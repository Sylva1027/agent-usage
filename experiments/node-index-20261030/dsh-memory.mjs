import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getHeapStatistics } from "node:v8";
import { zstdCompressSync } from "node:zlib";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DEFAULT_CONFIG = path.join(REPO_ROOT, "output", "node-index-20261030", "experiment.json");
const OLD_SPACE_MB = 224;
const SEMI_SPACE_MB = 4;
const MEMORY_KEYS = ["rssBytes", "heapTotalBytes", "heapUsedBytes", "externalBytes", "arrayBuffersBytes"];
const CALLBACK_MEMORY_NOTE =
  "Each callback sample is one process.memoryUsage() point in time. sampledMax is the maximum callback-time sample, not the process instantaneous heap peak.";
const PROCESS_MAX_RSS_NOTE =
  "resourceUsage().maxRSS is cumulative for the child process. File-end maxRSS values are cumulative checkpoints, not per-file peaks.";
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((member) => canonicalJson(member)).join(",")}]`;
  }
  const fields = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${fields.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function createTaggedDigest() {
  const hash = createHash("sha256");
  let recordCount = 0;
  return {
    add(tag, value) {
      const wire = canonicalJson(value);
      hash.update(`${Buffer.byteLength(tag)}:${tag}:${Buffer.byteLength(wire)}:`);
      hash.update(wire);
      recordCount += 1;
    },
    summary() {
      return { recordCount, digest: hash.copy().digest("hex") };
    },
  };
}

function createCallbackSampler() {
  let count = 0;
  let first = null;
  let last = null;
  let sampledMax = null;
  return {
    sample() {
      const usage = process.memoryUsage();
      const current = {
        rssBytes: usage.rss,
        heapTotalBytes: usage.heapTotal,
        heapUsedBytes: usage.heapUsed,
        externalBytes: usage.external,
        arrayBuffersBytes: usage.arrayBuffers,
      };
      count += 1;
      first ??= current;
      last = current;
      sampledMax ??= { ...current };
      for (const key of MEMORY_KEYS) {
        sampledMax[key] = Math.max(sampledMax[key], current[key]);
      }
    },
    summary() {
      return {
        count,
        first,
        last,
        sampledMax,
        note: CALLBACK_MEMORY_NOTE,
      };
    },
  };
}

function elapsedMs(startedAt) {
  return Math.round((Number(process.hrtime.bigint() - startedAt) / 1_000_000) * 1_000) / 1_000;
}

function parseArgs(argv) {
  let configFile = DEFAULT_CONFIG;
  let selfTest = false;
  let child = false;
  let variant = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("--config requires a path");
      configFile = path.resolve(value);
      index += 1;
    } else if (argument === "--self-test") {
      selfTest = true;
    } else if (argument === "--child") {
      child = true;
    } else if (argument === "--variant") {
      const value = argv[index + 1];
      if (value !== "baseline" && value !== "candidate") {
        throw new Error("--variant must be baseline or candidate");
      }
      variant = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (child && variant === null) {
    throw new Error("child mode requires --variant");
  }
  if (!child && variant !== null) {
    throw new Error("--variant is only valid in child mode");
  }
  if (child && selfTest) {
    throw new Error("--self-test cannot be combined with --child");
  }
  return { configFile, selfTest, child, variant };
}

function loadExperiment(configFile) {
  const experiment = JSON.parse(fs.readFileSync(configFile, "utf8"));
  for (const key of ["manifestPath", "nodeCompactBaseline", "compactRoot"]) {
    if (typeof experiment[key] !== "string" || experiment[key] === "") {
      throw new Error(`experiment config is missing ${key}`);
    }
  }
  return experiment;
}

function sourceIdFor(originalPath) {
  return `dsh-memory-${sha256Text(originalPath).slice(0, 20)}`;
}

function isDshSessionPath(value) {
  return typeof value === "string" && /[\\/]\.dsh[\\/]sessions[\\/]/.test(value);
}

async function selectLargestDshEntries(experiment) {
  const manifest = JSON.parse(fs.readFileSync(experiment.manifestPath, "utf8"));
  const candidates = [];
  const seenCopies = new Set();
  const seenSources = new Set();

  for (const entry of manifest.copied ?? []) {
    if (
      !isDshSessionPath(entry.original) ||
      typeof entry.copy !== "string" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size <= 0
    ) {
      continue;
    }
    const sourceKey = entry.original.toLowerCase();
    if (seenSources.has(sourceKey)) {
      continue;
    }
    seenSources.add(sourceKey);
    const inputFile = path.resolve(entry.copy);
    const seenKey = inputFile.toLowerCase();
    if (seenCopies.has(seenKey)) {
      continue;
    }
    seenCopies.add(seenKey);
    const info = await stat(inputFile).catch(() => null);
    if (!info?.isFile()) {
      continue;
    }
    if (info.size !== entry.size) {
      throw new Error(`manifest size mismatch for copied DSH input: ${inputFile}`);
    }
    candidates.push({
      file: inputFile,
      sourceId: sourceIdFor(entry.original),
      sourcePath: path.dirname(inputFile),
      sourceKey: sha256Text(entry.original).slice(0, 16),
      compressedBytes: entry.size,
      sortKey: entry.original,
    });
  }

  candidates.sort(
    (left, right) => right.compressedBytes - left.compressedBytes || left.sortKey.localeCompare(right.sortKey),
  );
  if (candidates.length < 3) {
    throw new Error(`manifest contains only ${candidates.length} usable DSH session copies; need 3`);
  }
  return candidates.slice(0, 3).map(({ sortKey: _sortKey, ...entry }, index) => ({ index, ...entry }));
}

async function readStdinJson() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  return JSON.parse(text);
}

async function loadVariantModules(experiment, variant) {
  const root = variant === "baseline" ? experiment.nodeCompactBaseline : experiment.compactRoot;
  const [dsh, perf] = await Promise.all([
    import(pathToFileURL(path.join(root, "src", "dsh-usage.js")).href),
    import(pathToFileURL(path.join(root, "src", "perf-sources", "dsh.js")).href),
  ]);
  return { root, dsh, perf };
}

async function runFile(modules, entry) {
  const source = Object.freeze({
    id: entry.sourceId,
    label: "DSH memory benchmark",
    path: entry.sourcePath,
  });
  const combined = createTaggedDigest();
  combined.add("source", { id: source.id, path: source.path });

  const usageDigest = createTaggedDigest();
  const usageSampler = createCallbackSampler();
  let usageEventCount = 0;
  let usageWarningCount = 0;
  const fileStartedAt = process.hrtime.bigint();
  const usageStartedAt = process.hrtime.bigint();
  await modules.dsh.streamDshSessionEvents(
    entry.file,
    source,
    (event) => {
      usageSampler.sample();
      usageEventCount += 1;
      usageDigest.add("event", event);
    },
    {
      onWarning: (warning) => {
        usageWarningCount += 1;
        usageDigest.add("warning", warning);
      },
      repositoryResolver: async (cwd) => ({
        key: `dsh-memory:${cwd}`,
        path: cwd,
        kind: "memory-fixture",
      }),
    },
  );
  const usageMs = elapsedMs(usageStartedAt);

  const perfDigest = createTaggedDigest();
  const perfSampler = createCallbackSampler();
  let perfSampleCount = 0;
  let perfWarningCount = 0;
  let perfWarningItemCount = 0;
  const perfStartedAt = process.hrtime.bigint();
  const perfResult = await modules.perf.streamDshPerfSamples(
    entry.file,
    source,
    (sample) => {
      perfSampler.sample();
      perfSampleCount += 1;
      perfDigest.add("sample", sample);
    },
    {
      onWarning: (warning) => {
        perfWarningCount += 1;
        perfWarningItemCount += Number.isSafeInteger(warning?.count) ? warning.count : 1;
        perfDigest.add("warning", warning);
      },
    },
  );
  const perfMs = elapsedMs(perfStartedAt);
  perfDigest.add("result", perfResult);
  assert.equal(perfSampleCount, perfResult.sampleCount, "perf callback count differs from reader result");

  const usageSummary = usageDigest.summary();
  const perfSummary = perfDigest.summary();
  combined.add("usage", {
    digest: usageSummary.digest,
    recordCount: usageSummary.recordCount,
    eventCount: usageEventCount,
    warningCount: usageWarningCount,
  });
  combined.add("perf", {
    digest: perfSummary.digest,
    recordCount: perfSummary.recordCount,
    sampleCount: perfSampleCount,
    warningCount: perfWarningCount,
    warningItemCount: perfWarningItemCount,
    stepEndFrames: perfResult.stepEndFrames,
  });
  const combinedSummary = combined.summary();
  const processMaxRSS = process.resourceUsage().maxRSS;

  return {
    index: entry.index,
    inputFile: entry.file,
    sourceKey: entry.sourceKey,
    sourceId: entry.sourceId,
    sourcePath: entry.sourcePath,
    compressedBytes: entry.compressedBytes,
    timingMs: {
      usage: usageMs,
      perf: perfMs,
      total: elapsedMs(fileStartedAt),
    },
    usage: {
      eventCount: usageEventCount,
      warningCount: usageWarningCount,
      digest: usageSummary.digest,
      callbackMemory: usageSampler.summary(),
    },
    perf: {
      sampleCount: perfSampleCount,
      warningCount: perfWarningCount,
      warningItemCount: perfWarningItemCount,
      stepEndFrames: perfResult.stepEndFrames,
      digest: perfSummary.digest,
      callbackMemory: perfSampler.summary(),
    },
    combinedDigest: combinedSummary.digest,
    processMaxRSSAtFileEnd: processMaxRSS,
  };
}

async function childMain(options) {
  const experiment = loadExperiment(options.configFile);
  const payload = await readStdinJson();
  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    throw new Error("child payload must contain a non-empty entries array");
  }
  const modules = await loadVariantModules(experiment, options.variant);
  const files = [];
  for (const entry of payload.entries) {
    files.push(await runFile(modules, entry));
  }
  const resourceUsage = process.resourceUsage();
  process.stdout.write(
    `${JSON.stringify({
      variant: options.variant,
      moduleRoot: modules.root,
      budget: {
        maxOldSpaceSizeMb: OLD_SPACE_MB,
        maxSemiSpaceSizeMb: SEMI_SPACE_MB,
        heapSizeLimitBytes: getHeapStatistics().heap_size_limit,
      },
      files,
      processResourceUsage: {
        maxRSS: resourceUsage.maxRSS,
        unit: "KiB",
        note: PROCESS_MAX_RSS_NOTE,
      },
      callbackMemoryNote: CALLBACK_MEMORY_NOTE,
    })}\n`,
  );
}

async function runVariantChild({ configFile, variant, entries }) {
  const scriptFile = fileURLToPath(import.meta.url);
  const args = [
    `--max-old-space-size=${OLD_SPACE_MB}`,
    `--max-semi-space-size=${SEMI_SPACE_MB}`,
    scriptFile,
    "--child",
    "--variant",
    variant,
    "--config",
    configFile,
  ];
  const env = { ...process.env };
  delete env.NODE_OPTIONS;

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
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
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`${variant} child failed (code=${code}, signal=${signal}): ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`${variant} child returned invalid JSON: ${error.message}; stdout=${stdout.trim()}`));
      }
    });
    child.stdin.end(JSON.stringify({ entries }));
  });
}

