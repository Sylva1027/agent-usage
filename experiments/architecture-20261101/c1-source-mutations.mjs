import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  appendFile,
  copyFile,
  lstat,
  mkdir,
  open,
  realpath,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

import { streamDshSessionRows } from "../../src/dsh-usage.js";
import { appendChange, planChanges, reviseChange } from "./remaining-harness-delivery-fixture.mjs";

export const C1_SOURCE_KINDS = Object.freeze(["codex", "dsh", "claude", "workbuddy", "zcode", "opencode"]);

const CODEX_KINDS = new Set(["codex", "main", "extra", "jetbrains"]);
const DELIVERY_KINDS = new Set(["claude", "workbuddy", "zcode", "opencode"]);
const SQLITE_SIDECARS = ["-wal", "-shm", "-journal"];
const COPY_EXCLUSIVE = fsConstants.COPYFILE_EXCL;
const APPEND_TOKENS = Object.freeze({
  codex: Object.freeze({ input: 140, cached: 30, output: 20, reasoning: 5, cacheWrite: 10 }),
  dsh: Object.freeze({ input: 140, cached: 30, output: 20, reasoning: 0, cacheWrite: 10 }),
  claude: Object.freeze({ input: 140, cached: 30, output: 20, reasoning: 0, cacheWrite: 10 }),
  workbuddy: Object.freeze({ input: 140, cached: 30, output: 20, reasoning: 5, cacheWrite: 10 }),
  zcode: Object.freeze({ input: 140, cached: 30, output: 20, reasoning: 5, cacheWrite: 10 }),
  opencode: Object.freeze({ input: 140, cached: 30, output: 20, reasoning: 5, cacheWrite: 10 }),
});
const REVISION_TOKENS = Object.freeze({ input: 0, cached: 0, output: 19, reasoning: 0, cacheWrite: 0 });

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function canonicalKind(kind) {
  if (CODEX_KINDS.has(kind)) return "codex";
  return C1_SOURCE_KINDS.includes(kind) ? kind : null;
}

function requiredString(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.trim(), `${label} must not be empty`);
  return value;
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) hash.update(bytes);
  return hash.digest("hex");
}

async function inspectDshHeader(filePath) {
  let header = null;
  for await (const row of streamDshSessionRows(filePath)) {
    if (!row || typeof row !== "object") continue;
    if ((row.type === "request/header" || row.type === "request/context") && row.data?.header) {
      header = structuredClone(row.data.header);
    }
  }
  assert.ok(header, `DSH source has no request header to carry forward: ${filePath}`);
  return { dshHeader: header };
}

async function validatedSource(filePath, homePath) {
  requiredString(filePath, "source file path");
  requiredString(homePath, "dataset home");
  assert.ok(path.isAbsolute(filePath), "source file path must be absolute");
  const resolved = path.resolve(filePath);
  const link = await lstat(resolved);
  assert.ok(link.isFile() && !link.isSymbolicLink(), "source must be a regular file");
  const actual = await realpath(resolved);
  assert.ok(inside(homePath, actual), "source must be inside dataset.home");
  const info = await stat(actual);
  assert.ok(info.isFile(), "source must be a regular file");
  assert.equal(Number(info.nlink), 1, "source must have exactly one filesystem link");
  return { filePath: actual, info };
}

