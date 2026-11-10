import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import * as d from "./windows-stability-run.mjs";
import { browser, expectedAll, stop } from "./c1-run.mjs";
import { projectionStorage } from "./c1-telemetry.mjs";
import { prepareStabilityMutations } from "./windows-stability-mutations.mjs";
import { snapshot, recover, cleanupSnapshot, contained, PUBLICATION_CARD, runContinuous, waitForOracleIdle, stopOwned, assertInternalRecovery } from "./live-source-recovery-run.mjs";
import { controls, resources, resourceChecks, gates, finish, streamNdjson, controlChecks } from "./windows-stability-analyze.mjs";
import { CLOSEOUT_PROFILE } from "./windows-stability-schedule.mjs";
import { ROOT } from "./windows-closeout-cost.mjs";

const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const save = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", flush: true }); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = async file => { const value = createHash("sha256"); for await (const bytes of createReadStream(file)) value.update(bytes); return value.digest("hex"); };
const log = (context, type, values) => fs.appendFile(path.join(context.directory, "events.ndjson"), JSON.stringify({ ...values, type, atMs: Date.now() }) + "\n");
const rows = async file => { const result = [], errors = []; await streamNdjson(file, row => result.push(row), errors); assert.deepEqual(errors, []); return result; };

async function verifyRuntime(config) {
  const receipt = await read(path.resolve("output/committed-publication-20261110/candidate-runtime.json"));
  assert.equal(config.runtime, receipt.directory); assert.equal(receipt.files.length, 119);
  for (const entry of receipt.files) {
    assert.equal(await hash(path.join(receipt.directory, entry.relative)), entry.sha256);
    assert.equal(await hash(path.resolve(entry.relative)), entry.sha256);
  }
  return { files: receipt.files.length, verified: true, commit: "811718a", checkedAt: new Date().toISOString() };
}

