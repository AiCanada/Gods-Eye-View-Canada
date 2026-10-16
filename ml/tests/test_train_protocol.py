"""train.py as a child process: the stdout events and the stdin pause / stop commands."""

import json
import unittest

import torch

from ml.gevtape import synth
from ml.gevtape import train
from ml.tests.support import PY, Child, TempDir, run_to_end


class TrainProtocolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = TempDir()
        cls.p = synth.make_gev_data(cls.tmp.path, scenarios=3, runs=2, days=12, bin_days=0, tape_hours=0)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.close()

    def args(self, out, *extra, epochs=3):
        return [PY, "-m", "ml.gevtape.train", "--data", self.p["root"], "--model", "outbreak", "--out", out,
                "--epochs", str(epochs), "--device", "cpu", "--threads", "1", "--context", "4", "--horizon", "4",
                "--hidden", "16", "--batch-size", "4", "--seed", "7", "--log-every", "1", *extra]

    def test_pause_then_resume_matches_an_uninterrupted_run(self):
        ref_dir = self.tmp.path / "ref"
        events, code, err = run_to_end(self.args(ref_dir))
        self.assertEqual(code, 0, err)
        self.assertEqual(events[-1], {"event": "done"})
        kinds = [e["event"] for e in events]
        self.assertEqual(kinds.count("metrics"), 3)
        self.assertEqual(kinds.count("checkpoint"), 3)
        prog = [e for e in events if e["event"] == "progress"]
        self.assertTrue(all(set(e) == {"event", "model", "epoch", "epochs", "step", "loss"} for e in prog))
        self.assertEqual(prog[0]["epoch"], 1)
        self.assertEqual(prog[-1]["epochs"], 3)
        steps_total = prog[-1]["step"]

        out = self.tmp.path / "paused"
        child = Child(self.args(out, "--sleep-ms", "40"))
        try:
            first = child.read_until(lambda e: e["event"] in ("progress", "error", "done"))
            self.assertEqual(first[-1]["event"], "progress", first)
            child.send({"cmd": "pause"})
            rest = child.read_until(lambda e: e["event"] in ("paused", "done", "error"))
            self.assertEqual(rest[-1], {"event": "paused"}, rest)
            self.assertEqual(rest[-2]["event"], "checkpoint")
            self.assertEqual(child.wait(30), 0)
        finally:
            child.close()
        ck = train.load_checkpoint(out / "checkpoint.pt")
        paused_step = ck["step"]
        self.assertLess(paused_step, steps_total)  # paused before the end
        self.assertTrue((out / "manifest.json").is_file())

        events2, code2, err2 = run_to_end(self.args(out, "--resume"))
        self.assertEqual(code2, 0, err2)
        self.assertEqual(events2[-1], {"event": "done"})
        prog2 = [e for e in events2 if e["event"] == "progress"]
        self.assertEqual(prog2[0]["step"], paused_step + 1)  # picks up at the next step
        self.assertEqual(prog2[-1]["step"], steps_total)

        a = train.load_checkpoint(ref_dir / "checkpoint.pt")["model"]
        b = train.load_checkpoint(out / "checkpoint.pt")["model"]
        self.assertEqual(set(a), set(b))
        for name in a:
            self.assertTrue(torch.equal(a[name], b[name]), f"{name} differs after pause + resume")
        ma = json.loads((ref_dir / "metrics.json").read_text(encoding="utf-8"))
        mb = json.loads((out / "metrics.json").read_text(encoding="utf-8"))
        self.assertEqual(ma["skill"], mb["skill"])
        man = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(man["licenceClasses"], ["open"])
        self.assertEqual(man["data"]["datasets"][0]["name"], "synthetic")
        self.assertEqual(man["data"]["worldId"], self.p["world_id"])

    def test_stop_checkpoints_then_done(self):
        out = self.tmp.path / "stopped"
        child = Child(self.args(out, "--sleep-ms", "40", epochs=50))
        try:
            child.read_until(lambda e: e["event"] == "progress")
            child.send_raw("this is not json\n")  # ignored
            child.send({"cmd": "stop"})
            rest = child.read_until(lambda e: e["event"] in ("paused", "done", "error"))
            self.assertEqual(rest[-1], {"event": "done"})
            self.assertEqual(rest[-2]["event"], "checkpoint")
            self.assertEqual(child.wait(30), 0)
        finally:
            child.close()
        ck = train.load_checkpoint(out / "checkpoint.pt")
        self.assertLess(ck["epoch"], 50)

    def test_missing_data_is_an_error_event(self):
        empty = self.tmp.path / "empty"
        empty.mkdir()
        events, code, _ = run_to_end(self.args(self.tmp.path / "x", epochs=1)[:4] + [empty] +
                                     self.args(self.tmp.path / "x", epochs=1)[5:])
        self.assertEqual(code, 1)
        self.assertEqual(events[-1]["event"], "error")
        self.assertIn("no outbreak datasets", events[-1]["message"])


if __name__ == "__main__":
    unittest.main()
