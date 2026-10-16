"""Validate a gev-outbreak dataset (docs/WORLD-MODEL-DATA.md, "Checks a reader can make").

CLI:
    python -m ml.gevtape.check <dataset_dir> [--world <dir>] [--limit N] [--json] [--explain]

Exit code 0 when no check failed, 1 otherwise. Warnings never fail.

What is checked, per check name in the report:

dataset       dataset.json parses, `days` is a positive integer (under
              `spec` as documented; elsewhere is a warning),
              `channels` (when present) lists the documented channel names in
              order and the documented number of flow / event codes.
world         world.json schema; countries.json present and equal to
              world.json countries[]; nodes/routes/links/tracked shapes; CSR
              offsets non-decreasing and in range; tracked indices valid and
              matching nodes.npy column 7; country indices valid; route ends
              valid; worldId reproduced from the files (warning only: the
              doc does not fix the construction; see reader.verify_world_id).
index         index.jsonl parses; keys unique; every indexed episode is in
              the shards and vice versa; the `shard` field names the shard
              the episode is in; dataset.json counts match (warnings). Pairs
              come from the keys (the `pair` field's meaning is not fixed).
members       every episode has <key>.json and all 14 documented arrays; the
              JSON's own `key` matches; its `arrays` table (when present)
              agrees with the .npy shapes and dtypes.
schema        schema strings of dataset.json and every episode JSON.
dtype, shape  documented dtype (little-endian) and shape of every array,
              with T from dataset.json `days`, C and K from the world (or
              the first episode when no world is given).
conservation  every row, as far as the arrays allow:
              - sum of tracked places <= country, per country and channel (the
                rest, the untracked places, is never negative); with a world
                the places are assigned to their countries and a country
                whose every node is tracked must match exactly; without one
                the check is over all places against all countries;
              - sum over countries = global for the channels the engine counts in
                lockstep: infected, reported, admitted, imported, reinfected,
                infected2 (from country_cum) and deaths (sum D); ward = sum H
                and icu = sum U only on the hospital path (some H or U is
                non-zero and the global ward is whole); vaccinated <= sum V is
                a warning only (V is caught up for untouched places, the
                engine's counter is not);
              - countriesClosed <= countries, restrictedPlaces <= nodes.
              Not checkable from the arrays: S, E, P, Is, Ia, R, V, Rx against
              the global row (it has no such channels), and the population
              identity (inTransit, pendingAdmit and isolated are global only).
non-negative  global and place_aux finite and >= 0; uint32 counts below 2^31
              (a negative count written as uint32 wraps to ~4.29e9); flow
              people >= 0.
cumulative    country_cum and place_cum never fall; D never falls; the
              cumulative global channels never fall.
actions       actions_* finite and in [0, 1] (so vaccineTarget <= 1);
              `flagged` never cleared; windowShare = popcount(window) / hours
              that day (warning only).
controls      controls_window < 2^24; switch rows (day in [0, T), node valid,
              value 0/1); flag rows (day, country valid); flows (day, from in
              [-1, n), to, mode 0-2, kind 0-5); events (hour in [0, 24T],
              node in [-1, n), kind 0-8, country flagged: node -1 and a valid
              country, first arrival: value 1-3).
pairs         the A and B arms of a scenario and run agree exactly on row 0
              of global, country_state, country_cum, place_state, place_cum
              (place_aux: warning only); their stream keys match (warning).
licences      classes in dataset.json and world.json (a `classes` field, or
              class names in `licences`; licence texts are fine) are
              documented classes (open, nc, restricted, unclear, personal,
              static); none declared is a warning. The report lists them.
"""

from __future__ import annotations

import argparse
import json
import sys
import tarfile
import zlib
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import formats as F
from .reader import (FormatError, dataset_field, declared_classes, iter_shard, licence_classes,
                     list_shards, load_dataset_meta, load_world, parse_key, read_index, same_shard,
                     verify_world_id)

CHECKS = ("dataset", "world", "index", "members", "schema", "dtype", "shape", "conservation",
          "non-negative", "cumulative", "actions", "controls", "pairs", "licences")
MAX_MESSAGES = 6  # per check, in the printed report
UINT_WRAP = 2 ** 31

_SI = {c: i for i, c in enumerate(F.STATE_CHANNELS)}
_CI = {c: i for i, c in enumerate(F.CUM_CHANNELS)}
_GI = {c: i for i, c in enumerate(F.GLOBAL_CHANNELS)}


