"""Readers for the .gev-data world-model formats (docs/WORLD-MODEL-DATA.md).

Everything here is read-only and needs only the standard library and numpy:

- worlds:   load_world(dir) -> World
- episodes: iter_episodes(dataset_dir) streams Episode objects out of
            shards/*.tar.gz with tarfile + numpy.load(io.BytesIO(...))
- datasets: load_dataset_meta, read_index
- helpers:  daily_obs, country_graph, place_edges, normalized_adjacency
- tape:     iter_tape(tape_dir, feed, day) over HH.ndjson.gz, manifests, gaps
- bins:     load_bins(bins_dir, day) -> Bins
- real:     load_real(dir) -> RealData (real/owid-oxcgrt), load_worldbank
- discovery: list_worlds / list_datasets / find_world under a .gev-data root
"""

from __future__ import annotations

import datetime as _dt
import gzip
import hashlib
import io
import json
import os
import random
import re
import tarfile
import warnings
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Iterator

import numpy as np

from . import formats as F
from . import geo


class FormatError(ValueError):
    """A file does not match the documented format."""


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------


def read_json(path):
    """Parse a UTF-8 JSON file."""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_npy(source):
    """numpy.load of a path or of raw .npy bytes, never unpickling."""
    if isinstance(source, (bytes, bytearray, memoryview)):
        return np.load(io.BytesIO(bytes(source)), allow_pickle=False)
    return np.load(source, allow_pickle=False)


def licence_classes(value) -> list:
    """The licence classes a `licences` field names, sorted and unique.

    Accepts a class string, a list of class strings, a list of objects with a
    `class` key ({source, class, licence}), or a dict ({class: sources} or
    {source: class}). Strings are returned as given, so a value that is not a
    class (for example a licence name) shows up for the caller to flag.
    """
    out: set = set()

    def add(item):
        if isinstance(item, str):
            if item:
                out.add(item)
        elif isinstance(item, dict):
            cls = item.get("class", item.get("licenceClass", item.get("classes")))
            if isinstance(cls, str):
                add(cls)
            elif isinstance(cls, (list, tuple)):
                for c in cls:
                    add(c)

    if isinstance(value, dict):
        if value and all(k in F.CATALOG_CLASSES for k in value):
            out.update(value.keys())
        else:
            for v in value.values():
                add(v)
    elif isinstance(value, (list, tuple)):
        for item in value:
            add(item)
    elif value is not None:
        add(value)
    return sorted(out)


def declared_classes(meta) -> list:
    """The licence classes a dataset.json / world.json declares.

    A `classes` field wins (the producer writes the classes there and puts
    the licence texts in `licences`); otherwise the entries of `licences`
    that are classes (strings or {class} objects). Licence texts are not
    classes and are left out.
    """
    if not isinstance(meta, dict):
        return []
    if meta.get("classes") is not None:
        return licence_classes(meta.get("classes"))
    found = licence_classes(meta.get("licences"))
    return [c for c in found if c in F.CATALOG_CLASSES]


def dataset_field(meta, name):
    """A dataset.json sweep number such as `days` or `runs`: under `spec` as
    documented, else at the top level or under `sampler.spec` (earlier layouts)."""
    if not isinstance(meta, dict):
        return None
    for holder in (meta.get("spec"), meta, (meta.get("sampler") or {}).get("spec")
                   if isinstance(meta.get("sampler"), dict) else None):
        if isinstance(holder, dict) and holder.get(name) is not None:
            return holder.get(name)
    return None


def _sort_time(value, fallback: float) -> float:
    """A sortable number from a ms timestamp or an ISO string."""
    if isinstance(value, (int, float)) and np.isfinite(value):
        return float(value)
    if isinstance(value, str):
        try:
            return _dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
        except ValueError:
            pass
    return fallback


# --------------------------------------------------------------------------
# World snapshot
# --------------------------------------------------------------------------


@dataclass
class World:
    """A frozen world graph (outbreak/worlds/<worldId>/)."""

    path: Path
    meta: dict
    nodes: np.ndarray          # float64 [n, 8], F.NODE_COLUMNS
    ids: list
    codes: list
    names: list
    routes: np.ndarray         # float64 [R, 7], F.ROUTE_COLUMNS
    links_offsets: np.ndarray  # int32 [n + 1], commuting CSR
    links_j: np.ndarray        # int32 [L]
    links_share: np.ndarray    # float64 [L]
    tracked: np.ndarray        # int32 [K], node index of each tracked place
    countries: list            # ISO2 codes, '' last for none
    demographics: np.ndarray | None = None   # [n, 5] when loaded with a data root
    demographics_columns: list | None = None
    abundance: np.ndarray | None = None      # [n, 17] when loaded with a data root
    abundance_columns: list | None = None

    @property
    def world_id(self) -> str:
        return str(self.meta.get("worldId") or self.path.name)

    @property
    def n(self) -> int:
        return int(self.nodes.shape[0])

    @property
    def K(self) -> int:
        return int(self.tracked.shape[0])

    @property
    def C(self) -> int:
        return len(self.countries)

    @property
    def lat(self) -> np.ndarray:
        return self.nodes[:, 0]

    @property
    def lon(self) -> np.ndarray:
        return self.nodes[:, 1]

    @property
    def population(self) -> np.ndarray:
        return self.nodes[:, 2]

    @property
    def utc_offset(self) -> np.ndarray:
        return self.nodes[:, 6]

    @property
    def country_of_node(self) -> np.ndarray:
        """Country index per node; anything out of range counts as none (C - 1)."""
        c = np.nan_to_num(self.nodes[:, 5], nan=-1).astype(np.int64)
        c[(c < 0) | (c >= self.C)] = self.C - 1
        return c

    @property
    def tracked_country(self) -> np.ndarray:
        """Country index per tracked place [K]."""
        return self.country_of_node[self.tracked]

    def country_population(self) -> np.ndarray:
        """People per country [C] (every node, tracked or not)."""
        return np.bincount(self.country_of_node, weights=self.population,
                           minlength=self.C)[: self.C]

    def links_of(self, i: int):
        """(neighbour node indices, commuting shares) of node i."""
        s, e = int(self.links_offsets[i]), int(self.links_offsets[i + 1])
        return self.links_j[s:e], self.links_share[s:e]

    @property
    def licence_classes(self) -> list:
        return declared_classes(self.meta)


