/**
 * 临时工具：皮肤配色工作台（palette studio）。
 *
 * 用途：给十套角色皮肤逐套试配色。填四个源色 → 按「最浅作浅色底、最深作深色底」
 * 的默认规则推导 12 个配色 token → 在右侧 iframe 里给真实首页注入同名 CSS 变量
 * 实时预览 → 逐项微调 → 导出可粘贴进 public/skin-palettes.js 的代码。
 *
 * 边界（刻意保持）：
 * - 不被 index.html 引用、不进静态导出快照、不被任何测试或主应用加载；配色定稿
 *   后本文件与 skin-palette-studio.html 可整体删除。
 * - 只通过同源 iframe 注入样式来预览，不修改主应用的任何文件与构建链。
 * - 预览映射不再自算（M1.5 退役旧草案式）：候选 token 经 M1.1 共享接口
 *   derivePaletteDeclarationsFromTokens 派生 20 项变量，与正式皮肤、首屏 bootstrap
 *   完全同源；注入前清除同一份 PALETTE_CSS_VAR_NAMES，不留旧值。「四源色生成草稿」
 *   保留为旧快速草稿，其算法不作求解器、不作门禁依据。导出里仍只有 12 个 token。
 * - 打开期间 iframe 会临时改动同源的皮肤/主题偏好；页面关闭时恢复打开前的值。
 */

import { PALETTE_CSS_VAR_NAMES, PALETTE_TOKEN_KEYS, SKINS, derivePaletteDeclarationsFromTokens } from "./skins.js";
import { SKIN_PALETTES } from "./skin-palettes.js";

const STORAGE_KEY = "codexUsageSkinPaletteStudioV1";
const MODES = ["light", "dark"];
const CHARACTER_SKINS = SKINS.filter((skin) => !skin.isClassic);
const DEEPSEEK_EXAMPLE = ["#4F4971", "#5E5C84", "#7178A9", "#F9F4F6"];
const DEFAULT_DRAFT_COLORS = ["#1f2933", "#607080", "#9fb2c4", "#dfe4e9"];
const SOURCE_RANKS = ["最深", "次深", "次浅", "最浅"];
const PREVIEW_SIZES = {
  "1440x900": [1440, 900],
  "1024x768": [1024, 768],
  "768x1024": [768, 1024],
  "390x844": [390, 844],
};
const ZOOMS = [45, 55, 70, 85, 100];

const TOKEN_LABELS = {
  pageBackground: "页面基底",
  panelBackground: "面板底",
  panelBorder: "面板描边",
  panelHighlight: "面板高光",
  panelShadow: "面板阴影",
  textPrimary: "主文字",
  textSecondary: "次要文字",
  accent: "强调色",
  controlBackground: "控件底",
  controlBorder: "控件描边",
  controlText: "控件文字",
  chartText: "图表文字",
};

/** Mirrors scripts/check-skin-palettes.mjs — only real colours may be stored. */
const COLOUR_RE =
  /^(#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^)]*\)|transparent|currentcolor|inherit|initial|unset|revert)$/i;

// ---------------------------------------------------------------------------
// Colour math (zero-dependency; hex and rgb()/rgba() cover the studio needs)
// ---------------------------------------------------------------------------

function parseColor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  let match = /^#([0-9a-f]{3,8})$/.exec(text);
  if (match) {
    let hex = match[1];
    if (hex.length <= 4) hex = [...hex].map((ch) => ch + ch).join("");
    return {
      rgb: [0, 2, 4].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)),
      alpha: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }
  match = /^rgba?\(([^)]+)\)$/.exec(text);
  if (match) {
    const parts = match[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const rgb = parts.slice(0, 3).map((part) => {
      const number = Number.parseFloat(part);
      if (!Number.isFinite(number)) return NaN;
      return Math.min(255, Math.max(0, Math.round(number * (part.includes("%") ? 2.55 : 1))));
    });
    if (rgb.some((n) => !Number.isFinite(n))) return null;
    const alpha = parts[3] === undefined ? 1 : Math.min(1, Math.max(0, Number.parseFloat(parts[3])));
    return { rgb, alpha: Number.isFinite(alpha) ? alpha : 1 };
  }
  return null;
}

