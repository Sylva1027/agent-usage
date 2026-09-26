import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalRecentValue,
  displayRecentValue,
  getLocale,
  localeFromLanguages,
  localizeQuotaReason,
  localizeServerError,
  localizeText,
  preferredLocale,
  setLocale,
} from "../public/i18n.js";
import {
  formatTimelineTooltip,
  formatUsageTooltip,
  rangeLabel,
  renderBarListHtml,
  renderComparisonHtml,
  renderCostDetailHtml,
  renderDatePickerHtml,
  renderHomesHtml,
  renderPeriodComparisonTableHtml,
  renderSourceOptionsHtml,
} from "../public/app.js";

function untranslatedUiFragments(markup) {
  const fragments = [];
  for (const match of String(markup).matchAll(/>([^<>]*[\u3400-\u9fff][^<>]*)</gu)) {
    const text = match[1].trim();
    if (text && /[\u3400-\u9fff]/u.test(localizeText(text, "en-US"))) fragments.push(text);
  }
  for (const match of String(markup).matchAll(/(?:aria-label|title|placeholder)="([^"]*[\u3400-\u9fff][^"]*)"/gu)) {
    if (/[\u3400-\u9fff]/u.test(localizeText(match[1], "en-US"))) fragments.push(match[1]);
  }
  return fragments;
}

test("browser language sets the first locale and a saved choice takes precedence", () => {
  assert.equal(localeFromLanguages(["zh-TW", "en-US"]), "zh-CN");
  assert.equal(localeFromLanguages(["en-GB", "zh-CN"]), "en-US");
  assert.equal(localeFromLanguages(["fr-FR"]), "en-US");
  assert.equal(preferredLocale({ getItem: () => "zh-CN" }, ["en-US"]), "zh-CN");
  assert.equal(preferredLocale({ getItem: () => { throw new Error("denied"); } }, ["en-US"]), "en-US");
  setLocale("en-US", { persist: false });
  assert.equal(getLocale(), "en-US");
  setLocale("zh-CN", { persist: false });
});

test("English recent ranges preserve the existing Chinese request values", () => {
  assert.equal(canonicalRecentValue("1 day"), "1天");
  assert.equal(canonicalRecentValue("2 weeks"), "2周");
  assert.equal(canonicalRecentValue("3 months"), "3个月");
  assert.equal(canonicalRecentValue("6 months"), "半年");
  assert.equal(canonicalRecentValue("1 year"), "一年");
  assert.equal(canonicalRecentValue("2"), "2天");
  assert.equal(canonicalRecentValue("tomorrow"), null);
  assert.equal(displayRecentValue("半年", "en-US"), "6 months");
  assert.equal(displayRecentValue("3个月", "en-US"), "3 months");
});

test("translated dashboard copy preserves cost and limit semantics", () => {
  assert.equal(localizeText("总花销", "en-US"), "Estimated Cost");
  assert.equal(localizeText("缓存读取", "en-US"), "Cache Hit");
  assert.equal(localizeText("本周限额", "en-US"), "Weekly Limit");
  assert.equal(localizeText("本周", "en-US"), "This Week");
  assert.equal(localizeText("总花销", "zh-CN"), "总花销");
  assert.match(localizeText("当前范围为今日；点击切换到 5 小时限额", "en-US"), /Current range: Today.*5-Hour Limit/);
  assert.equal(localizeQuotaReason({ reasonCode: "waiting", reason: "等待新的限额记录" }, "en-US"), "Waiting for a new limit record.");
  assert.equal(localizeServerError({ code: "INVALID_IMPORT_DIRECTORY", error: "中文原因" }, 400, "en-US"), "Choose a Codex or ZCode home directory, or a project with a usage log.");
});

test("every static dashboard label and accessible attribute has an English form", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const untranslated = [];
  for (const match of html.matchAll(/>([^<>]*[\u3400-\u9fff][^<>]*)</gu)) {
    const text = match[1].trim();
    if (text && text !== "文" && /[\u3400-\u9fff]/u.test(localizeText(text, "en-US"))) untranslated.push(text);
  }
  for (const match of html.matchAll(/(?:aria-label|title|placeholder)="([^"]*[\u3400-\u9fff][^"]*)"/gu)) {
    if (/[\u3400-\u9fff]/u.test(localizeText(match[1], "en-US"))) untranslated.push(match[1]);
  }
  assert.deepEqual(untranslated, []);
});

test("dynamic dashboard views have English copy for their rendered labels", () => {
  const previousDocument = globalThis.document;
  globalThis.document = { documentElement: { dataset: { theme: "light" } } };
  setLocale("en-US", { persist: false });
  try {
    const usage = { total: 100, input: 80, cached: 20, output: 20, reasoning: 4 };
    const home = { id: "home-1", label: "Codex home", path: "/tmp/codex", kind: "main", status: "active", eventCount: 4, sessionCount: 2, imported: true };
    const comparison = {
      label: "较昨日", previousRange: { start: "2026-09-25", end: "2026-09-25" },
      previousTotals: { total: 50 }, previousSessionCount: 2,
      totalDelta: 50, percentChange: 100, averageDelta: 25, averagePercentChange: 50,
    };
    const period = { total: 100, input: 80, cached: 20, output: 20, reasoning: 4 };
    const pieces = [
      renderDatePickerHtml({ viewDate: new Date(2026, 8, 1) }),
      renderBarListHtml([{ name: "CLI", total: usage }]),
      renderCostDetailHtml([{ name: "gpt-6-sol", totalUsd: 1.23 }]),
      renderComparisonHtml(comparison),
      renderComparisonHtml({ label: "暂无对比", previousRange: null }),
      renderPeriodComparisonTableHtml([{ key: "gpt-6-sol", name: "gpt-6-sol", periods: { today: period } }], { expanded: { kind: "model", key: "gpt-6-sol", period: "today" }, totals: { today: period }, sort: { period: "today", direction: "asc", showIndicator: true } }),
      renderHomesHtml([home], { canModify: true, excludedIds: [home.id] }),
      renderSourceOptionsHtml([home]),
      formatUsageTooltip({ name: "CLI", total: usage, count: 4, sessions: 2 }),
      formatTimelineTooltip({ name: "2026-09-26", total: usage, models: [{ name: "gpt-6-sol", total: usage }] }, "model"),
      formatTimelineTooltip({ name: "2026-09-26", total: usage, pricedTokens: 100, costByModel: { "gpt-6-sol": { totalUsd: 1.23, currency: "USD" } } }, "cost"),
      `<p>${rangeLabel({ range: { preset: "today", start: "2026-09-26", end: "2026-09-26" } })}</p>`,
    ];
    assert.deepEqual(pieces.flatMap(untranslatedUiFragments), []);
  } finally {
    setLocale("zh-CN", { persist: false });
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});
