"""Real-data calibration (ml.gevtape.calibrate) on synthetic real-format arrays, CPU only."""

import json
import math
import unittest

import numpy as np
import torch

from ml.gevtape import calibrate as K
from ml.gevtape import formats as F
from ml.gevtape import models as M
from ml.gevtape import reader as R
from ml.gevtape import synth
from ml.gevtape import train
from ml.tests.support import PY, TempDir, run_to_end


def collect(events, control=None, pause_at=()):
    def emit(ev, **fields):
        events.append({"event": ev, **fields})
        if control is not None and ev == "progress" and fields.get("step") in pause_at:
            control.pause.set()
    return emit


class CalibrateTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)
        cls.tmp = TempDir()
        cls.p = synth.make_gev_data(cls.tmp.path, scenarios=3, runs=2, days=12, bin_days=0, tape_hours=0,
                                    demographics=True, real_days=90)
        cls.base = cls.tmp.path / "ai-world" / "models" / "outbreak"
        args = train.parse_args(["--data", str(cls.p["root"]), "--model", "outbreak", "--out", str(cls.base),
                                 "--epochs", "1", "--device", "cpu", "--hidden", "16", "--context", "4",
                                 "--horizon", "3", "--batch-size", "8"])
        assert train.run(args, lambda *a, **k: None, train.Control()) == 0
        cls.ck = train.load_checkpoint(cls.base / "checkpoint.pt")
        cls.real = R.load_real(cls.p["root"])
        cls.world = R.load_world(cls.p["world_dir"])
        cls.P = K.prepare(cls.real, world=cls.world, worldbank=R.load_worldbank(cls.p["root"]),
                          n_static=int(cls.ck["model_config"].get("n_static", 1)))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.close()

    def args(self, out, *extra, epochs=1):
        return K.parse_args(["--data", str(self.p["root"]), "--model-dir", str(self.base), "--out", str(out),
                             "--epochs", str(epochs), "--device", "cpu", "--log-every", "1", *extra])

    # ---- the mapping
    def test_prepare_shapes_and_mapping(self):
        P, real = self.P, self.real
        T, C = real.T, real.C
        self.assertEqual(P.x.shape, (T, C, 22))
        self.assertEqual(P.a.shape, (T, C, 14))
        self.assertEqual(P.e_policy.shape[-1] + P.e_state.shape[-1] + 4 + P.growth.shape[-1], len(K.EXTRA_FEATURES))
        self.assertEqual((P.y.shape, P.m.shape), ((T, C, 4), (T, C, 4)))
        self.assertTrue(np.isfinite(P.x).all() and np.isfinite(P.y).all() and np.isfinite(P.growth).all())
        # PN has no population: out of the loss; DD and PN have no world node: no travel links.
        self.assertFalse(P.keep[-1])
        self.assertFalse(P.m[:, -1].any())
        self.assertTrue(np.all(P.adj[3:] == 0) and np.all(P.adj[:, 3:] == 0))
        self.assertTrue(np.any(P.adj[:3, :3] > 0))
        self.assertTrue(any("PN" in n for n in P.notes))
        # Actions: lockdown -> place.lockdown, tracing -> global.tracingIsolate, window on when any action is.
        act = np.where(real.actions_mask, np.nan_to_num(real.actions), 0)
        li = F.OUTBREAK_ACTIONS.index("place.lockdown")
        ti = F.OUTBREAK_ACTIONS.index("global.tracingIsolate")
        self.assertTrue(np.allclose(P.a[..., li], act[..., real.action_index("lockdown")]))
        self.assertTrue(np.allclose(P.a[..., ti], act[..., real.action_index("tracing")]))
        self.assertTrue(np.array_equal(P.a[..., 0] > 0, act.max(axis=-1) > 0))
        self.assertTrue(np.allclose(P.e_policy[..., 0], act[..., real.action_index("testing")]))
        # Static: log population, then the World Bank shares (n_static of the base model).
        self.assertEqual(P.static.shape[0], C)

    def test_observation_function_reproduces_the_targets(self):
        P = self.P
        x = torch.from_numpy(P.x.astype(np.float64))
        obs = K.observe_step(x[:-1], x[1:] - x[:-1], torch.from_numpy(P.lscale.astype(np.float64))).numpy()
        m = P.m[1:]
        self.assertGreater(m.sum(), 100)
        np.testing.assert_allclose(obs[m], P.y[1:][m], atol=1e-2)
        # Hospital and ICU only where a country reports them (the first two).
        self.assertTrue(P.m[:, :2, 2].any() and not P.m[:, 2:, 2].any())

    def test_zero_shot_is_the_sim_model_and_the_anchor_is_persistence(self):
        cfg = self.ck["model_config"]
        base = M.build_model("outbreak", cfg)
        base.load_state_dict(self.ck["model"])
        zero = M.with_extra_inputs(base, len(K.EXTRA_FEATURES), skip=True)
        C = self.real.C
        torch.manual_seed(0)
        x = torch.rand(2, C, 22) * 10
        a, s, adj = torch.rand(2, C, 14), torch.rand(2, C, int(cfg.get("n_static", 1))), torch.rand(C, C)
        h = torch.zeros(2, C, int(cfg["hidden"]))
        d0, _ = base.step(x, a, s, h, adj)
        d1, _ = zero.step(x, a, s, h, adj, torch.randn(2, C, len(K.EXTRA_FEATURES)))
        self.assertTrue(torch.allclose(d0, d1, atol=1e-6))
        # A model that only repeats the day's counts (head zeroed, anchored skip) scores persistence exactly.
        m = K.anchor_to_yesterday(M.build_model("outbreak", zero.config))
        torch.nn.init.zeros_(m.head[-1].weight)
        torch.nn.init.zeros_(m.head[-1].bias)
        T, c, h_ = self.P.T, 14, 7
        cut = T - max(h_, round(0.2 * T))
        starts = list(range(cut - c, T - c - h_ + 1, h_))
        r = K.evaluate(m, self.P, starts, c, h_, K.Fixed(self.P, "cpu"), "cpu")
        self.assertGreater(r["cells"], 0)
        self.assertAlmostEqual(r["model"], r["persistence"], places=5)

    # ---- the job
    def test_run_writes_the_reports(self):
        out = self.tmp.path / "cal-run"
        events = []
        self.assertEqual(K.run(self.args(out), collect(events), train.Control()), 0)
        kinds = [e["event"] for e in events]
        self.assertEqual(kinds[-1], "done")
        self.assertEqual(events[0]["phase"], "zero-shot")
        phases = {e.get("phase") for e in events if e["event"] == "progress"}
        self.assertEqual(phases, {"finetune", "scratch"})
        prog = [e for e in events if e["event"] == "progress"]
        self.assertTrue(all(math.isfinite(e["loss"]) and e["epochs"] == 2 for e in prog))
        final = [e for e in events if e["event"] == "metrics"][-1]
        self.assertEqual(final["phase"], "summary")
        self.assertEqual(final["skill"], final["fineTuned"])
        metrics = json.loads((out / "metrics.json").read_text(encoding="utf-8"))
        for key in ("zeroShot", "fineTuned", "scratch"):
            self.assertTrue(math.isfinite(metrics[key]["model"]) and math.isfinite(metrics[key]["persistence"]), key)
            self.assertEqual(set(metrics[key]["byChannel"]), set(F.CALIBRATION_OBS))
            self.assertEqual(len(metrics[key]["byHorizon"]["model"]), 7)
        self.assertEqual(metrics["zeroShot"]["persistence"], metrics["scratch"]["persistence"])
        self.assertTrue(metrics["done"])
        self.assertEqual(metrics["split"]["heldOutDays"][1], str(self.real.date(self.real.T - 1)))
        md = (out / "calibration.md").read_text(encoding="utf-8")
        for row in ("| zero-shot (sim only) |", "| fine-tuned (sim, then real) |", "| real only (from scratch) |",
                    "Attribution: synthetic epidemic"):
            self.assertIn(row, md)
        man = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(man["model"], "outbreak-real")
        self.assertEqual(man["licenceClasses"], ["open"])
        self.assertEqual(man["attributions"], self.real.attributions)
        ck = train.load_checkpoint(out / "checkpoint.pt")
        self.assertEqual(ck["kind"], "outbreak-real")
        self.assertEqual(ck["model_config"]["n_extra"], len(K.EXTRA_FEATURES))
        again = M.build_model("outbreak", ck["model_config"])
        again.load_state_dict(ck["model"])

    def test_pause_and_resume_in_both_phases_match_an_uninterrupted_run(self):
        ref = self.tmp.path / "cal-ref"
        self.assertEqual(K.run(self.args(ref, epochs=2), collect([]), train.Control()), 0)
        out = self.tmp.path / "cal-paused"
        for pause_at in ((2,), (8,), ()):  # mid fine-tuning, mid scratch, then to the end
            events, control = [], train.Control()
            extra = ("--resume",) if (out / "checkpoint.pt").exists() else ()
            self.assertEqual(K.run(self.args(out, *extra, epochs=2), collect(events, control, pause_at), control), 0)
            self.assertEqual(events[-1]["event"], "paused" if pause_at else "done")
        a = train.load_checkpoint(ref / "checkpoint.pt")
        b = train.load_checkpoint(out / "checkpoint.pt")
        for part in ("model", "scratch_model"):
            for name in a[part]:
                self.assertTrue(torch.equal(a[part][name], b[part][name]), f"{part}.{name}")
        for key in ("zeroShot", "fineTuned", "scratch"):
            self.assertEqual(a["metrics"][key]["model"], b["metrics"][key]["model"], key)

    def test_errors(self):
        with self.assertRaises(train.DataError):
            K.run(K.parse_args(["--data", str(self.p["root"]), "--model-dir", str(self.tmp.path / "nowhere"),
                                "--out", str(self.tmp.path / "x")]), collect([]), train.Control())
        empty = self.tmp.path / "no-real"
        empty.mkdir()
        with self.assertRaises(train.DataError):
            K.run(K.parse_args(["--data", str(empty), "--model-dir", str(self.base),
                                "--out", str(self.tmp.path / "y")]), collect([]), train.Control())

    def test_cli(self):
        out = self.tmp.path / "cal-cli"
        events, code, err = run_to_end([PY, "-m", "ml.gevtape.calibrate", "--data", self.p["root"], "--model-dir",
                                        self.base, "--out", out, "--epochs", "1", "--device", "cpu", "--threads", "1"])
        self.assertEqual(code, 0, err)
        self.assertEqual(events[-1], {"event": "done"})
        self.assertTrue((out / "calibration.md").is_file())
        events, code, _ = run_to_end([PY, "-m", "ml.gevtape.calibrate", "--data", self.p["root"], "--model-dir",
                                      self.tmp.path / "nowhere", "--out", out])
        self.assertEqual(code, 1)
        self.assertIn("no sim surrogate", events[-1]["message"])


if __name__ == "__main__":
    unittest.main()
