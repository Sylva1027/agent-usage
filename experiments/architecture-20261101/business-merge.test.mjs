import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalModelName } from '../../public/pricing-models.js';
import { deriveTimelineBucket, channelForRange, timelineBucketKey } from '../../public/timeline-utils.js';
import { getPricingCatalog } from '../../src/pricing.js';
import { previousUsageRange, resolveDateRange, selectQuotaWindows } from '../../src/usage-core.js';
import { productProjection } from './compat.mjs';
import { mergeBusinessParts } from './business-merge.mjs';

const NOW = new Date('2026-11-02T12:00:00.000Z');
const pricingCatalog = getPricingCatalog();

function usage(input, cached, output, reasoning = 0) {
  return { input, cached, output, reasoning, total: input + output };
}

function event(sourceId, homeId, homeLabel, sourceKind, eventId, timestamp, sessionId, model, cwd, options = {}) {
  return {
    sourceId,
    eventId,
    id: eventId,
    timestamp,
    sessionId,
    homeId,
    homeLabel,
    sourceKind,
    source: sourceKind,
    channel: options.channel || homeLabel,
    model,
    cwd,
    repositoryKey: options.repositoryKey || 'repo:shared',
    repositoryKind: options.repositoryKind || 'git',
    repositoryPath: options.repositoryPath || cwd,
    total: options.total || usage(100, 20, 10, 2),
    detailMask: 31,
    cacheWriteTokens: options.cacheWriteTokens || 0,
    cacheWriteKnown: true,
    requestInputTokens: options.total?.input || 100,
    contextLevel: 'short',
    serviceTier: 'default',
    priceVersion: 'current',
    quotaSource: 'plan',
  };
}

function fixture() {
  const homes = [
    { id: 'home-codex', label: 'Codex', kind: 'codex', path: '/fixture/codex' },
    { id: 'home-dsh', label: 'DSH', kind: 'dsh', path: '/fixture/dsh' },
    { id: 'home-zcode', label: 'ZCode', kind: 'zcode', path: '/fixture/zcode' },
    { id: 'home-claude', label: 'Claude', kind: 'claude', path: '/fixture/claude' },
    { id: 'home-empty', label: 'Empty', kind: 'custom', path: '/fixture/empty' },
  ];
  const context = {
    homes,
    sessions: [],
    warnings: ['fixture warning'],
    rateLimitObservations: [],
    generatedAt: NOW.toISOString(),
  };
  const events = [
    event('codex', 'home-codex', 'Codex', 'codex', 'e-codex-shared', '2026-11-01T10:00:00.000Z', 'session-shared', 'gpt-5.6', '/repo/codex-one', {
      channel: 'Codex Desktop',
      repositoryPath: 'D:/repos/shared',
      repositoryKind: 'git',
    }),
    event('dsh', 'home-dsh', 'DSH', 'dsh', 'e-dsh-shared', '2026-11-01T10:00:00.000Z', 'session-shared', 'routing-shared', '/repo/dsh-two', {
      channel: 'DSH Subagent',
      repositoryPath: 'D:/repos/shared',
      repositoryKind: 'workspace',
      total: usage(80, 10, 20, 3),
    }),
    event('codex', 'home-codex', 'Codex', 'codex', 'e-codex-routing', '2026-11-01T12:00:00.000Z', 'session-routing-usd', 'routing-shared', '/repo/codex-routing', {
      channel: 'CLI',
      repositoryPath: 'D:/repos/routing',
      total: usage(60, 5, 15, 1),
    }),
    event('zcode', 'home-zcode', 'ZCode', 'zcode', 'e-zcode', '2026-11-02T08:00:00.000Z', 'session-zcode', 'deepseek-v4.1-flash', '/repo/zcode-three', {
      channel: 'ZCode',
      repositoryPath: 'D:/repos/shared',
      total: usage(120, 30, 40, 4),
    }),
    event('codex', 'home-codex', 'Codex', 'codex', 'e-unknown-minimum', '2026-11-02T10:00:00.000Z', 'session-unknown-minimum', 'Unknown model', '/repo/unknown', {
      channel: 'CLI',
      repositoryKey: 'repo:unknown',
      repositoryPath: 'D:/repos/unknown',
    }),
    event('dsh', 'home-dsh', 'DSH', 'dsh', 'e-opencode-minimum', '2026-11-02T11:00:00.000Z', 'session-opencode-minimum', 'opencode-go/gemini-4-argon-contributor', '/repo/opencode', {
      channel: 'DSH',
      repositoryKey: 'repo:opencode',
      repositoryPath: 'D:/repos/opencode',
    }),
    event('claude', 'home-claude', 'Claude', 'claude', 'e-claude-excluded', '2026-11-02T09:00:00.000Z', 'session-claude', 'claude-sonnet-4', '/repo/claude-excluded', {
      channel: 'Claude',
      repositoryKey: 'repo:excluded',
      repositoryPath: 'D:/repos/excluded',
    }),
    event('codex', 'home-codex', 'Codex', 'codex', 'e-codex-prior-day', '2026-10-31T10:00:00.000Z', 'session-prior-day', 'codex-auto-review', '/repo/codex-prior', {
      channel: 'CLI',
      repositoryKey: 'repo:prior',
      total: usage(30, 1, 2),
    }),
    event('codex', 'home-codex', 'Codex', 'codex', 'e-codex-month', '2026-10-20T10:00:00.000Z', 'session-month', 'gpt-5.6', '/repo/codex-month', {
      channel: 'CLI',
      repositoryKey: 'repo:month',
      total: usage(70, 7, 8),
    }),
    event('dsh', 'home-dsh', 'DSH', 'dsh', 'e-dsh-old', '2026-09-01T10:00:00.000Z', 'session-old', 'deepseek-flash', '/repo/old', {
      channel: 'DSH',
      repositoryKey: 'repo:old',
      total: usage(40, 4, 5),
    }),
  ];
  return { events, context };
}

