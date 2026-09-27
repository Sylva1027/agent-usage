import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadServiceTierEvidence } from "../src/service-tier-evidence.js";
import { buildUsageReport } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";

const threadId = "thread-a";
const timestamp = (value) => Date.parse(value) / 1000;
const submission = (operation, tier, userText = "") =>
  `session_loop{thread_id=${threadId}}: Submission sub=Submission { id: "test", op: ${operation} { request: { input: UserInput { content: [Text { text: ${JSON.stringify(userText)} }] }, service_tier: ${tier}, collaboration_mode: None } } }`;

test("turn evidence identifies Fast and Standard while request input determines long context", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-usage-tier-"));
  const codexHome = path.join(root, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "09", "24");
  const databaseFile = path.join(root, "usage-index.sqlite");
  try {
    await mkdir(sessionDir, { recursive: true });
    const log = new DatabaseSync(path.join(codexHome, "logs_2.sqlite"));
    log.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)");
    const insert = log.prepare("INSERT INTO logs (ts, ts_nanos, thread_id, target, feedback_log_body) VALUES (?, 0, ?, 'codex_core::session::handlers', ?)");
    insert.run(timestamp("2026-09-24T10:01:00Z"), threadId, submission("TurnInput", 'Some(Some("priority"))', 'service_tier: Some(Some("default")), collaboration_mode: None'));
    insert.run(timestamp("2026-09-24T10:02:00Z"), threadId, submission("TurnInput", 'Some(Some("default"))'));
    insert.run(timestamp("2026-09-24T10:03:00Z"), threadId, submission("TurnInput", "None"));
    log.close();

    const usage = (input, cumulative, responseTier = null) => ({
      type: "token_count",
      info: {
        ...(cumulative ? { total_token_usage: { total_tokens: cumulative, input_tokens: cumulative, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 } } : {}),
        last_token_usage: { total_tokens: input, input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 },
        ...(responseTier ? { response: { service_tier: responseTier } } : {}),
      },
      ...(responseTier ? { service_tier: "priority" } : {}),
    });
    const rows = [
      { timestamp: "2026-09-24T10:00:00Z", type: "session_meta", payload: { id: threadId, source: "cli", originator: "codex-tui", cwd: root } },
      { timestamp: "2026-09-24T10:00:01Z", type: "turn_context", payload: { model: "gpt-6-sol" } },
      { timestamp: "2026-09-24T10:01:05Z", type: "event_msg", payload: usage(300_000, 300_000) },
      { timestamp: "2026-09-24T10:02:05Z", type: "event_msg", payload: usage(100_000, 400_000) },
      { timestamp: "2026-09-24T10:03:05Z", type: "event_msg", payload: usage(272_001, null, "default") },
    ];
    const firstFile = path.join(sessionDir, "rollout-a.jsonl");
    const secondFile = path.join(sessionDir, "rollout-b.jsonl");
    await writeFile(firstFile, `${rows.slice(0, 3).map((row) => JSON.stringify(row)).join("\n")}\n`);
    await writeFile(secondFile, `${[rows[0], rows[1], ...rows.slice(3)].map((row) => JSON.stringify(row)).join("\n")}\n`);
    const home = { id: "main", label: "Test", path: codexHome, kind: "main" };
    const evidence = loadServiceTierEvidence([home]);
    assert.equal(evidence.resolve(threadId, Date.parse("2026-09-24T10:01:05Z")), "priority");
    assert.equal(evidence.resolve(threadId, Date.parse("2026-09-24T10:02:05Z")), "default");
    assert.equal(evidence.resolve(threadId, Date.parse("2026-09-24T10:03:05Z"), "default"), "default");

    const report = await buildUsageReport({ homes: [home] });
    assert.deepEqual(report.events.map((event) => event.serviceTier), ["priority", "default", "default"]);
    assert.deepEqual(report.events.map((event) => event.contextLevel), ["long", "short", "long"]);
    assert.equal(report.events[2].requestInputTokens, 272_001);

    const store = new UsageStore({ homeDir: root, databaseFile });
    try {
      await store.sync({ options: { homeDir: root } });
      const summary = store.summarize({ preset: "all", bucket: "day" });
      assert.ok(Math.abs(summary.costEstimate.totalUsd - 3.688004) < 1e-9);
      assert.equal(summary.costEstimate.serviceTierUnknownRecords, 0);
      assert.equal(summary.costEstimate.contextUnknownRecords, 0);
      assert.equal(summary.totals.total, 672_001);
      rows[2].payload.info.total_token_usage.total_tokens = 320_000;
      rows[2].payload.info.total_token_usage.input_tokens = 320_000;
      rows[2].payload.info.last_token_usage.total_tokens = 320_000;
      rows[2].payload.info.last_token_usage.input_tokens = 320_000;
      await writeFile(firstFile, `${rows.slice(0, 3).map((row) => JSON.stringify(row)).join("\n")}\n`);
      const refreshed = await store.sync({ options: { homeDir: root } });
      assert.equal(refreshed.updatedFileCount, 2);
      assert.equal(store.summarize({ preset: "all", bucket: "day" }).totals.total, 672_001);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
