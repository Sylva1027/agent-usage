import {
  COMPARISON_PERIOD_KEYS,
  calendarPresetRange,
  emptyPeriodMetrics,
} from '../../public/period-comparison.js';
import { buildTimelineRows } from '../../public/timeline-utils.js';
import { createCostEstimateAccumulator, runWithPricingCatalog } from '../../src/pricing.js';
import {
  previousUsageRange,
  usageComparisonFromAggregates,
} from '../../src/usage-core.js';

const USAGE_FIELDS = ['total', 'input', 'cached', 'output', 'reasoning'];
const PERIOD_METRIC_FIELDS = Object.keys(emptyPeriodMetrics());
const COST_USD_FIELDS = ['totalUsd', 'inputUsd', 'cachedInputUsd', 'cacheWriteInputUsd', 'outputUsd'];
const COST_CNY_FIELDS = ['totalCny', 'inputCny', 'cachedInputCny', 'cacheWriteInputCny', 'outputCny'];
const COST_INTEGER_FIELDS = [
  'pricedTokens',
  'unpricedTokens',
  'minimumEstimatedTokens',
  'pricedRecords',
  'unpricedRecords',
  'minimumEstimatedRecords',
  'serviceTierUnknownTokens',
  'serviceTierUnknownRecords',
  'contextUnknownTokens',
  'contextUnknownRecords',
  'cacheWriteUnknownTokens',
  'cacheWriteUnknownRecords',
];
const COST_ARRAY_FIELDS = ['unpricedModels', 'minimumRateModels', 'unpricedReasons', 'priceVersions', 'priceSources'];
const COST_LOCALE_ARRAY_FIELDS = new Set(['unpricedModels', 'minimumRateModels']);
const TIMELINE_COST_FIELDS = [
  'totalUsd',
  'pricedTokens',
  'unpricedTokens',
  'minimumEstimatedTokens',
  'serviceTierUnknownTokens',
  'contextUnknownTokens',
  'cacheWriteUnknownTokens',
];

function emptyUsage() {
  return { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
}

function addUsage(target, source = {}) {
  for (const field of USAGE_FIELDS) target[field] += Number(source[field] || 0);
}

function compareOrder(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const result = String(left?.[index] ?? '').localeCompare(String(right?.[index] ?? ''));
    if (result) return result;
  }
  return 0;
}

function mergeOrder(current, next) {
  return !current || compareOrder(next, current) < 0 ? next : current;
}

function mergeSessions(target, source) {
  for (const [sessionId, order] of source || []) {
    target.set(sessionId, mergeOrder(target.get(sessionId), order));
  }
}

function mergeSummaryGroups(parts, field) {
  const groups = new Map();
  for (const part of parts) {
    for (const [key, fact] of part.facts.groups?.[field] || []) {
      const row = groups.get(key) || {
        key,
        count: 0,
        sessions: new Map(),
        total: emptyUsage(),
        order: fact.order,
        names: new Set(),
        paths: new Set(),
        kind: fact.kind,
      };
      row.order = mergeOrder(row.order, fact.order);
      mergeSessions(row.sessions, fact.sessions);
      if (fact.kind && row.order === fact.order) row.kind = fact.kind;
      if (field === 'repositories') {
        const repository = part.facts.repositories?.get(key);
        if (repository?.kind && (!row.kind || row.order === repository.order)) row.kind = repository.kind;
        for (const path of repository?.paths || []) row.paths.add(path);
      }
      groups.set(key, row);
    }
    for (const source of part.projection.summary[field] || []) {
      const row = groups.get(source.key) || {
        key: source.key,
        count: 0,
        sessions: new Map(),
        total: emptyUsage(),
        order: null,
        names: new Set(),
        paths: new Set(),
        kind: source.kind,
      };
      row.count += source.count;
      addUsage(row.total, source.total);
      row.names.add(source.name);
      if (source.kind && !row.kind) row.kind = source.kind;
      groups.set(source.key, row);
    }
  }

  return [...groups.values()]
    .map((group) => {
      const name = group.names.size
        ? [...group.names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))[0]
        : group.key;
      const common = {
        key: group.key,
        name,
        count: group.count,
        sessions: group.sessions.size,
        total: group.total,
      };
      if (field !== 'repositories') return { ...common, order: group.order };
      return {
        ...common,
        order: group.order,
        pathCount: group.paths.size,
        sessionIds: [...group.sessions].sort((left, right) => compareOrder(left[1], right[1])).map(([id]) => id),
        kind: group.kind || 'directory',
      };
    })
    .map(({ order, ...row }) => ({ row, order }))
    .sort((left, right) => {
      const total = right.row.total.total - left.row.total.total;
      if (total) return total;
      if (field === 'repositories') return left.row.name < right.row.name ? -1 : left.row.name > right.row.name ? 1 : 0;
      return compareOrder(left.order, right.order) || left.row.name.localeCompare(right.row.name);
    })
    .map(({ row }) => row);
}