function compareVariants(baseline, candidate) {
  const files = baseline.files.map((left, index) => {
    const right = candidate.files[index];
    const same = {
      inputFile: left.inputFile === right?.inputFile,
      sourceId: left.sourceId === right?.sourceId,
      sourcePath: left.sourcePath === right?.sourcePath,
      usageCounts:
        left.usage.eventCount === right?.usage.eventCount && left.usage.warningCount === right?.usage.warningCount,
      perfCounts:
        left.perf.sampleCount === right?.perf.sampleCount &&
        left.perf.warningCount === right?.perf.warningCount &&
        left.perf.warningItemCount === right?.perf.warningItemCount &&
        left.perf.stepEndFrames === right?.perf.stepEndFrames,
      usageDigest: left.usage.digest === right?.usage.digest,
      perfDigest: left.perf.digest === right?.perf.digest,
      combinedDigest: left.combinedDigest === right?.combinedDigest,
    };
    return {
      index,
      sourceId: left.sourceId,
      compressedBytes: left.compressedBytes,
      same,
      ok: Object.values(same).every(Boolean),
    };
  });
  return {
    ok: baseline.files.length === candidate.files.length && files.every((file) => file.ok),
    files,
  };
}

async function runRealMode(configFile) {
  const experiment = loadExperiment(configFile);
  const entries = await selectLargestDshEntries(experiment);
  const baseline = await runVariantChild({ configFile, variant: "baseline", entries });
  const candidate = await runVariantChild({ configFile, variant: "candidate", entries });
  const parity = compareVariants(baseline, candidate);
  const output = {
    status: parity.ok ? "ok" : "digest-mismatch",
    mode: "real",
    selection: {
      rule: "three largest compressed DSH session copies in the frozen manifest",
      count: entries.length,
    },
    entries: entries.map(({ index, inputFile, sourceKey, sourceId, sourcePath, compressedBytes }) => ({
      index,
      inputFile,
      sourceKey,
      sourceId,
      sourcePath,
      compressedBytes,
    })),
    baseline,
    candidate,
    parity,
  };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (!parity.ok) {
    process.exitCode = 1;
  }
}

