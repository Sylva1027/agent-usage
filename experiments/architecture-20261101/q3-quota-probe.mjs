// Run with node --max-old-space-size=224 --max-semi-space-size=4; --self-test needs no large fixture.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const outputRoot = path.join(root, 'output/architecture-20261104/q3');
const baseline = path.join(outputRoot, 'baseline');
const hashes = JSON.parse(fs.readFileSync(path.join(outputRoot, 'baseline-hashes.json'), 'utf8'));
const frozenModules = {};
const wrappedFunctions = ['selectStoredQuotaWindows', 'ensureUsageQuotaSchema', 'officialSignature',
  'createObservationSource', 'chooseLimit', 'currentStoredWindow', 'lastCompletedWindow',
  'createCycleTable', 'quotaAsOfBounds', 'writeCachedSelection', 'readCachedSelection', 'dropObservationSource'];
let trace = null;
const stack = [];
const connections = new WeakMap();
globalThis.__q3QuotaProbe = (fn, name) => function (...args) {
  if (!trace) return Reflect.apply(fn, this, args);
  const span = { id: trace.spans.length, parentId: stack.at(-1)?.id ?? null, name,
    minutes: ['currentStoredWindow', 'lastCompletedWindow', 'createCycleTable'].includes(name) ? args[4] : null };
  trace.spans.push(span);
  const started = performance.now(), overhead = trace.diagnosticMs;
  stack.push(span);
  try { return Reflect.apply(fn, this, args); }
  finally {
    stack.pop();
    span.elapsedMs = performance.now() - started;
    span.diagnosticMs = trace.diagnosticMs - overhead;
    span.adjustedMs = span.elapsedMs - span.diagnosticMs;
  }
};
registerHooks({ load(url, context, nextLoad) {
  if (!url.startsWith('file:')) return nextLoad(url, context);
  const relative = path.relative(root, fileURLToPath(url));
  const expected = hashes[relative] ?? hashes[relative.replaceAll(path.sep, '\\')];
  if (!expected) return nextLoad(url, context);
  const bytes = fs.readFileSync(path.join(baseline, relative));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, expected, `Frozen source changed: ${relative}`);
  frozenModules[relative] = sha256;
  let source = bytes.toString('utf8');
  if (relative.replaceAll(path.sep, '/') === 'src/usage-quota-store.js') {
    source += '\n' + wrappedFunctions.map(name => `${name} = globalThis.__q3QuotaProbe(${name}, ${JSON.stringify(name)});`).join('\n');
  }
  return { format: 'module', source, shortCircuit: true };
} });
const { selectStoredQuotaWindows, ensureUsageQuotaSchema } = await import(pathToFileURL(path.join(root, 'src/usage-quota-store.js')));

function diagnostic(work) {
  const started = performance.now();
  try { return work(); } finally { trace.diagnosticMs += performance.now() - started; }
}

function sqlKind(sql) {
  if (/HAVING MAX\(resets_at_ms\)/.test(sql)) return 'endpoint-conflict';
  if (/LAG\(first_observed\)/.test(sql)) return 'order-conflict';
  if (/WITH\s+boundaries/.test(sql)) return 'validity-bounds';
  if (/unique_endpoints/.test(sql)) return 'endpoint-support';
  if (/INSERT INTO[^\n]+endpoint_anchors/.test(sql)) return 'temp-anchor-write';
  if (/INSERT INTO[^\n]+cycles/.test(sql)) return 'temp-cycle-build';
  return stack.at(-1)?.name ?? 'outside-selection';
}

