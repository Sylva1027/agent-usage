import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createContext, attachPage, waitUsageResponse, pollBrowser, idleAndReopen,
  startSampler, dispatch, verifyFull, finishContext, pollResources } from "./windows-stability-run.mjs";
import {
  plan, continuousSchedule, assertContinuous, comparePair, isSourceUpdatePending,
  snapshot, restoreSnapshot, cleanupSnapshot, identity, ordinaryWork, checkPending, assertOrdinaryControl, assertInternalRecovery, activeExecutors,
  LEGACY_CARD, PUBLICATION_CARD, publicationTiming, runContinuous, settlePublicationTabs, canContinueGroup, analyzeGroup, inspectResults, summarizeGroups, finishResults,
} from "./live-source-recovery-run.mjs";

test("committed publication selects 401faeb, 36 appends, seven reopens, and exactly 27 R metrics without changing legacy", () => {
  const groups = plan(PUBLICATION_CARD), schedule = continuousSchedule(PUBLICATION_CARD);
  assert.equal(PUBLICATION_CARD.baseline, "401faeb");
  assert.equal(groups.length, 6); assert.equal(groups.reduce((n, row) => n + row.ordinary.length + row.continuous, 0), 36);
  assert.equal(groups.reduce((n, row) => n + row.reopens, 0), 7);
  assert.deepEqual(groups.map(row => `${row.label}/${row.variant}`), plan(LEGACY_CARD).map(row => `${row.label}/${row.variant}`));
  assert.equal(schedule.durationMs, 90_000); assert.equal(schedule.appendCount, 18); assert.equal(PUBLICATION_CARD.drainMs, 60_000);
  assert.deepEqual(schedule.events.map(row => [row.atMs, row.kind]), Array.from({ length: 18 }, (_, i) => [i * 5000, i % 2 ? "dsh" : "codex"]));
  assert.equal(comparePair(measurement(), measurement(), PUBLICATION_CARD).timings.length * 3, 27);
  assert.equal(comparePair(measurement(), measurement(), LEGACY_CARD).timings.length, 12);
  assert.equal(continuousSchedule(LEGACY_CARD).durationMs, 180_000); assert.equal(continuousSchedule(LEGACY_CARD).appendCount, 36);
});

