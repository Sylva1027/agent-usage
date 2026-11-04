import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, stat, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { getHeapStatistics } from "node:v8";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { readUsageSourceProgress } from "../../src/usage-source-progress.js";
import { UsageStore } from "../../src/usage-store.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const WORKSPACE_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
const DATASET_ROOT = path.join(WORKSPACE_ROOT, "output", "architecture-20261103", "growth-baseline");
const OUTPUT_ROOT = path.join(WORKSPACE_ROOT, "output", "architecture-20261103", "b2");
const HEAP_LIMIT_MIB = 224;
const SEMI_SPACE_MIB = 4;
const CASE_TIMEOUT_MS = 20 * 60 * 1000;
const NORMAL_APPEND_COUNT = 3;
const MAX_TRACKED_BYTES = 256n * 1024n * 1024n;
const EXACT_CASE_NAMES = new Set([
  "1x-codex-C",
  "1x-codex-E",
  "1x-dsh-C",
  "1x-dsh-E",
  "10x-codex-C",
  "10x-codex-E",
  "10x-dsh-C",
  "10x-dsh-E",
]);

function json(value) {
  return JSON.stringify(value, null, 2);
}

function nowIso() {
  return new Date().toISOString();
}

function runLabel() {
  return `growth-incremental-${nowIso().replaceAll(":", "").replaceAll(".", "")}`;
}

function safeLabel(value) {
  assert.match(value, /^growth-[a-z0-9.-]+$/i, `unsafe output label: ${value}`);
  return value;
}

function isStrictChild(parent, candidate) {
  const parentPath = path.resolve(parent);
  const candidatePath = path.resolve(candidate);
  const relative = path.relative(parentPath, candidatePath);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function databaseUrl(filePath) {
  return path.resolve(filePath).replaceAll("\\", "/");
}

function cpuDelta(before, after) {
  return {
    userMs: (after.user - before.user) / 1000,
    systemMs: (after.system - before.system) / 1000,
    totalMs: (after.user + after.system - before.user - before.system) / 1000,
  };
}

function memorySnapshot() {
  const memory = process.memoryUsage();
  const resource = process.resourceUsage();
  return {
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    rssBytes: memory.rss,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    lifetimeMaxRssBytes: Number(resource.maxRSS) * 1024,
  };
}

async function physicalSnapshot(filePath) {
  const info = await stat(filePath, { bigint: true });
  assert.ok(info.isFile(), `${filePath} is not a regular file`);
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    birthtimeNs: info.birthtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
    mtimeNs: info.mtimeNs.toString(),
    size: info.size.toString(),
  };
}

async function measured(work) {
  const wallStarted = performance.now();
  const cpuStarted = process.cpuUsage();
  const result = await work();
  return {
    result,
    timing: {
      wallMs: performance.now() - wallStarted,
      cpu: cpuDelta(cpuStarted, process.cpuUsage()),
      memory: memorySnapshot(),
    },
  };
}

async function hashStream(stream) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of stream) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function hashFile(filePath) {
  return hashStream(createReadStream(filePath));
}

async function hashRange(filePath, start, end) {
  assert.ok(Number.isSafeInteger(start) && start >= 0, `invalid hash start ${start}`);
  assert.ok(Number.isSafeInteger(end) && end >= start, `invalid hash end ${end}`);
  if (start === end) return { sha256: createHash("sha256").digest("hex"), bytes: 0 };
  const result = await hashStream(createReadStream(filePath, { start, end: end - 1 }));
  assert.equal(result.bytes, end - start, "range hash did not consume the exact range");
  return result;
}

async function readDataset(scale) {
  const datasetFile = path.join(DATASET_ROOT, scale, "dataset.json");
  const dataset = JSON.parse(await readFile(datasetFile, "utf8"));
  assert.equal(dataset.scale, Number(scale.slice(0, -1)), "dataset scale mismatch");
  assert.equal(path.resolve(dataset.root), path.join(path.dirname(datasetFile), "home"));
  return { dataset, datasetFile };
}

function selectedSources(dataset) {
  const selected = {};
  for (const kind of ["codex", "dsh"]) {
    const matching = dataset.inputs
      .filter((entry) => entry.role === "usage-file" && entry.kind === kind)
      .sort((left, right) => Number(right.sourceBytes) - Number(left.sourceBytes));
    assert.ok(matching.length > 0, `no ${kind} usage-file in dataset`);
    const source = matching[0];
    assert.ok(source.path.startsWith(`${dataset.root}${path.sep}`), `${kind} source is outside its dataset root`);
    assert.match(source.sha256, /^[a-f0-9]{64}$/, `${kind} source hash is malformed`);
    selected[kind] = {
      kind,
      path: path.resolve(source.path),
      sourceBytes: Number(source.sourceBytes),
      decodedBytes: Number(source.decodedBytes),
      rows: Number(source.rows),
      events: Number(source.events),
      quotaObservations: Number(source.quotaObservations),
      compressed: Boolean(source.compressed),
      sha256: source.sha256,
      sessionKey: source.sessionKey,
    };
  }
  return selected;
}

async function verifyFrozenSources() {
  const results = [];
  for (const scale of ["1x", "10x"]) {
    const { dataset, datasetFile } = await readDataset(scale);
    const sources = selectedSources(dataset);
    for (const kind of ["codex", "dsh"]) {
      const entry = sources[kind];
      const info = await stat(entry.path);
      assert.equal(info.size, entry.sourceBytes, `${scale}/${kind} source size differs from dataset`);
      const streamed = await hashFile(entry.path);
      assert.equal(streamed.bytes, entry.sourceBytes, `${scale}/${kind} source stream length differs`);
      results.push({
        scale,
        kind,
        datasetFile,
        path: entry.path,
        bytes: streamed.bytes,
        sha256: streamed.sha256,
        expectedSha256: entry.sha256,
        matches: streamed.sha256 === entry.sha256,
      });
    }
  }
  assert.ok(
    results.every((entry) => entry.matches),
    "one or more frozen source hashes changed",
  );
  return results;
}

function sourceLayout(homeDir, source) {
  if (source.kind === "codex") {
    return path.join(homeDir, ".codex", "sessions", "fixture", path.basename(source.path));
  }
  return path.join(
    homeDir,
    ".dsh",
    "sessions",
    "fixture",
    path.basename(path.dirname(source.path)),
    path.basename(source.path),
  );
}

