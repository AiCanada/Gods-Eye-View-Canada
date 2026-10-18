"""Adapter: post-train a Keras world model (ml.gevtape.tf_posttrain), such as
the one TENSORFLOW TRAINING makes (ml.gevtape.tf_train, model.keras).

Also the template for any other Keras or TensorFlow world model: copy this
file into .gev-data/ai-world/adapters/ (or ml/adapters/), keep the methods,
and turn the batch into your own model's inputs instead (ml.gevtape.tf_posttrain
explains the batch). A model from another machine or an older run works
here: when its channels differ from the bins', it is grown to them first,
keeping what it learned (tf_world.grow_model).
"""

import json
import os
from pathlib import Path

from ml.gevtape import tf_world as W


class KerasWorldAdapter:
    def __init__(self, checkpoint, *, device, channels, context, horizon, out_dir, lr=1e-3):
        tf = W.tensorflow()
        path = Path(checkpoint)
        folder = path if path.is_dir() else path.parent
        if path.is_dir():
            path = path / W.MODEL_FILE
        model = tf.keras.models.load_model(path, compile=False)
        n_channels, self.n_static, self.context, self.horizon = W.model_shape(model)
        old = self._channels(folder)
        if old and old != list(channels):
            grown = W.grow_model(model, old, list(channels))
            if grown is None:
                raise ValueError(f"{path} was built for {len(old)} channels and cannot be grown to these")
            model = grown
        elif n_channels != len(channels):
            raise ValueError(f"{path} reads {n_channels} channels, the bins have {len(channels)}, and no "
                             "manifest.json or state.json beside it says which they were")
        self.model = model
        self.channels = list(channels)
        self.opt = tf.keras.optimizers.AdamW(learning_rate=lr, weight_decay=0.0)
        self.model.compile(optimizer=self.opt)
        self.step = W.make_train_step(self.model, self.opt)

    @staticmethod
    def _channels(folder):
        """The channels the model trained on: its manifest.json (tf_train) or state.json."""
        for name, pick in (("manifest.json", lambda d: (d.get("data") or {}).get("channels")),
                           ("state.json", lambda d: (d.get("task") or {}).get("channels"))):
            try:
                found = pick(json.loads((folder / name).read_text(encoding="utf-8")))
            except (OSError, ValueError, AttributeError):
                continue
            if isinstance(found, list) and found:
                return [str(c) for c in found]
        return []

    def train_step(self, batch):
        rows, target, mask = W.place_rows(batch, self.context, self.horizon)
        if not len(target):
            return float("nan")
        return float(self.step(rows, target, mask))

    def evaluate(self, batch):
        tf = W.tensorflow()
        rows, target, mask = W.place_rows(batch, self.context, self.horizon)
        if not len(target):
            return None
        pred = W.predict_rows(self.model, rows)
        return float(W.channel_loss(tf.constant(pred), tf.constant(target), tf.constant(mask)))

    def save(self, folder):
        out = Path(folder)
        out.mkdir(parents=True, exist_ok=True)
        tmp = out / "model.tmp.keras"
        self.model.save(tmp)
        os.replace(tmp, out / W.MODEL_FILE)
        (out / "manifest.json").write_text(json.dumps({
            "model": "tf-posttrain", "framework": "tensorflow", "data": {"channels": self.channels},
            "contextHours": self.context, "horizonHours": self.horizon,
        }, indent=1) + "\n", encoding="utf-8", newline="\n")
