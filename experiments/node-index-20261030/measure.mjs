import {randomBytes} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {parseArgs} from "node:util";
import {runBenchmark} from "../rust-integration-20261030/benchmark.mjs";
import {verifyResults} from "../rust-integration-20261030/verify.mjs";

export const SCENARIOS = Object.freeze(["baseline", "index", "dsh", "combined", "profile"]);
export const TEMPERATURES = Object.freeze(["warm", "cold"]);

const DEFAULT_CONFIG = path.resolve("output/node-index-20261030/experiment.json");
const SAMPLER_FILE = path.join(import.meta.dirname, "sample-processes.ps1");
const SCENARIO_SOURCE = Object.freeze({
  baseline: "baseline",
  index: "candidate",
  dsh: "compact",
  combined: "candidate",
  profile: "profile",
});
const SCENARIO_ROOT = Object.freeze({
  baseline: "baselineRoot",
  index: "candidateRoot",
  dsh: "compactRoot",
  combined: "combinedRoot",
  profile: "profileRoot",
});

function assertChoice(value, choices, label) {
  if (!choices.includes(value)) throw new Error(`${label} must be one of: ${choices.join(", ")}`);
}

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function splitList(value) {
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(path.resolve(file), "utf8"));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function makeCaseConfig(experiment, {scenario, temperature, runId}) {
  assertChoice(scenario, SCENARIOS, "scenario");
  assertChoice(temperature, TEMPERATURES, "temperature");
  const source = SCENARIO_SOURCE[scenario];
  const root = experiment[SCENARIO_ROOT[scenario]];
  if (!root) throw new Error(`Experiment config has no ${SCENARIO_ROOT[scenario]}`);
  return {
    ...experiment,
    source,
    sourceRoot: root,
    [`${source}Root`]: root,
    scenario,
    temperature,
    runId,
    sampler: SAMPLER_FILE,
  };
}

export function expandCases(scenarios, temperatures, {name = null} = {}) {
  for (const scenario of scenarios) assertChoice(scenario, SCENARIOS, "scenario");
  for (const temperature of temperatures) assertChoice(temperature, TEMPERATURES, "temperature");
  return scenarios.flatMap((scenario) =>
    temperatures.map((temperature) => ({
      scenario,
      temperature,
      name: name ? `${name}-${scenario}-${temperature}` : null,
    })),
  );
}

export async function runSerial(cases, {runner = runCase} = {}) {
  const results = [];
  for (const testCase of cases) results.push(await runner(testCase));
  return results;
}

export async function runCase(
  {configPath = DEFAULT_CONFIG, scenario = "baseline", temperature = "warm", name = null},
  {benchmark = runBenchmark} = {},
) {
  assertChoice(scenario, SCENARIOS, "scenario");
  assertChoice(temperature, TEMPERATURES, "temperature");
  const experiment = await readJson(configPath);
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const runId = safeName(
    name || `${scenario}-${temperature}-${stamp}-${randomBytes(3).toString("hex")}`,
  );
  const caseConfig = makeCaseConfig(experiment, {scenario, temperature, runId});
  const caseConfigFile = path.join(
    path.resolve(experiment.evidence),
    "case-configs",
    `${runId}.json`,
  );
  await writeJson(caseConfigFile, caseConfig);
  const result = await benchmark({
    configPath: caseConfigFile,
    source: SCENARIO_SOURCE[scenario],
    operation: temperature,
    name: runId,
  });
  return {...result, scenario, temperature, caseConfigFile};
}

export function parseMeasureArgs(args = process.argv.slice(2)) {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") return {command: "help"};
  if (command === "run") {
    const parsed = parseArgs({
      args: args.slice(1),
      options: {
        config: {type: "string", default: DEFAULT_CONFIG},
        scenario: {type: "string", default: "baseline"},
        temperature: {type: "string", default: "warm"},
        name: {type: "string"},
        help: {type: "boolean", default: false},
      },
      strict: true,
    });
    return {
      command: "run",
      configPath: path.resolve(parsed.values.config),
      scenarios: splitList(parsed.values.scenario),
      temperatures: splitList(parsed.values.temperature),
      name: parsed.values.name || null,
      help: parsed.values.help,
    };
  }
  if (command === "verify") {
    const parsed = parseArgs({
      args: args.slice(1),
      options: {
        left: {type: "string"},
        right: {type: "string"},
        output: {type: "string"},
        help: {type: "boolean", default: false},
      },
      strict: true,
    });
    return {
      command: "verify",
      left: parsed.values.left ? path.resolve(parsed.values.left) : null,
      right: parsed.values.right ? path.resolve(parsed.values.right) : null,
      output: parsed.values.output ? path.resolve(parsed.values.output) : null,
      help: parsed.values.help,
    };
  }
  throw new Error(`Unknown command: ${command}`);
}

async function main() {
  const options = parseMeasureArgs();
  if (options.command === "help" || options.help) {
    console.log(
      [
        "Usage:",
        "  node measure.mjs run --scenario baseline|index|dsh|combined|profile --temperature warm|cold [--config FILE] [--name NAME]",
        "  node measure.mjs verify --left RESULT.json --right RESULT.json [--output REPORT.json]",
        "Scenario and temperature accept comma-separated lists; cases run serially.",
      ].join("\n"),
    );
    return;
  }
  if (options.command === "run") {
    const cases = expandCases(options.scenarios, options.temperatures, {name: options.name});
    const results = await runSerial(cases, {
      runner: (testCase) => runCase({...testCase, configPath: options.configPath}),
    });
    const summary = results.map((result) => ({
      runId: result.runId,
      scenario: result.scenario,
      temperature: result.temperature,
      passed: result.passed,
      resultFile: result.resultFile,
    }));
    console.log(JSON.stringify(summary, null, 2));
    if (summary.some((row) => !row.passed)) process.exitCode = 1;
    return;
  }
  if (!options.left || !options.right) {
    throw new Error("verify requires --left and --right result files");
  }
  const report = await verifyResults(options.left, options.right);
  if (options.output) {
    await writeJson(options.output, report);
    console.log(JSON.stringify({equal: report.equal, output: options.output}, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  if (!report.equal) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
