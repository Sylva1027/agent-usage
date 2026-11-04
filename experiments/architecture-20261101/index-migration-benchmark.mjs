import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { backup, DatabaseSync } from "node:sqlite";
import { STORE_SCHEMA_VERSION, UsageStore } from "../../src/usage-store.js";

const INDEX_NAME = "events_session_home_time_idx";
const INDEX_DDL = `CREATE INDEX IF NOT EXISTS ${INDEX_NAME} ON events(session_id, home_id, timestamp_ms)`;
const CUMULATIVE_SQL = `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total,
  COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cached), 0) AS cached,
  COALESCE(SUM(output), 0) AS output, COALESCE(SUM(reasoning), 0) AS reasoning,
  MIN(detail_mask & 1) AS input_known, MIN(detail_mask & 2) AS cached_known,
  MIN(detail_mask & 4) AS output_known, MIN(detail_mask & 8) AS reasoning_known,
  COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens, MIN(cache_write_known) AS cache_write_known
  FROM events WHERE session_id = ? AND home_id = ? AND source_path <> ? AND timestamp_ms < ?`;
const EVENT_COLUMNS =
  "source_path timestamp_ms session_id home_id home_label channel project model hour_key day_key week_key month_key total input cached output reasoning".split(
    " ",
  );
const EVENT_INSERT = `INSERT INTO events (${EVENT_COLUMNS.join(",")}) VALUES (${EVENT_COLUMNS.map(() => "?").join(",")})`;
const WRITE_BATCH_SIZE = 512;

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}
function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
function withDatabase(file, readOnly, work) {
  const database = new DatabaseSync(file, { readOnly });
  try {
    return work(database);
  } finally {
    database.close();
  }
}
async function backupDatabase(sourceFile, destinationFile) {
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  source.exec("PRAGMA query_only = ON");
  try {
    await backup(source, destinationFile);
  } finally {
    source.close();
  }
}
function indexInfo(database) {
  const row = database.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(INDEX_NAME);
  if (!row) return null;
  const columns = database
    .prepare(`PRAGMA index_info(${quote(INDEX_NAME)})`)
    .all()
    .sort((a, b) => Number(a.seqno) - Number(b.seqno))
    .map((item) => String(item.name));
  return { columns, sql: String(row.sql || "") };
}
function databaseInfo(file) {
  return withDatabase(file, true, (database) => {
    const pragma = (name) => Number(database.prepare(`PRAGMA ${name}`).get()[name]);
    const pageSize = pragma("page_size");
    const pageCount = pragma("page_count");
    const freePages = pragma("freelist_count");
    let dbstat;
    try {
      const row = database
        .prepare("SELECT COALESCE(SUM(pgsize),0) bytes,COUNT(*) pages FROM dbstat WHERE name=?")
        .get(INDEX_NAME);
      dbstat = { available: true, bytes: Number(row.bytes), pages: Number(row.pages) };
    } catch (error) {
      dbstat = { available: false, bytes: null, pages: null, reason: String(error?.message || error) };
    }
    return {
      schemaVersion: pragma("user_version"),
      sqliteVersion: String(database.prepare("SELECT sqlite_version() v").get().v),
      index: indexInfo(database),
      dbstat,
      pages: {
        pageSize, pageCount, freePages,
        allocatedMainBytes: pageSize * pageCount,
        usedMainBytes: pageSize * (pageCount - freePages),
      },
    };
  });
}
function frame(hash, value) {
  if (value === null || value === undefined) return hash.update("N");
  if (typeof value === "bigint") return hash.update(`I${value};`);
  if (typeof value === "number") return hash.update(`R${Object.is(value, -0) ? "-0" : value};`);
  const bytes =
    typeof value === "string"
      ? Buffer.from(value)
      : ArrayBuffer.isView(value)
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : fail("UNSUPPORTED_SQLITE_VALUE", `unsupported table value type: ${typeof value}`);
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hash.update(typeof value === "string" ? "S" : "B").update(length).update(bytes);
}
function hashTables(file) {
  return withDatabase(file, true, (database) => {
    const aggregate = createHash("sha256");
    const tables = [];
    let totalRows = 0;
    const definitions = database
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all();
    for (const definition of definitions) {
      const name = String(definition.name);
      const columns = database
        .prepare(`PRAGMA table_info(${quote(name)})`)
        .all()
        .sort((a, b) => Number(a.cid) - Number(b.cid));
      const names = columns.map((column) => String(column.name));
      const keys = columns
        .filter((column) => Number(column.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((column) => String(column.name));
      const statement = database.prepare(
        `SELECT ${names.map(quote).join(",")} FROM ${quote(name)} ORDER BY ${(keys.length ? keys : names).map(quote).join(",")}`,
      );
      statement.setReadBigInts(true);
      const hash = createHash("sha256");
      frame(hash, name);
      frame(hash, String(definition.sql || ""));
      frame(hash, JSON.stringify(names));
      let rowCount = 0;
      for (const row of statement.iterate()) {
        for (const column of names) frame(hash, row[column]);
        rowCount += 1;
      }
      const sha256 = hash.digest("hex");
      tables.push({ name, rowCount, sha256 });
      frame(aggregate, name);
      frame(aggregate, String(rowCount));
      frame(aggregate, sha256);
      totalRows += rowCount;
    }
    return { sha256: aggregate.digest("hex"), tableCount: tables.length, totalRows, tables };
  });
}
const normalized = (row) =>
  Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [key, typeof value === "bigint" ? String(value) : value]),
  );
