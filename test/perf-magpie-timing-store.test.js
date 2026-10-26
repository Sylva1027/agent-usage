import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";

function rollout(threadId, responseId, outputTokens = 100, model = "model-a") {
  return [
    {
      type: "session_meta",
      payload: { id: threadId, session_id: threadId, source: "cli", originator: "codex-tui" },
    },
    {
      type: "turn_context",
      payload: { thread_id: threadId, turn_id: `turn-${threadId}`, model, effort: "high" },
    },
    {
      type: "token_usage_record",
      timestamp: "2026-10-21T00:00:02.000Z",
      payload: {
        thread_id: threadId,
        turn_id: `turn-${threadId}`,
        response_id: responseId,
        usage: { output_tokens: outputTokens },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: threadId,
        turn_id: `turn-${threadId}`,
        item: { id: `item-${threadId}`, type: "AgentMessage" },
        started_at_ms: 1_800_000_000_000,
        completed_at_ms: 1_800_000_000_500,
      },
    },
    { type: "event_msg", payload: { type: "task_complete", thread_id: threadId, turn_id: `turn-${threadId}` } },
  ];
}

function ledgerRow(responseId, overrides = {}) {
  return {
    agent: "codex",
    provider: "codex",
    req: "codex/model-a",
    model: "model-a",
    response_id: responseId,
    status: 200,
    ms: 2_000,
    out: 100,
    stop: "completed",
    ep: "/backend-api/codex/responses",
    ...overrides,
  };
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "magpie-store-"));
  const homePath = path.join(root, "CodexHome");
  const sessions = path.join(homePath, "sessions", "2026", "10");
  await mkdir(sessions, { recursive: true });
  const filePath = path.join(sessions, "rollout-thread-a.jsonl");
  await writeFile(
    filePath,
    `${rollout("thread-a", "response-a")
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  const ledgerPath = path.join(root, ".config", "magpie", "usage.jsonl");
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  const options = {
    homeDir: root,
    databaseFile: path.join(root, "usage-index.sqlite"),
    env: {},
    extraHomes: homePath,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
  return { root, homePath, filePath, ledgerPath, options, store: new UsageStore(options) };
}

async function writeLedger(filePath, rows) {
  await writeFile(filePath, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

function evidenceCount(store) {
  return Number(store.database.prepare("SELECT COUNT(*) AS n FROM perf_request_timing_evidence").get().n);
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

test("Magpie auto-import handles no-op, late ledger/native arrival, aliases, and conflicts", async () => {
  const f = await fixture();
  const { store } = f;
  try {
    await writeLedger(f.ledgerPath, []);
    await store.sync();
    const home = store.homes.find((entry) => entry.kind === "extra");
    assert.ok(home, "the extra home must retain its raw kind");
    const homeId = String(home.id);
    assert.equal(evidenceCount(store), 0);

    await writeLedger(f.ledgerPath, [ledgerRow("response-a")]);
    await store.sync();
    assert.equal(evidenceCount(store), 1);
    assert.equal(sampleDuration(store, homeId, "thread-a"), 2_000);

    const calls = { records: 0, imports: 0 };
    const recordsForRequest = store.magpieRequestTimings.recordsForRequest.bind(store.magpieRequestTimings);
    store.magpieRequestTimings.recordsForRequest = (...args) => {
      calls.records += 1;
      return recordsForRequest(...args);
    };
    const importTiming = store.importRequestTimingEvidence.bind(store);
    store.importRequestTimingEvidence = (...args) => {
      calls.imports += 1;
      return importTiming(...args);
    };
    const version = store.readMeta("perf_index_version");
    await store.sync();
    assert.deepEqual(calls, { records: 0, imports: 0 });
    assert.equal(store.readMeta("perf_index_version"), version);

    store.magpieRequestTimings.recordsForRequest = recordsForRequest;
    store.importRequestTimingEvidence = importTiming;
    await appendFile(f.ledgerPath, `${JSON.stringify(ledgerRow("response-a", { ms: 3_000 }))}\n`);
    await store.sync();
    assert.equal(
      store.lookupRequestTiming({ homeId, responseId: "response-a" }).state,
      "conflict",
      "a same-origin duration conflict must invalidate the old speed",
    );
    assert.equal(sampleDuration(store, homeId, "thread-a"), null);

    store.database
      .prepare(
        `INSERT INTO perf_request_timing_evidence
           (home_id, evidence_origin, response_id, variant_key, schema_version,
            requested_model, reported_output_tokens, duration_ms, status, completed_at_ms)
         VALUES (?, 'foreign-origin', 'response-a', 'foreign', 1, 'model-a', 100, 4000, 'completed', NULL)`,
      )
      .run(homeId);
    const foreignCount = evidenceCount(store);
    await store.sync();
    assert.equal(evidenceCount(store), foreignCount, "foreign-origin evidence must not be duplicated");
  } finally {
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Magpie retries a failed home after the native projection becomes trusted", async () => {
  const f = await fixture();
  const { store } = f;
  try {
    await writeLedger(f.ledgerPath, [ledgerRow("response-a")]);
    const original = store.magpieRequestTimings.recordsForRequest.bind(store.magpieRequestTimings);
    let fail = true;
    store.magpieRequestTimings.recordsForRequest = (...args) => {
      if (fail) throw new Error("injected ledger failure");
      return original(...args);
    };
    await store.sync();
    assert.equal(evidenceCount(store), 0);
    assert.equal(
      store.warnings.some((warning) => String(warning).startsWith("MAGPIE_TIMING_IMPORT_FAILED:")),
      true,
    );

    fail = false;
    await store.sync();
    assert.equal(evidenceCount(store), 1);
    assert.equal(store.magpieTimingPublication, `${store.fingerprint}\u0000${store.readMeta("perf_index_version")}`);
  } finally {
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Magpie skips a home until its published projection arrives, then imports without ledger changes", async () => {
  const f = await fixture();
  const { store } = f;
  try {
    await writeLedger(f.ledgerPath, [ledgerRow("response-a")]);
    const importTiming = store.importRequestTimingEvidence.bind(store);
    let failOnce = true;
    store.importRequestTimingEvidence = (...args) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("injected native mapping failure");
      }
      return importTiming(...args);
    };
    await store.sync();
    assert.equal(evidenceCount(store), 0);
    await store.sync();
    assert.equal(evidenceCount(store), 1);
  } finally {
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Magpie imports canonical projection paths with original-case ownership", async () => {
  const f = await fixture();
  const { store } = f;
  try {
    await writeLedger(f.ledgerPath, [ledgerRow("response-a")]);
    const original = store.importRequestTimingEvidence.bind(store);
    let savedProjection;
    store.importRequestTimingEvidence = (input) => {
      const row = store.database.prepare("SELECT path, projection FROM perf_codex_projections LIMIT 1").get();
      savedProjection = row && { ...row };
      store.database.prepare("UPDATE perf_codex_projections SET path = lower(path)").run();
      return original(input);
    };
    await store.sync();
    assert.equal(evidenceCount(store), 1);
    assert.ok(savedProjection, "fixture must have a persisted projection");
    store.database.prepare("UPDATE perf_codex_projections SET path = ?").run(savedProjection.path);
  } finally {
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Magpie imports a ledger that arrives after the published native projection", async () => {
  const f = await fixture();
  const { store } = f;
  try {
    await store.sync();
    assert.equal(evidenceCount(store), 0);
    await writeLedger(f.ledgerPath, [ledgerRow("response-a", { ms: 2_500 })]);
    await store.sync();
    assert.equal(evidenceCount(store), 1);
    const home = store.homes.find((entry) => entry.kind === "extra");
    assert.equal(sampleDuration(store, String(home.id), "thread-a"), 2_500);
  } finally {
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Magpie ignores non-Codex models and requires an exact native model alias", async () => {
  const f = await fixture();
  const { store } = f;
  try {
    await writeLedger(f.ledgerPath, [ledgerRow("response-a", { req: "other/model-a", provider: "other" })]);
    await store.sync();
    assert.equal(evidenceCount(store), 1);
    const home = store.homes.find((entry) => entry.kind === "extra");
    assert.equal(store.lookupRequestTiming({ homeId: String(home.id), responseId: "response-a" }).state, "available");
    assert.equal(
      store.database
        .prepare("SELECT requested_model FROM perf_request_timing_evidence WHERE response_id = 'response-a'")
        .get().requested_model,
      "other/model-a",
    );
  } finally {
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Magpie does not read a missing ledger from the real home", async () => {
  const f = await fixture();
  const { store } = f;
  try {
    await rm(f.ledgerPath, { force: true });
    await store.sync();
    assert.equal(store.magpieTimingLoaded, false);
    assert.equal(evidenceCount(store), 0);
    assert.equal(store.magpieRequestTimings.requests.size, 0);
  } finally {
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
