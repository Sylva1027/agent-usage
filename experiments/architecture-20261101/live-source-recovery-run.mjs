import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { CLOSEOUT_PROFILE, protectionPassed } from "./windows-stability-schedule.mjs";
import { isSourceUpdatePending } from "./windows-stability-run.mjs";
import { closeoutObservationErrors } from "./windows-stability-recovery-analyze.mjs";
import { controls, controlChecks, resources, resourceChecks, gates, check, finish, streamNdjson } from "./windows-stability-analyze.mjs";

const project = fileURLToPath(new URL("../../", import.meta.url));
export const LEGACY_CARD = Object.freeze({ root: path.join(project, "output/live-source-recovery-20261110/validated"),
  baseline: "44a5da1", durationMs: 180_000, appendCount: 36, drainMs: 300_000 });
export const PUBLICATION_CARD = Object.freeze({ root: path.join(project, "output/committed-publication-20261110"),
  baseline: "401faeb", durationMs: 90_000, appendCount: 18, drainMs: 60_000 });
const CARD = process.env.WINDOWS_CLOSEOUT_ROOT && path.resolve(process.env.WINDOWS_CLOSEOUT_ROOT) === PUBLICATION_CARD.root
  ? PUBLICATION_CARD : LEGACY_CARD;
export const ROOT = CARD.root;
const prior = path.join(project, "output/archive-memory-budget-20261110");
const states = path.join(project, "output/archive-request-lifetime-20261110");
export const LABELS = ["current", "year", "two-years"];
export const KINDS = ["codex", "dsh", "zcode"];
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const exists = async file => fs.stat(file).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
const save = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", flush: true });
};
const hash = async file => {
  const digest = createHash("sha256");
  for await (const bytes of createReadStream(file)) digest.update(bytes);
  return digest.digest("hex");
};
const errorRecord = error => ({ message: error.message, stack: error.stack });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const ndjson = async file => {
  const rows = [], errors = [];
  await streamNdjson(file, row => rows.push(row), errors);
  assert.deepEqual(errors, [], `Unreadable evidence: ${file}`);
  return rows;
};
const log = (context, type, details) => fs.appendFile(path.join(context.directory, "events.ndjson"),
  JSON.stringify({ ...details, type, atMs: Date.now() }) + "\n");

export function plan(card = CARD) {
  return LABELS.flatMap(label => (label === "year" ? ["candidate", "baseline"] : ["baseline", "candidate"])
    .map(variant => ({ label, variant, ordinary: [...KINDS], scopes: ["today", "week", "all"],
      reopens: label === "two-years" && variant === "candidate" ? 2 : 1,
      continuous: label === "two-years" && variant === "candidate" ? card.appendCount : 0 })));
}

export function continuousSchedule(card = CARD) {
  return { profile: CLOSEOUT_PROFILE, mode: "live-source-continuous", label: "two-years", durationMs: card.durationMs,
    appendCount: card.appendCount, cycles: [], events: Array.from({ length: card.appendCount }, (_, i) => ({
      id: `continuous-${String(i + 1).padStart(2, "0")}`, type: "append", atMs: i * 5000,
      kind: i % 2 ? "dsh" : "codex", ordinal: i + 1, category: "continuous", inputClass: "continuous",
    })) };
}

export { isSourceUpdatePending };

export function checkPending(events, candidate) {
  const responses = events.filter(row => row.type === "response");
  const pending = events.filter(row => row.type === "http-pending");
  assert.equal(events.filter(row => row.type === "http-error" || row.error).length, 0);
  for (const row of pending) {
    assert.equal(candidate, true); assert.equal(row.code, "SOURCE_UPDATE_PENDING");
    assert.ok(isSourceUpdatePending(row.status, row.body), "Pending response shape was not proved");
    assert.ok(Number.isInteger(row.page) && Number.isFinite(row.atMs));
    assert.ok(responses.some(next => next.page === row.page && next.atMs >= row.atMs && next.usageVersion), "Pending never converged on its page");
  }
  return pending.length;
}

export function assertContinuous(inputs, startedAtMs, stoppedAtMs, card = CARD) {
  const expected = continuousSchedule(card);
  assert.equal(inputs.length, expected.appendCount);
  assert.ok(stoppedAtMs - startedAtMs >= expected.durationMs, "Continuous observation ended early");
  for (const [i, row] of inputs.entries()) {
    assert.equal(row.eventId, expected.events[i].id); assert.equal(row.kind, expected.events[i].kind);
    assert.equal(row.operation, "append"); assert.equal(row.category, "continuous");
    assert.ok(row.landedAtMs >= startedAtMs + i * 5000 && row.landedAtMs < startedAtMs + (i + 1) * 5000,
      "Missed 5s input slot; do not bunch late writes or rerun to select a timing");
    assert.ok(Number.isFinite(row.paintedAtMs) && row.usageVersion, "Input has no completed visible version");
  }
  const lastInputAtMs = inputs.at(-1).landedAtMs;
  const during = inputs.filter(row => row.paintedAtMs < lastInputAtMs && row.paintedAtMs >= startedAtMs);
  const versions = [...new Set(during.map(row => row.usageVersion))];
  assert.ok(versions.length >= 2, "Need two completed versions before writing stops");
  for (const kind of ["codex", "dsh"]) assert.ok(during.some(row => row.kind === kind), `No live progress for ${kind}`);
  const drainedAtMs = Math.max(...inputs.map(row => row.paintedAtMs));
  assert.ok(drainedAtMs - lastInputAtMs <= card.drainMs, `Final publication exceeded last-input + ${card.drainMs / 1000}s`);
  return { lastInputAtMs, drainedAtMs, drainMs: Math.max(0, drainedAtMs - lastInputAtMs), versions };
}

export function comparePair(before, after, card = CARD) {
  const keys = ["startup-today", "startup-all", "reopen", ...["today", "week", "all"].map(x => `scope-${x}`),
    ...KINDS.flatMap(x => card === PUBLICATION_CARD ? [`append-${x}`] : [`append-${x}`, `view-${x}`])];
  const timings = keys.map(key => {
    const beforeMs = before.metrics[key], afterMs = after.metrics[key];
    const known = Number.isFinite(beforeMs) && Number.isFinite(afterMs), passed = known && protectionPassed(beforeMs, afterMs);
    return { key, beforeMs, afterMs, passed, status: known ? passed ? "passed" : "failed" : "incomplete" };
  });
  const work = KINDS.map(kind => ({ kind, before: before.work?.[kind], after: after.work?.[kind],
    passed: Number.isInteger(before.work?.[kind]?.rounds) && Number.isInteger(after.work?.[kind]?.rounds) &&
      before.work[kind].rounds > 0 && after.work[kind].rounds > 0 &&
      after.work[kind].rounds <= before.work[kind].rounds && after.work[kind].commits === 1 }));
  const rounds = { before: before.ordinaryRounds, after: after.ordinaryRounds,
    passed: Number.isInteger(before.ordinaryRounds) && Number.isInteger(after.ordinaryRounds) &&
      after.ordinaryRounds > 0 && after.ordinaryRounds <= before.ordinaryRounds };
  for (const row of work) row.status = Number.isInteger(row.before?.rounds) && Number.isInteger(row.after?.rounds) && Number.isInteger(row.after?.commits)
    ? row.passed ? "passed" : "failed" : "incomplete";
  rounds.status = Number.isInteger(rounds.before) && Number.isInteger(rounds.after) ? rounds.passed ? "passed" : "failed" : "incomplete";
  const statuses = [...timings, ...work, rounds].map(row => row.status);
  return { passed: statuses.every(value => value === "passed"),
    status: statuses.includes("failed") ? "failed" : statuses.includes("incomplete") ? "incomplete" : "passed",
    timings, work, rounds, statisticalP95Claim: false };
}

