import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  constants as fsConstants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { getPricingCatalog, setPricingCatalog } from "../src/pricing.js";
import { serviceTierEvidenceFromSnapshot } from "../src/service-tier-evidence.js";
import {
  HistoryProjectionStore,
  ensureHistoryProjectionTracking,
  readHistoryProjectionStamp,
  recordHistoryProjectionBatch,
} from "../src/usage-history-projection-store.js";
import { UsageStore } from "../src/usage-store.js";

const DAY = 86400_000;
const START = Date.parse("2026-01-01T20:00:00Z");
const FILTERS = { preset: "all", calendarZone: "utc", bucket: "day", now: new Date("2026-01-08T12:00:00Z") };
const OPTIONS = { includeDetails: false };
const clean = (value) => JSON.parse(JSON.stringify(value, (key, item) => (key === "generatedAt" ? undefined : item)));

async function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-projection-recovery-"));
  const file = path.join(root, "source.sqlite");
  const sourcePath = path.join(root, "missing.jsonl");
  const cache = `${path.resolve(file)}.history-cache`;
  const queries = new Set();
  const prepare = HistoryProjectionStore.prototype.prepare;
  t.mock.method(HistoryProjectionStore.prototype, "prepare", function (...args) {
    const result = prepare.apply(this, args);
    if (this.directory === cache) queries.add(result.query);
    return result;
  });
  let store;
  const open = async (anonymous = false) => {
    const other = new UsageStore({
      databaseFile: file,
      homeDir: root,
      env: {},
      importDirs: [],
      automaticDiscoveryEnabled: false,
    });
    await other.open();
    other.homes = [{ id: "home", label: "Home", path: root, kind: "codex" }];
    other.serviceTierEvidence = store?.serviceTierEvidence || null;
    other.serviceTierEvidenceInput = store?.serviceTierEvidenceInput || "fixture-standard";
    if (anonymous) other.usageProjectionDatabaseIdentity = () => null;
    return other;
  };
  const close = () => {
    store?.close();
    for (const query of queries) query.close();
  };
  t.after(() => {
    close();
    rmSync(root, { recursive: true, force: true });
  });
  store = await open();
  store.database
    .prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?,?,?)")
    .run(sourcePath, "codex", "home", "Home", root, 1, 1, "fixture");
  const insert = (database, timestamp, total = 100) => {
    const date = new Date(timestamp),
      day = date.toISOString().slice(0, 10);
    const row = {
      source_path: sourcePath,
      timestamp_ms: timestamp,
      session_id: "shared-session",
      home_id: "home",
      home_label: "Home",
      channel: "CLI",
      project: "fixture",
      cwd: "/fixture/project",
      model: "gpt-6-sol",
      hour_key: `${day} ${date.toISOString().slice(11, 13)}`,
      day_key: day,
      week_key: "2025-12-29",
      month_key: day.slice(0, 7),
      detail_mask: 15,
      cache_write_tokens: 0,
      cache_write_known: 1,
      request_input_tokens: total - 10,
      context_level: "short",
      service_tier: "unknown",
      total,
      input: total - 10,
      cached: 5,
      output: 10,
      reasoning: 0,
    };
    const keys = Object.keys(row);
    return database
      .prepare(`INSERT INTO events(${keys.join(",")}) VALUES(${keys.map(() => "?").join(",")})`)
      .run(...Object.values(row));
  };
  for (let day = 0; day < 3; day++) insert(store.database, START + day * DAY, 100 + day);
  // Keep exclusive publication on Windows hosts where fixture hard links are unavailable.
  const fsPromises = process.getBuiltinModule("fs/promises");
  const link = fsPromises.link;
  fsPromises.link = (source, destination) => copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  syncBuiltinESMExports();
  try {
    const packages = [];
    for (let day = 0; day < 2; day++) {
      const candidate = path.join(root, `segment-${day}.sqlite`);
      const startMs = Date.parse("2026-01-01T00:00:00Z") + day * DAY;
      await createHistoryArchiveCandidate(store.database, candidate, { startMs, endMs: startMs + DAY });
      packages.push(candidate);
    }
    for (const candidate of packages)
      await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, candidate));
  } finally {
    fsPromises.link = link;
    syncBuiltinESMExports();
  }
  ensureHistoryProjectionTracking(store.database);
  return {
    file,
    cache,
    root,
    sourcePath,
    close,
    insert,
    get store() {
      return store;
    },
    read(filters = FILTERS) {
      return store.dashboardHistory(filters, OPTIONS);
    },
    openReader() {
      return open();
    },
    async reopen() {
      close();
      store = await open();
    },
    async oracle(filters = FILTERS) {
      const other = await open(true);
      try {
        return await other.dashboardHistory(filters, OPTIONS);
      } finally {
        other.close();
      }
    },
    append(timestamp, total = 100, database = store.database) {
      const before = readHistoryProjectionStamp(database);
      database.exec("BEGIN IMMEDIATE");
      try {
        insert(database, timestamp, total);
        recordHistoryProjectionBatch(database, before, { sources: [sourcePath], mode: "append" });
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function cacheFile(f, name = "current.json") {
  return path.join(f.cache, JSON.parse(readFileSync(path.join(f.cache, name), "utf8")).file);
}

function coldRows(query) {
  return query.database
    .prepare("SELECT rowid,payload,segment_id,event_id FROM history_query_rows WHERE segment_id<>'hot' ORDER BY rowid")
    .all()
    .map((row) => ({ ...row }));
}

function assertNoColdCopy(f, before) {
  assert.equal(
    f.store.lastHistoryQueryWork.projection.coldCopied,
    0,
    "dependency changes must not copy sealed cold facts",
  );
  assert.equal(f.store.lastHistoryQueryWork.projection.rebuilt, false);
  assert.deepEqual(coldRows(f.store.historyProjectionStore.query), before);
}

async function killAtCheckpoint(f, stage) {
  const config = {
    file: f.file,
    root: f.root,
    sourcePath: f.sourcePath,
    stage,
    timestamp: START + 3 * DAY,
    total: 207,
    filters: FILTERS,
  };
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./fixtures/history-projection-crash-child.mjs", import.meta.url)), JSON.stringify(config)],
    { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  const exited = once(child, "exit");
  let errors = "",
    timer;
  child.stderr.on("data", (chunk) => {
    errors = (errors + chunk).slice(-8192);
  });
  try {
    const marker = await new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        reject(new Error(`Crash child exited before ${stage}: ${code}/${signal}\n${errors}`)),
      );
      timer = setTimeout(() => reject(new Error(`Crash child did not reach ${stage}\n${errors}`)), 15_000);
    });
    assert.equal(marker.stage, stage);
    assert.equal(child.kill("SIGKILL"), true);
    const [code, signal] = await exited;
    assert.equal(signal, "SIGKILL", "parent must observe actual forced process termination");
    assert.equal(code, null);
    return marker;
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
}

test("initial candidate keeps its captured response unpublished and next read catches appends without recopying", async (t) => {
  const f = await fixture(t);
  const captured = await f.oracle();
  const capturedStamp = readHistoryProjectionStamp(f.store.database);
  const publish = HistoryProjectionStore.prototype.publish;
  const markImported = HistoryProjectionStore.prototype.markImported;
  let appended = 0;
  let imports = 0;
  const append = () => {
    f.append(START + (3 + appended) * DAY, 200 + appended);
    appended++;
  };
  t.mock.method(HistoryProjectionStore.prototype, "markImported", function (...args) {
    const result = markImported.apply(this, args);
    if (this.directory === f.cache) {
      imports++;
      if (appended < 2) append();
    }
    return result;
  });
  t.mock.method(HistoryProjectionStore.prototype, "publish", function (source, prepared, ...args) {
    if (this.directory === f.cache && appended < 3) append();
    return publish.call(this, source, prepared, ...args);
  });
  const result = await f.read();
  assert.equal(appended, 3);
  assert.deepEqual(clean(result), clean(captured), "the current response must stay on its complete captured version");
  assert.equal(existsSync(path.join(f.cache, "current.json")), false, "a superseded initial candidate is not current");
  const pending = new DatabaseSync(cacheFile(f, "candidate.json"), { readOnly: true });
  try {
    assert.deepEqual(
      JSON.parse(pending.prepare("SELECT inputs_json FROM usage_history_projection_cache").get().inputs_json),
      capturedStamp,
    );
  } finally {
    pending.close();
  }
  const next = await f.read();
  assert.deepEqual(clean(next), clean(await f.oracle()));
  assert.equal(next.summary.eventCount, 6);
  assert.equal(f.store.lastHistoryQueryWork.projection.coldCopied, 0);
  assert.equal(imports, 2, "candidate catch-up must retain the already imported cold packages");
  assert.equal(existsSync(path.join(f.cache, "current.json")), true);
});

test("external commit during a read preserves the captured version and is included on the next request", async (t) => {
  const f = await fixture(t);
  await f.read();
  f.append(START + 3 * DAY, 200);
  const captured = await f.oracle();
  const capturedStamp = readHistoryProjectionStamp(f.store.database);
  const writer = new DatabaseSync(f.file);
  try {
    const apply = HistoryProjectionStore.prototype.applyDelta;
    let inserted = false;
    t.mock.method(HistoryProjectionStore.prototype, "applyDelta", function (prepared, ...args) {
      if (this.directory === f.cache && !inserted) {
        inserted = true;
        f.insert(writer, START + 4 * DAY, 300);
      }
      return apply.call(this, prepared, ...args);
    });
    const result = await f.read();
    assert.equal(inserted, true);
    assert.deepEqual(clean(result), clean(captured));
    const header = f.store.historyProjectionStore.query.database
      .prepare("SELECT inputs_json FROM usage_history_projection_cache")
      .get();
    assert.deepEqual(
      JSON.parse(header.inputs_json),
      capturedStamp,
      "old facts must never carry the new source version",
    );
    assert.ok(readHistoryProjectionStamp(f.store.database).facts > capturedStamp.facts);
    const next = await f.read();
    assert.deepEqual(clean(next), clean(await f.oracle()));
    assert.equal(next.summary.eventCount, 5);
  } finally {
    writer.close();
  }
});

test("lease binds retained F1 facts and input after one catch-up when F0 exists and publication is superseded", async (t) => {
  const f = await fixture(t);
  await f.read();
  const f0 = cacheFile(f);
  const initial = readHistoryProjectionStamp(f.store.database);
  const writer = new DatabaseSync(f.file);
  try {
    f.insert(writer, START + 3 * DAY, 200);
  } finally {
    writer.close();
  }
  const prepare = HistoryProjectionStore.prototype.prepare;
  const publish = HistoryProjectionStore.prototype.publish;
  const attempts = [];
  let injected = false;
  t.mock.method(HistoryProjectionStore.prototype, "prepare", function (...args) {
    const prepared = prepare.apply(this, args);
    if (this.directory === f.cache) {
      attempts.push({
        file: prepared.query.database
          .prepare("PRAGMA database_list")
          .all()
          .find((row) => row.name === "main").file,
        rebuilding: prepared.rebuilding,
        delta: Boolean(prepared.delta),
        stamp: { ...prepared.stamp },
      });
    }
    return prepared;
  });
  t.mock.method(HistoryProjectionStore.prototype, "publish", function (source, prepared, ...args) {
    if (this.directory === f.cache && !injected) {
      assert.equal(prepared.rebuilding, true, "the untracked write must force a new F1 candidate");
      assert.notStrictEqual(prepared.query.database, this.query.database);
      assert.equal(cacheFile(f), f0);
      assert.equal(prepared.stamp.facts, initial.facts + 1);
      f.append(START + 4 * DAY, 300);
      injected = true;
      const result = publish.call(this, source, prepared, ...args);
      assert.equal(this.work.superseded, true);
      assert.equal(cacheFile(f), f0, "superseded F1 must leave current pointing to F0");
      assert.notStrictEqual(prepared.query.database, this.query.database);
      return result;
    }
    return publish.call(this, source, prepared, ...args);
  });
  const lease = await f.store.acquirePublishedHistoryReader();
  try {
    assert.equal(injected, true);
    assert.ok(lease?.publishedHistoryProjection, "one catch-up must publish and lease retained F1");
    const header = {
      ...lease.database.prepare("SELECT * FROM usage_history_projection_cache WHERE singleton=1").get(),
    };
    assert.deepEqual(
      lease.historyProjectionInput,
      JSON.parse(header.inputs_json),
      "the lease must never combine F0 facts with the superseded F1 input stamp",
    );
    assert.deepEqual(lease.historyProjectionInput, readHistoryProjectionStamp(f.store.database));
    assert.equal(header.status, "ready");
    assert.equal(lease.historyProjectionInput.facts, initial.facts + 2);
    assert.equal(attempts.length, 2, "acquire gets one initial attempt and at most one catch-up");
    assert.notEqual(path.resolve(attempts[0].file), path.resolve(f0));
    assert.equal(path.resolve(attempts[1].file), path.resolve(attempts[0].file), "catch-up must retain F1");
    assert.equal(attempts[0].rebuilding, true);
    assert.equal(attempts[0].delta, false);
    assert.equal(attempts[1].rebuilding, true);
    assert.equal(attempts[1].delta, true);
    assert.equal(path.resolve(lease.databaseFile), path.resolve(attempts[1].file));
    assert.equal(path.resolve(cacheFile(f)), path.resolve(lease.databaseFile));
    assert.equal(f.store.lastHistoryQueryWork.projection.resumed, true);
    assert.equal(f.store.lastHistoryQueryWork.projection.coldCopied, 0);
    const published = new DatabaseSync(cacheFile(f), { readOnly: true });
    try {
      assert.deepEqual(header, {
        ...published.prepare("SELECT * FROM usage_history_projection_cache WHERE singleton=1").get(),
      });
      const rows = (db) =>
        db
          .prepare("SELECT * FROM events ORDER BY timestamp_ms,history_ordinal")
          .all()
          .map((row) => ({ ...row }));
      const leased = rows(lease.database);
      assert.deepEqual(leased, rows(published));
      assert.deepEqual(
        leased.map((row) => [row.timestamp_ms, row.history_ordinal, row.total]),
        [
          [START, 0, 100],
          [START + DAY, 0, 101],
          [START + 2 * DAY, 0, 102],
          [START + 3 * DAY, 0, 200],
          [START + 4 * DAY, 0, 300],
        ],
      );
    } finally {
      published.close();
    }
    assert.deepEqual(clean(await lease.dashboardHistory(FILTERS, OPTIONS)), clean(await f.oracle()));
  } finally {
    lease?.close();
  }
});

test("external untracked commits rebuild once and then reuse the completed version after reopen", async (t) => {
  const f = await fixture(t);
  await f.read();
  const writer = new DatabaseSync(f.file);
  try {
    f.insert(writer, START + 4 * DAY, 300);
  } finally {
    writer.close();
  }
  const result = await f.read();
  assert.equal(f.store.lastHistoryQueryWork.projection.rebuilt, true);
  assert.deepEqual(clean(result), clean(await f.oracle()));
  await f.reopen();
  assert.deepEqual(clean(await f.read()), clean(result));
  assert.equal(f.store.lastHistoryQueryWork.projection.reused, true);
  assert.equal(f.store.lastHistoryQueryWork.projection.coldCopied, 0);
});

test("standalone all history prepares its derived summary schema and reuses it after reopen", async (t) => {
  const f = await fixture(t);
  const expected = clean((await f.oracle()).summary);
  const first = await f.store.summarizeHistory(FILTERS, OPTIONS);
  assert.deepEqual(clean(first), expected);
  const published = f.store.historyProjectionStore.query.database
    .prepare("SELECT * FROM usage_history_all_summary_state WHERE singleton=1")
    .get();
  assert.equal(published.status, "ready");
  assert.equal(published.target_revision, published.published_revision);
  await f.reopen();
  assert.deepEqual(clean(await f.store.summarizeHistory(FILTERS, OPTIONS)), expected);
  assert.equal(f.store.lastHistoryQueryWork.projection.reused, true);
  assert.equal(f.store.lastHistoryQueryWork.projection.coldCopied, 0);
  assert.deepEqual(
    f.store.historyProjectionStore.query.database
      .prepare("SELECT * FROM usage_history_all_summary_state WHERE singleton=1")
      .get(),
    published,
  );
});

test("two independent readers share a coherent initial publication without duplicating cold packages", async (t) => {
  const f = await fixture(t);
  const other = await f.openReader();
  try {
    const results = await Promise.allSettled([f.read(), other.dashboardHistory(FILTERS, OPTIONS)]);
    const expected = clean(await f.oracle());
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      assert.deepEqual(clean(result.value), expected);
    }
    const database = new DatabaseSync(cacheFile(f), { readOnly: true });
    try {
      assert.equal(database.prepare("SELECT COUNT(*) n FROM events").get().n, 3);
      assert.equal(database.prepare("SELECT COUNT(*) n FROM usage_history_projection_imports").get().n, 2);
    } finally {
      database.close();
    }
  } finally {
    other.close();
  }
});

test("input-only quota classification changes reach the derived auxiliary tables without copying cold facts", async (t) => {
  const f = await fixture(t);
  await f.read();
  const before = coldRows(f.store.historyProjectionStore.query);
  f.store.withHistoryProjectionInputChange(() =>
    f.store.database
      .prepare(`INSERT INTO quota_usage_sources
    (source_path,home_id,session_id,timestamp_ms,quota_source,until_ms) VALUES(?,?,?,?,?,?)`)
      .run(f.sourcePath, "home", "shared-session", START, "api", START + 10 * DAY),
  );
  const result = await f.read();
  assertNoColdCopy(f, before);
  const select = "SELECT * FROM quota_usage_sources ORDER BY source_path,session_id,timestamp_ms";
  assert.deepEqual(
    f.store.historyProjectionStore.query.database.prepare(select).all(),
    f.store.database.prepare(select).all(),
    "an inputs receipt must not advance the projection header while dropping auxiliary changes",
  );
  assert.deepEqual(clean(result), clean(await f.oracle()));
});

test("a failed initial publication resumes imported packages without duplicating or recopying them", async (t) => {
  const f = await fixture(t);
  const publish = HistoryProjectionStore.prototype.publish;
  const failure = new Error("publication interrupted");
  let stopped = false;
  const mock = t.mock.method(HistoryProjectionStore.prototype, "publish", function (...args) {
    if (this.directory === f.cache && !stopped) {
      stopped = true;
      throw failure;
    }
    return publish.apply(this, args);
  });
  await assert.rejects(f.read(), (error) => error === failure);
  assert.equal(existsSync(path.join(f.cache, "candidate.json")), true);
  assert.equal(existsSync(path.join(f.cache, "current.json")), false);
  mock.mock.restore();
  await f.reopen();
  const result = await f.read();
  assert.equal(f.store.lastHistoryQueryWork.projection.resumed, true);
  assert.equal(f.store.lastHistoryQueryWork.projection.coldCopied, 0);
  assert.equal(result.summary.eventCount, 3);
  assert.deepEqual(clean(result), clean(await f.oracle()));
});

test("SIGKILL at durable fact, uncommitted projection and committed projection boundaries recovers exactly once", async (t) => {
  for (const stage of ["facts-commit", "projection-transaction", "projection-commit"]) {
    await t.test(stage, { timeout: 20_000 }, async (child) => {
      const f = await fixture(child);
      await f.read();
      const before = coldRows(f.store.historyProjectionStore.query);
      const publishedFile = cacheFile(f);
      const stamp = readHistoryProjectionStamp(f.store.database);
      f.close();
      const marker = await killAtCheckpoint(f, stage);
      assert.equal(marker.transactionOpen, stage === "projection-transaction");
      assert.equal(marker.stamp.facts, stamp.facts + 1);
      const disk = new DatabaseSync(publishedFile);
      try {
        assert.equal(disk.prepare("PRAGMA quick_check").get().quick_check, "ok");
        assert.equal(
          disk.prepare("SELECT COUNT(*) n FROM events").get().n,
          stage === "projection-commit" ? 4 : 3,
          "only the completed outer projection transaction survives the forced kill",
        );
      } finally {
        disk.close();
      }
      await f.reopen();
      const target = readHistoryProjectionStamp(f.store.database);
      assert.equal(target.facts, marker.stamp.facts, "recovery must not replay the authoritative fact transaction");
      assert.equal(
        f.store.database.prepare("SELECT COUNT(*) n FROM events WHERE session_id='crash-session'").get().n,
        1,
      );
      const recovered = await f.read();
      assert.deepEqual(clean(recovered), clean(await f.oracle()));
      assert.equal(recovered.summary.eventCount, 4);
      assert.equal(recovered.summary.sessionCount, 2);
      assert.equal(recovered.summary.totals.total, 510);
      assertNoColdCopy(f, before);
      if (stage === "projection-commit") assert.equal(f.store.lastHistoryQueryWork.projection.reused, true);
      else assert.equal(f.store.lastHistoryQueryWork.projection.delta.added, 1);
      const query = f.store.historyProjectionStore.query.database;
      assert.equal(query.prepare("SELECT COUNT(*) n FROM history_query_rows").get().n, 4);
      assert.equal(query.prepare("SELECT COUNT(*) n FROM history_query_changes").get().n, 0);
      const revision = query.prepare("SELECT revision FROM usage_business_revision").get().revision;
      await f.reopen();
      assert.deepEqual(clean(await f.read()), clean(recovered));
      assert.equal(f.store.lastHistoryQueryWork.projection.reused, true);
      assert.equal(
        f.store.historyProjectionStore.query.database.prepare("SELECT revision FROM usage_business_revision").get()
          .revision,
        revision,
      );
    });
  }
});

test("malformed or missing current pointers and a damaged cache recover without changing authority facts", async (t) => {
  for (const damage of ["pointer-json", "missing-file", "cache-bytes", "missing-header"]) {
    await t.test(damage, async (child) => {
      const f = await fixture(child);
      const expected = await f.read();
      const sourceStamp = readHistoryProjectionStamp(f.store.database);
      const current = cacheFile(f);
      f.close();
      if (damage === "pointer-json") writeFileSync(path.join(f.cache, "current.json"), "{unfinished");
      else if (damage === "missing-file") rmSync(current);
      else if (damage === "cache-bytes") writeFileSync(current, "damaged derived SQLite");
      else {
        const database = new DatabaseSync(current);
        try {
          database.exec("DROP TABLE usage_history_projection_cache");
        } finally {
          database.close();
        }
      }
      await f.reopen();
      const result = await f.read();
      assert.deepEqual(clean(result), clean(expected));
      const repaired = readHistoryProjectionStamp(f.store.database);
      assert.equal(repaired.facts, sourceStamp.facts);
      assert.equal(repaired.auxiliary, sourceStamp.auxiliary);
      assert.equal(f.store.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
      assert.equal(readdirSync(f.cache).filter((name) => /^projection-.*\.sqlite$/.test(name)).length, 1);
    });
  }
});

test("price, FX and service-tier evidence changes reprice without copying cold facts", async (t) => {
  const original = getPricingCatalog();
  t.after(() => setPricingCatalog(original));
  const f = await fixture(t);
  const baseline = await f.read();
  const rows = coldRows(f.store.historyProjectionStore.query);
  const prices = structuredClone(original);
  const entry = prices.models["gpt-6-sol"];
  for (const rates of [entry.short, entry.long, entry.fast.short, entry.fast.long]) {
    for (const field of ["input", "cachedInput", "cacheWrite", "output"]) rates[field] *= 3;
  }
  setPricingCatalog(prices);
  const repriced = await f.read();
  assertNoColdCopy(f, rows);
  assert.notEqual(repriced.summary.costEstimate.totalUsd, baseline.summary.costEstimate.totalUsd);
  assert.deepEqual(clean(repriced), clean(await f.oracle()));

  const fx = structuredClone(prices);
  fx.usdToCnyRate *= 2;
  setPricingCatalog(fx);
  const converted = await f.read();
  assertNoColdCopy(f, rows);
  assert.equal(converted.summary.costEstimate.totalUsd, repriced.summary.costEstimate.totalUsd);
  assert.equal(converted.summary.costEstimate.usdToCnyRate, fx.usdToCnyRate);
  assert.deepEqual(clean(converted), clean(await f.oracle()));

  const totals = [];
  for (const tier of ["standard", "fast"]) {
    f.store.serviceTierEvidence = serviceTierEvidenceFromSnapshot({
      formatVersion: 1,
      threads: [{ threadId: "shared-session", turns: [{ time: START - 1, tier }] }],
    });
    f.store.serviceTierEvidenceInput = `fixture-${tier}`;
    const evidenced = await f.read();
    assertNoColdCopy(f, rows);
    totals.push(evidenced.summary.costEstimate.totalUsd);
    assert.deepEqual(clean(evidenced), clean(await f.oracle()));
  }
  assert.notEqual(totals[0], totals[1]);
});

test("a timezone dependency change repartitions calendar results without copying cold facts", async (t) => {
  const timezone = process.env.TZ;
  t.after(() => {
    if (timezone === undefined) delete process.env.TZ;
    else process.env.TZ = timezone;
  });
  process.env.TZ = "UTC";
  const f = await fixture(t);
  const filters = { ...FILTERS, calendarZone: "local" };
  const first = await f.read(filters);
  const before = coldRows(f.store.historyProjectionStore.query);
  process.env.TZ = "Asia/Shanghai";
  const changed = await f.read(filters);
  assert.deepEqual(clean(changed), clean(await f.oracle(filters)));
  assert.notDeepEqual(changed.summary.timeline, first.summary.timeline);
  assertNoColdCopy(f, before);
});