class Report:
    """Errors and warnings by check name, plus info lines."""

    def __init__(self):
        self.errors = defaultdict(list)
        self.warnings = defaultdict(list)
        self.info = {}

    def error(self, check, msg):
        self.errors[check].append(msg)

    def warn(self, check, msg):
        self.warnings[check].append(msg)

    @property
    def ok(self) -> bool:
        return not any(self.errors.values())

    @property
    def n_errors(self) -> int:
        return sum(len(v) for v in self.errors.values())

    @property
    def n_warnings(self) -> int:
        return sum(len(v) for v in self.warnings.values())

    def to_json(self) -> dict:
        return {"ok": self.ok, "errors": dict(self.errors), "warnings": dict(self.warnings),
                "info": self.info}


@dataclass
class _Ctx:
    T: int | None = None
    C: int | None = None
    K: int | None = None
    n: int | None = None
    world: object = None
    groups: dict | None = None  # cached sort of the tracked places by country


def _country_sums(pa: np.ndarray, ctx: _Ctx) -> np.ndarray:
    """[T1, K, F] place values summed into their countries, [T1, C, F] (sorted reduceat)."""
    if ctx.groups is None:
        tc = ctx.world.tracked_country
        order = np.argsort(tc, kind="stable")
        sc = tc[order]
        starts = np.flatnonzero(np.r_[True, sc[1:] != sc[:-1]]) if sc.size else np.zeros(0, np.int64)
        ctx.groups = {"order": order, "starts": starts, "present": sc[starts] if sc.size else sc}
    gr = ctx.groups
    out = np.zeros((pa.shape[0], ctx.C, pa.shape[2]), dtype=pa.dtype)
    if gr["order"].size:
        out[:, gr["present"]] = np.add.reduceat(pa[:, gr["order"]], gr["starts"], axis=1)
    return out


def _first(mask: np.ndarray):
    """Index tuple of the first True in mask."""
    return tuple(int(x) for x in np.argwhere(mask)[0])


def _seed_key(meta):
    """The random stream key an episode JSON names (streamKey as documented, at the
    top level or in a scenario object; else seedKey), or None."""
    if not isinstance(meta, dict):
        return None
    for holder in (meta, meta.get("scenario") if isinstance(meta.get("scenario"), dict) else {}):
        for k in ("streamKey", "seedKey"):
            if holder.get(k) is not None:
                return holder[k]
    return None


def _fmt_shape(shape) -> str:
    return "[" + ", ".join("*" if s is None else str(s) for s in shape) + "]"


# --------------------------------------------------------------------------
# dataset.json and world
# --------------------------------------------------------------------------

_CHANNEL_ALIASES = {
    "state": F.STATE_CHANNELS, "cum": F.CUM_CHANNELS, "aux": F.AUX_CHANNELS,
    "global": F.GLOBAL_CHANNELS, "actionsglobal": F.GLOBAL_ACTIONS,
    "actionscountry": F.COUNTRY_ACTIONS, "actionsplace": F.PLACE_ACTIONS,
    "globalactions": F.GLOBAL_ACTIONS, "countryactions": F.COUNTRY_ACTIONS,
    "placeactions": F.PLACE_ACTIONS,
}


def _norm_key(k: str) -> str:
    k = k.lower().replace("_", "").replace("-", "")
    return k[: -len("channels")] if k.endswith("channels") and k != "channels" else k


_KIND_LISTS = {"flowkinds": F.FLOW_KINDS, "flowmodes": F.FLOW_MODES, "eventkinds": F.EVENT_KINDS}


def _check_channels(channels, r: Report):
    """dataset.json `channels`: any channel list it names must be the documented
    one; code lists (FLOW_KINDS, FLOW_MODES, EVENT_KINDS) must have the
    documented number of codes (their names are not documented)."""
    if channels is None:
        r.warn("dataset", "dataset.json has no channels")
        return
    if not isinstance(channels, dict):
        r.warn("dataset", f"channels is a {type(channels).__name__}, not an object; not compared")
        return
    known = 0
    for k, v in channels.items():
        codes = _KIND_LISTS.get(_norm_key(k))
        if codes is not None:
            if not isinstance(v, list) or len(v) != len(codes):
                r.error("dataset", f"channels.{k} has {len(v) if isinstance(v, list) else '?'} codes, documented {len(codes)}")
            continue
        want = _CHANNEL_ALIASES.get(_norm_key(k))
        if want is None:
            continue
        known += 1
        if list(v) != list(want):
            r.error("dataset", f"channels.{k} is {v}, documented {list(want)}")
    if not known:
        r.warn("dataset", f"channels has no list this check recognises ({sorted(channels)})")