export function ordinaryWork(inputs, rows) {
  return Object.fromEntries(KINDS.map(kind => {
    const input = inputs.find(row => row.kind === kind);
    assert.ok(input, `Missing ordinary input: ${kind}`);
    const inWindow = row => row.atMs >= input.landedAtMs && row.atMs <= input.paintedAtMs;
    // replaceFile calls reuseSourcePrefix: count the COMMIT hook, not both returning wrappers.
    const source = rows.filter(row => row.event === "source-end" && row.method !== "reuseSourcePrefix" && row.filePath === input.filePath && inWindow(row));
    return [kind, { rounds: rows.filter(row => row.event === "round-end" && inWindow(row)).length,
      commits: rows.filter(row => row.event === "fact-commit" && row.filePath === input.filePath && inWindow(row)).length,
      parsedBytes: source.reduce((n, row) => n + (row.parsedBytes ?? 0), 0), failedAttempts: source.filter(row => row.error).length,
      attempts: source.length }];
  }));
}

const internalErrors = rows => rows.filter(row => row.error ||
  ["source-end", "round-end", "sync-end"].includes(row.event) && row.errorCode);

export function assertOrdinaryControl(rows, variant) {
  assert.equal(internalErrors(rows).length, 0, "Ordinary group has an internal failure");
  const rounds = rows.filter(row => row.event === "round-end");
  assert.ok(rounds.length > 0, "Ordinary round evidence missing");
  for (const row of rounds) {
    // 44a5da1 predates the retry counter; its source-error evidence must still be empty.
    const retries = variant === "baseline" ? row.sourceWork?.sourceRetries ?? 0 : row.sourceWork?.sourceRetries;
    assert.equal(retries, 0, "Ordinary sourceRetries must be zero, with candidate counter evidence");
  }
  return { sourceRetries: 0, failedAttempts: 0, rounds: rounds.length };
}

export function assertInternalRecovery(rows, continuous, events) {
  const errors = internalErrors(rows);
  if (!continuous) { assert.equal(errors.length, 0, "Internal error outside continuous segment"); return { recoveredErrors: [], failedAttempts: 0 }; }
  const oracle = events.find(row => row.type === "oracle" && row.name === "continuous-final" &&
    row.result?.passed === true && !row.result.retry && !row.result.skipped);
  assert.ok(oracle && Number.isFinite(oracle.atMs), "Continuous final oracle missing");
  const after = (a, b) => a.atMs > b.atMs || a.atMs === b.atMs && a.instance === b.instance && rows.indexOf(a) > rows.indexOf(b);
  const sourceErrors = errors.filter(row => row.event === "source-end");
  const recoveredErrors = errors.map(row => {
    assert.ok(["source-end", "round-end", "sync-end"].includes(row.event), "Unexpected internal error event");
    assert.ok(row.errorCode === "SOURCE_UPDATE_PENDING" || row.errorCode === "LIVE_SOURCE_CHANGED" && row.errorRetryable === true,
      "Internal error is not an explicitly retryable source change or pending update");
    assert.ok(row.atMs >= continuous.startedAtMs && row.atMs <= continuous.drainCompletedAtMs,
      "Internal error outside continuous write/drain window");
    assert.ok(row.instance && row.syncId, "Internal error correlation missing");
    let affected;
    if (row.event === "source-end") affected = [row];
    else {
      const round = row.event === "round-end" ? row : errors.filter(other => other.event === "round-end" &&
        other.instance === row.instance && other.syncId === row.syncId && after(row, other)).sort((a, b) => a.atMs - b.atMs).at(-1);
      assert.ok(round?.roundId, "Pending sync has no failed round to correlate");
      affected = sourceErrors.filter(source => source.instance === row.instance && source.syncId === row.syncId &&
        source.roundId === round.roundId && after(round, source) && !rows.some(commit => commit.event === "fact-commit" &&
          commit.filePath === source.filePath && commit.instance === source.instance && commit.roundId === source.roundId &&
          after(commit, source) && after(round, commit)));
      assert.ok(affected.length > 0, "Pending round has no source-error evidence");
    }
    const commits = affected.map(source => {
      assert.ok(typeof source.filePath === "string" && source.filePath && source.roundId, "Source error identity missing");
      const kind = ["main", "extra", "jetbrains"].includes(source.kind) ? "codex" : source.kind;
      assert.ok(continuous.inputs.some(input => input.kind === kind && input.filePath === source.filePath), "Error is not from a continuous input source");
      const commit = rows.find(next => next.event === "fact-commit" && next.filePath === source.filePath &&
        (["main", "extra", "jetbrains"].includes(next.kind) ? "codex" : next.kind) === kind && after(next, row) &&
        next.atMs <= continuous.drainCompletedAtMs && next.atMs <= oracle.atMs);
      assert.ok(commit, `No later same-source commit: ${source.filePath}`);
      return { filePath: source.filePath, kind, atMs: commit.atMs, instance: commit.instance, roundId: commit.roundId };
    });
    return { event: row.event, errorCode: row.errorCode, errorRetryable: row.errorRetryable, atMs: row.atMs,
      instance: row.instance, syncId: row.syncId, roundId: row.roundId, commits, oracleAtMs: oracle.atMs };
  });
  return { recoveredErrors, failedAttempts: sourceErrors.filter(row => row.method !== "reuseSourcePrefix").length };
}

export async function contained(parent, target) {
  parent = path.resolve(parent); target = path.resolve(target);
  const relative = path.relative(parent, target);
  assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "Path escaped owned directory");
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    assert.equal((await fs.lstat(cursor)).isSymbolicLink(), false, `Refuse link: ${cursor}`);
    if (cursor === parent) break;
  }
  assert.equal((await fs.realpath(target)).toLowerCase(), target.toLowerCase(), "Path aliases another directory");
  return target;
}

export async function identity(state) {
  const info = await fs.lstat(path.join(state, "usage-index.sqlite"), { bigint: true });
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n);
  return { dev: String(info.dev), ino: String(info.ino) };
}