test("the new-root CLI plan is read-only and accepts the shared driver's root admission", async () => {
  const script = path.join(path.dirname(path.dirname(PUBLICATION_CARD.root)), "experiments/architecture-20261101/live-source-recovery-run.mjs");
  const { stdout } = await promisify(execFile)(process.execPath, [script, "plan"], {
    env: { ...process.env, WINDOWS_CLOSEOUT_ROOT: PUBLICATION_CARD.root }, windowsHide: true, timeout: 10_000,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.root, PUBLICATION_CARD.root); assert.equal(result.baseline, "401faeb");
  assert.equal(result.appends, 36); assert.equal(result.reopens, 7); assert.equal(result.continuous.drainMs, 60_000);
});

test("final summaries retain a known R regression alongside missing evidence and all resource verdicts", () => {
  const groups = plan(PUBLICATION_CARD).map(row => ({ ...measurement(), ...row, status: "incomplete", completed: true,
    appends: row.ordinary.length + row.continuous, reopens: row.reopens,
    resource: { checks: [{ id: `${row.label}/cpu-io-storage-cost`, status: "incomplete" }] } }));
  groups[1].metrics["append-dsh"] = 1101; delete groups[1].metrics["startup-all"];
  const result = summarizeGroups(groups, PUBLICATION_CARD);
  assert.equal(result.status, "failed"); assert.equal(result.passed, false);
  assert.equal(result.pairs[0].status, "failed");
  assert.equal(result.pairs[0].timings.find(row => row.key === "startup-all").status, "incomplete");
  assert.equal(result.workload.appends, 36); assert.equal(result.workload.reopens, 7);
  assert.equal(result.groups[0].resource.checks[0].status, "incomplete");
});

test("publication timing keeps all failed verdicts, including exact last-input drain and both live sources", () => {
  const start = 1_000_000, inputs = continuous().slice(0, 18), last = inputs.at(-1).landedAtMs;
  assert.equal(publicationTiming(inputs, start, start + 90_000, last + 60_000).passed, true);
  assert.equal(publicationTiming(inputs, start, start + 90_000, last + 60_001).passed, false);
  const stalled = inputs.map(row => ({ ...row, paintedAtMs: last + 61_000, usageVersion: "one" }));
  const result = publicationTiming(stalled, start, start + 90_000, last + 61_000);
  assert.deepEqual(result.checks.filter(row => row.status === "failed").map(row => row.id),
    ["writer-versions", "writer-progress-codex", "writer-progress-dsh", "autonomous-drain"]);
  assert.throws(() => assertContinuous(stalled, start, start + 90_000, PUBLICATION_CARD), /two completed versions/);
});

async function continuousDriver(t, { lateDrain = false, lateSlot = false, unsafe = false, slowTab = false } = {}) {
  const directory = await testDirectory(t), start = 1_000_000;
  let now = start, polls = 0;
  t.mock.method(Date, "now", () => now);
  const context = createContext({ directory, ledger: { appendCount: 3, entries: [] } }), calls = [];
  const d = {
    async dispatch(c, event) {
      calls.push(event.type);
      if (event.type === "tabs-open") {
        c.pages = Array.from({ length: 3 }, (_, index) => ({ isClosed: () => false,
          evaluate: async () => ({ total: 123, busy: slowTab && index === 2 && now < start + 170_000 }) }));
        c.bodies = c.pages.map((_, page) => ({ page, preset: "all", total: 123, usageVersion: "final", body: {} }));
      }
      if (event.type === "tabs-close") c.pages = c.pages.slice(0, 1);
      if (event.type === "append") {
        c.ledger.appendCount++; c.inputs.push({ ...event, eventId: event.id, operation: "append", landedAtMs: now,
          ...(!lateDrain ? { paintedAtMs: now + 100, usageVersion: `v${event.ordinal}` } : {}) });
      }
    },
    async pollBrowser(c) {
      if (polls++) now += lateSlot && polls === 2 ? 10_000 : 5000;
      if (lateDrain && now >= start + 150_000) for (const input of c.inputs) Object.assign(input, { paintedAtMs: now, usageVersion: "drained" });
    },
    async pollResources() { if (unsafe && polls > 2) throw Error("Service tree exceeded 512 MiB"); },
    visibleInputs(c) { return { entries: c.ledger.entries }; },
    async verifyFull(c, name) { calls.push(name); assert.ok(c.inputs.every(row => row.paintedAtMs)); return { passed: true }; },
    async idleAndReopen(c, name) { calls.push(`${name}-reopen`); return { wallMs: 123 }; },
  };
  return { context, d, calls, directory };
}

test("a late drain records failure before full oracle and extra reopen, retaining the timing failure", async t => {
  const f = await continuousDriver(t, { lateDrain: true });
  const result = await runContinuous(f.d, f.context, PUBLICATION_CARD);
  assert.equal(result.passed, false); assert.equal(result.completed, true); assert.equal(result.inputs.length, 18);
  assert.ok(result.timingFailures.some(row => row.id === "autonomous-drain"));
  assert.deepEqual(f.calls.slice(-3), ["tabs-close", "continuous-final", "continuous-reopen"]);
  const disk = JSON.parse(await fs.readFile(path.join(f.directory, "continuous.json"), "utf8"));
  assert.equal(disk.passed, false); assert.equal(disk.oracle.passed, true); assert.equal(disk.reopen.wallMs, 123);
  const events = (await fs.readFile(path.join(f.directory, "events.ndjson"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(events.some(row => row.type === "timing-failure" && row.atMs < result.drainCompletedAtMs));
});

test("successful publication still requires the final oracle and extra reopen", async t => {
  const f = await continuousDriver(t);
  const result = await runContinuous(f.d, f.context, PUBLICATION_CARD);
  assert.equal(result.passed, true); assert.equal(result.completed, true); assert.equal(result.timing.passed, true);
  assert.equal(result.inputs.length, 18); assert.equal(f.context.pages.length, 1);
  assert.deepEqual(f.calls.slice(-3), ["tabs-close", "continuous-final", "continuous-reopen"]);
});

test("four cycles keep unique inputs and can defer the single service reopen", async t => {
  const f = await continuousDriver(t);
  const result = await runContinuous(f.d, f.context, PUBLICATION_CARD, { cycle: 1, reopen: false });
  assert.equal(result.passed, true); assert.equal(result.reopen, undefined);
  assert.ok(result.inputs.every(row => row.eventId.startsWith("cycle-1-")));
  assert.ok(f.calls.includes("cycle-1-continuous-final"));
  assert.equal(f.calls.includes("continuous-reopen"), false);
  const ids = Array.from({ length: 4 }, (_, i) => continuousSchedule(PUBLICATION_CARD, i + 1).events.map(row => row.id)).flat();
  assert.equal(new Set(ids).size, 72);
});

test("first paint timing stays fixed while other tabs finish before oracle admission", async t => {
  const f = await continuousDriver(t, { slowTab: true });
  const result = await runContinuous(f.d, f.context, PUBLICATION_CARD);
  assert.equal(result.passed, true);
  assert.ok(result.tabsSettled.atMs > result.drainCompletedAtMs + 10_000);
  assert.ok(result.tabsSettled.pages.every(row => row.complete && !row.busy));
  assert.ok(result.drainCompletedAtMs <= result.lastInputAtMs + 60_000);
  assert.deepEqual(f.calls.slice(-3), ["tabs-close", "continuous-final", "continuous-reopen"]);
});

test("a stale tab cannot be closed to manufacture a completed continuous check", async t => {
  const f = await continuousDriver(t);
  await f.d.dispatch(f.context, { type: "tabs-open" });
  f.context.bodies[2].body.updatePending = true;
  await assert.rejects(settlePublicationTabs(f.d, f.context, Date.now() + 10_000), /fixed deadline/);
  assert.equal(f.context.pages.length, 3);
  assert.equal(f.calls.includes("tabs-close"), false);
});

test("a missed slot stops injection without bunching, but still performs safe closeout", async t => {
  const f = await continuousDriver(t, { lateSlot: true });
  const result = await runContinuous(f.d, f.context, PUBLICATION_CARD);
  assert.equal(result.inputs.length, 1); assert.equal(result.completed, true); assert.equal(result.passed, false);
  assert.ok(result.timing.checks.some(row => row.id === "writer-workload" && row.status === "failed"));
  assert.ok(f.calls.includes("continuous-final")); assert.ok(f.calls.includes("continuous-reopen"));
});

test("a real memory failure stops load and oracle immediately while preserving continuous failure evidence", async t => {
  const f = await continuousDriver(t, { unsafe: true });
  await assert.rejects(runContinuous(f.d, f.context, PUBLICATION_CARD), /512 MiB/);
  assert.equal(f.calls.includes("continuous-final"), false); assert.equal(f.calls.includes("continuous-reopen"), false);
  const result = JSON.parse(await fs.readFile(path.join(f.directory, "continuous.json"), "utf8"));
  assert.equal(result.passed, false); assert.match(result.failure.message, /512 MiB/);
});

test("CPU/storage incompleteness remains incomplete and permits unrelated groups; correctness, memory and live processes do not", () => {
  const analysis = { completed: true, reliability: { passed: true }, evidence: [], resource: { checks: [
    { id: "current/active-memory", status: "passed" }, { id: "current/cpu-io-storage-cost", status: "incomplete" },
    { id: "current/normal-close-primary-wal", status: "incomplete", evidence: { finalSample: { serviceProcessCount: 0, sqlite: { complete: false } } } },
  ] } };
  const original = structuredClone(analysis); assert.equal(canContinueGroup(analysis), true); assert.deepEqual(analysis, original);
  analysis.reliability.passed = false; assert.equal(canContinueGroup(analysis), false); analysis.reliability.passed = true;
  analysis.resource.checks[0].status = "incomplete"; assert.equal(canContinueGroup(analysis), false);
  analysis.resource.checks[0].status = "failed"; assert.equal(canContinueGroup(analysis), false);
  analysis.resource.checks[0].status = "passed";
  analysis.resource.checks[2].evidence.finalSample.serviceProcessCount = 1; assert.equal(canContinueGroup(analysis), false);
});

test("opt-in sampler summaries keep missing cost fields null even after later complete samples", async () => {
  let sample = { atUnixMs: Date.now(), service: { processCount: 0, workingSetBytes: 0 }, browser: { workingSetBytes: 0 }, processes: [] };
  const context = createContext({ preserveMissingCosts: true });
  context.resourceTails = [{ read: async () => [JSON.stringify(sample)] }];
  await pollResources(context);
  assert.equal(context.resourceSummary.cpuSeconds, null); assert.equal(context.resourceSummary.peakStorageBytes, null);
  sample = { ...sample, service: { ...sample.service, cpuSecondsIncrement: 1, logicalReadBytesIncrement: 2, logicalWriteBytesIncrement: 3 },
    observer: { cpuSeconds: 1 }, state: { complete: true, observedBytes: 12 }, sqlite: { complete: true, categoryBytes: { wal: 0 } } };
  await pollResources(context); assert.equal(context.resourceSummary.cpuSeconds, null); assert.equal(context.resourceSummary.peakWalBytes, null);
});

test("inspection tolerates incomplete groups, preserves multiple failures and never overwrites raw evidence", async t => {
  const root = await testDirectory(t), directory = path.join(root, "short", "two-years", "candidate");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "result.json"), raw = JSON.stringify({ label: "two-years", variant: "candidate", passed: false,
    inputs: [], ordinary: [{ kind: "wrong" }], failure: { message: "original failure" } });
  await fs.writeFile(file, raw); await fs.writeFile(path.join(directory, "analysis.json"), "original analysis");
  const analysis = await analyzeGroup(directory, PUBLICATION_CARD);
  assert.equal(analysis.passed, false); assert.equal(analysis.resource.status, "incomplete");
  assert.ok(analysis.reliability.checks.filter(row => row.status === "failed").length >= 2);
  const result = await inspectResults(root, PUBLICATION_CARD);
  assert.equal(result.groups.length, 6); assert.equal(result.passed, false); assert.equal(result.workload.expectedAppends, 36);
  assert.equal(await fs.readFile(file, "utf8"), raw); assert.equal(await fs.readFile(path.join(directory, "analysis.json"), "utf8"), "original analysis");
  assert.deepEqual((await fs.readdir(directory)).sort(), ["analysis.json", "result.json"]);
});

test("oracle admission waits for every spawned executor and handles PID reuse", () => {
  const rows = [{ event: "executor-spawn", childPid: 1 }, { event: "executor-spawn", childPid: 2 }];
  assert.deepEqual(activeExecutors(rows), [1, 2]);
  rows.push({ event: "executor-exit", childPid: 1 });
  assert.deepEqual(activeExecutors(rows), [2]);
  rows.push({ event: "executor-spawn", childPid: 1 }, { event: "executor-exit", childPid: 2 });
  assert.deepEqual(activeExecutors(rows), [1]);
  rows.push({ event: "executor-exit", childPid: 1 });
  assert.deepEqual(activeExecutors(rows), []);
});

test("full-oracle mode rejects a partial committed version and admits the readonly oracle after UI verification", async t => {
  const directory = await testDirectory(t), kinds = ["codex", "dsh", "claude", "workbuddy", "zcode", "opencode"];
  const entry = { operation: "append", kind: "codex", expectedDelta: 160, deltaTokens: { input: 140, cached: 30, output: 20, reasoning: 5 } };
  const context = createContext({ directory, requireCompleteOracle: true, state: "unused", dataset: { home: "unused", expectedSessions: 6,
    expected: kinds.map(kind => ({ kind, events: 1, total: 10, input: 8, cached: 0, output: 2, reasoning: 0 })) }, ledger: { entries: [entry] } });
  const body = { metadata: { eventCount: 6, sessionCount: 6, homes: kinds.map(kind => ({ kind, eventCount: 1 })) },
    periodComparison: { totals: { all: { total: 60 } } }, summary: { totals: { total: 60 }, costEstimate: { totalUsd: 0, totalCny: 0 } },
    pricingCatalog: { usdToCnyRate: 7 } };
  context.bodies.push({ preset: "all", body });
  await assert.rejects(verifyFull(context, "partial"), /all response missing/);
  body.metadata.eventCount++; body.metadata.homes[0].eventCount++;
  body.periodComparison.totals.all.total += 160; body.summary.totals.total += 160;
  const calls = [];
  context.ui = { page: { waitForFunction: async () => calls.push("ui-verified") } };
  context.beforeOracle = async () => { calls.push("oracle-admission"); throw Error("fixture stops before spawn"); };
  await assert.rejects(verifyFull(context, "full"), /fixture stops before spawn/);
  assert.deepEqual(calls, ["ui-verified", "oracle-admission"]);
  assert.equal(context.oracleChildren.size, 0);
});

test("six interleaved groups contain exactly 54 appends and seven reopens; no custom range or long schedule", () => {
  const groups = plan();
  assert.deepEqual(groups.map(row => `${row.label}/${row.variant}`), [
    "current/baseline", "current/candidate", "year/candidate", "year/baseline", "two-years/baseline", "two-years/candidate",
  ]);
  assert.equal(groups.reduce((n, row) => n + row.ordinary.length + row.continuous, 0), 54);
  assert.equal(groups.reduce((n, row) => n + row.reopens, 0), 7);
  for (const row of groups) {
    assert.deepEqual(row.ordinary, ["codex", "dsh", "zcode"]);
    assert.deepEqual(row.scopes, ["today", "week", "all"]);
  }
  const schedule = continuousSchedule();
  assert.equal(schedule.durationMs, 180_000); assert.equal(schedule.appendCount, 36);
  assert.deepEqual(schedule.events.map(row => row.atMs), Array.from({ length: 36 }, (_, i) => i * 5000));
  assert.deepEqual(schedule.events.map(row => row.kind), Array.from({ length: 36 }, (_, i) => i % 2 ? "dsh" : "codex"));
});

test("only the exact pending status/code without any summary or data field qualifies", () => {
  assert.equal(isSourceUpdatePending(409, { code: "SOURCE_UPDATE_PENDING", error: "retry" }), true);
  for (const [status, body] of [
    [200, { code: "SOURCE_UPDATE_PENDING" }], [500, { code: "SOURCE_UPDATE_PENDING" }],
    [409, { code: "LIVE_SOURCE_CHANGED" }], [409, { code: "SOURCE_UPDATE_PENDING", summary: null }],
    [409, { code: "SOURCE_UPDATE_PENDING", data: undefined }], [409, null], [409, []], [409, "SOURCE_UPDATE_PENDING"],
  ]) assert.equal(isSourceUpdatePending(status, body), false);
});

test("pending remains incomplete without a later successful version on the same page", () => {
  const pending = { type: "http-pending", page: 1, atMs: 100, status: 409, code: "SOURCE_UPDATE_PENDING", body: { code: "SOURCE_UPDATE_PENDING" } };
  const response = { type: "response", page: 1, atMs: 101, usageVersion: "completed" };
  assert.equal(checkPending([pending, response], true), 1);
  for (const rows of [[pending], [pending, { ...response, page: 0 }], [pending, { ...response, atMs: 99 }],
    [pending, { ...response, usageVersion: null }], [{ ...pending, body: undefined }, response],
    [{ ...pending, body: { ...pending.body, summary: {} } }, response],
    [pending, response, { type: "http-error", status: 409, code: "CONFLICT" }]]) assert.throws(() => checkPending(rows, true));
  assert.throws(() => checkPending([pending, response], false));
});

test("both real observer entry points keep pending unfinished, log it once, and complete only on a successful paint", async t => {
  const directory = await testDirectory(t), now = Date.now(), page = new EventEmitter(), paints = [];
  const kinds = ["codex", "dsh", "claude", "workbuddy", "zcode", "opencode"];
  const entry = { operation: "append", kind: "codex", timestampMs: now, expectedDelta: 160,
    deltaTokens: { input: 140, cached: 30, output: 20, reasoning: 5 } };
  const context = createContext({ directory, allowSourceUpdatePending: true,
    dataset: { expected: kinds.map(kind => ({ kind, events: 1, total: 10, input: 8, cached: 0, output: 2, reasoning: 0 })), expectedSessions: 6 },
    ledger: { entries: [entry] }, selectedSessions: new Map(kinds.map(kind => [kind, kind])) });
  context.inputs.push({ ...entry, eventId: "one", kindCount: 1, landedAtMs: now - 1 });
  context.pages = [page]; context.ui = { page };
  page.isClosed = () => false; page.evaluate = async () => ({ dropped: 0, rows: paints.splice(0) });
  const request = { url: () => "http://localhost/api/usage?preset=all" };
  const response = (status, body) => ({ status: () => status, json: async () => body, url: request.url, request: () => request });
  const pendingBody = { code: "SOURCE_UPDATE_PENDING", error: "retry" }, pending = response(409, pendingBody);
  const success = response(200, { usageVersion: "completed", fingerprint: "complete-proof",
    metadata: { eventCount: 7, sessionCount: 6, homes: kinds.map(kind => ({ kind: kind === "codex" ? "main" : kind, eventCount: kind === "codex" ? 2 : 1 })) },
    periodComparison: { totals: { all: { total: 220 } } }, summary: { timelineError: null,
      range: { preset: "all", start: new Date(0).toISOString(), end: new Date(now + 60000).toISOString() },
      eventCount: 7, sessionCount: 6, totals: { total: 220, input: 188, cached: 30, output: 32, reasoning: 5 }, channels: [] } });
  let pendingSeen, releaseSuccess, listeners = 0, completed = false;
  const observed = new Promise(resolve => { pendingSeen = resolve; }), release = new Promise(resolve => { releaseSuccess = resolve; });
  page.waitForResponse = async (predicate, options) => {
    listeners++; assert.equal(options.timeout, 4321);
    page.emit("response", pending); assert.equal(await predicate(pending), false); pendingSeen();
    await release;
    page.emit("response", success); assert.equal(await predicate(success), true); return success;
  };
  await attachPage(context, page); page.emit("request", request);
  const waiting = waitUsageResponse(context, page, "all", 220, 4321).then(value => { completed = true; return value; });
  await observed; await Promise.all(context.responseTasks);
  paints.push({ kind: "paint", clock: Date.now(), total: "220" }); await pollBrowser(context);
  assert.equal(completed, false); assert.equal(context.responseSequence, 0); assert.deepEqual(context.bodies, []);
  assert.equal(context.lastBody, undefined); assert.equal(context.inputs[0].paintedAtMs, undefined);
  assert.equal(context.inputs[0].viewVisibleAtMs, undefined); assert.deepEqual(context.failures, []);
  const before = (await fs.readFile(path.join(directory, "events.ndjson"), "utf8")).trim().split("\n").map(JSON.parse);
  const receipts = before.filter(row => row.type === "http-pending"); assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].body, pendingBody); assert.equal(receipts[0].page, 0); assert.equal(receipts[0].status, 409);
  assert.equal(receipts[0].url, "/api/usage?preset=all"); assert.ok(Number.isFinite(receipts[0].requestStartedAtMs));
  releaseSuccess(); assert.equal(await waiting, success); await Promise.all(context.responseTasks);
  assert.deepEqual(context.failures, []);
  assert.equal(context.inputs[0].paintedAtMs, undefined, "Response alone must not complete the paint clock");
  paints.push({ kind: "paint", clock: Date.now(), total: "220" }); await pollBrowser(context);
  assert.equal(context.inputs[0].usageVersion, "completed"); assert.ok(context.inputs[0].paintedAtMs);
  assert.equal(context.responseSequence, 1); assert.equal(listeners, 1); assert.deepEqual(context.failures, []);
});

test("foreground and background observers reject every non-exact pending shape and keep the old opt-out behavior", async t => {
  const directory = await testDirectory(t);
  const cases = [
    [true, 409, { code: "OTHER" }], [true, 409, { code: "SOURCE_UPDATE_PENDING", summary: null }],
    [true, 409, { code: "SOURCE_UPDATE_PENDING", data: undefined }], [true, 500, { code: "SOURCE_UPDATE_PENDING" }],
    [true, 409, null], [true, 409, []], [undefined, 409, { code: "SOURCE_UPDATE_PENDING" }],
    [false, 409, { code: "SOURCE_UPDATE_PENDING" }], ["true", 409, { code: "SOURCE_UPDATE_PENDING" }],
  ];
  for (const [allowSourceUpdatePending, status, body] of cases) {
    const context = createContext({ directory, allowSourceUpdatePending }), page = new EventEmitter();
    context.pages = [page];
    const request = { url: () => "http://localhost/api/usage?preset=all" };
    const response = { status: () => status, json: async () => body, url: request.url, request: () => request };
    page.waitForResponse = async predicate => { await predicate(response); assert.fail("Unexpected HTTP was swallowed"); };
    await assert.rejects(waitUsageResponse(context, page, "all"), /status/);
    await attachPage(context, page); page.emit("request", request); page.emit("response", response);
    await Promise.all(context.responseTasks);
    assert.equal(context.failures.length, 1); assert.match(context.failures[0].message, /Unexpected usage HTTP error/);
    assert.equal(context.responseSequence, 0); assert.deepEqual(context.bodies, []);
  }
  const events = (await fs.readFile(path.join(directory, "events.ndjson"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(events.filter(row => row.type === "http-pending").length, 0);
  assert.equal(events.filter(row => row.type === "http-error").length, cases.length);
});

test("the reused driver exports are available and an invalid reopen name cannot touch the context", async () => {
  for (const fn of [createContext, startSampler, dispatch, verifyFull, idleAndReopen, finishContext]) assert.equal(typeof fn, "function");
  await assert.rejects(idleAndReopen({}, "../elsewhere"), /Unknown reopen name/);
});

const continuous = () => continuousSchedule().events.map((event, i) => ({ ...event, eventId: event.id,
  operation: "append", landedAtMs: 1_000_000 + i * 5000 + 100, paintedAtMs: 1_000_000 + i * 5000 + 1000,
  usageVersion: `version-${Math.floor(i / 2)}` }));

test("continuous acceptance requires real progress from both sources before the last write and a bounded final drain", () => {
  const inputs = continuous(), check = rows => assertContinuous(rows, 1_000_000, 1_180_000);
  const good = check(inputs); assert.ok(good.versions.length > 1); assert.equal(good.drainMs, 900);
  assert.throws(() => check(inputs.slice(1)), /36/);
  assert.throws(() => check(inputs.map(row => ({ ...row, usageVersion: "only-one" }))), /two completed versions/);
  assert.throws(() => check(inputs.map(row => row.kind === "dsh" ? { ...row, paintedAtMs: 1_180_000 } : row)), /live progress for dsh/);
  assert.throws(() => check(inputs.map((row, i) => i === 35 ? { ...row, paintedAtMs: row.landedAtMs + 300_001 } : row)), /300s/);
  assert.throws(() => check(inputs.map((row, i) => i === 5 ? { ...row, landedAtMs: row.landedAtMs + 5000 } : row)), /5s input slot/);
  assert.throws(() => assertContinuous(inputs, 1_000_000, 1_179_999), /ended early/);
});

function measurement(ms = 1000) {
  const keys = ["startup-today", "startup-all", "reopen", "scope-today", "scope-week", "scope-all",
    ...["codex", "dsh", "zcode"].flatMap(kind => [`append-${kind}`, `view-${kind}`])];
  return { metrics: Object.fromEntries(keys.map(key => [key, ms])), ordinaryRounds: 5,
    work: Object.fromEntries(["codex", "dsh", "zcode"].map(kind => [kind, { rounds: 1, commits: 1 }])) };
}

test("R protection requires both strict thresholds and never substitutes a missing timing or extra sync round", () => {
  assert.equal(comparePair(measurement(), measurement(1100)).passed, true);
  assert.equal(comparePair(measurement(), measurement(1101)).passed, false);
  assert.equal(comparePair(measurement(100), measurement(200)).passed, true);
  assert.equal(comparePair(measurement(100), measurement(201)).passed, false);
  const missing = measurement(); delete missing.metrics["append-dsh"];
  assert.equal(comparePair(measurement(), missing).passed, false);
  const amplified = measurement(); amplified.work.zcode.rounds++;
  assert.equal(comparePair(measurement(), amplified).passed, false);
  const duplicate = measurement(); duplicate.work.codex.commits++;
  assert.equal(comparePair(measurement(), duplicate).passed, false);
  const lateRound = measurement(); lateRound.ordinaryRounds++;
  assert.equal(comparePair(measurement(), lateRound).passed, false);
  assert.equal(comparePair(measurement(), measurement()).statisticalP95Claim, false);
});

test("nested prefix/replace telemetry counts one real commit and one parse", () => {
  const inputs = ["codex", "dsh", "zcode"].map((kind, i) => ({ kind, filePath: kind, landedAtMs: i * 100, paintedAtMs: i * 100 + 50 }));
  const rows = inputs.flatMap(row => [
    { event: "fact-commit", filePath: row.filePath, atMs: row.landedAtMs + 10 },
    { event: "source-end", method: "reuseSourcePrefix", filePath: row.filePath, committed: true, parsedBytes: 120, atMs: row.landedAtMs + 11 },
    { event: "source-end", method: "replaceFile", filePath: row.filePath, committed: true, parsedBytes: 120, atMs: row.landedAtMs + 12 },
    { event: "round-end", atMs: row.landedAtMs + 20 },
  ]);
  for (const work of Object.values(ordinaryWork(inputs, rows))) {
    assert.equal(work.commits, 1); assert.equal(work.rounds, 1); assert.equal(work.parsedBytes, 120); assert.equal(work.attempts, 1);
  }
});

test("ordinary groups require zero retries and zero failed attempts, including recovered failures", () => {
  const round = { event: "round-end", sourceWork: { sourceRetries: 0 } };
  assert.deepEqual(assertOrdinaryControl([round], "candidate"), { sourceRetries: 0, failedAttempts: 0, rounds: 1 });
  assert.equal(assertOrdinaryControl([{ event: "round-end", sourceWork: {} }], "baseline").sourceRetries, 0);
  assert.throws(() => assertOrdinaryControl([{ event: "round-end", sourceWork: {} }], "candidate"), /counter evidence/);
  assert.throws(() => assertOrdinaryControl([{ ...round, sourceWork: { sourceRetries: 1 } }], "candidate"), /zero/);
  assert.throws(() => assertOrdinaryControl([round, { event: "source-end", error: "recovered later", errorCode: "LIVE_SOURCE_CHANGED", errorRetryable: true }], "candidate"), /internal failure/);
  assert.throws(() => assertOrdinaryControl([], "candidate"), /evidence missing/);
});

function recoveryEvidence() {
  const source = { event: "source-end", method: "appendFile", atMs: 110, instance: "worker-1", syncId: "sync-1", roundId: "round-1",
    filePath: "codex.jsonl", kind: "main", error: "unchanged stack", errorCode: "LIVE_SOURCE_CHANGED", errorRetryable: true };
  const round = { event: "round-end", atMs: 120, instance: "worker-1", syncId: "sync-1", roundId: "round-1",
    error: "pending stack", errorCode: "SOURCE_UPDATE_PENDING", errorRetryable: true };
  const sync = { ...round, event: "sync-end", atMs: 130 }; delete sync.roundId;
  const commit = { event: "fact-commit", atMs: 200, instance: "worker-2", syncId: "sync-2", roundId: "round-2", filePath: source.filePath, kind: "main" };
  return { rows: [source, round, sync, commit], continuous: { startedAtMs: 100, drainCompletedAtMs: 250,
    inputs: [{ kind: "codex", filePath: source.filePath }, { kind: "dsh", filePath: "dsh.jsonl" }] },
    events: [{ type: "oracle", name: "continuous-final", atMs: 300, result: { passed: true } }] };
}

test("continuous errors require exact classification, same-round source correlation and a later same-source commit plus oracle", () => {
  const f = recoveryEvidence(), check = (rows = f.rows, events = f.events, continuous = f.continuous) => assertInternalRecovery(rows, continuous, events);
  const good = check(); assert.equal(good.recoveredErrors.length, 3); assert.equal(good.failedAttempts, 1);
  assert.equal(good.recoveredErrors[2].commits[0].filePath, "codex.jsonl");
  for (const change of [{ errorCode: "EACCES" }, { errorRetryable: false }, { errorRetryable: undefined },
    { errorCode: undefined }, { atMs: 99 }, { filePath: "other.jsonl" }, { kind: "dsh" }])
    assert.throws(() => check([{ ...f.rows[0], ...change }, ...f.rows.slice(1)]));
  assert.throws(() => check(f.rows.map(row => row.event === "fact-commit" ? { ...row, filePath: "other.jsonl" } : row)), /same-source commit/);
  assert.throws(() => check(f.rows.map(row => row.event === "fact-commit" ? { ...row, atMs: 109 } : row)), /same-source commit/);
  assert.throws(() => check(f.rows.map(row => row.event === "fact-commit" ? { ...row, atMs: 251 } : row)), /same-source commit/);
  assert.throws(() => check(f.rows.filter(row => row.event !== "source-end")), /source-error evidence/);
  assert.throws(() => check(f.rows.map(row => row.event === "source-end" ? { ...row, roundId: "unrelated" } : row)), /source-error evidence/);
  assert.throws(() => check(f.rows.map(row => row.event === "sync-end" ? { ...row, syncId: "unrelated" } : row)), /failed round/);
  assert.throws(() => check(f.rows, []), /oracle missing/);
  assert.throws(() => check(f.rows, [{ ...f.events[0], result: { passed: true, retry: true } }]), /oracle missing/);
  assert.throws(() => assertInternalRecovery(f.rows, undefined, f.events), /outside continuous/);
  assert.throws(() => check([...f.rows, { event: "projection", atMs: 140, error: "bad", errorCode: "SOURCE_UPDATE_PENDING" }]), /Unexpected internal/);
});

test("pending round/sync require only unresolved sources to commit again; an earlier recovered source stays committed", () => {
  const f = recoveryEvidence(), priorError = { ...f.rows[0], filePath: "dsh.jsonl", kind: "dsh", atMs: 101 };
  const priorCommit = { ...f.rows[3], filePath: "dsh.jsonl", kind: "dsh", instance: "worker-1", syncId: "sync-1", roundId: "round-1", atMs: 105 };
  const result = assertInternalRecovery([priorError, priorCommit, ...f.rows], f.continuous, f.events);
  assert.equal(result.recoveredErrors.length, 4);
  assert.deepEqual(result.recoveredErrors.at(-1).commits.map(row => row.filePath), ["codex.jsonl"]);
});

test("hook preserves thrown objects and stack text while adding structured source, round and sync error fields", async t => {
  const directory = await testDirectory(t), hookUrl = new URL("./windows-stability-hook.mjs", import.meta.url).href;
  const code = `import assert from 'node:assert/strict';
    import {readFileSync,readdirSync} from 'node:fs';
    import path from 'node:path';
    import {instrumentStore} from ${JSON.stringify(hookUrl)};
    const changed=Object.assign(new Error('same stack'),{code:'LIVE_SOURCE_CHANGED',retryable:true});
    const pending=Object.assign(new Error('pending stack'),{code:'SOURCE_UPDATE_PENDING',retryable:true});
    class Store {
      async sync(){return this.syncRound();}
      async syncRound(){try{return await this.appendFile({filePath:'codex.jsonl',source:{kind:'main'}});}catch(error){throw this.pending?pending:error;}}
      async appendFile(){if(this.failure)throw changed;return {committed:true};}
      async replaceFile(){} async reuseSourcePrefix(){}
    }
    instrumentStore(Store.prototype);const store=new Store();store.failure=true;
    await assert.rejects(store.sync(),error=>error===changed);
    store.pending=true;await assert.rejects(store.sync(),error=>error===pending);
    store.failure=false;assert.deepEqual(await store.sync(),{committed:true});
    const rows=readdirSync(process.env.WINDOWS_STABILITY_CONTROL_DIR).filter(n=>n.startsWith('events-')).flatMap(n=>
      readFileSync(path.join(process.env.WINDOWS_STABILITY_CONTROL_DIR,n),'utf8').trim().split('\\n').map(JSON.parse));
    const failures=rows.filter(r=>r.error);assert.equal(failures.length,6);
    for(const row of failures){assert.equal(row.errorRetryable,true);assert.equal(row.error,row.errorCode==='LIVE_SOURCE_CHANGED'?changed.stack:pending.stack);}
    assert.equal(failures.filter(r=>r.errorCode==='SOURCE_UPDATE_PENDING').length,2);
    const source=failures.filter(r=>r.event==='source-end');assert.ok(source.every(r=>r.syncId&&r.roundId&&r.filePath==='codex.jsonl'));
    for(const row of rows.filter(r=>['source-end','round-end','sync-end'].includes(r.event)&&!r.error)){
      assert.equal(Object.hasOwn(row,'errorCode'),false);assert.equal(Object.hasOwn(row,'errorRetryable'),false);
    }`;
  const env = { ...process.env, WINDOWS_STABILITY_CONTROL_DIR: directory };
  delete env.NODE_OPTIONS; delete env.CODEX_USAGE_EXECUTOR_CHILD;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], { env, windowsHide: true, timeout: 10000 });
});

async function testDirectory(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "live-source-tool-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("live-source-tool-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function fixture(t) {
  const root = await testDirectory(t);
  const output = path.join(root, "output"), state = path.join(root, "shared-state"), archive = path.join(root, "shared-history.sqlite");
  await fs.mkdir(output); await fs.mkdir(state);
  await fs.writeFile(archive, "immutable history package");
  await fs.writeFile(archive.replace(/\.sqlite$/, ".manifest.json"), '{"archive":true}\n');
  const digest = createHash("sha256").update(await fs.readFile(archive)).digest("hex");
  const db = new DatabaseSync(path.join(state, "usage-index.sqlite"));
  db.exec(`CREATE TABLE events(id INTEGER PRIMARY KEY,total INTEGER);
    INSERT INTO events VALUES(1,160);
    CREATE TABLE history_replaced_facts(fact_table,source_kind,home_id,source_path,payload_digest);
    CREATE TABLE archive_segments(segment_id,database_path,database_sha256);`);
  db.prepare("INSERT INTO archive_segments VALUES('cold',?,?)").run(archive, digest); db.close();
  await fs.writeFile(path.join(state, "pricing.json"), '{"fixed":true}\n');
  const config = { label: "current", state, startState: path.join(output, "snapshots", "current") };
  return { root, output, state, archive, config, prepared: await snapshot(config, output) };
}

function insert(state) {
  const db = new DatabaseSync(path.join(state, "usage-index.sqlite"));
  try { db.exec("INSERT INTO events VALUES(2,320)"); } finally { db.close(); }
}

test("finish derives a separate report and cleans only a proven-restored snapshot without rerunning groups", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.output, "preparations"));
  await fs.writeFile(path.join(f.output, "preparations/current.json"), JSON.stringify(f.prepared));
  await fs.writeFile(path.join(f.output, "analysis.json"), "original aggregate");
  const { file, result } = await finishResults(f.output, PUBLICATION_CARD);
  assert.equal(result.passed, false); assert.equal(result.status, "incomplete");
  assert.deepEqual(result.cleanup, [{ label: "current", deleted: true }]);
  assert.ok(path.basename(file).startsWith("analysis-finish-"));
  assert.equal(await fs.readFile(path.join(f.output, "analysis.json"), "utf8"), "original aggregate");
  await assert.rejects(fs.stat(f.config.startState), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(f.output, "short")), { code: "ENOENT" });
});

