/**
 * M3.2 浏览器实际色源与背景测量（browser-measure.mjs）
 * ============================================================================
 *
 * 固定导出（M3 卡）：
 *   installBrowserColorObserver(page)                   —— 导航前安装 canvas 绘制观察器
 *   captureStableFullPage(page)                         —— fullPage PNG 返回前恢复页面状态
 *   captureStableViewport(page)                         —— viewport PNG 返回前恢复页面状态
 *   measureBrowserRoles({ page, candidate, mode, stateId, roleCatalog, policy })
 *                                                       —— M4 打开状态后测量，返回 M0 测量记录
 *   buildColorObserverSource()                          —— 观察器源串（测试与诊断用；
 *                                                           生产路径经 install 安装）
 *   buildProbeSource(tag, ...args)                      —— 页内源工厂（测试与诊断用；
 *                                                           生产路径直调内部构建函数）
 *
 * 机制（卡面固定路径：读取计算样式 + 无前景背景截图 + 像素检查，不实现 CSS 解析器）：
 *   1. 文字角色：读真实 computed color/font/opacity 与文本 Range.getClientRects()；
 *      input/placeholder 用伪元素样式与内容区域；多节点逐一测、汇总最差。
 *   2. computed CSS 颜色 → sRGB/alpha 一律经浏览器自身 1×1 canvas 解析（双哨兵
 *      防非法值被静默沿用上一 fillStyle），Node 侧不重写 color() 等现代语法。
 *   3. 隐藏文字填充用 -webkit-text-fill-color: transparent + text-shadow: none
 *      （不动 color——currentColor 依赖的背景不得被改变）；元素自身是 SVG 时只
 *      隐绘制不隐盒子；图形角色的"自身填充"路径临时隐 background-color 和
 *      box-shadow，几何与边框不动。
 *   4. 背景 PNG = page.screenshot({ clip: 视口坐标 })（坐标约定为本机实测：
 *      fullPage 分带捕获会把 position:sticky 的粘住元素重复钉在每带顶部，背景里
 *      混进前景；一律视口坐标 + 视口内 clip，目标不在视口内时由滚动会话把他带到
 *      可见处分段测量）——截取的是真实合成结果（陶瓷渐变、聚光叠加、祖先背景全
 *      在内），隐藏前景后文本矩形内全部背景像素参与判定；PNG 在同一隔离浏览器内
 *      经 Image/canvas 解码，不新增运行时 PNG 依赖。截图 scale、devicePixelRatio、
 *      scroll 与坐标换算逐条写进 evidence。
 *   5. 文字本色与每个背景样本按实际 alpha 合成后算比值（compositeSrgb/
 *      contrastRatio 与 M3.1 共用一份 color-math，不取抗锯齿字缘、不把泛光
 *      算作满足对比）。
 *   6. 临时样式/隐藏/遮罩在 finally 恢复，恢复后核对原 CSS 声明和缺失 style 属性状态
 *      （含内联声明的逐属性原值核对，失败进 diagnostics.restoration.inlineRestoreFailures）、元素尺寸与
 *      截图状态（整页像素比对）。滚动会话登记所有可能被 scrollIntoView 移动的
 *      滚动容器（按可滚动余量，与当前偏移无关），恢复后逐个核验，任何不一致都
 *      进 diagnostics.restoration.scrollDifferences；测量过程不得改变应用业务
 *      状态。
 *   7. 无法隔离的滤镜 / 混合模式 / 祖先整体 opacity → unmeasured，附原图、
 *      目标框与手工测量方法；不把祖先 opacity 乘进前景 alpha 冒充合成正确。
 *   8. DOM 身份基准（M8.1 复核 P1）：一次**角色尝试**开始时 querySelectorAll 命中的
 *      有序对象集合就是这次尝试的固定基准，隐藏/逐带重探/像素扫描/恢复/恢复核验
 *      全部拿它比对——不得在每次隐藏时按当前 DOM 重新采样。集合数量变化或任一位次
 *      换成新节点都判定整个尝试失效（含"前面已测成员被替换"），丢弃本次全部
 *      measurements/evidence 并从新的完整角色快照重做，最多一次；第二次仍失效记
 *      unmeasured。失效样本的截图留在 captures 并标 sampleStatus，替换过程写进
 *      diagnostics.notes，不静默。
 *
 * 汇总口径：多节点/多绘制取最差比值，但缺测项一律保留并写入证据——有明确失败
 * 记 fail；没有失败而覆盖不完整（有已渲染节点没能测量）记 unmeasured，不许把已
 * 达标的那部分并成 pass 伪造覆盖率。未渲染节点（display:none / visibility:hidden /
 * 尺寸为 0）没有可测像素，单独记账（notRenderedCount/Reasons），不参与覆盖判定，
 * 但绝不静默删除。
 *
 * Canvas 路径（chart.* 实际绘制色）：
 *   导航前经观察器记录 fillText/strokeText/stroke/fill/fillRect 的颜色、alpha、
 *   font、transform 与绘制坐标（观察器调用原函数、不改绘图参数）。补 fillRect 的
 *   原因：应用用 fillRect 画分类色堆叠段（app.js 2377/2384），卡面四法观不到
 *   数据图形。观察器另记三件事：清空画布/重置尺寸/ctx.reset 记帧边界，读取只取
 *   frameOf(canvas) 指认的当前帧（旧帧描述的是已丢弃的画面；清空/尺寸重置后没有
 *   重绘就是零条记录 → unmeasured，不拿旧帧充数）；测量器自己重建底色层的记录标
 *   injected 并排除。绘制按角色类型分类：文字角色只测文字、图形角色只测堆叠段，
 *   strokeText 读 strokeStyle；属于本角色却测不动的绘制（混合合成、缺坐标、路径型
 *   stroke/fill）计入缺测，观察器记录失败的绘制带 canvasRef/frame 也计入缺测，
 *   另一角色的绘制与已确认的自绘底色层不计缺口，没有本角色可测绘制 → unmeasured。
 *   测背景：保存画布 bitmap 与绘图状态（save）→ 清前景 bitmap（应用自绘底色层按
 *   观察记录重建，finally 还原绘图状态）→ 截图读 CSS 背景 → putImageData 恢复
 *   bitmap（同样 save/restore）并逐像素核验。观察坐标是 drawing buffer 像素，
 *   与截图 CSS 盒按尺寸比换算后再取样。图中颜色取自观察记录，不从
 *   paletteChartSeries 推断（应用另有分类色分配）。
 *
 * 输出：{ records, captures, diagnostics }。
 *   records   —— M0 契约测量记录（十字段，返回前过 validateAssessment 自检）；
 *               M3.4 将其作为 browserChecks 消费。
 *   captures  —— 截图为调用方留存（roleId/kind/clip/dpr/pngBase64），unmeasured
 *               项附 original 原图与目标框。
 *   diagnostics —— environmentBlocked / 恢复核验 / dpr / 视口 / 计数与备注。
 *
 * 环境缺失（page 不可用）不伪造通过：全部预期角色记 unmeasured，reason 注明
 * ENVIRONMENT_BLOCKED，diagnostics.environmentBlocked = true（总计划 §3）。
 */

import { randomUUID } from "node:crypto";

import { compositeSrgb, contrastRatio } from "./color-math.mjs";
import { MODES, validateAssessment } from "./contracts.mjs";
import { captureDetailBarThreeFrames } from "./detail-bar-capture.mjs";
import { analyzeDetailBarFrames } from "./detail-bar-frame-analysis.mjs";
import { measureFocusOutlineAdjacentPixels } from "./focus-outline-browser.mjs";

const OBSERVER_GLOBAL = "__skinPaletteColorObserver";
const CANVAS_STASH_GLOBAL = "__skinPaletteCanvasStash";
const SCROLL_STASH_GLOBAL = "__skinPaletteScrollStash";
/** 角色尝试身份基准 + 隐藏样本暂存（页内，见 IDENTITY_SOURCE）。 */
const MEASUREMENT_STASH_GLOBAL = "__skinPaletteMeasurementStash";
/** 逐带滚动覆盖一个元素时的带上限（防失控循环）。 */
const MAX_MEASURE_BANDS = 12;
/** 每带之间保留的重叠量（粘住元素/半行文本不漏测）。 */
const BAND_OVERLAP_PX = 48;
const OCCLUSION_POINT_KINDS = Object.freeze(["center", "topLeft", "topRight", "bottomLeft", "bottomRight"]);
/** 卡面四法 + fillRect（应用用 fillRect 画时间分布堆叠段，见模块 docstring）。 */
const OBSERVED_METHODS = Object.freeze(["fillText", "strokeText", "stroke", "fill", "fillRect"]);
const INPUT_TEXT_TYPES = Object.freeze({
  "input.value": Object.freeze(["text", "search", "number"]),
  "input.placeholder": Object.freeze(["text", "search"]),
});
/** 颜色解析双哨兵：两个哨兵都被"沿用"才能判定浏览器拒绝了该值。 */
const COLOR_SENTINELS = Object.freeze(["#010203", "#040506"]);
/** 祖先链上这些属性使前景/背景无法分离（卡面步骤 7）。 */
const NON_ISOLATABLE_PROPS = Object.freeze(["opacity", "filter", "mixBlendMode", "backdropFilter"]);
const OWN_OPACITY_TEXT_DISALLOWED_TAGS = Object.freeze([
  "input",
  "textarea",
  "button",
  "select",
  "option",
  "optgroup",
  "label",
  "fieldset",
  "output",
  "progress",
  "meter",
  "object",
  "canvas",
  "img",
  "video",
  "audio",
  "iframe",
  "embed",
  "slot",
  "summary",
]);
const METHOD_TEXT = "browser-text-pixels";
const METHOD_SURFACE = "browser-painted-surface";
const METHOD_CANVAS = "browser-canvas-observer";
const METHOD_DETAIL_FILL = "browser-detail-fill-pixels";
const METHOD_NOT_APPLICABLE = "not-applicable";
const METHOD_UNMEASURED = "unmeasured";
export const OFFICIAL_CANDIDATE_ID = "official-source";
const INPUT_STATE_SELECTOR_ROLES = new Set(["input.value", "input.placeholder"]);
/** 无 fontBoundingBox 指标时的文本框回退（只放大取样区，对最差背景判定保守）。 */
const FALLBACK_ASCENT_RATIO = 0.8;
const FALLBACK_DESCENT_RATIO = 0.2;

// ---------------------------------------------------------------------------
// 纯助手（Node 侧，无 I/O）
// ---------------------------------------------------------------------------

function clipOf(rect) {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function unionRect(rects) {
  const boxes = rects.filter((rect) => rect && rect.width > 0 && rect.height > 0);
  if (boxes.length === 0) return null;
  const left = Math.min(...boxes.map((rect) => rect.x));
  const top = Math.min(...boxes.map((rect) => rect.y));
  const right = Math.max(...boxes.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...boxes.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Validate one band's diagnostic before any screenshot or pixel scan. */
function occlusionFailureReason(band) {
  const probe = band?.occlusion;
  if (!probe) return "遮挡探针缺失";
  if (probe.error) return `遮挡探针错误：${probe.error}`;
  if (probe.identityValid !== true) return "遮挡探针身份未确认";
  if (
    !probe.scroll ||
    !Number.isFinite(probe.scroll.x) ||
    !Number.isFinite(probe.scroll.y) ||
    !Array.isArray(probe.rects) ||
    probe.rects.length !== band.rects.length
  ) {
    return "遮挡探针矩形或滚动信息不完整";
  }
  const outsideHits = [];
  for (const [rectIndex, entry] of probe.rects.entries()) {
    if (
      entry?.rectIndex !== rectIndex ||
      !Array.isArray(entry.points) ||
      entry.points.length !== OCCLUSION_POINT_KINDS.length
    ) {
      return `遮挡探针第 ${rectIndex} 个矩形的五点记录不完整`;
    }
    for (const [pointIndex, point] of entry.points.entries()) {
      const top = point?.top;
      if (
        point?.kind !== OCCLUSION_POINT_KINDS[pointIndex] ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        typeof point.withinHost !== "boolean" ||
        !(
          top === null ||
          (top &&
            Number.isInteger(top.identityId) &&
            typeof top.tag === "string" &&
            (top.id === null || typeof top.id === "string") &&
            (top.className === null || typeof top.className === "string") &&
            [null, "input", "select", "textarea"].includes(top.hostType) &&
            (top.inputType === null || typeof top.inputType === "string"))
        )
      ) {
        return `遮挡探针第 ${rectIndex} 个矩形的 ${OCCLUSION_POINT_KINDS[pointIndex]} 记录无效`;
      }
      if (point.withinHost && !top) {
        return `遮挡探针第 ${rectIndex} 个矩形的 ${point.kind} 缺少命中节点身份`;
      }
      if (!point.withinHost) {
        const topLabel = top
          ? `${top.tag}${top.id ? `#${top.id}` : ""} (identityId=${top.identityId})`
          : "未命中 DOM 节点";
        outsideHits.push(`${point.kind}→${topLabel}`);
      }
    }
  }
  return outsideHits.length > 0 ? `发现宿主及其后代之外的命中：${outsideHits.join("，")}` : null;
}

/**
 * 背景像素里最差的对比样本。pixels 为页内 getImageData 的 0—255 平坦数组，
 * origin 为该像素网格左上角的页坐标；前景按实际 alpha 合成后算比值。
 */
function worstBackgroundSample(foreground, pixels, origin) {
  let worst = null;
  const stride = 4;
  const count = Math.floor(pixels.length / stride);
  const columns = origin.columns;
  for (let index = 0; index < count; index += 1) {
    const base = index * stride;
    const background = [pixels[base] / 255, pixels[base + 1] / 255, pixels[base + 2] / 255];
    const effective =
      foreground.alpha >= 1 ? foreground.rgb : compositeSrgb(foreground.rgb, foreground.alpha, background);
    const ratio = contrastRatio(effective, background);
    if (!worst || ratio < worst.ratio) {
      worst = {
        ratio,
        x: origin.x + (index % columns) * (origin.pixelStepX ?? 1),
        y: origin.y + Math.floor(index / columns) * (origin.pixelStepY ?? 1),
        background: [pixels[base], pixels[base + 1], pixels[base + 2], pixels[base + 3]],
      };
    }
  }
  return worst;
}

/** 属性快照差异（恢复核验）：人类可读差异列表，空数组 = 完全一致。 */
function diffSnapshots(before, after) {
  if (!after) return ["缺少恢复后快照"];
  const differences = [];
  for (const key of Object.keys(before)) {
    const left = JSON.stringify(before[key]);
    const right = JSON.stringify(after[key]);
    if (left !== right) differences.push(`${key}: ${left} → ${right}`);
  }
  return differences;
}

/** 恢复核验差异分类：rect 单独归几何，其余归样式声明（卡面步骤 6 的两类核对）。 */
function splitSnapshotDifferences(before, after) {
  const style = {};
  const geometry = {};
  for (const [key, value] of Object.entries(before)) {
    if (key === "rect") geometry[key] = value;
    else style[key] = value;
  }
  const afterStyle = after ? { ...after } : {};
  const rect = afterStyle.rect;
  delete afterStyle.rect;
  return {
    styleDifferences: diffSnapshots(style, afterStyle),
    rectDifferences: diffSnapshots(geometry, rect === undefined ? null : { rect }),
  };
}

/** 无法隔离判定：除已证明安全的普通文字叶自身 opacity 外，整条绘制链都要拒绝。 */
function isolationBlocker(probe, allowOwnOpacityText = false) {
  const chain = probe.chain ?? [];
  if (allowOwnOpacityText) {
    const opacity = Number.parseFloat(probe.computed?.opacity);
    if (
      !chain[0] ||
      chain[0].opacity !== probe.computed?.opacity ||
      !Number.isFinite(opacity) ||
      opacity <= 0 ||
      opacity >= 1
    ) {
      return "目标自身 opacity 与 chain 首项不一致或不在可支持范围";
    }
  }
  for (const [index, entry] of chain.entries()) {
    for (const prop of NON_ISOLATABLE_PROPS) {
      const value = entry[prop];
      if (prop === "opacity") {
        if (allowOwnOpacityText && index === 0) continue;
        if (Number.parseFloat(value) < 1) return `${entry.tag} 的 opacity=${value}（整体透明度无法分离）`;
      } else if (value && value !== "none" && value !== "normal") {
        return `${entry.tag} 的 ${prop}=${value}`;
      }
    }
  }
  return null;
}

async function ownOpacityTextProofFailure(page, node) {
  const opacity = Number.parseFloat(node.computed?.opacity);
  const prefix = `目标自身 opacity=${node.computed?.opacity} 的文字无法作为普通文字叶测量`;
  const reject = (reason) => `${prefix}：${reason}`;
  if (!Number.isFinite(opacity) || opacity <= 0 || opacity >= 1) return reject("透明度不是有限的 0 与 1 之间数值");
  if (node.isSvg !== false) return reject("SVG 目标不支持自身透明度例外");
  if (node.usesPlaceholder === true || node.pseudo !== null)
    return reject("输入 placeholder 或伪元素路径不支持自身透明度例外");
  if (node.hostType !== null || OWN_OPACITY_TEXT_DISALLOWED_TAGS.includes(node.tag)) {
    return reject("表单或非普通文字元素不支持自身透明度例外");
  }

  const proof = node.ownOpacityTextProof;
  if (!proof) return reject("探针缺少绘制安全字段");
  if (
    proof.isContentEditable !== false ||
    proof.isOrdinaryHtmlElement !== true ||
    proof.hasShadowRoot !== false ||
    proof.childElementCount !== 0 ||
    proof.directTextOnly !== true ||
    proof.hasNonEmptyDirectText !== true
  ) {
    return reject("无法证明目标是无子元素且含直接文字的 HTML 叶节点");
  }
  if (
    !Array.isArray(node.chain) ||
    node.chain.length === 0 ||
    !node.chain.every((entry) => entry.textDecorationLine === "none")
  ) {
    return reject("目标或祖先存在文字装饰，或缺少装饰样式证明");
  }
  if (proof.backgroundImage !== "none") return reject("目标背景图不为空或无法读取");
  const background = await parseColor(page, proof.backgroundColor);
  if (!background.ok || background.alpha !== 0) return reject("目标背景色未能由浏览器证明为透明");
  if (proof.boxShadow !== "none" || proof.textShadow !== "none") return reject("目标存在阴影或阴影样式无法读取");
  if (proof.borderWidths?.length !== 4 || proof.borderWidths.some((width) => width !== "0px")) {
    return reject("目标存在边框或边框宽度无法读取");
  }
  if (typeof proof.outlineStyle !== "string" || typeof proof.outlineWidth !== "string") {
    return reject("目标 outline 样式无法读取");
  }
  if (proof.outlineStyle !== "none" && proof.outlineWidth !== "0px") return reject("目标存在 outline 绘制");
  if (!["none", "normal"].includes(proof.beforeContent) || !["none", "normal"].includes(proof.afterContent)) {
    return reject("目标 ::before 或 ::after 生成了内容");
  }
  if (
    proof.display === "list-item" ||
    proof.clipPath !== "none" ||
    proof.maskImage !== "none" ||
    proof.webkitTextStrokeWidth !== "0px" ||
    proof.textEmphasisStyle !== "none"
  ) {
    return reject("目标存在列表标记、裁切、遮罩或额外文字绘制");
  }
  return null;
}

function nodeIdentity(node) {
  return {
    identityId: node.identityId ?? null,
    tag: node.tag ?? null,
    id: node.id ?? null,
    className: typeof node.className === "string" ? node.className.slice(0, 160) : null,
    hostType: ["input", "select", "textarea"].includes(node.hostType) ? node.hostType : null,
    inputType: typeof node.inputType === "string" ? node.inputType.slice(0, 40) : null,
  };
}

function pushNodeUnmeasured(measurements, node, reason, extra = {}) {
  measurements.push({ unmeasured: reason, node: node.index, identity: nodeIdentity(node), ...extra });
}

function ownTextRangeProbeFailure(node) {
  const probe = node?.ownTextRangeProbe;
  if (!probe || typeof probe !== "object") return "自身文字范围标记缺失";
  if (probe.source !== "direct-text-nodes") return `自身文字范围来源无效（${probe.source ?? "缺失"}）`;
  if (probe.status !== "captured") {
    return `自身文字范围状态为 ${probe.status ?? "缺失"}${probe.reason ? `（${probe.reason}）` : ""}`;
  }
  if (
    !Array.isArray(node.rawTextRects) ||
    !Array.isArray(node.textRects) ||
    !node.textRectClipping ||
    typeof node.textRectClipping !== "object"
  ) {
    return "自身文字范围缺少原始矩形或裁切证据";
  }
  return null;
}

function inputNodeApplicability(role, node) {
  if (!INPUT_STATE_SELECTOR_ROLES.has(role.id)) return null;
  if (node.hostType !== "input" || !INPUT_TEXT_TYPES[role.id].includes(node.inputType)) {
    return {
      kind: "unmeasured",
      reason: `目标类型违约：预期文字输入控件，实际为 ${node.hostType ?? node.tag ?? "未知"}/${node.inputType ?? "未知"}`,
    };
  }
  if (typeof node.hasValue !== "boolean") {
    return { kind: "unmeasured", reason: "节点探针未返回 hasValue 布尔值" };
  }
  if (role.id === "input.value") {
    return node.hasValue ? null : { kind: "not-applicable", reason: "输入值为空，没有可测的文字值" };
  }
  if (typeof node.hasPlaceholder !== "boolean") {
    return { kind: "unmeasured", reason: "节点探针未返回 hasPlaceholder 布尔值" };
  }
  if (!node.hasPlaceholder) return { kind: "not-applicable", reason: "输入控件没有 placeholder" };
  return node.hasValue ? { kind: "not-applicable", reason: "输入已有值，当前显示正文而非 placeholder" } : null;
}

function pushNodeNotApplicable(measurements, evidence, node, reason) {
  const entry = { index: node.index, identity: nodeIdentity(node), reason };
  measurements.push({ notApplicable: reason, node: node.index, identity: entry.identity });
  evidence.notApplicableNodes.push(entry);
}

function thresholdOf(role) {
  return typeof role.threshold === "number" && Number.isFinite(role.threshold) ? role.threshold : null;
}

/** M0 契约测量记录（十字段，无扩展字段——§4 扩展须先改契约）。 */
function buildRecord({ candidateId, mode, roleId, stateId, result, ratio, threshold, method, evidence, reason }) {
  return { candidateId, mode, roleId, stateId, result, ratio, threshold, method, evidence, reason };
}

function evidenceOf(payload) {
  return JSON.stringify(payload);
}

/** 记录自检：借 validateAssessment 的 envelope 走 M0 validateMeasurement 逐条校验。 */
function assertRecordsConform(records) {
  // 信封只是自检载体：readiness 随记录里是否存在 fail 切换（validateAssessment
  // 的一致性规则），视觉字段固定未评审——这里只校验测量记录本身。
  const envelope = {
    schemaVersion: 1,
    candidateId: records[0]?.candidateId ?? OFFICIAL_CANDIDATE_ID,
    candidateHash: "0".repeat(64),
    fast: [],
    browser: records,
    visual: { reviewed: false, verdict: null, notes: "" },
    readiness: records.some((record) => record.result === "fail") ? "rejected" : "incomplete",
    failures: [],
    unmeasured: [],
    diagnostics: {},
  };
  const verdict = validateAssessment(envelope);
  if (!verdict.valid) {
    const detail = verdict.errors
      .slice(0, 3)
      .map((issue) => `${issue.path} ${issue.message}`)
      .join("；");
    throw new TypeError(`measureBrowserRoles: 产出记录未过 M0 契约：${detail}`);
  }
}

function environmentBlockedResult({ roles, mode, stateId, candidateId, reason }) {
  const records = roles.map((role) =>
    buildRecord({
      candidateId,
      mode,
      roleId: role.id,
      stateId,
      result: "unmeasured",
      ratio: null,
      threshold: thresholdOf(role),
      method: METHOD_UNMEASURED,
      evidence: evidenceOf({ blocked: true, reason }),
      reason: `ENVIRONMENT_BLOCKED：${reason}`,
    }),
  );
  assertRecordsConform(records);
  return {
    records,
    captures: [],
    diagnostics: {
      environmentBlocked: true,
      blockedReason: reason,
      mode,
      stateId,
      candidateId,
      roles: roles.length,
      counts: { pass: 0, fail: 0, unmeasured: roles.length, notApplicable: 0 },
      restoration: null,
      notes: ["浏览器页面不可用：未执行任何测量，不记为通过（总计划 §3）"],
    },
  };
}

function pageBlockage(page) {
  if (!page || typeof page !== "object") return "page 缺失（浏览器未启动或已关闭）";
  if (typeof page.evaluate !== "function") return "page.evaluate 不可用（不是受支持的浏览器页面对象）";
  if (typeof page.screenshot !== "function") return "page.screenshot 不可用（无法截取背景 PNG）";
  return null;
}

/** 角色在该状态下是否预期出现（M0 角色目录的 states 声明）。 */
function rolesForState(roleCatalog, stateId) {
  if (stateId === null) return [...roleCatalog];
  return roleCatalog.filter((role) => Array.isArray(role.states) && role.states.includes(stateId));
}

// ---------------------------------------------------------------------------
// 页内源（纯字符串，arg 以 JSON 嵌入；skinProbe 标记便于测试替身识别）。
// 真实 Playwright 与测试替身执行同一份源，语义只有一份。
// ---------------------------------------------------------------------------

/** canvas 绘制观察器：记录卡面要求的字段，调用原函数且不改绘图参数。 */
export function buildColorObserverSource() {
  return `// skinProbe: color-observer
(() => {
  const globalKey = ${JSON.stringify(OBSERVER_GLOBAL)};
  if (window[globalKey]) return "already-installed";
  const proto = window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype;
  if (!proto) return "no-canvas";
  const canvasProto = window.HTMLCanvasElement && window.HTMLCanvasElement.prototype;
  const records = [];
  let nextEventSequence = 0;
  // 绘制帧：应用清空画布或重置画布尺寸都会丢弃既有 bitmap，此前的记录描述的是
  // 已经被覆盖的画面。按画布计数，读取时只保留最后一帧（见 canvas-stash）。
  const frames = new WeakMap();
  const frameOf = (canvas) => (frames.has(canvas) ? frames.get(canvas) : 0);
  const boundary = (canvas) => {
    if (canvas) frames.set(canvas, frameOf(canvas) + 1);
  };
  // 测量器自己重建背景产生的绘制必须可被排除，否则下一轮会把重建的底色层
  // 当成应用的当前绘制。
  let injectDepth = 0;
  const patchedCanvases = new WeakSet();
  const trackCanvasReset = (canvas) => {
    if (!canvas || patchedCanvases.has(canvas) || !canvasProto) return;
    for (const property of ["width", "height"]) {
      const descriptor = Object.getOwnPropertyDescriptor(canvasProto, property);
      if (!descriptor || typeof descriptor.set !== "function") continue;
      Object.defineProperty(canvas, property, {
        get: descriptor.get,
        set: function (value) {
          descriptor.set.call(this, value);
          if (injectDepth === 0) boundary(this);
        },
        configurable: true,
      });
    }
    patchedCanvases.add(canvas);
  };
  const snapshotTransform = (ctx) => {
    if (typeof ctx.getTransform !== "function") return null;
    const matrix = ctx.getTransform();
    return { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f };
  };
  for (const method of ${JSON.stringify(OBSERVED_METHODS)}) {
    const original = proto[method];
    if (typeof original !== "function") continue;
    proto[method] = function (...args) {
      const record = {
        eventSequence: nextEventSequence++,
        frame: null,
        injected: injectDepth > 0,
        method,
        canvasRef: null,
        canvasId: null,
        fillStyle: null,
        strokeStyle: null,
        lineWidth: null,
        alpha: null,
        composite: null,
        font: "",
        textAlign: "start",
        transform: null,
        text: null,
        x: null,
        y: null,
        rectArgs: null,
        measured: null,
      };
      try {
        const canvas = this.canvas || null;
        record.canvasRef = canvas;
        record.canvasId = canvas?.id || null;
        if (canvas) trackCanvasReset(canvas);
        record.frame = frameOf(canvas);
        record.injected = injectDepth > 0;
        if (method === "stroke" && Object.hasOwn(this, "__codexUsageChartDraw")) {
          const chartDraw = this.__codexUsageChartDraw;
          if (!chartDraw || typeof chartDraw !== "object" || Array.isArray(chartDraw)) {
            record.chartDrawInvalidReason = "invalid-metadata";
          } else if (chartDraw.roleId !== "chart.axis-line") {
            record.chartDrawInvalidReason = "unsupported-role-id";
          } else {
            const points = chartDraw.points;
            let validPoints = Array.isArray(points) && points.length === 3;
            const pointsCopy = [];
            for (let index = 0; validPoints && index < 3; index += 1) {
              const point = points[index];
              if (!Array.isArray(point) || point.length !== 2) {
                validPoints = false;
                continue;
              }
              const x = point[0];
              const y = point[1];
              if (!Number.isFinite(x) || !Number.isFinite(y)) validPoints = false;
              else pointsCopy.push([x, y]);
            }
            if (!validPoints) {
              record.chartDrawInvalidReason = "invalid-points";
            } else {
              record.chartDraw = {
                roleId: "chart.axis-line",
                points: pointsCopy,
              };
            }
          }
        }
        const isText = method === "fillText" || method === "strokeText";
        record.fillStyle = this.fillStyle;
        record.strokeStyle = this.strokeStyle;
        record.lineWidth = typeof this.lineWidth === "number" ? this.lineWidth : null;
        record.alpha = typeof this.globalAlpha === "number" ? this.globalAlpha : 1;
        record.composite = this.globalCompositeOperation || "source-over";
        record.font = typeof this.font === "string" ? this.font : "";
        record.textAlign = typeof this.textAlign === "string" ? this.textAlign : "start";
        record.transform = snapshotTransform(this);
        record.text = isText ? String(args[0]) : null;
        record.x = typeof args[1] === "number" ? args[1] : null;
        record.y = typeof args[2] === "number" ? args[2] : null;
        record.rectArgs = method === "fillRect" && args.length >= 4 ? [args[0], args[1], args[2], args[3]] : null;
        const measured = isText && typeof this.measureText === "function" ? this.measureText(args[0]) : null;
        record.measured = measured
          ? {
              width: measured.width,
              ascent: measured.actualBoundingBoxAscent,
              descent: measured.actualBoundingBoxDescent,
              fontAscent: measured.fontBoundingBoxAscent,
              fontDescent: measured.fontBoundingBoxDescent,
            }
          : null;
        records.push(record);
      } catch (error) {
        // 记录失败也要留下归属信息（画布、当前帧）：它仍是一条没能观察到的绘制，
        // 读取侧要能把它算进缺测，而不是让它从覆盖率里蒸发。
        records.push({
          ...record,
          frame: record.frame ?? frameOf(record.canvasRef),
          observationError: String(error && error.message ? error.message : error),
        });
      }
      return original.apply(this, args);
    };
  }
  // 只标记帧边界、不记录的整幅清除：clearRect 与 ctx.reset()
  for (const method of ["clearRect", "reset"]) {
    const original = proto[method];
    if (typeof original !== "function") continue;
    proto[method] = function (...args) {
      if (injectDepth === 0) boundary(this.canvas);
      return original.apply(this, args);
    };
  }
  Object.defineProperty(window, globalKey, {
    value: {
      version: 2,
      records,
      frameOf: (canvas) => frameOf(canvas),
      beginInject: () => {
        injectDepth += 1;
      },
      endInject: () => {
        injectDepth = Math.max(0, injectDepth - 1);
      },
      isInjecting: () => injectDepth > 0,
    },
    configurable: true,
  });
  return "installed";
})()`;
}

/**
 * 页内身份基准片段（探测/隐藏/扫描/恢复/核验/收尾六处共用同一份比对，不各写一套）。
 *
 * 基准 = 本次**角色尝试**开始时 `querySelectorAll(selector)` 命中的有序对象集合，
 * 外加每个宿主当时的**整个元素子树对象序列**。
 * 关键约束（M8.1 复核 P1）：基准只在尝试开始时建立一次，不得在每次隐藏时按当前
 * DOM 重新采样——否则"前面已测成员被替换"会被后一次采样悄悄接受，把两个 DOM 版本
 * 的样本混进同一个最差比值。集合数量变化、任一位次换成新节点，都判定整个尝试失效。
 * 子树也要比（M8.1 复核 P2）：宿主 `th` 对象不变、里面的 `button`/`span` 被换掉，
 * 同样是换了一个 DOM 版本——新子节点可以带自己的 `-webkit-text-fill-color`，
 * 把已经"隐藏"的文字重新画回背景 PNG 里。
 *
 * 隐藏有效性（`__isolationState`）与身份是两件事：身份没变也可能隔离失败（子节点
 * 本来就有独立文字填充），这时样本是污染样本，只能记 unmeasured，不得当真实低对比。
 */
const IDENTITY_SOURCE = `
  const __stash = () => {
    const key = ${JSON.stringify(MEASUREMENT_STASH_GLOBAL)};
    let state = window[key];
    if (!state) {
      state = { nextId: 1, nextToken: 1, ids: new WeakMap(), attempts: new Map(), sessions: new Map() };
      Object.defineProperty(window, key, { value: state, configurable: true });
    }
    if (!(state.ids instanceof WeakMap)) state.ids = new WeakMap();
    if (!(state.attempts instanceof Map)) state.attempts = new Map();
    if (!(state.sessions instanceof Map)) state.sessions = new Map();
    if (!Number.isFinite(state.nextId)) state.nextId = 1;
    if (!Number.isFinite(state.nextToken)) state.nextToken = 1;
    return state;
  };
  const __idFor = (state, element) => {
    if (!state.ids.has(element)) state.ids.set(element, state.nextId++);
    return state.ids.get(element);
  };
  const __safeIdentity = (state, element) => {
    const tag = String(element?.tagName || "").toLowerCase();
    const attribute = (name, limit) => {
      const value = element?.getAttribute?.(name);
      return typeof value === "string" && value ? value.slice(0, limit) : null;
    };
    return {
      identityId: state ? __idFor(state, element) : null,
      tag,
      id: attribute("id", 120),
      className: attribute("class", 160),
      hostType: ["input", "select", "textarea"].includes(tag) ? tag : null,
      inputType: tag === "input" ? String(element.type || "").slice(0, 40) : null,
    };
  };
  const __descendantsOf = (element) => {
    try {
      return Array.from(element.querySelectorAll("*"));
    } catch (error) {
      return [];
    }
  };
  const __limitedDynamicTextHost = (element) =>
    element?.nodeType === 1 &&
    (element.id === "lastSuccessfulCheck" ||
      String(element.className ?? "").split(/\\s+/).includes("comparison-as-of"));
  const __directTextNodes = (element) =>
    Array.from(element?.childNodes ?? []).filter((node) => {
      if (node?.nodeType !== 3) return false;
      return String(node.data ?? node.textContent ?? "").length > 0;
    });
  const __textNodeRangeRects = (node) => {
    const text = String(node.data ?? node.textContent ?? "");
    const range = document.createRange();
    if (typeof range.setStart === "function" && typeof range.setEnd === "function") {
      range.setStart(node, 0);
      range.setEnd(node, text.length);
    } else {
      range.selectNode(node);
    }
    return Array.from(range.getClientRects(), (rect) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    }));
  };
  const __limitedDynamicTextSnapshot = (element) => {
    if (!__limitedDynamicTextHost(element)) return null;
    try {
      const hostRect = element.getBoundingClientRect();
      if (
        !["x", "y", "width", "height"].every((key) => Number.isFinite(hostRect[key])) ||
        hostRect.width <= 0 ||
        hostRect.height <= 0
      ) {
        return { valid: false, reason: "动态文字 host 矩形无效", nodes: [] };
      }
      const nodes = [];
      for (const node of __directTextNodes(element)) {
        const text = String(node.data ?? node.textContent ?? "");
        const rects = __textNodeRangeRects(node);
        if (
          rects.length === 0 ||
          rects.some(
            (rect) =>
              !["x", "y", "width", "height"].every((key) => Number.isFinite(rect[key])) ||
              rect.width <= 0 ||
              rect.height <= 0,
          )
        ) {
          return { valid: false, reason: "动态文字 Range 为空或几何无效", nodes: [] };
        }
        nodes.push({
          node,
          text,
          startOffset: 0,
          endOffset: text.length,
          rects: rects.map((rect) => ({
            x: rect.x - hostRect.x,
            y: rect.y - hostRect.y,
            width: rect.width,
            height: rect.height,
          })),
        });
      }
      if (nodes.length === 0) {
        return { valid: false, reason: "动态文字 host 缺少非空直接 Text node", nodes: [] };
      }
      return { valid: true, reason: null, nodes };
    } catch (error) {
      return {
        valid: false,
        reason: "动态文字 Range 捕获失败：" + String(error?.message ?? error),
        nodes: [],
      };
    }
  };
  const __limitedDynamicTextSummary = (snapshot) =>
    snapshot === null
      ? null
      : {
          valid: snapshot.valid,
          reason: snapshot.reason,
          textNodeCount: snapshot.nodes.length,
          nodes: snapshot.nodes.map((node, index) => ({
            index,
            text: node.text,
            start: { offset: node.startOffset },
            end: { offset: node.endOffset },
            rects: node.rects.map((rect) => ({ ...rect })),
          })),
        };
  const __limitedDynamicTextIdentity = (snapshot, element) => {
    if (!snapshot) return { valid: true, reason: null };
    if (!snapshot.valid) return { valid: false, reason: snapshot.reason };
    try {
      const nodes = __directTextNodes(element);
      if (nodes.length !== snapshot.nodes.length) {
        return {
          valid: false,
          reason: "动态文字直接 Text node 数量已变化（" + snapshot.nodes.length + " → " + nodes.length + "）",
        };
      }
      const hostRect = element.getBoundingClientRect();
      if (
        !["x", "y", "width", "height"].every((key) => Number.isFinite(hostRect[key])) ||
        hostRect.width <= 0 ||
        hostRect.height <= 0
      ) {
        return { valid: false, reason: "动态文字 host 矩形无效" };
      }
      for (let index = 0; index < nodes.length; index += 1) {
        const baseline = snapshot.nodes[index];
        const node = nodes[index];
        if (node !== baseline.node) {
          return { valid: false, reason: "第 " + index + " 个直接 Text node 已换成新节点" };
        }
        const text = String(node.data ?? node.textContent ?? "");
        if (text !== baseline.text) {
          return { valid: false, reason: "第 " + index + " 个直接 Text node 内容已变化" };
        }
        const rects = __textNodeRangeRects(node);
        if (rects.length === 0) {
          return { valid: false, reason: "第 " + index + " 个直接 Text node 的 Range 为空" };
        }
        if (
          rects.some(
            (rect) =>
              !["x", "y", "width", "height"].every((key) => Number.isFinite(rect[key])) ||
              rect.width <= 0 ||
              rect.height <= 0,
          )
        ) {
          return { valid: false, reason: "第 " + index + " 个直接 Text node 的 Range 几何无效" };
        }
        const relative = rects.map((rect) => ({
          x: rect.x - hostRect.x,
          y: rect.y - hostRect.y,
          width: rect.width,
          height: rect.height,
        }));
        if (
          relative.length !== baseline.rects.length ||
          relative.some((rect, rectIndex) => {
            const expected = baseline.rects[rectIndex];
            return (
              !["x", "y", "width", "height"].every(
                (key) =>
                  Number.isFinite(rect[key]) &&
                  Number.isFinite(expected[key]) &&
                  Math.abs(rect[key] - expected[key]) <= 0.01,
              )
            );
          })
        ) {
          return { valid: false, reason: "第 " + index + " 个直接 Text node 的 Range 边界已变化" };
        }
      }
      return { valid: true, reason: null };
    } catch (error) {
      return {
        valid: false,
        reason: "动态文字 Range 复查失败：" + String(error?.message ?? error),
      };
    }
  };
  const __beginAttempt = (state, selector) => {
    const token = "a" + state.nextToken++;
    const elements = Array.from(document.querySelectorAll(selector));
    state.attempts.set(token, {
      selector,
      elements,
      subtrees: elements.map((element) => __descendantsOf(element)),
      textSnapshots: elements.map((element) => __limitedDynamicTextSnapshot(element)),
    });
    return token;
  };
  const __attemptIdentity = (state, attemptToken) => {
    const attempt = state.attempts.get(attemptToken);
    if (!attempt) return { valid: false, reason: "角色尝试基准不存在" };
    const current = Array.from(document.querySelectorAll(attempt.selector));
    if (current.length !== attempt.elements.length) {
      return {
        valid: false,
        reason: "selector 匹配集合数量已变化（" + attempt.elements.length + " → " + current.length + "）",
      };
    }
    for (let index = 0; index < current.length; index += 1) {
      if (current[index] !== attempt.elements[index]) {
        return { valid: false, reason: "selector 匹配集合第 " + index + " 位已换成新节点" };
      }
    }
    // 宿主同一对象时继续比子树：只换子节点（如 th 里的 button/span）也算换了版本
    const subtrees = attempt.subtrees || attempt.elements.map(() => []);
    for (let index = 0; index < current.length; index += 1) {
      const baseline = subtrees[index] || [];
      const live = __descendantsOf(current[index]);
      if (live.length !== baseline.length) {
        return {
          valid: false,
          reason: "第 " + index + " 位宿主的元素子树数量已变化（" + baseline.length + " → " + live.length + "）",
        };
      }
      for (let sub = 0; sub < live.length; sub += 1) {
        if (live[sub] !== baseline[sub]) {
          return { valid: false, reason: "第 " + index + " 位宿主的第 " + sub + " 个子节点已换成新节点" };
        }
      }
    }
    const textSnapshots = attempt.textSnapshots || attempt.elements.map(() => null);
    for (let index = 0; index < current.length; index += 1) {
      const checked = __limitedDynamicTextIdentity(textSnapshots[index] || null, current[index]);
      if (!checked.valid) {
        return { valid: false, reason: "第 " + index + " 位宿主：" + checked.reason };
      }
    }
    return { valid: true, reason: null };
  };
  const __alphaOf = (value) => {
    const text = String(value == null ? "" : value).trim().toLowerCase();
    // 具名 transparent 与 rgba(...,0) 都是"不画"；计算值通常是后者，前者是兜底
    if (text === "transparent") return 0;
    const match = /rgba?\\(([^)]+)\\)/.exec(text);
    if (!match) return 1;
    const parts = match[1].split(",").map((part) => Number.parseFloat(part));
    return parts.length >= 4 && Number.isFinite(parts[3]) ? parts[3] : 1;
  };
  const __paintsOwnText = (node) => {
    const children = node.childNodes || [];
    for (const child of children) {
      if (child.nodeType === 3 && child.textContent && child.textContent.trim() !== "") return true;
    }
    return false;
  };
  // 会画字的元素 = 宿主自身（有直接文本）加上子树里所有有直接文本的后代
  const __textPainters = (element) => {
    const painters = __paintsOwnText(element) ? [element] : [];
    for (const descendant of __descendantsOf(element)) {
      if (__paintsOwnText(descendant)) painters.push(descendant);
    }
    return painters;
  };
  const __stillPaintsText = (element) => {
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (!(Number.parseFloat(style.opacity) > 0)) return false;
    const fill = style.webkitTextFillColor || style.color;
    if (__alphaOf(fill) > 0) return true;
    return Boolean(style.textShadow) && style.textShadow !== "none";
  };
  const __isolationState = (element, mode) => {
    // svg 用 opacity:0 隐藏：组不透明度让整个子树一起消失，后代无法覆盖
    if (mode === "svg") {
      const opacity = getComputedStyle(element).opacity;
      return { isolated: opacity === "0", remaining: opacity === "0" ? [] : ["opacity"] };
    }
    // surface 量的是元素自身填充区：背景和光晕都属于前景，必须从背景 PNG 中隔离。
    if (mode === "surface") {
      const style = getComputedStyle(element);
      const remaining = [];
      if (__alphaOf(style.backgroundColor) !== 0) remaining.push("background-color");
      if (style.boxShadow !== "none") remaining.push("box-shadow");
      return { isolated: remaining.length === 0, remaining };
    }
    if (mode !== "text") return { isolated: true, remaining: [] };
    const remaining = __textPainters(element).filter((painter) => __stillPaintsText(painter));
    return {
      isolated: remaining.length === 0,
      remaining: remaining.map((node) => node.tagName.toLowerCase()),
    };
  };
  const __decorationMarker = "data-skin-palette-measurement-decoration";
  const __hostMaterial = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      geometry: {
        width: rect.width,
        height: rect.height,
        clientLeft: element.clientLeft,
        clientTop: element.clientTop,
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
      },
      style: {
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        boxShadow: style.boxShadow,
        borderColor: style.borderColor,
        borderWidth: style.borderWidth,
        borderRadius: style.borderRadius,
        padding: style.padding,
        color: style.color,
        opacity: style.opacity,
      },
    };
  };
  const __declarationMatches = (style, property, value, priority) =>
    style.getPropertyValue(property) === value && style.getPropertyPriority(property) === priority;
  const __restoreDeclaration = (style, property, value, priority) => {
    if (value) style.setProperty(property, value, priority || "");
    else style.removeProperty(property);
    return __declarationMatches(style, property, value, priority || "");
  };
  const __styleAttributeRestored = (element, wasPresent) => {
    if (wasPresent === true) return element.hasAttribute("style");
    // Unrelated declarations are allowed to remain; only an empty attribute is stale when originally absent.
    return wasPresent !== false || !element.hasAttribute("style") || element.style.cssText !== "";
  };
  const __restoreStyleAttribute = (element, wasPresent) => {
    if (wasPresent === false && element.style.cssText === "") {
      // cssText reads CSSOM; the raw getter flushes a pending empty style attribute before removal.
      element.getAttribute("style");
      element.removeAttribute("style");
    }
    return __styleAttributeRestored(element, wasPresent);
  };
  const __searchRuleActive = (decoration) => {
    if (!decoration?.styleNode?.isConnected || decoration.target.getAttribute(__decorationMarker) !== decoration.token) {
      return false;
    }
    try {
      return Array.from(decoration.styleNode.sheet?.cssRules ?? []).some(
        (rule) =>
          rule.selectorText === decoration.selector &&
          rule.style.getPropertyValue("visibility") === "hidden" &&
          rule.style.getPropertyPriority("visibility") === "important",
      );
    } catch (error) {
      return false;
    }
  };
  const __installDecoration = (element, token, mode) => {
    if (mode !== "text") return { stash: null, evidence: null };
    const before = __hostMaterial(element);
    if (element.tagName === "BUTTON" && element.id === "calendarZoneSelect") {
      const arrow = element.querySelector(".calendar-zone-arrow");
      if (!arrow) {
        return {
          stash: null,
          evidence: { kind: "calendar-zone-arrow", installed: false, hostStable: true, reason: "目标按钮缺少箭头节点" },
        };
      }
      const decoration = {
        kind: "calendar-zone-arrow",
        target: element,
        arrow,
        originalVisibility: arrow.style.getPropertyValue("visibility"),
        originalVisibilityPriority: arrow.style.getPropertyPriority("visibility"),
        before,
        after: null,
      };
      try {
        arrow.style.setProperty("visibility", "hidden", "important");
        decoration.after = __hostMaterial(element);
        const installed =
          arrow.style.getPropertyValue("visibility") === "hidden" &&
          arrow.style.getPropertyPriority("visibility") === "important";
        return {
          stash: decoration,
          evidence: {
            kind: decoration.kind,
            installed,
            hostStable: JSON.stringify(before) === JSON.stringify(decoration.after),
            childVisibility: "hidden",
            childVisibilityPriority: "important",
          },
        };
      } catch (error) {
        return {
          stash: decoration,
          evidence: {
            kind: decoration.kind,
            installed: false,
            hostStable: false,
            reason: String(error?.message ?? error),
          },
        };
      }
    }
    if (element.tagName === "INPUT" && String(element.type).toLowerCase() === "search") {
      const selector = 'input[type="search"][' + __decorationMarker + '="' + token + '"]::-webkit-search-cancel-button';
      const decoration = {
        kind: "search-cancel-button",
        target: element,
        token,
        selector,
        markerPresent: element.hasAttribute(__decorationMarker),
        markerValue: element.getAttribute(__decorationMarker),
        styleNode: document.createElement("style"),
        value: element.value,
        activeElement: document.activeElement,
        before,
        after: null,
      };
      try {
        decoration.styleNode.textContent = selector + "{visibility:hidden!important}";
        element.setAttribute(__decorationMarker, token);
        (document.head ?? document.documentElement).appendChild(decoration.styleNode);
        decoration.after = __hostMaterial(element);
        const active = __searchRuleActive(decoration);
        return {
          stash: decoration,
          evidence: {
            kind: decoration.kind,
            installed: active,
            hostStable: JSON.stringify(before) === JSON.stringify(decoration.after),
            businessStateUnchanged: element.value === decoration.value && document.activeElement === decoration.activeElement,
            hadValue: Boolean(decoration.value),
            wasFocused: decoration.activeElement === element,
            diagnosticLimit: "Edge 的 search 伪元素 CSSOM visibility 只作诊断；不作为绘制状态判据。",
          },
        };
      } catch (error) {
        return {
          stash: decoration,
          evidence: {
            kind: decoration.kind,
            installed: false,
            hostStable: false,
            businessStateUnchanged: element.value === decoration.value && document.activeElement === decoration.activeElement,
            hadValue: Boolean(decoration.value),
            wasFocused: decoration.activeElement === element,
            reason: String(error?.message ?? error),
            diagnosticLimit: "Edge 的 search 伪元素 CSSOM visibility 只作诊断；不作为绘制状态判据。",
          },
        };
      }
    }
    return { stash: null, evidence: null };
  };
  const __decorationState = (decoration) => {
    if (!decoration) return { active: true, hostStable: true, businessStateStable: true };
    const hostStable = JSON.stringify(__hostMaterial(decoration.target)) === JSON.stringify(decoration.after);
    if (decoration.kind === "calendar-zone-arrow") {
      return {
        active:
          decoration.target.querySelector(".calendar-zone-arrow") === decoration.arrow &&
          decoration.arrow.style.getPropertyValue("visibility") === "hidden" &&
          decoration.arrow.style.getPropertyPriority("visibility") === "important",
        hostStable,
        businessStateStable: true,
      };
    }
    return {
      active: __searchRuleActive(decoration),
      hostStable,
      businessStateStable:
        decoration.target.value === decoration.value && document.activeElement === decoration.activeElement,
    };
  };
  const __decorationRestored = (decoration) => {
    if (!decoration) return true;
    if (decoration.kind === "calendar-zone-arrow") {
      return (
        decoration.target.querySelector(".calendar-zone-arrow") === decoration.arrow &&
        __declarationMatches(
          decoration.arrow.style,
          "visibility",
          decoration.originalVisibility,
          decoration.originalVisibilityPriority,
        )
      );
    }
    const markerRestored = decoration.markerPresent
      ? decoration.target.hasAttribute(__decorationMarker) &&
        decoration.target.getAttribute(__decorationMarker) === decoration.markerValue
      : !decoration.target.hasAttribute(__decorationMarker);
    return (
      markerRestored &&
      !decoration.styleNode.isConnected &&
      decoration.target.value === decoration.value &&
      (!decoration.target.isConnected || document.activeElement === decoration.activeElement)
    );
  };
  const __cleanupDecoration = (decoration) => {
    const errors = [];
    if (!decoration) return { restored: true, errors };
    if (decoration.kind === "calendar-zone-arrow") {
      try {
        __restoreDeclaration(
          decoration.arrow.style,
          "visibility",
          decoration.originalVisibility,
          decoration.originalVisibilityPriority,
        );
      } catch (error) {
        errors.push(String(error?.message ?? error));
      }
    } else {
      try {
        if (decoration.markerPresent) decoration.target.setAttribute(__decorationMarker, decoration.markerValue);
        else decoration.target.removeAttribute(__decorationMarker);
      } catch (error) {
        errors.push("marker: " + String(error?.message ?? error));
      }
      try {
        if (decoration.styleNode.isConnected) decoration.styleNode.remove();
      } catch (error) {
        errors.push("style.remove: " + String(error?.message ?? error));
      }
      if (decoration.styleNode.isConnected) {
        try {
          decoration.styleNode.parentNode?.removeChild(decoration.styleNode);
        } catch (error) {
          errors.push("style.removeChild: " + String(error?.message ?? error));
        }
      }
      if (decoration.styleNode.isConnected) {
        try {
          while (decoration.styleNode.sheet?.cssRules?.length) decoration.styleNode.sheet.deleteRule(0);
        } catch (error) {
          errors.push("style.clearRules: " + String(error?.message ?? error));
        }
      }
    }
    let restored = false;
    try {
      restored = __decorationRestored(decoration);
    } catch (error) {
      errors.push("verify: " + String(error?.message ?? error));
    }
    return { restored, errors };
  };
`;

/** 节点探测：解析选择器、文本矩形、计算样式快照、祖先链、滚动与 dpr。 */
function buildNodeProbeSource(
  selector,
  pseudo,
  hiddenToken = null,
  trackIdentities = false,
  includeText = false,
  includeOwnOpacityTextProof = false,
  includeOwnTextRanges = false,
  includeCostNoteLinkDecorationProof = false,
) {
  return `// skinProbe: node-probe
(() => {
  const selector = ${JSON.stringify(selector)};
  const pseudo = ${JSON.stringify(pseudo)};
  const includeText = ${JSON.stringify(includeText)};
  const useOwnTextRanges = ${JSON.stringify(includeOwnTextRanges)};
  const includeCostNoteLinkDecorationProof = ${JSON.stringify(includeCostNoteLinkDecorationProof)};
  const ownOpacityTextDisallowedTags = ${JSON.stringify(OWN_OPACITY_TEXT_DISALLOWED_TAGS)};
${IDENTITY_SOURCE}
  let nodes = [];
  try {
    nodes = Array.from(document.querySelectorAll(selector));
  } catch (error) {
    return { error: "选择器无法解析：" + String(error && error.message ? error.message : error), nodes: [] };
  }
  const state = ${JSON.stringify(trackIdentities)} ? __stash() : (window[${JSON.stringify(MEASUREMENT_STASH_GLOBAL)}] ?? null);
  // 尝试基准先建立：本次尝试后续所有页内操作都拿它比对
  const attemptToken = state && ${JSON.stringify(trackIdentities)} && nodes.length > 0 ? __beginAttempt(state, selector) : null;
  const attemptTextSnapshots = attemptToken ? (state.attempts.get(attemptToken)?.textSnapshots ?? []) : [];
  // 带上隐藏样本时（逐带重探），先核验当前 DOM 是否仍是本次尝试开始时的对象集合
  let measurementIdentity = null;
  if (${JSON.stringify(hiddenToken !== null)}) {
    const stash = state ? state.sessions.get(${JSON.stringify(hiddenToken)}) : null;
    if (!stash) {
      measurementIdentity = { valid: false, reason: "隐藏样本暂存不存在" };
    } else {
      const checked = __attemptIdentity(state, stash.attemptToken);
      measurementIdentity = { valid: checked.valid, reason: checked.reason };
    }
    if (!measurementIdentity.valid) return { nodes: [], measurementIdentity, attemptToken };
  }
  const readChain = (element, includeTextDecorationLine = false) => {
    const chain = [];
    for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
      const style = getComputedStyle(current);
      chain.push({
        tag: current.tagName.toLowerCase(),
        opacity: style.opacity,
        filter: style.filter,
        mixBlendMode: style.mixBlendMode,
        backdropFilter: style.backdropFilter || style.webkitBackdropFilter || "none",
        ...(includeTextDecorationLine ? { textDecorationLine: style.textDecorationLine } : {}),
      });
    }
    return chain;
  };
  const parseCssPx = (value) => {
    const match = /^([0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)px$/.exec(String(value).trim());
    if (!match) return null;
    const number = Number(match[1]);
    return Number.isFinite(number) && number >= 0 ? number : null;
  };
  const parseRadiusPair = (value) => {
    const parts = String(value).trim().split(/\\s+/);
    if (parts.length < 1 || parts.length > 2) return null;
    const x = parseCssPx(parts[0]);
    const y = parts.length === 2 ? parseCssPx(parts[1]) : x;
    return x === null || y === null ? null : { x, y };
  };
  const readRoundedClip = (element, style, borderRect, clientRect, clipX, clipY) => {
    const radiusValues = [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ];
    const radiusPairs = radiusValues.map(parseRadiusPair);
    const hasRoundedCorner = radiusValues.some((value) => {
      const pair = parseRadiusPair(value);
      return pair === null || pair.x > 0 || pair.y > 0;
    });
    if (!hasRoundedCorner) return { roundedClip: null, error: null };
    const label = element.tagName.toLowerCase() + (element.id ? "#" + element.id : "");
    if (!clipX || !clipY) {
      return { roundedClip: null, error: label + " 有圆角但只有单轴 overflow 裁切，几何无法证明" };
    }
    if (radiusPairs.some((pair) => pair === null)) {
      return { roundedClip: null, error: label + " border-radius 不是可解释的有限 px 值" };
    }
    const borderWidths = {
      top: parseCssPx(style.borderTopWidth),
      right: parseCssPx(style.borderRightWidth),
      bottom: parseCssPx(style.borderBottomWidth),
      left: parseCssPx(style.borderLeftWidth),
    };
    if (Object.values(borderWidths).some((width) => width === null)) {
      return { roundedClip: null, error: label + " border 宽度不是可解释的有限 px 值" };
    }
    const paddingRect = {
      left: borderRect.left + borderWidths.left,
      top: borderRect.top + borderWidths.top,
      right: borderRect.right - borderWidths.right,
      bottom: borderRect.bottom - borderWidths.bottom,
    };
    const width = paddingRect.right - paddingRect.left;
    const height = paddingRect.bottom - paddingRect.top;
    if (
      [...Object.values(paddingRect), ...Object.values(clientRect), width, height].some((value) => !Number.isFinite(value))
    ) {
      return { roundedClip: null, effectiveClientRect: null, error: label + " client/padding 边界不是有限数值" };
    }
    if (width <= 0 || height <= 0) {
      return { roundedClip: null, error: label + " client 区与 border/padding 边界关系无法安全证明" };
    }
    const effectiveClientRect = {
      left: Math.max(clientRect.left, paddingRect.left),
      top: Math.max(clientRect.top, paddingRect.top),
      right: Math.min(clientRect.right, paddingRect.right),
      bottom: Math.min(clientRect.bottom, paddingRect.bottom),
    };
    if (
      Object.values(effectiveClientRect).some((value) => !Number.isFinite(value)) ||
      effectiveClientRect.right <= effectiveClientRect.left ||
      effectiveClientRect.bottom <= effectiveClientRect.top
    ) {
      return { roundedClip: null, effectiveClientRect: null, error: label + " client/padding 边界没有有限正面积交集" };
    }
    const outer = {
      topLeft: radiusPairs[0],
      topRight: radiusPairs[1],
      bottomRight: radiusPairs[2],
      bottomLeft: radiusPairs[3],
    };
    const inner = {
      topLeft: {
        x: Math.max(0, outer.topLeft.x - borderWidths.left),
        y: Math.max(0, outer.topLeft.y - borderWidths.top),
      },
      topRight: {
        x: Math.max(0, outer.topRight.x - borderWidths.right),
        y: Math.max(0, outer.topRight.y - borderWidths.top),
      },
      bottomRight: {
        x: Math.max(0, outer.bottomRight.x - borderWidths.right),
        y: Math.max(0, outer.bottomRight.y - borderWidths.bottom),
      },
      bottomLeft: {
        x: Math.max(0, outer.bottomLeft.x - borderWidths.left),
        y: Math.max(0, outer.bottomLeft.y - borderWidths.bottom),
      },
    };
    const horizontalPairs = [
      inner.topLeft.x + inner.topRight.x,
      inner.bottomLeft.x + inner.bottomRight.x,
    ];
    const verticalPairs = [
      inner.topLeft.y + inner.bottomLeft.y,
      inner.topRight.y + inner.bottomRight.y,
    ];
    if (
      Object.values(inner).some((pair) => pair.x > width / 2 + 0.02 || pair.y > height / 2 + 0.02) ||
      horizontalPairs.some((sum) => sum > width + 0.02) ||
      verticalPairs.some((sum) => sum > height + 0.02)
    ) {
      return { roundedClip: null, error: label + " used border-radius 超出可证明范围" };
    }
    return {
      roundedClip: {
        paddingRect,
        borderWidths,
        outerRadii: outer,
        innerRadii: inner,
      },
      effectiveClientRect,
      error: null,
    };
  };
  const pointInsideRoundedClip = (x, y, roundedClip) => {
    const rect = roundedClip.paddingRect;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return false;
    const corners = [
      { left: true, top: true, radius: roundedClip.innerRadii.topLeft, cx: rect.left + roundedClip.innerRadii.topLeft.x, cy: rect.top + roundedClip.innerRadii.topLeft.y },
      { left: false, top: true, radius: roundedClip.innerRadii.topRight, cx: rect.right - roundedClip.innerRadii.topRight.x, cy: rect.top + roundedClip.innerRadii.topRight.y },
      { left: false, top: false, radius: roundedClip.innerRadii.bottomRight, cx: rect.right - roundedClip.innerRadii.bottomRight.x, cy: rect.bottom - roundedClip.innerRadii.bottomRight.y },
      { left: true, top: false, radius: roundedClip.innerRadii.bottomLeft, cx: rect.left + roundedClip.innerRadii.bottomLeft.x, cy: rect.bottom - roundedClip.innerRadii.bottomLeft.y },
    ];
    for (const corner of corners) {
      if (corner.radius.x === 0 || corner.radius.y === 0) continue;
      const inCornerX = corner.left ? x < corner.cx : x > corner.cx;
      const inCornerY = corner.top ? y < corner.cy : y > corner.cy;
      if (!inCornerX || !inCornerY) continue;
      const dx = (x - corner.cx) / corner.radius.x;
      const dy = (y - corner.cy) / corner.radius.y;
      if (dx * dx + dy * dy > 1) return false;
    }
    return true;
  };
  const rectInsideRoundedClip = (rect, roundedClip) =>
    [
      [rect.x, rect.y],
      [rect.x + rect.width, rect.y],
      [rect.x, rect.y + rect.height],
      [rect.x + rect.width, rect.y + rect.height],
    ].every(([x, y]) => pointInsideRoundedClip(x, y, roundedClip));
  return {
    measurementIdentity,
    attemptToken,
    nodes: nodes.map((element, index) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const isField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
      const hasValue = isField && element.value !== "";
      const hasPlaceholder = isField && element.placeholder !== "";
      const usesPlaceholder = hasPlaceholder && !hasValue;
      const isSvg = typeof SVGElement !== "undefined" && element instanceof SVGElement;
      const ownOpacity = Number.parseFloat(style.opacity);
      const tag = element.tagName.toLowerCase();
      const isOwnOpacityTextCandidate =
        ${JSON.stringify(includeOwnOpacityTextProof)} &&
        Number.isFinite(ownOpacity) &&
        ownOpacity > 0 &&
        ownOpacity < 1 &&
        !isField &&
        !isSvg &&
        pseudo === null &&
        !ownOpacityTextDisallowedTags.includes(tag) &&
        element.namespaceURI === "http://www.w3.org/1999/xhtml" &&
        !tag.includes("-") &&
        element.isContentEditable === false;
      let ownTextRangeProbe = null;
      let ownTextRangeRects = null;
      let probeText = includeText && !useOwnTextRanges ? String(element.textContent ?? "") : "";
      if (useOwnTextRanges) {
        const ownTextUnsupportedReason = isField
          ? "form-control"
          : isSvg
            ? "svg"
            : pseudo !== null
              ? "pseudo"
              : element.isContentEditable !== false
                ? "editable-or-unknown"
                : element.namespaceURI !== "http://www.w3.org/1999/xhtml"
                  ? "non-html"
                  : tag !== "p" && tag !== "li"
                    ? "not-p-or-li"
                    : null;
        const directTextNodes = ownTextUnsupportedReason
          ? []
          : Array.from(element.childNodes ?? []).filter(
              (child) => child.nodeType === 3 && String(child.textContent ?? "").trim() !== "",
            );
        ownTextRangeRects = [];
        if (!ownTextUnsupportedReason) {
          if (includeText) probeText = directTextNodes.map((node) => String(node.textContent ?? "")).join("");
          for (const textNode of directTextNodes) {
            const range = document.createRange();
            range.selectNode(textNode);
            ownTextRangeRects.push(
              ...Array.from(range.getClientRects()).map((box) => ({
                x: box.x,
                y: box.y,
                width: box.width,
                height: box.height,
              })),
            );
          }
        }
        ownTextRangeProbe = {
          source: "direct-text-nodes",
          status: ownTextUnsupportedReason ? "unsupported" : directTextNodes.length === 0 ? "empty" : "captured",
          reason: ownTextUnsupportedReason,
          textNodeCount: directTextNodes.length,
        };
      }
      const ownOpacityTextProof =
        isOwnOpacityTextCandidate
          ? (() => {
              const children = Array.from(element.childNodes ?? []);
              const pseudoContent = (selector) => {
                const content = getComputedStyle(element, selector).content;
                return content === "none" || content === "normal" ? content : "generated";
              };
              return {
                isContentEditable: element.isContentEditable === true,
                isOrdinaryHtmlElement:
                  element.namespaceURI === "http://www.w3.org/1999/xhtml" && !tag.includes("-"),
                hasShadowRoot: element.shadowRoot != null,
                childElementCount: element.childElementCount,
                directTextOnly: children.every((child) => child.nodeType === 3),
                hasNonEmptyDirectText: children.some(
                  (child) => child.nodeType === 3 && String(child.textContent ?? "").trim() !== "",
                ),
                backgroundColor: style.backgroundColor,
                backgroundImage: style.backgroundImage,
                boxShadow: style.boxShadow,
                textShadow: style.textShadow,
                borderWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
                outlineStyle: style.outlineStyle,
                outlineWidth: style.outlineWidth,
                beforeContent: pseudoContent("::before"),
                afterContent: pseudoContent("::after"),
                display: style.display,
                clipPath: style.clipPath,
                maskImage: style.maskImage || style.webkitMaskImage || "none",
                webkitTextStrokeWidth: style.webkitTextStrokeWidth,
                textEmphasisStyle: style.textEmphasisStyle,
              };
            })()
          : null;
      const costNoteLinkDecorationIdentity = includeCostNoteLinkDecorationProof
        ? (() => {
            const selectorExact = selector === "#costEstimateNote a";
            const pseudoFree = pseudo === null;
            if (!selectorExact) {
              return { valid: false, identity: { selectorExact, pseudoFree }, reason: "selector-not-opted-in" };
            }
            if (!pseudoFree) {
              return { valid: false, identity: { selectorExact, pseudoFree }, reason: "pseudo-not-supported" };
            }
            const children = Array.from(element.childNodes ?? []);
            const directTextNodes = children.filter((child) => child.nodeType === 3);
            let withinCostEstimateNote = false;
            for (let current = element; current?.nodeType === 1; current = current.parentElement) {
              if (current.id === "costEstimateNote") {
                withinCostEstimateNote = true;
                break;
              }
            }
            const identity = {
              selectorExact,
              pseudoFree,
              isHtmlAnchor: tag === "a" && element.namespaceURI === "http://www.w3.org/1999/xhtml",
              withinCostEstimateNote,
              hasHref: element.hasAttribute("href"),
              isContentEditable: element.isContentEditable === false,
              hasShadowRoot: element.shadowRoot != null,
              childElementCount: element.childElementCount,
              directTextOnly: children.length > 0 && children.every((child) => child.nodeType === 3),
              directTextNodeCount: directTextNodes.length,
              hasNonEmptyDirectText: directTextNodes.some((child) => String(child.textContent ?? "").trim() !== ""),
            };
            const reason = !identity.isHtmlAnchor
              ? "not-an-html-anchor"
              : !identity.withinCostEstimateNote
                ? "outside-cost-estimate-note"
                : !identity.hasHref
                  ? "missing-href"
                  : !identity.isContentEditable
                    ? "editable-or-unknown"
                    : identity.hasShadowRoot || identity.childElementCount !== 0 || !identity.directTextOnly
                      ? "not-direct-text-leaf"
                      : !identity.hasNonEmptyDirectText
                        ? "empty-direct-text"
                        : null;
            return { valid: reason === null, identity, reason };
          })()
        : null;
      let textRects = [];
      let rawTextRects = null;
      let textRectClipping = null;
      if (isField) {
        if (useOwnTextRanges) {
          textRects = [];
        } else {
          textRects = [{
            x: rect.x + element.clientLeft,
            y: rect.y + element.clientTop,
            width: element.clientWidth,
            height: element.clientHeight,
          }];
        }
      } else {
        let rangeRects;
        if (useOwnTextRanges) {
          rangeRects = ownTextRangeRects;
        } else {
          const range = document.createRange();
          range.selectNodeContents(element);
          rangeRects = Array.from(range.getClientRects()).map((box) => ({
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
          }));
        }
        if (isSvg) {
          textRects = rangeRects;
        } else {
          rawTextRects = rangeRects;
          const clips = [];
          const discardedRawRectIndexes = new Set();
          const roundedRejectedRawRectIndexes = new Set();
          const roundedClips = [];
          const roundedErrors = [];
          let visible = rangeRects.map((box, index) => ({ index, ...box }));
          let unsupportedReason = null;
          let transformReason = null;
          for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
            const currentStyle = getComputedStyle(current);
            const overflowX = currentStyle.overflowX || "visible";
            const overflowY = currentStyle.overflowY || "visible";
            const clipX = overflowX !== "visible";
            const clipY = overflowY !== "visible";
            if (!transformReason && currentStyle.transform && currentStyle.transform !== "none") {
              transformReason = current.tagName.toLowerCase() + " transform=" + currentStyle.transform + " 影响文字矩形坐标";
            }
            if (!unsupportedReason && currentStyle.clipPath && currentStyle.clipPath !== "none") {
              unsupportedReason = current.tagName.toLowerCase() + " clip-path=" + currentStyle.clipPath + " 超出轴向矩形裁切范围";
            }
            const maskImage = currentStyle.maskImage || currentStyle.webkitMaskImage || "none";
            if (!unsupportedReason && maskImage !== "none") {
              unsupportedReason = current.tagName.toLowerCase() + " mask-image=" + maskImage + " 超出轴向矩形裁切范围";
            }
            if (!clipX && !clipY) continue;
            const currentRect = current.getBoundingClientRect();
            const clientRect = {
              left: currentRect.left + current.clientLeft,
              top: currentRect.top + current.clientTop,
              right: currentRect.left + current.clientLeft + current.clientWidth,
              bottom: currentRect.top + current.clientTop + current.clientHeight,
            };
            const rounded = readRoundedClip(current, currentStyle, currentRect, clientRect, clipX, clipY);
            if (rounded.error) roundedErrors.push(rounded.error);
            if (rounded.roundedClip) roundedClips.push(rounded.roundedClip);
            const clipEvidence = {
              tag: current.tagName.toLowerCase(),
              id: current.id || null,
              className: typeof current.className === "string" ? current.className.slice(0, 160) : null,
              overflowX,
              overflowY,
              clientRect,
              ...(rounded.roundedClip ? { effectiveClientRect: rounded.effectiveClientRect, roundedClip: rounded.roundedClip } : {}),
            };
            clips.push(clipEvidence);
            visible = visible.flatMap((box) => {
              const axisClientRect = rounded.roundedClip ? rounded.effectiveClientRect : clientRect;
              const left = clipX ? Math.max(box.x, axisClientRect.left) : box.x;
              const top = clipY ? Math.max(box.y, axisClientRect.top) : box.y;
              const right = clipX ? Math.min(box.x + box.width, axisClientRect.right) : box.x + box.width;
              const bottom = clipY ? Math.min(box.y + box.height, axisClientRect.bottom) : box.y + box.height;
              if (right <= left || bottom <= top) {
                discardedRawRectIndexes.add(box.index);
                return [];
              }
              return [{ index: box.index, x: left, y: top, width: right - left, height: bottom - top }];
            });
          }
          if (!unsupportedReason && clips.length > 0 && transformReason) unsupportedReason = transformReason;
          if (!unsupportedReason && roundedErrors.length > 0) unsupportedReason = roundedErrors[0];
          if (!unsupportedReason && roundedClips.length > 0) {
            for (const box of visible) {
              if (roundedClips.every((roundedClip) => rectInsideRoundedClip(box, roundedClip))) continue;
              roundedRejectedRawRectIndexes.add(box.index);
            }
            if (roundedRejectedRawRectIndexes.size > 0) {
              unsupportedReason = "最终 overflow 可见矩形有文字片段可能进入圆角裁切区";
            }
          }
          if (unsupportedReason) visible = [];
          textRects = visible.map(({ x, y, width, height }) => ({ x, y, width, height }));
          textRectClipping = {
            source: "Range.getClientRects intersected with axis overflow client rects",
            clips,
            discardedRawRectIndexes: [...discardedRawRectIndexes].sort((left, right) => left - right),
            roundedRejectedRawRectIndexes: [...roundedRejectedRawRectIndexes].sort((left, right) => left - right),
            unsupportedReason,
          };
        }
      }
      const chain = readChain(
        element,
        Boolean(ownOpacityTextProof) || costNoteLinkDecorationIdentity?.valid === true,
      );
      const costNoteLinkDecorationProof =
        costNoteLinkDecorationIdentity === null
          ? null
          : costNoteLinkDecorationIdentity.valid === false
            ? { ...costNoteLinkDecorationIdentity, chain: null }
            : (() => {
                const decorationChain = chain.map((entry) => ({
                  tag: entry.tag,
                  textDecorationLine:
                    typeof entry.textDecorationLine === "string" ? entry.textDecorationLine : null,
                }));
                let reason = null;
                if (
                  decorationChain.length === 0 ||
                  decorationChain[decorationChain.length - 1].tag !== "html"
                ) {
                  reason = "chain-does-not-reach-root";
                } else if (
                  decorationChain.some(({ textDecorationLine }) => textDecorationLine === null || textDecorationLine === "")
                ) {
                  reason = "missing-text-decoration-value";
                } else if (!["none", "underline"].includes(decorationChain[0].textDecorationLine)) {
                  reason = "unsupported-target-decoration";
                } else if (decorationChain.slice(1).some(({ textDecorationLine }) => textDecorationLine !== "none")) {
                  reason = "ancestor-decoration-not-none";
                }
                return {
                  valid: reason === null,
                  identity: costNoteLinkDecorationIdentity.identity,
                  chain: decorationChain,
                  reason,
                };
              })();
      const pseudoStyle = pseudo ? getComputedStyle(element, pseudo) : null;
      return {
        index,
        ...__safeIdentity(state, element),
        ...(attemptTextSnapshots[index] === null || attemptTextSnapshots[index] === undefined
          ? {}
          : { dynamicTextSnapshot: __limitedDynamicTextSummary(attemptTextSnapshots[index]) }),
        ...(${JSON.stringify(includeText)} ? { text: probeText } : {}),
        ...(ownTextRangeProbe === null ? {} : { ownTextRangeProbe }),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        client: { left: element.clientLeft, top: element.clientTop, width: element.clientWidth, height: element.clientHeight },
        textRects,
        ...(rawTextRects === null ? {} : { rawTextRects, textRectClipping }),
        hasValue,
        hasPlaceholder,
        usesPlaceholder,
        isSvg,
        ...(ownOpacityTextProof ? { ownOpacityTextProof } : {}),
        ...(costNoteLinkDecorationProof === null ? {} : { costNoteLinkDecorationProof }),
        computed: {
          color: style.color,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          opacity: style.opacity,
          textShadow: style.textShadow,
          textFillColor: style.webkitTextFillColor,
          visibility: style.visibility,
          display: style.display,
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
        },
        pseudo: pseudoStyle
          ? {
              color: pseudoStyle.color,
              opacity: pseudoStyle.opacity,
              fontSize: pseudoStyle.fontSize,
              textFillColor: pseudoStyle.webkitTextFillColor,
            }
          : null,
        chain,
        scroll: { x: window.scrollX, y: window.scrollY },
        dpr: window.devicePixelRatio || 1,
      };
    }),
  };
})()`;
}

/** 每个当前可采样矩形的五点遮挡证据；不对像素区域作完整无遮挡推断。 */
function buildOcclusionProbeSource(selector, index, rects, hiddenToken) {
  return `// skinProbe: occlusion-probe
(() => {
  const selector = ${JSON.stringify(selector)};
  const index = ${JSON.stringify(index)};
  const rects = ${JSON.stringify(rects)};
  const token = ${JSON.stringify(hiddenToken)};
${IDENTITY_SOURCE}
  const state = window[${JSON.stringify(MEASUREMENT_STASH_GLOBAL)}] ?? null;
  const stash = state ? state.sessions.get(token) : null;
  if (!stash) return { identityValid: false, reason: "隐藏样本暂存不存在", rects: [] };
  const checked = __attemptIdentity(state, stash.attemptToken);
  if (!checked.valid) return { identityValid: false, reason: checked.reason, rects: [] };
  const host = Array.from(document.querySelectorAll(selector))[index];
  if (!host || host !== stash.target) {
    return { identityValid: false, reason: "遮挡探针宿主与隐藏样本不一致", rects: [] };
  }
  if (typeof document.elementFromPoint !== "function") {
    return { identityValid: true, error: "document.elementFromPoint 不可用", rects: [] };
  }
  const isField = host.tagName === "INPUT" || host.tagName === "TEXTAREA";
  const hostStyle = isField ? getComputedStyle(host) : null;
  const hostRect = isField ? host.getBoundingClientRect() : null;
  const radiusForCorner = (property) => {
    if (!isField || !hostStyle || !hostRect) return 0;
    const value = String(hostStyle?.[property] ?? "");
    const radii = value.trim().split(" ").filter(Boolean).map((part, partIndex) => {
      const amount = Number.parseFloat(part);
      if (!Number.isFinite(amount) || amount <= 0) return 0;
      const extent = partIndex === 0 ? hostRect.width : hostRect.height;
      return part.endsWith("%") ? (amount * extent) / 100 : amount;
    });
    return Math.min(Math.max(0, ...radii), hostRect.width / 2, hostRect.height / 2);
  };
  const sampled = [];
  try {
    for (const [rectIndex, rect] of rects.entries()) {
      const inset = Math.min(2, rect.width / 4, rect.height / 4);
      // Field text uses the rectangular client box; move probe corners inside rounded controls.
      const insetFor = (property) =>
        Math.min(
          rect.width / 4,
          rect.height / 4,
          Math.max(inset, Math.ceil(radiusForCorner(property) * (1 - Math.SQRT1_2))),
        );
      const points = [
        ["center", rect.x + rect.width / 2, rect.y + rect.height / 2],
        ["topLeft", rect.x + insetFor("borderTopLeftRadius"), rect.y + insetFor("borderTopLeftRadius")],
        ["topRight", rect.x + rect.width - insetFor("borderTopRightRadius"), rect.y + insetFor("borderTopRightRadius")],
        ["bottomLeft", rect.x + insetFor("borderBottomLeftRadius"), rect.y + rect.height - insetFor("borderBottomLeftRadius")],
        ["bottomRight", rect.x + rect.width - insetFor("borderBottomRightRadius"), rect.y + rect.height - insetFor("borderBottomRightRadius")],
      ];
      sampled.push({
        rectIndex,
        points: points.map(([kind, x, y]) => {
          const top = document.elementFromPoint(x, y);
          return {
            kind,
            x,
            y,
            top: top ? __safeIdentity(state, top) : null,
            withinHost: Boolean(top && (top === host || host.contains(top))),
          };
        }),
      });
    }
  } catch (error) {
    return { identityValid: true, error: "elementFromPoint 调用失败", rects: [] };
  }
  return { identityValid: true, scroll: { x: window.scrollX, y: window.scrollY }, rects: sampled };
})()`;
}

/** computed CSS 颜色 → sRGB/alpha：浏览器自身 1×1 canvas 解析，双哨兵防静默沿用。 */
function buildColorParseSource(value) {
  return `// skinProbe: color-parse
(() => {
  const value = ${JSON.stringify(value)};
  const sentinels = ${JSON.stringify(COLOR_SENTINELS)};
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return { ok: false, reason: "无法取得 2d 上下文" };
  const readBacks = sentinels.map((sentinel) => {
    ctx.fillStyle = sentinel;
    ctx.fillStyle = value;
    return ctx.fillStyle;
  });
  const rejected = readBacks.every((readBack, index) => readBack === sentinels[index]);
  if (rejected) return { ok: false, reason: "浏览器拒绝该 CSS 颜色值（fillStyle 未更新）" };
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  return { ok: true, rgb: [data[0] / 255, data[1] / 255, data[2] / 255], alpha: data[3] / 255, readBack: readBacks[0] };
})()`;
}

/**
 * 隐藏前景（文字填充 / 自身填充 / SVG 绘制），返回原值供恢复。
 *
 * 传 attemptToken 时（正式路径）先与本次角色尝试的基准集合比对：基准只在尝试开始
 * 时建立一次，隐藏不再按当前 DOM 重新采样——否则"前面已测成员被替换"会被悄悄接受。
 * 不传 attemptToken 时走旧接口（selector/index 直取，测试与诊断用）。
 */
const COST_NOTE_LINK_DECORATION_IDENTITY_SOURCE = `
  const __costNoteLinkDecorationIdentity = (element, selector, pseudo) => {
    const selectorExact = selector === "#costEstimateNote a";
    const pseudoFree = pseudo === null;
    if (!selectorExact) return { valid: false, identity: { selectorExact, pseudoFree }, reason: "selector-not-opted-in" };
    if (!pseudoFree) return { valid: false, identity: { selectorExact, pseudoFree }, reason: "pseudo-not-supported" };
    const children = Array.from(element.childNodes ?? []);
    const directTextNodes = children.filter((child) => child.nodeType === 3);
    let withinCostEstimateNote = false;
    for (let current = element; current?.nodeType === 1; current = current.parentElement) {
      if (current.id === "costEstimateNote") {
        withinCostEstimateNote = true;
        break;
      }
    }
    const identity = {
      selectorExact,
      pseudoFree,
      isHtmlAnchor: element.tagName.toLowerCase() === "a" && element.namespaceURI === "http://www.w3.org/1999/xhtml",
      withinCostEstimateNote,
      hasHref: element.hasAttribute("href"),
      isContentEditable: element.isContentEditable === false,
      hasShadowRoot: element.shadowRoot != null,
      childElementCount: element.childElementCount,
      directTextOnly: children.length > 0 && children.every((child) => child.nodeType === 3),
      directTextNodeCount: directTextNodes.length,
      hasNonEmptyDirectText: directTextNodes.some((child) => String(child.textContent ?? "").trim() !== ""),
    };
    const reason = !identity.isHtmlAnchor
      ? "not-an-html-anchor"
      : !identity.withinCostEstimateNote
        ? "outside-cost-estimate-note"
        : !identity.hasHref
          ? "missing-href"
          : !identity.isContentEditable
            ? "editable-or-unknown"
            : identity.hasShadowRoot || identity.childElementCount !== 0 || !identity.directTextOnly
              ? "not-direct-text-leaf"
              : !identity.hasNonEmptyDirectText
                ? "empty-direct-text"
                : null;
    return { valid: reason === null, identity, reason };
  };
`;

function buildHideSource(selector, index, mode, attemptToken = null, identityContext = null) {
  const enableCostNoteLinkDecorationHide =
    mode === "text" &&
    attemptToken !== null &&
    selector === "#costEstimateNote a" &&
    identityContext?.roleId === "cost.note-link" &&
    identityContext?.stateId === "dashboard-default";
  if (attemptToken === null) {
    return `// skinProbe: hide
(() => {
  const element = document.querySelectorAll(${JSON.stringify(selector)})[${JSON.stringify(index)}];
  if (!element) return { ok: false, reason: "元素在隐藏前已消失" };
  const style = element.style;
  const originals = {};
  const remember = (property) => {
    originals[property] = style.getPropertyValue(property);
    originals[property + "Priority"] = style.getPropertyPriority(property);
  };
  if (${JSON.stringify(mode)} === "text") {
    remember("-webkit-text-fill-color");
    remember("text-shadow");
    style.setProperty("-webkit-text-fill-color", "transparent");
    style.setProperty("text-shadow", "none");
  } else if (${JSON.stringify(mode)} === "svg") {
    remember("opacity");
    style.setProperty("opacity", "0");
  } else {
    remember("background-color");
    remember("box-shadow");
    style.setProperty("background-color", "transparent");
    style.setProperty("box-shadow", "none");
  }
  return { ok: true, originals };
})()`;
  }
  return `// skinProbe: hide
(() => {
${IDENTITY_SOURCE}
${enableCostNoteLinkDecorationHide ? COST_NOTE_LINK_DECORATION_IDENTITY_SOURCE : ""}
  const state = __stash();
  const checked = __attemptIdentity(state, ${JSON.stringify(attemptToken)});
  if (!checked.valid) return { ok: false, identityInvalid: true, reason: checked.reason };
  const element = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))[${JSON.stringify(index)}];
  if (!element) return { ok: false, reason: "元素在隐藏前已消失" };
  const identityId = __idFor(state, element);
  const costNoteLinkDecorationProof = ${enableCostNoteLinkDecorationHide}
    ? (() => {
        const identity = __costNoteLinkDecorationIdentity(element, ${JSON.stringify(selector)}, null);
        if (!identity.valid) return { ...identity, chain: null };
        const chain = [];
        for (let current = element; current && current.nodeType === 1; current = current.parentElement) {
          const line = getComputedStyle(current).textDecorationLine;
          chain.push({ tag: current.tagName.toLowerCase(), textDecorationLine: typeof line === "string" ? line : null });
        }
        let reason = null;
        if (chain.length === 0 || chain[chain.length - 1].tag !== "html") {
          reason = "chain-does-not-reach-root";
        } else if (chain.some(({ textDecorationLine }) => textDecorationLine === null || textDecorationLine === "")) {
          reason = "missing-text-decoration-value";
        } else if (!["none", "underline"].includes(chain[0].textDecorationLine)) {
          reason = "unsupported-target-decoration";
        } else if (chain.slice(1).some(({ textDecorationLine }) => textDecorationLine !== "none")) {
          reason = "ancestor-decoration-not-none";
        }
        return { valid: reason === null, identity: identity.identity, chain, reason };
      })()
    : null;
  if (costNoteLinkDecorationProof && !costNoteLinkDecorationProof.valid) {
    return { ok: false, identityInvalid: true, reason: costNoteLinkDecorationProof.reason, costNoteLinkDecorationProof };
  }
  const style = element.style;
  const originalStyleAttributePresent = element.hasAttribute("style");
  const originals = {};
  const remember = (property) => {
    originals[property] = style.getPropertyValue(property);
    originals[property + "Priority"] = style.getPropertyPriority(property);
  };
  const token = "h" + state.nextToken++;
  if (${JSON.stringify(mode)} === "text") {
    remember("-webkit-text-fill-color");
    remember("text-shadow");
    if (costNoteLinkDecorationProof?.chain[0].textDecorationLine === "underline") {
      remember("text-decoration-line");
    }
  } else if (${JSON.stringify(mode)} === "svg") {
    remember("opacity");
  } else {
    remember("background-color");
    remember("box-shadow");
  }
  const stash = {
    attemptToken: ${JSON.stringify(attemptToken)},
    selector: ${JSON.stringify(selector)},
    index: ${JSON.stringify(index)},
    mode: ${JSON.stringify(mode)},
    target: element,
    targetId: identityId,
    originalStyleAttributePresent,
    originals,
    decoration: null,
  };
  state.sessions.set(token, stash);
  if (${JSON.stringify(mode)} === "text") {
    style.setProperty("-webkit-text-fill-color", "transparent");
    style.setProperty("text-shadow", "none");
    if (costNoteLinkDecorationProof?.chain[0].textDecorationLine === "underline") {
      style.setProperty("text-decoration-line", "none", "important");
    }
  } else if (${JSON.stringify(mode)} === "svg") {
    style.setProperty("opacity", "0");
  } else {
    style.setProperty("background-color", "transparent");
    style.setProperty("box-shadow", "none");
  }
  const costNoteLinkDecoration = costNoteLinkDecorationProof
    ? {
        changed: costNoteLinkDecorationProof.chain[0].textDecorationLine === "underline",
        installed: getComputedStyle(element).textDecorationLine === "none",
        computedTextDecorationLine: getComputedStyle(element).textDecorationLine,
      }
    : null;
  if (costNoteLinkDecoration && !costNoteLinkDecoration.installed) {
    return {
      ok: false,
      reason: "cost-note-link-decoration-hide-unverified",
      originals,
      token,
      identityId,
      costNoteLinkDecorationProof,
      costNoteLinkDecoration,
    };
  }
  const decoration = __installDecoration(element, token, ${JSON.stringify(mode)});
  stash.decoration = decoration.stash;
  // 隐藏写完之后立刻验一次隔离有效性：身份没变也可能隔离失败（子节点自带
  // -webkit-text-fill-color 会覆盖继承），那种样本是污染样本，不能当真实低对比
  const isolation = __isolationState(element, ${JSON.stringify(mode)});
  return {
    ok: true,
    originals,
    token,
    identityId,
    isolation,
    decorationIsolation: decoration.evidence,
    ...(costNoteLinkDecorationProof ? { costNoteLinkDecorationProof, costNoteLinkDecoration } : {}),
  };
})()`;
}

/**
 * 恢复隐藏：按原值逐属性写回（原为空则移除）。
 *
 * 传 token（正式路径）时用暂存的元素引用恢复，并回报 identityValid：恢复对象是否
 * 仍是本次尝试基准里的那一个。inlineRestored 核对声明逐属性回值和缺失 style 属性的
 * 空属性清理（computed 相同但内联声明不同也算没恢复干净）——正式调用方必须消费此字段。
 */
function buildRestoreSource(tokenOrSelector, index, originals) {
  if (index === undefined && originals === undefined) {
    return `// skinProbe: restore
(() => {
${IDENTITY_SOURCE}
  const state = __stash();
  const stash = state.sessions.get(${JSON.stringify(tokenOrSelector)});
  if (!stash) return { ok: false, reason: "隐藏对象暂存不存在" };
  const checked = __attemptIdentity(state, stash.attemptToken);
  const restoreErrors = [];
  for (const [property, value] of Object.entries(stash.originals)) {
    if (property.endsWith("Priority")) continue;
    try {
      if (!__restoreDeclaration(stash.target.style, property, value, stash.originals[property + "Priority"] || "")) {
        restoreErrors.push(property + ": 内联声明未回到原值");
      }
    } catch (error) {
      restoreErrors.push(property + ": " + String(error?.message ?? error));
    }
  }
  const decorationCleanup = __cleanupDecoration(stash.decoration);
  restoreErrors.push(...decorationCleanup.errors);
  let styleAttributeRestored = false;
  try {
    styleAttributeRestored = __restoreStyleAttribute(stash.target, stash.originalStyleAttributePresent);
    if (!styleAttributeRestored) restoreErrors.push("style 属性存在性未恢复");
  } catch (error) {
    restoreErrors.push("style 属性恢复失败：" + String(error?.message ?? error));
  }
  const declarationsRestored = Object.entries(stash.originals).every(([property, value]) => {
    if (property.endsWith("Priority")) return true;
    return (
      stash.target.style.getPropertyValue(property) === value &&
      stash.target.style.getPropertyPriority(property) === (stash.originals[property + "Priority"] || "")
    );
  });
  const inlineRestored = declarationsRestored && styleAttributeRestored;
  return {
    ok: true,
    identityValid: checked.valid,
    inlineRestored,
    decorationRestored: decorationCleanup.restored,
    restoreErrors,
    reason: checked.reason,
  };
})()`;
  }
  // 旧接口（selector/index/originals）：测试与诊断用，不依赖页内暂存
  return `// skinProbe: restore
(() => {
  const element = document.querySelectorAll(${JSON.stringify(tokenOrSelector)})[${JSON.stringify(index)}];
  if (!element) return { ok: false, reason: "元素在恢复前已消失" };
  const style = element.style;
  const originals = ${JSON.stringify(originals ?? {})};
  for (const [property, value] of Object.entries(originals)) {
    if (property.endsWith("Priority")) continue;
    if (value) {
      style.setProperty(property, value, originals[property + "Priority"] || "");
    } else {
      style.removeProperty(property);
    }
  }
  return { ok: true };
})()`;
}

/**
 * 恢复核验：重算样式快照与几何，和隐藏前快照在 Node 侧逐项比对。
 *
 * 传 token（正式路径）时用暂存元素核验，回报 identityValid（核验对象是否仍是本次
 * 尝试基准里的那一个）与 inlineRestored（声明逐属性回值且不存在空 style 残留）。
 * 不传 index 走旧接口（selector/index 直取，测试与诊断用）。
 */
function buildVerifySource(selectorOrToken, index) {
  if (index === undefined) {
    return `// skinProbe: verify
(() => {
${IDENTITY_SOURCE}
  const state = __stash();
  const token = ${JSON.stringify(selectorOrToken)};
  const stash = state.sessions.get(token);
  if (!stash) return { ok: false, differences: ["隐藏对象暂存不存在"] };
  const checked = __attemptIdentity(state, stash.attemptToken);
  const element = stash.target;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const declarationsRestored = Object.entries(stash.originals).every(([property, value]) => {
    if (property.endsWith("Priority")) return true;
    return (
      element.style.getPropertyValue(property) === value &&
      element.style.getPropertyPriority(property) === (stash.originals[property + "Priority"] || "")
    );
  });
  const styleAttributeRestored = __styleAttributeRestored(element, stash.originalStyleAttributePresent);
  const inlineRestored = declarationsRestored && styleAttributeRestored;
  const decorationRestored = __decorationRestored(stash.decoration);
  if (inlineRestored && decorationRestored) state.sessions.delete(token);
  return {
    ok: true,
    identityValid: checked.valid,
    inlineRestored,
    decorationRestored,
    reason: checked.reason,
    after: {
      color: style.color,
      textFillColor: style.webkitTextFillColor,
      textShadow: style.textShadow,
      backgroundColor: style.backgroundColor,
      opacity: style.opacity,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    },
  };
})()`;
  }
  return `// skinProbe: verify
(() => {
  const element = document.querySelectorAll(${JSON.stringify(selectorOrToken)})[${JSON.stringify(index)}];
  if (!element) return { ok: false, differences: ["元素在恢复后消失"] };
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return {
    ok: true,
    after: {
      color: style.color,
      textFillColor: style.webkitTextFillColor,
      textShadow: style.textShadow,
      backgroundColor: style.backgroundColor,
      opacity: style.opacity,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    },
  };
})()`;
}

/**
 * 收尾：释放本次角色尝试的页内暂存。
 *
 * 正常路径每个节点的隐藏样本由 verify 自行删除，但**失效重做、第二次失效、
 * 扫描/恢复抛异常**都会跳过 verify，留下带旧目标强引用的 session；attempts 里
 * 的匹配集合与子树引用此前也从不释放。重复测量/页面重绘会持续积累已脱离 DOM 的
 * 节点及其子树，违反"所有出口都要收尾"。
 *
 * 顺序：先按原值恢复尚未恢复的真实目标（样式不能只丢引用），再按尝试 token 删除
 * 本轮 sessions 与 attempts。只删属于这个 token 的条目，不碰其他会话。
 */
function buildReleaseAttemptSource(attemptToken) {
  return `// skinProbe: release-attempt
(() => {
${IDENTITY_SOURCE}
  const state = window[${JSON.stringify(MEASUREMENT_STASH_GLOBAL)}] ?? null;
  if (!state) return { ok: true, restoredTargets: 0, releasedSessions: 0, attemptReleased: false };
  const token = ${JSON.stringify(attemptToken)};
  let restoredTargets = 0;
  let releasedSessions = 0;
  const failures = [];
  for (const [sessionToken, stash] of Array.from(state.sessions.entries())) {
    if (stash.attemptToken !== token) continue;
    for (const [property, value] of Object.entries(stash.originals)) {
      if (property.endsWith("Priority")) continue;
      try {
        if (!__restoreDeclaration(stash.target.style, property, value, stash.originals[property + "Priority"] || "")) {
          failures.push(property + ": 内联声明未回到原值");
        }
      } catch (error) {
        failures.push(property + ": " + String(error?.message ?? error));
      }
    }
    try {
      if (!__restoreStyleAttribute(stash.target, stash.originalStyleAttributePresent)) {
        failures.push("style 属性存在性未恢复");
      }
    } catch (error) {
      failures.push("style 属性恢复失败：" + String(error?.message ?? error));
    }
    const decorationCleanup = __cleanupDecoration(stash.decoration);
    if (!decorationCleanup.restored) failures.push("装饰隔离未完全清理");
    failures.push(...decorationCleanup.errors);
    restoredTargets += 1;
    state.sessions.delete(sessionToken);
    releasedSessions += 1;
  }
  const attemptReleased = state.attempts.delete(token);
  return {
    ok: failures.length === 0,
    restoredTargets,
    releasedSessions,
    attemptReleased,
    ...(failures.length > 0 ? { failures } : {}),
  };
})()`;
}

/** 收尾调用方：把"补恢复"记进诊断，失败不吞。 */
async function releaseAttempt(page, diagnostics, roleId, attemptToken) {
  const result = await page.evaluate(buildReleaseAttemptSource(attemptToken));
  if (result && result.restoredTargets > 0) {
    diagnostics.notes.push(
      `${roleId}: 收尾释放时补恢复了 ${result.restoredTargets} 个未走完恢复核验的目标（尝试 ${attemptToken}）`,
    );
  }
  if (result?.ok === false) {
    diagnostics.restoration.inlineRestoreFailures.push(
      `${roleId}: 收尾释放仍有未恢复声明或装饰隔离（${(result.failures ?? []).join("；")}）`,
    );
  }
  return result;
}

/**
 * 滚动会话：把窗口与所有可能被 scrollIntoView 移动的滚动容器当前位置存进页内
 * 暂存区（元素引用不序列化，恢复在同页执行）。只登记"当前已有偏移"的容器会漏掉
 * 测量前停在 0、测量中被带走的容器，所以按"可滚动余量"登记，与当前偏移无关。
 * 测量结束必须调用 restore —— 测量不得改变应用滚动状态。
 */
function buildBeginScrollSessionSource() {
  return `// skinProbe: scroll-begin
(() => {
  const key = ${JSON.stringify(SCROLL_STASH_GLOBAL)};
  if (window[key]) return { ok: true, alreadyActive: true };
  const containers = [];
  for (const node of document.querySelectorAll("*")) {
    let overflowX = "visible";
    let overflowY = "visible";
    try {
      const style = getComputedStyle(node);
      overflowX = style.overflowX;
      overflowY = style.overflowY;
    } catch (error) {
      overflowX = "auto";
      overflowY = "auto";
    }
    // visible/clip 不是滚动盒：scrollIntoView 不会移动它们（读不到样式时按可
    // 滚动登记——宁可多存一个，不许漏存）。
    const scrollableX = overflowX !== "visible" && overflowX !== "clip";
    const scrollableY = overflowY !== "visible" && overflowY !== "clip";
    if (!scrollableX && !scrollableY) continue;
    const canScrollX = scrollableX && (node.scrollWidth > node.clientWidth || node.scrollLeft !== 0);
    const canScrollY = scrollableY && (node.scrollHeight > node.clientHeight || node.scrollTop !== 0);
    if (!canScrollX && !canScrollY) continue;
    containers.push({ node, top: node.scrollTop, left: node.scrollLeft });
  }
  Object.defineProperty(window, ${JSON.stringify(SCROLL_STASH_GLOBAL)}, {
    value: { x: window.scrollX, y: window.scrollY, containers },
    configurable: true,
  });
  return { ok: true, alreadyActive: false, registeredContainers: containers.length };
})()`;
}

/** 滚动会话恢复：窗口与容器逐个回到原位，并逐个核验（不一致要报出来，不静默）。 */
function buildRestoreScrollSource() {
  return `// skinProbe: scroll-restore
(() => {
  const stash = window[${JSON.stringify(SCROLL_STASH_GLOBAL)}];
  if (!stash) return { ok: false, reason: "滚动会话未开始" };
  window.scrollTo(stash.x, stash.y);
  for (const entry of stash.containers) {
    entry.node.scrollTop = entry.top;
    entry.node.scrollLeft = entry.left;
  }
  const mismatches = [];
  if (window.scrollX !== stash.x || window.scrollY !== stash.y) {
    mismatches.push(
      "窗口滚动未还原（(" + stash.x + ", " + stash.y + ") → (" + window.scrollX + ", " + window.scrollY + ")）",
    );
  }
  for (const entry of stash.containers) {
    if (entry.node.scrollTop !== entry.top || entry.node.scrollLeft !== entry.left) {
      mismatches.push(
        "容器滚动未还原（" + entry.top + "/" + entry.left + " → " + entry.node.scrollTop + "/" + entry.node.scrollLeft + "）",
      );
    }
  }
  delete window[${JSON.stringify(SCROLL_STASH_GLOBAL)}];
  return { ok: true, restored: mismatches.length === 0, mismatches };
})()`;
}

/** 把元素滚动到视口中部（scrollIntoView 会连带处理内部滚动容器）。 */
function buildBringIntoViewSource(selector, index) {
  return `// skinProbe: bring-into-view
(() => {
  const element = document.querySelectorAll(${JSON.stringify(selector)})[${JSON.stringify(index)}];
  if (!element) return { ok: false, reason: "元素不存在" };
  const before = { x: window.scrollX, y: window.scrollY };
  element.scrollIntoView({ block: "center", inline: "center" });
  return {
    ok: true,
    scrolled: window.scrollX !== before.x || window.scrollY !== before.y,
    scroll: { x: window.scrollX, y: window.scrollY },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
})()`;
}

/** 逐带下滚：元素高于视口时分段测量（ sticky/越界都无法用整页截图绕开）。 */
function buildScrollBySource(deltaY) {
  return `// skinProbe: scroll-by
(() => { window.scrollBy(0, ${JSON.stringify(deltaY)}); return { x: window.scrollX, y: window.scrollY }; })()`;
}

/** 回到指定滚动位置（恢复核验要在同一几何位置上比对）。 */
function buildScrollToSource(scroll) {
  return `// skinProbe: scroll-to
(() => { window.scrollTo(${JSON.stringify(scroll.x)}, ${JSON.stringify(scroll.y)}); return { x: window.scrollX, y: window.scrollY }; })()`;
}

/**
 * PNG 解码 + 区域像素扫描：同一隔离浏览器内 Image/canvas 解码，无运行时 PNG
 * 依赖。regions 用页坐标，源内换算成图像像素并回报原点，Node 侧再换算回页坐标。
 *
 * 传 hiddenToken 时在解码后核验 DOM 身份：截图到解码之间 DOM 被换过的话，手上这张
 * PNG 属于哪个 DOM 版本无法判定，整个样本作废（identityValid=false，不带像素回来）。
 */
function buildScanSource(base64, regions, clip, hiddenToken = null) {
  return `// skinProbe: scan
(async () => {
${IDENTITY_SOURCE}
  const image = new Image();
  image.src = "data:image/png;base64," + ${JSON.stringify(base64)};
  await image.decode();
  let identityValid = null;
  let identityReason = null;
  let isolationValid = null;
  let isolationReason = null;
  if (${JSON.stringify(hiddenToken !== null)}) {
    const state = window[${JSON.stringify(MEASUREMENT_STASH_GLOBAL)}] ?? null;
    const stash = state ? state.sessions.get(${JSON.stringify(hiddenToken)}) : null;
    if (!stash) {
      identityValid = false;
      identityReason = "隐藏样本暂存不存在";
    } else {
      const checked = __attemptIdentity(state, stash.attemptToken);
      identityValid = checked.valid;
      identityReason = checked.reason;
      // 隔离有效性必须在"解码之后、真实目标尚未恢复"时复核一遍：隐藏样式是在
      // 截图之前写的，live probe 与 PNG 解码跨了异步边界，同一个对象完全可能在
      // 这期间重新拿到文字填充/自身背景色或光晕，此时手上这张 PNG 已经是污染样本。
      if (identityValid) {
        const isolation = __isolationState(stash.target, stash.mode);
        const decoration = __decorationState(stash.decoration);
        isolationValid = isolation.isolated && decoration.active && decoration.hostStable && decoration.businessStateStable;
        isolationReason = !isolation.isolated
          ? stash.mode === "surface"
            ? "隐藏后自身填充仍未清空（" + isolation.remaining.join("、") + "）"
            : "隐藏后仍检测到文字绘制（" + isolation.remaining.join("、") + " 保留独立文字填充/阴影）"
          : !decoration.active
            ? "像素扫描时装饰隔离已失效"
            : !decoration.hostStable
              ? "装饰隔离改变了宿主几何或表面"
              : !decoration.businessStateStable
                ? "search 隔离改变了输入值或焦点"
                : null;
      }
    }
    if (!identityValid || isolationValid === false) {
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
        scale: { x: 1, y: 1 },
        regions: [],
        identityValid,
        reason: identityReason,
        isolationValid,
        isolationReason,
      };
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const clip = ${JSON.stringify(clip)};
  const scaleX = image.naturalWidth / clip.width;
  const scaleY = image.naturalHeight / clip.height;
  return {
    width: image.naturalWidth,
    height: image.naturalHeight,
    scale: { x: scaleX, y: scaleY },
    identityValid,
    reason: identityReason,
    isolationValid,
    isolationReason,
    regions: ${JSON.stringify(regions)}.map((region) => {
      const left = Math.max(0, Math.floor((region.x - clip.x) * scaleX));
      const top = Math.max(0, Math.floor((region.y - clip.y) * scaleY));
      const right = Math.min(image.naturalWidth, Math.ceil((region.x + region.width - clip.x) * scaleX));
      const bottom = Math.min(image.naturalHeight, Math.ceil((region.y + region.height - clip.y) * scaleY));
      const width = Math.max(0, right - left);
      const height = Math.max(0, bottom - top);
      if (width === 0 || height === 0) return { id: region.id, columns: 0, rows: 0, pixels: [] };
      const data = ctx.getImageData(left, top, width, height).data;
      return { id: region.id, columns: width, rows: height, origin: { x: left, y: top }, pixels: Array.from(data) };
    }),
  };
})()`;
}

/** 两张 PNG 的像素比对（截图状态核验）。 */
function buildCompareImagesSource(leftBase64, rightBase64) {
  return `// skinProbe: compare-images
(async () => {
  const decode = async (base64) => {
    const image = new Image();
    image.src = "data:image/png;base64," + base64;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  };
  const left = await decode(${JSON.stringify(leftBase64)});
  const right = await decode(${JSON.stringify(rightBase64)});
  if (left.width !== right.width || left.height !== right.height) {
    return {
      identical: false,
      reason: "尺寸不同",
      width: null,
      height: null,
      differingPixels: -1,
      maxChannelDelta: -1,
      bbox: null,
    };
  }
  let differingPixels = 0;
  let maxChannelDelta = 0;
  let minX = left.width;
  let minY = left.height;
  let maxX = -1;
  let maxY = -1;
  for (let index = 0; index < left.data.length; index += 4) {
    let delta = 0;
    for (let channel = 0; channel < 3; channel += 1) {
      delta = Math.max(delta, Math.abs(left.data[index + channel] - right.data[index + channel]));
    }
    if (delta > 0) {
      const pixel = index / 4;
      const x = pixel % left.width;
      const y = Math.floor(pixel / left.width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      differingPixels += 1;
    }
    if (delta > maxChannelDelta) maxChannelDelta = delta;
  }
  return {
    identical: differingPixels === 0,
    width: left.width,
    height: left.height,
    differingPixels,
    maxChannelDelta,
    bbox: differingPixels === 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
  };
})()`;
}

/** 等当前活动聚光伪元素的有限 opacity transition，并确认其状态跨帧稳定。 */
function buildSpotlightStabilitySource(budgetMs = 500) {
  const safeBudgetMs = Number.isFinite(budgetMs) ? Math.min(500, Math.max(1, Math.floor(budgetMs))) : 500;
  return `// skinProbe: spotlight-stability
(async () => {
  const budgetMs = ${safeBudgetMs};
  const startedAt = performance.now();
  const deadline = startedAt + budgetMs;
  let frameCount = 0;
  let transitionsWaited = 0;
  const read = () => Array.from(document.querySelectorAll(".shell [data-spotlight-active]"), (host) => {
    const pseudo = getComputedStyle(host, "::after");
    const style = host.style;
    return {
      id: host.id || null,
      tag: host.tagName || null,
      className: typeof host.className === "string" ? host.className : "",
      x: style.getPropertyValue("--spotlight-x"),
      y: style.getPropertyValue("--spotlight-y"),
      radius: style.getPropertyValue("--spotlight-radius"),
      mask: style.getPropertyValue("--spotlight-mask"),
      opacity: pseudo.opacity,
    };
  });
  const initial = read();
  const finish = (stable, reason, settled = read()) => ({
    stable,
    reason,
    budgetMs,
    waitedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    frameCount,
    transitionsWaited,
    initial,
    settled,
  });
  const nextFrame = async () => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return false;
    if (typeof requestAnimationFrame !== "function" || typeof setTimeout !== "function") return null;
    let timer;
    const frame = new Promise((resolve) => requestAnimationFrame(() => resolve(true)));
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), remaining);
    });
    const result = await Promise.race([frame, timeout]);
    clearTimeout(timer);
    if (result) frameCount += 1;
    return result;
  };
  const activeOpacityTransitions = () => {
    const transitions = [];
    for (const host of document.querySelectorAll(".shell [data-spotlight-active]")) {
      if (typeof host.getAnimations !== "function") return { error: "animation-api-unavailable" };
      let animations;
      try {
        animations = host.getAnimations({ subtree: true });
      } catch {
        return { error: "animation-api-unavailable" };
      }
      for (const animation of animations) {
        if (
          !["running", "paused"].includes(animation.playState) ||
          animation.effect?.target !== host ||
          animation.effect?.pseudoElement !== "::after" ||
          animation.transitionProperty !== "opacity"
        ) continue;
        const timing = animation.effect.getComputedTiming?.();
        if (!timing) return { error: "animation-timing-api-unavailable" };
        if (!Number.isFinite(timing.duration) || !Number.isFinite(timing.endTime) || !Number.isFinite(timing.iterations)) {
          return { error: "spotlight-opacity-transition-unbounded" };
        }
        if (timing.duration > 0) transitions.push(animation);
      }
    }
    return { transitions };
  };
  const waitTransition = async (animation) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return "timeout";
    const finishedPromise = animation.finished;
    if (!finishedPromise || typeof finishedPromise.then !== "function") return "animation-api-unavailable";
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve("timeout"), remaining);
    });
    const finished = Promise.resolve(finishedPromise).then(() => "settled", () => "settled");
    const result = await Promise.race([finished, timeout]);
    clearTimeout(timer);
    return result;
  };
  if (typeof requestAnimationFrame !== "function" || typeof setTimeout !== "function") {
    return finish(false, "frame-api-unavailable");
  }
  for (let index = 0; index < 2; index += 1) {
    const advanced = await nextFrame();
    if (advanced === null) return finish(false, "frame-api-unavailable");
    if (!advanced) return finish(false, "budget-exhausted-before-paint");
  }
  let stableFrames = 0;
  let previous = read();
  while (performance.now() < deadline) {
    const pending = activeOpacityTransitions();
    if (pending.error) return finish(false, pending.error, previous);
    if (pending.transitions.length) {
      transitionsWaited += pending.transitions.length;
      for (const animation of pending.transitions) {
        const outcome = await waitTransition(animation);
        if (outcome === "animation-api-unavailable") return finish(false, outcome, read());
        if (outcome === "timeout") return finish(false, "budget-exhausted-waiting-transition", read());
      }
      // A canceled transition can be replaced immediately; always query again.
      stableFrames = 0;
      previous = read();
      continue;
    }
    const advanced = await nextFrame();
    if (advanced === null) return finish(false, "frame-api-unavailable", previous);
    if (!advanced) return finish(false, "budget-exhausted-confirming-state", previous);
    const current = read();
    const remainingTransitions = activeOpacityTransitions();
    if (remainingTransitions.error) return finish(false, remainingTransitions.error, current);
    if (remainingTransitions.transitions.length) {
      stableFrames = 0;
      previous = current;
      continue;
    }
    stableFrames = JSON.stringify(previous) === JSON.stringify(current) ? stableFrames + 1 : 0;
    previous = current;
    if (stableFrames >= 2) return finish(true, null, current);
  }
  return finish(false, "budget-exhausted-confirming-state", previous);
})()`;
}

/** canvas 路径：确认画布、读观察记录（按画布身份 + 当前绘制帧 + 排除测量器注入）、把 bitmap 存进页内暂存区。 */
function buildCanvasStashSource(selector) {
  return `// skinProbe: canvas-stash
(() => {
  const canvas = document.querySelector(${JSON.stringify(selector)});
  if (!canvas || typeof canvas.getContext !== "function") return { ok: false, reason: "画布不存在或非 canvas 元素" };
  const observer = window[${JSON.stringify(OBSERVER_GLOBAL)}];
  if (!observer || !Array.isArray(observer.records)) {
    return { ok: false, reason: "颜色观察器未安装（installBrowserColorObserver 必须在导航前调用）" };
  }
  const ctx = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const bitmap = ctx.getImageData(0, 0, canvas.width, canvas.height);
  Object.defineProperty(window, ${JSON.stringify(CANVAS_STASH_GLOBAL)}, {
    value: { canvas, bitmap },
    configurable: true,
  });
  // 只保留这个画布的绘制：应用清空/重置画布后的旧记录描述的是已丢弃的画面；
  // 测量器自己重建底色层的记录（injected）不是应用的绘制；观察失败的记录
  // （observationError）仍是一条没能测量的绘制，要留着进缺测账。
  const drawn = observer.records.filter((record) => record.canvasRef === canvas && record.injected !== true);
  // 当前帧以观察器的帧号为准：应用清空画布或重置画布尺寸后若没有重绘，既有记录
  // 描述的是已被丢弃的画面。取"记录里的最大帧号"会把这类旧帧当成当前帧——空白
  // 画布也会按旧轴文字"测"出比值。
  if (typeof observer.frameOf !== "function") {
    return { ok: false, reason: "颜色观察器版本过旧（缺少 frameOf），无法确定当前绘制帧" };
  }
  const frame = observer.frameOf(canvas);
  const records = drawn
    .filter((record) => (record.frame ?? 0) === frame)
    .map((record) => {
      const copy = { ...record };
      delete copy.canvasRef;
      return copy;
    });
  return {
    ok: true,
    selector: ${JSON.stringify(selector)},
    canvasId: canvas.id || null,
    frame,
    bitmap: { width: bitmap.width, height: bitmap.height },
    cssRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    scroll: { x: window.scrollX, y: window.scrollY },
    dpr: window.devicePixelRatio || 1,
    records,
  };
})()`;
}

/** canvas 路径：清前景 bitmap；应用自绘底色层（覆盖 ≥95% 画布的 fillRect）按观察记录重建。 */
function buildCanvasClearSource(records) {
  return `// skinProbe: canvas-clear
(() => {
  const stash = window[${JSON.stringify(CANVAS_STASH_GLOBAL)}];
  if (!stash) return { ok: false, reason: "画布 bitmap 未暂存" };
  const ctx = stash.canvas.getContext("2d");
  const observer = window[${JSON.stringify(OBSERVER_GLOBAL)}];
  const beginInject = observer && typeof observer.beginInject === "function" ? observer.beginInject.bind(observer) : null;
  const endInject = observer && typeof observer.endInject === "function" ? observer.endInject.bind(observer) : null;
  // 重建背景是测量器自己的绘制：标记 injected，且不得推高应用侧帧号
  if (beginInject) beginInject();
  // save/restore 保存并还原整套绘图状态（transform、alpha、填充、合成……）；
  // 重建阶段抛异常也要走 restore，不能把应用的绘图状态留在半途。
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, stash.canvas.width, stash.canvas.height);
    const baseFills = (${JSON.stringify(records)}).filter((record) => {
      if (record.method !== "fillRect" || !Array.isArray(record.rectArgs)) return false;
      const [x, y, width, height] = record.rectArgs;
      return width * height >= 0.95 * stash.canvas.width * stash.canvas.height;
    });
    for (const record of baseFills) {
      const matrix = record.transform;
      ctx.fillStyle = record.fillStyle;
      ctx.globalAlpha = record.alpha;
      if (matrix) ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
      ctx.fillRect(...record.rectArgs);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }
    return { ok: true, rebuiltBaseLayers: baseFills.length };
  } finally {
    ctx.restore();
    if (endInject) endInject();
  }
})()`;
}

/** canvas 路径：恢复 bitmap 并核验（与暂存逐像素比对）。 */
function buildCanvasRestoreSource() {
  return `// skinProbe: canvas-restore
(() => {
  const stash = window[${JSON.stringify(CANVAS_STASH_GLOBAL)}];
  if (!stash) return { ok: false, reason: "画布 bitmap 未暂存" };
  const ctx = stash.canvas.getContext("2d");
  // putImageData 不受 transform 影响，但 setTransform 会改掉应用的绘图状态：
  // 同样 save/restore，恢复后 transform 必须与测量前一致。
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(stash.bitmap, 0, 0);
  } finally {
    ctx.restore();
  }
  const restored = ctx.getImageData(0, 0, stash.canvas.width, stash.canvas.height);
  let differing = 0;
  for (let index = 0; index < restored.data.length; index += 4) {
    if (
      restored.data[index] !== stash.bitmap.data[index] ||
      restored.data[index + 1] !== stash.bitmap.data[index + 1] ||
      restored.data[index + 2] !== stash.bitmap.data[index + 2] ||
      restored.data[index + 3] !== stash.bitmap.data[index + 3]
    ) {
      differing += 1;
    }
  }
  delete window[${JSON.stringify(CANVAS_STASH_GLOBAL)}];
  return { ok: true, differingPixels: differing, identical: differing === 0 };
})()`;
}

// ---------------------------------------------------------------------------
// 固定导出
// ---------------------------------------------------------------------------

/**
 * 委托原始截图，只移除截图后残留在原无 style 节点上的空 style 属性。
 */
export async function screenshotWithStyleAttributeGuard(page, options) {
  if (!page || typeof page.evaluate !== "function" || typeof page.screenshot !== "function") {
    throw new TypeError("screenshotWithStyleAttributeGuard: 需要可用的 Playwright page");
  }

  const token = randomUUID();
  let snapshotAttempted = false;
  let snapshotStored = false;
  let hasPrimaryError = false;
  let primaryError = null;
  let png;
  const cleanupErrors = [];

  try {
    snapshotAttempted = true;
    const snapshot = await page.evaluate((token) => {
      const key = `__skinScreenshotStyleGuard_${token}`;
      if (Object.hasOwn(window, key)) return { ok: false, conflict: true, error: "唯一暂存 token 已存在" };
      const roots = [document];
      const elements = new Map();
      const seen = new Set();
      for (let index = 0; index < roots.length; index += 1) {
        const root = roots[index];
        for (const element of root.querySelectorAll("input,textarea,[contenteditable]")) {
          if (seen.has(element)) continue;
          seen.add(element);
          elements.set(element, element.hasAttribute("style"));
        }
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) roots.push(element.shadowRoot);
        }
      }
      Object.defineProperty(window, key, {
        configurable: true,
        value: Object.freeze({ token, elements }),
      });
      return { ok: true, count: elements.size };
    }, token);
    if (snapshot?.ok !== true) {
      if (snapshot?.conflict === true) snapshotAttempted = false;
      throw new Error(`screenshotWithStyleAttributeGuard: 无法暂存页面节点引用：${snapshot?.error ?? "未知结果"}`);
    }
    snapshotStored = true;
    png = await page.screenshot(options);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    if (snapshotAttempted) {
      try {
        const result = await page.evaluate((token) => {
          const key = `__skinScreenshotStyleGuard_${token}`;
          const errors = [];
          if (!Object.hasOwn(window, key)) return { missing: true, released: true, ok: true, errors };
          const snapshot = window[key];
          if (snapshot?.token !== token) {
            return { missing: false, released: false, ok: false, errors: ["暂存 token 不匹配；未删除其他状态"] };
          }
          let index = 0;
          try {
            if (!(snapshot.elements instanceof Map)) {
              errors.push("暂存节点列表不可用");
            } else {
              for (const [element, originalStylePresent] of snapshot.elements) {
                if (originalStylePresent) {
                  index += 1;
                  continue;
                }
                try {
                  const rawStyle = element.getAttribute("style");
                  if (rawStyle === "") {
                    element.removeAttribute("style");
                    if (element.getAttribute("style") !== null) {
                      errors.push(`element ${index}: style 属性清理后仍存在`);
                    }
                  }
                } catch (error) {
                  errors.push(`element ${index}: ${String(error)}`);
                }
                index += 1;
              }
            }
          } catch (error) {
            errors.push(`暂存节点遍历失败：${String(error)}`);
          } finally {
            try {
              if (window[key] === snapshot) {
                if (!delete window[key] || Object.hasOwn(window, key)) {
                  errors.push("本次暂存无法删除或删除后仍存在");
                }
              } else {
                errors.push("暂存被其他状态替换；未删除该状态");
              }
            } catch (error) {
              errors.push(`暂存删除失败：${String(error)}`);
            }
          }
          return { missing: false, released: !Object.hasOwn(window, key), ok: errors.length === 0, errors };
        }, token);
        if (!result || !Array.isArray(result.errors)) {
          cleanupErrors.push(new TypeError("screenshotWithStyleAttributeGuard: 页面清理未返回错误列表"));
        } else {
          if (snapshotStored && result.missing) {
            cleanupErrors.push(new Error("screenshotWithStyleAttributeGuard: 已创建的本次暂存在清理时丢失"));
          }
          if (result.released !== true) {
            cleanupErrors.push(new Error("screenshotWithStyleAttributeGuard: 本次暂存未能释放"));
          }
          cleanupErrors.push(
            ...result.errors.map((message) => new Error(`screenshotWithStyleAttributeGuard: ${message}`)),
          );
          if (result.ok !== true && result.errors.length === 0) {
            cleanupErrors.push(new Error("screenshotWithStyleAttributeGuard: 页面清理未能确认成功"));
          }
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }

  if (hasPrimaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "screenshotWithStyleAttributeGuard: 截图失败且 style 属性清理也失败",
      { cause: primaryError },
    );
  }
  if (hasPrimaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "screenshotWithStyleAttributeGuard: style 属性清理失败");
  }
  return png;
}

function firstLayoutDifference(left, right, path = "", element = null) {
  const isObject = (value) => value !== null && typeof value === "object";
  const field = (value) => {
    if (value === null || ["string", "boolean"].includes(typeof value)) return { present: true, value };
    if (typeof value === "number" && Number.isFinite(value)) return { present: true, value };
    return { present: true, valueType: Array.isArray(value) ? "array" : typeof value };
  };
  const ownField = (object, key) =>
    isObject(object) && Object.hasOwn(object, key) ? field(object[key]) : { present: false };
  const difference = (before, after, at = path) => ({
    path: at,
    before,
    after,
    ...(element ? { element } : {}),
  });
  const leftArray = Array.isArray(left);
  const rightArray = Array.isArray(right);
  if (!isObject(left) || !isObject(right) || leftArray !== rightArray) {
    return difference(field(left), field(right));
  }
  if (leftArray) {
    if (left.length !== right.length) {
      const lengthPath = path ? `${path}.length` : "length";
      return difference({ present: true, value: left.length }, { present: true, value: right.length }, lengthPath);
    }
    for (let index = 0; index < left.length; index += 1) {
      if (JSON.stringify(left[index]) === JSON.stringify(right[index])) continue;
      const nextElement =
        path === "elements"
          ? {
              index,
              tag: typeof left[index]?.tag === "string" ? left[index].tag : null,
              id: typeof left[index]?.id === "string" ? left[index].id : null,
              className: typeof left[index]?.className === "string" ? left[index].className : null,
            }
          : element;
      const nested = firstLayoutDifference(left[index], right[index], `${path}[${index}]`, nextElement);
      if (nested) return nested;
    }
    return difference({ present: true, valueType: "array" }, { present: true, valueType: "array" }, path || "layout");
  }
  const keys = [...Object.keys(left), ...Object.keys(right).filter((key) => !Object.hasOwn(left, key))];
  for (const key of keys) {
    const nextPath = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
      return difference(ownField(left, key), ownField(right, key), nextPath);
    }
    if (
      isObject(left[key]) &&
      isObject(right[key]) &&
      Array.isArray(left[key]) === Array.isArray(right[key]) &&
      JSON.stringify(left[key]) !== JSON.stringify(right[key])
    ) {
      const nested = firstLayoutDifference(left[key], right[key], nextPath, element);
      if (nested) return nested;
    } else if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) {
      return difference(ownField(left, key), ownField(right, key), nextPath);
    }
  }
  return difference({ present: true, valueType: "object" }, { present: true, valueType: "object" }, path || "layout");
}

async function captureStablePage(page, { fullPage, name }) {
  if (!page || typeof page.evaluate !== "function" || typeof page.screenshot !== "function") {
    throw new TypeError(`${name}: 需要可用的 Playwright page`);
  }

  const readState = () =>
    page.evaluate(() => {
      const rect = (element) => {
        const value = element.getBoundingClientRect();
        return { x: value.x, y: value.y, width: value.width, height: value.height };
      };
      const metrics = (element) => ({
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        offsetWidth: element.offsetWidth,
        offsetHeight: element.offsetHeight,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
        rect: rect(element),
      });
      const root = document.documentElement;
      const style = root.style;
      const viewport = window.visualViewport;
      return {
        viewport: {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          visualWidth: viewport?.width ?? null,
          visualHeight: viewport?.height ?? null,
          visualOffsetLeft: viewport?.offsetLeft ?? null,
          visualOffsetTop: viewport?.offsetTop ?? null,
          visualScale: viewport?.scale ?? null,
        },
        scroll: { x: window.scrollX, y: window.scrollY },
        html: metrics(root),
        body: metrics(document.body),
        elements: Array.from(document.querySelectorAll("*"), (element) => {
          const computed = getComputedStyle(element);
          return {
            tag: element.tagName,
            id: element.id,
            className: typeof element.className === "string" ? element.className : "",
            rect: rect(element),
            display: computed.display,
            position: computed.position,
            transform: computed.transform,
          };
        }),
        inline: {
          styleAttributePresent: root.hasAttribute("style"),
          styleAttributeValue: root.getAttribute("style"),
          cssText: style.cssText,
          gutterValue: style.getPropertyValue("scrollbar-gutter"),
          gutterPriority: style.getPropertyPriority("scrollbar-gutter"),
          computedGutter: getComputedStyle(root).scrollbarGutter,
        },
      };
    });
  const layoutOf = (state) => ({
    viewport: state.viewport,
    scroll: state.scroll,
    html: state.html,
    body: state.body,
    elements: state.elements,
  });
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const before = await readState();
  const hasClassicGutter = before.viewport.innerWidth > before.html.clientWidth;
  let primaryError = null;
  let png;
  const cleanupErrors = [];

  try {
    if (hasClassicGutter) {
      const guard = await page.evaluate(() => {
        const root = document.documentElement;
        const supported = typeof CSS !== "undefined" && CSS.supports("scrollbar-gutter", "stable");
        if (!supported)
          return {
            supported: false,
            value: root.style.getPropertyValue("scrollbar-gutter"),
            priority: root.style.getPropertyPriority("scrollbar-gutter"),
          };
        root.style.setProperty("scrollbar-gutter", "stable", "important");
        return {
          supported: true,
          value: root.style.getPropertyValue("scrollbar-gutter"),
          priority: root.style.getPropertyPriority("scrollbar-gutter"),
          computed: getComputedStyle(root).scrollbarGutter,
        };
      });
      if (
        !guard.supported ||
        guard.value !== "stable" ||
        guard.priority !== "important" ||
        guard.computed !== "stable"
      ) {
        throw new Error(`${name}: classic gutter 无法安全应用 scrollbar-gutter: stable !important`);
      }
      const protectedState = await readState();
      if (!same(layoutOf(before), layoutOf(protectedState))) {
        throw new Error(`${name}: 应用 gutter 保护改变了页面布局`);
      }
    }
    png = await screenshotWithStyleAttributeGuard(page, { fullPage });
    if (!Buffer.isBuffer(png)) {
      throw new TypeError(`${name}: ${fullPage ? "fullPage" : "viewport"} 截图未返回原始 Buffer`);
    }
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      const restored = await page.evaluate((original) => {
        const root = document.documentElement;
        const style = root.style;
        if (original.gutterValue) style.setProperty("scrollbar-gutter", original.gutterValue, original.gutterPriority);
        else style.removeProperty("scrollbar-gutter");
        if (original.styleAttributePresent && !root.hasAttribute("style")) {
          root.setAttribute("style", original.styleAttributeValue ?? "");
        } else if (!original.styleAttributePresent && style.cssText === "") {
          root.removeAttribute("style");
        }
        const attributeBoundaryRestored = original.styleAttributePresent
          ? root.hasAttribute("style")
          : !root.hasAttribute("style") || style.cssText !== "";
        return {
          declarationRestored:
            style.getPropertyValue("scrollbar-gutter") === original.gutterValue &&
            style.getPropertyPriority("scrollbar-gutter") === original.gutterPriority,
          attributeBoundaryRestored,
        };
      }, before.inline);
      if (!restored.declarationRestored || !restored.attributeBoundaryRestored) {
        cleanupErrors.push(new Error(`${name}: scrollbar-gutter 或 style 属性边界未恢复`));
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await page.evaluate((scroll) => window.scrollTo(scroll.x, scroll.y), before.scroll);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          }),
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      const after = await readState();
      const beforeLayout = layoutOf(before);
      const afterLayout = layoutOf(after);
      if (!same(beforeLayout, afterLayout)) {
        const error = new Error(`${name}: 截图后 viewport、scroll、document 或内容几何未恢复`);
        error.layoutDifference = firstLayoutDifference(beforeLayout, afterLayout);
        cleanupErrors.push(error);
      }
      const inlineRestored =
        before.inline.gutterValue === after.inline.gutterValue &&
        before.inline.gutterPriority === after.inline.gutterPriority &&
        (before.inline.styleAttributePresent
          ? after.inline.styleAttributePresent
          : !after.inline.styleAttributePresent || after.inline.cssText !== "");
      if (!inlineRestored) cleanupErrors.push(new Error(`${name}: 原 style 属性存在性或 gutter 声明未恢复`));
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError([primaryError, ...cleanupErrors], `${name}: 截图失败且页面恢复也失败`, {
      cause: primaryError,
    });
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `${name}: 页面状态恢复失败`);
  return png;
}

/**
 * 截取并返回原始 PNG；截图前后均验证页面几何，所有临时状态都在返回前恢复。
 * classic scrollbar gutter 会临时保留 stable 槽位；overlay-scrollbar 页面不加占位。
 */
export async function captureStableFullPage(page) {
  return captureStablePage(page, { fullPage: true, name: "captureStableFullPage" });
}

export async function captureStableViewport(page) {
  return captureStablePage(page, { fullPage: false, name: "captureStableViewport" });
}

/** 导航前安装 canvas 绘制观察器（addInitScript：每次导航都生效、安装幂等）。 */
export function installBrowserColorObserver(page) {
  if (!page || typeof page !== "object" || typeof page.addInitScript !== "function") {
    throw new TypeError("installBrowserColorObserver: page.addInitScript 不可用（需要 Playwright 页面对象）");
  }
  page.addInitScript({ content: buildColorObserverSource() });
  return { installed: true, observedMethods: [...OBSERVED_METHODS], source: "buildColorObserverSource()" };
}

/**
 * 页内源工厂（测试与诊断入口）：tag 与各源串首行的 skinProbe 标记一致。
 * 生产路径不经过这里——measureBrowserRoles 直接调用内部构建函数；
 * 测试经此入口取得同一份源串，在 node:vm 替身里验证语义。
 */
export function buildProbeSource(tag, ...args) {
  switch (tag) {
    case "node-probe":
      return buildNodeProbeSource(...args);
    case "occlusion-probe":
      return buildOcclusionProbeSource(...args);
    case "color-parse":
      return buildColorParseSource(...args);
    case "hide":
      return buildHideSource(...args);
    case "restore":
      return buildRestoreSource(...args);
    case "verify":
      return buildVerifySource(...args);
    case "toast-guard":
      return buildToastBusinessGuardSource(...args);
    case "release-attempt":
      return buildReleaseAttemptSource(...args);
    case "scan":
      return buildScanSource(...args);
    case "compare-images":
      return buildCompareImagesSource(...args);
    case "spotlight-stability":
      return buildSpotlightStabilitySource(...args);
    case "spotlight-language-guard":
      return buildSpotlightLanguageGuardSource(...args);
    case "canvas-stash":
      return buildCanvasStashSource(...args);
    case "canvas-clear":
      return buildCanvasClearSource(...args);
    case "canvas-restore":
      return buildCanvasRestoreSource(...args);
    case "scroll-begin":
      return buildBeginScrollSessionSource(...args);
    case "scroll-restore":
      return buildRestoreScrollSource(...args);
    case "bring-into-view":
      return buildBringIntoViewSource(...args);
    case "scroll-by":
      return buildScrollBySource(...args);
    case "scroll-to":
      return buildScrollToSource(...args);
    default:
      throw new TypeError(`buildProbeSource: 未知皮肤探针标记 "${String(tag)}"`);
  }
}

// ---------------------------------------------------------------------------
// 原生命中遮挡组件（D21-C8-D3a）：单 toast 宿主、单文字矩形五点、
// DOM.getNodeForLocation(ignorePointerEventsNone)。只服务后续生产接线，当前未接路由。
// ---------------------------------------------------------------------------

const NATIVE_OCCLUSION_SOURCE = "native-cdp";
const NATIVE_OCCLUSION_OBJECT_GROUP = "skin-palette-toast-native-occlusion";
/** 本卡只覆盖 D2 已实测的普通 toast 宿主：SPAN#quotaPresetStatus.quota-preset-status。 */
const NATIVE_OCCLUSION_HOST_SCOPE = Object.freeze({
  tag: "span",
  id: "quotaPresetStatus",
  classNameToken: "quota-preset-status",
});

/**
 * D3b 仅接线这一个精确组合：状态、角色与角色现有 selector 同时成立才走 toast 固定视口。
 * 其它角色/状态即使选择器相同也不使用此分支（原 hover 守卫也保持独立）。
 */
const TOAST_NATIVE_STATE_ID = "quota-toast";
const TOAST_NATIVE_ROLE_ID = "toast.quota-status";
const TOAST_NATIVE_SELECTOR = ".quota-preset-status";
const SPOTLIGHT_METRIC_STATE_ID = "spotlight-metric-label";
const SPOTLIGHT_METRIC_LABEL_ROLE_ID = "panel.metric-label";
const SPOTLIGHT_METRIC_VALUE_ROLE_ID = "panel.metric-value";
const SPOTLIGHT_METRIC_LABEL_SELECTOR = ".metric:has(> #totalTokens) > span:not(.metric-new)";
const SPOTLIGHT_METRIC_VALUE_SELECTOR = ".metric:has(> #totalTokens) > #totalTokens";
const SPOTLIGHT_TIMELINE_STATE_ID = "spotlight-timeline-heading";
const SPOTLIGHT_TIMELINE_TITLE_ROLE_ID = "panel.section-title";
const SPOTLIGHT_TIMELINE_RANGE_ROLE_ID = "panel.heading-label";
const SPOTLIGHT_TIMELINE_TITLE_SELECTOR =
  ".chart-panel[data-spotlight-active] > .timeline-heading > .timeline-title > #timelinePanelTitle";
const SPOTLIGHT_TIMELINE_RANGE_SELECTOR =
  ".chart-panel[data-spotlight-active] > .timeline-heading > .timeline-title > #rangeLabel";
const SPOTLIGHT_DETAIL_HEADING_STATE_ID = "spotlight-detail-bars";
const SPOTLIGHT_DETAIL_FILL_STATE_ID = "spotlight-detail-fill";
const SPOTLIGHT_DETAIL_TITLE_ROLE_ID = "panel.section-title";
const SPOTLIGHT_DETAIL_MODE_ROLE_ID = "panel.heading-label";
const SPOTLIGHT_DETAIL_NAME_ROLE_ID = "panel.detail-bar-name";
const SPOTLIGHT_DETAIL_VALUE_ROLE_ID = "panel.detail-bar-value";
const SPOTLIGHT_DETAIL_TITLE_SELECTOR =
  "#detailPanel[data-spotlight-active] > .panel-heading > #detailPanelTitle:not(:empty)";
const SPOTLIGHT_DETAIL_MODE_SELECTOR =
  "#detailPanel[data-spotlight-active] > .panel-heading > #detailModeLabel:not(:empty)";
const SPOTLIGHT_DETAIL_NAME_SELECTOR =
  "#detailPanel[data-spotlight-active] > #detailList:not([hidden]) > .bar-row > .bar-label > .bar-name:not(:empty)";
const SPOTLIGHT_DETAIL_VALUE_SELECTOR =
  "#detailPanel[data-spotlight-active] > #detailList:not([hidden]) > .bar-row > .bar-label > .bar-value:not(:empty)";
const SPOTLIGHT_LANGUAGE_STATE_ID = "spotlight-language-selected";
const SPOTLIGHT_LANGUAGE_ROLE_ID = "spotlight.language-selected";
const SPOTLIGHT_LANGUAGE_SELECTOR =
  ".shell #languageToggle[data-spotlight-active][aria-pressed='false'] > [data-language='zh-CN'].is-selected:not(:empty)";
function spotlightMetricTargetKind(recordContext, role, rawSelector) {
  if (recordContext?.stateId !== SPOTLIGHT_METRIC_STATE_ID) return null;
  if (role?.id === SPOTLIGHT_METRIC_LABEL_ROLE_ID && rawSelector === SPOTLIGHT_METRIC_LABEL_SELECTOR) return "label";
  if (role?.id === SPOTLIGHT_METRIC_VALUE_ROLE_ID && rawSelector === SPOTLIGHT_METRIC_VALUE_SELECTOR) return "value";
  return null;
}

function isSpotlightLanguageContract(recordContext, role, rawSelector) {
  return (
    recordContext?.stateId === SPOTLIGHT_LANGUAGE_STATE_ID &&
    role?.id === SPOTLIGHT_LANGUAGE_ROLE_ID &&
    role?.kind === "text" &&
    role?.selector === SPOTLIGHT_LANGUAGE_SELECTOR &&
    rawSelector === SPOTLIGHT_LANGUAGE_SELECTOR
  );
}

function isSpotlightLanguageTarget(recordContext, role, rawSelector) {
  const background = role?.background;
  return (
    isSpotlightLanguageContract(recordContext, role, rawSelector) &&
    background?.kind === "layered" &&
    background?.browserRequired === true
  );
}

function spotlightTimelineTargetKind(recordContext, role, rawSelector) {
  if (recordContext?.stateId !== SPOTLIGHT_TIMELINE_STATE_ID) return null;
  if (role?.id === SPOTLIGHT_TIMELINE_TITLE_ROLE_ID && rawSelector === SPOTLIGHT_TIMELINE_TITLE_SELECTOR)
    return "title";
  if (role?.id === SPOTLIGHT_TIMELINE_RANGE_ROLE_ID && rawSelector === SPOTLIGHT_TIMELINE_RANGE_SELECTOR)
    return "range";
  return null;
}

function spotlightDetailHeadingTargetKind(recordContext, role, rawSelector) {
  if (recordContext?.stateId !== SPOTLIGHT_DETAIL_HEADING_STATE_ID) return null;
  if (role?.id === SPOTLIGHT_DETAIL_TITLE_ROLE_ID && rawSelector === SPOTLIGHT_DETAIL_TITLE_SELECTOR) return "title";
  if (role?.id === SPOTLIGHT_DETAIL_MODE_ROLE_ID && rawSelector === SPOTLIGHT_DETAIL_MODE_SELECTOR) return "mode-label";
  if (role?.id === SPOTLIGHT_DETAIL_NAME_ROLE_ID && rawSelector === SPOTLIGHT_DETAIL_NAME_SELECTOR) return "name";
  if (role?.id === SPOTLIGHT_DETAIL_VALUE_ROLE_ID && rawSelector === SPOTLIGHT_DETAIL_VALUE_SELECTOR) return "value";
  return null;
}

function isToastNativeTarget(recordContext, role, rawSelector) {
  return (
    recordContext?.stateId === TOAST_NATIVE_STATE_ID &&
    role?.id === TOAST_NATIVE_ROLE_ID &&
    rawSelector === TOAST_NATIVE_SELECTOR
  );
}

/**
 * 在**原宿主对象**上执行：命中对象是否属于原宿主，以及命中节点的页内身份。
 * identity 走与文字探针同一份 stash WeakMap；backendNodeId 只作独立记录，不冒充 identityId。
 */
const NATIVE_HIT_DECLARATION = `function(hit) {
${IDENTITY_SOURCE}
  const state = __stash();
  return {
    withinHost: hit === this || this.contains(hit),
    hostConnected: this.isConnected === true,
    top: __safeIdentity(state, hit),
  };
}`;

/**
 * 页内守卫：原 attempt[0] 与 hidden session 的业务绑定 + 可跨检查点比对的稳定快照。
 * 时间字段单独留存，比对时剔除；只覆盖本次调用窗口，不假装覆盖隐藏前后或像素链。
 */
function buildNativeOcclusionGuardSource(attemptToken, hiddenToken, inputRect, points) {
  return `// skinProbe: native-occlusion-guard
(() => {
  const attemptToken = ${JSON.stringify(attemptToken)};
  const hiddenToken = ${JSON.stringify(hiddenToken)};
  const inputRect = ${JSON.stringify(inputRect)};
  const points = ${JSON.stringify(points)};
  const hostScope = ${JSON.stringify(NATIVE_OCCLUSION_HOST_SCOPE)};
  const isolationProps = ${JSON.stringify(NON_ISOLATABLE_PROPS)};
${IDENTITY_SOURCE}
  const state = window[${JSON.stringify(MEASUREMENT_STASH_GLOBAL)}] ?? null;
  const base = { wallTime: new Date().toISOString(), performanceNow: performance.now() };
  const invalid = (reason) => ({ ...base, identityValid: false, reason });
  const attempt = state ? state.attempts.get(attemptToken) : null;
  if (!attempt) return invalid("角色尝试基准不存在");
  if (attempt.elements.length !== 1) return invalid("仅支持单一宿主：基准含 " + attempt.elements.length + " 个元素");
  const session = state.sessions.get(hiddenToken);
  if (!session) return invalid("隐藏样本暂存不存在");
  if (session.attemptToken !== attemptToken) return invalid("隐藏样本不属于本次角色尝试");
  if (session.index !== 0) return invalid("隐藏样本索引不是 0");
  const host = attempt.elements[0];
  if (session.target !== host) return invalid("隐藏样本宿主与角色尝试基准不一致");
  // 宿主范围：必须仍是原 toast 对象本尊，不按同 id/class 另找节点。
  if (String(host.tagName || "").toLowerCase() !== hostScope.tag) {
    return invalid("宿主标签不是原toast的 " + hostScope.tag.toUpperCase() + "（当前 " + String(host.tagName || "（空）") + "）");
  }
  if (String(host.id || "") !== hostScope.id) {
    return invalid("宿主 id 不是原toast的 " + hostScope.id + "（当前 " + String(host.id || "（空）") + "）");
  }
  if (!String(host.className ?? "").split(/\\s+/).filter(Boolean).includes(hostScope.classNameToken)) {
    return invalid("宿主缺少原toast的 " + hostScope.classNameToken + " class");
  }
  const checked = __attemptIdentity(state, attemptToken);
  if (!checked.valid) return invalid(checked.reason);
  if (!host.isConnected) return invalid("宿主已脱离文档");
  if (window.devicePixelRatio !== 1) return invalid("仅支持 DPR1，当前 " + window.devicePixelRatio);
  const style = getComputedStyle(host);
  if (host.hidden || style.display === "none" || style.visibility !== "visible") return invalid("宿主当前不可见");
  if (!(Number.parseFloat(style.opacity) > 0)) return invalid("宿主透明度为 0");
  // 绘制边界：只覆盖 D2 实测过的普通 toast，不支持项在入口与每个检查点都拒绝。
  const drawingChain = [];
  for (let current = host; current && current.nodeType === 1; current = current.parentElement) {
    const currentStyle = getComputedStyle(current);
    drawingChain.push({
      tag: String(current.tagName || "").toLowerCase(),
      opacity: currentStyle.opacity,
      filter: currentStyle.filter,
      mixBlendMode: currentStyle.mixBlendMode,
      backdropFilter: currentStyle.backdropFilter || currentStyle.webkitBackdropFilter || "none",
    });
  }
  for (const entry of drawingChain) {
    for (const prop of isolationProps) {
      const value = entry[prop];
      if (prop === "opacity") {
        if (Number.parseFloat(value) < 1) {
          return invalid(entry.tag + " 的 opacity=" + String(value) + "（整体透明度无法分离，本卡不支持）");
        }
      } else if (value && value !== "none" && value !== "normal") {
        return invalid(entry.tag + " 的 " + prop + "=" + String(value) + "（本卡不支持该绘制）");
      }
    }
  }
  const pseudoContent = {};
  for (const pseudo of ["::before", "::after"]) {
    const content = String(getComputedStyle(host, pseudo)?.content ?? "none");
    pseudoContent[pseudo] = content;
    if (content !== "none" && content !== "normal") {
      return invalid("宿主 " + pseudo + " 生成了内容（content: " + content + "），本卡不支持伪元素绘制");
    }
  }
  if (typeof host.getRootNode === "function" && host.getRootNode() !== document) {
    return invalid("宿主不在主文档（shadow/分离根未支持）");
  }
  if (String(host.textContent ?? "").trim() === "") return invalid("宿主没有文字");
  const hostRect = host.getBoundingClientRect();
  if (!(hostRect.width > 0 && hostRect.height > 0)) return invalid("宿主几何为空");
  const range = document.createRange();
  range.selectNodeContents(host);
  const textRects = Array.from(range.getClientRects(), (r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }));
  if (textRects.length !== 1) return invalid("宿主完整文字几何不是单一矩形（当前 " + textRects.length + " 个）");
  const textRect = textRects[0];
  if (!(textRect.width > 0 && textRect.height > 0)) return invalid("宿主文字几何为空");
  const rectMismatch = ["x", "y", "width", "height"].find(
    (key) => Math.abs(Number(textRect[key]) - Number(inputRect[key])) > 1e-6,
  );
  if (rectMismatch) return invalid("当前完整文字矩形与传入采样矩形不一致（" + rectMismatch + "）");
  if (typeof document.elementFromPoint !== "function") return invalid("document.elementFromPoint 不可用");
  // 默认命中与采样始终使用 viewport 整数坐标；native 在 baseline 守卫后另转 document 坐标。
  let defaultHits;
  try {
    defaultHits = points.map((point) => {
      const hit = document.elementFromPoint(point.integer.x, point.integer.y);
      return {
        kind: point.kind,
        x: point.integer.x,
        y: point.integer.y,
        top: hit ? __safeIdentity(state, hit) : null,
        withinHost: Boolean(hit && (hit === host || host.contains(hit))),
      };
    });
  } catch (error) {
    return invalid("elementFromPoint 调用失败");
  }
  return {
    ...base,
    identityValid: true,
    reason: null,
    selector: attempt.selector,
    connected: true,
    hidden: host.hidden === true,
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    pointerEvents: style.pointerEvents,
    text: String(host.textContent ?? ""),
    rect: { x: hostRect.x, y: hostRect.y, width: hostRect.width, height: hostRect.height },
    textRects,
    scroll: { x: window.scrollX, y: window.scrollY },
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    hostIdentity: __safeIdentity(state, host),
    drawingChain,
    pseudoContent,
    defaultHits,
  };
})()`;
}

/**
 * D3b toast 全过程业务守卫：只快照业务字段供 8 个检查点比对。
 * - 原宿主对象取自原 attempt.elements[0]；hidden session 存在时核对仍绑定同一宿主，
 *   恢复后 session 已被 verify 删除也不重寻同 id 节点（只核对原 attempt 引用）。
 * - 隐藏窗口内 -webkit-text-fill-color / text-shadow 的变化由原 hide/restore/verify
 *   规则负责；本守卫只负责其余业务字段稳定，比对时由调用方按阶段排除这两项。
 */
function buildToastBusinessGuardSource(attemptToken, hiddenToken) {
  return `// skinProbe: toast-guard
(() => {
  const attemptToken = ${JSON.stringify(attemptToken)};
  const hiddenToken = ${JSON.stringify(hiddenToken)};
  const hostScope = ${JSON.stringify(NATIVE_OCCLUSION_HOST_SCOPE)};
${IDENTITY_SOURCE}
  const base = { wallTime: new Date().toISOString(), performanceNow: performance.now() };
  const invalid = (reason) => ({ ...base, identityValid: false, reason });
  const state = window[${JSON.stringify(MEASUREMENT_STASH_GLOBAL)}] ?? null;
  const attempt = state ? state.attempts.get(attemptToken) : null;
  if (!attempt) return invalid("角色尝试基准不存在");
  if (attempt.elements.length !== 1) return invalid("仅支持单一宿主：基准含 " + attempt.elements.length + " 个元素");
  const host = attempt.elements[0];
  if (hiddenToken !== null) {
    const session = state.sessions.get(hiddenToken);
    if (session && session.target !== host) return invalid("隐藏样本宿主与角色尝试基准不一致");
  }
  if (String(host.tagName || "").toLowerCase() !== hostScope.tag) {
    return invalid("宿主标签不是原toast的 " + hostScope.tag.toUpperCase());
  }
  if (String(host.id || "") !== hostScope.id) return invalid("宿主 id 不是原toast的 " + hostScope.id);
  if (!String(host.className ?? "").split(/\\s+/).filter(Boolean).includes(hostScope.classNameToken)) {
    return invalid("宿主缺少原toast的 " + hostScope.classNameToken + " class");
  }
  const checked = __attemptIdentity(state, attemptToken);
  if (!checked.valid) return invalid(checked.reason);
  if (!host.isConnected) return invalid("宿主已脱离文档");
  if (window.devicePixelRatio !== 1) return invalid("仅支持 DPR1，当前 " + window.devicePixelRatio);
  if (typeof host.getRootNode === "function" && host.getRootNode() !== document) {
    return invalid("宿主不在主文档（shadow/分离根未支持）");
  }
  const style = getComputedStyle(host);
  const drawingChain = [];
  for (let current = host; current && current.nodeType === 1; current = current.parentElement) {
    const currentStyle = getComputedStyle(current);
    drawingChain.push({
      tag: String(current.tagName || "").toLowerCase(),
      opacity: String(currentStyle.opacity ?? "1"),
      filter: String(currentStyle.filter ?? "none") || "none",
      mixBlendMode: String(currentStyle.mixBlendMode ?? "normal") || "normal",
      backdropFilter: String((currentStyle.backdropFilter ?? currentStyle.webkitBackdropFilter) ?? "none") || "none",
    });
  }
  const pseudoContent = {};
  for (const pseudo of ["::before", "::after"]) {
    const pseudoStyle = getComputedStyle(host, pseudo);
    pseudoContent[pseudo] = String(pseudoStyle?.content ?? "none");
  }
  const text = String(host.textContent ?? "");
  const hostRect = host.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(host);
  const textRects = Array.from(range.getClientRects(), (box) => ({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  }));
  if (!attempt.toastContainers) {
    const stash = window[${JSON.stringify(SCROLL_STASH_GLOBAL)}];
    if (!stash) return invalid("缺少滚动会话");
    attempt.toastContainers = stash.containers.map((entry) => entry.node);
  }
  return {
    ...base,
    identityValid: true,
    reason: null,
    identityId: __idFor(state, host),
    text,
    hidden: host.hidden === true,
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    pointerEvents: style.pointerEvents,
    rect: { x: hostRect.x, y: hostRect.y, width: hostRect.width, height: hostRect.height },
    textRects,
    scroll: { x: window.scrollX, y: window.scrollY },
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
    containers: attempt.toastContainers.map((node) => ({
      identityId: __idFor(state, node),
      connected: node.isConnected,
      top: node.scrollTop,
      left: node.scrollLeft,
    })),
    drawingChain,
    pseudoContent,
    color: style.color,
    textFillColor: style.webkitTextFillColor,
    textShadow: style.textShadow,
    backgroundColor: style.backgroundColor,
    backgroundImage: style.backgroundImage,
  };
})()`;
}

/** 隐藏窗口内的检查点：text-fill/text-shadow 由原 hide 规则有意改写，比对时排除。 */
const TEXT_HIDE_GUARD_PHASES = new Set(["after-hide", "before-png", "after-png", "after-scan"]);

/** 单完整文字矩形前提：raw 与裁切后都恰好一个且完全一致、完整落在视口内。 */
function toastSingleFullTextRect(node, viewport) {
  const raw = node?.rawTextRects;
  const clipped = node?.textRects;
  if (!Array.isArray(raw) || raw.length !== 1 || !Array.isArray(clipped) || clipped.length !== 1) return false;
  if (node.textRectClipping?.unsupportedReason) return false;
  if (JSON.stringify(raw[0]) !== JSON.stringify(clipped[0])) return false;
  return isInsideViewport(clipped[0], viewport);
}

/** 未渲染宿主交给既有 notRendered/unmeasured 出口，不在固定视口前提里硬拒。 */
function toastNodeRendered(node) {
  return (
    node?.computed?.display !== "none" &&
    node?.computed?.visibility !== "hidden" &&
    node?.rect?.width > 0 &&
    node?.rect?.height > 0
  );
}

/**
 * toast 全过程业务守卫判定：baseline 对齐首次 node-probe 的身份/几何/前景与表面计算值；
 * 后续检查点只比对业务字段（时间字段不参与）。返回失败原因，null 表示通过。
 */
function toastBusinessGuardFailure(phase, observed, baseline, firstNode) {
  if (!observed || typeof observed !== "object") return "守卫未返回有效快照";
  if (observed.identityValid !== true) return observed.reason ?? "身份未确认";
  if (String(observed.text ?? "").trim() === "") return "宿主文字为空（toast 已清空或消失）";
  if (observed.hidden === true) return "宿主处于 hidden（toast 已隐藏）";
  if (observed.viewport?.dpr !== 1) return `仅支持 DPR1（当前 ${observed.viewport?.dpr}）`;
  if (!baseline) {
    if (!firstNode) return "缺少首次 node-probe 基准";
    if (observed.identityId !== firstNode.identityId) return "baseline 身份与首次 node-probe 不一致";
    if (observed.textRects?.length !== 1)
      return `baseline 完整文字矩形数量不是 1（当前 ${observed.textRects?.length ?? 0} 个）`;
    const probeTextRect = (firstNode.rawTextRects ?? firstNode.textRects)?.[0];
    if (!probeTextRect || JSON.stringify(observed.textRects?.[0]) !== JSON.stringify(probeTextRect)) {
      return "baseline 完整文字矩形与首次 node-probe 不一致";
    }
    if (observed.color !== firstNode.computed?.color) return "baseline 前景色与首次 node-probe 不一致";
    if (observed.textFillColor !== firstNode.computed?.textFillColor)
      return "baseline 文字填充色与首次 node-probe 不一致";
    if (observed.backgroundColor !== firstNode.computed?.backgroundColor)
      return "baseline 背景色与首次 node-probe 不一致";
    if (observed.backgroundImage !== firstNode.computed?.backgroundImage)
      return "baseline 背景图与首次 node-probe 不一致";
    return null;
  }
  if (observed.identityId !== baseline.identityId) return "宿主身份漂移（同 id 替换或原对象脱离）";
  if (observed.text !== baseline.text) return "文字内容变化（清空或替换）";
  if (
    observed.display !== baseline.display ||
    observed.visibility !== baseline.visibility ||
    observed.opacity !== baseline.opacity
  ) {
    return "可见性或整体透明度变化";
  }
  if (observed.pointerEvents !== baseline.pointerEvents) return "pointer-events 变化";
  if (JSON.stringify(observed.rect) !== JSON.stringify(baseline.rect)) return "宿主几何漂移";
  if (observed.textRects?.length !== 1) return `完整文字矩形数量变化（当前 ${observed.textRects?.length ?? 0} 个）`;
  if (JSON.stringify(observed.textRects) !== JSON.stringify(baseline.textRects)) return "完整文字矩形漂移";
  if (
    JSON.stringify(observed.scroll) !== JSON.stringify(baseline.scroll) ||
    JSON.stringify(observed.viewport) !== JSON.stringify(baseline.viewport)
  ) {
    return "窗口滚动或视口漂移";
  }
  if (JSON.stringify(observed.containers) !== JSON.stringify(baseline.containers)) return "滚动容器位置或连接状态漂移";
  if (JSON.stringify(observed.drawingChain) !== JSON.stringify(baseline.drawingChain))
    return "支持范围内的绘制属性变化";
  if (JSON.stringify(observed.pseudoContent) !== JSON.stringify(baseline.pseudoContent)) return "伪元素生成内容变化";
  if (observed.color !== baseline.color) return "前景色变化";
  if (observed.backgroundColor !== baseline.backgroundColor || observed.backgroundImage !== baseline.backgroundImage) {
    return "背景色源变化（中途换色不算同一次测量）";
  }
  if (!TEXT_HIDE_GUARD_PHASES.has(phase)) {
    if (observed.textFillColor !== baseline.textFillColor) return "文字填充色未恢复";
    if (observed.textShadow !== baseline.textShadow) return "文字阴影未恢复";
  }
  return null;
}

const NATIVE_SNAPSHOT_TRANSIENT_FIELDS = new Set(["wallTime", "performanceNow", "reason"]);

/** 首个漂移字段（消息与证据共用）；时间字段不算业务漂移。 */
function firstNativeSnapshotDifference(baseline, snapshot) {
  const keys = new Set([...Object.keys(baseline ?? {}), ...Object.keys(snapshot ?? {})]);
  for (const key of keys) {
    if (NATIVE_SNAPSHOT_TRANSIENT_FIELDS.has(key)) continue;
    if (JSON.stringify(baseline?.[key]) !== JSON.stringify(snapshot?.[key])) return key;
  }
  return null;
}

/** plain 身份副本：结果里只放真实节点的 plain 信息，不携带页内对象。 */
function copyOcclusionIdentity(top) {
  if (!top) return null;
  return {
    identityId: top.identityId,
    tag: top.tag,
    id: top.id ?? null,
    className: top.className ?? null,
    hostType: top.hostType ?? null,
    inputType: top.inputType ?? null,
  };
}

/** 输入校验 + 复用 pointerProbe 原五点坐标（不在此重算五点公式）。 */
function nativeOcclusionInput(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("probeToastNativeOcclusion: 需要 options 对象");
  }
  const { page, attemptToken, hiddenToken, rects, pointerProbe } = options;
  if (!page || typeof page !== "object" || typeof page.evaluate !== "function" || typeof page.context !== "function") {
    throw new TypeError("probeToastNativeOcclusion: page 需要具备 evaluate 与 context() 的页面对象");
  }
  if (
    typeof attemptToken !== "string" ||
    attemptToken === "" ||
    typeof hiddenToken !== "string" ||
    hiddenToken === ""
  ) {
    throw new TypeError("probeToastNativeOcclusion: attemptToken/hiddenToken 必须是非空字符串");
  }
  if (!Array.isArray(rects) || rects.length !== 1) {
    throw new TypeError("probeToastNativeOcclusion: 仅支持单一文字矩形（rects.length === 1）");
  }
  const rect = rects[0];
  if (
    !rect ||
    !["x", "y", "width", "height"].every((key) => Number.isFinite(rect[key])) ||
    !(rect.width > 0) ||
    !(rect.height > 0)
  ) {
    throw new TypeError("probeToastNativeOcclusion: rects[0] 不是有效几何");
  }
  if (!pointerProbe || typeof pointerProbe !== "object" || Array.isArray(pointerProbe)) {
    throw new TypeError("probeToastNativeOcclusion: 缺少 buildOcclusionProbeSource 的原结果");
  }
  if (pointerProbe.error)
    throw new TypeError(`probeToastNativeOcclusion: 原遮挡探针错误：${String(pointerProbe.error)}`);
  if (pointerProbe.identityValid !== true) throw new TypeError("probeToastNativeOcclusion: 原遮挡探针身份未确认");
  if (!Number.isFinite(pointerProbe.scroll?.x) || !Number.isFinite(pointerProbe.scroll?.y)) {
    throw new TypeError("probeToastNativeOcclusion: 原遮挡探针滚动信息不完整");
  }
  const probeRect = Array.isArray(pointerProbe.rects) && pointerProbe.rects.length === 1 ? pointerProbe.rects[0] : null;
  if (!probeRect) throw new TypeError("probeToastNativeOcclusion: 原遮挡探针必须是单一矩形五点");
  if (
    probeRect.rectIndex !== 0 ||
    !Array.isArray(probeRect.points) ||
    probeRect.points.length !== OCCLUSION_POINT_KINDS.length
  ) {
    throw new TypeError("probeToastNativeOcclusion: 原遮挡探针必须是单一矩形五点");
  }
  const points = probeRect.points.map((point, index) => {
    if (
      !point ||
      point.kind !== OCCLUSION_POINT_KINDS[index] ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      typeof point.withinHost !== "boolean"
    ) {
      throw new TypeError(`probeToastNativeOcclusion: 原遮挡探针第 ${index} 点无效`);
    }
    const integer = { x: Math.round(point.x), y: Math.round(point.y) };
    if (
      integer.x < rect.x ||
      integer.x >= rect.x + rect.width ||
      integer.y < rect.y ||
      integer.y >= rect.y + rect.height
    ) {
      throw new TypeError(`probeToastNativeOcclusion: 第 ${index} 点（${point.kind}）取整后越出原文字矩形`);
    }
    if (point.x < rect.x || point.x > rect.x + rect.width || point.y < rect.y || point.y > rect.y + rect.height) {
      throw new TypeError(`probeToastNativeOcclusion: 第 ${index} 点（${point.kind}）原点越出原文字矩形`);
    }
    return { kind: point.kind, x: point.x, y: point.y, integer };
  });
  return {
    page,
    attemptToken,
    hiddenToken,
    rect,
    points,
    pointerScroll: { x: pointerProbe.scroll.x, y: pointerProbe.scroll.y },
    pointerDiagnostics: {
      identityValid: true,
      scroll: { x: pointerProbe.scroll.x, y: pointerProbe.scroll.y },
      rects: [
        {
          rectIndex: 0,
          points: points.map((point, index) => ({
            kind: point.kind,
            x: point.x,
            y: point.y,
            top: copyOcclusionIdentity(probeRect.points[index].top),
            withinHost: probeRect.points[index].withinHost,
          })),
        },
      ],
    },
  };
}

/** 尽力附部分诊断；冻结/不可写错误不能因此换掉原错误对象。 */
function attachNativeOcclusionEvidence(error, evidence) {
  try {
    if (error && (typeof error === "object" || typeof error === "function")) {
      Object.defineProperty(error, "toastOcclusionEvidence", {
        value: evidence,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  } catch {
    // 诊断附加失败只影响可观测性，保持原错误对象不变
  }
}

async function runNativeOcclusionProbe(cdpSession, input, evidence) {
  const { page, attemptToken, hiddenToken, points } = input;
  const snapshotAt = async (label) => {
    evidence.stage = `guard:${label}`;
    const snapshot = await page.evaluate(
      buildNativeOcclusionGuardSource(attemptToken, hiddenToken, input.rect, points),
    );
    if (!snapshot || typeof snapshot !== "object") throw new Error(`原生命中守卫未返回有效快照（${label}）`);
    if (snapshot.identityValid !== true) {
      throw new Error(`原生命中检查失败（${label}）：${snapshot.reason ?? "身份未确认"}`);
    }
    evidence.checkpoints.push({ label, wallTime: snapshot.wallTime, performanceNow: snapshot.performanceNow });
    return snapshot;
  };
  const baseline = await snapshotAt("baseline");
  if (baseline.scroll.x !== input.pointerScroll.x || baseline.scroll.y !== input.pointerScroll.y) {
    throw new Error("原遮挡探针与页内当前滚动位置不一致");
  }
  for (const point of points) {
    const { width, height } = baseline.viewport;
    if (!(point.x >= 0 && point.x < width && point.y >= 0 && point.y < height)) {
      throw new Error(`原生命中组件：第 ${point.kind} 点原点越出当前视口`);
    }
    if (!(point.integer.x >= 0 && point.integer.x < width && point.integer.y >= 0 && point.integer.y < height)) {
      throw new Error(`原生命中组件：第 ${point.kind} 点取整后越出当前视口`);
    }
  }
  evidence.stage = "host-object";
  const hostResult = await cdpSession.send("Runtime.evaluate", {
    expression: `window[${JSON.stringify(MEASUREMENT_STASH_GLOBAL)}].attempts.get(${JSON.stringify(attemptToken)}).elements[0]`,
    objectGroup: NATIVE_OCCLUSION_OBJECT_GROUP,
  });
  const hostObjectId = hostResult?.result?.objectId;
  if (hostResult?.exceptionDetails || typeof hostObjectId !== "string" || hostObjectId === "") {
    throw new Error("原生命中组件：无法取得原宿主的 CDP 对象");
  }
  evidence.stage = "frame-tree";
  const frameTree = await cdpSession.send("Page.getFrameTree");
  const expectedFrameId = frameTree?.frameTree?.frame?.id;
  if (typeof expectedFrameId !== "string" || expectedFrameId === "") {
    throw new Error("原生命中组件：无法取得主帧 id");
  }
  const resultPoints = [];
  for (const [index, point] of points.entries()) {
    evidence.stage = `native:${point.kind}`;
    // Blink reads DOM.getNodeForLocation x/y as document CSS pixels before DocumentToFrame.
    // Keep viewport fields unchanged, and only query when the exact sum is a safe integer.
    const nativeDocument = {
      x: point.integer.x + baseline.scroll.x,
      y: point.integer.y + baseline.scroll.y,
    };
    evidence.currentPoint = {
      kind: point.kind,
      viewport: { x: point.x, y: point.y },
      viewportInteger: { x: point.integer.x, y: point.integer.y },
      scroll: { x: baseline.scroll.x, y: baseline.scroll.y },
      nativeDocument,
    };
    if (!Number.isSafeInteger(nativeDocument.x) || !Number.isSafeInteger(nativeDocument.y)) {
      throw new Error(`原生命中组件：${point.kind} 的 viewport 整数与基线 scroll 不能精确转换为安全 document 整数`);
    }
    const nativeDocumentInteger = nativeDocument;
    const location = await cdpSession.send("DOM.getNodeForLocation", {
      x: nativeDocumentInteger.x,
      y: nativeDocumentInteger.y,
      ignorePointerEventsNone: true,
    });
    if (!Number.isInteger(location?.backendNodeId) || location.backendNodeId <= 0) {
      throw new Error(`原生命中组件：${point.kind} 未返回有效 backendNodeId`);
    }
    if (location.frameId !== expectedFrameId) {
      throw new Error(`原生命中组件：${point.kind} 命中帧 ${String(location.frameId)} 不是主帧 ${expectedFrameId}`);
    }
    const resolved = await cdpSession.send("DOM.resolveNode", {
      backendNodeId: location.backendNodeId,
      objectGroup: NATIVE_OCCLUSION_OBJECT_GROUP,
    });
    const hitObjectId = resolved?.object?.objectId;
    if (typeof hitObjectId !== "string" || hitObjectId === "") {
      throw new Error(`原生命中组件：${point.kind} 的 backendNodeId=${location.backendNodeId} 未能解析为对象`);
    }
    const compared = await cdpSession.send("Runtime.callFunctionOn", {
      objectId: hostObjectId,
      functionDeclaration: NATIVE_HIT_DECLARATION,
      arguments: [{ objectId: hitObjectId }],
      returnByValue: true,
    });
    if (compared?.exceptionDetails) {
      throw new Error(`原生命中组件：${point.kind} 在原宿主对象上的命中比较抛出异常`);
    }
    const hit = compared?.result?.value;
    if (
      !hit ||
      typeof hit !== "object" ||
      typeof hit.withinHost !== "boolean" ||
      typeof hit.hostConnected !== "boolean"
    ) {
      throw new Error(`原生命中组件：${point.kind} 命中比较返回无效结果`);
    }
    if (hit.hostConnected !== true) {
      throw new Error(`原生命中组件：${point.kind} 比较期间原宿主已脱离文档`);
    }
    if (!hit.top || !Number.isInteger(hit.top.identityId) || typeof hit.top.tag !== "string") {
      throw new Error(`原生命中组件：${point.kind} 命中节点身份无效`);
    }
    const after = await snapshotAt(`after:${point.kind}`);
    const drift = firstNativeSnapshotDifference(baseline, after);
    if (drift) throw new Error(`原生命中检查点漂移（after:${point.kind}）：${drift} 与基线不一致`);
    resultPoints.push({
      kind: point.kind,
      x: point.x,
      y: point.y,
      integer: { x: point.integer.x, y: point.integer.y },
      coordinates: {
        viewport: { x: point.x, y: point.y },
        viewportInteger: { x: point.integer.x, y: point.integer.y },
        scroll: { x: baseline.scroll.x, y: baseline.scroll.y },
        nativeDocumentInteger,
      },
      top: copyOcclusionIdentity(hit.top),
      withinHost: hit.withinHost,
      defaultHit: {
        x: point.integer.x,
        y: point.integer.y,
        top: copyOcclusionIdentity(baseline.defaultHits?.[index]?.top),
        withinHost: baseline.defaultHits?.[index]?.withinHost === true,
      },
      source: NATIVE_OCCLUSION_SOURCE,
      frameId: location.frameId,
      backendNodeId: location.backendNodeId,
      hostMatch: { connected: true, withinHost: hit.withinHost },
    });
    evidence.pointsProbed = index + 1;
  }
  const final = await snapshotAt("after");
  const finalDrift = firstNativeSnapshotDifference(baseline, final);
  if (finalDrift) throw new Error(`原生命中检查点漂移（after）：${finalDrift} 与基线不一致`);
  return {
    identityValid: true,
    source: NATIVE_OCCLUSION_SOURCE,
    scroll: { x: baseline.scroll.x, y: baseline.scroll.y },
    rects: [{ rectIndex: 0, points: resultPoints }],
    pointerProbe: input.pointerDiagnostics,
    host: {
      attemptToken,
      hiddenToken,
      selector: baseline.selector,
      identityId: baseline.hostIdentity?.identityId ?? null,
      connected: true,
    },
    frame: { main: expectedFrameId },
    checkpoints: evidence.checkpoints,
  };
}

/**
 * 单 toast 原生命中遮挡组件：沿用 buildOcclusionProbeSource 的五点坐标，用本组件自有的
 * CDP 会话逐点取 DOM.getNodeForLocation(ignorePointerEventsNone) 并与原宿主对象比较。
 * 失败一律抛出（含原样保留的原始错误值）；不写文字 ratio，不做 pass/fail 判读。
 */
export async function probeToastNativeOcclusion(options) {
  const input = nativeOcclusionInput(options);
  const evidence = {
    source: NATIVE_OCCLUSION_SOURCE,
    stage: "validated",
    attemptToken: input.attemptToken,
    hiddenToken: input.hiddenToken,
    pointsProbed: 0,
    checkpoints: [],
  };
  let cdpSession = null;
  let result = null;
  let primaryThrown = false;
  let primaryError;
  try {
    const context = input.page.context();
    if (!context || typeof context.newCDPSession !== "function") {
      throw new TypeError("probeToastNativeOcclusion: page.context().newCDPSession 不可用（需要 CDP）");
    }
    cdpSession = await context.newCDPSession(input.page);
    result = await runNativeOcclusionProbe(cdpSession, input, evidence);
  } catch (error) {
    primaryThrown = true;
    primaryError = error;
  }
  const cleanupErrors = [];
  if (cdpSession) {
    try {
      await cdpSession.send("Runtime.releaseObjectGroup", { objectGroup: NATIVE_OCCLUSION_OBJECT_GROUP });
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await cdpSession.detach();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (primaryThrown) {
    attachNativeOcclusionEvidence(primaryError, evidence);
    if (cleanupErrors.length > 0) {
      throw new AggregateError([primaryError, ...cleanupErrors], "原生命中组件失败且 CDP 清理也失败", {
        cause: primaryError,
      });
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    const cleanupError = new AggregateError(cleanupErrors, "原生命中组件 CDP 清理失败，不返回可信命中");
    attachNativeOcclusionEvidence(cleanupError, evidence);
    throw cleanupError;
  }
  return result;
}

// ---------------------------------------------------------------------------
// B79 private input-placeholder native layout resolver.
// This is intentionally not wired into text measurement yet.
// ---------------------------------------------------------------------------

const INPUT_PLACEHOLDER_LAYOUT_OBJECT_GROUP = "skin-palette-input-placeholder-native-layout";
const INPUT_PLACEHOLDER_LAYOUT_SNAPSHOT = `function(current) {
  const document = this.ownerDocument;
  const view = document && document.defaultView;
  if (!view || typeof view.getComputedStyle !== "function") {
    throw new Error("input placeholder snapshot: defaultView/getComputedStyle unavailable");
  }
  const style = view.getComputedStyle(this);
  const placeholderStyle = view.getComputedStyle(this, "::placeholder");
  const rect = this.getBoundingClientRect();
  return {
    sameAttemptElement: this === current,
    connected: this.isConnected === true,
    tag: String(this.tagName || "").toLowerCase(),
    inputType: String(this.type || "").toLowerCase(),
    value: String(this.value ?? ""),
    placeholder: String(this.placeholder ?? ""),
    focused: document.activeElement === this,
    selectionStart: this.selectionStart,
    selectionEnd: this.selectionEnd,
    selectionDirection: this.selectionDirection,
    scroll: { x: view.scrollX, y: view.scrollY },
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    client: {
      left: this.clientLeft,
      top: this.clientTop,
      width: this.clientWidth,
      height: this.clientHeight,
    },
    style: {
      fontSize: style.fontSize,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      lineHeight: style.lineHeight,
      paddingTop: style.paddingTop,
      paddingRight: style.paddingRight,
      paddingBottom: style.paddingBottom,
      paddingLeft: style.paddingLeft,
      borderTopWidth: style.borderTopWidth,
      borderRightWidth: style.borderRightWidth,
      borderBottomWidth: style.borderBottomWidth,
      borderLeftWidth: style.borderLeftWidth,
      direction: style.direction,
      writingMode: style.writingMode,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      transform: style.transform,
      textFillColor: style.webkitTextFillColor,
      textShadow: style.textShadow,
    },
    placeholderStyle: {
      fontSize: placeholderStyle.fontSize,
      fontFamily: placeholderStyle.fontFamily,
      fontWeight: placeholderStyle.fontWeight,
      lineHeight: placeholderStyle.lineHeight,
      display: placeholderStyle.display,
      visibility: placeholderStyle.visibility,
      opacity: placeholderStyle.opacity,
      textFillColor: placeholderStyle.webkitTextFillColor,
      textShadow: placeholderStyle.textShadow,
    },
    fontsStatus: document.fonts ? document.fonts.status : null,
  };
}`;

const INPUT_PLACEHOLDER_NATIVE_TEXT_PAINT = `function(host) {
  const parent = this.parentElement;
  const view = parent?.ownerDocument?.defaultView;
  const style = parent && view?.getComputedStyle
    ? view.getComputedStyle(parent)
    : null;
  let rootHostIsOriginal = false;
  try {
    rootHostIsOriginal = this.getRootNode?.().host === host;
  } catch {}
  return {
    nodeValue: String(this.nodeValue ?? ""),
    isConnected: this.isConnected === true,
    rootHostIsOriginal,
    parentElement: parent && style
      ? {
          isConnected: parent.isConnected === true,
          style: {
            textFillColor: style.webkitTextFillColor,
            textShadow: style.textShadow,
            visibility: style.visibility,
            opacity: style.opacity,
          },
        }
      : null,
  };
}`;

function inputPlaceholderLayoutInput(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("resolveInputPlaceholderNativeLayout: 需要 options 对象");
  }
  const { page, attemptToken, nodeIndex, roleId, pseudo, expectedNode, expectedLayout = null } = options;
  if (!page || typeof page.context !== "function") {
    throw new TypeError("resolveInputPlaceholderNativeLayout: page.context 不可用");
  }
  if (typeof attemptToken !== "string" || attemptToken === "") {
    throw new TypeError("resolveInputPlaceholderNativeLayout: attemptToken 必须是非空字符串");
  }
  if (!Number.isInteger(nodeIndex) || nodeIndex < 0) {
    throw new TypeError("resolveInputPlaceholderNativeLayout: nodeIndex 必须是非负整数");
  }
  if (roleId !== "input.placeholder" || pseudo !== "::placeholder") {
    throw new TypeError("resolveInputPlaceholderNativeLayout: 仅支持 input.placeholder ::placeholder");
  }
  if (
    !expectedNode ||
    typeof expectedNode !== "object" ||
    expectedNode.index !== nodeIndex ||
    expectedNode.hostType !== "input" ||
    !["text", "search"].includes(expectedNode.inputType) ||
    expectedNode.hasValue !== false ||
    expectedNode.hasPlaceholder !== true
  ) {
    throw new TypeError("resolveInputPlaceholderNativeLayout: expectedNode 与空 text/search placeholder 不匹配");
  }
  if (
    expectedLayout !== null &&
    (!expectedLayout ||
      typeof expectedLayout !== "object" ||
      !Number.isInteger(expectedLayout.hostBackendNodeId) ||
      expectedLayout.hostBackendNodeId <= 0 ||
      !Number.isInteger(expectedLayout.backendNodeId) ||
      expectedLayout.backendNodeId <= 0 ||
      typeof expectedLayout.placeholder !== "string" ||
      expectedLayout.placeholder === "" ||
      !expectedLayout.offset ||
      !["x", "y", "width", "height"].every((key) => Number.isFinite(expectedLayout.offset[key])))
  ) {
    throw new TypeError("resolveInputPlaceholderNativeLayout: expectedLayout 无效");
  }
  return {
    page,
    attemptToken,
    nodeIndex,
    expectedNode,
    expectedLayout,
  };
}

function inputPlaceholderStashExpression(attemptToken, nodeIndex) {
  return `window[${JSON.stringify(MEASUREMENT_STASH_GLOBAL)}].attempts.get(${JSON.stringify(attemptToken)}).elements[${nodeIndex}]`;
}

function inputPlaceholderCandidateScan(root, placeholderText) {
  const candidates = [];
  const nonUaExactTexts = [];
  const invalidBackendNodeIds = [];
  const stack = [{ node: root, path: "node", underUa: false, level: 0 }];
  while (stack.length > 0) {
    const current = stack.pop();
    const node = current.node;
    if (!node || typeof node !== "object") continue;
    const underUa = current.underUa || node.shadowRootType === "user-agent";
    if (node.nodeType === 3 && node.nodeValue === placeholderText && underUa) {
      const candidate = {
        kind: "exact-text",
        path: current.path,
        backendNodeId: node.backendNodeId,
        nodeType: node.nodeType,
        nodeName: node.nodeName,
        nodeValue: node.nodeValue,
        underUa: true,
      };
      if (!Number.isInteger(candidate.backendNodeId) || candidate.backendNodeId <= 0) {
        invalidBackendNodeIds.push(candidate);
      } else {
        candidates.push(candidate);
      }
    } else if (node.nodeType === 3 && node.nodeValue === placeholderText) {
      nonUaExactTexts.push(current.path);
    }
    if (current.level >= 8) continue;
    for (const property of ["children", "shadowRoots", "pseudoElements"]) {
      const values = Array.isArray(node[property]) ? node[property] : [];
      for (let index = values.length - 1; index >= 0; index -= 1) {
        stack.push({
          node: values[index],
          path: `${current.path}.${property}[${index}]`,
          underUa,
          level: current.level + 1,
        });
      }
    }
  }
  const unique = candidates.filter(
    (candidate, index, values) =>
      values.findIndex((entry) => entry.backendNodeId === candidate.backendNodeId) === index,
  );
  return { candidates: unique, nonUaExactTexts, invalidBackendNodeIds };
}

function inputPlaceholderAxisAlignedRect(quads) {
  if (!Array.isArray(quads) || quads.length !== 1) {
    return { error: "getContentQuads 必须只返回一个 quad" };
  }
  const quad = quads[0];
  if (!Array.isArray(quad) || quad.length !== 8 || !quad.every(Number.isFinite)) {
    return { error: "getContentQuads quad 必须是 8 个有限数值" };
  }
  const points = [
    { x: quad[0], y: quad[1] },
    { x: quad[2], y: quad[3] },
    { x: quad[4], y: quad[5] },
    { x: quad[6], y: quad[7] },
  ];
  const tolerance = 0.01;
  const aligned =
    Math.abs(points[0].y - points[1].y) <= tolerance &&
    Math.abs(points[1].x - points[2].x) <= tolerance &&
    Math.abs(points[2].y - points[3].y) <= tolerance &&
    Math.abs(points[3].x - points[0].x) <= tolerance;
  if (!aligned) return { error: "getContentQuads quad 不是轴对齐矩形" };
  const x = Math.min(...points.map((point) => point.x));
  const y = Math.min(...points.map((point) => point.y));
  const width = Math.max(...points.map((point) => point.x)) - x;
  const height = Math.max(...points.map((point) => point.y)) - y;
  if (!(width > 0 && height > 0)) return { error: "getContentQuads quad 没有正面积" };
  return { rect: { x, y, width, height }, rawQuad: [...quad] };
}

function inputPlaceholderContentRect(snapshot) {
  const values = ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"].map((key) =>
    Number.parseFloat(snapshot?.style?.[key]),
  );
  if (!values.every(Number.isFinite)) return null;
  const [paddingTop, paddingRight, paddingBottom, paddingLeft] = values;
  const width = snapshot.client.width - paddingLeft - paddingRight;
  const height = snapshot.client.height - paddingTop - paddingBottom;
  if (!(width > 0 && height > 0)) return null;
  return {
    x: snapshot.rect.x + snapshot.client.left + paddingLeft,
    y: snapshot.rect.y + snapshot.client.top + paddingTop,
    width,
    height,
  };
}

function inputPlaceholderRectInside(rect, bounds, tolerance = 0.01) {
  return (
    rect.x >= bounds.x - tolerance &&
    rect.y >= bounds.y - tolerance &&
    rect.x + rect.width <= bounds.x + bounds.width + tolerance &&
    rect.y + rect.height <= bounds.y + bounds.height + tolerance
  );
}

function inputPlaceholderRectsEqual(left, right, tolerance = 0.01) {
  return ["x", "y", "width", "height"].every(
    (key) =>
      Number.isFinite(left?.[key]) && Number.isFinite(right?.[key]) && Math.abs(left[key] - right[key]) <= tolerance,
  );
}

function inputPlaceholderClientEqual(left, right, tolerance = 0.01) {
  return ["left", "top", "width", "height"].every(
    (key) =>
      Number.isFinite(left?.[key]) && Number.isFinite(right?.[key]) && Math.abs(left[key] - right[key]) <= tolerance,
  );
}

function inputPlaceholderDocumentRect(node) {
  if (
    !["x", "y", "width", "height"].every((key) => Number.isFinite(node?.rect?.[key])) ||
    !["x", "y"].every((key) => Number.isFinite(node?.scroll?.[key]))
  ) {
    return null;
  }
  return {
    x: node.rect.x + node.scroll.x,
    y: node.rect.y + node.scroll.y,
    width: node.rect.width,
    height: node.rect.height,
  };
}

function inputPlaceholderExpectedLayoutFailure(expected, before, candidate, offset, hostBackendNodeId) {
  if (!expected) return null;
  if (hostBackendNodeId !== expected.hostBackendNodeId) return "原 input backendNodeId 已变化";
  if (before.placeholder !== expected.placeholder) return "原 input placeholder 文案已变化";
  if (candidate.backendNodeId !== expected.backendNodeId) return "placeholder 候选 backendNodeId 已变化";
  if (expected.candidateKind && candidate.kind !== expected.candidateKind) return "placeholder 候选类型已变化";
  if (!inputPlaceholderRectsEqual(offset, expected.offset)) return "placeholder host-relative offset 已变化";
  return null;
}

function inputPlaceholderSnapshotProjection(snapshot) {
  const projection = { ...(snapshot ?? {}) };
  delete projection.sameAttemptElement;
  return projection;
}

function inputPlaceholderSnapshotFailure(expectedNode, before, after = null) {
  if (before?.sameAttemptElement !== true) return "原 input 对象与 stash attempt 位次不一致";
  if (before.connected !== true) return "原 input 已脱离文档";
  if (before.tag !== "input" || !["text", "search"].includes(before.inputType)) {
    return "原对象不是 text/search input";
  }
  if (before.value !== "") return "原 input value 非空";
  if (before.placeholder === "") return "原 input placeholder 为空";
  if (before.inputType !== expectedNode.inputType) return "原 input type 与调用参数不一致";
  if (!inputPlaceholderRectsEqual(before.rect, expectedNode.rect)) return "原 input 几何与调用参数不一致";
  if (!inputPlaceholderClientEqual(before.client, expectedNode.client)) return "原 input client 与调用参数不一致";
  if (expectedNode.computed?.fontSize != null && before.style.fontSize !== expectedNode.computed.fontSize) {
    return "原 input fontSize 与调用参数不一致";
  }
  if (expectedNode.computed?.fontWeight != null && before.style.fontWeight !== expectedNode.computed.fontWeight) {
    return "原 input fontWeight 与调用参数不一致";
  }
  if (after) {
    if (after.sameAttemptElement !== true) return "读取期间原 input stash 对象已替换";
    if (after.connected !== true) return "读取期间原 input 已脱离文档";
    if (
      JSON.stringify(inputPlaceholderSnapshotProjection(before)) !==
      JSON.stringify(inputPlaceholderSnapshotProjection(after))
    ) {
      return "读取期间原 input 几何、样式、value、焦点、selection、scroll 或字体状态漂移";
    }
  }
  return null;
}

function attachInputPlaceholderLayoutEvidence(error, evidence) {
  try {
    if (error && (typeof error === "object" || typeof error === "function")) {
      Object.defineProperty(error, "inputPlaceholderLayoutEvidence", {
        value: evidence,
        writable: true,
        configurable: true,
        enumerable: false,
      });
    }
  } catch {
    // 诊断附加失败只影响可观测性，保持原错误对象不变
  }
}

async function inputPlaceholderObjectId(cdpSession, expression) {
  const evaluated = await cdpSession.send("Runtime.evaluate", {
    expression,
    objectGroup: INPUT_PLACEHOLDER_LAYOUT_OBJECT_GROUP,
  });
  const objectId = evaluated?.result?.objectId;
  if (typeof objectId !== "string" || objectId === "") {
    throw new Error("input placeholder native layout: stash 未返回原 input objectId");
  }
  return objectId;
}

async function inputPlaceholderSnapshot(cdpSession, objectId, currentObjectId) {
  const result = await cdpSession.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: INPUT_PLACEHOLDER_LAYOUT_SNAPSHOT,
    arguments: [{ objectId: currentObjectId }],
    returnByValue: true,
  });
  if (result?.exceptionDetails) {
    throw new Error("input placeholder native layout: 原 input 快照抛出异常");
  }
  const snapshot = result?.result?.value;
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("input placeholder native layout: 原 input 快照返回无效值");
  }
  return snapshot;
}

async function inputPlaceholderNativeTextPaint(cdpSession, candidate, hostObjectId) {
  const resolved = await cdpSession.send("DOM.resolveNode", {
    backendNodeId: candidate.backendNodeId,
    objectGroup: INPUT_PLACEHOLDER_LAYOUT_OBJECT_GROUP,
  });
  const objectId = resolved?.object?.objectId;
  if (typeof objectId !== "string" || objectId === "") {
    throw new Error("input placeholder native layout: 原 UA 文本节点不可解析");
  }
  const result = await cdpSession.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: INPUT_PLACEHOLDER_NATIVE_TEXT_PAINT,
    arguments: [{ objectId: hostObjectId }],
    returnByValue: true,
  });
  if (result?.exceptionDetails) {
    throw new Error("input placeholder native layout: 原 UA 文本样式快照抛出异常");
  }
  const paint = result?.result?.value;
  if (!paint || typeof paint !== "object" || paint.parentElement === null) {
    return { error: "原 UA 文本节点缺少 parentElement 样式快照" };
  }
  if (paint.nodeValue !== candidate.nodeValue) {
    return { error: "原 UA 文本 nodeValue 已变化" };
  }
  if (paint.isConnected !== true || paint.parentElement.isConnected !== true) {
    return { error: "原 UA 文本节点或 parentElement 已脱离文档" };
  }
  if (paint.rootHostIsOriginal !== true) {
    return { error: "原 UA 文本节点不再属于原 input host" };
  }
  const style = paint.parentElement.style;
  if (
    !style ||
    [style.textFillColor, style.textShadow, style.visibility, style.opacity].some((value) => typeof value !== "string")
  ) {
    return { error: "原 UA 文本 parentElement computed 样式不完整" };
  }
  return {
    backendNodeId: candidate.backendNodeId,
    ...paint,
  };
}

async function runInputPlaceholderNativeLayout(cdpSession, input, evidence) {
  const expression = inputPlaceholderStashExpression(input.attemptToken, input.nodeIndex);
  evidence.stage = "bind-before";
  const hostObjectId = await inputPlaceholderObjectId(cdpSession, expression);
  const currentBeforeObjectId = await inputPlaceholderObjectId(cdpSession, expression);
  evidence.stage = "snapshot-before";
  const before = await inputPlaceholderSnapshot(cdpSession, hostObjectId, currentBeforeObjectId);
  evidence.before = before;
  const initialFailure = inputPlaceholderSnapshotFailure(input.expectedNode, before);
  if (initialFailure) {
    return { status: "unmeasured", reason: initialFailure, evidence };
  }

  evidence.stage = "describe";
  const described = await cdpSession.send("DOM.describeNode", {
    objectId: hostObjectId,
    depth: 2,
    pierce: true,
  });
  const hostBackendNodeId = described?.node?.backendNodeId;
  if (!Number.isInteger(hostBackendNodeId) || hostBackendNodeId <= 0) {
    throw new Error("input placeholder native layout: describeNode 未返回原 input backendNodeId");
  }
  evidence.hostBackendNodeId = hostBackendNodeId;
  if (input.expectedLayout && hostBackendNodeId !== input.expectedLayout.hostBackendNodeId) {
    return { status: "unmeasured", reason: "原 input backendNodeId 已变化", evidence };
  }
  if (input.expectedLayout && before.placeholder !== input.expectedLayout.placeholder) {
    return { status: "unmeasured", reason: "原 input placeholder 文案已变化", evidence };
  }
  const scan = inputPlaceholderCandidateScan(described.node, before.placeholder);
  evidence.candidateCounts = {
    candidates: scan.candidates.length,
    nonUaExactTexts: scan.nonUaExactTexts.length,
    invalidBackendNodeIds: scan.invalidBackendNodeIds.length,
  };
  if (scan.invalidBackendNodeIds.length > 0) {
    return {
      status: "unmeasured",
      reason: "输入 placeholder 原生候选 backendNodeId 无效",
      evidence,
    };
  }
  if (scan.candidates.length !== 1) {
    const reason =
      scan.candidates.length === 0
        ? `user-agent shadow 中未找到唯一精确 placeholder #text；非UA精确文本=${scan.nonUaExactTexts.length}`
        : `输入 placeholder 原生候选不唯一（${scan.candidates.length}）`;
    return { status: "unmeasured", reason, evidence };
  }
  const candidate = scan.candidates[0];
  evidence.candidate = candidate;
  if (input.expectedLayout && candidate.backendNodeId !== input.expectedLayout.backendNodeId) {
    return { status: "unmeasured", reason: "placeholder 候选 backendNodeId 已变化", evidence };
  }
  if (candidate.kind !== "exact-text" || candidate.underUa !== true) {
    return { status: "unmeasured", reason: "placeholder 候选不是原 UA shadow 精确 #text", evidence };
  }
  evidence.stage = "native-text-before";
  const nativeTextPaintBefore = await inputPlaceholderNativeTextPaint(cdpSession, candidate, hostObjectId);
  if (nativeTextPaintBefore?.error) {
    return { status: "unmeasured", reason: nativeTextPaintBefore.error, evidence };
  }
  evidence.nativeTextPaintBefore = nativeTextPaintBefore;
  evidence.stage = "content-quads";
  const quadsResult = await cdpSession.send("DOM.getContentQuads", {
    backendNodeId: candidate.backendNodeId,
  });
  evidence.rawQuads = quadsResult?.quads ?? null;
  const quad = inputPlaceholderAxisAlignedRect(quadsResult?.quads);

  evidence.stage = "native-text-after";
  const nativeTextPaintAfter = await inputPlaceholderNativeTextPaint(cdpSession, candidate, hostObjectId);
  if (nativeTextPaintAfter?.error) {
    return { status: "unmeasured", reason: nativeTextPaintAfter.error, evidence };
  }
  evidence.nativeTextPaintAfter = nativeTextPaintAfter;
  if (JSON.stringify(nativeTextPaintBefore) !== JSON.stringify(nativeTextPaintAfter)) {
    return {
      status: "unmeasured",
      reason: "quads 期间原 UA 文本、host 归属或 parent 样式漂移",
      evidence,
    };
  }

  evidence.stage = "snapshot-after";
  const currentAfterObjectId = await inputPlaceholderObjectId(cdpSession, expression);
  const after = await inputPlaceholderSnapshot(cdpSession, hostObjectId, currentAfterObjectId);
  evidence.after = after;
  const drift = inputPlaceholderSnapshotFailure(input.expectedNode, before, after);
  if (drift) return { status: "unmeasured", reason: drift, evidence };
  if (quad.error) return { status: "unmeasured", reason: quad.error, evidence };

  const contentRect = inputPlaceholderContentRect(before);
  if (!contentRect) {
    return { status: "unmeasured", reason: "原 input 内容区域无效", evidence };
  }
  if (!inputPlaceholderRectInside(quad.rect, contentRect)) {
    return { status: "unmeasured", reason: "getContentQuads quad 越出原 input 内容区域", evidence };
  }
  const offset = {
    x: quad.rect.x - before.rect.x,
    y: quad.rect.y - before.rect.y,
    width: quad.rect.width,
    height: quad.rect.height,
  };
  const expectedLayoutFailure = inputPlaceholderExpectedLayoutFailure(
    input.expectedLayout,
    before,
    candidate,
    offset,
    hostBackendNodeId,
  );
  if (expectedLayoutFailure) {
    return { status: "unmeasured", reason: expectedLayoutFailure, evidence };
  }
  const identity = {
    hostBackendNodeId,
    backendNodeId: candidate.backendNodeId,
    candidateKind: candidate.kind,
    placeholder: before.placeholder,
    offset,
  };
  evidence.stage = "resolved";
  return {
    status: "resolved",
    hostBackendNodeId,
    backendNodeId: candidate.backendNodeId,
    candidate,
    rawQuad: quad.rawQuad,
    rect: quad.rect,
    contentRect,
    offset,
    identity,
    before,
    after,
    nativeTextPaint: nativeTextPaintBefore,
    nativeTextPaintAfter,
    evidence,
  };
}

/**
 * Private B79 resolver. It is not wired into the text sampling path.
 * Expected shape failures return status:"unmeasured"; CDP/cleanup failures keep
 * the original thrown value and attempt both releaseObjectGroup and detach.
 */
async function resolveInputPlaceholderNativeLayout(options) {
  const input = inputPlaceholderLayoutInput(options);
  const evidence = {
    kind: "input-placeholder-native-layout",
    stage: "validated",
    attemptToken: input.attemptToken,
    nodeIndex: input.nodeIndex,
    hostBackendNodeId: null,
    candidate: null,
    candidateCounts: null,
    rawQuads: null,
    before: null,
    after: null,
    nativeTextPaintBefore: null,
    nativeTextPaintAfter: null,
    cleanup: null,
  };
  let cdpSession = null;
  let result = null;
  let primaryThrown = false;
  let primaryError;
  try {
    const context = input.page.context();
    if (!context || typeof context.newCDPSession !== "function") {
      throw new TypeError("resolveInputPlaceholderNativeLayout: page.context().newCDPSession 不可用");
    }
    cdpSession = await context.newCDPSession(input.page);
    result = await runInputPlaceholderNativeLayout(cdpSession, input, evidence);
  } catch (error) {
    primaryThrown = true;
    primaryError = error;
  }
  const cleanupErrors = [];
  const cleanup = { objectGroupReleased: false, cdpDetached: false };
  if (cdpSession) {
    try {
      await cdpSession.send("Runtime.releaseObjectGroup", { objectGroup: INPUT_PLACEHOLDER_LAYOUT_OBJECT_GROUP });
      cleanup.objectGroupReleased = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await cdpSession.detach();
      cleanup.cdpDetached = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  evidence.cleanup = cleanup;
  if (primaryThrown) {
    attachInputPlaceholderLayoutEvidence(primaryError, evidence);
    if (cleanupErrors.length > 0) {
      const aggregate = new AggregateError(
        [primaryError, ...cleanupErrors],
        "输入 placeholder 原生布局失败且 CDP 清理也失败",
        {
          cause: primaryError,
        },
      );
      attachInputPlaceholderLayoutEvidence(aggregate, evidence);
      throw aggregate;
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    const cleanupError = new AggregateError(cleanupErrors, "输入 placeholder 原生布局 CDP 清理失败，不返回可信结果");
    attachInputPlaceholderLayoutEvidence(cleanupError, evidence);
    throw cleanupError;
  }
  if (result) result.evidence = evidence;
  return result;
}

const INPUT_PLACEHOLDER_NATIVE_SOURCE = "cdp-ua-placeholder-quads";

function isInputPlaceholderNativeNode(role, pseudo, node) {
  return Boolean(
    role?.id === "input.placeholder" &&
      pseudo === "::placeholder" &&
      node?.hostType === "input" &&
      ["text", "search"].includes(node.inputType) &&
      node.hasValue === false &&
      node.hasPlaceholder === true,
  );
}

function inputPlaceholderNativeEvidence(result, phase) {
  return {
    phase,
    source: INPUT_PLACEHOLDER_NATIVE_SOURCE,
    status: result?.status ?? "error",
    reason: result?.reason ?? null,
    hostBackendNodeId: result?.hostBackendNodeId ?? null,
    backendNodeId: result?.backendNodeId ?? null,
    rawQuad: result?.rawQuad ?? null,
    rect: result?.rect ?? null,
    offset: result?.offset ?? null,
    identity: result?.identity ?? null,
    nativeTextPaint: result?.nativeTextPaint ?? null,
    nativeTextPaintAfter: result?.nativeTextPaintAfter ?? null,
    resolverEvidence: result?.evidence ?? null,
  };
}

function inputPlaceholderNativeStableProjection(result) {
  const before = result?.before;
  const { textFillColor: _hostTextFillColor, textShadow: _hostTextShadow, ...hostStyle } = before?.style ?? {};
  const {
    textFillColor: _placeholderTextFillColor,
    textShadow: _placeholderTextShadow,
    ...placeholderStyle
  } = before?.placeholderStyle ?? {};
  return {
    identity: result?.identity ?? null,
    host: {
      tag: before?.tag,
      inputType: before?.inputType,
      placeholder: before?.placeholder,
      focused: before?.focused,
      value: before?.value,
      selectionStart: before?.selectionStart,
      selectionEnd: before?.selectionEnd,
      selectionDirection: before?.selectionDirection,
      rect: before?.rect ? { width: before.rect.width, height: before.rect.height } : null,
      client: before?.client ?? null,
      connected: before?.connected,
      fontsStatus: before?.fontsStatus,
      style: hostStyle,
      placeholderStyle,
    },
    native: {
      nodeValue: result?.nativeTextPaint?.nodeValue,
      isConnected: result?.nativeTextPaint?.isConnected,
      rootHostIsOriginal: result?.nativeTextPaint?.rootHostIsOriginal,
      parentConnected: result?.nativeTextPaint?.parentElement?.isConnected,
      visibility: result?.nativeTextPaint?.parentElement?.style?.visibility,
      opacity: result?.nativeTextPaint?.parentElement?.style?.opacity,
    },
  };
}

async function inputPlaceholderNativeStageFailure(page, current, baseline, phase) {
  if (current?.status !== "resolved") return current?.reason ?? "原生 placeholder resolver 未解析";
  if (
    JSON.stringify(inputPlaceholderNativeStableProjection(current)) !==
    JSON.stringify(inputPlaceholderNativeStableProjection(baseline))
  ) {
    return `${phase} 阶段原 input/UA 身份、布局、焦点或文本状态漂移`;
  }
  const hidden = phase !== "restore" && phase !== "verify";
  if (hidden) {
    const hostStyle = current.before?.style;
    const nativeStyle = current.nativeTextPaint?.parentElement?.style;
    const hostFill = await parseColor(page, hostStyle?.textFillColor);
    const nativeFill = await parseColor(page, nativeStyle?.textFillColor);
    if (!hostFill.ok || hostFill.alpha !== 0) return `${phase} 阶段原 input host fill 未透明`;
    if (!nativeFill.ok || nativeFill.alpha !== 0) return `${phase} 阶段原 UA placeholder fill 未透明`;
    if (hostStyle?.textShadow !== "none" || nativeStyle?.textShadow !== "none") {
      return `${phase} 阶段 host 或原 UA placeholder 阴影未清除`;
    }
    return null;
  }
  const expectedHost = baseline.before?.style;
  const actualHost = current.before?.style;
  const expectedPlaceholder = baseline.before?.placeholderStyle;
  const actualPlaceholder = current.before?.placeholderStyle;
  const expectedNative = baseline.nativeTextPaint?.parentElement?.style;
  const actualNative = current.nativeTextPaint?.parentElement?.style;
  for (const key of ["textFillColor", "textShadow"]) {
    if (actualHost?.[key] !== expectedHost?.[key]) return `${phase} 阶段原 input host paint 未恢复`;
    if (actualPlaceholder?.[key] !== expectedPlaceholder?.[key]) return `${phase} 阶段 ::placeholder paint 未恢复`;
    if (actualNative?.[key] !== expectedNative?.[key]) return `${phase} 阶段原 UA placeholder paint 未恢复`;
  }
  return null;
}

/**
 * 测量一个状态下的预期角色。返回 { records, captures, diagnostics }；
 * records 为 M0 契约测量记录（M3.4 的 browserChecks 直接消费）。
 */
export async function measureBrowserRoles(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("measureBrowserRoles: 需要 options 对象");
  }
  const { page, candidate, mode, stateId, roleCatalog, policy, detailFillRestingPointer = null } = options;
  if (!MODES.includes(mode)) throw new TypeError(`measureBrowserRoles: 未知模式 "${String(mode)}"`);
  if (!Array.isArray(roleCatalog)) throw new TypeError("measureBrowserRoles: roleCatalog 必须是角色目录数组");
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("measureBrowserRoles: policy 必须是 M0 policy 对象");
  }
  if (
    candidate !== null &&
    candidate !== undefined &&
    (typeof candidate !== "object" || typeof candidate.id !== "string" || !candidate.id)
  ) {
    throw new TypeError("measureBrowserRoles: candidate 必须是 M0 候选对象或 null（正式色源模式）");
  }
  if (stateId !== null && stateId !== undefined && typeof stateId !== "string") {
    throw new TypeError("measureBrowserRoles: stateId 必须是字符串或 null");
  }
  if (detailFillRestingPointer !== null && typeof detailFillRestingPointer !== "function") {
    throw new TypeError("measureBrowserRoles: detailFillRestingPointer 必须是函数或 null");
  }
  const normalizedStateId = stateId ?? null;
  const roles = rolesForState(roleCatalog, normalizedStateId);
  if (typeof normalizedStateId === "string" && roles.length === 0) {
    throw new TypeError(`measureBrowserRoles: 状态 "${normalizedStateId}" 在角色目录中没有任何预期角色`);
  }
  const candidateId = candidate?.id ?? OFFICIAL_CANDIDATE_ID;

  const blockage = pageBlockage(page);
  if (blockage) {
    return environmentBlockedResult({ roles, mode, stateId: normalizedStateId, candidateId, reason: blockage });
  }

  const notes = [];
  const captures = [];
  const diagnostics = {
    environmentBlocked: false,
    mode,
    stateId: normalizedStateId,
    candidateId,
    roles: roles.length,
    counts: { pass: 0, fail: 0, unmeasured: 0, notApplicable: 0 },
    restoration: {
      styleDifferences: [],
      rectDifferences: [],
      canvasDifferences: [],
      scrollDifferences: [],
      inlineRestoreFailures: [],
      statePixelDiff: null,
      statePixelScope: null,
      spotlightStability: { budgetMs: 500, before: null, after: null, stable: false },
    },
    dpr: null,
    viewport: null,
    scroll: null,
    detailFill: null,
    notes,
  };

  // 角色截图一律用视口坐标 + 视口内 clip（fullPage 分带捕获会把 position:sticky
  // 的粘住元素重复钉到每带顶部，截到的"背景"混进前景）。目标不在视口内时由
  // collectVisibleRects 滚动到可见位置分段测量，滚动暂存/恢复见滚动会话源。
  const shoot = async (rect, kind, roleId, scroll = diagnostics.scroll) => {
    const clip = clipOf(rect);
    const png = await screenshotWithStyleAttributeGuard(page, { clip });
    const capture = {
      roleId,
      kind,
      clip,
      dpr: diagnostics.dpr,
      scroll: { ...scroll },
      pngBase64: png.toString("base64"),
    };
    captures.push(capture);
    return { index: captures.length - 1, base64: capture.pngBase64 };
  };

  const records = [];
  let phase = "before-state";
  const updateCounts = () => {
    diagnostics.counts = { pass: 0, fail: 0, unmeasured: 0, notApplicable: 0 };
    for (const record of records) {
      if (record.result === "pass") diagnostics.counts.pass += 1;
      else if (record.result === "fail") diagnostics.counts.fail += 1;
      else if (record.result === "unmeasured") diagnostics.counts.unmeasured += 1;
      else diagnostics.counts.notApplicable += 1;
    }
  };
  try {
    const viewport = await page.evaluate(`// skinProbe: viewport
(() => ({ width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY, dpr: window.devicePixelRatio || 1 }))()`);
    diagnostics.viewport = viewport;
    diagnostics.dpr = viewport.dpr;
    diagnostics.scroll = { x: viewport.scrollX, y: viewport.scrollY };
    const statePixelKind = normalizedStateId === SPOTLIGHT_DETAIL_HEADING_STATE_ID ? "viewport" : "full-page";
    const captureState = statePixelKind === "viewport" ? captureStableViewport : captureStableFullPage;
    diagnostics.restoration.statePixelScope =
      statePixelKind === "viewport"
        ? {
            kind: "viewport",
            width: viewport.width,
            height: viewport.height,
            scroll: { x: viewport.scrollX, y: viewport.scrollY },
          }
        : { kind: "full-page" };
    const statePixelLabel = statePixelKind === "viewport" ? "视口" : "整页";
    notes.push(
      `截图约定：视口坐标 + 视口内 clip（sticky 元素不能用 fullPage 分带截取）、scale=css（1 图像像素 = 1 CSS 像素）、dpr=${viewport.dpr}、初始 scroll=(${viewport.scrollX}, ${viewport.scrollY})`,
    );

    const waitForSpotlightStability = async (stage) => {
      let stability;
      try {
        stability = await page.evaluate(buildSpotlightStabilitySource());
      } catch (error) {
        stability = {
          stable: false,
          reason: `probe-error: ${error instanceof Error ? error.message : String(error)}`,
          budgetMs: 500,
          waitedMs: null,
        };
      }
      diagnostics.restoration.spotlightStability[stage] = stability;
      if (!stability.stable) {
        notes.push(
          `${statePixelLabel}${stage === "before" ? "基准" : "恢复后"}截图未满足聚光稳定条件（${stability.reason ?? "unknown"}）；仍保留图像比较，但不能视为稳定恢复。`,
        );
      }
      return stability;
    };

    await waitForSpotlightStability("before");
    // 基准截图无法原子恢复时必须中断；继续测量会让后续 PASS 失去可信页面基准。
    const stateBefore = (await captureState(page)).toString("base64");

    const runtime = { page, shoot, captures, diagnostics, notes, viewport, detailFillRestingPointer };
    phase = "roles";
    for (const role of roles) {
      const recordContext = {
        candidateId,
        mode,
        roleId: role.id,
        stateId: normalizedStateId,
        result: "",
        ratio: null,
        threshold: thresholdOf(role),
        method: "",
        evidence: "",
        reason: "",
      };
      if (
        role.id !== "focus.outline" &&
        (role.kind === "decorative" ||
          role.kind === "logotype" ||
          thresholdOf(role) === null ||
          (role.kind !== "text" && role.kind !== "graphic"))
      ) {
        records.push(notApplicableRecord(role, recordContext));
        continue;
      }
      records.push(await measureRole(role, runtime, recordContext));
    }
    phase = "after-state";
    await waitForSpotlightStability("after");
    diagnostics.restoration.spotlightStability.stable =
      diagnostics.restoration.spotlightStability.before?.stable === true &&
      diagnostics.restoration.spotlightStability.after?.stable === true;
    // 后截图失败同样不得返回已经计算出的测量记录。
    const stateAfter = (await captureState(page)).toString("base64");
    phase = "compare";
    const comparison = await page.evaluate(buildCompareImagesSource(stateBefore, stateAfter));
    diagnostics.restoration.statePixelDiff = comparison;
    if (comparison.identical === false) {
      const stateDiffCaptures = {
        before: captures.length,
        after: captures.length + 1,
      };
      for (const [kind, pngBase64] of [
        ["state-diff-before", stateBefore],
        ["state-diff-after", stateAfter],
      ]) {
        captures.push({
          roleId: null,
          kind,
          clip: null,
          dpr: diagnostics.dpr,
          scroll: { ...diagnostics.scroll },
          pngBase64,
        });
      }
      diagnostics.restoration.stateDiffCaptures = stateDiffCaptures;
      notes.push(
        `${statePixelLabel}截图前后存在像素差异（${comparison.differingPixels} px，最大通道差 ${comparison.maxChannelDelta}）`,
      );
    }

    phase = "record-validation";
    updateCounts();
    assertRecordsConform(records);
    return { records, captures, diagnostics };
  } catch (error) {
    updateCounts();
    diagnostics.partial = true;
    try {
      if (error !== null && (typeof error === "object" || typeof error === "function") && Object.isExtensible(error)) {
        Object.defineProperty(error, "measurementEvidence", {
          value: { complete: false, phase, records, captures, diagnostics },
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    } catch {
      // 诊断属性不可写时仍必须保留原错误。
    }
    throw error;
  }
}

function notApplicableRecord(role, recordContext) {
  const reason =
    role.kind === "decorative"
      ? "装饰例外：视觉评审项，不入正文 PASS 数"
      : role.kind === "logotype"
        ? "压印字标例外（总计划 §5.7）：视觉评审项，不入正文 PASS 数"
        : thresholdOf(role) === null
          ? "无阈值例外：目录未设阅读阈值，由视觉评审承担"
          : `非颜色角色 kind: ${String(role.kind)}`;
  return buildRecord({
    ...recordContext,
    roleId: role.id,
    result: "not-applicable",
    ratio: null,
    threshold: thresholdOf(role),
    method: METHOD_NOT_APPLICABLE,
    evidence: evidenceOf({ kind: METHOD_NOT_APPLICABLE, applicability: role.applicability ?? "" }),
    reason,
  });
}

function unmeasuredRecord(role, recordContext, method, reason, extra = {}) {
  return buildRecord({
    ...recordContext,
    roleId: role.id,
    result: "unmeasured",
    ratio: null,
    threshold: thresholdOf(role),
    method,
    evidence: evidenceOf({ kind: method, ...extra }),
    reason,
  });
}

/**
 * 滚动会话恢复 + 核验：还原结果逐项比对，任何不一致都进 diagnostics
 * （滚动状态没还原 = 测量改动了页面，不得静默通过）。
 */
async function restoreScrollSession(page, diagnostics, roleId, stage) {
  let result = null;
  let caughtError = null;
  try {
    result = await page.evaluate(buildRestoreScrollSource());
  } catch (error) {
    caughtError = error;
    result = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!result?.ok) {
    diagnostics.restoration.scrollDifferences.push(
      `${roleId}: ${stage}滚动会话恢复失败（${result?.reason ?? "未知原因"}）`,
    );
    return caughtError;
  }
  for (const mismatch of result.mismatches ?? []) {
    diagnostics.restoration.scrollDifferences.push(`${roleId}: ${stage}${mismatch}`);
  }
  return null;
}

/** 单角色测量：按卡面出口顺序分派到四条路径。 */
async function measureRole(role, runtime, recordContext) {
  let selector = typeof role.selector === "string" ? role.selector : null;
  if (role.id === "focus.outline" || INPUT_STATE_SELECTOR_ROLES.has(role.id) || role.selectorsByState !== undefined) {
    const selectorsByState = role.selectorsByState;
    const stateId = recordContext.stateId;
    if (!selectorsByState || typeof selectorsByState !== "object" || Array.isArray(selectorsByState)) {
      return unmeasuredRecord(
        role,
        recordContext,
        METHOD_UNMEASURED,
        `角色 ${role.id} 在状态 ${stateId ?? "(none)"} 的 selector 目录无效；拒绝回退到全局 selector`,
        { selector: null, selectorStateId: stateId },
      );
    }
    if (typeof stateId !== "string" || !Object.hasOwn(selectorsByState, stateId)) {
      return unmeasuredRecord(
        role,
        recordContext,
        METHOD_UNMEASURED,
        `角色 ${role.id} 在状态 ${stateId ?? "(none)"} 未登记 selectorsByState selector；拒绝回退到全局 selector`,
        { selector: null, selectorStateId: stateId },
      );
    }
    const stateSelector = selectorsByState[stateId];
    if (typeof stateSelector !== "string" || !stateSelector.trim()) {
      return unmeasuredRecord(
        role,
        recordContext,
        METHOD_UNMEASURED,
        `角色 ${role.id} 在状态 ${stateId} 的 selectorsByState selector 为空或非法`,
        { selector: null, selectorStateId: stateId },
      );
    }
    selector = stateSelector;
  }
  if (role.id === "focus.outline") return measureFocusOutlineRole(role, runtime, recordContext, selector);
  if (role.id === "chart.detail-fill") return measureDetailFillRole(role, runtime, recordContext, selector);
  const background = role.background;
  const backgroundKind = background && typeof background === "object" ? background.kind : null;
  const spotlightLanguageTarget = isSpotlightLanguageTarget(recordContext, role, selector);
  if (isSpotlightLanguageContract(recordContext, role, selector) && !spotlightLanguageTarget) {
    return unmeasuredRecord(
      role,
      recordContext,
      METHOD_UNMEASURED,
      "语言按钮聚光角色背景契约不是 layered/browserRequired：拒绝进入通用文字路径",
      { selector },
    );
  }

  // 1. layered / 径向聚光 / 带角色叠加：伪元素层无法隔离 → unmeasured + 原图 + 手工方法
  if (
    !spotlightLanguageTarget &&
    (backgroundKind === "layered" || (background?.browserRequired === true && backgroundKind !== "canvas"))
  ) {
    const capture = await captureOriginal(role, runtime, selector);
    return unmeasuredRecord(
      role,
      recordContext,
      METHOD_UNMEASURED,
      "叠加层（径向聚光/混合）无法与底部分离：按卡面步骤 7 保留 unmeasured；其覆盖范围内的必要文字角色已按真实合成背景测量",
      {
        selector,
        description: typeof background.description === "string" ? background.description : "",
        capture: capture.index,
        captureNote: capture.note,
        manualMethod: "在原尺寸截图上对覆盖范围内的必要文字逐点取样，按实际 alpha 合成后计算",
      },
    );
  }

  // 2. canvas 实际绘制（chart.*）：观察器记录 + bitmap 暂存/清前景/恢复。
  //    画布选择器在背景对象上（角色自身 selector 多为 null）。
  if (backgroundKind === "canvas") {
    const canvasSelector = typeof background?.canvasSelector === "string" ? background.canvasSelector : selector;
    if (canvasSelector) return measureCanvasRole(role, runtime, recordContext, canvasSelector);
    return unmeasuredRecord(role, recordContext, METHOD_UNMEASURED, "canvas 背景未登记 canvasSelector，无法定位画布", {
      selector,
    });
  }

  if (!selector) {
    return unmeasuredRecord(role, recordContext, METHOD_UNMEASURED, "角色未登记 DOM 选择器（canvasOp 或纯状态描述）", {
      canvasOp: role.canvasOp ?? null,
    });
  }

  // 3. 图形角色且前景为 null（色块）：自身填充 vs 真实背景
  if (role.kind === "graphic" && (role.foreground === null || role.foreground === undefined)) {
    return measurePaintedSurfaceRole(role, runtime, recordContext, selector);
  }

  // 4. 其余（含 HTML 图形角色带显式前景）：卡面未定义通用 HTML 图形机制 → unmeasured + 手工方法
  if (role.kind === "graphic") {
    const capture = await captureOriginal(role, runtime, selector);
    return unmeasuredRecord(
      role,
      recordContext,
      METHOD_UNMEASURED,
      "HTML 图形角色（显式前景表达式）无卡面定义的通用测量机制：保留 unmeasured 并以原尺寸截图人工核验",
      {
        selector,
        capture: capture.index,
        captureNote: capture.note,
        manualMethod: "对焦点圈/边框等逐状态截图，取前景色与其后方实际背景像素逐点合成计算",
      },
    );
  }

  return measureTextRole(role, runtime, recordContext, selector);
}

async function measureFocusOutlineRole(role, runtime, recordContext, selector) {
  const method = "browser-focus-outline-adjacent-pixels";
  const expected = { "keyboard-focus": "#addImportButton", "input-focus": "#pricingSearch" }[recordContext.stateId];
  if (
    role.kind !== "graphic" ||
    role.required !== true ||
    thresholdOf(role) !== 3 ||
    !expected ||
    selector !== expected
  ) {
    return unmeasuredRecord(
      role,
      recordContext,
      method,
      "焦点角色契约不是必要 graphic/3 或状态目标不匹配，拒绝猜测目标",
      { selector },
    );
  }
  const { page, diagnostics, captures } = runtime;
  const evidence = {
    kind: method,
    selector,
    scroll: {},
    captures: { focused: null },
  };
  const begin = await page.evaluate(buildBeginScrollSessionSource());
  evidence.scroll.begin = begin;
  if (!begin?.ok || begin.alreadyActive) {
    return unmeasuredRecord(
      role,
      recordContext,
      method,
      begin?.alreadyActive ? "已有其它滚动会话，焦点路径拒绝占用或清理" : "焦点滚动会话未能开始",
      evidence,
    );
  }
  const scrollDifferencesBefore = diagnostics.restoration.scrollDifferences.length;
  let measured = null;
  let operationError = null;
  let restorationError = null;
  let operationFailed = false;
  let restorationFailed = false;
  let blocked = null;
  try {
    evidence.scroll.bring = await page.evaluate(buildBringIntoViewSource(selector, 0));
    if (!evidence.scroll.bring?.ok) blocked = `焦点目标无法带入视口：${evidence.scroll.bring?.reason ?? "unknown"}`;
    else measured = await measureFocusOutlineAdjacentPixels({ page, selector });
  } catch (error) {
    operationError = error;
    operationFailed = true;
  } finally {
    try {
      const caughtError = await restoreScrollSession(page, diagnostics, role.id, "焦点轮廓路径");
      const differences = diagnostics.restoration.scrollDifferences.slice(scrollDifferencesBefore);
      evidence.scroll.restorationDifferences = differences;
      if (differences.length) {
        restorationFailed = true;
        restorationError = caughtError ?? new Error(differences.join("；"));
      }
    } catch (error) {
      restorationError = error;
      restorationFailed = true;
    }
  }
  const paired = measured ?? operationError?.focusOutlineEvidence;
  if (paired) {
    const pairedDiagnostics = paired.diagnostics ?? {};
    evidence.analysis = paired.analysis ?? null;
    evidence.probes = pairedDiagnostics.probes ?? {};
    evidence.decoded = pairedDiagnostics.decoded ?? null;
    evidence.mutated = pairedDiagnostics.mutated ?? null;
    evidence.clip = paired.captures.clip;
    evidence.scroll.sampling = pairedDiagnostics.probes?.before?.scroll ?? evidence.scroll.bring?.scroll;
    const png = paired.captures?.focused;
    if (png) {
      evidence.captures.focused = captures.length;
      captures.push({
        roleId: role.id,
        kind: "focus-outline-adjacent-focused",
        clip: { ...paired.captures.clip },
        dpr: pairedDiagnostics.probes?.before?.viewport?.dpr ?? diagnostics.dpr,
        scroll: { ...evidence.scroll.sampling },
        pngBase64: png.toString("base64"),
      });
    }
  }
  if (operationFailed || restorationFailed) {
    const error =
      operationFailed && restorationFailed
        ? new AggregateError([operationError, restorationError], "焦点测量与滚动恢复均失败")
        : operationFailed
          ? operationError
          : restorationError;
    try {
      if (error !== null && (typeof error === "object" || typeof error === "function") && Object.isExtensible(error)) {
        error.focusOutlineEvidence ??= paired ?? {
          diagnostics: {},
          captures: { clip: null, focused: null },
        };
        error.focusOutlineEvidence.measurement = { roleId: role.id, evidence, captures, diagnostics };
      }
    } catch {
      // 附件不可写不能覆盖原操作或恢复错误。
    }
    throw error;
  }
  if (blocked) return unmeasuredRecord(role, recordContext, method, blocked, evidence);
  return buildRecord({
    ...recordContext,
    roleId: role.id,
    threshold: 3,
    method,
    result: measured.analysis.result,
    ratio: measured.analysis.result === "unmeasured" ? null : measured.analysis.ratio,
    reason: measured.analysis.reason,
    evidence: evidenceOf(evidence),
  });
}

function detailFillHandleMatches(element, { global, token, index }) {
  const state = window[global];
  const attempt = state?.attempts?.get(token);
  const expected = attempt?.elements?.[index] ?? null;
  return {
    valid: expected === element && element?.isConnected === true,
    reason:
      expected !== element
        ? `第 ${index} 个 fill 已换成新节点`
        : element?.isConnected !== true
          ? `第 ${index} 个 fill 已脱离文档`
          : "",
  };
}

function detailFillContractFailure(role, recordContext, selector) {
  if (
    role.kind !== "graphic" ||
    role.required !== true ||
    thresholdOf(role) !== 3 ||
    !Array.isArray(role.states) ||
    !role.states.includes(recordContext.stateId)
  ) {
    return "详情填充角色契约不是必要 graphic/3 或当前状态未登记";
  }
  if (selector !== "#detailPanel #detailList > .bar-row > .bar-track > .bar-fill") {
    return "详情填充角色 selector 与固定直接行链契约不一致";
  }
  return null;
}

function detailFillCaptureSummary(capture) {
  if (!capture || typeof capture !== "object") return null;
  const summary = { ...capture };
  delete summary.frames;
  return summary;
}

function appendDetailFillFrames(role, runtime, rowIndex, capture, rowEvidence) {
  const indexes = { normal: null, background: null, verify: null };
  const clip = capture?.clip && typeof capture.clip === "object" ? { ...capture.clip } : null;
  const scrollSource = capture?.geometry?.scroll?.window ?? runtime.diagnostics.scroll ?? {};
  const scroll = {
    x: Number.isFinite(scrollSource.x) ? scrollSource.x : null,
    y: Number.isFinite(scrollSource.y) ? scrollSource.y : null,
  };
  for (const frame of ["normal", "background", "verify"]) {
    const png = capture?.frames?.[frame];
    if (!Buffer.isBuffer(png) || png.length === 0) continue;
    indexes[frame] = runtime.captures.length;
    runtime.captures.push({
      roleId: role.id,
      kind: `detail-fill-row-${rowIndex}-${frame}`,
      clip,
      dpr: capture?.geometry?.viewport?.dpr ?? runtime.diagnostics.dpr,
      scroll,
      pngBase64: png.toString("base64"),
    });
  }
  rowEvidence.captures = indexes;
}

async function detailFillDomCheck(page, selector, baselineNodes) {
  const current = await probeNodes(page, selector, null);
  if (current.error) return { valid: false, reason: current.error };
  if (current.nodes.length !== baselineNodes.length) {
    return {
      valid: false,
      reason: `fill 匹配集合数量变化（${baselineNodes.length} → ${current.nodes.length}）`,
    };
  }
  for (let index = 0; index < baselineNodes.length; index += 1) {
    if (current.nodes[index]?.identityId !== baselineNodes[index]?.identityId) {
      return { valid: false, reason: `第 ${index} 个 fill 已替换或重排` };
    }
  }
  return { valid: true, reason: "" };
}

function detailFillCaptureGap(capture) {
  if (capture?.status !== "captured-unvalidated") {
    return `C9 未完成三帧捕获：${capture?.status ?? "missing"}${capture?.reason ? `（${capture.reason}）` : ""}`;
  }
  for (const frame of ["normal", "background", "verify"]) {
    const png = capture.frames?.[frame];
    if (!Buffer.isBuffer(png) || png.length === 0) return `C9 缺少有效 ${frame} 帧`;
  }
  if (capture.restoration?.attempted !== true || capture.restoration?.verified !== true) {
    return "C9 paint 恢复未完成或未核验";
  }
  if (capture.hitTest?.status !== "observed") {
    return `C9 命中测试不完整：${capture.hitTest?.status ?? "missing"}`;
  }
  if (
    !capture.clip ||
    !["x", "y", "width"].every((key) => Number.isSafeInteger(capture.clip[key])) ||
    capture.clip.height !== 1
  ) {
    return "C9 未返回有效中心条 clip";
  }
  return null;
}

function detailFillAnalysisGap(analysis, clip) {
  if (analysis?.status !== "measured") {
    return `B41 未测：${analysis?.reason || "missing"}`;
  }
  if (!Number.isFinite(analysis.worstRatio)) return "B41 未返回有限最差比值";
  if (analysis.restoration?.identical !== true) return "B41 normal/verify 恢复像素不一致";
  for (const frame of ["normal", "background", "verify"]) {
    const dimensions = analysis.dimensions?.[frame];
    if (dimensions?.width !== clip.width || dimensions?.height !== clip.height) {
      return `B41 ${frame} 帧尺寸与中心条 clip 不一致`;
    }
  }
  return null;
}

function finalizeDetailFillEvidence(evidence, baselineNodes) {
  const fallbackReason = evidence.hardError?.reason || evidence.coverageFailures.at(-1) || "未执行 C9";
  for (let index = evidence.rows.length; index < baselineNodes.length; index += 1) {
    evidence.rows.push({
      index,
      identity: nodeIdentity(baselineNodes[index]),
      rowIndex: null,
      structure: null,
      status: "not-attempted",
      reason: fallbackReason,
      clip: null,
      captures: { normal: null, background: null, verify: null },
      capture: null,
      analysis: null,
      worstRatio: null,
    });
  }
  const measured = evidence.rows.filter((row) => row.status === "measured");
  evidence.measuredCount = measured.length;
  evidence.unmeasuredCount = evidence.rows.length - measured.length;
  const worst =
    measured.length > 0 ? measured.reduce((left, right) => (right.worstRatio < left.worstRatio ? right : left)) : null;
  evidence.worst = worst
    ? {
        index: worst.index,
        rowIndex: worst.rowIndex,
        ratio: worst.worstRatio,
        clip: worst.clip,
        worst: worst.analysis?.worst ?? null,
      }
    : null;
  evidence.complete =
    evidence.hardError === null &&
    evidence.measuredCount === baselineNodes.length &&
    evidence.coverageFailures.length === 0;
}

async function disposeDetailFillHandles(handles) {
  const errors = [];
  for (const [index, handle] of handles.entries()) {
    try {
      if (!handle || typeof handle.dispose !== "function") {
        throw new TypeError(`第 ${index} 个 fill ElementHandle 缺少 dispose`);
      }
      await handle.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function canAttachMeasurementEvidence(value) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") return false;
  try {
    if (!Object.isExtensible(value)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, "measurementEvidence");
    return descriptor === undefined || descriptor.configurable === true;
  } catch {
    return false;
  }
}

function detailFillPrimaryFailure(error, evidence) {
  if (canAttachMeasurementEvidence(error)) return error;
  const failure = new Error("详情填充测量失败（原始错误保留在 cause）", { cause: error });
  failure.detailFillEvidence = evidence;
  return failure;
}

async function measureDetailFillRole(role, runtime, recordContext, selector) {
  const contractFailure = detailFillContractFailure(role, recordContext, selector);
  if (contractFailure) {
    return unmeasuredRecord(role, recordContext, METHOD_DETAIL_FILL, contractFailure, { selector });
  }

  const { page } = runtime;
  const probe = await probeNodes(page, selector, null, { trackIdentities: true });
  if (probe.error) {
    return unmeasuredRecord(role, recordContext, METHOD_DETAIL_FILL, probe.error, { selector });
  }
  if (probe.nodes.length === 0) {
    return unmeasuredRecord(role, recordContext, METHOD_DETAIL_FILL, `状态内未找到选择器匹配：${selector}`, {
      selector,
    });
  }
  if (typeof probe.attemptToken !== "string" || probe.attemptToken === "") {
    return unmeasuredRecord(role, recordContext, METHOD_DETAIL_FILL, "详情填充角色尝试身份基准缺失", {
      selector,
    });
  }

  const baselineNodes = probe.nodes;
  const evidence = {
    kind: METHOD_DETAIL_FILL,
    selector,
    rowCount: baselineNodes.length,
    rows: [],
    coverageFailures: [],
    hardError: null,
    measuredCount: 0,
    unmeasuredCount: 0,
    worst: null,
    complete: false,
  };
  runtime.diagnostics.detailFill = evidence;
  const handles = [];
  const cleanupErrors = [];
  let outcome = null;
  let hasPrimaryError = false;
  let primaryError;
  let ownsScrollSession = false;
  const scrollRows =
    recordContext.stateId !== SPOTLIGHT_DETAIL_FILL_STATE_ID && typeof runtime.detailFillRestingPointer === "function";

  try {
    if (typeof page.$$ !== "function") {
      evidence.coverageFailures.push("Playwright page 缺少 fill ElementHandle 查询");
    } else {
      handles.push(...(await page.$$(selector)));
      if (handles.length !== baselineNodes.length) {
        evidence.coverageFailures.push(`fill ElementHandle 数量变化（${baselineNodes.length} → ${handles.length}）`);
      } else {
        for (let index = 0; index < handles.length; index += 1) {
          const matched = await handles[index].evaluate(detailFillHandleMatches, {
            global: MEASUREMENT_STASH_GLOBAL,
            token: probe.attemptToken,
            index,
          });
          if (matched?.valid !== true) {
            evidence.coverageFailures.push(matched?.reason || `第 ${index} 个 fill ElementHandle 身份未确认`);
            break;
          }
        }
      }

      if (evidence.coverageFailures.length === 0) {
        if (scrollRows) {
          const begin = await page.evaluate(buildBeginScrollSessionSource());
          if (begin?.ok !== true) {
            throw new Error(`详情填充逐行滚动准备失败：${begin?.reason ?? "missing"}`);
          }
          if (begin.alreadyActive === true) {
            throw new Error("详情填充逐行滚动拒绝接管已有滚动会话");
          }
          ownsScrollSession = true;
        }

        for (let index = 0; index < baselineNodes.length; index += 1) {
          if (ownsScrollSession) {
            const brought = await page.evaluate(buildBringIntoViewSource(selector, index));
            if (brought?.ok !== true) {
              evidence.coverageFailures.push(`第 ${index} 行：滚动准备失败（${brought?.reason ?? "missing"}）`);
              break;
            }
          }

          const before = await detailFillDomCheck(page, selector, baselineNodes);
          if (!before.valid) {
            evidence.coverageFailures.push(before.reason);
            break;
          }

          const row = {
            index,
            identity: nodeIdentity(baselineNodes[index]),
            rowIndex: null,
            structure: null,
            status: "unmeasured",
            reason: "",
            clip: null,
            captures: { normal: null, background: null, verify: null },
            capture: null,
            analysis: null,
            worstRatio: null,
          };
          evidence.rows.push(row);

          if (ownsScrollSession) {
            try {
              await runtime.detailFillRestingPointer();
            } catch (error) {
              row.status = "hard-error";
              row.reason = error instanceof Error ? error.message : `thrown:${String(error)}`;
              throw error;
            }
          }

          let capture;
          try {
            capture = await captureDetailBarThreeFrames({ page, fill: handles[index] });
          } catch (error) {
            const partial = error?.detailBarCaptureEvidence ?? null;
            row.reason = error instanceof Error ? error.message : String(error);
            appendDetailFillFrames(role, runtime, index, partial, row);
            row.capture = detailFillCaptureSummary(partial);
            row.status = "hard-error";
            evidence.hardError = { index, reason: row.reason };
            evidence.coverageFailures.push(`第 ${index} 行：C9 硬错（${row.reason}）`);
            hasPrimaryError = true;
            primaryError = error;
            break;
          }

          row.rowIndex = capture?.geometry?.rowIndex ?? null;
          row.structure = capture?.geometry?.structure ?? null;
          row.clip = capture?.clip ? { ...capture.clip } : null;
          appendDetailFillFrames(role, runtime, index, capture, row);
          row.capture = detailFillCaptureSummary(capture);

          if (capture.restoration?.attempted === true && capture.restoration?.verified !== true) {
            const restorationError = new Error(
              `detail-fill-restore-unverified:${capture.reason || capture.restoration?.result?.status || "missing"}`,
            );
            restorationError.detailBarCaptureEvidence = capture;
            row.status = "hard-error";
            evidence.hardError = { index, reason: restorationError.message };
            evidence.coverageFailures.push(`第 ${index} 行：${restorationError.message}`);
            hasPrimaryError = true;
            primaryError = restorationError;
            break;
          }

          const after = await detailFillDomCheck(page, selector, baselineNodes);
          if (!after.valid) {
            row.reason = after.reason;
            evidence.coverageFailures.push(after.reason);
            break;
          }

          const captureGap = detailFillCaptureGap(capture);
          if (captureGap) {
            row.reason = captureGap;
            evidence.coverageFailures.push(`第 ${index} 行：${captureGap}`);
            continue;
          }

          let analysis;
          try {
            analysis = await analyzeDetailBarFrames({
              page,
              clip: capture.clip,
              frames: capture.frames,
            });
          } catch (error) {
            row.reason = error instanceof Error ? error.message : String(error);
            row.status = "hard-error";
            evidence.hardError = { index, reason: row.reason };
            evidence.coverageFailures.push(`第 ${index} 行：B41 硬错（${row.reason}）`);
            hasPrimaryError = true;
            primaryError = error;
            break;
          }
          row.analysis = analysis;

          const analysisGap = detailFillAnalysisGap(analysis, capture.clip);
          if (analysisGap) {
            row.reason = analysisGap;
            evidence.coverageFailures.push(`第 ${index} 行：${analysisGap}`);
            continue;
          }

          const afterAnalysis = await detailFillDomCheck(page, selector, baselineNodes);
          if (!afterAnalysis.valid) {
            row.reason = afterAnalysis.reason;
            evidence.coverageFailures.push(afterAnalysis.reason);
            break;
          }
          row.status = "measured";
          row.reason = "";
          row.worstRatio = analysis.worstRatio;
        }

        if (!hasPrimaryError) {
          const finalIdentity = await detailFillDomCheck(page, selector, baselineNodes);
          if (!finalIdentity.valid) evidence.coverageFailures.push(finalIdentity.reason);
        }
      }
    }
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
    if (evidence.hardError === null) {
      evidence.hardError = {
        index: evidence.rows.length > 0 ? evidence.rows.length - 1 : null,
        reason: error instanceof Error ? error.message : `thrown:${String(error)}`,
      };
    }
  } finally {
    if (ownsScrollSession) {
      try {
        const differencesBefore = runtime.diagnostics.restoration.scrollDifferences.length;
        const scrollError = await restoreScrollSession(page, runtime.diagnostics, role.id, "详情填充路径");
        if (scrollError) cleanupErrors.push(scrollError);
        else if (runtime.diagnostics.restoration.scrollDifferences.length > differencesBefore) {
          cleanupErrors.push(new Error("详情填充滚动恢复未完成"));
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await runtime.detailFillRestingPointer();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  try {
    finalizeDetailFillEvidence(evidence, baselineNodes);
    if (!hasPrimaryError) {
      if (evidence.complete) {
        const result = evidence.worst.ratio < thresholdOf(role) ? "fail" : "pass";
        outcome = buildRecord({
          ...recordContext,
          roleId: role.id,
          threshold: thresholdOf(role),
          method: METHOD_DETAIL_FILL,
          result,
          ratio: evidence.worst.ratio,
          evidence: evidenceOf(evidence),
          reason: result === "fail" ? `最差行 ${evidence.worst.ratio.toFixed(4)} < 阈值 ${thresholdOf(role)}` : "",
        });
      } else {
        const reasons = [...new Set(evidence.coverageFailures.filter(Boolean))];
        if (reasons.length === 0) reasons.push("没有完整测得的详情填充行");
        outcome = unmeasuredRecord(role, recordContext, METHOD_DETAIL_FILL, reasons.join("；"), evidence);
      }
    }
  } catch (error) {
    if (hasPrimaryError) {
      cleanupErrors.push(error);
    } else {
      hasPrimaryError = true;
      primaryError = error;
    }
  } finally {
    cleanupErrors.push(...(await disposeDetailFillHandles(handles)));
  }
  if (hasPrimaryError) {
    const failure = detailFillPrimaryFailure(primaryError, evidence);
    if (cleanupErrors.length > 0) {
      throw new AggregateError([failure, ...cleanupErrors], "详情填充测量失败且清理失败", {
        cause: primaryError,
      });
    }
    throw failure;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "详情填充清理失败");
  }

  return outcome;
}

/**
 * 取一张原图（unmeasured 项的原尺寸证据）。选择器带伪元素后缀时按基选择器
 * 定位宿主（`::after` 交给 querySelectorAll 会抛 SyntaxError）；截图本身失败
 * 只记原因，不让诊断步骤掀翻整轮测量。
 */
async function captureOriginal(role, runtime, selector) {
  if (!selector) return { index: null, note: "角色未登记 DOM 选择器" };
  const { selector: base } = splitSelectorPseudo(selector);
  const probe = await probeNodes(runtime.page, base, null);
  if (probe.error) return { index: null, note: probe.error };
  if (probe.nodes.length === 0) return { index: null, note: `状态内未找到选择器匹配：${base}` };
  const first = probe.nodes[0];
  if (first.rect.width <= 0 || first.rect.height <= 0) return { index: null, note: "目标矩形尺寸为 0" };
  try {
    const shot = await runtime.shoot(first.rect, "original", role.id);
    return { index: shot.index, note: null };
  } catch (error) {
    return { index: null, note: `原图截取失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

async function probeNodes(page, selector, pseudo, options = {}) {
  const probe = await page.evaluate(
    buildNodeProbeSource(
      selector,
      pseudo,
      options.hiddenToken ?? null,
      options.trackIdentities === true,
      options.includeText === true,
      options.includeOwnOpacityTextProof === true,
      options.includeOwnTextRanges === true,
      options.includeCostNoteLinkDecorationProof === true,
    ),
  );
  if (probe?.error) return { error: probe.error, nodes: [] };
  return {
    nodes: Array.isArray(probe?.nodes) ? probe.nodes : [],
    measurementIdentity: probe?.measurementIdentity ?? null,
    attemptToken: probe?.attemptToken ?? null,
  };
}

async function parseColor(page, value) {
  return page.evaluate(buildColorParseSource(value));
}

/** 页内扫描区域（页坐标）→ 像素网格；返回带页坐标原点的最差样本。 */
function scanWorst(scan, foreground, clip, regions) {
  let worst = null;
  const regionById = new Map(regions.map((region) => [region.id, region]));
  for (const scanned of scan.regions) {
    if (scanned.pixels.length === 0 || scanned.columns === 0) continue;
    const region = regionById.get(scanned.id);
    if (!region) continue;
    const origin = {
      x: clip.x + scanned.origin.x / scan.scale.x,
      y: clip.y + scanned.origin.y / scan.scale.y,
      columns: scanned.columns,
      pixelStepX: 1 / scan.scale.x,
      pixelStepY: 1 / scan.scale.y,
    };
    const sample = worstBackgroundSample(foreground, scanned.pixels, origin);
    if (!worst || sample.ratio < worst.ratio) worst = sample;
  }
  return worst;
}

/**
 * 角色选择器可能带伪元素后缀（M0 目录如 `input::placeholder`）：
 * querySelectorAll 不接受伪元素，拆成基础选择器 + 伪元素；元素级样式操作
 * （隐藏/恢复/核验）一律用基础选择器，伪元素样式从 probe 的 computed 读。
 */
function splitSelectorPseudo(selector) {
  const match = /^(.*)::([a-zA-Z][a-zA-Z0-9-]*)$/.exec(selector);
  if (!match || match[1].trim() === "") return { selector, pseudo: null };
  return { selector: match[1], pseudo: `::${match[2]}` };
}

/** 矩形是否完整落在视口内（1px 容差）：越界带不截，避免 sticky/裁切伪影。 */
function isInsideViewport(rect, viewport) {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.y >= -1 &&
    rect.y + rect.height <= viewport.height + 1 &&
    rect.x >= -1 &&
    rect.x + rect.width <= viewport.width + 1
  );
}

/**
 * 本次角色尝试的 DOM 身份失效：对象集合在测量中途被换掉，手上的像素属于哪个
 * DOM 版本无法判定。整个尝试作废（旧 measurements/evidence 一起丢弃），由
 * withOneIdentityRetry 从新的完整角色快照重来。
 */
class MeasurementSampleInvalid extends Error {
  constructor(message, node = null, diagnostic = {}) {
    super(message);
    this.name = "MeasurementSampleInvalid";
    this.nodeDiagnostic = node
      ? {
          index: node.index,
          identity: nodeIdentity(node),
          ...(node.dynamicTextSnapshot ? { dynamicTextSnapshot: node.dynamicTextSnapshot } : {}),
          ...diagnostic,
        }
      : null;
  }
}

/** 原attempt保留容器引用，scroll stash清理后仍能核对同一批容器。 */
function buildHoverGuardSource(attemptToken) {
  return `// skinProbe: hover-guard
(() => {
${IDENTITY_SOURCE}
  const state = __stash();
  const token = ${JSON.stringify(attemptToken)};
  const checked = __attemptIdentity(state, token);
  const attempt = state.attempts.get(token);
  const target = attempt?.elements[0];
  if (!attempt || attempt.elements.length !== 1 || !target) {
    return { identityValid: false, reason: "悬停目标必须为单一原节点" };
  }
  if (!attempt.hoverContainers) {
    const stash = window[${JSON.stringify(SCROLL_STASH_GLOBAL)}];
    if (!stash) return { identityValid: false, reason: "缺少滚动会话" };
    attempt.hoverContainers = stash.containers.map(entry => entry.node);
  }
  const rect = target.getBoundingClientRect();
  return {
    identityValid: checked.valid,
    reason: checked.reason,
    identityId: __idFor(state, target),
    hovered: target.matches(":hover"),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    scroll: { x: window.scrollX, y: window.scrollY },
    containers: attempt.hoverContainers.map(node => ({
      identityId: __idFor(state, node), connected: node.isConnected,
      top: node.scrollTop, left: node.scrollLeft,
    })),
  };
})()`;
}

function buildSpotlightMetricGuardSource(attemptToken) {
  return `// skinProbe: spotlight-metric-guard
(() => {
${IDENTITY_SOURCE}
  const state = __stash();
  const token = ${JSON.stringify(attemptToken)};
  const checked = __attemptIdentity(state, token);
  const attempt = state.attempts.get(token);
  const target = attempt?.elements[0];
  if (!attempt || attempt.elements.length !== 1 || !target) {
    return { identityValid: false, reason: "聚光metric目标必须为单一原文本节点" };
  }
  const totalTokens = Array.from(document.querySelectorAll("#totalTokens"));
  const metricHosts =
    totalTokens.length === 1
      ? Array.from(document.querySelectorAll(".metric")).filter((host) =>
          Array.from(host.children).some((child) => child === totalTokens[0]),
        )
      : [];
  const host = metricHosts.length === 1 ? metricHosts[0] : null;
  const labels = host
    ? Array.from(host.children).filter((child) =>
        child.tagName.toLowerCase() === "span" && !child.classList.contains("metric-new"),
      )
    : [];
  const leafIsMetricLabel =
    metricHosts.length === 1 && labels.length === 1 && labels[0] === target && target.parentElement === host;
  const leafIsMetricValue =
    metricHosts.length === 1 &&
    totalTokens.length === 1 &&
    totalTokens[0] === target &&
    target.parentElement === host &&
    target.tagName.toLowerCase() === "strong" &&
    target.childElementCount === 0 &&
    Array.from(target.childNodes).every((child) => child.nodeType === 3) &&
    String(target.textContent ?? "").trim() !== "";
  const metricTargetKind = leafIsMetricLabel ? "label" : leafIsMetricValue ? "value" : null;
  const targetRangeRects = leafIsMetricValue
    ? (() => {
        const range = document.createRange();
        range.selectNodeContents(target);
        return Array.from(range.getClientRects()).map((rect) => ({
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }));
      })()
    : null;
  if (host && !attempt.spotlightMetricHost) attempt.spotlightMetricHost = host;
  const originalHost = attempt.spotlightMetricHost || null;
  if (!attempt.spotlightMetricContainers) {
    const stash = window[${JSON.stringify(SCROLL_STASH_GLOBAL)}];
    if (!stash) return { identityValid: false, reason: "聚光metric缺少滚动会话" };
    attempt.spotlightMetricContainers = stash.containers.map((entry) => entry.node);
  }
  const activeHosts = Array.from(document.querySelectorAll(".shell [data-spotlight-active]"));
  const targetStyle = getComputedStyle(target);
  const hostStyle = originalHost ? getComputedStyle(originalHost) : null;
  const pseudo = originalHost ? getComputedStyle(originalHost, "::after") : null;
  const maskImage =
    pseudo?.maskImage && pseudo.maskImage !== "none" ? pseudo.maskImage : pseudo?.webkitMaskImage || "none";
  const targetRect = target.getBoundingClientRect();
  const hostRect = originalHost?.getBoundingClientRect();
  return {
    identityValid: checked.valid,
    reason: checked.reason,
    targetIdentityId: __idFor(state, target),
    targetConnected: target.isConnected,
    targetText: String(target.textContent ?? ""),
    targetColor: targetStyle.color,
    targetTextFillColor: targetStyle.webkitTextFillColor,
    targetTextShadow: targetStyle.textShadow,
    metricTargetKind,
    leafIsMetricLabel,
    leafIsMetricValue,
    ...(leafIsMetricValue
      ? {
          targetClientWidth: target.clientWidth,
          targetScrollWidth: target.scrollWidth,
          targetRangeRects,
        }
      : {}),
    metricHostCount: metricHosts.length,
    metricLabelCount: labels.length,
    hostIdentityId: originalHost ? __idFor(state, originalHost) : null,
    currentHostIdentityId: host ? __idFor(state, host) : null,
    hostSame: host === originalHost,
    hostConnected: originalHost?.isConnected === true,
    activeHostCount: activeHosts.length,
    activeHostSame: activeHosts.length === 1 && activeHosts[0] === host,
    hovered: Boolean(host && host.matches(":hover")),
    targetRect: { x: targetRect.x, y: targetRect.y, width: targetRect.width, height: targetRect.height },
    hostRect: hostRect
      ? { x: hostRect.x, y: hostRect.y, width: hostRect.width, height: hostRect.height }
      : null,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 },
    scroll: { x: scrollX, y: scrollY },
    containers: attempt.spotlightMetricContainers.map((node) => ({
      identityId: __idFor(state, node),
      connected: node.isConnected,
      top: node.scrollTop,
      left: node.scrollLeft,
    })),
    spotlight: {
      x: originalHost?.style.getPropertyValue("--spotlight-x") || "",
      y: originalHost?.style.getPropertyValue("--spotlight-y") || "",
      radius: originalHost?.style.getPropertyValue("--spotlight-radius") || "",
      mask: originalHost?.style.getPropertyValue("--spotlight-mask") || "",
      pseudo: pseudo
        ? {
            content: pseudo.content,
            opacity: pseudo.opacity,
            maskImage,
            backgroundImage: pseudo.backgroundImage,
            position: pseudo.position,
            inset: pseudo.inset,
            zIndex: pseudo.zIndex,
            borderRadius: pseudo.borderRadius,
            pointerEvents: pseudo.pointerEvents,
            mixBlendMode: pseudo.mixBlendMode,
            filter: pseudo.filter,
            maskSize: pseudo.maskSize,
            maskRepeat: pseudo.maskRepeat,
            transitionProperty: pseudo.transitionProperty,
            transitionDuration: pseudo.transitionDuration,
          }
        : null,
      hostStyle: hostStyle
        ? {
            display: hostStyle.display,
            visibility: hostStyle.visibility,
            isolation: hostStyle.isolation,
            position: hostStyle.position,
            opacity: hostStyle.opacity,
            backgroundColor: hostStyle.backgroundColor,
            backgroundImage: hostStyle.backgroundImage,
            boxShadow: hostStyle.boxShadow,
            borderRadius: hostStyle.borderRadius,
            transform: hostStyle.transform,
            mixBlendMode: hostStyle.mixBlendMode,
            filter: hostStyle.filter,
          }
        : null,
    },
  };
})()`;
}

function buildSpotlightLanguageGuardSource(attemptToken) {
  return `// skinProbe: spotlight-language-guard
(() => {
${IDENTITY_SOURCE}
  const state = __stash();
  const token = ${JSON.stringify(attemptToken)};
  const checked = __attemptIdentity(state, token);
  const attempt = state.attempts.get(token);
  const target = attempt?.elements[0];
  if (!attempt || attempt.elements.length !== 1 || !target) {
    return { identityValid: false, reason: "语言聚光目标必须为单一原文字节点" };
  }
  const languageHosts = Array.from(document.querySelectorAll("#languageToggle"));
  const host = languageHosts.length === 1 ? languageHosts[0] : null;
  const hasClass = (node, name) => String(node?.className ?? "").split(/\\s+/).includes(name);
  const languageLeaves = (language) =>
    host
      ? Array.from(host.children).filter(
          (node) => node?.getAttribute?.("data-language") === language,
        )
      : [];
  const zhNodes = languageLeaves("zh-CN");
  const enNodes = languageLeaves("en-US");
  const zh = zhNodes.length === 1 ? zhNodes[0] : null;
  const en = enNodes.length === 1 ? enNodes[0] : null;
  const plainTextLeaf = (node, parent) =>
    Boolean(
      node &&
        node.parentElement === parent &&
        node.childElementCount === 0 &&
        Array.from(node.childNodes ?? []).every((child) => child.nodeType === 3) &&
        String(node.textContent ?? "").trim() !== "",
    );
  const zhSelected = hasClass(zh, "is-selected");
  const enSelected = hasClass(en, "is-selected");
  if (host && !attempt.spotlightLanguageHost) attempt.spotlightLanguageHost = host;
  if (zh && !attempt.spotlightLanguageZh) attempt.spotlightLanguageZh = zh;
  if (en && !attempt.spotlightLanguageEn) attempt.spotlightLanguageEn = en;
  const originalHost = attempt.spotlightLanguageHost || null;
  const originalZh = attempt.spotlightLanguageZh || null;
  const originalEn = attempt.spotlightLanguageEn || null;
  if (!attempt.spotlightLanguageContainers) {
    const scrollStash = window[${JSON.stringify(SCROLL_STASH_GLOBAL)}];
    if (!scrollStash) return { identityValid: false, reason: "语言聚光缺少滚动会话" };
    attempt.spotlightLanguageContainers = scrollStash.containers.map((entry) => entry.node);
  }
  const rectOf = (node) => {
    const rect = node?.getBoundingClientRect?.();
    return rect
      ? {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        }
      : null;
  };
  const rangeRectsOf = (node) => {
    if (!node) return null;
    const range = document.createRange();
    range.selectNodeContents(node);
    return Array.from(range.getClientRects(), (rect) => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    }));
  };
  const declarationOf = (node, property) =>
    node
      ? {
          value: node.style.getPropertyValue(property),
          priority: node.style.getPropertyPriority(property),
        }
      : null;
  const textSnapshot = (node) => {
    if (!node) return null;
    const style = getComputedStyle(node);
    const rect = rectOf(node);
    return {
      identityId: __idFor(state, node),
      connected: node.isConnected === true,
      text: String(node.textContent ?? ""),
      selected: hasClass(node, "is-selected"),
      rect,
      rangeRects: rangeRectsOf(node),
      color: style.color,
      textFillColor: style.webkitTextFillColor,
      textShadow: style.textShadow,
      opacity: style.opacity,
      display: style.display,
      visibility: style.visibility,
      styleAttributePresent: node.hasAttribute("style"),
      textFillDeclaration: declarationOf(node, "-webkit-text-fill-color"),
      textShadowDeclaration: declarationOf(node, "text-shadow"),
    };
  };
  const activeHosts = Array.from(document.querySelectorAll(".shell [data-spotlight-active]"));
  const hostStyle = originalHost ? getComputedStyle(originalHost) : null;
  const pseudo = originalHost ? getComputedStyle(originalHost, "::after") : null;
  const maskImage =
    pseudo?.maskImage && pseudo.maskImage !== "none"
      ? pseudo.maskImage
      : pseudo?.webkitMaskImage || "none";
  const root = document.scrollingElement || document.documentElement;
  const rootRect = rectOf(root);
  return {
    identityValid: checked.valid,
    reason: checked.reason,
    targetIdentityId: __idFor(state, target),
    targetConnected: target.isConnected === true,
    targetSame: target === zh,
    languageHostCount: languageHosts.length,
    zhNodeCount: zhNodes.length,
    enNodeCount: enNodes.length,
    zhLeaf: plainTextLeaf(zh, host),
    enLeaf: plainTextLeaf(en, host),
    zhSelected,
    enSelected,
    hostIdentityId: originalHost ? __idFor(state, originalHost) : null,
    currentHostIdentityId: host ? __idFor(state, host) : null,
    hostSame: host === originalHost,
    hostConnected: originalHost?.isConnected === true,
    zhSame: zh === originalZh,
    enSame: en === originalEn,
    hostIsButton: String(host?.tagName ?? "").toLowerCase() === "button",
    hostHasSpotlightActive: host?.hasAttribute?.("data-spotlight-active") === true,
    hostHasSpotlightStatic: host?.hasAttribute?.("data-spotlight-static") === true,
    hostAriaPressed: host?.getAttribute?.("aria-pressed") ?? null,
    activeHostCount: activeHosts.length,
    activeHostSame: activeHosts.length === 1 && activeHosts[0] === host,
    hovered: Boolean(host?.matches?.(":hover")),
    targetRect: rectOf(target),
    hostRect: rectOf(originalHost),
    zh: textSnapshot(zh),
    en: textSnapshot(en),
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    scroll: { x: window.scrollX, y: window.scrollY },
    root: root
      ? {
          identityId: __idFor(state, root),
          connected: root.isConnected === true,
          scrollTop: root.scrollTop,
          scrollLeft: root.scrollLeft,
          clientWidth: root.clientWidth,
          clientHeight: root.clientHeight,
          rect: rootRect,
        }
      : null,
    containers: attempt.spotlightLanguageContainers.map((node) => ({
      identityId: __idFor(state, node),
      connected: node.isConnected === true,
      top: node.scrollTop,
      left: node.scrollLeft,
    })),
    spotlight: {
      x: originalHost?.style.getPropertyValue("--spotlight-x") || "",
      y: originalHost?.style.getPropertyValue("--spotlight-y") || "",
      radius: originalHost?.style.getPropertyValue("--spotlight-radius") || "",
      mask: originalHost?.style.getPropertyValue("--spotlight-mask") || "",
      pseudo: pseudo
        ? {
            content: pseudo.content,
            opacity: pseudo.opacity,
            maskImage,
            backgroundImage: pseudo.backgroundImage,
            position: pseudo.position,
            inset: pseudo.inset,
            zIndex: pseudo.zIndex,
            borderRadius: pseudo.borderRadius,
            pointerEvents: pseudo.pointerEvents,
            mixBlendMode: pseudo.mixBlendMode,
            filter: pseudo.filter,
            maskSize: pseudo.maskSize,
            maskRepeat: pseudo.maskRepeat,
            transitionProperty: pseudo.transitionProperty,
            transitionDuration: pseudo.transitionDuration,
          }
        : null,
      hostStyle: hostStyle
        ? {
            display: hostStyle.display,
            visibility: hostStyle.visibility,
            isolation: hostStyle.isolation,
            position: hostStyle.position,
            opacity: hostStyle.opacity,
            backgroundColor: hostStyle.backgroundColor,
            backgroundImage: hostStyle.backgroundImage,
            boxShadow: hostStyle.boxShadow,
            borderRadius: hostStyle.borderRadius,
            transform: hostStyle.transform,
            mixBlendMode: hostStyle.mixBlendMode,
            filter: hostStyle.filter,
          }
        : null,
    },
  };
})()`;
}

function buildSpotlightTimelineHeadingGuardSource(attemptToken, roleId, targetKind) {
  return `// skinProbe: spotlight-timeline-heading-guard
(() => {
${IDENTITY_SOURCE}
  const state = __stash();
  const token = ${JSON.stringify(attemptToken)};
  const roleId = ${JSON.stringify(roleId)};
  const targetKind = ${JSON.stringify(targetKind)};
  const checked = __attemptIdentity(state, token);
  const attempt = state.attempts.get(token);
  const target = attempt?.elements[0];
  if (!attempt || attempt.elements.length !== 1 || !target) {
    return { identityValid: false, reason: "时间分布标题目标必须为单一原文字节点", roleId, targetKind };
  }
  const hasClass = (node, name) => String(node?.className ?? "").split(/\\s+/).includes(name);
  const chartHosts = Array.from(document.querySelectorAll(".chart-panel"));
  const host = chartHosts.length === 1 ? chartHosts[0] : null;
  const headings = host ? Array.from(host.children).filter((node) => hasClass(node, "timeline-heading")) : [];
  const heading = headings.length === 1 ? headings[0] : null;
  const titles = heading ? Array.from(heading.children).filter((node) => hasClass(node, "timeline-title")) : [];
  const titleContainer = titles.length === 1 ? titles[0] : null;
  const titleNodes = Array.from(document.querySelectorAll("#timelinePanelTitle"));
  const rangeNodes = Array.from(document.querySelectorAll("#rangeLabel"));
  const title = titleNodes.length === 1 ? titleNodes[0] : null;
  const range = rangeNodes.length === 1 ? rangeNodes[0] : null;
  const plainTextLeaf = (node, tag, parent) => Boolean(
    node &&
      String(node.tagName ?? "").toLowerCase() === tag &&
      node.parentElement === parent &&
      node.childElementCount === 0 &&
      Array.from(node.childNodes).every((child) => child.nodeType === 3) &&
      String(node.textContent ?? "").trim() !== "",
  );
  const titleLeaf = plainTextLeaf(title, "h2", titleContainer);
  const rangeLeaf = plainTextLeaf(range, "span", titleContainer);
  if (host && !attempt.spotlightTimelineHost) attempt.spotlightTimelineHost = host;
  if (heading && !attempt.spotlightTimelineHeading) attempt.spotlightTimelineHeading = heading;
  if (titleContainer && !attempt.spotlightTimelineTitleContainer) attempt.spotlightTimelineTitleContainer = titleContainer;
  if (title && !attempt.spotlightTimelineTitle) attempt.spotlightTimelineTitle = title;
  if (range && !attempt.spotlightTimelineRange) attempt.spotlightTimelineRange = range;
  const originalHost = attempt.spotlightTimelineHost || null;
  const originalHeading = attempt.spotlightTimelineHeading || null;
  const originalTitleContainer = attempt.spotlightTimelineTitleContainer || null;
  const originalTitle = attempt.spotlightTimelineTitle || null;
  const originalRange = attempt.spotlightTimelineRange || null;
  if (!attempt.spotlightTimelineContainers) {
    const stash = window[${JSON.stringify(SCROLL_STASH_GLOBAL)}];
    if (!stash) return { identityValid: false, reason: "时间分布标题缺少滚动会话", roleId, targetKind };
    attempt.spotlightTimelineContainers = stash.containers.map((entry) => entry.node);
  }
  const snapshotText = (node) => {
    if (!node) return null;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    return {
      identityId: __idFor(state, node),
      connected: node.isConnected === true,
      text: String(node.textContent ?? ""),
      color: style.color,
      textFillColor: style.webkitTextFillColor,
      textShadow: style.textShadow,
      opacity: style.opacity,
      display: style.display,
      visibility: style.visibility,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      rangeRects: Array.from(range.getClientRects(), (box) => ({
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      })),
    };
  };
  const activeHosts = Array.from(document.querySelectorAll(".shell [data-spotlight-active]"));
  const hostStyle = originalHost ? getComputedStyle(originalHost) : null;
  const pseudo = originalHost ? getComputedStyle(originalHost, "::after") : null;
  const maskImage =
    pseudo?.maskImage && pseudo.maskImage !== "none" ? pseudo.maskImage : pseudo?.webkitMaskImage || "none";
  const hostRect = originalHost?.getBoundingClientRect();
  const selected = targetKind === "title" ? title : targetKind === "range" ? range : null;
  const selectedSame = targetKind === "title" ? selected === originalTitle : targetKind === "range" && selected === originalRange;
  const targetStyle = selected ? getComputedStyle(selected) : null;
  const targetRect = selected?.getBoundingClientRect();
  return {
    identityValid: checked.valid,
    reason: checked.reason,
    roleId,
    targetKind,
    targetIdentityId: __idFor(state, target),
    targetConnected: target.isConnected === true,
    targetSame: selectedSame && selected === target,
    chartHostCount: chartHosts.length,
    headingCount: headings.length,
    titleContainerCount: titles.length,
    titleNodeCount: titleNodes.length,
    rangeNodeCount: rangeNodes.length,
    titleLeaf,
    rangeLeaf,
    hostIdentityId: originalHost ? __idFor(state, originalHost) : null,
    currentHostIdentityId: host ? __idFor(state, host) : null,
    hostSame: host === originalHost,
    hostConnected: originalHost?.isConnected === true,
    headingSame: heading === originalHeading,
    titleContainerSame: titleContainer === originalTitleContainer,
    titleSame: title === originalTitle,
    rangeSame: range === originalRange,
    hostHasSpotlightActive: Boolean(host?.hasAttribute("data-spotlight-active")),
    activeHostCount: activeHosts.length,
    activeHostSame: activeHosts.length === 1 && activeHosts[0] === host,
    hovered: Boolean(host && host.matches(":hover")),
    title: snapshotText(title),
    range: snapshotText(range),
    targetColor: targetStyle?.color ?? null,
    targetTextFillColor: targetStyle?.webkitTextFillColor ?? null,
    targetTextShadow: targetStyle?.textShadow ?? null,
    targetRect: targetRect
      ? { x: targetRect.x, y: targetRect.y, width: targetRect.width, height: targetRect.height }
      : null,
    hostRect: hostRect
      ? { x: hostRect.x, y: hostRect.y, width: hostRect.width, height: hostRect.height }
      : null,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 },
    scroll: { x: scrollX, y: scrollY },
    containers: attempt.spotlightTimelineContainers.map((node) => ({
      identityId: __idFor(state, node),
      connected: node.isConnected,
      top: node.scrollTop,
      left: node.scrollLeft,
    })),
    spotlight: {
      x: originalHost?.style.getPropertyValue("--spotlight-x") || "",
      y: originalHost?.style.getPropertyValue("--spotlight-y") || "",
      radius: originalHost?.style.getPropertyValue("--spotlight-radius") || "",
      mask: originalHost?.style.getPropertyValue("--spotlight-mask") || "",
      pseudo: pseudo
        ? {
            content: pseudo.content,
            opacity: pseudo.opacity,
            maskImage,
            backgroundImage: pseudo.backgroundImage,
            position: pseudo.position,
            inset: pseudo.inset,
            zIndex: pseudo.zIndex,
            borderRadius: pseudo.borderRadius,
            pointerEvents: pseudo.pointerEvents,
            mixBlendMode: pseudo.mixBlendMode,
            filter: pseudo.filter,
            maskSize: pseudo.maskSize,
            maskRepeat: pseudo.maskRepeat,
            transitionProperty: pseudo.transitionProperty,
            transitionDuration: pseudo.transitionDuration,
          }
        : null,
      hostStyle: hostStyle
        ? {
            display: hostStyle.display,
            visibility: hostStyle.visibility,
            isolation: hostStyle.isolation,
            position: hostStyle.position,
            opacity: hostStyle.opacity,
            backgroundColor: hostStyle.backgroundColor,
            backgroundImage: hostStyle.backgroundImage,
            boxShadow: hostStyle.boxShadow,
            borderRadius: hostStyle.borderRadius,
            transform: hostStyle.transform,
            mixBlendMode: hostStyle.mixBlendMode,
            filter: hostStyle.filter,
          }
        : null,
    },
  };
})()`;
}

function spotlightTimelineHeadingGuardFailure(observed, baseline, firstNode, phase, roleId, targetKind) {
  if (observed?.identityValid !== true) return observed?.reason || "目标身份核验失败";
  if (observed.roleId !== roleId || observed.targetKind !== targetKind) return "时间分布标题角色或目标类型失配";
  if (
    observed.targetIdentityId !== firstNode?.identityId ||
    observed.targetConnected !== true ||
    observed.targetSame !== true
  ) {
    return "原时间分布标题文字节点已失效";
  }
  if (
    observed.chartHostCount !== 1 ||
    observed.headingCount !== 1 ||
    observed.titleContainerCount !== 1 ||
    observed.titleNodeCount !== 1 ||
    observed.rangeNodeCount !== 1 ||
    observed.titleLeaf !== true ||
    observed.rangeLeaf !== true ||
    observed.hostSame !== true ||
    observed.hostConnected !== true ||
    observed.headingSame !== true ||
    observed.titleContainerSame !== true ||
    observed.titleSame !== true ||
    observed.rangeSame !== true ||
    observed.hostHasSpotlightActive !== true
  ) {
    return "原chart宿主、标题层级或唯一文字叶节点已变化";
  }
  if (observed.activeHostCount !== 1 || observed.activeHostSame !== true || observed.hovered !== true) {
    return "唯一聚光宿主或自然:hover状态已失效";
  }
  const selected = targetKind === "title" ? observed.title : observed.range;
  const firstRects = firstNode?.rawTextRects;
  const sameRects = (left, right) =>
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length > 0 &&
    left.length === right.length &&
    left.every(
      (rect, index) =>
        rect &&
        right[index] &&
        ["x", "y", "width", "height"].every(
          (key) => Number.isFinite(rect[key]) && Number.isFinite(right[index][key]) && rect[key] === right[index][key],
        ),
    );
  const textRectsValid = (snapshot) =>
    typeof snapshot?.text === "string" &&
    snapshot.text.trim() !== "" &&
    Array.isArray(snapshot.rangeRects) &&
    snapshot.rangeRects.length > 0 &&
    snapshot.rangeRects.every(
      (rect) =>
        rect &&
        [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.x + rect.width <= observed.viewport.width &&
        rect.y + rect.height <= observed.viewport.height,
    );
  if (!textRectsValid(observed.title) || !textRectsValid(observed.range)) {
    return "标题或周期范围为空、缺少文字几何或未完整落入当前视口";
  }
  if (
    !sameRects(firstRects, firstNode?.textRects) ||
    !sameRects(firstRects, selected?.rangeRects) ||
    selected?.text !== firstNode?.text ||
    selected?.color !== firstNode?.computed?.color ||
    (!TEXT_HIDE_GUARD_PHASES.has(phase) &&
      (selected?.textFillColor !== firstNode?.computed?.textFillColor ||
        selected?.textShadow !== firstNode?.computed?.textShadow))
  ) {
    return "目标文字、前景样式或原始文字矩形与node-probe不一致";
  }
  const spotlight = observed.spotlight;
  const pseudo = spotlight?.pseudo;
  const hostStyle = spotlight?.hostStyle;
  if (
    !spotlight?.x ||
    !spotlight.y ||
    !spotlight.radius ||
    !spotlight.mask ||
    spotlight.mask === "none" ||
    !pseudo ||
    pseudo.content === "none" ||
    pseudo.content === "normal" ||
    pseudo.opacity !== "1" ||
    !pseudo.maskImage ||
    pseudo.maskImage === "none" ||
    pseudo.backgroundImage === "none" ||
    pseudo.position !== "absolute" ||
    pseudo.pointerEvents !== "none" ||
    hostStyle?.display === "none" ||
    hostStyle?.visibility === "hidden" ||
    hostStyle?.isolation !== "isolate"
  ) {
    return "聚光伪元素、mask或绘制状态无效";
  }
  if (observed.containers?.some((container) => container.connected !== true)) {
    return "时间分布标题滚动容器已断开";
  }
  if (baseline) {
    const stableObserved = structuredClone(observed);
    const stableBaseline = structuredClone(baseline);
    if (TEXT_HIDE_GUARD_PHASES.has(phase)) {
      delete stableObserved[targetKind].textFillColor;
      delete stableObserved[targetKind].textShadow;
      delete stableBaseline[targetKind].textFillColor;
      delete stableBaseline[targetKind].textShadow;
      delete stableObserved.targetTextFillColor;
      delete stableObserved.targetTextShadow;
      delete stableBaseline.targetTextFillColor;
      delete stableBaseline.targetTextShadow;
    }
    if (JSON.stringify(stableObserved) !== JSON.stringify(stableBaseline)) {
      return "原时间分布标题、视口、滚动或光斑状态发生漂移";
    }
  }
  return null;
}

function buildSpotlightDetailHeadingGuardSource(attemptToken, roleId, targetKind) {
  return `// skinProbe: spotlight-detail-heading-guard
(() => {
${IDENTITY_SOURCE}
  const state = __stash();
  const token = ${JSON.stringify(attemptToken)};
  const roleId = ${JSON.stringify(roleId)};
  const targetKind = ${JSON.stringify(targetKind)};
  const checked = __attemptIdentity(state, token);
  const attempt = state.attempts.get(token);
  const target = attempt?.elements[0];
  const expectedTargetKind =
    roleId === "${SPOTLIGHT_DETAIL_TITLE_ROLE_ID}"
      ? "title"
      : roleId === "${SPOTLIGHT_DETAIL_MODE_ROLE_ID}"
        ? "mode-label"
        : null;
  if (expectedTargetKind !== targetKind) {
    return { identityValid: false, reason: "详情标题角色或目标类型失配", roleId, targetKind };
  }
  if (!attempt || attempt.elements.length !== 1 || !target) {
    return { identityValid: false, reason: "详情标题目标必须为单一原文字节点", roleId, targetKind };
  }
  const hasClass = (node, name) => String(node?.className ?? "").split(/\\s+/).includes(name);
  const panelNodes = Array.from(document.querySelectorAll("#detailPanel"));
  const shellPanels = Array.from(document.querySelectorAll(".shell #detailPanel"));
  const host = panelNodes.length === 1 && shellPanels.length === 1 && panelNodes[0] === shellPanels[0]
    ? panelNodes[0]
    : null;
  const headings = host ? Array.from(host.children).filter((node) => hasClass(node, "panel-heading")) : [];
  const heading = headings.length === 1 ? headings[0] : null;
  const titleNodes = Array.from(document.querySelectorAll("#detailPanelTitle"));
  const modeNodes = Array.from(document.querySelectorAll("#detailModeLabel"));
  const listNodes = Array.from(document.querySelectorAll("#detailList"));
  const title = titleNodes.length === 1 ? titleNodes[0] : null;
  const modeLabel = modeNodes.length === 1 ? modeNodes[0] : null;
  const list = listNodes.length === 1 ? listNodes[0] : null;
  const plainTextLeaf = (node, tag, parent) => Boolean(
    node &&
      String(node.tagName ?? "").toLowerCase() === tag &&
      node.parentElement === parent &&
      node.childElementCount === 0 &&
      Array.from(node.childNodes).every((child) => child.nodeType === 3) &&
      String(node.textContent ?? "").trim() !== "",
  );
  const titleLeaf = plainTextLeaf(title, "h2", heading);
  const modeLeaf = plainTextLeaf(modeLabel, "span", heading);
  if (host && !attempt.spotlightDetailHost) attempt.spotlightDetailHost = host;
  if (heading && !attempt.spotlightDetailHeading) attempt.spotlightDetailHeading = heading;
  if (title && !attempt.spotlightDetailTitle) attempt.spotlightDetailTitle = title;
  if (modeLabel && !attempt.spotlightDetailModeLabel) attempt.spotlightDetailModeLabel = modeLabel;
  if (list && !attempt.spotlightDetailList) attempt.spotlightDetailList = list;
  if (list && !attempt.spotlightDetailScrollNodes) {
    attempt.spotlightDetailScrollNodes = [];
    for (let node = list; node?.nodeType === 1; node = node.parentElement) {
      attempt.spotlightDetailScrollNodes.push(node);
    }
  }
  const originalHost = attempt.spotlightDetailHost || null;
  const originalHeading = attempt.spotlightDetailHeading || null;
  const originalTitle = attempt.spotlightDetailTitle || null;
  const originalModeLabel = attempt.spotlightDetailModeLabel || null;
  const originalList = attempt.spotlightDetailList || null;
  const scrollNodes = attempt.spotlightDetailScrollNodes || [];
  const currentScrollNodes = [];
  for (let node = list; node?.nodeType === 1; node = node.parentElement) currentScrollNodes.push(node);
  const scrollChainSame =
    currentScrollNodes.length === scrollNodes.length &&
    currentScrollNodes.every((node, index) => node === scrollNodes[index]);
  const scrollStash = window[${JSON.stringify(SCROLL_STASH_GLOBAL)}];
  if (!attempt.spotlightDetailScrollSessionNodes) {
    if (!scrollStash) return { identityValid: false, reason: "详情标题缺少滚动会话", roleId, targetKind };
    attempt.spotlightDetailScrollSessionNodes = scrollStash.containers.map((entry) => entry.node);
  }
  const snapshotText = (node) => {
    if (!node) return null;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    return {
      identityId: __idFor(state, node),
      connected: node.isConnected === true,
      text: String(node.textContent ?? ""),
      color: style.color,
      textFillColor: style.webkitTextFillColor,
      textShadow: style.textShadow,
      opacity: style.opacity,
      display: style.display,
      visibility: style.visibility,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      rangeRects: Array.from(range.getClientRects(), (box) => ({
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      })),
    };
  };
  const activeHosts = Array.from(document.querySelectorAll(".shell [data-spotlight-active]"));
  const hostStyle = originalHost ? getComputedStyle(originalHost) : null;
  const pseudo = originalHost ? getComputedStyle(originalHost, "::after") : null;
  const maskImage =
    pseudo?.maskImage && pseudo.maskImage !== "none" ? pseudo.maskImage : pseudo?.webkitMaskImage || "none";
  const hostRect = originalHost?.getBoundingClientRect();
  const selected = targetKind === "title" ? title : targetKind === "mode-label" ? modeLabel : null;
  const targetStyle = selected ? getComputedStyle(selected) : null;
  const targetRect = selected?.getBoundingClientRect();
  const listStyle = originalList ? getComputedStyle(originalList) : null;
  return {
    identityValid: checked.valid,
    reason: checked.reason,
    roleId,
    targetKind,
    targetIdentityId: __idFor(state, target),
    targetConnected: target.isConnected === true,
    targetSame: selected === originalTitle && targetKind === "title"
      ? selected === target
      : selected === originalModeLabel && targetKind === "mode-label" && selected === target,
    panelCount: panelNodes.length,
    shellPanelCount: shellPanels.length,
    headingCount: headings.length,
    titleNodeCount: titleNodes.length,
    modeNodeCount: modeNodes.length,
    listNodeCount: listNodes.length,
    titleLeaf,
    modeLeaf,
    listIsDirectChild: list?.parentElement === host,
    hostIdentityId: originalHost ? __idFor(state, originalHost) : null,
    hostSame: host === originalHost,
    hostConnected: originalHost?.isConnected === true,
    headingSame: heading === originalHeading,
    titleSame: title === originalTitle,
    modeLabelSame: modeLabel === originalModeLabel,
    listSame: list === originalList,
    listVisible: Boolean(
      list &&
        !list.hasAttribute("hidden") &&
        listStyle?.display !== "none" &&
        listStyle?.visibility !== "hidden",
    ),
    hostHasSpotlightActive: Boolean(host?.hasAttribute("data-spotlight-active")),
    activeHostCount: activeHosts.length,
    activeHostSame: activeHosts.length === 1 && activeHosts[0] === host,
    hovered: Boolean(host && host.matches(":hover")),
    title: snapshotText(title),
    modeLabel: snapshotText(modeLabel),
    targetColor: targetStyle?.color ?? null,
    targetTextFillColor: targetStyle?.webkitTextFillColor ?? null,
    targetTextShadow: targetStyle?.textShadow ?? null,
    targetRect: targetRect
      ? { x: targetRect.x, y: targetRect.y, width: targetRect.width, height: targetRect.height }
      : null,
    hostRect: hostRect
      ? { x: hostRect.x, y: hostRect.y, width: hostRect.width, height: hostRect.height }
      : null,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 },
    scroll: { x: scrollX, y: scrollY },
    scrollChainSame,
    scrollChain: currentScrollNodes.map((node) => ({
      identityId: __idFor(state, node),
      connected: node.isConnected === true,
      id: node.id || null,
      top: node.scrollTop,
      left: node.scrollLeft,
    })),
    scrollSessionContainers: attempt.spotlightDetailScrollSessionNodes.map((node) => ({
      identityId: __idFor(state, node),
      connected: node.isConnected === true,
      top: node.scrollTop,
      left: node.scrollLeft,
    })),
    spotlight: {
      x: originalHost?.style.getPropertyValue("--spotlight-x") || "",
      y: originalHost?.style.getPropertyValue("--spotlight-y") || "",
      radius: originalHost?.style.getPropertyValue("--spotlight-radius") || "",
      mask: originalHost?.style.getPropertyValue("--spotlight-mask") || "",
      pseudo: pseudo
        ? {
            content: pseudo.content,
            opacity: pseudo.opacity,
            maskImage,
            backgroundImage: pseudo.backgroundImage,
            position: pseudo.position,
            inset: pseudo.inset,
            zIndex: pseudo.zIndex,
            borderRadius: pseudo.borderRadius,
            pointerEvents: pseudo.pointerEvents,
            mixBlendMode: pseudo.mixBlendMode,
            filter: pseudo.filter,
            maskSize: pseudo.maskSize,
            maskRepeat: pseudo.maskRepeat,
            transitionProperty: pseudo.transitionProperty,
            transitionDuration: pseudo.transitionDuration,
          }
        : null,
      hostStyle: hostStyle
        ? {
            display: hostStyle.display,
            visibility: hostStyle.visibility,
            isolation: hostStyle.isolation,
            position: hostStyle.position,
            opacity: hostStyle.opacity,
            backgroundColor: hostStyle.backgroundColor,
            backgroundImage: hostStyle.backgroundImage,
            boxShadow: hostStyle.boxShadow,
            borderRadius: hostStyle.borderRadius,
            transform: hostStyle.transform,
            mixBlendMode: hostStyle.mixBlendMode,
            filter: hostStyle.filter,
          }
        : null,
    },
  };
})()`;
}

function spotlightDetailHeadingGuardFailure(observed, baseline, firstNode, phase, roleId, targetKind) {
  if (observed?.identityValid !== true) return observed?.reason || "目标身份核验失败";
  const validTarget =
    (roleId === SPOTLIGHT_DETAIL_TITLE_ROLE_ID && targetKind === "title") ||
    (roleId === SPOTLIGHT_DETAIL_MODE_ROLE_ID && targetKind === "mode-label");
  if (!validTarget || observed.roleId !== roleId || observed.targetKind !== targetKind) {
    return "详情标题角色或目标类型失配";
  }
  if (
    observed.targetIdentityId !== firstNode?.identityId ||
    observed.targetConnected !== true ||
    observed.targetSame !== true
  ) {
    return "原详情标题文字节点已失效";
  }
  if (
    observed.panelCount !== 1 ||
    observed.shellPanelCount !== 1 ||
    observed.headingCount !== 1 ||
    observed.titleNodeCount !== 1 ||
    observed.modeNodeCount !== 1 ||
    observed.listNodeCount !== 1 ||
    observed.titleLeaf !== true ||
    observed.modeLeaf !== true ||
    observed.listIsDirectChild !== true ||
    observed.listVisible !== true ||
    observed.hostSame !== true ||
    observed.hostConnected !== true ||
    observed.headingSame !== true ||
    observed.titleSame !== true ||
    observed.modeLabelSame !== true ||
    observed.listSame !== true ||
    observed.hostHasSpotlightActive !== true
  ) {
    return "详情宿主、标题结构、可见行列表或唯一文字叶节点已变化";
  }
  if (observed.activeHostCount !== 1 || observed.activeHostSame !== true || observed.hovered !== true) {
    return "唯一详情聚光宿主或自然:hover状态已失效";
  }
  const selected = targetKind === "title" ? observed.title : observed.modeLabel;
  const firstRects = firstNode?.rawTextRects;
  const sameRects = (left, right) =>
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length > 0 &&
    left.length === right.length &&
    left.every(
      (rect, index) =>
        rect &&
        right[index] &&
        ["x", "y", "width", "height"].every(
          (key) => Number.isFinite(rect[key]) && Number.isFinite(right[index][key]) && rect[key] === right[index][key],
        ),
    );
  const sameRect = (left, right) =>
    left &&
    right &&
    ["x", "y", "width", "height"].every(
      (key) => Number.isFinite(left[key]) && Number.isFinite(right[key]) && left[key] === right[key],
    );
  const textRectsValid = (snapshot) =>
    typeof snapshot?.text === "string" &&
    snapshot.text.trim() !== "" &&
    Array.isArray(snapshot.rangeRects) &&
    snapshot.rangeRects.length > 0 &&
    snapshot.rangeRects.every(
      (rect) =>
        rect &&
        [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.x + rect.width <= observed.viewport.width &&
        rect.y + rect.height <= observed.viewport.height,
    );
  if (!textRectsValid(observed.title) || !textRectsValid(observed.modeLabel)) {
    return "详情标题或模式说明为空、非纯文本或原始文字范围未完整落入当前视口";
  }
  if (
    !sameRect(firstNode?.rect, selected?.rect) ||
    !sameRects(firstRects, firstNode?.textRects) ||
    !sameRects(firstRects, selected?.rangeRects) ||
    selected?.text !== firstNode?.text ||
    selected?.color !== firstNode?.computed?.color ||
    (!TEXT_HIDE_GUARD_PHASES.has(phase) &&
      (selected?.textFillColor !== firstNode?.computed?.textFillColor ||
        selected?.textShadow !== firstNode?.computed?.textShadow))
  ) {
    return "目标详情文字、前景样式或原始文字几何与node-probe不一致";
  }
  const spotlight = observed.spotlight;
  const pseudo = spotlight?.pseudo;
  const hostStyle = spotlight?.hostStyle;
  if (
    !spotlight?.x ||
    !spotlight.y ||
    !spotlight.radius ||
    !spotlight.mask ||
    spotlight.mask === "none" ||
    !pseudo ||
    pseudo.content === "none" ||
    pseudo.content === "normal" ||
    pseudo.opacity !== "1" ||
    !pseudo.maskImage ||
    pseudo.maskImage === "none" ||
    pseudo.backgroundImage === "none" ||
    pseudo.position !== "absolute" ||
    pseudo.pointerEvents !== "none" ||
    hostStyle?.display === "none" ||
    hostStyle?.visibility === "hidden" ||
    hostStyle?.isolation !== "isolate"
  ) {
    return "详情聚光伪元素、mask或绘制状态无效";
  }
  if (
    observed.scrollChainSame !== true ||
    observed.scrollChain?.some((node) => node.connected !== true) ||
    observed.scrollSessionContainers?.some((node) => node.connected !== true)
  ) {
    return "详情列表或祖先滚动容器已断开";
  }
  if (baseline) {
    const stableObserved = structuredClone(observed);
    const stableBaseline = structuredClone(baseline);
    if (TEXT_HIDE_GUARD_PHASES.has(phase)) {
      const selectedKey = targetKind === "title" ? "title" : "modeLabel";
      for (const snapshot of [stableObserved[selectedKey], stableBaseline[selectedKey]]) {
        delete snapshot.textFillColor;
        delete snapshot.textShadow;
      }
      delete stableObserved.targetTextFillColor;
      delete stableObserved.targetTextShadow;
      delete stableBaseline.targetTextFillColor;
      delete stableBaseline.targetTextShadow;
    }
    if (JSON.stringify(stableObserved) !== JSON.stringify(stableBaseline)) {
      return "原详情标题、模式说明、滚动、视口或聚光状态发生漂移";
    }
  }
  return null;
}

function buildSpotlightDetailRowGuardSource(attemptToken, roleId, targetKind, nodeIndex) {
  return `// skinProbe: spotlight-detail-row-guard
(() => {
${IDENTITY_SOURCE}
  const state = __stash();
  const token = ${JSON.stringify(attemptToken)};
  const roleId = ${JSON.stringify(roleId)};
  const targetKind = ${JSON.stringify(targetKind)};
  const nodeIndex = ${JSON.stringify(nodeIndex)};
  const checked = __attemptIdentity(state, token);
  const attempt = state.attempts.get(token);
  const expectedTargetKind =
    roleId === "${SPOTLIGHT_DETAIL_NAME_ROLE_ID}"
      ? "name"
      : roleId === "${SPOTLIGHT_DETAIL_VALUE_ROLE_ID}"
        ? "value"
        : null;
  if (expectedTargetKind !== targetKind) {
    return { identityValid: false, reason: "详情行角色或目标类型失配", roleId, targetKind, nodeIndex };
  }
  if (!Number.isInteger(nodeIndex) || !attempt || !Array.isArray(attempt.elements) || !attempt.elements[nodeIndex]) {
    return { identityValid: false, reason: "详情行目标索引无效", roleId, targetKind, nodeIndex };
  }
  const target = attempt.elements[nodeIndex];
  const hasClass = (node, name) => String(node?.className ?? "").split(/\\s+/).includes(name);
  const panelNodes = Array.from(document.querySelectorAll("#detailPanel"));
  const shellPanels = Array.from(document.querySelectorAll(".shell #detailPanel"));
  const host = panelNodes.length === 1 && shellPanels.length === 1 && panelNodes[0] === shellPanels[0]
    ? panelNodes[0]
    : null;
  const headings = host ? Array.from(host.children).filter((node) => hasClass(node, "panel-heading")) : [];
  const heading = headings.length === 1 ? headings[0] : null;
  const titleNodes = Array.from(document.querySelectorAll("#detailPanelTitle"));
  const modeNodes = Array.from(document.querySelectorAll("#detailModeLabel"));
  const listNodes = Array.from(document.querySelectorAll("#detailList"));
  const title = titleNodes.length === 1 ? titleNodes[0] : null;
  const modeLabel = modeNodes.length === 1 ? modeNodes[0] : null;
  const list = listNodes.length === 1 ? listNodes[0] : null;
  const plainTextLeaf = (node, tag, parent) => Boolean(
    node &&
      String(node.tagName ?? "").toLowerCase() === tag &&
      node.parentElement === parent &&
      node.childElementCount === 0 &&
      Array.from(node.childNodes).every((child) => child.nodeType === 3) &&
      String(node.textContent ?? "").trim() !== "",
  );
  const titleLeaf = plainTextLeaf(title, "h2", heading);
  const modeLeaf = plainTextLeaf(modeLabel, "span", heading);
  const rowNodes = list ? Array.from(list.children) : [];
  const rectOf = (node) => {
    const rect = node?.getBoundingClientRect();
    return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
  };
  const snapshotText = (node) => {
    if (!node) return null;
    const style = getComputedStyle(node);
    const range = document.createRange();
    range.selectNodeContents(node);
    return {
      identityId: __idFor(state, node),
      connected: node.isConnected === true,
      text: String(node.textContent ?? ""),
      color: style.color,
      textFillColor: style.webkitTextFillColor,
      textShadow: style.textShadow,
      opacity: style.opacity,
      display: style.display,
      visibility: style.visibility,
      fontSize: style.fontSize,
      fontWeight: style.fontWeight,
      rect: rectOf(node),
      rangeRects: Array.from(range.getClientRects(), (box) => ({
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      })),
    };
  };
  const rows = rowNodes.map((row, rowIndex) => {
    const labels = Array.from(row.children).filter((node) => hasClass(node, "bar-label"));
    const label = labels.length === 1 ? labels[0] : null;
    const names = label ? Array.from(label.children).filter((node) => hasClass(node, "bar-name")) : [];
    const values = label ? Array.from(label.children).filter((node) => hasClass(node, "bar-value")) : [];
    const name = names.length === 1 ? names[0] : null;
    const value = values.length === 1 ? values[0] : null;
    return {
      rowIndex,
      row,
      label,
      nameNode: name,
      valueNode: value,
      structureValid: hasClass(row, "bar-row") && row.parentElement === list &&
        label?.parentElement === row && name?.parentElement === label && value?.parentElement === label &&
        plainTextLeaf(name, "span", label) && plainTextLeaf(value, "span", label),
      rowIdentityId: __idFor(state, row),
      labelIdentityId: label ? __idFor(state, label) : null,
      rowConnected: row.isConnected === true,
      labelConnected: label?.isConnected === true,
      rowRect: rectOf(row),
      labelRect: rectOf(label),
      name: snapshotText(name),
      value: snapshotText(value),
    };
  });
  const selectedRows = rows.map((row) => targetKind === "name" ? row.nameNode : row.valueNode);
  const exactSelector = targetKind === "name" ? ${JSON.stringify(SPOTLIGHT_DETAIL_NAME_SELECTOR)} : ${JSON.stringify(SPOTLIGHT_DETAIL_VALUE_SELECTOR)};
  const selectorNodes = Array.from(document.querySelectorAll(exactSelector));
  const orderedTargetsSame = rows.length > 0 &&
    attempt.elements.length === rows.length &&
    selectorNodes.length === rows.length &&
    rows.every((row, index) => selectedRows[index] && attempt.elements[index] === selectedRows[index] && selectorNodes[index] === selectedRows[index]);
  const rowIndex = selectedRows.findIndex((node) => node === target);
  if (host && !attempt.spotlightDetailRowHost) attempt.spotlightDetailRowHost = host;
  if (heading && !attempt.spotlightDetailRowHeading) attempt.spotlightDetailRowHeading = heading;
  if (title && !attempt.spotlightDetailRowTitle) attempt.spotlightDetailRowTitle = title;
  if (modeLabel && !attempt.spotlightDetailRowModeLabel) attempt.spotlightDetailRowModeLabel = modeLabel;
  if (list && !attempt.spotlightDetailRowList) attempt.spotlightDetailRowList = list;
  if (rows.length > 0 && !attempt.spotlightDetailRowNodes) {
    attempt.spotlightDetailRowNodes = rows.map((row) => [row.row, row.label, row.nameNode, row.valueNode]);
  }
  if (list && !attempt.spotlightDetailRowScrollNodes) {
    attempt.spotlightDetailRowScrollNodes = [];
    for (let node = list; node?.nodeType === 1; node = node.parentElement) attempt.spotlightDetailRowScrollNodes.push(node);
  }
  const originalHost = attempt.spotlightDetailRowHost || null;
  const originalHeading = attempt.spotlightDetailRowHeading || null;
  const originalTitle = attempt.spotlightDetailRowTitle || null;
  const originalModeLabel = attempt.spotlightDetailRowModeLabel || null;
  const originalList = attempt.spotlightDetailRowList || null;
  const originalRows = attempt.spotlightDetailRowNodes || [];
  const scrollNodes = attempt.spotlightDetailRowScrollNodes || [];
  const currentScrollNodes = [];
  for (let node = list; node?.nodeType === 1; node = node.parentElement) currentScrollNodes.push(node);
  const scrollChainSame = currentScrollNodes.length === scrollNodes.length &&
    currentScrollNodes.every((node, index) => node === scrollNodes[index]);
  const scrollStash = window[${JSON.stringify(SCROLL_STASH_GLOBAL)}];
  if (!attempt.spotlightDetailRowScrollSessionNodes) {
    if (!scrollStash) return { identityValid: false, reason: "详情行缺少滚动会话", roleId, targetKind, nodeIndex };
    attempt.spotlightDetailRowScrollSessionNodes = scrollStash.containers.map((entry) => entry.node);
  }
  const currentRowsSame = rows.length === originalRows.length &&
    rows.every((row, index) => {
      const original = originalRows[index];
      return original && row.row === original[0] && row.label === original[1] &&
        row.nameNode === original[2] && row.valueNode === original[3];
    });
  const activeHosts = Array.from(document.querySelectorAll(".shell [data-spotlight-active]"));
  const hostStyle = originalHost ? getComputedStyle(originalHost) : null;
  const pseudo = originalHost ? getComputedStyle(originalHost, "::after") : null;
  const maskImage = pseudo?.maskImage && pseudo.maskImage !== "none" ? pseudo.maskImage : pseudo?.webkitMaskImage || "none";
  const hostRect = rectOf(originalHost);
  const listStyle = originalList ? getComputedStyle(originalList) : null;
  const listRect = originalList?.getBoundingClientRect();
  const listClient = listRect ? {
    x: listRect.left + originalList.clientLeft,
    y: listRect.top + originalList.clientTop,
    right: listRect.left + originalList.clientLeft + originalList.clientWidth,
    bottom: listRect.top + originalList.clientTop + originalList.clientHeight,
  } : null;
  const selected = rowIndex >= 0 ? rows[rowIndex][targetKind] : null;
  const selectedNode = rowIndex >= 0 ? selectedRows[rowIndex] : null;
  const targetStyle = selectedNode ? getComputedStyle(selectedNode) : null;
  const targetRect = rectOf(selectedNode);
  return {
    identityValid: checked.valid,
    reason: checked.reason,
    roleId,
    targetKind,
    nodeIndex,
    rowIndex,
    targetIdentityId: __idFor(state, target),
    targetConnected: target.isConnected === true,
    targetSame: target === selectedNode,
    panelCount: panelNodes.length,
    shellPanelCount: shellPanels.length,
    headingCount: headings.length,
    titleNodeCount: titleNodes.length,
    modeNodeCount: modeNodes.length,
    listNodeCount: listNodes.length,
    titleLeaf,
    modeLeaf,
    listIsDirectChild: list?.parentElement === host,
    hostSame: host === originalHost,
    hostConnected: originalHost?.isConnected === true,
    headingSame: heading === originalHeading,
    titleSame: title === originalTitle,
    modeLabelSame: modeLabel === originalModeLabel,
    listSame: list === originalList,
    listVisible: Boolean(list && !list.hasAttribute("hidden") && listStyle?.display !== "none" && listStyle?.visibility !== "hidden"),
    rowCount: rows.length,
    rowStructureValid: rows.length > 0 && rows.length === rowNodes.length && rows.every((row) => row.structureValid),
    currentRowsSame,
    orderedTargetsSame,
    activeHostCount: activeHosts.length,
    activeHostSame: activeHosts.length === 1 && activeHosts[0] === host,
    hovered: Boolean(host && host.matches(":hover")),
    title: snapshotText(title),
    modeLabel: snapshotText(modeLabel),
    rows: rows.map(({ row, label, nameNode, valueNode, ...snapshot }) => snapshot),
    targetColor: targetStyle?.color ?? null,
    targetTextFillColor: targetStyle?.webkitTextFillColor ?? null,
    targetTextShadow: targetStyle?.textShadow ?? null,
    targetRect,
    hostRect,
    listClient,
    listScroll: originalList ? {
      top: originalList.scrollTop,
      left: originalList.scrollLeft,
      clientWidth: originalList.clientWidth,
      clientHeight: originalList.clientHeight,
      scrollWidth: originalList.scrollWidth,
      scrollHeight: originalList.scrollHeight,
    } : null,
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio || 1 },
    scroll: { x: scrollX, y: scrollY },
    scrollChainSame,
    scrollChain: currentScrollNodes.map((node) => ({
      identityId: __idFor(state, node),
      connected: node.isConnected === true,
      id: node.id || null,
      top: node.scrollTop,
      left: node.scrollLeft,
    })),
    scrollSessionContainers: attempt.spotlightDetailRowScrollSessionNodes.map((node) => ({
      identityId: __idFor(state, node),
      connected: node.isConnected === true,
      top: node.scrollTop,
      left: node.scrollLeft,
    })),
    spotlight: {
      x: originalHost?.style.getPropertyValue("--spotlight-x") || "",
      y: originalHost?.style.getPropertyValue("--spotlight-y") || "",
      radius: originalHost?.style.getPropertyValue("--spotlight-radius") || "",
      mask: originalHost?.style.getPropertyValue("--spotlight-mask") || "",
      pseudo: pseudo ? {
        content: pseudo.content,
        opacity: pseudo.opacity,
        maskImage,
        backgroundImage: pseudo.backgroundImage,
        position: pseudo.position,
        inset: pseudo.inset,
        zIndex: pseudo.zIndex,
        borderRadius: pseudo.borderRadius,
        pointerEvents: pseudo.pointerEvents,
        mixBlendMode: pseudo.mixBlendMode,
        filter: pseudo.filter,
        maskSize: pseudo.maskSize,
        maskRepeat: pseudo.maskRepeat,
        transitionProperty: pseudo.transitionProperty,
        transitionDuration: pseudo.transitionDuration,
      } : null,
      hostStyle: hostStyle ? {
        display: hostStyle.display,
        visibility: hostStyle.visibility,
        isolation: hostStyle.isolation,
        position: hostStyle.position,
        opacity: hostStyle.opacity,
        backgroundColor: hostStyle.backgroundColor,
        backgroundImage: hostStyle.backgroundImage,
        boxShadow: hostStyle.boxShadow,
        borderRadius: hostStyle.borderRadius,
        transform: hostStyle.transform,
        mixBlendMode: hostStyle.mixBlendMode,
        filter: hostStyle.filter,
      } : null,
    },
  };
})()`;
}

function spotlightDetailRowGuardFailure(observed, baseline, node, phase, roleId, targetKind, nodeIndex) {
  const validTarget =
    (roleId === SPOTLIGHT_DETAIL_NAME_ROLE_ID && targetKind === "name") ||
    (roleId === SPOTLIGHT_DETAIL_VALUE_ROLE_ID && targetKind === "value");
  if (observed?.identityValid !== true) return observed?.reason || "目标身份核验失败";
  if (
    !validTarget ||
    observed.roleId !== roleId ||
    observed.targetKind !== targetKind ||
    observed.nodeIndex !== nodeIndex
  ) {
    return "详情行角色、目标类型或节点索引失配";
  }
  if (
    observed.targetIdentityId !== node?.identityId ||
    observed.targetConnected !== true ||
    observed.targetSame !== true
  ) {
    return "原详情行文字节点已失效";
  }
  if (
    observed.panelCount !== 1 ||
    observed.shellPanelCount !== 1 ||
    observed.headingCount !== 1 ||
    observed.titleNodeCount !== 1 ||
    observed.modeNodeCount !== 1 ||
    observed.listNodeCount !== 1 ||
    observed.titleLeaf !== true ||
    observed.modeLeaf !== true ||
    observed.listIsDirectChild !== true ||
    observed.listVisible !== true ||
    observed.rowCount < 1 ||
    observed.rowStructureValid !== true ||
    observed.currentRowsSame !== true ||
    observed.orderedTargetsSame !== true ||
    observed.hostSame !== true ||
    observed.hostConnected !== true ||
    observed.headingSame !== true ||
    observed.titleSame !== true ||
    observed.modeLabelSame !== true ||
    observed.listSame !== true
  ) {
    return "详情宿主、标题结构、行顺序或名称/数值纯文字叶节点已变化";
  }
  if (observed.activeHostCount !== 1 || observed.activeHostSame !== true || observed.hovered !== true) {
    return "唯一详情聚光宿主或自然:hover状态已失效";
  }
  if (
    !Number.isInteger(observed.rowIndex) ||
    observed.rowIndex !== nodeIndex ||
    observed.rowIndex >= observed.rowCount
  ) {
    return "详情行索引无法对应原文字节点";
  }
  const sameRects = (left, right) =>
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length > 0 &&
    left.length === right.length &&
    left.every(
      (rect, index) =>
        rect &&
        right[index] &&
        ["x", "y", "width", "height"].every(
          (key) => Number.isFinite(rect[key]) && Number.isFinite(right[index][key]) && rect[key] === right[index][key],
        ),
    );
  const sameRect = (left, right) =>
    left &&
    right &&
    ["x", "y", "width", "height"].every(
      (key) => Number.isFinite(left[key]) && Number.isFinite(right[key]) && left[key] === right[key],
    );
  const inside = (rect, bounds) =>
    rect &&
    bounds &&
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= bounds.x &&
    rect.y >= bounds.y &&
    rect.x + rect.width <= bounds.right &&
    rect.y + rect.height <= bounds.bottom;
  const textRectsValid = (snapshot, bounds) =>
    typeof snapshot?.text === "string" &&
    snapshot.text.trim() !== "" &&
    snapshot.connected === true &&
    snapshot.display !== "none" &&
    snapshot.visibility !== "hidden" &&
    Array.isArray(snapshot.rangeRects) &&
    snapshot.rangeRects.length > 0 &&
    snapshot.rangeRects.every((rect) => inside(rect, bounds));
  const viewportBounds = { x: 0, y: 0, right: observed.viewport?.width, bottom: observed.viewport?.height };
  const listBounds = observed.listClient;
  if (!textRectsValid(observed.title, viewportBounds) || !textRectsValid(observed.modeLabel, viewportBounds)) {
    return "详情标题或模式说明为空、非纯文本或文字范围被视口裁切";
  }
  if (
    !Number.isFinite(listBounds?.x) ||
    !Number.isFinite(listBounds?.y) ||
    !Number.isFinite(listBounds?.right) ||
    !Number.isFinite(listBounds?.bottom)
  ) {
    return "详情列表可见客户区几何无效";
  }
  for (const row of observed.rows ?? []) {
    if (!textRectsValid(row.name, viewportBounds) || !textRectsValid(row.value, viewportBounds)) {
      return `详情第${row.rowIndex + 1}行名称或数值为空、非纯文本或被视口裁切`;
    }
    if (
      !row.name.rangeRects.every((rect) => inside(rect, listBounds)) ||
      !row.value.rangeRects.every((rect) => inside(rect, listBounds))
    ) {
      return `详情第${row.rowIndex + 1}行名称或数值被列表裁切`;
    }
  }
  const selected = observed.rows[observed.rowIndex]?.[targetKind];
  if (
    !sameRect(node?.rect, selected?.rect) ||
    !sameRects(node?.rawTextRects, node?.textRects) ||
    !sameRects(node?.rawTextRects, selected?.rangeRects) ||
    selected?.text !== node?.text ||
    selected?.color !== node?.computed?.color ||
    (!TEXT_HIDE_GUARD_PHASES.has(phase) &&
      (selected?.textFillColor !== node?.computed?.textFillColor ||
        selected?.textShadow !== node?.computed?.textShadow))
  ) {
    return "目标详情行文字、前景样式或原始与可见文字几何不一致";
  }
  const spotlight = observed.spotlight;
  const pseudo = spotlight?.pseudo;
  const hostStyle = spotlight?.hostStyle;
  if (
    !spotlight?.x ||
    !spotlight.y ||
    !spotlight.radius ||
    !spotlight.mask ||
    spotlight.mask === "none" ||
    !pseudo ||
    pseudo.content === "none" ||
    pseudo.content === "normal" ||
    pseudo.opacity !== "1" ||
    !pseudo.maskImage ||
    pseudo.maskImage === "none" ||
    pseudo.backgroundImage === "none" ||
    pseudo.position !== "absolute" ||
    pseudo.pointerEvents !== "none" ||
    hostStyle?.display === "none" ||
    hostStyle?.visibility === "hidden" ||
    hostStyle?.isolation !== "isolate"
  ) {
    return "详情聚光伪元素、mask或绘制状态无效";
  }
  if (
    observed.scrollChainSame !== true ||
    observed.scrollChain?.some((item) => item.connected !== true) ||
    observed.scrollSessionContainers?.some((item) => item.connected !== true)
  ) {
    return "详情列表或祖先滚动容器已断开";
  }
  if (baseline) {
    const stableObserved = structuredClone(observed);
    const stableBaseline = structuredClone(baseline);
    for (const snapshot of [stableObserved, stableBaseline]) {
      delete snapshot.nodeIndex;
      delete snapshot.rowIndex;
      delete snapshot.targetIdentityId;
      delete snapshot.targetConnected;
      delete snapshot.targetSame;
      delete snapshot.targetRect;
      delete snapshot.targetColor;
      delete snapshot.targetTextFillColor;
      delete snapshot.targetTextShadow;
    }
    if (TEXT_HIDE_GUARD_PHASES.has(phase)) {
      for (const snapshot of [stableObserved, stableBaseline]) {
        delete snapshot.rows[observed.rowIndex][targetKind].textFillColor;
        delete snapshot.rows[observed.rowIndex][targetKind].textShadow;
      }
    }
    if (JSON.stringify(stableObserved) !== JSON.stringify(stableBaseline)) {
      return "详情行、标题/模式、滚动、视口或聚光状态发生漂移";
    }
  }
  return null;
}

function spotlightMetricGuardFailure(observed, baseline, firstNode, phase, targetKind) {
  if (observed?.identityValid !== true) return observed?.reason || "目标身份核验失败";
  if (observed.targetIdentityId !== firstNode?.identityId || observed.targetConnected !== true) {
    return "原聚光metric文字节点已失效";
  }
  if (!baseline) {
    if (observed.targetText !== firstNode?.text) return "baseline 文字内容与首次node-probe不一致";
    if (observed.targetColor !== firstNode?.computed?.color) return "baseline 前景色与首次node-probe不一致";
    if (observed.targetTextFillColor !== firstNode?.computed?.textFillColor) {
      return "baseline 文字填充色与首次node-probe不一致";
    }
    if (observed.targetTextShadow !== firstNode?.computed?.textShadow) {
      return "baseline 文字阴影与首次node-probe不一致";
    }
  }
  const targetLeafMatches =
    targetKind === "label"
      ? observed.leafIsMetricLabel === true
      : targetKind === "value" && observed.leafIsMetricValue === true;
  if (
    observed.metricTargetKind !== targetKind ||
    observed.metricHostCount !== 1 ||
    observed.metricLabelCount !== 1 ||
    !targetLeafMatches ||
    observed.hostSame !== true ||
    observed.hostConnected !== true
  ) {
    return "包含#totalTokens的唯一metric宿主或指定文字目标已变化";
  }
  if (targetKind === "value") {
    const rawRects = firstNode?.rawTextRects;
    const visibleRects = firstNode?.textRects;
    const sameRects = (left, right) =>
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every(
        (rect, index) =>
          rect &&
          right[index] &&
          ["x", "y", "width", "height"].every(
            (key) =>
              Number.isFinite(rect[key]) && Number.isFinite(right[index][key]) && rect[key] === right[index][key],
          ),
      );
    if (
      !Number.isFinite(observed.targetClientWidth) ||
      observed.targetClientWidth < 0 ||
      !Number.isFinite(observed.targetScrollWidth) ||
      observed.targetScrollWidth < 0
    ) {
      return "总tokens数值 clientWidth/scrollWidth 缺失或非有限";
    }
    if (observed.targetScrollWidth > observed.targetClientWidth) {
      return "总tokens数值文字发生水平溢出";
    }
    if (
      typeof firstNode?.text !== "string" ||
      firstNode.text.trim() === "" ||
      !Array.isArray(rawRects) ||
      rawRects.length === 0 ||
      rawRects.some(
        (rect) =>
          !rect ||
          ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
          rect.width <= 0 ||
          rect.height <= 0,
      ) ||
      !sameRects(rawRects, visibleRects) ||
      !sameRects(rawRects, observed.targetRangeRects)
    ) {
      return "总tokens数值原始文字矩形缺失、被裁切或在测量中改变";
    }
  }
  if (observed.activeHostCount !== 1 || observed.activeHostSame !== true || observed.hovered !== true) {
    return "唯一聚光宿主或自然:hover状态已失效";
  }
  const spotlight = observed.spotlight;
  const pseudo = spotlight?.pseudo;
  const hostStyle = spotlight?.hostStyle;
  if (
    !spotlight?.x ||
    !spotlight.y ||
    !spotlight.radius ||
    !spotlight.mask ||
    spotlight.mask === "none" ||
    !pseudo ||
    pseudo.content === "none" ||
    pseudo.content === "normal" ||
    pseudo.opacity !== "1" ||
    !pseudo.maskImage ||
    pseudo.maskImage === "none" ||
    pseudo.backgroundImage === "none" ||
    pseudo.position !== "absolute" ||
    pseudo.pointerEvents !== "none" ||
    hostStyle?.display === "none" ||
    hostStyle?.visibility === "hidden" ||
    hostStyle?.isolation !== "isolate"
  ) {
    return "聚光伪元素、mask或绘制状态无效";
  }
  if (observed.containers?.some((container) => container.connected !== true)) {
    return "聚光metric滚动容器已断开";
  }
  if (baseline) {
    if (observed.targetText !== baseline.targetText) return "文字内容变化";
    if (observed.targetColor !== baseline.targetColor) return "前景色变化";
    if (!TEXT_HIDE_GUARD_PHASES.has(phase)) {
      if (observed.targetTextFillColor !== baseline.targetTextFillColor) return "文字填充色未恢复";
      if (observed.targetTextShadow !== baseline.targetTextShadow) return "文字阴影未恢复";
    }
    const stableObservation = { ...observed };
    const stableBaseline = { ...baseline };
    delete stableObservation.targetTextFillColor;
    delete stableObservation.targetTextShadow;
    delete stableBaseline.targetTextFillColor;
    delete stableBaseline.targetTextShadow;
    if (JSON.stringify(stableObservation) !== JSON.stringify(stableBaseline)) {
      return "原metric宿主、视口、滚动或光斑状态发生漂移";
    }
  }
  return null;
}

function spotlightLanguageGuardFailure(observed, baseline, firstNode, phase) {
  if (observed?.identityValid !== true) return observed?.reason || "目标身份核验失败";
  if (
    !observed.zh ||
    !observed.en ||
    observed.languageHostCount !== 1 ||
    observed.zhNodeCount !== 1 ||
    observed.enNodeCount !== 1 ||
    observed.zhLeaf !== true ||
    observed.enLeaf !== true ||
    observed.zhSelected !== true ||
    observed.enSelected !== false ||
    observed.targetSame !== true ||
    observed.zhSame !== true ||
    observed.enSame !== true
  ) {
    return "唯一语言按钮、zh-CN 选中叶或 en-US 未选中叶已变化";
  }
  if (
    observed.hostSame !== true ||
    observed.hostConnected !== true ||
    observed.hostIsButton !== true ||
    observed.hostHasSpotlightActive !== true ||
    observed.hostAriaPressed !== "false"
  ) {
    return "原 languageToggle 宿主或 aria-pressed 状态已变化";
  }
  if (observed.activeHostCount !== 1 || observed.activeHostSame !== true || observed.hovered !== true) {
    return "唯一聚光宿主或自然:hover状态已失效";
  }
  if (
    observed.targetIdentityId !== observed.zh.identityId ||
    observed.targetIdentityId !== firstNode?.identityId ||
    observed.targetConnected !== true ||
    observed.zh.connected !== true ||
    observed.en.connected !== true
  ) {
    return "原语言文字节点已失效";
  }
  if (observed.zh.text !== firstNode?.text || observed.zh.text.trim() === "" || observed.en.text.trim() === "") {
    return "baseline 语言文字内容与首次node-probe不一致";
  }
  const sameRects = (left, right) =>
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length > 0 &&
    left.length === right.length &&
    left.every(
      (rect, index) =>
        rect &&
        right[index] &&
        ["x", "y", "width", "height"].every(
          (key) => Number.isFinite(rect[key]) && Number.isFinite(right[index][key]) && rect[key] === right[index][key],
        ),
    );
  const firstRects = firstNode?.rawTextRects ?? firstNode?.textRects;
  const textRectsValid = (snapshot) =>
    Array.isArray(snapshot?.rangeRects) &&
    snapshot.rangeRects.length > 0 &&
    snapshot.rangeRects.every(
      (rect) =>
        rect &&
        [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.x >= 0 &&
        rect.y >= 0 &&
        rect.x + rect.width <= observed.viewport.width &&
        rect.y + rect.height <= observed.viewport.height,
    );
  if (
    JSON.stringify(observed.targetRect) !== JSON.stringify(firstNode?.rect) ||
    JSON.stringify(observed.zh.rect) !== JSON.stringify(firstNode?.rect) ||
    !sameRects(firstRects, observed.zh.rangeRects) ||
    !textRectsValid(observed.zh)
  ) {
    return "原语言文字或宿主矩形缺失、被裁切或在测量中改变";
  }
  if (
    observed.zh.color !== firstNode?.computed?.color ||
    (!TEXT_HIDE_GUARD_PHASES.has(phase) &&
      (observed.zh.textFillColor !== firstNode?.computed?.textFillColor ||
        observed.zh.textShadow !== firstNode?.computed?.textShadow))
  ) {
    return "baseline 语言文字前景与首次node-probe不一致";
  }
  const hostRect = observed.hostRect;
  if (
    !hostRect ||
    ![hostRect.x, hostRect.y, hostRect.width, hostRect.height].every(Number.isFinite) ||
    hostRect.width <= 0 ||
    hostRect.height <= 0
  ) {
    return "语言按钮宿主矩形无效";
  }
  const spotlight = observed.spotlight;
  const pseudo = spotlight?.pseudo;
  const hostStyle = spotlight?.hostStyle;
  if (
    !spotlight?.x ||
    !spotlight.y ||
    !spotlight.radius ||
    !spotlight.mask ||
    spotlight.mask === "none" ||
    !pseudo ||
    pseudo.content === "none" ||
    pseudo.content === "normal" ||
    pseudo.opacity !== "1" ||
    !pseudo.maskImage ||
    pseudo.maskImage === "none" ||
    pseudo.backgroundImage === "none" ||
    pseudo.position !== "absolute" ||
    pseudo.pointerEvents !== "none" ||
    hostStyle?.display === "none" ||
    hostStyle?.visibility === "hidden" ||
    hostStyle?.opacity !== "1" ||
    hostStyle?.position === "static" ||
    hostStyle?.isolation !== "isolate" ||
    hostStyle?.backgroundImage === "none" ||
    hostStyle?.boxShadow === "none"
  ) {
    return "语言按钮聚光伪元素、mask或宿主背景效应无效";
  }
  if (observed.root?.connected !== true || observed.containers?.some((container) => container.connected !== true)) {
    return "语言按钮根元素或滚动容器已断开";
  }
  if (baseline) {
    const stableObserved = structuredClone(observed);
    const stableBaseline = structuredClone(baseline);
    if (TEXT_HIDE_GUARD_PHASES.has(phase)) {
      for (const snapshot of [stableObserved.zh, stableBaseline.zh]) {
        delete snapshot.textFillColor;
        delete snapshot.textShadow;
        delete snapshot.textFillDeclaration;
        delete snapshot.textShadowDeclaration;
        delete snapshot.styleAttributePresent;
      }
    }
    if (JSON.stringify(stableObserved) !== JSON.stringify(stableBaseline)) {
      return "语言按钮、选中叶、根滚动、视口或聚光状态发生漂移，或恢复未回到原声明";
    }
  }
  return null;
}

function costNoteLinkTextRangeSignature(node) {
  if (
    !node?.rect ||
    ![node.rect.x, node.rect.y].every(Number.isFinite) ||
    !Array.isArray(node.textRects) ||
    node.textRects.length === 0
  ) {
    return null;
  }
  return node.textRects.map((rect) => {
    if (
      !rect ||
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return null;
    }
    return [rect.x - node.rect.x, rect.y - node.rect.y, rect.width, rect.height].map(
      (value) => Math.round(value * 1000) / 1000,
    );
  });
}

function costNoteLinkDecorationFailure(node, baselineProof = null, baselineRange = null, hidden = false) {
  const proof = node?.costNoteLinkDecorationProof;
  const identity = proof?.identity;
  const chain = proof?.chain;
  if (
    proof?.valid !== true ||
    !identity ||
    identity.selectorExact !== true ||
    identity.pseudoFree !== true ||
    identity.isHtmlAnchor !== true ||
    identity.withinCostEstimateNote !== true ||
    identity.hasHref !== true ||
    identity.isContentEditable !== true ||
    identity.hasShadowRoot !== false ||
    identity.childElementCount !== 0 ||
    identity.directTextOnly !== true ||
    !Number.isInteger(identity.directTextNodeCount) ||
    identity.directTextNodeCount < 1 ||
    identity.hasNonEmptyDirectText !== true ||
    !Array.isArray(chain) ||
    chain.length < 2 ||
    chain[0]?.tag !== "a" ||
    chain.at(-1)?.tag !== "html" ||
    chain.some((entry) => typeof entry?.textDecorationLine !== "string" || !entry.textDecorationLine)
  ) {
    return "装饰证明缺失或无效";
  }
  if (!["none", "underline"].includes(chain[0].textDecorationLine)) return "目标装饰状态无效";
  if (chain.slice(1).some((entry) => entry.textDecorationLine !== "none")) return "祖先装饰状态无效";
  if (baselineProof) {
    if (JSON.stringify(identity) !== JSON.stringify(baselineProof.identity)) return "链接身份证明发生变化";
    if (JSON.stringify(chain.slice(1)) !== JSON.stringify(baselineProof.chain.slice(1))) return "祖先装饰链发生变化";
    if (chain[0].textDecorationLine !== (hidden ? "none" : baselineProof.chain[0].textDecorationLine)) {
      return hidden ? "隐藏后目标装饰未清除" : "隐藏前目标装饰发生变化";
    }
  }
  const range = costNoteLinkTextRangeSignature(node);
  if (!range || range.some((rect) => rect === null)) return "文字范围缺失或无效";
  if (baselineRange && JSON.stringify(range) !== JSON.stringify(baselineRange)) return "文字范围发生变化";
  return null;
}

/** 默认逐带滚动；悬停固定视口只收当前完整文字，不移动目标。 */
async function collectVisibleRects(
  page,
  selector,
  index,
  viewport,
  readRects,
  hiddenToken = null,
  recordOcclusion = false,
  expectedNode = null,
  fixedViewport = false,
  fixedViewportLabel = "悬停固定视口",
  nativeAttemptToken = null,
  includeOwnTextRanges = false,
  includeCostNoteLinkDecorationProof = false,
  costNoteLinkBaselineProof = null,
  costNoteLinkBaselineRange = null,
) {
  const bands = [];
  if (!fixedViewport) await page.evaluate(buildBringIntoViewSource(selector, index));
  for (let step = 0; step < MAX_MEASURE_BANDS; step += 1) {
    const live = await probeNodes(page, selector, null, {
      hiddenToken,
      includeOwnTextRanges,
      includeCostNoteLinkDecorationProof,
    });
    if (live.measurementIdentity && live.measurementIdentity.valid === false) {
      if (fixedViewport) throw new Error(`${fixedViewportLabel}：逐带重探时 ${live.measurementIdentity.reason}`);
      throw new MeasurementSampleInvalid(`逐带重探时 ${live.measurementIdentity.reason}`, expectedNode);
    }
    const node = live.nodes[index];
    if (!node) {
      if (includeCostNoteLinkDecorationProof) {
        throw new MeasurementSampleInvalid("隐藏后链接身份或装饰证明缺失", expectedNode);
      }
      break;
    }
    if (includeCostNoteLinkDecorationProof) {
      const failure = costNoteLinkDecorationFailure(node, costNoteLinkBaselineProof, costNoteLinkBaselineRange, true);
      if (failure) {
        throw new MeasurementSampleInvalid(`隐藏后链接${failure}`, expectedNode, {
          costNoteLinkDecorationProof: node.costNoteLinkDecorationProof ?? null,
          textRects: node.textRects ?? null,
        });
      }
    }
    if (includeOwnTextRanges) {
      const rangeFailure = ownTextRangeProbeFailure(node);
      if (rangeFailure) {
        throw new MeasurementSampleInvalid(`逐带重探时${rangeFailure}`, expectedNode, {
          ownTextRangeProbe: node.ownTextRangeProbe ?? null,
          rawTextRects: node.rawTextRects ?? null,
          textRects: node.textRects ?? null,
          textRectClipping: node.textRectClipping ?? null,
        });
      }
    }
    const rawRects = await readRects(node);
    if (!Array.isArray(rawRects)) {
      throw new MeasurementSampleInvalid("文字几何回调未返回矩形数组", expectedNode);
    }
    const rects = rawRects.filter((rect) => isInsideViewport(rect, viewport));
    if (fixedViewport && (rects.length === 0 || rects.length !== rawRects.length)) {
      throw new Error(`${fixedViewportLabel}：文字几何未完整落入当前视口`);
    }
    if (rects.length > 0) {
      let occlusion = null;
      if (recordOcclusion) {
        try {
          occlusion = await page.evaluate(buildOcclusionProbeSource(selector, index, rects, hiddenToken));
          if (occlusion?.identityValid === false) {
            if (fixedViewport) throw new Error(`${fixedViewportLabel}：遮挡探针时 ${occlusion.reason}`);
            throw new MeasurementSampleInvalid(`遮挡探针时 ${occlusion.reason}`, expectedNode);
          }
          if (!occlusion) occlusion = { error: "遮挡探针未返回结果", rects: [] };
        } catch (error) {
          if (fixedViewport) throw error;
          if (error instanceof MeasurementSampleInvalid) throw error;
          occlusion = { error: "逐带遮挡探针执行失败", rects: [] };
        }
      }
      const band = {
        scroll: { ...node.scroll },
        rects,
        rect: node.rect,
        occlusion,
        ...(includeOwnTextRanges ? { ownTextRangeProbe: node.ownTextRangeProbe } : {}),
        ...(includeCostNoteLinkDecorationProof
          ? { costNoteLinkDecorationProof: node.costNoteLinkDecorationProof }
          : {}),
        ...(Array.isArray(node.rawTextRects)
          ? { rawTextRects: node.rawTextRects, textRectClipping: node.textRectClipping }
          : {}),
      };
      // D3b：普通 pointerProbe 先生成并保留在诊断里；toast 的原生命中结果替换
      // band.occlusion 供原 occlusionFailureReason 使用（不当普通命中降级放行）。
      // D3b-R1：原生命中探针抛错保持原对象，交给既有采样/操作清理路径；该结果
      // 同时是 PNG 前唯一一次原生检查，由 band 循环紧邻 before-png 守卫消费。
      if (nativeAttemptToken) {
        band.pointerProbe = occlusion;
        if (!occlusion || occlusion.error || occlusion.identityValid !== true) {
          band.nativeProbe = { ok: false, skipped: true, reason: "普通遮挡探针不可用，未调用原生命中探针" };
        } else {
          band.occlusion = await probeToastNativeOcclusion({
            page,
            attemptToken: nativeAttemptToken,
            hiddenToken,
            rects,
            pointerProbe: occlusion,
          });
          band.nativeProbe = { ok: true, source: band.occlusion.source };
        }
      }
      bands.push(band);
    }
    if (fixedViewport || node.rect.y + node.rect.height <= viewport.height + 1) break;
    await page.evaluate(buildScrollBySource(Math.max(1, viewport.height - BAND_OVERLAP_PX)));
  }
  return bands;
}

/** 恢复核验差异落账（样式与几何分列）。 */
function recordRestorationDiagnostics(diagnostics, role, node, differences) {
  if (differences.styleDifferences.length > 0) {
    diagnostics.restoration.styleDifferences.push(
      ...differences.styleDifferences.map((entry) => `${role.id}#${node.index}: ${entry}`),
    );
  }
  if (differences.rectDifferences.length > 0) {
    diagnostics.restoration.rectDifferences.push(`${role.id}#${node.index}`);
  }
}

/**
 * 消费恢复侧的 inlineRestored：computed 值相同但内联声明没回到原值或空 style 残留也算
 * 没恢复干净。落进 diagnostics，不静默。
 */
function recordInlineRestoreDiagnostics(diagnostics, role, node, restorations) {
  for (const [stage, result] of restorations) {
    if (result?.ok === true && result.inlineRestored === false) {
      diagnostics.restoration.inlineRestoreFailures.push(`${role.id}#${node.index}: ${stage} 内联声明未回到原值`);
    }
    if (result?.ok === true && result.decorationRestored === false) {
      diagnostics.restoration.inlineRestoreFailures.push(`${role.id}#${node.index}: ${stage} 装饰隔离未完全清理`);
    }
    if (result?.ok === true && result.restoreErrors?.length > 0) {
      diagnostics.restoration.inlineRestoreFailures.push(
        `${role.id}#${node.index}: ${stage} 恢复异常（${result.restoreErrors.join("；")}）`,
      );
    }
  }
}

/**
 * 一次角色尝试最多重做一次：DOM 身份失效 → 丢弃本次全部 measurements/evidence，
 * 从新的完整角色快照重来；第二次仍失效则记 unmeasured（不伪造通过）。
 * 已产出的截图留在 captures 里但标记为失效样本，作为"确实发生过替换"的证据。
 */
async function withOneIdentityRetry(role, runtime, recordContext, selector, attempt) {
  let lastReason = "未知 DOM 身份变化";
  let lastNodeDiagnostic = null;
  for (let round = 1; round <= 2; round += 1) {
    const captureStart = runtime.captures.length;
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof MeasurementSampleInvalid)) throw error;
      lastReason = error.message;
      lastNodeDiagnostic = error.nodeDiagnostic;
      for (const capture of runtime.captures.slice(captureStart)) {
        capture.sampleStatus = "invalidated-dom-identity";
        capture.sampleInvalidationReason = lastReason;
      }
      runtime.notes.push(`${role.id}: 第 ${round} 次角色尝试 DOM 样本失效——${lastReason}`);
      if (round === 2) {
        return unmeasuredRecord(
          role,
          recordContext,
          METHOD_UNMEASURED,
          `DOM 身份样本连续两次失效（角色尝试重做一次后仍被替换）：${lastReason}`,
          { selector, sampleInvalid: true, attempts: round, ...(lastNodeDiagnostic ?? {}) },
        );
      }
    }
  }
  return unmeasuredRecord(role, recordContext, METHOD_UNMEASURED, `DOM 身份样本失效：${lastReason}`, { selector });
}

async function measureTextRole(role, runtime, recordContext, rawSelector) {
  const hoverFixedViewport = recordContext.stateId === "button-hover" && role.id === "button.secondary";
  const toastFixedViewport = isToastNativeTarget(recordContext, role, rawSelector);
  const spotlightMetricTarget = spotlightMetricTargetKind(recordContext, role, rawSelector);
  const spotlightTimelineTarget = spotlightTimelineTargetKind(recordContext, role, rawSelector);
  const spotlightDetailHeadingTarget = spotlightDetailHeadingTargetKind(recordContext, role, rawSelector);
  const spotlightLanguageTarget = isSpotlightLanguageTarget(recordContext, role, rawSelector);
  const spotlightFixedViewport =
    spotlightMetricTarget !== null ||
    spotlightTimelineTarget !== null ||
    spotlightDetailHeadingTarget !== null ||
    spotlightLanguageTarget;
  // toast、hover 与聚光目标都不走身份重试：自然状态失效就拒绝，不换节点重测。
  if (hoverFixedViewport || toastFixedViewport || spotlightFixedViewport) {
    try {
      return await measureTextRoleAttempt(role, runtime, recordContext, rawSelector);
    } catch (error) {
      if (hoverFixedViewport && error instanceof MeasurementSampleInvalid) {
        throw new Error(`悬停固定视口：${error.message}`, { cause: error });
      }
      throw error;
    }
  }
  return withOneIdentityRetry(role, runtime, recordContext, rawSelector, () =>
    measureTextRoleAttempt(role, runtime, recordContext, rawSelector),
  );
}

async function measureTextRoleAttempt(role, runtime, recordContext, rawSelector) {
  const { page, shoot, diagnostics, viewport } = runtime;
  const hoverFixedViewport = recordContext.stateId === "button-hover" && role.id === "button.secondary";
  const toastFixedViewport = isToastNativeTarget(recordContext, role, rawSelector);
  const spotlightMetricTarget = spotlightMetricTargetKind(recordContext, role, rawSelector);
  const spotlightMetricFixedViewport = spotlightMetricTarget !== null;
  const spotlightTimelineTarget = spotlightTimelineTargetKind(recordContext, role, rawSelector);
  const spotlightTimelineFixedViewport = spotlightTimelineTarget !== null;
  const spotlightDetailHeadingTarget = spotlightDetailHeadingTargetKind(recordContext, role, rawSelector);
  const spotlightDetailHeadingFixedViewport = spotlightDetailHeadingTarget !== null;
  const spotlightDetailRowFixedViewport =
    spotlightDetailHeadingTarget === "name" || spotlightDetailHeadingTarget === "value";
  const spotlightLanguageFixedViewport = isSpotlightLanguageTarget(recordContext, role, rawSelector);
  const spotlightFixedViewport =
    spotlightMetricFixedViewport ||
    spotlightTimelineFixedViewport ||
    spotlightDetailHeadingFixedViewport ||
    spotlightLanguageFixedViewport;
  const includeOwnTextRanges =
    role.id === "cost.note-text" &&
    recordContext.stateId === "dashboard-default" &&
    rawSelector === "#costEstimateNote > p, #costEstimateNote li";
  const includeCostNoteLinkDecorationProof =
    role.id === "cost.note-link" &&
    recordContext.stateId === "dashboard-default" &&
    rawSelector === "#costEstimateNote a";
  const fixedViewport = hoverFixedViewport || toastFixedViewport || spotlightFixedViewport;
  const fixedViewportLabel = spotlightDetailRowFixedViewport
    ? "详情行聚光固定视口"
    : spotlightDetailHeadingFixedViewport
      ? "详情标题聚光固定视口"
      : spotlightLanguageFixedViewport
        ? "语言按钮聚光固定视口"
        : spotlightTimelineFixedViewport
          ? "时间分布标题聚光固定视口"
          : spotlightMetricFixedViewport
            ? "聚光metric固定视口"
            : toastFixedViewport
              ? "toast 固定视口"
              : "悬停固定视口";
  const { selector, pseudo } = splitSelectorPseudo(rawSelector);
  const nativePlaceholderRoute = role.id === "input.placeholder" && pseudo === "::placeholder";
  const probe = await probeNodes(page, selector, pseudo, {
    trackIdentities: true,
    includeText: spotlightFixedViewport,
    includeOwnOpacityTextProof: true,
    includeOwnTextRanges,
    includeCostNoteLinkDecorationProof,
  });
  if (probe.error) {
    return unmeasuredRecord(role, recordContext, METHOD_UNMEASURED, probe.error, { selector: rawSelector, pseudo });
  }
  if (probe.nodes.length === 0) {
    return unmeasuredRecord(role, recordContext, METHOD_UNMEASURED, `状态内未找到选择器匹配：${rawSelector}`, {
      selector: rawSelector,
      pseudo,
    });
  }
  // 本次尝试的固定基准：上面这次探测命中的有序对象集合，后续隐藏/重探/扫描/恢复
  // 核验全部拿它比对，不再按当前 DOM 重新采样
  const attemptToken = probe.attemptToken;
  const nativePlaceholderCaptureStart = runtime.captures.length;
  const measurements = [];
  const evidence = {
    kind: METHOD_TEXT,
    selector: rawSelector,
    elementSelector: selector,
    pseudo,
    nodes: [],
    notApplicableNodes: [],
  };
  const initialCostNoteLinkProofFailure = includeCostNoteLinkDecorationProof
    ? (probe.nodes.map((node) => costNoteLinkDecorationFailure(node)).find(Boolean) ?? null)
    : null;
  await page.evaluate(buildBeginScrollSessionSource());
  let hoverBaseline = null;
  const guardHover = async (phase) => {
    if (!hoverFixedViewport) return;
    const observed = await page.evaluate(buildHoverGuardSource(attemptToken));
    const entry = { phase, observed };
    diagnostics.hoverStateGuards ??= [];
    diagnostics.hoverStateGuards.push(entry);
    const stable =
      observed?.identityValid === true &&
      observed.hovered === true &&
      observed.identityId === probe.nodes[0]?.identityId &&
      JSON.stringify(observed.rect) === JSON.stringify(probe.nodes[0]?.rect) &&
      observed.containers?.every((container) => container.connected === true) &&
      (!hoverBaseline || JSON.stringify(observed) === JSON.stringify(hoverBaseline));
    entry.valid = Boolean(stable);
    if (!stable) throw new Error(`悬停固定视口 ${phase}：悬停、身份、几何或滚动状态失效`);
    hoverBaseline ??= observed;
  };
  let toastBaseline = null;
  let spotlightMetricBaseline = null;
  let spotlightMetricCaptureIndex = null;
  let spotlightTimelineBaseline = null;
  let spotlightTimelineCaptureIndex = null;
  let spotlightDetailHeadingBaseline = null;
  let spotlightDetailHeadingCaptureIndex = null;
  let spotlightDetailRowBaseline = null;
  let spotlightDetailRowNode = probe.nodes[0] ?? null;
  const spotlightDetailRowCaptureIndices = [];
  let spotlightLanguageBaseline = null;
  let spotlightLanguageCaptureIndex = null;
  const formatTextPathError = (error) => String(error?.message ?? error);
  let toastHiddenToken = null;
  /** PNG 后原生检查：正常遮挡返回拒绝原因；helper 抛错保持原对象交给采样/操作清理路径。 */
  const runToastNativeCheck = async (band) => {
    const result = await probeToastNativeOcclusion({
      page,
      attemptToken,
      hiddenToken: toastHiddenToken,
      rects: band.rects,
      pointerProbe: band.pointerProbe,
    });
    return {
      ok: true,
      reason: null,
      result,
      occlusion: occlusionFailureReason({ occlusion: result, rects: band.rects }),
    };
  };
  /** 给已产 PNG 标失效：标记失败只影响可观测性，不得替换主错误传播。 */
  const invalidateCapture = (index, reason, sampleStatus = "invalidated-toast-post-png-native") => {
    try {
      const capture = runtime.captures[index];
      if (capture) {
        capture.sampleStatus = sampleStatus;
        capture.sampleInvalidationReason = reason;
      }
    } catch {
      // 标记失败不得替换主错误传播
    }
  };
  const invalidateNativePlaceholderCaptures = (reason) => {
    for (let index = nativePlaceholderCaptureStart; index < runtime.captures.length; index += 1) {
      let alreadyInvalidated = false;
      try {
        alreadyInvalidated = Boolean(runtime.captures[index]?.sampleStatus);
      } catch {
        // 读取失效标记失败也不能替换主错误
      }
      if (!alreadyInvalidated) invalidateCapture(index, reason, "invalidated-input-placeholder-native");
    }
  };
  const guardToast = async (phase) => {
    if (!toastFixedViewport) return;
    const observed = await page.evaluate(buildToastBusinessGuardSource(attemptToken, toastHiddenToken));
    const entry = { phase, observed };
    diagnostics.toastStateGuards ??= [];
    diagnostics.toastStateGuards.push(entry);
    const failure = toastBusinessGuardFailure(phase, observed, toastBaseline, probe.nodes[0]);
    entry.valid = failure === null;
    if (failure) throw new Error(`toast 固定视口 ${phase}：${failure}`);
    toastBaseline ??= observed;
  };
  const guardSpotlightMetric = async (phase) => {
    if (!spotlightMetricFixedViewport) return;
    const observed = await page.evaluate(buildSpotlightMetricGuardSource(attemptToken));
    const entry = { phase, observed };
    diagnostics.spotlightMetricStateGuards ??= [];
    diagnostics.spotlightMetricStateGuards.push(entry);
    const failure = spotlightMetricGuardFailure(
      observed,
      spotlightMetricBaseline,
      probe.nodes[0],
      phase,
      spotlightMetricTarget,
    );
    entry.valid = failure === null;
    if (failure) {
      if (spotlightMetricCaptureIndex !== null) {
        invalidateCapture(spotlightMetricCaptureIndex, `${phase}：${failure}`, "invalidated-spotlight-metric-state");
      }
      throw new Error(`聚光metric固定视口 ${phase}：${failure}`);
    }
    spotlightMetricBaseline ??= observed;
  };
  const guardSpotlightTimeline = async (phase) => {
    if (!spotlightTimelineFixedViewport) return;
    const observed = await page.evaluate(
      buildSpotlightTimelineHeadingGuardSource(attemptToken, role.id, spotlightTimelineTarget),
    );
    const entry = { roleId: role.id, phase, observed };
    diagnostics.spotlightTimelineHeadingGuards ??= [];
    diagnostics.spotlightTimelineHeadingGuards.push(entry);
    const failure = spotlightTimelineHeadingGuardFailure(
      observed,
      spotlightTimelineBaseline,
      probe.nodes[0],
      phase,
      role.id,
      spotlightTimelineTarget,
    );
    entry.valid = failure === null;
    if (failure) {
      if (spotlightTimelineCaptureIndex !== null) {
        invalidateCapture(
          spotlightTimelineCaptureIndex,
          `${phase}：${failure}`,
          "invalidated-spotlight-timeline-heading-state",
        );
      }
      throw new Error(`时间分布标题聚光固定视口 ${phase}：${failure}`);
    }
    spotlightTimelineBaseline ??= observed;
  };
  const guardSpotlightLanguage = async (phase) => {
    if (!spotlightLanguageFixedViewport) return;
    const observed = await page.evaluate(buildSpotlightLanguageGuardSource(attemptToken));
    const entry = { phase, observed };
    diagnostics.spotlightLanguageStateGuards ??= [];
    diagnostics.spotlightLanguageStateGuards.push(entry);
    const failure = spotlightLanguageGuardFailure(observed, spotlightLanguageBaseline, probe.nodes[0], phase);
    entry.valid = failure === null;
    if (failure) {
      if (spotlightLanguageCaptureIndex !== null) {
        invalidateCapture(
          spotlightLanguageCaptureIndex,
          `${phase}：${failure}`,
          "invalidated-spotlight-language-state",
        );
      }
      throw new Error(`语言按钮聚光固定视口 ${phase}：${failure}`);
    }
    spotlightLanguageBaseline ??= observed;
  };
  const guardSpotlightDetailHeading = async (phase) => {
    if (!spotlightDetailHeadingFixedViewport) return;
    const isRowTarget = spotlightDetailRowFixedViewport;
    const observed = await page.evaluate(
      isRowTarget
        ? buildSpotlightDetailRowGuardSource(
            attemptToken,
            role.id,
            spotlightDetailHeadingTarget,
            spotlightDetailRowNode?.index,
          )
        : buildSpotlightDetailHeadingGuardSource(attemptToken, role.id, spotlightDetailHeadingTarget),
    );
    const entry = {
      roleId: role.id,
      nodeIndex: isRowTarget ? (spotlightDetailRowNode?.index ?? null) : 0,
      rowIndex: isRowTarget ? (observed?.rowIndex ?? null) : null,
      targetKind: spotlightDetailHeadingTarget,
      phase,
      observed,
    };
    const diagnosticsKey = isRowTarget ? "spotlightDetailRowGuards" : "spotlightDetailHeadingGuards";
    diagnostics[diagnosticsKey] ??= [];
    diagnostics[diagnosticsKey].push(entry);
    const failure = isRowTarget
      ? spotlightDetailRowGuardFailure(
          observed,
          spotlightDetailRowBaseline,
          spotlightDetailRowNode,
          phase,
          role.id,
          spotlightDetailHeadingTarget,
          spotlightDetailRowNode?.index,
        )
      : spotlightDetailHeadingGuardFailure(
          observed,
          spotlightDetailHeadingBaseline,
          probe.nodes[0],
          phase,
          role.id,
          spotlightDetailHeadingTarget,
        );
    entry.valid = failure === null;
    if (failure) {
      if (isRowTarget) {
        for (const index of spotlightDetailRowCaptureIndices) {
          invalidateCapture(index, `${phase}：${failure}`, "invalidated-spotlight-detail-row-state");
        }
      } else if (spotlightDetailHeadingCaptureIndex !== null) {
        invalidateCapture(
          spotlightDetailHeadingCaptureIndex,
          `${phase}：${failure}`,
          "invalidated-spotlight-detail-heading-state",
        );
      }
      throw new Error(`${fixedViewportLabel} ${phase}：${failure}`);
    }
    if (isRowTarget) spotlightDetailRowBaseline ??= observed;
    else spotlightDetailHeadingBaseline ??= observed;
  };
  const guardFixedViewport = async (phase) => {
    if (hoverFixedViewport) return guardHover(phase);
    if (toastFixedViewport) return guardToast(phase);
    if (spotlightLanguageFixedViewport) return guardSpotlightLanguage(phase);
    if (spotlightDetailHeadingFixedViewport) return guardSpotlightDetailHeading(phase);
    if (spotlightTimelineFixedViewport) return guardSpotlightTimeline(phase);
    if (spotlightMetricFixedViewport) return guardSpotlightMetric(phase);
  };
  let operationFailed = false;
  let operationError;
  try {
    if (fixedViewport) {
      await guardFixedViewport("baseline");
      if (hoverFixedViewport) {
        if (
          rawSelector !== "#addImportButton:hover" ||
          probe.nodes.length !== 1 ||
          probe.nodes[0].textRects.length === 0 ||
          !probe.nodes[0].textRects.every((rect) => isInsideViewport(rect, viewport))
        )
          throw new Error("悬停固定视口：单一目标的文字几何未完整落入当前视口");
      } else if (toastFixedViewport) {
        if (probe.nodes.length !== 1) throw new Error("toast 固定视口：宿主不唯一");
        if (toastNodeRendered(probe.nodes[0]) && !toastSingleFullTextRect(probe.nodes[0], viewport)) {
          throw new Error("toast 固定视口：单一完整文字矩形未完整落入当前视口");
        }
      } else if (spotlightTimelineFixedViewport) {
        if (
          probe.nodes.length !== 1 ||
          probe.nodes[0].textRects.length === 0 ||
          !probe.nodes[0].textRects.every((rect) => isInsideViewport(rect, viewport))
        ) {
          const targetLabel = spotlightTimelineTarget === "title" ? "时间标题" : "周期范围";
          throw new Error(`时间分布标题聚光固定视口：单一${targetLabel}文字几何未完整落入当前视口`);
        }
      } else if (spotlightDetailHeadingFixedViewport) {
        const sameRects = (left, right) =>
          Array.isArray(left) &&
          Array.isArray(right) &&
          left.length > 0 &&
          left.length === right.length &&
          left.every(
            (rect, index) =>
              rect &&
              right[index] &&
              ["x", "y", "width", "height"].every(
                (key) =>
                  Number.isFinite(rect[key]) && Number.isFinite(right[index][key]) && rect[key] === right[index][key],
              ),
          );
        if (spotlightDetailRowFixedViewport) {
          if (
            probe.nodes.length === 0 ||
            probe.nodes.some(
              (node) =>
                !sameRects(node.rawTextRects, node.textRects) ||
                !node.rawTextRects.every((rect) => isInsideViewport(rect, viewport)),
            )
          ) {
            throw new Error("详情行聚光固定视口：每个名称/数值原始文字范围都必须完整未裁切地落入当前视口");
          }
        } else if (
          probe.nodes.length !== 1 ||
          probe.nodes[0].rawTextRects?.length === 0 ||
          probe.nodes[0].textRects.length === 0 ||
          !probe.nodes[0].rawTextRects?.every((rect) => isInsideViewport(rect, viewport))
        ) {
          const targetLabel = spotlightDetailHeadingTarget === "title" ? "详情标题" : "模式说明";
          throw new Error(`详情标题聚光固定视口：单一${targetLabel}原始文字几何未完整落入当前视口`);
        }
      } else if (spotlightLanguageFixedViewport) {
        if (probe.nodes.length !== 1 || !toastSingleFullTextRect(probe.nodes[0], viewport)) {
          throw new Error("语言按钮聚光固定视口：单一选中语言文字矩形未完整未裁切地落入当前视口");
        }
      } else if (
        probe.nodes.length !== 1 ||
        probe.nodes[0].textRects.length === 0 ||
        !probe.nodes[0].textRects.every((rect) => isInsideViewport(rect, viewport))
      ) {
        const targetLabel = spotlightMetricTarget === "value" ? "总tokens数值" : "普通标签";
        throw new Error(`聚光metric固定视口：单一${targetLabel}的文字几何未完整落入当前视口`);
      }
    }
    for (const node of probe.nodes) {
      if (spotlightDetailRowFixedViewport) {
        spotlightDetailRowNode = node;
        if (node !== probe.nodes[0]) await guardFixedViewport("baseline");
      }
      let geometry = {
        rect: node.rect,
        client: node.client,
        textRects: node.textRects,
        ...(includeOwnTextRanges ? { ownTextRangeProbe: node.ownTextRangeProbe ?? null } : {}),
        ...(Array.isArray(node.rawTextRects)
          ? { rawTextRects: node.rawTextRects, textRectClipping: node.textRectClipping }
          : {}),
      };
      if (initialCostNoteLinkProofFailure) {
        const reason = `费用链接${initialCostNoteLinkProofFailure}`;
        pushNodeUnmeasured(measurements, node, reason, { geometry });
        evidence.nodes.push({
          index: node.index,
          identity: nodeIdentity(node),
          costNoteLinkDecorationProof: node.costNoteLinkDecorationProof ?? null,
          geometry,
          rejectedReason: reason,
        });
        continue;
      }
      if (includeOwnTextRanges) {
        const rangeFailure = ownTextRangeProbeFailure(node);
        if (rangeFailure) {
          const reason = `自身文字范围不可测：${rangeFailure}`;
          const identity = nodeIdentity(node);
          pushNodeUnmeasured(measurements, node, reason, { geometry });
          evidence.nodes.push({
            index: node.index,
            identity,
            ownTextRangeProbe: node.ownTextRangeProbe ?? null,
            geometry,
            rejectedReason: reason,
          });
          continue;
        }
      }
      const applicability = inputNodeApplicability(role, node);
      if (applicability?.kind === "unmeasured") {
        pushNodeUnmeasured(measurements, node, applicability.reason);
        continue;
      }
      if (applicability?.kind === "not-applicable") {
        pushNodeNotApplicable(measurements, evidence, node, applicability.reason);
        continue;
      }
      // 未渲染节点没有可测像素：单独记账，不参与覆盖判定，但原因必须留下
      const notRenderedReason =
        node.computed.display === "none"
          ? "元素 display:none（未渲染，没有可测像素）"
          : node.computed.visibility === "hidden"
            ? "元素 visibility:hidden（未渲染，没有可测像素）"
            : node.rect.width <= 0 || node.rect.height <= 0
              ? "元素矩形尺寸为 0（未渲染，没有可测像素）"
              : null;
      if (notRenderedReason) {
        measurements.push({ notRendered: notRenderedReason, node: node.index, identity: nodeIdentity(node) });
        continue;
      }
      let nativePlaceholderState = null;
      let nativePlaceholderLiveNode = node;
      let recordNativePlaceholderStage = async () => null;
      if (nativePlaceholderRoute && isInputPlaceholderNativeNode(role, pseudo, node)) {
        const brought = await page.evaluate(buildBringIntoViewSource(selector, node.index));
        if (brought?.ok !== true) {
          throw new MeasurementSampleInvalid(
            `input.placeholder 原生 UA 初始绑定无法带入视口：${brought?.reason ?? "unknown"}`,
            node,
            { nativePlaceholderBinding: { bring: brought, expected: nodeIdentity(node), live: null } },
          );
        }
        const liveProbe = await probeNodes(page, selector, null);
        if (liveProbe.error) {
          throw new MeasurementSampleInvalid(`input.placeholder 原生 UA 初始绑定重探失败：${liveProbe.error}`, node);
        }
        const liveNode = liveProbe.nodes[node.index];
        if (
          !liveNode ||
          !Number.isInteger(node.identityId) ||
          !Number.isInteger(liveNode.identityId) ||
          liveNode.index !== node.index ||
          liveNode.identityId !== node.identityId ||
          !inputPlaceholderRectsEqual(inputPlaceholderDocumentRect(node), inputPlaceholderDocumentRect(liveNode)) ||
          !inputPlaceholderClientEqual(node.client, liveNode.client)
        ) {
          throw new MeasurementSampleInvalid(
            "input.placeholder 原生 UA 初始绑定重探时身份、文档坐标、尺寸或 client 漂移",
            node,
            {
              nativePlaceholderBinding: {
                bring: brought,
                expected: {
                  identity: nodeIdentity(node),
                  documentRect: inputPlaceholderDocumentRect(node),
                  client: node.client,
                },
                live: liveNode
                  ? {
                      identity: nodeIdentity(liveNode),
                      documentRect: inputPlaceholderDocumentRect(liveNode),
                      client: liveNode.client,
                    }
                  : null,
              },
            },
          );
        }
        node.rect = liveNode.rect;
        node.client = liveNode.client;
        node.textRects = liveNode.textRects;
        geometry = {
          ...geometry,
          rect: node.rect,
          client: node.client,
          textRects: node.textRects,
        };
        const initial = await resolveInputPlaceholderNativeLayout({
          page,
          attemptToken,
          nodeIndex: node.index,
          roleId: role.id,
          pseudo,
          expectedNode: node,
        });
        const initialEvidence = inputPlaceholderNativeEvidence(initial, "initial");
        if (initial.status !== "resolved") {
          const reason = `input.placeholder 原生 UA 几何不可测：${initial.reason}`;
          geometry = { ...geometry, textRects: [], nativePlaceholder: initialEvidence };
          pushNodeUnmeasured(measurements, node, reason, { geometry });
          evidence.nodes.push({
            index: node.index,
            identity: nodeIdentity(node),
            geometry,
            nativePlaceholder: initialEvidence,
            rejectedReason: reason,
          });
          continue;
        }
        node.textRects = [initial.rect];
        geometry = { ...geometry, textRects: node.textRects, nativePlaceholder: initialEvidence };
        nativePlaceholderState = { baseline: initial, stages: [initialEvidence] };
        recordNativePlaceholderStage = async (phase, liveNode = node) => {
          const current = await resolveInputPlaceholderNativeLayout({
            page,
            attemptToken,
            nodeIndex: liveNode.index,
            roleId: role.id,
            pseudo,
            expectedNode: liveNode,
            expectedLayout: nativePlaceholderState.baseline.identity,
          });
          const stageEvidence = inputPlaceholderNativeEvidence(current, phase);
          nativePlaceholderState.stages.push(stageEvidence);
          if (current.status !== "resolved") {
            throw new MeasurementSampleInvalid(
              `input.placeholder 原生 UA ${phase} 阶段不可测：${current.reason}`,
              liveNode,
              { nativePlaceholder: stageEvidence },
            );
          }
          const failure = await inputPlaceholderNativeStageFailure(
            page,
            current,
            nativePlaceholderState.baseline,
            phase,
          );
          if (failure) {
            stageEvidence.failure = failure;
            throw new MeasurementSampleInvalid(`input.placeholder 原生 UA ${phase} 阶段失效：${failure}`, liveNode, {
              nativePlaceholder: stageEvidence,
            });
          }
          nativePlaceholderLiveNode = liveNode;
          return current;
        };
      }
      const opacity = Number.parseFloat(node.computed?.opacity);
      const needsOwnOpacityProof = !Number.isFinite(opacity) || opacity !== 1;
      const opacityProofFailure = needsOwnOpacityProof ? await ownOpacityTextProofFailure(page, node) : null;
      const blocker = isolationBlocker(node, needsOwnOpacityProof && opacityProofFailure === null);
      if (opacityProofFailure || blocker) {
        if (spotlightFixedViewport) await guardFixedViewport("before-png");
        const capture = await captureOriginal(role, runtime, selector);
        if (spotlightMetricFixedViewport) {
          spotlightMetricCaptureIndex = capture.index;
          await guardFixedViewport("after-png");
        } else if (spotlightTimelineFixedViewport) {
          spotlightTimelineCaptureIndex = capture.index;
          await guardFixedViewport("after-png");
        } else if (spotlightDetailRowFixedViewport) {
          if (Number.isInteger(capture.index)) spotlightDetailRowCaptureIndices.push(capture.index);
          await guardFixedViewport("after-png");
        } else if (spotlightDetailHeadingFixedViewport) {
          spotlightDetailHeadingCaptureIndex = capture.index;
          await guardFixedViewport("after-png");
        } else if (spotlightLanguageFixedViewport) {
          spotlightLanguageCaptureIndex = capture.index;
          await guardFixedViewport("after-png");
        }
        pushNodeUnmeasured(measurements, node, opacityProofFailure ?? blocker, {
          capture: capture.index,
          captureNote: capture.note,
        });
        continue;
      }
      if (node.textRects.length === 0) {
        const reason = node.textRectClipping?.unsupportedReason
          ? `文字裁切几何不受支持：${node.textRectClipping.unsupportedReason}`
          : node.rawTextRects?.length
            ? "文字矩形与轴向 overflow client 区没有正面积交集"
            : "无文本矩形（Range.getClientRects 为空）";
        pushNodeUnmeasured(measurements, node, reason, { geometry });
        continue;
      }
      // 伪元素选择器（如 input::placeholder）只在其真正生效的节点上量：没有
      // placeholder 或已有值的输入量的是正文色，混进来只会污染最差样本汇总。
      if (pseudo && node.usesPlaceholder !== true) {
        pushNodeUnmeasured(measurements, node, `${pseudo} 在该节点上未生效`, {
          hasValue: node.hasValue ?? null,
          hasPlaceholder: node.hasPlaceholder ?? null,
        });
        continue;
      }
      const usesPlaceholder = node.usesPlaceholder === true;
      const styleSource = usesPlaceholder ? node.pseudo : node.computed;
      const textFill = styleSource?.textFillColor;
      const colorValue = textFill && textFill !== "currentcolor" ? textFill : (styleSource?.color ?? null);
      if (!colorValue) {
        pushNodeUnmeasured(measurements, node, "读取不到文字颜色");
        continue;
      }
      const parsed = await parseColor(page, colorValue);
      if (!parsed.ok) {
        pushNodeUnmeasured(measurements, node, parsed.reason, { colorValue });
        continue;
      }
      let foreground = { rgb: parsed.rgb, alpha: parsed.alpha };
      const ownOpacity = Number.parseFloat(usesPlaceholder ? (node.pseudo?.opacity ?? "1") : node.computed.opacity);
      if (Number.isFinite(ownOpacity) && ownOpacity < 1) {
        // 元素/伪元素自身透明度只淡化自身绘制：折进前景 alpha（截图背景已含实际合成）
        foreground = { rgb: foreground.rgb, alpha: foreground.alpha * ownOpacity };
      }
      const hide = await page.evaluate(
        buildHideSource(
          selector,
          node.index,
          node.isSvg ? "svg" : "text",
          attemptToken,
          includeCostNoteLinkDecorationProof ? { roleId: role.id, stateId: recordContext.stateId } : null,
        ),
      );
      if (hide.identityInvalid) throw new MeasurementSampleInvalid(`隐藏前 ${hide.reason}`, node);
      const costNoteLinkBaselineProof = includeCostNoteLinkDecorationProof ? node.costNoteLinkDecorationProof : null;
      const costNoteLinkBaselineRange = includeCostNoteLinkDecorationProof
        ? costNoteLinkTextRangeSignature(node)
        : null;
      if (includeCostNoteLinkDecorationProof) {
        const failure = costNoteLinkDecorationFailure(
          { ...node, costNoteLinkDecorationProof: hide.costNoteLinkDecorationProof },
          costNoteLinkBaselineProof,
          costNoteLinkBaselineRange,
        );
        const decoration = hide.costNoteLinkDecoration;
        if (
          failure ||
          hide.identityId !== node.identityId ||
          decoration?.installed !== true ||
          decoration.computedTextDecorationLine !== "none" ||
          decoration.changed !== (costNoteLinkBaselineProof.chain[0].textDecorationLine === "underline")
        ) {
          throw new MeasurementSampleInvalid(`隐藏前费用链接装饰或身份核验失败${failure ? `：${failure}` : ""}`, node, {
            costNoteLinkDecorationProof: hide.costNoteLinkDecorationProof ?? null,
            costNoteLinkDecoration: decoration ?? null,
          });
        }
      }
      if (!hide.ok) {
        if (includeCostNoteLinkDecorationProof) {
          throw new MeasurementSampleInvalid("费用链接隐藏未通过验证", node);
        }
        pushNodeUnmeasured(measurements, node, hide.reason);
        continue;
      }
      if (toastFixedViewport) toastHiddenToken = hide.token;
      const decorationIsolation = hide.decorationIsolation;
      if (
        decorationIsolation &&
        (decorationIsolation.installed !== true ||
          decorationIsolation.hostStable !== true ||
          decorationIsolation.businessStateUnchanged === false)
      ) {
        const isolationRestore = await page.evaluate(buildRestoreSource(hide.token));
        const isolationVerify = await page.evaluate(buildVerifySource(hide.token));
        recordInlineRestoreDiagnostics(diagnostics, role, node, [
          ["装饰隔离失败后恢复", isolationRestore],
          ["装饰隔离失败后恢复核验", isolationVerify],
        ]);
        const reason =
          decorationIsolation.reason ??
          (decorationIsolation.installed !== true
            ? "装饰隔离未能安装"
            : decorationIsolation.hostStable !== true
              ? "装饰隔离改变了宿主几何或表面"
              : "search 隔离改变了输入值或焦点");
        pushNodeUnmeasured(measurements, node, `${reason}，不输出可信对比度`);
        continue;
      }
      if (hide.isolation && hide.isolation.isolated === false) {
        // 隐藏写完了，但树里仍有元素在画字（典型：子节点带自己的
        // -webkit-text-fill-color，覆盖了宿主的 transparent）。此时背景 PNG 里
        // 混着文字像素，比值必然趋近 1——这是**污染样本**，不是真实低对比。
        // 先把样式恢复回去，再记 unmeasured；不得记为 contrast fail。
        const isolationRestore = await page.evaluate(buildRestoreSource(hide.token));
        const isolationVerify = await page.evaluate(buildVerifySource(hide.token));
        recordInlineRestoreDiagnostics(diagnostics, role, node, [
          ["隔离失败后恢复", isolationRestore],
          ["隔离失败后恢复核验", isolationVerify],
        ]);
        measurements.push({
          unmeasured: `隐藏后仍检测到文字绘制（${hide.isolation.remaining.join("、")} 保留独立文字填充/阴影）：背景样本会混入文字像素，不记作真实对比`,
          node: node.index,
          identity: nodeIdentity(node),
        });
        continue;
      }
      if (nativePlaceholderState) await recordNativePlaceholderStage("after-hide", node);
      const nodeEvidence = {
        index: node.index,
        identity: nodeIdentity(node),
        ...(node.dynamicTextSnapshot ? { dynamicTextSnapshot: node.dynamicTextSnapshot } : {}),
        ...(includeOwnTextRanges ? { ownTextRangeProbe: node.ownTextRangeProbe } : {}),
        ...(node.ownOpacityTextProof ? { ownOpacityTextProof: node.ownOpacityTextProof } : {}),
        hasValue: node.hasValue ?? null,
        hasPlaceholder: node.hasPlaceholder ?? null,
        style: {
          opacity: node.computed.opacity,
          backgroundColor: node.computed.backgroundColor,
          backgroundImage: node.computed.backgroundImage,
        },
        pseudo: node.pseudo
          ? {
              color: node.pseudo.color,
              opacity: node.pseudo.opacity,
              fontSize: node.pseudo.fontSize,
              textFillColor: node.pseudo.textFillColor,
            }
          : null,
        geometry,
        decorationIsolation,
        ...(includeCostNoteLinkDecorationProof
          ? {
              costNoteLinkDecoration: {
                probe: node.costNoteLinkDecorationProof,
                hide: hide.costNoteLinkDecorationProof,
                hidden: hide.costNoteLinkDecoration,
              },
            }
          : {}),
        placeholder: usesPlaceholder,
        colorValue,
        parsed: { rgb: parsed.rgb, alpha: parsed.alpha, readBack: parsed.readBack },
        fontSize: node.computed.fontSize,
        fontWeight: node.computed.fontWeight,
        textRects: node.textRects.length,
        ...(nativePlaceholderState ? { nativePlaceholder: nativePlaceholderState } : {}),
        bands: [],
      };
      const measuredBands = [];
      const nativePlaceholderReadRects = async (live) => {
        const current = await recordNativePlaceholderStage("band-scroll", live);
        return [current.rect];
      };
      const currentNativePlaceholderLiveNode = async (phase) => {
        const liveProbe = await probeNodes(page, selector, null, { hiddenToken: hide.token });
        if (liveProbe.measurementIdentity?.valid === false) {
          throw new MeasurementSampleInvalid(
            `input.placeholder 原生 UA ${phase} 阶段重探时 ${liveProbe.measurementIdentity.reason}`,
            node,
          );
        }
        const live = liveProbe.nodes[node.index];
        if (!live || live.identityId !== node.identityId) {
          throw new MeasurementSampleInvalid(`input.placeholder 原生 UA ${phase} 阶段未找到原 input 节点`, node);
        }
        return live;
      };
      // 本节点的记账起点：晚期隔离失效时要整段撤掉，不能留下半个节点的样本
      const measurementMark = measurements.length;
      let sampleRejected = null;
      let occlusionRejected = false;
      let restored = null;
      let verify;
      let costNoteLinkRestoreFailure = null;
      let costNoteLinkVerifyFailure = null;
      let sampleFailed = false;
      let sampleError;
      try {
        await guardFixedViewport("after-hide");
        const bands = await collectVisibleRects(
          page,
          selector,
          node.index,
          viewport,
          nativePlaceholderState ? nativePlaceholderReadRects : (live) => live.textRects,
          hide.token,
          true,
          node,
          fixedViewport,
          fixedViewportLabel,
          toastFixedViewport ? attemptToken : null,
          includeOwnTextRanges,
          includeCostNoteLinkDecorationProof,
          costNoteLinkBaselineProof,
          costNoteLinkBaselineRange,
        );
        let regionSeq = 0;
        for (const band of bands) {
          const bandTextGeometry = {
            ...(Array.isArray(band.rawTextRects)
              ? {
                  ...(includeOwnTextRanges ? { ownTextRangeProbe: band.ownTextRangeProbe } : {}),
                  rawTextRects: band.rawTextRects,
                  textRectClipping: band.textRectClipping,
                }
              : {}),
            ...(includeCostNoteLinkDecorationProof
              ? { costNoteLinkDecorationProof: band.costNoteLinkDecorationProof }
              : {}),
          };
          const bandPointerProbe = band.pointerProbe ?? null;
          // D3b-R1：toast 的权威遮挡判定用 collect 里那次原生命中结果，紧邻
          // before-png 守卫消费（见下方）；此处保留普通探针路径的判定。
          const occlusionFailure = toastFixedViewport ? null : occlusionFailureReason(band);
          if (occlusionFailure) {
            const identity = `identityId=${node.identityId ?? "unknown"} ${node.tag ?? "unknown"}${node.id ? `#${node.id}` : ""}`;
            sampleRejected = `${identity}：${occlusionFailure}`;
            occlusionRejected = true;
            nodeEvidence.bands.push({
              scroll: band.scroll,
              sampleRects: band.rects,
              ...bandTextGeometry,
              occlusion: band.occlusion,
              ...(bandPointerProbe ? { pointerProbe: bandPointerProbe } : {}),
              rejected: occlusionFailure,
            });
            break;
          }
          const clip = unionRect(band.rects) ?? node.rect;
          const regions = band.rects.map((rect) => ({ id: `text-${node.index}-${regionSeq++}`, ...rect }));
          await guardFixedViewport("before-png");
          if (nativePlaceholderState) {
            await recordNativePlaceholderStage("before-png", nativePlaceholderLiveNode);
          }
          let prePngNative = null;
          if (toastFixedViewport) {
            // D3b-R1：collect 的原生命中结果就是 PNG 前唯一一次原生检查；
            // 紧邻 before-png 守卫消费，不再为同一件事重复建一次 CDP 会话。
            const prePngFailure = occlusionFailureReason(band);
            prePngNative = { ok: true, reason: null, result: band.occlusion, occlusion: prePngFailure };
            if (prePngFailure) {
              sampleRejected = `toast PNG 前原生检查：${prePngFailure}`;
              occlusionRejected = true;
              nodeEvidence.bands.push({
                scroll: band.scroll,
                sampleRects: band.rects,
                ...bandTextGeometry,
                occlusion: band.occlusion,
                pointerProbe: bandPointerProbe,
                nativeChecks: { prePng: prePngNative },
                rejected: sampleRejected,
              });
              break;
            }
          }
          const shot = await shoot(clip, "background", role.id, band.scroll);
          if (spotlightMetricFixedViewport) spotlightMetricCaptureIndex = shot.index;
          else if (spotlightTimelineFixedViewport) spotlightTimelineCaptureIndex = shot.index;
          else if (spotlightDetailRowFixedViewport) spotlightDetailRowCaptureIndices.push(shot.index);
          else if (spotlightDetailHeadingFixedViewport) spotlightDetailHeadingCaptureIndex = shot.index;
          else if (spotlightLanguageFixedViewport) spotlightLanguageCaptureIndex = shot.index;
          await guardFixedViewport("after-png");
          if (nativePlaceholderState) {
            await recordNativePlaceholderStage("after-png", nativePlaceholderLiveNode);
          }
          let postPngNative = null;
          if (toastFixedViewport) {
            try {
              postPngNative = await runToastNativeCheck(band);
            } catch (error) {
              // PNG 已产生：标记为失效部分证据保留；标记动作不得替换主错误传播。
              invalidateCapture(shot.index, "PNG 后原生检查异常");
              throw error;
            }
            if (postPngNative.occlusion) {
              const reason = postPngNative.occlusion;
              // 实际已产 PNG 保留并注明无效；该样本比值撤销。
              invalidateCapture(shot.index, reason);
              sampleRejected = `toast PNG 后原生检查：${reason}`;
              occlusionRejected = true;
              nodeEvidence.bands.push({
                scroll: band.scroll,
                clip,
                capture: shot.index,
                sampleRects: band.rects,
                ...bandTextGeometry,
                occlusion: band.occlusion,
                pointerProbe: bandPointerProbe,
                nativeChecks: { prePng: prePngNative, postPng: postPngNative },
                rejected: sampleRejected,
              });
              break;
            }
          }
          const scan = await page.evaluate(buildScanSource(shot.base64, regions, clipOf(clip), hide.token));
          await guardFixedViewport("after-scan");
          if (nativePlaceholderState) {
            await recordNativePlaceholderStage("after-scan", nativePlaceholderLiveNode);
          }
          if (scan?.identityValid === false) throw new MeasurementSampleInvalid(`像素扫描时 ${scan.reason}`, node);
          if (scan?.isolationValid === false) {
            // 解码后复核发现隐藏已经失效（同一对象在截图窗口里重新拿到文字填充）。
            // 这不是身份问题，不做身份重做；手上的 PNG 是污染样本，直接拒绝。
            sampleRejected = `像素扫描时 ${scan.isolationReason}`;
            if (nativePlaceholderState) {
              invalidateCapture(shot.index, sampleRejected, "invalidated-input-placeholder-native");
              nodeEvidence.bands.push({
                scroll: band.scroll,
                clip,
                capture: shot.index,
                sampleRects: band.rects,
                ...bandTextGeometry,
                rejected: sampleRejected,
              });
            }
            break;
          }
          const worst = scanWorst(scan, foreground, clipOf(clip), regions);
          measuredBands.push(band);
          nodeEvidence.bands.push({
            scroll: band.scroll,
            clip,
            scanScale: scan.scale,
            capture: shot.index,
            rects: band.rects.length,
            sampleRects: band.rects,
            ...bandTextGeometry,
            occlusion: band.occlusion,
            ...(bandPointerProbe ? { pointerProbe: bandPointerProbe } : {}),
            ...(toastFixedViewport ? { nativeChecks: { prePng: prePngNative, postPng: postPngNative } } : {}),
            worst,
          });
          if (worst)
            measurements.push({
              node: node.index,
              placeholder: usesPlaceholder,
              foreground,
              worst,
              capture: shot.index,
            });
          else pushNodeUnmeasured(measurements, node, "该带文本矩形内没有可取样的背景像素");
        }
        if (bands.length === 0) {
          pushNodeUnmeasured(measurements, node, "目标矩形没有完整落入视口的带（视口外内容需整页截图方案）");
        }
        // 恢复核验要在同一几何位置比对：回到第一带
        if (!fixedViewport && bands.length > 0) await page.evaluate(buildScrollToSource(bands[0].scroll));
        if (nativePlaceholderState) {
          nativePlaceholderLiveNode = await currentNativePlaceholderLiveNode("restore");
        }
      } catch (error) {
        sampleFailed = true;
        sampleError = error;
      }
      try {
        restored = await page.evaluate(buildRestoreSource(hide.token));
        if (includeCostNoteLinkDecorationProof) {
          const diagnosticCount = diagnostics.restoration.inlineRestoreFailures.length;
          recordInlineRestoreDiagnostics(diagnostics, role, node, [["恢复", restored]]);
          if (restored?.identityValid === false) {
            diagnostics.restoration.inlineRestoreFailures.push(`${role.id}#${node.index}: 恢复时链接身份失效`);
            costNoteLinkRestoreFailure = new MeasurementSampleInvalid(`恢复时 ${restored.reason}`, node);
          }
          if (
            !costNoteLinkRestoreFailure &&
            (restored?.ok !== true ||
              restored.inlineRestored !== true ||
              restored.decorationRestored !== true ||
              restored.restoreErrors?.length > 0)
          ) {
            if (diagnostics.restoration.inlineRestoreFailures.length === diagnosticCount) {
              diagnostics.restoration.inlineRestoreFailures.push(`${role.id}#${node.index}: 链接样式恢复未能核实`);
            }
            costNoteLinkRestoreFailure = new Error("费用链接样式恢复未完成");
          }
        }
        if (
          fixedViewport &&
          (restored?.ok !== true ||
            restored.identityValid === false ||
            restored.inlineRestored === false ||
            restored.decorationRestored === false ||
            restored.restoreErrors?.length > 0)
        ) {
          throw new Error(`${fixedViewportLabel}：样式恢复未完成`);
        }
        if (
          nativePlaceholderState &&
          (restored?.ok !== true ||
            restored.identityValid === false ||
            restored.inlineRestored !== true ||
            restored.restoreErrors?.length > 0)
        ) {
          throw new MeasurementSampleInvalid("input.placeholder 原生 UA：样式恢复未完成", node, {
            nativePlaceholder: nativePlaceholderState.stages.at(-1) ?? null,
            restore: restored,
          });
        }
        if (nativePlaceholderState) {
          await recordNativePlaceholderStage("restore", nativePlaceholderLiveNode);
        }
        await guardFixedViewport("after-style-restore");
      } catch (error) {
        if (includeCostNoteLinkDecorationProof) {
          costNoteLinkRestoreFailure = error;
        } else {
          if (nativePlaceholderState) {
            if (!sampleFailed) throw error;
            throw new AggregateError(
              [sampleError, error],
              `input.placeholder 原生 UA：采样和样式恢复均失败；原始错误：${String(sampleError?.message ?? sampleError)}`,
              { cause: sampleError },
            );
          }
          if (!fixedViewport || !sampleFailed) throw error;
          throw new AggregateError(
            [sampleError, error],
            `${fixedViewportLabel}：采样和样式恢复均失败；原始错误：${String(sampleError?.message ?? sampleError)}`,
            {
              cause: sampleError,
            },
          );
        }
      }
      if (sampleFailed && !includeCostNoteLinkDecorationProof) throw sampleError;
      if (restored?.identityValid === false && !includeCostNoteLinkDecorationProof) {
        throw new MeasurementSampleInvalid(`恢复时 ${restored.reason}`, node);
      }
      try {
        if (nativePlaceholderState) {
          nativePlaceholderLiveNode = await currentNativePlaceholderLiveNode("verify");
        }
        verify = await page.evaluate(buildVerifySource(hide.token));
        if (includeCostNoteLinkDecorationProof) {
          const diagnosticCount = diagnostics.restoration.inlineRestoreFailures.length;
          recordInlineRestoreDiagnostics(diagnostics, role, node, [["恢复核验", verify]]);
          if (verify?.identityValid === false) {
            diagnostics.restoration.inlineRestoreFailures.push(`${role.id}#${node.index}: 恢复核验时链接身份失效`);
            costNoteLinkVerifyFailure = new MeasurementSampleInvalid(`恢复核验时 ${verify.reason}`, node);
          }
          if (
            !costNoteLinkVerifyFailure &&
            (verify?.ok !== true ||
              verify.inlineRestored !== true ||
              verify.decorationRestored !== true ||
              verify.restoreErrors?.length > 0)
          ) {
            if (diagnostics.restoration.inlineRestoreFailures.length === diagnosticCount) {
              diagnostics.restoration.inlineRestoreFailures.push(`${role.id}#${node.index}: 链接恢复核验未能确认`);
            }
            costNoteLinkVerifyFailure = new Error("费用链接样式恢复核验未完成");
          }
        }
        await guardFixedViewport("after-verify");
        if (
          fixedViewport &&
          (verify?.ok !== true ||
            verify.identityValid === false ||
            verify.inlineRestored === false ||
            verify.decorationRestored === false ||
            verify.restoreErrors?.length > 0)
        ) {
          throw new Error(`${fixedViewportLabel}：样式恢复核验未完成`);
        }
        if (verify.identityValid === false && !includeCostNoteLinkDecorationProof) {
          throw new MeasurementSampleInvalid(`恢复核验时 ${verify.reason}`, node);
        }
        if (
          nativePlaceholderState &&
          (verify?.ok !== true ||
            verify.identityValid === false ||
            verify.inlineRestored !== true ||
            verify.restoreErrors?.length > 0)
        ) {
          throw new MeasurementSampleInvalid("input.placeholder 原生 UA：样式恢复核验未完成", node, {
            nativePlaceholder: nativePlaceholderState.stages.at(-1) ?? null,
            verify,
          });
        }
        if (nativePlaceholderState) {
          await recordNativePlaceholderStage("verify", nativePlaceholderLiveNode);
        }
      } catch (error) {
        if (includeCostNoteLinkDecorationProof) {
          costNoteLinkVerifyFailure = error;
        } else {
          if (nativePlaceholderState) {
            if (!sampleFailed) throw error;
            throw new AggregateError(
              [sampleError, error],
              `input.placeholder 原生 UA：采样和恢复核验均失败；原始错误：${String(sampleError?.message ?? sampleError)}`,
              { cause: sampleError },
            );
          }
          if (!sampleFailed) throw error;
          throw new AggregateError(
            [sampleError, error],
            `${fixedViewportLabel}：采样和恢复核验均失败；原始错误：${String(sampleError?.message ?? sampleError)}`,
            {
              cause: sampleError,
            },
          );
        }
      }
      if (includeCostNoteLinkDecorationProof && (costNoteLinkRestoreFailure || costNoteLinkVerifyFailure)) {
        const failures = [costNoteLinkRestoreFailure, costNoteLinkVerifyFailure].filter(Boolean);
        if (sampleFailed) failures.unshift(sampleError);
        if (failures.length === 1) throw failures[0];
        throw new AggregateError(failures, "费用链接：恢复或核验未完成", { cause: sampleError ?? failures[0] });
      }
      recordInlineRestoreDiagnostics(diagnostics, role, node, [
        ["恢复", restored],
        ["恢复核验", verify],
      ]);
      if (sampleFailed) throw sampleError;
      if (sampleRejected) {
        // 恢复/核验/释放都已照常走完，只是这个节点的样本不能用。这里必须把本轮为它记下
        // 的条目**全部撤掉**：assembleRoleRecord 先看"有没有低于阈值的已测样本"、再看
        // "有没有未测样本"，只留前半段的带会让这个没测完的节点直接判成 contrast fail。
        // 宁可记 unmeasured，也不给"测了一半"的失败结论。
        if (nativePlaceholderState) {
          for (const band of nodeEvidence.bands) {
            if (Number.isInteger(band.capture)) {
              invalidateCapture(band.capture, sampleRejected, "invalidated-input-placeholder-native");
            }
          }
        }
        const droppedBands = measurements.length - measurementMark;
        measurements.length = measurementMark;
        measurements.push({
          unmeasured: occlusionRejected
            ? `${sampleRejected}；撤销该节点此前 ${droppedBands} 个 band 的结果，不输出对比度结论`
            : `${sampleRejected}：拒绝该污染样本，本轮该节点已记的 ${droppedBands} 个带样本一并作废（同一次尝试内隔离已被证明不稳定，无法逐带归因），不记作真实对比`,
          node: node.index,
          identity: nodeIdentity(node),
        });
        if (occlusionRejected || nativePlaceholderState) {
          for (const band of nodeEvidence.bands) delete band.worst;
          nodeEvidence.rejectedReason = sampleRejected;
          evidence.nodes.push(nodeEvidence);
        }
        continue;
      }
      // 几何基准取第一带的实时矩形（滚动后 rect 会变，初始探测值已不可比）
      const geometryBefore = measuredBands.length > 0 ? measuredBands[0].rect : node.rect;
      const differences = splitSnapshotDifferences(
        {
          color: node.computed.color,
          textFillColor: node.computed.textFillColor,
          textShadow: node.computed.textShadow,
          backgroundColor: node.computed.backgroundColor,
          opacity: node.computed.opacity,
          rect: geometryBefore,
        },
        verify.after,
      );
      recordRestorationDiagnostics(diagnostics, role, node, differences);
      evidence.nodes.push(nodeEvidence);
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
    if (nativePlaceholderRoute) invalidateNativePlaceholderCaptures(formatTextPathError(error));
    if (spotlightTimelineCaptureIndex !== null) {
      invalidateCapture(
        spotlightTimelineCaptureIndex,
        formatTextPathError(error),
        "invalidated-spotlight-timeline-heading-state",
      );
    }
    if (spotlightDetailRowFixedViewport) {
      for (const index of spotlightDetailRowCaptureIndices) {
        invalidateCapture(index, formatTextPathError(error), "invalidated-spotlight-detail-row-state");
      }
    } else if (spotlightDetailHeadingCaptureIndex !== null) {
      invalidateCapture(
        spotlightDetailHeadingCaptureIndex,
        formatTextPathError(error),
        "invalidated-spotlight-detail-heading-state",
      );
    }
    if (spotlightLanguageCaptureIndex !== null) {
      invalidateCapture(
        spotlightLanguageCaptureIndex,
        formatTextPathError(error),
        "invalidated-spotlight-language-state",
      );
    }
  }
  {
    const cleanupErrors = [];
    const scrollDifferencesBefore = diagnostics.restoration.scrollDifferences.length;
    const scrollError = await restoreScrollSession(page, diagnostics, role.id, "文字路径");
    if ((fixedViewport || includeCostNoteLinkDecorationProof || nativePlaceholderRoute) && scrollError) {
      cleanupErrors.push(scrollError);
    }
    if (
      (fixedViewport || includeCostNoteLinkDecorationProof || nativePlaceholderRoute) &&
      !scrollError &&
      diagnostics.restoration.scrollDifferences.length > scrollDifferencesBefore
    ) {
      cleanupErrors.push(
        new Error(`${nativePlaceholderRoute ? "input.placeholder 原生 UA" : fixedViewportLabel}：滚动恢复未完成`),
      );
    }
    try {
      if (spotlightDetailRowFixedViewport) {
        for (const node of probe.nodes) {
          spotlightDetailRowNode = node;
          await guardFixedViewport("after-scroll-restore");
        }
      } else {
        await guardFixedViewport("after-scroll-restore");
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      const released = await releaseAttempt(page, diagnostics, role.id, attemptToken);
      if (nativePlaceholderRoute && released?.ok !== true) {
        cleanupErrors.push(new Error("input.placeholder 原生 UA：尝试释放未完成"));
      } else if ((fixedViewport || includeCostNoteLinkDecorationProof) && released?.ok === false) {
        cleanupErrors.push(
          new Error(
            includeCostNoteLinkDecorationProof ? "费用链接：尝试释放未完成" : `${fixedViewportLabel}：尝试释放未完成`,
          ),
        );
      }
    } catch (error) {
      if (!fixedViewport && !includeCostNoteLinkDecorationProof && !nativePlaceholderRoute) throw error;
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      if (nativePlaceholderRoute) {
        invalidateNativePlaceholderCaptures(cleanupErrors.map(formatTextPathError).join("；"));
      }
      if (spotlightTimelineCaptureIndex !== null) {
        invalidateCapture(
          spotlightTimelineCaptureIndex,
          cleanupErrors.map(formatTextPathError).join("；"),
          "invalidated-spotlight-timeline-heading-state",
        );
      }
      if (spotlightDetailRowFixedViewport) {
        for (const index of spotlightDetailRowCaptureIndices) {
          invalidateCapture(
            index,
            cleanupErrors.map(formatTextPathError).join("；"),
            "invalidated-spotlight-detail-row-state",
          );
        }
      } else if (spotlightDetailHeadingCaptureIndex !== null) {
        invalidateCapture(
          spotlightDetailHeadingCaptureIndex,
          cleanupErrors.map(formatTextPathError).join("；"),
          "invalidated-spotlight-detail-heading-state",
        );
      }
      if (spotlightLanguageCaptureIndex !== null) {
        invalidateCapture(
          spotlightLanguageCaptureIndex,
          cleanupErrors.map(formatTextPathError).join("；"),
          "invalidated-spotlight-language-state",
        );
      }
      const operationFailureDetail = operationFailed ? `；原始错误：${formatTextPathError(operationError)}` : "";
      const failureLabel = includeCostNoteLinkDecorationProof
        ? "费用链接"
        : nativePlaceholderRoute
          ? "input.placeholder 原生 UA"
          : fixedViewportLabel;
      throw new AggregateError(
        operationFailed ? [operationError, ...cleanupErrors] : cleanupErrors,
        `${failureLabel}：测量收尾失败${operationFailureDetail}`,
        operationFailed ? { cause: operationError } : undefined,
      );
    }
  }
  if (operationFailed) throw operationError;
  return assembleRoleRecord(role, recordContext, measurements, evidence, METHOD_TEXT);
}

async function measurePaintedSurfaceRole(role, runtime, recordContext, selector) {
  return withOneIdentityRetry(role, runtime, recordContext, selector, () =>
    measurePaintedSurfaceRoleAttempt(role, runtime, recordContext, selector),
  );
}

async function measurePaintedSurfaceRoleAttempt(role, runtime, recordContext, selector) {
  const { page, shoot, diagnostics, viewport } = runtime;
  const probe = await probeNodes(page, selector, null, { trackIdentities: true });
  if (probe.error) {
    return unmeasuredRecord(role, recordContext, METHOD_UNMEASURED, probe.error, { selector });
  }
  if (probe.nodes.length === 0) {
    return unmeasuredRecord(role, recordContext, METHOD_UNMEASURED, `状态内未找到选择器匹配：${selector}`, {
      selector,
    });
  }
  // 与文字路径同一口径：本次尝试的固定基准 = 上面这次探测命中的有序对象集合
  const attemptToken = probe.attemptToken;
  const measurements = [];
  const evidence = { kind: METHOD_SURFACE, selector, nodes: [] };
  const badgeCoreOnly = role.id === "badge.record";
  const badgeGeometryFailure = (live) => {
    const { rect, client } = live ?? {};
    if (
      !rect ||
      !client ||
      ![rect.x, rect.y, rect.width, rect.height, client.left, client.top, client.width, client.height].every(
        Number.isFinite,
      )
    ) {
      return "badge.record 核心采样坐标无效（仅支持有限坐标的 7×7 无边框圆点）";
    }
    if (client.width !== 7 || client.height !== 7 || client.left !== 0 || client.top !== 0) {
      return "badge.record 内容框不符合预期的 7×7 无边框几何";
    }
    if (Math.abs(rect.width - 7) > 1e-6 || Math.abs(rect.height - 7) > 1e-6) {
      return "badge.record 外框不符合预期的 7×7 几何（允许误差 1e-6 CSS px）";
    }
    return null;
  };
  await page.evaluate(buildBeginScrollSessionSource());
  try {
    for (const node of probe.nodes) {
      // 未渲染节点没有可测像素：单独记账，不参与覆盖判定，但原因必须留下
      const notRenderedReason =
        node.computed.display === "none"
          ? "元素 display:none（未渲染，没有可测像素）"
          : node.computed.visibility === "hidden"
            ? "元素 visibility:hidden（未渲染，没有可测像素）"
            : node.client.width <= 0 || node.client.height <= 0
              ? "元素内容框尺寸为 0（未渲染，没有可测像素）"
              : null;
      if (notRenderedReason) {
        measurements.push({ notRendered: notRenderedReason, node: node.index });
        continue;
      }
      if (badgeCoreOnly) {
        const geometryFailure = badgeGeometryFailure(node);
        if (geometryFailure) {
          measurements.push({ unmeasured: geometryFailure, node: node.index });
          evidence.nodes.push({
            index: node.index,
            geometry: { rect: node.rect, client: node.client },
            bands: [],
            rejectedReason: geometryFailure,
          });
          continue;
        }
      }
      const blocker = isolationBlocker(node);
      if (blocker) {
        const capture = await captureOriginal(role, runtime, selector);
        measurements.push({ unmeasured: blocker, capture: capture.index, captureNote: capture.note });
        continue;
      }
      if (node.computed.backgroundImage && node.computed.backgroundImage !== "none") {
        measurements.push({ unmeasured: "自身填充是渐变/图像而非平涂色：需逐像素处理，本卡不覆盖" });
        continue;
      }
      const parsed = await parseColor(page, node.computed.backgroundColor);
      if (!parsed.ok) {
        measurements.push({ unmeasured: parsed.reason, colorValue: node.computed.backgroundColor });
        continue;
      }
      // shortcut: 仅支持当前固定 7×7 badge.record；样式尺寸或变换改变时需重新校准。
      // 普通 surface 取样内容框；badge.record 仅取中央 3×3 核心。
      let unsupportedGeometryReason = null;
      const clientBoxes = (live) => {
        if (!badgeCoreOnly) {
          return [
            {
              x: live.rect.x + live.client.left,
              y: live.rect.y + live.client.top,
              width: live.client.width,
              height: live.client.height,
            },
          ];
        }
        unsupportedGeometryReason = badgeGeometryFailure(live);
        if (unsupportedGeometryReason) return [];
        return [
          {
            x: live.rect.x + (live.rect.width - 3) / 2,
            y: live.rect.y + (live.rect.height - 3) / 2,
            width: 3,
            height: 3,
          },
        ];
      };
      const hide = await page.evaluate(buildHideSource(selector, node.index, "surface", attemptToken));
      if (hide.identityInvalid) throw new MeasurementSampleInvalid(`隐藏前 ${hide.reason}`, node);
      if (!hide.ok) {
        measurements.push({ unmeasured: hide.reason });
        continue;
      }
      if (hide.isolation && hide.isolation.isolated === false) {
        // 自身填充或光晕没被清干净：背景 PNG 仍含有前景像素，不能当真实背景。
        // 与文字路径同口径——污染样本记 unmeasured，不记 contrast fail。
        const isolationRestore = await page.evaluate(buildRestoreSource(hide.token));
        const isolationVerify = await page.evaluate(buildVerifySource(hide.token));
        recordInlineRestoreDiagnostics(diagnostics, role, node, [
          ["隔离失败后恢复", isolationRestore],
          ["隔离失败后恢复核验", isolationVerify],
        ]);
        measurements.push({
          unmeasured: `隐藏后自身填充仍未清空（${hide.isolation.remaining.join("、")}）：背景样本会混入元素自身填充或光晕，不记作真实对比`,
          node: node.index,
        });
        continue;
      }
      const nodeEvidence = {
        index: node.index,
        fill: node.computed.backgroundColor,
        ...(badgeCoreOnly ? { geometry: { rect: node.rect, client: node.client } } : {}),
        parsed: { rgb: parsed.rgb, alpha: parsed.alpha, readBack: parsed.readBack },
        bands: [],
      };
      const measuredBands = [];
      const foreground = { rgb: parsed.rgb, alpha: parsed.alpha };
      // 本节点的记账起点：晚期隔离失效时要整段撤掉，不能留下半个节点的样本
      const measurementMark = measurements.length;
      let sampleRejected = null;
      let restored = null;
      try {
        const bands = await collectVisibleRects(
          page,
          selector,
          node.index,
          viewport,
          clientBoxes,
          hide.token,
          badgeCoreOnly,
          node,
        );
        let regionSeq = 0;
        for (const band of bands) {
          if (badgeCoreOnly) {
            const failure = occlusionFailureReason(band);
            if (failure) {
              const identity = `identityId=${node.identityId ?? "unknown"} ${node.tag ?? "unknown"}${node.id ? `#${node.id}` : ""}`;
              sampleRejected = `${identity}：${failure}`;
              nodeEvidence.bands.push({
                scroll: band.scroll,
                sampleRects: band.rects,
                occlusion: band.occlusion,
                rejected: failure,
              });
              break;
            }
          }
          const clip = band.rects[0];
          const regions = [{ id: `surface-${node.index}-${regionSeq++}`, ...clip }];
          const shot = await shoot(clip, "background", role.id, band.scroll);
          const scan = await page.evaluate(buildScanSource(shot.base64, regions, clipOf(clip), hide.token));
          if (scan.identityValid === false) throw new MeasurementSampleInvalid(`像素扫描时 ${scan.reason}`, node);
          if (scan.isolationValid === false) {
            // 解码后复核发现自身填充或光晕又被写回来：同一对象不做身份重做，
            // 直接拒绝这张污染样本。
            sampleRejected = `像素扫描时 ${scan.isolationReason}`;
            if (badgeCoreOnly) {
              nodeEvidence.bands.push({
                scroll: band.scroll,
                clip,
                capture: shot.index,
                sampleRects: band.rects,
                occlusion: band.occlusion,
                rejected: sampleRejected,
              });
            }
            break;
          }
          const scanned = badgeCoreOnly
            ? Array.isArray(scan?.regions)
              ? scan.regions.find((region) => region?.id === regions[0].id)
              : null
            : null;
          const pixelChannelCount = Array.isArray(scanned?.pixels) ? scanned.pixels.length : 0;
          if (
            badgeCoreOnly &&
            (!Number.isInteger(scanned?.columns) ||
              scanned.columns < 2 ||
              !Number.isInteger(scanned?.rows) ||
              scanned.rows < 2 ||
              pixelChannelCount === 0 ||
              pixelChannelCount !== scanned.columns * scanned.rows * 4 ||
              !scanned.pixels.every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255) ||
              !Number.isFinite(scan?.scale?.x) ||
              scan.scale.x <= 0 ||
              !Number.isFinite(scan?.scale?.y) ||
              scan.scale.y <= 0 ||
              !Number.isInteger(scanned.origin?.x) ||
              !Number.isInteger(scanned.origin?.y))
          ) {
            sampleRejected = `badge.record 中央 3×3 核心像素不足或扫描数据无效（${scanned?.columns ?? 0}×${scanned?.rows ?? 0}，${pixelChannelCount} 个通道值）`;
            nodeEvidence.bands.push({
              scroll: band.scroll,
              clip,
              scanScale: scan?.scale ?? null,
              capture: shot.index,
              sampleRects: band.rects,
              occlusion: band.occlusion,
              scan: {
                columns: scanned?.columns ?? 0,
                rows: scanned?.rows ?? 0,
                pixelCount: pixelChannelCount / 4,
                channelCount: pixelChannelCount,
              },
              rejected: sampleRejected,
            });
            break;
          }
          const worst = scanWorst(scan, foreground, clipOf(clip), regions);
          measuredBands.push(band);
          nodeEvidence.bands.push({
            scroll: band.scroll,
            clip,
            scanScale: scan.scale,
            capture: shot.index,
            ...(badgeCoreOnly
              ? {
                  sampleRects: band.rects,
                  occlusion: band.occlusion,
                  scan: {
                    columns: scanned.columns,
                    rows: scanned.rows,
                    pixelCount: pixelChannelCount / 4,
                    channelCount: pixelChannelCount,
                    origin: scanned.origin,
                  },
                }
              : {}),
            worst,
          });
          if (worst) measurements.push({ node: node.index, foreground, worst, capture: shot.index });
          else measurements.push({ unmeasured: "该带自身填充区内没有可取样的背景像素", node: node.index });
        }
        if (bands.length === 0) {
          if (unsupportedGeometryReason) sampleRejected = unsupportedGeometryReason;
          else
            measurements.push({
              unmeasured: badgeCoreOnly
                ? "badge.record 中央 3×3 核心没有完整落入视口的带"
                : "自身填充区没有完整落入视口的带（视口外内容需整页截图方案）",
              node: node.index,
            });
        }
        if (bands.length > 0) await page.evaluate(buildScrollToSource(bands[0].scroll));
      } finally {
        restored = await page.evaluate(buildRestoreSource(hide.token));
      }
      if (restored?.identityValid === false) throw new MeasurementSampleInvalid(`恢复时 ${restored.reason}`, node);
      const verify = await page.evaluate(buildVerifySource(hide.token));
      if (verify.identityValid === false) throw new MeasurementSampleInvalid(`恢复核验时 ${verify.reason}`, node);
      recordInlineRestoreDiagnostics(diagnostics, role, node, [
        ["恢复", restored],
        ["恢复核验", verify],
      ]);
      if (sampleRejected) {
        // 同文字路径：必须把本轮为这个节点记下的条目全部撤掉，否则一个"测了一半"的
        // 节点会因为前半段的带低于阈值而被 assembleRoleRecord 判成 contrast fail。
        const droppedBands = measurements.length - measurementMark;
        measurements.length = measurementMark;
        measurements.push({
          unmeasured: badgeCoreOnly
            ? `${sampleRejected}：拒绝该节点核心样本并撤销此前 ${droppedBands} 个带结果，不输出对比度结论`
            : `${sampleRejected}：拒绝该污染样本，本轮该节点已记的 ${droppedBands} 个带样本一并作废（同一次尝试内隔离已被证明不稳定，无法逐带归因），不记作真实对比`,
          node: node.index,
          ...(badgeCoreOnly ? { identity: nodeIdentity(node) } : {}),
        });
        if (badgeCoreOnly) {
          for (const band of nodeEvidence.bands) delete band.worst;
          nodeEvidence.rejectedReason = sampleRejected;
          evidence.nodes.push(nodeEvidence);
        }
        continue;
      }
      const geometryBefore = measuredBands.length > 0 ? measuredBands[0].rect : node.rect;
      const differences = splitSnapshotDifferences(
        {
          color: node.computed.color,
          backgroundColor: node.computed.backgroundColor,
          opacity: node.computed.opacity,
          rect: geometryBefore,
        },
        verify.after,
      );
      recordRestorationDiagnostics(diagnostics, role, node, differences);
      evidence.nodes.push(nodeEvidence);
    }
  } finally {
    await restoreScrollSession(page, diagnostics, role.id, "喷涂表面路径");
    await releaseAttempt(page, diagnostics, role.id, attemptToken);
  }
  return assembleRoleRecord(role, recordContext, measurements, evidence, METHOD_SURFACE);
}

function hasAxisLineIdentity(record) {
  const chartDraw = record.chartDraw;
  if (
    record.method !== "stroke" ||
    record.chartDrawInvalidReason != null ||
    !chartDraw ||
    typeof chartDraw !== "object" ||
    Array.isArray(chartDraw) ||
    !Object.hasOwn(chartDraw, "roleId") ||
    chartDraw.roleId !== "chart.axis-line" ||
    !Object.hasOwn(chartDraw, "points")
  ) {
    return false;
  }
  const points = chartDraw.points;
  if (!Array.isArray(points) || points.length !== 3) return false;
  for (let index = 0; index < 3; index += 1) {
    const point = points[index];
    if (!Array.isArray(point) || point.length !== 2) return false;
    const x = point[0];
    const y = point[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  }
  return true;
}

function axisLineBandRegions(record, canvasScale, clip, bitmap) {
  const transform = record.transform;
  const transformKeys = ["a", "b", "c", "d", "e", "f"];
  if (
    !bitmap ||
    typeof bitmap !== "object" ||
    !transform ||
    typeof transform !== "object" ||
    Array.isArray(transform) ||
    !transformKeys.every((key) => Object.hasOwn(transform, key) && Number.isFinite(transform[key])) ||
    transform.b !== 0 ||
    transform.c !== 0 ||
    transform.a <= 0 ||
    transform.a !== transform.d ||
    !Number.isFinite(record.lineWidth) ||
    record.lineWidth <= 0 ||
    !Number.isFinite(canvasScale.x) ||
    !Number.isFinite(canvasScale.y) ||
    canvasScale.x <= 0 ||
    canvasScale.y <= 0 ||
    !Number.isFinite(clip?.x) ||
    !Number.isFinite(clip?.y) ||
    !Number.isFinite(bitmap.width) ||
    !Number.isFinite(bitmap.height) ||
    bitmap.width <= 0 ||
    bitmap.height <= 0
  ) {
    return null;
  }
  const [p0, p1, p2] = record.chartDraw.points;
  if (p0[0] !== p1[0] || p1[1] !== p2[1] || p1[1] <= p0[1] || p2[0] <= p1[0]) return null;

  const points = [p0, p1, p2].map(([x, y]) => ({
    x: transform.a * x + transform.e,
    y: transform.d * y + transform.f,
  }));
  const [start, corner, end] = points;
  const strokeWidth = record.lineWidth * transform.a;
  const halfWidth = strokeWidth / 2;
  if (![...points.flatMap(({ x, y }) => [x, y]), strokeWidth].every(Number.isFinite) || strokeWidth <= 0) {
    return null;
  }

  const bitmapRects = [
    {
      part: "vertical",
      x: start.x - halfWidth,
      y: start.y - halfWidth,
      width: strokeWidth,
      height: corner.y - start.y + strokeWidth,
    },
    {
      part: "horizontal",
      x: corner.x - halfWidth,
      y: corner.y - halfWidth,
      width: end.x - corner.x + strokeWidth,
      height: strokeWidth,
    },
  ];
  if (
    bitmapRects.some(
      ({ x, y, width, height }) =>
        ![x, y, width, height].every(Number.isFinite) ||
        x < 0 ||
        y < 0 ||
        width <= 0 ||
        height <= 0 ||
        x + width > bitmap.width ||
        y + height > bitmap.height,
    )
  ) {
    return null;
  }

  return bitmapRects.map(({ part, x, y, width, height }) => ({
    part,
    x: clip.x + x * canvasScale.x,
    y: clip.y + y * canvasScale.y,
    width: width * canvasScale.x,
    height: height * canvasScale.y,
  }));
}

async function measureCanvasRole(role, runtime, recordContext, selector) {
  const { page, shoot, diagnostics, notes, viewport } = runtime;
  await page.evaluate(buildBeginScrollSessionSource());
  const stash = await page.evaluate(buildCanvasStashSource(selector));
  if (!stash.ok) {
    await restoreScrollSession(page, diagnostics, role.id, "画布路径");
    return unmeasuredRecord(role, recordContext, METHOD_UNMEASURED, stash.reason, { selector });
  }
  // 画布截图同样用视口坐标：先把画布滚进视口，再读它的实时CSS 盒
  await page.evaluate(buildBringIntoViewSource(selector, 0));
  const live = await page.evaluate(buildCanvasStashSource(selector));
  const cssRect = live.ok && live.cssRect ? live.cssRect : stash.cssRect;
  const clip = live.ok
    ? {
        x: live.cssRect.x,
        y: live.cssRect.y,
        width: live.cssRect.width,
        height: live.cssRect.height,
      }
    : null;
  // 观察记录里的坐标是 drawing buffer 像素（canvas.width/height），取样区域与
  // 截图都是 CSS 像素；两者尺寸通常不同（devicePixelRatio > 1 时 buffer 是 CSS
  // 盒的 dpr 倍）。不换算就会在 DPR=2 下把 CSS 30px 处的文字记成 60px，
  // 取样落到错误区域。
  const bitmapWidth = stash.bitmap?.width ?? 0;
  const bitmapHeight = stash.bitmap?.height ?? 0;
  const canvasScale = {
    x: bitmapWidth > 0 && cssRect?.width > 0 ? cssRect.width / bitmapWidth : 0,
    y: bitmapHeight > 0 && cssRect?.height > 0 ? cssRect.height / bitmapHeight : 0,
  };
  const evidence = {
    kind: METHOD_CANVAS,
    selector,
    canvasId: (live.ok ? live.canvasId : null) ?? stash.canvasId,
    drawFrame: live.ok ? live.frame : stash.frame,
    bitmap: stash.bitmap,
    cssRect,
    canvasScale,
    dpr: stash.dpr,
    clip,
    scroll: live.ok ? live.scroll : stash.scroll,
    rebuiltBaseLayers: null,
    capture: null,
    draws: [],
    skipped: [],
  };
  if (canvasScale.x <= 0 || canvasScale.y <= 0) {
    await restoreScrollSession(page, diagnostics, role.id, "画布路径");
    return unmeasuredRecord(
      role,
      recordContext,
      METHOD_UNMEASURED,
      "画布 CSS 尺寸或 bitmap 尺寸为 0，绘制坐标无法换算成 CSS 坐标",
      evidence,
    );
  }
  // 绘制按角色类型分类：文字角色只测文字、图形角色只测图形（堆叠段）。轴文字与
  // 堆叠段共用同一份观察记录，不分类就会让文字角色把底色层 fillRect、图形角色把
  // fillText 也当成自己的测量，制造出假的覆盖率与达标结论。
  const records = live.ok ? live.records : stash.records;
  const currentFrame = live.ok ? live.frame : stash.frame;
  const isTextRole = role.kind === "text";
  const drawRegions = [];
  // 属于本角色却测不动的绘制（混合合成、缺坐标、路径型 stroke/fill）和已测绘制
  // 一样进汇总：只写进 evidence.skipped 的话，"一个可测 fillRect + 一个不可测
  // stroke"仍会判 pass，用局部覆盖冒充完整覆盖。其他角色的绘制与已确认的应用
  // 自绘底色层不计缺口（countsAsMissing = false）。
  const measurements = [];
  const skipDraw = (record, reason, countsAsMissing) => {
    evidence.skipped.push({
      method: record.method,
      text: record.text ?? null,
      reason,
      eventSequence: record.eventSequence ?? null,
      frame: record.frame ?? null,
      canvasId: record.canvasId ?? null,
      strokeStyle: record.strokeStyle ?? null,
      lineWidth: record.lineWidth ?? null,
      alpha: record.alpha ?? null,
      composite: record.composite ?? null,
      transform: record.transform ?? null,
      ...(record.chartDraw == null ? {} : { chartDraw: record.chartDraw }),
      ...(record.chartDrawInvalidReason == null ? {} : { chartDrawInvalidReason: record.chartDrawInvalidReason }),
      ...(record.observationError == null ? {} : { observationError: record.observationError }),
    });
    if (countsAsMissing) {
      measurements.push({ unmeasured: reason, method: record.method, text: record.text ?? null });
    }
  };
  if (records.length === 0) {
    // 当前帧一条绘制都没有：画布被清空或尺寸重置后没有重绘。旧帧记录描述的是已
    // 丢弃的画面，拿它测量就是按不存在的像素下结论。
    await restoreScrollSession(page, diagnostics, role.id, "画布路径");
    return unmeasuredRecord(
      role,
      recordContext,
      METHOD_UNMEASURED,
      `画布当前绘制帧（第 ${currentFrame} 帧）没有任何绘制记录：画布已被清空或尺寸重置且未重绘，不沿用旧帧`,
      evidence,
    );
  }
  for (const record of records) {
    const isTextDraw = record.method === "fillText" || record.method === "strokeText";
    // 先分角色：画布上两类角色共用同一份观察记录，另一类的绘制不构成本角色的
    // 覆盖缺口，只记账说明为什么没测它。
    if (isTextRole !== isTextDraw) {
      skipDraw(
        record,
        isTextRole ? "文字角色只测文字绘制，图形绘制不计入本角色" : "图形角色只测图形绘制，文字绘制不计入本角色",
        false,
      );
      continue;
    }
    if (record.observationError) {
      // 观察器记录这条绘制时就失败了（读 fillStyle / measureText 出错）：颜色和
      // 坐标都没留下，仍按方法名归角色——本角色的这条绘制必须计入缺测，静默丢掉
      // 等于把没测到的绘制从覆盖率里抹掉。
      skipDraw(record, `观察器记录该绘制时出错：${record.observationError}`, true);
      continue;
    }
    if (record.composite && record.composite !== "source-over") {
      skipDraw(record, `非 source-over 合成（${record.composite}）无法单独取样`, true);
      continue;
    }
    if (role.id === "chart.timeline-segment" && hasAxisLineIdentity(record)) {
      skipDraw(record, "已确认属于 chart.axis-line，不属于 chart.timeline-segment", false);
      continue;
    }
    if (role.id === "chart.axis-line") {
      if (record.method === "fillRect" && Array.isArray(record.rectArgs)) {
        const [, , width, height] = record.rectArgs;
        if (width * height < 0.95 * bitmapWidth * bitmapHeight) {
          skipDraw(record, "fillRect 数据段属于 chart.timeline-segment，不属于 chart.axis-line", false);
          continue;
        }
      }
      if (hasAxisLineIdentity(record)) {
        const axisRegions = axisLineBandRegions(record, canvasScale, clip, stash.bitmap);
        if (!axisRegions) {
          skipDraw(record, "轴线缺少可采样的正向 L 形几何、有限线宽或平移+正均匀缩放变换", true);
          continue;
        }
        for (const region of axisRegions) {
          drawRegions.push({ id: `draw-${drawRegions.length}`, ...region, record });
        }
        continue;
      }
    }
    if (isTextDraw) {
      if (typeof record.x !== "number" || typeof record.y !== "number") {
        skipDraw(record, "文字绘制缺少坐标参数", true);
        continue;
      }
      const metrics = record.measured ?? {};
      const fontSize = Number.parseFloat(record.font) || 12;
      const ascent = metrics.ascent && metrics.ascent > 0 ? metrics.ascent : FALLBACK_ASCENT_RATIO * fontSize;
      const descent = metrics.descent && metrics.descent > 0 ? metrics.descent : FALLBACK_DESCENT_RATIO * fontSize;
      const width = metrics.width && metrics.width > 0 ? metrics.width : 0;
      if (width <= 0) {
        skipDraw(record, "文字宽度测量为 0", true);
        continue;
      }
      const anchorX =
        record.textAlign === "right"
          ? record.x - width
          : record.textAlign === "center"
            ? record.x - width / 2
            : record.x;
      const matrix = record.transform;
      const scaleX = matrix ? Math.abs(matrix.a) : 1;
      const scaleY = matrix ? Math.abs(matrix.d) : 1;
      // (x, y) 是当前坐标系下的基线左端；matrix 把它换算成 drawing buffer 像素
      const baselineX = matrix ? matrix.a * anchorX + matrix.c * record.y + matrix.e : anchorX;
      const baselineY = matrix ? matrix.b * anchorX + matrix.d * record.y + matrix.f : record.y;
      // 框顶在基线之上一个已按 d 缩放的 ascent；整框再按 buffer/CSS 尺寸比换算
      drawRegions.push({
        id: `draw-${drawRegions.length}`,
        x: clip.x + baselineX * canvasScale.x,
        y: clip.y + (baselineY - ascent * scaleY) * canvasScale.y,
        width: width * scaleX * canvasScale.x,
        height: (ascent + descent) * scaleY * canvasScale.y,
        record,
      });
    } else if (record.method === "fillRect" && Array.isArray(record.rectArgs)) {
      const [x, y, width, height] = record.rectArgs;
      // 覆盖几乎整幅画布的填充是应用自绘底色层（清前景时已重建），不是被测量的绘制
      if (width * height >= 0.95 * bitmapWidth * bitmapHeight) {
        skipDraw(record, "应用自绘底色层（清前景时已按观察记录重建），不是被测量的绘制", false);
        continue;
      }
      const matrix = record.transform;
      drawRegions.push({
        id: `draw-${drawRegions.length}`,
        x: clip.x + (matrix ? matrix.a * x + matrix.c * y + matrix.e : x) * canvasScale.x,
        y: clip.y + (matrix ? matrix.b * x + matrix.d * y + matrix.f : y) * canvasScale.y,
        width: (matrix ? Math.abs(matrix.a) * width : width) * canvasScale.x,
        height: (matrix ? Math.abs(matrix.d) * height : height) * canvasScale.y,
        record,
      });
    } else {
      // 路径型 stroke/fill 只记调用、不记矩形与坐标，取不到样。它是本角色的绘制，
      // 必须计入缺测而不是只记账——已测部分达标也不等于本角色被覆盖完整。
      skipDraw(record, "绘制机制没有可取样参数（路径型 stroke/fill 只记调用，不记矩形与坐标）", true);
    }
  }
  if (drawRegions.length === 0) {
    // 没有可测绘制就既不清画布也不截图：清空后拍一张空画布不能当成测量证据。
    // 本角色有绘制却都测不动时，缺测项照实进汇总（不许 pass）；一条本角色绘制都
    // 没有时（画布上只有另一类角色的绘制）单独说明跳过了什么。
    if (measurements.length === 0) {
      const reasons = evidence.skipped.map((entry) => `${entry.method}：${entry.reason}`);
      return unmeasuredRecord(
        role,
        recordContext,
        METHOD_UNMEASURED,
        `画布上没有该角色（${role.kind}）可测的当前帧绘制${reasons.length > 0 ? `：${reasons.join("；")}` : ""}`,
        evidence,
      );
    }
    return assembleRoleRecord(role, recordContext, measurements, evidence, METHOD_CANVAS);
  }
  let cleared = null;
  let clearFailure = null;
  try {
    cleared = await page.evaluate(buildCanvasClearSource(records));
    if (cleared && cleared.ok === false) clearFailure = `画布清前景失败：${cleared.reason}`;
  } catch (error) {
    clearFailure = `画布清前景失败：${error instanceof Error ? error.message : String(error)}`;
  }
  evidence.rebuiltBaseLayers = cleared?.ok ? cleared.rebuiltBaseLayers : null;
  let shot = null;
  try {
    if (!clearFailure && clip && isInsideViewport(clip, viewport)) {
      shot = await shoot(clip, "background", role.id, live.ok ? live.scroll : stash.scroll);
    }
    if (clearFailure) {
      return unmeasuredRecord(role, recordContext, METHOD_UNMEASURED, clearFailure, evidence);
    }
    if (!shot) {
      return unmeasuredRecord(
        role,
        recordContext,
        METHOD_UNMEASURED,
        "画布未完整落入视口（视口外内容需整页截图方案），已保留原图与画布记录",
        evidence,
      );
    }
    evidence.capture = shot.index;
    const regions = drawRegions.map((region) => ({
      id: region.id,
      ...(region.part ? { part: region.part } : {}),
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
    }));
    const scan = await page.evaluate(buildScanSource(shot.base64, regions, clipOf(clip)));
    const scannedById = new Map(scan.regions.map((region) => [region.id, region]));
    for (const region of drawRegions) {
      // 描边文字的前景色是描边色：fillText 取 fillStyle、strokeText 取 strokeStyle。
      // 统一读 fillStyle 会在"黑填白描"时按填充色下结论，前景色整个错。
      // 描边文字的前景色是描边色：fillText 取 fillStyle、strokeText 取 strokeStyle。
      // 统一读 fillStyle 会在"黑填白描"时按填充色下结论，前景色整个错。
      const colorValue =
        region.record.method === "stroke"
          ? region.record.strokeStyle
          : region.record.method === "strokeText"
            ? (region.record.strokeStyle ?? region.record.fillStyle)
            : region.record.fillStyle;
      const parsed = await parseColor(page, colorValue);
      if (!parsed.ok) {
        measurements.push({ unmeasured: parsed.reason, draw: region.id, colorValue });
        continue;
      }
      const scanned = scannedById.get(region.id);
      if (!scanned || scanned.pixels.length === 0) {
        measurements.push({ unmeasured: "绘制区域没有可取样的背景像素", draw: region.id });
        continue;
      }
      const foreground = { rgb: parsed.rgb, alpha: parsed.alpha * (region.record.alpha ?? 1) };
      const origin = {
        x: clip.x + scanned.origin.x / scan.scale.x,
        y: clip.y + scanned.origin.y / scan.scale.y,
        columns: scanned.columns,
        pixelStepX: 1 / scan.scale.x,
        pixelStepY: 1 / scan.scale.y,
      };
      const sample = worstBackgroundSample(foreground, scanned.pixels, origin);
      measurements.push({
        draw: region.id,
        method: region.record.method,
        foreground,
        worst: sample,
        text: region.record.text,
      });
      evidence.draws.push({
        id: region.id,
        ...(region.part ? { part: region.part } : {}),
        method: region.record.method,
        text: region.record.text,
        eventSequence: region.record.eventSequence ?? null,
        frame: region.record.frame ?? null,
        canvasId: region.record.canvasId ?? null,
        ...(region.record.chartDraw == null ? {} : { chartDraw: region.record.chartDraw }),
        colorValue,
        foreground,
        alpha: region.record.alpha ?? 1,
        lineWidth: region.record.lineWidth ?? null,
        font: region.record.font,
        transform: region.record.transform,
        parsed: { rgb: parsed.rgb, alpha: parsed.alpha },
        worst: sample,
        rect: { x: region.x, y: region.y, width: region.width, height: region.height },
      });
    }
    notes.push(`${role.id}: 画布 ${stash.canvasId ?? "(无 id)"} 重建底色层 ${evidence.rebuiltBaseLayers ?? 0} 个`);
    return assembleRoleRecord(role, recordContext, measurements, evidence, METHOD_CANVAS);
  } finally {
    try {
      const restored = await page.evaluate(buildCanvasRestoreSource());
      if (!restored.ok || !restored.identical) {
        diagnostics.restoration.canvasDifferences.push(
          `${role.id}: 画布恢复${restored.ok ? `存在 ${restored.differingPixels} 个像素差异` : `失败（${restored.reason}）`}`,
        );
      }
    } catch (error) {
      diagnostics.restoration.canvasDifferences.push(
        `${role.id}: 画布恢复失败（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
    await restoreScrollSession(page, diagnostics, role.id, "画布路径");
  }
}

/**
 * 汇总口径：多节点/多绘制取最差比值，但缺测项一律保留并写入证据——
 * - 有明确失败 → fail（失败优先，缺测不掩盖失败）；
 * - 没有失败而覆盖不完整（有已渲染节点没能测量）→ unmeasured，不许把已达标的那
 *   部分并成 pass 伪造覆盖率；
 * - 未渲染节点（display:none / visibility:hidden / 尺寸为 0）没有可测像素，单独
 *   记账（notRendered），不参与覆盖判定，但数量与原因都写进证据，不许静默删掉。
 */
function assembleRoleRecord(role, recordContext, measurements, evidence, method) {
  const measured = measurements.filter((entry) => entry.worst);
  const missing = measurements.filter((entry) => entry.unmeasured);
  const notApplicable = measurements.filter((entry) => entry.notApplicable);
  const notRendered = measurements.filter((entry) => entry.notRendered);
  const reasons = missing.map((entry) => entry.unmeasured).filter(Boolean);
  const notApplicableReasons = notApplicable.map((entry) => entry.notApplicable).filter(Boolean);
  const notRenderedReasons = notRendered.map((entry) => entry.notRendered).filter(Boolean);
  const coverage = {
    unmeasuredNodes: missing
      .filter((entry) => entry.identity)
      .map((entry) => ({
        index: entry.node,
        identity: entry.identity,
        reason: entry.unmeasured,
        ...(entry.geometry ? { geometry: entry.geometry } : {}),
      })),
    notApplicableCount: notApplicable.length,
    notApplicableReasons,
    notApplicableNodes:
      evidence.notApplicableNodes ??
      notApplicable
        .filter((entry) => entry.identity)
        .map((entry) => ({ index: entry.node, identity: entry.identity, reason: entry.notApplicable })),
    notRenderedNodes: notRendered
      .filter((entry) => entry.identity)
      .map((entry) => ({ index: entry.node, identity: entry.identity, reason: entry.notRendered })),
  };
  const common = {
    candidateId: recordContext.candidateId,
    mode: recordContext.mode,
    roleId: role.id,
    stateId: recordContext.stateId,
    threshold: recordContext.threshold,
    method,
  };
  if (measured.length === 0) {
    return buildRecord({
      ...common,
      result: "unmeasured",
      ratio: null,
      evidence: evidenceOf({
        ...evidence,
        ...coverage,
        measuredCount: 0,
        unmeasuredCount: missing.length,
        unmeasuredReasons: reasons,
        notRenderedCount: notRendered.length,
        notRenderedReasons,
      }),
      reason:
        reasons.length > 0
          ? reasons.join("；")
          : notApplicable.length > 0
            ? `没有活动可测节点（${notApplicable.length} 个目标不适用）`
            : "没有可测节点",
    });
  }
  const worst = measured.reduce((left, right) => (right.worst.ratio < left.worst.ratio ? right : left));
  const worstSummary = {
    node: worst.node ?? worst.draw ?? null,
    ratio: worst.worst.ratio,
    position: { x: worst.worst.x, y: worst.worst.y },
    background: worst.worst.background,
    foreground: worst.foreground ? { rgb: worst.foreground.rgb, alpha: worst.foreground.alpha } : null,
  };
  if (worst.worst.ratio < recordContext.threshold) {
    return buildRecord({
      ...common,
      result: "fail",
      ratio: worst.worst.ratio,
      evidence: evidenceOf({
        ...evidence,
        ...coverage,
        measuredCount: measured.length,
        unmeasuredCount: missing.length,
        unmeasuredReasons: reasons,
        notRenderedCount: notRendered.length,
        notRenderedReasons,
        worst: worstSummary,
      }),
      reason: `最差样本 ${worst.worst.ratio.toFixed(4)} < 阈值 ${recordContext.threshold}`,
    });
  }
  if (missing.length > 0) {
    return buildRecord({
      ...common,
      result: "unmeasured",
      ratio: null,
      evidence: evidenceOf({
        ...evidence,
        ...coverage,
        measuredCount: measured.length,
        unmeasuredCount: missing.length,
        unmeasuredReasons: reasons,
        notRenderedCount: notRendered.length,
        notRenderedReasons,
        worst: worstSummary,
      }),
      reason: `覆盖不完整：${measured.length} 项已测且全部达标，${missing.length} 项未能测量（${reasons.join("；") || "未说明原因"}）`,
    });
  }
  return buildRecord({
    ...common,
    result: "pass",
    ratio: worst.worst.ratio,
    evidence: evidenceOf({
      ...evidence,
      ...coverage,
      measuredCount: measured.length,
      unmeasuredCount: 0,
      unmeasuredReasons: [],
      notRenderedCount: notRendered.length,
      notRenderedReasons,
      worst: worstSummary,
    }),
    reason: "",
  });
}
