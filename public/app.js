import {
  buildTimelineRows,
  deriveTimelineBucket,
  MAX_TIMELINE_SLOTS,
  RECENT_SELECTIONS,
  resolveNamedRecentRange,
  hasSelectedCodexSource,
  quotaRecordsForRange,
  quotaRecordValues,
} from "./timeline-utils.js";
import {
  canonicalRecentValue,
  displayRecentValue,
  formatLocalDateTime,
  getLocale,
  initializeLocale,
  localizeQuotaReason,
  localizeServerError,
  localizeText,
  setLocale,
  translatePage,
} from "./i18n.js";
import { buildUsagePricingCoverage, resolvePricingModel } from "./pricing-models.js";
import { state } from "./app-state.js";
import { escapeHtml, externalHttpUrl, safeChartColor } from "./html-utils.js";
import {
  dateKey,
  datePickerMonthModel,
  monthStart,
  parseLocalDate,
  renderDatePickerHtml,
  selectDateRange,
} from "./calendar.js";
import { summarizePeriodComparison } from "./period-comparison.js";

export { datePickerMonthModel, renderDatePickerHtml };

if (typeof document !== "undefined" && document.body) initializeLocale();
state.locale = getLocale();
let quotaNoticeTimer = null;
let importDialogOpener = null;

const AUTO_REFRESH_INTERVAL_MS = 60_000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const QUOTA_PRESETS = ["quota_5h", "quota_week"];
const QUOTA_MODE_LABELS = Object.freeze({ quota_5h: "5 小时限额", quota_week: "本周限额" });
// 与服务端限额观察的来源清单一致：这些 kind 的目录才计入 Codex 限额窗口。
const CODEX_HOME_KINDS = new Set(["main", "jetbrains", "extra", "codex"]);
const QUOTA_UI_COPY = Object.freeze({
  unavailable: "此限额窗口当前不可用。",
  missingSnapshot: "尚无限额快照，请等待 Codex 写入限额记录。",
  staticMissingSnapshot: "此静态快照未包含限额元数据，请重新导出。",
  waiting: "等待新的限额记录。",
  invalidBoundaries: "导出中的限额窗口边界无效。",
  halfHourSlot: "每个图表时间槽是半小时。",
  weekSlot: "每个图表时间槽是连续 24 小时，不按本地自然日或夏令时拆分。",
  asOf: "统计数据截至",
  partialSlot: "当前时间槽仅统计至",
});
const THEME_STORAGE_KEY = "codexUsageTheme";
const AUTO_REFRESH_STORAGE_KEY = "codexUsageAutoRefresh";
const EXCLUDED_HOMES_STORAGE_KEY = "codexUsageExcludedHomes";
const formatter = new Intl.NumberFormat("en-US");
const millionTokenFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const cnyFormatter = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const compactFormatter = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 2,
});
const tooltipRows = new WeakMap();
const timelineBars = new WeakMap();
const timelineFocusIndex = new WeakMap();

const $ = (selector) => document.querySelector(selector);

function preferredTheme() {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "light" || saved === "dark") {
      return saved;
    }
  } catch {
    // Ignore storage failures in restricted contexts.
  }
  return "light";
}

function updateThemeButtons() {
  const button = $("#themeToggle");
  if (!button) return;
  const isDark = state.theme === "dark";
  button.classList.toggle("active", isDark);
  button.setAttribute("aria-pressed", String(isDark));
  button.setAttribute("aria-label", isDark ? "当前深色主题，点击切换到浅色主题" : "当前浅色主题，点击切换到深色主题");
}

function updateLanguageButton() {
  const button = $("#languageToggle");
  if (!button) return;
  const english = getLocale() === "en-US";
  button.classList.toggle("active", english);
  button.setAttribute("aria-pressed", String(english));
  button.setAttribute("aria-label", english ? "English interface. Switch to Chinese" : "当前中文界面，点击切换到英文");
  button.title = english ? "Switch to Chinese" : "切换到 English";
  button.querySelector("[data-language='zh-CN']")?.classList.toggle("is-selected", !english);
  button.querySelector("[data-language='en-US']")?.classList.toggle("is-selected", english);
}

function setLanguage(locale) {
  state.locale = setLocale(locale);
  updateLanguageButton();
  updateThemeButtons();
  updateCalendarZoneSelect();
  updateRecentControls();
  updateDateRangeControl();
  renderAutoRefreshControls();
  if (state.datePickerField) renderDatePicker(state.datePickerField);
  if (!$("#pricingDialog")?.hidden) renderPricingModelList();
  if (!$("#pricingDialog")?.hidden) renderAutomaticPricingStatus(state.pricingCatalog?.automatic);
  render();
  translatePage();
}

function setTheme(theme, { persist = true } = {}) {
  state.theme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme;
  if (persist) {
    try {
      localStorage.setItem(THEME_STORAGE_KEY, state.theme);
    } catch {
      // Ignore storage failures in restricted contexts.
    }
  }
  updateThemeButtons();
  render();
}

function isStaticSnapshot() {
  return Boolean(window.__CODEX_USAGE_REPORT__);
}

function usageValue(usage, field = "total") {
  return usage?.[field] || 0;
}

function formatTokens(value) {
  return formatter.format(Math.round(value || 0));
}

function setMetric(selector, value) {
  const element = $(selector);
  if (!element) return;
  const formatted = formatTokens(value);
  element.textContent = formatted;
  element.title = formatted;
}

function setTokenMetric(selector, value) {
  const element = $(selector);
  if (!element) return;
  element.textContent = formatTokenMillions(value);
  element.title = formatTokens(value);
}

const MIN_METRIC_FONT_PX = 11;

// 只缩不涨的字号适配：文本超出容器宽度时逐级缩小，直到放下或触及下限。
// 不设下限以上的目标字号，保证最大字号就是 CSS 里的默认值（与 tokens 行一致）。
export function fitTextToWidth(element, { minFontSize = MIN_METRIC_FONT_PX } = {}) {
  if (!element || typeof element.clientWidth !== "number") return;
  element.style.fontSize = "";
  const available = element.clientWidth;
  if (!available || element.scrollWidth <= available) return;
  const baseSize = parseFloat(getComputedStyle(element).fontSize) || 22;
  let size = baseSize;
  while (size > minFontSize) {
    size = Math.max(minFontSize, size - 1);
    element.style.fontSize = `${size}px`;
    if (element.scrollWidth <= available) return;
  }
}

function setCurrencyMetric(selector, usd, cny = null) {
  const element = $(selector);
  if (!element) return;
  const hasUsd = usd !== null && usd !== undefined && Number.isFinite(Number(usd));
  const hasCny = cny !== null && cny !== undefined && Number.isFinite(Number(cny));
  if (!hasUsd && !hasCny) {
    element.textContent = "—";
    element.title = "";
    return;
  }
  // 费用卡片统一以美元计价展示：人民币金额按汇率折算后并入，明细仍按原币种展示。
  const rate = Number(state.usdToCnyRate) > 0 ? Number(state.usdToCnyRate) : 1;
  const usdValue = hasUsd ? Number(usd) : 0;
  const cnyValue = hasCny ? Number(cny) : 0;
  const total = usdValue + cnyValue / rate;
  const formatted = formatCostAmount(total, "USD");
  element.textContent = formatted;
  element.title =
    hasUsd && hasCny
      ? `美元 ${formatPreciseCost(usdValue, "USD")} + 人民币 ${formatPreciseCost(cnyValue, "CNY")}（按汇率 ${rate} 折算）`
      : formatted;
  // Keep monetary values at the same typographic scale as the token row.
  // Very long amounts retain the full value in their existing title tooltip.
  element.style.fontSize = "";
}

export function formatTokenMillions(value) {
  const amount = Number(value || 0);
  const finite = Number.isFinite(amount) ? amount : 0;
  const magnitude = Math.abs(finite);
  const [divisor, unit] =
    magnitude >= 1_000_000_000_000 ? [1e12, "T"] : magnitude >= 1_000_000_000 ? [1e9, "B"] : [1e6, "M"];
  return `${millionTokenFormatter.format(finite / divisor)}${unit}`;
}

function formatCompact(value) {
  return compactFormatter.format(Math.round(value || 0));
}

// Normalize optional row labels before rendering or building accessible names.
function usageRowName(row) {
  return row?.name || row?.key || "未知";
}

// Model names render lowercase everywhere; aggregation keys and color lookups keep the original casing.
function displayModelName(value) {
  return String(value || "").toLowerCase();
}

// Keep keyboard/screen-reader labels aligned with the visual token value.
function usageRowAriaLabel(row, nameOverride = null) {
  return `${nameOverride ?? usageRowName(row)}：${formatTokens(usageValue(row?.total, "total"))} tokens`;
}

export function formatUsageTooltip(row, titleOverride = null, options = {}) {
  const total = row?.total || emptyUsage();
  const tooltipTitle = titleOverride || row?.name || row?.key || "未知";
  const details = [
    ["总 tokens", usageValue(total, "total")],
    ["总输入", usageValue(total, "input")],
    ["缓存读取", usageValue(total, "cached")],
    ["输出", usageValue(total, "output")],
    ["推理输出", usageValue(total, "reasoning")],
    ["事件", row?.count || 0],
    ["会话", row?.sessions || 0],
  ];
  const channels = row?.channels || [];
  const titleText = options.modelNames === true ? displayModelName(tooltipTitle) : tooltipTitle;
  return `
    <div class="usage-tooltip-title">${escapeHtml(titleText)}</div>
    <div class="usage-tooltip-grid">
      ${details
        .map(
          ([label, value]) => `
            <span class="usage-tooltip-label">${label}</span>
            <span class="usage-tooltip-value">${formatTokens(value)}</span>
          `,
        )
        .join("")}
    </div>
    ${
      channels.length
        ? `
          <div class="usage-tooltip-subtitle">渠道</div>
          <div class="usage-tooltip-grid">
            ${channels
              .map(
                (channel) => `
                  <span class="usage-tooltip-label">${escapeHtml(channel.name)}</span>
                  <span class="usage-tooltip-value">${formatTokens(usageValue(channel.total, "total"))}</span>
                `,
              )
              .join("")}
          </div>
        `
        : ""
    }
  `;
}

function usageTooltip() {
  return $("#usageTooltip");
}

function hideUsageTooltip() {
  const tooltip = usageTooltip();
  if (tooltip) {
    tooltip.hidden = true;
  }
}

export function usageTooltipPosition(anchorX, anchorY, width, height, viewportWidth, viewportHeight) {
  const offset = 14;
  const margin = 8;
  let left = anchorX + offset;
  let top = anchorY + offset;
  if (left + width + margin > viewportWidth) {
    left = anchorX - width - offset;
  }
  if (top + height + margin > viewportHeight) {
    top = anchorY - height - offset;
  }
  return {
    left: Math.min(Math.max(margin, left), Math.max(margin, viewportWidth - width - margin)),
    top: Math.min(Math.max(margin, top), Math.max(margin, viewportHeight - height - margin)),
  };
}

function positionUsageTooltip(anchor) {
  const tooltip = usageTooltip();
  if (!tooltip || tooltip.hidden) {
    return;
  }
  const rect = anchor?.getBoundingClientRect?.();
  const anchorX = Number.isFinite(anchor?.clientX) ? anchor.clientX : rect?.left || 8;
  const anchorY = Number.isFinite(anchor?.clientY) ? anchor.clientY : rect?.bottom || 8;
  const position = usageTooltipPosition(
    anchorX,
    anchorY,
    tooltip.offsetWidth,
    tooltip.offsetHeight,
    window.innerWidth,
    window.innerHeight,
  );
  tooltip.style.left = `${position.left}px`;
  tooltip.style.top = `${position.top}px`;
}

function scrollUsageTooltip(deltaY) {
  const tooltip = usageTooltip();
  if (!tooltip || tooltip.hidden || !deltaY) return false;
  const maxScroll = tooltip.scrollHeight - tooltip.clientHeight;
  const nextScroll = Math.min(maxScroll, Math.max(0, tooltip.scrollTop + deltaY));
  if (maxScroll <= 0 || nextScroll === tooltip.scrollTop) return false;
  tooltip.scrollTop = nextScroll;
  return true;
}

function showUsageTooltip(row, anchor, options = null) {
  const tooltip = usageTooltip();
  if (!tooltip || !row) {
    hideUsageTooltip();
    return;
  }
  tooltip.innerHTML = formatUsageTooltip(row, null, options || undefined);
  tooltip.hidden = false;
  positionUsageTooltip(anchor);
}

function timelineAccessibleLabel(row, mode, range = null) {
  const quotaInfo = quotaTimelineSlotInfo(row);
  const english = getLocale() === "en-US";
  const key = quotaInfo
    ? english
      ? `${quotaInfo.title}. Interval ${quotaInfo.interval}. ${quotaInfo.note}`
      : `${quotaInfo.title}，时间槽区间 ${quotaInfo.interval}。${quotaInfo.note}`
    : timelineSlotRangeTitle(row, range) || String(row?.key || row?.name || localizeText("未知时间"));
  if (mode === "cost") {
    const pair = costPairFromSlots(row?.costByModel);
    const amount =
      Number(row?.pricedTokens || 0) > 0 ? formatCostPair(pair.usd, pair.cny) : localizeText("无可计价费用");
    if (english)
      return `${key}. Estimated cost ${amount}; ${formatTokens(row?.minimumEstimatedTokens || 0)} tokens use fallback rates; ${formatTokens(row?.unpricedTokens || 0)} tokens are unpriced.`;
    return `${key}，费用估算 ${amount}，其中 ${formatTokens(row?.minimumEstimatedTokens || 0)} tokens 按最低费率估算，未计价 ${formatTokens(row?.unpricedTokens || 0)} tokens`;
  }
  const details = mode === "model" ? row?.models || [] : row?.channels || [];
  const kind = mode === "model" ? "模型" : "渠道";
  const breakdown = details
    .map((item) => `${item.name} ${formatTokens(usageValue(item.total, "total"))} tokens`)
    .join(english ? ", " : "，");
  if (english)
    return `${key}. Total ${formatTokens(usageValue(row?.total, "total"))} tokens${breakdown ? `; ${mode === "model" ? "models" : "sources"}: ${breakdown}` : ""}.`;
  return `${key}，总计 ${formatTokens(usageValue(row?.total, "total"))} tokens${breakdown ? `，${kind}：${breakdown}` : ""}`;
}

function showTimelineTooltip(row, anchor) {
  const tooltip = usageTooltip();
  if (!tooltip || !row) {
    hideUsageTooltip();
    return;
  }
  const range = currentSummary()?.range || null;
  tooltip.innerHTML = formatTimelineTooltip(row, state.timelineMode, range);
  tooltip.hidden = false;
  positionUsageTooltip(anchor);
  const chart = document.querySelector("#timelineChart");
  if (chart && document.activeElement === chart)
    chart.setAttribute("aria-label", localizeText(timelineAccessibleLabel(row, state.timelineMode, range)));
}

function bindUsageRows(container, selector, rows, options = null) {
  container.querySelectorAll(selector).forEach((element, index) => {
    tooltipRows.set(element, { row: rows[index], options });
  });
}

const CATEGORY_PALETTES = {
  light: [
    "#2563eb",
    "#c2410c",
    "#7c3aed",
    "#0f766e",
    "#be185d",
    "#4d7c0f",
    "#6b7280",
    "#b91c1c",
    "#0e7490",
    "#4338ca",
    "#15803d",
    "#9f1239",
  ],
  dark: [
    "#60a5fa",
    "#fb923c",
    "#c084fc",
    "#2dd4bf",
    "#f472b6",
    "#a3e635",
    "#cbd5e1",
    "#f87171",
    "#22d3ee",
    "#818cf8",
    "#4ade80",
    "#fda4af",
  ],
};

const MODEL_COLOR_ORDER = [
  "gpt-5.6-luna",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-6-sol",
  "gpt-6-astra",
  "codex-auto-review",
  "Unknown model",
  "gpt-5.6-terra",
  "gpt-5.5",
  "gpt-5.6",
  "gpt-daybreak-blue-latest",
];
const MODEL_COLOR_SLOTS = new Map(MODEL_COLOR_ORDER.map((name, index) => [name, index]));

function categoryColor(index, dark) {
  const palette = dark ? CATEGORY_PALETTES.dark : CATEGORY_PALETTES.light;
  return index < palette.length
    ? palette[index]
    : `hsl(${((index - palette.length) * 137.508 + 17) % 360} 70% ${dark ? 64 : 38}%)`;
}

function categoricalColors(rows = []) {
  const dark = document.documentElement.dataset?.theme === "dark";
  const totals = new Map();
  for (const row of rows) totals.set(row.name, Math.max(totals.get(row.name) || 0, usageValue(row.total, "total")));
  const names = [...totals.keys()].sort(
    (left, right) => totals.get(right) - totals.get(left) || left.localeCompare(right),
  );
  return new Map(names.map((name, index) => [name, categoryColor(index, dark)]));
}

export function getChannelColors(rows) {
  return categoricalColors(rows);
}

export function timelineChannelSegments(row, channelRows = []) {
  const rowChannels = new Map((row?.channels || []).map((channel) => [channel.name, channel]));
  const ordered = [];
  for (const channel of channelRows) {
    const match = rowChannels.get(channel.name);
    if (match) {
      ordered.push(match);
      rowChannels.delete(channel.name);
    }
  }
  ordered.push(...rowChannels.values());
  return ordered;
}

function isQuotaPreset(preset = state.preset) {
  return QUOTA_PRESETS.includes(preset);
}

function quotaWindowAvailability(quotaSnapshot, preset) {
  const window = quotaSnapshot?.windows?.[preset];
  if (window?.state === "available") return { available: true, reason: "" };
  return {
    available: false,
    reason:
      (window?.reason ? localizeQuotaReason(window) : "") ||
      (quotaSnapshot
        ? QUOTA_UI_COPY.unavailable
        : state.report
          ? QUOTA_UI_COPY.staticMissingSnapshot
          : QUOTA_UI_COPY.missingSnapshot),
  };
}

