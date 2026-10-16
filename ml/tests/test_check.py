import contextlib
import io
import json
import shutil
import unittest

import numpy as np

from ml.gevtape import check
from ml.gevtape import formats as F
from ml.gevtape import synth
from ml.tests.support import TempDir

S = F.STATE_CHANNELS.index("S")
REP = F.CUM_CHANNELS.index("reported")
G_INF = F.GLOBAL_CHANNELS.index("infected")
G_REP = F.GLOBAL_CHANNELS.index("reported")


def run_main(argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = check.main(argv)
    return code, buf.getvalue()


class CheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = TempDir()
        cls.p = synth.make_gev_data(cls.tmp.path, scenarios=2, runs=2, days=10, bin_days=0, tape_hours=0)
        cls.n = 0

    @classmethod
    def tearDownClass(cls):
        cls.tmp.close()

    def copy(self):
        """A fresh copy of the dataset (same world, found through ../../worlds)."""
        CheckTest.n += 1
        dst = self.p["dataset_dir"].parent / f"copy{CheckTest.n}"
        shutil.copytree(self.p["dataset_dir"], dst)
        return dst

    def assert_fails(self, dataset, check_name):
        r = check.check_dataset(dataset)
        self.assertFalse(r.ok, check.format_report(r, dataset))
        self.assertIn(check_name, r.errors, check.format_report(r, dataset))
        code, text = run_main([str(dataset)])
        self.assertEqual(code, 1)
        self.assertIn("RESULT: FAIL", text)
        return r

    def test_good_data_passes(self):
        code, text = run_main([str(self.p["dataset_dir"]), "--world", str(self.p["world_dir"])])
        self.assertEqual(code, 0, text)
        self.assertIn("RESULT: OK (0 errors, 0 warnings)", text)
        self.assertIn("worldId verified", text)
        self.assertIn("dataset: open; world: open", text)
        r = check.check_dataset(self.p["dataset_dir"])  # world found through ../../worlds
        self.assertTrue(r.ok)
        self.assertEqual(r.info["pairs"], "4 pairs compared")

    def test_json_and_limit(self):
        code, text = run_main([str(self.p["dataset_dir"]), "--json", "--limit", "3"])
        self.assertEqual(code, 0)
        rep = json.loads(text)
        self.assertTrue(rep["ok"])
        self.assertEqual(rep["info"]["episodes"], "3 read (limit 3)")

    def test_negative_global(self):
        d = self.copy()
        synth.modify_episode(d, "s000000-r01-A", lambda m, a: a["global"].__setitem__((3, G_REP), -5.0))
        r = self.assert_fails(d, "non-negative")
        self.assertTrue(any("negative" in e for e in r.errors["non-negative"]))

    def test_negative_count_wrapped_in_uint32(self):
        d = self.copy()

        def wrap(meta, arrays):
            arrays["place_state"][4, 1, S] = np.uint32(2 ** 32 - 3)  # -3 written as uint32
        synth.modify_episode(d, "s000001-r00-B", wrap)
        r = self.assert_fails(d, "non-negative")
        self.assertTrue(any("2^31" in e for e in r.errors["non-negative"]))

    def test_decreasing_cumulative(self):
        d = self.copy()

        def fall(meta, arrays):
            cc = arrays["country_cum"]
            cc[5:, 0, REP] = np.maximum(cc[5:, 0, REP], 1)
            cc[6, 0, REP] = cc[5, 0, REP] - 1  # one report taken back on day 6
            cc[7:, 0, REP] = np.maximum(cc[7:, 0, REP], cc[5, 0, REP])
        synth.modify_episode(d, "s000001-r01-A", fall)
        r = self.assert_fails(d, "cumulative")
        self.assertTrue(any("reported falls at row 6" in e for e in r.errors["cumulative"]))

    def test_pair_mismatch(self):
        d = self.copy()

        def shift(meta, arrays):
            arrays["global"][0, G_INF] += 1  # arm B no longer starts where arm A does
        synth.modify_episode(d, "s000000-r00-B", shift)
        r = self.assert_fails(d, "pairs")
        self.assertTrue(any("s000000-r00-A / s000000-r00-B: global differs on row 0" in e
                            for e in r.errors["pairs"]))

    def test_global_not_sum_of_countries(self):
        d = self.copy()
        synth.modify_episode(d, "s000000-r00-A", lambda m, a: a["global"].__setitem__((6, G_INF), a["global"][6, G_INF] + 10))
        r = self.assert_fails(d, "conservation")
        self.assertTrue(any("global infected" in e for e in r.errors["conservation"]))

    def test_places_exceed_country(self):
        d = self.copy()
        synth.modify_episode(d, "s000001-r00-A", lambda m, a: a["place_state"].__setitem__((2, 0, S), a["place_state"][2, 0, S] + 10 ** 8))
        self.assert_fails(d, "conservation")

    def test_action_out_of_range(self):
        d = self.copy()
        synth.modify_episode(d, "s000000-r01-B", lambda m, a: a["actions_place"].__setitem__((2, 1, 2), 1.5))
        r = self.assert_fails(d, "actions")
        self.assertTrue(any("vaccineTarget" in e for e in r.errors["actions"]))

    def test_controls_magnitudes(self):
        """The optional magnitudes member: accepted as documented, checked when there."""
        d = self.copy()
        T = 10

        def add(meta, arrays):
            m = np.full((T, len(F.MAGNITUDE_CONTROLS)), np.nan)
            m[:, 0] = 0.4  # lockdown every day
            m[3, 3] = 12.0  # one day's doses
            arrays["controls_magnitudes"] = m
        synth.modify_episode(d, "s000000-r01-B", add)
        r = check.check_dataset(d)
        self.assertTrue(r.ok, check.format_report(r, d))
        self.assertFalse(any("undocumented" in w for w in r.warnings.get("members", [])))
        self.assertNotIn("controls", r.warnings)

        def wide(meta, arrays):
            arrays["controls_magnitudes"] = np.full((T, 3), np.nan)
        e = self.copy()
        synth.modify_episode(e, "s000000-r01-B", wide)
        self.assert_fails(e, "shape")

        def over(meta, arrays):
            m = np.full((T, len(F.MAGNITUDE_CONTROLS)), np.nan)
            m[0, 1] = 1.5  # a ban share past 1: the engine clamps it
            arrays["controls_magnitudes"] = m
        o = self.copy()
        synth.modify_episode(o, "s000000-r01-B", over)
        r = check.check_dataset(o)
        self.assertTrue(r.ok)
        self.assertTrue(any("travelBan" in w for w in r.warnings["controls"]))

    def test_shape_and_dtype(self):
        d = self.copy()

        def bad(meta, arrays):
            arrays["place_aux"] = arrays["place_aux"][:, :, :5]
            arrays["flows"] = arrays["flows"].astype(np.int64)
        synth.modify_episode(d, "s000001-r01-B", bad)
        r = self.assert_fails(d, "shape")
        self.assertIn("dtype", r.errors)

    def test_schema_and_licence(self):
        d = self.copy()
        meta = json.loads((d / "dataset.json").read_text(encoding="utf-8"))
        meta["schema"] = "gev-outbreak-dataset/9"
        meta["licences"] = ["ODbL 1.0: share-alike if published"]  # a licence text is fine
        meta["classes"] = ["open", "secret"]  # an unknown class is not
        (d / "dataset.json").write_text(json.dumps(meta), encoding="utf-8")
        r = self.assert_fails(d, "schema")
        self.assertIn("licences", r.errors)
        self.assertTrue(any("secret" in e for e in r.errors["licences"]))

    def test_earlier_layout_is_accepted_with_warnings(self):
        # days / runs at the top level and classes named in `licences`, as the
        # first version of the doc had it; pair as the other arm's key.
        d = self.copy()
        meta = json.loads((d / "dataset.json").read_text(encoding="utf-8"))
        spec = meta.pop("spec")
        meta["days"], meta["runs"] = spec["days"], spec["runs"]
        meta["licences"] = ["open"]
        del meta["classes"]
        (d / "dataset.json").write_text(json.dumps(meta), encoding="utf-8")
        lines = [json.loads(x) for x in (d / "index.jsonl").read_text(encoding="utf-8").splitlines()]
        for e in lines:
            e["pair"] = e["key"][:-1] + ("B" if e["arm"] == "A" else "A")
        (d / "index.jsonl").write_text("".join(json.dumps(e) + "\n" for e in lines), encoding="utf-8")
        r = check.check_dataset(d)
        self.assertTrue(r.ok, check.format_report(r, d))
        self.assertEqual(len(r.warnings["dataset"]), 2)  # days and runs not under spec
        self.assertNotIn("index", r.warnings)
        self.assertNotIn("licences", r.warnings)

    def test_world_without_classes_is_a_warning(self):
        import shutil
        w = self.tmp.path / "w3" / "outbreak" / "worlds" / self.p["world_id"]
        shutil.copytree(self.p["world_dir"], w)
        d = self.tmp.path / "w3" / "outbreak" / "datasets" / "x"
        shutil.copytree(self.p["dataset_dir"], d)
        meta = json.loads((w / "world.json").read_text(encoding="utf-8"))
        del meta["classes"]  # the earlier world.json: licence texts only
        (w / "world.json").write_text(json.dumps(meta), encoding="utf-8")
        r = check.check_dataset(d)
        self.assertTrue(r.ok, check.format_report(r, d))
        self.assertTrue(any("world declares no licence classes" in x for x in r.warnings["licences"]))

    def test_world_countries_json(self):
        import shutil
        w = self.tmp.path / "w2" / "outbreak" / "worlds" / self.p["world_id"]
        shutil.copytree(self.p["world_dir"], w)
        d = self.tmp.path / "w2" / "outbreak" / "datasets" / "x"
        shutil.copytree(self.p["dataset_dir"], d)
        (w / "countries.json").write_text('["ZZ", ""]', encoding="utf-8")
        r = self.assert_fails(d, "world")
        self.assertTrue(any("countries.json" in e for e in r.errors["world"]))

    def test_missing_member_and_index(self):
        d = self.copy()

        def drop(meta, arrays):
            del arrays["events"]
        synth.modify_episode(d, "s000000-r01-A", drop)
        with open(d / "index.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"key": "s000009-r00-A", "shard": 0}) + "\n")
        r = self.assert_fails(d, "members")
        self.assertIn("index", r.errors)


if __name__ == "__main__":
    unittest.main()
