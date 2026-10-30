import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  importRequestTimingEvidence,
  lookupRequestTiming,
  readRequestTimingRevision,
  validateStoredEvidence,
} from "../src/perf-request-timing-store.js";
import { parseImportArgs, runImport } from "../scripts/import-perf-request-timings.mjs";
import { foldCodexRolloutMetadata } from "../src/perf-sources/codex-fold.js";
import { STORE_SCHEMA_VERSION, UsageStore } from "../src/usage-store.js";

const REVIEWED_ORIGINS = ["producer-v1"];

function evidence(responseId, overrides = {}) {
  return {
    schemaVersion: 1,
    evidenceOrigin: "producer-v1",
    responseId,
    requestedModel: "model-a",
    reportedOutputTokens: 100,
    durationMs: 1_000,
    status: "completed",
    completedAtMs: null,
    ...overrides,
  };
}

function generatedEvidence(responseId, overrides = {}) {
  return evidence(responseId, {
    schemaVersion: 2,
    generation: {
      outputTokens: 100,
      durationMs: 500,
      startOutputTokens: 1,
      timingKind: "first_last_output",
    },
    ...overrides,
  });
}

function generatedEvidenceForRequest(responseId, durationMs, overrides = {}) {
  return generatedEvidence(responseId, {
    durationMs,
    generation: {
      outputTokens: 100,
      durationMs,
      startOutputTokens: 0,
      timingKind: "first_last_output",
    },
    ...overrides,
  });
}

function links(...pairs) {
  return pairs.map(([responseId, threadId]) => ({ responseId, threadId }));
}

async function withDatabase(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "request-timing-store-"));
  const databaseFile = path.join(root, "timing.sqlite");
  let database = new DatabaseSync(databaseFile);
  try {
    return await fn({
      database,
      databaseFile,
      reopen() {
        database.close();
        database = new DatabaseSync(databaseFile);
        return database;
      },
    });
  } finally {
    try {
      database.close();
    } catch {
      // Already closed by the test.
    }
    await rm(root, { recursive: true, force: true });
  }
}

function nativeLinks(homeId) {
  const folded = foldCodexRolloutMetadata(homeId, [
    {
      records: [
        { kind: "turn_context", threadId: "thread-a", turnId: "turn-a", model: "model-a", effort: "high" },
        { kind: "turn_context", threadId: "thread-b", turnId: "turn-b", model: "model-a", effort: "high" },
        {
          kind: "token_usage_record",
          sourcePath: "rollout-a.jsonl",
          lineNumber: 1,
          threadId: "thread-a",
          turnId: "turn-a",
          responseId: "response-a",
          outputTokens: 100,
          turnOutputTokens: 100,
          timestamp: "2026-10-21T00:00:00.000Z",
        },
        {
          kind: "token_usage_record",
          sourcePath: "rollout-b.jsonl",
          lineNumber: 1,
          threadId: "thread-b",
          turnId: "turn-b",
          responseId: "response-b",
          outputTokens: 100,
          turnOutputTokens: 100,
          timestamp: "2026-10-21T00:00:00.000Z",
        },
      ],
    },
  ]);
  return folded.turns.flatMap((turn) =>
    turn.requests.map((request) => ({ responseId: request.responseId, threadId: turn.threadId })),
  );
}

function codexRollout(threadId, responseId, baseMs = 1_800_000_000_000) {
  return [
    {
      type: "session_meta",
      payload: { id: threadId, session_id: threadId, source: "cli", originator: "codex-tui" },
    },
    {
      type: "turn_context",
      payload: { thread_id: threadId, turn_id: `turn-${threadId}`, model: "model-a", effort: "high" },
    },
    {
      type: "token_usage_record",
      timestamp: new Date(baseMs + 2_000).toISOString(),
      payload: {
        thread_id: threadId,
        turn_id: `turn-${threadId}`,
        response_id: responseId,
        usage: { output_tokens: 100 },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: threadId,
        turn_id: `turn-${threadId}`,
        item: { id: `item-${threadId}`, type: "AgentMessage" },
        started_at_ms: baseMs,
        completed_at_ms: baseMs + 500,
      },
    },
    { type: "event_msg", payload: { type: "task_complete", thread_id: threadId, turn_id: `turn-${threadId}` } },
  ];
}

async function makeCodexStoreFixture(threads) {
  const root = await mkdtemp(path.join(tmpdir(), "request-timing-store-integration-"));
  const sessions = path.join(root, ".codex", "sessions", "2026", "10");
  await mkdir(sessions, { recursive: true });
  for (const thread of threads) {
    await writeFile(
      path.join(sessions, `rollout-${thread.threadId}.jsonl`),
      `${codexRollout(thread.threadId, thread.responseId)
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      "utf8",
    );
  }
  const databaseFile = path.join(root, "usage-index.sqlite");
  const options = {
    homeDir: root,
    databaseFile,
    env: {},
    extraHomes: "",
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
  const store = new UsageStore(options);
  await store.sync();
  const home = store.homes.find((candidate) => candidate.path === path.join(root, ".codex"));
  assert.ok(home, "fixture must discover one Codex home");
  return { root, store, homeId: String(home.id) };
}

async function writeCodexRollout(homePath, threadId, responseId, baseMs = 1_800_000_000_000) {
  const sessions = path.join(homePath, "sessions", "2026", "10");
  await mkdir(sessions, { recursive: true });
  const filePath = path.join(sessions, `rollout-${threadId}.jsonl`);
  await writeFile(
    filePath,
    `${codexRollout(threadId, responseId, baseMs)
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
    "utf8",
  );
  return filePath;
}

async function makeTwoHomeCodexStoreFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "request-timing-store-multi-home-"));
  const mainHome = path.join(root, ".codex");
  const otherHome = path.join(root, "other-codex");
  const mainFile = await writeCodexRollout(mainHome, "thread-a", "response-a");
  const otherFile = await writeCodexRollout(otherHome, "thread-b", "response-b");
  const options = {
    homeDir: root,
    databaseFile: path.join(root, "usage-index.sqlite"),
    env: {},
    extraHomes: otherHome,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
  const store = new UsageStore(options);
  await store.sync();
  const main = store.homes.find((home) => path.resolve(home.path) === path.resolve(mainHome));
  const other = store.homes.find((home) => path.resolve(home.path) === path.resolve(otherHome));
  assert.ok(main, "fixture must discover the main Codex home");
  assert.ok(other, "fixture must discover the extra Codex home");
  return {
    root,
    options,
    store,
    mainHome,
    otherHome,
    mainFile,
    otherFile,
    mainHomeId: String(main.id),
    otherHomeId: String(other.id),
  };
}

