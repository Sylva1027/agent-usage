import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = path.resolve(process.env.REMAINING_DELIVERY_ROOT || fileURLToPath(new URL("../../output/source-prefix-publish-20261106/", import.meta.url)));
process.env.REMAINING_DELIVERY_ROOT = base;
const { analyze } = await import("./remaining-harness-delivery-analyze.mjs");
const analysis = await analyze();
const rows = [];
for (const pair of analysis.rows) {
  for (const variant of ["baseline", "candidate"]) {
    const directory = path.join(base, "formal", `${pair.kind}-${variant}`);
    const result = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8"));
    const files = (await readdir(path.join(directory, "nodes"))).filter((name) => /^prefix-.*\.ndjson$/.test(name));
    const receipts = (await Promise.all(files.map(async (name) => (await readFile(path.join(directory, "nodes", name), "utf8"))
      .trim().split("\n").filter(Boolean).map(JSON.parse)))).flat();
    for (const receipt of receipts) {
      assert.equal(receipt.error, undefined);
      if (receipt.result.reusedPrefix) {
        assert.equal(receipt.eventMutations, receipt.result.insertedEvents);
        assert.equal(receipt.result.checkedEvents, receipt.result.reusedEvents + receipt.result.insertedEvents);
      }
    }
    for (const change of result.changes) {
      const publications = receipts.filter((row) => row.kind === pair.kind && row.endedAtMs >= change.landedAtMs
        && row.startedAtMs <= change.endedAtMs);
      assert.ok(publications.length, `${pair.kind}/${variant}/${change.label}: no publication receipt`);
      const reused = publications.filter((row) => row.result.reusedPrefix);
      if (variant === "candidate" && pair.kind === "zcode" && change.label === "append-2") {
        assert.equal(reused.length, publications.length, "the measured second append must actually reuse its prefix");
        assert.equal(reused.reduce((sum, row) => sum + row.eventMutations, 0), 1);
      }
      if (change.label === "revision") {
        assert.ok(publications.some((row) => !row.result.reusedPrefix && row.eventMutations > 0), "old changes require full replacement");
        assert.ok(reused.every((row) => row.result.insertedEvents === 0), "only a later unchanged check may reuse revised facts");
      }
      rows.push({ kind: pair.kind, variant, change: change.label,
        calls: publications.length, reusedCalls: reused.length,
        eventMutations: publications.reduce((sum, row) => sum + row.eventMutations, 0),
        publicationMs: publications.reduce((sum, row) => sum + row.durationMs, 0),
        checkedEvents: reused.reduce((sum, row) => sum + row.result.checkedEvents, 0),
        reusedEvents: reused.reduce((sum, row) => sum + row.result.reusedEvents, 0) });
    }
  }
}
const target = analysis.rows.find((row) => row.kind === "zcode").latency["append-2"];
const summary = { rows, zcodeSecondAppend: { ...target, targetRatio: 0.8, passed: target.ratio <= 0.8 },
  latencyPassed: analysis.triggers.length === 0, resourcePassed: analysis.resourcePassed,
  pairedResponses: analysis.pairedResponses, numericChecks: analysis.numericChecks };
await writeFile(path.join(base, "publication-analysis.json"), `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
