import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeDetailBarPixels,
  planDetailBarCenterStrip,
  validateDetailBarClipInsideShapes,
} from "../scripts/skin-palette/detail-bar-pixels.mjs";

const WIDTH = 6;

function plan(fillRect, visibleRect, radius) {
  return planDetailBarCenterStrip({ fillRect, visibleRect, radius });
}

function rectInsideRoundedFill(fill, radius, clip) {
  const top = clip.y - fill.y;
  const bottom = top + clip.height;
  const left = clip.x - fill.x;
  const right = left + clip.width;
  const corners = [
    [left, top],
    [right - 1, top],
    [left, bottom - 1],
    [right - 1, bottom - 1],
  ];
  for (const [x, y] of corners) {
    const dx = Math.min(x - 0, fill.width - 1 - x);
    const dy = Math.min(y - 0, fill.height - 1 - y);
    if (dx < radius - 0.5 || dy < radius - 0.5) {
      const innerX = Math.max(0, radius - 0.5 - dx);
      const innerY = Math.max(0, radius - 0.5 - dy);
      if (Math.hypot(innerX, innerY) > radius - 0.5) return false;
    }
  }
  return true;
}

function assertIntegralClip(clip) {
  for (const key of ["x", "y", "width"]) {
    assert.equal(Number.isInteger(clip[key]), true, `${key} 必须是整数（收到 ${clip[key]}）`);
  }
  assert.equal(clip.height, 1);
  assert.equal(clip.width > 0, true);
}

function strip(width, fill) {
  const pixels = new Array(width * 4);
  for (let x = 0; x < width; x += 1) {
    const [r, g, b, a] = fill(x);
    const base = x * 4;
    pixels[base] = r;
    pixels[base + 1] = g;
    pixels[base + 2] = b;
    pixels[base + 3] = a;
  }
  return { width, height: 1, pixels };
}

function opaqueStrip(width, color) {
  return strip(width, () => [color[0], color[1], color[2], 255]);
}

function analyze(foreground, background) {
  return analyzeDetailBarPixels({ foreground, background });
}

test("黑 21 / 白 21：完全相反的两端给出 21", () => {
  const result = analyze(opaqueStrip(WIDTH, [0, 0, 0]), opaqueStrip(WIDTH, [255, 255, 255]));
  assert.equal(result.status, "measured");
  assert.equal(result.sampleCount, WIDTH);
  assert.equal(result.worstRatio, 21);
  assert.equal(result.worst.x, 0);
  assert.equal(result.worst.y, 0);
});

test("单个低对比点主导最差值，而非平均值", () => {
  const foreground = opaqueStrip(WIDTH, [0, 0, 0]);
  // 5 个点是 21:1，只有 x=3 接近中灰；最差必须落在该点。
  const background = strip(WIDTH, (x) => (x === 3 ? [117, 117, 117, 255] : [255, 255, 255, 255]));
  const result = analyze(foreground, background);
  assert.equal(result.status, "measured");
  assert.equal(result.worst.x, 3);
  assert.equal(result.worstRatio < 21, true);
  assert.equal(result.worst.ratio, result.worstRatio);
  assert.deepEqual(result.worst.background, [117, 117, 117, 255]);
  assert.deepEqual(result.worst.foreground, [0, 0, 0, 255]);
});

test("相同颜色比值为 1", () => {
  const result = analyze(opaqueStrip(WIDTH, [37, 99, 176]), opaqueStrip(WIDTH, [37, 99, 176]));
  assert.equal(result.status, "measured");
  assert.equal(result.worstRatio, 1);
});

