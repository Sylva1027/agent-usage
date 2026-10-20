import assert from "node:assert/strict";
import test from "node:test";

import { contrastRatio } from "../scripts/skin-palette/color-math.mjs";
import {
  analyzeFocusOutlineAdjacentPixels,
  analyzeFocusOutlinePixels,
} from "../scripts/skin-palette/focus-outline-pixels.mjs";

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
function outlineRowSpans(height, rect, kind) {
  const radius = RADIUS;
  const edgeTolerance = kind === "core" ? 0.5 : 1 + Math.SQRT1_2;
  const cornerTolerance = kind === "core" ? 1 - Math.SQRT1_2 : 1 + Math.SQRT1_2;
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

function countCoreRegions(pixels) {
  return Object.fromEntries(REGION_IDS.map((id) => [id, pixels.filter((pixel) => pixel.region === id).length]));
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
  const withoutOutline = new Uint8Array(length);
  const restored = new Uint8ClampedArray(length);
  for (let offset = 0; offset < length; offset += 4) {
    focused.set(background, offset);
    withoutOutline.set(background, offset);
    restored.set(background, offset);
  }

  const corePixels = expandRowSpans(outlineRowSpans(height, rect, "core"));
  const envelopePixels = expandRowSpans(outlineRowSpans(height, rect, "envelope"));
  for (const { x, y } of corePixels) {
    writePixel(focused, width, x, y, color);
    writePixel(restored, width, x, y, color);
  }
  const input = {
    width,
    height,
    focused,
    withoutOutline,
    restored,
    rect: { ...rect },
    outline: { width: 2, offset: 3, radius: 11, color: [...color] },
  };
  return { input, corePixels, envelopePixels, coreRegionCounts: countCoreRegions(corePixels) };
}

function cloneInput(input) {
  return {
    ...input,
    focused: new Uint8ClampedArray(input.focused),
    withoutOutline: new Uint8Array(input.withoutOutline),
    restored: new Uint8ClampedArray(input.restored),
    rect: { ...input.rect },
    outline: { ...input.outline, color: [...input.outline.color] },
  };
}

function srgb8(rgba) {
  return rgba.slice(0, 3).map((channel) => channel / 255);
}

test("D21-B1 输入验证与支持边界：非法形状抛错，不支持几何明确 unmeasured", () => {
  const fixture = makeFixture();
  const input = cloneInput(fixture.input);
  assert.throws(() => analyzeFocusOutlinePixels(null), TypeError);
  assert.throws(() => analyzeFocusOutlinePixels({ ...input, width: Number.NaN }), TypeError);
  assert.throws(() => analyzeFocusOutlinePixels({ ...input, focused: new Uint8Array(4) }), TypeError);
  assert.throws(
    () => analyzeFocusOutlinePixels({ ...input, focused: null, rect: null }),
    /focused 必须是 Uint8Array 或 Uint8ClampedArray/,
    "旧入口仍先校验三帧缓冲，再校验 geometry",
  );
  assert.throws(() => analyzeFocusOutlinePixels({ ...input, rect: { ...input.rect, width: 0 } }), TypeError);
  assert.throws(
    () =>
      analyzeFocusOutlinePixels({
        ...input,
        rect: { x: 0, y: 0, width: 20, height: 20 },
        outline: { ...input.outline, radius: 11 },
      }),
    TypeError,
    "radius 大于短边一半是非法几何，不得钳制",
  );

  for (const [change, reason] of [
    [{ width: 3 }, "unsupported-outline-width"],
    [{ offset: 2 }, "unsupported-outline-offset"],
    [{ radius: 10 }, "unsupported-outline-radius"],
    [{ color: [255, 255, 255, 254] }, "unsupported-outline-alpha"],
  ]) {
    const unsupported = cloneInput(input);
    unsupported.outline = { ...unsupported.outline, ...change };
    const result = analyzeFocusOutlinePixels(unsupported);
    assert.equal(result.result, "unmeasured");
    assert.equal(result.ratio, null);
    assert.equal(result.reason, reason);
  }
  const clipped = cloneInput(input);
  clipped.rect.x = 4;
  assert.equal(analyzeFocusOutlinePixels(clipped).reason, "clip-does-not-contain-envelope");
});

test("均匀黑底白色轮廓：完整圆角 core/envelope 通过并回报保守下界 21:1", () => {
  const fixture = makeFixture();
  const before = {
    focused: new Uint8ClampedArray(fixture.input.focused),
    withoutOutline: new Uint8Array(fixture.input.withoutOutline),
    restored: new Uint8ClampedArray(fixture.input.restored),
  };
  assert.equal(fixture.corePixels.length, 150, "独立参考 mask 的固定 core 总数");
  assert.equal(fixture.envelopePixels.length, 652, "独立参考 mask 的固定 envelope 总数");
  assert.deepEqual(fixture.coreRegionCounts, EXPECTED_CORE_REGION_COUNTS, "圆/直边行区间 oracle 的冻结区域数");
  const result = analyzeFocusOutlinePixels(fixture.input);
  const knownRatio = contrastRatio(srgb8(OUTLINE_COLOR), srgb8(BACKGROUND));
  assert.equal(knownRatio, 21);
  assert.equal(result.result, "pass");
  assert.equal(result.reason, "conservative-envelope-pass");
  assert.equal(result.ratio, 21);
  assert.equal(result.coreMinRatio, knownRatio);
  assert.equal(result.conservativeMinRatio, knownRatio);
  assert.equal(result.corePixelCount, 150);
  assert.equal(result.envelopePixelCount, 652);
  assert.deepEqual(
    Object.fromEntries(REGION_IDS.map((id) => [id, result.regions[id].core])),
    EXPECTED_CORE_REGION_COUNTS,
    "独立 row-span oracle 锁住区域归类，区域边界偏差不能静默通过",
  );
  assert.deepEqual(fixture.input.focused, before.focused, "analyzer 不改 focused 输入");
  assert.deepEqual(fixture.input.withoutOutline, before.withoutOutline, "analyzer 不改基线输入");
  assert.deepEqual(fixture.input.restored, before.restored, "analyzer 不改 restored 输入");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result, "返回值可 JSON 序列化");
});

