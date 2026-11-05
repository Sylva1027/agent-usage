import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export const KINDS = ["claude", "workbuddy", "zcode", "opencode"];
const adapters = {
  claude: ["claude-code-usage.js", "streamClaudeSessionEvents"],
  workbuddy: ["workbuddy-usage.js", "streamWorkbuddySessionEvents"],
  zcode: ["zcode-usage.js", "streamZcodeDbEvents"],
  opencode: ["opencode-usage.js", "streamOpencodeDbEvents"],
};
const known = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0;
const token = (value) => known(value) ? Number(value) : 0;
const text = (value) => typeof value === "string" ? value.trim() : "";
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

function jsonLines(bytes) {
  const lines = [];
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(10, start);
    const end = newline < 0 ? bytes.length : newline;
    const contentEnd = end > start && bytes[end - 1] === 13 ? end - 1 : end;
    let raw;
    try { raw = JSON.parse(bytes.subarray(start, contentEnd).toString("utf8")); } catch { /* Non-record lines stay byte-for-byte intact. */ }
    lines.push({ start, end: contentEnd, raw });
    start = newline < 0 ? bytes.length : newline + 1;
  }
  return lines;
}

function usageFor(kind, raw) {
  if (kind === "workbuddy" || kind === "zcode") {
    const u = kind === "workbuddy" ? raw.providerData.usage : raw;
    const input = token(kind === "workbuddy" ? u.inputTokens : u.input_tokens);
    const output = token(kind === "workbuddy" ? u.outputTokens : u.output_tokens);
    const total = kind === "workbuddy" ? u.totalTokens : u.computed_total_tokens ?? u.provider_total_tokens;
    return { total: known(total) ? Number(total) : input + output, input, output,
      cached: token(kind === "workbuddy" ? u.inputTokensDetails?.[0]?.cached_tokens : u.cache_read_input_tokens),
      reasoning: token(kind === "workbuddy" ? u.outputTokensDetails?.[0]?.reasoning_tokens : u.reasoning_tokens) };
  }
  const u = kind === "claude" ? raw.message.usage : JSON.parse(raw.data).tokens;
  const cached = token(kind === "claude" ? u.cache_read_input_tokens : u.cache?.read);
  const input = token(kind === "claude" ? u.input_tokens : u.input) + cached + token(kind === "claude" ? u.cache_creation_input_tokens : u.cache?.write);
  const reasoning = token(kind === "claude" ? u.output_tokens_details?.thinking_tokens : u.reasoning);
  const output = token(kind === "claude" ? u.output_tokens : u.output) + (kind === "opencode" ? reasoning : 0);
  return { total: input + output, input, output, cached, reasoning };
}

