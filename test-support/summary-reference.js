// Independent event-by-event reference retained for memory/SQLite parity and literal boundary assertions.
// The live dashboard receives its summary and metadata from the API.
import {
  buildTimelineRows,
  channelForRange,
  homeSourceKinds,
  sourceGroup,
  deriveTimelineBucket,
  RECENT_SELECTIONS,
  resolveNamedRecentRange,
  previousQuotaRange,
  quotaRecordsForRange,
  quotaRecordValues,
} from "../public/timeline-utils.js";
import { canonicalRecentValue } from "../public/i18n.js";
import { buildModelActivity, canonicalModelName } from "../public/pricing-models.js";
import { isQuotaUsage } from "../public/quota-usage.js";
import { state } from "../public/app-state.js";

const QUOTA_UI_COPY = { unavailable: "此限额窗口当前不可用。", invalidBoundaries: "限额窗口边界无效。" };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const QUOTA_PRESETS = ["quota_5h", "quota_week"];

const CODEX_HOME_KINDS = new Set(["main", "jetbrains", "extra", "codex"]);

function usageValue(usage, field = "total") {
  return usage?.[field] || 0;
}

function isQuotaPreset(preset = state.preset) {
  return QUOTA_PRESETS.includes(preset);
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

function normalizeRecentValue(value) {
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

function getRange(events, quotaSnapshot = state.quotaSnapshot) {
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
        quotaReason: quotaWindow?.reason || QUOTA_UI_COPY.unavailable,
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

function setSummaryFilters(filters = {}) {
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

function comparisonLabel(range = null) {
  const mode = range?.quotaPreset || range?.preset || state.preset;
  return (
    {
      quota_5h: "较上一5h",
      quota_week: "较上一7d",
      today: "较昨日",
      week: "较上周",
      month: "较上月",
      custom: "较上一等长周期",
      recent: "较上一等长周期",
    }[mode] || "暂无对比"
  );
}

function percentChange(current, previous) {
  if (!previous) {
    return null;
  }
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function summarizeComparison(allEvents, range, currentTotals, options = {}) {
  // 纯统计辅助与服务端沿用同一套趋势口径。
  const quotaMode = Boolean(range?.quotaWindow || isQuotaPreset(range?.preset));
  const previousRange = quotaMode
    ? previousQuotaRange(range, options.quota, options.observations)
    : previousPeriodRange(range);
  const currentAvailable = !quotaMode || range?.quotaState === "available";
  if (!currentAvailable || !previousRange) {
    return {
      label: comparisonLabel(range),
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
    return (
      Number.isFinite(time) &&
      time >= previousRange.start.getTime() &&
      time <= previousRange.end.getTime() &&
      (!options.eventEligible || options.eventEligible(event))
    );
  });
  const previousTotals = previousEvents.reduce((sum, event) => addUsage(sum, event.total), emptyUsage());
  const now = asDate(range?.asOf) || asDate(state.now) || new Date();
  const average = averageTrend(currentTotals, previousTotals, range, previousRange, now);
  return {
    label: comparisonLabel(range),
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
  return new Set(
    (report.homes || [])
      .filter((home) => {
        const kind = String(home.kind ?? "").trim();
        return !kind || CODEX_HOME_KINDS.has(kind);
      })
      .map((home) => String(home.id)),
  );
}

function summarize(report) {
  const sourceKinds = homeSourceKinds(report.homes);
  const excluded = new Set((state.excludedHomes || []).map(String));
  const sourceEvents = (report.events || []).filter((event) => !excluded.has(String(event.homeId)));
  const range = getRange(sourceEvents, report.quota);
  const quotaObservations = report.quotaObservations || report.rateLimitObservations || [];
  const quotaPreset = isQuotaPreset(state.preset) || Boolean(range.quotaWindow);
  const quotaAvailable = !quotaPreset || range.quotaState === "available";
  // 限额窗口只衡量 Codex 用量，与服务端聚合保持同一口径。
  const codexHomeIds = quotaPreset ? codexHomeIdSet(report) : null;
  const quotaEventEligible = (event) => Boolean(codexHomeIds?.has(String(event.homeId))) && isQuotaUsage(event);
  // 跨度升档在汇总时推导（此时范围已解析、跨度已知），而非切换预设时。
  const bucket = deriveTimelineBucket(range, range.bucket || state.bucket);
  const events = sourceEvents.filter((event) => {
    if (!quotaAvailable) return false;
    if (quotaPreset && !quotaEventEligible(event)) {
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
    if (quotaAvailable) timeline = buildTimelineRows(events, range, bucket, { sourceKinds });
  } catch (error) {
    if (error.code !== "TIMELINE_RANGE_TOO_LARGE") throw error;
    timelineError = error.message;
  }
  const channels = groupEvents(events, (event) =>
    channelForRange(event.channel, range, sourceKinds.get(String(event.homeId))),
  ).sort((a, b) => b.total.total - a.total.total);
  const projects = groupEvents(events, (event) => event.cwd || "Unknown cwd").sort(
    (a, b) => b.total.total - a.total.total,
  );
  const repositories = groupRepositoryEvents(events);
  const models = groupEvents(events, (event) =>
    canonicalModelName(event.model || "Unknown model", report.pricingCatalog?.models),
  ).sort((a, b) => b.total.total - a.total.total);
  return {
    range,
    totals,
    costEstimate: summarizeEmbeddedCostEstimates(events, report.pricing),
    records: quotaPreset
      ? quotaRecordsForRange(range, report.quota, quotaObservations, (window) => {
          const rows = sourceEvents.filter(
            (event) =>
              quotaEventEligible(event) &&
              new Date(event.timestamp) >= window.start &&
              new Date(event.timestamp) <= window.end,
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
    comparison:
      report.comparison ??
      summarizeComparison(sourceEvents, range, totals, {
        quota: report.quota,
        observations: quotaObservations,
        eventEligible: quotaPreset ? quotaEventEligible : null,
      }),
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
    priceSource: priceSources.size === 1 ? [...priceSources][0] : "",
  };
}

function bucketForChannel(channel) {
  const name = String(channel || "").toLowerCase();
  if (name.startsWith("zcode")) return "ZCode";
  if (name.startsWith("dsh")) return "DSH";
  if (name.startsWith("opencode")) return "OpenCode";
  if (name.startsWith("claude")) return "Claude";
  if (name.startsWith("workbuddy")) return "WorkBuddy";
  return "Codex";
}

export function modelActivityFromReport(report) {
  const sourceKinds = homeSourceKinds(report.homes);
  return buildModelActivity(
    report.events.map((event) => ({
      model: event.model,
      timestamp: event.timestamp,
      harness: bucketForChannel(sourceGroup(event.channel, sourceKinds.get(String(event.homeId)))),
    })),
    report.asOf || report.generatedAt || Date.now(),
  );
}

export { getRange, setSummaryFilters, summarize };
