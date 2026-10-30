import { localizeText } from "./i18n.js";

const dash = "—";

// Constructing an Intl.NumberFormat is the dominant cost here while format() is stateless, so one
// instance per (options object, locale) pair is reused — the same reuse pattern i18n.js uses for
// Intl.DateTimeFormat. Callers must treat option objects as constants: the lookup is by identity.
const numberFormatters = new WeakMap();

function cachedNumberFormat(locale, options) {
  let byLocale = numberFormatters.get(options);
  if (!byLocale) {
    byLocale = new Map();
    numberFormatters.set(options, byLocale);
  }
  let formatter = byLocale.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, options);
    byLocale.set(locale, formatter);
  }
  return formatter;
}

const COUNT_OPTIONS = Object.freeze({ maximumFractionDigits: 0 });
const SINGLE_DECIMAL_OPTIONS = Object.freeze({ minimumFractionDigits: 1, maximumFractionDigits: 1 });
const PERCENT_OPTIONS = Object.freeze({ style: "percent", maximumFractionDigits: 1 });
const countOptionVariants = new WeakMap();

// formatPerfNumber layers callers' overrides on top of its integer default. Each distinct override
// object is merged with that default once and then reused as the cache key, so the overrides behave
// like the module-level constants above without changing which options are in effect.
function countOptions(overrides) {
  if (!overrides) return COUNT_OPTIONS;
  if (typeof overrides !== "object") return { ...COUNT_OPTIONS, ...overrides };
  let effective = countOptionVariants.get(overrides);
  if (!effective) {
    effective = Object.freeze({ ...COUNT_OPTIONS, ...overrides });
    countOptionVariants.set(overrides, effective);
  }
  return effective;
}

export function formatPerfNumber(value, locale = "zh-CN", options = null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return dash;
  return cachedNumberFormat(locale, countOptions(options)).format(value);
}

export function formatPerfTps(value, locale = "zh-CN") {
  if (typeof value !== "number" || !Number.isFinite(value)) return dash;
  return cachedNumberFormat(locale, SINGLE_DECIMAL_OPTIONS).format(value);
}

export function formatPerfDuration(value, locale = "zh-CN") {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return dash;
  if (value < 1000) return `${formatPerfNumber(value, locale)} ms`;
  return `${cachedNumberFormat(locale, SINGLE_DECIMAL_OPTIONS).format(value / 1000)} s`;
}

