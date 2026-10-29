import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture, createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

async function openFixture(t, fixture) {
  const store = new UsageStore(fixture.serverOptions);
  t.after(() => {
    t.mock.restoreAll();
    store.close();
    fixture.close();
  });
  await store.open();
  const options = fixture.reportOptions;
  assert.equal((await store.sync({ options })).perfState, "ready", "fixture must publish before observation");
  return { store, options };
}

function editZcode(filePath, sql, ...values) {
  const database = new DatabaseSync(filePath);
  try {
    database.prepare(sql).run(...values);
  } finally {
    database.close();
  }
}

async function openZcodeFixture(t, count = 2) {
  const fixture = createPerfIntegrationFixture();
  const homes = fixture.reportOptions.extraZcodeHomes.split(path.delimiter);
  if (count === 3) {
    const extraHome = path.join(fixture.reportOptions.homeDir, "zcode-third");
    mkdirSync(path.join(extraHome, "cli", "db"), { recursive: true });
    copyFileSync(path.join(homes[0], "cli", "db", "db.sqlite"), path.join(extraHome, "cli", "db", "db.sqlite"));
    homes.push(extraHome);
    fixture.reportOptions.extraZcodeHomes = homes.join(path.delimiter);
  }
  // Distinct sessions keep the existing changedSessions cascade out of these cases.
  for (const [index, home] of homes.entries()) {
    editZcode(path.join(home, "cli", "db", "db.sqlite"), "UPDATE model_usage SET session_id = ?", `prescan-${index}`);
  }
  const workspace = await openFixture(t, fixture);
  const dbFiles = workspace.store.homes.filter((home) => home.kind === "zcode").map((home) => home.usageLogPath);
  assert.equal(dbFiles.length, count);
  return { ...workspace, dbFiles };
}

function beforeFileDecision(t, store, action) {
  const prepare = store.database.prepare.bind(store.database);
  t.mock.method(store.database, "prepare", (sql) => {
    const statement = prepare(sql);
    if (sql !== "SELECT DISTINCT session_id FROM events WHERE source_path = ?") return statement;
    const all = statement.all.bind(statement);
    statement.all = (filePath) => {
      action(filePath);
      return all(filePath);
    };
    return statement;
  });
}

function observeRound(t, store) {
  const states = [];
  const replacements = [];
  const writeState = store.writePerfState.bind(store);
  const replace = store.replaceFile.bind(store);
  t.mock.method(store, "writePerfState", (state, options) => {
    states.push(state);
    return writeState(state, options);
  });
  t.mock.method(store, "replaceFile", (file, options) => {
    replacements.push({ filePath: file.filePath, state: store.readMeta("perf_state") });
    return replace(file, options);
  });
  return { states, replacements };
}

function snapshotFile(store, filePath) {
  const database = store.database;
  return {
    source: database.prepare("SELECT * FROM source_files WHERE path = ?").get(filePath),
    events: database.prepare("SELECT * FROM events WHERE source_path = ? ORDER BY id").all(filePath),
    quota: database
      .prepare("SELECT * FROM rate_limit_observations WHERE source_path = ? ORDER BY line_number, role")
      .all(filePath),
    samples: database.prepare("SELECT * FROM perf_samples WHERE source_path = ? ORDER BY sample_key").all(filePath),
  };
}

test("§12 · later files change: retain ready until the first replacement, then mark rebuilding once", async (t) => {
  const { store, options, dbFiles } = await openZcodeFixture(t, 3);
  for (const filePath of dbFiles.slice(1)) {
    editZcode(filePath, "UPDATE model_usage SET output_tokens = output_tokens + 1 WHERE status = 'completed'");
  }
  const observed = observeRound(t, store);
  const decisions = new Map();
  beforeFileDecision(t, store, (filePath) => {
    if (!decisions.has(filePath)) decisions.set(filePath, store.readMeta("perf_state"));
  });

  const round = await store.sync({ options });

  assert.equal(round.updatedFileCount, 2);
  assert.equal(round.perfState, "ready");
  assert.deepEqual(
    [...decisions],
    [
      [dbFiles[0], "ready"],
      [dbFiles[1], "ready"],
      [dbFiles[2], "rebuilding"],
    ],
  );
  assert.deepEqual(observed.states, ["rebuilding", "ready"]);
  assert.deepEqual(
    observed.replacements,
    dbFiles.slice(1).map((filePath) => ({ filePath, state: "rebuilding" })),
  );
});

