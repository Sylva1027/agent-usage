import assert from "node:assert/strict";
import test from "node:test";
import { buildModelActivity } from "../public/pricing-models.js";

test("recent aliases keep a shared catalog key active while retired missing models remain in All Models", () => {
  const previous = { metadata: state.metadata, pricingCatalog: state.pricingCatalog };
  try {
    state.pricingCatalog = { models: { "gpt-5.6-sol": {} } };
    state.metadata = {
      harnessModels: {
        Codex: ["gpt-5.6-sol", "gpt-daybreak-blue-latest", "retired-missing"],
        ZCode: ["new-free-free"],
        DSH: [],
        OpenCode: [],
      },
      ...buildModelActivity(
        [
          { harness: "Codex", model: "gpt-5.6-sol", timestamp: "2026-09-01T00:00:00Z" },
          { harness: "Codex", model: "retired-missing", timestamp: "2026-09-01T00:00:00Z" },
          { harness: "Codex", model: "gpt-daybreak-blue-latest", timestamp: "2026-09-30T00:00:00Z" },
          { harness: "ZCode", model: "new-free-free", timestamp: "2026-09-30T00:00:00Z" },
        ],
        "2026-10-01T00:00:00Z",
      ),
    };
    assert.deepEqual(pricingHarnessRows().Codex, [
      { model: "gpt-daybreak-blue-latest", catalogKey: "gpt-5.6-sol", matchType: "alias" },
    ]);
    assert.equal(pricingHarnessRows().ZCode[0].matchType, "free");
    assert.ok(pricingHarnessRows({ all: true }).Codex.some((row) => row.model === "retired-missing"));
    delete state.metadata.activeHarnessModels;
    assert.equal(pricingUsageModels().recent, true);
    assert.deepEqual(
      pricingHarnessRows().Codex.map((row) => row.model),
      ["gpt-daybreak-blue-latest"],
      "last-seen timestamps reconstruct activity without reviving retired models",
    );
  } finally {
    state.metadata = previous.metadata;
    state.pricingCatalog = previous.pricingCatalog;
  }
});

import {
  automaticPricingStatusText,
  datePickerMonthModel,
  drawTimeline,
  filterPeriodComparisonRows,
  getChannelColors,
  getModelColors,
  renderTimelineLegendHtml,
  getRange,
  maxTimelineValue,
  modelPricingInputsChanged,
  nextComparisonSort,
  pricingIssueText,
  pricingModelBadges,
  pricingProvenanceText,
  pricingUpdateSummaryText,
  discoveryReasonText,
  formatTokenMillions,
  formatTimelineTooltip,
  formatUsageTooltip,
  renderBarListHtml,
  renderCostDetailHtml,
  renderComparisonHtml,
  renderDatePickerHtml,
  renderHomesHtml,
  renderSourceOptionsHtml,
  claimHarnessKeys,
  pricingHarnessGroups,
  pricingHarnessRows,
  pricingUsageModels,
  formatCostAmount,
  formatCostPair,
  costPairFromSlots,
  costScaleValue,
  fitTextToWidth,
  formatAutoRefreshTimestamp,
  usagePricingCoverageText,
  renderPeriodComparisonTableHtml,
  setSummaryFilters,
  timelineAxisLabels,
  timelineDetailRows,
  timelineSlotRangeTitle,
} from "../public/app.js";
import { state } from "../public/app-state.js";
import { selectDateRange } from "../public/calendar.js";

// ---------------------------------------------------------------- harness 归组（DSH）

test("claimHarnessKeys 让同一模型只留在第一个 harness 分区里", () => {
  // ZCode 与 DSH 都可能跑 deepseek-flash，去重前会在计价弹窗里出现两次。
  const claimed = claimHarnessKeys({
    Codex: new Set([]),
    ZCode: new Set(["deepseek-flash", "glm-5.3"]),
    DSH: new Set(["deepseek-flash"]),
  });

  assert.deepEqual([...claimed.ZCode].sort(), ["deepseek-flash", "glm-5.3"]);
  assert.deepEqual([...claimed.DSH], [], "已被 ZCode 认领的模型不应再出现在 DSH");
});

test("claimHarnessKeys 按 Codex → ZCode → DSH 的优先级认领", () => {
  const claimed = claimHarnessKeys({
    Codex: new Set(["gpt-6-sol"]),
    ZCode: new Set(["gpt-6-sol", "deepseek-flash"]),
    DSH: new Set(["gpt-6-sol", "deepseek-flash"]),
  });

  assert.deepEqual([...claimed.Codex], ["gpt-6-sol"]);
  assert.deepEqual([...claimed.ZCode], ["deepseek-flash"]);
  assert.deepEqual([...claimed.DSH], []);
});

test("pricingHarnessGroups 读三元 harnessModels 并去重", () => {
  const previous = { metadata: state.metadata, pricingCatalog: state.pricingCatalog };
  try {
    state.pricingCatalog = {
      models: {
        "gpt-6-sol": { currency: "USD", source: "https://developers.openai.com/api/docs/pricing" },
        "deepseek-flash": { currency: "CNY", source: "https://api-docs.deepseek.com/x" },
      },
    };
    // 同一模型同时被 ZCode 与 DSH 使用。
    state.metadata = { harnessModels: { Codex: ["gpt-6-sol"], ZCode: ["deepseek-flash"], DSH: ["deepseek-flash"] } };
    state.metadata.activeHarnessModels = state.metadata.harnessModels;

    const groups = pricingHarnessGroups();
    assert.deepEqual([...groups.Codex], ["gpt-6-sol"]);
    assert.deepEqual([...groups.ZCode], ["deepseek-flash"]);
    assert.deepEqual([...groups.DSH], [], "DSH 不应重复展示已被 ZCode 认领的模型");

    // 只被 DSH 用到的模型必须出现在 DSH 分区里，而不是消失。
    state.metadata = { harnessModels: { Codex: [], ZCode: [], DSH: ["deepseek-flash"] } };
    state.metadata.activeHarnessModels = state.metadata.harnessModels;
    const dshOnly = pricingHarnessGroups();
    assert.deepEqual([...dshOnly.DSH], ["deepseek-flash"]);
    assert.deepEqual([...dshOnly.ZCode], []);
  } finally {
    state.metadata = previous.metadata;
    state.pricingCatalog = previous.pricingCatalog;
  }
});

test("pricingHarnessGroups respects an empty recent set instead of reviving historical models", () => {
  const previous = { metadata: state.metadata, pricingCatalog: state.pricingCatalog, summary: state.summary };
  try {
    state.metadata = {
      activeHarnessModels: { Codex: [], ZCode: [], DSH: [] },
      harnessModels: { Codex: ["gpt-6-sol"], ZCode: ["deepseek-flash"], DSH: [] },
    };
    state.summary = { models: [{ name: "gpt-6-sol" }, { name: "deepseek-flash" }] };
    state.pricingCatalog = {
      models: {
        "gpt-6-sol": { currency: "USD", source: "https://developers.openai.com/api/docs/pricing" },
        "deepseek-flash": { currency: "CNY", source: "https://api-docs.deepseek.com/x" },
      },
    };

    const groups = pricingHarnessGroups();
    assert.deepEqual([...groups.Codex], []);
    assert.deepEqual([...groups.ZCode], []);
    assert.deepEqual([...groups.DSH], []);
    assert.equal(pricingHarnessRows({ all: true }).Codex.length, 1);
  } finally {
    state.metadata = previous.metadata;
    state.pricingCatalog = previous.pricingCatalog;
    state.summary = previous.summary;
  }
});

