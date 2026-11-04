import { summarizeUsage } from '../../src/usage-core.js';
import { summarizePeriodComparison } from '../../public/period-comparison.js';
import { getPricingCatalog, runWithPricingCatalog } from '../../src/pricing.js';

// Reuse the current business formulas; this layer is explicitly included in full-page measurements.
export function productProjection(carrier, filters = {}) {
  const context = carrier.context || {};
  const now = new Date(filters.now || context.generatedAt || Date.now());
  const pricingCatalog = filters.pricingCatalog || getPricingCatalog();
  const report = { ...context, generatedAt: context.generatedAt || now.toISOString(), events: carrier.events,
    homes: context.homes || [], sessions: context.sessions || [], warnings: context.warnings || [],
    rateLimitObservations: context.rateLimitObservations || [] };
  return runWithPricingCatalog(pricingCatalog, () => {
    const summary = summarizeUsage(report, { ...filters, now });
    const excluded = new Set(filters.excludeHomes || []);
    const metadata = { generatedAt: report.generatedAt, eventCount: report.events.length,
      sessionCount: new Set(report.events.map(event => event.sessionId)).size,
      homeCount: report.homes.length, warnings: report.warnings,
      homes: report.homes.map(home => {
        const events = report.events.filter(event => event.homeId === home.id);
        return { ...home, status: events.length ? 'active' : 'no-events', eventCount: events.length,
          sessionCount: new Set(events.map(event => event.sessionId)).size };
      }) };
    return { summary, metadata, pricingCatalog, quota: summary.quota,
      periodComparison: summarizePeriodComparison(report.events.filter(event => !excluded.has(event.homeId)), { now, calendarZone: filters.calendarZone, pricingModels: pricingCatalog.models }) };
  });
}

/** Map the already-resolved product range onto the narrow backend query. */
export function backendQueryForProjection(projected, filters = {}) {
  const range = projected.summary.range;
  if (range.quotaWindow) return null;
  const query = new URLSearchParams();
  if (range.start) query.set('start', range.start);
  if (range.end) query.set('end', range.end);
  const excludeHomes = [...new Set(filters.excludeHomes || [])].sort();
  if (excludeHomes.length) query.set('excludeHomes', excludeHomes.join(','));
  return query;
}

/** Replace only the four fields owned by the backend aggregate contract. */
export function applyBackendAggregates(projected, aggregate) {
  for (const field of ['eventCount', 'sessionCount', 'homeCount']) {
    if (!Number.isSafeInteger(aggregate?.[field]) || aggregate[field] < 0) {
      throw new TypeError(`Backend query ${field} must be a non-negative safe integer`);
    }
  }
  if (!aggregate?.totals || typeof aggregate.totals !== 'object') {
    throw new TypeError('Backend query totals are missing');
  }
  const totals = {};
  for (const field of ['total', 'input', 'cached', 'output', 'reasoning']) {
    if (!Number.isSafeInteger(aggregate.totals[field]) || aggregate.totals[field] < 0) {
      throw new TypeError(`Backend query totals.${field} must be a non-negative safe integer`);
    }
    totals[field] = aggregate.totals[field];
  }
  return {
    ...projected,
    summary: {
      ...projected.summary,
      totals,
      eventCount: aggregate.eventCount,
      sessionCount: aggregate.sessionCount,
      homeCount: aggregate.homeCount,
    },
  };
}
