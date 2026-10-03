"""P0.3 source-image manifest for the model character skin work.

Reads only `lineart assets/light` and `lineart assets/dark` (never modifies,
moves or renames them) and records, per file: byte size, SHA-256, PNG header,
actual alpha distribution, ink luminance and the non-transparent bounding box.

It additionally cross-checks each light/dark pair for the same character and
view, because "the file names were checked" is not image-content acceptance:
identical alpha masks or an inverted ink polarity between the two modes are
facts the plan requires to be recorded rather than assumed.

Finally it renders two labelled contact sheets so the front/side view of every
file can be verified by eye.

Requires Pillow and numpy from the bundled Python runtime.

Outputs (relative to this file):
  baseline/source-images.json
  baseline/contact-sheet-light.png
  baseline/contact-sheet-dark.png
"""

import hashlib
import json
import struct
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BASELINE = HERE / "baseline"

# Registry order from the implementation plan section 3.1.
CHARACTERS = [
    "ChatGPT",
    "Claude",
    "GLM",
    "Gemini",
    "DeepSeek",
    "Kimi",
    "Qwen",
    "Grok",
    "Muse",
    "Mimo",
]

VIEWS = {
    "front": {"light": "{n}-lineart.png", "dark": "{n}-dark-lineart.png"},
    "side": {"light": "{n}-side-lineart.png", "dark": "{n}-side-dark-lineart.png"},
}

CELL_W, CELL_H, LABEL_H = 206, 360, 18
LUMA = np.array([0.2126, 0.7152, 0.0722])


def source_path(mode: str, character: str, view: str) -> Path:
    return ROOT / "lineart assets" / mode / VIEWS[view][mode].format(n=character)


def png_header(data: bytes) -> dict:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        return {"error": "not a PNG signature"}
    length, chunk_type = struct.unpack(">I4s", data[8:16])
    if chunk_type != b"IHDR":
        return {"error": f"first chunk is {chunk_type!r}, not IHDR"}
    # IHDR payload is 13 bytes: width(4) height(4) depth(1) colorType(1) compression(1) filter(1) interlace(1)
    width, height, depth, color_type, compression, filter_method, interlace = struct.unpack(">IIBBBBB", data[16:29])
    color_types = {
        0: "grayscale",
        2: "truecolor",
        3: "indexed",
        4: "grayscale+alpha",
        6: "truecolor+alpha",
    }
    return {
        "width": width,
        "height": height,
        "bitDepth": depth,
        "colorType": color_type,
        "colorTypeName": color_types.get(color_type, f"unknown({color_type})"),
        "interlace": interlace,
        "ihdrLength": length,
        "compression": compression,
        "filterMethod": filter_method,
    }


