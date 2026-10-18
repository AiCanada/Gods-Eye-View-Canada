"""The AI World tab's TENSORFLOW sections: the Keras world model (ml.gevtape.tf_world,
tf_train), the export (tf_export), post-training (tf_posttrain with
ml/adapters/keras_world.py) and the TensorBoard writer every trainer shares
(ml.gevtape.board). The TensorFlow tests skip when this Python has no
TensorFlow; the writer and the torch-free imports are tested regardless."""

import importlib.util
import json
import struct
import subprocess
import sys
import unittest

import numpy as np

from ml.gevtape import board as B
from ml.gevtape import protocol, synth, train
from ml.tests.support import REPO_ROOT, TempDir, child_env

HAS_TF = importlib.util.find_spec("tensorflow") is not None


def read_records(path):
    """Every TFRecord in a file, CRCs checked."""
    data = path.read_bytes()
    out, at = [], 0
    while at < len(data):
        (n,) = struct.unpack("<Q", data[at: at + 8])
        (crc,) = struct.unpack("<I", data[at + 8: at + 12])
        assert crc == B.masked_crc(data[at: at + 8]), "length CRC"
        body = data[at + 12: at + 12 + n]
        (crc,) = struct.unpack("<I", data[at + 12 + n: at + 16 + n])
        assert crc == B.masked_crc(body), "data CRC"
        out.append(body)
        at += 16 + n
    return out


class BoardTest(unittest.TestCase):
    def test_crc32c_is_the_castagnoli_checksum(self):
        self.assertEqual(B.crc32c(b"123456789"), 0xE3069283)
        self.assertEqual(B.crc32c(b""), 0)

    def test_scalars_are_framed_records_with_a_file_version_first(self):
        tmp = TempDir()
        try:
            board = B.Board(tmp.path / "run")
            board.scalars(10, {"train/loss": 0.5, "skipped": float("nan"), "none": None})
            board.skill(10, {"skill": {"model": 0.2, "persistence": 0.3},
                             "domains": {"hazards": {"model": 0.1, "persistence": 0.15}, "news": None}})
            files = list((tmp.path / "run").glob("events.out.tfevents.*"))
            self.assertEqual(len(files), 1)
            records = read_records(files[0])
            self.assertEqual(len(records), 3)
            self.assertIn(b"brain.Event:2", records[0])
            self.assertIn(b"train/loss", records[1])
            self.assertNotIn(b"skipped", records[1])
            self.assertIn(b"domain/hazards/persistence", records[2])
            self.assertNotIn(b"domain/news", records[2])
        finally:
            tmp.close()

    def test_no_folder_writes_nothing(self):
        board = B.Board(None)
        board.scalars(1, {"x": 1.0})
        self.assertIsNone(board.path)

    @unittest.skipUnless(importlib.util.find_spec("tensorboard") is not None, "no tensorboard")
    def test_tensorboard_reads_the_events(self):
        from tensorboard.backend.event_processing import event_accumulator as ea

        tmp = TempDir()
        try:
            board = B.Board(tmp.path / "run")
            for step in (1, 2, 3):
                board.scalars(step, {"train/loss": 1.0 / step})
            acc = ea.EventAccumulator(str(tmp.path / "run"))
            acc.Reload()
            values = [(e.step, round(e.value, 4)) for e in acc.Scalars("train/loss")]
            self.assertEqual(values, [(1, 1.0), (2, 0.5), (3, 0.3333)])
        finally:
            tmp.close()


class TorchFreeTest(unittest.TestCase):
    def test_the_protocol_is_one_class_for_both_frameworks(self):
        self.assertIs(train.DataError, protocol.DataError)
        self.assertIs(train.Emitter, protocol.Emitter)
        self.assertIs(train.Control, protocol.Control)

    def test_the_tensorflow_side_imports_without_torch(self):
        code = ("import sys; sys.modules['torch'] = None\n"
                "from ml.gevtape import adapters, board, protocol, tf_world, torch_data\n"
                "assert 'torch' not in [m for m in sys.modules if sys.modules[m] is not None]\n"
                "w = torch_data.BinWindows\n"
                "print('ok')")
        out = subprocess.run([sys.executable, "-c", code], cwd=REPO_ROOT, env=child_env(), capture_output=True,
                             text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr[-2000:])
        self.assertEqual(out.stdout.strip(), "ok")


