import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { discoverUsageSources } from "../src/usage-core.js";
import { readHistoryProjectionStamp } from "../src/usage-history-projection-store.js";
import { UsageSourceProof } from "../src/usage-source-proof.js";
import { UsageStore } from "../src/usage-store.js";

const DAY = 86_400_000;
const START = Date.parse("2026-11-01T00:00:00.000Z");
const COLD_END = START + 2 * DAY;
const FILTERS = { preset: "all", calendarZone: "utc", now: new Date(START + 5 * DAY) };
const OPTIONS = { includeDetails: false };
const clean = (value) => JSON.parse(JSON.stringify(value, (key, item) => (key === "generatedAt" ? undefined : item)));
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

class ShaOnlySourceProof extends UsageSourceProof {
  async provider() {
    return null;
  }
}

function usage(total) {
  return {
    total_tokens: total,
    input_tokens: total,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}

function token(time, cumulative, last, usedPercent = 100) {
  return {
    timestamp: new Date(time).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: usage(cumulative), last_token_usage: usage(last) },
      rate_limits: {
        limit_id: "codex",
        credits: { has_credits: true },
        primary: { used_percent: usedPercent, window_minutes: 300, resets_at: (START + 6 * DAY) / 1000 },
      },
    },
  };
}

function dshMessage(time, seq, total) {
  return {
    type: "assistant/message",
    seq,
    time,
    data: {
      turn: 1,
      step: seq,
      usage: { inputTokens: total - 7, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 5, totalTokens: total },
    },
  };
}

function checkpointFor(store, filePath) {
  const row = store.database
    .prepare("SELECT checkpoint_json FROM usage_source_progress WHERE source_path=?")
    .get(filePath);
  return row ? JSON.parse(row.checkpoint_json) : null;
}

async function fixture(t, { archiveCount = 2, dsh = false, coldOnly = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "history-source-append-"));
  const filePath = dsh
    ? path.join(root, ".dsh", "sessions", "fixture", "history-append", "session.v4.jsonl.zstd")
    : path.join(root, ".codex", "sessions", "2026", "11", "01", "rollout-history-append.jsonl");
  const databaseFile = path.join(root, "usage.sqlite");
  const options = { homeDir: root, env: {}, importDirs: [], databaseFile };
  const openStore = (file = databaseFile) => {
    const value = new UsageStore({ ...options, databaseFile: file });
    value.sourceProof = new ShaOnlySourceProof();
    value.repositoryResolver = (cwd) => ({ key: `directory:${cwd}`, path: cwd, kind: "directory" });
    return value;
  };
  let store = openStore();
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const encode = (rows) => (dsh ? zstdCompressSync(Buffer.from(jsonl(rows))) : jsonl(rows));
  const header = { type: "request/header", time: START, data: { header: { config: { model: "deepseek-flash" } } } };
  const initial = dsh
    ? [
        { type: "session", version: 4, id: "history-append", cwd: root, createdAt: START, delegationDepth: 0 },
        header,
        dshMessage(START + 1000, 1, 101),
        dshMessage(START + DAY + 1000, 2, 70),
        dshMessage(COLD_END + 1000, 3, 51),
      ]
    : [
        { type: "session_meta", payload: { id: "history-append", source: "cli", originator: "codex-tui", cwd: root } },
        { type: "turn_context", payload: { model: "gpt-5.1-codex" } },
        token(START + 1000, 101, 101),
        token(START + DAY + 1000, 171, 70),
        token(COLD_END + 1000, 222, 51),
      ];
  if (coldOnly) initial.pop();
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, encode(initial));
  await store.sync();
  assert.equal(store.database.prepare("SELECT COUNT(*) n FROM events").get().n, coldOnly ? 2 : 3);
  const candidates = [];
  for (let day = 0; day < archiveCount; day++) {
    const candidate = path.join(root, `archive-${day}.sqlite`);
    await createHistoryArchiveCandidate(store.database, candidate, {
      startMs: START + day * DAY,
      endMs: START + (day + 1) * DAY,
    });
    candidates.push(candidate);
  }
  for (const candidate of candidates)
    await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, candidate));
  // Archive deletion invalidates the old cursor; a real cold reparse must establish the next one.
  await appendFile(filePath, encode([dsh ? header : { type: "note", text: "cold checkpoint refresh" }]));
  await store.sync();
  return {
    root,
    filePath,
    databaseFile,
    encode,
    openStore,
    get store() {
      return store;
    },
    async reopen() {
      store.close();
      store = openStore();
      await store.open();
    },
  };
}