function usage(last) {
  return {
    total_tokens: last,
    input_tokens: last,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}

function codexAppendPayload(checkpoint, index, timestamp) {
  assert.equal(checkpoint.adapter, "codex-jsonl", "Codex append requires the Codex checkpoint adapter");
  const previous = checkpoint.state?.previousCumulative;
  assert.ok(previous, "Codex checkpoint has no previous cumulative usage");
  for (const field of ["total", "input", "cached", "output", "reasoning"]) {
    assert.ok(Number.isFinite(previous[field]) && previous[field] >= 0, `Codex checkpoint ${field} is invalid`);
  }
  const delta = 40 + index;
  const cumulative = {
    ...previous,
    total: previous.total + delta,
    input: previous.input + delta,
  };
  const row = {
    timestamp: new Date(timestamp).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: cumulative.total,
          input_tokens: cumulative.input,
          cached_input_tokens: cumulative.cached,
          output_tokens: cumulative.output,
          reasoning_output_tokens: cumulative.reasoning,
        },
        last_token_usage: usage(delta),
      },
    },
  };
  return {
    bytes: Buffer.from(`${JSON.stringify(row)}\n`, "utf8"),
    expectedDelta: delta,
    semantic: {
      type: "codex-token-count",
      timestamp: row.timestamp,
      cumulativeTotal: cumulative.total,
      lastTotal: delta,
    },
  };
}

function dshAppendPayload(checkpoint, index, timestamp) {
  assert.equal(checkpoint.adapter, "dsh-v4-zstd", "DSH append requires the DSH checkpoint adapter");
  assert.equal(checkpoint.state?.header?.version, 4, "DSH checkpoint is not v4");
  const model = String(checkpoint.state.model || "gpt-5.1-codex");
  const provider = String(checkpoint.state.modelProvider || "fixture");
  const output = 10 + index;
  const input = 18;
  const cacheRead = 2;
  const total = input + cacheRead + output;
  const rows = [
    {
      type: "request/header",
      time: timestamp,
      data: { header: { config: { model, provider } } },
    },
    {
      type: "assistant/message",
      seq: 900000000 + index,
      time: timestamp,
      data: {
        turn: 900000,
        step: index,
        usage: {
          inputTokens: input,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: 0,
          outputTokens: output,
          totalTokens: total,
        },
      },
    },
  ];
  const text = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  return {
    bytes: zstdCompressSync(Buffer.from(text, "utf8")),
    expectedDelta: total,
    semantic: {
      type: "dsh-assistant-message-frame",
      timestamp,
      seq: rows[1].seq,
      model,
      provider,
      input,
      cached: cacheRead,
      output,
      total,
    },
  };
}

function appendPayload(source, checkpoint, index, timestamp) {
  const payload =
    source.kind === "codex"
      ? codexAppendPayload(checkpoint, index, timestamp)
      : dshAppendPayload(checkpoint, index, timestamp);
  assert.ok(Buffer.isBuffer(payload.bytes) && payload.bytes.length > 0, "append payload must be non-empty bytes");
  return payload;
}

function currentCheckpoint(store, filePath) {
  const saved = readUsageSourceProgress(store.database, filePath);
  assert.ok(saved, "usage source checkpoint is missing");
  assert.ok(Number.isSafeInteger(saved.checkpoint.offset), "checkpoint offset is not an integer");
  assert.equal(
    saved.checkpoint.offset,
    Number(store.database.prepare("SELECT size FROM source_files WHERE path=?").get(filePath)?.size),
    "checkpoint offset does not match indexed file size",
  );
  return saved;
}

async function dashboardTotals(store, now) {
  const all = await measured(() =>
    store.dashboardHistory({ preset: "all", calendarZone: "utc", bucket: "day", now }, { includeDetails: false }),
  );
  const today = await measured(() =>
    store.dashboardHistory({ preset: "today", calendarZone: "utc", bucket: "hour", now }, { includeDetails: false }),
  );
  for (const [scope, value] of [
    ["all", all.result],
    ["today", today.result],
  ]) {
    assert.ok(Number.isFinite(value?.summary?.totals?.total), `${scope} dashboard total is missing`);
    assert.ok(Number.isSafeInteger(value.summary.eventCount), `${scope} dashboard eventCount is missing`);
    assert.ok(Array.isArray(value.summary.timeline), `${scope} dashboard timeline is missing`);
  }
  return {
    totals: {
      all: all.result.summary.totals.total,
      today: today.result.summary.totals.total,
      allEvents: all.result.summary.eventCount,
      todayEvents: today.result.summary.eventCount,
    },
    timing: {
      all: all.timing,
      today: today.timing,
    },
  };
}

async function freshFullReplacementOracle({ homeDir, databaseFile, now, label }) {
  const oracle = new UsageStore({
    homeDir,
    databaseFile,
    env: {},
    importDirs: [],
  });
  try {
    await oracle.open();
    oracle.appendFile = async () => null;
    const sync = await measured(() => oracle.sync());
    const work = { ...oracle.lastSyncSourceWork };
    assert.equal(work.appendedFiles, 0, `${label}: fresh oracle unexpectedly appended`);
    assert.equal(work.replacedFiles, 1, `${label}: fresh oracle did not full-parse its source`);
    const sourceRows = oracle.database.prepare("SELECT path,size FROM source_files ORDER BY path").all();
    assert.equal(sourceRows.length, 1, `${label}: fresh oracle source count`);
    assert.equal(Number(work.parsedBytes), Number(sourceRows[0].size), `${label}: fresh oracle parsedBytes`);
    const dashboard = await dashboardTotals(oracle, now);
    const counts = actualSourceCounts(oracle);
    const integrity = quickCheck(oracle.database);
    return {
      databaseFile,
      timing: sync.timing,
      sourceWork: work,
      dashboard,
      counts: { ...counts },
      quickCheck: integrity,
      sourceBinding: sourceBinding(oracle, String(sourceRows[0].path)),
    };
  } finally {
    oracle.close();
  }
}

function assertTotalsAdvance(before, after, expectedDelta, label) {
  assert.equal(
    after.all,
    before.all + expectedDelta,
    `${label}: all dashboard expected +${expectedDelta}, got ${after.all - before.all}`,
  );
  assert.equal(
    after.today,
    before.today + expectedDelta,
    `${label}: today dashboard expected +${expectedDelta}, got ${after.today - before.today}`,
  );
  assert.equal(after.allEvents, before.allEvents + 1, `${label}: all event count must advance by one`);
  assert.equal(after.todayEvents, before.todayEvents + 1, `${label}: today event count must advance by one`);
}

