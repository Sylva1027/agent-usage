import assert from "node:assert/strict";
import test from "node:test";

import { contrastRatio } from "../scripts/skin-palette/color-math.mjs";
import { analyzeFocusOutlineAdjacentPixels } from "../scripts/skin-palette/focus-outline-pixels.mjs";

const WIDTH = 72;
const HEIGHT = 49;
const RECT = Object.freeze({ x: 9, y: 9.8125, width: 54, height: 30 });
const OUTLINE_COLOR = Object.freeze([255, 255, 255, 255]);
const BACKGROUND = Object.freeze([0, 0, 0, 255]);
const REGION_IDS = ["top", "topRight", "right", "bottomRight", "bottom", "bottomLeft", "left", "topLeft"];
const EXPECTED_CORE_REGION_COUNTS = Object.freeze({
  top: 32,
  topRight: 12,
  right: 16,
  bottomRight: 15,
  bottom: 32,
  bottomLeft: 15,
  left: 16,
  topLeft: 12,
});
const OUTLINE_DISTANCE = 4;
const RADIUS = 11;
const GEOMETRY_EPSILON = 1e-9;

function appendPixelCenterSpan(spans, y, region, leftCenter, rightCenter) {
  const first = Math.ceil(leftCenter - 0.5 - GEOMETRY_EPSILON);
  const last = Math.floor(rightCenter - 0.5 + GEOMETRY_EPSILON);
  if (first <= last) spans.push({ y, region, first, last });
}

function appendCircularRowSpan(spans, y, py, { id, x, y: centerY, side, vertical }, radius, tolerance) {
  if ((vertical === "top" && py >= centerY) || (vertical === "bottom" && py <= centerY)) return;
  const dy = Math.abs(py - centerY);
  const innerRadius = radius + OUTLINE_DISTANCE - tolerance;
  const outerRadius = radius + OUTLINE_DISTANCE + tolerance;
  if (dy > outerRadius + GEOMETRY_EPSILON) return;
  const outerX = Math.sqrt(Math.max(0, outerRadius ** 2 - dy ** 2));
  const innerX = dy >= innerRadius ? 0 : Math.sqrt(innerRadius ** 2 - dy ** 2);
  if (side === "left") {
    appendPixelCenterSpan(spans, y, id, x - outerX, Math.min(x - innerX, x - GEOMETRY_EPSILON));
  } else {
    appendPixelCenterSpan(spans, y, id, Math.max(x + innerX, x + GEOMETRY_EPSILON), x + outerX);
  }
}

// Independent row-span oracle: intersect straight offset bands and quarter-circle annuli with each pixel-center row.
function outlineRowSpans(height, rect) {
  const radius = RADIUS;
  const edgeTolerance = 0.5;
  const cornerTolerance = 1 - Math.SQRT1_2;
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  const leftCenter = left + radius;
  const rightCenter = right - radius;
  const topCenter = top + radius;
  const bottomCenter = bottom - radius;
  const corners = [
    { id: "topLeft", x: leftCenter, y: topCenter, side: "left", vertical: "top" },
    { id: "topRight", x: rightCenter, y: topCenter, side: "right", vertical: "top" },
    { id: "bottomRight", x: rightCenter, y: bottomCenter, side: "right", vertical: "bottom" },
    { id: "bottomLeft", x: leftCenter, y: bottomCenter, side: "left", vertical: "bottom" },
  ];
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const py = y + 0.5;
    const spans = [];
    if (py < topCenter && Math.abs(top - py - OUTLINE_DISTANCE) <= edgeTolerance + GEOMETRY_EPSILON) {
      appendPixelCenterSpan(spans, y, "top", leftCenter, rightCenter);
    }
    if (py > bottomCenter && Math.abs(py - bottom - OUTLINE_DISTANCE) <= edgeTolerance + GEOMETRY_EPSILON) {
      appendPixelCenterSpan(spans, y, "bottom", leftCenter, rightCenter);
    }
    if (py >= topCenter && py <= bottomCenter) {
      appendPixelCenterSpan(
        spans,
        y,
        "left",
        left - OUTLINE_DISTANCE - edgeTolerance,
        left - OUTLINE_DISTANCE + edgeTolerance,
      );
      appendPixelCenterSpan(
        spans,
        y,
        "right",
        right + OUTLINE_DISTANCE - edgeTolerance,
        right + OUTLINE_DISTANCE + edgeTolerance,
      );
    }
    for (const corner of corners) appendCircularRowSpan(spans, y, py, corner, radius, cornerTolerance);
    rows.push(spans);
  }
  return rows;
}

