import unittest

from ml.gevtape import formats as F


class FormatsTest(unittest.TestCase):
    def test_channel_counts_match_documented_widths(self):
        self.assertEqual(len(F.STATE_CHANNELS), 15)
        self.assertEqual(len(F.CUM_CHANNELS), 7)
        self.assertEqual(len(F.AUX_CHANNELS), 6)
        self.assertEqual(len(F.GLOBAL_CHANNELS), 20)
        self.assertEqual(len(F.GLOBAL_ACTIONS), 9)
        self.assertEqual(len(F.COUNTRY_ACTIONS), 2)
        self.assertEqual(len(F.PLACE_ACTIONS), 3)
        self.assertEqual(len(F.FLOW_KINDS), 6)
        self.assertEqual(len(F.EVENT_KINDS), 9)
        self.assertEqual(len(F.NODE_COLUMNS), 8)
        self.assertEqual(len(F.ROUTE_COLUMNS), 7)

    def test_documented_order(self):
        self.assertEqual(F.STATE_CHANNELS[:3], ("S", "E", "P"))
        self.assertEqual(F.STATE_CHANNELS[-1], "Rx")
        self.assertEqual(F.GLOBAL_CHANNELS[0], "infected")
        self.assertEqual(F.GLOBAL_CHANNELS[-1], "globalSignal")
        self.assertEqual(F.PLACE_ACTIONS[2], "vaccineTarget")
        self.assertEqual(F.EVENT_KINDS[F.EVENT_COUNTRY_FLAGGED], "country flagged")

    def test_episode_arrays_and_expected_shapes(self):
        self.assertEqual(len(F.EPISODE_ARRAYS), 14)
        self.assertEqual(F.expected_shape("global", 10, 4, 6), (11, 20))
        self.assertEqual(F.expected_shape("country_state", 10, 4, 6), (11, 4, 15))
        self.assertEqual(F.expected_shape("actions_place", 10, 4, 6), (10, 6, 3))
        self.assertEqual(F.expected_shape("flows", 10, 4, 6), (None, 6))
        self.assertEqual(F.EPISODE_ARRAYS["country_state"][0], "<u4")

    def test_mappings_name_real_channels(self):
        for g, c in F.GLOBAL_FROM_CUM.items():
            self.assertIn(g, F.GLOBAL_CHANNELS)
            self.assertIn(c, F.CUM_CHANNELS)
        for mapping in (F.GLOBAL_FROM_STATE, F.GLOBAL_FROM_STATE_HOSPITAL):
            for g, s in mapping.items():
                self.assertIn(g, F.GLOBAL_CHANNELS)
                self.assertIn(s, F.STATE_CHANNELS)
        for f in F.MONOTONE_FEATURES:
            self.assertIn(f, F.OUTBREAK_FEATURES)
        self.assertEqual(set(F.LICENCE_CLASSES), {"open", "nc", "restricted", "unclear", "personal", "static"})
        self.assertIn("countries.json", F.WORLD_FILES)
        self.assertNotIn("countries.json", F.WORLD_ARRAYS)
        self.assertEqual(len(F.BIN_CHANNELS["mobility"]), 8)
        self.assertNotIn("military", F.BIN_CHANNELS["mobility"])
        self.assertEqual(len(F.BIN_CHANNELS["news-markets"]), 42)
        self.assertEqual(sum(len(c) for c in F.BIN_CHANNELS.values()), 72)
        self.assertEqual(F.track_kind("ais-live-vessels"), "vessels")
        self.assertTrue(F.track_trainable("flights"))
        self.assertTrue(F.track_trainable("ais-live-vessels"))
        self.assertFalse(F.track_trainable("military"))
        self.assertIsNone(F.track_kind("military"), "military travel has no track kind")


if __name__ == "__main__":
    unittest.main()
