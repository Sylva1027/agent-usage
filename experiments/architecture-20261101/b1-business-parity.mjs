import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const root = path.resolve('output/architecture-20261103/b1');
const label = process.argv[2];
assert.match(label || '', /^[a-z0-9-]+$/i);
const directory = path.join(root, label);
const variant = process.argv[3];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function compare(actual, expected, at = '$') {
  if (typeof actual === 'number' && typeof expected === 'number') {
    const tolerance = Number.isInteger(actual) && Number.isInteger(expected) ? 0 : Math.max(1e-8, Math.abs(expected) * 1e-11);
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${at}: ${actual} != ${expected}`);
    return;
  }
  if (!actual || !expected || typeof actual !== 'object' || typeof expected !== 'object') {
    assert.deepEqual(actual, expected, at); return;
  }
  assert.equal(Array.isArray(actual), Array.isArray(expected), at);
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${at} keys`);
  for (const key of Object.keys(expected)) compare(actual[key], expected[key], `${at}.${key}`);
}

if (variant) {
  assert.ok(['before', 'candidate'].includes(variant));
  const { UsageStore } = await import('../../src/usage-store.js');
  const store = new UsageStore({ databaseFile: path.join(directory, `${variant}.sqlite`), env: {}, importDirs: [] });
  const results = [];
  try {
    await store.open();
    store.homes = store.database.prepare(`SELECT home_id AS id, MAX(home_label) label, MAX(home_path) path,
      CASE WHEN kind IN ('main','extra','jetbrains') THEN 'codex' ELSE kind END AS kind
      FROM source_files GROUP BY home_id, kind ORDER BY home_id, kind`).all();
    const maximum = Number(store.database.prepare('SELECT MAX(timestamp_ms) value FROM events').get().value);
    const now = new Date(maximum + 12 * 3600000);
    const startDate = new Date(maximum - 30 * 86400000).toISOString().slice(0, 10);
    const endDate = new Date(maximum).toISOString().slice(0, 10);
    for (const calendarZone of ['local', 'utc']) {
      for (const preset of ['today', 'all', 'custom', 'quota_week']) {
        const filters = { now, calendarZone, preset, bucket: preset === 'today' ? 'hour' : 'day', startDate, endDate };
        results.push({ filters, dashboard: await store.dashboardHistory(filters) });
      }
      const filters = { now, calendarZone, preset: 'custom', bucket: 'day', startDate, endDate, excludeHomes: [String(store.homes[0].id)] };
      results.push({ filters, dashboard: await store.dashboardHistory(filters) });
    }
    await writeFile(path.join(directory, `${variant}.json`), JSON.stringify(results), { flag: 'wx' });
  } finally { store.close(); }
} else {
  await mkdir(directory);
  const source = path.resolve('output/architecture-20261102/full-startup/seed/usage-index.sqlite');
  const original = new DatabaseSync(source, { readOnly: true });
  let before;
  const facts = database => database.prepare(`SELECT COUNT(*) events, SUM(total) total, SUM(input) input,
    SUM(cached) cached, SUM(output) output, SUM(reasoning) reasoning FROM events`).get();
  try {
    before = facts(original);
    for (const name of ['before', 'candidate']) await backup(original, path.join(directory, `${name}.sqlite`));
  } finally { original.close(); }
  for (const name of ['before', 'candidate']) {
    const flags = ['--max-old-space-size=224', '--max-semi-space-size=4'];
    if (name === 'before') flags.push('--import', pathToFileURL(path.resolve('experiments/architecture-20261101/b1-baseline.mjs')).href);
    const env = { ...process.env }; delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, [...flags, process.argv[1], label, name], { env, windowsHide: true, stdio: 'inherit' });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(code, 0, `${name} child failed`);
  }
  const expected = JSON.parse(await readFile(path.join(directory, 'before.json'), 'utf8'));
  const actual = JSON.parse(await readFile(path.join(directory, 'candidate.json'), 'utf8'));
  let failure = null;
  try { compare(actual, expected); } catch (error) { failure = error.message; }
  const copies = {};
  for (const name of ['before', 'candidate']) {
    const database = new DatabaseSync(path.join(directory, `${name}.sqlite`), { readOnly: true });
    try {
      copies[name] = { facts: facts(database), integrity: database.prepare('PRAGMA quick_check').all() };
      assert.deepEqual(copies[name].facts, before, `${name} retained facts`);
      assert.deepEqual(copies[name].integrity.map(row => row.quick_check), ['ok']);
    } finally { database.close(); }
  }
  const result = { passed: failure === null, scopes: expected.length, source, sourceFacts: before, copies,
    exactJsonMatch: digest(actual) === digest(expected), failure,
    numericTolerance: 'Integers exact; other numbers max(1e-8 absolute, 1e-11 relative). All keys and nonnumeric values exact.' };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(result));
  if (failure) process.exitCode = 1;
}
