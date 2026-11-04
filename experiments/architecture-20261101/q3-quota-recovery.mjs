import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { completedQuotaWindows } from "../../public/timeline-utils.js";
import { selectQuotaWindows } from "../../src/usage-core.js";
import {
  USAGE_QUOTA_TABLE_NAMES,
  ensureUsageQuotaSchema,
  iterateStoredQuotaWindows,
  quotaProjectionWork,
  selectStoredQuotaWindows,
} from "../../src/usage-quota-store.js";

const [label, mode, childStage, childPhase] = process.argv.slice(2);
assert.match(label || "", /^q3-[a-z0-9-]+$/);
const directory = fileURLToPath(new URL(`../../output/q3/recovery/${label}/`, import.meta.url));
const heapArgs = ["--max-old-space-size=224", "--max-semi-space-size=4"];
const stages = ["initial", "incremental"];
const phases = ["before-commit", "after-commit"];
const MINUTE = 60_000;
const NOW = Date.parse("2026-11-04T12:00:00Z");
const AS_OF = NOW + 2 * MINUTE;
const PREFIX = "usage_quota_projection_";

function row(lineNumber, overrides = {}) {
  return {
    sourcePath: "fixture", lineNumber, role: "primary", limitId: "codex",
    observedAtMs: NOW - MINUTE, windowMinutes: 300, resetsAtMs: NOW + 240 * MINUTE,
    usedPercent: 20, ...overrides,
  };
}

const officials = [
  row(1, { sourcePath: "official", observedAtMs: NOW - 2 * MINUTE, usedPercent: 61 }),
  row(2, { sourcePath: "official", role: "secondary", observedAtMs: NOW - 2 * MINUTE,
    windowMinutes: 10_080, usedPercent: 62 }),
  row(1, { usedPercent: 99 }), // Raw identity shadows this official snapshot.
  row(1, { sourcePath: "official", limitId: "other", usedPercent: 99 }),
  row(3, { sourcePath: "official", windowMinutes: -1 }),
  row(3, { sourcePath: "official", limitId: "other" }), // Invalid first row keeps its identity.
];

function open(root) {
  const database = new DatabaseSync(path.join(root, "usage.sqlite"));
  database.exec("PRAGMA recursive_triggers=OFF; PRAGMA busy_timeout=1000");
  return database;
}

function put(database, observation) {
  database.prepare(`INSERT INTO rate_limit_observations (
    source_path,line_number,role,observed_at_ms,limit_id,window_minutes,resets_at_ms,used_percent
  ) VALUES(?,?,?,?,?,?,?,?)`).run(observation.sourcePath, observation.lineNumber, observation.role,
    observation.observedAtMs, observation.limitId, observation.windowMinutes, observation.resetsAtMs,
    observation.usedPercent);
}

function rawRows(database) {
  return database.prepare("SELECT * FROM rate_limit_observations ORDER BY source_path,line_number,role").all();
}

function facts(database) {
  const rows = rawRows(database);
  return { count: rows.length, sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    revision: Number(database.prepare("SELECT revision FROM quota_revision WHERE singleton=1").get().revision) };
}

