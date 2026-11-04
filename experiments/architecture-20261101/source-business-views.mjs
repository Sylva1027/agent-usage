import { createHash } from 'node:crypto';
import { productProjection } from './compat.mjs';
import { mergeBusinessParts } from './business-merge.mjs';
import { resolveDateRange, previousUsageRange, selectQuotaWindows, QUOTA_PERCENT_STALE_AFTER_MS } from '../../src/usage-core.js';
import { getPricingCatalog, estimateEventCost, runWithPricingCatalog } from '../../src/pricing.js';
import { canonicalModelName } from '../../public/pricing-models.js';
import { homeSourceKinds, channelForRange, deriveTimelineBucket, timelineBucketKey } from '../../public/timeline-utils.js';
import { startOfLocalDay } from '../../public/period-comparison.js';
import { refreshSummaryClock } from '../../src/usage-summary-cache.js';

const GROUPS = ['channels', 'homes', 'models', 'projects', 'repositories'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compareOrder = (a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]);
function first(map, key, order) { const previous = map.get(key); if (!previous || compareOrder(order, previous) < 0) map.set(key, order); }
function group(map, key, event, order) {
  let entry = map.get(key);
  if (!entry) { entry = { order, sessions: new Map() }; map.set(key, entry); }
  if (compareOrder(order, entry.order) < 0) entry.order = order;
  first(entry.sessions, event.sessionId, order);
}
function repository(map, event, order) {
  const key = event.repositoryKey || `directory:${event.cwd || 'Unknown cwd'}`;
  let entry = map.get(key);
  if (!entry) { entry = { paths: new Set(), order, kind: event.repositoryKind || 'directory' }; map.set(key, entry); }
  if (compareOrder(order, entry.order) < 0) { entry.order = order; entry.kind = event.repositoryKind || 'directory'; }
  if (event.cwd) entry.paths.add(event.cwd);
}
function inRange(timestamp, range) { return Number.isFinite(timestamp) && (!range?.start || timestamp >= range.start.getTime()) && (!range?.end || timestamp <= range.end.getTime()); }
function upperBound(values, target) { let lo = 0, hi = values.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (values[mid] <= target) lo = mid + 1; else hi = mid; } return lo; }
function dayKey(now, zone) { return startOfLocalDay(now, zone).toISOString(); }

export class SourceBusinessViews {
  constructor() {
    this.bases = new WeakMap();
    this.contexts = new WeakMap();
    this.parts = new WeakMap();
    this.views = new Map();
    this.contextId = 0;
    this.stats = { sourcePreparations: 0, preparedEvents: 0, partBuilds: 0, partEvents: 0, partHits: 0, viewHits: 0, viewBuilds: 0, fallbacks: 0 };
  }

  base(sourceId, events) {
    let base = this.bases.get(events);
    if (base) return base;
    const metadataSessions = new Set(), metadataHomes = new Map();
    const entries = events.map(event => {
      metadataSessions.add(event.sessionId);
      let home = metadataHomes.get(event.homeId);
      if (!home) { home = { count: 0, sessions: new Set() }; metadataHomes.set(event.homeId, home); }
      home.count++; home.sessions.add(event.sessionId);
      return { event, timestamp: Date.parse(event.timestamp), order: [event.timestamp, sourceId, event.eventId] };
    }).sort((a, b) => compareOrder(a.order, b.order));
    const times = entries.map(row => row.timestamp).filter(Number.isFinite).sort((a, b) => a - b);
    base = { entries, times, metadataSessions, metadataHomes, estimates: new Map() };
    this.bases.set(events, base);
    this.stats.sourcePreparations++; this.stats.preparedEvents += events.length;
    return base;
  }

  context(context) {
    let entry = this.contexts.get(context);
    if (entry) return entry;
    const deadlines = [];
    for (const observation of context.rateLimitObservations || []) {
      const observed = Number(observation.observedAtMs ?? observation.observed_at_ms);
      const reset = Number(observation.resetsAtMs ?? observation.resets_at_ms);
      const duration = Number(observation.windowMinutes ?? observation.window_minutes) * 60_000;
      for (const time of [observed, observed + QUOTA_PERCENT_STALE_AFTER_MS, reset, reset - duration]) if (Number.isFinite(time)) deadlines.push(time);
    }
    deadlines.sort((a, b) => a - b);
    entry = { id: ++this.contextId, deadlines, quotaEpoch: null, quota: null };
    this.contexts.set(context, entry);
    return entry;
  }

  quota(context, info, now) {
    const epoch = upperBound(info.deadlines, now.getTime());
    if (info.quotaEpoch !== epoch) {
      info.quota = selectQuotaWindows(context.rateLimitObservations || [], now);
      info.quotaEpoch = epoch;
    }
    const quota = structuredClone(info.quota);
    quota.asOf = now.toISOString();
    for (const window of Object.values(quota.windows || {})) if (window.state === 'available') window.percentStale = now.getTime() - Date.parse(window.observedAt) > QUOTA_PERCENT_STALE_AFTER_MS;
    return { quota, epoch };
  }

  materialize(carrier) {
    const entries = [];
    for (const [sourceId, source] of carrier.sources) for (const entry of this.base(sourceId, source.events).entries) entries.push(entry);
    entries.sort((a, b) => compareOrder(a.order, b.order));
    return { ...carrier, events: entries.map(row => row.event) };
  }

