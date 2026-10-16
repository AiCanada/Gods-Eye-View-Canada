"""Training text for a custom LLM, from what God's Eye View recorded and what the owner adds.

    python -m ml.gevtape.llm_data --data .gev-data --out <folder> --sources news,prices,news-moves,links,readings,urls,local
                                  [--urls-dir .gev-data/llm/sources/urls] [--path <file or folder>] ...

Owner request 2026-10-16: "add Custom LLM to be trained under Power Up's on
Dashboard · Select data sources to train from · Add any custom URL to train
from · Add any local sources to train from". The sources:

  news        recorded headlines (the news and news-urls feeds), one document a day
  prices      each recorded asset's day: first, last, low, high, change
  news-moves  a day's headlines, then which assets moved most the next day
              (question and answer, from recorded prices; not advice)
  links       the measured layer-asset links (ml.gevtape.links) as questions and answers
  readings    a day of binned readings at the most populated tracked places
  urls        the text of the custom URLs the server saved (one .txt each)
  local       the owner's own files and folders on this machine: text, Markdown,
              CSV, JSON, JSON lines (a {"messages": [...]} or {"text": ...} line
              is kept as it is), HTML (its text), code

Military travel is never in the bins or the tape it reads. Every example
carries the licence class of its source (news nc, prices unclear, the
derived ones the class of what they came from, urls unclear, local
personal) and the dataset stays on this machine.

Writes <out>/train.jsonl, <out>/heldout.jsonl (one example in twenty, chosen
by a hash of its text so a rebuild keeps the split) and <out>/manifest.json
(counts by source, classes, bytes, the last recorded day).
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import html
import json
import re
import sys
from pathlib import Path

import numpy as np

from . import reader as R

SOURCES = ("news", "prices", "news-moves", "links", "readings", "urls", "local")
SOURCE_CLASS = {"news": "nc", "prices": "unclear", "news-moves": "nc", "links": "unclear",
                "readings": "unclear", "urls": "unclear", "local": "personal"}
TEXT_EXTENSIONS = frozenset({".txt", ".md", ".markdown", ".rst", ".csv", ".tsv", ".json", ".jsonl", ".ndjson",
                             ".html", ".htm", ".xml", ".log", ".py", ".js", ".mjs", ".ts", ".yaml", ".yml"})
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_LOCAL_BYTES = 200 * 1024 * 1024
MAX_LOCAL_FILES = 20_000
CHUNK_CHARS = 4000
READING_PLACES = 30
NOTE = "Recorded by God's Eye View; a readout, not advice."


def _chunks(text, size=CHUNK_CHARS):
    text = text.strip()
    while text:
        if len(text) <= size:
            yield text
            return
        cut = text.rfind("\n", 0, size)
        cut = cut if cut > size // 2 else size
        yield text[:cut].strip()
        text = text[cut:].strip()


def _day(ms):
    return _dt.datetime.fromtimestamp(ms / 1000, _dt.timezone.utc)


def _records(tape, feed):
    for day in R.list_tape_days(tape, feed):
        for rec in R.iter_tape(tape, feed, day):
            yield day, rec


# ---------------------------------------------------------------- recorded


def news_by_day(tape):
    out = {}
    for feed in ("news", "news-urls"):
        for day, rec in _records(tape, feed):
            title = str(rec.get("title") or rec.get("name") or "").strip()
            if not title:
                continue
            t = rec.get("published") or rec.get("t")
            hour = _day(t).strftime("%H:%M") if isinstance(t, (int, float)) else "--:--"
            place = str(rec.get("place") or rec.get("source") or "").strip()
            out.setdefault(day, []).append(f"{hour} · {place + ' · ' if place else ''}{title}")
    return {d: sorted(set(lines)) for d, lines in out.items()}


def prices_by_day(tape):
    """{day: {series: {label, unit, first, last, low, high}}} from the markets tape."""
    out = {}
    for day, rec in _records(tape, "markets"):
        series, value = rec.get("series"), rec.get("value")
        if not isinstance(series, str) or not isinstance(value, (int, float)):
            continue
        row = out.setdefault(day, {}).setdefault(series, {"label": rec.get("label") or series,
                                                           "unit": rec.get("unit") or "", "values": []})
        row["values"].append((rec.get("quotedAt") or rec.get("t") or 0, float(value)))
    for day in out.values():
        for row in day.values():
            vals = [v for _, v in sorted(row.pop("values"))]
            row.update(first=vals[0], last=vals[-1], low=min(vals), high=max(vals))
    return out


def _pct(a, b):
    return (b - a) / abs(a) * 100 if a else None


def news_docs(news):
    for day, lines in sorted(news.items()):
        yield {"text": f"News headlines on {day.isoformat()} ({NOTE})\n" + "\n".join(f"- {x}" for x in lines)}


def price_docs(prices):
    for day, rows in sorted(prices.items()):
        lines = []
        for row in rows.values():
            pct = _pct(row["first"], row["last"])
            move = f" ({pct:+.2f}%)" if pct is not None else ""
            lines.append(f"- {row['label']}: first {row['first']:g}, last {row['last']:g}{move}, "
                         f"low {row['low']:g}, high {row['high']:g} {row['unit']}".rstrip())
        yield {"text": f"Recorded prices on {day.isoformat()} ({NOTE})\n" + "\n".join(lines)}


def news_move_pairs(news, prices, top=5):
    for day, lines in sorted(news.items()):
        nxt = prices.get(day + _dt.timedelta(days=1))
        if not nxt or not lines:
            continue
        moves = sorted(((_pct(r["first"], r["last"]), r["label"]) for r in nxt.values()
                        if _pct(r["first"], r["last"]) is not None), key=lambda x: -abs(x[0]))[:top]
        if not moves:
            continue
        answer = "; ".join(f"{label} {'up' if p > 0 else 'down' if p < 0 else 'flat'} {abs(p):.2f}%"
                           for p, label in moves)
        yield {"messages": [
            {"role": "user", "content": f"Headlines on {day.isoformat()}:\n" + "\n".join(lines[:40]) +
             "\nWhich recorded assets moved most over the next day?"},
            {"role": "assistant", "content": f"On {(day + _dt.timedelta(days=1)).isoformat()} the recorded "
             f"prices moved: {answer}. These are recorded moves, not a forecast and not advice."},
        ]}


def link_pairs(report):
    by_asset = {}
    for row in (report or {}).get("results", []):
        if row.get("holds"):
            by_asset.setdefault(row.get("asset"), []).append(row)
    for asset, rows in sorted(by_asset.items()):
        parts = []
        for row in rows[:8]:
            lag = int(row.get("lagHours", 0))
            order = (f"{row['channel']} moves {lag} h before it" if lag > 0 else
                     f"it moves {-lag} h before {row['channel']}" if lag < 0 else f"{row['channel']} in the same hour")
            parts.append(f"{order} (r {float(row['r']):.2f}, {int(row.get('n', 0))} hours, held on later hours)")
        yield {"messages": [
            {"role": "user", "content": f"In the recorded data, what moves together with {asset}?"},
            {"role": "assistant", "content": "; ".join(parts) + ". A correlation is not a cause and not advice."},
        ]}


def reading_docs(data_root):
    worlds = R.list_bin_worlds(data_root)
    if not worlds:
        return
    bins_dir = worlds[-1]
    wdir = R.find_world(data_root, bins_dir.name)
    world = R.load_world(wdir) if wdir else None
    for day in R.list_bin_days(bins_dir):
        b = R.load_bins(bins_dir, day)
        arr, names = b.stacked([g for g in b.groups if g not in ("markets", "news-markets") and
                                not g.startswith("military")])
        if not names:
            continue
        K = arr.shape[1]
        if world is not None and world.K == K:
            pop = world.population[world.tracked]
            order = np.argsort(-pop)[:READING_PLACES]
            label = lambda k: world.names[world.tracked[k]]  # noqa: E731
        else:
            order = np.arange(min(K, READING_PLACES))
            label = lambda k: f"place {k}"  # noqa: E731
        lines = []
        with np.errstate(all="ignore"):
            means = np.nanmean(arr, axis=0) if arr.size else arr
        for k in order:
            vals = [(names[c], means[k, c]) for c in range(len(names)) if np.isfinite(means[k, c])]
            if vals:
                lines.append(f"- {label(int(k))}: " + ", ".join(f"{n} {v:.3g}" for n, v in vals[:24]))
        if lines:
            yield {"text": f"Hourly means recorded on {day.isoformat()} ({NOTE})\n" + "\n".join(lines)}


# ---------------------------------------------------------------- added


def url_docs(urls_dir):
    folder = Path(urls_dir) if urls_dir else None
    if not folder or not folder.is_dir():
        return
    for path in sorted(folder.glob("*.txt")):
        text = path.read_text(encoding="utf-8", errors="replace")
        head, _, body = text.partition("\n\n")
        for chunk in _chunks(body or text):
            yield {"text": f"{head.strip()}\n{chunk}" if body else chunk}


def html_text(raw):
    raw = re.sub(r"(?is)<(script|style|noscript)\b.*?</\1>", " ", raw)
    raw = re.sub(r"(?s)<[^>]+>", " ", raw)
    return re.sub(r"[ \t\r\f\v]+", " ", html.unescape(raw)).strip()


def local_files(paths):
    seen, total, count = set(), 0, 0
    for given in paths or []:
        root = Path(given).expanduser()
        files = [root] if root.is_file() else sorted(p for p in root.rglob("*") if p.is_file()) if root.is_dir() else []
        for path in files:
            # Hidden folders and files (.git, .ssh, .env …) are never training data.
            hidden = any(part.startswith(".") for part in path.relative_to(root).parts) if path != root else                 path.name.startswith(".")
            if path.suffix.lower() not in TEXT_EXTENSIONS or path in seen or hidden:
                continue
            seen.add(path)
            size = path.stat().st_size
            if size > MAX_FILE_BYTES or total + size > MAX_LOCAL_BYTES or count >= MAX_LOCAL_FILES:
                continue
            total += size
            count += 1
            yield path


def local_docs(paths):
    for path in local_files(paths):
        raw = path.read_text(encoding="utf-8", errors="replace")
        ext = path.suffix.lower()
        if ext in (".jsonl", ".ndjson"):
            for line in raw.splitlines():
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict) and (isinstance(obj.get("messages"), list) or isinstance(obj.get("text"), str)):
                    yield {k: obj[k] for k in ("messages", "text") if k in obj}
            continue
        text = html_text(raw) if ext in (".html", ".htm", ".xml") else raw
        for chunk in _chunks(text):
            yield {"text": f"{path.name}\n{chunk}"}


# ---------------------------------------------------------------- build


def _key(example):
    return hashlib.sha1(json.dumps(example, sort_keys=True).encode("utf-8")).hexdigest()


def build(data_root, out, sources, *, urls_dir=None, paths=()):
    root = Path(data_root)
    tape = R.gev_paths(root)["tape"]
    wanted = [s for s in sources if s in SOURCES]
    if not wanted:
        raise ValueError(f"no known source; choose from {', '.join(SOURCES)}")
    news = news_by_day(tape) if {"news", "news-moves"} & set(wanted) else {}
    prices = prices_by_day(tape) if {"prices", "news-moves"} & set(wanted) else {}
    makers = {
        "news": lambda: news_docs(news),
        "prices": lambda: price_docs(prices),
        "news-moves": lambda: news_move_pairs(news, prices),
        "links": lambda: link_pairs(_read(R.gev_paths(root)["models"] / "links" / "links.json")),
        "readings": lambda: reading_docs(root),
        "urls": lambda: url_docs(urls_dir),
        "local": lambda: local_docs(paths),
    }
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    counts, classes, seen = {}, set(), set()
    n_train = n_held = 0
    with open(out / "train.jsonl", "w", encoding="utf-8", newline="\n") as tr, \
            open(out / "heldout.jsonl", "w", encoding="utf-8", newline="\n") as ho:
        for source in wanted:
            n = 0
            for example in makers[source]():
                key = _key(example)
                if key in seen:
                    continue
                seen.add(key)
                example = {**example, "source": source, "class": SOURCE_CLASS[source]}
                line = json.dumps(example, ensure_ascii=False) + "\n"
                if int(key[:8], 16) % 20 == 0:
                    ho.write(line)
                    n_held += 1
                else:
                    tr.write(line)
                    n_train += 1
                n += 1
            counts[source] = n
            if n:
                classes.add(SOURCE_CLASS[source])
    days = sorted({d for feed in ("news", "markets") for d in R.list_tape_days(tape, feed)}) if tape.is_dir() else []
    manifest = {
        "sources": wanted, "counts": counts, "train": n_train, "heldout": n_held,
        "classes": sorted(classes), "bytes": (out / "train.jsonl").stat().st_size + (out / "heldout.jsonl").stat().st_size,
        "dataThrough": days[-1].isoformat() if days else None,
        "localPaths": [str(p) for p in paths or []], "urlsDir": str(urls_dir) if urls_dir else None,
        "generatedAt": int(_dt.datetime.now(_dt.timezone.utc).timestamp() * 1000),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def _read(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def main(argv=None) -> int:
    p = argparse.ArgumentParser(prog="python -m ml.gevtape.llm_data", description=__doc__.split("\n\n")[0])
    p.add_argument("--data", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--sources", default=",".join(SOURCES))
    p.add_argument("--urls-dir", default=None)
    p.add_argument("--path", action="append", default=[], help="a local file or folder (repeat)")
    args = p.parse_args(argv)
    try:
        manifest = build(args.data, args.out, [s.strip() for s in args.sources.split(",") if s.strip()],
                         urls_dir=args.urls_dir, paths=args.path)
    except ValueError as e:
        print(json.dumps({"event": "error", "message": str(e)}))
        return 1
    print(json.dumps({"event": "built", **{k: manifest[k] for k in ("train", "heldout", "counts", "classes")}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
