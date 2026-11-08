import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, lstat, open, realpath, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { streamDshSessionRows } from "../../src/dsh-usage.js";
import { C1_SOURCE_KINDS, prepareC1Mutations, restoreC1Mutations } from "./c1-source-mutations.mjs";

const queues = new WeakMap();
const runtimeDefault = fileURLToPath(new URL("../../", import.meta.url));
const rawUsage = { input_tokens: 140, cached_input_tokens: 30, output_tokens: 20,
  reasoning_output_tokens: 5, cache_write_input_tokens: 10, total_tokens: 160 };
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const emptyDelta = () => ({ total: 0, events: 0, sessions: 0, input: 0, cached: 0, output: 0, reasoning: 0, cacheWrite: 0 });
const appendDelta = (kind) => ({ total: 160, events: 1, sessions: 0, input: 140, cached: 30, output: 20,
  reasoning: kind === "dsh" || kind === "claude" ? 0 : 5, cacheWrite: 10 });

function timestamp(value) {
  assert.ok(Number.isSafeInteger(value) && value > 0 && value < 8.64e15, "invalid timestampMs");
  return value;
}

async function isolatedHome(home) {
  const resolved = path.resolve(home);
  const actual = await realpath(resolved);
  assert.equal(actual.toLowerCase(), resolved.toLowerCase(), "dataset.home must be an isolated directory");
  assert.ok(!/(?:^|[\\/])captures?(?:-[^\\/]+)?(?:[\\/]|$)/i.test(actual), "refuse frozen capture mutation");
  assert.ok(inside(tmpdir(), actual) || (!inside(homedir(), actual) && !/^[a-z]:[\\/]users[\\/]/i.test(actual)),
    "refuse active user source mutation");
  return actual;
}

async function verifySource(plan) {
  const info = await lstat(plan.filePath);
  assert.ok(info.isFile() && !info.isSymbolicLink() && Number(info.nlink) === 1, "source must be an isolated regular copy");
  assert.equal((await realpath(plan.filePath)).toLowerCase(), path.resolve(plan.filePath).toLowerCase(), "source path changed");
  assert.ok(inside(plan.datasetHome, plan.filePath), "source escaped dataset.home");
}

function enqueue(ledger, kind, action) {
  assert.equal(ledger.version, 1, "unsupported mutation ledger");
  assert.ok(!ledger.restoring && !ledger.restoredAtMs, "mutation ledger is closing or restored");
  assert.ok(C1_SOURCE_KINDS.includes(kind), "unsupported source kind");
  let pending = queues.get(ledger);
  if (!pending) queues.set(ledger, pending = new Map());
  const next = (pending.get(kind) ?? Promise.resolve()).then(action);
  pending.set(kind, next.catch(() => {}));
  return next;
}

async function codexBaseline(filePath) {
  let cumulative = Object.fromEntries(Object.keys(rawUsage).map((field) => [field, 0]));
  const input = createReadStream(filePath);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const value = row?.payload?.info?.total_token_usage;
      if (row?.type !== "event_msg" || row.payload?.type !== "token_count" || !value) continue;
      cumulative = Object.fromEntries(Object.keys(rawUsage).map((field) => [field, Number(value[field] ?? 0)]));
      assert.ok(Object.values(cumulative).every((n) => Number.isSafeInteger(n) && n >= 0), "unsupported Codex cumulative counter");
    }
  } finally { lines.close(); input.destroy(); }
  return cumulative;
}

