"""Small models sized for an 8 GB GPU (RTX 4060 Laptop class).

- OutbreakSurrogate: per-country GRU over days with message passing over the
  country graph, conditioned on actions and static features, predicting
  next-day log1p deltas of [state, cum].
- WorldModel: the same pattern over the tracked places for hourly bins, with
  NaN masks (missing hours are inputs with mask 0, never zeros).
- TrackPredictor: a constant-velocity great-circle baseline plus a small GRU
  residual over the last N fixes, predicting offsets at 5/15/30/60 minutes.

Every model keeps its constructor arguments in `self.config`, so
`build_model(kind, config)` rebuilds it from a checkpoint.
"""

from __future__ import annotations

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as Fn

from . import formats as F

# --------------------------------------------------------------------------
# Graph helpers
# --------------------------------------------------------------------------


def adjacency_tensor(rows, cols, weights, n: int, *, dense_limit: int = 2048, device=None) -> torch.Tensor:
    """An [n, n] adjacency from edge lists: dense, or sparse COO when n > dense_limit."""
    rows = torch.as_tensor(np.asarray(rows), dtype=torch.long)
    cols = torch.as_tensor(np.asarray(cols), dtype=torch.long)
    w = torch.as_tensor(np.asarray(weights), dtype=torch.float32)
    if n > dense_limit:
        return torch.sparse_coo_tensor(torch.stack([rows, cols]), w, (n, n), device=device,
                                       check_invariants=True).coalesce()
    A = torch.zeros((n, n), dtype=torch.float32)
    if len(w):
        A.index_put_((rows, cols), w, accumulate=True)
    return A.to(device) if device is not None else A


def dense_to_tensor(A: np.ndarray, *, dense_limit: int = 2048, device=None) -> torch.Tensor:
    """A numpy [n, n] adjacency as a tensor (sparse when large)."""
    n = A.shape[0]
    if n > dense_limit:
        r, c = np.nonzero(A)
        return adjacency_tensor(r, c, A[r, c], n, dense_limit=dense_limit, device=device)
    t = torch.as_tensor(A, dtype=torch.float32)
    return t.to(device) if device is not None else t


def aggregate(adj: torch.Tensor, h: torch.Tensor) -> torch.Tensor:
    """sum_j adj[i, j] * h[:, j, :] for h [B, X, H] (adj dense [X, X] or sparse)."""
    if adj.is_sparse:
        B, X, H = h.shape
        flat = h.permute(1, 0, 2).reshape(X, B * H).float()
        out = torch.sparse.mm(adj, flat).to(h.dtype)
        return out.reshape(X, B, H).permute(1, 0, 2)
    return torch.matmul(adj.to(h.dtype), h)


class GraphGRUCell(nn.Module):
    """One time step for every node of a graph.

    The input is encoded; the neighbours' previous hidden states are read
    through the adjacency; a GRUCell updates each node's state; then
    `rounds` residual message-passing rounds refine the output (the
    recurrent state itself stays a plain GRU state).
    Returns (new state [B, X, H], output [B, X, H]).
    """

    def __init__(self, in_dim: int, hidden: int, rounds: int = 1):
        super().__init__()
        self.hidden = hidden
        self.enc = nn.Sequential(nn.Linear(in_dim, hidden), nn.GELU(), nn.Linear(hidden, hidden))
        self.read = nn.Linear(hidden, hidden)
        self.cell = nn.GRUCell(2 * hidden, hidden)
        self.mp = nn.ModuleList(
            nn.Sequential(nn.Linear(2 * hidden, hidden), nn.GELU(), nn.Linear(hidden, hidden))
            for _ in range(rounds))
        self.norm = nn.LayerNorm(hidden)

    def forward(self, inp, h, adj):
        B, X, _ = inp.shape
        z = self.enc(inp)
        m = self.read(aggregate(adj, h))
        h = self.cell(torch.cat([z, m], dim=-1).reshape(B * X, -1), h.reshape(B * X, -1)).reshape(B, X, -1)
        out = h
        for layer in self.mp:
            out = out + layer(torch.cat([out, aggregate(adj, out)], dim=-1))
        return h, self.norm(out)


# --------------------------------------------------------------------------
# Outbreak surrogate
# --------------------------------------------------------------------------


# softplus(raw - shift) for the features that cannot fall: about 0.0025 a day
# at raw = 0, so the zero-initialised model starts at persistence even where
# nothing happens (most countries of a real world, most days).
MONOTONE_SHIFT = 6.0


