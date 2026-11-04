import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createProductServer } from './product-server.mjs';
import { productProjection } from './compat.mjs';
import { makeFixture, NOW } from './fixture.mjs';
import { launch, request, VARIANTS } from './runner.mjs';
import { copyTrial, launchTrial } from './product-benchmark-support.mjs';
import { assertBusinessEqual } from './business-parity.mjs';

const output = path.resolve(process.argv[2] || 'output/architecture-20261102/integration');
const variants = process.argv.slice(3).length ? process.argv.slice(3) : VARIANTS;
await mkdir(output, { recursive: true });
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const cases = [
  { preset: 'all', bucket: 'day', calendarZone: 'utc' },
  { preset: 'today', bucket: 'hour', calendarZone: 'utc' },
  { preset: 'week', bucket: 'day', calendarZone: 'utc' },
  { preset: 'month', bucket: 'day', calendarZone: 'local' },
  { preset: 'recent', recentValue: '1天', calendarZone: 'utc' },
  { preset: 'all', calendarZone: 'utc', excludeHomes: [] },
];
const results = [];
for (const variant of variants) {
  let engine, server, real;
  const checks = [];
  const moneyDiagnostics = { moneyDifferences: 0, maxMoneyDifference: 0 };
  try {
    const directory = path.join(output, variant, 'small-' + Date.now()); await mkdir(directory, { recursive: true });
    engine = await launch(variant, directory);
    const fixture = makeFixture(); await request(engine.baseUrl, '/api/commit', fixture);
    const full = await request(engine.baseUrl, '/api/changes'); assert.equal(full.revision, 1); assert.equal(full.reset, true);
    assert.equal(full.sources.reduce((n, s) => n + s.events.length, 0), fixture.events.length);
    const frozen = await request(engine.baseUrl, '/api/freeze', {});
    const extra = { ...fixture.events[0], eventId: 'extra', sessionId: 'extra', total: { input: 9, output: 0, cached: 0, reasoning: 0, total: 9 } };
    await request(engine.baseUrl, '/api/commit', { sourceId: 'extra', events: [extra], cursor: { version: 1 } });
    const delta = await request(engine.baseUrl, '/api/changes?since=1'); assert.equal(delta.sources.length, 1); assert.equal(delta.sources[0].sourceId, 'extra');
    assert.equal(delta.sources[0].events.length, 1); assert.equal(delta.revision, 2);
    await request(engine.baseUrl, '/api/commit', { sourceId: 'extra', events: [], cursor: { version: 2 } });
    assert.deepEqual((await request(engine.baseUrl, '/api/changes?since=2')).sources[0].events, []);
    const conflict = await fetch(engine.baseUrl + '/api/commit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: 'extra', events: [extra], cursor: {}, expectedCursor: null }) });
    assert.equal(conflict.status, 409); assert.equal((await request(engine.baseUrl, '/api/changes?since=3')).sources.length, 0);
    assert.equal((await request(engine.baseUrl, '/api/changes?snapshot=' + frozen.snapshot)).sources[0].events.length, fixture.events.length);
    checks.push('full-delta-empty-CAS-snapshot');
    server = await createProductServer({ backend: engine.baseUrl, now: NOW }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = 'http://127.0.0.1:' + server.address().port;
    const smallCarrier = await request(engine.baseUrl, '/api/report');
    for (const filters of cases) {
      const params = new URLSearchParams({ ...filters, excludeHomes: (filters.excludeHomes || [fixture.context.homes[1].id]).join(',') });
      const actual = await request(base, '/api/usage?' + params);
      const expected = productProjection(smallCarrier, { ...filters, excludeHomes: (params.get('excludeHomes') || '').split(',').filter(Boolean), now: NOW });
      assertBusinessEqual(actual.summary, expected.summary, '$.summary', moneyDiagnostics);
      assert.deepEqual(actual.periodComparison, expected.periodComparison);
      assert.equal(hash(actual.quota), hash(expected.quota));
    }
    const before = await request(base, '/api/diagnostics');
    await request(base, '/api/usage?preset=all'); const after = await request(base, '/api/diagnostics');
    assert.ok(after.feed.bytes - before.feed.bytes < 10_000, 'No repeated full feed'); checks.push('small-business-full-payload-six-filters');
    await new Promise(resolve => server.close(resolve)); server = null; await engine.stop(); engine = null;
    const realDir = path.join(output, variant, 'real-' + Date.now()); await copyTrial(variant, realDir);
    const input = JSON.parse(await readFile('output/architecture-20261101/real/fixture.json', 'utf8'));
    real = await launchTrial(variant, realDir, { now: input.context.generatedAt });
    const carrier = await request(real.engine.baseUrl, '/api/report');
    for (const filters of cases.slice(0, 4)) {
      const actual = await request(real.baseUrl, '/api/usage?' + new URLSearchParams(filters));
      const expected = productProjection(carrier, { ...filters, now: input.context.generatedAt });
      assertBusinessEqual(actual.summary, expected.summary, '$.summary', moneyDiagnostics);
      assert.equal(hash(actual.periodComparison), hash(expected.periodComparison), `${variant} real comparison ${filters.preset}`);
      assert.equal(hash(actual.metadata), hash({ ...expected.metadata, imports: [] }));
    }
    checks.push('real-159610-four-business-projections');
    const currentFilters = { preset: 'all', bucket: 'day', calendarZone: 'utc', now: input.context.generatedAt };
    const added = { ...input.events[0], eventId: 'real-incremental-check', sessionId: 'real-incremental-check', timestamp: input.context.generatedAt,
      total: { total: 1000001, input: 1000000, cached: 0, output: 1, reasoning: 0 } };
    for (const events of [[added], [{ ...added, total: { ...added.total, total: 2000001, input: 2000000 } }], []]) {
      const before = await request(real.baseUrl, '/api/diagnostics');
      await request(real.engine.baseUrl, '/api/commit', { sourceId: 'real-incremental-check', events, cursor: { update: events[0]?.total.total || 0 } });
      const actual = await request(real.baseUrl, '/api/usage?preset=all&bucket=day&calendarZone=utc');
      const expected = productProjection(await request(real.engine.baseUrl, '/api/report'), currentFilters);
      assertBusinessEqual(actual.summary, expected.summary, '$.summary', moneyDiagnostics);
      assert.deepEqual(actual.periodComparison, expected.periodComparison);
      assert.deepEqual(actual.metadata, { ...expected.metadata, imports: [] });
      const after = await request(real.baseUrl, '/api/diagnostics');
      assert.equal(after.projection.sourceViews.preparedEvents - before.projection.sourceViews.preparedEvents, events.length);
      assert.equal(after.projection.sourceViews.partEvents - before.projection.sourceViews.partEvents, events.length);
      assert.ok(after.feed.bytes - before.feed.bytes < 10000, 'unchanged real context was retransferred');
    }
    checks.push('real-small-replacement-empty-only-changed-source-no-context-transfer');
    results.push({ variant, passed: true, checks, moneyDiagnostics });
  } catch (error) { results.push({ variant, passed: false, checks, error: error.stack, stderr: engine?.stderr() || real?.stderr() }); }
  finally { if (server) await new Promise(resolve => server.close(resolve)); await engine?.stop(); await real?.stop(); }
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: results.every(r => r.passed), results }, null, 2));
  console.log(JSON.stringify(results.at(-1)));
}
if (results.some(r => !r.passed)) process.exitCode = 1;
