import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { streamUsageFileEvents } from "../../src/usage-core.js";
import { streamDshSessionRows } from "../../src/dsh-usage.js";
import { createRemainingHarnessFixture, FIXTURE_TIME } from "../../test-support/remaining-harness-fixture.mjs";
import { C1_SOURCE_KINDS } from "./c1-source-mutations.mjs";
import { appendStabilityMutation, prepareStabilityMutations, restoreStabilityMutations, reviseStabilityMutation } from "./windows-stability-mutations.mjs";

const runtimeDirectory = fileURLToPath(new URL("../../", import.meta.url));
const APPEND_TIME = FIXTURE_TIME + 86_400_000;
const jsonCopy = (value) => JSON.parse(JSON.stringify(value));
const fields = ["total", "input", "cached", "output", "reasoning", "cacheWrite"];
const zero = () => Object.fromEntries([...fields, "events", "sessions"].map((key) => [key, 0]));

async function collect(plan) {
  const events = [], warnings = [];
  await streamUsageFileEvents(plan.filePath, plan.source, (event) => events.push(event), {
    repositoryResolver: (cwd) => ({ key: cwd, path: cwd, kind: "directory" }),
    onWarning: (warning) => warnings.push(warning),
  });
  assert.deepEqual(warnings, []);
  return events;
}

function totals(events) {
  const result = zero();
  for (const event of events) {
    for (const field of fields) result[field] += field === "cacheWrite" ? event.cacheWriteTokens || 0 : event.usage[field];
  }
  result.events = events.length;
  result.sessions = new Set(events.map((event) => event.sessionId)).size;
  return result;
}

const difference = (after, before) => Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "windows-stability-mutations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await mkdir(home);
  const sources = [];
  for (const kind of ["claude", "workbuddy", "zcode", "opencode"]) {
    sources.push({ kind, ...createRemainingHarnessFixture(path.join(home, kind), kind, 3) });
  }
  for (const kind of ["codex", "dsh"]) {
    const directory = path.join(home, kind);
    await mkdir(directory);
    const filePath = path.join(directory, kind === "codex" ? "rollout-tiny.jsonl" : "session.zstd");
    const cumulative = { input_tokens: 1010, cached_input_tokens: 102, output_tokens: 205,
      reasoning_output_tokens: 21, cache_write_input_tokens: 10, total_tokens: 1215 };
    const last = { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5,
      reasoning_output_tokens: 1, cache_write_input_tokens: 0, total_tokens: 15 };
    const row = (index, info) => ({ type: "event_msg", timestamp: new Date(FIXTURE_TIME + index).toISOString(),
      payload: { type: "token_count", info } });
    const rows = kind === "codex" ? [
      { type: "session_meta", payload: { id: "tiny-codex", cwd: "/fixture/project", source: "cli" } },
      row(0, { total_token_usage: Object.fromEntries(Object.entries(cumulative).map(([key, n]) => [key, n - last[key]])), last_token_usage: last }),
      row(1, { total_token_usage: cumulative, last_token_usage: last }),
      row(2, { last_token_usage: last }),
    ] : [
      { type: "session", version: 4, id: "tiny-dsh", cwd: "/fixture/project", createdAt: FIXTURE_TIME, delegationDepth: 0 },
      { type: "request/header", data: { header: { config: { model: "deepseek-chat", provider: "deepseek" } } } },
      ...[1, 2, 3].map((index) => ({ type: "assistant/message", seq: index, time: FIXTURE_TIME + index,
        data: { turn: index, step: 1, usage: { inputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 5, totalTokens: 15 } } })),
    ];
    const bytes = Buffer.from(rows.map((entry) => JSON.stringify(entry)).join("\n"));
    await writeFile(filePath, kind === "codex" ? bytes : zstdCompressSync(Buffer.concat([bytes, Buffer.from("\n")])));
    sources.push({ kind, filePath, source: { id: `fixture-${kind}`, label: `Fixture ${kind}`, kind, path: directory } });
  }
  const databaseFile = path.join(root, "seed.sqlite");
  const db = new DatabaseSync(databaseFile);
  try {
    db.exec(`CREATE TABLE source_files(path TEXT,kind TEXT,home_id TEXT,home_label TEXT,home_path TEXT,mtime_ms REAL);
      CREATE TABLE events(source_path TEXT,timestamp_ms INTEGER);`);
    for (const plan of sources) {
      const info = await stat(plan.filePath);
      db.prepare("INSERT INTO source_files VALUES(?,?,?,?,?,?)")
        .run(plan.filePath, plan.kind === "codex" ? "main" : plan.kind, plan.source.id, plan.source.label, plan.source.path, info.mtimeMs);
      for (const event of await collect(plan)) db.prepare("INSERT INTO events VALUES(?,?)").run(plan.filePath, event.timestampMs);
    }
  } finally { db.close(); }
  const dataset = { root, home };
  const directory = path.join(root, "mutations");
  return { root, home, dataset, databaseFile, directory };
}

