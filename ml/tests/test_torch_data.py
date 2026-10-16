import datetime as dt
import types
import unittest
from unittest import mock

import numpy as np
import torch
from torch.utils.data import DataLoader

from ml.gevtape import formats as F
from ml.gevtape import geo
from ml.gevtape import reader as R
from ml.gevtape import synth
from ml.gevtape import torch_data as td
from ml.tests.support import TempDir


def as_workers(n, fn):
    """Run fn() as each of n DataLoader workers (patched get_worker_info); returns the results."""
    out = []
    for i in range(n):
        with mock.patch("ml.gevtape.torch_data.get_worker_info",
                        return_value=types.SimpleNamespace(id=i, num_workers=n)):
            out.append(fn())
    return out


class EpisodeWindowsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = TempDir()
        cls.p = synth.make_gev_data(cls.tmp.path, scenarios=3, runs=2, days=10, bin_days=3, tape_hours=3)
        cls.world = R.load_world(cls.p["world_dir"])
        # One more dataset with a single shard (fewer shards than workers).
        cls.one = synth.write_dataset(cls.tmp.path, "one-shard", cls.p["world_dir"], scenarios=2, runs=1,
                                      days=10, episodes_per_shard=100)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.close()

    def windows(self, **kw):
        return td.EpisodeWindows(self.p["dataset_dir"], world=self.world, context=4, horizon=3, **kw)

    def test_shapes_and_count(self):
        ds = self.windows(seed=1)
        items = list(ds)
        L = 7
        self.assertEqual(len(items), 12 * (11 - L + 1))  # 12 episodes x 5 windows
        it = items[0]
        self.assertEqual(it["x"].shape, (L, 4, td.N_OUTBREAK_FEATURES))
        self.assertEqual(it["a"].shape, (L - 1, 4, td.N_OUTBREAK_ACTIONS))
        self.assertEqual(it["s"].shape, (4, 1))
        self.assertTrue(np.isfinite(it["x"]).all() and (it["x"] >= 0).all())
        batch = next(iter(DataLoader(ds, batch_size=5)))
        self.assertEqual(tuple(batch["x"].shape), (5, L, 4, 22))
        self.assertEqual(tuple(batch["a"].shape), (5, L - 1, 4, 14))
        self.assertEqual(len(batch["key"]), 5)

    def test_log1p_normalisation_matches_episode(self):
        ds = self.windows(shuffle=False)
        ep = next(R.iter_episodes(self.p["dataset_dir"]))
        first = next(iter(ds))
        self.assertEqual(first["key"], ep.key)
        want = np.log1p(np.concatenate([ep["country_state"][:7], ep["country_cum"][:7]], axis=-1).astype(np.float64))
        self.assertTrue(np.allclose(first["x"], want, atol=1e-5))

    def test_deterministic_and_epoch_dependent(self):
        def order(epoch):
            ds = self.windows(seed=5)
            ds.set_epoch(epoch)
            return [(w["key"], w["start"]) for w in ds]
        self.assertEqual(order(0), order(0))
        self.assertNotEqual(order(0), order(1))
        self.assertEqual(sorted(order(0)), sorted(order(1)))

    def test_worker_split_by_shard_and_by_episode(self):
        for dataset in (self.p["dataset_dir"], self.one):
            ds = td.EpisodeWindows(dataset, world=self.world, context=4, horizon=3, seed=2)
            whole = sorted((w["key"], w["start"]) for w in ds)
            parts = as_workers(2, lambda: [(w["key"], w["start"]) for w in ds])
            self.assertTrue(parts[0] and parts[1])
            self.assertFalse(set(parts[0]) & set(parts[1]))
            self.assertEqual(sorted(parts[0] + parts[1]), whole)

    def test_scenario_filter(self):
        ds = self.windows(scenarios={1}, shuffle=False)
        keys = {w["key"] for w in ds}
        self.assertEqual(keys, {"s000001-r00-A", "s000001-r00-B", "s000001-r01-A", "s000001-r01-B"})
        self.assertLessEqual(len(ds.shards), 2)

    def test_actions_place_to_country_average(self):
        ep = next(R.iter_episodes(self.p["dataset_dir"]))
        a = td.outbreak_actions(ep, "country", self.world)
        ap = ep["actions_place"]
        c = int(self.world.tracked_country[0])
        ks = np.flatnonzero(self.world.tracked_country == c)
        w = self.world.population[self.world.tracked[ks]]
        want = (ap[:, ks, :] * w[None, :, None]).sum(axis=1) / w.sum()
        self.assertTrue(np.allclose(a[:, c, 11:], want, atol=1e-5))
        self.assertTrue(np.allclose(a[:, c, :9], ep["actions_global"]))
        place = td.outbreak_actions(ep, "place", self.world)
        self.assertEqual(place.shape, (10, 6, 14))

    def test_static_without_world(self):
        ep = next(R.iter_episodes(self.p["dataset_dir"]))
        s0 = td.outbreak_static(None, "country", ep)
        s1 = td.outbreak_static(self.world, "country")
        self.assertTrue(np.allclose(s0, s1, atol=1e-5))  # row-0 compartments sum to the population
        self.assertEqual(td.outbreak_static(self.world, "country", n_static=3).shape, (4, 3))


class BinAndTrackWindowsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = TempDir()
        cls.p = synth.make_gev_data(cls.tmp.path, scenarios=1, runs=1, days=4, bin_days=3, tape_hours=3)
        cls.world = R.load_world(cls.p["world_dir"])

    @classmethod
    def tearDownClass(cls):
        cls.tmp.close()

    def test_bin_series_and_windows(self):
        ser = td.load_bin_series(self.p["bins_dir"])
        C = sum(len(c) for c in F.BIN_CHANNELS.values())  # every documented channel
        self.assertEqual(ser["values"].shape, (72, 6, C))
        self.assertEqual(ser["start"], dt.date(2026, 10, 1))
        ds = td.BinWindows(ser, world=self.world, context=12, horizon=6, stride=2, seed=0)
        self.assertGreater(len(ds), 0)
        w = next(iter(ds))
        self.assertEqual(w["v"].shape, (18, 6, C))
        self.assertEqual(w["m"].shape, (18, 6, C))
        self.assertEqual(w["tf"].shape, (18, 6, td.N_TIME_FEATURES))
        self.assertEqual(w["s"].shape, (6, 4))
        s = w["start"]
        raw = ser["values"][s: s + 18]
        self.assertTrue(np.array_equal(w["m"] > 0, np.isfinite(raw)))
        self.assertTrue(np.allclose(td.symexp(w["v"])[w["m"] > 0], raw[np.isfinite(raw)], rtol=1e-4, atol=1e-3))
        self.assertTrue((w["v"][w["m"] == 0] == 0).all())
        # Held-out windows keep their targets inside the held-out hours.
        held = td.BinWindows(ser, world=self.world, context=12, horizon=6, target_hours=(48, 72), shuffle=False)
        self.assertTrue(all(st + 12 >= 48 for st in held.starts))
        parts = as_workers(2, lambda: [w["start"] for w in ds])
        self.assertEqual(sorted(parts[0] + parts[1]), sorted(ds.starts.tolist()))

    def test_hour_features(self):
        tf = td.hour_features(R.day_start_ms(dt.date(2026, 10, 1)), 24, np.array([0.0, 6.0]))
        self.assertEqual(tf.shape, (24, 2, 6))
        self.assertAlmostEqual(float(tf[0, 0, 0]), 0.0, places=5)  # midnight UTC: sin 0
        self.assertAlmostEqual(float(tf[0, 1, 2]), 1.0, places=5)  # 06:00 local: sin(pi/2)

    def test_track_windows(self):
        ds = td.TrackWindows(self.p["tape_dir"], days=[dt.date(2026, 10, 1)], seed=0)
        items = list(ds)
        self.assertGreater(len(items), 100)
        it = items[0]
        self.assertEqual(it["feats"].shape, (8, td.N_TRACK_FEATURES))
        self.assertEqual(it["base"].shape, (4, 2))
        self.assertEqual(it["target"].shape, (4, 2))
        self.assertIn(it["kind"], range(len(td.TRACK_KINDS)))
        # Synthetic tracks barely turn: the constant-velocity baseline lands near the truth.
        flights = [x for x in items if x["kind"] == td.TRACK_KINDS.index("flights") and x["tmask"][0] > 0]
        err = np.median([np.hypot(*(x["base"][0] - x["target"][0])) for x in flights])
        self.assertLess(err, 5.0)
        moved = np.median([np.hypot(*x["target"][0]) for x in flights])
        self.assertGreater(moved, 30.0)  # 5 minutes of a jet is ~65 km
        batch = next(iter(DataLoader(ds, batch_size=16)))
        self.assertEqual(tuple(batch["feats"].shape), (16, 8, 7))
        self.assertEqual(batch["kind"].dtype, torch.int64)

    def test_vessel_feed_alias(self):
        import shutil
        root = self.tmp.path / "alias"
        shutil.copytree(self.p["tape_dir"] / "vessels", root / "tape" / "ais-live-vessels")
        ds = td.TrackWindows(root / "tape", days=[dt.date(2026, 10, 1)], feeds=["ais-live-vessels"], seed=0)
        kinds = {x["kind"] for x in ds}
        self.assertEqual(kinds, {td.TRACK_KINDS.index("vessels")})
        self.assertEqual(F.track_kind("ais-live-vessels"), "vessels")
        self.assertIsNone(F.track_kind("earthquakes"))

    def test_geo_round_trip(self):
        e, n = geo.aeqd_forward(10.0, 20.0, 11.0, 21.5)
        la, lo = geo.aeqd_inverse(10.0, 20.0, e, n)
        self.assertAlmostEqual(float(la), 11.0, places=6)
        self.assertAlmostEqual(float(lo), 21.5, places=6)
        self.assertTrue(geo.in_bbox(0.0, 179.5, (170, -10, -170, 10)))
        self.assertFalse(geo.in_bbox(0.0, 0.0, (170, -10, -170, 10)))
        self.assertTrue(geo.in_bbox(0.0, 180.0, (170, -10, 180, 10)))
        self.assertEqual(geo.parse_bbox("1,2,3,4"), (1.0, 2.0, 3.0, 4.0))


if __name__ == "__main__":
    unittest.main()
