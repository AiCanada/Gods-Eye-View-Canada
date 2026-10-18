"""EXPORT FOR TENSORFLOW: the recorded bins as a TFRecord dataset, and the Keras
world model as a SavedModel and a TFLite file.

    python -m ml.gevtape.tf_export --data .gev-data --out <new folder>
                                   [--classes open] [--days FIRST:LAST] [--world <id>]
                                   [--model <folder with model.keras>] [--no-model]

Into one new folder:

  everything ml.gevtape.export writes (bins/ as .npy, channels.json,
  places.json, assets.json, links.json, manifest.json, DATASET.md), with the
  same licence-class filter, then
  tfrecord/YYYY-MM-DD.tfrecord  one tf.train.Example per hour of the day:
                                hour_ms int64, and the observed entries only
                                as place / channel int64 and value float
                                (raw bin values; nothing unobserved is
                                written, so a missing entry is never a 0)
  tfrecord/spec.json            the channel order, K, how to parse it
  savedmodel/                   the Keras world model (ml.gevtape.tf_train)
                                with a serving signature, when there is one
  model.tflite                  the same model for TFLite, checked against
                                Keras on held-out rows
  TENSORFLOW.md                 how to read all of it with tf.data
  tensorflow.json               files, sizes, sha256, the model's licence mix

The model learned from every class it trained on (its manifest says which),
whatever --classes keeps out of the dataset: tensorflow.json marks it
publishable only when both are open only, and the owner decides each release.

Same JSON-lines protocol as the trainers: progress events with a `stage`
(dataset, tfrecord, savedmodel, tflite), then {"event":"export",...} and done;
an error is {"event":"error","message"}.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import sys
import traceback
from pathlib import Path

import numpy as np

from . import export as X
from . import reader as R
from . import tf_world as W
from .protocol import DataError, Emitter, atomic_json, now_ms

FORMAT = "gev-world-tfrecord/1"


def default_model_dir(data_root):
    return R.gev_paths(data_root)["models"].parent / "tensorflow" / "models" / W.MODEL_NAME


def flat_channels(channels):
    """['group.channel', ...] in the order Bins.stacked uses (groups sorted)."""
    return [f"{g}.{c}" for g in sorted(channels) for c in channels[g]]


def hour_examples(tf, day, groups, channels, order):
    """24 serialized tf.train.Examples for one exported day."""
    at = {name: i for i, name in enumerate(order)}
    start = R.day_start_ms(day)
    hours = [([], [], []) for _ in range(24)]
    for group, arr in groups.items():
        cols = [at[f"{group}.{c}"] for c in channels.get(group, [])]
        if arr.shape[2] != len(cols):
            raise DataError(f"{day} {group}: {arr.shape[2]} channels, channels.json lists {len(cols)}")
        hh, kk, cc = np.nonzero(np.isfinite(arr))
        for h, k, c in zip(hh.tolist(), kk.tolist(), cc.tolist()):
            hours[h][0].append(k)
            hours[h][1].append(cols[c])
            hours[h][2].append(float(arr[h, k, c]))
    feature = tf.train.Feature
    for h, (places, chans, values) in enumerate(hours):
        yield tf.train.Example(features=tf.train.Features(feature={
            "hour_ms": feature(int64_list=tf.train.Int64List(value=[start + h * 3_600_000])),
            "place": feature(int64_list=tf.train.Int64List(value=places)),
            "channel": feature(int64_list=tf.train.Int64List(value=chans)),
            "value": feature(float_list=tf.train.FloatList(value=values)),
        })).SerializeToString(), len(values)


def write_tfrecords(tf, out: Path, manifest, emit):
    channels = json.loads((out / "channels.json").read_text(encoding="utf-8"))
    order = flat_channels(channels)
    folder = out / "tfrecord"
    folder.mkdir()
    files, entries, K = [], 0, None
    for n, iso in enumerate(manifest["days"]):
        day = _dt.date.fromisoformat(iso)
        y, m, d = R.day_parts(day)
        groups = {}
        for f in sorted((out / "bins" / y / m).glob(f"{d}.*.npy")):
            arr = R.load_npy(f).astype(np.float32, copy=False)
            groups[f.name[len(d) + 1: -len(".npy")]] = arr
            K = int(arr.shape[1])
        path = folder / f"{iso}.tfrecord"
        with tf.io.TFRecordWriter(str(path)) as writer:
            for raw, count in hour_examples(tf, day, groups, channels, order):
                writer.write(raw)
                entries += count
        files.append(path)
        emit("progress", model="tf-export", stage="tfrecord", done=n + 1, total=len(manifest["days"]))
    spec = {
        "format": FORMAT, "channels": order, "K": K, "days": manifest["days"], "entries": entries,
        "features": {"hour_ms": "int64 [1], UTC ms of the hour's start",
                     "place": "int64 [n], the tracked place (places.json row k)",
                     "channel": "int64 [n], index into channels",
                     "value": "float32 [n], the bin value as recorded (observed entries only)"},
        "values": "raw bin values; the kit's models read sign(x)*log1p(|x|) of them",
    }
    atomic_json(folder / "spec.json", spec)
    return files + [folder / "spec.json"], spec


def export_model(tf, model_dir: Path, out: Path, data_root, emit):
    """SavedModel + TFLite of a Keras world model; the summary, or None when there is no model."""
    model_path = model_dir / W.MODEL_FILE
    if not model_path.is_file():
        return None, []
    model = tf.keras.models.load_model(model_path, compile=False)
    n_ch, n_static, context, horizon = W.model_shape(model)
    emit("progress", model="tf-export", stage="savedmodel")
    saved = out / "savedmodel"
    model.export(str(saved), verbose=False)
    emit("progress", model="tf-export", stage="tflite")
    converter = tf.lite.TFLiteConverter.from_saved_model(str(saved))
    lite = converter.convert()
    lite_path = out / "model.tflite"
    lite_path.write_bytes(lite)
    check = tflite_check(tf, model, lite, data_root, n_ch, n_static, context, horizon)
    manifest = {}
    try:
        manifest = json.loads((model_dir / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    classes = list(manifest.get("licenceClasses") or ["unclear"])
    files = [p for p in saved.rglob("*") if p.is_file()] + [lite_path]
    return {
        "from": str(model_path), "channels": n_ch, "static": n_static, "contextHours": context,
        "horizonHours": horizon, "trainedOn": (manifest.get("data") or {}).get("binDays"),
        "channelNames": (manifest.get("data") or {}).get("channels"), "licenceClasses": classes,
        "openOnly": classes == ["open"], "tflite": check,
    }, files


def tflite_check(tf, model, lite, data_root, n_ch, n_static, context, horizon):
    """The TFLite model against Keras on a few rows: held-out rows of the bins
    when they still fit the model, else zeros. Returns the largest difference."""
    rows = None
    try:
        data = W.WorldData(data_root, context=context, horizon=horizon, max_places=64)
        if len(data.channels) == n_ch and data.n_static == n_static and len(data.val):
            rows, _, _ = W.place_rows(data.val.window(int(data.val.starts[0])), context, horizon, keep_empty=True)
            rows = {k: a[:8] for k, a in rows.items()}
    except DataError:
        rows = None
    if rows is None:
        F = 2 * n_ch + 6
        rows = {"context": np.zeros((1, context, F), np.float32), "future": np.zeros((1, horizon, 6), np.float32),
                "static": np.zeros((1, n_static), np.float32), "last": np.zeros((1, n_ch), np.float32),
                "seen": np.zeros((1, n_ch), np.float32)}
    want = np.asarray(model(rows, training=False))
    interp = tf.lite.Interpreter(model_content=lite)
    runner = interp.get_signature_runner()
    n = want.shape[0]
    got = []
    for i in range(n):  # one row at a time: the converted signature has a batch of 1
        res = runner(**{k: a[i: i + 1] for k, a in rows.items()})
        got.append(np.asarray(next(iter(res.values()))))
    diff = float(np.max(np.abs(np.concatenate(got) - want))) if n else None
    return {"rows": int(n), "maxAbsDiff": diff, "ok": diff is not None and diff < 1e-3}


CARD = """# For TensorFlow