function instrument(database) {
  if (connections.has(database)) return connections.get(database);
  const wrapped = {
    get isTransaction() { return database.isTransaction; },
    exec(sql) {
      // Snapshot TEMP before frozen code drops it; diagnostics are outside SQL timers.
      for (const match of sql.matchAll(/DROP TABLE IF EXISTS\s+("[^"]+")/g)) {
        diagnostic(() => {
          const name = match[1];
          const exists = database.prepare("SELECT 1 FROM sqlite_temp_master WHERE name = ?").get(name.slice(1, -1));
          if (exists) trace.tempTables.push({ name, spanId: stack.at(-1)?.id,
            rows: database.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n,
            pageCount: database.prepare('PRAGMA temp.page_count').get().page_count,
            freelistCount: database.prepare('PRAGMA temp.freelist_count').get().freelist_count,
            pageSize: database.prepare('PRAGMA temp.page_size').get().page_size });
        });
      }
      const started = performance.now();
      try { return database.exec(sql); }
      finally { trace.exec.push({ sql, spanId: stack.at(-1)?.id, sqlMs: performance.now() - started }); }
    },
    prepare(sql) {
      const started = performance.now();
      const statement = database.prepare(sql);
      const record = { id: trace.statements.length, kind: sqlKind(sql), spanId: stack.at(-1)?.id,
        minutes: [...stack].reverse().find(span => span.minutes)?.minutes ?? null,
        sql, prepareMs: performance.now() - started, calls: 0, sqlMs: 0,
        sqlReturnedRows: 0, jsIterationRows: 0, iteratorNextCalls: 0, changedRows: 0,
        actualRowsScanned: null };
      trace.statements.push(record);
      function invoke(method, args) {
        if (!record.calls) diagnostic(() => {
          record.firstParameters = args;
          const plan = { statementId: record.id, sql, parameters: args };
          try {
            plan.queryPlan = database.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args);
            plan.bytecode = database.prepare('EXPLAIN ' + sql).all(...args);
          } catch (error) { plan.error = error.message; }
          trace.plans.push(plan);
        });
        record.calls++;
        const began = performance.now();
        let result;
        try { result = statement[method](...args); }
        finally { record.sqlMs += performance.now() - began; }
        if (method === 'get') record.sqlReturnedRows += result === undefined ? 0 : 1;
        if (method === 'all') record.sqlReturnedRows += result.length;
        if (method === 'run') record.changedRows += Number(result.changes);
        if (method !== 'iterate') return result;
        return {
          [Symbol.iterator]() { return this; },
          next() {
            const began = performance.now();
            let item;
            try { item = result.next(); }
            finally { record.sqlMs += performance.now() - began; record.iteratorNextCalls++; }
            if (!item.done) { record.sqlReturnedRows++; record.jsIterationRows++; }
            return item;
          },
          return() { return result.return?.() ?? { done: true }; },
        };
      }
      return Object.fromEntries(['get', 'all', 'run', 'iterate'].map(method => [method, (...args) => invoke(method, args)]));
    },
  };
  connections.set(database, wrapped);
  return wrapped;
}

function officialObservations(database) {
  const raw = database.prepare("SELECT value FROM store_meta WHERE key = 'official_quota_observations'").get()?.value;
  const observations = JSON.parse(raw || '[]');
  assert.ok(Array.isArray(observations));
  return { observations, rawSha256: raw ? createHash('sha256').update(raw).digest('hex') : null,
    rawBytes: raw ? Buffer.byteLength(raw) : 0 };
}

function snapshot(database, file) {
  const revision = database.prepare('SELECT revision FROM quota_revision WHERE singleton=1').get()?.revision;
  const cache = database.prepare('SELECT format_version,quota_revision,official_signature,valid_from_ms,valid_to_ms FROM usage_quota_window_cache WHERE singleton=1').get();
  return { revision, cache, totalChanges: database.prepare('SELECT total_changes() AS n').get().n,
    mainPages: database.prepare('PRAGMA main.page_count').get().page_count,
    tempPages: database.prepare('PRAGMA temp.page_count').get().page_count,
    walBytes: file && fs.existsSync(file + '-wal') ? fs.statSync(file + '-wal').size : 0 };
}

