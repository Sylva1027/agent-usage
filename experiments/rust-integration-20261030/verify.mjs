import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {compareComparable} from "./benchmark.mjs";

async function readJson(file) {
  return JSON.parse(await fs.readFile(path.resolve(file), "utf8"));
}

export async function verifyResults(leftFile, rightFile) {
  const [left, right] = await Promise.all([readJson(leftFile), readJson(rightFile)]);
  const leftRows = new Map(left.responses.map((row) => [row.label, row]));
  const rightRows = new Map(right.responses.map((row) => [row.label, row]));
  const labels = [...new Set([...leftRows.keys(), ...rightRows.keys()])].sort();
  const comparisons = [];
  for (const label of labels) {
    const leftRow = leftRows.get(label);
    const rightRow = rightRows.get(label);
    if (!leftRow || !rightRow) {
      comparisons.push({
        label,
        equal: false,
        fields: {},
        differences: [{path: "$.response", left: Boolean(leftRow), right: Boolean(rightRow)}],
      });
      continue;
    }
    const [leftPayload, rightPayload] = await Promise.all([
      readJson(leftRow.payloadFile),
      readJson(rightRow.payloadFile),
    ]);
    comparisons.push({label, ...compareComparable(leftPayload, rightPayload)});
  }
  return {
    equal: left.fixedNow === right.fixedNow && comparisons.every((row) => row.equal),
    fixedNow: {left: left.fixedNow, right: right.fixedNow, equal: left.fixedNow === right.fixedNow},
    labels,
    comparisons,
    memory: {left: left.memory, right: right.memory},
    results: {left: path.resolve(leftFile), right: path.resolve(rightFile)},
  };
}

async function main() {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      left: {type: "string"},
      right: {type: "string"},
      output: {type: "string"},
    },
    strict: true,
  });
  const left = parsed.values.left || parsed.positionals[0];
  const right = parsed.values.right || parsed.positionals[1];
  assert(left && right, "Usage: verify.mjs <left-result.json> <right-result.json> [--output FILE]");
  const report = await verifyResults(left, right);
  if (parsed.values.output) {
    await fs.writeFile(path.resolve(parsed.values.output), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.equal) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