function sampleDuration(store, homeId, threadId) {
  const sourcePath = String(
    store.database
      .prepare("SELECT source_path FROM perf_rollout_threads WHERE home_id = ? AND thread_id = ?")
      .get(homeId, threadId).source_path,
  );
  return store.database
    .prepare("SELECT duration_ms FROM perf_samples WHERE home_id = ? AND source_path = ?")
    .get(homeId, sourcePath).duration_ms;
}

function timingPublicationSeq(store) {
  return Number(store.readMeta("perf_request_timing_publication_seq"));
}

test("validateStoredEvidence treats an unselected generation column as absent for history compatibility", () => {
  const row = {
    evidence_origin: "producer-v1",
    schema_version: 2,
    requested_model: "model-a",
    reported_output_tokens: 100,
    duration_ms: 1_000,
    status: "completed",
    completed_at_ms: null,
  };
  assert.deepEqual(validateStoredEvidence(row), {
    requestedModel: "model-a",
    reportedOutputTokens: 100,
    durationMs: 1_000,
    generation: null,
  });
  assert.throws(
    () => validateStoredEvidence({ ...row, generation_json: "{" }),
    (error) => error?.code === "REQUEST_TIMING_STORE_CORRUPT",
  );
});

test("C0 · read-only lookup/revision are missing/0 before import; import builds the tables", async () => {
  await withDatabase(({ database }) => {
    assert.deepEqual(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-a" }), {
      state: "missing",
      durationMs: null,
      reportedOutputTokens: null,
      requestedModel: "",
      generation: null,
    });
    assert.equal(readRequestTimingRevision(database), 0);
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'perf_request_timing_%'")
        .get().n,
      0,
    );

    const imported = importRequestTimingEvidence(database, {
      homeId: "home-a",
      records: [evidence("response-a")],
      requestLinks: links(["response-a", "thread-a"]),
    });
    assert.deepEqual(imported, { revision: 1, changed: true, affectedThreadIds: ["thread-a"] });
    for (const table of ["perf_request_timing_meta", "perf_request_timing_evidence", "perf_request_timing_threads"]) {
      assert.equal(
        database.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).n,
        1,
      );
    }
  });
});