export async function archives(state) {
  const db = new DatabaseSync(path.join(state, "usage-index.sqlite"), { readOnly: true });
  let entries;
  try { entries = db.prepare("SELECT database_path, database_sha256 FROM archive_segments ORDER BY segment_id").all(); }
  finally { db.close(); }
  const result = [];
  for (const row of entries) {
    const file = path.resolve(row.database_path), manifest = file.replace(/\.sqlite$/, ".manifest.json");
    assert.notEqual(file, manifest);
    const sha256 = await hash(file); assert.equal(sha256, row.database_sha256, "Historical package changed");
    result.push({ file, sha256, manifest, manifestSha256: await hash(manifest) });
  }
  return result;
}

export async function snapshot(config, outputRoot = ROOT) {
  const started = Date.now();
  const { files, facts } = await import("./source-snapshot-memory-run.mjs");
  await fs.mkdir(path.dirname(config.startState), { recursive: true });
  await contained(outputRoot, path.dirname(config.startState));
  assert.equal(await exists(config.startState), false, "Snapshot already exists");
  const before = { identity: await identity(config.state), facts: facts(config.state), archives: await archives(config.state) };
  await fs.cp(config.state, config.startState, { recursive: true, force: false, errorOnExist: true });
  assert.deepEqual(facts(config.startState), before.facts);
  assert.deepEqual(await identity(config.state), before.identity);
  const entries = [];
  for (const relative of await files(config.startState)) entries.push({ relative, sha256: await hash(path.join(config.startState, relative)) });
  return { ...before, entries, config, preparedAtMs: Date.now(), wallMs: Date.now() - started, rawCopyBytes: 0, archiveCopyBytes: 0 };
}

export async function restoreSnapshot(prepared, outputRoot = ROOT) {
  const { facts, files, restore } = await import("./source-snapshot-memory-run.mjs");
  const { config } = prepared;
  await contained(outputRoot, config.startState);
  assert.deepEqual(await identity(config.state), prepared.identity, "Primary identity changed before restoration");
  assert.deepEqual((await files(config.startState)).sort(), prepared.entries.map(row => row.relative).sort(), "Rollback inventory changed");
  for (const entry of prepared.entries) {
    await contained(config.startState, path.join(config.startState, entry.relative));
    assert.equal(await hash(path.join(config.startState, entry.relative)), entry.sha256, "Rollback snapshot changed");
  }
  await restore(config, outputRoot);
  assert.deepEqual(await identity(config.state), prepared.identity, "Primary inode was replaced");
  assert.deepEqual(facts(config.state), prepared.facts, "Facts were not restored");
  assert.deepEqual(await archives(config.state), prepared.archives, "Historical packages changed");
  return { restored: true, identity: prepared.identity, facts: prepared.facts, archives: prepared.archives, atMs: Date.now() };
}

export async function cleanupSnapshot(prepared, outputRoot = ROOT) {
  const { facts, files } = await import("./source-snapshot-memory-run.mjs");
  const { config } = prepared;
  const target = await contained(outputRoot, config.startState);
  assert.deepEqual(await identity(config.state), prepared.identity);
  assert.deepEqual(facts(config.state), prepared.facts);
  assert.deepEqual(await archives(config.state), prepared.archives);
  for (const variant of ["baseline", "candidate"]) {
    const directory = path.join(outputRoot, "short", config.label, variant), base = path.join(directory, "base-ledger.json");
    if (!await exists(base)) continue;
    assert.equal((await read(path.join(directory, "restoration.json"))).rawRestored, true);
    for (const row of (await read(base)).plans) assert.equal(await hash(row.filePath), row.sha256, "Source changed after restoration");
  }
  const entries = await files(target);
  let bytes = 0;
  for (const relative of entries) bytes += (await fs.stat(path.join(target, relative))).size;
  await save(path.join(outputRoot, "cleanup", `${config.label}-snapshot.json`), { target, bytes, checked: true, atMs: Date.now() });
  await fs.rm(target, { recursive: true });
}

async function runtime(variant) {
  const receipt = await read(path.join(ROOT, `${variant}-runtime.json`));
  assert.equal(path.resolve(receipt.directory), path.join(ROOT, `${variant}-runtime`));
  if (variant === "baseline") assert.equal(receipt.commit, CARD.baseline);
  assert.ok(receipt.files.length > 0);
  for (const entry of receipt.files) {
    const file = await contained(receipt.directory, path.join(receipt.directory, entry.relative));
    assert.equal(await hash(file), entry.sha256, `Frozen ${variant} changed: ${entry.relative}`);
  }
  return receipt;
}