test("finish retains the snapshot when the shared state has not been restored", async t => {
  const f = await fixture(t); insert(f.state);
  await fs.mkdir(path.join(f.output, "preparations"));
  await fs.writeFile(path.join(f.output, "preparations/current.json"), JSON.stringify(f.prepared));
  const { result } = await finishResults(f.output, PUBLICATION_CARD);
  assert.equal(result.status, "failed"); assert.equal(result.cleanup[0].deleted, false);
  assert.equal((await fs.stat(f.config.startState)).isDirectory(), true);
});

test("rollback restores facts and files in place, verifies history, and only deletes its own snapshot", async t => {
  const f = await fixture(t), before = await identity(f.state);
  insert(f.state); await fs.writeFile(path.join(f.state, "transient.bin"), "disposable");
  await fs.writeFile(path.join(f.state, "pricing.json"), "changed");
  const receipt = await restoreSnapshot(f.prepared, f.output);
  assert.equal(receipt.restored, true); assert.deepEqual(await identity(f.state), before);
  const db = new DatabaseSync(path.join(f.state, "usage-index.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT SUM(total) n FROM events").get().n, 160); } finally { db.close(); }
  assert.equal(await fs.readFile(path.join(f.state, "pricing.json"), "utf8"), '{"fixed":true}\n');
  await assert.rejects(fs.stat(path.join(f.state, "transient.bin")), { code: "ENOENT" });
  await cleanupSnapshot(f.prepared, f.output);
  await assert.rejects(fs.stat(f.config.startState), { code: "ENOENT" });
  assert.equal(await fs.readFile(f.archive, "utf8"), "immutable history package");
  assert.deepEqual(await identity(f.state), before);
});

