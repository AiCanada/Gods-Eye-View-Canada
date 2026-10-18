"""PyTorch datasets of training windows over the .gev-data formats.

- EpisodeWindows  outbreak episodes -> (context days, actions, target days)
                  at country level by default (or tracked places)
- BinWindows      hourly bins on the tracked places, NaN-masked
- TrackWindows    tape fixes -> track examples for the TrackPredictor

All three are IterableDatasets. Their order depends only on (seed, epoch)
and the worker split: EpisodeWindows shuffles shards (then windows through a
seeded buffer) and gives each DataLoader worker its own shards
(torch.utils.data.get_worker_info); with fewer shards than workers the
episodes are dealt out instead. Call set_epoch(e) before each epoch.

The feature functions (outbreak_features, outbreak_actions, ...) are shared
with ml.gevtape.serve so training and serving see the same numbers.
Normalisation: log1p for counts (outbreak), sign(x)*log1p(|x|) for the
heterogeneous bin channels (weather can be negative).
"""

from __future__ import annotations

import datetime as _dt
import math
import random
import warnings
import zlib
from pathlib import Path

import numpy as np

try:
    from torch.utils.data import IterableDataset, get_worker_info
except ImportError:  # the TensorFlow Python (ml.gevtape.tf_train) has no torch: plain iterables
    class IterableDataset:  # noqa: D101
        pass

    def get_worker_info():
        return None

from . import formats as F
from . import geo
from .reader import (World, as_date, day_start_ms, iter_episodes, iter_tape, list_bin_days,
                     list_shards, load_bins, parse_key, read_index, same_shard)

N_OUTBREAK_FEATURES = len(F.STATE_CHANNELS) + len(F.CUM_CHANNELS)          # 22
N_OUTBREAK_ACTIONS = len(F.GLOBAL_ACTIONS) + len(F.COUNTRY_ACTIONS) + len(F.PLACE_ACTIONS)  # 14
N_TIME_FEATURES = 6     # UTC hour, local hour, weekday (sin, cos each)
N_PLACE_STATIC = 4      # log population, unit-sphere position (3)
TRACK_KINDS = tuple(F.TRACK_FEEDS)  # flights, vessels, transit (no military)
N_TRACK_FEATURES = 7


def worker_slot():
    """(worker id, number of workers) inside a DataLoader worker, else (0, 1)."""
    info = get_worker_info()
    return (info.id, info.num_workers) if info is not None else (0, 1)


def _shuffle_seed(seed: int, epoch: int) -> int:
    return (int(seed) * 1_000_003 + int(epoch) * 7919) & 0x7FFFFFFF


# --------------------------------------------------------------------------
# Outbreak features
# --------------------------------------------------------------------------


def outbreak_features(ep, level: str = "country") -> np.ndarray:
    """log1p of [state, cum] per row: float32 [T + 1, X, 22] (X = C or K)."""
    st = ep[f"{level}_state"]
    cu = ep[f"{level}_cum"]
    x = np.concatenate([st, cu], axis=-1).astype(np.float64)
    return np.log1p(x).astype(np.float32)


def place_country_weights(world: World | None, K: int, C: int):
    """[K, C] matrix averaging tracked places into their countries (population weights)."""
    M = np.zeros((K, C), dtype=np.float64)
    if world is None or world.K != K:
        return None
    pop = np.maximum(world.population[world.tracked], 1.0)
    M[np.arange(K), world.tracked_country] = pop
    tot = M.sum(axis=0, keepdims=True)
    return np.divide(M, tot, out=np.zeros_like(M), where=tot > 0)