function formatLocalClock(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatLocalDateTimeWithZone(value) {
  const date = asDate(value);
  if (!date || Number.isNaN(date.getTime())) return "未知时间";
  const seconds = String(date.getSeconds()).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `UTC${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, "0")}:${String(absoluteOffset % 60).padStart(2, "0")}`;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "本地时区";
  const timestamp =
    getLocale() === "en-US" ? formatLocalDateTime(date) : `${dateKey(date)} ${formatLocalClock(date)}:${seconds}`;
  return `${timestamp} (${timeZone}, ${offset})`;
}

function quotaWindowBounds(range) {
  return {
    start: asDate(range?.windowStart || range?.start),
    end: asDate(range?.windowEndExclusive || range?.end),
  };
}

function quotaRangeAccessibleLabel(range) {
  const { start, end } = quotaWindowBounds(range);
  const mode = range?.quotaPreset || range?.preset;
  const name = range?.recentValue || QUOTA_MODE_LABELS[mode] || "限额窗口";
  const interval =
    start && end
      ? `[${formatLocalDateTimeWithZone(start)}, ${formatLocalDateTimeWithZone(end)})`
      : localizeText("限额窗口边界不可用");
  if (getLocale() === "en-US") {
    const asOf = range?.asOf ? `; data as of ${formatLocalDateTimeWithZone(range.asOf)}` : "";
    const weekNote = mode === "quota_week" ? `; ${localizeText(QUOTA_UI_COPY.weekSlot)}` : "";
    return `${localizeText(name)} ${interval}${asOf}${weekNote}`;
  }
  const asOf = range?.asOf ? `；${QUOTA_UI_COPY.asOf} ${formatLocalDateTimeWithZone(range.asOf)}` : "";
  const weekNote = mode === "quota_week" ? `；${QUOTA_UI_COPY.weekSlot}` : "";
  return `${name} ${interval}${asOf}${weekNote}`;
}

function quotaTimelineSlotInfo(row) {
  if (!isQuotaPreset() && !(state.preset === "recent" && ["上一个5h", "上周"].includes(state.recentValue))) return null;
  const startMs = Number(row?.slotStartMs ?? row?.key);
  const endMs = Number(row?.slotEndExclusiveMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const start = new Date(startMs);
  const end = new Date(endMs);
  const interval = `[${formatLocalDateTimeWithZone(start)}, ${formatLocalDateTimeWithZone(end)})`;
  const title = `${formatLocalDateTimeWithZone(start)} – ${formatLocalDateTimeWithZone(end)}`;
  const baseNote = localizeText(
    state.preset === "quota_week" || (state.preset === "recent" && state.recentValue === "上周")
      ? QUOTA_UI_COPY.weekSlot
      : QUOTA_UI_COPY.halfHourSlot,
  );
  const asOf = asDate(
    state.summary?.range?.asOf || state.report?.asOf || state.report?.quota?.asOf || state.quotaSnapshot?.asOf,
  );
  const partialNote =
    asOf && asOf.getTime() > startMs && asOf.getTime() < endMs
      ? getLocale() === "en-US"
        ? `${localizeText(QUOTA_UI_COPY.partialSlot)} ${formatLocalDateTimeWithZone(asOf)}.`
        : `${QUOTA_UI_COPY.partialSlot} ${formatLocalDateTimeWithZone(asOf)}。`
      : "";
  const note = [baseNote, partialNote].filter(Boolean).join(" ");
  return { title, interval, note };
}

function asDate(value) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

function startOfDay(date, zone = "local") {
  return zone === "utc"
    ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    : new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function endOfDay(date, zone = "local") {
  return zone === "utc"
    ? new Date(startOfDay(date, zone).getTime() + MS_PER_DAY - 1)
    : new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function subtractMonthsClamped(date, months, zone = "local") {
  const utc = zone === "utc";
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = utc ? date.getUTCMonth() : date.getMonth();
  const day = utc ? date.getUTCDate() : date.getDate();
  const target = utc ? new Date(Date.UTC(year, month - months, 1)) : new Date(year, month - months, 1);
  const targetYear = utc ? target.getUTCFullYear() : target.getFullYear();
  const targetMonth = utc ? target.getUTCMonth() : target.getMonth();
  const clamped = Math.min(day, daysInMonth(targetYear, targetMonth));
  return utc
    ? new Date(
        Date.UTC(
          targetYear,
          targetMonth,
          clamped,
          date.getUTCHours(),
          date.getUTCMinutes(),
          date.getUTCSeconds(),
          date.getUTCMilliseconds(),
        ),
      )
    : new Date(
        targetYear,
        targetMonth,
        clamped,
        date.getHours(),
        date.getMinutes(),
        date.getSeconds(),
        date.getMilliseconds(),
      );
}

export function normalizeRecentValue(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, "");
  return canonicalRecentValue(value) || normalized;
}

function parseRecentValue(value) {
  const normalized = normalizeRecentValue(value);
  if (RECENT_SELECTIONS.includes(normalized)) return { named: normalized };
  if (normalized === "半年") {
    return { months: 6 };
  }
  if (normalized === "一年") {
    return { months: 12 };
  }
  const dayMatch = normalized.match(/^([1-9]\d*)天$/);
  if (dayMatch) {
    return { days: Number(dayMatch[1]) };
  }
  const weekMatch = normalized.match(/^([1-9]\d*)周$/);
  if (weekMatch) {
    return { days: Number(weekMatch[1]) * 7 };
  }
  const monthMatch = normalized.match(/^([1-9]\d*)个月$/);
  if (monthMatch) {
    return { months: Number(monthMatch[1]) };
  }
  const yearMatch = normalized.match(/^([1-9]\d*)年$/);
  if (yearMatch) {
    return { months: Number(yearMatch[1]) * 12 };
  }
  return null;
}

function recentDateRange(value, now, zone = "local") {
  const parsed = parseRecentValue(value);
  if (!parsed) {
    return null;
  }
  if (parsed.days === 1) {
    return {
      start: new Date(now.getTime() - MS_PER_DAY),
      end: now,
      preset: "recent",
      rolling: true,
    };
  }
  const start = parsed.days
    ? addCalendarDays(startOfDay(now, zone), 1 - parsed.days, zone)
    : startOfDay(subtractMonthsClamped(now, parsed.months, zone), zone);
  return {
    start,
    end: endOfDay(now, zone),
    preset: "recent",
  };
}

function startOfWeek(date, zone = "local") {
  const start = startOfDay(date, zone);
  const day = (zone === "utc" ? start.getUTCDay() : start.getDay()) || 7;
  if (zone === "utc") start.setUTCDate(start.getUTCDate() - day + 1);
  else start.setDate(start.getDate() - day + 1);
  return start;
}

function addCalendarDays(date, days, zone = "local") {
  const next = new Date(date);
  if (zone === "utc") next.setUTCDate(next.getUTCDate() + days);
  else next.setDate(next.getDate() + days);
  return next;
}

export function getRange(events, quotaSnapshot = state.report?.quota) {
  const now = state.now ? new Date(state.now) : quotaSnapshot?.asOf ? new Date(quotaSnapshot.asOf) : new Date();
  const zone = state.calendarZone;
  if (state.preset === "quota_5h" || state.preset === "quota_week") {
    const quota = quotaSnapshot || null;
    const quotaWindow = quota?.windows?.[state.preset];
    if (quotaWindow?.state !== "available") {
      return {
        start: null,
        end: null,
        asOf: quota?.asOf ? new Date(quota.asOf) : now,
        quotaState: quotaWindow?.state || "missing",
        quotaReason:
          quotaWindow?.reason || (state.report ? QUOTA_UI_COPY.staticMissingSnapshot : QUOTA_UI_COPY.unavailable),
        preset: state.preset,
        bucket: state.preset === "quota_5h" ? "quota_30m" : "quota_24h",
        calendarZone: zone,
      };
    }
    const asOfMs = Date.parse(quota.asOf);
    const startMs = Date.parse(quotaWindow.windowStart);
    const endExclusiveMs = Date.parse(quotaWindow.windowEndExclusive);
    if (![asOfMs, startMs, endExclusiveMs].every(Number.isFinite) || startMs > asOfMs || asOfMs >= endExclusiveMs) {
      return {
        start: null,
        end: null,
        asOf: Number.isFinite(asOfMs) ? new Date(asOfMs) : now,
        quotaState: "ambiguous",
        quotaReason: QUOTA_UI_COPY.invalidBoundaries,
        preset: state.preset,
        bucket: state.preset === "quota_5h" ? "quota_30m" : "quota_24h",
        calendarZone: zone,
      };
    }
    return {
      start: new Date(startMs),
      end: new Date(Math.min(asOfMs, endExclusiveMs) - 1),
      asOf: new Date(asOfMs),
      windowStart: new Date(startMs),
      windowEndExclusive: new Date(endExclusiveMs),
      observedAt: quotaWindow.observedAt ? new Date(quotaWindow.observedAt) : null,
      usedPercent: quotaWindow.usedPercent ?? null,
      percentStale: Boolean(quotaWindow.percentStale),
      limitId: quota.limitId || null,
      quotaState: "available",
      quotaReason: null,
      quotaWindow: true,
      preset: state.preset,
      bucket: state.preset === "quota_5h" ? "quota_30m" : "quota_24h",
      calendarZone: zone,
    };
  }
  if (state.preset === "today") {
    return { start: startOfDay(now, zone), end: endOfDay(now, zone), preset: state.preset, calendarZone: zone };
  }
  if (state.preset === "week") {
    return { start: startOfWeek(now, zone), end: endOfDay(now, zone), preset: state.preset, calendarZone: zone };
  }
  if (state.preset === "month") {
    return {
      start:
        zone === "utc"
          ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
          : new Date(now.getFullYear(), now.getMonth(), 1),
      end: endOfDay(now, zone),
      preset: state.preset,
      calendarZone: zone,
    };
  }
  if (state.preset === "custom") {
    return {
      start: state.startDate ? new Date(`${state.startDate}T00:00:00${zone === "utc" ? "Z" : ""}`) : null,
      end: state.endDate ? new Date(`${state.endDate}T23:59:59.999${zone === "utc" ? "Z" : ""}`) : null,
      preset: state.preset,
      calendarZone: zone,
    };
  }
  if (state.preset === "recent") {
    const named = resolveNamedRecentRange(state.recentValue, now, quotaSnapshot, zone);
    if (named) return { ...named, calendarZone: zone };
    const range = recentDateRange(state.recentValue, now, zone);
    if (range) {
      return { ...range, calendarZone: zone };
    }
  }
  let firstTimestamp = Infinity;
  let lastTimestamp = -Infinity;
  for (const event of events) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    firstTimestamp = Math.min(firstTimestamp, timestamp);
    lastTimestamp = Math.max(lastTimestamp, timestamp);
  }
  return {
    start: Number.isFinite(firstTimestamp) ? startOfDay(new Date(firstTimestamp), zone) : null,
    end: Number.isFinite(lastTimestamp) ? endOfDay(new Date(lastTimestamp), zone) : null,
    preset: state.preset,
    calendarZone: zone,
  };
}

export function nextPresetState(currentState = {}, preset = "today") {
  const selected = ["today", "week", "month", "all", "custom", "recent"].includes(preset) ? preset : "today";
  const next = { preset: selected, bucket: selected === "today" ? "hour" : "day" };
  if (isQuotaPreset(currentState.preset)) next.lastQuotaPreset = currentState.preset;
  return next;
}

export function nextQuotaPresetState(currentState = {}) {
  const currentPreset = currentState.preset || "today";
  const preferred = QUOTA_PRESETS.includes(currentState.lastQuotaPreset) ? currentState.lastQuotaPreset : "quota_5h";
  const target = isQuotaPreset(currentPreset) ? (currentPreset === "quota_5h" ? "quota_week" : "quota_5h") : preferred;
  return {
    changed: true,
    preset: target,
    bucket: target === "quota_5h" ? "quota_30m" : "quota_24h",
    lastQuotaPreset: target,
    reason: "",
  };
}

export function nextRecentState(_currentState = {}, value = "") {
  const recentValue = normalizeRecentValue(value);
  const parsed = parseRecentValue(recentValue);
  const namedBucket = { 上一个5h: "quota_30m", 上周: "quota_24h", 上个月: "day", 今年: "month" }[recentValue];
  return { preset: "recent", recentValue, bucket: namedBucket || (parsed?.days === 1 ? "hour" : "day") };
}

export function setSummaryFilters(filters = {}) {
  Object.assign(state, filters);
}

function addUsage(target, usage) {
  for (const field of ["total", "input", "cached", "output", "reasoning"]) {
    target[field] += usageValue(usage, field);
  }
  return target;
}

function emptyUsage() {
  return { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
}

function groupEvents(events, keyFn, options = {}) {
  const groups = new Map();
  for (const event of events) {
    const key = keyFn(event);
    const group = groups.get(key) || {
      key,
      name: key,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
      channelGroups: options.includeChannels ? new Map() : null,
    };
    group.count += 1;
    group.sessions.add(event.sessionId);
    addUsage(group.total, event.total);
    if (group.channelGroups) {
      const channelKey = event.channel || "Unknown";
      const channel = group.channelGroups.get(channelKey) || {
        key: channelKey,
        name: channelKey,
        count: 0,
        sessions: new Set(),
        total: emptyUsage(),
      };
      channel.count += 1;
      channel.sessions.add(event.sessionId);
      addUsage(channel.total, event.total);
      group.channelGroups.set(channelKey, channel);
    }
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    key: group.key,
    name: group.name,
    count: group.count,
    sessions: group.sessions.size,
    total: group.total,
    ...(group.channelGroups
      ? {
          channels: [...group.channelGroups.values()]
            .map((channel) => ({
              key: channel.key,
              name: channel.name,
              count: channel.count,
              sessions: channel.sessions.size,
              total: channel.total,
            }))
            .sort((a, b) => b.total.total - a.total.total),
        }
      : {}),
  }));
}

function groupRepositoryEvents(events) {
  const groups = new Map();
  for (const event of events) {
    const key = event.repositoryKey || `directory:${event.cwd || "Unknown cwd"}`;
    const group = groups.get(key) || {
      key,
      name: event.repositoryPath || event.cwd || "Unknown cwd",
      kind: event.repositoryKind || "directory",
      count: 0,
      sessions: new Set(),
      pathSet: new Set(),
      total: emptyUsage(),
    };
    const repositoryPath = event.repositoryPath || event.cwd || "Unknown cwd";
    if (repositoryPath < group.name) group.name = repositoryPath;
    group.count += 1;
    group.sessions.add(event.sessionId);
    if (event.cwd) group.pathSet.add(event.cwd);
    addUsage(group.total, event.total);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const { sessions, pathSet, ...row } = group;
      return { ...row, sessions: sessions.size, sessionIds: [...sessions], pathCount: pathSet.size };
    })
    .sort((a, b) => b.total.total - a.total.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function previousPeriodRange(range) {
  if (
    !range.start ||
    !range.end ||
    state.preset === "all" ||
    state.preset === "quota_5h" ||
    state.preset === "quota_week"
  ) {
    return null;
  }
  const zone = range.calendarZone === "utc" ? "utc" : "local";
  if (state.preset === "today") {
    const previousDay = addCalendarDays(startOfDay(asDate(range.start), zone), -1, zone);
    return {
      start: previousDay,
      end: endOfDay(previousDay, zone),
    };
  }
  if (state.preset === "week") {
    const previousWeekStart = addCalendarDays(startOfWeek(asDate(range.start), zone), -7, zone);
    return {
      start: previousWeekStart,
      end: endOfDay(addCalendarDays(previousWeekStart, 6, zone), zone),
    };
  }
  if (state.preset === "month") {
    const currentMonthStart = asDate(range.start);
    return {
      start:
        zone === "utc"
          ? new Date(Date.UTC(currentMonthStart.getUTCFullYear(), currentMonthStart.getUTCMonth() - 1, 1))
          : new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - 1, 1),
      end: new Date(currentMonthStart.getTime() - 1),
    };
  }
  const durationMs = range.end.getTime() - range.start.getTime() + 1;
  return {
    start: new Date(range.start.getTime() - durationMs),
    end: new Date(range.start.getTime() - 1),
  };
}

function rangeDurationMs(range) {
  const start = asDate(range?.start);
  const end = asDate(range?.end);
  if (!start || !end) {
    return 0;
  }
  return Math.max(0, end.getTime() - start.getTime() + 1);
}

function currentElapsedMs(range, now) {
  const start = asDate(range?.start);
  const end = asDate(range?.end);
  if (!start || !end || Number.isNaN(now?.getTime())) {
    return rangeDurationMs(range);
  }
  const boundedEnd = Math.min(end.getTime(), Math.max(start.getTime(), now.getTime()));
  return Math.max(0, boundedEnd - start.getTime() + 1);
}

function averageTrend(currentTotals, previousTotals, range, previousRange, now) {
  const previousDurationMs = rangeDurationMs(previousRange);
  const elapsedMs = currentElapsedMs(range, now);
  const averageBaselineTotal = previousDurationMs
    ? Math.round((previousTotals.total * elapsedMs) / previousDurationMs)
    : 0;
  return {
    averageBaselineTotal,
    averageDelta: currentTotals.total - averageBaselineTotal,
    averagePercentChange: percentChange(currentTotals.total, averageBaselineTotal),
  };
}

function comparisonLabel() {
  return (
    {
      today: "较昨日",
      week: "较上周",
      month: "较上月",
      custom: "较上一等长周期",
      recent: "较上一等长周期",
    }[state.preset] || "暂无对比"
  );
}

function percentChange(current, previous) {
  if (!previous) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function summarizeComparison(allEvents, range, currentTotals) {
  // 静态导出没有 API 可用，因此在浏览器端复用同一套趋势口径。
  const previousRange = previousPeriodRange(range);
  if (!previousRange) {
    return {
      label: comparisonLabel(),
      previousRange: null,
      previousTotals: emptyUsage(),
      previousEventCount: 0,
      previousSessionCount: 0,
      totalDelta: currentTotals.total,
      percentChange: null,
      averageBaselineTotal: 0,
      averageDelta: currentTotals.total,
      averagePercentChange: null,
    };
  }
  const previousEvents = allEvents.filter((event) => {
    const time = Date.parse(event.timestamp);
    return Number.isFinite(time) && time >= previousRange.start.getTime() && time <= previousRange.end.getTime();
  });
  const previousTotals = previousEvents.reduce((sum, event) => addUsage(sum, event.total), emptyUsage());
  const now = state.now ? new Date(state.now) : new Date();
  const average = averageTrend(currentTotals, previousTotals, range, previousRange, now);
  return {
    label: comparisonLabel(),
    previousRange: {
      start: previousRange.start.toISOString(),
      end: previousRange.end.toISOString(),
    },
    previousTotals,
    previousEventCount: previousEvents.length,
    previousSessionCount: new Set(previousEvents.map((event) => event.sessionId)).size,
    totalDelta: currentTotals.total - previousTotals.total,
    percentChange: percentChange(currentTotals.total, previousTotals.total),
    ...average,
  };
}

function codexHomeIdSet(report) {
  return new Set((report.homes || []).filter((home) => CODEX_HOME_KINDS.has(home.kind)).map((home) => String(home.id)));
}

export function summarize(report) {
  const excluded = new Set((state.excludedHomes || []).map(String));
  const sourceEvents = (report.events || []).filter((event) => !excluded.has(String(event.homeId)));
  const range = getRange(sourceEvents, report.quota);
  const quotaPreset = isQuotaPreset(state.preset) || Boolean(range.quotaWindow);
  const quotaAvailable = !quotaPreset || range.quotaState === "available";
  // 限额窗口只衡量 Codex 用量，与服务端聚合保持同一口径。
  const codexHomeIds = quotaPreset ? codexHomeIdSet(report) : null;
  // 跨度升档在汇总时推导（此时范围已解析、跨度已知），而非切换预设时。
  const bucket = deriveTimelineBucket(range, range.bucket || state.bucket);
  const events = sourceEvents.filter((event) => {
    if (!quotaAvailable) return false;
    if (codexHomeIds && !codexHomeIds.has(String(event.homeId))) {
      return false;
    }
    const date = new Date(event.timestamp);
    if (Number.isNaN(date.getTime())) {
      return false;
    }
    if (range.start && date < range.start) {
      return false;
    }
    if (range.end && date > range.end) {
      return false;
    }
    return true;
  });
  const totals = events.reduce((sum, event) => addUsage(sum, event.total), emptyUsage());
  range.bucket = bucket;
  let timeline = [];
  let timelineError = null;
  try {
    if (quotaAvailable) timeline = buildTimelineRows(events, range, bucket);
  } catch (error) {
    if (error.code !== "TIMELINE_RANGE_TOO_LARGE") throw error;
    timelineError = error.message;
  }
  const channels = groupEvents(events, (event) => event.channel).sort((a, b) => b.total.total - a.total.total);
  const projects = groupEvents(events, (event) => event.cwd || "Unknown cwd").sort(
    (a, b) => b.total.total - a.total.total,
  );
  const repositories = groupRepositoryEvents(events);
  const models = groupEvents(events, (event) => event.model || "Unknown model").sort(
    (a, b) => b.total.total - a.total.total,
  );
  return {
    range,
    totals,
    costEstimate: summarizeEmbeddedCostEstimates(events, report.pricing),
    records: quotaPreset
      ? quotaRecordsForRange(range, report.quota, report.rateLimitObservations, (window) => {
          const rows = events.filter(
            (event) => new Date(event.timestamp) >= window.start && new Date(event.timestamp) <= window.end,
          );
          return {
            eventCount: rows.length,
            values: quotaRecordValues(
              rows.reduce((sum, event) => addUsage(sum, event.total), emptyUsage()),
              summarizeEmbeddedCostEstimates(rows, report.pricing),
              new Set(rows.map((event) => event.sessionId)).size,
              report.pricing?.usdToCnyRate,
            ),
          };
        })
      : {},
    comparison: quotaPreset ? null : summarizeComparison(sourceEvents, range, totals),
    quota: report.quota || null,
    timeline,
    timelineError,
    channels,
    projects,
    repositories,
    models,
    sessionCount: new Set(events.map((event) => event.sessionId)).size,
    eventCount: events.length,
  };
}

function summarizeEmbeddedCostEstimates(events, pricing = {}) {
  if (!events.every((event) => event.costEstimate)) return null;
  const totals = {
    inputUsd: 0,
    cachedInputUsd: 0,
    cacheWriteInputUsd: 0,
    outputUsd: 0,
    totalUsd: 0,
    cacheRateInput: 0,
    cacheRateCached: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    minimumEstimatedTokens: 0,
    pricedRecords: 0,
    minimumEstimatedRecords: 0,
    unpricedRecords: 0,
    serviceTierUnknownTokens: 0,
    serviceTierUnknownRecords: 0,
    contextUnknownTokens: 0,
    contextUnknownRecords: 0,
    cacheWriteUnknownTokens: 0,
    cacheWriteUnknownRecords: 0,
  };
  const byCurrency = {
    USD: { inputUsd: 0, cachedInputUsd: 0, cacheWriteInputUsd: 0, outputUsd: 0, totalUsd: 0, records: 0 },
    CNY: { inputUsd: 0, cachedInputUsd: 0, cacheWriteInputUsd: 0, outputUsd: 0, totalUsd: 0, records: 0 },
  };
  const models = new Set();
  const unpricedModels = new Set();
  const minimumRateModels = new Set();
  const unpricedReasons = new Set();
  const priceVersions = new Set();
  const priceSources = new Set();
  for (const event of events) {
    const estimate = event.costEstimate;
    for (const field of [
      "pricedTokens",
      "unpricedTokens",
      "minimumEstimatedTokens",
      "serviceTierUnknownTokens",
      "contextUnknownTokens",
      "cacheWriteUnknownTokens",
    ])
      totals[field] += Number(estimate[field] || 0);
    const bucket = byCurrency[estimate.currency === "CNY" ? "CNY" : "USD"];
    for (const field of ["inputUsd", "cachedInputUsd", "cacheWriteInputUsd", "outputUsd", "totalUsd"]) {
      bucket[field] += Number(estimate[field] || 0);
    }
    if (Number(estimate.pricedTokens || 0) > 0) {
      totals.pricedRecords += 1;
      bucket.records += 1;
    }
    if (Number(estimate.minimumEstimatedTokens || 0) > 0) totals.minimumEstimatedRecords += 1;
    if (Number(estimate.unpricedTokens || 0) > 0) totals.unpricedRecords += 1;
    if (Number(estimate.serviceTierUnknownTokens || 0) > 0) totals.serviceTierUnknownRecords += 1;
    if (Number(estimate.contextUnknownTokens || 0) > 0) totals.contextUnknownRecords += 1;
    if (Number(estimate.cacheWriteUnknownTokens || 0) > 0) totals.cacheWriteUnknownRecords += 1;
    const name = String(event.model || "Unknown model").trim();
    if (name && name.toLocaleLowerCase() !== "unknown model") models.add(name);
    for (const model of estimate.unpricedModels || []) unpricedModels.add(model);
    for (const model of estimate.minimumRateModels || []) minimumRateModels.add(model);
    for (const reason of estimate.unpricedReasons || []) unpricedReasons.add(reason);
    if (estimate.priceVersion) priceVersions.add(estimate.priceVersion);
    if (estimate.priceSource) priceSources.add(estimate.priceSource);
    const usage = event.total || {};
    const mask = Number(event.detailMask || 0);
    if ((mask & 3) === 3 && Number(usage.input || 0) > 0) {
      totals.cacheRateInput += Number(usage.input || 0);
      totals.cacheRateCached += Number(usage.cached || 0);
    }
  }
  const usd = byCurrency.USD;
  const cny = byCurrency.CNY;
  return {
    totalUsd: usd.records > 0 ? usd.totalUsd : null,
    inputUsd: usd.records > 0 ? usd.inputUsd : null,
    cachedInputUsd: usd.records > 0 ? usd.cachedInputUsd : null,
    cacheWriteInputUsd: usd.records > 0 ? usd.cacheWriteInputUsd : null,
    outputUsd: usd.records > 0 ? usd.outputUsd : null,
    totalCny: cny.records > 0 ? cny.totalUsd : null,
    inputCny: cny.records > 0 ? cny.inputUsd : null,
    cachedInputCny: cny.records > 0 ? cny.cachedInputUsd : null,
    cacheWriteInputCny: cny.records > 0 ? cny.cacheWriteInputUsd : null,
    outputCny: cny.records > 0 ? cny.outputUsd : null,
    currencies: [...(usd.records > 0 ? ["USD"] : []), ...(cny.records > 0 ? ["CNY"] : [])],
    cacheHitRate: totals.cacheRateInput > 0 ? totals.cacheRateCached / totals.cacheRateInput : null,
    modelCount: models.size,
    pricedTokens: totals.pricedTokens,
    unpricedTokens: totals.unpricedTokens,
    minimumEstimatedTokens: totals.minimumEstimatedTokens,
    pricedRecords: totals.pricedRecords,
    unpricedRecords: totals.unpricedRecords,
    minimumEstimatedRecords: totals.minimumEstimatedRecords,
    unpricedModels: [...unpricedModels].sort((a, b) => a.localeCompare(b)),
    minimumRateModels: [...minimumRateModels].sort((a, b) => a.localeCompare(b)),
    unpricedReasons: [...unpricedReasons].sort(),
    serviceTierUnknownTokens: totals.serviceTierUnknownTokens,
    serviceTierUnknownRecords: totals.serviceTierUnknownRecords,
    contextUnknownTokens: totals.contextUnknownTokens,
    contextUnknownRecords: totals.contextUnknownRecords,
    cacheWriteUnknownTokens: totals.cacheWriteUnknownTokens,
    cacheWriteUnknownRecords: totals.cacheWriteUnknownRecords,
    priceVersions: [...priceVersions].sort(),
    priceSources: [...priceSources].sort(),
    priceCheckedAt: pricing.checkedAt || "",
    priceMode: pricing.mode || "",
    priceSource: pricing.source || "",
  };
}

function renderCostMetrics(summary) {
  const estimate = summary.costEstimate;
  const note = $("#costEstimateNote");
  if (!estimate) {
    $("#costEstimateDate").textContent = "";
    for (const selector of [
      "#totalCost",
      "#inputCost",
      "#cachedInputCost",
      "#outputCost",
      "#cacheHitRate",
      "#priceModelCount",
    ]) {
      $(selector).textContent = "—";
      $(selector).removeAttribute("title");
    }
    note.textContent = isStaticSnapshot() ? "此静态快照没有费用估算，请重新导出快照。" : "费用估算暂不可用。";
    note.title = "";
    return;
  }

  setCurrencyMetric("#totalCost", estimate.totalUsd, estimate.totalCny);
  setCurrencyMetric("#inputCost", estimate.inputUsd, estimate.inputCny);
  setCurrencyMetric("#cachedInputCost", estimate.cachedInputUsd, estimate.cachedInputCny);
  setCurrencyMetric("#outputCost", estimate.outputUsd, estimate.outputCny);
  $("#cacheHitRate").textContent =
    estimate.cacheHitRate === null ? "—" : `${(estimate.cacheHitRate * 100).toFixed(2)}%`;
  $("#cacheHitRate").title = $("#cacheHitRate").textContent;
  setMetric("#priceModelCount", estimate.modelCount);

  $("#costEstimateDate").textContent = estimate.priceCheckedAt ? `· ${estimate.priceCheckedAt}` : "";
  const checkedAt = estimate.priceCheckedAt ? `价格基准 ${estimate.priceCheckedAt}` : "当前价格基准";
  const totalTokens = formatTokens(summary.totals.total);
  const caveats = [];
  if (estimate.serviceTierUnknownRecords > 0)
    caveats.push(`${formatTokens(estimate.serviceTierUnknownRecords)} 条记录的服务等级未知，按 Standard 情景估算`);
  if (estimate.contextUnknownRecords > 0)
    caveats.push(
      `${formatTokens(estimate.contextUnknownRecords)} 条记录无法可靠对应单次请求输入，按可用的较低上下文费率估算`,
    );
  if (estimate.cacheWriteUnknownRecords > 0)
    caveats.push(
      `${formatTokens(estimate.cacheWriteUnknownTokens)} 个输入 tokens 缺少缓存写入明细，相关未知部分按最低费率估算`,
    );
  if (estimate.minimumEstimatedTokens > 0)
    caveats.push(`${formatTokens(estimate.minimumEstimatedTokens)} / ${totalTokens} tokens 使用最低费率估算`);
  if (estimate.minimumRateModels?.length)
    caveats.push(
      `模型 ${estimate.minimumRateModels.map((name) => displayModelName(name)).join("、")} 缺少专用单价，按价目表最低费率估算`,
    );
  if (estimate.unpricedTokens > 0) caveats.push(`仍有 ${formatTokens(estimate.unpricedTokens)} tokens 无法估算`);
  const sourceLinks = renderPricingSourceLinksHtml(
    [estimate.priceSource, ...(estimate.priceSources || [])],
    estimate.currencies || [],
  );
  note.innerHTML = `
    <p>按当前价目表估算 · ${escapeHtml(checkedAt)} · ${sourceLinks || "默认价格来源"}</p>
    <p>金额按已知明细及最低费率情景折算 API 等价费用，不代表实际账单，也不含工具调用等非 token 费用。</p>
    ${
      caveats.length
        ? `<ul aria-label="估算限制">${caveats.map((caveat) => `<li>${escapeHtml(caveat)}。</li>`).join("")}</ul>`
        : "<p>缓存读取与写入按各自官方费率计入总额。</p>"
    }
  `;
  note.title = estimate.unpricedModels?.length
    ? `仍无法计价的模型：${estimate.unpricedModels.map((name) => displayModelName(name)).join("、")}`
    : "更新计价标准后，所有已索引的历史用量会按新单价重算。";
}

const PRICING_SOURCE_LABELS = Object.freeze({
  "developers.openai.com": "OpenAI 价格表",
  "stepfun.com": "StepFun 定价",
  "mimo.mi.com": "MiMo 定价",
  "deepseek.com": "DeepSeek 定价",
  "kimi.com": "Kimi 定价",
  "bigmodel.cn": "GLM 定价",
});

export function renderPricingSourceLinksHtml(values = [], currencies = []) {
  const sources = new Map();
  for (const value of values) {
    const url = externalHttpUrl(value);
    if (!url || (!currencies.includes("USD") && url.hostname === "developers.openai.com")) continue;
    sources.set(url.href, url);
  }
  return [...sources.values()]
    .map((url) => {
      const label = Object.hasOwn(PRICING_SOURCE_LABELS, url.hostname)
        ? PRICING_SOURCE_LABELS[url.hostname]
        : url.hostname;
      return `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
    })
    .join("、");
}

// New Record：所选范围内的纪录期点亮对应指标卡右上角的 New 小字。
const RECORD_CARD_METRICS = Object.freeze({
  totalTokens: "#totalTokens",
  inputTokens: "#inputTokens",
  cachedTokens: "#cachedTokens",
  outputTokens: "#outputTokens",
  reasoningTokens: "#reasoningTokens",
  sessionCount: "#sessionCount",
  totalCost: "#totalCost",
  inputCost: "#inputCost",
  cachedCost: "#cachedInputCost",
  outputCost: "#outputCost",
  cacheHitRate: "#cacheHitRate",
  modelCount: "#priceModelCount",
});

function renderRecordBadges(records = {}) {
  const englishRecordNames = {
    totalTokens: "Total tokens",
    inputTokens: "Input tokens",
    cachedTokens: "Cache hit tokens",
    outputTokens: "Output tokens",
    reasoningTokens: "Reasoning tokens",
    sessionCount: "Sessions",
    totalCost: "Estimated cost",
    inputCost: "Cache miss cost",
    cachedCost: "Cache hit cost",
    outputCost: "Output cost",
    cacheHitRate: "Cache hit rate",
    modelCount: "Model count",
  };
  for (const [metric, selector] of Object.entries(RECORD_CARD_METRICS)) {
    const valueNode = $(selector);
    const card = valueNode?.closest(".metric");
    const badge = card?.querySelector(".metric-new");
    if (!badge) continue;
    const record = state.preset === "all" ? null : records?.[metric];
    badge.hidden = !record;
    badge.textContent = "";
    badge.setAttribute("role", "img");
    badge.setAttribute("aria-label", getLocale() === "en-US" ? "New record" : "新纪录");
    const comparisonCount = record?.comparedWindowCount;
    card.title = record
      ? getLocale() === "en-US"
        ? `Highest ${englishRecordNames[metric]?.toLowerCase() || "usage"} in a ${record.unit || "period"}: ${record.period}${comparisonCount ? ` (compared with ${comparisonCount} earlier observed windows)` : ""}`
        : `${record.title}：${record.period}${comparisonCount ? `（对比此前 ${comparisonCount} 个已观测窗口）` : ""}`
      : "";
  }
}

function renderMetrics(summary) {
  setTokenMetric("#totalTokens", summary.totals.total);
  setTokenMetric("#inputTokens", summary.totals.input);
  setTokenMetric("#cachedTokens", summary.totals.cached);
  setTokenMetric("#outputTokens", summary.totals.output);
  setTokenMetric("#reasoningTokens", summary.totals.reasoning);
  setMetric("#sessionCount", summary.sessionCount);
  renderCostMetrics(summary);
  renderRecordBadges(summary.records);
}

export function rangeLabel(summary) {
  const range = summary?.range || {};
  if (isQuotaPreset(range.preset) || range.quotaWindow) {
    const mode = range.quotaPreset || range.preset;
    const label = range.recentValue || QUOTA_MODE_LABELS[mode];
    if (range.quotaState !== "available") return `等待${label}数据`;
    const { start, end } = quotaWindowBounds(range);
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return `等待${label}数据`;
    }
    if (mode === "quota_week") return `${dateKey(start)} 至 ${dateKey(end)}`;
    const shortStart = dateKey(start).slice(5);
    const shortEnd = dateKey(end).slice(5);
    const startLabel = `${shortStart} ${formatLocalClock(start)}`;
    const endLabel = `${shortEnd} ${formatLocalClock(end)}`;
    return dateKey(start) === dateKey(end) ? `${startLabel}–${formatLocalClock(end)}` : `${startLabel}–${endLabel}`;
  }
  const start = summary.range.start ? dateKey(asDate(summary.range.start), range.calendarZone) : "开始";
  const end = summary.range.end ? dateKey(asDate(summary.range.end), range.calendarZone) : "现在";
  // 粒度升档时在副标题明示合并方式，避免"日柱去哪了"的困惑。
  const granularity = range.bucket === "week" ? " · 按周合并" : range.bucket === "month" ? " · 按月合并" : "";
  return `${start} 至 ${end}${range.calendarZone === "utc" ? " (UTC)" : ""}${granularity}`;
}

export function renderBarListHtml(rows, colorMap = null, options = {}) {
  // Build escaped HTML in one place so all bar-list render paths stay safe.
  if (!rows.length) {
    return `<div class="empty">没有匹配的用量记录</div>`;
  }
  const modelNames = options.modelNames === true;
  const max = rows[0].total.total || 1;
  return rows
    .map((row) => {
      const width = Math.max(2, (row.total.total / max) * 100);
      const color = colorMap?.get(row.name);
      const fillStyle = `width: ${width}%;${color ? ` background: ${safeChartColor(color)};` : ""}`;
      const rawName = usageRowName(row);
      const displayName = modelNames ? displayModelName(rawName) : rawName;
      const name = escapeHtml(displayName);
      const ariaLabel = escapeHtml(usageRowAriaLabel(row, modelNames ? displayName : null));
      return `
        <div class="bar-row" data-usage-tooltip="true" tabindex="0" aria-label="${ariaLabel}">
          <div class="bar-label">
            <span class="bar-name" title="${name}">${name}</span>
            <span class="bar-value" title="${formatTokens(row.total.total)}">${formatTokenMillions(row.total.total)}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="${fillStyle}"></div></div>
        </div>
      `;
    })
    .join("");
}

function renderBarList(container, rows, colorMap = null, options = null) {
  container.innerHTML = renderBarListHtml(rows, colorMap, options || undefined);
  bindUsageRows(container, ".bar-row", rows, options);
}

function timelineBreakdownReady(rows, mode) {
  if (mode === "channel") return true;
  const activeRows = rows.filter((row) => usageValue(row?.total, "total") > 0);
  if (mode === "model") {
    return activeRows.every(
      (row) =>
        Array.isArray(row.models) &&
        Math.abs(
          row.models.reduce((sum, model) => sum + usageValue(model.total, "total"), 0) - usageValue(row.total, "total"),
        ) < 1e-6,
    );
  }
  return activeRows.every((row) => {
    const costs = row.costByModel;
    if (!costs || typeof costs !== "object" || Array.isArray(costs)) return false;
    if (!Number.isFinite(Number(row.pricedTokens)) || !Number.isFinite(Number(row.unpricedTokens))) return false;
    const pricedTokens = Object.values(costs).reduce((sum, cost) => sum + Number(cost.pricedTokens || 0), 0);
    const unpricedTokens = Object.values(costs).reduce((sum, cost) => sum + Number(cost.unpricedTokens || 0), 0);
    return (
      Math.abs(pricedTokens - Number(row.pricedTokens)) < 1e-6 &&
      Math.abs(unpricedTokens - Number(row.unpricedTokens)) < 1e-6
    );
  });
}

export function timelineDetailRows(summary, mode) {
  if (summary.timelineError) return [];
  if (mode === "channel") return summary.channels || [];
  if (mode === "model") return summary.models || [];
  const byModel = new Map();
  for (const slot of summary.timeline || []) {
    for (const [name, cost] of Object.entries(slot.costByModel || {})) {
      const amount = Number(cost?.totalUsd || 0);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const entry = byModel.get(name) || { name, totalUsd: 0, currency: cost?.currency || "USD" };
      entry.totalUsd += amount;
      byModel.set(name, entry);
    }
  }
  return [...byModel.values()]
    .map((entry) => ({ ...entry, scaleValue: scaledCost(entry.totalUsd, entry.currency) }))
    .sort((left, right) => right.scaleValue - left.scaleValue || left.name.localeCompare(right.name));
}

export function renderCostDetailHtml(rows, colorMap = null) {
  if (!rows.length) return '<div class="empty">没有可计价的费用记录</div>';
  const values = rows.map((row) => row.scaleValue ?? scaledCost(row.totalUsd, row.currency));
  const max = values[0] || 1;
  return rows
    .map((row, index) => {
      const name = escapeHtml(displayModelName(row.name));
      const amount = formatPreciseCost(row.totalUsd, row.currency);
      const color = safeChartColor(colorMap?.get(row.name) || getModelColor(row.name));
      const width = Math.max(2, (values[index] / max) * 100);
      return `
      <div class="bar-row" tabindex="0" aria-label="${name}，费用估算 ${amount}">
        <div class="bar-label">
          <span class="bar-name" title="${name}">${name}</span>
          <span class="bar-value" title="${amount}">${amount}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width: ${width}%; background: ${color};"></div></div>
      </div>
    `;
    })
    .join("");
}

function renderTimelineDetails(summary, channelColors, modelColors) {
  const mode = state.timelineMode;
  const label = { channel: "按渠道", model: "按模型", cost: "按花销" }[mode] || "按渠道";
  $("#detailModeLabel").textContent = label;
  const container = $("#detailList");
  if (summary.timelineError) {
    container.innerHTML = '<div class="empty">时间范围过大，无法生成时间分布。</div>';
    return;
  }
  if (!timelineBreakdownReady(summary.timeline || [], mode)) {
    container.innerHTML = `<div class="empty">${mode === "model" ? "模型" : "费用"}明细不可用，请刷新数据。</div>`;
    return;
  }
  const rows = timelineDetailRows(summary, mode);
  if (mode === "cost") {
    container.innerHTML = renderCostDetailHtml(rows, modelColors);
    return;
  }
  renderBarList(
    container,
    rows,
    mode === "model" ? modelColors : channelColors,
    mode === "model" ? { modelNames: true } : null,
  );
}
const COMPARISON_PERIOD_LABELS = { today: "今日", week: "本周", month: "本月", all: "全部" };
const COMPARISON_PERIOD_ORDER = ["today", "week", "month", "all"];

function comparisonPeriodTotal(row, period) {
  const total = Number(row.periods?.[period]?.total ?? 0);
  return Number.isFinite(total) ? total : 0;
}

function comparePeriodComparisonRows(left, right, kind, sort) {
  const selectedPeriod = COMPARISON_PERIOD_ORDER.includes(sort?.period) ? sort.period : "today";
  const periods = sort?.showIndicator
    ? [selectedPeriod, ...COMPARISON_PERIOD_ORDER.filter((period) => period !== selectedPeriod)]
    : COMPARISON_PERIOD_ORDER;

  for (const [index, period] of periods.entries()) {
    const leftTotal = comparisonPeriodTotal(left, period);
    const rightTotal = comparisonPeriodTotal(right, period);
    const direction = index === 0 && sort?.showIndicator ? sort.direction : "desc";
    const difference = direction === "asc" ? leftTotal - rightTotal : rightTotal - leftTotal;
    if (difference !== 0) return difference;
  }

  const leftName = comparisonRowName(left.name, kind);
  const rightName = comparisonRowName(right.name, kind);
  const nameOrder = leftName.localeCompare(rightName);
  if (nameOrder !== 0) return nameOrder;
  return String(left.key || "").localeCompare(String(right.key || ""));
}

function comparisonTokenValueClass(formattedValue) {
  return formattedValue === "0.00M" ? ' class="comparison-total-zero"' : "";
}

function comparisonMetricHtml(label, value, unavailableTokens, { suffix = "", precision = 0 } = {}) {
  const known = Number(value || 0);
  const missing = Number(unavailableTokens || 0);
  const formatted =
    known === 0 && missing > 0
      ? "明细未提供"
      : precision
        ? `${(known * 100).toFixed(precision)}%`
        : `${formatTokenMillions(known)}${suffix}`;
  const title = precision || (known === 0 && missing > 0) ? "" : ` title="${formatTokens(known)}"`;
  const note = missing > 0 ? `；另有 ${formatTokenMillions(missing)} token 的记录未提供此项` : "";
  return `<div class="comparison-detail-metric"><span>${escapeHtml(label)}</span><strong${comparisonTokenValueClass(formatted)}${title}>${formatted}</strong><small${missing > 0 ? ` title="${formatTokens(missing)}"` : ""}>${missing > 0 ? escapeHtml(note.slice(2)) : ""}</small></div>`;
}

function renderPeriodDetailHtml(metrics, period) {
  const hitInput = Number(metrics.cacheRateInput || 0);
  const hitRate = hitInput > 0 ? Number(metrics.cacheRateCached || 0) / hitInput : null;
  const partialHitData = Number(metrics.uncachedInputUnavailableTokens || 0) > 0;
  const hitLabel =
    hitRate === null
      ? partialHitData
        ? "明细未提供"
        : "—"
      : `${(hitRate * 100).toFixed(2)}%${partialHitData ? "（已知部分）" : ""}`;
  return `
    <h3 class="comparison-detail-title">${COMPARISON_PERIOD_LABELS[period]}明细</h3>
    <div class="comparison-detail-grid">
      ${comparisonMetricHtml("总 tokens", metrics.total)}
      ${comparisonMetricHtml("总输入", metrics.input, metrics.inputUnavailableTokens)}
      ${comparisonMetricHtml("缓存读取", metrics.cached, metrics.cachedUnavailableTokens)}
      ${comparisonMetricHtml("未命中输入", metrics.uncachedInput, metrics.uncachedInputUnavailableTokens)}
      ${comparisonMetricHtml("输出", metrics.output, metrics.outputUnavailableTokens)}
      ${comparisonMetricHtml("推理输出", metrics.reasoning, metrics.reasoningUnavailableTokens)}
      <div class="comparison-detail-metric"><span>缓存命中率</span><strong>${hitLabel}</strong><small>${partialHitData ? "只按总输入与缓存读取都已知的记录计算" : "缓存读取 ÷ 总输入"}</small></div>
      <div class="comparison-detail-metric"><span>明细不完整记录的总量</span><strong${comparisonTokenValueClass(formatTokenMillions(metrics.unattributedDetailTokens || 0))} title="${formatTokens(metrics.unattributedDetailTokens || 0)}">${formatTokenMillions(metrics.unattributedDetailTokens || 0)}</strong><small>记录总量提示，不与各明细相加</small></div>
      <div class="comparison-detail-metric"><span>字段不一致记录的总量</span><strong${comparisonTokenValueClass(formatTokenMillions(metrics.inconsistentTokens || 0))} title="${formatTokens(metrics.inconsistentTokens || 0)}">${formatTokenMillions(metrics.inconsistentTokens || 0)}</strong><small>涉及总量、输入/输出或缓存关系不一致</small></div>
      <div class="comparison-detail-metric"><span>明细校验差额合计</span><strong${comparisonTokenValueClass(formatTokenMillions(metrics.reconciliationGap || 0))} title="${formatTokens(metrics.reconciliationGap || 0)}">${formatTokenMillions(metrics.reconciliationGap || 0)}</strong><small>各项差额之和，仅作质量提示</small></div>
    </div>
  `;
}

export function filterPeriodComparisonRows(rows = []) {
  return rows.filter((row) => Object.values(row.periods || {}).some((period) => Number(period?.total || 0) > 0));
}

function comparisonRowName(value, kind) {
  const name = String(value || "");
  if (kind === "model") return displayModelName(name);
  if (kind !== "repository" || !name || name === "Unknown cwd") return name;
  const normalized = name.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || name;
}

export function nextComparisonSort(current, period) {
  if (!current?.showIndicator || current.period !== period) {
    return { period, direction: "desc", showIndicator: true };
  }
  if (current.direction === "desc") {
    return { period, direction: "asc", showIndicator: true };
  }
  return { period: "today", direction: "desc", showIndicator: false };
}

export function renderPeriodComparisonTableHtml(rows = [], options = {}) {
  const kind = options.kind === "repository" ? "repository" : "model";
  const query = String(options.query || "")
    .trim()
    .toLocaleLowerCase();
  const expanded = options.expanded || null;
  const totals = options.totals || null;
  const sort = options.sort || { period: "today", direction: "desc", showIndicator: false };
  const periodKeys = COMPARISON_PERIOD_ORDER;
  const filtered = rows.filter((row) => {
    if (!query) return true;
    return comparisonRowName(row.name, kind).toLocaleLowerCase().includes(query);
  });
  if (!filtered.length) {
    return `<div class="empty">${rows.length ? "没有匹配的用量记录" : "所选时间范围内没有用量"}</div>`;
  }
  const sorted = [...filtered].sort((left, right) => comparePeriodComparisonRows(left, right, kind, sort));
  const body = sorted
    .map((row, index) => {
      const rowId = `${kind}-period-${index}`;
      const displayName = comparisonRowName(row.name, kind);
      const repositoryIcon =
        kind === "repository" && row.kind === "git"
          ? '<svg class="repository-git-icon" viewBox="0 0 16 16" role="img" aria-label="Git 仓库" title="Git 仓库" focusable="false" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4.5v7m0-3.5h3a3 3 0 0 0 3-3V5.5" /><circle cx="6" cy="3" r="1.5" /><circle cx="6" cy="13" r="1.5" /><circle cx="12" cy="4" r="1.5" /></svg>'
          : "";
      const cells = periodKeys
        .map((period) => {
          const isExpanded = expanded?.kind === kind && expanded?.key === row.key && expanded?.period === period;
          const value = row.periods?.[period]?.total || 0;
          const formattedValue = formatTokenMillions(value);
          const roundedZeroClass = formattedValue === "0.00M" ? " comparison-total-zero" : "";
          return `<td><button class="comparison-total-button${roundedZeroClass}" type="button" data-period-expand data-kind="${kind}" data-key="${escapeHtml(row.key)}" data-period="${period}" aria-expanded="${isExpanded}" ${isExpanded ? `aria-controls="${rowId}-detail"` : ""} title="${formatTokens(value)}">${formattedValue}</button></td>`;
        })
        .join("");
      const isExpanded = expanded?.kind === kind && expanded?.key === row.key;
      const activeMetrics = isExpanded ? row.periods?.[expanded.period] : null;
      return `
      <tr><th scope="row"><span class="comparison-row-name">${repositoryIcon}<span class="comparison-row-label" title="${escapeHtml(displayName)}" aria-label="${escapeHtml(displayName)}">${escapeHtml(displayName)}</span></span></th>${cells}</tr>
      ${activeMetrics ? `<tr class="comparison-detail-row"><td id="${rowId}-detail" colspan="5">${renderPeriodDetailHtml(activeMetrics, expanded.period)}</td></tr>` : ""}
    `;
    })
    .join("");
  const totalsRow = totals
    ? `<tfoot><tr><th scope="row" title="不受搜索筛选影响">全局合计</th>${periodKeys
        .map((period) => {
          const value = totals[period]?.total || 0;
          const formattedValue = formatTokenMillions(value);
          const roundedZeroClass = formattedValue === "0.00M" ? "comparison-total-zero" : "";
          return `<td class="${roundedZeroClass}" title="${formatTokens(value)}">${formattedValue}</td>`;
        })
        .join("")}</tr></tfoot>`
    : "";
  return `
    <div class="comparison-table-frame">
      <div class="comparison-table-scroll">
        <table class="comparison-table">
          <thead><tr><th scope="col">${kind === "repository" ? "仓库" : "模型"}</th>${periodKeys
            .map((period) => {
              const isSorted = sort.showIndicator && sort.period === period;
              const direction = isSorted ? sort.direction : "desc";
              const indicator = isSorted ? (direction === "asc" ? "▲" : "▼") : "";
              const ariaSort = isSorted ? (direction === "asc" ? "ascending" : "descending") : "none";
              const label = COMPARISON_PERIOD_LABELS[period];
              const sortLabel = isSorted ? `${label}，${direction === "asc" ? "正序" : "倒序"}` : `按${label}用量排序`;
              const sortTitle = sort.showIndicator
                ? `当前先按${label}${sort.direction === "asc" ? "正序" : "倒序"}；平手依次按其余周期倒序`
                : "默认排序优先级：今日 → 本周 → 本月 → 全部（各项倒序）";
              return `<th scope="col" aria-sort="${ariaSort}"><button class="comparison-sort-button" type="button" data-comparison-sort data-kind="${kind}" data-period="${period}" aria-label="${sortLabel}" title="${sortTitle}"><span>${label}</span><span class="comparison-sort-indicator" aria-hidden="true"${indicator ? "" : " hidden"}>${indicator}</span></button></th>`;
            })
            .join("")}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      ${totalsRow ? `<table class="comparison-table comparison-table-foot">${totalsRow}</table>` : ""}
    </div>
  `;
}

function renderPeriodComparisons(comparison) {
  const expanded = state.expandedPeriodCell;
  const models = filterPeriodComparisonRows(comparison?.models || []);
  const repositories = filterPeriodComparisonRows(comparison?.repositories || []);
  $("#modelComparisonTable").innerHTML = renderPeriodComparisonTableHtml(models, {
    kind: "model",
    query: state.modelComparisonQuery,
    expanded,
    totals: comparison?.totals,
    sort: state.modelComparisonSort,
  });
  $("#repositoryComparisonTable").innerHTML = renderPeriodComparisonTableHtml(repositories, {
    kind: "repository",
    query: state.repositoryComparisonQuery,
    expanded,
    totals: comparison?.totals,
    sort: state.repositoryComparisonSort,
  });
  const asOf = comparison?.asOf ? new Date(comparison.asOf).toLocaleString(getLocale()) : "";
  for (const node of document.querySelectorAll("[data-comparison-as-of]")) {
    node.textContent = asOf ? `统计截至 ${asOf}` : "";
  }
}

const MONTH_NAMES_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortTimelineLabel(key, bucket, range) {
  const text = String(key || "");
  if (bucket === "quota_30m" || bucket === "quota_24h") {
    const timestampMs = Number(text);
    if (!Number.isFinite(timestampMs)) return text;
    const date = new Date(timestampMs);
    if (bucket === "quota_30m") {
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    }
    return getLocale() === "en-US"
      ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]
      : ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
  }
  if (bucket === "hour") {
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):00$/);
    if (!match) return text;
    const start = asDate(range?.start);
    const end = asDate(range?.end);
    const oneDay = start && end && dateKey(start, range?.calendarZone) === dateKey(end, range?.calendarZone);
    return oneDay ? match[4] : `${match[2]}-${match[3]} ${match[4]}`;
  }
  if (bucket === "month") {
    const monthStart = asDate(range?.start);
    const monthEnd = asDate(range?.end);
    const crossYear =
      monthStart &&
      monthEnd &&
      dateKey(monthStart, range?.calendarZone).slice(0, 4) !== dateKey(monthEnd, range?.calendarZone).slice(0, 4);
    // 跨年时保留 "2026-09" 全键，同年内缩成 "9月"/"Sep"。
    if (crossYear) return text;
    const month = Number(text.slice(5, 7));
    if (!Number.isFinite(month)) return text;
    return getLocale() === "en-US" ? MONTH_NAMES_EN[month - 1] || text : `${month}月`;
  }
  if (bucket === "day" || bucket === "week") {
    const start = asDate(range?.start);
    const end = asDate(range?.end);
    if (bucket === "day" && range?.preset === "week") {
      const date = new Date(`${text}T12:00:00`);
      return getLocale() === "en-US"
        ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()]
        : ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][date.getDay()];
    }
    if (bucket === "day" && range?.preset === "month") return text.slice(8, 10);
    if (
      start &&
      end &&
      dateKey(start, range?.calendarZone).slice(0, 4) !== dateKey(end, range?.calendarZone).slice(0, 4)
    )
      return text;
    return text.slice(5);
  }
  return text;
}

// 周/月槽的标题显示覆盖日期区间，首尾槽不满时标注"部分"，
// 避免把周键（周一日期）或月键（YYYY-MM）误读成某一天。
export function timelineSlotRangeTitle(row, range) {
  const bucket = range?.bucket;
  const key = String(row?.key || "");
  if ((bucket !== "week" && bucket !== "month") || !key) return null;
  const zone = range?.calendarZone === "utc" ? "utc" : "local";
  const rangeStart = asDate(range?.start);
  const rangeEnd = asDate(range?.end);
  let first = null;
  let last = null;
  if (bucket === "week") {
    first = asDate(zone === "utc" ? `${key}T00:00:00Z` : `${key}T00:00:00`);
    last = first ? addCalendarDays(first, 6, zone) : null;
  } else {
    const year = Number(key.slice(0, 4));
    const month = Number(key.slice(5, 7));
    if (Number.isFinite(year) && Number.isFinite(month)) {
      first = zone === "utc" ? new Date(Date.UTC(year, month - 1, 1)) : new Date(year, month - 1, 1);
      last = zone === "utc" ? new Date(Date.UTC(year, month, 0)) : new Date(year, month, 0);
    }
  }
  if (!first || !last || Number.isNaN(first.getTime()) || Number.isNaN(last.getTime())) return null;
  const effectiveStart = rangeStart && first < rangeStart ? rangeStart : first;
  const effectiveEnd = rangeEnd && last > rangeEnd ? rangeEnd : last;
  const partial = effectiveStart > first || effectiveEnd < last;
  const english = getLocale() === "en-US";
  const partialLabel = !partial
    ? ""
    : english
      ? bucket === "week"
        ? " (partial week)"
        : " (partial month)"
      : bucket === "week"
        ? "（部分周）"
        : "（部分月）";
  return `${dateKey(effectiveStart, zone)}${english ? " to " : " 至 "}${dateKey(effectiveEnd, zone)}${partialLabel}`;
}

const CALENDAR_BUCKETS = new Set(["day", "week", "month", "hour"]);

export function timelineAxisLabels(rows, options = {}) {
  if (!rows.length) return [];
  const bucket = options.bucket || "day";
  const range = options.range || {};
  const chartWidth = options.chartWidth || 960;
  const oneDayHourly =
    bucket === "hour" &&
    range.start &&
    range.end &&
    dateKey(asDate(range.start), range.calendarZone) === dateKey(asDate(range.end), range.calendarZone);
  const labels = rows.map((row) => shortTimelineLabel(row.key, bucket, range));
  if (oneDayHourly && chartWidth >= 700) {
    return rows.map((_row, index) => ({ index, label: labels[index] }));
  }
  // 未来槽位不画柱（drawTimeline 跳过 row.future），也不作为刻度候选，月视图才不会标出统计范围外的日期。
  const endKey = range?.end ? dateKey(asDate(range.end), range.calendarZone) : null;
  const candidateIndexes = [];
  rows.forEach((row, index) => {
    const isFuture =
      typeof row.future === "boolean"
        ? row.future
        : Boolean(endKey) && CALENDAR_BUCKETS.has(bucket) && String(row.key).slice(0, 10) > endKey;
    if (!isFuture) candidateIndexes.push(index);
  });
  const pool = candidateIndexes.length ? candidateIndexes : rows.map((_row, index) => index);
  const maxLabels = Math.max(1, options.maxLabels || Math.floor(chartWidth / 68));
  // 固定整数步长、末尾锚定：相邻刻度间隔恒定，且最新一天必有标签。
  // 旧的等分四舍五入在除不尽时产生 2/3 天交替间隔，还会整段跳过某天（如 13 天范围恰好丢掉 09-21）。
  const step = Math.max(1, Math.ceil(pool.length / maxLabels));
  const picked = [];
  for (let position = pool.length - 1; position >= 0; position -= step) {
    picked.push(pool[position]);
  }
  return picked.reverse().map((index) => ({ index, label: labels[index] }));
}

function formatDelta(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatTokenMillions(value)}`;
}

function formatExactDelta(value) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatTokens(value)}`;
}

function previousTokensLabel(comparisonLabel) {
  return (
    {
      较昨日: "昨日 tokens",
      较上周: "上周 tokens",
      较上月: "上月 tokens",
      较上一等长周期: "前一等长区间 tokens",
    }[comparisonLabel] || "上一周期 tokens"
  );
}

function previousPeriodDateLabel(range) {
  const start = asDate(range?.start);
  const end = asDate(range?.end);
  return start && end ? `${dateKey(start, state.calendarZone)} 至 ${dateKey(end, state.calendarZone)}` : "";
}

function formatPercent(value) {
  if (value === null || value === undefined) {
    return "无基准";
  }
  const percent = Number(value);
  if (!Number.isFinite(percent)) return "无基准";
  const sign = percent > 0 ? "+" : "";
  return `${sign}${percent}%`;
}

function comparisonClass(value) {
  return value > 0 ? "up" : value < 0 ? "down" : "flat";
}

export function renderComparisonHtml(comparison) {
  if (!comparison) {
    return "";
  }
  if (!comparison.previousRange) {
    const message = comparison.label === "暂无对比" ? "全部范围没有可比较的上一周期" : "当前范围没有可比较的上一周期";
    return `
      <article class="comparison-item comparison-unavailable flat">
        <span>趋势变化</span>
        <strong>暂无对比</strong>
        <small>${message}</small>
      </article>
    `;
  }
  const equalLengthPreviousRange = comparison.label === "较上一等长周期";
  const previousPeriodDetail = equalLengthPreviousRange ? previousPeriodDateLabel(comparison.previousRange) : "";
  const previousSessionDetail = `${formatTokens(comparison.previousSessionCount)} 个会话`;
  return `
    <article class="comparison-item ${comparisonClass(comparison.totalDelta)}">
      <span>${escapeHtml(comparison.label)}</span>
      <strong title="${formatExactDelta(comparison.totalDelta)}">${formatDelta(comparison.totalDelta)}</strong>
      <small>${formatPercent(comparison.percentChange)}</small>
    </article>
    <article class="comparison-item ${comparisonClass(comparison.averageDelta)}">
      <span>流速同比</span>
      <strong title="${formatExactDelta(comparison.averageDelta)}">${formatDelta(comparison.averageDelta)}</strong>
      <small>${formatPercent(comparison.averagePercentChange)}</small>
    </article>
    <article class="comparison-item${equalLengthPreviousRange ? " previous-period-equal-range" : ""}">
      <span>${previousTokensLabel(comparison.label)}</span>
      <strong title="${formatTokens(comparison.previousTotals.total)}">${formatTokenMillions(comparison.previousTotals.total)}</strong>
      <small>${previousPeriodDetail ? `${previousPeriodDetail} · ` : ""}${previousSessionDetail}</small>
    </article>
  `;
}

function renderComparison(summary) {
  const container = $("#comparisonSummary");
  if (!container) {
    return;
  }
  container.innerHTML = renderComparisonHtml(summary.comparison);
}

function getModelColor(name) {
  const dark = document.documentElement.dataset?.theme === "dark";
  const fixedSlot = MODEL_COLOR_SLOTS.get(name);
  if (fixedSlot !== undefined) return categoryColor(fixedSlot, dark);
  let hash = 2166136261;
  for (const character of String(name)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `hsl(${(hash >>> 0) % 360} 70% ${dark ? 64 : 38}%)`;
}

export function getModelColors(rows = []) {
  const dark = document.documentElement.dataset?.theme === "dark";
  const names = [...new Set(rows.map((row) => row.name))];
  const extraNames = names
    .filter((name) => !MODEL_COLOR_SLOTS.has(name))
    .sort((left, right) => left.localeCompare(right));
  const extraSlots = new Map(extraNames.map((name, index) => [name, MODEL_COLOR_ORDER.length + index]));
  return new Map(names.map((name) => [name, categoryColor(MODEL_COLOR_SLOTS.get(name) ?? extraSlots.get(name), dark)]));
}

function timelineModelSegments(row, modelRows = []) {
  const rowModels = new Map((row?.models || []).map((model) => [model.name, model]));
  const ordered = [];
  for (const model of modelRows) {
    const match = rowModels.get(model.name);
    if (match) {
      ordered.push(match);
      rowModels.delete(model.name);
    }
  }
  ordered.push(...rowModels.values());
  return ordered;
}

function timelineCostSegments(row, modelRows = []) {
  const costByModel = row?.costByModel || {};
  const orderedNames = modelRows.map((model) => model.name);
  for (const name of Object.keys(costByModel)) {
    if (!orderedNames.includes(name)) orderedNames.push(name);
  }
  return orderedNames
    .filter((name) => costByModel[name])
    .map((name) => ({ name, value: scaledCost(costByModel[name].totalUsd, costByModel[name].currency) }))
    .filter((segment) => segment.value > 0);
}

function timelineValue(row, mode) {
  if (mode === "cost") {
    return Object.values(row?.costByModel || {}).reduce(
      (total, cost) => total + scaledCost(cost.totalUsd, cost.currency),
      0,
    );
  }
  return usageValue(row?.total, "total");
}

const preciseUsdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const preciseCnyFormatter = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// 金额符号随模型标价货币切换：美元模型显示 $，人民币模型显示 ¥。
export function formatCostAmount(value, currency = "USD") {
  const amount = Number(value || 0);
  const safe = Number.isFinite(amount) ? amount : 0;
  return currency === "CNY" ? cnyFormatter.format(safe) : usdFormatter.format(safe);
}

function formatPreciseCost(value, currency = "USD") {
  const amount = Number(value || 0);
  const safe = Number.isFinite(amount) ? amount : 0;
  return currency === "CNY" ? preciseCnyFormatter.format(safe) : preciseUsdFormatter.format(safe);
}

// 混合币种并列展示（如 $1.23 + ¥4.56）；某币种没有计价记录时用 null 表示。
export function formatCostPair(usd, cny) {
  const parts = [];
  const usdValue = Number(usd);
  const cnyValue = Number(cny);
  if (usd !== null && usd !== undefined && Number.isFinite(usdValue)) parts.push(formatPreciseCost(usdValue, "USD"));
  if (cny !== null && cny !== undefined && Number.isFinite(cnyValue)) parts.push(formatPreciseCost(cnyValue, "CNY"));
  return parts.length ? parts.join(" + ") : "—";
}

export function costPairFromSlots(costByModel = {}) {
  let usd = 0;
  let cny = 0;
  let hasUsd = false;
  let hasCny = false;
  for (const cost of Object.values(costByModel || {})) {
    const amount = Number(cost?.totalUsd || 0);
    if (!(amount > 0)) continue;
    if (cost?.currency === "CNY") {
      cny += amount;
      hasCny = true;
    } else {
      usd += amount;
      hasUsd = true;
    }
  }
  return { usd: hasUsd ? usd : null, cny: hasCny ? cny : null };
}

// 混合币种的排序与图表比例按汇率折算到同一标尺（含人民币时统一折人民币），
// 展示金额始终保留各模型的原币种。
export function costScaleValue(amount, currency, rate, targetCurrency) {
  const value = Number(amount || 0);
  const safeRate = Number(rate) > 0 ? Number(rate) : 1;
  const target = targetCurrency === "CNY" ? "CNY" : "USD";
  if ((currency === "CNY") === (target === "CNY")) return value;
  return currency === "CNY" ? value / safeRate : value * safeRate;
}

function scaledCost(amount, currency) {
  return costScaleValue(amount, currency, state.usdToCnyRate, state.costScaleTarget);
}

export function formatTimelineTooltip(row, mode = "channel", range = null) {
  const quotaInfo = quotaTimelineSlotInfo(row);
  const quotaNote = quotaInfo
    ? `<div class="usage-tooltip-note">${getLocale() === "en-US" ? "Interval" : "时间槽区间"} ${escapeHtml(quotaInfo.interval)}${getLocale() === "en-US" ? "; " : "；"}${escapeHtml(quotaInfo.note)}</div>`
    : "";
  const slotTitle = quotaInfo?.title || timelineSlotRangeTitle(row, range);
  if (mode === "channel") return `${formatUsageTooltip(row, slotTitle)}${quotaNote}`;
  const title = escapeHtml(slotTitle || row?.name || row?.key || "未知时间");
  if (mode === "model") {
    const models = (row?.models || [])
      .map(
        (model) =>
          `<span class="usage-tooltip-label">${escapeHtml(displayModelName(model.name))}</span><span class="usage-tooltip-value">${formatTokens(usageValue(model.total, "total"))}</span>`,
      )
      .join("");
    return `<div class="usage-tooltip-title">${title}</div>${quotaNote}<div class="usage-tooltip-grid"><span class="usage-tooltip-label">总 tokens</span><span class="usage-tooltip-value">${formatTokens(usageValue(row?.total, "total"))}</span></div><div class="usage-tooltip-subtitle">模型</div><div class="usage-tooltip-grid">${models || `<span class="usage-tooltip-label">无模型用量</span>`}</div>`;
  }
  const costs = Object.entries(row?.costByModel || {})
    .filter(([, cost]) => Number(cost.totalUsd || 0) > 0)
    .sort(
      (left, right) =>
        scaledCost(right[1].totalUsd, right[1].currency) - scaledCost(left[1].totalUsd, left[1].currency),
    )
    .map(([name, cost]) => {
      const native = formatPreciseCost(cost.totalUsd, cost.currency);
      const converted =
        cost.currency === state.costScaleTarget
          ? ""
          : `（≈${formatPreciseCost(scaledCost(cost.totalUsd, cost.currency), state.costScaleTarget)}）`;
      return `<span class="usage-tooltip-label">${escapeHtml(displayModelName(name))}</span><span class="usage-tooltip-value">${native}${converted}</span>`;
    })
    .join("");
  const pair = costPairFromSlots(row?.costByModel);
  const amountLabel = Number(row?.pricedTokens || 0) > 0 ? formatCostPair(pair.usd, pair.cny) : "无可计价费用";
  const caveats = [];
  if (Number(row?.unpricedTokens || 0) > 0) caveats.push(`未计价 ${formatTokens(row.unpricedTokens)} tokens`);
  if (Number(row?.serviceTierUnknownTokens || 0) > 0) caveats.push("服务等级未知，金额按 Standard 情景估算");
  if (Number(row?.contextUnknownTokens || 0) > 0) caveats.push("请求上下文未知，按可用的较低上下文费率估算");
  if (Number(row?.minimumEstimatedTokens || 0) > 0)
    caveats.push(`其中 ${formatTokens(row.minimumEstimatedTokens)} tokens 按最低费率估算`);
  if (Number(row?.cacheWriteUnknownTokens || 0) > 0) caveats.push("缓存写入明细未知，相关未知部分按最低费率估算");
  return `<div class="usage-tooltip-title">${title}</div>${quotaNote}<div class="usage-tooltip-subtitle">费用估算</div><div class="usage-tooltip-grid"><span class="usage-tooltip-label">估算金额</span><span class="usage-tooltip-value">${amountLabel}</span><span class="usage-tooltip-label">已纳入估算 tokens</span><span class="usage-tooltip-value">${formatTokens(row?.pricedTokens || 0)}</span></div>${costs ? `<div class="usage-tooltip-subtitle">按模型</div><div class="usage-tooltip-grid">${costs}</div>` : ""}${caveats.length ? `<div class="usage-tooltip-note">${caveats.map(escapeHtml).join("；")}</div>` : ""}`;
}

function updateTimelineModeButtons() {
  for (const button of document.querySelectorAll("[data-timeline-mode]")) {
    const selected = button.dataset.timelineMode === state.timelineMode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

export function renderTimelineLegendHtml(summary, mode, channelColors, modelColors) {
  const isChannel = mode === "channel";
  const isCost = mode === "cost";
  const totalsByName = new Map();
  for (const slot of summary.timeline || []) {
    let segments;
    if (isChannel) {
      segments = slot.channels || [];
    } else if (isCost) {
      segments = Object.entries(slot.costByModel || {}).map(([name, cost]) => ({
        name,
        value: Number(cost.totalUsd || 0),
      }));
    } else {
      segments = slot.models || [];
    }
    for (const segment of segments) {
      const value = isCost ? Number(segment.value || 0) : usageValue(segment.total, "total");
      if (!(value > 0)) continue;
      totalsByName.set(segment.name, (totalsByName.get(segment.name) || 0) + value);
    }
  }
  const ordered = [...totalsByName.keys()].sort((a, b) => a.localeCompare(b));
  const colorFor = (name) =>
    isChannel ? channelColors.get(name) || "var(--green)" : modelColors.get(name) || getModelColor(name);
  return ordered
    .map((name) => {
      const color = safeChartColor(colorFor(name));
      const escapedName = escapeHtml(isChannel ? name : displayModelName(name));
      return (
        '<span class="timeline-legend-item" role="listitem"><span class="timeline-legend-swatch" style="background:' +
        color +
        '"></span><span title="' +
        escapedName +
        '">' +
        escapedName +
        "</span></span>"
      );
    })
    .join("");
}

function renderTimelineLegend(summary, channelColors, modelColors) {
  const container = document.querySelector("#timelineLegend");
  if (!container) return;
  container.innerHTML = renderTimelineLegendHtml(summary, state.timelineMode, channelColors, modelColors);
}

export function maxTimelineValue(values) {
  return values.reduce((maximum, value) => Math.max(maximum, value), 0);
}

// 时间轴刻度文字：12px、-22.5° 旋转，水平占位 ≈ 文字宽×cos(22.5°) + 字号×sin(22.5°)，另留 4px 呼吸空隙。
const TIMELINE_AXIS_FONT_PX = 12;
const TIMELINE_LABEL_FONT_PX = 13;
const TIMELINE_TICK_TILT = Math.PI / 8;
const TIMELINE_TICK_GAP = 4;

export function drawTimeline(
  canvas,
  rows,
  channelRows = [],
  channelColors = new Map(),
  range = null,
  mode = state.timelineMode,
  modelRows = [],
  modelColorsByName = getModelColors(modelRows),
) {
  const context = canvas.getContext("2d");
  canvas.dataset.usageTooltip = "true";
  const modeLabel = { channel: "按渠道", model: "按模型", cost: "按花销" }[mode] || "按渠道";
  const startLabel = range?.start ? dateKey(asDate(range.start), range?.calendarZone) : "";
  const endLabel = range?.end ? dateKey(asDate(range.end), range?.calendarZone) : "";
  const rangeLabelText = startLabel && endLabel ? `，统计范围 ${startLabel} 至 ${endLabel}` : "";
  const baseAriaLabel =
    getLocale() === "en-US"
      ? `Usage over time, ${mode === "cost" ? "estimated API-equivalent cost by model, with USD on the vertical axis" : `tokens stacked ${mode === "model" ? "by model" : "by source"}`}${startLabel && endLabel ? `, from ${startLabel} to ${endLabel}` : ""}. Inspect each interval for ${mode === "cost" ? "dates, model costs, and fallback estimates" : "dates and details"}.`
      : mode === "cost"
        ? `时间分布，按模型堆叠 API 等价费用估算，美元为纵轴单位${rangeLabelText}；每个时间槽可查看完整日期、模型费用和最低费率估算部分`
        : `时间分布，${modeLabel}堆叠 tokens${rangeLabelText}；每个时间槽可查看完整日期和明细`;
  canvas.dataset.chartAriaLabel = localizeText(baseAriaLabel);
  canvas.setAttribute?.("aria-label", localizeText(baseAriaLabel));
  timelineBars.set(canvas, []);
  const ratio = window.devicePixelRatio || 1;
  const styles = getComputedStyle(document.documentElement);
  const fontFamily =
    styles.getPropertyValue("--ui-font-sans").trim() ||
    'Inter, "Noto Sans SC", "Microsoft YaHei UI", "PingFang SC", system-ui, -apple-system, sans-serif';
  const timelineAxisFont = `${TIMELINE_AXIS_FONT_PX}px ${fontFamily}`;
  const timelineLabelFont = `${TIMELINE_LABEL_FONT_PX}px ${fontFamily}`;
  const chartLine = styles.getPropertyValue("--chart-line").trim() || "#d9e0e6";
  const chartText = styles.getPropertyValue("--chart-text").trim() || "#607080";
  const blue = styles.getPropertyValue("--blue").trim() || "#2364aa";
  const green = styles.getPropertyValue("--green").trim() || "#2f855a";
  const width = canvas.clientWidth * ratio;
  const height = canvas.clientHeight * ratio;
  canvas.width = width;
  canvas.height = height;
  context.clearRect(0, 0, width, height);
  context.scale(ratio, ratio);

  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  const padding = { top: 18, right: 18, bottom: 42, left: 64 };
  const chartWidth = cssWidth - padding.left - padding.right;
  const chartHeight = cssHeight - padding.top - padding.bottom;
  context.strokeStyle = chartLine;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(padding.left, padding.top);
  context.lineTo(padding.left, padding.top + chartHeight);
  context.lineTo(padding.left + chartWidth, padding.top + chartHeight);
  context.stroke();

  if (!rows.length) {
    const emptyMessage =
      isQuotaPreset(range?.preset) && range?.quotaState !== "available"
        ? range?.quotaReason || QUOTA_UI_COPY.waiting
        : "没有匹配的用量记录";
    context.fillStyle = chartText;
    context.font = timelineLabelFont;
    context.fillText(localizeText(emptyMessage), padding.left + 12, padding.top + 28);
    if (isQuotaPreset(range?.preset) && range?.quotaState !== "available") {
      canvas.dataset.chartAriaLabel = localizeText(emptyMessage);
      canvas.setAttribute?.("aria-label", localizeText(emptyMessage));
    }
    timelineBars.set(canvas, []);
    return;
  }

  const breakdownReady = timelineBreakdownReady(rows, mode);
  if (!breakdownReady) {
    const action = isStaticSnapshot() ? "请重新导出快照" : "请重启服务";
    const message = `${mode === "model" ? "模型" : "费用"}明细不可用，${action}`;
    context.fillStyle = chartText;
    context.font = timelineLabelFont;
    context.fillText(localizeText(message), padding.left + 12, padding.top + 28);
    canvas.dataset.chartAriaLabel = localizeText(message);
    canvas.setAttribute?.("aria-label", localizeText(message));
    timelineBars.set(canvas, []);
    return;
  }

  const values = rows.map((row) => timelineValue(row, mode));
  const max = maxTimelineValue(values);
  const scaleMax = max || 1;
  const slotWidth = chartWidth / Math.max(rows.length, 1);
  const barWidth = Math.min(slotWidth, Math.max(Math.min(1, slotWidth), Math.min(30, slotWidth * 0.72)));
  const bars = [];
  rows.forEach((row, index) => {
    if (row.future) return;
    const value = values[index];
    const barHeight = value > 0 ? Math.max(2, (value / scaleMax) * chartHeight) : 0;
    const slotX = padding.left + index * slotWidth;
    const centerX = slotX + slotWidth / 2;
    const x = centerX - barWidth / 2;
    let segments;
    if (mode === "channel") {
      segments = timelineChannelSegments(row, channelRows).map((segment) => ({
        name: segment.name,
        value: usageValue(segment.total, "total"),
        color: channelColors.get(segment.name) || green,
      }));
    } else if (mode === "model") {
      segments = timelineModelSegments(row, modelRows).map((segment) => ({
        name: segment.name,
        value: usageValue(segment.total, "total"),
        color: modelColorsByName.get(segment.name) || getModelColor(segment.name),
      }));
    } else {
      segments = timelineCostSegments(row, modelRows).map((segment) => ({
        ...segment,
        color: modelColorsByName.get(segment.name) || getModelColor(segment.name),
      }));
    }
    let y = padding.top + chartHeight;
    if (mode === "channel" && value > 0 && !segments.length) {
      context.fillStyle = blue;
      context.fillRect(x, y - barHeight, barWidth, barHeight);
    }
    for (const segment of segments) {
      if (!(segment.value > 0)) continue;
      const segmentHeight = (segment.value / value) * barHeight;
      y -= segmentHeight;
      context.fillStyle = segment.color;
      context.fillRect(x, y, barWidth, Math.max(0.5, segmentHeight));
    }
    bars.push({ x: slotX, y: padding.top, width: slotWidth, height: chartHeight, row });
  });
  timelineBars.set(canvas, bars);

  context.fillStyle = chartText;
  context.font = timelineAxisFont;
  // 纵轴数值右对齐贴住坐标轴，各模式保持一致（含按花销的金额标签）。
  context.textAlign = "right";
  const axisLabelX = padding.left - 10;
  if (mode === "cost") {
    // 柱高按统一标尺折算（见 scaledCost），轴标签用同一标尺的币种。
    context.fillText(formatPreciseCost(max, state.costScaleTarget), axisLabelX, padding.top + 8);
    context.fillText(formatPreciseCost(0, state.costScaleTarget), axisLabelX, padding.top + chartHeight);
  } else {
    context.fillText(formatCompact(max), axisLabelX, padding.top + 8);
    context.fillText("0", axisLabelX, padding.top + chartHeight);
  }
  context.textAlign = "left";

  const bucket = range?.bucket || state.bucket;
  // 刻度密度按旋转后的实际文字占位估算：固定 68px 会高估"01"这类窄标签的宽度，
  // 把放得下的刻度（如 13 天的"全部"视图）误判成超容。
  context.font = timelineAxisFont;
  const tickFootprint = rows.reduce((widest, row) => {
    const width = context.measureText(shortTimelineLabel(row.key, bucket, range)).width;
    return Math.max(
      widest,
      width * Math.cos(TIMELINE_TICK_TILT) + TIMELINE_AXIS_FONT_PX * Math.sin(TIMELINE_TICK_TILT),
    );
  }, 0);
  const labels = timelineAxisLabels(rows, {
    bucket,
    range,
    chartWidth,
    maxLabels: Math.max(1, Math.floor(chartWidth / (tickFootprint + TIMELINE_TICK_GAP))),
  });
  for (const label of labels) {
    const centerX = padding.left + label.index * slotWidth + slotWidth / 2;
    context.save();
    context.translate(centerX, padding.top + chartHeight + 18);
    context.rotate(-Math.PI / 8);
    // 刻度文字以槽位中心（柱心）为对齐原点，否则左对齐绘制会整体偏右。
    context.textAlign = "center";
    context.fillText(label.label, 0, 0);
    context.restore();
  }
}

function timelineRowAt(canvas, event) {
  const bars = timelineBars.get(canvas) || [];
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const hit = bars.find((bar) => x >= bar.x && x <= bar.x + bar.width && y >= bar.y && y <= bar.y + bar.height);
  return hit?.row || null;
}

function setupUsageTooltip() {
  const timelineChart = $("#timelineChart");
  timelineChart.addEventListener("pointermove", (event) => {
    const row = timelineRowAt(timelineChart, event);
    if (row) {
      showTimelineTooltip(row, event);
      return;
    }
    hideUsageTooltip();
  });
  timelineChart.addEventListener("pointerleave", hideUsageTooltip);
  timelineChart.addEventListener("focus", () => {
    const bars = timelineBars.get(timelineChart) || [];
    if (!bars.length) return;
    timelineFocusIndex.set(timelineChart, 0);
    showTimelineTooltip(bars[0].row, timelineChart);
  });
  timelineChart.addEventListener("keydown", (event) => {
    const bars = timelineBars.get(timelineChart) || [];
    if (!bars.length) return;
    let index = timelineFocusIndex.get(timelineChart) || 0;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") index = Math.min(bars.length - 1, index + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") index = Math.max(0, index - 1);
    else if (event.key === "Home") index = 0;
    else if (event.key === "End") index = bars.length - 1;
    else if (event.key === "Escape") {
      hideUsageTooltip();
      return;
    } else return;
    event.preventDefault();
    timelineFocusIndex.set(timelineChart, index);
    showTimelineTooltip(bars[index].row, timelineChart);
  });
  timelineChart.addEventListener("blur", () => {
    timelineChart.setAttribute("aria-label", timelineChart.dataset.chartAriaLabel || "時間分布圖");
    hideUsageTooltip();
  });

  document.addEventListener("pointermove", (event) => {
    if (event.target === timelineChart) {
      return;
    }
    const target = event.target.closest?.("[data-usage-tooltip]");
    if (!target) {
      hideUsageTooltip();
      return;
    }
    const bound = tooltipRows.get(target);
    showUsageTooltip(bound?.row, event, bound?.options);
  });
  document.addEventListener("pointerleave", hideUsageTooltip);
  document.addEventListener("focusin", (event) => {
    const target = event.target.closest?.("[data-usage-tooltip]");
    if (!target) {
      return;
    }
    const bound = tooltipRows.get(target);
    showUsageTooltip(bound?.row, target, bound?.options);
  });
  document.addEventListener("focusout", (event) => {
    if (event.target.closest?.("[data-usage-tooltip]")) {
      hideUsageTooltip();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !event.target.closest?.("[data-usage-tooltip]") ||
      (event.key !== "PageDown" && event.key !== "PageUp")
    ) {
      return;
    }
    const delta = (event.key === "PageDown" ? 1 : -1) * (usageTooltip()?.clientHeight || 0) * 0.75;
    if (scrollUsageTooltip(delta)) event.preventDefault();
  });
  document.addEventListener(
    "wheel",
    (event) => {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        !event.target.closest?.("[data-usage-tooltip]")
      )
        return;
      if (scrollUsageTooltip(event.deltaY)) event.preventDefault();
    },
    { passive: false },
  );
}

function homeStatusLabel(home) {
  // Convert machine-friendly scan states into compact dashboard labels.
  if (home.type === "unsupported" || home.status === "unsupported") {
    return "不可用";
  }
  if (home.status === "active" && home.eventCount > 0) {
    return "有用量记录";
  }
  if (home.status === "no-events") {
    return "无用量记录";
  }
  return "可扫描";
}

function homeRowsFromMetadata(metadata) {
  // Preserve unsupported stored imports so users can remove or fix them.
  const homes = [...(metadata.homes || [])];
  const seen = new Set(homes.map((home) => home.path));
  for (const entry of metadata.imports || []) {
    if (seen.has(entry.path)) {
      continue;
    }
    homes.push({
      ...entry,
      label: entry.label || entry.path,
      kind: entry.type,
      imported: true,
      status: entry.type === "unsupported" ? "unsupported" : "active",
      eventCount: 0,
      sessionCount: 0,
    });
  }
  return homes;
}

export function renderSourceOptionsHtml(homes, excludedIds = []) {
  // 数据来源多选：取消勾选的来源不计入用量统计。文本与路径转义后渲染。
  const excluded = new Set(excludedIds || []);
  const sources = (homes || []).filter((home) => home.id);
  if (!sources.length) {
    return `<div class="empty">没有可统计的来源</div>`;
  }
  return sources
    .map((home) => {
      const id = escapeHtml(home.id);
      const label = escapeHtml(home.label || home.path || home.id);
      const kind = escapeHtml(home.kind || home.type || "");
      const status = escapeHtml(homeStatusLabel(home));
      const pathText = escapeHtml(home.path || "");
      const counts = `${formatTokens(home.eventCount || 0)} 条事件 · ${formatTokens(home.sessionCount || 0)} 个会话`;
      const isExcluded = excluded.has(home.id);
      const checked = isExcluded ? "" : " checked";
      const excludedBadge = isExcluded ? `<span class="home-excluded">不计入统计</span>` : "";
      return `
        <label class="source-option${isExcluded ? " excluded" : ""}">
          <input type="checkbox" data-source-id="${id}"${checked} />
          <span class="source-option-text">
            <span class="source-option-label"><strong>${label}</strong><span class="home-kind">${kind}</span></span>
            <span class="source-option-meta"><span class="home-status">${status}</span><span>${counts}</span>${excludedBadge}</span>
            <span class="source-option-path" title="${pathText}">${pathText}</span>
          </span>
        </label>
      `;
    })
    .join("");
}

export function renderHomesHtml(homes, { canModify = false, excludedIds = [] } = {}) {
  // Render paths and labels as escaped text because they may come from imported logs.
  if (!homes.length) {
    return `<div class="empty">没有发现 Codex、ZCode、DSH 或 OpenCode 目录</div>`;
  }
  const excluded = new Set(excludedIds || []);
  return homes
    .map((home) => {
      const label = escapeHtml(home.label);
      const kind = escapeHtml(home.kind || home.type || "");
      const status = escapeHtml(homeStatusLabel(home));
      const pathText = escapeHtml(home.path);
      const reason = home.reason ? `<div class="home-reason">${escapeHtml(home.reason)}</div>` : "";
      const counts = `${formatTokens(home.eventCount || 0)} 条事件 · ${formatTokens(home.sessionCount || 0)} 个会话`;
      const removeButton =
        canModify && home.imported
          ? `<button class="home-remove" type="button" data-import-action="remove" data-import-path="${pathText}" aria-label="移除 ${label}">移除</button>`
          : "";
      const isExcluded = Boolean(home.id) && excluded.has(home.id);
      const excludedBadge = isExcluded ? `<span class="home-excluded">不计入统计</span>` : "";
      return `
        <div class="home-row${isExcluded ? " excluded" : ""}">
          <div class="home-label">
            <strong>${label}</strong>
            <span class="home-kind">${kind}</span>
          </div>
          <div class="home-meta">
            <span class="home-status">${status}</span>
            <span>${counts}</span>
            ${excludedBadge}
            ${removeButton}
          </div>
          <div class="home-path" title="${pathText}">${pathText}</div>
          ${reason}
        </div>
      `;
    })
    .join("");
}

function renderHomes(homes, options = {}) {
  const container = $("#homeList");
  container.innerHTML = renderHomesHtml(homes, options);
}

// harness 归组顺序。Codex 优先，便于 gpt 系模型归到最相关一侧。
const HARNESS_ORDER = ["Codex", "ZCode", "DSH", "OpenCode"];

/** 渠道名 → harness 桶名。ZCode、DSH 与 OpenCode 都用自己的渠道前缀，其余归 Codex。 */
function bucketForChannel(channel) {
  const name = String(channel || "").toLowerCase();
  if (name.startsWith("zcode")) return "ZCode";
  if (name.startsWith("dsh")) return "DSH";
  if (name.startsWith("opencode")) return "OpenCode";
  return "Codex";
}

function newHarnessModelBuckets() {
  return Object.fromEntries(HARNESS_ORDER.map((harness) => [harness, new Set()]));
}

function harnessModelLists(buckets) {
  return Object.fromEntries(
    HARNESS_ORDER.map((harness) => [harness, [...(buckets[harness] || [])].sort((a, b) => a.localeCompare(b))]),
  );
}

/**
 * 同一个模型可能被多个 harness 用到（例如 ZCode 与 DSH 都跑 deepseek-flash）。
 * 计价弹窗按 harness 分区展示，若不去重，同一个模型会在多个分区里重复出现。
 * 这里按 HARNESS_ORDER 先到先得：一个模型只留在它遇到的第一个分区里。
 * @param {Record<string, Set<string>>} groups
 */
export function claimHarnessKeys(groups) {
  const claimed = new Set();
  const ordered = Object.fromEntries(HARNESS_ORDER.map((harness) => [harness, new Set()]));
  for (const harness of HARNESS_ORDER) {
    for (const key of groups[harness] || []) {
      if (claimed.has(key)) continue;
      claimed.add(key);
      ordered[harness].add(key);
    }
  }
  return ordered;
}

function metadataFromReport(report) {
  const homeStats = new Map();
  const harnessModels = newHarnessModelBuckets();
  for (const event of report.events) {
    const current = homeStats.get(event.homeId) || {
      eventCount: 0,
      sessions: new Set(),
    };
    current.eventCount += 1;
    current.sessions.add(event.sessionId);
    homeStats.set(event.homeId, current);
    const model = String(event.model || "").trim();
    if (model && model.toLocaleLowerCase() !== "unknown model") {
      harnessModels[bucketForChannel(event.channel)].add(model);
    }
  }
  return {
    generatedAt: report.generatedAt,
    eventCount: report.events.length,
    sessionCount: report.sessions.length,
    harnessModels: harnessModelLists(harnessModels),
    homes: report.homes.map((home) => {
      const stats = homeStats.get(home.id) || { eventCount: 0, sessions: new Set() };
      return {
        ...home,
        status: stats.eventCount > 0 ? "active" : "no-events",
        eventCount: stats.eventCount,
        sessionCount: stats.sessions.size,
      };
    }),
    warnings: report.warnings || [],
  };
}

let staticSummaryCache = null;

function currentSummary() {
  if (state.report) {
    const nowKey = state.now ? new Date(state.now).getTime() : Math.floor(Date.now() / 60_000);
    const excludedKey = [...(state.excludedHomes || [])].map(String).sort().join(",");
    const key = [
      state.preset,
      state.bucket,
      state.startDate,
      state.endDate,
      state.recentValue,
      state.calendarZone,
      excludedKey,
      nowKey,
    ].join("|");
    if (staticSummaryCache?.report === state.report && staticSummaryCache.key === key)
      return staticSummaryCache.summary;
    const summary = summarize(state.report);
    staticSummaryCache = { report: state.report, key, summary };
    return summary;
  }
  return state.summary;
}

function currentMetadata() {
  return state.metadata;
}

function renderUnavailableQuota(reason, range = null) {
  hideUsageTooltip();
  const message = reason || QUOTA_UI_COPY.waiting;
  const unavailableRange = range || {
    preset: state.preset,
    quotaState: "waiting",
    quotaReason: message,
    asOf: state.quotaSnapshot?.asOf || state.now,
    bucket: state.preset === "quota_5h" ? "quota_30m" : "quota_24h",
  };
  unavailableRange.quotaReason = message;
  const rangeNode = $("#rangeLabel");
  if (rangeNode) {
    rangeNode.textContent = rangeLabel({ range: unavailableRange });
    rangeNode.title = quotaRangeAccessibleLabel(unavailableRange);
  }
  for (const selector of [
    "#totalTokens",
    "#inputTokens",
    "#cachedTokens",
    "#outputTokens",
    "#reasoningTokens",
    "#sessionCount",
    "#totalCost",
    "#inputCost",
    "#cachedInputCost",
    "#outputCost",
    "#cacheHitRate",
    "#priceModelCount",
  ]) {
    const node = $(selector);
    if (node) {
      node.textContent = "—";
      node.title = "";
    }
  }
  for (const card of document.querySelectorAll(".metric")) {
    card.title = "";
    const badge = card.querySelector(".metric-new");
    if (badge) badge.hidden = true;
  }
  const comparison = $("#comparisonSummary");
  if (comparison) {
    comparison.hidden = true;
    comparison.innerHTML = "";
  }
  const warning = $("#timelineRangeWarning");
  if (warning) {
    warning.hidden = true;
    warning.textContent = "";
  }
  const legend = $("#timelineLegend");
  if (legend) legend.innerHTML = "";
  const detailList = $("#detailList");
  if (detailList) detailList.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  drawTimeline($("#timelineChart"), [], [], new Map(), unavailableRange, state.timelineMode);
  updateTimelineModeButtons();
  updateQuotaPresetButton();
  updateDateRangeControl();
}

function render() {
  const summary = currentSummary();
  const metadata = currentMetadata();
  if (!summary || !metadata) {
    return;
  }
  const quotaWindow = summary.quota?.windows?.[state.preset];
  const quotaState = summary.range?.quotaState ?? quotaWindow?.state;
  const quotaReason =
    quotaWindow?.reason && getLocale() === "en-US"
      ? localizeQuotaReason(quotaWindow)
      : (summary.range?.quotaReason ?? quotaWindow?.reason);
  if (isQuotaPreset(state.preset) && quotaState !== "available") {
    renderUnavailableQuota(quotaReason || QUOTA_UI_COPY.waiting, {
      ...summary.range,
      quotaState: quotaState || "missing",
      quotaReason: quotaReason || QUOTA_UI_COPY.waiting,
    });
    renderPeriodComparisons(state.periodComparison);
    renderHomes(homeRowsFromMetadata(metadata), { canModify: !isStaticSnapshot(), excludedIds: state.excludedHomes });
    translatePage();
    return;
  }
  hideUsageTooltip();
  renderMetrics(summary);
  const quotaMode = isQuotaPreset(summary.range?.preset || state.preset) || Boolean(summary.range?.quotaWindow);
  const comparisonStrip = $("#comparisonSummary");
  if (comparisonStrip) comparisonStrip.hidden = quotaMode;
  if (quotaMode) comparisonStrip.innerHTML = "";
  else renderComparison(summary);
  renderPeriodComparisons(state.periodComparison);
  const rangeNode = $("#rangeLabel");
  rangeNode.textContent = rangeLabel(summary);
  const rangeStart = asDate(summary.range.start);
  const rangeEnd = asDate(summary.range.end);
  rangeNode.title = quotaMode
    ? quotaRangeAccessibleLabel(summary.range)
    : rangeStart && rangeEnd
      ? summary.range.calendarZone === "utc"
        ? `${rangeStart.toISOString()} 至 ${rangeEnd.toISOString()}`
        : `${rangeStart.toLocaleString(getLocale())} 至 ${rangeEnd.toLocaleString(getLocale())}`
      : rangeNode.textContent;
  const timelineWarning = $("#timelineRangeWarning");
  if (timelineWarning) {
    timelineWarning.hidden = !summary.timelineError;
    timelineWarning.textContent = summary.timelineError
      ? `此范围超过 ${MAX_TIMELINE_SLOTS.toLocaleString(getLocale())} 个时间槽，无法生成时间分布。请缩短日期范围。`
      : "";
  }
  const channelColors = getChannelColors(summary.channels);
  const allPeriodModels = state.periodComparison?.models || [];
  const modelColors = getModelColors([...allPeriodModels, ...summary.models]);
  renderTimelineDetails(summary, channelColors, modelColors);
  renderTimelineLegend(summary, channelColors, modelColors);
  updateTimelineModeButtons();
  renderHomes(homeRowsFromMetadata(metadata), { canModify: !isStaticSnapshot(), excludedIds: state.excludedHomes });
  if (!$("#importDialog")?.hidden) {
    // 数据先于弹窗就绪时，让弹窗里的来源多选同步最新列表。
    renderSourceOptions();
  }
  drawTimeline(
    $("#timelineChart"),
    summary.timeline,
    summary.channels,
    channelColors,
    summary.range,
    state.timelineMode,
    summary.models,
    modelColors,
  );
  updateQuotaPresetButton();
  translatePage();
}

function setAutoRefreshStatus(message, { error = false } = {}) {
  const node = document.querySelector("#autoRefreshError");
  if (!node) return;
  node.textContent = message || "";
  node.classList.toggle("is-error", error);
}

function readAutoRefreshPreference() {
  try {
    return localStorage.getItem(AUTO_REFRESH_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function persistAutoRefreshPreference(enabled) {
  try {
    localStorage.setItem(AUTO_REFRESH_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // The current page still honors the choice when storage is unavailable.
  }
}

function renderAutoRefreshControls() {
  const button = document.querySelector("#autoRefreshToggle");
  if (!button) return;
  const staticSnapshot = isStaticSnapshot();
  button.disabled = staticSnapshot;
  button.textContent = state.autoRefreshEnabled && !staticSnapshot ? "开" : "关";
  button.setAttribute("aria-pressed", String(state.autoRefreshEnabled && !staticSnapshot));
  button.title = staticSnapshot ? "静态快照不能启动轮询" : "切换自动刷新";
  document.querySelector("#autoRefreshInterval").textContent = staticSnapshot
    ? "静态快照，不轮询"
    : `${AUTO_REFRESH_INTERVAL_MS / 1000}s`;
  const checked = state.lastSuccessfulCheck ? new Date(state.lastSuccessfulCheck) : null;
  document.querySelector("#lastSuccessfulCheck").textContent =
    checked && !Number.isNaN(checked.getTime())
      ? `上次：${formatAutoRefreshTimestamp(checked, getLocale(), state.calendarZone)}`
      : "上次：尚无";
}

export function formatAutoRefreshTimestamp(value, locale = "zh-CN", calendarZone = "local") {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const timeZone = calendarZone === "utc" ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
    timeZoneName: "short",
  }).format(date);
}

function setAutoRefreshEnabled(enabled, { persist = true, checkNow = true } = {}) {
  if (isStaticSnapshot()) {
    state.autoRefreshEnabled = false;
    renderAutoRefreshControls();
    return;
  }
  state.autoRefreshEnabled = Boolean(enabled);
  state.autoRefreshRunId += 1;
  state.autoRefreshCheckInFlight = false;
  state.usageLoadId += 1;
  if (persist) persistAutoRefreshPreference(state.autoRefreshEnabled);
  if (state.autoRefreshEnabled) {
    state.snapshotId = null;
    startAutoRefresh();
    setAutoRefreshStatus(checkNow ? "已开启，正在检查…" : "");
    if (checkNow) void loadUsage();
  } else {
    stopAutoRefresh();
    setAutoRefreshStatus("已关闭");
    void loadUsage({ skipCheck: true, freeze: true });
  }
  renderAutoRefreshControls();
}

function initializeAutoRefresh() {
  state.autoRefreshEnabled = isStaticSnapshot() ? false : readAutoRefreshPreference();
  renderAutoRefreshControls();
  if (isStaticSnapshot()) {
    setAutoRefreshStatus("此静态快照不会轮询；运行 npm run export 可生成新快照");
  }
}

const PRICING_FIELDS = [
  ["input", "缓外输入"],
  ["cachedInput", "缓存输入"],
  ["cacheWrite", "缓存写入"],
  ["output", "输出"],
];

function setPricingMessage(message, isError = false) {
  const element = $("#pricingMessage");
  element.textContent = message;
  element.classList.toggle("error", isError);
}

export function automaticPricingStatusText(status = {}, locale = "zh-CN", fallbackTotal = 0) {
  const english = locale === "en-US";
  const updatedAt = status.priceUpdatedAt ? new Date(status.priceUpdatedAt) : null;
  const price = updatedAt && Number.isFinite(updatedAt.getTime()) ? dateKey(updatedAt) : null;
  const matched = status.automaticModelCount ?? 0;
  const total = status.totalModelCount ?? fallbackTotal;
  const partial = status.partialAutomaticModelCount ?? 0;
  const sourceCoverage = status.priceSourceCoverage || {};
  const usdSourceMapped = sourceCoverage.supportedUsdModelCount ?? sourceCoverage.supportedModelCount ?? 0;
  const cnySourceMapped = sourceCoverage.supportedCnyModelCount ?? 0;
  const unsupportedCurrency = sourceCoverage.unsupportedCurrencyModelCount ?? 0;
  const manualModels = status.manualModelCount ?? status.manualModels?.length ?? 0;
  const numberLocale = english ? "en-US" : "zh-CN";
  const formatRate = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0
      ? new Intl.NumberFormat(numberLocale, { maximumFractionDigits: 4 }).format(number)
      : null;
  };
  const automaticRate = formatRate(status.automaticUsdToCnyRate);
  const effectiveRate = formatRate(status.effectiveUsdToCnyRate);
  const exchangeRate = english
    ? `${status.manualExchangeRate ? `auto ${automaticRate || "built-in"} · current ${effectiveRate || "built-in"} (manual)` : `current ${effectiveRate || automaticRate || "built-in"}`} · quote date ${status.exchangeRateDate || "built-in"}`
    : `${status.manualExchangeRate ? `自动 ${automaticRate || "内置"} · 当前 ${effectiveRate || "内置"}（手动）` : `当前 ${effectiveRate || automaticRate || "内置"}`} · 报价日期 ${status.exchangeRateDate || "内置"}`;
  return english
    ? `Model prices: ${price || "built-in"} (auto-maintained ${matched}/${total}, partial ${partial}, manual overrides ${manualModels}) · USD source mappings ${usdSourceMapped}/${total}, CNY adapters ${cnySourceMapped}, CNY manual-only ${unsupportedCurrency} · USD/CNY: ${exchangeRate}`
    : `模型价：${price || "内置"}（自动维护 ${matched}/${total}，部分 ${partial}，手动覆盖 ${manualModels}）· USD 来源适配 ${usdSourceMapped}/${total}，CNY 官方源 ${cnySourceMapped} 条，暂保留本地 ${unsupportedCurrency} 条 · 美元兑人民币：${exchangeRate}`;
}

export function usagePricingCoverageText(coverage = {}, locale = "zh-CN") {
  const english = locale === "en-US";
  if (!coverage.ready)
    return english ? "Waiting for usage data before checking coverage." : "等待用量加载，暂不能确认计价覆盖。";
  const used = coverage.usedModelCount || 0;
  const matched = coverage.matchedUsedModelCount || 0;
  const missing = coverage.missingUsedModels?.length ?? Math.max(0, used - matched);
  const free = coverage.freeRuleUsedModelCount || 0;
  return english
    ? `Usage coverage ${matched}/${used} · missing rates ${missing} · free-rule models ${free}`
    : `用量覆盖 ${matched}/${used} · 缺少费率 ${missing} · 免费规则 ${free}`;
}

export function pricingUpdateSummaryText(summary = {}, locale = "zh-CN") {
  const english = locale === "en-US";
  const verified = summary.verifiedModelCount ?? 0;
  const attempted = summary.attemptedModelCount ?? 0;
  const changed = summary.changedModelCount ?? 0;
  const partial = summary.partialModelCount ?? 0;
  const conflicts = summary.conflictModelCount ?? 0;
  const manual = summary.manualOverrideModelCount ?? 0;
  const noMatch = summary.noValidMatchModelCount ?? 0;
  const cny = summary.unsupportedCurrencyModelCount ?? 0;
  return english
    ? `Price check: verified ${verified}/${attempted}, changed ${changed}, partial ${partial}, conflicts ${conflicts}, manual overrides ${manual}, no valid source match ${noMatch}; CNY entries kept local ${cny}`
    : `本次计价：核验 ${verified}/${attempted}，变化 ${changed}，部分 ${partial}，冲突 ${conflicts}，受手动覆盖 ${manual}，未命中有效来源 ${noMatch}；CNY 本地保留 ${cny}`;
}

function renderAutomaticRateRestoreControl() {
  const button = $("#restoreAutomaticRateButton");
  if (!button) return;
  button.hidden = state.pricingCatalog?.automatic?.manualExchangeRate !== true;
  button.setAttribute("aria-pressed", String(state.restoreAutomaticExchangeRate === true));
}

function renderAutomaticPricingStatus(status = {}, coverage = undefined) {
  const node = $("#pricingAutomaticStatus");
  if (!node) return;
  node.textContent = automaticPricingStatusText(
    status,
    getLocale(),
    Object.keys(state.pricingCatalog?.models || {}).length,
  );
  const coverageNode = $("#pricingUsageCoverage");
  if (coverageNode) {
    let resolvedCoverage = coverage ?? state.pricingCatalog?.usageCoverage;
    if (!resolvedCoverage && state.metadata?.harnessModels) {
      resolvedCoverage = buildUsagePricingCoverage(
        state.metadata.harnessModels,
        state.pricingCatalog?.models || {},
        true,
      );
    }
    coverageNode.textContent = usagePricingCoverageText(resolvedCoverage || {}, getLocale());
  }
}

export function pricingIssueText(issue, english) {
  const source = !english && issue.source === "Xiaomi MiMo" ? "小米 MiMo" : issue.source;
  if (issue.code === "timeout") {
    const seconds = issue.timeoutMs ? `（${issue.timeoutMs / 1000} 秒）` : "";
    return english
      ? `${source} timed out${issue.timeoutMs ? ` after ${issue.timeoutMs / 1000}s` : ""}`
      : `${source} 请求超时${seconds}`;
  }
  return `${source}：${issue.message}`;
}

export function discoveryReasonText(reason, english) {
  const labels = english
    ? {
        "not-found": "not listed by either price source",
        "unsupported-provider": "not a supported OpenAI text model",
        "incomplete-rates": "required input, cache, or output rates are missing",
        "context-policy-unknown": "context pricing policy is unknown",
        "unsupported-context-policy": "multiple context tiers are not supported",
        conflict: "the price sources disagree",
        "catalog-capacity": "the 100-model catalog limit was reached",
        timeout: "price source timed out",
        "source-error": "price sources could not be read",
        "retry-after": "retry is available after one hour",
        "usage-not-ready": "waiting for usage indexing",
        error: "discovery failed",
      }
    : {
        "not-found": "两个价目来源都没有该模型",
        "unsupported-provider": "不是支持的 OpenAI 文本模型",
        "incomplete-rates": "缺少输入、缓存或输出必需费率",
        "context-policy-unknown": "上下文计价规则不明确",
        "unsupported-context-policy": "暂不支持多个上下文档位",
        conflict: "两个价目来源存在冲突",
        "catalog-capacity": "已达到 100 个模型上限",
        timeout: "价目来源请求超时",
        "source-error": "无法读取价目来源",
        "retry-after": "一小时后可重试",
        "usage-not-ready": "等待用量索引就绪",
        error: "自动发现失败",
      };
  return labels[reason] || reason || (english ? "unknown result" : "未知结果");
}

export function pricingProvenanceText(metadata = {}, locale = "zh-CN") {
  const english = locale === "en-US";
  const labels = {
    short: english ? "Standard short" : "标准短上下文",
    long: english ? "Standard long" : "标准长上下文",
    "fast.short": english ? "Fast short" : "快速短上下文",
    "fast.long": english ? "Fast long" : "快速长上下文",
  };
  const origins = english
    ? { remote: "remote", "built-in": "built-in", derived: "derived from Standard ×2", mixed: "mixed" }
    : { remote: "远端来源", "built-in": "内置价目", derived: "由标准费率推算 ×2", mixed: "混合来源" };
  const fieldLabels = english
    ? { input: "input", cachedInput: "cache read", cacheWrite: "cache write", output: "output" }
    : { input: "输入", cachedInput: "缓存读取", cacheWrite: "缓存写入", output: "输出" };
  return Object.entries(labels)
    .filter(([tier]) => metadata[tier])
    .map(([tier, label]) => {
      const item = metadata[tier];
      const details = [origins[item.origin] || item.origin || (english ? "unknown" : "未知")];
      if (item.sourceUrl) {
        try {
          details.push(new URL(item.sourceUrl).hostname);
        } catch {
          details.push(item.sourceUrl);
        }
      }
      if (item.inheritedFields?.length) {
        details.push(
          (english ? "inherited " : "沿用") +
            item.inheritedFields.map((field) => fieldLabels[field] || field).join(", "),
        );
      }
      const inheritedSources =
        item.inheritedFields
          ?.map((field) => {
            const inherited = item.inheritedFrom?.[field];
            if (!inherited) return "";
            let source = inherited.origin || (english ? "previous rate" : "原费率");
            if (inherited.sourceUrl) {
              try {
                source = new URL(inherited.sourceUrl).hostname;
              } catch {
                source = inherited.sourceUrl;
              }
            }
            return `${fieldLabels[field] || field} ← ${source}`;
          })
          .filter(Boolean) || [];
      if (inheritedSources.length) details.push(inheritedSources.join(", "));
      if (item.checkedAt) details.push(item.checkedAt.slice(0, 10));
      if (item.conflicts?.length) details.push(english ? "conflict retained previous rate" : "冲突时保留原费率");
      return `${label}: ${details.join(" · ")}`;
    })
    .join(english ? "; " : "；");
}

async function refreshPricingAutomatically(force = false) {
  if (isStaticSnapshot() || (state.pricingCatalog && !force)) return;
  const button = $("#refreshPricingButton");
  if (button) button.disabled = true;
  if (force && state.pricingCatalog)
    setPricingMessage(getLocale() === "en-US" ? "Updating prices and exchange rate…" : "正在更新价目与汇率…");
  try {
    const response = await fetch("/api/pricing/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(localizeServerError(result, response.status));
    if (state.pricingCatalog) state.pricingCatalog.automatic = result;
    if (result.changed || result.statusChanged) {
      if (state.pricingCatalog) {
        const catalogResponse = await fetch("/api/pricing");
        if (!catalogResponse.ok) throw new Error(`HTTP ${catalogResponse.status}`);
        const catalog = await catalogResponse.json();
        state.pricingCatalog = catalog;
        $("#usdToCnyRate").value = String(catalog.usdToCnyRate);
        state.restoreAutomaticExchangeRate = false;
        renderAutomaticRateRestoreControl();
      }
      if (result.changed) await loadUsage({ skipCheck: true });
    }
    if (state.pricingCatalog) {
      renderAutomaticPricingStatus(state.pricingCatalog.automatic || result, state.pricingCatalog.usageCoverage);
      renderPricingModelList();
      const english = getLocale() === "en-US";
      const issueMessages = result.issues?.length
        ? result.issues.map((issue) => pricingIssueText(issue, english)).join(english ? "; " : "；")
        : result.errors?.join(english ? "; " : "；");
      const discoveryResults = result.discovery?.results || [];
      const discoveryAdded = result.discovery?.addedModels?.length || 0;
      const discoveryDetails = discoveryResults
        .filter((item) => ["deferred", "rejected", "error"].includes(item.status))
        .map((item) => `${item.model}: ${discoveryReasonText(item.reason, english)}`)
        .join(english ? "; " : "；");
      const discoveryMessage = [
        discoveryAdded
          ? english
            ? `Added ${discoveryAdded} model rate(s)`
            : `已新增 ${discoveryAdded} 个模型费率`
          : "",
        discoveryDetails,
      ]
        .filter(Boolean)
        .join(english ? "; " : "；");
      const details = [issueMessages, discoveryMessage].filter(Boolean).join(english ? "; " : "；");
      const message = details
        ? english
          ? `${result.pricesUpdated || result.exchangeRateUpdated || discoveryAdded ? "Partially updated" : "Update incomplete; using saved rates"}: ${details}.`
          : `${result.pricesUpdated || result.exchangeRateUpdated || discoveryAdded ? "部分更新完成" : "更新未完成，继续使用已有费率"}：${details}。`
        : force
          ? result.changed || result.statusChanged
            ? getLocale() === "en-US"
              ? result.changed
                ? "Update complete. Unsaved edits were reset."
                : "Status checked. Rates are unchanged."
              : result.changed
                ? "更新完成；未保存的编辑已重置。"
                : "状态已检查，费率未变化。"
            : getLocale() === "en-US"
              ? "Checked. Rates are unchanged."
              : "已检查，费率未变化。"
          : "";
      const summaryMessage = force ? pricingUpdateSummaryText(result.priceUpdateSummary, getLocale()) : "";
      setPricingMessage([message, summaryMessage].filter(Boolean).join(english ? " · " : "；"), Boolean(issueMessages));
    }
  } catch (error) {
    if (state.pricingCatalog)
      setPricingMessage(
        getLocale() === "en-US" ? `Automatic update failed: ${error.message}` : `自动更新失败：${error.message}`,
        true,
      );
  } finally {
    if (button) button.disabled = false;
  }
}

function pricingModelNoteParts(contexts) {
  const parts = [];
  if (Number.isInteger(contexts.longContextThreshold))
    parts.push(`单次输入超过 ${formatTokens(contexts.longContextThreshold)} tokens 按长上下文价`);
  if (Number.isInteger(contexts.outputThreshold))
    parts.push(`输出达到 ${formatTokens(contexts.outputThreshold)} tokens 起按长输出价`);
  if (contexts.offPeakMultiplier)
    parts.push(
      `谷时按 ${Number((contexts.offPeakMultiplier * 10).toFixed(2))} 折计（北京时间工作日 9:00-12:00、14:00-18:00 为高峰，节假日未建模按高峰计）`,
    );
  return parts;
}

function pricingModelHint(contexts) {
  const short = contexts.short || {};
  const parts = [`${short.input ?? "?"}/${short.cachedInput ?? "?"}/${short.output ?? "?"}（入/缓/出）`];
  if (Number.isInteger(contexts.longContextThreshold))
    parts.push(`上下文 ${formatTokens(contexts.longContextThreshold)} 分档`);
  if (Number.isInteger(contexts.outputThreshold)) parts.push(`输出 ${formatTokens(contexts.outputThreshold)} 分档`);
  if (contexts.offPeakMultiplier) parts.push(`谷时 ${Number((contexts.offPeakMultiplier * 10).toFixed(2))} 折`);
  if (contexts.fast) parts.push("快速模式价");
  return parts.join(" · ");
}

function pricingContextsHtml(model, contexts) {
  const contextBlock = (context, label, source) => `
      <div class="pricing-context">
        <strong>${label}</strong>
        ${PRICING_FIELDS.map(
          ([field, fieldLabel]) => `
          <label>${fieldLabel}<input type="number" min="0" step="any" required
            data-model="${escapeHtml(model)}" data-context="${context}" data-field="${field}"
            value="${escapeHtml(source[field])}" /></label>
        `,
        ).join("")}
      </div>
    `;
  const standard = ["short", "shortLongOutput", "long"]
    .filter((context) => contexts[context])
    .map((context) =>
      contextBlock(
        context,
        { short: "短上下文", shortLongOutput: "短上下文·长输出", long: "长上下文" }[context],
        contexts[context],
      ),
    )
    .join("");
  const fast = contexts.fast
    ? `<div class="pricing-fast-block"><strong>快速模式</strong><div class="pricing-contexts">${[
        "short",
        "shortLongOutput",
        "long",
      ]
        .filter((context) => contexts.fast[context])
        .map((context) =>
          contextBlock(
            `fast.${context}`,
            { short: "快速·短上下文", shortLongOutput: "快速·短上下文·长输出", long: "快速·长上下文" }[context],
            contexts.fast[context],
          ),
        )
        .join("")}</div></div>`
    : "";
  return standard + fast;
}

// 计价字段写回工作副本；fast.* 指向官方声明的快速模式费率。
function writePricingField(entry, context, field, value) {
  if (context.startsWith("fast.")) {
    const sub = context.slice(5);
    if (entry.fast?.[sub]) entry.fast[sub][field] = value;
    return;
  }
  if (entry[context]) entry[context][field] = value;
}

export function modelPricingInputsChanged(inputs) {
  const fields = [...inputs];
  return (
    fields.length > 0 &&
    fields.every((input) => input.validity.valid && input.value !== "" && Number.isFinite(Number(input.value))) &&
    fields.some((input) => Number(input.value) !== Number(input.defaultValue))
  );
}

function updateModelPricingApplyState() {
  const inputs = $("#modelPricingFields").querySelectorAll("input[data-model]");
  $("#applyModelPricingButton").disabled = !modelPricingInputsChanged(inputs);
}

// 计价条目的 harness 归属：OpenAI 价目（Codex 常用的 gpt 系）归 Codex，其余厂商归 ZCode。
function isCodexPricingModel(model, entry) {
  return model.startsWith("gpt-") || !entry?.source || entry.source.includes("developers.openai.com");
}

function pricingRowsForNames(names, catalog) {
  const rows = [];
  const seen = new Set();
  for (const raw of names) {
    const resolved = resolvePricingModel(raw, catalog);
    if (resolved.matchType === "missing" && !resolved.rawModel) continue;
    const normalized = resolved.rawModel.toLowerCase();
    const identity = resolved.catalogKey ? `catalog:${resolved.catalogKey}` : `${resolved.matchType}:${normalized}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    rows.push({ model: resolved.rawModel, catalogKey: resolved.catalogKey, matchType: resolved.matchType });
  }
  return rows;
}

export function pricingHarnessRows() {
  const catalog = state.pricingCatalog?.models || {};
  const groups = Object.fromEntries(HARNESS_ORDER.map((harness) => [harness, []]));
  const harnessModels = state.metadata?.harnessModels;
  const hasHarnessData = HARNESS_ORDER.some((harness) => (harnessModels?.[harness]?.length || 0) > 0);

  if (hasHarnessData) {
    const claimedCatalogKeys = new Set();
    for (const harness of HARNESS_ORDER) {
      const rows = pricingRowsForNames(harnessModels[harness] || [], catalog);
      groups[harness] = rows.filter((row) => {
        if (!row.catalogKey) return true;
        if (claimedCatalogKeys.has(row.catalogKey)) return false;
        claimedCatalogKeys.add(row.catalogKey);
        return true;
      });
    }
    return groups;
  }

  const names = new Set();
  for (const row of state.summary?.models || []) names.add(row.name || row.key);
  for (const row of state.periodComparison?.models || []) names.add(row.key || row.name);
  for (const row of pricingRowsForNames(names, catalog)) {
    const harness = row.catalogKey && isCodexPricingModel(row.catalogKey, catalog[row.catalogKey]) ? "Codex" : "ZCode";
    groups[harness].push(row);
  }
  return groups;
}

// 一级：在用 / 全部；在用模型下再按 Codex / ZCode / DSH 分组。
// 在用模型优先按使用记录的实际渠道归属（metadata.harnessModels），
// 服务端尚未提供该数据时按价目来源兜底分组，保证弹窗始终可用。
export function pricingHarnessGroups() {
  const rows = pricingHarnessRows();
  return Object.fromEntries(
    HARNESS_ORDER.map((harness) => [harness, new Set(rows[harness].map((row) => row.catalogKey).filter(Boolean))]),
  );
}

export function pricingModelBadges(model, automatic = {}, source = "", locale = "zh-CN") {
  const english = locale === "en-US";
  const matched = Array.isArray(automatic.automaticModels)
    ? automatic.automaticModels.includes(model)
    : String(source || "").startsWith("https://models.dev/") ||
      String(source || "").includes("raw.githubusercontent.com/BerriAI/litellm/");
  const manual = automatic.manualModels?.includes(model) || false;
  return `<span class="pricing-match-badge ${matched ? "auto" : "unmatched"}">${matched ? (english ? "Auto-matched" : "自动匹配") : english ? "Not auto-matched" : "未自动匹配"}</span>${manual ? `<span class="pricing-match-badge manual">${english ? "Manual override" : "手动覆盖"}</span>` : ""}`;
}

function renderPricingModelList() {
  const container = $("#pricingModelList");
  const catalog = state.pricingCatalog;
  if (!container || !catalog) return;
  const search = state.pricingSearch.trim().toLocaleLowerCase();
  const matches = (row) => !search || `${row.model} ${row.catalogKey || ""}`.toLocaleLowerCase().includes(search);
  const english = getLocale() === "en-US";
  const rowHtml = (row) => {
    if (row.matchType === "missing") {
      return `<div class="pricing-model-row pricing-model-unpriced" role="group" aria-label="${escapeHtml(row.model)}">
        <span class="pricing-model-name"><span class="pricing-model-id">${escapeHtml(row.model)}</span><span class="pricing-state-badge missing">${english ? "Missing rate" : "缺少费率"}</span></span>
        <span class="pricing-model-hint">${english ? "No model-specific rate; currently estimated with the lowest listed rates." : "缺少模型费率，当前按最低费率估算。"}</span>
        <button type="button" class="pricing-rematch-button" data-pricing-rematch>${english ? "Match again" : "重新匹配"}</button>
      </div>`;
    }
    if (row.matchType === "free") {
      return `<div class="pricing-model-row pricing-model-unpriced" role="group" aria-label="${escapeHtml(row.model)}">
        <span class="pricing-model-name"><span class="pricing-model-id">${escapeHtml(row.model)}</span><span class="pricing-state-badge free">${english ? "Free rule" : "免费规则"}</span></span>
        <span class="pricing-model-hint">${english ? "Estimated as free by the -free rule." : "按 -free 规则估算为免费。"}</span>
      </div>`;
    }
    const contexts = catalog.models[row.catalogKey];
    const badges = pricingModelBadges(row.catalogKey, catalog.automatic, contexts.source, getLocale());
    const priceName =
      row.model.toLowerCase() === row.catalogKey.toLowerCase()
        ? ""
        : `<span class="pricing-model-hint">${english ? "Priced as" : "计价名称"} ${escapeHtml(row.catalogKey)}</span>`;
    return `<button type="button" class="pricing-model-row" data-pricing-model="${escapeHtml(row.catalogKey)}" title="${english ? "Edit this model's rates" : "点击编辑该模型费率"}">
      <span class="pricing-model-name"><span class="pricing-model-id">${escapeHtml(row.model)}</span><span class="currency-badge">${contexts.currency === "CNY" ? "CNY" : "USD"}</span>${badges}</span>
      <span class="pricing-model-hint">${priceName || escapeHtml(pricingModelHint(contexts))}</span>
    </button>`;
  };

  if (state.pricingScope === "all") {
    const rowsByName = new Map(
      Object.keys(catalog.models).map((model) => [
        model.toLowerCase(),
        { model, catalogKey: model, matchType: "exact" },
      ]),
    );
    for (const rows of Object.values(pricingHarnessRows())) {
      for (const row of rows) {
        if (!row.catalogKey) rowsByName.set(row.model.toLowerCase(), row);
      }
    }
    const rows = [...rowsByName.values()]
      .sort((left, right) => left.model.localeCompare(right.model))
      .filter(matches)
      .map(rowHtml)
      .join("");
    container.innerHTML = rows || `<div class="empty">${search ? "没有匹配的模型" : "暂无模型"}</div>`;
    return;
  }

  const displayGroups = pricingHarnessRows();
  const sections = HARNESS_ORDER.map((harness) => {
    const rows = displayGroups[harness]
      .sort((left, right) => left.model.localeCompare(right.model))
      .filter(matches)
      .map(rowHtml)
      .join("");
    return rows ? `<div class="pricing-harness-group"><h3>${harness}</h3>${rows}</div>` : "";
  }).join("");
  container.innerHTML = sections || `<div class="empty">${search ? "没有匹配的模型" : "暂无已用到的模型"}</div>`;
}

function updatePricingScopeButtons() {
  for (const button of document.querySelectorAll("[data-pricing-scope]")) {
    const selected = button.dataset.pricingScope === state.pricingScope;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

function openModelPricing(model) {
  const entry = state.pricingCatalog?.models?.[model];
  if (!entry) return;
  state.modelPricingDraft = model;
  $("#modelPricingTitle").innerHTML =
    `${escapeHtml(model)}<span class="currency-badge">${entry.currency === "CNY" ? "CNY" : "USD"}</span>`;
  const provenance = pricingProvenanceText(state.pricingCatalog?.automatic?.modelMetadata?.[model], getLocale());
  $("#modelPricingNote").textContent = [...pricingModelNoteParts(entry), provenance].filter(Boolean).join("；");
  $("#modelPricingFields").innerHTML = pricingContextsHtml(model, entry);
  updateModelPricingApplyState();
  // 原生顶层弹窗：showModal 负责置顶、焦点圈定，关闭时焦点自动还原。
  $("#modelPricingDialog").showModal();
}

function closeModelPricing() {
  const dialog = $("#modelPricingDialog");
  if (dialog.open) dialog.close();
}

function applyModelPricing() {
  const model = state.modelPricingDraft;
  const entry = state.pricingCatalog?.models?.[model];
  const inputs = $("#modelPricingFields").querySelectorAll("input[data-model]");
  if (!model || !entry || !modelPricingInputsChanged(inputs)) return;
  for (const input of inputs) {
    writePricingField(entry, input.dataset.context, input.dataset.field, Number(input.value));
  }
  closeModelPricing();
  renderPricingModelList();
}

async function openPricingDialog() {
  if (isStaticSnapshot()) return;
  const button = $("#updatePricingButton");
  button.disabled = true;
  try {
    const response = await fetch("/api/pricing");
    const catalog = await response.json();
    if (!response.ok) throw new Error(localizeServerError(catalog, response.status));
    state.pricingCatalog = catalog;
    state.restoreAutomaticExchangeRate = false;
    renderAutomaticRateRestoreControl();
    renderAutomaticPricingStatus(catalog.automatic, catalog.usageCoverage);
    state.pricingSearch = "";
    state.pricingScope = "used";
    $("#pricingSearch").value = "";
    $("#usdToCnyRate").value = String(catalog.usdToCnyRate ?? 6.72);
    updatePricingScopeButtons();
    renderPricingModelList();
    setPricingMessage("");
    $("#pricingDialog").hidden = false;
    window.requestAnimationFrame(() => $("#pricingSearch").focus());
  } catch (error) {
    setAutoRefreshStatus(`读取计价标准失败：${error.message}`, { error: true });
  } finally {
    button.disabled = false;
  }
}

function closePricingDialog() {
  closeModelPricing();
  $("#pricingDialog").hidden = true;
  state.pricingCatalog = null;
  state.restoreAutomaticExchangeRate = false;
  renderAutomaticRateRestoreControl();
  state.pricingSearch = "";
  setPricingMessage("");
  $("#updatePricingButton").focus();
}

function restoreAutomaticExchangeRateDraft() {
  const rate = Number(state.pricingCatalog?.automatic?.automaticUsdToCnyRate);
  if (!(rate > 0)) {
    setPricingMessage(
      getLocale() === "en-US" ? "No automatic exchange rate is available." : "当前没有可恢复的自动汇率。",
      true,
    );
    return;
  }
  state.restoreAutomaticExchangeRate = true;
  $("#usdToCnyRate").value = String(rate);
  renderAutomaticRateRestoreControl();
  setPricingMessage(
    getLocale() === "en-US"
      ? "The automatic rate will take effect when you save. Cancel leaves the saved rate unchanged."
      : "自动汇率将在保存后生效；取消不会改变已保存的汇率。",
  );
}

async function submitPricing(event) {
  event.preventDefault();
  if (!state.pricingCatalog) return;
  const usdToCnyRate = Number($("#usdToCnyRate").value);
  if (!(usdToCnyRate > 0)) {
    setPricingMessage("请填写大于 0 的美元兑人民币汇率。", true);
    return;
  }
  const restoreAutomaticExchangeRate = state.restoreAutomaticExchangeRate === true;
  // 价格核对日期自动取保存当天，无需用户填写。
  const now = new Date();
  const checkedAt = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const button = $("#savePricingButton");
  button.disabled = true;
  setPricingMessage("正在保存并重算…");
  try {
    const response = await fetch("/api/pricing", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: state.pricingCatalog.version,
        checkedAt,
        usdToCnyRate,
        restoreAutomaticExchangeRate,
        models: structuredClone(state.pricingCatalog.models),
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(localizeServerError(data, response.status));
    await loadUsage({ skipCheck: true });
    closePricingDialog();
  } catch (error) {
    setPricingMessage(`保存失败：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
}

function setImportControlsDisabled(disabled) {
  for (const selector of ["#importButton", "#addImportButton", "#pickImportDirectoryButton"]) {
    const button = $(selector);
    if (!button) {
      continue;
    }
    button.disabled = disabled;
    button.title = disabled ? "静态快照不能编辑数据来源" : "";
  }
}

async function pickImportDirectory() {
  if (isStaticSnapshot()) {
    setImportMessage("静态快照不能选择目录，请启动本地服务或手动输入路径。", true);
    return;
  }

  const pickButton = $("#pickImportDirectoryButton");
  pickButton.disabled = true;
  setImportMessage("正在打开文件夹选择器...");
  try {
    const response = await fetch("/api/pick-directory", { method: "POST" });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(localizeServerError(data, response.status));
    }
    if (data.path) {
      $("#importPath").value = data.path;
      setImportMessage("已选择目录，可继续导入。");
    } else {
      setImportMessage("没有选择目录。");
    }
  } catch (error) {
    setImportMessage(`选择失败：${error.message}，也可以手动输入路径。`, true);
  } finally {
    pickButton.disabled = false;
  }
}

function setImportMessage(message, isError = false) {
  const element = $("#importMessage");
  element.textContent = message;
  element.classList.toggle("error", isError);
}

function readExcludedHomes() {
  try {
    const saved = JSON.parse(localStorage.getItem(EXCLUDED_HOMES_STORAGE_KEY) || "[]");
    if (Array.isArray(saved)) {
      return saved.filter((id) => typeof id === "string" && id);
    }
  } catch {
    // Ignore storage failures in restricted contexts.
  }
  return [];
}

function saveExcludedHomes() {
  try {
    localStorage.setItem(EXCLUDED_HOMES_STORAGE_KEY, JSON.stringify(state.excludedHomes));
  } catch {
    // Ignore storage failures in restricted contexts.
  }
}

function openImportDialog() {
  if (isStaticSnapshot()) {
    setAutoRefreshStatus("静态快照不能编辑数据来源，请启动本地服务后再操作");
    return;
  }
  const dialog = $("#importDialog");
  importDialogOpener = document.activeElement;
  dialog.hidden = false;
  $("#importPath").value = "";
  setImportMessage("");
  renderSourceOptions();
  window.requestAnimationFrame(() => $("#importPath").focus());
}

function renderSourceOptions() {
  const container = $("#sourcePicker");
  if (!container) {
    return;
  }
  container.innerHTML = renderSourceOptionsHtml(homeRowsFromMetadata(currentMetadata() || {}), state.excludedHomes);
}

function setSourceOption(id, checked) {
  const excluded = new Set(state.excludedHomes);
  if (checked) {
    excluded.delete(id);
  } else {
    excluded.add(id);
  }
  state.excludedHomes = [...excluded];
  saveExcludedHomes();
  reconcileQuotaSourceSelection();
  // 勾选变化立即生效：跳过同步直接按新筛选刷新汇总。
  void loadUsage({ skipCheck: true });
}

function closeImportDialog() {
  $("#importDialog").hidden = true;
  setImportMessage("");
  importDialogOpener?.focus({ preventScroll: true });
  importDialogOpener = null;
}

function trapDialogFocus(event, dialog) {
  const controls = [...dialog.querySelectorAll("button, input, select, textarea, a[href], [tabindex]")].filter(
    (control) => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length > 0,
  );
  if (!controls.length) return;
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!dialog.contains(document.activeElement) || document.activeElement === (event.shiftKey ? first : last)) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

async function submitImportDirectory(event) {
  event.preventDefault();
  const importPath = $("#importPath").value.trim();
  if (!importPath) {
    setImportMessage("请输入目录路径。", true);
    return;
  }

  const submitButton = $("#submitImportButton");
  submitButton.disabled = true;
  setImportMessage("正在识别目录...");
  try {
    const response = await fetch("/api/imports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: importPath }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(localizeServerError(data, response.status));
    }
    closeImportDialog();
    setAutoRefreshStatus(`已导入 ${data.import.label}，正在刷新...`);
    await loadUsage();
  } catch (error) {
    setImportMessage(`导入失败：${error.message}`, true);
  } finally {
    submitButton.disabled = false;
  }
}

async function removeImportDirectory(importPath) {
  // Removing an import mutates local service state, so static snapshots refuse it.
  if (isStaticSnapshot()) {
    setAutoRefreshStatus("静态快照不能移除导入目录，请启动本地服务后再操作");
    return;
  }
  setAutoRefreshStatus("正在移除导入目录...");
  const response = await fetch(`/api/imports?path=${encodeURIComponent(importPath)}`, {
    method: "DELETE",
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(localizeServerError(data, response.status));
  }
  setAutoRefreshStatus("已移除导入目录，正在刷新...");
  await loadUsage();
}

function updatePresetButtons() {
  if (state.preset === "all") renderRecordBadges();
  for (const button of document.querySelectorAll("[data-preset]")) {
    button.classList.toggle("active", button.dataset.preset === state.preset);
  }
  updateQuotaPresetButton();
}

function clearQuotaNotice() {
  if (quotaNoticeTimer !== null) {
    window.clearTimeout(quotaNoticeTimer);
    quotaNoticeTimer = null;
  }
  state.quotaNotice = "";
  updateQuotaPresetButton();
}

function showQuotaNotice(message) {
  clearQuotaNotice();
  if (!message) return;
  state.quotaNotice = message;
  updateQuotaPresetButton();
  quotaNoticeTimer = window.setTimeout(() => {
    quotaNoticeTimer = null;
    state.quotaNotice = "";
    updateQuotaPresetButton();
  }, 5000);
}

function updateQuotaPresetButton() {
  const button = $("#quotaPresetToggle");
  if (!button) return;
  const enabled = selectedCodexAvailable();
  button.disabled = !enabled;
  const quotaSnapshot = state.quotaSnapshot || state.summary?.quota || state.report?.quota || null;
  const quotaActive = isQuotaPreset(state.preset);
  const currentStatus = quotaActive ? quotaWindowAvailability(quotaSnapshot, state.preset) : null;
  const preferred = QUOTA_PRESETS.includes(state.lastQuotaPreset) ? state.lastQuotaPreset : "quota_5h";
  const target = quotaActive ? (state.preset === "quota_5h" ? "quota_week" : "quota_5h") : preferred;
  const targetName = QUOTA_MODE_LABELS[target] || "限额窗口";
  const currentName = quotaActive
    ? QUOTA_MODE_LABELS[state.preset]
    : state.preset === "recent"
      ? state.recentValue
      : state.preset === "week"
        ? "本周"
        : COMPARISON_PERIOD_LABELS[state.preset] || state.preset;
  const currentReason = currentStatus && !currentStatus.available ? `；${currentStatus.reason}` : "";
  const label = `当前范围为${currentName}${currentReason}；点击切换到${targetName}`;
  button.classList.toggle("active", quotaActive);
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(quotaActive));
  button.title = enabled ? label : "";
  for (const mode of button.querySelectorAll("[data-quota-mode]")) {
    mode.classList.toggle("is-selected", quotaActive && mode.dataset.quotaMode === state.preset);
  }
  const status = $("#quotaPresetStatus");
  if (status) {
    status.textContent = state.quotaNotice;
    status.hidden = !enabled || !state.quotaNotice;
  }
  updateRecentControls();
}

function selectedCodexAvailable() {
  return hasSelectedCodexSource(homeRowsFromMetadata(currentMetadata() || {}), state.excludedHomes);
}

function reconcileQuotaSourceSelection() {
  if (!selectedCodexAvailable()) {
    if (
      isQuotaPreset(state.preset) ||
      (state.preset === "recent" && ["上一个5h", "上周"].includes(state.recentValue))
    ) {
      state.preset = "today";
      state.bucket = "hour";
    }
    if (["上一个5h", "上周"].includes(state.recentValue)) state.recentValue = "上个月";
    state.quotaNotice = "";
  }
  updatePresetButtons();
  updateRecentControls();
}

function updateRecentControls() {
  const recentValue = $("#recentValue");
  const display = displayRecentValue(state.recentValue);
  if (recentValue && recentValue.value !== display) {
    recentValue.value = display;
  }
  for (const option of document.querySelectorAll("[data-recent-option]")) {
    const mode = { 上一个5h: "quota_5h", 上周: "quota_week" }[option.dataset.recentOption];
    const quota = state.quotaSnapshot || state.summary?.quota || state.report?.quota;
    option.disabled = Boolean(
      mode && (!selectedCodexAvailable() || quota?.previousWindows?.[mode]?.state !== "available"),
    );
    option.setAttribute("aria-selected", String(option.dataset.recentOption === state.recentValue));
  }
}

function datePickerViewDate() {
  return state.datePickerView || parseLocalDate(state.startDate) || new Date();
}

function updateDateRangeControl() {
  const button = $("#dateRangeButton");
  if (!button) return;
  // 只展示正在生效或正在挑选的范围；切回预设后旧的自定义日期保留在 state 里供下次预填，但不再显示。
  const range = state.datePickerDraft || (state.preset === "custom" ? state : { startDate: "", endDate: "" });
  $("#dateRangeStart").textContent = range.startDate || localizeText("年/月/日");
  $("#dateRangeEnd").textContent = range.endDate || "";
  $("#dateRangeEnd").hidden = !range.endDate;
  $("#dateRangeSeparator").hidden = !range.endDate;
  button.classList.toggle("has-range", Boolean(range.startDate));
  button.classList.toggle("active", state.preset === "custom");
  const label = [localizeText("打开日期范围日历"), range.startDate, range.endDate].filter(Boolean).join(" · ");
  button.setAttribute("aria-label", label);
  button.title = label;
}

function renderDatePicker(field) {
  const picker = $("#dateRangePicker");
  if (!picker) {
    return;
  }
  const range = state.datePickerDraft || state;
  picker.innerHTML = renderDatePickerHtml({
    field,
    viewDate: datePickerViewDate(),
    startDate: range.startDate,
    endDate: range.endDate,
  });
  updateDateRangeControl();
}

function closeDatePickers() {
  state.datePickerField = "";
  state.datePickerDraft = null;
  $("#dateRangePicker").hidden = true;
  $("#dateRangeButton").setAttribute("aria-expanded", "false");
  updateDateRangeControl();
}

function setDatePickerOpen(open) {
  if (!open) {
    closeDatePickers();
    return;
  }
  setRecentMenuOpen(false);
  state.datePickerDraft = { startDate: state.startDate, endDate: state.endDate };
  state.datePickerView = monthStart(parseLocalDate(state.startDate) || new Date());
  state.datePickerField = "start";
  renderDatePicker("start");
  $("#dateRangePicker").hidden = false;
  $("#dateRangeButton").setAttribute("aria-expanded", "true");
}

function applyDateRangeValues(startDate, endDate) {
  state.startDate = startDate;
  state.endDate = endDate;
  Object.assign(state, nextPresetState(state, "custom"));
  clearQuotaNotice();
  updatePresetButtons();
  refreshViewForFilters();
}

function clearDateRangeSelection() {
  // 清空正在挑选的草稿与已保存的自定义日期；若自定义范围已生效，过滤也一并撤掉，回到默认“今日”（与刷新页面等效）。
  state.datePickerDraft = { startDate: "", endDate: "" };
  state.datePickerField = "start";
  state.startDate = "";
  state.endDate = "";
  if (state.preset === "custom") {
    Object.assign(state, nextPresetState(state, "today"));
    clearQuotaNotice();
    updatePresetButtons();
    updateRecentControls();
    refreshViewForFilters();
  }
  renderDatePicker("start");
  $("#dateRangeButton").focus({ preventScroll: true });
}

function selectDatePickerDate(field, value) {
  const next = selectDateRange({ ...state.datePickerDraft, field }, value);
  if (!next) return;
  state.datePickerDraft = { startDate: next.startDate, endDate: next.endDate };
  if (next.complete) {
    applyDateRangeValues(next.startDate, next.endDate);
    closeDatePickers();
    $("#dateRangeButton").focus({ preventScroll: true });
    return;
  }
  state.datePickerField = next.field;
  renderDatePicker(next.field);
  $("#dateRangePicker").querySelector(`[data-date="${next.startDate}"]`)?.focus({ preventScroll: true });
}

function shiftDatePickerMonth(field, offset) {
  const current = datePickerViewDate();
  state.datePickerView = new Date(current.getFullYear(), current.getMonth() + offset, 1);
  renderDatePicker(field);
}

function setRecentMenuOpen(open) {
  const menu = $("#recentRangeMenu");
  const input = $("#recentValue");
  const button = $("#recentMenuButton");
  const segment = document.querySelector(".recent-segment");
  if (!menu || !input || !button || !segment) {
    return;
  }
  if (open) closeDatePickers();
  menu.hidden = !open;
  input.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-expanded", String(open));
  segment.classList.toggle("menu-open", open);
}

function activateRecentValue(value) {
  const next = nextRecentState(state, value);
  const option = [...document.querySelectorAll("[data-recent-option]")].find(
    (node) => node.dataset.recentOption === next.recentValue,
  );
  if (option?.disabled) return;
  if (!parseRecentValue(next.recentValue)) {
    setAutoRefreshStatus("最近范围格式无效。请使用数字和天、周、月或年。", { error: true });
    updateRecentControls();
    setRecentMenuOpen(false);
    return;
  }
  state.recentValue = next.recentValue;
  state.preset = next.preset;
  state.bucket = next.bucket;
  clearQuotaNotice();
  updatePresetButtons();
  updateRecentControls();
  updateDateRangeControl();
  setRecentMenuOpen(false);
  refreshViewForFilters();
}

function usageQuery({ skipCheck = false, freeze = false } = {}) {
  const params = new URLSearchParams({
    preset: state.preset,
    bucket: state.bucket,
    calendarZone: state.calendarZone,
    view: "dashboard",
  });
  if (state.preset === "custom") {
    if (state.startDate) {
      params.set("startDate", state.startDate);
    }
    if (state.endDate) {
      params.set("endDate", state.endDate);
    }
  }
  if (state.preset === "recent" && state.recentValue) {
    params.set("recentValue", state.recentValue);
  }
  if (state.excludedHomes.length) {
    params.set("exclude", state.excludedHomes.join(","));
  }

  if (skipCheck) {
    params.set("skipCheck", "1");
  }
  if (freeze) {
    params.set("freeze", "1");
  } else if (!state.autoRefreshEnabled && state.snapshotId) {
    params.set("snapshot", state.snapshotId);
  }
  return `?${params.toString()}`;
}

// 静态快照没有服务端可用：对比数据直接用内嵌事件在浏览器里重算，
// 并沿用 localStorage 中持久化的来源排除，保证与在线面板同一口径。
export function staticPeriodComparison(report, calendarZone = state.calendarZone) {
  const excluded = new Set((state.excludedHomes || []).map(String));
  const events = (report.events || []).filter((event) => !excluded.has(String(event.homeId)));
  const now = state.now || report.asOf || report.quota?.asOf || report.generatedAt || undefined;
  return summarizePeriodComparison(events, { now, calendarZone });
}

async function loadUsage({ skipCheck = false, freeze = false } = {}) {
  const loadId = ++state.usageLoadId;
  const embeddedReport = window.__CODEX_USAGE_REPORT__;

  try {
    if (embeddedReport) {
      state.autoRefreshEnabled = false;
      state.report = embeddedReport;
      state.quotaSnapshot = embeddedReport.quota || null;
      state.now = embeddedReport.asOf || embeddedReport.quota?.asOf || embeddedReport.generatedAt || null;
      state.metadata = metadataFromReport(embeddedReport);
      state.summary = null;
      state.periodComparison = staticPeriodComparison(embeddedReport);
      state.fingerprint = "static";
      if (Number(embeddedReport.pricing?.usdToCnyRate) > 0)
        state.usdToCnyRate = Number(embeddedReport.pricing.usdToCnyRate);
      state.costScaleTarget = (embeddedReport.events || []).some((event) => event.costEstimate?.currency === "CNY")
        ? "CNY"
        : "USD";
      setAutoRefreshStatus("此静态快照不会轮询；运行 npm run export 可生成新快照");
    } else {
      const response = await fetch(
        `/api/usage${usageQuery({ skipCheck, freeze: freeze || (!state.autoRefreshEnabled && !state.snapshotId) })}`,
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const error = new Error(localizeServerError(data, response.status));
        error.status = response.status;
        error.body = data;
        throw error;
      }
      if (loadId !== state.usageLoadId) return;
      state.report = null;
      state.metadata = data.metadata;
      state.summary = data.summary;
      state.quotaSnapshot = data.summary?.quota || data.quota || null;
      clearQuotaNotice();
      state.periodComparison = data.periodComparison || null;
      state.fingerprint = data.fingerprint || "";
      state.snapshotId = data.snapshotId || null;
      const costEstimate = data.summary?.costEstimate;
      if (Number(costEstimate?.usdToCnyRate) > 0) state.usdToCnyRate = Number(costEstimate.usdToCnyRate);
      state.costScaleTarget = (costEstimate?.currencies || []).includes("CNY") ? "CNY" : "USD";
      if (data.checkedAt) state.lastSuccessfulCheck = data.checkedAt;
      setAutoRefreshStatus(state.autoRefreshEnabled ? "" : "已关闭");
    }
    if (loadId !== state.usageLoadId) return;
    const previousPreset = state.preset;
    reconcileQuotaSourceSelection();
    if (!embeddedReport && previousPreset !== state.preset) return loadUsage({ skipCheck: true });
    renderAutoRefreshControls();
    updateQuotaPresetButton();
    render();
    if (!embeddedReport && !$("#pricingDialog").hidden && state.pricingCatalog) {
      try {
        const response = await fetch("/api/pricing");
        if (response.ok) {
          const latest = await response.json();
          state.pricingCatalog.usageCoverage = latest.usageCoverage;
          state.pricingCatalog.automatic = latest.automatic;
          renderAutomaticPricingStatus(latest.automatic, latest.usageCoverage);
          renderPricingModelList();
        }
      } catch {}
    }
  } catch (error) {
    if (loadId === state.usageLoadId && error.status === 410 && state.snapshotId && !state.autoRefreshEnabled) {
      state.snapshotId = null;
      setAutoRefreshStatus("快照已回收，正在重新冻结…");
      void loadUsage({ skipCheck: true, freeze: true });
      return;
    }
    if (loadId === state.usageLoadId) {
      if (isQuotaPreset(state.preset) && [409, 413].includes(error.status)) {
        if (error.body?.quota) state.quotaSnapshot = error.body.quota;
        state.summary = null;
        state.report = null;
        const windowStatus = quotaWindowAvailability(state.quotaSnapshot, state.preset);
        const reason = windowStatus.available
          ? localizeServerError(error.body, error.status)
          : windowStatus.reason || localizeServerError(error.body, error.status);
        renderUnavailableQuota(reason);
        const expectedWait = error.body?.code === "QUOTA_WINDOW_UNAVAILABLE";
        setAutoRefreshStatus(expectedWait ? "" : "限额统计暂不可用", { error: !expectedWait });
        return;
      }
      setAutoRefreshStatus(`加载失败：${error.message}`, { error: true });
    }
  }
}

async function checkForUpdates() {
  if (isStaticSnapshot() || !state.autoRefreshEnabled || !state.fingerprint || state.autoRefreshCheckInFlight) return;
  const runId = state.autoRefreshRunId;
  state.autoRefreshCheckInFlight = true;
  setAutoRefreshStatus("正在检查更新…");
  try {
    const response = await fetch(`/api/status?since=${encodeURIComponent(state.fingerprint)}`);
    if (!response.ok) throw new Error(`API ${response.status}`);
    const status = await response.json();
    if (!state.autoRefreshEnabled || runId !== state.autoRefreshRunId) return;
    state.lastSuccessfulCheck = status.checkedAt || new Date().toISOString();
    setAutoRefreshStatus("");
    renderAutoRefreshControls();
    if (status.changed || isQuotaPreset(state.preset)) {
      setAutoRefreshStatus(status.changed ? "检测到用量变化，正在更新…" : "正在刷新限额窗口…");
      await loadUsage();
    }
  } catch (error) {
    if (state.autoRefreshEnabled && runId === state.autoRefreshRunId) {
      setAutoRefreshStatus(`检查失败：${error.message}；下次继续尝试`, { error: true });
    }
  } finally {
    if (runId === state.autoRefreshRunId) {
      state.autoRefreshCheckInFlight = false;
      renderAutoRefreshControls();
    }
  }
}

function startAutoRefresh() {
  if (isStaticSnapshot() || !state.autoRefreshEnabled || state.autoRefreshTimer) return;
  state.autoRefreshTimer = window.setInterval(() => void checkForUpdates(), AUTO_REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (state.autoRefreshTimer) window.clearInterval(state.autoRefreshTimer);
  state.autoRefreshTimer = null;
}

function refreshViewForFilters() {
  if (isStaticSnapshot()) {
    state.periodComparison = staticPeriodComparison(state.report || window.__CODEX_USAGE_REPORT__);
    render();
    return;
  }
  void loadUsage({ skipCheck: true });
}

function updateCalendarZoneSelect() {
  const select = $("#calendarZoneSelect");
  const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  select.querySelector('[value="local"]').textContent = localZone === "Asia/Shanghai" ? "GMT+8" : "本地时间";
  select.value = state.calendarZone;
}

function toggleQuotaPreset() {
  if (!selectedCodexAvailable()) return;
  const quotaSnapshot = state.quotaSnapshot || state.summary?.quota || state.report?.quota || null;
  const next = nextQuotaPresetState(state);
  state.preset = next.preset;
  state.bucket = next.bucket;
  state.lastQuotaPreset = next.lastQuotaPreset;
  clearQuotaNotice();
  updatePresetButtons();
  updateRecentControls();
  const availability = quotaWindowAvailability(quotaSnapshot, next.preset);
  const reason = availability.available ? "正在加载限额窗口…" : availability.reason;
  if (!isStaticSnapshot()) state.summary = null;
  renderUnavailableQuota(reason);
  if (!availability.available) showQuotaNotice(`${QUOTA_MODE_LABELS[next.preset]}：${reason}`);
  refreshViewForFilters();
}

function bootDashboard() {
  try {
    state.calendarZone = window.localStorage.getItem("codexUsageCalendarZoneV2") === "utc" ? "utc" : "local";
  } catch {
    state.calendarZone = "local";
  }
  updateCalendarZoneSelect();
  updateDateRangeControl();
  setupUsageTooltip();
  updateLanguageButton();
  $("#languageToggle").addEventListener("click", () => {
    setLanguage(getLocale() === "en-US" ? "zh-CN" : "en-US");
  });

  $("#quotaPresetToggle").addEventListener("click", toggleQuotaPreset);
  $("#dateRangeButton").addEventListener("click", () => setDatePickerOpen(!state.datePickerField));

  $("#calendarZoneSelect").addEventListener("change", (event) => {
    const zone = event.target.value;
    if (!["local", "utc"].includes(zone) || zone === state.calendarZone) return;
    state.calendarZone = zone;
    try {
      window.localStorage.setItem("codexUsageCalendarZoneV2", zone);
    } catch {}
    updateCalendarZoneSelect();
    renderAutoRefreshControls();
    refreshViewForFilters();
  });

  $("#presetButtons").addEventListener("click", (event) => {
    const button = event.target.closest("[data-preset]");
    if (!button) {
      return;
    }
    closeDatePickers();
    const next = nextPresetState(state, button.dataset.preset);
    state.preset = next.preset;
    state.bucket = next.bucket;
    if (next.lastQuotaPreset) state.lastQuotaPreset = next.lastQuotaPreset;
    clearQuotaNotice();
    updatePresetButtons();
    updateRecentControls();
    updateDateRangeControl();
    refreshViewForFilters();
  });

  $("#bucketSelect")?.remove(); // 粒度选择已移除，粒度随范围自动推导。

  $("#dateRangePicker").addEventListener("click", (event) => {
    const clear = event.target.closest("[data-date-picker-clear]");
    if (clear) {
      event.stopPropagation();
      if (!clear.disabled) {
        clearDateRangeSelection();
      }
      return;
    }
    const field = state.datePickerField || "start";
    const nav = event.target.closest("[data-date-picker-action]");
    if (nav) {
      event.stopPropagation();
      shiftDatePickerMonth(field, nav.dataset.datePickerAction === "next" ? 1 : -1);
      $("#dateRangePicker")
        .querySelector(`[data-date-picker-action="${nav.dataset.datePickerAction}"]`)
        ?.focus({ preventScroll: true });
      return;
    }
    const day = event.target.closest("[data-date]");
    if (!day) return;
    event.stopPropagation();
    selectDatePickerDate(field, day.dataset.date);
  });
  $(".toolbar").addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.datePickerField) {
      closeDatePickers();
      $("#dateRangeButton").focus({ preventScroll: true });
    }
  });

  $("#recentValue").addEventListener("change", (event) => {
    activateRecentValue(event.target.value);
  });

  $("#recentValue").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") {
      return;
    }
    event.preventDefault();
    activateRecentValue(event.target.value);
  });

  $("#recentValue").addEventListener("focus", () => {
    setRecentMenuOpen(true);
  });

  $("#recentMenuButton").addEventListener("click", (event) => {
    event.stopPropagation();
    const shouldOpen = $("#recentRangeMenu").hidden;
    $("#recentValue").focus();
    setRecentMenuOpen(shouldOpen);
  });

  $("#recentRangeMenu").addEventListener("click", (event) => {
    const option = event.target.closest("[data-recent-option]");
    if (!option || option.disabled) {
      return;
    }
    event.stopPropagation();
    activateRecentValue(option.dataset.recentOption);
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".recent-segment")) {
      setRecentMenuOpen(false);
    }
    if (!event.target.closest("#dateRangePicker, #dateRangeButton")) {
      closeDatePickers();
    }
  });

  $("#autoRefreshToggle").addEventListener("click", () => setAutoRefreshEnabled(!state.autoRefreshEnabled));
  $("#timelineModes").addEventListener("click", (event) => {
    const button = event.target.closest("[data-timeline-mode]");
    if (!button || button.dataset.timelineMode === state.timelineMode) return;
    state.timelineMode = button.dataset.timelineMode;
    render();
  });

  $("#updatePricingButton").addEventListener("click", openPricingDialog);
  $("#refreshPricingButton").addEventListener("click", () => void refreshPricingAutomatically(true));
  $("#pricingForm").addEventListener("submit", submitPricing);
  $("#cancelPricingButton").addEventListener("click", closePricingDialog);
  $("#restoreAutomaticRateButton").addEventListener("click", restoreAutomaticExchangeRateDraft);
  $("#usdToCnyRate").addEventListener("input", () => {
    if (!state.restoreAutomaticExchangeRate) return;
    state.restoreAutomaticExchangeRate = false;
    renderAutomaticRateRestoreControl();
  });
  $("#pricingDialog").addEventListener("click", (event) => {
    if (event.target.id === "pricingDialog") closePricingDialog();
  });
  $("#pricingSearch").addEventListener("input", (event) => {
    state.pricingSearch = event.target.value;
    renderPricingModelList();
  });
  $("#pricingScope").addEventListener("click", (event) => {
    const button = event.target.closest("[data-pricing-scope]");
    if (!button) return;
    state.pricingScope = button.dataset.pricingScope;
    updatePricingScopeButtons();
    renderPricingModelList();
  });
  $("#pricingModelList").addEventListener("click", (event) => {
    if (event.target.closest("[data-pricing-rematch]")) {
      void refreshPricingAutomatically(true);
      return;
    }
    const row = event.target.closest("[data-pricing-model]");
    if (!row) return;
    openModelPricing(row.dataset.pricingModel);
  });
  $("#applyModelPricingButton").addEventListener("click", applyModelPricing);
  $("#modelPricingFields").addEventListener("input", updateModelPricingApplyState);
  $("#modelPricingFields").addEventListener("change", updateModelPricingApplyState);
  $("#cancelModelPricingButton").addEventListener("click", closeModelPricing);
  $("#modelPricingDialog").addEventListener("click", (event) => {
    if (event.target.id === "modelPricingDialog") closeModelPricing();
  });
  // cancel（Esc）与 close() 都会走到 close：草稿在这里统一清理。
  $("#modelPricingDialog").addEventListener("close", () => {
    state.modelPricingDraft = null;
  });
  $("#importButton").addEventListener("click", openImportDialog);
  $("#addImportButton").addEventListener("click", openImportDialog);
  $("#repositoryComparisonSearch").addEventListener("input", (event) => {
    state.repositoryComparisonQuery = event.target.value;
    renderPeriodComparisons(state.periodComparison);
  });
  $("#modelComparisonSearch").addEventListener("input", (event) => {
    state.modelComparisonQuery = event.target.value;
    renderPeriodComparisons(state.periodComparison);
  });
  for (const selector of ["#repositoryComparisonTable", "#modelComparisonTable"]) {
    $(selector).addEventListener("click", (event) => {
      const sortButton = event.target.closest("[data-comparison-sort]");
      if (sortButton) {
        const { kind, period } = sortButton.dataset;
        const stateKey = kind === "repository" ? "repositoryComparisonSort" : "modelComparisonSort";
        state[stateKey] = nextComparisonSort(state[stateKey], period);
        renderPeriodComparisons(state.periodComparison);
        document
          .querySelector(
            `#${kind === "repository" ? "repositoryComparisonTable" : "modelComparisonTable"} [data-comparison-sort][data-period="${period}"]`,
          )
          ?.focus({ preventScroll: true });
        return;
      }
      const button = event.target.closest("[data-period-expand]");
      if (!button) return;
      const next = { kind: button.dataset.kind, key: button.dataset.key, period: button.dataset.period };
      const current = state.expandedPeriodCell;
      state.expandedPeriodCell =
        current?.kind === next.kind && current?.key === next.key && current?.period === next.period ? null : next;
      renderPeriodComparisons(state.periodComparison);
      const restoredButton = [...document.querySelectorAll("[data-period-expand]")].find(
        (candidate) =>
          candidate.dataset.kind === next.kind &&
          candidate.dataset.key === next.key &&
          candidate.dataset.period === next.period,
      );
      restoredButton?.focus({ preventScroll: true });
    });
  }
  $("#homeList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-import-action='remove']");
    if (!button) {
      return;
    }
    button.disabled = true;
    removeImportDirectory(button.dataset.importPath).catch((error) => {
      button.disabled = false;
      setAutoRefreshStatus(`移除失败：${error.message}`);
    });
  });
  $("#importForm").addEventListener("submit", submitImportDirectory);
  $("#pickImportDirectoryButton").addEventListener("click", pickImportDirectory);
  $("#sourcePicker").addEventListener("change", (event) => {
    const input = event.target.closest("input[data-source-id]");
    if (!input) {
      return;
    }
    setSourceOption(input.dataset.sourceId, input.checked);
  });
  $("#cancelImportButton").addEventListener("click", closeImportDialog);
  $("#importDialog").addEventListener("click", (event) => {
    if (event.target.id === "importDialog") {
      closeImportDialog();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Tab" && !$("#modelPricingDialog").open) {
      const dialog = [$("#pricingDialog"), $("#importDialog")].find((candidate) => !candidate.hidden);
      if (dialog) trapDialogFocus(event, dialog);
    }
    if (event.key === "Escape") {
      setRecentMenuOpen(false);
    }
    // 子弹窗已改原生 <dialog>，Esc 由平台关闭顶层弹窗；这里只在子弹窗未打开时关父弹窗。
    if (event.key === "Escape" && !$("#pricingDialog").hidden && !$("#modelPricingDialog").open) closePricingDialog();
    if (event.key === "Escape" && !$("#importDialog").hidden) {
      closeImportDialog();
    }
  });
  $("#themeToggle").addEventListener("click", () => {
    setTheme(state.theme === "dark" ? "light" : "dark");
  });
  let resizeRenderQueued = false;
  window.addEventListener("resize", () => {
    if (resizeRenderQueued) return;
    resizeRenderQueued = true;
    requestAnimationFrame(() => {
      resizeRenderQueued = false;
      render();
    });
  });
  // 图表高度随容器（右侧详情行数、窗口/面板拖拽）变化：观察到尺寸变化就按新尺寸重绘。
  const chartCanvas = $("#timelineChart");
  if (chartCanvas && typeof ResizeObserver !== "undefined") {
    let chartResizeTimer = null;
    const chartResizeObserver = new ResizeObserver(() => {
      clearTimeout(chartResizeTimer);
      chartResizeTimer = setTimeout(() => render(), 60);
    });
    chartResizeObserver.observe(chartCanvas);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.autoRefreshEnabled) {
      startAutoRefresh();
      void checkForUpdates();
    }
  });

  setTheme(preferredTheme(), { persist: false });
  state.excludedHomes = readExcludedHomes();
  initializeAutoRefresh();
  updateRecentControls();
  $("#updatePricingButton").disabled = isStaticSnapshot();
  $("#updatePricingButton").title = isStaticSnapshot() ? "静态快照无法更新计价标准；请启动本地服务" : "";
  setImportControlsDisabled(isStaticSnapshot());
  void loadUsage().then(() => {
    startAutoRefresh();
    void refreshPricingAutomatically();
  });
  if (!isStaticSnapshot()) setInterval(() => void refreshPricingAutomatically(), 60 * 60 * 1000);
}

if (typeof document !== "undefined") {
  bootDashboard();
}
