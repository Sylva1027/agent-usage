import { contrastRatio } from "./color-math.mjs";

const THRESHOLD = 3;
const DISTANCE = 4;
const CORE_EDGE_TOLERANCE = 1 - 0.5;
const CORE_CORNER_TOLERANCE = 1 - Math.SQRT1_2;
const ENVELOPE_TOLERANCE = 1 + Math.SQRT1_2;
const ADJACENT_DISTANCE_MIN = 6;
const ADJACENT_DISTANCE_MAX = 7;
const GEOMETRY_EPSILON = 1e-9;
const REGION_IDS = Object.freeze([
  "top",
  "topRight",
  "right",
  "bottomRight",
  "bottom",
  "bottomLeft",
  "left",
  "topLeft",
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFinite(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} 必须是有限数值`);
  }
  return value;
}

function emptyRegions() {
  return Object.fromEntries(REGION_IDS.map((id) => [id, { core: 0, envelope: 0 }]));
}

function emptyAdjacentRegions() {
  return Object.fromEntries(
    REGION_IDS.map((id) => [id, { core: 0, background: 0, minRatio: null, worstBackground: null }]),
  );
}

function unmeasured(reason, diagnostics = {}) {
  return {
    result: "unmeasured",
    ratio: null,
    threshold: THRESHOLD,
    reason,
    corePixelCount: 0,
    envelopePixelCount: 0,
    regions: emptyRegions(),
    coreMinRatio: null,
    conservativeMinRatio: null,
    worstCore: null,
    worstEnvelope: null,
    diagnostics,
  };
}

function adjacentUnmeasured(reason, diagnostics = {}) {
  return {
    result: "unmeasured",
    ratio: null,
    threshold: THRESHOLD,
    reason,
    corePixelCount: 0,
    backgroundPixelCount: 0,
    regions: emptyAdjacentRegions(),
    worstBackground: null,
    diagnostics,
  };
}

function readPixelDimensions(input) {
  if (!isRecord(input)) throw new TypeError("input 必须是对象");
  const { width, height } = input;
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new TypeError("width 与 height 必须是正安全整数");
  }
  const expectedLength = width * height * 4;
  if (!Number.isSafeInteger(expectedLength)) throw new TypeError("图像尺寸乘积超出安全整数范围");
  return { width, height, expectedLength };
}

function readOutlineGeometry({ rect, outline }) {
  if (!isRecord(rect) || !isRecord(outline)) throw new TypeError("rect 与 outline 必须是对象");
  const geometry = {
    rect: {
      x: requireFinite(rect.x, "rect.x"),
      y: requireFinite(rect.y, "rect.y"),
      width: requireFinite(rect.width, "rect.width"),
      height: requireFinite(rect.height, "rect.height"),
    },
    outline: {
      width: requireFinite(outline.width, "outline.width"),
      offset: requireFinite(outline.offset, "outline.offset"),
      radius: requireFinite(outline.radius, "outline.radius"),
      color: outline.color,
    },
  };
  if (geometry.rect.width <= 0 || geometry.rect.height <= 0) throw new TypeError("rect 宽高必须为正数");
  if (geometry.outline.width <= 0 || geometry.outline.radius < 0) {
    throw new TypeError("outline.width 必须为正数且 radius 不得为负数");
  }
  if (!Array.isArray(geometry.outline.color) || geometry.outline.color.length !== 4) {
    throw new TypeError("outline.color 必须是四通道 RGBA 数组");
  }
  for (const [index, channel] of geometry.outline.color.entries()) {
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new TypeError(`outline.color[${index}] 必须是 0..255 的整数`);
    }
  }
  if (geometry.outline.radius > Math.min(geometry.rect.width, geometry.rect.height) / 2) {
    throw new TypeError("outline.radius 不得超过 rect 短边的一半");
  }
  return geometry;
}

function readAdjacentInput(input) {
  const { width, height, expectedLength } = readPixelDimensions(input);
  const { focused } = input;
  if (!(focused instanceof Uint8Array) && !(focused instanceof Uint8ClampedArray)) {
    throw new TypeError("focused 必须是 Uint8Array 或 Uint8ClampedArray");
  }
  if (focused.length !== expectedLength) throw new TypeError("focused 长度必须为 width × height × 4");
  return { width, height, focused, ...readOutlineGeometry(input) };
}

function readInput(input) {
  const { width, height, expectedLength } = readPixelDimensions(input);
  const { focused, withoutOutline, restored } = input;
  const buffers = { focused, withoutOutline, restored };
  for (const [name, buffer] of Object.entries(buffers)) {
    if (!(buffer instanceof Uint8Array) && !(buffer instanceof Uint8ClampedArray)) {
      throw new TypeError(`${name} 必须是 Uint8Array 或 Uint8ClampedArray`);
    }
    if (buffer.length !== expectedLength) throw new TypeError(`${name} 长度必须为 width × height × 4`);
  }
  return { width, height, buffers, ...readOutlineGeometry(input) };
}

function regionFor(x, y, rect, radius) {
  const leftCenter = rect.x + radius;
  const rightCenter = rect.x + rect.width - radius;
  const topCenter = rect.y + radius;
  const bottomCenter = rect.y + rect.height - radius;
  if (x < leftCenter) {
    if (y < topCenter) return "topLeft";
    if (y > bottomCenter) return "bottomLeft";
    return "left";
  }
  if (x > rightCenter) {
    if (y < topCenter) return "topRight";
    if (y > bottomCenter) return "bottomRight";
    return "right";
  }
  if (y < topCenter) return "top";
  if (y > bottomCenter) return "bottom";
  return null;
}

function signedDistance(x, y, rect, radius) {
  const qx = Math.abs(x - (rect.x + rect.width / 2)) - (rect.width / 2 - radius);
  const qy = Math.abs(y - (rect.y + rect.height / 2)) - (rect.height / 2 - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function pixelRgba(buffer, offset) {
  return [buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]];
}

function differentBytes(left, right, offset) {
  for (let channel = 0; channel < 4; channel += 1) {
    if (left[offset + channel] !== right[offset + channel]) return true;
  }
  return false;
}

function recordDifference(diagnostic, x, y, left, right, offset) {
  diagnostic.mismatchPixels += 1;
  diagnostic.firstMismatch ??= {
    pixel: { x, y },
    left: pixelRgba(left, offset),
    right: pixelRgba(right, offset),
  };
}

function contrastSample(color, background, x, y) {
  const rgb = color.slice(0, 3).map((channel) => channel / 255);
  const backgroundRgb = background.slice(0, 3).map((channel) => channel / 255);
  return {
    pixel: { x, y },
    center: { x: x + 0.5, y: y + 0.5 },
    ratio: contrastRatio(rgb, backgroundRgb),
    background,
  };
}

function keepWorst(current, sample) {
  return current === null || sample.ratio < current.ratio ? sample : current;
}

/**
 * Compare the declared opaque outline color with every pixel in the fixed
 * d=6..7px band outside the rounded component. This is a finite-domain pixel
 * primitive, not a browser capture routine.
 */
export function analyzeFocusOutlineAdjacentPixels(input) {
  const { width, height, focused, rect, outline } = readAdjacentInput(input);
  const requiredBounds = {
    left: rect.x - ADJACENT_DISTANCE_MAX - 0.5,
    top: rect.y - ADJACENT_DISTANCE_MAX - 0.5,
    right: rect.x + rect.width + ADJACENT_DISTANCE_MAX + 0.5,
    bottom: rect.y + rect.height + ADJACENT_DISTANCE_MAX + 0.5,
  };
  const diagnostics = {
    clip: {
      complete:
        requiredBounds.left >= -GEOMETRY_EPSILON &&
        requiredBounds.top >= -GEOMETRY_EPSILON &&
        requiredBounds.right <= width + GEOMETRY_EPSILON &&
        requiredBounds.bottom <= height + GEOMETRY_EPSILON,
      requiredBounds,
    },
    backgroundAlpha: { checkedPixels: 0, nonOpaquePixels: 0, firstNonOpaque: null },
    coreOutlineColor: { checkedPixels: 0, mismatchPixels: 0, firstMismatch: null },
    missingCoreRegions: [],
    missingBackgroundRegions: [],
  };

  if (outline.width !== 2) return adjacentUnmeasured("unsupported-outline-width", diagnostics);
  if (outline.offset !== 3) return adjacentUnmeasured("unsupported-outline-offset", diagnostics);
  if (outline.radius !== 11) return adjacentUnmeasured("unsupported-outline-radius", diagnostics);
  if (outline.color[3] !== 255) return adjacentUnmeasured("unsupported-outline-alpha", diagnostics);
  if (!diagnostics.clip.complete) {
    return adjacentUnmeasured("clip-does-not-contain-adjacent-band", diagnostics);
  }

  const regions = emptyAdjacentRegions();
  let corePixelCount = 0;
  let backgroundPixelCount = 0;
  let worstBackground = null;
  const outlineColor = outline.color;
  const coreColor = diagnostics.coreOutlineColor;
  const backgroundAlpha = diagnostics.backgroundAlpha;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const centerX = x + 0.5;
      const centerY = y + 0.5;
      const distance = signedDistance(centerX, centerY, rect, outline.radius);
      const region = regionFor(centerX, centerY, rect, outline.radius);
      if (region === null) continue;
      const offset = (y * width + x) * 4;
      const focusedPixel = pixelRgba(focused, offset);
      const coreTolerance =
        region.includes("Left") || region.includes("Right") ? CORE_CORNER_TOLERANCE : CORE_EDGE_TOLERANCE;

      if (Math.abs(distance - DISTANCE) <= coreTolerance + GEOMETRY_EPSILON) {
        corePixelCount += 1;
        regions[region].core += 1;
        coreColor.checkedPixels += 1;
        if (focusedPixel.some((channel, index) => channel !== outlineColor[index])) {
          coreColor.mismatchPixels += 1;
          coreColor.firstMismatch ??= { pixel: { x, y }, focused: focusedPixel, expected: [...outlineColor] };
        }
      }

      if (
        distance < ADJACENT_DISTANCE_MIN - GEOMETRY_EPSILON ||
        distance > ADJACENT_DISTANCE_MAX + GEOMETRY_EPSILON
      ) {
        continue;
      }
      backgroundPixelCount += 1;
      regions[region].background += 1;
      backgroundAlpha.checkedPixels += 1;
      if (focusedPixel[3] !== 255) {
        backgroundAlpha.nonOpaquePixels += 1;
        backgroundAlpha.firstNonOpaque ??= { pixel: { x, y }, alpha: focusedPixel[3] };
        continue;
      }
      const sample = { ...contrastSample(outlineColor, focusedPixel, x, y), region };
      regions[region].minRatio =
        regions[region].minRatio === null
          ? sample.ratio
          : Math.min(regions[region].minRatio, sample.ratio);
      regions[region].worstBackground = keepWorst(regions[region].worstBackground, sample);
      worstBackground = keepWorst(worstBackground, sample);
    }
  }

  diagnostics.missingCoreRegions = REGION_IDS.filter((id) => regions[id].core === 0);
  diagnostics.missingBackgroundRegions = REGION_IDS.filter((id) => regions[id].background === 0);
  const base = {
    result: "unmeasured",
    ratio: null,
    threshold: THRESHOLD,
    reason: "analysis-not-complete",
    corePixelCount,
    backgroundPixelCount,
    regions,
    worstBackground,
    diagnostics,
  };
  if (coreColor.mismatchPixels > 0) {
    return {
      ...base,
      reason: "core-outline-color-mismatch",
      diagnostics: { ...diagnostics, reasons: ["core-outline-color-mismatch"] },
    };
  }
  if (backgroundAlpha.nonOpaquePixels > 0) {
    return {
      ...base,
      reason: "adjacent-background-not-opaque",
      diagnostics: { ...diagnostics, reasons: ["adjacent-background-not-opaque"] },
    };
  }
  if (diagnostics.missingCoreRegions.length > 0) {
    return {
      ...base,
      reason: "core-region-missing",
      diagnostics: { ...diagnostics, reasons: ["core-region-missing"] },
    };
  }
  if (diagnostics.missingBackgroundRegions.length > 0 || backgroundPixelCount === 0 || worstBackground === null) {
    return {
      ...base,
      reason: "adjacent-background-region-missing",
      diagnostics: { ...diagnostics, reasons: ["adjacent-background-region-missing"] },
    };
  }
  if (worstBackground.ratio < THRESHOLD) {
    return {
      ...base,
      result: "fail",
      ratio: worstBackground.ratio,
      reason: "background-contrast-below-threshold",
      diagnostics: { ...diagnostics, reasons: [] },
    };
  }
  return {
    ...base,
    result: "pass",
    ratio: worstBackground.ratio,
    reason: "adjacent-background-pass",
    diagnostics: { ...diagnostics, reasons: [] },
  };
}

/**
 * Classify only the observed solid 2px / offset 3px / radius 11px opaque outline.
 * The clip is compared in full outside the rounded border shape; the interior is ignored.
 */
export function analyzeFocusOutlinePixels(input) {
  const { width, height, buffers, rect, outline } = readInput(input);
  const result = unmeasured("analysis-not-complete");
  const clipExtent = DISTANCE + ENVELOPE_TOLERANCE;
  const requiredBounds = {
    left: rect.x - clipExtent,
    top: rect.y - clipExtent,
    right: rect.x + rect.width + clipExtent,
    bottom: rect.y + rect.height + clipExtent,
  };
  result.diagnostics = {
    clip: {
      complete:
        requiredBounds.left >= -GEOMETRY_EPSILON &&
        requiredBounds.top >= -GEOMETRY_EPSILON &&
        requiredBounds.right <= width + GEOMETRY_EPSILON &&
        requiredBounds.bottom <= height + GEOMETRY_EPSILON,
      requiredBounds,
    },
    coreOutlineColor: { checkedPixels: 0, mismatchPixels: 0, firstMismatch: null },
    envelopeAlpha: {
      checkedPixels: 0,
      nonOpaquePixels: 0,
      channels: { focused: 0, withoutOutline: 0, restored: 0 },
      firstNonOpaque: null,
    },
    restoreOutsideRoundedShape: { checkedPixels: 0, mismatchPixels: 0, firstMismatch: null },
    focusedOutsideEnvelope: { checkedPixels: 0, mismatchPixels: 0, firstMismatch: null },
  };

  if (outline.width !== 2) return unmeasured("unsupported-outline-width", result.diagnostics);
  if (outline.offset !== 3) return unmeasured("unsupported-outline-offset", result.diagnostics);
  if (outline.radius !== 11) return unmeasured("unsupported-outline-radius", result.diagnostics);
  if (outline.color[3] !== 255) return unmeasured("unsupported-outline-alpha", result.diagnostics);
  if (!result.diagnostics.clip.complete) return unmeasured("clip-does-not-contain-envelope", result.diagnostics);

  const regions = emptyRegions();
  let corePixelCount = 0;
  let envelopePixelCount = 0;
  let coreMinRatio = null;
  let conservativeMinRatio = null;
  let worstCore = null;
  let worstEnvelope = null;
  let envelopeOpaque = true;
  const restore = result.diagnostics.restoreOutsideRoundedShape;
  const outside = result.diagnostics.focusedOutsideEnvelope;
  const outlineColor = outline.color;
  const coreColor = result.diagnostics.coreOutlineColor;
  const envelopeAlpha = result.diagnostics.envelopeAlpha;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const centerX = x + 0.5;
      const centerY = y + 0.5;
      const distance = signedDistance(centerX, centerY, rect, outline.radius);
      const distanceFromCenterline = Math.abs(distance - DISTANCE);
      const inEnvelope = distanceFromCenterline <= ENVELOPE_TOLERANCE + GEOMETRY_EPSILON;
      const region = regionFor(centerX, centerY, rect, outline.radius);
      const inCore =
        region !== null &&
        distanceFromCenterline <=
          (region.includes("Left") || region.includes("Right") ? CORE_CORNER_TOLERANCE : CORE_EDGE_TOLERANCE) +
            GEOMETRY_EPSILON;
      const offset = (y * width + x) * 4;

      if (distance > 0) {
        restore.checkedPixels += 1;
        if (differentBytes(buffers.focused, buffers.restored, offset)) {
          recordDifference(restore, x, y, buffers.focused, buffers.restored, offset);
        }
      }

      if (!inEnvelope && distance > 0) {
        outside.checkedPixels += 1;
        if (differentBytes(buffers.focused, buffers.withoutOutline, offset)) {
          recordDifference(outside, x, y, buffers.focused, buffers.withoutOutline, offset);
        }
      }

      if (!inEnvelope || region === null) continue;
      envelopePixelCount += 1;
      regions[region].envelope += 1;
      envelopeAlpha.checkedPixels += 1;
      const alpha = {
        focused: buffers.focused[offset + 3],
        withoutOutline: buffers.withoutOutline[offset + 3],
        restored: buffers.restored[offset + 3],
      };
      let pixelOpaque = true;
      for (const [name, value] of Object.entries(alpha)) {
        if (value !== 255) {
          envelopeAlpha.channels[name] += 1;
          pixelOpaque = false;
        }
      }
      if (!pixelOpaque) {
        envelopeAlpha.nonOpaquePixels += 1;
        envelopeAlpha.firstNonOpaque ??= { pixel: { x, y }, alpha };
        envelopeOpaque = false;
      }
      const background = pixelRgba(buffers.withoutOutline, offset);
      if (pixelOpaque) {
        const sample = contrastSample(outlineColor, background, x, y);
        conservativeMinRatio =
          conservativeMinRatio === null ? sample.ratio : Math.min(conservativeMinRatio, sample.ratio);
        worstEnvelope = keepWorst(worstEnvelope, sample);
      }

      if (!inCore) continue;
      corePixelCount += 1;
      regions[region].core += 1;
      coreColor.checkedPixels += 1;
      const focused = pixelRgba(buffers.focused, offset);
      const restored = pixelRgba(buffers.restored, offset);
      if (
        focused.some((channel, index) => channel !== outlineColor[index]) ||
        restored.some((channel, index) => channel !== outlineColor[index])
      ) {
        coreColor.mismatchPixels += 1;
        coreColor.firstMismatch ??= { pixel: { x, y }, focused, restored, expected: [...outlineColor] };
      }
      if (pixelOpaque) {
        const sample = contrastSample(outlineColor, background, x, y);
        coreMinRatio = coreMinRatio === null ? sample.ratio : Math.min(coreMinRatio, sample.ratio);
        worstCore = keepWorst(worstCore, sample);
      }
    }
  }

  if (!envelopeOpaque) {
    coreMinRatio = null;
    conservativeMinRatio = null;
    worstCore = null;
    worstEnvelope = null;
  }
  const missingCoreRegions = REGION_IDS.filter((id) => regions[id].core === 0);
  const reasons = [];
  if (missingCoreRegions.length > 0 || corePixelCount === 0) reasons.push("core-region-missing");
  if (envelopeAlpha.nonOpaquePixels > 0) reasons.push("envelope-pixel-not-opaque");
  if (coreColor.mismatchPixels > 0) reasons.push("core-outline-color-mismatch");
  if (restore.mismatchPixels > 0) reasons.push("restoration-outside-rounded-shape-mismatch");
  if (outside.mismatchPixels > 0) reasons.push("focused-state-drift-outside-envelope");
  if (envelopePixelCount === 0 || conservativeMinRatio === null || coreMinRatio === null) {
    reasons.push("contrast-samples-incomplete");
  }
  if (reasons.length > 0) {
    return {
      ...result,
      reason: reasons[0],
      corePixelCount,
      envelopePixelCount,
      regions,
      coreMinRatio,
      conservativeMinRatio,
      worstCore,
      worstEnvelope,
      diagnostics: { ...result.diagnostics, missingCoreRegions },
    };
  }
  if (coreMinRatio < THRESHOLD) {
    return {
      ...result,
      result: "fail",
      ratio: coreMinRatio,
      reason: "core-contrast-below-threshold",
      corePixelCount,
      envelopePixelCount,
      regions,
      coreMinRatio,
      conservativeMinRatio,
      worstCore,
      worstEnvelope,
      diagnostics: { ...result.diagnostics, missingCoreRegions },
    };
  }
  if (conservativeMinRatio < THRESHOLD) {
    return {
      ...result,
      reason: "boundary-contrast-uncertain",
      corePixelCount,
      envelopePixelCount,
      regions,
      coreMinRatio,
      conservativeMinRatio,
      worstCore,
      worstEnvelope,
      diagnostics: { ...result.diagnostics, missingCoreRegions },
    };
  }
  return {
    ...result,
    result: "pass",
    ratio: conservativeMinRatio,
    reason: "conservative-envelope-pass",
    corePixelCount,
    envelopePixelCount,
    regions,
    coreMinRatio,
    conservativeMinRatio,
    worstCore,
    worstEnvelope,
    diagnostics: { ...result.diagnostics, missingCoreRegions },
  };
}
