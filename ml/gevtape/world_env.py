"""Reinforcement learning on the recorded world: data layers in, asset positions out.

Owner request 2026-10-15: the tab is also for someone who wants to "train or
RL NEW world model from data layers and interactions between data layers and
assets". This is the environment for that, Gymnasium-style (reset / step
with Gymnasium's 5-tuple) and with no gymnasium needed; `as_gymnasium()`
wraps it when gymnasium is installed.

    from ml.gevtape.world_env import WorldMarketEnv
    env = WorldMarketEnv(".gev-data", split="train", episode_hours=168)
    obs, info = env.reset(seed=0)
    done = False
    while not done:
        action = policy(obs)                    # one weight per asset, -1..1
        obs, reward, done, truncated, info = env.step(action)

Each step is one recorded hour. The observation is the last `context` hours
of every bin channel (all data layers, demographics-ready places, news,
supply, prices: whatever the bins hold, military never), plus the assets'
recent prices and the current position:

  layers    float32 [context, K, C]  symlog of each channel, 0 where missing
  mask      float32 [context, K, C]  1 where the channel was observed
  prices    float32 [context, A]     each asset's price over its latest one,
                                     minus 1 (0 where missing)
  position  float32 [A]              the weights held
  hour      float32 [2]              sin / cos of the UTC hour of the step

The action is a weight per asset in -1..1, scaled down so the absolute
weights sum to at most 1 (no leverage). The reward is the next hour's
portfolio return, sum_a w_a r_a, minus `cost_bps` basis points of turnover;
an asset with no price that hour (a closed market) earns nothing. This is a
research environment on recorded data, not trading advice.

Splits are by time: `train` uses the first `fit_share` of the recorded
hours, `test` the rest, so an agent is judged on hours it never saw.

Model-based RL: pass `model`, any callable model(window, time_ms) -> next
hour [K, C] (window [context, K, C] float64 with NaN for missing, time_ms
the UTC milliseconds of its first hour), and the episode is imagined by
that model from a recorded start instead of read from the tape. `KitWorldModel`
adapts the world model this kit trains (ml.gevtape.train --model world);
any other world model plugs in the same way.
"""

from __future__ import annotations

import warnings
from pathlib import Path

import numpy as np

from . import reader as R
from . import torch_data as td

MARKET_GROUP = "markets"


class WorldEnvError(RuntimeError):
    """No bins, no prices, or too few recorded hours for an episode."""


def _mean_over_places(values):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", category=RuntimeWarning)
        return np.nanmean(values, axis=1)


def load_series(data_root):
    """The latest world's bins as one hourly series (torch_data.load_bin_series)."""
    worlds = R.list_bin_worlds(data_root)
    if not worlds:
        raise WorldEnvError(f"no bins under {Path(data_root) / 'bins'}: record and bin a day first")
    series = td.load_bin_series(worlds[-1])
    if series is None:
        raise WorldEnvError(f"no bins in {worlds[-1]}")
    series["bins_dir"] = worlds[-1]
    return series


