/**
 * M4.2 首屏和基准截图（capture.mjs）
 * ============================================================================
 *
 * 固定流程（M4.2 卡面步骤 1—7）：一候选两模式的基准捕获。candidate = null 时走
 * 正式色源验收模式（M4.1 服务的原文件模式），保存该皮肤的旧颜色/几何对照；其余
 * 输入必须是过 M0 契约的完整 Candidate。"对照只做一次并绑定源摘要"的编排属
 * M4.4 review-cli，本模块只负责把 sourceHashes 写进 capture.json 供绑定。
 *
 * 每个模式一条完全独立的浏览器上下文（同数据、同滚动位置=顶部、同透明度）：
 *   1. context 1920×1080 / DPR 1 / locale zh-CN / timezone Asia/Shanghai /
 *      reducedMotion reduce；context.route 阻断预览服务之外的一切 http(s) 并记账。
 *      计价 refresh 在页面路由层返回"无变化"（现有 UI audit 的开发 route 同款），
 *      请求到不了服务端，不修改 server 业务逻辑。
 *   2. init script 只在键为空时播种隔离偏好（主题 / 完整皮肤偏好 v1 /
 *      关闭自动刷新）——不重写已有值，不掩盖偏好恢复失败。
 *   3. 首屏检查：page route 扣住 /app.js 模块响应（module 是 deferred，扣住入口
 *      即扣住整个模块图），goto(waitUntil:"commit") 后等 bootstrap dataset 标记
 *      和 stylesheet 就绪（不能等 load/DOMContentLoaded，会死锁）；读 root 20 项
 *      声明、dataset、可见背景，与 Node 侧 derivePaletteDeclarationsFromTokens
 *      输出核对，存 first-screen.png/json。随后放行模块（finally 保证放行或结束）。
 *   4. 运行时就绪：等 __skinTestHook（app.js 安装）与 preset 按钮出现，真实点击
 *      『全部』（STATE_CATALOG dashboard-default 的触发步骤），等非零指标、
 *      fonts.ready、角色图片 decode、Canvas 当前帧有绘制且 toDataURL 收敛——
 *      不用固定 sleep 代替就绪条件（应用在数据到达后会二次重画时间分布图）。
 *   5. 导航前已装 M3 观察器（installBrowserColorObserver）；就绪后把 page 交给
 *      measureBrowserRoles(stateId:"dashboard-default") 测量，测量恢复页面后
 *      回到顶部截基准整页图（baseline.png）并复读 20 项声明——必须与首屏一致。
 *   6. 全程记录 pageerror / console error / requestfailed / ≥400 响应 / 外网拦截；
 *      任何就绪失败、声明不一致、必要资源失败都让该模式记 failed，不算截图成功。
 *
 * 输出（outDir 必须是仓库 docs/validation/ 下的空新目录）：
 *   capture.json            元数据（身份/摘要/环境/错误/各模式结果）
 *   <mode>/first-screen.png 原尺寸首屏截图（1920×1080 视口）
 *   <mode>/first-screen.json 首屏 20 项声明（期望/实际/差异）+ dataset + 背景
 *   <mode>/baseline.png     原尺寸基准整页截图
 *   <mode>/layout.json      固定元素几何（topbar/首 metric/首 panel/chart/角色 bounds）
 *   <mode>/colors.json      运行时 20 项声明 + 首屏/运行时/期望三方一致性
 *   <mode>/checks.json      M3 测量记录（dashboard-default）+ 诊断 + 截图索引
 *   <mode>/captures/*.png   测量过程的角色背景/原图截图（编号对应 checks 索引）
 *
 * 只使用 Node 内置模块、M0—M4 既有工具与 Playwright 开发运行时；不写 public/。
 */

import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, collectSourceHashes, sha256Canonical, validateCandidate } from "./contracts.mjs";
import {
  captureStableFullPage,
  installBrowserColorObserver,
  measureBrowserRoles,
  OFFICIAL_CANDIDATE_ID,
} from "./browser-measure.mjs";
import { ROLE_CATALOG, STATE_CATALOG } from "./roles.mjs";
import { startCandidatePreview } from "./preview-server.mjs";
import { getPaletteFixtureHash, getTimelineWarningFixtureHash } from "../../test-support/skin-palette-fixture.mjs";
import {
  PALETTE_CSS_VAR_NAMES,
  SKIN_PREFERENCE_VERSION,
  derivePaletteDeclarationsFromTokens,
} from "../../public/skins.js";
import { SKIN_PALETTES } from "../../public/skin-palettes.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..");

const POLICY = JSON.parse(readFileSync(path.join(MODULE_DIR, "policy.json"), "utf8"));
const MODES = Object.freeze(["light", "dark"]);
const MAX_MATRIX_ATTEMPTS_PER_UNIT = 2;
const MATRIX_RETRY_POLICY = Object.freeze({ version: 1, maxAttemptsPerUnit: MAX_MATRIX_ATTEMPTS_PER_UNIT });
const BASELINE_STATE_ID = "dashboard-default";
const BASE_VIEWPORT = Object.freeze({ width: 1920, height: 1080 });

/** 偏好存储键（与 public/index.html 内联脚本、app.js、skin-bootstrap.js 一致）。 */
const THEME_STORAGE_KEY = "codexUsageTheme";
const SKIN_STORAGE_KEY = "codexUsageSkinV1";
const AUTO_REFRESH_STORAGE_KEY = "codexUsageAutoRefresh";

/**
 * 运行证据必须覆盖的 31 项源文件：M3.4 的 REQUIRED_SOURCE_FILES（assess.mjs 导出，26 项，含焦点与 detail-bar 模块）
 * 全集 + 捕获链路自身依赖（skin-bootstrap.js、i18n.js、bootstrap-source.mjs、
 * preview-server.mjs、capture.mjs）。测试直接断言 M3.4 集合是本清单的子集。
 */
const SOURCE_FILES = Object.freeze([
  "public/index.html",
  "public/skin-palettes.js",
  "public/skin-bootstrap.js",
  "public/styles.css",
  "public/skins.css",
  "public/app.js",
  "public/app-state.js",
  "public/timeline-utils.js",
  "public/i18n.js",
  "public/skin-ui.js",
  "public/skin-picker.js",
  "public/skins.js",
  "scripts/skin-palette/contracts.mjs",
  "scripts/skin-palette/roles.mjs",
  "scripts/skin-palette/policy.json",
  "scripts/skin-palette/color-math.mjs",
  "scripts/skin-palette/bootstrap-source.mjs",
  "scripts/skin-palette/browser-measure.mjs",
  "scripts/skin-palette/focus-outline-pixels.mjs",
  "scripts/skin-palette/focus-outline-browser.mjs",
  "scripts/skin-palette/detail-bar-capture.mjs",
  "scripts/skin-palette/detail-bar-frame-analysis.mjs",
  "scripts/skin-palette/detail-bar-pixels.mjs",
  "scripts/skin-palette/detail-bar-browser.mjs",
  "scripts/skin-palette/detail-bar-hit-browser.mjs",
  "scripts/skin-palette/detail-bar-paint-browser.mjs",
  "scripts/skin-palette/evaluate.mjs",
  "scripts/skin-palette/diagnostics.mjs",
  "scripts/skin-palette/assess.mjs",
  "scripts/skin-palette/preview-server.mjs",
  "scripts/skin-palette/capture.mjs",
]);
export { SOURCE_FILES };
// M4.3 矩阵数据（测试与 M4.4 CLI 直接消费；默认导出同样聚合一份）
export { MATRIX_UNTESTED, STATE_MATRIX_GROUPS };

/** Playwright 运行时位置：环境变量优先，其次本机 codex 运行时依赖目录（M3.2 同款）。 */
const PLAYWRIGHT_CANDIDATES = Object.freeze(
  [
    process.env.AGENT_USAGE_PLAYWRIGHT_MODULE,
    path.join(
      homedir(),
      ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs",
    ),
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0),
);

const EDGE_CANDIDATES = Object.freeze([
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/microsoft-edge",
  "/usr/bin/microsoft-edge-stable",
  "/usr/bin/google-chrome",
]);

// ---------------------------------------------------------------------------
// 纯助手（Node 侧，可单测）
// ---------------------------------------------------------------------------

/**
 * 指标文本 → 数值。应用渲染格式：formatTokenMillions 的 "0.24M"/"1.2B" 与
 * Intl 分组的 "242,800"；"-" 表示尚未渲染。无法解析返回 null。
 * 该函数会被原样序列化进页内就绪探针（必须保持自包含，不引用闭包变量）。
 */
export function parseMetricNumber(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed === "-") return null;
  const match = /^([+-]?[\d\u00a0\u202f,.]+)\s*([kKmMbBtT])?$/.exec(trimmed);
  if (!match) return null;
  const mantissa = match[1].replace(/[\u00a0\u202f,]/g, "");
  if (mantissa === "" || !Number.isFinite(Number(mantissa))) return null;
  const number = Number(mantissa);
  const unit = (match[2] ?? "").toLowerCase();
  const multiplier = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" ? 1e9 : unit === "t" ? 1e12 : 1;
  return number * multiplier;
}

/**
 * 期望声明（M1.1 派生的 [name, value][]）与页面实际值（{name: value}）的差异。
 * 颜色大小写不敏感（生产文件小写、候选契约大写，运行时两者等价）；空数组 = 一致。
 */
export function diffPaletteDeclarations(expectedPairs, actualMap) {
  if (!Array.isArray(expectedPairs))
    throw new TypeError("diffPaletteDeclarations: expectedPairs 必须是 [name, value][]");
  if (!actualMap || typeof actualMap !== "object" || Array.isArray(actualMap)) {
    throw new TypeError("diffPaletteDeclarations: actualMap 必须是 { name: value } 映射");
  }
  const differences = [];
  const expected = new Map(expectedPairs.map(([name, value]) => [name, normalizeDeclarationValue(value)]));
  for (const [name, value] of expected) {
    if (!Object.hasOwn(actualMap, name)) {
      differences.push({ name, kind: "missing", expected: value, actual: null });
    } else if (normalizeDeclarationValue(actualMap[name]) !== value) {
      differences.push({ name, kind: "mismatch", expected: value, actual: String(actualMap[name]).trim() });
    }
  }
  for (const name of Object.keys(actualMap)) {
    if (!expected.has(name)) {
      differences.push({ name, kind: "unexpected", expected: null, actual: String(actualMap[name]).trim() });
    }
  }
  return differences;
}

function normalizeDeclarationValue(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

/**
 * 必要资源/脚本错误的阻断清单（纯函数，可单测）。被记录的错误类里没有"允许忽略"
 * 项：未捕获异常、console 错误、请求失败、≥400 响应、模块未被扣住、角色图未解码
 * 任何一项都阻止捕获成功。blockedExternal 是设计行为（外网请求被主动阻断记账），
 * 不在此列，但仍要求为空才算干净证据（由测试断言）。
 */
export function buildResourceBlockers(errors, { moduleRequestCount = 0, charactersReady = false } = {}) {
  const blockers = [];
  if (!errors || typeof errors !== "object") return blockers;
  for (const key of ["pageErrors", "consoleErrors", "requestFailed", "resourceFailures"]) {
    const list = Array.isArray(errors[key]) ? errors[key] : [];
    if (list.length > 0) {
      blockers.push(`${ERROR_CLASS_LABELS[key]}（${list.length}）：${JSON.stringify(list)}`);
    }
  }
  if (moduleRequestCount === 0) {
    blockers.push("app.js 模块请求未被捕获到（必要资源未加载）");
  }
  if (!charactersReady) {
    blockers.push("角色图片未全部解码（必要资源未加载）");
  }
  return blockers;
}

const ERROR_CLASS_LABELS = Object.freeze({
  pageErrors: "页面存在未捕获异常",
  consoleErrors: "页面 console 错误",
  requestFailed: "必要资源请求失败",
  resourceFailures: "必要资源响应失败（≥400）",
});

/**
 * 偏好播种 init script：只在键为空时写入——重载不重写，不掩盖偏好恢复失败。
 * 主题 light/dark；皮肤偏好完整对象（version/skinId/showCharacters/opacity）；
 * 自动刷新固定 "off"（读侧语义：非 "off" 即开启）。
 */
export function buildPreferenceSeedSource({
  theme,
  skinId,
  showCharacters = true,
  opacity = 0.5,
  autoRefresh = "off",
}) {
  if (theme !== "light" && theme !== "dark") {
    throw new TypeError(`buildPreferenceSeedSource: theme 必须是 light/dark，收到 ${JSON.stringify(theme)}`);
  }
  if (typeof skinId !== "string" || skinId.length === 0) {
    throw new TypeError("buildPreferenceSeedSource: skinId 必须是非空字符串");
  }
  const payload = {
    theme,
    autoRefresh,
    skinPreference: { version: SKIN_PREFERENCE_VERSION, skinId, showCharacters: Boolean(showCharacters), opacity },
  };
  return `(() => {
  const payload = ${JSON.stringify(payload)};
  const seedIfEmpty = (key, value) => {
    let existing = null;
    try {
      existing = localStorage.getItem(key);
    } catch {
      return;
    }
    if (existing !== null) return;
    try {
      localStorage.setItem(key, value);
    } catch {
      // 隔离上下文的 storage 不可用时让流程失败在后续就绪检查上，不静默改偏好
    }
  };
  seedIfEmpty(${JSON.stringify(THEME_STORAGE_KEY)}, payload.theme);
  seedIfEmpty(${JSON.stringify(SKIN_STORAGE_KEY)}, JSON.stringify(payload.skinPreference));
  seedIfEmpty(${JSON.stringify(AUTO_REFRESH_STORAGE_KEY)}, payload.autoRefresh);
})()`;
}

/**
 * 捕获输出目录：必须解析到 <rootDir>/docs/validation/ 之下（CLI 写入前验证，
 * 总计划 §3），且是空的新目录——已有证据一律不覆盖。词法检查之外做真实路径
 * 双检（M2.4 同款）：目录内 junction/符号链接指向校验根之外时词法看着合法；
 * mkdir 之后再次复检，防创建窗口内的调包（TOCTOU）。requireEmpty=false 供
 * M4.3 恢复执行复用（containment 与真实路径双检照旧，只放行已有进度的目录）。
 */
export async function assertCaptureOutputDir(outDir, rootDir = REPO_ROOT, { requireEmpty = true } = {}) {
  if (typeof outDir !== "string" || outDir.trim() === "") {
    throw new TypeError("assertCaptureOutputDir: outDir 必须是非空字符串路径");
  }
  const validationRoot = path.resolve(rootDir, "docs", "validation");
  const resolved = path.resolve(outDir);
  const containmentError = (detail) =>
    `assertCaptureOutputDir: outDir 必须位于 ${validationRoot} 之下${detail}（收到 ${resolved}）`;
  // "越出校验根"= 相对路径为 .. 开头或绝对路径；"等于根"是另一种违规（捕获目录必须
  // 严格在根之内），两者只在对应检查点分别生效
  const relativeEscapes = (relative) =>
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  const lexicalRelative = path.relative(validationRoot, resolved);
  if (lexicalRelative === "" || relativeEscapes(lexicalRelative)) {
    throw new Error(containmentError(""));
  }

  // 校验根先确保存在（递归创建幂等），真实路径检查才有可信边界
  await mkdir(validationRoot, { recursive: true });
  const validationRootReal = await realpath(validationRoot);
  // 沿父链找到最深的已存在祖先，还原真实路径再核验包含关系——junction 在这一步现形。
  // 祖先恰好是校验根本身是合法的（最常见情形），这里只拦"越出"
  let existingReal = validationRootReal;
  let current = resolved;
  while (current !== path.dirname(current)) {
    try {
      existingReal = await realpath(current);
      break;
    } catch {
      current = path.dirname(current);
    }
  }
  if (relativeEscapes(path.relative(validationRootReal, existingReal))) {
    throw new Error(`assertCaptureOutputDir: outDir 真实路径越出校验根（真实路径 ${existingReal}）`);
  }

  let entries = [];
  try {
    entries = await readdir(resolved);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (requireEmpty && entries.length > 0) {
    throw new Error(`assertCaptureOutputDir: 捕获目录必须是空的新目录（${resolved} 已有 ${entries.length} 项）`);
  }

  await mkdir(resolved, { recursive: true });
  const createdReal = await realpath(resolved);
  const createdRelative = path.relative(validationRootReal, createdReal);
  if (createdRelative === "" || relativeEscapes(createdRelative)) {
    throw new Error(`assertCaptureOutputDir: 创建目录后的真实路径越出校验根（真实路径 ${createdReal}）`);
  }
  return resolved;
}

/** 解析开发运行时的 Playwright 与 Edge（不可用时返回 null，调用方报 ENVIRONMENT_BLOCKED）。 */
export async function resolveBrowserRuntime() {
  let chromium = null;
  for (const candidate of PLAYWRIGHT_CANDIDATES) {
    const specifier = existsSync(candidate) ? `file://${candidate.replace(/\\/g, "/")}` : candidate;
    try {
      chromium = (await import(specifier)).chromium ?? null;
    } catch {
      chromium = null;
    }
    if (chromium) break;
  }
  const executablePath = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
  return chromium && executablePath ? { chromium, executablePath } : null;
}

// ---------------------------------------------------------------------------
// 页内探针源（IIFE 字符串；parseMetricNumber 以 toString 嵌入保证单一实现）
// ---------------------------------------------------------------------------

/** 首屏/运行时声明读取：root 20 项声明 + dataset + 可见背景 + 样式表清单。 */
function buildDeclarationsProbeSource() {
  return `(() => {
  const names = ${JSON.stringify([...PALETTE_CSS_VAR_NAMES])};
  const root = document.documentElement;
  const rootStyle = getComputedStyle(root);
  const declarations = {};
  for (const name of names) declarations[name] = rootStyle.getPropertyValue(name).trim();
  const bodyStyle = getComputedStyle(document.body);
  return {
    declarations,
    dataset: {
      theme: root.dataset.theme ?? null,
      locale: root.dataset.locale ?? null,
      skin: root.dataset.skin ?? null,
      skinCharacters: root.dataset.skinCharacters ?? null,
      skinOpacity: root.dataset.skinOpacity ?? null,
      skinTheme: root.dataset.skinTheme ?? null,
      skinBootstrap: root.dataset.skinBootstrap ?? null,
    },
    backgrounds: {
      documentElement: rootStyle.backgroundColor,
      body: bodyStyle.backgroundColor,
      bodyImage: bodyStyle.backgroundImage,
    },
    stylesheets: Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(
      (link) => new URL(link.href).pathname,
    ),
    // 首屏扣住证明：模块未执行时指标仍是占位符"-"；若已渲染出数字说明扣住失败，
    // 首屏证据就拍成了运行时状态（颜色断言发现不了——首屏与运行时本就同源）
    unrenderedMetrics: Array.from(document.querySelectorAll(".metric strong")).filter(
      (node) => (node.textContent ?? "").trim() === "-",
    ).length,
  };
})()`;
}

/** bootstrap dataset 标记 + 全部样式表就绪（模式主题匹配；模块扣住时的安全等待）。 */
function buildBootstrapReadySource(mode) {
  return `(() => {
  const root = document.documentElement;
  if (root.dataset.skinBootstrap !== "1") return false;
  if (root.dataset.theme !== ${JSON.stringify(mode)}) return false;
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  if (links.length === 0) return false;
  return links.every((link) => link.sheet !== null);
})()`;
}

/** app 模块已执行（__skinTestHook 由 app.js 安装）且基准触发按钮可用。 */
function buildAppReadySource() {
  return `(() => Boolean(
  window.__skinTestHook
    && document.querySelector('#presetButtons button[data-preset="all"]'),
))()`;
}

/** 非零指标就绪（M0 dashboard-default 的 nonZeroText：解析文本数值，仅数元素不够）。 */
function buildNonZeroMetricsWaitSource() {
  return `(() => {
  const parseMetricNumber = ${parseMetricNumber.toString()};
  const nodes = Array.from(document.querySelectorAll(".metric strong"));
  if (nodes.length === 0) return false;
  return nodes.some((node) => (parseMetricNumber(node.textContent ?? "") ?? 0) > 0);
})()`;
}

/** 角色图片解码就绪：有 src 的装饰图必须全部解码完成；无图不阻塞但记录原因。 */
export function buildCharactersReadySource() {
  return `(() => {
  const images = Array.from(document.querySelectorAll("#skinCharacters img"));
  if (images.length === 0) return { ready: true, note: "no-decoration-layer", total: 0, loaded: 0 };
  const withSrc = images.filter((image) => image.getAttribute("src"));
  if (withSrc.length === 0) return { ready: true, note: "no-character-assets", total: images.length, loaded: 0 };
  const loaded = withSrc.every(
    (image) => image.dataset.loaded === "1" && image.complete && image.naturalWidth > 0,
  );
  return { ready: loaded, total: images.length, loaded: withSrc.length };
})()`;
}

/**
 * 角色图片等待源：waitForFunction 需要布尔返回值（对象恒为真值，直接等对象会立即
 * 通过），所以轮询时对探针 IIFE 的结果取 .ready——延迟加载的图片就绪后变 true。
 */
export const CHARACTERS_READY_WAIT_SOURCE = `(() => (${buildCharactersReadySource()}).ready)()`;

/**
 * Canvas 就绪：当前帧（M3 观察器 frameOf 语义）有应用绘制，且 toDataURL 相邻两次
 * 采样相同（数据到达后的二次重画已收敛）。签名暂存在 window WeakMap，仅本捕获用。
 */
function buildCanvasStableWaitSource(selector) {
  return `(() => {
  const canvas = document.querySelector(${JSON.stringify(selector)});
  if (!canvas || typeof canvas.toDataURL !== "function") return false;
  const observer = window.__skinPaletteColorObserver;
  if (!observer || !Array.isArray(observer.records)) return false;
  const frame = typeof observer.frameOf === "function" ? observer.frameOf(canvas) : null;
  const draws = observer.records.filter(
    (record) => record.canvasRef === canvas && (frame === null || (record.frame ?? 0) === frame),
  );
  if (draws.length === 0) return false;
  if (!window.__captureCanvasSignatures) window.__captureCanvasSignatures = new WeakMap();
  const signatures = window.__captureCanvasSignatures;
  const signature = canvas.toDataURL();
  const previous = signatures.get(canvas);
  signatures.set(canvas, signature);
  return previous !== undefined && previous === signature;
})()`;
}

/** 字体就绪（document.fonts.ready；无 Web 字体时立即兑现）。 */
const FONTS_READY_SOURCE = `(() => document.fonts.ready.then(() => document.fonts.status))()`;

/** 双 rAF 对齐：等当前样式/布局真正绘制两帧（同步原语，不是固定时长 sleep）。 */
const PAINT_SETTLE_SOURCE = `(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
}))()`;

/** Captured regions retain their trigger viewport only when the unit opts in. */
export async function settleStateEvidenceViewport(page, unit) {
  if (unit.preserveTriggerViewport !== true) {
    await page.evaluate("(() => { window.scrollTo(0, 0); return { x: window.scrollX, y: window.scrollY }; })()");
  }
  await page.evaluate(PAINT_SETTLE_SOURCE);
}

/** 基准布局/固定元素颜色：topbar、首个 metric、首个 panel、chart、角色 artwork bounds。 */
function buildLayoutProbeSource() {
  return `(() => {
  const rectOf = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  const styleOf = (element, properties) => {
    if (!element) return null;
    const style = getComputedStyle(element);
    return Object.fromEntries(properties.map((property) => [property, style.getPropertyValue(property)]));
  };
  const firstMetric = document.querySelector(".metric");
  const firstPanel = document.querySelector(".panel");
  const canvas = document.querySelector("#timelineChart");
  return {
    viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
    scroll: { x: window.scrollX, y: window.scrollY },
    documentHeight: document.documentElement.scrollHeight,
    elements: {
      topbar: {
        rect: rectOf(document.querySelector(".topbar")),
        style: styleOf(document.querySelector(".topbar"), ["background-color", "background-image"]),
      },
      firstMetric: {
        rect: rectOf(firstMetric),
        style: styleOf(firstMetric, ["background-color", "background-image"]),
      },
      firstPanel: {
        rect: rectOf(firstPanel),
        style: styleOf(firstPanel, ["background-color", "background-image", "border-color"]),
      },
      chart: {
        rect: rectOf(canvas),
        style: styleOf(canvas, ["background-color"]),
      },
    },
    artwork: Array.from(document.querySelectorAll("#skinCharacters img")).map((image) => ({
      view: image.dataset.view ?? null,
      src: image.getAttribute("src"),
      loaded: image.dataset.loaded ?? null,
      rect: rectOf(image),
    })),
  };
})()`;
}

// ---------------------------------------------------------------------------
// 单模式捕获
// ---------------------------------------------------------------------------

const APP_MODULE_ROUTE = /\/app\.js(?:\?|$)/;
const PRICING_REFRESH_ROUTE = /\/api\/pricing\/refresh(?:\?|$)/;

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJson(file, value) {
  await writeFile(file, jsonText(value), "utf8");
}

function sha256Of(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function hashEvidenceTree(rootDir) {
  const rootPath = path.resolve(rootDir);
  const rootRealPath = await realpath(rootPath);
  const entries = [];
  const walk = async (directory) => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      if (child.isSymbolicLink()) throw new Error(`证据目录包含符号链接：${path.relative(rootPath, absolutePath)}`);
      if (child.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!child.isFile()) throw new Error(`证据目录包含非普通文件：${path.relative(rootPath, absolutePath)}`);
      const bytes = await readFile(absolutePath);
      entries.push({
        file: path.relative(rootRealPath, absolutePath).split(path.sep).join("/"),
        sha256: sha256Of(bytes),
        bytes: bytes.length,
      });
    }
  };
  await walk(rootRealPath);
  if (entries.length === 0) throw new Error("证据目录为空");
  return sha256Canonical(entries);
}

/**
 * S0 的固定附件清单。故意不递归扫描模式目录：后续状态证据写在 states/，
 * 不属于基准截图、布局、颜色声明与基准角色测量的取证范围。
 */
async function collectBaselineEvidenceManifest(modeDir, { mode, skinId, measureRoles } = {}) {
  if (typeof measureRoles !== "boolean") throw new TypeError("S0 附件清单的 measureRoles 必须是布尔值");
  const absoluteModeDir = path.resolve(modeDir);
  const modeDirStat = await lstat(absoluteModeDir);
  if (!modeDirStat.isDirectory() || modeDirStat.isSymbolicLink()) {
    throw new Error("模式证据目录不是普通目录");
  }
  const rootRealPath = await realpath(absoluteModeDir);
  const readAttachment = async (file) => {
    if (
      typeof file !== "string" ||
      file.length === 0 ||
      path.posix.isAbsolute(file) ||
      file.includes("\\") ||
      file.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error(`S0 附件路径无效：${String(file)}`);
    }
    const segments = file.split("/");
    let currentPath = rootRealPath;
    for (const [index, segment] of segments.entries()) {
      currentPath = path.join(currentPath, segment);
      const info = await lstat(currentPath);
      if (info.isSymbolicLink()) throw new Error(`S0 附件不能是符号链接：${file}`);
      const isLast = index === segments.length - 1;
      if (isLast ? !info.isFile() : !info.isDirectory()) {
        throw new Error(`S0 附件路径不是普通${isLast ? "文件" : "目录"}：${file}`);
      }
    }
    const actualPath = await realpath(currentPath);
    const relativePath = path.relative(rootRealPath, actualPath);
    if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      throw new Error(`S0 附件指向模式目录之外：${file}`);
    }
    const bytes = await readFile(actualPath);
    if (bytes.length === 0) throw new Error(`S0 附件为空：${file}`);
    return {
      entry: { file, sha256: sha256Of(bytes), bytes: bytes.length },
      bytes,
    };
  };

  const fixedFiles = ["baseline.png", "colors.json", "first-screen.json", "first-screen.png", "layout.json"];
  const files = new Set(fixedFiles);
  let checks = null;
  if (measureRoles) {
    const checksAttachment = await readAttachment("checks.json");
    try {
      checks = JSON.parse(checksAttachment.bytes.toString("utf8"));
    } catch (error) {
      throw new Error(`checks.json JSON 损坏：${error instanceof Error ? error.message : String(error)}`);
    }
    if (
      checks?.stateId !== BASELINE_STATE_ID ||
      checks.mode !== mode ||
      !Array.isArray(checks.records) ||
      checks.records.length === 0 ||
      !Array.isArray(checks.captureIndex) ||
      checks.captureIndex.length === 0
    ) {
      throw new Error("checks.json 缺少 S0 角色判据或测量截图索引");
    }
    files.add("checks.json");
    for (const capture of checks.captureIndex) {
      const captureFile = capture?.file;
      if (
        typeof captureFile !== "string" ||
        !captureFile.startsWith("captures/") ||
        captureFile.split("/").length !== 2 ||
        !captureFile.endsWith(".png")
      ) {
        throw new Error(`checks.json 中的 S0 测量截图路径无效：${String(captureFile)}`);
      }
      files.add(captureFile);
    }
  }

  const entries = [];
  for (const file of [...files].sort((left, right) => left.localeCompare(right))) {
    const attachment = await readAttachment(file);
    entries.push(attachment.entry);
    if (file.endsWith(".json") && file !== "checks.json") {
      let parsed;
      try {
        parsed = JSON.parse(attachment.bytes.toString("utf8"));
      } catch (error) {
        throw new Error(`${file} JSON 损坏：${error instanceof Error ? error.message : String(error)}`);
      }
      if (parsed?.mode !== mode || parsed?.skinId !== skinId) {
        throw new Error(`${file} 的模式或皮肤身份与 S0 不一致`);
      }
      if (file === "first-screen.json" && parsed.matches !== true) {
        throw new Error("first-screen.json 未记录成功的一致性判定");
      }
      if (
        file === "colors.json" &&
        (parsed.runtimeMatchesExpected !== true ||
          parsed.firstScreenMatchesRuntime !== true ||
          parsed.spotlight?.off !== true)
      ) {
        throw new Error("colors.json 未记录成功的一致性判定或聚光关闭状态");
      }
    }
  }
  if (
    measureRoles &&
    checks?.captureIndex?.length !== entries.filter((entry) => entry.file.startsWith("captures/")).length
  ) {
    throw new Error("checks.json 测量截图索引与 S0 附件集合不一致");
  }
  return {
    schemaVersion: 1,
    measureRoles,
    files: entries,
    sha256: sha256Canonical(entries),
  };
}

