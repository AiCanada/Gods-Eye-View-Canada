"""Price moves on the globe: the world model's markets prediction, placed at each asset's hub."""

import unittest

from ml.gevtape import serve as S
from ml.gevtape import synth
from ml.gevtape import train
from ml.tests.support import TempDir


class MarketsPredictTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = TempDir()
        cls.p = synth.make_gev_data(cls.tmp.path, scenarios=1, runs=1, days=4, bin_days=3, tape_hours=0,
                                    markets=("crude", "gold", "tsx", "bitcoin"))
        cls.models = cls.tmp.path / "ai-world" / "models"
        args = train.parse_args(["--data", str(cls.p["root"]), "--model", "world", "--out", str(cls.models / "world"),
                                 "--epochs", "1", "--device", "cpu", "--hidden", "16", "--batch-size", "8",
                                 "--context", "12", "--horizon", "6", "--stride", "3"])
        assert train.run(args, lambda *a, **k: None, train.Control()) == 0
        cls.server = S.Server(cls.p["root"], cls.models, needed_days={"world": 1})

    @classmethod
    def tearDownClass(cls):
        cls.tmp.close()

    def test_each_asset_gets_a_move_and_a_hub_except_crypto(self):
        res = self.server.predict({"domain": "markets", "horizon": 6})
        self.assertIsNone(res["learning"])
        assets = {a["series"]: a for a in res["assets"]}
        self.assertEqual(set(assets), {"crude", "gold", "tsx", "bitcoin"})
        for a in assets.values():
            self.assertAlmostEqual(a["value"], (a["predicted"] - a["last"]) / abs(a["last"]) * 100, places=2)
        self.assertEqual((assets["tsx"]["hub"], assets["tsx"]["lat"], assets["tsx"]["lon"]),
                         ("Toronto", 43.6481, -79.3815))
        self.assertNotIn("lat", assets["bitcoin"], "crypto has no place on the globe")
        self.assertEqual({p["series"] for p in res["points"]}, {"crude", "gold", "tsx"})
        self.assertEqual(assets["gold"]["label"], "Gold")

    def test_a_box_keeps_only_the_hubs_inside_it(self):
        res = self.server.predict({"domain": "markets", "horizon": 6, "bbox": "-100,30,-70,50"})
        self.assertEqual({p["series"] for p in res["points"]}, {"crude", "tsx"})
        self.assertEqual(len(res["assets"]), 4, "the list still names every predicted asset")

    def test_military_is_never_a_domain(self):
        with self.assertRaises(S.RequestError):
            self.server.predict({"domain": "military"})


if __name__ == "__main__":
    unittest.main()
