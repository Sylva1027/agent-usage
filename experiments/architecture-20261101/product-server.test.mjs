import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { makeFixture } from './fixture.mjs';
import { aggregateEvents } from './node/query.mjs';
import { productProjection } from './compat.mjs';
import { createProductServer as createServer } from './product-server.mjs';
import { getPricingCatalog } from '../../src/pricing.js';

const NOW = '2026-11-01T10:00:00.000Z';
// This suite retains the previous published path as a comparison contract.
const createProductServer = options => createServer({ mode: 'published', ...options });

function clone(value) {
  return structuredClone(value);
}

function source(sourceId, events) {
  return { events: clone(events), cursor: { sourceId, count: events.length }, updatedRevision: 1 };
}

function snapshotRecord(record) {
  return {
    revision: record.revision,
    sources: new Map(
      [...record.sources].map(([sourceId, value]) => [sourceId, {
        events: clone(value.events),
        cursor: clone(value.cursor),
      }]),
    ),
    context: clone(record.context),
  };
}

function eventsFrom(record) {
  return [...record.sources]
    .flatMap(([sourceId, value]) => value.events.map(event => ({ sourceId, event })))
    .sort((left, right) =>
      left.event.timestamp.localeCompare(right.event.timestamp)
      || left.sourceId.localeCompare(right.sourceId)
      || left.event.eventId.localeCompare(right.event.eventId))
    .map(item => item.event);
}

function filteredEvents(record, params) {
  const start = params.get('start');
  const end = params.get('end');
  const excluded = new Set((params.get('excludeHomes') || '').split(',').filter(Boolean));
  return eventsFrom(record).filter(event =>
    !excluded.has(event.homeId)
    && (!start || Date.parse(event.timestamp) >= Date.parse(start))
    && (!end || Date.parse(event.timestamp) <= Date.parse(end)));
}

