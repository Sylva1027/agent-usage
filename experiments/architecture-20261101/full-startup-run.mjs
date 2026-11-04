import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve('experiments/architecture-20261101');
const base = path.resolve('output/architecture-20261102/full-startup');
const name = process.argv[2] || 'formal-live-1';
const seed = path.resolve(process.env.ARCH_STATE_SEED || path.join(base, 'seed'));
const output = path.join(base, name); await mkdir(base, { recursive: true }); await mkdir(output);
const state = path.join(output, 'state'); await cp(seed, state, { recursive: true, preserveTimestamps: true });
const protoDirectory = path.join(output, 'prototype');
if (process.env.ARCH_STARTUP_PROTO_SEED) await cp(path.resolve(process.env.ARCH_STARTUP_PROTO_SEED), protoDirectory, { recursive: true, preserveTimestamps: true });
const manifest = JSON.parse(await readFile(path.join(seed, 'state-manifest.json'), 'utf8'));
const services = path.join(output, 'services.json');
const { chromium } = await import(pathToFileURL(process.env.ARCH_PLAYWRIGHT_MODULE || 'C:/Users/Silver/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.ARCH_CHROMIUM || 'C:/Users/Silver/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe' });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const timeoutMs = Number(process.env.ARCH_STARTUP_TIMEOUT_MS || 600_000);
assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
const page = await context.newPage(); page.setDefaultTimeout(timeoutMs); page.setDefaultNavigationTimeout(timeoutMs);
const result = { name, seed, output, trace: process.env.ARCH_NO_TRACE !== '1', processCold: true, osCacheFlushed: false, startedAt: new Date().toISOString(), requests: [], errors: [] };
page.on('pageerror', error => result.errors.push(error.message));
page.on('requestfailed', request => result.errors.push({ url: new URL(request.url()).pathname, failure: request.failure() }));
const start = performance.now(); const elapsed = () => performance.now() - start;
page.on('response', response => { if (response.url().includes('/api/')) result.requests.push({ url: new URL(response.url()).pathname + new URL(response.url()).search, status: response.status(), at: elapsed(), timing: response.request().timing() }); });
let service, child, sampler, serviceWatch;
const samplerStop = path.join(output, 'resource-stop');
const heavyHooks = process.env.ARCH_NO_TRACE !== '1' || process.env.ARCH_STARTUP_SERVER_WRAPPER || process.env.ARCH_STARTUP_BRIDGE === '1' || process.env.ARCH_STARTUP_EXPORT_ROWS === '1';
const configurationHooks = heavyHooks ? ['startup-trace.mjs'] : process.env.ARCH_STARTUP_OPTIONS_FILE ? ['startup-options.mjs'] : [];
result.configurationHook = heavyHooks ? 'trace-compiler' : configurationHooks.length ? 'light-options' : 'none';
const preload = ['startup-state-overlay.mjs', ...(process.env.ARCH_STARTUP_REPLAY_FILE ? ['startup-replay.mjs'] : []), ...(process.env.ARCH_STARTUP_FS_AUDIT_DIR ? ['startup-fs-audit.mjs'] : []), 'startup-telemetry.mjs', ...(process.env.ARCH_B1_BASELINE === '1' ? ['b1-baseline.mjs'] : []), ...(process.env.ARCH_DSH_BASELINE_FILE ? ['dsh-stage-baseline.mjs'] : []), ...(process.env.ARCH_DSH_PROBE_DIR ? ['dsh-stage-probe.mjs'] : []), ...configurationHooks];
const env = { ...process.env, NODE_OPTIONS: preload.map(file => '--import=' + pathToFileURL(path.join(root, file)).href).join(' '), ARCH_STARTUP_STATE_MAP: JSON.stringify({ logicalRoot: manifest.logicalRoot, physicalRoot: state }), ARCH_STARTUP_RESULT_DIR: output };
if (process.env.ARCH_FATAL_REPORT === '1') env.NODE_OPTIONS += ` --report-on-fatalerror --report-directory="${output.replaceAll('\\', '/')}"`;
if (process.env.ARCH_STARTUP_SQL_DIR) env.NODE_OPTIONS += ' --import=' + pathToFileURL(path.join(root, 'startup-sql-probe.mjs')).href;
if (process.env.ARCH_STARTUP_CUMULATIVE_INDEX === '1') env.NODE_OPTIONS += ' --import=' + pathToFileURL(path.join(root, 'startup-cumulative-index.mjs')).href;
if (process.env.ARCH_B1_PHASES === '1') env.NODE_OPTIONS += ' --import=' + pathToFileURL(path.join(root, 'b1-phase-probe.mjs')).href;
if (process.env.ARCH_STARTUP_PROTO_SEED) env.ARCH_STARTUP_PROTO_DIR = protoDirectory;
if (result.trace) env.ARCH_STARTUP_TRACE_DIR = path.join(output, 'trace'); else delete env.ARCH_STARTUP_TRACE_DIR;
try {
  child = spawn(process.execPath, ['src/cli.js', 'gateway', '--host', '127.0.0.1', '--port', '0', '--state-file', services, ...(process.env.ARCH_STARTUP_HOME_DIR ? ['--home-dir', process.env.ARCH_STARTUP_HOME_DIR] : [])], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', chunk => logs += chunk); child.stderr.on('data', chunk => logs += chunk);
  service = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Gateway registration timeout: ' + logs)), 60_000);
    child.once('error', reject); child.on('exit', async code => { clearTimeout(timer); if (code) return reject(Error('Gateway exited ' + code + ': ' + logs)); try { const json = JSON.parse(await readFile(services, 'utf8')); resolve((Array.isArray(json) ? json : json.services)[0]); } catch (error) { reject(error); } });
  });
  result.listenMs = elapsed(); result.servicePid = service.pid; result.gatewayLogs = logs;
  console.log(JSON.stringify({ name, stage: 'listening', ms: result.listenMs, pid: service.pid }));
  if (process.env.ARCH_RESOURCE_SAMPLER === '1') {
    sampler = spawn('pwsh', ['-NoProfile', '-File', path.join(root, 'growth-resource-sampler.ps1'), '-ResultDir', output, '-ServicePid', String(service.pid), '-RunnerPid', String(process.pid), '-StopFile', samplerStop], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    sampler.stdout.on('data', chunk => console.log(String(chunk).trim()));
    sampler.stderr.on('data', chunk => console.error(String(chunk).trim()));
  }
  const serviceGone = new Promise((resolve,reject) => {
    serviceWatch = setInterval(() => { try { process.kill(service.pid, 0); } catch(error) { if (error.code === 'ESRCH') reject(Error('Gateway process disappeared before first response')); } }, 1000);
  });
  // A dead gateway cannot finish the outstanding browser request.
  const firstResponse = Promise.race([page.waitForResponse(r => r.url().includes('/api/usage?')), serviceGone]);
  firstResponse.catch(() => {});
  await page.goto(service.url, { waitUntil: 'domcontentloaded' }); result.domContentMs = elapsed();
  const response = await firstResponse; const body = await response.json(); result.apiCompleteMs = elapsed();
  result.status = response.status(); result.bodyBytes = Buffer.byteLength(JSON.stringify(body)); result.summaryCache = response.headers()['x-summary-cache'];
  result.serverTiming = response.headers()['server-timing'];
  await writeFile(path.join(output, 'first-response.json'), JSON.stringify(body));
  assert.equal(response.status(), 200, JSON.stringify(body));
  const total = body.summary.totals.total; assert.ok(Number.isFinite(total));
  await page.waitForFunction(n => { const title = document.querySelector('#totalTokens')?.title; return Boolean(title) && Number(title.replace(/[^0-9]/g, '')) === n; }, total);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  result.firstPaintMs = elapsed(); result.total = total; result.metadata = body.metadata;
  console.log(JSON.stringify({ name, stage: 'first-paint', ms: result.firstPaintMs, total }));
  result.filters = [];
  if (process.env.ARCH_FIRST_ONLY !== '1') for (const preset of ['all', 'today', 'week', 'month', 'all']) {
    const t = elapsed(); const waiting = page.waitForResponse(r => r.url().includes('/api/usage?'));
    await page.evaluate(p => document.querySelector(`[data-preset="${p}"]`).click(), preset);
    const response = await waiting, body = await response.json(); assert.equal(response.status(), 200, JSON.stringify(body));
    await writeFile(path.join(output, `response-${preset}.json`), JSON.stringify(body));
    await page.waitForFunction(n => { const title = document.querySelector('#totalTokens')?.title; return Boolean(title) && Number(title.replace(/[^0-9]/g, '')) === n; }, body.summary.totals.total);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    result.filters.push({ preset, ms: elapsed() - t, total: body.summary.totals.total, cache: response.headers()['x-summary-cache'] });
    console.log(JSON.stringify({ name, stage: 'filter', ...result.filters.at(-1) }));
  }
  if (process.env.ARCH_STARTUP_SERVER_WRAPPER) result.productDiagnostics = await fetch(service.url + '/api/diagnostics').then(r => r.json());
  const ps = `$roots=@(${service.pid}); $all=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId); $ids=[System.Collections.Generic.HashSet[int]]::new(); foreach($value in $roots){[void]$ids.Add($value)}; do {$added=$false; foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$added=$true}}}while($added); @(Get-Process -Id @($ids) -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,WorkingSet64,PrivateMemorySize64,CPU)|ConvertTo-Json -Compress`;
  const sampled = await promisify(execFile)('pwsh', ['-NoProfile', '-Command', ps], { windowsHide: true });
  result.resourceSample = JSON.parse(sampled.stdout); result.resourceSampleAtMs = elapsed();
} catch (error) { result.failure = error.stack; console.error(error.stack); process.exitCode = 1;
} finally {
  clearInterval(serviceWatch);
  const measuredErrors = [...result.errors];
  result.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  if (service) { try { await fetch(service.url + '/internal/shutdown', { method: 'POST', headers: { 'x-codex-usage-shutdown-token': service.shutdownToken }, signal: AbortSignal.timeout(10_000) }); } catch {} }
  await browser.close();
  if (sampler) {
    const stopped = new Promise(resolve => { if (sampler.exitCode !== null) resolve(); else sampler.once('exit', resolve); });
    await writeFile(samplerStop, 'stop');
    await stopped;
    result.samplerExitCode = sampler.exitCode;
    try { result.resourceSummary = JSON.parse(await readFile(path.join(output, 'resource-summary.json'), 'utf8')); }
    catch (error) { result.samplerFailure = error.message; }
    result.errors = measuredErrors;
    await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  }
}
