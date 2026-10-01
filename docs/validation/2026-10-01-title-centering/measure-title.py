"""Analyze untouched screenshot pairs; no image is edited or exported."""
import json
import sys
from pathlib import Path
from PIL import Image, ImageChops

output = Path(__file__).parent
live = "--live" in sys.argv
rows = json.loads((output / ("capture-live-final.json" if live else "capture-final.json")).read_text(encoding="utf-8"))
for row in rows:
    visible = Image.open(output / (row["prefix"] + "-visible.png")).convert("RGB")
    hidden = Image.open(output / (row["prefix"] + "-hidden.png")).convert("RGB")
    diff = ImageChops.difference(visible, hidden)
    bounds = diff.getbbox()
    assert bounds, row["prefix"]
    # The opening capital A defines the cap face without g descenders.
    # Restrict x to its interior, retaining top/bottom anti-aliased paint.
    capital_width = 23 if row["width"] > 720 else 19
    xs = range(bounds[0], bounds[0] + capital_width)
    ys = [y for y in range(visible.height) if any(max(diff.getpixel((x, y))) > 3 for x in xs)]
    top = min(ys)
    bottom = max(ys) + 1
    offset = (top + bottom - visible.height) / 2
    row.update({"paintBounds": bounds, "capitalTopGap": top, "capitalBottomGap": visible.height - bottom, "capitalCenterOffset": offset})
    row["passed"] = (
        abs(offset) <= 1.5
        and row["compatMode"] == "CSS1Compat"
        and row["transform"] == "none"
        and row["trim"] == "trim-both"
        and row["header"]["height"] <= 76
        and row["actions"]["right"] <= row["header"]["right"]
    )
    print(row["prefix"], "top/bottom", top, visible.height - bottom, "offset", offset, "PASS" if row["passed"] else "FAIL")
passed = all(row["passed"] for row in rows)
result = {"passed": passed, "checks": len(rows), "maxAbsoluteCapitalOffset": max(abs(row["capitalCenterOffset"]) for row in rows), "rows": rows}
(output / ("pixels-live-final.json" if live else "pixels-final.json")).write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
if not passed:
    sys.exit(1)
