"""Trainer child process (docs/AI-WORLD-TAB.md, "Child-process protocol").

    python -m ml.gevtape.train --data <.gev-data> --model {outbreak,world,tracks} --out <dir>
                               [--epochs N] [--resume] [--device auto|cpu|cuda] [...]

stdout carries only protocol lines, one JSON object each:
  {"event":"progress","model","epoch","epochs","step","loss"}   epoch is 1-based
  {"event":"checkpoint","path"}
  {"event":"metrics","skill":{"metric":"mae","model","persistence"}, ...}
  {"event":"paused"}  {"event":"done"}  {"event":"error","message"}
stdin takes {"cmd":"pause"} (checkpoint at the next step boundary, print
paused, exit 0) and {"cmd":"stop"} (checkpoint, print done, exit 0), read
on a background thread. Anything human-readable goes to stderr.

<out>/checkpoint.pt  model + optimizer + epoch/step + RNG states (resume
                     with --resume continues exactly: same batches, same
                     weights as an uninterrupted run; --resume on a finished
                     run trains another --epochs from its weights, on the
                     data there is now)
<out>/metrics.json   skill against persistence on held-out data (MAE)
<out>/manifest.json  the data it trained on and the licence classes seen

Models: outbreak (sim episodes, country level), world (hourly bins on the
tracked places), tracks (moving things on the tape).
"""

from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import random
import sys
import threading
import time
import traceback
import zlib
from itertools import islice
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as Fn
from torch.utils.data import DataLoader, IterableDataset, default_collate

from . import formats as F
from . import geo
from . import models as M
from . import reader as R
from . import torch_data as td

CHECKPOINT_FORMAT = "gevtape-checkpoint/1"
MODEL_FORMAT = "gevtape-model/1"
LOCAL_ONLY_NOTE = ("Trained locally for the AI World tab. Not for publication: only 'open' "
                   "data may ever enter something published, and only with the owner's say.")

DEFAULTS = {
    "outbreak": {"batch_size": 16, "lr": 2e-3, "context": 7, "horizon": 7, "stride": 1},
    "world": {"batch_size": 8, "lr": 2e-3, "context": 24, "horizon": 24, "stride": 1},
    "tracks": {"batch_size": 256, "lr": 2e-3, "context": 8, "horizon": 60, "stride": 1},
}


class DataError(RuntimeError):
    """The data needed for a model is missing or too short."""


# --------------------------------------------------------------------------
# Protocol plumbing
# --------------------------------------------------------------------------


def _clean(value):
    """JSON-safe: non-finite floats become null, numpy scalars plain numbers."""
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if isinstance(value, (np.floating, float)):
        v = float(value)
        return v if math.isfinite(v) else None
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.bool_):
        return bool(value)
    return value


class Emitter:
    """Writes protocol events as JSON lines (ASCII, LF only) to stdout or a given stream."""

    def __init__(self, stream=None):
        self.stream = stream if stream is not None else sys.stdout
        self.lock = threading.Lock()

    def __call__(self, event: str, **fields):
        line = json.dumps(_clean({"event": event, **fields}), separators=(",", ":"))
        with self.lock:
            raw = getattr(self.stream, "buffer", None)
            if raw is not None:  # bytes: no CRLF translation on Windows
                self.stream.flush()
                raw.write(line.encode("ascii") + b"\n")
                raw.flush()
            else:
                self.stream.write(line + "\n")
                self.stream.flush()


class Control:
    """Pause / stop requests, set from stdin (listen) or directly (tests)."""

    def __init__(self):
        self.pause = threading.Event()
        self.stop = threading.Event()

    def requested(self):
        if self.stop.is_set():
            return "stop"
        if self.pause.is_set():
            return "pause"
        return None

    def handle(self, line: str):
        try:
            cmd = json.loads(line).get("cmd")
        except (ValueError, AttributeError):
            return
        if cmd == "pause":
            self.pause.set()
        elif cmd == "stop":
            self.stop.set()

    def listen(self, fd: int):
        """Read commands from a file descriptor on a daemon thread (os.read: no
        buffered-reader lock is held, so interpreter shutdown never waits on it)."""

        def run():
            buf = b""
            while True:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    return
                if not chunk:
                    return  # EOF: the server closed our stdin; keep training
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    self.handle(line.decode("utf-8", "replace"))

        t = threading.Thread(target=run, name="gevtape-stdin", daemon=True)
        t.start()
        return t


def log(*parts):
    print(*parts, file=sys.stderr, flush=True)


def now_ms() -> int:
    return int(time.time() * 1000)


def resolve_device(name: str) -> torch.device:
    if name == "cpu":
        return torch.device("cpu")
    if torch.cuda.is_available():
        return torch.device("cuda")
    if name == "cuda":
        log("gevtape: CUDA requested but not available; using the CPU")
    return torch.device("cpu")


def seed_everything(seed: int):
    random.seed(seed)
    np.random.seed(seed % (2 ** 32))
    torch.manual_seed(seed)


def rng_state() -> dict:
    """Every global RNG, in a form torch.load(weights_only=True) accepts."""
    np_state = np.random.get_state(legacy=False)
    return {
        "python": random.getstate(),
        "numpy": {"bit_generator": np_state["bit_generator"],
                  "key": torch.from_numpy(np.asarray(np_state["state"]["key"], dtype=np.int64)),
                  "pos": int(np_state["state"]["pos"]), "has_gauss": int(np_state["has_gauss"]),
                  "gauss": float(np_state["gauss"])},
        "torch": torch.get_rng_state(),
        "cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else [],
    }


