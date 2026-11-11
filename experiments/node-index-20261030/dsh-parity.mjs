import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const EXPERIMENT_FILE = path.join(REPO_ROOT, "output", "node-index-20261030", "experiment.json");
const T0 = Date.parse("2026-10-30T00:00:00.000Z");
const SESSION_ID = "session-dsh-node-index-parity";
const SOURCE = Object.freeze({ id: "home-dsh-node-index-parity", label: "DSH parity", path: "/fixture/.dsh" });
const BODY_SENTINEL = "DSH-NODE-INDEX-BODY-MUST-NOT-CROSS-PROJECTION";
const STREAM_SENTINEL = "DSH-NODE-INDEX-STREAM-MUST-NOT-CROSS-PROJECTION";
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const experiment = JSON.parse(fs.readFileSync(EXPERIMENT_FILE, "utf8"));
assert.ok(fs.existsSync(experiment.manifestPath), "configured real-input manifest is missing");
assert.ok(fs.existsSync(experiment.warmDatabase), "configured warm seed is missing");
const manifest = JSON.parse(fs.readFileSync(experiment.manifestPath, "utf8"));

const baselineDsh = await import(pathToFileURL(path.join(experiment.nodeCompactBaseline, "src", "dsh-usage.js")).href);
const baselinePerf = await import(
  pathToFileURL(path.join(experiment.nodeCompactBaseline, "src", "perf-sources", "dsh.js")).href
);
const candidateDsh = await import(pathToFileURL(path.join(experiment.compactRoot, "src", "dsh-usage.js")).href);
const candidatePerf = await import(
  pathToFileURL(path.join(experiment.compactRoot, "src", "perf-sources", "dsh.js")).href
);

