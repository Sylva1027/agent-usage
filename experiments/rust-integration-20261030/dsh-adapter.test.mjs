import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { zstdCompressSync } from "node:zlib";

import { dshRustAdapterStats } from "./dsh-adapter.mjs";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ADAPTER_FILE = path.join(REPO_ROOT, "experiments", "rust-integration-20261030", "dsh-adapter.mjs");
const RUNTIME_HOOK_FILE = path.join(
  REPO_ROOT,
  "experiments",
  "rust-integration-20261030",
  "runtime-hook.mjs",
);
const ORIGINAL_HOOK_FILE = path.join(
  REPO_ROOT,
  "docs",
  "validation",
  "2026-10-29-local-summary-endurance",
  "probes",
  "hook.mjs",
);
const CANDIDATE_ROOT = path.join(REPO_ROOT, ".codex-usage", "rust-integration-20261030", "candidate", "src");
const OUTPUT_ROOT = path.join(REPO_ROOT, "output", "rust-integration-20261030");
const T0 = Date.parse("2026-10-30T00:00:00.000Z");
const SESSION_ID = "session-rust-integration-r1";
const BODY_SENTINEL = "R1-BODY-MUST-NOT-CROSS-IPC";
const STREAM_SENTINEL = "R1-STREAM-TEXT-MUST-NOT-CROSS-IPC";

