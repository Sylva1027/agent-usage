import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { apply as installDshCapture } from "../scripts/dsh-output-capture.mjs";
import { appendOutputObservation, outputObservationFile } from "../src/perf-output-observations.js";
import { buildUsageReport, summarizeUsage } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";

const T = Date.parse("2026-10-30T04:00:00Z");
const filters = { preset: "all", now: new Date(T + 60_000), calendarZone: "utc" };
const lines = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scalar = {
  samplingWindowMs: 100,
  tokenizer: "o200k_base",
  outputTokens: 200,
  durationMs: 200,
  windows: [{ startMs: 1000, endMs: 1200, outputTokens: 200 }],
};

function options(root, home) {
  return {
    homeDir: root,
    env: {},
    importDirs: [home],
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
    databaseFile: path.join(root, "index.sqlite"),
  };
}

function dshRows(root) {
  return [
    { type: "session", version: 4, id: "session", cwd: root, createdAt: T, delegationDepth: 0 },
    {
      type: "request/header",
      seq: 1,
      time: T,
      data: { header: { config: { provider: "deepseek-account", model: "deepseek-flash", reasoningEffort: "max" } } },
    },
    { type: "step/start", seq: 2, time: T + 100, data: { turn: 1, step: 1 } },
    {
      type: "assistant/message",
      seq: 3,
      time: T + 2000,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "message",
          role: "assistant",
          source: { provider: "deepseek-account", model: "deepseek-flash" },
          content: [],
        },
        usage: { inputTokens: 20, outputTokens: 1100, totalTokens: 1120 },
        stream: [
          { type: "text-chunks", time0: T + 1000, texts: ["中".repeat(900), "中".repeat(200)], dt: [100], index: 0 },
          { type: "chunk", time: T + 1200, chunk: { type: "usage", usage: { outputTokens: 1100 } } },
          { type: "chunk", time: T + 1300, chunk: { type: "finish", reason: { kind: "stop" } } },
        ],
      },
    },
  ];
}