export async function analyze(directory) {
  const result = await read(path.join(directory, "result.json")), evidence = [], control = await controls(path.join(directory, "control"), evidence);
  const events = await rows(path.join(directory, "events.ndjson")), nodeRows = [];
  for (const entry of await fs.readdir(path.join(directory, "nodes"))) if (/^node-\d+\.jsonl$/.test(entry)) nodeRows.push(...await rows(path.join(directory, "nodes", entry)));
  const summary = await read(path.join(directory, "resource-summary.json"));
  const profile = { profile: CLOSEOUT_PROFILE, events: [], cycles: result.cycles.map(row => ({ idleFromMs: row.idleStartedAtMs - result.startedAtMs, idleToMs: row.idleEndedAtMs - result.startedAtMs })) };
  const phase = { mode: "closeout-soak", expectedSchedule: profile, schedule: { startedAtMs: result.startedAtMs }, inputs: result.inputs, result };
  const allResponses = events.filter(row => row.type === "response" && row.preset === "all");
  const observations = { faults: [], closed: await read(path.join(directory, "closed.json")), firstAllResponse: allResponses[0], lastAllResponse: allResponses.at(-1) };
  const memory = await resources(directory, await fs.readdir(directory, { withFileTypes: true }), [summary], control, nodeRows, phase, observations, evidence);
  const resource = gates(); resourceChecks("two-years", memory, [summary], [phase], await read(path.join(directory, "closed.json")), resource);
  resource.checks.push({ id: "complete-final-costs", status: summary.counterCoverage?.complete ? "passed" : "incomplete", evidence: summary.counterCoverage });
  const reliability = gates(); controlChecks("two-years", control, observations, [phase], reliability);
  const previousFile = path.resolve("output/committed-publication-20261110/short/two-years/candidate/analysis.json");
  const previous = await read(previousFile);
  for (const check of reliability.checks.filter(row => /ordinary-projection-reuse|ordinary-zcode-net-added/.test(row.id))) {
    const prior = previous.reliability.checks.find(row => row.id === check.id);
    assert.equal(prior?.status, "passed");
    check.status = "passed"; check.evidence = { reusedFrom: previousFile, reason: "No ordinary/ZCode mutation in this frozen-runtime card", prior: prior.evidence };
  }
  const activeProjection = control.projections.filter(row => result.cycles.some(cycle => row.atMs >= cycle.startedAtMs && row.atMs <= cycle.tabsSettled.atMs));
  reliability.checks.push({ id: "continuous-projection-reuse", status: activeProjection.length && activeProjection.every(row => row.coldCopied === 0 && row.fullRebuild === false) ? "passed" : "failed", evidence: activeProjection });
  const checks = [
    { id: "known-node-cost-coverage", passed: control.processes.every(node => summary.counterCoverage?.processes.some(member => member.pid === node.pid && Math.abs(Date.parse(member.startTimeUtc) - node.startedAtMs) < 1000 && member.final)) },
    { id: "four-cycles", passed: result.cycles.length === 4 && result.cycles.every(row => row.passed) },
    { id: "72-visible-inputs", passed: result.inputs.length === 72 && result.inputs.every(row => row.paintedAtMs && row.usageVersion) },
    { id: "six-oracles", passed: events.filter(row => row.type === "oracle" && row.result?.passed && !row.result.retry && !row.result.skipped).length === 6 },
    { id: "no-unexpected-http", passed: !events.some(row => row.type === "http-error") },
    { id: "reopen", passed: Boolean(result.reopen) },
    { id: "normal-execution", passed: !result.failure && !result.cleanupError && !result.restorationError },
  ];
  for (const check of checks) reliability.checks.push({ id: check.id, status: check.passed ? "passed" : "failed" });
  try {
    for (const cycle of result.cycles) {
      const current = control.sources.filter(row => row.atMs >= cycle.startedAtMs && row.atMs <= cycle.tabsSettled.atMs);
      const combined = [];
      for (const entry of await fs.readdir(path.join(directory, "control"))) if (/^events-\d+\.ndjson$/.test(entry)) combined.push(...await rows(path.join(directory, "control", entry)));
      assertInternalRecovery(combined.filter(row => row.atMs >= cycle.startedAtMs && row.atMs <= cycle.tabsSettled.atMs), cycle,
        events.map(row => row.name === `cycle-${cycle.cycle}-continuous-final` ? { ...row, name: "continuous-final" } : row));
      assert.ok(current.length > 0);
    }
    reliability.checks.push({ id: "internal-recovery", status: "passed" });
  } catch (error) { reliability.checks.push({ id: "internal-recovery", status: "failed", evidence: error.message }); }
  finish(resource); finish(reliability);
  return { passed: resource.passed && reliability.passed && !evidence.length, resource, reliability, memory, evidence,
    costs: summary.counterCoverage, workload: { cycles: result.cycles.length, appends: result.inputs.length, reopens: result.reopen ? 1 : 0 } };
}

