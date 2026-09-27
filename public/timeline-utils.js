const USAGE_FIELDS = ["total", "input", "cached", "output", "reasoning"];

export function quotaRecordValues(total, cost, sessions, rate = 1) {
  const amount = (key) =>
    Number(cost?.[`${key}Usd`] || 0) + Number(cost?.[`${key}Cny`] || 0) / (Number(rate) > 0 ? Number(rate) : 1);
  return {
    totalTokens: total.total,
    inputTokens: total.input,
    cachedTokens: total.cached,
    outputTokens: total.output,
    reasoningTokens: total.reasoning,
    sessionCount: sessions,
    modelCount: cost?.modelCount,
    cacheHitRate: cost?.cacheHitRate,
    totalCost: amount("total"),
    inputCost: amount("input"),
    cachedCost: amount("cachedInput"),
    outputCost: amount("output"),
  };
}

// Compare earlier observed reset windows of the same quota bucket. One real
// window can have several reset timestamps a few seconds apart; use its most
// frequently observed endpoint instead of discarding the entire cluster.
export function quotaRecordsForRange(range, quota, observations, summarizeWindow) {
  if (!range?.quotaWindow || range.quotaState !== "available" || !quota?.limitId) return {};
  const mode = range.quotaPreset || range.preset;
  const minutes = mode === "quota_5h" ? 300 : mode === "quota_week" ? 10080 : 0;
  if (!minutes) return {};
  const duration = minutes * 60000;
  const start = new Date(range.start).getTime();
  const asOf = new Date(range.asOf || quota.asOf).getTime();
  const byObservation = new Map();
  for (const row of observations || []) {
    const observed = Number(row.observedAtMs);
    const end = Number(row.resetsAtMs);
    if (
      row.limitId !== quota.limitId ||
      Number(row.windowMinutes) !== minutes ||
      !Number.isFinite(observed) ||
      !Number.isFinite(end) ||
      observed > asOf ||
      observed < end - duration ||
      observed >= end ||
      end > start
    )
      continue;
    const ends = byObservation.get(observed) || new Set();
    ends.add(end);
    byObservation.set(observed, ends);
  }
  const support = new Map();
  for (const ends of byObservation.values()) {
    if (ends.size !== 1) continue; // Conflicting endpoints at the same observation time.
    const end = ends.values().next().value;
    support.set(end, (support.get(end) || 0) + 1);
  }
  const tolerance = 2 * 60000;
  const clusters = [];
  for (const end of [...support.keys()].sort((a, b) => a - b)) {
    if (!clusters.length || end - clusters.at(-1).at(-1) > tolerance) clusters.push([]);
    clusters.at(-1).push(end);
  }
  const candidates = clusters
    .map((cluster) => cluster.sort((a, b) => support.get(b) - support.get(a) || b - a)[0])
    .sort((a, b) => a - b);
  // Inconsistent snapshots can also claim overlapping windows many minutes
  // apart. Keep the non-overlapping set backed by the most observations.
  const best = [{ score: 0, ends: [] }];
  for (let i = 0; i < candidates.length; i += 1) {
    let previousIndex = i - 1;
    while (previousIndex >= 0 && candidates[i] - candidates[previousIndex] < duration - tolerance) previousIndex -= 1;
    const without = best[i];
    const before = best[previousIndex + 1];
    const withCurrent = { score: before.score + support.get(candidates[i]), ends: [...before.ends, candidates[i]] };
    best.push(withCurrent.score > without.score ? withCurrent : without);
  }
  const previous = best
    .at(-1)
    .ends.map((end) => summarizeWindow({ start: new Date(end - duration), end: new Date(end - 1) }))
    .filter((value) => value.eventCount > 0);
  if (!previous.length) return {};
  const current = summarizeWindow(range);
  if (!current.eventCount) return {};
  const titles = {
    totalTokens: "总 tokens",
    inputTokens: "总输入",
    cachedTokens: "缓存读取",
    outputTokens: "输出",
    reasoningTokens: "推理输出",
    sessionCount: "会话数",
    modelCount: "模型数量",
    cacheHitRate: "缓存命中率",
    totalCost: "估算花销",
    inputCost: "缓外输入花销",
    cachedCost: "缓存输入花销",
    outputCost: "输出花销",
  };
  const records = {};
  for (const [metric, title] of Object.entries(titles)) {
    const value = current.values[metric];
    const baseline = previous.map((item) => item.values[metric]).filter(Number.isFinite);
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      !baseline.length ||
      baseline.some((old) => value <= old + Math.max(1, Math.abs(old)) * 1e-10)
    )
      continue;
    records[metric] = {
      title: `${title}最高的${minutes === 300 ? "5 小时限额窗口" : "每周限额窗口"}`,
      unit: minutes === 300 ? "5-hour window" : "weekly limit window",
      period: `${new Date(range.start).toISOString()} – ${new Date(range.windowEndExclusive || new Date(range.end).getTime() + 1).toISOString()}`,
      value,
      comparedWindowCount: baseline.length,
    };
  }
  return records;
}

