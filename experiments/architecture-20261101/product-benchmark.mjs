import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { VARIANTS, request } from './runner.mjs';
import { copyTrial, distribution, launchTrial, publishDelta } from './product-benchmark-support.mjs';

const output = path.resolve(process.argv[2] || 'output/architecture-20261102/product-benchmark');
const variants = process.argv.slice(3).length ? process.argv.slice(3) : ['b0', ...VARIANTS];
const samples = Number(process.env.ARCH_SAMPLES || 100), coldSamples = Number(process.env.ARCH_COLD_SAMPLES || 3);
assert.ok(Number.isSafeInteger(samples) && samples > 0 && coldSamples > 0);
const fixture = JSON.parse(await readFile('output/architecture-20261101/real/fixture.json', 'utf8'));
const manifest = JSON.parse(await readFile('output/architecture-20261101/real/manifest.json', 'utf8'));
const now = fixture.context.generatedAt;
const baseTotal = fixture.events.reduce((sum, e) => sum + e.total.total, 0);
const event = fixture.events.find(e => e.homeId === fixture.context.homes[0].id);
assert.ok(event);
const { chromium } = await import(pathToFileURL(process.env.ARCH_PLAYWRIGHT_MODULE));
const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCH_CHROMIUM });
const exec = promisify(execFile);
await mkdir(output, { recursive: true });
const prior = JSON.parse(await readFile(path.join(output, 'results.json'), 'utf8').catch(() => '{"results":[]}'));
const results = prior.results.filter(row => !variants.includes(row.variant));

async function resources(trial) {
  const cdp = await browser.newBrowserCDPSession();
  let info;
  try { info = await cdp.send('SystemInfo.getProcessInfo'); } finally { await cdp.detach(); }
  const serviceRoots = [trial.child.pid, trial.engine?.child.pid].filter(Boolean);
  const browserIds = info.processInfo.map(p => p.id);
  const { stdout } = await exec('pwsh', ['-NoProfile', '-Command', `$roots=@(${serviceRoots.join(',')}); $all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); $serviceIds=[System.Collections.Generic.HashSet[int]]::new(); foreach($value in $roots){[void]$serviceIds.Add($value)}; do {$added=$false; foreach($p in $all){if($serviceIds.Contains([int]$p.ParentProcessId) -and $serviceIds.Add([int]$p.ProcessId)){$added=$true}}}while($added); $ids=@($serviceIds)+@(${browserIds.join(',')}); $rows=@(Get-Process -Id $ids -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64,CPU); @{serviceIds=@($serviceIds);rows=$rows}|ConvertTo-Json -Depth 4 -Compress`], { windowsHide: true });
  const parsed = JSON.parse(stdout), service = parsed.serviceIds, list = parsed.rows;
  const sum = target => list.filter(p => target.includes(p.Id)).reduce((out, p) => ({ workingSet: out.workingSet + p.WorkingSet64, privateBytes: out.privateBytes + p.PrivateMemorySize64, cpuSeconds: out.cpuSeconds + p.CPU }), { workingSet: 0, privateBytes: 0, cpuSeconds: 0 });
  return { at: performance.now(), service: sum(service), browser: sum(browserIds), servicePids: service, browserProcessCount: browserIds.length };
}

async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(120_000);
  page.setDefaultNavigationTimeout(120_000);
  return { context, page, errors };
}

async function painted(page, total) {
  await page.waitForFunction(value => Number(document.querySelector('#totalTokens')?.title.replace(/[^0-9]/g, '')) === value, total);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function clickUsage(page, preset) {
  const started = performance.now();
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/usage?') && r.request().method() === 'GET'),
    page.evaluate(p => document.querySelector(`[data-preset="${p}"]`).click(), preset),
  ]);
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  await painted(page, body.summary.totals.total);
  return { ms: performance.now() - started, body, bytes: Buffer.byteLength(JSON.stringify(body)), timing: response.headers()['server-timing'] || null };
}

