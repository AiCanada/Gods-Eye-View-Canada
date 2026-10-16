"""Small synthetic data in the documented .gev-data formats.

For tests and smoke runs only: nothing here is real. It writes

- a world snapshot   outbreak/worlds/<worldId>/ (world.json + .npy files)
- a dataset          outbreak/datasets/<name>/ (dataset.json, README.md,
                     index.jsonl, shards/shard-<n>.tar.gz)
- tape               tape/<feed>/YYYY/MM/DD/HH.ndjson.gz + manifest.jsonl
- bins               bins/<worldId>/YYYY/MM/DD.<group>.npy + channels.json
- demographics       demographics/places-<worldId>.npy (+ .json) and
                     demographics/worldbank.json, optional
- real               real/owid-oxcgrt/ (obs, actions, masks, population,
                     meta.json), optional

exactly as docs/WORLD-MODEL-DATA.md lays them out. Episodes come from a
tiny daily stochastic metapopulation model (integer counts, binomial draws)
that keeps every invariant ml.gevtape.check tests: places sum into
countries, countries into the global channels, cumulative channels never
fall, and the two arms of a pair share row 0 (same random stream key).

CLI: python -m ml.gevtape.synth <out_root> [--scenarios N] [--runs N]
     [--days N] [--bin-days N] [--tape-hours N] [--seed N]
"""

from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import io
import json
import math
import shutil
import sys
import tarfile
import tempfile
from pathlib import Path

import numpy as np

from . import formats as F
from . import geo
from .reader import World, load_world, list_shards, day_parts, day_start_ms

# Licence texts (what `licences` holds); their class goes in `classes`.
SYNTH_LICENCE_TEXTS = ["ml/gevtape/synth.py synthetic data (CC0 1.0)"]
BUILT_AT = 1760000000000  # fixed, so the same seed gives the same bytes
# Travel is boosted so a 16-node toy world sees imports within days.
TRAVEL_BOOST = 20.0
# The documented bin groups and channels (docs/WORLD-MODEL-DATA.md, Bins).
DEFAULT_BIN_CHANNELS = {g: list(cols) for g, cols in F.BIN_CHANNELS.items()}

_S = {c: i for i, c in enumerate(F.STATE_CHANNELS)}
_Q = {c: i for i, c in enumerate(F.CUM_CHANNELS)}
_ACTIVE = [_S[c] for c in F.ACTIVE_COMPARTMENTS]


# --------------------------------------------------------------------------
# Byte helpers
# --------------------------------------------------------------------------


def npy_bytes(arr: np.ndarray) -> bytes:
    """An array as .npy (version 1.0) bytes."""
    buf = io.BytesIO()
    np.save(buf, np.ascontiguousarray(arr), allow_pickle=False)
    return buf.getvalue()


def write_npy(path, arr: np.ndarray) -> None:
    with open(path, "wb") as f:
        np.save(f, np.ascontiguousarray(arr), allow_pickle=False)


def write_json(path, obj) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, indent=1)
        f.write("\n")