function observations(database) {
  const seen = new Set();
  return [...rawRows(database), ...officials].filter((observation, index) => {
    const source = observation.sourcePath ?? observation.source_path;
    const line = observation.lineNumber ?? observation.line_number;
    const key = source !== undefined && line !== undefined && observation.role
      ? `${source}\0${line}\0${observation.role}` : `unkeyed\0${index}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortedRows(rows) {
  return rows.map((item) => ({ ...item })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function snapshot(database) {
  return Object.fromEntries(USAGE_QUOTA_TABLE_NAMES.map((name) =>
    [name, sortedRows(database.prepare(`SELECT * FROM ${name}`).all())]));
}

function assertPointContributions(database, rows) {
  const expected = new Map();
  for (const observation of rows) {
    const limit = observation.limitId ?? observation.limit_id;
    const minutes = Number(observation.windowMinutes ?? observation.window_minutes);
    const observed = Number(observation.observedAtMs ?? observation.observed_at_ms);
    const reset = Number(observation.resetsAtMs ?? observation.resets_at_ms);
    if (typeof limit !== "string" || !limit.trim() || !Number.isFinite(minutes) || minutes <= 0
      || !Number.isFinite(observed) || !Number.isFinite(reset)) continue;
    const percent = observation.usedPercent ?? observation.used_percent;
    const point = { limit_id: limit, window_minutes: minutes, observed_at_ms: observed, resets_at_ms: reset,
      percent_kind: percent == null ? "null" : "number", percent_value: percent == null ? 0 : Number(percent) };
    const key = JSON.stringify(point);
    const previous = expected.get(key);
    expected.set(key, { ...point, refs: (previous?.refs ?? 0) + 1 });
  }
  const actual = database.prepare(`SELECT * FROM ${PREFIX}points`).all();
  assert.deepEqual(sortedRows(actual), sortedRows([...expected.values()]), "point refs must count each identity once");
  return actual.reduce((sum, point) => sum + Number(point.refs), 0);
}

function verify(database, asOf = AS_OF) {
  const rows = observations(database);
  const expected = selectQuotaWindows(rows, asOf);
  const actual = selectStoredQuotaWindows(database, asOf, officials);
  const work = { ...quotaProjectionWork(database) };
  assert.deepEqual(actual, expected, "all current and previous window fields must match the original JS algorithm");
  assert.notEqual(work.fallback, true, "recovery must use the persistent projection");
  const completed = {};
  for (const limit of ["codex", "other"]) for (const minutes of [300, 10_080]) {
    const original = completedQuotaWindows(rows, limit, asOf, minutes);
    const iterable = iterateStoredQuotaWindows(database, limit, asOf, minutes, officials);
    const result = iterable === null ? null : [...iterable];
    assert.deepEqual(result, original, `complete cycle list ${limit}/${minutes}`);
    completed[`${limit}/${minutes}`] = result;
  }
  assert.ok(completed["codex/300"].length >= 3);
  assert.ok(completed["codex/10080"].length >= 3);
  const pointRefs = assertPointContributions(database, rows);
  assert.equal(database.prepare(`SELECT COUNT(*) n FROM ${PREFIX}changes`).get().n, 0);
  const state = database.prepare(`SELECT * FROM ${PREFIX}state`).get();
  assert.equal(Number(state.revision), facts(database).revision);
  assert.equal(Number(state.queued), 0);
  assert.equal(Number(state.rebuild), 0);
  return { selection: actual, completed, work, pointRefs };
}

async function prepareFixture(root, stage) {
  await mkdir(root);
  const database = open(root);
  try {
    database.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE rate_limit_observations (
        source_path TEXT NOT NULL, line_number INTEGER NOT NULL CHECK(line_number>0),
        role TEXT NOT NULL CHECK(role IN ('primary','secondary')), observed_at_ms INTEGER NOT NULL,
        limit_id TEXT NOT NULL, window_minutes REAL NOT NULL CHECK(window_minutes>0),
        resets_at_ms INTEGER NOT NULL, used_percent REAL CHECK(used_percent IS NULL OR used_percent BETWEEN 0 AND 100),
        PRIMARY KEY(source_path,line_number,role)
      ) STRICT`);
    assert.equal(ensureUsageQuotaSchema(database), true);
    database.exec("BEGIN IMMEDIATE");
    let line = 1;
    for (const minutes of [300, 10_080]) for (let cycle = -3; cycle <= 0; cycle += 1) {
      const reset = NOW + (240 + cycle * minutes) * MINUTE;
      put(database, row(line++, { role: minutes === 300 ? "primary" : "secondary", windowMinutes: minutes,
        resetsAtMs: reset, observedAtMs: reset - (minutes - 5) * MINUTE }));
    }
    put(database, row(line, { sourcePath: "singleton", limitId: "other", usedPercent: 1 }));
    database.exec("COMMIT");
    if (stage === "incremental") {
      const baseline = verify(database, NOW);
      assert.equal(baseline.work.rebuilt, true);
      database.exec("BEGIN IMMEDIATE");
      put(database, row(20, { observedAtMs: NOW + MINUTE, usedPercent: 80 }));
      put(database, row(21, { role: "secondary", windowMinutes: 10_080,
        observedAtMs: NOW + MINUTE, usedPercent: 81 }));
      database.exec("COMMIT");
    }
    return { facts: facts(database), projection: snapshot(database) };
  } finally { database.close(); }
}

