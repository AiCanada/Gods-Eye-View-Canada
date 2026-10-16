"""Train a custom LLM (LoRA) on the dataset ml.gevtape.llm_data built, and post-train it later.

    python -m ml.gevtape.llm_train --data-dir <dataset folder> --base .gev-data/llm/base/Qwen3.5-0.8B --out <model folder>
                                   [--from <an earlier model folder>] [--epochs 1] [--rank 8] [--alpha 16]
                                   [--lr 2e-4] [--max-len 512] [--batch-size 4] [--accumulate 4]
                                   [--device auto|cpu|cuda] [--resume]

Owner requests 2026-10-16: a custom LLM trained from the POWER UP dashboard,
and post-training "to keep the most up to date". The default base is
Qwen3.5-0.8B, with Qwen3.6-35B-A3B as the large option (owner rulings
2026-10-16). The base model must already be on this machine (a
model folder such as .gev-data/llm/base/Qwen3.6-35B-A3B, or a Hugging Face id
in the local cache): nothing is downloaded. Its weights stay frozen; small
low-rank adapters (LoRA) on the attention projections (the full-attention
q/k/v/o and the gated-delta linear-attention in_proj_qkv, in_proj_z and
out_proj) learn from the data. A base too big for the GPU (Qwen3.6-35B-A3B is
about 72 GB in bf16) is split: as many layers as fit go on the GPU and the
rest stay in RAM, with gradient checkpointing (`--placement auto`, the
default; `gpu`, `split` and `cpu` force one). `--from` post-trains: it starts
from an earlier model's adapters (same base) and trains them further on the
new dataset.

Before and after training the loss on heldout.jsonl is measured (did it
learn?). The model folder holds adapter.safetensors and adapter.json (base,
rank, targets, the data it saw and through which day, the losses, what it
was post-trained from). Same JSON-lines protocol as ml.gevtape.train
(progress / checkpoint / paused / done / error; {"cmd":"pause"} and
{"cmd":"stop"} save the adapters and the step, --resume continues).

`python -m ml.gevtape.llm_chat --model <model folder> --prompt "..."` asks it.
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sys
import traceback
from pathlib import Path

import torch
from torch import nn

from .train import Control, DataError, Emitter, atomic_json, now_ms, resolve_device

DEFAULT_TARGETS = ("q_proj", "k_proj", "v_proj", "o_proj", "in_proj_qkv", "in_proj_z", "out_proj")
DEFAULT_BASE = "Qwen/Qwen3.5-0.8B"  # the default; Qwen/Qwen3.6-35B-A3B is the large option
GIB = 1024 ** 3
ADAPTER_FILE = "adapter.safetensors"
ADAPTER_META = "adapter.json"
STATE_FILE = "train-state.json"


class LoRALinear(nn.Module):
    """y = W x + (alpha / r) B A x, with W frozen and B starting at zero."""

    def __init__(self, base: nn.Linear, rank: int, alpha: float):
        super().__init__()
        self.base = base
        for p in self.base.parameters():
            p.requires_grad_(False)
        self.rank, self.scale = int(rank), float(alpha) / float(rank)
        self.lora_a = nn.Parameter(torch.empty(rank, base.in_features, device=base.weight.device,
                                               dtype=torch.float32))
        self.lora_b = nn.Parameter(torch.zeros(base.out_features, rank, device=base.weight.device,
                                               dtype=torch.float32))
        nn.init.kaiming_uniform_(self.lora_a, a=math.sqrt(5))

    def forward(self, x):
        out = self.base(x)
        delta = (x.to(self.lora_a.dtype) @ self.lora_a.t()) @ self.lora_b.t()
        return out + (delta * self.scale).to(out.dtype)


def add_lora(model, rank=8, alpha=16, targets=DEFAULT_TARGETS):
    """Wrap the named linear layers; returns the wrapped module names."""
    names = []
    for name, module in list(model.named_modules()):
        for child_name, child in list(module.named_children()):
            if isinstance(child, nn.Linear) and child_name in targets:
                setattr(module, child_name, LoRALinear(child, rank, alpha))
                names.append(f"{name}.{child_name}" if name else child_name)
    if not names:
        raise DataError(f"the base model has no linear layer named {', '.join(targets)}")
    for p in model.parameters():
        p.requires_grad_(False)
    for module in model.modules():
        if isinstance(module, LoRALinear):
            module.lora_a.requires_grad_(True)
            module.lora_b.requires_grad_(True)
    return names


def lora_state(model):
    return {f"{name}.{part}": getattr(module, part).detach().cpu().contiguous()
            for name, module in model.named_modules() if isinstance(module, LoRALinear)
            for part in ("lora_a", "lora_b")}


def load_lora_state(model, state):
    own = dict(model.named_modules())
    loaded = 0
    for key, value in state.items():
        name, part = key.rsplit(".", 1)
        module = own.get(name)
        if isinstance(module, LoRALinear) and getattr(module, part).shape == value.shape:
            getattr(module, part).data.copy_(value.to(getattr(module, part).device))
            loaded += 1
    return loaded


def save_adapter(folder, model, meta):
    from safetensors.torch import save_file

    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / f"{ADAPTER_FILE}.tmp"
    save_file(lora_state(model), str(tmp))
    tmp.replace(folder / ADAPTER_FILE)
    atomic_json(folder / ADAPTER_META, meta)


def read_adapter(folder):
    from safetensors.torch import load_file

    folder = Path(folder)
    meta = json.loads((folder / ADAPTER_META).read_text(encoding="utf-8"))
    return meta, load_file(str(folder / ADAPTER_FILE))


def weight_bytes(base):
    """The base model's weights on disk (a folder's or the cached snapshot's *.safetensors), or 0."""
    folder = Path(base)
    if not folder.is_dir():
        try:
            from huggingface_hub import snapshot_download

            folder = Path(snapshot_download(base, local_files_only=True))
        except Exception:
            return 0
    return sum(p.stat().st_size for p in folder.glob("*.safetensors"))


