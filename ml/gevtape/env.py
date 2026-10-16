"""Client for the closed-loop outbreak environment (Gymnasium-style, no gymnasium needed).

The environment is a child process speaking JSON lines on stdio, by default
`node scripts/outbreak-env.mjs` run from the repository root:

  -> {"cmd":"reset","scenario":<object|null>,"seed":<int>}
  <- {"ok":true,"obs":{"day":0,"global":[...],"country_state":[[S,E,P,Is,Ia,H,U,R,D,V]...]},"info":{...}}
  -> {"cmd":"step","action":{"window":<24-bit int|null>,"switch":{"<node>":0|1},"flag":[<country>...],
                             "lockdown":<0-1>,"travelBan":<0-1>,"testsPer1000Day":<>=0>,"vaccinePer1000Day":<>=0>}}
     (the magnitudes are optional: one left out stays the scenario's own setting that day)
  <- {"ok":true,"obs":{...},"done":<bool>,"info":{...}}
  -> {"cmd":"close"}
  <- (no answer needed; the process exits)

An answer {"ok":false,"error":...} raises EnvError, as do a dead process
and an answer that does not come within `timeout` seconds. Lines on the
child's stdout that are not JSON objects are skipped (kept in `log_tail`).

    with OutbreakEnv() as env:
        obs, info = env.reset(seed=1)
        done = False
        while not done:
            obs, reward, done, truncated, info = env.step({"window": window_mask(range(8, 20))})

`step` returns Gymnasium's 5-tuple. The protocol carries no reward, so the
reward comes from `reward_fn(prev_obs, obs, info)`: by default
info["reward"] when the environment sends one, else minus the day's new
infections (the rise of the cumulative global `infected` channel).
"""

from __future__ import annotations

import collections
import json
import queue
import subprocess
import threading
from pathlib import Path

import numpy as np

from . import formats as F

REPO_ROOT = Path(__file__).resolve().parents[2]
_EOF = object()
_INFECTED = F.GLOBAL_CHANNELS.index("infected")


class EnvError(RuntimeError):
    """The environment answered with an error, died, or did not answer in time."""


def window_mask(hours) -> int:
    """The 24-bit intervention-window mask with the given hours of the day (0-23) on."""
    mask = 0
    for h in hours:
        h = int(h)
        if not 0 <= h < 24:
            raise ValueError(f"hour {h} is not in 0..23")
        mask |= 1 << h
    return mask


def default_reward(prev_obs, obs, info) -> float:
    """info['reward'] if the environment sends one, else minus the day's new infections."""
    if isinstance(info, dict) and isinstance(info.get("reward"), (int, float)):
        return float(info["reward"])
    if prev_obs is None:
        return 0.0
    try:
        return -float(obs["global"][_INFECTED] - prev_obs["global"][_INFECTED])
    except (KeyError, IndexError, TypeError):
        return 0.0


MAGNITUDES = ("lockdown", "travelBan", "testsPer1000Day", "vaccinePer1000Day")


def make_action(action=None) -> dict:
    """A step action as plain JSON: {window: int|None, switch: {str: 0|1}, flag: [int]}
    plus any of the day's magnitudes (lockdown and travelBan in [0, 1],
    testsPer1000Day and vaccinePer1000Day >= 0) that are given.

    Accepts numpy scalars and arrays, bools for the switch values and int
    node keys. Raises ValueError on anything outside the protocol.
    """
    action = dict(action or {})
    unknown = set(action) - {"window", "switch", "flag", *MAGNITUDES}
    if unknown:
        raise ValueError(f"unknown action fields {sorted(unknown)}")
    window = action.get("window")
    if window is not None:
        if isinstance(window, (bool, np.bool_)) or not isinstance(window, (int, np.integer)):
            raise ValueError("window must be an int mask (or None)")
        window = int(window)
        if not 0 <= window < (1 << 24):
            raise ValueError("window must fit in 24 bits")
    switch = {}
    for node, on in dict(action.get("switch") or {}).items():
        try:
            key = str(int(node))
        except (TypeError, ValueError):
            raise ValueError(f"switch key {node!r} is not a node index") from None
        val = int(on)
        if val not in (0, 1):
            raise ValueError(f"switch value for node {key} must be 0 or 1")
        switch[key] = val
    flag = [int(c) for c in np.asarray(action.get("flag") if action.get("flag") is not None else [], dtype=np.int64).ravel()]
    if any(c < 0 for c in flag):
        raise ValueError("flag holds a negative country index")
    out = {"window": window, "switch": switch, "flag": flag}
    for name in MAGNITUDES:
        value = action.get(name)
        if value is None:
            continue
        if isinstance(value, (bool, np.bool_)):
            raise ValueError(f"{name} must be a number")
        value = float(value)
        hi = 1.0 if name in ("lockdown", "travelBan") else np.inf
        if not np.isfinite(value) or value < 0 or value > hi:
            raise ValueError(f"{name} must be in [0, {hi:g}]")
        out[name] = value
    return out


def _to_numpy_obs(obs) -> dict:
    """Numeric lists (global, country_state, ...) to float64 arrays, shapes as sent.

    No layout is imposed: `global` is the 20 GLOBAL_CHANNELS every day in the
    newer scripts/outbreak-env.mjs, and was the engine's totals row plus
    inTransit, pendingAdmit and isolated before (4 values on day 0, 18 or 19
    after); `country_state` is [C, 10] (S, E, P, Is, Ia, H, U, R, D, V).
    Column 0 of `global` is the cumulative infected count in every form.
    """
    if not isinstance(obs, dict):
        raise EnvError(f"obs is a {type(obs).__name__}, expected an object")
    out = {}
    for k, v in obs.items():
        if k == "day":
            out[k] = int(v)
        elif isinstance(v, list):
            try:
                out[k] = np.asarray(v, dtype=np.float64)
            except (TypeError, ValueError):
                out[k] = v
        else:
            out[k] = v
    return out