test("six sources repeatedly append beyond ordinal 9, retain appends across two revisions, and restore", async (t) => {
  const f = await fixture(t);
  let ledger = await prepareStabilityMutations(f.dataset, f.directory, { databaseFile: f.databaseFile, runtimeDirectory });
  assert.deepEqual(ledger.plans.map((plan) => plan.kind), C1_SOURCE_KINDS);
  const before = new Map(), bytes = new Map();
  for (const plan of ledger.plans) {
    before.set(plan.kind, await collect(plan));
    bytes.set(plan.kind, await readFile(plan.filePath));
  }
  assert.equal(before.get("codex").length, 3);
  assert.equal(totals(before.get("codex")).total, 45, "initial cumulative baseline is not request usage");
  const backupsBefore = await readdir(path.join(f.directory, "originals"));
  assert.equal(backupsBefore.length, 6);
  const receipts = [];
  const append = async (ordinal, time = APPEND_TIME) => {
    const start = Date.now();
    const batch = await Promise.all(C1_SOURCE_KINDS.map((kind) => appendStabilityMutation(ledger, kind,
      { ordinal, timestampMs: time, category: ordinal < 3 ? "ordinary" : "burst" })));
    const end = Date.now();
    for (const receipt of batch) {
      assert.equal(receipt.ordinal, ordinal);
      assert.equal(receipt.timestampMs, time);
      assert.equal(receipt.expectedDelta, 160);
      assert.equal(receipt.expectedEventDelta, 1);
      assert.ok(start <= receipt.startedAtMs && receipt.startedAtMs <= receipt.landedAtMs && receipt.landedAtMs <= end);
    }
    receipts.push(...batch);
  };
  await append(0);
  await append(1);
  const firstRevision = await reviseStabilityMutation(ledger);
  assert.equal(firstRevision.expectedDelta, 19);
  await append(100);
  ledger = jsonCopy(ledger);
  const secondRevision = await reviseStabilityMutation(ledger, { outputDelta: -7 });
  assert.equal(secondRevision.expectedDelta, -7);
  assert.equal(secondRevision.expectedEventDelta, 0);
  assert.equal(secondRevision.identity, firstRevision.identity);
  assert.equal(secondRevision.timestampMs, firstRevision.timestampMs);
  await append(10_000, APPEND_TIME - 86_400_000 + 1);
  assert.equal(ledger.appendCount, 24);
  assert.equal(ledger.revisionCount, 2);
  assert.deepEqual(ledger.expected, { total: 3852, events: 24, sessions: 0, input: 3360, cached: 720,
    output: 492, reasoning: 80, cacheWrite: 240 });
  for (const plan of ledger.plans) {
    const after = await collect(plan);
    assert.deepEqual(difference(totals(after), totals(before.get(plan.kind))), ledger.byKind[plan.kind].expected);
    assert.equal(after.length, before.get(plan.kind).length + 4);
    const kindReceipts = receipts.filter((receipt) => receipt.kind === plan.kind);
    const appended = plan.kind === "codex" ? after.slice(-4) : kindReceipts.map((receipt) =>
      after.find((event) => (event.eventId ?? event.messageId) === receipt.identity));
    assert.deepEqual(appended.map((event) => event.timestampMs), [APPEND_TIME, APPEND_TIME, APPEND_TIME, APPEND_TIME - 86_400_000 + 1]);
    for (const event of appended) {
      assert.deepEqual(event.usage, { total: 160, input: 140, cached: 30, output: 20,
        reasoning: plan.kind === "dsh" || plan.kind === "claude" ? 0 : 5 });
      assert.equal(event.cacheWriteTokens, 10);
    }
    const ids = receipts.filter((receipt) => receipt.kind === plan.kind).map((receipt) => receipt.identity);
    assert.equal(new Set(ids).size, 4);
    if (plan.kind !== "codex") {
      const actualIds = after.map((event) => event.eventId ?? event.messageId);
      assert.equal(new Set(actualIds).size, after.length);
      for (const id of ids) assert.ok(actualIds.includes(id));
    }
    if (["codex", "claude", "workbuddy"].includes(plan.kind)) {
      assert.deepEqual((await readFile(plan.filePath)).subarray(0, bytes.get(plan.kind).length), bytes.get(plan.kind));
    }
    assert.equal(ledger.byKind[plan.kind].appendCount, 4);
  }
  const codex = ledger.plans.find((plan) => plan.kind === "codex");
  const lastCodex = JSON.parse((await readFile(codex.filePath, "utf8")).trimEnd().split("\n").at(-1));
  assert.equal(lastCodex.payload.info.total_token_usage.total_tokens, 1215 + 640);
  assert.equal(lastCodex.payload.info.total_token_usage.cache_write_input_tokens, 50);
  const dsh = ledger.plans.find((plan) => plan.kind === "dsh");
  const dshRows = [];
  for await (const row of streamDshSessionRows(dsh.filePath)) if (row.type === "assistant/message") dshRows.push(row);
  assert.deepEqual(dshRows.slice(-4).map((row) => row.seq), [4, 5, 6, 7]);
  assert.deepEqual(dshRows.slice(-4).map((row) => row.data.turn), [4, 5, 6, 7]);
  assert.equal(dshRows.at(-1).data.usage.inputTokens, 100);
  assert.deepEqual(await readdir(path.join(f.directory, "originals")), backupsBefore, "one backup per source, regardless of input count");
  assert.deepEqual((await readdir(f.directory)).sort(), ["ledger.json", "mutations.ndjson", "originals"]);
  const journal = (await readFile(path.join(f.directory, "mutations.ndjson"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(journal.length, 26);
  assert.equal(journal.reduce((n, entry) => n + entry.expectedDelta, 0), ledger.expected.total);
  const restored = await restoreStabilityMutations(jsonCopy(ledger));
  assert.equal(restored.length, 6);
  for (const plan of ledger.plans) {
    assert.deepEqual(await readFile(plan.filePath), bytes.get(plan.kind));
    assert.deepEqual(await collect(plan), before.get(plan.kind));
    assert.ok(Math.abs((await stat(plan.filePath)).mtimeMs - plan.mtimeMs) < 1);
  }
});

test("same-source overlap serializes; duplicate IDs and invalid revisions leave counts and bytes intact", async (t) => {
  const f = await fixture(t);
  const ledger = await prepareStabilityMutations(f.dataset, f.directory, { databaseFile: f.databaseFile });
  const results = await Promise.allSettled([0, 0, 500].map((ordinal) =>
    appendStabilityMutation(ledger, "codex", { ordinal, timestampMs: APPEND_TIME })));
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.match(results[1].reason.message, /duplicate/);
  assert.equal(ledger.expected.events, 2);
  const zcode = ledger.plans.find((plan) => plan.kind === "zcode");
  const original = await readFile(zcode.filePath);
  await assert.rejects(reviseStabilityMutation(ledger, { outputDelta: -1000 }), /invalid token counter/);
  assert.equal(ledger.revisionCount, 0);
  assert.deepEqual(await readFile(zcode.filePath), original);
  await assert.rejects(appendStabilityMutation(ledger, "codex", { ordinal: 3, timestampMs: NaN }), /timestampMs/);
  const pending = appendStabilityMutation(ledger, "codex", { ordinal: 4, timestampMs: APPEND_TIME });
  await restoreStabilityMutations(ledger);
  await pending;
  assert.equal(ledger.expected.events, 3);
  assert.throws(() => appendStabilityMutation(ledger, "codex", { ordinal: 5 }), /closing or restored/);
});