function assertAppendWork(store, suffix) {
  assert.equal(store.lastSyncSourceWork.appendedFiles, 1);
  assert.equal(store.lastSyncSourceWork.replacedFiles, 0);
  assert.equal(store.lastSyncSourceWork.parsedBytes, Buffer.byteLength(suffix), "only suffix bytes enter the parser");
}

function appendBatches(store, since) {
  return store.database
    .prepare("SELECT mode,sources_json FROM usage_history_projection_batches WHERE sequence>? ORDER BY sequence")
    .all(since)
    .map((row) => ({ mode: row.mode, sources: JSON.parse(row.sources_json) }));
}

async function assertCanonical(f) {
  const canonical = f.openStore();
  canonical.usageProjectionDatabaseIdentity = () => null;
  await canonical.open();
  canonical.homes = f.store.homes;
  canonical.serviceTierEvidenceInput = f.store.serviceTierEvidenceInput;
  try {
    for (const filters of [FILTERS, { ...FILTERS, preset: "custom", startDate: "2026-11-03", endDate: "2026-11-03" }]) {
      assert.deepEqual(
        clean(await f.store.dashboardHistory(filters, OPTIONS)),
        clean(await canonical.dashboardHistory(filters, OPTIONS)),
        "dashboard, prices, metadata and period comparisons must exactly match the original SQL path",
      );
    }
  } finally {
    canonical.close();
  }
  const full = f.openStore(path.join(f.root, "full-parse.sqlite"));
  try {
    await full.sync();
    assert.deepEqual(await f.store.publishedHistoryUsageEvents(), full.publishedUsageEvents());
    for (const table of ["rate_limit_observations", "quota_usage_sources"]) {
      const rows = (value) => value.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
      assert.deepEqual(rows(f.store), rows(full), `${table} must match a new database full parse`);
    }
  } finally {
    full.close();
  }
}

test("multi-archive ordinary Codex appends only the certified tail and matches canonical money exactly", async (t) => {
  const f = await fixture(t);
  const prefix = await readFile(f.filePath);
  assert.equal(checkpointFor(f.store, f.filePath)?.offset, prefix.length, "cold replacement saves a complete cursor");
  const hotBefore = f.store.database.prepare("SELECT id,total FROM events ORDER BY id").all();
  const stamp = readHistoryProjectionStamp(f.store.database);
  const suffix = jsonl([
    { type: "turn_context", payload: { model: "gpt-5.1-codex-mini" } },
    token(COLD_END, 271, 49, 20),
    token(COLD_END + 3000, 310, 39, 100),
  ]);
  await appendFile(f.filePath, suffix);
  await f.store.sync();
  assertAppendWork(f.store, suffix);
  assert.ok(f.store.lastSyncSourceWork.prefixBytesRead >= prefix.length, "the entire old prefix must be verified");
  assert.deepEqual(
    f.store.database.prepare("SELECT id,total FROM events WHERE id<=? ORDER BY id").all(hotBefore.at(-1).id),
    hotBefore,
  );
  assert.deepEqual(
    appendBatches(f.store, stamp.sequence).filter((batch) => batch.sources.includes(f.filePath)),
    [{ mode: "append", sources: [f.filePath] }],
  );
  assert.equal(checkpointFor(f.store, f.filePath).offset, (await stat(f.filePath)).size);
  await assertCanonical(f);
});

