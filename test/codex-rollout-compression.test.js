import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { constants, zstdCompressSync } from "node:zlib";
import { openRolloutStream } from "../src/codex-rollout.js";
import {
  buildUsageIndex,
  buildUsageReport,
  discoverSessionFiles,
  parseSessionFile,
  summarizeUsage,
  summarizeUsageIndex,
} from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";
import { readCodexRolloutMetadata } from "../src/perf-sources/codex-jsonl.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";
import { createUsageExecutor } from "../src/usage-executor.js";

async function usageFixture() {
  const fixture = createPerfCodexIntegrationFixture();
  for (const file of fixture.rolloutFiles)
    await writeFile(file, (await readFile(file, "utf8")).replaceAll("codex-fixture-model", "gpt-6-astra"));
  await appendFile(
    fixture.rolloutFiles[0],
    JSON.stringify({
      timestamp: "2026-10-04T12:20:00Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 100, input_tokens: 80, output_tokens: 20 } },
      },
    }) + "\n",
  );
  return fixture;
}

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-zst-test-"));
  t.after(async () => {
    assert.ok(path.basename(root).startsWith("codex-zst-test-"));
    await rm(root, { recursive: true, force: true });
  });
  return root;
}
async function collect(file) {
  const chunks = [];
  for await (const chunk of openRolloutStream(file)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

test("compressed rollout reads every frame, skippable metadata and UTF-8 across frames", async (t) => {
  const root = await temporary(t),
    file = path.join(root, "rollout.jsonl.zst");
  const bytes = Buffer.from('{"text":"中文"}\n');
  const split = bytes.indexOf(Buffer.from("中文")) + 1;
  const metadata = Buffer.alloc(12);
  metadata.writeUInt32LE(0x184d2a50);
  metadata.writeUInt32LE(4, 4);
  metadata.writeUInt32LE(0xfd2fb528, 8);
  await writeFile(
    file,
    Buffer.concat([zstdCompressSync(bytes.subarray(0, split)), metadata, zstdCompressSync(bytes.subarray(split))]),
  );
  assert.deepEqual(await collect(file), bytes);
});

test("compressed rollout rejects every intra-frame truncation, garbage, bad checksum and invalid UTF-8", async (t) => {
  const file = path.join(await temporary(t), "rollout.jsonl.zst");
  const frame = zstdCompressSync(Buffer.from('{"tokens":123}\n'));
  for (let cut = 0; cut < frame.length; cut++) {
    await writeFile(file, frame.subarray(0, cut));
    await assert.rejects(collect(file));
  }
  const crc = zstdCompressSync(Buffer.from("payload\n"), { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
  crc[crc.length - 1] ^= 1;
  for (const invalid of [
    Buffer.concat([frame, Buffer.from("junk")]),
    crc,
    zstdCompressSync(Buffer.from([0xff])),
    zstdCompressSync(Buffer.from([0xe4, 0xb8])),
  ]) {
    await writeFile(file, invalid);
    await assert.rejects(collect(file));
  }
});

test("compressed rollout JSON errors fail both usage and TPS readers instead of dropping lines", async (t) => {
  const root = await temporary(t),
    file = path.join(root, "rollout.jsonl.zst");
  await writeFile(file, zstdCompressSync(Buffer.from('{"type":"session_meta","payload":{"id":"test"}}\nBROKEN\n')));
  await assert.rejects(
    parseSessionFile(file, { id: "test", label: "test", path: root }),
    /Invalid compressed rollout JSON/,
  );
  await assert.rejects(readCodexRolloutMetadata(file), /Invalid compressed rollout JSON/);
});

test("legal Unicode separators in JSON stay inside one record in both representations", async (t) => {
  const root = await temporary(t);
  const bytes = Buffer.from(
    `${JSON.stringify({ type: "session_meta", payload: { id: "unicode", cwd: "a\u2028b\u2029c" } })}\r\n${JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-astra" } })}\n${JSON.stringify({ timestamp: "2026-10-04T12:00:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 100, input_tokens: 80, output_tokens: 20 } } } })}`,
  );
  const plain = path.join(root, "rollout.jsonl"),
    compressed = `${plain}.zst`;
  await writeFile(plain, bytes);
  await writeFile(compressed, zstdCompressSync(bytes));
  const home = { id: "home", label: "home", path: root };
  const a = await parseSessionFile(plain, home),
    b = await parseSessionFile(compressed, home);
  assert.equal(a.events[0].cwd, "a\u2028b\u2029c");
  assert.deepEqual(a.events, b.events);
  assert.deepEqual((await readCodexRolloutMetadata(plain)).stats, (await readCodexRolloutMetadata(compressed)).stats);
});

test("discovery selects one physical representation in active and archived directories", async (t) => {
  const home = await temporary(t);
  await mkdir(path.join(home, "sessions"));
  await mkdir(path.join(home, "archived_sessions"));
  const file = path.join(home, "sessions", "rollout.jsonl");
  await writeFile(file, "{}\n");
  await writeFile(`${file}.zst`, zstdCompressSync(Buffer.from("{}\n")));
  const archive = path.join(home, "archived_sessions", "older.jsonl.zst");
  await writeFile(archive, zstdCompressSync(Buffer.from("{}\n")));
  assert.deepEqual(await discoverSessionFiles(home), [archive, file].sort());
  await rm(file);
  assert.deepEqual(await discoverSessionFiles(home), [archive, `${file}.zst`].sort());
});

test("plain/compressed transitions preserve usage, cost, quota and TPS across report, index and store", async () => {
  const fixture = await usageFixture();
  const store = new UsageStore(fixture.serverOptions);
  const filters = { preset: "all", now: new Date("2026-10-04T13:00:00Z") };
  try {
    await store.sync();
    const baseline = store.summarize(filters, { includeDetails: false });
    const originals = new Map();
    for (const file of fixture.rolloutFiles) {
      const bytes = await readFile(file);
      originals.set(file, bytes);
      await writeFile(`${file}.zst`, zstdCompressSync(bytes));
      await rm(file);
    }
    await store.sync();
    const compressed = store.summarize(filters, { includeDetails: false });
    for (const field of ["totals", "models", "costEstimate", "quota"])
      assert.deepEqual(compressed[field], baseline[field], field);
    assert.deepEqual(compressed.perf.groups, baseline.perf.groups);
    assert.deepEqual(compressed.perf.coverage, baseline.perf.coverage);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM source_files").get().n, fixture.rolloutFiles.length);
    assert.equal(store.database.prepare("PRAGMA foreign_key_check").all().length, 0);
    const report = summarizeUsage(await buildUsageReport(fixture.serverOptions), filters);
    const index = summarizeUsageIndex(await buildUsageIndex(fixture.serverOptions), filters);
    assert.deepEqual(report.totals, baseline.totals);
    assert.deepEqual(index.totals, baseline.totals);
    assert.deepEqual(report.costEstimate, baseline.costEstimate);
    assert.deepEqual(index.costEstimate, baseline.costEstimate);
    assert.deepEqual(report.perf.groups, baseline.perf.groups);
    await store.sync();
    assert.deepEqual(store.summarize(filters).totals, baseline.totals);
    for (const [file, bytes] of originals) await writeFile(file, bytes);
    await store.sync();
    assert.deepEqual(store.summarize(filters).totals, baseline.totals);
    assert.equal(store.database.prepare("SELECT COUNT(*) AS n FROM source_files").get().n, fixture.rolloutFiles.length);
    await appendFile(
      fixture.rolloutFiles.at(-1),
      `${JSON.stringify({ timestamp: "2026-10-04T12:20:00Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 100, input_tokens: 80, output_tokens: 20 } } } })}\n`,
    );
    await store.sync();
    assert.equal(store.summarize(filters).totals.total, baseline.totals.total + 100);
  } finally {
    store.close();
    fixture.close();
  }
});

test("reader upgrade preserves existing events and re-reads Codex sources only once", async () => {
  const fixture = await usageFixture();
  let store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync();
    const before = store.summarize({ preset: "all" }).totals;
    store.database.exec("DELETE FROM store_meta WHERE key='codex_rollout_reader_version'");
    store.close();
    store = new UsageStore(fixture.serverOptions);
    await store.open();
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE size=-1").get().n,
      fixture.rolloutFiles.length,
    );
    assert.deepEqual(store.summarize({ preset: "all" }).totals, before);
    await store.sync();
    assert.deepEqual(store.summarize({ preset: "all" }).totals, before);
    assert.equal((await store.sync()).updatedFileCount, 0);
  } finally {
    store.close();
    fixture.close();
  }
});

test("a compressed source changed after reading cannot commit its replacement", async () => {
  const fixture = await usageFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync();
    const before = store.summarize({ preset: "all" }).totals;
    const file = fixture.rolloutFiles[0],
      compressed = `${file}.zst`;
    await writeFile(compressed, zstdCompressSync(await readFile(file)));
    await rm(file);
    const resolver = store.repositoryResolver;
    let changed = false;
    store.repositoryResolver = async (cwd) => {
      if (!changed) {
        changed = true;
        await new Promise((resolve) => setTimeout(resolve, 10));
        await appendFile(compressed, "junk");
      }
      return resolver(cwd);
    };
    await assert.rejects(
      store.replaceFile({
        filePath: compressed,
        source: store.homes.find((x) => x.path === fixture.codexHome),
        info: await stat(compressed),
      }),
    );
    assert.deepEqual(store.summarize({ preset: "all" }).totals, before);
    assert.ok(store.database.prepare("SELECT path FROM source_files WHERE path=?").get(file));
  } finally {
    store.close();
    fixture.close();
  }
});

test("failed compressed representation replacement keeps the previous committed usage", async () => {
  const fixture = await usageFixture();
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync();
    const before = store.summarize({ preset: "all" }).totals;
    const file = fixture.rolloutFiles[0],
      frame = zstdCompressSync(await readFile(file));
    await writeFile(`${file}.zst`, frame.subarray(0, -2));
    await rm(file);
    await store.sync();
    assert.deepEqual(store.summarize({ preset: "all" }).totals, before);
    assert.ok(store.database.prepare("SELECT path FROM source_files WHERE path=?").get(file));
    assert.equal(store.database.prepare("SELECT path FROM source_files WHERE path=?").get(`${file}.zst`), undefined);
    assert.ok(store.warnings.length > 0);
  } finally {
    store.close();
    fixture.close();
  }
});

