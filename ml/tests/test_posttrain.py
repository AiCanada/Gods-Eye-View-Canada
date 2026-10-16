"""Post-training an existing world model through an adapter (ml.gevtape.posttrain)."""

import json
import shutil
import unittest

from ml.gevtape import posttrain as P
from ml.gevtape import synth
from ml.gevtape import train
from ml.tests.support import TempDir


class PostTrainTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = TempDir()
        cls.p = synth.make_gev_data(cls.tmp.path, scenarios=1, runs=1, days=3, bin_days=4, tape_hours=0,
                                    markets=("gold",))
        # An existing world model, trained before the newest day was recorded.
        cls.base = cls.tmp.path / "existing"
        args = train.parse_args(["--data", str(cls.p["root"]), "--model", "world", "--out", str(cls.base),
                                 "--epochs", "1", "--device", "cpu", "--hidden", "8", "--batch-size", "8",
                                 "--context", "12", "--horizon", "6", "--stride", "6"])
        assert train.run(args, lambda *a, **k: None, train.Control()) == 0

    @classmethod
    def tearDownClass(cls):
        cls.tmp.close()

    def args(self, out, *extra):
        return P.build_parser().parse_args([
            "--data", str(self.p["root"]), "--adapter", "kit_world:KitWorldAdapter",
            "--checkpoint", str(self.base / "checkpoint.pt"), "--out", str(out), "--device", "cpu",
            "--context", "12", "--horizon", "6", "--epochs", "2", *extra])

    def test_the_existing_model_is_post_trained_and_scored_before_and_after(self):
        out = self.tmp.path / "post"
        events = []
        self.assertEqual(P.run(self.args(out), lambda e, **f: events.append((e, f)), train.Control()), 0)
        metrics = json.loads((out / "metrics.json").read_text())
        self.assertIsNotNone(metrics["heldOutLossBefore"])
        self.assertIsNotNone(metrics["heldOutLossAfter"])
        self.assertEqual(metrics["helped"], metrics["heldOutLossAfter"] < metrics["heldOutLossBefore"])
        self.assertEqual(metrics["heldOutDays"], [metrics["days"][-1]])
        self.assertIn("markets.gold", metrics["channels"])
        self.assertTrue((out / "model" / "checkpoint.pt").is_file())
        self.assertEqual([e for e, _ in events][-1], "done")
        self.assertTrue((self.base / "checkpoint.pt").is_file(), "the original is left as it was")

    def test_a_pause_saves_and_resume_carries_on(self):
        out = self.tmp.path / "paused"
        control = train.Control()
        control.pause.set()
        events = []
        self.assertEqual(P.run(self.args(out), lambda e, **f: events.append((e, f)), control), 0)
        self.assertIn("paused", [e for e, _ in events])
        state = json.loads((out / "posttrain-state.json").read_text())
        self.assertTrue(state["saved"])
        events = []
        self.assertEqual(P.run(self.args(out, "--resume"), lambda e, **f: events.append((e, f)), train.Control()), 0)
        self.assertEqual([e for e, _ in events][-1], "done")
        self.assertTrue((out / "metrics.json").is_file())

    def test_only_adapters_in_the_adapter_folders_are_imported(self):
        for spec in ["../evil:X", "os:system", "kit_world", "Kit:X"]:
            with self.assertRaises(train.DataError):
                P.load_adapter_class(spec, self.p["root"])
        mine = self.p["root"] / "ai-world" / "adapters"
        mine.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(P.REPO_ROOT / "ml" / "adapters" / "kit_world.py", mine / "my_model.py")
        cls, path = P.load_adapter_class("my_model:KitWorldAdapter", self.p["root"])
        self.assertEqual(cls.__name__, "KitWorldAdapter")
        self.assertEqual(path, mine / "my_model.py")
        with self.assertRaises(train.DataError):
            P.load_adapter_class("my_model:Missing", self.p["root"])


if __name__ == "__main__":
    unittest.main()
