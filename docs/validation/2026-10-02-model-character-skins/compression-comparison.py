"""P1 size/quality study for the skin display copies (decision support only).

The user asked to see an original-vs-compressed comparison before deciding the
offline export volume policy. Source images are only ever read.

All 40 source files are measured. Variants:
  original       as shipped by the user
  la-lossless    RGBA -> grayscale+alpha PNG (byte-identical, verified)
  la-75 / la-50  LA downscaled to 75% / 50% with LANCZOS
  webp-lossless  WebP lossless (smallest "no visible change" option here)
  webp-q90-50    WebP quality 90 at 50%

For each variant the study reports bytes and how far the pixels moved. Because
the art is single-colour ink on transparency, both alpha and RGB deltas are
measured; an alpha-only check would call a colour-shifted stroke identical.
RGB is compared only where ink is visible in either image, and transparent
pixels' RGB is explicitly excluded from the "visible" verdict.

Outputs (relative to this file):
  baseline/compression-comparison.json
  baseline/compression-comparison.png
"""

import json
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
BASELINE = HERE / "baseline"

CHARACTERS = ["ChatGPT", "Claude", "GLM", "Gemini", "DeepSeek", "Kimi", "Qwen", "Grok", "Muse", "Mimo"]
VIEWS = {
    "front": {"light": "{n}-lineart.png", "dark": "{n}-dark-lineart.png"},
    "side": {"light": "{n}-side-lineart.png", "dark": "{n}-side-dark-lineart.png"},
}
ALL_SUBJECTS = [(mode, character, view) for mode in ("light", "dark") for character in CHARACTERS for view in ("front", "side")]
SHEET_SUBJECT = ("light", "ChatGPT", "front")

VARIANTS = ["original", "la-lossless", "la-75", "la-50", "webp-lossless", "webp-q90-50"]

# 1:1 detail crop on the subject's head/hair area, where thin strokes live.
CROP = (300, 100, 600, 400)
PATCH = 300
DISPLAY_H = 520
LABEL_H = 18
LABEL_COL_W = 0

EXISTING_EXPORT_BYTES = 28.54 * 1024 * 1024  # dist/codex-usage.html, measured 2026-10-02


def path_of(mode, character, view):
    return ROOT / "lineart assets" / mode / VIEWS[view][mode].format(n=character)


def load_rgba(path):
    with Image.open(path) as image:
        return image.convert("RGBA").copy()


def encode(image, fmt, **kwargs):
    buffer = BytesIO()
    image.save(buffer, format=fmt, **kwargs)
    return buffer.getvalue()


def decode_rgba(data):
    return Image.open(BytesIO(data)).convert("RGBA")


def compare_pixels(reference, candidate):
    if candidate.size != reference.size:
        candidate = candidate.resize(reference.size, Image.LANCZOS)
    a = np.asarray(reference)
    b = np.asarray(candidate)
    if a.shape != b.shape:
        b = np.asarray(candidate.convert("RGBA"))
    alpha_delta = np.abs(a[..., 3].astype(np.int16) - b[..., 3].astype(np.int16))
    visible = (a[..., 3] > 0) | (b[..., 3] > 0)
    rgb_delta = np.abs(a[..., :3].astype(np.int16) - b[..., :3].astype(np.int16))
    rgb_visible = rgb_delta[visible] if visible.any() else np.zeros(1, dtype=np.int16)
    return {
        "alphaMaxDelta": int(alpha_delta.max()),
        "alphaChangedPixelFraction": round(float((alpha_delta > 0).mean()), 6),
        "rgbMaxDeltaVisible": int(rgb_visible.max()),
        "rgbChangedVisibleFraction": round(float((rgb_visible > 0).mean()), 6),
        "byteIdentical": bool(np.array_equal(a, b)),
        "visuallyIdentical": bool(alpha_delta.max() == 0 and rgb_visible.max() == 0),
    }


