import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { createUsageExecutor } from "../../src/usage-executor.js";

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const WORKSPACE_ROOT = path.resolve(path.dirname(SCRIPT_FILE), "../..");
const B2_ROOT = path.join(WORKSPACE_ROOT, "output/architecture-20261103/b2");
const DEFAULT_OUTPUT_ROOT = path.join(B2_ROOT, "page-e1-final-v2");
const BASELINE_ROOT = path.join(WORKSPACE_ROOT, "output/architecture-20261103/growth-baseline");
const RESOURCE_SAMPLER = path.join(
  WORKSPACE_ROOT,
  "experiments/architecture-20261101/growth-resource-sampler.ps1",
);
const PLAYWRIGHT_MODULE =
  process.env.ARCH_PLAYWRIGHT_MODULE ||
  "C:/Users/Silver/AppData/Local/npm-cache/_npx/31e32ef8478fbf80/node_modules/playwright/index.mjs";
const CHROMIUM_EXECUTABLE =
  process.env.ARCH_CHROMIUM ||
  "C:/Users/Silver/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe";
const NODE_GATEWAY_HEAP_MB = 512;
const EXECUTOR_HEAP_MB = 224;
const WAIT_TIMEOUT_MS = 900_000;
const TODAY = new Date();
const CODEX_DELTA = 1_000;
const DSH_DELTA = 1_900;
const DEFAULT_SCALES = ["1x", "10x"];
const TOKEN_FIELDS = ["total", "input", "cached", "output", "reasoning"];
const CONFIG_FILE_NAMES = new Set(["config.toml", "settings.json", "opencode.json", "auth.json"]);
const SOURCE_FILES = [
  "public/app.js",
  "public/timeline-utils.js",
  "src/dsh-frame-progress.js",
  "src/dsh-usage.js",
  "src/server.js",
  "src/usage-core.js",
  "src/usage-executor.js",
  "src/usage-rollups.js",
  "src/usage-source-native.js",
  "src/usage-source-proof.js",
  "src/usage-store.js",
  "src/usage-summary-cache.js",
];

function log(stage, details = {}) {
  process.stdout.write(`${JSON.stringify({ stage, at: new Date().toISOString(), ...details })}\n`);
}

function safeInteger(value, label) {
  const number = Number(value);
  assert.ok(Number.isSafeInteger(number) && number >= 0, `${label} must be a non-negative safe integer`);
  return number;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function relativeToWorkspace(filePath) {
  return path.relative(WORKSPACE_ROOT, filePath).split(path.sep).join("/");
}

async function hashFile(filePath) {
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { sha256: hash.digest("hex"), bytes: offset };
}

async function productionSourceSnapshot() {
  const files = {};
  for (const relative of SOURCE_FILES) {
    const filePath = path.join(WORKSPACE_ROOT, relative);
    const info = await stat(filePath);
    const hash = await hashFile(filePath);
    files[relative] = {
      sha256: hash.sha256,
      bytes: hash.bytes,
      mtimeMs: info.mtimeMs,
    };
  }
  return {
    capturedAt: new Date().toISOString(),
    files,
  };
}

async function walkFiles(root, output = []) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(child, output);
    else if (entry.isFile()) output.push(child);
  }
  return output;
}

function datasetFiles(dataset) {
  const candidates = dataset.inputs
    .filter((entry) => entry && typeof entry.path === "string" && Number.isSafeInteger(entry.sourceBytes))
    .map((entry) => ({ ...entry, resolvedPath: path.resolve(entry.path) }));
  assert.ok(candidates.length > 0);
  for (const candidate of candidates) {
    assert.equal(path.parse(candidate.resolvedPath).root.toLowerCase(), path.parse(dataset.root).root.toLowerCase());
    const relative = path.relative(path.resolve(dataset.root), candidate.resolvedPath);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  }
  return candidates;
}

function expectedDatasetTotal(dataset) {
  return dataset.expected.reduce((sum, entry) => sum + safeInteger(entry.total, `${entry.kind} expected total`), 0);
}

function expectedDatasetEvents(dataset) {
  return dataset.expected.reduce((sum, entry) => sum + safeInteger(entry.events, `${entry.kind} expected events`), 0);
}

function selectedScaleFiles(dataset) {
  const files = datasetFiles(dataset).filter((entry) => entry.role === "usage-file");
  const choose = (kind) =>
    files
      .filter((entry) => entry.kind === kind)
      .sort(
        (left, right) =>
          right.sourceBytes - left.sourceBytes ||
          left.key.localeCompare(right.key) ||
          left.resolvedPath.localeCompare(right.resolvedPath),
      )[0];
  const codex = choose("codex");
  const dsh = choose("dsh");
  assert.ok(codex && codex.compressed === false, `${dataset.scale}x selected Codex source must be plain JSONL`);
  assert.ok(dsh && dsh.compressed === true, `${dataset.scale}x selected DSH source must be compressed v4`);
  return { codex, dsh };
}

async function assertDiskSpace(outputRoot) {
  const fileSystem = await statfs(outputRoot, { bigint: true });
  const freeBytes = fileSystem.bavail * fileSystem.bsize;
  assert.ok(freeBytes > 20n * 1024n * 1024n * 1024n, `insufficient E: free space: ${freeBytes} bytes`);
  return { freeBytes: Number(freeBytes), blockSize: Number(fileSystem.bsize) };
}

async function createMirror(dataset, runRoot) {
  const scaleRoot = path.join(runRoot, `${dataset.scale}x`);
  const home = path.join(scaleRoot, "home");
  const sourceRoot = path.resolve(dataset.root);
  await mkdir(home, { recursive: true });
  const selected = selectedScaleFiles(dataset);
  const selectedPaths = new Set([path.resolve(selected.codex.resolvedPath), path.resolve(selected.dsh.resolvedPath)]);
  const files = await walkFiles(sourceRoot);
  const sourceFiles = new Map(files.map((file) => [path.resolve(file), file]));
  for (const input of datasetFiles(dataset)) {
    assert.ok(sourceFiles.has(input.resolvedPath), `dataset input is absent from source home: ${input.path}`);
  }

  const stats = {
    files: 0,
    bytes: 0,
    hardlinks: 0,
    independentUsageCopies: 0,
    independentConfigCopies: 0,
    startedAt: new Date().toISOString(),
  };
  const started = performance.now();
  for (const sourceFile of files) {
    const relative = path.relative(sourceRoot, sourceFile);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const target = path.join(home, relative);
    await mkdir(path.dirname(target), { recursive: true });
    const info = await stat(sourceFile);
    const independent =
      selectedPaths.has(path.resolve(sourceFile)) || CONFIG_FILE_NAMES.has(path.basename(sourceFile).toLowerCase());
    if (independent) {
      await copyFile(sourceFile, target, 1);
      const [sourceInfo, targetInfo] = await Promise.all([stat(sourceFile), stat(target)]);
      assert.notEqual(String(sourceInfo.ino), String(targetInfo.ino), `independent copy unexpectedly hardlinked: ${target}`);
      if (selectedPaths.has(path.resolve(sourceFile))) stats.independentUsageCopies += 1;
      else stats.independentConfigCopies += 1;
    } else {
      try {
        await link(sourceFile, target);
        const [sourceInfo, targetInfo] = await Promise.all([stat(sourceFile), stat(target)]);
        assert.equal(String(sourceInfo.ino), String(targetInfo.ino), `hardlink inode mismatch: ${target}`);
        stats.hardlinks += 1;
      } catch (error) {
        if (!["EXDEV", "EPERM"].includes(error.code)) throw error;
        await copyFile(sourceFile, target, 1);
        stats.fallbackCopies = (stats.fallbackCopies || 0) + 1;
      }
    }
    const targetInfo = await stat(target);
    assert.equal(targetInfo.size, info.size);
    stats.files += 1;
    stats.bytes += info.size;
  }
  stats.elapsedMs = performance.now() - started;
  stats.finishedAt = new Date().toISOString();
  assert.equal(stats.independentUsageCopies, 2);
  assert.ok(stats.independentConfigCopies >= 2, "configuration files must not be writable hardlinks");

  const mapped = {};
  for (const kind of ["codex", "dsh"]) {
    const source = selected[kind];
    const relative = path.relative(sourceRoot, source.resolvedPath);
    const target = path.join(home, relative);
    const before = await hashFile(source.resolvedPath);
    const targetHash = await hashFile(target);
    assert.deepEqual(targetHash, before);
    assert.equal(before.sha256, source.sha256, `${dataset.scale}x ${kind} frozen source SHA drifted`);
    mapped[kind] = {
      kind,
      key: source.key,
      sessionKey: source.sessionKey,
      sourcePath: source.resolvedPath,
      targetPath: target,
      sourceBytes: source.sourceBytes,
      sourceSha256: source.sha256,
      originalInfo: await stat(source.resolvedPath),
    };
  }
  return { scaleRoot, home, selected: mapped, mirror: stats };
}

async function prepareScale(dataset, runRoot, seedSource) {
  const mirrored = await createMirror(dataset, runRoot);
  const stateDirectory = path.join(mirrored.scaleRoot, ".codex-usage");
  await mkdir(stateDirectory, { recursive: true });
  await copyFile(path.join(seedSource, "pricing-auto.json"), path.join(stateDirectory, "pricing-auto.json"));
  await copyFile(path.join(seedSource, "codex-quota.json"), path.join(stateDirectory, "codex-quota.json"));
  return {
    ...mirrored,
    stateDirectory,
    databaseFile: path.join(stateDirectory, "usage-index.sqlite"),
    importStoreFile: path.join(stateDirectory, "imports.json"),
    pricingFile: path.join(stateDirectory, "pricing.json"),
    automaticPricingFile: path.join(stateDirectory, "pricing-auto.json"),
    oracleDatabaseFile: path.join(mirrored.scaleRoot, "oracle", "usage-index.sqlite"),
  };
}

