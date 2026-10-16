"""serve.py as a child process: ping, learning answers without models, points and tracks with them."""

import math
import unittest

from ml.gevtape import formats as F
from ml.gevtape import synth
from ml.gevtape import train
from ml.tests.support import PY, Child, TempDir

PREDICTION_KEYS = {"domain", "horizonHours", "generatedAt", "skill", "learning", "points", "tracks"}


def serve(root, models):
    return Child([PY, "-m", "ml.gevtape.serve", "--data", root, "--models", models, "--threads", "1"])


class ServeProtocolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = TempDir()
        cls.p = synth.make_gev_data(cls.tmp.path, scenarios=3, runs=2, days=10, bin_days=3, tape_hours=3,
                                    demographics=True)
        cls.models = cls.tmp.path / "ai-world" / "models"
        for kind, extra in (("outbreak", ["--context", "4", "--horizon", "3"]),
                            ("world", ["--context", "12", "--horizon", "6", "--stride", "3"]),
                            ("tracks", [])):
            args = train.parse_args(["--data", str(cls.p["root"]), "--model", kind, "--out", str(cls.models / kind),
                                     "--epochs", "1", "--device", "cpu", "--hidden", "16", "--batch-size", "8"] + extra)
            assert train.run(args, lambda *a, **k: None, train.Control()) == 0

    @classmethod
    def tearDownClass(cls):
        cls.tmp.close()

    def ask(self, child, req):
        child.send(req)
        ans = child.read(60)
        self.assertEqual(ans.get("id"), req.get("id"))
        return ans

    def check_prediction(self, res, domain, horizon):
        self.assertEqual(set(res), PREDICTION_KEYS)
        self.assertEqual(res["domain"], domain)
        self.assertEqual(res["horizonHours"], horizon)
        self.assertIsInstance(res["generatedAt"], int)

    def test_no_models_answers_learning(self):
        empty = self.tmp.path / "no-models"
        empty.mkdir()
        child = serve(self.p["root"], empty)
        try:
            self.assertEqual(self.ask(child, {"id": 1, "cmd": "ping"}), {"id": 1, "ok": True, "result": {"models": []}})
            for i, domain in enumerate(F.PREDICTION_DOMAINS):
                ans = self.ask(child, {"id": 10 + i, "cmd": "predict", "domain": domain, "horizon": 24, "bbox": None})
                self.assertTrue(ans["ok"], ans)
                res = ans["result"]
                self.check_prediction(res, domain, 24)
                self.assertEqual(res["points"], [])
                self.assertEqual(res["tracks"], [])
                self.assertIsNone(res["skill"])
                self.assertEqual(set(res["learning"]), {"daysRecorded", "needed"})
            mob = self.ask(child, {"id": 30, "cmd": "predict", "domain": "mobility"})["result"]
            self.assertEqual(mob["learning"], {"daysRecorded": 3, "needed": 7})
            tr = self.ask(child, {"id": 31, "cmd": "predict", "domain": "tracks"})["result"]
            self.assertEqual(tr["learning"], {"daysRecorded": 1, "needed": 1})
            bad = self.ask(child, {"id": "x", "cmd": "predict", "domain": "nowhere"})
            self.assertFalse(bad["ok"])
            self.assertIn("domain", bad["error"])
            self.assertFalse(self.ask(child, {"id": 32, "cmd": "predict", "domain": "news", "bbox": "1,2"})["ok"])
            self.assertFalse(self.ask(child, {"id": 33, "cmd": "predict", "domain": "news", "horizon": -1})["ok"])
            self.assertFalse(self.ask(child, {"id": 34, "cmd": "dance"})["ok"])
            child.send_raw("not json\n")
            self.assertEqual(child.read(30), {"id": None, "ok": False, "error": "bad JSON"})
            self.assertEqual(self.ask(child, {"id": 99, "cmd": "close"})["ok"], True)
            self.assertEqual(child.wait(30), 0)
        finally:
            child.close()

    def test_trained_models_give_points_and_tracks(self):
        child = serve(self.p["root"], self.models)
        try:
            ping = self.ask(child, {"id": 1, "cmd": "ping"})
            models = {m["kind"]: m for m in ping["result"]["models"]}
            self.assertEqual(set(models), {"outbreak", "world", "tracks"})
            self.assertEqual(
                sorted(models["world"]["domains"]),
                ["hazards", "mobility", "news", "news-markets", "supply", "traffic", "trains", "weather"],
            )
            self.assertNotIn("military", models["world"]["domains"])
            self.assertEqual(models["tracks"]["domains"], ["tracks", "flights", "vessels", "transit"])
            self.assertEqual(models["outbreak"]["classes"], ["open"])
            self.assertEqual(models["outbreak"]["skill"]["metric"], "mae")

            ans = self.ask(child, {"id": 2, "cmd": "predict", "domain": "outbreak", "horizon": 48})
            res = ans["result"]
            self.check_prediction(res, "outbreak", 48)
            self.assertIsNone(res["learning"])
            self.assertEqual(res["skill"]["metric"], "mae")
            self.assertTrue(res["points"])
            for pt in res["points"]:
                self.assertTrue(all(math.isfinite(pt[k]) for k in ("lat", "lon", "value")))
                self.assertGreaterEqual(pt["value"], 0.5)

            for i, domain in enumerate(("mobility", "weather", "hazards", "news")):
                res = self.ask(child, {"id": 10 + i, "cmd": "predict", "domain": domain, "horizon": "6"})["result"]
                self.check_prediction(res, domain, 6)
                self.assertIsNone(res["learning"])
                self.assertEqual(len(res["points"]), 6, domain)  # every tracked place observed the channel
            temp = self.ask(child, {"id": 20, "cmd": "predict", "domain": "weather", "channel": "t2m"})["result"]
            self.assertEqual(len(temp["points"]), 6)
            lat0, lon0 = temp["points"][0]["lat"], temp["points"][0]["lon"]
            box = f"{lon0 - 0.01},{lat0 - 0.01},{lon0 + 0.01},{lat0 + 0.01}"
            one = self.ask(child, {"id": 21, "cmd": "predict", "domain": "weather", "channel": "weather.t2m",
                                   "bbox": box})
            self.assertEqual(len(one["result"]["points"]), 1)
            self.assertFalse(self.ask(child, {"id": 22, "cmd": "predict", "domain": "weather", "channel": "nope"})["ok"])

            res = self.ask(child, {"id": 30, "cmd": "predict", "domain": "tracks", "horizon": 1})["result"]
            self.check_prediction(res, "tracks", 1)
            self.assertIsNone(res["learning"])
            self.assertTrue(res["tracks"])
            kinds = {t["kind"] for t in res["tracks"]}
            self.assertTrue(kinds <= set(F.TRACK_FEEDS) and "flights" in kinds)
            for t in res["tracks"]:
                self.assertEqual(len(t["path"]), 5)  # the last fix, then 5 / 15 / 30 / 60 minutes
                times = [p[2] for p in t["path"]]
                self.assertEqual([b - times[0] for b in times[1:]], [300000, 900000, 1800000, 3600000])
            short = self.ask(child, {"id": 31, "cmd": "predict", "domain": "tracks", "horizon": 0.25})["result"]
            self.assertTrue(all(len(t["path"]) == 3 for t in short["tracks"]))  # 5 and 15 minutes only
            far = self.ask(child, {"id": 32, "cmd": "predict", "domain": "tracks", "bbox": [0, -89, 1, -88]})["result"]
            self.assertEqual(far["tracks"], [])
            self.assertEqual(self.ask(child, {"id": 33, "cmd": "reload"})["ok"], True)
        finally:
            child.close()


if __name__ == "__main__":
    unittest.main()