// This literal reader deliberately does not import any adapter or accounting code.
async function sourceEvents(kind, filePath) {
  assert.ok(KINDS.includes(kind), "unsupported harness kind");
  if (kind === "claude" || kind === "workbuddy") {
    const groups = new Map();
    const lines = jsonLines(await readFile(filePath));
    for (const [lineIndex, { raw }] of lines.entries()) {
      if (!raw || typeof raw !== "object") continue;
      let identity, sessionId, timestampMs, key;
      if (kind === "claude") {
        if (raw.type !== "assistant" || !raw.message?.usage) continue;
        key = String(raw.message.id || "").trim() || String(raw.uuid || "");
        identity = String(raw.message.id || raw.uuid || "");
        sessionId = String(raw.sessionId || "").trim();
        timestampMs = Date.parse(raw.timestamp);
        if (!key || !sessionId || !Number.isFinite(timestampMs)) continue;
      } else {
        const p = raw.providerData;
        key = identity = text(p?.messageId);
        if (!key || groups.has(key) || !["message", "function_call"].includes(text(raw.type)) || !p.usage ||
          text(p.model) === "default-model" || text(p.requestModelName).toLowerCase() === "auto") continue;
        timestampMs = typeof raw.timestamp === "number" ? raw.timestamp : Date.parse(String(raw.timestamp ?? ""));
        if (!Number.isFinite(timestampMs)) continue;
        assert.ok(Math.abs(timestampMs) <= 8.64e15, "unsupported WorkBuddy timestamp");
        sessionId = text(raw.sessionId) || path.basename(filePath, ".jsonl");
      }
      const usage = usageFor(kind, raw);
      if (kind === "claude" && !Object.values(usage).some(Boolean)) continue;
      if (!groups.has(key) || usage.total > groups.get(key).usage.total) {
        groups.set(key, { identity, sessionId, timestampMs, usage, raw, lineIndex });
      }
    }
    return [...groups.values()];
  }
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    const versions = new Map();
    if (kind === "opencode" && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_v2'").get()) {
      for (const row of db.prepare("SELECT id, version FROM session_v2").all()) versions.set(row.id, row.version);
    }
    const rows = db.prepare(kind === "zcode" ? "SELECT * FROM model_usage ORDER BY completed_at, id" :
      "SELECT * FROM session_message WHERE type='assistant' ORDER BY time_created, seq").all();
    const events = [];
    for (const raw of rows) {
      let timestampMs, sessionId, identity;
      if (kind === "zcode") {
        timestampMs = [raw.completed_at, raw.started_at].map(Number).find((n) => Number.isFinite(n) && n > 0);
        sessionId = String(raw.session_id || "").trim() || `zcode:${raw.id}`;
        identity = String(raw.id || `${sessionId}:${timestampMs}`);
      } else {
        let data;
        try { data = JSON.parse(raw.data); } catch { continue; }
        if (!data?.tokens || typeof data.tokens !== "object") continue;
        sessionId = String(raw.session_id || "").trim() || String(raw.id || "").trim();
        if (!sessionId) continue;
        const version = String(versions.get(sessionId) ?? "").trim();
        const major = version ? Number(version.split(".")[0]) : NaN;
        if (Number.isInteger(major) && major >= 0 && major < 2) continue;
        timestampMs = [data.time?.completed, data.time?.created, raw.time_created].map(Number).find((n) => Number.isFinite(n) && n > 0);
        identity = `${sessionId}:${raw.seq ?? timestampMs}`;
      }
      if (timestampMs === undefined) continue;
      const usage = usageFor(kind, raw);
      if (Object.values(usage).some(Boolean)) events.push({ identity, sessionId, timestampMs, usage, raw });
    }
    return events;
  } finally { db.close(); }
}

export async function accountSource({ kind, filePath }) {
  const events = await sourceEvents(kind, filePath);
  return { total: events.reduce((sum, event) => sum + event.usage.total, 0), eventCount: events.length,
    sessionCount: new Set(events.map((event) => event.sessionId)).size };
}