def outbreak_actions(ep, level: str = "country", world: World | None = None, weights=None) -> np.ndarray:
    """Actions per day and unit: float32 [T, X, 14] = global (9) + country (2) + place (3).

    Country level: place actions are population-weighted means over the
    country's tracked places (zero for a country with none, or without a
    world). Place level: each place gets its country's actions. `weights`
    (place_country_weights, precomputed) saves rebuilding it per episode.
    """
    ag = np.asarray(ep["actions_global"], dtype=np.float32)
    ac = np.asarray(ep["actions_country"], dtype=np.float32)
    ap = np.asarray(ep["actions_place"], dtype=np.float32)
    T, C, K = ag.shape[0], ac.shape[1], ap.shape[1]
    if level == "country":
        M = weights if weights is not None else place_country_weights(world, K, C)
        if M is not None:  # [T, P, K] @ [K, C] on BLAS, then [T, C, P]
            agg = np.matmul(ap.transpose(0, 2, 1), M.astype(np.float32)).transpose(0, 2, 1)
        else:
            agg = np.zeros((T, C, ap.shape[2]), np.float32)
        return np.concatenate([np.broadcast_to(ag[:, None, :], (T, C, ag.shape[1])), ac, agg], axis=-1)
    if level == "place":
        if world is not None and world.K == K:
            acp = ac[:, world.tracked_country, :]
        else:
            acp = np.zeros((T, K, ac.shape[2]), np.float32)
        return np.concatenate([np.broadcast_to(ag[:, None, :], (T, K, ag.shape[1])), acp, ap], axis=-1)
    raise ValueError("level must be 'country' or 'place'")


def _sphere(lat, lon) -> np.ndarray:
    la, lo = np.radians(lat), np.radians(lon)
    return np.stack([np.sin(la), np.cos(la) * np.sin(lo), np.cos(la) * np.cos(lo)], axis=-1)


def demographic_shares(world: World | None):
    """[n, 4] demographic shares (0-1, NaN unknown) from world.demographics, or None.

    demographics/places-<worldId>.npy is [n, 5]: log10 population, then the
    four shares; the population column is dropped (the static features carry
    their own).
    """
    dm = world.demographics if world is not None else None
    if dm is None or dm.ndim != 2 or dm.shape[0] != world.n or dm.shape[1] < 2:
        return None
    return np.asarray(dm[:, 1:], dtype=np.float64)


def fit_width(s: np.ndarray, n_static: int | None) -> np.ndarray:
    """Zero-pad or truncate static features to a model's trained width."""
    s = np.nan_to_num(np.asarray(s, dtype=np.float32))
    if n_static is None or s.shape[1] == n_static:
        return s
    out = np.zeros((s.shape[0], n_static), np.float32)
    w = min(n_static, s.shape[1])
    out[:, :w] = s[:, :w]
    return out


def outbreak_static(world: World | None, level: str = "country", ep=None, n_static: int | None = None) -> np.ndarray:
    """Static features per unit, float32 [X, S].

    Country: log1p(population) / 20, then (when the world was loaded with its
    demographics) the population-weighted mean of each demographic share over
    the country's places. Without a world the population is the row-0 sum of
    the population compartments. Place: log1p(population) / 20, the
    unit-sphere position, then the place's shares. `n_static` pads with
    zeros / truncates to a model's trained width.
    """
    shares = demographic_shares(world)
    if level == "country":
        if world is not None:
            pop = world.country_population()
        elif ep is not None:
            cols = [F.STATE_CHANNELS.index(c) for c in F.POPULATION_COMPARTMENTS]
            pop = ep["country_state"][0][:, cols].astype(np.float64).sum(axis=1)
        else:
            raise ValueError("need a world or an episode")
        parts = [np.log1p(pop)[:, None] / 20.0]
        if shares is not None:
            cn = world.country_of_node
            w = np.maximum(world.population, 0)[:, None] * np.isfinite(shares)
            num = np.zeros((world.C, shares.shape[1]))
            den = np.zeros_like(num)
            np.add.at(num, cn, np.nan_to_num(shares) * w)
            np.add.at(den, cn, w)
            parts.append(np.divide(num, den, out=np.zeros_like(num), where=den > 0))
        s = np.concatenate(parts, axis=1)
    elif level == "place":
        if world is not None:
            s = place_static(world, world.K)
        elif ep is not None:
            cols = [F.STATE_CHANNELS.index(c) for c in F.POPULATION_COMPARTMENTS]
            pop = ep["place_state"][0][:, cols].astype(np.float64).sum(axis=1)
            s = np.concatenate([np.log1p(pop)[:, None] / 20.0, np.zeros((pop.shape[0], 3))], axis=1)
        else:
            raise ValueError("need a world or an episode")
    else:
        raise ValueError("level must be 'country' or 'place'")
    return fit_width(s, n_static)