  part(sourceId, events, context, filters, range, bucket, catalog, catalogKey, key) {
    let cache = this.parts.get(events);
    if (!cache) { cache = new Map(); this.parts.set(events, cache); }
    if (cache.has(key)) { this.stats.partHits++; return cache.get(key); }
    const base = this.base(sourceId, events);
    const ordered = base.entries.map(row => row.event);
    const projection = productProjection({ events: ordered, context }, { ...filters, bucket, pricingCatalog: catalog });
    const excluded = new Set(filters.excludeHomes || []), kinds = homeSourceKinds(context.homes || []);
    const previousRange = previousUsageRange(range);
    const facts = { sessions: new Map(), previousSessions: new Map(), groups: Object.fromEntries(GROUPS.map(k => [k, new Map()])),
      repositories: new Map(), timeline: new Map(), metadataSessions: base.metadataSessions, metadataHomes: base.metadataHomes,
      periodRepositories: new Map(), selectedHomes: new Set(), priceModels: new Set(), cacheRateInput: 0, cacheRateCached: 0 };
    let estimates = base.estimates.get(catalogKey);
    if (!estimates) { estimates = new WeakMap(); base.estimates.clear(); base.estimates.set(catalogKey, estimates); }
    runWithPricingCatalog(catalog, () => {
      for (const { event, timestamp, order } of base.entries) {
        if (excluded.has(event.homeId) || !Number.isFinite(timestamp)) continue;
        repository(facts.periodRepositories, event, order);
        if (previousRange && inRange(timestamp, previousRange)) first(facts.previousSessions, event.sessionId, order);
        if (!inRange(timestamp, range)) continue;
        first(facts.sessions, event.sessionId, order); facts.selectedHomes.add(event.homeId);
        const keys = { channels: channelForRange(event.channel, range, kinds.get(String(event.homeId))), homes: event.homeLabel,
          models: canonicalModelName(event.model || 'Unknown model', catalog.models), projects: event.cwd || 'Unknown cwd', repositories: event.repositoryKey || `directory:${event.cwd || 'Unknown cwd'}` };
        for (const name of GROUPS) group(facts.groups[name], keys[name], event, order);
        repository(facts.repositories, event, order);
        const slotKey = timelineBucketKey(event.timestamp, bucket, range.calendarZone);
        let slot = facts.timeline.get(slotKey);
        if (!slot) { slot = { sessions: new Map(), channels: new Map(), models: new Map() }; facts.timeline.set(slotKey, slot); }
        first(slot.sessions, event.sessionId || '', order);
        group(slot.channels, keys.channels, event, order); group(slot.models, keys.models, event, order);
        let estimate = estimates.get(event);
        if (!estimate) { estimate = estimateEventCost(event); estimates.set(event, estimate); }
        const model = canonicalModelName(estimate.model || 'Unknown model', catalog.models);
        if (model && model.toLocaleLowerCase() !== 'unknown model') facts.priceModels.add(model);
        facts.cacheRateInput += Number(estimate.cacheRateInput || 0); facts.cacheRateCached += Number(estimate.cacheRateCached || 0);
        const mask = Number.isInteger(event.detailMask) ? event.detailMask : 15;
        if ((mask & 3) === 3 && event.total.input > 0) { facts.cacheRateInput += event.total.input; facts.cacheRateCached += event.total.cached || 0; }
      }
    });
    const part = { sourceId, projection, facts };
    cache.set(key, part); if (cache.size > 24) cache.delete(cache.keys().next().value);
    this.stats.partBuilds++; this.stats.partEvents += events.length;
    return part;
  }

  project(carrier, filters, { asOf, pricingCatalog = getPricingCatalog(), snapshot = null } = {}) {
    const now = new Date(asOf), context = carrier.context || {};
    const info = this.context(context), { quota, epoch } = this.quota(context, info, now);
    const bounds = [];
    for (const [sourceId, source] of carrier.sources) { const base = this.base(sourceId, source.events); if (base.times.length) bounds.push({ timestamp: new Date(base.times[0]).toISOString() }, { timestamp: new Date(base.times.at(-1)).toISOString() }); }
    const range = resolveDateRange({ ...filters, quota, now }, bounds);
    if (range.rolling || range.quotaWindow || !['all', 'today', 'week', 'month', 'custom'].includes(range.preset)) {
      this.stats.fallbacks++;
      return productProjection(this.materialize(carrier), { ...filters, now, pricingCatalog });
    }
    const bucket = deriveTimelineBucket(range, filters.bucket || 'day');
    const shape = { preset: range.preset, bucket, calendarZone: range.calendarZone || 'local',
      excludeHomes: [...new Set((filters.excludeHomes || []).map(String))].sort(),
      ...(range.preset === 'custom' ? { startDate: filters.startDate, endDate: filters.endDate } : {}) };
    const catalogKey = digest(pricingCatalog);
    const key = digest({ shape, context: info.id, catalogKey, day: dayKey(now, range.calendarZone), epoch });
    const viewKey = `${snapshot ?? 'live'}:${carrier.revision}:${key}`;
    if (this.views.has(viewKey)) {
      this.stats.viewHits++;
      const result = structuredClone(this.views.get(viewKey));
      if (snapshot === null) {
        const keys = new Set(Object.keys(result.metadata)); refreshSummaryClock(result, now);
        for (const key of Object.keys(result.metadata)) if (!keys.has(key)) delete result.metadata[key];
        if (!context.generatedAt) { result.summary.generatedAt = now.toISOString(); result.metadata.generatedAt = now.toISOString(); }
      }
      return result;
    }
    const parts = [];
    for (const [sourceId, source] of carrier.sources) parts.push(this.part(sourceId, source.events, context,
      { ...shape, now, quota }, range, bucket, pricingCatalog, catalogKey, key));
    const result = mergeBusinessParts(parts, { context, pricingCatalog, now, range, bucket, quota });
    result.metadata.generatedAt = result.summary.generatedAt;
    this.stats.viewBuilds++;
    this.views.set(viewKey, structuredClone(result)); if (this.views.size > 32) this.views.delete(this.views.keys().next().value);
    return result;
  }
}