test("legacy and mixed pricing responses keep observed models visible while explicit recent emptiness wins", () => {
  const previous = { metadata: state.metadata, pricingCatalog: state.pricingCatalog };
  try {
    state.metadata = { harnessModels: { Codex: ["gpt-6-sol", "missing-legacy"], ZCode: ["legacy-free-free"] } };
    state.pricingCatalog = { models: { "gpt-6-sol": {} }, usageCoverage: { ready: true, usedModelCount: 3 } };
    assert.equal(pricingUsageModels().recent, false);
    assert.deepEqual(
      pricingHarnessRows().Codex.map((row) => row.model),
      ["gpt-6-sol", "missing-legacy"],
    );
    assert.equal(pricingHarnessRows().ZCode[0].matchType, "free");

    state.pricingCatalog.modelActivity = { modelUsageAsOf: "2026-10-01T00:00:00Z" };
    state.metadata.activeHarnessModels = { Codex: ["gpt-6-sol"] };
    assert.equal(pricingUsageModels().recent, true, "incomplete catalog activity does not hide valid metadata");
    assert.equal(pricingHarnessRows().Codex.length, 1);

    state.pricingCatalog.modelActivity.activeHarnessModels = {};
    assert.equal(pricingUsageModels().recent, true);
    assert.deepEqual(
      pricingHarnessRows().Codex,
      [],
      "explicit empty catalog wins over both older and historical lists",
    );
    delete state.pricingCatalog.modelActivity.activeHarnessModels;
    state.metadata.activeHarnessModels = { Codex: [] };
    assert.deepEqual(pricingHarnessRows().Codex, [], "explicit empty usage metadata cannot fall back to history");
  } finally {
    state.metadata = previous.metadata;
    state.pricingCatalog = previous.pricingCatalog;
  }
});

test("pricingHarnessRows keeps aliases visible and exposes missing and free usage", () => {
  const previous = { metadata: state.metadata, pricingCatalog: state.pricingCatalog };
  try {
    state.pricingCatalog = {
      models: {
        "gpt-5.6-sol": { currency: "USD", source: "https://developers.openai.com/api/docs/pricing" },
        "mimo-v2.6-flash": { currency: "CNY", source: "https://example.com/pricing" },
      },
    };
    state.metadata = {
      harnessModels: {
        Codex: ["gpt-daybreak-blue-latest", "future-model"],
        ZCode: ["mimo-v2.6-flash-free"],
        DSH: [],
      },
    };
    state.metadata.activeHarnessModels = state.metadata.harnessModels;
    const rows = pricingHarnessRows();
    assert.deepEqual(rows.Codex, [
      { model: "gpt-daybreak-blue-latest", catalogKey: "gpt-5.6-sol", matchType: "alias" },
      { model: "future-model", catalogKey: null, matchType: "missing" },
    ]);
    assert.deepEqual(rows.ZCode, [{ model: "mimo-v2.6-flash-free", catalogKey: null, matchType: "free" }]);
    assert.deepEqual([...pricingHarnessGroups().Codex], ["gpt-5.6-sol"]);
  } finally {
    state.metadata = previous.metadata;
    state.pricingCatalog = previous.pricingCatalog;
  }
});

test("空状态文案包含 DSH 与 OpenCode", () => {
  const html = renderHomesHtml([]);
  assert.match(html, /没有发现 Codex、ZCode、DSH 或 OpenCode 目录/);
});

test("claimHarnessKeys 按 Codex → ZCode → DSH → OpenCode 的优先级认领", () => {
  const claimed = claimHarnessKeys({
    Codex: new Set(["gpt-6-sol"]),
    ZCode: new Set(["deepseek-flash"]),
    DSH: new Set(["deepseek-flash", "test-model"]),
    OpenCode: new Set(["test-model", "oc-model"]),
  });
  assert.deepEqual([...claimed.Codex], ["gpt-6-sol"]);
  assert.deepEqual([...claimed.ZCode], ["deepseek-flash"]);
  assert.deepEqual([...claimed.DSH], ["test-model"]);
  assert.deepEqual([...claimed.OpenCode], ["oc-model"]);
});

test("pricing status gives total coverage and marks each price source", () => {
  const status = {
    priceUpdatedAt: "2026-09-28T08:00:00Z",
    exchangeRateDate: "2026-09-28",
    automaticModelCount: 25,
    partialAutomaticModelCount: 4,
    totalModelCount: 86,
    unmatchedModelCount: 52,
    priceSourceCoverage: {
      supportedModelCount: 82,
      supportedUsdModelCount: 49,
      supportedCnyModelCount: 33,
      unsupportedCurrencyModelCount: 4,
    },
    automaticModels: ["gpt-6-sol"],
    manualModels: ["gpt-6-sol"],
  };
  assert.match(automaticPricingStatusText(status), /自动维护 25\/86，部分 4/);
  assert.match(automaticPricingStatusText(status), /USD 来源适配 49\/86，CNY 官方源 33 条，暂保留本地 4 条/);
  assert.match(automaticPricingStatusText(status, "en-US"), /auto-maintained 25\/86, partial 4/);
  assert.match(
    automaticPricingStatusText(status, "en-US"),
    /USD source mappings 49\/86, CNY adapters 33, CNY manual-only 4/,
  );
  assert.match(pricingModelBadges("gpt-6-sol", status), /自动匹配.*手动覆盖/);
  assert.match(pricingModelBadges("deepseek-flash", status), /未自动匹配/);
  assert.match(pricingModelBadges("gpt-6-sol", {}, "https://models.dev/api.json"), /自动匹配/);
  assert.equal(
    pricingIssueText({ source: "LiteLLM", code: "timeout", timeoutMs: 30_000 }, false),
    "LiteLLM 请求超时（30 秒）",
  );
  assert.equal(
    pricingIssueText({ source: "Xiaomi MiMo", code: "timeout", timeoutMs: 30_000 }, false),
    "小米 MiMo 请求超时（30 秒）",
  );
  assert.match(discoveryReasonText("catalog-capacity", false), /100 个模型上限/);
  assert.match(discoveryReasonText("context-policy-unknown", true), /context pricing policy is unknown/);
  const update = pricingUpdateSummaryText({
    attemptedModelCount: 49,
    verifiedModelCount: 31,
    changedModelCount: 7,
    partialModelCount: 9,
    conflictModelCount: 1,
    manualOverrideModelCount: 3,
    noValidMatchModelCount: 18,
    unsupportedCurrencyModelCount: 37,
  });
  assert.match(update, /核验 31\/49，变化 7，部分 9，冲突 1/);
  assert.match(
    pricingUpdateSummaryText({ verifiedModelCount: 31, attemptedModelCount: 49 }, "en-US"),
    /verified 31\/49/,
  );
  const provenance = pricingProvenanceText({
    short: {
      sourceUrl: "https://models.dev/api.json",
      checkedAt: "2026-09-30T12:00:00Z",
      origin: "mixed",
      inheritedFields: ["cacheWrite"],
    },
    "fast.short": { origin: "derived" },
  });
  assert.match(provenance, /标准短上下文.*models.dev.*沿用缓存写入/);
  assert.match(provenance, /快速短上下文.*由标准费率推算/);
});

test("usage coverage status distinguishes loading, covered, free, and missing models", () => {
  assert.match(usagePricingCoverageText({ ready: false }), /等待用量加载/);
  assert.match(
    usagePricingCoverageText({
      ready: true,
      usedModelCount: 3,
      matchedUsedModelCount: 2,
      freeRuleUsedModelCount: 1,
      missingUsedModels: [{ model: "future-model", harnesses: ["Codex"] }],
    }),
    /用量覆盖 2\/3 · 缺少费率 1 · 免费规则 1/,
  );
  assert.match(usagePricingCoverageText({ ready: false }, "en-US"), /Waiting for usage/);
});

test("model pricing Apply requires a valid numeric change and disables again after a revert", () => {
  const first = { value: "4", defaultValue: "4", validity: { valid: true } };
  const second = { value: "0.4", defaultValue: "0.4", validity: { valid: true } };
  assert.equal(modelPricingInputsChanged([first, second]), false);
  first.value = "4.0";
  assert.equal(modelPricingInputsChanged([first, second]), false);
  first.value = "5";
  assert.equal(modelPricingInputsChanged([first, second]), true);
  second.validity.valid = false;
  assert.equal(modelPricingInputsChanged([first, second]), false);
  second.validity.valid = true;
  first.value = "4";
  assert.equal(modelPricingInputsChanged([first, second]), false);
});