class OutbreakEnv:
    """The environment child process behind a reset / step / close interface."""

    def __init__(self, node: str = "node", script: str = "scripts/outbreak-env.mjs", cwd=None, *,
                 args=(), timeout: float = 120.0, reward_fn=default_reward, env=None):
        self.cmd = [str(node), str(script), *map(str, args)]
        self.cwd = str(cwd if cwd is not None else REPO_ROOT)
        self.timeout = float(timeout)
        self.reward_fn = reward_fn
        self.child_env = env
        self.log_tail = collections.deque(maxlen=50)
        self.stderr_tail = collections.deque(maxlen=50)
        self._proc = None
        self._lines = None
        self._threads = []
        self._last_obs = None
        self._done = False
        self.n_countries = None

    # ---- process
    def _start(self):
        if self._proc is not None and self._proc.poll() is None:
            return
        try:
            self._proc = subprocess.Popen(self.cmd, cwd=self.cwd, env=self.child_env, stdin=subprocess.PIPE,
                                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
        except OSError as e:
            raise EnvError(f"cannot start {' '.join(self.cmd)} in {self.cwd}: {e}") from e
        self._lines = queue.Queue()
        proc, lines = self._proc, self._lines

        def read_stdout():
            for raw in iter(proc.stdout.readline, b""):
                lines.put(raw)
            lines.put(_EOF)

        def read_stderr():
            for raw in iter(proc.stderr.readline, b""):
                self.stderr_tail.append(raw.decode("utf-8", "replace").rstrip())

        self._threads = [threading.Thread(target=read_stdout, daemon=True, name="outbreak-env-stdout"),
                         threading.Thread(target=read_stderr, daemon=True, name="outbreak-env-stderr")]
        for t in self._threads:
            t.start()

    def _died(self, what: str) -> EnvError:
        code = self._proc.poll() if self._proc is not None else None
        tail = " | ".join(list(self.stderr_tail)[-5:])
        return EnvError(f"{what} (exit code {code}){': ' + tail if tail else ''}")

    def _send(self, obj):
        try:
            self._proc.stdin.write((json.dumps(obj, separators=(",", ":")) + "\n").encode("utf-8"))
            self._proc.stdin.flush()
        except (BrokenPipeError, OSError, ValueError):
            raise self._died("the environment process is gone") from None

    def _receive(self) -> dict:
        while True:
            try:
                raw = self._lines.get(timeout=self.timeout)
            except queue.Empty:
                self._kill()
                raise EnvError(f"no answer within {self.timeout:g} s") from None
            if raw is _EOF:
                try:
                    self._proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
                raise self._died("the environment process ended")
            text = raw.decode("utf-8", "replace").strip()
            if not text:
                continue
            try:
                msg = json.loads(text)
            except ValueError:
                self.log_tail.append(text)
                continue
            if isinstance(msg, dict):
                return msg
            self.log_tail.append(text)

    def _request(self, obj) -> dict:
        self._start()
        self._send(obj)
        msg = self._receive()
        if not msg.get("ok"):
            raise EnvError(str(msg.get("error") or "the environment refused the request"))
        return msg

    def _kill(self):
        if self._proc is not None and self._proc.poll() is None:
            self._proc.kill()
            try:
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass

    # ---- Gymnasium-style API
    def reset(self, *, scenario=None, seed: int = 0):
        """Start an episode: returns (obs, info) with numpy arrays in obs."""
        msg = self._request({"cmd": "reset", "scenario": scenario, "seed": int(seed)})
        obs = _to_numpy_obs(msg.get("obs"))
        cs = obs.get("country_state")
        self.n_countries = int(cs.shape[0]) if isinstance(cs, np.ndarray) and cs.ndim == 2 else None
        self._last_obs, self._done = obs, False
        return obs, msg.get("info") or {}

    def step(self, action=None):
        """One day: returns (obs, reward, terminated, truncated, info)."""
        if self._last_obs is None:
            raise EnvError("call reset() before step()")
        if self._done:
            raise EnvError("the episode is over; call reset()")
        act = make_action(action)
        msg = self._request({"cmd": "step", "action": act})
        obs = _to_numpy_obs(msg.get("obs"))
        info = msg.get("info") or {}
        reward = float(self.reward_fn(self._last_obs, obs, info))
        self._last_obs, self._done = obs, bool(msg.get("done"))
        return obs, reward, self._done, False, info

    def close(self):
        """Ask the environment to exit; kill it if it does not. Safe to call twice."""
        proc = self._proc
        if proc is None:
            return
        if proc.poll() is None:
            try:
                proc.stdin.write(b'{"cmd":"close"}\n')
                proc.stdin.flush()
                proc.stdin.close()
            except (BrokenPipeError, OSError, ValueError):
                pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._kill()
        for t in self._threads:  # the readers end at EOF once the process is gone
            t.join(timeout=2)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            try:
                stream.close()
            except (OSError, ValueError):
                pass
        self._proc = None
        self._last_obs, self._done = None, False

    @staticmethod
    def named_global(obs):
        """{channel: value} of obs['global'] when it has the 20 GLOBAL_CHANNELS, else None."""
        g = obs.get("global") if isinstance(obs, dict) else None
        if g is None or len(g) != len(F.GLOBAL_CHANNELS):
            return None
        return {name: float(v) for name, v in zip(F.GLOBAL_CHANNELS, g)}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass
