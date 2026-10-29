import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selectQuotaWindows, summarizeUsage } from "../src/usage-core.js";

// =====================================================================================
// U4 —— 自动刷新 60 秒周期：运行时周期夹具
//
// 本文件既是**仓库测试**（`node --test test/app-autorefresh.test.js`，交审检查点名），也是
// `U4/measure-u4.mjs`、`U4/mutation-u4.mjs`、`U4/verify-u4.mjs` 复用的**唯一夹具源**：
// 脚本以 `U4_HARNESS_ONLY=1` 导入本文件 ⇒ 只取导出、不注册测试（避免把测试跑两遍）。
//
// ⚠️ 夹具为什么必须"跑真的 app.js"：
//   交审要求"至少一次真实 60 秒周期验证接线"、并要 source-check / 时钟重算 / 实际同步
//   四类计数。改前 `test/app-autorefresh.test.js` 只在**源码文本**上做正则断言，无法回答
//   "这一周期到底发了几次请求、skipCheck 有没有被用掉"。因此本卡引入运行时夹具：
//   `public/app.js` 是 ES 模块（`import { state } from "./app-state.js"`），Node 无法直接
//   把它当脚本求值，故夹具把它的 **import/export 行**改写成"从 __deps 解构"，其余字节一律
//   不动（见 `loadAppSource` 的 `applied` 替换清单与断言），再在 `node:vm` 里求值。
//   ⇒ 测的仍是**交付字节**，`state` 仍是 `public/app-state.js` 里那**同一个对象**。
//
// 时钟口径：app.js 只在 4 处读"现在"（`state.now` 优先，否则 `new Date()`）——
//   `:756` 最近范围、`:1094` 对比趋势、`:2951` 限额不可用时的 as-of、`:3612` 模型用量 as-of。
//   `state.now` 是**产品自带的注入点**（app.js 从不写它），夹具用它把周期变成确定性的。
// =====================================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const APP_PATH = path.join(REPO_ROOT, "public", "app.js");
const INDEX_PATH = path.join(REPO_ROOT, "public", "index.html");
const RESPONSES_DIR = path.join(
  REPO_ROOT,
  "docs/validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/baseline/reports/responses/original/pristine",
);

/** `U4_HARNESS_ONLY=1` ⇒ 只导出夹具、不注册 test()（供 U4 脚本复用）。 */
export const HARNESS_ONLY = process.env.U4_HARNESS_ONLY === "1";
/** `U4_REAL_CYCLE=1` ⇒ 额外跑一次**真实 60 秒**周期（默认关，避免拖慢交审门禁）。 */
export const REAL_CYCLE = process.env.U4_REAL_CYCLE === "1";
/** `U4_APP_SOURCE=<path>` ⇒ 用**别的** app.js 字节跑同一套判据（变异测试用）。 */
export const APP_UNDER_TEST = process.env.U4_APP_SOURCE ? path.resolve(process.env.U4_APP_SOURCE) : APP_PATH;
/** 自动刷新周期（来自 app.js 的 `AUTO_REFRESH_INTERVAL_MS`，夹具会逐值核对）。 */
export const EXPECTED_INTERVAL_MS = 60_000;

// =====================================================================================
// §B1 假 DOM：元素契约由**真实** `public/index.html` 派生（哪些 id 存在、哪些 hidden）
// =====================================================================================

const CANVAS_METHODS = [
  "save",
  "restore",
  "beginPath",
  "closePath",
  "moveTo",
  "lineTo",
  "arc",
  "arcTo",
  "rect",
  "roundRect",
  "ellipse",
  "fill",
  "stroke",
  "clip",
  "fillRect",
  "strokeRect",
  "clearRect",
  "fillText",
  "strokeText",
  "translate",
  "rotate",
  "scale",
  "transform",
  "setTransform",
  "resetTransform",
  "setLineDash",
  "getLineDash",
  "drawImage",
  "putImageData",
  "createPattern",
  "isPointInPath",
];

function createClassList() {
  const set = new Set();
  return {
    add: (...names) => {
      for (const name of names) set.add(name);
    },
    remove: (...names) => {
      for (const name of names) set.delete(name);
    },
    toggle: (name, force) => {
      const want = force === undefined ? !set.has(name) : Boolean(force);
      if (want) set.add(name);
      else set.delete(name);
      return want;
    },
    contains: (name) => set.has(name),
    replace: (from, to) => {
      if (!set.delete(from)) return false;
      set.add(to);
      return true;
    },
    get length() {
      return set.size;
    },
    item: (index) => [...set][index] ?? null,
    toString: () => [...set].join(" "),
    [Symbol.iterator]: () => set[Symbol.iterator](),
  };
}

function createStyle() {
  const target = {};
  const methods = {
    setProperty: (name, value) => {
      target[name] = String(value);
    },
    removeProperty: (name) => {
      const previous = name in target ? target[name] : "";
      delete target[name];
      return previous;
    },
    getPropertyValue: (name) => (name in target ? target[name] : ""),
    getPropertyPriority: () => "",
    item: (index) => Object.keys(target)[index] ?? "",
  };
  return new Proxy(target, {
    get: (inner, key) => {
      if (key in methods) return methods[key];
      if (key in inner) return inner[key];
      if (typeof key === "symbol") return undefined;
      return "";
    },
    set: (inner, key, value) => {
      inner[key] = value;
      return true;
    },
    has: (inner, key) => key in inner || key in methods,
  });
}

function createDataset(seed = {}) {
  return new Proxy(
    { ...seed },
    {
      get: (target, key) => (key in target ? target[key] : undefined),
      set: (target, key, value) => {
        target[key] = String(value);
        return true;
      },
      has: (target, key) => key in target,
    },
  );
}

function createCanvasContext(canvas) {
  const state = { canvas };
  return new Proxy(state, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (typeof key === "symbol") return undefined;
      if (key === "measureText")
        return (text) => ({ width: String(text ?? "").length * 6, actualBoundingBoxAscent: 8 });
      if (key === "createLinearGradient" || key === "createRadialGradient" || key === "createConicGradient") {
        return () => ({ addColorStop() {} });
      }
      if (key === "getImageData")
        return (...args) => {
          const width = args[2] ?? 0;
          const height = args[3] ?? 0;
          return { data: new Uint8ClampedArray(Math.max(4, width * height * 4)), width, height };
        };
      if (key === "createImageData")
        return (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, w * h * 4)), width: w, height: h });
      if (CANVAS_METHODS.includes(key)) return () => {};
      return target[key];
    },
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  });
}

/**
 * 造一个 DOM 元素替身。契约（`dataset`/`classList`/属性表/事件表）都真在，未实现的浏览器
 * 行为退化为 no-op —— 夹具只用于**周期计数**，不做视觉断言。
 */
function createElement(tag = "div", { id = "", dataset = {}, hidden = false, ownerDocument = null } = {}) {
  const listeners = new Map();
  const attributes = new Map();
  const children = [];
  const base = {
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    nodeType: 1,
    id,
    className: "",
    dataset: createDataset(dataset),
    classList: createClassList(),
    style: createStyle(),
    textContent: "",
    innerHTML: "",
    outerHTML: "",
    value: "",
    checked: false,
    disabled: false,
    hidden,
    title: "",
    width: 0,
    height: 0,
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    clientWidth: 800,
    clientHeight: 400,
    clientTop: 0,
    clientLeft: 0,
    offsetWidth: 800,
    offsetHeight: 400,
    offsetTop: 0,
    offsetLeft: 0,
    children,
    childNodes: children,
    parentNode: null,
    parentElement: null,
    firstChild: null,
    lastChild: null,
    nextSibling: null,
    previousSibling: null,
    isConnected: true,
    ownerDocument,
    selectionStart: 0,
    selectionEnd: 0,
    files: [],
    accept: "",
    ariaHidden: null,
    offsetParent: null,
    __listeners: listeners,
    __attributes: attributes,
    addEventListener: (type, handler) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener: (type, handler) => {
      const list = listeners.get(type);
      if (!list) return;
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent: (event) => {
      const target = event?.target ?? base;
      for (const handler of listeners.get(event?.type) ?? []) handler({ ...event, target, currentTarget: base });
      return true;
    },
    setAttribute: (name, value) => {
      attributes.set(name, String(value));
      if (name === "hidden") base.hidden = true;
      if (name === "id") base.id = String(value);
      if (name === "title") base.title = String(value);
      if (name === "disabled") base.disabled = true;
      if (name === "value") base.value = String(value);
    },
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    removeAttribute: (name) => attributes.delete(name),
    hasAttribute: (name) => attributes.has(name),
    toggleAttribute: (name, force) => {
      const want = force === undefined ? !attributes.has(name) : Boolean(force);
      if (want) attributes.set(name, "");
      else attributes.delete(name);
      return want;
    },
    appendChild: (child) => {
      children.push(child);
      return child;
    },
    append: (...nodes) => children.push(...nodes),
    prepend: (...nodes) => children.unshift(...nodes),
    removeChild: (child) => {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      return child;
    },
    replaceChildren: (...nodes) => {
      children.length = 0;
      children.push(...nodes);
    },
    insertBefore: (child) => {
      children.unshift(child);
      return child;
    },
    insertAdjacentElement: () => null,
    insertAdjacentHTML: (position, html) => {
      base.innerHTML =
        position === "afterbegin" || position === "beforeend" ? `${base.innerHTML}${html}` : `${html}${base.innerHTML}`;
    },
    insertAdjacentText: () => {},
    remove: () => {
      base.parentNode?.removeChild?.(base);
    },
    querySelector: (selector) => (selector === "[data-quota-mode]" ? null : null),
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    closest: (selector) => {
      if (selector === "[data-preset]" && typeof base.dataset?.preset === "string") return base;
      if (selector === "[data-quota-mode]" && typeof base.dataset?.quotaMode === "string") return base;
      if (selector.startsWith("#") && base.id === selector.slice(1)) return base;
      return null;
    },
    matches: (selector) => base.closest(selector) === base,
    contains: (node) => node === base || children.includes(node),
    focus: () => {},
    blur: () => {},
    click: () => base.dispatchEvent({ type: "click", target: base }),
    scrollIntoView: () => {},
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: base.clientWidth,
      bottom: base.clientHeight,
      width: base.clientWidth,
      height: base.clientHeight,
      toJSON: () => ({}),
    }),
    getClientRects: () => [],
    cloneNode: () => createElement(tag, { id, dataset, hidden, ownerDocument }),
    after: () => {},
    before: () => {},
    replaceWith: () => {},
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    hasPointerCapture: () => false,
    attachShadow: () => createElement("shadow-root", { ownerDocument }),
    animate: () => ({ finished: Promise.resolve(), cancel() {}, addEventListener() {}, removeEventListener() {} }),
    getAnimations: () => [],
    getContext: (type) => (type === "2d" ? createCanvasContext(base) : null),
    toDataURL: () => "data:image/png;base64,",
    normalize: () => {},
    setSelectionRange: () => {},
    select: () => {},
    checkValidity: () => true,
    reportValidity: () => true,
    setCustomValidity: () => {},
    requestFullscreen: async () => {},
    scrollTo: () => {},
    showModal: () => {
      base.hidden = false;
    },
    close: () => {},
    reset: () => {},
    submit: () => {},
  };
  return base;
}

