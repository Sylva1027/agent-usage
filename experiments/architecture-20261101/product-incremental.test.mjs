import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startServer } from './node/server.mjs';
import { createProductServer } from './product-server.mjs';
import { makeFixture, NOW } from './fixture.mjs';
import { request } from './runner.mjs';
import { productProjection } from './compat.mjs';
import { assertBusinessEqual } from './business-parity.mjs';

test('incremental gateway publishes only changed source work and keeps frozen facts independent', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'architecture-business-view-'));
  let backend, server;
  try {
    backend = await startServer({ database: path.join(directory, 'index.sqlite'), port: 0 });
    const fixture = makeFixture(36);
    await request(backend.baseUrl, '/api/commit', { ...fixture, sourceId: 'a', events: fixture.events.slice(0, 18) });
    await request(backend.baseUrl, '/api/commit', { sourceId: 'b', events: fixture.events.slice(18), cursor: { n: 1 } });
    server = await createProductServer({ backend: backend.baseUrl, now: NOW });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = 'http://127.0.0.1:' + server.address().port;
    const route = '/api/usage?preset=all&calendarZone=utc';
    await request(url, route);
    const before = await request(url, '/api/diagnostics');
    const frozen = await request(url, route + '&freeze=1');
    const event = { ...fixture.events[0], eventId: 'updated', sessionId: 'visible-update', total: { input: 1000000, output: 1, cached: 0, reasoning: 0, total: 1000001 } };
    await request(backend.baseUrl, '/api/commit', { sourceId: 'b', events: [event], cursor: { n: 2 } });
    const live = await request(url, route);
    const expected = productProjection(await request(backend.baseUrl, '/api/report'), { preset: 'all', calendarZone: 'utc', now: NOW });
    assertBusinessEqual(live.summary, expected.summary);
    assertBusinessEqual(live.periodComparison, expected.periodComparison);
    assert.equal(live.fingerprint, '3');
    const after = await request(url, '/api/diagnostics');
    assert.equal(after.query.requests, 0, 'materialized business views own their aggregates');
    // Snapshot initialization adds its own old-source contributions; the live update still adds one event.
    assert.equal(after.projection.sourceViews.preparedEvents - before.projection.sourceViews.preparedEvents, 37);
    const stillFrozen = await request(url, route + '&snapshot=' + frozen.snapshotId);
    assert.equal(stillFrozen.summary.totals.total, frozen.summary.totals.total);
    assert.equal(stillFrozen.periodComparison.asOf, frozen.periodComparison.asOf);
    const stable = await request(url, route), repeated = await request(url, route);
    assertBusinessEqual(stable.summary, repeated.summary);
    const last = await request(url, '/api/diagnostics');
    assert.equal(last.projection.sourceViews.partBuilds, after.projection.sourceViews.partBuilds);
    assert.ok(last.feed.bytes - after.feed.bytes < 10000);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await backend?.close(); await rm(directory, { recursive: true, force: true });
  }
});