function assertWork(work, expected, label) {
  assert.ok(work && typeof work === "object", `${label}: lastSyncSourceWork is missing`);
  assert.equal(work.appendedFiles, expected.appendedFiles, `${label}: appendedFiles`);
  assert.equal(work.replacedFiles, expected.replacedFiles, `${label}: replacedFiles`);
  assert.ok(Number.isSafeInteger(work.parsedBytes) && work.parsedBytes >= 0, `${label}: parsedBytes is invalid`);
  assert.ok(
    Number.isSafeInteger(work.prefixBytesRead) && work.prefixBytesRead >= 0,
    `${label}: prefixBytesRead is invalid`,
  );
  assert.ok(Number.isSafeInteger(work.journalBytes) && work.journalBytes >= 0, `${label}: journalBytes is invalid`);
}

function assertNativeIncrement(work, checkpoint, storage, label, { oldPrefixBytes, suffixBytes }) {
  assert.equal(work.parsedBytes, suffixBytes, `${label}: parsed bytes must equal the appended suffix`);
  if (storage === "C") {
    if (work.appendedFiles === 1) {
      assert.equal(work.replacedFiles, 0, `${label}: native increment also reported replacement`);
      assert.equal(work.prefixBytesRead, 0, `${label}: native increment reread a source prefix`);
      assert.ok(work.journalBytes > 0, `${label}: native increment returned no journal bytes`);
      assert.equal(checkpoint.validation.kind, "ntfs-usn-v1", `${label}: native validation kind`);
    }
    return;
  }
  assert.equal(work.appendedFiles, 1, `${label}: E: SHA fallback did not parse the exact suffix`);
  assert.equal(work.replacedFiles, 0, `${label}: E: SHA fallback unexpectedly performed a full replacement`);
  assert.equal(work.journalBytes, 0, `${label}: E: inactive journal returned journal bytes`);
  assert.equal(checkpoint.validation.kind, "sha256-prefix-v1", `${label}: E: fallback validation kind`);
  assert.equal(
    work.prefixBytesRead,
    2 * oldPrefixBytes + suffixBytes,
    `${label}: E: SHA fallback must read old prefix twice plus the suffix`,
  );
}

function eventTimestamp(index) {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0);
  return start + index * 1000;
}

async function prepareFixture(config) {
  assert.ok(EXACT_CASE_NAMES.has(config.caseName), `unexpected case name ${config.caseName}`);
  const { dataset } = await readDataset(config.scale);
  const source = selectedSources(dataset)[config.kind];
  if (config.storage === "C") {
    const localTemp = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp") : os.tmpdir();
    await mkdir(localTemp, { recursive: true });
    const resolvedTemp = path.resolve(localTemp);
    const root = path.resolve(await mkdtemp(path.join(resolvedTemp, "codex-b2-growth-")));
    assert.ok(isStrictChild(resolvedTemp, root), "C: private fixture escaped LOCALAPPDATA/Temp");
    assert.match(path.basename(root), /^codex-b2-growth-/, "C: private fixture prefix mismatch");
    return { source, dataset, homeDir: root, cleanupRoot: root, workspace: root };
  }
  assert.equal(config.storage, "E", "storage must be C or E");
  const outputPrefix = path.resolve(config.runDirectory);
  assert.ok(isStrictChild(OUTPUT_ROOT, outputPrefix), "E: run directory escaped B2 output root");
  const workspace = path.resolve(await mkdtemp(path.join(outputPrefix, "growth-fixture-")));
  assert.ok(isStrictChild(outputPrefix, workspace), "E: private fixture escaped its run directory");
  const homeDir = path.join(workspace, "home");
  await mkdir(homeDir, { recursive: true });
  return { source, dataset, homeDir, cleanupRoot: workspace, workspace };
}

async function copyFixture(sourcePath, targetPath, expected) {
  await mkdir(path.dirname(targetPath), { recursive: true });
  const parentStats = await statfs(path.dirname(path.dirname(targetPath)));
  const available = BigInt(parentStats.bavail) * BigInt(parentStats.bsize);
  assert.ok(
    available >= BigInt(expected.sourceBytes) + MAX_TRACKED_BYTES,
    `insufficient free space: ${available} bytes available`,
  );
  await copyFile(sourcePath, targetPath);
  const copied = await stat(targetPath);
  assert.equal(copied.size, expected.sourceBytes, "copied fixture size differs from source");
  const streamed = await hashFile(targetPath);
  assert.equal(streamed.bytes, expected.sourceBytes, "copied fixture stream length differs");
  assert.equal(streamed.sha256, expected.sha256, "copied fixture hash differs from frozen source");
  return {
    targetPath,
    bytes: streamed.bytes,
    sha256: streamed.sha256,
    availableBeforeCopyBytes: available.toString(),
    mtimeMs: copied.mtimeMs,
  };
}

function factColumns(database, table, excluded = []) {
  const ignored = new Set(excluded);
  const columns = database
    .prepare(`PRAGMA main.table_info(${quoteIdentifier(table)})`)
    .all()
    .map((row) => String(row.name))
    .filter((name) => !ignored.has(name));
  assert.ok(columns.length > 0, `${table} has no comparable columns`);
  return columns;
}

function factHash(database, table, columns) {
  const quoted = columns.map(quoteIdentifier);
  const hash = createHash("sha256");
  let count = 0;
  for (const row of database
    .prepare(`SELECT ${quoted.join(",")} FROM main.${quoteIdentifier(table)} ORDER BY ${quoted.join(",")}`)
    .iterate()) {
    hash.update(JSON.stringify(row));
    hash.update("\n");
    count += 1;
  }
  return { count, sha256: hash.digest("hex") };
}