def load_world(path, data_root=None) -> World:
    """Load world.json and the .npy files of a world snapshot directory.

    Raises FormatError when an array file is missing or a shape disagrees
    with the documented layout. The country list comes from world.json, else
    countries.json. With `data_root`, the world's demographics
    (demographics/places-<worldId>.npy) are attached when they exist.
    """
    p = Path(path)
    if not (p / "world.json").is_file():
        raise FormatError(f"{p}: no world.json")
    meta = read_json(p / "world.json")
    for name in F.WORLD_ARRAYS:
        if not (p / name).is_file():
            raise FormatError(f"{p}: missing {name}")
    nodes = np.asarray(load_npy(p / "nodes.npy"), dtype=np.float64)
    if nodes.ndim != 2 or nodes.shape[1] != len(F.NODE_COLUMNS):
        raise FormatError(f"nodes.npy: shape {nodes.shape}, expected [n, 8]")
    n = nodes.shape[0]
    ids = read_json(p / "node_ids.json")
    if not isinstance(ids, dict):
        raise FormatError("node_ids.json: expected {id: [], code: [], name: []}")
    lists = {}
    for k in ("id", "code", "name"):
        v = ids.get(k)
        if v is None:
            v = [""] * n
        if not isinstance(v, list) or len(v) != n:
            raise FormatError(f"node_ids.json: '{k}' must be a list of {n}")
        lists[k] = v
    routes = np.asarray(load_npy(p / "routes.npy"), dtype=np.float64)
    if routes.size == 0:
        routes = routes.reshape(0, len(F.ROUTE_COLUMNS))
    if routes.ndim != 2 or routes.shape[1] != len(F.ROUTE_COLUMNS):
        raise FormatError(f"routes.npy: shape {routes.shape}, expected [R, 7]")
    offsets = load_npy(p / "links_offsets.npy")
    links_j = load_npy(p / "links_j.npy")
    share = load_npy(p / "links_share.npy")
    if offsets.shape != (n + 1,):
        raise FormatError(f"links_offsets.npy: shape {offsets.shape}, expected [{n + 1}]")
    if links_j.ndim != 1 or share.shape != links_j.shape:
        raise FormatError("links_j.npy / links_share.npy: expected two [L] arrays")
    if n and int(offsets[-1]) != links_j.shape[0]:
        raise FormatError("links_offsets.npy: last offset is not the number of links")
    tracked = load_npy(p / "tracked.npy")
    if tracked.ndim != 1:
        raise FormatError(f"tracked.npy: shape {tracked.shape}, expected [K]")
    countries = meta.get("countries")
    if (not isinstance(countries, list) or not countries) and (p / "countries.json").is_file():
        countries = read_json(p / "countries.json")  # a producer extra: the same list
    if not isinstance(countries, list) or not countries:
        top = int(np.nanmax(nodes[:, 5])) + 1 if n else 1
        countries = [str(i) for i in range(max(top - 1, 0))] + [""]
    demo, demo_cols = None, None
    abund, abund_cols = None, None
    if data_root is not None:
        demo, dmeta = load_demographics(data_root, str(meta.get("worldId") or p.name), n)
        demo_cols = (dmeta or {}).get("channels")
        abund, ameta = load_abundance(data_root, str(meta.get("worldId") or p.name), n)
        abund_cols = (ameta or {}).get("channels")
    return World(
        path=p, meta=meta, nodes=nodes,
        ids=lists["id"], codes=lists["code"], names=lists["name"],
        routes=routes,
        links_offsets=offsets.astype(np.int64),
        links_j=links_j.astype(np.int64),
        links_share=share.astype(np.float64),
        tracked=tracked.astype(np.int64),
        countries=[str(c) for c in countries],
        demographics=demo, demographics_columns=demo_cols,
        abundance=abund, abundance_columns=abund_cols,
    )


def _load_static_places(d, stem, n=None):
    """(float32 [n, C] or None, <stem>.json or None) from a static per-place table."""
    arr_path = d / f"{stem}.npy"
    if not arr_path.is_file():
        return None, None
    arr = np.asarray(load_npy(arr_path), dtype=np.float32)
    if arr.ndim != 2 or (n is not None and arr.shape[0] != n):
        warnings.warn(f"{arr_path}: shape {arr.shape} does not fit the world's {n} places; ignored")
        return None, None
    meta = None
    if (d / f"{stem}.json").is_file():
        try:
            meta = read_json(d / f"{stem}.json")
        except (OSError, ValueError):
            meta = None
    return arr, meta


def load_demographics(data_root, world_id, n=None):
    """(float32 [n, 5] or None, places-<worldId>.json or None) from <root>/demographics/.

    Columns: log10 population, then four shares in 0-1 (NaN where the
    country has no figure). None when absent or when its rows are not the
    world's n places.
    """
    return _load_static_places(Path(data_root) / "demographics", f"places-{world_id}", n)


def load_abundance(data_root, world_id, n=None):
    """(float32 [n, C] or None, abundance-<worldId>.json or None) from <root>/demographics/.

    The GLOBAL ABUNDANCE MAP's figures per place, by its country: one
    column per indicator with the country's place among the others (0 the
    least abundant, 1 the most), then their mean; NaN where the country has
    no figure. `channels` in the .json names the columns. None when absent
    or when its rows are not the world's n places.
    """
    return _load_static_places(Path(data_root) / "demographics", f"abundance-{world_id}", n)


