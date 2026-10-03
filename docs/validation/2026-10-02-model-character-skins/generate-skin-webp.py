"""One-off generator for the public WebP display copies (implementation plan 3.4).

Node has no built-in image encoder and the preparation/check scripts may only use
built-in fs/path without adding production dependencies, so the 40 public copies
are produced here, once, and committed. `skins:prepare` / `skins:check` then work
from the registry, the recorded hashes and the committed files.

The transform is deterministic and lossless:
    source PNG (RGBA, single-colour ink)  ->  WebP lossless
Geometry, alpha and ink polarity are preserved exactly. Nothing is resized,
recoloured or inverted, and the sources under `lineart assets/` are only read.

Run:
  & "<bundled python>" docs/validation/2026-10-02-model-character-skins/generate-skin-webp.py

Outputs:
  public/assets/skins/light/*.webp
  public/assets/skins/dark/*.webp
  public/skin-assets.json          (per-file source and copy hashes)
"""

import hashlib
import json
import subprocess
import sys
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PUBLIC_ROOT = ROOT / "public" / "assets" / "skins"
MANIFEST = ROOT / "public" / "skin-assets.json"

WEBP_LOSSLESS_PARAMS = {"lossless": True, "method": 5}

# Ask the registry (public/skins.js) for the authoritative asset list instead of
# duplicating 40 paths here; the registry is the single source of truth.
REGISTRY_SNIPPET = (
    'import("./public/skins.js").then((m) => '
    "process.stdout.write(JSON.stringify(m.enumerateSourceAssets())));"
)


def load_registry():
    result = subprocess.run(
        ["node", "-e", REGISTRY_SNIPPET],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"registry read failed:\n{result.stderr}")
    return json.loads(result.stdout)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def main() -> int:
    sources = load_registry()
    print(f"registry reports {len(sources)} source assets")
    if len(sources) != 40:
        print(f"FAIL expected 40 source assets from the registry, got {len(sources)}")
        return 1

    manifest = {
        "generatedBy": "docs/validation/2026-10-02-model-character-skins/generate-skin-webp.py",
        "transform": "PNG(RGBA) -> WebP lossless, geometry and ink polarity preserved, no resize/recolour/invert",
        "encoder": f"Pillow {Image.__version__}",
        "assets": {},
    }

    created, verified, missing = 0, 0, []
    for entry in sources:
        source_path = ROOT / entry["sourcePath"]
        if not source_path.exists():
            missing.append(entry["sourcePath"])
            continue
        source_bytes = source_path.read_bytes()

        with Image.open(source_path) as image:
            original = image.convert("RGBA")
        # Encode into memory first so a failure never leaves a half-written copy.
        buffer = BytesIO()
        original.save(buffer, format="WEBP", **WEBP_LOSSLESS_PARAMS)
        encoded = buffer.getvalue()

        decoded = Image.open(BytesIO(encoded)).convert("RGBA")
        a = np.asarray(original)
        b = np.asarray(decoded)
        if a.shape != b.shape:
            print(f"FAIL {entry['publicUrl']}: shape changed {a.shape} -> {b.shape}")
            return 1
        alpha_delta = int(np.abs(a[..., 3].astype(np.int16) - b[..., 3].astype(np.int16)).max())
        visible = (a[..., 3] > 0) | (b[..., 3] > 0)
        rgb_delta = np.abs(a[..., :3].astype(np.int16) - b[..., :3].astype(np.int16))
        rgb_max = int(rgb_delta[visible].max()) if visible.any() else 0
        # Fully transparent pixels may lose RGB (invisible); anything visible must not move.
        hidden_rgb_changed = bool(np.any(rgb_delta[~visible] != 0))
        if alpha_delta != 0 or rgb_max != 0:
            print(f"FAIL {entry['publicUrl']}: lossless encode changed visible pixels (alpha<={alpha_delta}, rgb<={rgb_max})")
            return 1

        out_name = entry["expectedName"]
        mode_dir = PUBLIC_ROOT / entry["mode"]
        mode_dir.mkdir(parents=True, exist_ok=True)
        out_path = mode_dir / out_name
        if out_path.exists() and out_path.read_bytes() == encoded:
            verified += 1
        else:
            out_path.write_bytes(encoded)
            created += 1

        manifest["assets"][entry["publicUrl"]] = {
            "skinId": entry["skinId"],
            "mode": entry["mode"],
            "view": entry["view"],
            "sourcePath": entry["sourcePath"],
            "sourceBytes": len(source_bytes),
            "sourceSha256": sha256_bytes(source_bytes),
            "publicPath": (out_path.relative_to(ROOT)).as_posix(),
            "publicBytes": len(encoded),
            "publicSha256": sha256_bytes(encoded),
            "alphaMaxDelta": alpha_delta,
            "rgbMaxDeltaVisible": rgb_max,
            "transparentRgbReduced": hidden_rgb_changed,
        }

    if missing:
        print(f"FAIL missing {len(missing)} source file(s):")
        for path in missing:
            print(f"  {path}")
        return 1

    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    total_source = sum(a["sourceBytes"] for a in manifest["assets"].values())
    total_public = sum(a["publicBytes"] for a in manifest["assets"].values())
    print(f"copies written: {created}, already up to date: {verified}")
    print(f"source total {total_source/1024/1024:.2f} MB -> public total {total_public/1024/1024:.2f} MB")
    print(f"wrote {MANIFEST.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