test("token values use two decimals with M/B/T units and retain exact hover values", () => {
  assert.equal(formatTokenMillions(62_617_267), "62.62M");
  assert.equal(formatTokenMillions(1_392_280_000), "1.39B");
  assert.equal(formatTokenMillions(1_000_000_000), "1.00B");
  assert.equal(formatTokenMillions(1_000_000_000_000), "1.00T");
  assert.equal(formatTokenMillions(1_395_280_000_000), "1.40T");
  assert.equal(formatTokenMillions(-1_392_280_000), "-1.39B");

  const barHtml = renderBarListHtml([{ key: "gpt-6-luna", name: "gpt-6-luna", total: { total: 62_617_267 } }]);
  assert.match(barHtml, /title="62,617,267">62\.62M/);

  const comparisonHtml = renderPeriodComparisonTableHtml(
    [
      {
        key: "gpt-6-luna",
        name: "gpt-6-luna",
        periods: { today: { total: 62_617_267 }, week: { total: 0 }, month: { total: 0 }, all: { total: 0 } },
      },
    ],
    {
      totals: { today: { total: 62_617_267 }, week: { total: 0 }, month: { total: 0 }, all: { total: 0 } },
    },
  );
  assert.match(comparisonHtml, /title="62,617,267">62\.62M/);
  assert.doesNotMatch(comparisonHtml, /aria-controls="model-period-0-detail"/);

  const expandedHtml = renderPeriodComparisonTableHtml(
    [
      {
        key: "gpt-6-luna",
        name: "gpt-6-luna",
        periods: { today: { total: 62_617_267 }, week: { total: 0 }, month: { total: 0 }, all: { total: 0 } },
      },
    ],
    {
      expanded: { kind: "model", key: "gpt-6-luna", period: "today" },
    },
  );
  assert.match(expandedHtml, /aria-controls="model-period-0-detail"/);
  assert.match(expandedHtml, /id="model-period-0-detail"/);
});

test("timeline details follow channel, model, and cost modes", () => {
  const channels = [{ name: "CLI", total: { total: 20 } }];
  const models = [{ name: "gpt-6-sol", total: { total: 20 } }];
  const summary = {
    channels,
    models,
    timeline: [
      { costByModel: { "gpt-6-sol": { totalUsd: 0.3 }, "gpt-6-luna": { totalUsd: 0.1 } } },
      { costByModel: { "gpt-6-sol": { totalUsd: 0.2 }, "gpt-6-luna": { totalUsd: 0.5 } } },
    ],
  };
  assert.equal(timelineDetailRows(summary, "channel"), channels);
  assert.equal(timelineDetailRows(summary, "model"), models);
  assert.deepEqual(timelineDetailRows(summary, "cost"), [
    { name: "gpt-6-luna", totalUsd: 0.6, currency: "USD", scaleValue: 0.6 },
    { name: "gpt-6-sol", totalUsd: 0.5, currency: "USD", scaleValue: 0.5 },
  ]);
  assert.deepEqual(timelineDetailRows({ ...summary, timelineError: "too many slots" }, "cost"), []);
});

