import { contrastRatio } from "./color-math.mjs";

/**
 * Detail bar 填色 vs 隐藏背景的逐点像素比较（M5.2.P-C2）。
 *
 * 纯数值组件：不读 PNG、不截图、不做 IO、不访问 DOM，只比较两条已对齐的
 * 采样带。PASS/FAIL 判定与阈值不在这里——调用方按角色阈值自行解释比值。
 *
 * shortcut: 只接受 height === 1 的 CSS 中心采样条，即已证明落在 fill 内的一条。
 * 它不代表整圆角端点、轨道边界或条上所有位置；要扩大适用范围必须先由浏览器
 * 入口校准几何与身份，再改这里的前提。
 */

function isPixelBuffer(value) {
  return Array.isArray(value) || value instanceof Uint8Array || value instanceof Uint8ClampedArray;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 读取一条采样带：width 正整数、height 恒为 1、像素长度恰 4×width、通道为 0..255 整数。 */
function readStrip(input, name) {
  if (!isRecord(input)) throw new TypeError(`${name} 必须是 { width, height, pixels } 对象`);
  const { width, height, pixels } = input;
  if (!Number.isSafeInteger(width) || width <= 0) {
    throw new TypeError(`${name}.width 必须是正安全整数（收到 ${String(width)}）`);
  }
  if (height !== 1) {
    throw new TypeError(`${name}.height 必须为 1：本组件只接受同尺寸 CSS 中心采样条（收到 ${String(height)}）`);
  }
  if (!isPixelBuffer(pixels)) {
    throw new TypeError(`${name}.pixels 必须是像素数组（Array / Uint8Array / Uint8ClampedArray）`);
  }
  const expectedLength = width * 4;
  if (pixels.length !== expectedLength) {
    throw new TypeError(`${name}.pixels 长度必须为 width × 4（收到 ${pixels.length}，期望 ${expectedLength}）`);
  }
  for (let index = 0; index < pixels.length; index += 1) {
    const channel = pixels[index];
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) {
      throw new TypeError(`${name}.pixels[${index}] 必须是 0..255 的整数（收到 ${String(channel)}）`);
    }
  }
  return { width, pixels };
}

function pixelAt(pixels, x) {
  const base = x * 4;
  return [pixels[base], pixels[base + 1], pixels[base + 2], pixels[base + 3]];
}

function rgbOf(rgba) {
  return [rgba[0] / 255, rgba[1] / 255, rgba[2] / 255];
}

function unmeasured(reason) {
  return { status: "unmeasured", reason, sampleCount: 0, worstRatio: null, worst: null };
}

/**
 * 逐点比较同一 x 上的前景（fill）与背景（隐藏 fill 后）实际 RGB。
 * 任一像素 alpha 不足 255 时整条拒绝：不能跳过坏点给剩余区域发结论。
 */
export function analyzeDetailBarPixels(input) {
  if (!isRecord(input)) throw new TypeError("input 必须是 { foreground, background } 对象");
  const { foreground, background } = input;
  const front = readStrip(foreground, "foreground");
  const back = readStrip(background, "background");
  if (front.width !== back.width) {
    throw new TypeError(`foreground 与 background 的 width 必须一致（收到 ${front.width} 与 ${back.width}）`);
  }

  for (const [name, strip] of [
    ["foreground", front],
    ["background", back],
  ]) {
    for (let x = 0; x < strip.width; x += 1) {
      const rgba = pixelAt(strip.pixels, x);
      if (rgba[3] !== 255) {
        return unmeasured(`${name} 在 x=${x} 的 alpha 为 ${rgba[3]}，不是 255：整条拒绝，不跳过该点继续比较`);
      }
    }
  }

  let worst = null;
  for (let x = 0; x < front.width; x += 1) {
    const frontRgba = pixelAt(front.pixels, x);
    const backRgba = pixelAt(back.pixels, x);
    const ratio = contrastRatio(rgbOf(frontRgba), rgbOf(backRgba));
    if (!worst || ratio < worst.ratio) {
      worst = {
        ratio,
        x,
        y: 0,
        foreground: frontRgba,
        background: backRgba,
      };
    }
  }

  return {
    status: "measured",
    reason: "",
    sampleCount: front.width,
    worstRatio: worst ? worst.ratio : null,
    worst,
  };
}

// --- C3: 中心采样带几何规划 --------------------------------------------------

const ENDPOINT_INSET = 1;