/**
 * 由 `public/index.html` 派生 DOM 契约：每个 `id` 一个元素（带 `hidden` 属性者为隐藏），
 * 外加属性选择器（`[data-preset]` 等）对应的元素列表。⇒ 夹具的"存在性"与真实页面一致，
 * 不存在的 id 必须返回 null（否则会把真实页面里走不到的兜底分支当成正常路径）。
 */
export function parseDomContract(html) {
  const ids = new Map();
  for (const match of html.matchAll(/<([a-zA-Z][\w-]*)([^>]*?)\bid="([^"]+)"([^>]*)>/g)) {
    const [, tag, before, id, after] = match;
    const attrs = `${before}${after}`;
    ids.set(id, { tag, hidden: /(^|\s)hidden(\s|=|>|$)/.test(attrs) });
  }
  const attributeValues = (name) => [...html.matchAll(new RegExp(`data-${name}="([^"]+)"`, "g"))].map((m) => m[1]);
  return {
    ids,
    dataPreset: [...new Set(attributeValues("preset"))],
    dataQuotaMode: [...new Set(attributeValues("quota-mode"))],
    dataRecentOption: [...new Set(attributeValues("recent-option"))],
    dataTimelineMode: [...new Set(attributeValues("timeline-mode"))],
    dataCalendarZone: [...new Set(attributeValues("calendar-zone"))],
    dataPricingScope: [...new Set(attributeValues("pricing-scope"))],
  };
}

export function createDomStub(html, contract) {
  const byId = new Map();
  const all = [];
  const makeElement = (tag, options) => {
    const element = createElement(tag, { ...options, ownerDocument: document });
    all.push(element);
    return element;
  };
  const document = {
    hidden: false,
    visibilityState: "visible",
    readyState: "complete",
    cookie: "",
    title: "Agent Usage",
    __byId: byId,
    __all: all,
    __listeners: new Map(),
  };
  for (const [id, meta] of contract.ids) {
    const element = makeElement(meta.tag, { id, hidden: meta.hidden });
    (id === "timelineChart" ? [] : []).forEach(() => {});
    byId.set(id, element);
  }
  document.body = makeElement("body", {});
  document.documentElement = makeElement("html", {});
  document.head = makeElement("head", {});
  document.activeElement = document.body;

  // ---- 迷你选择器求值：只支持 app.js 真正用到的形态（`#id`、`.class`、`[attr]`、
  //      `[attr="value"]`、`[attr='value']`、`#id [attr=value]`、`main.shell`）。
  //      "命中与否"由**真实 index.html** 决定：真实页面里不存在的 id/属性 ⇒ null，
  //      这样真实页面走不到的兜底分支不会被夹具误当正常路径。结构组合子直接报错，避免静默失真。
  const queryCache = new Map();
  const parseAttributeToken = (token) => {
    const match = token.slice(1, -1).match(/^([\w-]+)(?:\s*([~^$*|]?=)\s*["']?([^"']*)["']?)?$/);
    if (!match) return null;
    const [, attribute, operator, value] = match;
    const name = attribute.replace(/^data-/, "").replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    return { attribute, operator: operator ?? null, value: value ?? null, name };
  };
  const elementForAttributeToken = (token) => {
    const parsed = parseAttributeToken(token);
    if (!parsed) return null;
    if (!html.includes(parsed.attribute)) return null;
    if (parsed.value !== null && parsed.value !== "" && !html.includes(parsed.value)) return null;
    return makeElement("div", { dataset: parsed.value === null ? {} : { [parsed.name]: parsed.value } });
  };
  const tokenMatches = (token) => {
    if (token.startsWith("#")) return byId.has(token.slice(1));
    if (token.startsWith(".")) {
      const className = token.slice(1);
      return new RegExp(`class="[^"]*\\b${className}\\b`).test(html);
    }
    if (token.startsWith("[")) return elementForAttributeToken(token) !== null;
    // 标签名或 `main.shell` 这类标签+类：真实页面必然存在同名标签
    const [tag] = token.split(".");
    return html.includes(`<${tag}`);
  };
  const resolveSelector = (selector, { all }) => {
    if (typeof selector !== "string") return all ? [] : null;
    const trimmed = selector.trim();
    if (/[>+~]/.test(trimmed)) throw new Error(`U4 夹具未实现结构组合子：${selector}`);
    const tokens = trimmed.split(/\s+/);
    const last = tokens.at(-1);
    if (tokens.some((token) => !tokenMatches(token))) return all ? [] : null;
    if (last.startsWith("#")) {
      const element = byId.get(last.slice(1)) ?? null;
      return all ? (element ? [element] : []) : element;
    }
    if (last.startsWith("[")) {
      const list = listFor(last);
      return all ? list : (list[0] ?? null);
    }
    if (last.startsWith(".")) {
      const element = makeElement("div", {});
      return all ? [element] : element;
    }
    const element = makeElement(last.split(".")[0], {});
    return all ? [element] : element;
  };

  const listFor = (selector) => {
    if (selector === "[data-preset]") {
      return contract.dataPreset.map((preset) => makeElement("button", { dataset: { preset } }));
    }
    if (selector === "[data-quota-mode]") {
      return contract.dataQuotaMode.map((mode) => makeElement("span", { dataset: { quotaMode: mode } }));
    }
    if (selector === "[data-recent-option]") {
      return contract.dataRecentOption.map((value) => makeElement("button", { dataset: { recentOption: value } }));
    }
    if (selector === "[data-timeline-mode]") {
      return contract.dataTimelineMode.map((mode) => makeElement("button", { dataset: { timelineMode: mode } }));
    }
    if (selector === "[data-calendar-zone]") {
      return contract.dataCalendarZone.map((zone) => makeElement("button", { dataset: { calendarZone: zone } }));
    }
    if (selector === "[data-pricing-scope]") {
      return contract.dataPricingScope.map((scope) => makeElement("button", { dataset: { pricingScope: scope } }));
    }
    if (selector.startsWith("#")) return byId.has(selector.slice(1)) ? [byId.get(selector.slice(1))] : [];
    if (selector.startsWith("[")) {
      const element = elementForAttributeToken(selector);
      return element ? [element] : [];
    }
    if (selector.startsWith(".")) return [makeElement("div", {})];
    return [];
  };

  const querySelector = (selector) => {
    const key = String(selector);
    if (!queryCache.has(key)) queryCache.set(key, resolveSelector(key, { all: false }));
    return queryCache.get(key);
  };
  document.querySelector = querySelector;
  document.querySelectorAll = (selector) => {
    const trimmed = String(selector).trim();
    if (trimmed.includes(",")) return trimmed.split(",").flatMap((part) => resolveSelector(part.trim(), { all: true }));
    if (/\s/.test(trimmed)) return resolveSelector(trimmed, { all: true });
    return listFor(trimmed);
  };
  document.getElementById = (id) => byId.get(id) ?? null;
  document.createElement = (tag) => makeElement(tag, {});
  document.createDocumentFragment = () => makeElement("fragment", {});
  document.createTextNode = (text) => ({ nodeType: 3, textContent: text });
  document.addEventListener = (type, handler) => {
    if (!document.__listeners.has(type)) document.__listeners.set(type, []);
    document.__listeners.get(type).push(handler);
  };
  document.removeEventListener = () => {};
  document.dispatchEvent = (event) => {
    for (const handler of document.__listeners.get(event?.type) ?? []) handler({ ...event, target: document });
    return true;
  };
  document.execCommand = () => true;
  document.createRange = () => ({ selectNodeContents() {}, setStart() {}, setEnd() {}, toString: () => "" });
  document.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  document.elementsFromPoint = () => [];
  document.elementFromPoint = () => null;
  document.querySelectorAll("[data-preset]");
  return { document, byId, all, listFor };
}

// =====================================================================================
// §B2 加载 app.js（只改写 import/export 行）
// =====================================================================================

export async function loadAppSource({ appSourcePath = APP_PATH, depsDir = path.join(REPO_ROOT, "public") } = {}) {
  const source = await readFile(appSourcePath, "utf8");
  const specifiers = [...new Set([...source.matchAll(/from\s*"(\.[^"]+)"/g)].map((m) => m[1]))];
  const deps = {};
  for (const spec of specifiers) {
    deps[spec] = await import(pathToFileURL(path.join(depsDir, spec)).href);
  }
  const applied = [];
  for (const match of source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from\s*"(\.[^"]+)";\s*$/gm)) {
    const names = match[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .join(", ");
    applied.push({ from: match[0], to: `const { ${names} } = __deps[${JSON.stringify(match[2])}];`, kind: "import" });
  }
  for (const match of source.matchAll(/^export\s*\{[^}]*\};\s*$/gm)) {
    applied.push({ from: match[0], to: "", kind: "export-list" });
  }
  for (const match of source.matchAll(/^export\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gm)) {
    applied.push({ from: match[0], to: "", kind: "export-keyword" });
  }
  let code = source;
  for (const step of applied) {
    if (!code.includes(step.from))
      throw new Error(`改写锚点丢失：${step.kind} ${JSON.stringify(step.from.slice(0, 60))}`);
    code = code.replace(step.from, step.to);
  }
  const leftovers = {
    import: (code.match(/^\s*import\s/gm) ?? []).length,
    export: (code.match(/^\s*export\s/gm) ?? []).length,
  };
  if (leftovers.import || leftovers.export) throw new Error(`import/export 改写不完整：${JSON.stringify(leftovers)}`);
  const nonImportExport = applied.filter((step) => !/^(import|export)/.test(step.from));
  if (nonImportExport.length) throw new Error("改写只允许落在 import/export 行");
  return {
    source,
    code,
    deps,
    specifiers,
    applied,
    transform: {
      sourceBytes: Buffer.byteLength(source, "utf8"),
      transformedBytes: Buffer.byteLength(code, "utf8"),
      rewritten: applied.length,
      byKind: applied.reduce((acc, step) => {
        acc[step.kind] = (acc[step.kind] ?? 0) + 1;
        return acc;
      }, {}),
      onlyImportExportLines: nonImportExport.length === 0,
      leftovers,
      /** 忠实性：`code` 恰好等于 `source` 经过这些**字面替换**的结果。 */
      derivedFromReplacements: applied.reduce((acc, step) => acc.replace(step.from, step.to), source) === code,
    },
  };
}

// =====================================================================================
// §B3 周期夹具
// =====================================================================================

/**
 * `public/app-state.js` 导出的是**模块级单例**：同一进程里连开两个夹具必须先把状态归零，
 * 否则上一个场景的 preset / quota 快照会漏进下一个场景，计数就被残留污染。
 */
let pristineState = null;
function cloneState(value) {
  return JSON.parse(JSON.stringify(value));
}
/** 依赖模块（`public/skin-ui.js` 等）跑在 **Node realm**，会在调用期读裸 `document`。
 *  ⇒ 夹具期间把 DOM 挂到 globalThis（jsdom 同做法），`dispose()` 逐项还原。 */