try {
  for (const variant of variants) {
    let trial, pageState;
    const raw = { cold: [], reload: [], switching: [], publication: [], stages: [], resourceSamples: [] };
    const directory = path.join(output, variant);
    let result, activeScenario = 'cold';
    try {
      if (variant === 'b0') { await mkdir(directory, { recursive: true }); await cp(manifest.databaseFile, path.join(directory, 'baseline.sqlite')); }
      else await copyTrial(variant, directory);
      for (let i = 0; i < coldSamples; i++) {
        const started = performance.now();
        trial = await launchTrial(variant, directory, { now });
        pageState = await newPage();
        const responsePromise = pageState.page.waitForResponse(r => r.url().includes('/api/usage?'));
        await pageState.page.goto(trial.baseUrl, { waitUntil: 'domcontentloaded' });
        const response = await responsePromise;
        const body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body));
        await painted(pageState.page, body.summary.totals.total);
        raw.cold.push(performance.now() - started);
        raw.stages.push({ scenario: 'cold', i, bytes: Buffer.byteLength(JSON.stringify(body)), timing: response.headers()['server-timing'] || null, startupMs: trial.startupMs });
        assert.deepEqual(pageState.errors, []);
        if (i < coldSamples - 1) { await pageState.context.close(); pageState = null; await trial.stop(); trial = null; }
      }
      const { page } = pageState;
      const initialAll = await clickUsage(page, 'all');
      raw.stages.push({ scenario: 'initial-all', ms: initialAll.ms, timing: initialAll.timing, bytes: initialAll.bytes });
      // Prime each ordinary filter once; their first-miss durations remain in stages.
      for (const preset of ['today', 'week', 'month', 'all']) {
        const r = await clickUsage(page, preset);
        raw.stages.push({ scenario: 'first-filter', preset, ms: r.ms, timing: r.timing, bytes: r.bytes });
      }
      raw.resourceSamples.push(await resources(trial));
      activeScenario = 'switching';
      for (let i = 0; i < samples; i++) {
        const preset = ['today', 'week', 'month', 'all'][i % 4];
        const r = await clickUsage(page, preset);
        raw.switching.push(r.ms);
        raw.stages.push({ scenario: 'switch', i, timing: r.timing, bytes: r.bytes });
        if ((i + 1) % 25 === 0) console.log(JSON.stringify({ variant, scenario: 'switch', done: i + 1, of: samples }));
      }
      await clickUsage(page, 'all');
      activeScenario = 'reloadWarmService';
      for (let i = 0; i < samples; i++) {
        const started = performance.now();
        const responsePromise = page.waitForResponse(r => r.url().includes('/api/usage?'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        const response = await responsePromise, body = await response.json();
        assert.equal(response.status(), 200, JSON.stringify(body));
        await painted(page, body.summary.totals.total);
        raw.reload.push(performance.now() - started);
        if ((i + 1) % 25 === 0) console.log(JSON.stringify({ variant, scenario: 'page-reload-warm-service', done: i + 1, of: samples }));
      }
      await clickUsage(page, 'all');
      activeScenario = 'publication';
      for (let i = 1; i <= samples; i++) {
        const started = performance.now();
        const committed = await publishDelta(trial, event, i, now);
        const commitMs = performance.now() - started;
        const r = await clickUsage(page, 'all');
        assert.equal(r.body.summary.totals.total, baseTotal + i * 1_000_000);
        if (trial.engine) assert.equal(r.body.fingerprint, String(committed.revision));
        await painted(page, baseTotal + i * 1_000_000);
        raw.publication.push(performance.now() - started);
        raw.stages.push({ scenario: 'publication', i, commitMs, requestToPaintMs: r.ms, timing: r.timing, bytes: r.bytes, revision: r.body.fingerprint });
        if (i % 25 === 0) { raw.resourceSamples.push(await resources(trial)); console.log(JSON.stringify({ variant, scenario: 'commit-click-paint', done: i, of: samples })); }
      }
      const beforeIdle = await resources(trial);
      await page.waitForTimeout(10_000);
      const afterIdle = await resources(trial);
      raw.resourceSamples.push(beforeIdle, afterIdle);
      if (trial.engine) raw.diagnostics = await request(trial.baseUrl, '/api/diagnostics');
      assert.deepEqual(pageState.errors, []);
      result = { variant, passed: true, cold: distribution(raw.cold), reloadWarmService: distribution(raw.reload), switching: distribution(raw.switching), publication: distribution(raw.publication),
        idleServiceCpuSeconds: afterIdle.service.cpuSeconds - beforeIdle.service.cpuSeconds,
        idleBrowserCpuSeconds: afterIdle.browser.cpuSeconds - beforeIdle.browser.cpuSeconds,
        idleObservedSeconds: (afterIdle.at - beforeIdle.at) / 1000, rawFile: path.join(directory, 'samples.json') };
    } catch (error) { result = { variant, passed: false, failedScenario: activeScenario, error: error.stack, pageErrors: pageState?.errors, stderr: trial?.stderr(),
      partial: Object.fromEntries(Object.entries(raw).filter(([, v]) => Array.isArray(v) && v.length && typeof v[0] === 'number').map(([key, value]) => [key, distribution(value)])) }; }
    finally { await pageState?.context.close(); await trial?.stop(); }
    await writeFile(path.join(directory, 'samples.json'), JSON.stringify(raw, null, 2));
    await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
    results.push(result);
    await writeFile(path.join(output, 'results.json'), JSON.stringify({ now, eventCount: fixture.events.length, samples, coldSamples,
      boundary: 'isolated indexed facts publication -> real original product page paint after explicit range click; excludes collector and automatic poll wait',
      coldScope: 'fresh gateway/backend process and browser context, OS file cache uncontrolled', resourceScope: 'sampled service RSS/private bytes and Chromium process tree, no collector', results }, null, 2));
    console.log(JSON.stringify(result));
  }
} finally { await browser.close(); }
if (results.some(r => !r.passed)) process.exitCode = 1;
