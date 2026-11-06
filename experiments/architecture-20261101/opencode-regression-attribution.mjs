import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BASE } from "./remaining-harness-delivery-prepare.mjs";

const labels = process.argv.slice(2);
assert.ok(labels.length);
const output = [];
for (const label of labels) {
  assert.match(label, /^[a-z0-9-]+$/);
  const directory = path.join(BASE, "formal", label);
  const result = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8"));
  assert.equal(result.passed, true);
  const files = (await readdir(path.join(directory, "nodes"))).filter((file) => file.startsWith("detail-") && file.endsWith(".ndjson"));
  const rows = (await Promise.all(files.map(async (file) => (await readFile(path.join(directory, "nodes", file), "utf8"))
    .trim().split("\n").filter(Boolean).map(JSON.parse)))).flat();
  assert.ok(rows.length);
  assert.ok(rows.filter((row) => "dropped" in row).every((row) => row.dropped === 0));
  const phases = [{ label: "initial", start: result.initial.endedAtMs - result.initialServiceWallMs,
    end: result.initial.endedAtMs, totalMs: result.initialServiceWallMs },
  ...result.changes.map((row) => ({ label: row.label, start: row.landedAtMs, end: row.endedAtMs, totalMs: row.actualPaintMs })),
  ...result.scopes.map((row) => ({ label: row.preset, start: row.startedAtMs, end: row.endedAtMs, totalMs: row.wallMs }))];
  output.push({ label, phases: phases.map((phase) => {
    const selected = rows.filter((row) => row.start >= phase.start - 1 && row.start <= phase.end);
    const names = [...new Set(selected.map((row) => row.name))];
    return { ...phase, spans: names.map((name) => {
      const spans = selected.filter((row) => row.name === name);
      return { name, calls: spans.length, inclusiveMs: spans.reduce((sum, row) => sum + row.durationMs, 0),
        details: spans.filter((row) => row.work || row.before).map((row) => ({ work: row.work, before: row.before, after: row.after })) };
    }).sort((a, b) => b.inclusiveMs - a.inclusiveMs) };
  }) });
}
const target = path.join(BASE, `attribution-${labels.join("--")}.json`);
await writeFile(target, `${JSON.stringify(output, null, 2)}\n`, { flag: "wx" });
console.log(JSON.stringify({ file: target, groups: output.length, nestedSpansMustNotBeAdded: true }));
