"""The TensorFlow world model: a Keras model on the same hourly bins as the
PyTorch one (ml.gevtape.train --model world), held out and scored the same way.

Shared by ml.gevtape.tf_train (trains it), ml.gevtape.tf_export (SavedModel
and TFLite) and ml/adapters/keras_world.py (post-trains it). It imports numpy
and TensorFlow only, so it runs in the WSL2 GPU Python
(scripts/tensorflow-wsl-setup.sh) as well as in the Windows one (CPU).

Each tracked place is read by itself (no neighbour graph, unlike the PyTorch
model): the last `context` hours of every channel, which of them were
observed, the hour features, the place's static features, and the hour
features of the `horizon` hours ahead. The model predicts a change from
persistence (the last value observed in the context), and that change starts
at zero: an untrained model scores exactly as persistence does, so every gain
over it is learned.

Values are in the same space as the PyTorch model's: sign(x)*log1p(|x|) of
the bin values, observed targets only.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from . import formats as F
from . import reader as R
from . import torch_data as td
from .protocol import DataError

MODEL_NAME = "tf-world"
MODEL_FILE = "model.keras"
INPUTS = ("context", "future", "static", "last", "seen")


def tensorflow():
    """TensorFlow, imported on first use (the data helpers below need only numpy)."""
    import tensorflow as tf

    return tf


class WorldData:
    """The bins of a world as training and held-out windows (the PyTorch
    WorldTask's split: the last days held out, at least one when there are two)."""

    def __init__(self, data_root, *, world_id=None, context=24, horizon=24, stride=1, val_fraction=0.2,
                 max_places=512, seed=0, n_static=None):
        root = Path(data_root)
        if world_id:
            self.bins_dir = R.gev_paths(root)["bins"] / world_id
        else:
            worlds = R.list_bin_worlds(root)
            if not worlds:
                raise DataError(f"no bins under {R.gev_paths(root)['bins']}: record and bin a day first")
            self.bins_dir = worlds[-1]
        self.root = root
        self.world_id = self.bins_dir.name
        wdir = R.find_world(root, self.world_id)
        self.world = R.load_world(wdir, data_root=root) if wdir is not None else None
        series = td.load_bin_series(self.bins_dir, channels=None)
        if series is None:
            raise DataError(f"no bins in {self.bins_dir}")
        self.series = series
        self.channels = list(series["channels"])
        self.context, self.horizon = int(context), int(horizon)
        days = series["days"]
        H, K = series["values"].shape[:2]
        n_val = max(1, round(len(days) * val_fraction)) if len(days) >= 2 else 0
        self.val_days = days[-n_val:] if n_val else []
        self.train_days = days[:-n_val] if n_val else days
        cut = ((self.val_days[0] - series["start"]).days * 24) if self.val_days else H
        self.K = K
        self.n_static = int(n_static or td.place_static(self.world, K).shape[1])
        common = dict(world=self.world, context=self.context, horizon=self.horizon, seed=seed,
                      n_static=self.n_static)
        self.train = td.BinWindows(series, stride=stride, target_hours=(0, cut), max_places=max_places, **common)
        if len(self.train) == 0:
            raise DataError(f"not enough bins for one window: need {self.context + self.horizon} hours "
                            f"before the held-out days ({len(days)} days recorded)")
        val = td.BinWindows(series, stride=max(1, self.horizon), target_hours=(cut, H), shuffle=False, **common)
        self.in_sample = len(val) == 0
        if self.in_sample:
            val = td.BinWindows(series, stride=max(1, self.horizon), shuffle=False, **common)
        self.val = val
        self.domain_cols = {dom: [i for i, ch in enumerate(self.channels) if ch.split(".", 1)[0] in groups]
                            for dom, groups in F.DOMAIN_GROUPS.items()}

    def classes(self):
        classes = set(self.series["classes"])
        if not classes:  # the bins do not say: take each feed's class off the tape for those days
            tape = R.gev_paths(self.root)["tape"]
            for d in self.series["days"]:
                classes.update(R.tape_day_classes(tape, d))
        if self.world is not None and self.world.demographics is not None:
            classes.add("open")  # World Bank WDI, CC BY 4.0
        return sorted(classes) or [F.UNKNOWN_CLASS]

    def manifest(self):
        return {"bins": str(self.bins_dir), "worldId": self.world_id,
                "demographics": self.world is not None and self.world.demographics is not None,
                "binDays": [str(d) for d in self.series["days"]],
                "heldOutDays": [str(d) for d in self.val_days], "channels": self.channels}


def collate(windows):
    """BinWindows items stacked into one batch of numpy arrays."""
    return {k: np.stack([w[k] for w in windows]) for k in ("v", "m", "tf", "s")}


def batches(windows, size, limit=None):
    """Windows from an iterable, `size` at a time, as collated batches."""
    items = []
    for n, item in enumerate(windows):
        if limit is not None and n >= limit:
            break
        items.append(item)
        if len(items) == size:
            yield collate(items)
            items = []
    if items:
        yield collate(items)


def place_rows(batch, context, horizon, keep_empty=False):
    """One row per (window, place): the model's inputs, the targets, the mask.

    `batch` holds numpy arrays v, m [B, L, P, Ch], tf [B, L, P, 6], s [B, P, S]
    (one window without B also works), as BinWindows makes them. The mask keeps
    the observed targets of channels seen in the context (where persistence is
    defined). Rows with nothing to score are dropped unless keep_empty.
    """
    v = np.asarray(batch["v"], np.float32)
    m = np.asarray(batch["m"], np.float32)
    tf_ = np.asarray(batch["tf"], np.float32)
    s = np.asarray(batch["s"], np.float32)
    if v.ndim == 3:
        v, m, tf_, s = v[None], m[None], tf_[None], s[None]
    B, L, P, Ch = v.shape
    c, h = int(context), int(horizon)
    if L < c + h:
        raise ValueError(f"windows of {L} hours are shorter than context {c} + horizon {h}")
    ctx = np.concatenate([v[:, :c], m[:, :c], tf_[:, :c]], axis=-1).transpose(0, 2, 1, 3).reshape(B * P, c, -1)
    fut = tf_[:, c:c + h].transpose(0, 2, 1, 3).reshape(B * P, h, tf_.shape[-1])
    obs = m[:, :c] > 0
    seen = obs.any(axis=1)                                              # [B, P, Ch]
    last_at = c - 1 - np.argmax(obs[:, ::-1], axis=1)                   # the last observed hour
    last = np.take_along_axis(v[:, :c], last_at[:, None], axis=1)[:, 0]
    last = np.where(seen, last, 0.0).astype(np.float32)
    target = v[:, c:c + h].transpose(0, 2, 1, 3).reshape(B * P, h, Ch)
    mask = (m[:, c:c + h] * seen[:, None]).transpose(0, 2, 1, 3).reshape(B * P, h, Ch).astype(np.float32)
    rows = {"context": ctx.astype(np.float32), "future": fut.astype(np.float32),
            "static": s.reshape(B * P, -1).astype(np.float32), "last": last.reshape(B * P, Ch),
            "seen": seen.reshape(B * P, Ch).astype(np.float32)}
    if not keep_empty:
        keep = mask.reshape(B * P, -1).sum(axis=1) > 0
        rows = {k: a[keep] for k, a in rows.items()}
        target, mask = target[keep], mask[keep]
    return rows, target, mask


def build_model(n_channels, n_static, context=24, horizon=24, hidden=64):
    """The Keras model: dilated causal convolutions over the context, then a
    change from persistence for every hour ahead. Builtin ops only (TFLite)."""
    keras = tensorflow().keras
    L = keras.layers
    inputs = {
        "context": keras.Input((context, 2 * n_channels + td.N_TIME_FEATURES), name="context"),
        "future": keras.Input((horizon, td.N_TIME_FEATURES), name="future"),
        "static": keras.Input((n_static,), name="static"),
        "last": keras.Input((n_channels,), name="last"),
        "seen": keras.Input((n_channels,), name="seen"),
    }
    x = inputs["context"]
    for rate in (1, 2, 4):
        x = L.Conv1D(hidden, 3, padding="causal", dilation_rate=rate, activation="relu")(x)
    z = L.Concatenate()([L.Flatten()(x), L.Flatten()(inputs["future"]), inputs["static"], inputs["last"],
                         inputs["seen"]])
    z = L.Dense(2 * hidden, activation="relu")(z)
    z = L.Dense(2 * hidden, activation="relu")(z)
    change = L.Dense(horizon * n_channels, kernel_initializer="zeros", name="change")(z)
    change = L.Reshape((horizon, n_channels))(change)
    pred = L.Add(name="prediction")([L.RepeatVector(horizon)(inputs["last"]), change])
    return keras.Model(inputs=inputs, outputs=pred, name="gev_tf_world")


def model_shape(model):
    """(channels, static width, context, horizon) a model was built for."""
    shapes = {t.name.split(":")[0]: tuple(t.shape) for t in model.inputs}
    ctx, st, last = shapes["context"], shapes["static"], shapes["last"]
    return int(last[-1]), int(st[-1]), int(ctx[1]), int(shapes["future"][1])


def grow_model(model, old_channels, new_channels, hidden=None):
    """A model for `new_channels` that keeps what `model` learned on `old_channels`
    (the PyTorch models.grow_world_model, for Keras): the weights of every channel
    both lists share move to its new position, a new channel starts at zero (it
    predicts persistence until it is learned), and a dropped one is let go.
    None when the two cannot be matched (another static width or window)."""
    n_old, n_static, context, horizon = model_shape(model)
    if n_old != len(old_channels):
        return None
    convs = [layer for layer in model.layers if type(layer).__name__ == "Conv1D"]
    dense = [layer for layer in model.layers if type(layer).__name__ == "Dense"]
    if len(convs) != 3 or len(dense) != 3:
        return None
    hidden = hidden or int(convs[0].filters)
    grown = build_model(len(new_channels), n_static, context, horizon, hidden)
    g_convs = [layer for layer in grown.layers if type(layer).__name__ == "Conv1D"]
    g_dense = [layer for layer in grown.layers if type(layer).__name__ == "Dense"]
    at = {name: i for i, name in enumerate(old_channels)}
    pairs = [(j, at[name]) for j, name in enumerate(new_channels) if name in at]
    new_ix = np.array([j for j, _ in pairs], np.int64)
    old_ix = np.array([i for _, i in pairs], np.int64)
    n_new = len(new_channels)
    # The context features are [values, observed mask, hour features].
    kernel, bias = convs[0].get_weights()
    k = np.zeros((kernel.shape[0], 2 * n_new + td.N_TIME_FEATURES, kernel.shape[2]), kernel.dtype)
    k[:, new_ix] = kernel[:, old_ix]
    k[:, n_new + new_ix] = kernel[:, n_old + old_ix]
    k[:, 2 * n_new:] = kernel[:, 2 * n_old:]
    g_convs[0].set_weights([k, bias])
    for mine, theirs in zip(g_convs[1:], convs[1:]):
        mine.set_weights(theirs.get_weights())
    kernel, bias = dense[0].get_weights()
    fixed = kernel.shape[0] - 2 * n_old  # conv features, the hours ahead, static; then last, seen
    k = np.zeros((fixed + 2 * n_new, kernel.shape[1]), kernel.dtype)
    k[:fixed] = kernel[:fixed]
    k[fixed + new_ix] = kernel[fixed + old_ix]
    k[fixed + n_new + new_ix] = kernel[fixed + n_old + old_ix]
    g_dense[0].set_weights([k, bias])
    g_dense[1].set_weights(dense[1].get_weights())
    kernel, bias = dense[2].get_weights()
    k = np.zeros((kernel.shape[0], horizon * n_new), kernel.dtype)
    b = np.zeros(horizon * n_new, bias.dtype)
    for t in range(horizon):  # the change is [hour, channel], row-major
        k[:, t * n_new + new_ix] = kernel[:, t * n_old + old_ix]
        b[t * n_new + new_ix] = bias[t * n_old + old_ix]
    g_dense[2].set_weights([k, b])
    return grown


def channel_loss(pred, target, mask):
    """Mean squared error averaged across the channels observed in the batch
    (the PyTorch model's balanced_channel_loss): a dense channel does not drown
    a rare one, and a channel with nothing observed is left out."""
    tf = tensorflow()
    err = tf.square(pred - target) * mask
    num = tf.reduce_sum(err, axis=[0, 1])
    cnt = tf.reduce_sum(mask, axis=[0, 1])
    present = tf.cast(cnt > 0, err.dtype)
    per = tf.math.divide_no_nan(num, cnt)
    return tf.math.divide_no_nan(tf.reduce_sum(per * present), tf.reduce_sum(present))


def make_train_step(model, optimizer, clip=1.0):
    tf = tensorflow()

    @tf.function(reduce_retracing=True)
    def step(rows, target, mask):
        with tf.GradientTape() as tape:
            loss = channel_loss(model(rows, training=True), target, mask)
        grads = tape.gradient(loss, model.trainable_variables)
        grads, _ = tf.clip_by_global_norm(grads, clip)
        optimizer.apply_gradients(zip(grads, model.trainable_variables))
        return loss

    return step


def predict_rows(model, rows, chunk=8192):
    out = []
    n = next(iter(rows.values())).shape[0]
    for i in range(0, n, chunk):
        out.append(np.asarray(model({k: a[i: i + chunk] for k, a in rows.items()}, training=False)))
    return np.concatenate(out) if out else np.zeros((0,), np.float32)


def held_out_loss(model, windows, context, horizon, size=8, limit=64):
    """The training loss on held-out windows, without an update."""
    tf = tensorflow()
    total, n = 0.0, 0
    for batch in batches(windows, size, limit):
        rows, target, mask = place_rows(batch, context, horizon)
        if not len(target):
            continue
        loss = float(channel_loss(tf.constant(predict_rows(model, rows)), tf.constant(target), tf.constant(mask)))
        if loss == loss:
            total, n = total + loss, n + 1
    return total / n if n else None


def evaluate(model, data: WorldData, eval_windows=512):
    """MAE against persistence on the held-out windows, overall, per domain and
    per channel: the same report as the PyTorch world model's metrics.json."""
    c, h, Ch = data.context, data.horizon, len(data.channels)
    err_m = np.zeros(Ch, np.float64)
    err_p = np.zeros(Ch, np.float64)
    cnt = np.zeros(Ch, np.float64)
    starts = [int(s) for s in data.val.starts[:eval_windows]]
    for s in starts:  # a window at a time over every place: a K = 5000 window is tens of MB
        rows, target, mask = place_rows(data.val.window(s, crop=False), c, h)
        if not len(target):
            continue
        pred = predict_rows(model, rows)
        err_m += (np.abs(pred - target) * mask).sum(axis=(0, 1))
        err_p += (np.abs(rows["last"][:, None, :] - target) * mask).sum(axis=(0, 1))
        cnt += mask.sum(axis=(0, 1))
    if cnt.sum() == 0:
        return {"skill": None, "note": "no observed targets in the held-out windows"}

    def skill(cols):
        n = cnt[cols].sum()
        if n == 0:
            return None
        return {"metric": "mae", "model": float(err_m[cols].sum() / n), "persistence": float(err_p[cols].sum() / n)}

    return {
        "skill": skill(list(range(Ch))),
        "space": "sign(x)*log1p(|x|) of the bin values, observed targets only",
        "contextHours": c, "horizonHours": h, "windows": len(starts), "inSample": data.in_sample,
        "heldOutDays": [str(d) for d in data.val_days],
        "domains": {dom: skill(cols) for dom, cols in data.domain_cols.items() if cols},
        "byChannel": {ch: skill([i]) for i, ch in enumerate(data.channels)},
    }


def configure_devices(device="auto"):
    """Pick the devices before TensorFlow touches one; returns what it runs on.

    GPU memory grows as needed instead of taking the whole card: the PyTorch
    trainer may be on the same GPU.
    """
    tf = tensorflow()
    gpus = tf.config.list_physical_devices("GPU")
    if device == "cpu" or not gpus:
        if gpus:
            tf.config.set_visible_devices([], "GPU")
        return "CPU"
    for gpu in gpus:
        try:
            tf.config.experimental.set_memory_growth(gpu, True)
        except (RuntimeError, ValueError):
            pass
    try:
        name = tf.config.experimental.get_device_details(gpus[0]).get("device_name")
    except (RuntimeError, ValueError, AttributeError):
        name = None
    return f"GPU {name}" if name else "GPU"
