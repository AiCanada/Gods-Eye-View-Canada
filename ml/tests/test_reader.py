import datetime as dt
import gzip
import json
import shutil
import unittest
import warnings

import numpy as np

from ml.gevtape import formats as F
from ml.gevtape import reader as R
from ml.gevtape import synth
from ml.tests.support import TempDir

DAY = dt.date(2026, 10, 1)


class ReaderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = TempDir()
        cls.p = synth.make_gev_data(cls.tmp.path, scenarios=3, runs=2, days=10, bin_days=2, tape_hours=2,
                                    demographics=True, real_days=30)
        cls.world = R.load_world(cls.p["world_dir"])

    @classmethod
    def tearDownClass(cls):
        cls.tmp.close()

    # ---- world
    def test_load_world(self):
        w = self.world
        self.assertEqual(w.nodes.shape, (16, 8))
        self.assertEqual(w.K, 6)
        self.assertEqual(w.countries[-1], "")
        self.assertEqual(w.C, 4)
        self.assertEqual(w.links_offsets.shape, (17,))
        self.assertTrue(np.array_equal(w.nodes[w.tracked, 7], np.arange(w.K)))
        self.assertEqual(len(w.ids), 16)
        self.assertEqual(w.licence_classes, ["open"])
        self.assertAlmostEqual(w.country_population().sum(), w.population.sum())
        ok, how = R.verify_world_id(w.path)
        self.assertTrue(ok, how)
        self.assertEqual(how, "sorted names, name + bytes, every file")
        self.assertIsNone(w.demographics)  # only with a data root
        wd = R.load_world(self.p["world_dir"], data_root=self.p["root"])
        self.assertEqual(wd.demographics.shape, (16, 5))
        self.assertEqual(wd.demographics_columns[0], "log10Population")
        arr, meta = R.load_demographics(self.p["root"], "nope")
        self.assertIsNone(arr)
        # The GLOBAL ABUNDANCE MAP's figures per place, beside the demographics.
        self.assertIsNone(wd.abundance)
        d = self.p["root"] / "demographics"
        synth.write_npy(d / f"abundance-{w.world_id}.npy", np.full((16, 3), 0.5, np.float32))
        (d / f"abundance-{w.world_id}.json").write_text(
            json.dumps({"worldId": w.world_id, "channels": ["abundance_gdp", "abundance_life", "abundance"]}),
            encoding="utf-8")
        wa = R.load_world(self.p["world_dir"], data_root=self.p["root"])
        self.assertEqual(wa.abundance.shape, (16, 3))
        self.assertEqual(wa.abundance_columns, ["abundance_gdp", "abundance_life", "abundance"])
        self.assertEqual(wa.demographics.shape, (16, 5))
        synth.write_npy(d / f"abundance-{w.world_id}.npy", np.zeros((3, 3), np.float32))
        with warnings.catch_warnings(record=True):
            warnings.simplefilter("always")
            arr, meta = R.load_abundance(self.p["root"], w.world_id, 16)
        self.assertIsNone(arr)

    def test_load_world_rejects_bad_shapes(self):
        d = self.tmp.path / "badworld"
        shutil.copytree(self.p["world_dir"], d)
        synth.write_npy(d / "nodes.npy", np.zeros((16, 7)))
        with self.assertRaises(R.FormatError):
            R.load_world(d)

    def test_country_graph_and_adjacency(self):
        W = R.country_graph(self.world)
        self.assertEqual(W.shape, (4, 4))
        self.assertTrue(np.all(np.diag(W) == 0))
        r = self.world.routes
        cn = self.world.country_of_node
        f, t = r[:, 0].astype(int), r[:, 1].astype(int)
        intl = cn[f] != cn[t]
        self.assertAlmostEqual(W.sum(), r[intl, 4].sum())
        Wd = R.country_graph(self.world, include_domestic=True)
        self.assertAlmostEqual(Wd.sum(), r[:, 4].sum())
        A = R.normalized_adjacency(W)
        sums = A.sum(axis=1)
        self.assertTrue(np.all((np.abs(sums - 1) < 1e-5) | (sums == 0)))
        rows, cols, w = R.place_edges(self.world, k_nearest=2)
        self.assertTrue(len(rows) >= 2 * self.world.K)
        tot = np.bincount(rows, weights=w, minlength=self.world.K)
        self.assertTrue(np.allclose(tot, 1.0, atol=1e-5))

    # ---- episodes
    def test_iter_episodes_round_trip(self):
        index = R.read_index(self.p["dataset_dir"])
        eps = list(R.iter_episodes(self.p["dataset_dir"]))
        self.assertEqual(len(eps), 12)
        self.assertEqual({e.key for e in eps}, {e["key"] for e in index})
        for ep in eps:
            self.assertTrue(ep.complete)
            self.assertEqual(ep.meta["schema"], F.EPISODE_SCHEMA)
            self.assertEqual(ep.T, 10)
            for name, (dtype, _) in F.EPISODE_ARRAYS.items():
                self.assertEqual(ep[name].dtype, np.dtype(dtype), name)
                want = F.expected_shape(name, 10, 4, 6)
                self.assertEqual(len(want), ep[name].ndim)
            s, r, arm = R.parse_key(ep.key)
            self.assertEqual((ep.scenario, ep.run, ep.arm), (s, r, arm))
        a = next(e for e in eps if e.key == "s000001-r00-A")
        self.assertEqual(a.pair_key, "s000001-r00-B")

    def test_shard_subset_and_shuffle(self):
        shards = R.list_shards(self.p["dataset_dir"])
        self.assertEqual([R.shard_number(s) for s in shards], [0, 1, 2])
        only = [e.key for e in R.iter_episodes(self.p["dataset_dir"], shards=[1])]
        self.assertEqual(len(only), 5)
        a = [e.key for e in R.iter_episodes(self.p["dataset_dir"], shuffle_shards=True, seed=3)]
        b = [e.key for e in R.iter_episodes(self.p["dataset_dir"], shuffle_shards=True, seed=3)]
        self.assertEqual(a, b)
        self.assertEqual(sorted(a), sorted(e.key for e in R.iter_episodes(self.p["dataset_dir"])))
        keys = {"s000002-r01-B"}
        self.assertEqual([e.key for e in R.iter_episodes(self.p["dataset_dir"], keys=keys)], ["s000002-r01-B"])

    def test_members_in_any_order_and_with_directories(self):
        shard = R.list_shards(self.p["dataset_dir"])[0]
        members = synth.read_tar_gz(shard)
        mixed = members[::-1]  # every episode's members interleaved backwards
        mixed = [("./sub/" + n, d) for n, d in mixed]
        out = self.tmp.path / "mixed.tar.gz"
        synth.write_tar_gz(out, mixed)
        eps = list(R.iter_shard(out))
        self.assertEqual(len(eps), 5)
        self.assertTrue(all(e.complete for e in eps))
        orig = {e.key: e for e in R.iter_shard(shard)}
        for e in eps:
            self.assertTrue(np.array_equal(e["country_state"], orig[e.key]["country_state"]))

    def test_bad_member_is_recorded_not_raised(self):
        shard = R.list_shards(self.p["dataset_dir"])[0]
        members = synth.read_tar_gz(shard)
        broken = [(n, b"not npy" if n.endswith(".flows.npy") else d) for n, d in members]
        out = self.tmp.path / "broken.tar.gz"
        synth.write_tar_gz(out, broken)
        eps = list(R.iter_shard(out))
        self.assertEqual(len(eps), 5)
        self.assertTrue(all(e.errors and not e.complete for e in eps))

    def test_daily_obs(self):
        ep = next(R.iter_episodes(self.p["dataset_dir"]))
        d = R.daily_obs(ep)
        self.assertEqual(d["reported"].shape, (10, 4))
        cum = ep["country_cum"].astype(np.int64)
        self.assertTrue(np.array_equal(d["infected"].sum(axis=0), cum[-1, :, 0] - cum[0, :, 0]))
        self.assertTrue((d["deaths"] >= 0).all())
        g = R.daily_obs(ep, level="global")
        self.assertEqual(g["reported"].shape, (10,))
        self.assertAlmostEqual(g["infected"].sum(), ep["global"][-1, 0] - ep["global"][0, 0])
        p = R.daily_obs(ep, level="place")
        self.assertEqual(p["admitted"].shape, (10, 6))

    def test_read_index_skips_partial_last_line(self):
        d = self.tmp.path / "idx"
        d.mkdir()
        (d / "index.jsonl").write_text('{"key": "s000000-r00-A"}\n{"key": "s0000', encoding="utf-8")
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            self.assertEqual(R.read_index(d), [{"key": "s000000-r00-A"}])
        (d / "index.jsonl").write_text('{"key": 1}\nnope\n{"key": 2}\n', encoding="utf-8")
        with self.assertRaises(R.FormatError):
            R.read_index(d)

    def test_dataset_meta_helpers(self):
        meta = R.load_dataset_meta(self.p["dataset_dir"])
        self.assertEqual((R.dataset_field(meta, "days"), R.dataset_field(meta, "runs")), (10, 2))
        self.assertEqual(R.dataset_field({"days": 5}, "days"), 5)  # an earlier, top-level layout
        self.assertEqual(R.declared_classes(meta), ["open"])
        self.assertEqual(R.declared_classes({"licences": ["ODbL text", "nc"]}), ["nc"])

    def test_licence_classes_forms(self):
        self.assertEqual(R.licence_classes(["open", "nc", "open"]), ["nc", "open"])
        self.assertEqual(R.licence_classes([{"source": "x", "class": "unclear"}]), ["unclear"])
        self.assertEqual(R.licence_classes({"open": ["a"], "nc": ["b"]}), ["nc", "open"])
        self.assertEqual(R.licence_classes({"OpenSky": "nc"}), ["nc"])
        self.assertEqual(R.licence_classes(None), [])

    # ---- tape
    def test_iter_tape(self):
        tape = self.p["tape_dir"]
        feeds = R.list_tape_feeds(tape)
        self.assertEqual(feeds, ["flights", "news", "transit", "vessels"])
        self.assertEqual(R.list_tape_days(tape, "flights"), [DAY])
        self.assertEqual(R.tape_hours(tape, "flights", DAY), [0, 1])
        recs = list(R.iter_tape(tape, "flights", DAY))
        manifest = R.read_tape_manifest(tape, "flights", DAY)
        self.assertEqual(len(recs), sum(m["records"] for m in manifest))
        self.assertTrue(all(r["feed"] == "flights" and r["class"] == "nc" for r in recs))
        self.assertEqual(sorted(r["t"] for r in recs), [r["t"] for r in recs])
        # Also from the .gev-data root and with string days.
        self.assertEqual(len(list(R.iter_tape(self.p["root"], "flights", "2026-10-01", hours=[1]))),
                         manifest[1]["records"])
        self.assertEqual(len(R.read_gaps(tape)), 1)
        self.assertEqual(R.tape_day_classes(tape, DAY), ["nc", "open", "unclear"])

    def test_truncated_tape_file(self):
        root = self.tmp.path / "trunc"
        src = R.tape_day_dir(self.p["tape_dir"], "flights", DAY)
        dst = R.tape_day_dir(root / "tape", "flights", DAY)
        dst.mkdir(parents=True)
        data = (src / "00.ndjson.gz").read_bytes()
        full = gzip.decompress(data).decode().splitlines()
        # A file still being written: valid records, then a cut mid-stream plus a broken line.
        payload = ("\n".join(full) + "\n{broken\n").encode()
        (dst / "00.ndjson.gz").write_bytes(gzip.compress(payload)[:-12])
        stats = {}
        got = list(R.iter_tape(root / "tape", "flights", DAY, stats=stats))
        self.assertEqual(stats["truncated"], 1)
        self.assertGreater(len(got), len(full) // 2)
        self.assertTrue(all(isinstance(r, dict) for r in got))

    # ---- bins
    def test_load_bins(self):
        bins = self.p["bins_dir"]
        self.assertEqual(R.list_bin_days(bins), [DAY, DAY + dt.timedelta(days=1)])
        b = R.load_bins(bins, DAY)
        self.assertEqual(set(b.groups), set(F.BIN_CHANNELS))
        self.assertEqual(b.groups["weather"].shape, (24, 6, 6))
        self.assertEqual(b.groups["weather"].dtype, np.float32)
        self.assertEqual(b.channels["weather"], list(F.BIN_CHANNELS["weather"]))
        self.assertTrue(np.isnan(b.groups["traffic"][:, 3:]).all())  # not ticked for half the places
        day2 = R.load_bins(bins, "2026/10/02")
        self.assertTrue(np.isnan(day2.groups["mobility"][5:9]).all())  # the recorded gap
        # DD.classes.json (newer writers): the classes seen per group that day.
        self.assertEqual(b.group_classes["mobility"], ["nc"])
        self.assertEqual(b.classes, ["nc", "open"])
        old = synth.write_bins(self.tmp.path / "old-bins", self.p["world_dir"], days=1, day_classes=False)
        self.assertEqual((R.load_bins(old, DAY).classes, R.load_bins(old, DAY).group_classes), ([], {}))
        arr, names = b.stacked(["mobility", "news"])
        self.assertEqual(arr.shape, (24, 6, 9))  # 8 mobility columns (no military) and news
        self.assertEqual(names[0], "mobility.aircraft")
        self.assertEqual(names[-1], "news.articles")

    def test_load_real(self):
        r = R.load_real(self.p["root"])  # the .gev-data root or real/owid-oxcgrt itself
        self.assertEqual(R.load_real(self.p["real_dir"]).T, 30)
        self.assertEqual((r.T, r.C), (30, 5))
        self.assertEqual(r.obs.shape, (30, 5, 6))
        self.assertEqual(r.actions.shape, (30, 5, 5))
        self.assertEqual((r.obs_mask.dtype, r.actions_mask.dtype), (np.dtype(bool), np.dtype(bool)))
        self.assertEqual(r.obs_channels, list(F.REAL_OBS_CHANNELS))
        self.assertEqual(r.action_channels, list(F.REAL_ACTION_CHANNELS))
        self.assertTrue(np.isnan(r.obs[~r.obs_mask]).all())
        self.assertTrue(np.isfinite(r.obs[r.obs_mask]).all())
        self.assertTrue(np.isnan(r.population[-1]))
        self.assertEqual(r.countries[-1], "PN")
        self.assertEqual(r.classes, ["open"])
        self.assertEqual(len(r.attributions), 2)
        self.assertEqual(r.date(29), DAY.replace(year=2020, month=1, day=30))
        self.assertEqual(r.obs_index("icu"), 3)
        wb = R.load_worldbank(self.p["root"])
        self.assertEqual(set(wb), {"AA", "BB", "CC"})
        self.assertTrue(np.all((wb["AA"] > 0) & (wb["AA"] < 1)))
        bad = self.tmp.path / "bad-real"
        shutil.copytree(self.p["real_dir"], bad)
        synth.write_npy(bad / "population.npy", np.ones(4))
        with self.assertRaises(R.FormatError):
            R.load_real(bad)

    def test_discovery(self):
        root = self.p["root"]
        self.assertEqual(R.list_worlds(root), [self.p["world_dir"]])
        self.assertEqual(R.find_world(root, self.p["world_id"]), self.p["world_dir"])
        self.assertEqual(R.list_datasets(root, world_id=self.p["world_id"]), [self.p["dataset_dir"]])
        self.assertEqual(R.list_datasets(root, world_id="nope"), [])
        self.assertEqual(R.list_bin_worlds(root), [self.p["bins_dir"]])


if __name__ == "__main__":
    unittest.main()
