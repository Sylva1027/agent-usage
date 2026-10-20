import assert from "node:assert/strict";
import test from "node:test";

import { englishCopyEntries } from "../public/i18n.js";
import {
  formatPerfDuration,
  formatPerfNumber,
  formatPerfRate,
  formatPerfTps,
  renderPerfCoverageHtml,
  renderPerfDetailHtml,
  renderPerfListHtml,
} from "../public/perf-ui.js";

function group(overrides = {}) {
  const dimensions = {
    sourceKind: "zcode",
    homeId: "home-a",
    channel: "zcode-subagent",
    agentKind: "subagent",
    agent: "worker",
    model: "fixture-model",
    modelProvider: "fixture-provider",
    reasoningEffort: "",
    timingKind: "request_e2e",
    tokenScope: "reported_output_unspecified",
  };
  const value = { ...dimensions, ...overrides };
  const defaultTps = { p10: 10.04, p50: 20.26, p90: 40.9, pooled: 25.123 };
  return {
    groupKey: JSON.stringify([
      value.sourceKind,
      value.homeId,
      value.channel,
      value.agentKind,
      value.agent,
      value.model,
      value.modelProvider,
      value.reasoningEffort,
      value.timingKind,
      value.tokenScope,
    ]),
    ...value,
    n: overrides.n ?? 20,
    tps: overrides.tps ?? defaultTps,
    durationMs: { p50: 500, p90: 1200 },
    sums: { outputTokens: 1000, durationMs: 40000 },
    state: "ok",
    rank: 99,
    insufficientSamples: overrides.insufficientSamples ?? false,
    warnings: [],
  };
}

function bucket(overrides = {}) {
  return {
    eligible: 20,
    positiveOutput: 20,
    timedPositiveOutput: 20,
    completeTimedPositiveOutput: 20,
    sampled: 20,
    dropped: 0,
    pending: 0,
    unplaced: 0,
    byFlag: {},
    droppedByReason: {},
    timingRate: 1,
    completeTimingRate: 1,
    sampleRate: 1,
    byEra: null,
    ...overrides,
  };
}

function summary(groups = [], coverage = bucket(), meta = {}) {
  return {
    state: "ready",
    unsupportedSources: [],
    degradedHomeIds: [],
    sourceWarnings: [],
    groups,
    coverage,
    meta: { state: "ready", minSamples: 20, sourceWarnings: [], ...meta },
  };
}

function renderedModels(html, groups) {
  return [...html.matchAll(/data-perf-group-index="(\d+)"/g)].map((match) => groups[Number(match[1])]?.model);
}

test("number formatters keep API values untouched and use locale-aware units", () => {
  assert.equal(formatPerfTps(12.345, "en-US"), "12.3");
  assert.equal(formatPerfNumber(12345, "en-US"), "12,345");
  assert.equal(formatPerfDuration(999, "en-US"), "999 ms");
  assert.equal(formatPerfDuration(1000, "en-US"), "1.0 s");
  assert.equal(formatPerfRate(0.125, "en-US"), "12.5%");
  assert.equal(formatPerfRate(null, "en-US"), "—");
});