/** One starting backup per selected source. expected/byKind are deltas from that starting point. */
export async function prepareStabilityMutations(dataset, directory, {
  databaseFile = path.join(dataset.root, "seed-state", "usage-index.sqlite"),
  runtimeDirectory = runtimeDefault,
} = {}) {
  const home = await isolatedHome(dataset.home);
  assert.ok(!inside(home, path.resolve(directory)), "mutation output must be outside dataset.home");
  const plans = await prepareC1Mutations(dataset, { databaseFile, runtimeDirectory, directory });
  const state = {};
  for (const plan of plans) {
    state[plan.kind] = { ordinals: [], expected: emptyDelta(), appendCount: 0, revisionCount: 0 };
    if (plan.kind === "codex") state.codex.cumulative = await codexBaseline(plan.filePath);
    if (plan.kind === "dsh") {
      let seq = 0, turn = 0, sessionId;
      for await (const row of streamDshSessionRows(plan.filePath)) {
        if (row?.type === "session") sessionId = row.id;
        const identity = Number(row?.seq ?? (row?.type === "assistant/message" ? row.time : 0));
        if (Number.isFinite(identity)) seq = Math.max(seq, identity);
        turn = Math.max(turn, Number(row?.data?.turn) || 0);
      }
      assert.ok(sessionId && Number.isSafeInteger(seq) && Number.isSafeInteger(turn), "unsupported DSH identity counters");
      Object.assign(state.dsh, { seq, turn, sessionId });
    }
  }
  const ledger = { version: 1, runId: randomUUID(), directory: path.resolve(directory), plans, byKind: state,
    entries: [], expected: emptyDelta(), appendCount: 0, revisionCount: 0, restoredAtMs: null };
  await writeFile(path.join(ledger.directory, "ledger.json"), `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx" });
  await writeFile(path.join(ledger.directory, "mutations.ndjson"), "", { flag: "wx" });
  return ledger;
}

async function appendLines(filePath, rows) {
  const handle = await open(filePath, "r+");
  try {
    const { size } = await handle.stat();
    const last = Buffer.alloc(1);
    if (size) await handle.read(last, 0, 1, size - 1);
    const prefix = size && last[0] !== 10 ? "\n" : "";
    await appendFile(filePath, `${prefix}${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  } finally { await handle.close(); }
}

function sqlChange(filePath, action) {
  const db = new DatabaseSync(filePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    const result = action(db);
    db.exec("COMMIT");
    return result;
  } finally {
    try { if (db.isTransaction) db.exec("ROLLBACK"); } finally { db.close(); }
  }
}

// Match the delivery fixture's real payloads without its per-append full-source scan.
function deliveryRow(plan, id, timestampMs, sequence) {
  const raw = structuredClone(plan.deliveryPlan.original.raw);
  const sessionId = plan.deliveryPlan.original.sessionId;
  if (plan.kind === "claude") {
    Object.assign(raw, { sessionId, timestamp: new Date(timestampMs).toISOString(), uuid: id });
    raw.message = { ...raw.message, id, model: "claude-sonnet-4-5-20250929", content: [], usage: {
      input_tokens: 100, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 20,
      output_tokens_details: { thinking_tokens: 0 }, service_tier: "standard",
    } };
  } else if (plan.kind === "workbuddy") {
    Object.assign(raw, { sessionId, timestamp: timestampMs, uuid: id, content: "" });
    raw.providerData = { ...raw.providerData, messageId: id, model: "deepseek-v4.1-flash", requestModelName: "deepseek-v4.1-flash",
      usage: { inputTokens: 140, outputTokens: 20, totalTokens: 160,
        inputTokensDetails: [{ cached_tokens: 30 }], outputTokensDetails: [{ reasoning_tokens: 5 }] },
      rawUsage: { input_tokens: 140, output_tokens: 20, total_tokens: 160, cache_creation_input_tokens: 10 } };
  } else if (plan.kind === "zcode") {
    Object.assign(raw, { id, session_id: sessionId, started_at: timestampMs, completed_at: timestampMs,
      input_tokens: 140, output_tokens: 20, model_id: "gpt-6-sol" });
    const fields = { logical_request_id: id, assistant_message_id: id, first_token_at: timestampMs,
      duration_ms: 0, time_to_first_token_ms: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 10,
      reasoning_tokens: 5, computed_total_tokens: 160, provider_total_tokens: 160,
      raw_usage_json: JSON.stringify({ input_tokens: 140, output_tokens: 20, total_tokens: 160,
        reasoning_tokens: 5, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 }) };
    for (const [key, value] of Object.entries(fields)) if (Object.hasOwn(raw, key)) raw[key] = value;
  } else {
    const data = JSON.parse(raw.data);
    data.time = { ...data.time, created: timestampMs, completed: timestampMs };
    data.model = { ...data.model, id: "gpt-6-sol" };
    data.tokens = { input: 100, output: 15, reasoning: 5, cache: { read: 30, write: 10 } };
    if (Object.hasOwn(data, "id")) data.id = id;
    if (Object.hasOwn(data, "content")) data.content = [];
    Object.assign(raw, { id, session_id: sessionId, seq: sequence, time_created: timestampMs, data: JSON.stringify(data) });
    if (Object.hasOwn(raw, "time_updated")) raw.time_updated = timestampMs;
  }
  return raw;
}

async function record(ledger, receipt, delta) {
  const state = ledger.byKind[receipt.kind];
  receipt.expectedDelta = receipt.deltaTotal = delta.total;
  receipt.expectedEventDelta = receipt.deltaEvents = delta.events;
  receipt.deltaSessions = delta.sessions;
  receipt.deltaTokens = Object.fromEntries(Object.entries(delta).filter(([field]) => !["total", "events", "sessions"].includes(field)));
  for (const field of Object.keys(delta)) {
    ledger.expected[field] += delta[field];
    state.expected[field] += delta[field];
  }
  const counter = receipt.operation === "append" ? "appendCount" : "revisionCount";
  ledger[counter]++;
  state[counter]++;
  ledger.entries.push(receipt);
  await appendFile(path.join(ledger.directory, "mutations.ndjson"), `${JSON.stringify(receipt)}\n`);
  return receipt;
}

export function appendStabilityMutation(ledger, kind, { ordinal, timestampMs = Date.now(), category = "ordinary" } = {}) {
  return enqueue(ledger, kind, async () => {
    timestamp(timestampMs);
    assert.ok(Number.isSafeInteger(ordinal) && ordinal >= 0, "ordinal must be a non-negative safe integer");
    const state = ledger.byKind[kind];
    assert.ok(!state.ordinals.includes(ordinal), `duplicate ${kind} ordinal ${ordinal}`);
    const plan = ledger.plans.find((entry) => entry.kind === kind);
    await verifySource(plan);
    const id = `windows-stability-${ledger.runId}-${kind}-${ordinal}`;
    const sizeBefore = (await stat(plan.filePath)).size;
    const startedAtMs = Date.now();
    let identity = id, cumulative, seq, turn;
    if (kind === "codex") {
      cumulative = Object.fromEntries(Object.entries(rawUsage).map(([field, value]) => [field, state.cumulative[field] + value]));
      assert.ok(Object.values(cumulative).every(Number.isSafeInteger), "Codex cumulative counter overflow");
      const time = new Date(timestampMs).toISOString();
      await appendLines(plan.filePath, [
        { timestamp: time, type: "turn_context", payload: { model: "gpt-6-sol" } },
        { id, timestamp: time, type: "event_msg", payload: { type: "token_count", info: {
          total_token_usage: cumulative, last_token_usage: rawUsage,
        } } },
      ]);
      state.cumulative = cumulative;
    } else if (kind === "dsh") {
      seq = state.seq + 1;
      turn = state.turn + 1;
      assert.ok(Number.isSafeInteger(seq) && Number.isSafeInteger(turn), "DSH identity counter overflow");
      const rows = [
        { type: "request/header", time: timestampMs, data: { header: plan.dshHeader } },
        { type: "assistant/message", seq, time: timestampMs, surfaceOp: "append", data: { turn, step: 1,
          message: { content: [] }, usage: { inputTokens: 100, cacheReadTokens: 30, cacheWriteTokens: 10,
            outputTokens: 20, totalTokens: 160, reasoningTokens: 0 } } },
      ];
      await appendFile(plan.filePath, zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)));
      Object.assign(state, { seq, turn });
      identity = `${state.sessionId}:${seq}`;
    } else {
      const sequence = kind === "opencode" ? plan.deliveryPlan.sequenceBase + state.appendCount + 1 : undefined;
      if (kind === "opencode") assert.ok(Number.isSafeInteger(sequence), "OpenCode sequence overflow");
      const raw = deliveryRow(plan, id, timestampMs, sequence);
      if (kind === "claude" || kind === "workbuddy") await appendLines(plan.filePath, [raw]);
      else sqlChange(plan.filePath, (db) => {
        const fields = Object.keys(raw);
        const table = kind === "zcode" ? "model_usage" : "session_message";
        db.prepare(`INSERT INTO ${table} (${fields.map(quote).join(",")}) VALUES (${fields.map(() => "?").join(",")})`).run(...Object.values(raw));
      });
      if (kind === "opencode") identity = `${raw.session_id}:${raw.seq}`;
    }
    const landedAtMs = Date.now();
    state.ordinals.push(ordinal);
    return record(ledger, { operation: "append", kind, ordinal, timestampMs, category, startedAtMs, landedAtMs,
      filePath: plan.filePath, identity, id, sizeBefore, sizeAfter: (await stat(plan.filePath)).size,
      ...(cumulative ? { cumulative } : {}), ...(seq ? { seq, turn } : {}) }, appendDelta(kind));
  });
}

