import fs from "node:fs";
import path from "node:path";
const exp = JSON.parse(fs.readFileSync("output/node-index-20261030/experiment.json", "utf8"));
const variant = process.argv[2] || "baseline";
if (!["baseline", "combined"].includes(variant)) throw Error("Usage: index-profile.mjs [baseline|combined]");
const sourceRoot = variant === "combined" ? exp.combinedRoot : exp.baselineRoot;
fs.cpSync(sourceRoot, exp.profileRoot, { recursive: true });
function transform(file, edits) {
  let text = fs.readFileSync(path.join(sourceRoot, "src", file), "utf8");
  for (const [anchor, label] of edits) {
    if (text.split(anchor).length !== 2) throw Error(`Ambiguous profile anchor ${file}: ${label}`);
    text = text.replace(anchor, `globalThis.__indexStage?.(${JSON.stringify(label)});\n${anchor}`);
  }
  fs.writeFileSync(path.join(exp.profileRoot, "src", file), text);
}
transform("usage-store.js", [
  ["    const homes = await discoverUsageSources(syncOptions);", "sync.discover.start"],
  ["    const { files, warnings, failedHomes = [] } = await this.usageFiles(homes);", "sync.discover.done"],
  ["    const knownFiles = new Set(files.map((file) => file.filePath));", "sync.fingerprint.done"],
  ["    const previousCodexThreadsByPath = new Map();", "sync.workbuddy.done"],
  ["    const codexOldSampleKeysByHome = new Map();", "sync.oldThreads.done"],
  ["    const codexDirtyTimingThreadsByHome = new Map();", "sync.oldKeys.done"],
  ["    const codexPlans = new Map();", "sync.planning.start"],
  ["          window = await planStableCodexHome(", "sync.planHome.start"],
  ["        if (!window.ok || (!window.stable && window.partial !== true) || !window.plan?.ok) {", "sync.planHome.done"],
  ["      const stagedThreads = plan.stagedThreads;", "sync.publishHome.start"],
  ["    const nextServiceTierEvidence = loadServiceTierEvidence(homes);", "sync.evidence.start"],
  ["    const quotaEvidenceSnapshot = JSON.stringify(quotaSourceEvidenceSnapshot(nextQuotaEvidence));", "sync.evidence.loaded"],
]);
transform("usage-core.js", [
  ["    before = await codexPlanningFingerprint(home, files);", "plan.prefix.start"],
  ["      plan = await planCodexHomeThreads(", "plan.prefix.done"],
  ["      after = perfHomeContentFingerprint(home, afterFiles);", "plan.proof.done"],
  ["  if (scanError !== null || before === null || after === null || afterFiles === null) {", "plan.afterProbe.done"],
]);
console.log(JSON.stringify({ profileRoot: exp.profileRoot, variant }));