test("perf number formatters reuse Intl.NumberFormat per (options object, locale)", () => {
  const nativeNumberFormat = Intl.NumberFormat;
  const formatAll = (locale, values) => {
    for (const value of values) {
      formatPerfNumber(value, locale);
      formatPerfTps(value, locale);
      formatPerfDuration(value, locale);
      formatPerfRate(value, locale);
    }
  };
  const values = [0, 1, 999.5, 1234.567, 1000.4, 987654321.123, -7.9, 1e21];
  let constructions = 0;
  Intl.NumberFormat = function countingNumberFormat(...args) {
    constructions += 1;
    return new nativeNumberFormat(...args);
  };
  Intl.NumberFormat.prototype = nativeNumberFormat.prototype;

  try {
    // A locale that has not been formatted yet builds at most one instance per distinct option set
    // (integer / one decimal / percent) and builds nothing on the repeats.
    for (const locale of ["de-DE", "ja-JP"]) {
      constructions = 0;
      formatAll(locale, values);
      const first = constructions;
      assert.ok(first >= 1 && first <= 3, `expected at most 3 formatters for ${locale}, built ${first}`);
      formatAll(locale, values);
      formatAll(locale, values);
      assert.equal(constructions, first, `repeated formatting must not construct another formatter for ${locale}`);
    }
    // Each locale keeps its own instances instead of borrowing another locale's.
    constructions = 0;
    formatAll("sv-SE", values);
    assert.ok(constructions >= 1 && constructions <= 3);
    // An explicit options object is merged with the integer default once, then reused by identity.
    const overrides = Object.freeze({ maximumFractionDigits: 2 });
    constructions = 0;
    for (let index = 0; index < 25; index += 1) formatPerfNumber(1234.567, "en-US", overrides);
    assert.equal(constructions, 1, "a repeated options object must build one formatter");
  } finally {
    Intl.NumberFormat = nativeNumberFormat;
  }

  // The cache must not change any output: every entry still matches a freshly built formatter.
  for (const locale of ["zh-CN", "en-US", "de-DE", "ja-JP"]) {
    const count = new nativeNumberFormat(locale, { maximumFractionDigits: 0 });
    const single = new nativeNumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const percent = new nativeNumberFormat(locale, { style: "percent", maximumFractionDigits: 1 });
    for (const value of [-1.5, 0, 999.5, 1000, 1234.567, 987654321]) {
      assert.equal(formatPerfNumber(value, locale), count.format(value));
      assert.equal(formatPerfTps(value, locale), single.format(value));
      assert.equal(formatPerfRate(value / 1000, locale), percent.format(value / 1000));
      assert.equal(
        formatPerfDuration(value, locale),
        value < 0 ? "—" : value < 1000 ? `${count.format(value)} ms` : `${single.format(value / 1000)} s`,
      );
    }
  }
});

test("ranking is derived only within the declared pool and small samples follow ranked rows", () => {
  const slow = group({ model: "slow", modelProvider: "provider-a", tps: { p10: 2, p50: 10, p90: 12, pooled: 9 } });
  const fast = group({ model: "fast", modelProvider: "provider-b", tps: { p10: 10, p50: 30, p90: 35, pooled: 29 } });
  const small19 = group({
    model: "small-19",
    n: 19,
    tps: { p10: 50, p50: 50, p90: 50, pooled: 50 },
    insufficientSamples: true,
  });
  const small1 = group({
    model: "small-1",
    n: 1,
    tps: { p10: 1, p50: 1, p90: 1, pooled: 1 },
    insufficientSamples: true,
  });
  const otherHome = group({
    model: "other-home",
    homeId: "home-b",
    tps: { p10: 100, p50: 100, p90: 100, pooled: 100 },
  });
  const html = renderPerfListHtml(summary([slow, fast, small19, small1, otherHome]), {
    locale: "zh-CN",
    homeLabels: new Map([
      ["home-a", "Home A"],
      ["home-b", "Home B"],
    ]),
  });

  assert.ok(html.indexOf('data-perf-group-index="1"') < html.indexOf('data-perf-group-index="0"'));
  assert.ok(html.indexOf('data-perf-group-index="0"') < html.indexOf('data-perf-group-index="2"'));
  assert.ok(html.indexOf('data-perf-group-index="2"') < html.indexOf('data-perf-group-index="3"'));
  assert.match(html, /排名 1/);
  assert.match(html, /排名 2/);
  assert.match(html, /样本不足/);
  assert.match(html, /Home A/);
  assert.match(html, /Home B/);
  assert.equal(
    (html.match(/Home A/g) || []).length,
    1,
    "one source/home heading keeps same-named models together only within a home",
  );
  assert.equal((html.match(/Home B/g) || []).length, 1);
  assert.doesNotMatch(html, /排名 99/, "renderer does not trust global API rank values");
});