test("source and projection cursors survive reopen and a second real Codex tail append", async (t) => {
  const f = await fixture(t);
  await appendFile(f.filePath, jsonl([token(COLD_END + 2000, 263, 41, 20)]));
  await f.store.sync();
  await f.store.dashboardHistory(FILTERS, OPTIONS);
  const checkpoint = checkpointFor(f.store, f.filePath);
  const cursor = f.store.historyProjectionStore.query.database
    .prepare("SELECT * FROM usage_history_projection_sources WHERE source_path=?")
    .get(f.filePath);
  assert.ok(cursor, "published projection records its hot source cursor");
  await f.reopen();
  assert.deepEqual(checkpointFor(f.store, f.filePath), checkpoint);
  const suffix = jsonl([token(COLD_END + 3000, 300, 37)]);
  await appendFile(f.filePath, suffix);
  await f.store.sync();
  assertAppendWork(f.store, suffix);
  await f.store.dashboardHistory(FILTERS, OPTIONS);
  assert.equal(f.store.lastHistoryQueryWork.projection.rebuilt, false);
  const next = f.store.historyProjectionStore.query.database
    .prepare("SELECT last_id FROM usage_history_projection_sources WHERE source_path=?")
    .get(f.filePath);
  assert.ok(next.last_id > cursor.last_id);
  await assertCanonical(f);
});

test("cold events, quota-only cold rows, changed old bytes and unknown progress require full fallback", async (t) => {
  for (const reason of ["cold event", "cold quota", "old bytes", "unknown checkpoint", "unloaded baseline"]) {
    await t.test(reason, async (t) => {
      const f = await fixture(t);
      assert.ok(checkpointFor(f.store, f.filePath), "exercise a previously certified cold cursor");
      const before = readHistoryProjectionStamp(f.store.database);
      if (reason === "old bytes") {
        const original = await readFile(f.filePath, "utf8");
        const revised = original.replace("gpt-5.1-codex", "gpt-5.2-codex");
        assert.notEqual(revised, original);
        assert.equal(Buffer.byteLength(revised), Buffer.byteLength(original));
        await writeFile(f.filePath, revised);
      }
      if (["unknown checkpoint", "unloaded baseline"].includes(reason)) {
        const checkpoint = checkpointFor(f.store, f.filePath);
        if (reason === "unknown checkpoint") checkpoint.adapter = "future-adapter";
        else checkpoint.state.baselineLoaded = false;
        f.store.database
          .prepare("UPDATE usage_source_progress SET checkpoint_json=? WHERE source_path=?")
          .run(JSON.stringify(checkpoint), f.filePath);
      }
      const cold = reason.startsWith("cold");
      const row = token(cold ? START + DAY + 2000 : COLD_END + 2000, 263, 41, 20);
      if (reason === "cold quota") delete row.payload.info;
      await appendFile(f.filePath, jsonl([row]));
      await f.store.sync();
      assert.equal(f.store.lastSyncSourceWork.appendedFiles, 0);
      assert.equal(f.store.lastSyncSourceWork.replacedFiles, 1);
      assert.equal(f.store.lastSyncSourceWork.parsedBytes, (await stat(f.filePath)).size);
      assert.ok(
        appendBatches(f.store, before.sequence).some(
          (batch) => batch.mode === "replace" && batch.sources.includes(f.filePath),
        ),
      );
      await assertCanonical(f);
    });
  }

  await t.test("saved progress still falls back for a shared quota source and tied observation", async (t) => {
    const f = await fixture(t);
    const saved = checkpointFor(f.store, f.filePath);
    assert.ok(saved, "the archived source must already have certified progress");
    const peer = path.join(path.dirname(f.filePath), "z-shared-quota.jsonl");
    const meta = JSON.parse((await readFile(f.filePath, "utf8")).split("\n")[0]);
    const quota = token(COLD_END + 1000, 0, 0, 20);
    delete quota.payload.info;
    await writeFile(peer, jsonl([meta, quota]));
    await f.store.sync();
    assert.deepEqual(
      checkpointFor(f.store, f.filePath),
      saved,
      "indexing quota-only peer preserves the original cursor",
    );
    const sources = f.store.database
      .prepare("SELECT source_path,home_id,session_id FROM quota_usage_sources ORDER BY source_path")
      .all();
    assert.deepEqual(
      sources.map((row) => row.source_path),
      [f.filePath, peer].sort(),
    );
    assert.equal(new Set(sources.map((row) => `${row.home_id}:${row.session_id}`)).size, 1);
    assert.equal(
      f.store.database
        .prepare(`SELECT COUNT(DISTINCT source_path) n FROM rate_limit_observations
        WHERE limit_id='codex' AND window_minutes=300 AND observed_at_ms=?`)
        .get(COLD_END + 1000).n,
      2,
    );
    const before = readHistoryProjectionStamp(f.store.database);
    await appendFile(f.filePath, jsonl([token(COLD_END + 2000, 263, 41, 20)]));
    await f.store.sync();
    assert.equal(f.store.lastSyncSourceWork.appendedFiles, 0);
    assert.equal(f.store.lastSyncSourceWork.replacedFiles, 1);
    assert.equal(f.store.lastSyncSourceWork.parsedBytes, (await stat(f.filePath)).size);
    assert.ok(
      appendBatches(f.store, before.sequence).some(
        (batch) => batch.mode === "replace" && batch.sources.includes(f.filePath),
      ),
    );
  });
});