function cumulativeSample(file) {
  const found = withDatabase(file, true, (database) => {
    const groups = database.prepare(
      `SELECT session_id,home_id,MAX(timestamp_ms) latest_timestamp,COUNT(DISTINCT source_path) source_count
       FROM events GROUP BY session_id,home_id HAVING COUNT(DISTINCT source_path)>1
       ORDER BY COUNT(*) DESC,latest_timestamp DESC,session_id,home_id LIMIT 64`,
    );
    groups.setReadBigInts(true);
    const latestTarget = database.prepare(
      `SELECT source_path,timestamp_ms FROM events WHERE session_id=? AND home_id=?
       ORDER BY timestamp_ms DESC,source_path LIMIT 1`,
    );
    latestTarget.setReadBigInts(true);
    const cumulative = database.prepare(CUMULATIVE_SQL);
    cumulative.setReadBigInts(true);
    let scanned = 0;
    for (const group of groups.iterate()) {
      scanned += 1;
      const target = latestTarget.get(String(group.session_id), String(group.home_id));
      const parameters = [String(group.session_id), String(group.home_id), String(target.source_path), target.timestamp_ms];
      const result = cumulative.get(...parameters);
      if (Number(result.count) > 0) {
        return {
          parameters,
          boundary: { sameHome: true, sameSession: true, crossFileExclusion: true,
            targetTimestampMs: String(target.timestamp_ms), predecessorCount: Number(result.count),
            candidateSourceCount: Number(group.source_count), candidatesScanned: scanned, candidateScanLimit: 64 },
        };
      }
    }
    return null;
  });
  if (!found) fail("NO_CROSS_FILE_PREDECESSOR", "no candidate group had a positive cumulative predecessor count");
  return found;
}
async function prepareControl(sourceFile, destinationFile, indexed) {
  await backupDatabase(sourceFile, destinationFile);
  withDatabase(destinationFile, false, (database) => {
    database.exec(`PRAGMA journal_mode=WAL;DROP INDEX IF EXISTS ${quote(INDEX_NAME)};`);
    if (indexed) database.exec(INDEX_DDL);
    database.exec("VACUUM");
  });
  assert.equal(Boolean(databaseInfo(destinationFile).index), indexed);
}
function queryRow(statement, parameters) {
  return normalized(statement.get(...parameters));
}
function benchmarkQuery(indexedFile, unindexedFile, parameters) {
  return withDatabase(indexedFile, true, (indexed) =>
    withDatabase(unindexedFile, true, (unindexed) => {
      const indexedStatement = indexed.prepare(CUMULATIVE_SQL);
      const unindexedStatement = unindexed.prepare(CUMULATIVE_SQL);
      indexedStatement.setReadBigInts(true);
      unindexedStatement.setReadBigInts(true);
      const indexedResult = queryRow(indexedStatement, parameters);
      assert.deepEqual(indexedResult, queryRow(unindexedStatement, parameters));
      const times = { indexedMs: [], unindexedMs: [] };
      for (let round = 0; round < 3; round += 1) {
        const order =
          round % 2
            ? [["unindexedMs", unindexedStatement], ["indexedMs", indexedStatement]]
            : [["indexedMs", indexedStatement], ["unindexedMs", unindexedStatement]];
        for (const [key, statement] of order) {
          const started = performance.now();
          queryRow(statement, parameters);
          times[key].push(performance.now() - started);
        }
      }
      const plan = (database) =>
        database.prepare(`EXPLAIN QUERY PLAN ${CUMULATIVE_SQL}`).all(...parameters).map((row) => String(row.detail));
      return {
        exactMatch: true,
        result: indexedResult,
        ...times,
        indexedPlan: plan(indexed),
        unindexedPlan: plan(unindexed),
      };
    }),
  );
}
function writeSource(file) {
  return withDatabase(file, true, (database) => {
    const row = database.prepare("SELECT path,home_id,home_label FROM source_files ORDER BY path LIMIT 1").get();
    if (!row) fail("NO_SOURCE_FILES", "seed has no source_files row for the write benchmark");
    const maximum = database.prepare("SELECT MAX(timestamp_ms) value FROM events").get().value;
    return {
      path: String(row.path),
      homeId: String(row.home_id),
      homeLabel: String(row.home_label),
      timestampMs: BigInt(maximum ?? 0) + 1n,
    };
  });
}
function makeBatch(source) {
  return Array.from({ length: WRITE_BATCH_SIZE }, (_, index) => [
    source.path, source.timestampMs + BigInt(index), `index-benchmark-${String(index).padStart(4, "0")}`,
    source.homeId, source.homeLabel, ..."benchmark benchmark benchmark benchmark benchmark benchmark benchmark".split(" "),
    100, 80, 40, 20, 0,
  ]);
}
async function fileSize(file) {
  try {
    return Number((await stat(file)).size);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}
async function fileSizes(file) {
  const [mainBytes, walBytes, shmBytes] = await Promise.all([file, `${file}-wal`, `${file}-shm`].map(fileSize));
  return { mainBytes, walBytes, shmBytes };
}
async function writeTrial(template, destination, batch) {
  await backupDatabase(template, destination);
  const database = new DatabaseSync(destination);
  try {
    database.exec("PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;");
    assert.equal(Number(database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get().busy || 0), 0);
    const before = await fileSize(`${destination}-wal`);
    const insert = database.prepare(EVENT_INSERT);
    const transactionStarted = performance.now();
    database.exec("BEGIN IMMEDIATE");
    let changed = 0;
    for (const values of batch) changed += Number(insert.run(...values).changes);
    assert.equal(changed, batch.length);
    const commitStarted = performance.now();
    database.exec("COMMIT");
    const commitMs = performance.now() - commitStarted;
    const transactionMs = performance.now() - transactionStarted;
    const after = await fileSize(`${destination}-wal`);
    return { commitMs, transactionMs, walBytesBefore: before, walBytesAfter: after,
      walBytesGrowth: after - before };
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {}
    throw error;
  } finally {
    database.close();
  }
}
async function benchmarkWrites(output, sourceFile, source) {
  const templates = {
    indexed: path.join(output, "write-templates", "indexed.sqlite"),
    unindexed: path.join(output, "write-templates", "unindexed.sqlite"),
  };
  await mkdir(path.dirname(templates.indexed));
  await prepareControl(sourceFile, templates.indexed, true);
  await prepareControl(sourceFile, templates.unindexed, false);
  const batch = makeBatch(source);
  const trials = { indexed: [], unindexed: [] };
  for (let round = 0; round < 3; round += 1) {
    const order = round % 2 ? ["unindexed", "indexed"] : ["indexed", "unindexed"];
    for (const state of order) {
      const directory = path.join(output, "write-trials", `${round + 1}-${state}`);
      await mkdir(directory, { recursive: true });
      trials[state].push(await writeTrial(templates[state], path.join(directory, "control.sqlite"), batch));
    }
  }
  const summarize = (rows) =>
    Object.fromEntries(
      ["commitMs", "transactionMs", "walBytesBefore", "walBytesAfter", "walBytesGrowth"].map((key) => [
        key,
        rows.map((row) => row[key]),
      ]),
    );
  return {
    batchSize: WRITE_BATCH_SIZE,
    freshDatabasePerTrial: true,
    roundOrder: ["indexed,unindexed", "unindexed,indexed", "indexed,unindexed"],
    measurement: "SQLite logical transaction and WAL bytes; not physical I/O",
    indexed: summarize(trials.indexed),
    unindexed: summarize(trials.unindexed),
  };
}
async function newDirectory(directory) {
  await mkdir(path.dirname(directory), { recursive: true });
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") fail("OUTPUT_EXISTS", "output directory must be new");
    throw error;
  }
  return path.resolve(directory);
}
export async function runIndexMigrationBenchmark({ seedFile, outputDirectory }) {
  if (typeof seedFile !== "string" || !seedFile.trim()) fail("MISSING_SEED", "seed database path is required");
  if (typeof outputDirectory !== "string" || !outputDirectory.trim()) {
    fail("MISSING_OUTPUT", "new output directory is required");
  }
  const seed = path.resolve(seedFile);
  if (!(await lstat(seed)).isFile()) fail("SEED_NOT_FILE", "seed database must be a regular file");
  const output = await newDirectory(outputDirectory);
  const copiedSeed = path.join(output, "databases", "seed-copy.sqlite");
  await mkdir(path.dirname(copiedSeed));
  await backupDatabase(seed, copiedSeed);
  const check = withDatabase(copiedSeed, true, (database) =>
    database.prepare("PRAGMA quick_check").all().map((row) => String(row.quick_check)),
  );
  if (check.length !== 1 || check[0] !== "ok") fail("QUICK_CHECK_FAILED", "quick_check failed");
  const beforeHash = hashTables(copiedSeed);
  const before = databaseInfo(copiedSeed);
  if (before.schemaVersion !== STORE_SCHEMA_VERSION) fail("SCHEMA_VERSION", "seed must already use schema 24");
  if (before.index) fail("TARGET_INDEX_ALREADY_EXISTS", "seed contains the target index");
  const filesBefore = await fileSizes(copiedSeed);
  const firstStore = new UsageStore({ databaseFile: copiedSeed, homeDir: output });
  const firstStarted = performance.now();
  await firstStore.open();
  const firstOpenMs = performance.now() - firstStarted;
  assert.ok(indexInfo(firstStore.database));
  const checkpointStarted = performance.now();
  const checkpoint = firstStore.database.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  const firstCheckpointMs = performance.now() - checkpointStarted;
  assert.equal(Number(checkpoint.busy || 0), 0);
  const closeStarted = performance.now();
  firstStore.close();
  const firstCloseMs = performance.now() - closeStarted;
  const reopenedStore = new UsageStore({ databaseFile: copiedSeed, homeDir: output });
  const reopenStarted = performance.now();
  await reopenedStore.open();
  const reopenMs = performance.now() - reopenStarted;
  reopenedStore.close();
  const after = databaseInfo(copiedSeed);
  assert.equal(after.schemaVersion, STORE_SCHEMA_VERSION);
  assert.deepEqual(after.index?.columns, ["session_id", "home_id", "timestamp_ms"]);
  const afterHash = hashTables(copiedSeed);
  if (beforeHash.sha256 !== afterHash.sha256) {
    fail("PERSISTENT_DATA_CHANGED", "formal open changed authoritative persistent rows");
  }
  const queryDirectory = path.join(output, "query-controls");
  await mkdir(queryDirectory);
  const indexedQuery = path.join(queryDirectory, "indexed.sqlite");
  const unindexedQuery = path.join(queryDirectory, "unindexed.sqlite");
  await prepareControl(copiedSeed, indexedQuery, true);
  await prepareControl(copiedSeed, unindexedQuery, false);
  const sample = cumulativeSample(copiedSeed);
  const cumulativeQuery = benchmarkQuery(indexedQuery, unindexedQuery, sample.parameters);
  assert.equal(String(cumulativeQuery.result.count), String(sample.boundary.predecessorCount));
  sample.boundary.resultCount = Number(cumulativeQuery.result.count);
  const insertWrite = await benchmarkWrites(output, copiedSeed, writeSource(copiedSeed));
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, sqlite: before.sqliteVersion },
    scope: {
      offlineOnly: true,
      sourceScan: false,
      seedCopy: "node:sqlite read-only backup with committed WAL",
      persistentDataCoverage: "all main tables; sqlite_% excluded",
    },
    schemaVersion: { expected: STORE_SCHEMA_VERSION, before: before.schemaVersion, after: after.schemaVersion },
    persistentData: { before: beforeHash, after: afterHash, dataPreserved: true },
    dataPreserved: true,
    index: {
      columns: after.index.columns,
      sql: after.index.sql,
      firstOpenMs,
      firstCheckpointMs,
      firstCloseMs,
      reopenMs,
      dbstat: after.dbstat,
      pages: {
        before: before.pages,
        after: after.pages,
        allocatedMainBytesGrowth: after.pages.allocatedMainBytes - before.pages.allocatedMainBytes,
      },
      files: { before: filesBefore, after: await fileSizes(copiedSeed) },
    },
    cumulativeQuery: { boundary: sample.boundary, ...cumulativeQuery },
    insertWrite,
  };
  const reportFile = path.join(output, "index-migration-report.json");
  await writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return { report, reportFile };
}
async function main() {
  if (process.argv.length !== 4) {
    process.stderr.write(
      "usage: node experiments/architecture-20261101/index-migration-benchmark.mjs <schema-24-seed.sqlite> <new-output-directory>\n",
    );
    process.exitCode = 2;
    return;
  }
  if (!within(path.resolve(process.cwd(), "output"), process.argv[3])) {
    fail("CLI_OUTPUT_OUTSIDE_ROOT", "CLI output directory must be within cwd/output");
  }
  const { report } = await runIndexMigrationBenchmark({
    seedFile: process.argv[2],
    outputDirectory: process.argv[3],
  });
  const { index, cumulativeQuery, insertWrite } = report;
  const summary = {
    ok: report.ok,
    dataPreserved: report.dataPreserved,
    schemaVersion: report.schemaVersion,
    index: { columns: index.columns, firstOpenMs: index.firstOpenMs, firstCheckpointMs: index.firstCheckpointMs,
      firstCloseMs: index.firstCloseMs, reopenMs: index.reopenMs, dbstat: index.dbstat, pages: index.pages },
    cumulativeQuery: { boundary: cumulativeQuery.boundary, exactMatch: cumulativeQuery.exactMatch,
      indexedMs: cumulativeQuery.indexedMs, unindexedMs: cumulativeQuery.unindexedMs,
      indexedPlan: cumulativeQuery.indexedPlan, unindexedPlan: cumulativeQuery.unindexedPlan },
    insertWrite,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error?.code || "BENCHMARK_FAILED" })}\n`);
    process.exitCode = 1;
  });
}