function mergeSegmentFacts(target, source) {
  for (const [key, fact] of source || []) {
    const current = target.get(key) || {
      key,
      count: 0,
      sessions: new Map(),
      total: emptyUsage(),
      order: fact.order,
    };
    current.order = mergeOrder(current.order, fact.order);
    mergeSessions(current.sessions, fact.sessions);
    target.set(key, current);
  }
}

function materializeSegments(segments) {
  return [...segments.values()]
    .map(({ order, ...segment }) => ({
      key: segment.key,
      name: segment.key,
      count: segment.count,
      sessions: segment.sessions.size,
      total: segment.total,
    }))
    .sort((left, right) => right.total.total - left.total.total || left.name.localeCompare(right.name));
}

function timelinePricingStatus(tokens, estimated, sawUnknown) {
  if (!estimated) return 'unavailable';
  if (tokens.unpricedTokens > 0) return tokens.pricedTokens > 0 ? 'partial' : 'unpriced';
  if (tokens.minimumEstimatedTokens > 0) return 'minimum-estimate';
  return sawUnknown ? 'unknown' : 'estimated';
}

function mergeTimeline(parts, range, bucket) {
  const rows = new Map();
  for (const part of parts) {
    const timelineFacts = part.facts.timeline || new Map();
    for (const [key, fact] of timelineFacts) {
      const current = rows.get(key) || {
        key,
        count: 0,
        sessions: new Map(),
        total: emptyUsage(),
        channels: new Map(),
        models: new Map(),
        costs: new Map(),
        tokenCoverage: {
          pricedTokens: 0,
          unpricedTokens: 0,
          minimumEstimatedTokens: 0,
          serviceTierUnknownTokens: 0,
          contextUnknownTokens: 0,
          cacheWriteUnknownTokens: 0,
        },
        estimated: false,
        sawUnknown: false,
        scenarioReasons: new Set(),
      };
      mergeSessions(current.sessions, fact.sessions);
      mergeSegmentFacts(current.channels, fact.channels);
      mergeSegmentFacts(current.models, fact.models);
      rows.set(key, current);
    }

    for (const source of part.projection.summary.timeline || []) {
      const hasData =
        source.count > 0 ||
        source.sessions > 0 ||
        source.total.total > 0 ||
        Object.keys(source.costByModel || {}).length > 0;
      if (!hasData) continue;
      const current = rows.get(source.key) || {
        key: source.key,
        count: 0,
        sessions: new Map(),
        total: emptyUsage(),
        channels: new Map(),
        models: new Map(),
        costs: new Map(),
        tokenCoverage: {
          pricedTokens: 0,
          unpricedTokens: 0,
          minimumEstimatedTokens: 0,
          serviceTierUnknownTokens: 0,
          contextUnknownTokens: 0,
          cacheWriteUnknownTokens: 0,
        },
        estimated: false,
        sawUnknown: false,
        scenarioReasons: new Set(),
      };
      current.count += source.count;
      addUsage(current.total, source.total);
      for (const [group, field] of [
        [current.channels, source.channels],
        [current.models, source.models],
      ]) {
        for (const segment of field || []) {
          const target = group.get(segment.key) || {
            key: segment.key,
            count: 0,
            sessions: new Map(),
            total: emptyUsage(),
            order: null,
          };
          target.count += segment.count;
          addUsage(target.total, segment.total);
          group.set(segment.key, target);
        }
      }
      for (const field of Object.keys(current.tokenCoverage)) {
        current.tokenCoverage[field] += Number(source[field] || 0);
      }
      for (const [key, sourceCost] of Object.entries(source.costByModel || {})) {
        const model = sourceCost.model || key.split('\u0000')[0];
        const currency = sourceCost.currency || 'USD';
        const costKey = `${model}\u0000${currency}`;
        const cost = current.costs.get(costKey) || {
          model,
          currency,
          records: 0,
          statuses: new Set(),
        };
        for (const field of TIMELINE_COST_FIELDS) cost[field] = Number(cost[field] || 0) + Number(sourceCost[field] || 0);
        cost.records += 1;
        if (sourceCost.pricingStatus) cost.statuses.add(sourceCost.pricingStatus);
        current.costs.set(costKey, cost);
      }
      current.estimated ||= source.pricingStatus !== 'no-data' && source.pricingStatus !== 'unavailable';
      current.sawUnknown ||= source.pricingStatus === 'unknown';
      for (const reason of source.scenarioReasons || []) current.scenarioReasons.add(reason);
      rows.set(source.key, current);
    }
  }

  const baseRows = buildTimelineRows([], range, bucket);
  const baseByKey = new Map(baseRows.map((row) => [row.key, row]));
  const keys = new Set([...baseByKey.keys(), ...rows.keys()]);
  return [...keys]
    .map((key) => {
      const base = baseByKey.get(key) || {
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
        pricingStatus: 'no-data',
      };
      const merged = rows.get(key);
      if (!merged) return base;

      const currenciesByModel = new Map();
      for (const cost of merged.costs.values()) {
        const currencies = currenciesByModel.get(cost.model) || new Set();
        currencies.add(cost.currency);
        currenciesByModel.set(cost.model, currencies);
      }
      const costByModel = Object.fromEntries(
        [...merged.costs.values()]
          .sort((left, right) => left.model.localeCompare(right.model) || left.currency.localeCompare(right.currency))
          .map((cost) => {
            const mixed = currenciesByModel.get(cost.model).size > 1;
            return [
              mixed ? `${cost.model}\u0000${cost.currency}` : cost.model,
              {
                ...(mixed ? { model: cost.model } : {}),
                totalUsd: cost.totalUsd,
                currency: cost.currency,
                pricedTokens: cost.pricedTokens,
                unpricedTokens: cost.unpricedTokens,
                minimumEstimatedTokens: cost.minimumEstimatedTokens,
                serviceTierUnknownTokens: cost.serviceTierUnknownTokens,
                contextUnknownTokens: cost.contextUnknownTokens,
                cacheWriteUnknownTokens: cost.cacheWriteUnknownTokens,
                pricingStatus:
                  cost.unpricedTokens > 0
                    ? cost.pricedTokens > 0
                      ? 'partial'
                      : 'unpriced'
                    : cost.minimumEstimatedTokens > 0
                      ? 'minimum-estimate'
                      : 'estimated',
              },
            ];
          }),
      );
      return {
        ...base,
        count: merged.count,
        sessions: merged.sessions.size,
        total: merged.total,
        channels: materializeSegments(merged.channels),
        models: materializeSegments(merged.models),
        costByModel,
        ...merged.tokenCoverage,
        ...(merged.scenarioReasons.size ? { scenarioReasons: [...merged.scenarioReasons].sort() } : {}),
        pricingStatus: timelinePricingStatus(merged.tokenCoverage, merged.estimated, merged.sawUnknown),
      };
    })
    .sort((left, right) =>
      left.slotStartMs !== undefined && right.slotStartMs !== undefined
        ? left.slotStartMs - right.slotStartMs
        : left.key.localeCompare(right.key),
    );
}

