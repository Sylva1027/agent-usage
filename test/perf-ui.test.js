import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { englishCopyEntries } from "../public/i18n.js";
import {
  formatPerfDuration,
  formatPerfNumber,
  formatPerfRate,
  formatPerfTps,
  layoutPerfModelBands,
  renderPerfCoverageHtml,
  renderPerfDetailHtml,
  renderPerfListHtml,
  renderPerfModelDetailHtml,
  renderPerfModelTableHtml,
  renderPerfModelsHtml,
  sourceLabel,
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
  const englishDetailsStart = english.indexOf('<details class="perf-coverage-more">');
  assert.ok(englishDetailsStart >= 0);
  assert.doesNotMatch(english.slice(0, englishDetailsStart), /all history for the selected sources/i);
  assert.match(
    english.slice(englishDetailsStart),
    /all history for the selected sources[\s\S]*?excluded from the eligible-record denominator for the current range/i,
  );
  const chineseDetailsStart = chinese.indexOf('<details class="perf-coverage-more">');
  assert.ok(chineseDetailsStart >= 0);
  assert.doesNotMatch(chinese.slice(0, chineseDetailsStart), /时间未定位统计所选来源的全历史记录/);
  assert.match(
    chinese.slice(chineseDetailsStart),
    /时间未定位统计所选来源的全历史记录，不计入当前范围的适用候选分母。/,
  );
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

test("missing sources show a preserved-history status without changing ready state", () => {
  const perf = summary();
  perf.missingSources = [{ homeId: "private-home", sourcePath: "C:\\private\\usage.jsonl" }];
  const chinese = renderPerfCoverageHtml(perf, { locale: "zh-CN" });
  const english = renderPerfCoverageHtml(perf, { locale: "en-US" });
  assert.match(chinese, /<p class="perf-notice status" role="status">部分来源已缺失，已保留历史数据。<\/p>/);
  assert.match(english, /Some sources are missing\. Historical data is preserved\./);
  assert.equal(perf.state, "ready");
  assert.equal(perf.meta.state, "ready");
  assert.doesNotMatch(chinese + english, /private-home|private\\usage|部分数据来源不可用/);

  perf.missingSources = [];
  assert.doesNotMatch(renderPerfCoverageHtml(perf, { locale: "zh-CN" }), /保留历史数据/);
  delete perf.missingSources;
  assert.doesNotMatch(renderPerfCoverageHtml(perf, { locale: "zh-CN" }), /保留历史数据/);
});

test("every fixed performance label has an explicit English copy entry", () => {
  const english = new Map(englishCopyEntries());
  const labels = [
    "查看方式",
    "选择一组模型查看详情。",
    "部分来源已缺失，已保留历史数据。",
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
    "参考行",
    "计量条件未验证",
    "排名信息不可用",
    "满足当前计量条件",
    "满足当前计量条件的历史样本排序；分隔线以下为参考读数。",
    "样本数不可用",
    "请求",
    "步骤",
    "消息",
    "轮次",
    "混合样本",
    "样本",
    "p90 是第 90 百分位，不是最快 10% 的平均值，也不是速度上限。",
    "Codex 计时覆盖",
    "候选采样覆盖率",
    "已记录输出覆盖率",
    "没有适用的 Codex 来源。",
    "此响应未提供 Codex 计时覆盖信息。",
    "本范围没有 Codex 候选。",
    "Codex 计时覆盖信息不可用。",
    "性能索引正在重建，覆盖信息不可用。",
    "性能索引尚未初始化，覆盖信息不可用。",
    "性能索引尚未初始化，当前没有可展示的模型速度。",
    "部分来源降级，覆盖保留已发布的健康数据。",
    "输出 token 合计溢出，已记录输出比例不可用。",
    "输出 token 汇总字段缺失或无效，已记录输出比例不可用。",
    "已记录输出覆盖率只统计已知输出。",
    "缺失或无效时长",
    "进行中",
    "另有输出 token 未知的候选",
    "全历史、无法定位日期的记录",
    "不计入当前范围分母",
    "推理强度",
    "提供方",
    "provider 未知",
    "provider 信息不可用",
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

const MODEL_SAMPLE_START = Date.parse("2026-10-04T10:00:00Z");
const MODEL_SAMPLE_END = Date.parse("2026-10-04T11:00:00Z");

function model(overrides = {}) {
  const value = {
    sourceKind: "codex",
    model: "gpt-6.1-sol",
    reasoningEffort: "high",
    window: "turn",
    firstSampleAtMs: MODEL_SAMPLE_START,
    lastSampleAtMs: MODEL_SAMPLE_END,
    averageTps: 81.6,
    p10: 58.2,
    p90: 96.4,
    n: 207,
    state: "ok",
    rankState: "eligible",
    rank: 1,
    ...overrides,
  };
  const key = [value.sourceKind, value.model, value.reasoningEffort];
  if (Object.hasOwn(value, "modelProvider")) key.push(value.modelProvider);
  return {
    key: JSON.stringify(key),
    ...value,
  };
}

function timingCoverage(overrides = {}) {
  return {
    methodVersion: "tps-v2",
    counts: { eligible: 3, sampled: 1, sampleRate: 1 / 3, unplaced: 0 },
    recordedOutputTokens: 4500,
    sampledOutputTokens: 1000,
    unknownOutputCandidates: 0,
    ...overrides,
  };
}

function legacyModel(overrides = {}) {
  const row = model(overrides);
  delete row.rankState;
  return row;
}

function modelRowHtml(html, index) {
  const marker = html.indexOf(`data-perf-model-index="${index}"`);
  const start = html.lastIndexOf("<tr", marker);
  const next = html.indexOf("<tr", marker + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

function visibleText(html) {
  return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
}

test("Codex with usage but no request duration stays selectable and explains the missing speed once", () => {
  const row = model({
    state: "missing_duration",
    averageTps: null,
    p10: null,
    p90: null,
    n: 0,
    candidateCount: 407,
    firstCandidateAtMs: MODEL_SAMPLE_START,
    lastCandidateAtMs: MODEL_SAMPLE_END,
  });
  for (const locale of ["zh-CN", "en-US"]) {
    const html = renderPerfModelsHtml({ models: [row] }, { locale });
    const table = renderPerfModelTableHtml([row], { locale });
    assert.match(table, /Codex/);
    assert.match(table, /data-perf-model-key=/);
    assert.doesNotMatch(table, /mini-fill|\bn=|407/);
    assert.match(html, /407/);
    assert.doesNotMatch(html, /perf-model-timing-missing|Request duration is missing from the log|日志未记录请求耗时/);
    assert.doesNotMatch(html, /perf-model-band|0\.0|0 个轮次|0 turns/);
  }
});

test("model list uses the comparison rail with three plain headers and no ranking or row sample count", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const rows = [
      model({ n: 151 }),
      legacyModel({ model: "legacy", n: 9 }),
      model({ model: "small", rankState: "insufficient_samples", n: 1 }),
    ];
    const html = renderPerfModelTableHtml(rows, { locale, selectedKey: rows[2].key });
    assert.equal((html.match(/<th scope="col">/g) || []).length, 3);
    assert.match(html, /class="comparison-table-frame"/);
    assert.match(html, /class="comparison-table-scroll perf-model-table-scroll"/);
    assert.match(html, /class="comparison-table perf-model-table perf-model-data-table"/);
    assert.doesNotMatch(html, /perf-model-rank|rankState|is-reference|\bn=|▼|Reasoning Effort|推理强度|排名|参考行/);
    assert.match(html, /aria-pressed="true"/);
    assert.equal((html.match(/data-perf-model-index=/g) || []).length, 3);
    assert.match(html, locale === "en-US" ? /<th scope="col">Models<\/th>/ : /<th scope="col">模型<\/th>/);
  }
});

test("model table handles 0, 1, 5, 6, and 11 rows without dropping the scroll region", () => {
  for (const count of [0, 1, 5, 6, 11]) {
    const rows = Array.from({ length: count }, (_, index) =>
      model({
        model: `model-${index}`,
        averageTps: 100 - index,
        rank: index + 1,
      }),
    );
    const html = renderPerfModelTableHtml(rows, { locale: "zh-CN" });
    assert.equal((html.match(/class="perf-model-data-row/g) || []).length, count);
    if (count === 0) {
      assert.match(html, /当前范围没有可评估的性能样本/);
    } else {
      assert.match(html, /class="comparison-table-scroll perf-model-table-scroll"/);
    }
  }
});

test("model rows escape hostile model, effort, key, and long labels while preserving full title text", () => {
  const hostile = model({
    model: `<img src=x onerror="alert(1)">${"long-model-".repeat(20)}`,
    reasoningEffort: `max"><script>alert(1)</script>`,
    sourceKind: `codex"><img src=x>`,
  });
  const html = renderPerfModelTableHtml([hostile], { locale: "zh-CN" });
  const detail = renderPerfModelDetailHtml(hostile, { locale: "zh-CN" });
  assert.doesNotMatch(html + detail, /<img|<script/);
  assert.match(html, /&lt;img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /title="[^"]*&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(detail, /class="perf-model-detail-title" title="[^"]*long-model-[^"]*"/);
});

test("model identities group source and provider above model and optional effort without separator dots", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const row = model({ sourceKind: "workbuddy", reasoningEffort: "" });
    const table = renderPerfModelTableHtml([row], { locale });
    const detail = renderPerfModelDetailHtml(row, { locale });
    assert.doesNotMatch(table, /class="perf-model-effort"| · —/);
    assert.doesNotMatch(detail, /class="perf-model-title-effort"| · —/);
    assert.doesNotMatch(detail, /class="perf-model-separator"/);
    assert.match(
      detail,
      /class="perf-model-identity-context"><span class="perf-model-source-name">WorkBuddy<\/span><span class="perf-model-sample-count">[^<]+<\/span><\/div><div class="perf-model-identity-model">/,
    );
    assert.match(
      table,
      /<td class="perf-model-source" title="WorkBuddy"><span class="perf-model-source-kind">WorkBuddy<\/span><\/td>/,
    );
    const withEffort = renderPerfModelDetailHtml(model({ reasoningEffort: "max" }), { locale });
    assert.match(
      withEffort,
      /class="perf-model-identity-model"><span class="perf-model-title-name">[^<]+<\/span><span class="perf-model-title-effort">max<\/span><\/div>/,
    );
  }
});

test("same-named models remain distinct by provider in source cells, detail, and accessible names", () => {
  const alpha = model({ model: "identical-model", modelProvider: "provider-alpha" });
  const beta = model({ model: "identical-model", modelProvider: "provider-beta" });
  const table = renderPerfModelTableHtml([alpha, beta], { locale: "zh-CN" });
  const alphaDetail = renderPerfModelDetailHtml(alpha, { locale: "zh-CN" });

  assert.match(
    table,
    /title="Codex · provider-alpha"><span class="perf-model-source-kind">Codex<\/span><span class="perf-model-source-provider">provider-alpha<\/span>/,
  );
  assert.match(
    table,
    /title="Codex · provider-beta"><span class="perf-model-source-kind">Codex<\/span><span class="perf-model-source-provider">provider-beta<\/span>/,
  );
  assert.match(table, /aria-label="Codex · provider-alpha · identical-model · high,/);
  assert.match(table, /aria-label="Codex · provider-beta · identical-model · high,/);
  assert.match(alphaDetail, /aria-label="Codex · provider-alpha · identical-model · high"/);
  assert.match(alphaDetail, /<span class="perf-model-provider-name" title="provider-alpha">provider-alpha<\/span>/);
});

test("missing providers are omitted while known identities remain escaped and readable", () => {
  const empty = model({ modelProvider: "" });
  const missing = model();
  const hostileProvider = `provider <script>alert(1)</script> ${"long-provider-".repeat(20)}`;
  const hostile = model({ modelProvider: hostileProvider });

  const chinese = renderPerfModelTableHtml([empty, missing, hostile], { locale: "zh-CN" });
  const english = renderPerfModelTableHtml([empty, missing], { locale: "en-US" });
  const missingDetail = renderPerfModelDetailHtml(missing, { locale: "zh-CN" });
  const hostileDetail = renderPerfModelDetailHtml(hostile, { locale: "zh-CN" });
  assert.equal((chinese.match(/class="perf-model-source-provider"/g) || []).length, 1);
  assert.doesNotMatch(english, /perf-model-source-provider|Provider unknown|Provider information unavailable/);
  assert.match(missingDetail, /aria-label="Codex · gpt-6\.1-sol · high"/);
  assert.doesNotMatch(missingDetail, /perf-model-provider-name|provider 信息不可用|provider 未知/);
  assert.doesNotMatch(chinese, /<script>/);
  assert.match(chinese, /provider &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(chinese, /title="Codex · provider &lt;script&gt;alert\(1\)&lt;\/script&gt; long-provider-/);
  assert.doesNotMatch(hostileDetail, /<script>/);
  assert.match(hostileDetail, /class="perf-model-provider-name" title="provider &lt;script&gt;/);
  assert.doesNotMatch(chinese, /官方直连|official direct/i);
});

test("model overflow rows have no rank, speed, or bar and detail has no stale band", () => {
  const overflow = model({
    averageTps: null,
    p10: null,
    p90: null,
    state: "overflow",
    rankState: "overflow",
    rank: null,
  });
  const html = renderPerfModelTableHtml([model(), overflow], { locale: "zh-CN" });
  const overflowRow = modelRowHtml(html, 1);
  assert.doesNotMatch(overflowRow, /perf-model-rank/);
  assert.doesNotMatch(overflowRow, /perf-model-row-note|\bn=/);

  assert.match(overflowRow, /<span><\/span><span class="perf-model-speed-value">—<\/span>/);
  assert.doesNotMatch(overflowRow, /perf-model-mini-fill/);
  const detail = renderPerfModelDetailHtml(overflow, { locale: "zh-CN" });
  assert.match(detail, /聚合溢出/);
  assert.doesNotMatch(detail, /perf-model-band|tok\/s/);
});

test("small sample rows retain speed and detail count without ranking labels", () => {
  const row = model({ n: 2, rankState: "insufficient_samples" });
  const html = renderPerfModelTableHtml([row]);
  assert.match(html, /81.6/);
  assert.doesNotMatch(html, /样本不足|排名|参考行|\bn=/);
  assert.match(renderPerfModelDetailHtml(row), /2 个轮次/);
});

test("model list preserves supplied row order without ranking segments", () => {
  const rows = [
    model({ model: "first", averageTps: 10 }),
    model({ model: "second", averageTps: 100, rankState: "unverified" }),
  ];
  const html = renderPerfModelTableHtml(rows);
  assert.ok(html.indexOf("first") < html.indexOf("second"));
  assert.doesNotMatch(html, /perf-model-rank|is-reference/);
});

test("old rank fields have no effect on model list markup", () => {
  const row = legacyModel({ rank: 99 });
  assert.equal(renderPerfModelTableHtml([row]), renderPerfModelTableHtml([{ ...row, rank: null }]));
});

test("model detail omits sample and candidate dates in every state and locale", () => {
  for (const state of ["ok", "missing_duration", "overflow"]) {
    const row = model({
      state,
      candidateCount: 407,
      firstSampleAtMs: Date.parse("2026-10-04T15:30:00Z"),
      lastSampleAtMs: Date.parse("2026-10-04T16:50:00Z"),
      firstCandidateAtMs: Date.parse("2026-10-04T15:30:00Z"),
      lastCandidateAtMs: Date.parse("2026-10-04T16:50:00Z"),
    });
    for (const locale of ["zh-CN", "en-US"]) {
      const html = renderPerfModelsHtml({ models: [row] }, { locale });
      assert.doesNotMatch(html, /样本日期|Sample date|2026-10-0[45]|<br>/);
      assert.match(html, /perf-model-identity-context">.*?perf-model-sample-count/s);
      assert.doesNotMatch(html, /perf-model-hero">.*?perf-model-sample-count/s);
    }
  }
});

test("model detail names each sample window and never calls Codex turns requests", () => {
  const cases = [
    ["request", 6, "6 个请求", "6 requests"],
    ["step", 6, "6 个步骤", "6 steps"],
    ["message", 6, "6 条消息", "6 messages"],
    ["turn", 6, "6 个轮次", "6 turns"],
    ["mixed", 6, "6 个混合样本", "6 mixed samples"],
  ];
  for (const [window, n, chinese, english] of cases) {
    const row = model({ window, n });
    assert.match(renderPerfModelDetailHtml(row, { locale: "zh-CN" }), new RegExp(chinese));
    assert.match(renderPerfModelDetailHtml(row, { locale: "en-US" }), new RegExp(english));
  }
  const codex = renderPerfModelDetailHtml(model({ window: "turn", n: 6 }), { locale: "zh-CN" });
  assert.doesNotMatch(codex, /6 个请求|326 个请求/);
});

test("model band keeps a mean outside p10-p90 outside the distribution and handles n=1", () => {
  const outside = model({
    averageTps: (2000 * 1000) / 119000,
    p10: 100,
    p90: 100,
    n: 20,
  });
  const html = renderPerfModelDetailHtml(outside, { locale: "zh-CN" });
  assert.match(html, /perf-model-band-fill" style="left: 83\.33%; width: 0\.00%"/);
  assert.match(html, /perf-model-tick is-up" style="left: 16\.67%"/);
  assert.match(html, /perf-model-tick-value">100\.0<\/span><span class="perf-model-tick-name">10% \/ 90%/);
  assert.match(html, /常见速度区间 100\.0–100\.0 tok\/s/);
  assert.match(html, /p90 是第 90 百分位，不是最快 10% 的平均值，也不是速度上限。/);
  assert.doesNotMatch(html, /80%|请求/);

  const one = model({ averageTps: 100, p10: 100, p90: 100, n: 1 });
  const oneHtml = renderPerfModelDetailHtml(one, { locale: "zh-CN" });
  assert.match(oneHtml, /1 个轮次/);
  assert.match(oneHtml, /perf-model-tick-value">100\.0<\/span><span class="perf-model-tick-name">10% \/ 90%/);
});

test("narrow and equal model bands keep exact ticks while centering a visible fill", () => {
  const narrow = model({ averageTps: 183.5, p10: 183.3, p90: 183.8, n: 2 });
  const html = renderPerfModelDetailHtml(narrow, { locale: "zh-CN" });
  assert.match(html, /perf-model-tick is-down" style="left: 16\.67%"/);
  assert.match(html, /perf-model-tick is-down" style="left: 83\.33%"/);
  assert.match(html, /perf-model-tick is-up" style="left: 43\.33%"/);
  assert.match(html, /perf-model-band-fill" style="left: 50\.00%; width: 66\.67%"/);

  const equal = model({ averageTps: 100, p10: 100, p90: 100, n: 1 });
  const equalHtml = renderPerfModelDetailHtml(equal, { locale: "zh-CN" });
  assert.match(equalHtml, /perf-model-band-fill" style="left: 50\.00%; width: 0\.00%"/);

  const zero = model({ averageTps: 0, p10: 0, p90: 0, n: 1 });
  const zeroHtml = renderPerfModelDetailHtml(zero, { locale: "zh-CN" });
  assert.match(zeroHtml, /perf-model-band-fill" style="left: 50\.00%; width: 0\.00%"/);

  const tiny = model({ averageTps: 1.5e-300, p10: 1e-300, p90: 2e-300, n: 2 });
  const tinyHtml = renderPerfModelDetailHtml(tiny, { locale: "zh-CN" });
  assert.match(tinyHtml, /perf-model-tick is-down" style="left: 16\.67%"/);
  assert.match(tinyHtml, /perf-model-tick is-down" style="left: 83\.33%"/);
  assert.match(tinyHtml, /perf-model-tick is-up" style="left: 50\.00%"/);
  assert.doesNotMatch(tinyHtml, /NaN|Infinity/);

  const reversed = model({ averageTps: 15, p10: 20, p90: 10, n: 2 });
  assert.doesNotMatch(renderPerfModelDetailHtml(reversed, { locale: "zh-CN" }), /perf-model-band/);

  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.perf-model-band-fill \{[\s\S]*?min-width: 4px;[\s\S]*?transform: translateX\(-50%\);/);
});

test("model band leaves endpoint labels in geometric position and provides a measured fallback row", () => {
  const close = model({ averageTps: 59.1, p10: 58.2, p90: 60, n: 17 });
  const closeHtml = renderPerfModelDetailHtml(close, { locale: "zh-CN" });
  assert.match(closeHtml, /perf-model-close-endpoints" hidden/);
  assert.match(closeHtml, /perf-model-tick is-down" style="left: 16\.67%"/);
  assert.match(closeHtml, /perf-model-tick is-down" style="left: 83\.33%"/);

  const low = model({ averageTps: 10, p10: 20, p90: 80, n: 20 });
  const lowHtml = renderPerfModelDetailHtml(low, { locale: "zh-CN" });
  assert.match(lowHtml, /perf-model-tick is-up" style="left: 16\.67%"/);
  assert.match(lowHtml, /perf-model-tick is-down" style="left: 26\.19%"/);

  const high = model({ averageTps: 110, p10: 10, p90: 20, n: 20 });
  const highHtml = renderPerfModelDetailHtml(high, { locale: "zh-CN" });
  assert.match(highHtml, /perf-model-tick is-up" style="left: 83\.33%"/);
  assert.match(highHtml, /perf-model-tick is-down" style="left: 16\.67%"/);
  assert.match(highHtml, /perf-model-tick is-down" style="left: 23\.33%"/);
});

test("model band measures label boxes and collapses colliding endpoints", () => {
  const classList = () => {
    const values = new Set();
    return {
      add: (...names) =>
        names.forEach((name) => {
          values.add(name);
        }),
      remove: (...names) =>
        names.forEach((name) => {
          values.delete(name);
        }),
      toggle: (name, force) => (force ? values.add(name) : values.delete(name)),
      contains: (name) => values.has(name),
    };
  };
  const rect = (left, right) => ({ left, right, width: right - left });
  const plotRect = rect(0, 270);
  const makeTick = (_kind, center, width) => {
    const classes = classList();
    const label = {
      getBoundingClientRect() {
        if (classes.contains("edge-right")) return rect(center - width, center);
        if (classes.contains("edge-left")) return rect(center, center + width);
        return rect(center - width / 2, center + width / 2);
      },
    };
    return {
      classList: classes,
      querySelector: (selector) => (selector === "[data-perf-tick-label]" ? label : null),
    };
  };
  const average = makeTick("up", 205, 60);
  const slow = makeTick("down", 176, 60);
  const fast = makeTick("down", 235, 70);
  const fallback = { hidden: true, classList: classList() };
  const plotClasses = classList();
  const plot = {
    classList: plotClasses,
    getBoundingClientRect: () => plotRect,
    querySelectorAll: (selector) =>
      selector === ".perf-model-tick"
        ? [average, slow, fast]
        : selector === ".perf-model-tick.is-down"
          ? [slow, fast]
          : [],
    querySelector: (selector) => (selector === ".perf-model-close-endpoints" ? fallback : null),
  };

  layoutPerfModelBands({ querySelectorAll: () => [plot] });
  assert.equal(fast.classList.contains("edge-right"), true);
  assert.equal(plotClasses.contains("is-crowded"), true);
  assert.equal(fallback.hidden, false);
});

test("model band restores natural endpoint labels before remeasuring a crowded plot", () => {
  const oldResizeObserver = globalThis.ResizeObserver;
  delete globalThis.ResizeObserver;
  const classes = new Set(["is-crowded"]);
  const toggles = [];
  let measurements = 0;
  const label = (left, right) => ({
    getBoundingClientRect() {
      assert.equal(classes.has("is-crowded"), false);
      measurements += 1;
      return { left, right, width: right - left };
    },
  });
  const tick = (_kind, box) => ({
    classList: { add() {}, remove() {} },
    querySelector: (selector) =>
      selector === "[data-perf-tick-label]" || selector === ".perf-model-tick-label" ? box : null,
  });
  const average = tick("up", label(145, 205));
  const slow = tick("down", label(80, 100));
  const fast = tick("down", label(230, 260));
  const fallback = { hidden: false };
  const plot = {
    classList: {
      remove(name) {
        classes.delete(name);
      },
      toggle(name, force) {
        toggles.push(force);
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    getBoundingClientRect: () => ({ left: 0, right: 270 }),
    querySelectorAll: (selector) =>
      selector === ".perf-model-tick"
        ? [average, slow, fast]
        : selector === ".perf-model-tick.is-down"
          ? [slow, fast]
          : [],
    querySelector: (selector) => (selector === ".perf-model-close-endpoints" ? fallback : null),
  };
  try {
    layoutPerfModelBands({ querySelectorAll: () => [plot] });
    assert.equal(measurements, 5);
    assert.deepEqual(toggles, [false]);
    assert.equal(classes.has("is-crowded"), false);
    assert.equal(fallback.hidden, true);
  } finally {
    if (oldResizeObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = oldResizeObserver;
  }
});

test("model band layout disconnects removed plots instead of retaining them", () => {
  const oldResizeObserver = globalThis.ResizeObserver;
  const active = new Set();
  class FakeResizeObserver {
    observe(plot) {
      active.add(plot);
    }
    disconnect() {
      active.clear();
    }
  }
  globalThis.ResizeObserver = FakeResizeObserver;
  const classList = () => ({ add() {}, remove() {}, toggle() {} });
  const plot = (name) => ({
    name,
    classList: classList(),
    querySelectorAll: () => [],
    querySelector: () => null,
  });
  const first = plot("first");
  const second = plot("second");
  try {
    layoutPerfModelBands({ querySelectorAll: () => [first] });
    assert.deepEqual([...active], [first]);
    layoutPerfModelBands({ querySelectorAll: () => [second] });
    assert.deepEqual([...active], [second]);
  } finally {
    layoutPerfModelBands({ querySelectorAll: () => [] });
    if (oldResizeObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = oldResizeObserver;
  }
});

test("model speed copy is complete in English and keeps the selected key", () => {
  const rows = [model(), model({ sourceKind: "dsh", model: "gpt-6-astra", reasoningEffort: "", rank: 2 })];
  const html = renderPerfModelsHtml({ models: rows }, { locale: "en-US", selectedKey: rows[1].key });
  assert.match(html, /<th scope="col">Models<\/th>/);
  assert.match(html, /Average Speed \(tok\/s\)/);
  assert.match(html, /207 turns/);
  assert.match(html, /Common speed range 58\.2–96\.4 tok\/s/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /data-perf-model-key="\[&quot;dsh&quot;,&quot;gpt-6-astra&quot;,&quot;&quot;\]"/);
});

test("percentile endpoints use only percentages in both languages and only mean has a marker", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const html = renderPerfModelDetailHtml(model(), { locale });
    assert.match(html, /perf-model-tick-name">10%/);
    assert.match(html, /perf-model-tick-name">90%/);
    assert.doesNotMatch(visibleText(html), /慢端|快端|Slow end|Fast end/);
  }
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.perf-model-tick::before/);
  assert.match(css, /\.perf-model-tick\.is-up::before/);
});

test("model speed CSS reserves five rows, keeps native focus, and disables gradient fills", () => {
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(
    css,
    /\.perf-model-table-scroll \{[\s\S]*?height: calc\(5 \* var\(--perf-row-height\) \+ var\(--perf-head-height\)\);[\s\S]*?overflow-y: auto;[\s\S]*?scrollbar-gutter: stable;/,
  );
  assert.match(css, /\.perf-model-mini-fill \{[\s\S]*?display: block;[\s\S]*?background-image: none;/);
  assert.match(css, /\.perf-model-band-fill \{[\s\S]*?background-image: none;/);
  assert.match(css, /\.perf-model-speed-cell \{[\s\S]*?display: grid;/);
  assert.doesNotMatch(css, /\.perf-model-speed \{[\s\S]*?display: grid;/);
  assert.match(css, /\.perf-model-detail-panel \{[\s\S]*?min-height: 0;[\s\S]*?overflow: hidden;/);
  assert.match(css, /\.perf-model-source-name \{[\s\S]*?flex: none;/);
  assert.match(
    css,
    /\.perf-model-title-name \{[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/,
  );
  assert.match(
    css,
    /\.perf-model-source-kind,[\s\S]*?\.perf-model-source-provider \{[\s\S]*?display: block;[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/,
  );
  assert.match(
    css,
    /\.perf-model-provider-name \{[\s\S]*?overflow: hidden;[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;/,
  );

  assert.match(css, /\.perf-model-row-action:focus-visible \{[\s\S]*?outline: 2px solid var\(--blue\);/);
  assert.match(css, /\.perf-model-table-scroll:focus-visible \{/);
});

test("Codex timing coverage adds no summary row to populated or empty model panels in either language", () => {
  const coverage = timingCoverage({
    counts: { eligible: 3, sampled: 1, sampleRate: 1 / 3, unplaced: 12 },
    unknownOutputCandidates: 2,
  });
  for (const locale of ["zh-CN", "en-US"]) {
    for (const models of [[model()], []]) {
      const html = renderPerfModelsHtml({ models, codexTimingCoverage: coverage }, { locale });
      assert.doesNotMatch(
        html,
        /perf-codex-coverage|Codex 计时覆盖|候选采样覆盖率|已记录输出覆盖率|Codex timing coverage|Candidate sampling coverage|Recorded-output coverage/,
      );
    }
  }
});

test("Codex coverage states stay silent in the model region", () => {
  const missingField = renderPerfModelsHtml({ models: [] }, { locale: "zh-CN" });
  assert.doesNotMatch(missingField, /perf-codex-coverage|未提供|不可用/);
  assert.doesNotMatch(missingField, /0%/);

  const noSource = renderPerfModelsHtml({ models: [], codexTimingCoverage: null }, { locale: "zh-CN" });
  assert.doesNotMatch(noSource, /perf-codex-coverage|没有适用的 Codex 来源/);
  assert.doesNotMatch(noSource, /0%/);

  const zeroCandidates = renderPerfModelsHtml(
    {
      models: [],
      codexTimingCoverage: timingCoverage({
        counts: { eligible: 0, sampled: 0, sampleRate: null, unplaced: 4 },
        recordedOutputTokens: 0,
        sampledOutputTokens: 0,
      }),
    },
    { locale: "zh-CN" },
  );
  assert.doesNotMatch(zeroCandidates, /perf-codex-coverage|本范围没有 Codex 候选|不可用/);
  assert.doesNotMatch(zeroCandidates, /0%/);

  const zeroSampled = renderPerfModelsHtml(
    {
      models: [],
      codexTimingCoverage: timingCoverage({
        counts: { eligible: 6, sampled: 0, sampleRate: 0, unplaced: 0 },
        recordedOutputTokens: 4500,
        sampledOutputTokens: 0,
      }),
    },
    { locale: "zh-CN" },
  );
  assert.doesNotMatch(zeroSampled, /perf-codex-coverage|候选采样覆盖率|已记录输出覆盖率/);

  const overflow = renderPerfModelsHtml(
    {
      models: [],
      codexTimingCoverage: timingCoverage({ recordedOutputTokens: null, sampledOutputTokens: null }),
    },
    { locale: "zh-CN" },
  );
  assert.doesNotMatch(overflow, /已记录输出覆盖率|输出 token 合计溢出|不可用/);

  const missingTokens = timingCoverage();
  delete missingTokens.recordedOutputTokens;
  delete missingTokens.sampledOutputTokens;
  assert.doesNotMatch(
    renderPerfModelsHtml({ models: [], codexTimingCoverage: missingTokens }, { locale: "zh-CN" }),
    /已记录输出覆盖率|输出 token 汇总字段缺失或无效/,
  );

  const oldCoverage = {
    models: [],
    coverage: { bySource: { codex: { eligible: 777, sampled: 600, sampleRate: 0.77 } } },
  };
  const oldHtml = renderPerfModelsHtml(oldCoverage, { locale: "zh-CN" });
  assert.doesNotMatch(oldHtml, /perf-codex-coverage|此响应未提供/);
  assert.doesNotMatch(oldHtml, /77%|777|600/);

  const rebuilding = renderPerfModelsHtml(
    { state: "rebuilding", models: [], codexTimingCoverage: timingCoverage() },
    { locale: "zh-CN" },
  );
  assert.doesNotMatch(rebuilding, /perf-codex-coverage|覆盖信息不可用/);
  assert.doesNotMatch(rebuilding, /33\.3%|22\.2%/);

  const uninitialized = renderPerfModelsHtml(
    { state: "uninitialized", models: [], codexTimingCoverage: timingCoverage() },
    { locale: "zh-CN" },
  );
  assert.doesNotMatch(uninitialized, /perf-codex-coverage|覆盖信息不可用/);
  assert.match(uninitialized, /性能索引尚未初始化，当前没有可展示的模型速度/);
  assert.doesNotMatch(uninitialized, /33\.3%|22\.2%/);

  const degraded = renderPerfModelsHtml(
    {
      state: "degraded",
      degradedHomeIds: ["codex-home"],
      models: [model()],
      codexTimingCoverage: timingCoverage(),
    },
    { locale: "zh-CN" },
  );
  assert.doesNotMatch(degraded, /perf-codex-coverage|候选采样覆盖率|已记录输出覆盖率/);
  assert.doesNotMatch(visibleText(degraded), /部分来源降级|已记录输出覆盖率/);
});

test("model panels show measurements without persistent disclaimers", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const row = legacyModel({ n: 151 });
    delete row.firstSampleAtMs;
    delete row.lastSampleAtMs;
    const html = renderPerfModelsHtml({ models: [row] }, { locale });
    const text = visibleText(html);
    assert.match(text, /81\.6/);
    assert.match(text, /151/);
    assert.doesNotMatch(
      text,
      /不可用|未提供|参考行|排名信息|provider|p90|unavailable|not include|Reference row|Provider|90th percentile/i,
    );
    assert.doesNotMatch(html, /perf-model-table-note|perfModelTableNote|perf-codex-coverage/);
    assert.match(
      html,
      /title="(?:常见速度区间|Common speed range)[^"]*(?:p90 是第 90 百分位|p90 is the 90th percentile)/,
    );
    assert.doesNotMatch(text, /常见速度区间|Common speed range/);
  }
});

test("Codex coverage diagnostics add no rows or counts to empty model panels", () => {
  const html = renderPerfModelsHtml(
    {
      models: [],
      codexTimingCoverage: timingCoverage({
        counts: {
          eligible: 6,
          sampled: 0,
          sampleRate: 0,
          pending: 2,
          unplaced: 0,
          droppedByReason: { duration_missing_nonpositive_invalid: 4 },
          byFlag: { duration_missing_nonpositive_invalid: 99 },
        },
        recordedOutputTokens: 4500,
        sampledOutputTokens: 0,
      }),
    },
    { locale: "zh-CN" },
  );
  assert.doesNotMatch(html, /perf-codex-coverage|缺失或无效时长|进行中/);
  assert.doesNotMatch(html, /99|perf-model-data-row|\bn=0/);
});

test("the formal page places model speed directly after timeline details and before period comparisons", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const timeline = html.indexOf('<section class="main-grid"');
  const timelineDetails = html.indexOf('id="detailPanel"');
  const periodComparison = html.indexOf('<section class="period-comparison-grid"');
  const modelSpeed = html.indexOf('id="perfModelsSection"');
  const scannedDirectories = html.indexOf('<section class="bottom-grid"');
  assert.ok(timeline >= 0);
  assert.ok(timeline < timelineDetails);
  assert.ok(timelineDetails < modelSpeed);
  assert.match(
    html.slice(html.indexOf("</section>", timelineDetails), modelSpeed),
    /^<\/section>\s*<\/section>\s*<section $/,
  );
  assert.ok(modelSpeed < periodComparison);
  assert.ok(periodComparison < scannedDirectories);
});

test("perf 来源标签包含 WorkBuddy，未知来源仍是兜底", () => {
  assert.equal(sourceLabel("workbuddy", "zh-CN"), "WorkBuddy");
  assert.equal(sourceLabel("workbuddy", "en-US"), "WorkBuddy");
  assert.equal(sourceLabel("claude", "zh-CN"), "Claude");
  assert.equal(sourceLabel("claude", "en-US"), "Claude");
  assert.equal(sourceLabel("codex", "zh-CN"), "Codex");
  assert.equal(sourceLabel("unsupported", "en-US"), "Unknown source");
});
