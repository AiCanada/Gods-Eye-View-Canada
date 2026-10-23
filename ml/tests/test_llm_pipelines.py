"""Each LLM family's pipeline: told from the base model, its adapters, its frozen parts, its target rendering."""

import io
import json
import unittest
from contextlib import redirect_stdout

from torch import nn

from ml.gevtape import llm_pipelines as P
from ml.gevtape import llm_train as T
from ml.tests.support import TempDir


class StubTokenizer:
    """Records what the template was asked for."""

    chat_template = "{{ messages }}"

    def __init__(self):
        self.calls = []

    def apply_chat_template(self, messages, tokenize=False, add_generation_prompt=False, **kwargs):
        self.calls.append({"messages": messages, "add_generation_prompt": add_generation_prompt, **kwargs})
        return "RENDERED"


def model_folder(root, name, config):
    folder = root / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "config.json").write_text(json.dumps(config), encoding="utf-8")
    return folder


class RegistryTest(unittest.TestCase):
    def test_the_registry_names_every_family_with_its_rules(self):
        reg = P.load_registry()
        names = [f["family"] for f in reg["families"]]
        self.assertEqual(names, ["qwen3_5", "qwen3_6", "nemotron_h", "gemma4", "muse_glimmer", "muse_spark",
                                 "deepseek_v4", "generic"])
        ids = [s["id"] for f in reg["families"] for s in f.get("sizes", []) if s.get("id")]
        self.assertEqual(len(ids), len(set(ids)), "no size listed twice")
        for row in reg["families"]:
            pipe = P.family(row["family"])
            self.assertIn("thinking", pipe["format"])
            if not pipe["teacherOnly"]:
                self.assertTrue(pipe["targets"], row["family"])
                self.assertIn("text", pipe["data"])
        self.assertEqual(P.family("qwen3_5")["sizes"][0]["id"], "Qwen/Qwen3.5-0.8B")
        self.assertTrue(P.family("deepseek_v4")["teacherOnly"])
        self.assertEqual(P.family("nobody")["family"], "generic", "an unknown name is the generic pipeline")
        self.assertEqual(T.DEFAULT_TARGETS, tuple(P.family("generic")["targets"]),
                         "the generic pipeline keeps the trainer's own targets")

    def test_a_base_model_is_matched_by_its_config_or_its_name(self):
        tmp = TempDir()
        try:
            root = tmp.path
            cases = [
                ("qwen", {"model_type": "qwen3_5", "architectures": ["Qwen3_5ForConditionalGeneration"]}, "qwen3_5"),
                ("Qwen3.6-35B-A3B", {"model_type": "qwen3_5_moe"}, "qwen3_6"),
                ("lightning", {"model_type": "nemotron_h", "architectures": ["NemotronHForCausalLM"]}, "nemotron_h"),
                ("gemma", {"model_type": "gemma4", "text_config": {"model_type": "gemma4_text"}}, "gemma4"),
                ("glimmer", {"architectures": ["MuseGlimmerForConditionalGeneration"]}, "muse_glimmer"),
                ("v4", {"model_type": "deepseek_v4"}, "deepseek_v4"),
                ("llama", {"model_type": "llama", "architectures": ["LlamaForCausalLM"]}, "generic"),
                ("nothing", {}, "generic"),
            ]
            for name, config, family in cases:
                self.assertEqual(P.pipeline_for(model_folder(root, name, config))["family"], family, name)
            self.assertEqual(P.pipeline_for(root / "missing")["family"], "generic", "no config: generic")
            self.assertEqual(P.pipeline_for("nobody/not-here-model")["family"], "generic",
                             "an id not in the cache downloads nothing and is generic")
            self.assertEqual(P.pipeline_for("Qwen/Qwen3.6-27B")["family"], "qwen3_6", "the name is enough")
            self.assertEqual(P.pipeline_for("x", config={"model_type": "gemma4"})["family"], "gemma4")
        finally:
            tmp.close()

    def test_the_targets_and_frozen_parts_differ_by_family(self):
        self.assertIn("in_proj_qkv", P.family("qwen3_5")["targets"])
        self.assertNotIn("gate_proj", P.family("qwen3_5")["targets"])
        nemotron = P.family("nemotron_h")
        self.assertIn("in_proj", nemotron["targets"])
        self.assertIn("up_proj", nemotron["targets"])
        self.assertTrue(nemotron["experimental"])
        gemma = P.family("gemma4")
        self.assertIn("gate_proj", gemma["targets"])
        for frozen in ("vision_tower", "audio_tower", "embed_tokens_per_layer", "router", "experts"):
            self.assertIn(frozen, gemma["skip"])
        self.assertEqual(gemma["data"], ["text", "image", "audio"])
        self.assertEqual(P.family("muse_glimmer")["format"]["train"], {"reasoning_strength": "low"})