export const RECENT_SELECTIONS = Object.freeze(["上一个5h", "上周", "上个月", "今年"]);

export function resolveNamedRecentRange(value, now, quota, calendarZone = "local") {
  if (!RECENT_SELECTIONS.includes(value)) return null;
  const utc = calendarZone === "utc";
  if (value === "上个月")
    return {
      preset: "recent",
      start: utc
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
        : new Date(now.getFullYear(), now.getMonth() - 1, 1),
      end: new Date(
        (utc
          ? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
          : new Date(now.getFullYear(), now.getMonth(), 1).getTime()) - 1,
      ),
      bucket: "day",
    };
  if (value === "今年")
    return {
      preset: "recent",
      start: utc ? new Date(Date.UTC(now.getUTCFullYear(), 0, 1)) : new Date(now.getFullYear(), 0, 1),
      end: utc
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59, 999))
        : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999),
      bucket: "month",
    };
  const mode = value === "上一个5h" ? "quota_5h" : "quota_week";
  const window = quota?.previousWindows?.[mode];
  const start = new Date(window?.windowStart || NaN);
  const endExclusive = new Date(window?.windowEndExclusive || NaN);
  const duration = (mode === "quota_5h" ? 5 : 168) * 60 * 60 * 1000;
  const available =
    window?.state === "available" &&
    Number.isFinite(start.getTime()) &&
    endExclusive.getTime() - start.getTime() === duration &&
    endExclusive <= now;
  return {
    preset: "recent",
    recentValue: value,
    quotaWindow: true,
    quotaPreset: mode,
    quotaState: available ? "available" : "missing",
    quotaReason: available ? null : "尚未发现上一限额窗口的 Codex 记录。",
    start: available ? start : null,
    end: available ? new Date(endExclusive.getTime() - 1) : null,
    windowStart: available ? start : null,
    windowEndExclusive: available ? endExclusive : null,
    asOf: now,
    bucket: mode === "quota_5h" ? "quota_30m" : "quota_24h",
    rolling: true,
  };
}

export function hasSelectedCodexSource(homes = [], excludedIds = []) {
  const excluded = new Set(excludedIds.map(String));
  return homes.some(
    (home) =>
      !excluded.has(String(home.id)) && !["zcode", "unsupported"].includes(home.kind) && home.status !== "unsupported",
  );
}

