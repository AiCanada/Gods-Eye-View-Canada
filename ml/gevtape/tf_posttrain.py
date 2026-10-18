"""Post-train an existing TensorFlow (Keras) world model on the newest recorded data.

    python -m ml.gevtape.tf_posttrain --data .gev-data --checkpoint <model.keras or its folder> --out <folder>
                                      [--adapter keras_world:KerasWorldAdapter] [--epochs 1]
                                      [--context 24] [--horizon 24] [--batch-size 8]
                                      [--device auto|cpu|gpu] [--resume] [--tensorboard <logdir>]

The TensorFlow side of ml.gevtape.posttrain (POST-TRAIN A TENSORFLOW MODEL in
the AI World tab): the same held-out days, the same windows, the same
metrics.json (held-out loss before and after: did it help?), with numpy
batches instead of torch tensors, and no PyTorch needed.

The adapter is a class in ml/adapters/ or .gev-data/ai-world/adapters/
(`--adapter module:Class`, ml.gevtape.adapters), built as

    Class(checkpoint, device=..., channels=[...], context=24, horizon=24, out_dir=...)

with
    train_step(batch) -> float    one update on the batch, its loss
    evaluate(batch)   -> float    the loss without an update (optional)
    save(folder)                  writes the post-trained model there
and, when its model reads other windows than asked, `context` and `horizon`
attributes (the runner then cuts the windows to them).

A batch is a dict of numpy arrays: v [B, L, K, C] symlog values (0 where
missing), m [B, L, K, C] the observed mask, tf [B, L, K, 6] time features,
s [B, K, S] place features, plus `channels`, `context` and `horizon`.
L = context + horizon. ml/adapters/keras_world.py post-trains a model made by
TENSORFLOW TRAINING (ml.gevtape.tf_train) and is the template for any other
Keras model.

Same JSON-lines protocol as the trainers (progress / checkpoint / posttrain /
paused / done / error; {"cmd":"pause"} and {"cmd":"stop"} on stdin save the
model and the step, and --resume continues).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

from . import reader as R
from . import tf_world as W
from . import torch_data as td
from .adapters import load_adapter_class
from .board import Board
from .protocol import Control, DataError, Emitter, atomic_json, now_ms

MODEL = "tf-posttrain"


def batch_with(batch, extra):
    return {**batch, **extra}


def held_out_loss(adapter, windows, size, extra, limit):
    fn = getattr(adapter, "evaluate", None)
    if not callable(fn):
        return None
    total, n = 0.0, 0
    for batch in W.batches(windows, size, limit):
        loss = fn(batch_with(batch, extra))
        if loss is not None and float(loss) == float(loss):
            total += float(loss)
            n += 1
    return total / n if n else None


def run(args, emit, control) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    root = Path(args.data)
    cls, adapter_path = load_adapter_class(args.adapter, root)
    worlds = R.list_bin_worlds(root)
    if not worlds:
        raise DataError(f"no bins under {R.gev_paths(root)['bins']}: record and bin a day first")
    bins_dir = worlds[-1]
    series = td.load_bin_series(bins_dir)
    if series is None:
        raise DataError(f"no bins in {bins_dir}")
    world_dir = R.find_world(root, bins_dir.name)
    world = R.load_world(world_dir, data_root=root) if world_dir else None
    device = W.configure_devices(args.device)
    state_file = out / "posttrain-state.json"
    state = json.loads(state_file.read_text(encoding="utf-8")) if (args.resume and state_file.is_file()) else {}
    checkpoint = str(out / "model") if state.get("saved") else str(args.checkpoint)
    if not Path(checkpoint).exists():
        raise DataError(f"no model at {checkpoint}")
    channels = list(series["channels"])
    adapter = cls(checkpoint, device=device, channels=channels, context=args.context, horizon=args.horizon,
                  out_dir=str(out))
    context = int(getattr(adapter, "context", args.context))
    horizon = int(getattr(adapter, "horizon", args.horizon))
    days = series["days"]
    n_val = max(1, round(len(days) * 0.2)) if len(days) >= 2 else 0
    val_days = days[-n_val:] if n_val else []
    H = series["values"].shape[0]
    cut = ((val_days[0] - series["start"]).days * 24) if val_days else H
    common = dict(world=world, context=context, horizon=horizon, seed=args.seed,
                  n_static=getattr(adapter, "n_static", None))
    train_set = td.BinWindows(series, stride=args.stride, target_hours=(0, cut), max_places=args.max_places,
                              **common)
    val_set = td.BinWindows(series, stride=max(1, horizon), target_hours=(cut, H), shuffle=False,
                            max_places=args.max_places, **common)
    if len(train_set) == 0:
        raise DataError(f"not enough recorded hours for one window of {context + horizon}")
    extra = {"channels": channels, "context": context, "horizon": horizon}
    limit = args.eval_windows
    before = state.get("heldOutLossBefore")
    if before is None:
        before = held_out_loss(adapter, val_set, args.batch_size, extra, limit)
    start_epoch, skip = int(state.get("epoch", 0)), int(state.get("step", 0))
    steps = int(state.get("steps", 0))
    board = Board(args.tensorboard)
    emit("progress", model=MODEL, epoch=start_epoch, epochs=args.epochs, device=device)

    def save(epoch, step, saved=True):
        adapter.save(str(out / "model"))
        atomic_json(state_file, {"epoch": epoch, "step": step, "steps": steps, "saved": saved,
                                 "heldOutLossBefore": before, "adapter": args.adapter,
                                 "checkpoint": str(args.checkpoint)})

    last_loss = None
    for epoch in range(start_epoch, args.epochs):
        train_set.set_epoch(epoch)
        for step, batch in enumerate(W.batches(train_set, args.batch_size)):
            if epoch == start_epoch and step < skip:
                continue
            last_loss = float(adapter.train_step(batch_with(batch, extra)))
            steps += 1
            if steps % max(1, args.log_every) == 0:
                board.scalars(steps, {"posttrain/loss": last_loss})
            wanted = control.requested()
            if wanted:
                save(epoch, step + 1)
                emit("checkpoint", model=MODEL, epoch=epoch, step=step + 1)
                emit("paused" if wanted == "pause" else "done", model=MODEL)
                return 0
        emit("progress", model=MODEL, epoch=epoch + 1, epochs=args.epochs, loss=last_loss)
        save(epoch + 1, 0)
    after = held_out_loss(adapter, val_set, args.batch_size, extra, limit)
    board.scalars(steps, {"posttrain/held-out-before": before, "posttrain/held-out-after": after})
    classes = sorted(set(series["classes"])) or ["unclear"]
    metrics = {
        "model": MODEL,
        "framework": "tensorflow",
        "adapter": args.adapter,
        "adapterFile": str(adapter_path),
        "checkpoint": str(args.checkpoint),
        "saved": str(out / "model"),
        "device": device,
        "worldId": bins_dir.name,
        "days": [d.isoformat() for d in days],
        "trainedThrough": (days[:-n_val] or days)[-1].isoformat() if days else None,
        "heldOutDays": [d.isoformat() for d in val_days],
        "contextHours": context,
        "horizonHours": horizon,
        "heldOutLossBefore": before,
        "heldOutLossAfter": after,
        "helped": (before is not None and after is not None and after < before),
        "trainLoss": last_loss,
        "channels": channels,
        "licenceClasses": classes,
        "updatedAt": now_ms(),
    }
    atomic_json(out / "metrics.json", metrics)
    emit("posttrain", model=MODEL, helped=metrics["helped"], before=before, after=after)
    emit("done", model=MODEL)
    return 0


def build_parser():
    p = argparse.ArgumentParser(prog="python -m ml.gevtape.tf_posttrain", description=__doc__.split("\n\n")[0])
    p.add_argument("--data", required=True)
    p.add_argument("--adapter", default="keras_world:KerasWorldAdapter",
                   help="module:Class in ml/adapters/ or .gev-data/ai-world/adapters/")
    p.add_argument("--checkpoint", required=True, help="the existing model (a .keras file or its folder)")
    p.add_argument("--out", required=True)
    p.add_argument("--epochs", type=int, default=1)
    p.add_argument("--context", type=int, default=24)
    p.add_argument("--horizon", type=int, default=24)
    p.add_argument("--stride", type=int, default=6)
    p.add_argument("--batch-size", type=int, default=8)
    p.add_argument("--max-places", type=int, default=512, help="crops of this many neighbouring places (0: all)")
    p.add_argument("--eval-windows", type=int, default=64)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--device", default="auto", choices=("auto", "cpu", "gpu"))
    p.add_argument("--log-every", type=int, default=10)
    p.add_argument("--tensorboard", default=None, help="TensorBoard log folder for this run")
    p.add_argument("--resume", action="store_true")
    return p


def main(argv=None) -> int:
    emit = Emitter(sys.stdout)
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as e:
        return int(e.code or 0)
    control = Control()
    try:
        control.listen(sys.stdin.fileno())
    except (AttributeError, OSError, ValueError):
        pass
    try:
        return run(args, emit, control)
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


if __name__ == "__main__":
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")  # before TensorFlow is imported
    sys.exit(main())
