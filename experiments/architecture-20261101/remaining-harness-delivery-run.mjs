import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, readdir, realpath, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASE, ROOT, KINDS, hashFile, inside, read, save, usageOptions, verifyRuntime } from "./remaining-harness-delivery-prepare.mjs";

const serving = process.argv[2] === "--serve";
const { observeQ5Delivery, readQ5Delivery } = serving ? {} : await import("./q5-summary-hook.mjs");
const { painted, waitForServer } = serving ? {} : await import("./b2-page-diagnostic.mjs");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = fileURLToPath(import.meta.url);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const elapsed = () => performance.timeOrigin + performance.now();
const isUsage = (response) => new URL(response.url()).pathname === "/api/usage";

async function stopServer(server, result) {
  if (!server || server.child.exitCode !== null) return;
  let timer;
  const ended = new Promise((resolve, reject) => {
    server.child.once("exit", (code, signal) => resolve({ code, signal }));
    timer = setTimeout(() => { server.child.kill(); reject(new Error("server shutdown timed out")); }, 20000);
  });
  void ended.catch(() => {});
  try {
    const response = await fetch(`${server.ready.url}/internal/shutdown`, { method: "POST",
      headers: { "x-codex-usage-shutdown-token": server.shutdownToken }, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 202);
    const outcome = await ended; assert.equal(outcome.code, 0);
    result.shutdown = outcome;
  } finally { clearTimeout(timer); }
}

async function launch(matrix, variant, directory, suffix = "") {
  const configFile = path.join(directory, `server${suffix}.json`), token = randomUUID();
  await save(configFile, { directory: matrix.versions[variant].directory, options: usageOptions(matrix, token) });
  const traceDirectory = path.join(directory, "nodes"); await mkdir(traceDirectory, { recursive: true });
  const env = { ...process.env, REMAINING_DELIVERY_TRACE: traceDirectory,
    TEMP: path.join(directory, "temp"), TMP: path.join(directory, "temp") };
  delete env.NODE_OPTIONS;
  for (const key of Object.keys(env)) if (/^(?:Q[0-9]+_|ARCH_(?:FULL|SOURCE|TRACE))/.test(key)) delete env[key];
  await mkdir(env.TEMP, { recursive: true });
  const startedAtMs = elapsed();
  const child = spawn(process.execPath, ["--max-old-space-size=512", "--import",
    pathToFileURL(matrix.telemetryModule || path.join(HERE, "remaining-harness-delivery-telemetry.mjs")).href, SCRIPT, "--serve", configFile],
  { cwd: ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (bytes) => void appendFile(path.join(directory, `stdout${suffix}.log`), bytes));
  child.stderr.on("data", (bytes) => void appendFile(path.join(directory, `stderr${suffix}.log`), bytes));
  try { return { child, ready: await waitForServer(child), shutdownToken: token, startedAtMs }; }
  catch (error) { if (child.exitCode === null) child.kill(); throw error; }
}

async function sampling(server, directory, suffix) {
  const target = path.join(directory, `resources-${suffix}`); await mkdir(target);
  const stopFile = path.join(target, "stop");
  const child = spawn("pwsh", ["-NoProfile", "-File", path.join(HERE, "b2-attribution-resource.ps1"),
    "-ResultDir", target, "-ServicePid", String(server.ready.pid), "-RunnerPid", String(process.pid),
    "-StopFile", stopFile, "-StateDir", path.join(BASE, "working-state"), "-TempDir", path.join(directory, "temp"),
    "-SampleIntervalMilliseconds", "250"], { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; child.stderr.on("data", (bytes) => { errors += bytes; });
  const exit = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const ready = (async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`observer exited: ${errors}`);
      try { if ((await stat(path.join(target, "resources.ndjson"))).size) return; } catch (error) { if (error.code !== "ENOENT") throw error; }
      await sleep(100);
    }
    throw new Error("observer did not start");
  })();
  void ready.catch(() => {});
  return { child, stopFile, ready, directory: target, async stop() {
    await writeFile(stopFile, "stop");
    const timer = setTimeout(() => child.kill(), 30000);
    try { assert.equal(await exit, 0, errors); } finally { clearTimeout(timer); }
  } };
}

async function browserContext(matrix) {
  const { chromium } = await import(pathToFileURL(matrix.runtime.playwright.file));
  const browser = await chromium.launch({ headless: true, executablePath: matrix.runtime.chromium.file });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(observeQ5Delivery);
  await context.addInitScript(() => localStorage.setItem("codexUsageCalendarZoneV2", "utc"));
  return { browser, context };
}

async function navigate(context, url, errors) {
  const page = await context.newPage();
  page.setDefaultTimeout(180000); page.setDefaultNavigationTimeout(180000);
  page.on("pageerror", (error) => errors.push(String(error.stack || error)));
  page.on("response", (response) => { if (response.status() >= 500) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  const pending = page.waitForResponse(isUsage);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const response = await pending, first = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(first));
  await painted(page, first.summary.totals.total, 180000);
  return { page, first };
}

async function scope(page, preset, directory, label) {
  const startedAtMs = elapsed();
  const pending = page.waitForResponse((response) => isUsage(response) && new URL(response.url()).searchParams.get("preset") === preset);
  await page.locator(`[data-preset="${preset}"]`).click();
  const response = await pending, body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  await painted(page, body.summary.totals.total, 180000);
  const endedAtMs = elapsed(); await save(path.join(directory, `${label}.json`), body);
  return { preset, startedAtMs, endedAtMs, wallMs: endedAtMs - startedAtMs, total: body.summary.totals.total,
    events: body.summary.eventCount, cache: response.headers()["x-summary-cache"] };
}

async function closePage(page) {
  if (!page) return;
  await page.close();
}

async function storage() {
  const database = new DatabaseSync(path.join(BASE, "working-state/usage-index.sqlite"), { readOnly: true });
  try { return { quickCheck: database.prepare("PRAGMA quick_check").get().quick_check,
    facts: database.prepare("SELECT COUNT(*) events,SUM(total) total FROM events").get(),
    sources: database.prepare("SELECT kind,COUNT(*) files FROM source_files GROUP BY kind").all() }; }
  finally { database.close(); }
}

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const original = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(original, target);
    else { const info = await stat(original); await copyFile(original, target); await utimes(target, info.atime, info.mtime); }
  }
}