test("dashboard queries read the committed WAL view while a background sync is still running", async () => {
  const fixture = await usageFixture();
  const executor = createUsageExecutor(fixture.serverOptions);
  try {
    await executor.sync({ options: fixture.serverOptions });
    const filters = { preset: "all", now: new Date("2026-10-04T13:00:00Z") };
    const baseline = await executor.dashboard(filters, { includeDetails: false });
    const dir = path.dirname(fixture.rolloutFiles[0]);
    const header = '{"type":"session_meta","payload":{"id":"background-thread"}}\n';
    const padding = '{"type":"response_item","payload":{"type":"message","content":[]}}\n'.repeat(150000);
    const token = `${JSON.stringify({
      timestamp: "2026-10-04T12:01:00Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { last_token_usage: { total_tokens: 100, input_tokens: 80, output_tokens: 20 } },
      },
    })}\n`;
    await writeFile(path.join(dir, "background.jsonl.zst"), zstdCompressSync(Buffer.from(header + padding + token)));
    let completed = false;
    const syncing = executor.sync({ options: fixture.serverOptions }).then(() => {
      completed = true;
    });
    const during = await executor.dashboard(filters, { includeDetails: false });
    assert.equal(completed, false, "a range query must finish before the background sync");
    assert.deepEqual(during.summary.totals, baseline.summary.totals);
    assert.equal(during.metadata.eventCount, baseline.metadata.eventCount);
    await syncing;
    const after = await executor.dashboard(filters, { includeDetails: false });
    assert.equal(after.summary.totals.total, baseline.summary.totals.total + 100);
    assert.equal(after.metadata.eventCount, baseline.metadata.eventCount + 1);
  } finally {
    await executor.close();
    fixture.close();
  }
});
