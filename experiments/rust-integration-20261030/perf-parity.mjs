import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const exp = JSON.parse(fs.readFileSync("output/rust-integration-20261030/experiment.json", "utf8"));
const load = (root, file) => import(pathToFileURL(path.join(root, "src", file)).href);
const base = await load(exp.baselineRoot, "perf-stats.js");
const { UsageStore } = await load(exp.baselineRoot, "usage-store.js");
const targets = [await load(exp.compactRoot, "perf-stats.js"), await load(exp.candidateRoot, "perf-stats.js")];
assert(process.env.RUST_PERF_BIN, "RUST_PERF_BIN is required");
const directory = path.join(exp.work, "perf-parity");
fs.mkdirSync(directory, { recursive: true });
const file = path.join(directory, "index.sqlite");
fs.copyFileSync(exp.warmDatabase, file);
const database = new DatabaseSync(file, { readOnly: true });
const marker = Symbol.for("codex-usage.perf.unique-iterable.v1");
const rows = () => Object.assign((function* () {
  yield* UsageStore.prototype.perfCandidatesForRange.call({ database }, null, [], true);
  yield* UsageStore.prototype.unplacedPerfSamples.call({ database }, [], true);
})(), { [marker]: true });
const knownSources = database.prepare("SELECT DISTINCT source_kind AS kind,home_id AS homeId FROM perf_samples").all();
const meta = JSON.parse(fs.readFileSync(path.join(exp.evidence, "profile-1-all.json"))).summary.perf.meta;
const results = [];
function check(name, factory, options) {
  const expected = base.summarizePerf(factory(), options);
  for (const [index, target] of targets.entries()) {
    const actual = target.summarizePerf(factory(), options);
    assert.deepEqual(actual, expected, `${name}: ${index === 0 ? "node-compact" : "rust-perf"}`);
  }
  results.push({ name, equal: true, eligible: expected.coverage.eligible, unplaced: expected.coverage.unplaced });
  console.log(JSON.stringify(results.at(-1)));
}
try {
  check("real-all", rows, { knownSources, meta });
  check("real-range", rows, { knownSources, meta, range: { startMs: Date.parse("2026-10-20"), endMs: Date.parse("2026-10-22") } });
  check("real-excluded", rows, { knownSources, meta, excludedHomeIds: [knownSources[0].homeId] });
  check("empty", () => Object.assign([][Symbol.iterator](), { [marker]: true }), { knownSources, meta });
  const seed = rows().next().value;
  const edge = Array.from({ length: 40 }, (_, index) => ({
    ...seed, sampleKey: JSON.stringify(["codex", seed.homeId, "edge", String(index)]),
    sourceKind: "codex", model: index % 2 ? "gpt-😀" : "gpt-\uE000", modelProvider: "openai",
    reasoningEffort: "high", methodVersion: "tps-v4", status: "completed", timingKind: "generation",
    tsMs: index % 7 ? 1793200000000 + index : null, outputTokens: index % 11 ? 100 + index : null,
    durationMs: index % 5 ? 1000 + index : null,
    sampleFlags: (index % 3 ? 0 : 65536) | (index % 5 ? 0 : 128) | (index % 11 ? 0 : 256) | (index % 7 ? 0 : 32768),
  }));
  edge.push({ ...edge[0], sampleKey: "edge-overflow", tsMs: 1793200000000, outputTokens: Number.MAX_SAFE_INTEGER, durationMs: 2, sampleFlags: 0 });
  const factory = () => Object.assign(edge.values(), { [marker]: true });
  check("edge-overflow-unplaced-estimate-unicode", factory, { knownSources, meta: { ...meta, minSamples: 1 } });
  fs.writeFileSync(path.join(exp.evidence, "perf-parity.json"), JSON.stringify(results, null, 2));
} finally {
  database.close();
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
}
