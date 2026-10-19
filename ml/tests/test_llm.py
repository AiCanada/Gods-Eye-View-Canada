"""Custom LLM training: the dataset from recorded data and the owner's sources, LoRA training and post-training."""

import datetime as dt
import gzip
import json
import unittest
from pathlib import Path

from ml.gevtape import llm_chat as C
from ml.gevtape import llm_data as D
from ml.gevtape import llm_train as T
from ml.gevtape.train import Control, DataError
from ml.tests.support import TempDir

DAY = dt.date(2026, 10, 14)


def tape(root, feed, day, hour, records):
    d = Path(root) / "tape" / feed / f"{day:%Y}" / f"{day:%m}" / f"{day:%d}"
    d.mkdir(parents=True, exist_ok=True)
    with gzip.open(d / f"{hour:02d}.ndjson.gz", "at", encoding="utf-8") as f:
        for rec in records:
            f.write(json.dumps(rec) + "\n")


def tiny_model(folder):
    """A two-layer Llama and a word-level tokenizer, saved like a downloaded model."""
    from tokenizers import Tokenizer, models, pre_tokenizers
    from transformers import LlamaConfig, LlamaForCausalLM, PreTrainedTokenizerFast

    words = ("<pad> <unk> <eos> news headlines on recorded prices wti crude gold first last low high up down "
             "which assets moved most over the next day user assistant the a of and in to is gev world model "
             "storm port oil rises falls 2026 10 14 15 - : . , % ( ) ;").split()
    vocab = {w: i for i, w in enumerate(dict.fromkeys(words))}
    raw = Tokenizer(models.WordLevel(vocab=vocab, unk_token="<unk>"))
    raw.pre_tokenizer = pre_tokenizers.Whitespace()
    tok = PreTrainedTokenizerFast(tokenizer_object=raw, unk_token="<unk>", pad_token="<pad>", eos_token="<eos>")
    cfg = LlamaConfig(vocab_size=len(vocab), hidden_size=32, intermediate_size=64, num_hidden_layers=2,
                      num_attention_heads=2, num_key_value_heads=2, max_position_embeddings=256)
    LlamaForCausalLM(cfg).save_pretrained(folder)
    tok.save_pretrained(folder)
    return folder


