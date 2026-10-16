"""The world-market RL environment (ml.gevtape.world_env): recorded hours, time splits, rewards, imagined episodes."""

import unittest

import numpy as np

from ml.gevtape.world_env import WorldEnvError, WorldMarketEnv


def series(hours=120, K=2):
    """Two layer channels and two assets; gold rises 1 % every hour, crude is flat, military is dropped."""
    values = np.full((hours, K, 5), np.nan)
    values[:, :, 0] = np.arange(hours)[:, None]  # traffic.segments
    values[:, :, 1] = 3.0  # weather.t2m
    values[:, :, 2] = (100 * 1.01 ** np.arange(hours))[:, None]  # markets.gold
    values[:, :, 3] = 50.0  # markets.crude
    values[:, :, 4] = 9.0  # military.x (never seen)
    values[10:12, :, 3] = np.nan  # crude closed two hours
    return {"values": values, "start_ms": 0,
            "channels": ["traffic.segments", "weather.t2m", "markets.gold", "markets.crude", "military.x"]}


class WorldEnvTest(unittest.TestCase):
    def test_observation_and_military_left_out(self):
        env = WorldMarketEnv(series=series(), context=6, episode_hours=10, seed=0)
        self.assertEqual(env.assets, ["gold", "crude"])
        self.assertNotIn("military.x", env.channels)
        obs, info = env.reset(options={"start": 20})
        self.assertEqual(obs["layers"].shape, (6, 2, 4))
        self.assertEqual(obs["prices"].shape, (6, 2))
        self.assertAlmostEqual(float(obs["prices"][-1, 0]), 0.0, places=6, msg="relative to the latest price")
        self.assertLess(float(obs["prices"][0, 0]), 0, "older gold was cheaper")
        self.assertEqual(info["hour"], 20)
        self.assertEqual(env.observation_shapes["layers"], (6, 2, 4))

    def test_reward_turnover_cost_and_no_leverage(self):
        env = WorldMarketEnv(series=series(), context=6, episode_hours=5, cost_bps=10)
        env.reset(options={"start": 20})
        _, reward, done, truncated, info = env.step([2.0, 0.0])
        self.assertAlmostEqual(reward, 0.01 - 0.001, places=9, msg="long gold earns 1 %, minus 10 bp of turnover")
        _, reward, *_ = env.step([1.0, 0.0])
        self.assertAlmostEqual(reward, 0.01, places=9, msg="no turnover, no cost")
        w = WorldMarketEnv.clean_action([0.8, -0.8], 2)
        self.assertAlmostEqual(float(np.abs(w).sum()), 1.0)
        with self.assertRaises(ValueError):
            env.step([1.0])

    def test_a_closed_market_earns_nothing_and_episodes_end(self):
        env = WorldMarketEnv(series=series(), context=6, episode_hours=3, split="all")
        env.reset(options={"start": 9})
        _, reward, done, _, info = env.step([0.0, 1.0])
        self.assertAlmostEqual(reward, -0.0001, places=12, msg="only 1 bp of turnover: crude has no price at 10")
        self.assertEqual(info["returns"][1], 0.0)
        env.step([0.0, 1.0])
        *_, done, _, _ = env.step([0.0, 1.0])
        self.assertTrue(done)

    def test_train_and_test_hours_never_mix(self):
        train = WorldMarketEnv(series=series(), context=6, episode_hours=500, split="train", fit_share=0.5)
        test = WorldMarketEnv(series=series(), context=6, episode_hours=500, split="test", fit_share=0.5)
        train.reset(seed=1)
        self.assertLessEqual(train.end, 59)
        test.reset(seed=1)
        self.assertGreaterEqual(test.t, 60)
        with self.assertRaises(WorldEnvError):
            train.reset(options={"start": 80})
        with self.assertRaises(WorldEnvError):
            WorldMarketEnv(series=series(hours=6), context=6)
        no_prices = series()
        no_prices["channels"] = ["a.b", "c.d", "e.f", "g.h", "i.j"]
        with self.assertRaises(WorldEnvError):
            WorldMarketEnv(series=no_prices)

    def test_an_imagined_episode_runs_on_any_world_model(self):
        calls = []

        def model(window, time_ms):
            calls.append((window.shape, time_ms))
            nxt = window[-1].copy()
            nxt[:, 2] *= 0.98  # this model thinks gold falls 2 % an hour
            return nxt

        env = WorldMarketEnv(series=series(), context=6, episode_hours=4, model=model)
        obs, info = env.reset(options={"start": 20})
        self.assertTrue(info["imagined"])
        _, reward, *_ = env.step([1.0, 0.0])
        self.assertAlmostEqual(reward, -0.02 - 0.0001, places=9)
        self.assertEqual(calls[0], ((6, 2, 4), 15 * 3_600_000), "military is not in the model's window")
        obs, *_ = env.step([1.0, 0.0])
        self.assertLess(float(obs["prices"][-2, 0]), 0.0205, "the agent sees the imagined fall")
        self.assertGreater(float(obs["prices"][-2, 0]), 0.0200)


    def test_a_model_sees_its_own_channel_order(self):
        def model(window, time_ms):
            return window[-1]

        model.channels = ["markets.crude", "markets.gold", "news.articles"]
        env = WorldMarketEnv(series=series(), context=6, episode_hours=2, model=model)
        self.assertEqual(env.channels, model.channels)
        self.assertEqual(env.assets, ["crude", "gold"])
        obs, _ = env.reset(options={"start": 30})
        self.assertEqual(float(obs["mask"][:, :, 2].sum()), 0.0, "a channel the bins lack stays missing")


if __name__ == "__main__":
    unittest.main()