test("C0 · schema v2 generation is additive, preferred, and idempotent", async () => {
  await withDatabase(({ database }) => {
    const input = {
      homeId: "home-a",
      records: [evidence("response-a")],
      requestLinks: links(["response-a", "thread-a"]),
    };
    importRequestTimingEvidence(database, input);
    assert.equal(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-a" }).generation, null);

    const approximate = generatedEvidence("response-a", {
      generation: {
        outputTokens: 100,
        durationMs: 900,
        startOutputTokens: 1,
        timingKind: "first_output_response_end",
      },
    });
    assert.equal(importRequestTimingEvidence(database, { ...input, records: [approximate] }).revision, 2);
    assert.deepEqual(
      lookupRequestTiming(database, { homeId: "home-a", responseId: "response-a" }).generation,
      approximate.generation,
    );

    assert.equal(
      importRequestTimingEvidence(database, { ...input, records: [generatedEvidence("response-a")] }).revision,
      3,
    );
    assert.deepEqual(
      lookupRequestTiming(database, { homeId: "home-a", responseId: "response-a" }).generation,
      generatedEvidence("response-a").generation,
    );
    assert.deepEqual(importRequestTimingEvidence(database, { ...input, records: [generatedEvidence("response-a")] }), {
      revision: 3,
      changed: false,
      affectedThreadIds: [],
    });
    assert.deepEqual(
      lookupRequestTiming(database, {
        homeId: "home-a",
        responseId: "response-a",
        model: "model-a",
        outputTokens: 100,
        reasoningOutputTokens: 0,
      }),
      {
        state: "available",
        durationMs: 1_000,
        reportedOutputTokens: 100,
        requestedModel: "model-a",
        generation: generatedEvidence("response-a").generation,
      },
    );
    assert.equal(
      lookupRequestTiming(database, {
        homeId: "home-a",
        responseId: "response-a",
        model: "model-b",
        outputTokens: 100,
      }).state,
      "conflict",
    );
    assert.equal(
      lookupRequestTiming(database, {
        homeId: "home-a",
        responseId: "response-a",
        model: "model-a",
        outputTokens: 101,
      }).state,
      "conflict",
    );
  });
});

test("C0 · known native reasoning reconciles generation output without rewriting raw evidence", async () => {
  await withDatabase(({ database }) => {
    const explicit = (outputTokens) => ({
      outputTokens,
      durationMs: 500,
      startOutputTokens: 0,
      timingKind: "explicit",
    });
    importRequestTimingEvidence(database, {
      homeId: "home-a",
      records: [
        generatedEvidence("response-valid", { generation: explicit(80) }),
        generatedEvidence("response-conflict", { generation: explicit(100) }),
      ],
      requestLinks: links(["response-valid", "thread-valid"], ["response-conflict", "thread-conflict"]),
    });

    assert.deepEqual(
      lookupRequestTiming(database, {
        homeId: "home-a",
        responseId: "response-valid",
        model: "model-a",
        outputTokens: 100,
        reasoningOutputTokens: 20,
      }),
      {
        state: "available",
        durationMs: 1_000,
        reportedOutputTokens: 100,
        requestedModel: "model-a",
        generation: explicit(80),
      },
    );
    assert.equal(
      lookupRequestTiming(database, {
        homeId: "home-a",
        responseId: "response-valid",
        model: "model-a",
        outputTokens: 100,
        reasoningOutputTokens: 0,
      }).state,
      "conflict",
    );
    assert.equal(
      lookupRequestTiming(database, {
        homeId: "home-a",
        responseId: "response-conflict",
        model: "model-a",
        outputTokens: 100,
        reasoningOutputTokens: 20,
      }).state,
      "conflict",
    );
    assert.deepEqual(
      lookupRequestTiming(database, {
        homeId: "home-a",
        responseId: "response-conflict",
        model: "model-a",
        outputTokens: 100,
        reasoningOutputTokens: null,
      }).generation,
      explicit(100),
    );

    const stored = database
      .prepare(`
        SELECT reported_output_tokens, generation_json
        FROM perf_request_timing_evidence
        WHERE home_id = ? AND response_id = ?
      `)
      .get("home-a", "response-conflict");
    assert.equal(Number(stored.reported_output_tokens), 100);
    assert.deepEqual(JSON.parse(String(stored.generation_json)), explicit(100));
  });
});

test("C0 · origins can differ but contradictory reported counts still conflict", async () => {
  await withDatabase(({ database }) => {
    const base = {
      homeId: "home-a",
      requestLinks: links(["response-a", "thread-a"]),
    };
    importRequestTimingEvidence(database, {
      ...base,
      records: [evidence("response-a", { evidenceOrigin: "producer-a" })],
    });
    importRequestTimingEvidence(database, {
      ...base,
      records: [evidence("response-a", { evidenceOrigin: "producer-b", durationMs: 2_000 })],
    });
    assert.deepEqual(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-a" }), {
      state: "available",
      durationMs: 1_000,
      reportedOutputTokens: 100,
      requestedModel: "model-a",
      generation: null,
    });

    importRequestTimingEvidence(database, {
      ...base,
      records: [evidence("response-a", { evidenceOrigin: "producer-c", reportedOutputTokens: 101 })],
    });
    assert.equal(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-a" }).state, "conflict");
  });
});

test("C0 · an existing v1 evidence table upgrades without losing old rows", async () => {
  await withDatabase(({ database }) => {
    database.exec(`
      CREATE TABLE perf_request_timing_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0)
      ) STRICT;
      INSERT INTO perf_request_timing_meta VALUES (1, 0);
      CREATE TABLE perf_request_timing_evidence (
        home_id TEXT NOT NULL CHECK (length(home_id) > 0),
        evidence_origin TEXT NOT NULL CHECK (length(evidence_origin) > 0),
        response_id TEXT NOT NULL CHECK (length(response_id) > 0),
        variant_key TEXT NOT NULL CHECK (length(variant_key) > 0),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        requested_model TEXT NOT NULL CHECK (length(requested_model) > 0),
        reported_output_tokens INTEGER NOT NULL CHECK (reported_output_tokens >= 0),
        duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
        status TEXT NOT NULL CHECK (status = 'completed'),
        completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= 0),
        PRIMARY KEY (home_id, evidence_origin, response_id, variant_key)
      ) STRICT;
      CREATE TABLE perf_request_timing_threads (
        home_id TEXT NOT NULL CHECK (length(home_id) > 0),
        response_id TEXT NOT NULL CHECK (length(response_id) > 0),
        thread_id TEXT NOT NULL CHECK (length(thread_id) > 0),
        PRIMARY KEY (home_id, response_id, thread_id)
      ) STRICT;
      CREATE TABLE perf_request_timing_dirty_threads (
        home_id TEXT NOT NULL CHECK (length(home_id) > 0),
        thread_id TEXT NOT NULL CHECK (length(thread_id) > 0),
        PRIMARY KEY (home_id, thread_id)
      ) STRICT;
    `);
    const old = evidence("response-old");
    database
      .prepare(`
        INSERT INTO perf_request_timing_evidence
          (home_id, evidence_origin, response_id, variant_key, schema_version,
           requested_model, reported_output_tokens, duration_ms, status, completed_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        "home-a",
        old.evidenceOrigin,
        old.responseId,
        JSON.stringify([
          old.schemaVersion,
          old.requestedModel,
          old.reportedOutputTokens,
          old.durationMs,
          old.status,
          old.completedAtMs,
        ]),
        old.schemaVersion,
        old.requestedModel,
        old.reportedOutputTokens,
        old.durationMs,
        old.status,
        old.completedAtMs,
      );
    database
      .prepare("INSERT INTO perf_request_timing_threads VALUES (?, ?, ?)")
      .run("home-a", "response-old", "thread-old");
    assert.equal(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-old" }).generation, null);

    importRequestTimingEvidence(database, {
      homeId: "home-a",
      records: [generatedEvidence("response-new")],
      requestLinks: links(["response-new", "thread-new"]),
    });

    assert.equal(
      database
        .prepare("PRAGMA table_info(perf_request_timing_evidence)")
        .all()
        .some((row) => row.name === "generation_json"),
      true,
    );
    assert.deepEqual(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-old" }), {
      state: "available",
      durationMs: 1_000,
      reportedOutputTokens: 100,
      requestedModel: "model-a",
      generation: null,
    });
    assert.deepEqual(
      lookupRequestTiming(database, { homeId: "home-a", responseId: "response-new" }).generation,
      generatedEvidence("response-new").generation,
    );
  });
});

test("C0 · ensureSchema gives the new response index statistics and lookup uses it without a version bump", async () => {
  await withDatabase(({ database }) => {
    const input = {
      homeId: "home-a",
      records: Array.from({ length: 1_000 }, (_, index) => evidence(`response-${index}`)),
      requestLinks: links(...Array.from({ length: 1_000 }, (_, index) => [`response-${index}`, `thread-${index}`])),
    };
    importRequestTimingEvidence(database, input);
    database.exec("DROP INDEX perf_request_timing_evidence_response");
    database.exec("ANALYZE");
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM sqlite_stat1 WHERE tbl = 'perf_request_timing_evidence'").get().n,
      1,
    );

    const revision = readRequestTimingRevision(database);
    assert.deepEqual(importRequestTimingEvidence(database, { ...input, records: [], requestLinks: [] }), {
      revision,
      changed: false,
      affectedThreadIds: [],
    });
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("perf_request_timing_evidence_response").n,
      1,
    );
    assert.deepEqual(
      database
        .prepare("PRAGMA index_info(perf_request_timing_evidence_response)")
        .all()
        .map((row) => String(row.name)),
      ["home_id", "response_id"],
    );
    assert.equal(
      database
        .prepare(`
          EXPLAIN QUERY PLAN
          SELECT evidence_origin, schema_version, requested_model, reported_output_tokens,
                 duration_ms, status, completed_at_ms
          FROM perf_request_timing_evidence
          WHERE home_id = ? AND response_id = ?
          ORDER BY evidence_origin, variant_key
        `)
        .all("home-a", "response-a")
        .some(
          (row) =>
            String(row.detail).includes("perf_request_timing_evidence_response") &&
            String(row.detail).includes("home_id=? AND response_id=?"),
        ),
      true,
    );
    assert.equal(
      database.prepare("SELECT COUNT(*) AS n FROM sqlite_stat1 WHERE tbl = 'perf_request_timing_evidence'").get().n,
      2,
    );
    database.exec("DELETE FROM sqlite_stat1 WHERE idx = 'perf_request_timing_evidence_response'");
    importRequestTimingEvidence(database, { ...input, records: [], requestLinks: [] });
    assert.equal(
      database
        .prepare("SELECT COUNT(*) AS n FROM sqlite_stat1 WHERE idx = 'perf_request_timing_evidence_response'")
        .get().n,
      0,
      "existing index statistics must not be refreshed on every schema check",
    );
    assert.equal(readRequestTimingRevision(database), revision);
  });
});

test("C0 · exact duplicates are idempotent; differing output/model/duration/origin persists conflict", async () => {
  await withDatabase(({ database }) => {
    const input = {
      homeId: "home-a",
      records: [evidence("response-a")],
      requestLinks: links(["response-a", "thread-a"]),
    };
    assert.equal(importRequestTimingEvidence(database, input).revision, 1);
    assert.deepEqual(importRequestTimingEvidence(database, input), {
      revision: 1,
      changed: false,
      affectedThreadIds: [],
    });

    assert.deepEqual(
      lookupRequestTiming(database, { homeId: "home-a", threadId: "thread-a", responseId: "response-a" }),
      {
        state: "available",
        durationMs: 1_000,
        reportedOutputTokens: 100,
        requestedModel: "model-a",
        generation: null,
      },
    );

    assert.deepEqual(
      importRequestTimingEvidence(database, {
        ...input,
        records: [evidence("response-a", { reportedOutputTokens: 101 })],
      }),
      { revision: 2, changed: true, affectedThreadIds: ["thread-a"] },
    );
    assert.equal(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-a" }).state, "conflict");

    // Once conflicting, later variants cannot "repair" it by matching one value.
    assert.deepEqual(
      importRequestTimingEvidence(database, {
        ...input,
        records: [evidence("response-a", { requestedModel: "model-b" })],
      }),
      { revision: 3, changed: true, affectedThreadIds: ["thread-a"] },
    );
    assert.deepEqual(
      importRequestTimingEvidence(database, {
        ...input,
        records: [evidence("response-a", { durationMs: 2_000 })],
      }),
      { revision: 4, changed: true, affectedThreadIds: ["thread-a"] },
    );
    assert.deepEqual(
      importRequestTimingEvidence(database, {
        ...input,
        records: [evidence("response-a", { evidenceOrigin: "producer-v2" })],
      }),
      { revision: 5, changed: true, affectedThreadIds: ["thread-a"] },
    );
    assert.deepEqual(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-a" }), {
      state: "conflict",
      durationMs: null,
      reportedOutputTokens: null,
      requestedModel: "",
      generation: null,
    });
    assert.equal(importRequestTimingEvidence(database, input).revision, 5, "duplicate after conflict is still inert");
  });
});

test("C0 · import order is symmetric, conflicts survive close/reopen, and cross-file batches retain every variant", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "request-timing-order-"));
  try {
    const firstFile = path.join(root, "first.sqlite");
    const secondFile = path.join(root, "second.sqlite");
    const first = new DatabaseSync(firstFile);
    const second = new DatabaseSync(secondFile);
    try {
      const a = evidence("response-a", { reportedOutputTokens: 100 });
      const b = evidence("response-a", { reportedOutputTokens: 200 });
      const inputA = { homeId: "home-a", records: [a], requestLinks: links(["response-a", "thread-a"]) };
      const inputB = { homeId: "home-a", records: [b], requestLinks: links(["response-a", "thread-a"]) };

      importRequestTimingEvidence(first, inputA);
      importRequestTimingEvidence(first, inputB);
      importRequestTimingEvidence(second, inputB);
      importRequestTimingEvidence(second, inputA);

      first.close();
      const reopened = new DatabaseSync(firstFile);
      try {
        assert.deepEqual(lookupRequestTiming(reopened, { homeId: "home-a", responseId: "response-a" }), {
          state: "conflict",
          durationMs: null,
          reportedOutputTokens: null,
          requestedModel: "",
          generation: null,
        });
        assert.equal(readRequestTimingRevision(reopened), 2);
      } finally {
        reopened.close();
      }
      assert.equal(lookupRequestTiming(second, { homeId: "home-a", responseId: "response-a" }).state, "conflict");
      assert.equal(readRequestTimingRevision(second), 2);
    } finally {
      try {
        first.close();
      } catch {
        // Reopened test closes it.
      }
      second.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C0 · homes and native threads are isolated; an unmatched thread is missing", async () => {
  await withDatabase(({ database }) => {
    importRequestTimingEvidence(database, {
      homeId: "home-a",
      records: [evidence("response-a", { durationMs: 1_000 })],
      requestLinks: links(["response-a", "thread-a"]),
    });
    importRequestTimingEvidence(database, {
      homeId: "home-b",
      records: [evidence("response-a", { durationMs: 2_000 })],
      requestLinks: links(["response-a", "thread-b"]),
    });
    assert.deepEqual(
      lookupRequestTiming(database, { homeId: "home-a", threadId: "thread-a", responseId: "response-a" }),
      {
        state: "available",
        durationMs: 1_000,
        reportedOutputTokens: 100,
        requestedModel: "model-a",
        generation: null,
      },
    );
    assert.deepEqual(
      lookupRequestTiming(database, { homeId: "home-b", threadId: "thread-b", responseId: "response-a" }),
      {
        state: "available",
        durationMs: 2_000,
        reportedOutputTokens: 100,
        requestedModel: "model-a",
        generation: null,
      },
    );
    assert.equal(
      lookupRequestTiming(database, { homeId: "home-a", threadId: "thread-b", responseId: "response-a" }).state,
      "missing",
    );
    assert.equal(lookupRequestTiming(database, { homeId: "home-a", responseId: "no-evidence" }).state, "missing");
  });
});

test("C0 · an existing response/thread link rejects A→B and B→A without changing state", async () => {
  const runOrientation = async (firstThread, secondThread) => {
    await withDatabase(({ database, reopen }) => {
      importRequestTimingEvidence(database, {
        homeId: "home-a",
        records: [evidence("response-a")],
        requestLinks: links(["response-a", firstThread]),
      });
      assert.throws(
        () =>
          importRequestTimingEvidence(database, {
            homeId: "home-a",
            records: [evidence("response-a")],
            requestLinks: links(["response-a", secondThread]),
          }),
        (error) => error.code === "REQUEST_TIMING_THREAD_CONFLICT",
      );
      assert.equal(readRequestTimingRevision(database), 1);
      assert.deepEqual(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-a" }), {
        state: "available",
        durationMs: 1_000,
        reportedOutputTokens: 100,
        requestedModel: "model-a",
        generation: null,
      });

      const reopened = reopen();
      assert.equal(readRequestTimingRevision(reopened), 1);
      assert.equal(
        lookupRequestTiming(reopened, { homeId: "home-a", threadId: firstThread, responseId: "response-a" }).state,
        "available",
      );
      assert.equal(
        lookupRequestTiming(reopened, { homeId: "home-a", threadId: secondThread, responseId: "response-a" }).state,
        "missing",
      );
      assert.deepEqual(
        importRequestTimingEvidence(reopened, {
          homeId: "home-a",
          records: [evidence("response-a")],
          requestLinks: links(["response-a", firstThread]),
        }),
        { revision: 1, changed: false, affectedThreadIds: [] },
      );
    });
  };

  await runOrientation("thread-a", "thread-b");
  await runOrientation("thread-b", "thread-a");
});

test("C0 · a mixed batch with one link conflict leaves none of its other new records", async () => {
  await withDatabase(({ database }) => {
    importRequestTimingEvidence(database, {
      homeId: "home-a",
      records: [evidence("response-old")],
      requestLinks: links(["response-old", "thread-old"]),
    });

    assert.throws(
      () =>
        importRequestTimingEvidence(database, {
          homeId: "home-a",
          records: [evidence("response-old", { durationMs: 2_000 }), evidence("response-new")],
          requestLinks: links(["response-old", "thread-other"], ["response-new", "thread-new"]),
        }),
      (error) => error.code === "REQUEST_TIMING_THREAD_CONFLICT",
    );

    assert.equal(readRequestTimingRevision(database), 1);
    assert.equal(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-new" }).state, "missing");
    assert.deepEqual(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-old" }), {
      state: "available",
      durationMs: 1_000,
      reportedOutputTokens: 100,
      requestedModel: "model-a",
      generation: null,
    });
    assert.deepEqual(
      importRequestTimingEvidence(database, {
        homeId: "home-a",
        records: [evidence("response-old")],
        requestLinks: links(["response-old", "thread-old"]),
      }),
      { revision: 1, changed: false, affectedThreadIds: [] },
    );
  });
});

test("C0 · affectedThreadIds deduplicates multiple legal responses on one thread", async () => {
  await withDatabase(({ database }) => {
    assert.deepEqual(
      importRequestTimingEvidence(database, {
        homeId: "home-a",
        records: [evidence("response-a"), evidence("response-b")],
        requestLinks: links(["response-a", "thread-shared"], ["response-b", "thread-shared"]),
      }),
      { revision: 1, changed: true, affectedThreadIds: ["thread-shared"] },
    );
    assert.equal(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-a" }).state, "available");
    assert.equal(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-b" }).state, "available");
  });
});

test("C0 · synthetic native ledger links affect only their own threads", async () => {
  await withDatabase(({ database }) => {
    const requestLinks = nativeLinks("home-native");
    assert.deepEqual(requestLinks, [
      { responseId: "response-a", threadId: "thread-a" },
      { responseId: "response-b", threadId: "thread-b" },
    ]);

    assert.deepEqual(
      importRequestTimingEvidence(database, {
        homeId: "home-native",
        records: [evidence("response-a")],
        requestLinks,
      }),
      { revision: 1, changed: true, affectedThreadIds: ["thread-a"] },
    );
    assert.deepEqual(
      importRequestTimingEvidence(database, {
        homeId: "home-native",
        records: [evidence("response-b")],
        requestLinks,
      }),
      { revision: 2, changed: true, affectedThreadIds: ["thread-b"] },
    );
    assert.deepEqual(
      importRequestTimingEvidence(database, {
        homeId: "home-native",
        records: [evidence("response-a", { durationMs: 3_000 })],
        requestLinks,
      }),
      { revision: 3, changed: true, affectedThreadIds: ["thread-a"] },
    );
    assert.equal(lookupRequestTiming(database, { homeId: "home-native", responseId: "response-a" }).state, "conflict");
    assert.equal(lookupRequestTiming(database, { homeId: "home-native", responseId: "response-b" }).state, "available");
  });
});

test("C0 · a SQL failure mid-batch rolls back new rows and preserves old usable evidence", async () => {
  await withDatabase(({ database }) => {
    importRequestTimingEvidence(database, {
      homeId: "home-a",
      records: [evidence("response-old")],
      requestLinks: links(["response-old", "thread-old"]),
    });
    database.exec(`
      CREATE TRIGGER fail_timing_insert
      BEFORE INSERT ON perf_request_timing_evidence
      WHEN NEW.response_id = 'response-fail'
      BEGIN
        SELECT RAISE(ABORT, 'injected timing failure');
      END;
    `);

    assert.throws(
      () =>
        importRequestTimingEvidence(database, {
          homeId: "home-a",
          records: [evidence("response-new"), evidence("response-fail")],
          requestLinks: links(["response-new", "thread-new"], ["response-fail", "thread-fail"]),
        }),
      /injected timing failure/,
    );

    assert.equal(readRequestTimingRevision(database), 1);
    assert.equal(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-new" }).state, "missing");
    assert.deepEqual(lookupRequestTiming(database, { homeId: "home-a", responseId: "response-old" }), {
      state: "available",
      durationMs: 1_000,
      reportedOutputTokens: 100,
      requestedModel: "model-a",
      generation: null,
    });
  });
});

test("C1 · v17 migrates through timing tables to v22; reopen is idempotent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "request-timing-migration-"));
  const databaseFile = path.join(root, "usage-index.sqlite");
  let store = new UsageStore({ homeDir: root, databaseFile });
  try {
    await store.open();
    assert.equal(STORE_SCHEMA_VERSION, 23);
    assert.equal(store.database.prepare("PRAGMA user_version").get().user_version, 23);
    for (const table of [
      "perf_request_timing_meta",
      "perf_request_timing_evidence",
      "perf_request_timing_threads",
      "perf_request_timing_dirty_threads",
    ]) {
      assert.equal(store.database.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(table)?.type, "table");
    }
    store.close();

    const raw = new DatabaseSync(databaseFile);
    raw.exec(`
      DROP TABLE perf_request_timing_dirty_threads;
      DROP TABLE perf_request_timing_threads;
      DROP TABLE perf_request_timing_evidence;
      DROP TABLE perf_request_timing_meta;
      PRAGMA user_version = 17;
    `);
    raw.close();

    store = new UsageStore({ homeDir: root, databaseFile });
    await store.open();
    assert.equal(store.database.prepare("PRAGMA user_version").get().user_version, 23);
    assert.equal(readRequestTimingRevision(store.database), 0);
    store.close();

    store = new UsageStore({ homeDir: root, databaseFile });
    await store.open();
    assert.equal(store.database.prepare("PRAGMA user_version").get().user_version, 23);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("C1 · a wrong v17 timing shape rolls back to v17 and cannot leave half a migration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "request-timing-migration-failure-"));
  const databaseFile = path.join(root, "usage-index.sqlite");
  let store = new UsageStore({ homeDir: root, databaseFile });
  try {
    await store.open();
    store.close();
    const raw = new DatabaseSync(databaseFile);
    raw.exec(`
      DROP TABLE perf_request_timing_dirty_threads;
      DROP TABLE perf_request_timing_threads;
      DROP TABLE perf_request_timing_evidence;
      DROP TABLE perf_request_timing_meta;
      CREATE VIEW perf_request_timing_meta AS SELECT 1 AS singleton, 0 AS revision;
      PRAGMA user_version = 17;
    `);
    raw.close();

    store = new UsageStore({ homeDir: root, databaseFile });
    await assert.rejects(store.open(), /perf_request_timing_meta|timing contract|ERR/);
    const after = new DatabaseSync(databaseFile);
    try {
      assert.equal(after.prepare("PRAGMA user_version").get().user_version, 17);
      assert.equal(
        after
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'perf_request_timing_%'")
          .get().n,
        0,
      );
    } finally {
      after.close();
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("C1 · import folds native projections, queues only the affected thread, and publishes on retry", async () => {
  const fixture = await makeCodexStoreFixture([
    { threadId: "thread-a", responseId: "response-a" },
    { threadId: "thread-b", responseId: "response-b" },
  ]);
  const { store, homeId } = fixture;
  try {
    const sourcePathFor = (threadId) =>
      String(
        store.database
          .prepare("SELECT source_path FROM perf_rollout_threads WHERE home_id = ? AND thread_id = ?")
          .get(homeId, threadId).source_path,
      );
    const pathA = sourcePathFor("thread-a");
    const pathB = sourcePathFor("thread-b");
    const eventSnapshot = () => ({
      count: Number(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n),
      total: Number(store.database.prepare("SELECT COALESCE(SUM(total), 0) AS n FROM events").get().n),
      cost: store.summarize({ preset: "all" }).costEstimate.totalUsd,
    });
    const before = eventSnapshot();
    const versionBefore = store.readMeta("perf_index_version");
    const fingerprintsBefore = JSON.parse(store.readMeta("perf_file_fingerprints"));
    assert.equal(typeof fingerprintsBefore[pathA], "string");
    assert.equal(typeof fingerprintsBefore[pathB], "string");
    assert.equal(sampleDuration(store, homeId, "thread-a"), null);
    assert.equal(sampleDuration(store, homeId, "thread-b"), null);
    assert.equal(store.summarize({ preset: "all" }).perf.coverage.sampled, 0);

    assert.deepEqual(
      store.importRequestTimingEvidence({
        homeId,
        records: [generatedEvidenceForRequest("response-a", 1_000)],
        reviewedOrigins: REVIEWED_ORIGINS,
      }),
      { revision: 1, changed: true, affectedThreadIds: ["thread-a"] },
    );
    assert.deepEqual(store.requestTimingDirtyThreads(homeId), ["thread-a"]);
    assert.equal(
      store.readMeta("perf_index_version"),
      versionBefore,
      "import must not publish an old candidate as new",
    );
    assert.equal(JSON.parse(store.readMeta("perf_file_fingerprints"))[pathA], fingerprintsBefore[pathA]);
    assert.equal(JSON.parse(store.readMeta("perf_file_fingerprints"))[pathB], fingerprintsBefore[pathB]);
    assert.deepEqual(store.lookupRequestTiming({ homeId, threadId: "thread-a", responseId: "response-a" }), {
      state: "available",
      durationMs: 1_000,
      reportedOutputTokens: 100,
      requestedModel: "model-a",
      generation: {
        outputTokens: 100,
        durationMs: 1_000,
        startOutputTokens: 0,
        timingKind: "first_last_output",
      },
    });

    await store.sync();
    assert.deepEqual(store.codexThreadBuildPlan.get(homeId), {
      staged: ["thread-a"],
      retained: ["thread-b"],
    });
    assert.deepEqual(store.requestTimingDirtyThreads(homeId), []);
    assert.equal(
      store.database
        .prepare("SELECT duration_ms FROM perf_samples WHERE home_id = ? AND source_path = ?")
        .get(homeId, pathA).duration_ms,
      null,
    );
    assert.equal(store.lookupRequestTiming({ homeId, responseId: "response-a" }).generation.durationMs, 1000);
    assert.equal(JSON.parse(store.readMeta("perf_file_fingerprints"))[pathB], fingerprintsBefore[pathB]);
    assert.notEqual(store.readMeta("perf_index_version"), versionBefore);
    assert.deepEqual(eventSnapshot(), before, "timing import and perf rebuild must not rewrite usage or cost");
    assert.equal(sampleDuration(store, homeId, "thread-b"), null);
    const perfAfter = store.summarize({ preset: "all" }).perf;
    assert.equal(perfAfter.coverage.sampled, 0);
    assert.equal(perfAfter.groups.length, 0);
    assert.equal(perfAfter.models.length, 1);
    assert.equal(perfAfter.models[0].n, 0);
    assert.equal(perfAfter.models[0].averageTps, null);

    const publishedVersion = store.readMeta("perf_index_version");
    assert.equal(store.readMeta("perf_request_timing_published_revision"), "1");
    assert.deepEqual(
      store.importRequestTimingEvidence({
        homeId,
        records: [generatedEvidenceForRequest("response-a", 1_000)],
        reviewedOrigins: REVIEWED_ORIGINS,
      }),
      { revision: 1, changed: false, affectedThreadIds: [] },
    );
    await store.sync();
    assert.equal(
      store.readMeta("perf_index_version"),
      publishedVersion,
      "duplicate import must leave the version stable",
    );
    assert.equal(store.readMeta("perf_request_timing_published_revision"), "1");

    store.importRequestTimingEvidence({
      homeId,
      records: [generatedEvidenceForRequest("response-a", 2_000)],
      reviewedOrigins: REVIEWED_ORIGINS,
    });
    store.database.exec(`
      CREATE TRIGGER fail_timing_dirty_clear
      BEFORE DELETE ON perf_request_timing_dirty_threads
      WHEN OLD.thread_id = 'thread-a'
      BEGIN
        SELECT RAISE(ABORT, 'injected dirty clear failure');
      END;
    `);
    await store.sync();
    assert.equal(readRequestTimingRevision(store.database), 2);
    assert.equal(
      store.readMeta("perf_index_version"),
      publishedVersion,
      "a failed timing publication must keep the last published index version",
    );
    assert.equal(store.readMeta("perf_request_timing_published_revision"), "1");
    assert.deepEqual(
      store.requestTimingDirtyThreads(homeId),
      ["thread-a"],
      "failed publication must retain dirty state",
    );
    assert.equal(store.lookupRequestTiming({ homeId, responseId: "response-a" }).state, "conflict");

    await store.sync();
    assert.equal(
      store.readMeta("perf_index_version"),
      publishedVersion,
      "a repeated failed publication must keep the last published index version",
    );
    assert.equal(store.readMeta("perf_request_timing_published_revision"), "1");
    assert.deepEqual(store.requestTimingDirtyThreads(homeId), ["thread-a"]);

    store.database.exec("DROP TRIGGER fail_timing_dirty_clear");
    await store.sync();
    assert.deepEqual(store.requestTimingDirtyThreads(homeId), []);
    assert.equal(store.readMeta("perf_request_timing_published_revision"), "2");
    assert.notEqual(
      store.readMeta("perf_index_version"),
      publishedVersion,
      "successful retry must publish the new revision",
    );
    assert.deepEqual(eventSnapshot(), before);
  } finally {
    store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("C1 · a successful home publishes timing while another home fails, survives reopen, then resumes", async () => {
  const fixture = await makeTwoHomeCodexStoreFixture();
  let { store } = fixture;
  try {
    const importTiming = (homeId, responseId, durationMs) =>
      store.importRequestTimingEvidence({
        homeId,
        records: [generatedEvidenceForRequest(responseId, durationMs)],
        reviewedOrigins: REVIEWED_ORIGINS,
      });

    importTiming(fixture.mainHomeId, "response-a", 1_000);
    importTiming(fixture.otherHomeId, "response-b", 1_000);
    await store.sync();
    const publishedVersion = store.readMeta("perf_index_version");
    const publishedSeq = timingPublicationSeq(store);
    assert.equal(sampleDuration(store, fixture.mainHomeId, "thread-a"), null);
    assert.equal(sampleDuration(store, fixture.otherHomeId, "thread-b"), null);

    importTiming(fixture.mainHomeId, "response-a", 2_000);
    importTiming(fixture.otherHomeId, "response-b", 2_000);
    assert.equal(store.readMeta("perf_index_version"), publishedVersion);
    store.database.exec(`
      CREATE TRIGGER fail_timing_dirty_clear
      BEFORE DELETE ON perf_request_timing_dirty_threads
      WHEN OLD.thread_id = 'thread-b'
      BEGIN
        SELECT RAISE(ABORT, 'injected B failure');
      END;
    `);

    await store.sync();
    assert.deepEqual(store.requestTimingDirtyThreads(fixture.mainHomeId), []);
    assert.deepEqual(store.requestTimingDirtyThreads(fixture.otherHomeId), ["thread-b"]);
    assert.equal(sampleDuration(store, fixture.mainHomeId, "thread-a"), null);
    assert.equal(sampleDuration(store, fixture.otherHomeId, "thread-b"), null);
    assert.equal(timingPublicationSeq(store), publishedSeq + 1);
    assert.notEqual(store.readMeta("perf_index_version"), publishedVersion);

    const partialVersion = store.readMeta("perf_index_version");
    const partialSeq = timingPublicationSeq(store);
    await store.sync();
    assert.equal(store.readMeta("perf_index_version"), partialVersion);
    assert.equal(timingPublicationSeq(store), partialSeq);
    assert.deepEqual(store.requestTimingDirtyThreads(fixture.otherHomeId), ["thread-b"]);

    store.close();
    store = new UsageStore(fixture.options);
    await store.open();
    assert.equal(store.readMeta("perf_index_version"), partialVersion);
    assert.equal(timingPublicationSeq(store), partialSeq);
    assert.deepEqual(store.requestTimingDirtyThreads(fixture.otherHomeId), ["thread-b"]);

    store.database.exec("DROP TRIGGER fail_timing_dirty_clear");
    await store.sync();
    assert.deepEqual(store.requestTimingDirtyThreads(fixture.mainHomeId), []);
    assert.deepEqual(store.requestTimingDirtyThreads(fixture.otherHomeId), []);
    assert.equal(sampleDuration(store, fixture.otherHomeId, "thread-b"), null);
    assert.equal(timingPublicationSeq(store), partialSeq + 1);
    assert.notEqual(store.readMeta("perf_index_version"), partialVersion);

    const recoveredVersion = store.readMeta("perf_index_version");
    const recoveredSeq = timingPublicationSeq(store);
    await store.sync();
    assert.equal(store.readMeta("perf_index_version"), recoveredVersion);
    assert.equal(timingPublicationSeq(store), recoveredSeq);
  } finally {
    store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("C1 · the second home can publish timing while the first home remains dirty", async () => {
  const fixture = await makeTwoHomeCodexStoreFixture();
  const { store } = fixture;
  try {
    const importTiming = (homeId, responseId, durationMs) =>
      store.importRequestTimingEvidence({
        homeId,
        records: [generatedEvidenceForRequest(responseId, durationMs)],
        reviewedOrigins: REVIEWED_ORIGINS,
      });

    importTiming(fixture.mainHomeId, "response-a", 1_000);
    importTiming(fixture.otherHomeId, "response-b", 1_000);
    await store.sync();
    const publishedVersion = store.readMeta("perf_index_version");
    const publishedSeq = timingPublicationSeq(store);

    importTiming(fixture.mainHomeId, "response-a", 2_000);
    importTiming(fixture.otherHomeId, "response-b", 2_000);
    store.database.exec(`
      CREATE TRIGGER fail_timing_dirty_clear
      BEFORE DELETE ON perf_request_timing_dirty_threads
      WHEN OLD.thread_id = 'thread-a'
      BEGIN
        SELECT RAISE(ABORT, 'injected A failure');
      END;
    `);

    await store.sync();
    assert.deepEqual(store.requestTimingDirtyThreads(fixture.mainHomeId), ["thread-a"]);
    assert.deepEqual(store.requestTimingDirtyThreads(fixture.otherHomeId), []);
    assert.equal(sampleDuration(store, fixture.mainHomeId, "thread-a"), null);
    assert.equal(sampleDuration(store, fixture.otherHomeId, "thread-b"), null);
    assert.equal(timingPublicationSeq(store), publishedSeq + 1);
    assert.notEqual(store.readMeta("perf_index_version"), publishedVersion);

    const partialVersion = store.readMeta("perf_index_version");
    const partialSeq = timingPublicationSeq(store);
    await store.sync();
    assert.equal(store.readMeta("perf_index_version"), partialVersion);
    assert.equal(timingPublicationSeq(store), partialSeq);
    assert.deepEqual(store.requestTimingDirtyThreads(fixture.mainHomeId), ["thread-a"]);
  } finally {
    store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("C1 · unrelated source fingerprints still advance while timing publication is blocked", async () => {
  const fixture = await makeTwoHomeCodexStoreFixture();
  const { store } = fixture;
  try {
    const publishedVersion = store.readMeta("perf_index_version");
    const publishedSeq = timingPublicationSeq(store);
    const publishedFingerprint = JSON.parse(store.readMeta("perf_file_fingerprints"))[fixture.otherFile];

    store.importRequestTimingEvidence({
      homeId: fixture.mainHomeId,
      records: [evidence("response-a")],
      reviewedOrigins: REVIEWED_ORIGINS,
    });
    store.database.exec(`
      CREATE TRIGGER fail_timing_dirty_clear
      BEFORE DELETE ON perf_request_timing_dirty_threads
      WHEN OLD.thread_id = 'thread-a'
      BEGIN
        SELECT RAISE(ABORT, 'injected A failure');
      END;
    `);
    await writeCodexRollout(fixture.otherHome, "thread-b", "response-b", 1_800_000_005_000);

    await store.sync();
    assert.deepEqual(store.requestTimingDirtyThreads(fixture.mainHomeId), ["thread-a"]);
    assert.equal(timingPublicationSeq(store), publishedSeq);
    assert.notEqual(JSON.parse(store.readMeta("perf_file_fingerprints"))[fixture.otherFile], publishedFingerprint);
    assert.notEqual(store.readMeta("perf_index_version"), publishedVersion);
  } finally {
    store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("C1 · reviewed origins apply explicitly to one batch and cannot be self-certified", async () => {
  const fixture = await makeCodexStoreFixture([{ threadId: "thread-a", responseId: "response-a" }]);
  const { store, homeId } = fixture;
  try {
    const versionBefore = store.readMeta("perf_index_version");
    assert.throws(
      () =>
        store.importRequestTimingEvidence({
          homeId,
          records: [evidence("response-a")],
        }),
      (error) => error.code === "REQUEST_TIMING_ORIGIN_UNREVIEWED",
    );
    assert.throws(
      () =>
        store.importRequestTimingEvidence({
          homeId,
          reviewedOrigins: ["another-origin"],
          records: [evidence("response-a", { admission: "certified", certified: true })],
        }),
      (error) => error.code === "REQUEST_TIMING_ORIGIN_UNREVIEWED",
    );
    assert.equal(readRequestTimingRevision(store.database), 0);
    assert.deepEqual(store.requestTimingDirtyThreads(homeId), []);
    assert.equal(store.lookupRequestTiming({ homeId, responseId: "response-a" }).state, "missing");
    assert.equal(store.readMeta("perf_index_version"), versionBefore);

    assert.deepEqual(
      store.importRequestTimingEvidence({
        homeId,
        reviewedOrigins: REVIEWED_ORIGINS,
        records: [evidence("response-a")],
      }),
      { revision: 1, changed: true, affectedThreadIds: ["thread-a"] },
    );
    assert.throws(
      () =>
        store.importRequestTimingEvidence({
          homeId,
          records: [evidence("response-a")],
        }),
      (error) => error.code === "REQUEST_TIMING_ORIGIN_UNREVIEWED",
    );
    assert.equal(readRequestTimingRevision(store.database), 1);
  } finally {
    store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("C1 · CLI requires explicit reviewed origins before it opens the database", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "request-timing-cli-review-"));
  try {
    const input = path.join(root, "records.json");
    const database = path.join(root, "usage.sqlite");
    await writeFile(
      input,
      JSON.stringify([
        evidence("response-a", {
          evidenceOrigin: "unauthenticated_candidate",
          admission: "certified",
          certified: true,
        }),
      ]),
      "utf8",
    );
    await assert.rejects(
      runImport(["--database", database, "--home", "home-a", "--input", input]),
      (error) => error.code === "REQUEST_TIMING_ORIGIN_UNREVIEWED",
    );
    await assert.rejects(
      runImport(["--database", database, "--home", "home-a", "--input", input, "--reviewed-origin", "another-origin"]),
      (error) => error.code === "REQUEST_TIMING_ORIGIN_UNREVIEWED",
    );
    assert.equal(existsSync(database), false, "review rejection must happen before the store is opened");

    assert.deepEqual(
      parseImportArgs([
        "--database",
        database,
        "--home",
        "home-a",
        "--input",
        input,
        "--reviewed-origin",
        "origin-a",
        "--reviewed-origin",
        "origin-b",
      ]).reviewedOrigins,
      ["origin-a", "origin-b"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("C1 · unknown and ambiguous native links reject the batch without changing evidence or dirty state", async () => {
  const fixture = await makeCodexStoreFixture([
    { threadId: "thread-a", responseId: "response-shared" },
    { threadId: "thread-b", responseId: "response-shared" },
  ]);
  const { store, homeId } = fixture;
  try {
    assert.throws(
      () =>
        store.importRequestTimingEvidence({
          homeId,
          records: [evidence("response-shared")],
          reviewedOrigins: REVIEWED_ORIGINS,
        }),
      (error) => error.code === "REQUEST_TIMING_THREAD_CONFLICT",
    );
    assert.equal(readRequestTimingRevision(store.database), 0);
    assert.deepEqual(store.requestTimingDirtyThreads(homeId), []);
    assert.equal(store.lookupRequestTiming({ homeId, responseId: "response-shared" }).state, "missing");

    assert.throws(
      () =>
        store.importRequestTimingEvidence({
          homeId,
          records: [evidence("response-unknown")],
          reviewedOrigins: REVIEWED_ORIGINS,
        }),
      (error) => error.code === "REQUEST_TIMING_LINK_MISSING",
    );
    assert.equal(readRequestTimingRevision(store.database), 0);
    assert.deepEqual(store.requestTimingDirtyThreads(homeId), []);
  } finally {
    store.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