function mergeCostEstimate(parts, pricingCatalog) {
  const cost = runWithPricingCatalog(pricingCatalog, () => createCostEstimateAccumulator().result());
  const currencies = new Set();
  const arrays = Object.fromEntries(COST_ARRAY_FIELDS.map((field) => [field, new Set()]));
  const cacheRate = { input: 0, cached: 0 };
  const models = new Set();
  let first;

  for (const part of parts) {
    const source = part.projection.summary.costEstimate;
    first ||= source;
    for (const currency of source.currencies || []) currencies.add(currency);
    for (const field of COST_INTEGER_FIELDS) cost[field] += Number(source[field] || 0);
    for (const field of COST_ARRAY_FIELDS) {
      for (const value of source[field] || []) arrays[field].add(value);
    }
    cacheRate.input += Number(part.facts.cacheRateInput || 0);
    cacheRate.cached += Number(part.facts.cacheRateCached || 0);
    for (const model of part.facts.priceModels || []) models.add(model);
  }

  for (const field of COST_USD_FIELDS) {
    cost[field] = currencies.has('USD')
      ? parts.reduce((sum, part) => sum + Number(part.projection.summary.costEstimate[field] || 0), 0)
      : null;
  }
  for (const field of COST_CNY_FIELDS) {
    cost[field] = currencies.has('CNY')
      ? parts.reduce((sum, part) => sum + Number(part.projection.summary.costEstimate[field] || 0), 0)
      : null;
  }
  cost.currencies = ['USD', 'CNY'].filter((currency) => currencies.has(currency));
  cost.cacheHitRate = cacheRate.input > 0 ? cacheRate.cached / cacheRate.input : null;
  cost.modelCount = models.size;
  for (const field of COST_ARRAY_FIELDS) {
    cost[field] = [...arrays[field]].sort(
      COST_LOCALE_ARRAY_FIELDS.has(field) ? (left, right) => left.localeCompare(right) : undefined,
    );
  }
  cost.priceSource = cost.priceSources.length === 1 ? cost.priceSources[0] : '';
  cost.usdToCnyRate = pricingCatalog.usdToCnyRate ?? first?.usdToCnyRate ?? cost.usdToCnyRate;
  cost.priceCheckedAt = pricingCatalog.checkedAt ?? first?.priceCheckedAt ?? cost.priceCheckedAt;
  if (first?.priceMode) cost.priceMode = first.priceMode;
  return cost;
}