export function timelineDateKey(date, calendarZone = "local") {
  const utc = calendarZone === "utc";
  const year = utc ? date.getUTCFullYear() : date.getFullYear();
  const month = String((utc ? date.getUTCMonth() : date.getMonth()) + 1).padStart(2, "0");
  const day = String(utc ? date.getUTCDate() : date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function timelineBucketKey(value, bucket = "day", calendarZone = "local") {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const utc = calendarZone === "utc";
  if (bucket === "hour") {
    return `${timelineDateKey(date, calendarZone)} ${String(utc ? date.getUTCHours() : date.getHours()).padStart(2, "0")}:00`;
  }
  if (bucket === "month") {
    return timelineDateKey(date, calendarZone).slice(0, 7);
  }
  if (bucket === "week") {
    const start = utc
      ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
      : new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = (utc ? start.getUTCDay() : start.getDay()) || 7;
    if (utc) start.setUTCDate(start.getUTCDate() - day + 1);
    else start.setDate(start.getDate() - day + 1);
    return timelineDateKey(start, calendarZone);
  }
  return timelineDateKey(date, calendarZone);
}

function asDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date, zone = "local") {
  return zone === "utc"
    ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
    : new Date(date.getFullYear(), date.getMonth(), date.getDate());
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

export const MAX_TIMELINE_SLOTS = 2_000;

function appendCalendarKey(keys, key, limit) {
  if (keys.length >= limit) {
    /** @type {RangeError & { code?: string }} */
    const error = new RangeError(`Time range exceeds ${limit} timeline slots.`);
    error.code = "TIMELINE_RANGE_TOO_LARGE";
    throw error;
  }
  keys.push(key);
}

function generateCalendarKeys(start, end, bucket, calendarZone = "local", limit = MAX_TIMELINE_SLOTS) {
  const keys = [];
  if (!start || !end || end < start) return keys;
  const utc = calendarZone === "utc";
  if (bucket === "hour") {
    const cursor = utc
      ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate(), start.getUTCHours()))
      : new Date(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours());
    const last = utc
      ? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), end.getUTCHours()))
      : new Date(end.getFullYear(), end.getMonth(), end.getDate(), end.getHours());
    const seen = new Set();
    while (cursor <= last) {
      const key = timelineBucketKey(cursor, bucket, calendarZone);
      if (!seen.has(key)) {
        seen.add(key);
        appendCalendarKey(keys, key, limit);
      }
      if (utc) cursor.setUTCHours(cursor.getUTCHours() + 1);
      else cursor.setHours(cursor.getHours() + 1);
    }
    return keys;
  }
  if (bucket === "day") {
    let cursor = startOfDay(start, calendarZone);
    const last = startOfDay(end, calendarZone);
    while (cursor <= last) {
      appendCalendarKey(keys, timelineBucketKey(cursor, bucket, calendarZone), limit);
      cursor = addCalendarDays(cursor, 1, calendarZone);
    }
    return keys;
  }
  if (bucket === "week") {
    let cursor = startOfWeek(start, calendarZone);
    const last = startOfWeek(end, calendarZone);
    while (cursor <= last) {
      appendCalendarKey(keys, timelineBucketKey(cursor, bucket, calendarZone), limit);
      cursor = addCalendarDays(cursor, 7, calendarZone);
    }
    return keys;
  }
  if (bucket === "month") {
    const cursor = utc
      ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
      : new Date(start.getFullYear(), start.getMonth(), 1);
    const last = utc
      ? new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1))
      : new Date(end.getFullYear(), end.getMonth(), 1);
    while (cursor <= last) {
      appendCalendarKey(keys, timelineBucketKey(cursor, bucket, calendarZone), limit);
      if (utc) cursor.setUTCMonth(cursor.getUTCMonth() + 1, 1);
      else cursor.setMonth(cursor.getMonth() + 1, 1);
    }
  }
  return keys;
}

function slotKeys(range, bucket, existingRows) {
  const start = asDate(range?.start);
  const end = asDate(range?.end);
  const preset = range?.preset;
  const zone = range?.calendarZone === "utc" ? "utc" : "local";
  if (bucket === "hour" && preset === "today" && start) {
    const date = timelineDateKey(start, zone);
    return Array.from({ length: 24 }, (_, hour) => `${date} ${String(hour).padStart(2, "0")}:00`);
  }
  if (bucket === "day" && preset === "week" && start) {
    const monday = startOfWeek(start, zone);
    return Array.from({ length: 7 }, (_, index) =>
      timelineBucketKey(addCalendarDays(monday, index, zone), "day", zone),
    );
  }
  if (bucket === "day" && preset === "month" && start) {
    const first =
      zone === "utc"
        ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
        : new Date(start.getFullYear(), start.getMonth(), 1);
    const days =
      zone === "utc"
        ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate()
        : new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    return Array.from({ length: days }, (_, index) =>
      timelineBucketKey(addCalendarDays(first, index, zone), "day", zone),
    );
  }
  if (start && end) return generateCalendarKeys(start, end, bucket, zone);
  return [...existingRows].sort((a, b) => a.key.localeCompare(b.key)).map((row) => row.key);
}

function emptyUsage() {
  return { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
}

function emptyRow(key, slot = {}) {
  return {
    key,
    name: key,
    count: 0,
    sessions: 0,
    total: emptyUsage(),
    channels: [],
    models: [],
    costByModel: {},
    pricedTokens: 0,
    unpricedTokens: 0,
    minimumEstimatedTokens: 0,
    serviceTierUnknownTokens: 0,
    contextUnknownTokens: 0,
    cacheWriteUnknownTokens: 0,
    pricingStatus: "no-data",
    ...(slot.slotStartMs === undefined
      ? {}
      : {
          slotStartMs: slot.slotStartMs,
          slotEndExclusiveMs: slot.slotEndExclusiveMs,
          future: Boolean(slot.future),
        }),
  };
}

function addUsage(target, usage = {}) {
  for (const field of USAGE_FIELDS) target[field] += Number(usage[field] || 0);
}

function addSegment(group, event) {
  group.count += 1;
  group.sessions.add(event.sessionId || "");
  addUsage(group.total, event.total || event.usage);
}

export function generateQuotaTimelineSlots(range, bucket) {
  const slotCount = bucket === "quota_30m" ? 10 : bucket === "quota_24h" ? 7 : 0;
  if (!slotCount) return [];
  const slotMs = bucket === "quota_30m" ? 30 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const startMs = asDate(range?.windowStart || range?.start)?.getTime();
  const endMs = asDate(range?.windowEndExclusive)?.getTime();
  const asOfMs = asDate(range?.asOf)?.getTime();
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    !Number.isFinite(asOfMs) ||
    endMs - startMs !== slotCount * slotMs
  ) {
    throw new RangeError("Quota timeline requires an observed window and a fixed asOf time.");
  }
  return Array.from({ length: slotCount }, (_, index) => {
    const slotStartMs = startMs + index * slotMs;
    return {
      key: String(slotStartMs),
      name: new Date(slotStartMs).toISOString(),
      slotStartMs,
      slotEndExclusiveMs: slotStartMs + slotMs,
      future: slotStartMs >= asOfMs,
    };
  });
}