def world_files_digest(path, order: Iterable[str] = F.WORLD_FILES, *, with_names: bool = False) -> str:
    """First 16 hex digits of sha256 over the files in `order` (each file's
    name before its bytes when with_names)."""
    h = hashlib.sha256()
    for name in order:
        if with_names:
            h.update(name.encode("utf-8"))
        with open(Path(path) / name, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    return h.hexdigest()[:16]


def verify_world_id(path) -> tuple:
    """(ok, how): does world.json's worldId match the files?

    The doc says "a sha256 over every file but world.json" without the
    construction. Tried first what server/shared/outbreakWorldStore.mjs does
    (every file of the folder but world.json by sorted name, each name hashed
    before its bytes), then the documented files that way, then plain
    concatenations in table and sorted order.
    ok is None when there is no worldId to compare.
    """
    p = Path(path)
    meta = read_json(p / "world.json")
    want = str(meta.get("worldId") or "")
    if not want:
        return None, "world.json has no worldId"
    every = sorted(f.name for f in p.iterdir() if f.is_file() and f.name != "world.json"
                   and not f.name.endswith(".tmp"))
    tries = (("sorted names, name + bytes, every file", every, True),
             ("sorted names, name + bytes, documented files", sorted(F.WORLD_FILES), True),
             ("table order", F.WORLD_FILES, False),
             ("sorted names", sorted(F.WORLD_FILES), False))
    for label, order, names in tries:
        try:
            if world_files_digest(p, order, with_names=names) == want:
                return True, label
        except OSError:
            continue  # a file this construction names is missing
    return False, "no tried construction reproduces it (" + "; ".join(t[0] for t in tries) + ")"


# --------------------------------------------------------------------------
# Datasets and episodes
# --------------------------------------------------------------------------

_KEY_RE = re.compile(r"^s(\d+)-r(\d+)-([A-Za-z0-9]+)$")
_SHARD_RE = re.compile(r"^shard-(\d+)\.tar\.gz$")


def parse_key(key: str):
    """(scenario, run, arm) of an episode key like 's000123-r05-A', or Nones."""
    m = _KEY_RE.match(key or "")
    if not m:
        return None, None, None
    return int(m.group(1)), int(m.group(2)), m.group(3)


@dataclass
class Episode:
    """One run of one scenario: its JSON and its arrays."""

    key: str
    meta: dict | None
    arrays: dict
    shard: str = ""
    extra: dict = field(default_factory=dict)    # members neither .json nor .npy
    errors: list = field(default_factory=list)   # members that failed to parse

    @property
    def scenario(self):
        s = parse_key(self.key)[0]
        return s if s is not None else (self.meta or {}).get("scenario")

    @property
    def run(self):
        r = parse_key(self.key)[1]
        return r if r is not None else (self.meta or {}).get("run")

    @property
    def arm(self):
        a = parse_key(self.key)[2]
        return a if a is not None else (self.meta or {}).get("arm")

    @property
    def pair_key(self):
        """The key of the other arm of this scenario and run (A <-> B), or None."""
        s, r, arm = parse_key(self.key)
        if arm not in ("A", "B"):
            return None
        return self.key[: -len(arm)] + ("B" if arm == "A" else "A")

    @property
    def T(self) -> int:
        """Days in the episode."""
        if "global" in self.arrays:
            return int(self.arrays["global"].shape[0]) - 1
        if "actions_global" in self.arrays:
            return int(self.arrays["actions_global"].shape[0])
        return int((self.meta or {}).get("days") or 0)

    @property
    def complete(self) -> bool:
        return self.meta is not None and set(F.EPISODE_ARRAYS).issubset(self.arrays)

    def __getitem__(self, name):
        return self.arrays[name]

    def __contains__(self, name):
        return name in self.arrays

    def get(self, name, default=None):
        return self.arrays.get(name, default)


def load_dataset_meta(dataset_dir) -> dict:
    """dataset.json of a dataset directory."""
    return read_json(Path(dataset_dir) / "dataset.json")


def read_index(dataset_dir) -> list:
    """index.jsonl as a list of dicts ([] when there is none).

    A last line without its newline that does not parse is skipped (the
    generator may be writing it); any other bad line raises FormatError.
    """
    p = Path(dataset_dir) / "index.jsonl"
    if not p.is_file():
        return []
    with open(p, "r", encoding="utf-8") as f:
        text = f.read()
    lines = text.split("\n")
    out = []
    for n, line in enumerate(lines, 1):
        if not line.strip():
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError as e:
            if n == len(lines):  # unterminated last line
                warnings.warn(f"{p}: skipped a partial last line")
                continue
            raise FormatError(f"{p}:{n}: {e}") from None
    return out


def shard_number(path) -> int | None:
    """n of shards/shard-<n>.tar.gz (any zero padding), or None."""
    m = _SHARD_RE.match(Path(path).name)
    return int(m.group(1)) if m else None


def list_shards(dataset_dir) -> list:
    """The dataset's shards/*.tar.gz in shard-number order."""
    d = Path(dataset_dir) / "shards"
    if not d.is_dir():
        return []
    found = []
    for p in d.iterdir():
        if p.is_file() and p.name.endswith(".tar.gz"):
            num = shard_number(p)
            found.append((num is None, num if num is not None else 0, p.name, p))
    found.sort()
    return [row[-1] for row in found]


def index_shard_name(entry_shard) -> str | None:
    """The shard file name an index.jsonl `shard` field points at.

    An int (or numeric string) n is shard-<n>.tar.gz up to zero padding, so
    callers compare with shard_number(); a name is used as given.
    """
    if entry_shard is None:
        return None
    if isinstance(entry_shard, (int, np.integer)):
        return f"shard-{int(entry_shard)}.tar.gz"
    s = str(entry_shard)
    if s.isdigit():
        return f"shard-{int(s)}.tar.gz"
    return Path(s).name


def same_shard(entry_shard, path) -> bool:
    """Does an index.jsonl `shard` field name this shard file?"""
    if entry_shard is None:
        return False
    if isinstance(entry_shard, (int, np.integer)) or str(entry_shard).isdigit():
        return shard_number(path) == int(entry_shard)
    name = Path(str(entry_shard)).name
    if name == Path(path).name:
        return True
    num = shard_number(name)
    return num is not None and num == shard_number(path)


def _resolve_shards(dataset_dir, shards) -> list:
    every = list_shards(dataset_dir)
    if shards is None:
        return every
    by_num = {shard_number(p): p for p in every}
    by_name = {p.name: p for p in every}
    out = []
    for s in shards:
        if isinstance(s, (int, np.integer)):
            if int(s) not in by_num:
                raise FileNotFoundError(f"no shard {int(s)} in {dataset_dir}")
            out.append(by_num[int(s)])
            continue
        sp = Path(s)
        if sp.is_file():
            out.append(sp)
        elif sp.name in by_name:
            out.append(by_name[sp.name])
        else:
            raise FileNotFoundError(f"no shard {s} in {dataset_dir}")
    return out


def iter_shard(path, *, keys=None) -> Iterator[Episode]:
    """Stream the episodes of one shard (a gzip'd tar read front to back).

    Members are grouped by their key, the part of the member's base name up
    to the first '.'. An episode is yielded once the next episode's members
    begin (when it has its JSON and all 14 documented arrays), or as soon as
    the optional ones (controls_magnitudes) have arrived too, so a shard
    written episode by episode is read with one episode in memory; members in
    any other order still work (incomplete groups are yielded at the end of
    the shard). A member that fails to parse is recorded in Episode.errors
    rather than raised.
    `keys` (a set) skips every other episode without parsing it.
    """
    path = Path(path)
    pending: dict = {}
    done: set = set()
    required = set(F.EPISODE_ARRAYS)
    everything = required | set(F.OPTIONAL_EPISODE_ARRAYS)
    last = None

    def make(key, g):
        return Episode(key=key, meta=g["meta"], arrays=g["arrays"],
                       shard=path.name, extra=g["extra"], errors=g["errors"])

    with tarfile.open(path, mode="r|gz") as tf:
        for member in tf:
            if not member.isfile():
                continue
            base = member.name.replace("\\", "/").rsplit("/", 1)[-1]
            key, dot, rest = base.partition(".")
            if not dot or not key:
                continue
            if keys is not None and key not in keys:
                continue
            if key in done:
                warnings.warn(f"{path.name}: member {base} arrived after its episode was complete; ignored")
                continue
            # The next episode begins: the one before it is finished if it
            # has everything it needs.
            if last is not None and key != last and last in pending:
                g0 = pending[last]
                if g0["meta"] is not None and required.issubset(g0["arrays"]):
                    done.add(last)
                    yield make(last, pending.pop(last))
            last = key
            fobj = tf.extractfile(member)
            data = fobj.read() if fobj is not None else b""
            g = pending.setdefault(key, {"meta": None, "arrays": {}, "extra": {}, "errors": []})
            if rest == "json":
                try:
                    g["meta"] = json.loads(data.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError) as e:
                    g["errors"].append(f"{base}: {e}")
            elif rest.endswith(".npy"):
                name = rest[: -len(".npy")]
                try:
                    g["arrays"][name] = load_npy(data)
                except (ValueError, OSError, EOFError) as e:
                    g["errors"].append(f"{base}: {e}")
            else:
                g["extra"][rest] = data
            if g["meta"] is not None and everything.issubset(g["arrays"]):
                done.add(key)
                yield make(key, pending.pop(key))
    for key, g in pending.items():
        yield make(key, g)


def iter_episodes(dataset_dir, *, shards=None, shuffle_shards=False, seed=0,
                  keys=None) -> Iterator[Episode]:
    """Stream every episode of a dataset from shards/*.tar.gz.

    shards: a subset to read (shard numbers, file names or paths), in that
    order; shuffle_shards: shuffle the shard order with `seed` (episodes keep
    their order inside a shard); keys: only these episode keys.
    """
    paths = _resolve_shards(dataset_dir, shards)
    if shuffle_shards:
        paths = list(paths)
        random.Random(seed).shuffle(paths)
    keyset = set(keys) if keys is not None else None
    for p in paths:
        yield from iter_shard(p, keys=keyset)


def daily_obs(episode: Episode, level: str = "country") -> dict:
    """New counts per day, derived from the cumulative channels.

    level 'country' or 'place': {name: int64 [T, X]} for every CUM_CHANNELS
    name (new infections, new reports, new admissions, ...) plus 'deaths'
    (the daily rise of state D). level 'global': {name: float64 [T]} for the
    cumulative GLOBAL_CHANNELS. Differences are taken in int64/float64, so a
    falling cumulative shows as a negative number instead of wrapping.
    """
    if level == "global":
        g = np.asarray(episode["global"], dtype=np.float64)
        return {name: np.diff(g[:, F.GLOBAL_CHANNELS.index(name)])
                for name in F.GLOBAL_CUMULATIVE}
    if level not in ("country", "place"):
        raise ValueError("level must be 'country', 'place' or 'global'")
    cum = np.asarray(episode[f"{level}_cum"], dtype=np.int64)
    state = np.asarray(episode[f"{level}_state"], dtype=np.int64)
    d = np.diff(cum, axis=0)
    out = {name: d[..., j] for j, name in enumerate(F.CUM_CHANNELS)}
    out["deaths"] = np.diff(state[..., F.STATE_CHANNELS.index("D")], axis=0)
    return out


def country_graph(world: World, *, modes=None, include_domestic=False) -> np.ndarray:
    """Country adjacency [C, C]: passengers a day on routes, by (from, to) country.

    Directed (row = from). modes: route modes to count (0 air, 1 rail), all
    by default. The diagonal (domestic routes) is zero unless asked for.
    """
    C = world.C
    W = np.zeros((C, C), dtype=np.float64)
    r = world.routes
    if r.size == 0:
        return W
    f = np.nan_to_num(r[:, 0], nan=-1).astype(np.int64)
    t = np.nan_to_num(r[:, 1], nan=-1).astype(np.int64)
    pax = r[:, 4]
    ok = (f >= 0) & (f < world.n) & (t >= 0) & (t < world.n) & np.isfinite(pax) & (pax > 0)
    if modes is not None:
        ok &= np.isin(r[:, 5], list(modes))
    cn = world.country_of_node
    np.add.at(W, (cn[f[ok]], cn[t[ok]]), pax[ok])
    if not include_domestic:
        np.fill_diagonal(W, 0.0)
    return W


def normalized_adjacency(W: np.ndarray, *, log: bool = True) -> np.ndarray:
    """Row-normalised weights (log1p first by default), zero diagonal, float32.

    Row i averages over the nodes i is linked to; a node with no links gets
    an all-zero row (its messages are zero).
    """
    A = np.log1p(np.maximum(W, 0)) if log else np.maximum(W, 0).astype(np.float64)
    A = A.copy()
    np.fill_diagonal(A, 0.0)
    s = A.sum(axis=1, keepdims=True)
    A = np.divide(A, s, out=np.zeros_like(A), where=s > 0)
    return A.astype(np.float32)


def place_edges(world: World, *, k_nearest: int = 4):
    """Edges among the tracked places for the world model's graph.

    Routes between two tracked places (weight log1p passengers a day) plus
    each place's k nearest tracked places by great-circle distance (weight
    1), summed where both exist, then row-normalised. Returns (rows, cols,
    weights) over tracked indices 0..K-1.
    """
    K = world.K
    if K == 0:
        z = np.zeros(0, dtype=np.int64)
        return z, z, np.zeros(0, dtype=np.float32)
    weights: dict = {}
    pos = np.full(world.n, -1, dtype=np.int64)
    pos[world.tracked] = np.arange(K)
    r = world.routes
    if r.size:
        f = np.nan_to_num(r[:, 0], nan=-1).astype(np.int64)
        t = np.nan_to_num(r[:, 1], nan=-1).astype(np.int64)
        ok = (f >= 0) & (f < world.n) & (t >= 0) & (t < world.n)
        for a, b, pax in zip(f[ok], t[ok], r[ok, 4]):
            ka, kb = pos[a], pos[b]
            if ka >= 0 and kb >= 0 and ka != kb and pax > 0:
                weights[(ka, kb)] = weights.get((ka, kb), 0.0) + float(pax)
    weights = {k: float(np.log1p(v)) for k, v in weights.items()}
    k = min(k_nearest, K - 1)
    if k > 0:
        lat = world.lat[world.tracked]
        lon = world.lon[world.tracked]
        for start in range(0, K, 512):  # chunked: K can be thousands
            stop = min(K, start + 512)
            d = geo.haversine_km(lat[start:stop, None], lon[start:stop, None], lat[None, :], lon[None, :])
            d[np.arange(stop - start), np.arange(start, stop)] = np.inf
            near = np.argpartition(d, k - 1, axis=1)[:, :k]
            for i, row in enumerate(near):
                for j in row:
                    key = (start + i, int(j))
                    weights[key] = weights.get(key, 0.0) + 1.0
    if not weights:
        z = np.zeros(0, dtype=np.int64)
        return z, z, np.zeros(0, dtype=np.float32)
    rows = np.array([a for a, _ in weights], dtype=np.int64)
    cols = np.array([b for _, b in weights], dtype=np.int64)
    w = np.array(list(weights.values()), dtype=np.float64)
    tot = np.bincount(rows, weights=w, minlength=K)
    w = w / np.where(tot[rows] > 0, tot[rows], 1.0)
    return rows, cols, w.astype(np.float32)


# --------------------------------------------------------------------------
# World tape
# --------------------------------------------------------------------------


def day_parts(day) -> tuple:
    """('YYYY', 'MM', 'DD') from a date, datetime, 'YYYY-MM-DD', 'YYYY/MM/DD' or 'YYYYMMDD'."""
    if isinstance(day, _dt.datetime):
        day = day.date()
    if isinstance(day, _dt.date):
        return f"{day.year:04d}", f"{day.month:02d}", f"{day.day:02d}"
    s = str(day).strip().replace("-", "/").replace("_", "/")
    if re.fullmatch(r"\d{8}", s):
        s = f"{s[:4]}/{s[4:6]}/{s[6:]}"
    m = re.fullmatch(r"(\d{4})/(\d{1,2})/(\d{1,2})", s)
    if not m:
        raise ValueError(f"not a day: {day!r}")
    return m.group(1), f"{int(m.group(2)):02d}", f"{int(m.group(3)):02d}"


def as_date(day) -> _dt.date:
    y, m, d = day_parts(day)
    return _dt.date(int(y), int(m), int(d))


def day_start_ms(day) -> int:
    """UTC milliseconds of a day's midnight."""
    d = as_date(day)
    return int(_dt.datetime(d.year, d.month, d.day, tzinfo=_dt.timezone.utc).timestamp() * 1000)


def tape_root(tape_dir) -> Path:
    """The tape/ directory, given it or the .gev-data root above it."""
    p = Path(tape_dir)
    if p.name != "tape" and (p / "tape").is_dir():
        return p / "tape"
    return p


def tape_day_dir(tape_dir, feed: str, day) -> Path:
    y, m, d = day_parts(day)
    return tape_root(tape_dir) / feed / y / m / d


def iter_tape(tape_dir, feed: str, day, *, hours=None, stats=None) -> Iterator[dict]:
    """Records of one feed for one UTC day, hour file by hour file (HH.ndjson.gz).

    Blank lines are skipped; a line that is not JSON is counted in
    stats['bad'] and skipped; a file cut short (the recorder may be writing
    it) stops at the cut and is counted in stats['truncated']. Multi-member
    gzip (appended writes) reads as one stream.
    """
    if stats is None:
        stats = {}
    stats.setdefault("bad", 0)
    stats.setdefault("truncated", 0)
    stats.setdefault("files", 0)
    d = tape_day_dir(tape_dir, feed, day)
    for hh in (range(24) if hours is None else hours):
        path = d / f"{int(hh):02d}.ndjson.gz"
        if not path.is_file():
            continue
        stats["files"] += 1
        try:
            with gzip.open(path, "rt", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        stats["bad"] += 1
                        continue
                    if isinstance(rec, dict):
                        yield rec
                    else:
                        stats["bad"] += 1
        except (EOFError, gzip.BadGzipFile, zlib.error, UnicodeDecodeError):
            stats["truncated"] += 1


def list_tape_feeds(tape_dir) -> list:
    """Feed directories under tape/ (those holding a YYYY directory)."""
    root = tape_root(tape_dir)
    if not root.is_dir():
        return []
    out = []
    for p in sorted(root.iterdir()):
        if p.is_dir() and any(c.is_dir() and re.fullmatch(r"\d{4}", c.name) for c in p.iterdir()):
            out.append(p.name)
    return out


def list_tape_days(tape_dir, feed: str) -> list:
    """Days (dates) with a directory for this feed, oldest first."""
    root = tape_root(tape_dir) / feed
    out = []
    if not root.is_dir():
        return out
    for y in root.iterdir():
        if not (y.is_dir() and re.fullmatch(r"\d{4}", y.name)):
            continue
        for m in y.iterdir():
            if not (m.is_dir() and re.fullmatch(r"\d{2}", m.name)):
                continue
            for d in m.iterdir():
                if d.is_dir() and re.fullmatch(r"\d{2}", d.name):
                    try:
                        out.append(_dt.date(int(y.name), int(m.name), int(d.name)))
                    except ValueError:
                        pass
    return sorted(out)


def tape_hours(tape_dir, feed: str, day) -> list:
    """Hours (ints) of a day that have an HH.ndjson.gz file."""
    d = tape_day_dir(tape_dir, feed, day)
    if not d.is_dir():
        return []
    return sorted(int(p.name[:2]) for p in d.iterdir()
                  if re.fullmatch(r"\d{2}\.ndjson\.gz", p.name))


def tape_files(tape_dir, feed: str, day, hour: int) -> list:
    """Frame / raster / grid files of one hour (tape/<feed>/YYYY/MM/DD/HH/<file>)."""
    d = tape_day_dir(tape_dir, feed, day) / f"{int(hour):02d}"
    return sorted(p for p in d.iterdir() if p.is_file()) if d.is_dir() else []


def _read_jsonl(path) -> list:
    out = []
    if not Path(path).is_file():
        return out
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # a line being written
    return out


def read_tape_manifest(tape_dir, feed: str, day) -> list:
    """manifest.jsonl of a feed-day: one {t, hour, records, bytes, files} per write."""
    return _read_jsonl(tape_day_dir(tape_dir, feed, day) / "manifest.jsonl")


def read_gaps(tape_dir) -> list:
    """tape/gaps.jsonl: {from, to, reason, feeds} per gap."""
    return _read_jsonl(tape_root(tape_dir) / "gaps.jsonl")


def tape_day_classes(tape_dir, day, feeds=None) -> list:
    """Licence classes recorded on a day: the `class` of each feed's first record."""
    out = set()
    for feed in (feeds if feeds is not None else list_tape_feeds(tape_dir)):
        for rec in iter_tape(tape_dir, feed, day):
            if isinstance(rec.get("class"), str):
                out.add(rec["class"])
            break
    return sorted(out)


# --------------------------------------------------------------------------
# Bins
# --------------------------------------------------------------------------

_RESERVED_CHANNEL_KEYS = {"licences", "classes", "schema", "worldId", "version",
                          "groups", "builtAt", "updatedAt"}


def _parse_channels(obj) -> tuple:
    """(channels per group, licence classes) from a channels.json object."""
    if not isinstance(obj, dict):
        raise FormatError("channels.json: expected an object")
    groups = obj["groups"] if isinstance(obj.get("groups"), dict) else obj
    channels, classes = {}, set(licence_classes(obj.get("licences") or obj.get("classes")))
    for k, v in groups.items():
        if k in _RESERVED_CHANNEL_KEYS:
            continue
        if isinstance(v, list) and all(isinstance(x, str) for x in v):
            channels[k] = list(v)
        elif isinstance(v, dict):
            cols = v.get("channels", v.get("columns"))
            if isinstance(cols, list):
                channels[k] = [str(x) for x in cols]
                classes.update(licence_classes(v.get("licences") or v.get("classes")))
    return channels, sorted(classes)


def load_bin_channels(bins_dir, day=None) -> tuple:
    """(channels per group, licence classes) for a day's bins.

    Looks for YYYY/MM/DD.channels.json first (a per-day override, in case
    the producer writes one), then channels.json at the bins root.
    """
    root = Path(bins_dir)
    cands = []
    if day is not None:
        y, m, d = day_parts(day)
        cands.append(root / y / m / f"{d}.channels.json")
    cands.append(root / "channels.json")
    for c in cands:
        if c.is_file():
            return _parse_channels(read_json(c))
    return {}, []


@dataclass
class Bins:
    """One day of binned tape: hourly features on the tracked places."""

    day: _dt.date
    groups: dict      # group -> float32 [24, K, channels]; NaN = not observed
    channels: dict    # group -> channel names
    classes: list     # licence classes of the day's bins ([] if nothing says)
    group_classes: dict = field(default_factory=dict)  # group -> classes seen (DD.classes.json)

    @property
    def K(self) -> int:
        for a in self.groups.values():
            return int(a.shape[1])
        return 0

    def stacked(self, groups=None) -> tuple:
        """(float32 [24, K, sum of channels], ['group.channel', ...]) over `groups`."""
        names, parts = [], []
        for g in (groups if groups is not None else sorted(self.groups)):
            if g not in self.groups:
                continue
            parts.append(self.groups[g])
            names.extend(f"{g}.{c}" for c in self.channels[g])
        if not parts:
            return np.zeros((24, self.K, 0), dtype=np.float32), []
        return np.concatenate(parts, axis=-1), names


def load_bins(bins_dir, day) -> Bins:
    """Every YYYY/MM/DD.<group>.npy of a day (float32 [24, K, channels])."""
    root = Path(bins_dir)
    y, m, d = day_parts(day)
    month = root / y / m
    channels, classes = load_bin_channels(root, day)
    groups, names = {}, {}
    if month.is_dir():
        for f in sorted(month.glob(f"{d}.*.npy")):
            group = f.name[len(d) + 1: -len(".npy")]
            arr = load_npy(f)
            if arr.ndim != 3 or arr.shape[0] != 24:
                raise FormatError(f"{f}: shape {arr.shape}, expected [24, K, channels]")
            if arr.dtype != np.float32:
                arr = arr.astype(np.float32)
            cols = channels.get(group)
            if cols is None or len(cols) != arr.shape[2]:
                if cols is not None:
                    warnings.warn(f"{f}: channels.json names {len(cols)} columns, file has {arr.shape[2]}")
                cols = [f"c{i}" for i in range(arr.shape[2])]
            groups[group], names[group] = arr, list(cols)
    ks = {a.shape[1] for a in groups.values()}
    if len(ks) > 1:
        raise FormatError(f"{root}/{y}/{m}/{d}: groups disagree on K: {sorted(ks)}")
    # YYYY/MM/DD.classes.json: {group: [classes seen that day]} (newer writers).
    group_classes = {}
    cj = month / f"{d}.classes.json"
    if cj.is_file():
        try:
            obj = read_json(cj)
        except (OSError, ValueError):
            obj = None
        if isinstance(obj, dict):
            group_classes = {str(g): licence_classes(v) for g, v in obj.items()}
    every = set(classes)
    for v in group_classes.values():
        every.update(v)
    return Bins(day=as_date(day), groups=groups, channels=names, classes=sorted(every),
                group_classes=group_classes)


def list_bin_days(bins_dir) -> list:
    """Days (dates) with at least one bins file, oldest first."""
    root = Path(bins_dir)
    out = set()
    if not root.is_dir():
        return []
    for y in root.iterdir():
        if not (y.is_dir() and re.fullmatch(r"\d{4}", y.name)):
            continue
        for m in y.iterdir():
            if not (m.is_dir() and re.fullmatch(r"\d{2}", m.name)):
                continue
            for f in m.iterdir():
                mm = re.fullmatch(r"(\d{2})\.(.+)\.npy", f.name)
                if mm:
                    try:
                        out.add(_dt.date(int(y.name), int(m.name), int(mm.group(1))))
                    except ValueError:
                        pass
    return sorted(out)


# --------------------------------------------------------------------------
# Real epidemics and policy (real/owid-oxcgrt/)
# --------------------------------------------------------------------------


@dataclass
class RealData:
    """OWID + OxCGRT aligned by day and country (docs/WORLD-MODEL-DATA.md)."""

    path: Path
    meta: dict
    obs: np.ndarray           # float32 [T, C, 6] F.REAL_OBS_CHANNELS; NaN where not observed
    obs_mask: np.ndarray      # bool [T, C, 6]
    actions: np.ndarray       # float32 [T, C, 5] F.REAL_ACTION_CHANNELS, shares 0-1
    actions_mask: np.ndarray  # bool [T, C, 5]
    population: np.ndarray    # float64 [C]; NaN where unknown
    countries: list           # ISO2 per column
    obs_channels: list
    action_channels: list

    @property
    def T(self) -> int:
        return int(self.obs.shape[0])

    @property
    def C(self) -> int:
        return int(self.obs.shape[1])

    @property
    def start(self) -> _dt.date:
        return as_date(self.meta.get("from") or "2020-01-01")

    def date(self, t: int) -> _dt.date:
        return self.start + _dt.timedelta(days=int(t))

    @property
    def classes(self) -> list:
        """Licence classes: `classes` if given, else the single `class`."""
        found = declared_classes(self.meta)
        if not found and isinstance(self.meta.get("class"), str):
            found = [self.meta["class"]]
        return found

    @property
    def attributions(self) -> list:
        """The licence / attribution texts (meta.json `licences`)."""
        lic = self.meta.get("licences")
        return [str(x) for x in lic] if isinstance(lic, list) else ([str(lic)] if lic else [])

    def obs_index(self, name: str) -> int:
        return self.obs_channels.index(name)

    def action_index(self, name: str) -> int:
        return self.action_channels.index(name)


def real_dir(path) -> Path:
    """real/owid-oxcgrt/, given it or the .gev-data root above it."""
    p = Path(path)
    sub = p / "real" / "owid-oxcgrt"
    return sub if (sub / "meta.json").is_file() and not (p / "meta.json").is_file() else p


def load_real(path) -> RealData:
    """obs, actions, their masks, population and meta.json of real/owid-oxcgrt/.

    Masks become bool; values where a mask is 0 are NaN (whatever the file
    holds). Raises FormatError when the shapes or channel lists disagree.
    """
    p = real_dir(path)
    if not (p / "meta.json").is_file():
        raise FormatError(f"{p}: no meta.json")
    meta = read_json(p / "meta.json")
    files = {}
    for name in ("obs", "obs_mask", "actions", "actions_mask", "population"):
        f = p / f"{name}.npy"
        if not f.is_file():
            raise FormatError(f"{p}: missing {name}.npy")
        files[name] = load_npy(f)
    obs = np.asarray(files["obs"], dtype=np.float32)
    act = np.asarray(files["actions"], dtype=np.float32)
    om = np.asarray(files["obs_mask"]).astype(bool)
    am = np.asarray(files["actions_mask"]).astype(bool)
    pop = np.asarray(files["population"], dtype=np.float64)
    if obs.ndim != 3 or om.shape != obs.shape:
        raise FormatError(f"obs {obs.shape} / obs_mask {om.shape}: expected two [T, C, channels]")
    if act.ndim != 3 or act.shape[:2] != obs.shape[:2] or am.shape != act.shape:
        raise FormatError(f"actions {act.shape} / actions_mask {am.shape} do not match obs {obs.shape}")
    T, C = obs.shape[:2]
    if pop.shape != (C,):
        raise FormatError(f"population.npy: shape {pop.shape}, expected [{C}]")
    ch = meta.get("channels") if isinstance(meta.get("channels"), dict) else {}
    obs_ch = [str(x) for x in ch.get("obs") or F.REAL_OBS_CHANNELS]
    act_ch = [str(x) for x in ch.get("actions") or F.REAL_ACTION_CHANNELS]
    if len(obs_ch) != obs.shape[2] or len(act_ch) != act.shape[2]:
        raise FormatError(f"meta.json channels ({len(obs_ch)} obs, {len(act_ch)} actions) do not match "
                          f"the arrays ({obs.shape[2]}, {act.shape[2]})")
    countries = meta.get("countries")
    if not isinstance(countries, list) or len(countries) != C:
        raise FormatError(f"meta.json countries: expected a list of {C}")
    if isinstance(meta.get("days"), int) and meta["days"] != T:
        warnings.warn(f"{p}: meta.json days = {meta['days']} but the arrays have {T}")
    obs = np.where(om, np.nan_to_num(obs), np.nan).astype(np.float32)
    act = np.where(am, np.nan_to_num(act), np.nan).astype(np.float32)
    return RealData(path=p, meta=meta, obs=obs, obs_mask=om, actions=act, actions_mask=am, population=pop,
                    countries=[str(c) for c in countries], obs_channels=obs_ch, action_channels=act_ch)


def load_worldbank(data_root) -> dict:
    """{ISO2: float [4] shares (0-1): age0to14, age15to64, age65up, urban} from
    demographics/worldbank.json (the World Bank table, percentages); {} if absent."""
    f = Path(data_root) / "demographics" / "worldbank.json"
    if not f.is_file():
        return {}
    try:
        table = read_json(f)
    except (OSError, ValueError):
        return {}
    rows = table.get("byCountry") if isinstance(table, dict) else None
    out = {}
    for code, row in (rows or {}).items():
        if not isinstance(row, dict):
            continue
        vals = []
        for field_name in ("age0to14", "age15to64", "age65up", "urban"):
            v = row.get(field_name)
            vals.append(float(v) / 100.0 if isinstance(v, (int, float)) and np.isfinite(v) else np.nan)
        out[str(code)] = np.array(vals, dtype=np.float64)
    return out


# --------------------------------------------------------------------------
# Discovery under a .gev-data root
# --------------------------------------------------------------------------


def gev_paths(data_root) -> dict:
    """The documented directories under a .gev-data root."""
    r = Path(data_root)
    return {
        "worlds": r / "outbreak" / "worlds",
        "datasets": r / "outbreak" / "datasets",
        "tape": r / "tape",
        "bins": r / "bins",
        "models": r / "ai-world" / "models",
        "predictions": r / "ai-world" / "predictions",
        "real": r / "real" / "owid-oxcgrt",
        "demographics": r / "demographics",
    }


def list_worlds(data_root) -> list:
    """World snapshot directories, oldest first (by builtAt, then mtime)."""
    base = gev_paths(data_root)["worlds"]
    rows = []
    if base.is_dir():
        for p in base.iterdir():
            wj = p / "world.json"
            if wj.is_file():
                try:
                    built = read_json(wj).get("builtAt")
                except (OSError, json.JSONDecodeError):
                    built = None
                mtime = wj.stat().st_mtime * 1000
                rows.append((_sort_time(built, mtime), mtime, p.name, p))
    rows.sort()
    return [r[-1] for r in rows]


def find_world(data_root, world_id) -> Path | None:
    """outbreak/worlds/<worldId>/ when it exists (else a world whose json names it)."""
    if not world_id:
        return None
    p = gev_paths(data_root)["worlds"] / str(world_id)
    if (p / "world.json").is_file():
        return p
    for w in list_worlds(data_root):
        try:
            if read_json(w / "world.json").get("worldId") == world_id:
                return w
        except (OSError, json.JSONDecodeError):
            continue
    return None


def list_datasets(data_root, world_id=None) -> list:
    """Dataset directories (with a dataset.json), oldest first by mtime."""
    base = gev_paths(data_root)["datasets"]
    rows = []
    if base.is_dir():
        for p in base.iterdir():
            dj = p / "dataset.json"
            if not dj.is_file():
                continue
            if world_id is not None:
                try:
                    if read_json(dj).get("worldId") != world_id:
                        continue
                except (OSError, json.JSONDecodeError):
                    continue
            rows.append((dj.stat().st_mtime, p.name, p))
    rows.sort()
    return [r[-1] for r in rows]


def list_bin_worlds(data_root) -> list:
    """bins/<worldId> directories, oldest first by their latest day."""
    base = gev_paths(data_root)["bins"]
    rows = []
    if base.is_dir():
        for p in base.iterdir():
            if p.is_dir():
                days = list_bin_days(p)
                if days:
                    rows.append((days[-1], p.name, p))
    rows.sort()
    return [r[-1] for r in rows]


def dir_size(path) -> int:
    """Bytes under a directory (0 if missing)."""
    total = 0
    for dirpath, _dirs, files in os.walk(path):
        for f in files:
            try:
                total += os.path.getsize(os.path.join(dirpath, f))
            except OSError:
                pass
    return total
