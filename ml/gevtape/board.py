"""TensorBoard scalars with nothing but the standard library, for every trainer.

torch.utils.tensorboard and tf.summary both bring TensorFlow into the
process (the first through tensorboard.compat whenever TensorFlow is
installed), which a PyTorch trainer has no use for. A scalar event is small
enough to write by hand: an Event protocol buffer (wall_time, step, one
Summary.Value with a tag and a simple_value) framed as a TFRecord (length,
masked CRC-32C of the length, the bytes, masked CRC-32C of the bytes), in a
file whose name holds "tfevents". TensorBoard reads these as its own.

    board = Board(".gev-data/ai-world/tensorboard/world")   # None: writes nothing
    board.scalars(step, {"train/loss": 0.12})
    board.skill(step, metrics)   # held-out MAE and persistence, overall and per domain
"""

from __future__ import annotations

import os
import socket
import struct
import time
from pathlib import Path


def _crc32c_table():
    table = []
    for n in range(256):
        c = n
        for _ in range(8):
            c = (c >> 1) ^ 0x82F63B78 if c & 1 else c >> 1
        table.append(c)
    return table


_TABLE = _crc32c_table()


def crc32c(data: bytes) -> int:
    c = 0xFFFFFFFF
    for b in data:
        c = _TABLE[(c ^ b) & 0xFF] ^ (c >> 8)
    return c ^ 0xFFFFFFFF


def masked_crc(data: bytes) -> int:
    c = crc32c(data)
    return (((c >> 15) | (c << 17)) + 0xA282EAD8) & 0xFFFFFFFF


def _varint(n: int) -> bytes:
    n &= (1 << 64) - 1
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _field(number: int, wire: int) -> bytes:
    return _varint((number << 3) | wire)


def _bytes_field(number: int, data: bytes) -> bytes:
    return _field(number, 2) + _varint(len(data)) + data


def event(wall_time: float, step: int = 0, *, file_version: str | None = None, scalars=None) -> bytes:
    """One serialized tensorflow.Event: a file version, or scalar values."""
    out = _field(1, 1) + struct.pack("<d", float(wall_time)) + _field(2, 0) + _varint(int(step))
    if file_version is not None:
        out += _bytes_field(3, file_version.encode("utf-8"))
    if scalars:
        summary = b"".join(
            _bytes_field(1, _bytes_field(1, str(tag).encode("utf-8")) + _field(2, 5) + struct.pack("<f", float(v)))
            for tag, v in scalars.items())
        out += _bytes_field(5, summary)
    return out


def record(data: bytes) -> bytes:
    """A TFRecord: length, its masked CRC-32C, the data, its masked CRC-32C."""
    length = struct.pack("<Q", len(data))
    return length + struct.pack("<I", masked_crc(length)) + data + struct.pack("<I", masked_crc(data))


class Board:
    """Scalars for TensorBoard in `logdir`, or nothing when logdir is empty."""

    def __init__(self, logdir):
        self.path = None
        if not logdir:
            return
        folder = Path(logdir)
        folder.mkdir(parents=True, exist_ok=True)
        now = time.time()
        host = "".join(ch for ch in socket.gethostname() if ch.isalnum() or ch in "-_") or "host"
        self.path = folder / f"events.out.tfevents.{int(now)}.{host}.{os.getpid()}.gev"
        self._write(event(now, file_version="brain.Event:2"))

    def _write(self, data: bytes):
        with open(self.path, "ab") as f:
            f.write(record(data))

    def scalars(self, step, values):
        if self.path is None:
            return
        kept = {k: float(v) for k, v in values.items() if v is not None and float(v) == float(v)}
        if kept:
            self._write(event(time.time(), int(step), scalars=kept))

    def skill(self, step, metrics):
        """Held-out MAE against persistence, overall and per domain."""
        skill = (metrics or {}).get("skill") or {}
        out = {"held-out/mae": skill.get("model"), "held-out/persistence": skill.get("persistence")}
        for dom, sk in ((metrics or {}).get("domains") or {}).items():
            if isinstance(sk, dict):
                out[f"domain/{dom}/mae"] = sk.get("model")
                out[f"domain/{dom}/persistence"] = sk.get("persistence")
        self.scalars(step, out)