class OutbreakSurrogate(nn.Module):
    """Next-day log1p deltas of the 22 outbreak features per country.

    Inputs per step: log1p features x_t [B, X, 22] (scaled by x_scale),
    actions a_t [B, X, 14], static s [B, X, S], and `n_extra` more inputs
    when set (real-data calibration adds testing, tests and observation
    masks); the graph adj [X, X]. Features that cannot fall (cumulative
    channels and D) get a softplus delta, so predictions keep the cumulative
    channels monotone. The unit count X is not a parameter: any world's
    countries work.
    """

    kind = "outbreak"

    def __init__(self, n_features: int = len(F.OUTBREAK_FEATURES), n_actions: int = 14, n_static: int = 1,
                 hidden: int = 64, rounds: int = 1, x_scale: float = 0.1, monotone=None, n_extra: int = 0,
                 extra_skip: bool = False):
        super().__init__()
        if monotone is None:
            monotone = [F.OUTBREAK_FEATURES.index(f) for f in F.MONOTONE_FEATURES] if n_features == len(F.OUTBREAK_FEATURES) else []
        self.config = dict(n_features=n_features, n_actions=n_actions, n_static=n_static, hidden=hidden,
                           rounds=rounds, x_scale=x_scale, monotone=list(monotone))
        if n_extra:
            self.config["n_extra"] = int(n_extra)
        if extra_skip:
            self.config["extra_skip"] = True
        self.x_scale = x_scale
        self.n_extra = int(n_extra)
        # A linear path from the extra inputs straight to the head's raw output
        # (zero at first): real-data calibration feeds it yesterday's growth.
        self.skip = nn.Linear(self.n_extra, n_features) if (extra_skip and self.n_extra) else None
        if self.skip is not None:
            nn.init.zeros_(self.skip.weight)
            nn.init.zeros_(self.skip.bias)
        self.cell = GraphGRUCell(n_features + n_actions + n_static + self.n_extra, hidden, rounds)
        self.head = nn.Sequential(nn.Linear(hidden, hidden), nn.GELU(), nn.Linear(hidden, n_features))
        # Zero output layer: an untrained surrogate predicts no change (persistence).
        nn.init.zeros_(self.head[-1].weight)
        nn.init.zeros_(self.head[-1].bias)
        mono = torch.zeros(n_features, dtype=torch.bool)
        mono[list(monotone)] = True
        self.register_buffer("monotone", mono, persistent=False)

    def init_state(self, B: int, X: int, like: torch.Tensor):
        return torch.zeros(B, X, self.cell.hidden, device=like.device, dtype=like.dtype)

    def step(self, x_t, a_t, s, h, adj, extra_t=None):
        parts = [x_t * self.x_scale, a_t, s]
        if self.n_extra:
            if extra_t is None:
                extra_t = x_t.new_zeros(x_t.shape[:-1] + (self.n_extra,))
            parts.append(extra_t)
        h, out = self.cell(torch.cat(parts, dim=-1), h, adj)
        raw = self.head(out)
        if self.skip is not None:
            raw = raw + self.skip(extra_t)
        delta = torch.where(self.monotone, Fn.softplus(raw - MONOTONE_SHIFT), raw)
        return delta, h

    def forward(self, x, a, s, adj, extra=None):
        """Teacher-forced deltas: x [B, L, X, F], a [B, L-1, X, A], s [B, X, S],
        extra [B, L-1, X, n_extra] (optional) -> [B, L-1, X, F]."""
        B, L, X, _ = x.shape
        h = self.init_state(B, X, x)
        out = []
        for t in range(L - 1):
            d, h = self.step(x[:, t], a[:, t], s, h, adj, None if extra is None else extra[:, t])
            out.append(d)
        return torch.stack(out, dim=1)

    @torch.no_grad()
    def rollout(self, x_ctx, a, s, adj, horizon: int, extra=None):
        """Predict `horizon` rows after c context rows.

        x_ctx [B, c, X, F]; a [B, c - 1 + horizon, X, A] (the actions of every
        transition from the first context row on); extra likewise (optional).
        Returns [B, horizon, X, F].
        """
        B, c, X, _ = x_ctx.shape
        h = self.init_state(B, X, x_ctx)
        ex = (lambda t: None) if extra is None else (lambda t: extra[:, t])  # noqa: E731
        for t in range(c - 1):
            _, h = self.step(x_ctx[:, t], a[:, t], s, h, adj, ex(t))
        x_t = x_ctx[:, -1]
        out = []
        for k in range(horizon):
            d, h = self.step(x_t, a[:, c - 1 + k], s, h, adj, ex(c - 1 + k))
            x_t = torch.clamp(x_t + d, min=0.0)
            out.append(x_t)
        return torch.stack(out, dim=1)