def _check_world(world_dir, r: Report, expected_id=None):
    try:
        world = load_world(world_dir)
    except (FormatError, OSError, ValueError, json.JSONDecodeError) as e:
        r.error("world", str(e))
        return None
    m = world.meta
    if m.get("schema") != F.WORLD_SCHEMA:
        r.error("schema", f"world.json schema {m.get('schema')!r}, expected {F.WORLD_SCHEMA!r}")
    n, K, C = world.n, world.K, world.C
    if world.countries and world.countries[-1] != "":
        r.error("world", "countries[] does not end with '' (none)")
    cj = Path(world.path) / "countries.json"
    if not cj.is_file():
        r.error("world", "missing countries.json")
    else:
        try:
            listed = json.loads(cj.read_text(encoding="utf-8"))
        except ValueError as e:
            r.error("world", f"countries.json: {e}")
            listed = None
        if listed is not None and isinstance(m.get("countries"), list) and listed != m["countries"]:
            r.error("world", "countries.json and world.json countries[] differ")
    off = world.links_offsets
    if (np.diff(off) < 0).any() or off[0] != 0:
        r.error("world", "links_offsets is not a non-decreasing CSR starting at 0")
    if world.links_j.size and ((world.links_j < 0) | (world.links_j >= n)).any():
        r.error("world", "links_j holds node indices out of range")
    sh = world.links_share
    if sh.size and (~np.isfinite(sh) | (sh < 0) | (sh > 1)).any():
        r.error("world", "links_share outside [0, 1]")
    tr = world.tracked
    if tr.size and ((tr < 0) | (tr >= n)).any():
        r.error("world", "tracked.npy holds node indices out of range")
    elif tr.size:
        col = world.nodes[:, 7]
        if not np.array_equal(col[tr], np.arange(K)):
            r.error("world", "nodes.npy column 7 (tracked index) disagrees with tracked.npy")
        if int((col >= 0).sum()) != K:
            r.error("world", "nodes.npy marks a different number of tracked nodes than tracked.npy")
        if len(set(tr.tolist())) != K:
            r.error("world", "tracked.npy repeats a node")
    cidx = world.nodes[:, 5]
    if n and (~np.isfinite(cidx) | (cidx < 0) | (cidx >= C)).any():
        r.error("world", f"nodes.npy country index outside [0, {C})")
    if world.routes.size:
        ends = world.routes[:, :2]
        if ((ends < 0) | (ends >= n)).any():
            r.error("world", "routes.npy from/to out of range")
        if not np.isin(world.routes[:, 5], (0, 1)).all():
            r.error("world", "routes.npy mode is not 0 (air) or 1 (rail)")
        if (world.routes[:, 4] < 0).any():
            r.error("world", "routes.npy passengers < 0")
    counts = m.get("counts") or {}
    for key, actual in (("nodes", n), ("routes", world.routes.shape[0]),
                        ("links", world.links_j.shape[0]), ("tracked", K), ("countries", C)):
        if isinstance(counts.get(key), int) and counts[key] != actual:
            r.warn("world", f"world.json counts.{key} = {counts[key]}, files have {actual}")
    if expected_id and world.world_id != expected_id:
        r.error("world", f"dataset.json worldId {expected_id} but the world is {world.world_id}")
    try:
        ok, how = verify_world_id(world.path)
    except OSError as e:
        ok, how = False, str(e)
    if ok is False:
        r.warn("world", f"worldId {world.world_id} not reproduced from the files: {how}")
    r.info["world"] = (f"{world.path.name}: n {n}, C {C}, K {K}, R {world.routes.shape[0]}, "
                       f"L {world.links_j.shape[0]}" + (f", worldId verified ({how})" if ok else ""))
    return world


# --------------------------------------------------------------------------
# One episode
# --------------------------------------------------------------------------