test("native helper publishes its PID even when stdin closes immediately", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-rust-pid-"));
  const pidFile = path.join(root, "pid");
  const binary = path.join(REPO_ROOT, ".codex-usage/rust-integration-20261030/rust-target/release/dsh-rust-helper.exe");
  try {
    const child = spawn(binary, [], { env: { ...process.env, RUST_DSH_PID_FILE: pidFile }, stdio: "ignore", windowsHide: true });
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0);
    assert.equal(Number(await readFile(pidFile, "utf8")), child.pid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function frame(value) {
  return zstdCompressSync(Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"));
}

function rowsFrame(rows) {
  return frame(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function damagedFrame() {
  return Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from("not-a-frame")]);
}

async function loadModules() {
  const baselineDsh = await import(pathToFileURL(path.join(REPO_ROOT, "src", "dsh-usage.js")).href);
  const baselinePerf = await import(pathToFileURL(path.join(REPO_ROOT, "src", "perf-sources", "dsh.js")).href);
  const candidateDsh = await import(pathToFileURL(path.join(CANDIDATE_ROOT, "dsh-usage.js")).href);
  const candidatePerf = await import(
    pathToFileURL(path.join(CANDIDATE_ROOT, "perf-sources", "dsh.js")).href
  );
  const candidateStore = await import(pathToFileURL(path.join(CANDIDATE_ROOT, "usage-store.js")).href);
  return { baselineDsh, baselinePerf, candidateDsh, candidatePerf, UsageStore: candidateStore.UsageStore };
}

async function collectRows(module, filePath) {
  const rows = [];
  const warnings = [];
  for await (const row of module.streamDshSessionRows(filePath, {
    onWarning: (warning) => warnings.push(warning),
  })) {
    rows.push(row);
  }
  return { rows, warnings };
}

async function collectProjection(dshModule, perfModule, filePath, source) {
  const events = [];
  const eventWarnings = [];
  await dshModule.streamDshSessionEvents(filePath, source, (event) => events.push(event), {
    onWarning: (warning) => eventWarnings.push(warning),
    repositoryResolver: async (cwd) => ({
      key: `fixture:${cwd}`,
      path: cwd,
      kind: "fixture",
    }),
  });

  const samples = [];
  const perfWarnings = [];
  const perfResult = await perfModule.streamDshPerfSamples(
    filePath,
    source,
    (sample) => samples.push(sample),
    { onWarning: (warning) => perfWarnings.push(warning) },
  );
  return { events, eventWarnings, samples, perfWarnings, perfResult };
}

async function syntheticFile(root) {
  const directory = path.join(root, "sessions", "fixture", SESSION_ID);
  const filePath = path.join(directory, "session.v4.jsonl.zstd");
  await mkdir(directory, { recursive: true });

  const session = {
    type: "session",
    version: 4,
    id: SESSION_ID,
    cwd: "E:\\fixture\\rust-integration-r1",
    delegationDepth: 0,
    createdAt: T0,
    agentPreset: "中文预设",
  };
  const request = {
    type: "request/header",
    seq: 1,
    time: T0 + 1,
    data: {
      header: { config: { model: "deepseek-chat", provider: "deepseek-account", reasoningEffort: "max" } },
    },
  };
  const title = {
    type: "session/title",
    seq: 2,
    time: T0 + 2,
    data: { title: "R1 synthetic" },
  };
  const stepStart = { type: "step/start", seq: 3, time: T0 + 100, data: { turn: 1, step: 1 } };
  const retry = { type: "llm/retry-started", seq: 4, time: T0 + 150, data: { turn: 1, step: 1 } };
  const message = {
    type: "assistant/message",
    seq: 5,
    time: T0 + 250,
    data: {
      turn: 1,
      step: 1,
      usage: {
        inputTokens: 10,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        outputTokens: 3,
        reasoningTokens: 0,
        totalTokens: 16,
      },
      message: {
        source: { model: "deepseek-chat", provider: "deepseek-account" },
        content: [{ type: "text", text: BODY_SENTINEL }],
      },
      stream: [
        { type: "text-chunks", time0: T0 + 200, index: 0, dt: [20], texts: ["A", STREAM_SENTINEL] },
        {
          type: "tool-call-chunks",
          time0: T0 + 225,
          index: 0,
          dt: [5],
          id: "fixture-tool",
          name: "fixture-tool",
          args: ["", STREAM_SENTINEL],
        },
        { type: "chunk", time: T0 + 240, chunk: { type: "usage", usage: { outputTokens: 3 } } },
        { type: "chunk", time: T0 + 250, chunk: { type: "finish", reason: { kind: "stop" } } },
      ],
    },
  };
  const stepEnd = { type: "step/end", seq: 6, data: { turn: 1, step: 1, payload: BODY_SENTINEL } };

  const sessionLine = Buffer.from(`${JSON.stringify(session)}\n`, "utf8");
  const marker = Buffer.from("中文", "utf8");
  const markerAt = sessionLine.indexOf(marker);
  assert.notEqual(markerAt, -1);
  const frames = [
    rowsFrame([request, title, stepStart, retry]),
    rowsFrame([message, stepEnd]),
    frame(sessionLine.subarray(0, markerAt + 1)),
    frame(sessionLine.subarray(markerAt + 1)),
    frame('{"type":"broken"\n'),
    damagedFrame(),
    zstdCompressSync(Buffer.alloc(0)),
  ];
  await writeFile(filePath, Buffer.concat(frames));
  return filePath;
}

async function filesUnder(directory, files = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) await filesUnder(filePath, files);
    else if (entry.isFile() && /^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) files.push(filePath);
  }
  return files;
}

async function chooseRealFile(baselineDsh) {
  const explicit = process.env.DSH_R1_REAL_FILE;
  if (explicit) return explicit;
  const files = await baselineDsh.dshSessionFiles(path.join(os.homedir(), ".dsh"));
  const candidates = [];
  for (const filePath of files) {
    const info = await stat(filePath);
    if (info.size >= 20_000 && info.size <= 250_000) {
      candidates.push({ filePath, size: info.size, mtimeMs: info.mtimeMs });
    }
  }
  candidates.sort((left, right) => left.mtimeMs - right.mtimeMs || left.size - right.size);
  if (candidates.length === 0) throw new Error("no readable real DSH file in the 20-250 KiB range");
  return candidates[0].filePath;
}

async function chooseLargestRealFile(baselineDsh) {
  const explicit = process.env.DSH_R1_BOUNDARY_FILE;
  if (explicit) return explicit;
  const files = await baselineDsh.dshSessionFiles(path.join(os.homedir(), ".dsh"));
  let largest = null;
  for (const filePath of files) {
    const info = await stat(filePath);
    if (!largest || info.size > largest.size) {
      largest = { filePath, size: info.size };
    }
  }
  if (!largest) throw new Error("no readable real DSH file for the output-boundary measurement");
  return largest.filePath;
}

async function measureRows(module, filePath) {
  let rows = 0;
  const warnings = [];
  for await (const _row of module.streamDshSessionRows(filePath, {
    onWarning: (warning) => warnings.push(warning),
  })) {
    rows += 1;
  }
  return { rows, warnings };
}

async function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await processExists(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`DSH Rust helper ${pid} remained alive after its parent exited`);
}