function filtersFor(overrides = {}) {
  return {
    preset: 'custom',
    startDate: '2026-10-30',
    endDate: '2026-11-02',
    calendarZone: 'utc',
    now: NOW,
    pricingCatalog,
    excludeHomes: ['home-claude'],
    ...overrides,
  };
}

function inRange(eventValue, range) {
  const timestamp = Date.parse(eventValue.timestamp);
  return (
    Number.isFinite(timestamp) &&
    (!range.start || timestamp >= range.start.getTime()) &&
    (!range.end || timestamp <= range.end.getTime())
  );
}

function sessionFacts(sourceEvents, sourceId) {
  const sessions = new Map();
  for (const sourceEvent of sourceEvents) {
    const order = [sourceEvent.timestamp, sourceId, sourceEvent.eventId];
    const current = sessions.get(sourceEvent.sessionId);
    if (!current || order[0].localeCompare(current[0]) < 0) sessions.set(sourceEvent.sessionId, order);
  }
  return sessions;
}

function mergeOrder(current, next) {
  if (!current) return next;
  for (let index = 0; index < 3; index += 1) {
    const compared = String(next[index]).localeCompare(String(current[index]));
    if (compared) return compared < 0 ? next : current;
  }
  return current;
}

function addOrdered(map, key, order, sessionId) {
  const current = map.get(key) || { order, sessions: new Map() };
  current.order = mergeOrder(current.order, order);
  current.sessions.set(sessionId, mergeOrder(current.sessions.get(sessionId), order));
  map.set(key, current);
}

