import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { cp, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { ROOT, launch, request } from './runner.mjs';

export const ORIGINAL_RESULTS = path.resolve('output/architecture-20261101/real-results');
export async function copyTrial(variant, directory) {
  await mkdir(directory, { recursive: true });
  const entries = await readdir(ORIGINAL_RESULTS, { withFileTypes: true });
  const prior = entries.filter(e => e.isDirectory() && e.name.startsWith(variant + '-')).map(e => e.name).sort().at(-1);
  assert.ok(prior, 'No imported real database for ' + variant);
  const extension = variant.endsWith('redb') ? '.redb' : variant.endsWith('duckdb') ? '.duckdb' : '.sqlite';
  const name = variant + extension;
  await cp(path.join(ORIGINAL_RESULTS, prior, name), path.join(directory, name));
  return directory;
}

export async function childServer(script, args = [], now) {
  const child = spawn(process.execPath, ['--max-old-space-size=2048', '--report-on-fatalerror', '--report-directory=' + path.resolve('output/architecture-20261102'), '--import', pathToFileURL(path.join(ROOT, 'benchmark-clock.mjs')).href, path.join(ROOT, script), ...args],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...(now ? { ARCH_BENCH_NOW: now } : {}) } });
  let stderr = '', pending = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(Error('Server timeout: ' + stderr)); }, 120_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(Error(`Server exited ${code}: ${stderr}`)); });
    child.stdout.on('data', chunk => {
      pending += chunk;
      let split;
      while ((split = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, split); pending = pending.slice(split + 1);
        try { const message = JSON.parse(line); if (message.port) { clearTimeout(timer); resolve(message); } } catch {}
      }
    });
  });
  return { child, baseUrl: `http://127.0.0.1:${ready.port}`, stderr: () => stderr,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = once(child, 'exit'); child.kill();
      await done;
    } };
}

export async function launchTrial(variant, directory, { now, mode = 'incremental' } = {}) {
  let engine, gateway;
  const started = performance.now();
  try {
    if (variant === 'b0') {
      const database = path.join(directory, 'baseline.sqlite');
      gateway = await childServer('b0-server.mjs', ['--database', database, '--directory', directory], now);
      return { ...gateway, database, startupMs: performance.now() - started };
    }
    engine = await launch(variant, directory);
    gateway = await childServer('product-server.mjs', ['--backend', engine.baseUrl, '--port', '0', '--mode', mode, ...(now ? ['--now', now] : [])], now);
    return { ...gateway, engine, startupMs: performance.now() - started,
      async stop() { await gateway.stop(); await engine.stop(); } };
  } catch (error) { await gateway?.stop(); await engine?.stop(); throw error; }
}

// All variants start at the same boundary: validated facts being published into an isolated index.
// This excludes source detection/decoding. The original collector is measured separately.
export async function publishDelta(trial, event, sample, now) {
  const tokens = 1_000_000 * sample;
  const delta = { ...event, eventId: 'architecture-visible-delta', sessionId: 'architecture-visible-delta', timestamp: now,
    total: { input: tokens, cached: 0, output: 0, reasoning: 0, total: tokens } };
  if (trial.engine) {
    return request(trial.engine.baseUrl, '/api/commit', { sourceId: 'architecture-visible-delta', events: [delta], cursor: { sample } });
  }
  const db = new DatabaseSync(trial.database);
  try {
    db.exec('BEGIN IMMEDIATE');
    const row = db.prepare('SELECT * FROM events WHERE home_id = ? LIMIT 1').get(event.homeId);
    assert.ok(row, 'B0 needs an existing home/source for the controlled delta');
    delete row.id;
    const date = new Date(now), localDay = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    Object.assign(row, { timestamp_ms: date.getTime(), session_id: delta.sessionId,
      total: tokens, input: tokens, cached: 0, output: 0, reasoning: 0, cache_write_tokens: 0, request_input_tokens: tokens,
      day_key: localDay, month_key: localDay.slice(0, 7), hour_key: `${localDay}T${String(date.getHours()).padStart(2, '0')}` });
    db.prepare('DELETE FROM events WHERE session_id = ?').run(delta.sessionId);
    const columns = Object.keys(row);
    db.prepare(`INSERT INTO events (${columns.map(c => `"${c}"`).join(',')}) VALUES (${columns.map(() => '?').join(',')})`).run(...Object.values(row));
    db.prepare('INSERT OR REPLACE INTO store_meta(key,value) VALUES (?,?)').run('fingerprint', 'architecture-delta-' + sample);
    db.prepare('INSERT OR REPLACE INTO store_meta(key,value) VALUES (?,?)').run('generated_at', now);
    db.exec('COMMIT');
    return { revision: 'architecture-delta-' + sample };
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  finally { db.close(); }
}

export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  assert.ok(sorted.length);
  return { n: sorted.length, p50: sorted[Math.ceil(sorted.length * .5) - 1], p95: sorted[Math.ceil(sorted.length * .95) - 1], max: sorted.at(-1),
    over200ms: sorted.filter(v => v > 200).length, over1000ms: sorted.filter(v => v > 1000).length };
}
