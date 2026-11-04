import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cloneQ5Cell, lockCanonical } from "./q5-fixture.mjs";
import { appendQ5AndPaint, observeQ5Delivery, readQ5Delivery, readCapturedPricing } from "./q5-summary-hook.mjs";
import { openPage, painted, serverOptions, waitForServer, stopServer, progressRows, codexAppendRows, dshAppendFrame } from "./b2-page-diagnostic.mjs";
import { BASE, ROOT } from "./q6-performance-prepare.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const save = async (file, value) => {
  await writeFile(`${file}.pending`, JSON.stringify(value, null, 2) + "\n", { flush: true });
  await rename(`${file}.pending`, file);
};
export function nativeAppendEvidence(append, expectedKind) {
  if (append.proofKind !== expectedKind) return { nativeAppend: false, nativeReparse: false };
  const captured = append.proofs.some((row) => row.label === "proof.capture" && row.proofKind === expectedKind && row.readBytes === 0);
  const verified = append.proofs.some((row) => row.label === "proof.verify" && row.proofKind === expectedKind && row.readBytes === 0);
  return { nativeAppend: captured && verified, nativeReparse: captured && !verified &&
    append.syncs.some((row) => row.sourceWork?.replacedFiles > 0) };
}
async function traces(directory) {
  return (await Promise.all((await readdir(directory)).filter((name) => /^trace-.*\.ndjson$/.test(name))
    .map(async (name) => (await readFile(path.join(directory, name), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse)))).flat();
}
function storage(prepared) {
  const db = new DatabaseSync(prepared.databaseFile, { readOnly: true });
  try { return { integrity: db.prepare("PRAGMA quick_check").get().quick_check,
    events: db.prepare("SELECT COUNT(*) n, SUM(total) total FROM events").get(),
    catalog: db.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_source_catalog'").get()
      ? { ready: db.prepare("SELECT ready FROM usage_source_catalog WHERE path=''").get()?.ready ?? 0,
        rows: db.prepare("SELECT COUNT(*) n FROM usage_source_catalog").get().n,
        pages: db.prepare("SELECT name,SUM(pgsize) bytes FROM dbstat WHERE name LIKE 'usage_source_catalog%' GROUP BY name").all() } : null }; }
  finally { db.close(); }
}

async function runCell(cell, matrix) {
  const { prepared, directory, variant, proofMode } = cell;
  await assert.rejects(stat(path.join(directory, "result.json")), (error) => error.code === "ENOENT");
  const version = matrix.versions.find((entry) => entry.variant === variant);
  const traceDirectory = path.join(directory, "components");
  await mkdir(traceDirectory, { recursive: true });
  const result = { generation: "q6", cell: cell.id, variant, proofMode, prepared, rounds: cell.rounds,
    startedAt: new Date().toISOString(), appends: [], scopes: [], resourceSpans: [], passed: false };
  let server, sampler, browser, release;
  const checkpoint = async () => {
    if (browser) result.delivery = await readQ5Delivery(browser.page);
    await save(path.join(directory, "result.json"), result);
  };
  async function launch(suffix = "") {
    const token = randomUUID();
    const configFile = path.join(directory, `server${suffix}.json`);
    const hookConfig = path.join(directory, `hook${suffix}.json`);
    await writeFile(configFile, JSON.stringify({ options: serverOptions(prepared, token) }));
    await writeFile(hookConfig, JSON.stringify({ version, output: traceDirectory, proofMode, pricing: matrix.pricing,
      selected: Object.values(prepared.selected).map((entry) => entry.targetPath) }));
    const env = { ...process.env, Q6_PERFORMANCE_CONFIG: hookConfig, TEMP: path.join(directory, "temp"), TMP: path.join(directory, "temp") };
    for (const key of ["NODE_OPTIONS", "Q5_VARIANT", "Q6_TEST_HELPER", "Q6_TEST_TRACE"]) delete env[key];
    await mkdir(env.TEMP, { recursive: true });
    const child = spawn(process.execPath, ["--max-old-space-size=512", "--import", pathToFileURL(path.join(here, "q6-performance-hook.mjs")).href,
      fileURLToPath(import.meta.url), "--serve", configFile], { cwd: ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const ready = await waitForServer(child);
    return { child, ready, shutdownToken: token };
  }
  async function sampling(suffix = "") {
    const out = path.join(directory, suffix ? `resources-${suffix}` : "resources");
    await mkdir(out, { recursive: true });
    const stopFile = path.join(out, "stop");
    const child = spawn("pwsh", ["-NoProfile", "-File", path.join(here, "b2-attribution-resource.ps1"),
      "-ResultDir", out, "-ServicePid", String(server.ready.pid), "-RunnerPid", String(process.pid),
      "-StopFile", stopFile, "-StateDir", prepared.stateDirectory, "-TempDir", path.join(directory, "temp"), "-SampleIntervalMilliseconds", "500"],
    { cwd: ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let error = ""; child.stderr.on("data", (bytes) => { error += bytes; });
    result.resourceSpans.push({ directory: out, phase: suffix || "initial", servicePid: server.ready.pid });
    await sleep(1500); assert.equal(child.exitCode, null, error);
    return { child, stopFile, error: () => error };
  }
  async function stopSampling() {
    if (!sampler) return;
    const current = sampler; sampler = null;
    await writeFile(current.stopFile, "stop");
    if (current.child.exitCode === null) {
      const exit = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { current.child.kill(); reject(new Error("resource sampler stop timeout")); }, 30000);
        current.child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
      });
      assert.equal(exit, 0, current.error());
    } else assert.equal(current.child.exitCode, 0, current.error());
  }
  async function scope(preset) {
    const page = browser.page;
    const pending = page.waitForResponse((response) => { const url = new URL(response.url()); return url.pathname === "/api/usage" && url.searchParams.get("preset") === preset; });
    const start = Date.now();
    await page.evaluate((value) => document.querySelector(`[data-preset="${value}"]`).click(), preset);
    const response = await pending, body = await response.json();
    assert.equal(response.status(), 200, JSON.stringify(body));
    await painted(page, body.summary.totals.total, 120000);
    result.scopes.push({ preset, startedAtMs: start, endedAtMs: Date.now(), wallMs: Date.now() - start,
      cache: response.headers()["x-summary-cache"], total: body.summary.totals.total });
    await checkpoint();
  }
  try {
    release = await lockCanonical(prepared);
    result.fixture = await cloneQ5Cell(prepared, { proofMode, nativeBinary: version.nativeBinary, variant,
      pricingSha256: matrix.pricing.catalogSha256 });
    assert.equal(result.fixture.factsIdentical, true);
    server = await launch(); result.server = server.ready;
    sampler = await sampling();
    const started = Date.now();
    browser = await openPage(server.ready.url, directory, [observeQ5Delivery]);
    browser.page.setDefaultTimeout(120000);
    const originalWait = browser.page.waitForResponse.bind(browser.page);
    browser.page.waitForResponse = (predicate, options) => originalWait(predicate, { ...options, timeout: 120000 });
    result.first = { startedAtMs: started, endedAtMs: Date.now(), all: browser.all };
    result.initialStorage = storage(prepared); await checkpoint();
    let expected = browser.all.total;
    const previous = progressRows(prepared.databaseFile).find((entry) => entry.sourcePath === prepared.selected.codex.targetPath).checkpoint.state.previousCumulative;
    const state = { codex: { cumulative: { ...previous }, nextTimestampMs: matrix.appendTimeMs },
      dsh: { nextSequence: matrix.appendTimeMs * 10, nextTimestampMs: matrix.appendTimeMs, turn: 1, step: 1 } };
    for (const kind of ["codex", "dsh"]) for (let n = 0; n < cell.rounds; n++) {
      expected += kind === "codex" ? 1000 : 1900;
      await appendQ5AndPaint(browser.page, prepared, state, kind, result, expected, checkpoint, {
        painted: (page, total) => painted(page, total, 120000), codexAppendRows, dshAppendFrame });
      const append = result.appends.at(-1);
      assert.equal(append.responseEventCount, browser.all.eventCount + result.appends.length);
      const delivery = await readQ5Delivery(browser.page);
      const paint = delivery.rows.find((row) => row.kind === "paint" && row.at >= append.appendLandedAtMs &&
        Number(String(row.total).replace(/[^0-9]/g, "")) === expected);
      assert.ok(paint, "correct-value paint observer missing");
      append.actualPaintAtMs = paint.clock ?? paint.at;
      append.actualPaintMs = append.actualPaintAtMs - append.appendLandedAtMs;
      const rows = (await traces(traceDirectory)).filter((row) => row.at >= append.appendStartedAtMs && row.at <= append.endedAtMs);
      append.acquisition = rows.filter((row) => row.label === "acquisition.prepare").map((row) => ({ eligible: row.eligible, work: row.work, duration: row.duration }));
      append.syncs = rows.filter((row) => row.label === "store.sync");
      append.fullFallback = append.syncs.some((row) => row.delta.enumerations > 0) || rows.some((row) => row.label === "discovery");
      const progress = progressRows(prepared.databaseFile).find((entry) => entry.sourcePath === prepared.selected[kind].targetPath);
      append.proofKind = progress.validation.kind;
      append.proofs = rows.filter((row) => row.label?.startsWith("proof.") && row.path === prepared.selected[kind].targetPath);
      if (proofMode === "sha") assert.equal(append.proofKind, "sha256-prefix-v2");
      else {
        const expectedKind = result.fixture.proofs.find((row) => row.kind === kind).proofKind;
        Object.assign(append, nativeAppendEvidence(append, expectedKind));
        assert.ok(append.nativeAppend || append.nativeReparse, "Native proof or full-source recertification missing");
      }
      await checkpoint();
    }
    for (const preset of ["today", "week", "all"]) await scope(preset);
    result.final = result.first.all.body;
    const finalResponse = await browser.page.evaluate(async () => (await fetch("/api/usage?preset=all&view=dashboard&bucket=day&calendarZone=local&skipCheck=1")).json());
    result.final = finalResponse; result.finalStorage = storage(prepared);
    assert.equal(result.finalStorage.events.total, expected);
    assert.equal(result.finalStorage.integrity, "ok"); assert.deepEqual(browser.errors, []);
    await checkpoint();
    await browser.browser.close(); browser = null;
    await stopServer(server, result); server = null; await stopSampling();
    const reopen = Date.now(); server = await launch("-reopen"); sampler = await sampling("reopen");
    browser = await openPage(server.ready.url, directory, [observeQ5Delivery]);
    assert.equal(browser.all.total, expected);
    result.reopen = { startedAtMs: reopen, endedAtMs: Date.now(), all: browser.all };
    assert.deepEqual(browser.errors, []); result.passed = true;
  } catch (error) { result.failure = { message: error.message, stack: error.stack, code: error.code }; }
  finally {
    try { await checkpoint(); } catch {}
    if (browser) await browser.browser.close();
    if (server) await stopServer(server, result);
    await stopSampling();
    if (release) {
      for (const prior of Object.values(cell.prior)) {
        await copyFile(prior.file, prior.path);
        await utimes(prior.path, prior.mtimeMs / 1000, prior.mtimeMs / 1000);
        assert.equal((await stat(prior.path)).size, prior.size);
      }
      await release();
    }
    result.finishedAt = new Date().toISOString();
    await save(path.join(directory, "result.json"), result);
  }
  console.log(JSON.stringify({ cell: cell.id, variant, passed: result.passed, appends: result.appends.length,
    fallbackAppends: result.appends.filter((row) => row.fullFallback).length, failure: result.failure?.message }));
  if (!result.passed) process.exitCode = 1;
  return result;
}

if (process.argv[2] === "--serve") {
  const config = await read(path.resolve(process.argv[3]));
  const { createUsageServer } = await import("../../src/server.js");
  let server;
  const shutdown = async () => { await server.close(); process.exit(0); };
  server = createUsageServer({ ...config.options, onShutdown: () => void shutdown() });
  server.once("error", (error) => { console.error(error); process.exit(1); });
  server.listen(49152 + process.pid % 10000, "127.0.0.1", () => console.log(JSON.stringify({ stage: "server-ready", pid: process.pid,
    port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })));
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const matrix = await read(path.join(BASE, "matrix.json"));
  readCapturedPricing(matrix.pricing.file, matrix.pricing.catalogSha256);
  const cell = matrix.cells.find((entry) => entry.id === process.argv[2] && entry.variant === process.argv[3]);
  assert.ok(cell, "Specify a prepared cell and variant");
  await runCell(cell, matrix);
}
