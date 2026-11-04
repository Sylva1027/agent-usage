import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { startOfLocalDay } from '../../public/period-comparison.js';
import { QUOTA_PERCENT_STALE_AFTER_MS } from '../../src/usage-core.js';
import { refreshSummaryClock } from '../../src/usage-summary-cache.js';
import { productProjection } from './compat.mjs';
import { SourceBusinessViews } from './source-business-views.mjs';

export const PROJECTION_CACHE_VERSION = 1;
const CACHE_LIMIT = 64;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function eventOrder(left, right, leftSourceId, rightSourceId) {
  return left.timestamp.localeCompare(right.timestamp)
    || leftSourceId.localeCompare(rightSourceId)
    || left.eventId.localeCompare(right.eventId);
}

function nextCalendarDay(now, calendarZone) {
  const next = startOfLocalDay(now, calendarZone);
  if (calendarZone === 'utc') next.setUTCDate(next.getUTCDate() + 1);
  else next.setDate(next.getDate() + 1);
  return next.getTime();
}

function observationNumber(observation, camel, snake) {
  return Number(observation?.[camel] ?? observation?.[snake]);
}

function projectionValidUntil(carrier, filters, now) {
  const nowMs = now.getTime();
  let validUntil = nextCalendarDay(now, filters.calendarZone === 'utc' ? 'utc' : 'local');
  const afterNow = value => {
    if (Number.isFinite(value) && value > nowMs && value < validUntil) validUntil = value;
  };

  for (const event of carrier.events) {
    afterNow(Date.parse(event.timestamp));
  }
  for (const observation of carrier.context.rateLimitObservations || []) {
    const observedAt = observationNumber(observation, 'observedAtMs', 'observed_at_ms');
    const resetAt = observationNumber(observation, 'resetsAtMs', 'resets_at_ms');
    const windowMinutes = Number(observation.windowMinutes ?? observation.window_minutes);
    afterNow(observedAt);
    afterNow(observedAt + QUOTA_PERCENT_STALE_AFTER_MS);
    afterNow(resetAt);
    if (Number.isFinite(windowMinutes) && windowMinutes > 0) afterNow(resetAt - windowMinutes * 60_000);
  }
  return validUntil;
}

function refreshCachedClock(projected, now) {
  const metadataKeys = new Set(Object.keys(projected.metadata || {}));
  refreshSummaryClock(projected, now);
  for (const key of Object.keys(projected.metadata || {})) {
    if (!metadataKeys.has(key)) delete projected.metadata[key];
  }
  return projected;
}

function requestResult(result) {
  if (result && Object.hasOwn(result, 'value')) return result;
  return { value: result, bytes: Buffer.byteLength(JSON.stringify(result)) };
}

function newState(snapshot) {
  return {
    snapshot,
    revision: null,
    sources: new Map(),
    context: {},
    carrier: null,
    loading: null,
  };
}

export class ProductPublisher {
  constructor({ request, project = productProjection } = {}) {
    if (typeof request !== 'function') throw new TypeError('ProductPublisher request must be a function');
    this.request = request;
    this.project = project;
    this.businessViews = new SourceBusinessViews();
    this.live = newState(null);
    // shortcut: frozen carriers live for this prototype process; bound retention before production.
    this.snapshots = new Map();
    this.cache = new Map();
    this.counters = {
      feedRequests: 0,
      feedBytes: 0,
      feedUpdates: 0,
      probeRequests: 0,
      probeBytes: 0,
      projectionRequests: 0,
      projectionCacheHits: 0,
      projectionCacheMisses: 0,
      projectionMs: 0,
      queryRequests: 0,
      queryMs: 0,
      responses: 0,
      responseBytes: 0,
    };
  }

  state(snapshot = null) {
    if (snapshot === null) return this.live;
    const key = String(snapshot);
    let state = this.snapshots.get(key);
    if (!state) {
      state = newState(key);
      this.snapshots.set(key, state);
    }
    return state;
  }

