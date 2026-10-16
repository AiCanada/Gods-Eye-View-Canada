"""Measured interactions between the data layers and the financial assets.

    python -m ml.gevtape.links --data .gev-data --out .gev-data/ai-world/models/links
                               [--max-lag 24] [--min-hours 48] [--fit-share 0.7] [--top 200]

Owner request 2026-10-15: the tab is also for someone training a NEW world
model "from data layers and interactions between data layers and assets".
This measures those interactions on the recorded bins, so a model builder
starts from numbers instead of guesses.

For every asset a (the bins' `markets.<a>` channels) and every other
recorded channel c, on hourly series averaged over the tracked places:

  asset return   r_a(t) = (p_a(t) - p_a(t-1)) / |p_a(t-1)|
  channel change x_c(t) = c(t) - c(t-1); another asset's own return when c
                 is a price (`markets.*`), so asset-to-asset links are
                 measured the same way
  lead / lag     the Pearson correlation of x_c(t - L) with r_a(t), for
                 L = -max_lag .. +max_lag hours (L > 0: the channel moves
                 first; L < 0: the price moves first)

Each correlation is fitted on the first `fit_share` of the hours and checked
on the rest, which the fit never saw (`rTest`). A link `holds` when the
held-out hours give the same sign and at least half the strength. p is the
two-sided Fisher z test on the fitted hours and q its Benjamini-Hochberg
false-discovery rate across every channel, asset and lag tested. Hourly
series are autocorrelated, so p and q are optimistic; `holds` is the
stronger evidence. A correlation is not a cause, and none of this is
advice. A pair with fewer than `min_hours` paired hours is not reported.

The study list (links.json beside the bins, src/trainingLinks.mjs) gets the
strongest measured link between its sides (`studyPairs`).

Writes <out>/links.json atomically. Same JSON-lines protocol as
ml.gevtape.train on stdout (progress / links / done / error); --resume and
pause / stop are accepted (the run is short and starts over).
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import traceback
import warnings
from pathlib import Path

import numpy as np

from . import reader as R
from . import torch_data as td
from .train import Control, DataError, Emitter, atomic_json, now_ms

MARKET_GROUP = "markets"
SKIP_GROUPS = frozenset({"military"})


def _mean_over_places(values):
    """[H, K, C] -> [H, C], NaN where no place has a value."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        return np.nanmean(values, axis=1)


def relative_change(series):
    """(p(t) - p(t-1)) / |p(t-1)| along axis 0; NaN where either is missing or p(t-1) is 0."""
    out = np.full_like(series, np.nan, dtype=np.float64)
    prev, cur = series[:-1], series[1:]
    with np.errstate(divide="ignore", invalid="ignore"):
        out[1:] = np.where(np.isfinite(prev) & np.isfinite(cur) & (prev != 0),
                           (cur - prev) / np.abs(prev), np.nan)
    return out


def first_difference(series):
    out = np.full_like(series, np.nan, dtype=np.float64)
    out[1:] = series[1:] - series[:-1]
    return out


def shift(x, lag):
    """x(t - lag) along axis 0 (NaN where it falls off the series)."""
    out = np.full_like(x, np.nan)
    if lag == 0:
        return x.copy()
    if abs(lag) >= len(x):
        return out
    if lag > 0:
        out[lag:] = x[:-lag]
    else:
        out[:lag] = x[-lag:]
    return out


def masked_corr(X, Y):
    """Pairwise-complete Pearson r and n between every column of X [T, C] and Y [T, A]."""
    mx, my = np.isfinite(X), np.isfinite(Y)
    x, y = np.where(mx, X, 0.0), np.where(my, Y, 0.0)
    fx, fy = mx.astype(np.float64), my.astype(np.float64)
    n = fx.T @ fy
    sx, sy = x.T @ fy, fx.T @ y
    sxx, syy = (x * x).T @ fy, fx.T @ (y * y)
    sxy = x.T @ y
    with np.errstate(divide="ignore", invalid="ignore"):
        cov = sxy - sx * sy / n
        vx = sxx - sx * sx / n
        vy = syy - sy * sy / n
        r = cov / np.sqrt(vx * vy)
    r = np.where((n >= 3) & (vx > 1e-12 * np.maximum(1.0, sxx)) & (vy > 1e-12 * np.maximum(1.0, syy)), r, np.nan)
    return np.clip(r, -1.0, 1.0), n