test("provider and effort labels preserve rank-pool order and keep API group indexes", () => {
  const providerGroups = [
    group({ model: "rank-A", modelProvider: "provider-A", n: 20, tps: { p10: 90, p50: 100, p90: 110, pooled: 100 } }),
    group({ model: "rank-B", modelProvider: "provider-B", n: 20, tps: { p10: 80, p50: 90, p90: 100, pooled: 90 } }),
    group({ model: "small-A", modelProvider: "provider-A", n: 1, tps: { p10: 190, p50: 200, p90: 210, pooled: 200 } }),
  ];
  const providerHtml = renderPerfListHtml(summary(providerGroups), { locale: "zh-CN" });
  assert.deepEqual(renderedModels(providerHtml, providerGroups), ["rank-A", "rank-B", "small-A"]);

  const effortGroups = [
    group({
      model: "rank-high",
      modelProvider: "provider-A",
      reasoningEffort: "high",
      n: 20,
      tps: { p10: 90, p50: 100, p90: 110, pooled: 100 },
    }),
    group({
      model: "rank-low",
      modelProvider: "provider-A",
      reasoningEffort: "low",
      n: 20,
      tps: { p10: 80, p50: 90, p90: 100, pooled: 90 },
    }),
    group({
      model: "small-high",
      modelProvider: "provider-A",
      reasoningEffort: "high",
      n: 1,
      tps: { p10: 190, p50: 200, p90: 210, pooled: 200 },
    }),
  ];
  const effortHtml = renderPerfListHtml(summary(effortGroups), { locale: "zh-CN" });
  assert.deepEqual(renderedModels(effortHtml, effortGroups), ["rank-high", "rank-low", "small-high"]);

  const rankedByEffort = [
    group({
      model: "rank-1",
      modelProvider: "provider-A",
      reasoningEffort: "high",
      tps: { p10: 90, p50: 100, p90: 110, pooled: 100 },
    }),
    group({
      model: "rank-2",
      modelProvider: "provider-A",
      reasoningEffort: "low",
      tps: { p10: 80, p50: 90, p90: 100, pooled: 90 },
    }),
    group({
      model: "rank-3",
      modelProvider: "provider-A",
      reasoningEffort: "high",
      tps: { p10: 70, p50: 80, p90: 90, pooled: 80 },
    }),
  ];
  const rankedHtml = renderPerfListHtml(summary(rankedByEffort), { locale: "zh-CN" });
  assert.deepEqual(renderedModels(rankedHtml, rankedByEffort), ["rank-1", "rank-2", "rank-3"]);
  for (const [index, rank] of [1, 2, 3].entries()) {
    assert.match(rankedHtml, new RegExp(`data-perf-group-index="${index}"[^>]*aria-label="rank-${rank}, 排名 ${rank}`));
  }

  const selectedHtml = renderPerfListHtml(summary(providerGroups), {
    locale: "zh-CN",
    selectedGroupKey: providerGroups[1].groupKey,
  });
  assert.match(selectedHtml, /data-perf-group-index="1" aria-pressed="true"/);
});

test("zero-sample diagnostics explain missing output, duration, and source filtering", () => {
  const key = JSON.stringify([
    "zcode",
    "home-a",
    "zcode",
    "unknown",
    "",
    "no-timing-model",
    "provider",
    "",
    "request_e2e",
    "reported_output_unspecified",
  ]);
  const coverage = bucket({
    eligible: 4,
    positiveOutput: 3,
    timedPositiveOutput: 1,
    completeTimedPositiveOutput: 1,
    sampled: 0,
    dropped: 3,
    timingRate: 1 / 3,
    completeTimingRate: 1 / 3,
    sampleRate: 0,
    byGroup: {
      [key]: bucket({
        eligible: 4,
        positiveOutput: 3,
        timedPositiveOutput: 1,
        completeTimedPositiveOutput: 1,
        sampled: 0,
        dropped: 3,
        byFlag: { SOURCE_FILTERED: 1 },
        droppedByReason: {
          output_missing_zero_invalid: 1,
          duration_missing_nonpositive_invalid: 1,
          source_filtered: 1,
        },
        timingRate: 1 / 3,
        completeTimingRate: 1 / 3,
        sampleRate: 0,
      }),
    },
  });
  const perf = summary([], coverage, { state: "ready" });
  const html = renderPerfListHtml(perf, { locale: "zh-CN" });
  assert.match(html, /no-timing-model/);
  assert.match(html, /适用候选 4/);
  assert.match(html, /缺少输出\/输出无效/);
  assert.match(html, /缺少时长\/时长无效/);
  assert.match(html, /源过滤/);
  assert.match(html, /代理未知/);
  assert.doesNotMatch(html, /0\.0 tok\/s/);
});