function rgbToHex(rgb) {
  return `#${rgb
    .map((n) =>
      Math.min(255, Math.max(0, Math.round(n)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function relativeLuminance(rgb) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function luminanceOf(value) {
  const parsed = parseColor(value);
  return parsed ? relativeLuminance(parsed.rgb) : 0;
}

/** Linear mix of a toward b by t; returns hex, or null when unparseable. */
function mixColors(a, b, t) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return null;
  return rgbToHex(ca.rgb.map((v, i) => v + (cb.rgb[i] - v) * t));
}

function contrastRatio(a, b) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return null;
  const la = relativeLuminance(ca.rgb);
  const lb = relativeLuminance(cb.rgb);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

function saturationOf(value) {
  const parsed = parseColor(value);
  if (!parsed) return 0;
  const [r, g, b] = parsed.rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 2;
  return (max - min) / (1 - Math.abs(2 * l - 1));
}

// ---------------------------------------------------------------------------
// Default derivation: the old quick draft (kept; not the M2 solver, not a gate)
// ---------------------------------------------------------------------------

/** The more saturated of the two middle colours; a near tie goes to the lighter. */
function pickAccentBase(sorted) {
  const [, c2, c3] = sorted;
  return saturationOf(c3) - saturationOf(c2) >= -0.02 ? c3 : c2;
}

function sortSources(colors) {
  return colors.slice().sort((a, b) => luminanceOf(a) - luminanceOf(b));
}

function deriveTokens(colors, mode) {
  if (colors.some((value) => !parseColor(value))) return null;
  const [c1, c2, c3, c4] = sortSources(colors);
  const accentBase = pickAccentBase([c1, c2, c3, c4]);
  if (mode === "light") {
    const panelBackground = mixColors(c4, "#ffffff", 0.5);
    return {
      pageBackground: c4,
      panelBackground,
      panelBorder: mixColors(c2, c4, 0.35),
      panelHighlight: mixColors(panelBackground, "#ffffff", 0.65),
      panelShadow: mixColors(c1, c4, 0.3),
      textPrimary: c1,
      textSecondary: mixColors(c1, c4, 0.45),
      accent: accentBase,
      controlBackground: panelBackground,
      controlBorder: mixColors(c2, c4, 0.35),
      controlText: c1,
      chartText: mixColors(c1, c4, 0.45),
    };
  }
  const panelBackground = mixColors(c1, c2, 0.45);
  return {
    pageBackground: c1,
    panelBackground,
    panelBorder: mixColors(c1, c3, 0.35),
    panelHighlight: mixColors(c3, c1, 0.35),
    panelShadow: mixColors("#000000", c1, 0.25),
    textPrimary: c4,
    textSecondary: mixColors(c4, c1, 0.45),
    accent: mixColors(accentBase, "#ffffff", 0.12),
    controlBackground: panelBackground,
    controlBorder: mixColors(c1, c3, 0.35),
    controlText: c4,
    chartText: mixColors(c4, c1, 0.45),
  };
}

function sourceTags(colors, mode) {
  const [c1, c2, c3, c4] = sortSources(colors);
  const accentBase = pickAccentBase([c1, c2, c3, c4]);
  const accentTag = accentBase === c2 ? "次深色" : "次浅色";
  if (mode === "light") {
    return {
      pageBackground: "最浅色",
      panelBackground: "推导",
      panelBorder: "推导",
      panelHighlight: "推导",
      panelShadow: "推导",
      textPrimary: "最深色",
      textSecondary: "推导",
      accent: accentTag,
      controlBackground: "同面板底",
      controlBorder: "同面板描边",
      controlText: "同主文字",
      chartText: "同次要文字",
    };
  }
  return {
    pageBackground: "最深色",
    panelBackground: "推导",
    panelBorder: "推导",
    panelHighlight: "推导",
    panelShadow: "推导",
    textPrimary: "最浅色",
    textSecondary: "推导",
    accent: `${accentTag}+提亮`,
    controlBackground: "同面板底",
    controlBorder: "同面板描边",
    controlText: "同主文字",
    chartText: "同次要文字",
  };
}

// ---------------------------------------------------------------------------
// State and drafts
// ---------------------------------------------------------------------------

const state = { activeSkinId: "deepseek", activeMode: "light", drafts: {} };
/** Keeps the last valid derivation so a half-typed source colour pauses, not breaks. */
const lastGoodDerived = { light: null, dark: null };

function ensureDraft(skinId) {
  let draft = state.drafts[skinId];
  if (!draft || !Array.isArray(draft.colors) || draft.colors.length !== 4) {
    draft = {
      colors: skinId === "deepseek" ? [...DEEPSEEK_EXAMPLE] : [...DEFAULT_DRAFT_COLORS],
      overrides: { light: {}, dark: {} },
    };
    state.drafts[skinId] = draft;
  }
  if (!draft.overrides || typeof draft.overrides !== "object") draft.overrides = {};
  for (const mode of MODES) {
    if (!draft.overrides[mode] || typeof draft.overrides[mode] !== "object") draft.overrides[mode] = {};
  }
  return draft;
}

function saveState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        activeSkinId: state.activeSkinId,
        activeMode: state.activeMode,
        drafts: state.drafts,
      }),
    );
  } catch {
    // Storage can be blocked; the studio still works without persistence.
  }
}

function loadState() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return;
  }
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    if (CHARACTER_SKINS.some((skin) => skin.id === parsed.activeSkinId)) state.activeSkinId = parsed.activeSkinId;
    if (parsed.activeMode === "dark") state.activeMode = "dark";
    if (parsed.drafts && typeof parsed.drafts === "object") state.drafts = parsed.drafts;
  } catch {
    // A corrupt draft is treated as absent; defaults apply.
  }
}

function derivedTokens(mode) {
  const derived = deriveTokens(ensureDraft(state.activeSkinId).colors, mode);
  if (derived) lastGoodDerived[mode] = derived;
  return derived || lastGoodDerived[mode];
}

function resolvedTokens(mode) {
  const derived = derivedTokens(mode);
  if (!derived) return null;
  const overrides = ensureDraft(state.activeSkinId).overrides[mode] || {};
  const tokens = {};
  for (const key of PALETTE_TOKEN_KEYS) tokens[key] = overrides[key] ?? derived[key] ?? null;
  return tokens;
}

// ---------------------------------------------------------------------------
// Preview: inject palette variables into the real dashboard iframe
// ---------------------------------------------------------------------------

function previewDeclarationPairs(tokens, mode) {
  // M1.5：预览映射退役本工具自算的陶瓷/active-ink/hover/阴影草案式，一律经 M1.1
  // 共享接口派生——与正式皮肤、首屏 bootstrap 完全同源。token 无有效值时返回空，
  // assertInline 随即把 20 项变量清干净，不残留上一轮候选或当前皮肤的值。
  return derivePaletteDeclarationsFromTokens(tokens, mode) ?? [];
}

function buildSheet() {
  const blocks = [];
  for (const mode of MODES) {
    const tokens = resolvedTokens(mode);
    if (!tokens) continue;
    const pairs = previewDeclarationPairs(tokens, mode);
    if (!pairs.length) continue;
    const body = pairs.map(([name, value]) => `  ${name}: ${value};`).join("\n");
    // The light block first, dark second: in dark mode both match the root and
    // the later declaration wins — the same ordering trick styles.css itself uses.
    blocks.push(mode === "light" ? `:root {\n${body}\n}` : `[data-theme="dark"] {\n${body}\n}`);
  }
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function buildExportText() {
  const lines = [];
  const bodies = [];
  for (const mode of MODES) {
    const tokens = resolvedTokens(mode);
    if (!tokens) continue;
    const entries = PALETTE_TOKEN_KEYS.filter((key) => tokens[key]).map((key) => `      ${key}: "${tokens[key]}",`);
    if (!entries.length) continue;
    bodies.push(`    ${mode}: {\n${entries.join("\n")}\n    },`);
  }
  if (!bodies.length) return "";
  const sorted = sortSources(ensureDraft(state.activeSkinId).colors);
  lines.push(`  ${state.activeSkinId}: {`);
  lines.push(`    // 源四色（深→浅）：${sorted.join(" ")}`);
  lines.push(bodies.join("\n"));
  lines.push("  },");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// DOM wiring
// ---------------------------------------------------------------------------

const frame = document.getElementById("studioFrame");
const sizer = document.getElementById("studioFrameSizer");
const holder = document.getElementById("studioFrameHolder");
const chipsHost = document.getElementById("studioSkinChips");
const slotsHost = document.getElementById("studioSourceSlots");
const rowsHost = document.getElementById("studioTokenRows");
const tabsHost = document.getElementById("studioModeTabs");
const fileState = document.getElementById("studioFileState");
const contrastHost = document.getElementById("studioContrast");
const sourceWarning = document.getElementById("studioSourceWarning");
const output = document.getElementById("studioOutput");
const exportSkinLabel = document.getElementById("studioExportSkin");

let chipRefs = [];
let sourceRefs = [];
let rowRefs = [];

const preview = {
  ready: false,
  observer: null,
  observerDoc: null,
  accents: { light: null, dark: null },
  inlineVars: { light: [], dark: [] },
  boot: { theme: null, skin: null },
  init() {
    try {
      this.boot.theme = localStorage.getItem("codexUsageTheme");
      this.boot.skin = localStorage.getItem("codexUsageSkinV1");
    } catch {
      // Preference restore is best-effort only.
    }
    window.addEventListener("pagehide", () => this.restorePrefs());
    frame.addEventListener("load", () => {
      this.onLoad();
    });
  },
  restorePrefs() {
    try {
      if (this.boot.theme === null) localStorage.removeItem("codexUsageTheme");
      else localStorage.setItem("codexUsageTheme", this.boot.theme);
      if (this.boot.skin === null) localStorage.removeItem("codexUsageSkinV1");
      else localStorage.setItem("codexUsageSkinV1", this.boot.skin);
    } catch {
      // Best effort.
    }
  },
  async onLoad() {
    this.ready = false;
    const hook = await this.waitForHook();
    if (!hook) return;
    hook.selectSkin(state.activeSkinId);
    await this.syncTheme();
    this.inject();
    this.ready = true;
  },
  waitForHook() {
    const deadline = Date.now() + 10000;
    return new Promise((resolve) => {
      const tick = () => {
        const hook = frame.contentWindow?.__skinTestHook;
        if (hook) return resolve(hook);
        if (Date.now() > deadline) return resolve(null);
        setTimeout(tick, 120);
      };
      tick();
    });
  },
  async syncTheme() {
    const doc = frame.contentDocument;
    if (!doc) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if ((doc.documentElement.dataset.theme || "light") === state.activeMode) return;
      doc.getElementById("themeToggle")?.click();
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  },
  inject() {
    const doc = frame.contentDocument;
    if (!doc) return;
    let style = doc.getElementById("studioPaletteSheet");
    if (!style) {
      style = doc.createElement("style");
      style.id = "studioPaletteSheet";
      doc.head.appendChild(style);
    }
    style.textContent = buildSheet();
    for (const mode of MODES) {
      const tokens = resolvedTokens(mode);
      this.accents[mode] = tokens?.accent || null;
      this.inlineVars[mode] = tokens ? previewDeclarationPairs(tokens, mode) : [];
    }
    // Inline beats any stylesheet: the wired app now writes its own palette
    // variables inline on <html> (skin-ui apply), so the studio's candidate
    // values must play on the same layer. The observer re-asserts every inline
    // variable after each app write; the equality guard prevents loops.
    this.assertInline(doc);
    // An iframe reload replaces the document, so the observer must re-attach to
    // the live one; comparing the document reference handles exactly that.
    if (this.observerDoc !== doc) {
      this.observer?.disconnect();
      this.observer = new MutationObserver(() => {
        this.assertInline(frame.contentDocument);
      });
      this.observer.observe(doc.documentElement, { attributes: true, attributeFilter: ["style"] });
      this.observerDoc = doc;
    }
  },
  assertInline(doc) {
    if (!doc) return;
    const root = doc.documentElement;
    const pairs = this.inlineVars[state.activeMode] ?? [];
    const applied = new Set(pairs.map(([name]) => name));
    // 注入前清除同一份 PALETTE_CSS_VAR_NAMES（M1.5）：候选未覆盖的名字不得残留
    // 上一次候选或当前皮肤的 inline 值。只在出现差异时写——等值护栏保证下面的
    // MutationObserver 不会自激循环。
    for (const name of PALETTE_CSS_VAR_NAMES) {
      if (!applied.has(name) && root.style.getPropertyValue(name) !== "") {
        root.style.removeProperty(name);
      }
    }
    for (const [name, value] of pairs) {
      if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
    }
  },
  refresh() {
    if (this.ready) this.inject();
  },
  selectSkin(skinId) {
    frame.contentWindow?.__skinTestHook?.selectSkin(skinId);
  },
  async setMode(mode) {
    state.activeMode = mode;
    await this.syncTheme();
    this.refresh();
  },
};

function buildChips() {
  chipsHost.textContent = "";
  chipRefs = CHARACTER_SKINS.map((skin) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "studio-chip";
    chip.textContent = skin.name;
    chip.dataset.skinId = skin.id;
    chip.setAttribute("aria-pressed", "false");
    chip.addEventListener("click", () => {
      state.activeSkinId = skin.id;
      ensureDraft(skin.id);
      saveState();
      renderAll();
      preview.selectSkin(skin.id);
    });
    chipsHost.append(chip);
    return chip;
  });
}

function buildSourceSlots() {
  slotsHost.textContent = "";
  sourceRefs = [0, 1, 2, 3].map((index) => {
    const slot = document.createElement("label");
    slot.className = "studio-source-slot";
    const color = document.createElement("input");
    color.type = "color";
    const text = document.createElement("input");
    text.type = "text";
    text.className = "studio-hex";
    text.spellcheck = false;
    const rank = document.createElement("span");
    rank.className = "studio-source-rank";
    color.addEventListener("input", () => setSourceColor(index, color.value));
    text.addEventListener("change", () => setSourceColor(index, text.value));
    slot.append(color, text, rank);
    slotsHost.append(slot);
    return { index, color, text, rank };
  });
}

function buildTokenRows() {
  rowsHost.textContent = "";
  rowRefs = PALETTE_TOKEN_KEYS.map((key) => {
    const row = document.createElement("div");
    row.className = "studio-token-row";
    row.dataset.token = key;
    const color = document.createElement("input");
    color.type = "color";
    const name = document.createElement("span");
    name.className = "studio-token-name";
    name.textContent = TOKEN_LABELS[key] || key;
    name.title = key;
    const text = document.createElement("input");
    text.type = "text";
    text.className = "studio-token-hex";
    text.spellcheck = false;
    text.placeholder = "颜色";
    const tag = document.createElement("span");
    tag.className = "studio-token-tag";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "studio-token-reset";
    reset.textContent = "↺";
    reset.title = "恢复推导值";
    reset.hidden = true;
    reset.addEventListener("click", () => {
      delete ensureDraft(state.activeSkinId).overrides[state.activeMode][key];
      saveState();
      renderAll();
    });
    color.addEventListener("input", () => setTokenOverride(key, color.value));
    text.addEventListener("change", () => setTokenOverride(key, text.value));
    row.append(color, name, text, tag, reset);
    rowsHost.append(row);
    return { key, row, color, text, tag, reset };
  });
}

function setSourceColor(index, raw) {
  const draft = ensureDraft(state.activeSkinId);
  draft.colors[index] = String(raw ?? "").trim();
  saveState();
  renderAll();
}

function setTokenOverride(key, raw) {
  const value = String(raw ?? "").trim();
  if (!COLOUR_RE.test(value)) {
    // Invalid text is never stored; the row keeps its previous value.
    renderTokenRowStates();
    return;
  }
  const draft = ensureDraft(state.activeSkinId);
  const derived = derivedTokens(state.activeMode);
  if (derived?.[key] && value.toLowerCase() === String(derived[key]).toLowerCase()) {
    delete draft.overrides[state.activeMode][key];
  } else {
    draft.overrides[state.activeMode][key] = value;
  }
  saveState();
  renderAll();
}

function renderChips() {
  for (const chip of chipRefs) chip.setAttribute("aria-pressed", String(chip.dataset.skinId === state.activeSkinId));
}

function renderTabs() {
  for (const tab of tabsHost.querySelectorAll(".studio-tab")) {
    tab.setAttribute("aria-pressed", String(tab.dataset.mode === state.activeMode));
  }
}

function renderSources() {
  const draft = ensureDraft(state.activeSkinId);
  const sorted = sortSources(draft.colors);
  for (const ref of sourceRefs) {
    const value = draft.colors[ref.index] ?? "";
    const parsed = parseColor(value);
    ref.color.value = parsed ? rgbToHex(parsed.rgb) : "#000000";
    if (document.activeElement !== ref.text) ref.text.value = value;
    const rankIndex = sorted.indexOf(draft.colors[ref.index]);
    ref.rank.textContent = parsed && rankIndex >= 0 ? SOURCE_RANKS[rankIndex] : "待有效色";
    ref.text.classList.toggle("is-invalid", Boolean(value) && !parsed);
  }
  sourceWarning.hidden = draft.colors.every((value) => parseColor(value));
}

function renderTokenRowStates() {
  const draft = ensureDraft(state.activeSkinId);
  const tokens = resolvedTokens(state.activeMode);
  const tags = sourceTags(draft.colors, state.activeMode);
  for (const ref of rowRefs) {
    const value = tokens?.[ref.key] ?? "";
    const overridden = Boolean(draft.overrides[state.activeMode][ref.key]);
    ref.row.classList.toggle("is-overridden", overridden);
    ref.reset.hidden = !overridden;
    ref.tag.textContent = overridden ? "手改" : tags[ref.key] || "";
    const parsed = parseColor(value);
    if (document.activeElement !== ref.color && parsed) ref.color.value = rgbToHex(parsed.rgb);
    if (document.activeElement !== ref.text) ref.text.value = value;
    ref.text.classList.toggle("is-invalid", Boolean(value) && !COLOUR_RE.test(value));
  }
}

function renderContrast() {
  const notes = [];
  for (const mode of MODES) {
    const tokens = resolvedTokens(mode);
    if (!tokens) continue;
    const background = tokens.panelBackground || tokens.pageBackground;
    for (const key of ["textPrimary", "textSecondary"]) {
      const ratio = contrastRatio(tokens[key], background);
      if (ratio !== null && ratio < 3) {
        notes.push(
          `${mode === "light" ? "浅色" : "深色"}：${TOKEN_LABELS[key]} 对面板底 ${ratio.toFixed(2)}:1（低于 3:1）`,
        );
      }
    }
  }
  contrastHost.hidden = !notes.length;
  contrastHost.textContent = notes.join("；");
}

function renderFileState() {
  const entry = SKIN_PALETTES[state.activeSkinId];
  const count = (mode) => {
    if (!entry || typeof entry[mode] !== "object" || entry[mode] === null) return 0;
    return Object.keys(entry[mode]).filter((key) => PALETTE_TOKEN_KEYS.includes(key) || key === "chartSeries").length;
  };
  const light = count("light");
  const dark = count("dark");
  fileState.textContent = `skin-palettes.js 当前：浅色 ${light ? `${light} 项` : "待定"} / 深色 ${dark ? `${dark} 项` : "待定"}`;
}

function renderExport() {
  exportSkinLabel.textContent = state.activeSkinId;
  output.value = buildExportText();
}

function renderAll() {
  renderChips();
  renderTabs();
  renderSources();
  renderTokenRowStates();
  renderContrast();
  renderFileState();
  renderExport();
  preview.refresh();
}

function applyPreviewGeometry() {
  const [width, height] = PREVIEW_SIZES[document.getElementById("studioViewport").value] || PREVIEW_SIZES["1440x900"];
  const zoom = Number.parseInt(document.getElementById("studioZoom").value, 10) / 100;
  frame.style.width = `${width}px`;
  frame.style.height = `${height}px`;
  frame.style.transform = `scale(${zoom})`;
  sizer.style.width = `${Math.round(width * zoom)}px`;
  sizer.style.height = `${Math.round(height * zoom)}px`;
}

/** Auto-fit zoom once at start (and on viewport change); afterwards it is manual. */
function autoZoom() {
  const [width] = PREVIEW_SIZES[document.getElementById("studioViewport").value];
  const available = Math.max(200, holder.clientWidth - 26);
  const fit = ZOOMS.findLast((z) => z / 100 <= available / width) || ZOOMS[0];
  document.getElementById("studioZoom").value = String(fit);
  applyPreviewGeometry();
}

function flash(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

document.getElementById("studioRederive").addEventListener("click", () => {
  ensureDraft(state.activeSkinId).overrides = { light: {}, dark: {} };
  saveState();
  renderAll();
});

document.getElementById("studioClearDraft").addEventListener("click", () => {
  delete state.drafts[state.activeSkinId];
  ensureDraft(state.activeSkinId);
  saveState();
  renderAll();
});

for (const tab of tabsHost.querySelectorAll(".studio-tab")) {
  tab.addEventListener("click", () => {
    state.activeMode = tab.dataset.mode;
    saveState();
    renderAll();
    preview.setMode(tab.dataset.mode);
  });
}

document.getElementById("studioViewport").addEventListener("change", () => {
  autoZoom();
});

document.getElementById("studioZoom").addEventListener("change", () => {
  applyPreviewGeometry();
});

document.getElementById("studioCopy").addEventListener("click", async () => {
  const button = document.getElementById("studioCopy");
  try {
    await navigator.clipboard.writeText(output.value);
    flash(button, "已复制");
  } catch {
    output.select();
    document.execCommand("copy");
    flash(button, "已复制");
  }
});

loadState();
ensureDraft(state.activeSkinId);
buildChips();
buildSourceSlots();
buildTokenRows();
renderAll();
preview.init();
applyPreviewGeometry();
autoZoom();

if (!location.protocol.startsWith("http")) {
  document.getElementById("studioProtocolWarning").hidden = false;
}

/** Introspection for browser-driven audits; deliberately plain, like the app hook. */
window.__studioPaletteTestHook = {
  state,
  deriveTokens,
  resolvedTokens,
  buildSheet,
  buildExportText,
  ensureDraft,
};