class EpisodeWindows(IterableDataset):
    """Windows of outbreak episodes for the OutbreakSurrogate.

    Each item is a dict of numpy arrays (default_collate stacks them):
      x      float32 [L, X, 22]  log1p features of rows start .. start+L-1
      a      float32 [L-1, X, 14] actions of those L-1 day transitions
      s      float32 [X, S]       static features
      start  int                  first row
      key    str                  the episode key
    with L = context + horizon rows: the first `context` rows are history,
    the last `horizon` rows targets.
    """

    def __init__(self, dataset_dir, *, world: World | None = None, context: int = 7, horizon: int = 7,
                 level: str = "country", stride: int = 1, scenarios=None, keys=None, shuffle: bool = True,
                 shuffle_buffer: int = 256, seed: int = 0, epoch: int = 0, n_static: int | None = None):
        super().__init__()
        self.dataset_dir = Path(dataset_dir)
        self.world = world
        self.context, self.horizon = int(context), int(horizon)
        self.length = self.context + self.horizon
        self.level = level
        self.stride = max(1, int(stride))
        self.scenarios = set(scenarios) if scenarios is not None else None
        self.keys = set(keys) if keys is not None else None
        self.shuffle = shuffle
        self.shuffle_buffer = int(shuffle_buffer)
        self.seed, self.epoch = int(seed), int(epoch)
        self.n_static = n_static
        self.static = outbreak_static(world, level, n_static=n_static) if world is not None else None
        self.weights = (place_country_weights(world, world.K, world.C)
                        if world is not None and level == "country" else None)
        self.shards = self._select_shards()

    def set_epoch(self, epoch: int):
        self.epoch = int(epoch)

    def wanted(self, key: str) -> bool:
        if self.keys is not None and key not in self.keys:
            return False
        if self.scenarios is not None and parse_key(key)[0] not in self.scenarios:
            return False
        return True

    def _select_shards(self):
        shards = list_shards(self.dataset_dir)
        if self.scenarios is None and self.keys is None:
            return shards
        wanted = {e.get("shard") for e in read_index(self.dataset_dir)
                  if isinstance(e, dict) and self.wanted(str(e.get("key", "")))}
        chosen = [p for p in shards if any(same_shard(w, p) for w in wanted)]
        return chosen or shards  # an index we cannot map: read everything

    def episode_windows(self, ep):
        """Every window of one episode, in order."""
        x = outbreak_features(ep, self.level)
        w = self.weights if self.weights is not None and self.weights.shape[1] == ep["actions_country"].shape[1] else None
        a = outbreak_actions(ep, self.level, self.world, weights=w)
        s = self.static if self.static is not None else outbreak_static(None, self.level, ep, self.n_static)
        L = self.length
        for st in range(0, x.shape[0] - L + 1, self.stride):
            yield {"x": x[st: st + L], "a": a[st: st + L - 1], "s": s, "start": st, "key": ep.key}

    def __iter__(self):
        wid, nw = worker_slot()
        shards = list(self.shards)
        if self.shuffle:
            random.Random(_shuffle_seed(self.seed, self.epoch)).shuffle(shards)
        by_shard = len(shards) >= nw
        mine = shards[wid::nw] if by_shard else shards
        rng = np.random.default_rng([self.seed, self.epoch, wid])
        buf, count = [], 0
        for ep in iter_episodes(self.dataset_dir, shards=mine):
            if not self.wanted(ep.key):
                continue
            if not ep.complete:
                warnings.warn(f"episode {ep.key} is incomplete; skipped")
                continue
            count += 1
            if not by_shard and (count - 1) % nw != wid:
                continue
            for w in self.episode_windows(ep):
                if not self.shuffle or self.shuffle_buffer <= 1:
                    yield w
                    continue
                buf.append(w)
                if len(buf) >= self.shuffle_buffer:
                    j = int(rng.integers(len(buf)))
                    buf[j], buf[-1] = buf[-1], buf[j]
                    yield buf.pop()
        for j in (rng.permutation(len(buf)) if buf else ()):
            yield buf[j]


