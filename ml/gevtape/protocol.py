"""The child-process protocol shared by every runner (docs/AI-WORLD-TAB.md,
"Child-process protocol"), with nothing from PyTorch or TensorFlow in it:
the TensorFlow runners (ml.gevtape.tf_train, tf_export, tf_posttrain) run in
a Python that has no torch, and the PyTorch ones import the same helpers
through ml.gevtape.train.

stdout carries only protocol lines, one JSON object each (Emitter); stdin
takes {"cmd":"pause"} and {"cmd":"stop"} (Control). Anything human-readable
goes to stderr (log).
"""

from __future__ import annotations

import json
import math
import os
import sys
import threading
import time
from pathlib import Path

import numpy as np

MODEL_FORMAT = "gevtape-model/1"
LOCAL_ONLY_NOTE = ("Trained locally for the AI World tab. Not for publication: only 'open' "
                   "data may ever enter something published, and only with the owner's say.")


class DataError(RuntimeError):
    """The data needed for a model is missing or too short."""


def _clean(value):
    """JSON-safe: non-finite floats become null, numpy scalars plain numbers."""
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    if isinstance(value, (np.floating, float)):
        v = float(value)
        return v if math.isfinite(v) else None
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.bool_):
        return bool(value)
    return value


class Emitter:
    """Writes protocol events as JSON lines (ASCII, LF only) to stdout or a given stream."""

    def __init__(self, stream=None):
        self.stream = stream if stream is not None else sys.stdout
        self.lock = threading.Lock()

    def __call__(self, event: str, **fields):
        line = json.dumps(_clean({"event": event, **fields}), separators=(",", ":"))
        with self.lock:
            raw = getattr(self.stream, "buffer", None)
            if raw is not None:  # bytes: no CRLF translation on Windows
                self.stream.flush()
                raw.write(line.encode("ascii") + b"\n")
                raw.flush()
            else:
                self.stream.write(line + "\n")
                self.stream.flush()


class Control:
    """Pause / stop requests, set from stdin (listen) or directly (tests)."""

    def __init__(self):
        self.pause = threading.Event()
        self.stop = threading.Event()

    def requested(self):
        if self.stop.is_set():
            return "stop"
        if self.pause.is_set():
            return "pause"
        return None

    def handle(self, line: str):
        try:
            cmd = json.loads(line).get("cmd")
        except (ValueError, AttributeError):
            return
        if cmd == "pause":
            self.pause.set()
        elif cmd == "stop":
            self.stop.set()

    def listen(self, fd: int):
        """Read commands from a file descriptor on a daemon thread (os.read: no
        buffered-reader lock is held, so interpreter shutdown never waits on it)."""

        def run():
            buf = b""
            while True:
                try:
                    chunk = os.read(fd, 4096)
                except OSError:
                    return
                if not chunk:
                    return  # EOF: the server closed our stdin; keep training
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    self.handle(line.decode("utf-8", "replace"))

        t = threading.Thread(target=run, name="gevtape-stdin", daemon=True)
        t.start()
        return t


def log(*parts):
    print(*parts, file=sys.stderr, flush=True)


def now_ms() -> int:
    return int(time.time() * 1000)


def atomic_json(path: Path, obj):
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(_clean(obj), f, indent=1)
        f.write("\n")
    os.replace(tmp, path)