def _check_members(ep, r: Report, ctx: _Ctx) -> bool:
    key = ep.key
    for e in ep.errors:
        r.error("members", f"{key}: {e}")
    if parse_key(key)[0] is None:
        r.warn("members", f"{key}: key is not s<scenario>-r<run>-<arm>")
    meta = ep.meta
    if meta is None:
        r.error("members", f"{key}: no {key}.json")
    else:
        if meta.get("schema") != F.EPISODE_SCHEMA:
            r.error("schema", f"{key}.json schema {meta.get('schema')!r}, expected {F.EPISODE_SCHEMA!r}")
        if "key" in meta and meta["key"] != key:
            r.error("members", f"{key}.json says key {meta['key']!r}")
    missing = [n for n in F.EPISODE_ARRAYS if n not in ep.arrays]
    if missing:
        r.error("members", f"{key}: missing {', '.join(missing)}")
    extra = sorted(set(ep.arrays) - set(F.EPISODE_ARRAYS) - set(F.OPTIONAL_EPISODE_ARRAYS))
    if extra:
        r.warn("members", f"{key}: undocumented arrays {extra}")
    # Dimensions: T from dataset.json, C/K from the world, else the first episode.
    if ctx.T is None and "global" in ep.arrays:
        ctx.T = int(ep["global"].shape[0]) - 1
    if ctx.C is None and "country_state" in ep.arrays and ep["country_state"].ndim == 3:
        ctx.C = int(ep["country_state"].shape[1])
    if ctx.K is None and "place_state" in ep.arrays and ep["place_state"].ndim == 3:
        ctx.K = int(ep["place_state"].shape[1])
    if meta:
        for field, want in (("days", ctx.T), ("countries", ctx.C), ("places", ctx.K)):
            if isinstance(meta.get(field), int) and want is not None and meta[field] != want:
                r.error("shape", f"{key}.json {field} = {meta[field]}, expected {want}")
    good = not missing and not ep.errors
    table = (meta or {}).get("arrays") if isinstance((meta or {}).get("arrays"), dict) else {}
    for name, (dtype, _dims) in {**F.EPISODE_ARRAYS, **F.OPTIONAL_EPISODE_ARRAYS}.items():
        if name not in ep.arrays:
            continue
        a = ep.arrays[name]
        if a.dtype != np.dtype(dtype):
            r.error("dtype", f"{key}.{name}: dtype {a.dtype.str}, expected {dtype}")
            good = False
        want = F.expected_shape(name, ctx.T, ctx.C, ctx.K)
        if a.ndim != len(want) or any(w is not None and w != s for w, s in zip(want, a.shape)):
            r.error("shape", f"{key}.{name}: shape {list(a.shape)}, expected {_fmt_shape(want)}")
            good = False
        t = table.get(name)
        if isinstance(t, dict):
            if "shape" in t and list(t["shape"]) != list(a.shape):
                r.error("members", f"{key}.json arrays.{name}.shape {t['shape']} but the .npy is {list(a.shape)}")
            if "dtype" in t and np.dtype(t["dtype"]) != a.dtype:
                r.error("members", f"{key}.json arrays.{name}.dtype {t['dtype']} but the .npy is {a.dtype.str}")
    return good


