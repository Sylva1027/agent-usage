import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../../src/history-archive.js";
import { UsageStore } from "../../src/usage-store.js";

const SELF = fileURLToPath(import.meta.url);
const label = process.argv[3] === "child" ? "recovery" : process.argv[2] || "recovery";
assert.match(label, /^[a-z0-9-]+$/);
const OUTPUT_ROOT = path.resolve("output/c1-long-history-20261107", label);
const HEAP_ARGS = ["--max-old-space-size=224", "--max-semi-space-size=4"];
const AUTHORITY_META = "history_archive_event_authority";
const REVISION_META = "history_archive_event_revisions";
const COLD_TIMESTAMP = "2026-07-12T02:00:00.000Z";
const HOT_TIMESTAMP = "2026-07-12T02:01:00.000Z";
const COLD_MS = Date.parse(COLD_TIMESTAMP);
const HOT_MS = Date.parse(HOT_TIMESTAMP);

function discoveryOptions(root) {
  return { homeDir: root, env: {}, importDirs: [] };
}

function storeOptions(root, databaseName = "state.sqlite") {
  return {
    ...discoveryOptions(root),
    databaseFile: path.join(root, databaseName),
    automaticDiscoveryEnabled: false,
  };
}

async function openStore(root, databaseName = "state.sqlite") {
  const store = new UsageStore(storeOptions(root, databaseName));
  await store.open();
  return store;
}

function sourcePath(root) {
  return path.join(root, ".codex", "sessions", "2026", "07", "12", "rollout-c1-recovery.jsonl");
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

function tokenLine(timestamp, cumulativeTotal, lastTotal) {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage(cumulativeTotal),
        last_token_usage: usage(lastTotal),
      },
    },
  });
}

function sourceText(coldTotal, hotLastTotal) {
  const sessionMeta = {
    timestamp: COLD_TIMESTAMP,
    type: "session_meta",
    payload: {
      id: "c1-recovery-session",
      cwd: "/workspace/c1-recovery",
      source: "cli",
      originator: "codex-tui",
      model_provider: "openai",
    },
  };
  const turnContext = { type: "turn_context", payload: { model: "gpt-6-sol" } };
  return [
    JSON.stringify(sessionMeta),
    JSON.stringify(turnContext),
    tokenLine(COLD_TIMESTAMP, coldTotal, coldTotal),
    tokenLine(HOT_TIMESTAMP, coldTotal + hotLastTotal, hotLastTotal),
    "",
  ].join("\n");
}

async function writeSource(root, coldTotal, hotLastTotal) {
  const filePath = sourcePath(root);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, sourceText(coldTotal, hotLastTotal));
  const changedAt = new Date(Date.now() + 1000);
  await utimes(filePath, changedAt, changedAt);
  return filePath;
}

async function syncStore(store, root) {
  return store.sync({ options: discoveryOptions(root) });
}

