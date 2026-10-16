"""Ask a custom LLM trained by ml.gevtape.llm_train (its base, plus its adapters).

    python -m ml.gevtape.llm_chat --model <model folder> --prompt "What moved before crude?" [--max-new 200]

The base model comes from this machine only, as in training.
"""

from __future__ import annotations

import argparse
import sys

import torch

from .llm_train import add_lora, load_base, load_lora_state, read_adapter
from .train import DataError, resolve_device


def ask(model_dir, prompt, *, max_new=200, device="auto", loader=None):
    meta, state = read_adapter(model_dir)
    dev = resolve_device(device)
    tok, model = load_base(meta["base"], dev, loader=loader)
    dev = getattr(model, "gev_input_device", dev)
    add_lora(model, meta["rank"], meta["alpha"], tuple(meta["targets"]))
    load_lora_state(model, state)
    model.eval()
    msgs = [{"role": "user", "content": prompt}]
    text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True) \
        if getattr(tok, "chat_template", None) else f"User: {prompt}\nAssistant:"
    ids = tok(text, return_tensors="pt").to(dev)
    with torch.no_grad():
        out = model.generate(**ids, max_new_tokens=max_new, do_sample=False,
                             pad_token_id=tok.pad_token_id if tok.pad_token_id is not None else 0)
    return tok.decode(out[0, ids["input_ids"].shape[1]:], skip_special_tokens=True).strip()


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m ml.gevtape.llm_chat", description=__doc__.split("\n\n")[0])
    p.add_argument("--model", required=True)
    p.add_argument("--prompt", required=True)
    p.add_argument("--max-new", type=int, default=200)
    p.add_argument("--device", default="auto")
    args = p.parse_args(argv)
    try:
        print(ask(args.model, args.prompt, max_new=args.max_new, device=args.device))
    except (DataError, OSError) as e:
        print(f"llm_chat: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
