import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { isQuotaUsage } from '../../public/quota-usage.js';

const label = process.argv[2], command = process.argv[3];
assert.match(label || '', /^[a-z0-9-]+$/i);
const root = path.resolve('output/architecture-20261103/b1', label);
const scales = [{ scale: '1x', points: 100000 }, { scale: '5x', points: 500000 }, { scale: '10x', points: 1000000 }];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

if (command === 'prepare-ready') {
  const sourceLabel = process.argv[4]; assert.match(sourceLabel || '', /^[a-z0-9-]+$/i);
  const previous = JSON.parse(await readFile(path.resolve('output/architecture-20261103/b1', sourceLabel, 'manifest.json'), 'utf8'));
  await mkdir(root);
  const cases = [];
  for (const entry of previous.cases) {
    const directory = path.join(root, entry.scale); await mkdir(directory);
    const file = path.join(directory, 'candidate.sqlite');
    const source = new DatabaseSync(entry.file, { readOnly: true });
    try {
      await backup(source, file);
      if (entry.scale !== '5x') await backup(source, path.join(directory, 'baseline.sqlite'));
    } finally { source.close(); }
    cases.push({ ...entry, directory, file });
  }
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ cases, sourceLabel,
    note: 'Same facts and classification points as the completed source label, with derived tables already prepared. Query-only timing excludes open and independent integrity verification; total child time remains reported.' }, null, 2), { flag: 'wx' });
} else if (command === 'prepare') {
  await mkdir(root);
  const { UsageStore } = await import('../../src/usage-store.js');
  const source = new DatabaseSync(path.resolve('output/architecture-20261102/full-startup/growth-standard-light-1-1x/state/usage-index.sqlite'), { readOnly: true });
  const cases = [];
  try {
    for (const spec of scales) {
      const directory = path.join(root, spec.scale); await mkdir(directory);
      const file = path.join(directory, 'candidate.sqlite'); await backup(source, file);
      const store = new UsageStore({ databaseFile: file, env: {}, importDirs: [] });
      try {
        await store.open(); const database = store.database;
        const home = database.prepare("SELECT home_id FROM source_files WHERE kind IN ('main','extra','jetbrains','codex') LIMIT 1").get().home_id;
        const observationPath = database.prepare('SELECT path FROM source_files WHERE home_id=? LIMIT 1').get(home).path;
        const sessions = database.prepare('SELECT DISTINCT session_id FROM events WHERE home_id=? ORDER BY session_id').all(home).map(row => row.session_id);
        assert.ok(sessions.length);
        const maximum = Number(database.prepare('SELECT MAX(timestamp_ms) value FROM events').get().value);
        const asOf = maximum + 3600000, end = asOf + 3600000, start = end - 10080 * 60000;
        database.exec('BEGIN');
        database.exec('DELETE FROM quota_usage_sources; DELETE FROM rate_limit_observations');
        database.prepare("DELETE FROM store_meta WHERE key IN ('quota_source_log_evidence','official_quota_observations')").run();
        const insert = database.prepare(`INSERT INTO quota_usage_sources
          (source_path,home_id,session_id,timestamp_ms,quota_source,until_ms) VALUES ('lookup-history',?,?,?,'plan',0)`);
        for (let i = 0; i < spec.points; i++) insert.run(home, sessions[i % sessions.length], maximum - 30 * 86400000 + i * 1000);
        const observation = database.prepare(`INSERT INTO rate_limit_observations
          (source_path,line_number,role,limit_id,observed_at_ms,window_minutes,resets_at_ms,used_percent)
          VALUES (?,1,?,'lookup',?,?,?,10)`);
        observation.run(observationPath, 'primary', asOf - 1000, 300, end);
        observation.run(observationPath, 'secondary', asOf - 1000, 10080, end);
        database.exec('COMMIT');
        const models = database.prepare('SELECT DISTINCT model FROM events WHERE home_id=?').all(home)
          .map(row => row.model).filter(model => isQuotaUsage({ model, quotaSource: 'plan' }));
        assert.ok(models.length);
        const expected = database.prepare(`SELECT COUNT(*) events, COUNT(DISTINCT session_id) sessions,
          SUM(total) total,SUM(input) input,SUM(cached) cached,SUM(output) output,SUM(reasoning) reasoning
          FROM events WHERE home_id=? AND timestamp_ms>=? AND timestamp_ms<? AND model IN (${models.map(() => '?').join(',')})`).get(home, start, end, ...models);
        assert.ok(expected.events > 0);
        assert.equal(database.prepare('SELECT COUNT(*) value FROM events').get().value, 146412);
        assert.equal(database.prepare('SELECT COUNT(*) value FROM quota_usage_sources').get().value, spec.points);
        const before = database.prepare('SELECT COUNT(*) events,SUM(total) total FROM events').get();
        cases.push({ ...spec, directory, file, asOf, expected, before, home, sessionInventory: sessions.length });
      } finally { store.close(); }
      if (spec.scale !== '5x') {
        const database = new DatabaseSync(file, { readOnly: true });
        try { await backup(database, path.join(directory, 'baseline.sqlite')); } finally { database.close(); }
      }
    }
  } finally { source.close(); }
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ cases, note: 'Fixed 146412 events and six homes; only historical classification points grow. Controlled plan states and two current quota observations isolate this path.' }, null, 2), { flag: 'wx' });
} else if (command === '__child') {
  const scale = process.argv[4], implementation = process.argv[5];
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const entry = manifest.cases.find(value => value.scale === scale); assert.ok(entry);
  const { UsageStore } = await import('../../src/usage-store.js');
  const store = new UsageStore({ databaseFile: path.join(entry.directory, `${implementation}.sqlite`), env: {}, importDirs: [] });
  let payload;
  try {
    const started = performance.now(), cpu = process.cpuUsage();
    await store.open();
    store.homes = store.database.prepare(`SELECT home_id id,MAX(home_label) label,MAX(home_path) path,
      CASE WHEN kind IN ('main','extra','jetbrains') THEN 'codex' ELSE kind END kind FROM source_files GROUP BY home_id,kind ORDER BY home_id,kind`).all();
    const queryStarted = performance.now(), queryCpuStarted = process.cpuUsage();
    const result = await store.dashboardHistory({ preset: 'quota_week', now: new Date(entry.asOf), bucket: 'day' });
    const queryMs = performance.now() - queryStarted, queryCpu = process.cpuUsage(queryCpuStarted);
    assert.equal(result.summary.quota.windows.quota_week.state, 'available');
    assert.equal(result.summary.eventCount, entry.expected.events);
    assert.equal(result.summary.sessionCount, entry.expected.sessions);
    for (const field of ['total','input','cached','output','reasoning']) assert.equal(result.summary.totals[field], entry.expected[field], field);
    assert.deepEqual({ ...store.database.prepare('SELECT COUNT(*) events,SUM(total) total FROM events').get() }, entry.before);
    assert.equal(store.database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    const used = process.cpuUsage(cpu);
    payload = { passed: true, scale, implementation, elapsedMs: performance.now() - started,
      cpuMs: (used.user + used.system) / 1000, queryMs, queryCpuMs: (queryCpu.user + queryCpu.system) / 1000,
      osPeakRssBytes: process.resourceUsage().maxRSS * 1024, oldSpaceMiB: 224, result };
  } catch (error) { payload = { passed: false, scale, implementation, error: { message: error.message, stack: error.stack } }; process.exitCode = 1; }
  finally { store.close(); }
  await writeFile(path.join(entry.directory, `${implementation}.json`), JSON.stringify(payload), { flag: 'wx' });
} else if (command === 'run') {
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const runs = [];
  for (const entry of manifest.cases) {
    for (const implementation of entry.scale === '5x' ? ['candidate'] : ['baseline', 'candidate']) {
      const flags = ['--max-old-space-size=224','--max-semi-space-size=4','--report-on-fatalerror',`--report-directory=${entry.directory}`];
      if (implementation === 'baseline') flags.push('--import', pathToFileURL(path.resolve('experiments/architecture-20261101/b1-baseline.mjs')).href);
      const env = { ...process.env }; delete env.NODE_OPTIONS;
      const child = spawn(process.execPath, [...flags, process.argv[1], label, '__child', entry.scale, implementation], { env, windowsHide: true, stdio: ['ignore','ignore','pipe'] });
      let stderr = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { if (stderr.length < 1048576) stderr += chunk; });
      const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
      await writeFile(path.join(entry.directory, `${implementation}-stderr.log`), stderr, { flag: 'wx' });
      let payload = null;
      try { payload = JSON.parse(await readFile(path.join(entry.directory, `${implementation}.json`), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const run = { scale: entry.scale, points: entry.points, implementation, exit, passed: exit.code === 0 && payload?.passed === true,
        oom: /heap out of memory|Reached heap limit|Ineffective mark-compacts/.test(stderr),
        elapsedMs: payload?.elapsedMs, cpuMs: payload?.cpuMs, queryMs: payload?.queryMs, queryCpuMs: payload?.queryCpuMs,
        osPeakRssBytes: payload?.osPeakRssBytes, error: payload?.error };
      runs.push(run); console.log(JSON.stringify(run));
    }
  }
  const small = manifest.cases[0];
  const before = JSON.parse(await readFile(path.join(small.directory, 'baseline.json'), 'utf8'));
  const after = JSON.parse(await readFile(path.join(small.directory, 'candidate.json'), 'utf8'));
  assert.deepEqual(canonical(after.result), canonical(before.result), 'Small controlled quota dashboard parity');
  assert.ok(runs.filter(run => run.implementation === 'candidate').every(run => run.passed));
  await writeFile(path.join(root, 'result.json'), JSON.stringify({ passed: true, runs, smallBusinessParity: true }, null, 2), { flag: 'wx' });
} else throw new Error('Use LABEL prepare|run');