const within = (root, file) => { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
async function mutationPath(filePath) {
  const resolved = path.resolve(filePath);
  const actual = await realpath(resolved);
  assert.equal(actual.toLowerCase(), resolved.toLowerCase(), "source must be an isolated regular copy");
  assert.ok(!/(?:^|[\\/])captures?(?:-[^\\/]+)?[\\/]/i.test(actual), "refuse frozen capture mutation");
  assert.ok(within(tmpdir(), actual) || (!within(homedir(), actual) && !/^[a-z]:[\\/]users[\\/]/i.test(actual)), "refuse active user source mutation");
  return actual;
}

export async function planChanges({ kind, filePath, source, runtimeDirectory, appendTimeMs }) {
  assert.ok(KINDS.includes(kind), "unsupported harness kind");
  assert.ok(Number.isSafeInteger(appendTimeMs) && appendTimeMs > 0 && appendTimeMs < 8.64e15 - 10000, "invalid append time");
  filePath = await mutationPath(filePath);
  const [module, method] = adapters[kind];
  const stream = (await import(pathToFileURL(path.join(runtimeDirectory, "src", module)).href))[method];
  let selected;
  await stream(filePath, source, (event) => { selected ??= event; }, {
    repositoryResolver: (cwd) => ({ key: cwd, path: cwd, kind: "directory" }),
  });
  assert.ok(selected, "source has no normalized event to revise");
  const original = (await sourceEvents(kind, filePath)).find((event) =>
    event.identity === String(selected.eventId ?? selected.messageId) && event.sessionId === selected.sessionId &&
    event.timestampMs === selected.timestampMs && event.usage.total === selected.usage.total);
  assert.ok(original, "unsupported source metadata: normalized event has no matching raw winner");
  assert.ok(original.timestampMs < appendTimeMs, "revision must target an old event");
  assert.ok(Object.values(original.raw).every((value) => typeof value !== "bigint" && !(value instanceof Uint8Array)), "unsupported SQLite metadata type");
  if (kind === "zcode" || kind === "opencode") assert.ok(typeof original.raw.id === "string" && original.raw.id, "unsupported SQLite event ID");
  if (kind === "zcode") assert.ok(["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "reasoning_tokens", "model_id"]
    .every((field) => Object.hasOwn(original.raw, field)), "unsupported ZCode token columns");
  const output = kind === "claude" ? original.raw.message.usage.output_tokens : kind === "workbuddy" ?
    original.raw.providerData.usage.outputTokens : kind === "zcode" ? original.raw.output_tokens : JSON.parse(original.raw.data).tokens.output;
  assert.ok(known(output), "unsupported original output counter");
  let sequenceBase;
  if (kind === "opencode") {
    const db = new DatabaseSync(filePath, { readOnly: true });
    try { sequenceBase = Number(db.prepare("SELECT MAX(seq) AS n FROM session_message WHERE session_id=?").get(original.raw.session_id).n); }
    finally { db.close(); }
    assert.ok(Number.isSafeInteger(sequenceBase), "unsupported OpenCode sequence");
  }
  const idPrefix = `remaining-delivery-${kind}-${createHash("sha256").update(`${original.identity}:${appendTimeMs}`).digest("hex").slice(0, 16)}`;
  return { kind, filePath, appendTimeMs, original, idPrefix, ...(sequenceBase === undefined ? {} : { sequenceBase }) };
}

function appendRow(plan, ordinal) {
  const { kind } = plan;
  const raw = structuredClone(plan.original.raw);
  const id = `${plan.idPrefix}-${ordinal}`;
  const timestamp = plan.appendTimeMs + ordinal * 1000;
  if (kind === "claude") {
    raw.sessionId = plan.original.sessionId;
    raw.timestamp = new Date(timestamp).toISOString();
    raw.uuid = id;
    raw.message = { ...raw.message, id, model: "claude-sonnet-4-5-20250929", content: [], usage: {
      input_tokens: 100, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 20,
      output_tokens_details: { thinking_tokens: 0 }, service_tier: "standard",
    } };
  } else if (kind === "workbuddy") {
    raw.sessionId = plan.original.sessionId;
    raw.timestamp = timestamp;
    raw.uuid = id;
    raw.content = "";
    raw.providerData = { ...raw.providerData, messageId: id, model: "deepseek-v4.1-flash", requestModelName: "deepseek-v4.1-flash",
      usage: { inputTokens: 140, outputTokens: 20, totalTokens: 160,
        inputTokensDetails: [{ cached_tokens: 30 }], outputTokensDetails: [{ reasoning_tokens: 5 }] },
      rawUsage: { input_tokens: 140, output_tokens: 20, total_tokens: 160, cache_creation_input_tokens: 10 } };
  } else if (kind === "zcode") {
    Object.assign(raw, { id, session_id: plan.original.sessionId, started_at: timestamp, completed_at: timestamp,
      input_tokens: 140, output_tokens: 20, model_id: "gpt-6-sol" });
    const fields = { logical_request_id: id, assistant_message_id: id, first_token_at: timestamp,
      duration_ms: 0, time_to_first_token_ms: 0, cache_read_input_tokens: 30, cache_creation_input_tokens: 10,
      reasoning_tokens: 5, computed_total_tokens: 160, provider_total_tokens: 160,
      raw_usage_json: JSON.stringify({ input_tokens: 140, output_tokens: 20, total_tokens: 160, reasoning_tokens: 5,
        cache_read_input_tokens: 30, cache_creation_input_tokens: 10 }) };
    for (const [field, value] of Object.entries(fields)) if (Object.hasOwn(raw, field)) raw[field] = value;
  } else {
    const data = JSON.parse(raw.data);
    data.time = { ...data.time, created: timestamp, completed: timestamp };
    data.model = { ...data.model, id: "gpt-6-sol" };
    data.tokens = { input: 100, output: 15, reasoning: 5, cache: { read: 30, write: 10 } };
    if (Object.hasOwn(data, "id")) data.id = id;
    if (Object.hasOwn(data, "content")) data.content = [];
    Object.assign(raw, { id, session_id: plan.original.sessionId, seq: plan.sequenceBase + ordinal + 1,
      time_created: timestamp, data: JSON.stringify(data) });
    if (Object.hasOwn(raw, "time_updated")) raw.time_updated = timestamp;
  }
  return { raw, identity: kind === "opencode" ? `${raw.session_id}:${raw.seq}` : id };
}

function sqlChange(filePath, action) {
  const db = new DatabaseSync(filePath);
  try {
    db.exec("BEGIN IMMEDIATE");
    action(db);
    db.exec("COMMIT");
    return Date.now();
  } finally {
    try { if (db.isTransaction) db.exec("ROLLBACK"); } finally { db.close(); }
  }
}

export async function appendChange(plan, ordinal) {
  assert.ok(Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < 10, "invalid append ordinal");
  await mutationPath(plan.filePath);
  const { raw, identity } = appendRow(plan, ordinal);
  const existing = await sourceEvents(plan.kind, plan.filePath);
  assert.ok(!existing.some((event) => event.identity === identity), "append identity already exists");
  let payload;
  if (plan.kind === "claude" || plan.kind === "workbuddy") {
    const bytes = await readFile(plan.filePath);
    const eol = bytes.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
    const terminated = bytes.length === 0 || bytes.at(-1) === 10;
    payload = `${terminated ? "" : eol}${JSON.stringify(raw)}${terminated ? eol : ""}`;
  }
  const startedAtMs = Date.now();
  let landedAtMs;
  if (payload !== undefined) {
    await appendFile(plan.filePath, payload);
    landedAtMs = Date.now();
  } else {
    landedAtMs = sqlChange(plan.filePath, (db) => {
      const table = plan.kind === "zcode" ? "model_usage" : "session_message";
      const fields = Object.keys(raw);
      db.prepare(`INSERT INTO ${table} (${fields.map(quote).join(",")}) VALUES (${fields.map(() => "?").join(",")})`).run(...Object.values(raw));
    });
  }
  return { startedAtMs, landedAtMs, deltaTotal: 160, deltaEvents: 1, deltaSessions: 0, identity };
}

export async function reviseChange(plan) {
  await mutationPath(plan.filePath);
  const { kind, original } = plan;
  let replacement, bytes, line;
  if (kind === "claude" || kind === "workbuddy") {
    bytes = await readFile(plan.filePath);
    line = jsonLines(bytes)[original.lineIndex];
    assert.ok(line?.raw && JSON.stringify(line.raw) === JSON.stringify(original.raw), "original JSONL event changed since planning");
    const raw = line.raw;
    if (kind === "claude") raw.message.usage.output_tokens = Number(raw.message.usage.output_tokens) + 19;
    else {
      const u = raw.providerData.usage;
      u.outputTokens = Number(u.outputTokens) + 19;
      if (known(u.totalTokens)) u.totalTokens = Number(u.totalTokens) + 19;
    }
    replacement = Buffer.from(JSON.stringify(raw));
  }
  const startedAtMs = Date.now();
  let landedAtMs;
  if (replacement) {
    const temporary = `${plan.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, Buffer.concat([bytes.subarray(0, line.start), replacement, bytes.subarray(line.end)]), { flag: "wx" });
      await rename(temporary, plan.filePath);
      landedAtMs = Date.now();
    } catch (error) {
      await unlink(temporary).catch((cleanupError) => { if (cleanupError.code !== "ENOENT") throw cleanupError; });
      throw error;
    }
  } else {
    landedAtMs = sqlChange(plan.filePath, (db) => {
      const table = kind === "zcode" ? "model_usage" : "session_message";
      const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(original.raw.id);
      assert.ok(row && JSON.stringify(row) === JSON.stringify(original.raw), "original SQLite event changed since planning");
      let changes;
      if (kind === "zcode") {
        changes = { output_tokens: Number(row.output_tokens) + 19 };
        for (const field of ["computed_total_tokens", "provider_total_tokens"]) if (known(row[field])) changes[field] = Number(row[field]) + 19;
      } else {
        const data = JSON.parse(row.data);
        data.tokens.output = Number(data.tokens.output) + 19;
        changes = { data: JSON.stringify(data) };
      }
      const result = db.prepare(`UPDATE ${table} SET ${Object.keys(changes).map((field) => `${quote(field)}=?`).join(",")} WHERE id=?`).run(...Object.values(changes), original.raw.id);
      assert.equal(result.changes, 1, "revision must update exactly one original row");
    });
  }
  return { startedAtMs, landedAtMs, deltaTotal: 19, deltaEvents: 0, deltaSessions: 0, identity: original.identity };
}