def fisher_p(r, n):
    """Two-sided p of r against 0 (Fisher z), NaN where it cannot be had."""
    r, n = np.asarray(r, dtype=np.float64), np.asarray(n, dtype=np.float64)
    with np.errstate(divide="ignore", invalid="ignore"):
        z = np.abs(np.arctanh(np.clip(r, -0.999999, 0.999999))) * np.sqrt(np.maximum(n - 3, 0))
    erfc = np.frompyfunc(math.erfc, 1, 1)
    p = erfc(z / math.sqrt(2)).astype(np.float64)
    return np.where(np.isfinite(r) & (n > 3), p, np.nan)


def bh_q(p):
    """Benjamini-Hochberg q-values (NaN stays NaN)."""
    p = np.asarray(p, dtype=np.float64)
    q = np.full_like(p, np.nan)
    ok = np.flatnonzero(np.isfinite(p))
    if not ok.size:
        return q
    order = ok[np.argsort(p[ok])]
    m = order.size
    ranked = p[order] * m / np.arange(1, m + 1)
    ranked = np.minimum.accumulate(ranked[::-1])[::-1]
    q[order] = np.minimum(ranked, 1.0)
    return q


def measure(values, channels, *, max_lag=24, min_hours=48, fit_share=0.7, min_test=24):
    """Every channel x asset x lag measured on an hourly bins series.

    values [H, K, C] as torch_data.load_bin_series gives them; channels the
    'group.channel' names. Returns (results, info): results a list of dicts,
    strongest evidence first.
    """
    series = _mean_over_places(np.asarray(values, dtype=np.float64))
    groups = [c.split(".", 1)[0] for c in channels]
    assets = [i for i, g in enumerate(groups) if g == MARKET_GROUP]
    if not assets:
        return [], {"reason": "no market prices in the bins yet"}
    H = series.shape[0]
    returns = relative_change(series[:, assets])
    feats, names = [], []
    for j, name in enumerate(channels):
        if groups[j] in SKIP_GROUPS or groups[j].startswith("military-"):
            continue
        col = series[:, j]
        if np.isfinite(col).sum() < 3:
            continue
        feats.append(relative_change(col[:, None])[:, 0] if groups[j] == MARKET_GROUP else first_difference(col))
        names.append(name)
    if not feats:
        return [], {"reason": "no other recorded channel yet"}
    X = np.stack(feats, axis=1)
    cut = max(1, int(round(H * fit_share)))
    asset_names = [channels[i] for i in assets]
    rows = []
    for lag in range(-max_lag, max_lag + 1):
        XL = shift(X, lag)
        r_fit, n_fit = masked_corr(XL[:cut], returns[:cut])
        r_test, n_test = masked_corr(XL[cut:], returns[cut:])
        for ci, ai in zip(*np.nonzero(np.isfinite(r_fit) & (n_fit >= min_hours))):
            if names[ci] == asset_names[ai]:
                continue  # an asset with itself is not an interaction
            rows.append((names[ci], asset_names[ai], lag, float(r_fit[ci, ai]), int(n_fit[ci, ai]),
                         float(r_test[ci, ai]) if np.isfinite(r_test[ci, ai]) else None, int(n_test[ci, ai])))
    info = {"hours": int(H), "fitHours": int(cut), "testHours": int(H - cut), "channels": len(names),
            "assets": len(assets), "maxLag": int(max_lag), "minHours": int(min_hours)}
    if not rows:
        info["reason"] = f"fewer than {min_hours} paired hours for every pair"
        return [], info
    p = fisher_p([row[3] for row in rows], [row[4] for row in rows])
    q = bh_q(p)
    results = []
    for k, (channel, asset, lag, r, n, rt, nt) in enumerate(rows):
        holds = bool(rt is not None and nt >= min_test and np.sign(rt) == np.sign(r) and abs(rt) >= abs(r) / 2)
        results.append({"channel": channel, "asset": asset.split(".", 1)[1], "lagHours": lag,
                        "r": round(r, 4), "n": n, "p": float(p[k]), "q": float(q[k]),
                        "rTest": None if rt is None else round(rt, 4), "nTest": nt, "holds": holds})
    results.sort(key=lambda row: (not row["holds"], row["q"], -abs(row["r"])))
    info["tested"] = len(results)
    return results, info


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def study_pairs(results, links):
    """The strongest measured link between the two sides of each study pair."""
    out = []
    for link in links if isinstance(links, list) else []:
        reads = [str(r) for r in link.get("reads", []) if isinstance(r, str)]
        prices = {r.split(".", 1)[1] for r in reads if r.startswith(MARKET_GROUP + ".")}
        any_price = MARKET_GROUP in reads or not prices
        # A read in words ("every other non-military number …") is any channel.
        any_other = any(" " in r for r in reads)
        others = [r for r in reads if not r.startswith(MARKET_GROUP) and " " not in r]

        def wanted(row):
            if not (any_price or row["asset"] in prices):
                return False
            ch = row["channel"]
            if any_other or not others:
                return not ch.startswith(MARKET_GROUP)
            return any(ch == o or ch.startswith(o + ".") for o in others)

        best = next((row for row in results if wanted(row)), None)
        out.append({"id": link.get("id"), "best": best})
    return out