def window(v, m, context, horizon, n_static=4):
    """One BinWindows-shaped window from [L, P, C] values and mask."""
    L, P, C = v.shape
    assert L == context + horizon
    return {"v": v.astype(np.float32), "m": m.astype(np.float32),
            "tf": np.zeros((L, P, 6), np.float32), "s": np.zeros((P, n_static), np.float32)}


@unittest.skipUnless(HAS_TF, "no tensorflow in this Python")
class KerasWorldModelTest(unittest.TestCase):
    def test_rows_carry_the_last_observed_value_and_mask_only_seen_channels(self):
        from ml.gevtape import tf_world as W

        c, h = 4, 2
        v = np.zeros((c + h, 2, 2))
        m = np.zeros((c + h, 2, 2))
        v[1, 0, 0], m[1, 0, 0] = 5.0, 1  # place 0, channel 0: seen at hour 1
        v[2, 0, 0], m[2, 0, 0] = 7.0, 1  # ... and last at hour 2
        v[4, 0, 0], m[4, 0, 0] = 9.0, 1  # a target
        v[4, 0, 1], m[4, 0, 1] = 3.0, 1  # channel 1 is never seen in the context: not scored
        v[5, 1, 0], m[5, 1, 0] = 1.0, 1  # place 1 has no context at all
        rows, target, mask = W.place_rows(window(v, m, c, h), c, h)
        self.assertEqual(rows["context"].shape, (1, c, 2 * 2 + 6), "place 1 has nothing to score")
        self.assertEqual(rows["last"].tolist(), [[7.0, 0.0]])
        self.assertEqual(rows["seen"].tolist(), [[1.0, 0.0]])
        self.assertEqual(mask.sum(), 1.0)
        self.assertEqual(target[0, 0, 0], 9.0)
        rows, _, _ = W.place_rows(window(v, m, c, h), c, h, keep_empty=True)
        self.assertEqual(rows["last"].shape, (2, 2))

    def test_an_untrained_model_is_persistence(self):
        from ml.gevtape import tf_world as W

        model = W.build_model(3, 4, context=6, horizon=4, hidden=8)
        rng = np.random.default_rng(0)
        rows = {"context": rng.normal(size=(5, 6, 12)).astype(np.float32),
                "future": rng.normal(size=(5, 4, 6)).astype(np.float32),
                "static": rng.normal(size=(5, 4)).astype(np.float32),
                "last": rng.normal(size=(5, 3)).astype(np.float32),
                "seen": np.ones((5, 3), np.float32)}
        pred = np.asarray(model(rows))
        self.assertEqual(pred.shape, (5, 4, 3))
        np.testing.assert_allclose(pred, np.repeat(rows["last"][:, None, :], 4, axis=1), atol=1e-6)
        self.assertEqual(W.model_shape(model), (3, 4, 6, 4))

    def test_a_grown_model_keeps_what_it_knew_and_starts_new_channels_at_persistence(self):
        from ml.gevtape import tf_world as W

        old, new = ["a.x", "b.y"], ["b.y", "n.new", "a.x"]
        model = W.build_model(2, 4, context=6, horizon=4, hidden=8)
        rng = np.random.default_rng(1)
        for layer in model.layers:
            weights = layer.get_weights()
            if weights:
                layer.set_weights([rng.normal(scale=0.3, size=w.shape).astype(w.dtype) for w in weights])
        grown = W.grow_model(model, old, new)
        self.assertEqual(W.model_shape(grown), (3, 4, 6, 4))
        n = 4
        ctx = rng.normal(size=(n, 6, 2 * 2 + 6)).astype(np.float32)
        last = rng.normal(size=(n, 2)).astype(np.float32)
        base = {"future": rng.normal(size=(n, 4, 6)).astype(np.float32),
                "static": rng.normal(size=(n, 4)).astype(np.float32)}
        a = np.asarray(model({**base, "context": ctx, "last": last, "seen": np.ones((n, 2), np.float32)}))

        def reorder(block):  # [..., 2] old order -> [..., 3] new order, the new channel empty
            return np.stack([block[..., 1], np.zeros_like(block[..., 0]), block[..., 0]], axis=-1)

        ctx_new = np.concatenate([reorder(ctx[..., :2]), reorder(ctx[..., 2:4]), ctx[..., 4:]], axis=-1)
        b = np.asarray(grown({**base, "context": ctx_new, "last": reorder(last),
                              "seen": reorder(np.ones((n, 2), np.float32))}))
        np.testing.assert_allclose(b[..., 0], a[..., 1], rtol=1e-4, atol=1e-4)
        np.testing.assert_allclose(b[..., 2], a[..., 0], rtol=1e-4, atol=1e-4)
        np.testing.assert_allclose(b[..., 1], 0.0, atol=1e-7)