test("coverage preserves null rates, reports Codex era splits, and never sums overlapping flags", () => {
  const perf = summary(
    [],
    bucket({
      eligible: 0,
      timingRate: null,
      completeTimingRate: null,
      sampleRate: null,
      droppedByReason: { output_missing_zero_invalid: 0 },
      byFlag: { SOURCE_FILTERED: 2, METHOD_ESTIMATE: 1 },
      bySource: {
        codex: bucket({ byEra: { recent: bucket({ sampleRate: 0.5 }), legacy: bucket({ sampleRate: null }) } }),
      },
    }),
  );
  const html = renderPerfCoverageHtml(perf, { locale: "zh-CN" });
  const englishHtml = renderPerfCoverageHtml(perf, { locale: "en-US" });
  assert.match(html, /有跨度率[\s\S]*?—/);
  assert.match(html, /Codex · 近期/);
  assert.match(html, /Codex · 历史/);
  assert.match(englishHtml, /Codex · Recent/);
  assert.match(englishHtml, /Codex · History/);
  assert.doesNotMatch(englishHtml, /Codex · 近期|Codex · 历史/);
  assert.match(html, /诊断标记可能相互重叠/);
  assert.match(html, /SOURCE_FILTERED: 2/);
});

test("unplaced coverage identifies its all-history scope without changing the current denominator", () => {
  const perf = summary(
    [],
    bucket({ eligible: 0, sampled: 0, unplaced: 17, timingRate: null, completeTimingRate: null, sampleRate: null }),
  );
  perf.unsupportedSources = [{ kind: "unsupported", homeId: "unknown-home" }];
  const english = renderPerfCoverageHtml(perf, { locale: "en-US" });
  const chinese = renderPerfCoverageHtml(perf, { locale: "zh-CN" });

  assert.match(english, /Unknown source/);
  assert.doesNotMatch(english, /未知来源/);
  assert.match(english, /Unplaced in time[\s\S]*?17/);
  assert.match(
    english,
    /all history for the selected sources[\s\S]*?excluded from the eligible-record denominator for the current range/i,
  );
  assert.match(chinese, /时间未定位统计所选来源的全历史记录，不计入当前范围的适用候选分母。/);
  assert.equal(perf.coverage.eligible, 0, "unplaced records do not enter current-range eligible counts");
  assert.equal(perf.coverage.unplaced, 17);
});

test("Codex estimate details distinguish timing and percentile direction", () => {
  const estimate = group({
    sourceKind: "codex",
    homeId: "codex-home",
    channel: "codex-main",
    agentKind: "main",
    agent: "",
    model: "gpt-estimated",
    timingKind: "item_span_estimate",
    tokenScope: "reported_output_includes_reasoning",
  });
  const html = renderPerfDetailHtml(estimate, { byGroup: { [estimate.groupKey]: bucket() } }, { locale: "zh-CN" });
  assert.match(html, /轮级 item 时窗 TPS 估算/);
  assert.match(html, /p10（慢端）/);
  assert.match(html, /p90（快端）/);
  assert.match(html, /合并样本 TPS 不代表日历时间整体效率/);
  assert.match(html, /tok\/s/);
});

