import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {runBenchmark} from "../rust-integration-20261030/benchmark.mjs";

export async function runVariant(variant, operation = "warm", name = `${variant}-${operation}`) {
  assert(["baseline", "history", "content", "summary", "candidate", "profile"].includes(variant));
  const config = JSON.parse(await fs.readFile("output/node-startup-20261030/experiment.json", "utf8"));
  const source = variant === "baseline" || variant === "profile" ? variant : "candidate";
  const root = config[variant + "Root"];
  const file = path.join(config.evidence, "case-configs", `${name}.json`);
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, JSON.stringify({
    ...config, source, sourceRoot: root, [source + "Root"]: root, variant,
    sampler: path.resolve("experiments/node-index-20261030/sample-processes.ps1"),
  }, null, 2));
  return runBenchmark({configPath: file, source, operation, name});
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const result = await runVariant(process.argv[2], process.argv[3] || "warm", process.argv[4]);
  console.log(JSON.stringify({passed: result.passed, resultFile: result.resultFile}));
  if (!result.passed) process.exitCode = 1;
}
