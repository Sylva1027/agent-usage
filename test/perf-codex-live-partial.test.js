import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  codexSampleAllowed,
  createCodexProjectionCache,
  createCodexPublishFilter,
  decodeCodexPublicationPolicy,
} from "../src/perf-sources/codex-thread.js";
import { planStableCodexHome, proveCodexLiveAppend } from "../src/usage-core.js";
import { UsageStore, createPersistentCodexProjectionCache } from "../src/usage-store.js";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "codex-live-partial-"));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));

function lines(threadId, model, turn = "Turn-1") {
  return [
    { type: "session_meta", payload: { id: threadId, session_id: threadId, source: "cli" } },
    { type: "turn_context", payload: { thread_id: threadId, turn_id: turn, model } },
    {
      type: "token_usage_record",
      timestamp: "2026-10-04T12:00:01.000Z",
      payload: {
        thread_id: threadId,
        turn_id: turn,
        response_id: `resp-${threadId}-${turn}`,
        usage: { output_tokens: 120 },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: threadId,
        turn_id: turn,
        item: { id: `item-${threadId}-${turn}`, type: "AgentMessage" },
        started_at_ms: 1000,
        completed_at_ms: 1400,
      },
    },
  ];
}

function appendTurn(file, threadId, model, turn) {
  writeFileSync(
    file,
    `${readFileSync(file, "utf8")}${lines(threadId, model, turn).slice(1).map(JSON.stringify).join("\n")}\n`,
  );
}