function measure(database, label, asOf, official, file) {
  const before = snapshot(database, file);
  trace = { label, diagnosticMs: 0, spans: [], statements: [], exec: [], tempTables: [], plans: [] };
  const cpu = process.cpuUsage(), began = performance.now();
  let result;
  try { result = selectStoredQuotaWindows(instrument(database), asOf, official); }
  finally {
    trace.elapsedMs = performance.now() - began;
    trace.adjustedMs = trace.elapsedMs - trace.diagnosticMs;
    trace.cpu = process.cpuUsage(cpu);
  }
  const measured = trace;
  trace = null;
  measured.result = result;
  measured.before = before;
  measured.after = snapshot(database, file);
  measured.totalChangedRowsIncludingTriggers = measured.after.totalChanges - before.totalChanges;
  measured.sqlMs = measured.statements.reduce((n, statement) => n + statement.sqlMs, 0) + measured.exec.reduce((n, entry) => n + entry.sqlMs, 0);
  measured.jsIterationRows = measured.statements.reduce((n, statement) => n + statement.jsIterationRows, 0);
  measured.directChangedRows = measured.statements.reduce((n, statement) => n + statement.changedRows, 0);
  measured.memory = process.memoryUsage();
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM sqlite_temp_master WHERE name LIKE 'codex_usage_quota_%'").get().n, 0);
  return measured;
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function manifest(file) {
  const entries = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const current = file + suffix;
    if (!fs.existsSync(current)) { entries.push({ suffix, exists: false }); continue; }
    const before = fs.statSync(current);
    const sha256 = await hashFile(current);
    const after = fs.statSync(current);
    assert.equal(before.size, after.size);
    assert.equal(before.mtimeMs, after.mtimeMs);
    entries.push({ suffix, exists: true, bytes: after.size, mtimeMs: after.mtimeMs, sha256 });
  }
  return entries;
}

async function copyClosedFixture(source, destination) {
  const before = await manifest(source);
  for (const entry of before.filter(entry => entry.exists && entry.suffix !== '-shm')) {
    fs.copyFileSync(source + entry.suffix, destination + entry.suffix, fs.constants.COPYFILE_EXCL);
    assert.equal(await hashFile(destination + entry.suffix), entry.sha256);
  }
  assert.deepEqual(await manifest(source), before, 'Source changed while cloning; discard this run.');
  return { source, destination, before, copied: before.filter(entry => entry.exists && entry.suffix !== '-shm'),
    shm: 'Not copied: transient WAL index is rebuilt only on the clone.', copyHashesMatch: true };
}

function facts(database) {
  return database.prepare('SELECT COUNT(*) AS n,SUM(total) AS total,SUM(input) AS input,SUM(output) AS output,SUM(cached) AS cached,SUM(reasoning) AS reasoning FROM events').get();
}

