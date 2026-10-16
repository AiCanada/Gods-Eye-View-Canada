"""Measured layer-asset links (ml.gevtape.links): known leads are found and checked out of sample."""

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np

from ml.gevtape import links as L


def series(hours=600, lead=3, seed=1, strength=0.8):
    """A price whose hourly return follows a channel's change `lead` hours later, plus noise channels."""
    rng = np.random.default_rng(seed)
    driver = np.cumsum(rng.normal(0, 1, hours))
    change = np.diff(driver, prepend=driver[0])
    ret = np.zeros(hours)
    ret[lead:] = strength * change[:-lead] * 0.001
    ret += rng.normal(0, 0.0004, hours)
    price = 100 * np.cumprod(1 + ret)
    noise = np.cumsum(rng.normal(0, 1, hours))
    K = 3
    values = np.full((hours, K, 3), np.nan, dtype=np.float32)
    values[:, :, 0] = driver[:, None]
    values[:, :, 1] = noise[:, None]
    values[:, :, 2] = price[:, None]
    values[::7, 0, 0] = np.nan  # a place missing now and then changes nothing
    return values, ["hazards.quakes", "news.articles", "markets.crude"]


class LinksTest(unittest.TestCase):
    def test_masked_corr_matches_numpy_and_skips_gaps(self):
        rng = np.random.default_rng(0)
        X = rng.normal(size=(200, 2))
        Y = 0.5 * X[:, :1] + rng.normal(size=(200, 1))
        r, n = L.masked_corr(X, Y)
        self.assertAlmostEqual(r[0, 0], np.corrcoef(X[:, 0], Y[:, 0])[0, 1], places=10)
        self.assertEqual(n[0, 0], 200)
        X[:10, 0] = np.nan
        r, n = L.masked_corr(X, Y)
        self.assertEqual(n[0, 0], 190)
        self.assertAlmostEqual(r[0, 0], np.corrcoef(X[10:, 0], Y[10:, 0])[0, 1], places=10)
        flat, _ = L.masked_corr(np.ones((50, 1)), Y[:50])
        self.assertTrue(np.isnan(flat[0, 0]), "no variance, no correlation")

    def test_a_known_lead_is_found_holds_out_of_sample_and_noise_does_not(self):
        values, channels = series()
        results, info = L.measure(values, channels, max_lag=6, min_hours=48)
        self.assertEqual(info["assets"], 1)
        top = results[0]
        self.assertEqual((top["channel"], top["asset"], top["lagHours"]), ("hazards.quakes", "crude", 3))
        self.assertTrue(top["holds"])
        self.assertLess(top["q"], 1e-6)
        noise = [r for r in results if r["channel"] == "news.articles" and r["holds"] and r["q"] < 0.01]
        self.assertEqual(noise, [], "a channel unrelated to the price is not reported as a link")
        self.assertFalse(any(r["channel"] == "markets.crude" for r in results), "no asset with itself")

    def test_too_little_data_says_so(self):
        values, channels = series(hours=40)
        results, info = L.measure(values, channels, min_hours=48)
        self.assertEqual(results, [])
        self.assertIn("48", info["reason"])
        results, info = L.measure(values[:, :, :2], channels[:2])
        self.assertEqual(info["reason"], "no market prices in the bins yet")

    def test_bh_and_study_pairs(self):
        q = L.bh_q([0.01, 0.04, np.nan, 0.03])
        self.assertTrue(np.isnan(q[2]))
        self.assertAlmostEqual(q[0], 0.03)
        self.assertAlmostEqual(q[1], 0.04)
        rows = [{"channel": "hazards.quakes", "asset": "crude", "r": 0.5},
                {"channel": "news.articles", "asset": "gold", "r": 0.2}]
        pairs = L.study_pairs(rows, [
            {"id": "a", "reads": ["news.articles", "markets.gold"]},
            {"id": "b", "reads": ["markets", "every other non-military number in that hour"]},
            {"id": "c", "reads": ["traffic.speedRatio", "markets.gasoline"]},
        ])
        self.assertEqual(pairs[0]["best"]["asset"], "gold")
        self.assertEqual(pairs[1]["best"]["channel"], "hazards.quakes")
        self.assertIsNone(pairs[2]["best"])

    def test_cli_writes_links_json_from_bins(self):
        from ml.gevtape import torch_data as td
        values, channels = series()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            calls = {}
            real_load, real_latest = td.load_bin_series, L.latest_bins_dir
            bins = root / "bins" / "w1"
            bins.mkdir(parents=True)
            (bins / "links.json").write_text(json.dumps([{"id": "x", "reads": ["hazards.quakes", "markets.crude"]}]))
            try:
                L.latest_bins_dir = lambda data: bins
                td.load_bin_series = lambda d: calls.setdefault("s", {
                    "values": values, "channels": channels, "days": [], "classes": ["open"]})
                events = []
                code = L.run(L.build_parser().parse_args(["--data", tmp, "--out", str(root / "out"), "--max-lag", "4"]),
                             lambda e, **f: events.append((e, f)), L.Control())
            finally:
                td.load_bin_series, L.latest_bins_dir = real_load, real_latest
            self.assertEqual(code, 0)
            report = json.loads((root / "out" / "links.json").read_text())
            self.assertEqual(report["results"][0]["lagHours"], 3)
            self.assertEqual(report["studyPairs"][0]["best"]["channel"], "hazards.quakes")
            self.assertIn("not advice", report["note"])
            self.assertEqual([e for e, _ in events][-1], "done")


if __name__ == "__main__":
    unittest.main()
