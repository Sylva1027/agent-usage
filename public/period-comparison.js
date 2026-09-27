// 周期对比的共享实现：服务端汇总、SQLite 索引和浏览器（含静态快照）三条
// 路径都使用这里的口径，避免排除来源或时段边界在各实现间漂移。
import { USAGE_DETAIL_INCONSISTENT, USAGE_DETAIL_MASK, emptyUsage } from "./usage-fields.js";

export const COMPARISON_PERIOD_KEYS = ["today", "week", "month", "all"];

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function startOfLocalDay(date, zone = "local") {
  return zone === "utc"
    ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    : new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function endOfLocalDay(date, zone = "local") {
  return zone === "utc"
    ? new Date(startOfLocalDay(date, zone).getTime() + MS_PER_DAY - 1)
    : new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

export function startOfLocalWeek(date, zone = "local") {
  const start = startOfLocalDay(date, zone);
  const day = (zone === "utc" ? start.getUTCDay() : start.getDay()) || 7;
  if (zone === "utc") start.setUTCDate(start.getUTCDate() - day + 1);
  else start.setDate(start.getDate() - day + 1);
  return start;
}

// today/week/month/all 四个日历时段的唯一实现：usage-core 的 resolveDateRange
// 与 summarizePeriodComparison 都委托到这里。
export function calendarPresetRange(preset, now, zone = "local", timestamps = []) {
  if (preset === "today") {
    return { start: startOfLocalDay(now, zone), end: endOfLocalDay(now, zone), preset, calendarZone: zone };
  }
  if (preset === "week") {
    return { start: startOfLocalWeek(now, zone), end: endOfLocalDay(now, zone), preset, calendarZone: zone };
  }
  if (preset === "month") {
    return {
      start:
        zone === "utc"
          ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
          : new Date(now.getFullYear(), now.getMonth(), 1),
      end: endOfLocalDay(now, zone),
      preset,
      calendarZone: zone,
    };
  }
  if (!timestamps.length) {
    return { start: null, end: null, preset: "all", calendarZone: zone };
  }
  let earliestTimestamp = timestamps[0];
  let latestTimestamp = timestamps[0];
  for (const timestamp of timestamps) {
    if (timestamp < earliestTimestamp) {
      earliestTimestamp = timestamp;
    }
    if (timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
    }
  }
  return {
    start: startOfLocalDay(new Date(earliestTimestamp), zone),
    end: endOfLocalDay(new Date(latestTimestamp), zone),
    preset: "all",
    calendarZone: zone,
  };
}

function emptyPeriodMetrics() {
  return {
    total: 0,
    input: 0,
    inputUnavailableTokens: 0,
    cached: 0,
    cachedUnavailableTokens: 0,
    uncachedInput: 0,
    uncachedInputUnavailableTokens: 0,
    cacheRateInput: 0,
    cacheRateCached: 0,
    output: 0,
    outputUnavailableTokens: 0,
    reasoning: 0,
    reasoningUnavailableTokens: 0,
    unattributedDetailTokens: 0,
    inconsistentTokens: 0,
    reconciliationGap: 0,
  };
}

function addPeriodEvent(target, event) {
  const usage = event.total || emptyUsage();
  const total = Number(usage.total || 0);
  const mask = Number.isInteger(event.detailMask) ? event.detailMask : USAGE_DETAIL_MASK.complete;
  target.total += total;
  if (mask & USAGE_DETAIL_MASK.input) {
    target.input += Number(usage.input || 0);
  } else {
    target.inputUnavailableTokens += total;
  }
  if (mask & USAGE_DETAIL_MASK.cached) {
    target.cached += Number(usage.cached || 0);
  } else {
    target.cachedUnavailableTokens += total;
  }
  if (
    (mask & (USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.cached)) ===
    (USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.cached)
  ) {
    target.uncachedInput += Math.max(0, Number(usage.input || 0) - Number(usage.cached || 0));
    target.cacheRateInput += Number(usage.input || 0);
    target.cacheRateCached += Number(usage.cached || 0);
  } else {
    target.uncachedInputUnavailableTokens += total;
  }
  if (mask & USAGE_DETAIL_MASK.output) {
    target.output += Number(usage.output || 0);
  } else {
    target.outputUnavailableTokens += total;
  }
  if (mask & USAGE_DETAIL_MASK.reasoning) {
    target.reasoning += Number(usage.reasoning || 0);
  } else {
    target.reasoningUnavailableTokens += total;
  }
  if ((mask & USAGE_DETAIL_MASK.complete) !== USAGE_DETAIL_MASK.complete) {
    target.unattributedDetailTokens += total;
  }
  if (mask & USAGE_DETAIL_INCONSISTENT) {
    target.inconsistentTokens += total;
  }
  target.reconciliationGap += Number(event.reconciliationGap || 0);
}

function comparisonRow(map, key, name, event, periodKeys, { includeRepositoryMetadata = false } = {}) {
  let row = map.get(key);
  if (!row) {
    row = {
      key,
      name,
      ...(includeRepositoryMetadata ? { kind: event.repositoryKind || "directory", pathSet: new Set() } : {}),
      periods: Object.fromEntries(periodKeys.map((period) => [period, emptyPeriodMetrics()])),
    };
    map.set(key, row);
  } else if (includeRepositoryMetadata && name < row.name) {
    row.name = name;
  }
  if (includeRepositoryMetadata && event.cwd) {
    row.pathSet.add(event.cwd);
  }

  return row;
}

export function summarizePeriodComparison(events = [], options = {}) {
  const asOf = options.now ? new Date(options.now) : new Date();
  const zone = options.calendarZone === "utc" ? "utc" : "local";
  const timestamps = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
  const ranges = Object.fromEntries(
    COMPARISON_PERIOD_KEYS.map((key) => [key, calendarPresetRange(key, asOf, zone, timestamps)]),
  );
  const rows = { models: new Map(), repositories: new Map() };
  const totals = Object.fromEntries(COMPARISON_PERIOD_KEYS.map((key) => [key, emptyPeriodMetrics()]));

  for (const event of events) {
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) {
      continue;
    }
    const modelKey = event.model || "Unknown model";
    const repositoryKey = event.repositoryKey || `directory:${event.cwd || "Unknown cwd"}`;
    const modelRow = comparisonRow(rows.models, modelKey, modelKey, event, COMPARISON_PERIOD_KEYS);
    const repositoryRowKey = repositoryKey;
    const repositoryName = event.repositoryPath || event.cwd || "Unknown cwd";
    const repositoryRow = comparisonRow(
      rows.repositories,
      repositoryRowKey,
      repositoryName,
      event,
      COMPARISON_PERIOD_KEYS,
      {
        includeRepositoryMetadata: true,
      },
    );

    for (const period of COMPARISON_PERIOD_KEYS) {
      const range = ranges[period];
      if ((range.start && timestamp < range.start.getTime()) || (range.end && timestamp > range.end.getTime())) {
        continue;
      }
      addPeriodEvent(totals[period], event);
      addPeriodEvent(modelRow.periods[period], event);
      addPeriodEvent(repositoryRow.periods[period], event);
    }
  }

  function sortedRows(map) {
    return [...map.values()]
      .map((row) => {
        const { pathSet, ...result } = row;
        return pathSet ? { ...result, pathCount: pathSet.size } : result;
      })
      .sort((a, b) => b.periods.all.total - a.periods.all.total || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  return {
    asOf: asOf.toISOString(),
    periods: COMPARISON_PERIOD_KEYS.map((key) => ({
      key,
      start: ranges[key].start?.toISOString() || null,
      end: ranges[key].end?.toISOString() || null,
    })),
    totals,
    models: sortedRows(rows.models),
    repositories: sortedRows(rows.repositories),
  };
}
