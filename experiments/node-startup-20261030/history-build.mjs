import fs from "node:fs";
import path from "node:path";

export function transformHistory(source) {
  const replace = (from, to) => {
    if (source.split(from).length !== 2) throw Error("Ambiguous history anchor: " + from.slice(0, 90));
    source = source.replace(from, to);
  };
  replace(
    "  dirtyTimingThreadIds,\n) {\n  if (dirtyTimingThreadIds instanceof Set",
    "  dirtyTimingThreadIds,\n  acknowledgedMissingPaths,\n) {\n  if (dirtyTimingThreadIds instanceof Set",
  );
  replace(
    "  if (!(oldPaths instanceof Set) || oldPaths.size !== thread.rolloutFiles.length) return true;",
    `  if (!(oldPaths instanceof Set)) return true;
  if (oldPaths.size !== thread.rolloutFiles.length) {
    let missingCount = 0;
    for (const filePath of oldPaths) if (acknowledgedMissingPaths?.has(filePath)) missingCount++;
    if (oldPaths.size - missingCount !== thread.rolloutFiles.length) return true;
  }`,
  );
  replace(
    "    const publishedCodexWarnings = this.publishedFileWarningsForRead();",
    `    const publishedCodexWarnings = this.publishedFileWarningsForRead();
    // Missing dependencies already acknowledged by a successful publication stay in history.
    const acknowledgedMissingSources =
      this.readMetaRaw("perf_state") === PERF_STATE_READY &&
      this.readMetaRaw("perf_method_version") === PERF_METHOD_VERSION
        ? decodeMissingSources(this.readMetaRaw(MISSING_SOURCES_META))
        : [];`,
  );
  replace(
    "        const stagedThreads = [];\n        const retainedThreadIds = [];",
    `        const stagedThreads = [];
        const retainedThreadIds = [];
        const acknowledgedMissingPaths = new Set(
          (policyNeedsUpgrade ? [] : acknowledgedMissingSources)
            .filter((source) =>
              source.homeId === homeId && canonicalizeKind(source.kind) === "codex" &&
              !currentCodexPaths.has(source.path) && !replacementTargetByOldPath.has(source.path))
            .map((source) => source.path),
        );`,
  );
  replace(
    "              dirtyTimingThreadIds,\n            )",
    "              dirtyTimingThreadIds,\n              acknowledgedMissingPaths,\n            )",
  );
  return source;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const config = JSON.parse(fs.readFileSync("output/node-startup-20261030/experiment.json", "utf8"));
  const file = "src/usage-store.js";
  fs.writeFileSync(path.join(config.historyRoot, file), transformHistory(fs.readFileSync(path.join(config.baselineRoot, file), "utf8")));
  console.log(JSON.stringify({historyRoot: config.historyRoot}));
}