test("cost details show model amounts and escape model names", () => {
  const oldDocument = globalThis.document;
  globalThis.document = { documentElement: { dataset: { theme: "light" } } };
  try {
    const html = renderCostDetailHtml([
      { name: '<img src=x onerror="alert(1)">', totalUsd: 1.25 },
      { name: "gpt-6-sol", totalUsd: 0.5 },
      { name: "gpt-6-luna", totalUsd: 1.256 },
    ]);
    assert.match(html, /\$1\.25/);
    assert.match(html, /\$0\.50/);
    assert.match(html, /\$1\.26/);
    assert.doesNotMatch(html, /\$1\.256/);
    assert.match(html, /width: 40%/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});
test("comparison sort cycles through descending, ascending, and default order", () => {
  const defaultSort = { period: "today", direction: "desc", showIndicator: false };
  const descending = nextComparisonSort(defaultSort, "today");
  const ascending = nextComparisonSort(descending, "today");
  const cancelled = nextComparisonSort(ascending, "today");
  assert.deepEqual(descending, { period: "today", direction: "desc", showIndicator: true });
  assert.deepEqual(ascending, { period: "today", direction: "asc", showIndicator: true });
  assert.deepEqual(cancelled, defaultSort);
  assert.deepEqual(nextComparisonSort(ascending, "week"), { period: "week", direction: "desc", showIndicator: true });

  const rows = [
    {
      key: "directory:all",
      name: "/work/e-all",
      kind: "directory",
      periods: { today: { total: 1 }, week: { total: 2 }, month: { total: 3 }, all: { total: 10 } },
    },
    {
      key: "git:month",
      name: "/work/d-month",
      kind: "git",
      periods: { today: { total: 1 }, week: { total: 2 }, month: { total: 4 }, all: { total: 0 } },
    },
    {
      key: "directory:week",
      name: "/work/c-week",
      kind: "directory",
      periods: { today: { total: 1 }, week: { total: 3 }, month: { total: 0 }, all: { total: 0 } },
    },
    {
      key: "directory:today",
      name: "/work/b-today",
      kind: "directory",
      periods: { today: { total: 2 }, week: { total: 0 }, month: { total: 0 }, all: { total: 0 } },
    },
    { key: "git:zero", name: "/work/z-zero", kind: "git", periods: {} },
  ];
  const rowNames = (sort, kind) =>
    [
      ...renderPeriodComparisonTableHtml(rows, { kind, sort }).matchAll(
        /class="comparison-row-label"[^>]*>([^<]+)<\/span>/g,
      ),
    ].map((match) => match[1]);
  const expected = ["b-today", "c-week", "d-month", "e-all", "z-zero"];
  assert.deepEqual(rowNames(defaultSort, "repository"), ["d-month", "z-zero", "b-today", "c-week", "e-all"]);
  assert.deepEqual(rowNames(cancelled, "repository"), ["d-month", "z-zero", "b-today", "c-week", "e-all"]);
  assert.deepEqual(
    rowNames(defaultSort, "model"),
    expected.map((name) => `/work/${name}`),
  );
  assert.deepEqual(rowNames(ascending, "repository"), ["z-zero", "d-month", "c-week", "e-all", "b-today"]);
  assert.deepEqual(
    rowNames(ascending, "model"),
    ["z-zero", "c-week", "d-month", "e-all", "b-today"].map((name) => `/work/${name}`),
  );
  assert.match(renderPeriodComparisonTableHtml(rows, { sort: cancelled }), /aria-sort="none"/);
  assert.match(
    renderPeriodComparisonTableHtml(rows, { sort: defaultSort }),
    /title="默认排序优先级：今日 → 本周 → 本月 → 全部（各项倒序）"/,
  );

  const manualTieRows = [
    {
      key: "low-today",
      name: "/work/low-today",
      kind: "directory",
      periods: { today: { total: 1 }, week: { total: 5 } },
    },
    { key: "high-today", name: "/work/high-today", kind: "git", periods: { today: { total: 10 }, week: { total: 5 } } },
    {
      key: "low-week",
      name: "/work/low-week",
      kind: "directory",
      periods: { today: { total: 100 }, week: { total: 2 } },
    },
  ];
  const manualWeekAscending = { period: "week", direction: "asc", showIndicator: true };
  const manualNames = [
    ...renderPeriodComparisonTableHtml(manualTieRows, { kind: "repository", sort: manualWeekAscending }).matchAll(
      /class="comparison-row-label"[^>]*>([^<]+)<\/span>/g,
    ),
  ].map((match) => match[1]);
  assert.deepEqual(manualNames, ["high-today", "low-week", "low-today"]);
  assert.match(
    renderPeriodComparisonTableHtml(rows, { kind: "repository", sort: defaultSort }),
    /title="本地 Git 仓库优先；默认排序优先级/,
  );
  const queried = renderPeriodComparisonTableHtml(rows, { kind: "repository", query: "month", sort: ascending });
  assert.match(queried, />d-month<\/span>/);
  assert.doesNotMatch(queried, />b-today<\/span>/);
  assert.deepEqual(
    rows.map((row) => row.key),
    ["directory:all", "git:month", "directory:week", "directory:today", "git:zero"],
  );
});

test("auto refresh timestamps use the selected calendar zone and identify it", () => {
  const value = "2026-01-01T12:05:30.000Z";
  const utc = formatAutoRefreshTimestamp(value, "en-US", "utc");
  assert.match(utc, /12:05/);
  assert.match(utc, /UTC/);
  assert.equal(formatAutoRefreshTimestamp("not a date", "en-US", "utc"), "");
});

test("natural week comparison headings and accessible sort labels use 本周", () => {
  const rows = [
    {
      key: "gpt-6-luna",
      name: "gpt-6-luna",
      periods: {
        today: { total: 1 },
        week: { total: 2 },
        month: { total: 3 },
        all: { total: 4 },
      },
    },
  ];
  const html = renderPeriodComparisonTableHtml(rows, {
    kind: "model",
    expanded: { kind: "model", key: "gpt-6-luna", period: "week" },
  });
  assert.match(html, /本周/);
  assert.match(html, /aria-label="按本周用量排序"/);
  assert.match(html, /title="默认排序优先级：今日 → 本周 → 本月 → 全部（各项倒序）"/);
  assert.match(html, /本周明细/);
  assert.doesNotMatch(html, /本自然周明细/);
});

test("period comparison includes the union of all four periods and reconciles totals", () => {
  const models = filterPeriodComparisonRows([
    {
      key: "gpt-6-luna",
      periods: {
        today: { total: 120 },
        week: { total: 200 },
        month: { total: 300 },
        all: { total: 400 },
      },
    },
    {
      key: "gpt-6-sol",
      periods: {
        today: { total: 0 },
        week: { total: 4 },
        month: { total: 4 },
        all: { total: 4 },
      },
    },
    {
      key: "gpt-6-astra",
      periods: {
        today: { total: 0 },
        week: { total: 0 },
        month: { total: 0 },
        all: { total: 0 },
      },
    },
  ]);
  assert.deepEqual(
    models.map((row) => row.key),
    ["gpt-6-luna", "gpt-6-sol"],
  );
  for (const [period, total] of Object.entries({ today: 120, week: 204, month: 304, all: 404 })) {
    assert.equal(
      models.reduce((sum, row) => sum + row.periods[period].total, 0),
      total,
    );
  }

  const repositories = filterPeriodComparisonRows([
    {
      key: "directory:shared",
      kind: "directory",
      periods: { today: { total: 12 }, week: { total: 12 }, month: { total: 12 }, all: { total: 12 } },
    },
    {
      key: "directory:inactive",
      kind: "directory",
      periods: { today: { total: 0 }, week: { total: 0 }, month: { total: 0 }, all: { total: 0 } },
    },
    {
      key: "git:repo",
      kind: "git",
      sourceKeys: ["git:repo"],
      periods: { today: { total: 0 }, week: { total: 30 }, month: { total: 30 }, all: { total: 30 } },
    },
  ]);
  assert.deepEqual(
    repositories.map((row) => row.key),
    ["directory:shared", "git:repo"],
  );
});

test("event date range handles enough records to exceed argument spread limits", () => {
  setSummaryFilters({ preset: "all", now: null, startDate: "", endDate: "" });
  const firstTimestamp = Date.parse("2026-01-01T00:00:00.000Z");
  const lastTimestamp = firstTimestamp + 124_999 * 1000;
  const events = Array.from({ length: 125_000 }, (_, index) => ({
    timestamp: new Date(firstTimestamp + index * 1000).toISOString(),
  }));

  const range = getRange(events);
  assert.ok(range.start instanceof Date);
  assert.ok(range.end instanceof Date);
  assert.ok(range.start.getTime() <= firstTimestamp);
  assert.ok(range.end.getTime() >= lastTimestamp);
});

test("timeline maximum handles enough values to exceed argument spread limits", () => {
  const values = Array(125_000).fill(1);
  values[values.length - 1] = 42;
  assert.equal(maxTimelineValue(values), 42);
});

test("channel colors remain attached to channels when row order changes", () => {
  const oldDocument = globalThis.document;
  const oldGetComputedStyle = globalThis.getComputedStyle;
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  try {
    const channels = [{ name: "CLI" }, { name: "IDE" }, { name: "API" }, { name: "Unknown" }];
    const first = getChannelColors(channels);
    const reordered = getChannelColors([...channels].reverse());
    for (const channel of channels) {
      assert.equal(reordered.get(channel.name), first.get(channel.name));
    }
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
    if (oldGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = oldGetComputedStyle;
  }
});

test("timeline model and channel legends assign distinct colors in both themes", () => {
  const oldDocument = globalThis.document;
  const rows = ["gpt-5.6-luna", "gpt-6-luna", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-astra", "codex-auto-review"].map(
    (name, index) => ({ name, total: { total: 600 - index * 100 } }),
  );
  const rgb = (hex) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  try {
    for (const theme of ["light", "dark"]) {
      globalThis.document = { documentElement: { dataset: { theme } } };
      for (const colorsFor of [getModelColors, getChannelColors]) {
        const colors = colorsFor(rows);
        const reordered = colorsFor([...rows].reverse());
        const swatches = [...colors.values()];
        assert.equal(new Set(swatches).size, rows.length);
        for (const row of rows) assert.equal(colors.get(row.name), reordered.get(row.name));
        if (colorsFor === getModelColors) {
          assert.equal(colors.get("gpt-6-luna"), getModelColors([{ name: "gpt-6-luna" }]).get("gpt-6-luna"));
        }
        for (let i = 0; i < swatches.length; i += 1) {
          for (let j = i + 1; j < swatches.length; j += 1) {
            const first = rgb(swatches[i]);
            const second = rgb(swatches[j]);
            assert.ok(Math.hypot(...first.map((value, channel) => value - second[channel])) > 85);
          }
        }
      }
    }
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

test("timeline legend shows every model directly without a heading or expand control", () => {
  const oldDocument = globalThis.document;
  globalThis.document = { documentElement: { dataset: { theme: "dark" } } };
  try {
    const names = [
      "gpt-5.6-luna",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-6-sol",
      "gpt-6-astra",
      "codex-auto-review",
      "Unknown model",
    ];
    const colors = getModelColors(names.map((name) => ({ name })));
    const timeline = [
      {
        models: names.map((name, index) => ({ name, total: { total: index + 1 } })),
        costByModel: Object.fromEntries(names.map((name, index) => [name, { totalUsd: index + 1 }])),
      },
    ];
    for (const mode of ["model", "cost"]) {
      const html = renderTimelineLegendHtml({ timeline }, mode, new Map(), colors);
      assert.equal((html.match(/role="listitem"/g) || []).length, names.length);
      for (const name of names) assert.ok(html.includes(`>${name.toLowerCase()}</span>`));
      assert.doesNotMatch(html, /<details|timeline-legend-title|其余/);
    }
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

test("render helpers escape usage row names before inserting HTML", () => {
  const rows = [
    {
      name: '<img src=x onerror="alert(1)">',
      total: { total: 42, input: 40, cached: 0, output: 2, reasoning: 0 },
    },
  ];

  const barHtml = renderBarListHtml(rows);

  assert.doesNotMatch(barHtml, /<img/i);
  assert.match(barHtml, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("renderHomesHtml shows escaped statuses and removable imported directories", () => {
  const html = renderHomesHtml(
    [
      {
        label: "Project <unsafe>",
        kind: "project-log",
        path: "/tmp/project&one",
        imported: true,
        status: "active",
        eventCount: 3,
      },
    ],
    { canModify: true },
  );

  assert.doesNotMatch(html, /Project <unsafe>/);
  assert.match(html, /Project &lt;unsafe&gt;/);
  assert.match(html, /\/tmp\/project&amp;one/);
  assert.match(html, /data-import-action="remove"/);
  assert.match(html, /有用量记录/);
});

test("renderSourceOptionsHtml 勾选默认选中的来源并跳过无 id 项", () => {
  const homes = [
    {
      id: "main-1",
      label: "Main Codex",
      kind: "main",
      path: "/u/.codex",
      status: "active",
      eventCount: 5,
      sessionCount: 2,
    },
    {
      id: "zcode-1",
      label: "Main ZCode",
      kind: "zcode",
      path: "/u/.zcode",
      status: "active",
      eventCount: 9,
      sessionCount: 3,
    },
    { label: "导入 <unsafe>", kind: "unsupported", path: "/tmp/x", eventCount: 0 },
  ];
  const html = renderSourceOptionsHtml(homes, ["zcode-1"]);

  assert.match(html, /data-source-id="main-1" checked/);
  assert.doesNotMatch(html, /data-source-id="zcode-1" checked/);
  assert.match(html, /Main ZCode/);
  assert.match(html, /source-option excluded/);
  assert.match(html, /5 条事件 · 2 个会话/);
  assert.match(html, /有用量记录/);
  assert.equal((html.match(/不计入统计/g) || []).length, 1);
  // 没有稳定 id 的条目（如不支持的导入）不进入多选列表。
  assert.doesNotMatch(html, /unsafe/);
  assert.equal(renderSourceOptionsHtml([], []), `<div class="empty">没有可统计的来源</div>`);
});

test("renderHomesHtml 标记被排除统计的来源", () => {
  const html = renderHomesHtml(
    [
      {
        id: "zcode-1",
        label: "Main ZCode",
        kind: "zcode",
        path: "/u/.zcode",
        status: "active",
        eventCount: 9,
        sessionCount: 3,
      },
      {
        id: "main-1",
        label: "Main Codex",
        kind: "main",
        path: "/u/.codex",
        status: "active",
        eventCount: 5,
        sessionCount: 2,
      },
    ],
    { excludedIds: ["zcode-1"] },
  );

  assert.match(html, /home-row excluded/);
  assert.match(html, /不计入统计/);
  assert.equal((html.match(/不计入统计/g) || []).length, 1);
});

test("费用金额按币种显示符号，混合币种并列展示", () => {
  assert.match(formatCostAmount(1.5, "USD"), /\$1\.50/);
  assert.match(formatCostAmount(1.5, "CNY"), /1\.50/);
  assert.match(formatCostAmount(1.5, "CNY"), /¥/);
  assert.equal(formatCostPair(null, null), "—");
  assert.match(formatCostPair(1, null), /^\$1\.00$/);
  assert.match(formatCostPair(null, 2), /2\.00/);
  assert.match(formatCostPair(1, 2), /\$1\.00 \+ .*2\.00/);

  const pair = costPairFromSlots({
    a: { totalUsd: 3, currency: "USD" },
    b: { totalUsd: 4, currency: "CNY" },
    c: { totalUsd: 0, currency: "CNY" },
  });
  assert.deepEqual(pair, { usd: 3, cny: 4 });
  assert.deepEqual(costPairFromSlots({}), { usd: null, cny: null });
});

test("fitTextToWidth 只缩小字号且不破下限，放得下时不改动", () => {
  const oldGetComputedStyle = globalThis.getComputedStyle;
  const makeElement = (fitsAtSize) => {
    const element = { style: { fontSize: "" }, clientWidth: 100 };
    Object.defineProperty(element, "scrollWidth", {
      get() {
        const size = this.style.fontSize ? parseFloat(this.style.fontSize) : 22;
        return size <= fitsAtSize ? 100 : 140;
      },
    });
    return element;
  };
  globalThis.getComputedStyle = () => ({ fontSize: "22px" });
  try {
    const needsShrink = makeElement(16);
    fitTextToWidth(needsShrink);
    assert.equal(needsShrink.style.fontSize, "16px");

    const hopeless = makeElement(5);
    fitTextToWidth(hopeless);
    assert.equal(hopeless.style.fontSize, "11px");

    const alreadyFits = makeElement(22);
    fitTextToWidth(alreadyFits);
    assert.equal(alreadyFits.style.fontSize, "");
  } finally {
    globalThis.getComputedStyle = oldGetComputedStyle;
  }
});

test("图例按名称字母排序，跨币种费用按汇率折算比较", () => {
  const summary = {
    timeline: [
      {
        channels: [{ name: "ZCode", total: { total: 500 } }],
        models: [
          { name: "aaa-model", total: { total: 200 } },
          { name: "zzz-model", total: { total: 500 } },
        ],
      },
    ],
  };
  const legendHtml = renderTimelineLegendHtml(
    summary,
    "model",
    new Map(),
    new Map([
      ["aaa-model", "#111111"],
      ["zzz-model", "#222222"],
    ]),
  );
  // 字母序：aaa 在前；若按用量排 zzz 会在前。
  assert.ok(legendHtml.indexOf("aaa-model") < legendHtml.indexOf("zzz-model"));

  // ¥75.51 按 7.2 汇率约合 $10.49，排序应低于 $60.11。
  assert.ok(costScaleValue(75.51, "CNY", 7.2, "CNY") < costScaleValue(60.11, "USD", 7.2, "CNY"));
  assert.ok(costScaleValue(75.51, "CNY", 7.2, "USD") < costScaleValue(60.11, "USD", 7.2, "USD"));
  assert.equal(costScaleValue(75.51, "CNY", 7.2, "CNY"), 75.51);
  assert.ok(Math.abs(costScaleValue(60.11, "USD", 7.2, "CNY") - 432.792) < 1e-9);
});

test("renderComparisonHtml renders trend, average trend, and previous totals", () => {
  const html = renderComparisonHtml({
    label: "较上周",
    previousRange: {
      start: "2026-06-15T00:00:00.000Z",
      end: "2026-06-21T23:59:59.999Z",
    },
    previousTotals: { total: 62_617_267, input: 62_617_267, cached: 0, output: 0, reasoning: 0 },
    previousSessionCount: 2,
    totalDelta: -25_518_704,
    percentChange: -57.14,
    averageBaselineTotal: 50,
    averageDelta: 8_581_809,
    averagePercentChange: 500,
  });

  assert.match(html, /较上周/);
  assert.match(html, /同比流速/);
  assert.match(html, /上周 tokens/);
  assert.match(html, /<strong title="-25,518,704">-25\.52M<\/strong>/);
  assert.match(html, /<strong title="\+8,581,809">\+8\.58M<\/strong>/);
  assert.match(html, /<strong title="62,617,267">62\.62M<\/strong>/);
  assert.match(html, /2 个会话/);
});

test("renderComparisonHtml names the previous token period for day, week, and month", () => {
  const labels = [
    ["较昨日", "昨日 tokens"],
    ["较上周", "上周 tokens"],
    ["较上月", "上月 tokens"],
  ];

  for (const [comparisonLabel, expected] of labels) {
    const html = renderComparisonHtml({
      label: comparisonLabel,
      previousRange: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-01T23:59:59.999Z" },
      previousTotals: { total: 1_000_000 },
      previousSessionCount: 1,
      totalDelta: 0,
      percentChange: 0,
      averageDelta: 0,
      averagePercentChange: 0,
    });

    assert.ok(html.includes(`<span>${expected}</span>`), `expected ${comparisonLabel} to render ${expected}`);
  }
});

test("renderComparisonHtml explains all-time comparisons and dates custom baselines", () => {
  const allTimeHtml = renderComparisonHtml({ label: "暂无对比", previousRange: null });
  assert.match(allTimeHtml, /全部范围没有可比较的上一周期/);
  assert.doesNotMatch(allTimeHtml, /上一周期 tokens/);
  const incompleteCustomHtml = renderComparisonHtml({ label: "较上一等长周期", previousRange: null });
  assert.match(incompleteCustomHtml, /当前范围没有可比较的上一周期/);

  const customHtml = renderComparisonHtml({
    label: "较上一等长周期",
    previousRange: {
      start: new Date(2026, 7, 31),
      end: new Date(2026, 8, 9, 23, 59, 59, 999),
    },
    previousTotals: { total: 12_345_678 },
    previousSessionCount: 4,
    totalDelta: 1_000_000,
    percentChange: 8.1,
    averageDelta: 500_000,
    averagePercentChange: 4.2,
  });
  assert.match(customHtml, /前一等长区间 tokens/);
  assert.match(customHtml, /2026-08-31 至 2026-09-09 · 4 个会话/);
});

test("datePickerMonthModel starts weeks on Monday and keeps outside-month days selectable", () => {
  const model = datePickerMonthModel(new Date("2026-07-15T12:00:00"), "2026-06-30");

  assert.deepEqual(model.weekdays, ["一", "二", "三", "四", "五", "六", "日"]);
  assert.deepEqual(
    model.cells.slice(0, 7).map((cell) => [cell.date, cell.inCurrentMonth]),
    [
      ["2026-06-29", false],
      ["2026-06-30", false],
      ["2026-07-01", true],
      ["2026-07-02", true],
      ["2026-07-03", true],
      ["2026-07-04", true],
      ["2026-07-05", true],
    ],
  );
  assert.equal(model.cells[1].selected, true);
});

test("renderDatePickerHtml marks outside-month dates as dim but selectable buttons", () => {
  const html = renderDatePickerHtml({
    field: "start",
    viewDate: new Date("2026-07-15T12:00:00"),
    startDate: "2026-06-30",
    endDate: "2026-07-02",
  });

  assert.match(html, /<div class="date-picker-weekday">一<\/div>/);
  assert.match(html, /data-date="2026-06-29"[^>]*class="date-picker-day outside-month"/);
  assert.match(html, /data-date="2026-06-30"[^>]*class="date-picker-day outside-month selected range-start"/);
  assert.match(html, /data-date="2026-07-01"[^>]*class="date-picker-day in-range"/);
  assert.match(html, /data-date="2026-07-02"[^>]*class="date-picker-day selected range-end"/);
  assert.match(html, /type="button"[^>]*data-date="2026-06-29"/);
});

test("renderDatePickerHtml enables the clear control once a date is picked and disables it when empty", () => {
  const withRange = renderDatePickerHtml({
    field: "start",
    viewDate: new Date("2026-07-15T12:00:00"),
    startDate: "2026-06-30",
    endDate: "2026-07-02",
  });
  assert.match(withRange, /class="date-picker-clear" data-date-picker-clear aria-label=/);
  assert.doesNotMatch(withRange, /data-date-picker-clear disabled/);

  const empty = renderDatePickerHtml({ field: "end", viewDate: new Date("2026-07-15T12:00:00") });
  assert.match(empty, /data-date-picker-clear disabled/);
  assert.match(empty, /class="date-picker-hint picking-end"/);
});

test("date range selection keeps the first endpoint pending and commits the second across months", () => {
  const pending = selectDateRange({ startDate: "2026-09-01", field: "start" }, "2026/9/29");
  assert.deepEqual(pending, {
    startDate: "2026-09-29",
    endDate: "",
    field: "end",
    complete: false,
  });
  assert.deepEqual(selectDateRange(pending, "2026-10-02"), {
    startDate: "2026-09-29",
    endDate: "2026-10-02",
    field: "start",
    complete: true,
  });
});

test("date range selection orders reversed endpoints and allows a single day", () => {
  assert.deepEqual(selectDateRange({ startDate: "2026-09-29", field: "end" }, "2026-09-20"), {
    startDate: "2026-09-20",
    endDate: "2026-09-29",
    field: "start",
    complete: true,
  });
  const singleDay = selectDateRange({ startDate: "2026-09-29", field: "end" }, "2026-09-29");
  assert.equal(singleDay.startDate, singleDay.endDate);
  assert.equal(singleDay.complete, true);
  assert.match(
    renderDatePickerHtml({ ...singleDay, viewDate: new Date("2026-09-01T12:00:00") }),
    /data-date="2026-09-29"[^>]*class="date-picker-day selected range-start range-end"/,
  );
});

test("date range selection rejects invalid dates and starts a new range when no start exists", () => {
  assert.equal(selectDateRange({ startDate: "2026-09-29", field: "end" }, "2026-02-30"), null);
  assert.equal(selectDateRange({}, ""), null);
  assert.equal(selectDateRange({ field: "end" }, "2026-09-29").complete, false);
});

test("timelineAxisLabels shows all 24 labels for a single hourly day", () => {
  // Single-day hourly charts should label every hour from midnight through the last hour.
  const rows = Array.from({ length: 24 }, (_, hour) => ({
    key: `2026-06-18 ${String(hour).padStart(2, "0")}:00`,
  }));

  assert.deepEqual(
    timelineAxisLabels(rows, {
      bucket: "hour",
      range: {
        start: "2026-06-18T00:00:00",
        end: "2026-06-18T23:59:59.999",
      },
      maxLabels: 8,
    }).map((label) => label.label),
    Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")),
  );
});

test("timelineAxisLabels samples hourly labels outside a single day", () => {
  // Multi-day hourly charts sample labels at a fixed step anchored to the most recent slot.
  const rows = Array.from({ length: 48 }, (_, index) => {
    const day = index < 24 ? "18" : "19";
    const hour = String(index % 24).padStart(2, "0");
    return { key: `2026-06-${day} ${hour}:00` };
  });
  const labels = timelineAxisLabels(rows, {
    bucket: "hour",
    range: {
      start: "2026-06-18T00:00:00",
      end: "2026-06-19T23:59:59.999",
    },
    maxLabels: 8,
  });

  assert.equal(labels.length, 8);
  const indexes = labels.map((label) => label.index);
  assert.deepEqual(indexes, [5, 11, 17, 23, 29, 35, 41, 47]);
  assert.deepEqual(
    indexes.slice(1).map((index, position) => index - indexes[position]),
    [6, 6, 6, 6, 6, 6, 6],
  );
  assert.deepEqual([labels[0].label, labels.at(-1).label], ["06-18 05", "06-19 23"]);
});

test("timelineAxisLabels keeps equal day gaps over a full month and skips future days", () => {
  // 月视图：整月 30 槽，28-30 是未来日不参与刻度；固定步长间隔全等（旧算法为 3/2 天交替）。
  const rows = Array.from({ length: 30 }, (_, index) => ({
    key: `2026-09-${String(index + 1).padStart(2, "0")}`,
  }));
  const labels = timelineAxisLabels(rows, {
    bucket: "day",
    range: { preset: "month", start: "2026-09-01T00:00:00", end: "2026-09-27T23:59:59" },
    maxLabels: 12,
  });

  const indexes = labels.map((label) => label.index);
  assert.deepEqual(indexes, [2, 5, 8, 11, 14, 17, 20, 23, 26]);
  assert.deepEqual(
    indexes.slice(1).map((index, position) => index - indexes[position]),
    [3, 3, 3, 3, 3, 3, 3, 3],
  );
  assert.equal(labels.at(-1).label, "27");
});

test("timelineAxisLabels keeps every day labeled when slots fit the text", () => {
  // 13 天的"全部"视图曾在 12 标签上限下整段跳过 09-21；步长为 1 时必须全天保留。
  const rows = Array.from({ length: 13 }, (_, index) => ({
    key: `2026-09-${String(index + 15).padStart(2, "0")}`,
  }));
  const labels = timelineAxisLabels(rows, {
    bucket: "day",
    range: { preset: "all", start: "2026-09-15T00:00:00", end: "2026-09-27T23:59:59" },
    maxLabels: 22,
  });

  assert.deepEqual(
    labels.map((label) => label.index),
    Array.from({ length: 13 }, (_, index) => index),
  );
  assert.ok(labels.some((label) => label.label === "09-21"));
});

test("drawTimeline does not draw visible bars for zero-token rows", () => {
  // Empty hourly buckets should keep hit areas and labels without painting 2px fake bars.
  const calls = [];
  const context = {
    clearRect: (...args) => calls.push(["clearRect", ...args]),
    scale: (...args) => calls.push(["scale", ...args]),
    beginPath: (...args) => calls.push(["beginPath", ...args]),
    moveTo: (...args) => calls.push(["moveTo", ...args]),
    lineTo: (...args) => calls.push(["lineTo", ...args]),
    stroke: (...args) => calls.push(["stroke", ...args]),
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    fillText: (...args) => calls.push(["fillText", ...args]),
    save: (...args) => calls.push(["save", ...args]),
    translate: (...args) => calls.push(["translate", ...args]),
    rotate: (...args) => calls.push(["rotate", ...args]),
    restore: (...args) => calls.push(["restore", ...args]),
    measureText: () => ({ width: 20 }),
  };
  const canvas = {
    clientWidth: 960,
    clientHeight: 320,
    dataset: {},
    getContext: () => context,
  };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: () => "",
  });

  try {
    drawTimeline(canvas, [
      {
        key: "2026-06-18 00:00",
        total: { total: 0 },
        channels: [],
      },
    ]);

    assert.equal(calls.filter(([name]) => name === "fillRect").length, 0);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});

test("drawTimeline renders model and cost stacks and rejects missing breakdowns", () => {
  const calls = [];
  let currentFillStyle = "";
  const context = {
    clearRect: () => {},
    scale: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fillRect: (...args) => calls.push({ type: "rect", fillStyle: currentFillStyle, args }),
    fillText: (text) => calls.push({ type: "text", text }),
    save: () => {},
    translate: () => {},
    rotate: () => {},
    restore: () => {},
    measureText: () => ({ width: 20 }),
    set fillStyle(value) {
      currentFillStyle = value;
    },
    get fillStyle() {
      return currentFillStyle;
    },
  };
  const canvas = {
    clientWidth: 960,
    clientHeight: 320,
    dataset: {},
    getContext: () => context,
  };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });

  try {
    const row = {
      key: "2026-09-23 12:00",
      total: { total: 100 },
      channels: [],
      models: [{ name: "gpt-6-sol", total: { total: 100 } }],
      costByModel: {
        "gpt-6-sol": { totalUsd: 0.25, pricedTokens: 100, unpricedTokens: 0 },
      },
      pricedTokens: 100,
      unpricedTokens: 0,
    };
    const modelRows = [{ name: "gpt-6-sol", total: { total: 100 } }];

    const allPeriodColors = new Map([["gpt-6-sol", "#123456"]]);
    drawTimeline(canvas, [row], [], new Map(), null, "model", modelRows, allPeriodColors);
    const modelBars = calls.filter((call) => call.type === "rect");
    assert.equal(modelBars.length, 1);
    assert.equal(modelBars[0].fillStyle, allPeriodColors.get("gpt-6-sol"));

    calls.length = 0;
    drawTimeline(canvas, [row], [], new Map(), null, "cost", modelRows, allPeriodColors);
    const costBars = calls.filter((call) => call.type === "rect");
    assert.equal(costBars.length, 1);
    assert.equal(costBars[0].fillStyle, modelBars[0].fillStyle);
    assert.ok(calls.some((call) => call.type === "text" && call.text === "$0.25"));

    const staleRow = { key: row.key, total: row.total };
    for (const [mode, message] of [
      ["model", "模型明细不可用"],
      ["cost", "费用明细不可用"],
    ]) {
      calls.length = 0;
      drawTimeline(canvas, [staleRow], [], new Map(), null, mode, modelRows);
      assert.equal(calls.filter((call) => call.type === "rect").length, 0);
      assert.ok(calls.some((call) => call.type === "text" && call.text.includes(message)));
    }
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});
test("drawTimeline keeps dense hourly bars inside the chart width", () => {
  // Dense all-time hourly charts must shrink visual bars instead of pushing later bars off-canvas.
  const calls = [];
  const context = {
    clearRect: (...args) => calls.push(["clearRect", ...args]),
    scale: (...args) => calls.push(["scale", ...args]),
    beginPath: (...args) => calls.push(["beginPath", ...args]),
    moveTo: (...args) => calls.push(["moveTo", ...args]),
    lineTo: (...args) => calls.push(["lineTo", ...args]),
    stroke: (...args) => calls.push(["stroke", ...args]),
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    fillText: (...args) => calls.push(["fillText", ...args]),
    save: (...args) => calls.push(["save", ...args]),
    translate: (...args) => calls.push(["translate", ...args]),
    rotate: (...args) => calls.push(["rotate", ...args]),
    restore: (...args) => calls.push(["restore", ...args]),
    measureText: () => ({ width: 20 }),
  };
  const canvas = {
    clientWidth: 1200,
    clientHeight: 320,
    dataset: {},
    getContext: () => context,
  };
  const rows = Array.from({ length: 700 }, (_, index) => ({
    key: `2026-06-${String(Math.floor(index / 24) + 1).padStart(2, "0")} ${String(index % 24).padStart(2, "0")}:00`,
    total: { total: index === 699 ? 100 : 1 },
    channels: [],
  }));
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: () => "",
  });

  try {
    drawTimeline(canvas, rows);

    const visibleBars = calls.filter(([name]) => name === "fillRect");
    const lastBar = visibleBars.at(-1);
    assert.ok(lastBar[1] + lastBar[3] <= 1200 - 18);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});

test("timeline labels show natural week weekdays and full month dates", () => {
  const weekRows = Array.from({ length: 7 }, (_, index) => ({
    key: `2026-05-${String(4 + index).padStart(2, "0")}`,
  }));
  assert.deepEqual(
    timelineAxisLabels(weekRows, {
      bucket: "day",
      // range.end 需覆盖整周：超出 end 的行是未来槽位，不参与刻度候选。
      range: { preset: "week", start: "2026-05-04T00:00:00", end: "2026-05-10T23:59:59" },
    }).map((label) => label.label),
    ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
  );

  const monthRows = Array.from({ length: 29 }, (_, index) => ({
    key: `2024-02-${String(index + 1).padStart(2, "0")}`,
  }));
  const labels = timelineAxisLabels(monthRows, {
    bucket: "day",
    // range.end 需覆盖整月：超出 end 的行现在是未来槽位，不参与刻度候选。
    range: { preset: "month", start: "2024-02-01T00:00:00", end: "2024-02-29T23:59:59" },
    chartWidth: 2000,
    maxLabels: 31,
  });
  assert.equal(labels.length, 29);
  assert.deepEqual([labels[0].label, labels.at(-1).label], ["01", "29"]);

  assert.equal(
    timelineAxisLabels([{ key: "2026-05-04" }], {
      bucket: "week",
      range: { preset: "all", start: "2026-05-04T00:00:00", end: "2026-05-10T23:59:59" },
    })[0].label,
    "05-04",
  );
});

test("drawTimeline centers date ticks under capped slot bars", () => {
  const calls = [];
  const context = {
    clearRect: (...args) => calls.push(["clearRect", ...args]),
    scale: (...args) => calls.push(["scale", ...args]),
    beginPath: (...args) => calls.push(["beginPath", ...args]),
    moveTo: (...args) => calls.push(["moveTo", ...args]),
    lineTo: (...args) => calls.push(["lineTo", ...args]),
    stroke: (...args) => calls.push(["stroke", ...args]),
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    fillText: (...args) => calls.push(["fillText", ...args]),
    save: (...args) => calls.push(["save", ...args]),
    translate: (...args) => calls.push(["translate", ...args]),
    rotate: (...args) => calls.push(["rotate", ...args]),
    restore: (...args) => calls.push(["restore", ...args]),
    measureText: () => ({ width: 20 }),
  };
  const canvas = {
    clientWidth: 960,
    clientHeight: 320,
    dataset: {},
    getContext: () => context,
  };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  try {
    drawTimeline(
      canvas,
      [{ key: "2026-05-26", total: { total: 100 }, channels: [] }],
      [],
      new Map(),
      {
        preset: "custom",
        start: "2026-05-26T00:00:00",
        end: "2026-05-26T23:59:59",
      },
      "channel",
    );
    const bar = calls.find(([name]) => name === "fillRect");
    const tick = calls.find(([name]) => name === "translate");
    assert.ok(bar);
    assert.equal(bar[3], 30);
    assert.equal(bar[1] + bar[3] / 2, tick[1]);
    assert.ok(bar[3] < 960 - 64 - 18);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});

test("model names render lowercase while data keys, colors, and non-model labels keep their casing", () => {
  const mixed = "GLM-4.7-Air";
  const periods = { today: { total: 10 }, week: { total: 0 }, month: { total: 0 }, all: { total: 0 } };

  const comparisonHtml = renderPeriodComparisonTableHtml([{ key: mixed, name: mixed, periods }], { kind: "model" });
  assert.match(
    comparisonHtml,
    /class="comparison-row-label" title="glm-4\.7-air" aria-label="glm-4\.7-air">glm-4\.7-air</,
  );
  assert.match(comparisonHtml, /data-key="GLM-4\.7-Air"/);
  assert.match(
    renderPeriodComparisonTableHtml([{ key: mixed, name: mixed, periods }], { kind: "model", query: "GLM" }),
    /glm-4\.7-air</,
  );
  const repoHtml = renderPeriodComparisonTableHtml([{ key: "repo:x", name: "/Work/MixedCase", periods }], {
    kind: "repository",
  });
  assert.match(repoHtml, /aria-label="MixedCase">MixedCase</);

  const modelColors = new Map([[mixed, "#123456"]]);
  const modelBarHtml = renderBarListHtml([{ name: mixed, total: { total: 20 } }], modelColors, { modelNames: true });
  assert.match(modelBarHtml, /title="glm-4\.7-air">glm-4\.7-air</);
  assert.match(modelBarHtml, /aria-label="glm-4\.7-air：20 tokens"/);
  assert.match(modelBarHtml, /background: #123456/);
  assert.match(renderBarListHtml([{ name: "CLI", total: { total: 5 } }]), /title="CLI">CLI</);

  const costDetailHtml = renderCostDetailHtml(
    [{ name: mixed, totalUsd: 1.5, currency: "USD", scaleValue: 1.5 }],
    modelColors,
  );
  assert.match(costDetailHtml, /title="glm-4\.7-air">glm-4\.7-air</);
  assert.match(costDetailHtml, /background: #123456/);

  const legendSummary = {
    timeline: [
      {
        models: [{ name: mixed, total: { total: 8 } }],
        channels: [{ name: "CLI", total: { total: 8 } }],
        costByModel: { [mixed]: { totalUsd: 0.5, currency: "USD" } },
      },
    ],
  };
  assert.match(renderTimelineLegendHtml(legendSummary, "model", new Map(), modelColors), />glm-4\.7-air</);
  assert.match(renderTimelineLegendHtml(legendSummary, "cost", new Map(), modelColors), />glm-4\.7-air</);
  assert.match(renderTimelineLegendHtml(legendSummary, "channel", new Map(), new Map()), />CLI</);

  const usageTooltipHtml = formatUsageTooltip(
    { name: mixed, total: { total: 3 }, channels: [{ name: "CLI", total: { total: 3 } }] },
    null,
    { modelNames: true },
  );
  assert.match(usageTooltipHtml, /usage-tooltip-title">glm-4\.7-air</);
  assert.match(usageTooltipHtml, /usage-tooltip-label">CLI</);
  assert.doesNotMatch(usageTooltipHtml, /GLM/);
  assert.match(formatUsageTooltip({ name: "CLI", total: { total: 3 } }), /usage-tooltip-title">CLI</);

  const slotRow = {
    name: "2026-09-27 10:00",
    models: [{ name: mixed, total: { total: 6 } }],
    costByModel: { [mixed]: { totalUsd: 0.4, currency: "USD" } },
    total: { total: 6 },
  };
  assert.match(formatTimelineTooltip(slotRow, "model"), /usage-tooltip-label">glm-4\.7-air</);
  assert.doesNotMatch(formatTimelineTooltip(slotRow, "model"), /GLM/);
  assert.match(formatTimelineTooltip(slotRow, "cost"), /usage-tooltip-label">glm-4\.7-air</);
});

test("timelineAxisLabels renders month keys as month names within one year and full keys across years", () => {
  const sameYear = timelineAxisLabels(
    Array.from({ length: 9 }, (_, index) => ({ key: `2026-0${index + 1}` })),
    {
      bucket: "month",
      range: { preset: "all", start: "2026-01-15T00:00:00", end: "2026-09-01T23:59:59" },
      maxLabels: 20,
    },
  );
  assert.deepEqual(
    sameYear.map((label) => label.label),
    ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月"],
  );

  const crossYear = timelineAxisLabels([{ key: "2025-11" }, { key: "2025-12" }, { key: "2026-01" }], {
    bucket: "month",
    range: { preset: "all", start: "2025-11-01T00:00:00", end: "2026-01-31T23:59:59" },
    maxLabels: 10,
  });
  assert.deepEqual(
    crossYear.map((label) => label.label),
    ["2025-11", "2025-12", "2026-01"],
  );
});

test("timelineSlotRangeTitle expands week and month keys into covered date ranges", () => {
  const weekFull = timelineSlotRangeTitle(
    { key: "2026-03-09" },
    { bucket: "week", start: "2026-03-09T00:00:00", end: "2026-09-01T23:59:59.999" },
  );
  assert.equal(weekFull, "2026-03-09 至 2026-03-15");

  const weekClippedStart = timelineSlotRangeTitle(
    { key: "2026-03-09" },
    { bucket: "week", start: "2026-03-11T00:00:00", end: "2026-09-01T23:59:59.999" },
  );
  assert.equal(weekClippedStart, "2026-03-11 至 2026-03-15（部分周）");

  const weekClippedEnd = timelineSlotRangeTitle(
    { key: "2026-03-09" },
    { bucket: "week", start: "2026-03-09T00:00:00", end: "2026-03-12T23:59:59.999" },
  );
  assert.equal(weekClippedEnd, "2026-03-09 至 2026-03-12（部分周）");

  const monthFull = timelineSlotRangeTitle(
    { key: "2026-04" },
    { bucket: "month", start: "2026-03-15T00:00:00", end: "2026-09-01T23:59:59.999" },
  );
  assert.equal(monthFull, "2026-04-01 至 2026-04-30");

  const monthPartial = timelineSlotRangeTitle(
    { key: "2026-03" },
    { bucket: "month", start: "2026-03-15T00:00:00", end: "2026-09-01T23:59:59.999" },
  );
  assert.equal(monthPartial, "2026-03-15 至 2026-03-31（部分月）");

  const dayBucket = timelineSlotRangeTitle(
    { key: "2026-03-15" },
    { bucket: "day", start: "2026-03-15T00:00:00", end: "2026-03-15T23:59:59.999" },
  );
  assert.equal(dayBucket, null);
});