def variants_for(original):
    la = original.convert("LA")
    la75 = la.resize((round(la.width * 0.75), round(la.height * 0.75)), Image.LANCZOS)
    la50 = la.resize((round(la.width * 0.5), round(la.height * 0.5)), Image.LANCZOS)
    return {
        "original": ("PNG", original, {}),
        "la-lossless": ("PNG", la, {"optimize": True, "compress_level": 9}),
        "la-75": ("PNG", la75, {"optimize": True, "compress_level": 9}),
        "la-50": ("PNG", la50, {"optimize": True, "compress_level": 9}),
        "webp-lossless": ("WEBP", original, {"lossless": True, "method": 5}),
        "webp-q90-50": ("WEBP", la50.convert("RGBA"), {"quality": 90, "method": 5}),
    }


def measure_subject(mode, character, view):
    path = path_of(mode, character, view)
    original = load_rgba(path)
    source_bytes = path.stat().st_size
    rows = []
    for name in VARIANTS:
        fmt, image, kwargs = variants_for(original)[name]
        data = encode(image, fmt, **kwargs)
        entry = {
            "variant": name,
            "format": fmt,
            "size": list(image.size),
            "bytes": len(data),
            "percentOfOriginal": round(100 * len(data) / source_bytes, 1),
            **compare_pixels(original, decode_rgba(data)),
        }
        rows.append(entry)
    array = np.asarray(original)
    return {
        "mode": mode,
        "character": character,
        "view": view,
        "sourcePath": path.relative_to(ROOT).as_posix(),
        "sourceBytes": source_bytes,
        "sourceSize": list(original.size),
        "rgbChannelsEqual": bool(np.all(array[..., 0] == array[..., 1]) and np.all(array[..., 1] == array[..., 2])),
        "variants": rows,
    }