test("§12 · same size/mtime rewrite after the old prescan still marks rebuilding before replacement", async (t) => {
  const fixture = createPerfCodexIntegrationFixture();
  const { store, options } = await openFixture(t, fixture);
  const target = fixture.rolloutFiles[0];
  const observed = observeRound(t, store);
  let injected = false;
  let stateBeforeRewrite;
  beforeFileDecision(t, store, (filePath) => {
    if (filePath !== target || injected) return;
    injected = true;
    stateBeforeRewrite = store.readMeta("perf_state");
    // This query is after the removed prescan and before the live per-file probe (perf-store S2 fixture).
    const before = statSync(target);
    const text = readFileSync(target, "utf8");
    const next = text.replaceAll("codex-fixture-model", "codex-fixture-other");
    assert.notEqual(next, text);
    assert.equal(Buffer.byteLength(next), Buffer.byteLength(text));
    writeFileSync(target, next);
    utimesSync(target, before.atime, before.mtime);
    const after = statSync(target);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs, "fixed fixture timestamp must survive the rewrite exactly");
  });

  const round = await store.sync({ options });

  assert.equal(injected, true, "the rewrite must occur inside this sync");
  assert.equal(stateBeforeRewrite, "ready", "there is no structural change before the rewrite");
  assert.equal(round.updatedFileCount, 1);
  assert.deepEqual(observed.replacements, [{ filePath: target, state: "rebuilding" }]);
  assert.deepEqual(observed.states, ["rebuilding", "ready"]);
});

test("§12 · first replacement rolls back: mark once, preserve facts, recover next round", async (t) => {
  const { store, options, dbFiles } = await openZcodeFixture(t);
  const [failedFile, successfulFile] = dbFiles;
  const before = snapshotFile(store, failedFile);
  const fingerprints = store.readPublishedFileFingerprints();
  assert.ok(before.events.length > 0 && before.samples.length > 0, "rollback needs existing facts");
  for (const filePath of dbFiles) {
    editZcode(filePath, "UPDATE model_usage SET output_tokens = output_tokens + 1 WHERE status = 'completed'");
  }
  store.database.exec(`
    CREATE TEMP TRIGGER fail_first_prescan_replace BEFORE INSERT ON perf_samples
    WHEN NEW.source_path = '${failedFile.replaceAll("'", "''")}'
    BEGIN SELECT RAISE(ABORT, 'prescan replacement failure'); END;
  `);
  const observed = observeRound(t, store);

  const failed = await store.sync({ options });

  assert.equal(failed.updatedFileCount, 1, "the second file must still commit");
  assert.equal(failed.perfState, "degraded");
  assert.deepEqual(observed.states, ["rebuilding", "degraded"]);
  assert.deepEqual(
    observed.replacements,
    dbFiles.map((filePath) => ({ filePath, state: "rebuilding" })),
  );
  assert.deepEqual(snapshotFile(store, failedFile), before, "failed replacement must roll back all file facts");
  assert.equal(store.readPublishedFileFingerprints()[failedFile], fingerprints[failedFile]);
  assert.notEqual(store.readPublishedFileFingerprints()[successfulFile], fingerprints[successfulFile]);
  assert.ok(store.warnings.some((warning) => warning.includes("prescan replacement failure")));
  assert.equal(store.writeTransactionDepth, 0);

  store.database.exec("DROP TRIGGER fail_first_prescan_replace");
  observed.states.length = 0;
  observed.replacements.length = 0;
  const recovered = await store.sync({ options });

  assert.equal(recovered.updatedFileCount, 1);
  assert.equal(recovered.perfState, "ready");
  assert.deepEqual(observed.states, ["rebuilding", "ready"], "the marker belongs to each round");
  assert.deepEqual(observed.replacements, [{ filePath: failedFile, state: "rebuilding" }]);
  assert.notDeepEqual(snapshotFile(store, failedFile).events, before.events);
  assert.deepEqual(
    snapshotFile(store, failedFile).samples,
    before.samples,
    "raw-only output changes do not create generation timing",
  );
  assert.notEqual(store.readPublishedFileFingerprints()[failedFile], fingerprints[failedFile]);
  assert.deepEqual(JSON.parse(store.readMeta("perf_degraded_home_ids")), []);
});

test("§12 · rebuilding marker failure rejects sync before replaceFile and the per-file parse catch", async (t) => {
  const { store, options, dbFiles } = await openZcodeFixture(t);
  const before = snapshotFile(store, dbFiles[0]);
  const fingerprints = store.readPublishedFileFingerprints();
  editZcode(dbFiles[0], "UPDATE model_usage SET output_tokens = output_tokens + 1 WHERE status = 'completed'");
  const states = [];
  const replace = t.mock.method(store, "replaceFile");
  const writeState = store.writePerfState.bind(store);
  const failure = new Error("prescan rebuilding marker failure");
  t.mock.method(store, "writePerfState", (state, stateOptions) => {
    states.push(state);
    if (state === "rebuilding") throw failure;
    return writeState(state, stateOptions);
  });

  await assert.rejects(
    () => store.sync({ options }),
    (error) => error === failure,
  );

  assert.deepEqual(states, ["rebuilding"], "marker failure cannot fall through to degraded publication");
  assert.equal(replace.mock.callCount(), 0, "no usage parsing may start before the marker succeeds");
  assert.equal(store.readMeta("perf_state"), "ready");
  assert.deepEqual(snapshotFile(store, dbFiles[0]), before);
  assert.deepEqual(store.readPublishedFileFingerprints(), fingerprints);
  assert.equal(store.publishedFileMapsView, null, "sync must release its round view on rejection");
  assert.equal(store.writeTransactionDepth, 0);
});