function addPeriodMetrics(target, source) {
  for (const field of PERIOD_METRIC_FIELDS) target[field] += Number(source?.[field] || 0);
}

function mergePeriodComparison(parts, options) {
  const totals = Object.fromEntries(COMPARISON_PERIOD_KEYS.map((key) => [key, emptyPeriodMetrics()]));
  const rows = {
    models: new Map(),
    repositories: new Map(),
  };

  for (const part of parts) {
    const comparison = part.projection.periodComparison;
    for (const key of COMPARISON_PERIOD_KEYS) addPeriodMetrics(totals[key], comparison?.totals?.[key]);
    for (const field of ['models', 'repositories']) {
      for (const source of comparison?.[field] || []) {
        const row = rows[field].get(source.key) || {
          key: source.key,
          names: new Set(),
          periods: Object.fromEntries(COMPARISON_PERIOD_KEYS.map((key) => [key, emptyPeriodMetrics()])),
          order: null,
          paths: new Set(),
          kind: source.kind,
        };
        row.names.add(source.name);
        for (const key of COMPARISON_PERIOD_KEYS) addPeriodMetrics(row.periods[key], source.periods?.[key]);
        if (field === 'repositories') {
          const repository = part.facts.periodRepositories?.get(source.key);
          row.order = mergeOrder(row.order, repository?.order);
          if (repository?.order && row.order === repository.order) row.kind = repository.kind;
          for (const path of repository?.paths || []) row.paths.add(path);
        }
        rows[field].set(source.key, row);
      }
    }
  }

  const sorted = (field) =>
    [...rows[field].values()]
      .map((row) => {
        const name = [...row.names].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))[0] || row.key;
        const result = { key: row.key, name, periods: row.periods };
        if (field === 'repositories') {
          result.kind = row.kind || 'directory';
          result.pathCount = row.paths.size;
        }
        return result;
      })
      .sort((left, right) => right.periods.all.total - left.periods.all.total || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

  const zone = options.range.calendarZone === 'utc' ? 'utc' : 'local';
  const ranges = Object.fromEntries(
    ['today', 'week', 'month'].map((key) => [key, calendarPresetRange(key, options.now, zone)]),
  );
  const allTimestamps = parts
    .flatMap((part) => part.projection.periodComparison?.periods || [])
    .filter((period) => period.key === 'all')
    .flatMap((period) => [Date.parse(period.start), Date.parse(period.end)])
    .filter(Number.isFinite);
  ranges.all = calendarPresetRange('all', options.now, zone, allTimestamps);

  return {
    asOf: options.now.toISOString(),
    periods: COMPARISON_PERIOD_KEYS.map((key) => ({
      key,
      start: ranges[key].start?.toISOString() || null,
      end: ranges[key].end?.toISOString() || null,
    })),
    totals,
    models: sorted('models'),
    repositories: sorted('repositories'),
  };
}