test("任一像素 alpha 不足 255 就整条拒绝", () => {
  const foreground = strip(WIDTH, (x) => (x === 2 ? [10, 20, 30, 254] : [10, 20, 30, 255]));
  const result = analyze(foreground, opaqueStrip(WIDTH, [255, 255, 255]));
  assert.equal(result.status, "unmeasured");
  assert.equal(result.sampleCount, 0);
  assert.equal(result.worstRatio, null);
  assert.equal(result.worst, null);
  assert.match(result.reason, /foreground 在 x=2 的 alpha 为 254/);

  const background = strip(WIDTH, (x) => (x === 4 ? [200, 200, 200, 0] : [200, 200, 200, 255]));
  const backResult = analyze(opaqueStrip(WIDTH, [0, 0, 0]), background);
  assert.equal(backResult.status, "unmeasured");
  assert.match(backResult.reason, /background 在 x=4 的 alpha 为 0/);
});

test("维度/长度/非有限/越界字节违约抛 TypeError", () => {
  const white = opaqueStrip(WIDTH, [255, 255, 255]);
  const black = opaqueStrip(WIDTH, [0, 0, 0]);
  assert.throws(() => analyze({ ...white, height: 2 }, black), TypeError);
  assert.throws(() => analyze({ ...white, height: 0 }, black), TypeError);
  assert.throws(() => analyze(white, opaqueStrip(WIDTH + 1, [0, 0, 0])), TypeError);
  assert.throws(() => analyze({ width: WIDTH, height: 1, pixels: new Array(WIDTH * 4 - 1) }, black), TypeError);
  const nonFinite = opaqueStrip(WIDTH, [0, 0, 0]);
  nonFinite.pixels[3] = Number.NaN;
  assert.throws(() => analyze(nonFinite, black), TypeError);
  const outOfRange = opaqueStrip(WIDTH, [0, 0, 0]);
  outOfRange.pixels[5] = 256;
  assert.throws(() => analyze(outOfRange, black), TypeError);
  assert.throws(() => analyze({ width: 0, height: 1, pixels: [] }, black), TypeError);
  assert.throws(() => analyze({ width: 1.5, height: 1, pixels: new Array(4) }, black), TypeError);
  assert.throws(() => analyze({ width: WIDTH, height: 1, pixels: {} }, black), TypeError);
  assert.throws(() => analyze("not-an-object", black), TypeError);
});

test("原输入不被修改，且最差坐标与原 RGBA 正确", () => {
  const foregroundPixels = [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255];
  const backgroundPixels = [255, 255, 255, 255, 120, 120, 120, 255, 255, 255, 255, 255];
  const foreground = { width: 3, height: 1, pixels: foregroundPixels };
  const background = { width: 3, height: 1, pixels: backgroundPixels };
  const foregroundCopy = [...foregroundPixels];
  const backgroundCopy = [...backgroundPixels];

  const result = analyze(foreground, background);
  assert.equal(result.status, "measured");
  assert.equal(result.sampleCount, 3);
  assert.equal(result.worst.x, 1);
  assert.equal(result.worst.y, 0);
  assert.deepEqual(result.worst.foreground, [0, 0, 0, 255]);
  assert.deepEqual(result.worst.background, [120, 120, 120, 255]);
  assert.deepEqual(foregroundPixels, foregroundCopy);
  assert.deepEqual(backgroundPixels, backgroundCopy);
});

// --- C3: 中心采样带几何规划 --------------------------------------------------

test("长横条与短竖胶囊都拿到居中的 1px 采样带", () => {
  const visible = { x: 0, y: 0, width: 400, height: 300 };
  const wide = plan({ x: 10, y: 20, width: 200, height: 10 }, visible, 5);
  assert.equal(wide.status, "measured");
  assertIntegralClip(wide.sampleClip);
  assert.equal(wide.sampleClip.y, 25);
  assert.equal(wide.sampleClip.x, 12);
  assert.equal(wide.sampleClip.width, 196);
  assert.equal(rectInsideRoundedFill({ x: 10, y: 20, width: 200, height: 10 }, 5, wide.sampleClip), true);

  // 竖胶囊（高 > 宽）：圆角上限是 width/2，中心 1px 带只剩 4 列可用。
  const tall = plan({ x: 10, y: 20, width: 6, height: 40 }, visible, 3);
  assert.equal(tall.status, "measured");
  assertIntegralClip(tall.sampleClip);
  assert.equal(tall.sampleClip.x, 11);
  assert.equal(tall.sampleClip.width, 4);
  assert.equal(tall.sampleClip.y, 40);
  assert.equal(rectInsideRoundedFill({ x: 10, y: 20, width: 6, height: 40 }, 3, tall.sampleClip), true);
});