class LlmDataTest(unittest.TestCase):
    def test_recorded_sources_urls_and_local_files_become_examples(self):
        tmp = TempDir()
        try:
            root = tmp.path / ".gev-data"
            t0 = 1792000000000
            tape(root, "news", DAY, 9, [{"t": t0, "title": "Storm shuts port", "place": "Houston", "class": "nc"}])
            tape(root, "markets", DAY, 9, [{"series": "crude", "label": "WTI crude", "unit": "usd", "value": 95.0,
                                            "quotedAt": t0}])
            nxt = DAY + dt.timedelta(days=1)
            tape(root, "markets", nxt, 9, [{"series": "crude", "label": "WTI crude", "value": 95.0, "quotedAt": t0},
                                           {"series": "crude", "label": "WTI crude", "value": 97.0,
                                            "quotedAt": t0 + 3600000}])
            urls = root / "llm" / "sources" / "urls"
            urls.mkdir(parents=True)
            (urls / "a1.txt").write_text("https://example.org/report\n\nThe port reopened after the storm.")
            mine = tmp.path / "mine"
            mine.mkdir()
            (mine / "notes.md").write_text("# Notes\nOil rises when ports close.")
            (mine / "chat.jsonl").write_text(json.dumps({"messages": [{"role": "user", "content": "hi"},
                                                                     {"role": "assistant", "content": "hello"}]}) + "\n")
            (mine / "photo.png").write_bytes(b"\x89PNG")
            (mine / "page.html").write_text("<html><script>x()</script><p>Gold &amp; oil</p></html>")
            out = tmp.path / "data"
            m = D.build(root, out, list(D.SOURCES), urls_dir=urls, paths=[str(mine)])
            self.assertEqual(m["counts"]["news"], 1)
            self.assertEqual(m["counts"]["prices"], 2)
            self.assertEqual(m["counts"]["news-moves"], 1)
            self.assertEqual(m["counts"]["urls"], 1)
            self.assertEqual(m["counts"]["local"], 3, "notes, the chat line and the page; never the picture")
            self.assertEqual(m["dataThrough"], nxt.isoformat())
            self.assertIn("personal", m["classes"])
            lines = [json.loads(x) for f in ("train.jsonl", "heldout.jsonl")
                     for x in (out / f).read_text(encoding="utf-8").splitlines()]
            self.assertEqual(m["train"] + m["heldout"], len(lines))
            moves = next(x for x in lines if x["source"] == "news-moves")
            self.assertIn("Storm shuts port", moves["messages"][0]["content"])
            self.assertIn("WTI crude up 2.11%", moves["messages"][1]["content"])
            self.assertIn("not advice", moves["messages"][1]["content"])
            page = next(x for x in lines if x["source"] == "local" and "page.html" in x.get("text", ""))
            self.assertIn("Gold & oil", page["text"])
            self.assertNotIn("x()", page["text"])
            # A rebuild keeps the same held-out split.
            again = D.build(root, tmp.path / "data2", list(D.SOURCES), urls_dir=urls, paths=[str(mine)])
            self.assertEqual(again["heldout"], m["heldout"])
            with self.assertRaises(ValueError):
                D.build(root, tmp.path / "x", ["nonsense"])
        finally:
            tmp.close()

    def test_distilled_ground_truths_become_question_and_answer_pairs(self):
        tmp = TempDir()
        try:
            root = tmp.path / ".gev-data"
            run = root / "distill" / "h3-abc"
            run.mkdir(parents=True)
            rows = [{"question": "What moved before crude?", "groundTruth": "Shipping rates.", "class": "restricted"},
                    {"question": "No answer", "groundTruth": ""}]
            (run / "dataset.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows) + "not json\n",
                                               encoding="utf-8")
            out = tmp.path / "data"
            m = D.build(root, out, ["distilled"])
            self.assertEqual(m["counts"]["distilled"], 1, "a record with no ground truth is not an example")
            self.assertEqual(m["classes"], ["restricted"])
            lines = [json.loads(x) for f in ("train.jsonl", "heldout.jsonl")
                     for x in (out / f).read_text(encoding="utf-8").splitlines()]
            self.assertEqual(lines[0]["messages"], [{"role": "user", "content": "What moved before crude?"},
                                                    {"role": "assistant", "content": "Shipping rates."}])
        finally:
            tmp.close()


class LlmTrainTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = TempDir()
        cls.base = tiny_model(cls.tmp.path / "base")
        data = cls.tmp.path / "data"
        data.mkdir()
        lines = [{"text": "news headlines on 2026 10 14 : storm port . oil rises ."} for _ in range(24)]
        (data / "train.jsonl").write_text("\n".join(json.dumps(x) for x in lines))
        (data / "heldout.jsonl").write_text(json.dumps(lines[0]))
        (data / "manifest.json").write_text(json.dumps({"dataThrough": "2026-10-14", "classes": ["nc"]}))
        cls.data = data

    @classmethod
    def tearDownClass(cls):
        cls.tmp.close()

    def args(self, out, *extra):
        return T.build_parser().parse_args(["--data-dir", str(self.data), "--base", str(self.base), "--out", str(out),
                                            "--device", "cpu", "--epochs", "3", "--batch-size", "4",
                                            "--accumulate", "1", "--lr", "5e-3", "--rank", "4", *extra])

    def test_lora_learns_the_data_and_saves_only_the_adapters(self):
        out = self.tmp.path / "model"
        events = []
        self.assertEqual(T.run(self.args(out), lambda e, **f: events.append((e, f)), Control()), 0)
        meta = json.loads((out / T.ADAPTER_META).read_text())
        self.assertLess(meta["heldOutLossAfter"], meta["heldOutLossBefore"])
        self.assertTrue(meta["helped"])
        self.assertEqual(meta["dataThrough"], "2026-10-14")
        self.assertEqual(meta["base"], str(self.base))
        self.assertEqual(meta["wrapped"], 8, "q, k, v and o in both layers")
        self.assertTrue((out / T.ADAPTER_FILE).is_file())
        self.assertFalse(any(p.suffix == ".bin" for p in out.iterdir()), "the frozen base is not copied")
        self.assertEqual([e for e, _ in events][-1], "done")
        answer = C.ask(out, "news headlines", max_new=4, device="cpu")
        self.assertIsInstance(answer, str)

    def test_post_training_starts_from_the_earlier_adapters(self):
        first = self.tmp.path / "first"
        T.run(self.args(first, "--epochs", "1"), lambda *a, **k: None, Control())
        later = self.tmp.path / "later"
        self.assertEqual(T.run(self.args(later, "--from", str(first)), lambda *a, **k: None, Control()), 0)
        meta = json.loads((later / T.ADAPTER_META).read_text())
        self.assertEqual(meta["postTrainedFrom"], "first")
        first_meta = json.loads((first / T.ADAPTER_META).read_text())
        self.assertLessEqual(meta["heldOutLossBefore"], first_meta["heldOutLossBefore"],
                             "it starts where the earlier model left off, not from scratch")

    def test_pause_saves_and_resume_carries_on(self):
        out = self.tmp.path / "paused"
        control = Control()
        control.pause.set()
        events = []
        T.run(self.args(out), lambda e, **f: events.append((e, f)), control)
        self.assertIn("paused", [e for e, _ in events])
        events = []
        self.assertEqual(T.run(self.args(out, "--resume"), lambda e, **f: events.append((e, f)), Control()), 0)
        self.assertEqual([e for e, _ in events][-1], "done")

    def test_a_base_model_not_on_this_machine_is_refused_not_downloaded(self):
        with self.assertRaises(DataError) as caught:
            T.run(T.build_parser().parse_args(["--data-dir", str(self.data), "--base", "nobody/not-here-model",
                                               "--out", str(self.tmp.path / "none"), "--device", "cpu"]),
                  lambda *a, **k: None, Control())
        self.assertIn("NOT ON THIS MACHINE", str(caught.exception))


class PlacementTest(unittest.TestCase):
    def test_a_base_too_big_for_the_gpu_is_split_across_gpu_and_ram(self):
        G = T.GIB
        self.assertEqual(T.choose_placement(1.2 * G, 7.5 * G, 128 * G), "gpu", "Qwen3-0.6B fits the 4060")
        self.assertEqual(T.choose_placement(67 * G, 7.5 * G, 128 * G), "split", "Qwen3.6-35B-A3B does not")
        self.assertEqual(T.choose_placement(67 * G, 0, 128 * G), "cpu", "no GPU: RAM only")
        self.assertEqual(T.choose_placement(1 * G, 7.5 * G, 128 * G, "cpu"), "cpu")
        self.assertEqual(T.choose_placement(1 * G, 0, 128 * G, "gpu"), "cpu", "no GPU to force")
        with self.assertRaises(DataError):
            T.choose_placement(200 * G, 7.5 * G, 128 * G)
        self.assertIn("in_proj_qkv", T.DEFAULT_TARGETS, "the gated-delta layers of Qwen3.6 get adapters too")
        self.assertEqual(T.DEFAULT_BASE, "Qwen/Qwen3.5-0.8B")

    def test_the_weights_on_disk_are_measured_from_a_folder(self):
        tmp = TempDir()
        try:
            (tmp.path / "a.safetensors").write_bytes(b"x" * 1000)
            (tmp.path / "b.safetensors").write_bytes(b"x" * 24)
            (tmp.path / "config.json").write_text("{}")
            self.assertEqual(T.weight_bytes(tmp.path), 1024)
            self.assertEqual(T.weight_bytes(tmp.path / "missing"), 0)
        finally:
            tmp.close()


if __name__ == "__main__":
    unittest.main()
