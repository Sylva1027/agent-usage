import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { createCostEstimateAccumulator, createEventPricing, runWithPricingCatalog } from "../../src/pricing.js";
import { UsageStore } from "../../src/usage-store.js";
import { ROOT,datasetOptions } from "./c1-datasets.mjs";
import { createRemainingHarnessFixture } from "../../test-support/remaining-harness-fixture.mjs";
import { prepareStabilityMutations,appendStabilityMutation } from "./windows-stability-mutations.mjs";
import { CLOSEOUT_PROFILE } from "./windows-stability-schedule.mjs";
import { browser, stop } from "./c1-run.mjs";
import { painted } from "./b2-page-diagnostic.mjs";
import { readQ5Delivery } from "./q5-summary-hook.mjs";
import {
  attachPage, launchServer, loadPage, matchingControlledExit, pollBrowser, registerControlledExit, stabilityScope, waitUsageResponse,mutationSessions,
} from "./windows-stability-run.mjs";

const KINDS = ["codex", "dsh", "claude", "workbuddy", "zcode", "opencode"];
const FIELDS = ["total", "input", "cached", "output", "reasoning"];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + "\n");
const lines = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const usage = { input_tokens: 140, cached_input_tokens: 30, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 160 };
const closeout=process.env.WINDOWS_CLOSEOUT_PREFLIGHT==="1";
const closeoutRoot=path.resolve(process.env.WINDOWS_CLOSEOUT_ROOT??path.join(ROOT,"output/windows-parallel-20261109"));
assert.ok(["output/windows-parallel-20261109","output/archive-request-lifetime-20261110"].some(relative=>path.join(ROOT,relative)===closeoutRoot));

async function savePreflight(name, receipt) {
  const directory = closeout?path.join(closeoutRoot,"browser-preflight"):path.join(ROOT, name.startsWith("combined-")
    ? "output/windows-multitab-20261109/preflight" : "output/windows-stability-recovery-20261109/preflight");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `browser-${name}.json`);
  let prior;
  try { prior = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  assert.ok(!prior || prior.passed === true, `Refuse to overwrite a failed receipt: ${file}`);
  if(closeout)assert.equal(prior,undefined,"Preserve the first closeout browser receipt");
  await writeFile(file, JSON.stringify(receipt, null, 2) + "\n", { flag: prior ? "w" : "wx" });
  return file;
}

async function until(check, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await pause(25);
  }
  assert.fail(`Timed out: ${label}`);
}

async function hookRows(context) {
  const files = (await readdir(context.control)).filter(name => /^events-\d+\.ndjson$/.test(name));
  return (await Promise.all(files.map(name => readFile(path.join(context.control, name), "utf8"))))
    .flatMap(text => text.split("\n").filter(Boolean).map(line => JSON.parse(line)));
}