def _check_values(ep, r: Report, ctx: _Ctx):
    key, T, C, K, n = ep.key, ctx.T, ctx.C, ctx.K, ctx.n
    g = np.asarray(ep["global"], dtype=np.float64)
    cs = ep["country_state"].astype(np.int64)
    cc = ep["country_cum"].astype(np.int64)
    ps = ep["place_state"].astype(np.int64)
    pcm = ep["place_cum"].astype(np.int64)
    aux = ep["place_aux"]

    # ---- non-negative
    for name in ("country_state", "country_cum", "place_state", "place_cum"):
        a = ep[name]
        bad = a >= UINT_WRAP
        if bad.any():
            row, idx, ch = _first(bad)
            chans = F.STATE_CHANNELS if name.endswith("state") else F.CUM_CHANNELS
            r.error("non-negative", f"{key}.{name}: {int(bad.sum())} values >= 2^31 (negative written as uint32?), "
                                    f"first row {row} index {idx} {chans[ch]} = {int(a[row, idx, ch])}")
    for name, a, chans in (("global", g, F.GLOBAL_CHANNELS), ("place_aux", aux, F.AUX_CHANNELS)):
        nonfin = ~np.isfinite(a)
        if nonfin.any():
            r.error("non-negative", f"{key}.{name}: {int(nonfin.sum())} values not finite")
        neg = np.isfinite(a) & (a < 0)
        if neg.any():
            loc = _first(neg)
            r.error("non-negative", f"{key}.{name}: {int(neg.sum())} negative values, first row {loc[0]} "
                                    f"{chans[loc[-1]]} = {float(a[loc]):g}")
    flows = ep["flows"]
    if flows.size and (flows[:, 5] < 0).any():
        r.error("non-negative", f"{key}.flows: {int((flows[:, 5] < 0).sum())} rows with people < 0")

    # ---- cumulative
    for name, a, chans in (("country_cum", cc, F.CUM_CHANNELS), ("place_cum", pcm, F.CUM_CHANNELS)):
        fall = np.diff(a, axis=0) < 0
        if fall.any():
            row, idx, ch = _first(fall)
            r.error("cumulative", f"{key}.{name}: {chans[ch]} falls at row {row + 1} (index {idx}: "
                                  f"{int(a[row, idx, ch])} -> {int(a[row + 1, idx, ch])}); {int(fall.sum())} falls")
    for name, a in (("country_state", cs), ("place_state", ps)):
        dd = a[:, :, _SI["D"]]
        fall = np.diff(dd, axis=0) < 0
        if fall.any():
            row, idx = _first(fall)
            r.error("cumulative", f"{key}.{name}: D falls at row {row + 1} (index {idx}: {int(dd[row, idx])} -> {int(dd[row + 1, idx])})")
    for gname in F.GLOBAL_CUMULATIVE:
        col = g[:, _GI[gname]]
        fall = np.diff(col) < -1e-9 * np.maximum(1.0, np.abs(col[1:]))
        if fall.any():
            row = int(np.argmax(fall))
            r.error("cumulative", f"{key}.global: {gname} falls at row {row + 1} ({col[row]:g} -> {col[row + 1]:g})")

    # ---- conservation
    world = ctx.world
    for label, pa, ca, chans in (("state", ps, cs, F.STATE_CHANNELS), ("cum", pcm, cc, F.CUM_CHANNELS)):
        if world is not None:
            agg = _country_sums(pa, ctx)
            rest = ca - agg
            neg = rest < 0
            if neg.any():
                row, c, ch = _first(neg)
                r.error("conservation", f"{key}: tracked places of country {c} ({world.countries[c] or 'none'}) hold "
                                        f"more {chans[ch]} than the country at row {row} ({int(agg[row, c, ch])} > {int(ca[row, c, ch])})")
            tracked_mask = np.zeros(world.n, dtype=bool)
            tracked_mask[world.tracked] = True
            untracked = np.bincount(world.country_of_node[~tracked_mask], minlength=C)[:C]
            full = untracked == 0
            off = (rest != 0) & full[None, :, None]
            if off.any():
                row, c, ch = _first(off)
                r.error("conservation", f"{key}: every place of country {c} is tracked but the country's {chans[ch]} "
                                        f"differs from their sum at row {row} ({int(ca[row, c, ch])} vs {int(agg[row, c, ch])})")
        else:
            over = pa.sum(axis=1) > ca.sum(axis=1)
            if over.any():
                row, ch = _first(over)
                r.error("conservation", f"{key}: the tracked places hold more {chans[ch]} than all countries at row {row}")
    tot_c = cc.sum(axis=1)  # [T1, 7]
    tot_s = cs.sum(axis=1)  # [T1, 15]
    pairs = [(gname, tot_c[:, _CI[c]], f"sum country_cum.{c}") for gname, c in F.GLOBAL_FROM_CUM.items()]
    pairs += [(gname, tot_s[:, _SI[s]], f"sum country_state.{s}") for gname, s in F.GLOBAL_FROM_STATE.items()]
    ward = g[:, _GI["ward"]]
    hospital = (tot_s[:, _SI["H"]].any() or tot_s[:, _SI["U"]].any()) and np.allclose(ward, np.round(ward))
    if hospital:
        pairs += [(gname, tot_s[:, _SI[s]], f"sum country_state.{s}") for gname, s in F.GLOBAL_FROM_STATE_HOSPITAL.items()]
    for gname, want, label in pairs:
        have = g[:, _GI[gname]]
        off = np.abs(have - want) > 0.5 + 1e-9 * np.abs(want)
        if off.any():
            row = int(np.argmax(off))
            r.error("conservation", f"{key}: global {gname} = {have[row]:g} but {label} = {int(want[row])} at row {row}")
    vac_over = g[:, _GI["vaccinated"]] > tot_s[:, _SI["V"]] + 0.5
    if vac_over.any():
        row = int(np.argmax(vac_over))
        r.warn("conservation", f"{key}: global vaccinated {g[row, _GI['vaccinated']]:g} > sum V {int(tot_s[row, _SI['V']])} at row {row}")
    if (g[:, _GI["countriesClosed"]] > C).any():
        r.error("conservation", f"{key}: countriesClosed exceeds the {C} countries")
    if n is not None and (g[:, _GI["restrictedPlaces"]] > n).any():
        r.error("conservation", f"{key}: restrictedPlaces exceeds the {n} nodes")

    # ---- actions
    for name, chans in (("actions_global", F.GLOBAL_ACTIONS), ("actions_country", F.COUNTRY_ACTIONS),
                        ("actions_place", F.PLACE_ACTIONS)):
        a = ep[name]
        bad = ~np.isfinite(a) | (a < 0) | (a > 1)
        if bad.any():
            loc = _first(bad)
            r.error("actions", f"{key}.{name}: {int(bad.sum())} values outside [0, 1], first day {loc[0]} "
                               f"{chans[loc[-1]]} = {float(a[loc]):g}")
    fl = ep["actions_country"][:, :, 1]
    cleared = np.diff(fl, axis=0) < 0
    if cleared.any():
        d, c = _first(cleared)
        r.error("actions", f"{key}.actions_country: flagged cleared for country {c} on day {d + 1}")
    cw = ep["controls_window"].astype(np.int64)
    hours = (ep.meta or {}).get("hours")
    hours = int(hours) if isinstance(hours, (int, float)) and hours > 0 else 24 * T
    per_day = np.clip(hours - 24 * np.arange(T), 1, 24)
    pop = np.array([bin(int(x) & 0xFFFFFF).count("1") for x in cw], dtype=np.float64)
    share = ep["actions_global"][:, 0].astype(np.float64)
    off = np.abs(share - pop / per_day) > 1e-4
    if off.any():
        d = int(np.argmax(off))
        r.warn("actions", f"{key}: windowShare {share[d]:.4f} on day {d}, popcount(window)/hours = {pop[d] / per_day[d]:.4f}")

    # ---- controls
    if (cw >= 2 ** 24).any() or (cw < 0).any():
        r.error("controls", f"{key}.controls_window: values beyond 24 bits")
    sw = ep["controls_switch"]
    if sw.size:
        if ((sw[:, 0] < 0) | (sw[:, 0] >= T)).any():
            r.error("controls", f"{key}.controls_switch: day outside [0, {T})")
        if (sw[:, 1] < 0).any() or (n is not None and (sw[:, 1] >= n).any()):
            r.error("controls", f"{key}.controls_switch: node out of range")
        if not np.isin(sw[:, 2], (0, 1)).all():
            r.error("controls", f"{key}.controls_switch: value not 0/1")
    if "controls_magnitudes" in ep.arrays:
        mg = ep["controls_magnitudes"].astype(np.float64)
        if mg.ndim == 2 and mg.shape[1] == len(F.MAGNITUDE_CONTROLS):
            given = np.isfinite(mg)
            # Logged as the control gave them; the engine clamps shares to
            # [0, 1], so a value outside is a policy's, not a broken run.
            for j, name in enumerate(F.MAGNITUDE_CONTROLS):
                col = mg[given[:, j], j]
                hi = 1.0 if name in ("lockdown", "travelBan") else np.inf
                if col.size and ((col < 0).any() or (col > hi).any()):
                    r.warn("controls", f"{key}.controls_magnitudes: {name} outside [0, {hi:g}] (the engine clamps)")
    fg = ep["controls_flags"]
    if fg.size:
        if ((fg[:, 0] < 0) | (fg[:, 0] >= T)).any():
            r.error("controls", f"{key}.controls_flags: day outside [0, {T})")
        if ((fg[:, 1] < 0) | (fg[:, 1] >= C)).any():
            r.error("controls", f"{key}.controls_flags: country outside [0, {C})")
    if flows.size:
        nn = n if n is not None else np.iinfo(np.int32).max
        checks = (((flows[:, 0] < 0) | (flows[:, 0] >= T), "day outside [0, T)"),
                  ((flows[:, 1] < -1) | (flows[:, 1] >= nn), "from node out of range"),
                  ((flows[:, 2] < 0) | (flows[:, 2] >= nn), "to node out of range"),
                  (~np.isin(flows[:, 3], (0, 1, 2)), "mode not 0-2"),
                  ((flows[:, 4] < 0) | (flows[:, 4] >= len(F.FLOW_KINDS)), "kind not 0-5"))
        for bad, what in checks:
            if bad.any():
                r.error("controls", f"{key}.flows: {int(bad.sum())} rows with {what}")
    ev = ep["events"]
    if ev.size:
        nn = n if n is not None else np.iinfo(np.int32).max
        kind = ev[:, 2]
        checks = (((ev[:, 0] < 0) | (ev[:, 0] > 24 * T), f"hour outside [0, {24 * T}]"),
                  ((ev[:, 1] < -1) | (ev[:, 1] >= nn), "node out of range"),
                  ((kind < 0) | (kind >= len(F.EVENT_KINDS)), "kind not 0-8"),
                  ((kind == F.EVENT_COUNTRY_FLAGGED) & ((ev[:, 1] != -1) | (ev[:, 3] < 0) | (ev[:, 3] >= C)),
                   "country-flagged event without node -1 and a valid country"),
                  ((kind == F.EVENT_FIRST_ARRIVAL) & ~np.isin(ev[:, 3], (1, 2, 3)), "first arrival value not 1-3"))
        for bad, what in checks:
            if bad.any():
                r.error("controls", f"{key}.events: {int(bad.sum())} rows with {what}")


