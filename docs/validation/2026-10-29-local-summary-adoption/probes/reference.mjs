import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const evidence = path.resolve("output/local-summary-adoption-20261029");
const exp = JSON.parse(await fs.readFile(path.join(evidence, "experiment.json"), "utf8"));
const warmPreset = process.argv[2];
const directory = path.join(exp.work, warmPreset ? "baseline-warm-" + warmPreset : "baseline-cold");
await fs.mkdir(directory, { recursive: true });
const config = {
  ...exp,
  sourceRoot: exp.beforeSourceRoot,
  options: { ...exp.options, databaseFile: path.join(directory, "index.sqlite") },
};
for (const suffix of ["", "-wal", "-shm"]) await fs.rm(config.options.databaseFile + suffix, { force: true });
if (warmPreset) await fs.copyFile(exp.warmDatabase, config.options.databaseFile);
const file = path.join(directory, "config.json");
await fs.writeFile(file, JSON.stringify(config));
const child = fork(path.resolve("docs/validation/2026-10-29-local-summary-endurance/probes/calculator.mjs"), [file], {
  execArgv: ["--max-old-space-size=1024", "--import", pathToFileURL(exp.hookFile).href],
  env: { ...process.env, LOCAL_SUMMARY_CASE_CONFIG: file },
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});
let result;
let stderr = "";
child.stderr.on("data", (data) => { stderr += data; });
child.on("message", (message) => {
  if (message.type === "ready") child.send({
    type: "job", id: "baseline", operation: warmPreset ? "query" : "refresh", includeDetails: false,
    filters: { preset: warmPreset || "today", bucket: !warmPreset || warmPreset === "today" ? "hour" : warmPreset === "quota_week" ? "quota_24h" : "day", calendarZone: "local", startDate: "", endDate: "", recentValue: "", excludeHomes: [], now: exp.fixedNow },
  });
  if (message.type === "result") result = message;
});
const code = await new Promise((resolve) => child.once("close", resolve));
assert.equal(code, 0, stderr);
assert(result?.ok, result?.error);
const comparable = (payload) => Object.fromEntries(["summary", "metadata", "periodComparison", "pricingCatalog", "quota"].map((key) => [key, payload[key]]));
const reference = comparable(result.payload);
const name = warmPreset ? "baseline-warm-" + warmPreset : "baseline-cold";
await fs.writeFile(path.join(evidence, name + "-payload.json"), JSON.stringify(reference));
const targets = warmPreset ? ["adoption-warm-final-" + warmPreset] : ["adoption-cold-today", "adoption-migration-today"];
for (const target of targets) {
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(evidence, target + ".json"), "utf8")), reference, target);
}
const canonical = (v) => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v;
const hash = createHash("sha256").update(JSON.stringify(canonical(reference))).digest("hex");
await fs.writeFile(path.join(evidence, name + "-result.json"), JSON.stringify({
  role: "Independent pre-adoption engine, excluded from target memory", sourceRoot: config.sourceRoot,
  hash, metrics: result.metrics, targets, equal: true,
}, null, 2));
console.log(JSON.stringify({ hash, targets, equal: true }));