def latest_bins_dir(data_root):
    worlds = R.list_bin_worlds(data_root)
    return worlds[-1] if worlds else None


def run(args, emit, control) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    bins_dir = latest_bins_dir(args.data)
    emit("progress", model="links", epoch=0, epochs=1)
    if bins_dir is None:
        raise DataError("no bins yet: the tape is binned once a day has been recorded")
    series = td.load_bin_series(bins_dir)
    if series is None:
        raise DataError(f"no bins under {bins_dir}")
    results, info = measure(series["values"], series["channels"], max_lag=args.max_lag,
                            min_hours=args.min_hours, fit_share=args.fit_share)
    if control.requested() == "stop":
        emit("done", model="links")
        return 0
    report = {
        "generatedAt": now_ms(),
        "worldId": bins_dir.name,
        "days": [d.isoformat() for d in series["days"]],
        "classes": series["classes"],
        **info,
        "note": "Correlation on recorded hours, fitted then checked on later hours. Not a cause; not advice.",
        "results": results[: args.top],
        "studyPairs": study_pairs(results, _read_json(bins_dir / "links.json")),
    }
    atomic_json(out / "links.json", report)
    held = sum(1 for row in results if row["holds"])
    # Its own event: a `metrics` event would stand in for the world model's scores.
    emit("links", model="links", tested=len(results), holds=held, hours=info.get("hours", 0))
    emit("progress", model="links", epoch=1, epochs=1)
    emit("done", model="links")
    return 0


def build_parser():
    p = argparse.ArgumentParser(prog="python -m ml.gevtape.links", description=__doc__.split("\n\n")[0])
    p.add_argument("--data", required=True, help="the .gev-data root")
    p.add_argument("--out", required=True, help="where links.json is written")
    p.add_argument("--max-lag", type=int, default=24, help="hours each way (default 24)")
    p.add_argument("--min-hours", type=int, default=48, help="paired hours a pair needs (default 48)")
    p.add_argument("--fit-share", type=float, default=0.7, help="share of hours fitted; the rest checks (0.7)")
    p.add_argument("--top", type=int, default=200, help="results kept in links.json (default 200)")
    p.add_argument("--resume", action="store_true", help="accepted; the run starts over")
    p.add_argument("--device", default="cpu", help="accepted; numpy only")
    return p


def main(argv=None) -> int:
    emit = Emitter(sys.stdout)
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as e:
        return int(e.code or 0)
    if not 0.1 <= args.fit_share <= 0.95 or args.max_lag < 0 or args.min_hours < 4:
        emit("error", message="--fit-share 0.1-0.95, --max-lag >= 0, --min-hours >= 4")
        return 1
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