class RenderTest(unittest.TestCase):
    def test_each_family_renders_a_non_thinking_target_through_its_own_template(self):
        msgs = [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "Q?"},
                {"role": "assistant", "content": "A."}]
        for name, wanted in (("qwen3_5", {"enable_thinking": False}), ("qwen3_6", {"enable_thinking": False}),
                             ("nemotron_h", {"enable_thinking": False}), ("gemma4", {}),
                             ("muse_glimmer", {"reasoning_strength": "low"}), ("generic", {})):
            tok = StubTokenizer()
            self.assertEqual(P.render_target(tok, msgs, P.family(name)), "RENDERED", name)
            call = tok.calls[-1]
            self.assertEqual({k: v for k, v in call.items() if k not in ("messages", "add_generation_prompt")},
                             wanted, name)
            self.assertFalse(call["add_generation_prompt"])
        # Gemma 4: a <|think|> at the start of the system prompt would switch thinking on; it is taken off.
        tok = StubTokenizer()
        P.render_target(tok, [{"role": "system", "content": "<|think|> Be brief."}, *msgs[1:]], P.family("gemma4"))
        self.assertEqual(tok.calls[-1]["messages"][0]["content"], "Be brief.")
        # A prompt for generation: the generate kwargs and the generation prompt.
        tok = StubTokenizer()
        P.render_target(tok, msgs[1:2], P.family("qwen3_5"), add_generation_prompt=True)
        self.assertTrue(tok.calls[-1]["add_generation_prompt"])
        self.assertEqual(tok.calls[-1]["enable_thinking"], False)
        # No template at all: Role: lines, and Assistant: to answer after.
        plain = type("Tok", (), {"chat_template": None})()
        self.assertEqual(P.render_target(plain, msgs[1:], P.family("generic")), "User: Q?\nAssistant: A.")
        self.assertEqual(P.render_target(plain, msgs[1:2], None, add_generation_prompt=True), "User: Q?\nAssistant:")

    def test_what_this_python_lacks_is_said_before_anything_loads(self):
        ok, why = P.needs_met(P.family("muse_glimmer"), installed="5.14.1")
        self.assertFalse(ok)
        self.assertIn("transformers 5.15 or newer (installed 5.14.1)", why)
        self.assertIn("pip install -U transformers", why)
        ok, why = P.needs_met(P.family("deepseek_v4"), installed="5.14.1")
        self.assertFalse(ok)
        self.assertIn("trains nowhere on this PC", why)
        self.assertIn("AI DISTILLATION", why)
        self.assertEqual(P.needs_met(P.family("generic"), installed="4.57.1"), (True, ""))
        self.assertEqual(P.needs_met(P.family("qwen3_5"), installed=""), (True, ""), "no transformers to compare: the load says")
        self.assertEqual(P._version_tuple("5.15.0.dev0"), (5, 15, 0, 0))

    def test_adapters_skip_the_frozen_parts_of_a_model(self):
        class Block(nn.Module):
            def __init__(self):
                super().__init__()
                self.q_proj = nn.Linear(4, 4)
                self.up_proj = nn.Linear(4, 4)

        class Model(nn.Module):
            def __init__(self):
                super().__init__()
                self.visual = Block()
                self.layers = nn.ModuleList([Block(), Block()])
                self.embed_tokens_per_layer = nn.Embedding(4, 4)

        model = Model()
        names = T.add_lora(model, 2, 4, ("q_proj", "up_proj"), skip=("visual", "embed_tokens_per_layer"))
        self.assertEqual(names, ["layers.0.q_proj", "layers.0.up_proj", "layers.1.q_proj", "layers.1.up_proj"])
        self.assertIsInstance(model.visual.q_proj, nn.Linear, "the tower stays as it was")

    def test_the_command_line_lists_every_family_and_a_base(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(P.main(["--json"]), 0)
        got = json.loads(out.getvalue())
        self.assertEqual(len(got["families"]), 8)
        self.assertIn("transformers", got["installed"])
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(P.main(["--base", "Qwen/Qwen3.6-27B"]), 0)
        self.assertIn("Qwen/Qwen3.6-27B: qwen3_6", out.getvalue())
        self.assertIn("teacher only", out.getvalue())


if __name__ == "__main__":
    unittest.main()
