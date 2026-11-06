import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { streamUsageFileEvents } from "../../src/usage-core.js";
import {
  C1_SOURCE_KINDS,
  appendC1Mutation,
  prepareC1Mutations,
  restoreC1Mutations,
  reviseC1Mutation,
} from "./c1-source-mutations.mjs";
import { generateLineInputs } from "./growth-line-inputs.mjs";
import { generateSqliteInputs } from "./growth-sqlite-inputs.mjs";

const runtimeDirectory = fileURLToPath(new URL("../../", import.meta.url));
const DAY = 86_400_000;
const START_MS = Date.parse("2025-01-01T00:00:00.000Z");
const HOMES = {
  codex: ".codex",
  dsh: ".dsh",
  claude: ".claude",
  workbuddy: ".workbuddy-ai",
  zcode: ".zcode",
  opencode: ".opencode",
};

async function hashFile(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function sourceHome(home, kind) {
  return path.join(home, HOMES[kind]);
}

function timeRange(day, span = 7) {
  const startMs = START_MS + day * DAY;
  return { startMs, endMs: startMs + span * DAY };
}

function lineFile(key, kind, day, options = {}) {
  return {
    key,
    kind,
    sessionKey: `tiny-${key}`,
    projectKey: "project1",
    events: 4,
    rows: 4,
    decodedBytes: 12_000,
    sourceBytes: 12_000,
    compressed: false,
    frames: 0,
    quotaObservations: 0,
    timeRange: timeRange(day),
    ...options,
  };
}

async function createTinyDataset(t) {
  const root = await mkdtemp(path.join(runtimeDirectory, ".c1-source-mutations-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const lineInputs = await generateLineInputs({
    root: home,
    scale: 1,
    files: [
      lineFile("codexplain", "codex", 1),
      lineFile("codexzstd", "codex", 30, {
        events: 2,
        rows: 2,
        compressed: true,
        frames: 1,
      }),
      lineFile("dshlatest", "dsh", 60, {
        compressed: true,
        frames: 2,
      }),
      lineFile("claudelatest", "claude", 90),
      lineFile("workbuddylatest", "workbuddy", 120),
    ],
  });
  const sqliteInputs = await generateSqliteInputs({
    root: home,
    scale: 1,
    files: [
      { key: "zcodelatest", kind: "zcode", events: 8, sessions: 4, projects: 2, sourceBytes: 1024 * 1024 },
      { key: "opencodelatest", kind: "opencode", events: 8, sessions: 4, projects: 2, sourceBytes: 1024 * 1024 },
    ],
    timeRange: timeRange(180, 365),
    sessionOrder: "contiguous",
  });
  const selected = new Map();
  selected.set("codex", lineInputs.files.find((file) => file.key === "codexplain"));
  for (const kind of ["dsh", "claude", "workbuddy"]) {
    selected.set(kind, lineInputs.files.find((file) => file.kind === kind));
  }
  for (const output of sqliteInputs) {
    selected.set(output.kind, { ...output, path: path.join(home, output.relativePath) });
  }

  const databaseFile = path.join(root, "imported.sqlite");
  const database = new DatabaseSync(databaseFile);
  try {
    database.exec(`
      CREATE TABLE source_files (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        home_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL
      );
    `);
    const insertSource = database.prepare(
      `INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = database.prepare("INSERT INTO events (source_path, timestamp_ms) VALUES (?, ?)");
    let nextId = 1;
    const add = async (file, kind, rowKind, timestampMs) => {
      const info = await stat(file.path);
      const eventCount = Number(file.events ?? file.eventCount);
      assert.ok(Number.isSafeInteger(eventCount) && eventCount > 0);
      insertSource.run(
        file.path,
        rowKind,
        `home-${kind}`,
        `Tiny ${kind}`,
        sourceHome(home, kind),
        info.size,
        info.mtimeMs,
        "2026-11-07T00:00:00.000Z",
      );
      for (let index = 0; index < eventCount; index += 1) {
        insertEvent.run(file.path, timestampMs + index * 1000);
      }
      nextId += eventCount;
    };

    for (const kind of C1_SOURCE_KINDS) {
      const file = selected.get(kind);
      await add(file, kind, kind === "codex" ? "main" : kind, timeRange(30 * (C1_SOURCE_KINDS.indexOf(kind) + 1)).startMs);
    }
    const compressedCodex = lineInputs.files.find((file) => file.key === "codexzstd");
    await add(compressedCodex, "codex", "codex", timeRange(300).startMs);
    assert.equal(Number(database.prepare("SELECT COUNT(*) n FROM events").get().n), nextId - 1);
  } finally {
    database.close();
  }
  return { root, home, databaseFile, selected };
}

async function collect(plan, filePath = plan.filePath) {
  const events = [];
  const warnings = [];
  await streamUsageFileEvents(
    filePath,
    plan.source,
    (event) => events.push(event),
    {
      repositoryResolver: (cwd) => ({ key: cwd, path: cwd, kind: "directory" }),
      onWarning: (warning) => warnings.push(warning),
    },
  );
  assert.deepEqual(warnings, []);
  return events;
}

function totals(events) {
  return events.reduce(
    (sum, event) => {
      for (const field of ["total", "input", "cached", "output", "reasoning"]) {
        sum[field] += event.usage[field];
      }
      sum.cacheWrite += event.cacheWriteTokens || 0;
      return sum;
    },
    { total: 0, input: 0, cached: 0, output: 0, reasoning: 0, cacheWrite: 0 },
  );
}

function difference(after, before) {
  return Object.fromEntries(Object.keys(after).map((field) => [field, after[field] - before[field]]));
}

function sessions(events) {
  return [...new Set(events.map((event) => event.sessionId))].sort();
}

async function missing(filePath) {
  try {
    await access(filePath);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

test("six C1 sources append, ZCode revises, and all restore through real adapters", async (t) => {
  const fixture = await createTinyDataset(t);
  const dataset = { home: fixture.home };
  const directory = path.join(fixture.root, "mutation-run");
  const seed = new DatabaseSync(fixture.databaseFile, { readOnly: true });
  const sourceTimes = new Map(seed.prepare("SELECT path,mtime_ms FROM source_files").all().map(row=>[row.path,Number(row.mtime_ms)]));
  seed.close();
  const changedPath = [...sourceTimes.keys()].find(file=>file.endsWith(".zstd"));
  const { utimes } = await import("node:fs/promises");
  await utimes(changedPath, (sourceTimes.get(changedPath)+5000)/1000, (sourceTimes.get(changedPath)+5000)/1000);
  const plans = await prepareC1Mutations(dataset, {
    databaseFile: fixture.databaseFile,
    runtimeDirectory,
    directory,
  });
  assert.deepEqual(plans.map((plan) => plan.kind), C1_SOURCE_KINDS);
  assert.ok(plans.find((plan) => plan.kind === "codex").filePath.endsWith("codexplain.jsonl"));
  assert.ok(plans.find((plan) => plan.kind === "dsh").filePath.endsWith(".zstd"));
  for (const plan of plans) {
    assert.equal(plan.mtimeMs,sourceTimes.get(plan.filePath),"reset target must remain the seed time, not the previous attempt's file time");
    const relative = path.relative(fixture.home, plan.filePath);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    assert.equal(Number((await stat(plan.filePath)).nlink), 1);
    assert.equal(Number((await stat(plan.backupFile)).nlink), 1);
    assert.equal(await hashFile(plan.backupFile), plan.sha256);
  }

  const before = new Map();
  const appended = new Map();
  for (const plan of plans) {
    const events = await collect(plan);
    assert.ok(events.length > 0);
    before.set(plan.kind, events);
    const started = Date.now();
    const receipt = await appendC1Mutation(plan);
    const ended = Date.now();
    assert.ok(started <= receipt.startedAtMs && receipt.startedAtMs <= receipt.landedAtMs && receipt.landedAtMs <= ended);
    assert.deepEqual(
      [receipt.deltaTotal, receipt.deltaEvents, receipt.deltaSessions],
      [160, 1, 0],
    );
    const afterAppend = await collect(plan);
    appended.set(plan.kind, afterAppend);
    assert.equal(afterAppend.length, events.length + 1);
    assert.deepEqual(sessions(afterAppend), sessions(events));
    assert.deepEqual(difference(totals(afterAppend), totals(events)), {
      total: 160,
      input: 140,
      cached: 30,
      output: 20,
      reasoning: plan.kind === "dsh" || plan.kind === "claude" ? 0 : 5,
      cacheWrite: 10,
    });
    assert.deepEqual(receipt.deltaTokens, {
      input: 140,
      cached: 30,
      output: 20,
      reasoning: plan.kind === "dsh" || plan.kind === "claude" ? 0 : 5,
      cacheWrite: 10,
    });
  }

  const codex = plans.find((plan) => plan.kind === "codex");
  await assert.rejects(reviseC1Mutation(codex), /ZCode only/);
  const zcode = plans.find((plan) => plan.kind === "zcode");
  const beforeRevision = appended.get("zcode");
  const revised = await reviseC1Mutation(zcode);
  assert.deepEqual(
    [revised.deltaTotal, revised.deltaEvents, revised.deltaSessions],
    [19, 0, 0],
  );
  const afterRevision = await collect(zcode);
  assert.equal(afterRevision.length, beforeRevision.length);
  assert.deepEqual(sessions(afterRevision), sessions(beforeRevision));
  assert.deepEqual(difference(totals(afterRevision), totals(beforeRevision)), {
    total: 19,
    input: 0,
    cached: 0,
    output: 19,
    reasoning: 0,
    cacheWrite: 0,
  });
  assert.deepEqual(revised.deltaTokens, {
    input: 0,
    cached: 0,
    output: 19,
    reasoning: 0,
    cacheWrite: 0,
  });

  for (const kind of ["zcode", "opencode"]) {
    const plan = plans.find((candidate) => candidate.kind === kind);
    for (const suffix of ["-wal", "-shm", "-journal"]) await writeFile(`${plan.filePath}${suffix}`, "stale");
  }
  const restored = await restoreC1Mutations(JSON.parse(JSON.stringify(plans)));
  assert.deepEqual(restored.map((item) => item.kind), C1_SOURCE_KINDS);
  for (const plan of plans) {
    const info = await stat(plan.filePath);
    assert.equal(Number(info.nlink), 1);
    assert.ok(Math.abs(info.mtimeMs - plan.mtimeMs) < 1);
    assert.equal(await hashFile(plan.filePath), plan.sha256);
    assert.deepEqual(await collect(plan), before.get(plan.kind));
    for (const suffix of ["-wal", "-shm", "-journal"]) assert.equal(await missing(`${plan.filePath}${suffix}`), true);
  }
});