async function run() {
  assert.equal((await read(path.join(ROOT, "cost-calibration-v2.json"))).passed, true);
  const old = await read(path.resolve("output/committed-publication-20261110/short/two-years/candidate/config.json"));
  const config = { ...old, directory: path.join(ROOT, "four-cycles"), startState: path.join(ROOT, "snapshots/two-years") };
  const runtime = await verifyRuntime(config); await save(path.join(ROOT, "runtime-verification.json"), runtime);
  const prepared = await snapshot(config, ROOT); await save(path.join(ROOT, "preparation.json"), prepared);
  await fs.mkdir(config.directory); await save(path.join(config.directory, "config.json"), config);
  const result = { startedAtMs: Date.now(), cycles: [], inputs: [], passed: false };
  let context;
  const cancel = () => { if (context) context.cancelled = true; };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    const dataset = await read(config.datasetFile), control = path.join(config.directory, "control"); await fs.mkdir(control);
    const ledger = await prepareStabilityMutations(dataset, path.join(config.directory, "mutations"), { databaseFile: path.join(config.seedDirectory, "usage-index.sqlite"), runtimeDirectory: config.runtime });
    const base = await d.retainedLedger(config.baseLedgerFile, config.baseMutationsFile), entry = await read(config.entryFile);
    assert.equal(entry.rawAppendCount, base.appendCount); assert.equal(entry.revisionCount, base.revisionCount);
    for (const row of entry.sources) assert.equal(await hash(row.file), row.sha256);
    d.inheritCloseoutLedger(ledger, base); await save(path.join(config.directory, "base-ledger.json"), ledger);
    const seed = new DatabaseSync(path.join(config.seedDirectory, "usage-index.sqlite"), { readOnly: true });
    context = d.createContext({ ...config, dataset, ledger, seed, control, profile: CLOSEOUT_PROFILE, completeCostAccounting: true,
      preserveMissingCosts: true, requireCompleteOracle: true, requiredAllTotal: expectedAll(dataset).total + ledger.expected.total });
    context.beforeOracle = name => waitForOracleIdle(context, name);
    context.selectedSessions = d.mutationSessions(ledger, seed);
    context.ui = await browser(); context.pages = [context.ui.page]; await d.attachPage(context, context.ui.page);
    context.server = await d.launchServer(context); context.sampler = await d.startSampler(context); await d.loadPage(context);
    await d.pollBrowser(context); result.initialOracle = await d.verifyFull(context, "initial"); delete context.requiredAllTotal;
    const gatewayPid = context.server.child.pid;
    for (let cycle = 1; cycle <= 4; cycle++) {
      assert.equal(context.server.child.pid, gatewayPid);
      const current = await runContinuous(d, context, PUBLICATION_CARD, { cycle, reopen: false }); current.cycle = cycle;
      result.cycles.push(current);
      current.idleStartedAtMs = Date.now();
      while (Date.now() - current.idleStartedAtMs < 120_000) {
        await d.pollBrowser(context); await d.pollResources(context); assert.deepEqual(context.failures, []); assert.ok(!context.cancelled); await pause(500);
      }
      current.idleEndedAtMs = Date.now();
      await save(path.join(config.directory, `cycle-${cycle}-idle.json`), { startedAtMs: current.idleStartedAtMs, endedAtMs: current.idleEndedAtMs });
      if (!current.passed) break;
    }
    await context.ui.page.close(); await stop(context.server); await context.sampler.stop(); await d.pollResources(context);
    await log(context, "normal-close", { projection: projectionStorage(context.state) });
    context.ui.page = await context.ui.context.newPage(); context.pages = [context.ui.page]; await d.attachPage(context, context.ui.page);
    const startedAtMs = Date.now(); context.server = await d.launchServer(context, "-final-reopen"); context.sampler = await d.startSampler(context, "-final-reopen");
    await d.loadPage(context); await d.pollBrowser(context);
    result.reopen = { startedAtMs, endedAtMs: Date.now(), wallMs: Date.now() - startedAtMs };
    await save(path.join(config.directory, "final-reopen.json"), result.reopen);
    result.reopenOracle = await d.verifyFull(context, "reopen");
    result.passed = result.cycles.length === 4 && result.cycles.every(row => row.passed);
  } catch (error) { result.failure = { message: error.message, stack: error.stack }; }
  finally {
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
    if (context) {
      result.inputs = context.inputs;
      try { await stopOwned(d, context, Boolean(result.failure)); } catch (error) { result.cleanupError = error.message; }
    }
    try { await recover(prepared, config.directory, ROOT); } catch (error) { result.restorationError = error.message; }
    result.endedAtMs = Date.now(); await save(path.join(config.directory, "result.json"), result);
    if (!result.restorationError) await cleanupSnapshot(prepared, ROOT);
  }
  const analysis = await analyze(config.directory); await save(path.join(ROOT, "analysis.json"), analysis);
  console.log(JSON.stringify({ passed: analysis.passed, workload: analysis.workload, checks: [...analysis.resource.checks, ...analysis.reliability.checks].map(row => ({ id: row.id, status: row.status })) }));
  process.exitCode = analysis.passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await contained(path.resolve("output"), ROOT);
  if (process.argv[2] === "run") await run();
  else if (process.argv[2] === "analyze") console.log(JSON.stringify(await analyze(path.join(ROOT, "four-cycles"))));
  else throw Error("Expected run or analyze");
}