test("最短 2% 窄条仍可规划，而不是被 w-2r 一律拒绝", () => {
  const visible = { x: 0, y: 0, width: 400, height: 300 };
  const narrow = plan({ x: 10, y: 20, width: 5, height: 10 }, visible, 2.5);
  assert.equal(narrow.status, "measured");
  assertIntegralClip(narrow.sampleClip);
  assert.equal(narrow.sampleClip.x, 11);
  assert.equal(narrow.sampleClip.width, 3);
  assert.equal(rectInsideRoundedFill({ x: 10, y: 20, width: 5, height: 10 }, 2.5, narrow.sampleClip), true);
});

test("非整数几何按整像素边界取整，且仍落在 fill 内", () => {
  const visible = { x: 0, y: 0, width: 400, height: 300 };
  const fill = { x: 10.5, y: 20.25, width: 200.5, height: 10.5 };
  const result = plan(fill, visible, 5);
  assert.equal(result.status, "measured");
  assertIntegralClip(result.sampleClip);
  assert.equal(result.sampleClip.y, 25);
  assert.equal(result.sampleClip.x, 12);
  assert.equal(result.sampleClip.width, 197);
  assert.equal(rectInsideRoundedFill(fill, 5, result.sampleClip), true);
  assert.equal(result.sampleClip.x >= fill.x, true);
  assert.equal(result.sampleClip.x + result.sampleClip.width <= fill.x + fill.width, true);
  assert.equal(result.sampleClip.y >= fill.y, true);
  assert.equal(result.sampleClip.y + 1 <= fill.y + fill.height, true);
});

test("fill 未完整落入 visibleRect 时明确拒绝", () => {
  const clipped = plan({ x: 10, y: 20, width: 200, height: 10 }, { x: 12, y: 20, width: 180, height: 10 }, 5);
  assert.equal(clipped.status, "unmeasured");
  assert.match(clipped.reason, /fill 未完整落入 visibleRect/);
  assert.equal(clipped.sampleClip, undefined);
});

test("太小没有安全像素时明确拒绝", () => {
  const visible = { x: 0, y: 0, width: 400, height: 300 };
  const tiny = plan({ x: 10, y: 20, width: 2, height: 10 }, visible, 1);
  assert.equal(tiny.status, "unmeasured");
  assert.match(tiny.reason, /没有可用的整 CSS 像素中心条/);
});

test("非法半径与维度抛 TypeError", () => {
  const visible = { x: 0, y: 0, width: 400, height: 300 };
  assert.throws(() => plan({ x: 10, y: 20, width: 200, height: 10 }, visible, -1), TypeError);
  assert.throws(() => plan({ x: 10, y: 20, width: 200, height: 10 }, visible, 5.001), TypeError);
  assert.throws(() => plan({ x: 10, y: 20, width: 5, height: 10 }, visible, 3), TypeError);
  assert.throws(() => plan({ x: 10, y: 20, width: 200, height: 10 }, visible, Number.NaN), TypeError);
  assert.throws(() => plan({ x: 10, y: 20, width: 0, height: 10 }, visible, 0), TypeError);
  assert.throws(() => plan({ x: 10, y: 20, width: 200, height: -1 }, visible, 0), TypeError);
  assert.throws(
    () => plan({ x: 10, y: 20, width: 200, height: 10 }, { x: 0, y: 0, width: 0, height: 5 }, 5),
    TypeError,
  );
  assert.throws(() => plan({ x: 10, y: 20, width: 200 }, visible, 5), TypeError);
  assert.throws(() => plan("not-a-rect", visible, 5), TypeError);
});