async function clearSqliteSidecars(filePath) {
  for (const suffix of SQLITE_SIDECARS) {
    try {
      await unlink(`${filePath}${suffix}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function selectable(kind, filePath) {
  const lower = filePath.toLowerCase();
  if (kind === "codex") return lower.endsWith(".jsonl");
  if (kind === "dsh") return lower.endsWith(".zstd");
  return true;
}

function selectSources(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT sf.path, sf.kind, sf.home_id, sf.home_label, sf.home_path, sf.mtime_ms,
          MAX(e.timestamp_ms) AS latest_event_ms
         FROM source_files sf
         JOIN events e ON e.source_path = sf.path
         GROUP BY sf.path, sf.kind, sf.home_id, sf.home_label, sf.home_path, sf.mtime_ms`,
      )
      .all();
    const selected = new Map();
    for (const row of rows) {
      const kind = canonicalKind(String(row.kind));
      if (!kind || !selectable(kind, String(row.path))) continue;
      const candidate = {
        kind,
        path: String(row.path),
        homeId: String(row.home_id),
        homeLabel: String(row.home_label),
        homePath: String(row.home_path),
        mtimeMs: Number(row.mtime_ms),
        latestEventMs: Number(row.latest_event_ms),
      };
      const previous = selected.get(kind);
      if (
        !previous ||
        candidate.latestEventMs > previous.latestEventMs ||
        (candidate.latestEventMs === previous.latestEventMs && candidate.mtimeMs > previous.mtimeMs) ||
        (candidate.latestEventMs === previous.latestEventMs &&
          candidate.mtimeMs === previous.mtimeMs &&
          candidate.path.localeCompare(previous.path) < 0)
      ) {
        selected.set(kind, candidate);
      }
    }
    const missing = C1_SOURCE_KINDS.filter((kind) => !selected.has(kind));
    assert.deepEqual(missing, [], `missing usable C1 sources: ${missing.join(", ")}`);
    return selected;
  } finally {
    database.close();
  }
}

function sourceFor(candidate) {
  return {
    id: candidate.homeId,
    label: candidate.homeLabel,
    path: candidate.homePath,
    kind: candidate.kind,
  };
}

function baseReceipt(kind, startedAtMs, landedAtMs, deltaTokens) {
  return {
    kind,
    startedAtMs,
    landedAtMs,
    deltaTotal: 160,
    deltaEvents: 1,
    deltaSessions: 0,
    deltaTokens: { ...deltaTokens },
  };
}

function revisionReceipt(kind, startedAtMs, landedAtMs) {
  return {
    kind,
    startedAtMs,
    landedAtMs,
    deltaTotal: 19,
    deltaEvents: 0,
    deltaSessions: 0,
    deltaTokens: { ...REVISION_TOKENS },
  };
}

function validateOrdinal(ordinal) {
  assert.ok(Number.isSafeInteger(ordinal) && ordinal >= 0 && ordinal < 10, "ordinal must be an integer from 0 to 9");
}

async function verifyPlan(plan, { backup = false } = {}) {
  assert.ok(plan && typeof plan === "object", "mutation plan must be an object");
  assert.ok(C1_SOURCE_KINDS.includes(plan.kind), "mutation plan kind is invalid");
  requiredString(plan.datasetHome, "plan.datasetHome");
  requiredString(plan.originalsDirectory, "plan.originalsDirectory");
  requiredString(plan.filePath, "plan.filePath");
  requiredString(plan.backupFile, "plan.backupFile");
  assert.ok(inside(plan.datasetHome, plan.filePath), "planned source escaped dataset.home");
  assert.ok(inside(plan.originalsDirectory, plan.backupFile), "planned backup escaped originals");
  const source = await validatedSource(plan.filePath, plan.datasetHome);
  if (!samePath(source.filePath, plan.filePath)) throw new Error("planned source path changed");
  if (backup) {
    const backupInfo = await lstat(plan.backupFile);
    assert.ok(backupInfo.isFile() && !backupInfo.isSymbolicLink(), "backup must be a regular file");
    assert.equal(Number((await stat(plan.backupFile)).nlink), 1, "backup must have one filesystem link");
    assert.equal(await hashFile(plan.backupFile), plan.sha256, "original backup checksum changed");
  }
  return source;
}

async function fileEndsWithNewline(filePath) {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (info.size === 0) return true;
    const byte = Buffer.alloc(1);
    await handle.read(byte, 0, 1, info.size - 1);
    return byte[0] === 10;
  } finally {
    await handle.close();
  }
}

async function appendCodex(plan) {
  const startedAtMs = Date.now();
  const timestamp = new Date(startedAtMs).toISOString();
  const prefix = (await fileEndsWithNewline(plan.filePath)) ? "" : "\n";
  const usage = APPEND_TOKENS.codex;
  const payload = `${prefix}${JSON.stringify({
    timestamp,
    type: "turn_context",
    payload: { model: "gpt-6-sol" },
  })}\n${JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: usage.input,
          cached_input_tokens: usage.cached,
          output_tokens: usage.output,
          reasoning_output_tokens: usage.reasoning,
          cache_write_input_tokens: usage.cacheWrite,
          total_tokens: 160,
        },
      },
    },
  })}\n`;
  await appendFile(plan.filePath, payload);
  return baseReceipt("codex", startedAtMs, Date.now(), usage);
}

