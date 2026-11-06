import assert from "node:assert/strict";
import path from "node:path";
import { BASE, read, save } from "./remaining-harness-delivery-prepare.mjs";
import { business, regressed, resources } from "./remaining-harness-delivery-analyze.mjs";

const countNumbers = (value) => typeof value === "number" ? 1 : value && typeof value === "object"
  ? Object.values(value).reduce((sum, child) => sum + countNumbers(child), 0) : 0;
const pairs = [
  ["opencode", "diagnostic-old-1", "diagnostic-current-1"],
  ["opencode", "diagnostic-old-2", "diagnostic-current-2"],
  ["claude", "diagnostic-claude-old", "diagnostic-claude-current"],
];
let numericChecks = 0, pairedResponses = 0;
const rows = [];
for (const [kind, oldLabel, currentLabel] of pairs) {
  const leftDir = path.join(BASE, "formal", oldLabel), rightDir = path.join(BASE, "formal", currentLabel);
  const old = await read(path.join(leftDir, "result.json")), current = await read(path.join(rightDir, "result.json"));
  assert.ok(old.passed && current.passed);
  const reference = (await read(path.join(BASE, `plan-${kind}.json`))).appendTimeMs;
  for (const stage of ["initial", "append-1", "append-2", "revision", "scope-today", "scope-week", "scope-all", "reopen"]) {
    const before = business(await read(path.join(leftDir, `${stage}.json`)), reference);
    const after = business(await read(path.join(rightDir, `${stage}.json`)), reference);
    assert.deepEqual(after, before, `${oldLabel}/${currentLabel}/${stage}`);
    numericChecks += countNumbers(before); pairedResponses++;
  }
  const metric = (result, name) => name === "initial" ? result.initialServiceWallMs : name === "reopen" ? result.reopen.wallMs
    : ["today", "week", "all"].includes(name) ? result.scopes.find((row) => row.preset === name).wallMs
    : result.changes.find((row) => row.label === name).actualPaintMs;
  rows.push({ kind, oldLabel, currentLabel,
    latency: Object.fromEntries(["initial", "append-1", "append-2", "revision", "today", "week", "all", "reopen"].map((name) => {
      const baselineMs = metric(old, name), currentMs = metric(current, name);
      return [name, { baselineMs, currentMs, trigger: regressed(baselineMs, currentMs) }];
    })), resources: { baseline: await resources(leftDir), current: await resources(rightDir) } });
}
const result = { groups: 6, pairs: rows, pairedResponses, numericChecks, productionChangedDuringDiagnostics: false };
await save(path.join(BASE, "diagnostics.json"), result);
console.log(JSON.stringify({ groups: result.groups, pairedResponses, numericChecks,
  triggers: rows.flatMap((row) => Object.entries(row.latency).filter(([, value]) => value.trigger).map(([metric]) => ({ group: row.currentLabel, metric }))) }));
