"""Post-training a world model that meets new channels: grown, not replaced."""

import unittest

import torch

from ml.gevtape import models as M
from ml.gevtape import synth
from ml.gevtape import train
from ml.tests.support import TempDir


class GrowTest(unittest.TestCase):
    def test_known_channels_predict_exactly_as_before_and_new_ones_start_at_persistence(self):
        torch.manual_seed(0)
        old = M.WorldModel(n_channels=3, hidden=8)
        with torch.no_grad():
            for p in old.parameters():
                p.add_(torch.randn_like(p) * 0.1)
        old_names = ["a.x", "b.y", "c.z"]
        new_names = ["b.y", "new.q", "a.x", "c.z"]  # one new, one moved
        grown = M.grow_world_model(old.state_dict(), old.config, old_names, new_names)
        self.assertEqual(grown.config["n_channels"], 4)
        B, L, K = 2, 5, 3
        v_old = torch.randn(B, L, K, 3)
        m_old = torch.ones(B, L, K, 3)
        tf = torch.randn(B, L, K, 6)
        s = torch.randn(B, K, 4)
        adj = torch.eye(K)
        order = [new_names.index(n) for n in old_names]
        v_new = torch.zeros(B, L, K, 4)
        m_new = torch.zeros(B, L, K, 4)
        v_new[..., order] = v_old
        m_new[..., order] = m_old
        with torch.no_grad():
            before = old(v_old, m_old, tf, s, adj)
            after = grown(v_new, m_new, tf, s, adj)
        self.assertTrue(torch.allclose(after[..., order], before, atol=1e-5))
        # The new channel: never observed, its head is zero, so it stays at 0 (persistence of nothing seen).
        self.assertTrue(torch.allclose(after[..., new_names.index("new.q")], torch.zeros(B, L - 1, K)))

    def test_a_resumed_run_with_a_new_asset_grows_the_checkpoint(self):
        tmp = TempDir()
        try:
            p = synth.make_gev_data(tmp.path, scenarios=1, runs=1, days=3, bin_days=3, tape_hours=0)
            out = tmp.path / "ai-world" / "models" / "world"
            base = ["--data", str(p["root"]), "--model", "world", "--out", str(out), "--epochs", "1",
                    "--device", "cpu", "--hidden", "8", "--batch-size", "8", "--context", "12",
                    "--horizon", "6", "--stride", "6"]
            assert train.run(train.parse_args(base), lambda *a, **k: None, train.Control()) == 0
            first = torch.load(out / "checkpoint.pt", weights_only=False)
            # A new asset starts being recorded: the bins gain a markets group.
            synth.write_bins(p["root"], p["world_dir"], days=3, markets=("gold",))
            events = []
            code = train.run(train.parse_args(base + ["--resume"]), lambda e, **f: events.append((e, f)),
                             train.Control())
            self.assertEqual(code, 0)
            self.assertIn(("progress", True), [(e, f.get("channelsGrown")) for e, f in events])
            second = torch.load(out / "checkpoint.pt", weights_only=False)
            self.assertIn("markets.gold", second["task"]["channels"])
            self.assertEqual(second["createdAt"], first["createdAt"], "the same model, post-trained")
            self.assertEqual(second["model"]["head.2.weight"].shape[0], len(second["task"]["channels"]))
        finally:
            tmp.close()


if __name__ == "__main__":
    unittest.main()