# --------------------------------------------------------------------------
# Whole dataset
# --------------------------------------------------------------------------


def check_dataset(dataset_dir, world_dir=None, limit=None) -> Report:
    """Run every check over a dataset directory; see the module docstring."""
    r = Report()
    d = Path(dataset_dir)
    ctx = _Ctx()
    meta = None
    try:
        meta = load_dataset_meta(d)
    except FileNotFoundError:
        r.error("dataset", f"{d}: no dataset.json")
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        r.error("dataset", f"dataset.json: {e}")
    if meta is not None:
        if meta.get("schema") != F.DATASET_SCHEMA:
            r.error("schema", f"dataset.json schema {meta.get('schema')!r}, expected {F.DATASET_SCHEMA!r}")
        days = dataset_field(meta, "days")
        if isinstance(days, int) and not isinstance(days, bool) and days > 0:
            ctx.T = days
        else:
            r.error("dataset", f"dataset.json days is {days!r}, expected a positive integer")
        for name in ("days", "runs"):
            spec = meta.get("spec") if isinstance(meta.get("spec"), dict) else {}
            if spec.get(name) is None and dataset_field(meta, name) is not None:
                r.warn("dataset", f"{name} is not under spec, where the doc puts it")
        _check_channels(meta.get("channels"), r)
        r.info["dataset"] = (f"{meta.get('schema')}, world {meta.get('worldId')}, {dataset_field(meta, 'days')} days, "
                             f"{dataset_field(meta, 'runs')} runs")
    world_id = (meta or {}).get("worldId")
    if world_dir is None and world_id:
        auto = d.parent.parent / "worlds" / str(world_id)
        if (auto / "world.json").is_file():
            world_dir = auto
    if world_dir is not None:
        world = _check_world(world_dir, r, expected_id=world_id)
        if world is not None:
            ctx.world, ctx.C, ctx.K, ctx.n = world, world.C, world.K, world.n
    else:
        r.info["world"] = "none given or found (conservation checked over all places; node ranges unchecked)"

    try:
        index = read_index(d)
    except FormatError as e:
        r.error("index", str(e))
        index = []
    index_by_key = {}
    for e in index:
        k = e.get("key") if isinstance(e, dict) else None
        if not k:
            r.error("index", f"index.jsonl entry without a key: {str(e)[:80]}")
            continue
        if k in index_by_key:
            r.error("index", f"index.jsonl repeats key {k}")
        index_by_key[k] = e
    if not index:
        r.warn("index", "no index.jsonl entries")

    shards = list_shards(d)
    if not shards:
        r.error("members", f"{d / 'shards'}: no shard-<n>.tar.gz")
    rows0, seeds, seen = {}, {}, {}
    checked, full_read = 0, True
    for shard in shards:
        if limit is not None and checked >= limit:
            full_read = False
            break
        try:
            for ep in iter_shard(shard):
                if limit is not None and checked >= limit:
                    full_read = False
                    break
                checked += 1
                if ep.key in seen:
                    r.error("index", f"episode {ep.key} appears in {seen[ep.key]} and {shard.name}")
                seen[ep.key] = shard.name
                if _check_members(ep, r, ctx):
                    try:
                        _check_values(ep, r, ctx)
                    except (ValueError, IndexError, TypeError) as e:
                        r.error("shape", f"{ep.key}: values not checkable ({e})")
                rows0[ep.key] = {name: np.array(ep[name][0]) for name in F.ROW_ARRAYS if name in ep.arrays
                                 and ep[name].ndim >= 1 and ep[name].shape[0] > 0}
                seeds[ep.key] = _seed_key(ep.meta)
        except (tarfile.TarError, OSError, EOFError, zlib.error) as e:
            r.error("members", f"{shard.name}: unreadable ({e})")
    r.info["episodes"] = f"{checked} read" + ("" if full_read else f" (limit {limit})")

    # ---- pairs
    groups = defaultdict(dict)
    for k in rows0:
        s, run, arm = parse_key(k)
        if s is not None and arm in ("A", "B"):
            groups[(s, run)][arm] = k
    n_pairs = 0
    for (s, run), arms in sorted(groups.items()):
        if "A" not in arms or "B" not in arms:
            if full_read and "B" in arms:
                r.warn("pairs", f"{arms['B']} has no arm A")
            continue
        n_pairs += 1
        a, b = rows0[arms["A"]], rows0[arms["B"]]
        for name in F.ROW_ARRAYS:
            if name not in a or name not in b:
                continue
            if a[name].shape != b[name].shape or not np.array_equal(a[name], b[name]):
                where = ""
                if a[name].shape == b[name].shape:
                    loc = _first(a[name] != b[name])
                    where = f" (first at {loc}: {a[name][loc]} vs {b[name][loc]})"
                if name == "place_aux":
                    r.warn("pairs", f"{arms['A']} / {arms['B']}: place_aux differs on row 0{where}")
                else:
                    r.error("pairs", f"{arms['A']} / {arms['B']}: {name} differs on row 0{where}")
        sa, sb = seeds.get(arms["A"]), seeds.get(arms["B"])
        if sa is not None and sb is not None and sa != sb:
            r.warn("pairs", f"{arms['A']} / {arms['B']}: seed keys differ ({sa} vs {sb})")
    r.info["pairs"] = f"{n_pairs} pairs compared"

    # ---- index consistency
    if full_read and index_by_key:
        missing = sorted(set(index_by_key) - set(seen))
        unindexed = sorted(set(seen) - set(index_by_key))
        if missing:
            r.error("index", f"{len(missing)} indexed episodes not in any shard (first {missing[0]})")
        if unindexed:
            r.error("index", f"{len(unindexed)} episodes in shards but not in index.jsonl (first {unindexed[0]})")
        wrong = [k for k, e in index_by_key.items() if k in seen and "shard" in e
                 and not same_shard(e["shard"], seen[k])]
        if wrong:
            r.warn("index", f"{len(wrong)} index entries name another shard (first {wrong[0]}: "
                            f"{index_by_key[wrong[0]]['shard']!r} vs {seen[wrong[0]]})")
    if full_read and meta is not None and isinstance(meta.get("counts"), dict):
        counts = meta["counts"]
        scen = {parse_key(k)[0] for k in seen}
        for name, actual in (("episodes", len(seen)), ("shards", len(shards)), ("scenarios", len(scen))):
            if isinstance(counts.get(name), int) and counts[name] != actual:
                r.warn("index", f"dataset.json counts.{name} = {counts[name]}, found {actual}")
    r.info["index"] = f"{len(index_by_key)} entries, {len(shards)} shards"

    # ---- licences
    found = {}
    for where, m in (("dataset", meta), ("world", ctx.world.meta if ctx.world is not None else None)):
        if m is None:
            continue
        if m.get("classes") is not None:
            named = licence_classes(m.get("classes"))
            unknown = [c for c in named if c not in F.LICENCE_CLASSES]
            if unknown:
                r.error("licences", f"{where}: classes {unknown} are not licence classes {list(F.LICENCE_CLASSES)}")
        found[where] = [c for c in declared_classes(m) if c in F.LICENCE_CLASSES]
        if not found[where]:
            texts = licence_classes(m.get("licences"))
            r.warn("licences", f"{where} declares no licence classes" +
                   (f" ({len(texts)} licence texts but no `classes`)" if texts else ""))
    r.info["licences"] = "; ".join(f"{w}: {', '.join(c) or '-'}" for w, c in found.items()) or "-"
    return r