function factsFor(sourceEvents, allEvents, sourceId, projection, filters, bucket) {
  const excluded = new Set(filters.excludeHomes || []);
  const sourceRange = {
    ...projection.summary.range,
    start: projection.summary.range.start ? new Date(projection.summary.range.start) : null,
    end: projection.summary.range.end ? new Date(projection.summary.range.end) : null,
  };
  const available = sourceEvents.filter((item) => !excluded.has(item.homeId));
  const current = available.filter((item) => inRange(item, sourceRange));
  const previous = previousUsageRange(sourceRange);
  const previousEvents = previous ? available.filter((item) => inRange(item, previous)) : [];
  const groups = {
    channels: new Map(),
    homes: new Map(),
    models: new Map(),
    projects: new Map(),
    repositories: new Map(),
  };
  const repositories = new Map();
  const periodRepositories = new Map();
  const timeline = new Map();
  const metadataHomes = new Map();
  const metadataSessions = new Set();
  const selectedHomes = new Set();
  const priceModels = new Set();
  let cacheRateInput = 0;
  let cacheRateCached = 0;

  for (const item of sourceEvents) {
    metadataSessions.add(item.sessionId);
    const home = metadataHomes.get(item.homeId) || { count: 0, sessions: new Set() };
    home.count += 1;
    home.sessions.add(item.sessionId);
    metadataHomes.set(item.homeId, home);
  }

  for (const item of available) {
    if (!Number.isFinite(Date.parse(item.timestamp))) continue;
    const order = [item.timestamp, sourceId, item.eventId];
    addOrdered(periodRepositories, item.repositoryKey, order, item.sessionId);
    const repository = periodRepositories.get(item.repositoryKey);
    repository.paths ||= new Set();
    repository.kind ||= item.repositoryKind;
    if (item.cwd) repository.paths.add(item.cwd);
  }

  for (const item of current) {
    const order = [item.timestamp, sourceId, item.eventId];
    const sourceKind = projection.metadata.homes.find((home) => home.id === item.homeId)?.kind;
    const channel = channelForRange(item.channel, sourceRange, sourceKind);
    const model = canonicalModelName(item.model, pricingCatalog.models);
    const keys = {
      channels: channel,
      homes: item.homeLabel,
      models: model,
      projects: item.cwd || 'Unknown cwd',
      repositories: item.repositoryKey || `directory:${item.cwd || 'Unknown cwd'}`,
    };
    for (const [field, key] of Object.entries(keys)) addOrdered(groups[field], key, order, item.sessionId);
    const repository = repositories.get(keys.repositories) || {
      order,
      paths: new Set(),
      kind: item.repositoryKind || 'directory',
    };
    repository.order = mergeOrder(repository.order, order);
    repository.paths ||= new Set();
    repository.kind = repository.order === order ? item.repositoryKind || 'directory' : repository.kind;
    if (item.cwd) repository.paths.add(item.cwd);
    repositories.set(keys.repositories, repository);
    selectedHomes.add(item.homeId);

    const slotKey = timelineBucketKey(item.timestamp, bucket, sourceRange.calendarZone);
    const slot = timeline.get(slotKey) || {
      sessions: new Map(),
      channels: new Map(),
      models: new Map(),
    };
    slot.sessions.set(item.sessionId, mergeOrder(slot.sessions.get(item.sessionId), order));
    addOrdered(slot.channels, channel, order, item.sessionId);
    addOrdered(slot.models, model, order, item.sessionId);
    timeline.set(slotKey, slot);

    cacheRateInput += Number(item.total.input || 0);
    cacheRateCached += Number(item.total.cached || 0);
    if (model && model.toLocaleLowerCase() !== 'unknown model') priceModels.add(model);
  }

  return {
    sessions: sessionFacts(current, sourceId),
    previousSessions: sessionFacts(previousEvents, sourceId),
    groups,
    repositories,
    timeline,
    metadataSessions,
    metadataHomes,
    periodRepositories,
    cacheRateInput,
    cacheRateCached,
    priceModels,
    selectedHomes,
  };
}

function sourceParts(sample, filters) {
  const allEvents = sample.events;
  const range = resolveDateRange(filters, allEvents);
  const bucket = deriveTimelineBucket(range, filters.bucket || 'day');
  const sourceIds = ['codex', 'dsh', 'zcode', 'claude'];
  const parts = sourceIds.map((sourceId) => {
    const events = allEvents.filter((item) => item.sourceId === sourceId);
    const projection = productProjection({ events, context: sample.context }, { ...filters, bucket });
    return {
      sourceId,
      projection,
      facts: factsFor(events, allEvents, sourceId, projection, filters, bucket),
    };
  });
  return { range, bucket, parts };
}

function assertProjectionEqual(actual, expected, path = 'projection') {
  if (typeof actual === 'number' && typeof expected === 'number') {
    if (Number.isInteger(actual) && Number.isInteger(expected)) {
      assert.equal(actual, expected, path);
    } else if (Object.is(actual, expected)) {
      return;
    } else {
      assert.ok(Math.abs(actual - expected) < 1e-9, `${path}: ${actual} != ${expected}`);
    }
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path);
    assert.equal(actual.length, expected.length, `${path}.length`);
    expected.forEach((value, index) => assertProjectionEqual(actual[index], value, `${path}[${index}]`));
    return;
  }
  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', path);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path}.keys`);
    for (const key of Object.keys(expected)) assertProjectionEqual(actual[key], expected[key], `${path}.${key}`);
    return;
  }
  assert.equal(actual, expected, path);
}