async function loadExistingScale(dataset, scaleRoot) {
  const home = path.join(scaleRoot, "home");
  assert.ok((await stat(home)).isDirectory(), `existing diagnostic home not found: ${home}`);
  const selected = selectedScaleFiles(dataset);
  const mapped = {};
  for (const kind of ["codex", "dsh"]) {
    const source = selected[kind];
    const relative = path.relative(path.resolve(dataset.root), source.resolvedPath);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    const targetPath = path.join(home, relative);
    assert.ok((await stat(targetPath)).isFile(), `existing diagnostic source not found: ${targetPath}`);
    const before = await hashFile(source.resolvedPath);
    assert.equal(before.sha256, source.sha256, `${dataset.scale}x frozen ${kind} source SHA drifted`);
    mapped[kind] = {
      kind,
      key: source.key,
      sessionKey: source.sessionKey,
      sourcePath: source.resolvedPath,
      targetPath,
      sourceBytes: source.sourceBytes,
      sourceSha256: source.sha256,
      originalInfo: await stat(source.resolvedPath),
    };
  }
  const stateDirectory = path.join(scaleRoot, ".codex-usage");
  return {
    scaleRoot,
    home,
    selected: mapped,
    mirror: null,
    stateDirectory,
    databaseFile: path.join(stateDirectory, "usage-index.sqlite"),
    importStoreFile: path.join(stateDirectory, "imports.json"),
    pricingFile: path.join(stateDirectory, "pricing.json"),
    automaticPricingFile: path.join(stateDirectory, "pricing-auto.json"),
    oracleDatabaseFile: path.join(scaleRoot, "oracle", "usage-index.sqlite"),
  };
}

function serverOptions(prepared, shutdownToken = null) {
  return {
    homeDir: prepared.home,
    env: {},
    importDirs: [],
    extraOpencodeHomes: path.join(prepared.home, ".opencode"),
    databaseFile: prepared.databaseFile,
    importStoreFile: prepared.importStoreFile,
    pricingFile: prepared.pricingFile,
    automaticPricingFile: prepared.automaticPricingFile,
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
    ...(shutdownToken ? { shutdownToken } : {}),
  };
}

async function serveMain(configFile) {
  const config = JSON.parse(await readFile(configFile, "utf8"));
  assert.equal(config.gatewayHeapMb, NODE_GATEWAY_HEAP_MB);
  assert.ok(config.options.homeDir && config.options.databaseFile);
  const { createUsageServer } = await import("../../src/server.js");
  let closing = false;
  let server;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  };
  server = createUsageServer({ ...config.options, onShutdown: () => void shutdown() });
  server.once("error", (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    log("server-ready", {
      pid: process.pid,
      port: address.port,
      url: `http://127.0.0.1:${address.port}`,
      heapLimitBytes: process.memoryUsage().heapTotal,
    });
  });
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

async function waitForServer(child) {
  let output = "";
  let errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.stage === "server-ready") log("child-server-ready", record);
      } catch {
        // The child may print a framework message; preserve it for failure diagnostics.
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`diagnostic server exited ${child.exitCode}\n${output}\n${errors}`);
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.stage === "server-ready") return record;
      } catch {
        // Ignore non-protocol lines.
      }
    }
    await sleep(100);
  }
  child.kill("SIGKILL");
  throw new Error(`diagnostic server readiness timed out\n${output}\n${errors}`);
}

async function startServer(prepared, scaleRoot) {
  const shutdownToken = createHash("sha256")
    .update(`${process.pid}:${Date.now()}:${prepared.home}`)
    .digest("hex");
  const configFile = path.join(scaleRoot, "server-config.json");
  const options = serverOptions(prepared, shutdownToken);
  await writeFile(
    configFile,
    `${JSON.stringify({ gatewayHeapMb: NODE_GATEWAY_HEAP_MB, executorHeapMb: EXECUTOR_HEAP_MB, options }, null, 2)}\n`,
    { flag: "wx" },
  );
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${NODE_GATEWAY_HEAP_MB}`, SCRIPT_FILE, "--serve", configFile],
    {
      cwd: WORKSPACE_ROOT,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const ready = await waitForServer(child);
  return { child, ready, shutdownToken, configFile };
}

async function stopServer(server, result) {
  if (!server || server.child.exitCode !== null) return;
  const started = performance.now();
  let response;
  try {
    response = await fetch(`${server.ready.url}/internal/shutdown`, {
      method: "POST",
      headers: { "x-codex-usage-shutdown-token": server.shutdownToken },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    if (server.child.exitCode === null) throw error;
  }
  if (response) assert.equal(response.status, 202);
  const exited = await Promise.race([
    new Promise((resolve) => server.child.once("exit", (code, signal) => resolve({ code, signal }))),
    sleep(20_000).then(() => null),
  ]);
  if (!exited) {
    server.child.kill("SIGKILL");
    throw new Error("diagnostic server did not exit after graceful shutdown");
  }
  assert.equal(exited.code, 0, `diagnostic server exited with code ${exited.code}`);
  result.shutdown = { elapsedMs: performance.now() - started, ...exited };
}

async function startSampler(scaleRoot, servicePid) {
  const stopFile = path.join(scaleRoot, "resource-stop");
  const child = spawn(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      RESOURCE_SAMPLER,
      "-ResultDir",
      scaleRoot,
      "-ServicePid",
      String(servicePid),
      "-RunnerPid",
      String(process.pid),
      "-StopFile",
      stopFile,
    ],
    { cwd: WORKSPACE_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await sleep(1_200);
  assert.equal(child.exitCode, null, `resource sampler exited early: ${stderr}`);
  return { child, stopFile, stderr: () => stderr };
}

async function stopSampler(sampler, scaleRoot) {
  if (!sampler) return null;
  await writeFile(sampler.stopFile, "stop");
  const exit = await Promise.race([
    new Promise((resolve) => sampler.child.once("exit", (code, signal) => resolve({ code, signal }))),
    sleep(30_000).then(() => null),
  ]);
  if (!exit) {
    sampler.child.kill("SIGKILL");
    throw new Error("resource sampler did not stop");
  }
  assert.equal(exit.code, 0, `resource sampler failed: ${sampler.stderr()}`);
  const summary = JSON.parse(await readFile(path.join(scaleRoot, "resource-summary.json"), "utf8"));
  const samples = (await readFile(path.join(scaleRoot, "resource-samples.ndjson"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(samples.length > 0);
  return { ...summary, samples, exit };
}

function instrumentPage() {
  const state = {
    usageSynced: 0,
    sources: [],
    sseCloses: [],
    suppressedSseOpens: [],
    fetchPaths: [],
    sseDisabled: false,
  };
  Object.defineProperty(window, "__e1Diagnostic", { value: state, configurable: false });
  const NativeEventSource = window.EventSource;
  function TrackedEventSource(url, configuration) {
    if (state.sseDisabled) {
      state.suppressedSseOpens.push({ at: Date.now(), url: String(url) });
      return {
        CONNECTING: NativeEventSource.CONNECTING,
        OPEN: NativeEventSource.OPEN,
        CLOSED: NativeEventSource.CLOSED,
        readyState: NativeEventSource.CLOSED,
        url: String(url),
        withCredentials: Boolean(configuration?.withCredentials),
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return true;
        },
        close() {
          state.sseCloses.push({ at: Date.now(), url: String(url), suppressedOpen: true });
        },
      };
    }
    const source = new NativeEventSource(url, configuration);
    const nativeClose = source.close.bind(source);
    Object.defineProperty(source, "close", {
      configurable: true,
      value() {
        state.sseCloses.push({ at: Date.now(), url: String(url) });
        return nativeClose();
      },
    });
    state.sources.push(source);
    source.addEventListener("usage-synced", () => {
      state.usageSynced += 1;
    });
    return source;
  }
  TrackedEventSource.prototype = NativeEventSource.prototype;
  for (const key of ["CONNECTING", "OPEN", "CLOSED"]) {
    Object.defineProperty(TrackedEventSource, key, { value: NativeEventSource[key] });
  }
  window.EventSource = TrackedEventSource;
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const raw = args[0] instanceof Request ? args[0].url : String(args[0]);
    state.fetchPaths.push(new URL(raw, location.href).pathname + new URL(raw, location.href).search);
    return nativeFetch(...args);
  };
}

async function painted(page, expected, timeout = WAIT_TIMEOUT_MS) {
  await page.waitForFunction(
    (value) => {
      const title = document.querySelector("#totalTokens")?.title;
      const spinner = document.querySelector("#autoRefreshSpinner");
      const numeric = Number(String(title || "").replace(/[^0-9]/g, ""));
      return numeric === value && !spinner?.classList.contains("is-loading");
    },
    expected,
    { timeout },
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

function usageResponseMatches(response, preset) {
  const url = new URL(response.url());
  return url.pathname === "/api/usage" && (url.searchParams.get("preset") || "all") === preset;
}

async function switchPreset(page, preset, details) {
  const started = performance.now();
  const startedAtMs = Date.now();
  const responsePromise = page.waitForResponse((response) => usageResponseMatches(response, preset), {
    timeout: WAIT_TIMEOUT_MS,
  });
  await page.evaluate((value) => document.querySelector(`[data-preset="${value}"]`).click(), preset);
  const response = await responsePromise;
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  const total = safeInteger(body.summary?.totals?.total, `${preset} total`);
  await painted(page, total);
  const record = {
    preset,
    total,
    eventCount: body.summary?.eventCount,
    cache: response.headers()["x-summary-cache"] || null,
    wallMs: performance.now() - started,
    startedAtMs,
    endedAtMs: Date.now(),
  };
  details.scopes.push({ name: `preset-${preset}-${details.scopes.length + 1}`, ...record });
  return { ...record, body };
}

function codexAppendRows(state) {
  state.cumulative.total += CODEX_DELTA;
  state.cumulative.input += 600;
  state.cumulative.cached += 100;
  state.cumulative.output += 300;
  state.cumulative.reasoning += 100;
  const timestamp = new Date(state.nextTimestampMs).toISOString();
  state.nextTimestampMs += 1_000;
  const last = {
    total_tokens: CODEX_DELTA,
    input_tokens: 600,
    cached_input_tokens: 100,
    output_tokens: 300,
    reasoning_output_tokens: 100,
  };
  const cumulative = Object.fromEntries(
    TOKEN_FIELDS.map((field) => [field === "cached" ? "cached_input_tokens" : `${field}_tokens`, state.cumulative[field]]),
  );
  return Buffer.from(
    `${JSON.stringify({
      type: "turn_context",
      payload: { model: "gpt-5.1-codex" },
    })}\n${JSON.stringify({
      timestamp,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: cumulative,
          last_token_usage: last,
        },
        rate_limits: {
          limit_id: "codex",
          credits: { has_credits: true },
          primary: {
            used_percent: 45,
            window_minutes: 300,
            resets_at: Math.floor((Date.now() + 5 * 60 * 60 * 1000) / 1000),
          },
        },
      },
    })}\n`,
    "utf8",
  );
}

function dshAppendFrame(state) {
  const row = {
    type: "assistant/message",
    seq: state.nextSequence,
    time: state.nextTimestampMs,
    data: {
      turn: state.turn,
      step: state.step,
      usage: {
        inputTokens: 700,
        cacheReadTokens: 100,
        cacheWriteTokens: 100,
        outputTokens: 1_000,
        totalTokens: DSH_DELTA,
      },
    },
  };
  state.nextSequence += 1;
  state.turn += 1;
  state.step += 1;
  state.nextTimestampMs += 1_000;
  return zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`, "utf8"));
}

