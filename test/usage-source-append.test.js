import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, open, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { discoverUsageSources } from "../src/usage-core.js";
import { UsageSourceProof } from "../src/usage-source-proof.js";
import { UsageStore } from "../src/usage-store.js";

const START = Date.parse("2026-11-03T01:00:00.000Z");
const SOURCE_WORK_KEYS = ["appendedFiles", "journalBytes", "parsedBytes", "prefixBytesRead", "replacedFiles", "sourceRetries"];

class ShaOnlySourceProof extends UsageSourceProof {
  async provider() {
    return null;
  }
}

function deterministicRepository(cwd) {
  return { key: `directory:${cwd}`, path: cwd, kind: "directory" };
}

function storeOptions(root, databaseFile) {
  return {
    homeDir: root,
    databaseFile,
    env: {},
    importDirs: [],
  };
}

function createStore(root, databaseFile, proof = null) {
  const store = new UsageStore(storeOptions(root, databaseFile));
  store.repositoryResolver = deterministicRepository;
  if (proof) store.sourceProof = proof;
  return store;
}

async function tempRoot(t, prefix) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
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

function codexMeta(timestamp, sessionId, modelProvider = "openai") {
  return {
    timestamp,
    type: "session_meta",
    payload: {
      id: sessionId,
      source: "cli",
      originator: "codex-tui",
      cwd: "/work/append",
      model_provider: modelProvider,
    },
  };
}

function turnContext(model) {
  return { type: "turn_context", payload: { model } };
}

function tokenRow(timestamp, cumulative, last, { usedPercent = 100, credits = true } = {}) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage(cumulative),
        last_token_usage: usage(last),
      },
      rate_limits: {
        limit_id: "codex",
        credits: { has_credits: credits },
        primary: {
          used_percent: usedPercent,
          window_minutes: 300,
          resets_at: Date.parse("2026-11-03T08:00:00.000Z") / 1000,
        },
      },
    },
  };
}

async function codexFixture(t, options = {}) {
  const root = await tempRoot(t, "usage-source-append-codex-");
  const sessionDir = path.join(root, ".codex", "sessions", "2026", "11", "03");
  await mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, options.fileName || "rollout-append.jsonl");
  return {
    root,
    filePath,
    databaseFile: path.join(root, "usage-index.sqlite"),
    oracleFile: path.join(root, "oracle.sqlite"),
  };
}