function frame(value) {
  return zstdCompressSync(Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"));
}

function rowsFrame(rows) {
  return frame(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function damagedFrame() {
  return Buffer.concat([ZSTD_MAGIC, Buffer.from("not-a-valid-zstd-frame")]);
}

function selfSession(id, time) {
  return {
    type: "session",
    version: 4,
    id,
    cwd: "E:\\fixture\\dsh-memory",
    createdAt: time,
    delegationDepth: 0,
    agentPreset: "memory-self-test",
  };
}

function selfRows(id, time, outputTokens) {
  return [
    selfSession(id, time),
    {
      type: "request/header",
      seq: 1,
      time: time + 100,
      data: {
        header: {
          config: {
            model: "deepseek-memory",
            provider: "deepseek-account",
            reasoningEffort: "max",
          },
        },
      },
    },
    { type: "step/start", seq: 2, time: time + 200, data: { turn: 1, step: 1 } },
    {
      type: "assistant/message",
      seq: 3,
      time: time + 400,
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { model: "deepseek-memory", provider: "deepseek-account" },
          content: [{ type: "text", text: "self-test-body" }],
        },
        usage: {
          inputTokens: 10,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
          outputTokens,
          reasoningTokens: 0,
          totalTokens: 12 + outputTokens,
        },
        stream: [
          {
            type: "text-chunks",
            time0: time + 250,
            index: 0,
            dt: [50],
            texts: ["", "self-test-stream"],
          },
          {
            type: "chunk",
            time: time + 350,
            chunk: { type: "usage", usage: { outputTokens } },
          },
          {
            type: "chunk",
            time: time + 400,
            chunk: { type: "finish", reason: { kind: "stop" } },
          },
        ],
      },
    },
    { type: "step/end", seq: 4, data: { turn: 1, step: 1 } },
  ];
}

async function writeSelfTestFile(root, name, frames) {
  const directory = path.join(root, "sessions", name);
  const file = path.join(directory, "session.v4.jsonl.zstd");
  await mkdir(directory, { recursive: true });
  await writeFile(file, Buffer.concat(frames));
  return file;
}

async function runSelfTest(configFile) {
  const root = await mkdtemp(path.join(os.tmpdir(), "dsh-memory-self-test-"));
  try {
    const firstFile = await writeSelfTestFile(root, "first", [
      rowsFrame(selfRows("dsh-memory-self-first", Date.parse("2026-10-30T00:00:00.000Z"), 5)),
    ]);
    const secondRows = selfRows("dsh-memory-self-second", Date.parse("2026-10-30T00:01:00.000Z"), 7);
    const secondFile = await writeSelfTestFile(root, "second", [
      rowsFrame(secondRows.slice(0, 3)),
      damagedFrame(),
      frame(`${JSON.stringify(secondRows[3])}\n${JSON.stringify(secondRows[4])}\n{"broken":\n`),
    ]);
    const entries = [];
    for (const [index, file] of [firstFile, secondFile].entries()) {
      entries.push({
        index,
        file,
        sourceKey: sha256Text(file).slice(0, 16),
        sourceId: `dsh-memory-self-${index + 1}`,
        sourcePath: path.dirname(file),
        compressedBytes: (await stat(file)).size,
      });
    }

    const baseline = await runVariantChild({ configFile, variant: "baseline", entries });
    const candidate = await runVariantChild({ configFile, variant: "candidate", entries });
    const parity = compareVariants(baseline, candidate);
    assert.equal(parity.ok, true, "self-test digests or counts differ");
    for (const variant of [baseline, candidate]) {
      assert.equal(variant.files.length, 2);
      for (const file of variant.files) {
        assert.ok(file.usage.eventCount > 0, "self-test must produce usage events");
        assert.ok(file.perf.sampleCount > 0, "self-test must produce perf samples");
        assert.equal(file.usage.callbackMemory.count, file.usage.eventCount);
        assert.equal(file.perf.callbackMemory.count, file.perf.sampleCount);
      }
    }

    process.stdout.write(
      `${JSON.stringify({
        status: "ok",
        mode: "self-test",
        budget: baseline.budget,
        baseline: {
          files: baseline.files.map((file) => ({
            sourceId: file.sourceId,
            timingMs: file.timingMs,
            usage: {
              eventCount: file.usage.eventCount,
              warningCount: file.usage.warningCount,
              digest: file.usage.digest,
            },
            perf: {
              sampleCount: file.perf.sampleCount,
              warningCount: file.perf.warningCount,
              digest: file.perf.digest,
            },
            combinedDigest: file.combinedDigest,
            processMaxRSSAtFileEnd: file.processMaxRSSAtFileEnd,
          })),
          processResourceUsage: baseline.processResourceUsage,
        },
        candidate: {
          files: candidate.files.map((file) => ({
            sourceId: file.sourceId,
            timingMs: file.timingMs,
            usage: {
              eventCount: file.usage.eventCount,
              warningCount: file.usage.warningCount,
              digest: file.usage.digest,
            },
            perf: {
              sampleCount: file.perf.sampleCount,
              warningCount: file.perf.warningCount,
              digest: file.perf.digest,
            },
            combinedDigest: file.combinedDigest,
            processMaxRSSAtFileEnd: file.processMaxRSSAtFileEnd,
          })),
          processResourceUsage: candidate.processResourceUsage,
        },
        parity,
      })}\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.child) {
    await childMain(options);
  } else if (options.selfTest) {
    await runSelfTest(options.configFile);
  } else {
    await runRealMode(options.configFile);
  }
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
const moduleFile = path.resolve(fileURLToPath(import.meta.url));
if (invokedFile === moduleFile) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