function tableDifference(database, table, columns, side) {
  const projected = columns.map((column) => quoteIdentifier(column)).join(",");
  const other = side === "left" ? "oracle_compare" : "main";
  const own = side === "left" ? "main" : "oracle_compare";
  return Number(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM (
        SELECT ${projected} FROM ${own}.${quoteIdentifier(table)}
        EXCEPT
        SELECT ${projected} FROM ${other}.${quoteIdentifier(table)}
      )`,
      )
      .get().count,
  );
}

function compareFacts(store, oracleDatabaseFile) {
  store.database.prepare("ATTACH DATABASE ? AS oracle_compare").run(databaseUrl(oracleDatabaseFile));
  try {
    const tables = [
      { name: "events", excluded: ["id"] },
      { name: "rate_limit_observations", excluded: [] },
      { name: "quota_usage_sources", excluded: [] },
    ];
    const comparisons = [];
    for (const table of tables) {
      const columns = factColumns(store.database, table.name, table.excluded);
      const leftOnly = tableDifference(store.database, table.name, columns, "left");
      const rightOnly = tableDifference(store.database, table.name, columns, "right");
      assert.equal(leftOnly, 0, `${table.name}: current store has rows missing from full oracle`);
      assert.equal(rightOnly, 0, `${table.name}: full oracle has rows missing from current store`);
      comparisons.push({
        table: table.name,
        columns,
        leftOnly,
        rightOnly,
        current: factHash(store.database, table.name, columns),
        oracle: factHashFromAttached(store.database, table.name, columns),
      });
    }
    return comparisons;
  } finally {
    store.database.exec("DETACH DATABASE oracle_compare");
  }
}

function factHashFromAttached(database, table, columns) {
  const quoted = columns.map(quoteIdentifier);
  const hash = createHash("sha256");
  let count = 0;
  for (const row of database
    .prepare(`SELECT ${quoted.join(",")} FROM oracle_compare.${quoteIdentifier(table)} ORDER BY ${quoted.join(",")}`)
    .iterate()) {
    hash.update(JSON.stringify(row));
    hash.update("\n");
    count += 1;
  }
  return { count, sha256: hash.digest("hex") };
}

function sourceBinding(store, filePath) {
  const row = store.database
    .prepare(
      `SELECT kind,home_id AS homeId,home_label AS homeLabel,home_path AS homePath,size,mtime_ms AS mtimeMs
     FROM source_files WHERE path=?`,
    )
    .get(filePath);
  assert.ok(row, "source_files binding is missing");
  return { ...row };
}

function quickCheck(database) {
  const rows = database
    .prepare("PRAGMA quick_check")
    .all()
    .map((row) => row.quick_check);
  assert.deepEqual(rows, ["ok"], "SQLite quick_check failed");
  return rows;
}

function expectedSourceCounts(source) {
  return {
    events: source.events,
    rateLimitObservations: source.quotaObservations,
  };
}

function actualSourceCounts(store) {
  return store.database
    .prepare(
      `SELECT
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM rate_limit_observations) AS rateLimitObservations,
      (SELECT COUNT(*) FROM source_files) AS sourceFiles,
      (SELECT COUNT(*) FROM quota_usage_sources) AS quotaUsageSources`,
    )
    .get();
}

async function worker(configFile) {
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const expectedHeap = HEAP_LIMIT_MIB * 1024 * 1024;
  const heapLimit = Number(process.execArgv.find((arg) => arg.startsWith("--max-old-space-size="))?.split("=")[1]);
  assert.equal(heapLimit, HEAP_LIMIT_MIB, "worker old-space limit is not 224 MiB");
  assert.ok(
    process.execArgv.includes(`--max-semi-space-size=${SEMI_SPACE_MIB}`),
    "worker semi-space limit is not 4 MiB",
  );
  const { source, homeDir, cleanupRoot } = await prepareFixture(config);
  const filePath = sourceLayout(homeDir, source);
  const databaseFile = config.databaseFile;
  const oracleDatabaseFile = `${databaseFile}.oracle`;
  const result = {
    label: config.caseName,
    startedAt: nowIso(),
    identity: {
      user: os.userInfo().username,
      homedir: os.homedir(),
      platform: process.platform,
      node: process.version,
      execArgv: [...process.execArgv],
      heapLimitBytes: expectedHeap,
      heapLimitObservedBytes: getHeapStatistics().heap_size_limit,
      localAppData: process.env.LOCALAPPDATA || null,
    },
    source: {
      kind: source.kind,
      frozenPath: source.path,
      fixturePath: filePath,
      expectedBytes: source.sourceBytes,
      expectedSha256: source.sha256,
      expectedEvents: source.events,
      expectedRateLimitObservations: source.quotaObservations,
    },
    fixture: {
      homeDir,
      cleanupRoot,
      databaseFile,
      copy: null,
    },
    steps: [],
    failure: null,
    cleanup: null,
  };
  let store = null;
  let success = false;
  try {
    console.log(JSON.stringify({ event: "copy-start", label: config.caseName, at: nowIso() }));
    result.fixture.copy = await copyFixture(source.path, filePath, source);
    const copiedInfo = await stat(filePath);
    result.fixture.copy.mtimeMs = copiedInfo.mtimeMs;
    result.fixture.copy.physical = await physicalSnapshot(filePath);
    const originalSize = Number(copiedInfo.size);
    const originalPrefixHash = (await hashRange(filePath, 0, originalSize)).sha256;
    result.fixture.copy.originalPrefixSha256 = originalPrefixHash;

    store = new UsageStore({
      homeDir,
      databaseFile,
      env: {},
      importDirs: [],
    });
    const now = new Date(Number(config.nowMs));
    assert.ok(Number.isFinite(now.getTime()), "dashboard now is invalid");

    console.log(JSON.stringify({ event: "initial-sync-start", label: config.caseName, at: nowIso() }));
    const initialSync = await measured(() => store.sync());
    assertWork(store.lastSyncSourceWork, { appendedFiles: 0, replacedFiles: 1 }, "initial");
    const initialCheckpoint = currentCheckpoint(store, filePath);
    const initialCounts = actualSourceCounts(store);
    assert.deepEqual(
      {
        events: Number(initialCounts.events),
        rateLimitObservations: Number(initialCounts.rateLimitObservations),
      },
      expectedSourceCounts(source),
      "initial full parse counts differ from the frozen dataset",
    );
    assert.equal(Number(initialCounts.sourceFiles), 1, "initial sync discovered more than one source");
    const initialDashboard = await dashboardTotals(store, now);
    result.steps.push({
      name: "initial",
      kind: "full-parse",
      timing: initialSync.timing,
      syncResult: initialSync.result,
      sourceWork: { ...store.lastSyncSourceWork },
      checkpoint: initialCheckpoint,
      counts: { ...initialCounts },
      dashboard: initialDashboard,
      prefixSha256: originalPrefixHash,
      physical: result.fixture.copy.physical,
    });
    let previousTotals = initialDashboard.totals;
    let comparisonOracle = null;
    let mainStoredInfo = null;
    let mainStoredPhysical = null;
    console.log(
      JSON.stringify({
        event: "initial-sync-finished",
        label: config.caseName,
        events: Number(initialCounts.events),
        validation: initialCheckpoint.validation.kind,
        wallMs: initialSync.timing.wallMs,
      }),
    );

    for (let index = 1; index <= NORMAL_APPEND_COUNT; index += 1) {
      const beforeAppend = currentCheckpoint(store, filePath);
      const beforeInfo = await stat(filePath);
      const beforePrefix = await hashRange(filePath, 0, originalSize);
      assert.equal(beforePrefix.sha256, originalPrefixHash, `append-${index}: original prefix changed before append`);
      const physicalBefore = await physicalSnapshot(filePath);
      const payload = appendPayload(source, beforeAppend.checkpoint, index, eventTimestamp(index));
      await appendFile(filePath, payload.bytes);
      const postAppendInfo = await stat(filePath);
      assert.equal(
        postAppendInfo.size,
        beforeInfo.size + payload.bytes.length,
        `append-${index}: file growth mismatch`,
      );
      const prefixBeforeSync = await hashRange(filePath, 0, originalSize);
      assert.equal(prefixBeforeSync.sha256, originalPrefixHash, `append-${index}: original prefix changed by append`);

      const sync = await measured(() => store.sync());
      const work = { ...store.lastSyncSourceWork };
      const checkpoint = currentCheckpoint(store, filePath);
      assertNativeIncrement(work, checkpoint, config.storage, `append-${index}`, {
        oldPrefixBytes: beforeAppend.checkpoint.offset,
        suffixBytes: payload.bytes.length,
      });
      const prefixAfterSync = await hashRange(filePath, 0, originalSize);
      assert.equal(prefixAfterSync.sha256, originalPrefixHash, `append-${index}: prefix changed during sync`);
      const physicalAfter = await physicalSnapshot(filePath);
      for (const field of ["dev", "ino", "birthtimeNs"]) {
        assert.equal(physicalAfter[field], physicalBefore[field], `append-${index}: source physical ${field} changed`);
      }
      const dashboard = await dashboardTotals(store, now);
      assertTotalsAdvance(previousTotals, dashboard.totals, payload.expectedDelta, `append-${index}`);
      previousTotals = dashboard.totals;
      result.steps.push({
        name: `append-${index}`,
        kind: "small-append",
        bytesAppended: payload.bytes.length,
        expectedDelta: payload.expectedDelta,
        semantic: payload.semantic,
        fileSizeBefore: beforeInfo.size,
        fileSizeAfter: postAppendInfo.size,
        prefixSha256: originalPrefixHash,
        timing: sync.timing,
        syncResult: sync.result,
        sourceWork: work,
        checkpoint,
        dashboard,
        physicalBefore,
        physicalAfter,
      });
      console.log(
        JSON.stringify({
          event: "append-finished",
          label: config.caseName,
          index,
          expectedDelta: payload.expectedDelta,
          appendedFiles: work.appendedFiles,
          replacedFiles: work.replacedFiles,
          parsedBytes: work.parsedBytes,
          prefixBytesRead: work.prefixBytesRead,
          journalBytes: work.journalBytes,
          total: dashboard.totals.all,
          wallMs: sync.timing.wallMs,
        }),
      );
    }

    if (config.storage === "E") {
      const controlIndex = NORMAL_APPEND_COUNT + 1;
      const beforeControl = currentCheckpoint(store, filePath);
      const beforeControlInfo = await stat(filePath);
      const physicalBefore = await physicalSnapshot(filePath);
      const controlPayload = appendPayload(
        source,
        beforeControl.checkpoint,
        controlIndex,
        eventTimestamp(controlIndex),
      );
      console.log(JSON.stringify({ event: "full-control-append-start", label: config.caseName }));
      await appendFile(filePath, controlPayload.bytes);
      const postAppendInfo = await stat(filePath);
      assert.equal(
        postAppendInfo.size,
        beforeControlInfo.size + controlPayload.bytes.length,
        "full-control file growth mismatch",
      );
      const prefixBeforeSync = await hashRange(filePath, 0, originalSize);
      assert.equal(prefixBeforeSync.sha256, originalPrefixHash, "full-control original prefix changed by append");
      const originalAppendFile = store.appendFile.bind(store);
      let sync;
      console.log(JSON.stringify({ event: "full-control-sync-start", label: config.caseName }));
      try {
        store.appendFile = async () => null;
        sync = await measured(() => store.sync());
      } finally {
        store.appendFile = originalAppendFile;
      }
      console.log(
        JSON.stringify({
          event: "full-control-sync-finished",
          label: config.caseName,
          wallMs: sync.timing.wallMs,
        }),
      );
      const work = { ...store.lastSyncSourceWork };
      assert.equal(work.appendedFiles, 0, "full-control unexpectedly used incremental append");
      assert.equal(work.replacedFiles, 1, "full-control did not force full replacement");
      assert.equal(work.parsedBytes, postAppendInfo.size, "full-control must parse the complete current file");
      const checkpoint = currentCheckpoint(store, filePath);
      assert.equal(checkpoint.validation.kind, "sha256-prefix-v1", "full-control validation kind");
      const physicalAfter = await physicalSnapshot(filePath);
      for (const field of ["dev", "ino", "birthtimeNs"]) {
        assert.equal(physicalAfter[field], physicalBefore[field], `full-control: source physical ${field} changed`);
      }
      const dashboard = await dashboardTotals(store, now);
      assertTotalsAdvance(previousTotals, dashboard.totals, controlPayload.expectedDelta, "full-control");
      const prefixAfterSync = await hashRange(filePath, 0, originalSize);
      assert.equal(prefixAfterSync.sha256, originalPrefixHash, "full-control prefix changed during sync");
      previousTotals = dashboard.totals;
      result.steps.push({
        name: "full-control",
        kind: "forced-full-replacement",
        note: "The current implementation was locally patched appendFile=>null after three appends; this is not a saved pre-B1 baseline.",
        bytesAppended: controlPayload.bytes.length,
        expectedDelta: controlPayload.expectedDelta,
        semantic: controlPayload.semantic,
        fileSizeBefore: beforeControlInfo.size,
        fileSizeAfter: postAppendInfo.size,
        prefixSha256: originalPrefixHash,
        timing: sync.timing,
        syncResult: sync.result,
        sourceWork: work,
        checkpoint,
        dashboard,
        physicalBefore,
        physicalAfter,
      });
      console.log(
        JSON.stringify({
          event: "full-control-finished",
          label: config.caseName,
          replacedFiles: work.replacedFiles,
          parsedBytes: work.parsedBytes,
          total: dashboard.totals.all,
          wallMs: sync.timing.wallMs,
        }),
      );
    }

    if (!comparisonOracle) {
      mainStoredInfo = await stat(filePath);
      mainStoredPhysical = await physicalSnapshot(filePath);
      console.log(JSON.stringify({ event: "oracle-start", label: config.caseName, at: nowIso() }));
      comparisonOracle = await freshFullReplacementOracle({
        homeDir,
        databaseFile: oracleDatabaseFile,
        now,
        label: "final-oracle",
      });
    }

    const currentBinding = sourceBinding(store, filePath);
    for (const field of ["dev", "ino", "birthtimeNs"]) {
      assert.equal(
        mainStoredPhysical[field],
        result.fixture.copy.physical[field],
        `final source physical ${field} changed from the copied fixture`,
      );
    }
    assert.equal(Number(currentBinding.size), mainStoredInfo.size, "source binding size differs from main-store state");
    assert.equal(
      Number(currentBinding.mtimeMs),
      mainStoredInfo.mtimeMs,
      "source binding mtime differs from main-store state",
    );
    result.factComparison = compareFacts(store, comparisonOracle.databaseFile);
    const currentQuickCheck = quickCheck(store.database);
    result.oracle = {
      databaseFile: comparisonOracle.databaseFile,
      timing: comparisonOracle.timing,
      sourceWork: comparisonOracle.sourceWork,
      dashboard: comparisonOracle.dashboard,
      quickCheck: comparisonOracle.quickCheck,
      sourceBinding: comparisonOracle.sourceBinding,
    };
    result.sourceBinding = currentBinding;
    result.sourcePhysical = mainStoredPhysical;
    result.sourceFinalPhysical = await physicalSnapshot(filePath);
    result.quickCheck = currentQuickCheck;
    result.finalDashboardTotals = previousTotals;
    result.finishedAt = nowIso();
    result.process = {
      cpu: process.cpuUsage(),
      resourceUsage: process.resourceUsage(),
      memory: memorySnapshot(),
    };
    success = true;
    console.log(JSON.stringify({ event: "case-passed", label: config.caseName, at: result.finishedAt }));
  } catch (error) {
    result.failure = {
      name: error?.name || "Error",
      message: error?.message || String(error),
      code: error?.code || null,
      stack: error?.stack || String(error),
    };
    console.error(error?.stack || String(error));
  } finally {
    try {
      store?.close();
    } catch (error) {
      result.cleanup = { ...result.cleanup, storeCloseError: error.message };
    }
    if (success) {
      try {
        const resolvedRoot = path.resolve(cleanupRoot);
        if (config.storage === "C") {
          const localTemp = path.resolve(
            process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Temp") : os.tmpdir(),
          );
          assert.ok(isStrictChild(localTemp, resolvedRoot), "refusing to clean an unverified C: fixture path");
        } else {
          assert.ok(
            isStrictChild(path.resolve(config.runDirectory), resolvedRoot),
            "refusing to clean an unverified E: fixture path",
          );
        }
        await rm(resolvedRoot, { recursive: true, force: true });
        result.cleanup = { removed: true, path: resolvedRoot, at: nowIso() };
      } catch (error) {
        success = false;
        result.failure = {
          name: "CleanupError",
          message: error?.message || String(error),
          code: error?.code || null,
          stack: error?.stack || String(error),
        };
      }
    } else {
      result.cleanup = {
        removed: false,
        preservedFailurePath: cleanupRoot,
        reason: "failed run evidence retained",
      };
    }
    await writeFile(config.resultFile, json(result));
  }
  if (!success) process.exitCode = 1;
}

const SAMPLER_SCRIPT = `
param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [Parameter(Mandatory = $true)][string]$OutputFile,
  [int]$IntervalMs = 50
)
$ErrorActionPreference = "Stop"
$known = [System.Collections.Generic.HashSet[int]]::new()
[void]$known.Add($RootPid)
$records = @{}
$maxTreeWorkingSet = [uint64]0
$maxHelperWorkingSet = [uint64]0
$maxProcessCount = 0
$samples = 0
$rootGoneAt = $null
$observerPid = $PID
try {
  while ($true) {
    $all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,WorkingSetSize,UserModeTime,KernelModeTime)
    $byPid = @{}
    foreach ($item in $all) { $byPid[[int]$item.ProcessId] = $item }
    $changed = $true
    while ($changed) {
      $changed = $false
      foreach ($item in $all) {
        if ($known.Contains([int]$item.ParentProcessId) -and $known.Add([int]$item.ProcessId)) {
          $changed = $true
        }
      }
    }
    $sampleWorkingSet = [uint64]0
    $sampleProcesses = @()
    foreach ($processId in @($known)) {
      if (-not $byPid.ContainsKey($processId)) { continue }
      $item = $byPid[$processId]
      $workingSet = [uint64]$item.WorkingSetSize
      $cpuSeconds = ([double]$item.UserModeTime + [double]$item.KernelModeTime) / 10000000.0
      $sampleWorkingSet += $workingSet
      $sampleProcesses += [pscustomobject]@{
        pid = [int]$item.ProcessId
        parentPid = [int]$item.ParentProcessId
        name = [string]$item.Name
        executablePath = if ($item.ExecutablePath) { [string]$item.ExecutablePath } else { $null }
        workingSetBytes = $workingSet
        cpuSeconds = $cpuSeconds
      }
      $key = [string]$processId
      if (-not $records.ContainsKey($key)) {
        $records[$key] = [pscustomobject]@{
          pid = [int]$item.ProcessId
          parentPid = [int]$item.ParentProcessId
          name = [string]$item.Name
          executablePath = if ($item.ExecutablePath) { [string]$item.ExecutablePath } else { $null }
          peakWorkingSetBytes = $workingSet
          peakSampleCpuSeconds = $cpuSeconds
          lastSeen = [DateTimeOffset]::UtcNow.ToString("o")
        }
      } else {
        $record = $records[$key]
        if ($workingSet -gt $record.peakWorkingSetBytes) { $record.peakWorkingSetBytes = $workingSet }
        if ($cpuSeconds -gt $record.peakSampleCpuSeconds) { $record.peakSampleCpuSeconds = $cpuSeconds }
        $record.lastSeen = [DateTimeOffset]::UtcNow.ToString("o")
      }
    }
    if ($sampleWorkingSet -gt $maxTreeWorkingSet) { $maxTreeWorkingSet = $sampleWorkingSet }
    $helperWorkingSet = [uint64]0
    foreach ($sampleProcess in $sampleProcesses) {
      if ($sampleProcess.name -ieq "windows-source-proof.exe") { $helperWorkingSet += $sampleProcess.workingSetBytes }
    }
    if ($helperWorkingSet -gt $maxHelperWorkingSet) { $maxHelperWorkingSet = $helperWorkingSet }
    if ($sampleProcesses.Count -gt $maxProcessCount) { $maxProcessCount = $sampleProcesses.Count }
    $samples += 1
    if (-not $byPid.ContainsKey($RootPid)) {
      if ($null -eq $rootGoneAt) { $rootGoneAt = [DateTimeOffset]::UtcNow }
      if (($sampleProcesses | Measure-Object).Count -eq 0 -or
          ([DateTimeOffset]::UtcNow - $rootGoneAt).TotalMilliseconds -ge 1500) {
        break
      }
    }
    Start-Sleep -Milliseconds $IntervalMs
  }
} catch {
  $records["sampler-error"] = [pscustomobject]@{ error = $_.Exception.Message; stack = $_.ScriptStackTrace }
} finally {
  $payload = [pscustomobject]@{
    observerPid = $observerPid
    rootPid = $RootPid
    intervalMs = $IntervalMs
    samples = $samples
    maxTreeWorkingSetBytes = $maxTreeWorkingSet
    maxHelperWorkingSetBytes = $maxHelperWorkingSet
    maxProcessCount = $maxProcessCount
    processes = @($records.Values | Sort-Object pid)
    finishedAt = [DateTimeOffset]::UtcNow.ToString("o")
  }
  $payload | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $OutputFile -Encoding utf8
}
`;

async function stopSampler(sampler, timeoutMs = 5000) {
  if (!sampler || sampler.exitCode !== null) return { forced: false, exitCode: sampler?.exitCode ?? null };
  const exited = new Promise((resolve) => sampler.once("exit", (code, signal) => resolve({ code, signal })));
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  const immediate = await Promise.race([exited, timeout]);
  if (immediate) return { forced: false, ...immediate };
  sampler.kill();
  return { forced: true, wait: await Promise.race([exited, timeout]) };
}

function terminateProcessTree(pid) {
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

async function runCase(runDirectory, scale, kind, storage, nowMs, sampleCounter) {
  const caseName = `${scale}-${kind}-${storage}`;
  assert.ok(EXACT_CASE_NAMES.has(caseName), `unexpected matrix case ${caseName}`);
  const stem = safeLabel(`growth-case-${caseName}`);
  const configFile = path.join(runDirectory, `${stem}.worker.json`);
  const resultFile = path.join(runDirectory, `${stem}.json`);
  const logFile = path.join(runDirectory, `${stem}.log`);
  const samplerFile = path.join(runDirectory, `growth-sampler-${caseName}.json`);
  const databaseFile = path.join(runDirectory, `${stem}.sqlite`);
  const config = {
    caseName,
    scale,
    kind,
    storage,
    runDirectory,
    resultFile,
    databaseFile,
    nowMs,
    sampleCounter,
  };
  await writeFile(configFile, json(config));
  await writeFile(logFile, "");
  const command = [
    process.execPath,
    `--max-old-space-size=${HEAP_LIMIT_MIB}`,
    `--max-semi-space-size=${SEMI_SPACE_MIB}`,
    SCRIPT_PATH,
    "--worker",
    configFile,
  ];
  console.log(JSON.stringify({ event: "case-start", caseName, command }));
  const child = spawn(command[0], command.slice(1), {
    cwd: WORKSPACE_ROOT,
    env: { ...process.env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(child.pid, `${caseName}: failed to start worker`);
  const logChunks = [];
  child.stdout.on("data", (chunk) => logChunks.push(chunk));
  child.stderr.on("data", (chunk) => logChunks.push(chunk));
  let sampler = null;
  let timeout = null;
  let exit = null;
  let failure = null;
  try {
    sampler = spawn(
      "pwsh",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        path.join(runDirectory, "growth-sampler.ps1"),
        "-RootPid",
        String(child.pid),
        "-OutputFile",
        samplerFile,
        "-IntervalMs",
        "50",
      ],
      {
        cwd: WORKSPACE_ROOT,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let samplerStderr = "";
    sampler.stderr.on("data", (chunk) => {
      samplerStderr += chunk.toString();
    });
    exit = await new Promise((resolve) => {
      timeout = setTimeout(() => {
        failure = new Error(`${caseName}: worker exceeded ${CASE_TIMEOUT_MS} ms`);
        resolve({ code: null, signal: null, timedOut: true });
      }, CASE_TIMEOUT_MS);
      child.once("error", (error) => resolve({ code: null, signal: null, error }));
      child.once("exit", (code, signal) => resolve({ code, signal, timedOut: false }));
    });
    if (timeout) clearTimeout(timeout);
    if (exit.timedOut || exit.error) {
      const termination = terminateProcessTree(child.pid);
      failure = failure || exit.error || new Error(`${caseName}: worker terminated`);
      exit.cleanup = termination;
    }
    const samplerStop = await stopSampler(sampler);
    if (samplerStderr.trim()) samplerStop.stderr = samplerStderr.trim();
    exit.sampler = samplerStop;
  } catch (error) {
    failure = error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  await writeFile(logFile, Buffer.concat(logChunks));
  let workerResult;
  try {
    workerResult = JSON.parse(await readFile(resultFile, "utf8"));
  } catch (error) {
    workerResult = {
      label: caseName,
      failure: { name: "MissingWorkerResult", message: error.message },
    };
  }
  let samplerResult = null;
  try {
    samplerResult = JSON.parse((await readFile(samplerFile, "utf8")).replace(/^\uFEFF/, ""));
  } catch (error) {
    samplerResult = { failure: error.message };
  }
  const passed = exit?.code === 0 && workerResult.failure === null;
  const caseResult = {
    caseName,
    command,
    exit,
    passed,
    parentFailure: failure
      ? {
          name: failure.name,
          message: failure.message,
          stack: failure.stack,
        }
      : null,
    workerResult,
    sampler: samplerResult,
    logFile,
    configFile,
    resultFile,
  };
  await writeFile(resultFile, json(caseResult));
  console.log(
    JSON.stringify({
      event: "case-finished",
      caseName,
      passed,
      exitCode: exit?.code,
      failure: caseResult.parentFailure?.message || workerResult.failure?.message || null,
      workerPeakRssMiB:
        (samplerResult?.processes || [])
          .filter((entry) => entry.pid === child.pid)
          .map((entry) => entry.peakWorkingSetBytes / 1024 / 1024)[0] || null,
      helperPeakRssMiB: Number(samplerResult?.maxHelperWorkingSetBytes || 0) / 1024 / 1024,
    }),
  );
  return caseResult;
}

async function selfCheck() {
  assert.ok(isStrictChild("C:\\Temp", "C:\\Temp\\codex-b2-growth-a"));
  assert.equal(isStrictChild("C:\\Temp", "C:\\Temp"), false);
  assert.equal(isStrictChild("C:\\Temp", "C:\\TempBad\\x"), false);
  const checkpoint = {
    adapter: "codex-jsonl",
    state: {
      previousCumulative: { total: 100, input: 100, cached: 0, output: 0, reasoning: 0 },
    },
  };
  const codex = codexAppendPayload(checkpoint, 1, Date.parse("2026-11-03T12:00:00Z"));
  const row = JSON.parse(codex.bytes.toString("utf8"));
  assert.equal(row.payload.info.total_token_usage.total_tokens, 141);
  assert.equal(row.payload.info.last_token_usage.total_tokens, 41);
  const dshCheckpoint = {
    adapter: "dsh-v4-zstd",
    state: { header: { version: 4 }, model: "deepseek", modelProvider: "fixture" },
  };
  const dsh = dshAppendPayload(dshCheckpoint, 2, Date.parse("2026-11-03T12:00:00Z"));
  const decoded = zstdDecompressSync(dsh.bytes).toString("utf8").trim().split("\n").map(JSON.parse);
  assert.equal(decoded.length, 2);
  assert.equal(decoded[1].data.usage.totalTokens, 32);
  assert.equal(dsh.expectedDelta, 32);
  assertNativeIncrement(
    { appendedFiles: 1, replacedFiles: 0, parsedBytes: 3, prefixBytesRead: 43, journalBytes: 0 },
    { validation: { kind: "sha256-prefix-v1" } },
    "E",
    "self-check-fallback",
    { oldPrefixBytes: 20, suffixBytes: 3 },
  );
  assert.throws(
    () =>
      assertNativeIncrement(
        { appendedFiles: 1, replacedFiles: 0, parsedBytes: 3, prefixBytesRead: 20, journalBytes: 0 },
        { validation: { kind: "sha256-prefix-v1" } },
        "E",
        "self-check-fallback",
        { oldPrefixBytes: 20, suffixBytes: 3 },
      ),
    /read old prefix twice/,
  );
  assertNativeIncrement(
    { appendedFiles: 1, replacedFiles: 0, parsedBytes: 3, prefixBytesRead: 0, journalBytes: 7 },
    { validation: { kind: "ntfs-usn-v1" } },
    "C",
    "self-check-native",
    { oldPrefixBytes: 20, suffixBytes: 3 },
  );
  const output = path.join(OUTPUT_ROOT, safeLabel(`growth-selfcheck-${Date.now()}`));
  await mkdir(output);
  assert.ok(isStrictChild(OUTPUT_ROOT, output));
  await rm(output, { recursive: true, force: true });
  console.log(JSON.stringify({ event: "self-check-passed", at: nowIso() }));
}

async function parent() {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const runDirectory = path.join(OUTPUT_ROOT, safeLabel(runLabel()));
  await mkdir(runDirectory);
  const samplerScript = path.join(runDirectory, "growth-sampler.ps1");
  await writeFile(samplerScript, SAMPLER_SCRIPT, "utf8");
  const manifestFile = path.join(runDirectory, "growth-manifest.json");
  const startedAt = nowIso();
  const nowMs = Date.now();
  const manifest = {
    startedAt,
    runDirectory,
    command: {
      argv: process.argv,
      node: process.version,
      pwsh: "pwsh 7",
    },
    identity: {
      user: os.userInfo().username,
      homedir: os.homedir(),
      platform: process.platform,
      localAppData: process.env.LOCALAPPDATA || null,
      temp: os.tmpdir(),
    },
    limits: {
      oldSpaceMiB: HEAP_LIMIT_MIB,
      semiSpaceMiB: SEMI_SPACE_MIB,
      caseTimeoutMs: CASE_TIMEOUT_MS,
      normalAppendsPerCase: NORMAL_APPEND_COUNT,
    },
    selectedSources: {},
    sourceIntegrity: {},
    cases: [],
    failure: null,
    finishedAt: null,
  };
  await writeFile(manifestFile, json(manifest));
  try {
    for (const scale of ["1x", "10x"]) {
      const { dataset, datasetFile } = await readDataset(scale);
      manifest.selectedSources[scale] = {
        datasetFile,
        root: dataset.root,
        sources: selectedSources(dataset),
      };
    }
    await writeFile(manifestFile, json(manifest));
    console.log(JSON.stringify({ event: "source-integrity-start", at: nowIso() }));
    manifest.sourceIntegrity.before = await verifyFrozenSources();
    await writeFile(manifestFile, json(manifest));
    console.log(JSON.stringify({ event: "source-integrity-passed", at: nowIso() }));
    let sampleCounter = 0;
    for (const scale of ["1x", "10x"]) {
      for (const kind of ["codex", "dsh"]) {
        for (const storage of ["C", "E"]) {
          sampleCounter += 1;
          const caseResult = await runCase(runDirectory, scale, kind, storage, nowMs, sampleCounter);
          manifest.cases.push({
            caseName: caseResult.caseName,
            passed: caseResult.passed,
            command: caseResult.command,
            resultFile: caseResult.resultFile,
            logFile: caseResult.logFile,
          });
          await writeFile(manifestFile, json(manifest));
        }
      }
    }
    manifest.sourceIntegrity.after = await verifyFrozenSources();
    assert.deepEqual(
      manifest.sourceIntegrity.after.map(({ path: sourcePath, bytes, sha256 }) => ({
        path: sourcePath,
        bytes,
        sha256,
      })),
      manifest.sourceIntegrity.before.map(({ path: sourcePath, bytes, sha256 }) => ({
        path: sourcePath,
        bytes,
        sha256,
      })),
      "frozen source changed during the matrix",
    );
  } catch (error) {
    manifest.failure = {
      name: error?.name || "Error",
      message: error?.message || String(error),
      stack: error?.stack || String(error),
    };
  } finally {
    manifest.finishedAt = nowIso();
    await writeFile(manifestFile, json(manifest));
  }
  const passed =
    manifest.failure === null &&
    manifest.cases.length === EXACT_CASE_NAMES.size &&
    manifest.cases.every((entry) => entry.passed);
  console.log(
    JSON.stringify({
      event: "run-finished",
      passed,
      runDirectory,
      cases: manifest.cases.length,
      failedCases: manifest.cases.filter((entry) => !entry.passed).map((entry) => entry.caseName),
      failure: manifest.failure,
    }),
  );
  if (!passed) process.exitCode = 1;
}

const [mode, argument] = process.argv.slice(2);
if (mode === "--worker") {
  await worker(argument);
} else if (mode === "--self-check") {
  await selfCheck();
} else if (mode === undefined) {
  await parent();
} else {
  throw new Error(`unknown mode ${mode}`);
}