def format_report(r: Report, dataset_dir) -> str:
    lines = [f"check {dataset_dir}"]
    for key in ("dataset", "world", "index", "episodes", "pairs", "licences"):
        if key in r.info:
            lines.append(f"  {key:<13}{r.info[key]}")
    for check in CHECKS:
        errs, warns = r.errors.get(check, []), r.warnings.get(check, [])
        if errs:
            status = f"FAIL {len(errs)}"
        elif warns:
            status = f"ok, {len(warns)} warning" + ("s" if len(warns) > 1 else "")
        else:
            status = "ok"
        lines.append(f"  {check:<13}{status}")
        for kind, msgs in (("error", errs), ("warning", warns)):
            for m in msgs[:MAX_MESSAGES]:
                lines.append(f"      {kind}: {m}")
            if len(msgs) > MAX_MESSAGES:
                lines.append(f"      ... and {len(msgs) - MAX_MESSAGES} more {kind}s")
    lines.append(f"RESULT: {'OK' if r.ok else 'FAIL'} ({r.n_errors} errors, {r.n_warnings} warnings)")
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m ml.gevtape.check",
                                 description="Validate a gev-outbreak dataset directory.")
    ap.add_argument("dataset_dir", nargs="?")
    ap.add_argument("--world", help="the world snapshot directory (default: ../../worlds/<worldId> if present)")
    ap.add_argument("--limit", type=int, default=None, help="check only the first N episodes")
    ap.add_argument("--json", action="store_true", help="print the report as JSON")
    ap.add_argument("--explain", action="store_true", help="print what each check covers and exit")
    a = ap.parse_args(argv)
    if a.explain:
        print(__doc__)
        return 0
    if not a.dataset_dir:
        ap.error("dataset_dir is required")
    r = check_dataset(a.dataset_dir, world_dir=a.world, limit=a.limit)
    if a.json:
        print(json.dumps(r.to_json(), indent=1))
    else:
        print(format_report(r, a.dataset_dir))
    return 0 if r.ok else 1


if __name__ == "__main__":
    sys.exit(main())