async function freezeCandidate() {
  assert.notEqual(CARD, PUBLICATION_CARD, "Main owns the committed-publication runtime receipts");
  const baseline = await runtime("baseline"), directory = path.join(ROOT, "candidate-runtime");
  await fs.mkdir(directory);
  const entries = [];
  for (const entry of baseline.files) {
    const source = await contained(project, path.join(project, entry.relative)), destination = path.join(directory, entry.relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const sha256 = await hash(source); await fs.copyFile(source, destination);
    assert.equal(await hash(destination), sha256);
    entries.push({ relative: entry.relative, sha256 });
  }
  await save(path.join(ROOT, "candidate-runtime.json"), { directory, files: entries, baselineCommit: baseline.commit, frozenAtMs: Date.now() });
}

export async function configFor(label, variant) {
  assert.ok(LABELS.includes(label)); assert.ok(["baseline", "candidate"].includes(variant));
  const old = await read(path.join(prior, "configs", `${label}-candidate.json`));
  const expected = label === "two-years" ? path.join(states, label, "state") : path.join(states, `prepared-${label}`, label, "state");
  assert.equal(old.state, expected); await contained(states, old.state);
  assert.equal(old.datasetFile, path.join(project, "output/c1-long-history-20261107/datasets", label, "dataset.json"));
  return { ...old, label, variant, runtime: (await runtime(variant)).directory,
    mode: "live-source-ordinary", directory: path.join(ROOT, "short", label, variant), startState: path.join(ROOT, "snapshots", label) };
}

async function driver() {
  const value = await import("./windows-stability-run.mjs");
  for (const name of ["createContext", "startSampler", "dispatch", "verifyFull", "idleAndReopen", "finishContext"])
    assert.equal(typeof value[name], "function", `Owner integration required: windows-stability-run.mjs export ${name}`);
  return value;
}

async function observeUntil(d, context, done, deadline, allowTimeout = false) {
  while (true) {
    await d.pollBrowser(context); await d.pollResources(context);
    assert.equal(context.failures.length, 0, JSON.stringify(context.failures));
    assert.ok(!context.cancelled, "Run interrupted");
    if (await done()) return true;
    if (allowTimeout && Date.now() >= deadline) return false;
    assert.ok(Date.now() < deadline, "Observation exceeded its fixed deadline");
    await pause(Math.min(250, deadline - Date.now()));
  }
}

const drained = context => context.inputs.every(row => row.paintedAtMs) && !context.actionTasks.size && !context.responseTasks.size;

export async function settlePublicationTabs(d, context, deadline) {
  let pages;
  await observeUntil(d, context, async () => {
    pages = [];
    for (const [index, page] of context.pages.entries()) {
      assert.equal(page.isClosed(), false, "Publication tab closed before final verification");
      const row = [...context.bodies].reverse().find(value => value.page === index);
      const view = await page.evaluate(() => ({
        total: Number(String(document.querySelector("#totalTokens")?.title).replace(/[^0-9]/g, "")),
        busy: document.querySelector("#autoRefreshSpinner")?.classList.contains("is-loading") !== false,
      }));
      const complete = row?.preset === "all" && Boolean(row.usageVersion) && row.body.updatePending !== true &&
        d.visibleInputs(context, row.body).entries.length === context.ledger.entries.length && view.total === row.total && !view.busy;
      pages.push({ page: index, total: view.total, busy: view.busy, usageVersion: row?.usageVersion, complete: Boolean(complete) });
    }
    return pages.length === 3 && pages.every(row => row.complete) && !context.actionTasks.size && !context.responseTasks.size;
  }, deadline);
  const result = { atMs: Date.now(), pages };
  await log(context, "publication-tabs-settled", result);
  return result;
}

export function publicationTiming(inputs, startedAtMs, stoppedAtMs, drainCompletedAtMs) {
  const timing = gates(), schedule = continuousSchedule(PUBLICATION_CARD), lastInputAtMs = inputs.at(-1)?.landedAtMs ?? null;
  const during = inputs.filter(row => row.paintedAtMs >= startedAtMs && row.paintedAtMs < lastInputAtMs && row.usageVersion);
  const versions = [...new Set(during.map(row => row.usageVersion))];
  const paintsComplete = inputs.length > 0 && inputs.every(row => Number.isFinite(row.paintedAtMs) && row.usageVersion);
  const drainedAtMs = paintsComplete ? Math.max(...inputs.map(row => row.paintedAtMs)) : null;
  check(timing, "writer-workload", inputs.length === schedule.appendCount && inputs.every((row, i) =>
    row.eventId === schedule.events[i]?.id && row.kind === schedule.events[i]?.kind && row.operation === "append" &&
    row.category === "continuous") ? "passed" : "failed", { expected: schedule.appendCount, actual: inputs.length });
  check(timing, "writer-slots", inputs.every((row, i) => row.landedAtMs >= startedAtMs + i * 5000 &&
    row.landedAtMs < startedAtMs + (i + 1) * 5000) ? "passed" : "failed", inputs.map(row => row.landedAtMs));
  check(timing, "writer-duration", stoppedAtMs - startedAtMs >= schedule.durationMs ? "passed" : "failed", { startedAtMs, stoppedAtMs });
  check(timing, "writer-versions", versions.length >= 2 ? "passed" : "failed", { versions, lastInputAtMs });
  for (const kind of ["codex", "dsh"]) check(timing, `writer-progress-${kind}`,
    during.some(row => row.kind === kind) ? "passed" : "failed", during.filter(row => row.kind === kind).map(row => row.eventId));
  check(timing, "autonomous-drain", paintsComplete && Number.isFinite(drainCompletedAtMs) &&
    Math.max(drainedAtMs, drainCompletedAtMs) <= lastInputAtMs + PUBLICATION_CARD.drainMs ? "passed" : "failed",
  { lastInputAtMs, drainedAtMs, drainCompletedAtMs, limitMs: PUBLICATION_CARD.drainMs });
  return { ...finish(timing), lastInputAtMs, drainedAtMs, drainMs: drainedAtMs === null ? null : drainedAtMs - lastInputAtMs, versions };
}

async function runPublicationContinuous(d, context) {
  context.allowSourceUpdatePending = true;
  await d.dispatch(context, { id: "continuous-tabs", type: "tabs-open" });
  assert.equal(context.pages.filter(page => !page.isClosed()).length, 3);
  const schedule = continuousSchedule(PUBLICATION_CARD), first = context.inputs.length;
  const result = context.continuous = { passed: false, startedAtMs: Date.now(), inputs: [], timingFailures: [] };
  const recordTiming = async (id, message) => {
    const failure = { id, message, atMs: Date.now() }; result.timingFailures.push(failure);
    await log(context, "timing-failure", failure);
  };
  context.ordinalOffset = context.ledger.appendCount;
  await save(path.join(context.directory, "schedule-continuous.json"), { ...schedule, startedAtMs: result.startedAtMs });
  try {
    for (const event of schedule.events) {
      const slot = result.startedAtMs + event.atMs;
      await observeUntil(d, context, () => Date.now() >= slot, slot + 5000);
      if (Date.now() >= slot + 5000) { await recordTiming("writer-slots", `Missed write slot: ${event.id}`); break; }
      await d.dispatch(context, event);
      if (context.inputs.at(-1).landedAtMs >= slot + 5000) {
        await recordTiming("writer-slots", `Late landing: ${event.id}`); break;
      }
    }
    result.inputs = context.inputs.slice(first);
    const lastInputAtMs = result.inputs.at(-1)?.landedAtMs ?? result.startedAtMs;
    if (result.inputs.length === schedule.appendCount)
      await observeUntil(d, context, () => Date.now() >= result.startedAtMs + schedule.durationMs, lastInputAtMs + 60_000);
    result.stoppedAtMs = Date.now();
    for (const row of publicationTiming(result.inputs, result.startedAtMs, result.stoppedAtMs).checks)
      if (row.id.startsWith("writer-") && row.status === "failed") await recordTiming(row.id, JSON.stringify(row.evidence));
    // Only passive browser/resource observation may help the autonomous drain.
    if (!await observeUntil(d, context, () => drained(context), lastInputAtMs + 60_000, true)) {
      await recordTiming("autonomous-drain", "Final publication exceeded last-input + 60s");
      assert.ok(await observeUntil(d, context, () => drained(context), lastInputAtMs + 300_000, true),
        "Safe closeout drain exceeded last-input + 300s; final oracle/reopen incomplete");
    }
    result.drainCompletedAtMs = Date.now();
    // First paint is not evidence that the other tabs' admitted queries have finished.
    result.tabsSettled = await settlePublicationTabs(d, context, lastInputAtMs + 300_000);
    await d.dispatch(context, { id: "continuous-tabs-close", type: "tabs-close" });
    const oracleStarted = Date.now(); result.oracle = await d.verifyFull(context, "continuous-final");
    result.oracleWallMs = Date.now() - oracleStarted;
    result.reopen = await d.idleAndReopen(context, "continuous");
    result.completed = true;
  } catch (error) { result.failure = errorRecord(error); throw error; }
  finally {
    result.inputs = context.inputs.slice(first);
    result.timing = publicationTiming(result.inputs, result.startedAtMs, result.stoppedAtMs, result.drainCompletedAtMs);
    const { lastInputAtMs, drainedAtMs, drainMs, versions } = result.timing;
    Object.assign(result, { lastInputAtMs, drainedAtMs, drainMs, versions });
    result.passed = result.completed === true && result.timing.passed && !result.timingFailures.length;
    await save(path.join(context.directory, "continuous.json"), result);
  }
  return result;
}

export async function runContinuous(d, context, card = CARD) {
  if (card === PUBLICATION_CARD) return runPublicationContinuous(d, context);
  context.allowSourceUpdatePending = true;
  await d.dispatch(context, { id: "continuous-tabs", type: "tabs-open" });
  assert.equal(context.pages.filter(page => !page.isClosed()).length, 3);
  const schedule = continuousSchedule(card), first = context.inputs.length, startedAtMs = Date.now();
  context.ordinalOffset = context.ledger.appendCount;
  await save(path.join(context.directory, "schedule-continuous.json"), { ...schedule, startedAtMs });
  for (const event of schedule.events) {
    await observeUntil(d, context, () => Date.now() >= startedAtMs + event.atMs, startedAtMs + event.atMs + 5000);
    assert.ok(Date.now() < startedAtMs + event.atMs + 5000, "Missed continuous write slot");
    await d.dispatch(context, event);
  }
  const lastInputAtMs = context.inputs.at(-1).landedAtMs;
  await observeUntil(d, context, () => Date.now() >= startedAtMs + schedule.durationMs, lastInputAtMs + 300_000);
  const stoppedAtMs = Date.now();
  // No query, navigation, restart or new hint may help the final drain.
  await observeUntil(d, context, () => drained(context), lastInputAtMs + 300_000);
  const drainedAtMs = Date.now(); assert.ok(drainedAtMs <= lastInputAtMs + 300_000);
  const inputs = context.inputs.slice(first), progress = assertContinuous(inputs, startedAtMs, stoppedAtMs, card);
  const oracleStarted = Date.now(), oracle = await d.verifyFull(context, "continuous-final"), oracleWallMs = Date.now() - oracleStarted;
  await d.dispatch(context, { id: "continuous-tabs-close", type: "tabs-close" });
  const reopen = await d.idleAndReopen(context, "continuous");
  assert.deepEqual(await read(path.join(context.directory, "continuous-reopen.json")), reopen,
    "Owner integration required: named idleAndReopen must preserve final-reopen.json");
  const result = { passed: true, startedAtMs, stoppedAtMs, ...progress, drainCompletedAtMs: drainedAtMs, inputs, oracle, oracleWallMs, reopen };
  await save(path.join(context.directory, "continuous.json"), result);
  return result;
}

async function hookRows(directory) {
  const rows = [];
  for (const name of await fs.readdir(directory)) if (/^events-\d+\.ndjson$/.test(name)) rows.push(...await ndjson(path.join(directory, name)));
  return rows;
}

export function activeExecutors(rows) {
  const active = new Set();
  for (const row of rows) {
    if (row.event === "executor-spawn") active.add(row.childPid);
    else if (row.event === "executor-exit") active.delete(row.childPid);
  }
  return [...active];
}

async function waitForOracleIdle(context, name) {
  const startedAtMs = Date.now();
  const file = path.join(context.control, `events-${context.server.child.pid}.ndjson`);
  // The independent readonly oracle must not pin WAL while the product's writer is closing.
  while (activeExecutors(await ndjson(file)).length) {
    assert.ok(Date.now() - startedAtMs < 10_000, "Executor did not retire before independent oracle");
    await pause(25);
  }
  await log(context, "oracle-idle", { name, startedAtMs, waitedMs: Date.now() - startedAtMs });
}

async function resourceEvidence(directory, summary, control, phase, observations, evidence) {
  const nodes = [];
  const names = await fs.readdir(path.join(directory, "nodes")).catch(error => {
    if (error.code !== "ENOENT") throw error;
    evidence.push({ file: path.join(directory, "nodes"), status: "missing" }); return [];
  });
  for (const name of names)
    if (/^node-\d+\.jsonl$/.test(name)) nodes.push(...await ndjson(path.join(directory, "nodes", name)));
  const result = await resources(directory, await fs.readdir(directory, { withFileTypes: true }), [summary], control, nodes, phase, observations, evidence);
  if (phase.result?.card === "committed-publication") {
    result.observedCosts = { sampledCpuSeconds: result.sampledCpuSeconds, sampledLogicalReadBytes: result.sampledLogicalReadBytes,
      sampledLogicalWriteBytes: result.sampledLogicalWriteBytes };
    for (const [field, counter] of [["sampledCpuSeconds", "cpuSeconds"], ["sampledLogicalReadBytes", "logicalReadBytes"], ["sampledLogicalWriteBytes", "logicalWriteBytes"]])
      if (!result.processes.length || result.processes.some(row => !Number.isFinite(row[counter]))) result[field] = null;
  }
  return result;
}

export function canContinueGroup(analysis) {
  return analysis.completed === true && analysis.reliability?.passed === true && !analysis.evidence?.length &&
    analysis.resource?.checks.length > 0 && analysis.resource.checks.every(row => row.status === "passed" ||
      row.status === "incomplete" && (row.id.endsWith("/cpu-io-storage-cost") || row.id.endsWith("/normal-close-primary-wal") &&
        row.evidence?.finalSample?.serviceProcessCount === 0 && row.evidence.finalSample.sqlite?.complete !== true));
}

async function beforeContinuous(context, result) {
  const evidence = [], control = await controls(context.control, evidence), reliability = gates();
  const phase = { mode: "live-source-ordinary", inputs: result.ordinary, result,
    expectedSchedule: { profile: CLOSEOUT_PROFILE, cycles: [], events: [] } };
  const responses = (await ndjson(path.join(context.directory, "events.ndjson"))).filter(row => row.type === "response" && row.preset === "all");
  const observations = { faults: [], firstAllResponse: responses[0], lastAllResponse: responses.at(-1) };
  controlChecks(result.label, control, observations, [phase], reliability);
  const memory = await resourceEvidence(context.directory, context.resourceSummary, control, phase, observations, evidence);
  const receipt = { checks: reliability.checks, memory, evidence };
  await save(path.join(context.directory, "before-continuous.json"), receipt);
  assert.deepEqual(evidence, []);
  assert.ok(reliability.checks.every(row => row.status !== "failed"), "Ordinary correctness failure; continuous segment cancelled");
  assert.ok(memory.samples > 0 && memory.idleSamples > 0 && !memory.missingMemorySamples && !memory.missingIdentitySamples);
  assert.ok(memory.envelopeBytes <= 512 * 1048576 && memory.idlePeakBytes <= 256 * 1048576,
    "Ordinary resource failure; continuous segment cancelled");
}

async function stopOwned(d, context, failed) {
  let failure;
  try { await d.finishContext(context, { failed, retainSources: true }); }
  catch (error) { failure = error; }
  const child = context.server?.child;
  if (child && child.exitCode === null && child.signalCode === null) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    const code = await new Promise((resolve, reject) => { killer.once("error", reject); killer.once("exit", resolve); });
    assert.equal(code, 0, "Could not stop this run's owned gateway tree; keep recovery snapshot");
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once("exit", resolve));
  }
  await save(path.join(context.directory, "stopped.json"), { stopped: true, atMs: Date.now(), cleanupError: failure && errorRecord(failure) });
  if (failure) throw failure;
}