test('merges crossed sessions, repositories, aliases, currencies, coverage and periods', () => {
  const sample = fixture();
  const quota = selectQuotaWindows(sample.context.rateLimitObservations, NOW);
  quota.asOf = NOW.toISOString();
  const filters = filtersFor({ quota });
  const expected = productProjection({ events: sample.events, context: sample.context }, filters);
  const { range, bucket, parts } = sourceParts(sample, filters);
  const actual = mergeBusinessParts(parts, {
    context: sample.context,
    pricingCatalog,
    now: NOW,
    range,
    bucket,
    quota,
  });

  assertProjectionEqual(actual, expected);
  assert.equal(actual.summary.sessionCount, 6);
  assert.equal(actual.metadata.sessionCount, 9);
  const sharedRepository = /** @type {any} */ (actual.summary.repositories.find((row) => row.key === 'repo:shared'));
  assert.deepEqual(sharedRepository.sessionIds, [
    'session-shared',
    'session-routing-usd',
    'session-zcode',
  ]);
  assert.equal(sharedRepository.pathCount, 4);
  assert.ok(actual.summary.models.some((row) => row.key === 'gpt-5.6-sol'));
  assert.ok(actual.summary.models.some((row) => row.key === 'deepseek-flash'));
  assert.ok(
    actual.summary.costEstimate.minimumRateModels.indexOf('opencode-go/gemini-4-argon-contributor') <
      actual.summary.costEstimate.minimumRateModels.indexOf('Unknown model'),
  );
  const mixedCosts = Object.entries(actual.summary.timeline.find((row) => row.key === '2026-11-01').costByModel);
  assert.deepEqual(
    mixedCosts.filter(([key]) => key.includes('routing-shared')).map(([key, cost]) => [key, cost.currency]),
    [
      ['routing-shared\u0000CNY', 'CNY'],
      ['routing-shared\u0000USD', 'USD'],
    ],
  );
  const empty = actual.summary.timeline.find((row) => row.key === '2026-10-30');
  assert.equal(empty.count, 0);
  assert.equal(empty.pricingStatus, 'no-data');
  assert.deepEqual(empty.channels, []);
  assert.deepEqual(empty.costByModel, {});
});

test('empty current scope retains empty slots and source metadata', () => {
  const sample = fixture();
  const quota = selectQuotaWindows(sample.context.rateLimitObservations, NOW);
  quota.asOf = NOW.toISOString();
  const filters = filtersFor({ excludeHomes: ['home-codex', 'home-dsh', 'home-zcode', 'home-claude'], quota });
  const expected = productProjection({ events: sample.events, context: sample.context }, filters);
  const { range, bucket, parts } = sourceParts(sample, filters);
  const actual = mergeBusinessParts(parts, {
    context: sample.context,
    pricingCatalog,
    now: NOW,
    range,
    bucket,
    quota,
  });
  assertProjectionEqual(actual, expected);
});

test('matches direct projection for today, week, month, all and custom ranges', () => {
  const sample = fixture();
  const quota = selectQuotaWindows(sample.context.rateLimitObservations, NOW);
  quota.asOf = NOW.toISOString();
  for (const preset of ['today', 'week', 'month', 'all', 'custom']) {
    const filters = filtersFor({ preset, quota });
    const expected = productProjection({ events: sample.events, context: sample.context }, filters);
    const { range, bucket, parts } = sourceParts(sample, filters);
    const actual = mergeBusinessParts(parts, {
      context: sample.context,
      pricingCatalog,
      now: NOW,
      range,
      bucket,
      quota,
    });
    assertProjectionEqual(actual, expected, preset);
  }
});

test('all-home exclusion and earliest/latest home exclusions bound periodComparison all', () => {
  const sample = fixture();
  const quota = selectQuotaWindows(sample.context.rateLimitObservations, NOW);
  quota.asOf = NOW.toISOString();
  const allHomeIds = [...new Set(sample.events.map((item) => item.homeId))];
  const allExcluded = filtersFor({ preset: 'all', excludeHomes: allHomeIds, quota });
  const expected = productProjection({ events: sample.events, context: sample.context }, allExcluded);
  const build = sourceParts(sample, allExcluded);
  const actual = mergeBusinessParts(build.parts, {
    context: sample.context,
    pricingCatalog,
    now: NOW,
    range: build.range,
    bucket: build.bucket,
    quota,
  });
  assertProjectionEqual(actual, expected);
  assert.deepEqual(actual.periodComparison.periods.find((period) => period.key === 'all'), {
    key: 'all',
    start: null,
    end: null,
  });

  const boundarySample = {
    context: sample.context,
    events: [
      sample.events.find((item) => item.eventId === 'e-codex-prior-day'),
      sample.events.find((item) => item.eventId === 'e-opencode-minimum'),
    ],
  };
  for (const [excludedHomeId, start, end] of [
    ['home-codex', '2026-11-02T00:00:00.000Z', '2026-11-02T23:59:59.999Z'],
    ['home-dsh', '2026-10-31T00:00:00.000Z', '2026-10-31T23:59:59.999Z'],
  ]) {
    const filters = filtersFor({ preset: 'all', excludeHomes: [excludedHomeId], quota });
    const direct = productProjection({ events: boundarySample.events, context: boundarySample.context }, filters);
    const source = sourceParts(boundarySample, filters);
    const merged = mergeBusinessParts(source.parts, {
      context: boundarySample.context,
      pricingCatalog,
      now: NOW,
      range: source.range,
      bucket: source.bucket,
      quota,
    });
    assertProjectionEqual(merged, direct, excludedHomeId);
    assert.deepEqual(merged.periodComparison.periods.find((period) => period.key === 'all'), {
      key: 'all',
      start,
      end,
    });
  }
});