async function appendAndPaint(page, prepared, scaleState, kind, mode, details, expectedTotal) {
  const target = prepared.selected[kind];
  const source = path.relative(prepared.home, target.targetPath);
  assert.ok(source && !source.startsWith("..") && !path.isAbsolute(source));
  const beforeSize = (await stat(target.targetPath)).size;
  const sseBefore = await page.evaluate(() => window.__e1Diagnostic.usageSynced);
  const pageBefore = await page.locator("#totalTokens").getAttribute("title");
  const totalBefore = Number(String(pageBefore).replace(/[^0-9]/g, ""));
  assert.equal(totalBefore, expectedTotal - (kind === "codex" ? CODEX_DELTA : DSH_DELTA));
  const appendBytes = kind === "codex" ? codexAppendRows(scaleState.codex) : dshAppendFrame(scaleState.dsh);
  if (mode === "sse-loss") {
    await page.evaluate(() => {
      window.__e1Diagnostic.sseDisabled = true;
      for (const eventSource of window.__e1Diagnostic.sources) eventSource.close();
    });
  }
  const started = performance.now();
  const startedAtMs = Date.now();
  if (mode === "sse-loss") {
    await appendFile(target.targetPath, appendBytes);
    const afterSize = (await stat(target.targetPath)).size;
    const record = {
      kind,
      mode,
      expectedTotal,
      totalBefore,
      sseBefore,
      bytesBefore: beforeSize,
      bytesAfter: afterSize,
      appendedBytes: appendBytes.length,
      inputGrowthBytes: afterSize - beforeSize,
      expectedProofBytesIfAppend: 2 * beforeSize + appendBytes.length,
      wallMs: performance.now() - started,
      startedAtMs,
      endedAtMs: Date.now(),
      awaitingPollingRecovery: true,
    };
    assert.equal(record.inputGrowthBytes, record.appendedBytes);
    details.appends.push(record);
    details.scopes.push({ name: `${kind}-${mode}-${details.appends.length}`, ...record });
    return record;
  }
  const responsePromise = page.waitForResponse(
    async (response) => {
      if (!usageResponseMatches(response, "all")) return false;
      try {
        const candidate = await response.json();
        return Number(candidate.summary?.totals?.total) === expectedTotal;
      } catch {
        return false;
      }
    },
    { timeout: WAIT_TIMEOUT_MS },
  );
  await appendFile(target.targetPath, appendBytes);
  const response = await responsePromise;
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  assert.equal(safeInteger(body.summary?.totals?.total, "append total"), expectedTotal);
  await painted(page, expectedTotal);
  const sseAfter = await page.evaluate(() => window.__e1Diagnostic.usageSynced);
  const afterSize = (await stat(target.targetPath)).size;
  const record = {
    kind,
    mode,
    expectedTotal,
    totalBefore,
    sseBefore,
    sseAfter,
    automaticSseObserved: sseAfter > sseBefore,
    bytesBefore: beforeSize,
    bytesAfter: afterSize,
    appendedBytes: appendBytes.length,
    inputGrowthBytes: afterSize - beforeSize,
    expectedProofBytesIfAppend: 2 * beforeSize + appendBytes.length,
    cache: response.headers()["x-summary-cache"] || null,
    responseEventCount: body.summary?.eventCount,
    wallMs: performance.now() - started,
    startedAtMs,
    endedAtMs: Date.now(),
  };
  assert.equal(record.inputGrowthBytes, record.appendedBytes);
  if (mode === "sse") {
    assert.equal(record.automaticSseObserved, true, `${kind} append did not arrive through page SSE`);
    assert.equal(record.cache, "miss", `${kind} append was hidden by a stale summary-cache hit`);
  }
  if (mode === "sse-loss") assert.equal(record.automaticSseObserved, false, "closed SSE unexpectedly notified the page");
  details.appends.push(record);
  details.scopes.push({ name: `${kind}-${mode}-${details.appends.length}`, ...record });
  return record;
}

async function toggleAutoRefresh(page, expectedEnabled) {
  const started = performance.now();
  const responsePromise = page.waitForResponse((response) => usageResponseMatches(response, "all"), {
    timeout: WAIT_TIMEOUT_MS,
  });
  await page.evaluate(() => document.querySelector("#autoRefreshToggle").click());
  const response = await responsePromise;
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  await painted(page, safeInteger(body.summary?.totals?.total, "toggle total"));
  assert.equal(
    await page.locator("#autoRefreshToggle").getAttribute("aria-pressed"),
    String(expectedEnabled),
  );
  return { body, wallMs: performance.now() - started };
}

async function waitForPollingRecovery(page, expectedTotal) {
  const started = performance.now();
  const startedAtMs = Date.now();
  const sseBefore = await page.evaluate(() => window.__e1Diagnostic.usageSynced);
  const response = await page.waitForResponse(
    async (candidate) => {
      if (!usageResponseMatches(candidate, "all")) return false;
      try {
        return Number((await candidate.json()).summary?.totals?.total) === expectedTotal;
      } catch {
        return false;
      }
    },
    { timeout: 180_000 },
  );
  const body = await response.json();
  assert.equal(response.status(), 200, JSON.stringify(body));
  assert.equal(safeInteger(body.summary?.totals?.total, "polling total"), expectedTotal);
  await painted(page, expectedTotal);
  const sseAfter = await page.evaluate(() => window.__e1Diagnostic.usageSynced);
  assert.equal(sseAfter, sseBefore, "polling recovery unexpectedly depended on SSE");
  return {
    wallMs: performance.now() - started,
    startedAtMs,
    endedAtMs: Date.now(),
    automaticSseObserved: false,
    total: expectedTotal,
    cache: response.headers()["x-summary-cache"] || null,
  };
}

function progressRows(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const columns = database
      .prepare("PRAGMA table_info(usage_source_progress)")
      .all()
      .map((row) => String(row.name));
    assert.ok(columns.includes("checkpoint_json"));
    const selected = ["source_path", "checkpoint_json", ...(columns.includes("validation_json") ? ["validation_json"] : [])];
    return database
      .prepare(`SELECT ${selected.map((column) => `"${column}"`).join(",")} FROM usage_source_progress ORDER BY source_path`)
      .all()
      .map((row) => ({
        sourcePath: String(row.source_path),
        checkpoint: JSON.parse(String(row.checkpoint_json)),
        validation: row.validation_json ? JSON.parse(String(row.validation_json)) : null,
      }));
  } finally {
    database.close();
  }
}

function sourceInventory(databaseFile) {
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const files = database
      .prepare("SELECT path, kind, home_id, home_path, size FROM source_files ORDER BY path")
      .all()
      .map((row) => ({ ...row }));
    const byKind = database
      .prepare(
        `SELECT CASE WHEN s.kind IN ('main','jetbrains','extra','codex') THEN 'codex' ELSE s.kind END AS kind,
                COUNT(e.id) AS events,
                COALESCE(SUM(e.total),0) AS total,
                COALESCE(SUM(e.input),0) AS input,
                COALESCE(SUM(e.cached),0) AS cached,
                COALESCE(SUM(e.output),0) AS output,
                COALESCE(SUM(e.reasoning),0) AS reasoning
           FROM source_files s JOIN events e ON e.source_path=s.path
          GROUP BY 1 ORDER BY 1`,
      )
      .all()
      .map((row) => ({
        kind: String(row.kind),
        events: Number(row.events),
        totals: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, Number(row[field])])),
      }));
    return { files, byKind };
  } finally {
    database.close();
  }
}

function compareInventory(inventory, dataset, home) {
  for (const row of inventory.files) {
    assert.ok(path.resolve(row.home_path).startsWith(path.resolve(home) + path.sep));
    assert.ok(!path.resolve(row.path).startsWith(path.resolve(dataset.root) + path.sep));
  }
  for (const expected of dataset.expected) {
    const observed = inventory.byKind.find((entry) => entry.kind === expected.kind);
    assert.ok(observed, `missing source kind ${expected.kind}`);
    assert.equal(observed.events, expected.events, `${expected.kind} event count`);
    for (const field of TOKEN_FIELDS) {
      assert.equal(observed.totals[field], expected[field], `${expected.kind} ${field}`);
    }
  }
}

