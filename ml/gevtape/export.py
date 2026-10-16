"""A self-contained training set from the recorded bins, for training a new world model elsewhere.

    python -m ml.gevtape.export --data .gev-data --out D:/world-set [--classes open] [--days 2026-10-01:2026-10-14]

Owner request 2026-10-15: the tab is also for "someone looking to train or RL
NEW world model from data layers and interactions between data layers and
assets". This writes everything such a person needs into one folder, readable
with numpy alone:

  bins/YYYY/MM/DD.<group>.npy   float32 [24, K, channels]: one hour per row,
                                one tracked place per column, NaN = not
                                observed (never a made-up 0)
  bins/YYYY/MM/DD.classes.json  the licence classes each group was built from
  channels.json                 {group: [channel names]}
  places.json                   the K tracked places: name, lat, lon,
                                population, country, UTC offset
  assets.json                   every financial asset: label, group, unit,
                                quote symbol, the place its benchmark is set
  links.json                    the study pairs (src/trainingLinks.mjs)
  links-measured.json           the measured layer-asset interactions
                                (ml.gevtape.links), when there is a report
  manifest.json                 files, sizes, sha256, licence mix, days
  DATASET.md                    this card: shapes, channels, classes, terms

Licence classes (docs/WORLD-MODEL-DATA.md): open, nc, restricted, unclear,
personal. `--classes` keeps only the groups of a day whose classes are all
allowed; `--classes open` is the only choice fit to share outside this
machine, and the owner decides each release. Military travel is never in the
bins. Nothing is uploaded anywhere.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import shutil
import sys
from pathlib import Path

from . import reader as R

ALL_CLASSES = ("open", "nc", "restricted", "unclear", "personal")


class ExportError(RuntimeError):
    """Nothing to export, or a bad option."""


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _write_json(path: Path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False), encoding="utf-8")


def parse_days(text):
    """'2026-10-01:2026-10-14' -> (first, last) dates; None or '' -> (None, None)."""
    if not text:
        return None, None
    a, sep, b = str(text).partition(":")
    try:
        first = _dt.date.fromisoformat(a) if a else None
        # One day alone, or an open end after the colon.
        last = _dt.date.fromisoformat(b) if b else (None if sep else first)
    except ValueError:
        raise ExportError("--days is FIRST:LAST as YYYY-MM-DD") from None
    return first, last


def places_of(world):
    out = []
    for k, node in enumerate(world.tracked.tolist()):
        row = world.nodes[node]
        country = world.countries[world.country_of_node[node]] if world.countries else ""
        out.append({"k": k, "name": world.names[node] if node < len(world.names) else "",
                    "lat": float(row[0]), "lon": float(row[1]), "population": float(row[2]),
                    "country": country or None,
                    "utcOffset": float(row[6]) if row[6] == row[6] else None})
    return out


def export(data_root, out, *, classes=ALL_CLASSES, first=None, last=None, world_id=None):
    """Write the training set; returns the manifest."""
    allowed = {c.strip().lower() for c in classes if c and c.strip()}
    bad = allowed - set(ALL_CLASSES)
    if bad or not allowed:
        raise ExportError(f"--classes takes {', '.join(ALL_CLASSES)}")
    root = Path(data_root)
    worlds = R.list_bin_worlds(root)
    bins_dir = next((w for w in worlds if w.name == world_id), None) if world_id else (worlds[-1] if worlds else None)
    if bins_dir is None:
        raise ExportError(f"no bins under {root / 'bins'}: record and bin a day first")
    out = Path(out)
    if out.exists() and any(out.iterdir()):
        raise ExportError(f"{out} is not empty: export into a new folder")
    days = [d for d in R.list_bin_days(bins_dir)
            if (first is None or d >= first) and (last is None or d <= last)]
    if not days:
        raise ExportError("no binned day in that range")
    files, kept_days, mix, left_out = [], [], set(), []
    for d in days:
        y, m, dd = R.day_parts(d)
        src = bins_dir / y / m
        day_classes = _read_json(src / f"{dd}.classes.json") or {}
        kept = {}
        for f in sorted(src.glob(f"{dd}.*.npy")):
            group = f.name[len(dd) + 1: -len(".npy")]
            if group == "military" or group.startswith("military-"):
                continue
            seen = [str(c).lower() for c in day_classes.get(group, [])] or ["unclear"]
            if not set(seen) <= allowed:
                left_out.append({"day": d.isoformat(), "group": group, "classes": sorted(set(seen))})
                continue
            dest = out / "bins" / y / m / f.name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(f, dest)
            files.append(dest)
            kept[group] = sorted(set(seen))
            mix.update(seen)
        if kept:
            _write_json(out / "bins" / y / m / f"{dd}.classes.json", kept)
            files.append(out / "bins" / y / m / f"{dd}.classes.json")
            kept_days.append(d.isoformat())
    if not kept_days:
        raise ExportError(f"every group of those days has a class outside {sorted(allowed)}")
    channels, _ = R.load_bin_channels(bins_dir)
    _write_json(out / "channels.json", {g: list(c) for g, c in channels.items()
                                        if g != "military" and not g.startswith("military-")})
    files.append(out / "channels.json")
    for name, dest in (("assets.json", "assets.json"), ("links.json", "links.json")):
        if (bins_dir / name).is_file():
            shutil.copyfile(bins_dir / name, out / dest)
            files.append(out / dest)
    measured = R.gev_paths(root)["models"] / "links" / "links.json"
    if measured.is_file():
        shutil.copyfile(measured, out / "links-measured.json")
        files.append(out / "links-measured.json")
    wdir = R.find_world(root, bins_dir.name)
    places = places_of(R.load_world(wdir)) if wdir else None
    if places is not None:
        _write_json(out / "places.json", places)
        files.append(out / "places.json")
    manifest = {
        "format": "gev-world-set/1",
        "worldId": bins_dir.name,
        "createdAt": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
        "days": kept_days,
        "allowedClasses": sorted(allowed),
        "licenceClasses": sorted(mix),
        "publishable": sorted(mix) == ["open"],
        "leftOut": left_out,
        "places": len(places) if places is not None else None,
        "files": [{"path": p.relative_to(out).as_posix(), "bytes": p.stat().st_size, "sha256": _sha256(p)}
                  for p in sorted(set(files))],
    }
    _write_json(out / "manifest.json", manifest)
    (out / "DATASET.md").write_text(card(manifest, channels), encoding="utf-8")
    return manifest


def card(manifest, channels):
    groups = "\n".join(f"| `{g}` | {len(c)} | {', '.join(f'`{x}`' for x in c)} |"
                       for g, c in channels.items() if g != "military" and not g.startswith("military-"))
    share = ("Every group is class `open`: fit to share, when the owner says so for that release."
             if manifest["publishable"] else
             "Holds classes other than `open` (" + ", ".join(manifest["licenceClasses"]) +
             "): for local training only. Export again with `--classes open` for a shareable set.")
    return f"""---