let domGlobalsOwner = null;
let harnessCounter = 0;
function installDomGlobals(harnessId, values) {
  if (domGlobalsOwner !== null && domGlobalsOwner !== harnessId) {
    throw new Error(`U4 夹具同一时刻只允许一个（当前持有者 ${domGlobalsOwner}；先 dispose 再开下一个）`);
  }
  const saved = new Map();
  const patched = [];
  const skipped = [];
  for (const [key, value] of Object.entries(values)) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    saved.set(key, descriptor);
    // configurable 的只读访问器（如 Node navigator）也可替换，避免宿主语言污染夹具。
    if (descriptor && !descriptor.configurable) {
      skipped.push(key);
      continue;
    }
    try {
      Object.defineProperty(globalThis, key, {
        value,
        configurable: true,
        writable: true,
        enumerable: descriptor?.enumerable ?? true,
      });
      patched.push(key);
    } catch {
      skipped.push(key);
    }
  }
  domGlobalsOwner = harnessId;
  const install = { patched, skipped };
  install.restore = () => {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) delete globalThis[key];
      else Object.defineProperty(globalThis, key, descriptor);
    }
    if (domGlobalsOwner === harnessId) domGlobalsOwner = null;
  };
  return install;
}

const WRAPPED = [
  "render",
  "loadUsage",
  "checkForUpdates",
  "usageQuery",
  "recentDateRange",
  "currentElapsedMs",
  "formatLocalDateTimeWithZone",
  "quotaWindowAvailability",
  "quotaWindowBounds",
  "setAutoRefreshStatus",
  "refreshPricingAutomatically",
];

function emptyCounts() {
  return {
    ticks: 0,
    statusChecks: 0,
    usageSyncs: 0,
    skipCheckSyncs: 0,
    freezeSyncs: 0,
    snapshotSyncs: 0,
    otherFetches: 0,
    loadUsageCalls: 0,
    checkForUpdatesCalls: 0,
    renders: 0,
    queryBuilds: 0,
    statusWrites: 0,
    statusErrors: 0,
    lastStatus: "",
    calls: {},
    clock: {
      recentDateRange: 0,
      currentElapsedMs: 0,
      formatLocalDateTimeWithZone: 0,
      quotaWindowAvailability: 0,
      quotaWindowBounds: 0,
    },
  };
}