test("a single archive retains full replacement and its established SQL money order", async (t) => {
  const f = await fixture(t, { archiveCount: 1 });
  await appendFile(f.filePath, jsonl([token(COLD_END + 2000, 263, 41, 20)]));
  await f.store.sync();
  assert.equal(f.store.lastSyncSourceWork.appendedFiles, 0);
  assert.equal(f.store.lastSyncSourceWork.replacedFiles, 1);
  assert.equal(f.store.lastSyncSourceWork.parsedBytes, (await stat(f.filePath)).size);
  await assertCanonical(f);
});

test("an append batch failure rolls facts, quota, source progress and projection input back together", async (t) => {
  const f = await fixture(t);
  f.store.database.exec(`CREATE TRIGGER fail_history_append_batch BEFORE INSERT ON usage_history_projection_batches
    WHEN NEW.mode='append' BEGIN SELECT RAISE(ABORT,'injected append batch failure'); END`);
  const tables = [
    "source_files",
    "events",
    "rate_limit_observations",
    "quota_usage_sources",
    "history_replaced_facts",
    "usage_source_progress",
    "usage_source_baselines",
    "usage_source_reparse",
    "usage_business_revision",
    "usage_history_projection_inputs",
    "usage_history_projection_batches",
  ];
  const snapshot = () =>
    Object.fromEntries(
      tables.map((table) => [table, f.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    );
  const before = snapshot();
  await appendFile(f.filePath, jsonl([token(COLD_END + 2000, 263, 41, 20)]));
  const homes = await discoverUsageSources(f.store.options);
  const source = homes.find((home) => f.filePath.startsWith(home.path));
  assert.ok(source);
  await assert.rejects(
    f.store.appendFile({ filePath: f.filePath, source, info: await stat(f.filePath) }),
    /injected append batch failure/,
  );
  assert.deepEqual(snapshot(), before);
  assert.equal(f.store.database.isTransaction, false);
  assert.equal(f.store.writeTransactionDepth, 0);
  f.store.database.exec("DROP TRIGGER fail_history_append_batch");
  await f.reopen();
  await f.store.sync();
  assert.equal(f.store.lastSyncSourceWork.appendedFiles, 1, "the rolled-back cursor must permit one clean retry");
  await assertCanonical(f);
});

test("multi-archive DSH frame tails append after reopen and archive proof is checked again on each query", async (t) => {
  const f = await fixture(t, { dsh: true });
  assert.equal(checkpointFor(f.store, f.filePath)?.adapter, "dsh-v4-zstd");
  await f.reopen();
  const suffix = Buffer.concat([
    f.encode([dshMessage(COLD_END + 2000, 4, 41)]),
    f.encode([dshMessage(COLD_END + 3000, 5, 37)]),
  ]);
  await appendFile(f.filePath, suffix);
  await f.store.sync();
  assertAppendWork(f.store, suffix);
  await assertCanonical(f);
  const archive = f.store.database
    .prepare("SELECT database_path FROM archive_segments ORDER BY start_ms LIMIT 1")
    .get().database_path;
  await rename(archive, `${archive}.missing`);
  try {
    await assert.rejects(f.store.dashboardHistory(FILTERS, OPTIONS), /ENOENT|archive|missing/i);
  } finally {
    await rename(`${archive}.missing`, archive);
  }
});

function rawRows(rows) {
  return rows.map((row) => {
    const value = { ...row };
    delete value.id;
    return value;
  });
}

function observeColdReparse(t, f) {
  const trace = { prefixes: [], packageReads: [] };
  const read = f.store.readHistoryArchiveSnapshot;
  t.mock.method(f.store, "readHistoryArchiveSnapshot", function (record, page, scope) {
    if (scope?.path === f.filePath) trace.packageReads.push(String(record.segment_id));
    return read.call(this, record, page, scope);
  });
  const reparse = f.store.historyArchiveReparsePrefixes;
  t.mock.method(f.store, "historyArchiveReparsePrefixes", async function (...args) {
    const result = await reparse.apply(this, args);
    trace.prefixes.push({
      usedProjection: Boolean(result.usedProjection),
      raw: rawRows(result.prefixes.flatMap((prefix) => [...prefix.originalRows.values()])),
    });
    return result;
  });
  return trace;
}

async function reviseIgnoredNote(f) {
  const text = await readFile(f.filePath, "utf8");
  const revised = text.replace("cold checkpoint refresh", "cold checkpoint revised");
  assert.notEqual(revised, text, "change existing bytes to require a complete source reparse");
  await writeFile(f.filePath, revised);
}

test("sync full reparse reuses exact published raw cold prefixes while direct replace still reads packages", async (t) => {
  const f = await fixture(t);
  await f.store.dashboardHistory(FILTERS, OPTIONS);
  const records = f.store.database.prepare("SELECT * FROM archive_segments ORDER BY start_ms").all();
  const expected = [];
  for (const record of records) expected.push(...(await f.store.readHistoryArchiveSnapshot(record)).rows);
  assert.equal(
    JSON.parse(f.store.readMetaRaw("history_archive_event_revisions") || '{"revisions":[]}').revisions.length,
    0,
  );
  const trace = observeColdReparse(t, f);
  const replace = f.store.replaceFile;
  const outcomes = [];
  t.mock.method(f.store, "replaceFile", async function (...args) {
    const result = await replace.apply(this, args);
    outcomes.push(result);
    return result;
  });
  await reviseIgnoredNote(f);
  await f.store.sync();
  assert.equal(f.store.lastSyncSourceWork.replacedFiles, 1);
  assert.equal(f.store.lastSyncSourceWork.parsedBytes, (await stat(f.filePath)).size);
  assert.deepEqual(trace.prefixes, [{ usedProjection: true, raw: rawRows(expected) }]);
  assert.deepEqual(trace.packageReads, [], "the source reparse consumes owned raw rows, not package rows");
  assert.equal(outcomes[0].historyVerificationPending, true);
  await assertCanonical(f);

  const homes = await discoverUsageSources(f.store.options);
  const source = homes.find((home) => f.filePath.startsWith(home.path));
  assert.ok(source);
  const direct = await f.store.replaceFile({ filePath: f.filePath, source, info: await stat(f.filePath) });
  assert.equal(Boolean(direct.historyVerificationPending), false);
  assert.deepEqual(
    trace.packageReads,
    records.map((record) => String(record.segment_id)),
  );
  assert.deepEqual(trace.prefixes.at(-1), { usedProjection: false, raw: rawRows(expected) });
  await assertCanonical(f);
});

test("cold revisions and mismatching cache or source stamps fall back to original package prefixes", async (t) => {
  for (const reason of ["cold revision", "cache stamp", "source stamp"]) {
    await t.test(reason, async (t) => {
      const f = await fixture(t);
      if (reason === "cold revision") {
        const text = await readFile(f.filePath, "utf8");
        await writeFile(f.filePath, text.replace("gpt-5.1-codex", "gpt-5.2-codex"));
        await f.store.sync();
        const revisions = JSON.parse(f.store.readMetaRaw("history_archive_event_revisions")).revisions;
        assert.ok(revisions.some((entry) => entry.sourceIdentity.path === f.filePath));
      }
      await f.store.dashboardHistory(FILTERS, OPTIONS);
      const cache = f.store.historyProjectionStore.query.database;
      const header = JSON.parse(
        cache.prepare("SELECT inputs_json FROM usage_history_projection_cache").get().inputs_json,
      );
      assert.deepEqual(
        header,
        readHistoryProjectionStamp(f.store.database),
        "start from an exactly matching published stamp",
      );
      if (reason === "cache stamp") {
        cache
          .prepare("UPDATE usage_history_projection_cache SET inputs_json=?")
          .run(JSON.stringify({ ...header, token: `${header.token}-stale` }));
      }
      if (reason === "source stamp") {
        assert.ok(
          f.store.database
            .prepare("UPDATE rate_limit_observations SET used_percent=used_percent-1 WHERE source_path=?")
            .run(f.filePath).changes > 0,
        );
        assert.notDeepEqual(header, readHistoryProjectionStamp(f.store.database));
      }
      const trace = observeColdReparse(t, f);
      await reviseIgnoredNote(f);
      await f.store.sync();
      assert.equal(f.store.lastSyncSourceWork.replacedFiles, 1);
      assert.equal(trace.prefixes.length, 1);
      assert.equal(trace.prefixes[0].usedProjection, false);
      assert.equal(trace.packageReads.length, 2, "both original archive packages must supply the raw prefix");
      await assertCanonical(f);
    });
  }
});

test("an auxiliary-only cached-prefix reparse cannot finish sync with a missing or changed archive", async (t) => {
  for (const fault of ["missing", "changed"]) {
    await t.test(fault, async (t) => {
      const f = await fixture(t, { coldOnly: true });
      await f.store.dashboardHistory(FILTERS, OPTIONS);
      const projection = f.store.historyProjectionStore;
      const published = () =>
        JSON.parse(
          projection.query.database.prepare("SELECT inputs_json FROM usage_history_projection_cache").get().inputs_json,
        );
      const before = published();
      const archive = f.store.database
        .prepare("SELECT database_path FROM archive_segments ORDER BY start_ms DESC LIMIT 1")
        .get().database_path;
      const archiveBytes = await readFile(archive);
      const trace = observeColdReparse(t, f);
      const publish = t.mock.method(projection, "publish");
      const replace = f.store.replaceFile;
      let pending = false;
      t.mock.method(f.store, "replaceFile", async function (...args) {
        const outcome = await replace.apply(this, args);
        pending = outcome.historyVerificationPending;
        assert.equal(pending, true);
        assert.equal(this.database.prepare("SELECT COUNT(*) n FROM usage_rollup_dirty_days").get().n, 0);
        assert.ok(readHistoryProjectionStamp(this.database).auxiliary > before.auxiliary);
        if (fault === "missing") await rename(archive, `${archive}.missing`);
        else {
          const changed = Buffer.from(archiveBytes);
          changed[changed.length - 1] ^= 1;
          await writeFile(archive, changed);
        }
        return outcome;
      });
      const reader = t.mock.method(f.store, "withSqlHistoryReader");
      const text = await readFile(f.filePath, "utf8");
      const revised = text.replace('"used_percent":100', '"used_percent":85');
      assert.notEqual(revised, text);
      await writeFile(f.filePath, revised);
      try {
        await assert.rejects(f.store.sync(), {
          code: fault === "missing" ? "ENOENT" : "HISTORY_BACKUP_DIGEST_MISMATCH",
        });
        assert.equal(pending, true);
        assert.equal(trace.prefixes[0].usedProjection, true);
        assert.deepEqual(trace.packageReads, []);
        assert.ok(reader.mock.callCount() > 0, "pending verification requires the full reader even with no dirty days");
        assert.equal(publish.mock.callCount(), 0, "failed package verification must not publish the new projection");
        assert.deepEqual(published(), before, "the last completed projection remains available for recovery");
      } finally {
        if (fault === "missing") await rename(`${archive}.missing`, archive);
        else await writeFile(archive, archiveBytes);
      }
      await f.reopen();
      await f.store.sync();
      await assertCanonical(f);
      assert.deepEqual(
        JSON.parse(
          f.store.historyProjectionStore.query.database
            .prepare("SELECT inputs_json FROM usage_history_projection_cache")
            .get().inputs_json,
        ),
        readHistoryProjectionStamp(f.store.database),
        "repair and retry must converge to the current authoritative inputs",
      );
    });
  }
});