async function openPage(url, scaleRoot, initializers = []) {
  assert.ok((await stat(PLAYWRIGHT_MODULE)).isFile(), `Playwright module not found: ${PLAYWRIGHT_MODULE}`);
  assert.ok((await stat(CHROMIUM_EXECUTABLE)).isFile(), `Chromium not found: ${CHROMIUM_EXECUTABLE}`);
  const { chromium } = await import(pathToFileURL(PLAYWRIGHT_MODULE).href);
  const browser = await chromium.launch({ headless: true, executablePath: CHROMIUM_EXECUTABLE });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(WAIT_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(WAIT_TIMEOUT_MS);
  await page.addInitScript(instrumentPage);
  for (const initialize of initializers) await page.addInitScript(initialize);
  const errors = [];
  const expectedSseAborts = [];
  page.on("pageerror", (error) => errors.push({ type: "pageerror", message: error.message }));
  page.on("requestfailed", async (request) => {
    const requestUrl = new URL(request.url());
    if (requestUrl.pathname === "/api/usage-events") {
      const evidence = await page.evaluate(() => ({
        closeCount: window.__e1Diagnostic.sseCloses.length,
        lastClose: window.__e1Diagnostic.sseCloses.at(-1) || null,
      }));
      if (evidence.closeCount > 0) {
        expectedSseAborts.push({
          type: "expected-sse-abort",
          url: requestUrl.pathname,
          failure: request.failure(),
          closeEvidence: evidence.lastClose,
        });
        return;
      }
    }
    errors.push({
      type: "requestfailed",
      url: requestUrl.pathname,
      failure: request.failure(),
    });
  });
  const started = performance.now();
  try {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#totalTokens[title]");
  await page.waitForFunction(() => !document.querySelector("#autoRefreshSpinner")?.classList.contains("is-loading"));
  const bootstrapMs = performance.now() - started;
  const all = await switchPreset(page, "all", { scopes: [] });
  await page.screenshot({ path: path.join(scaleRoot, "page-bootstrap.png"), fullPage: true });
  return { chromium, browser, context, page, errors, expectedSseAborts, bootstrapMs, all };
  } catch(error) {
    await browser.close();
    throw error;
  }
}

async function runScale(dataset, prepared, runRoot, result) {
  const scaleResult = {
    scale: dataset.scale,
    expectedInitialTotal: expectedDatasetTotal(dataset),
    expectedFinalTotal: expectedDatasetTotal(dataset) + 3 * CODEX_DELTA + 3 * DSH_DELTA + 2 * CODEX_DELTA,
    mirror: prepared.mirror,
    selected: Object.fromEntries(
      Object.entries(prepared.selected).map(([kind, value]) => [
        kind,
        {
          key: value.key,
          source: relativeToWorkspace(value.sourcePath),
          target: relativeToWorkspace(value.targetPath),
          bytes: value.sourceBytes,
          sha256: value.sourceSha256,
        },
      ]),
    ),
    scopes: [],
    appends: [],
    assertions: [],
  };
  result.scales.push(scaleResult);
  let server;
  let sampler;
  let browserState;
  try {
    server = await startServer(prepared, prepared.scaleRoot);
    scaleResult.server = {
      pid: server.ready.pid,
      gatewayHeapMb: NODE_GATEWAY_HEAP_MB,
      executorHeapMb: EXECUTOR_HEAP_MB,
      config: relativeToWorkspace(server.configFile),
    };
    sampler = await startSampler(prepared.scaleRoot, server.ready.pid);
    const scopeDetails = { scopes: scaleResult.scopes, appends: scaleResult.appends };
    browserState = await openPage(server.ready.url, prepared.scaleRoot);
    assert.equal(browserState.all.total, scaleResult.expectedInitialTotal);
    scaleResult.bootstrap = {
      wallMs: browserState.bootstrapMs,
      firstAllMs: browserState.all.wallMs,
      total: browserState.all.total,
      eventCount: browserState.all.eventCount,
      cache: browserState.all.cache,
      firstSourceVisit: true,
    };
    scaleResult.scopes.push({
      name: "bootstrap-full-source-landing",
      wallMs: browserState.bootstrapMs,
      startedAtMs: Date.now() - browserState.bootstrapMs,
      endedAtMs: Date.now(),
    });
    const initialInventory = sourceInventory(prepared.databaseFile);
    compareInventory(initialInventory, dataset, prepared.home);
    scaleResult.initialInventory = {
      sourceFiles: initialInventory.files.length,
      byKind: initialInventory.byKind,
    };
    log("bootstrap-complete", {
      scale: dataset.scale,
      wallMs: browserState.bootstrapMs,
      sourceFiles: initialInventory.files.length,
      total: browserState.all.total,
    });

    const scaleState = {
      codex: {
        cumulative: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, 0])),
        nextTimestampMs: Math.max(Date.now(), Date.parse(dataset.createdAt) + 100_000),
      },
      dsh: {
        nextSequence: Date.now() * 10,
        nextTimestampMs: Date.now() + 20_000,
        turn: 1,
        step: 1,
      },
    };

    let expected = scaleResult.expectedInitialTotal;
    for (let index = 1; index <= 3; index += 1) {
      expected += CODEX_DELTA;
      await appendAndPaint(
        browserState.page,
        prepared,
        scaleState,
        "codex",
        "sse",
        scopeDetails,
        expected,
      );
      if (index === 1) {
        scaleResult.scopes.push({
          name: "codex-first-refresh",
          ...scaleResult.appends.at(-1),
        });
      }
    }
    const today = await switchPreset(browserState.page, "today", scopeDetails);
    const week = await switchPreset(browserState.page, "week", scopeDetails);
    const allAgain = await switchPreset(browserState.page, "all", scopeDetails);
    assert.equal(allAgain.total, expected);
    scaleResult.presetChecks = { today, week, all: allAgain };

    for (let index = 1; index <= 3; index += 1) {
      expected += DSH_DELTA;
      await appendAndPaint(
        browserState.page,
        prepared,
        scaleState,
        "dsh",
        "sse",
        scopeDetails,
        expected,
      );
    }
    scaleResult.scopes.push({
      name: "dsh-revisit",
      ...scaleResult.appends.at(-1),
    });

    const lossRecoveryStart = Date.now();
    expected += CODEX_DELTA;
    await appendAndPaint(
      browserState.page,
      prepared,
      scaleState,
      "codex",
      "sse-loss",
      scopeDetails,
      expected,
    );
    const pollingResponse = await waitForPollingRecovery(browserState.page, expected);
    assert.ok(pollingResponse.wallMs < 180_000);
    scaleResult.sseLossRecovery = {
      ...pollingResponse,
      startedAtMs: lossRecoveryStart,
      endedAtMs: Date.now(),
      note: "The page EventSource was closed before the append; recovery came from the 60s status poll.",
    };
    scaleResult.scopes.push({ name: "sse-loss-poll-recovery", ...scaleResult.sseLossRecovery });

    const frozenBefore = await toggleAutoRefresh(browserState.page, false);
    assert.equal(frozenBefore.body.summary.totals.total, expected);
    const frozenStart = Date.now();
    const frozenAppend = codexAppendRows(scaleState.codex);
    const frozenFile = prepared.selected.codex.targetPath;
    await appendFile(frozenFile, frozenAppend);
    await sleep(1_500);
    assert.equal(
      Number((await browserState.page.locator("#totalTokens").getAttribute("title")).replace(/[^0-9]/g, "")),
      expected,
      "frozen page changed without an explicit reload",
    );
    const snapshotId = frozenBefore.body.snapshotId;
    assert.match(
      String(snapshotId),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const frozenSnapshotResponse = await fetch(
      `${server.ready.url}/api/usage?preset=all&bucket=day&calendarZone=local&snapshot=${snapshotId}`,
    );
    const frozenSnapshot = await frozenSnapshotResponse.json();
    assert.equal(frozenSnapshotResponse.status, 200, JSON.stringify(frozenSnapshot));
    assert.equal(frozenSnapshot.summary.totals.total, expected);
    expected += CODEX_DELTA;
    const frozenResume = await toggleAutoRefresh(browserState.page, true);
    assert.equal(frozenResume.body.summary.totals.total, expected);
    await painted(browserState.page, expected);
    scaleResult.frozen = {
      before: expected - CODEX_DELTA,
      heldAfterAppend: frozenSnapshot.summary.totals.total,
      resumed: frozenResume.body.summary.totals.total,
      snapshotId,
      wallMs: Date.now() - frozenStart,
    };
    scaleResult.scopes.push({
      name: "frozen-hold-and-resume",
      wallMs: Date.now() - frozenStart,
      startedAtMs: frozenStart,
      endedAtMs: Date.now(),
      totalBefore: expected - CODEX_DELTA,
      totalAfter: expected,
    });

    const finalPreset = await switchPreset(browserState.page, "all", scopeDetails);
    assert.equal(finalPreset.total, expected);
    await browserState.page.screenshot({ path: path.join(prepared.scaleRoot, "page-final.png"), fullPage: true });
    const progress = progressRows(prepared.databaseFile);
    const selectedProgress = await Promise.all(
      [prepared.selected.codex.targetPath, prepared.selected.dsh.targetPath].map(async (sourcePath) => {
        const row = progress.find((entry) => path.resolve(entry.sourcePath) === path.resolve(sourcePath));
        assert.ok(row, `missing progress checkpoint for ${sourcePath}`);
        const finalSourceSize = (await stat(sourcePath)).size;
        assert.equal(row.checkpoint.offset, finalSourceSize, "progress must end at the actual file EOF");
        assert.equal(row.validation?.kind, "sha256-prefix-v1", "E: synthetic journal must use SHA fallback");
        assert.equal(typeof row.validation?.identity, "string", "SHA checkpoint must carry a physical identity");
        assert.ok(Number.isFinite(row.validation?.ctimeMs), "SHA checkpoint must carry ctimeMs");
        return {
          source: relativeToWorkspace(sourcePath),
          adapter: row.checkpoint.adapter,
          offset: row.checkpoint.offset,
          lineNumber: row.checkpoint.lineNumber,
          validationKind: row.validation.kind,
        };
      }),
    );
    for (const item of selectedProgress) {
      const entry = scaleResult.appends.find((append) =>
        append.kind === (item.adapter === "dsh-v4-zstd" ? "dsh" : "codex"),
      );
      assert.ok(entry);
    }
    scaleResult.progress = selectedProgress;
    scaleResult.finalPage = {
      total: finalPreset.total,
      eventCount: finalPreset.body.summary.eventCount,
      cache: finalPreset.cache,
      fingerprint: finalPreset.body.fingerprint,
    };
    scaleResult.shaFallback = {
      platform: process.platform,
      journalInactiveReason: "The synthetic E: source is not registered as an active USN writer.",
      validationKinds: selectedProgress.map((entry) => entry.validationKind),
      expectedProofBytesIfAppendTotal: scaleResult.appends.reduce(
        (sum, append) => sum + append.expectedProofBytesIfAppend,
        0,
      ),
      note:
        "The expected proof-byte formula is 2 * old prefix + suffix. It is not observed parser input or physical I/O.",
    };
    scaleResult.cachePreparation = {
      initialAllCache: browserState.all.cache,
      refreshCaches: scaleResult.appends.map((append) => ({
        kind: append.kind,
        mode: append.mode,
        cache: append.cache || null,
      })),
      firstChangedSourceCache: scaleResult.appends.find((append) => append.mode === "sse")?.cache || null,
      persistentSummaryRebuiltOnFirstPhysicalSignature: scaleResult.appends.find(
        (append) => append.mode === "sse",
      )?.cache === "miss",
    };
    assert.equal(
      scaleResult.cachePreparation.persistentSummaryRebuiltOnFirstPhysicalSignature,
      true,
      "first physical source-signature change must rebuild the persistent summary",
    );
    await sleep(500);
    scaleResult.sseLifecycle = {
      explicitClosures: await browserState.page.evaluate(() => window.__e1Diagnostic.sseCloses),
      correctlyClassifiedAborts: browserState.expectedSseAborts,
    };
    assert.ok(scaleResult.sseLifecycle.explicitClosures.length > 0);
    assert.deepEqual(browserState.errors, []);
    scaleResult.assertions.push(
      "initial source inventory and all token fields equal dataset",
      "six automatic appends were observed through the page SSE path",
      "today/week/all page values painted after API response",
      "closed-SSE append recovered through the 60-second poll",
      "auto-off/frozen page stayed unchanged until explicit resume",
      "selected progress uses verified SHA checkpoints at EOF",
    );
    await stopServer(server, scaleResult);
    server = null;
    await browserState.browser.close();
    browserState = null;
    const resources = await stopSampler(sampler, prepared.scaleRoot);
    sampler = null;
    scaleResult.resources = summarizeResources(resources, scaleResult.scopes);
    assert.equal(scaleResult.resources.servicePeakProcessCount >= 1, true);
    assert.ok(scaleResult.resources.samples > 0);

    const oracle = await runOracle(dataset, prepared);
    scaleResult.oracle = oracle;
    assert.equal(oracle.summary.totals.total, scaleResult.finalPage.total);
    assert.equal(oracle.summary.eventCount, scaleResult.finalPage.eventCount);
    scaleResult.oracleParity = compareFacts(prepared.databaseFile, prepared.oracleDatabaseFile);
    assert.equal(scaleResult.oracleParity.eventsDifference, 0);
    assert.equal(scaleResult.oracleParity.rateLimitDifference, 0);
    assert.equal(scaleResult.oracleParity.quotaSourceDifference, 0);
  } finally {
    if (browserState) await browserState.browser.close().catch(() => {});
    if (server) {
      try {
        await stopServer(server, scaleResult);
      } catch (error) {
        scaleResult.cleanupFailure = error.stack;
      }
    }
    if (sampler) {
      try {
        const resources = await stopSampler(sampler, prepared.scaleRoot);
        scaleResult.resources ||= summarizeResources(resources, scaleResult.scopes);
      } catch (error) {
        scaleResult.cleanupFailure = error.stack;
      }
    }
  }
  await assertNoResidualProcesses(scaleResult);
  const verified = [];
  for (const kind of ["codex", "dsh"]) {
    const selected = prepared.selected[kind];
    const before = selected.originalInfo;
    const after = await stat(selected.sourcePath);
    assert.equal(after.size, before.size, `${dataset.scale}x frozen ${kind} source size changed`);
    assert.equal(after.mtimeMs, before.mtimeMs, `${dataset.scale}x frozen ${kind} source mtime changed`);
    const afterHash = await hashFile(selected.sourcePath);
    assert.equal(afterHash.sha256, selected.sourceSha256, `${dataset.scale}x frozen ${kind} source hash changed`);
    verified.push({ kind, sha256: afterHash.sha256, bytes: afterHash.bytes });
  }
  scaleResult.frozenSourceIntegrity = verified;
  assert.equal(scaleResult.oracleParity?.allEqual, true);
}

