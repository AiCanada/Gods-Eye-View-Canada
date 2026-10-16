"""Prediction child process (docs/AI-WORLD-TAB.md, "Child-process protocol").

    python -m ml.gevtape.serve --data <.gev-data> --models <dir> [--device cpu|auto|cuda]

One JSON request per stdin line, one JSON answer per stdout line:

  {"id":1,"cmd":"ping"}
    -> {"id":1,"ok":true,"result":{"models":[{name, kind, domains, epoch, step,
        updatedAt, classes, skill}, ...]}}
  {"id":2,"cmd":"predict","domain":"outbreak","horizon":24,"bbox":"w,s,e,n"}
    -> {"id":2,"ok":true,"result":Prediction}
  {"id":3,"cmd":"reload"}   forget loaded models (they also reload by mtime)
  {"id":4,"cmd":"close"}    answer, then exit 0 (so does end of stdin)
  anything else -> {"id":...,"ok":false,"error":"..."}

`horizon` is in hours (number or numeric string, default 24); `bbox` is
"w,s,e,n", [w,s,e,n] or null and filters points and tracks (w > e crosses
the antimeridian). Optional request fields: "channel" (which channel is the
heat value), "dataset" / "episode" (outbreak: which episode to roll on from).

Domains: outbreak (the surrogate rolled on from the newest episode of the
newest dataset, on the latest world snapshot), mobility / weather / hazards
/ news (the world model over the latest bins), tracks (the track predictor
over the latest tape). With no model, or not enough history, the answer is
a Prediction with `learning: {daysRecorded, needed}` and no points or
tracks: nothing is ever invented.

<models>/<kind>/checkpoint.pt is the model of each kind (outbreak, world,
tracks); a directory with another name counts when its manifest.json names
the kind.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import sys
import time
import traceback
from pathlib import Path

import numpy as np
import torch

from . import formats as F
from . import geo
from . import models as M
from . import reader as R
from . import torch_data as td
from .train import _clean, load_checkpoint

KINDS = ("outbreak", "world", "tracks")
NEEDED_DAYS = {"outbreak": 14, "world": 7, "tracks": 1}
MAX_HORIZON_HOURS = 24 * 30
MAX_WORLD_STEPS = 24 * 7
FRESH_TRACK_MS = 15 * 60000
MAX_TRACKS = 5000


class RequestError(ValueError):
    """A bad request (answered with ok: false)."""


def now_ms() -> int:
    return int(time.time() * 1000)


def prediction(domain, horizon, *, skill=None, learning=None, points=(), tracks=()) -> dict:
    """The documented Prediction shape."""
    return {"domain": domain, "horizonHours": horizon, "generatedAt": now_ms(), "skill": skill,
            "learning": learning, "points": list(points), "tracks": list(tracks)}


def parse_horizon(value) -> float:
    if value is None or value == "":
        return 24
    try:
        h = float(value)
    except (TypeError, ValueError):
        raise RequestError(f"horizon must be a number of hours, not {value!r}") from None
    if not math.isfinite(h) or h <= 0:
        raise RequestError("horizon must be a positive number of hours")
    h = min(h, MAX_HORIZON_HOURS)
    return int(h) if h == int(h) else h


class LoadedModel:
    def __init__(self, kind, path: Path, device):
        self.kind, self.path = kind, path
        self.mtime = path.stat().st_mtime
        ck = load_checkpoint(path)
        if ck.get("kind") != kind:
            raise ValueError(f"{path} holds a {ck.get('kind')} model")
        self.model = M.build_model(kind, ck["model_config"])
        self.model.load_state_dict(ck["model"])
        self.model.to(device).eval()
        self.config = ck["model_config"]
        self.state = ck.get("task") or {}
        self.epoch, self.step = ck.get("epoch"), ck.get("step")
        self.saved_at = ck.get("savedAt")
        d = path.parent
        self.metrics = _read_json(d / "metrics.json") or ck.get("metrics") or {}
        self.manifest = _read_json(d / "manifest.json") or {}

    def skill(self, domain=None):
        if domain is not None and isinstance(self.metrics.get("domains"), dict):
            s = self.metrics["domains"].get(domain)
            if s:
                return s
        return self.metrics.get("skill")


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


class ModelBank:
    """Checkpoints under --models, loaded lazily and reloaded when they change."""

    def __init__(self, models_dir, device):
        self.dir = Path(models_dir)
        self.device = device
        self.loaded = {}
        self.errors = {}

    def path_for(self, kind):
        p = self.dir / kind / "checkpoint.pt"
        if p.is_file():
            return p
        best = None
        if self.dir.is_dir():
            for d in self.dir.iterdir():
                ck = d / "checkpoint.pt"
                if ck.is_file() and (_read_json(d / "manifest.json") or {}).get("model") == kind:
                    if best is None or ck.stat().st_mtime > best.stat().st_mtime:
                        best = ck
        return best

    def get(self, kind):
        p = self.path_for(kind)
        if p is None:
            self.loaded.pop(kind, None)
            return None
        cur = self.loaded.get(kind)
        try:
            if cur is None or cur.path != p or cur.mtime != p.stat().st_mtime:
                self.loaded[kind] = LoadedModel(kind, p, self.device)
                self.errors.pop(kind, None)
        except Exception as e:  # a half-written or foreign file: keep what we had
            self.errors[kind] = f"{type(e).__name__}: {e}"
            print(f"gevtape serve: cannot load {p}: {e}", file=sys.stderr, flush=True)
        return self.loaded.get(kind)

    def describe(self):
        out = []
        for kind in KINDS:
            lm = self.get(kind)
            if lm is None:
                continue
            if kind == "outbreak":
                domains = ["outbreak"]
            elif kind == "tracks":
                domains = ["tracks", "flights", "vessels", "transit"]
            else:
                domains = []
                for ch in lm.state.get("channels", []):
                    group = str(ch).split(".", 1)[0]
                    if group and group != "military" and not group.startswith("military-") and group not in domains:
                        domains.append(group)
            out.append({"name": lm.path.parent.name, "kind": kind, "domains": domains, "epoch": lm.epoch,
                        "step": lm.step, "updatedAt": lm.saved_at, "path": str(lm.path),
                        "classes": lm.manifest.get("licenceClasses"), "skill": lm.skill()})
        return out


class Server:
    def __init__(self, data_root, models_dir, device="cpu", needed_days=None):
        self.root = Path(data_root)
        self.paths = R.gev_paths(self.root)
        self.device = torch.device(device)
        self.bank = ModelBank(models_dir, self.device)
        self.needed = dict(NEEDED_DAYS, **(needed_days or {}))
        self._worlds = {}
        self._graphs = {}
        self._episode = {}

    # ---- plumbing
    def handle(self, req) -> dict:
        rid = req.get("id") if isinstance(req, dict) else None
        if not isinstance(req, dict):
            return {"id": None, "ok": False, "error": "a request is a JSON object"}
        cmd = req.get("cmd")
        try:
            if cmd == "ping":
                return {"id": rid, "ok": True, "result": {"models": self.bank.describe()}}
            if cmd == "predict":
                return {"id": rid, "ok": True, "result": self.predict(req)}
            if cmd == "reload":
                self.bank.loaded.clear()
                self._worlds.clear()
                self._graphs.clear()
                self._episode.clear()
                return {"id": rid, "ok": True, "result": {"models": self.bank.describe()}}
            return {"id": rid, "ok": False, "error": f"unknown cmd {cmd!r}"}
        except RequestError as e:
            return {"id": rid, "ok": False, "error": str(e)}
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            return {"id": rid, "ok": False, "error": f"{type(e).__name__}: {e}"}

    def world(self, world_dir):
        """The world snapshot (with its demographics when recorded), cached by path and mtimes."""
        if world_dir is None:
            return None
        demo = self.root / "demographics" / f"places-{Path(world_dir).name}.npy"
        key = (str(world_dir), (Path(world_dir) / "world.json").stat().st_mtime,
               demo.stat().st_mtime if demo.is_file() else None)
        if key not in self._worlds:
            self._worlds = {key: R.load_world(world_dir, data_root=self.root)}
        return self._worlds[key]

    def graph(self, world, kind: str):
        """The world's country graph ('country') or tracked-place graph ('place'), cached."""
        key = (str(world.path), kind)
        if key not in self._graphs:
            if kind == "country":
                g = M.dense_to_tensor(R.normalized_adjacency(R.country_graph(world)), device=self.device)
            else:
                r, c, w = R.place_edges(world)
                g = M.adjacency_tensor(r, c, w, world.K, device=self.device)
            self._graphs[key] = g
        return self._graphs[key]

    def predict(self, req) -> dict:
        domain = req.get("domain")
        if isinstance(domain, str) and (domain == "military" or domain.startswith("military-")):
            raise RequestError("military is not predicted")
        known = set(F.PREDICTION_DOMAINS) | set(F.BIN_CHANNELS) | {"markets"} | self.world_groups()
        if domain not in known:
            raise RequestError(f"domain must be one of {', '.join(F.PREDICTION_DOMAINS)}")
        horizon = parse_horizon(req.get("horizon"))
        try:
            bbox = geo.parse_bbox(req.get("bbox"))
        except (ValueError, TypeError) as e:
            raise RequestError(f"bad bbox: {e}") from None
        if domain == "outbreak":
            return self.predict_outbreak(horizon, bbox, req)
        if domain == "tracks":
            return self.predict_tracks(horizon, bbox, req)
        if domain == "markets":
            return self.predict_markets(horizon, bbox, req)
        return self.predict_world(domain, horizon, bbox, req)

    @staticmethod
    def _points(lat, lon, values, bbox, sd=None):
        lat, lon, values = np.asarray(lat), np.asarray(lon), np.asarray(values, dtype=np.float64)
        keep = geo.in_bbox(lat, lon, bbox) & np.isfinite(values)
        out = []
        for i in np.flatnonzero(keep):
            p = {"lat": round(float(lat[i]), 5), "lon": round(float(lon[i]), 5), "value": round(float(values[i]), 4)}
            if sd is not None and np.isfinite(sd[i]):
                p["sd"] = round(float(sd[i]), 4)
            out.append(p)
        return out

    # ---- outbreak
    def _latest_episode(self, dataset_dir, key=None):
        index = R.read_index(dataset_dir)
        entry = None
        if key:
            entry = next((e for e in index if e.get("key") == key), {"key": key})
        else:
            for e in reversed(index):
                if R.parse_key(str(e.get("key")))[2] in ("A", None):
                    entry = e
                    break
        shards = R.list_shards(dataset_dir)
        if not shards:
            return None
        if entry is None:  # no index: the last episode of the last shard
            ep = None
            for ep in R.iter_shard(shards[-1]):
                pass
            return ep if ep is not None and ep.complete else None
        k = str(entry.get("key"))
        cand = [p for p in shards if R.same_shard(entry.get("shard"), p)] or shards
        stamp = tuple((str(p), p.stat().st_mtime) for p in cand)
        cache = self._episode.get((str(dataset_dir), k))
        if cache and cache[0] == stamp:
            return cache[1]
        ep = next((e for e in R.iter_episodes(dataset_dir, shards=cand, keys={k}) if e.complete), None)
        self._episode = {(str(dataset_dir), k): (stamp, ep)}
        return ep

    def predict_outbreak(self, horizon, bbox, req):
        lm = self.bank.get("outbreak")
        wid = lm.state.get("worldId") if lm else None
        datasets = R.list_datasets(self.root, world_id=wid) if wid else []
        datasets = datasets or R.list_datasets(self.root)
        if req.get("dataset"):
            datasets = [d for d in datasets if d.name == req["dataset"]]
        days_recorded = int(R.dataset_field(R.load_dataset_meta(datasets[-1]), "days") or 0) if datasets else 0
        needed = (int(lm.state.get("context", 7)) + int(lm.state.get("horizon", 7))) if lm else self.needed["outbreak"]
        learning = {"daysRecorded": days_recorded, "needed": needed}
        if lm is None or not datasets:
            return prediction("outbreak", horizon, learning=learning)
        meta = R.load_dataset_meta(datasets[-1])
        world = self.world(R.find_world(self.root, meta.get("worldId")))
        if world is None:
            return prediction("outbreak", horizon, skill=lm.skill(), learning=learning)
        ep = self._latest_episode(datasets[-1], req.get("episode"))
        if ep is None or ep["country_state"].shape[1] != world.C:
            return prediction("outbreak", horizon, skill=lm.skill(), learning=learning)
        x = td.outbreak_features(ep)
        acts = td.outbreak_actions(ep, "country", world)
        c = max(1, min(int(lm.state.get("context", 7)), x.shape[0]))
        days = max(1, math.ceil(horizon / 24))
        # The context's own transitions, then the last day's decisions held for the horizon.
        a_ctx = acts[acts.shape[0] - (c - 1):] if c > 1 else acts[:0]
        last = acts[-1:] if acts.shape[0] else np.zeros((1,) + acts.shape[1:], np.float32)
        a = np.concatenate([a_ctx, np.repeat(last, days, axis=0)], axis=0)
        s = td.outbreak_static(world, "country", n_static=int(lm.config.get("n_static", 1)))
        adj = self.graph(world, "country")
        with torch.no_grad():
            pred = lm.model.rollout(torch.from_numpy(x[-c:])[None].to(self.device),
                                    torch.from_numpy(a)[None].to(self.device),
                                    torch.from_numpy(s)[None].to(self.device), adj, days)[0, -1].cpu().numpy()
        per_country = self._outbreak_value(pred, req.get("channel"))
        # Spread each country's value over its tracked places by their infections now
        # (by population where there are none); a country without one gets its biggest node.
        cn = world.country_of_node
        st = ep["place_state"][-1].astype(np.float64)
        active = st[:, [F.STATE_CHANNELS.index(c_) for c_ in F.ACTIVE_COMPARTMENTS]].sum(axis=1)
        pop = np.maximum(world.population[world.tracked], 1.0)
        weight = active + 1e-6 * pop
        lat, lon, val = [], [], []
        tc = world.tracked_country
        for ci in range(world.C):
            v = float(per_country[ci])
            if not (v >= 0.5):
                continue
            ks = np.flatnonzero(tc == ci)
            if ks.size:
                w = weight[ks] / weight[ks].sum()
                for k, wk in zip(ks, w):
                    node = world.tracked[k]
                    lat.append(world.lat[node]); lon.append(world.lon[node]); val.append(v * wk)
            else:
                nodes = np.flatnonzero(cn == ci)
                if nodes.size:
                    node = nodes[np.argmax(world.population[nodes])]
                    lat.append(world.lat[node]); lon.append(world.lon[node]); val.append(v)
        pts = [p for p in self._points(lat, lon, val, bbox) if p["value"] >= 0.5]
        return prediction("outbreak", horizon, skill=lm.skill(), points=pts)

    @staticmethod
    def _outbreak_value(pred, channel):
        """People per country from predicted log1p features: 'active' (default) or one feature."""
        if channel in (None, "", "active"):
            cols = [F.OUTBREAK_FEATURES.index(f"state.{c}") for c in F.ACTIVE_COMPARTMENTS]
            return np.expm1(pred[:, cols]).sum(axis=1)
        name = channel if channel in F.OUTBREAK_FEATURES else (
            f"state.{channel}" if f"state.{channel}" in F.OUTBREAK_FEATURES else f"cum.{channel}")
        if name not in F.OUTBREAK_FEATURES:
            raise RequestError(f"unknown outbreak channel {channel!r}")
        return np.expm1(pred[:, F.OUTBREAK_FEATURES.index(name)])

    # ---- world model domains
    def world_groups(self):
        lm = self.bank.get("world")
        groups = []
        for ch in (lm.state.get("channels") if lm else []) or []:
            group = str(ch).split(".", 1)[0]
            if group and group not in groups:
                groups.append(group)
        return set(groups)

    def _world_rollout(self, domain, groups, horizon):
        """Roll the world model forward for these bin groups.

        Returns (rollout, None) or (None, prediction) when there is nothing to
        roll yet (no model, no bins, too little context): that prediction is
        the honest LEARNING answer.
        """
        lm = self.bank.get("world")
        bins_dir = None
        if lm is not None and (self.paths["bins"] / str(lm.state.get("worldId"))).is_dir():
            bins_dir = self.paths["bins"] / str(lm.state.get("worldId"))
        if bins_dir is None:
            worlds = R.list_bin_worlds(self.root)
            bins_dir = worlds[-1] if worlds else None
        days = []
        if bins_dir is not None:
            for d in R.list_bin_days(bins_dir):
                y, m, dd = R.day_parts(d)
                if any((bins_dir / y / m / f"{dd}.{g}.npy").is_file() for g in groups):
                    days.append(d)
        learning = {"daysRecorded": len(days), "needed": self.needed["world"]}
        if lm is None or not days:
            return None, prediction(domain, horizon, skill=lm.skill(domain) if lm else None, learning=learning)
        channels = list(lm.state.get("channels", []))
        cols = [i for i, ch in enumerate(channels) if ch.split(".", 1)[0] in groups]
        if not cols:
            return None, prediction(domain, horizon, learning=learning)
        ctx = int(lm.state.get("context", 24))
        steps = int(min(MAX_WORLD_STEPS, max(1, math.ceil(horizon))))
        recent = [d for d in R.list_bin_days(bins_dir) if d >= days[-1] - _dt.timedelta(days=math.ceil(ctx / 24) + 1)]
        series = td.load_bin_series(bins_dir, days=recent, channels=channels)
        if series is None:
            return None, prediction(domain, horizon, skill=lm.skill(domain), learning=learning)
        vals = series["values"]
        obs = np.isfinite(vals).reshape(vals.shape[0], -1).any(axis=1)
        if not obs.any() or np.flatnonzero(obs)[-1] + 1 < ctx:
            return None, prediction(domain, horizon, skill=lm.skill(domain), learning=learning)
        end = int(np.flatnonzero(obs)[-1]) + 1
        K = vals.shape[1]
        wdir = R.find_world(self.root, bins_dir.name)
        world = self.world(wdir)
        if world is None or world.K != K:
            return None, prediction(domain, horizon, skill=lm.skill(domain), learning=learning)
        window = vals[end - ctx: end]
        mask = np.isfinite(window)
        v = np.where(mask, td.symlog(np.nan_to_num(window)), 0).astype(np.float32)
        tf = td.hour_features(series["start_ms"] + (end - ctx) * 3600000, ctx + steps, td.place_utc_offsets(world, K))
        s = td.place_static(world, K, int(lm.config.get("n_static", td.N_PLACE_STATIC)))
        adj = self.graph(world, "place")
        dev = self.device
        with torch.no_grad():
            pred, seen = lm.model.rollout(torch.from_numpy(v)[None].to(dev), torch.from_numpy(mask.astype(np.float32))[None].to(dev),
                                          torch.from_numpy(tf)[None].to(dev), torch.from_numpy(s)[None].to(dev), adj, steps)
        return {"lm": lm, "bins_dir": bins_dir, "channels": channels, "cols": cols, "world": world,
                "window": window, "pred": pred[0, -1].cpu().numpy(), "seen": seen[0].cpu().numpy()}, None

    def predict_world(self, domain, horizon, bbox, req):
        # Each bin group is its own prediction. mobility no longer swallows
        # trains and traffic; those are their own rows.
        if domain in F.BIN_CHANNELS or domain in self.world_groups():
            groups = (domain,)
        else:
            groups = F.DOMAIN_GROUPS[domain]
        roll, early = self._world_rollout(domain, groups, horizon)
        if early is not None:
            return early
        lm, world = roll["lm"], roll["world"]
        ch = self._world_channel(roll["channels"], roll["cols"], req.get("channel"))
        values = np.where(roll["seen"][:, ch], td.symexp(roll["pred"][:, ch]), np.nan)
        idx = world.tracked
        return prediction(domain, horizon, skill=lm.skill(domain),
                          points=self._points(world.lat[idx], world.lon[idx], values, bbox))

    def predict_markets(self, horizon, bbox, req):
        """Each asset's predicted price move, drawn where its benchmark is set.

        A price is the same number at every place in the bins, so the model's
        per-place predictions are averaged into one per asset. `value` is the
        signed percent move from the last recorded price; `assets` lists
        every predicted asset, those with no home (crypto) included. An asset
        with no last price or no prediction is left out, never invented.
        """
        roll, early = self._world_rollout("markets", ("markets",), horizon)
        if early is not None:
            return early
        lm, channels = roll["lm"], roll["channels"]
        meta = _read_json(roll["bins_dir"] / "assets.json") or {}
        assets = []
        for c in roll["cols"]:
            series = channels[c].split(".", 1)[-1]
            col = roll["window"][:, :, c]
            last_rows = [row for row in col if np.isfinite(row).any()]
            seen = roll["seen"][:, c]
            if not last_rows or not seen.any():
                continue
            last = float(np.nanmean(last_rows[-1]))
            predicted = float(np.mean(td.symexp(roll["pred"][seen, c])))
            if not (np.isfinite(last) and np.isfinite(predicted)) or last == 0:
                continue
            info = meta.get(series) or {}
            hub = info.get("hub") or None
            row = {"series": series, "label": info.get("label") or series, "group": info.get("group"),
                   "unit": info.get("unit"), "last": round(last, 6), "predicted": round(predicted, 6),
                   "value": round((predicted - last) / abs(last) * 100.0, 4)}
            if hub and np.isfinite(hub.get("lat", np.nan)) and np.isfinite(hub.get("lon", np.nan)):
                row.update(hub=hub.get("name"), lat=round(float(hub["lat"]), 5), lon=round(float(hub["lon"]), 5))
            assets.append(row)
        points = [a for a in assets if "lat" in a
                  and geo.in_bbox(np.array([a["lat"]]), np.array([a["lon"]]), bbox)[0]]
        out = prediction("markets", horizon, skill=lm.skill("markets"), points=points)
        out["assets"] = assets
        return out

    @staticmethod
    def _world_channel(channels, cols, wanted):
        if not wanted:
            return cols[0]
        for i in cols:
            if channels[i] == wanted or channels[i].split(".", 1)[-1] == wanted:
                return i
        raise RequestError(f"channel {wanted!r} is not one of {[channels[i] for i in cols]}")

    # ---- tracks
    def predict_tracks(self, horizon, bbox, req):
        lm = self.bank.get("tracks")
        tape = self.paths["tape"]
        feeds = [f for f in R.list_tape_feeds(tape) if F.track_trainable(f)]
        all_days = sorted({d for f in feeds for d in R.list_tape_days(tape, f)})
        learning = {"daysRecorded": len(all_days), "needed": self.needed["tracks"]}
        if lm is None or not feeds:
            return prediction("tracks", horizon, skill=lm.skill() if lm else None, learning=learning)
        horizons_all = list(lm.state.get("horizons") or F.TRACK_HORIZONS_MIN)
        use = [j for j, h in enumerate(horizons_all) if h <= horizon * 60]
        n_fixes = int(lm.state.get("nFixes") or 8)
        feats, kinds, bases, anchors, ids = [], [], [], [], []
        for feed in feeds:
            day = R.list_tape_days(tape, feed)[-1]
            hours = R.tape_hours(tape, feed, day)
            if not hours:
                continue
            recs = list(R.iter_tape(tape, feed, day, hours=hours[-2:]))
            tracks = td.group_fixes(feed, recs)
            if not tracks:
                continue
            newest = max(fx[-1, 0] for fx in tracks.values())
            for tid, fx in sorted(tracks.items()):
                if fx.shape[0] < 2 or fx[-1, 0] < newest - FRESH_TRACK_MS:
                    continue
                f_, b_, anc = td.track_inputs(fx, fx.shape[0] - 1, n_fixes, horizons_all)
                feats.append(f_); bases.append(b_); anchors.append(anc)
                kinds.append(td.TRACK_KINDS.index(F.track_kind(feed))); ids.append((feed, tid))
        if not feats:
            return prediction("tracks", horizon, skill=lm.skill(), learning=learning)
        out = []
        with torch.no_grad():
            for i in range(0, len(feats), 1024):
                pred = lm.model(torch.from_numpy(np.stack(feats[i: i + 1024])).to(self.device),
                                torch.tensor(kinds[i: i + 1024], dtype=torch.long, device=self.device),
                                torch.from_numpy(np.stack(bases[i: i + 1024])).to(self.device)).cpu().numpy()
                out.append(pred)
        pred = np.concatenate(out, axis=0)
        tracks = []
        for (feed, tid), anc, off in zip(ids, anchors, pred):
            lat0, lon0, t0 = anc
            path = [[round(lat0, 5), round(lon0, 5), int(t0)]]
            if use:
                la, lo = geo.aeqd_inverse(lat0, lon0, off[use, 0], off[use, 1])
                path += [[round(float(a), 5), round(float(b), 5), int(t0 + horizons_all[j] * 60000)]
                         for a, b, j in zip(np.atleast_1d(la), np.atleast_1d(lo), use)]
            lats = np.array([p[0] for p in path])
            lons = np.array([p[1] for p in path])
            if geo.in_bbox(lats, lons, bbox).any():
                tracks.append({"id": f"{feed}:{tid}", "kind": F.track_kind(feed), "path": path})
        tracks.sort(key=lambda t: -t["path"][0][2])
        return prediction("tracks", horizon, skill=lm.skill(), tracks=tracks[:MAX_TRACKS])