test("DSH transport capture binds committed message and late timing reaches memory and SQLite", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aligned-dsh-"));
  const home = path.join(root, ".dsh");
  const file = path.join(home, "sessions", "project", "session", "session.v4.jsonl.zstd");
  await mkdir(path.dirname(file), { recursive: true });
  const rows = dshRows(root);
  await writeFile(file, zstdCompressSync(Buffer.from(lines(rows))));
  const config = options(root, home);
  const store = new UsageStore(config);
  const handlers = new Map();
  let dispose;
  const errors = [];
  const ctx = {
    on: (event, listener) => {
      handlers.set(event, listener);
    },
    effect: (effect) => {
      dispose = effect();
    },
    logger: { debug: (...args) => errors.push(args) },
  };
  const send = (response, event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  const server = createServer(async (_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    send(response, { type: "message_start", message: { id: "wire-id", model: "deepseek-flash" } });
    send(response, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send(response, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "中".repeat(900) } });
    await delay(150);
    send(response, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "中".repeat(200) } });
    send(response, { type: "content_block_stop", index: 0 });
    send(response, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1100 } });
    send(response, { type: "message_stop" });
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await store.sync();
    assert.equal((await store.summarize(filters)).perf.models[0].n, 0);
    installDshCapture(ctx, { home });
    const session = { id: "session" };
    const agent = { session };
    const stream = handlers.get("llm/stream")({ sessionId: "session" }, () =>
      (async function* () {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/messages`);
        for await (const bytes of response.body) yield bytes;
      })(),
    );
    handlers.get("agent/assistant-stream")({ agent, frame: { type: "start", attemptId: "session:1" } });
    for await (const _chunk of stream) {
      /* The ordinary consumer receives unchanged bytes. */
    }
    await delay(150); // Downstream tool/commit wait must not enter the measured interval.
    handlers.get("session/event")(session, rows.at(-1));
    handlers.get("agent/assistant-stream")({
      agent,
      frame: {
        type: "end",
        attemptId: "session:1",
        outcome: { kind: "committed", eventType: "assistant/message", seq: 3 },
      },
    });
    await dispose();
    dispose = null;
    assert.deepEqual(errors, []);
    const raw = JSON.parse((await readFile(outputObservationFile(file, "dsh"), "utf8")).trim());
    assert.equal(raw.measurement.outputTokens, 200);
    assert.equal(raw.messageId, "message", "bind the committed local message, not a guessed wire ID");
    assert.equal(raw.sessionId, "session");
    assert.equal(JSON.stringify(raw).includes("中"), false);
    await store.sync();
    const indexed = await store.summarize(filters);
    const memory = summarizeUsage(await buildUsageReport(config), filters);
    for (const summary of [indexed, memory]) {
      assert.equal(summary.perf.methodVersion, "tps-v8");
      assert.equal(summary.perf.models[0].n, 1);
      assert.equal(summary.perf.models[0].averageTps, 200_000 / raw.measurement.durationMs);
    }
    assert.deepEqual(indexed.totals, memory.totals);
  } finally {
    await dispose?.();
    store.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkBuddy exact measurements refresh when the ledger or measurement method changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aligned-workbuddy-"));
  const home = path.join(root, ".workbuddy-ai");
  const file = path.join(home, "projects", "project", "session.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    lines([
      { type: "message", role: "user", sessionId: "session", __codebuddyLocal: {}, providerData: { agent: "cli" } },
      {
        type: "message",
        timestamp: T,
        role: "assistant",
        sessionId: "session",
        cwd: root,
        providerData: {
          messageId: "wire-id",
          model: "deepseek-flash",
          usage: { inputTokens: 20, outputTokens: 1100, totalTokens: 1120 },
        },
      },
    ]),
  );
  const config = options(root, home);
  const store = new UsageStore(config);
  try {
    await store.sync();
    assert.equal((await store.summarize(filters)).perf.models[0].n, 0);
    await appendOutputObservation(outputObservationFile(file, "workbuddy"), {
      schemaVersion: 2,
      sourceKind: "workbuddy",
      sessionId: "session",
      messageId: "wire-id",
      model: "deepseek-flash",
      clock: "transport_receive",
      measurement: scalar,
    });
    await store.sync();
    const indexed = await store.summarize(filters);
    const memory = summarizeUsage(await buildUsageReport(config), filters);
    for (const summary of [indexed, memory]) {
      assert.equal(summary.perf.models[0].n, 1);
      assert.equal(summary.perf.models[0].averageTps, 1000);
    }
    store.database.prepare("UPDATE perf_samples SET method_version='tps-v6' WHERE source_kind='workbuddy'").run();
    store.database.prepare("UPDATE store_meta SET value='tps-v6' WHERE key='perf_method_version'").run();
    const fingerprints = store.readPublishedFileFingerprints();
    const oldDigest = createHash("sha256")
      .update("workbuddy:visible-output-v1")
      .update(await readFile(file))
      .update(await readFile(outputObservationFile(file, "workbuddy")))
      .digest("hex")
      .slice(0, 32);
    fingerprints[file] = fingerprints[file].replace(/[^:]+$/, oldDigest);
    store.database
      .prepare("UPDATE store_meta SET value=? WHERE key='perf_file_fingerprints'")
      .run(JSON.stringify(fingerprints));
    store.close();
    await store.open();
    store.database.exec(
      "CREATE TRIGGER upgrade_fail BEFORE INSERT ON perf_samples WHEN NEW.source_kind='workbuddy' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    await store.sync();
    assert.equal(
      store.readPublishedFileFingerprints()[file],
      fingerprints[file],
      "failed upgrade must retain retry evidence",
    );
    store.database.exec("DROP TRIGGER upgrade_fail");
    await store.sync();
    const upgraded = await store.summarize(filters);
    assert.equal(upgraded.perf.methodVersion, "tps-v8");
    assert.equal(upgraded.perf.models[0].n, 1, "unchanged valid capture must be re-read after a method upgrade");
    assert.equal(upgraded.perf.models[0].averageTps, 1000);
    assert.deepEqual(upgraded.totals, indexed.totals);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
