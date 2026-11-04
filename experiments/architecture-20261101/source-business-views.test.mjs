import assert from 'node:assert/strict';
import test from 'node:test';
import { SourceBusinessViews } from './source-business-views.mjs';
import { makeFixture, NOW } from './fixture.mjs';
import { productProjection } from './compat.mjs';
import { getPricingCatalog } from '../../src/pricing.js';
import { assertBusinessEqual } from './business-parity.mjs';

function carrier(fixture, revision = 1) {
  return { revision, context: fixture.context, sources: new Map(['a', 'b', 'c'].map((key, i) => [key, { events: fixture.events.filter((_, j) => j % 3 === i) }])) };
}
function compare(engine, input, filters = {}, now = NOW, catalog = getPricingCatalog(), snapshot = null) {
  const expected = productProjection(engine.materialize(input), { ...filters, now, pricingCatalog: catalog });
  const actual = engine.project(input, filters, { asOf: now, pricingCatalog: catalog, snapshot });
  assertBusinessEqual(actual, expected);
  return actual;
}

test('source views match all original business fields over ranges and home exclusion', () => {
  const fixture = makeFixture(180), input = carrier(fixture), engine = new SourceBusinessViews();
  for (const zone of ['utc', 'local']) for (const preset of ['all', 'today', 'week', 'month', 'custom', 'recent']) {
    compare(engine, input, { preset, calendarZone: zone, bucket: preset === 'today' ? 'hour' : 'day', startDate: '2026-10-28', endDate: '2026-11-01', recentValue: '1天' });
    compare(engine, input, { preset, calendarZone: zone, excludeHomes: [fixture.context.homes[1].id], startDate: '2026-10-28', endDate: '2026-11-01', recentValue: '1天' });
  }
  for (const preset of ['quota_5h', 'quota_week']) compare(engine, input, { preset, calendarZone: 'utc' });
});

test('one source replacement reuses untouched contributions and session identity across sources', () => {
  const fixture = makeFixture(36);
  fixture.events.forEach((event, i) => { event.sessionId = 'shared-' + i % 2; event.repositoryKey = 'shared-repo'; });
  const input = carrier(fixture), engine = new SourceBusinessViews();
  compare(engine, input, { preset: 'all', calendarZone: 'utc' });
  const prepared = engine.stats.preparedEvents, built = engine.stats.partEvents;
  const sources = new Map(input.sources);
  sources.set('b', { events: [{ ...fixture.events[0], eventId: 'replacement', total: { total: 7, input: 6, cached: 0, output: 1, reasoning: 0 } }] });
  const next = { ...input, revision: 2, sources };
  compare(engine, next, { preset: 'all', calendarZone: 'utc' });
  assert.equal(engine.stats.preparedEvents - prepared, 1);
  assert.equal(engine.stats.partEvents - built, 1);
  sources.set('b', { events: [] });
  compare(engine, { ...next, revision: 3, sources: new Map(sources) }, { preset: 'all', calendarZone: 'utc' });
  compare(engine, input, { preset: 'all', calendarZone: 'utc' }, NOW, getPricingCatalog(), 'old-frozen-view');
});

test('live clock, date boundary and catalog invalidate only the applicable view', () => {
  const fixture = makeFixture(48), input = carrier(fixture), engine = new SourceBusinessViews();
  for (const now of [NOW, '2026-11-01T12:00:10.000Z', '2026-11-02T00:00:00.000Z', '2026-10-31T23:59:59.000Z']) {
    compare(engine, input, { preset: 'today', calendarZone: 'utc' }, now);
  }
  const catalog = structuredClone(getPricingCatalog()); catalog.version += '-changed'; catalog.checkedAt = '2026-11-02T00:00:00.000Z';
  compare(engine, input, { preset: 'all', calendarZone: 'utc' }, NOW, catalog);
  compare(engine, input, { preset: 'all', calendarZone: 'utc' }, NOW, getPricingCatalog());
});

test('empty input and an empty selected range preserve full zero structures', () => {
  const fixture = makeFixture(0), engine = new SourceBusinessViews();
  compare(engine, carrier(fixture), { preset: 'all' });
  compare(engine, carrier(makeFixture(24)), { preset: 'custom', startDate: '2000-01-01', endDate: '2000-01-02', calendarZone: 'utc' });
  const populated = makeFixture(24);
  compare(engine, carrier(populated), { preset: 'all', excludeHomes: populated.context.homes.map(h => h.id) });
  compare(engine, carrier(populated), { preset: 'all', excludeHomes: [populated.context.homes[0].id, populated.context.homes.at(-1).id] });
  const noContext = { revision: 1, context: {}, sources: new Map() };
  compare(engine, noContext, { preset: 'all' });
  compare(engine, noContext, { preset: 'all' }, '2026-11-01T12:00:10.000Z');
});