async function recover(prepared, directory) {
  const started = Date.now(), errors = [];
  const base = path.join(directory, "base-ledger.json");
  if (await exists(base)) {
    assert.equal((await read(path.join(directory, "stopped.json"))).stopped, true, "Stop owned processes before restore");
    const { restoreStabilityMutations } = await import("./windows-stability-mutations.mjs");
    try { await restoreStabilityMutations(await read(base)); } catch (error) { errors.push(errorRecord(error)); }
  }
  let receipt;
  try { receipt = await restoreSnapshot(prepared); } catch (error) { errors.push(errorRecord(error)); }
  if (errors.length) {
    await save(path.join(directory, `restoration-failed-${Date.now()}.json`), { errors, wallMs: Date.now() - started });
    throw Error(JSON.stringify(errors));
  }
  await save(path.join(directory, "restoration.json"), { ...receipt, rawRestored: true, wallMs: Date.now() - started });
  // Only this group's source backups are disposable; journals and all shared inputs stay.
  if (await exists(base)) for (const row of (await read(base)).plans) {
    const target = await contained(path.join(directory, "mutations"), row.backupFile);
    assert.equal(await hash(row.filePath), row.sha256);
    await fs.unlink(target);
  }
}

export async function runGroup(config, prepared) {
  const d = await driver(), { browser, expectedAll } = await import("./c1-run.mjs");
  const { prepareStabilityMutations } = await import("./windows-stability-mutations.mjs");
  const { assertArchiveRequestStartup } = await import("./archive-request-prepare.mjs");
  await fs.mkdir(path.dirname(config.directory), { recursive: true }); await fs.mkdir(config.directory);
  await save(path.join(config.directory, "config.json"), config);
  const result = { label: config.label, variant: config.variant, passed: false, startedAtMs: Date.now(), metrics: {},
    ...(CARD === PUBLICATION_CARD ? { card: "committed-publication" } : {}) };
  let context;
  const cancel = () => { if (context) context.cancelled = true; };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    await restoreSnapshot(prepared);
    const dataset = await read(config.datasetFile), control = path.join(config.directory, "control");
    const { projectionStorage } = await import("./c1-telemetry.mjs");
    d.assertCloseoutProjection(config.label, projectionStorage(config.state), prepared.archives.length);
    const preflight = await read(config.preflightFile);
    assert.equal(preflight.profile, CLOSEOUT_PROFILE); assert.equal(preflight.passed, true);
    assert.deepEqual(preflight.groups.map(row => row.name).sort(), ["after", "before", "closed-tabs", "normal"]);
    for (const row of preflight.groups) assert.equal(await hash(row.file), row.sha256);
    const ledger = await prepareStabilityMutations(dataset, path.join(config.directory, "mutations"), {
      databaseFile: path.join(config.seedDirectory, "usage-index.sqlite"), runtimeDirectory: config.runtime,
    });
    if (config.baseLedgerFile) {
      const base = await d.retainedLedger(config.baseLedgerFile, config.baseMutationsFile), entry = await read(config.entryFile);
      assert.equal(entry.rawAppendCount, base.appendCount); assert.equal(entry.revisionCount, base.revisionCount);
      for (const row of entry.sources) assert.equal(await hash(row.file), row.sha256);
      d.inheritCloseoutLedger(ledger, base);
    }
    await save(path.join(config.directory, "base-ledger.json"), ledger); await fs.mkdir(control);
    const seed = new DatabaseSync(path.join(config.seedDirectory, "usage-index.sqlite"), { readOnly: true });
    context = d.createContext({ ...config, dataset, ledger, seed, control, profile: CLOSEOUT_PROFILE,
      requiredAllTotal: expectedAll(dataset).total + ledger.expected.total,
      allowSourceUpdatePending: false, preserveMissingCosts: CARD === PUBLICATION_CARD, requireCompleteOracle: CARD === PUBLICATION_CARD });
    context.beforeOracle = name => waitForOracleIdle(context, name);
    context.selectedSessions = d.mutationSessions(ledger, seed);
    context.ui = await browser(); context.pages = [context.ui.page]; await d.attachPage(context, context.ui.page);
    context.server = await d.launchServer(context); context.sampler = await d.startSampler(context); await d.loadPage(context);
    await observeUntil(d, context, () => drained(context), Date.now() + 300_000);
    result.startup = assertArchiveRequestStartup(await hookRows(control));
    const initialOracleStarted = Date.now(); result.initialOracle = await d.verifyFull(context, "initial");
    result.initialOracleWallMs = Date.now() - initialOracleStarted; delete context.requiredAllTotal;
    context.ordinalOffset = ledger.appendCount;
    const events = KINDS.map((kind, i) => ({ id: `ordinary-${kind}`, type: "append", kind, ordinal: i + 1, category: "ordinary" }));
    for (const event of events) {
      await d.dispatch(context, event);
      await observeUntil(d, context, () => drained(context), context.inputs.at(-1).landedAtMs + 120_000);
    }
    result.ordinary = structuredClone(context.inputs);
    for (const preset of ["today", "week", "all"]) {
      const measured = await d.stabilityScope(context, context.ui.page, preset, undefined, config.directory, `scope-${preset}`);
      await log(context, "scope", measured.result); result.metrics[`scope-${preset}`] = measured.result.wallMs;
    }
    const finalOracleStarted = Date.now(); result.finalOracle = await d.verifyFull(context, "ordinary-final");
    result.finalOracleWallMs = Date.now() - finalOracleStarted;
    result.reopen = await d.idleAndReopen(context); result.metrics.reopen = result.reopen.wallMs;
    result.ordinarySafety = assertOrdinaryControl(await hookRows(control), config.variant);
    result.ordinaryRounds = result.ordinarySafety.rounds;
    for (const preset of ["today", "all"]) {
      const row = (await ndjson(path.join(config.directory, "events.ndjson"))).find(row => row.type === `startup-${preset}` && row.page === 0);
      assert.ok(row); result.metrics[`startup-${preset}`] = row.wallMs;
    }
    for (const row of result.ordinary) {
      result.metrics[`append-${row.kind}`] = row.landingToPaintMs; result.metrics[`view-${row.kind}`] = row.viewLandingToPaintMs;
    }
    await save(path.join(config.directory, "ordinary.json"), { ...result, passed: true });
    if (config.label === "two-years" && config.variant === "candidate") {
      await beforeContinuous(context, result); result.continuous = await runContinuous(d, context);
    }
    assert.equal(context.failures.length, 0, JSON.stringify(context.failures));
    result.completed = true;
    result.passed = !result.continuous || result.continuous.passed;
  } catch (error) { result.failure = errorRecord(error); }
  finally {
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    if (context) {
      result.continuous ??= context.continuous;
      result.inputs = context.inputs;
      try { await stopOwned(d, context, Boolean(result.failure)); } catch (error) { result.cleanupError = errorRecord(error); result.passed = false; }
    } else if (await exists(path.join(config.directory, "base-ledger.json"))) {
      await save(path.join(config.directory, "stopped.json"), { stopped: true, neverLaunched: true });
    }
    try { await recover(prepared, config.directory); }
    catch (error) { result.restorationError = errorRecord(error); result.passed = false; }
    result.endedAtMs = Date.now(); await save(path.join(config.directory, "result.json"), result);
  }
  if (CARD !== PUBLICATION_CARD) assert.equal(result.passed, true, JSON.stringify(result));
  const analysis = await analyzeGroup(config.directory); await save(path.join(config.directory, "analysis.json"), analysis);
  assert.equal(CARD === PUBLICATION_CARD ? canContinueGroup(analysis) : analysis.passed, true,
    "Correctness/memory/cleanup failure or missing safety evidence; stop remaining groups (all verdicts retained)");
  return analysis;
}