# --------------------------------------------------------------------------
# Bins
# --------------------------------------------------------------------------


def symlog(x):
    return np.sign(x) * np.log1p(np.abs(x))


def symexp(y):
    return np.sign(y) * np.expm1(np.abs(y))


def load_bin_series(bins_dir, days=None, channels=None):
    """Days of bins as one hourly series (missing days and hours are NaN).

    Returns None when there are no bins, else a dict:
      values    float32 [H, K, Ch]  (H = 24 x days from the first to the last)
      channels  ['group.channel', ...] (the given order, else first seen)
      start     the first day (date); start_ms its UTC midnight
      days      the days that had files
      classes   licence classes channels.json declared ([] if none)
    """
    all_days = list_bin_days(bins_dir) if days is None else sorted({as_date(d) for d in days})
    loaded, classes, names_seen = {}, set(), []
    for d in all_days:
        b = load_bins(bins_dir, d)
        if not b.groups:
            continue
        arr, names = b.stacked()
        loaded[d] = (arr, names)
        classes.update(b.classes)
        for nm in names:
            if nm not in names_seen:
                names_seen.append(nm)
    if not loaded:
        return None
    cols = list(channels) if channels is not None else names_seen
    first, last = min(loaded), max(loaded)
    K = next(iter(loaded.values()))[0].shape[1]
    H = ((last - first).days + 1) * 24
    values = np.full((H, K, len(cols)), np.nan, dtype=np.float32)
    at = {nm: i for i, nm in enumerate(cols)}
    for d, (arr, names) in loaded.items():
        if arr.shape[1] != K:
            raise ValueError(f"bins of {d} have K = {arr.shape[1]}, expected {K}")
        o = (d - first).days * 24
        for j, nm in enumerate(names):
            if nm in at:
                values[o: o + 24, :, at[nm]] = arr[:, :, j]
    return {"values": values, "channels": cols, "start": first, "start_ms": day_start_ms(first),
            "days": sorted(loaded), "classes": sorted(classes)}