function checkpoint(database, stage, phase) {
  assert.equal(typeof process.send, "function");
  process.send({ stage, phase, pid: process.pid, execArgv: process.execArgv,
    isTransaction: database.isTransaction, facts: facts(database),
    state: database.prepare(`SELECT * FROM ${PREFIX}state`).get() ?? null,
    queuedRows: Number(database.prepare(`SELECT COUNT(*) n FROM ${PREFIX}changes`).get().n) });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  throw new Error("Parent did not kill the child at the projection COMMIT boundary");
}

async function killAtCommit(root, stage, phase) {
  const child = fork(fileURLToPath(import.meta.url), [label, "child", stage, phase], {
    execArgv: heapArgs, windowsHide: true, env: { ...process.env, NODE_OPTIONS: "" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stdout = "", stderr = "", message = null, failure = null, killRequested = false;
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        failure = new Error("No projection checkpoint IPC within 30 seconds");
        child.kill("SIGKILL");
      }, 30_000);
      child.on("message", (received) => {
        try {
          assert.equal(message, null, "only one checkpoint is allowed");
          message = received;
          assert.equal(message.pid, child.pid);
          assert.equal(message.stage, stage);
          assert.equal(message.phase, phase);
          assert.deepEqual(message.execArgv, heapArgs);
          assert.equal(message.isTransaction, phase === "before-commit");
          killRequested = child.kill("SIGKILL");
          assert.equal(killRequested, true);
        } catch (error) { failure = error; child.kill("SIGKILL"); }
      });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        try {
          if (failure) throw failure;
          assert.ok(message, `Child exited without checkpoint: ${stderr}`);
          assert.equal(killRequested, true);
          assert.equal(signal, "SIGKILL", JSON.stringify({ code, signal, stderr }));
          resolve({ checkpoint: message, exit: { code, signal }, killRequested });
        } catch (error) { reject(error); }
      });
    });
  } finally {
    await writeFile(path.join(root, "child-stdout.log"), stdout, { flag: "wx" });
    await writeFile(path.join(root, "child-stderr.log"), stderr, { flag: "wx" });
  }
}