export async function createCycleHarness(options = {}) {
  const {
    appSourcePath = APP_UNDER_TEST,
    depsDir = path.join(REPO_ROOT, "public"),
    response,
    initial = {},
    storage = {},
    realTimers = false,
    pricingCatalog = { automatic: {}, usageCoverage: {}, modelActivities: [] },
  } = options;
  const html = await readFile(INDEX_PATH, "utf8");
  const contract = parseDomContract(html);
  const dom = createDomStub(html, contract);
  const loaded = await loadAppSource({ appSourcePath, depsDir });
  const state = loaded.deps["./app-state.js"].state;

  if (pristineState === null) pristineState = cloneState(state);
  else Object.assign(state, cloneState(pristineState));

  const counts = emptyCounts();
  const fetchLog = [];
  const failures = [];
  let pendingFetches = 0;
  let timerSeq = 0;
  const timers = { entries: [], timeouts: [], cleared: [], tickCalls: 0, cycleCallbacks: [] };
  const storageMap = new Map(Object.entries(storage));

  const localStorage = {
    getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
    setItem: (key, value) => storageMap.set(key, String(value)),
    removeItem: (key) => storageMap.delete(key),
    clear: () => storageMap.clear(),
    key: (index) => [...storageMap.keys()][index] ?? null,
    get length() {
      return storageMap.size;
    },
  };

  const windowStub = {
    innerWidth: 1280,
    innerHeight: 900,
    devicePixelRatio: 1,
    document: dom.document,
    localStorage,
    sessionStorage: localStorage,
    navigator: {
      language: "zh-CN",
      languages: ["zh-CN"],
      userAgent: "u4-harness",
      clipboard: { writeText: async () => {} },
      platform: "Win32",
    },
    matchMedia: (query) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
    requestAnimationFrame: (callback) => {
      queueMicrotask(() => callback(Date.now()));
      timerSeq += 1;
      return timerSeq;
    },
    cancelAnimationFrame: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => "", color: "", backgroundColor: "" }),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    scrollTo: () => {},
    open: () => null,
    location: { href: "http://u4.local/", origin: "http://u4.local", search: "", pathname: "/", hash: "" },
  };

  const sandbox = {
    __deps: loaded.deps,
    console: { ...console, debug: () => {}, info: () => {}, warn: () => {} },
    fetch: (url, init) => {
      const request = { url: String(url), init };
      const parsed = new URL(request.url, "http://u4.local");
      const entry = {
        url: request.url,
        path: parsed.pathname,
        params: Object.fromEntries(parsed.searchParams.entries()),
        at: clockIso(),
        cycle: counts.ticks,
        seq: fetchLog.length,
      };
      fetchLog.push(entry);
      if (parsed.pathname === "/api/status") counts.statusChecks += 1;
      else if (parsed.pathname === "/api/usage" || parsed.pathname === "/api/summary") {
        counts.usageSyncs += 1;
        if (entry.params.skipCheck === "1") counts.skipCheckSyncs += 1;
        if (entry.params.freeze === "1") counts.freezeSyncs += 1;
        if (entry.params.snapshot) counts.snapshotSyncs += 1;
      } else if (parsed.pathname.startsWith("/api/")) counts.otherFetches += 1;
      pendingFetches += 1;
      entry.pending = true;
      const finish = (result) => {
        const status = result?.status ?? 200;
        entry.status = status;
        entry.pending = false;
        pendingFetches -= 1;
        return {
          ok: result?.ok ?? (status >= 200 && status < 300),
          status,
          json: async () => result?.payload ?? null,
          text: async () => JSON.stringify(result?.payload ?? null),
          headers: { get: () => "application/json" },
        };
      };
      let outcome;
      try {
        outcome = response ? response({ ...entry, init }) : { payload: null };
      } catch (error) {
        pendingFetches -= 1;
        entry.pending = false;
        entry.error = error.message;
        failures.push({ kind: "router", url: entry.url, message: error.message });
        return Promise.reject(error);
      }
      if (outcome && typeof outcome.then === "function") {
        return Promise.resolve(outcome).then(finish, (error) => {
          pendingFetches -= 1;
          entry.pending = false;
          failures.push({ kind: "fetch", url: entry.url, message: error?.message ?? String(error) });
          throw error;
        });
      }
      return Promise.resolve(finish(outcome));
    },
    localStorage,
    sessionStorage: localStorage,
    window: windowStub,
    navigator: {
      language: "zh-CN",
      languages: ["zh-CN"],
      userAgent: "u4-harness",
      clipboard: { writeText: async () => {} },
      platform: "Win32",
    },
    location: windowStub.location,
    document: dom.document,
    performance: { now: () => Date.now() },
    Date,
    Intl,
    URL,
    URLSearchParams,
    AbortController,
    TextEncoder,
    TextDecoder,
    queueMicrotask,
    structuredClone,
    getComputedStyle: windowStub.getComputedStyle,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    cancelAnimationFrame: windowStub.cancelAnimationFrame,
    matchMedia: windowStub.matchMedia,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IntersectionObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    Chart: class {
      constructor() {
        this.data = { datasets: [] };
        this.options = {};
      }
      update() {}
      destroy() {}
      resize() {}
      static register() {}
    },
    setTimeout: (callback, ms) => {
      let id;
      if (realTimers) {
        id = setTimeout(callback, ms);
      } else {
        timerSeq += 1;
        id = timerSeq;
      }
      timers.timeouts.push({ id, callback, ms, real: realTimers, cleared: false });
      return id;
    },
    clearTimeout: (id) => {
      const entry = timers.timeouts.find((candidate) => candidate.id === id);
      if (entry) entry.cleared = true;
      if (realTimers) clearTimeout(id);
    },
    setInterval: (callback, ms) => {
      let id = null;
      if (!realTimers) {
        timerSeq += 1;
        id = timerSeq;
      }
      const entry = {
        id,
        ms,
        callback,
        real: realTimers,
        cleared: false,
        calls: 0,
      };
      if (realTimers) {
        entry.id = setInterval(() => {
          entry.calls += 1;
          timers.tickCalls += 1;
          callback();
        }, ms);
      }
      timers.entries.push(entry);
      return entry.id;
    },
    clearInterval: (id) => {
      const entry = timers.entries.find((candidate) => candidate.id === id);
      if (entry) entry.cleared = true;
      timers.cleared.push(id);
      if (realTimers) clearInterval(id);
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  sandbox.top = sandbox;
  const context = vm.createContext(sandbox);

  function clockIso() {
    return state?.now ? new Date(state.now).toISOString() : new Date().toISOString();
  }

  const record = (name, args) => {
    counts.calls[name] = (counts.calls[name] ?? 0) + 1;
    if (name === "loadUsage") counts.loadUsageCalls += 1;
    if (name === "checkForUpdates") counts.checkForUpdatesCalls += 1;
    if (name === "render") counts.renders += 1;
    if (name === "usageQuery") counts.queryBuilds += 1;
    if (name in counts.clock) counts.clock[name] += 1;
    if (name === "setAutoRefreshStatus") {
      counts.statusWrites += 1;
      const [message, flags] = args;
      counts.lastStatus = String(message ?? "");
      if (flags?.error) counts.statusErrors += 1;
    }
  };
  sandbox.__u4 = { record };

  for (const [key, value] of Object.entries(initial)) state[key] = value;
  if (pricingCatalog !== null) state.pricingCatalog = pricingCatalog;

  harnessCounter += 1;
  const harnessId = `u4-${harnessCounter}`;
  const globals = installDomGlobals(harnessId, {
    document: dom.document,
    window: windowStub,
    localStorage,
    sessionStorage: localStorage,
    navigator: sandbox.navigator,
    location: windowStub.location,
    getComputedStyle: windowStub.getComputedStyle,
    matchMedia: windowStub.matchMedia,
    requestAnimationFrame: windowStub.requestAnimationFrame,
    cancelAnimationFrame: windowStub.cancelAnimationFrame,
    ResizeObserver: sandbox.ResizeObserver,
    IntersectionObserver: sandbox.IntersectionObserver,
    MutationObserver: sandbox.MutationObserver,
    Chart: sandbox.Chart,
  });

  Object.assign(windowStub, {
    setInterval: sandbox.setInterval,
    clearInterval: sandbox.clearInterval,
    setTimeout: sandbox.setTimeout,
    clearTimeout: sandbox.clearTimeout,
    requestAnimationFrame: sandbox.requestAnimationFrame,
    cancelAnimationFrame: sandbox.cancelAnimationFrame,
    queueMicrotask,
    getComputedStyle: sandbox.getComputedStyle,
    matchMedia: sandbox.matchMedia,
  });

  vm.runInContext(loaded.code, context, { filename: "public/app.js (U4 harness)" });
  vm.runInContext(
    `(() => {
      const names = ${JSON.stringify(WRAPPED)};
      for (const name of names) {
        const original = globalThis[name];
        if (typeof original !== "function") continue;
        globalThis[name] = function (...args) {
          __u4.record(name, args);
          return original.apply(this, args);
        };
      }
    })();`,
    context,
  );

  const api = vm.runInContext(
    `({
      checkForUpdates, loadUsage, startAutoRefresh, stopAutoRefresh, setAutoRefreshEnabled,
      initializeAutoRefresh, toggleQuotaPreset, render, usageQuery, updateQuotaPresetButton,
      renderAutoRefreshControls, renderUnavailableQuota, refreshViewForFilters, quotaWindowAvailability,
      AUTO_REFRESH_INTERVAL_MS, bootRan: typeof document !== "undefined",
    })`,
    context,
  );

  const flush = async (rounds = 6) => {
    for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const settle = async ({ rounds = 60, toleratePending = false } = {}) => {
    for (let index = 0; index < rounds; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      if (pendingFetches === 0 && !state.autoRefreshCheckInFlight) {
        await new Promise((resolve) => setImmediate(resolve));
        if (pendingFetches === 0 && !state.autoRefreshCheckInFlight) return index + 1;
      }
    }
    if (toleratePending) return rounds;
    throw new Error(`settle 超时：pendingFetches=${pendingFetches} checkInFlight=${state.autoRefreshCheckInFlight}`);
  };

  const activeIntervals = (ms = null) =>
    timers.entries.filter((entry) => !entry.cleared && (ms === null || entry.ms === ms));
  /** 周期回调：优先取 60000ms 那个；若被改短（变异体）就退回到**最新的非整点**定时器 ——
   *  这样"周期不是 60 秒"会落到 `u4.coverage.intervalIs60s` 这条**具名判据**上，
   *  而不是让夹具抛错（夹具抛错只能说明夹具脆，不能算抓住变体）。 */
  const pickInterval = () => {
    const preferred = activeIntervals(EXPECTED_INTERVAL_MS).at(-1);
    if (preferred) return preferred;
    const fallback = activeIntervals()
      .filter((entry) => entry.ms !== 60 * 60 * 1000)
      .at(-1);
    if (!fallback) throw new Error("tick：没有任何在册的周期回调（自动刷新未启动）");
    return fallback;
  };

  const harness = {
    appPath: appSourcePath,
    state,
    counts,
    fetchLog,
    failures,
    timers,
    dom,
    contract,
    context,
    loaded,
    api,
    globals,
    storage: storageMap,
    flush,
    settle,
    clockIso,
    activeIntervals,
    get pendingFetches() {
      return pendingFetches;
    },
    /** 手动触发一次周期回调（真实接线：app.js 自己注册的那个 60000ms 回调）。 */
    async tick({ settle: doSettle = true } = {}) {
      const interval = pickInterval();
      counts.ticks += 1;
      interval.calls += 1;
      timers.lastTickMs = interval.ms;
      timers.cycleCallbacks.push({ cycle: counts.ticks, at: clockIso(), ms: interval.ms });
      interval.callback();
      if (doSettle) await settle();
    },
    /** 在 fetch 未决时触发一次周期（用于"已有 sync 重叠"）。 */
    async tickWhilePending() {
      const interval = pickInterval();
      counts.ticks += 1;
      interval.calls += 1;
      timers.lastTickMs = interval.ms;
      timers.cycleCallbacks.push({ cycle: counts.ticks, at: clockIso(), ms: interval.ms });
      interval.callback();
      await flush(3);
    },
    countsSnapshot() {
      return JSON.parse(JSON.stringify(counts));
    },
    resetCounts() {
      Object.assign(counts, emptyCounts());
    },
    logSince(seq) {
      return fetchLog.filter((entry) => entry.seq >= seq);
    },
    dispose() {
      for (const entry of timers.entries) if (entry.real && entry.id !== null) clearInterval(entry.id);
      for (const entry of timers.timeouts) if (entry.real && entry.id !== null) clearTimeout(entry.id);
      globals.restore();
    },
  };
  return harness;
}

// =====================================================================================
// §B4 载荷夹具：默认生成隔离数据；历史测量脚本仍可显式传入抓包目录。
// =====================================================================================

const FIXTURE_FILES = {
  today: "00-first_check_today_default.json",
  quota_5h: "10-quota_5h.json",
  quota_week: "11-quota_week.json",
};

export async function loadRecordedPayloads({ dir } = {}) {
  if (!dir) {
    const now = new Date("2026-10-09T00:00:00.000Z");
    const homes = [{ id: "fixture-codex", label: "Codex", kind: "main", status: "active", path: "/fixture/.codex" }];
    const rateLimitObservations = [300, 10080].map((windowMinutes) => ({
      limitId: "codex",
      windowMinutes,
      role: windowMinutes === 300 ? "primary" : "secondary",
      observedAtMs: now.getTime(),
      resetsAtMs: now.getTime() + windowMinutes * 60000,
      usedPercent: 10,
      sourcePath: "/fixture/rollout.jsonl",
      lineNumber: 1,
    }));
    const report = {
      generatedAt: now.toISOString(),
      homes,
      warnings: [],
      rateLimitObservations,
      sessions: [],
      events: [
        {
          timestamp: now.toISOString(),
          sessionId: "fixture-session",
          homeId: homes[0].id,
          homeLabel: "Codex",
          channel: "CLI",
          model: "gpt-6-sol",
          cwd: "/fixture/project",
          total: { total: 1100, input: 1000, cached: 400, output: 100, reasoning: 0 },
        },
      ],
    };
    const quota = selectQuotaWindows(rateLimitObservations, now);
    return Object.fromEntries(
      Object.keys(FIXTURE_FILES).map((preset) => [
        preset,
        {
          checkedAt: now.toISOString(),
          fingerprint: "f".repeat(64),
          quota,
          metadata: { homes, imports: [], warnings: [] },
          summary: summarizeUsage(
            { ...report, quota },
            { preset, now, bucket: preset === "today" ? "hour" : preset === "quota_5h" ? "quota_30m" : "quota_24h" },
          ),
        },
      ]),
    );
  }
  const payloads = {};
  for (const [key, file] of Object.entries(FIXTURE_FILES)) {
    payloads[key] = JSON.parse(await readFile(path.join(dir, file), "utf8"));
  }
  return payloads;
}

/**
 * 造一个确定性的"服务器"：`/api/status` 与 `/api/usage`。
 * `plan` 是响应计划：`{ status: fn(params), usage: fn(params) }`，两者都返回 `{status, payload}`。
 */
export function createRouter({ payloads, status, usage, extra = {}, log = () => {} }) {
  return (request) => {
    if (request.path === "/api/status") {
      const answer = status({ request, payloads });
      log({ path: request.path, ...answer });
      return answer;
    }
    if (request.path === "/api/usage" || request.path === "/api/summary") {
      const answer = usage({ request, payloads });
      log({ path: request.path, ...answer });
      return answer;
    }
    if (request.path in extra) return extra[request.path]({ request, payloads });
    if (request.path === "/api/pricing/refresh")
      return { payload: { changed: false, statusChanged: false, issues: [], errors: [] } };
    if (request.path === "/api/pricing")
      return { payload: { usdToCnyRate: 6.72, automatic: {}, usageCoverage: {}, modelActivity: {} } };
    return { status: 404, payload: { error: `u4 harness 未登记的路由：${request.path}` } };
  };
}

export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// =====================================================================================
// §C 确定性周期矩阵
//
// 每个 range（today / quota_5h / quota_week）跑 ≥3 个周期，逐周期记：
//   源检查（/api/status 次数）/ 实际同步（/api/usage 次数）/ skipCheck 命中数 /
//   时钟重算（对时刻敏感的函数调用）/ 该周期发出的请求参数 / 渲染出来的产品可见字符串。
// 返回 `checks`（每条 `{id, ok, detail}`）——测试把它翻成**具名 AssertionError**，
// 测量脚本落 JSON，变异脚本据此判定"哪条判据抓住了变体"。
// =====================================================================================

export function patchPayload(payload, preset, patch = {}) {
  const next = clone(payload);
  if (patch.checkedAt) next.checkedAt = patch.checkedAt;
  if (patch.fingerprint) next.fingerprint = patch.fingerprint;
  if (patch.generatedAt && next.summary) next.summary.generatedAt = patch.generatedAt;
  if (patch.totals && next.summary) next.summary.totals = { ...next.summary.totals, ...patch.totals };
  if (patch.modelRename && next.summary?.models?.length) {
    // 只改**已存在**的字符串字段（否则加一个键就会改变字节数，"同尺寸"就不成立了）
    next.summary.models[0] = { ...next.summary.models[0], name: patch.modelRename, key: patch.modelRename };
  }
  if (patch.quotaState) {
    next.summary.range = {
      ...next.summary.range,
      quotaState: patch.quotaState,
      quotaReason: patch.quotaReason ?? null,
    };
    const windows = { ...(next.summary.quota?.windows ?? {}) };
    windows[preset] = { ...(windows[preset] ?? {}), state: patch.quotaState, reason: patch.quotaReason ?? null };
    next.summary.quota = { ...(next.summary.quota ?? {}), windows };
    next.quota = { ...(next.quota ?? {}), windows };
  }
  if (patch.clearAsOf) {
    // 让"限额不可用"的 as-of 只能来自**注入时钟** `state.now`（复用面：跨日 / reset）
    next.summary.range = { ...next.summary.range, asOf: null };
    const windows = { ...(next.summary.quota?.windows ?? {}) };
    windows[preset] = { ...(windows[preset] ?? {}), asOf: null };
    next.summary.quota = { ...(next.summary.quota ?? {}), asOf: null, windows };
    next.quota = { ...(next.quota ?? {}), asOf: null, windows };
  }
  if (patch.windowEndExclusive && next.summary.range) {
    next.summary.range = { ...next.summary.range, windowEndExclusive: patch.windowEndExclusive, quotaWindow: true };
  }
  return next;
}

/** 造一个"服务器"：`/api/status` 的 changed 与 `/api/usage` 的载荷都由脚本控制。 */
export function createPlannedRouter({ payload, preset, plan, requests }) {
  const server = {
    payload,
    changed: false,
    fingerprint: payload.fingerprint,
    checkedAt: payload.checkedAt,
    launcher: null,
  };
  const router = createRouter({
    payloads: {},
    status: () => {
      server.changed = plan.take();
      return {
        payload: {
          fingerprint: plan.fingerprint ? plan.fingerprint(server) : server.fingerprint,
          changed: server.changed,
          checkedAt: server.checkedAt,
        },
      };
    },
    usage: () => {
      requests.usage.push({ preset, fingerprint: server.payload.fingerprint });
      return { payload: server.payload };
    },
    log: () => {},
  });
  return { server, router };
}

export async function runCycleMatrix(options = {}) {
  const { appSourcePath = APP_UNDER_TEST, depsDir = path.join(REPO_ROOT, "public") } = options;
  const payloads = await loadRecordedPayloads();
  const checks = [];
  const evidence = { cycles: [], ranges: {}, static: {} };
  const ok = (id, condition, detail = null) => {
    checks.push({ id, ok: Boolean(condition), detail });
    return Boolean(condition);
  };

  for (const preset of ["today", "quota_5h", "quota_week"]) {
    const base = payloads[preset];
    const isQuota = preset !== "today";
    const script = [];
    const state = {
      payload: base,
      changed: false,
      checkedAt: base.checkedAt,
      cycle: 0,
      sameSizeBytes: null,
      gate: null,
      forceChanged: null,
    };
    const router = createRouter({
      payloads: {},
      status: () => {
        const step = script[Math.min(state.cycle - 1, script.length - 1)] ?? { changed: false };
        state.changed = state.forceChanged ?? step.changed ?? false;
        if (step.statusFingerprint) state.payload = { ...state.payload, fingerprint: step.statusFingerprint };
        return {
          payload: {
            fingerprint: state.payload.fingerprint,
            changed: state.changed,
            checkedAt: state.checkedAt,
          },
        };
      },
      usage: () => (state.gate ? state.gate.then(() => ({ payload: state.payload })) : { payload: state.payload }),
      log: () => {},
    });

    const harness = await createCycleHarness({
      appSourcePath,
      depsDir,
      response: router,
      storage: { codexUsageAutoRefresh: "on" },
      initial: {
        now: "2026-10-09T00:00:00.000Z",
        preset,
        bucket: preset === "today" ? "hour" : preset === "quota_5h" ? "quota_30m" : "quota_24h",
        lastQuotaPreset: preset === "quota_week" ? "quota_week" : "quota_5h",
      },
    });
    const domRangeLabel = () => harness.dom.byId.get("rangeLabel");
    await harness.settle();

    const baseFingerprint = harness.state.fingerprint;
    const observed = [];
    const capture = (label) => ({
      cycle: harness.counts.ticks,
      label,
      statusChecks: harness.counts.statusChecks,
      usageSyncs: harness.counts.usageSyncs,
      skipCheckSyncs: harness.counts.skipCheckSyncs,
      freezeSyncs: harness.counts.freezeSyncs,
      renders: harness.counts.renders,
      clock: clone(harness.counts.clock),
      clockTotal: Object.values(harness.counts.clock).reduce((sum, value) => sum + value, 0),
      fingerprint: harness.state.fingerprint,
      lastSuccessfulCheck: harness.state.lastSuccessfulCheck,
      quotaState: harness.state.summary?.range?.quotaState ?? null,
      rangeText: domRangeLabel()?.textContent ?? "",
      rangeTitle: domRangeLabel()?.title ?? "",
      statusErrors: harness.counts.statusErrors,
      lastStatus: harness.counts.lastStatus,
      seq: harness.fetchLog.length,
    });
    const delta = (from, to) => ({
      statusChecks: to.statusChecks - from.statusChecks,
      usageSyncs: to.usageSyncs - from.usageSyncs,
      skipCheckSyncs: to.skipCheckSyncs - from.skipCheckSyncs,
      freezeSyncs: to.freezeSyncs - from.freezeSyncs,
      renders: to.renders - from.renders,
      clockTotal: to.clockTotal - from.clockTotal,
      clock: Object.fromEntries(Object.entries(to.clock).map(([key, value]) => [key, value - from.clock[key]])),
    });

    // ---- 周期 1：changed=false（today 应只探测；quota 预设应探测 + 同步）----
    // ---- 周期 2：changed=true（必须同步，且**不得**带 skipCheck）----
    // ---- 周期 3：同尺寸改写（载荷字节数不变、内容变化）----
    // ---- 周期 4：WAL（主文件字段不变、指纹随 -wal 变化）----
    // ---- 周期 5：重回 changed=false ----
    script.push({ changed: false }, { changed: true }, { changed: true }, { changed: true }, { changed: false });

    for (const [index, label] of [
      "changed-false",
      "changed-true",
      "same-size-rewrite",
      "wal-only",
      "changed-false-again",
    ].entries()) {
      const before = capture(`${label}:before`);
      const beforeText = JSON.stringify(state.payload);
      state.cycle = index + 1;
      state.checkedAt = `2026-10-09T0${index}:0${index}:0${index}.000Z`;
      harness.state.now = `2026-10-09T0${index}:30:00.000Z`;
      if (label === "same-size-rewrite") {
        const models = state.payload.summary?.models ?? [];
        const original = models[0]?.name ?? "gpt-5-codex";
        const renamed = `${original.slice(0, -1)}${original.at(-1) === "x" ? "y" : "x"}`;
        const fingerprint = `${String(state.payload.fingerprint).slice(0, -2)}re`;
        const candidate = patchPayload(state.payload, preset, {
          checkedAt: state.checkedAt,
          fingerprint,
          modelRename: renamed,
        });
        state.payload = candidate;
        state.sameSizeBytes = {
          before: Buffer.byteLength(beforeText, "utf8"),
          after: Buffer.byteLength(JSON.stringify(candidate), "utf8"),
          equal: Buffer.byteLength(beforeText, "utf8") === Buffer.byteLength(JSON.stringify(candidate), "utf8"),
        };
      } else if (label === "wal-only") {
        state.payload = patchPayload(state.payload, preset, {
          checkedAt: state.checkedAt,
          fingerprint: `${String(state.payload.fingerprint).slice(0, -2)}wa`,
        });
      } else {
        state.payload = patchPayload(state.payload, preset, { checkedAt: state.checkedAt });
      }
      await harness.tick();
      const after = capture(`${label}:after`);
      const diff = delta(before, after);
      const cycleRequests = harness.fetchLog.slice(before.seq);
      const statusRequests = cycleRequests.filter((entry) => entry.path === "/api/status");
      const usageRequests = cycleRequests.filter((entry) => entry.path === "/api/usage");
      const record = {
        preset,
        label,
        cycle: index + 1,
        changed: state.changed,
        isQuota,
        delta: diff,
        statusRequests: statusRequests.map((entry) => ({ params: entry.params, status: entry.status })),
        usageRequests: usageRequests.map((entry) => ({ params: entry.params, status: entry.status })),
        fingerprintAfter: after.fingerprint,
        lastSuccessfulCheck: after.lastSuccessfulCheck,
        rangeTitle: after.rangeTitle,
        quotaState: after.quotaState,
        sameSizeBytes: state.sameSizeBytes,
        statusErrors: after.statusErrors,
        lastStatus: after.lastStatus,
      };
      observed.push(record);
      evidence.cycles.push(record);

      const prefix = `${preset}.${label}`;
      // ① 每个周期都必须做**源检查**（这正是"不得以少查来源换性能"的机械证据）
      ok(`u4.cycle.${prefix}.sourceCheck`, diff.statusChecks === 1, { statusChecks: diff.statusChecks });
      // ② 周期路径的同步**不得**用 skipCheck（服务器端 skipCheck=1 会跳过来源内容检查）
      ok(
        `u4.cycle.${prefix}.syncKeepsCheck`,
        usageRequests.every((entry) => entry.params.skipCheck !== "1"),
        { skipCheck: usageRequests.map((entry) => entry.params.skipCheck ?? null) },
      );
      // ③ changed=true ⇒ 必须同步；④ today + changed=false ⇒ 不同步（配额预设必须同步以重算时钟）
      if (state.changed) {
        ok(`u4.cycle.${prefix}.syncOnChanged`, diff.usageSyncs === 1, { usageSyncs: diff.usageSyncs });
      } else if (isQuota) {
        ok(`u4.cycle.${prefix}.syncOnQuotaClock`, diff.usageSyncs === 1, { usageSyncs: diff.usageSyncs });
      } else {
        ok(`u4.cycle.${prefix}.noSyncWhenUnchanged`, diff.usageSyncs === 0, { usageSyncs: diff.usageSyncs });
      }
      // ⑤ 探测必须带上当前指纹（续航链），且周期内该请求只有一次
      ok(
        `u4.cycle.${prefix}.sinceChain`,
        statusRequests.length === 1 && statusRequests[0].params.since === before.fingerprint,
        { since: statusRequests[0]?.params.since ?? null, expected: before.fingerprint },
      );
      // ⑥ 配额预设：每个周期都要重算时钟（窗口可用性/边界）
      if (isQuota) {
        ok(`u4.cycle.${prefix}.clockRecompute`, diff.clockTotal >= 1, { clock: diff.clock });
      }
      // ⑦ 同尺寸改写：字节数必须真的相等（否则"同尺寸"就是空话）
      if (label === "same-size-rewrite") {
        ok(`u4.cycle.${prefix}.sameSizeProven`, state.sameSizeBytes?.equal === true, state.sameSizeBytes ?? {});
      }
      // ⑧ 同尺寸改写 / WAL：同步后客户端必须落到**新内容**
      if (label === "same-size-rewrite") {
        ok(
          `u4.cycle.${prefix}.contentApplied`,
          after.fingerprint !== before.fingerprint && after.lastSuccessfulCheck === state.checkedAt,
          { fingerprintBefore: before.fingerprint, fingerprintAfter: after.fingerprint, checkedAt: state.checkedAt },
        );
      }
      if (label === "wal-only") {
        ok(
          `u4.cycle.${prefix}.walApplied`,
          after.fingerprint === state.payload.fingerprint && after.fingerprint !== baseFingerprint,
          { fingerprint: after.fingerprint, expected: state.payload.fingerprint },
        );
      }
      ok(`u4.cycle.${prefix}.noError`, after.statusErrors === 0, { lastStatus: after.lastStatus });
    }

    // ---- 复位跨越（reset）：窗口从 available 变 unavailable + 新的 as-of ----
    {
      const before = capture("reset:before");
      state.cycle += 1;
      state.checkedAt = "2026-10-09T06:00:00.000Z";
      harness.state.now = "2026-10-09T06:30:00.000Z";
      state.payload = patchPayload(state.payload, preset, {
        checkedAt: state.checkedAt,
        quotaState: "unavailable",
        quotaReason: "等待新的限额记录。",
        windowEndExclusive: "2026-10-09T06:20:00.000Z",
        clearAsOf: true,
      });
      await harness.tick();
      const after = capture("reset:after");
      const diff = delta(before, after);
      if (isQuota) {
        const emptyMessage = harness.state.emptySummaryMessage ?? "";
        const detailHtml = harness.dom.byId.get("detailList")?.innerHTML ?? "";
        const record = {
          preset,
          label: "quota-reset-crossing",
          cycle: state.cycle,
          delta: diff,
          rangeTitle: after.rangeTitle,
          rangeText: after.rangeText,
          quotaState: after.quotaState,
          emptySummaryMessage: emptyMessage,
          detailHtml,
        };
        observed.push(record);
        evidence.cycles.push(record);
        ok(`u4.cycle.${preset}.reset.recomputed`, diff.clockTotal >= 1, { clock: diff.clock });
        ok(
          `u4.cycle.${preset}.reset.rendersUnavailable`,
          /等待新的限额记录/.test(emptyMessage) && /等待新的限额记录/.test(detailHtml),
          { emptySummaryMessage: emptyMessage, detailHtml },
        );
        ok(
          `u4.cycle.${preset}.reset.asOfFromClock`,
          // 注入时钟 = 2026-10-09T06:30Z；真实 now（若有人绕过 state.now）会是运行当天(2026-10-10) ⇒ 必然不同
          after.rangeTitle.includes("2026-10-09") && !after.rangeTitle.includes("2026-10-1"),
          { rangeTitle: after.rangeTitle },
        );
        // 产品把窗口边界渲染成**本地时刻**（`formatLocalClock`）⇒ 期望值按同一口径算，
        // 不写死宿主时区。
        const endAt = new Date("2026-10-09T06:20:00.000Z");
        const localClock = `${String(endAt.getHours()).padStart(2, "0")}:${String(endAt.getMinutes()).padStart(2, "0")}`;
        ok(
          `u4.cycle.${preset}.reset.windowBoundsApplied`,
          after.rangeTitle.includes(localClock) || after.rangeTitle.includes("06:20"),
          { expectedLocalClock: localClock, rangeTitle: after.rangeTitle, rangeText: after.rangeText },
        );
      } else {
        await harness.settle();
      }
    }

    // ---- 暂停（真实点击）→ 3 次陈旧回调不得发请求；恢复（真实点击）→ 继续探测 ----
    {
      const toggle = harness.dom.byId.get("autoRefreshToggle");
      toggle.click();
      await harness.settle();
      const paused = capture("paused");
      const stale = harness.timers.entries.filter((entry) => entry.ms !== 60 * 60 * 1000).at(-1);
      const beforeStale = capture("stale:before");
      for (let index = 0; index < 3; index += 1) {
        harness.counts.ticks += 1;
        stale.callback();
      }
      await harness.settle();
      const afterStale = capture("stale:after");
      const staleDiff = delta(beforeStale, afterStale);
      ok(`u4.pause.${preset}.timerCleared`, harness.state.autoRefreshTimer === null && stale.cleared === true, {
        timer: harness.state.autoRefreshTimer,
        cleared: stale.cleared,
        clearedIds: harness.timers.cleared.length,
      });
      ok(
        `u4.pause.${preset}.staleCallbackSilent`,
        staleDiff.statusChecks === 0 && staleDiff.usageSyncs === 0,
        staleDiff,
      );
      ok(`u4.pause.${preset}.asOfFrozen`, afterStale.lastSuccessfulCheck === paused.lastSuccessfulCheck, {
        before: paused.lastSuccessfulCheck,
        after: afterStale.lastSuccessfulCheck,
      });
      const frozenRequest = harness.fetchLog.slice(paused.seq - 2).find((entry) => entry.params.freeze === "1");
      ok(
        `u4.pause.${preset}.freezeSnapshot`,
        Boolean(frozenRequest) && frozenRequest.params.skipCheck === "1",
        frozenRequest ? { params: frozenRequest.params } : {},
      );

      const beforeResume = capture("resume:before");
      toggle.click();
      await harness.settle();
      const afterResume = capture("resume:after");
      const resumeDiff = delta(beforeResume, afterResume);
      const resumed = harness.timers.entries.filter((entry) => entry.ms === EXPECTED_INTERVAL_MS && !entry.cleared);
      ok(`u4.resume.${preset}.timerRestored`, resumed.length === 1 && harness.state.autoRefreshTimer !== null, {
        active: resumed.length,
        timer: harness.state.autoRefreshTimer,
      });
      ok(
        `u4.resume.${preset}.immediateLoadKeepsCheck`,
        resumeDiff.usageSyncs >= 1 && resumeDiff.skipCheckSyncs === 0,
        resumeDiff,
      );
      const beforeNext = capture("resume:next:before");
      await harness.tick();
      const afterNext = capture("resume:next:after");
      const nextDiff = delta(beforeNext, afterNext);
      ok(`u4.resume.${preset}.nextCycleProbes`, nextDiff.statusChecks === 1, nextDiff);
    }

    // ---- 与"已有 sync 重叠"：同步未决时再触发一次周期 ⇒ 不得重复发请求 ----
    // 用**同一个夹具**、把 /api/usage 的返回挂在一个我能解除的闸门上（不另开夹具：app-state
    // 是模块级单例，再开一个夹具会把本夹具的 state 归零）。
    {
      let release = null;
      state.gate = new Promise((resolve) => {
        release = resolve;
      });
      state.forceChanged = true;
      const beforeFirst = capture("overlap:first:before");
      await harness.tickWhilePending();
      const first = capture("overlap:first:after");
      const firstDiff = delta(beforeFirst, first);
      await harness.tickWhilePending();
      const second = capture("overlap:second:after");
      const secondDiff = delta(first, second);
      release();
      state.gate = null;
      state.forceChanged = null;
      await harness.settle();
      const settled = capture("overlap:settled");
      ok(`u4.overlap.${preset}.singleFlight`, secondDiff.statusChecks === 0 && secondDiff.usageSyncs === 0, {
        firstCycle: firstDiff,
        whileInFlight: secondDiff,
      });
      ok(
        `u4.overlap.${preset}.guardReleased`,
        firstDiff.usageSyncs === 1 &&
          harness.state.autoRefreshCheckInFlight === false &&
          harness.state.summary?.quota !== undefined,
        { firstCycle: firstDiff, checkInFlight: harness.state.autoRefreshCheckInFlight },
      );
      ok(`u4.overlap.${preset}.stillChecksSources`, firstDiff.statusChecks === 1, firstDiff);
      evidence.overlap = evidence.overlap ?? {};
      evidence.overlap[preset] = {
        firstCycle: firstDiff,
        whileInFlight: secondDiff,
        settled: { fingerprint: settled.fingerprint },
      };
    }

    // ---- 切范围（真实 toggleQuotaPreset）：请求带上新 preset，且**下一个周期仍做源检查** ----
    if (!isQuota) {
      const beforeSwitch = capture("switch:before");
      // 切到限额预设时若限额快照没有 as-of，渲染只能用**注入时钟** `state.now`
      // （`renderUnavailableQuota` 的默认入参，app.js:2951）—— 这条必须在**同步**渲染后立刻取，
      // 因为紧接着的 `refreshViewForFilters()` 会用新载荷再渲染一次。
      harness.state.quotaSnapshot = { ...(harness.state.quotaSnapshot ?? {}), asOf: null };
      harness.api.toggleQuotaPreset();
      const switchTitle = domRangeLabel()?.title ?? "";
      const switchText = domRangeLabel()?.textContent ?? "";
      await harness.settle();
      const switchRequests = harness.fetchLog.slice(beforeSwitch.seq);
      ok(
        `u4.switch.rangeSwitchUsesInjectedClock`,
        switchTitle.includes("2026-10-09") && !switchTitle.includes("2026-10-1"),
        { switchTitle, switchText, injectedNow: harness.state.now },
      );
      ok(
        `u4.switch.rangePlumbing`,
        harness.state.preset === "quota_5h" &&
          switchRequests.some((entry) => entry.path === "/api/usage" && entry.params.preset === "quota_5h"),
        {
          preset: harness.state.preset,
          requests: switchRequests.map((entry) => ({ path: entry.path, preset: entry.params.preset })),
        },
      );
      const beforeAfterSwitch = capture("switch:next:before");
      await harness.tick();
      const afterAfterSwitch = capture("switch:next:after");
      const nextDiff = delta(beforeAfterSwitch, afterAfterSwitch);
      ok(`u4.switch.nextCycleProbes`, nextDiff.statusChecks === 1 && nextDiff.usageSyncs === 1, nextDiff);
      ok(
        `u4.switch.userActionMaySkip`,
        switchRequests.filter((entry) => entry.path === "/api/usage").every((entry) => entry.params.skipCheck === "1"),
        { requests: switchRequests.map((entry) => entry.params) },
      );
    }

    evidence.ranges[preset] = {
      cycles: observed,
      totalStatusChecks: harness.counts.statusChecks,
      totalUsageSyncs: harness.counts.usageSyncs,
      totalSkipCheck: harness.counts.skipCheckSyncs,
      totalFreeze: harness.counts.freezeSyncs,
      clock: clone(harness.counts.clock),
      activeIntervals: harness.activeIntervals().map((entry) => entry.ms),
      failures: clone(harness.failures),
    };
    evidence.static.harnessIntervalMs = harness.api.AUTO_REFRESH_INTERVAL_MS;
    harness.dispose();
  }

  // ---- 覆盖面无减损：每个周期都保留了它自己的源检查 ----
  const perRange = Object.entries(evidence.ranges).map(([preset, entry]) => ({
    preset,
    cycles: entry.cycles.length,
    statusChecks: entry.totalStatusChecks,
  }));
  evidence.coverage = perRange;
  ok("u4.coverage.intervalIs60s", evidence.static.harnessIntervalMs === EXPECTED_INTERVAL_MS, {
    intervalMs: evidence.static.harnessIntervalMs,
  });
  return { checks, evidence, payloads };
}

// =====================================================================================
// §C2 失败后自愈：引导时首轮取数失败（`state.fingerprint` 为空）之后，60 秒循环还要不要继续检查？
//
// 服务器**明确支持**无 `since` 的探测：`src/server.js:620`
//   `changed: since ? clientFingerprint(status.fingerprint) !== since : true`
// 即"没有基线 ⇒ 一律当成有变化"。所以客户端只要继续探测就能自愈。
// 本场景就是这条契约的机械证据：先造一次失败的引导，再看两个周期内有没有源检查 / 同步。
// =====================================================================================

export async function runRecoveryScenario({
  appSourcePath = APP_UNDER_TEST,
  depsDir = path.join(REPO_ROOT, "public"),
} = {}) {
  const checks = [];
  const ok = (id, condition, detail = null) => {
    checks.push({ id, ok: Boolean(condition), detail });
    return Boolean(condition);
  };
  const payloads = await loadRecordedPayloads();
  let bootFailed = false;
  const router = createRouter({
    payloads,
    status: () => ({
      payload: { fingerprint: payloads.today.fingerprint, changed: true, checkedAt: "2026-10-09T08:00:00.000Z" },
    }),
    usage: () => {
      if (!bootFailed) {
        bootFailed = true;
        return { status: 500, payload: { error: "u4 探针：引导首轮取数失败" } };
      }
      return { payload: payloads.today };
    },
  });
  const harness = await createCycleHarness({
    appSourcePath,
    depsDir,
    response: router,
    storage: { codexUsageAutoRefresh: "on" },
    initial: { now: "2026-10-09T08:00:00.000Z", preset: "today" },
  });
  await harness.settle();
  const afterBoot = {
    fingerprint: harness.state.fingerprint,
    statusChecks: harness.counts.statusChecks,
    usageSyncs: harness.counts.usageSyncs,
    lastStatus: harness.counts.lastStatus,
    statusErrors: harness.counts.statusErrors,
  };
  ok("u4.recovery.bootDidFail", afterBoot.fingerprint === "" && afterBoot.statusErrors >= 1, afterBoot);

  harness.resetCounts();
  const before = harness.fetchLog.length;
  const cycles = [];
  for (let index = 0; index < 3; index += 1) {
    await harness.tick();
    cycles.push({
      cycle: index + 1,
      statusChecks: harness.counts.statusChecks,
      usageSyncs: harness.counts.usageSyncs,
      skipCheckSyncs: harness.counts.skipCheckSyncs,
      fingerprint: harness.state.fingerprint,
      lastSuccessfulCheck: harness.state.lastSuccessfulCheck,
      lastStatus: harness.counts.lastStatus,
      statusErrors: harness.counts.statusErrors,
    });
  }
  const requests = harness.fetchLog.slice(before);
  const observed = {
    afterBoot,
    cycles,
    statusRequests: requests.filter((entry) => entry.path === "/api/status").map((entry) => entry.params),
    usageRequests: requests.filter((entry) => entry.path === "/api/usage").map((entry) => entry.params),
    recoveredFingerprint: harness.state.fingerprint,
    recoveredSummary: Boolean(harness.state.summary),
    finalStatus: harness.counts.lastStatus,
  };
  ok(
    "u4.recovery.loopKeepsCheckingAfterFailedBoot",
    cycles.some((entry) => entry.statusChecks >= 1),
    { cycles: cycles.map((entry) => entry.statusChecks), statusRequests: observed.statusRequests },
  );
  ok(
    "u4.recovery.sinceChainAfterRecovery",
    observed.statusRequests.length > 0 &&
      !Object.hasOwn(observed.statusRequests[0], "since") &&
      observed.statusRequests.slice(1).every((params) => typeof params.since === "string" && params.since.length > 0),
    { statusRequests: observed.statusRequests },
  );
  ok(
    "u4.recovery.selfHealsWithoutManualRefresh",
    observed.recoveredSummary === true && observed.recoveredFingerprint === payloads.today.fingerprint,
    { recoveredFingerprint: observed.recoveredFingerprint, recoveredSummary: observed.recoveredSummary },
  );
  ok(
    "u4.recovery.recoverySyncKeepsCheck",
    observed.usageRequests.every((params) => params.skipCheck !== "1"),
    { usageRequests: observed.usageRequests },
  );
  harness.dispose();
  return { checks, observed };
}

// =====================================================================================
// §A 既有断言（原样保留 —— 本卡**不**放松任何一条既有覆盖）
// =====================================================================================

function sourceBetween(source, startFunction, endFunction) {
  const startIndex = source.indexOf(`function ${startFunction}`);
  const endIndex = source.indexOf(`function ${endFunction}`, startIndex);
  assert.notEqual(startIndex, -1);
  assert.notEqual(endIndex, -1);
  return source.slice(startIndex, endIndex);
}

if (!HARNESS_ONLY) {
  test("auto refresh preference gates polling, preserves manual refresh, and preserves frozen server snapshots", async () => {
    const source = await readFile(APP_UNDER_TEST, "utf8");
    const check = sourceBetween(source, "checkForUpdates", "startAutoRefresh");
    const start = sourceBetween(source, "startAutoRefresh", "stopAutoRefresh");
    const stop = sourceBetween(source, "stopAutoRefresh", "refreshViewForFilters");
    const toggle = sourceBetween(source, "setAutoRefreshEnabled", "initializeAutoRefresh");
    const initialize = sourceBetween(source, "initializeAutoRefresh", "setPricingMessage");
    const visibilityStart = source.indexOf('document.addEventListener("visibilitychange"');
    const visibilityEnd = source.indexOf("setTheme(preferredTheme()", visibilityStart);
    const visibility = source.slice(visibilityStart, visibilityEnd);

    assert.match(source, /AUTO_REFRESH_STORAGE_KEY/);
    assert.match(source, /localStorage\.setItem\(AUTO_REFRESH_STORAGE_KEY/);
    assert.match(check, /!state\.autoRefreshEnabled/);
    assert.match(check, /state\.autoRefreshCheckInFlight/);
    assert.match(check, /runId !== state\.autoRefreshRunId/);
    assert.match(check, /await loadUsage\(\)/);
    assert.match(check, /status\.changed \|\| isQuotaPreset\(state\.preset\)/);
    assert.match(start, /state\.autoRefreshTimer/);
    assert.match(stop, /window\.clearInterval/);
    assert.match(toggle, /stopAutoRefresh\(\)/);
    assert.match(toggle, /if \(checkNow\) void loadUsage\(\)/);
    assert.match(toggle, /loadUsage\(\{ skipCheck: true, freeze: true \}\)/);
    assert.match(initialize, /state\.autoRefreshEnabled = readAutoRefreshPreference\(\)/);
    assert.match(visibility, /!document\.hidden && state\.autoRefreshEnabled/);
    assert.match(source, /params\.set\("snapshot", state\.snapshotId\)/);
    assert.match(source, /params\.set\("freeze", "1"\)/);
    assert.match(source, /if \(error\.body\?\.quota\) state\.quotaSnapshot = error\.body\.quota/);
    assert.match(source, /renderUnavailableQuota\(reason\)/);
    assert.match(source, /state\.summary = null/);
    assert.doesNotMatch(source, /force: true/);
  });

  test("U4 harness loads the delivered app.js module with only import/export lines rewritten", async () => {
    const loaded = await loadAppSource({});
    assert.equal(loaded.transform.onlyImportExportLines, true);
    assert.equal(loaded.transform.derivedFromReplacements, true);
    assert.equal(loaded.transform.leftovers.import, 0);
    assert.equal(loaded.transform.leftovers.export, 0);
    assert.ok(loaded.transform.rewritten > 0);
  });

  // 确定性周期矩阵：一次跑完 today / quota_5h / quota_week，逐条判据都有**具名**消息
  // （`u4.<id>: <期望> | 实测 …`），变异脚本据此判定"哪条判据抓住了变体"。
  test("U4 deterministic 60s cycles: source check, skipCheck policy, quota clock recompute", async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      get: () => ({ language: "en-US", languages: ["en-US"] }),
    });
    let checks;
    let evidence;
    try {
      ({ checks, evidence } = await runCycleMatrix({}));
      assert.equal(globalThis.navigator.language, "en-US", "夹具结束后恢复宿主只读 navigator");
    } finally {
      if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
      else delete globalThis.navigator;
    }
    const failed = checks.filter((check) => !check.ok);
    assert.equal(
      failed.length,
      0,
      `周期矩阵有判据未通过：${failed.map((check) => `${check.id}: ${JSON.stringify(check.detail)}`).join(" | ")}`,
    );
    assert.ok(checks.length >= 40, `判据数过少：${checks.length}`);
    for (const preset of ["today", "quota_5h", "quota_week"]) {
      const entry = evidence.ranges[preset];
      assert.ok(entry.cycles.length >= 3, `${preset} 的确定性周期不足 3 个：${entry.cycles.length}`);
      assert.equal(entry.failures.length, 0, `${preset} 夹具内部失败：${JSON.stringify(entry.failures)}`);
    }
  });

  // 首轮取数失败后必须自愈：循环继续探测（无基线时也探测），且恢复期的同步不做 skipCheck。
  test("U4 failed boot self-heals on the next 60s cycles (no manual refresh needed)", async () => {
    const { checks, observed } = await runRecoveryScenario({});
    const failed = checks.filter((check) => !check.ok);
    assert.equal(
      failed.length,
      0,
      `自愈场景有判据未通过：${failed.map((check) => `${check.id}: ${JSON.stringify(check.detail)}`).join(" | ")}`,
    );
    assert.ok(observed.recoveredSummary === true, `恢复后必须拿到用量数据：${JSON.stringify(observed)}`);
    assert.ok(
      observed.cycles.every((entry) => entry.statusChecks >= 1),
      `恢复期每个周期都要探测来源：${JSON.stringify(observed.cycles.map((entry) => entry.statusChecks))}`,
    );
  });

  test("a failed range reload retries on the next cycle even with unchanged sources", async () => {
    const payloads = await loadRecordedPayloads();
    let failNext = false;
    const month = clone(payloads.today);
    month.summary.range.preset = "month";
    const router = createRouter({
      payloads,
      status: ({ request }) => ({
        payload: {
          fingerprint: payloads.today.fingerprint,
          changed: request.params.since !== payloads.today.fingerprint,
        },
      }),
      usage: ({ request }) => {
        if (failNext) {
          failNext = false;
          return { status: 500, payload: { error: "Worker terminated due to reaching memory limit" } };
        }
        return { payload: request.params.preset === "month" ? month : payloads.today };
      },
    });
    const harness = await createCycleHarness({
      response: router,
      storage: { codexUsageAutoRefresh: "on" },
      initial: { preset: "today" },
    });
    try {
      await harness.settle();
      assert.equal(harness.state.fingerprint, payloads.today.fingerprint);
      harness.state.preset = "month";
      failNext = true;
      await harness.api.loadUsage({ skipCheck: true });
      assert.equal(harness.state.fingerprint, "");
      assert.match(harness.dom.byId.get("autoRefreshError").textContent, /详情/);
      assert.match(harness.dom.byId.get("autoRefreshErrorText").value, /加载失败/);
      harness.dom.byId.get("autoRefreshError").click();
      assert.equal(harness.dom.byId.get("autoRefreshErrorDetails").hidden, false);
      assert.equal(harness.dom.byId.get("autoRefreshError").getAttribute("aria-expanded"), "true");
      harness.dom.byId.get("autoRefreshErrorBack").click();
      assert.equal(harness.dom.byId.get("autoRefreshErrorDetails").hidden, true);
      harness.resetCounts();
      await harness.tick();
      assert.equal(harness.counts.statusChecks, 1);
      assert.equal(harness.counts.usageSyncs, 1);
      assert.equal(harness.state.summary.range.preset, "month");
      assert.equal(harness.state.fingerprint, payloads.today.fingerprint);
      assert.equal(harness.dom.byId.get("autoRefreshError").textContent, "");
      assert.equal(harness.dom.byId.get("autoRefreshErrorDetails").hidden, true);
    } finally {
      harness.dispose();
    }
  });

  for (const supersede of [null, "reload", "pause"]) {
    test(`TPS-only refresh: ${supersede || "slow response"} updates the model while tokens stay equal`, async () => {
      const payloads = await loadRecordedPayloads();
      const withTps = (averageTps, n) => {
        const payload = clone(payloads.today);
        payload.fingerprint = `t1-tps-${averageTps}-${n}`;
        payload.summary.perf = {
          models: [
            {
              key: '["codex","t1-model","high",""]',
              sourceKind: "codex",
              model: "t1-model",
              reasoningEffort: "high",
              modelProvider: "",
              window: "request",
              firstSampleAtMs: Date.parse("2026-10-09T00:00:00.000Z"),
              lastSampleAtMs: Date.parse("2026-10-09T00:00:00.000Z"),
              averageTps,
              p10: averageTps / 2,
              p90: averageTps * 2,
              n,
              state: "ok",
              rankState: "eligible",
              rank: 1,
            },
          ],
        };
        return payload;
      };
      const before = withTps(40, 20);
      const live = withTps(80, 21);
      const replacement = withTps(120, 22);
      replacement.summary.range.preset = supersede === "reload" ? "month" : "today";
      replacement.snapshotId = supersede === "pause" ? "t1-frozen-tps" : null;
      let releaseLive;
      const liveGate = new Promise((resolve) => {
        releaseLive = resolve;
      });
      let refreshing = false;
      const router = createRouter({
        payloads,
        status: () => ({ payload: { changed: true, fingerprint: live.fingerprint } }),
        usage: ({ request }) => {
          if (!refreshing) return { payload: before };
          if (request.params.preset === "month" || request.params.freeze === "1" || request.params.snapshot) {
            return { payload: replacement };
          }
          return liveGate;
        },
      });
      const harness = await createCycleHarness({
        response: router,
        initial: { preset: "today" },
        storage: { codexUsageAutoRefresh: "on" },
      });
      let checking;
      try {
        await harness.settle();
        const models = harness.dom.byId.get("perfModels");
        const total = harness.dom.byId.get("totalTokens");
        const output = harness.dom.byId.get("outputTokens");
        const spinner = harness.dom.byId.get("autoRefreshSpinner");
        const oldHtml = models.innerHTML;
        const oldTokens = [total.textContent, output.textContent];
        assert.match(oldHtml, /<strong>40(?:\.0)?<\/strong>/);
        assert.match(oldHtml, /20 个请求/);
        harness.resetCounts();
        refreshing = true;
        let completed = false;
        checking = harness.api.checkForUpdates().then(() => {
          completed = true;
        });
        await harness.flush();
        assert.equal(harness.pendingFetches, 1);
        assert.equal(completed, false);
        assert.equal(harness.state.autoRefreshCheckInFlight, true);
        assert.equal(spinner.classList.contains("is-loading"), true);
        assert.equal(harness.counts.renders, 0);
        assert.equal(models.innerHTML, oldHtml, "a status change alone must not display the new TPS");
        assert.equal(harness.state.fingerprint, before.fingerprint);
        await harness.tickWhilePending();
        assert.equal(harness.counts.statusChecks, 1, "the next tick must not overlap a slow TPS request");
        assert.equal(harness.counts.usageSyncs, 1);

        if (supersede === "reload") {
          harness.state.preset = "month";
          await harness.api.loadUsage({ skipCheck: true });
        } else if (supersede === "pause") {
          harness.api.setAutoRefreshEnabled(false);
          await harness.flush();
          assert.equal(harness.fetchLog.at(-1).params.freeze, "1");
          assert.equal(harness.state.snapshotId, replacement.snapshotId);
        }
        const currentHtml = models.innerHTML;
        releaseLive({ payload: live });
        await checking;
        await harness.settle();
        const expected = supersede ? replacement : live;
        assert.deepEqual(clone(harness.state.summary.perf), expected.summary.perf);
        assert.deepEqual(clone(harness.state.summary.totals), before.summary.totals);
        assert.deepEqual([total.textContent, output.textContent], oldTokens);
        assert.equal(harness.state.fingerprint, expected.fingerprint);
        assert.equal(harness.state.selectedPerfModelKey, expected.summary.perf.models[0].key);
        assert.match(models.innerHTML, supersede ? /<strong>120(?:\.0)?<\/strong>/ : /<strong>80(?:\.0)?<\/strong>/);
        assert.match(models.innerHTML, supersede ? /22 个请求/ : /21 个请求/);
        assert.notEqual(models.innerHTML, oldHtml, "TPS and n must change even while both token labels stay equal");
        assert.equal(harness.counts.renders, 1);
        assert.equal(spinner.classList.contains("is-loading"), false);
        assert.equal(harness.state.autoRefreshCheckInFlight, false);
        if (supersede) {
          assert.equal(models.innerHTML, currentHtml, "a stale live response must not overwrite the new result");
        }
        if (supersede === "pause") {
          await harness.api.loadUsage({ skipCheck: true });
          assert.equal(harness.fetchLog.at(-1).params.snapshot, replacement.snapshotId);
          assert.equal(models.innerHTML, currentHtml, "subsequent paused reads keep the frozen TPS and n");
          assert.equal(harness.state.autoRefreshEnabled, false);
        }
      } finally {
        releaseLive({ payload: live });
        try {
          await checking;
          await harness.settle();
        } finally {
          harness.dispose();
        }
      }
    });
  }

  for (const supersede of [null, "reload", "pause"]) {
    for (const fail of [false, true]) {
      test(`quota preset correction: ${supersede || "current"}, ${fail ? "failure" : "success"}`, async () => {
        const payloads = await loadRecordedPayloads();
        const invalidQuota = clone(payloads.quota_5h);
        invalidQuota.metadata.homes = [];
        invalidQuota.summary.totals.total = 9_000_000_000;
        const today = clone(payloads.today);
        today.metadata.homes = [];
        today.summary.totals.total = 2_000_000_000;
        const replacement = clone(today);
        replacement.summary.range.preset = supersede === "reload" ? "month" : "today";
        replacement.snapshotId = supersede === "pause" ? "paused-snapshot" : null;
        let releaseCorrection;
        const correctionGate = new Promise((resolve) => {
          releaseCorrection = resolve;
        });
        let releaseReplacement;
        const replacementGate = new Promise((resolve) => {
          releaseReplacement = resolve;
        });
        let correcting = false;
        let followupRequests = 0;
        const router = createRouter({
          payloads,
          status: () => ({ payload: { changed: true, fingerprint: today.fingerprint } }),
          usage: ({ request }) => {
            if (!correcting) return { payload: payloads.quota_5h };
            if (request.params.preset === "quota_5h") return { payload: invalidQuota };
            followupRequests += 1;
            return followupRequests === 1 ? correctionGate : replacementGate;
          },
        });
        const harness = await createCycleHarness({
          response: router,
          initial: { preset: "quota_5h" },
          storage: { codexUsageAutoRefresh: "on" },
        });
        let checking;
        try {
          await harness.settle();
          const spinner = harness.dom.byId.get("autoRefreshSpinner");
          const total = harness.dom.byId.get("totalTokens");
          const before = total.textContent;
          const rendered = [];
          const render = harness.context.render;
          harness.context.render = (...args) => {
            const result = render(...args);
            rendered.push({
              preset: harness.state.summary.range.preset,
              busy: spinner.classList.contains("is-loading"),
              tokens: total.textContent,
            });
            return result;
          };
          harness.resetCounts();
          correcting = true;
          let completed = false;
          checking = harness.api.checkForUpdates().then(() => {
            completed = true;
          });
          await harness.flush();
          assert.equal(harness.state.preset, "today");
          assert.equal(harness.counts.usageSyncs, 2);
          assert.equal(harness.counts.skipCheckSyncs, 1);
          assert.equal(harness.pendingFetches, 1);
          assert.equal(completed, false, "the check must await the corrected request");
          assert.equal(spinner.classList.contains("is-loading"), true);
          assert.equal(harness.counts.renders, 0, "the mismatched quota payload must not render");
          assert.equal(total.textContent, before);

          if (supersede === "reload") {
            harness.state.preset = "month";
            void harness.api.loadUsage({ skipCheck: true });
          } else if (supersede === "pause") {
            harness.api.setAutoRefreshEnabled(false);
            assert.equal(spinner.classList.contains("is-loading"), false);
            assert.equal(harness.fetchLog.at(-1).params.freeze, "1");
          }
          releaseCorrection(
            fail ? { status: 500, payload: { error: "corrected request failed" } } : { payload: today },
          );
          await checking;

          if (supersede) {
            assert.equal(harness.pendingFetches, 1);
            assert.equal(harness.counts.renders, 0, "stale success must not render");
            assert.equal(harness.counts.statusErrors, 0, "stale failure must not replace the current status");
            assert.equal(spinner.classList.contains("is-loading"), supersede === "reload");
            assert.equal(total.textContent, before);
            releaseReplacement({ payload: replacement });
            await harness.settle();
          } else if (fail) {
            assert.equal(harness.state.fingerprint, "", "the next cycle must retry the failed range");
            assert.equal(harness.counts.statusErrors, 1);
            assert.match(harness.dom.byId.get("autoRefreshErrorText").value, /corrected request failed/);
            assert.equal(harness.counts.renders, 0);
            assert.equal(total.textContent, before);
          }
          assert.equal(spinner.classList.contains("is-loading"), false);
          if (supersede || !fail) {
            assert.deepEqual(rendered, [
              {
                preset: supersede === "reload" ? "month" : "today",
                busy: supersede !== "pause",
                tokens: total.textContent,
              },
            ]);
            assert.notEqual(total.textContent, before, "the corrected tokens must be visible");
            assert.equal(harness.state.summary.totals.total, today.summary.totals.total);
            assert.equal(harness.counts.statusErrors, 0);
          }
          assert.equal(harness.state.autoRefreshCheckInFlight, false);
        } finally {
          releaseCorrection({ payload: today });
          releaseReplacement({ payload: replacement });
          await checking;
          await harness.settle();
          harness.dispose();
        }
      });
    }
  }

  if (REAL_CYCLE) {
    test("U4 real 60s cycle: the product's own interval actually probes once per period", async () => {
      const payloads = await loadRecordedPayloads();
      const startedAt = new Date().toISOString();
      const router = createRouter({
        payloads,
        status: () => ({
          payload: { fingerprint: payloads.today.fingerprint, changed: false, checkedAt: new Date().toISOString() },
        }),
        usage: () => ({ payload: payloads.today }),
      });
      const harness = await createCycleHarness({
        response: router,
        realTimers: true,
        storage: { codexUsageAutoRefresh: "on" },
      });
      await harness.settle();
      const interval = harness.timers.entries.find((entry) => entry.ms === EXPECTED_INTERVAL_MS);
      assert.ok(interval, "真实档必须注册一个 60000ms 周期");
      harness.resetCounts();
      const before = harness.fetchLog.length;
      await new Promise((resolve) => setTimeout(resolve, 61_000));
      const observed = harness.countsSnapshot();
      const finishedAt = new Date().toISOString();
      const cycles = harness.fetchLog.slice(before);
      const realFires = interval.calls;
      harness.dispose();
      assert.equal(realFires, 1, `真实定时器在 61 秒里应恰好触发一次 60 秒周期，实测 ${realFires}`);
      assert.equal(observed.statusChecks, 1, `真实周期应恰好探测一次来源，实测 ${observed.statusChecks}`);
      assert.equal(observed.skipCheckSyncs, 0, "真实周期不得用 skipCheck");
      assert.equal(cycles.filter((entry) => entry.path === "/api/status").length, 1);
      const [first] = cycles;
      assert.ok(
        Date.parse(finishedAt) - Date.parse(startedAt) >= 60_000,
        `真实周期必须真的等满 60 秒（实测 ${Date.parse(finishedAt) - Date.parse(startedAt)}ms）`,
      );
      assert.ok(first.at >= startedAt, `周期时刻 ${first.at} 应落在 ${startedAt} 之后`);
      process.stdout.write(
        `U4 real-60s-cycle: startedAt=${startedAt} finishedAt=${finishedAt} realFires=${realFires} statusChecks=${observed.statusChecks} usageSyncs=${observed.usageSyncs} skipCheck=${observed.skipCheckSyncs} firstProbeAt=${first.at}\n`,
      );
    });
  }
}

// 供 U4 脚本复用（HARNESS_ONLY 下也导出）
export { APP_PATH, INDEX_PATH, REPO_ROOT, RESPONSES_DIR, FIXTURE_FILES, WRAPPED, emptyCounts };