function insertObservation(database, row) {
  return database.prepare(`INSERT INTO rate_limit_observations
    (source_path,line_number,role,observed_at_ms,limit_id,limit_name,plan_type,window_minutes,resets_at_ms,used_percent)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(row.source_path,row.line_number,row.role,row.observed_at_ms,row.limit_id,
      row.limit_name ?? null,row.plan_type ?? null,row.window_minutes,row.resets_at_ms,row.used_percent);
}

const limitations = [
  'SQL returned rows and JS iteration rows are exact API counts, not actual B-tree visits. actualRowsScanned is null: this Node build has neither ENABLE_STMT_SCANSTATUS nor a statement scan-status API.',
  'EXPLAIN plans and bytecode show access paths, not measured scan counts. Input cardinalities are separate diagnostics; correlated official dedup scans may repeat.',
  'One private 10x quota-only observation insertion; no file sync, browser, DSH event append, full rebuild, whole regression suite, or end-to-end refresh measurement.',
  'SQL timers include SQLite step work; iterator timers exclude loop-body writes. Function adjustedMs excludes timed diagnostics but retains wrapper overhead. CPU includes diagnostics; no cold-disk or statistical claims.',
  'TEMP page counts are logical connection allocations/high-water snapshots, not physical disk I/O; changedRows excludes triggers, totalChangedRowsIncludingTriggers includes them. Main/WAL byte sizes are not bytes physically written.',
  'Closed-source copying is hash/stat-checked before/after; it is not a live-writer backup protocol. The source DB is never opened by SQLite.',
];

async function selfTest() {
  const { selectQuotaWindows } = await import(pathToFileURL(path.join(root, 'src/usage-core.js')));
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`CREATE TABLE store_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
      CREATE TABLE rate_limit_observations(source_path TEXT NOT NULL,line_number INTEGER NOT NULL CHECK(line_number>0),
      role TEXT NOT NULL CHECK(role IN ('primary','secondary')),observed_at_ms INTEGER NOT NULL,limit_id TEXT NOT NULL,
      limit_name TEXT,plan_type TEXT,window_minutes REAL NOT NULL CHECK(window_minutes>0),resets_at_ms INTEGER NOT NULL,
      used_percent REAL CHECK(used_percent IS NULL OR used_percent BETWEEN 0 AND 100),PRIMARY KEY(source_path,line_number,role)) STRICT;`);
    assert.equal(ensureUsageQuotaSchema(database), true);
    const asOf = Date.parse('2026-11-03T12:00:00Z');
    const base = { source_path: 'fixture', line_number: 1, role: 'primary', observed_at_ms: asOf - 60000,
      limit_id: 'codex', window_minutes: 300, resets_at_ms: asOf + 60 * 60000, used_percent: 10 };
    const persisted = [base, { ...base, line_number: 2, limit_id: ' ' },
      { ...base, line_number: 3, observed_at_ms: asOf - 24 * 3600000, resets_at_ms: asOf - 23 * 3600000 }];
    for (const row of persisted) insertObservation(database, row);
    const official = [{ ...base, used_percent: 99 }, { ...base, line_number: 2, limit_id: 'masked' },
      { ...base, source_path: 'official', line_number: 1, observed_at_ms: asOf, used_percent: 44 },
      { ...base, source_path: 'official', line_number: 1, observed_at_ms: asOf, used_percent: 88 },
      { ...base, source_path: 'invalid-first', observed_at_ms: null },
      { ...base, source_path: 'invalid-first', used_percent: 77 }];
    // Missing limit id invalidates the first identity and must still mask its duplicate.
    official[4].limit_id = '';
    database.prepare("INSERT INTO store_meta VALUES('official_quota_observations',?)").run(JSON.stringify(official));
    const loaded = officialObservations(database).observations;
    assert.deepEqual(loaded, official);
    const map = new Map();
    for (const row of [...persisted, ...loaded]) {
      const identity = `${row.source_path}\0${row.line_number}\0${row.role}`;
      if (!map.has(identity)) map.set(identity, row);
    }
    const expected = selectQuotaWindows([...map.values()], asOf);
    const first = measure(database, 'self-test-miss', asOf, loaded);
    assert.deepEqual(first.result, expected);
    assert.equal(first.result.windows.quota_5h.usedPercent, 44);
    assert.ok(first.tempTables.some(table => table.name.includes('endpoint_anchors') && table.rows > 0));
    assert.equal(first.jsIterationRows, first.tempTables.filter(table => table.name.includes('endpoint_anchors')).reduce((n, table) => n + table.rows, 0));
    assert.ok(first.plans.every(plan => !plan.error));
    const reuse = measure(database, 'self-test-reuse', asOf, loaded);
    assert.deepEqual(reuse.result, expected);
    assert.equal(reuse.totalChangedRowsIncludingTriggers, 0);
    assert.equal(reuse.tempTables.length, 0);
    insertObservation(database, { ...base, line_number: 4, observed_at_ms: asOf, used_percent: 44 });
    const changed = measure(database, 'self-test-revision', asOf, loaded);
    assert.equal(changed.after.cache.quota_revision, changed.after.revision);
    assert.ok(changed.jsIterationRows > 0);
    assert.ok(changed.statements.some(statement => statement.kind === 'validity-bounds' && statement.sqlReturnedRows === 1 && statement.actualRowsScanned === null));
    console.log(JSON.stringify({ passed: true, checks: ['frozen hashes', 'official store_meta read', 'persisted-first and official-first dedup',
      'invalid identity masking', 'independent frozen usage-core parity', 'TEMP/JS row accounting', 'EXPLAIN capture', 'cache reuse', 'revision invalidation'], frozenModules }));
  } finally { database.close(); }
}

async function run() {
  assert.ok(process.execArgv.includes('--max-old-space-size=224') && process.execArgv.includes('--max-semi-space-size=4'),
    'Use node --max-old-space-size=224 --max-semi-space-size=4 experiments/architecture-20261101/q3-quota-probe.mjs [--self-test] [--out directory]');
  if (process.argv.includes('--self-test')) return selfTest();
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--out'), 'Only --out <new private directory> is supported.');
  const destination = path.resolve(args[1] ?? path.join(outputRoot, 'quota-probe-' + new Date().toISOString().replaceAll(/[:.]/g, '-')));
  assert.ok(destination.startsWith(outputRoot + path.sep), 'Output must stay in the private Q3 output directory.');
  fs.mkdirSync(destination); // Exclusive run directory: never overwrite another probe.
  const report = JSON.parse(fs.readFileSync(path.join(root, 'output/architecture-20261103/q2/q2-20261103-b/10x-sha/candidate/result.json'), 'utf8'));
  const source = path.resolve(report.prepared.databaseFile);
  const expectedSource = path.join(root, 'output/architecture-20261103/q2/q2-20261103-b/10x-sha/candidate/fixture/10x/.codex-usage/usage-index.sqlite');
  assert.equal(source, expectedSource, 'Only the named closed private Q2 candidate is authorized.');
  const file = path.join(destination, 'quota-clone.sqlite');
  console.log(JSON.stringify({ stage: 'copy-and-hash', source, destination }));
  const copied = await copyClosedFixture(source, file);
  fs.writeFileSync(path.join(destination, 'copy.json'), JSON.stringify(copied, null, 2) + '\n');
  let database = new DatabaseSync(file);
  const measurements = [];
  let result;
  try {
    database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(ensureUsageQuotaSchema(database), true);
    const beforeFacts = facts(database);
    assert.equal(beforeFacts.n, 1_464_120 + 12, 'Read the current +12 fixture, never result.json counts.');
    const beforeQuota = database.prepare('SELECT COUNT(*) AS n,MAX(observed_at_ms) AS latest FROM rate_limit_observations').get();
    const official = officialObservations(database);
    const cacheFrom = database.prepare('SELECT valid_from_ms FROM usage_quota_window_cache WHERE singleton=1').get()?.valid_from_ms;
    // The frozen cache deliberately refuses to replace newer results with historical queries.
    const asOf = Math.max(Number(cacheFrom ?? 0), beforeQuota.latest + 1000,
      ...official.observations.map(row => Number(row.observedAtMs ?? row.observed_at_ms) + 1000).filter(Number.isFinite));
    const cardinalities = database.prepare(`SELECT limit_id,window_minutes,COUNT(*) AS rows,
      MIN(observed_at_ms) AS firstObserved,MAX(observed_at_ms) AS lastObserved,
      COUNT(DISTINCT resets_at_ms) AS distinctResets FROM rate_limit_observations GROUP BY limit_id,window_minutes`).all();
    console.log(JSON.stringify({ stage: 'baseline-selection', eventCount: beforeFacts.n, quotaRows: beforeQuota.n, asOf: new Date(asOf).toISOString() }));
    const initial = measure(database, 'baseline-selection', asOf, official.observations, file);
    measurements.push(initial);
    assert.ok(initial.result.limitId, 'Fixture must select an unambiguous bucket.');
    const seed = database.prepare(`SELECT * FROM rate_limit_observations WHERE limit_id=? AND window_minutes=300
      ORDER BY observed_at_ms DESC LIMIT 1`).get(initial.result.limitId);
    assert.ok(seed);
    const line = database.prepare('SELECT MAX(line_number)+1 AS n FROM rate_limit_observations WHERE source_path=?').get(seed.source_path).n;
    const row = { ...seed, line_number: line, observed_at_ms: asOf,
      resets_at_ms: seed.resets_at_ms > asOf && seed.resets_at_ms - 300 * 60000 <= asOf ? seed.resets_at_ms : asOf + 300 * 60000,
      used_percent: (Number(seed.used_percent ?? 0) + 1) % 101 };
    const revision = database.prepare('SELECT revision FROM quota_revision WHERE singleton=1').get().revision;
    const insertionStarted = performance.now();
    const inserted = insertObservation(database, row);
    const insertionMs = performance.now() - insertionStarted;
    assert.equal(inserted.changes, 1);
    assert.equal(database.prepare('SELECT revision FROM quota_revision WHERE singleton=1').get().revision, revision + 1);
    console.log(JSON.stringify({ stage: 'new-observation-selection' }));
    const changed = measure(database, 'new-observation', asOf, official.observations, file);
    measurements.push(changed);
    assert.equal(changed.result.windows.quota_5h.observedAt, new Date(asOf).toISOString());
    assert.equal(changed.result.windows.quota_5h.usedPercent, row.used_percent);
    assert.equal(changed.after.cache.quota_revision, revision + 1);
    assert.ok(changed.jsIterationRows > 0);
    const reuse = measure(database, 'unchanged-reuse', asOf, official.observations, file);
    measurements.push(reuse);
    assert.deepEqual(reuse.result, changed.result);
    assert.equal(reuse.totalChangedRowsIncludingTriggers, 0);
    assert.equal(reuse.tempTables.length, 0);
    assert.equal(reuse.jsIterationRows, 0);
    assert.deepEqual(facts(database), beforeFacts);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM rate_limit_observations').get().n, beforeQuota.n + 1);
    assert.deepEqual(officialObservations(database), official);
    assert.equal(database.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    const compileOptions = database.prepare('PRAGMA compile_options').all().map(row => row.compile_options);
    database.close();
    database = new DatabaseSync(file);
    const reopened = measure(database, 'reopened-unchanged-reuse', asOf, officialObservations(database).observations, file);
    measurements.push(reopened);
    assert.deepEqual(reopened.result, changed.result);
    assert.equal(reopened.totalChangedRowsIncludingTriggers, 0);
    assert.equal(reopened.tempTables.length, 0);
    assert.equal(reopened.jsIterationRows, 0);
    result = { passed: true, createdAt: new Date().toISOString(), node: process.version, execArgv: process.execArgv,
      asOf: new Date(asOf).toISOString(), asOfRule: 'max(existing cache valid_from_ms, latest persisted/official observation + 1000ms)', frozenModules, copied, facts: beforeFacts,
      quotaRowsBefore: beforeQuota.n, quotaRowsAfter: beforeQuota.n + 1, cardinalities,
      official: { count: official.observations.length, rawBytes: official.rawBytes, rawSha256: official.rawSha256,
        ordering: 'Unchanged JSON array from store_meta; persisted identity wins, then first official identity wins, including invalid blockers.' },
      insertion: { row, insertionMs, changes: inserted.changes, revisionBefore: revision, revisionAfter: revision + 1 },
      sqlite: { compileOptions, tempStore: database.prepare('PRAGMA temp_store').get().temp_store,
        journalMode: database.prepare('PRAGMA journal_mode').get().journal_mode },
      checks: { quickCheck: true, copiedHashesMatch: true, sourceNeverOpenedBySqlite: true, eventCountAndTokenTotalsUnchanged: true,
        exactlyOneQuotaObservationAdded: true, officialMetadataUnchanged: true, reuseExact: true, reopenReuseExact: true, tempCleaned: true },
      measurements, limitations };
  } finally { database.close(); }
  assert.deepEqual(await manifest(source), copied.before, 'Source changed during probe.');
  result.checks.sourceFilesUnchangedAtEnd = true;
  const plans = measurements.map(measurement => ({ label: measurement.label, plans: measurement.plans }));
  for (const measurement of measurements) delete measurement.plans;
  fs.writeFileSync(path.join(destination, 'explain-plans.json'), JSON.stringify(plans, null, 2) + '\n');
  fs.writeFileSync(path.join(destination, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ passed: true, output: destination, measurements: measurements.map(measurement => ({ label: measurement.label,
    adjustedMs: measurement.adjustedMs, sqlMs: measurement.sqlMs, jsIterationRows: measurement.jsIterationRows,
    tempRows: measurement.tempTables.map(table => ({ name: table.name, rows: table.rows })),
    changedRowsIncludingTriggers: measurement.totalChangedRowsIncludingTriggers })) }));
}

await run();
