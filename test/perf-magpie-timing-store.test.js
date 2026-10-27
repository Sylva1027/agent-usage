import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
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

test("Magpie delta associates only changed requests and publishes without a second native round", async () => {
  const f = await fixture();
  const store = f.store;
  try {
    const other = path.join(path.dirname(f.filePath), "rollout-thread-b.jsonl");
    await writeFile(other, `${rollout("thread-b", "response-b").map(JSON.stringify).join("\n")}\n`);
    await writeLedger(f.ledgerPath, [ledgerRow("response-a"), ledgerRow("response-b")]);
    await store.sync();
    const homeId = String(store.homes.find((entry) => entry.kind === "extra").id);
    const unchangedThread = store.nativeTimingThreads.get(homeId).get("thread-b");
    let rounds = 0;
    const round = store.syncRound.bind(store);
    store.syncRound = (...args) => {
      rounds += 1;
      return round(...args);
    };
    const seen = [];
    const records = store.magpieRequestTimings.recordsForRequest.bind(store.magpieRequestTimings);
    store.magpieRequestTimings.recordsForRequest = (...args) => {
      seen.push(args[0]);
      return records(...args);
    };
    await appendFile(f.ledgerPath, `${JSON.stringify(ledgerRow("response-a", { ms: 3000 }))}\n`);
    await store.sync();
    assert.equal(rounds, 1);
    assert.deepEqual(seen, ["response-a"]);
    assert.equal(store.nativeTimingThreads.get(homeId).get("thread-b"), unchangedThread);
    assert.equal(sampleDuration(store, homeId, "thread-a"), null);
    assert.equal(sampleDuration(store, homeId, "thread-b"), 2000);
    assert.equal(store.requestTimingDirtyThreadCount(), 0);
    assert.deepEqual(store.magpieRequestTimings.pendingChanges().responseIds, new Set());
  } finally {
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Magpie directed timing publication matches the complete native-round reference", async () => {
  const f = await fixture();
  const reference = new UsageStore({ ...f.options, databaseFile: path.join(f.root, "reference.sqlite") });
  reference.publishMagpieRequestTimings = () => false;
  try {
    await writeLedger(f.ledgerPath, []);
    await f.store.sync();
    await reference.sync();
    await writeLedger(f.ledgerPath, [ledgerRow("response-a")]);
    await f.store.sync();
    await reference.sync();
    await appendFile(f.ledgerPath, `${JSON.stringify(ledgerRow("response-a", { ms: 3000 }))}\n`);
    await f.store.sync();
    await reference.sync();
    for (const table of [
      "events",
      "perf_samples",
      "perf_sample_sources",
      "perf_rollout_threads",
      "history_replaced_facts",
    ]) {
      const rows = (store) =>
        store.database
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) => {
            const copy = { ...row };
            delete copy.recorded_at;
            return copy;
          });
      assert.deepEqual(rows(f.store), rows(reference), table);
    }
    const normalize = (summary) => {
      const result = structuredClone(summary);
      delete result.generatedAt;
      delete result.perf.indexedAt;
      delete result.perf.meta.indexedAt;
      return result;
    };
    const filters = { preset: "all", now: new Date("2026-10-26T12:00:00Z") };
    assert.deepEqual(normalize(await f.store.summarize(filters)), normalize(await reference.summarize(filters)));
  } finally {
    f.store.close();
    reference.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Magpie directed rollback preserves pending evidence and retries without new ledger bytes", async () => {
  const f = await fixture();
  const store = f.store;
  try {
    await writeLedger(f.ledgerPath, []);
    const initial = await store.sync();
    const homeId = String(store.homes.find((entry) => entry.kind === "extra").id);
    const before = sampleDuration(store, homeId, "thread-a");
    const publish = store.publishMagpieRequestTimings.bind(store);
    const writeMeta = store.writeMeta.bind(store);
    store.publishMagpieRequestTimings = () => {
      store.writeMeta = (key, value) => {
        if (key === "perf_index_version") throw new Error("injected directed publication failure");
        return writeMeta(key, value);
      };
      try {
        return publish();
      } finally {
        store.writeMeta = writeMeta;
      }
    };
    await writeLedger(f.ledgerPath, [ledgerRow("response-a")]);
    const failed = await store.sync();
    assert.equal(failed.magpieTimingFingerprint, initial.magpieTimingFingerprint);
    assert.equal(sampleDuration(store, homeId, "thread-a"), before);
    assert.equal(store.requestTimingDirtyThreadCount(), 1);
    assert.ok(store.magpieRequestTimings.pendingChanges().responseIds.has("response-a"));
    store.publishMagpieRequestTimings = publish;
    const retried = await store.sync();
    assert.notEqual(retried.magpieTimingFingerprint, initial.magpieTimingFingerprint);
    assert.equal(store.requestTimingDirtyThreadCount(), 0);
    assert.equal(sampleDuration(store, homeId, "thread-a"), 2000);
  } finally {
    store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Magpie publishes same-cycle native plus ledger and late native-only mappings", async () => {
  const f = await fixture();
  try {
    await writeLedger(f.ledgerPath, [ledgerRow("response-a"), ledgerRow("response-b")]);
    let rounds = 0;
    const round = f.store.syncRound.bind(f.store);
    f.store.syncRound = (...args) => {
      rounds += 1;
      return round(...args);
    };
    const initial = await f.store.sync();
    const homeId = String(f.store.homes.find((entry) => entry.kind === "extra").id);
    assert.equal(initial.updatedFileCount, 1);
    assert.equal(sampleDuration(f.store, homeId, "thread-a"), 2000);
    assert.equal(rounds, 1, "a new native request and its ledger evidence publish in one discovery round");
    const other = path.join(path.dirname(f.filePath), "rollout-thread-b.jsonl");
    await writeFile(
      other,
      `${rollout("thread-b", "response-b")
        .map((row) => JSON.stringify(row))
        .join("\n")}\n`,
    );
    const next = await f.store.sync();
    assert.equal(next.updatedFileCount, 1);
    assert.equal(sampleDuration(f.store, homeId, "thread-b"), 2000);
    assert.equal(rounds, 2, "native-only arrival reuses the ledger in the same cycle");
    assert.equal(f.store.requestTimingDirtyThreadCount(), 0);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Magpie rejects a publication context superseded by another connection", async () => {
  const f = await fixture();
  const other = new UsageStore(f.options);
  other.importMagpieRequestTimings = async () => false;
  try {
    await writeLedger(f.ledgerPath, []);
    await f.store.sync();
    const homeId = String(f.store.homes.find((entry) => entry.kind === "extra").id);
    const added = path.join(path.dirname(f.filePath), "rollout-thread-b.jsonl");
    const read = f.store.magpieRequestTimings.read.bind(f.store.magpieRequestTimings);
    let interleave = true;
    f.store.magpieRequestTimings.read = async (...args) => {
      if (interleave) {
        interleave = false;
        await writeFile(
          added,
          `${rollout("thread-b", "response-b")
            .map((row) => JSON.stringify(row))
            .join("\n")}\n`,
        );
        await other.sync();
        const warnings = other.readPublishedFileWarnings();
        warnings[added] = [{ sourceKind: "codex", homeId, code: "UNKEYABLE_RECORD", count: 1 }];
        other.writeMeta("perf_file_warnings", JSON.stringify(warnings));
      }
      return read(...args);
    };
    let rounds = 0;
    const round = f.store.syncRound.bind(f.store);
    f.store.syncRound = (...args) => {
      rounds += 1;
      return round(...args);
    };
    await writeLedger(f.ledgerPath, [ledgerRow("response-a")]);
    await f.store.sync();
    assert.equal(rounds, 2, "a stale context must fall back to the complete native round");
    assert.equal(f.store.readPublishedFileWarnings()[added][0].code, "UNKEYABLE_RECORD");
    assert.ok(f.store.readPublishedFileFingerprints()[added]);
    assert.equal(sampleDuration(f.store, homeId, "thread-a"), 2000);
    assert.equal(f.store.requestTimingDirtyThreadCount(), 0);
  } finally {
    other.close();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Magpie revalidates dependencies after building directed timing samples", async () => {
  const f = await fixture();
  try {
    await writeLedger(f.ledgerPath, []);
    await f.store.sync();
    const homeId = String(f.store.homes.find((entry) => entry.kind === "extra").id);
    const lookup = f.store.lookupRequestTiming.bind(f.store);
    let changed = false;
    f.store.lookupRequestTiming = (query) => {
      if (!changed) {
        changed = true;
        writeFileSync(
          f.filePath,
          `${rollout("thread-a", "response-a", 999)
            .map((row) => JSON.stringify(row))
            .join("\n")}\n`,
        );
      }
      return lookup(query);
    };
    let rounds = 0;
    const round = f.store.syncRound.bind(f.store);
    f.store.syncRound = (...args) => {
      rounds += 1;
      return round(...args);
    };
    await writeLedger(f.ledgerPath, [ledgerRow("response-a")]);
    await f.store.sync();
    assert.equal(changed, true);
    assert.equal(rounds, 2, "a dependency changed during building must enter native recovery");
    assert.equal(
      sampleDuration(f.store, homeId, "thread-a"),
      null,
      "the stale output=100 denominator must not publish",
    );
    assert.equal(f.store.requestTimingDirtyThreadCount(), 0);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
