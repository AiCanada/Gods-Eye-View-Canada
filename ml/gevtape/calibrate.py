"""Real-data calibration of the outbreak surrogate: sim pretraining -> real fine-tune and validation.

    python -m ml.gevtape.calibrate --data .gev-data --model-dir .gev-data/ai-world/models/outbreak
                                   --out .gev-data/ai-world/models/outbreak-real
                                   [--epochs N] [--device auto|cpu|cuda] [--resume] [...]

Reads real/owid-oxcgrt/ (OWID + OxCGRT; docs/WORLD-MODEL-DATA.md, "Real
epidemics and policy") and the sim surrogate's checkpoint.pt, then compares
three models on the held-out last 20 % of days (a time split; --val-fraction):

  zero-shot   the sim surrogate as trained on sim episodes, through the
              mapping below; it never sees real data
  fine-tuned  those weights trained further on the real training days
  scratch     the same architecture, freshly initialised, trained on the
              real training days only

Same JSON-lines protocol as ml.gevtape.train: progress / checkpoint / metrics
/ paused / done / error on stdout, {"cmd":"pause"} / {"cmd":"stop"} on stdin
(checkpoint at the next step boundary, then paused / done, exit 0), --resume
continues exactly. Progress events carry `phase` ("finetune", "scratch");
`epochs` counts both phases (2 x --epochs). The last metrics event carries
the fine-tuned skill plus all three results.

Mapping (sim surrogate <-> real):

  observations (the loss and the metrics; log1p of people per 100,000, using
  the country's population; masked to observed cells)
    real newCases   <-> daily rise of sim cum.reported
    real newDeaths  <-> daily rise of sim state.D
    real hospital   <-> sim state.H (ward occupancy)
    real icu        <-> sim state.U
  new cases and deaths are 7-day trailing means (--smooth) of the observed
  days; a day counts as observed when at least half its window is.

  actions (real shares 0-1 -> the surrogate's 14 action features)
    lockdown    -> place.lockdown (the country's places)
    travelBan   -> place.banned
    tracing     -> global.tracingIsolate
    vaccination -> place.vaccineTarget
    any action on -> global.windowShare = 1 (sim measures act inside the
                     intervention window only); the rest stay 0
  extra inputs (weights start at zero, so zero-shot is the sim model
  exactly): testing (the one real action without a sim counterpart),
  whether the day's actions were observed, new tests per 100k (log1p / 10),
  whether new cases, new deaths, hospital and ICU were observed, their
  values on the input day, and for cases and deaths log(q) + 6 with q the
  day's count over 1 + the cumulative count (over the days ahead: from the
  model's own predictions of the day before). The surrogate's inputs are
  cumulative counts, in which a day's rise is a difference of ~1e-4; these
  give it the rates. A linear path from the extra inputs to the head's raw
  output then repeats the day's count exactly (softplus(log q) = log1p(q),
  and (1 + cumulative) * q = the count): it is zero in the zero-shot model
  (the sim surrogate exactly) and starts at that identity in the fine-tuned
  and the scratch models, which learn corrections to persistence.

  state (the surrogate reads all 22 log1p features; real data observes four,
  so the rest is a crude reconstruction, as the zero-shot model needs it)
    cum.reported = cum.infected = cum.local = running sum of daily cases
    state.D = running sum of daily deaths; H, U = hospital, ICU (last value
    carried); V = people vaccinated; E, P, Is, Ia = 3, 2, 3, 2 days of the
    current daily case rate; R = reported recovered + V; S = the rest of the
    population; Rx = R; cum.admitted = rises of H; the rest 0.

Training matches the evaluation: each window's context days start from the
real (reconstructed) rows, the days ahead run free on the model's own rows;
the loss covers every observed cell of both.

Writes <out>/checkpoint.pt (the fine-tuned model, kind 'outbreak-real', and
the scratch model), metrics.json, calibration.md (human-readable) and
manifest.json (licence classes and the OWID / OxCGRT attributions).
"""

from __future__ import annotations

import argparse
import copy
import math
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as Fn

from . import formats as F
from . import models as M
from . import reader as R
from .torch_data import fit_width
from .train import (CHECKPOINT_FORMAT, LOCAL_ONLY_NOTE, MODEL_FORMAT, Control, DataError, Emitter,
                    atomic_json, atomic_torch_save, load_checkpoint, log, now_ms, resolve_device,
                    rng_state, seed_everything, set_rng_state)

KIND = "outbreak-real"
PER = 1e5  # observations are people per 100,000
RECON_DAYS = {"E": 3.0, "P": 2.0, "Is": 3.0, "Ia": 2.0}  # days of the daily case rate per compartment
EXTRA_POLICY = ("testing", "actionsObserved")  # indexed by the day being predicted
EXTRA_STATE = ("newTests", "observed.newCases", "observed.newDeaths", "observed.hospital",
               "observed.icu")  # indexed by the input day