test("几何输入不被修改", () => {
  const fill = { x: 10.5, y: 20.25, width: 200.5, height: 10.5 };
  const visible = { x: 0, y: 0, width: 400, height: 300 };
  const fillCopy = { ...fill };
  const visibleCopy = { ...visible };
  const result = plan(fill, visible, 5);
  assert.equal(result.status, "measured");
  assert.deepEqual(fill, fillCopy);
  assert.deepEqual(visible, visibleCopy);
});

// --- C3 边界修正回归（主管实调五例）-----------------------------------------

test("高度不足 1px 时不得返回高度 1 的采样带", () => {
  const fill = { x: 0, y: 0, width: 10, height: 0.5 };
  const result = plan(fill, fill, 0);
  assert.equal(result.status, "unmeasured");
  assert.equal(result.sampleClip, undefined);
  assert.match(result.reason, /没有完整落入 fill 的整 CSS 像素行/);
});

test("非整数下边界必须整条落入 fill，不得超出底边", () => {
  const fill = { x: 0.2, y: 0.2, width: 10, height: 1.4 };
  const result = plan(fill, fill, 0);
  // fill 高度 1.4 只有 [1,2) 这一条完整落入的整数行，但其上端在圆角影响外、
  // 下端 2 ≤ 1.6 成立；这里真正要断言的是：返回的 clip 永不出底边。
  assert.equal(result.status, "unmeasured");
  assert.match(result.reason, /没有完整落入 fill 的整 CSS 像素行/);
  assert.equal(result.sampleClip, undefined);
});

test("两端各 1px 内缩不因窄条减小", () => {
  const fill = { x: 0, y: 0, width: 1, height: 10 };
  const result = plan(fill, fill, 0);
  // width 1 减去两端各 1 后无内区，必须拒绝而不是返回 width 1。
  assert.equal(result.status, "unmeasured");
  assert.match(result.reason, /没有可用的整 CSS 像素中心条/);
});

test("微小越界属于部分裁切，严格包含不用 epsilon 放宽", () => {
  const fill = { x: -1e-10, y: 0, width: 10, height: 10 };
  const visible = { x: 0, y: 0, width: 10, height: 10 };
  const result = plan(fill, visible, 0);
  assert.equal(result.status, "unmeasured");
  assert.match(result.reason, /fill 未完整落入 visibleRect/);
});

test("超过 min(w,h)/2 的半径不得被 epsilon 或 clamp 接受", () => {
  const fill = { x: 0, y: 0, width: 10, height: 10 };
  assert.throws(() => plan(fill, fill, 5 + 5e-10), TypeError);
  assert.throws(() => plan(fill, fill, 5 + 1e-3), TypeError);
  assert.throws(() => plan(fill, fill, Number.POSITIVE_INFINITY), TypeError);
  // 恰好等于上限仍合法。
  const exact = plan(fill, fill, 5);
  assert.equal(exact.status, "measured");
  assert.equal(exact.sampleClip.y, 5);
  assert.equal(exact.sampleClip.x, 2);
  assert.equal(exact.sampleClip.width, 6);
});

test("整条四角落入统一圆角形状，而非只验中心", () => {
  const visible = { x: 0, y: 0, width: 400, height: 300 };
  // 10×10、r=5 的正圆是极端情形：中心行 [5,6] 的上下端圆角切入最大。
  const circle = plan({ x: 0, y: 0, width: 10, height: 10 }, visible, 5);
  assert.equal(circle.status, "measured");
  assert.equal(circle.sampleClip.y, 5);
  assert.equal(circle.sampleClip.x, 2);
  assert.equal(circle.sampleClip.width, 6);
  assert.equal(rectInsideRoundedFill({ x: 0, y: 0, width: 10, height: 10 }, 5, circle.sampleClip), true);
});