function rewriteOwnerAndAppend(file, threadId, model, turn) {
  const records = readFileSync(file, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const metadata = records.find((record) => record.type === "session_meta");
  assert.ok(metadata);
  metadata.payload.id = threadId;
  metadata.payload.session_id = threadId;
  writeFileSync(
    file,
    `${records.map(JSON.stringify).join("\n")}\n${lines(threadId, model, turn).slice(1).map(JSON.stringify).join("\n")}\n`,
  );
}

let seq = 0;
function fixture() {
  const root = path.join(ROOT, `case-${++seq}`);
  const homeDir = path.join(root, "codex");
  const sessionsDir = path.join(homeDir, "sessions", "2026", "10");
  mkdirSync(sessionsDir, { recursive: true });
  const active = path.join(sessionsDir, "rollout-active.jsonl");
  const sibling = path.join(sessionsDir, "rollout-sibling.jsonl");
  const third = path.join(sessionsDir, "rollout-third.jsonl");
  writeFileSync(active, `${lines("Thread-Active", "Active-Model").map(JSON.stringify).join("\n")}\n`);
  writeFileSync(sibling, `${lines("Thread-Sibling", "Sibling-Model").map(JSON.stringify).join("\n")}\n`);
  writeFileSync(third, `${lines("Thread-Third", "Third-Model").map(JSON.stringify).join("\n")}\n`);
  const options = {
    homeDir: root,
    env: {},
    extraHomes: homeDir,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
  return {
    root,
    homeDir,
    sessionsDir,
    active,
    sibling,
    third,
    options,
    serverOptions: {
      ...options,
      databaseFile: path.join(root, "index.sqlite"),
      importStoreFile: path.join(root, "imports.json"),
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function identity(store, threadId) {
  return store.database
    .prepare("SELECT rowid AS rid, sample_key FROM perf_samples WHERE sample_key LIKE ? ORDER BY sample_key")
    .all(`%"${threadId}"%`)
    .map((row) => `${row.sample_key}=${Number(row.rid)}`);
}

function rolloutIdentity(store, threadId) {
  return store.database
    .prepare("SELECT rowid AS rid, source_path FROM perf_rollout_threads WHERE thread_id = ? ORDER BY source_path")
    .all(threadId)
    .map((row) => `${row.source_path}=${Number(row.rid)}`);
}

function warnings(store) {
  return JSON.parse(store.readMeta("perf_source_warnings"));
}

function liveWarning(store) {
  return warnings(store).find((entry) => entry.code === "LIVE_SOURCE_CHANGED");
}

function blockedThreads(store, homeId) {
  const policy = decodeCodexPublicationPolicy(store.readMeta("perf_codex_publication_policy"));
  assert.equal(policy.usable, true);
  return policy.partialHomes.find((entry) => entry.homeId === homeId)?.blockedThreadIds ?? [];
}

function injectBeforeCodexPublication(store, action) {
  const state = { injected: false, codexQueries: 0 };
  const realPrepare = store.database.prepare.bind(store.database);
  store.database.prepare = (sql) => {
    const statement = realPrepare(sql);
    if (!String(sql).includes("SELECT DISTINCT session_id FROM events WHERE source_path = ?")) return statement;
    const realAll = statement.all.bind(statement);
    statement.all = (...args) => {
      state.codexQueries += 1;
      if (state.codexQueries === 2) {
        state.injected = true;
        action();
      }
      return realAll(...args);
    };
    return statement;
  };
  state.restore = () => {
    store.database.prepare = realPrepare;
  };
  return state;
}

test("live append is isolated through planning and pre-publication, then publishes on a quiet round", async () => {
  const home = fixture();
  const store = new UsageStore(home.serverOptions);
  try {
    await store.open();
    await store.sync({ options: home.options });
    const homeId = store.database.prepare("SELECT home_id FROM source_files WHERE path = ?").get(home.active).home_id;
    const indexVersion = store.readMeta("perf_index_version");
    const activeBefore = identity(store, "Thread-Active");
    const siblingBefore = identity(store, "Thread-Sibling");

    appendTurn(home.active, "Thread-Active", "Active-Model", "Turn-2");
    const realLookup = store.codexProjections.lookup.bind(store.codexProjections);
    let planningAppend = false;
    store.codexProjections.lookup = (args) => {
      if (!planningAppend) {
        planningAppend = true;
        appendTurn(home.active, "Thread-Active", "Active-Model", "Turn-3");
      }
      return realLookup(args);
    };
    let publicationAppend;
    try {
      publicationAppend = injectBeforeCodexPublication(store, () =>
        appendTurn(home.active, "Thread-Active", "Active-Model", "Turn-4"),
      );
      const status = await store.sync({ options: home.options });
      assert.equal(status.perfState, "degraded");
    } finally {
      store.codexProjections.lookup = realLookup;
      publicationAppend?.restore();
    }

    assert.equal(planningAppend, true);
    assert.equal(publicationAppend.injected, true);
    assert.deepEqual(identity(store, "Thread-Active"), activeBefore);
    assert.deepEqual(identity(store, "Thread-Sibling"), siblingBefore);
    assert.deepEqual(
      warnings(store).filter((entry) => entry.code === "LIVE_SOURCE_CHANGED"),
      [{ sourceKind: "codex", homeId, code: "LIVE_SOURCE_CHANGED", count: 1 }],
    );
    assert.deepEqual(blockedThreads(store, homeId), ["Thread-Active"]);
    assert.equal(store.readMeta("perf_index_version"), indexVersion);

    const storedSamples = [...store.perfCandidatesForRange(null), ...store.unplacedPerfSamples()];
    const storedModels = new Set(storedSamples.map((sample) => String(sample.model)));
    const policy = decodeCodexPublicationPolicy(store.readMeta("perf_codex_publication_policy"));
    const publishFilter = createCodexPublishFilter([homeId], policy.partialHomes);
    assert.equal(storedModels.has("Active-Model"), true);
    assert.equal(storedModels.has("Sibling-Model"), true);
    assert.equal(
      storedSamples.some((sample) => sample.model === "Active-Model" && codexSampleAllowed(publishFilter, sample)),
      false,
    );
    assert.equal(
      storedSamples.some((sample) => sample.model === "Sibling-Model" && codexSampleAllowed(publishFilter, sample)),
      true,
    );

    const quiet = await store.sync({ options: home.options });
    assert.equal(quiet.perfState, "ready");
    assert.equal(identity(store, "Thread-Active").length > activeBefore.length, true);
    assert.deepEqual(identity(store, "Thread-Sibling"), siblingBefore);
    assert.equal(liveWarning(store), undefined);
  } finally {
    store.close();
    home.close();
  }
});

test("first post-planning append isolates the late thread without promoting its cache", async () => {
  const home = fixture();
  const store = new UsageStore(home.serverOptions);
  try {
    await store.open();
    await store.sync({ options: home.options });
    const homeId = store.database.prepare("SELECT home_id FROM source_files WHERE path = ?").get(home.active).home_id;
    const indexVersion = store.readMeta("perf_index_version");
    const activeBefore = identity(store, "Thread-Active");
    const siblingBefore = identity(store, "Thread-Sibling");
    const thirdBefore = identity(store, "Thread-Third");
    const activeRolloutsBefore = rolloutIdentity(store, "Thread-Active");
    const siblingRolloutsBefore = rolloutIdentity(store, "Thread-Sibling");
    const thirdRolloutsBefore = rolloutIdentity(store, "Thread-Third");

    appendTurn(home.active, "Thread-Active", "Active-Model", "Turn-2");
    const realLookup = store.codexProjections.lookup.bind(store.codexProjections);
    let planningAppend = false;
    store.codexProjections.lookup = (args) => {
      if (!planningAppend) {
        planningAppend = true;
        appendTurn(home.active, "Thread-Active", "Active-Model", "Turn-3");
      }
      return realLookup(args);
    };
    let publicationAppend;
    try {
      publicationAppend = injectBeforeCodexPublication(store, () =>
        appendTurn(home.sibling, "Thread-Sibling", "Sibling-Model", "Turn-2"),
      );
      const status = await store.sync({ options: home.options });
      assert.equal(status.perfState, "degraded");
    } finally {
      store.codexProjections.lookup = realLookup;
      publicationAppend?.restore();
    }

    assert.equal(planningAppend, true);
    assert.equal(publicationAppend.injected, true);
    assert.deepEqual(identity(store, "Thread-Active"), activeBefore);
    assert.deepEqual(identity(store, "Thread-Sibling"), siblingBefore);
    assert.deepEqual(identity(store, "Thread-Third"), thirdBefore);
    assert.deepEqual(rolloutIdentity(store, "Thread-Active"), activeRolloutsBefore);
    assert.deepEqual(rolloutIdentity(store, "Thread-Sibling"), siblingRolloutsBefore);
    assert.deepEqual(rolloutIdentity(store, "Thread-Third"), thirdRolloutsBefore);
    assert.deepEqual(blockedThreads(store, homeId), ["Thread-Active", "Thread-Sibling"]);
    assert.deepEqual(
      warnings(store).filter((entry) => entry.code === "LIVE_SOURCE_CHANGED"),
      [{ sourceKind: "codex", homeId, code: "LIVE_SOURCE_CHANGED", count: 1 }],
    );
    assert.equal(store.readMeta("perf_index_version"), indexVersion);

    const buildPlan = store.codexThreadBuildPlan.get(homeId);
    assert.ok(buildPlan);
    assert.equal(buildPlan.staged.includes("Thread-Active"), false);
    assert.equal(buildPlan.staged.includes("Thread-Sibling"), false);
    const cachedPaths = new Set(
      store.database
        .prepare("SELECT path FROM perf_codex_projections WHERE home_id = ?")
        .all(homeId)
        .map((row) => path.resolve(row.path).toLowerCase()),
    );
    assert.equal(cachedPaths.has(path.resolve(home.sibling).toLowerCase()), false);
    assert.equal(cachedPaths.has(path.resolve(home.third).toLowerCase()), true);

    const storedSamples = [...store.perfCandidatesForRange(null), ...store.unplacedPerfSamples()];
    const policy = decodeCodexPublicationPolicy(store.readMeta("perf_codex_publication_policy"));
    const publishFilter = createCodexPublishFilter([homeId], policy.partialHomes);
    assert.equal(
      storedSamples.some((sample) => sample.model === "Active-Model" && codexSampleAllowed(publishFilter, sample)),
      false,
    );
    assert.equal(
      storedSamples.some((sample) => sample.model === "Sibling-Model" && codexSampleAllowed(publishFilter, sample)),
      false,
    );
    assert.equal(
      storedSamples.some((sample) => sample.model === "Third-Model" && codexSampleAllowed(publishFilter, sample)),
      true,
    );

    const quiet = await store.sync({ options: home.options });
    assert.equal(quiet.perfState, "ready");
    assert.notDeepEqual(identity(store, "Thread-Active"), activeBefore);
    assert.notDeepEqual(identity(store, "Thread-Sibling"), siblingBefore);
    assert.deepEqual(identity(store, "Thread-Third"), thirdBefore);
    assert.equal(liveWarning(store), undefined);
  } finally {
    store.close();
    home.close();
  }
});

test("late owner rewrite still rejects the whole home", async () => {
  const home = fixture();
  const store = new UsageStore(home.serverOptions);
  try {
    await store.open();
    await store.sync({ options: home.options });
    const homeId = store.database.prepare("SELECT home_id FROM source_files WHERE path = ?").get(home.active).home_id;
    const indexVersion = store.readMeta("perf_index_version");
    const activeBefore = identity(store, "Thread-Active");
    const siblingBefore = identity(store, "Thread-Sibling");
    const thirdBefore = identity(store, "Thread-Third");
    const activeRolloutsBefore = rolloutIdentity(store, "Thread-Active");
    const siblingRolloutsBefore = rolloutIdentity(store, "Thread-Sibling");
    const thirdRolloutsBefore = rolloutIdentity(store, "Thread-Third");

    appendTurn(home.sibling, "Thread-Sibling", "Sibling-Model", "Turn-2");
    let publicationRewrite;
    try {
      publicationRewrite = injectBeforeCodexPublication(store, () =>
        rewriteOwnerAndAppend(home.active, "Thread-Sibling", "Sibling-Model", "Turn-3"),
      );
      const status = await store.sync({ options: home.options });
      assert.equal(status.perfState, "degraded");
    } finally {
      publicationRewrite?.restore();
    }

    assert.equal(publicationRewrite.injected, true);
    assert.deepEqual(identity(store, "Thread-Active"), activeBefore);
    assert.deepEqual(identity(store, "Thread-Sibling"), siblingBefore);
    assert.deepEqual(identity(store, "Thread-Third"), thirdBefore);
    assert.deepEqual(rolloutIdentity(store, "Thread-Active"), activeRolloutsBefore);
    assert.deepEqual(rolloutIdentity(store, "Thread-Sibling"), siblingRolloutsBefore);
    assert.deepEqual(rolloutIdentity(store, "Thread-Third"), thirdRolloutsBefore);
    const policy = decodeCodexPublicationPolicy(store.readMeta("perf_codex_publication_policy"));
    assert.equal(policy.usable, true);
    assert.deepEqual(policy.partialHomes, []);
    assert.equal(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM perf_rollout_threads WHERE source_path = ? AND thread_id = ?")
        .get(home.active, "Thread-Sibling").count,
      0,
    );
    assert.equal(
      store.database
        .prepare("SELECT COUNT(*) AS count FROM perf_sample_sources WHERE source_path = ? AND sample_key LIKE ?")
        .get(home.active, `%"Thread-Sibling"%`).count,
      0,
    );
    assert.deepEqual(
      warnings(store).filter((entry) => entry.code === "LIVE_SOURCE_CHANGED"),
      [{ sourceKind: "codex", homeId, code: "LIVE_SOURCE_CHANGED", count: 1 }],
    );
    assert.equal(store.readMeta("perf_index_version"), indexVersion);
  } finally {
    store.close();
    home.close();
  }
});

test("append proof rejects a growing same-owner rewrite whose old prefix changed", async () => {
  const home = fixture();
  try {
    const window = await planStableCodexHome({ id: "codex", kind: "codex", path: home.homeDir });
    const beforeBytes = readFileSync(home.active);
    const evidence = window.before.filePrefixEvidence[home.active];
    const beforeFingerprint = window.before.fileFingerprints[home.active];
    const original = beforeBytes.toString("utf8");
    const changed = original.replace('"source":"cli"', '"source":"vsc"');
    assert.equal(changed.length, original.length);
    const appended = lines("Thread-Active", "Active-Model", "Turn-2")[2];
    writeFileSync(home.active, `${changed}${JSON.stringify(appended)}\n`);
    const after = statSync(home.active);
    const afterFingerprint = `${after.size}:${after.mtimeMs}:${createHash("sha256")
      .update(readFileSync(home.active))
      .digest("hex")
      .slice(0, 32)}`;
    assert.equal(
      await proveCodexLiveAppend(home.active, beforeFingerprint, afterFingerprint, "Thread-Active", evidence),
      false,
    );
    assert.equal(
      await proveCodexLiveAppend(home.active, beforeFingerprint, afterFingerprint, "Thread-Active", undefined),
      false,
    );
  } finally {
    home.close();
  }
});

test("projection cache commit excludes live paths from memory and persistence", async () => {
  const home = fixture();
  const store = new UsageStore(home.serverOptions);
  try {
    await store.open();
    const inner = createCodexProjectionCache();
    const cache = createPersistentCodexProjectionCache({ database: store.database, inner });
    const excluded = path.join(home.sessionsDir, "excluded.jsonl");
    const kept = path.join(home.sessionsDir, "kept.jsonl");
    const fingerprints = { [excluded]: "fp-excluded", [kept]: "fp-kept" };
    for (const filePath of [excluded, kept]) {
      cache.stage({
        homeId: "home",
        kind: "codex",
        filePath,
        fingerprints,
        projection: { threadId: "thread", records: [] },
      });
    }
    assert.equal(cache.commit("home", [excluded]), 1);
    assert.deepEqual(
      inner.entries().map((entry) => path.resolve(entry.path).toLowerCase()),
      [path.resolve(kept).toLowerCase()],
    );
    const persisted = store.database
      .prepare("SELECT path FROM perf_codex_projections")
      .all()
      .map((row) => row.path);
    assert.deepEqual(
      persisted.map((value) => path.resolve(value).toLowerCase()),
      [path.resolve(kept).toLowerCase()],
    );
  } finally {
    store.close();
    home.close();
  }
});