function factRows(database, table, excluded = []) {
  const ignored = new Set(excluded);
  const columns = database
    .prepare(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
    .all()
    .map((row) => String(row.name))
    .filter((name) => !ignored.has(name));
  const quoted = columns.map((column) => `"${column.replaceAll('"', '""')}"`);
  return database
    .prepare(`SELECT ${quoted.join(", ")} FROM "${table}" ORDER BY ${quoted.join(", ")}`)
    .all()
    .map((row) => ({ ...row }));
}

function factSnapshot(store) {
  return {
    events: factRows(store.database, "events", ["id"]),
    rateLimitObservations: factRows(store.database, "rate_limit_observations"),
    quotaUsageSources: factRows(store.database, "quota_usage_sources"),
  };
}

function assertSourceWork(store, expected) {
  const work = store.lastSyncSourceWork;
  assert.ok(work, "sync must publish lastSyncSourceWork");
  assert.deepEqual(Object.keys(work).sort(), SOURCE_WORK_KEYS);
  assert.equal(work.sourceRetries, 0, "uncontended source work must not retry");
  for (const key of SOURCE_WORK_KEYS) {
    assert.equal(typeof work[key], "number", `${key} must be an aggregate byte/file count`);
    assert.ok(Number.isFinite(work[key]) && work[key] >= 0, `${key} must be finite and non-negative`);
  }
  for (const [key, value] of Object.entries(expected)) assert.equal(work[key], value, key);
}

function progressFor(store, filePath) {
  const row = store.database
    .prepare("SELECT checkpoint_json AS checkpointJson FROM usage_source_progress WHERE source_path=?")
    .get(filePath);
  return row ? JSON.parse(row.checkpointJson) : null;
}

async function freshOracle(fixture) {
  const oracle = createStore(fixture.root, `${fixture.oracleFile}.${Date.now()}-${Math.random()}`);
  try {
    await oracle.sync();
    return factSnapshot(oracle);
  } finally {
    oracle.close();
  }
}

async function sourceFile(store, root, filePath) {
  const homes = await discoverUsageSources(storeOptions(root, store.databaseFile));
  const home = homes.find((candidate) => filePath.startsWith(candidate.path));
  assert.ok(home, `fixture source not discovered for ${filePath}`);
  return { filePath, source: home, info: await stat(filePath) };
}

function boundedProof() {
  const state = {
    verifyMode: "accept",
    failCapture: false,
    verifyCalls: 0,
    captureCalls: 0,
  };
  return {
    state,
    async begin() {
      return { kind: "fixture-fence", journalBytes: 11 };
    },
    async verify(_filePath, _validation, offset, info) {
      state.verifyCalls += 1;
      if (state.verifyMode === "reject") return null;
      return {
        kind: "fixture-bounded-v1",
        offset,
        info,
        readBytes: 3,
        journalBytes: 5,
      };
    },
    async capture(_filePath, offset, info) {
      state.captureCalls += 1;
      if (state.failCapture) throw new Error("bounded capture failure");
      return {
        validation: {
          kind: "fixture-bounded-v1",
          offset,
          identity: `fixture:${info.size}`,
        },
        readBytes: 2,
        journalBytes: 7,
      };
    },
    close() {},
  };
}

test("Codex SHA-only append preserves cumulative/quota facts and handles EOF tails", async (t) => {
  const fixture = await codexFixture(t);
  const initialText = jsonl([
    codexMeta("2026-11-03T01:00:00.000Z", "codex-append"),
    turnContext("gpt-5.1-codex"),
    tokenRow("2026-11-03T01:01:00.000Z", 100, 100, { usedPercent: 100, credits: true }),
  ]);
  await writeFile(fixture.filePath, initialText);

  const proof = new ShaOnlySourceProof();
  const store = createStore(fixture.root, fixture.databaseFile, proof);
  try {
    await store.sync();
    assert.ok(progressFor(store, fixture.filePath), "initial parse must save a proof-backed checkpoint");

    const appendText = jsonl([
      turnContext("gpt-5.1-codex-mini"),
      tokenRow("2026-11-03T01:02:00.000Z", 160, 60, { usedPercent: 20, credits: true }),
    ]);
    await appendFile(fixture.filePath, appendText);
    const appended = await store.sync();
    assert.equal(appended.updatedFileCount, 1);
    assert.equal(store.lastSyncRollupWork.applied, true);
    assert.equal(store.lastSyncRollupWork.readEvents, 1, "real sync must maintain daily rollups from the new row");
    store.prepareHotRollups();
    assert.equal(store.lastRollupWork.readEvents, 0, "the subsequent query must not recertify old facts");
    assertSourceWork(store, {
      appendedFiles: 1,
      replacedFiles: 0,
      parsedBytes: Buffer.byteLength(appendText),
    });
    assert.equal(
      store.lastSyncSourceWork.prefixBytesRead,
      2 * Buffer.byteLength(initialText) + Buffer.byteLength(appendText),
      "SHA accounting includes verification before and after parsing plus new-suffix capture",
    );
    assert.equal(store.lastSyncSourceWork.journalBytes, 0);
    assert.deepEqual(factSnapshot(store), await freshOracle(fixture));
    assert.deepEqual(
      store.database
        .prepare("SELECT quota_source FROM quota_usage_sources ORDER BY timestamp_ms")
        .all()
        .map((row) => row.quota_source),
      ["credits", "plan"],
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM rate_limit_observations").get().n, 2);

    const undelimited = JSON.stringify(
      tokenRow("2026-11-03T01:03:00.000Z", 190, 30, { usedPercent: 10, credits: true }),
    );
    await appendFile(fixture.filePath, undelimited);
    await store.sync();
    assert.deepEqual(factSnapshot(store), await freshOracle(fixture));
    assert.equal(progressFor(store, fixture.filePath), null, "a valid undelimited row is not a safe cursor");

    await appendFile(fixture.filePath, "\n");
    await store.sync();
    assert.ok(progressFor(store, fixture.filePath), "terminating the row restores a safe checkpoint");

    const partialLine = JSON.stringify(
      tokenRow("2026-11-03T01:04:00.000Z", 220, 30, { usedPercent: 9, credits: false }),
    );
    const splitAt = 36;
    const beforeInvalidTail = factSnapshot(store);
    const checkpointBeforeTail = progressFor(store, fixture.filePath);
    await appendFile(fixture.filePath, partialLine.slice(0, splitAt));
    await store.sync();
    assert.deepEqual(factSnapshot(store), beforeInvalidTail);
    assert.deepEqual(progressFor(store, fixture.filePath), checkpointBeforeTail);

    await appendFile(fixture.filePath, `${partialLine.slice(splitAt)}\n`);
    await store.sync();
    assert.deepEqual(factSnapshot(store), await freshOracle(fixture));
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n, 4);
  } finally {
    store.close();
  }
});

test("DSH multi-frame append matches a new database full parse", async (t) => {
  const root = await tempRoot(t, "usage-source-append-dsh-");
  const sessionDir = path.join(root, ".dsh", "sessions", "fixture", "dsh-append");
  await mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, "session.v4.jsonl.zstd");
  const databaseFile = path.join(root, "usage-index.sqlite");
  const oracleFile = path.join(root, "oracle.sqlite");

  const session = {
    type: "session",
    version: 4,
    id: "dsh-append",
    cwd: "E:\\work\\dsh-append",
    createdAt: START,
    delegationDepth: 0,
    agentPreset: "standard",
  };
  const request = (model, provider) => ({
    type: "request/header",
    time: START + 1,
    data: { header: { config: { model, provider } } },
  });
  const assistant = (seq, outputTokens) => ({
    type: "assistant/message",
    seq,
    time: START + seq * 1000,
    data: {
      turn: 1,
      step: seq,
      usage: {
        inputTokens: 10,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        outputTokens,
        totalTokens: 12 + outputTokens,
      },
    },
  });
  const frame = (rows) => zstdCompressSync(Buffer.from(jsonl(rows), "utf8"));
  const initialFrames = Buffer.concat([
    frame([session]),
    frame([request("deepseek-flash", "provider-a"), assistant(1, 7)]),
  ]);
  await writeFile(filePath, initialFrames);

  const store = createStore(root, databaseFile, new ShaOnlySourceProof());
  try {
    await store.sync();
    assert.equal(progressFor(store, filePath)?.adapter, "dsh-v4-zstd");

    const suffix = Buffer.concat([
      frame([
        request("deepseek-v4-pro", "provider-b"),
        {
          type: "session/title",
          time: START + 2000,
          data: { title: "Appended title" },
        },
        assistant(2, 11),
      ]),
      frame([assistant(3, 13)]),
    ]);
    await appendFile(filePath, suffix);
    const result = await store.sync();
    assert.equal(store.lastSyncRollupWork.applied, true);
    assert.equal(store.lastSyncRollupWork.readEvents, 2, "DSH sync must use the same incremental rollup path");
    assert.equal(result.updatedFileCount, 1);
    assertSourceWork(store, {
      appendedFiles: 1,
      replacedFiles: 0,
      parsedBytes: suffix.length,
    });
    assert.equal(
      store.lastSyncSourceWork.prefixBytesRead,
      2 * initialFrames.length + suffix.length,
      "DSH SHA accounting includes verification before and after parsing plus new-suffix capture",
    );

    const oracle = createStore(root, oracleFile);
    let full;
    try {
      await oracle.sync();
      full = factSnapshot(oracle);
    } finally {
      oracle.close();
    }
    assert.deepEqual(factSnapshot(store), full);
    assert.deepEqual(
      store.database
        .prepare("SELECT model, output FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => ({ ...row })),
      [
        { model: "deepseek-flash", output: 7 },
        { model: "deepseek-v4-pro", output: 11 },
        { model: "deepseek-v4-pro", output: 13 },
      ],
    );
    assert.equal(progressFor(store, filePath).offset, (await stat(filePath)).size);
  } finally {
    store.close();
  }
});

test("middle revision plus append and shorter same-path replacement require full fallback", async (t) => {
  const fixture = await codexFixture(t);
  const initialText = jsonl([
    codexMeta("2026-11-03T02:00:00.000Z", "revision-session"),
    turnContext("gpt-5.1-codex"),
    tokenRow("2026-11-03T02:01:00.000Z", 100, 100),
  ]);
  await writeFile(fixture.filePath, initialText);
  const before = await stat(fixture.filePath);
  const store = createStore(fixture.root, fixture.databaseFile, new ShaOnlySourceProof());

  try {
    await store.sync();
    const bytes = await readFile(fixture.filePath);
    const modelAt = bytes.indexOf(Buffer.from("gpt-5.1-codex", "utf8"));
    assert.notEqual(modelAt, -1);
    const handle = await open(fixture.filePath, "r+");
    try {
      await handle.write(Buffer.from("6"), 0, 1, modelAt + 4);
    } finally {
      await handle.close();
    }
    await appendFile(fixture.filePath, jsonl([tokenRow("2026-11-03T02:02:00.000Z", 150, 50)]));
    await utimes(fixture.filePath, before.atime, before.mtime);

    await store.sync();
    assertSourceWork(store, {
      appendedFiles: 0,
      replacedFiles: 1,
      parsedBytes: (await stat(fixture.filePath)).size,
    });
    assert.ok(store.lastSyncSourceWork.prefixBytesRead > 0);
    assert.deepEqual(factSnapshot(store), await freshOracle(fixture));

    const replacement = jsonl([
      codexMeta("2026-11-03T03:00:00.000Z", "replacement-session"),
      turnContext("gpt-6-sol"),
      tokenRow("2026-11-03T03:01:00.000Z", 77, 77),
    ]);
    await writeFile(fixture.filePath, replacement);
    await store.sync();
    assertSourceWork(store, {
      appendedFiles: 0,
      replacedFiles: 1,
      parsedBytes: Buffer.byteLength(replacement),
    });
    assert.deepEqual(factSnapshot(store), await freshOracle(fixture));
    assert.deepEqual(
      store.database
        .prepare("SELECT DISTINCT session_id FROM events")
        .all()
        .map((row) => row.session_id),
      ["replacement-session"],
    );
    assert.equal(progressFor(store, fixture.filePath).offset, Buffer.byteLength(replacement));
  } finally {
    store.close();
  }
});

test("reverse discovery, earlier-file revision, and crash restart preserve durable downstream reparse", async (t) => {
  const root = await tempRoot(t, "usage-source-append-dependencies-");
  const sessionDir = path.join(root, ".codex", "sessions", "2026", "11", "03");
  await mkdir(sessionDir, { recursive: true });
  const downstream = path.join(sessionDir, "a-downstream.jsonl");
  const upstream = path.join(sessionDir, "z-upstream.jsonl");
  const databaseFile = path.join(root, "usage-index.sqlite");
  const revisionText = jsonl([
    codexMeta("2026-11-03T04:00:00.000Z", "shared-session"),
    turnContext("gpt-5.1-codex"),
    tokenRow("2026-11-03T04:01:00.000Z", 150, 150),
  ]);
  await writeFile(
    downstream,
    jsonl([
      codexMeta("2026-11-03T04:00:00.000Z", "shared-session"),
      turnContext("gpt-5.1-codex"),
      tokenRow("2026-11-03T04:02:00.000Z", 200, 100),
    ]),
  );
  await writeFile(
    upstream,
    jsonl([
      codexMeta("2026-11-03T04:00:00.000Z", "shared-session"),
      turnContext("gpt-5.1-codex"),
      tokenRow("2026-11-03T04:01:00.000Z", 100, 100),
    ]),
  );

  let store = createStore(root, databaseFile, new ShaOnlySourceProof());
  try {
    await store.sync();
    assert.deepEqual(
      store.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => row.total),
      [100, 100],
      "reverse discovery must settle unchanged downstream facts before sync returns",
    );
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM usage_source_reparse").get().n, 0);

    await writeFile(
      upstream,
      `${revisionText}${jsonl([{ type: "note", timestamp: "2026-11-03T04:01:30.000Z", text: "revision" }])}`,
    );
    const upstreamSource = await sourceFile(store, root, upstream);
    await store.replaceFile(upstreamSource, { progress: true });
    assert.deepEqual(
      store.database
        .prepare("SELECT source_path FROM usage_source_reparse")
        .all()
        .map((row) => row.source_path),
      [downstream],
      "the changed earlier file must durably mark its unchanged downstream file",
    );
    store.close();

    store = createStore(root, databaseFile, new ShaOnlySourceProof());
    await store.sync();
    assertSourceWork(store, { appendedFiles: 0 });
    assert.ok(store.lastSyncSourceWork.replacedFiles >= 1, "the durable downstream reparse must run after restart");
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM usage_source_reparse").get().n, 0);
    assert.deepEqual(
      store.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => row.total),
      [150, 50],
    );

    const oracle = createStore(root, path.join(root, "oracle.sqlite"));
    let expected;
    try {
      await oracle.open();
      const source = await sourceFile(oracle, root, upstream);
      const downstreamSource = await sourceFile(oracle, root, downstream);
      await oracle.replaceFile(source, { progress: false });
      await oracle.replaceFile(downstreamSource, { progress: false });
      expected = factSnapshot(oracle);
    } finally {
      oracle.close();
    }
    assert.deepEqual(factSnapshot(store), expected);
  } finally {
    store.close();
  }
});

