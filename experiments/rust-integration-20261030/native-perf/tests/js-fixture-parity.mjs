import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { summarizePerf } from "../../../../src/perf-stats.js";

const [fixturePath, rustBinary] = process.argv.slice(2);
if (!fixturePath || !rustBinary) {
  throw new Error("usage: node tests/js-fixture-parity.mjs FIXTURE RUST_BINARY");
}

const [configLine, ...sampleLines] = fs
  .readFileSync(fixturePath, "utf8")
  .split(/\r?\n/)
  .filter(Boolean);
const config = JSON.parse(configLine);
const samples = sampleLines.map((line, index) => {
  const row = JSON.parse(line);
  return {
    sampleKey: JSON.stringify([row.sourceKind, row.homeId, `fixture-${index}`]),
    sourcePath: "fixture",
    sourceKind: row.sourceKind,
    homeId: row.homeId,
    channel: row.channel,
    agentKind: row.agentKind,
    agent: row.agent,
    sessionId: `session-${index}`,
    turnKey: `turn-${index}`,
    model: row.model,
    modelProvider: row.modelProvider,
    reasoningEffort: row.reasoningEffort,
    modelEvidence: "explicit",
    window: row.window,
    timingKind: row.timingKind,
    timingSource: "explicit",
    tokenScope: row.tokenScope,
    status: row.status,
    tsMs: row.tsMs,
    windowStartMs: null,
    windowEndMs: null,
    durationMs: row.durationMs,
    outputTokens: row.outputTokens,
    inputTokens: null,
    requestCount: null,
    itemCount: null,
    timedItemCount: null,
    sampleFlags: row.sampleFlags,
    diagnosticReason: "fixture",
    diagnosticReasonChain: [],
    methodVersion: row.methodVersion,
  };
});

const expected = summarizePerf(samples, {
  range: null,
  knownSources: config.codexApplicable ? [{ kind: "codex", homeId: "h1" }] : [],
  meta: config.meta,
});
const result = spawnSync(rustBinary, ["--input", fixturePath], {
  encoding: "utf8",
  windowsHide: true,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(JSON.parse(result.stdout), expected);
console.log("JS/Rust fixture parity: OK");