test("fill/track/祖先三个内框同时满足才 measured", () => {
  const result = validateDetailBarClipInsideShapes({
    clip: { x: 10, y: 4, width: 20, height: 1 },
    shapes: [
      { rect: { x: 0, y: 0, width: 100, height: 10 }, radius: 5, source: "fill-inner" },
      { rect: { x: -2, y: -2, width: 104, height: 14 }, radius: 7, source: "track-inner" },
      { rect: { x: -10, y: -10, width: 130, height: 30 }, radius: 9, source: "ancestor-inner" },
    ],
  });
  assert.equal(result.status, "measured");
  assert.equal(result.shapeCount, 3);
  assert.deepEqual(result.sources, ["fill-inner", "track-inner", "ancestor-inner"]);
});

test("直边内但落在圆角外时 unmeasured", () => {
  const result = validateDetailBarClipInsideShapes({
    clip: { x: 0, y: 0, width: 2, height: 1 },
    shapes: [{ rect: { x: 0, y: 0, width: 20, height: 10 }, radius: 5, source: "fill-inner" }],
  });
  assert.equal(result.status, "unmeasured");
  assert.match(result.reason, /圆角/);
  assert.match(result.reason, /fill-inner/);
});

test("1e-10 越界不用 epsilon 放行", () => {
  const result = validateDetailBarClipInsideShapes({
    clip: { x: 10, y: 0, width: 2, height: 1 },
    shapes: [{ rect: { x: 10 + 1e-10, y: 0, width: 20, height: 10 }, radius: 0, source: "ancestor-inner" }],
  });
  assert.equal(result.status, "unmeasured");
  assert.match(result.reason, /超出内框/);
});

test("fractional uniform radius 按实际圆弧证明", () => {
  const result = validateDetailBarClipInsideShapes({
    clip: { x: 5, y: 4, width: 10, height: 1 },
    shapes: [{ rect: { x: 0, y: 0, width: 20, height: 20 }, radius: 5.6640625, source: "fractional-inner" }],
  });
  assert.equal(result.status, "measured");
});

test("无 shapes、坏数值、无来源与半像素 clip 明确失败", () => {
  const clip = { x: 0, y: 0, width: 2, height: 1 };
  const empty = validateDetailBarClipInsideShapes({ clip, shapes: [] });
  assert.equal(empty.status, "unmeasured");
  assert.equal(empty.shapeCount, 0);

  assert.throws(() => validateDetailBarClipInsideShapes({ clip, shapes: "not-array" }), TypeError);
  assert.throws(() => validateDetailBarClipInsideShapes({ clip: { ...clip, x: 0.5 }, shapes: [] }), TypeError);
  assert.throws(() => validateDetailBarClipInsideShapes({ clip: { ...clip, height: 2 }, shapes: [] }), TypeError);
  for (const shape of [
    { rect: { x: 0, y: 0, width: 0, height: 10 }, radius: 0, source: "bad-width" },
    { rect: { x: 0, y: 0, width: 20, height: 10 }, radius: -1, source: "negative-radius" },
    { rect: { x: 0, y: 0, width: 20, height: 10 }, radius: 5 + 1e-10, source: "over-radius" },
    { rect: { x: 0, y: 0, width: 20, height: 10 }, radius: Number.NaN, source: "nan-radius" },
    { rect: { x: 0, y: 0, width: 20, height: 10 }, radius: 0, source: "  " },
  ]) {
    assert.throws(() => validateDetailBarClipInsideShapes({ clip, shapes: [shape] }), TypeError);
  }
});

test("不同 shape 任一项失败即 unmeasured，并指出来源", () => {
  const result = validateDetailBarClipInsideShapes({
    clip: { x: 0, y: 0, width: 2, height: 1 },
    shapes: [
      { rect: { x: 0, y: 0, width: 20, height: 10 }, radius: 0, source: "fill-inner" },
      { rect: { x: -2, y: -2, width: 24, height: 14 }, radius: 0, source: "track-inner" },
      { rect: { x: 0, y: 0, width: 20, height: 10 }, radius: 5, source: "ancestor-inner" },
    ],
  });
  assert.equal(result.status, "unmeasured");
  assert.match(result.reason, /ancestor-inner/);
  assert.equal(result.shapeCount, 3);
});
