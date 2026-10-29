import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { renderPerfModelsHtml } from "../public/perf-ui.js";
import { createUsageServer } from "../src/server.js";
import { buildUsageReport, summarizeUsage } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";

const T = Date.parse("2026-10-29T02:00:00Z");
const FILTERS = { preset: "all", now: new Date(T + 60_000), calendarZone: "utc" };

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-v4-"));
  const home = path.join(root, ".dsh");
  const file = path.join(home, "sessions", "project", "session", "session.v4.jsonl.zstd");
  const rows = [
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
      time: T + 2_200,
      data: {
        turn: 1,
        step: 1,
        message: { role: "assistant", source: { provider: "deepseek-account", model: "deepseek-flash" }, content: [] },
        usage: { inputTokens: 20, outputTokens: 101, totalTokens: 121 },
        stream: [
          { type: "reasoning-chunks", time0: T + 1_000, texts: ["a", "b"], dt: [500], index: 0 },
          { type: "text-chunks", time0: T + 2_000, texts: ["c"], dt: [], index: 1 },
          { type: "chunk", time: T + 2_100, chunk: { type: "usage", usage: { outputTokens: 101 } } },
          { type: "chunk", time: T + 2_200, chunk: { type: "finish", reason: { kind: "stop" } } },
        ],
      },
    },
    // No step/end: completed model output must be visible while its tools/agent step can continue.
  ];
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)));
  const options = {
    homeDir: root,
    env: {},
    importDirs: [home],
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
    databaseFile: path.join(root, "index.sqlite"),
  };
  const store = new UsageStore(options);
  try {
    await run({ root, file, options, store });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function assertSpeed(perf) {
  assert.equal(perf.meta.methodVersion, "tps-v4");
  assert.equal(perf.models.length, 1);
  assert.equal(perf.models[0].averageTps, 100);
  assert.equal(perf.models[0].n, 1);
  assert.equal(perf.models[0].p10, 100);
  assert.equal(perf.models[0].p90, 100);
  assert.equal(perf.models[0].rank, null);
  assert.equal(perf.groups[0].tokenScope, "all_generated_output");
  assert.equal(perf.coverage.sampled, 1);
}

test("DSH full generation reaches memory, SQLite, API and frozen snapshots before step/end", async () => {
  await fixture(async ({ file, options, store }) => {
    const bytes = await readFile(file);
    await store.sync();
    const indexed = await store.summarize(FILTERS);
    const memory = summarizeUsage(await buildUsageReport(options), FILTERS);
    assertSpeed(indexed.perf);
    assertSpeed(memory.perf);
    assert.deepEqual(memory.perf.models, indexed.perf.models);
    assert.deepEqual(memory.perf.groups, indexed.perf.groups);
    const native = store.database.prepare("SELECT output_tokens, duration_ms FROM perf_samples").get();
    assert.equal(native.output_tokens, 100);
    assert.equal(native.duration_ms, 1_000);
    store.close();
    const server = createUsageServer(options);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      let frozen;
      for (const route of [
        "summary?preset=all",
        "usage?preset=all&view=dashboard",
        "usage?preset=all&detail=full",
        "usage?preset=all&freeze=1",
      ]) {
        const response = await fetch(`${base}/api/${route}`);
        assert.equal(response.status, 200);
        const body = await response.json();
        assertSpeed(body.summary.perf);
        assert.deepEqual(body.summary.perf.models, indexed.perf.models);
        assert.doesNotMatch(JSON.stringify(body.summary.perf), /sampleKey|sourcePath|reasoning-chunks/);
        if (body.snapshotId) frozen = body;
      }
      const html = renderPerfModelsHtml(indexed.perf, { calendarZone: "utc" });
      assert.match(html, /100/);
      assert.doesNotMatch(html, /all_generated_output|reasoning|Magpie|警告|覆盖率/);
      const response = await fetch(`${base}/api/summary?preset=all&snapshot=${frozen.snapshotId}`);
      assert.deepEqual((await response.json()).summary.perf, frozen.summary.perf);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.deepEqual(await readFile(file), bytes);
  });
});

test("unchanged DSH files upgrade once from v3; a failed replacement retains its old fingerprint for retry", async () => {
  await fixture(async ({ file, store }) => {
    await store.sync();
    const bytes = await readFile(file);
    const info = await stat(file);
    const oldDigest = createHash("sha256").update("dsh:native-generation-v1").update(bytes).digest("hex").slice(0, 32);
    const oldFingerprint = `${info.size}:${info.mtimeMs}:${oldDigest}`;
    const readFingerprints = () =>
      JSON.parse(store.database.prepare("SELECT value FROM store_meta WHERE key='perf_file_fingerprints'").get().value);
    store.database
      .prepare("UPDATE store_meta SET value=? WHERE key='perf_file_fingerprints'")
      .run(JSON.stringify({ [file]: oldFingerprint }));
    store.database.prepare("UPDATE store_meta SET value='tps-v3' WHERE key='perf_method_version'").run();
    store.database.exec(
      "UPDATE perf_samples SET method_version='tps-v3', token_scope='non_reasoning_output', output_tokens=NULL, duration_ms=NULL",
    );
    store.close();
    await store.open();
    let replacements = 0;
    const replace = store.replaceFile.bind(store);
    store.replaceFile = async (...args) => {
      replacements += 1;
      return replace(...args);
    };
    store.database.exec(
      "CREATE TRIGGER dsh_v4_fail BEFORE INSERT ON perf_samples WHEN NEW.source_kind='dsh' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
    );
    await store.sync();
    assert.equal(replacements, 1);
    assert.equal(readFingerprints()[file], oldFingerprint);
    store.database.exec("DROP TRIGGER dsh_v4_fail");
    await store.sync();
    assert.equal(replacements, 2);
    assert.notEqual(readFingerprints()[file], oldFingerprint);
    assertSpeed((await store.summarize(FILTERS)).perf);
    await store.sync();
    assert.equal(replacements, 2);
    assert.deepEqual(await readFile(file), bytes);
  });
});