async function restore(matrix) {
  for (const file of Object.values(matrix.selected)) {
    assert.ok(inside(matrix.home, file.filePath));
    assert.equal(await realpath(file.filePath), path.resolve(file.filePath));
    assert.equal((await stat(file.filePath)).nlink, 1);
    for (const suffix of ["-wal", "-shm", "-journal"]) await rm(file.filePath + suffix, { force: true });
    assert.equal(await hashFile(file.original), file.sha256);
    await copyFile(file.original, file.filePath);
    await utimes(file.filePath, file.mtimeMs / 1000, file.mtimeMs / 1000);
  }
  const state = path.join(BASE, "working-state");
  assert.equal(await realpath(state), path.resolve(BASE, "working-state")); assert.ok(inside(BASE, state));
  await rm(state, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await copyTree(path.join(BASE, "seed-state"), state);
}

async function seed(matrix) {
  const directory = path.join(BASE, "seed"); await mkdir(directory);
  let server, sampler, browser, page;
  const result = { errors: [], startedAt: new Date().toISOString() };
  try {
    browser = await browserContext(matrix); server = await launch(matrix, "baseline", directory);
    sampler = await sampling(server, directory, "initial"); await sampler.ready;
    ({ page } = await navigate(browser.context, server.ready.url, result.errors));
    result.scopes = [];
    for (const preset of ["all", "today", "week", "all"]) result.scopes.push(await scope(page, preset, directory, `scope-${result.scopes.length}-${preset}`));
    result.storage = await storage(); assert.equal(result.storage.quickCheck, "ok");
    assert.equal(result.storage.sources.length, 6);
    assert.deepEqual(result.errors, []);
    result.all = await read(path.join(directory, "scope-3-all.json"));
    await closePage(page); page = null; await stopServer(server, result); server = null;
    await sampler.stop(); sampler = null; await browser.browser.close(); browser = null;
    await copyTree(path.join(BASE, "working-state"), path.join(BASE, "seed-state"));
    result.passed = true;
  } finally {
    await closePage(page).catch(() => {});
    if (server) await stopServer(server, result);
    if (sampler) await sampler.stop();
    if (browser) await browser.browser.close();
    result.endedAt = new Date().toISOString(); await save(path.join(directory, "result.json"), result);
  }
  console.log(JSON.stringify({ seed: result.passed, facts: result.storage.facts, sources: result.storage.sources }));
}

async function change(page, plan, method, expected, directory, label) {
  const before = await readQ5Delivery(page);
  const pending = page.waitForResponse(async (response) => {
    if (!isUsage(response) || new URL(response.url()).searchParams.get("preset") !== "all") return false;
    try { return (await response.json()).summary?.totals?.total === expected.total; } catch { return false; }
  }, { timeout: 180000 });
  void pending.catch(() => {});
  const mutation = await method(plan);
  const response = await pending, body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  assert.equal(body.summary.eventCount, expected.events);
  assert.equal(body.summary.sessionCount, expected.sessions);
  await painted(page, expected.total, 180000);
  const endedAtMs = elapsed(), delivery = await readQ5Delivery(page);
  const rows = delivery.rows.slice(before.rows.length);
  assert.equal(delivery.dropped, 0);
  assert.ok(rows.some((row) => row.kind === "page-receipt" && row.event === "usage-synced"), "new value must follow the source notification");
  const paint = rows.find((row) => row.kind === "paint" && Number(String(row.total).replace(/[^0-9]/g, "")) === expected.total);
  assert.ok(paint, "new-value frame missing");
  const actualPaintMs = paint.clock - mutation.landedAtMs;
  assert.ok(actualPaintMs >= 0, "paint precedes source commit");
  await save(path.join(directory, `${label}.json`), body);
  return { label, ...mutation, expected, actualPaintMs, confirmedMs: endedAtMs - mutation.landedAtMs,
    endedAtMs, cache: response.headers()["x-summary-cache"], fingerprint: body.fingerprint, responseAtMs: rows.find((row) => row.kind === "fetch-body" && row.total === expected.total)?.clock };
}

async function run(matrix, kind, variant, label = `${kind}-${variant}`) {
  const { planChanges, appendChange, reviseChange } = await import("./remaining-harness-delivery-fixture.mjs");
  assert.ok(KINDS.includes(kind)); assert.ok(matrix.versions[variant]); assert.match(label, /^[a-z0-9-]+$/);
  await verifyRuntime(matrix.versions[variant]);
  const directory = path.join(BASE, "formal", label); await assert.rejects(stat(directory), (error) => error.code === "ENOENT"); await mkdir(directory, { recursive: true });
  await restore(matrix);
  const planFile = path.join(BASE, `plan-${kind}.json`);
  let plan;
  try { plan = await read(planFile); } catch (error) {
    if (error.code !== "ENOENT") throw error;
    plan = await planChanges({ ...matrix.selected[kind], kind, runtimeDirectory: matrix.versions.baseline.directory, appendTimeMs: Date.now() - 60000 });
    await save(planFile, plan);
  }
  const seed = await read(path.join(BASE, "seed/result.json"));
  const result = { kind, variant, label, errors: [], changes: [], scopes: [], startedAt: new Date().toISOString(), passed: false };
  let server, sampler, browser, page;
  try {
    browser = await browserContext(matrix); server = await launch(matrix, variant, directory);
    sampler = await sampling(server, directory, "initial"); await sampler.ready;
    ({ page } = await navigate(browser.context, server.ready.url, result.errors));
    result.initial = await scope(page, "all", directory, "initial");
    assert.equal(result.initial.total, seed.storage.facts.total); assert.equal(result.initial.events, seed.storage.facts.events);
    const expected = { total: result.initial.total, events: result.initial.events, sessions: (await read(path.join(directory, "initial.json"))).summary.sessionCount };
    for (const ordinal of [1, 2]) {
      expected.total += 160; expected.events++;
      result.changes.push(await change(page, plan, (value) => appendChange(value, ordinal), { ...expected }, directory, `append-${ordinal}`));
    }
    expected.total += 19;
    result.changes.push(await change(page, plan, reviseChange, { ...expected }, directory, "revision"));
    for (const preset of ["today", "week", "all"]) result.scopes.push(await scope(page, preset, directory, `scope-${preset}`));
    result.beforeReopenStorage = await storage();
    await page.screenshot({ path: path.join(directory, "final.png"), fullPage: true });
    result.deliveryInitial = await readQ5Delivery(page);
    await closePage(page); page = null; await stopServer(server, result); server = null;
    await sampler.stop(); sampler = null;
    // Chromium is already running; the clock includes the full new service process.
    server = await launch(matrix, variant, directory, "-reopen");
    sampler = await sampling(server, directory, "reopen");
    ({ page } = await navigate(browser.context, server.ready.url, result.errors));
    const reopened = await scope(page, "all", directory, "reopen");
    result.reopen = { ...reopened, startedAtMs: server.startedAtMs, wallMs: reopened.endedAtMs - server.startedAtMs };
    assert.equal(reopened.total, expected.total); assert.equal(reopened.events, expected.events);
    await sampler.ready; result.deliveryReopen = await readQ5Delivery(page);
    result.finalStorage = await storage(); assert.equal(result.finalStorage.quickCheck, "ok");
    assert.deepEqual(result.errors, []); result.passed = true;
  } catch (error) { result.error = String(error.stack || error); throw error; }
  finally {
    await closePage(page).catch(() => {});
    if (server) await stopServer(server, result);
    if (sampler) await sampler.stop();
    if (browser) await browser.browser.close();
    result.endedAt = new Date().toISOString(); await save(path.join(directory, "result.json"), result);
  }
  await verifyRuntime(matrix.versions[variant]);
  console.log(JSON.stringify({ kind, variant, passed: result.passed, appends: result.changes.slice(0, 2).map((row) => row.actualPaintMs),
    revisionMs: result.changes[2].actualPaintMs, reopenMs: result.reopen.wallMs }));
}

const args = process.argv.slice(2);
if (args[0] === "--serve") {
  const config = await read(args[1]);
  const { createUsageServer } = await import(pathToFileURL(path.join(config.directory, "src/server.js")));
  let server, closing = false;
  async function shutdown() { if (closing) return; closing = true; await new Promise((resolve) => server.close(resolve)); process.exit(0); }
  server = createUsageServer({ ...config.options, onShutdown: () => void shutdown() });
  server.on("error", (error) => { console.error(error.stack); process.exit(1); });
  server.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ stage: "server-ready", pid: process.pid,
    port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })));
  process.once("SIGTERM", () => void shutdown()); process.once("SIGINT", () => void shutdown());
} else {
  const matrix = await read(path.join(BASE, "matrix.json"));
  if (args[0] === "seed") await seed(matrix);
  else if (args[0] === "run") await run(matrix, args[1], args[2], args[3]);
  else if (args[0] === "matrix") {
    for (const [index, kind] of KINDS.entries()) for (const variant of index % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"]) await run(matrix, kind, variant);
  } else throw new Error("use seed | matrix | run <kind> <variant> [new-label]");
}