def ink_luminance(rgba: np.ndarray) -> dict:
    """Luminance of non-transparent pixels: separates dark ink from light ink."""
    alpha = rgba[..., 3]
    mask = alpha > 0
    count = int(mask.sum())
    if count == 0:
        return {"count": 0}
    luminance = (rgba[..., :3].astype(np.float64) @ LUMA)[mask]
    values = np.sort(luminance)
    return {
        "count": count,
        "min": round(float(values[0]), 2),
        "p05": round(float(values[int(count * 0.05)]), 2),
        "median": round(float(values[count // 2]), 2),
        "p95": round(float(values[min(count - 1, int(count * 0.95))]), 2),
        "max": round(float(values[-1]), 2),
        "mean": round(float(values.mean()), 2),
    }


def analyse(path: Path) -> dict:
    data = path.read_bytes()
    record = {
        "relativePath": path.relative_to(ROOT).as_posix(),
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "header": png_header(data),
    }
    with Image.open(path) as image:
        image.load()
        rgba = np.asarray(image.convert("RGBA"))
        bands = image.getbands()
        record["pillowMode"] = image.mode
        record["pillowSize"] = list(image.size)
        record["bands"] = list(bands)
        record["hasAlphaChannel"] = "A" in bands

        alpha = rgba[..., 3]
        total = int(alpha.size)
        histogram = np.bincount(alpha.reshape(-1), minlength=256)
        transparent = int(histogram[0])
        opaque = int(histogram[255])
        partial = total - transparent - opaque
        record["alpha"] = {
            "totalPixels": total,
            "fullyTransparentPixels": transparent,
            "partiallyTransparentPixels": partial,
            "fullyOpaquePixels": opaque,
            "transparentFraction": round(transparent / total, 6),
            "partialFraction": round(partial / total, 6),
            "opaqueFraction": round(opaque / total, 6),
            "isActuallyTransparent": transparent > 0,
        }
        mask = alpha > 0
        if mask.any():
            ys, xs = np.nonzero(mask)
            record["alpha"]["boundingBoxOfInk"] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
        else:
            record["alpha"]["boundingBoxOfInk"] = None
        record["alphaSha256"] = hashlib.sha256(alpha.tobytes()).hexdigest()
        record["rgbSha256"] = hashlib.sha256(rgba[..., :3].tobytes()).hexdigest()
        record["ink"] = ink_luminance(rgba)
    return record


def compare_modes(character: str, view: str) -> dict:
    """Cross-check the light and dark file of one character/view pair."""
    light_path = source_path("light", character, view)
    dark_path = source_path("dark", character, view)
    if not light_path.exists() or not dark_path.exists():
        return {"available": False}
    with Image.open(light_path) as light_image, Image.open(dark_path) as dark_image:
        light = np.asarray(light_image.convert("RGBA"))
        dark = np.asarray(dark_image.convert("RGBA"))
    if light.shape != dark.shape:
        return {"available": True, "sizeMatches": False, "lightSize": list(light.shape[:2][::-1]), "darkSize": list(dark.shape[:2][::-1])}
    ink = light[..., 3] > 0
    polarity_all = light[..., :3].astype(np.int16) + dark[..., :3].astype(np.int16)
    polarity_ink = polarity_all[ink]
    light_ink = ink_luminance(light)
    dark_ink = ink_luminance(dark)
    return {
        "available": True,
        "sizeMatches": True,
        "alphaMaskIdentical": bool(np.array_equal(light[..., 3], dark[..., 3])),
        "rgbIdentical": bool(np.array_equal(light[..., :3], dark[..., :3])),
        # True only where both files are fully inverted; transparent pixels often
        # share RGB 0,0,0 in both files, so this is reported for comparison only.
        "rgbPolarityInvertedEveryPixel": bool(np.all(polarity_all == 255)),
        # The meaningful statement: wherever there is ink, one file is the exact
        # 255-minus complement of the other.
        "rgbPolarityInvertedOnInkPixels": bool(np.all(polarity_ink == 255)),
        "inkPixelCount": int(ink.sum()),
        "lightInkIsUniformBlack": light_ink.get("max") == 0.0,
        "darkInkIsUniformWhite": dark_ink.get("min") == 255.0,
        "lightInkMedian": light_ink.get("median"),
        "darkInkMedian": dark_ink.get("median"),
    }


def checkerboard(size, square=16):
    board = Image.new("RGB", size, (128, 128, 128))
    draw = ImageDraw.Draw(board)
    for y in range(0, size[1], square):
        for x in range(0, size[0], square):
            if (x // square + y // square) % 2:
                draw.rectangle([x, y, x + square - 1, y + square - 1], fill=(160, 160, 160))
    return board


def contact_sheet(mode: str, records: dict) -> Path:
    columns, rows = 5, 4
    sheet = checkerboard((columns * CELL_W, rows * (CELL_H + LABEL_H)), square=20)
    draw = ImageDraw.Draw(sheet)

    cells = [(character, view) for character in CHARACTERS for view in ("front", "side")]
    for index, (character, view) in enumerate(cells):
        column, row = index % columns, index // columns
        x, y = column * CELL_W, row * (CELL_H + LABEL_H)
        draw.rectangle([x, y, x + CELL_W - 1, y + LABEL_H - 1], fill=(20, 20, 20))
        draw.text((x + 4, y + 4), f"{character} / {view}", fill=(255, 255, 255))
        with Image.open(ROOT / records[f"{mode}:{character}:{view}"]["relativePath"]) as image:
            thumb = image.convert("RGBA").copy()
        thumb.thumbnail((CELL_W - 6, CELL_H - 6), Image.LANCZOS)
        cell = checkerboard((CELL_W, CELL_H), square=20)
        cell.paste(thumb, ((CELL_W - thumb.width) // 2, (CELL_H - thumb.height) // 2), thumb)
        sheet.paste(cell, (x, y + LABEL_H))

    out = BASELINE / f"contact-sheet-{mode}.png"
    sheet.save(out)
    return out


def main() -> None:
    BASELINE.mkdir(parents=True, exist_ok=True)
    records = {}
    missing = []
    for mode in ("light", "dark"):
        for character in CHARACTERS:
            for view in VIEWS:
                path = source_path(mode, character, view)
                key = f"{mode}:{character}:{view}"
                if not path.exists():
                    missing.append({"key": key, "expectedPath": path.relative_to(ROOT).as_posix()})
                    continue
                records[key] = analyse(path)

    cross_mode = {f"{character}:{view}": compare_modes(character, view) for character in CHARACTERS for view in VIEWS}

    by_hash = {}
    for key, record in records.items():
        by_hash.setdefault(record["sha256"], []).append(key)
    duplicates = [{"sha256": digest, "keys": sorted(keys)} for digest, keys in by_hash.items() if len(keys) > 1]

    manifest = {
        "generatedFrom": ["lineart assets/light", "lineart assets/dark"],
        "expectedFiles": len(CHARACTERS) * 2 * 2,
        "foundFiles": len(records),
        "missing": missing,
        "duplicateContent": duplicates,
        "crossMode": cross_mode,
        "files": {key: records[key] for key in sorted(records)},
    }
    (BASELINE / "source-images.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"expected={manifest['expectedFiles']} found={manifest['foundFiles']} missing={len(missing)}")
    for entry in missing:
        print(f"  MISSING {entry['key']} -> {entry['expectedPath']}")
    print(f"duplicate file content groups: {len(duplicates)}")
    for group in duplicates:
        print(f"  {group['sha256'][:12]} {group['keys']}")

    print("\ncross-mode light/dark pair check:")
    print(f"{'pair':<16} {'size':>5} {'alphaSame':>10} {'rgbSame':>8} {'invAll':>7} {'invOnInk':>9} {'L-ink':>7} {'D-ink':>7}")
    for key, entry in cross_mode.items():
        if not entry.get("available"):
            print(f"{key:<16} unavailable")
            continue
        print(
            f"{key:<16} {str(entry['sizeMatches']):>5} {str(entry.get('alphaMaskIdentical')):>10}"
            f" {str(entry.get('rgbIdentical')):>8} {str(entry.get('rgbPolarityInvertedEveryPixel')):>7}"
            f" {str(entry.get('rgbPolarityInvertedOnInkPixels')):>9}"
            f" {str(entry.get('lightInkMedian')):>7} {str(entry.get('darkInkMedian')):>7}"
        )

    for mode in ("light", "dark"):
        sheet = contact_sheet(mode, records)
        print(f"\nwrote {sheet.relative_to(ROOT).as_posix()}")

    print("\nper-file summary:")
    print(f"{'key':<22} {'WxH':<12} {'mode':<6} {'transp%':>8} {'partial%':>9} {'opaque%':>8} {'inkMedian':>10} {'inkMean':>8}")
    for key in sorted(records):
        record = records[key]
        alpha = record["alpha"]
        ink = record["ink"]
        print(
            f"{key:<22} {record['header'].get('width')}x{record['header'].get('height'):<6} {record['pillowMode']:<6}"
            f" {100 * alpha['transparentFraction']:>8.2f} {100 * alpha['partialFraction']:>9.2f}"
            f" {100 * alpha['opaqueFraction']:>8.2f} {ink.get('median', float('nan')):>10} {ink.get('mean', float('nan')):>8}"
        )


if __name__ == "__main__":
    main()