function mergeMetadata(parts, context) {
  const sessions = new Set();
  const homes = new Map();
  let eventCount = 0;
  for (const part of parts) {
    eventCount += Number(part.projection.metadata.eventCount || 0);
    for (const sessionId of part.facts.metadataSessions || []) sessions.add(sessionId);
    for (const [homeId, source] of part.facts.metadataHomes || []) {
      const target = homes.get(homeId) || { count: 0, sessions: new Set() };
      target.count += Number(source.count || 0);
      for (const sessionId of source.sessions || []) target.sessions.add(sessionId);
      homes.set(homeId, target);
    }
  }
  const contextHomes = context.homes || [];
  return {
    generatedAt: context.generatedAt,
    eventCount,
    sessionCount: sessions.size,
    homeCount: contextHomes.length,
    warnings: context.warnings || [],
    homes: contextHomes.map((home) => {
      const stat = homes.get(String(home.id ?? home.homeId ?? '')) || { count: 0, sessions: new Set() };
      return {
        ...home,
        status: stat.count ? 'active' : 'no-events',
        eventCount: stat.count,
        sessionCount: stat.sessions.size,
      };
    }),
  };
}

/**
 * Merge source-local product projections using precomputed identity facts.
 * This function deliberately never receives or scans raw usage events.
 */
export function mergeBusinessParts(parts, options) {
  const context = options.context || {};
  const totals = emptyUsage();
  const previousTotals = emptyUsage();
  const currentSessions = new Map();
  const previousSessions = new Map();
  const selectedHomes = new Set();
  let eventCount = 0;
  let previousEventCount = 0;

  for (const part of parts) {
    addUsage(totals, part.projection.summary.totals);
    addUsage(previousTotals, part.projection.summary.comparison?.previousTotals);
    mergeSessions(currentSessions, part.facts.sessions);
    mergeSessions(previousSessions, part.facts.previousSessions);
    for (const homeId of part.facts.selectedHomes || []) selectedHomes.add(homeId);
    eventCount += part.projection.summary.eventCount;
    previousEventCount += part.projection.summary.comparison?.previousEventCount || 0;
  }

  const comparison = usageComparisonFromAggregates({
    range: options.range,
    currentTotals: totals,
    previousTotals,
    previousEventCount,
    previousSessionCount: previousSessions.size,
    now: options.now,
    previousRange: previousUsageRange(options.range),
  });

  const summary = {
    generatedAt: context.generatedAt || options.now.toISOString(),
    range: {
      preset: options.range.preset,
      start: options.range.start ? options.range.start.toISOString() : null,
      end: options.range.end ? options.range.end.toISOString() : null,
      bucket: options.bucket,
      calendarZone: options.range.calendarZone || 'local',
      rolling: false,
    },
    totals,
    comparison,
    quota: options.quota,
    costEstimate: mergeCostEstimate(parts, options.pricingCatalog),
    eventCount,
    sessionCount: currentSessions.size,
    homeCount: selectedHomes.size,
    timeline: mergeTimeline(parts, options.range, options.bucket),
    timelineError: parts.find((part) => part.projection.summary.timelineError)?.projection.summary.timelineError || null,
    channels: mergeSummaryGroups(parts, 'channels'),
    homes: mergeSummaryGroups(parts, 'homes'),
    models: mergeSummaryGroups(parts, 'models'),
    projects: mergeSummaryGroups(parts, 'projects'),
    repositories: mergeSummaryGroups(parts, 'repositories'),
  };

  return {
    summary,
    metadata: mergeMetadata(parts, context),
    pricingCatalog: options.pricingCatalog,
    quota: summary.quota,
    periodComparison: mergePeriodComparison(parts, options),
  };
}