function requireFiniteNumber(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${name} 必须是有限数值（收到 ${String(value)}）`);
  }
  return value;
}

function readGeometryRect(input, name) {
  if (!isRecord(input)) throw new TypeError(`${name} 必须是 { x, y, width, height } 对象`);
  const rect = {
    x: requireFiniteNumber(input.x, `${name}.x`),
    y: requireFiniteNumber(input.y, `${name}.y`),
    width: requireFiniteNumber(input.width, `${name}.width`),
    height: requireFiniteNumber(input.height, `${name}.height`),
  };
  if (!(rect.width > 0) || !(rect.height > 0)) {
    throw new TypeError(`${name} 必须有正面积（收到 width=${rect.width}, height=${rect.height}）`);
  }
  return rect;
}

/**
 * 均匀圆角矩形在局部垂直坐标 u 处，左侧（右侧同样）被圆角切掉的水平量。
 * 中间区域为 0，两侧单调递增，所以任一竖带的最大切入必在带的某个端点取得。
 */
function cornerInsetAt(u, height, radius) {
  if (!(radius > 0)) return 0;
  if (u >= radius && u <= height - radius) return 0;
  const delta = u < radius ? radius - u : u - (height - radius);
  return radius - Math.sqrt(Math.max(0, radius * radius - delta * delta));
}

/**
 * 1px 采样带的整像素范围：带上边界 u0、下边界 u1，四角都在圆角形状内。
 * 圆角切入量只可能在带的顶/底端最大，所以这里只检查两个端点（见 cornerInsetAt）。
 */
function bandSpan(u0, u1, width, height, radius, inset) {
  const insetAt = Math.max(cornerInsetAt(u0, height, radius), cornerInsetAt(u1, height, radius));
  const left = inset + insetAt;
  const right = width - inset - insetAt;
  return { left, right };
}

/**
 * 规划 detail bar 的中心 1 CSS 像素采样带（M5.2.P-C3）。
 *
 * 只产几何方案：不采样、不截图、不判 PASS，不读 DOM / CSS / IO。
 * shortcut: dpr = 1 的 CSS 像素约定；圆角按单一均匀半径建模；真实浏览器入口
 * 必须先证明 fillRect/visibleRect/radius 的来源与身份，本函数才能被信任。
 */
export function planDetailBarCenterStrip(input) {
  if (!isRecord(input)) throw new TypeError("input 必须是 { fillRect, visibleRect, radius } 对象");
  const { fillRect, visibleRect, radius } = input;
  const fill = readGeometryRect(fillRect, "fillRect");
  const visible = readGeometryRect(visibleRect, "visibleRect");
  const r = requireFiniteNumber(radius, "radius");
  const radiusLimit = Math.min(fill.width, fill.height) / 2;
  if (r < 0 || r > radiusLimit) {
    throw new TypeError(`radius 必须落在 [0, min(width, height)/2] = [0, ${radiusLimit}]（收到 ${r}）`);
  }

  const visibleLeft = visible.x;
  const visibleRight = visible.x + visible.width;
  const fillLeft = fill.x;
  const fillRight = fill.x + fill.width;
  const fillTop = fill.y;
  const fillBottom = fill.y + fill.height;

  // fill 必须完整落入 visibleRect：任一边越界即拒绝，不扩大到别的行或别的裁切。
  if (
    fillLeft < visibleLeft ||
    fillRight > visibleRight ||
    fillTop < visible.y ||
    fillBottom > visible.y + visible.height
  ) {
    return unmeasured(
      `fill 未完整落入 visibleRect：fill=[${fillLeft}, ${fillTop}, ${fillRight}, ${fillBottom}] visible=[${visibleLeft}, ${visible.y}, ${visibleRight}, ${visible.y + visible.height}]`,
    );
  }

  // 合法整数行：整条 [row, row+1] 必须完整落在 fill 内；fill 已在 visible 内，故同时满足 visible。
  const firstRow = Math.ceil(fillTop);
  const lastRow = Math.floor(fillBottom) - 1;
  if (firstRow > lastRow) {
    return unmeasured(`没有完整落入 fill 的整 CSS 像素行：fill=[${fillLeft}, ${fillTop}, ${fillRight}, ${fillBottom}]`);
  }
  const centerRow = Math.round(fill.y + fill.height / 2 - 0.5);
  const row = Math.min(Math.max(centerRow, firstRow), lastRow);
  const bandTop = row - fillTop;

  // 两端各 1 CSS 像素内缩不因窄条减小；圆角切入按整条 1px 带的上下端取最大。
  const span = bandSpan(bandTop, bandTop + 1, fill.width, fill.height, r, ENDPOINT_INSET);
  if (span.right <= span.left) {
    return unmeasured(
      `没有可用的整 CSS 像素中心条：fill=[${fillLeft}, ${fillTop}, ${fill.width}, ${fill.height}] radius=${r}`,
    );
  }
  const clip = {
    x: Math.ceil(fillLeft + span.left),
    y: row,
    width: Math.floor(fillLeft + span.right) - Math.ceil(fillLeft + span.left),
    height: 1,
  };
  if (clip.width <= 0) {
    return unmeasured(
      `没有可用的整 CSS 像素中心条：fill=[${fillLeft}, ${fillTop}, ${fill.width}, ${fill.height}] radius=${r}`,
    );
  }
  if (
    clip.x < fillLeft ||
    clip.x + clip.width > fillRight ||
    clip.y < visible.y ||
    clip.y + 1 > visible.y + visible.height
  ) {
    return unmeasured(
      `中心条未完整落入 fill/visibleRect：clip=[${clip.x}, ${clip.y}, ${clip.x + clip.width}, ${clip.y + 1}] fill=[${fillLeft}, ${fillTop}, ${fillRight}, ${fillBottom}] visible=[${visibleLeft}, ${visible.y}, ${visibleRight}, ${visible.y + visible.height}]`,
    );
  }
  // 整条四角都必须落在支持的统一圆角形状内，不能只验中心。
  const localLeft = clip.x - fillLeft;
  const localRight = clip.x + clip.width - fillLeft;
  for (const px of [localLeft, localRight]) {
    for (const py of [bandTop, bandTop + 1]) {
      if (!cornerInsideRoundedRect(px, py, fill.width, fill.height, r)) {
        return unmeasured(
          `中心条四角未落入圆角形状：local=(${px}, ${py}) fill=${fill.width}×${fill.height} radius=${r}`,
        );
      }
    }
  }
  return { status: "measured", reason: "", sampleClip: clip };
}

/**
 * fill 局部坐标下的点是否落在统一圆角矩形内：直线段带内直接成立，
 * 否则必须落在对应圆角弧心半径内。与 cornerInsetAt 的算式互为独立验算。
 */
function cornerInsideRoundedRect(px, py, width, height, radius) {
  if (px >= radius && px <= width - radius) return true;
  if (py >= radius && py <= height - radius) return true;
  const cx = px < radius ? radius : width - radius;
  const cy = py < radius ? radius : height - radius;
  return Math.hypot(px - cx, py - cy) <= radius;
}

/**
 * 证明一条整数 1px 高一整行采样条位于每个调用方已归一化的圆角内框内。
 *
 * 只做几何包含：不读 DOM/CSS/PNG，不判颜色或 PASS。每个 shape 必须给出
 * 同一坐标系下的 rect、uniform radius 和来源标签；半径不 clamp、不宽容
 * 越界，任一项失败即 unmeasured。
 *
 * shortcut: shape 的 inner rect/半径归一化由调用方负责；CSS border ->
 * padding 内框半径的推导留给后续浏览器卡，不能拿 outer radius 直接代替。
 */
export function validateDetailBarClipInsideShapes(input) {
  if (!isRecord(input)) throw new TypeError("input 必须是 { clip, shapes } 对象");
  const { clip: rawClip, shapes } = input;
  if (!isRecord(rawClip)) throw new TypeError("clip 必须是 { x, y, width, height } 对象");
  const clip = {
    x: rawClip.x,
    y: rawClip.y,
    width: rawClip.width,
    height: rawClip.height,
  };
  for (const [name, value] of Object.entries(clip)) {
    if (!Number.isInteger(value)) throw new TypeError(`clip.${name} 必须是整数（收到 ${String(value)}）`);
  }
  if (clip.width <= 0 || clip.height !== 1) {
    throw new TypeError(`clip 必须是正整数宽、恰好 1 像素高（收到 width=${clip.width}, height=${clip.height}）`);
  }
  if (!Array.isArray(shapes)) throw new TypeError("shapes 必须是数组");
  if (shapes.length === 0) {
    return { status: "unmeasured", reason: "shapes 为空：没有内框可证明", clip, shapeCount: 0, sources: [] };
  }

  const parsed = shapes.map((shape, index) => {
    if (!isRecord(shape)) throw new TypeError(`shapes[${index}] 必须是对象`);
    if (typeof shape.source !== "string" || shape.source.trim() === "") {
      throw new TypeError(`shapes[${index}].source 必须是非空来源标签`);
    }
    const rect = readGeometryRect(shape.rect, `shapes[${index}].rect`);
    const radius = requireFiniteNumber(shape.radius, `shapes[${index}].radius`);
    const limit = Math.min(rect.width, rect.height) / 2;
    if (radius < 0 || radius > limit) {
      throw new TypeError(`shapes[${index}].radius 必须落在 [0, min(width,height)/2]=[0, ${limit}]（收到 ${radius}）`);
    }
    return { rect, radius, source: shape.source };
  });

  for (const { rect, radius, source } of parsed) {
    // cornerInsideRoundedRect 自身不做矩形边界检查；必须先排除整条越界。
    if (
      clip.x < rect.x ||
      clip.y < rect.y ||
      clip.x + clip.width > rect.x + rect.width ||
      clip.y + clip.height > rect.y + rect.height
    ) {
      return {
        status: "unmeasured",
        reason: `clip 超出内框：${source}`,
        clip,
        shapeCount: parsed.length,
        sources: parsed.map((item) => item.source),
      };
    }
    const localLeft = clip.x - rect.x;
    const localRight = clip.x + clip.width - rect.x;
    const localTop = clip.y - rect.y;
    const localBottom = clip.y + clip.height - rect.y;
    for (const [px, py] of [
      [localLeft, localTop],
      [localRight, localTop],
      [localLeft, localBottom],
      [localRight, localBottom],
    ]) {
      if (!cornerInsideRoundedRect(px, py, rect.width, rect.height, radius)) {
        return {
          status: "unmeasured",
          reason: `clip 角落超出内框圆角：${source}`,
          clip,
          shapeCount: parsed.length,
          sources: parsed.map((item) => item.source),
        };
      }
    }
  }

  return {
    status: "measured",
    reason: "",
    clip,
    shapeCount: parsed.length,
    sources: parsed.map((item) => item.source),
  };
}