function createMockBackend(fixture) {
  const half = Math.ceil(fixture.events.length / 2);
  const record = {
    revision: 1,
    sources: new Map([
      ['alpha', source('alpha', fixture.events.slice(0, half))],
      ['beta', source('beta', fixture.events.slice(half))],
    ]),
    context: clone(fixture.context),
  };
  const snapshots = new Map();
  const calls = {
    changes: [],
    query: [],
    report: 0,
    freeze: 0,
    freezeSnapshots: [],
    status: [],
  };
  let raceQueryOnce = false;
  let captureQueryAtEntry = false;
  let queryHook = null;

  function commit(sourceId, events, cursor = { sourceId, version: record.revision + 1 }, context = record.context) {
    record.revision += 1;
    record.context = clone(context);
    record.sources.set(sourceId, {
      events: clone(events),
      cursor: clone(cursor),
      updatedRevision: record.revision,
    });
  }

  function changesResponse(params) {
    const snapshot = params.get('snapshot');
    if (snapshot !== null) {
      const frozen = snapshots.get(snapshot);
      if (!frozen) throw Object.assign(new Error('snapshot not found'), { status: 404, code: 'NOT_FOUND' });
      return {
        revision: frozen.revision,
        reset: true,
        sources: [...frozen.sources].map(([sourceId, value]) => ({
          sourceId,
          events: clone(value.events),
          cursor: clone(value.cursor),
        })),
        context: clone(frozen.context),
      };
    }
    const sinceText = params.get('since');
    const since = sinceText === null ? null : Number(sinceText);
    const selected = since === null
      ? [...record.sources]
      : [...record.sources].filter(([, value]) => value.updatedRevision > since);
    return {
      revision: record.revision,
      reset: since === null,
      sources: selected.map(([sourceId, value]) => ({
        sourceId,
        events: clone(value.events),
        cursor: clone(value.cursor),
      })),
      context: clone(record.context),
    };
  }

  async function request(route) {
    const url = new URL(route, 'http://127.0.0.1');
    let value;
    if (url.pathname === '/api/changes') {
      calls.changes.push(route);
      value = changesResponse(url.searchParams);
    } else if (url.pathname === '/api/query') {
      calls.query.push(route);
      if (raceQueryOnce) {
        raceQueryOnce = false;
        commit('alpha', [
          ...record.sources.get('alpha').events,
          {
            ...clone(fixture.events[0]),
            eventId: 'future-race-event',
            sessionId: 'future-race-session',
            timestamp: '2026-11-01T11:30:00.000Z',
            total: { input: 7, cached: 1, output: 3, reasoning: 0, total: 10 },
          },
        ], { race: 1 });
      }
      const snapshot = url.searchParams.get('snapshot');
      const selectedAtEntry = captureQueryAtEntry
        ? snapshot === null ? snapshotRecord(record) : snapshots.get(snapshot)
        : null;
      if (captureQueryAtEntry && !selectedAtEntry) {
        throw Object.assign(new Error('snapshot not found'), { status: 404, code: 'NOT_FOUND' });
      }
      if (queryHook) {
        await queryHook({
          call: calls.query.length,
          route,
          params: new URLSearchParams(url.searchParams),
          entryRecord: selectedAtEntry,
        });
      }
      const selected = captureQueryAtEntry
        ? selectedAtEntry
        : snapshot === null ? record : snapshots.get(snapshot);
      if (!selected) throw Object.assign(new Error('snapshot not found'), { status: 404, code: 'NOT_FOUND' });
      value = {
        revision: selected.revision,
        ...aggregateEvents(filteredEvents(selected, url.searchParams)),
      };
    } else if (url.pathname === '/api/report') {
      calls.report += 1;
      const snapshot = url.searchParams.get('snapshot');
      const selected = snapshot === null ? record : snapshots.get(snapshot);
      value = {
        revision: selected.revision,
        events: filteredEvents(selected, url.searchParams),
        context: clone(selected.context),
        cursors: Object.fromEntries([...selected.sources].map(([sourceId, entry]) => [sourceId, clone(entry.cursor)])),
      };
    } else if (url.pathname === '/api/status') {
      calls.status.push(route);
      value = { revision: record.revision, eventCount: eventsFrom(record).length };
    } else if (url.pathname === '/api/freeze') {
      calls.freeze += 1;
      const id = String(record.revision);
      calls.freezeSnapshots.push(id);
      snapshots.set(id, snapshotRecord(record));
      value = { snapshot: Number(id) };
    } else {
      throw Object.assign(new Error('not found'), { status: 404 });
    }
    return { value, bytes: Buffer.byteLength(JSON.stringify(value)) };
  }

  return {
    calls,
    request,
    record,
    commit,
    currentEvents: () => eventsFrom(record),
    setRaceQueryOnce(value = true) {
      raceQueryOnce = value;
    },
    captureQueriesAtEntry(value = true) {
      captureQueryAtEntry = value;
    },
    setQueryHook(value) {
      queryHook = value;
    },
    restart(revision, sources, context = record.context) {
      record.revision = revision;
      record.context = clone(context);
      record.sources = new Map(
        sources.map(entry => [entry.sourceId, {
          events: clone(entry.events),
          cursor: clone(entry.cursor ?? { restart: revision }),
          updatedRevision: revision,
        }]),
      );
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

async function json(baseUrl, route) {
  const response = await fetch(baseUrl + route);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return { response, payload };
}

function catalog(version = 'test-v1') {
  return { ...clone(getPricingCatalog()), version };
}

function carrier(events, context) {
  return { revision: 1, events, context };
}

function allProjection(backend, pricingCatalog) {
  return productProjection(
    carrier(backend.currentEvents(), backend.record.context),
    { preset: 'all', calendarZone: 'utc', now: new Date(NOW), pricingCatalog },
  );
}

function assertBusinessVersion(payload, expected, revision) {
  assert.equal(payload.fingerprint, String(revision));
  assert.deepEqual(payload.summary, expected.summary);
  assert.deepEqual(payload.quota, expected.quota);
  assert.deepEqual(payload.periodComparison, expected.periodComparison);
}

test('published feed replaces sources by delta and query owns ordinary aggregates', async () => {
  const fixture = makeFixture(12);
  const backend = createMockBackend(fixture);
  backend.setRaceQueryOnce();
  const pricingCatalog = catalog();
  const server = await createProductServer({
    backend: 'http://127.0.0.1:1',
    now: NOW,
    request: backend.request,
    pricingCatalog: () => pricingCatalog,
  });
  const baseUrl = await listen(server);
  try {
    const first = await json(baseUrl, '/api/usage?preset=today&calendarZone=utc');
    const current = backend.currentEvents();
    const expected = productProjection(
      carrier(current, backend.record.context),
      { preset: 'today', calendarZone: 'utc', now: new Date(NOW), pricingCatalog },
    );
    assert.equal(first.payload.fingerprint, '2');
    assert.deepEqual(first.payload.summary, expected.summary);
    assert.equal(backend.calls.report, 0);
    assert.deepEqual(backend.calls.changes, ['/api/changes', '/api/changes?since=1&contextSince=1']);
    assert.equal(backend.calls.query.length, 2);
    assert.match(first.response.headers.get('server-timing'), /feed;dur=.*projection;dur=.*core;dur=.*response;dur=/);
    const firstQuery = new URL(backend.calls.query[0], 'http://127.0.0.1').searchParams;
    assert.equal(firstQuery.get('start'), expected.summary.range.start);
    assert.equal(firstQuery.get('end'), expected.summary.range.end);
    assert.equal(first.payload.summary.eventCount, current.length);
    assert.ok(current.some(event => Date.parse(event.timestamp) > Date.parse(NOW)));

    const alpha = backend.record.sources.get('alpha');
    backend.commit('alpha', alpha.events.slice(0, 2), { replacement: 1 });
    const second = await json(baseUrl, '/api/usage?preset=today&calendarZone=utc');
    assert.equal(second.payload.fingerprint, '3');
    assert.equal(second.payload.summary.eventCount, backend.currentEvents().length);
    assert.ok(backend.record.sources.get('beta').events.length > 0);
    assert.equal(backend.calls.report, 0);

    const diagnostics = await json(baseUrl, '/api/diagnostics');
    assert.equal(diagnostics.payload.feed.requests, 3);
    assert.ok(diagnostics.payload.feed.bytes > 0);
    assert.equal(diagnostics.payload.query.requests, 3);
    assert.equal(diagnostics.payload.projection.requests, 3);
  } finally {
    await close(server);
  }
});

test('parallel usage requests retry to one revision when blocked core reads newer facts', async () => {
  const fixture = makeFixture(12);
  const backend = createMockBackend(fixture);
  backend.commit('alpha', backend.record.sources.get('alpha').events, { seed: 2 });
  const gates = [deferred(), deferred()];
  backend.setQueryHook(async ({ call }) => {
    if (call <= 2) await gates[call - 1].promise;
  });
  const pricingCatalog = catalog();
  const server = await createProductServer({
    backend: 'http://127.0.0.1:1',
    now: NOW,
    request: backend.request,
    pricingCatalog: () => pricingCatalog,
  });
  const baseUrl = await listen(server);
  const route = '/api/usage?preset=all&calendarZone=utc';
  try {
    const first = json(baseUrl, route);
    const second = json(baseUrl, route);
    await waitFor(() => backend.calls.query.length === 2);
    backend.commit('alpha', [
      ...backend.record.sources.get('alpha').events,
      {
        ...clone(fixture.events[0]),
        eventId: 'concurrent-core-newer',
        sessionId: 'concurrent-core-newer-session',
        timestamp: '2026-11-01T11:45:00.000Z',
        total: { input: 9, cached: 2, output: 4, reasoning: 1, total: 13 },
      },
    ], { newer: 3 });
    const expected = allProjection(backend, pricingCatalog);

    gates[0].resolve();
    const firstResult = await first;
    gates[1].resolve();
    const secondResult = await second;

    assertBusinessVersion(firstResult.payload, expected, 3);
    assertBusinessVersion(secondResult.payload, expected, 3);
    assert.equal(backend.calls.query.length, 4);
  } finally {
    gates[0].resolve();
    gates[1].resolve();
    await close(server);
  }
});

test('blocked core keeps its captured revision when another usage advances live state', async () => {
  const fixture = makeFixture(12);
  const backend = createMockBackend(fixture);
  backend.commit('alpha', backend.record.sources.get('alpha').events, { seed: 2 });
  backend.captureQueriesAtEntry();
  const entered = deferred();
  const release = deferred();
  backend.setQueryHook(async ({ call }) => {
    if (call === 1) {
      entered.resolve();
      await release.promise;
    }
  });
  const pricingCatalog = catalog();
  const server = await createProductServer({
    backend: 'http://127.0.0.1:1',
    now: NOW,
    request: backend.request,
    pricingCatalog: () => pricingCatalog,
  });
  const baseUrl = await listen(server);
  const route = '/api/usage?preset=all&calendarZone=utc';
  try {
    const first = json(baseUrl, route);
    await entered.promise;
    const expectedOld = allProjection(backend, pricingCatalog);

    backend.commit('alpha', [
      ...backend.record.sources.get('alpha').events,
      {
        ...clone(fixture.events[0]),
        eventId: 'concurrent-state-newer',
        sessionId: 'concurrent-state-newer-session',
        timestamp: '2026-11-01T11:50:00.000Z',
        total: { input: 11, cached: 3, output: 5, reasoning: 1, total: 16 },
      },
    ], { newer: 3 });
    const expectedNew = allProjection(backend, pricingCatalog);
    const secondResult = await json(baseUrl, route);

    release.resolve();
    const firstResult = await first;

    assertBusinessVersion(firstResult.payload, expectedOld, 2);
    assertBusinessVersion(secondResult.payload, expectedNew, 3);
    assert.equal(backend.calls.query.length, 2);
  } finally {
    release.resolve();
    await close(server);
  }
});

test('warm unchanged usage probes status and skips changes', async () => {
  const fixture = makeFixture(12);
  const backend = createMockBackend(fixture);
  const pricingCatalog = catalog();
  const server = await createProductServer({
    backend: 'http://127.0.0.1:1',
    now: NOW,
    request: backend.request,
    pricingCatalog: () => pricingCatalog,
  });
  const baseUrl = await listen(server);
  const route = '/api/usage?preset=all&calendarZone=utc';
  try {
    const first = await json(baseUrl, route);
    const warmCarrier = server.productPublisher.carrier();
    const second = await json(baseUrl, route);

    assert.deepEqual(second.payload.summary, first.payload.summary);
    assert.strictEqual(server.productPublisher.carrier(), warmCarrier);
    assert.equal(backend.calls.changes.length, 1);
    assert.equal(backend.calls.status.length, 1);
    const diagnostics = await json(baseUrl, '/api/diagnostics');
    assert.equal(diagnostics.payload.feed.requests, 1);
    assert.equal(diagnostics.payload.probe.requests, 1);
    assert.ok(diagnostics.payload.probe.bytes > 0);
    assert.equal(diagnostics.payload.query.requests, 2);
  } finally {
    await close(server);
  }
});

test('new live revision uses delta changes after the status probe', async () => {
  const fixture = makeFixture(12);
  const backend = createMockBackend(fixture);
  const pricingCatalog = catalog();
  const server = await createProductServer({
    backend: 'http://127.0.0.1:1',
    now: NOW,
    request: backend.request,
    pricingCatalog: () => pricingCatalog,
  });
  const baseUrl = await listen(server);
  const route = '/api/usage?preset=all&calendarZone=utc';
  try {
    await json(baseUrl, route);
    const oldCarrier = server.productPublisher.carrier();
    backend.commit('alpha', [
      ...backend.record.sources.get('alpha').events,
      {
        ...clone(fixture.events[0]),
        eventId: 'probe-new-revision',
        sessionId: 'probe-new-session',
        timestamp: '2026-11-01T11:55:00.000Z',
        total: { input: 13, cached: 4, output: 6, reasoning: 1, total: 19 },
      },
    ], { newer: 2 });
    const updated = await json(baseUrl, route);
    const expected = allProjection(backend, pricingCatalog);

    assertBusinessVersion(updated.payload, expected, 2);
    assert.notStrictEqual(server.productPublisher.carrier(), oldCarrier);
    assert.deepEqual(backend.calls.status, ['/api/status']);
    assert.deepEqual(backend.calls.changes, ['/api/changes', '/api/changes?since=1&contextSince=1']);
    const diagnostics = await json(baseUrl, '/api/diagnostics');
    assert.equal(diagnostics.payload.feed.requests, 2);
    assert.equal(diagnostics.payload.probe.requests, 1);
  } finally {
    await close(server);
  }
});

test('backend revision rollback fetches full changes without a future since', async () => {
  const fixture = makeFixture(12);
  const backend = createMockBackend(fixture);
  backend.commit('alpha', backend.record.sources.get('alpha').events, { seed: 2 });
  backend.commit('alpha', backend.record.sources.get('alpha').events, { seed: 3 });
  const pricingCatalog = catalog();
  const server = await createProductServer({
    backend: 'http://127.0.0.1:1',
    now: NOW,
    request: backend.request,
    pricingCatalog: () => pricingCatalog,
  });
  const baseUrl = await listen(server);
  const route = '/api/usage?preset=all&calendarZone=utc';
  try {
    await json(baseUrl, route);
    const oldCarrier = server.productPublisher.carrier();
    backend.restart(1, [{
      sourceId: 'restarted',
      events: fixture.events.slice(0, 3),
      cursor: { restart: 1 },
    }], fixture.context);
    const restarted = await json(baseUrl, route);
    const expected = allProjection(backend, pricingCatalog);

    assertBusinessVersion(restarted.payload, expected, 1);
    assert.notStrictEqual(server.productPublisher.carrier(), oldCarrier);
    assert.deepEqual(backend.calls.changes, ['/api/changes', '/api/changes']);
    assert.equal(backend.calls.changes.some(value => value.includes('since=3')), false);
    assert.deepEqual(backend.calls.status, ['/api/status']);
    const diagnostics = await json(baseUrl, '/api/diagnostics');
    assert.equal(diagnostics.payload.feed.requests, 2);
    assert.equal(diagnostics.payload.probe.requests, 1);
  } finally {
    await close(server);
  }
});

test('projection cache uses clock boundaries, filters, catalog, and revision', async () => {
  const fixture = makeFixture(12);
  const backend = createMockBackend(fixture);
  let now = NOW;
  let pricingCatalog = catalog('v1');
  const server = await createProductServer({
    backend: 'http://127.0.0.1:1',
    now: () => now,
    request: backend.request,
    pricingCatalog: () => pricingCatalog,
  });
  const baseUrl = await listen(server);
  try {
    await json(baseUrl, '/api/usage?preset=today&calendarZone=utc');
    const warmCarrier = server.productPublisher.carrier();
    const warmContext = server.productPublisher.state().context;
    now = '2026-11-01T10:00:01.000Z';
    const hit = await json(baseUrl, '/api/usage?preset=today&calendarZone=utc');
    assert.strictEqual(server.productPublisher.carrier(), warmCarrier);
    assert.strictEqual(server.productPublisher.state().context, warmContext);
    assert.equal(hit.payload.periodComparison.asOf, now);
    const fresh = productProjection(
      carrier(backend.currentEvents(), backend.record.context),
      { preset: 'today', calendarZone: 'utc', now: new Date(now), pricingCatalog },
    );
    assert.deepEqual(hit.payload.summary, fresh.summary);
    assert.deepEqual(hit.payload.periodComparison, fresh.periodComparison);

    await json(baseUrl, '/api/usage?preset=today&calendarZone=utc&bucket=hour');
    pricingCatalog = catalog('v2');
    await json(baseUrl, '/api/usage?preset=today&calendarZone=utc');
    now = '2026-11-02T00:00:00.000Z';
    const nextDay = await json(baseUrl, '/api/usage?preset=today&calendarZone=utc');
    assert.equal(nextDay.payload.summary.eventCount, 0);

    const diagnostics = await json(baseUrl, '/api/diagnostics');
    assert.equal(diagnostics.payload.projection.requests, 5);
    assert.equal(diagnostics.payload.projection.cacheHits, 1);
    assert.equal(diagnostics.payload.projection.cacheMisses, 4);
    assert.equal(diagnostics.payload.query.requests, 5);
    assert.equal(diagnostics.payload.feed.requests, 1);
    assert.equal(diagnostics.payload.probe.requests, 4);
    assert.ok(diagnostics.payload.probe.bytes > 0);
    assert.equal(diagnostics.payload.projection.cacheVersion, 1);
  } finally {
    await close(server);
  }
});

test('ordinary query bounds exactly match product resolveDateRange', async () => {
  const fixture = makeFixture(12);
  const backend = createMockBackend(fixture);
  const pricingCatalog = catalog();
  const server = await createProductServer({
    backend: 'http://127.0.0.1:1',
    now: NOW,
    request: backend.request,
    pricingCatalog: () => pricingCatalog,
  });
  const baseUrl = await listen(server);
  const cases = [
    ['today', '/api/usage?preset=today&calendarZone=utc', { preset: 'today', calendarZone: 'utc' }],
    ['week', '/api/usage?preset=week&calendarZone=utc', { preset: 'week', calendarZone: 'utc' }],
    ['month', '/api/usage?preset=month&calendarZone=utc', { preset: 'month', calendarZone: 'utc' }],
    ['all', '/api/usage?preset=all&calendarZone=utc', { preset: 'all', calendarZone: 'utc' }],
    [
      'custom',
      '/api/usage?preset=custom&startDate=2026-10-31&endDate=2026-11-02&calendarZone=utc',
      { preset: 'custom', startDate: '2026-10-31', endDate: '2026-11-02', calendarZone: 'utc' },
    ],
  ];
  try {
    for (const [, route, filters] of cases) {
      const response = await json(baseUrl, route);
      const expected = productProjection(
        carrier(backend.currentEvents(), backend.record.context),
        { ...filters, now: new Date(NOW), pricingCatalog },
      );
      const params = new URL(backend.calls.query.at(-1), 'http://127.0.0.1').searchParams;
      assert.equal(params.get('start'), expected.summary.range.start);
      assert.equal(params.get('end'), expected.summary.range.end);
      assert.deepEqual(response.payload.summary, expected.summary);
    }
    const today = productProjection(
      carrier(backend.currentEvents(), backend.record.context),
      { preset: 'today', calendarZone: 'utc', now: new Date(NOW), pricingCatalog },
    );
    const futureCount = backend.currentEvents().filter(event => Date.parse(event.timestamp) > Date.parse(NOW)).length;
    assert.ok(futureCount > 0);
    assert.equal(today.summary.eventCount, futureCount + backend.currentEvents().filter(event =>
      Date.parse(event.timestamp) <= Date.parse(NOW)
      && event.timestamp.startsWith('2026-11-01')).length);
  } finally {
    await close(server);
  }
});

test('rolling recent range is recomputed instead of reusing a stale clock', async () => {
  const fixture = makeFixture(12);
  const backend = createMockBackend(fixture);
  let now = NOW;
  const pricingCatalog = catalog();
  const server = await createProductServer({
    backend: 'http://127.0.0.1:1',
    now: () => now,
    request: backend.request,
    pricingCatalog: () => pricingCatalog,
  });
  const baseUrl = await listen(server);
  const route = `/api/usage?preset=recent&recentValue=${encodeURIComponent('1 天')}&calendarZone=utc`;
  try {
    await json(baseUrl, route);
    now = '2026-11-01T10:00:01.000Z';
    const second = await json(baseUrl, route);
    const expected = productProjection(
      carrier(backend.currentEvents(), backend.record.context),
      { preset: 'recent', recentValue: '1 天', calendarZone: 'utc', now: new Date(now), pricingCatalog },
    );
    assert.deepEqual(second.payload.summary, expected.summary);
    const params = new URL(backend.calls.query.at(-1), 'http://127.0.0.1').searchParams;
    assert.equal(params.get('start'), expected.summary.range.start);
    assert.equal(params.get('end'), expected.summary.range.end);
    const diagnostics = await json(baseUrl, '/api/diagnostics');
    assert.equal(diagnostics.payload.projection.cacheHits, 0);
    assert.equal(diagnostics.payload.projection.cacheMisses, 2);
  } finally {
    await close(server);
  }
});

test('freeze binds snapshot facts, catalog, and asOf across range changes', async () => {
  const fixture = makeFixture(12);
  const backend = createMockBackend(fixture);
  let now = NOW;
  let pricingCatalog = catalog('frozen-v1');
  const server = await createProductServer({
    backend: 'http://127.0.0.1:1',
    now: () => now,
    request: backend.request,
    pricingCatalog: () => pricingCatalog,
  });
  const baseUrl = await listen(server);
  try {
    const frozen = await json(baseUrl, '/api/usage?preset=today&calendarZone=utc&freeze=1');
    const viewId = frozen.payload.snapshotId;
    assert.match(viewId, /^view-/);
    assert.notEqual(viewId, '1');
    assert.equal(frozen.payload.fingerprint, '1');

    const oldEvents = backend.currentEvents();
    backend.commit('alpha', [], { replacement: 2 });
    now = '2026-11-02T12:00:00.000Z';
    pricingCatalog = catalog('frozen-v2');

    const switched = await json(
      baseUrl,
      `/api/usage?preset=all&calendarZone=utc&snapshot=${encodeURIComponent(viewId)}`,
    );
    const expected = productProjection(
      carrier(oldEvents, fixture.context),
      { preset: 'all', calendarZone: 'utc', now: new Date(NOW), pricingCatalog: catalog('frozen-v1') },
    );
    assert.equal(switched.payload.fingerprint, '1');
    assert.equal(switched.payload.snapshotId, viewId);
    assert.equal(switched.payload.periodComparison.asOf, NOW);
    assert.equal(switched.payload.pricingCatalog.version, 'frozen-v1');
    assert.deepEqual(switched.payload.summary, expected.summary);
    assert.equal(backend.calls.freeze, 1);
    assert.deepEqual(backend.calls.freezeSnapshots, ['1']);
    assert.equal(backend.calls.changes.filter(route => route.includes('snapshot=1')).length, 1);
    assert.ok(backend.calls.query.at(-1).includes('snapshot=1'));
  } finally {
    await close(server);
  }
});

async function verifyRepeatedFreezeIsolation(mode) {
  const fixture = makeFixture(12);
  const backend = createMockBackend(fixture);
  let now = NOW;
  let pricingCatalog = catalog('freeze-a');
  const server = await createProductServer({
    mode,
    backend: 'http://127.0.0.1:1',
    now: () => now,
    request: backend.request,
    pricingCatalog: () => pricingCatalog,
  });
  const baseUrl = await listen(server);
  try {
    const first = await json(baseUrl, '/api/usage?preset=all&calendarZone=utc&freeze=1');
    const oldViewId = first.payload.snapshotId;
    assert.match(oldViewId, /^view-/);

    now = '2026-11-01T10:05:00.000Z';
    pricingCatalog = catalog('freeze-b');
    const second = await json(baseUrl, '/api/usage?preset=all&calendarZone=utc&freeze=1');
    const newViewId = second.payload.snapshotId;
    assert.match(newViewId, /^view-/);
    assert.notEqual(newViewId, oldViewId);
    assert.deepEqual(backend.calls.freezeSnapshots, ['1', '1']);

    now = '2026-11-01T10:10:00.000Z';
    pricingCatalog = catalog('live-c');
    const oldResult = await json(
      baseUrl,
      `/api/usage?preset=all&calendarZone=utc&snapshot=${encodeURIComponent(oldViewId)}`,
    );
    const newResult = await json(
      baseUrl,
      `/api/usage?preset=all&calendarZone=utc&snapshot=${encodeURIComponent(newViewId)}`,
    );
    const facts = carrier(backend.currentEvents(), backend.record.context);
    const expectedOld = productProjection(
      facts,
      { preset: 'all', calendarZone: 'utc', now: new Date(NOW), pricingCatalog: catalog('freeze-a') },
    );
    const expectedNew = productProjection(
      facts,
      {
        preset: 'all',
        calendarZone: 'utc',
        now: new Date('2026-11-01T10:05:00.000Z'),
        pricingCatalog: catalog('freeze-b'),
      },
    );

    assert.equal(oldResult.payload.snapshotId, oldViewId);
    assert.equal(oldResult.payload.periodComparison.asOf, NOW);
    assert.equal(oldResult.payload.pricingCatalog.version, 'freeze-a');
    assert.deepEqual(oldResult.payload.summary, expectedOld.summary);
    assert.deepEqual(oldResult.payload.periodComparison, expectedOld.periodComparison);

    assert.equal(newResult.payload.snapshotId, newViewId);
    assert.equal(newResult.payload.periodComparison.asOf, '2026-11-01T10:05:00.000Z');
    assert.equal(newResult.payload.pricingCatalog.version, 'freeze-b');
    assert.deepEqual(newResult.payload.summary, expectedNew.summary);
    assert.deepEqual(newResult.payload.periodComparison, expectedNew.periodComparison);

    assert.equal(backend.calls.freeze, 2);
    assert.ok(backend.calls.query.every(route => route.includes('snapshot=1') || mode === 'legacy'));
    if (mode === 'published') {
      assert.equal(backend.calls.changes.filter(route => route.includes('snapshot=1')).length, 1);
      assert.ok(backend.calls.query.every(route => route.includes('snapshot=1')));
    } else {
      assert.equal(backend.calls.query.length, 0);
      assert.equal(backend.calls.report, 4);
    }
  } finally {
    await close(server);
  }
}

test('published freeze views keep separate asOf and catalog for the same backend revision', async () => {
  await verifyRepeatedFreezeIsolation('published');
});

test('legacy freeze views keep separate asOf and catalog for the same backend revision', async () => {
  await verifyRepeatedFreezeIsolation('legacy');
});

test('legacy mode keeps full report projection on every usage request', async () => {
  const fixture = makeFixture(6);
  const backend = createMockBackend(fixture);
  const pricingCatalog = catalog();
  const server = await createProductServer({
    mode: 'legacy',
    now: NOW,
    request: backend.request,
    pricingCatalog: () => pricingCatalog,
  });
  const baseUrl = await listen(server);
  try {
    const first = await json(baseUrl, '/api/usage?preset=all&calendarZone=utc');
    await json(baseUrl, '/api/usage?preset=all&calendarZone=utc');
    const expected = productProjection(
      carrier(backend.currentEvents(), fixture.context),
      { preset: 'all', calendarZone: 'utc', now: new Date(NOW), pricingCatalog },
    );
    assert.deepEqual(first.payload.summary, expected.summary);
    assert.equal(backend.calls.report, 2);
    assert.equal(backend.calls.changes.length, 0);
    assert.equal(backend.calls.query.length, 0);
    const diagnostics = await json(baseUrl, '/api/diagnostics');
    assert.equal(diagnostics.payload.mode, 'legacy');
    assert.equal(diagnostics.payload.projection.requests, 2);
    assert.equal(diagnostics.payload.query.requests, 0);
  } finally {
    await close(server);
  }
});

test('published and legacy keep byte-identical business payloads', async () => {
  const fixture = makeFixture(12);
  const backend = createMockBackend(fixture);
  const pricingCatalog = catalog();
  const options = {
    now: NOW,
    request: backend.request,
    pricingCatalog: () => pricingCatalog,
  };
  const publishedServer = await createProductServer({ ...options, backend: 'http://127.0.0.1:1' });
  const legacyServer = await createProductServer({ ...options, mode: 'legacy' });
  const publishedUrl = await listen(publishedServer);
  const legacyUrl = await listen(legacyServer);
  try {
    const route = '/api/usage?preset=all&calendarZone=utc';
    const [published, legacy] = await Promise.all([
      fetch(publishedUrl + route).then(response => response.text()),
      fetch(legacyUrl + route).then(response => response.text()),
    ]);
    assert.equal(published, legacy);
  } finally {
    await close(publishedServer);
    await close(legacyServer);
  }
});
