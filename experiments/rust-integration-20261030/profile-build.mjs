import fs from "node:fs";
import path from "node:path";

const exp = JSON.parse(fs.readFileSync("output/rust-integration-20261030/experiment.json", "utf8"));
const root = path.join(exp.profileRoot, "src");
function transform(file, run) {
  const target = path.join(root, file);
  const original = fs.readFileSync(path.join(exp.baselineRoot, "src", file), "utf8");
  let value = original;
  const replace = (from, to) => {
    if (value.split(from).length !== 2) throw Error(`Ambiguous profile anchor: ${file}: ${from.slice(0, 90)}`);
    value = value.replace(from, to);
  };
  run(replace);
  fs.writeFileSync(target, value);
}
transform("perf-stats.js", (replace) => {
  replace("export function summarizePerf(samples, options = {}) {", "export function summarizePerf(samples, options = {}) { globalThis.__rustProfile?.('perf.start');");
  replace("  return selection;\n}", "  globalThis.__rustProfile?.('perf.selection.done', {eligible:selection.eligible.length,unplaced:selection.unplaced.length}); return selection;\n}");
  replace("  const coverage = computePerfCoverageWithBreakdown(selection, eraCutoffMs);", "  const coverage = computePerfCoverageWithBreakdown(selection, eraCutoffMs); globalThis.__rustProfile?.('perf.coverage.done');");
  replace("  const minSamples = opts.meta?.minSamples ?? PERF_MIN_SAMPLES;", "  globalThis.__rustProfile?.('perf.codexCoverage.done'); const minSamples = opts.meta?.minSamples ?? PERF_MIN_SAMPLES;");
  replace("  let nextRank = 1;", "  globalThis.__rustProfile?.('perf.groups.sorted',{groups:groups.length}); let nextRank = 1;");
  replace("models: projectPerfModels(selection.eligible, minSamples, selection.eligible),", "models: globalThis.__rustProfileValue('perf.models', () => projectPerfModels(selection.eligible, minSamples, selection.eligible)),");
});
transform("usage-executor.js", (replace) => {
  replace("return JSON.parse(JSON.stringify(value));", "globalThis.__rustProfile?.('wire.start'); const text = JSON.stringify(value); globalThis.__rustProfile?.('wire.stringify',{bytes:Buffer.byteLength(text)}); const result = JSON.parse(text); globalThis.__rustProfile?.('wire.done'); return result;");
});
console.log(JSON.stringify({ profileRoot: exp.profileRoot }));