# The input day's observations (log1p per 100k, 0 where not observed); over
# the days ahead, the model's own prediction of the day before.
EXTRA_OBS = tuple(f"obs.{c}" for c in F.CALIBRATION_OBS)
# The growth of log1p cum.reported and of log1p D that would repeat the input
# day's count tomorrow, coded for the head: log(q) + its softplus shift with
# q = count / (1 + cumulative), since softplus(log q) = log1p(q) and
# (1 + cum) * q = count. Through the skip path a weight of 1 repeats the day's
# count exactly; zero in the zero-shot model, 1 at the start of the trained
# ones (anchor_to_yesterday). Over the days ahead q = -expm1(-delta) of the
# model's own step (its count over its new cumulative).
EXTRA_GROWTH = ("growth.newCases", "growth.newDeaths")
EXTRA_FEATURES = EXTRA_POLICY + EXTRA_STATE + EXTRA_OBS + EXTRA_GROWTH
GROWTH_CLIP = (-10.0, 10.0)

_FI = {f: i for i, f in enumerate(F.OUTBREAK_FEATURES)}
_AI = {a: i for i, a in enumerate(F.OUTBREAK_ACTIONS)}
OBS_FEATURES = (_FI["cum.reported"], _FI["state.D"], _FI["state.H"], _FI["state.U"])


# --------------------------------------------------------------------------
# Real data -> the surrogate's inputs and the targets
# --------------------------------------------------------------------------


