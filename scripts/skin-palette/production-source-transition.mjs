import { createHash } from "node:crypto";

import { SOURCE_FILES } from "./capture.mjs";
import { buildProductionBootstrapSource } from "./production-bootstrap-source.mjs";
import { buildProductionPaletteSource } from "./production-palette-source.mjs";
import { buildProductionPickerSource } from "./production-picker-source.mjs";

const PREIMAGE_FILES = Object.freeze(["public/skin-palettes.js", "public/skin-picker.js", "public/skin-bootstrap.js"]);
const PREIMAGE_SET = new Set(PREIMAGE_FILES);
const SHA256_RE = /^[a-f0-9]{64}$/;

function copyExactRecord(value, label, keys, validateValue, copyValue = (item) => item) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain or null-prototype record`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain or null-prototype record`);
  }

  const allowedKeys = new Set(keys);
  const descriptors = new Map();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${label} must not have symbol keys`);
    if (!allowedKeys.has(key)) throw new TypeError(`${label} has unknown key ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an own data property`);
    }
    if (!validateValue(descriptor.value)) throw new TypeError(`${label}.${key} has an invalid value`);
    descriptors.set(key, descriptor.value);
  }
  if (descriptors.size !== keys.length) throw new TypeError(`${label} is missing registered keys`);

  const copy = Object.create(null);
  for (const key of keys) copy[key] = copyValue(descriptors.get(key));
  return copy;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Check the only permitted production source transition using caller-supplied bytes. */
export function verifyProductionSourceTransition({
  beforeSourceHashes,
  sourceSnapshot,
  afterSourceBytes,
  verifiedModel,
  selections,
} = {}) {
  const before = copyExactRecord(
    beforeSourceHashes,
    "beforeSourceHashes",
    SOURCE_FILES,
    (value) => typeof value === "string" && SHA256_RE.test(value),
  );
  const snapshot = copyExactRecord(sourceSnapshot, "sourceSnapshot", PREIMAGE_FILES, Buffer.isBuffer, (value) =>
    Buffer.from(value),
  );
  const after = copyExactRecord(afterSourceBytes, "afterSourceBytes", SOURCE_FILES, Buffer.isBuffer, (value) =>
    Buffer.from(value),
  );
  const sourceHashes = Object.fromEntries(SOURCE_FILES.map((file) => [file, sha256(after[file])]));
  const errorsByPath = new Map(SOURCE_FILES.map((file) => [file, []]));
  const addError = (error) => errorsByPath.get(error.path).push(error);

  const preimageMismatches = new Set();
  for (const file of PREIMAGE_FILES) {
    if (sha256(snapshot[file]) !== before[file]) {
      preimageMismatches.add(file);
      addError({
        code: "source-preimage-mismatch",
        path: file,
        detail: "sourceSnapshot SHA-256 differs from beforeSourceHashes",
      });
    }
  }

  for (const file of SOURCE_FILES) {
    if (PREIMAGE_SET.has(file)) continue;
    if (sha256(after[file]) !== before[file]) {
      addError({
        code: "unexpected-source-transition",
        path: file,
        detail: "unchanged source bytes differ from beforeSourceHashes",
      });
    }
  }

  const expectedBootstrap = buildProductionBootstrapSource({ verifiedModel, selections });
  if (preimageMismatches.size === 0) {
    const expected = new Map([
      [
        "public/skin-palettes.js",
        buildProductionPaletteSource({
          beforeSource: snapshot["public/skin-palettes.js"],
          verifiedModel,
          selections,
        }),
      ],
      ["public/skin-picker.js", buildProductionPickerSource({ beforeSource: snapshot["public/skin-picker.js"] })],
      ["public/skin-bootstrap.js", expectedBootstrap],
    ]);
    for (const file of PREIMAGE_FILES) {
      if (!after[file].equals(expected.get(file))) {
        addError({
          code: "production-source-transition-mismatch",
          path: file,
          detail: "source bytes differ from the complete production constructor output",
        });
      }
    }
  } else if (!after["public/skin-bootstrap.js"].equals(expectedBootstrap)) {
    addError({
      code: "production-source-transition-mismatch",
      path: "public/skin-bootstrap.js",
      detail: "source bytes differ from the complete production constructor output",
    });
  }

  const errors = SOURCE_FILES.flatMap((file) => errorsByPath.get(file));
  return {
    status: errors.length === 0 ? "pass" : "rejected",
    errors,
    gaps: [],
    sourceHashes,
  };
}