export async function analyzeGroup(directory, card = CARD) {
  const evidence = [], reliability = gates(), resource = gates(), timing = gates();
  const readEvidence = async name => {
    try { return await read(path.join(directory, name)); }
    catch (error) { evidence.push({ file: path.join(directory, name), status: error.code === "ENOENT" ? "missing" : "invalid", ...errorRecord(error) }); return null; }
  };
  const verify = (id, available, action, group = reliability) => {
    if (!available) { check(group, id, "incomplete", "Evidence missing"); return; }
    try { const value = action(); check(group, id, "passed", value); return value; }
    catch (error) { check(group, id, "failed", errorRecord(error)); }
  };
  const result = await readEvidence("result.json"), events = [], mutations = [];
  await streamNdjson(path.join(directory, "events.ndjson"), row => events.push(row), evidence);
  await streamNdjson(path.join(directory, "mutations/mutations.ndjson"), row => { if (row.operation === "append") mutations.push(row); }, evidence);
  const label = result?.label ?? path.basename(path.dirname(directory)), variant = result?.variant ?? path.basename(directory);
  const inputs = result?.inputs ?? [], responses = events.filter(row => row.type === "response"), continuous = result?.continuous;
  const hasContinuous = label === "two-years" && variant === "candidate";
  verify("execution", result, () => {
    assert.ok(result.completed ?? result.passed, "Group did not complete");
    for (const key of ["failure", "cleanupError", "restorationError"]) assert.ok(!result[key], JSON.stringify(result[key]));
  });
  verify("paint-evidence", result?.inputs, () => assert.deepEqual(closeoutObservationErrors(inputs, responses), []));
  verify("ordinary-inputs", result?.ordinary, () => assert.deepEqual(result.ordinary.map(row => row.kind), KINDS));
  verify("continuous-closeout", !hasContinuous || continuous, () => {
    assert.equal(Boolean(continuous), hasContinuous);
    if (continuous) assert.deepEqual(inputs.slice(3), continuous.inputs);
  });
  if (hasContinuous && card === PUBLICATION_CARD && continuous) {
    Object.assign(timing, publicationTiming(continuous.inputs, continuous.startedAtMs, continuous.stoppedAtMs, continuous.drainCompletedAtMs));
    for (const row of continuous.timingFailures ?? []) check(timing, row.id, "failed", row);
  } else if (hasContinuous) verify("continuous-timing", continuous, () => {
    assertContinuous(continuous.inputs, continuous.startedAtMs, continuous.stoppedAtMs, card);
    assert.ok(continuous.drainCompletedAtMs <= continuous.lastInputAtMs + card.drainMs);
  }, timing);
  else check(timing, "ordinary-only", "passed");
  verify("append-count", result?.inputs, () => assert.equal(inputs.length, hasContinuous ? card.appendCount + 3 : 3), timing);
  verify("input-ledger", result?.inputs, () => {
    assert.equal(mutations.length, inputs.length); assert.equal(new Set(inputs.map(row => row.eventId)).size, inputs.length);
    for (const input of inputs) {
      assert.equal(mutations.filter(row => row.kind === input.kind && row.ordinal === input.ordinal).length, 1);
      for (const type of ["input-landed", "input-visible", "view-visible"])
        assert.equal(events.filter(row => row.type === type && row.eventId === input.eventId).length, 1);
    }
  });
  const pendingResponses = verify("http-responses", events.length, () => checkPending(events, variant === "candidate"));
  const oracles = events.filter(row => row.type === "oracle" && !row.result?.retry);
  for (const name of ["initial", "ordinary-final", "reopen", ...(hasContinuous ? ["continuous-final", "continuous-reopen"] : [])])
    verify(`oracle/${name}`, events.length, () => assert.ok(oracles.some(row => row.name === name && row.result?.passed === true && !row.result.skipped), `Missing oracle: ${name}`));
  const closed = await readEvidence("closed.json"), restoration = await readEvidence("restoration.json");
  verify("cleanup", closed && restoration, () => {
    assert.deepEqual(closed.errors, []); assert.equal(restoration.rawRestored, true); assert.equal(restoration.restored, true);
  });
  const summary = await readEvidence("resource-summary.json"), rawControl = [];
  let control, resourceSummary, sourceWork;
  try {
    control = await controls(path.join(directory, "control"), evidence);
    rawControl.push(...await hookRows(path.join(directory, "control")));
  } catch (error) { evidence.push({ file: path.join(directory, "control"), status: error.code === "ENOENT" ? "missing" : "invalid", ...errorRecord(error) }); }
  const ordinarySafety = verify("ordinary-source-work", rawControl.length, () => assertOrdinaryControl(
    continuous ? rawControl.filter(row => row.atMs < continuous.startedAtMs) : rawControl, variant));
  const internalRecovery = verify("internal-recovery", rawControl.length, () => assertInternalRecovery(rawControl, continuous, events));
  const work = verify("ordinary-work", result?.ordinary && rawControl.length, () => ordinaryWork(result.ordinary, rawControl));
  const phase = { mode: "live-source-ordinary", inputs, result, expectedSchedule: { profile: CLOSEOUT_PROFILE, cycles: [], events: [] } };
  const observations = { closed, faults: [], firstAllResponse: responses.find(row => row.preset === "all"),
    lastAllResponse: responses.filter(row => row.preset === "all").at(-1) };
  sourceWork = verify("control", control, () => controlChecks(label, control, observations, [phase], reliability));
  try {
    if (control) {
      resourceSummary = await resourceEvidence(directory, summary, control, phase, observations, evidence);
      // Existing resource gates name the last sampler final-reopen; map only the final-close evidence.
      if (continuous) resourceSummary.lastSamples = resourceSummary.lastSamples
        .filter(row => row.directory !== "resources-final-reopen")
        .map(row => row.directory === "resources-continuous-reopen" ? { ...row, directory: "resources-final-reopen" } : row);
      resourceChecks(label, resourceSummary, summary ? [summary] : [], [phase], closed, resource);
      if (card === PUBLICATION_CARD && Object.keys(summary?.incompleteCosts ?? {}).length) {
        const cost = resource.checks.find(row => row.id.endsWith("/cpu-io-storage-cost"));
        if (cost.status === "passed") cost.status = "incomplete";
        cost.evidence.incompleteSummaryCounters = summary.incompleteCosts;
      }
    } else check(resource, "resource-evidence", "incomplete");
  } catch (error) { check(resource, "resource-evidence", "incomplete", errorRecord(error)); }
  finish(reliability); finish(resource); finish(timing);
  const overall = gates();
  for (const [id, group] of Object.entries({ reliability, resource, timing })) check(overall, id, group.status);
  check(overall, "raw-evidence", evidence.some(row => row.status !== "missing") ? "failed" : evidence.length ? "incomplete" : "passed", evidence);
  return { label, variant, ...finish(overall), completed: Boolean(result?.completed ?? result?.passed), metrics: result?.metrics ?? {},
    ordinaryRounds: result?.ordinaryRounds, work, reliability, resource, timing, evidence, ordinarySafety, internalRecovery,
    sourceWork, resources: resourceSummary, pendingResponses, appends: inputs.length,
    reopens: Number(Boolean(result?.reopen)) + Number(Boolean(continuous?.reopen)), statisticalP95Claim: false };
}