test("bounded sourceProof injection covers append, verification fallback, and transaction rollback", async (t) => {
  const fixture = await codexFixture(t);
  await writeFile(
    fixture.filePath,
    jsonl([
      codexMeta("2026-11-03T05:00:00.000Z", "proof-session"),
      turnContext("gpt-5.1-codex"),
      tokenRow("2026-11-03T05:01:00.000Z", 100, 100),
    ]),
  );
  const proof = boundedProof();
  const store = createStore(fixture.root, fixture.databaseFile, proof);

  try {
    await store.sync();
    const firstAppend = jsonl([tokenRow("2026-11-03T05:02:00.000Z", 130, 30)]);
    await appendFile(fixture.filePath, firstAppend);
    await store.sync();
    assertSourceWork(store, {
      appendedFiles: 1,
      replacedFiles: 0,
      parsedBytes: Buffer.byteLength(firstAppend),
    });
    assert.ok(store.lastSyncSourceWork.prefixBytesRead > 0);
    assert.ok(store.lastSyncSourceWork.journalBytes > 0);
    assert.ok(proof.state.verifyCalls > 0);
    assert.deepEqual(factSnapshot(store), await freshOracle(fixture));

    const secondAppend = jsonl([tokenRow("2026-11-03T05:03:00.000Z", 170, 40)]);
    await appendFile(fixture.filePath, secondAppend);
    proof.state.verifyMode = "reject";
    await store.sync();
    assertSourceWork(store, {
      appendedFiles: 0,
      replacedFiles: 1,
      parsedBytes: (await stat(fixture.filePath)).size,
    });
    assert.deepEqual(factSnapshot(store), await freshOracle(fixture));

    const factsBeforeFailure = factSnapshot(store);
    const progressBeforeFailure = store.database
      .prepare("SELECT * FROM usage_source_progress WHERE source_path=?")
      .get(fixture.filePath);
    const revisionBeforeFailure = store.storeRevision;
    await appendFile(fixture.filePath, jsonl([tokenRow("2026-11-03T05:04:00.000Z", 220, 50)]));
    proof.state.verifyMode = "accept";
    proof.state.failCapture = true;
    const file = await sourceFile(store, fixture.root, fixture.filePath);
    await assert.rejects(store.replaceFile(file, { progress: true }), /bounded capture failure/);

    assert.deepEqual(factSnapshot(store), factsBeforeFailure);
    assert.deepEqual(
      store.database.prepare("SELECT * FROM usage_source_progress WHERE source_path=?").get(fixture.filePath),
      progressBeforeFailure,
    );
    assert.equal(store.storeRevision, revisionBeforeFailure);
    assert.equal(store.database.isTransaction, false);
    assert.equal(store.writeTransactionDepth, 0);
  } finally {
    store.close();
  }
});