function expandRowSpans(rows) {
  const pixels = [];
  for (const spans of rows) {
    for (const { y, region, first, last } of spans) {
      for (let x = first; x <= last; x += 1) pixels.push({ x, y, region });
    }
  }
  return pixels;
}

function writePixel(buffer, width, x, y, rgba) {
  buffer.set(rgba, (y * width + x) * 4);
}

function makeFixture({
  width = WIDTH,
  height = HEIGHT,
  rect = RECT,
  color = OUTLINE_COLOR,
  background = BACKGROUND,
} = {}) {
  const length = width * height * 4;
  const focused = new Uint8ClampedArray(length);
  for (let offset = 0; offset < length; offset += 4) {
    focused.set(background, offset);
  }

  const corePixels = expandRowSpans(outlineRowSpans(height, rect));
  for (const { x, y } of corePixels) {
    writePixel(focused, width, x, y, color);
  }
  const input = {
    width,
    height,
    focused,
    rect: { ...rect },
    outline: { width: 2, offset: 3, radius: 11, color: [...color] },
  };
  return { input, corePixels };
}

function srgb8(rgba) {
  return rgba.slice(0, 3).map((channel) => channel / 255);
}

test("A58 adjacent: 输入验证与支持边界", () => {
  const input = makeFixture().input;
  assert.throws(() => analyzeFocusOutlineAdjacentPixels(null), TypeError);
  assert.throws(() => analyzeFocusOutlineAdjacentPixels({ ...input, width: Number.NaN }), TypeError);
  assert.throws(() => analyzeFocusOutlineAdjacentPixels({ ...input, focused: new Uint8Array(4) }), TypeError);
  assert.throws(() => analyzeFocusOutlineAdjacentPixels({ ...input, rect: { ...input.rect, width: 0 } }), TypeError);
  assert.throws(
    () =>
      analyzeFocusOutlineAdjacentPixels({
        ...input,
        rect: { x: 0, y: 0, width: 20, height: 20 },
        outline: { ...input.outline, radius: 11 },
      }),
    TypeError,
  );

  for (const [change, reason] of [
    [{ width: 3 }, "unsupported-outline-width"],
    [{ offset: 2 }, "unsupported-outline-offset"],
    [{ radius: 10 }, "unsupported-outline-radius"],
    [{ color: [255, 255, 255, 254] }, "unsupported-outline-alpha"],
  ]) {
    const result = analyzeFocusOutlineAdjacentPixels({
      ...input,
      outline: { ...input.outline, ...change },
    });
    assert.equal(result.result, "unmeasured");
    assert.equal(result.ratio, null);
    assert.equal(result.reason, reason);
  }

  const clipped = analyzeFocusOutlineAdjacentPixels({
    ...input,
    rect: { ...input.rect, x: 6 },
  });
  assert.equal(clipped.result, "unmeasured");
  assert.equal(clipped.reason, "clip-does-not-contain-adjacent-band");
});

test("A58 adjacent: AA 边缘不采样，d6..7 阴影作为真实外部背景", () => {
  const fixture = makeFixture();
  writePixel(fixture.input.focused, WIDTH, 36, 4, OUTLINE_COLOR);
  writePixel(fixture.input.focused, WIDTH, 36, 3, [20, 20, 20, 255]);

  const result = analyzeFocusOutlineAdjacentPixels(fixture.input);
  assert.equal(result.result, "pass");
  assert.equal(result.reason, "adjacent-background-pass");
  assert.equal(result.corePixelCount, 150);
  assert.ok(result.backgroundPixelCount > 100);
  assert.deepEqual(
    Object.fromEntries(REGION_IDS.map((id) => [id, result.regions[id].core])),
    EXPECTED_CORE_REGION_COUNTS,
  );
  assert.deepEqual(result.diagnostics.missingCoreRegions, []);
  assert.deepEqual(result.diagnostics.missingBackgroundRegions, []);
  assert.deepEqual(result.worstBackground.pixel, { x: 36, y: 3 });
  assert.deepEqual(result.worstBackground.background, [20, 20, 20, 255]);
  assert.deepEqual(result.regions.top.worstBackground.background, [20, 20, 20, 255]);
});

