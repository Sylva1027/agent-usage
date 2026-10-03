"""Measure ink bounding boxes for all 40 skin source images.

P3.1 needs one display parameter set per image so characters of different canvas
sizes and padding render at a consistent visual size. This script derives the raw
measurements; it does not invent any styling.

Usage:
    python docs/validation/2026-10-02-model-character-skins/measure-ink-bounds.py
"""

from __future__ import annotations

import json
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[3]
SOURCE_DIR = ROOT / "lineart assets"
OUT = pathlib.Path(__file__).resolve().parent / "ink-bounds.json"

# Alpha above this counts as ink. The art is transparent line work, so anything
# this opaque is a drawn pixel rather than anti-aliasing fringe.
INK_ALPHA = 32


def measure(path: pathlib.Path) -> dict:
    with Image.open(path) as image:
        image = image.convert("RGBA")
        width, height = image.size
        alpha = image.getchannel("A")
        # getbbox() on the alpha channel gives the tight ink box in one pass.
        box = alpha.point(lambda value: 255 if value >= INK_ALPHA else 0).getbbox()
    if box is None:
        return {"file": path.name, "width": width, "height": height, "empty": True}
    left, top, right, bottom = box
    return {
        "file": path.name,
        "width": width,
        "height": height,
        "empty": False,
        "ink": {"left": left, "top": top, "right": right, "bottom": bottom},
        "inkWidth": right - left,
        "inkHeight": bottom - top,
        # Fractions, so a renderer can anchor by proportion rather than pixels.
        "inkLeftFraction": round(left / width, 6),
        "inkTopFraction": round(top / height, 6),
        "inkWidthFraction": round((right - left) / width, 6),
        "inkHeightFraction": round((bottom - top) / height, 6),
        # Horizontal centre of the ink, as a fraction of canvas width.
        "inkCenterXFraction": round((left + right) / 2 / width, 6),
    }


def main() -> int:
    if not SOURCE_DIR.is_dir():
        print(f"missing source directory: {SOURCE_DIR}", file=sys.stderr)
        return 1

    # Sources live under light/ and dark/ subdirectories.
    files = sorted(SOURCE_DIR.rglob("*.png"))
    if len(files) != 40:
        print(f"expected 40 source images, found {len(files)}", file=sys.stderr)

    records = []
    for path in files:
        record = measure(path)
        # Record which mode directory the file came from, so the output is
        # self-describing rather than relying on the file name alone.
        record["mode"] = path.parent.name
        records.append(record)
    records.sort(key=lambda item: (item["mode"], item["file"]))
    OUT.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"{len(records)} images measured -> {OUT.relative_to(ROOT)}")
    print()
    print(f"{'mode/file':46} {'canvas':>11}  {'ink w x h':>11}  {'ink w frac':>10}  {'ink h frac':>10}")
    for record in records:
        if record.get("empty"):
            print(f"{record['file']:46} {'empty':>11}")
            continue
        canvas = f"{record['width']}x{record['height']}"
        ink = f"{record['inkWidth']}x{record['inkHeight']}"
        label = f"{record['mode']}/{record['file']}"
        print(
            f"{label:46} {canvas:>11}  {ink:>11}  "
            f"{record['inkWidthFraction']:>10.4f}  {record['inkHeightFraction']:>10.4f}"
        )

    # Report the spread, which is what the per-image parameters must normalise.
    widths = [r["inkWidthFraction"] for r in records if not r.get("empty")]
    heights = [r["inkHeightFraction"] for r in records if not r.get("empty")]
    if widths and heights:
        print()
        print(f"ink width fraction  range: {min(widths):.4f} .. {max(widths):.4f}")
        print(f"ink height fraction range: {min(heights):.4f} .. {max(heights):.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