test("§12 · Codex policy upgrade marks rebuilding before file decisions even with zero replacements", async (t) => {
  const fixture = createPerfCodexIntegrationFixture();
  const { store, options } = await openFixture(t, fixture);
  store.database.prepare("DELETE FROM store_meta WHERE key = 'perf_codex_publication_policy'").run();
  const observed = observeRound(t, store);
  const decisions = [];
  beforeFileDecision(t, store, () => decisions.push(store.readMeta("perf_state")));

  const round = await store.sync({ options });

  assert.equal(round.updatedFileCount, 0);
  assert.equal(round.perfState, "ready");
  assert.deepEqual(observed.replacements, []);
  assert.deepEqual(observed.states, ["rebuilding", "ready"]);
  assert.equal(decisions.length, fixture.rolloutFiles.length);
  assert.ok(
    decisions.every((state) => state === "rebuilding"),
    "structural publication must mark before the loop",
  );
  assert.ok(store.readMeta("perf_codex_publication_policy"), "the policy must actually be republished");
});

function workbuddyUsage(messageId, sessionId) {
  return {
    timestamp: 1792537466382,
    type: "function_call",
    sessionId,
    cwd: "/work/prescan",
    providerData: {
      messageId,
      model: "deepseek-v4.1-flash",
      usage: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
    },
  };
}

function workbuddyTrace(messageId, duration) {
  return {
    type: "span_end",
    span: {
      traceId: "prescan-trace",
      spanId: messageId,
      name: "generation",
      type: "generation",
      endedAt: "2026-10-21T00:08:56.704Z",
      duration,
      status: "ok",
      toolOutput: JSON.stringify([{ id: messageId }]),
    },
  };
}

test("§12 · WorkBuddy trace targets mark rebuilding even when the target is absent", async (t) => {
  const fixture = createPerfIntegrationFixture();
  const home = path.join(fixture.reportOptions.homeDir, ".workbuddy-ai");
  const project = path.join(home, "projects", "prescan");
  const traceFile = path.join(home, "traces", "1", "trace_prescan.jsonl");
  const targetSession = "21201ca7-ac0f-4672-9745-084a3dfeb70d";
  const retainedSession = "bd7e6ac4-720f-4c77-8280-8d2687320b1a";
  const target = path.join(project, `${targetSession}.jsonl`);
  mkdirSync(project, { recursive: true });
  mkdirSync(path.dirname(traceFile), { recursive: true });
  writeFileSync(target, `${JSON.stringify(workbuddyUsage("prescan-target", targetSession))}\n`);
  writeFileSync(
    path.join(project, `${retainedSession}.jsonl`),
    `${JSON.stringify(workbuddyUsage("prescan-retained", retainedSession))}\n`,
  );
  const initialTraces = [workbuddyTrace("prescan-target", 800), workbuddyTrace("prescan-retained", 900)];
  writeFileSync(traceFile, `${initialTraces.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const { store, options } = await openFixture(t, fixture);
  assert.equal(
    store.database.prepare("SELECT source_path FROM perf_samples WHERE source_path = ?").get(target)?.source_path,
    target,
  );
  unlinkSync(target);
  writeFileSync(
    traceFile,
    `${[...initialTraces, workbuddyTrace("prescan-target", 850)].map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
  const refresh = store.refreshWorkbuddyDurations.bind(store);
  const insertedMessageIds = [];
  t.mock.method(store, "refreshWorkbuddyDurations", async (...args) => {
    const outcome = await refresh(...args);
    insertedMessageIds.push(...outcome.insertedMessageIds);
    return outcome;
  });
  const observed = observeRound(t, store);
  const decisions = [];
  beforeFileDecision(t, store, (filePath) => decisions.push({ filePath, state: store.readMeta("perf_state") }));

  const round = await store.sync({ options });

  assert.deepEqual(insertedMessageIds, ["prescan-target"], "a real trace insertion must create the stale-path target");
  assert.equal(round.updatedFileCount, 0);
  assert.deepEqual(observed.replacements, []);
  assert.equal(observed.states.filter((state) => state === "rebuilding").length, 1);
  assert.ok(decisions.length > 0, "the retained session must keep the WorkBuddy home discoverable");
  assert.ok(
    decisions.every(({ state }) => state === "rebuilding"),
    "trace targets require the early marker",
  );
  assert.equal(
    decisions.some(({ filePath }) => filePath === target),
    false,
  );
});
