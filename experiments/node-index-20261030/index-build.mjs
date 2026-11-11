import fs from "node:fs";
import path from "node:path";
const exp = JSON.parse(fs.readFileSync("output/node-index-20261030/experiment.json", "utf8"));
let source = fs.readFileSync(path.join(exp.baselineRoot, "src/usage-store.js"), "utf8");
function replaceOnce(from, to) {
  if (source.split(from).length !== 2) throw Error("Ambiguous index optimization anchor: " + from.slice(0, 90));
  source = source.replace(from, to);
}
replaceOnce("      const previousSessions = existing\n", "      const previousSessions = existing && changedSessions.size > 0\n");
replaceOnce(
  '.prepare("SELECT sample_key, home_id FROM perf_samples WHERE source_kind = \'codex\'")\n      .all())',
  '.prepare("SELECT sample_key, home_id FROM perf_samples WHERE source_kind = \'codex\'")\n      .iterate())',
);
replaceOnce("currentRows: selectCurrent.all(sourcePath),", "currentRows: selectCurrent.iterate(sourcePath),");
replaceOnce(
  '        saveReplacedPerfFacts("perf_samples", previousPerfSamplesByPath, currentPerfSamplesForPath);',
  '        saveReplacedPerfFacts("perf_samples", previousPerfSamplesByPath, currentPerfSamplesForPath);\n        previousPerfSamplesByPath.clear();',
);
replaceOnce(
  '        saveReplacedPerfFacts("perf_sample_sources", previousPerfSampleSourcesByPath, currentPerfSampleSourcesForPath);',
  '        saveReplacedPerfFacts("perf_sample_sources", previousPerfSampleSourcesByPath, currentPerfSampleSourcesForPath);\n        previousPerfSampleSourcesByPath.clear();',
);
const start = source.indexOf("function quotaObservationsFromDatabase(");
const end = source.indexOf("\nfunction publishedUsageSessionsFromEvents", start);
if (start < 0 || end < 0) throw Error("Missing quota loader");
const loader = source.slice(start, end);
if (!loader.includes("    .all()\n    .map((row) => ({")) throw Error("Missing quota materialization anchor");
const compactLoader = loader
  .replace("  return database\n", "  return Array.from(database\n")
  .replace("    .all()\n    .map((row) => ({", "    .iterate(), (row) => ({");
source = source.slice(0, start) + compactLoader + source.slice(end);
fs.writeFileSync(path.join(exp.candidateRoot, "src/usage-store.js"), source);
console.log(JSON.stringify({ candidateRoot: exp.candidateRoot }));