function quotaSlotForEvent(event, slots, range, bucket) {
  const timestampValue = event.timestamp ?? event.timestampMs;
  const timestampMs =
    timestampValue instanceof Date
      ? timestampValue.getTime()
      : typeof timestampValue === "number"
        ? timestampValue
        : Date.parse(timestampValue);
  if (!Number.isFinite(timestampMs) || !slots.length) return null;
  const asOfMs = asDate(range.asOf).getTime();
  const windowEndMs = asDate(range.windowEndExclusive).getTime();
  const startMs = slots[0].slotStartMs;
  const effectiveEndExclusiveMs = Math.min(asOfMs, windowEndMs);
  if (timestampMs < startMs || timestampMs >= effectiveEndExclusiveMs) return null;
  const slotMs = bucket === "quota_30m" ? 30 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return slots[Math.floor((timestampMs - startMs) / slotMs)] || null;
}

function materializeSegments(groups) {
  return [...groups.values()]
    .map((group) => ({
      key: group.key,
      name: group.name,
      count: group.count,
      sessions: group.sessions.size,
      total: group.total,
    }))
    .sort((a, b) => b.total.total - a.total.total || a.name.localeCompare(b.name));
}

/** @param {Iterable<any>} events */
export function buildTimelineRows(events = [], range = {}, bucket = "day", options = {}) {
  const hasBoundedRange = Boolean(asDate(range?.start) && asDate(range?.end));
  const quotaSlots =
    bucket === "quota_30m" || bucket === "quota_24h" ? generateQuotaTimelineSlots(range, bucket) : null;
  const rangedKeys = quotaSlots
    ? quotaSlots.map((slot) => slot.key)
    : hasBoundedRange
      ? slotKeys(range, bucket, [])
      : null;
  const quotaSlotsByKey = quotaSlots ? new Map(quotaSlots.map((slot) => [slot.key, slot])) : null;
  const rowsByKey = new Map();
  const estimateCost = options.estimateCost || ((event) => event.costEstimate || null);
  for (const event of events) {
    const slot = quotaSlots ? quotaSlotForEvent(event, quotaSlots, range, bucket) : null;
    const key = quotaSlots
      ? slot?.key
      : timelineBucketKey(event.timestamp ?? event.timestampMs, bucket, range?.calendarZone);
    if (!key) continue;
    const row = rowsByKey.get(key) || {
      ...emptyRow(key, slot || {}),
      channelGroups: new Map(),
      modelGroups: new Map(),
      modelCosts: new Map(),
      sessionsSet: new Set(),
      estimatedRecords: 0,
      serviceTierUnknownTokens: 0,
      contextUnknownTokens: 0,
      cacheWriteUnknownTokens: 0,
    };
    row.count += 1;
    row.sessionsSet.add(event.sessionId || "");
    addUsage(row.total, event.total || event.usage);
    const channelName = String(event.channel || "Unknown");
    const channel = row.channelGroups.get(channelName) || {
      key: channelName,
      name: channelName,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
    };
    addSegment(channel, event);
    row.channelGroups.set(channelName, channel);

    const modelName = String(event.model || "Unknown model");
    const model = row.modelGroups.get(modelName) || {
      key: modelName,
      name: modelName,
      count: 0,
      sessions: new Set(),
      total: emptyUsage(),
    };
    addSegment(model, event);
    row.modelGroups.set(modelName, model);

    const estimate = estimateCost(event);
    if (estimate) {
      options.onEstimate?.(event, estimate);
      row.estimatedRecords += 1;
      const cost = row.modelCosts.get(modelName) || {
        totalUsd: 0,
        currency: estimate.currency || "USD",
        pricedTokens: 0,
        unpricedTokens: 0,
        minimumEstimatedTokens: 0,
        serviceTierUnknownTokens: 0,
        contextUnknownTokens: 0,
        cacheWriteUnknownTokens: 0,
        pricingStatuses: new Set(),
      };
      cost.totalUsd += Number(estimate.totalUsd || 0);
      cost.pricedTokens += Number(estimate.pricedTokens || 0);
      cost.unpricedTokens += Number(estimate.unpricedTokens || 0);
      cost.minimumEstimatedTokens += Number(estimate.minimumEstimatedTokens || 0);
      cost.serviceTierUnknownTokens += Number(estimate.serviceTierUnknownTokens || 0);
      cost.contextUnknownTokens += Number(estimate.contextUnknownTokens || 0);
      cost.cacheWriteUnknownTokens += Number(estimate.cacheWriteUnknownTokens || 0);
      if (estimate.pricingStatus) cost.pricingStatuses.add(estimate.pricingStatus);
      row.modelCosts.set(modelName, cost);
      row.pricedTokens += Number(estimate.pricedTokens || 0);
      row.unpricedTokens += Number(estimate.unpricedTokens || 0);
      row.minimumEstimatedTokens += Number(estimate.minimumEstimatedTokens || 0);
      row.serviceTierUnknownTokens += Number(estimate.serviceTierUnknownTokens || 0);
      row.contextUnknownTokens += Number(estimate.contextUnknownTokens || 0);
      row.cacheWriteUnknownTokens += Number(estimate.cacheWriteUnknownTokens || 0);
    }
    rowsByKey.set(key, row);
  }

  const rows = [...rowsByKey.values()].map((row) => {
    const statusValues = [...row.modelCosts.values()].flatMap((entry) => [...entry.pricingStatuses]);
    let pricingStatus = "unavailable";
    if (row.estimatedRecords > 0) {
      pricingStatus =
        row.unpricedTokens > 0
          ? row.pricedTokens > 0
            ? "partial"
            : "unpriced"
          : row.minimumEstimatedTokens > 0
            ? "minimum-estimate"
            : "estimated";
      if (!row.pricedTokens && !row.unpricedTokens && statusValues.includes("unknown")) pricingStatus = "unknown";
    }
    return {
      key: row.key,
      name: row.name,
      count: row.count,
      sessions: row.sessionsSet.size,
      total: row.total,
      channels: materializeSegments(row.channelGroups),
      models: materializeSegments(row.modelGroups),
      costByModel: Object.fromEntries(
        [...row.modelCosts].map(([name, cost]) => [
          name,
          {
            totalUsd: cost.totalUsd,
            currency: cost.currency || "USD",
            pricedTokens: cost.pricedTokens,
            unpricedTokens: cost.unpricedTokens,
            minimumEstimatedTokens: cost.minimumEstimatedTokens,
            serviceTierUnknownTokens: cost.serviceTierUnknownTokens,
            contextUnknownTokens: cost.contextUnknownTokens,
            cacheWriteUnknownTokens: cost.cacheWriteUnknownTokens,
            pricingStatus:
              cost.unpricedTokens > 0
                ? cost.pricedTokens > 0
                  ? "partial"
                  : "unpriced"
                : cost.minimumEstimatedTokens > 0
                  ? "minimum-estimate"
                  : "estimated",
          },
        ]),
      ),
      pricedTokens: row.pricedTokens,
      unpricedTokens: row.unpricedTokens,
      minimumEstimatedTokens: row.minimumEstimatedTokens,
      serviceTierUnknownTokens: row.serviceTierUnknownTokens,
      contextUnknownTokens: row.contextUnknownTokens,
      cacheWriteUnknownTokens: row.cacheWriteUnknownTokens,
      pricingStatus,
      ...(row.slotStartMs === undefined
        ? {}
        : {
            slotStartMs: row.slotStartMs,
            slotEndExclusiveMs: row.slotEndExclusiveMs,
            future: Boolean(row.future),
          }),
    };
  });
  rows.sort((a, b) =>
    a.slotStartMs !== undefined && b.slotStartMs !== undefined
      ? a.slotStartMs - b.slotStartMs
      : a.key.localeCompare(b.key),
  );

  const byKey = new Map(rows.map((row) => [row.key, row]));
  const ordered = (rangedKeys || slotKeys(range, bucket, rows)).map(
    (key) => byKey.get(key) || emptyRow(key, quotaSlotsByKey?.get(key) || {}),
  );
  const included = new Set(ordered.map((row) => row.key));
  for (const row of rows) if (!included.has(row.key)) ordered.push(row);
  return ordered;
}