export function formatPerfRate(value, locale = "zh-CN") {
  if (typeof value !== "number" || !Number.isFinite(value)) return dash;
  return cachedNumberFormat(locale, PERCENT_OPTIONS).format(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function copy(value, locale) {
  return escapeHtml(localizeText(value, locale));
}

export function sourceLabel(kind, locale) {
  const labels = {
    codex: "Codex",
    zcode: "ZCode",
    dsh: "DSH",
    opencode: "OpenCode",
    workbuddy: "WorkBuddy",
    claude: "Claude",
    unsupported: "未知来源",
  };
  if (kind === "unsupported" || !kind) return localizeText("未知来源", locale);
  return labels[kind] || String(kind);
}

function sourceName(kind, locale) {
  return escapeHtml(sourceLabel(kind, locale));
}

function homeName(homeId, homeLabels) {
  if (homeLabels instanceof Map) return homeLabels.get(homeId) || homeId || "—";
  return homeLabels?.[homeId] || homeId || "—";
}

function dimension(value, locale) {
  return value ? escapeHtml(value) : copy("未提供", locale);
}

const SAMPLE_UNITS = {
  request: { label: "请求", measure: "个" },
  step: { label: "步骤", measure: "个" },
  message: { label: "消息", measure: "条" },
  turn: { label: "轮次", measure: "个" },
  mixed: { label: "混合样本", measure: "个" },
};

function sampleCountText(model, locale) {
  const count = model?.n;
  if (!Number.isFinite(count)) return "";
  const formatted = formatPerfNumber(count, locale);
  const unit = SAMPLE_UNITS[model?.window] || { label: "样本", measure: "个" };
  if (locale === "en-US") return `${formatted} ${localizeText(unit.label, locale)}${count === 1 ? "" : "s"}`;
  return `${formatted} ${unit.measure}${unit.label}`;
}

function agentName(group, locale) {
  const name = String(group?.agent ?? "").trim();
  if (group?.agentKind === "main") return copy("主代理", locale);
  if (group?.agentKind === "subagent")
    return name ? `${copy("子代理", locale)} · ${escapeHtml(name)}` : copy("子代理", locale);
  return name ? `${copy("代理未知", locale)} · ${escapeHtml(name)}` : copy("代理未知", locale);
}

function measurementName(group, locale) {
  if (group?.timingKind === "generation") return copy("生成速度", locale);
  if (group?.timingKind === "item_span_estimate") return copy("轮级 item 时窗 TPS 估算", locale);
  if (group?.timingKind === "request_e2e") return copy("请求端到端 TPS（含请求等待）", locale);
  return escapeHtml(group?.timingKind || copy("计时方式未知", locale));
}

function tokenScopeName(group, locale) {
  const scopes = {
    non_reasoning_output: "非推理输出 tokens",
    reported_output_unspecified: "报告的输出 tokens（范围未注明）",
    visible_plus_reasoning: "可见输出与推理 tokens",
    reported_output_includes_reasoning: "报告的输出 tokens（含推理）",
  };
  return copy(scopes[group?.tokenScope] || group?.tokenScope || "Token 范围未知", locale);
}

function countCell(value, locale) {
  return escapeHtml(formatPerfNumber(value, locale));
}

function pctCell(value, locale) {
  return escapeHtml(formatPerfRate(value, locale));
}

function codeUnitCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function parseGroupKey(key) {
  if (typeof key !== "string" || key === "(unkeyed)") return null;
  try {
    const value = JSON.parse(key);
    if (!Array.isArray(value) || value.length < 10) return null;
    return {
      sourceKind: value[0],
      homeId: value[1],
      channel: value[2],
      agentKind: value[3],
      agent: value[4],
      model: value[5],
      modelProvider: value[6],
      reasoningEffort: value[7],
      timingKind: value[8],
      tokenScope: value[9],
    };
  } catch {
    return null;
  }
}

function coverageForGroup(coverage, group) {
  const source = coverage?.coverage || coverage;
  return source?.byGroup?.[group?.groupKey] || null;
}

function renderRateRows(coverage, locale) {
  const rows = [
    ["有跨度率", coverage?.timingRate],
    ["完整跨度率", coverage?.completeTimingRate],
    ["有效样本率", coverage?.sampleRate],
  ];
  return rows
    .map(([label, value]) => `<tr><th scope="row">${copy(label, locale)}</th><td>${pctCell(value, locale)}</td></tr>`)
    .join("");
}

function diagnosticCountsHtml(bucket, locale) {
  const reasons = bucket?.droppedByReason || {};
  const flags = bucket?.byFlag || {};
  const rows = [
    ["缺少输出/输出无效", reasons.output_missing_zero_invalid],
    ["缺少时长/时长无效", reasons.duration_missing_nonpositive_invalid],
    ["源过滤", flags.SOURCE_FILTERED],
  ].filter(([, value]) => typeof value === "number" && value > 0);
  if (!rows.length) return "";
  return `<ul class="perf-diagnostic-counts">${rows.map(([label, value]) => `<li><span>${copy(label, locale)}</span><strong>${countCell(value, locale)}</strong></li>`).join("")}</ul>`;
}

function groupPoolKey(group) {
  return JSON.stringify([
    group.sourceKind,
    group.homeId,
    group.channel,
    group.agentKind,
    group.agent,
    group.timingKind,
    group.tokenScope,
  ]);
}

function groupOrder(a, b, ranks, minSamples) {
  const rankA = ranks.get(a.groupKey);
  const rankB = ranks.get(b.groupKey);
  if (rankA != null || rankB != null) {
    if (rankA == null) return 1;
    if (rankB == null) return -1;
    if (rankA !== rankB) return rankA - rankB;
  }
  const smallA = a.insufficientSamples === true || a.n < minSamples;
  const smallB = b.insufficientSamples === true || b.n < minSamples;
  if (smallA !== smallB) return smallA ? 1 : -1;
  if (a.state === "overflow" && b.state !== "overflow") return 1;
  if (b.state === "overflow" && a.state !== "overflow") return -1;
  const p50A = a.tps?.p50;
  const p50B = b.tps?.p50;
  if (typeof p50A === "number" && typeof p50B === "number" && p50A !== p50B) return p50B - p50A;
  return codeUnitCompare(String(a.groupKey || ""), String(b.groupKey || ""));
}

function displayRanks(groups, minSamples) {
  const pools = new Map();
  for (const group of groups) {
    if (
      group?.state === "overflow" ||
      group?.insufficientSamples === true ||
      group?.n < minSamples ||
      typeof group?.tps?.p50 !== "number"
    )
      continue;
    const key = groupPoolKey(group);
    if (!pools.has(key)) pools.set(key, []);
    pools.get(key).push(group);
  }
  const ranks = new Map();
  for (const pool of pools.values()) {
    pool.sort((a, b) => b.tps.p50 - a.tps.p50 || codeUnitCompare(String(a.groupKey || ""), String(b.groupKey || "")));
    for (let index = 0; index < pool.length; index += 1) ranks.set(pool[index].groupKey, index + 1);
  }
  return ranks;
}

function groupBy(values, keyOf) {
  const groups = new Map();
  for (const value of values) {
    const key = keyOf(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function renderGroupButton(group, index, rank, selectedKey, locale) {
  const insufficient = group.insufficientSamples === true || group.n < 20;
  const stateLabel =
    group.state === "overflow"
      ? copy("聚合溢出", locale)
      : insufficient
        ? copy("样本不足", locale)
        : `${copy("排名", locale)} ${countCell(rank, locale)}`;
  const tps = group.tps?.p50;
  const model = escapeHtml(group.model || copy("模型未知", locale));
  const provider = dimension(group.modelProvider, locale);
  const effort = dimension(group.reasoningEffort, locale);
  const selected = selectedKey === group.groupKey;
  const label = `${group.model || localizeText("模型未知", locale)}, ${localizeText(group.state === "overflow" ? "聚合溢出" : insufficient ? "样本不足" : "排名", locale)} ${rank ?? ""}, p50 ${formatPerfTps(tps, locale)} tok/s, n ${formatPerfNumber(group.n, locale)}`;
  return `<button class="perf-model-row${selected ? " selected" : ""}" type="button" data-perf-group-index="${index}" aria-pressed="${selected}" aria-label="${escapeHtml(label)}" title="${model}"><span class="perf-model-name">${model}</span><span class="perf-model-tags"><span>${provider}</span><span>${effort}</span></span><span class="perf-model-result"><span class="perf-rank${insufficient || group.state === "overflow" ? " muted" : ""}">${stateLabel}</span><strong>${escapeHtml(formatPerfTps(tps, locale))} tok/s</strong><span>n=${countCell(group.n, locale)}</span></span></button>`;
}

function renderDiagnosticGroup(bucketKey, bucket, homeLabels, locale) {
  const dimensions = parseGroupKey(bucketKey);
  const label = dimensions
    ? `${sourceName(dimensions.sourceKind, locale)} · ${escapeHtml(homeName(dimensions.homeId, homeLabels))} · ${escapeHtml(dimensions.channel || copy("渠道未知", locale))} · ${agentName(dimensions, locale)} · ${escapeHtml(dimensions.model || copy("模型未知", locale))}`
    : copy("未归类来源", locale);
  const details = diagnosticCountsHtml(bucket, locale);
  return `<article class="perf-diagnostic"><strong>${label}</strong><span>${copy("适用候选", locale)} ${countCell(bucket?.eligible, locale)} · ${copy("已采样", locale)} ${countCell(bucket?.sampled, locale)}</span>${details}</article>`;
}

export function renderPerfListHtml(perf, { locale = "zh-CN", homeLabels = {}, selectedGroupKey = null } = {}) {
  const groups = Array.isArray(perf?.groups) ? perf.groups.filter((group) => group && typeof group === "object") : [];
  const coverage = perf?.coverage || {};
  const homeLabelMap = homeLabels;
  const minSamples =
    Number.isSafeInteger(perf?.meta?.minSamples) && perf.meta.minSamples > 0 ? perf.meta.minSamples : 20;
  const ranks = displayRanks(groups, minSamples);
  const groupIndexes = new Map(groups.map((group, index) => [group, index]));
  const ordered = [...groups].sort((a, b) => groupOrder(a, b, ranks, minSamples));
  let output = "";

  const bySource = groupBy(ordered, (group) => JSON.stringify([group.sourceKind, group.homeId, group.channel]));
  for (const sourceGroups of bySource.values()) {
    const first = sourceGroups[0];
    const heading = `${sourceName(first.sourceKind, locale)} · ${escapeHtml(homeName(first.homeId, homeLabelMap))} · ${escapeHtml(first.channel || copy("渠道未知", locale))}`;
    output += `<section class="perf-source-group"><h3>${heading}</h3>`;
    const byAgent = groupBy(sourceGroups, (group) => JSON.stringify([group.agentKind, group.agent]));
    for (const agentGroups of byAgent.values()) {
      output += `<section class="perf-agent-group"><h4>${agentName(agentGroups[0], locale)}</h4>`;
      const byMeasure = groupBy(agentGroups, (group) => JSON.stringify([group.timingKind, group.tokenScope]));
      for (const measureGroups of byMeasure.values()) {
        output += `<div class="perf-measure-group"><h5>${measurementName(measureGroups[0], locale)} · ${tokenScopeName(measureGroups[0], locale)}</h5>`;
        for (const group of measureGroups) {
          const rank = ranks.get(group.groupKey);
          output += renderGroupButton(group, groupIndexes.get(group), rank, selectedGroupKey, locale);
        }
        output += "</div>";
      }
      output += "</section>";
    }
    output += "</section>";
  }

  const diagnostics = Object.entries(coverage?.byGroup || {})
    .filter(
      ([key, bucket]) =>
        bucket && bucket.eligible > 0 && bucket.sampled === 0 && !groups.some((group) => group.groupKey === key),
    )
    .sort(([a], [b]) => codeUnitCompare(a, b));
  if (diagnostics.length) {
    output += `<section class="perf-diagnostics"><h3>${copy("未形成 TPS 的候选", locale)}</h3>${diagnostics.map(([key, bucket]) => renderDiagnosticGroup(key, bucket, homeLabelMap, locale)).join("")}</section>`;
  }
  if (!output) {
    const noEligible = coverage?.eligible === 0;
    const message =
      perf?.meta?.state === "rebuilding"
        ? copy("统计更新中，当前不展示部分排名。", locale)
        : noEligible
          ? copy("当前范围没有可评估的性能样本。", locale)
          : copy("存在适用候选，但当前没有可计算的 TPS 样本。", locale);
    output = `<p class="empty perf-empty">${message}</p>`;
  }
  return output;
}

export function renderPerfCoverageHtml(perf, { locale = "zh-CN", homeLabels = {} } = {}) {
  const coverage = perf?.coverage || {};
  const state = perf?.state || perf?.meta?.state;
  const warnings = perf?.sourceWarnings?.length ? perf.sourceWarnings : perf?.meta?.sourceWarnings || [];
  const notices = [];
  if (perf?.missingSources?.length) notices.push(["status", "部分来源已缺失，已保留历史数据。"]);
  if (state === "rebuilding") notices.push(["status", "统计更新中，当前不展示部分排名。"]);
  if (state === "degraded" || (perf?.degradedHomeIds || []).length)
    notices.push(["warning", "部分数据来源不可用，当前结果可能不完整。"]);
  if (coverage.eligible > 0 && coverage.sampled === 0)
    notices.push(["warning", "存在适用候选，但当前没有可计算的 TPS 样本。"]);
  if ((perf?.unsupportedSources || []).length) notices.push(["warning", "有不支持性能统计的来源，未纳入 TPS 样本。"]);
  if (warnings.length) notices.push(["warning", "存在来源告警，展开覆盖明细可查看。"]);
  const noticeHtml = notices
    .map(
      ([kind, text]) =>
        `<p class="perf-notice ${kind}" role="${kind === "status" ? "status" : "alert"}">${copy(text, locale)}</p>`,
    )
    .join("");
  const overview = [
    ["适用候选", coverage.eligible],
    ["已采样", coverage.sampled],
    ["丢弃", coverage.dropped],
    ["等待中", coverage.pending],
    ["时间未定位", coverage.unplaced],
  ];
  const overviewHtml = overview
    .map(([label, value]) => `<div><dt>${copy(label, locale)}</dt><dd>${countCell(value, locale)}</dd></div>`)
    .join("");
  const unplacedNote = `<p class="perf-coverage-note">${copy("时间未定位统计所选来源的全历史记录，不计入当前范围的适用候选分母。", locale)}</p>`;
  const rateRows = [
    ["有跨度率", coverage.timingRate],
    ["完整跨度率", coverage.completeTimingRate],
    ["有效样本率", coverage.sampleRate],
  ];
  const ratesHtml = rateRows
    .map(([label, value]) => `<div><dt>${copy(label, locale)}</dt><dd>${pctCell(value, locale)}</dd></div>`)
    .join("");
  const countRows = [
    ["有效输出", coverage.positiveOutput],
    ["已计时输出", coverage.timedPositiveOutput],
    ["完整计时输出", coverage.completeTimedPositiveOutput],
  ];
  const countRowsHtml = countRows
    .map(([label, value]) => `<tr><th scope="row">${copy(label, locale)}</th><td>${countCell(value, locale)}</td></tr>`)
    .join("");
  const sourceRows = Object.entries(coverage.bySource || {}).sort(([a], [b]) => codeUnitCompare(a, b));
  const sourceHtml = sourceRows
    .map(([kind, bucket]) => {
      const era = bucket?.byEra;
      const eraHtml = era
        ? `<div class="perf-era-row"><strong>${sourceName(kind, locale)} · ${copy("近期", locale)}</strong><span>${copy("有效样本率", locale)} ${pctCell(era.recent?.sampleRate, locale)}</span><strong>${sourceName(kind, locale)} · ${copy("历史", locale)}</strong><span>${copy("有效样本率", locale)} ${pctCell(era.legacy?.sampleRate, locale)}</span></div>`
        : "";
      return `<section class="perf-source-coverage"><h4>${sourceName(kind, locale)}</h4><table><tbody>${renderRateRows(bucket, locale)}</tbody></table>${eraHtml}</section>`;
    })
    .join("");
  const unsupported = (perf?.unsupportedSources || [])
    .map((source) => {
      const kind = source?.kind || source?.sourceKind || "unsupported";
      const home = homeName(source?.homeId, homeLabels);
      return `<li>${sourceName(kind, locale)} · ${escapeHtml(home)}</li>`;
    })
    .join("");
  const warningHtml = warnings
    .map((warning) => {
      const home = homeName(warning?.homeId, homeLabels);
      return `<li>${sourceName(warning?.sourceKind, locale)} · ${escapeHtml(home)} · ${escapeHtml(warning?.code || copy("来源告警", locale))}: ${countCell(warning?.count, locale)}</li>`;
    })
    .join("");
  const reasonRows = Object.entries(coverage.droppedByReason || {})
    .filter(([, value]) => typeof value === "number" && value > 0)
    .sort(([a], [b]) => codeUnitCompare(a, b));
  const reasonHtml = reasonRows
    .map(
      ([reason, value]) =>
        `<tr><th scope="row">${copy(reasonLabel(reason), locale)}</th><td>${countCell(value, locale)}</td></tr>`,
    )
    .join("");
  const flagRows = Object.entries(coverage.byFlag || {})
    .filter(([, value]) => typeof value === "number" && value > 0)
    .sort(([a], [b]) => codeUnitCompare(a, b));
  const flagsHtml = flagRows
    .map(([flag, value]) => `<li>${escapeHtml(flag)}: ${countCell(value, locale)}</li>`)
    .join("");
  const breakdown = `<div class="perf-coverage-breakdown"><table class="perf-coverage-table"><tbody>${countRowsHtml}</tbody></table>${unplacedNote}${sourceHtml ? `<div class="perf-source-coverages">${sourceHtml}</div>` : ""}${reasonRows.length ? `<section><h4>${copy("丢弃原因", locale)}</h4><table class="perf-coverage-table"><tbody>${reasonHtml}</tbody></table></section>` : ""}${flagRows.length ? `<section><h4>${copy("诊断标记", locale)}</h4><p class="perf-overlap-note">${copy("诊断标记可能相互重叠，不要把它们相加为丢弃数。", locale)}</p><ul class="perf-flag-list">${flagsHtml}</ul></section>` : ""}${unsupported ? `<section><h4>${copy("不支持来源", locale)}</h4><ul class="perf-flag-list">${unsupported}</ul></section>` : ""}${warningHtml ? `<section><h4>${copy("来源告警", locale)}</h4><ul class="perf-flag-list">${warningHtml}</ul></section>` : ""}</div>`;
  return `${noticeHtml}<section class="perf-coverage-block"><h3>${copy("覆盖情况", locale)}</h3><dl class="perf-coverage-overview">${overviewHtml}</dl><dl class="perf-coverage-rates">${ratesHtml}</dl><details class="perf-coverage-more"><summary>${copy("覆盖明细与诊断", locale)}</summary>${breakdown}</details></section>`;
}

function reasonLabel(reason) {
  const labels = {
    record_conflict: "记录冲突",
    model_ambiguous: "模型不明确",
    terminal_unverified: "终态未验证",
    source_filtered: "源过滤",
    output_missing_zero_invalid: "缺少输出/输出无效",
    duration_missing_nonpositive_invalid: "缺少时长/时长无效",
    partial_item_span: "轮级时窗不完整",
    overlapping_item_span: "轮级时窗重叠",
    source_semantics_mismatch: "来源计时语义不匹配",
  };
  return labels[reason] || reason;
}

export function renderPerfDetailHtml(group, coverage, { locale = "zh-CN", homeLabels = {} } = {}) {
  if (!group) return `<p class="empty">${copy("选择一组模型查看详情。", locale)}</p>`;
  const bucket = coverageForGroup(coverage, group);
  const output = [
    ["p10（慢端）", group.tps?.p10, "tps"],
    ["p50", group.tps?.p50, "tps"],
    ["p90（快端）", group.tps?.p90, "tps"],
    ["合并样本 TPS", group.tps?.pooled, "tps"],
    ["耗时 p50", group.durationMs?.p50, "duration"],
    ["耗时 p90", group.durationMs?.p90, "duration"],
  ];
  const stats = output
    .map(([label, value, kind]) => {
      const formatted =
        kind === "duration" ? formatPerfDuration(value, locale) : `${formatPerfTps(value, locale)} tok/s`;
      return `<div class="perf-detail-stat"><dt>${copy(label, locale)}</dt><dd>${escapeHtml(formatted)}</dd></div>`;
    })
    .join("");
  const metadata = [
    ["来源", sourceName(group.sourceKind, locale)],
    ["来源目录", escapeHtml(homeName(group.homeId, homeLabels))],
    ["渠道名称", escapeHtml(group.channel || copy("渠道未知", locale))],
    ["代理", agentName(group, locale)],
    ["模型名称", escapeHtml(group.model || copy("模型未知", locale))],
    ["提供方", dimension(group.modelProvider, locale)],
    ["推理强度", dimension(group.reasoningEffort, locale)],
    ["计时口径", measurementName(group, locale)],
    ["Token 范围", tokenScopeName(group, locale)],
    ["样本数 n", countCell(group.n, locale)],
  ]
    .map(([label, value]) => `<div><dt>${copy(label, locale)}</dt><dd>${value}</dd></div>`)
    .join("");
  const diagnostic = bucket
    ? `<section class="perf-detail-coverage"><h3>${copy("此组覆盖诊断", locale)}</h3><p>${copy("适用候选", locale)} ${countCell(bucket.eligible, locale)} · ${copy("已采样", locale)} ${countCell(bucket.sampled, locale)}</p>${diagnosticCountsHtml(bucket, locale)}<table class="perf-coverage-table"><tbody>${renderRateRows(bucket, locale)}</tbody></table></section>`
    : `<p class="perf-overlap-note">${copy("此组没有覆盖诊断。", locale)}</p>`;
  const warnings =
    Array.isArray(group.warnings) && group.warnings.length
      ? `<p class="perf-notice warning">${group.warnings.map((warning) => escapeHtml(warning)).join(" · ")}</p>`
      : "";
  return `<article class="perf-detail"><h3>${escapeHtml(group.model || copy("模型未知", locale))}</h3><p class="perf-method-note">${measurementName(group, locale)} · ${tokenScopeName(group, locale)}</p><dl class="perf-detail-meta">${metadata}</dl><dl class="perf-detail-stats">${stats}</dl><p class="perf-overlap-note">${copy("p10 表示较慢端，p90 表示较快端；合并样本 TPS 不代表日历时间整体效率。", locale)}</p>${warnings}${diagnostic}</article>`;
}

function perfModels(perf) {
  const values = Array.isArray(perf) ? perf : perf?.models;
  return Array.isArray(values) ? values.filter((model) => model && typeof model === "object") : [];
}

function selectedPerfModel(models, selectedKey) {
  return (
    models.find((model) => model.key === selectedKey) ||
    models.find((model) => model.state === "ok" && Number.isFinite(model.averageTps)) ||
    models[0] ||
    null
  );
}

function modelEmptyMessage(perf, locale) {
  const state = perf?.meta?.state || perf?.state;
  if (state === "rebuilding") return copy("统计更新中，当前不展示部分排名。", locale);
  if (state === "uninitialized") return copy("性能索引尚未初始化，当前没有可展示的模型速度。", locale);
  const eligible = perf?.codexTimingCoverage?.counts?.eligible;
  return copy(eligible > 0 ? "存在适用候选，但当前没有可计算的 TPS 样本。" : "当前范围没有可评估的性能样本。", locale);
}

function modelBandGeometry(model) {
  if (
    model?.state !== "ok" ||
    !Number.isFinite(model.averageTps) ||
    !Number.isFinite(model.p10) ||
    !Number.isFinite(model.p90)
  ) {
    return null;
  }
  if (model.p10 > model.p90) return null;
  const values = [model.p10, model.p90, model.averageTps].map((value) => Math.max(0, value));
  const low = Math.min(...values);
  const high = Math.max(...values);
  const spread = high - low;
  if (!Number.isFinite(spread)) return null;
  const percentage =
    spread === 0
      ? () => 50
      : (value) => Math.max(0, Math.min(100, (((Math.max(0, value) - low) / spread + 0.25) / 1.5) * 100));
  const p10 = percentage(model.p10);
  const p90 = percentage(model.p90);
  return {
    average: percentage(model.averageTps),
    p10,
    p90,
    bandLeft: (p10 + p90) / 2,
    same: p10 === p90,
  };
}

function bandTickHtml(percentage, value, name, direction, locale, { labelled = true } = {}) {
  const label = labelled
    ? `<span class="perf-model-tick-label" data-perf-tick-label="${direction}"><span class="perf-model-tick-value">${escapeHtml(formatPerfTps(value, locale))}</span><span class="perf-model-tick-name">${copy(name, locale)}</span></span>`
    : "";
  return `<span class="perf-model-tick is-${direction}" style="left: ${percentage.toFixed(2)}%">${label}</span>`;
}

function renderModelBand(model, locale) {
  const geometry = modelBandGeometry(model);
  if (!geometry) return "";
  const p10 = formatPerfTps(model.p10, locale);
  const p90 = formatPerfTps(model.p90, locale);
  const average = formatPerfTps(model.averageTps, locale);
  const summary = `10% ${p10}, ${localizeText("平均", locale)} ${average} tok/s, 90% ${p90} tok/s, ${localizeText("样本数", locale)} ${formatPerfNumber(model.n, locale)}`;
  const endpoints = geometry.same
    ? bandTickHtml(geometry.p10, model.p10, "10% / 90%", "down", locale)
    : `${bandTickHtml(geometry.p10, model.p10, "10%", "down", locale)}${bandTickHtml(geometry.p90, model.p90, "90%", "down", locale)}<span class="perf-model-close-endpoints" hidden><span>${copy("10%", locale)} <strong>${escapeHtml(p10)}</strong></span><span>${copy("90%", locale)} <strong>${escapeHtml(p90)}</strong></span></span>`;
  return `<div class="perf-model-band">
  <div class="perf-model-plot" role="img" aria-label="${escapeHtml(summary)}" title="${copy("常见速度区间", locale)} ${escapeHtml(p10)}–${escapeHtml(p90)} tok/s · ${copy("p90 是第 90 百分位，不是最快 10% 的平均值，也不是速度上限。", locale)}">
    <div class="bar-track perf-model-band-track" aria-hidden="true"><div class="bar-fill perf-model-band-fill" style="left: ${geometry.bandLeft.toFixed(2)}%; width: ${(geometry.p90 - geometry.p10).toFixed(2)}%"></div></div>
    ${bandTickHtml(geometry.average, model.averageTps, "平均", "up", locale)}
    ${endpoints}
  </div>
</div>`;
}

function renderPerfModelRow(model, index, maxAverage, selectedKey, locale) {
  const validAverage = model.state === "ok" && Number.isFinite(model.averageTps);
  const width = validAverage && maxAverage > 0 ? Math.max(0, Math.min(100, (model.averageTps / maxAverage) * 100)) : 0;
  const selected = model.key === selectedKey;
  const source = sourceLabel(model.sourceKind, locale);
  const modelLabel = model.model || localizeText("模型未知", locale);
  const provider = model.modelProvider || "";
  const identity = [source, provider, modelLabel, model.reasoningEffort].filter(Boolean).join(" · ");
  const speed = validAverage ? formatPerfTps(model.averageTps, locale) : dash;
  const effort = model.reasoningEffort
    ? `<span class="perf-model-effort">${escapeHtml(model.reasoningEffort)}</span>`
    : "";
  const speedCell = validAverage
    ? `<span class="bar-track perf-model-mini-track" aria-hidden="true"><span class="bar-fill perf-model-mini-fill" style="width: ${width.toFixed(2)}%"></span></span><span class="perf-model-speed-value">${escapeHtml(speed)}</span>`
    : `<span></span><span class="perf-model-speed-value">${dash}</span>`;
  const label = `${identity}, ${localizeText("平均", locale)} ${speed} tok/s`;
  return `<tr class="perf-model-data-row${selected ? " selected" : ""}${model.state === "overflow" ? " is-overflow" : ""}" data-perf-model-index="${index}"><th scope="row"><button class="perf-model-row-action" type="button" data-perf-model-key="${escapeHtml(model.key)}" aria-pressed="${selected}" aria-label="${escapeHtml(label)}" title="${escapeHtml(identity)}"><span class="comparison-row-name"><span class="comparison-row-label perf-model-name">${escapeHtml(modelLabel)}</span>${effort}</span></button></th><td class="perf-model-source" title="${escapeHtml([source, provider].filter(Boolean).join(" · "))}"><span class="perf-model-source-kind">${escapeHtml(source)}</span>${provider ? `<span class="perf-model-source-provider">${escapeHtml(provider)}</span>` : ""}</td><td class="perf-model-speed"><span class="perf-model-speed-cell">${speedCell}</span></td></tr>`;
}

export function renderPerfModelTableHtml(perf, { locale = "zh-CN", selectedKey = null } = {}) {
  const models = perfModels(perf);
  if (!models.length)
    return `<section class="panel perf-model-table-panel" aria-label="${copy("模型速度", locale)}"><p class="empty perf-model-empty">${modelEmptyMessage(perf, locale)}</p></section>`;
  const maxAverage = Math.max(
    0,
    ...models
      .filter((model) => model.state === "ok" && Number.isFinite(model.averageTps))
      .map((model) => model.averageTps),
  );
  const columns =
    '<colgroup><col class="perf-model-col-model" /><col class="perf-model-col-source" /><col class="perf-model-col-speed" /></colgroup>';
  const header = `<thead><tr><th scope="col">${copy("模型", locale)}</th><th scope="col">${copy("来源", locale)}</th><th scope="col">${copy("平均速度 (tok/s)", locale)}</th></tr></thead>`;
  const rows = models.map((model, index) => renderPerfModelRow(model, index, maxAverage, selectedKey, locale)).join("");
  return `<section class="panel perf-model-table-panel" aria-label="${copy("模型速度", locale)}"><div class="comparison-table-frame"><div class="comparison-table-scroll perf-model-table-scroll" tabindex="0" role="region" aria-label="${copy("模型速度", locale)}"><table class="comparison-table perf-model-table perf-model-data-table" aria-label="${copy("模型速度", locale)}">${columns}${header}<tbody>${rows}</tbody></table></div></div></section>`;
}

export function renderPerfModelDetailHtml(model, { locale = "zh-CN" } = {}) {
  if (!model) return `<p class="empty">${copy("选择一行模型查看速度详情。", locale)}</p>`;
  const source = sourceLabel(model.sourceKind, locale);
  const modelLabel = model.model || localizeText("模型未知", locale);
  const providerText = model.modelProvider || "";
  const provider = escapeHtml(providerText);
  const effort = model.reasoningEffort
    ? `<span class="perf-model-title-effort">${escapeHtml(model.reasoningEffort)}</span>`
    : "";
  const titleLabel = [source, providerText, modelLabel, model.reasoningEffort].filter(Boolean).join(" · ");
  const count =
    model.state === "missing_duration"
      ? `${localizeText("用量记录", locale)} ${formatPerfNumber(model.candidateCount, locale)}`
      : sampleCountText(model, locale);
  const title = `<div class="perf-model-detail-title" title="${escapeHtml(titleLabel)}" aria-label="${escapeHtml(titleLabel)}"><div class="perf-model-identity-context"><span class="perf-model-source-name">${escapeHtml(source)}</span>${providerText ? `<span class="perf-model-provider-name" title="${provider}">${provider}</span>` : ""}${count ? `<span class="perf-model-sample-count">${escapeHtml(count)}</span>` : ""}</div><div class="perf-model-identity-model"><span class="perf-model-title-name">${escapeHtml(modelLabel)}</span>${effort}</div></div>`;
  if (model.state === "overflow") {
    return `<div class="perf-model-detail-head">${title}</div><p class="perf-model-overflow">${copy("聚合溢出", locale)}</p>`;
  }
  if (model.state === "missing_duration") {
    return `<div class="perf-model-detail-head">${title}</div><div class="perf-model-hero"><strong>${dash}</strong><span class="perf-model-unit">tok/s</span></div>`;
  }
  const hero = `<div class="perf-model-hero"><strong>${escapeHtml(formatPerfTps(model.averageTps, locale))}</strong><span class="perf-model-unit">tok/s</span></div>`;
  return `<div class="perf-model-detail-head">${title}</div>${hero}${renderModelBand(model, locale)}`;
}

export function renderPerfModelsHtml(perf, { locale = "zh-CN", selectedKey = null } = {}) {
  const models = perfModels(perf);
  const selected = selectedPerfModel(models, selectedKey);
  return `<div class="main-grid perf-models-grid">${renderPerfModelTableHtml(perf, { locale, selectedKey: selected?.key ?? selectedKey })}<section class="panel detail-panel perf-model-detail-panel" aria-label="${copy("模型速度", locale)}">${models.length ? renderPerfModelDetailHtml(selected, { locale }) : `<p class="empty perf-model-empty">${modelEmptyMessage(perf, locale)}</p>`}</section></div>`;
}

let observedBandPlots = new WeakSet();
let bandResizeObserver = null;

function placeBandLabel(plot, tick) {
  const label = tick?.querySelector("[data-perf-tick-label]");
  if (!label) return;
  tick.classList.remove("edge-left", "edge-right");
  const plotRect = plot.getBoundingClientRect();
  const labelRect = label.getBoundingClientRect();
  if (labelRect.left < plotRect.left + 1) tick.classList.add("edge-left");
  else if (labelRect.right > plotRect.right - 1) tick.classList.add("edge-right");
}

function layoutBandPlot(plot) {
  const fallback = plot.querySelector(".perf-model-close-endpoints");
  plot.classList.remove("is-crowded");
  if (fallback) fallback.hidden = true;
  const ticks = [...plot.querySelectorAll(".perf-model-tick")];
  for (const tick of ticks) placeBandLabel(plot, tick);

  const endpoints = [...plot.querySelectorAll(".perf-model-tick.is-down")];
  if (!fallback || endpoints.length !== 2) {
    return;
  }

  const plotRect = plot.getBoundingClientRect();
  const [slow, fast] = endpoints.map((tick) => tick.querySelector(".perf-model-tick-label")?.getBoundingClientRect());
  const crowded =
    !slow || !fast || slow.right + 6 > fast.left || slow.left < plotRect.left - 1 || fast.right > plotRect.right + 1;
  plot.classList.toggle("is-crowded", crowded);
  fallback.hidden = !crowded;
}

function observeBandPlot(plot) {
  if (observedBandPlots.has(plot) || typeof ResizeObserver === "undefined") return;
  if (!bandResizeObserver) {
    bandResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) layoutBandPlot(entry.target);
    });
  }
  observedBandPlots.add(plot);
  bandResizeObserver.observe(plot);
}

export function layoutPerfModelBands(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  bandResizeObserver?.disconnect();
  observedBandPlots = new WeakSet();
  for (const plot of root.querySelectorAll(".perf-model-plot")) {
    layoutBandPlot(plot);
    observeBandPlot(plot);
  }
}