/** 在任何续跑写盘前验证已捕获的 S0 固定附件摘要。 */
export async function readCapturedBaselineEvidence({
  modeDir,
  progressUnit,
  mode,
  skinId,
  requireMeasurements = false,
} = {}) {
  const fail = (reason) => {
    throw new Error(`S0 基准附件证据不完整：${reason}；拒绝续跑，请连 S0 一起重新捕获`);
  };
  const saved = progressUnit?.baselineEvidence;
  if (
    saved?.schemaVersion !== 1 ||
    typeof saved.measureRoles !== "boolean" ||
    !Array.isArray(saved.files) ||
    typeof saved.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(saved.sha256)
  ) {
    fail("progress.json 缺少有效的固定附件摘要");
  }
  if (requireMeasurements && !saved.measureRoles) fail("本次要求测量 S0 角色，但原基准未包含测量附件");
  if (sha256Canonical(saved.files) !== saved.sha256) fail("progress.json 内部附件清单摘要不匹配");
  let actual;
  try {
    actual = await collectBaselineEvidenceManifest(modeDir, {
      mode,
      skinId,
      measureRoles: saved.measureRoles,
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (actual.sha256 !== saved.sha256 || canonicalJson(actual.files) !== canonicalJson(saved.files)) {
    fail("固定附件缺失或 SHA-256 已变化");
  }
  return actual;
}

/** 校验 progress.json 标记 captured 的单元及其完整、未变化的落盘证据。 */
export async function readCapturedUnitEvidence({
  unitDir,
  unit,
  mode,
  skinId,
  expectedRoleIds = [],
  expectedEvidenceHash,
} = {}) {
  const unitId = unit?.id ?? "<unknown>";
  const fail = (reason) => {
    throw new Error(`续跑单元 ${unitId} 的成功证据不完整：${reason}；请使用新目录重新捕获`);
  };
  if (!unit || typeof unit !== "object" || typeof unit.id !== "string") fail("单元声明无效");
  if (!Array.isArray(expectedRoleIds) || expectedRoleIds.some((roleId) => typeof roleId !== "string")) {
    fail("expectedRoleIds 声明无效");
  }
  if (typeof expectedEvidenceHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedEvidenceHash)) {
    fail("progress.json 缺少有效的 evidenceHash");
  }

  let evidenceHash;
  try {
    evidenceHash = await hashEvidenceTree(unitDir);
  } catch (error) {
    fail(`无法读取证据目录（${error instanceof Error ? error.message : String(error)}）`);
  }
  if (evidenceHash !== expectedEvidenceHash) fail("证据文件摘要与 progress.json 不一致");

  let baseRealPath;
  try {
    baseRealPath = await realpath(unitDir);
  } catch (error) {
    fail(`单元目录不存在（${error instanceof Error ? error.message : String(error)}）`);
  }
  const resolvedFiles = new Map();
  const resolveEvidenceFile = async (reference, label) => {
    const file = typeof reference === "string" ? reference : reference?.file;
    if (typeof file !== "string" || file.length === 0 || path.isAbsolute(file)) fail(`${label} 路径无效`);
    const segments = file.split(/[\\/]+/);
    if (segments.some((segment) => segment === ".." || segment === "")) fail(`${label} 路径越界`);
    const absolutePath = path.resolve(baseRealPath, file);
    const relativePath = path.relative(baseRealPath, absolutePath);
    if (relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
      fail(`${label} 路径越界`);
    }
    let actualPath;
    let bytes;
    try {
      actualPath = await realpath(absolutePath);
      const actualRelative = path.relative(baseRealPath, actualPath);
      if (actualRelative === ".." || actualRelative.startsWith(`..${path.sep}`) || path.isAbsolute(actualRelative)) {
        fail(`${label} 指向证据目录之外`);
      }
      bytes = await readFile(actualPath);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(`续跑单元 ${unitId} 的成功证据不完整：`)) throw error;
      fail(`${label} 缺失或不可读（${error instanceof Error ? error.message : String(error)}）`);
    }
    if (bytes.length === 0) fail(`${label} 是空文件`);
    if (
      reference &&
      typeof reference === "object" &&
      (Object.hasOwn(reference, "bytes") || Object.hasOwn(reference, "sha256"))
    ) {
      if (!Number.isInteger(reference.bytes) || typeof reference.sha256 !== "string") {
        fail(`${label} 哈希清单格式无效`);
      }
      if (reference.bytes !== bytes.length) fail(`${label} 字节数与 state.json 不一致`);
      if (reference.sha256 !== sha256Of(bytes)) fail(`${label} SHA-256 与 state.json 不一致`);
    }
    resolvedFiles.set(file, bytes);
    return { file, bytes };
  };
  const parseJsonEvidence = async (reference, label) => {
    const { file, bytes } = await resolveEvidenceFile(reference, label);
    try {
      return { file, value: JSON.parse(bytes.toString("utf8")) };
    } catch (error) {
      fail(`${label} JSON 损坏（${error instanceof Error ? error.message : String(error)}）`);
    }
  };
  const referencePath = (reference) => (typeof reference === "string" ? reference : reference?.file);

  const { value: state } = await parseJsonEvidence("state.json", "state.json");
  if (
    state?.kind !== "skin-palette-capture-state" ||
    state.status !== "captured" ||
    state.unitId !== unit.id ||
    state.mode !== mode ||
    state.skinId !== skinId ||
    state.stateId !== (unit.stateId ?? null)
  ) {
    fail("state.json 的 kind、状态或单元/模式/皮肤身份不匹配");
  }
  if (unit.fixtureRequirement) {
    const actual = state.trace?.fixtureRequirement;
    const expected = unit.fixtureRequirement;
    if (
      !actual ||
      typeof actual !== "object" ||
      Array.isArray(actual) ||
      ["name", "expectedHash", "actualHash", "match"].some((key) => !Object.hasOwn(actual, key)) ||
      actual.name !== expected.name ||
      actual.expectedHash !== expected.expectedHash ||
      actual.actualHash !== expected.expectedHash ||
      actual.match !== true
    ) {
      fail("trace.fixtureRequirement 与注册 fixture 身份不匹配");
    }
  }
  if (!state.files || typeof state.files !== "object" || Array.isArray(state.files)) fail("state.json 缺少 files 清单");
  if (referencePath(state.files.state) !== "state.json") fail("state.json 未登记自身路径");
  if (referencePath(state.files.checks) !== "checks.json") fail("checks.json 未登记");
  if (referencePath(state.files.geometry) !== "geometry.json") fail("geometry.json 未登记");
  if (referencePath(state.screenshots?.state) !== "state.png") fail("状态截图 state.png 未登记");

  // 清单内的每个附件都要存在并与 state.json 中的哈希/字节数一致。
  for (const [name, reference] of Object.entries(state.files)) {
    await resolveEvidenceFile(reference, `files.${name}`);
  }
  if (!state.screenshots || typeof state.screenshots !== "object" || Array.isArray(state.screenshots)) {
    fail("state.json 缺少截图清单");
  }
  for (const [name, reference] of Object.entries(state.screenshots)) {
    const file = referencePath(reference);
    const fileKey = name === "state" ? "stateScreenshot" : name;
    if (typeof file !== "string" || referencePath(state.files[fileKey]) !== file) {
      fail(`screenshots.${name} 与 files 清单不一致`);
    }
    await resolveEvidenceFile(reference, `screenshots.${name}`);
  }

  const { value: checks } = await parseJsonEvidence(state.files.checks, "checks.json");
  if (
    checks?.kind !== "skin-palette-capture-checks" ||
    checks.status !== "captured" ||
    checks.unitId !== unit.id ||
    checks.stateId !== (unit.stateId ?? null) ||
    checks.mode !== mode ||
    !Array.isArray(checks.records) ||
    !Array.isArray(checks.captureIndex)
  ) {
    fail("checks.json 的 kind、身份或结构不匹配");
  }
  const recordIds = new Set(
    checks.records.map((record) => record?.roleId).filter((roleId) => typeof roleId === "string"),
  );
  for (const roleId of expectedRoleIds) {
    if (!recordIds.has(roleId)) fail(`checks.json 缺少预期角色 ${roleId}`);
  }
  if (JSON.stringify(checks.captureIndex) !== JSON.stringify(state.captures)) {
    fail("state.json 与 checks.json 的测量截图索引不一致");
  }
  for (const capture of checks.captureIndex) {
    await resolveEvidenceFile(capture?.file, `测量截图 ${String(capture?.roleId ?? "")}`);
  }

  const { value: geometry } = await parseJsonEvidence(state.files.geometry, "geometry.json");
  if (
    geometry?.unitId !== unit.id ||
    geometry.stateId !== (unit.stateId ?? null) ||
    geometry.mode !== mode ||
    geometry.skinId !== skinId
  ) {
    fail("geometry.json 的身份不匹配");
  }

  let roleScopeGaps = [];
  if (expectedRoleIds.length > 0) {
    if (!Array.isArray(state.trace?.roleScopeGaps)) fail("trace.roleScopeGaps 缺失");
    roleScopeGaps = state.trace.roleScopeGaps;
    for (const gap of roleScopeGaps) {
      if (
        !gap ||
        !expectedRoleIds.includes(gap.roleId) ||
        typeof gap.reason !== "string" ||
        checks.records.find((record) => record.roleId === gap.roleId)?.result !== "unmeasured"
      ) {
        fail("trace.roleScopeGaps 与本状态角色判据不一致");
      }
    }
  }

  const expectedTimelineModes = unit.timelineModeSequence ?? [];
  if (expectedTimelineModes.length > 0) {
    const timelineTrace = state.trace?.timelineModes;
    const variants = state.measurementVariants;
    if (!Array.isArray(timelineTrace?.checks) || !variants || typeof variants !== "object") {
      fail("S5 视图测量清单缺失");
    }
    for (const viewMode of expectedTimelineModes) {
      const variant = variants[viewMode];
      const traceEntry = timelineTrace.checks.find((entry) => entry.mode === viewMode);
      const checksPath = `checks.timeline-${viewMode}.json`;
      const capturePrefix = `timeline${viewMode[0].toUpperCase()}${viewMode.slice(1)}`;
      if (
        !variant ||
        variant.checks !== checksPath ||
        traceEntry?.measurementEvidence?.checks !== checksPath ||
        referencePath(state.files[`${capturePrefix}Checks`]) !== checksPath
      ) {
        fail(`按${viewMode}视图测量证据未登记`);
      }
      const { value: variantChecks } = await parseJsonEvidence(variant.checks, `${viewMode}视图 checks`);
      if (
        variantChecks?.kind !== "skin-palette-capture-checks" ||
        variantChecks.status !== "captured" ||
        variantChecks.viewMode !== viewMode ||
        variantChecks.unitId !== unit.id ||
        variantChecks.stateId !== (unit.stateId ?? null) ||
        variantChecks.mode !== mode ||
        !Array.isArray(variantChecks.records) ||
        !Array.isArray(variantChecks.captureIndex) ||
        variantChecks.captureIndex.length === 0
      ) {
        fail(`${viewMode} 视图 checks 结构或身份不匹配`);
      }
      const variantRecordIds = new Set(
        variantChecks.records.map((record) => record?.roleId).filter((roleId) => typeof roleId === "string"),
      );
      for (const roleId of expectedRoleIds) {
        if (!variantRecordIds.has(roleId)) fail(`${viewMode} 视图 checks 缺少预期角色 ${roleId}`);
      }
      if (JSON.stringify(variant.captureIndex) !== JSON.stringify(variantChecks.captureIndex)) {
        fail(`${viewMode} 视图截图索引不一致`);
      }
      for (const capture of variantChecks.captureIndex) {
        await resolveEvidenceFile(capture?.file, `${viewMode} 视图测量截图`);
      }
    }
  }
  return { state, checks, geometry, roleScopeGaps, evidenceHash };
}

async function saveScreenshotBuffer(file, buffer) {
  await writeFile(file, buffer);
  return { file: path.basename(file), sha256: sha256Of(buffer), bytes: buffer.length };
}

/** 计价 refresh 的"无变化"响应（浏览器路由层；到不了服务端，不改 server 业务逻辑）。 */
function pricingRefreshFulfillBody() {
  return JSON.stringify({
    checkedAt: new Date().toISOString(),
    changed: false,
    statusChanged: false,
  });
}

/**
 * 打开一个模式的隔离浏览器上下文（M4.2 首屏/基准流程的共享骨架，M4.3 矩阵
 * 在同一上下文内连续捕获多个状态，失败时才关闭换新上下文）。上下文级装配：
 * 1920×1080 / DPR 1 / locale zh-CN / Asia/Shanghai / reducedMotion reduce
 * （D 组桌面视口另传 viewport，其余装配不变）；隔离偏好播种（矩阵默认自动刷新
 * 为 "off"，M4.2 卡面步骤 2——S1 的开启态由真实点击 #autoRefreshToggle 达成；
 * online-freeze 回归显式播种 "on" 以观察轮询）；外网阻断；计价 refresh 开发 route；app.js 模块扣住路由；
 * M3 canvas 观察器。
 */
async function createModeContext({ browser, previewUrl, mode, skinId, viewport = BASE_VIEWPORT, autoRefresh = "off" }) {
  const context = await browser.newContext({
    viewport: { ...viewport },
    deviceScaleFactor: 1,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    reducedMotion: "reduce",
  });
  const errors = {
    pageErrors: [],
    consoleErrors: [],
    requestFailed: [],
    resourceFailures: [],
    blockedExternal: [],
  };
  const counters = { moduleRequestCount: 0, pricingRefreshInterceptions: 0 };
  const quotaContext = { quotaEvidence: null, quotaEvidenceErrors: [] };
  const quotaHook = (method, ...args) => {
    try {
      quotaContext.quotaEvidence?.[method](...args);
    } catch (error) {
      quotaContext.quotaEvidenceErrors.push({
        method,
        message: error instanceof Error ? error.message : String(error),
      });
      quotaContext.quotaEvidence = null;
    }
  };
  const heldRoutes = [];
  let resolveFirstModuleRequestHeld;
  const firstModuleRequestHeld = new Promise((resolve) => {
    resolveFirstModuleRequestHeld = resolve;
  });

  context.on("requestfailed", (request) => {
    const url = request.url();
    if (url.startsWith(previewUrl)) {
      errors.requestFailed.push({ url, error: request.failure()?.errorText ?? null });
    }
  });
  context.on("request", (request) => quotaHook("onRequest", request));
  context.on("response", (response) => {
    const url = response.url();
    let resourceFailureIndex;
    if (url.startsWith(previewUrl) && response.status() >= 400) {
      errors.resourceFailures.push({ url, status: response.status() });
      resourceFailureIndex = errors.resourceFailures.length - 1;
    }
    quotaHook("onResponse", response, resourceFailureIndex);
  });

  await context.addInitScript(
    buildPreferenceSeedSource({ theme: mode, skinId, showCharacters: true, opacity: 0.5, autoRefresh }),
  );

  // 外网阻断：预览服务自身之外的一切 http(s) abort 并记账（data:/blob:/about: 放行）
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(previewUrl) || /^(data|blob|about):/i.test(url)) {
      void route.continue().catch(() => {});
      return;
    }
    errors.blockedExternal.push(url);
    void route.abort().catch(() => {});
  });

  const page = await context.newPage();
  try {
    quotaContext.quotaEvidence = createQuotaEvidenceRecorder({ page, errors, origin: new URL(previewUrl).origin });
  } catch (error) {
    quotaContext.quotaEvidenceErrors.push({
      method: "create",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  page.on("pageerror", (error) => {
    errors.pageErrors.push(error instanceof Error ? error.message : String(error));
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.consoleErrors.push(message.text());
      quotaHook("onConsole", message, errors.consoleErrors.length - 1);
    }
  });

  // 计价 refresh 在页面路由层返回"无变化"（audit 同款开发 route）
  await page.route(PRICING_REFRESH_ROUTE, (route) => {
    counters.pricingRefreshInterceptions += 1;
    void route
      .fulfill({
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: pricingRefreshFulfillBody(),
      })
      .catch(() => {});
  });

  // 扣住 app.js 模块响应：module 是 deferred，入口被扣即整个模块图不执行
  await page.route(APP_MODULE_ROUTE, (route) => {
    counters.moduleRequestCount += 1;
    heldRoutes.push(route);
    resolveFirstModuleRequestHeld();
  });

  // M3 观察器在导航前安装（步骤 6）
  installBrowserColorObserver(page);

  const releaseHeldRoutes = async () => {
    const routes = heldRoutes.splice(0);
    try {
      await page.unroute(APP_MODULE_ROUTE);
    } catch {
      // 页面已不可用时无需再解绑
    }
    for (const route of routes) {
      try {
        await route.continue();
      } catch {
        try {
          await route.abort();
        } catch {
          // 两个出口都失败说明请求已不存在
        }
      }
    }
  };

  const close = async () => {
    // finally 保证放行或结束被暂停的模块请求（卡面步骤 3）
    for (const route of heldRoutes.splice(0)) {
      try {
        await route.continue();
      } catch {
        try {
          await route.abort();
        } catch {
          // 请求已不存在
        }
      }
    }
    await context.close().catch(() => {});
  };

  return Object.assign(quotaContext, {
    previewUrl,
    context,
    page,
    errors,
    counters,
    heldRoutes,
    firstModuleRequestHeld,
    releaseHeldRoutes,
    close,
  });
}

/**
 * 模块放行后的运行时就绪链：app hook 与基准触发按钮、真实点击『全部』（STATE_CATALOG
 * dashboard-default 的触发步骤）、非零指标、fonts.ready、角色图片解码、Canvas 当前帧
 * 收敛——不用固定 sleep 代替就绪条件（应用在数据到达后会二次重画时间分布图）。
 */
async function awaitRuntimeReady({ page, stateTimeoutMs, readiness, durations, blockers }) {
  await waitOk({ page, blockers, durations }, "appReady", buildAppReadySource(), stateTimeoutMs);
  await page.click('#presetButtons button[data-preset="all"]').catch((error) => {
    blockers.push(`点击『全部』失败：${error instanceof Error ? error.message : String(error)}`);
  });
  await waitOk({ page, blockers, durations }, "nonZeroMetrics", buildNonZeroMetricsWaitSource(), stateTimeoutMs);
  try {
    const started = Date.now();
    readiness.fontStatus = await page.evaluate(FONTS_READY_SOURCE);
    durations.fontsReady = Date.now() - started;
  } catch (error) {
    blockers.push(`fonts.ready 等待失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const started = Date.now();
    let characters = await page.evaluate(buildCharactersReadySource());
    if (!characters.ready) {
      try {
        await page.waitForFunction(CHARACTERS_READY_WAIT_SOURCE, undefined, { timeout: stateTimeoutMs });
      } catch (waitError) {
        blockers.push(
          `角色图片未在 ${stateTimeoutMs}ms 内全部解码：${JSON.stringify(characters)}（${
            waitError instanceof Error ? waitError.message : String(waitError)
          }）`,
        );
      }
    }
    // 就绪与否都以等待后的最终状态为准（readiness.characters 记录末次读取）
    characters = await page.evaluate(buildCharactersReadySource());
    durations.charactersReady = Date.now() - started;
    readiness.characters = characters;
  } catch (error) {
    blockers.push(`角色图片就绪检查失败：${error instanceof Error ? error.message : String(error)}`);
  }
  await waitOk(
    { page, blockers, durations },
    "timelineCanvasStable",
    buildCanvasStableWaitSource("#timelineChart"),
    stateTimeoutMs,
  );
}

/** 就绪等待（记录耗时；失败进 blockers 但不抛——由成功判定统一收口）。 */
async function waitOk({ page, blockers, durations }, name, source, timeout) {
  const started = Date.now();
  try {
    await page.waitForFunction(source, undefined, { timeout });
    durations[name] = Date.now() - started;
    return true;
  } catch (error) {
    durations[name] = Date.now() - started;
    blockers.push(`${name} 未在 ${timeout}ms 内就绪：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Normalize only the identity written at the capture boundary; measurement results stay untouched. */
function normalizeMeasurementIdentity({ candidateId, records, diagnostics, label }) {
  const production = candidateId === null;
  if (!production && (typeof candidateId !== "string" || candidateId.length === 0)) {
    throw new TypeError(`${label}: capture candidateId must be null or a non-empty string`);
  }
  if (!Array.isArray(records)) throw new TypeError(`${label}: measurement records must be an array`);

  const normalizeId = (record, source) => {
    if (!record || typeof record !== "object" || Array.isArray(record) || !Object.hasOwn(record, "candidateId")) {
      throw new TypeError(`${label}: ${source} is missing its own candidateId`);
    }
    const id = record.candidateId;
    const accepted = production ? id === null || id === OFFICIAL_CANDIDATE_ID : id === candidateId;
    if (!accepted) throw new TypeError(`${label}: ${source} candidateId does not match the capture identity`);
    return production ? null : candidateId;
  };

  const normalizedRecords = Array.from(records, (record, index) => ({
    ...record,
    candidateId: normalizeId(record, `records[${index}]`),
  }));
  let normalizedDiagnostics = diagnostics;
  if (diagnostics !== null && diagnostics !== undefined) {
    if (typeof diagnostics !== "object" || Array.isArray(diagnostics)) {
      throw new TypeError(`${label}: measurement diagnostics must be an object or null`);
    }
    if (Object.hasOwn(diagnostics, "candidateId")) {
      normalizedDiagnostics = {
        ...diagnostics,
        candidateId: normalizeId(diagnostics, "diagnostics"),
      };
    }
  }
  return { candidateId, records: normalizedRecords, diagnostics: normalizedDiagnostics };
}

export function measurementErrorTrace(error, seen = new WeakSet()) {
  try {
    if (error === null || (typeof error !== "object" && typeof error !== "function")) {
      return { name: "ThrownValue", message: String(error), stack: null, valueType: typeof error };
    }
    if (seen.has(error)) return { circularReference: true };
    seen.add(error);
    const own = (key) => Object.getOwnPropertyDescriptor(error, key);
    const value = (key) => own(key)?.value;
    let name;
    for (let object = error; object; object = Object.getPrototypeOf(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, "name");
      if (descriptor) {
        name = descriptor.value;
        break;
      }
    }
    let stack = value("stack");
    if (stack === undefined && error instanceof Error) {
      try {
        stack = error.stack;
      } catch {
        // V8 的惰性 stack 可能是 getter；读取失败不能遮盖主错。
      }
    }
    const trace = {
      name: typeof name === "string" ? name : "Error",
      message: typeof value("message") === "string" ? value("message") : "错误无可读的消息字段",
      stack: typeof stack === "string" ? stack : null,
    };
    if (Array.isArray(value("errors")))
      trace.errors = Array.from(value("errors"), (item) => measurementErrorTrace(item, seen));
    const cause = own("cause");
    if (cause && Object.hasOwn(cause, "value")) trace.cause = measurementErrorTrace(cause.value, seen);
    const layoutDifference = value("layoutDifference");
    if (layoutDifference && typeof layoutDifference === "object" && !Array.isArray(layoutDifference)) {
      const traceField = (entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
        if (entry.present === false) return { present: false };
        if (entry.present !== true) return null;
        const fieldValue = entry.value;
        if (
          fieldValue === null ||
          typeof fieldValue === "string" ||
          typeof fieldValue === "boolean" ||
          (typeof fieldValue === "number" && Number.isFinite(fieldValue))
        ) {
          return { present: true, value: fieldValue };
        }
        if (typeof entry.valueType === "string") return { present: true, valueType: entry.valueType };
        return null;
      };
      const before = traceField(layoutDifference.before);
      const after = traceField(layoutDifference.after);
      if (typeof layoutDifference.path === "string" && before && after) {
        trace.layoutDifference = { path: layoutDifference.path, before, after };
        const element = layoutDifference.element;
        if (
          element &&
          typeof element === "object" &&
          !Array.isArray(element) &&
          Number.isSafeInteger(element.index) &&
          [element.tag, element.id, element.className].every((item) => item === null || typeof item === "string")
        ) {
          trace.layoutDifference.element = {
            index: element.index,
            tag: element.tag,
            id: element.id,
            className: element.className,
          };
        }
      }
    }
    seen.delete(error);
    return trace;
  } catch {
    return { name: "UnreadableError", message: "错误字段读取失败，保留捕获失败状态", stack: null };
  }
}

function failedCatalogMeasurement(error, { candidateId, mode, stateId }) {
  const counts = { pass: 0, fail: 0, unmeasured: 0, notApplicable: 0 };
  let rejection = "measureBrowserRoles 失败且没有可用的 own-data measurementEvidence";
  try {
    const descriptor =
      error !== null && (typeof error === "object" || typeof error === "function")
        ? Object.getOwnPropertyDescriptor(error, "measurementEvidence")
        : null;
    if (descriptor && Object.hasOwn(descriptor, "value")) {
      const packet = structuredClone(descriptor.value);
      if (
        packet?.complete !== false ||
        !Array.isArray(packet.records) ||
        !Array.isArray(packet.captures) ||
        !packet.diagnostics ||
        typeof packet.diagnostics !== "object" ||
        Array.isArray(packet.diagnostics) ||
        !["before-state", "roles", "after-state", "compare", "record-validation"].includes(packet.phase)
      ) {
        throw new TypeError("partial packet 形状或阶段不合法");
      }
      const roleIds = new Set(ROLE_CATALOG.map((role) => role.id));
      for (const record of packet.records) {
        if (
          !record ||
          !roleIds.has(record.roleId) ||
          record.mode !== mode ||
          record.stateId !== stateId ||
          !["pass", "fail", "unmeasured", "not-applicable"].includes(record.result)
        ) {
          throw new TypeError("partial record 的角色或 mode/state 身份不匹配");
        }
        counts[record.result === "not-applicable" ? "notApplicable" : record.result] += 1;
      }
      if (
        !Object.hasOwn(packet.diagnostics, "candidateId") ||
        packet.diagnostics.mode !== mode ||
        packet.diagnostics.stateId !== stateId
      ) {
        throw new TypeError("partial diagnostics 身份不匹配");
      }
      normalizeMeasurementIdentity({
        candidateId,
        records: packet.records,
        diagnostics: packet.diagnostics,
        label: "catalog partial measurement",
      });
      const stateDiffCaptures = packet.diagnostics.restoration?.stateDiffCaptures;
      const statePixelDiff = packet.diagnostics.restoration?.statePixelDiff;
      const statePixelScope = packet.diagnostics.restoration?.statePixelScope;
      const boundCaptureKinds = new Map();
      if (stateDiffCaptures !== undefined && stateDiffCaptures !== null) {
        const scopeValid =
          statePixelScope?.kind === "full-page" ||
          (statePixelScope?.kind === "viewport" &&
            Number.isSafeInteger(statePixelScope.width) &&
            statePixelScope.width > 0 &&
            Number.isSafeInteger(statePixelScope.height) &&
            statePixelScope.height > 0 &&
            Number.isFinite(statePixelScope.scroll?.x) &&
            Number.isFinite(statePixelScope.scroll?.y));
        if (
          packet.phase !== "record-validation" ||
          statePixelDiff?.identical !== false ||
          !Number.isSafeInteger(statePixelDiff.differingPixels) ||
          statePixelDiff.differingPixels <= 0 ||
          !Number.isSafeInteger(statePixelDiff.maxChannelDelta) ||
          statePixelDiff.maxChannelDelta < 1 ||
          statePixelDiff.maxChannelDelta > 255 ||
          !scopeValid ||
          !Number.isSafeInteger(stateDiffCaptures.before) ||
          !Number.isSafeInteger(stateDiffCaptures.after) ||
          stateDiffCaptures.before < 0 ||
          stateDiffCaptures.after !== stateDiffCaptures.before + 1 ||
          stateDiffCaptures.after >= packet.captures.length
        ) {
          throw new TypeError("partial state-diff capture binding invalid");
        }
        boundCaptureKinds.set(stateDiffCaptures.before, "state-diff-before");
        boundCaptureKinds.set(stateDiffCaptures.after, "state-diff-after");
      }
      for (const [index, capture] of packet.captures.entries()) {
        const expectedKind = boundCaptureKinds.get(index);
        const identityValid = expectedKind
          ? capture?.roleId === null && capture.kind === expectedKind
          : roleIds.has(capture?.roleId);
        if (!identityValid || typeof capture.pngBase64 !== "string" || !capture.pngBase64) {
          throw new TypeError("partial capture 角色未登记或没有原图");
        }
        const png = Buffer.from(capture.pngBase64, "base64");
        if (
          png.toString("base64") !== capture.pngBase64 ||
          !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ) {
          throw new TypeError("partial capture 不是原始 PNG base64");
        }
      }
      packet.diagnostics.partial = true;
      packet.diagnostics.counts = counts;
      return {
        measurement: { records: packet.records, captures: packet.captures, diagnostics: packet.diagnostics },
        phase: packet.phase,
        packet: "accepted",
      };
    }
  } catch (failure) {
    rejection = `partial packet 已拒绝：${measurementErrorTrace(failure).message}`;
  }
  return {
    measurement: {
      records: [],
      captures: [],
      diagnostics: {
        candidateId,
        mode,
        stateId,
        partial: true,
        counts: { pass: 0, fail: 0, unmeasured: 0, notApplicable: 0 },
        notes: [rejection],
      },
    },
    phase: null,
    packet: "unavailable",
    reason: rejection,
  };
}

/**
 * 一模式的首屏 + 基准捕获（M4.2 卡面步骤 3—7）。captureEvidence=false 时仍然
 * goto、放行模块并跑完整就绪链（页面必须到达基准态，状态矩阵依赖它），但不写
 * 任何证据文件、也跳过首屏扣住判据——M4.3 恢复执行用它把已有 S0 证据的目录
 * 重新带到基准态，不覆盖已有证据。
 */
async function runBaselineCapture({
  ctx,
  mode,
  skinId,
  candidate,
  expectedPairs,
  outModeDir,
  stateTimeoutMs,
  policy,
  measureRoles,
  captureEvidence = true,
  restingPointer = false,
}) {
  const { page, errors, counters, heldRoutes, firstModuleRequestHeld, releaseHeldRoutes } = ctx;
  const capturesDir = path.join(outModeDir, "captures");
  const evidence = {};
  const blockers = [];
  const readiness = {};
  const durations = {};
  let firstScreenProbe = null;
  let firstScreenDiffs = [];
  let firstScreenMatches = false;
  let runtimeProbe = null;
  let layout = null;
  let measurement = null;
  let detailFillRestingPointer = null;
  const startedAt = Date.now();

  if (captureEvidence) await mkdir(outModeDir, { recursive: true });

  // 声明一致性判定（意外异常的出口也要读这三个值，声明必须留在最外层 try 之外）
  let runtimeDiffs = null;
  let runtimeMatches = false;
  let firstScreenMatchesRuntime = false;

  try {
    // ---- 首屏（模块扣住状态） ----
    await page.goto(ctx.previewUrl, { waitUntil: "commit", timeout: stateTimeoutMs });
    const bootstrapReady = await waitOk(
      { page, blockers, durations },
      "bootstrapReady",
      buildBootstrapReadySource(mode),
      stateTimeoutMs,
    );
    if (bootstrapReady && captureEvidence) {
      // commit 不保证浏览器已经调度 deferred module 请求。等真实 route 事件或超时，
      // 再检查模块是否仍被扣住，避免在并行负载下把“请求尚未调度”误判为路由失配。
      if (heldRoutes.length === 0) {
        let timeout = null;
        await Promise.race([
          firstModuleRequestHeld,
          new Promise((resolve) => {
            timeout = setTimeout(resolve, stateTimeoutMs);
          }),
        ]);
        if (timeout !== null) clearTimeout(timeout);
      }
      // 首屏确定性的硬前提：此刻模块响应必须仍被扣住（路由失配或提前放行都到此为止）
      if (heldRoutes.length === 0) {
        blockers.push("app.js 响应在首屏证据采集时未被扣住——模块扣住路由未生效或已提前放行");
      }
      firstScreenProbe = await page.evaluate(buildDeclarationsProbeSource());
      if (!(firstScreenProbe.unrenderedMetrics > 0)) {
        blockers.push("首屏证据采集时指标已渲染出数字——app.js 模块未被成功扣住，首屏拍成的是运行时状态");
      }
      firstScreenDiffs = diffPaletteDeclarations(expectedPairs, firstScreenProbe.declarations);
      firstScreenMatches = firstScreenDiffs.length === 0;
      if (!firstScreenMatches) {
        blockers.push(`首屏声明与 M1.1 派生不一致：${JSON.stringify(firstScreenDiffs)}`);
      }
      const shot = await page.screenshot({ fullPage: false });
      evidence.firstScreen = await saveScreenshotBuffer(path.join(outModeDir, "first-screen.png"), shot);
      evidence.firstScreenJson = path.basename(path.join(outModeDir, "first-screen.json"));
      await writeJson(path.join(outModeDir, "first-screen.json"), {
        mode,
        skinId,
        expected: expectedPairs.map(([name, value]) => [name, value]),
        actual: firstScreenProbe.declarations,
        matches: firstScreenMatches,
        differences: firstScreenDiffs,
        dataset: firstScreenProbe.dataset,
        backgrounds: firstScreenProbe.backgrounds,
        stylesheets: firstScreenProbe.stylesheets,
        unrenderedMetrics: firstScreenProbe.unrenderedMetrics,
        screenshot: evidence.firstScreen,
      });
    }

    // ---- 放行模块，等运行时与数据就绪 ----
    await releaseHeldRoutes();
    await awaitRuntimeReady({
      page,
      stateTimeoutMs,
      readiness,
      durations,
      blockers,
    });

    // ---- 基准静止态（S0）：卡面要求 S0 "聚光关闭" ----
    // 聚光是指针派生态，而 catalog 的触发步骤（点『全部』）把指针留在凸起的预设
    // 按钮上——真机探针实测此时 .shell [data-spotlight-active] 就挂在 button.active
    // 上，基准图与角色测量都带着一块光斑。把指针移到凹陷面等图层消失后再取证。
    if (restingPointer === true) {
      const records = [];
      readiness.spotlight = { off: false, calls: records };
      detailFillRestingPointer = async () => {
        const record = {};
        records.push(record);
        try {
          await applySpotlight(page, "off", stateTimeoutMs, record);
          readiness.spotlight.off = true;
          Object.assign(readiness.spotlight, record.spotlight ?? {});
        } catch (error) {
          readiness.spotlight.off = false;
          record.error = error instanceof Error ? error.message : String(error);
          throw error;
        }
      };
      try {
        await detailFillRestingPointer();
      } catch (error) {
        blockers.push(`基准聚光未能关闭：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // ---- M3 测量（观察器已在导航前安装；测量自带恢复核验） ----
    if (measureRoles && captureEvidence) {
      try {
        const started = Date.now();
        measurement = await measureBrowserRoles({
          page,
          candidate,
          mode,
          stateId: BASELINE_STATE_ID,
          roleCatalog: ROLE_CATALOG,
          policy,
          ...(detailFillRestingPointer ? { detailFillRestingPointer } : {}),
        });
        durations.measureBrowserRoles = Date.now() - started;
        const measurementIdentity = normalizeMeasurementIdentity({
          candidateId: candidate === null ? null : candidate?.id,
          records: measurement.records,
          diagnostics: measurement.diagnostics,
          label: "S0 checks.json",
        });
        await mkdir(capturesDir, { recursive: true });
        const captureIndex = [];
        for (const [index, capture] of measurement.captures.entries()) {
          const file = `${String(index).padStart(3, "0")}-${capture.roleId || "capture"}.png`;
          await writeFile(path.join(capturesDir, file), Buffer.from(capture.pngBase64, "base64"));
          captureIndex.push({ index, roleId: capture.roleId, kind: capture.kind, file: `captures/${file}` });
        }
        evidence.checksJson = "checks.json";
        await writeJson(path.join(outModeDir, "checks.json"), {
          stateId: BASELINE_STATE_ID,
          mode,
          candidateId: measurementIdentity.candidateId,
          records: measurementIdentity.records,
          counts: measurement.diagnostics.counts,
          diagnostics: measurementIdentity.diagnostics,
          captureIndex,
        });
      } catch (error) {
        blockers.push(`measureBrowserRoles 失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // ---- 恢复基准状态（回到顶部）后截图 + 运行时声明复读 ----
    try {
      await page.evaluate("(() => { window.scrollTo(0, 0); return { x: window.scrollX, y: window.scrollY }; })()");
      await page.evaluate(PAINT_SETTLE_SOURCE);
      runtimeProbe = await page.evaluate(buildDeclarationsProbeSource());
      layout = await page.evaluate(buildLayoutProbeSource());
    } catch (error) {
      blockers.push(`基准状态恢复/读取失败：${error instanceof Error ? error.message : String(error)}`);
    }

    runtimeDiffs = runtimeProbe ? diffPaletteDeclarations(expectedPairs, runtimeProbe.declarations) : null;
    runtimeMatches = runtimeDiffs ? runtimeDiffs.length === 0 : false;
    if (runtimeProbe && !runtimeMatches) {
      blockers.push(`运行时声明与 M1.1 派生不一致：${JSON.stringify(runtimeDiffs)}`);
    }
    firstScreenMatchesRuntime =
      firstScreenProbe &&
      runtimeProbe &&
      diffPaletteDeclarations(Object.entries(firstScreenProbe.declarations), runtimeProbe.declarations).length === 0;
    if (firstScreenProbe && runtimeProbe && !firstScreenMatchesRuntime) {
      blockers.push("运行时声明与首屏声明不一致（首屏/运行时颜色必须配对）");
    }

    if (layout && captureEvidence) {
      evidence.layoutJson = "layout.json";
      await writeJson(path.join(outModeDir, "layout.json"), { mode, skinId, ...layout });
    }
    if (runtimeProbe && captureEvidence) {
      evidence.colorsJson = "colors.json";
      await writeJson(path.join(outModeDir, "colors.json"), {
        mode,
        skinId,
        expected: expectedPairs.map(([name, value]) => [name, value]),
        runtime: runtimeProbe.declarations,
        runtimeMatchesExpected: runtimeMatches,
        runtimeDifferences: runtimeDiffs,
        firstScreenMatchesRuntime,
        backgrounds: runtimeProbe.backgrounds,
        dataset: runtimeProbe.dataset,
        // 矩阵 S0 的静止态登记：聚光是指针派生态，基准取证前是否把它关掉必须留痕
        ...(readiness.spotlight ? { spotlight: readiness.spotlight } : {}),
      });
    }
    if (captureEvidence) {
      try {
        const shot = await captureStableFullPage(page);
        evidence.baseline = await saveScreenshotBuffer(path.join(outModeDir, "baseline.png"), shot);
      } catch (error) {
        blockers.push(`基准整页截图失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // 成功判定：被记录的错误类逐项进 blockers（无允许忽略清单，见 buildResourceBlockers）
    if (captureEvidence) {
      blockers.push(
        ...buildResourceBlockers(errors, {
          moduleRequestCount: counters.moduleRequestCount,
          charactersReady: readiness.characters?.ready ?? false,
        }),
      );
    }
  } catch (error) {
    // 未预期的异常也要落证据：已保存的截图保留，失败原因进 blockers
    blockers.push(`捕获流程异常：${error instanceof Error ? error.message : String(error)}`);
  }

  const status = blockers.length === 0 ? "captured" : "failed";
  return {
    status,
    blockers,
    errors,
    readiness,
    durations,
    evidence,
    moduleRequestCount: counters.moduleRequestCount,
    pricingRefreshInterceptions: counters.pricingRefreshInterceptions,
    firstScreenMatches,
    runtimeMatches,
    firstScreenMatchesRuntime,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// 单模式捕获（M4.2 入口：一模式一个上下文，captureBaseline 逐模式调用）
// ---------------------------------------------------------------------------

async function captureMode({
  browser,
  previewUrl,
  mode,
  skinId,
  candidate,
  expectedPairs,
  outModeDir,
  stateTimeoutMs,
  policy,
  measureRoles,
}) {
  await mkdir(outModeDir, { recursive: true });
  const ctx = await createModeContext({ browser, previewUrl, mode, skinId });
  try {
    return await runBaselineCapture({
      ctx,
      mode,
      skinId,
      candidate,
      expectedPairs,
      outModeDir,
      stateTimeoutMs,
      policy,
      measureRoles,
      captureEvidence: true,
      restingPointer: true,
    });
  } finally {
    await ctx.close();
  }
}

// ---------------------------------------------------------------------------
// 固定出口
// ---------------------------------------------------------------------------

/**
 * 一候选两模式的基准捕获。candidate = null 为正式色源验收模式（必须显式传
 * skinId）；fixture 是 M0.4 隔离 fixture，生命周期归调用方——本函数只经
 * startCandidatePreview 使用它，结束后 close 预览服务，不触碰 fixture。
 */
export async function captureBaseline({
  candidate = null,
  skinId: skinIdOption = null,
  fixture,
  outDir,
  modes = ["light", "dark"],
  rootDir = REPO_ROOT,
  browserRuntime = null,
  measureRoles = true,
  stateTimeoutMs = 15000,
  port = 0,
} = {}) {
  if (!Array.isArray(modes) || modes.length === 0 || new Set(modes).size !== modes.length) {
    throw new TypeError("captureBaseline: modes 必须是不重复的非空数组");
  }
  for (const mode of modes) {
    if (!MODES.includes(mode)) throw new TypeError(`captureBaseline: 未知模式 "${String(mode)}"`);
  }
  if (typeof measureRoles !== "boolean") {
    throw new TypeError("captureBaseline: measureRoles 必须是布尔值");
  }
  if (!Number.isInteger(stateTimeoutMs) || stateTimeoutMs <= 0) {
    throw new TypeError("captureBaseline: stateTimeoutMs 必须是正整数毫秒");
  }

  const { productionMode, skinId, candidateSnapshot } = snapshotCaptureCandidate({
    candidate,
    skinId: skinIdOption,
    label: "captureBaseline",
  });
  const expectedPairs = deriveExpectedPairs({
    productionMode,
    skinId,
    candidateSnapshot,
    modes,
    label: "captureBaseline",
  });

  const resolvedOutDir = await assertCaptureOutputDir(outDir, rootDir);

  const runtime = browserRuntime ?? (await resolveBrowserRuntime());
  if (!runtime) {
    throw new Error(
      "ENVIRONMENT_BLOCKED: 未找到可用的 Playwright/Edge 运行时（AGENT_USAGE_PLAYWRIGHT_MODULE / AGENT_USAGE_EDGE_PATH），不伪造捕获",
    );
  }

  const sourceHashes = collectSourceHashes(SOURCE_FILES, (relativePath) =>
    readFileSync(path.join(REPO_ROOT, relativePath)),
  );

  const preview = await startCandidatePreview({ candidate: candidateSnapshot, fixture, port });
  let browser = null;
  try {
    browser = await runtime.chromium.launch({
      executablePath: runtime.executablePath,
      headless: true,
    });

    const modeResults = {};
    for (const mode of modes) {
      modeResults[mode] = await captureMode({
        browser,
        previewUrl: preview.url,
        mode,
        skinId,
        candidate: candidateSnapshot,
        expectedPairs: expectedPairs[mode],
        outModeDir: path.join(resolvedOutDir, mode),
        stateTimeoutMs,
        policy: POLICY,
        measureRoles,
      });
    }

    const meta = {
      schemaVersion: 1,
      kind: "skin-palette-capture",
      tool: "scripts/skin-palette/capture.mjs",
      createdAt: new Date().toISOString(),
      candidate: productionMode
        ? { production: true, skinId }
        : {
            id: candidateSnapshot.id,
            candidateHash: candidateSnapshot.candidateHash,
            skinId: candidateSnapshot.skinId,
            variant: candidateSnapshot.variant,
            profileHash: candidateSnapshot.profileHash,
            policyHash: candidateSnapshot.policyHash,
            derivationHash: candidateSnapshot.derivationHash,
          },
      fixtureHash: typeof fixture?.fixtureHash === "string" ? fixture.fixtureHash : null,
      policyHash: sha256Canonical(POLICY),
      sourceHashes,
      environment: {
        node: process.version,
        browser: await browser.version(),
        viewport: { ...BASE_VIEWPORT },
        deviceScaleFactor: 1,
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        reducedMotion: "reduce",
        baselineStateId: BASELINE_STATE_ID,
      },
      stateTimeoutMs,
      modes: modeResults,
    };
    await writeJson(path.join(resolvedOutDir, "capture.json"), meta);
    return { outDir: resolvedOutDir, skinId, modes: modeResults, capture: meta };
  } finally {
    // fixture 生命周期归调用方：这里只关浏览器与预览服务（close 可重复调用）
    if (browser) await browser.close().catch(() => {});
    await preview.close();
  }
}

// ---------------------------------------------------------------------------
// M4.3 状态矩阵与可恢复执行
// ---------------------------------------------------------------------------

/**
 * M4.3 卡面矩阵（S0—S8 + D）。每次命令只捕获一个候选：先完成一个模式，再另一个
 * 模式；组内状态按列出顺序捕获；每状态独立 timeout（默认 15 秒；autorefresh-error
 * 的触发要连续拨动开关并等请求失败，单独放宽）与结果。
 *
 * 单元三种 kind：
 *   baseline  —— M4.2 首屏/基准（S0；证据落 <mode>/ 根，与 M4.2 布局一致）
 *   catalog   —— STATE_CATALOG 状态的触发→就绪→测量→恢复（证据落
 *                <mode>/states/<unitId>/：checks.json / geometry.json /
 *                state.png / region.png / state.json）
 *   procedure —— S3 来源排除生命周期，或卡面 S7 规程（主题往返 / 重载偏好 /
 *                character→classic→character）；动作取 catalog 词汇表
 *
 * 36 个 STATE_CATALOG 状态的全部归属：
 *   S0 dashboard-default（基准）；D 组与 S1 各复测一次
 *   S1 preset-selected / button-hover / keyboard-focus / quota-toast /
 *      menu-recent-open / skin-previews-visual / autorefresh-on / autorefresh-off /
 *      autorefresh-error（开启按钮仅由独立 autorefresh-on 状态测量，不借用基线角色）
 *   S2 calendar-open / calendar-range / comparison-trend-up / comparison-trend-down /
 *      calendar-same-day / empty-range
 *   S3 dialog-import-open / dialog-import-source-excluded / dialog-import-error / home-list-reason /
 *      home-source-excluded
 *   S4 dialog-pricing-open / pricing-input-filled / input-focus
 *   S5 dense-data / metric-record-visible / comparison-sort-active / bar-fill-visual
 *   S6 characters-off / characters-100 / spotlight-on×2 / spotlight-metric-label /
 *      spotlight-timeline-heading（时间分布标题组追加单元；卡面原固定顺序仍为
 *      (off,off) → (50%,off) → (100%,off) → (50%,on) → (100%,on)，50% 基准即 S0）
 *   S7 theme-dark（light↔dark 往返）/ skin-character-selected（classic 往返）
 *      ＋ 重载偏好（卡面规程，catalog 无对应状态）
 *   D  dashboard-default / dense-data（2560×1440 与 1280×720 两个桌面 CSS 视口，
 *      不重复全部弹窗状态）
 */
const BASELINE_UNIT_ID = "baseline";
/** S0 基准播种态同时满足的 catalog 状态（卡面矩阵 (50%, 聚光关) 单元，不重复捕获）。 */
const BASELINE_IMPLICIT_STATE_ID = "characters-50";
const PROGRESS_KIND = "skin-palette-capture-progress";
const CAPTURE_MATRIX_KIND = "skin-palette-capture-matrix";
const DESKTOP_VIEWPORTS = Object.freeze([
  Object.freeze({ width: 2560, height: 1440 }),
  Object.freeze({ width: 1280, height: 720 }),
]);
const DESKTOP_STATE_IDS = Object.freeze(["dashboard-default", "dense-data"]);

/** 卡面要求记录的目标机器人工复核项：脚本只能以 CSS 视口 + DPR 1 捕获，人工项明确列为未测。 */
const MATRIX_UNTESTED = Object.freeze([
  "目标机器的实际显示缩放 / 浏览器 zoom 人工复核（卡面要求记录一次；本矩阵只覆盖 CSS 视口与 deviceScaleFactor=1，人工项未执行）",
]);

/** 拨动型开关的幂等点击：until 已命中则不点（避免把已命中的状态点反）。 */
const ENSURE_CLICK_ACTIONS = Object.freeze(["ensureClick"]);

/**
 * catalog 步骤改写（roles.mjs 不在本卡允许文件内，矩阵侧显式适配）：
 * matchAction + matchSelector 命中的步骤整步换成 to，轨迹里留 rewrittenFrom。
 * 唯一用途：日期范围 catalog 状态的“清除日期范围”在无选区时是 disabled
 * 按钮，原样点击只会超时——而这一步的意图（确保起点没有选区）在禁用时已满足。
 */
function rewriteCatalogStep(step, rewrites) {
  if (!Array.isArray(rewrites) || rewrites.length === 0) return step;
  for (const rewrite of rewrites) {
    if (!rewrite || typeof rewrite.matchSelector !== "string" || typeof rewrite.to !== "object") continue;
    if (rewrite.matchSelector !== step.selector) continue;
    if ((rewrite.matchAction ?? null) !== (step.action ?? null)) continue;
    return { ...step, ...rewrite.to, rewrittenFrom: { action: step.action, selector: step.selector } };
  }
  return step;
}

const STATE_MATRIX_GROUPS = Object.freeze([
  {
    id: "S0",
    label: "基准（两模式、1920×1080、角色 50%、聚光关闭）",
    units: [{ id: BASELINE_UNIT_ID, kind: "baseline" }],
  },
  {
    id: "S1",
    label: "工具栏（preset default/hover/selected、主题/刷新控件、keyboard focus）",
    units: [
      {
        id: "autorefresh-on",
        kind: "catalog",
        stateId: "autorefresh-on",
        note: "独立测量自动刷新开启按钮；catalog 先选『全部』并用 ensureClick 幂等确保 aria-pressed=true。恢复为空，后续 autorefresh-off/autorefresh-error 均从开启态出发",
      },
      { id: "preset-selected", kind: "catalog", stateId: "preset-selected", clipSelector: "#presetButtons" },
      {
        id: "button-hover",
        kind: "catalog",
        stateId: "button-hover",
        clipSelector: "#addImportButton",
        preserveTriggerViewport: true,
      },
      {
        id: "keyboard-focus",
        kind: "catalog",
        stateId: "keyboard-focus",
        clipSelector: ".toolbar",
        // focus.outline 在 M0 目录里是句人话不是选择器（机测恒 unmeasured），卡面要求
        // "局部截图与对应角色测量"、M3.2 注释要求原尺寸截图人工核验——被 Tab 命中的
        // #addImportButton 在首屏之外（底部"扫描目录"面板），补一张滚动后的元素图
        evidenceTargets: ["#addImportButton"],
      },
      {
        id: "quota-toast",
        kind: "catalog",
        stateId: "quota-toast",
        clipSelector: "#presetButtons",
        precondition: {
          selector: "#quotaPresetToggle:not([disabled])",
          note: "fixture3 含可选中的空 Codex 主来源，按钮可用但没有额度窗口；toast 展示窗口不可用提示，不代表已有真实额度数据。实际可达性仍由此 selector 判断。",
        },
      },
      { id: "menu-recent-open", kind: "catalog", stateId: "menu-recent-open", clipSelector: "#presetButtons" },
      { id: "skin-previews-visual", kind: "catalog", stateId: "skin-previews-visual", clipSelector: "#skinDialog" },
      { id: "autorefresh-off", kind: "catalog", stateId: "autorefresh-off", clipSelector: ".auto-refresh-well" },
      {
        id: "autorefresh-error",
        kind: "catalog",
        stateId: "autorefresh-error",
        clipSelector: ".auto-refresh-well",
        routeFault: "/api/usage",
        readyTimeoutMs: 20000,
        preSteps: [
          { action: "click", selector: "#autoRefreshToggle" },
          { action: "ensureClick", selector: "#autoRefreshToggle", until: '#autoRefreshToggle[aria-pressed="true"]' },
        ],
        recovery: {
          unrouteFault: true,
          steps: [
            { action: "click", selector: "#autoRefreshToggle" },
            { action: "ensureClick", selector: "#autoRefreshToggle", until: '#autoRefreshToggle[aria-pressed="true"]' },
          ],
          expectGone: ".auto-refresh-error.is-error",
        },
        note: "触发：路由中止 /api/usage 后拨动开关——关/开两个方向都会立刻重拉 usage 并失败，错误提示随即出现；随后 ensureClick 保证取证时开关停在开启态（catalog 注释要求“开启态下的失败”）。恢复：还原路由后再拨动一次（成功加载清除错误）并 ensureClick 回到开启态——catalog 的 restore 为空、只靠下一次轮询自然清除要等 60s，且“不得把开关留在关闭态”，故用开关自身完成确定性恢复并在轨迹里留痕",
      },
    ],
  },
  {
    id: "S2",
    label: "日期（上/下行、同日范围与空态）",
    units: [
      { id: "calendar-open", kind: "catalog", stateId: "calendar-open", clipSelector: ".date-picker-popover" },
      {
        id: "calendar-range",
        kind: "catalog",
        stateId: "calendar-range",
        clipSelector: ".date-picker-popover",
        stepRewrites: [
          {
            matchAction: "click",
            matchSelector: "[data-date-picker-clear]",
            to: { action: "clickIfEnabled" },
          },
        ],
        postSteps: [{ action: "click", selector: "#dateRangeButton" }],
        note: "选完终点后日期弹层自动关闭并重开，仅捕获日期选区；清除按钮在无选区时 disabled，改写为点击-if-enabled",
      },
      {
        id: "comparison-trend-up",
        kind: "catalog",
        stateId: "comparison-trend-up",
        clipSelector: "#comparisonSummary",
        restorePreSteps: [{ action: "click", selector: "#dateRangeButton" }],
        stepRewrites: [
          {
            matchAction: "click",
            matchSelector: "[data-date-picker-clear]",
            to: { action: "clickIfEnabled" },
          },
        ],
        note: "选择终点后弹层自动关闭；闭层测量上行摘要，恢复先重开日历，再由 catalog restore 清空并关闭",
      },
      {
        id: "comparison-trend-down",
        kind: "catalog",
        stateId: "comparison-trend-down",
        clipSelector: "#comparisonSummary",
        restorePreSteps: [{ action: "click", selector: "#dateRangeButton" }],
        stepRewrites: [
          {
            matchAction: "click",
            matchSelector: "[data-date-picker-clear]",
            to: { action: "clickIfEnabled" },
          },
        ],
        note: "选择终点后弹层关闭；下行 ready 在闭层状态确认。恢复先重开日历，再由 catalog restore 清空并关闭",
      },
      {
        id: "calendar-same-day",
        kind: "catalog",
        stateId: "calendar-same-day",
        clipSelector: ".date-picker-popover",
        stepRewrites: [
          {
            matchAction: "click",
            matchSelector: "[data-date-picker-clear]",
            to: { action: "clickIfEnabled" },
          },
        ],
        postSteps: [{ action: "click", selector: "#dateRangeButton" }],
        note: "同日第二次选择会关闭弹层；重开后才等待同一日期格的 range-start 与 range-end 双类",
      },
      {
        id: "empty-range",
        kind: "catalog",
        stateId: "empty-range",
        clipSelector: ".date-picker-popover",
        restorePreSteps: [{ action: "click", selector: "#dateRangeButton" }],
        stepRewrites: [
          {
            matchAction: "click",
            matchSelector: "[data-date-picker-clear]",
            to: { action: "clickIfEnabled" },
          },
        ],
      },
    ],
  },
  {
    id: "S3",
    label: "来源（导入弹窗、长路径与目录选择、筛选开关、错误提示、保存来源原因）",
    units: [
      {
        id: "dialog-import-open",
        kind: "catalog",
        stateId: "dialog-import-open",
        clipSelector: "#importDialog",
        importControls: true,
      },
      {
        id: "dialog-import-source-excluded",
        kind: "procedure",
        handler: "source-excluded",
        stateId: "dialog-import-source-excluded",
        clipSelector: "#sourcePicker",
      },
      { id: "dialog-import-error", kind: "catalog", stateId: "dialog-import-error", clipSelector: "#importDialog" },
      {
        id: "home-list-reason",
        kind: "catalog",
        stateId: "home-list-reason",
        clipSelector: "#homeList",
        evidenceTargets: ["#homeList .home-reason"],
      },
      {
        id: "home-source-excluded",
        kind: "procedure",
        handler: "home-source-excluded",
        stateId: "home-source-excluded",
        clipSelector: "#homeList",
      },
    ],
  },
  {
    id: "S4",
    label: "计价（计价弹窗、非零费用、缺价徽标、填值与焦点）",
    units: [
      { id: "dialog-pricing-open", kind: "catalog", stateId: "dialog-pricing-open", clipSelector: "#pricingDialog" },
      { id: "pricing-input-filled", kind: "catalog", stateId: "pricing-input-filled", clipSelector: "#pricingDialog" },
      { id: "input-focus", kind: "catalog", stateId: "input-focus", clipSelector: "#pricingDialog" },
    ],
  },
  {
    id: "S5",
    label: "图表/表格（model/channel 视图、排序指示、多系列与密集行）",
    units: [
      {
        id: "dense-data",
        kind: "catalog",
        stateId: "dense-data",
        timelineModeSequence: ["model", "cost"],
      },
      {
        id: "metric-record-visible",
        kind: "catalog",
        stateId: "metric-record-visible",
        clipSelector: ".metric:has(#totalTokens)",
        restorePreSteps: [{ action: "click", selector: "#dateRangeButton" }],
        stepRewrites: [
          {
            matchAction: "click",
            matchSelector: "[data-date-picker-clear]",
            to: { action: "clickIfEnabled" },
          },
        ],
        note: "选 2026-09-28 至 2026-10-04 后日期弹层自动关闭；恢复先重开日历，再清空选区、关闭弹层并切回『全部』",
      },
      {
        id: "comparison-sort-active",
        kind: "catalog",
        stateId: "comparison-sort-active",
        clipSelector: "#modelComparisonTable",
      },
      { id: "bar-fill-visual", kind: "catalog", stateId: "bar-fill-visual", clipSelector: ".timeline-chart-well" },
    ],
  },
  {
    id: "S6",
    label: "角色干扰（角色关闭与 100%、语言/指标/时间分布/详情文字聚光；50% 已在 S0）",
    units: [
      { id: "characters-off", kind: "catalog", stateId: "characters-off", clipSelector: "#skinCharacters" },
      { id: "characters-100", kind: "catalog", stateId: "characters-100", clipSelector: "#skinCharacters" },
      {
        id: "spotlight-on",
        kind: "catalog",
        stateId: "spotlight-on",
        clipSelector: ".topbar",
        // 聚光是"指针当前落在哪个表面"的派生态：上一个单元遗留的鼠标位置可能正好
        // 压在 .topbar 上，入口就绪会被误命中，点亮/熄灭两条路径就一次都没真跑。
        // 先按凹陷面把指针归位，再由 catalog 步骤真实点亮，收尾再真实熄灭。
        preSteps: [{ action: "setSpotlight", value: "off" }],
      },
      {
        id: "spotlight-on-characters-100",
        kind: "catalog",
        stateId: "spotlight-on",
        clipSelector: ".topbar",
        preSteps: [
          { action: "setSpotlight", value: "off" },
          { action: "setOpacity", value: "1" },
        ],
        postRestoreSteps: [{ action: "setOpacity", value: "0.5" }],
        note: "卡面固定顺序第 5 步 (100%, on)：聚光开启 + 角色 100% 组合；角色测量沿用 catalog 的 spotlight-on（stateId 不变，单元 id 区分组合）",
      },
      {
        id: "spotlight-language-selected",
        kind: "catalog",
        stateId: "spotlight-language-selected",
        clipSelector: "#languageToggle",
        preserveTriggerViewport: true,
        preSteps: [{ action: "setSpotlight", value: "off" }],
      },
      {
        id: "spotlight-metric-label",
        kind: "catalog",
        stateId: "spotlight-metric-label",
        clipSelector: ".metric:has(> #totalTokens)",
        preserveTriggerViewport: true,
        preSteps: [
          { action: "click", selector: '#presetButtons button[data-preset="all"]' },
          { action: "setSpotlight", value: "off" },
        ],
      },
      {
        id: "spotlight-timeline-heading",
        kind: "catalog",
        stateId: "spotlight-timeline-heading",
        clipSelector: ".chart-panel",
        preserveTriggerViewport: true,
        preSteps: [
          { action: "click", selector: '#presetButtons button[data-preset="all"]' },
          { action: "setSpotlight", value: "off" },
        ],
      },
      {
        id: "spotlight-detail-bars",
        kind: "catalog",
        stateId: "spotlight-detail-bars",
        clipSelector: "#detailPanel",
        preserveTriggerViewport: true,
        preSteps: [
          { action: "click", selector: '#presetButtons button[data-preset="all"]' },
          { action: "click", selector: '#timelineModes [data-timeline-mode="channel"]' },
          { action: "setSpotlight", value: "off" },
        ],
      },
      {
        id: "spotlight-detail-fill",
        kind: "catalog",
        stateId: "spotlight-detail-fill",
        clipSelector: "#detailPanel",
        preserveTriggerViewport: true,
        preSteps: [
          { action: "click", selector: '#presetButtons button[data-preset="all"]' },
          { action: "click", selector: '#timelineModes [data-timeline-mode="channel"]' },
          { action: "setSpotlight", value: "off" },
        ],
      },
    ],
  },
  {
    id: "S7",
    label: "恢复（light→dark→light、重载偏好、character→classic→character）",
    units: [
      { id: "theme-roundtrip", kind: "procedure", handler: "theme-roundtrip", stateId: "theme-dark" },
      { id: "reload-preferences", kind: "procedure", handler: "reload-preferences" },
      { id: "skin-roundtrip", kind: "procedure", handler: "skin-roundtrip", stateId: "skin-character-selected" },
    ],
  },
  {
    id: "S8",
    label: "超长时间线范围告警（独立 fixture）",
    units: [
      {
        id: "timeline-range-warning",
        kind: "catalog",
        stateId: "timeline-range-warning",
        clipSelector: "#timelineRangeWarning",
        fixtureRequirement: {
          name: "timeline-range-warning",
          expectedHash: getTimelineWarningFixtureHash(),
        },
        // 入口先清掉 all 基线已有告警，避免 entry-ready 对称跳过，catalog 步骤再切回 all。
        preSteps: [
          {
            action: "click",
            selector: '#presetButtons button[data-preset="today"]',
            until: 'body:has(#presetButtons button[data-preset="today"].active) #timelineRangeWarning[hidden]',
          },
        ],
        recovery: {
          steps: [],
          // 此检查位于共享 rebaselineToAll 前；variant 最终 all 基线可以再次显示告警。
          expectGone: "#timelineRangeWarning:not([hidden])",
        },
      },
    ],
  },
  {
    id: "D",
    label: "桌面缩放（2560×1440 与 1280×720 窄桌面 CSS 视口；不重复全部弹窗状态）",
    units: DESKTOP_VIEWPORTS.flatMap((viewport) =>
      DESKTOP_STATE_IDS.map((stateId) => ({
        id: `d${viewport.width}x${viewport.height}-${stateId}`,
        kind: "catalog",
        stateId,
        viewport,
      })),
    ),
  },
]);

function assertFixedMatrixGroupsAndBaseHash(groups, fixtureHash) {
  if (!Array.isArray(groups) || groups.length === 0) {
    throw new TypeError("fixed matrix fixture bindings: groups must be a non-empty array");
  }
  const seen = new Set();
  for (const groupId of groups) {
    if (
      typeof groupId !== "string" ||
      !STATE_MATRIX_GROUPS.some((group) => group.id === groupId) ||
      seen.has(groupId)
    ) {
      throw new TypeError(`fixed matrix fixture bindings: invalid or duplicate group ${String(groupId)}`);
    }
    seen.add(groupId);
  }
  if (fixtureHash !== getPaletteFixtureHash()) {
    throw new TypeError("fixed matrix fixture bindings: fixtureHash must match the base fixture");
  }
}

function isExactPlainRecord(value, keys) {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return false;
    }
    const ownKeys = Reflect.ownKeys(value);
    return (
      ownKeys.length === keys.length &&
      keys.every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value");
      })
    );
  } catch {
    return false;
  }
}

export function buildFixedMatrixFixtureBindings({ groups, fixtureHash, warningFixtureHash }) {
  assertFixedMatrixGroupsAndBaseHash(groups, fixtureHash);
  if (warningFixtureHash !== getTimelineWarningFixtureHash()) {
    throw new TypeError("fixed matrix fixture bindings: warningFixtureHash must match the timeline warning fixture");
  }
  return Object.freeze(
    Object.fromEntries(
      groups.map((groupId) => [
        groupId,
        Object.freeze(
          groupId === "S8"
            ? { fixtureKind: "timeline-range-warning", fixtureHash: warningFixtureHash }
            : { fixtureKind: "base", fixtureHash },
        ),
      ]),
    ),
  );
}

export function assertFixedMatrixFixtureBindings({ groups, fixtureHash, fixtureBindings }) {
  assertFixedMatrixGroupsAndBaseHash(groups, fixtureHash);
  if (!isExactPlainRecord(fixtureBindings, groups)) {
    throw new TypeError("fixed matrix fixture bindings: fixtureBindings keys must exactly match groups");
  }
  for (const groupId of groups) {
    const isWarning = groupId === "S8";
    const binding = fixtureBindings[groupId];
    if (
      !isExactPlainRecord(binding, ["fixtureKind", "fixtureHash"]) ||
      binding.fixtureKind !== (isWarning ? "timeline-range-warning" : "base") ||
      binding.fixtureHash !== (isWarning ? getTimelineWarningFixtureHash() : fixtureHash)
    ) {
      throw new TypeError(`fixed matrix fixture bindings: invalid binding for group ${groupId}`);
    }
  }
}

const STATE_BY_ID = new Map(STATE_CATALOG.map((state) => [state.id, state]));

/** 矩阵有效单元列表：S0—S8 按定义顺序（baseline 在前），D 组按视口顺序。 */
function effectiveMatrixUnits(groupIds) {
  const byId = new Map(STATE_MATRIX_GROUPS.map((group) => [group.id, group]));
  const units = [];
  for (const groupId of groupIds) {
    const group = byId.get(groupId);
    for (const unit of group.units) units.push({ ...unit, group: groupId, groupLabel: group.label });
  }
  return units;
}

/** 状态覆盖率（stateId → 覆盖它的单元 id 列表；规程单元按登记的 catalog stateId 归属）。 */
export function describeMatrixCoverage(groupIds = null) {
  const groups = groupIds ?? STATE_MATRIX_GROUPS.map((group) => group.id);
  const coverage = new Map();
  const add = (stateId, unitId) => {
    if (!coverage.has(stateId)) coverage.set(stateId, []);
    coverage.get(stateId).push(unitId);
  };
  for (const unit of effectiveMatrixUnits(groups)) {
    if (unit.kind === "baseline") {
      // S0 基准同时就是卡面矩阵的 (角色 50%, 聚光关) 单元——catalog 的 characters-50
      // 步骤（setCharacters on + setOpacity 0.5）正是基准播种态（首屏/测量都按它
      // 捕获），重复捕获只会得到同一张证据，故覆盖率按两个状态登记
      add(BASELINE_STATE_ID, unit.id);
      add(BASELINE_IMPLICIT_STATE_ID, unit.id);
      continue;
    }
    if (typeof unit.stateId !== "string") continue;
    add(unit.stateId, unit.id);
  }
  return coverage;
}

/** 状态就绪等待源（STATE_CATALOG 的 ready.kind → 布尔等待源；waitForFunction 要布尔返回值）。 */
export function buildStateReadyWaitSource(ready) {
  if (!ready || typeof ready !== "object" || Array.isArray(ready) || typeof ready.kind !== "string") {
    throw new TypeError("buildStateReadyWaitSource: ready 必须是 STATE_CATALOG 的就绪描述对象");
  }
  const selector = JSON.stringify(ready.selector);
  switch (ready.kind) {
    case "matches":
    case "exists":
      // matches：选择器命中即就绪（.active / :focus-visible / aria-pressed 等）
      return `(() => Boolean(document.querySelector(${selector})))()`;
    case "visible":
      return `(() => {
  const node = document.querySelector(${selector});
  if (!node) return false;
  const rect = node.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && getComputedStyle(node).visibility !== "hidden";
})()`;
    case "nonZeroText":
      return `(() => {
  const parseMetricNumber = ${parseMetricNumber.toString()};
  const nodes = Array.from(document.querySelectorAll(${selector}));
  if (nodes.length === 0) return false;
  return nodes.some((node) => (parseMetricNumber(node.textContent ?? "") ?? 0) > 0);
})()`;
    case "dataCount": {
      if (!Number.isInteger(ready.min) || ready.min <= 0) {
        throw new TypeError("buildStateReadyWaitSource: dataCount 就绪需要正整数 min");
      }
      return `(() => document.querySelectorAll(${selector}).length >= ${ready.min})()`;
    }
    case "spotlightHost":
      if (typeof ready.selector !== "string" || !ready.selector.trim()) {
        throw new TypeError("buildStateReadyWaitSource: spotlightHost 就绪需要 selector");
      }
      return `(() => {
  try {
    const matches = document.querySelectorAll(${selector});
    if (matches.length !== 1) return false;
    const node = matches[0];
    if (!node.isConnected) return false;
    const activeHosts = document.querySelectorAll(".shell [data-spotlight-active]");
    if (activeHosts.length !== 1 || activeHosts[0] !== node) return false;
    const rect = node.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0) || node.getClientRects().length === 0) return false;
    const hostStyle = getComputedStyle(node);
    if (hostStyle.display === "none" || hostStyle.visibility === "hidden" || hostStyle.visibility === "collapse") {
      return false;
    }
    const hostOpacity = Number.parseFloat(hostStyle.opacity);
    if (!Number.isFinite(hostOpacity) || hostOpacity <= 0) return false;
    const after = getComputedStyle(node, "::after");
    if (typeof after.content !== "string" || after.content === "none" || after.content === "normal") return false;
    if (after.display === "none" || after.visibility === "hidden") return false;
    // Computed opacity accepts reduced-motion's transition:none and waits out normal transitions.
    return (
      after.opacity === "1" &&
      typeof after.backgroundImage === "string" &&
      after.backgroundImage !== "none" &&
      typeof after.maskImage === "string" &&
      after.maskImage !== "none"
    );
  } catch {
    return false;
  }
})()`;
    default:
      throw new TypeError(`buildStateReadyWaitSource: 未知就绪类型 "${String(ready.kind)}"`);
  }
}

/**
 * 日历翻月计划（纯函数）：从当前视图月导航到目标日期所在月。日期弹层是 42 格
 * 网格（含相邻月边缘日）， executor 只在目标日期单元格不存在时才调用本计划；
 * 月份文本读不到时退化为逐次 prev/next 试触。
 */
export function planMonthNavigation(from, targetDate) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(targetDate ?? ""));
  if (!match) {
    throw new TypeError(`planMonthNavigation: targetDate 必须是 YYYY-MM-DD（收到 ${JSON.stringify(targetDate)}）`);
  }
  const fromYear = Number(from?.year);
  const fromMonth = Number(from?.month);
  if (!Number.isInteger(fromYear) || !Number.isInteger(fromMonth) || fromMonth < 1 || fromMonth > 12) {
    throw new TypeError("planMonthNavigation: from 必须是 { year, month(1-12) }");
  }
  const diff = (Number(match[1]) - fromYear) * 12 + (Number(match[2]) - fromMonth);
  if (diff === 0) return { action: "none", clicks: 0 };
  return diff < 0 ? { action: "prev", clicks: -diff } : { action: "next", clicks: diff };
}

/** 从 .date-picker-day[data-date="YYYY-MM-DD"] 选择器里取日期；不是日期格则返回 null。 */
function calendarDayFromSelector(selector) {
  const match = /^\.date-picker-day\[data-date="(\d{4}-\d{2}-\d{2})"\]$/.exec(String(selector ?? ""));
  return match ? match[1] : null;
}

/**
 * 状态单元的错误阻断（纯函数）：被记录的四类错误（未捕获异常 / console 错误 /
 * 请求失败 / ≥400 响应）逐项阻断——与 buildResourceBlockers 同一语义，但模块
 * 请求数与角色解码是“每上下文一次”的基准判据，不在单元级重复。
 */
export function buildStateBlockers(errors) {
  const blockers = [];
  if (!errors || typeof errors !== "object") return blockers;
  for (const key of ["pageErrors", "consoleErrors", "requestFailed", "resourceFailures"]) {
    const list = Array.isArray(errors[key]) ? errors[key] : [];
    if (list.length > 0) {
      blockers.push(`${ERROR_CLASS_LABELS[key]}（${list.length}）：${JSON.stringify(list)}`);
    }
  }
  return blockers;
}

/** 只分类已取得原响应的精确 quota 等待；采集和实际放行由后续调用方负责。 */
export function classifyExpectedQuotaErrors({ errors, scope, responses, consoles }) {
  const keys = ["pageErrors", "consoleErrors", "requestFailed", "resourceFailures", "blockedExternal"];
  if (
    !errors ||
    !keys.every((key) => Array.isArray(errors[key])) ||
    !Array.isArray(responses) ||
    !Array.isArray(consoles)
  ) {
    throw new TypeError("classifyExpectedQuotaErrors: errors 五个数组及 responses/consoles 数组必须存在");
  }
  const scopedErrors = { ...errors };
  for (const key of keys) scopedErrors[key] = errors[key].slice();
  const expectedErrors = { resourceFailures: [], consoleErrors: [] };
  const matches = [];
  const rejected = [];
  const result = { scopedErrors, expectedErrors, matches, rejected };
  const identity = (value) =>
    (typeof value === "string" && value.trim().length > 0) || (Number.isSafeInteger(value) && value > 0);
  const order = (value) => Number.isSafeInteger(value) && value >= 0;
  let origin;
  try {
    origin = new URL(scope?.origin);
  } catch {
    origin = null;
  }
  if (
    !identity(scope?.id) ||
    !identity(scope?.pageId) ||
    scope.unitId !== "quota-toast" ||
    scope.stateId !== "quota-toast" ||
    !["light", "dark"].includes(scope.mode) ||
    !Number.isSafeInteger(scope.attempt) ||
    scope.attempt < 1 ||
    scope.triggerSucceeded !== true ||
    !order(scope.startOrder) ||
    !order(scope.endOrder) ||
    scope.startOrder >= scope.endOrder ||
    !origin ||
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== scope.origin
  ) {
    rejected.push({ kind: "scope", reason: "无效或非 quota-toast 的成功触发窗口" });
    return result;
  }
  const inScope = responses.filter((entry) => entry?.scopeId === scope.id);
  const accepted = [];
  const resources = new Set();
  const consoleIndexes = new Set();
  for (const [index, entry] of responses.entries()) {
    let url;
    try {
      url = new URL(entry?.url);
    } catch {
      url = null;
    }
    const original = errors.resourceFailures[entry?.resourceFailureIndex];
    let reason = null;
    if (!entry || entry.scopeId !== scope.id || entry.pageId !== scope.pageId) reason = "scope/page 不匹配";
    else if (typeof entry.requestId !== "string" || !entry.requestId.trim()) reason = "缺少非空 requestId";
    else if (
      inScope.filter((other) => other.requestId === entry.requestId).length !== 1 ||
      inScope.filter((other) => other.url === entry.url).length !== 1 ||
      inScope.filter((other) => other.resourceFailureIndex === entry.resourceFailureIndex).length !== 1
    )
      reason = "requestId、同完整 URL 请求或资源 index 存在歧义";
    else if (
      entry.method !== "GET" ||
      typeof entry.url !== "string" ||
      entry.url.trim() !== entry.url ||
      !url ||
      url.origin !== scope.origin ||
      url.pathname !== "/api/usage" ||
      url.username ||
      url.password ||
      url.hash ||
      url.searchParams.getAll("preset").length !== 1 ||
      url.searchParams.get("preset") !== "quota_5h" ||
      url.searchParams.getAll("bucket").length !== 1 ||
      url.searchParams.get("bucket") !== "quota_30m"
    )
      reason = "请求方法、origin/path 或精确 quota 查询不匹配";
    else if (
      entry.status !== 409 ||
      entry.bodyReadStatus !== "parsed" ||
      entry.bodyCode !== "QUOTA_WINDOW_UNAVAILABLE"
    ) {
      reason = "未证实 409 QUOTA_WINDOW_UNAVAILABLE 原响应";
    } else if (
      !order(entry.requestOrder) ||
      !order(entry.responseOrder) ||
      entry.requestOrder <= scope.startOrder ||
      entry.responseOrder <= entry.requestOrder ||
      entry.responseOrder >= scope.endOrder
    )
      reason = "请求/响应不在成功触发窗口内或顺序无效";
    else if (
      !Number.isSafeInteger(entry.resourceFailureIndex) ||
      entry.resourceFailureIndex < 0 ||
      !original ||
      original.url !== entry.url ||
      original.status !== entry.status
    )
      reason = "原 resourceFailures 的 index/url/status 不匹配";
    if (reason) {
      rejected.push({ kind: "response", index, reason });
      continue;
    }
    resources.add(entry.resourceFailureIndex);
    accepted.push(entry);
    matches.push({
      requestId: entry.requestId,
      resourceFailureIndex: entry.resourceFailureIndex,
      binding: "EXACT_RESPONSE_METADATA",
      basis: "scope/page、完整 URL、原资源 index/status、业务 code 及窗口顺序一致",
    });
  }
  const resourceConsole = "Failed to load resource: the server responded with a status of 409 (Conflict)";
  for (const [index, entry] of consoles.entries()) {
    const candidates = accepted.filter(
      (response) =>
        response.url === entry?.locationUrl &&
        order(entry?.order) &&
        entry.order > response.responseOrder &&
        entry.order < scope.endOrder,
    );
    let reason = null;
    if (!entry || entry.scopeId !== scope.id || entry.pageId !== scope.pageId) reason = "console scope/page 不匹配";
    else if (
      !Number.isSafeInteger(entry.index) ||
      entry.index < 0 ||
      entry.index >= errors.consoleErrors.length ||
      errors.consoleErrors[entry.index] !== entry.text ||
      entry.text !== resourceConsole
    )
      reason = "原 console index/text 或精确 409 文本不匹配";
    else if (consoles.filter((other) => other?.scopeId === scope.id && other.index === entry.index).length !== 1) {
      reason = "console index 证据重复，无法唯一绑定";
    } else if (typeof entry.locationUrl !== "string" || !entry.locationUrl || candidates.length !== 1) {
      reason = "console 来源、响应后窗口顺序或唯一候选请求未证实";
    }
    if (reason) {
      rejected.push({ kind: "console", index, reason });
      continue;
    }
    const response = candidates[0];
    consoleIndexes.add(entry.index);
    matches.push({
      requestId: response.requestId,
      resourceFailureIndex: response.resourceFailureIndex,
      consoleErrorIndex: entry.index,
      binding: "INFERRED_UNIQUE",
      basis: "同 scope/page、原 console index/text、完整 location URL、实际响应后的窗口顺序；非原生 console request ID",
    });
  }
  for (const [key, indexes] of [
    ["resourceFailures", resources],
    ["consoleErrors", consoleIndexes],
  ]) {
    expectedErrors[key] = errors[key].filter((_entry, index) => indexes.has(index));
    scopedErrors[key] = errors[key].filter((_entry, index) => !indexes.has(index));
    for (const index of errors[key].keys()) {
      if (!indexes.has(index)) rejected.push({ kind: key, index, reason: "该原错误缺少唯一完整匹配证据，继续阻断" });
    }
  }
  return result;
}

let quotaRecorderSequence = 0;

/** 事件 handler 的事实记录组件；本身不注册 listener，也不分类或删除原错误。 */
export function createQuotaEvidenceRecorder({ page, errors, origin }) {
  const keys = ["pageErrors", "consoleErrors", "requestFailed", "resourceFailures", "blockedExternal"];
  if (!page || !errors || !keys.every((key) => Array.isArray(errors[key])) || new URL(origin).origin !== origin) {
    throw new TypeError("createQuotaEvidenceRecorder: page、原错误数组及精确 origin 必须存在");
  }
  const pageId = `quota-page-${++quotaRecorderSequence}`;
  const requests = new WeakMap();
  const history = [];
  let sequence = 0;
  let windowNumber = 0;
  let current = null;
  const active = () => (current && current.scope.endOrder === null ? current : null);
  const relatedUrl = (value) => {
    try {
      const url = new URL(value);
      return url.origin === origin && url.pathname === "/api/usage" ? url : null;
    } catch {
      return null;
    }
  };
  const relativeIndex = (index, start, list) =>
    Number.isSafeInteger(index) && index >= start && index < list.length ? index - start : null;
  const messageOf = (error) => (error instanceof Error ? error.message : String(error));
  const recorder = {
    begin({ mode, attempt, unitId, stateId }) {
      if (active()) throw new Error("quota 前一触发窗口尚未结束");
      current = {
        scope: {
          id: `${pageId}-window-${++windowNumber}`,
          pageId,
          mode,
          attempt,
          unitId,
          stateId,
          origin,
          triggerSucceeded: false,
          startOrder: ++sequence,
          endOrder: null,
        },
        resourceStart: errors.resourceFailures.length,
        consoleStart: errors.consoleErrors.length,
        responses: [],
        consoles: [],
        pending: new Set(),
        snapshot: null,
        triggerMarked: false,
      };
    },
    markTriggerResult(ok) {
      if (!active() || current.triggerMarked) throw new Error("quota trigger 结果必须在活动窗口且仅记录一次");
      ++sequence;
      current.triggerMarked = true;
      current.scope.triggerSucceeded = ok === true;
    },
    endWindow() {
      if (!current) throw new Error("quota 尚未 begin");
      current.scope.endOrder ??= ++sequence;
    },
    onRequest(request) {
      const requestOrder = ++sequence;
      let url;
      let method;
      try {
        url = request.url();
        method = request.method();
      } catch {
        return;
      }
      if (!relatedUrl(url) || requests.has(request)) return;
      const owner = active();
      let pageMatches = false;
      let pageReason = null;
      try {
        pageMatches = request.frame().page() === page;
      } catch (error) {
        pageReason = messageOf(error);
      }
      const entry = {
        requestId: `${pageId}-request-${history.length + 1}`,
        scopeId: pageMatches ? (owner?.scope.id ?? null) : null,
        pageId: pageMatches ? pageId : null,
        method,
        url,
        requestOrder,
        responseOrder: null,
        status: null,
        resourceFailureIndex: null,
        bodyReadStatus: "not-received",
        bodyCode: null,
        ...(pageMatches ? {} : { pageReason: pageReason ?? "request.frame().page() 不是本 page" }),
      };
      const tracked = { entry, owner, pageMatches };
      requests.set(request, tracked);
      history.push(tracked);
      if (owner) owner.responses.push(entry);
    },
    onResponse(response, resourceFailureIndex) {
      const responseOrder = ++sequence;
      let tracked;
      let url;
      let status;
      try {
        tracked = requests.get(response.request());
        url = response.url();
        status = response.status();
      } catch {
        return;
      }
      if (!tracked) {
        const owner = active();
        if (owner && relatedUrl(url))
          owner.responses.push({
            requestId: null,
            scopeId: null,
            pageId: null,
            url,
            status,
            requestOrder: null,
            responseOrder,
            resourceFailureIndex: relativeIndex(resourceFailureIndex, owner.resourceStart, errors.resourceFailures),
            bodyReadStatus: "unbound-request",
            bodyCode: null,
          });
        return;
      }
      const { entry, owner, pageMatches } = tracked;
      if (entry.responseOrder !== null) return;
      entry.responseOrder = responseOrder;
      entry.status = status;
      entry.responseUrl = url;
      entry.resourceFailureIndex = owner
        ? relativeIndex(resourceFailureIndex, owner.resourceStart, errors.resourceFailures)
        : null;
      const parsedUrl = relatedUrl(entry.url);
      if (
        !owner ||
        !pageMatches ||
        url !== entry.url ||
        status !== 409 ||
        entry.method !== "GET" ||
        parsedUrl.searchParams.getAll("preset").length !== 1 ||
        parsedUrl.searchParams.get("preset") !== "quota_5h" ||
        parsedUrl.searchParams.getAll("bucket").length !== 1 ||
        parsedUrl.searchParams.get("bucket") !== "quota_30m" ||
        (owner.scope.endOrder !== null && responseOrder >= owner.scope.endOrder)
      ) {
        entry.bodyReadStatus = "not-eligible";
        return;
      }
      entry.bodyReadStatus = "pending";
      const task = Promise.resolve()
        .then(() => response.body())
        .then((value) => {
          const bytes = Buffer.from(value);
          entry.bodyText = bytes.toString("utf8");
          entry.bodyBytes = bytes.length;
          entry.bodySha256 = createHash("sha256").update(bytes).digest("hex");
          let body;
          try {
            body = JSON.parse(entry.bodyText);
          } catch (error) {
            entry.bodyReadStatus = "invalid-json";
            entry.bodyError = messageOf(error);
            return;
          }
          if (
            !body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            typeof body.code !== "string" ||
            !body.code.trim()
          ) {
            entry.bodyReadStatus = "invalid-body";
            entry.bodyError = "原 body 必须为含非空 code 的对象";
            return;
          }
          entry.bodyCode = body.code;
          entry.bodyReadStatus = "parsed";
        })
        .catch((error) => {
          entry.bodyReadStatus = "read-failed";
          entry.bodyError = messageOf(error);
        })
        .finally(() => owner.pending.delete(task));
      owner.pending.add(task);
    },
    onConsole(message, consoleErrorIndex) {
      const order = ++sequence;
      const owner = active();
      if (!owner) return;
      let text;
      let location;
      try {
        text = message.text();
        location = message.location();
      } catch {
        return;
      }
      const locationUrl = typeof location?.url === "string" ? location.url : null;
      // 同 URL 的旧窗口/未知 page/并发请求不能从 console 原文获得原生身份。
      const related = history.filter(({ entry }) => entry.url === locationUrl);
      const ambiguous = related.length !== 1 || related[0].owner !== owner || !related[0].pageMatches;
      owner.consoles.push({
        scopeId: ambiguous ? null : owner.scope.id,
        pageId,
        index: relativeIndex(consoleErrorIndex, owner.consoleStart, errors.consoleErrors),
        order,
        text,
        locationUrl,
        location: structuredClone(location ?? null),
        ...(ambiguous ? { scopeReason: "同 URL 的其它窗口、并发或未知 page 请求，console 来源缺证" } : {}),
      });
    },
    settleAndSnapshot() {
      const owner = current;
      if (!owner) return Promise.reject(new Error("quota 尚未 begin"));
      if (!owner.snapshot)
        owner.snapshot = (async () => {
          let timer;
          try {
            if (owner.pending.size)
              await Promise.race([
                Promise.allSettled([...owner.pending]),
                new Promise((resolve) => {
                  timer = setTimeout(resolve, 1000);
                }),
              ]);
          } finally {
            clearTimeout(timer);
          }
          const snapshot = structuredClone({
            scope: owner.scope,
            responses: owner.responses,
            consoles: owner.consoles,
          });
          for (const entry of snapshot.responses) {
            if (entry.bodyReadStatus === "pending") {
              entry.bodyReadStatus = "timeout";
              entry.bodyCode = null;
              entry.bodyError = "有界收尾 1000ms 后仍未完成";
            }
          }
          return snapshot;
        })();
      return owner.snapshot.then((snapshot) => structuredClone(snapshot));
    },
  };
  return recorder;
}

/**
 * 恢复执行的摘要比对（纯函数）：中断后只在同 candidateHash / skinId /
 * retryPolicy / policyHash / sourceHashes / fixtureHash 下允许补缺状态（卡面恢复策略），否则调用方必须
 * 创建新捕获目录。sourceHashes 逐键比对且键集合必须一致（工具自身也在表内——
 * 改过 capture.mjs 就不允许续跑旧目录）。
 */
export function resumeDigestsMatch(saved, current) {
  if (!saved || typeof saved !== "object" || !current || typeof current !== "object") return false;
  for (const key of [
    "candidate",
    "candidateHash",
    "skinId",
    "retryPolicy",
    "policyHash",
    "fixtureHash",
    "fixtureBindings",
  ]) {
    const left = saved[key] ?? null;
    const right = current[key] ?? null;
    // candidate 是对象：progress.json 解析出来的副本与本次新构造的对象引用必然不同，
    // 按引用比会让每一次候选续跑都被误判为“不一致”——结构化摘要比对
    if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
      if (sha256Canonical(left) !== sha256Canonical(right)) return false;
      continue;
    }
    if (left !== right) return false;
  }
  const savedHashes = saved.sourceHashes;
  const currentHashes = current.sourceHashes;
  if (!savedHashes || typeof savedHashes !== "object" || !currentHashes || typeof currentHashes !== "object") {
    return false;
  }
  const savedKeys = Object.keys(savedHashes).sort();
  const currentKeys = Object.keys(currentHashes).sort();
  if (savedKeys.length !== currentKeys.length) return false;
  for (const key of currentKeys) {
    if (savedHashes[key] !== currentHashes[key]) return false;
  }
  return true;
}

function describeResumeDigestDifferences(saved, current) {
  const differences = [];
  for (const key of [
    "candidate",
    "candidateHash",
    "skinId",
    "retryPolicy",
    "policyHash",
    "fixtureHash",
    "fixtureBindings",
  ]) {
    const left = saved?.[key] ?? null;
    const right = current?.[key] ?? null;
    const same =
      left !== null && right !== null && typeof left === "object" && typeof right === "object"
        ? sha256Canonical(left) === sha256Canonical(right)
        : left === right;
    if (!same) differences.push(key);
  }
  const savedHashes = saved?.sourceHashes;
  const currentHashes = current?.sourceHashes;
  if (!savedHashes || !currentHashes || typeof savedHashes !== "object" || typeof currentHashes !== "object") {
    differences.push("sourceHashes");
  } else {
    const allFiles = new Set([...Object.keys(savedHashes), ...Object.keys(currentHashes)]);
    for (const file of allFiles) {
      if (savedHashes[file] !== currentHashes[file]) differences.push(`sourceHashes.${file}`);
    }
  }
  return differences;
}

/**
 * 恢复计划（纯函数）：已 captured 的单元跳过（已有成功证据不覆盖），其余
 * （缺测 / 失败）进补缺队列。失败单元在 resume 命令里重新捕获一次，其历史
 * 尝试记录保留在 progress.attempts，不删除、不覆盖。
 */
export function planResume(unitKeys, savedUnits) {
  if (!Array.isArray(unitKeys)) {
    throw new TypeError("planResume: unitKeys 必须是单元键数组");
  }
  const units = savedUnits && typeof savedUnits === "object" && !Array.isArray(savedUnits) ? savedUnits : {};
  const pending = [];
  const skip = [];
  for (const key of unitKeys) {
    const entry = units[key];
    if (entry && typeof entry === "object" && entry.status === "captured") skip.push(key);
    else pending.push(key);
  }
  return { pending, skip };
}

// ---------------------------------------------------------------------------
// STATE_CATALOG 动作执行器
// ---------------------------------------------------------------------------

/** 键盘 Tab 找焦点目标的预算下限；trigger 阶段必须自然 Tab 命中。 */
const FOCUS_TAB_BUDGET = 60;
/** 可聚焦元素计数口径（Tab 预算按它的一圈给）：隐藏/禁用/零尺寸都不占 Tab 顺序。 */
const TABBABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
/** 日历标题读不到时的逐向试触上限（纯函数计划失效时的兜底）。 */
const CALENDAR_NAV_FALLBACK_LIMIT = 18;

/** 步骤失败类阻断的前缀：出现任一项就不必再等就绪（步骤没走完，就绪判定没有意义）。 */
const STEP_FAILURE_PREFIXES = Object.freeze(["触发步骤失败", "预步骤失败", "收尾步骤失败"]);

/** 弹窗卫生：基准复位时逐个关闭可能残留的弹层（拨动型控件用其开关按钮）。 */
const DIALOG_CLOSE_ACTIONS = Object.freeze([
  { label: "importDialog", selector: "#importDialog:not([hidden])", close: "#cancelImportButton" },
  { label: "pricingDialog", selector: "#pricingDialog:not([hidden])", close: "#cancelPricingButton" },
  { label: "dateRangePicker", selector: "#dateRangePicker:not([hidden])", close: "#dateRangeButton" },
  {
    label: "recentRangeMenu",
    selector: "#recentRangeMenu:not([hidden])",
    close: '#presetButtons button[data-preset="all"]',
  },
  { label: "skinDialog", selector: "#skinDialog:not([hidden])", close: "#closeSkinDialogButton" },
]);

/** 执行一个 STATE_CATALOG 步骤（或矩阵自定义步骤）。不抛错：失败以 { ok:false, error } 记录。 */
export async function applyStateStep(page, step, { stateTimeoutMs, phase = "step" } = {}) {
  if (!step || typeof step !== "object" || typeof step.action !== "string") {
    throw new TypeError("applyStateStep: step 必须是含 action 的步骤对象");
  }
  const record = {
    phase,
    action: step.action,
    selector: step.selector ?? null,
    rewrittenFrom: step.rewrittenFrom ?? null,
  };
  try {
    switch (step.action) {
      case "click":
        await clickWithCalendarNavigation(page, step.selector, stateTimeoutMs, record);
        break;
      case "clickIfEnabled":
        await clickIfEnabled(page, step.selector, stateTimeoutMs, record);
        break;
      case "ensureClick":
        await ensureClick(page, step.selector, step.until, stateTimeoutMs, record);
        break;
      case "hover":
        await page.hover(step.selector, { timeout: stateTimeoutMs });
        break;
      case "fill":
        await page.fill(step.selector, String(step.value), { timeout: stateTimeoutMs });
        break;
      case "focus":
        await focusViaKeyboardOrDirect(page, step.selector, stateTimeoutMs, record, phase === "trigger");
        break;
      case "setTheme":
        await applyThemeViaToggle(page, step.value, stateTimeoutMs, record);
        break;
      case "setSpotlight":
        await applySpotlight(page, step.value, stateTimeoutMs, record);
        break;
      case "setCharacters":
        await callSkinHook(page, "setShowCharacters", [step.value !== "off"], record);
        break;
      case "setOpacity":
        await callSkinHook(page, "setOpacity", [Number(step.value)], record);
        break;
      case "selectSkin":
        await callSkinHook(page, "selectSkin", [step.value], record);
        break;
      default:
        throw new TypeError(`applyStateStep: 未知动作 "${String(step.action)}"`);
    }
    if (typeof step.until === "string" && step.until.length > 0 && !ENSURE_CLICK_ACTIONS.includes(step.action)) {
      await page.waitForFunction(
        `(() => Boolean(document.querySelector(${JSON.stringify(step.until)})))()`,
        undefined,
        {
          timeout: stateTimeoutMs,
        },
      );
      record.until = step.until;
    }
    return { ...record, ok: true };
  } catch (error) {
    return { ...record, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 点击；目标是日历日期格时先确保该日期在当前视图月内可见（catalog 注记要求按当前月份翻月）。 */
async function clickWithCalendarNavigation(page, selector, stateTimeoutMs, record) {
  const target = calendarDayFromSelector(selector);
  if (target) await ensureCalendarDayVisible(page, selector, stateTimeoutMs, record);
  await page.click(selector, { timeout: stateTimeoutMs });
}

/** 幂等拨动：until 已命中则不点击（避免把已命中的开关状态点反）。 */
/**
 * 条件点击：目标 disabled 说明操作没有作用对象（如“清除日期范围”在无选区时禁用），
 * 跳过即满足步骤意图并在轨迹留痕；目标缺失仍走 page.click 报真实错误。
 */
async function clickIfEnabled(page, selector, stateTimeoutMs, record) {
  const status = await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return "missing";
    return node.disabled ? "disabled" : "enabled";
  }, selector);
  if (status === "disabled") {
    record.clickIfEnabled = "skipped（目标禁用：操作当前无作用对象，步骤意图已满足）";
    return;
  }
  await page.click(selector, { timeout: stateTimeoutMs });
  record.clickIfEnabled = "clicked";
}

/** 幂等拨动：until 已命中则不点击（避免把已命中的开关状态点反）。 */
async function ensureClick(page, selector, until, stateTimeoutMs, record) {
  if (typeof until !== "string" || until.length === 0) {
    throw new TypeError("ensureClick: 需要 until 选择器");
  }
  const already = await page.evaluate((sel) => Boolean(document.querySelector(sel)), until);
  if (already) {
    record.ensureClick = "skipped（until 已命中）";
    return;
  }
  await page.click(selector, { timeout: stateTimeoutMs });
  record.ensureClick = until;
}

/**
 * trigger 焦点只能由自然 Tab 命中；其它阶段保留 already/直接 focus 回退。
 * catalog 入口已就绪时的 focus 重建由 runStateUnit 调度，执行器只保证 trigger 自然 Tab。
 */
async function focusViaKeyboardOrDirect(page, selector, stateTimeoutMs, record, requireTab = false) {
  // 焦点身份必须可判重：只记 tagName#id.类名会把一堆 `.active` 预设按钮混成一个
  // 身份（Tab 第 8 步就误判“绕回起点”而提前放弃）——按可聚焦序列里的下标定位
  const activeKey = () =>
    page.evaluate((source) => {
      const element = document.activeElement;
      if (!element) return "none";
      const nodes = Array.from(document.querySelectorAll(source));
      const index = nodes.indexOf(element);
      return index >= 0 ? `tabbable[${index}]#${element.id || ""}` : `outside#${element.tagName.toLowerCase()}`;
    }, TABBABLE_SELECTOR);
  const matches = () =>
    page.evaluate((sel) => {
      const element = document.activeElement;
      return Boolean(element && typeof element.matches === "function" && element.matches(sel));
    }, selector);
  if (!requireTab && (await matches())) {
    record.focusStrategy = "already";
    return;
  }
  // 一个完整 Tab 循环 = 页面上可见可聚焦元素的数量。看板的 #addImportButton 排在
  // 80+ 个可聚焦元素的末尾，固定小预算会在绕完一圈之前就误判“Tab 不可达”并退化
  // 成脚本 focus——按实际数量给预算（一圈 + 余量），绕回起点才承认不可达。
  const tabbable = await page.evaluate((source) => {
    const nodes = Array.from(document.querySelectorAll(source));
    return nodes.filter((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden";
    }).length;
  }, TABBABLE_SELECTOR);
  const budget = Math.max(FOCUS_TAB_BUDGET, tabbable + 5);
  record.tabbableCount = tabbable;
  record.focusBudget = budget;
  const start = await activeKey();
  for (let press = 1; press <= budget; press += 1) {
    record.focusPresses = press; // 实际 Tab 调用次数，含抛错的调用。
    await page.keyboard.press("Tab");
    if (await matches()) {
      record.focusStrategy = "tab";
      return;
    }
    if (press > 1 && (await activeKey()) === start) break; // Tab 序列绕回起点：目标不可达
  }
  if (requireTab) {
    record.focusStrategy = "tab-unreachable";
    throw new Error(
      `自然 Tab 未命中 ${selector}（调用 ${record.focusPresses} 次，预算 ${budget}）；trigger 禁止直接 focus 回退`,
    );
  }
  await page.focus(selector, { timeout: stateTimeoutMs });
  record.focusStrategy = "direct";
  record.focusFallback = `Tab 一个完整循环（${budget} 次）内未命中目标，退化为脚本 focus`;
}

/** setTheme：读 data-theme，不一致就点 #themeToggle（最多两次）。 */
async function applyThemeViaToggle(page, value, stateTimeoutMs, record) {
  if (value !== "light" && value !== "dark") {
    throw new TypeError(`applyThemeViaToggle: value 必须是 light/dark（收到 ${JSON.stringify(value)}）`);
  }
  const readTheme = () => page.evaluate(() => document.documentElement.dataset.theme ?? null);
  let clicks = 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if ((await readTheme()) === value) {
      record.theme = value;
      record.themeClicks = clicks;
      return;
    }
    await page.click("#themeToggle", { timeout: stateTimeoutMs });
    clicks += 1;
  }
  throw new Error(`setTheme 两次点击后 data-theme 仍为 ${await readTheme()}（期望 ${value}）`);
}

/**
 * setSpotlight：聚光是指针命中的表面照明。on = 把指针移到凸起表面（.topbar）
 * 中心并等 data-spotlight-active；off = 移到凹陷区域（.metric > strong 等，
 * surfaceAt 直接判空）并等图层消失。两次移动确保 pointermove 被处理。
 */
async function applySpotlight(page, value, stateTimeoutMs, record) {
  if (value !== "on" && value !== "off") {
    throw new TypeError(`applySpotlight: value 必须是 on/off（收到 ${JSON.stringify(value)}）`);
  }
  const target =
    value === "on"
      ? await page.evaluate((selector) => {
          const node = document.querySelector(selector);
          if (!node) return null;
          const rect = node.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return null;
          const point = {
            x: Math.round(rect.x + rect.width / 2),
            y: Math.round(rect.y + rect.height / 2),
          };
          return { point, nextPoint: { x: point.x + 1, y: point.y + 1 } };
        }, ".topbar")
      : await page.evaluate(() => {
          const selector = ".metric > strong, #timelineChart, .timeline-chart-well";
          for (const node of document.querySelectorAll(selector)) {
            const rect = node.getBoundingClientRect();
            const left = Math.max(0, rect.left);
            const top = Math.max(0, rect.top);
            const right = Math.min(window.innerWidth, rect.right);
            const bottom = Math.min(window.innerHeight, rect.bottom);
            if (right <= left || bottom <= top) continue;
            const point = {
              x: Math.floor((left + right) / 2),
              y: Math.floor((top + bottom) / 2),
            };
            const nextPoint = { x: point.x + 1, y: point.y + 1 };
            const inside = (p) => p.x >= left && p.x < right && p.y >= top && p.y < bottom;
            if (!inside(point) || !inside(nextPoint)) continue;
            const hitsNode = (p) => {
              const hit = document.elementFromPoint(p.x, p.y);
              return Boolean(hit && (hit === node || node.contains(hit)));
            };
            if (!hitsNode(point) || !hitsNode(nextPoint)) continue;
            return { point, nextPoint };
          }
          return null;
        });
  if (!target) throw new Error(`setSpotlight ${value}: 找不到指针落点（凸起/凹陷表面缺失）`);
  const { point, nextPoint } = target;
  await page.mouse.move(point.x, point.y);
  await page.mouse.move(nextPoint.x, nextPoint.y);
  const layerSelector = ".shell [data-spotlight-active]";
  const source =
    value === "on"
      ? `(() => Boolean(document.querySelector(${JSON.stringify(layerSelector)})))()`
      : `(() => !document.querySelector(${JSON.stringify(layerSelector)}))()`;
  const started = Date.now();
  try {
    await page.waitForFunction(source, undefined, { timeout: stateTimeoutMs });
    record.spotlight = { value, point, nextPoint, ms: Date.now() - started };
  } catch (error) {
    throw new Error(
      `setSpotlight ${value} 未在 ${stateTimeoutMs}ms 内生效（point ${JSON.stringify(point)}）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** 经产品自身运行时钩子改皮肤状态（M4.2 认可的唯一页内副作用入口，不加调试接口）。 */
async function callSkinHook(page, method, args, record) {
  await page.evaluate(
    ([name, params]) => {
      const hook = window.__skinTestHook;
      if (!hook || typeof hook[name] !== "function") {
        throw new Error(`__skinTestHook.${name} 不可用（app.js 未安装或方法缺失）`);
      }
      hook[name](...params);
    },
    [method, args],
  );
  record.hook = `${method}(${JSON.stringify(args)})`;
}

/**
 * 确保目标日期格在当前视图月内：读 .date-picker-title 的"YYYY年MM月"按纯函数
 * 计划翻月（catalog 注记要求按当前月份计算次数），标题读不到时退化为两个方向
 * 逐次试触。catalog 里显式的 prev 步骤照原样执行——本导航从执行后的真实月份
 * 继续算，两者叠加正好是总距离。
 */
async function ensureCalendarDayVisible(page, selector, stateTimeoutMs, record) {
  const target = calendarDayFromSelector(selector);
  if (!target) return;
  const exists = async () => page.evaluate((sel) => Boolean(document.querySelector(sel)), selector);
  if (await exists()) {
    record.calendar = { target, navigation: "already-visible" };
    return;
  }
  const view = await page.evaluate(() => {
    const title = document.querySelector(".date-picker-title");
    const match = title ? /(\d{4})年(\d{1,2})月/.exec(title.textContent ?? "") : null;
    return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
  });
  const actions = [];
  const plan = view ? planMonthNavigation(view, target) : null;
  if (plan && plan.action !== "none") {
    for (let click = 0; click < plan.clicks; click += 1) {
      await page.click(`[data-date-picker-action="${plan.action}"]`, { timeout: stateTimeoutMs });
      actions.push(plan.action);
      if (await exists()) break;
    }
  }
  if (!(await exists())) {
    for (const action of ["prev", "next"]) {
      for (let click = 0; click < CALENDAR_NAV_FALLBACK_LIMIT; click += 1) {
        await page.click(`[data-date-picker-action="${action}"]`, { timeout: stateTimeoutMs });
        actions.push(action);
        if (await exists()) break;
      }
      if (await exists()) break;
    }
  }
  if (!(await exists())) {
    throw new Error(`日历导航后仍找不到目标日期格 ${selector}（试触记录 ${JSON.stringify(actions)}）`);
  }
  record.calendar = { target, from: view, clicks: actions.length, actions };
}

/** 就绪判定的一次性求值（入口“已在状态中”检查；异常按未就绪处理）。 */
async function evaluateReady(page, ready) {
  if (!ready) return null;
  try {
    return Boolean(await page.evaluate(buildStateReadyWaitSource(ready)));
  } catch {
    return false;
  }
}

/** 就绪等待（每状态独立 timeout；命中与否都记录，不抛）。 */
async function waitStateReady(page, ready, timeout) {
  if (!ready) return { ok: true, kind: null, selector: null, ms: 0, skipped: true };
  const started = Date.now();
  try {
    await page.waitForFunction(buildStateReadyWaitSource(ready), undefined, { timeout });
    return { ok: true, kind: ready.kind, selector: ready.selector, ms: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      kind: ready.kind,
      selector: ready.selector,
      ms: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 基准复位：关闭可能残留的弹层 → 回到『全部』预设 → 等非零指标 → 双 rAF。
 * 每个状态恢复后都跑一遍，保证下一个状态从确定的看板基准出发（catalog 的
 * restore 多把预设弹回 today，而 fixture 的 today 无数据）。任何恢复步骤失败
 * 都进入 blockers，使本次尝试失败并走有限重试，不让污染后的页面继续复用。
 */
async function rebaselineToAll(page, stateTimeoutMs, trace) {
  const record = { dialogsClosed: [], preset: null, nonZero: false, warning: null, failures: [] };
  for (const dialog of DIALOG_CLOSE_ACTIONS) {
    const open = await page.evaluate((sel) => Boolean(document.querySelector(sel)), dialog.selector);
    if (!open) continue;
    try {
      await page.click(dialog.close, { timeout: stateTimeoutMs });
      await page.waitForFunction((selector) => !document.querySelector(selector), dialog.selector, {
        timeout: stateTimeoutMs,
      });
      record.dialogsClosed.push(dialog.label);
    } catch (error) {
      record.failures.push(`关闭 ${dialog.label} 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    await page.click('#presetButtons button[data-preset="all"]', { timeout: stateTimeoutMs });
    await page.waitForFunction(
      () => document.querySelector('#presetButtons button[data-preset="all"]')?.classList.contains("active") === true,
      undefined,
      { timeout: stateTimeoutMs },
    );
    record.preset = "all";
  } catch (error) {
    record.failures.push(`点击/确认『全部』失败：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await page.waitForFunction(buildNonZeroMetricsWaitSource(), undefined, { timeout: stateTimeoutMs });
    record.nonZero = true;
  } catch (error) {
    record.failures.push(`非零指标未就绪：${error instanceof Error ? error.message : String(error)}`);
  }
  await page.evaluate(PAINT_SETTLE_SOURCE).catch(() => {});
  record.ok = record.failures.length === 0;
  record.warning = record.failures.length === 0 ? null : record.failures.join("；");
  trace.rebaseline = record;
  return record;
}

/** 区域截图：把视口截图裁到目标元素与视口的交集（不滚动页面，避免改变状态本身）。 */
async function captureRegionShot(page, selector) {
  const box = await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return null;
    const rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, selector);
  if (!box) return { ok: false, reason: `区域选择器无可见元素：${selector}` };
  const view = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  const x = Math.max(0, Math.floor(box.x));
  const y = Math.max(0, Math.floor(box.y));
  const width = Math.min(view.width, Math.ceil(box.x + box.width)) - x;
  const height = Math.min(view.height, Math.ceil(box.y + box.height)) - y;
  if (width <= 0 || height <= 0) return { ok: false, reason: "区域不在当前视口内" };
  const buffer = await page.screenshot({ fullPage: false, clip: { x, y, width, height } });
  return { ok: true, buffer, clip: { x, y, width, height } };
}

/**
 * 目标元素取证（可滚动）：先 scrollIntoView 再裁到元素与视口交集。
 *
 * 只为"角色目录无法机测、卡面要求原尺寸截图人工核验"的角色补图——焦点环
 * （focus.outline 在目录里是句人话不是选择器）高频率落在首屏之外。滚动不改变
 * 焦点/主题/皮肤这些被捕获状态，但会改变视口口径，所以只能在几何与角色测量
 * 都完成之后调用，且调用方负责把结果按 target1/target2… 挂到 shots 上。
 */
async function captureScrolledRegionShot(page, selector) {
  const found = await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) return false;
    node.scrollIntoView({ block: "center", inline: "center" });
    return true;
  }, selector);
  if (!found) return { ok: false, reason: `目标选择器无元素：${selector}` };
  await page.evaluate(PAINT_SETTLE_SOURCE).catch(() => {});
  return captureRegionShot(page, selector);
}

// ---------------------------------------------------------------------------
// 状态单元捕获（触发 → 就绪 → 取证 → 测量 → 恢复 → 基准复位）
// ---------------------------------------------------------------------------

function recordInteractionAssertion(trace, blockers, label, expected, actual) {
  const ok = Object.is(actual, expected);
  trace.interactionAssertions ??= [];
  trace.interactionAssertions.push({ label, expected, actual, ok });
  if (!ok)
    blockers.push(`交互状态断言失败（${label}）：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  return ok;
}

async function waitForUsageFilterResponse(page, expectedExcludedId, timeout) {
  return page.waitForResponse(
    (response) => {
      try {
        const url = new URL(response.url());
        if (url.pathname !== "/api/usage") return false;
        return expectedExcludedId
          ? url.searchParams.get("exclude")?.split(",").includes(expectedExcludedId) === true
          : !url.searchParams.has("exclude");
      } catch {
        return false;
      }
    },
    { timeout },
  );
}

async function findSourceCheckbox(page, sourceId) {
  const sources = page.locator("#sourcePicker input[data-source-id]");
  const count = await sources.count();
  for (let index = 0; index < count; index += 1) {
    const checkbox = sources.nth(index);
    if ((await checkbox.getAttribute("data-source-id")) === sourceId) return checkbox;
  }
  throw new Error(`来源 checkbox 已消失：${sourceId}`);
}

async function readSourceCheckbox(page, sourceId) {
  const checkbox = await findSourceCheckbox(page, sourceId);
  const checked = await checkbox.isChecked();
  const label = checkbox.locator("xpath=ancestor::label[1]");
  if ((await label.count()) !== 1) throw new Error(`来源 checkbox 缺少唯一 label：${sourceId}`);
  const badge = label.locator(".home-excluded");
  const badgePresent = (await badge.count()) > 0;
  const badgeVisible = badgePresent && (await badge.isVisible());
  return { checkbox, checked, badgePresent, badgeVisible };
}

/** 只读核对弹窗来源身份与主页行是否以完整路径唯一绑定。 */
export async function readHomeSourceBinding(page, sourceId) {
  if (typeof sourceId !== "string" || sourceId.trim().length === 0) {
    throw new TypeError("readHomeSourceBinding: sourceId 必须是非空字符串");
  }

  const sourceInputs = page.locator("#sourcePicker input[data-source-id]");
  const sourceInputCount = await sourceInputs.count();
  let sourceIdMatches = 0;
  for (let index = 0; index < sourceInputCount; index += 1) {
    if ((await sourceInputs.nth(index).getAttribute("data-source-id")) === sourceId) sourceIdMatches += 1;
  }
  if (sourceIdMatches !== 1) {
    throw new Error(`readHomeSourceBinding: sourceId 必须唯一，${sourceId} 匹配 ${sourceIdMatches} 项`);
  }

  const checkbox = await findSourceCheckbox(page, sourceId);
  const option = checkbox.locator("xpath=ancestor::label[1]");
  if ((await option.count()) !== 1) throw new Error(`readHomeSourceBinding: 来源缺少唯一选项行：${sourceId}`);
  const optionClass = await option.getAttribute("class");
  if (typeof optionClass !== "string" || !optionClass.split(/\s+/).includes("source-option")) {
    throw new Error(`readHomeSourceBinding: 来源 checkbox 不属于 .source-option：${sourceId}`);
  }
  const optionPaths = option.locator(".source-option-path");
  if ((await optionPaths.count()) !== 1) {
    throw new Error(`readHomeSourceBinding: 来源必须有唯一 .source-option-path：${sourceId}`);
  }
  const path = await optionPaths.first().getAttribute("title");
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error(`readHomeSourceBinding: 来源缺少非空完整路径 title：${sourceId}`);
  }

  const sourcePathNodes = page.locator("#sourcePicker .source-option-path[title]");
  let sourcePathCount = 0;
  for (let index = 0; index < (await sourcePathNodes.count()); index += 1) {
    if ((await sourcePathNodes.nth(index).getAttribute("title")) === path) sourcePathCount += 1;
  }
  if (sourcePathCount !== 1) {
    throw new Error(`readHomeSourceBinding: 完整路径在来源列表必须唯一，实际匹配 ${sourcePathCount} 项`);
  }

  const homeRows = page.locator("#homeList > .home-row");
  const matchingHomeRows = [];
  let matchingHomePathCount = 0;
  for (let index = 0; index < (await homeRows.count()); index += 1) {
    const row = homeRows.nth(index);
    const rowPaths = row.locator(":scope > .home-path");
    for (let pathIndex = 0; pathIndex < (await rowPaths.count()); pathIndex += 1) {
      if ((await rowPaths.nth(pathIndex).getAttribute("title")) !== path) continue;
      matchingHomePathCount += 1;
      matchingHomeRows.push(row);
    }
  }
  if (matchingHomePathCount !== 1) {
    throw new Error(`readHomeSourceBinding: 完整路径在主页必须唯一，实际匹配 ${matchingHomePathCount} 项`);
  }

  const homeRow = matchingHomeRows[0];
  const homeRowPaths = homeRow.locator(":scope > .home-path");
  const targetPathCount = await homeRowPaths.count();
  if (targetPathCount !== 1) {
    throw new Error(`readHomeSourceBinding: 目标主页行必须只有一个直接 .home-path，实际 ${targetPathCount} 项`);
  }
  const homeRowClass = await homeRow.getAttribute("class");
  const homeNames = homeRow.locator(":scope > .home-label > strong");
  const dialog = page.locator("#importDialog");
  if ((await dialog.count()) !== 1) throw new Error("readHomeSourceBinding: #importDialog 必须唯一");

  const allSourceInputs = page.locator("#sourcePicker input[type=checkbox]");
  const excludedSourceIds = [];
  for (let index = 0; index < (await allSourceInputs.count()); index += 1) {
    const input = allSourceInputs.nth(index);
    if (!(await input.isChecked())) excludedSourceIds.push(await input.getAttribute("data-source-id"));
  }

  const excludedRows = page.locator("#homeList > .home-row.excluded");
  const excludedHomePaths = [];
  for (let index = 0; index < (await excludedRows.count()); index += 1) {
    const paths = excludedRows.nth(index).locator(":scope > .home-path");
    const title = (await paths.count()) === 1 ? await paths.first().getAttribute("title") : null;
    excludedHomePaths.push(typeof title === "string" && title.length > 0 ? title : null);
  }

  const targetSource = await readSourceCheckbox(page, sourceId);
  return {
    sourceId,
    path,
    checked: targetSource.checked,
    dialogHidden: (await dialog.getAttribute("hidden")) !== null,
    sourceBadgePresent: targetSource.badgePresent,
    sourceBadgeVisible: targetSource.badgeVisible,
    homeExcluded: typeof homeRowClass === "string" && homeRowClass.split(/\s+/).includes("excluded"),
    homeVisible: await homeRow.isVisible(),
    targetNameCount: await homeNames.count(),
    targetPathCount,
    excludedSourceIds,
    excludedHomePaths,
  };
}

async function waitForSourceRestored(page, sourceId, timeout) {
  await page.waitForFunction(
    (expectedSourceId) => {
      const checkbox = Array.from(document.querySelectorAll("#sourcePicker input[data-source-id]")).find(
        (input) => input.getAttribute("data-source-id") === expectedSourceId,
      );
      const label = checkbox?.closest("label");
      return Boolean(checkbox && label && checkbox.checked && !label.querySelector(".home-excluded"));
    },
    sourceId,
    { timeout },
  );
}

/** 只围住 S3 的临时来源排除态；测量回调结束前不恢复筛选或关闭弹窗。 */
export async function withSourceExcludedState({ page, state, stateTimeoutMs, trace, step }, captureExcluded) {
  if (state?.id !== "dialog-import-source-excluded") {
    throw new TypeError("withSourceExcludedState: state 必须是 dialog-import-source-excluded");
  }
  if (typeof captureExcluded !== "function") {
    throw new TypeError("withSourceExcludedState: captureExcluded 必须是函数");
  }
  const record = {
    stateId: state.id,
    sourceId: null,
    initiallyChecked: null,
    filter: {
      requestPath: "/api/usage",
      requestedExclude: null,
      responseUrl: null,
      responseStatus: null,
      checkboxUnchecked: null,
      badgePresent: null,
      badgeVisible: null,
    },
    callback: { started: false, completed: false },
    order: [],
    restore: {
      requestPath: "/api/usage",
      requestedExclude: null,
      responseUrl: null,
      filterAttempted: false,
      responseStatus: null,
      checked: null,
      badgePresent: null,
      badgeVisible: null,
      domReady: false,
      errors: [],
    },
  };
  trace.sourceExcluded = record;
  let openingAttempted = false;
  let uncheckAttempted = false;
  let callbackValue;
  let operationError = null;
  const restoreErrors = [];
  const recordRestoreError = (error) => {
    const value = error instanceof Error ? error : new Error(String(error));
    restoreErrors.push(value);
    record.restore.errors.push(value.message);
  };
  const confirmRestoredDom = async () => {
    record.order.push("restore-dom-wait-started");
    try {
      await waitForSourceRestored(page, record.sourceId, stateTimeoutMs);
      const restored = await readSourceCheckbox(page, record.sourceId);
      record.restore.checked = restored.checked;
      record.restore.badgePresent = restored.badgePresent;
      record.restore.badgeVisible = restored.badgeVisible;
      if (!restored.checked || restored.badgePresent) {
        recordRestoreError(
          new Error(
            `来源恢复后状态不正确：checked=${restored.checked} badgePresent=${restored.badgePresent} badgeVisible=${restored.badgeVisible}`,
          ),
        );
        return false;
      }
      record.restore.domReady = true;
      record.order.push("restore-dom-ready", "source-restored");
      return true;
    } catch (error) {
      recordRestoreError(error);
      return false;
    }
  };

  try {
    for (const openStep of state.steps ?? []) {
      openingAttempted = true;
      const outcome = await step(openStep, "trigger");
      if (!outcome.ok) throw new Error(`打开来源排除状态失败：${outcome.error}`);
    }
    if (!openingAttempted) throw new Error("来源排除状态没有打开步骤");

    const sources = page.locator("#sourcePicker input[data-source-id]");
    if ((await sources.count()) < 1) throw new Error("来源排除状态没有 source checkbox");
    const first = sources.first();
    const sourceId = await first.getAttribute("data-source-id");
    if (typeof sourceId !== "string" || sourceId.trim().length === 0) {
      throw new Error("来源排除状态的首个 source checkbox 缺少有效 data-source-id");
    }
    record.sourceId = sourceId;
    record.initiallyChecked = await first.isChecked();
    record.order.push("dialog-open", "initial-state-read");
    if (!record.initiallyChecked) {
      throw new Error(`来源排除状态要求来源初始勾选，实际未勾选：${sourceId}`);
    }

    const checkbox = await findSourceCheckbox(page, sourceId);
    record.filter.requestedExclude = sourceId;
    record.filter.requestStarted = true;
    record.order.push("filter-request-started");
    uncheckAttempted = true;
    const filterResponsePromise = waitForUsageFilterResponse(page, sourceId, stateTimeoutMs);
    const [, filteredResponse] = await Promise.all([
      checkbox.uncheck({ timeout: stateTimeoutMs }),
      filterResponsePromise,
    ]);
    record.filter.responseUrl = filteredResponse.url();
    record.filter.responseStatus = filteredResponse.status();
    record.order.push("filter-response");
    if (record.filter.responseStatus !== 200) {
      throw new Error(`来源排除请求必须返回 HTTP 200，实际 ${record.filter.responseStatus}`);
    }

    const ready = await waitStateReady(page, state.ready, stateTimeoutMs);
    trace.ready = ready;
    record.filter.ready = ready;
    if (!ready.ok) throw new Error(`来源排除状态未就绪：${ready.error}`);
    const excluded = await readSourceCheckbox(page, sourceId);
    record.filter.checkboxUnchecked = !excluded.checked;
    record.filter.badgePresent = excluded.badgePresent;
    record.filter.badgeVisible = excluded.badgeVisible;
    record.order.push("excluded-state-ready");
    if (excluded.checked || !excluded.badgeVisible) {
      throw new Error(`来源排除前置条件不成立：checked=${excluded.checked} badgeVisible=${excluded.badgeVisible}`);
    }

    record.callback.started = true;
    record.order.push("measurement-callback-started");
    callbackValue = await captureExcluded();
    record.callback.completed = true;
    record.order.push("measurement-callback-completed");

    const afterCapture = await readSourceCheckbox(page, sourceId);
    if (afterCapture.checked || !afterCapture.badgeVisible) {
      throw new Error(
        `测量回调期间来源排除态发生变化：checked=${afterCapture.checked} badgeVisible=${afterCapture.badgeVisible}`,
      );
    }
    record.order.push("excluded-state-confirmed-after-measurement");
  } catch (error) {
    operationError = error;
  } finally {
    if (uncheckAttempted && record.sourceId) {
      try {
        const current = await readSourceCheckbox(page, record.sourceId);
        if (!current.checked) {
          record.restore.filterAttempted = true;
          record.restore.requestedExclude = null;
          record.order.push("restore-request-started");
          const restoreResponsePromise = waitForUsageFilterResponse(page, null, stateTimeoutMs);
          try {
            const [, restoredResponse] = await Promise.all([
              current.checkbox.check({ timeout: stateTimeoutMs }),
              restoreResponsePromise,
            ]);
            record.restore.responseUrl = restoredResponse.url();
            record.restore.responseStatus = restoredResponse.status();
            record.order.push("restore-response");
            if (record.restore.responseStatus !== 200) {
              recordRestoreError(new Error(`来源恢复请求必须返回 HTTP 200，实际 ${record.restore.responseStatus}`));
            } else {
              await confirmRestoredDom();
            }
          } catch (error) {
            recordRestoreError(error);
          }
        } else {
          record.restore.checked = true;
          record.restore.badgePresent = current.badgePresent;
          record.restore.badgeVisible = current.badgeVisible;
          record.restore.skippedBecauseAlreadyChecked = true;
          record.order.push("restore-skipped-already-checked");
          if (current.badgePresent) await confirmRestoredDom();
          else {
            record.restore.domReady = true;
            record.order.push("source-restored");
          }
        }
      } catch (error) {
        recordRestoreError(error);
      }
    }

    if (openingAttempted) {
      for (const closeStep of state.restore ?? []) {
        try {
          record.order.push("dialog-close-started");
          const outcome = await step(closeStep, "restore");
          if (!outcome.ok) {
            recordRestoreError(new Error(`关闭来源弹窗失败：${outcome.error}`));
          } else {
            await page.waitForFunction(
              "(() => { const dialog = document.querySelector('#importDialog'); return Boolean(dialog && dialog.hidden); })()",
              undefined,
              { timeout: stateTimeoutMs },
            );
            record.order.push("dialog-closed");
          }
        } catch (error) {
          recordRestoreError(error);
        }
      }
    }
  }

  record.restore.ok = record.restore.errors.length === 0;
  if (operationError && record.restore.errors.length > 0) {
    throw new AggregateError([operationError, ...restoreErrors], "来源排除操作及恢复均失败");
  }
  if (operationError) throw operationError;
  if (record.restore.errors.length > 0) {
    throw new AggregateError(restoreErrors, "来源排除恢复失败");
  }
  return callbackValue;
}

/** 专用于主页来源排除态；只管理 checkbox/弹窗生命周期，不承载测量或矩阵接线。 */
export async function withHomeSourceExcludedState({ page, state, stateTimeoutMs, trace, step }, captureHomeExcluded) {
  if (state?.id !== "home-source-excluded") {
    throw new TypeError("withHomeSourceExcludedState: state 必须是 home-source-excluded");
  }
  if (typeof captureHomeExcluded !== "function") {
    throw new TypeError("withHomeSourceExcludedState: captureHomeExcluded 必须是函数");
  }
  if (
    !state.ready ||
    !Array.isArray(state.restore) ||
    !state.restore.some((entry) => entry?.selector === "#cancelImportButton")
  ) {
    throw new TypeError("withHomeSourceExcludedState: state 必须提供 ready 与 #cancelImportButton restore 步骤");
  }
  if (!page || !trace || typeof trace !== "object" || typeof step !== "function") {
    throw new TypeError("withHomeSourceExcludedState: page、trace 对象和 step 函数均为必需");
  }

  const openStep = { action: "click", selector: "#addImportButton" };
  const record = {
    stateId: state.id,
    sourceId: null,
    path: null,
    entryDialogHidden: null,
    initiallyChecked: null,
    bindings: {},
    filter: {
      requestPath: "/api/usage",
      requestedExclude: null,
      responseUrl: null,
      responseStatus: null,
    },
    callback: { started: false, completed: false },
    order: [],
    restore: {
      requestPath: "/api/usage",
      requestedExclude: null,
      filterAttempted: false,
      responseUrl: null,
      responseStatus: null,
      checked: null,
      badgePresent: null,
      badgeVisible: null,
      homeExcluded: null,
      errors: [],
      ok: null,
    },
  };
  trace.homeSourceExcluded = record;

  let openingAttempted = false;
  let uncheckAttempted = false;
  let operationFailed = false;
  let operationError;
  let callbackValue;
  let restorationFailed = false;
  const restorationErrors = [];
  const errorText = (error) => (error instanceof Error ? error.message : String(error));
  const recordRestoreError = (error) => {
    restorationFailed = true;
    restorationErrors.push(error);
    record.restore.errors.push(errorText(error));
  };
  const readDialogHidden = async () => {
    const dialog = page.locator("#importDialog");
    if ((await dialog.count()) !== 1) throw new Error("#importDialog 必须唯一");
    return (await dialog.getAttribute("hidden")) !== null;
  };
  const waitDialogHidden = (hidden) =>
    page.waitForFunction(
      (expectedHidden) => {
        const dialog = document.querySelector("#importDialog");
        return Boolean(dialog && dialog.hidden === expectedHidden);
      },
      hidden,
      { timeout: stateTimeoutMs },
    );
  const waitHomeExcluded = (path, excluded) =>
    page.waitForFunction(
      ({ expectedPath, expectedExcluded }) => {
        const rows = Array.from(document.querySelectorAll("#homeList > .home-row")).filter((row) =>
          Array.from(row.querySelectorAll(":scope > .home-path")).some(
            (node) => node.getAttribute("title") === expectedPath,
          ),
        );
        return rows.length === 1 && rows[0].classList.contains("excluded") === expectedExcluded;
      },
      { expectedPath: path, expectedExcluded: excluded },
      { timeout: stateTimeoutMs },
    );
  const readBound = async (stage) => {
    const binding = await readHomeSourceBinding(page, record.sourceId);
    record.bindings[stage] = binding;
    if (binding.sourceId !== record.sourceId || binding.path !== record.path) {
      throw new Error(
        `${stage}: sourceId/path 身份漂移（期望 ${record.sourceId} → ${record.path}，实际 ${binding.sourceId} → ${binding.path}）`,
      );
    }
    if (binding.targetNameCount !== 1 || binding.targetPathCount !== 1) {
      throw new Error(
        `${stage}: 目标名称/路径叶节点必须各唯一（${binding.targetNameCount}/${binding.targetPathCount}）`,
      );
    }
    return binding;
  };
  const requireBinding = (binding, stage, expected) => {
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.is(binding[key], value)) {
        throw new Error(`${stage}: ${key} 状态不符（期望 ${String(value)}，实际 ${String(binding[key])}）`);
      }
    }
  };
  const requireExcludedSet = (binding, stage, ids, paths) => {
    const sameItems = (actual, expected) =>
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => actual[index] === value);
    if (!sameItems(binding.excludedSourceIds, ids) || !sameItems(binding.excludedHomePaths, paths)) {
      throw new Error(
        `${stage}: 排除集合不符（sources=${JSON.stringify(binding.excludedSourceIds)} homes=${JSON.stringify(binding.excludedHomePaths)}）`,
      );
    }
  };
  const verifyUsageResponse = (response, expectedExclude) => {
    const url = new URL(response.url());
    const excludeValues = url.searchParams.getAll("exclude");
    const queryMatches =
      expectedExclude === null
        ? excludeValues.length === 0
        : excludeValues.length === 1 && excludeValues[0] === expectedExclude;
    if (url.pathname !== "/api/usage" || !queryMatches) {
      throw new Error(`来源请求身份不符：${url.pathname}${url.search}（期望 exclude=${String(expectedExclude)}）`);
    }
    if (response.status() !== 200) {
      throw new Error(`来源请求必须返回 HTTP 200，实际 ${response.status()}`);
    }
    return { url: response.url(), status: response.status() };
  };
  const performStep = async (entry, phase, actionLabel) => {
    const outcome = await step(entry, phase);
    if (!outcome?.ok) throw new Error(`${actionLabel}失败：${outcome?.error ?? "步骤未成功"}`);
  };
  const closeDialog = async (recovering) => {
    let hadError = false;
    for (const closeStep of state.restore) {
      let hidden = false;
      try {
        hidden = await readDialogHidden();
      } catch (error) {
        if (!recovering) throw error;
        recordRestoreError(error);
        hadError = true;
      }
      if (hidden) return !hadError;
      record.order.push(recovering ? "restore-dialog-close-started" : "dialog-close-started");
      try {
        await performStep(closeStep, "restore", "关闭来源弹窗");
        await waitDialogHidden(true);
        record.order.push(recovering ? "restore-dialog-closed" : "dialog-closed");
      } catch (error) {
        if (!recovering) throw error;
        recordRestoreError(error);
        hadError = true;
      }
    }
    let hidden = false;
    try {
      hidden = await readDialogHidden();
    } catch (error) {
      if (!recovering) throw error;
      recordRestoreError(error);
      hadError = true;
    }
    if (hidden) return !hadError;
    const error = new Error("state.restore 步骤后 #importDialog 仍未 hidden");
    if (!recovering) throw error;
    recordRestoreError(error);
    return false;
  };
  const ensureRestoreDialogOpen = async () => {
    let hidden;
    try {
      hidden = await readDialogHidden();
    } catch (error) {
      recordRestoreError(error);
      return false;
    }
    if (!hidden) return true;
    record.order.push("restore-dialog-open-started");
    try {
      await performStep(openStep, "restore", "重新打开来源弹窗");
    } catch (error) {
      recordRestoreError(error);
    }
    try {
      await waitDialogHidden(false);
      record.order.push("restore-dialog-opened");
      return true;
    } catch (error) {
      recordRestoreError(error);
      return false;
    }
  };

  try {
    record.entryDialogHidden = await readDialogHidden();
    record.order.push("entry-dialog-checked");
    if (!record.entryDialogHidden) throw new Error("入口 #importDialog 必须已关闭；本 wrapper 不接管用户现有弹窗");

    openingAttempted = true;
    record.order.push("dialog-open-started");
    await performStep(openStep, "trigger", "打开来源弹窗");
    await waitDialogHidden(false);
    record.order.push("dialog-opened");

    const sourceInputs = page.locator("#sourcePicker input[type=checkbox]");
    if ((await sourceInputs.count()) < 1) throw new Error("主页排除状态没有来源 checkbox");
    const first = sourceInputs.first();
    const sourceId = await first.getAttribute("data-source-id");
    if (typeof sourceId !== "string" || sourceId.trim().length === 0) {
      throw new Error("主页排除状态的首个来源 checkbox 缺少有效 data-source-id");
    }
    record.sourceId = sourceId;
    const initial = await readHomeSourceBinding(page, sourceId);
    record.bindings.initial = initial;
    record.path = initial.path;
    record.initiallyChecked = initial.checked;
    record.order.push("initial-binding-read");
    if (initial.sourceId !== sourceId || initial.dialogHidden || !initial.checked || initial.homeExcluded) {
      throw new Error("主页排除状态入口必须是唯一绑定、弹窗打开、来源已勾选且主页行未排除");
    }
    if (
      initial.targetNameCount !== 1 ||
      initial.targetPathCount !== 1 ||
      initial.sourceBadgePresent ||
      initial.sourceBadgeVisible
    ) {
      throw new Error("主页排除状态入口名称/路径叶或来源徽标不符合初始状态");
    }
    requireExcludedSet(initial, "initial", [], []);

    const checkbox = await findSourceCheckbox(page, sourceId);
    record.filter.requestedExclude = sourceId;
    record.order.push("exclude-request-started");
    uncheckAttempted = true;
    const filterResponsePromise = waitForUsageFilterResponse(page, sourceId, stateTimeoutMs);
    const [, filterResponse] = await Promise.all([
      checkbox.uncheck({ timeout: stateTimeoutMs }),
      filterResponsePromise,
    ]);
    record.filter.responseUrl = filterResponse.url();
    record.filter.responseStatus = filterResponse.status();
    record.order.push("exclude-response");
    verifyUsageResponse(filterResponse, sourceId);

    await waitHomeExcluded(record.path, true);
    const excludedInDialog = await readBound("excludedInDialog");
    requireBinding(excludedInDialog, "excludedInDialog", {
      dialogHidden: false,
      checked: false,
      sourceBadgePresent: true,
      sourceBadgeVisible: true,
      homeExcluded: true,
    });
    requireExcludedSet(excludedInDialog, "excludedInDialog", [sourceId], [record.path]);
    record.order.push("excluded-dialog-binding-confirmed");

    await closeDialog(false);
    const ready = await waitStateReady(page, state.ready, stateTimeoutMs);
    record.ready = ready;
    record.order.push("home-ready");
    if (!ready.ok) throw new Error(`主页排除状态未就绪：${ready.error}`);
    const homeBinding = await readBound("home");
    requireBinding(homeBinding, "home", {
      dialogHidden: true,
      checked: false,
      homeExcluded: true,
      homeVisible: true,
    });
    requireExcludedSet(homeBinding, "home", [sourceId], [record.path]);
    record.order.push("home-binding-confirmed");

    record.callback.started = true;
    record.order.push("callback-started");
    callbackValue = await captureHomeExcluded();
    record.callback.completed = true;
    record.order.push("callback-completed");
    const afterCapture = await readBound("afterCapture");
    requireBinding(afterCapture, "afterCapture", {
      dialogHidden: true,
      checked: false,
      homeExcluded: true,
      homeVisible: true,
    });
    requireExcludedSet(afterCapture, "afterCapture", [sourceId], [record.path]);
    record.order.push("after-callback-binding-confirmed");
  } catch (error) {
    operationFailed = true;
    operationError = error;
    record.operationError = { thrown: true, message: errorText(error) };
  } finally {
    if (uncheckAttempted && record.sourceId !== null && record.path !== null) {
      const dialogReady = await ensureRestoreDialogOpen();
      if (!dialogReady) {
        recordRestoreError(new Error("恢复来源前无法确认来源弹窗已打开"));
      } else {
        let beforeRestore = null;
        let sameIdentity = false;
        try {
          beforeRestore = await readHomeSourceBinding(page, record.sourceId);
          record.bindings.restoreBefore = beforeRestore;
          sameIdentity = beforeRestore.sourceId === record.sourceId && beforeRestore.path === record.path;
          if (!sameIdentity) {
            recordRestoreError(
              new Error(
                `恢复前 sourceId/path 身份漂移（期望 ${record.sourceId} → ${record.path}，实际 ${beforeRestore.sourceId} → ${beforeRestore.path}）；不勾选其他来源`,
              ),
            );
          }
          if (sameIdentity && (beforeRestore.targetNameCount !== 1 || beforeRestore.targetPathCount !== 1)) {
            sameIdentity = false;
            recordRestoreError(new Error("恢复前目标名称/路径叶节点不唯一；不勾选其他来源"));
          }
        } catch (error) {
          sameIdentity = false;
          recordRestoreError(error);
        }

        if (sameIdentity && beforeRestore) {
          if (!beforeRestore.checked) {
            record.restore.filterAttempted = true;
            record.restore.requestedExclude = null;
            record.order.push("restore-request-started");
            try {
              const checkbox = await findSourceCheckbox(page, record.sourceId);
              const restoreResponsePromise = waitForUsageFilterResponse(page, null, stateTimeoutMs);
              const [checkResult, responseResult] = await Promise.allSettled([
                checkbox.check({ timeout: stateTimeoutMs }),
                restoreResponsePromise,
              ]);
              if (responseResult.status === "fulfilled") {
                const restoreResponse = responseResult.value;
                record.restore.responseUrl = restoreResponse.url();
                record.restore.responseStatus = restoreResponse.status();
                record.order.push("restore-response");
                try {
                  verifyUsageResponse(restoreResponse, null);
                } catch (error) {
                  recordRestoreError(error);
                }
              } else {
                recordRestoreError(responseResult.reason);
              }
              if (checkResult.status === "rejected") recordRestoreError(checkResult.reason);
            } catch (error) {
              recordRestoreError(error);
            }
          } else {
            record.order.push("restore-skipped-already-checked");
          }

          try {
            await waitHomeExcluded(record.path, false);
            record.order.push("restore-home-row-ready");
          } catch (error) {
            recordRestoreError(error);
          }
          try {
            const restored = await readBound("restoreAfter");
            record.restore.checked = restored.checked;
            record.restore.badgePresent = restored.sourceBadgePresent;
            record.restore.badgeVisible = restored.sourceBadgeVisible;
            record.restore.homeExcluded = restored.homeExcluded;
            requireBinding(restored, "restoreAfter", {
              checked: true,
              sourceBadgePresent: false,
              homeExcluded: false,
            });
            requireExcludedSet(restored, "restoreAfter", [], []);
            record.order.push("restore-binding-confirmed");
          } catch (error) {
            recordRestoreError(error);
          }
        }
      }
    }

    if (openingAttempted) await closeDialog(true);
  }

  record.restore.ok = !restorationFailed;
  const errors = operationFailed ? [operationError, ...restorationErrors] : restorationErrors;
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    const cause = operationFailed ? operationError : restorationErrors[0];
    throw new AggregateError(errors, "主页来源排除操作及恢复均失败", { cause });
  }
  return callbackValue;
}

/** S3 实际打开目录选择器并拨动来源筛选；选择路径只预填表单，不提交导入。 */
async function captureImportControlInteractions({ page, unit, stateTimeoutMs, trace, blockers, shots, step }) {
  const result = { directory: null, sourceFilter: null };
  trace.importControls = result;

  const picker = await step({ action: "click", selector: "#pickImportDirectoryButton" }, "trigger");
  if (!picker.ok) {
    blockers.push(`目录选择操作失败：${picker.error}`);
    return;
  }
  try {
    await page.waitForFunction(
      (expectedPath) => document.querySelector("#importPath")?.value === expectedPath,
      unit.expectedDirectoryPath,
      { timeout: stateTimeoutMs },
    );
    result.directory = {
      expectedPath: unit.expectedDirectoryPath,
      actualPath: await page.locator("#importPath").inputValue(),
      selected: true,
    };
    recordInteractionAssertion(
      trace,
      blockers,
      "fixture 目录选择完成",
      unit.expectedDirectoryPath,
      result.directory.actualPath,
    );
    shots.sourceDirectorySelected = await page.screenshot({ fullPage: false });
  } catch (error) {
    result.directory = {
      expectedPath: unit.expectedDirectoryPath,
      actualPath: await page
        .locator("#importPath")
        .inputValue()
        .catch(() => null),
      selected: false,
      error: error instanceof Error ? error.message : String(error),
    };
    blockers.push(`目录选择后路径未命中 fixture：${result.directory.error}`);
    return;
  }

  const sourceOptions = page.locator("#sourcePicker input[type=checkbox][data-source-id]");
  const count = await sourceOptions.count();
  if (count < 1) {
    blockers.push("来源筛选操作失败：导入弹窗没有可拨动的来源 checkbox");
    result.sourceFilter = { ok: false, reason: "no-source-checkbox" };
    return;
  }
  const checkbox = sourceOptions.first();
  const sourceId = await checkbox.getAttribute("data-source-id");
  const sourceSelector = `#sourcePicker input[data-source-id="${sourceId}"]`;
  const initiallyChecked = await checkbox.isChecked();
  result.sourceFilter = { sourceId, initiallyChecked, excluded: null, restored: null };
  recordInteractionAssertion(trace, blockers, "fixture 来源初始启用", true, initiallyChecked);

  const waitForExcludedDom = () =>
    page.waitForFunction(
      (expectedSourceId) => {
        const current = Array.from(
          document.querySelectorAll("#sourcePicker input[type=checkbox][data-source-id]"),
        ).find((input) => input.getAttribute("data-source-id") === expectedSourceId);
        const label = current?.closest("label");
        const badge = label?.querySelector(".home-excluded");
        const style = badge ? window.getComputedStyle(badge) : null;
        return Boolean(
          current &&
            !current.checked &&
            label?.classList.contains("excluded") &&
            badge?.getClientRects().length &&
            style &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.visibility !== "collapse",
        );
      },
      sourceId,
      { timeout: stateTimeoutMs },
    );

  if (!initiallyChecked) {
    const enableResponse = waitForUsageFilterResponse(page, null, stateTimeoutMs);
    const started = Date.now();
    const enableCheckbox = await findSourceCheckbox(page, sourceId);
    await enableCheckbox.check({ timeout: stateTimeoutMs });
    trace.steps.push({
      phase: "trigger",
      action: "check",
      selector: sourceSelector,
      ok: true,
      ms: Date.now() - started,
    });
    const response = await enableResponse;
    result.sourceFilter.normalizedResponseStatus = response.status();
    if (response.status() !== 200) {
      throw new Error(`来源启用归一化请求必须返回 HTTP 200，实际 ${response.status()}`);
    }
    result.sourceFilter.normalizedDomWait = { started: true, completed: false };
    await waitForSourceRestored(page, sourceId, stateTimeoutMs).catch((error) => {
      result.sourceFilter.normalizedDomWait.error = error instanceof Error ? error.message : String(error);
      throw error;
    });
    const normalized = await readSourceCheckbox(page, sourceId);
    result.sourceFilter.normalizedDomWait.completed = true;
    result.sourceFilter.normalizedChecked = normalized.checked;
    result.sourceFilter.normalizedBadgePresent = normalized.badgePresent;
    recordInteractionAssertion(
      trace,
      blockers,
      "来源启用归一化完成",
      true,
      normalized.checked && !normalized.badgePresent,
    );
  }

  const filteredResponse = waitForUsageFilterResponse(page, sourceId, stateTimeoutMs);
  const filterStarted = Date.now();
  const filterCheckbox = await findSourceCheckbox(page, sourceId);
  await filterCheckbox.uncheck({ timeout: stateTimeoutMs });
  trace.steps.push({
    phase: "trigger",
    action: "uncheck",
    selector: sourceSelector,
    ok: true,
    ms: Date.now() - filterStarted,
  });
  const filtered = await filteredResponse;
  result.sourceFilter.filterResponseStatus = filtered.status();
  if (filtered.status() !== 200) {
    throw new Error(`来源筛选请求必须返回 HTTP 200，实际 ${filtered.status()}`);
  }
  result.sourceFilter.excludedDomWait = { started: true, completed: false };
  await waitForExcludedDom().catch((error) => {
    result.sourceFilter.excludedDomWait.error = error instanceof Error ? error.message : String(error);
    throw error;
  });
  const excluded = await readSourceCheckbox(page, sourceId);
  const excludedLabel = excluded.checkbox.locator("xpath=ancestor::label[1]");
  const excludedLabelClass = await excludedLabel.getAttribute("class");
  result.sourceFilter.excludedDomWait.completed = true;
  result.sourceFilter.excluded = !excluded.checked;
  result.sourceFilter.excludedLabelClass = excludedLabelClass;
  result.sourceFilter.excludedBadgePresent = excluded.badgePresent;
  result.sourceFilter.excludedBadgeVisible = excluded.badgeVisible;
  recordInteractionAssertion(trace, blockers, "来源筛选已关闭该来源", true, result.sourceFilter.excluded);
  recordInteractionAssertion(
    trace,
    blockers,
    "来源筛选显示排除样式",
    true,
    String(excludedLabelClass).split(/\s+/).includes("excluded"),
  );
  recordInteractionAssertion(trace, blockers, "来源筛选显示排除标记", true, excluded.badgeVisible);
  await page.evaluate(PAINT_SETTLE_SOURCE);
  shots.sourceFiltered = await page.screenshot({ fullPage: false });

  const restoreResponse = waitForUsageFilterResponse(page, null, stateTimeoutMs);
  const restoreStarted = Date.now();
  const restoreCheckbox = await findSourceCheckbox(page, sourceId);
  await restoreCheckbox.check({ timeout: stateTimeoutMs });
  trace.restore.push({
    phase: "restore",
    action: "check",
    selector: sourceSelector,
    sourceId,
    ok: true,
    ms: Date.now() - restoreStarted,
  });
  const restored = await restoreResponse;
  result.sourceFilter.restoreResponseStatus = restored.status();
  if (restored.status() !== 200) {
    throw new Error(`来源筛选恢复请求必须返回 HTTP 200，实际 ${restored.status()}`);
  }
  result.sourceFilter.restoreDomWait = { started: true, completed: false };
  await waitForSourceRestored(page, sourceId, stateTimeoutMs).catch((error) => {
    result.sourceFilter.restoreDomWait.error = error instanceof Error ? error.message : String(error);
    throw error;
  });
  const restoredState = await readSourceCheckbox(page, sourceId);
  result.sourceFilter.restoreDomWait.completed = true;
  result.sourceFilter.restored = restoredState.checked;
  result.sourceFilter.restoredBadgePresent = restoredState.badgePresent;
  result.sourceFilter.restoredBadgeVisible = restoredState.badgeVisible;
  recordInteractionAssertion(trace, blockers, "来源筛选恢复为启用", true, restoredState.checked);
  recordInteractionAssertion(trace, blockers, "来源筛选恢复后排除标记消失", false, restoredState.badgePresent);
}

/** S5 真实切换模型/花销视图，在所选视图仍显示时截图、测量，再恢复入口视图。 */
async function captureTimelineModeInteractions({
  page,
  modes,
  stateTimeoutMs,
  trace,
  blockers,
  shots,
  step,
  candidate,
  skinMode,
  stateId,
  roleCatalog,
  policy,
}) {
  const labelFor = { channel: "按渠道", model: "按模型", cost: "按花销" };
  const selected = page.locator('#timelineModes button[data-timeline-mode][aria-pressed="true"]');
  const initialMode = await selected.getAttribute("data-timeline-mode");
  trace.timelineModes = { initialMode, requested: [...modes], checks: [] };
  const measurements = {};
  if (!labelFor[initialMode]) {
    blockers.push(`图表视图操作失败：无法读取初始视图（${String(initialMode)}）`);
    return measurements;
  }
  try {
    for (const mode of modes) {
      if (!labelFor[mode] || mode === initialMode) {
        blockers.push(`图表视图操作配置无效：${String(mode)}`);
        break;
      }
      const selector = `#timelineModes button[data-timeline-mode="${mode}"]`;
      const clicked = await step({ action: "click", selector }, "trigger");
      if (!clicked.ok) {
        blockers.push(`切换到 ${labelFor[mode]} 失败：${clicked.error}`);
        break;
      }
      await page.waitForFunction(
        ({ expectedMode, label }) =>
          document
            .querySelector(`#timelineModes button[data-timeline-mode="${expectedMode}"]`)
            ?.getAttribute("aria-pressed") === "true" &&
          document.querySelector("#detailModeLabel")?.textContent.trim() === label,
        { expectedMode: mode, label: labelFor[mode] },
        { timeout: stateTimeoutMs },
      );
      const screenshotField = `timeline${mode[0].toUpperCase()}${mode.slice(1)}`;
      await page.evaluate(PAINT_SETTLE_SOURCE);
      shots[screenshotField] = await page.screenshot({ fullPage: false });
      const actualLabel = (await page.locator("#detailModeLabel").textContent())?.trim() ?? null;
      const check = { mode, label: labelFor[mode], screenshotField, selected: true, actualLabel };
      if (!Array.isArray(roleCatalog) || roleCatalog.length === 0) {
        throw new Error(`状态 ${stateId} 缺少角色目录，不能为 ${mode} 视图生成测量证据`);
      }
      const measurementStarted = Date.now();
      const measurement = await measureBrowserRoles({
        page,
        candidate,
        mode: skinMode,
        stateId,
        roleCatalog,
        policy,
      });
      const stillSelected =
        (await page.locator(`#timelineModes button[data-timeline-mode="${mode}"]`).getAttribute("aria-pressed")) ===
        "true";
      const labelAfterMeasurement = (await page.locator("#detailModeLabel").textContent())?.trim() ?? null;
      if (!stillSelected || labelAfterMeasurement !== labelFor[mode]) {
        throw new Error(`测量后视图状态发生变化（期望 ${labelFor[mode]}，实际 ${labelAfterMeasurement}）`);
      }
      measurements[mode] = measurement;
      check.measurement = {
        status: "captured",
        recordCount: measurement.records?.length ?? 0,
        captureCount: measurement.captures?.length ?? 0,
        counts: measurement.diagnostics?.counts ?? null,
        durationMs: Date.now() - measurementStarted,
      };
      trace.timelineModes.checks.push(check);
      recordInteractionAssertion(trace, blockers, `${labelFor[mode]}视图已切换并取证`, labelFor[mode], actualLabel);
    }
  } catch (error) {
    blockers.push(`图表视图就绪/取证失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    const currentMode = await page
      .locator('#timelineModes button[data-timeline-mode][aria-pressed="true"]')
      .getAttribute("data-timeline-mode")
      .catch(() => null);
    if (currentMode && currentMode !== initialMode) {
      const restored = await step(
        { action: "click", selector: `#timelineModes button[data-timeline-mode="${initialMode}"]` },
        "restore",
      );
      if (!restored.ok) {
        blockers.push(`图表视图恢复失败（${initialMode}）：${restored.error}`);
      } else {
        try {
          await page.waitForFunction(
            (mode) =>
              document
                .querySelector(`#timelineModes button[data-timeline-mode="${mode}"]`)
                ?.getAttribute("aria-pressed") === "true",
            initialMode,
            { timeout: stateTimeoutMs },
          );
          trace.timelineModes.restoredMode = initialMode;
        } catch (error) {
          blockers.push(
            `图表视图恢复后状态未命中（${initialMode}）：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } else {
      trace.timelineModes.restoredMode = currentMode;
    }
  }
  return measurements;
}

const errorCountKeys = ["pageErrors", "consoleErrors", "requestFailed", "resourceFailures", "blockedExternal"];

function snapshotErrorCounts(errors) {
  const snapshot = {};
  for (const key of errorCountKeys) snapshot[key] = errors[key].length;
  return snapshot;
}

function errorDelta(errors, start) {
  const delta = {};
  for (const key of errorCountKeys) delta[key] = errors[key].slice(start[key]);
  return delta;
}

/** 保留历史 runner 导入名；角色目录必须原样进入真实测量分支。 */
export function adaptRoleCatalogForMeasurement(roleCatalog) {
  if (!Array.isArray(roleCatalog)) throw new TypeError("adaptRoleCatalogForMeasurement: roleCatalog 必须是数组");
  return roleCatalog;
}

/** 在主页来源排除生命周期的回调内捕获真实状态、完整目录测量和滚动区域图。 */
export async function captureHomeSourceExcludedEvidence({
  page,
  unit,
  mode,
  skinId,
  candidate,
  policy,
  trace,
  evidence,
  measureRoles = measureBrowserRoles,
}) {
  const lifecycle = trace.homeSourceExcluded;
  trace.durations ??= {};
  const ready = lifecycle?.ready ?? null;
  trace.ready = ready;
  if (!ready?.ok) throw new Error(`主页排除状态在取证前失去就绪：${ready?.error ?? "缺少 wrapper ready 记录"}`);

  lifecycle.evidence = { stateStage: null, geometryStage: null, regionStage: null };
  await page.evaluate(PAINT_SETTLE_SOURCE);
  evidence.shots.state = await page.screenshot({ fullPage: false });
  lifecycle.evidence.stateStage = "home-source-excluded";
  evidence.geometry = {
    unitId: unit.id,
    stateId: unit.stateId,
    mode,
    skinId,
    stage: "home-source-excluded",
    ...(await page.evaluate(buildLayoutProbeSource())),
  };
  lifecycle.evidence.geometryStage = "home-source-excluded";

  const started = Date.now();
  trace.roleScopeAdaptation = [];
  trace.roleScopeGaps = [];
  let measurementFailed = false;
  let measurementError;
  try {
    evidence.measurement = await measureRoles({
      page,
      candidate,
      mode,
      stateId: unit.stateId,
      roleCatalog: adaptRoleCatalogForMeasurement(ROLE_CATALOG),
      policy,
    });
  } catch (error) {
    measurementFailed = true;
    measurementError = error;
    const failure = failedCatalogMeasurement(error, {
      candidateId: candidate?.id ?? null,
      mode,
      stateId: unit.stateId,
    });
    evidence.measurement = failure.measurement;
    trace.measurementFailure = {
      complete: false,
      phase: failure.phase,
      packet: failure.packet,
      reason: failure.reason ?? null,
      error: measurementErrorTrace(error),
    };
  } finally {
    trace.durations.measureBrowserRoles = Date.now() - started;
  }

  try {
    const region = await captureScrolledRegionShot(page, unit.clipSelector);
    if (!region.ok) throw new Error(`主页排除态滚动区域截图失败：${region.reason}`);
    evidence.shots.region = region;
    lifecycle.evidence.regionStage = "home-source-excluded";
  } catch (error) {
    trace.regionMiss = error instanceof Error ? error.message : String(error);
    if (!measurementFailed) throw error;
  }

  if (measurementFailed) throw measurementError;
  return evidence.measurement;
}

/**
 * 捕获一个状态单元。返回内存中的证据载荷（截图 Buffer / 测量记录 / 几何 /
 * 轨迹），由编排者决定落盘位置：成功 → 单元目录；失败 → attempt-N 目录
 * （复跑记录单独存放，已有成功证据一律不覆盖）。
 *
 * catalog 单元：入口已就绪时只重做必要 focus，跳过其它触发及 catalog 恢复，防把
 * 已命中的状态点反；否则执行完整 catalog 步骤 → 等就绪 → 取证（回顶部、区域截图、视口截图、
 * 几何）→ M3 测量 → catalog 恢复 → 单元级 postRestoreSteps。
 * procedure 单元：S3 来源排除生命周期、S7 三个规程各自触发与自证（验收以 20 项声明为准）。
 * 收口：恢复后 20 项声明必须回到本模式期望（无旧色残留）+ 本单元错误增量
 * 逐项阻断（buildStateBlockers）。
 */
async function runStateUnit({
  ctx,
  unit,
  mode,
  skinId,
  candidate,
  expectedPairs,
  otherModePairs,
  policy,
  stateTimeoutMs,
  baselineTimeoutMs,
  attempt,
  fixtureHash,
}) {
  const { page, errors } = ctx;
  const state = unit.stateId ? (STATE_BY_ID.get(unit.stateId) ?? null) : null;
  const blockers = [];
  const trace = {
    unitId: unit.id,
    group: unit.group,
    groupLabel: unit.groupLabel,
    kind: unit.kind,
    stateId: unit.stateId ?? null,
    note: unit.note ?? null,
    stepRewrites: unit.stepRewrites ?? null,
    mode,
    attempt,
    startedAt: new Date().toISOString(),
    steps: [],
    ready: null,
    restore: [],
    recovery: null,
    rebaseline: null,
    declarations: {},
    verification: null,
    durations: {},
    readiness: {},
  };
  const shots = {};
  let measurement = null;
  let timelineModeMeasurements = {};
  let geometry = null;
  let unrouteFault = null;
  const errorStart = snapshotErrorCounts(errors);
  const isQuotaUnit = unit.id === "quota-toast" && unit.stateId === "quota-toast";
  const quotaDiagnosticStart = ctx.quotaEvidenceErrors?.length ?? 0;
  let quotaRecorder = null;
  let quotaBeginCounts = null;
  let quotaBegan = false;
  let quotaEndAttempted = false;
  let quotaBroken = false;
  let quotaSnapshot = null;
  if (isQuotaUnit) trace.quotaEvidence = { started: false, errors: [] };
  const quotaFailure = (stage, error) => {
    quotaBroken = true;
    ctx.quotaEvidence = null;
    const message = error instanceof Error ? error.message : String(error);
    trace.quotaEvidence.errors.push({ stage, message });
    blockers.push(`quota 证据采集失败（${stage}）：${message}`);
  };
  const endQuotaWindow = () => {
    if (!quotaBegan || quotaEndAttempted) return;
    quotaEndAttempted = true;
    try {
      quotaRecorder.endWindow();
      trace.quotaEvidence.windowEnded = true;
    } catch (error) {
      trace.quotaEvidence.windowEnded = false;
      quotaFailure("end", error);
    }
  };
  const faultPattern =
    typeof unit.routeFault === "string" && unit.routeFault.length > 0 ? new RegExp(unit.routeFault) : null;
  const step = async (value, phase) => {
    const outcome = await applyStateStep(page, value, { stateTimeoutMs, phase });
    if (phase === "trigger") trace.steps.push(outcome);
    else if (phase === "restore") trace.restore.push(outcome);
    else if (phase === "recovery") trace.recovery.steps.push(outcome);
    else trace.steps.push(outcome);
    return outcome;
  };

  if (unit.kind === "catalog" && unit.stateId && !state) {
    blockers.push(`矩阵单元 ${unit.id} 引用不存在的 catalog 状态 "${String(unit.stateId)}"`);
    return {
      status: "failed",
      blockers,
      trace,
      measurement,
      timelineModeMeasurements,
      geometry,
      shots,
      durations: trace.durations,
      errors: {},
    };
  }

  if (unit.fixtureRequirement) {
    const { name, expectedHash } = unit.fixtureRequirement;
    const actualHash = typeof fixtureHash === "string" ? fixtureHash : null;
    const match = typeof expectedHash === "string" && actualHash === expectedHash;
    trace.fixtureRequirement = { name, expectedHash, actualHash, match };
    if (!match) {
      return {
        status: "unreachable",
        blockers: [],
        trace,
        measurement: null,
        timelineModeMeasurements,
        geometry: null,
        shots,
        durations: trace.durations,
        errors: {},
        stateId: unit.stateId ?? null,
        reason: `fixture 身份不匹配（${String(name)}）：expected=${String(expectedHash)} actual=${actualHash ?? "<missing>"}`,
      };
    }
  }

  // 0. DOM 前置条件（fixture 结构性限制的显式登记）：见 quota-toast 单元。不命中时记
  // unreachable——既不是 captured（没捕获到）也不是 failed（没有任何操作失败），
  // 无法捕获的事实必须原样留在报告里；前置是静态 DOM 判据，重试不可能翻盘，故不重跑。
  if (typeof unit.precondition?.selector === "string") {
    let met = false;
    try {
      met = await page.evaluate((selector) => Boolean(document.querySelector(selector)), unit.precondition.selector);
    } catch {
      met = false;
    }
    trace.precondition = { selector: unit.precondition.selector, met, note: unit.precondition.note ?? null };
    if (!met) {
      return {
        status: "unreachable",
        blockers: [],
        trace,
        measurement: null,
        timelineModeMeasurements,
        geometry: null,
        shots,
        durations: trace.durations,
        errors: {},
        stateId: unit.stateId ?? null,
        reason: `前置条件未命中（${unit.precondition.selector}）：${unit.precondition.note ?? "状态在当前环境下无法进入"}`,
      };
    }
  }

  try {
    // 1. 路由故障注入（autorefresh-error：中止数据请求让轮询/加载失败）
    if (unit.routeFault && faultPattern) {
      await page.route(faultPattern, (route) => {
        void route.abort().catch(() => {});
      });
      unrouteFault = () => page.unroute(faultPattern).catch(() => {});
      trace.routeFault = unit.routeFault;
    }

    // 1. 单元级预步骤（开启态复测、聚光组合、错误态触发）
    for (const pre of unit.preSteps ?? []) {
      const outcome = await step(pre, "trigger");
      if (!outcome.ok) blockers.push(`预步骤失败（${pre.action} ${pre.selector ?? ""}）：${outcome.error}`);
    }

    if (unit.kind === "procedure") {
      if (unit.handler === "theme-roundtrip") {
        await runThemeRoundtrip({
          page,
          mode,
          otherModePairs,
          trace,
          blockers,
          step,
          shots,
        });
      } else if (unit.handler === "reload-preferences") {
        await runReloadPreferences({
          page,
          mode,
          skinId,
          expectedPairs,
          stateTimeoutMs,
          baselineTimeoutMs,
          trace,
          blockers,
          shots,
        });
      } else if (unit.handler === "skin-roundtrip") {
        await runSkinRoundtrip({ page, skinId, expectedPairs, stateTimeoutMs, trace, blockers, step, shots });
      } else if (unit.handler === "source-excluded") {
        if (!state) {
          blockers.push(`矩阵单元 ${unit.id} 引用不存在的 catalog 状态 "${String(unit.stateId)}"`);
        } else {
          try {
            await withSourceExcludedState({ page, state, stateTimeoutMs, trace, step }, async () => {
              const ready = await waitStateReady(page, state.ready, stateTimeoutMs);
              trace.ready = ready;
              if (!ready.ok) throw new Error(`来源排除状态在取证前失去就绪：${ready.error}`);
              await page.evaluate(PAINT_SETTLE_SOURCE);
              if (unit.clipSelector) {
                const region = await captureRegionShot(page, unit.clipSelector);
                if (region.ok) shots.region = region;
                else trace.regionMiss = region.reason;
              }
              shots.state = await page.screenshot({ fullPage: false });
              geometry = {
                unitId: unit.id,
                stateId: unit.stateId,
                mode,
                skinId,
                stage: "source-excluded",
                ...(await page.evaluate(buildLayoutProbeSource())),
              };
              const started = Date.now();
              trace.roleScopeAdaptation = [];
              trace.roleScopeGaps = [];
              measurement = await measureBrowserRoles({
                page,
                candidate,
                mode,
                stateId: unit.stateId,
                roleCatalog: adaptRoleCatalogForMeasurement(ROLE_CATALOG),
                policy,
              });
              trace.durations.measureBrowserRoles = Date.now() - started;
              return measurement;
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const causes =
              error instanceof AggregateError
                ? error.errors.map((cause) => (cause instanceof Error ? cause.message : String(cause)))
                : [];
            trace.sourceExcludedFailure = { message, causes };
            blockers.push(`来源排除流程失败：${message}${causes.length > 0 ? `；底层错误：${causes.join("；")}` : ""}`);
          }
        }
      } else if (unit.handler === "home-source-excluded") {
        if (!state) {
          blockers.push(`矩阵单元 ${unit.id} 引用不存在的 catalog 状态 "${String(unit.stateId)}"`);
        } else {
          const evidence = { measurement: null, geometry: null, shots: {} };
          try {
            await withHomeSourceExcludedState({ page, state, stateTimeoutMs, trace, step }, () =>
              captureHomeSourceExcludedEvidence({
                page,
                unit,
                mode,
                skinId,
                candidate,
                policy,
                trace,
                evidence,
              }),
            );
          } catch (error) {
            const details = measurementErrorTrace(error);
            const causes = error instanceof AggregateError ? error.errors.map((cause) => String(cause)) : [];
            trace.homeSourceExcludedFailure = details;
            blockers.push(
              `主页排除流程失败：${details.message}${causes.length > 0 ? `；底层错误：${causes.join("；")}` : ""}`,
            );
          }
          measurement = evidence.measurement;
          geometry = evidence.geometry;
          Object.assign(shots, evidence.shots);
        }
      } else {
        blockers.push(`矩阵单元 ${unit.id} 声明了未知规程 "${String(unit.handler)}"`);
      }
      // 其它规程单元的几何 + 视口图取收尾态；主页排除态必须由 handler 在 wrapper
      // callback 内取证，不能用恢复后的页面补出目标状态截图。
      const homeExcludedEvidenceRequired = unit.handler === "home-source-excluded";
      try {
        if (!geometry && !homeExcludedEvidenceRequired) {
          await page.evaluate(PAINT_SETTLE_SOURCE);
          geometry = {
            unitId: unit.id,
            stateId: unit.stateId ?? null,
            mode,
            skinId,
            stage: "post-procedure",
            ...(await page.evaluate(buildLayoutProbeSource())),
          };
        }
        if (!homeExcludedEvidenceRequired) shots.state ??= await page.screenshot({ fullPage: false });
      } catch (error) {
        blockers.push(`规程单元取证失败：${error instanceof Error ? error.message : String(error)}`);
      }
      if (homeExcludedEvidenceRequired) {
        const missing = [];
        if (
          !Buffer.isBuffer(shots.state) ||
          trace.homeSourceExcluded?.evidence?.stateStage !== "home-source-excluded"
        ) {
          missing.push("主页排除态 state.png");
        }
        if (geometry?.stage !== "home-source-excluded" || geometry.stateId !== unit.stateId) {
          missing.push("主页排除态 geometry.json");
        }
        if (
          !shots.region?.ok ||
          !Buffer.isBuffer(shots.region.buffer) ||
          trace.homeSourceExcluded?.evidence?.regionStage !== "home-source-excluded"
        ) {
          missing.push("主页排除态滚动 region.png");
        }
        trace.homeSourceExcludedEvidenceMissing = missing;
        if (missing.length > 0) blockers.push(`主页排除态目标证据缺失：${missing.join("、")}`);
      }
    } else if (state) {
      // 2. 入口已就绪也必须重建自然 Tab 焦点，其它动作保持跳过。
      const entryReady = await evaluateReady(page, state.ready);
      trace.entryReady = entryReady;
      const repeatFocus = entryReady && state.expectedRoleIds?.includes("focus.outline");
      if (entryReady && !repeatFocus) {
        trace.steps.push({
          phase: "trigger",
          action: "skipped",
          reason: "entry-ready（入口就绪已命中，不把已命中的状态点反）",
        });
      } else {
        for (const catalogStep of state.steps) {
          if (entryReady && catalogStep.action !== "focus") {
            trace.steps.push({
              phase: "trigger",
              action: "skipped",
              skippedAction: catalogStep.action,
              selector: catalogStep.selector ?? null,
              reason: "entry-ready（只重建自然 Tab 焦点，非 focus 动作已满足）",
            });
            continue;
          }
          const effective = rewriteCatalogStep(catalogStep, unit.stepRewrites);
          const quotaTrigger =
            isQuotaUnit && effective.action === "click" && effective.selector === "#presetButtons .quota-preset-toggle";
          if (quotaTrigger) {
            quotaBeginCounts = snapshotErrorCounts(errors);
            quotaRecorder = ctx.quotaEvidence;
            try {
              if (!quotaRecorder) {
                trace.quotaEvidence.unavailableDiagnostics = (ctx.quotaEvidenceErrors ?? []).slice();
                throw new Error("缺少 quota 记录器，保留原错误阻断");
              }
              quotaRecorder.begin({ mode, attempt, unitId: unit.id, stateId: unit.stateId });
              quotaBegan = true;
              trace.quotaEvidence.started = true;
            } catch (error) {
              quotaFailure("begin", error);
            }
          }
          const outcome = await step(effective, "trigger");
          if (quotaTrigger && quotaBegan) {
            try {
              quotaRecorder.markTriggerResult(outcome.ok);
            } catch (error) {
              quotaFailure("trigger-result", error);
            }
          }
          if (!outcome.ok) {
            blockers.push(`触发步骤失败（${catalogStep.action} ${catalogStep.selector ?? ""}）：${outcome.error}`);
            break;
          }
        }
      }

      // 2.5 单元级收尾步骤（catalog 步骤之后、就绪等待之前）：日历选完终点后弹层
      // 自动关闭，重开一次才会渲染出 range-end——真实用户回看选区就是这么做的
      for (const extra of unit.postSteps ?? []) {
        const outcome = await step(extra, "trigger");
        if (!outcome.ok) blockers.push(`收尾步骤失败（${extra.action} ${extra.selector ?? ""}）：${outcome.error}`);
      }

      // 3. 就绪等待（每状态独立 timeout）
      if (!blockers.some((blocker) => STEP_FAILURE_PREFIXES.some((prefix) => blocker.startsWith(prefix)))) {
        const readyOutcome = await waitStateReady(page, state.ready, unit.readyTimeoutMs ?? stateTimeoutMs);
        trace.ready = readyOutcome;
        if (!readyOutcome.ok) {
          blockers.push(
            `状态 ${unit.stateId} 未在 ${unit.readyTimeoutMs ?? stateTimeoutMs}ms 内就绪（${state.ready?.kind} ${state.ready?.selector ?? ""}）：${readyOutcome.error}`,
          );
        }
      }

      if (trace.ready?.ok && unit.importControls) {
        await captureImportControlInteractions({ page, unit, stateTimeoutMs, trace, blockers, shots, step });
      }
      if (trace.ready?.ok && Array.isArray(unit.timelineModeSequence)) {
        timelineModeMeasurements =
          (await captureTimelineModeInteractions({
            page,
            modes: unit.timelineModeSequence,
            stateTimeoutMs,
            trace,
            blockers,
            shots,
            step,
            candidate,
            skinMode: mode,
            stateId: unit.stateId,
            roleCatalog: adaptRoleCatalogForMeasurement(ROLE_CATALOG),
            policy,
          })) ?? {};
      }

      // 4. 显式保留触发视口的单元保持不动，其它状态仍回顶部；区域裁图自身不滚动。
      if (trace.ready?.ok) {
        try {
          await settleStateEvidenceViewport(page, unit);
          if (unit.group === "D" && (unit.stateId === "dashboard-default" || unit.stateId === "dense-data")) {
            const restingPointer = {};
            trace.restingPointer = restingPointer;
            try {
              await applySpotlight(page, "off", stateTimeoutMs, restingPointer);
            } catch (error) {
              restingPointer.error = error instanceof Error ? error.message : String(error);
              throw error;
            }
          }
          if (unit.clipSelector) {
            const region = await captureRegionShot(page, unit.clipSelector);
            if (region.ok) shots.region = region;
            else trace.regionMiss = region.reason;
          }
          shots.state = await page.screenshot({ fullPage: false });
          geometry = {
            unitId: unit.id,
            stateId: unit.stateId,
            mode,
            skinId,
            ...(await page.evaluate(buildLayoutProbeSource())),
          };
        } catch (error) {
          blockers.push(`状态取证失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // 5. M3 测量（有预期角色的状态；角色 pass/fail/unmeasured 是证据不是捕获阻断）
      if (
        trace.ready?.ok &&
        Array.isArray(state.expectedRoleIds) &&
        state.expectedRoleIds.length > 0 &&
        !blockers.length
      ) {
        if (unit.stateId === "button-hover") {
          trace.hoverMeasurement = { before: await evaluateReady(page, state.ready), after: null };
        }
        if (unit.stateId === "button-hover" && trace.hoverMeasurement.before !== true) {
          blockers.push("悬停状态在M3测量前丢失：button-hover，停止测量");
          measurement = {
            records: [],
            captures: [],
            diagnostics: {
              candidateId: candidate?.id ?? null,
              mode,
              stateId: unit.stateId,
              partial: true,
              counts: { pass: 0, fail: 0, unmeasured: 0, notApplicable: 0 },
              notes: ["悬停在M3前丢失，未执行测量"],
            },
          };
        } else {
          try {
            const started = Date.now();
            const adapted = adaptRoleCatalogForMeasurement(ROLE_CATALOG);
            trace.roleScopeAdaptation = [];
            trace.roleScopeGaps = [];
            const detailFillRestingPointer =
              unit.kind === "catalog" &&
              state.id !== "spotlight-detail-fill" &&
              Array.isArray(state.expectedRoleIds) &&
              state.expectedRoleIds.includes("chart.detail-fill")
                ? async () => {
                    const record = {};
                    trace.detailFillRestingPointer.push(record);
                    try {
                      await applySpotlight(page, "off", stateTimeoutMs, record);
                    } catch (error) {
                      record.error = error instanceof Error ? error.message : String(error);
                      throw error;
                    }
                  }
                : null;
            if (detailFillRestingPointer) trace.detailFillRestingPointer = [];
            measurement = await measureBrowserRoles({
              page,
              candidate,
              mode,
              stateId: unit.stateId,
              roleCatalog: adapted,
              policy,
              ...(detailFillRestingPointer ? { detailFillRestingPointer } : {}),
            });
            trace.durations.measureBrowserRoles = Date.now() - started;
          } catch (error) {
            const failure = failedCatalogMeasurement(error, {
              candidateId: candidate?.id ?? null,
              mode,
              stateId: unit.stateId,
            });
            measurement = failure.measurement;
            const originalError = measurementErrorTrace(error);
            trace.measurementFailure = {
              complete: false,
              phase: failure.phase,
              packet: failure.packet,
              reason: failure.reason ?? null,
              error: originalError,
            };
            blockers.push(`measureBrowserRoles（${unit.stateId}）失败：${originalError.message}`);
          } finally {
            if (unit.stateId === "button-hover") {
              trace.hoverMeasurement.after = await evaluateReady(page, state.ready);
              if (trace.hoverMeasurement.after !== true) blockers.push("悬停状态在M3测量后丢失：button-hover");
            }
          }
        }
      }

      // 5b. 目标元素取证（unit.evidenceTargets）：焦点环这类目录无法机测、卡面要求
      // 原尺寸截图人工核验的角色，控件常在首屏之外——收在几何与测量之后、恢复之前，
      // 滚动只改视口口径，不动焦点/主题/皮肤这些被捕获状态
      if (trace.ready?.ok && Array.isArray(unit.evidenceTargets)) {
        for (const [index, selector] of unit.evidenceTargets.entries()) {
          const field = `target${index + 1}`;
          try {
            const shot = await captureScrolledRegionShot(page, selector);
            if (shot.ok) shots[field] = shot;
            else trace.targetMisses = [...(trace.targetMisses ?? []), `${field}: ${shot.reason}`];
          } catch (error) {
            trace.targetMisses = [
              ...(trace.targetMisses ?? []),
              `${field}: ${error instanceof Error ? error.message : String(error)}`,
            ];
          }
        }
      }

      // 6. 入口已就绪时仅重建 focus，catalog 恢复仍对称跳过；全局基准复位保持原流程。
      endQuotaWindow();
      if (entryReady) {
        trace.restore.push({ phase: "restore", action: "skipped", reason: "entry-ready" });
      } else {
        for (const restorePreStep of unit.restorePreSteps ?? []) {
          const restored = await step(restorePreStep, "restore");
          if (!restored.ok) {
            blockers.push(
              `恢复前置步骤失败（${restorePreStep.action} ${restorePreStep.selector ?? ""}）：${restored.error}`,
            );
          }
        }
        for (const restoreStep of state.restore ?? []) {
          const restored = await step(restoreStep, "restore");
          if (!restored.ok)
            blockers.push(`恢复步骤失败（${restoreStep.action} ${restoreStep.selector ?? ""}）：${restored.error}`);
        }
      }
    }

    // 7. 单元级恢复补充（聚光组合的透明度还原等）
    for (const extra of unit.postRestoreSteps ?? []) {
      const restored = await step(extra, "restore");
      if (!restored.ok) blockers.push(`补充恢复步骤失败（${extra.action} ${extra.selector ?? ""}）：${restored.error}`);
    }

    // 8. 故障恢复（autorefresh-error：还原路由 + 开关自身完成确定性恢复）
    if (unit.recovery) {
      trace.recovery = { expectGone: unit.recovery.expectGone, steps: [] };
      if (unit.recovery.unrouteFault && unrouteFault) await unrouteFault();
      for (const recoveryStep of unit.recovery.steps ?? []) {
        const outcome = await step(recoveryStep, "recovery");
        if (!outcome.ok) blockers.push(`恢复步骤失败（${recoveryStep.action}）：${outcome.error}`);
      }
      if (unit.recovery.expectGone) {
        try {
          await page.waitForFunction(
            `(() => !document.querySelector(${JSON.stringify(unit.recovery.expectGone)}))()`,
            undefined,
            { timeout: stateTimeoutMs },
          );
          trace.recovery.errorCleared = true;
        } catch (error) {
          blockers.push(
            `恢复后错误提示未在 ${stateTimeoutMs}ms 内清除（${unit.recovery.expectGone}）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }

    // 9. 基准复位（重载规程自身就是复位，不重复）
    if (unit.handler !== "reload-preferences") {
      const rebaseline = await rebaselineToAll(page, stateTimeoutMs, trace);
      if (!rebaseline.ok) blockers.push(`基准复位失败：${JSON.stringify(rebaseline.failures)}`);
    }

    // 10. 复读 20 项声明：恢复后必须回到本模式期望（旧色残留即阻断）
    try {
      const post = await page.evaluate(buildDeclarationsProbeSource());
      const postDiffs = diffPaletteDeclarations(expectedPairs, post.declarations);
      trace.declarations.post = post.declarations;
      trace.declarations.postMatches = postDiffs.length === 0;
      if (postDiffs.length > 0) {
        blockers.push(`恢复后 20 项声明与期望不一致（疑似旧色残留）：${JSON.stringify(postDiffs)}`);
      }
    } catch (error) {
      blockers.push(`恢复后声明复读失败：${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    blockers.push(`状态单元流程异常：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    endQuotaWindow();
    if (unrouteFault) await unrouteFault();
  }

  if (isQuotaUnit && quotaBegan) {
    try {
      quotaSnapshot = await quotaRecorder.settleAndSnapshot();
      trace.quotaEvidence.snapshot = quotaSnapshot;
      if (!quotaSnapshot?.scope || !Number.isSafeInteger(quotaSnapshot.scope.endOrder))
        throw new Error("quota 快照窗口未结束");
    } catch (error) {
      quotaFailure("snapshot", error);
    }
  }
  if (isQuotaUnit) {
    trace.quotaEvidence.collectorErrors = (ctx.quotaEvidenceErrors ?? []).slice(quotaDiagnosticStart);
    if (trace.quotaEvidence.collectorErrors.length)
      quotaFailure("handler", new Error("原生事件 hook 异常，原错误继续阻断"));
  }
  const deltaErrors = errorDelta(errors, errorStart);
  // 故障注入的伴生错误不计入阻断：abort 掉 /api/usage 必然产生 requestFailed 与
  // 浏览器那句 "Failed to load resource" 控制台噪声——它们正是本状态的触发因，
  // 不是缺陷。两类 induced 错误完整留在 trace.faultInducedErrors 供审计，其余
  // 错误（页面异常、真实 ≥400、非故障 URL 失败）仍逐项阻断。
  if (faultPattern) {
    const induced = { requestFailed: [], consoleErrors: [] };
    const scoped = { ...deltaErrors };
    scoped.requestFailed = deltaErrors.requestFailed.filter((entry) => {
      if (faultPattern.test(String(entry?.url ?? ""))) {
        induced.requestFailed.push(entry);
        return false;
      }
      return true;
    });
    scoped.consoleErrors = deltaErrors.consoleErrors.filter((text) => {
      if (/^Failed to load resource: /.test(String(text))) {
        induced.consoleErrors.push(text);
        return false;
      }
      return true;
    });
    trace.faultInducedErrors = induced;
    blockers.push(...buildStateBlockers(scoped));
  } else if (isQuotaUnit && quotaBegan && !quotaBroken && quotaSnapshot) {
    try {
      const offsets = {
        resourceFailures: quotaBeginCounts.resourceFailures - errorStart.resourceFailures,
        consoleErrors: quotaBeginCounts.consoleErrors - errorStart.consoleErrors,
      };
      const shift = (index, offset) => (Number.isSafeInteger(index) && index >= 0 ? index + offset : null);
      const responses = quotaSnapshot.responses.map((entry) => ({
        ...entry,
        resourceFailureIndex: shift(entry.resourceFailureIndex, offsets.resourceFailures),
      }));
      const consoles = quotaSnapshot.consoles.map((entry) => ({
        ...entry,
        index: shift(entry.index, offsets.consoleErrors),
      }));
      trace.quotaEvidence.indexTranslation = { unitErrorStart: errorStart, recorderBegin: quotaBeginCounts, offsets };
      trace.quotaEvidence.translatedIndexes = {
        responses: responses.map((entry) => ({
          requestId: entry.requestId,
          resourceFailureIndex: entry.resourceFailureIndex,
        })),
        consoles: consoles.map((entry) => ({ index: entry.index, order: entry.order })),
      };
      const classified = classifyExpectedQuotaErrors({
        errors: deltaErrors,
        scope: quotaSnapshot.scope,
        responses,
        consoles,
      });
      if (!errorCountKeys.every((key) => Array.isArray(classified?.scopedErrors?.[key])))
        throw new Error("quota 分类未返回完整错误数组");
      trace.quotaEvidence.expectedErrors = classified.expectedErrors;
      trace.quotaEvidence.matches = classified.matches;
      trace.quotaEvidence.rejected = classified.rejected;
      blockers.push(...buildStateBlockers(classified.scopedErrors));
    } catch (error) {
      quotaFailure("classification", error);
      blockers.push(...buildStateBlockers(deltaErrors));
    }
  } else {
    blockers.push(...buildStateBlockers(deltaErrors));
  }
  const status = blockers.length === 0 ? "captured" : "failed";
  return {
    status,
    blockers,
    trace,
    measurement,
    timelineModeMeasurements,
    geometry,
    shots,
    durations: trace.durations,
    errors: deltaErrors,
    stateId: unit.stateId ?? null,
  };
}

/** S7 规程一：主题往返（进入主题 → 对侧主题 → 回到进入主题），20 项声明在对侧主题必须整体切换。 */
async function runThemeRoundtrip({ page, mode, otherModePairs, trace, blockers, step, shots }) {
  const readDeclarations = () => page.evaluate(buildDeclarationsProbeSource());
  const entry = await readDeclarations();
  const otherMode = mode === "light" ? "dark" : "light";
  trace.verification = {
    handler: "theme-roundtrip",
    entryTheme: entry.dataset.theme,
    otherTheme: otherMode,
    checks: [],
  };
  const switched = await step({ action: "setTheme", value: otherMode }, "trigger");
  if (!switched.ok) {
    blockers.push(`主题切换到 ${otherMode} 失败：${switched.error}`);
    return;
  }
  const atOther = await readDeclarations();
  const otherDiffs = diffPaletteDeclarations(otherModePairs, atOther.declarations);
  trace.verification.atOtherTheme = {
    theme: atOther.dataset.theme,
    declarationsMatch: otherDiffs.length === 0,
    differences: otherDiffs,
  };
  trace.verification.checks.push({
    label: `20 项声明在 ${otherMode} 主题下与 ${otherMode} 模式期望一致`,
    ok: otherDiffs.length === 0,
  });
  if (otherDiffs.length > 0) {
    blockers.push(`${otherMode} 主题下 20 项声明与期望不一致：${JSON.stringify(otherDiffs)}`);
  }
  try {
    await page.evaluate(PAINT_SETTLE_SOURCE);
    shots.otherTheme = await page.screenshot({ fullPage: false });
  } catch (error) {
    blockers.push(`对侧主题截图失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const restored = await step({ action: "setTheme", value: mode }, "restore");
  if (!restored.ok) blockers.push(`主题恢复到 ${mode} 失败：${restored.error}`);
}

/** S7 规程二：重载页面，偏好（主题/皮肤/角色/透明度）与 20 项声明必须原样恢复。 */
async function runReloadPreferences({
  page,
  mode,
  skinId,
  expectedPairs,
  stateTimeoutMs,
  baselineTimeoutMs,
  trace,
  blockers,
  shots,
}) {
  const readDeclarations = () => page.evaluate(buildDeclarationsProbeSource());
  const before = await readDeclarations();
  trace.verification = {
    handler: "reload-preferences",
    before: {
      theme: before.dataset.theme,
      skin: before.dataset.skin,
      skinCharacters: before.dataset.skinCharacters,
      skinOpacity: before.dataset.skinOpacity,
    },
    checks: [],
  };
  const started = Date.now();
  await page.reload({ timeout: baselineTimeoutMs, waitUntil: "commit" });
  trace.durations.reload = Date.now() - started;
  const bootstrapReady = await waitOk(
    { page, blockers, durations: trace.durations },
    "reloadBootstrapReady",
    buildBootstrapReadySource(mode),
    stateTimeoutMs,
  );
  if (!bootstrapReady) return;
  await awaitRuntimeReady({ page, stateTimeoutMs, readiness: trace.readiness, durations: trace.durations, blockers });
  const after = await readDeclarations();
  const diffs = diffPaletteDeclarations(expectedPairs, after.declarations);
  const expectedDataset = { theme: mode, skin: skinId, skinCharacters: "on", skinOpacity: "0.5" };
  const actualDataset = {
    theme: after.dataset.theme,
    skin: after.dataset.skin,
    skinCharacters: after.dataset.skinCharacters,
    skinOpacity: after.dataset.skinOpacity,
  };
  const datasetOk = JSON.stringify(expectedDataset) === JSON.stringify(actualDataset);
  trace.verification.after = {
    ...actualDataset,
    declarationsMatch: diffs.length === 0,
    differences: diffs,
    datasetMatchesBaseline: datasetOk,
  };
  trace.verification.checks.push({ label: "重载后 20 项声明与期望一致", ok: diffs.length === 0 });
  trace.verification.checks.push({ label: "重载后偏好回到基准（主题/皮肤/角色/50%）", ok: datasetOk });
  if (diffs.length > 0) blockers.push(`重载后 20 项声明与期望不一致：${JSON.stringify(diffs)}`);
  if (!datasetOk) {
    blockers.push(
      `重载后偏好与基准不一致：期望 ${JSON.stringify(expectedDataset)} 实际 ${JSON.stringify(actualDataset)}`,
    );
  }
  try {
    await page.evaluate(PAINT_SETTLE_SOURCE);
    shots.reloaded = await page.screenshot({ fullPage: false });
  } catch (error) {
    blockers.push(`重载后截图失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** S7 规程三：character → classic → character；classic 下候选色必须整体清除，回来必须整体恢复。 */
async function runSkinRoundtrip({ page, skinId, expectedPairs, stateTimeoutMs, trace, blockers, step, shots }) {
  const readDeclarations = () => page.evaluate(buildDeclarationsProbeSource());
  const entry = await readDeclarations();
  trace.verification = { handler: "skin-roundtrip", entrySkin: entry.dataset.skin, classicSkin: "classic", checks: [] };
  const toClassic = await step({ action: "selectSkin", value: "classic" }, "trigger");
  if (!toClassic.ok) {
    blockers.push(`切换到 classic 失败：${toClassic.error}`);
    return;
  }
  await page
    .waitForFunction('(() => document.documentElement.dataset.skin === "classic")()', undefined, {
      timeout: stateTimeoutMs,
    })
    .catch((error) => {
      blockers.push(`切换到 classic 后 data-skin 未就绪：${error instanceof Error ? error.message : String(error)}`);
    });
  const atClassic = await readDeclarations();
  const classicDiffs = diffPaletteDeclarations(expectedPairs, atClassic.declarations);
  trace.verification.atClassic = {
    skin: atClassic.dataset.skin,
    candidateColoursCleared: classicDiffs.length > 0,
    differenceCount: classicDiffs.length,
  };
  trace.verification.checks.push({
    label: "classic 下候选色被整体清除（与候选期望存在差异）",
    ok: classicDiffs.length > 0,
  });
  if (classicDiffs.length === 0) {
    blockers.push("切换到 classic 后 20 项声明与候选完全一致——候选色未被清除（旧色残留嫌疑）");
  }
  try {
    await page.evaluate(PAINT_SETTLE_SOURCE);
    shots.classic = await page.screenshot({ fullPage: false });
  } catch (error) {
    blockers.push(`classic 截图失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const back = await step({ action: "selectSkin", value: skinId }, "restore");
  if (!back.ok) {
    blockers.push(`恢复到 ${skinId} 失败：${back.error}`);
    return;
  }
  await page
    .waitForFunction(`(() => document.documentElement.dataset.skin === ${JSON.stringify(skinId)})()`, undefined, {
      timeout: stateTimeoutMs,
    })
    .catch((error) => {
      blockers.push(`恢复到 ${skinId} 后 data-skin 未就绪：${error instanceof Error ? error.message : String(error)}`);
    });
}

// ---------------------------------------------------------------------------
// 单元证据落盘（checks.json / geometry.json / PNG / state.json）
// ---------------------------------------------------------------------------

/**
 * 单元证据落盘。成功单元写 <mode>/states/<unitId>/，失败尝试写同级的 attempt-N/
 * （历史尝试保留、不删除；调用方已判定键状态——已 captured 的单元永不再落盘）。
 *
 * 卡面要求每状态产出 checks.json / geometry.json / PNG。measureBrowserRoles 有
 * 结果的单元写逐角色判据与 captures/ 截图索引；规程单元（S7）没有预期角色，
 * checks.json 以最小形状落盘并注明“无逐角色判据”，验收以 state.json 的 20 项
 * 声明复读与轨迹为准——不编造判据。
 */
async function writeUnitEvidence({ unitDir, unit, mode, skinId, payload, candidateId }) {
  const measurement = payload.measurement ?? null;
  const measurementIdentity = normalizeMeasurementIdentity({
    candidateId,
    records: measurement?.records ?? [],
    diagnostics: measurement?.diagnostics ?? null,
    label: `${unit.id} checks.json`,
  });
  const timelineMeasurementIdentities = new Map(
    Object.entries(payload.timelineModeMeasurements ?? {}).map(([viewMode, variantMeasurement]) => [
      viewMode,
      normalizeMeasurementIdentity({
        candidateId,
        records: variantMeasurement.records ?? [],
        diagnostics: variantMeasurement.diagnostics ?? null,
        label: `${unit.id} checks.timeline-${viewMode}.json`,
      }),
    ]),
  );
  await mkdir(unitDir, { recursive: true });
  const screenshots = {};
  const files = {};
  const shotEntries = [
    ["state", payload.shots?.state, "state.png"],
    ["region", payload.shots?.region, "region.png"],
    ["otherTheme", payload.shots?.otherTheme, "other-theme.png"],
    ["classic", payload.shots?.classic, "classic.png"],
    ["reloaded", payload.shots?.reloaded, "reloaded.png"],
    ["sourceDirectorySelected", payload.shots?.sourceDirectorySelected, "source-directory-selected.png"],
    ["sourceFiltered", payload.shots?.sourceFiltered, "source-filtered.png"],
    ["timelineModel", payload.shots?.timelineModel, "timeline-model.png"],
    ["timelineCost", payload.shots?.timelineCost, "timeline-cost.png"],
    // 目标元素取证（evidenceTargets）：target1/target2… 与 region 同形（带 clip）
    ...Object.entries(payload.shots ?? {})
      .filter(([field]) => /^target\d+$/.test(field))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([field, value]) => [field, value, `${field}.png`]),
  ];
  for (const [field, value, fileName] of shotEntries) {
    if (!value) continue;
    // region 是 captureRegionShot 的结果对象（{ ok, buffer, clip }），其余是裸 Buffer
    const buffer = Buffer.isBuffer(value) ? value : value?.buffer;
    if (!Buffer.isBuffer(buffer)) continue;
    const fileKey = field === "state" ? "stateScreenshot" : field;
    files[fileKey] = await saveScreenshotBuffer(path.join(unitDir, fileName), buffer);
    screenshots[field] = Buffer.isBuffer(value) ? fileName : { file: fileName, clip: value.clip ?? null };
  }
  if (payload.geometry) {
    files.geometry = "geometry.json";
    await writeJson(path.join(unitDir, "geometry.json"), payload.geometry);
  }

  const captureIndex = [];
  if (measurement) {
    const capturesDir = path.join(unitDir, "captures");
    await mkdir(capturesDir, { recursive: true });
    for (const [index, capture] of (measurement.captures ?? []).entries()) {
      const fileName = `${String(index).padStart(3, "0")}-${capture.roleId || "capture"}.png`;
      const file = `captures/${fileName}`;
      const saved = await saveScreenshotBuffer(path.join(unitDir, file), Buffer.from(capture.pngBase64, "base64"));
      files[`capture${String(index).padStart(3, "0")}`] = { ...saved, file };
      captureIndex.push({
        index,
        roleId: capture.roleId ?? null,
        kind: capture.kind ?? null,
        file,
      });
    }
  }

  const measurementVariants = {};
  const trace = payload.trace ? structuredClone(payload.trace) : null;
  for (const [viewMode, variantMeasurement] of Object.entries(payload.timelineModeMeasurements ?? {})) {
    const variantIdentity = timelineMeasurementIdentities.get(viewMode);
    const captureIndexForMode = [];
    const captureDir = `captures/timeline-${viewMode}`;
    await mkdir(path.join(unitDir, captureDir), { recursive: true });
    for (const [index, capture] of (variantMeasurement.captures ?? []).entries()) {
      const fileName = `${String(index).padStart(3, "0")}-${capture.roleId || "capture"}.png`;
      const file = `${captureDir}/${fileName}`;
      const saved = await saveScreenshotBuffer(path.join(unitDir, file), Buffer.from(capture.pngBase64, "base64"));
      files[`timeline${viewMode[0].toUpperCase()}${viewMode.slice(1)}Capture${String(index).padStart(3, "0")}`] = {
        ...saved,
        file,
      };
      captureIndexForMode.push({
        index,
        roleId: capture.roleId ?? null,
        kind: capture.kind ?? null,
        file,
      });
    }
    const checksFile = `checks.timeline-${viewMode}.json`;
    files[`timeline${viewMode[0].toUpperCase()}${viewMode.slice(1)}Checks`] = checksFile;
    await writeJson(path.join(unitDir, checksFile), {
      schemaVersion: 1,
      kind: "skin-palette-capture-checks",
      unitId: unit.id,
      stateId: payload.stateId ?? null,
      mode,
      viewMode,
      candidateId: variantIdentity.candidateId,
      status: payload.status,
      counts: variantMeasurement.diagnostics?.counts ?? null,
      diagnostics: variantIdentity.diagnostics,
      records: variantIdentity.records,
      captureIndex: captureIndexForMode,
    });
    measurementVariants[viewMode] = { checks: checksFile, captureIndex: captureIndexForMode };
    const traceEntry = trace?.timelineModes?.checks?.find((entry) => entry.mode === viewMode);
    if (traceEntry) {
      traceEntry.measurementEvidence = {
        checks: checksFile,
        recordCount: variantMeasurement.records?.length ?? 0,
        captureCount: captureIndexForMode.length,
      };
    }
  }

  files.checks = "checks.json";
  await writeJson(path.join(unitDir, "checks.json"), {
    schemaVersion: 1,
    kind: "skin-palette-capture-checks",
    unitId: unit.id,
    stateId: payload.stateId ?? null,
    mode,
    candidateId: measurementIdentity.candidateId,
    status: payload.status,
    counts: measurement?.diagnostics?.counts ?? null,
    diagnostics: measurementIdentity.diagnostics,
    records: measurementIdentity.records,
    captureIndex,
    ...(measurement
      ? {}
      : {
          note: "本单元无 STATE_CATALOG 预期角色（规程或空角色集）：无逐角色判据，验收以 state.json 的 20 项声明复读与轨迹为准",
        }),
  });
  files.state = "state.json";
  await writeJson(path.join(unitDir, "state.json"), {
    schemaVersion: 1,
    kind: "skin-palette-capture-state",
    unitId: unit.id,
    group: unit.group ?? null,
    groupLabel: unit.groupLabel ?? null,
    unitKind: unit.kind,
    stateId: payload.stateId ?? null,
    mode,
    skinId,
    attempt: payload.trace?.attempt ?? null,
    status: payload.status,
    blockers: payload.blockers ?? [],
    durations: payload.durations ?? {},
    screenshots,
    captures: captureIndex,
    files,
    measurementVariants,
    trace,
    errors: payload.errors ?? {},
  });
  const evidenceHash = await hashEvidenceTree(unitDir);
  return { files, screenshots, captureIndex, measurementVariants, evidenceHash };
}

// ---------------------------------------------------------------------------
// 候选入口快照与期望声明（captureBaseline / captureStateMatrix 共用）
// ---------------------------------------------------------------------------

/**
 * 入口同步固定候选（第一个 await 之前完成）：canonicalJson 严格快照 +
 * validateCandidate。JSON.stringify 会洗白 undefined/稀疏数组/Date/循环引用这些
 * 非法形状，快照一律走 canonicalJson——期望颜色派生、预览服务、测量与元数据全部
 * 只用这一份，调用方对象跨 await 的改动进不了证据（M4.1 启动边界同款语义）。
 */
function snapshotCaptureCandidate({ candidate, skinId: skinIdOption, label }) {
  const productionMode = candidate === null;
  let skinId = skinIdOption;
  let candidateSnapshot = null;
  if (productionMode) {
    if (typeof skinId !== "string" || !Object.hasOwn(SKIN_PALETTES, skinId)) {
      throw new TypeError(`${label}: 正式色源模式必须提供 SKIN_PALETTES 内的 skinId（收到 ${JSON.stringify(skinId)}）`);
    }
  } else {
    if (!candidate || typeof candidate !== "object" || typeof candidate.skinId !== "string") {
      throw new TypeError(`${label}: candidate 必须是 M0 完整 Candidate 或 null（正式色源模式）`);
    }
    if (skinId !== null && skinId !== candidate.skinId) {
      throw new TypeError(`${label}: skinId(${skinId}) 与 candidate.skinId(${candidate.skinId}) 不一致`);
    }
    try {
      candidateSnapshot = JSON.parse(canonicalJson(candidate));
    } catch (error) {
      throw new TypeError(
        `${label}: candidate 必须是可严格序列化的完整 Candidate（快照失败：${
          error instanceof Error ? error.message : String(error)
        }）`,
      );
    }
    const check = validateCandidate(candidateSnapshot);
    if (!check.valid) {
      throw new TypeError(`${label}: candidate 未通过 M0 契约校验：${JSON.stringify(check.errors)}`);
    }
    skinId = candidateSnapshot.skinId;
  }
  return { productionMode, skinId, candidateSnapshot };
}

/** 两模式期望声明（M1.1 派生）：候选取快照 modes，正式色源取 SKIN_PALETTES。 */
function deriveExpectedPairs({ productionMode, skinId, candidateSnapshot, modes, label }) {
  const expectedPairs = {};
  for (const mode of modes) {
    const tokens = productionMode ? SKIN_PALETTES[skinId][mode] : candidateSnapshot.modes[mode];
    const derived = derivePaletteDeclarationsFromTokens(tokens, mode);
    if (!derived || derived.length !== PALETTE_CSS_VAR_NAMES.length) {
      throw new TypeError(`${label}: ${skinId}/${mode} 无法派生完整 20 项声明`);
    }
    expectedPairs[mode] = [...derived];
  }
  return expectedPairs;
}

// ---------------------------------------------------------------------------
// 状态矩阵捕获（一次命令一个候选：先一个模式，再另一个模式）
// ---------------------------------------------------------------------------

/**
 * 一模式的矩阵捕获。单 fixture 时 S1—S8 共用主上下文；双 fixture 时 S8 与 base 分开。
 * D 组每个桌面视口独立上下文（视口只能在建上下文时定）。
 *
 * 失败与恢复纪律：
 *   - 新上下文基准页面不可达 = 服务级故障：当前单元如实 failed，本模式后续单元记
 *     incomplete，不再在空上下文上执行；
 *   - 单元失败一次：关闭当前上下文、尝试证据落 attempt-N/，在新上下文复跑一次；
 *   - 单元最多两次实际执行，预算跨 resume 共享且写入摘要；复跑仍失败则保留两个
 *     独立目录并记 failed，后续续跑不得重置预算或覆盖历史；
 *   - 已 captured 的单元（含续跑）跳过，落盘永远不覆盖成功证据。
 */
export function buildMatrixCaptureSequences({
  units,
  wantBaseline,
  fixtureBindings = null,
  fixtureHash,
  previewUrl,
  warningPreviewUrl = null,
}) {
  const sequences = [];
  const byViewport = new Map();
  for (const unit of units) {
    if (unit.kind === "baseline") continue;
    const viewportKey = unit.viewport ? `${unit.viewport.width}x${unit.viewport.height}` : "base";
    const binding = fixtureBindings?.[unit.group] ?? { fixtureKind: "base", fixtureHash };
    const isWarning = binding.fixtureKind === "timeline-range-warning";
    const key = fixtureBindings ? `${isWarning ? "warning" : "base"}:${viewportKey}` : viewportKey;
    if (!byViewport.has(key)) {
      byViewport.set(key, {
        viewport: unit.viewport,
        units: [],
        fixtureKind: binding.fixtureKind,
        fixtureHash: binding.fixtureHash,
        previewUrl: isWarning ? warningPreviewUrl : previewUrl,
      });
    }
    byViewport.get(key).units.push(unit);
  }
  for (const sequence of byViewport.values()) sequences.push(sequence);
  if (wantBaseline && !sequences.some((sequence) => sequence.fixtureKind === "base" && !sequence.viewport)) {
    sequences.unshift({ viewport: undefined, units: [], fixtureKind: "base", fixtureHash, previewUrl });
  }
  return sequences;
}

async function captureStateMatrixMode({
  mode,
  units,
  expectedPairs,
  otherModePairs,
  candidate,
  skinId,
  browser,
  previewUrl,
  warningPreviewUrl = null,
  outDir,
  measureBaseline,
  stateTimeoutMs,
  baselineTimeoutMs,
  progress,
  resumedCapturedUnits,
  writeProgress,
  markUnit,
  recordAttempt,
  fixtureHash,
  fixtureBindings = null,
}) {
  const captureCandidateId = candidate === null ? null : candidate.id;
  const baselineKey = `${mode}/${BASELINE_UNIT_ID}`;
  const modeDir = path.join(outDir, mode);
  const results = { status: "incomplete", blockers: [], gaps: [], baseline: null, states: {} };
  const wantBaseline = units.some((unit) => unit.kind === "baseline");

  const attemptsAlreadyUsed = (key, unitDir) => {
    const recorded = progress.attempts
      .filter((entry) => entry?.key === key && Number.isInteger(entry.attempt) && entry.attempt > 0)
      .reduce((highest, entry) => Math.max(highest, entry.attempt), 0);
    let evidenced = 0;
    for (let attempt = 1; attempt <= MAX_MATRIX_ATTEMPTS_PER_UNIT; attempt += 1) {
      if (existsSync(path.join(unitDir, `attempt-${attempt}`, "state.json"))) evidenced = attempt;
    }
    return Math.max(recorded, evidenced);
  };

  // Keep sequence planning pure so baseline-only matrix groups stay testable without a browser.
  const sequences = buildMatrixCaptureSequences({
    units,
    wantBaseline,
    fixtureBindings,
    fixtureHash,
    previewUrl,
    warningPreviewUrl,
  });

  const runBaseline = async (ctx, captureEvidence, measureRoles = measureBaseline) =>
    runBaselineCapture({
      ctx,
      mode,
      skinId,
      candidate,
      expectedPairs,
      outModeDir: modeDir,
      stateTimeoutMs: baselineTimeoutMs,
      policy: POLICY,
      measureRoles,
      captureEvidence,
      // S0 要求"聚光关闭"：catalog 触发会把指针留在凸起预设按钮上。
      restingPointer: true,
    });

  let serviceBroken = false;
  let baselineFailed = false;

  for (const sequence of sequences) {
    if (serviceBroken) break;
    let ctx = null;
    const closeContext = async () => {
      if (!ctx) return;
      const current = ctx;
      ctx = null;
      await current.close().catch(() => {});
    };
    /** 新建上下文并跑到基准就绪；基准不可达即服务级故障（抛给调用方收尾）。 */
    const openSequenceContext = async () => {
      const fresh = await createModeContext({
        browser,
        previewUrl: sequence.previewUrl,
        mode,
        skinId,
        viewport: sequence.viewport,
      });
      const isBaselineSequence = !fixtureBindings || (sequence.fixtureKind === "base" && !sequence.viewport);
      const baseline = await runBaseline(fresh, false, isBaselineSequence ? measureBaseline : false);
      if (baseline.status !== "captured") {
        await fresh.close().catch(() => {});
        throw new Error(`新上下文基准不可达：${baseline.blockers.map((item) => String(item)).join("；")}`);
      }
      return fresh;
    };

    try {
      ctx = await createModeContext({
        browser,
        previewUrl: sequence.previewUrl,
        mode,
        skinId,
        viewport: sequence.viewport,
      });
      const baselineAlready = progress.units[baselineKey]?.status === "captured";
      const isBaseSequence = sequence.fixtureKind === "base";
      const isBaselineSequence = !fixtureBindings || (isBaseSequence && !sequence.viewport);
      const wantBaselineEvidence = wantBaseline && !baselineAlready && isBaselineSequence;
      const baseline = await runBaseline(ctx, wantBaselineEvidence, isBaselineSequence ? measureBaseline : false);
      if (results.baseline === null && isBaselineSequence) {
        results.baseline = {
          status: baseline.status,
          blockers: baseline.blockers,
          moduleRequestCount: baseline.moduleRequestCount,
          pricingRefreshInterceptions: baseline.pricingRefreshInterceptions,
          firstScreenMatches: baseline.firstScreenMatches,
          runtimeMatches: baseline.runtimeMatches,
          durationMs: baseline.durationMs,
          evidence: wantBaselineEvidence ? baseline.evidence : null,
        };
      }
      if (baseline.status !== "captured") {
        serviceBroken = true;
        results.blockers.push(
          ...baseline.blockers.map(
            (item) =>
              `上下文基准（${mode}/${sequence.viewport ? `${sequence.viewport.width}x${sequence.viewport.height}` : "主视口"}）：${item}`,
          ),
        );
        if (wantBaseline && isBaselineSequence) {
          baselineFailed = true;
          results.blockers.push(...baseline.blockers.map((item) => `基准（${baselineKey}）：${item}`));
          recordAttempt(baselineKey, {
            attempt: 1,
            status: "failed",
            blockers: baseline.blockers,
            at: new Date().toISOString(),
          });
          markUnit(baselineKey, "failed", { blockers: baseline.blockers, attempts: 1 });
          await writeProgress();
        }
        continue;
      }
      if (wantBaseline && !baselineAlready && isBaselineSequence) {
        let baselineEvidence;
        try {
          baselineEvidence = await collectBaselineEvidenceManifest(modeDir, {
            mode,
            skinId,
            measureRoles: measureBaseline,
          });
        } catch (error) {
          const blockers = [`S0 固定附件清单生成失败：${error instanceof Error ? error.message : String(error)}`];
          baselineFailed = true;
          serviceBroken = true;
          results.baseline.status = "failed";
          results.baseline.blockers.push(...blockers);
          results.blockers.push(...blockers.map((item) => `基准（${baselineKey}）：${item}`));
          recordAttempt(baselineKey, {
            attempt: 1,
            status: "failed",
            blockers,
            at: new Date().toISOString(),
          });
          markUnit(baselineKey, "failed", { blockers, attempts: 1 });
          await writeProgress();
          break;
        }
        markUnit(baselineKey, "captured", { attempts: 1, evidence: ".", baselineEvidence });
        await writeProgress();
      }

      for (const unit of sequence.units) {
        const key = `${mode}/${unit.id}`;
        const unitDir = path.join(modeDir, "states", unit.id);
        if (progress.units[key]?.status === "captured") {
          const savedEvidence = resumedCapturedUnits.get(key);
          if (!savedEvidence) {
            throw new Error(`续跑单元 ${key} 未通过成功证据预检，拒绝跳过`);
          }
          results.states[unit.id] = { status: "captured", resumed: true };
          for (const adaptation of savedEvidence.roleScopeGaps) {
            results.gaps.push({
              unitId: unit.id,
              stateId: unit.stateId ?? null,
              reason: `角色 ${adaptation.roleId} 未由 M3.2 实测：${adaptation.reason}`,
            });
          }
          continue;
        }

        const runOnce = (attempt) =>
          runStateUnit({
            ctx,
            unit,
            mode,
            skinId,
            candidate,
            expectedPairs,
            otherModePairs,
            policy: POLICY,
            stateTimeoutMs,
            baselineTimeoutMs,
            attempt,
            fixtureHash: sequence.fixtureHash,
          });

        // 异常外壳：页面崩溃、上下文被提前关掉这类 throw 也按“失败一次 + 新上下文
        // 复跑一次”记账（卡面：失败后关闭当前上下文、写明确错误、不在损坏页面继续）。
        // 不设 catch 会让一趟捕获整体掀翻——进度和证据其实已逐单元落盘，本该能续跑。
        const runOnceSafely = async (attemptValue) => {
          try {
            return await runOnce(attemptValue);
          } catch (error) {
            return {
              status: "failed",
              blockers: [
                `单元 ${unit.id} 第 ${attemptValue} 次执行异常：${error instanceof Error ? error.message : String(error)}`,
              ],
              trace: { unitId: unit.id, mode, attempt: attemptValue, steps: [], restore: [], abnormal: true },
              measurement: null,
              geometry: null,
              shots: {},
              durations: {},
              errors: {},
              stateId: unit.stateId ?? null,
            };
          }
        };
        let attemptNumber = attemptsAlreadyUsed(key, unitDir) + 1;
        if (attemptNumber > MAX_MATRIX_ATTEMPTS_PER_UNIT) {
          const previous = progress.units[key] ?? {};
          const blockers = Array.isArray(previous.blockers)
            ? previous.blockers
            : ["本单元跨续跑重试预算已耗尽（最多 2 次实际执行）"];
          results.states[unit.id] = {
            status: "failed",
            blockers,
            attempts: MAX_MATRIX_ATTEMPTS_PER_UNIT,
            retryBudgetExhausted: true,
          };
          markUnit(key, "failed", {
            blockers,
            attempts: MAX_MATRIX_ATTEMPTS_PER_UNIT,
            retryBudgetExhausted: true,
          });
          await writeProgress();
          continue;
        }

        let outcome = await runOnceSafely(attemptNumber);
        if (outcome.status === "unreachable") {
          // 前置条件未命中：fixture 结构性不可达。落一条证据（状态 + 原因可审计），
          // 不重试、不计失败——未捕获的事实留在 gaps 里
          recordAttempt(key, {
            attempt: attemptNumber,
            status: "unreachable",
            reason: outcome.reason,
            at: new Date().toISOString(),
          });
          await writeUnitEvidence({
            unitDir,
            unit,
            mode,
            skinId,
            payload: outcome,
            candidateId: captureCandidateId,
          });
          markUnit(key, "unreachable", { reason: outcome.reason });
          results.states[unit.id] = { status: "unreachable", reason: outcome.reason };
          results.gaps.push({ unitId: unit.id, stateId: unit.stateId ?? null, reason: outcome.reason });
          await writeProgress();
          continue;
        }

        while (outcome.status !== "captured") {
          recordAttempt(key, {
            attempt: attemptNumber,
            status: outcome.status,
            blockers: outcome.blockers,
            at: new Date().toISOString(),
          });
          await writeUnitEvidence({
            unitDir: path.join(unitDir, `attempt-${attemptNumber}`),
            unit,
            mode,
            skinId,
            payload: outcome,
            candidateId: captureCandidateId,
          });
          await writeProgress();

          if (attemptNumber >= MAX_MATRIX_ATTEMPTS_PER_UNIT) break;
          await closeContext();
          try {
            ctx = await openSequenceContext();
          } catch (error) {
            recordAttempt(key, {
              attempt: attemptNumber,
              phase: "retry-open",
              status: "aborted",
              reason: error instanceof Error ? error.message : String(error),
              at: new Date().toISOString(),
            });
            serviceBroken = true;
            break;
          }
          attemptNumber += 1;
          outcome = await runOnceSafely(attemptNumber);
          if (outcome.status === "unreachable") {
            recordAttempt(key, {
              attempt: attemptNumber,
              status: "unreachable",
              reason: outcome.reason,
              at: new Date().toISOString(),
            });
            await writeUnitEvidence({
              unitDir,
              unit,
              mode,
              skinId,
              payload: outcome,
              candidateId: captureCandidateId,
            });
            markUnit(key, "unreachable", { reason: outcome.reason });
            results.states[unit.id] = { status: "unreachable", reason: outcome.reason };
            results.gaps.push({ unitId: unit.id, stateId: unit.stateId ?? null, reason: outcome.reason });
            await writeProgress();
            break;
          }
        }

        if (outcome.status === "unreachable") continue;
        if (outcome.status !== "captured") {
          markUnit(key, "failed", {
            blockers: outcome.blockers,
            attempts: attemptNumber,
            retryBudgetExhausted: attemptNumber >= MAX_MATRIX_ATTEMPTS_PER_UNIT,
          });
          results.states[unit.id] = {
            status: "failed",
            blockers: outcome.blockers,
            attempts: attemptNumber,
            retryBudgetExhausted: attemptNumber >= MAX_MATRIX_ATTEMPTS_PER_UNIT,
          };
          await writeProgress();
          if (serviceBroken) break;
          await closeContext();
          try {
            ctx = await openSequenceContext();
          } catch (error) {
            recordAttempt(key, {
              attempt: attemptNumber,
              phase: "continue-open",
              status: "aborted",
              reason: error instanceof Error ? error.message : String(error),
              at: new Date().toISOString(),
            });
            serviceBroken = true;
            break;
          }
          continue;
        }
        const savedEvidence = await writeUnitEvidence({
          unitDir,
          unit,
          mode,
          skinId,
          payload: outcome,
          candidateId: captureCandidateId,
        });
        markUnit(key, "captured", {
          attempts: attemptNumber,
          evidence: `states/${unit.id}`,
          evidenceHash: savedEvidence.evidenceHash,
        });
        results.states[unit.id] = { status: "captured", blockers: [] };
        for (const adaptation of outcome.trace?.roleScopeGaps ?? []) {
          results.gaps.push({
            unitId: unit.id,
            stateId: unit.stateId ?? null,
            reason: `角色 ${adaptation.roleId} 未由 M3.2 实测：${adaptation.reason}`,
          });
        }
        await writeProgress();
      }
    } finally {
      await closeContext();
    }
    if (serviceBroken) break;
  }

  // 未开局/服务级中断的剩余单元：明确 incomplete，不假装捕获过
  for (const unit of units) {
    if (unit.kind === "baseline") continue;
    const key = `${mode}/${unit.id}`;
    if (progress.units[key]?.status === "captured" || results.states[unit.id]) continue;
    results.states[unit.id] = { status: "incomplete", reason: serviceBroken ? "服务级中断后未执行" : "未执行" };
    markUnit(key, "incomplete", { reason: results.states[unit.id].reason });
  }
  if (serviceBroken || baselineFailed) {
    await writeProgress();
  }

  const stateStatuses = Object.values(results.states).map((entry) => entry.status);
  const baselineCaptured = !wantBaseline || progress.units[baselineKey]?.status === "captured";
  if (!baselineCaptured || stateStatuses.includes("failed")) results.status = "failed";
  else if (stateStatuses.some((status) => status !== "captured")) results.status = "incomplete";
  else results.status = "captured";
  return results;
}

/**
 * M4.3 状态矩阵与可恢复执行入口。一次命令只捕获一个候选：先完整捕获一个模式
 * （S0 基准 → S1—S8 → D 视口），再另一个模式；每状态独立 timeout（默认 15 秒）
 * 与结果；证据随完成随落盘（progress.json 每个单元后更新）。
 *
 * 恢复执行：resume=true 时校验 outDir 内含 progress.json 且摘要绑定一致（同
 * candidateHash / skinId / retryPolicy / policyHash / sourceHashes / fixtureHash / fixtureBindings）才续跑——已 captured
 * 的单元跳过（成功证据不覆盖），缺测与未耗尽预算的失败单元继续执行，最多两次
 * 实际尝试在同一证据目录内累计，历史尝试保留。
 * 摘要不一致或无进度文件一律报错，由调用方创建新捕获目录。
 */
/** Close matrix-owned resources and preserve the primary/cleanup thrown values in order. */
export async function closeCaptureMatrixResources({
  browser,
  warningPreview,
  preview,
  operationFailed = false,
  operationError,
} = {}) {
  const errors = [];
  if (operationFailed) errors.push(operationError);

  for (const resource of [browser, warningPreview, preview]) {
    if (resource === null || resource === undefined) continue;
    try {
      await resource.close();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "capture matrix operation and resource cleanup failed");
}

export async function captureStateMatrix({
  candidate = null,
  skinId: skinIdOption = null,
  fixture,
  timelineWarningFixture = null,
  outDir,
  modes = ["light", "dark"],
  rootDir = REPO_ROOT,
  browserRuntime = null,
  measureBaseline = true,
  stateTimeoutMs = 15000,
  baselineTimeoutMs = stateTimeoutMs,
  port = 0,
  resume = false,
  groups = null,
} = {}) {
  const label = "captureStateMatrix";
  if (!Array.isArray(modes) || modes.length === 0 || new Set(modes).size !== modes.length) {
    throw new TypeError(`${label}: modes 必须是不重复的非空数组`);
  }
  for (const mode of modes) {
    if (!MODES.includes(mode)) throw new TypeError(`${label}: 未知模式 "${String(mode)}"`);
  }
  for (const [name, value] of [
    ["measureBaseline", measureBaseline],
    ["resume", resume],
  ]) {
    if (typeof value !== "boolean") throw new TypeError(`${label}: ${name} 必须是布尔值`);
  }
  for (const [name, value] of [
    ["stateTimeoutMs", stateTimeoutMs],
    ["baselineTimeoutMs", baselineTimeoutMs],
  ]) {
    if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label}: ${name} 必须是正整数毫秒`);
  }
  const requestedGroupIds =
    Array.isArray(groups) && groups.length > 0 ? [...groups] : STATE_MATRIX_GROUPS.map((group) => group.id);
  const groupIds = timelineWarningFixture ? requestedGroupIds : [...new Set(requestedGroupIds)];
  const knownGroups = new Set(STATE_MATRIX_GROUPS.map((group) => group.id));
  for (const groupId of groupIds) {
    if (!knownGroups.has(groupId))
      throw new TypeError(`${label}: 未知矩阵组 "${String(groupId)}"（可选 ${[...knownGroups].join(" / ")}）`);
  }
  let fixtureBindings = null;
  if (timelineWarningFixture !== null) {
    if (fixture === timelineWarningFixture)
      throw new TypeError(`${label}: fixture 与 timelineWarningFixture 必须是不同实例`);
    fixtureBindings = buildFixedMatrixFixtureBindings({
      groups: groupIds,
      fixtureHash: fixture?.fixtureHash,
      warningFixtureHash: timelineWarningFixture?.fixtureHash,
    });
  }
  const units = effectiveMatrixUnits(groupIds).map((unit) =>
    unit.importControls ? { ...unit, expectedDirectoryPath: fixture?.pickedPath ?? null } : unit,
  );

  const { productionMode, skinId, candidateSnapshot } = snapshotCaptureCandidate({
    candidate,
    skinId: skinIdOption,
    label,
  });
  // 两模式期望声明都派生：S7 主题往返要在对侧主题核对 20 项声明，即使本次只
  // 捕获一个模式，对侧期望也必须有（缺了对侧期望就无法判定"整体切换"）
  const expectedPairs = deriveExpectedPairs({
    productionMode,
    skinId,
    candidateSnapshot,
    modes: [...MODES],
    label,
  });

  const runtime = browserRuntime ?? (await resolveBrowserRuntime());
  if (!runtime) {
    throw new Error(
      "ENVIRONMENT_BLOCKED: 未找到可用的 Playwright/Edge 运行时（AGENT_USAGE_PLAYWRIGHT_MODULE / AGENT_USAGE_EDGE_PATH），不伪造捕获",
    );
  }

  const sourceHashes = collectSourceHashes(SOURCE_FILES, (relativePath) =>
    readFileSync(path.join(REPO_ROOT, relativePath)),
  );
  const digests = {
    candidate: productionMode
      ? null
      : { id: candidateSnapshot.id, candidateHash: candidateSnapshot.candidateHash, skinId: candidateSnapshot.skinId },
    candidateHash: productionMode ? null : candidateSnapshot.candidateHash,
    skinId: productionMode ? skinId : candidateSnapshot.skinId,
    retryPolicy: MATRIX_RETRY_POLICY,
    policyHash: sha256Canonical(POLICY),
    fixtureHash: typeof fixture?.fixtureHash === "string" ? fixture.fixtureHash : null,
    ...(fixtureBindings ? { fixtureBindings } : {}),
    sourceHashes,
  };

  // ---- 输出目录与进度（恢复执行） ----
  const progressPath = path.join(outDir, "progress.json");
  let resolvedOutDir;
  let progress;
  const resumedCapturedUnits = new Map();
  if (resume) {
    resolvedOutDir = await assertCaptureOutputDir(outDir, rootDir, { requireEmpty: false });
    if (!existsSync(progressPath)) {
      throw new Error(`${label}: resume=true 但 ${progressPath} 不存在——没有进度可续（新捕获目录请传 resume=false）`);
    }
    let saved = null;
    try {
      saved = JSON.parse(await readFile(progressPath, "utf8"));
    } catch (error) {
      throw new Error(`${label}: progress.json 解析失败（${error instanceof Error ? error.message : String(error)}）`);
    }
    if (saved?.kind !== PROGRESS_KIND)
      throw new Error(`${label}: progress.json 不是本工具的进度文件（kind=${String(saved?.kind)}）`);
    if (fixtureBindings) {
      for (const [name, values, expected, known] of [
        ["groups", saved.groups, groupIds, knownGroups],
        ["modes", saved.modes, modes, new Set(MODES)],
      ]) {
        if (
          !Array.isArray(values) ||
          values.length !== expected.length ||
          new Set(values).size !== values.length ||
          values.some((value, index) => !known.has(value) || value !== expected[index])
        ) {
          throw new Error(`${label}: progress.json ${name} 缺失、无效或与本次运行不一致`);
        }
      }
      try {
        assertFixedMatrixFixtureBindings({
          groups: groupIds,
          fixtureHash: saved?.digests?.fixtureHash,
          fixtureBindings: saved?.digests?.fixtureBindings,
        });
      } catch (error) {
        throw new Error(
          `${label}: progress.json fixtureBindings 无效（${error instanceof Error ? error.message : String(error)}）`,
        );
      }
    }
    if (!resumeDigestsMatch(saved.digests, digests)) {
      throw new Error(
        `${label}: 摘要绑定不一致（${describeResumeDigestDifferences(saved.digests, digests).join(", ") || "未知字段"}）——必须创建新捕获目录，不得续跑`,
      );
    }
    progress = saved;
    progress.units = saved.units && typeof saved.units === "object" && !Array.isArray(saved.units) ? saved.units : {};
    progress.attempts = Array.isArray(saved.attempts) ? saved.attempts : [];
    progress.resumedAt = new Date().toISOString();
    // 已 captured 的 S0 是全矩阵角色判据的地基：无论本次是否选择 S0 组，
    // 都先校验固定附件（不含后续 states/），之后才允许写 progress.json/capture.json。
    for (const mode of modes) {
      const baselineKey = `${mode}/${BASELINE_UNIT_ID}`;
      const progressUnit = progress.units[baselineKey];
      if (progressUnit?.status !== "captured") continue;
      const requireMeasurements = units.some((unit) => unit.kind === "baseline") && measureBaseline;
      try {
        await readCapturedBaselineEvidence({
          modeDir: path.join(resolvedOutDir, mode),
          progressUnit,
          mode,
          skinId,
          requireMeasurements,
        });
      } catch (error) {
        throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // 在写回 progress.json 或最终 capture.json 之前，先校验所有要跳过的成功单元。
    // 这样缺图/损坏/被替换的证据会拒绝续跑，不会覆盖原报告；角色缺口也从原 state.json 恢复。
    for (const mode of modes) {
      for (const unit of units) {
        if (unit.kind === "baseline") continue;
        const key = `${mode}/${unit.id}`;
        const progressUnit = progress.units[key];
        if (progressUnit?.status !== "captured") continue;
        const state = unit.stateId ? STATE_BY_ID.get(unit.stateId) : null;
        try {
          const savedEvidence = await readCapturedUnitEvidence({
            unitDir: path.join(resolvedOutDir, mode, "states", unit.id),
            unit,
            mode,
            skinId,
            expectedRoleIds: state?.expectedRoleIds ?? [],
            expectedEvidenceHash: progressUnit.evidenceHash,
          });
          resumedCapturedUnits.set(key, savedEvidence);
        } catch (error) {
          throw new Error(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } else {
    resolvedOutDir = await assertCaptureOutputDir(outDir, rootDir);
    await mkdir(resolvedOutDir, { recursive: true });
    progress = {
      schemaVersion: 1,
      kind: PROGRESS_KIND,
      tool: "scripts/skin-palette/capture.mjs",
      createdAt: new Date().toISOString(),
      digests,
      modes,
      groups: groupIds,
      retryPolicy: MATRIX_RETRY_POLICY,
      units: {},
      attempts: [],
    };
  }
  const writeProgress = async () => {
    progress.lastUpdatedAt = new Date().toISOString();
    await writeJson(progressPath, progress);
  };
  const markUnit = (key, status, extra = {}) => {
    progress.units[key] = { ...(progress.units[key] ?? {}), status, ...extra, updatedAt: new Date().toISOString() };
  };
  const recordAttempt = (key, entry) => {
    progress.attempts.push({ key, ...entry });
  };
  await writeProgress();

  let preview = null;
  let warningPreview = null;
  let browser = null;
  let operationFailed = false;
  let operationError;
  let result;
  try {
    preview = await startCandidatePreview({ candidate: candidateSnapshot, fixture, port });
    if (timelineWarningFixture !== null) {
      warningPreview = await startCandidatePreview({
        candidate: candidateSnapshot,
        fixture: timelineWarningFixture,
        port: 0,
      });
    }
    browser = await runtime.chromium.launch({
      executablePath: runtime.executablePath,
      headless: true,
    });

    const modeResults = {};
    for (const mode of modes) {
      modeResults[mode] = await captureStateMatrixMode({
        mode,
        units,
        expectedPairs: expectedPairs[mode],
        otherModePairs: expectedPairs[mode === "light" ? "dark" : "light"],
        candidate: candidateSnapshot,
        skinId,
        browser,
        previewUrl: preview.url,
        warningPreviewUrl: warningPreview?.url ?? null,
        outDir: resolvedOutDir,
        measureBaseline,
        stateTimeoutMs,
        baselineTimeoutMs,
        progress,
        resumedCapturedUnits,
        writeProgress,
        markUnit,
        recordAttempt,
        fixtureHash: digests.fixtureHash,
        fixtureBindings,
      });
    }

    await writeProgress();
    const meta = {
      schemaVersion: 1,
      kind: CAPTURE_MATRIX_KIND,
      tool: "scripts/skin-palette/capture.mjs",
      createdAt: new Date().toISOString(),
      candidate: productionMode
        ? { production: true, skinId }
        : {
            id: candidateSnapshot.id,
            candidateHash: candidateSnapshot.candidateHash,
            skinId: candidateSnapshot.skinId,
            variant: candidateSnapshot.variant,
            profileHash: candidateSnapshot.profileHash,
            policyHash: candidateSnapshot.policyHash,
            derivationHash: candidateSnapshot.derivationHash,
          },
      fixtureHash: digests.fixtureHash,
      ...(fixtureBindings ? { fixtureBindings } : {}),
      policyHash: digests.policyHash,
      sourceHashes,
      environment: {
        node: process.version,
        browser: await browser.version(),
        viewports: [{ ...BASE_VIEWPORT }, ...DESKTOP_VIEWPORTS.map((viewport) => ({ ...viewport }))],
        deviceScaleFactor: 1,
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
        reducedMotion: "reduce",
        baselineStateId: BASELINE_STATE_ID,
      },
      stateTimeoutMs,
      baselineTimeoutMs,
      retryPolicy: MATRIX_RETRY_POLICY,
      measureBaseline,
      groups: groupIds,
      coverage: Object.fromEntries(describeMatrixCoverage(groupIds)),
      untested: [...MATRIX_UNTESTED],
      modes: modeResults,
    };
    await writeJson(path.join(resolvedOutDir, "capture.json"), meta);
    result = { outDir: resolvedOutDir, skinId, modes: modeResults, capture: meta, progress };
  } catch (error) {
    operationFailed = true;
    operationError = error;
  } finally {
    // fixture 生命周期归调用方；本函数关闭 Browser 与两 preview，保留主错和清理错。
    await closeCaptureMatrixResources({ browser, warningPreview, preview, operationFailed, operationError });
  }
  return result;
}

function extractUsageTotalTokens(data) {
  const total = Number(data?.summary?.totals?.total);
  if (!Number.isFinite(total)) throw new TypeError("online freeze 回归：/api/usage 缺少有限 summary.totals.total");
  return total;
}

async function resolveFixtureUsageLogPath(fixture) {
  if (typeof fixture?.homeDir !== "string" || typeof fixture?.importStoreFile !== "string") {
    throw new TypeError("online freeze 回归：fixture 必须提供 homeDir 与 importStoreFile");
  }
  const fixtureRoot = path.resolve(path.dirname(fixture.homeDir));
  const importStorePath = path.resolve(fixture.importStoreFile);
  const storeRelative = path.relative(fixtureRoot, importStorePath);
  if (storeRelative === ".." || storeRelative.startsWith(`..${path.sep}`) || path.isAbsolute(storeRelative)) {
    throw new TypeError("online freeze 回归：importStoreFile 必须位于隔离 fixture 根目录内");
  }
  const store = JSON.parse(await readFile(importStorePath, "utf8"));
  const imported = Array.isArray(store?.imports)
    ? store.imports.find((entry) => typeof entry?.path === "string")
    : null;
  if (!imported) throw new TypeError("online freeze 回归：fixture 没有可写入的导入目录");
  const projectDir = path.resolve(imported.path);
  const projectRelative = path.relative(fixtureRoot, projectDir);
  if (
    !projectRelative ||
    projectRelative === ".." ||
    projectRelative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(projectRelative)
  ) {
    throw new TypeError("online freeze 回归：导入目录必须是隔离 fixture 根目录的子目录");
  }
  return path.join(projectDir, ".codex-usage", "usage.jsonl");
}

function buildOnlineFreezeEvent(template, label, tokens) {
  const now = new Date().toISOString();
  return {
    ...template,
    timestamp: now,
    session_id: `m4-online-freeze-${label}-${Date.now()}`,
    request_id: `m4-online-freeze-${label}-${Date.now()}`,
    usage: { total: tokens, input: tokens, cached: 0, output: 0 },
  };
}

function recordRegressionAssertion(result, label, expected, actual) {
  const ok = Object.is(actual, expected);
  result.assertions.push({ label, expected, actual, ok });
  if (!ok) result.blockers.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  return ok;
}

function waitForBrowserUsageResponse(page, predicate, timeout) {
  return page.waitForResponse(
    (response) => {
      try {
        const url = new URL(response.url());
        return url.pathname === "/api/usage" && predicate(url);
      } catch {
        return false;
      }
    },
    { timeout },
  );
}

async function readUsageResponse(response) {
  const data = await response.json().catch(() => null);
  if (!response.ok() || !data) throw new Error(`/api/usage 返回 ${response.status()}，无法读取回归数据`);
  return data;
}

/**
 * 在线冻结专用回归入口（M4.3 / M6.2.4）：真实追加 usage.jsonl 记录，观察 live 自动刷新，
 * 暂停后切换周期核对同一服务端 snapshot，再恢复刷新观察新增量。每次只运行一个模式，
 * 使用调用方提供的隔离 fixture，结束时恢复其日志原文；该流程不属于候选初筛矩阵。
 */
export async function captureOnlineFreezeRegression({
  candidate = null,
  skinId: skinIdOption = "chatgpt",
  fixture,
  mode = "light",
  outDir,
  rootDir = REPO_ROOT,
  browserRuntime = null,
  stateTimeoutMs = 15000,
  pollIntervalMs = 500,
  port = 0,
} = {}) {
  const label = "captureOnlineFreezeRegression";
  if (!MODES.includes(mode)) throw new TypeError(`${label}: mode 必须是 light 或 dark`);
  for (const [name, value] of [
    ["stateTimeoutMs", stateTimeoutMs],
    ["pollIntervalMs", pollIntervalMs],
  ]) {
    if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${label}: ${name} 必须是正整数毫秒`);
  }
  if (pollIntervalMs >= 60_000) throw new TypeError(`${label}: pollIntervalMs 必须小于 60000ms`);
  const resolvedOutDir = await assertCaptureOutputDir(outDir, rootDir);
  await mkdir(resolvedOutDir, { recursive: true });

  const { productionMode, skinId, candidateSnapshot } = snapshotCaptureCandidate({
    candidate,
    skinId: skinIdOption,
    label,
  });
  const expectedPairs = deriveExpectedPairs({ productionMode, skinId, candidateSnapshot, modes: [mode], label });
  const runtime = browserRuntime ?? (await resolveBrowserRuntime());
  if (!runtime) throw new Error("ENVIRONMENT_BLOCKED: 未找到可用的 Playwright/Edge 运行时，不伪造在线冻结回归");

  const result = {
    schemaVersion: 1,
    kind: "skin-palette-online-freeze-regression",
    status: "incomplete",
    createdAt: new Date().toISOString(),
    candidate: productionMode
      ? { production: true, skinId }
      : { id: candidateSnapshot.id, skinId: candidateSnapshot.skinId },
    mode,
    fixtureHash: typeof fixture?.fixtureHash === "string" ? fixture.fixtureHash : null,
    polling: { productIntervalMs: 60_000, acceleratedIntervalMs: pollIntervalMs },
    assertions: [],
    blockers: [],
    events: [],
    phases: {},
    screenshots: {},
  };
  let preview = null;
  let browser = null;
  let ctx = null;
  let logPath = null;
  let originalLog = null;

  const recordUsageScreenshot = async (field) => {
    const buffer = await ctx.page.screenshot({ fullPage: false });
    const name = `${field}.png`;
    result.screenshots[field] = await saveScreenshotBuffer(path.join(resolvedOutDir, name), buffer);
  };
  const assertResponse = (response, phase) => {
    if (!response?.ok()) throw new Error(`${phase} 的 /api/usage 请求返回 ${response?.status() ?? "无响应"}`);
  };

  try {
    logPath = await resolveFixtureUsageLogPath(fixture);
    originalLog = await readFile(logPath, "utf8");
    const templateLine = originalLog.split(/\r?\n/).find((line) => line.trim().length > 0);
    if (!templateLine) throw new Error("online freeze 回归：fixture usage.jsonl 为空");
    const template = JSON.parse(templateLine);

    preview = await startCandidatePreview({ candidate: candidateSnapshot, fixture, port });
    browser = await runtime.chromium.launch({ executablePath: runtime.executablePath, headless: true });
    ctx = await createModeContext({ browser, previewUrl: preview.url, mode, skinId, autoRefresh: "on" });
    await ctx.page.addInitScript((intervalMs) => {
      const nativeSetInterval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) =>
        nativeSetInterval(callback, delay === 60_000 ? intervalMs : delay, ...args);
    }, pollIntervalMs);

    const baseline = await runBaselineCapture({
      ctx,
      mode,
      skinId,
      candidate: candidateSnapshot,
      expectedPairs: expectedPairs[mode],
      outModeDir: resolvedOutDir,
      stateTimeoutMs,
      policy: POLICY,
      measureRoles: false,
      captureEvidence: false,
    });
    recordRegressionAssertion(result, "live 初始基准已就绪", "captured", baseline.status);

    const readAllLive = async () => {
      const url = new URL("/api/usage", preview.url);
      url.searchParams.set("preset", "all");
      url.searchParams.set("bucket", "day");
      url.searchParams.set("calendarZone", "local");
      url.searchParams.set("view", "dashboard");
      const response = await ctx.page.request.get(url.toString(), { timeout: stateTimeoutMs });
      if (!response.ok()) throw new Error(`初始 /api/usage 返回 ${response.status()}`);
      return response.json();
    };
    const initial = await readAllLive();
    const initialTotal = extractUsageTotalTokens(initial);
    const initialMetricText = (await ctx.page.locator("#totalTokens").getAttribute("title"))?.trim() ?? "";
    const initialVisibleMetricText = (await ctx.page.locator("#totalTokens").textContent())?.trim() ?? "";
    result.phases.initialLive = { totalTokens: initialTotal, fingerprint: initial.fingerprint ?? null };
    recordRegressionAssertion(
      result,
      "初始页面与 live API 数值一致",
      initialTotal,
      parseMetricNumber(initialMetricText),
    );

    const firstLiveResponse = waitForBrowserUsageResponse(
      ctx.page,
      (url) => url.searchParams.get("preset") === "all" && !url.searchParams.has("snapshot"),
      stateTimeoutMs,
    );
    const firstEvent = buildOnlineFreezeEvent(template, "live", 100_000);
    await appendFile(logPath, `${JSON.stringify(firstEvent)}\n`, "utf8");
    result.events.push({ requestId: firstEvent.request_id, sessionId: firstEvent.session_id, totalTokens: 100_000 });
    const firstLive = await firstLiveResponse;
    assertResponse(firstLive, "新增记录后的 live 更新");
    const firstLiveData = await readUsageResponse(firstLive);
    const firstLiveTotal = extractUsageTotalTokens(firstLiveData);
    result.phases.liveUpdated = {
      totalTokens: firstLiveTotal,
      fingerprint: firstLiveData.fingerprint ?? null,
      snapshotId: firstLiveData.snapshotId ?? null,
      expectedAddedTokens: 100_000,
    };
    recordRegressionAssertion(result, "新增记录触发 live 数值更新", initialTotal + 100_000, firstLiveTotal);
    recordRegressionAssertion(result, "live 更新不使用冻结快照", null, firstLiveData.snapshotId ?? null);
    await ctx.page.waitForFunction(
      (previous) => document.querySelector("#totalTokens")?.getAttribute("title") !== previous,
      initialMetricText,
      { timeout: stateTimeoutMs },
    );
    const liveMetricText = (await ctx.page.locator("#totalTokens").getAttribute("title"))?.trim() ?? "";
    const liveVisibleMetricText = (await ctx.page.locator("#totalTokens").textContent())?.trim() ?? "";
    recordRegressionAssertion(result, "live 更新已反映到页面指标", firstLiveTotal, parseMetricNumber(liveMetricText));
    recordRegressionAssertion(
      result,
      "live 新增量改变可见总量指标",
      false,
      liveVisibleMetricText === initialVisibleMetricText,
    );
    await recordUsageScreenshot("live-updated");

    const freezeResponse = waitForBrowserUsageResponse(
      ctx.page,
      (url) => url.searchParams.get("preset") === "all" && url.searchParams.get("freeze") === "1",
      stateTimeoutMs,
    );
    await ctx.page.click("#autoRefreshToggle", { timeout: stateTimeoutMs });
    const frozenResponse = await freezeResponse;
    assertResponse(frozenResponse, "暂停自动刷新并冻结 snapshot");
    const frozenData = await readUsageResponse(frozenResponse);
    const frozenTotal = extractUsageTotalTokens(frozenData);
    const snapshotId = frozenData.snapshotId ?? null;
    result.phases.paused = {
      totalTokens: frozenTotal,
      fingerprint: frozenData.fingerprint ?? null,
      snapshotId,
      preset: "all",
    };
    recordRegressionAssertion(
      result,
      "暂停时创建服务端 snapshot",
      true,
      typeof snapshotId === "string" && snapshotId.length > 0,
    );
    recordRegressionAssertion(result, "冻结快照保留 live 新增量", firstLiveTotal, frozenTotal);

    const secondEvent = buildOnlineFreezeEvent(template, "resume", 200_000);
    await appendFile(logPath, `${JSON.stringify(secondEvent)}\n`, "utf8");
    result.events.push({ requestId: secondEvent.request_id, sessionId: secondEvent.session_id, totalTokens: 200_000 });

    const weekResponse = waitForBrowserUsageResponse(
      ctx.page,
      (url) => url.searchParams.get("preset") === "week" && url.searchParams.get("snapshot") === snapshotId,
      stateTimeoutMs,
    );
    await ctx.page.click('#presetButtons button[data-preset="week"]', { timeout: stateTimeoutMs });
    const week = await weekResponse;
    assertResponse(week, "暂停期间切换到本周");
    const weekData = await readUsageResponse(week);
    result.phases.pausedWeek = {
      totalTokens: extractUsageTotalTokens(weekData),
      fingerprint: weekData.fingerprint ?? null,
      snapshotId: weekData.snapshotId ?? null,
      asOf: weekData.summary?.range?.asOf ?? null,
    };
    recordRegressionAssertion(result, "暂停切周期继续使用同一 snapshot", snapshotId, weekData.snapshotId ?? null);
    recordRegressionAssertion(
      result,
      "暂停切周期保持同一 fingerprint",
      frozenData.fingerprint ?? null,
      weekData.fingerprint ?? null,
    );
    await recordUsageScreenshot("paused-week");

    const allPausedResponse = waitForBrowserUsageResponse(
      ctx.page,
      (url) => url.searchParams.get("preset") === "all" && url.searchParams.get("snapshot") === snapshotId,
      stateTimeoutMs,
    );
    await ctx.page.click('#presetButtons button[data-preset="all"]', { timeout: stateTimeoutMs });
    const allPaused = await allPausedResponse;
    assertResponse(allPaused, "暂停期间切回全部范围");
    const allPausedData = await readUsageResponse(allPaused);
    const allPausedTotal = extractUsageTotalTokens(allPausedData);
    result.phases.pausedAll = {
      totalTokens: allPausedTotal,
      fingerprint: allPausedData.fingerprint ?? null,
      snapshotId: allPausedData.snapshotId ?? null,
      asOf: allPausedData.summary?.range?.asOf ?? null,
    };
    recordRegressionAssertion(result, "切回全部仍使用同一 snapshot", snapshotId, allPausedData.snapshotId ?? null);
    recordRegressionAssertion(result, "暂停期间新增记录未进入冻结数据", frozenTotal, allPausedTotal);

    const resumedResponse = waitForBrowserUsageResponse(
      ctx.page,
      (url) =>
        url.searchParams.get("preset") === "all" &&
        !url.searchParams.has("snapshot") &&
        !url.searchParams.has("freeze"),
      stateTimeoutMs,
    );
    await ctx.page.click("#autoRefreshToggle", { timeout: stateTimeoutMs });
    const resumed = await resumedResponse;
    assertResponse(resumed, "恢复自动刷新");
    const resumedData = await readUsageResponse(resumed);
    const resumedTotal = extractUsageTotalTokens(resumedData);
    result.phases.resumed = {
      totalTokens: resumedTotal,
      fingerprint: resumedData.fingerprint ?? null,
      snapshotId: resumedData.snapshotId ?? null,
      expectedAddedTokens: 200_000,
    };
    recordRegressionAssertion(result, "恢复刷新释放冻结 snapshot", null, resumedData.snapshotId ?? null);
    recordRegressionAssertion(result, "恢复刷新取得暂停期间新增量", frozenTotal + 200_000, resumedTotal);
    recordRegressionAssertion(
      result,
      "恢复刷新看到新 fingerprint",
      false,
      resumedData.fingerprint === frozenData.fingerprint,
    );
    await ctx.page.waitForFunction(
      (previous) => document.querySelector("#totalTokens")?.getAttribute("title") !== previous,
      liveMetricText,
      { timeout: stateTimeoutMs },
    );
    const resumedMetricText = (await ctx.page.locator("#totalTokens").getAttribute("title"))?.trim() ?? "";
    recordRegressionAssertion(result, "恢复刷新已反映到页面指标", resumedTotal, parseMetricNumber(resumedMetricText));
    await recordUsageScreenshot("resumed-live");

    const browserErrors = buildStateBlockers(ctx.errors);
    if (browserErrors.length > 0) result.blockers.push(...browserErrors.map((entry) => `浏览器运行错误：${entry}`));
  } catch (error) {
    result.blockers.push(error instanceof Error ? error.message : String(error));
  } finally {
    if (logPath && originalLog !== null) {
      try {
        await writeFile(logPath, originalLog, "utf8");
        if (preview && ctx) {
          const restoreUrl = new URL("/api/usage", preview.url);
          restoreUrl.searchParams.set("preset", "all");
          restoreUrl.searchParams.set("bucket", "day");
          restoreUrl.searchParams.set("calendarZone", "local");
          restoreUrl.searchParams.set("view", "dashboard");
          const restored = await ctx.page.request.get(restoreUrl.toString(), { timeout: stateTimeoutMs });
          if (!restored.ok()) result.blockers.push(`隔离 fixture 原始日志复同步失败（API ${restored.status()}）`);
        }
      } catch (error) {
        result.blockers.push(
          `恢复隔离 fixture 原始日志失败：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (ctx) await ctx.close().catch((error) => result.blockers.push(`关闭在线冻结上下文失败：${String(error)}`));
    if (browser)
      await browser.close().catch((error) => result.blockers.push(`关闭在线冻结浏览器失败：${String(error)}`));
    if (preview)
      await preview.close().catch((error) => result.blockers.push(`关闭在线冻结预览服务失败：${String(error)}`));
  }

  const sourceHashes = collectSourceHashes(SOURCE_FILES, (relativePath) =>
    readFileSync(path.join(REPO_ROOT, relativePath)),
  );
  result.sourceHashes = sourceHashes;
  result.status =
    result.blockers.length === 0 && result.assertions.every((assertion) => assertion.ok) ? "passed" : "failed";
  result.completedAt = new Date().toISOString();
  await writeJson(path.join(resolvedOutDir, "online-freeze.json"), result);
  if (result.status !== "passed") {
    const error = new Error(`${label}: online freeze 回归失败（${result.blockers.join("；") || "断言未通过"}）`);
    error.result = result;
    throw error;
  }
  return { outDir: resolvedOutDir, result };
}

export default {
  captureBaseline,
  captureOnlineFreezeRegression,
  captureStateMatrix,
  assertCaptureOutputDir,
  buildResourceBlockers,
  buildStateBlockers,
  buildPreferenceSeedSource,
  buildStateReadyWaitSource,
  settleStateEvidenceViewport,
  buildCharactersReadySource,
  describeMatrixCoverage,
  diffPaletteDeclarations,
  parseMetricNumber,
  planMonthNavigation,
  planResume,
  resolveBrowserRuntime,
  resumeDigestsMatch,
  SOURCE_FILES,
  STATE_MATRIX_GROUPS,
  MATRIX_UNTESTED,
};