async function appendDsh(plan, ordinal) {
  const timestamp = Date.now();
  const seq = timestamp * 10 + ordinal;
  assert.ok(Number.isSafeInteger(seq), "DSH append sequence exceeds safe integer range");
  const usage = APPEND_TOKENS.dsh;
  const rows = [
    {
      type: "request/header",
      time: timestamp,
      data: { header: structuredClone(plan.dshHeader) },
    },
    {
      type: "assistant/message",
      seq,
      time: timestamp,
      surfaceOp: "append",
      data: {
        turn: timestamp,
        step: ordinal,
        message: { content: [] },
        usage: {
          inputTokens: 100,
          cacheReadTokens: usage.cached,
          cacheWriteTokens: usage.cacheWrite,
          outputTokens: usage.output,
          totalTokens: 160,
          reasoningTokens: 0,
        },
      },
    },
  ];
  const frame = zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`));
  const startedAtMs = Date.now();
  await appendFile(plan.filePath, frame);
  return baseReceipt("dsh", startedAtMs, Date.now(), usage);
}

export async function prepareC1Mutations(dataset, { databaseFile, runtimeDirectory, directory } = {}) {
  assert.ok(dataset && typeof dataset === "object", "dataset must be an object");
  requiredString(dataset.home, "dataset.home");
  requiredString(databaseFile, "databaseFile");
  requiredString(runtimeDirectory, "runtimeDirectory");
  requiredString(directory, "directory");
  const datasetHome = await realpath(dataset.home);
  const databaseInfo = await stat(databaseFile);
  assert.ok(databaseInfo.isFile(), "databaseFile must be a regular file");
  const runtimeInfo = await stat(runtimeDirectory);
  assert.ok(runtimeInfo.isDirectory(), "runtimeDirectory must be a directory");
  const selected = selectSources(databaseFile);
  const originalsDirectory = path.join(path.resolve(directory), "originals");
  await mkdir(originalsDirectory, { recursive: true });
  const appendTimeMs = Date.now() - 60_000;
  const plans = [];

  for (const [index, kind] of C1_SOURCE_KINDS.entries()) {
    const candidate = selected.get(kind);
    const sourceFile = await validatedSource(candidate.path, datasetHome);
    const sha256 = await hashFile(sourceFile.filePath);
    const source = sourceFor(candidate);
    const backupFile = path.join(
      originalsDirectory,
      `${String(index + 1).padStart(2, "0")}-${kind}-${path.basename(sourceFile.filePath)}`,
    );
    await copyFile(sourceFile.filePath, backupFile, COPY_EXCLUSIVE);
    await utimes(backupFile, sourceFile.info.atimeMs / 1000, sourceFile.info.mtimeMs / 1000);
    assert.equal(await hashFile(backupFile), sha256, "prepared backup checksum differs from source");

    const plan = {
      kind,
      datasetHome,
      originalsDirectory,
      filePath: sourceFile.filePath,
      backupFile,
      source,
      sha256,
      mtimeMs: candidate.mtimeMs,
      size: sourceFile.info.size,
      latestEventMs: candidate.latestEventMs,
    };
    if (kind === "dsh") {
      Object.assign(plan, await inspectDshHeader(sourceFile.filePath));
    } else if (kind !== "codex") {
      plan.deliveryPlan = await planChanges({
        kind,
        filePath: sourceFile.filePath,
        source,
        runtimeDirectory,
        appendTimeMs,
      });
    }
    plans.push(plan);
  }
  assert.deepEqual(plans.map((plan) => plan.kind), C1_SOURCE_KINDS);
  return plans;
}

export async function appendC1Mutation(plan, ordinal = 1) {
  validateOrdinal(ordinal);
  await verifyPlan(plan);
  if (plan.kind === "codex") return appendCodex(plan);
  if (plan.kind === "dsh") return appendDsh(plan, ordinal);
  assert.ok(DELIVERY_KINDS.has(plan.kind), "mutation kind is unsupported");
  const result = await appendChange(plan.deliveryPlan, ordinal);
  return baseReceipt(plan.kind, result.startedAtMs, result.landedAtMs, APPEND_TOKENS[plan.kind]);
}

export async function reviseC1Mutation(plan) {
  await verifyPlan(plan);
  assert.equal(plan.kind, "zcode", "C1 revision supports ZCode only");
  const result = await reviseChange(plan.deliveryPlan);
  return revisionReceipt(plan.kind, result.startedAtMs, result.landedAtMs);
}

export async function restoreC1Mutations(plans) {
  assert.ok(Array.isArray(plans), "plans must be an array");
  assert.equal(plans.length, C1_SOURCE_KINDS.length, "restore requires exactly six plans");
  const kinds = new Set(plans.map((plan) => plan?.kind));
  assert.equal(kinds.size, C1_SOURCE_KINDS.length, "restore plans must have unique kinds");
  for (const kind of C1_SOURCE_KINDS) assert.ok(kinds.has(kind), `restore plan missing ${kind}`);
  for (const plan of plans) await verifyPlan(plan, { backup: true });

  const restored = [];
  for (const kind of C1_SOURCE_KINDS) {
    const plan = plans.find((candidate) => candidate.kind === kind);
    await clearSqliteSidecars(plan.filePath);
    await copyFile(plan.backupFile, plan.filePath);
    await utimes(plan.filePath, plan.mtimeMs / 1000, plan.mtimeMs / 1000);
    await clearSqliteSidecars(plan.filePath);
    const current = await stat(plan.filePath);
    assert.equal(Number(current.nlink), 1, "restored source must have one filesystem link");
    assert.ok(Math.abs(current.mtimeMs - plan.mtimeMs) < 1, `restored mtime differs for ${kind}`);
    const sha256 = await hashFile(plan.filePath);
    assert.equal(sha256, plan.sha256, `restored checksum differs for ${kind}`);
    restored.push({ kind, filePath: plan.filePath, sha256, mtimeMs: current.mtimeMs });
  }
  return restored;
}