test("A58 adjacent: 单个圆角低对比不能被其他区域的高对比覆盖", () => {
  const fixture = makeFixture();
  writePixel(fixture.input.focused, WIDTH, 7, 8, [200, 200, 200, 255]);

  const result = analyzeFocusOutlineAdjacentPixels(fixture.input);
  assert.equal(result.result, "fail");
  assert.equal(result.reason, "background-contrast-below-threshold");
  assert.equal(result.worstBackground.region, "topLeft");
  assert.deepEqual(result.worstBackground.pixel, { x: 7, y: 8 });
  assert.deepEqual(result.worstBackground.background, [200, 200, 200, 255]);
  assert.ok(result.ratio < 3);
  assert.equal(result.ratio, result.regions.topLeft.minRatio);
  assert.ok(REGION_IDS.filter((id) => id !== "topLeft").every((id) => result.regions[id].minRatio >= 3));
});

test("A58 adjacent: core 单个字节污染即 unmeasured", () => {
  const fixture = makeFixture();
  const sample = fixture.corePixels[0];
  writePixel(fixture.input.focused, WIDTH, sample.x, sample.y, [254, 255, 255, 255]);

  const result = analyzeFocusOutlineAdjacentPixels(fixture.input);
  assert.equal(result.result, "unmeasured");
  assert.equal(result.ratio, null);
  assert.equal(result.reason, "core-outline-color-mismatch");
  assert.deepEqual(result.diagnostics.coreOutlineColor.firstMismatch.pixel, { x: sample.x, y: sample.y });
});

test("A58 adjacent: 缺区、截断与非 opaque 均拒测", async (t) => {
  await t.test("圆角缺区", () => {
    const circle = makeFixture({ width: 40, height: 40, rect: { x: 9, y: 9, width: 22, height: 22 } });
    const result = analyzeFocusOutlineAdjacentPixels(circle.input);
    assert.equal(result.result, "unmeasured");
    assert.ok(result.diagnostics.missingCoreRegions.length > 0);
    assert.ok(result.diagnostics.missingBackgroundRegions.length > 0);
  });

  await t.test("clip 截断", () => {
    const fixture = makeFixture();
    const result = analyzeFocusOutlineAdjacentPixels({
      ...fixture.input,
      rect: { ...fixture.input.rect, x: 6 },
    });
    assert.equal(result.result, "unmeasured");
    assert.equal(result.reason, "clip-does-not-contain-adjacent-band");
    assert.equal(result.diagnostics.clip.complete, false);
  });

  await t.test("外部背景非 opaque", () => {
    const fixture = makeFixture();
    const offset = (3 * WIDTH + 36) * 4 + 3;
    fixture.input.focused[offset] = 254;
    const result = analyzeFocusOutlineAdjacentPixels(fixture.input);
    assert.equal(result.result, "unmeasured");
    assert.equal(result.ratio, null);
    assert.equal(result.reason, "adjacent-background-not-opaque");
    assert.deepEqual(result.diagnostics.backgroundAlpha.firstNonOpaque, {
      pixel: { x: 36, y: 3 },
      alpha: 254,
    });
  });
});

test("A58 adjacent: 2.990... 不得舍入为 3:1", () => {
  const fixture = makeFixture({ color: [90, 90, 90, 255] });
  writePixel(fixture.input.focused, WIDTH, 36, 3, [3, 3, 3, 255]);
  const knownRatio = contrastRatio(srgb8([90, 90, 90, 255]), srgb8([3, 3, 3, 255]));
  assert.ok(Math.abs(knownRatio - 2.9903750899186705) < 1e-12);
  assert.equal(Math.round(knownRatio), 3);

  const result = analyzeFocusOutlineAdjacentPixels(fixture.input);
  assert.equal(result.result, "fail");
  assert.equal(result.reason, "background-contrast-below-threshold");
  assert.equal(result.ratio, knownRatio);
  assert.deepEqual(result.worstBackground.pixel, { x: 36, y: 3 });
});
