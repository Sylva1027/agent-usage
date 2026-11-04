import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { makeFixture, NOW } from './fixture.mjs';
import { productProjection } from './compat.mjs';
import { aggregateEvents } from './node/query.mjs';
import { launch, request, VARIANTS } from './runner.mjs';

const destination = path.resolve(process.argv[2] || 'output/architecture-20261101/verification');
const variants = process.argv.slice(3).length ? process.argv.slice(3) : VARIANTS;
await mkdir(destination, { recursive: true });
const fixture = makeFixture();
const results = [];
const filters = [ {}, { start: '2026-10-30T00:00:00.000Z', end: NOW },
  { excludeHomes: 'fixture-codex,fixture-dsh' }, { start: NOW, end: NOW }, { start: '2027-01-01T00:00:00.000Z' } ];
const businessCases = [
  { preset: 'all', now: NOW, calendarZone: 'utc' },
  { preset: 'today', now: NOW, calendarZone: 'utc' },
  { preset: 'week', now: NOW, calendarZone: 'utc' },
  { preset: 'month', now: NOW, calendarZone: 'utc' },
  { preset: 'custom', startDate: '2026-10-29', endDate: '2026-10-31', now: NOW, calendarZone: 'utc' },
  { preset: 'all', excludeHomes: ['fixture-codex'], now: NOW, calendarZone: 'utc' },
  { preset: 'quota_5h', now: NOW, calendarZone: 'utc' },
  { preset: 'quota_week', now: NOW, calendarZone: 'utc' },
];
for (const variant of variants) {
  const directory = path.join(destination, variant + '-' + Date.now());
  await mkdir(directory, { recursive: true });
  const checks = [], started = performance.now();
  let server;
  try {
    server = await launch(variant, directory);
    assert.equal((await request(server.baseUrl, '/api/health')).ok, true);
    const committed = await request(server.baseUrl, '/api/commit', fixture);
    assert.equal(committed.eventCount, fixture.events.length);
    checks.push('commit-six-sources');
    const carrier = await request(server.baseUrl, '/api/report');
    assert.deepEqual(carrier.events, [...fixture.events].sort((a,b) => a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId)));
    assert.deepEqual(carrier.context, fixture.context);
    assert.deepEqual(carrier.cursors[fixture.sourceId], fixture.cursor);
    checks.push('lossless-report-and-context-and-cursor');
    const cursorState = await request(server.baseUrl, '/api/cursors');
    assert.deepEqual(cursorState, { revision: carrier.revision, cursors: carrier.cursors });
    for (const expectedCursor of [null, { stale: true }]) {
      await assert.rejects(request(server.baseUrl, '/api/commit', { ...fixture, expectedCursor }), error => error.status === 409);
      assert.deepEqual(await request(server.baseUrl, '/api/report'), carrier);
    }
    checks.push('thin-cursors-and-conditional-commit-conflict');
    for (const filter of filters) {
      const query = new URLSearchParams(filter).toString();
      const expectedEvents = carrier.events.filter(event => (!filter.start || event.timestamp >= filter.start) &&
        (!filter.end || event.timestamp <= filter.end) && !(filter.excludeHomes || '').split(',').includes(event.homeId));
      const report = await request(server.baseUrl, '/api/report?' + query);
      const aggregate = await request(server.baseUrl, '/api/query?' + query);
      assert.deepEqual(report.events, expectedEvents);
      const expectedTotals = expectedEvents.reduce((sum, event) => {
        for (const key of Object.keys(sum)) sum[key] += event.total[key]; return sum;
      }, { input:0,cached:0,output:0,reasoning:0,total:0 });
      assert.deepEqual(aggregate.totals, expectedTotals);
      assert.equal(aggregate.eventCount, expectedEvents.length);
      assert.equal(aggregate.sessionCount, new Set(expectedEvents.map(event => event.sessionId)).size);
      assert.equal(aggregate.homeCount, new Set(expectedEvents.map(event => event.homeId)).size);
      assert.deepEqual({ ...aggregate, revision: undefined }, { ...aggregateEvents(expectedEvents), revision: undefined });
    }
    checks.push('range-boundary-source-exclusion-empty-native-totals');
    for (const businessFilter of businessCases) {
      assert.deepEqual(productProjection(carrier, businessFilter), productProjection({ events: carrier.events, context: fixture.context }, businessFilter));
    }
    checks.push('current-product-business-projection-eight-cases');
    const frozen = await request(server.baseUrl, '/api/freeze', {});
    const revised = structuredClone(fixture); revised.events = revised.events.slice(0, 6); revised.cursor = { count: 6, revision: 'changed' };
    const after = await request(server.baseUrl, '/api/commit', revised);
    assert.ok(Number(after.revision) > Number(committed.revision));
    assert.equal((await request(server.baseUrl, '/api/report')).events.length, 6);
    assert.deepEqual((await request(server.baseUrl, '/api/report?snapshot=' + frozen.snapshot)).events, carrier.events);
    checks.push('source-replacement-and-pinned-freeze');
    const preserved = await request(server.baseUrl, '/api/report');
    const invalid = [
      { ...fixture, events: [fixture.events[0], fixture.events[0]] },
      { ...fixture, events: [{ ...fixture.events[0], total: { ...fixture.events[0].total, input: -1 } }] },
      { ...fixture, events: [{ ...fixture.events[0], timestamp: 'garbage' }] },
      { ...fixture, events: [{ ...fixture.events[0], homeId: '' }] },
      { ...fixture, sourceId: '' },
      { ...fixture, events: [{ ...fixture.events[0], total: { ...fixture.events[0].total, total: Number.MAX_SAFE_INTEGER + 1 } }] },
    ];
    for (const bad of invalid) {
      await assert.rejects(request(server.baseUrl, '/api/commit', bad), error => error.status === 400);
      assert.deepEqual(await request(server.baseUrl, '/api/report'), preserved);
    }
    await assert.rejects(request(server.baseUrl, '/api/report?snapshot=999999999'), error => error.status === 404);
    checks.push('invalid-input-does-not-change-publication');
    await server.crash();
    server = await launch(variant, directory);
    assert.deepEqual(await request(server.baseUrl, '/api/report'), preserved);
    assert.deepEqual((await request(server.baseUrl, '/api/report?snapshot=' + frozen.snapshot)).events, carrier.events);
    checks.push('forced-process-restart-and-durable-freeze');
    await request(server.baseUrl, '/api/commit', { sourceId: 'empty-source', events: [], cursor: {} });
    assert.equal((await request(server.baseUrl, '/api/report')).events.length, 6);
    checks.push('empty-source-keeps-other-sources');
    results.push({ variant, passed: true, checks, elapsedMs: performance.now() - started });
  } catch (error) {
    results.push({ variant, passed: false, checks, error: error.stack, stderr: server?.stderr() });
  } finally { await server?.stop(); }
  await writeFile(path.join(destination, 'results.json'), JSON.stringify({ passed: results.every(result=>result.passed), results }, null, 2));
  console.log(JSON.stringify(results.at(-1)));
}
if (results.some(result=>!result.passed)) process.exitCode = 1;
