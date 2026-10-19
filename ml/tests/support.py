"""Shared test helpers: temp .gev-data trees and a line-reading child process."""

from __future__ import annotations

import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PY = sys.executable


def child_env() -> dict:
    """The environment for child processes: no bytecode written, UTF-8 stdio."""
    env = dict(os.environ)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    # MLflow's usage telemetry stays off, as in the app (server/shared/mlflowJobs.mjs).
    env["MLFLOW_DISABLE_TELEMETRY"] = "true"
    env["DO_NOT_TRACK"] = "true"
    return env


class TempDir:
    """A temporary directory removed at close (errors ignored on Windows file locks)."""

    def __init__(self, prefix="gevtape-test-"):
        self.path = Path(tempfile.mkdtemp(prefix=prefix))

    def close(self):
        shutil.rmtree(self.path, ignore_errors=True)


class Child:
    """A child process whose stdout lines are read on a thread, so reads can time out."""

    def __init__(self, args, cwd=REPO_ROOT):
        self.proc = subprocess.Popen([str(a) for a in args], cwd=str(cwd), env=child_env(),
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE)
        self.lines = queue.Queue()
        self.stderr = []
        self.raw = []
        self._t = [threading.Thread(target=self._read_out, daemon=True),
                   threading.Thread(target=self._read_err, daemon=True)]
        for t in self._t:
            t.start()

    def _read_out(self):
        for raw in iter(self.proc.stdout.readline, b""):
            self.raw.append(raw)
            self.lines.put(raw)
        self.lines.put(None)

    def _read_err(self):
        for raw in iter(self.proc.stderr.readline, b""):
            self.stderr.append(raw.decode("utf-8", "replace"))

    def send(self, obj):
        self.proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def send_raw(self, text: str):
        self.proc.stdin.write(text.encode("utf-8"))
        self.proc.stdin.flush()

    def read(self, timeout=60.0):
        try:
            raw = self.lines.get(timeout=timeout)
        except queue.Empty:
            raise AssertionError(f"no output within {timeout} s; stderr: {''.join(self.stderr)[-2000:]}") from None
        if raw is None:
            raise AssertionError(f"process ended (code {self.proc.poll()}); stderr: {''.join(self.stderr)[-2000:]}")
        return json.loads(raw.decode("utf-8"))

    def read_until(self, pred, timeout=60.0):
        out = []
        while True:
            msg = self.read(timeout)
            out.append(msg)
            if pred(msg):
                return out

    def wait(self, timeout=60.0) -> int:
        return self.proc.wait(timeout=timeout)

    def close(self):
        if self.proc.poll() is None:
            try:
                self.proc.stdin.close()
                self.proc.wait(timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                self.proc.kill()
                self.proc.wait(timeout=10)
        for t in self._t:
            t.join(timeout=5)
        for s in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                s.close()
            except (OSError, ValueError):
                pass


def run_to_end(args, timeout=120.0):
    """Run a child to completion; returns (events, return code, stderr)."""
    c = Child(args)
    try:
        code = c.wait(timeout)
    finally:
        c.close()
    events = [json.loads(r.decode("utf-8")) for r in c.raw if r.strip()]
    return events, code, "".join(c.stderr)
