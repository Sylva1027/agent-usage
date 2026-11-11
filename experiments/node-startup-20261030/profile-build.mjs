import fs from "node:fs";
import path from "node:path";
const config = JSON.parse(fs.readFileSync("output/node-startup-20261030/experiment.json", "utf8"));
const variant = process.argv[2] || "baseline";
if (!["baseline", "candidate", "history", "summary", "content"].includes(variant)) throw Error("Unknown profile variant");
const root = config[variant + "Root"];
fs.cpSync(root, config.profileRoot, {recursive: true});
const historyChanged = fs.readFileSync(path.join(root, "src/usage-store.js"), "utf8").includes("  acknowledgedMissingPaths,");
function transform(file, edits) {
  let source = fs.readFileSync(path.join(root, "src", file), "utf8");
  for (const [from, to] of edits) {
    if (source.split(from).length !== 2) throw Error("Ambiguous profile anchor: " + from.slice(0, 80));
    source = source.replace(from, to);
  }
  fs.writeFileSync(path.join(config.profileRoot, "src", file), source);
}
const mark = (anchor, label) => [anchor, `globalThis.__indexStage?.(${JSON.stringify(label)});\n${anchor}`];
transform("usage-core.js", [
  mark("    before = await codexPlanningFingerprint(home, files);", "plan.prefix.start"),
  mark("      plan = await planCodexHomeThreads(", "plan.prefix.done"),
  mark("      after = perfHomeContentFingerprint(home, afterFiles);", "plan.proof.done"),
  mark("  if (scanError !== null || before === null || after === null || afterFiles === null) {", "plan.afterProbe.done"),
]);
transform("usage-store.js", [
  mark("    const homes = await discoverUsageSources(syncOptions);", "sync.discover.start"),
  mark("    const { files, warnings, failedHomes = [] } = await this.usageFiles(homes);", "sync.discover.done"),
  mark("    const knownFiles = new Set(files.map((file) => file.filePath));", "sync.fingerprint.done"),
  mark("    const previousCodexThreadsByPath = new Map();", "sync.workbuddy.done"),
  mark("    const codexDirtyTimingThreadsByHome = new Map();", "sync.oldKeys.done"),
  mark("          window = await planStableCodexHome(", "sync.planHome.start"),
  mark("        if (!window.ok || (!window.stable && window.partial !== true) || !window.plan?.ok) {", "sync.planHome.done"),
  mark("      const stagedThreads = plan.stagedThreads;", "sync.publishHome.start"),
  mark("    const nextServiceTierEvidence = loadServiceTierEvidence(homes);", "sync.evidence.start"),
  ["  if (dirtyTimingThreadIds instanceof Set && dirtyTimingThreadIds.has(thread.threadId)) return true;", `  const note = (reason, extra = {}) => { globalThis.__indexStage?.("history.build.reason", {thread: createHash("sha256").update(thread.threadId).digest("hex").slice(0, 12), reason, ...extra}); return true; };\n  if (dirtyTimingThreadIds instanceof Set && dirtyTimingThreadIds.has(thread.threadId)) return note("timing-dirty");`],
  ['  if (!(oldThreadIds instanceof Set) || !oldThreadIds.has(thread.threadId)) return true;', '  if (!(oldThreadIds instanceof Set) || !oldThreadIds.has(thread.threadId)) return note("thread-new");'],
  historyChanged
    ? ['  if (!(oldPaths instanceof Set)) return true;', '  if (!(oldPaths instanceof Set)) return note("path-set-missing");']
    : ['  if (!(oldPaths instanceof Set) || oldPaths.size !== thread.rolloutFiles.length) return true;', '  if (!(oldPaths instanceof Set) || oldPaths.size !== thread.rolloutFiles.length) return note("path-set-size", {oldCount: oldPaths?.size ?? null, currentCount: thread.rolloutFiles.length, oldOnly: oldPaths ? [...oldPaths].filter(p => !thread.rolloutFiles.includes(p)).length : null});'],
  ...(historyChanged ? [['    if (oldPaths.size - missingCount !== thread.rolloutFiles.length) return true;', '    if (oldPaths.size - missingCount !== thread.rolloutFiles.length) return note("path-set-size");']] : []),
  ['    if (!oldPaths.has(filePath)) return true;', '    if (!oldPaths.has(filePath)) return note("path-membership");'],
  ['    if (typeof after !== "string" || after !== publishedFingerprints?.[filePath]) return true;', '    if (typeof after !== "string" || after !== publishedFingerprints?.[filePath]) return note("fingerprint", {missingAfter: typeof after !== "string", missingPublished: !publishedFingerprints?.[filePath]});'],
  mark('          let rollouts = thread.rollouts;', "history.hydrate.start"),
  mark('          const built = buildCodexThreadPerfSamples(homeId, thread.threadId, rollouts, {', "history.hydrate.done"),
  mark('          stagedThreads.push({', "history.build.done"),
]);
console.log(JSON.stringify({variant, root: config.profileRoot}));
