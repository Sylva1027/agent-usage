import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { VARIANTS, request } from './runner.mjs';
import { makeFixture } from './fixture.mjs';
import { launchTrial } from './product-benchmark-support.mjs';

const output = path.resolve(process.argv[2] || 'output/architecture-20261102/live');
await mkdir(output, { recursive: true });
const { chromium } = await import(pathToFileURL(process.env.ARCH_PLAYWRIGHT_MODULE));
const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCH_CHROMIUM });
const results = [];
async function painted(page, total) {
  await page.waitForFunction(n => Number(document.querySelector('#totalTokens')?.title.replace(/[^0-9]/g, '')) === n, total, { timeout: 90_000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function action(page, selector) {
  const [response] = await Promise.all([page.waitForResponse(r => r.url().includes('/api/usage?'), { timeout: 90_000 }), page.locator(selector).click()]);
  const body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body));
  await painted(page, body.summary.totals.total); return body;
}
try {
  // Concurrent correctness checks only. These single 60s waits are not a ranking benchmark.
  const settled = await Promise.allSettled(VARIANTS.map(async variant => {
    const directory = path.join(output, variant + '-' + Date.now()); await mkdir(directory, { recursive: true });
    let trial, context;
    try {
      trial = await launchTrial(variant, directory);
      const fixture = makeFixture(24); fixture.context.generatedAt = new Date().toISOString();
      await request(trial.engine.baseUrl, '/api/commit', fixture);
      context = await browser.newContext(); const page = await context.newPage(); const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(trial.baseUrl); await page.waitForSelector('#totalTokens[title]');
      const initial = await action(page, '[data-preset="all"]');
      const frozen = await action(page, '#autoRefreshToggle');
      assert.ok(frozen.snapshotId);
      const oldTotal = initial.summary.totals.total;
      const delta = { ...fixture.events[0], eventId: 'live-visible', sessionId: 'live-visible', timestamp: new Date().toISOString(), total: { input: 17_000_000, cached: 0, output: 0, reasoning: 0, total: 17_000_000 } };
      await request(trial.engine.baseUrl, '/api/commit', { sourceId: 'live-added', events: [delta], cursor: { n: 1 } });
      const frozenAgain = await action(page, '[data-preset="all"]');
      assert.equal(frozenAgain.summary.totals.total, oldTotal); assert.equal(frozenAgain.snapshotId, frozen.snapshotId);
      assert.equal(frozenAgain.periodComparison.asOf, frozen.periodComparison.asOf);
      const resumed = await action(page, '#autoRefreshToggle');
      assert.equal(resumed.summary.totals.total, oldTotal + 17_000_000); assert.equal(resumed.fingerprint, '2');
      const started = performance.now(), startedAt = Date.now();
      delta.total.input = delta.total.total = 19_000_000; delta.timestamp = new Date().toISOString();
      const responsePromise = page.waitForResponse(r => r.url().includes('/api/usage?'), { timeout: 90_000 });
      await request(trial.engine.baseUrl, '/api/commit', { sourceId: 'live-added', events: [delta], cursor: { n: 2 } });
      const response = await responsePromise, automatic = await response.json();
      assert.equal(response.status(), 200); assert.equal(automatic.fingerprint, '3'); assert.equal(automatic.summary.totals.total, oldTotal + 19_000_000);
      assert.ok(Date.parse(automatic.periodComparison.asOf) >= startedAt);
      await painted(page, oldTotal + 19_000_000);
      assert.deepEqual(errors, []);
      return { variant, passed: true, autoCommitToPaintMs: performance.now() - started, fixedClock: false, automaticIntervalMs: 60_000,
        checks: ['freeze-retains-facts-and-asOf', 'resume-displays-new-version', 'automatic-with-no-user-action-displays-exact-next-revision', 'default-live-clock'] };
    } finally { await context?.close(); await trial?.stop(); }
  }));
  for (let i = 0; i < settled.length; i++) {
    const item = settled[i]; results.push(item.status === 'fulfilled' ? item.value : { variant: VARIANTS[i], passed: false, error: item.reason.stack });
  }
} finally { await browser.close(); }
await writeFile(path.join(output, 'results.json'), JSON.stringify({ passed: results.every(r => r.passed), scope: 'small fixture live-clock correctness and one natural automatic interval each, concurrent; not p95 or architecture ranking', results }, null, 2));
for (const result of results) console.log(JSON.stringify(result));
if (results.some(r => !r.passed)) process.exitCode = 1;
