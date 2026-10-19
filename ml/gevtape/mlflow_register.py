"""MODEL REGISTRY: put a trained model in the MLflow model registry as a new version.

    python -m ml.gevtape.mlflow_register --tracking-uri <MLflow server> --kind world|tf-world|llm
                                         --source <model folder> --name <registered model>
                                         [--alias champion|challenger]

  world     the kit's PyTorch world model (a folder with checkpoint.pt:
            .gev-data/ai-world/models/world, or a post-trained one)
  tf-world  a Keras world model (a folder with model.keras: TENSORFLOW TRAINING,
            or POST-TRAIN A TENSORFLOW MODEL)
  llm       a custom LLM (.gev-data/llm/<name>/model, with adapter.json)

The model is logged in a run of the experiment ai-world/registry (its held-out
score, data days and licence classes with it) as a pyfunc model
(ml.gevtape.mlflow_models) and registered under --name. The version's tags
say what it is (gev.kind, gev.channels, gev.context, gev.horizon, gev.nStatic,
gev.licenceClasses), which MODEL SERVING and EVALUATION read. Nothing leaves
this machine: the tracking server is the local one.

Same JSON-lines protocol as the trainers: progress events with a `stage`,
then {"event":"registered","name","version","runId","alias"} and done.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import traceback
from pathlib import Path

import numpy as np

from .protocol import DataError, Emitter, utf8_streams

REPO_ROOT = Path(__file__).resolve().parents[2]
KINDS = ("world", "tf-world", "llm")
EXPERIMENT = "ai-world/registry"


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def describe(kind, source, data_root):
    """(config, artifacts to write, tags, metrics) for a model folder."""
    source = Path(source)
    metrics = read_json(source / "metrics.json")
    manifest = read_json(source / "manifest.json")
    skill = metrics.get("skill") or {}
    scores = {k: v for k, v in (("held-out/mae", skill.get("model")),
                                ("held-out/persistence", skill.get("persistence")),
                                ("held-out/loss-before", metrics.get("heldOutLossBefore")),
                                ("held-out/loss-after", metrics.get("heldOutLossAfter"))) if v is not None}
    classes = manifest.get("licenceClasses") or metrics.get("licenceClasses") or ["unclear"]
    if kind == "world":
        import torch

        from . import reader as R

        path = source / "checkpoint.pt" if source.is_dir() else source
        if not path.is_file():
            raise DataError(f"no checkpoint.pt in {source}")
        ckpt = torch.load(path, map_location="cpu", weights_only=False)
        if ckpt.get("kind") != "world":
            raise DataError(f"{path} holds a {ckpt.get('kind')} model, not a world model")
        task = ckpt.get("task") or {}
        channels = list(task.get("channels") or [])
        config = {"kind": kind, "context": int(task.get("context") or 24), "horizon": int(task.get("horizon") or 24),
                  "channels": channels, "nStatic": int(task.get("nStatic") or 4), "worldId": task.get("worldId")}
        wdir = R.find_world(Path(data_root), task.get("worldId")) if task.get("worldId") else None
        if wdir is not None:
            world = R.load_world(wdir, data_root=Path(data_root))
            rows, cols, weights = R.place_edges(world)
            K = world.K
        else:
            rows = cols = np.zeros(0, np.int64)
            weights = np.zeros(0, np.float32)
            K = 0
        return config, {"checkpoint": path}, {"graph": (rows, cols, weights, K)}, classes, scores, \
            manifest.get("data", {}).get("binDays")
    if kind == "tf-world":
        from . import tf_world as W

        path = source / W.MODEL_FILE if source.is_dir() else source
        if not path.is_file():
            raise DataError(f"no {W.MODEL_FILE} in {source}")
        model = W.tensorflow().keras.models.load_model(path, compile=False)
        n_channels, n_static, context, horizon = W.model_shape(model)
        state = read_json(path.parent / "state.json")
        channels = list((manifest.get("data") or {}).get("channels") or (state.get("task") or {}).get("channels") or [])
        if len(channels) != n_channels:
            raise DataError(f"{path} reads {n_channels} channels, but its folder names {len(channels)}")
        config = {"kind": kind, "context": context, "horizon": horizon, "channels": channels, "nStatic": n_static}
        return config, {"model": path}, {}, classes, scores, (manifest.get("data") or {}).get("binDays")
    if kind == "llm":
        from .llm_train import read_adapter

        meta, _ = read_adapter(source)
        config = {"kind": kind, "name": source.parent.name, "base": meta.get("base"),
                  "dataThrough": meta.get("dataThrough")}
        for key in ("heldOutLossBefore", "heldOutLossAfter"):
            if meta.get(key) is not None:
                scores[f"held-out/{'loss-before' if key.endswith('Before') else 'loss-after'}"] = meta[key]
        return config, {"adapter": source}, {}, meta.get("classes") or classes, scores, None
    raise DataError(f"--kind is one of {', '.join(KINDS)}")


def register(args, emit):
    import mlflow
    from mlflow import MlflowClient

    from . import mlflow_models as MM

    mlflow.set_tracking_uri(args.tracking_uri)
    mlflow.set_experiment(EXPERIMENT)
    emit("progress", model="mlflow-register", stage="reading")
    config, artifacts, extra, classes, scores, days = describe(args.kind, args.source, args.data)
    with tempfile.TemporaryDirectory(prefix="gev-mlflow-") as tmp:
        tmp = Path(tmp)
        (tmp / "config.json").write_text(json.dumps(config, indent=1), encoding="utf-8")
        files = {"config": str(tmp / "config.json"), **{k: str(v) for k, v in artifacts.items()}}
        if "graph" in extra:
            rows, cols, weights, K = extra["graph"]
            np.savez(tmp / "graph.npz", rows=rows, cols=cols, weights=weights, K=np.int64(K))
            files["graph"] = str(tmp / "graph.npz")
        if args.kind == "world":
            python_model, framework = MM.KitWorldModel(), "pytorch"
            signature = MM.world_signature(len(config["channels"]), config["nStatic"], config["horizon"])
            requirements = ["torch", "numpy"]
        elif args.kind == "tf-world":
            python_model, framework = MM.KerasWorld(), "tensorflow"
            signature = MM.world_signature(len(config["channels"]), config["nStatic"], config["horizon"])
            requirements = ["tensorflow", "numpy"]
        else:
            python_model, framework = MM.CustomLlm(), "transformers"
            signature = MM.llm_signature()
            requirements = ["torch", "transformers", "safetensors", "numpy"]
        with mlflow.start_run(run_name=f"register {args.name}") as run:
            mlflow.set_tags({"gev.kind": args.kind, "gev.framework": framework, "gev.source": str(args.source),
                             "gev.licenceClasses": ",".join(classes)})
            mlflow.log_params({"kind": args.kind, "source": str(args.source),
                               **{k: config[k] for k in ("context", "horizon", "nStatic", "base") if k in config},
                               **({"channels": len(config["channels"])} if "channels" in config else {})})
            if scores:
                mlflow.log_metrics({k: float(v) for k, v in scores.items()})
            if days:
                mlflow.set_tag("gev.dataDays", f"{days[0]}..{days[-1]} ({len(days)})")
            emit("progress", model="mlflow-register", stage="logging")
            info = mlflow.pyfunc.log_model(name="model", python_model=python_model, artifacts=files,
                                           code_paths=[str(REPO_ROOT / "ml")], signature=signature,
                                           pip_requirements=requirements, registered_model_name=args.name)
            run_id = run.info.run_id
    version = str(info.registered_model_version)
    client = MlflowClient()
    tags = {"gev.kind": args.kind, "gev.framework": framework, "gev.source": str(args.source),
            "gev.licenceClasses": ",".join(classes)}
    if "channels" in config:
        tags.update({"gev.channels": json.dumps(config["channels"]), "gev.context": str(config["context"]),
                     "gev.horizon": str(config["horizon"]), "gev.nStatic": str(config["nStatic"])})
    for key, value in scores.items():
        tags[f"gev.{key.replace('/', '.')}"] = f"{float(value):.6g}"
    for key, value in tags.items():
        client.set_model_version_tag(args.name, version, key, value)
    client.set_registered_model_tag(args.name, "gev.kind", args.kind)
    if args.alias:
        client.set_registered_model_alias(args.name, args.alias, version)
    emit("registered", name=args.name, version=version, runId=run_id, alias=args.alias, kind=args.kind)


def build_parser():
    p = argparse.ArgumentParser(prog="python -m ml.gevtape.mlflow_register", description=__doc__.split("\n\n")[0])
    p.add_argument("--tracking-uri", default=os.environ.get("MLFLOW_TRACKING_URI"), help="the local MLflow server")
    p.add_argument("--data", default=".gev-data", help="the .gev-data root (the place graph of a world model)")
    p.add_argument("--kind", required=True, choices=KINDS)
    p.add_argument("--source", required=True, help="the model folder")
    p.add_argument("--name", required=True, help="the registered model's name")
    p.add_argument("--alias", default=None, choices=("champion", "challenger"))
    return p


def main(argv=None) -> int:
    utf8_streams()
    emit = Emitter(sys.stdout)
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as e:
        return int(e.code or 0)
    try:
        if not args.tracking_uri:
            raise DataError("no MLflow server: --tracking-uri or MLFLOW_TRACKING_URI")
        register(args, emit)
    except DataError as e:
        emit("error", message=str(e))
        return 1
    except ImportError as e:
        emit("error", message=f"MLflow is not installed in this Python ({e.name or e}): "
                              "py -3.13 -m pip install mlflow")
        return 1
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        emit("error", message=f"{type(e).__name__}: {e}")
        return 1
    emit("done", model="mlflow-register")
    return 0


if __name__ == "__main__":
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    sys.exit(main())