function invalidateSource(store, filePath) {
  store.database
    .prepare("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE path = ?")
    .run(filePath);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileSha256(filePath) {
  return sha256(await readFile(filePath));
}

function manifestPath(databaseFile) {
  const parsed = path.parse(databaseFile);
  return path.join(parsed.dir, `${parsed.name}.manifest.json`);
}

async function packageHashes(candidateFile) {
  return {
    database: await fileSha256(candidateFile),
    manifest: await fileSha256(manifestPath(candidateFile)),
  };
}

function hotRows(store) {
  return store.database
    .prepare(
      `SELECT timestamp_ms, session_id, total, input, cached, output, reasoning
       FROM events ORDER BY timestamp_ms, id`,
    )
    .all()
    .map((row) => ({
      timestampMs: Number(row.timestamp_ms),
      sessionId: String(row.session_id),
      total: Number(row.total),
      input: Number(row.input),
      cached: Number(row.cached),
      output: Number(row.output),
      reasoning: Number(row.reasoning),
    }));
}

function revisionMeta(store) {
  const raw = store.readMetaRaw(REVISION_META);
  return raw === undefined ? null : JSON.parse(raw);
}

function authorityState(store) {
  const raw = store.readMetaRaw(AUTHORITY_META);
  return {
    authority: raw === undefined ? null : JSON.parse(raw),
    segments: store.database
      .prepare(
        `SELECT segment_id, database_path, database_sha256, start_ms, end_ms, event_count
         FROM archive_segments ORDER BY start_ms, segment_id`,
      )
      .all()
      .map((row) => ({
        segmentId: String(row.segment_id),
        databasePath: String(row.database_path),
        databaseSha256: String(row.database_sha256),
        startMs: Number(row.start_ms),
        endMs: Number(row.end_ms),
        eventCount: Number(row.event_count),
      })),
  };
}

function stableState(store) {
  return {
    hotRows: hotRows(store),
    revisions: revisionMeta(store),
    archive: authorityState(store),
    replacedFacts: store.database
      .prepare(
        `SELECT source_path, payload_digest, occurrence_count, method_version, revision_reason
         FROM history_replaced_facts ORDER BY source_path, payload_digest, method_version`,
      )
      .all()
      .map((row) => ({
        sourcePath: String(row.source_path),
        payloadDigest: String(row.payload_digest),
        occurrenceCount: Number(row.occurrence_count),
        methodVersion: String(row.method_version),
        revisionReason: String(row.revision_reason),
      })),
    missingSources: store.sourceState().missingSources,
  };
}

function quickCheck(store) {
  return store.database.prepare("PRAGMA quick_check").get().quick_check;
}

function assertRevision100To90(store, sourceFile) {
  const revision = revisionMeta(store);
  assert.ok(revision, "cold revision metadata is missing");
  assert.equal(revision.formatVersion, 1);
  assert.equal(revision.revisions.length, 1);
  const entry = revision.revisions[0];
  assert.equal(entry.sourceIdentity.path, sourceFile);
  assert.deepEqual(
    entry.removed.map((delta) => [Number(delta.payload.total), delta.count]),
    [[100, 1]],
  );
  assert.deepEqual(
    entry.added.map((delta) => [Number(delta.payload.total), delta.count]),
    [[90, 1]],
  );
  return revision;
}

async function publishedBusinessEvents(store) {
  return (await store.publishedHistoryUsageEvents()).map((event) => {
    const { id: _id, ...business } = event;
    return business;
  });
}

function assertBusinessParity(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: event count`);
  for (let index = 0; index < actual.length; index += 1) {
    const actualEvent = actual[index];
    const expectedEvent = expected[index];
    const keys = new Set([...Object.keys(actualEvent), ...Object.keys(expectedEvent)]);
    for (const key of keys) {
      assert.deepEqual(actualEvent[key], expectedEvent[key], `${label}: event ${index} field ${key}`);
    }
  }
}

async function createOracle(root) {
  const store = await openStore(root, "oracle.sqlite");
  try {
    await syncStore(store, root);
    return await publishedBusinessEvents(store);
  } finally {
    store.close();
  }
}

async function createArchivedFixture(root) {
  const sourceFile = await writeSource(root, 100, 30);
  const candidateFile = path.join(root, "candidate.sqlite");
  const store = await openStore(root);
  try {
    await syncStore(store, root);
    assert.deepEqual(
      hotRows(store).map((row) => row.total),
      [100, 30],
    );

    await createHistoryArchiveCandidate(store.database, candidateFile, {
      startMs: COLD_MS,
      endMs: HOT_MS,
    });
    const plan = await prepareHistoryArchiveCommit(store.database, candidateFile);
    const committed = await store.commitHistoryArchiveEvents(plan);
    assert.equal(committed.inserted, true);
    assert.equal(committed.replay, false);
    assert.equal(committed.deletedEventCount, 1);

    const archive = authorityState(store);
    assert.deepEqual(archive.authority, {
      formatVersion: 1,
      segmentIds: [committed.segmentId],
    });
    assert.equal(archive.segments.length, 1);
    assert.equal(archive.segments[0].databasePath, candidateFile);
    assert.equal(archive.segments[0].databaseSha256, committed.segmentId);
    assert.deepEqual(
      hotRows(store).map((row) => row.total),
      [30],
    );
    assert.deepEqual(
      (await publishedBusinessEvents(store)).map((event) => event.total.total),
      [100, 30],
    );
    assert.equal(revisionMeta(store), null);
    assert.equal(quickCheck(store), "ok");

    return {
      store,
      sourceFile,
      candidateFile,
      candidateHashes: await packageHashes(candidateFile),
      segmentId: committed.segmentId,
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

async function mutateToFinal(root, store) {
  const sourceFile = await writeSource(root, 90, 30);
  invalidateSource(store, sourceFile);
  return { sourceFile, expected: await createOracle(root) };
}

function assertCandidateHashes(actual, expected, label) {
  assert.deepEqual(actual, expected, `${label}: archive package bytes changed`);
}

function checkpoint(store, phase) {
  assert.equal(typeof process.send, "function");
  process.send({
    pid: process.pid,
    phase,
    execArgv: process.execArgv,
    isTransaction: store.database.isTransaction,
    hotRows: hotRows(store),
    revision: revisionMeta(store),
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  throw new Error("Parent did not kill the parked archive-revision child");
}

async function runCrashChild(root, phase) {
  assert.ok(phase === "before-commit" || phase === "after-commit");
  const store = await openStore(root);
  const database = store.database;
  const exec = database.exec.bind(database);
  const replace = store.replaceFile.bind(store);
  let replacing = false;
  let targetTransaction = false;

  store.replaceFile = async (...args) => {
    replacing = true;
    try {
      return await replace(...args);
    } finally {
      replacing = false;
    }
  };
  database.exec = (sql) => {
    const statement = String(sql).trim();
    if (replacing && statement === "BEGIN IMMEDIATE") targetTransaction = true;
    const boundary = replacing && targetTransaction && statement === "COMMIT";
    if (boundary && phase === "before-commit") checkpoint(store, phase);
    const result = exec(sql);
    if (boundary) targetTransaction = false;
    if (boundary && phase === "after-commit") checkpoint(store, phase);
    return result;
  };

  await syncStore(store, root);
  throw new Error("Archive revision COMMIT boundary was not reached");
}

async function killAtRevisionCommit(root, caseDirectory, phase) {
  const child = fork(SELF, [root, "child", phase], {
    execArgv: HEAP_ARGS,
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: "" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "";
  let stderr = "";
  let message = null;
  let killRequested = false;
  let failure = null;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        failure = new Error(`No archive revision IPC checkpoint within 30 seconds: ${stderr}`);
        child.kill("SIGKILL");
      }, 30_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("message", (received) => {
        try {
          assert.equal(message, null, "only one crash checkpoint is allowed");
          message = received;
          assert.equal(message.pid, child.pid);
          assert.equal(message.phase, phase);
          assert.deepEqual(message.execArgv, HEAP_ARGS);
          assert.equal(message.isTransaction, phase === "before-commit");
          killRequested = child.kill("SIGKILL");
          assert.equal(killRequested, true);
        } catch (error) {
          failure = error;
          child.kill("SIGKILL");
        }
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        try {
          if (failure) throw failure;
          assert.ok(message, `child exited without checkpoint: ${stderr}`);
          assert.equal(killRequested, true);
          assert.equal(signal, "SIGKILL", JSON.stringify({ code, signal, stderr }));
          resolve({ checkpoint: message, exit: { code, signal }, killRequested });
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    await writeFile(path.join(caseDirectory, "child-stdout.log"), stdout, { flag: "wx" });
    await writeFile(path.join(caseDirectory, "child-stderr.log"), stderr, { flag: "wx" });
  }
}

async function revisionCase(caseDirectory) {
  const fixture = await createArchivedFixture(caseDirectory);
  try {
    const { expected } = await mutateToFinal(caseDirectory, fixture.store);
    await syncStore(fixture.store, caseDirectory);
    const actual = await publishedBusinessEvents(fixture.store);
    assertBusinessParity(actual, expected, "revision versus hot oracle");
    assert.deepEqual(
      actual.map((event) => event.total.total),
      [90, 30],
    );
    assert.deepEqual(
      hotRows(fixture.store).map((row) => row.total),
      [30],
    );
    const revision = assertRevision100To90(fixture.store, fixture.sourceFile);
    assertCandidateHashes(
      await packageHashes(fixture.candidateFile),
      fixture.candidateHashes,
      "revision",
    );
    assert.equal(quickCheck(fixture.store), "ok");
    const stable = stableState(fixture.store);
    const repeated = await syncStore(fixture.store, caseDirectory);
    assert.equal(repeated.updatedFileCount, 0);
    assert.deepEqual(stableState(fixture.store), stable);
    return {
      revision,
      eventTotals: actual.map((event) => event.total.total),
      hotEventTotals: hotRows(fixture.store).map((row) => row.total),
      candidateHashes: fixture.candidateHashes,
      quickCheck: quickCheck(fixture.store),
      repeatedSyncUpdatedFiles: repeated.updatedFileCount,
    };
  } finally {
    fixture.store.close();
  }
}

async function missingSourceCase(caseDirectory) {
  const fixture = await createArchivedFixture(caseDirectory);
  try {
    const { sourceFile, expected } = await mutateToFinal(caseDirectory, fixture.store);
    await syncStore(fixture.store, caseDirectory);
    assertBusinessParity(
      await publishedBusinessEvents(fixture.store),
      expected,
      "missing-source baseline",
    );
    const before = stableState(fixture.store);
    const beforeRevision = fixture.store.readMetaRaw(REVISION_META);
    invalidateSource(fixture.store, sourceFile);
    await rm(sourceFile);
    const missing = await syncStore(fixture.store, caseDirectory);
    assert.ok(missing.missingSources.some((source) => source.path === sourceFile));
    assert.deepEqual(await publishedBusinessEvents(fixture.store), expected);
    assert.equal(fixture.store.readMetaRaw(REVISION_META), beforeRevision);
    assert.deepEqual(hotRows(fixture.store), before.hotRows);
    assertCandidateHashes(
      await packageHashes(fixture.candidateFile),
      fixture.candidateHashes,
      "missing-source",
    );
    assert.equal(quickCheck(fixture.store), "ok");
    const afterFirst = stableState(fixture.store);
    const repeated = await syncStore(fixture.store, caseDirectory);
    assert.equal(repeated.updatedFileCount, 0);
    assert.deepEqual(stableState(fixture.store), afterFirst);
    return {
      missingSources: missing.missingSources.map((source) => source.path),
      eventTotals: (await publishedBusinessEvents(fixture.store)).map((event) => event.total.total),
      revisionUnchanged: true,
      candidateHashes: fixture.candidateHashes,
      quickCheck: quickCheck(fixture.store),
      repeatedSyncUpdatedFiles: repeated.updatedFileCount,
    };
  } finally {
    fixture.store.close();
  }
}

async function crashCase(caseDirectory, phase) {
  const fixture = await createArchivedFixture(caseDirectory);
  let expected;
  let sourceFile;
  try {
    ({ sourceFile, expected } = await mutateToFinal(caseDirectory, fixture.store));
    assert.deepEqual(
      hotRows(fixture.store).map((row) => row.total),
      [30],
    );
    assert.deepEqual(
      (await publishedBusinessEvents(fixture.store)).map((event) => event.total.total),
      [100, 30],
    );
    assert.equal(revisionMeta(fixture.store), null);
  } finally {
    fixture.store.close();
  }

  const killed = await killAtRevisionCommit(caseDirectory, caseDirectory, phase);
  if (phase === "before-commit") {
    assert.ok(killed.checkpoint.revision, "pre-COMMIT checkpoint did not contain staged revision metadata");
    assert.equal(
      killed.checkpoint.revision.revisions[0].added[0].payload.total,
      90,
    );
  } else {
    assert.equal(
      killed.checkpoint.revision.revisions[0].added[0].payload.total,
      90,
    );
  }

  const store = await openStore(caseDirectory);
  try {
    assert.equal(quickCheck(store), "ok");
    assert.deepEqual(
      hotRows(store).map((row) => row.total),
      [30],
    );
    if (phase === "before-commit") {
      assert.equal(revisionMeta(store), null);
      assert.deepEqual(
        (await publishedBusinessEvents(store)).map((event) => event.total.total),
        [100, 30],
      );
    } else {
      assertRevision100To90(store, sourceFile);
      assert.deepEqual(
        (await publishedBusinessEvents(store)).map((event) => event.total.total),
        [90, 30],
      );
    }
    assertCandidateHashes(
      await packageHashes(fixture.candidateFile),
      fixture.candidateHashes,
      `${phase}-before-recovery`,
    );

    const recoveredSync = await syncStore(store, caseDirectory);
    assert.equal(recoveredSync.updatedFileCount, 1);
    assertBusinessParity(await publishedBusinessEvents(store), expected, `${phase} recovery`);
    assertRevision100To90(store, sourceFile);
    assert.deepEqual(
      hotRows(store).map((row) => row.total),
      [30],
    );
    assert.equal(quickCheck(store), "ok");
    const recoveredState = stableState(store);
    const revisionAfterRecovery = store.readMetaRaw(REVISION_META);
    const repeatedSync = await syncStore(store, caseDirectory);
    assert.equal(repeatedSync.updatedFileCount, 0);
    assert.equal(store.readMetaRaw(REVISION_META), revisionAfterRecovery);
    assert.deepEqual(stableState(store), recoveredState);
    assertCandidateHashes(
      await packageHashes(fixture.candidateFile),
      fixture.candidateHashes,
      `${phase}-after-recovery`,
    );
    return {
      phase,
      killed,
      stateBeforeRecovery: phase === "before-commit" ? "pre-revision" : "post-revision",
      recoveredSyncUpdatedFiles: recoveredSync.updatedFileCount,
      repeatedSyncUpdatedFiles: repeatedSync.updatedFileCount,
      eventTotals: (await publishedBusinessEvents(store)).map((event) => event.total.total),
      hotEventTotals: hotRows(store).map((row) => row.total),
      candidateHashes: fixture.candidateHashes,
      quickCheck: quickCheck(store),
    };
  } finally {
    store.close();
  }
}

async function runCase(name, run) {
  const caseDirectory = path.join(OUTPUT_ROOT, name);
  await mkdir(caseDirectory);
  const result = { case: name, passed: false, startedAt: new Date().toISOString() };
  try {
    Object.assign(result, await run(caseDirectory));
    result.passed = true;
  } catch (error) {
    result.error = { message: error.message, stack: error.stack };
    await writeFile(path.join(caseDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
    });
    throw error;
  }
  result.endedAt = new Date().toISOString();
  await writeFile(path.join(caseDirectory, "result.json"), `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(JSON.stringify({ case: name, passed: true }));
  return result;
}

async function runParent() {
  assert.deepEqual(process.execArgv, HEAP_ARGS, "parent must run with the required 224/4 heap flags");
  await mkdir(OUTPUT_ROOT);
  const startedAt = new Date().toISOString();
  const results = [];
  try {
    results.push(await runCase("cold-revision", revisionCase));
    results.push(await runCase("source-missing", missingSourceCase));
    results.push(await runCase("before-commit", (directory) => crashCase(directory, "before-commit")));
    results.push(await runCase("after-commit", (directory) => crashCase(directory, "after-commit")));
  } catch (error) {
    await writeFile(
      path.join(OUTPUT_ROOT, "result.json"),
      `${JSON.stringify(
        {
          passed: false,
          startedAt,
          endedAt: new Date().toISOString(),
          heapArgs: HEAP_ARGS,
          results,
          error: { message: error.message, stack: error.stack },
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    throw error;
  }
  const report = {
    passed: results.every((result) => result.passed),
    startedAt,
    endedAt: new Date().toISOString(),
    heapArgs: HEAP_ARGS,
    results,
  };
  await writeFile(path.join(OUTPUT_ROOT, "result.json"), `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
  });
  console.log(JSON.stringify({ passed: report.passed, cases: results.length, output: OUTPUT_ROOT }));
}

const [childRoot, childMode, childPhase] = process.argv.slice(2);
if (childMode === "child") {
  assert.ok(childRoot, "child root is required");
  await runCrashChild(childRoot, childPhase);
} else {
  assert.equal(childMode, undefined);
  await runParent();
}