def _write(stream, obj):
    stream.write(json.dumps(_clean(obj), separators=(",", ":")).encode("ascii") + b"\n")
    stream.flush()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m ml.gevtape.serve", description="JSON-lines prediction server.")
    ap.add_argument("--data", required=True, help="the .gev-data directory")
    ap.add_argument("--models", required=True, help="the models directory (ai-world/models)")
    ap.add_argument("--device", default="cpu", choices=("cpu", "auto", "cuda"),
                    help="cpu by default, so serving never competes with training for the GPU")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--needed-days", type=int, default=None, help="days of bins before the world domains predict")
    a = ap.parse_args(argv)
    if a.threads:
        torch.set_num_threads(a.threads)
    device = "cuda" if a.device in ("auto", "cuda") and torch.cuda.is_available() else "cpu"
    server = Server(a.data, a.models, device=device,
                    needed_days={"world": a.needed_days} if a.needed_days else None)
    out = sys.stdout.buffer
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            _write(out, {"id": None, "ok": False, "error": "bad JSON"})
            continue
        if isinstance(req, dict) and req.get("cmd") in ("close", "exit", "quit"):
            _write(out, {"id": req.get("id"), "ok": True, "result": {}})
            break
        _write(out, server.handle(req))
    return 0


if __name__ == "__main__":
    sys.exit(main())