def trailing_mean(v: np.ndarray, m: np.ndarray, w: int):
    """Mean of the observed values over the last w days, and whether at least half were observed."""
    vv = np.where(m, v, 0.0).astype(np.float64)
    mm = m.astype(np.float64)
    cs, cm = np.cumsum(vv, axis=0), np.cumsum(mm, axis=0)
    if w > 1:
        pad = np.zeros((w,) + cs.shape[1:])
        cs = cs - np.concatenate([pad, cs[:-w]], axis=0)
        cm = cm - np.concatenate([pad, cm[:-w]], axis=0)
    ok = cm >= max(1, (w + 1) // 2)
    return np.where(ok, cs / np.maximum(cm, 1.0), 0.0), ok


def carry_forward(v: np.ndarray, ok: np.ndarray) -> np.ndarray:
    """[T, C]: the last value where ok, 0 before the first."""
    T, C = v.shape
    idx = np.where(ok, np.arange(T)[:, None], -1)
    idx = np.maximum.accumulate(idx, axis=0)
    return np.where(idx >= 0, v[np.maximum(idx, 0), np.arange(C)[None, :]], 0.0)


@dataclass
class Prepared:
    """Real data on the surrogate's terms, day by day (row t = the end of day t)."""

    countries: list
    start: object
    x: np.ndarray           # float32 [T, C, 22] log1p reconstructed features
    a: np.ndarray           # float32 [T, C, 14] action features of day t
    e_policy: np.ndarray    # float32 [T, C, 2]  extra inputs of day t (the day predicted)
    e_state: np.ndarray     # float32 [T, C, 5]  extra inputs of day t (the input day)
    y: np.ndarray           # float32 [T, C, 4]  log1p per-100k targets (0 where not observed)
    m: np.ndarray           # bool    [T, C, 4]
    growth: np.ndarray      # float32 [T, C, 2] growth inputs of day t (EXTRA_GROWTH)
    lscale: np.ndarray      # float32 [C] log(1e5 / population)
    keep: np.ndarray        # bool [C]: countries with a population
    static: np.ndarray      # float32 [C, S]
    adj: np.ndarray         # float32 [C, C]
    notes: list = field(default_factory=list)

    @property
    def T(self) -> int:
        return int(self.x.shape[0])

    @property
    def C(self) -> int:
        return int(self.x.shape[1])


def prepare(real: R.RealData, *, smooth: int = 7, world=None, worldbank=None, n_static: int = 1) -> Prepared:
    """Reconstruct the surrogate's inputs and the observation targets (see the module docstring)."""
    T, C = real.T, real.C
    notes = []
    pop = real.population.astype(np.float64).copy()
    if world is not None:  # a missing population from the world snapshot, when it knows the country
        wpop = dict(zip(world.countries, world.country_population()))
        for i, code in enumerate(real.countries):
            if not (np.isfinite(pop[i]) and pop[i] > 0) and wpop.get(code, 0) > 0:
                pop[i] = wpop[code]
                notes.append(f"{code}: population from the world snapshot")
    keep = np.isfinite(pop) & (pop > 0)
    for i in np.flatnonzero(~keep):
        notes.append(f"{real.countries[i]}: no population, left out of the loss and the metrics")
    popu = np.where(keep, pop, 1e6)  # placeholder for countries left out

    def ch(name):
        k = real.obs_index(name)
        return np.clip(np.nan_to_num(real.obs[..., k].astype(np.float64)), 0, None), real.obs_mask[..., k]

    cases, cases_m = ch("newCases")
    deaths, deaths_m = ch("newDeaths")
    hosp, hosp_m = ch("hospital")
    icu, icu_m = ch("icu")
    tests, tests_m = ch("newTests")
    vacc, vacc_m = ch("peopleVaccinated")
    rc, rc_ok = trailing_mean(cases, cases_m, smooth)
    rd, rd_ok = trailing_mean(deaths, deaths_m, smooth)
    rt, rt_ok = trailing_mean(tests, tests_m, smooth)
    rc_in, rd_in = carry_forward(rc, rc_ok), carry_forward(rd, rd_ok)  # gaps keep the last rate
    cum = np.cumsum(rc_in, axis=0)
    D = np.cumsum(rd_in, axis=0)
    H, U = carry_forward(hosp, hosp_m), carry_forward(icu, icu_m)
    V = np.minimum(carry_forward(vacc, vacc_m), popu[None, :])
    comp = {k: d * rc_in for k, d in RECON_DAYS.items()}
    active = sum(comp.values())
    Rr = np.maximum(0.0, cum - active - H - U - D) + V
    Rr = np.minimum(Rr, np.maximum(0.0, popu[None, :] - active - H - U - D))
    S = np.maximum(0.0, popu[None, :] - active - H - U - D - Rr)
    admitted = np.cumsum(np.maximum(0.0, np.diff(H, axis=0, prepend=0.0)), axis=0)
    zero = np.zeros((T, C))
    state = {"S": S, "E": comp["E"], "P": comp["P"], "Is": comp["Is"], "Ia": comp["Ia"], "H": H, "U": U,
             "R": Rr, "D": D, "V": V, "E2": zero, "P2": zero, "Is2": zero, "Ia2": zero, "Rx": Rr}
    cumd = {"infected": cum, "reported": cum, "admitted": admitted, "imported": zero, "local": cum,
            "reinfected": zero, "infected2": zero}
    x = np.stack([state[c] for c in F.STATE_CHANNELS] + [cumd[c] for c in F.CUM_CHANNELS], axis=-1)
    x = np.log1p(np.maximum(x, 0.0)).astype(np.float32)

    def pc(v):  # log1p of people per 100k
        return np.log1p(PER * v / popu[None, :])

    y = np.stack([pc(rc), pc(rd), pc(hosp), pc(icu)], axis=-1)
    m = np.stack([rc_ok, rd_ok, hosp_m, icu_m], axis=-1) & keep[None, :, None]
    y = np.where(m, y, 0.0).astype(np.float32)

    act = np.where(real.actions_mask, np.nan_to_num(real.actions), 0.0).astype(np.float32)
    a = np.zeros((T, C, len(F.OUTBREAK_ACTIONS)), np.float32)
    for rname, sname in F.REAL_ACTION_TO_SIM.items():
        a[..., _AI[sname]] = act[..., real.action_index(rname)]
    a[..., _AI["global.windowShare"]] = (act.max(axis=-1) > 0).astype(np.float32)
    e_policy = np.stack([act[..., real.action_index("testing")],
                         real.actions_mask.any(axis=-1).astype(np.float32)], axis=-1).astype(np.float32)
    e_state = np.stack([pc(carry_forward(rt, rt_ok)) / 10.0, rc_ok, rd_ok, hosp_m, icu_m],
                       axis=-1).astype(np.float32)

    shares = np.zeros((C, 4))
    for i, code in enumerate(real.countries):
        row = (worldbank or {}).get(code)
        if row is not None:
            shares[i] = np.nan_to_num(row)
    static = fit_width(np.concatenate([np.log1p(popu)[:, None] / 20.0, shares], axis=1), n_static)

    adj = np.zeros((C, C), np.float32)
    if world is not None:
        at = {code: j for j, code in enumerate(world.countries) if code}
        idx = np.array([at.get(code, -1) for code in real.countries])
        ok = idx >= 0
        W = np.zeros((C, C))
        W[np.ix_(ok, ok)] = R.country_graph(world)[np.ix_(idx[ok], idx[ok])]
        adj = R.normalized_adjacency(W)
        missing = [real.countries[i] for i in np.flatnonzero(~ok)]
        if missing:
            notes.append(f"not in the world graph (no travel links): {', '.join(missing)}")
    else:
        notes.append("no world snapshot: no travel links between countries")
    lscale = np.log(PER / popu).astype(np.float32)
    # q = the day's count over 1 + the cumulative count through that day (float64).
    growth = np.stack([growth_feature(rc_in / (1.0 + cum)), growth_feature(rd_in / (1.0 + D))], axis=-1)
    return Prepared(countries=list(real.countries), start=real.start, x=x, a=a, e_policy=e_policy,
                    e_state=e_state, y=y, m=m, growth=growth.astype(np.float32), lscale=lscale, keep=keep,
                    static=static, adj=adj, notes=notes)


def growth_feature(q):
    """log(q) + the head's softplus shift, clipped (numpy or torch): the raw output
    whose step repeats a count that is q times 1 + the cumulative count."""
    if isinstance(q, torch.Tensor):
        return (torch.log(q.clamp_min(1e-12)) + M.MONOTONE_SHIFT).clamp(*GROWTH_CLIP)
    return np.clip(np.log(np.maximum(q, 1e-12)) + M.MONOTONE_SHIFT, *GROWTH_CLIP)


def anchor_to_yesterday(model):
    """Set the skip path to repeat the input day's counts (cases -> cum.reported,
    cum.infected, cum.local; deaths -> D; hospital and ICU repeat anyway with a
    zero delta): the trained models learn corrections to persistence. The
    zero-shot model keeps its zero path, so it stays the sim surrogate exactly."""
    gi = {name: i for i, name in enumerate(EXTRA_FEATURES)}
    with torch.no_grad():
        for feat in ("cum.reported", "cum.infected", "cum.local"):
            model.skip.weight[_FI[feat], gi["growth.newCases"]] = 1.0
        model.skip.weight[_FI["state.D"], gi["growth.newDeaths"]] = 1.0
    return model


def observe_step(x_prev, delta, lscale):
    """Predicted observations of one day, log1p per 100k: [..., C, 4].

    x_prev is the row the step starts from, delta the surrogate's predicted
    change. The day's rise of a log1p-coded cumulative count c is
    (1 + c_prev) * expm1(delta) = exp(x_prev) * expm1(delta), computed from delta
    itself (x_prev + delta loses small deltas in float32 once c is large);
    hospital and ICU are stocks: expm1(x_prev + delta).
    """
    rep, dea, hos, icu = OBS_FEATURES
    new_c = torch.exp(x_prev[..., rep] + lscale) * torch.expm1(delta[..., rep].clamp_min(0))
    new_d = torch.exp(x_prev[..., dea] + lscale) * torch.expm1(delta[..., dea].clamp_min(0))
    h = torch.exp(lscale) * torch.expm1((x_prev[..., hos] + delta[..., hos]).clamp_min(0))
    u = torch.exp(lscale) * torch.expm1((x_prev[..., icu] + delta[..., icu]).clamp_min(0))
    return torch.log1p(torch.stack([new_c, new_d, h, u], dim=-1))


def window(P: Prepared, s: int, c: int, h: int):
    """Rows s..s+c+h-1: context rows s..s+c-1, then h days to predict.

    Returns x [L, C, 22], actions a and extra inputs e for the L - 1 day
    transitions (all but the observations and growths, which run_window
    adds), the input days' observations and growths obs_in [L - 1, C, 6],
    the targets y / masks m, and
    persistence (the last value observed in the context, [C, 4], with where
    it exists). Extra inputs that are observations (tests, observed flags)
    are held at the last context day for the days ahead; actions are taken
    as known.
    """
    L = c + h
    e_state = P.e_state[s: s + L - 1].copy()
    e_state[c:] = e_state[c - 1]
    e = np.concatenate([P.e_policy[s + 1: s + L], e_state], axis=-1)
    yc, mc = P.y[s: s + c], P.m[s: s + c]
    last = np.where(mc, np.arange(c)[:, None, None], -1).max(axis=0)  # [C, 4]
    pers = np.take_along_axis(yc, np.maximum(last, 0)[None], axis=0)[0]
    obs_in = np.concatenate([P.y[s: s + L - 1], P.growth[s: s + L - 1]], axis=-1)
    return (P.x[s: s + L], P.a[s + 1: s + L], e, obs_in, P.y[s + 1: s + L], P.m[s + 1: s + L],
            pers, last >= 0)


# --------------------------------------------------------------------------
# Loss and evaluation
# --------------------------------------------------------------------------


class Fixed:
    """The tensors every batch shares (static features, graph, population scale)."""

    def __init__(self, P: Prepared, device):
        self.static = torch.from_numpy(P.static).to(device)
        self.adj = torch.from_numpy(P.adj).to(device)
        self.lscale = torch.from_numpy(P.lscale).to(device)


def run_window(model, x, a, e, y_in, fx: Fixed, c: int, h: int):
    """Predicted observations for every transition of a window, [B, c - 1 + h, C, 4].

    The c - 1 context transitions start from the real (reconstructed) rows
    and the real observations of their day; the h days ahead run free on the
    model's own rows and its own prediction of the day before, as a forecast
    does. Training and evaluation both go through here.
    """
    B, C = x.shape[0], x.shape[2]
    s = fx.static.unsqueeze(0).expand(B, -1, -1)
    hs = model.init_state(B, C, x)
    rep, dea = OBS_FEATURES[0], OBS_FEATURES[1]
    out = []
    for t in range(c - 1):
        d, hs = model.step(x[:, t], a[:, t], s, hs, fx.adj, torch.cat([e[:, t], y_in[:, t]], dim=-1))
        out.append(observe_step(x[:, t], d, fx.lscale))
    x_t, fed = x[:, c - 1], y_in[:, c - 1]
    for k in range(h):
        t = c - 1 + k
        d, hs = model.step(x_t, a[:, t], s, hs, fx.adj, torch.cat([e[:, t], fed], dim=-1))
        obs_t = observe_step(x_t, d, fx.lscale)
        out.append(obs_t)
        # Tomorrow's inputs: today's predicted observations and growths.
        fed = torch.cat([obs_t, growth_feature(-torch.expm1(-d[..., rep]))[..., None],
                         growth_feature(-torch.expm1(-d[..., dea]))[..., None]], dim=-1)
        x_t = torch.clamp(x_t + d, min=0.0)
    return torch.stack(out, dim=1)


def _batch(P: Prepared, starts, c: int, h: int, device):
    parts = [window(P, s, c, h) for s in starts]
    x, a, e, y_in, y, m = (torch.from_numpy(np.stack([p[k] for p in parts])).to(device) for k in range(6))
    pers = np.stack([p[6] for p in parts])
    ok = np.stack([p[7] for p in parts])
    return x, a, e, y_in, y, m, pers, ok


def batch_loss(model, P: Prepared, starts, c: int, h: int, fx: Fixed, device):
    """Masked Huber loss over the observed cells of the windows (context and days ahead),
    averaged per channel and then over the channels, so hospital and ICU (observed in
    a few countries) weigh as much as cases and deaths."""
    x, a, e, y_in, y, m, _, _ = _batch(P, starts, c, h, device)
    pred = run_window(model, x, a, e, y_in, fx, c, h)
    w = m.to(pred.dtype)
    err = Fn.smooth_l1_loss(pred, y, reduction="none", beta=1.0) * w
    per = err.sum(dim=(0, 1, 2)) / w.sum(dim=(0, 1, 2)).clamp_min(1.0)  # [4]
    seen = (w.sum(dim=(0, 1, 2)) > 0).to(pred.dtype)
    return (per * seen).sum() / seen.sum().clamp_min(1.0)


@torch.no_grad()
def evaluate(model, P: Prepared, starts, c: int, h: int, fx: Fixed, device, batch_size: int = 8) -> dict:
    """Masked MAE (log1p per 100k) of the h days ahead over the held-out windows, model vs persistence."""
    model.eval()
    nO = len(F.CALIBRATION_OBS)
    sm, sp, cnt = np.zeros((h, nO)), np.zeros((h, nO)), np.zeros((h, nO))
    for i in range(0, len(starts), batch_size):
        x, a, e, y_in, y, m, pers, ok = _batch(P, starts[i: i + batch_size], c, h, device)
        pred = run_window(model, x, a, e, y_in, fx, c, h)[:, c - 1:].cpu().numpy()
        y = y[:, c - 1:].cpu().numpy()
        valid = m[:, c - 1:].cpu().numpy() & ok[:, None]
        sm += (np.abs(pred - y) * valid).sum(axis=(0, 2))
        sp += (np.abs(pers[:, None] - y) * valid).sum(axis=(0, 2))
        cnt += valid.sum(axis=(0, 2))
    n = cnt.sum()
    out = {"metric": "mae", "model": float(sm.sum() / n) if n else None,
           "persistence": float(sp.sum() / n) if n else None, "cells": int(n),
           "byChannel": {}, "byHorizon": {"model": [], "persistence": []}}
    for j, name in enumerate(F.CALIBRATION_OBS):
        nj = cnt[:, j].sum()
        out["byChannel"][name] = {"model": float(sm[:, j].sum() / nj) if nj else None,
                                  "persistence": float(sp[:, j].sum() / nj) if nj else None, "cells": int(nj)}
    for k in range(h):
        nk = cnt[k].sum()
        out["byHorizon"]["model"].append(float(sm[k].sum() / nk) if nk else None)
        out["byHorizon"]["persistence"].append(float(sp[k].sum() / nk) if nk else None)
    return out


def summary(result):
    """{metric, model, persistence} of an evaluation (what a metrics event carries)."""
    if not result:
        return None
    return {"metric": "mae", "model": result.get("model"), "persistence": result.get("persistence")}


def skill_ratio(result):
    """1 - MAE / persistence MAE, or None."""
    if not result or result.get("model") is None or not result.get("persistence"):
        return None
    return 1.0 - result["model"] / result["persistence"]


# --------------------------------------------------------------------------
# Reports
# --------------------------------------------------------------------------


def _fmt(v, digits=3):
    return "-" if v is None else f"{v:.{digits}f}"


def calibration_markdown(metrics: dict, info: dict) -> str:
    """calibration.md: what was compared, how, and the result."""
    rows = [("zero-shot (sim only)", metrics.get("zeroShot")), ("fine-tuned (sim, then real)", metrics.get("fineTuned")),
            ("real only (from scratch)", metrics.get("scratch"))]
    lines = [
        "# Outbreak surrogate on real data",
        "",
        f"Real data: {info['real']} ({info['from']} to {info['to']}, {info['countries']} countries). "
        f"Trained on {info['trainFrom']} to {info['trainTo']}; held out {info['heldFrom']} to {info['heldTo']} "
        f"(the last {round(100 * info['valFraction'])} % of days).",
        f"Base model: {info['base']} (the sim surrogate, epoch {info.get('baseEpoch')}).",
        f"Scored: log1p of people per 100,000 for new cases and new deaths ({info['smooth']}-day trailing means), "
        f"hospital and ICU occupancy; mean absolute error over the observed cells of {info['horizon']}-day "
        f"forecasts from {info['context']} days of context, against persistence (the last observed value).",
        "",
        "| model | MAE | persistence | skill |",
        "| ----- | --- | ----------- | ----- |",
    ]
    for label, res in rows:
        lines.append(f"| {label} | {_fmt((res or {}).get('model'))} | {_fmt((res or {}).get('persistence'))} | "
                     f"{_fmt(skill_ratio(res), 2)} |")
    lines += ["", "Skill is 1 − MAE / persistence MAE: above 0 beats persistence.", "",
              "| channel | zero-shot | fine-tuned | real only | persistence | cells |",
              "| ------- | --------- | ---------- | --------- | ----------- | ----- |"]
    for name in F.CALIBRATION_OBS:
        by = [((r or {}).get("byChannel") or {}).get(name) or {} for _, r in rows]
        pers = next((b.get("persistence") for b in by if b.get("persistence") is not None), None)
        cells = next((b.get("cells") for b in by if b.get("cells")), 0)
        lines.append(f"| {name} | {_fmt(by[0].get('model'))} | {_fmt(by[1].get('model'))} | "
                     f"{_fmt(by[2].get('model'))} | {_fmt(pers)} | {cells} |")
    lines += [
        "",
        "Mapping: real newCases ↔ the daily rise of sim cum.reported, newDeaths ↔ the rise of D, hospital ↔ H, "
        "ICU ↔ U. Actions: lockdown → place lockdown, travelBan → banned, tracing → tracing (isolate), "
        "vaccination → vaccine target, any action on → the intervention window. Testing, test volumes, which "
        "observations exist, the day's observations and its growth of cumulative cases and deaths enter as "
        "extra inputs at zero weight, so the zero-shot model is the sim surrogate exactly. The unobserved "
        "compartments are a crude reconstruction from the case rate (ml/gevtape/calibrate.py).",
        "",
        "Fine-tuned and real-only models start from persistence (a linear path from the growth inputs repeats "
        "the day's counts exactly) and learn corrections; they share the optimiser settings, so only their starting "
        "weights differ (the sim surrogate's, or fresh ones). Training runs like the evaluation: the context "
        "days start from the real data, the days ahead run on the model's own predictions.",
    ]
    if info.get("notes"):
        lines += ["", "Notes: " + "; ".join(info["notes"]) + "."]
    lines += ["", "Attribution: " + "; ".join(info.get("attributions") or []) + ".",
              "", "Licence classes: " + ", ".join(info.get("classes") or []) + ". " + LOCAL_ONLY_NOTE, ""]
    return "\n".join(lines)


# --------------------------------------------------------------------------
# The job
# --------------------------------------------------------------------------


def build_parser():
    ap = argparse.ArgumentParser(prog="python -m ml.gevtape.calibrate",
                                 description="Fine-tune and validate the sim outbreak surrogate on real data.")
    ap.add_argument("--data", required=True, help="the .gev-data directory")
    ap.add_argument("--model-dir", required=True, help="the sim surrogate's directory (checkpoint.pt)")
    ap.add_argument("--out", required=True, help="output directory (checkpoint.pt, metrics.json, calibration.md, manifest.json)")
    ap.add_argument("--real", default=None, help="real/owid-oxcgrt directory (default: under --data)")
    ap.add_argument("--epochs", type=int, default=10, help="epochs of fine-tuning, and again of training from scratch")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--device", default="auto", choices=("auto", "cpu", "cuda"))
    ap.add_argument("--context", type=int, default=14, help="days of history")
    ap.add_argument("--horizon", type=int, default=7, help="days forecast")
    ap.add_argument("--smooth", type=int, default=7, help="trailing mean (days) of new cases and deaths; 1: raw")
    ap.add_argument("--val-fraction", type=float, default=0.2, help="the last share of days held out")
    ap.add_argument("--stride", type=int, default=3, help="days between training windows")
    ap.add_argument("--batch-size", type=int, default=8)
    ap.add_argument("--lr", type=float, default=1e-3, help="peak learning rate (cosine decay over each phase)")
    ap.add_argument("--lr-scratch", type=float, default=None,
                    help="from scratch, if different (default: --lr, so only the starting weights differ)")
    ap.add_argument("--weight-decay", type=float, default=1e-4)
    ap.add_argument("--max-batches", type=int, default=0, help="cap on batches per epoch (0: all)")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--threads", type=int, default=None)
    ap.add_argument("--log-every", type=int, default=10)
    ap.add_argument("--sleep-ms", type=int, default=0)
    return ap


def parse_args(argv=None):
    return build_parser().parse_args(argv)


def run(args, emit, control) -> int:
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    ckpt_path = out / "checkpoint.pt"
    if args.threads:
        torch.set_num_threads(args.threads)
    device = resolve_device(args.device)
    data = Path(args.data)
    base_path = Path(args.model_dir) / "checkpoint.pt"
    if not base_path.is_file():
        raise DataError(f"no sim surrogate at {base_path}: train the outbreak model first")
    base_ck = load_checkpoint(base_path)
    if base_ck.get("kind") != "outbreak":
        raise DataError(f"{base_path} holds a {base_ck.get('kind')} model, not the outbreak surrogate")
    try:
        real = R.load_real(args.real or R.gev_paths(data)["real"])
    except (R.FormatError, OSError) as e:
        raise DataError(f"real data: {e}") from None
    base_task = base_ck.get("task") or {}
    wdir = R.find_world(data, base_task.get("worldId")) or (R.list_worlds(data) or [None])[-1]
    world = R.load_world(wdir) if wdir is not None else None
    cfg = dict(base_ck["model_config"])
    P = prepare(real, smooth=args.smooth, world=world, worldbank=R.load_worldbank(data),
                n_static=int(cfg.get("n_static", 1)))
    c, h = int(args.context), int(args.horizon)
    L = c + h
    T = P.T
    cut = T - max(h, int(round(T * args.val_fraction)))
    train_starts = list(range(0, cut - L + 1, max(1, args.stride)))
    eval_starts = list(range(max(0, cut - c), T - L + 1, h))
    if not train_starts or not eval_starts:
        raise DataError(f"{T} days are too few for {c} days of context and {h} days ahead on both sides of the split")

    identity = {"base": str(base_path), "baseSavedAt": base_ck.get("savedAt"), "countries": list(real.countries),
                "days": T, "cut": cut, "context": c, "horizon": h, "smooth": args.smooth,
                "extra": list(EXTRA_FEATURES), "obs": list(F.CALIBRATION_OBS)}
    ckpt = load_checkpoint(ckpt_path) if (args.resume and ckpt_path.exists()) else None
    if ckpt is not None and ckpt.get("task") != identity:
        log("gevtape calibrate: the base model or the real data changed since the checkpoint; starting over")
        ckpt = None
    seed_everything(args.seed)
    base = M.build_model("outbreak", cfg)
    base.load_state_dict(base_ck["model"])
    zero = M.with_extra_inputs(base, len(EXTRA_FEATURES), skip=True).to(device)
    ft = anchor_to_yesterday(copy.deepcopy(zero))
    torch.manual_seed(args.seed + 1)
    scratch = anchor_to_yesterday(M.build_model("outbreak", zero.config).to(device))
    opt_ft = torch.optim.AdamW(ft.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    opt_sc = torch.optim.AdamW(scratch.parameters(), lr=args.lr_scratch or args.lr, weight_decay=args.weight_decay)
    fx = Fixed(P, device)
    N = int(args.epochs)
    total = 2 * N
    start_g, skip, step = 0, 0, 0
    metrics = {}
    created_at = now_ms()
    if ckpt is not None:
        ft.load_state_dict(ckpt["model"])
        opt_ft.load_state_dict(ckpt["optimizer"])
        scratch.load_state_dict(ckpt["scratch_model"])
        opt_sc.load_state_dict(ckpt["scratch_optimizer"])
        start_g, skip, step = int(ckpt["epoch"]), int(ckpt["step_in_epoch"]), int(ckpt["step"])
        metrics = dict(ckpt.get("metrics") or {})
        created_at = int(ckpt.get("createdAt") or created_at)
        total = int(ckpt.get("total", total))
        N = total // 2
        set_rng_state(ckpt["rng"])
    info = {
        "real": str(real.path), "from": str(real.start), "to": str(real.date(T - 1)), "countries": int(P.keep.sum()),
        "trainFrom": str(real.date(0)), "trainTo": str(real.date(cut - 1)), "heldFrom": str(real.date(cut)),
        "heldTo": str(real.date(T - 1)), "valFraction": (T - cut) / T, "base": str(Path(args.model_dir)),
        "baseEpoch": base_ck.get("epoch"), "smooth": args.smooth, "context": c, "horizon": h, "notes": P.notes,
        "attributions": real.attributions,
    }
    base_man = R.read_json(Path(args.model_dir) / "manifest.json") if (Path(args.model_dir) / "manifest.json").is_file() else {}
    classes = sorted(set(real.classes) | set(base_man.get("licenceClasses") or [])) or [F.UNKNOWN_CLASS]
    info["classes"] = classes

    def write_outputs(final: bool):
        atomic_json(out / "metrics.json", {
            "model": KIND, "updatedAt": now_ms(), "epochs": N, "done": final,
            "space": f"log1p people per 100,000 ({args.smooth}-day trailing means for new cases and deaths)",
            "contextDays": c, "horizonDays": h,
            "split": {"trainDays": [info["trainFrom"], info["trainTo"]], "heldOutDays": [info["heldFrom"], info["heldTo"]],
                      "trainWindows": len(train_starts), "heldOutWindows": len(eval_starts)},
            "skill": summary(metrics.get("fineTuned") or metrics.get("zeroShot")),
            "zeroShot": metrics.get("zeroShot"), "fineTuned": metrics.get("fineTuned"),
            "scratch": metrics.get("scratch"), "history": metrics.get("history", []),
            "mapping": {"observations": F.SIM_OBSERVATION, "actions": F.REAL_ACTION_TO_SIM,
                        "windowShare": "1 when any real action is on", "extraInputs": list(EXTRA_FEATURES),
                        "reconstructionDays": RECON_DAYS},
            "notes": P.notes,
        })
        atomic_json(out / "manifest.json", {
            "format": MODEL_FORMAT, "model": KIND, "createdAt": created_at, "updatedAt": now_ms(),
            "base": {"modelDir": str(Path(args.model_dir)), "checkpointSavedAt": base_ck.get("savedAt"),
                     "epoch": base_ck.get("epoch"), "licenceClasses": base_man.get("licenceClasses")},
            "data": {"real": str(real.path), "schema": real.meta.get("schema"), "from": info["from"], "to": info["to"],
                     "days": T, "countries": real.C, "trainDays": [info["trainFrom"], info["trainTo"]],
                     "heldOutDays": [info["heldFrom"], info["heldTo"]], "worldId": world.world_id if world else None},
            "licenceClasses": classes, "attributions": real.attributions,
            "openOnly": all(x == "open" for x in classes), "note": LOCAL_ONLY_NOTE,
        })
        if final:
            (out / "calibration.md").write_text(calibration_markdown(metrics, info), encoding="utf-8", newline="\n")

    def save(g, in_epoch):
        atomic_torch_save(ckpt_path, {
            "format": CHECKPOINT_FORMAT, "kind": KIND, "model_config": ft.config, "model": ft.state_dict(),
            "optimizer": opt_ft.state_dict(), "scratch_model": scratch.state_dict(),
            "scratch_optimizer": opt_sc.state_dict(), "epoch": g, "step_in_epoch": in_epoch, "step": step,
            "total": total, "rng": rng_state(), "task": identity, "metrics": metrics, "seed": args.seed,
            "createdAt": created_at, "savedAt": now_ms(),
        })
        write_outputs(final=False)
        emit("checkpoint", path=str(ckpt_path))

    if "zeroShot" not in metrics:
        metrics["zeroShot"] = evaluate(zero, P, eval_starts, c, h, fx, device, args.batch_size)
        emit("metrics", skill=summary(metrics["zeroShot"]), phase="zero-shot", model=KIND, epoch=0)
    for g in range(start_g, total):
        phase = "finetune" if g < N else "scratch"
        model, opt = (ft, opt_ft) if phase == "finetune" else (scratch, opt_sc)
        lr0 = args.lr if phase == "finetune" or args.lr_scratch is None else args.lr_scratch
        g_in_phase = g if phase == "finetune" else g - N
        order = np.random.default_rng([args.seed, g]).permutation(len(train_starts))
        chunks = [[train_starts[j] for j in order[i: i + args.batch_size]]
                  for i in range(0, len(order), args.batch_size)]
        model.train()
        recent = []
        for i, chunk in enumerate(chunks):
            if args.max_batches and i >= args.max_batches:
                break
            if g == start_g and i < skip:
                continue
            # Cosine decay over the phase, from where in it this step is (resumes exactly).
            done_frac = (g_in_phase + i / max(1, len(chunks))) / max(1, N)
            for group in opt.param_groups:
                group["lr"] = lr0 * 0.5 * (1.0 + math.cos(math.pi * min(1.0, done_frac)))
            loss = batch_loss(model, P, chunk, c, h, fx, device)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            step += 1
            recent.append(float(loss.detach()))
            if step % max(1, args.log_every) == 0:
                emit("progress", model=KIND, epoch=g + 1, epochs=total, step=step, loss=float(np.mean(recent)),
                     phase=phase)
                recent = []
            if args.sleep_ms:
                time.sleep(args.sleep_ms / 1000.0)
            req = control.requested()
            if req:
                save(g, i + 1)
                emit("paused" if req == "pause" else "done")
                return 0
        if recent:
            emit("progress", model=KIND, epoch=g + 1, epochs=total, step=step, loss=float(np.mean(recent)),
                 phase=phase)
        skip = 0
        result = evaluate(model, P, eval_starts, c, h, fx, device, args.batch_size)
        metrics.setdefault("history", []).append({"epoch": g + 1, "phase": phase, **(summary(result) or {})})
        if g == N - 1:
            metrics["fineTuned"] = result
        if g == total - 1:
            metrics["scratch"] = result
        emit("metrics", skill=summary(result), phase=phase, model=KIND, epoch=g + 1)
        save(g + 1, 0)
        req = control.requested()
        if req:
            emit("paused" if req == "pause" else "done")
            return 0
    write_outputs(final=True)
    emit("metrics", skill=summary(metrics.get("fineTuned") or metrics.get("zeroShot")), phase="summary",
         model=KIND, zeroShot=summary(metrics.get("zeroShot")), fineTuned=summary(metrics.get("fineTuned")),
         scratch=summary(metrics.get("scratch")))
    emit("done")
    return 0


def main(argv=None) -> int:
    emit = Emitter(sys.stdout)
    try:
        args = parse_args(argv)
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