export function summarizeGroups(groups, card = CARD) {
  const pairs = LABELS.map(label => {
    const before = groups.find(row => row.label === label && row.variant === "baseline"), after = groups.find(row => row.label === label && row.variant === "candidate");
    return { label, ...comparePair(before, after, card) };
  });
  const workload = { appends: groups.reduce((n, row) => n + row.appends, 0), reopens: groups.reduce((n, row) => n + row.reopens, 0),
    expectedAppends: 18 + card.appendCount, expectedReopens: 7 };
  const result = gates();
  for (const group of groups) check(result, `${group.label}/${group.variant}`, group.status ?? (group.passed ? "passed" : "incomplete"));
  for (const pair of pairs) {
    check(result, `R/${pair.label}`, pair.status, pair);
  }
  check(result, "workload", workload.appends === workload.expectedAppends && workload.reopens === workload.expectedReopens ? "passed" :
    groups.every(row => row.completed) ? "failed" : "incomplete", workload);
  return { ...finish(result), groups, pairs, workload, statisticalP95Claim: false };
}

export async function inspectResults(outputRoot = ROOT, card = CARD) {
  const groups = [];
  for (const group of plan(card)) groups.push(await analyzeGroup(path.join(outputRoot, "short", group.label, group.variant), card));
  return summarizeGroups(groups, card);
}