// Forward real HTTP responses, and retain both ends of established SSE streams for an actual disconnect.
async function proxyTo(target) {
  const records = [], streams = new Set(), sockets = new Set(), upstreams = new Set();
  let held = null;
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, target).pathname;
    const row = { url: request.url, pathname, startedAtMs: Date.now() };
    records.push(row);
    if (pathname === "/api/usage-events" && held) await held.promise;
    if (response.destroyed) return;
    const upstream = http.request(new URL(request.url, target), {
      method: request.method, headers: request.headers, agent: false,
    }, incoming => {
      Object.assign(row, { status: incoming.statusCode, receivedAtMs: Date.now(), contentType: incoming.headers["content-type"] });
      response.writeHead(incoming.statusCode, incoming.headers);
      response.flushHeaders();
      const stream = { incoming, response, upstream, row };
      if (pathname === "/api/usage-events") streams.add(stream);
      incoming.on("data", bytes => { row.bytes = (row.bytes ?? 0) + bytes.length; });
      incoming.on("error", () => response.destroy());
      incoming.pipe(response);
      response.once("close", () => { streams.delete(stream); incoming.destroy(); });
    });
    row.forwardedAtMs = Date.now();
    upstreams.add(upstream);
    upstream.on("error", error => { row.error = error.code; response.destroy(); });
    upstream.once("close", () => upstreams.delete(upstream));
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const release = () => { held?.resolve(); held = null; };
  return {
    url: `http://127.0.0.1:${server.address().port}`, records, streams,
    disconnect() {
      assert.ok(streams.size > 0, "must destroy an already established SSE stream");
      let resolve;
      held = { promise: new Promise(done => { resolve = done; }), resolve };
      const cut = [...streams].map(({ row }) => ({ ...row, disconnectedAtMs: Date.now() }));
      for (const { incoming, response, upstream } of [...streams]) {
        assert.equal(incoming.statusCode, 200);
        assert.match(incoming.headers["content-type"], /^text\/event-stream/);
        incoming.destroy(); upstream.destroy(); response.destroy();
      }
      return cut;
    },
    release,
    async close() {
      release();
      const closed = new Promise(resolve => server.close(resolve));
      for (const upstream of upstreams) upstream.destroy();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

function facts(context) {
  const database = new DatabaseSync(path.join(context.state, "usage-index.sqlite"), { readOnly: true });
  try {
    assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
    return {
      ...database.prepare("SELECT COUNT(*) events,COUNT(DISTINCT id) distinctEvents,COUNT(DISTINCT session_id) sessions,SUM(total) total FROM events").get(),
      sources: database.prepare("SELECT source_path,COUNT(*) events,SUM(total) total FROM events GROUP BY source_path ORDER BY source_path").all(),
    };
  } finally { database.close(); }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

const childExited = child => child.exitCode != null || child.signalCode != null;

function cleanupSkipReason(birth, rows, server) {
  if (birth.role === "gateway" && birth.pid === server?.child.pid && childExited(server.child)) return "server-already-exited";
  if (rows.some(row => row.event === "process-exit" && row.instance === birth.instance && row.pid === birth.pid && row.atMs >= birth.atMs)) return "process-exit-observed";
  const nextBirth = Math.min(...rows.filter(row => row.event === "process-born" && row.pid === birth.pid && row.atMs > birth.atMs).map(row => row.atMs));
  if (rows.some(row => row.event === "executor-exit" && row.pid === birth.ppid && row.childPid === birth.pid && row.atMs >= birth.atMs && row.atMs < nextBirth)) return "executor-exit-observed";
  return null;
}

async function cleanupBirth(birth, rows, server, notBeforeMs) {
  const record = { pid: birth.pid, instance: birth.instance, birthAtMs: birth.atMs, notBeforeMs };
  const reason = cleanupSkipReason(birth, rows, server);
  if (reason) return { ...record, action: "skipped", reason };
  if (!Number.isSafeInteger(birth.pid) || birth.pid <= 0 || !birth.instance || !Number.isSafeInteger(birth.atMs) ||
      !Number.isSafeInteger(notBeforeMs) || notBeforeMs > birth.atMs) {
    return { ...record, action: "unknown", reason: "missing-or-invalid-birth-identity" };
  }
  // SafeHandle pins this generation through the native time check and Kill, avoiding a PID lookup after checking.
  const script = `
$record = [Console]::In.ReadToEnd() | ConvertFrom-Json
$result = @{ pid = $record.pid; instance = $record.instance; birthAtMs = $record.birthAtMs; notBeforeMs = $record.notBeforeMs }
$target = $null
try {
  $target = [System.Diagnostics.Process]::GetProcessById([int]$record.pid)
  $handle = $target.SafeHandle
  $created = $target.StartTime.ToUniversalTime()
  $result.createdAtUtc = $created.ToString('O')
  $result.creationTicks = $created.Ticks.ToString()
  $lower = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$record.notBeforeMs).UtcTicks
  $upper = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$record.birthAtMs).UtcTicks
  if ($created.Ticks -gt $upper) {
    $result.action = 'skipped'; $result.reason = 'newer-generation'
  } elseif ($created.Ticks -lt $lower) {
    $result.action = 'skipped'; $result.reason = 'outside-birth-window'
  } else {
    $target.Kill($true)
    if (-not $target.WaitForExit(5000)) { throw 'Matching process did not exit' }
    $result.action = 'killed'; $result.reason = 'native-birth-matched'
  }
} catch [ArgumentException] {
  $result.action = 'skipped'; $result.reason = 'already-absent'
} catch {
  $result.action = 'unknown'; $result.reason = $_.Exception.Message
} finally {
  if ($null -ne $target) { $target.Dispose() }
}
$result | ConvertTo-Json -Compress
`;
  const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", bytes => { stdout += bytes; }); child.stderr.on("data", bytes => { stderr += bytes; });
  const ended = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  child.stdin.end(JSON.stringify(record));
  assert.equal(await ended, 0, stderr);
  return JSON.parse(stdout);
}

function assertFixtureDirectory(directory) {
  assert.ok(path.isAbsolute(directory), "fixture directory must be absolute");
  const absolute = path.resolve(directory);
  assert.ok([path.resolve(ROOT,"output"),closeoutRoot].includes(path.dirname(absolute)), "fixture parent must be ROOT/output or private closeout root");
  assert.match(path.basename(absolute), /^windows-stability-browser-/, "fixture basename must have the browser prefix");
}

async function fixture(t,{six=false}={}) {
  const startedAtMs = Date.now();
  if(closeout)await mkdir(closeoutRoot,{recursive:true});
  const directory = await mkdtemp(path.join(closeout?closeoutRoot:path.join(ROOT,"output"), "windows-stability-browser-"));
  const home = path.join(directory, "home"), state = path.join(directory, "state"), control = path.join(directory, "control");
  const timestampMs = Date.now() - 10_000;
  const files = {
    codex: path.join(home, ".codex/sessions/browser/session.jsonl"),
    dsh: path.join(home, ".dsh/sessions/browser/browser-dsh/session.v4.jsonl.zstd"),
  };
  const context = {
    directory, state, control, runtime: process.env.WINDOWS_CLOSEOUT_RUNTIME??ROOT, timestampMs, files, trace: path.join(directory, "nodes"), startedAtMs,
    ...(closeout?{profile:CLOSEOUT_PROFILE}:{}),
    dataset: { home, expectedSessions: 2, expected: KINDS.map(kind => {
      const n = ["codex", "dsh"].includes(kind) ? 1 : 0;
      return { kind, events: n, sessions: n, total: n * 160, input: n * 140, cached: n * 30, output: n * 20, reasoning: kind === "codex" ? 5 : 0 };
    }) },
    ledger: { entries: [] }, selectedSessions: new Map([["codex", "browser-codex"], ["dsh", "browser-dsh"]]),
    seed: new DatabaseSync(":memory:"), rangeCache: new Map(), bodies: [], inputs: [], pages: [], pageSets: new Map(),
    responseTasks: new Set(), failures: [], responseSequence: 0, navigationSequence: 0, tasks: [], httpErrors: [], passed: false,
  };
  t.after(async () => {
    context.closing = true;
    const errors = [];
    if (!context.passed && context.ui) {
      for (const [index, page] of context.pages.entries()) {
        await save(path.join(directory, `page-${index}.json`), await readQ5Delivery(page)).catch(error => errors.push(String(error)));
        await page.screenshot({ path: path.join(directory, `page-${index}.png`), timeout: 5000 }).catch(error => errors.push(String(error)));
      }
    }
    await context.ui?.instance.close().catch(error => errors.push(String(error)));
    await Promise.allSettled(context.tasks);
    await Promise.allSettled([...context.responseTasks]);
    if (context.server && !childExited(context.server.child)) {
      await stop(context.server).catch(error => errors.push(String(error)));
    }
    const rows = await hookRows(context), births = rows.filter(row => row.event === "process-born");
    const owned = [...new Set(births.map(row => row.pid))], cleanupProcesses = [];
    for (const birth of births) {
      let result;
      try { result = await cleanupBirth(birth, rows, context.server, context.server?.startedAtMs ?? startedAtMs); }
      catch (error) { result = { pid: birth.pid, instance: birth.instance, action: "unknown", reason: String(error) }; }
      cleanupProcesses.push(result);
      if (result.action === "unknown") errors.push(`Unknown cleanup identity; not killed: ${JSON.stringify(result)}`);
    }
    await context.proxy?.close().catch(error => errors.push(String(error)));
    context.seed.close();
    await save(path.join(directory, "receipt.json"), {
      passed: context.passed, failures: context.failures, controlledExits: context.controlledExits,
      proxy: context.proxy?.records, pages: [...context.pageSets.values()], owned, cleanupProcesses, cleanupErrors: errors,
    });
    if (context.passed && !errors.length) {
      try {
        const file = await savePreflight(context.receiptName, {
          passed: true, scenario: context.receiptName, startedAtMs, completedAtMs: Date.now(),
          observationVersion:2,...(closeout?{profile:CLOSEOUT_PROFILE}:{}),
          ...context.receipt, cleanup: { passed: true, ownedPids: owned, processes: cleanupProcesses, livePids: [], proxyClosed: true },
        });
        t.diagnostic(`Browser receipt: ${file}`);
      } catch (error) { errors.push(String(error)); }
    }
    if (context.passed && !errors.length&&!closeout) {
      assertFixtureDirectory(directory);
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    else t.diagnostic(`${context.passed&&!errors.length?"Preserved browser evidence":"Small failure evidence"}: ${directory}`);
    assert.deepEqual(errors, [], "isolated service cleanup");
  });
  await Promise.all([state, control, context.trace, ...Object.values(files).map(file => path.dirname(file))].map(dir => mkdir(dir, { recursive: true })));
  context.seed.exec("CREATE TABLE events(timestamp_ms,session_id,source_path,total,input,cached,output,reasoning)");
  for (const [kind, session] of context.selectedSessions) {
    context.seed.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)").run(timestampMs, session, files[kind], 160, 140, 30, 20, kind === "codex" ? 5 : 0);
  }
  await writeFile(files.codex, lines([
    { type: "session_meta", timestamp: new Date(timestampMs).toISOString(), payload: { id: "browser-codex", cwd: directory, source: "cli" } },
    { type: "turn_context", timestamp: new Date(timestampMs).toISOString(), payload: { model: "gpt-6-sol" } },
    { type: "event_msg", timestamp: new Date(timestampMs).toISOString(), payload: { type: "token_count", info: { total_token_usage: usage } } },
  ]));
  await writeFile(files.dsh, zstdCompressSync(Buffer.from(lines([
    { type: "session", version: 4, id: "browser-dsh", cwd: directory, delegationDepth: 0, createdAt: timestampMs },
    { type: "request/header", time: timestampMs, data: { header: { config: { model: "deepseek-chat", provider: "deepseek" } } } },
    dshRow(timestampMs, 1),
  ]))));
  if(six){
    for(const [kind,relative] of [["claude",".claude/projects/browser/session.jsonl"],["workbuddy",".workbuddy-ai/projects/browser/session.jsonl"],["zcode",".zcode/cli/db/db.sqlite"],["opencode",".opencode/opencode.db"]]){
      const source=createRemainingHarnessFixture(path.join(directory,"raw-fixtures",kind),kind,1),file=path.join(home,relative);
      await mkdir(path.dirname(file),{recursive:true});await copyFile(source.filePath,file);files[kind]=file;
      if(kind==="workbuddy")await writeFile(file,lines([{type:"session-meta",sessionId:"long-session"}])+await readFile(file,"utf8"));
    }
    const store=new UsageStore(datasetOptions(home,state));
    try{
      await store.open();await store.sync();
      context.seed.exec("DELETE FROM events");
      for(const row of store.database.prepare("SELECT timestamp_ms,session_id,source_path,total,input,cached,output,reasoning FROM events").iterate())context.seed.prepare("INSERT INTO events VALUES(?,?,?,?,?,?,?,?)").run(...Object.values(row));
      context.dataset.expected=store.database.prepare("SELECT s.kind,COUNT(*) events,SUM(e.total) total,SUM(e.input) input,SUM(e.cached) cached,SUM(e.output) output,SUM(e.reasoning) reasoning FROM events e JOIN source_files s ON s.path=e.source_path GROUP BY s.kind").all().map(row=>({...row,kind:row.kind==="main"?"codex":row.kind}));
      context.dataset.expectedSessions=store.database.prepare("SELECT COUNT(DISTINCT session_id) n FROM events").get().n;
    }finally{store.close();}
    context.ledger=await prepareStabilityMutations(context.dataset,path.join(directory,"mutations"),{databaseFile:path.join(state,"usage-index.sqlite"),runtimeDirectory:context.runtime});
    context.selectedSessions=mutationSessions(context.ledger,context.seed);
  }
  context.server = await launchServer(context);
  context.gatewayPid = context.server.ready.pid;
  context.proxy = await proxyTo(context.server.ready.url);
  context.server.ready.url = context.proxy.url;
  context.ui = await browser();
  await addPage(context, context.ui.page);
  await loadPage(context, context.ui.page);
  await context.ui.page.waitForFunction(() => window.__q5Delivery.rows.some(row => row.kind === "page-receipt" && row.event === "open"));
  await Promise.all(context.responseTasks);
  assert.deepEqual(context.failures, []);
  assert.equal(context.lastBody.total,context.dataset.expected.reduce((n,row)=>n+row.total,0));
  return context;
}

function dshRow(timestampMs, seq) {
  return { type: "assistant/message", time: timestampMs, seq, surfaceOp: "append", data: { turn: seq, step: 1,
    message: { content: [] }, usage: { inputTokens: 100, cacheReadTokens: 30, cacheWriteTokens: 10, outputTokens: 20, totalTokens: 160 } } };
}

async function addPage(context, page) {
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(15_000);
  // Chromium otherwise coalesces the two tabs' identical in-flight GETs behind one cache lock.
  const cdp = await context.ui.context.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  context.pages.push(page);
  await attachPage(context, page);
  const rows = [];
  context.pageSets.set(page, rows);
  page.on("response", response => {
    if (new URL(response.url()).pathname !== "/api/usage") return;
    const task = (async () => {
      const body = await response.json();
      if (response.status() === 500) context.httpErrors.push({ response, body });
      rows.push({ status: response.status(), body, startedAtMs: context.requestStarts.get(response.request()), receivedAtMs: Date.now() });
    })();
    context.tasks.push(task); void task.catch(() => {});
  });
}

async function append(context, kind) {
  const timestampMs = Date.now();
  context.ledger.entries.push({ kind, operation: "append", timestampMs, expectedDelta: 160,
    deltaTokens: { input: 140, cached: 30, output: 20, reasoning: kind === "codex" ? 5 : 0 } });
  if (kind === "codex") await appendFile(context.files.codex, lines([
    { type: "event_msg", timestamp: new Date(timestampMs).toISOString(), payload: { type: "token_count", info: {
      total_token_usage: Object.fromEntries(Object.entries(usage).map(([key, value]) => [key, value * 2])), last_token_usage: usage,
    } } },
  ]));
  else await appendFile(context.files.dsh, zstdCompressSync(Buffer.from(lines([dshRow(timestampMs, 2)]))));
  return timestampMs;
}

async function verify(context, kind, changedAtMs) {
  const pages = [];
  for (const page of context.pages) {
    await painted(page, 480, 15_000);
    const delivery = await readQ5Delivery(page);
    assert.equal(delivery.dropped, 0);
    assert.ok(delivery.rows.some(row => row.kind === "paint" && row.clock >= changedAtMs && Number(row.total.replace(/[^0-9]/g, "")) === 480));
    assert.ok(!delivery.rows.some(row => row.kind === "page-error"));
    const row = context.pageSets.get(page).findLast(row => row.status === 200 && row.body.summary.totals.total === 480);
    assert.ok(row, "new value must come from a real 200 response");
    const expected = { total: 480, input: 420, cached: 90, output: 60, reasoning: kind === "codex" ? 10 : 5 };
    for (const field of FIELDS) assert.equal(row.body.summary.totals[field], expected[field], field);
    assert.equal(row.body.summary.eventCount, 3);
    assert.equal(row.body.summary.sessionCount, 2);
    assert.equal(row.body.metadata.eventCount, 3);
    assert.equal(row.body.periodComparison.totals.all.total, 480);
    const paint = delivery.rows.find(row => row.kind === "paint" && row.clock >= changedAtMs && Number(row.total.replace(/[^0-9]/g, "")) === 480);
    pages.push({ page: context.pages.indexOf(page), responseAtMs: row.receivedAtMs, paintedAtMs: paint.clock,
      total: row.body.summary.totals.total, events: row.body.summary.eventCount, sessions: row.body.summary.sessionCount,
      totals: row.body.summary.totals, usageVersion: row.body.usageVersion, fingerprint: row.body.fingerprint });
  }
  await Promise.all(context.responseTasks);
  assert.deepEqual(context.failures, []);
  const stored = facts(context);
  assert.equal(stored.events, 3); assert.equal(stored.distinctEvents, 3); assert.equal(stored.sessions, 2); assert.equal(stored.total, 480);
  assert.equal(stored.sources.find(row => row.source_path === context.files[kind]).events, 2);
  const rows = await hookRows(context);
  assert.deepEqual(rows.filter(row => row.event === "process-born" && row.role === "gateway").map(row => row.pid), [context.gatewayPid]);
  assert.ok(alive(context.gatewayPid), "same gateway survived");
  return { newValue: 480, changedAtMs, pages, duplicateCheck: { passed: true, expectedEvents: 3, ...stored },
    gateway: { pid: context.gatewayPid, processBornPids: [context.gatewayPid], unchanged: true, port: context.server.ready.port } };
}

for (const [name, point] of [["normal", null], ["before", "before-commit"], ["after", "after-commit-before-notify"]]) {
  test(`combined real three-tab scope switch and source append: ${name}`, { timeout: 90_000 }, async t => {
    const context = await fixture(t), main = context.ui.page;
    context.receiptName = `combined-${name}`;
    for (let index = 0; index < 2; index++) {
      const page = await context.ui.context.newPage();
      await addPage(context, page);
      await loadPage(context, page);
      await page.waitForFunction(() => window.__q5Delivery.rows.some(row => row.kind === "page-receipt" && row.event === "open"));
    }
    const today = await stabilityScope(context, main, "today", 320, context.directory, "combined-today");
    await pollBrowser(context); // Drain establishment paints before tracking the real append.
    const beforeVersion = context.lastBody.usageVersion;
    const automatic = context.pages.slice(1).map(page => waitUsageResponse(context, page, "all", 480, 75_000));
    for (const pending of automatic) { context.tasks.push(pending); void pending.catch(() => {}); }
    let command, parked, killedAtMs, killFrame, week, scopeChange, scopeAppendOverlap, actual500 = [];
    if (point) {
      command = { id: `browser-combined-${name}`, point, sourcePath: context.files.codex };
      await save(path.join(context.control, "pause-sync.tmp"), command);
      await rename(path.join(context.control, "pause-sync.tmp"), path.join(context.control, "pause-sync.json"));
    } else {
      const requested = main.waitForRequest(request => {
        const url = new URL(request.url());
        return url.pathname === "/api/usage" && url.searchParams.get("preset") === "week";
      });
      context.tasks.push(requested); void requested.catch(() => {});
      scopeChange = stabilityScope(context, main, "week", undefined, context.directory, "combined-week");
      context.tasks.push(scopeChange); void scopeChange.catch(() => {});
      await requested;
      await until(() => context.proxy.records.find(row => row.pathname === "/api/usage" &&
        new URL(row.url, context.proxy.url).searchParams.get("preset") === "week" && row.forwardedAtMs && !row.status),
      "normal week request is in flight before append");
    }
    const changedAtMs = await append(context, "codex");
    const appendCompletedAtMs = Date.now();
    const input = { ...context.ledger.entries.at(-1), kindCount: 1, landedAtMs: changedAtMs };
    context.inputs.push(input);
    if (!point) {
      week = await scopeChange;
      const request = context.proxy.records.find(row => row.pathname === "/api/usage" &&
        new URL(row.url, context.proxy.url).searchParams.get("preset") === "week");
      assert.ok(request.forwardedAtMs <= changedAtMs && request.receivedAtMs >= appendCompletedAtMs,
        "real upstream week request must overlap the source append");
      scopeAppendOverlap = { passed: true, appendStartedAtMs: changedAtMs, appendCompletedAtMs, request };
    }
    if (point) {
      parked = await until(async () => (await hookRows(context)).find(row => row.event === "fault-parked" && row.commandId === command.id), "combined hook fault-parked");
      assert.equal(parked.role, "executor"); assert.equal(parked.ppid, context.gatewayPid);
      assert.equal(parked.point, point); assert.equal(parked.transaction, point === "before-commit");
      assert.equal(facts(context).total, point === "before-commit" ? 320 : 480);
      scopeChange = stabilityScope(context, main, "week", 480, context.directory, "combined-week");
      context.tasks.push(scopeChange); void scopeChange.catch(() => {});
      await until(() => context.proxy.records.find(row => row.pathname === "/api/usage" &&
        new URL(row.url, context.proxy.url).searchParams.get("preset") === "week" &&
        row.startedAtMs >= parked.atMs && row.forwardedAtMs && !row.status), "combined main week request is in flight");
      killFrame = { atMs: Date.now(), facts: facts(context), tabs: await Promise.all(context.pages.map(async (page, index) => ({
        page: index, ...await page.evaluate(() => ({ preset: document.querySelector("[data-preset].active")?.dataset.preset,
          total: document.querySelector("#totalTokens")?.title })),
      }))) };
      assert.deepEqual(killFrame.tabs.map(row => row.preset), ["week", "all", "all"]);
      assert.equal(killFrame.facts.total, point === "before-commit" ? 320 : 480);
      process.kill(parked.pid, "SIGKILL");
      killedAtMs = Date.now();
      registerControlledExit(context, { pid: parked.pid, point, commandId: command.id, killedAtMs, gatewayPid: context.gatewayPid });
      const failed = await until(() => context.pageSets.get(main).find(row => row.status === 500), "combined upstream controlled 500");
      assert.equal(failed.body.code, "EXECUTOR_EXITED"); assert.ok(failed.startedAtMs <= killedAtMs);
      const actual = context.httpErrors.find(row => row.body.code === "EXECUTOR_EXITED");
      assert.equal(matchingControlledExit(context, actual.response, actual.body).commandId, command.id);
      actual500 = [{ status: failed.status, code: failed.body.code, startedAtMs: failed.startedAtMs, receivedAtMs: failed.receivedAtMs }];
      week = await scopeChange;
      const mainRows = context.pageSets.get(main), failureIndex = mainRows.indexOf(failed);
      assert.ok(mainRows.slice(failureIndex + 1).some(row => row.status === 200 &&
        row.body.summary.range.preset === "week" && row.body.summary.totals.total === 480), "week recovered automatically after its 500");
    }
    await Promise.all(automatic);
    const validation = await verify(context, "codex", changedAtMs);
    const costs = [];
    for (const [index, page] of context.pages.entries()) {
      const preset = index === 0 ? "week" : "all";
      assert.equal(await page.locator("[data-preset].active").getAttribute("data-preset"), preset);
      const row = context.pageSets.get(page).findLast(row => row.status === 200 && row.body.summary.totals.total === 480);
      assert.equal(row.body.summary.range.preset, preset);
      assert.notEqual(row.body.usageVersion, beforeVersion);
      for (const field of FIELDS) assert.equal(row.body.periodComparison.totals.all[field], row.body.summary.totals[field], `all ${field}`);
      const databaseFile = path.join(context.state, "usage-index.sqlite"), database = new DatabaseSync(databaseFile, { readOnly: true });
      const reader = new UsageStore({ databaseFile });
      reader.database = database; reader.homes = row.body.metadata.homes;
      let expectedCost, costEvents = 0;
      try {
        expectedCost = runWithPricingCatalog(row.body.pricingCatalog, () => {
          const pricing = createEventPricing(row.body.pricingCatalog.models);
          const accumulator = createCostEstimateAccumulator({ modelName: pricing.costModelName });
          const range = row.body.summary.range;
          for (const event of reader.costEventsForRange({ ...range, start: new Date(range.start), end: new Date(range.end) })) {
            accumulator.add(event, pricing.estimate(event)); costEvents++;
          }
          return accumulator.result();
        });
      } finally { database.close(); }
      assert.equal(costEvents, 3, "cost stream covers every real fixture event");
      assert.deepEqual(row.body.summary.costEstimate, expectedCost, "every cost field matches the read-only SQL fact stream");
      const cost = row.body.summary.costEstimate;
      await page.waitForFunction(async expected => {
        const { formatCostAmount } = await import("/app.js");
        return document.querySelector("#totalCost")?.textContent === formatCostAmount(
          (expected.usd ?? 0) + (expected.cny ?? 0) / expected.rate, "USD");
      }, { usd: cost.totalUsd, cny: cost.totalCny, rate: row.body.pricingCatalog.usdToCnyRate });
      costs.push({ page: index, preset, costEstimate: cost, expectedCost, costEvents, allCostFieldsPassed: true });
    }
    assert.ok(!context.bodies.some(row => row.page === 0 && row.preset === "all" && row.total === 480), "main never supplied the new all value");
    await until(async () => { await pollBrowser(context); return input.paintedAtMs; }, "shared pollBrowser records the other tab's all paint");
    assert.ok(input.viewVisibleAtMs&&input.viewUsageVersion&&input.viewLandingToPaintMs>=0,"v2 selected range has its own versioned clock");
    const mainPresetAtConfirmation = await main.locator("[data-preset].active").getAttribute("data-preset");
    assert.equal(mainPresetAtConfirmation, "week", "main is outside all when pollBrowser confirms the input");
    assert.ok([1, 2].includes(input.paintedPage), "another tab must certify the input");
    const body = context.bodies.find(row => row.sequence === input.responseSequence);
    assert.equal(body.page, input.paintedPage); assert.equal(body.preset, "all"); assert.equal(body.total, 480);
    assert.equal(body.counts.codex, 1); assert.equal(body.usageVersion, input.usageVersion);
    const rows = await hookRows(context), log = (await readFile(path.join(context.directory, "events.ndjson"), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    assert.equal(log.filter(row => row.type === "input-visible").length, 1);
    assert.equal(log.find(row => row.type === "input-visible").paintedPage, input.paintedPage);
    const upstream500 = context.proxy.records.filter(row => row.pathname === "/api/usage" && row.status === 500);
    let executorExit, workerRebuilt, sharedWaiter;
    if (point) {
      executorExit = rows.find(row => row.event === "executor-exit" && row.childPid === parked.pid && row.atMs >= killedAtMs);
      workerRebuilt = rows.find(row => row.event === "executor-spawn" && row.pid === context.gatewayPid && row.childPid !== parked.pid && row.atMs >= killedAtMs);
      sharedWaiter = log.find(row => row.type === "waiting-for-fault-recovery" && row.commandId === command.id && row.preset === "week");
      assert.ok(executorExit); assert.ok(workerRebuilt); assert.ok(sharedWaiter); assert.ok(upstream500.length);
      assert.ok(rows.some(row => row.event === "process-born" && row.role === "executor" && row.pid === workerRebuilt.childPid && row.ppid === context.gatewayPid));
      assert.ok(input.paintedAtMs >= killedAtMs && input.paintedAtMs - killedAtMs <= 75_000);
    } else assert.equal(upstream500.length, 0);
    assert.deepEqual(context.failures, []);
    context.receipt = {
      appendCount:1,observationVersion:2,
      ...validation, scopes: { main: [today.result, week.result], otherTabs: ["all", "all"] }, scopeAppendOverlap, costs,
      sharedPollBrowser: { passed: true, mainPage: 0, mainPresetAtConfirmation, confirmedAtMs: Date.now(), mainHasNewAllResponse: false, input,
        sameTabResponse: { page: body.page, sequence: body.sequence, preset: body.preset, usageVersion: body.usageVersion } },
      command, kill: point ? { signal: "SIGKILL", ...context.controlledExits[0], hookReceipt: parked, frame: killFrame } : undefined,
      executorExit, workerRebuilt, actual500, upstream500,
      automaticRecovery: { passed: true, sharedWaiter, noNavigationAfterKill: true,
        allPagesPaintedAtMs: Math.max(...validation.pages.map(row => row.paintedAtMs)),
        elapsedMs: Math.max(...validation.pages.map(row => row.paintedAtMs)) - (killedAtMs ?? changedAtMs) },
    };
    context.passed = true;
  });
}

test("closeout closed tabs then scope switch WorkBuddy append and six-source burst",{timeout:90_000},async t=>{
  const context=await fixture(t,{six:true}),main=context.ui.page;
  context.receiptName="combined-closed-tabs";
  for(let i=0;i<2;i++){const page=await context.ui.context.newPage();await addPage(context,page);await loadPage(context,page);}
  for(const page of context.pages.slice(1))await page.close();context.pages=context.pages.slice(0,1);
  await stabilityScope(context,main,"week",undefined,context.directory,"closed-tabs-week");
  await pollBrowser(context);
  const add=async(kind,ordinal)=>{
    const row=await appendStabilityMutation(context.ledger,kind,{ordinal,timestampMs:Date.now(),category:ordinal===1?"ordinary":"burst"});
    const input={...row,eventId:`closed-tabs-${ordinal}`,kindCount:context.ledger.byKind[kind].appendCount};context.inputs.push(input);return input;
  };
  const workbuddy=await add("workbuddy",1);
  await until(async()=>{await pollBrowser(context);return workbuddy.viewVisibleAtMs;},"automatic WorkBuddy selected week visibility",30_000);
  assert.equal(workbuddy.viewPreset,"week");assert.equal(workbuddy.viewPage,0);assert.equal(workbuddy.paintedAtMs,undefined);
  await stabilityScope(context,main,"all",undefined,context.directory,"closed-tabs-all");
  await until(async()=>{await pollBrowser(context);return workbuddy.paintedAtMs;},"independent WorkBuddy all confirmation");
  const burstStartedAtMs=Date.now();
  await Promise.all(KINDS.map((kind,i)=>add(kind,i+2)));
  await until(async()=>{await pollBrowser(context);return context.inputs.every(input=>input.viewVisibleAtMs&&input.paintedAtMs);},"six-source automatic burst publication",30_000);
  await Promise.all(context.responseTasks);assert.deepEqual(context.failures,[]);
  const body=context.lastBody.body,db=new DatabaseSync(path.join(context.state,"usage-index.sqlite"),{readOnly:true});
  const reader=new UsageStore({databaseFile:path.join(context.state,"usage-index.sqlite")});reader.database=db;reader.homes=body.metadata.homes;
  let expectedCost;
  try{
    assert.equal(db.prepare("SELECT COUNT(*) n FROM events").get().n,13);
    expectedCost=runWithPricingCatalog(body.pricingCatalog,()=>{
      const pricing=createEventPricing(body.pricingCatalog.models),accumulator=createCostEstimateAccumulator({modelName:pricing.costModelName}),range=body.summary.range;
      for(const event of reader.costEventsForRange({...range,start:new Date(range.start),end:new Date(range.end)}))accumulator.add(event,pricing.estimate(event));return accumulator.result();
    });
  }finally{db.close();}
  assert.deepEqual(body.summary.costEstimate,expectedCost);
  assert.equal(context.inputs.length,7);
  for(const input of context.inputs){assert.ok(input.viewUsageVersion&&input.usageVersion);assert.ok(input.paintedAtMs>=input.viewVisibleAtMs);}
  context.receipt={appendCount:7,observationVersion:2,inputs:context.inputs,closedExtraTabs:2,scope:"week",burstStartedAtMs,expectedCost,exactCostPassed:true};context.passed=true;
});

for (const point of ["before-commit", "after-commit-before-notify"]) {
  test(`real three-tab establishment recovers automatically after ${point} executor kill`, { timeout: 90_000 }, async t => {
    const context = await fixture(t), commandId = `browser-${point}`;
    const command = { id: commandId, point, sourcePath: context.files.codex };
    await save(path.join(context.control, "pause-sync.tmp"), command);
    await rename(path.join(context.control, "pause-sync.tmp"), path.join(context.control, "pause-sync.json"));
    const changedAtMs = await append(context, "codex");
    const parked = await until(async () => (await hookRows(context)).find(row => row.event === "fault-parked" && row.commandId === commandId), "hook fault-parked receipt");
    assert.equal(parked.role, "executor"); assert.equal(parked.ppid, context.gatewayPid); assert.equal(parked.point, point);
    assert.equal(parked.transaction, point === "before-commit");
    assert.equal(facts(context).total, point === "before-commit" ? 320 : 480);
    const automatic = waitUsageResponse(context, context.ui.page, "all", 480, 75_000);
    void automatic.catch(() => {}); context.tasks.push(automatic);
    const newPages = await Promise.all([context.ui.context.newPage(), context.ui.context.newPage()]);
    const loads = [];
    for (const page of newPages) {
      await addPage(context, page);
      const loading = loadPage(context, page); void loading.catch(() => {});
      loads.push(loading); context.tasks.push(loading);
    }
    await until(() => context.proxy.records.filter(row => row.pathname === "/api/usage" && row.startedAtMs >= parked.atMs && row.forwardedAtMs && !row.status).length >= 2, "two new tabs have real in-flight usage requests");
    process.kill(parked.pid, "SIGKILL");
    const killedAtMs = Date.now();
    registerControlledExit(context, { pid: parked.pid, point, commandId, killedAtMs, gatewayPid: context.gatewayPid });
    const errors = await Promise.all(newPages.map(page => until(() => context.pageSets.get(page).find(row => row.status === 500), "actual executor-exited 500")));
    for (const row of errors) { assert.equal(row.body.code, "EXECUTOR_EXITED"); assert.ok(row.startedAtMs <= killedAtMs); }
    const actual = context.httpErrors[0];
    assert.equal(matchingControlledExit(context, actual.response, actual.body).commandId, commandId);
    assert.equal(matchingControlledExit({ ...context, controlledExits: [] }, actual.response, actual.body), null);
    assert.equal(matchingControlledExit(context, actual.response, { ...actual.body, code: "EXECUTOR_UNAVAILABLE" }), null);
    assert.equal(matchingControlledExit({ ...context, requestStarts: new WeakMap([[actual.response.request(), killedAtMs + 1]]) }, actual.response, actual.body), null);
    assert.equal(matchingControlledExit({ ...context, controlledExits: [{ ...context.controlledExits[0], killedAtMs: Date.now() - 300_001 }] }, actual.response, actual.body), null);
    assert.ok(context.proxy.records.filter(row => row.pathname === "/api/usage" && row.status === 500).length >= 2, "500s originated upstream");
    await Promise.all([automatic, ...loads]);
    for (const page of newPages) {
      const rows = context.pageSets.get(page), failed = rows.findIndex(row => row.status === 500);
      assert.ok(rows.slice(failed + 1).some(row => row.status === 200 && row.body.summary.range.preset === "today" && row.body.summary.totals.total === 480), "initial today request recovered before loadPage changes scope");
    }
    const validation = await verify(context, "codex", changedAtMs);
    const rows = await hookRows(context);
    assert.ok(rows.some(row => row.event === "executor-exit" && row.childPid === parked.pid && row.atMs >= killedAtMs));
    assert.ok(rows.some(row => row.event === "executor-spawn" && row.pid === context.gatewayPid && row.childPid !== parked.pid && row.atMs >= killedAtMs), "worker rebuilt after kill");
    assert.ok(rows.some(row => row.event === "process-born" && row.role === "executor" && row.pid !== parked.pid && row.ppid === context.gatewayPid && row.atMs >= killedAtMs));
    const log = await readFile(path.join(context.directory, "events.ndjson"), "utf8");
    assert.ok(log.includes('"type":"waiting-for-fault-recovery"'), "shared driver waited across the controlled 500");
    const allPagesPaintedAtMs = Math.max(...validation.pages.map(row => row.paintedAtMs));
    assert.ok(allPagesPaintedAtMs - killedAtMs <= 300_000);
    context.receiptName = point === "before-commit" ? "before" : "after";
    context.receipt = {
      ...validation, command, kill: { signal: "SIGKILL", ...context.controlledExits[0], hookReceipt: parked },
      executorExit: rows.find(row => row.event === "executor-exit" && row.childPid === parked.pid && row.atMs >= killedAtMs),
      workerRebuilt: rows.find(row => row.event === "executor-spawn" && row.pid === context.gatewayPid && row.childPid !== parked.pid && row.atMs >= killedAtMs),
      actual500: errors.map(row => ({ status: row.status, code: row.body.code, startedAtMs: row.startedAtMs, receivedAtMs: row.receivedAtMs })),
      upstream500: context.proxy.records.filter(row => row.pathname === "/api/usage" && row.status === 500),
      automaticRecovery: { passed: true, allPagesPaintedAtMs, elapsedMs: allPagesPaintedAtMs - killedAtMs,
        newTabsRecoveredBeforeScopeChange: true, sharedWaiterObserved500: true,
        newTabs: newPages.map(page => {
          const row = context.pageSets.get(page).find(row => row.status === 200 && row.body.summary.range.preset === "today");
          return { page: context.pages.indexOf(page), recoveredAtMs: row.receivedAtMs, elapsedMs: row.receivedAtMs - killedAtMs };
        }) },
    };
    context.passed = true;
  });
}

test("an established real SSE disconnect emits error/open and automatically discovers a new DSH value", { timeout: 45_000 }, async t => {
  const context = await fixture(t), page = context.ui.page;
  const before = await readQ5Delivery(page), beforeVersion = context.lastBody.usageVersion;
  const pending = waitUsageResponse(context, page, "all", 480, 20_000);
  context.tasks.push(pending); void pending.catch(() => {});
  const cut = context.proxy.disconnect();
  assert.ok(cut.every(row => row.bytes > 0), "real SSE bytes preceded disconnect");
  await page.waitForFunction(start => window.__q5Delivery.rows.slice(start).some(row => row.kind === "page-receipt" && row.event === "error"), before.rows.length);
  const changedAtMs = await append(context, "dsh");
  assert.equal(facts(context).total, 320, "new input has not been synced while disconnected");
  const reopenedAtMs = Date.now();
  context.proxy.release();
  await pending;
  const validation = await verify(context, "dsh", changedAtMs);
  const delivery = (await readQ5Delivery(page)).rows.slice(before.rows.length);
  const error = delivery.findIndex(row => row.kind === "page-receipt" && row.event === "error");
  const open = delivery.findIndex((row, index) => index > error && row.kind === "page-receipt" && row.event === "open");
  assert.ok(error >= 0 && open > error, "actual EventSource error then automatic open");
  const reconnectCheck = delivery.findIndex((row, index) => index > open && row.kind === "fetch-start" && row.url.startsWith("/api/status"));
  assert.ok(reconnectCheck > open, "app checks sources after reopening SSE");
  assert.ok(context.proxy.records.some(row => row.pathname === "/api/usage-events" && row.startedAtMs >= cut[0].disconnectedAtMs && row.status === 200));
  assert.ok(Date.now() - reopenedAtMs < 20_000, "reconnect recovers before the 60s periodic timer");
  assert.notEqual(context.lastBody.usageVersion, beforeVersion);
  assert.ok(context.proxy.records.filter(row => row.pathname === "/api/usage").every(row => row.status === 200));
  await save(path.join(context.directory, "sse-cut.json"), { cut, reopenedAtMs, delivery });
  context.receiptName = "sse";
  context.receipt = {
    ...validation, sse: { route: "/api/usage-events", cut, error: delivery[error], open: delivery[open],
      reconnectCheck: delivery[reconnectCheck], reconnected: context.proxy.records.filter(row => row.pathname === "/api/usage-events").at(-1) },
    automaticRecovery: { passed: true, reopenedAtMs, allPagesPaintedAtMs: validation.pages[0].paintedAtMs,
      elapsedMs: validation.pages[0].paintedAtMs - cut[0].disconnectedAtMs,
      fromReopenMs: validation.pages[0].paintedAtMs - reopenedAtMs, beforePeriodic60s: true },
  };
  context.passed = true;
});

test("cleanup skips observed exits and records unknown identity without killing", async () => {
  const birth = { event: "process-born", role: "executor", pid: 10, ppid: 9, instance: "old-worker", atMs: 2000 };
  const exit = { event: "executor-exit", pid: 9, childPid: 10, atMs: 3000 };
  assert.equal((await cleanupBirth(birth, [birth, exit], null, 1000)).reason, "executor-exit-observed");
  const newer = { ...birth, instance: "new-worker", atMs: 4000 };
  assert.equal(cleanupSkipReason(newer, [birth, exit, newer], null), null, "old exit cannot describe the reused PID's new generation");
  assert.equal(cleanupSkipReason(birth, [birth, newer, { ...exit, atMs: 4500 }], null), null, "new exit cannot describe the old generation");
  const server = { child: { pid: 9, exitCode: 0, signalCode: null } };
  assert.equal((await cleanupBirth({ ...birth, role: "gateway", pid: 9 }, [], server, 1000)).reason, "server-already-exited");
  assert.equal(childExited({ exitCode: null, signalCode: "SIGKILL" }), true);
  const unknown = await cleanupBirth({ ...birth, atMs: undefined }, [], null, 1000);
  assert.equal(unknown.action, "unknown");
  assert.equal(unknown.reason, "missing-or-invalid-birth-identity");
});

test("cleanup native birth calibration skips a reused PID and kills only its matching generation", { timeout: 15_000 }, async t => {
  const notBeforeMs = Date.now();
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  const ended = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  t.after(async () => { if (!childExited(child)) child.kill("SIGKILL"); await ended; });
  const birth = { event: "process-born", role: "executor", pid: child.pid, ppid: process.pid, instance: "native-calibration", atMs: Date.now() + 1000 };
  const reused = await cleanupBirth({ ...birth, atMs: notBeforeMs - 1 }, [], null, notBeforeMs - 10_000);
  assert.equal(reused.action, "skipped");
  assert.equal(reused.reason, "newer-generation");
  assert.ok(Date.parse(reused.createdAtUtc) > notBeforeMs - 1);
  assert.equal(childExited(child), false, "a newer process at the historical PID survived");
  const older = await cleanupBirth({ ...birth, atMs: Date.now() + 2000 }, [], null, Date.now() + 1000);
  assert.equal(older.action, "skipped");
  assert.equal(older.reason, "outside-birth-window");
  assert.equal(childExited(child), false);
  const matched = await cleanupBirth({ ...birth, atMs: Date.now() }, [], null, notBeforeMs);
  assert.equal(matched.action, "killed");
  assert.equal(matched.reason, "native-birth-matched");
  await ended;
  assert.equal(childExited(child), true);
});

test("cleanup directory guard requires an absolute browser directory directly under ROOT/output", () => {
  assert.doesNotThrow(() => assertFixtureDirectory(path.join(ROOT, "output/windows-stability-browser-calibration")));
  assert.throws(() => assertFixtureDirectory("output/windows-stability-browser-relative"), /absolute/);
  assert.throws(() => assertFixtureDirectory(path.join(ROOT, "windows-stability-browser-outside")), /ROOT\/output/);
  assert.throws(() => assertFixtureDirectory(path.join(ROOT, "output/nested/windows-stability-browser-nested")), /ROOT\/output/);
  assert.throws(() => assertFixtureDirectory(path.join(ROOT, "output/other-fixture")), /browser prefix/);
});