def choose_placement(weights, gpu_free, ram_total, wanted="auto"):
    """Where the frozen base goes: 'gpu', 'split' (GPU and RAM) or 'cpu'.

    On the GPU when the weights take at most 70 % of its free memory (the rest
    is activations); split when a GPU is there but too small; the CPU when
    there is no GPU. A model that fits neither the GPU and RAM together is
    refused rather than left to swap.
    """
    if weights and weights > gpu_free + max(0, ram_total - 12 * GIB):
        raise DataError(f"the base model ({weights / GIB:.0f} GiB) does not fit this machine's GPU and RAM together")
    if wanted in ("gpu", "split", "cpu"):
        return wanted if (wanted != "gpu" and wanted != "split") or gpu_free else "cpu"
    if not gpu_free:
        return "cpu"
    return "gpu" if weights and weights <= 0.7 * gpu_free else "split"


def _ram_total():
    try:
        import psutil

        return int(psutil.virtual_memory().total)
    except Exception:
        try:
            import ctypes

            class Status(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                            ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                            ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                            ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                            ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

            status = Status()
            status.dwLength = ctypes.sizeof(Status)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
            return int(status.ullTotalPhys)
        except Exception:
            return 16 * GIB


def load_base(base, device, *, loader=None, placement="auto", emit=None):
    """The tokenizer and the model, from this machine only (no download).

    Returns (tokenizer, model). `model.gev_input_device` is where token ids go
    (the embedding's device: the GPU, or the CPU when split puts it there).
    """
    if loader is not None:
        tok, model = loader(base, device)
        model.gev_input_device = device
        return tok, model
    from transformers import AutoModelForCausalLM, AutoTokenizer

    gpu_free = torch.cuda.mem_get_info()[0] if device.type == "cuda" else 0
    where = choose_placement(weight_bytes(base), gpu_free, _ram_total(), placement)
    bf16 = (where != "gpu") or (device.type == "cuda" and torch.cuda.is_bf16_supported())
    dtype = torch.bfloat16 if bf16 else torch.float32
    kwargs = {"local_files_only": True, "dtype": dtype}
    if where == "split":
        kwargs["device_map"] = "auto"
        kwargs["max_memory"] = {0: max(1, int(gpu_free / GIB - 1.5)) * GIB, "cpu": max(8, int(_ram_total() / GIB - 12)) * GIB}
    try:
        tok = AutoTokenizer.from_pretrained(base, local_files_only=True)
        model = AutoModelForCausalLM.from_pretrained(base, **kwargs)
    except OSError as e:
        raise DataError(f"BASE MODEL NOT ON THIS MACHINE: {base} (put it in .gev-data/llm/base/ or the Hugging "
                        f"Face cache first; nothing is downloaded here): {e}") from None
    if tok.pad_token_id is None:
        tok.pad_token = tok.eos_token
    if where == "gpu":
        model = model.to(device)
    elif where == "cpu":
        model = model.to("cpu")
    if where != "gpu":
        # The big case: recompute activations in the backward pass instead of keeping them.
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        model.config.use_cache = False
    model.gev_input_device = model.get_input_embeddings().weight.device
    if emit:
        emit("progress", model="llm", placement=where, gpuFreeGiB=round(gpu_free / GIB, 1),
             weightsGiB=round(weight_bytes(base) / GIB, 1))
    return tok, model


def example_text(example, tok):
    if isinstance(example.get("messages"), list):
        msgs = [m for m in example["messages"] if isinstance(m, dict) and isinstance(m.get("content"), str)]
        if getattr(tok, "chat_template", None):
            try:
                return tok.apply_chat_template(msgs, tokenize=False)
            except Exception:
                pass
        return "\n".join(f"{m.get('role', 'user').title()}: {m['content']}" for m in msgs)
    return str(example.get("text") or "")


def read_jsonl(path, limit=None):
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict):
                    out.append(obj)
                if limit and len(out) >= limit:
                    break
    except OSError:
        pass
    return out