test("Rust projected rows preserve real Node event and TPS projections", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-rust-integration-r1-"));
  let store = null;
  t.after(() => rm(root, { recursive: true, force: true }));
  try {
    const { baselineDsh, baselinePerf, candidateDsh, candidatePerf, UsageStore } = await loadModules();
    const synthetic = await syntheticFile(root);
    const source = { id: "home-r1", label: "R1 fixture", path: root };

    const baselineRows = await collectRows(baselineDsh, synthetic);
    const candidateRows = await collectRows(candidateDsh, synthetic);
    assert.deepEqual(candidateRows.warnings, baselineRows.warnings);
    assert.deepEqual(
      candidateRows.rows.map((row) => row.type),
      baselineRows.rows.map((row) => row.type),
    );
    assert.equal(candidateRows.rows.length, baselineRows.rows.length);
    const candidateWire = JSON.stringify(candidateRows.rows);
    assert.equal(candidateWire.includes(BODY_SENTINEL), false);
    assert.equal(candidateWire.includes(STREAM_SENTINEL), false);
    const candidateMessage = candidateRows.rows.find((row) => row.type === "assistant/message");
    assert.equal(candidateMessage.data.message.content, undefined);
    assert.deepEqual(candidateMessage.data.message.source, {
      model: "deepseek-chat",
      provider: "deepseek-account",
    });
    assert.equal(candidateMessage.data.stream[0].texts[1], "x");

    const baselineSynthetic = await collectProjection(baselineDsh, baselinePerf, synthetic, source);
    const candidateSynthetic = await collectProjection(candidateDsh, candidatePerf, synthetic, source);
    assert.deepEqual(candidateSynthetic.events, baselineSynthetic.events);
    assert.deepEqual(candidateSynthetic.eventWarnings, baselineSynthetic.eventWarnings);
    assert.deepEqual(candidateSynthetic.samples, baselineSynthetic.samples);
    assert.deepEqual(candidateSynthetic.perfWarnings, baselineSynthetic.perfWarnings);
    assert.deepEqual(candidateSynthetic.perfResult, baselineSynthetic.perfResult);
    assert.ok(candidateSynthetic.events.length > 0);
    assert.ok(candidateSynthetic.samples.length > 0);

    const realFile = await chooseRealFile(baselineDsh);
    const realInfo = await stat(realFile);
    const realSource = { id: "home-r1-real", label: "R1 real", path: path.dirname(realFile) };
    const baselineReal = await collectProjection(baselineDsh, baselinePerf, realFile, realSource);
    const candidateReal = await collectProjection(candidateDsh, candidatePerf, realFile, realSource);
    assert.deepEqual(candidateReal.events, baselineReal.events);
    assert.deepEqual(candidateReal.eventWarnings, baselineReal.eventWarnings);
    assert.deepEqual(candidateReal.samples, baselineReal.samples);
    assert.deepEqual(candidateReal.perfWarnings, baselineReal.perfWarnings);
    assert.deepEqual(candidateReal.perfResult, baselineReal.perfResult);
    assert.ok(candidateReal.events.length > 0);
    assert.ok(candidateReal.samples.length > 0);

    const boundaryFile = await chooseLargestRealFile(baselineDsh);
    const boundaryInfo = await stat(boundaryFile);
    const ipcBeforeBoundary = dshRustAdapterStats();
    const boundaryStream = await measureRows(candidateDsh, boundaryFile);
    const ipcAfterBoundary = dshRustAdapterStats();
    const boundary = {
      file: boundaryFile,
      compressedBytes: boundaryInfo.size,
      rows: ipcAfterBoundary.rows - ipcBeforeBoundary.rows,
      batches: ipcAfterBoundary.batches - ipcBeforeBoundary.batches,
      outputBytes: ipcAfterBoundary.outputBytes - ipcBeforeBoundary.outputBytes,
      maxBatchRows: ipcAfterBoundary.maxBatchRows,
      warnings: boundaryStream.warnings.length,
    };
    assert.equal(boundary.rows, boundaryStream.rows);
    assert.equal(ipcAfterBoundary.scans - ipcBeforeBoundary.scans, 1);
    assert.equal(boundary.batches, Math.ceil(boundary.rows / 64));
    assert.ok(boundary.outputBytes > 0);
    assert.ok(boundary.maxBatchRows <= 64);

    const dshHome = path.join(root, ".dsh");
    const copiedFile = path.join(
      dshHome,
      "sessions",
      "fixture",
      SESSION_ID,
      "session.v4.jsonl.zstd",
    );
    await mkdir(path.dirname(copiedFile), { recursive: true });
    await copyFile(realFile, copiedFile);
    const options = {
      homeDir: root,
      env: {},
      importDirs: [],
      automaticDiscoveryEnabled: false,
      pricingRefreshSchedulerEnabled: false,
      pricingFile: path.join(root, "pricing.json"),
      automaticPricingFile: path.join(root, "pricing-auto.json"),
      importStoreFile: path.join(root, "imports.json"),
    };
    store = new UsageStore({ ...options, databaseFile: path.join(root, "usage.sqlite") });
    const syncStatus = await store.sync({ options });
    const sqliteEvents = Number(store.database.prepare("SELECT COUNT(*) AS count FROM events").get().count);
    const sqlitePerfSamples = Number(
      store.database.prepare("SELECT COUNT(*) AS count FROM perf_samples").get().count,
    );
    assert.equal(sqliteEvents, candidateReal.events.length, JSON.stringify(syncStatus));
    assert.equal(sqlitePerfSamples, candidateReal.samples.length, JSON.stringify(syncStatus));
    store.close();
    store = null;

    const adapterStats = dshRustAdapterStats();
    assert.equal(adapterStats.spawns, 1);
    assert.ok(adapterStats.scans >= 10);
    assert.ok(adapterStats.maxBatchRows <= 64);

    const evidence = {
      synthetic: {
        file: synthetic,
        rows: candidateRows.rows.length,
        warnings: candidateRows.warnings,
        events: candidateSynthetic.events.length,
        perfSamples: candidateSynthetic.samples.length,
      },
      real: {
        file: realFile,
        compressedBytes: realInfo.size,
        events: candidateReal.events.length,
        perfSamples: candidateReal.samples.length,
        warnings: candidateReal.perfWarnings,
      },
      boundary,
      sqlite: {
        database: path.join(root, "usage.sqlite"),
        events: sqliteEvents,
        perfSamples: sqlitePerfSamples,
        syncStatus,
      },
      ipc: adapterStats,
    };
    await mkdir(OUTPUT_ROOT, { recursive: true });
    await writeFile(
      path.join(OUTPUT_ROOT, "r1-equivalence.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
      "utf8",
    );
    console.log(JSON.stringify(evidence));
  } finally {
    store?.close();
  }
});

