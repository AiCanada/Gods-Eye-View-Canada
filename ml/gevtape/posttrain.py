"""Post-train an existing world model on the newest recorded data, to keep it up to date.

    python -m ml.gevtape.posttrain --data .gev-data --adapter kit_world:KitWorldAdapter
                                   --checkpoint <model file or folder> --out <folder>
                                   [--epochs 1] [--context 24] [--horizon 6] [--batch-size 8]
                                   [--device auto|cpu|cuda] [--resume]

Owner request 2026-10-16: "This training sim can also be used to update
existing World models via Post training to keep the most up to date". The
kit's own world model already does this by itself: every day it resumes from
its checkpoint and trains a new round on every recorded day, old and new,
and a new data layer or asset grows it instead of replacing it
(models.grow_world_model). This runner does the same for a world model that
is not the kit's own: an adapter loads it, the runner feeds it the recorded
hours (the same windows the kit's model trains on), and the adapter saves it.

An adapter is a Python class in a file the owner put in ml/adapters/ (this
repository) or .gev-data/ai-world/adapters/; `--adapter module:Class` names
it, nothing else is imported. It is built as

    Class(checkpoint, device=..., channels=[...], context=24, horizon=6, out_dir=...)

and has
    train_step(batch) -> float    one update on the batch, its loss
    evaluate(batch)   -> float    the loss without an update (optional)
    save(folder)                  writes the post-trained model there

A batch is a dict of torch tensors on the device: v [B, L, K, C] symlog
values (0 where missing), m [B, L, K, C] the observed mask, tf [B, L, K, 6]
time features, s [B, K, S] place features, adj the place graph, plus
`channels`, `context` and `horizon`. L = context + horizon.

The last days recorded are held out: metrics.json gives the held-out loss
before and after post-training (did it help?), the days trained through, and
the licence classes of the data. Same JSON-lines protocol as ml.gevtape.train
(progress / checkpoint / posttrain / paused / done / error; {"cmd":"pause"} and
{"cmd":"stop"} on stdin save the model and the step, and --resume continues).
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

import torch
from torch.utils.data import default_collate

from . import reader as R
from . import torch_data as td
from .adapters import ADAPTER_SPEC, REPO_ROOT, adapter_dirs, load_adapter_class  # noqa: F401
from .train import Control, DataError, Emitter, atomic_json, now_ms, resolve_device


def latest_bins(data_root):
    worlds = R.list_bin_worlds(data_root)
    if not worlds:
        raise DataError(f"no bins under {R.gev_paths(data_root)['bins']}: record and bin a day first")
    return worlds[-1]


def batches(dataset, size, limit=None):
    items = []
    for n, item in enumerate(dataset):
        if limit is not None and n >= limit:
            break
        items.append(item)
        if len(items) == size:
            yield default_collate(items)
            items = []
    if items:
        yield default_collate(items)


def on_device(batch, device, adj, extra):
    out = {k: (v.to(device) if torch.is_tensor(v) else v) for k, v in batch.items()}
    out["adj"] = adj
    out.update(extra)
    return out


def held_out_loss(adapter, dataset, size, device, adj, extra, limit):
    fn = getattr(adapter, "evaluate", None)
    if not callable(fn):
        return None
    total, n = 0.0, 0
    with torch.no_grad():
        for batch in batches(dataset, size, limit):
            loss = fn(on_device(batch, device, adj, extra))
            if loss is not None and float(loss) == float(loss):
                total += float(loss)
                n += 1
    return total / n if n else None


def run(args, emit, control) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    root = Path(args.data)
    cls, adapter_path = load_adapter_class(args.adapter, root)
    bins_dir = latest_bins(root)
    series = td.load_bin_series(bins_dir)
    if series is None:
        raise DataError(f"no bins in {bins_dir}")
    world_dir = R.find_world(root, bins_dir.name)
    world = R.load_world(world_dir, data_root=root) if world_dir else None
    days = series["days"]
    n_val = max(1, round(len(days) * 0.2)) if len(days) >= 2 else 0
    val_days = days[-n_val:] if n_val else []
    H = series["values"].shape[0]
    cut = ((val_days[0] - series["start"]).days * 24) if val_days else H
    common = dict(world=world, context=args.context, horizon=args.horizon, seed=args.seed)
    train_set = td.BinWindows(series, stride=args.stride, target_hours=(0, cut), **common)
    val_set = td.BinWindows(series, stride=max(1, args.horizon), target_hours=(cut, H), shuffle=False, **common)
    if len(train_set) == 0:
        raise DataError(f"not enough recorded hours for one window of {args.context + args.horizon}")
    device = resolve_device(args.device)
    K = series["values"].shape[1]
    if world is not None and world.K == K:
        from . import models as M
        r, c, w = R.place_edges(world)
        adj = M.adjacency_tensor(r, c, w, K).to(device)
    else:
        adj = torch.eye(K, device=device)
    state_file = out / "posttrain-state.json"
    state = json.loads(state_file.read_text()) if (args.resume and state_file.is_file()) else {}
    checkpoint = str(out / "model") if state.get("saved") else str(args.checkpoint)
    if not Path(checkpoint).exists():
        raise DataError(f"no model at {checkpoint}")
    extra = {"channels": list(series["channels"]), "context": args.context, "horizon": args.horizon}
    adapter = cls(checkpoint, device=str(device), channels=extra["channels"], context=args.context,
                  horizon=args.horizon, out_dir=str(out))
    limit = args.eval_windows
    before = state.get("heldOutLossBefore")
    if before is None:
        before = held_out_loss(adapter, val_set, args.batch_size, device, adj, extra, limit)
    start_epoch, skip = int(state.get("epoch", 0)), int(state.get("step", 0))
    emit("progress", model="posttrain", epoch=start_epoch, epochs=args.epochs)

    def save(epoch, step, saved=True):
        adapter.save(str(out / "model"))
        atomic_json(state_file, {"epoch": epoch, "step": step, "saved": saved, "heldOutLossBefore": before,
                                 "adapter": args.adapter, "checkpoint": str(args.checkpoint)})

    last_loss = None
    for epoch in range(start_epoch, args.epochs):
        train_set.set_epoch(epoch)
        for step, batch in enumerate(batches(train_set, args.batch_size)):
            if epoch == start_epoch and step < skip:
                continue
            last_loss = float(adapter.train_step(on_device(batch, device, adj, extra)))
            wanted = control.requested()
            if wanted:
                save(epoch, step + 1)
                emit("checkpoint", model="posttrain", epoch=epoch, step=step + 1)
                emit("paused" if wanted == "pause" else "done", model="posttrain")
                return 0
        emit("progress", model="posttrain", epoch=epoch + 1, epochs=args.epochs, loss=last_loss)
        save(epoch + 1, 0)
    after = held_out_loss(adapter, val_set, args.batch_size, device, adj, extra, limit)
    classes = sorted(set(series["classes"])) or ["unclear"]
    metrics = {
        "model": "posttrain",
        "adapter": args.adapter,
        "adapterFile": str(adapter_path),
        "checkpoint": str(args.checkpoint),
        "saved": str(out / "model"),
        "worldId": bins_dir.name,
        "days": [d.isoformat() for d in days],
        "trainedThrough": (days[:-n_val] or days)[-1].isoformat() if days else None,
        "heldOutDays": [d.isoformat() for d in val_days],
        "heldOutLossBefore": before,
        "heldOutLossAfter": after,
        "helped": (before is not None and after is not None and after < before),
        "trainLoss": last_loss,
        "channels": extra["channels"],
        "licenceClasses": classes,
        "updatedAt": now_ms(),
    }
    atomic_json(out / "metrics.json", metrics)
    # Its own event: a `metrics` event would stand in for the kit model's scores.
    emit("posttrain", model="posttrain", helped=metrics["helped"],
         before=metrics["heldOutLossBefore"], after=metrics["heldOutLossAfter"])
    emit("done", model="posttrain")
    return 0


def build_parser():
    p = argparse.ArgumentParser(prog="python -m ml.gevtape.posttrain", description=__doc__.split("\n\n")[0])
    p.add_argument("--data", required=True)
    p.add_argument("--adapter", required=True, help="module:Class in ml/adapters/ or .gev-data/ai-world/adapters/")
    p.add_argument("--checkpoint", required=True, help="the existing model (a file or a folder)")
    p.add_argument("--out", required=True)
    p.add_argument("--epochs", type=int, default=1)
    p.add_argument("--context", type=int, default=24)
    p.add_argument("--horizon", type=int, default=6)
    p.add_argument("--stride", type=int, default=6)
    p.add_argument("--batch-size", type=int, default=8)
    p.add_argument("--eval-windows", type=int, default=64)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--device", default="auto")
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
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        emit("error", message=f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