def comparison_sheet(subject):
    """Two rows: the figure at a realistic on-page height, then a 1:1 crop."""
    mode, character, view = subject
    original = load_rgba(path_of(mode, character, view))
    la = original.convert("LA")
    columns = [
        ("original", "A original PNG", original),
        ("la-lossless", "B LA lossless", la.convert("RGBA")),
        ("la-75", "C LA 75%", la.resize((round(la.width * 0.75), round(la.height * 0.75)), Image.LANCZOS).convert("RGBA")),
        ("la-50", "D LA 50%", la.resize((round(la.width * 0.5), round(la.height * 0.5)), Image.LANCZOS).convert("RGBA")),
    ]
    columns.append(("webp-lossless", "E WebP lossless", decode_rgba(encode(original, "WEBP", lossless=True, method=5))))

    sheet_w = len(columns) * PATCH
    sheet_h = LABEL_H + DISPLAY_H + LABEL_H + PATCH
    sheet = Image.new("RGB", (sheet_w, sheet_h), (128, 128, 128))
    draw = ImageDraw.Draw(sheet)

    for index, (name, label, image) in enumerate(columns):
        x = index * PATCH
        draw.rectangle([x, 0, x + PATCH - 1, LABEL_H - 1], fill=(20, 20, 20))
        draw.text((x + 4, 4), label, fill=(255, 255, 255))

        thumb = image.copy()
        thumb.thumbnail((PATCH - 6, DISPLAY_H - 6), Image.LANCZOS)
        board = checkerboard((PATCH, DISPLAY_H), 20)
        board.paste(thumb, ((PATCH - thumb.width) // 2, (DISPLAY_H - thumb.height) // 2), thumb)
        sheet.paste(board, (x, LABEL_H))

        restored = image if image.size == original.size else image.resize(original.size, Image.LANCZOS)
        crop = restored.crop(CROP)
        board = checkerboard((PATCH, PATCH), 20)
        board.paste(crop, (0, 0), crop)
        y = LABEL_H + DISPLAY_H + LABEL_H
        draw.rectangle([x, LABEL_H + DISPLAY_H, x + PATCH - 1, y - 1], fill=(20, 20, 20))
        draw.text((x + 4, LABEL_H + DISPLAY_H + 4), f"{label} @1:1", fill=(255, 255, 255))
        sheet.paste(board, (x, y))

    out = BASELINE / "compression-comparison.png"
    sheet.save(out)
    return out


def checkerboard(size, square=16):
    board = Image.new("RGB", size, (128, 128, 128))
    draw = ImageDraw.Draw(board)
    for y in range(0, size[1], square):
        for x in range(0, size[0], square):
            if (x // square + y // square) % 2:
                draw.rectangle([x, y, x + square - 1, y + square - 1], fill=(160, 160, 160))
    return board


# Measured from the P0.2 baseline (body background per theme).
PAGE_BG = {"light": (207, 216, 225), "dark": (32, 37, 43)}


def flatten_at_opacity(asset, background, opacity):
    """What the page actually shows: the asset at `opacity` over the page colour."""
    layer = asset.copy()
    layer.putalpha(layer.getchannel("A").point(lambda value: round(value * opacity)))
    canvas = Image.new("RGB", asset.size, background)
    canvas.paste(layer, (0, 0), layer)
    return canvas


def amplified_difference(left, right, factor=20):
    a = np.asarray(left.convert("RGB")).astype(np.int16)
    b = np.asarray(right.convert("RGB")).astype(np.int16)
    return Image.fromarray(np.clip(np.abs(a - b) * factor, 0, 255).astype(np.uint8), "RGB")


def look_sheet(character="ChatGPT", view="front"):
    """Pixel-level proof sheet for the LA-lossless and WebP-lossless proposals.

    Columns are original / LA lossless / WebP lossless. Rows: the whole figure,
    a 4x nearest-neighbour zoom on the eye area (no interpolation, so any pixel
    change is visible), a 20x-amplified difference against the original taken at
    the real 50% opacity over the page colour, and the real page rendering on
    the light and dark backgrounds.
    """
    cells, label_h, label_col = 300, 18, 220
    center_crop = (300, 100, 600, 400)
    zoom_crop = (360, 195, 435, 270)

    per_mode = {}
    for mode in ("light", "dark"):
        original = load_rgba(path_of(mode, character, view))
        per_mode[mode] = {
            "original": original,
            "la-lossless": decode_rgba(encode(original.convert("LA"), "PNG", optimize=True, compress_level=9)),
            "webp-lossless": decode_rgba(encode(original, "WEBP", lossless=True, method=5)),
        }

    def on_checker(image, size):
        board = checkerboard((size, size), 20)
        board.paste(image, (0, 0), image)
        return board

    def whole(light, _dark):
        thumb = light.copy()
        thumb.thumbnail((cells - 6, cells - 6), Image.LANCZOS)
        board = checkerboard((cells, cells), 20)
        board.paste(thumb, ((cells - thumb.width) // 2, (cells - thumb.height) // 2), thumb)
        return board

    def zoom(light, _dark):
        return on_checker(light.crop(zoom_crop).resize((cells, cells), Image.NEAREST), cells)

    def difference(light, _dark):
        background = PAGE_BG["light"]
        reference = flatten_at_opacity(per_mode["light"]["original"], background, 0.5).crop(center_crop)
        current = flatten_at_opacity(light, background, 0.5).crop(center_crop)
        return amplified_difference(reference, current)

    def on_page(background, pick):
        def render(light, dark):
            rendered = flatten_at_opacity(pick(light, dark), background, 0.5)
            thumb = rendered.copy()
            thumb.thumbnail((cells, cells), Image.LANCZOS)
            board = Image.new("RGB", (cells, cells), background)
            board.paste(thumb, ((cells - thumb.width) // 2, (cells - thumb.height) // 2))
            return board

        return render

    rows = [
        ("1. whole figure", whole),
        ("2. 4x nearest zoom (eye)", zoom),
        ("3. diff x20 @50% on page bg", difference),
        ("4. light page bg @50%", on_page(PAGE_BG["light"], lambda light, dark: light)),
        ("5. dark page bg @50% (dark asset)", on_page(PAGE_BG["dark"], lambda light, dark: dark)),
    ]
    columns = [("original", "A original PNG"), ("la-lossless", "B LA lossless"), ("webp-lossless", "C WebP lossless")]

    sheet = Image.new("RGB", (label_col + len(columns) * cells, label_h + len(rows) * (label_h + cells)), (48, 48, 48))
    draw = ImageDraw.Draw(sheet)
    draw.rectangle([0, 0, sheet.width - 1, label_h - 1], fill=(20, 20, 20))
    for index, (_, label) in enumerate(columns):
        draw.text((label_col + index * cells + 4, 4), label, fill=(255, 255, 255))

    for row_index, (row_label, builder) in enumerate(rows):
        y = label_h + row_index * (label_h + cells)
        draw.rectangle([0, y, sheet.width - 1, y + label_h - 1], fill=(20, 20, 20))
        draw.text((6, y + 4), row_label, fill=(255, 255, 255))
        for index, (variant, _) in enumerate(columns):
            sheet.paste(builder(per_mode["light"][variant], per_mode["dark"][variant]), (label_col + index * cells, y + label_h))

    out = BASELINE / "compression-look.png"
    sheet.save(out)
    return out


def main():
    BASELINE.mkdir(parents=True, exist_ok=True)
    results = []
    for index, subject in enumerate(ALL_SUBJECTS, start=1):
        results.append(measure_subject(*subject))
        if index % 10 == 0:
            print(f"measured {index}/{len(ALL_SUBJECTS)} files")

    (BASELINE / "compression-comparison.json").write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    source_total = sum(r["sourceBytes"] for r in results)
    print(f"\n40 source files = {source_total/1024/1024:.2f} MB")
    print("all 40 files have R==G==B on every pixel:", all(r["rgbChannelsEqual"] for r in results))

    print(f"\n{'variant':<15}{'total MB':>10}{'% of orig':>11}{'base64 MB':>11}{'export MB':>11}   fidelity")
    summary = []
    for name in VARIANTS:
        total = sum(next(row for row in r["variants"] if row["variant"] == name)["bytes"] for r in results)
        base64_mb = total * 4 / 3 / 1024 / 1024
        export_mb = (EXISTING_EXPORT_BYTES + total * 4 / 3) / 1024 / 1024
        rows = [next(row for row in r["variants"] if row["variant"] == name) for r in results]
        identical = all(row["visuallyIdentical"] for row in rows)
        byte_identical = all(row["byteIdentical"] for row in rows)
        worst_rgb = max(row["rgbMaxDeltaVisible"] for row in rows)
        worst_alpha = max(row["alphaMaxDelta"] for row in rows)
        if byte_identical:
            verdict = "byte-identical"
        elif identical:
            verdict = "visually identical (invisible px only)"
        else:
            verdict = f"changed: alpha<={worst_alpha}, rgb<={worst_rgb}"
        print(f"{name:<15}{total/1024/1024:>10.2f}{100*total/source_total:>10.1f}%{base64_mb:>11.1f}{export_mb:>11.1f}   {verdict}")
        summary.append({"variant": name, "totalBytes": total, "base64Mb": round(base64_mb, 1), "exportMb": round(export_mb, 1), "verdict": verdict})

    print(f"\nexisting dist/codex-usage.html = {EXISTING_EXPORT_BYTES/1024/1024:.2f} MB")

    print("\nper-file size under the two no-visible-change options (KB):")
    print(f"{'file':<34}{'orig':>7}{'LA':>7}{'WebP-LL':>9}")
    for result in results:
        rows = {row["variant"]: row for row in result["variants"]}
        print(f"{result['sourcePath'].replace('lineart assets/', ''):<34}{result['sourceBytes']/1024:>7.0f}{rows['la-lossless']['bytes']/1024:>7.0f}{rows['webp-lossless']['bytes']/1024:>9.0f}")

    sheet = comparison_sheet(SHEET_SUBJECT)
    print(f"\nwrote {sheet.relative_to(ROOT).as_posix()}")

    look = look_sheet()
    print(f"wrote {look.relative_to(ROOT).as_posix()}")

    # Explicit verdict for the two no-visible-change candidates, across all 40 files.
    for name in ("la-lossless", "webp-lossless"):
        rows = [next(row for row in r["variants"] if row["variant"] == name) for r in results]
        print(
            f"{name}: byte-identical={all(row['byteIdentical'] for row in rows)} "
            f"visually-identical={all(row['visuallyIdentical'] for row in rows)} "
            f"maxAlphaDelta={max(row['alphaMaxDelta'] for row in rows)} "
            f"maxVisibleRgbDelta={max(row['rgbMaxDeltaVisible'] for row in rows)}"
        )


if __name__ == "__main__":
    main()
