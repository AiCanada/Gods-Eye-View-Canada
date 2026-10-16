import datetime as dt
import json
import math
import unittest

import numpy as np
import torch
import torch.nn.functional as Fn
from torch.utils.data import DataLoader

from ml.gevtape import formats as F
from ml.gevtape import models as M
from ml.gevtape import reader as R
from ml.gevtape import synth
from ml.gevtape import torch_data as td
from ml.gevtape import train
from ml.tests.support import TempDir


def overfit(model, loss_fn, steps=40, lr=1e-2):
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    first = None
    for _ in range(steps):
        loss = loss_fn()
        if first is None:
            first = float(loss.detach())
        opt.zero_grad()
        loss.backward()
        opt.step()
    return first, float(loss_fn().detach())


class ModelsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        torch.set_num_threads(2)
        cls.tmp = TempDir()
        cls.p = synth.make_gev_data(cls.tmp.path, scenarios=3, runs=2, days=10, bin_days=3, tape_hours=3)
        cls.world = R.load_world(cls.p["world_dir"])

    @classmethod
    def tearDownClass(cls):
        cls.tmp.close()

    def test_outbreak_surrogate_learns_and_stays_monotone(self):
        torch.manual_seed(0)
        ds = td.EpisodeWindows(self.p["dataset_dir"], world=self.world, context=4, horizon=3, seed=0)
        b = next(iter(DataLoader(ds, batch_size=8)))
        adj = M.dense_to_tensor(R.normalized_adjacency(R.country_graph(self.world)))
        model = M.OutbreakSurrogate(n_static=1, hidden=16)
        x, a, s = b["x"], b["a"], b["s"]

        def loss_fn():
            return Fn.mse_loss(model(x, a, s, adj), x[:, 1:] - x[:, :-1])
        first, last = overfit(model, loss_fn)
        self.assertTrue(math.isfinite(first) and math.isfinite(last))
        self.assertLess(last, first)
        pred = model.rollout(x[:, :4], a, s, adj, 3)
        self.assertEqual(tuple(pred.shape), (8, 3, 4, 22))
        mono = [F.OUTBREAK_FEATURES.index(f) for f in F.MONOTONE_FEATURES]
        seq = torch.cat([x[:, 3:4], pred], dim=1)[..., mono]
        self.assertTrue((seq[:, 1:] >= seq[:, :-1] - 1e-6).all())  # cumulative channels never fall

    def test_untrained_surrogate_is_near_persistence(self):
        model = M.OutbreakSurrogate(n_static=1, hidden=8)
        x = torch.rand(2, 5, 3, 22) * 10
        d = model(x, torch.zeros(2, 4, 3, 14), torch.zeros(2, 3, 1), torch.zeros(3, 3))
        self.assertLess(float(d.detach().abs().max()), 0.02)

    def test_world_model_learns_and_starts_at_persistence(self):
        torch.manual_seed(0)
        ser = td.load_bin_series(self.p["bins_dir"])
        ds = td.BinWindows(ser, world=self.world, context=12, horizon=6, stride=3, seed=0)
        b = next(iter(DataLoader(ds, batch_size=4)))
        r, c, w = R.place_edges(self.world)
        adj = M.adjacency_tensor(r, c, w, self.world.K)
        model = M.WorldModel(n_channels=len(ser["channels"]), hidden=16)
        v, m, tf, s = b["v"], b["m"], b["tf"], b["s"]
        pred, seen = model.rollout(v[:, :12], m[:, :12], tf, s, adj, 6)
        last = torch.zeros_like(v[:, 0])
        for t in range(12):
            last = torch.where(m[:, t] > 0, v[:, t], last)
        self.assertTrue(torch.allclose(pred, last.unsqueeze(1).expand_as(pred)))  # zero head = persistence

        def loss_fn():
            p = model(v, m, tf, s, adj)
            wgt = m[:, 1:]
            return ((p - v[:, 1:]) ** 2 * wgt).sum() / wgt.sum()
        first, last_loss = overfit(model, loss_fn)
        self.assertLess(last_loss, first)

    def test_track_predictor_starts_at_baseline_and_learns(self):
        torch.manual_seed(0)
        ds = td.TrackWindows(self.p["tape_dir"], days=[dt.date(2026, 10, 1)], seed=0)
        b = next(iter(DataLoader(ds, batch_size=64)))
        model = M.TrackPredictor(hidden=16)
        out = model(b["feats"], b["kind"], b["base"])
        self.assertTrue(torch.equal(out, b["base"]))

        def loss_fn():
            p = model(b["feats"], b["kind"], b["base"])
            wgt = b["tmask"].unsqueeze(-1)
            return (Fn.smooth_l1_loss(p, b["target"], reduction="none") * wgt).sum() / wgt.sum()
        first, last = overfit(model, loss_fn, steps=30, lr=3e-3)
        self.assertLess(last, first)

    def test_world_training_rollout_matches_eval_rollout(self):
        torch.manual_seed(0)
        model = M.WorldModel(n_channels=2, hidden=8)
        v = torch.randn(1, 4, 2, 2)
        m = torch.ones(1, 4, 2, 2)
        tf = torch.randn(1, 7, 2, 6)
        s = torch.randn(1, 2, 4)
        adj = torch.eye(2)
        with torch.no_grad():
            rolled, seen_r = model.rollout(v, m, tf, s, adj, 3)
            trained, seen_t = model.predict_forward(v, m, tf, s, adj, 3)
        self.assertTrue(torch.allclose(rolled, trained))
        self.assertTrue(torch.equal(seen_r, seen_t))

    def test_world_loss_does_not_drown_a_rare_channel(self):
        pred = torch.zeros(1, 2, 1, 2)
        target = torch.zeros(1, 2, 1, 2)
        target[0, 0, 0, 1] = 1.0
        mask = torch.zeros(1, 2, 1, 2)
        mask[0, :, 0, 0] = 1.0
        mask[0, 0, 0, 1] = 1.0
        loss = train.balanced_channel_loss(pred, target, mask)
        self.assertAlmostEqual(float(loss), 0.5, places=5)
        mask[0, 0, 0, 1] = 0.0
        quiet = train.balanced_channel_loss(pred, target, mask)
        self.assertAlmostEqual(float(quiet), 0.0, places=5)

    def test_world_crop_adjacency(self):
        args = train.parse_args(["--data", str(self.p["root"]), "--model", "world", "--out", str(self.tmp.path / "w"),
                                 "--context", "12", "--horizon", "6", "--max-places", "4"])
        task = train.WorldTask(args)
        idx = torch.tensor([[0, 1, 2, 3], [1, 2, 4, 5]])
        A = task.crop_adjacency(idx, torch.device("cpu"))
        self.assertEqual(tuple(A.shape), (2, 4, 4))
        sums = A.sum(dim=-1)
        self.assertTrue(torch.all((torch.abs(sums - 1) < 1e-5) | (sums == 0)))
        self.assertTrue(torch.all(A.diagonal(dim1=1, dim2=2) == 0))
        full = task.crop_adjacency(torch.arange(6)[None], torch.device("cpu"))
        self.assertIs(full, task.adj)  # every place: the shared full graph

    def test_sparse_graph_matches_dense(self):
        rng = np.random.default_rng(0)
        A = rng.random((5, 5)) * (rng.random((5, 5)) > 0.5)
        h = torch.randn(3, 5, 4)
        dense = M.dense_to_tensor(A)
        sparse = M.dense_to_tensor(A, dense_limit=2)
        self.assertTrue(sparse.is_sparse)
        self.assertTrue(torch.allclose(M.aggregate(dense, h), M.aggregate(sparse, h), atol=1e-6))

    def test_build_model_round_trip(self):
        for kind, model in (("outbreak", M.OutbreakSurrogate(n_static=2, hidden=8)),
                            ("world", M.WorldModel(n_channels=3, hidden=8)),
                            ("tracks", M.TrackPredictor(hidden=8))):
            again = M.build_model(kind, model.config)
            again.load_state_dict(model.state_dict())
            self.assertEqual(M.count_parameters(again), M.count_parameters(model))

    def test_trainer_runs_each_model_two_epochs(self):
        for kind, extra in (("outbreak", ["--context", "4", "--horizon", "3"]),
                            ("world", ["--context", "12", "--horizon", "6", "--stride", "3", "--max-places", "4"]),
                            ("tracks", [])):
            out = self.tmp.path / "models" / kind
            events = []
            args = train.parse_args(["--data", str(self.p["root"]), "--model", kind, "--out", str(out),
                                     "--epochs", "2", "--device", "cpu", "--hidden", "16",
                                     "--log-every", "1", "--batch-size", "8"] + extra)
            code = train.run(args, lambda ev, **f: events.append({"event": ev, **f}), train.Control())
            self.assertEqual(code, 0, kind)
            losses = [e["loss"] for e in events if e["event"] == "progress"]
            self.assertTrue(losses and all(isinstance(x, float) and math.isfinite(x) for x in losses), kind)
            self.assertEqual(events[-1]["event"], "done")
            self.assertEqual(sum(e["event"] == "metrics" for e in events), 2)
            metrics = json.loads((out / "metrics.json").read_text(encoding="utf-8"))
            self.assertEqual(metrics["skill"]["metric"], "mae", kind)
            self.assertTrue(math.isfinite(metrics["skill"]["model"]) and math.isfinite(metrics["skill"]["persistence"]))
            manifest = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
            self.assertTrue(manifest["licenceClasses"], kind)
            self.assertTrue(all(c in F.LICENCE_CLASSES for c in manifest["licenceClasses"]), kind)
            ck = train.load_checkpoint(out / "checkpoint.pt")  # weights_only load works
            self.assertEqual((ck["kind"], ck["epoch"], ck["step_in_epoch"]), (kind, 2, 0))
        tracks = json.loads((self.tmp.path / "models" / "tracks" / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(tracks["licenceClasses"], ["nc", "open", "unclear"])
        self.assertFalse(tracks["openOnly"])
        outbreak = json.loads((self.tmp.path / "models" / "outbreak" / "metrics.json").read_text(encoding="utf-8"))
        self.assertIn("counterfactual", outbreak)
        self.assertGreater(outbreak["counterfactual"]["pairs"], 0)
        self.assertIn("skillAllCountries", outbreak)

        # --resume on the finished run trains a new round of --epochs from its weights.
        events = []
        args = train.parse_args(["--data", str(self.p["root"]), "--model", "outbreak", "--out",
                                 str(self.tmp.path / "models" / "outbreak"), "--epochs", "1", "--device", "cpu",
                                 "--resume", "--log-every", "1", "--batch-size", "8"])
        self.assertEqual(train.run(args, lambda ev, **f: events.append({"event": ev, **f}), train.Control()), 0)
        prog = [e for e in events if e["event"] == "progress"]
        self.assertTrue(prog and all((e["epoch"], e["epochs"]) == (1, 1) for e in prog))
        ck = train.load_checkpoint(self.tmp.path / "models" / "outbreak" / "checkpoint.pt")
        self.assertEqual((ck["epoch"], ck["round_start"], ck["target"]), (3, 2, 3))
        self.assertEqual(ck["task"]["context"], 4)  # the first round's window is kept


if __name__ == "__main__":
    unittest.main()