format: {manifest['format']}
world: {manifest['worldId']}
days: {len(manifest['days'])} ({manifest['days'][0]} to {manifest['days'][-1]})
places: {manifest['places']}
licence_classes: [{', '.join(manifest['licenceClasses'])}]
---

# World training set ({manifest['worldId']})

Hourly recordings of the data layers, news, supply and financial assets, on a
fixed set of tracked places, made by the Artificial Intelligence World
Training Sim. Use it to train or reinforcement-learn a new world model.

## Shapes

`bins/YYYY/MM/DD.<group>.npy` is float32 `[24, K, channels]`: hour of the UTC
day, tracked place (`places.json` row `k`), channel (`channels.json`). NaN
means not observed (a feed off, paused or quiet), never zero. Prices
(`markets.*`) are the same number at every place; `assets.json` says where
each benchmark is set. Military travel is never recorded.

| group | channels | names |
| --- | --- | --- |
{groups}

## Licence

{share}

Classes: open (shareable with attribution), nc (non-commercial), restricted
(the source's terms limit storage or training), unclear (no terms found),
personal (the owner's own devices). `manifest.json` lists the groups left out
by the class filter.

## Reading it

```python
import numpy as np, json
channels = json.load(open("channels.json"))
day = np.load("bins/2026/10/14.markets.npy")      # [24, K, assets]
```

With this repository's kit: `ml.gevtape.torch_data.load_bin_series(<folder>/bins)`
for one hourly series, `ml.gevtape.world_env.WorldMarketEnv(series=...)` for
reinforcement learning with asset positions as actions, and
`ml.gevtape.links` for measured layer-asset interactions. A correlation is not
a cause; nothing here is advice.
"""


def build_parser():
    p = argparse.ArgumentParser(prog="python -m ml.gevtape.export", description=__doc__.split("\n\n")[0])
    p.add_argument("--data", required=True, help="the .gev-data root")
    p.add_argument("--out", required=True, help="a new, empty folder")
    p.add_argument("--classes", default=",".join(ALL_CLASSES),
                   help="licence classes to keep, comma separated (default all; 'open' to share)")
    p.add_argument("--days", default="", help="FIRST:LAST, YYYY-MM-DD (default every binned day)")
    p.add_argument("--world", default=None, help="a world id (default the newest binned world)")
    return p


def main(argv=None) -> int:
    try:
        args = build_parser().parse_args(argv)
    except SystemExit as e:
        return int(e.code or 0)
    try:
        first, last = parse_days(args.days)
        manifest = export(args.data, args.out, classes=args.classes.split(","), first=first, last=last,
                          world_id=args.world)
    except ExportError as e:
        print(f"export: {e}", file=sys.stderr)
        return 1
    print(json.dumps({"out": str(args.out), "days": len(manifest["days"]), "files": len(manifest["files"]),
                      "licenceClasses": manifest["licenceClasses"], "publishable": manifest["publishable"]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