test("degraded, unsupported, long, and hostile source labels remain visible and escaped", () => {
  const hostile = group({
    model: `<img src=x onerror="alert(1)">${"long-model-".repeat(25)}`,
    modelProvider: "provider <script>alert(1)</script>",
    agent: "worker & <img src=x>",
  });
  const perf = summary([hostile], bucket(), {
    state: "degraded",
    sourceWarnings: [{ sourceKind: "dsh", homeId: "home-a", code: "LIVE_SOURCE_CHANGED", count: 1 }],
  });
  perf.state = "degraded";
  perf.degradedHomeIds = ["home-a"];
  perf.unsupportedSources = [{ kind: "unsupported", homeId: "home-a" }];
  const list = renderPerfListHtml(perf, { locale: "zh-CN", homeLabels: { "home-a": "<b>unsafe</b>" } });
  const coverage = renderPerfCoverageHtml(perf, { locale: "zh-CN", homeLabels: { "home-a": "<b>unsafe</b>" } });
  assert.doesNotMatch(list + coverage, /<img|<script|<b>/);
  assert.match(list, /&lt;img/);
  assert.match(list, /&lt;script&gt;/);
  assert.match(coverage, /部分数据来源不可用/);
  assert.match(coverage, /不支持来源/);
  assert.match(coverage, /LIVE_SOURCE_CHANGED/);
  assert.ok(list.length > 600, "a long model label is retained in escaped markup and title");
});

test("every fixed performance label has an explicit English copy entry", () => {
  const english = new Map(englishCopyEntries());
  const labels = [
    "查看方式",
    "选择一组模型查看详情。",
    "统计更新中，当前不展示部分排名。",
    "部分数据来源不可用，当前结果可能不完整。",
    "存在适用候选，但当前没有可计算的 TPS 样本。",
    "当前范围没有可评估的性能样本。",
    "用量摘要暂不可用。",
    "有不支持性能统计的来源，未纳入 TPS 样本。",
    "未形成 TPS 的候选",
    "覆盖情况",
    "覆盖明细与诊断",
    "存在来源告警，展开覆盖明细可查看。",
    "有跨度率",
    "完整跨度率",
    "有效样本率",
    "适用候选",
    "有效输出",
    "已计时输出",
    "完整计时输出",
    "已采样",
    "丢弃",
    "等待中",
    "时间未定位",
    "时间未定位统计所选来源的全历史记录，不计入当前范围的适用候选分母。",
    "缺少输出/输出无效",
    "缺少时长/时长无效",
    "源过滤",
    "诊断标记可能相互重叠，不要把它们相加为丢弃数。",
    "诊断标记",
    "丢弃原因",
    "不支持来源",
    "来源告警",
    "未归类来源",
    "渠道未知",
    "未知来源",
    "未提供",
    "主代理",
    "子代理",
    "代理未知",
    "模型未知",
    "计时方式未知",
    "Token 范围未知",
    "报告的输出 tokens（范围未注明）",
    "可见输出与推理 tokens",
    "报告的输出 tokens（含推理）",
    "请求端到端 TPS（含请求等待）",
    "轮级 item 时窗 TPS 估算",
    "样本不足",
    "聚合溢出",
    "排名",
    "推理强度",
    "提供方",
    "p10（慢端）",
    "p90（快端）",
    "合并样本 TPS",
    "耗时 p50",
    "耗时 p90",
    "来源",
    "来源目录",
    "渠道名称",
    "代理",
    "模型名称",
    "Token 范围",
    "计时口径",
    "样本数 n",
    "此组覆盖诊断",
    "此组没有覆盖诊断。",
    "p10 表示较慢端，p90 表示较快端；合并样本 TPS 不代表日历时间整体效率。",
    "记录冲突",
    "模型不明确",
    "终态未验证",
    "轮级时窗不完整",
    "轮级时窗重叠",
    "来源计时语义不匹配",
  ];
  for (const label of labels) assert.ok(english.has(label), `missing English translation for ${label}`);
});