/** Revise the same old ZCode row cumulatively; outputDelta may be negative. */
export function reviseStabilityMutation(ledger, { kind = "zcode", outputDelta = 19, category = "revision" } = {}) {
  assert.equal(kind, "zcode", "historical revision supports ZCode only");
  assert.ok(Number.isSafeInteger(outputDelta) && outputDelta !== 0, "outputDelta must be a non-zero safe integer");
  return enqueue(ledger, kind, async () => {
    const plan = ledger.plans.find((entry) => entry.kind === kind);
    await verifySource(plan);
    const original = plan.deliveryPlan.original;
    const state = ledger.byKind[kind];
    const before = state.revisedRaw ?? original.raw;
    const startedAtMs = Date.now();
    const after = sqlChange(plan.filePath, (db) => {
      const row = db.prepare("SELECT * FROM model_usage WHERE id=?").get(original.raw.id);
      assert.ok(row, "old revision target is missing");
      assert.deepEqual({ ...row }, { ...before }, "old revision target changed outside the ledger");
      const changes = { output_tokens: Number(row.output_tokens) + outputDelta };
      for (const field of ["computed_total_tokens", "provider_total_tokens"]) {
        if (row[field] !== null && row[field] !== undefined && row[field] !== "" && Number.isFinite(Number(row[field]))) {
          changes[field] = Number(row[field]) + outputDelta;
        }
      }
      assert.ok(Object.values(changes).every((n) => Number.isSafeInteger(n) && n >= 0), "revision would make an invalid token counter");
      if (row.raw_usage_json) {
        const usage = JSON.parse(row.raw_usage_json);
        for (const field of ["output_tokens", "total_tokens"]) {
          if (Number.isFinite(usage[field])) usage[field] += outputDelta;
        }
        changes.raw_usage_json = JSON.stringify(usage);
      }
      const result = db.prepare(`UPDATE model_usage SET ${Object.keys(changes).map((field) => `${quote(field)}=?`).join(",")} WHERE id=?`)
        .run(...Object.values(changes), original.raw.id);
      assert.equal(result.changes, 1, "revision must update exactly one old row");
      return { ...row, ...changes };
    });
    const landedAtMs = Date.now();
    state.revisedRaw = after;
    return record(ledger, { operation: "revision", kind, ordinal: state.revisionCount + 1,
      timestampMs: original.timestampMs, category, startedAtMs, landedAtMs, filePath: plan.filePath,
      identity: original.identity, outputDelta }, { ...emptyDelta(), total: outputDelta, output: outputDelta });
  });
}

/** Stop all readers/writers before restoring; retain backups and the audit journal. */
export async function restoreStabilityMutations(ledger) {
  assert.equal(ledger.version, 1, "unsupported mutation ledger");
  assert.ok(!ledger.restoring, "restore already in progress");
  ledger.restoring = true;
  try {
    await Promise.all(queues.get(ledger)?.values() ?? []);
    const restored = await restoreC1Mutations(ledger.plans);
    ledger.restoredAtMs = Date.now();
    await appendFile(path.join(ledger.directory, "mutations.ndjson"), `${JSON.stringify({ operation: "restore", landedAtMs: ledger.restoredAtMs, restored })}\n`);
    return restored;
  } finally { ledger.restoring = false; }
}