def write_tar_gz(path, members) -> int:
    """Write [(name, bytes)] as a gzip'd ustar archive (fixed mtimes). Returns bytes written."""
    with open(path, "wb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as gz:
            with tarfile.open(fileobj=gz, mode="w", format=tarfile.USTAR_FORMAT) as tf:
                for name, data in members:
                    info = tarfile.TarInfo(name)
                    info.size = len(data)
                    info.mtime = 0
                    info.mode = 0o644
                    tf.addfile(info, io.BytesIO(data))
    return Path(path).stat().st_size


def read_tar_gz(path) -> list:
    """All members of a .tar.gz as [(name, bytes)], in order."""
    out = []
    with tarfile.open(path, mode="r|gz") as tf:
        for m in tf:
            if m.isfile():
                out.append((m.name, tf.extractfile(m).read()))
    return out


# --------------------------------------------------------------------------
# World
# --------------------------------------------------------------------------


def make_world(gev_root, *, n_nodes=16, countries=("AA", "BB", "CC"),
               n_tracked=6, seed=0, licences=None) -> Path:
    """Write a synthetic world under <gev_root>/outbreak/worlds/<worldId>/.

    Nodes are spread around one centre per country (the last node has no
    country when there are enough nodes); even nodes are airports. Routes
    join airports (air) and neighbours in a country (rail); commuting links
    join each node to its two nearest compatriots. Returns the directory.
    """
    rng = np.random.default_rng([seed, 1])
    cr = len(countries)
    C = cr + 1
    n = int(n_nodes)
    country = np.arange(n) % cr
    if n > 2 * cr:
        country[-1] = C - 1  # no country
    centre_lat = np.linspace(-35, 50, cr)
    centre_lon = np.linspace(-110, 120, cr)
    lat = np.where(country < cr, centre_lat[np.minimum(country, cr - 1)], 0.0) + rng.normal(0, 2.5, n)
    lon = np.where(country < cr, centre_lon[np.minimum(country, cr - 1)], -150.0) + rng.normal(0, 3.0, n)
    population = np.round(10 ** rng.uniform(4.6, 6.4, n))
    kind = np.where(np.arange(n) % 2 == 0, 0, 1)
    size = np.zeros(n)
    airports = np.flatnonzero(kind == 0)
    big = airports[np.argsort(-population[airports], kind="stable")][: max(1, len(airports) // 3)]
    size[airports] = 1
    size[big] = 2
    utc = np.round(lon / 15.0)
    order = sorted(range(n), key=lambda i: (-int(kind[i] == 0 and size[i] == 2), -population[i], i))
    tracked = np.array(order[: min(n_tracked, n)], dtype=np.int32)
    tracked_index = np.full(n, -1.0)
    tracked_index[tracked] = np.arange(len(tracked))
    nodes = np.stack([lat, lon, population, kind, size, country, utc, tracked_index], axis=1).astype(np.float64)

    routes = []
    for a in airports:  # each airport flies to three others, both ways
        others = [b for b in airports if b != a]
        for b in rng.choice(others, size=min(3, len(others)), replace=False):
            km = float(geo.haversine_km(lat[a], lon[a], lat[b], lon[b]))
            for f, t in ((a, b), (b, a)):
                routes.append([f, t, float(rng.integers(0, 96)) * 900000.0,
                               km / 800.0 * 3600000.0, float(rng.integers(80, 1500)), 0.0, km])
    for c in range(cr):  # rail between neighbours inside a country
        members = np.flatnonzero(country == c)
        for a, b in zip(members[:-1], members[1:]):
            km = float(geo.haversine_km(lat[a], lon[a], lat[b], lon[b]))
            for f, t in ((a, b), (b, a)):
                routes.append([f, t, 8 * 3600000.0, km / 160.0 * 3600000.0,
                               float(rng.integers(50, 600)), 1.0, km])
    routes = np.array(routes, dtype=np.float64).reshape(-1, len(F.ROUTE_COLUMNS))

    offsets, links_j, share = [0], [], []
    for i in range(n):
        same = [j for j in range(n) if j != i and country[j] == country[i]]
        same.sort(key=lambda j: float(geo.haversine_km(lat[i], lon[i], lat[j], lon[j])))
        for j in same[:2]:
            links_j.append(j)
            share.append(float(rng.uniform(0.01, 0.06)))
        offsets.append(len(links_j))

    node_ids = {"id": [f"syn{i:03d}" for i in range(n)],
                "code": [f"S{i:02d}" for i in range(n)],
                "name": [f"Synthetic place {i}" for i in range(n)]}
    worlds = Path(gev_root) / "outbreak" / "worlds"
    worlds.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=".tmp-world-", dir=worlds))
    write_npy(tmp / "nodes.npy", nodes)
    with open(tmp / "node_ids.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump(node_ids, f)
    write_npy(tmp / "routes.npy", routes)
    write_npy(tmp / "links_offsets.npy", np.array(offsets, dtype=np.int32))
    write_npy(tmp / "links_j.npy", np.array(links_j, dtype=np.int32))
    write_npy(tmp / "links_share.npy", np.array(share, dtype=np.float64))
    write_npy(tmp / "tracked.npy", tracked)
    country_list = list(countries) + [""]
    with open(tmp / "countries.json", "w", encoding="utf-8", newline="\n") as f:
        json.dump(country_list, f)
    # worldId as server/shared/outbreakWorldStore.mjs makes it: every file by
    # sorted name, each name hashed before its bytes.
    h = hashlib.sha256()
    for name in sorted(F.WORLD_FILES):
        h.update(name.encode("utf-8"))
        h.update((tmp / name).read_bytes())
    world_id = h.hexdigest()[:16]
    meta = {
        "schema": F.WORLD_SCHEMA,
        "worldId": world_id,
        "builtAt": "2025-10-09T08:53:20.000Z",
        "node": "synthetic",
        "v8": "",
        "counts": {"nodes": n, "routes": int(routes.shape[0]), "railRoutes": int((routes[:, 5] == 1).sum()),
                   "links": len(links_j), "tracked": int(len(tracked)), "countries": C},
        "countries": country_list,
        "tracked": int(len(tracked)),
        "sources": [{"file": "synthetic", "sha256": "0" * 64, "bytes": 0}],
        "rail": {"builtAt": BUILT_AT, "version": 0, "speedKmh": 160},
        "railSource": "synthetic",
        "licences": licences if licences is not None else SYNTH_LICENCE_TEXTS,
        "classes": ["open"],
    }
    write_json(tmp / "world.json", meta)
    final = worlds / world_id
    if final.exists():
        shutil.rmtree(tmp)
    else:
        tmp.rename(final)
    return final


# --------------------------------------------------------------------------
# Episodes
# --------------------------------------------------------------------------


def sample_scenario(k: int, *, seed: int, world: World, days: int) -> dict:
    """Scenario k of a synthetic sweep (depends only on seed and k)."""
    rng = np.random.default_rng([seed, k, 77])
    two = (k % 3) == 2
    profile = {
        "r0": float(rng.uniform(2.5, 4.5)),
        "latentDays": float(rng.uniform(2.0, 4.0)),
        "presymDays": 1.5,
        "infectiousDays": float(rng.uniform(4.0, 7.0)),
        "asymptomaticPct": float(rng.uniform(20, 50)),
        "hospitalPct": float(rng.uniform(3, 9)),
        "icuPct": 20.0,
        "fatalityPct": float(rng.uniform(5, 15)),
        "hospitalDays": 6.0,
        "ascertainPct": float(rng.uniform(25, 60)),
        "vaccinatedPct": float(rng.choice([0.0, 10.0])),
        "initialCases": int(rng.integers(20, 150)),
        "variants": "two-strain" if two else None,
        "strain2Day": int(max(1, days // 2)),
        "strain2Cases": 5,
        "strain2Pct": 130,
        "crossImmunityPct": 50,
    }
    interventions = {
        "perPlace": True,
        "startDay": int(rng.integers(0, max(1, days // 3))),
        "lockdown": float(rng.uniform(0.4, 0.8)),
        "travelBan": 0.5,
        "tracingIsolate": 0.3,
        "tracingPresym": 0.1,
        "exitScreening": True,
        "entryScreening": False,
        "quarantineCatch": 0.2,
        "importDetect": 0.2,
        "triggerReported": int(rng.integers(2, 10)),
        "borderPolicy": "reported",
        "borderTrigger": 15,
        "vaccine": ({"startDay": 1, "perDay": 20.0, "coverageMax": 0.6,
                     "efficacy": 0.8, "protectDays": 0} if k % 2 == 0 else None),
    }
    pool = [int(i) for i in world.tracked]
    count = 1 + int(rng.integers(0, 2))
    origins = sorted({int(x) for x in rng.choice(pool, size=min(count, len(pool)), replace=False)})
    start_ms = day_start_ms(dt.date(2026, 1, 1)) + int(rng.integers(0, 365)) * 86400000
    return {"index": k, "seed": int(seed), "preset": "synthetic", "policy": "rules",
            "compare": "all", "profile": profile, "interventions": interventions,
            "origins": origins, "startMs": start_ms,
            "untilMs": start_ms + days * 86400000, "policySeed": int(rng.integers(0, 2**32))}


def _binom(rng, n, p) -> np.ndarray:
    n = np.maximum(np.asarray(n, dtype=np.int64), 0)
    p = np.clip(np.nan_to_num(np.asarray(p, dtype=np.float64)), 0.0, 1.0)
    return np.asarray(rng.binomial(n, np.broadcast_to(p, n.shape)), dtype=np.int64)


def _popcount(x: int) -> int:
    return bin(int(x) & 0xFFFFFFFF).count("1")


def simulate_episode(world: World, scenario: dict, *, run: int, arm: str, days: int):
    """One run of one arm: (episode json dict without 'key'/'arrays', arrays dict).

    Arm 'A' runs the scenario's measures; arm 'B' (the comparison, 'all')
    runs none of them. Both draw from the stream keyed by (seed, scenario,
    run), so they agree on row 0. Daily steps; every count is an integer and
    each node keeps its population.
    """
    sc, prof, iv = scenario, scenario["profile"], scenario["interventions"]
    T, n, C, K = int(days), world.n, world.C, world.K
    tracked = world.tracked
    cn = world.country_of_node
    N = np.round(world.population).astype(np.int64)
    Nf = np.maximum(N, 1).astype(np.float64)
    measures = arm == "A"
    rng = np.random.default_rng([sc["seed"], sc["index"], run])

    X = np.zeros((n, len(F.STATE_CHANNELS)), np.int64)
    Q = np.zeros((n, len(F.CUM_CHANNELS)), np.int64)
    S0 = np.round(N * (1 - prof["vaccinatedPct"] / 100.0)).astype(np.int64)
    X[:, _S["S"]] = S0
    X[:, _S["R"]] = N - S0
    X[:, _S["Rx"]] = N - S0
    arrived = np.full(n, np.inf)
    first_by = np.zeros(n, np.int64)
    for o in sc["origins"]:
        m = min(int(prof["initialCases"]), int(X[o, _S["S"]]))
        X[o, _S["S"]] -= m
        X[o, _S["E"]] += m
        Q[o, _Q["infected"]] += m
        arrived[o], first_by[o] = 0, 1
    beds = np.maximum(2, np.round(N * 3e-4)).astype(np.int64)
    switch = np.zeros(n, np.int64)
    on_since = np.full(n, -1, np.int64)
    flagged = np.zeros(C, np.int64)
    border = np.zeros(C, np.int64)
    first_report = np.full(n, np.inf)
    first_death = np.full(n, np.inf)
    first_ten = np.full(n, np.inf)
    overflow = np.full(n, np.inf)
    first_ten[Q[:, _Q["infected"]] >= 10] = 0
    icu_admitted = 0
    reports_today = np.zeros(n, np.int64)
    lock_eff = np.zeros(n)

    g = np.zeros((T + 1, len(F.GLOBAL_CHANNELS)), np.float64)
    cs = np.zeros((T + 1, C, len(F.STATE_CHANNELS)), np.int64)
    cc = np.zeros((T + 1, C, len(F.CUM_CHANNELS)), np.int64)
    ps = np.zeros((T + 1, K, len(F.STATE_CHANNELS)), np.int64)
    pc = np.zeros((T + 1, K, len(F.CUM_CHANNELS)), np.int64)
    pa = np.zeros((T + 1, K, len(F.AUX_CHANNELS)), np.float32)
    ag = np.zeros((T, len(F.GLOBAL_ACTIONS)), np.float32)
    ac = np.zeros((T, C, len(F.COUNTRY_ACTIONS)), np.float32)
    ap = np.zeros((T, K, len(F.PLACE_ACTIONS)), np.float32)
    cw = np.zeros(T, np.uint32)
    switch_rows, flag_rows, flow_rows, events = [], [], [], []

    def record(r):
        ps[r], pc[r] = X[tracked], Q[tracked]
        np.add.at(cs[r], cn, X)
        np.add.at(cc[r], cn, Q)
        caution = np.minimum(1.0, Q[:, _Q["reported"]] / Nf * 1e4)
        lock = iv["lockdown"] * switch if measures else np.zeros(n)
        pa[r] = np.stack([switch, np.where(switch == 1, 0.9, 1.0), caution, lock * caution,
                          reports_today, (X[:, _S["H"]] > beds).astype(float)], axis=1)[tracked]
        H, U = X[:, _S["H"]], X[:, _S["U"]]
        g[r] = [Q[:, _Q["infected"]].sum(), Q[:, _Q["reported"]].sum(), X[:, _S["D"]].sum(),
                H.sum(), U.sum(), Q[:, _Q["admitted"]].sum(), N[switch == 1].sum(),
                X[:, _S["V"]].sum(), border[: C - 1].sum(), Q[:, _Q["imported"]].sum(),
                Q[:, _Q["reinfected"]].sum(), float((N * lock_eff).sum() / Nf.sum()),
                np.maximum(0, H - beds).sum(), switch.sum(), icu_admitted,
                Q[:, _Q["infected2"]].sum(), 0, 0, 0,
                Q[:, _Q["reported"]].sum() / Nf.sum() * 1e5]

    record(0)
    routes = world.routes
    beta = prof["r0"] / prof["infectiousDays"]
    rel2 = prof["strain2Pct"] / 100.0
    cross = prof["crossImmunityPct"] / 100.0
    two = prof["variants"] == "two-strain"
    seeded2 = False
    vac = iv["vaccine"] if measures else None
    for d in range(T):
        # ---- the day's control (decided on the state at row d)
        window_open = measures and d >= iv["startDay"]
        mask = 0xFFFFFF if window_open else 0
        active = X[:, _ACTIVE].sum(axis=1)
        if window_open:
            turn_on = (switch == 0) & (Q[:, _Q["reported"]] >= iv["triggerReported"]) & (active > 0)
            turn_off = (switch == 1) & (d - on_since >= 3) & (active == 0)
        else:
            turn_on = np.zeros(n, bool)
            turn_off = switch == 1
        for i in np.flatnonzero(turn_on | turn_off):
            switch[i] = 1 if turn_on[i] else 0
            on_since[i] = d if turn_on[i] else -1
            switch_rows.append((d, int(i), int(switch[i])))
            events.append((24 * d, int(i), 5 if switch[i] else 6, 0))
        crep = np.bincount(cn, weights=Q[:, _Q["reported"]], minlength=C)
        newf = (crep >= iv["borderTrigger"]) & (flagged == 0)
        newf[C - 1] = False
        for c in np.flatnonzero(newf):
            flagged[c] = 1
            flag_rows.append((d, int(c)))
            events.append((24 * d, -1, F.EVENT_COUNTRY_FLAGGED, int(c)))
        border = flagged.copy() if measures else np.zeros(C, np.int64)
        # ---- the day's decisions as features
        share = _popcount(mask) / 24.0
        cw[d] = mask
        ag[d] = [share, iv["tracingIsolate"] * share if measures else 0,
                 iv["tracingPresym"] * share if measures else 0,
                 share if (measures and iv["exitScreening"]) else 0,
                 share if (measures and iv["entryScreening"]) else 0,
                 iv["quarantineCatch"] * share if measures else 0,
                 iv["importDetect"] if measures else 0, 0, 0]
        ac[d, :, 0] = border
        ac[d, :, 1] = flagged
        lock = iv["lockdown"] * switch if measures else np.zeros(n)
        ban = iv["travelBan"] * switch if measures else np.zeros(n)
        if vac is not None:
            cover = min(vac["coverageMax"], vac["perDay"] / 1000.0 * max(0, d - vac["protectDays"] - vac["startDay"]))
            target = np.round(N * vac["efficacy"] * cover).astype(np.int64)
        else:
            target = np.zeros(n, np.int64)
        ap[d] = np.stack([lock, ban, target / Nf], axis=1)[tracked]
        # ---- the campaign
        move = np.clip(target - X[:, _S["V"]], 0, X[:, _S["S"]])
        X[:, _S["S"]] -= move
        X[:, _S["R"]] += move
        X[:, _S["Rx"]] += move
        X[:, _S["V"]] += move
        # ---- infection (prevalence mixed over commuting links)
        lock_eff = lock * 0.9
        prev1 = (X[:, _S["P"]] + X[:, _S["Is"]] + 0.5 * X[:, _S["Ia"]]) / Nf
        prev2 = rel2 * (X[:, _S["P2"]] + X[:, _S["Is2"]] + 0.5 * X[:, _S["Ia2"]]) / Nf
        mix1, mix2 = prev1.copy(), prev2.copy()
        for i in range(n):
            js, sh = world.links_of(i)
            if len(js):
                keep = 1.0 - sh.sum()
                mix1[i] = keep * prev1[i] + (sh * prev1[js]).sum()
                mix2[i] = keep * prev2[i] + (sh * prev2[js]).sum()
        damp = (1.0 - lock_eff) * (1.0 - 0.5 * ag[d, 1])
        lam1, lam2 = beta * mix1 * damp, beta * mix2 * damp
        lam = lam1 + lam2
        new = _binom(rng, X[:, _S["S"]], 1 - np.exp(-lam))
        new2 = _binom(rng, new, np.divide(lam2, lam, out=np.zeros(n), where=lam > 0))
        X[:, _S["S"]] -= new
        X[:, _S["E"]] += new - new2
        X[:, _S["E2"]] += new2
        Q[:, _Q["infected"]] += new
        Q[:, _Q["local"]] += new
        Q[:, _Q["infected2"]] += new2
        fresh_here = (new > 0) & ~np.isfinite(arrived)
        arrived[fresh_here], first_by[fresh_here] = 24 * d + 6, 3
        if two and seeded2:
            esc = _binom(rng, X[:, _S["Rx"]], 1 - np.exp(-(1 - cross) * lam2))
            for col in ("Rx", "R"):
                X[:, _S[col]] -= esc
            X[:, _S["E2"]] += esc
            for col in ("infected", "infected2", "reinfected", "local"):
                Q[:, _Q[col]] += esc
        if two and not seeded2 and d == prof["strain2Day"]:
            o = sc["origins"][0]
            m = min(int(prof["strain2Cases"]), int(X[o, _S["S"]]))
            X[o, _S["S"]] -= m
            X[o, _S["E2"]] += m
            Q[o, _Q["infected"]] += m
            Q[o, _Q["infected2"]] += m
            seeded2 = True
            events.append((24 * d, -1, 8, 0))
        # ---- progression (both strains share wards and deaths)
        reports_today = np.zeros(n, np.int64)
        for sfx in ("", "2"):
            e_out = _binom(rng, X[:, _S["E" + sfx]], 1 - math.exp(-1 / prof["latentDays"]))
            X[:, _S["E" + sfx]] -= e_out
            X[:, _S["P" + sfx]] += e_out
            p_out = _binom(rng, X[:, _S["P" + sfx]], 1 - math.exp(-1 / prof["presymDays"]))
            sym = _binom(rng, p_out, 1 - prof["asymptomaticPct"] / 100.0)
            X[:, _S["P" + sfx]] -= p_out
            X[:, _S["Is" + sfx]] += sym
            X[:, _S["Ia" + sfx]] += p_out - sym
            rep = _binom(rng, sym, prof["ascertainPct"] / 100.0)
            reports_today += rep
            Q[:, _Q["reported"]] += rep
            gamma = 1 - math.exp(-1 / prof["infectiousDays"])
            is_out = _binom(rng, X[:, _S["Is" + sfx]], gamma)
            adm = _binom(rng, is_out, prof["hospitalPct"] / 100.0)
            icu = _binom(rng, adm, prof["icuPct"] / 100.0)
            X[:, _S["Is" + sfx]] -= is_out
            X[:, _S["H"]] += adm - icu
            X[:, _S["U"]] += icu
            X[:, _S["R"]] += is_out - adm
            if sfx == "":
                X[:, _S["Rx"]] += is_out - adm
            Q[:, _Q["admitted"]] += adm
            icu_admitted += int(icu.sum())
            ia_out = _binom(rng, X[:, _S["Ia" + sfx]], gamma)
            X[:, _S["Ia" + sfx]] -= ia_out
            X[:, _S["R"]] += ia_out
            if sfx == "":
                X[:, _S["Rx"]] += ia_out
        for col, days_in, fat in (("H", prof["hospitalDays"], prof["fatalityPct"] / 100.0),
                                  ("U", 10.0, min(1.0, 3 * prof["fatalityPct"] / 100.0))):
            out = _binom(rng, X[:, _S[col]], 1 - math.exp(-1 / days_in))
            died = _binom(rng, out, fat)
            X[:, _S[col]] -= out
            X[:, _S["D"]] += died
            X[:, _S["R"]] += out - died
            X[:, _S["Rx"]] += out - died
        # ---- travel: latent travellers swap places with susceptibles
        for f, t, pax, mode in zip(routes[:, 0].astype(int), routes[:, 1].astype(int), routes[:, 4], routes[:, 5]):
            closed = 0.9 if (border[cn[f]] or border[cn[t]]) and cn[f] != cn[t] else 0.0
            allowed = pax * (1 - ban[f]) * (1 - ban[t]) * (1 - closed)
            k = int(_binom(rng, X[f, _S["E"]], min(1.0, TRAVEL_BOOST * allowed / Nf[f])))
            k = min(k, int(X[t, _S["S"]]))
            if k <= 0:
                continue
            X[f, _S["E"]] -= k
            X[t, _S["E"]] += k
            X[t, _S["S"]] -= k
            X[f, _S["S"]] += k
            Q[t, _Q["imported"]] += k
            flow_rows.append((d, int(f), int(t), int(mode), 0, k))
            flow_rows.append((d, int(f), int(t), int(mode), 3, k))
            if not np.isfinite(arrived[t]):
                arrived[t], first_by[t] = 24 * d + 12, 3 if mode == 1 else 2
        # ---- first events of the day
        hour = 24 * d
        first_report[(Q[:, _Q["reported"]] > 0) & ~np.isfinite(first_report)] = hour + 18
        first_death[(X[:, _S["D"]] > 0) & ~np.isfinite(first_death)] = hour + 20
        first_ten[(Q[:, _Q["infected"]] >= 10) & ~np.isfinite(first_ten)] = hour + 16
        overflow[(X[:, _S["H"]] > beds) & ~np.isfinite(overflow)] = hour + 21
        record(d + 1)

    for i in range(n):
        for stamps, kind in ((arrived, 0), (first_report, 1), (first_death, 2), (first_ten, 3), (overflow, 4)):
            if np.isfinite(stamps[i]):
                events.append((int(stamps[i]), i, kind, int(first_by[i]) if kind == 0 else 0))
    events.sort(key=lambda e: (e[0], e[2], e[1]))
    new_inf = np.diff(g[:, 0])
    labels = {
        "extinct": bool(X[:, _ACTIVE].sum() == 0),
        "infected": float(g[T, 0]), "deaths": float(g[T, 2]), "reported": float(g[T, 1]),
        "peakDay": int(np.argmax(new_inf)) if T else 0,
        "peakNew": float(new_inf.max()) if T else 0.0,
        "peakWard": float(g[1:, 3].max()) if T else 0.0,
        "reached": int(np.isfinite(arrived).sum()),
        "countriesReached": int(len(set(cn[np.isfinite(arrived)].tolist()))),
        "switches": len(switch_rows), "flags": len(flag_rows),
    }
    constants = {
        "perPlace": True, "borderPolicy": "reported" if measures else "none",
        "startHour": 24 * iv["startDay"] if measures else None, "endHour": None,
        "lockdown": iv["lockdown"] if measures else 0, "travelBan": iv["travelBan"] if measures else 0,
        "tracingIsolate": iv["tracingIsolate"] if measures else 0,
        "tracingPresym": iv["tracingPresym"] if measures else 0,
        "exitScreening": bool(measures and iv["exitScreening"]),
        "entryScreening": bool(measures and iv["entryScreening"]),
        "quarantineCatch": iv["quarantineCatch"] if measures else 0,
        "importDetect": iv["importDetect"] if measures else 0,
        "testsPer1000Day": 0, "vaccine": vac,
    }
    arrays = {
        "global": g,
        "country_state": cs.astype(np.uint32), "country_cum": cc.astype(np.uint32),
        "place_state": ps.astype(np.uint32), "place_cum": pc.astype(np.uint32),
        "place_aux": pa.astype(np.float32),
        "actions_global": ag, "actions_country": ac, "actions_place": ap,
        "controls_window": cw,
        "controls_switch": np.array(switch_rows, dtype=np.int32).reshape(-1, 3),
        "controls_flags": np.array(flag_rows, dtype=np.int32).reshape(-1, 2),
        "flows": np.array(flow_rows, dtype=np.int32).reshape(-1, 6),
        "events": np.array(events, dtype=np.int32).reshape(-1, 4),
    }
    meta = {
        "schema": F.EPISODE_SCHEMA, "run": run, "days": T, "hours": 24 * T, "places": K, "countries": C,
        "scenario": sc["index"], "arm": arm, "worldId": world.world_id, "preset": sc["preset"],
        "policy": sc["policy"], "compare": sc["compare"] if arm == "B" else None,
        "profile": sc["profile"], "origins": sc["origins"], "startMs": sc["startMs"],
        "untilMs": sc["untilMs"], "streamKey": [sc["seed"], sc["index"]], "policySeed": sc["policySeed"],
        "labels": labels, "constants": constants,
    }
    return meta, arrays


def episode_members(key: str, meta: dict, arrays: dict) -> list:
    """<key>.json (with each array's shape and dtype) then <key>.<array>.npy."""
    shapes = {name: {"shape": list(a.shape), "dtype": a.dtype.str} for name, a in arrays.items()}
    js = json.dumps({"key": key, **meta, "arrays": shapes}).encode("utf-8")
    return [(f"{key}.json", js)] + [(f"{key}.{name}.npy", npy_bytes(arrays[name]))
                                    for name in F.EPISODE_ARRAYS if name in arrays]


def write_dataset(gev_root, name: str, world_dir, *, scenarios=3, runs=2, days=12,
                  pair_every=1, episodes_per_shard=5, seed=0, classes=("open",)) -> Path:
    """Write outbreak/datasets/<name>/ for the world at world_dir.

    Scenario s gets an arm B when s % pair_every == 0. Episodes are packed
    into shards of `episodes_per_shard` in key order, so the two arms of a
    pair can land in different shards (as they may in real data).
    """
    world = load_world(world_dir)
    out = Path(gev_root) / "outbreak" / "datasets" / name
    (out / "shards").mkdir(parents=True, exist_ok=True)
    episodes = []
    for s in range(scenarios):
        sc = sample_scenario(s, seed=seed, world=world, days=days)
        arms = ("A", "B") if (pair_every and s % pair_every == 0) else ("A",)
        for r in range(runs):
            for arm in arms:
                key = f"s{s:06d}-r{r:02d}-{arm}"
                meta, arrays = simulate_episode(world, sc, run=r, arm=arm, days=days)
                episodes.append((key, sc, arm, len(arms) == 2, meta, arrays))
    index_lines, total_bytes, shard = [], 0, 0
    for start in range(0, len(episodes), episodes_per_shard):
        chunk = episodes[start: start + episodes_per_shard]
        members = []
        for key, sc, arm, paired, meta, arrays in chunk:
            s, r = sc["index"], meta["run"]
            meta["pair"] = key.rsplit("-", 1)[0]  # the scenario-run id both arms share
            index_lines.append({
                "key": key, "shard": shard, "scenario": s, "run": r, "arm": arm, "pair": meta["pair"],
                "worldId": world.world_id, "preset": sc["preset"], "policy": sc["policy"],
                "compare": sc["compare"] if paired else None, "labels": meta["labels"],
            })
            members.extend(episode_members(key, meta, arrays))
        total_bytes += write_tar_gz(out / "shards" / f"shard-{shard:06d}.tar.gz", members)
        shard += 1
    with open(out / "index.jsonl", "w", encoding="utf-8", newline="\n") as f:
        for line in index_lines:
            f.write(json.dumps(line) + "\n")
    write_json(out / "dataset.json", {
        "schema": F.DATASET_SCHEMA,
        "name": name,
        "worldId": world.world_id,
        "places": world.K,
        "spec": {"seed": seed, "scenarios": scenarios, "runs": runs, "days": days,
                 "perShard": episodes_per_shard,
                 "compareShare": (1.0 / pair_every) if pair_every else 0.0, "policyMix": [1, 0, 0]},
        "channels": {
            "STATE_CHANNELS": list(F.STATE_CHANNELS), "CUM_CHANNELS": list(F.CUM_CHANNELS),
            "AUX_CHANNELS": list(F.AUX_CHANNELS), "GLOBAL_CHANNELS": list(F.GLOBAL_CHANNELS),
            "GLOBAL_ACTIONS": list(F.GLOBAL_ACTIONS), "COUNTRY_ACTIONS": list(F.COUNTRY_ACTIONS),
            "PLACE_ACTIONS": list(F.PLACE_ACTIONS), "FLOW_KINDS": list(F.FLOW_KIND_IDS),
            "FLOW_MODES": list(F.FLOW_MODE_IDS), "EVENT_KINDS": list(F.EVENT_KIND_IDS),
        },
        "generator": {"package": "synthetic", "commit": "0" * 40, "engineSha256": "0" * 64,
                      "node": "synthetic", "v8": ""},
        "counts": {"scenarios": scenarios, "shards": shard, "episodes": len(episodes), "bytes": total_bytes},
        "licences": list(SYNTH_LICENCE_TEXTS),
        "classes": list(classes),
    })
    with open(out / "README.md", "w", encoding="utf-8", newline="\n") as f:
        f.write(f"# {name}\n\nSynthetic episodes from ml/gevtape/synth.py (not real data): "
                f"{scenarios} scenarios x {runs} runs, {days} days, world {world.world_id}.\n")
    return out


def modify_episode(dataset_dir, key: str, fn) -> None:
    """Rewrite the shard holding `key`, after fn(meta, arrays) changes them in place.

    For tests that need a corrupted dataset.
    """
    for shard in list_shards(dataset_dir):
        members = read_tar_gz(shard)
        names = [m[0] for m in members]
        if f"{key}.json" not in names:
            continue
        meta = json.loads(dict(members)[f"{key}.json"].decode("utf-8"))
        arrays = {}
        for name, data in members:
            if name.startswith(key + ".") and name.endswith(".npy"):
                arrays[name[len(key) + 1: -4]] = np.load(io.BytesIO(data), allow_pickle=False)
        fn(meta, arrays)
        out = []
        for name, data in members:
            if name == f"{key}.json":
                out.append((name, json.dumps(meta).encode("utf-8")))
            elif name.startswith(key + ".") and name.endswith(".npy"):
                arr_name = name[len(key) + 1: -4]
                if arr_name in arrays:
                    out.append((name, npy_bytes(arrays[arr_name])))
            else:
                out.append((name, data))
        # Arrays fn added become new members, right after the episode's own
        # (a shard keeps an episode's members together).
        present = {name[len(key) + 1: -4] for name in names if name.startswith(key + ".") and name.endswith(".npy")}
        added = [(f"{key}.{arr_name}.npy", npy_bytes(arr)) for arr_name, arr in arrays.items()
                 if arr_name not in present]
        if added:
            last = max(k for k, (name, _) in enumerate(out) if name.startswith(key + "."))
            out[last + 1:last + 1] = added
        write_tar_gz(shard, out)
        return
    raise KeyError(key)


# --------------------------------------------------------------------------
# Bins
# --------------------------------------------------------------------------


def _bin_values(name, rng, base, cyc, lat, weekday):
    """One synthetic channel [24, K]: a daily cycle on each place's local clock plus noise."""
    shape = cyc.shape
    count = lambda scale: np.maximum(0, scale * base * (0.15 + cyc) * weekday + rng.normal(0, 0.4, shape))  # noqa: E731
    if name in ("aircraft", "vessels", "transitVehicles", "transitBuses", "railVehicles", "segments"):
        return count({"aircraft": 1.0, "vessels": 0.3, "transitVehicles": 0.6, "transitBuses": 0.4,
                      "railVehicles": 0.2, "segments": 0.5}[name])
    if name in ("aircraftOnGround", "aircraftDepartures"):
        return count({"aircraftOnGround": 0.3, "aircraftDepartures": 0.1}[name])
    if name == "bikesAvailable":
        return np.maximum(0, base * (1.2 - cyc) + rng.normal(0, 0.5, shape))
    if name in ("transitMeanSpeed", "railMeanSpeed"):
        return np.maximum(0, (25 if name == "transitMeanSpeed" else 70) * (1.1 - 0.3 * cyc) + rng.normal(0, 1, shape))
    if name == "speedRatio":
        return np.clip(1.0 - 0.4 * cyc + rng.normal(0, 0.03, shape), 0, 1.2)
    if name == "t2m":
        return 18 - np.abs(lat)[None, :] / 3 + 6 * np.sin(2 * np.pi * (cyc - 0.5)) + rng.normal(0, 0.5, shape)
    if name == "humidity":
        return np.clip(70 - 20 * cyc + rng.normal(0, 3, shape), 0, 100)
    if name == "precip":
        return np.maximum(0, rng.normal(-0.2, 0.4, shape))
    if name in ("u10", "v10"):
        return 3 * np.sin(2 * np.pi * cyc) + rng.normal(0, 1, shape)
    if name == "mslp":
        return 1013 + 4 * np.cos(2 * np.pi * cyc) + rng.normal(0, 0.5, shape)
    if name == "quakes":
        return rng.poisson(0.05, shape).astype(float)
    if name == "quakeMaxMag":
        return np.where(rng.random(shape) < 0.05, rng.uniform(2, 5, shape), 0.0)
    if name in ("fireDetections", "fireRadiativePower"):
        n = rng.poisson(0.1 + 0.3 * cyc).astype(float)
        return n if name == "fireDetections" else n * rng.uniform(5, 50, shape)
    if name == "perimeterAcres":
        return np.where(rng.random(shape) < 0.02, rng.uniform(10, 1000, shape), 0.0)
    if name == "cycloneDistanceKm":
        return np.full(shape, 2000.0) + rng.normal(0, 10, shape)
    if name == "articles":
        return rng.poisson(1 + 4 * cyc).astype(float)
    return np.maximum(0, base * cyc + rng.normal(0, 0.5, shape))


# Hubs for the synthetic market assets, as assets.json carries them
# (src/marketAssets.mjs); crypto has none.
SYNTH_ASSET_HUBS = {
    "crude": {"label": "WTI crude", "group": "commodity", "unit": "usd",
              "hub": {"name": "Cushing, Oklahoma", "lat": 35.9851, "lon": -96.767}},
    "gold": {"label": "Gold", "group": "commodity", "unit": "usd",
             "hub": {"name": "London", "lat": 51.5136, "lon": -0.089}},
    "tsx": {"label": "S&P/TSX Composite", "group": "equity", "unit": "points",
            "hub": {"name": "Toronto", "lat": 43.6481, "lon": -79.3815}},
    "bitcoin": {"label": "Bitcoin", "group": "crypto", "unit": "usd", "hub": None},
}


def write_bins(gev_root, world_dir, *, start=dt.date(2026, 10, 1), days=4, seed=0,
               gaps=((1, 5, 9),), channels=None, classes=None, day_classes=True, markets=None) -> Path:
    """Write bins/<worldId>/YYYY/MM/DD.<group>.npy for `days` days plus channels.json.

    The documented groups and channels by default. Values follow each place's
    local clock (a learnable daily cycle) with noise. `gaps` are (day index,
    first hour, end hour) spans where nothing was observed (NaN everywhere);
    traffic is also not ticked for half the places on day 0. channels.json is
    {group: [channels]} as scripts/world-tape-bin.mjs writes it; `classes`, if
    given, is added as "licences". With day_classes, each day also gets
    DD.classes.json ({group: [classes seen]}), as newer writers do. `markets`
    (asset ids) adds a `markets` group: each asset's price a random walk, the
    same number at every place as the real bins copy it, plus assets.json.
    """
    world = load_world(world_dir)
    channels = channels or DEFAULT_BIN_CHANNELS
    rng = np.random.default_rng([seed, 3])
    K = world.K
    lat = world.lat[world.tracked]
    utc = np.nan_to_num(world.utc_offset[world.tracked])
    base = 10 ** rng.uniform(1, 2.5, K)
    root = Path(gev_root) / "bins" / world.world_id
    root.mkdir(parents=True, exist_ok=True)
    channels = dict(channels)
    prices = None
    if markets:
        channels["markets"] = list(markets)
        walk = rng.normal(0, 0.003, (days * 24, len(markets)))
        prices = 100 * np.exp(np.cumsum(walk, axis=0))
        write_json(root / "assets.json", {a: SYNTH_ASSET_HUBS.get(a, {"label": a, "hub": None}) for a in markets})
    doc = {g: list(cols) for g, cols in channels.items()}
    if classes:
        doc["licences"] = list(classes)
    write_json(root / "channels.json", doc)
    for di in range(days):
        day = start + dt.timedelta(days=di)
        y, m, d = day_parts(day)
        (root / y / m).mkdir(parents=True, exist_ok=True)
        local = (np.arange(24)[:, None] + utc[None, :]) % 24
        cyc = 0.5 + 0.5 * np.sin(2 * np.pi * (local - 9) / 24)  # [24, K], peaks mid-afternoon
        weekday = 1.0 + 0.1 * math.sin(2 * math.pi * day.weekday() / 7)
        for group, cols in channels.items():
            if group == "markets":
                arr = np.repeat(prices[di * 24:(di + 1) * 24, None, :], K, axis=1).astype(np.float32)
            else:
                arr = np.stack([_bin_values(c, rng, base, cyc, lat, weekday) for c in cols], axis=-1).astype(np.float32)
            for gd, h0, h1 in gaps:
                if gd == di:
                    arr[h0:h1] = np.nan
            if group == "traffic" and di == 0:
                arr[:, K // 2:, :] = np.nan
            write_npy(root / y / m / f"{d}.{group}.npy", arr)
        if day_classes:
            write_json(root / y / m / f"{d}.classes.json",
                       {g: (["nc"] if g in ("mobility", "news") else ["open"]) for g in channels})
    return root


def write_demographics(gev_root, world_dir, *, seed=0) -> Path:
    """Write demographics/places-<worldId>.npy (+ .json) like server/shared/demographicsStore.mjs.

    float32 [n, 5]: log10 population, then four shares in 0-1 drawn per
    country (NaN for the places with no country).
    """
    world = load_world(world_dir)
    rng = np.random.default_rng([seed, 9])
    out = Path(gev_root) / "demographics"
    out.mkdir(parents=True, exist_ok=True)
    young = rng.uniform(0.12, 0.42, world.C)
    old = rng.uniform(0.03, 0.22, world.C)
    urban = rng.uniform(0.3, 0.95, world.C)
    c = world.country_of_node
    arr = np.stack([np.log10(np.maximum(world.population, 1)), young[c], 1 - young[c] - old[c], old[c], urban[c]],
                   axis=1).astype(np.float32)
    arr[c == world.C - 1, 1:] = np.nan
    write_npy(out / f"places-{world.world_id}.npy", arr)
    write_json(out / f"places-{world.world_id}.json", {
        "worldId": world.world_id,
        "channels": ["log10Population", "age0to14", "age15to64", "age65up", "urban"],
        "licence": "synthetic (CC0 1.0)"})
    by_country = {code: {"age0to14": round(100 * float(young[i]), 2),
                         "age15to64": round(100 * float(1 - young[i] - old[i]), 2),
                         "age65up": round(100 * float(old[i]), 2), "urban": round(100 * float(urban[i]), 2),
                         "years": {}}
                  for i, code in enumerate(world.countries) if code}
    write_json(out / "worldbank.json", {"source": "synthetic (CC0 1.0)", "byCountry": by_country,
                                        "fetchedAt": BUILT_AT})
    return out


# --------------------------------------------------------------------------
# Real epidemics and policy (real/owid-oxcgrt/)
# --------------------------------------------------------------------------


def write_real(gev_root, *, countries=("AA", "BB", "CC", "DD", "PN"), days=120, seed=0,
               start=dt.date(2020, 1, 1)) -> Path:
    """Write real/owid-oxcgrt/ in the documented layout from a toy epidemic (not real data).

    Per country: a log-incidence walk that lockdowns bend down, weekly
    reporting noise, deaths and admissions lagging cases. Gaps as in the
    real set: hospital / ICU reported by two countries only, tests and
    vaccinations by some, a few missing case days, actions observed ~90 %;
    the last country has no population (NaN). Unobserved values are NaN.
    """
    rng = np.random.default_rng([seed, 17])
    T, C = int(days), len(countries)
    pop = np.round(10 ** rng.uniform(5.5, 7.5, C))
    pop[-1] = np.nan
    t = np.arange(T)
    obs = np.zeros((T, C, 6), np.float32)
    act = np.zeros((T, C, 5), np.float32)
    for c in range(C):
        p = pop[c] if np.isfinite(pop[c]) else 5e5
        start_day = int(rng.integers(5, 20))
        level = np.log(max(1.0, 1e-6 * p))
        lock = 0.0
        inc = np.zeros(T)
        for d in range(T):
            if d >= start_day:
                level += 0.12 - 0.35 * lock + float(rng.normal(0, 0.05))
                inc[d] = np.exp(level)
            per100k = 1e5 * inc[d] / p
            lock = 0.8 if per100k > 20 else (0.0 if per100k < 5 else lock)
            act[d, c] = [lock, 0.5 if d > 30 else 0.0, 0.66 if d > 10 else 0.0, 0.5 if d > 15 else 0.0,
                         min(1.0, max(0.0, (d - 60) / 40))]
        weekly = 1.0 + 0.25 * np.sin(2 * np.pi * t / 7)
        cases = rng.poisson(np.clip(inc * weekly, 0, 1e9)).astype(float)
        deaths = rng.poisson(0.01 * np.concatenate([np.zeros(10), inc[:-10]])).astype(float)
        hosp = 0.05 * np.convolve(inc, np.ones(7), mode="full")[:T]
        obs[:, c] = np.stack([cases, deaths, hosp, 0.2 * hosp, 8 * cases + 50,
                              np.cumsum(np.where(t > 60, 0.002 * p, 0.0))], axis=1)
    om = np.ones((T, C, 6), bool)
    om[rng.random((T, C)) < 0.03, :2] = False  # a few unreported days
    om[:, 2:, 2:4] = False                     # hospital / ICU from the first two countries only
    om[:, ::2, 4] = False                      # tests from some
    om[:61, :, 5] = False                      # no vaccination figures before the campaign
    om[:, -1, :] &= rng.random((T, 6)) < 0.5
    am = rng.random((T, C)) < 0.9
    am = np.repeat(am[:, :, None], 5, axis=2)
    obs = np.where(om, obs, np.nan).astype(np.float32)
    act = np.where(am, act, np.nan).astype(np.float32)
    out = Path(gev_root) / "real" / "owid-oxcgrt"
    out.mkdir(parents=True, exist_ok=True)
    write_npy(out / "obs.npy", obs)
    write_npy(out / "obs_mask.npy", om.astype(np.uint8))
    write_npy(out / "actions.npy", act)
    write_npy(out / "actions_mask.npy", am.astype(np.uint8))
    write_npy(out / "population.npy", pop.astype(np.float64))
    write_json(out / "meta.json", {
        "schema": F.REAL_SCHEMA, "from": str(start), "to": str(start + dt.timedelta(days=T - 1)), "days": T,
        "countries": list(countries),
        "channels": {"obs": list(F.REAL_OBS_CHANNELS), "actions": list(F.REAL_ACTION_CHANNELS)},
        "actionMapping": "synthetic", "domain": "real", "class": "open",
        "licences": ["synthetic epidemic, OWID-style (CC0 1.0)", "synthetic policy, OxCGRT-style (CC0 1.0)"],
    })
    return out


# --------------------------------------------------------------------------
# Tape
# --------------------------------------------------------------------------


def _tape_records(rng, day, hours, n_flights, n_vessels, n_transit):
    """Synthetic records per hour: {hour: [record, ...]}."""
    t0 = day_start_ms(day)
    out = {h: [] for h in hours}
    span = (min(hours) * 3600000, (max(hours) + 1) * 3600000)

    def mover(feed, ident, every_s, speed_kmmin, turn_sd, make, lat, lon):
        heading = float(rng.uniform(0, 360))
        t = span[0] + int(rng.integers(0, every_s)) * 1000
        while t < span[1]:
            h = int(t // 3600000)
            if h in out:
                out[h].append(make(t0 + t, ident, lat, lon, heading, speed_kmmin))
            step_min = every_s / 60.0
            heading = (heading + float(rng.normal(0, turn_sd))) % 360
            lat, lon = geo.destination(lat, lon, heading, speed_kmmin * step_min)
            lat, lon = float(lat), float(lon)
            t += every_s * 1000

    for i in range(n_flights):
        hexid = f"{0xa00000 + i:06x}"
        mover("flights", hexid, 60, 13.0, 2.0, lambda t, ident, la, lo, hd, sp: {
            "t": t, "feed": "flights", "class": "nc", "licence": "synthetic (non-commercial style)",
            "hex": ident, "callsign": f"SYN{ident[-3:].upper()}", "lat": round(la, 5), "lon": round(lo, 5),
            "alt": 10500, "speed": round(sp * 60 / 1.852, 1), "track": round(hd, 1), "vrate": 0,
            "ground": False, "source": "synthetic"},
            float(rng.uniform(-40, 50)), float(rng.uniform(-120, 120)))
    for i in range(n_vessels):
        mover("vessels", str(200000000 + i), 120, 0.35, 4.0, lambda t, ident, la, lo, hd, sp: {
            "t": t, "feed": "vessels", "class": "unclear", "licence": "synthetic (unconfirmed terms style)",
            "mmsi": ident, "name": f"SYN VESSEL {ident[-2:]}", "type": 70, "lat": round(la, 5),
            "lon": round(lo, 5), "sog": round(sp * 60 / 1.852, 1), "cog": round(hd, 1), "heading": round(hd)},
            float(rng.uniform(-30, 30)), float(rng.uniform(-60, 60)))
    for i in range(n_transit):
        mover("transit", f"bus{i}", 30, 0.4, 10.0, lambda t, ident, la, lo, hd, sp: {
            "t": t, "feed": "transit", "class": "open", "licence": "synthetic (open style)",
            "region": "syn", "id": ident, "route": "1", "mode": "bus", "lat": round(la, 6),
            "lon": round(lo, 6), "bearing": round(hd), "speed": round(sp * 1000 / 60, 1)},
            float(rng.uniform(40, 50)), float(rng.uniform(-75, -70)))
    for h in hours:
        for j in range(3):
            out[h].append({"t": t0 + h * 3600000 + j * 600000, "feed": "news", "class": "nc",
                           "licence": "synthetic", "source": "synthetic", "title": f"Item {h}-{j}",
                           "url": "", "place": "", "lat": None, "lon": None,
                           "published": t0 + h * 3600000})
    return out


def write_tape(gev_root, *, day=dt.date(2026, 10, 1), hours=(0, 1, 2), seed=0,
               n_flights=6, n_vessels=3, n_transit=4) -> Path:
    """Write tape/<feed>/YYYY/MM/DD/HH.ndjson.gz (+ manifest.jsonl) for a few hours."""
    rng = np.random.default_rng([seed, 5])
    root = Path(gev_root) / "tape"
    per_hour = _tape_records(rng, day, list(hours), n_flights, n_vessels, n_transit)
    y, m, d = day_parts(day)
    for h in hours:
        by_feed: dict = {}
        for rec in sorted(per_hour[h], key=lambda r: r["t"]):
            by_feed.setdefault(rec["feed"], []).append(rec)
        for feed, recs in by_feed.items():
            ddir = root / feed / y / m / d
            ddir.mkdir(parents=True, exist_ok=True)
            data = "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in recs).encode("utf-8")
            path = ddir / f"{h:02d}.ndjson.gz"
            with open(path, "wb") as raw:
                with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as gz:
                    gz.write(data)
            with open(ddir / "manifest.jsonl", "a", encoding="utf-8", newline="\n") as f:
                f.write(json.dumps({"t": recs[-1]["t"], "hour": h, "records": len(recs),
                                    "bytes": path.stat().st_size, "files": 0}) + "\n")
    with open(root / "gaps.jsonl", "a", encoding="utf-8", newline="\n") as f:
        start = day_start_ms(day) + (max(hours) + 1) * 3600000
        f.write(json.dumps({"from": start, "to": start + 600000, "reason": "paused",
                            "feeds": ["flights"]}) + "\n")
    return root


# --------------------------------------------------------------------------
# Everything at once
# --------------------------------------------------------------------------


def make_gev_data(root, *, seed=0, n_nodes=16, n_tracked=6, scenarios=3, runs=2, days=12,
                  episodes_per_shard=5, bin_days=4, tape_hours=3, tape_day=dt.date(2026, 10, 1),
                  dataset_name="synthetic", demographics=False, real_days=0, markets=None) -> dict:
    """A small .gev-data tree: world, dataset, bins, tape (demographics, real data). Returns the paths."""
    root = Path(root)
    world_dir = make_world(root, n_nodes=n_nodes, n_tracked=n_tracked, seed=seed)
    dataset_dir = write_dataset(root, dataset_name, world_dir, scenarios=scenarios, runs=runs,
                                days=days, episodes_per_shard=episodes_per_shard, seed=seed)
    bins_dir = write_bins(root, world_dir, days=bin_days, seed=seed, markets=markets) if bin_days else None
    tape_dir = write_tape(root, day=tape_day, hours=tuple(range(tape_hours)), seed=seed) if tape_hours else None
    demo_dir = write_demographics(root, world_dir, seed=seed) if demographics else None
    real = write_real(root, days=real_days, seed=seed) if real_days else None
    return {"root": root, "world_dir": world_dir, "world_id": world_dir.name,
            "dataset_dir": dataset_dir, "bins_dir": bins_dir, "tape_dir": tape_dir,
            "demographics_dir": demo_dir, "real_dir": real}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="python -m ml.gevtape.synth",
                                 description="Write a small synthetic .gev-data tree (not real data).")
    ap.add_argument("out", help="root directory to write (a .gev-data look-alike)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--nodes", type=int, default=16)
    ap.add_argument("--tracked", type=int, default=6)
    ap.add_argument("--scenarios", type=int, default=3)
    ap.add_argument("--runs", type=int, default=2)
    ap.add_argument("--days", type=int, default=12)
    ap.add_argument("--per-shard", type=int, default=5)
    ap.add_argument("--bin-days", type=int, default=4)
    ap.add_argument("--tape-hours", type=int, default=3)
    ap.add_argument("--demographics", action="store_true", help="also write demographics/places-<worldId>.npy")
    ap.add_argument("--real-days", type=int, default=0, help="also write real/owid-oxcgrt/ with this many days")
    a = ap.parse_args(argv)
    paths = make_gev_data(a.out, seed=a.seed, n_nodes=a.nodes, n_tracked=a.tracked,
                          scenarios=a.scenarios, runs=a.runs, days=a.days,
                          episodes_per_shard=a.per_shard, bin_days=a.bin_days,
                          tape_hours=a.tape_hours, demographics=a.demographics, real_days=a.real_days)
    print(json.dumps({k: str(v) for k, v in paths.items()}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