class WorldMarketEnv:
    """See the module docstring."""

    def __init__(self, data_root=None, *, series=None, context=24, episode_hours=168, assets=None,
                 split="train", fit_share=0.7, cost_bps=1.0, model=None, seed=None):
        if series is None:
            if data_root is None:
                raise WorldEnvError("give data_root (a .gev-data folder) or series")
            series = load_series(data_root)
        values = np.asarray(series["values"], dtype=np.float64)
        channels = list(series["channels"])
        keep = [i for i, c in enumerate(channels) if not c.split(".", 1)[0].startswith("military")]
        self.values = values[:, :, keep]
        self.channels = [channels[i] for i in keep]
        wanted = getattr(model, "channels", None)
        if wanted:
            # A world model sees the channels in the order it was trained on;
            # one it knows that the bins do not have stays missing (NaN).
            at = {c: i for i, c in enumerate(self.channels)}
            remapped = np.full(self.values.shape[:2] + (len(wanted),), np.nan)
            for j, c in enumerate(wanted):
                if c in at:
                    remapped[:, :, j] = self.values[:, :, at[c]]
            self.values = remapped
            self.channels = [str(c) for c in wanted]
        cols = [i for i, c in enumerate(self.channels) if c.split(".", 1)[0] == MARKET_GROUP]
        if assets is not None:
            wanted = {f"{MARKET_GROUP}.{a}" for a in assets}
            cols = [i for i in cols if self.channels[i] in wanted]
        if not cols:
            raise WorldEnvError("no asset prices in the bins (tick MARKETS and record first)")
        self.asset_cols = cols
        self.assets = [self.channels[i].split(".", 1)[1] for i in cols]
        self.start_ms = int(series.get("start_ms", 0))
        self.context = int(context)
        self.episode_hours = int(episode_hours)
        self.cost = float(cost_bps) / 10_000.0
        self.model = model
        H = self.values.shape[0]
        cut = int(round(H * float(fit_share)))
        lo, hi = (0, cut) if split == "train" else (cut, H) if split == "test" else (0, H)
        if split not in ("train", "test", "all"):
            raise WorldEnvError("split is train, test or all")
        # A step at hour t needs `context` hours before it and the next hour's
        # price, inside the split (a train episode never reads a test hour).
        self.first = max(lo, self.context)
        self.hi = hi
        self.last_start = max(self.first, hi - 1 - self.episode_hours)
        if hi - 1 - self.first < 1:
            raise WorldEnvError(f"too few recorded hours for a {split} episode: need more than {self.context + 1}")
        self.split = split
        self.rng = np.random.default_rng(seed)
        self.t = None
        self.end = None
        self.position = np.zeros(len(self.assets), dtype=np.float64)
        self.imagined = None

    # ---- spaces, described without gymnasium
    @property
    def observation_shapes(self):
        K, C, A = self.values.shape[1], self.values.shape[2], len(self.assets)
        return {"layers": (self.context, K, C), "mask": (self.context, K, C), "prices": (self.context, A),
                "position": (A,), "hour": (2,)}

    @property
    def action_shape(self):
        return (len(self.assets),)

    # ---- the episode
    def reset(self, *, seed=None, options=None):
        if seed is not None:
            self.rng = np.random.default_rng(seed)
        start = (options or {}).get("start")
        if start is None:
            start = int(self.rng.integers(self.first, max(self.first, self.last_start) + 1))
        self.t = int(start)
        if not self.first <= self.t < self.hi - 1:
            raise WorldEnvError(f"start {self.t} is outside the {self.split} hours {self.first}..{self.hi - 2}")
        self.end = min(self.t + self.episode_hours, self.hi - 1)
        self.position = np.zeros(len(self.assets), dtype=np.float64)
        self.imagined = None
        if self.model is not None:
            # Imagined hours start from the recorded context and grow from the model.
            self.imagined = list(self.values[self.t - self.context: self.t + 1])
        return self._obs(), self._info()

    def _window(self):
        # The `context` hours before the current one.
        if self.imagined is not None:
            return np.asarray(self.imagined[-(self.context + 1):-1])
        return self.values[self.t - self.context: self.t]

    def _now_values(self):
        return np.asarray(self.imagined[-1]) if self.imagined is not None else self.values[self.t]

    def _prices(self, rows):
        return _mean_over_places(np.asarray(rows)[..., self.asset_cols])

    def _obs(self):
        window = np.concatenate([self._window()[1:], self._now_values()[None]], axis=0)
        mask = np.isfinite(window)
        layers = np.where(mask, td.symlog(np.nan_to_num(window)), 0.0)
        prices = self._prices(window)
        latest = np.array([next((p for p in prices[::-1, a] if np.isfinite(p) and p != 0), np.nan)
                           for a in range(prices.shape[1])])
        with np.errstate(divide="ignore", invalid="ignore"):
            rel = np.where(np.isfinite(prices) & np.isfinite(latest), prices / latest - 1.0, 0.0)
        hour = ((self.start_ms / 3_600_000.0) + self.t) % 24
        return {"layers": layers.astype(np.float32), "mask": mask.astype(np.float32),
                "prices": np.nan_to_num(rel).astype(np.float32), "position": self.position.astype(np.float32),
                "hour": np.array([np.sin(2 * np.pi * hour / 24), np.cos(2 * np.pi * hour / 24)], dtype=np.float32)}

    def _info(self, **extra):
        return {"hour": self.t, "timeMs": self.start_ms + self.t * 3_600_000, "assets": self.assets,
                "split": self.split, "imagined": self.imagined is not None, **extra}

    @staticmethod
    def clean_action(action, n):
        w = np.nan_to_num(np.clip(np.asarray(action, dtype=np.float64).reshape(-1), -1.0, 1.0))
        if w.size != n:
            raise ValueError(f"an action is {n} weights, one per asset; got {w.size}")
        gross = np.abs(w).sum()
        return w / gross if gross > 1.0 else w

    def step(self, action):
        if self.t is None:
            raise WorldEnvError("reset() before step()")
        w = self.clean_action(action, len(self.assets))
        now = self._now_values()
        if self.imagined is not None:
            window = np.concatenate([self._window()[1:], now[None]], axis=0)
            first_ms = self.start_ms + (self.t - self.context + 1) * 3_600_000
            nxt = np.asarray(self.model(window, first_ms), dtype=np.float64)
            if nxt.shape != now.shape:
                raise WorldEnvError(f"the model gave {nxt.shape}, expected {now.shape}")
            self.imagined.append(nxt)
        else:
            nxt = self.values[self.t + 1]
        p0, p1 = self._prices(now[None])[0], self._prices(nxt[None])[0]
        with np.errstate(divide="ignore", invalid="ignore"):
            r = np.where(np.isfinite(p0) & np.isfinite(p1) & (p0 != 0), (p1 - p0) / np.abs(p0), 0.0)
        turnover = float(np.abs(w - self.position).sum())
        reward = float(w @ r) - self.cost * turnover
        self.position = w
        self.t += 1
        terminated = self.t >= self.end
        return self._obs(), reward, terminated, False, self._info(returns=r.tolist(), turnover=turnover)