test("a corrupted rollback copy is rejected before writing shared state", async t => {
  const f = await fixture(t); insert(f.state);
  await fs.writeFile(path.join(f.config.startState, "pricing.json"), "corrupt snapshot");
  await assert.rejects(restoreSnapshot(f.prepared, f.output), /Rollback snapshot changed/);
  const db = new DatabaseSync(path.join(f.state, "usage-index.sqlite"), { readOnly: true });
  try { assert.equal(db.prepare("SELECT COUNT(*) n FROM events").get().n, 2); } finally { db.close(); }
});

test("cleanup cannot hide changed facts, historical packages, manifests, or an escaped snapshot", async t => {
  const f = await fixture(t); insert(f.state);
  await assert.rejects(cleanupSnapshot(f.prepared, f.output));
  await restoreSnapshot(f.prepared, f.output);
  await fs.writeFile(f.archive, "corrupted historical package");
  await assert.rejects(cleanupSnapshot(f.prepared, f.output), /Historical package changed/);
  await fs.writeFile(f.archive, "immutable history package");
  await fs.writeFile(f.archive.replace(/\.sqlite$/, ".manifest.json"), "changed manifest");
  await assert.rejects(restoreSnapshot(f.prepared, f.output), /Historical packages changed/);
  await assert.rejects(cleanupSnapshot({ ...f.prepared, config: { ...f.config, startState: f.state } }, f.output), /escaped/);
  assert.ok((await fs.stat(f.config.startState)).isDirectory());
});

test("a different primary inode is rejected without deleting shared data", async t => {
  const f = await fixture(t), primary = path.join(f.state, "usage-index.sqlite");
  const replacement = path.join(f.root, "replacement-state");
  await fs.cp(f.state, replacement, { recursive: true });
  await assert.rejects(restoreSnapshot({ ...f.prepared, config: { ...f.config, state: replacement } }, f.output), /Primary identity changed/);
  assert.ok((await fs.stat(primary)).isFile());
});
