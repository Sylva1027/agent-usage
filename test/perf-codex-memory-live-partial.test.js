import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { decodeCodexPublicationPolicy } from "../src/perf-sources/codex-thread.js";
import { buildUsageReport } from "../src/usage-core.js";

const HOME_ID = "home-live";
const MISSING_TIMING = {
  state: "missing",
  durationMs: null,
  reportedOutputTokens: null,
  requestedModel: "",
};

function rolloutLines(threadId, model, turn = "Turn-1") {
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
        turn_token_usage: { output_tokens: 120 },
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

function appendTurn(filePath, threadId, model, turn) {
  const suffix = rolloutLines(threadId, model, turn)
    .slice(1)
    .map((line) => JSON.stringify(line))
    .join("\n");
  writeFileSync(filePath, `${readFileSync(filePath, "utf8")}${suffix}\n`);
}

function rewriteOwnerAndAppend(filePath, threadId, model, turn) {
  const records = readFileSync(filePath, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const metadata = records.find((record) => record.type === "session_meta");
  assert.ok(metadata);
  metadata.payload.id = threadId;
  metadata.payload.session_id = threadId;
  const suffix = rolloutLines(threadId, model, turn)
    .slice(1)
    .map((line) => JSON.stringify(line))
    .join("\n");
  writeFileSync(filePath, `${records.map((line) => JSON.stringify(line)).join("\n")}\n${suffix}\n`);
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-memory-live-partial-"));
  const homeDir = path.join(root, "codex");
  const sessionsDir = path.join(homeDir, "sessions", "2026", "10");
  mkdirSync(sessionsDir, { recursive: true });
  const rolloutA = path.join(sessionsDir, "rollout-a.jsonl");
  const rolloutB = path.join(sessionsDir, "rollout-b.jsonl");
  writeFileSync(
    rolloutA,
    `${rolloutLines("Thread-A", "Model-A")
      .map((line) => JSON.stringify(line))
      .join("\n")}\n`,
  );
  writeFileSync(
    rolloutB,
    `${rolloutLines("Thread-B", "Model-B")
      .map((line) => JSON.stringify(line))
      .join("\n")}\n`,
  );
  return {
    root,
    rolloutA,
    home: { id: HOME_ID, label: "Codex live", path: homeDir, kind: "main" },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

function sampleThreads(report) {
  return [...new Set(report.perfSamples.map((sample) => JSON.parse(sample.sampleKey)[2]))].sort();
}

test("memory path blocks only the thread appended after planning", async (t) => {
  const home = fixture();
  t.after(home.close);
  const options = { homes: [home.home], lookupRequestTiming: () => MISSING_TIMING };

  const baseline = await buildUsageReport(options);
  assert.equal(baseline.perfMeta.state, "ready");
  assert.deepEqual(sampleThreads(baseline), ["Thread-A", "Thread-B"]);

  let appended = false;
  const changed = await buildUsageReport({
    ...options,
    lookupRequestTiming: () => {
      if (!appended) {
        appended = true;
        appendTurn(home.rolloutA, "Thread-A", "Model-A", "Turn-2");
      }
      return MISSING_TIMING;
    },
  });
  assert.equal(appended, true);
  assert.equal(changed.perfMeta.state, "degraded");
  assert.deepEqual(changed.perfMeta.degradedHomeIds, [HOME_ID]);
  assert.deepEqual(decodeCodexPublicationPolicy(changed.perfMeta.codexPublicationPolicy).partialHomes, [
    { homeId: HOME_ID, blockedThreadIds: ["Thread-A"] },
  ]);
  assert.deepEqual(
    changed.perfMeta.sourceWarnings.filter((warning) => warning.code === "LIVE_SOURCE_CHANGED"),
    [{ sourceKind: "codex", homeId: HOME_ID, code: "LIVE_SOURCE_CHANGED", count: 1 }],
  );
  assert.equal(changed.perfMeta.indexVersion, null);
  assert.deepEqual(sampleThreads(changed), ["Thread-B"]);
  assert.deepEqual(changed.perfMeta.rankedHomeIds, [HOME_ID]);

  const quiet = await buildUsageReport(options);
  assert.equal(quiet.perfMeta.state, "ready");
  assert.deepEqual(sampleThreads(quiet), ["Thread-A", "Thread-B"]);
  assert.deepEqual(
    quiet.perfMeta.sourceWarnings.filter((warning) => warning.code === "LIVE_SOURCE_CHANGED"),
    [],
  );
});

test("memory path blocks the whole home when ownership changes after planning", async (t) => {
  const home = fixture();
  t.after(home.close);
  const options = { homes: [home.home], lookupRequestTiming: () => MISSING_TIMING };

  await buildUsageReport(options);

  let rewritten = false;
  const changed = await buildUsageReport({
    ...options,
    lookupRequestTiming: () => {
      if (!rewritten) {
        rewritten = true;
        rewriteOwnerAndAppend(home.rolloutA, "Thread-B", "Model-B", "Turn-2");
      }
      return MISSING_TIMING;
    },
  });
  assert.equal(rewritten, true);
  assert.equal(changed.perfMeta.state, "degraded");
  assert.deepEqual(changed.perfMeta.degradedHomeIds, [HOME_ID]);
  assert.deepEqual(decodeCodexPublicationPolicy(changed.perfMeta.codexPublicationPolicy).partialHomes, []);
  assert.deepEqual(
    changed.perfMeta.sourceWarnings.filter((warning) => warning.code === "LIVE_SOURCE_CHANGED"),
    [{ sourceKind: "codex", homeId: HOME_ID, code: "LIVE_SOURCE_CHANGED", count: 1 }],
  );
  assert.deepEqual(changed.perfMeta.rankedHomeIds, []);
});