# --------------------------------------------------------------------------
# World model
# --------------------------------------------------------------------------


def grow_world_model(state, config, old_channels, new_channels):
    """A world model for `new_channels` that keeps what `state` learned.

    Post-training (owner request 2026-10-16: keep an existing world model up
    to date): when a data layer or an asset adds channels, the trained model
    is grown instead of thrown away. Only the input encoder's first layer and
    the output head depend on the channel list. A channel both lists name
    keeps its weights, wherever it moved; a new channel's weights start at
    zero, so the grown model predicts every known channel exactly as before
    and a new one at persistence until training teaches it; a channel no
    longer recorded is dropped. Everything else is copied as it is.
    """
    old_channels, new_channels = list(old_channels), list(new_channels)
    C0, C1 = len(old_channels), len(new_channels)
    cfg = dict(config, n_channels=C1)
    model = WorldModel(**cfg)
    grown = model.state_dict()
    where = {name: i for i, name in enumerate(old_channels)}
    pairs = [(where[name], j) for j, name in enumerate(new_channels) if name in where]
    for key, value in state.items():
        if key not in grown:
            continue
        if key == "cell.enc.0.weight":
            out = torch.zeros_like(grown[key])
            for i, j in pairs:
                out[:, j] = value[:, i]            # the value column
                out[:, C1 + j] = value[:, C0 + i]  # its observed-mask column
            out[:, 2 * C1:] = value[:, 2 * C0:]    # time and static features
            grown[key] = out
        elif key in ("head.2.weight", "head.2.bias"):
            out = torch.zeros_like(grown[key])
            for i, j in pairs:
                out[j] = value[i]
            grown[key] = out
        elif grown[key].shape == value.shape:
            grown[key] = value.clone()
    model.load_state_dict(grown)
    return model


class WorldModel(nn.Module):
    """Next-hour symlog values of the binned channels per tracked place.

    Inputs per step: values v_t and masks m_t [B, K, Ch] (0 / 0 where not
    observed), the time features of the hour being predicted [B, K, 6],
    static features [B, K, 4]. The prediction is the last observed value
    plus a learned change, so an untrained model starts at persistence.
    """

    kind = "world"

    def __init__(self, n_channels: int, n_time: int = 6, n_static: int = 4, hidden: int = 64, rounds: int = 1):
        super().__init__()
        self.config = dict(n_channels=n_channels, n_time=n_time, n_static=n_static, hidden=hidden, rounds=rounds)
        self.cell = GraphGRUCell(2 * n_channels + n_time + n_static, hidden, rounds)
        self.head = nn.Sequential(nn.Linear(hidden, hidden), nn.GELU(), nn.Linear(hidden, n_channels))
        nn.init.zeros_(self.head[-1].weight)
        nn.init.zeros_(self.head[-1].bias)

    def init_state(self, B, K, like):
        return torch.zeros(B, K, self.cell.hidden, device=like.device, dtype=like.dtype)

    def step(self, v_t, m_t, last, tf_next, s, h, adj):
        h, out = self.cell(torch.cat([v_t, m_t, tf_next, s], dim=-1), h, adj)
        return last + self.head(out), h

    def forward(self, v, m, tf, s, adj):
        """Teacher-forced: the prediction for hour t + 1 made at hour t, [B, L-1, K, Ch]."""
        B, L, K, _ = v.shape
        h = self.init_state(B, K, v)
        last = torch.zeros_like(v[:, 0])
        out = []
        for t in range(L - 1):
            last = torch.where(m[:, t] > 0, v[:, t], last)
            pred, h = self.step(v[:, t], m[:, t], last, tf[:, t + 1], s, h, adj)
            out.append(pred)
        return torch.stack(out, dim=1)

    def predict_forward(self, v, m, tf, s, adj, horizon: int):
        """Predict `horizon` hours after the context, with gradients.

        v, m [B, c, K, Ch] (the context); tf [B, c + horizon, K, 6].
        Predictions are fed back only for channels seen in the context.
        Returns ([B, horizon, K, Ch] symlog predictions, seen [B, K, Ch]).
        """
        B, c, K, _ = v.shape
        h = self.init_state(B, K, v)
        last = torch.zeros_like(v[:, 0])
        seen = torch.zeros_like(v[:, 0], dtype=torch.bool)
        for t in range(c - 1):
            last = torch.where(m[:, t] > 0, v[:, t], last)
            seen |= m[:, t] > 0
            _, h = self.step(v[:, t], m[:, t], last, tf[:, t + 1], s, h, adj)
        v_t, m_t = v[:, c - 1], m[:, c - 1]
        last = torch.where(m_t > 0, v_t, last)
        seen |= m_t > 0
        out = []
        for k in range(horizon):
            pred, h = self.step(v_t, m_t, last, tf[:, c + k], s, h, adj)
            out.append(pred)
            v_t = torch.where(seen, pred, torch.zeros_like(pred))
            m_t = seen.to(v.dtype)
            last = torch.where(seen, pred, last)
        return torch.stack(out, dim=1), seen

    @torch.no_grad()
    def rollout(self, v, m, tf, s, adj, horizon: int):
        """The same prediction as `predict_forward`, without gradients."""
        return self.predict_forward(v, m, tf, s, adj, horizon)


