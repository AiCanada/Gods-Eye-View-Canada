"""Adapter: post-train a world model checkpoint made by this kit (ml.gevtape.train --model world).

Also the template for any other world model: copy this file into
.gev-data/ai-world/adapters/ (or ml/adapters/), keep the four methods, and
load, step and save your own model instead (ml.gevtape.posttrain explains the
batch). A checkpoint from another machine or an older run works here: when
its channels differ from the bins', it is grown to them first, keeping what
it learned (models.grow_world_model).
"""

from pathlib import Path

import torch

from ml.gevtape import models as M
from ml.gevtape.train import CHECKPOINT_FORMAT, atomic_torch_save, balanced_channel_loss


class KitWorldAdapter:
    def __init__(self, checkpoint, *, device, channels, context, horizon, out_dir, lr=1e-3):
        path = Path(checkpoint)
        if path.is_dir():
            path = path / "checkpoint.pt"
        ckpt = torch.load(path, map_location="cpu", weights_only=False)
        if ckpt.get("kind") != "world":
            raise ValueError(f"{path} is not a world model checkpoint (kind {ckpt.get('kind')!r})")
        self.ckpt = ckpt
        old = list((ckpt.get("task") or {}).get("channels") or [])
        if old and old != list(channels):
            self.model = M.grow_world_model(ckpt["model"], ckpt["model_config"], old, channels)
        else:
            self.model = M.build_model("world", ckpt["model_config"])
            self.model.load_state_dict(ckpt["model"])
        self.channels = list(channels)
        self.device = torch.device(device)
        self.model.to(self.device)
        self.context, self.horizon = int(context), int(horizon)
        self.opt = torch.optim.AdamW(self.model.parameters(), lr=lr, weight_decay=0.0)

    def _loss(self, batch):
        v, m = batch["v"], batch["m"]
        c, h = self.context, self.horizon
        pred, seen = self.model.predict_forward(v[:, :c], m[:, :c], batch["tf"], batch["s"], batch["adj"], h)
        future = m[:, c:c + h]
        mask = future * seen.unsqueeze(1).to(dtype=future.dtype)
        return balanced_channel_loss(pred, v[:, c:c + h], mask)

    def train_step(self, batch):
        self.model.train()
        loss = self._loss(batch)
        self.opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
        self.opt.step()
        return float(loss.detach())

    def evaluate(self, batch):
        self.model.eval()
        return float(self._loss(batch))

    def save(self, folder):
        out = Path(folder)
        out.mkdir(parents=True, exist_ok=True)
        task = dict(self.ckpt.get("task") or {}, channels=self.channels)
        atomic_torch_save(out / "checkpoint.pt", {
            **{k: v for k, v in self.ckpt.items() if k not in ("model", "optimizer", "model_config", "task")},
            "format": CHECKPOINT_FORMAT, "kind": "world", "model_config": self.model.config,
            "model": self.model.state_dict(), "optimizer": self.opt.state_dict(), "task": task,
        })
