"""EVALUATION: score registered world models side by side against persistence.

    python -m ml.gevtape.mlflow_evaluate --tracking-uri <MLflow server> --data .gev-data
                                         [--model name@alias | name/version ...] [--eval-windows 32]

Every version given, or by default every registered world model's aliased
versions and its newest one (PyTorch and Keras alike: ml.gevtape.mlflow_models
gives them one interface), predicts the held-out days of the newest binned
world: the last fifth of the days, as the trainers hold out. Each is scored as
the trainers score their own models: MAE in the symlog space on observed
targets of channels seen in the context, against persistence (the last value
observed), overall and per domain. A model meets the bins in its own channel
order; a channel the bins no longer have is simply not observed.

The scores go to an MLflow run in ai-world/evaluation (metrics per model, a
table artifact evaluation.json) and onto each version as gev.eval.* tags.
Protocol: progress events, then {"event":"evaluation","rows","best","runId"},
then done.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path

import numpy as np

from . import formats as F
from . import reader as R
from . import torch_data as td
from .protocol import DataError, Emitter, utf8_streams

EXPERIMENT = "ai-world/evaluation"
WORLD_KINDS = ("world", "tf-world")


class Scores:
    """Absolute errors of a model and of persistence per channel."""

    def __init__(self, channels):
        self.channels = list(channels)
        n = len(self.channels)
        self.err_m = np.zeros(n)
        self.err_p = np.zeros(n)
        self.cnt = np.zeros(n)

    def add(self, pred, window, context, horizon):
        v, m = np.asarray(window["v"], np.float32), np.asarray(window["m"], np.float32)
        if v.ndim == 3:
            v, m = v[None], m[None]
        c, h = context, horizon
        obs = m[:, :c] > 0
        seen = obs.any(axis=1)                                            # [B, K, C]
        last_at = c - 1 - np.argmax(obs[:, ::-1], axis=1)
        last = np.where(seen, np.take_along_axis(v[:, :c], last_at[:, None], axis=1)[:, 0], 0.0)
        ok = (m[:, c:c + h] > 0) & seen[:, None]
        target = v[:, c:c + h]
        pred = np.asarray(pred, np.float32).reshape(target.shape)
        self.err_m += (np.abs(pred - target) * ok).sum(axis=(0, 1, 2))
        self.err_p += (np.abs(last[:, None] - target) * ok).sum(axis=(0, 1, 2))
        self.cnt += ok.sum(axis=(0, 1, 2))

    def skill(self, cols=None):
        cols = list(range(len(self.channels))) if cols is None else cols
        n = self.cnt[cols].sum()
        if n == 0:
            return None
        return {"mae": float(self.err_m[cols].sum() / n), "persistence": float(self.err_p[cols].sum() / n),
                "targets": int(n)}

    def domains(self):
        out = {}
        for dom, groups in F.DOMAIN_GROUPS.items():
            cols = [i for i, ch in enumerate(self.channels) if ch.split(".", 1)[0] in groups]
            if cols and (sk := self.skill(cols)):
                out[dom] = sk
        return out


def held_out_windows(data_root, channels, context, horizon, n_static, limit):
    """The held-out windows of the newest binned world, in the given channel order."""
    worlds = R.list_bin_worlds(data_root)
    if not worlds:
        raise DataError(f"no bins under {R.gev_paths(data_root)['bins']}: record and bin a day first")
    bins_dir = worlds[-1]
    series = td.load_bin_series(bins_dir, channels=channels)
    if series is None:
        raise DataError(f"no bins in {bins_dir}")
    wdir = R.find_world(Path(data_root), bins_dir.name)
    world = R.load_world(wdir, data_root=Path(data_root)) if wdir is not None else None
    days = series["days"]
    n_val = max(1, round(len(days) * 0.2)) if len(days) >= 2 else 0
    val_days = days[-n_val:] if n_val else days
    H = series["values"].shape[0]
    cut = ((val_days[0] - series["start"]).days * 24) if n_val else 0
    windows = td.BinWindows(series, world=world, context=context, horizon=horizon, stride=max(1, horizon),
                            target_hours=(cut, H), shuffle=False, n_static=n_static)
    starts = [int(s) for s in windows.starts[:limit]]
    return windows, starts, [str(d) for d in val_days], bins_dir.name


def candidates(client, wanted):
    """(name, version, tags) for each model version to score."""
    out = []
    if wanted:
        for spec in wanted:
            if "@" in spec:
                name, alias = spec.split("@", 1)
                mv = client.get_model_version_by_alias(name, alias)
            elif "/" in spec:
                name, version = spec.rsplit("/", 1)
                mv = client.get_model_version(name, version)
            else:
                versions = client.search_model_versions(f"name='{spec}'")
                if not versions:
                    raise DataError(f"no registered model {spec}")
                mv = max(versions, key=lambda v: int(v.version))
            out.append(mv)
    else:
        for rm in client.search_registered_models():
            versions = client.search_model_versions(f"name='{rm.name}'")
            if not versions or (versions[0].tags or {}).get("gev.kind") not in WORLD_KINDS:
                continue
            aliased = {str(v) for v in (rm.aliases or {}).values()}
            newest = str(max(int(v.version) for v in versions))
            out.extend(v for v in versions if str(v.version) in aliased | {newest})
    seen, unique = set(), []
    for mv in out:
        key = (mv.name, str(mv.version))
        if key not in seen and (mv.tags or {}).get("gev.kind") in WORLD_KINDS:
            seen.add(key)
            unique.append(mv)
    return unique


def evaluate(args, emit):
    import mlflow
    from mlflow import MlflowClient

    mlflow.set_tracking_uri(args.tracking_uri)
    client = MlflowClient()
    versions = candidates(client, args.model)
    if not versions:
        raise DataError("no registered world model to evaluate: register one in MODEL REGISTRY first")
    rows, cache, held, world_id = [], {}, [], None
    for n, mv in enumerate(versions):
        tags = mv.tags or {}
        channels = json.loads(tags.get("gev.channels") or "[]")
        context, horizon = int(tags.get("gev.context", 24)), int(tags.get("gev.horizon", 24))
        n_static = int(tags.get("gev.nStatic", 4))
        emit("progress", model="mlflow-evaluate", stage="scoring", done=n, total=len(versions),
             name=mv.name, version=str(mv.version))
        key = (tuple(channels), context, horizon, n_static)
        if key not in cache:
            cache[key] = held_out_windows(args.data, channels, context, horizon, n_static, args.eval_windows)
        windows, starts, held, world_id = cache[key]
        model = mlflow.pyfunc.load_model(f"models:/{mv.name}/{mv.version}")
        scores = Scores(channels)
        started = time.time()
        for s in starts:
            w = windows.window(s, crop=False)
            batch = {k: w[k][None] for k in ("v", "m", "tf", "s")}
            scores.add(model.predict(batch), batch, context, horizon)
        overall = scores.skill()
        rows.append({"name": mv.name, "version": str(mv.version), "kind": tags.get("gev.kind"),
                     "aliases": sorted(a for a in (getattr(mv, "aliases", None) or [])),
                     "mae": overall and overall["mae"], "persistence": overall and overall["persistence"],
                     "skill": (1 - overall["mae"] / overall["persistence"])
                     if overall and overall["persistence"] > 0 else None,
                     "targets": overall and overall["targets"], "windows": len(starts),
                     "seconds": round(time.time() - started, 1), "domains": scores.domains()})
    scored = [r for r in rows if r["mae"] is not None]
    best = min(scored, key=lambda r: r["mae"]) if scored else None
    mlflow.set_experiment(EXPERIMENT)
    with mlflow.start_run(run_name=f"evaluate {len(rows)} model(s)") as run:
        mlflow.log_params({"models": len(rows), "eval_windows": args.eval_windows, "world": world_id,
                           "held_out_days": ",".join(held)[:500]})
        for r in scored:
            prefix = f"{r['name']}.v{r['version']}"
            mlflow.log_metrics({f"{prefix}/mae": r["mae"], f"{prefix}/persistence": r["persistence"],
                                **({f"{prefix}/skill": r["skill"]} if r["skill"] is not None else {}),
                                **{f"{prefix}/{dom}/mae": sk["mae"] for dom, sk in r["domains"].items()}})
        mlflow.log_table({"model": [r["name"] for r in rows], "version": [r["version"] for r in rows],
                          "kind": [r["kind"] for r in rows], "mae": [r["mae"] for r in rows],
                          "persistence": [r["persistence"] for r in rows], "skill": [r["skill"] for r in rows],
                          "targets": [r["targets"] for r in rows]}, artifact_file="evaluation.json")
        if best:
            mlflow.set_tags({"gev.best": f"{best['name']} v{best['version']}"})
        run_id = run.info.run_id
    for r in scored:
        for key, value in (("gev.eval.mae", r["mae"]), ("gev.eval.persistence", r["persistence"]),
                           ("gev.eval.skill", r["skill"])):
            if value is not None:
                client.set_model_version_tag(r["name"], r["version"], key, f"{value:.6g}")
        client.set_model_version_tag(r["name"], r["version"], "gev.eval.days", ",".join(held)[:500])
    emit("evaluation", rows=rows, best={"name": best["name"], "version": best["version"]} if best else None,
         runId=run_id, heldOutDays=held, worldId=world_id)


def build_parser():
    p = argparse.ArgumentParser(prog="python -m ml.gevtape.mlflow_evaluate", description=__doc__.split("\n\n")[0])
    p.add_argument("--tracking-uri", default=os.environ.get("MLFLOW_TRACKING_URI"), help="the local MLflow server")
    p.add_argument("--data", default=".gev-data")
    p.add_argument("--model", action="append", help="name@alias, name/version or a name (its newest version)")
    p.add_argument("--eval-windows", type=int, default=32, help="held-out windows per model (all places each)")
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
        evaluate(args, emit)
    except DataError as e:
        emit("error", message=str(e))
        return 1
    except ImportError as e:
        emit("error", message=f"MLflow is not installed in this Python ({e.name or e}): py -3.13 -m pip install mlflow")
        return 1
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        emit("error", message=f"{type(e).__name__}: {e}")
        return 1
    emit("done", model="mlflow-evaluate")
    return 0


if __name__ == "__main__":
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    sys.exit(main())
