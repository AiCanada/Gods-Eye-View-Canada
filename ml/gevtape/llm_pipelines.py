"""Each LLM family's training pipeline: what LoRA adapts, what stays frozen, how a training target is rendered.

    python -m ml.gevtape.llm_pipelines [--base <folder or id>] [--json]

Owner request 2026-10-22: "Each LLM will have its own training pipeline
determining the type of data and format; research pipelines for Qwen 3.5, 3.6,
Nvidia Nemotron, Meta Spark Open, Gemma 4, DeepSeek-V4-Pro." The registry is
llm_pipelines.json beside this file (the server reads the same file for the
base list and the PIPELINE line). A family is told from the base model's
config.json (model_type, architectures), or from its name where the classes
are shared (Qwen 3.6 uses Qwen 3.5's).

A pipeline says:

  targets   the linear layers LoRA adapts (attention; Gated DeltaNet, Mamba or
            MLP projections where the family has them)
  skip      module names left frozen whatever their layers are called (vision
            and audio towers, perception encoders, per-layer embeddings,
            routers, routed experts, multi-token-prediction heads)
  format    how the family's own chat template renders a training target with
            thinking off: a kwarg (enable_thinking: false), a token the system
            prompt must not start with (<|think|>), a reasoning strength, or
            nothing; and the kwargs generation uses
  data      the data types the family can take (text now; image, audio later)
  needs     the transformers version, and kernels for a fast path
  teacherOnly  too big for any training here: a teacher in AI DISTILLATION

Nothing here downloads or loads a model: a config is read from a folder or the
local Hugging Face cache only.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

REGISTRY_FILE = Path(__file__).with_name("llm_pipelines.json")
GENERIC = "generic"


def load_registry(path=REGISTRY_FILE) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def families(registry=None) -> list:
    return list((registry or load_registry()).get("families", []))


def family(name, registry=None) -> dict:
    """The pipeline named `name`, else the generic one."""
    rows = families(registry)
    for row in rows:
        if row.get("family") == name:
            return _complete(row)
    return _complete(next(row for row in rows if row.get("family") == GENERIC))


def _complete(row) -> dict:
    """A pipeline with every field present, as a copy."""
    out = json.loads(json.dumps(row))
    out.setdefault("targets", [])
    out.setdefault("skip", [])
    out.setdefault("format", {"system": True, "thinking": "none", "train": {}, "generate": {}})
    out["format"].setdefault("train", {})
    out["format"].setdefault("generate", {})
    out.setdefault("data", ["text"])
    out.setdefault("needs", {})
    out.setdefault("teacherOnly", False)
    out.setdefault("experimental", False)
    out.setdefault("sizes", [])
    return out


def read_config(base) -> dict:
    """The base model's config.json from a folder, or the local Hugging Face cache; {} when there is none."""
    folder = Path(str(base))
    if not folder.is_dir():
        try:
            from huggingface_hub import snapshot_download

            folder = Path(snapshot_download(str(base), local_files_only=True, allow_patterns=["config.json"]))
        except Exception:
            return {}
    try:
        return json.loads((folder / "config.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def pipeline_for(base, config=None, registry=None) -> dict:
    """The pipeline a base model trains through: by its name where a family shares
    another's classes, else by model_type or architectures, else the generic one."""
    rows = families(registry)
    name = str(base or "").replace("\\", "/").rstrip("/").lower()
    for row in rows:
        if any(str(s.get("id", "")).lower() == name for s in row.get("sizes", []) if s.get("id")):
            return _complete(row)
    for row in rows:
        for needle in row.get("match", {}).get("name", []) or []:
            if needle.lower() in name:
                return _complete(row)
    cfg = config if config is not None else read_config(base)
    types = {str(cfg.get("model_type") or "")}
    for sub in ("text_config",):
        if isinstance(cfg.get(sub), dict):
            types.add(str(cfg[sub].get("model_type") or ""))
    archs = {str(a) for a in (cfg.get("architectures") or [])}
    types.discard("")
    for row in rows:
        match = row.get("match", {})
        if types & set(match.get("model_type", [])) or archs & set(match.get("architectures", [])):
            return _complete(row)
    return family(GENERIC, registry)


def _version_tuple(text) -> tuple:
    out = []
    for part in str(text or "").split("."):
        digits = ""
        for ch in part:
            if ch.isdigit():
                digits += ch
            else:
                break
        out.append(int(digits or 0))
    return tuple(out)


def installed_transformers() -> str:
    try:
        from transformers import __version__

        return str(__version__)
    except Exception:
        return ""


def needs_met(pipeline, installed=None) -> tuple:
    """(ok, why): whether this Python can train the family. A missing version
    or model class gives the one line to run; kernels only mark a slow path."""
    if pipeline.get("teacherOnly"):
        return False, (f"{pipeline.get('label', pipeline.get('family'))} trains nowhere on this PC: "
                       "use it as a teacher in AI DISTILLATION.")
    needs = pipeline.get("needs") or {}
    wanted = needs.get("transformers")
    have = installed_transformers() if installed is None else installed
    if wanted and have and _version_tuple(have) < _version_tuple(wanted):
        return False, (f"{pipeline.get('label')} needs transformers {wanted} or newer (installed {have}): "
                       "py -3.13 -m pip install -U transformers")
    for model_type in (pipeline.get("match") or {}).get("model_type", [])[:1]:
        if have and importlib.util.find_spec("transformers") and \
                importlib.util.find_spec(f"transformers.models.{model_type}") is None:
            return False, (f"{pipeline.get('label')} is not in the installed transformers ({have}): "
                           "py -3.13 -m pip install -U transformers")
    return True, ""


def train_kwargs(pipeline) -> dict:
    return dict((pipeline.get("format") or {}).get("train") or {})


def generate_kwargs(pipeline) -> dict:
    return dict((pipeline.get("format") or {}).get("generate") or {})


def render_target(tok, messages, pipeline=None, *, add_generation_prompt=False) -> str:
    """The training (or prompt) text through the family's own template with
    thinking off; a model without a template gets Role: lines."""
    msgs = [m for m in messages if isinstance(m, dict) and isinstance(m.get("content"), str)]
    if pipeline and (pipeline.get("format") or {}).get("thinking") == "system-token":
        token = (pipeline.get("format") or {}).get("token") or ""
        if token:
            msgs = [{**m, "content": m["content"][len(token):].lstrip()} if m.get("role") == "system"
                    and m["content"].startswith(token) else m for m in msgs]
    if getattr(tok, "chat_template", None):
        kwargs = (generate_kwargs(pipeline) if add_generation_prompt else train_kwargs(pipeline)) if pipeline else {}
        try:
            return tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=add_generation_prompt,
                                           **kwargs)
        except Exception:
            pass
    text = "\n".join(f"{m.get('role', 'user').title()}: {m['content']}" for m in msgs)
    return f"{text}\nAssistant:" if add_generation_prompt else text


def describe(base=None, registry=None) -> dict:
    """The registry with what this Python has, and the pipeline of `base` when given."""
    reg = registry or load_registry()
    have = installed_transformers()
    rows = []
    for row in families(reg):
        pipe = _complete(row)
        ok, why = needs_met(pipe, have)
        rows.append({**pipe, "met": ok, "why": why})
    out = {"installed": {"transformers": have}, "families": rows}
    if base:
        pipe = pipeline_for(base, registry=reg)
        ok, why = needs_met(pipe, have)
        out["base"] = {"base": str(base), **pipe, "met": ok, "why": why}
    return out


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m ml.gevtape.llm_pipelines", description=__doc__.split("\n\n")[0])
    p.add_argument("--base", default=None, help="a model folder or id: which pipeline it trains through")
    p.add_argument("--json", action="store_true", help="the whole registry as JSON (the default is one line a family)")
    args = p.parse_args(argv)
    got = describe(args.base)
    if args.json:
        print(json.dumps(got, ensure_ascii=False, indent=2))
        return 0
    for row in got["families"]:
        state = "teacher only" if row.get("teacherOnly") else ("ready" if row["met"] else row["why"])
        print(f"{row['family']:14} {row['label']:22} {state}")
    if "base" in got:
        b = got["base"]
        print(f"{b['base']}: {b['family']} ({'ok' if b['met'] else b['why']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