if (mode === "child") {
  assert.ok(stages.includes(childStage));
  assert.ok(phases.includes(childPhase));
  const database = open(path.join(directory, `${childStage}-${childPhase}`));
  assert.equal(ensureUsageQuotaSchema(database), true);
  const exec = database.exec.bind(database);
  let projectionTransaction = false;
  database.exec = (sql) => {
    if (sql === "BEGIN IMMEDIATE") projectionTransaction = true;
    const commit = projectionTransaction && sql === "COMMIT";
    if (commit && childPhase === "before-commit") checkpoint(database, childStage, childPhase);
    const result = exec(sql);
    if (commit && childPhase === "after-commit") checkpoint(database, childStage, childPhase);
    return result;
  };
  selectStoredQuotaWindows(database, AS_OF, officials);
  throw new Error("The projection COMMIT crash point was not reached");
} else {
  assert.equal(mode, undefined);
  assert.ok(heapArgs.every((argument) => process.execArgv.includes(argument)), "Run the parent with the standard 224/4 heap flags");
  await mkdir(path.dirname(directory), { recursive: true });
  await mkdir(directory);
  const results = [];
  for (const stage of stages) for (const phase of phases) {
    const root = path.join(directory, `${stage}-${phase}`);
    const result = { stage, phase, passed: false };
    results.push(result);
    try {
      const before = await prepareFixture(root, stage);
      await writeFile(path.join(root, "before.json"), JSON.stringify(before, null, 2) + "\n", { flag: "wx" });
      Object.assign(result, await killAtCommit(root, stage, phase));
      assert.deepEqual(result.checkpoint.facts, before.facts);
      assert.equal(result.checkpoint.queuedRows, 0);
      assert.equal(Number(result.checkpoint.state.revision), before.facts.revision);
      let database = open(root);
      let published;
      try {
        assert.deepEqual(facts(database), before.facts, "all committed facts survive the child kill");
        const recoveredBefore = snapshot(database);
        result.statusBeforeRecovery = recoveredBefore[`${PREFIX}state`][0] ?? null;
        if (phase === "before-commit") {
          assert.deepEqual(recoveredBefore, before.projection, "uncommitted projection and queue changes must roll back atomically");
        } else {
          assert.equal(Number(result.statusBeforeRecovery.revision), before.facts.revision);
          assert.equal(Number(result.statusBeforeRecovery.as_of_ms), AS_OF);
          assert.equal(Number(result.statusBeforeRecovery.queued), 0);
          assert.equal(recoveredBefore[`${PREFIX}changes`].length, 0);
        }
        result.recovered = verify(database);
        const shouldRebuild = stage === "initial" && phase === "before-commit";
        assert.equal(result.recovered.work.rebuilt, shouldRebuild);
        assert.equal(result.recovered.work.changes, stage === "incremental" && phase === "before-commit" ? 2 : 0);
        if (phase === "after-commit") {
          assert.equal(result.recovered.work.cycles, 0);
          assert.equal(result.recovered.work.endpoints, 0);
        }
        assert.equal(result.recovered.selection.windows.quota_5h.usedPercent, stage === "incremental" ? 80 : 61);
        assert.equal(result.recovered.selection.windows.quota_week.usedPercent, stage === "incremental" ? 81 : 62);
        assert.deepEqual(facts(database), before.facts);
        assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
        published = snapshot(database);
      } finally { database.close(); }
      database = open(root);
      try {
        result.reopened = verify(database);
        assert.equal(result.reopened.work.reused, true);
        assert.equal(result.reopened.work.rebuilt, false);
        for (const key of ["changes", "promotedTimes", "endpoints", "cycles"])
          assert.equal(result.reopened.work[key], 0, `reopen must not repeat ${key}`);
        assert.deepEqual(result.reopened.selection, result.recovered.selection);
        assert.deepEqual(result.reopened.completed, result.recovered.completed);
        assert.deepEqual(snapshot(database), published, "reopen must not double-add any persistent contribution");
        assert.deepEqual(facts(database), before.facts);
        result.facts = facts(database);
        result.integrity = database.prepare("PRAGMA quick_check").get().quick_check;
        assert.equal(result.integrity, "ok");
        result.passed = true;
      } finally { database.close(); }
    } catch (error) {
      result.error = { message: error.message, stack: error.stack };
    }
    await writeFile(path.join(root, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx", flush: true });
    console.log(JSON.stringify({ stage, phase, passed: result.passed, work: result.recovered?.work, error: result.error?.message }));
  }
  const report = { passed: results.every((result) => result.passed), parentExecArgv: process.execArgv, heapArgs, results };
  await writeFile(path.join(directory, "result.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", flush: true });
  assert.equal(report.passed, true, `Recovery failed; inspect ${path.join(directory, "result.json")}`);
  console.log(JSON.stringify({ passed: true, points: results.length, directory }));
}