async function runContinuationScale(dataset, prepared, existingScaleRoot, continuationRoot, result) {
  const reusedInitialTotal =
    expectedDatasetTotal(dataset) + 3 * CODEX_DELTA + 3 * DSH_DELTA + CODEX_DELTA;
  const reusedInitialEvents = expectedDatasetEvents(dataset) + 7;
  const finalExpectedTotal = reusedInitialTotal + 2 * CODEX_DELTA;
  const finalExpectedEvents = reusedInitialEvents + 2;
  const scaleResult = {
    scale: dataset.scale,
    mode: "continuation",
    reusedFrom: relativeToWorkspace(existingScaleRoot),
    reusedInitialTotal,
    reusedInitialEvents,
    expectedFinalTotal: finalExpectedTotal,
    expectedFinalEvents: finalExpectedEvents,
    scopes: [],
    appends: [],
    assertions: [],
  };
  result.scales.push(scaleResult);
  const oraclePrepared = {
    ...prepared,
    oracleDatabaseFile: path.join(continuationRoot, "oracle", "usage-index.sqlite"),
  };
  const savedCodexProgress = progressRows(prepared.databaseFile).find(
    (entry) => path.resolve(entry.sourcePath) === path.resolve(prepared.selected.codex.targetPath),
  );
  const savedCodexCumulative = savedCodexProgress?.checkpoint?.state?.previousCumulative;
  assert.ok(savedCodexCumulative, "continuation requires saved Codex cumulative state");
  for (const field of TOKEN_FIELDS) {
    assert.ok(Number.isSafeInteger(savedCodexCumulative[field]) && savedCodexCumulative[field] >= 0);
  }
  let server;
  let sampler;
  let browserState;
  try {
    server = await startServer(prepared, continuationRoot);
    scaleResult.server = {
      pid: server.ready.pid,
      gatewayHeapMb: NODE_GATEWAY_HEAP_MB,
      executorHeapMb: EXECUTOR_HEAP_MB,
      config: relativeToWorkspace(server.configFile),
    };
    sampler = await startSampler(continuationRoot, server.ready.pid);
    const scopeDetails = { scopes: scaleResult.scopes, appends: scaleResult.appends };
    browserState = await openPage(server.ready.url, continuationRoot);
    assert.equal(browserState.all.total, reusedInitialTotal, "reused page total");
    assert.equal(browserState.all.eventCount, reusedInitialEvents, "reused page event count");
    scaleResult.reusedPageOpen = {
      wallMs: browserState.bootstrapMs,
      firstAllMs: browserState.all.wallMs,
      total: browserState.all.total,
      eventCount: browserState.all.eventCount,
      cache: browserState.all.cache,
    };
    scaleResult.scopes.push({
      name: "reused-home-page-open",
      wallMs: browserState.bootstrapMs,
      startedAtMs: Date.now() - browserState.bootstrapMs,
      endedAtMs: Date.now(),
      total: browserState.all.total,
      eventCount: browserState.all.eventCount,
      cache: browserState.all.cache,
    });
    log("continuation-page-open", scaleResult.reusedPageOpen);

    const scaleState = {
      codex: {
        cumulative: Object.fromEntries(TOKEN_FIELDS.map((field) => [field, savedCodexCumulative[field]])),
        nextTimestampMs: Math.max(Date.now(), Date.parse(dataset.createdAt) + 200_000),
      },
      dsh: {
        nextSequence: Date.now() * 10,
        nextTimestampMs: Date.now() + 20_000,
        turn: 1,
        step: 1,
      },
    };
    let expected = reusedInitialTotal;

    const lossRecoveryStart = Date.now();
    expected += CODEX_DELTA;
    await appendAndPaint(
      browserState.page,
      prepared,
      scaleState,
      "codex",
      "sse-loss",
      scopeDetails,
      expected,
    );
    const pollingResponse = await waitForPollingRecovery(browserState.page, expected);
    assert.ok(pollingResponse.wallMs < 180_000);
    scaleResult.sseLossRecovery = {
      ...pollingResponse,
      startedAtMs: lossRecoveryStart,
      endedAtMs: Date.now(),
      note: "The page EventSource was closed before the append; recovery came from the 60s status poll.",
    };
    scaleResult.scopes.push({ name: "sse-loss-poll-recovery", ...scaleResult.sseLossRecovery });

    const frozenBefore = await toggleAutoRefresh(browserState.page, false);
    assert.equal(frozenBefore.body.summary.totals.total, expected);
    const frozenStart = Date.now();
    const frozenAppend = codexAppendRows(scaleState.codex);
    await appendFile(prepared.selected.codex.targetPath, frozenAppend);
    await sleep(1_500);
    assert.equal(
      Number((await browserState.page.locator("#totalTokens").getAttribute("title")).replace(/[^0-9]/g, "")),
      expected,
      "frozen page changed without an explicit reload",
    );
    const snapshotId = frozenBefore.body.snapshotId;
    assert.match(
      String(snapshotId),
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const frozenSnapshotResponse = await fetch(
      `${server.ready.url}/api/usage?preset=all&bucket=day&calendarZone=local&snapshot=${snapshotId}`,
    );
    const frozenSnapshot = await frozenSnapshotResponse.json();
    assert.equal(frozenSnapshotResponse.status, 200, JSON.stringify(frozenSnapshot));
    assert.equal(frozenSnapshot.summary.totals.total, expected);
    expected += CODEX_DELTA;
    const frozenResume = await toggleAutoRefresh(browserState.page, true);
    assert.equal(frozenResume.body.summary.totals.total, expected);
    await painted(browserState.page, expected);
    scaleResult.frozen = {
      before: expected - CODEX_DELTA,
      heldAfterAppend: frozenSnapshot.summary.totals.total,
      resumed: frozenResume.body.summary.totals.total,
      snapshotId,
      wallMs: Date.now() - frozenStart,
    };
    scaleResult.scopes.push({
      name: "frozen-hold-and-resume",
      wallMs: Date.now() - frozenStart,
      startedAtMs: frozenStart,
      endedAtMs: Date.now(),
      totalBefore: expected - CODEX_DELTA,
      totalAfter: expected,
    });

    const finalPreset = await switchPreset(browserState.page, "all", scopeDetails);
    assert.equal(finalPreset.total, expected);
    assert.equal(finalPreset.body.summary.eventCount, finalExpectedEvents);
    await browserState.page.screenshot({ path: path.join(continuationRoot, "page-final.png"), fullPage: true });
    const progress = progressRows(prepared.databaseFile);
    const selectedProgress = await Promise.all(
      [prepared.selected.codex.targetPath, prepared.selected.dsh.targetPath].map(async (sourcePath) => {
        const row = progress.find((entry) => path.resolve(entry.sourcePath) === path.resolve(sourcePath));
        assert.ok(row, `missing progress checkpoint for ${sourcePath}`);
        const finalSourceSize = (await stat(sourcePath)).size;
        assert.equal(row.checkpoint.offset, finalSourceSize, "progress must end at the actual file EOF");
        assert.equal(row.validation?.kind, "sha256-prefix-v1", "E: synthetic journal must use SHA fallback");
        assert.equal(typeof row.validation?.identity, "string", "SHA checkpoint must carry a physical identity");
        assert.ok(Number.isFinite(row.validation?.ctimeMs), "SHA checkpoint must carry ctimeMs");
        return {
          source: relativeToWorkspace(sourcePath),
          adapter: row.checkpoint.adapter,
          offset: row.checkpoint.offset,
          lineNumber: row.checkpoint.lineNumber,
          validationKind: row.validation.kind,
        };
      }),
    );
    scaleResult.progress = selectedProgress;
    scaleResult.finalPage = {
      total: finalPreset.total,
      eventCount: finalPreset.body.summary.eventCount,
      cache: finalPreset.cache,
      fingerprint: finalPreset.body.fingerprint,
    };
    scaleResult.shaFallback = {
      platform: process.platform,
      journalInactiveReason: "The synthetic E: source is not registered as an active USN writer.",
      validationKinds: selectedProgress.map((entry) => entry.validationKind),
      expectedProofBytesIfAppendTotal: scaleResult.appends.reduce(
        (sum, append) => sum + append.expectedProofBytesIfAppend,
        0,
      ),
      note:
        "The expected proof-byte formula is 2 * old prefix + suffix. It is not observed parser input or physical I/O.",
    };
    scaleResult.cachePreparation = {
      reusedHomeOpenCache: browserState.all.cache,
      refreshCaches: scaleResult.appends.map((append) => ({
        kind: append.kind,
        mode: append.mode,
        cache: append.cache || null,
      })),
    };
    await sleep(500);
    scaleResult.sseLifecycle = {
      explicitClosures: await browserState.page.evaluate(() => window.__e1Diagnostic.sseCloses),
      correctlyClassifiedAborts: browserState.expectedSseAborts,
    };
    assert.ok(scaleResult.sseLifecycle.explicitClosures.length > 0);
    assert.deepEqual(browserState.errors, []);
    scaleResult.assertions.push(
      "reused-home page open matched the prior 10x total and event count",
      "closed-SSE append recovered through the 60-second poll with the exact expected total",
      "auto-off/frozen page stayed unchanged until explicit resume",
      "selected progress uses verified SHA checkpoints at EOF",
    );

    await stopServer(server, scaleResult);
    server = null;
    await browserState.browser.close();
    browserState = null;
    const resources = await stopSampler(sampler, continuationRoot);
    sampler = null;
    scaleResult.resources = summarizeResources(resources, scaleResult.scopes);
    assert.equal(scaleResult.resources.servicePeakProcessCount >= 1, true);
    assert.ok(scaleResult.resources.samples > 0);

    const oracle = await runOracle(dataset, oraclePrepared);
    scaleResult.oracle = oracle;
    assert.equal(oracle.summary.totals.total, scaleResult.finalPage.total);
    assert.equal(oracle.summary.eventCount, scaleResult.finalPage.eventCount);
    scaleResult.oracleParity = compareFacts(prepared.databaseFile, oraclePrepared.oracleDatabaseFile);
    assert.equal(scaleResult.oracleParity.eventsDifference, 0);
    assert.equal(scaleResult.oracleParity.rateLimitDifference, 0);
    assert.equal(scaleResult.oracleParity.quotaSourceDifference, 0);
  } finally {
    if (browserState) await browserState.browser.close().catch(() => {});
    if (server) {
      try {
        await stopServer(server, scaleResult);
      } catch (error) {
        scaleResult.cleanupFailure = error.stack;
      }
    }
    if (sampler) {
      try {
        const resources = await stopSampler(sampler, continuationRoot);
        scaleResult.resources ||= summarizeResources(resources, scaleResult.scopes);
      } catch (error) {
        scaleResult.cleanupFailure = error.stack;
      }
    }
  }
  await assertNoResidualProcesses(scaleResult);
  const verified = [];
  for (const kind of ["codex", "dsh"]) {
    const selected = prepared.selected[kind];
    const before = selected.originalInfo;
    const after = await stat(selected.sourcePath);
    assert.equal(after.size, before.size, `10x frozen ${kind} source size changed`);
    assert.equal(after.mtimeMs, before.mtimeMs, `10x frozen ${kind} source mtime changed`);
    const afterHash = await hashFile(selected.sourcePath);
    assert.equal(afterHash.sha256, selected.sourceSha256, `10x frozen ${kind} source hash changed`);
    verified.push({ kind, sha256: afterHash.sha256, bytes: afterHash.bytes });
  }
  scaleResult.frozenSourceIntegrity = verified;
  assert.equal(scaleResult.oracleParity?.allEqual, true);
}

function sumRows(rows, field) {
  return rows.reduce((sum, row) => sum + Number(row[field] || 0), 0);
}

function summarizeResources(resources, scopes) {
  const samples = resources.samples;
  const scopeSummaries = scopes.map((scope) => {
    const start = Number(scope.startedAtMs);
    const end = Number(scope.endedAtMs);
    const windowSamples = samples.filter((sample) => sample.atUnixMs >= start && sample.atUnixMs <= end);
    const serviceRows = windowSamples.flatMap((sample) =>
      (sample.processes || []).filter((row) => row.role === "service"),
    );
    const helperNames = [...new Set(serviceRows.map((row) => row.name))].sort();
    const perSampleService = windowSamples.map((sample) => ({
      cpuSeconds: sumRows((sample.processes || []).filter((row) => row.role === "service"), "cpuSeconds"),
      rssBytes: sumRows((sample.processes || []).filter((row) => row.role === "service"), "workingSetBytes"),
      readBytes: sumRows((sample.processes || []).filter((row) => row.role === "service"), "logicalReadBytes"),
      writeBytes: sumRows((sample.processes || []).filter((row) => row.role === "service"), "logicalWriteBytes"),
      processCount: (sample.processes || []).filter((row) => row.role === "service").length,
    }));
    return {
      name: scope.name,
      wallMs: Number.isFinite(scope.wallMs) ? scope.wallMs : end - start,
      samples: windowSamples.length,
      serviceProcessCountPeak: perSampleService.reduce((max, row) => Math.max(max, row.processCount), 0),
      serviceRssBytesPeak: perSampleService.reduce((max, row) => Math.max(max, row.rssBytes), 0),
      serviceCpuSecondsPeak: perSampleService.reduce((max, row) => Math.max(max, row.cpuSeconds), 0),
      serviceLogicalReadBytesPeak: perSampleService.reduce((max, row) => Math.max(max, row.readBytes), 0),
      serviceLogicalWriteBytesPeak: perSampleService.reduce((max, row) => Math.max(max, row.writeBytes), 0),
      serviceProcessNames: helperNames,
    };
  });
  const processRows = resources.processes || [];
  return {
    samples: resources.sampleCount,
    metricDefinitions: resources.metricDefinitions,
    overall: {
      service: resources.service,
      browser: resources.browser,
      runner: resources.runner,
      observer: resources.observer,
      sqlite: resources.sqlite,
    },
    servicePeakProcessCount: resources.service?.peakSampledProcessCount || 0,
    servicePeakRssBytes: resources.service?.peakSampledWorkingSetBytes || 0,
    serviceHelperProcesses: processRows.filter((row) => row.role === "service").map((row) => ({
      pid: row.pid,
      name: row.name,
      parentPid: row.parentPid,
      startTimeUtcTicks: row.startTimeUtcTicks,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      peakWorkingSetBytes: row.peakWorkingSetBytes,
      cpuSeconds: row.peakCpuSeconds,
      logicalReadBytes: row.maxLogicalReadBytes,
      logicalWriteBytes: row.maxLogicalWriteBytes,
    })),
    scopeSummaries,
  };
}

async function queryProcessInstances(pids) {
  if (pids.length === 0) return [];
  const idList = pids.map((pid) => Number(pid)).join(",");
  const command = [
    `$ids = @(${idList})`,
    "$rows = foreach ($id in $ids) {",
    "$process = Get-Process -Id $id -ErrorAction SilentlyContinue",
    "if ($null -eq $process) { continue }",
    "try { $startTicks = [long]$process.StartTime.ToUniversalTime().Ticks } catch { continue }",
    "[pscustomobject]@{ pid = [int]$id; name = [string]$process.ProcessName; startTimeUtcTicks = $startTicks }",
    "}",
    "ConvertTo-Json -InputObject @($rows) -Compress",
  ].join("; ");
  const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command], {
    cwd: WORKSPACE_ROOT,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.equal(exit.code, 0, `process-instance query failed: ${stderr}`);
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function selfCheckResourceSummary(scaleRoot, expectedServiceProcessPeak) {
  const rawSummary = JSON.parse(await readFile(path.join(scaleRoot, "resource-summary.json"), "utf8"));
  const samples = (await readFile(path.join(scaleRoot, "resource-samples.ndjson"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const rawServiceProcessPeak = samples.reduce(
    (maximum, sample) =>
      Math.max(maximum, (sample.processes || []).filter((row) => row.role === "service").length),
    0,
  );
  const summary = summarizeResources({ ...rawSummary, samples }, []);
  assert.equal(rawServiceProcessPeak, expectedServiceProcessPeak);
  assert.equal(summary.servicePeakProcessCount, rawServiceProcessPeak);
  assert.equal(summary.samples, rawSummary.sampleCount);
  assert.ok(summary.servicePeakRssBytes > 0);
  assert.ok(summary.serviceHelperProcesses.some((row) => row.name === "node.exe"));
  log("resource-summary-self-check", {
    scaleRoot,
    samples: summary.samples,
    servicePeakProcessCount: summary.servicePeakProcessCount,
    servicePeakRssBytes: summary.servicePeakRssBytes,
  });
  return summary;
}

async function selfCheckResidualProcesses(scaleRoot) {
  const rawSummary = JSON.parse(await readFile(path.join(scaleRoot, "resource-summary.json"), "utf8"));
  const samples = (await readFile(path.join(scaleRoot, "resource-samples.ndjson"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const rows = (rawSummary.processes || [])
    .filter((row) => row.role === "service")
    .map((row) => {
      const observed = samples
        .flatMap((sample) => sample.processes || [])
        .find((candidate) => candidate.pid === row.pid && Number(candidate.startTimeUtcTicks) > 0);
      return { ...row, startTimeUtcTicks: observed?.startTimeUtcTicks };
    });
  const result = { resources: { serviceHelperProcesses: rows } };
  await assertNoResidualProcesses(result);
  log("residual-self-check", {
    scaleRoot,
    checkedPids: result.residualCheck.checkedPids.length,
    residual: result.residualCheck.residual,
    pidReuse: result.residualCheck.pidReuse,
  });
}

async function selfCheckOracleDatabase(databaseFile, expectedTotal, expectedEventCount) {
  const executor = createUsageExecutor({ databaseFile });
  try {
    await executor.open();
    const dashboard = await executor.dashboard(
      { preset: "all", bucket: "day", calendarZone: "local", now: TODAY },
      { includeDetails: false },
    );
    assert.equal(dashboard.summary.totals.total, expectedTotal);
    assert.equal(dashboard.summary.eventCount, expectedEventCount);
    log("oracle-self-check", {
      databaseFile,
      total: dashboard.summary.totals.total,
      eventCount: dashboard.summary.eventCount,
    });
  } finally {
    await executor.close();
  }
}

function tableColumns(database, schema, table) {
  return database
    .prepare(`PRAGMA ${schema}.table_info("${table}")`)
    .all()
    .map((row) => String(row.name));
}

function compareTable(database, table, excluded = []) {
  const columns = tableColumns(database, "main", table);
  const selected = columns.filter((column) => !excluded.includes(column));
  assert.ok(selected.length > 0);
  const quoted = selected.map((column) => `"${column.replaceAll('"', '""')}"`).join(",");
  const row = database
    .prepare(
      `SELECT COUNT(*) AS differences FROM (
         SELECT ${quoted}, SUM(sign) AS balance
         FROM (
           SELECT ${quoted}, 1 AS sign FROM live."${table}"
           UNION ALL
           SELECT ${quoted}, -1 AS sign FROM main."${table}"
         )
         GROUP BY ${quoted}
         HAVING SUM(sign) <> 0
       )`,
    )
    .get();
  return Number(row.differences);
}

function compareFacts(liveDatabaseFile, oracleDatabaseFile) {
  const database = new DatabaseSync(oracleDatabaseFile, { readOnly: true });
  try {
    database.prepare("ATTACH DATABASE ? AS live").run(liveDatabaseFile);
    const eventsDifference = compareTable(database, "events", ["id"]);
    const rateLimitDifference = compareTable(database, "rate_limit_observations");
    const quotaSourceDifference = compareTable(database, "quota_usage_sources");
    return {
      eventsDifference,
      rateLimitDifference,
      quotaSourceDifference,
      allEqual: eventsDifference === 0 && rateLimitDifference === 0 && quotaSourceDifference === 0,
      excludedEventColumns: ["id"],
    };
  } finally {
    database.close();
  }
}

async function runOracle(dataset, prepared) {
  await mkdir(path.dirname(prepared.oracleDatabaseFile), { recursive: true });
  await rm(prepared.oracleDatabaseFile, { force: true });
  await rm(`${prepared.oracleDatabaseFile}-wal`, { force: true });
  await rm(`${prepared.oracleDatabaseFile}-shm`, { force: true });
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  const options = {
    ...serverOptions(prepared),
    databaseFile: prepared.oracleDatabaseFile,
  };
  const executor = createUsageExecutor(options);
  let status;
  let dashboard;
  try {
    status = await executor.sync({ options });
    dashboard = await executor.dashboard(
      { preset: "all", bucket: "day", calendarZone: "local", now: TODAY },
      { includeDetails: false },
    );
  } finally {
    await executor.close();
  }
  const cpu = process.cpuUsage(cpuStarted);
  const database = new DatabaseSync(prepared.oracleDatabaseFile, { readOnly: true });
  let sourceFiles;
  try {
    sourceFiles = database.prepare("SELECT COUNT(*) AS count FROM source_files").get().count;
  } finally {
    database.close();
  }
  return {
    wallMs: performance.now() - started,
    cpuSeconds: (cpu.user + cpu.system) / 1_000_000,
    status,
    summary: dashboard.summary,
    sourceFiles,
    datasetScale: dataset.scale,
  };
}

async function assertNoResidualProcesses(scaleResult) {
  const rows = scaleResult.resources?.serviceHelperProcesses || [];
  const started = performance.now();
  let remaining = rows;
  const pidReuse = [];
  while (remaining.length > 0 && performance.now() - started < 5_000) {
    await sleep(100);
    const active = await queryProcessInstances(remaining.map((row) => row.pid));
    const activeByPid = new Map(active.map((row) => [Number(row.pid), row]));
    const candidates = remaining;
    remaining = [];
    for (const row of candidates) {
      const current = activeByPid.get(Number(row.pid));
      if (!current) continue;
      assert.ok(
        Number(row.startTimeUtcTicks) > 0,
        `missing creation identity for service-tree process ${row.pid} (${row.name})`,
      );
      if (Number(current.startTimeUtcTicks) !== Number(row.startTimeUtcTicks)) {
        pidReuse.push({
          pid: row.pid,
          expectedStartTimeUtcTicks: row.startTimeUtcTicks,
          observedStartTimeUtcTicks: current.startTimeUtcTicks,
        });
        continue;
      }
      remaining.push(row);
    }
  }
  assert.equal(
    remaining.length,
    0,
    `service-tree processes still alive after shutdown: ${remaining.map((row) => `${row.pid}:${row.name}`).join(",")}`,
  );
  scaleResult.residualCheck = {
    checkedPids: rows.map((row) => row.pid),
    residual: 0,
    graceMs: Math.round(performance.now() - started),
    pidReuse,
  };
}

async function runDiagnostic() {
  const startedAt = new Date().toISOString();
  const totalStarted = performance.now();
  await mkdir(B2_ROOT, { recursive: true });
  const outIndex = process.argv.indexOf("--out");
  const outputRoot =
    outIndex >= 0 && process.argv[outIndex + 1] ? path.resolve(process.argv[outIndex + 1]) : DEFAULT_OUTPUT_ROOT;
  const scalesIndex = process.argv.indexOf("--scales");
  const scales =
    scalesIndex >= 0 && process.argv[scalesIndex + 1]
      ? process.argv[scalesIndex + 1].split(",").filter(Boolean)
      : DEFAULT_SCALES;
  assert.ok(scales.length > 0 && scales.every((scale) => DEFAULT_SCALES.includes(scale)), "invalid --scales value");
  assert.equal(new Set(scales).size, scales.length);
  const formal = process.argv.includes("--formal");
  if (formal) assert.equal(process.env.E1_NOTIFICATION_STABLE, "1", "formal timing requires stable notifications");
  assert.ok(
    path.resolve(outputRoot).startsWith(`${path.resolve(B2_ROOT)}${path.sep}page-`),
    "diagnostic output must remain under b2/page-*",
  );
  await stat(outputRoot)
    .then(() => {
      throw new Error(`diagnostic output already exists; choose a new page-* label: ${outputRoot}`);
    })
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  await mkdir(outputRoot, { recursive: true });
  const disk = await assertDiskSpace(outputRoot);
  const sourceSnapshotBefore = await productionSourceSnapshot();
  const result = {
    schemaVersion: "b2-page-diagnostic.v1",
    passed: false,
    mode: formal ? "formal" : "smoke",
    productionState: process.env.E1_PRODUCTION_STATE || (formal ? "notification-stable" : "unlabeled-smoke"),
    sourceSnapshot: {
      before: sourceSnapshotBefore,
      after: null,
    },
    startedAt,
    outputRoot,
    scope: "1x/10x small-sample source-to-page correctness diagnostic; not p95 and not B3/C",
    measurementSemantics: {
      appendInputGrowthBytes: "Post-append file size minus pre-append file size; not observed parser read bytes.",
      expectedProofBytesIfAppend:
        "The SHA-fallback proof contract 2 * old prefix + appended suffix; not observed parser input or physical I/O.",
      refreshLatency: "Original-page wall time from file append through exact API total and painted value, not executor sync time.",
      sourceWork: "Observed by G1; E1 reports page wall time plus OS service-tree CPU and logical I/O.",
      sampledResourceTree:
        "Service metrics are sampled at 1s and include the gateway, executor, proof helper, and their conhost processes; browser, runner, and observer are separate scopes.",
      sampledSqliteMetric:
        "The resource sampler's sqliteFiles field scans <scaleRoot>/state only. Zero there is not .codex-usage disk usage, and this diagnostic does not claim a disk-capacity peak.",
    },
    limits: {
      gatewayHeapMb: NODE_GATEWAY_HEAP_MB,
      executorHeapMb: EXECUTOR_HEAP_MB,
      automaticDiscoveryEnabled: false,
      pricingRefreshSchedulerEnabled: false,
      realSourcesOrDatabasesTouched: false,
      userServiceTouched: false,
    },
    disk,
    scales: [],
  };
  try {
    for (const scale of scales) {
      const scaleRoot = path.join(BASELINE_ROOT, scale);
      const datasetFile = path.join(scaleRoot, "dataset.json");
      const datasetHashBefore = await hashFile(datasetFile);
      const dataset = JSON.parse(await readFile(datasetFile, "utf8"));
      assert.equal(dataset.scale, Number(scale.slice(0, -1)));
      const prepared = await prepareScale(dataset, outputRoot, path.join(scaleRoot, "seed-empty"));
      log("mirror-complete", {
        scale,
        files: prepared.mirror.files,
        bytes: prepared.mirror.bytes,
        hardlinks: prepared.mirror.hardlinks,
        independentUsageCopies: prepared.mirror.independentUsageCopies,
        independentConfigCopies: prepared.mirror.independentConfigCopies,
      });
      await runScale(dataset, prepared, outputRoot, result);
      const datasetHashAfter = await hashFile(datasetFile);
      assert.deepEqual(datasetHashAfter, datasetHashBefore, `${scale} frozen dataset.json changed`);
      result.scales.at(-1).datasetIntegrity = {
        before: datasetHashBefore,
        after: datasetHashAfter,
      };
      log("scale-complete", {
        scale,
        bootstrapMs: result.scales.at(-1).bootstrap.wallMs,
        finalTotal: result.scales.at(-1).finalPage.total,
        oracleMs: result.scales.at(-1).oracle.wallMs,
      });
    }
    result.sourceSnapshot.after = await productionSourceSnapshot();
    assert.deepEqual(result.sourceSnapshot.after.files, result.sourceSnapshot.before.files);
    result.passed = true;
  } catch (error) {
    result.failure = {
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
    };
    throw error;
  } finally {
    result.finishedAt = new Date().toISOString();
    result.elapsedMs = performance.now() - totalStarted;
    await writeFile(path.join(outputRoot, "page-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

async function runContinuationDiagnostic(existingScaleRoot) {
  const startedAt = new Date().toISOString();
  const totalStarted = performance.now();
  await mkdir(B2_ROOT, { recursive: true });
  const outIndex = process.argv.indexOf("--out");
  assert.ok(outIndex >= 0 && process.argv[outIndex + 1], "continuation requires --out");
  const outputRoot = path.resolve(process.argv[outIndex + 1]);
  const formal = process.argv.includes("--formal");
  if (formal) assert.equal(process.env.E1_NOTIFICATION_STABLE, "1", "formal timing requires stable notifications");
  assert.ok(
    outputRoot.startsWith(`${path.resolve(B2_ROOT)}${path.sep}page-`),
    "diagnostic output must remain under b2/page-*",
  );
  assert.notEqual(outputRoot, path.resolve(existingScaleRoot), "continuation output must be a new label");
  await stat(outputRoot)
    .then(() => {
      throw new Error(`diagnostic output already exists; choose a new page-* label: ${outputRoot}`);
    })
    .catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  const existingResultFile = path.join(path.dirname(path.resolve(existingScaleRoot)), "page-result.json");
  const existingResult = JSON.parse(await readFile(existingResultFile, "utf8"));
  const existingScale = existingResult.scales?.find((entry) => entry.scale === 10);
  assert.ok(existingScale, "continuation source result has no 10x scale");
  assert.equal(existingScale.appends?.length, 7, "continuation requires the preserved seven-append 10x state");

  const datasetFile = path.join(BASELINE_ROOT, "10x", "dataset.json");
  const datasetHashBefore = await hashFile(datasetFile);
  const dataset = JSON.parse(await readFile(datasetFile, "utf8"));
  assert.equal(dataset.scale, 10);
  const prepared = await loadExistingScale(dataset, path.resolve(existingScaleRoot));
  await mkdir(outputRoot, { recursive: true });
  const disk = await assertDiskSpace(outputRoot);
  const sourceSnapshotBefore = await productionSourceSnapshot();
  const result = {
    schemaVersion: "b2-page-diagnostic.continuation.v1",
    passed: false,
    mode: formal ? "formal-continuation" : "smoke-continuation",
    productionState:
      process.env.E1_PRODUCTION_STATE || (formal ? "notification-stable" : "unlabeled-smoke"),
    reusedFrom: relativeToWorkspace(existingScaleRoot),
    reusedScaleEvidence: {
      initialTotal: existingScale.bootstrap?.total,
      appends: existingScale.appends?.length,
      originalFailure: existingResult.failure?.message || null,
    },
    sourceSnapshot: {
      before: sourceSnapshotBefore,
      after: null,
    },
    startedAt,
    outputRoot,
    scope: "10x continuation from preserved source landing and append state; not p95 and not B3/C",
    measurementSemantics: {
      appendInputGrowthBytes: "Post-append file size minus pre-append file size; not observed parser read bytes.",
      expectedProofBytesIfAppend:
        "The SHA-fallback proof contract 2 * old prefix + appended suffix; not observed parser input or physical I/O.",
      refreshLatency: "Original-page wall time from file append through exact API total and painted value, not executor sync time.",
      sourceWork: "Observed by G1; E1 reports page wall time plus OS service-tree CPU and logical I/O.",
    },
    limits: {
      gatewayHeapMb: NODE_GATEWAY_HEAP_MB,
      executorHeapMb: EXECUTOR_HEAP_MB,
      automaticDiscoveryEnabled: false,
      pricingRefreshSchedulerEnabled: false,
      realSourcesOrDatabasesTouched: false,
      userServiceTouched: false,
    },
    disk,
    scales: [],
  };
  try {
    await runContinuationScale(dataset, prepared, path.resolve(existingScaleRoot), outputRoot, result);
    const datasetHashAfter = await hashFile(datasetFile);
    assert.deepEqual(datasetHashAfter, datasetHashBefore, "10x frozen dataset.json changed");
    result.scales[0].datasetIntegrity = {
      before: datasetHashBefore,
      after: datasetHashAfter,
    };
    result.sourceSnapshot.after = await productionSourceSnapshot();
    assert.deepEqual(result.sourceSnapshot.after.files, result.sourceSnapshot.before.files);
    result.passed = true;
    log("continuation-complete", {
      finalTotal: result.scales[0].finalPage.total,
      oracleMs: result.scales[0].oracle.wallMs,
    });
  } catch (error) {
    result.failure = {
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
    };
    throw error;
  } finally {
    result.finishedAt = new Date().toISOString();
    result.elapsedMs = performance.now() - totalStarted;
    await writeFile(path.join(outputRoot, "page-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  }
  return result;
}

async function main() {
  const continuationIndex = process.argv.indexOf("--continue-10x-from");
  if (continuationIndex >= 0) {
    const existingScaleRoot = process.argv[continuationIndex + 1];
    assert.ok(existingScaleRoot, "--continue-10x-from requires the existing 10x scale directory");
    const result = await runContinuationDiagnostic(path.resolve(existingScaleRoot));
    log("diagnostic-complete", {
      outputRoot: result.outputRoot,
      elapsedMs: result.elapsedMs,
      scales: result.scales.map((scale) => ({
        scale: scale.scale,
        finalTotal: scale.finalPage.total,
        oracleMs: scale.oracle.wallMs,
      })),
    });
    return;
  }
  const residualCheckIndex = process.argv.indexOf("--self-check-residual");
  if (residualCheckIndex >= 0) {
    const scaleRoot = process.argv[residualCheckIndex + 1];
    assert.ok(scaleRoot, "--self-check-residual requires a scale output directory");
    await selfCheckResidualProcesses(path.resolve(scaleRoot));
    return;
  }
  const oracleCheckIndex = process.argv.indexOf("--self-check-oracle");
  if (oracleCheckIndex >= 0) {
    const databaseFile = process.argv[oracleCheckIndex + 1];
    const expectedTotal = Number(process.argv[oracleCheckIndex + 2]);
    const expectedEventCount = Number(process.argv[oracleCheckIndex + 3]);
    assert.ok(databaseFile, "--self-check-oracle requires a database file");
    assert.ok(Number.isSafeInteger(expectedTotal) && expectedTotal >= 0);
    assert.ok(Number.isSafeInteger(expectedEventCount) && expectedEventCount >= 0);
    await selfCheckOracleDatabase(path.resolve(databaseFile), expectedTotal, expectedEventCount);
    return;
  }
  const resourceCheckIndex = process.argv.indexOf("--self-check-resource");
  if (resourceCheckIndex >= 0) {
    const scaleRoot = process.argv[resourceCheckIndex + 1];
    const expectedProcessPeak = Number(process.argv[resourceCheckIndex + 2]);
    assert.ok(scaleRoot, "--self-check-resource requires a scale output directory");
    assert.ok(Number.isSafeInteger(expectedProcessPeak) && expectedProcessPeak > 0);
    await selfCheckResourceSummary(path.resolve(scaleRoot), expectedProcessPeak);
    return;
  }
  const serveIndex = process.argv.indexOf("--serve");
  if (serveIndex >= 0) {
    const configFile = process.argv[serveIndex + 1];
    assert.ok(configFile, "--serve requires a config file");
    await serveMain(path.resolve(configFile));
    return;
  }
  const result = await runDiagnostic();
  log("diagnostic-complete", {
    outputRoot: result.outputRoot,
    elapsedMs: result.elapsedMs,
    scales: result.scales.map((scale) => ({
      scale: scale.scale,
      bootstrapMs: scale.bootstrap.wallMs,
      finalTotal: scale.finalPage.total,
      oracleMs: scale.oracle.wallMs,
    })),
  });
}

export { prepareScale, loadExistingScale, serverOptions, serveMain, waitForServer, stopServer,
  openPage, painted, switchPreset, appendAndPaint, progressRows, hashFile, productionSourceSnapshot,
  sourceInventory, compareInventory, codexAppendRows, dshAppendFrame, waitForPollingRecovery, sleep };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