test("只看轮廓 core：内部高对比填充不能掩盖低对比轮廓 fail", () => {
  const fixture = makeFixture({ color: [85, 85, 85, 255] });
  const centerX = Math.floor(fixture.input.rect.x + fixture.input.rect.width / 2);
  const centerY = Math.floor(fixture.input.rect.y + fixture.input.rect.height / 2);
  writePixel(fixture.input.focused, WIDTH, centerX, centerY, [255, 255, 255, 255]);
  const result = analyzeFocusOutlinePixels(fixture.input);
  const knownRatio = contrastRatio(srgb8([85, 85, 85, 255]), srgb8(BACKGROUND));
  assert.ok(knownRatio < 3);
  assert.equal(result.result, "fail");
  assert.equal(result.reason, "core-contrast-below-threshold");
  assert.equal(result.ratio, knownRatio);
  assert.ok(result.worstCore);
});

test("核心颜色逐字节匹配声明色：一字节灰度差不能被算作达标", () => {
  const fixture = makeFixture({ color: [90, 90, 90, 255] });
  const expectedRatio = contrastRatio(srgb8([90, 90, 90, 255]), srgb8(BACKGROUND));
  const actualRatio = contrastRatio(srgb8([89, 89, 89, 255]), srgb8(BACKGROUND));
  assert.ok(Math.abs(expectedRatio - 3.0448346617620263) < 1e-12);
  assert.ok(Math.abs(actualRatio - 2.9979745649422775) < 1e-12);
  assert.equal(analyzeFocusOutlinePixels(fixture.input).result, "pass");

  const sample = fixture.corePixels[0];
  for (const buffer of [fixture.input.focused, fixture.input.restored]) {
    writePixel(buffer, WIDTH, sample.x, sample.y, [89, 89, 89, 255]);
  }
  const result = analyzeFocusOutlinePixels(fixture.input);
  assert.equal(result.result, "unmeasured");
  assert.equal(result.ratio, null);
  assert.equal(result.reason, "core-outline-color-mismatch");
  assert.deepEqual(result.diagnostics.coreOutlineColor.firstMismatch.pixel, { x: sample.x, y: sample.y });
});

test("小数几何保留圆角有效像素：样本可在 border bounding rect 内、rounded fill 外", () => {
  const fixture = makeFixture();
  const corner = fixture.corePixels.find((pixel) => pixel.x === 9 && pixel.y === 10 && pixel.region === "topLeft");
  assert.ok(corner, "固定输入含左上圆角 core 像素");
  const center = { x: corner.x + 0.5, y: corner.y + 0.5 };
  assert.ok(center.x >= RECT.x && center.x <= RECT.x + RECT.width);
  assert.ok(center.y >= RECT.y && center.y <= RECT.y + RECT.height);
  const circleCenter = { x: RECT.x + RADIUS, y: RECT.y + RADIUS };
  const pixelCenter = { x: corner.x + 0.5, y: corner.y + 0.5 };
  assert.ok(
    Math.hypot(pixelCenter.x - circleCenter.x, pixelCenter.y - circleCenter.y) > RADIUS,
    "固定圆心距离证明像素在 rounded fill 外，不能整块排除 border rect",
  );
  const result = analyzeFocusOutlinePixels(fixture.input);
  assert.equal(result.result, "pass");
  assert.ok(result.regions.topLeft.core > 0);
  assert.ok(result.regions.bottomRight.core > 0);
});