def hour_features(start_ms: int, H: int, utc_offsets) -> np.ndarray:
    """float32 [H, K, 6]: sin/cos of the UTC hour, the local hour and the weekday."""
    utc_offsets = np.asarray(utc_offsets, dtype=np.float64)
    hours = np.arange(H, dtype=np.float64) + (start_ms / 3600000.0)
    utc_h = hours % 24
    local = (utc_h[:, None] + utc_offsets[None, :]) % 24
    weekday = ((hours // 24) + 3) % 7  # 1970-01-01 was a Thursday (3 with Monday = 0)
    K = utc_offsets.shape[0]
    out = np.empty((H, K, N_TIME_FEATURES), dtype=np.float32)
    out[..., 0] = np.sin(2 * np.pi * utc_h / 24)[:, None]
    out[..., 1] = np.cos(2 * np.pi * utc_h / 24)[:, None]
    out[..., 2] = np.sin(2 * np.pi * local / 24)
    out[..., 3] = np.cos(2 * np.pi * local / 24)
    out[..., 4] = np.sin(2 * np.pi * weekday / 7)[:, None]
    out[..., 5] = np.cos(2 * np.pi * weekday / 7)[:, None]
    return out


def place_static(world: World | None, K: int, n_static: int | None = None) -> np.ndarray:
    """float32 [K, 4 (+4)] static features of the tracked places: log1p(population) / 20,
    the unit-sphere position, then the demographic shares when the world has them
    (zeros without a matching world). `n_static` fits a model's trained width."""
    if world is None or world.K != K:
        return fit_width(np.zeros((K, N_PLACE_STATIC), np.float32), n_static)
    idx = world.tracked
    parts = [np.log1p(np.maximum(world.population[idx], 0))[:, None] / 20.0, _sphere(world.lat[idx], world.lon[idx])]
    shares = demographic_shares(world)
    if shares is not None:
        parts.append(shares[idx])
    return fit_width(np.concatenate(parts, axis=1), n_static)


def place_utc_offsets(world: World | None, K: int) -> np.ndarray:
    if world is None or world.K != K:
        return np.zeros(K)
    return np.nan_to_num(world.utc_offset[world.tracked])


class BinWindows(IterableDataset):
    """Hourly windows of binned tape for the WorldModel.

    Each item:
      v      float32 [L, K, Ch]  symlog values, 0 where not observed
      m      float32 [L, K, Ch]  1 observed, 0 not (NaN in the bins)
      tf     float32 [L, K, 6]   time features
      s      float32 [K, S]      static features (place_static)
      start  int                 first hour (index into the series)
      idx    int64 [K]           which tracked places (all, or a crop of
                                 max_places nearest a random place)
    L = context + horizon. A window is kept when its context has at least one
    observation and its targets at least `min_targets`; `target_hours`
    (h0, h1) keeps only windows whose targets all fall in [h0, h1) (the
    held-out days, or the training days).
    """

    def __init__(self, series: dict, *, world: World | None = None, context: int = 24, horizon: int = 24,
                 stride: int = 1, target_hours=None, shuffle: bool = True, seed: int = 0, epoch: int = 0,
                 min_targets: int = 1, n_static: int | None = None, max_places: int | None = None):
        super().__init__()
        raw = series["values"]
        self.H, self.K, self.Ch = raw.shape
        self.channels = list(series["channels"])
        self.mask = np.isfinite(raw)
        self.v = np.where(self.mask, symlog(np.nan_to_num(raw)), 0.0).astype(np.float32)
        self.tf = hour_features(series["start_ms"], self.H, place_utc_offsets(world, self.K))
        self.static = place_static(world, self.K, n_static)
        # Crops: with max_places < K each window covers the max_places tracked
        # places nearest a random one (neighbours stay together for the graph).
        self.max_places = int(max_places) if max_places and max_places < self.K else None
        if world is not None and world.K == self.K:
            self.xyz = _sphere(world.lat[world.tracked], world.lon[world.tracked])
        else:
            self.xyz = None
        self.context, self.horizon = int(context), int(horizon)
        L = self.context + self.horizon
        h0, h1 = target_hours if target_hours is not None else (0, self.H)
        obs_hour = self.mask.reshape(self.H, -1).sum(axis=1)
        csum = np.concatenate([[0], np.cumsum(obs_hour)])
        starts = []
        for s in range(0, self.H - L + 1, max(1, int(stride))):
            t0, t1 = s + self.context, s + L
            if t0 < h0 or t1 > h1:
                continue
            if csum[t0] - csum[s] < 1 or csum[t1] - csum[t0] < min_targets:
                continue
            starts.append(s)
        self.starts = np.array(starts, dtype=np.int64)
        self.shuffle, self.seed, self.epoch = shuffle, int(seed), int(epoch)

    def __len__(self):
        return len(self.starts)

    def set_epoch(self, epoch: int):
        self.epoch = int(epoch)

    def places(self, s: int) -> np.ndarray:
        """The tracked places of window s: all, or a crop seeded by (seed, epoch, s)."""
        if self.max_places is None:
            return np.arange(self.K)
        rng = np.random.default_rng([self.seed, self.epoch, int(s)])
        if self.xyz is None:
            return np.sort(rng.choice(self.K, size=self.max_places, replace=False))
        d = ((self.xyz - self.xyz[int(rng.integers(self.K))]) ** 2).sum(axis=1)
        return np.sort(np.argpartition(d, self.max_places - 1)[: self.max_places])

    def window(self, s: int, crop: bool = True) -> dict:
        L = self.context + self.horizon
        idx = self.places(s) if crop else np.arange(self.K)
        if idx.shape[0] == self.K:
            v, m, tf, st = self.v[s: s + L], self.mask[s: s + L], self.tf[s: s + L], self.static
        else:
            v, m, tf, st = (self.v[s: s + L][:, idx], self.mask[s: s + L][:, idx], self.tf[s: s + L][:, idx],
                            self.static[idx])
        return {"v": v, "m": m.astype(np.float32), "tf": tf, "s": st, "start": int(s), "idx": idx}

    def __iter__(self):
        wid, nw = worker_slot()
        order = self.starts
        if self.shuffle:
            order = order[np.random.default_rng([self.seed, self.epoch]).permutation(len(order))]
        for s in order[wid::nw]:
            yield self.window(int(s))


# --------------------------------------------------------------------------
# Tracks
# --------------------------------------------------------------------------


def track_id(feed: str, rec: dict):
    """A track's id from its feed's id field(s) ('region:id' for transit), or None."""
    vals = [rec.get(f) for f in F.TRACK_FEEDS[F.track_kind(feed)]["id"]]
    if any(v is None or v == "" for v in vals):
        return None
    return ":".join(str(v) for v in vals)


def _num(v) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        return math.nan
    return x if math.isfinite(x) else math.nan


def group_fixes(feed: str, records) -> dict:
    """{track id: float64 [m, 5] (t, lat, lon, speed, heading)} sorted by time, one fix per ms."""
    spec = F.TRACK_FEEDS[F.track_kind(feed)]
    spd_f, hdg_f = spec["speed"], spec["heading"]
    rows: dict = {}
    for rec in records:
        tid = track_id(feed, rec)
        if tid is None:
            continue
        t, lat, lon = _num(rec.get("t")), _num(rec.get("lat")), _num(rec.get("lon"))
        if math.isnan(t) or math.isnan(lat) or math.isnan(lon) or abs(lat) > 90 or abs(lon) > 180:
            continue
        rows.setdefault(tid, []).append((t, lat, lon, _num(rec.get(spd_f)), _num(rec.get(hdg_f))))
    out = {}
    for tid, r in rows.items():
        a = np.array(r, dtype=np.float64)
        a = a[np.argsort(a[:, 0], kind="stable")]
        keep = np.concatenate([[True], np.diff(a[:, 0]) > 0])
        out[tid] = a[keep]
    return out


def track_inputs(fixes: np.ndarray, i: int, n_fixes: int, horizons_min):
    """Model inputs for anchor fix i: (feats [N, 7], base [H, 2], anchor (lat, lon, t)).

    feats per history step (front-padded with zeros): asinh(east km),
    asinh(north km) of the fix relative to the anchor (azimuthal equidistant
    frame), asinh(minutes before the anchor), log1p|reported speed| / 5,
    sin/cos of the reported heading (0 when absent), valid flag.
    base: the constant-velocity positions at the horizons in that frame (km).
    """
    lo = max(0, i - n_fixes + 1)
    hist = fixes[lo: i + 1]
    t_a, lat_a, lon_a = fixes[i, 0], fixes[i, 1], fixes[i, 2]
    e, n_ = geo.aeqd_forward(lat_a, lon_a, hist[:, 1], hist[:, 2])
    feats = np.zeros((n_fixes, N_TRACK_FEATURES), dtype=np.float32)
    m = hist.shape[0]
    spd = hist[:, 3]
    hdg = np.radians(hist[:, 4])
    has_h = np.isfinite(hdg)
    block = np.stack([np.arcsinh(e), np.arcsinh(n_), np.arcsinh((hist[:, 0] - t_a) / 60000.0),
                      np.where(np.isfinite(spd), np.log1p(np.abs(np.nan_to_num(spd))) / 5.0, 0.0),
                      np.where(has_h, np.sin(np.nan_to_num(hdg)), 0.0),
                      np.where(has_h, np.cos(np.nan_to_num(hdg)), 0.0),
                      np.ones(m)], axis=1)
    feats[n_fixes - m:] = block
    horizons_ms = np.asarray(horizons_min, dtype=np.float64) * 60000.0
    if i >= 1:
        blat, blon = geo.constant_velocity(fixes[i - 1, 1], fixes[i - 1, 2], fixes[i - 1, 0],
                                           lat_a, lon_a, t_a, horizons_ms)
    else:
        blat = np.full(len(horizons_ms), lat_a)
        blon = np.full(len(horizons_ms), lon_a)
    be, bn = geo.aeqd_forward(lat_a, lon_a, blat, blon)
    base = np.stack([be, bn], axis=-1).astype(np.float32)
    return feats, base, (float(lat_a), float(lon_a), float(t_a))


def _interp(fixes: np.ndarray, t: float, max_gap_ms: float):
    """(lat, lon) on a track at time t (linear between the bracketing fixes), or None."""
    ts = fixes[:, 0]
    if t < ts[0] or t > ts[-1]:
        return None
    j = int(np.searchsorted(ts, t, side="right")) - 1
    if j >= len(ts) - 1:
        return (fixes[-1, 1], fixes[-1, 2]) if t == ts[-1] else None
    if ts[j + 1] - ts[j] > max_gap_ms:
        return None
    w = (t - ts[j]) / (ts[j + 1] - ts[j])
    lon0, lon1 = fixes[j, 2], fixes[j + 1, 2]
    dlon = (lon1 - lon0 + 180.0) % 360.0 - 180.0
    return (fixes[j, 1] + w * (fixes[j + 1, 1] - fixes[j, 1]), float(geo.wrap_lon(lon0 + w * dlon)))


def track_examples(fixes: np.ndarray, kind: int, *, n_fixes: int = 8, horizons_min=F.TRACK_HORIZONS_MIN,
                   max_gap_ms: float = 10 * 60000.0, anchor_window=None, anchor_stride: int = 1,
                   min_history: int = 2):
    """Training examples along one track (anchors with >= min_history fixes and >= 1 target)."""
    H = len(horizons_min)
    for i in range(min_history - 1, fixes.shape[0], max(1, anchor_stride)):
        t_a = fixes[i, 0]
        if anchor_window is not None and not (anchor_window[0] <= t_a < anchor_window[1]):
            continue
        truth = np.full((H, 2), np.nan)
        for h, tau in enumerate(horizons_min):
            p = _interp(fixes, t_a + tau * 60000.0, max_gap_ms)
            if p is not None:
                truth[h] = p
        tmask = np.isfinite(truth[:, 0])
        if not tmask.any():
            continue
        feats, base, anchor = track_inputs(fixes, i, n_fixes, horizons_min)
        te, tn = geo.aeqd_forward(anchor[0], anchor[1], np.nan_to_num(truth[:, 0]), np.nan_to_num(truth[:, 1]))
        target = np.where(tmask[:, None], np.stack([te, tn], axis=-1), 0.0).astype(np.float32)
        yield {"feats": feats, "kind": int(kind), "base": base, "target": target,
               "tmask": tmask.astype(np.float32), "anchor": np.array(anchor, dtype=np.float64),
               "truth": np.nan_to_num(truth)}


def keep_track(tid: str, sample: float, salt: int = 0) -> bool:
    """Deterministic subsample of track ids (crc32), keeping about `sample` of them."""
    if sample >= 1.0:
        return True
    return (zlib.crc32(f"{salt}:{tid}".encode()) % 100000) < sample * 100000


class TrackWindows(IterableDataset):
    """Track examples from the tape, one (feed, day) item at a time.

    `feeds` are tape feed names (an alias such as ais-live-vessels counts
    as its kind). Each day is read with the previous day's last hour (history) and the
    next day's first two hours (targets); anchors are the day's own fixes.
    Items are shuffled by (seed, epoch) and dealt to workers; examples pass
    through a seeded shuffle buffer. `id_filter(tid) -> bool` and `sample`
    restrict the tracks (a held-out split, or a cap on busy feeds).
    Each item: feats [N, 7], kind, base [H, 2], target [H, 2], tmask [H],
    anchor [3] (lat, lon, t), truth [H, 2] (lat, lon of the targets).
    """

    def __init__(self, tape_dir, *, days, feeds=None, n_fixes: int = 8, horizons_min=F.TRACK_HORIZONS_MIN,
                 shuffle: bool = True, shuffle_buffer: int = 512, seed: int = 0, epoch: int = 0,
                 anchor_stride: int = 1, id_filter=None, sample: float = 1.0, max_gap_ms: float = 10 * 60000.0):
        super().__init__()
        self.tape_dir = Path(tape_dir)
        self.feeds = [f for f in (feeds or TRACK_KINDS) if F.track_trainable(f)]
        self.days = sorted({as_date(d) for d in days})
        self.items = [(f, d) for f in self.feeds for d in self.days]
        self.n_fixes, self.horizons_min = int(n_fixes), tuple(horizons_min)
        self.shuffle, self.shuffle_buffer = shuffle, int(shuffle_buffer)
        self.seed, self.epoch = int(seed), int(epoch)
        self.anchor_stride, self.id_filter, self.sample = int(anchor_stride), id_filter, float(sample)
        self.max_gap_ms = float(max_gap_ms)

    def set_epoch(self, epoch: int):
        self.epoch = int(epoch)

    def item_examples(self, feed: str, day):
        day = as_date(day)
        recs = []
        recs.extend(iter_tape(self.tape_dir, feed, day - _dt.timedelta(days=1), hours=[23]))
        recs.extend(iter_tape(self.tape_dir, feed, day))
        recs.extend(iter_tape(self.tape_dir, feed, day + _dt.timedelta(days=1), hours=[0, 1]))
        t0 = day_start_ms(day)
        kind = TRACK_KINDS.index(F.track_kind(feed))
        tracks = group_fixes(feed, recs)
        for tid in sorted(tracks):
            if not keep_track(tid, self.sample, self.seed):
                continue
            if self.id_filter is not None and not self.id_filter(f"{feed}:{tid}"):
                continue
            yield from track_examples(tracks[tid], kind, n_fixes=self.n_fixes, horizons_min=self.horizons_min,
                                      max_gap_ms=self.max_gap_ms, anchor_window=(t0, t0 + 86400000),
                                      anchor_stride=self.anchor_stride)

    def __iter__(self):
        wid, nw = worker_slot()
        items = list(self.items)
        if self.shuffle:
            random.Random(_shuffle_seed(self.seed, self.epoch)).shuffle(items)
        rng = np.random.default_rng([self.seed, self.epoch, wid, 11])
        buf = []
        for feed, day in items[wid::nw]:
            for ex in self.item_examples(feed, day):
                if not self.shuffle or self.shuffle_buffer <= 1:
                    yield ex
                    continue
                buf.append(ex)
                if len(buf) >= self.shuffle_buffer:
                    j = int(rng.integers(len(buf)))
                    buf[j], buf[-1] = buf[-1], buf[j]
                    yield buf.pop()
        for j in (rng.permutation(len(buf)) if buf else ()):
            yield buf[j]