# --------------------------------------------------------------------------
# Track predictor
# --------------------------------------------------------------------------


class TrackPredictor(nn.Module):
    """Offsets (east, north km from the last fix) at each horizon.

    pred = constant-velocity baseline + GRU residual. The residual head starts
    at zero, so an untrained model is exactly the baseline.
    feats [B, N, 7] (see torch_data.track_inputs), kind [B] (feed index),
    base [B, H, 2] baseline offsets in km.
    """

    kind = "tracks"

    def __init__(self, n_features: int = 7, n_kinds: int = 3, hidden: int = 64,
                 horizons=F.TRACK_HORIZONS_MIN, resid_scale: float = 5.0):
        super().__init__()
        self.config = dict(n_features=n_features, n_kinds=n_kinds, hidden=hidden,
                           horizons=list(horizons), resid_scale=resid_scale)
        self.horizons = list(horizons)
        self.resid_scale = resid_scale
        self.kind_emb = nn.Embedding(n_kinds, 8)
        self.gru = nn.GRU(n_features + 8, hidden, batch_first=True)
        H = len(self.horizons)
        self.head = nn.Sequential(nn.Linear(hidden + 2 * H, hidden), nn.GELU(), nn.Linear(hidden, 2 * H))
        nn.init.zeros_(self.head[-1].weight)
        nn.init.zeros_(self.head[-1].bias)

    def forward(self, feats, kind, base):
        B, N, _ = feats.shape
        e = self.kind_emb(kind).unsqueeze(1).expand(B, N, -1)
        _, h = self.gru(torch.cat([feats, e], dim=-1))
        z = torch.cat([h[-1], torch.asinh(base.flatten(1))], dim=-1)
        resid = self.head(z).view(B, -1, 2) * self.resid_scale
        return base + resid


def with_extra_inputs(model: OutbreakSurrogate, n_extra: int, skip: bool = False) -> OutbreakSurrogate:
    """A copy of a surrogate with n_extra more inputs whose weights start at zero
    (and, with skip, a zero linear path from them to the output), so it predicts
    exactly as the original until it is trained."""
    if model.n_extra or model.skip is not None:
        raise ValueError("the model already has extra inputs")
    cfg = dict(model.config)
    cfg["n_extra"] = int(n_extra)
    if skip:
        cfg["extra_skip"] = True
    new = OutbreakSurrogate(**cfg)
    sd = {k: v.clone() for k, v in model.state_dict().items()}
    w = sd["cell.enc.0.weight"]
    sd["cell.enc.0.weight"] = torch.cat([w, torch.zeros(w.shape[0], int(n_extra), dtype=w.dtype)], dim=1)
    if skip:
        sd["skip.weight"] = torch.zeros_like(new.skip.weight)
        sd["skip.bias"] = torch.zeros_like(new.skip.bias)
    new.load_state_dict(sd)
    return new


MODEL_CLASSES = {"outbreak": OutbreakSurrogate, "world": WorldModel, "tracks": TrackPredictor}


def build_model(kind: str, config: dict) -> nn.Module:
    """Rebuild a model from its kind and saved config."""
    return MODEL_CLASSES[kind](**config)


def count_parameters(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())
