"""The kit's models as MLflow models (pyfunc), for MODEL REGISTRY, MODEL SERVING
and EVALUATION in the AI World tab.

Every world model, PyTorch or Keras, takes and gives the same thing, so the
registry can hold both, a served one answers the same request, and one
evaluation scores them side by side:

  input   a dict of arrays, one or more windows of the hourly bins:
          v, m  [B, L, K, C]  symlog values (0 where missing) and the observed mask
                              (only the first `context` hours are read)
          tf    [B, L, K, 6]  hour features of every hour (L = context + horizon)
          s     [B, K, S]     place features
  output  [B, horizon, K, C]  symlog predictions (sign(y)*expm1(|y|) for values)

C is the model's channel list (config.json, the version's `gev.channels`
tag). The PyTorch model uses its place graph when K is the world's, and no
graph on a crop. The custom LLM takes a `prompt` column and gives answers,
each kept as an MLflow trace when tracing is on.

The model's code goes with it (`code_paths`: this repository's ml/ package),
so `mlflow models serve --env-manager local` runs it in this Python.
"""

from __future__ import annotations

import json
from pathlib import Path

import mlflow.pyfunc
import numpy as np

WORLD_KINDS = ("world", "tf-world")


def window_arrays(model_input, context, horizon):
    """v, m, tf, s as float32 with a batch axis; v and m padded to tf's hours."""
    if hasattr(model_input, "to_dict") and not isinstance(model_input, dict):
        raise ValueError("a world model takes a dict of arrays: v, m, tf, s")
    arrays = {k: np.asarray(model_input[k], dtype=np.float32) for k in ("v", "m", "tf", "s")}
    if arrays["v"].ndim == 3:
        arrays = {k: a[None] for k, a in arrays.items()}
    L = arrays["tf"].shape[1]
    if L < context + horizon:
        raise ValueError(f"tf covers {L} hours; the model needs context {context} + horizon {horizon}")
    for k in ("v", "m"):
        if arrays[k].shape[1] < context:
            raise ValueError(f"{k} covers {arrays[k].shape[1]} hours; the model reads {context}")
        if arrays[k].shape[1] < L:
            pad = np.zeros((arrays[k].shape[0], L - arrays[k].shape[1]) + arrays[k].shape[2:], np.float32)
            arrays[k] = np.concatenate([arrays[k], pad], axis=1)
    return arrays


class KitWorldModel(mlflow.pyfunc.PythonModel):
    """The kit's PyTorch world model (ml.gevtape.train --model world)."""

    def load_context(self, context):
        import torch

        from ml.gevtape import models as M

        self.config = json.loads(Path(context.artifacts["config"]).read_text(encoding="utf-8"))
        ckpt = torch.load(context.artifacts["checkpoint"], map_location="cpu", weights_only=True)
        self.model = M.build_model("world", ckpt["model_config"])
        self.model.load_state_dict(ckpt["model"])
        self.model.eval()
        graph = np.load(context.artifacts["graph"])
        self.K = int(graph["K"])
        self.adj = M.adjacency_tensor(graph["rows"], graph["cols"], graph["weights"], self.K)
        self.context, self.horizon = int(self.config["context"]), int(self.config["horizon"])

    def predict(self, context, model_input, params=None):
        import torch

        from ml.gevtape import models as M

        a = window_arrays(model_input, self.context, self.horizon)
        K = a["v"].shape[2]
        adj = self.adj if K == self.K else M.adjacency_tensor(np.zeros(0, np.int64), np.zeros(0, np.int64),
                                                               np.zeros(0, np.float32), K)
        c, h = self.context, self.horizon
        t = {k: torch.from_numpy(v) for k, v in a.items()}
        with torch.no_grad():
            pred, _ = self.model.rollout(t["v"][:, :c], t["m"][:, :c], t["tf"][:, :c + h], t["s"], adj, h)
        return pred.numpy().astype(np.float32)


class KerasWorld(mlflow.pyfunc.PythonModel):
    """The Keras world model (ml.gevtape.tf_train), read per place."""

    def load_context(self, context):
        from ml.gevtape import tf_world as W

        self.config = json.loads(Path(context.artifacts["config"]).read_text(encoding="utf-8"))
        self.model = W.tensorflow().keras.models.load_model(context.artifacts["model"], compile=False)
        self.context, self.horizon = int(self.config["context"]), int(self.config["horizon"])

    def predict(self, context, model_input, params=None):
        from ml.gevtape import tf_world as W

        a = window_arrays(model_input, self.context, self.horizon)
        B, _, K, C = a["v"].shape
        rows, _, _ = W.place_rows(a, self.context, self.horizon, keep_empty=True)
        pred = W.predict_rows(self.model, rows)                     # [B*K, h, C]
        return pred.reshape(B, K, self.horizon, C).transpose(0, 2, 1, 3).astype(np.float32)


class CustomLlm(mlflow.pyfunc.PythonModel):
    """A custom LLM (ml.gevtape.llm_train): the base model on this machine plus its adapters."""

    def load_context(self, context):
        from ml.gevtape import llm_chat

        self.config = json.loads(Path(context.artifacts["config"]).read_text(encoding="utf-8"))
        self.tok, self.model, self.dev, self.meta = llm_chat.load(context.artifacts["adapter"])

    def predict(self, context, model_input, params=None):
        from ml.gevtape import llm_chat

        if hasattr(model_input, "columns"):
            prompts = [str(p) for p in model_input["prompt"].tolist()]
        elif isinstance(model_input, dict):
            got = model_input.get("prompt", "")
            prompts = [str(p) for p in (got if isinstance(got, (list, tuple)) else [got])]
        else:
            prompts = [str(p) for p in model_input]
        max_new = int((params or {}).get("max_new_tokens", 200))
        answers = []
        for prompt in prompts:
            with llm_chat.traced("custom LLM", {"prompt": prompt},
                                 {"gev.model": self.config.get("name", ""), "gev.base": str(self.meta.get("base"))}) \
                    as (set_outputs, _):
                answer = llm_chat.generate(self.tok, self.model, self.dev, prompt, max_new=max_new)
                set_outputs({"answer": answer})
            answers.append(answer)
        return answers


def world_signature(n_channels, n_static, horizon):
    from mlflow.models import ModelSignature
    from mlflow.types.schema import Schema, TensorSpec

    f32 = np.dtype(np.float32)
    inputs = Schema([TensorSpec(f32, (-1, -1, -1, n_channels), "v"), TensorSpec(f32, (-1, -1, -1, n_channels), "m"),
                     TensorSpec(f32, (-1, -1, -1, 6), "tf"), TensorSpec(f32, (-1, -1, n_static), "s")])
    outputs = Schema([TensorSpec(f32, (-1, horizon, -1, n_channels))])
    return ModelSignature(inputs=inputs, outputs=outputs)


def llm_signature():
    from mlflow.models import ModelSignature
    from mlflow.types.schema import ColSpec, ParamSchema, ParamSpec, Schema

    return ModelSignature(inputs=Schema([ColSpec("string", "prompt")]), outputs=Schema([ColSpec("string")]),
                          params=ParamSchema([ParamSpec("max_new_tokens", "long", 200)]))
