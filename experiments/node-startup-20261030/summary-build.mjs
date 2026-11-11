import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const experimentFile = path.resolve("output/node-startup-20261030/experiment.json");

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  assert.equal(count, 1, `${label}: expected exactly one baseline anchor, found ${count}`);
  return source.replace(from, to);
}

/**
 * Build the summary candidate from the frozen baseline source.
 *
 * The only behavioral changes are:
 * 1. read quota observations once inside the summary read transaction;
 * 2. reuse one model-normalized pricing function across the full-history
 *    record scan instead of rebuilding normalization and memo keys per row.
 */
export function transformSource(source) {
  assert.equal(typeof source, "string", "source must be a string");
  let transformed = source;

  transformed = replaceOnce(
    transformed,
    "    const quota = selectQuotaWindows(this.quotaObservations(), asOf);\n",
    "    const quotaObservations = this.quotaObservations();\n    const quota = selectQuotaWindows(quotaObservations, asOf);\n",
    "quota observations read",
  );
  transformed = replaceOnce(
    transformed,
    "      ? previousQuotaRange(range, quota, this.quotaObservations())\n",
    "      ? previousQuotaRange(range, quota, quotaObservations)\n",
    "previous quota range",
  );
  transformed = replaceOnce(
    transformed,
    "            ? quotaRecordsForRange(range, quota, this.quotaObservations(), (window) => {\n",
    "            ? quotaRecordsForRange(range, quota, quotaObservations, (window) => {\n",
    "quota records",
  );
  transformed = replaceOnce(
    transformed,
    `    // W4-b1 / D1：全历史扫描的逐行计价也走同一个事件计价 memo（整段包成**一轮**：轮内放宽到
    // 192 MiB，轮末收敛回 64 MiB），并注入给 \`buildRecordChampions\` —— 注入而非改源码形状，
    // 共享门禁的锚点因此**零变更**。
`,
    `    // Price the full-history scan through one request-local model dictionary.
    // This keeps the estimator and unknown-value semantics unchanged while
    // avoiding per-row model normalization and event-memo key construction.
`,
    "record-scan pricing comment",
  );
  transformed = replaceOnce(
    transformed,
    `    const champions =
      memoized ??
      this.withEventCostMemoRound(() =>
        this.buildRecordChampions(zone, where, scope.params, usdToCnyRate, (event) =>
          this.eventCostMemo.estimate(event),
        ),
      );
`,
    `    const champions =
      memoized ??
      (() => {
        const eventPricing = createEventPricing();
        return this.buildRecordChampions(zone, where, scope.params, usdToCnyRate, (event) =>
          eventPricing.estimate(event),
        );
      })();
`,
    "record-scan model pricing",
  );

  assert.ok(
    transformed.includes("const eventPricing = createEventPricing();"),
    "candidate must reuse one model-normalized pricing function for the record scan",
  );
  assert.ok(
    transformed.includes("previousQuotaRange(range, quota, quotaObservations)"),
    "candidate must reuse the quota observation mapping",
  );
  return transformed;
}

function main() {
  const experiment = JSON.parse(fs.readFileSync(experimentFile, "utf8"));
  const baselineFile = path.join(experiment.baselineRoot, "src", "usage-store.js");
  const summaryFile = path.join(experiment.summaryRoot, "src", "usage-store.js");
  const source = fs.readFileSync(baselineFile, "utf8");
  const candidate = transformSource(source);
  fs.mkdirSync(path.dirname(summaryFile), { recursive: true });
  fs.writeFileSync(summaryFile, candidate, "utf8");
  process.stdout.write(
    `${JSON.stringify({
      baseline: baselineFile,
      summary: summaryFile,
      baselineBytes: Buffer.byteLength(source),
      summaryBytes: Buffer.byteLength(candidate),
    })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