def encode(examples, tok, max_len):
    rows = []
    for ex in examples:
        text = example_text(ex, tok)
        if not text.strip():
            continue
        ids = tok(text, truncation=True, max_length=max_len)["input_ids"]
        if len(ids) >= 2:
            rows.append(ids)
    return rows


def batch_tensors(rows, pad_id, device):
    width = max(len(r) for r in rows)
    ids = torch.full((len(rows), width), pad_id, dtype=torch.long)
    att = torch.zeros((len(rows), width), dtype=torch.long)
    for i, r in enumerate(rows):
        ids[i, : len(r)] = torch.tensor(r)
        att[i, : len(r)] = 1
    labels = ids.masked_fill(att == 0, -100)
    return ids.to(device), att.to(device), labels.to(device)


def mean_loss(model, rows, pad_id, device, batch_size):
    if not rows:
        return None
    model.eval()
    total, n = 0.0, 0
    with torch.no_grad():
        for i in range(0, len(rows), batch_size):
            ids, att, labels = batch_tensors(rows[i: i + batch_size], pad_id, device)
            loss = model(input_ids=ids, attention_mask=att, labels=labels).loss
            if torch.isfinite(loss):
                total += float(loss)
                n += 1
    return total / n if n else None


def run(args, emit, control, *, loader=None) -> int:
    data_dir, out = Path(args.data_dir), Path(args.out)
    manifest = json.loads((data_dir / "manifest.json").read_text(encoding="utf-8")) \
        if (data_dir / "manifest.json").is_file() else {}
    train_ex = read_jsonl(data_dir / "train.jsonl")
    held_ex = read_jsonl(data_dir / "heldout.jsonl", limit=args.eval_examples)
    if not train_ex:
        raise DataError(f"no training examples in {data_dir / 'train.jsonl'}: build the data first")
    device = resolve_device(args.device)
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    state = json.loads((out / STATE_FILE).read_text()) if args.resume and (out / STATE_FILE).is_file() else {}
    previous = None
    if state.get("saved") and (out / ADAPTER_FILE).is_file():
        previous = out
    elif args.from_model:
        previous = Path(args.from_model)
    prior_meta, prior_state = read_adapter(previous) if previous else ({}, None)
    base = prior_meta.get("base") or args.base
    if prior_meta and args.base and prior_meta.get("base") != args.base and previous != out:
        raise DataError(f"{previous} was trained on {prior_meta.get('base')}, not {args.base}")
    rank = int(prior_meta.get("rank") or args.rank)
    alpha = float(prior_meta.get("alpha") or args.alpha)
    targets = tuple(prior_meta.get("targets") or args.targets.split(","))
    tok, model = load_base(base, device, loader=loader, placement=args.placement, emit=emit)
    device = getattr(model, "gev_input_device", device)
    wrapped = add_lora(model, rank, alpha, targets)
    if prior_state is not None:
        load_lora_state(model, prior_state)
    pad_id = tok.pad_token_id if tok.pad_token_id is not None else 0
    train_rows = encode(train_ex, tok, args.max_len)
    held_rows = encode(held_ex, tok, args.max_len)
    before = state.get("heldOutLossBefore")
    if before is None:
        before = mean_loss(model, held_rows, pad_id, device, args.batch_size)
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=args.lr, weight_decay=0.0)
    start_epoch, skip = int(state.get("epoch", 0)), int(state.get("step", 0))
    emit("progress", model="llm", epoch=start_epoch, epochs=args.epochs, examples=len(train_rows))
    meta = {
        "format": "gev-lora/1", "base": base, "rank": rank, "alpha": alpha, "targets": list(targets),
        "wrapped": len(wrapped), "dataDir": str(data_dir), "data": manifest,
        "dataThrough": manifest.get("dataThrough"), "classes": manifest.get("classes", []),
        "postTrainedFrom": prior_meta.get("name") or (str(previous) if previous and previous != out else
                                                      state.get("postTrainedFrom")),
        "createdAt": prior_meta.get("createdAt") if previous == out else (state.get("createdAt") or now_ms()),
        "name": out.name,
    }

    def save(epoch, step, extra=None):
        save_adapter(out, model, {**meta, "updatedAt": now_ms(), **(extra or {})})
        atomic_json(out / STATE_FILE, {"epoch": epoch, "step": step, "saved": True, "heldOutLossBefore": before,
                                       "createdAt": meta["createdAt"], "postTrainedFrom": meta["postTrainedFrom"]})

    loss_value = None
    for epoch in range(start_epoch, args.epochs):
        order = list(range(len(train_rows)))
        random.Random(args.seed + epoch).shuffle(order)
        model.train()
        steps = list(range(0, len(order), args.batch_size))
        opt.zero_grad(set_to_none=True)
        for n, i in enumerate(steps):
            if epoch == start_epoch and n < skip:
                continue
            ids, att, labels = batch_tensors([train_rows[j] for j in order[i: i + args.batch_size]], pad_id, device)
            loss = model(input_ids=ids, attention_mask=att, labels=labels).loss / args.accumulate
            loss.backward()
            loss_value = float(loss.detach()) * args.accumulate
            if (n + 1) % args.accumulate == 0 or n + 1 == len(steps):
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                opt.step()
                opt.zero_grad(set_to_none=True)
            if n % max(1, len(steps) // 20) == 0:
                emit("progress", model="llm", epoch=epoch, epochs=args.epochs, step=n + 1, steps=len(steps),
                     loss=loss_value)
            wanted = control.requested()
            if wanted:
                save(epoch, n + 1)
                emit("checkpoint", model="llm", epoch=epoch, step=n + 1)
                emit("paused" if wanted == "pause" else "done", model="llm")
                return 0
        save(epoch + 1, 0)
        emit("progress", model="llm", epoch=epoch + 1, epochs=args.epochs, loss=loss_value)
    after = mean_loss(model, held_rows, pad_id, device, args.batch_size)
    result = {"heldOutLossBefore": before, "heldOutLossAfter": after,
              "helped": before is not None and after is not None and after < before,
              "trainLoss": loss_value, "examples": len(train_rows), "heldOut": len(held_rows)}
    save(args.epochs, 0, result)
    emit("llm", model="llm", **result)
    emit("done", model="llm")
    return 0


def build_parser():
    p = argparse.ArgumentParser(prog="python -m ml.gevtape.llm_train", description=__doc__.split("\n\n")[0])
    p.add_argument("--data-dir", required=True)
    p.add_argument("--base", default=DEFAULT_BASE, help="a model folder, or a model id in the local cache")
    p.add_argument("--placement", default="auto", choices=("auto", "gpu", "split", "cpu"),
                   help="where the frozen base goes (auto: the GPU if it fits, else GPU and RAM)")
    p.add_argument("--out", required=True)
    p.add_argument("--from", dest="from_model", default=None, help="post-train an earlier model folder")
    p.add_argument("--epochs", type=int, default=1)
    p.add_argument("--rank", type=int, default=8)
    p.add_argument("--alpha", type=float, default=16.0)
    p.add_argument("--targets", default=",".join(DEFAULT_TARGETS))
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--max-len", type=int, default=512)
    p.add_argument("--batch-size", type=int, default=4)
    p.add_argument("--accumulate", type=int, default=4)
    p.add_argument("--eval-examples", type=int, default=200)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--device", default="auto")
    p.add_argument("--resume", action="store_true")
    return p


def main(argv=None) -> int:
    emit = Emitter(sys.stdout)
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as e:
        return int(e.code or 0)
    control = Control()
    try:
        control.listen(sys.stdin.fileno())
    except (AttributeError, OSError, ValueError):
        pass
    try:
        return run(args, emit, control)
    except DataError as e:
        emit("error", message=str(e))
        return 1
    except Exception as e:
        traceback.print_exc(file=sys.stderr)
        emit("error", message=f"{type(e).__name__}: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
