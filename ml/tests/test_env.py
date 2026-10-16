"""OutbreakEnv against a fake environment process (ml/tests/fake_outbreak_env.py)."""

import sys
import unittest
from pathlib import Path

import numpy as np

from ml.gevtape.env import EnvError, OutbreakEnv, make_action, window_mask
from ml.tests.support import REPO_ROOT

FAKE = Path(__file__).with_name("fake_outbreak_env.py")


def fake_env(**kw):
    return OutbreakEnv(node=sys.executable, script=str(FAKE), cwd=REPO_ROOT, timeout=30, **kw)


class EnvTest(unittest.TestCase):
    def test_episode(self):
        with fake_env() as env:
            obs, info = env.reset(seed=3, scenario={"preset": "flu"})
            self.assertEqual(obs["day"], 0)
            self.assertIsInstance(obs["global"], np.ndarray)
            self.assertEqual(obs["global"].shape, (20,))
            self.assertEqual(obs["country_state"].shape, (3, 15))
            self.assertEqual(env.n_countries, 3)
            self.assertEqual(info, {"seed": 3, "scenario": {"preset": "flu"}})
            action = {"window": np.uint32(window_mask(range(8, 12))), "switch": {np.int64(5): True, "7": 0},
                      "flag": np.array([1, 2])}
            obs, reward, terminated, truncated, info = env.step(action)
            self.assertEqual(info["echo"], {"window": 0xF00, "switch": {"5": 1, "7": 0}, "flag": [1, 2]})
            self.assertEqual(obs["day"], 1)
            self.assertEqual(reward, -7.0)  # minus the day's new infections
            self.assertFalse(terminated)
            self.assertFalse(truncated)
            steps = 1
            while not terminated:
                obs, reward, terminated, truncated, info = env.step(None)
                steps += 1
            self.assertEqual(steps, 5)
            self.assertEqual(info["echo"], {"window": None, "switch": {}, "flag": []})
            with self.assertRaises(EnvError):
                env.step({})  # the episode is over
            obs, _ = env.reset(seed=4)  # a new episode on the same process
            self.assertEqual(obs["day"], 0)
            proc = env._proc
        self.assertIsNotNone(proc.poll())  # closed by the context manager

    def test_errors(self):
        env = fake_env()
        try:
            with self.assertRaises(EnvError):
                env.step({})  # no reset yet
            with self.assertRaises(EnvError) as cm:
                env.reset(scenario="bad")
            self.assertIn("bad scenario", str(cm.exception))
            env.reset()
            with self.assertRaises(ValueError):
                env.step({"window": 1 << 24})
            with self.assertRaises(ValueError):
                env.step({"switch": {"3": 2}})
            with self.assertRaises(ValueError):
                env.step({"spin": 1})
            with self.assertRaises(EnvError) as cm:
                env.step({"flag": [999]})  # the fake env exits with code 3
            self.assertIn("exit code 3", str(cm.exception))
            self.assertIn("told to crash", str(cm.exception))
        finally:
            env.close()
            env.close()  # idempotent

    def test_custom_reward_and_missing_program(self):
        with fake_env(reward_fn=lambda prev, obs, info: float(obs["day"])) as env:
            env.reset()
            _, reward, *_ = env.step({})
            self.assertEqual(reward, 1.0)
        missing = OutbreakEnv(node=str(REPO_ROOT / "no-such-program.exe"), cwd=REPO_ROOT)
        with self.assertRaises(EnvError):
            missing.reset()

    def test_short_global_on_day_zero(self):
        # The earlier env sent 4 global values on day 0 and more later; both forms work.
        with fake_env() as env:
            obs, _ = env.reset(scenario="short")
            self.assertEqual(obs["global"].shape, (4,))
            obs, reward, *_ = env.step({})
            self.assertEqual(obs["global"].shape, (20,))
            self.assertEqual(reward, -7.0)
            self.assertEqual(env.named_global(obs)["infected"], 7.0)
            self.assertIsNone(env.named_global({"global": np.zeros(4)}))

    def test_make_action(self):
        self.assertEqual(make_action(None), {"window": None, "switch": {}, "flag": []})
        self.assertEqual(make_action({"window": 0xFFFFFF, "flag": (4,)}), {"window": 0xFFFFFF, "switch": {}, "flag": [4]})
        with self.assertRaises(ValueError):
            make_action({"window": True})
        # The day's magnitudes ride along when given, and only then.
        self.assertEqual(
            make_action({"window": 1, "lockdown": np.float32(0.5), "vaccinePer1000Day": 3}),
            {"window": 1, "switch": {}, "flag": [], "lockdown": 0.5, "vaccinePer1000Day": 3.0},
        )
        for bad in ({"travelBan": 1.5}, {"lockdown": -0.1}, {"testsPer1000Day": float("nan")},
                    {"vaccinePer1000Day": True}, {"strength": 1}):
            with self.assertRaises(ValueError):
                make_action(bad)
        with self.assertRaises(ValueError):
            window_mask([24])


if __name__ == "__main__":
    unittest.main()
