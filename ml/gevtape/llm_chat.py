"""Ask a custom LLM trained by ml.gevtape.llm_train (its base, plus its adapters).

    python -m ml.gevtape.llm_chat --model <model folder> --prompt "What moved before crude?" [--max-new 200]
                                  [--trace --tracking-uri <MLflow server>] [--json]

The base model comes from this machine only, as in training. With --trace the
question and the answer are kept as an MLflow trace (LLM TRACING in the AI
World tab), in the experiment ai-world/llm-traces; --json prints one protocol
line, {"event":"answer","answer","traceId","experimentId"}, for the server.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import sys
import time

import torch

from .llm_train import add_lora, load_base, load_lora_state, read_adapter
from .protocol import utf8_streams
from .train import DataError, resolve_device

TRACE_EXPERIMENT = "ai-world/llm-traces"


def load(model_dir, *, device="auto", loader=None):
    """(tokenizer, model, input device, adapter meta) of a trained custom LLM, ready to answer."""
    meta, state = read_adapter(model_dir)
    dev = resolve_device(device)
    tok, model = load_base(meta["base"], dev, loader=loader)
    dev = getattr(model, "gev_input_device", dev)
    add_lora(model, meta["rank"], meta["alpha"], tuple(meta["targets"]))
    load_lora_state(model, state)
    model.eval()
    return tok, model, dev, meta


def generate(tok, model, dev, prompt, *, max_new=200):
    msgs = [{"role": "user", "content": prompt}]
    text = tok.apply_chat_template(msgs, tokenize=False, add_generation_prompt=True) \
        if getattr(tok, "chat_template", None) else f"User: {prompt}\nAssistant:"
    ids = tok(text, return_tensors="pt").to(dev)
    with torch.no_grad():
        out = model.generate(**ids, max_new_tokens=max_new, do_sample=False,
                             pad_token_id=tok.pad_token_id if tok.pad_token_id is not None else 0)
    return tok.decode(out[0, ids["input_ids"].shape[1]:], skip_special_tokens=True).strip()


def ask(model_dir, prompt, *, max_new=200, device="auto", loader=None):
    tok, model, dev, _ = load(model_dir, device=device, loader=loader)
    return generate(tok, model, dev, prompt, max_new=max_new)


def traced(name, inputs, attributes=None):
    """An MLflow span around one answer when MLflow is set up, else nothing.
    Yields a setter for the outputs and, after the block, the trace id."""
    try:
        import mlflow
    except ImportError:
        mlflow = None

    @contextlib.contextmanager
    def span():
        box = {"traceId": None}
        if mlflow is None:
            yield (lambda outputs: None), box
            return
        with mlflow.start_span(name=name, span_type="LLM") as s:
            s.set_inputs(inputs)
            if attributes:
                s.set_attributes(attributes)
            yield s.set_outputs, box
            box["traceId"] = getattr(s, "trace_id", None) or getattr(s, "request_id", None)
        # Traces are written in the background: wait for this one before it is reported.
        flush = getattr(mlflow, "flush_trace_async_logging", None)
        if flush is not None:
            try:
                flush()
            except Exception:  # noqa: BLE001  a trace that cannot be written does not stop the answer
                pass

    return span()


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m ml.gevtape.llm_chat", description=__doc__.split("\n\n")[0])
    p.add_argument("--model", required=True)
    p.add_argument("--prompt", required=True)
    p.add_argument("--max-new", type=int, default=200)
    p.add_argument("--device", default="auto")
    p.add_argument("--trace", action="store_true", help="keep the question and answer as an MLflow trace")
    p.add_argument("--tracking-uri", default=None, help="the MLflow server (default MLFLOW_TRACKING_URI)")
    p.add_argument("--json", action="store_true", help="one protocol line instead of the bare answer")
    args = p.parse_args(argv)
    utf8_streams()
    experiment_id = None
    try:
        if args.trace:
            import mlflow

            if args.tracking_uri:
                mlflow.set_tracking_uri(args.tracking_uri)
            experiment_id = mlflow.set_experiment(TRACE_EXPERIMENT).experiment_id
        started = time.time()
        tok, model, dev, meta = load(args.model, device=args.device)
        attributes = {"gev.model": str(args.model), "gev.base": str(meta.get("base")),
                      "max_new_tokens": args.max_new, "device": str(dev)}
        if args.trace:
            with traced("custom LLM", {"prompt": args.prompt}, attributes) as (set_outputs, box):
                answer = generate(tok, model, dev, args.prompt, max_new=args.max_new)
                set_outputs({"answer": answer})
            trace_id = box["traceId"]
        else:
            answer, trace_id = generate(tok, model, dev, args.prompt, max_new=args.max_new), None
    except (DataError, OSError, ImportError) as e:
        if args.json:
            print(json.dumps({"event": "error", "message": str(e)}), flush=True)
        print(f"llm_chat: {e}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({"event": "answer", "answer": answer, "traceId": trace_id,
                          "experimentId": experiment_id, "seconds": round(time.time() - started, 1)},
                         ensure_ascii=True), flush=True)
    else:
        print(answer)
    return 0


if __name__ == "__main__":
    sys.exit(main())