function frame(value) {
  return zstdCompressSync(Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8"));
}

function rowsFrame(rows) {
  return frame(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function damagedFrame() {
  return Buffer.concat([ZSTD_MAGIC, Buffer.from("not-a-valid-zstd-frame")]);
}

function requestRow(type, seq, time, model, provider, effort = "max") {
  return {
    type,
    seq,
    time,
    data: {
      header: { config: { model, provider, reasoningEffort: effort } },
    },
  };
}

function stepRow(type, seq, time, turn, step) {
  const row = { type, seq, data: { turn, step } };
  if (time !== undefined) row.time = time;
  return row;
}

function successfulMessage({ seq, time, turn, step, outputTokens, model, provider, large }) {
  const text = large ? `${STREAM_SENTINEL}:${"x".repeat(512 * 1024)}` : STREAM_SENTINEL;
  return {
    type: "assistant/message",
    seq,
    time,
    surfaceOp: "append",
    data: {
      turn,
      step,
      message: {
        role: "assistant",
        source: { model, provider },
        content: [{ type: "text", text: `${BODY_SENTINEL}:${"y".repeat(512 * 1024)}` }],
      },
      usage: {
        inputTokens: 10,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        outputTokens,
        reasoningTokens: 0,
        totalTokens: 13 + outputTokens,
      },
      stream: [
        { type: "reasoning-chunks", time0: time - 90, index: 0, dt: [], texts: ["r"] },
        { type: "text-chunks", time0: time - 60, index: 1, dt: [20], texts: ["", text] },
        {
          type: "tool-call-chunks",
          time0: time - 20,
          index: 2,
          dt: [],
          id: "tool-parity",
          name: "parity",
          args: [text],
        },
        { type: "chunk", time: time - 10, chunk: { type: "usage", usage: { outputTokens } } },
        { type: "chunk", time, chunk: { type: "finish", reason: { kind: "stop" } } },
      ],
    },
  };
}

async function syntheticFile(root) {
  const directory = path.join(root, "sessions", "fixture", SESSION_ID);
  const filePath = path.join(directory, "session.v4.jsonl.zstd");
  await mkdir(directory, { recursive: true });

  const firstMessage = successfulMessage({
    seq: 4,
    time: T0 + 1_000,
    turn: 1,
    step: 1,
    outputTokens: 4,
    model: "model-a",
    provider: "deepseek-account",
    large: true,
  });
  const secondMessage = successfulMessage({
    seq: 8,
    time: T0 + 2_000,
    turn: 2,
    step: 1,
    outputTokens: 6,
    model: "model-b",
    provider: "deepseek-official",
    large: false,
  });
  const session = {
    type: "session",
    version: 4,
    id: SESSION_ID,
    cwd: "E:\\fixture\\dsh-node-index",
    createdAt: T0,
    delegationDepth: 0,
    agentPreset: "中文预设",
  };
  const sessionLine = Buffer.from(`${JSON.stringify(session)}\n`, "utf8");
  const marker = Buffer.from("中文预设", "utf8");
  const markerAt = sessionLine.indexOf(marker);
  assert.notEqual(markerAt, -1);

  await writeFile(
    filePath,
    Buffer.concat([
      rowsFrame([
        requestRow("request/header", 1, T0 + 100, "model-a", "deepseek-account"),
        { type: "session/title", seq: 2, time: T0 + 200, data: { title: "late header parity" } },
        stepRow("step/start", 3, T0 + 500, 1, 1),
        stepRow("llm/retry-started", 3, T0 + 700, 1, 1),
        firstMessage,
        stepRow("step/end", 5, T0 + 9_999, 1, 1),
      ]),
      frame(sessionLine.subarray(0, markerAt + 1)),
      damagedFrame(),
      frame(
        Buffer.concat([
          sessionLine.subarray(markerAt + 1),
          Buffer.from(
            `\n${JSON.stringify(requestRow("request/context", 6, T0 + 1_100, "model-b", "deepseek-official"))}\n`,
            "utf8",
          ),
          Buffer.from(`${JSON.stringify(stepRow("step/start", 7, T0 + 1_200, 2, 1))}\n`, "utf8"),
          Buffer.from(`${JSON.stringify(secondMessage)}\n`, "utf8"),
          Buffer.from(`${JSON.stringify(stepRow("step/end", 9, undefined, 2, 1))}\n`, "utf8"),
          Buffer.from('{"type":"broken-one"\n{"broken":\n', "utf8"),
        ]),
      ),
    ]),
  );
  return filePath;
}

async function collectRowDigest(module, filePath) {
  const hash = createHash("sha256");
  const warnings = [];
  let rows = 0;
  let sessionAgentPreset;
  for await (const row of module.streamDshSessionRows(filePath, {
    onWarning: (warning) => warnings.push(warning),
  })) {
    rows += 1;
    if (row?.type === "session") {
      sessionAgentPreset = row.agentPreset;
    }
    hash.update(JSON.stringify(row));
    hash.update("\n");
  }
  return { rows, digest: hash.digest("hex"), warnings, sessionAgentPreset };
}

async function collectProjection(dshModule, perfModule, filePath) {
  const events = [];
  const eventWarnings = [];
  const trace = [];
  await dshModule.streamDshSessionEvents(
    filePath,
    SOURCE,
    (event) => {
      events.push(event);
      trace.push(`event:${event.eventId}`);
    },
    {
      onWarning: (warning) => {
        eventWarnings.push(warning);
        trace.push(warning.startsWith("MALFORMED_JSON:") ? "warning:json" : "warning:frame");
      },
      repositoryResolver: async (cwd) => ({ key: `fixture:${cwd}`, path: cwd, kind: "fixture" }),
    },
  );

  const samples = [];
  const perfWarnings = [];
  const perfResult = await perfModule.streamDshPerfSamples(filePath, SOURCE, (sample) => samples.push(sample), {
    onWarning: (warning) => perfWarnings.push(warning),
  });
  return { events, eventWarnings, trace, samples, perfWarnings, perfResult };
}

async function compareFile(filePath, label) {
  const baselineRows = await collectRowDigest(baselineDsh, filePath);
  const candidateRows = await collectRowDigest(candidateDsh, filePath);
  assert.deepEqual(candidateRows, baselineRows, `${label}: full-row stream parity`);

  const baseline = await collectProjection(baselineDsh, baselinePerf, filePath);
  const candidate = await collectProjection(candidateDsh, candidatePerf, filePath);
  assert.deepEqual(candidate.events, baseline.events, `${label}: event parity`);
  assert.deepEqual(candidate.eventWarnings, baseline.eventWarnings, `${label}: event warning parity`);
  assert.deepEqual(candidate.trace, baseline.trace, `${label}: warning/event order parity`);
  assert.deepEqual(candidate.samples, baseline.samples, `${label}: TPS sample parity`);
  assert.deepEqual(candidate.perfWarnings, baseline.perfWarnings, `${label}: perf warning parity`);
  assert.deepEqual(candidate.perfResult, baseline.perfResult, `${label}: perf result parity`);
  return { baselineRows, baseline, candidate };
}

const root = await mkdtemp(path.join(os.tmpdir(), "dsh-node-index-parity-"));
try {
  const synthetic = await syntheticFile(root);
  const compared = await compareFile(synthetic, "synthetic");

  assert.equal(compared.baseline.events.length, 2);
  assert.equal(compared.baseline.samples.length, 2);
  assert.deepEqual(
    compared.baseline.events.map((event) => event.model),
    ["model-a", "model-b"],
  );
  assert.deepEqual(
    compared.baseline.samples.map((sample) => sample.model),
    ["model-a", "model-b"],
  );
  assert.match(compared.baselineRows.sessionAgentPreset, /\uFFFD/);
  assert.notEqual(compared.baselineRows.sessionAgentPreset, "中文预设");
  assert.deepEqual(
    compared.baseline.eventWarnings.map((warning) => (warning.startsWith("MALFORMED_JSON:") ? "json" : "frame")),
    ["frame", "json"],
  );
  assert.deepEqual(
    compared.baseline.perfWarnings.map((warning) => warning.code),
    ["MALFORMED_FRAME", "MALFORMED_JSON"],
  );
  const projectedWire = JSON.stringify({
    events: compared.baseline.events,
    samples: compared.baseline.samples,
  });
  assert.equal(projectedWire.includes(BODY_SENTINEL), false);
  assert.equal(projectedWire.includes(STREAM_SENTINEL), false);

  const dshCopies = manifest.copied
    .filter(
      (entry) =>
        typeof entry.copy === "string" &&
        /[\\/]\.dsh[\\/]sessions[\\/]/.test(entry.original) &&
        entry.size >= 20_000 &&
        entry.size <= 300_000 &&
        fs.existsSync(entry.copy),
    )
    .sort((left, right) => left.size - right.size || left.copy.localeCompare(right.copy));
  const targets = [70_000, 140_000, 230_000];
  const used = new Set();
  const realResults = [];

  for (const target of targets) {
    const candidates = [...dshCopies].sort(
      (left, right) =>
        Math.abs(left.size - target) - Math.abs(right.size - target) || left.copy.localeCompare(right.copy),
    );
    let found = false;
    for (const entry of candidates.slice(0, 20)) {
      if (used.has(entry.copy)) continue;
      used.add(entry.copy);
      let baseline;
      try {
        baseline = await collectProjection(baselineDsh, baselinePerf, entry.copy);
      } catch {
        continue;
      }
      if (baseline.events.length === 0 || baseline.samples.length === 0) continue;

      const rows = await collectRowDigest(baselineDsh, entry.copy);
      const candidateRows = await collectRowDigest(candidateDsh, entry.copy);
      assert.deepEqual(candidateRows, rows, "real full-row stream parity");
      const candidate = await collectProjection(candidateDsh, candidatePerf, entry.copy);
      assert.deepEqual(candidate.events, baseline.events, "real event parity");
      assert.deepEqual(candidate.eventWarnings, baseline.eventWarnings, "real event warning parity");
      assert.deepEqual(candidate.trace, baseline.trace, "real warning/event order parity");
      assert.deepEqual(candidate.samples, baseline.samples, "real TPS sample parity");
      assert.deepEqual(candidate.perfWarnings, baseline.perfWarnings, "real perf warning parity");
      assert.deepEqual(candidate.perfResult, baseline.perfResult, "real perf result parity");
      realResults.push({
        compressedBytes: entry.size,
        rows: rows.rows,
        events: baseline.events.length,
        samples: baseline.samples.length,
        warnings: baseline.eventWarnings.length,
      });
      found = true;
      break;
    }
    assert.equal(found, true, `no real DSH file near ${target} bytes produced events and samples`);
  }

  console.log(
    JSON.stringify({
      status: "ok",
      manifestFiles: manifest.copied.length,
      warmSeed: path.basename(experiment.warmDatabase),
      synthetic: {
        rows: compared.baselineRows.rows,
        events: compared.baseline.events.length,
        samples: compared.baseline.samples.length,
        warnings: compared.baseline.eventWarnings.length,
      },
      real: realResults,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