// inspect never writes; finish only derives a new report and removes proven-restored rollback copies.
export async function finishResults(outputRoot = ROOT, card = CARD) {
  const result = await inspectResults(outputRoot, card);
  result.cleanup = [];
  for (const label of LABELS) {
    const file = path.join(outputRoot, "preparations", `${label}.json`);
    if (!await exists(file)) continue;
    const prepared = await read(file);
    if (!await exists(prepared.config.startState)) continue;
    try {
      for (const variant of ["baseline", "candidate"]) {
        const directory = path.join(outputRoot, "short", label, variant);
        if (await exists(path.join(directory, "base-ledger.json")))
          assert.equal((await read(path.join(directory, "stopped.json"))).stopped, true);
      }
      await cleanupSnapshot(prepared, outputRoot); result.cleanup.push({ label, deleted: true });
    } catch (error) { result.cleanup.push({ label, deleted: false, ...errorRecord(error) }); }
  }
  if (result.cleanup.some(row => !row.deleted)) { result.status = "failed"; result.passed = false; }
  const file = path.join(outputRoot, `analysis-finish-${Date.now()}.json`);
  await save(file, result); return { file, result };
}

async function main() {
  const [command, label, variant] = process.argv.slice(2);
  if (command === "plan") return console.log(JSON.stringify({ root: ROOT, baseline: CARD.baseline, groups: plan(),
    continuous: { durationMs: CARD.durationMs, appendCount: CARD.appendCount, drainMs: CARD.drainMs }, appends: 18 + CARD.appendCount, reopens: 7, statisticalP95Claim: false }, null, 2));
  assert.equal(path.resolve(process.env.WINDOWS_CLOSEOUT_ROOT || ""), ROOT);
  if (command === "inspect") {
    if (label) { assert.ok(LABELS.includes(label)); assert.ok(["baseline", "candidate"].includes(variant)); }
    const result = label ? await analyzeGroup(path.join(ROOT, "short", label, variant)) : await inspectResults();
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 1; return;
  }
  if (command === "finish") {
    const { file, result } = await finishResults();
    console.log(JSON.stringify({ file, status: result.status, workload: result.workload, cleanup: result.cleanup }, null, 2));
    process.exitCode = result.passed ? 0 : 1; return;
  }
  if (command === "freeze-candidate") return freezeCandidate();
  if (command === "recover" || command === "cleanup") {
    assert.ok(LABELS.includes(label));
    const prepared = await read(path.join(ROOT, "preparations", `${label}.json`));
    if (command === "cleanup") return cleanupSnapshot(prepared);
    assert.ok(["baseline", "candidate"].includes(variant));
    return recover(prepared, path.join(ROOT, "short", label, variant));
  }
  assert.equal(command, "run", "Use plan | run | inspect [<label> <variant>] | finish | recover <label> <variant> | cleanup <label> (legacy only: freeze-candidate)");
  await driver(); await runtime("baseline"); await runtime("candidate");
  const groups = [];
  for (const name of LABELS) {
    const prepared = await snapshot(await configFor(name, "baseline"));
    await save(path.join(ROOT, "preparations", `${name}.json`), prepared);
    try {
      for (const group of plan().filter(row => row.label === name)) groups.push(await runGroup(await configFor(name, group.variant), prepared));
      const pair = comparePair(groups.find(row => row.label === name && row.variant === "baseline"), groups.find(row => row.label === name && row.variant === "candidate"));
      await save(path.join(ROOT, "pairs", `${name}.json`), pair);
    } finally {
      // A restoration failure keeps its snapshot and prevents cleanup.
      if ((await Promise.all(["baseline", "candidate"].map(v => exists(path.join(ROOT, "short", name, v, "result.json")))))
        .some(Boolean)) {
        const attempts = [];
        for (const v of ["baseline", "candidate"]) {
          const file = path.join(ROOT, "short", name, v, "result.json");
          if (await exists(file)) attempts.push(await read(file));
        }
        if (attempts.every(row => !row.restorationError)) await cleanupSnapshot(prepared);
      }
    }
  }
  const result = summarizeGroups(groups);
  await save(path.join(ROOT, "analysis.json"), result); process.exitCode = result.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