Made by EXPORT FOR TENSORFLOW in the Artificial Intelligence World Training
Sim ({world}, {first} to {last}). DATASET.md describes the hourly bins
themselves; this card is the TensorFlow side.

## TFRecord dataset

`tfrecord/YYYY-MM-DD.tfrecord` holds one `tf.train.Example` per hour. Only
observed entries are written: a place and channel that is not in an hour's
example was not observed (a feed off, paused or quiet), not zero.

```python
import json, tensorflow as tf
spec = json.load(open("tfrecord/spec.json"))
K, C = spec["K"], len(spec["channels"])
feature = {{"hour_ms": tf.io.FixedLenFeature([1], tf.int64),
           "place": tf.io.VarLenFeature(tf.int64),
           "channel": tf.io.VarLenFeature(tf.int64),
           "value": tf.io.VarLenFeature(tf.float32)}}

def hour(raw):
    ex = tf.io.parse_single_example(raw, feature)
    at = tf.stack([ex["place"].values, ex["channel"].values], axis=1)
    dense = tf.scatter_nd(at, ex["value"].values, [K, C])
    seen = tf.scatter_nd(at, tf.ones_like(ex["value"].values), [K, C])
    return ex["hour_ms"][0], dense, seen       # [K, C] values and the observed mask

hours = tf.data.TFRecordDataset(sorted(tf.io.gfile.glob("tfrecord/*.tfrecord"))).map(hour)
windows = hours.window(48, shift=1, drop_remainder=True)   # 24 h context + 24 h ahead
```

