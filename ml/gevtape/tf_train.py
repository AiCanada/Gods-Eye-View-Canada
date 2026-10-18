"""TensorFlow trainer child process: a Keras world model on the hourly bins.

    python -m ml.gevtape.tf_train --data <.gev-data> --out <dir>
                                  [--epochs N] [--resume] [--device auto|cpu|gpu]
                                  [--tensorboard <logdir>] [...]

The AI World tab's TENSORFLOW TRAINING section runs it: on the GPU through
WSL2 (scripts/tensorflow-wsl-run.sh; TensorFlow has no GPU on native Windows
since 2.11), else on the CPU with the Windows Python 3.13. Same bins, same
held-out days and the same score as ml.gevtape.train --model world (MAE
against persistence per domain and per channel), so the two read side by side.

Same JSON-lines protocol as ml.gevtape.train (docs/AI-WORLD-TAB.md):
  {"event":"progress","model":"tf-world","epoch","epochs","step","loss"}
  {"event":"checkpoint","path"}  {"event":"metrics","skill","domains",...}
  {"event":"paused"}  {"event":"done"}  {"event":"error","message"}
and {"cmd":"pause"} / {"cmd":"stop"} on stdin. The first progress event (epoch
0) says what it runs on: {"device":"GPU NVIDIA ...","tensorflow":"2.21.0"}.

<out>/model.keras    the Keras model with its optimizer (tf_export and the
                     keras_world adapter read it)
<out>/state.json     epoch, step and the data it was built for (--resume
                     continues from it; --resume on a finished run trains
                     another --epochs on the data there is now; a different
                     channel list starts a new model)
<out>/metrics.json   skill against persistence on held-out data (MAE)
<out>/manifest.json  the data it trained on and the licence classes seen
--tensorboard DIR    loss and held-out scores for TensorBoard
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

from . import tf_world as W
from .board import Board
from .protocol import LOCAL_ONLY_NOTE, MODEL_FORMAT, Control, DataError, Emitter, atomic_json, now_ms

STATE_FORMAT = "gevtape-tf-state/1"


def build_parser():
    ap = argparse.ArgumentParser(prog="python -m ml.gevtape.tf_train", description=__doc__.split("\n\n")[0])
    ap.add_argument("--data", required=True, help="the .gev-data directory")
    ap.add_argument("--out", required=True, help="model directory (model.keras, state.json, metrics.json)")
    ap.add_argument("--epochs", type=int, default=10)
    ap.add_argument("--resume", action="store_true", help="continue from <out>/state.json (fresh start if none)")
    ap.add_argument("--device", default="auto", choices=("auto", "cpu", "gpu"))
    ap.add_argument("--batch-size", type=int, default=8, help="windows per step")
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--weight-decay", type=float, default=1e-4)
    ap.add_argument("--hidden", type=int, default=64)
    ap.add_argument("--context", type=int, default=24, help="history hours")
    ap.add_argument("--horizon", type=int, default=24, help="hours ahead")
    ap.add_argument("--stride", type=int, default=1, help="window stride (hours)")
    ap.add_argument("--val-fraction", type=float, default=0.2)
    ap.add_argument("--world-id", default=None)
    ap.add_argument("--eval-windows", type=int, default=512, help="cap on held-out windows")
    ap.add_argument("--max-places", type=int, default=512,
                    help="train on crops of this many neighbouring tracked places (0: all)")
    ap.add_argument("--max-batches", type=int, default=0, help="cap on batches per epoch (0: the whole pass)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--log-every", type=int, default=10, help="progress event every N steps")
    ap.add_argument("--tensorboard", default=None, help="TensorBoard log folder for this run")
    ap.add_argument("--sleep-ms", type=int, default=0, help="pause between steps (share the machine; tests)")
    return ap


def read_state(path: Path):
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return state if isinstance(state, dict) and state.get("format") == STATE_FORMAT else None


def run(args, emit, control) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model_path, state_path = out / W.MODEL_FILE, out / "state.json"
    device = W.configure_devices(args.device)
    tf = W.tensorflow()
    keras = tf.keras
    keras.utils.set_random_seed(args.seed)
    state = read_state(state_path) if (args.resume and model_path.is_file()) else None
    prior = (state or {}).get("task") or {}
    data = W.WorldData(args.data, world_id=prior.get("worldId") or args.world_id,
                       context=prior.get("context") or args.context, horizon=prior.get("horizon") or args.horizon,
                       stride=args.stride, val_fraction=args.val_fraction, max_places=args.max_places,
                       seed=args.seed, n_static=prior.get("nStatic"))
    mismatch = state is not None and list(prior.get("channels") or []) != data.channels
    grown = None
    if mismatch:
        # A new data layer or asset grows the model instead of replacing it
        # (as the PyTorch world model does); the round starts over on it.
        grown = W.grow_model(keras.models.load_model(model_path, compile=False), prior["channels"], data.channels)
    flag = {"channelsGrown": True} if grown is not None else {"channelMismatch": True} if mismatch else {}
    emit("progress", model=W.MODEL_NAME, epoch=0, epochs=args.epochs, device=device, tensorflow=tf.__version__,
         **flag)
    created_at = int((state or {}).get("createdAt") or now_ms())
    if mismatch:
        state = None
    if state is not None:
        model = keras.models.load_model(model_path)
        opt = model.optimizer
    else:
        model = grown if grown is not None else W.build_model(len(data.channels), data.n_static, data.context,
                                                              data.horizon, args.hidden)
        opt = keras.optimizers.AdamW(learning_rate=args.lr, weight_decay=args.weight_decay)
        model.compile(optimizer=opt)
        if grown is None:
            created_at = now_ms()
    start_epoch = int((state or {}).get("epoch", 0))
    skip = int((state or {}).get("stepInEpoch", 0))
    step = int((state or {}).get("step", 0))
    round_start = int((state or {}).get("roundStart", 0))
    metrics = (state or {}).get("metrics")
    if state is not None and skip == 0 and start_epoch >= int(state.get("target", start_epoch)):
        round_start = start_epoch  # a finished run: --resume trains a new round of --epochs from it
    target = round_start + args.epochs
    train_step = W.make_train_step(model, opt)
    board = Board(args.tensorboard)
    task = {"worldId": data.world_id, "context": data.context, "horizon": data.horizon,
            "channels": data.channels, "nStatic": data.n_static}

    def save(epoch, in_epoch):
        tmp = model_path.with_name("model.tmp.keras")
        model.save(tmp)
        os.replace(tmp, model_path)
        atomic_json(state_path, {"format": STATE_FORMAT, "model": W.MODEL_NAME, "epoch": epoch,
                                 "stepInEpoch": in_epoch, "step": step, "epochs": args.epochs,
                                 "roundStart": round_start, "target": target, "task": task, "metrics": metrics,
                                 "seed": args.seed, "device": device, "tensorflow": tf.__version__,
                                 "createdAt": created_at, "savedAt": now_ms()})
        if metrics is not None:
            atomic_json(out / "metrics.json", {"model": W.MODEL_NAME, "framework": "tensorflow",
                                               "epoch": epoch, "epochs": args.epochs, "step": step,
                                               "device": device, "updatedAt": now_ms(), **metrics})
        classes = data.classes()
        atomic_json(out / "manifest.json", {
            "format": MODEL_FORMAT, "model": W.MODEL_NAME, "framework": "tensorflow",
            "tensorflow": tf.__version__, "createdAt": created_at, "updatedAt": now_ms(), "epoch": epoch,
            "step": step, "data": data.manifest(), "licenceClasses": classes,
            "openOnly": all(c == "open" for c in classes), "note": LOCAL_ONLY_NOTE,
        })
        emit("checkpoint", path=str(model_path))

    def finish(kind):
        emit("paused" if kind == "pause" else "done")
        return 0

    shown = lambda e: e - round_start + 1  # noqa: E731  1-based epoch within the round
    for epoch in range(start_epoch, target):
        data.train.set_epoch(epoch)
        in_epoch, recent, batches = 0, [], 0
        for i, batch in enumerate(W.batches(data.train, args.batch_size)):
            if args.max_batches and i >= args.max_batches:
                break
            batches += 1
            if epoch == start_epoch and i < skip:
                in_epoch = i + 1
                continue  # replaying the part of the epoch done before the pause
            rows, target_v, mask = W.place_rows(batch, data.context, data.horizon)
            in_epoch = i + 1
            if len(target_v):
                loss = float(train_step(rows, target_v, mask))
                step += 1
                recent.append(loss)
                if step % max(1, args.log_every) == 0:
                    mean = float(np.mean(recent))
                    emit("progress", model=W.MODEL_NAME, epoch=shown(epoch), epochs=args.epochs, step=step,
                         loss=mean)
                    board.scalars(step, {"train/loss": mean})
                    recent = []
            if args.sleep_ms:
                time.sleep(args.sleep_ms / 1000.0)
            req = control.requested()
            if req:
                save(epoch, in_epoch)
                return finish(req)
        if batches == 0:
            raise DataError("no training batches: are the bins shorter than context + horizon?")
        if recent:
            mean = float(np.mean(recent))
            emit("progress", model=W.MODEL_NAME, epoch=shown(epoch), epochs=args.epochs, step=step, loss=mean)
            board.scalars(step, {"train/loss": mean})
        skip = 0
        metrics = W.evaluate(model, data, args.eval_windows)
        board.skill(step, metrics)
        emit("metrics", **{k: v for k, v in metrics.items() if k in ("skill", "domains", "inSample")},
             model=W.MODEL_NAME, epoch=shown(epoch))
        save(epoch + 1, 0)
        req = control.requested()
        if req:
            return finish(req)
    emit("done")
    return 0


def main(argv=None) -> int:
    emit = Emitter(sys.stdout)
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as e:  # argparse already printed the usage to stderr
        return int(e.code or 0)
    control = Control()
    try:
        control.listen(sys.stdin.fileno())
    except (AttributeError, OSError, ValueError):
        pass  # no usable stdin: nothing to listen to
    try:
        return run(args, emit, control)
    except DataError as e:
        emit("error", message=str(e))
        return 1
    except ImportError as e:
        emit("error", message=f"TensorFlow is not installed in this Python ({e.name or e}): "
                              "npm run tensorflow:wsl-setup, or py -3.13 -m pip install tensorflow")
        return 1
    except Exception as e:  # report anything else on the protocol too
        traceback.print_exc(file=sys.stderr)
        emit("error", message=f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")  # before TensorFlow is imported
    sys.exit(main())
