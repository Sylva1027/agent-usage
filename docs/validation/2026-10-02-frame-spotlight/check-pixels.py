"""Read-only pixel verification of opaque text over a lit frame."""
import json
from pathlib import Path
from PIL import Image

directory = Path(__file__).resolve().parent
results = []
for prefix in ("online", "offline"):
    before = Image.open(directory / f"{prefix}-text-before.png").convert("RGB")
    after = Image.open(directory / f"{prefix}-text-after.png").convert("RGB")
    assert before.size == after.size
    original = list(before.get_flattened_data())
    illuminated = list(after.get_flattened_data())
    core = [index for index, pixel in enumerate(original) if pixel == (255, 255, 255)]
    assert len(core) > 500, "fixture must have enough fully opaque foreground pixels"
    assert all(illuminated[index] == original[index] for index in core), "light overpainted text"
    changed = sum(a != b for a, b in zip(original, illuminated))
    assert changed > 500, "background must really light beneath the text"
    results.append({"prefix": prefix, "unchangedOpaqueTextPixels": len(core), "changedBackgroundAndAntialiasPixels": changed})
(directory / "pixel-results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
print(json.dumps(results))