@unittest.skipUnless(HAS_TF, "no tensorflow in this Python")
class TensorflowRunnersTest(unittest.TestCase):
    """tf_train, tf_export and tf_posttrain on a small synthetic .gev-data tree."""

    @classmethod
    def setUpClass(cls):
        from ml.gevtape import tf_train

        cls.tmp = TempDir()
        cls.p = synth.make_gev_data(cls.tmp.path, scenarios=1, runs=1, days=3, bin_days=4, tape_hours=0,
                                    markets=("gold",))
        cls.model = cls.tmp.path / "tf-world"
        cls.events = []
        args = tf_train.build_parser().parse_args([
            "--data", str(cls.p["root"]), "--out", str(cls.model), "--epochs", "1", "--device", "cpu",
            "--hidden", "8", "--context", "12", "--horizon", "6", "--stride", "6",
            "--tensorboard", str(cls.tmp.path / "board" / "tf-world")])
        cls.code = tf_train.run(args, lambda e, **f: cls.events.append((e, f)), protocol.Control())

    @classmethod
    def tearDownClass(cls):
        cls.tmp.close()

    def test_training_writes_the_model_and_scores_it_against_persistence(self):
        self.assertEqual(self.code, 0)
        kinds = [e for e, _ in self.events]
        self.assertEqual(kinds[0], "progress")
        self.assertEqual(self.events[0][1]["device"], "CPU")
        self.assertIn("metrics", kinds)
        self.assertEqual(kinds[-1], "done")
        metrics = json.loads((self.model / "metrics.json").read_text())
        self.assertEqual(metrics["framework"], "tensorflow")
        self.assertEqual(metrics["skill"]["metric"], "mae")
        self.assertIsNotNone(metrics["skill"]["persistence"])
        self.assertEqual(len(metrics["heldOutDays"]), 1)
        manifest = json.loads((self.model / "manifest.json").read_text())
        self.assertIn("markets.gold", manifest["data"]["channels"])
        self.assertTrue((self.model / "model.keras").is_file())
        self.assertTrue(list((self.tmp.path / "board" / "tf-world").glob("events.out.tfevents.*")))

    def test_a_pause_saves_the_step_and_resume_finishes_the_epoch(self):
        from ml.gevtape import tf_train

        out = self.tmp.path / "paused"
        argv = ["--data", str(self.p["root"]), "--out", str(out), "--epochs", "1", "--device", "cpu",
                "--hidden", "8", "--context", "12", "--horizon", "6", "--stride", "6", "--batch-size", "1"]
        control = protocol.Control()
        control.pause.set()
        events = []
        self.assertEqual(tf_train.run(tf_train.build_parser().parse_args(argv), lambda e, **f: events.append(e),
                                      control), 0)
        self.assertEqual(events[-1], "paused")
        state = json.loads((out / "state.json").read_text())
        self.assertEqual((state["epoch"], state["stepInEpoch"]), (0, 1))
        events = []
        self.assertEqual(tf_train.run(tf_train.build_parser().parse_args(argv + ["--resume"]),
                                      lambda e, **f: events.append(e), protocol.Control()), 0)
        self.assertEqual(events[-1], "done")
        self.assertEqual(json.loads((out / "state.json").read_text())["epoch"], 1)

    def test_the_export_holds_tfrecords_a_savedmodel_and_a_checked_tflite(self):
        import tensorflow as tf

        from ml.gevtape import tf_export

        out = self.tmp.path / "export"
        result = tf_export.export(self.p["root"], out, model_dir=self.model)
        self.assertEqual(result["format"], "gev-tensorflow-export/1")
        self.assertTrue(result["model"]["tflite"]["ok"], result["model"]["tflite"])
        self.assertTrue((out / "savedmodel" / "saved_model.pb").is_file())
        self.assertTrue((out / "model.tflite").is_file())
        spec = json.loads((out / "tfrecord" / "spec.json").read_text())
        self.assertEqual(len(list((out / "tfrecord").glob("*.tfrecord"))), len(result["days"]))
        feature = {"hour_ms": tf.io.FixedLenFeature([1], tf.int64), "place": tf.io.VarLenFeature(tf.int64),
                   "channel": tf.io.VarLenFeature(tf.int64), "value": tf.io.VarLenFeature(tf.float32)}
        first = sorted((out / "tfrecord").glob("*.tfrecord"))[0]
        hours = [tf.io.parse_single_example(raw, feature) for raw in tf.data.TFRecordDataset(str(first))]
        self.assertEqual(len(hours), 24)
        self.assertEqual(int(hours[1]["hour_ms"][0]) - int(hours[0]["hour_ms"][0]), 3_600_000)
        total = sum(int(tf.size(h["value"].values)) for h in hours)
        bins = self.p["root"] / "bins"
        day = first.stem
        y, m, d = day.split("-")
        observed = sum(int(np.isfinite(np.load(f)).sum())
                       for f in (bins / self.p["world_id"] / y / m).glob(f"{d}.*.npy"))
        self.assertEqual(total, observed, "every observed entry, and nothing that was not observed")
        self.assertTrue(all(0 <= int(c) < len(spec["channels"]) for h in hours for c in h["channel"].values))
        self.assertIn("TFRecordDataset", (out / "TENSORFLOW.md").read_text(encoding="utf-8"))

    def test_the_keras_model_is_post_trained_and_scored_before_and_after(self):
        from ml.gevtape import tf_posttrain as P

        out = self.tmp.path / "post"
        events = []
        args = P.build_parser().parse_args([
            "--data", str(self.p["root"]), "--checkpoint", str(self.model), "--out", str(out), "--device", "cpu",
            "--epochs", "1", "--context", "24", "--horizon", "24"])
        self.assertEqual(P.run(args, lambda e, **f: events.append((e, f)), protocol.Control()), 0)
        metrics = json.loads((out / "metrics.json").read_text())
        self.assertEqual(metrics["framework"], "tensorflow")
        self.assertIsNotNone(metrics["heldOutLossBefore"])
        self.assertIsNotNone(metrics["heldOutLossAfter"])
        self.assertEqual(metrics["helped"], metrics["heldOutLossAfter"] < metrics["heldOutLossBefore"])
        self.assertTrue((out / "model" / "model.keras").is_file())
        self.assertEqual([e for e, _ in events][-1], "done")
        # The adapter read the model's own window (12 + 6), not the one asked for.
        self.assertEqual((metrics["contextHours"], metrics["horizonHours"]), (12, 6))
        self.assertTrue(any(f.get("device") == "CPU" for e, f in events if e == "progress"))

    def test_only_adapters_in_the_adapter_folders_are_imported(self):
        from ml.gevtape.adapters import load_adapter_class

        cls, path = load_adapter_class("keras_world:KerasWorldAdapter", self.p["root"])
        self.assertEqual(cls.__name__, "KerasWorldAdapter")
        self.assertEqual(path.name, "keras_world.py")
        for spec in ("os:system", "../x:Y", "keras_world"):
            with self.assertRaises(protocol.DataError):
                load_adapter_class(spec, self.p["root"])


if __name__ == "__main__":
    unittest.main()