def set_rng_state(st: dict):
    py = st["python"]
    random.setstate((py[0], tuple(py[1]), py[2]))
    n = st["numpy"]
    np.random.set_state({"bit_generator": n["bit_generator"],
                         "state": {"key": n["key"].numpy().astype(np.uint32), "pos": n["pos"]},
                         "has_gauss": n["has_gauss"], "gauss": n["gauss"]})
    torch.set_rng_state(st["torch"])
    if st.get("cuda") and torch.cuda.is_available():
        try:
            torch.cuda.set_rng_state_all(st["cuda"])
        except RuntimeError:
            pass  # a different GPU count; CUDA draws are not used by these models


def atomic_json(path: Path, obj):
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(_clean(obj), f, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def atomic_torch_save(path: Path, obj):
    tmp = path.with_name(path.name + ".tmp")
    torch.save(obj, tmp)
    os.replace(tmp, path)


def load_checkpoint(path) -> dict:
    """A checkpoint written by this module (tensors and plain containers only)."""
    return torch.load(path, map_location="cpu", weights_only=True)


class Chain(IterableDataset):
    """Several IterableDatasets one after the other, passing set_epoch on."""

    def __init__(self, parts):
        super().__init__()
        self.parts = list(parts)

    def set_epoch(self, epoch):
        for p in self.parts:
            if hasattr(p, "set_epoch"):
                p.set_epoch(epoch)

    def __iter__(self):
        for p in self.parts:
            yield from p


def _batches(items, size):
    """Collate a list of dict items into batches of tensors (for eval sets)."""
    for i in range(0, len(items), size):
        yield default_collate(items[i: i + size])


# --------------------------------------------------------------------------
# Tasks
# --------------------------------------------------------------------------


class Task:
    """What a model trains on: its data, loss, evaluation and manifest."""

    kind = ""

    def __init__(self, args, prior=None):
        self.args = args
        self.prior = prior or {}

    def build_model(self):  # -> nn.Module
        raise NotImplementedError

    def to(self, device):
        """Move fixed tensors (graphs) to the device."""

    def train_dataset(self):  # -> IterableDataset with set_epoch
        raise NotImplementedError

    def loss(self, model, batch, device):
        raise NotImplementedError

    def evaluate(self, model, device) -> dict:
        raise NotImplementedError

    def state(self) -> dict:
        """What serve needs besides the weights (stored in the checkpoint)."""
        return {}

    def manifest(self) -> dict:
        raise NotImplementedError


def split_ids(ids, val_fraction: float, seed: int):
    """(train, held out): a seeded shuffle of the sorted ids, at least one held out when there are two."""
    ids = sorted(set(ids))
    if len(ids) < 2 or val_fraction <= 0:
        return set(ids), set()
    order = list(ids)
    random.Random(seed).shuffle(order)
    n_val = min(len(ids) - 1, max(1, round(len(ids) * val_fraction)))
    return set(order[n_val:]), set(order[:n_val])


def episode_keys(dataset_dir) -> list:
    """Episode keys of a dataset (index.jsonl, else the shard member names)."""
    keys = [str(e.get("key")) for e in R.read_index(dataset_dir) if isinstance(e, dict) and e.get("key")]
    if keys:
        return keys
    import tarfile
    for shard in R.list_shards(dataset_dir):
        with tarfile.open(shard, mode="r|gz") as tf:
            for m in tf:
                base = m.name.rsplit("/", 1)[-1]
                if base.endswith(".json"):
                    keys.append(base[:-5])
    return keys


class OutbreakTask(Task):
    kind = "outbreak"

    def __init__(self, args, prior=None):
        super().__init__(args, prior)
        root = Path(args.data)
        datasets = R.list_datasets(root)
        if args.dataset:
            datasets = [d for d in datasets if d.name in set(args.dataset)]
        if not datasets:
            raise DataError(f"no outbreak datasets under {R.gev_paths(root)['datasets']}")
        metas = {d: R.load_dataset_meta(d) for d in datasets}
        self.world_id = self.prior.get("worldId") or args.world_id or metas[datasets[-1]].get("worldId")
        self.datasets = [d for d in datasets if metas[d].get("worldId") == self.world_id] or datasets[-1:]
        self.metas = {d: metas[d] for d in self.datasets}
        wdir = R.find_world(root, self.world_id)
        self.world = R.load_world(wdir, data_root=root) if wdir is not None else None
        if self.world is None:
            log(f"gevtape: world {self.world_id} not found; country populations come from the episodes, no graph")
        self.context = int(self.prior.get("context") or args.context)
        self.horizon = int(self.prior.get("horizon") or args.horizon)
        days = [R.dataset_field(m, "days") for m in self.metas.values()]
        days = [int(d) for d in days if isinstance(d, (int, float)) and d > 0]
        if days and not self.prior and min(days) + 1 < self.context + self.horizon:
            rows = min(days) + 1  # short episodes (a smoke dataset): shrink the window to fit
            self.horizon = max(1, min(self.horizon, rows // 2))
            self.context = max(1, min(self.context, rows - self.horizon))
            log(f"gevtape: episodes have {rows} rows; window shrunk to context {self.context}, horizon {self.horizon}")
        self.n_static = self.prior.get("nStatic")
        # Held-out split by scenario, per dataset (both arms and every run of a scenario stay together).
        self.train_scen, self.val_scen, self.keys = {}, {}, {}
        for d in self.datasets:
            keys = episode_keys(d)
            self.keys[d] = keys
            scen = [R.parse_key(k)[0] for k in keys if R.parse_key(k)[0] is not None]
            self.train_scen[d], self.val_scen[d] = split_ids(scen, args.val_fraction, args.seed)
        self.in_sample = not any(self.val_scen.values())
        # Static features and the graph.
        probe = None
        if self.world is None:
            probe = next(R.iter_episodes(self.datasets[-1]), None)
            if probe is None:
                raise DataError("the dataset has no episodes yet")
        self.static = td.outbreak_static(self.world, "country", probe, self.n_static)
        self.n_static = int(self.static.shape[1])
        C = self.static.shape[0]
        if self.world is not None:
            A = R.normalized_adjacency(R.country_graph(self.world))
        else:
            A = np.zeros((C, C), np.float32)
        self.adj_np = A
        self.adj = M.dense_to_tensor(A)
        self._pairs = None

    def build_model(self):
        return M.OutbreakSurrogate(n_static=self.n_static, hidden=self.args.hidden, rounds=self.args.rounds)

    def to(self, device):
        self.adj = self.adj.to(device)

    def _windows(self, scen_sets, *, shuffle, stride):
        parts = [td.EpisodeWindows(d, world=self.world, context=self.context, horizon=self.horizon,
                                   scenarios=scen_sets[d], shuffle=shuffle, stride=stride,
                                   seed=self.args.seed, n_static=self.n_static)
                 for d in self.datasets if scen_sets[d]]
        return Chain(parts)

    def train_dataset(self):
        return self._windows(self.train_scen, shuffle=True, stride=self.args.stride)

    def loss(self, model, batch, device):
        x = batch["x"].to(device)
        pred = model(x, batch["a"].to(device), batch["s"].to(device), self.adj)
        return Fn.mse_loss(pred, x[:, 1:] - x[:, :-1])

    def val_items(self):
        """The held-out windows (up to eval_windows), read again for each evaluation:
        at real scale they are too big to keep (a window is C x 22 x context + horizon)."""
        sets = self.train_scen if self.in_sample else self.val_scen
        ds = self._windows(sets, shuffle=False, stride=max(1, self.horizon))
        return list(islice(iter(ds), self.args.eval_windows))

    def _pair_arm(self, ep):
        """(row 0 features [1, C, 22], actions [T, C, 14], simulated final infected) of one arm."""
        inf = F.CUM_CHANNELS.index("infected")
        return (td.outbreak_features(ep)[:1], td.outbreak_actions(ep, "country", self.world),
                float(ep["country_cum"][-1, :, inf].astype(np.int64).sum()))

    def pairs(self):
        """Up to cf_pairs (A, B) arm pairs, held-out scenarios first."""
        if self._pairs is not None:
            return self._pairs
        out = []
        for in_sample in (False, True):
            for d in self.datasets:
                want = self.train_scen[d] if in_sample else self.val_scen[d]
                arms = {}
                for k in self.keys[d]:
                    s, r, arm = R.parse_key(k)
                    if s in want and arm in ("A", "B"):
                        arms.setdefault((s, r), {})[arm] = k
                chosen = [v for _, v in sorted(arms.items()) if len(v) == 2][: self.args.cf_pairs - len(out)]
                if not chosen:
                    continue
                keys = {k for v in chosen for k in v.values()}
                arms_of = {}
                for ep in R.iter_episodes(d, keys=keys):
                    if ep.complete:  # keep what the rollout needs, not the episode (~20 MB at K = 5000)
                        arms_of[ep.key] = self._pair_arm(ep)
                for v in chosen:
                    if v["A"] in arms_of and v["B"] in arms_of:
                        out.append((arms_of[v["A"]], arms_of[v["B"]], in_sample))
            if out:
                break
        self._pairs = out
        return out

    @torch.no_grad()
    def evaluate(self, model, device):
        model.eval()
        c, h = self.context, self.horizon
        items = self.val_items()
        if not items:
            return {"skill": None, "note": "no held-out windows (episodes shorter than context + horizon?)"}
        inf = F.OUTBREAK_FEATURES.index("cum.infected")
        nF = len(F.OUTBREAK_FEATURES)
        sums = {k: [torch.zeros(h, nF, dtype=torch.float64), torch.zeros(h, nF, dtype=torch.float64), 0.0]
                for k in ("all", "reached")}
        for batch in _batches(items, self.args.batch_size):
            x = batch["x"].to(device)
            pred = model.rollout(x[:, :c], batch["a"].to(device), batch["s"].to(device), self.adj, h)
            tgt = x[:, c:]
            pers = x[:, c - 1: c].expand_as(tgt)
            abs_m, abs_p = (pred - tgt).abs(), (pers - tgt).abs()
            # Reached: countries with an infection by the end of the context or in the targets.
            reached = (x[:, c - 1:, :, inf] > 0).any(dim=1).to(x.dtype)
            for key, w in (("all", torch.ones_like(reached)), ("reached", reached)):
                wx = w[:, None, :, None]
                sums[key][0] += (abs_m * wx).sum(dim=(0, 2)).double().cpu()
                sums[key][1] += (abs_p * wx).sum(dim=(0, 2)).double().cpu()
                sums[key][2] += float(w.sum())

        def table(key):
            m, p, n = sums[key]
            return (m / max(n, 1.0)).numpy(), (p / max(n, 1.0)).numpy(), n

        mm, mp, n_all = table("all")
        rm, rp, n_reached = table("reached")
        prim_m, prim_p = (rm, rp) if n_reached > 0 else (mm, mp)
        out = {
            "skill": {"metric": "mae", "model": float(prim_m.mean()), "persistence": float(prim_p.mean())},
            "skillAllCountries": {"metric": "mae", "model": float(mm.mean()), "persistence": float(mp.mean())},
            "space": ("log1p people, mean over the 22 features and horizon days; skill over the countries "
                      "the outbreak has reached (all countries when none has), skillAllCountries over all"),
            "reachedShare": n_reached / max(n_all, 1.0),
            "contextDays": c, "horizonDays": h, "windows": len(items), "inSample": self.in_sample,
            "byHorizon": {"model": prim_m.mean(axis=1).tolist(), "persistence": prim_p.mean(axis=1).tolist()},
            "byFeature": {f: {"model": float(prim_m[:, i].mean()), "persistence": float(prim_p[:, i].mean())}
                          for i, f in enumerate(F.OUTBREAK_FEATURES)},
        }
        cf = self.counterfactual(model, device)
        if cf is not None:
            out["counterfactual"] = cf
        return out

    @torch.no_grad()
    def counterfactual(self, model, device):
        pairs = self.pairs()
        if not pairs:
            return None
        idx = F.OUTBREAK_FEATURES.index("cum.infected")
        s = torch.from_numpy(self.static)[None].to(device)
        errs, sims = [], []
        for A, B, _ in pairs:
            if A[1].shape[0] != B[1].shape[0]:
                continue  # arms of different lengths (a cut run): not comparable
            T = A[1].shape[0]
            finals = []
            for x0, acts, _final in (A, B):
                x = torch.from_numpy(x0)[None].to(device)
                a = torch.from_numpy(acts)[None].to(device)
                finals.append(model.rollout(x, a, s, self.adj, T)[0, -1, :, idx])
            pred = float(torch.expm1(finals[1]).sum() - torch.expm1(finals[0]).sum())
            sim = B[2] - A[2]
            errs.append(abs(pred - sim))
            sims.append(abs(sim))
        if not errs:
            return None
        return {"metric": "final infected, arm B minus arm A (people); median |predicted - simulated|",
                "pairs": len(pairs), "medianAbsError": float(np.median(errs)),
                "medianAbsSimulatedDiff": float(np.median(sims)),
                "inSample": bool(any(p[2] for p in pairs))}

    def state(self):
        return {"worldId": self.world_id, "context": self.context, "horizon": self.horizon,
                "nStatic": self.n_static, "level": "country", "features": list(F.OUTBREAK_FEATURES),
                "demographics": self.world is not None and self.world.demographics is not None,
                "actions": list(F.GLOBAL_ACTIONS) + list(F.COUNTRY_ACTIONS) + list(F.PLACE_ACTIONS)}

    def manifest(self):
        classes = set()
        datasets = []
        for d in self.datasets:
            m = self.metas[d]
            cl = R.declared_classes(m)
            classes.update(cl)
            datasets.append({"name": d.name, "worldId": m.get("worldId"), "days": R.dataset_field(m, "days"),
                             "runs": R.dataset_field(m, "runs"), "episodes": len(self.keys[d]),
                             "shards": len(R.list_shards(d)), "licences": cl,
                             "heldOutScenarios": sorted(self.val_scen[d])})
        if self.world is not None:
            classes.update(self.world.licence_classes)
            if self.world.demographics is not None:
                classes.add("open")  # World Bank WDI, CC BY 4.0 (docs/WORLD-MODEL-DATA.md, Demographics)
        return {"datasets": datasets, "worldId": self.world_id,
                "demographics": self.world is not None and self.world.demographics is not None,
                "world": str(self.world.path) if self.world is not None else None,
                "classes": sorted(classes) or [F.UNKNOWN_CLASS]}


def balanced_channel_loss(pred, target, mask):
    """Mean squared error, averaged across channels that were observed.

    A dense channel does not drown a rare one. A channel with no observation
    is left out of the average, not scored as a perfect zero.
    """
    err = (pred - target) ** 2 * mask
    dims = tuple(range(err.ndim - 1))
    counts = mask.sum(dim=dims)
    present = counts > 0
    if not bool(present.any()):
        return err.sum() * 0
    return (err.sum(dim=dims)[present] / counts[present]).mean()


class WorldTask(Task):
    kind = "world"

    def __init__(self, args, prior=None):
        super().__init__(args, prior)
        root = Path(args.data)
        wid = self.prior.get("worldId") or args.world_id
        if wid:
            self.bins_dir = R.gev_paths(root)["bins"] / wid
        else:
            worlds = R.list_bin_worlds(root)
            if not worlds:
                raise DataError(f"no bins under {R.gev_paths(root)['bins']}")
            self.bins_dir = worlds[-1]
        self.world_id = self.bins_dir.name
        wdir = R.find_world(root, self.world_id)
        self.world = R.load_world(wdir, data_root=root) if wdir is not None else None
        disk = td.load_bin_series(self.bins_dir, channels=None)
        if disk is None:
            raise DataError(f"no bins in {self.bins_dir}")
        disk_channels = list(disk["channels"])
        prior_channels = list(self.prior.get("channels") or [])
        # A checkpoint trained on a different channel list is not resumed.
        # The next run starts a new world model on the bins as they are now.
        self.channel_mismatch = bool(prior_channels) and prior_channels != disk_channels
        self.series = disk
        self.channels = disk_channels
        self.context = int(self.prior.get("context") or args.context)
        self.horizon = int(self.prior.get("horizon") or args.horizon)
        days = self.series["days"]
        H = self.series["values"].shape[0]
        # Held out: the last days (at least one when there are two or more).
        n_val = max(1, round(len(days) * args.val_fraction)) if len(days) >= 2 else 0
        self.val_days = days[-n_val:] if n_val else []
        self.train_days = days[:-n_val] if n_val else days
        cut = ((self.val_days[0] - self.series["start"]).days * 24) if self.val_days else H
        K = self.series["values"].shape[1]
        self.n_static = int(self.prior.get("nStatic") or td.place_static(self.world, K).shape[1])
        common = dict(world=self.world, context=self.context, horizon=self.horizon, seed=args.seed,
                      n_static=self.n_static)
        self.train = td.BinWindows(self.series, stride=args.stride, target_hours=(0, cut),
                                   max_places=args.max_places, **common)
        if len(self.train) == 0:
            raise DataError(f"not enough bins for one window: need {self.context + self.horizon} hours "
                            f"before the held-out days ({len(days)} days recorded)")
        val = td.BinWindows(self.series, stride=max(1, self.horizon), target_hours=(cut, H), shuffle=False, **common)
        self.in_sample = len(val) == 0
        if self.in_sample:
            val = td.BinWindows(self.series, stride=max(1, self.horizon), shuffle=False, **common)
        self.val = val
        K = self.series["values"].shape[1]
        if self.world is not None and self.world.K == K:
            r, c, w = R.place_edges(self.world)
        else:
            r = c = np.zeros(0, np.int64)
            w = np.zeros(0, np.float32)
        self.K, self.edges = K, (r, c, w)
        self.adj = M.adjacency_tensor(r, c, w, K)
        self.domain_cols = {dom: [i for i, ch in enumerate(self.channels) if ch.split(".", 1)[0] in groups]
                            for dom, groups in F.DOMAIN_GROUPS.items()}

    def build_model(self):
        return M.WorldModel(n_channels=len(self.channels), n_static=self.n_static, hidden=self.args.hidden,
                            rounds=self.args.rounds)

    def to(self, device):
        self.adj = self.adj.to(device)

    def train_dataset(self):
        return self.train

    def crop_adjacency(self, idx, device):
        """The graph of each window's places: the full one, or [B, P, P] induced and
        re-normalised on a crop."""
        idx = idx.cpu().numpy()
        B, P = idx.shape
        if P == self.K:
            return self.adj
        r, c, w = self.edges
        out = np.zeros((B, P, P), np.float32)
        for b in range(B):
            pos = np.full(self.K, -1, np.int64)
            pos[idx[b]] = np.arange(P)
            pr, pc = pos[r], pos[c]
            keep = (pr >= 0) & (pc >= 0)
            np.add.at(out[b], (pr[keep], pc[keep]), w[keep])
            tot = out[b].sum(axis=1, keepdims=True)
            out[b] = np.divide(out[b], tot, out=np.zeros_like(out[b]), where=tot > 0)
        return torch.from_numpy(out).to(device)

    def loss(self, model, batch, device):
        v, m = batch["v"].to(device), batch["m"].to(device)
        adj = self.crop_adjacency(batch["idx"], device)
        c, h = self.context, self.horizon
        pred, seen = model.predict_forward(
            v[:, :c], m[:, :c], batch["tf"].to(device), batch["s"].to(device), adj, h,
        )
        future = m[:, c:c + h]
        mask = future * seen.unsqueeze(1).to(dtype=future.dtype)
        return balanced_channel_loss(pred, v[:, c:c + h], mask)

    @torch.no_grad()
    def evaluate(self, model, device):
        model.eval()
        c, h = self.context, self.horizon
        Ch = len(self.channels)
        err_m = torch.zeros(Ch, dtype=torch.float64)
        err_p = torch.zeros(Ch, dtype=torch.float64)
        cnt = torch.zeros(Ch, dtype=torch.float64)
        starts = [int(s) for s in self.val.starts[: self.args.eval_windows]]
        size = self.args.batch_size
        # Built a batch at a time over every place: a K = 5000 window is tens of MB.
        for batch in (default_collate([self.val.window(s, crop=False) for s in starts[i: i + size]])
                      for i in range(0, len(starts), size)):
            v, m = batch["v"].to(device), batch["m"].to(device)
            pred, seen = model.rollout(v[:, :c], m[:, :c], batch["tf"].to(device), batch["s"].to(device), self.adj, h)
            # Persistence: the last value observed in the context.
            last = torch.zeros_like(v[:, 0])
            for t in range(c):
                last = torch.where(m[:, t] > 0, v[:, t], last)
            ok = (m[:, c:] > 0) & seen.unsqueeze(1)
            tgt = v[:, c:]
            okf = ok.double()
            err_m += ((pred - tgt).abs().double() * okf).sum(dim=(0, 1, 2)).cpu()
            err_p += ((last.unsqueeze(1) - tgt).abs().double() * okf).sum(dim=(0, 1, 2)).cpu()
            cnt += okf.sum(dim=(0, 1, 2)).cpu()
        if cnt.sum() == 0:
            return {"skill": None, "note": "no observed targets in the held-out windows"}

        def skill(cols):
            n = cnt[cols].sum()
            if n == 0:
                return None
            return {"metric": "mae", "model": float(err_m[cols].sum() / n), "persistence": float(err_p[cols].sum() / n)}

        allc = list(range(Ch))
        return {
            "skill": skill(allc),
            "space": "sign(x)*log1p(|x|) of the bin values, observed targets only",
            "contextHours": c, "horizonHours": h, "windows": len(starts), "inSample": self.in_sample,
            "heldOutDays": [str(d) for d in self.val_days],
            "domains": {dom: skill(cols) for dom, cols in self.domain_cols.items() if cols},
            "byChannel": {ch: skill([i]) for i, ch in enumerate(self.channels)},
        }

    def state(self):
        return {"worldId": self.world_id, "context": self.context, "horizon": self.horizon,
                "channels": self.channels, "nStatic": self.n_static,
                "demographics": self.world is not None and self.world.demographics is not None}

    def manifest(self):
        classes = set(self.series["classes"])
        if not classes:  # the bins do not say: take each feed's class off the tape for those days
            tape = R.gev_paths(self.args.data)["tape"]
            for d in self.series["days"]:
                classes.update(R.tape_day_classes(tape, d))
        if self.world is not None and self.world.demographics is not None:
            classes.add("open")  # World Bank WDI, CC BY 4.0
        return {"bins": str(self.bins_dir), "worldId": self.world_id,
                "demographics": self.world is not None and self.world.demographics is not None,
                "binDays": [str(d) for d in self.series["days"]],
                "heldOutDays": [str(d) for d in self.val_days], "channels": self.channels,
                "classes": sorted(classes) or [F.UNKNOWN_CLASS]}


class HeldOut:
    """A fifth of the track ids (crc32) held out; picklable for DataLoader workers."""

    def __init__(self, held: bool):
        self.held = held

    def __call__(self, tid: str) -> bool:
        return (zlib.crc32(tid.encode()) % 5 == 0) == self.held


class TrackTask(Task):
    kind = "tracks"

    def __init__(self, args, prior=None):
        super().__init__(args, prior)
        self.tape = R.gev_paths(args.data)["tape"]
        self.feeds = [f for f in R.list_tape_feeds(self.tape) if F.track_trainable(f) and R.list_tape_days(self.tape, f)]
        if not self.feeds:
            raise DataError(f"no track feeds ({', '.join(td.TRACK_KINDS)}) under {self.tape}")
        days = sorted({d for f in self.feeds for d in R.list_tape_days(self.tape, f)})
        self.days = days
        self.n_fixes = int(self.prior.get("nFixes") or args.n_fixes)
        self.horizons = list(self.prior.get("horizons") or F.TRACK_HORIZONS_MIN)
        # A checkpoint from another set of kinds (before military left) starts afresh.
        prior_kinds = self.prior.get("kinds")
        self.channel_mismatch = bool(prior_kinds) and list(prior_kinds) != list(td.TRACK_KINDS)
        common = dict(feeds=self.feeds, n_fixes=self.n_fixes, horizons_min=self.horizons, seed=args.seed,
                      sample=args.track_sample)
        if len(days) >= 2:
            self.val_days, self.train_days = days[-1:], days[:-1]
            self.train = td.TrackWindows(self.tape, days=self.train_days, **common)
            val = td.TrackWindows(self.tape, days=self.val_days, shuffle=False, **common)
            self.split = "last day held out"
        else:
            self.val_days, self.train_days = [], days
            self.train = td.TrackWindows(self.tape, days=days, id_filter=HeldOut(False), **common)
            val = td.TrackWindows(self.tape, days=days, id_filter=HeldOut(True), shuffle=False, **common)
            self.split = "one day: a fifth of the tracks (by id) held out"
        self.val_items = list(islice(iter(val), self.args.eval_windows))
        self.in_sample = not self.val_items
        if self.in_sample:
            self.val_items = list(islice(iter(td.TrackWindows(self.tape, days=days, shuffle=False, **common)),
                                         self.args.eval_windows))

    def build_model(self):
        return M.TrackPredictor(n_kinds=len(td.TRACK_KINDS), hidden=self.args.hidden, horizons=self.horizons)

    def train_dataset(self):
        return self.train

    def loss(self, model, batch, device):
        pred = model(batch["feats"].to(device), batch["kind"].to(device), batch["base"].to(device))
        w = batch["tmask"].to(device).unsqueeze(-1)
        err = Fn.smooth_l1_loss(pred, batch["target"].to(device), reduction="none", beta=1.0)
        return (err * w).sum() / (w.sum() * 2).clamp_min(1.0)

    @torch.no_grad()
    def evaluate(self, model, device):
        model.eval()
        if not self.val_items:
            return {"skill": None, "note": "no held-out track examples"}
        H = len(self.horizons)
        sums = {k: np.zeros(H) for k in ("model", "persistence", "cv")}
        cnt = np.zeros(H)
        for batch in _batches(self.val_items, 512):
            pred = model(batch["feats"].to(device), batch["kind"].to(device), batch["base"].to(device)).cpu().numpy()
            base = batch["base"].numpy()
            anchor = batch["anchor"].numpy()
            truth = batch["truth"].numpy()
            mask = batch["tmask"].numpy() > 0
            lat0, lon0 = anchor[:, 0:1], anchor[:, 1:2]
            for name, off in (("model", pred), ("cv", base)):
                la, lo = geo.aeqd_inverse(lat0, lon0, off[..., 0], off[..., 1])
                e = geo.haversine_km(la, lo, truth[..., 0], truth[..., 1])
                sums[name] += np.where(mask, e, 0).sum(axis=0)
            e = geo.haversine_km(lat0, lon0, truth[..., 0], truth[..., 1])
            sums["persistence"] += np.where(mask, e, 0).sum(axis=0)
            cnt += mask.sum(axis=0)
        tot = max(cnt.sum(), 1)
        by = {k: (v / np.maximum(cnt, 1)).tolist() for k, v in sums.items()}
        return {
            "skill": {"metric": "mae", "model": float(sums["model"].sum() / tot),
                      "persistence": float(sums["persistence"].sum() / tot)},
            "constantVelocity": float(sums["cv"].sum() / tot),
            "space": "great-circle km at the horizons", "horizonsMin": self.horizons,
            "byHorizon": by, "examples": len(self.val_items), "inSample": self.in_sample, "split": self.split,
        }

    def state(self):
        return {"nFixes": self.n_fixes, "horizons": self.horizons, "kinds": list(td.TRACK_KINDS)}

    def manifest(self):
        classes = set()
        for d in self.days:
            classes.update(R.tape_day_classes(self.tape, d, self.feeds))
        return {"tape": str(self.tape), "feeds": self.feeds, "tapeDays": [str(d) for d in self.days],
                "heldOutDays": [str(d) for d in self.val_days], "split": self.split,
                "classes": sorted(classes) or [F.UNKNOWN_CLASS]}


TASKS = {"outbreak": OutbreakTask, "world": WorldTask, "tracks": TrackTask}


# --------------------------------------------------------------------------
# The loop
# --------------------------------------------------------------------------


def build_parser():
    ap = argparse.ArgumentParser(prog="python -m ml.gevtape.train", description=__doc__.split("\n\n")[0])
    ap.add_argument("--data", required=True, help="the .gev-data directory")
    ap.add_argument("--model", required=True, choices=sorted(TASKS))
    ap.add_argument("--out", required=True, help="model directory (checkpoint.pt, metrics.json, manifest.json)")
    ap.add_argument("--epochs", type=int, default=10)
    ap.add_argument("--resume", action="store_true", help="continue from <out>/checkpoint.pt (fresh start if none)")
    ap.add_argument("--device", default="auto", choices=("auto", "cpu", "cuda"))
    ap.add_argument("--batch-size", type=int, default=None)
    ap.add_argument("--lr", type=float, default=None)
    ap.add_argument("--weight-decay", type=float, default=1e-4)
    ap.add_argument("--hidden", type=int, default=64)
    ap.add_argument("--rounds", type=int, default=1, help="message-passing rounds per step (outbreak, world)")
    ap.add_argument("--context", type=int, default=None, help="history: days (outbreak), hours (world)")
    ap.add_argument("--horizon", type=int, default=None, help="targets: days (outbreak), hours (world)")
    ap.add_argument("--stride", type=int, default=None, help="window stride (days / hours)")
    ap.add_argument("--n-fixes", type=int, default=8, help="track history length (tracks)")
    ap.add_argument("--track-sample", type=float, default=1.0, help="share of track ids used (tracks)")
    ap.add_argument("--val-fraction", type=float, default=0.2)
    ap.add_argument("--dataset", action="append", help="dataset name under outbreak/datasets (repeatable)")
    ap.add_argument("--world-id", default=None)
    ap.add_argument("--eval-windows", type=int, default=512, help="cap on held-out windows / examples")
    ap.add_argument("--max-places", type=int, default=512,
                    help="world: train on crops of this many neighbouring tracked places (0: all)")
    ap.add_argument("--cf-pairs", type=int, default=32, help="cap on A/B pairs for counterfactual accuracy")
    ap.add_argument("--max-batches", type=int, default=0, help="cap on batches per epoch (0: the whole pass)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--workers", type=int, default=0, help="DataLoader worker processes")
    ap.add_argument("--threads", type=int, default=None, help="torch CPU threads")
    ap.add_argument("--bf16", action="store_true", help="bfloat16 autocast on CUDA")
    ap.add_argument("--log-every", type=int, default=10, help="progress event every N steps")
    ap.add_argument("--sleep-ms", type=int, default=0, help="pause between steps (share the machine; tests)")
    return ap


def parse_args(argv=None):
    args = build_parser().parse_args(argv)
    for k, v in DEFAULTS[args.model].items():
        if getattr(args, k, None) is None:
            setattr(args, k, v)
    return args


def _write_outputs(out: Path, args, task, metrics, epoch, step, created_at):
    if metrics is not None:
        atomic_json(out / "metrics.json", {"model": args.model, "epoch": epoch, "epochs": args.epochs, "step": step,
                                           "updatedAt": now_ms(), **metrics})
    man = task.manifest()
    classes = man.pop("classes")
    atomic_json(out / "manifest.json", {
        "format": MODEL_FORMAT, "model": args.model, "createdAt": created_at, "updatedAt": now_ms(),
        "epoch": epoch, "step": step, "data": man, "licenceClasses": classes,
        "openOnly": all(c == "open" for c in classes), "note": LOCAL_ONLY_NOTE,
    })


def run(args, emit, control) -> int:
    """Train per args; emit protocol events; honour control. Returns the exit code."""
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ckpt_path = out / "checkpoint.pt"
    if args.threads:
        torch.set_num_threads(args.threads)
    device = resolve_device(args.device)
    ckpt = load_checkpoint(ckpt_path) if (args.resume and ckpt_path.exists()) else None
    if ckpt is not None and ckpt.get("kind") != args.model:
        raise DataError(f"{ckpt_path} holds a {ckpt.get('kind')} model, not {args.model}")
    seed_everything(args.seed)
    task = TASKS[args.model](args, prior=(ckpt or {}).get("task"))
    mismatched = ckpt is not None and getattr(task, "channel_mismatch", False)
    grown = None
    if mismatched and args.model == "world" and (ckpt.get("task") or {}).get("channels"):
        # Post-training: a world model meets new channels grown, not replaced.
        grown = M.grow_world_model(ckpt["model"], ckpt["model_config"],
                                   ckpt["task"]["channels"], task.channels)
    if mismatched:
        prior_created = ckpt.get("createdAt")
        ckpt = None
    model = grown if grown is not None else (
        M.build_model(args.model, ckpt["model_config"]) if ckpt else task.build_model())
    if grown is not None:
        emit("progress", model=args.model, epoch=0, epochs=args.epochs, channelsGrown=True)
    elif mismatched:
        emit("progress", model=args.model, epoch=0, epochs=args.epochs, channelMismatch=True)
    model.to(device)
    task.to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    start_epoch, skip, step = 0, 0, 0
    round_start = 0
    metrics = None
    created_at = now_ms()
    if grown is not None and prior_created:
        created_at = int(prior_created)
    if ckpt is not None:
        model.load_state_dict(ckpt["model"])
        opt.load_state_dict(ckpt["optimizer"])
        start_epoch, skip, step = int(ckpt["epoch"]), int(ckpt["step_in_epoch"]), int(ckpt["step"])
        metrics = ckpt.get("metrics")
        created_at = int(ckpt.get("createdAt") or created_at)
        round_start = int(ckpt.get("round_start", 0))
        target = int(ckpt.get("target", ckpt.get("epochs", args.epochs)))
        if skip == 0 and start_epoch >= target:
            # A finished run: --resume starts a new round of --epochs from these
            # weights (the server retrains this way on the data recorded since).
            round_start = start_epoch
        set_rng_state(ckpt["rng"])
    target = round_start + args.epochs  # absolute epoch count this round reaches
    dataset = task.train_dataset()
    amp = args.bf16 and device.type == "cuda"

    def save(epoch, in_epoch):
        atomic_torch_save(ckpt_path, {
            "format": CHECKPOINT_FORMAT, "kind": args.model, "model_config": model.config,
            "model": model.state_dict(), "optimizer": opt.state_dict(),
            "epoch": epoch, "step_in_epoch": in_epoch, "step": step, "epochs": args.epochs,
            "round_start": round_start, "target": target,
            "rng": rng_state(), "task": task.state(), "metrics": metrics, "seed": args.seed,
            "createdAt": created_at, "savedAt": now_ms(),
        })
        _write_outputs(out, args, task, metrics, epoch, step, created_at)
        emit("checkpoint", path=str(ckpt_path))

    def finish(kind):
        emit("paused" if kind == "pause" else "done")
        return 0

    shown = lambda e: e - round_start + 1  # noqa: E731  1-based epoch within the round
    for epoch in range(start_epoch, target):
        dataset.set_epoch(epoch)
        loader = DataLoader(dataset, batch_size=args.batch_size, num_workers=args.workers,
                            generator=torch.Generator().manual_seed(args.seed + epoch),
                            persistent_workers=False)
        model.train()
        in_epoch, recent, batches = 0, [], 0
        for i, batch in enumerate(loader):
            if args.max_batches and i >= args.max_batches:
                break
            batches += 1
            if epoch == start_epoch and i < skip:
                in_epoch = i + 1
                continue  # replaying the part of the epoch done before the pause
            with (torch.autocast(device_type="cuda", dtype=torch.bfloat16) if amp else contextlib.nullcontext()):
                loss = task.loss(model, batch, device)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            step += 1
            in_epoch = i + 1
            recent.append(float(loss.detach()))
            if step % max(1, args.log_every) == 0:
                emit("progress", model=args.model, epoch=shown(epoch), epochs=args.epochs, step=step,
                     loss=float(np.mean(recent)))
                recent = []
            if args.sleep_ms:
                time.sleep(args.sleep_ms / 1000.0)
            req = control.requested()
            if req:
                save(epoch, in_epoch)
                return finish(req)
        if batches == 0:
            raise DataError("no training batches: is every episode/series shorter than context + horizon?")
        if recent:
            emit("progress", model=args.model, epoch=shown(epoch), epochs=args.epochs, step=step,
                 loss=float(np.mean(recent)))
        skip = 0
        metrics = task.evaluate(model, device)
        emit("metrics", **{k: v for k, v in metrics.items() if k in ("skill", "domains", "counterfactual",
                                                                    "constantVelocity", "inSample")},
             model=args.model, epoch=shown(epoch))
        save(epoch + 1, 0)
        req = control.requested()
        if req:
            return finish(req)
    emit("done")
    return 0


def main(argv=None) -> int:
    emit = Emitter(sys.stdout)
    try:
        args = parse_args(argv)
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
    except Exception as e:  # report anything else on the protocol too
        traceback.print_exc(file=sys.stderr)
        emit("error", message=f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