{model}

## Licence

Dataset classes: {data_classes}. {model_licence} Nothing here was uploaded
anywhere. A correlation is not a cause; nothing here is advice.
"""

MODEL_CARD = """## The Keras world model

`savedmodel/` (`tf.saved_model.load`, signature `serve`) and `model.tflite`
take, per tracked place:

| input | shape | what |
| --- | --- | --- |
| `context` | [n, {context}, {ctx_width}] | the last {context} hours: symlog values, observed mask, 6 hour features |
| `future` | [n, {horizon}, 6] | the hour features of the {horizon} hours ahead |
| `static` | [n, {static}] | log population / 20, unit-sphere position, demographic shares |
| `last` | [n, {channels}] | the last value observed in the context (persistence) |
| `seen` | [n, {channels}] | 1 where the channel was observed in the context |

and give `[n, {horizon}, {channels}]` predictions in the symlog space
(`sign(x)*log1p(|x|)`; invert with `sign(y)*expm1(|y|)`). Channel order:
`tfrecord/spec.json` when the model trained on these channels
(`tensorflow.json` lists the model's own). TFLite against Keras on
{rows} held-out rows: largest difference {diff}.
"""


def export(data_root, out, *, classes=X.ALL_CLASSES, first=None, last=None, world_id=None, model_dir=None,
           with_model=True, emit=None):
    emit = emit or (lambda *a, **k: None)
    tf = W.tensorflow()
    out = Path(out)
    emit("progress", model="tf-export", stage="dataset")
    try:
        manifest = X.export(data_root, out, classes=classes, first=first, last=last, world_id=world_id)
    except X.ExportError as e:
        raise DataError(str(e)) from e
    files, spec = write_tfrecords(tf, out, manifest, emit)
    summary, model_files = (None, [])
    if with_model:
        summary, model_files = export_model(tf, Path(model_dir or default_model_dir(data_root)), out, data_root,
                                            emit)
    files += model_files
    if summary is None:
        model_text = ("## The Keras world model\n\nNot in this export: no model was trained with TENSORFLOW "
                      "TRAINING yet (ml.gevtape.tf_train).")
        model_licence = ""
    else:
        model_text = MODEL_CARD.format(context=summary["contextHours"], horizon=summary["horizonHours"],
                                       ctx_width=2 * summary["channels"] + 6, static=summary["static"],
                                       channels=summary["channels"], rows=summary["tflite"]["rows"],
                                       diff=summary["tflite"]["maxAbsDiff"])
        model_licence = (f"The model learned from: {', '.join(summary['licenceClasses'])}"
                         f"{' (open only).' if summary['openOnly'] else '; it is for local use only.'}")
    card = CARD.format(world=manifest["worldId"], first=manifest["days"][0], last=manifest["days"][-1],
                       model=model_text, data_classes=", ".join(manifest["licenceClasses"]),
                       model_licence=model_licence)
    (out / "TENSORFLOW.md").write_text(card, encoding="utf-8", newline="\n")
    files.append(out / "TENSORFLOW.md")
    result = {
        "format": "gev-tensorflow-export/1",
        "tensorflow": tf.__version__,
        "createdAt": now_ms(),
        "worldId": manifest["worldId"],
        "days": manifest["days"],
        "places": spec["K"],
        "channels": len(spec["channels"]),
        "entries": spec["entries"],
        "datasetClasses": manifest["licenceClasses"],
        "model": summary,
        "publishable": manifest["publishable"] and (summary is None or summary["openOnly"]),
        "files": [{"path": p.relative_to(out).as_posix(), "bytes": p.stat().st_size, "sha256": X._sha256(p)}
                  for p in sorted(set(files))],
    }
    atomic_json(out / "tensorflow.json", result)
    return result


def build_parser():
    p = argparse.ArgumentParser(prog="python -m ml.gevtape.tf_export", description=__doc__.split("\n\n")[0])
    p.add_argument("--data", required=True, help="the .gev-data root")
    p.add_argument("--out", required=True, help="a new, empty folder")
    p.add_argument("--classes", default=",".join(X.ALL_CLASSES),
                   help="licence classes to keep, comma separated (default all; 'open' to share)")
    p.add_argument("--days", default="", help="FIRST:LAST, YYYY-MM-DD (default every binned day)")
    p.add_argument("--world", default=None, help="a world id (default the newest binned world)")
    p.add_argument("--model", default=None, help="the folder with model.keras (default the TENSORFLOW TRAINING one)")
    p.add_argument("--no-model", action="store_true", help="the dataset only")
    return p


def main(argv=None) -> int:
    emit = Emitter(sys.stdout)
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as e:
        return int(e.code or 0)
    try:
        try:
            first, last = X.parse_days(args.days)
        except X.ExportError as e:
            raise DataError(str(e)) from e
        result = export(args.data, args.out, classes=args.classes.split(","), first=first, last=last,
                        world_id=args.world, model_dir=args.model, with_model=not args.no_model, emit=emit)
    except DataError as e:
        emit("error", message=str(e))
        return 1
    except ImportError as e:
        emit("error", message=f"TensorFlow is not installed in this Python ({e.name or e}): "
                              "npm run tensorflow:wsl-setup, or py -3.13 -m pip install tensorflow")
        return 1
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        emit("error", message=f"{type(e).__name__}: {e}")
        return 1
    model = result["model"] or {}
    emit("export", out=str(args.out), days=len(result["days"]), entries=result["entries"],
         files=len(result["files"]), publishable=result["publishable"], datasetClasses=result["datasetClasses"],
         model=bool(result["model"]), tfliteOk=(model.get("tflite") or {}).get("ok"))
    emit("done")
    return 0


if __name__ == "__main__":
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")  # before TensorFlow is imported
    sys.exit(main())