class KitWorldModel:
    """The kit's trained world model (models/world/checkpoint.pt) as a one-hour-ahead callable.

    It needs the world snapshot the bins were made on (for the place graph,
    static features and local hours), found under <data_root> by the bins'
    world id.
    """

    def __init__(self, data_root, models_dir=None, device="cpu"):
        import torch

        from . import serve as S

        self.torch = torch
        root = Path(data_root)
        models = Path(models_dir) if models_dir else R.gev_paths(root)["models"]
        self.server = S.Server(root, models, device=device)
        self.lm = self.server.bank.get("world")
        if self.lm is None:
            raise WorldEnvError(f"no world model under {models / 'world'}: train one first")
        world_id = str(self.lm.state.get("worldId"))
        self.world = self.server.world(R.find_world(root, world_id))
        if self.world is None:
            raise WorldEnvError(f"the world {world_id} the model was trained on is not under {root}")
        self.channels = list(self.lm.state.get("channels", []))
        self.context = int(self.lm.state.get("context", 24))

    def __call__(self, window, time_ms=0):
        torch = self.torch
        window = np.asarray(window, dtype=np.float64)
        time_ms = int(time_ms) + max(0, window.shape[0] - self.context) * 3_600_000
        window = window[-self.context:]
        mask = np.isfinite(window)
        v = np.where(mask, td.symlog(np.nan_to_num(window)), 0).astype(np.float32)
        K = window.shape[1]
        tf = td.hour_features(time_ms, self.context + 1, td.place_utc_offsets(self.world, K))
        s = td.place_static(self.world, K, int(self.lm.config.get("n_static", td.N_PLACE_STATIC)))
        adj = self.server.graph(self.world, "place")
        dev = self.server.device
        with torch.no_grad():
            pred, seen = self.lm.model.rollout(torch.from_numpy(v)[None].to(dev),
                                               torch.from_numpy(mask.astype(np.float32))[None].to(dev),
                                               torch.from_numpy(tf)[None].to(dev), torch.from_numpy(s)[None].to(dev),
                                               adj, 1)
        out = td.symexp(pred[0, -1].cpu().numpy()).astype(np.float64)
        return np.where(seen[0].cpu().numpy(), out, np.nan)


def as_gymnasium(env: WorldMarketEnv):
    """The same environment as a gymnasium.Env (needs `pip install gymnasium`)."""
    import gymnasium as gym
    from gymnasium import spaces

    shapes = env.observation_shapes

    class _GymWorldMarket(gym.Env):
        metadata = {"render_modes": []}

        def __init__(self):
            self.inner = env
            self.observation_space = spaces.Dict({
                "layers": spaces.Box(-np.inf, np.inf, shapes["layers"], np.float32),
                "mask": spaces.Box(0, 1, shapes["mask"], np.float32),
                "prices": spaces.Box(-np.inf, np.inf, shapes["prices"], np.float32),
                "position": spaces.Box(-1, 1, shapes["position"], np.float32),
                "hour": spaces.Box(-1, 1, shapes["hour"], np.float32),
            })
            self.action_space = spaces.Box(-1, 1, env.action_shape, np.float32)

        def reset(self, *, seed=None, options=None):
            super().reset(seed=seed)
            return self.inner.reset(seed=seed, options=options)

        def step(self, action):
            return self.inner.step(action)

    return _GymWorldMarket()