  async sync(snapshot = null) {
    const state = this.state(snapshot);
    if (state.snapshot !== null && state.revision !== null) return state;
    if (!state.loading) {
      state.loading = this.#sync(state).finally(() => {
        state.loading = null;
      });
    }
    return state.loading;
  }

  async #fetchChanges(route) {
    const result = requestResult(await this.request(route));
    this.counters.feedRequests += 1;
    this.counters.feedBytes += Number(result.bytes) || 0;
    return result.value;
  }

  async #probeRevision() {
    const result = requestResult(await this.request('/api/status'));
    this.counters.probeRequests += 1;
    this.counters.probeBytes += Number(result.bytes) || 0;
    const revision = result.value?.revision;
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new TypeError('Status revision must be a non-negative safe integer');
    }
    return revision;
  }

  async #sync(state) {
    let since = state.snapshot === null ? state.revision : null;
    if (state.snapshot === null && since !== null) {
      const liveRevision = await this.#probeRevision();
      if (liveRevision === since) return state;
      if (liveRevision < since) since = null;
    }
    const query = state.snapshot === null
      ? since === null ? '' : `?since=${since}&contextSince=${since}`
      : `?snapshot=${encodeURIComponent(state.snapshot)}`;
    let payload = await this.#fetchChanges(`/api/changes${query}`);
    if (since !== null && payload?.reset !== true && Number(payload?.revision) < since) {
      payload = await this.#fetchChanges('/api/changes');
    }
    if (!Number.isSafeInteger(payload?.revision) || payload.revision < 0) {
      throw new TypeError('Feed revision must be a non-negative safe integer');
    }
    if (!Array.isArray(payload.sources)) throw new TypeError('Feed sources must be an array');

    const replace = state.snapshot !== null || state.revision === null || payload.reset === true || since === null;
    const revisionChanged = state.revision !== payload.revision;
    const factsChanged = replace || payload.sources.length > 0 || revisionChanged;
    if (!factsChanged) {
      // The feed contract binds context to revision, so an empty warm delta leaves facts untouched.
      state.revision = payload.revision;
      return state;
    }
    const nextSources = replace ? new Map() : new Map(state.sources);
    const seen = new Set();
    for (const source of payload.sources) {
      if (typeof source?.sourceId !== 'string' || !source.sourceId) {
        throw new TypeError('Feed sourceId must be a non-empty string');
      }
      if (seen.has(source.sourceId)) throw new TypeError(`Feed repeated sourceId ${source.sourceId}`);
      if (!Array.isArray(source.events)) throw new TypeError(`Feed source ${source.sourceId} events must be an array`);
      seen.add(source.sourceId);
      nextSources.set(source.sourceId, {
        events: source.events,
        cursor: source.cursor,
      });
    }
    if (replace && payload.context === undefined) throw new TypeError('Full changes must include context');
    if (payload.context !== undefined) {
      if (payload.context !== null && (typeof payload.context !== 'object' || Array.isArray(payload.context))) {
        throw new TypeError('Feed context must be an object');
      }
      state.context = payload.context || {};
    }
    state.sources = nextSources;
    this.cache.clear();
    if (revisionChanged) {
      this.counters.feedUpdates += 1;
    }
    state.revision = payload.revision;
    state.carrier = null;
    return state;
  }

  carrier(snapshot = null) {
    const state = this.state(snapshot);
    if (state.revision === null) throw new Error('Published facts have not been loaded');
    if (state.carrier) return state.carrier;
    const events = [];
    for (const [sourceId, source] of state.sources) {
      for (const event of source.events) events.push({ sourceId, event });
    }
    events.sort((left, right) => eventOrder(left.event, right.event, left.sourceId, right.sourceId));
    state.carrier = {
      revision: state.revision,
      events: events.map(item => item.event),
      context: state.context,
    };
    return state.carrier;
  }

  sourceCarrier(snapshot = null) {
    const state = this.state(snapshot);
    if (state.revision === null) throw new Error('Published facts have not been loaded');
    return { revision: state.revision, context: state.context, sources: state.sources };
  }

  projectSources(carrier, filters, options) {
    const started = performance.now();
    this.counters.projectionRequests++;
    const result = this.businessViews.project(carrier, filters, options);
    this.counters.projectionMs += performance.now() - started;
    return result;
  }

  projectCarrier(carrier, filters, { asOf, pricingCatalog, snapshot = null, useCache = true } = {}) {
    const now = new Date(asOf);
    if (Number.isNaN(now.getTime())) throw new RangeError('Projection asOf must be a valid date');
    if (!pricingCatalog) throw new TypeError('Projection pricingCatalog is required');
    const shape = { ...filters };
    delete shape.now;
    delete shape.pricingCatalog;
    delete shape.pricingModels;
    const key = digest({
      version: PROJECTION_CACHE_VERSION,
      scope: snapshot === null ? 'live' : `snapshot:${snapshot}`,
      revision: carrier.revision,
      filters: shape,
      pricing: pricingCatalog,
    });
    const started = performance.now();
    this.counters.projectionRequests += 1;

    const cached = useCache ? this.cache.get(key) : null;
    if (cached && now.getTime() >= cached.createdAt && now.getTime() < cached.validUntil) {
      this.counters.projectionCacheHits += 1;
      const result = structuredClone(cached.value);
      if (snapshot === null && now.getTime() !== cached.asOf) refreshCachedClock(result, now);
      this.counters.projectionMs += performance.now() - started;
      return result;
    }

    this.counters.projectionCacheMisses += 1;
    const result = this.project(carrier, { ...filters, now, pricingCatalog });
    if (useCache) {
      let validUntil = Number.POSITIVE_INFINITY;
      if (snapshot === null) {
        validUntil = result.summary.range.rolling
          ? now.getTime()
          : projectionValidUntil(carrier, filters, now);
      }
      this.cache.set(key, {
        value: structuredClone(result),
        asOf: now.getTime(),
        createdAt: now.getTime(),
        validUntil,
      });
      if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
    }
    this.counters.projectionMs += performance.now() - started;
    return result;
  }

  recordQuery(durationMs) {
    this.counters.queryRequests += 1;
    this.counters.queryMs += durationMs;
  }

  recordResponse(bytes) {
    this.counters.responses += 1;
    this.counters.responseBytes += bytes;
  }

  diagnostics(mode) {
    return {
      mode,
      revision: this.live.revision,
      feed: {
        requests: this.counters.feedRequests,
        bytes: this.counters.feedBytes,
        updates: this.counters.feedUpdates,
      },
      probe: {
        requests: this.counters.probeRequests,
        bytes: this.counters.probeBytes,
      },
      projection: {
        requests: this.counters.projectionRequests,
        cacheHits: this.counters.projectionCacheHits,
        cacheMisses: this.counters.projectionCacheMisses,
        ms: this.counters.projectionMs,
        cacheEntries: this.cache.size,
        cacheVersion: PROJECTION_CACHE_VERSION,
        sourceViews: { ...this.businessViews.stats },
      },
      query: {
        requests: this.counters.queryRequests,
        ms: this.counters.queryMs,
      },
      response: {
        count: this.counters.responses,
        bytes: this.counters.responseBytes,
      },
    };
  }
}
