"""The training-set export (ml.gevtape.export): numpy-readable, licence-filtered, self-describing."""

import datetime as dt
import json
import unittest

import numpy as np

from ml.gevtape import export as E
from ml.gevtape import synth
from ml.tests.support import TempDir


class ExportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = TempDir()
        cls.p = synth.make_gev_data(cls.tmp.path, scenarios=1, runs=1, days=3, bin_days=2, tape_hours=0,
                                    markets=("crude", "tsx"))

    @classmethod
    def tearDownClass(cls):
        cls.tmp.close()

    def test_everything_for_local_training(self):
        out = self.tmp.path / "set-all"
        m = E.export(self.p["root"], out)
        self.assertEqual(len(m["days"]), 2)
        self.assertFalse(m["publishable"])
        arr = np.load(out / "bins" / "2026" / "10" / "01.markets.npy")
        self.assertEqual(arr.shape[0], 24)
        self.assertEqual(json.loads((out / "assets.json").read_text())["tsx"]["hub"]["name"], "Toronto")
        places = json.loads((out / "places.json").read_text())
        self.assertEqual(len(places), arr.shape[1])
        self.assertTrue(all(-90 <= p["lat"] <= 90 for p in places))
        card = (out / "DATASET.md").read_text(encoding="utf-8")
        self.assertIn("local training only", card)
        self.assertIn("Military travel is never recorded", card)
        listed = {f["path"] for f in m["files"]}
        self.assertIn("bins/2026/10/01.markets.npy", listed)
        self.assertTrue(all(len(f["sha256"]) == 64 for f in m["files"]))

    def test_open_only_is_shareable_and_names_what_it_left_out(self):
        out = self.tmp.path / "set-open"
        m = E.export(self.p["root"], out, classes=["open"], first=dt.date(2026, 10, 2), last=dt.date(2026, 10, 2))
        self.assertTrue(m["publishable"])
        self.assertEqual(m["days"], ["2026-10-02"])
        self.assertFalse((out / "bins" / "2026" / "10" / "02.mobility.npy").exists(), "mobility is class nc")
        self.assertTrue((out / "bins" / "2026" / "10" / "02.weather.npy").exists())
        self.assertIn({"day": "2026-10-02", "group": "news", "classes": ["nc"]}, m["leftOut"])
        self.assertIn("fit to share", (out / "DATASET.md").read_text(encoding="utf-8"))

    def test_refusals(self):
        with self.assertRaises(E.ExportError):
            E.export(self.p["root"], self.tmp.path / "x", classes=["secret"])
        busy = self.tmp.path / "busy"
        busy.mkdir()
        (busy / "keep.txt").write_text("mine")
        with self.assertRaises(E.ExportError):
            E.export(self.p["root"], busy)
        self.assertEqual((busy / "keep.txt").read_text(), "mine", "nothing overwritten")
        with self.assertRaises(E.ExportError):
            E.export(self.p["root"], self.tmp.path / "y", first=dt.date(2030, 1, 1))
        self.assertEqual(E.parse_days("2026-10-01"), (dt.date(2026, 10, 1), dt.date(2026, 10, 1)))
        self.assertEqual(E.parse_days("2026-10-01:"), (dt.date(2026, 10, 1), None))
        self.assertEqual(E.main(["--data", str(self.tmp.path / "nowhere"), "--out", str(self.tmp.path / "z")]), 1)


if __name__ == "__main__":
    unittest.main()