test("the production physical-path hook maps Rust reads while warnings retain the logical path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-rust-mapped-r1-"));
  const physicalRoot = path.join(root, "physical");
  const logicalRoot = path.join(root, "logical");
  t.after(() => rm(root, { recursive: true, force: true }));
  try {
    const { baselineDsh, baselinePerf, candidateDsh, candidatePerf } = await loadModules();
    const physicalFile = await syntheticFile(physicalRoot);
    const logicalFile = path.join(
      logicalRoot,
      "sessions",
      "fixture",
      SESSION_ID,
      "session.v4.jsonl.zstd",
    );
    await assert.rejects(stat(logicalFile), { code: "ENOENT" });

    const previousPhysicalHook = globalThis.__localSummaryPhysical;
    globalThis.__localSummaryPhysical = (value) => (value === logicalFile ? physicalFile : value);
    try {
      const source = { id: "home-r1-mapped", label: "R1 mapped", path: root };
      const baselineRows = await collectRows(baselineDsh, physicalFile);
      const candidateRows = await collectRows(candidateDsh, logicalFile);
      const logicalWarnings = baselineRows.warnings.map((warning) =>
        warning.replaceAll(physicalFile, logicalFile),
      );
      assert.deepEqual(candidateRows.warnings, logicalWarnings);
      assert.ok(candidateRows.warnings.length > 0);
      assert.ok(candidateRows.warnings.every((warning) => warning.includes(logicalFile)));
      assert.ok(candidateRows.warnings.every((warning) => !warning.includes(physicalFile)));

      const baseline = await collectProjection(baselineDsh, baselinePerf, physicalFile, source);
      const candidate = await collectProjection(candidateDsh, candidatePerf, logicalFile, source);
      assert.deepEqual(candidate.events, baseline.events);
      assert.deepEqual(candidate.eventWarnings, logicalWarnings);
      assert.deepEqual(
        candidate.samples.map((sample) => ({ ...sample, sourcePath: "<mapped>" })),
        baseline.samples.map((sample) => ({ ...sample, sourcePath: "<mapped>" })),
      );
      assert.deepEqual(candidate.perfWarnings, baseline.perfWarnings);
      assert.deepEqual(candidate.perfResult, baseline.perfResult);
      assert.ok(candidate.events.length > 0);
      assert.ok(candidate.samples.length > 0);
    } finally {
      if (previousPhysicalHook === undefined) delete globalThis.__localSummaryPhysical;
      else globalThis.__localSummaryPhysical = previousPhysicalHook;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one helper is reused per parent and exits after the parent exits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-rust-lifecycle-r1-"));
  try {
    const filePath = await syntheticFile(root);
    const adapterUrl = pathToFileURL(ADAPTER_FILE).href;
    const manifestFile = path.join(root, "manifest.json");
    const configFile = path.join(root, "runtime-config.json");
    const eventFile = path.join(root, "process-events.jsonl");
    await writeFile(
      manifestFile,
      `${JSON.stringify({ work: root, mappings: [] }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      configFile,
      `${JSON.stringify(
        {
          originalHookFile: ORIGINAL_HOOK_FILE,
          manifestPath: manifestFile,
          sourceRoot: path.join(root, "source"),
          processEventFile: eventFile,
          fixedNow: "2026-10-30T00:00:00.000Z",
          options: {
            databaseFile: path.join(root, "lifecycle.sqlite"),
            env: {},
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const script = [
      `import { streamDshRustRows, dshRustAdapterStats } from ${JSON.stringify(adapterUrl)};`,
      `for await (const _row of streamDshRustRows(${JSON.stringify(filePath)})) {}`,
      `for await (const _row of streamDshRustRows(${JSON.stringify(filePath)})) {}`,
      "console.log(JSON.stringify({ stats: dshRustAdapterStats() }));",
    ].join("\n");
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--import",
        pathToFileURL(RUNTIME_HOOK_FILE).href,
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          LOCAL_SUMMARY_CASE_CONFIG: configFile,
          NODE_NO_WARNINGS: "1",
        },
        timeout: 20_000,
        windowsHide: true,
      },
    );
    assert.equal(stderr, "");
    const result = JSON.parse(stdout.trim());
    assert.equal(result.stats.spawns, 1);
    assert.equal(result.stats.scans, 2);
    const events = (await readFile(eventFile, "utf8"))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const helperStarts = events.filter(
      (event) =>
        event.action === "start" &&
        event.kind === "helper" &&
        /dsh-rust-helper\.exe$/i.test(event.executable),
    );
    assert.equal(helperStarts.length, 1);
    assert.ok(Number.isInteger(helperStarts[0].pid));
    await waitForProcessExit(helperStarts[0].pid);
    await mkdir(OUTPUT_ROOT, { recursive: true });
    await writeFile(
      path.join(OUTPUT_ROOT, "r1-lifecycle.json"),
      `${JSON.stringify(
        {
          parentPid: helperStarts[0].parentPid,
          helperPid: helperStarts[0].pid,
          helperStart: helperStarts[0],
          helperEnd: events.find(
            (event) => event.action === "end" && event.pid === helperStarts[0].pid,
          ),
          stats: result.stats,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