test("角区缺测或 core 颜色不符时 unmeasured，不借直边结果补足", () => {
  const circle = makeFixture({ width: 40, height: 40, rect: { x: 9, y: 9, width: 22, height: 22 } });
  const missing = analyzeFocusOutlinePixels(circle.input);
  assert.equal(missing.result, "unmeasured");
  assert.equal(missing.reason, "core-region-missing");
  assert.ok(missing.diagnostics.missingCoreRegions.length > 0);
  assert.equal(missing.ratio, null);

  const fixture = makeFixture();
  for (const buffer of [fixture.input.focused, fixture.input.restored]) {
    writePixel(buffer, WIDTH, 9, 10, BACKGROUND);
  }
  const mismatch = analyzeFocusOutlinePixels(fixture.input);
  assert.equal(mismatch.result, "unmeasured");
  assert.equal(mismatch.reason, "core-outline-color-mismatch");
  assert.deepEqual(mismatch.diagnostics.coreOutlineColor.firstMismatch.pixel, { x: 9, y: 10 });
});

test("core 达标而 envelope 边界低于阈值时保留为 boundary-contrast-uncertain", () => {
  const fixture = makeFixture();
  const boundary = fixture.envelopePixels.find(
    ({ x, y }) => !fixture.corePixels.some((pixel) => pixel.x === x && pixel.y === y) && x === 30 && y === 4,
  );
  assert.ok(boundary, "固定 top-edge 像素属于 envelope 但不属于 core");
  writePixel(fixture.input.withoutOutline, WIDTH, boundary.x, boundary.y, OUTLINE_COLOR);
  const result = analyzeFocusOutlinePixels(fixture.input);
  assert.equal(result.coreMinRatio, 21);
  assert.equal(result.conservativeMinRatio, 1);
  assert.equal(result.result, "unmeasured");
  assert.equal(result.ratio, null);
  assert.equal(result.reason, "boundary-contrast-uncertain");
  assert.deepEqual(result.worstEnvelope.pixel, { x: boundary.x, y: boundary.y });
});

test("恢复、外区漂移与内部 caret 差异分开判定", async (t) => {
  await t.test("恢复态 rounded-shape 外任一字节不一致则 unmeasured", () => {
    const fixture = makeFixture();
    const restored = cloneInput(fixture.input);
    writePixel(restored.restored, WIDTH, 0, 0, [1, 0, 0, 255]);
    const result = analyzeFocusOutlinePixels(restored);
    assert.equal(result.reason, "restoration-outside-rounded-shape-mismatch");
    assert.equal(result.result, "unmeasured");
  });

  await t.test("focused 与无轮廓态在 envelope 外漂移则 unmeasured", () => {
    const fixture = makeFixture();
    const drift = cloneInput(fixture.input);
    for (const buffer of [drift.focused, drift.restored]) writePixel(buffer, WIDTH, 0, 0, [1, 0, 0, 255]);
    const result = analyzeFocusOutlinePixels(drift);
    assert.equal(result.reason, "focused-state-drift-outside-envelope");
    assert.equal(result.result, "unmeasured");
  });

  await t.test("rounded fill 内部 caret 像素变化不污染轮廓外围恢复检查", () => {
    const fixture = makeFixture();
    writePixel(fixture.input.focused, WIDTH, 35, 24, [255, 255, 255, 255]);
    const result = analyzeFocusOutlinePixels(fixture.input);
    assert.equal(result.result, "pass");
    assert.equal(result.diagnostics.restoreOutsideRoundedShape.mismatchPixels, 0);
  });
});

test("envelope 中 focused、基线或 restored 的 alpha 只要不是 255 就拒测", async (t) => {
  const fixture = makeFixture();
  const boundary = fixture.envelopePixels.find(({ x, y }) => x === 30 && y === 4);
  assert.ok(boundary, "固定边界样本在 envelope 内");
  assert.ok(!fixture.corePixels.some(({ x, y }) => x === boundary.x && y === boundary.y));

  await t.test("focused/restored 所有 core alpha 改为 254", () => {
    const input = cloneInput(fixture.input);
    for (const { x, y } of fixture.corePixels) {
      const alphaOffset = (y * WIDTH + x) * 4 + 3;
      input.focused[alphaOffset] = 254;
      input.restored[alphaOffset] = 254;
    }
    const result = analyzeFocusOutlinePixels(input);
    assert.equal(result.result, "unmeasured");
    assert.equal(result.reason, "envelope-pixel-not-opaque");
    assert.equal(result.ratio, null);
    assert.equal(result.diagnostics.envelopeAlpha.channels.focused, fixture.corePixels.length);
    assert.equal(result.diagnostics.envelopeAlpha.channels.restored, fixture.corePixels.length);
  });

  for (const name of ["focused", "withoutOutline", "restored"]) {
    await t.test(name, () => {
      const input = cloneInput(fixture.input);
      input[name][(boundary.y * WIDTH + boundary.x) * 4 + 3] = 254;
      const result = analyzeFocusOutlinePixels(input);
      assert.equal(result.result, "unmeasured");
      assert.equal(result.reason, "envelope-pixel-not-opaque");
      assert.equal(result.ratio, null);
      assert.equal(result.diagnostics.envelopeAlpha.nonOpaquePixels, 1);
      assert.equal(result.diagnostics.envelopeAlpha.channels[name], 1);
    });
  }
});

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