test("missing cumulative dependencies block publication and resume after the retained source returns", async (t) => {
  const root = await tempRoot(t, "source-dependency-unavailable-");
  const directory = path.join(root, ".codex", "sessions");
  await mkdir(directory, { recursive: true });
  const upstream = path.join(directory, "a.jsonl"),
    downstream = path.join(directory, "b.jsonl");
  const text = (total, minute, last) =>
    jsonl([
      codexMeta("2026-11-03T04:00:00.000Z", "retained-dependent"),
      turnContext("gpt-5.1-codex"),
      tokenRow(`2026-11-03T04:0${minute}:00.000Z`, total, last),
    ]);
  await writeFile(upstream, text(100, 1, 100));
  const retained = text(200, 2, 100);
  await writeFile(downstream, retained);
  const database = path.join(root, "facts.sqlite");
  let store = createStore(root, database, new ShaOnlySourceProof());
  const pending = { code: "SOURCE_DEPENDENCY_PENDING" };
  try {
    await store.sync();
    assert.equal(store.summarize({ preset: "all" }).totals.total, 200);
    await rm(downstream);
    await writeFile(upstream, text(150, 1, 150));
    await assert.rejects(store.sync(), pending);
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM events").get().n, 2, "missing facts stay retained");
    assert.throws(() => store.metadata(), pending);
    assert.throws(() => store.summarize({ preset: "all" }), pending);
    assert.throws(() => store.periodComparison(), pending);
    assert.throws(() => store.publishedUsageEvents(), pending);
    await assert.rejects(store.dashboardHistory({ preset: "all" }), pending);
    store.close();
    store = createStore(root, database, new ShaOnlySourceProof());
    await assert.rejects(store.sync(), pending);
    await writeFile(downstream, retained);
    await store.sync();
    assert.equal(store.database.prepare("SELECT COUNT(*) n FROM usage_source_reparse").get().n, 0);
    assert.equal(store.summarize({ preset: "all" }).totals.total, 200);
    assert.deepEqual(
      store.database
        .prepare("SELECT total FROM events ORDER BY timestamp_ms")
        .all()
        .map((row) => row.total),
      [150, 50],
    );
  } finally {
    store.close();
  }
});
