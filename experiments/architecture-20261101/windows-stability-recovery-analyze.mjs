import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  phaseAnalysis, controls, controlChecks, resources, resourceChecks,
  gates, check, finish, mergeInput, streamNdjson,
} from "./windows-stability-analyze.mjs";
import { stabilitySchedule } from "./windows-stability-schedule.mjs";

const project = fileURLToPath(new URL("../../", import.meta.url));
const defaultRoot = path.join(project, "output/windows-stability-recovery-20261109");
const finite = Number.isFinite;
const verdict = (known, passed) => !known ? "incomplete" : passed ? "passed" : "failed";
const mutationKey = row => `${row.operation}/${row.kind}/${row.ordinal}`;

async function json(file, evidence) {
  try { return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) {
    evidence.push({ file, status: error.code === "ENOENT" ? "missing" : "invalid", message: error.message });
    return null;
  }
}

async function names(directory, evidence) {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    evidence.push({ file: directory, status: error.code === "ENOENT" ? "missing" : "invalid", message: error.message });
    return [];
  }
}

function gatewayContinuity(control, events, phase, reliability) {
  const start = phase.schedule?.startedAtMs, end = start + phase.expectedSchedule.durationMs;
  const activeAtStart = control.processes.filter(row => row.role === "gateway" && row.atMs <= start &&
    !control.exits.some(exit => exit.instance === row.instance && exit.atMs <= start));
  const bornDuring = control.processes.filter(row => row.role === "gateway" && row.atMs > start && row.atMs < end);
  const exitedDuring = control.exits.filter(row => row.role === "gateway" && row.atMs >= start && row.atMs < end);
  const restartedDuring = events.faults.filter(row => row.type === "gateway-restarted" && row.atMs >= start && row.atMs < end);
  const closedDuring = events.normalCloses.filter(row => row.atMs >= start && row.atMs < end);
  const complete = phase.result?.passed === true && phase.result.startedAtMs === start &&
    phase.result.observedDurationMs >= phase.expectedSchedule.durationMs && phase.result.endedAtMs >= end;
  const violation = activeAtStart.length > 1 || bornDuring.length || exitedDuring.length || restartedDuring.length || closedDuring.length;
  check(reliability, "two-years/endurance/gateway-continuity", violation ? "failed" : verdict(complete && activeAtStart.length === 1, true),
    { start, end, activeAtStart, bornDuring, exitedDuring, restartedDuring, closedDuring });
}

function httpFaults(control, events, inputs, reliability) {
  events.expectedHttpErrors = [];
  events.unexpectedErrors = [];
  for (const row of events.errors) {
    const park = control.faults.find(fault => fault.event === "fault-parked" && fault.commandId === row.controlledFaultId);
    const kill = park && events.faults.find(fault => fault.type === "executor-killed" && fault.commandId === park.commandId &&
      fault.pid === park.pid && fault.point === park.point && fault.atMs >= park.atMs);
    const exit = kill && control.faults.find(fault => fault.event === "executor-exit" && fault.childPid === kill.pid && fault.atMs >= kill.atMs);
    const expected = row.type === "http-error" && row.status === 500 && row.code === "EXECUTOR_EXITED" && kill && exit &&
      row.atMs >= kill.atMs && row.atMs - kill.atMs <= 300000 &&
      finite(row.requestStartedAtMs) && row.requestStartedAtMs <= kill.atMs;
    if (!expected) { events.unexpectedErrors.push(row); continue; }
    const before = events.responses.filter(response => response.atMs < kill.atMs).at(-1);
    const affected = inputs.filter(input => input.landedAtMs <= kill.atMs + 1000 && input.paintedAtMs >= kill.atMs &&
      input.landedAtMs >= park.atMs - 300000);
    const recovered = affected.find(input => events.responses.some(response => response.atMs >= row.atMs &&
      response.atMs <= row.atMs + 300000 && response.atMs <= input.paintedAtMs &&
      response.sequence === input.responseSequence && response.usageVersion === input.usageVersion &&
      response.usageVersion && response.usageVersion !== before?.usageVersion &&
      Number.isSafeInteger(input.kindCount) && response.counts?.[input.kind] >= input.kindCount));
    const receipt = { error: row, park, kill, executorExit: exit, recoveredEventId: recovered?.eventId ?? null };
    events.expectedHttpErrors.push(receipt);
    check(reliability, `two-years/http-recovery/${events.expectedHttpErrors.length}`,
      verdict(Boolean(before && affected.length), Boolean(recovered)), receipt);
  }
  check(reliability, "two-years/unexpected-errors", verdict(Object.keys(events.counts).length > 0,
    !events.unexpectedErrors.length), events.unexpectedErrors);
}

export async function analyzeWindowsStabilityRecovery(root = defaultRoot) {
  root = path.resolve(root);
  const directory = path.join(root, "two-years"), evidence = [];
  const reliability = gates(), resource = gates(), performance = gates();
  const run = await json(path.join(root, "result.json"), evidence);
  const preflight = await json(path.join(root, "preflight.json"), evidence);
  const multitab = run?.kind === "windows-multitab";
  const selectedViewClock=multitab&&run.observationVersion===2;
  const baseCount = multitab ? preflight?.baseAppendCount : 48;
  const recovery = await json(path.join(directory, "recovery.json"), evidence);
  const base = await json(path.join(directory, "base-ledger.json"), evidence);
  const schedule = await json(path.join(directory, "schedule-endurance.json"), evidence);
  const result = await json(path.join(directory, "result-endurance.json"), evidence);
  const entries = await names(directory, evidence);
  const groups = Array.isArray(preflight?.groups) ? preflight.groups : [];
  const expectedGroups = multitab ? ["combined-normal", "combined-before", "combined-after"] : ["before-commit", "after-commit", "sse", "resources"];
  const hashes = Object.values(preflight?.toolHashes ?? {});
  check(reliability, "preflight", verdict(Boolean(preflight), preflight?.passed === true && groups.length === expectedGroups.length &&
    expectedGroups.every(name => groups.filter(row => row?.name === name && row.passed === true).length === 1) &&
    hashes.length > 0 && hashes.every(value => typeof value === "string" && /^[a-f\d]{64}$/i.test(value)) &&
    (!multitab || run.mode === "endurance" && [82,84].includes(baseCount) && [undefined,2].includes(run.observationVersion))),
  { ...preflight, toolHashValidation: "SHA-256 format only; Main entry verifies current-source equality for each tool." });
  const baseInputs = Array.isArray(base?.entries) ? base.entries : [];
  const baseAppends = baseInputs.filter(row => row.operation === "append");
  check(reliability, "two-years/base-ledger", verdict(Boolean(base), base?.appendCount === baseCount && base.revisionCount === 1 &&
    baseInputs.length === baseCount+1 && baseAppends.length === baseCount && baseInputs.filter(row => row.operation === "revision").length === 1 &&
    new Set(baseAppends.map(row => row.ordinal)).size === baseCount && baseAppends.every(row => Number.isSafeInteger(row.ordinal) && row.ordinal >= 1 && row.ordinal <= baseCount)),
  { appendCount: base?.appendCount ?? null, revisionCount: base?.revisionCount ?? null, entries: baseInputs.length, countedInNewInputs: false });
  check(reliability, "two-years/same-path-recovery", verdict(Boolean(recovery), recovery?.passed === true &&
    finite(recovery.wallMs) && recovery.wallMs >= 0 && recovery.wallMs <= 300000 && recovery.expectedAppends === baseCount &&
    recovery.beforeRecent === (multitab?baseCount:47) && recovery.afterRecent === baseCount && recovery.samePrimaryIdentity === true &&
    recovery.sameProjectionFile === true && recovery.coldCopied === 0 && recovery.fullRebuild === false &&
    recovery.oracle?.passed === true && recovery.oracle.retry !== true && recovery.oracle.skipped === undefined), recovery);
  if(multitab){
    const pending=await json(path.join(directory,"pending-recovery.json"),evidence);
    check(reliability,"two-years/retained-pending-recovery",verdict(Boolean(pending),pending?.passed===true && pending.expectedAppends===80 &&
      pending.beforeRecent===79 && pending.afterRecent===80 && pending.wallMs>=0 && pending.wallMs<=300000 &&
      pending.samePrimaryIdentity===true && pending.sameProjectionFile===true && pending.coldCopied===0 && pending.fullRebuild===false &&
      pending.oracle?.passed===true && pending.oracle.retry===false && pending.oracle.skipped===undefined),pending);
  }

  const events = { counts: {}, faults: [], oracles: [], normalCloses: [], locks: [], scopes: [], errors: [], sse: [], responses: [],viewResponses:[],views:[] };
  const ledger = new Map(), landings = new Map(), visibleIds = new Set(), duplicates = [], conflicts = [];
  await streamNdjson(path.join(directory, "events.ndjson"), row => {
    events.counts[row.type] = (events.counts[row.type] ?? 0) + 1;
    if (["input-landed", "input-visible"].includes(row.type)) {
      if (row.type === "input-landed") {
        if (landings.has(row.eventId)) duplicates.push(row.eventId);
        landings.set(row.eventId, row);
      } else {
        if (visibleIds.has(row.eventId)) duplicates.push(row.eventId);
        visibleIds.add(row.eventId);
      }
      mergeInput(ledger, row, conflicts);
    }
    if (["fault-observed", "executor-killed", "gateway-restarted"].includes(row.type)) events.faults.push(row);
    if (row.type === "oracle") events.oracles.push({ atMs: row.atMs, name: row.name, ...row.result });
    if (row.type === "normal-close") events.normalCloses.push(row);
    if (row.type === "scope") events.scopes.push(row);
    if (row.type === "write-lock") events.locks.push(row);
    if (row.type === "browser" && row.kind === "page-receipt" && ["error", "open"].includes(row.event)) events.sse.push(row);
    if (row.type === "response" && row.preset === "all") events.responses.push(row);
    if(row.type==="response")events.viewResponses.push(row);
    if(row.type==="view-visible"){events.views.push(row);if(selectedViewClock)mergeInput(ledger,row,conflicts);}
    if (row.type === "http-error" || row.error) events.errors.push(row);
  }, evidence);
  events.responses.sort((a, b) => a.atMs - b.atMs);
  events.initialAllResponse = events.responses[0];
  events.firstAllResponse = events.responses.filter(row => row.atMs <= schedule?.startedAtMs).at(-1);
  events.lastAllResponse = events.responses.at(-1);
  const baseline = events.firstAllResponse;
  const baselineCounts = Object.fromEntries(baseAppends.map(row => [row.kind, baseAppends.filter(input => input.kind === row.kind).length]));
  check(reliability, "two-years/recovered-source-baseline", verdict(Boolean(base && baseline),
    Object.entries(baselineCounts).every(([kind, count]) => baseline?.counts?.[kind] === count) &&
    Object.values(baseline?.counts ?? {}).reduce((n, count) => n + count, 0) === baseCount),
  { expectedCounts: baselineCounts, response: baseline ?? null });
  const phaseInputs = Array.isArray(result?.inputs) ? result.inputs : [];
  for (const row of phaseInputs) mergeInput(ledger, row, conflicts);
  const mutations = [], mutationFile = path.join(directory, "mutations/mutations.ndjson");
  await streamNdjson(mutationFile, row => mutations.push(row), evidence);
  const changes = mutations.filter(row => ["append", "revision"].includes(row.operation));
  const byMutation = new Map(changes.map(row => [mutationKey(row), row]));
  const byLanding = new Map([...landings.values()].map(row => [mutationKey(row), row]));
  const byInput = new Map([...ledger.values()].map(row => [mutationKey(row), row]));
  // Cleanup can finish a mutation after the phase snapshot; keep that input in the denominator.
  for (const row of changes) mergeInput(ledger, { ...row, eventId: byInput.get(mutationKey(row))?.eventId ?? `mutation:${mutationKey(row)}` }, conflicts);
  const mismatches = [...landings.values()].filter(row => {
    const mutation = byMutation.get(mutationKey(row));
    return !mutation || ["id", "identity", "filePath", "landedAtMs", "category", "expectedDelta", "expectedEventDelta", "outputDelta"]
      .some(field => mutation[field] !== row[field]);
  }).map(row => row.eventId);
  const missingLandings = [...byMutation.keys()].filter(key => !byLanding.has(key));
  check(reliability, "two-years/mutation-ledger-agreement", verdict(mutations.length > 0,
    changes.length === byMutation.size && landings.size === byLanding.size && changes.length === landings.size &&
    !missingLandings.length && !mismatches.length && mutations.every(row => ["append", "revision", "restore"].includes(row.operation))),
  { mutationCount: changes.length, firstLandingCount: landings.size, missingLandings, mismatches });
  const inputs = [...ledger.values()];
  const plannedIds = new Set(stabilitySchedule("endurance").events.filter(row => ["append", "revision"].includes(row.type)).map(row => row.id));
  const unexpected = inputs.filter(row => !plannedIds.has(row.eventId)).map(row => row.eventId);
  check(reliability, "two-years/new-input-counts", verdict(Boolean(result), inputs.length === 386 &&
    inputs.filter(row => row.operation === "append").length === 384 && inputs.filter(row => row.operation === "revision").length === 2 &&
    changes.length === 386 && !unexpected.length), { expectedAppends: 384, expectedRevisions: 2, actualInputs: inputs.length, unexpected });
  const revisions = inputs.filter(row => row.operation === "revision").sort((a, b) => a.landedAtMs - b.landedAtMs);
  check(reliability, "two-years/revision-ordinals", verdict(revisions.length > 0, revisions.length === 2 &&
    revisions.every((row, i) => row.ordinal === i + 2)), revisions.map(row => ({ eventId: row.eventId, ordinal: row.ordinal })));
  check(reliability, "two-years/duplicate-inputs", verdict(inputs.length > 0, !duplicates.length &&
    new Set(phaseInputs.map(row => row.eventId)).size === phaseInputs.length), duplicates);
  check(reliability, "two-years/input-record-agreement", verdict(inputs.length > 0, !conflicts.length), conflicts);
  const missingRaw = inputs.filter(row => !landings.has(row.eventId) || !visibleIds.has(row.eventId)).map(row => row.eventId);
  check(reliability, "two-years/raw-input-evidence", verdict(Boolean(result), !missingRaw.length), missingRaw);
  const invalidInputs = inputs.filter(row => !finite(row.landedAtMs) || !finite(row.paintedAtMs) || !finite(row.landingToPaintMs) ||
    row.paintedAtMs < row.landedAtMs || row.landingToPaintMs < 0 || typeof row.usageVersion !== "string" || !row.usageVersion ||
    !Number.isSafeInteger(row.responseSequence) || row.responseSequence <= 0).map(row => row.eventId);
  check(reliability, "two-years/input-publication-evidence", verdict(inputs.length > 0, !invalidInputs.length), invalidInputs);
  if(selectedViewClock){
    const badViews=inputs.filter(input=>{
      const views=events.views.filter(row=>row.eventId===input.eventId),view=views[0];
      const response=events.viewResponses.find(row=>row.sequence===input.viewResponseSequence&&row.page===input.viewPage&&row.preset===input.viewPreset&&row.usageVersion===input.viewUsageVersion);
      return views.length!==1||!view||!response||!input.viewUsageVersion||!finite(input.viewVisibleAtMs)||!finite(input.viewLandingToPaintMs)||
        input.viewLandingToPaintMs<0||Math.abs(input.viewVisibleAtMs-input.landedAtMs-input.viewLandingToPaintMs)>1||response.atMs>input.viewVisibleAtMs+1000||
        (input.viewPreset!=="all"&&(input.operation!=="append"||!(input.timestampMs>=Date.parse(response.range?.start)&&input.timestampMs<=Date.parse(response.range?.end))))||
        (input.operation==="append"?!(Number.isSafeInteger(response.counts?.[input.kind])&&response.counts[input.kind]>=input.kindCount):
          !(Number.isSafeInteger(response.revisionCount)&&response.revisionCount>=(input.revisionIndex??input.ordinal)));
    }).map(row=>row.eventId);
    check(reliability,"two-years/selected-view-evidence",verdict(Boolean(result),!badViews.length&&events.views.length===inputs.length),{badViews});
  }
  const phase = phaseAnalysis("two-years", "endurance", schedule, result, ledger, events, reliability, performance, false, baseCount,selectedViewClock);
  const reopen = await json(path.join(directory, "final-reopen.json"), evidence);
  const closed = await json(path.join(directory, "closed.json"), evidence);
  events.closed = closed;
  check(reliability, "two-years/normal-close", verdict(Boolean(closed), closed?.failed === false && closed.rawRestored === true &&
    !closed.errors?.length && events.normalCloses.length > 0), { closed, normalCloses: events.normalCloses });
  check(reliability, "two-years/oracles", verdict(events.oracles.length > 0, events.oracles.every(row =>
    row.retry === true || row.passed === true && row.skipped === undefined)), events.oracles);
  check(reliability, "two-years/reopen-exact", verdict(Boolean(reopen), finite(reopen?.wallMs) && reopen.wallMs >= 0 &&
    events.oracles.some(row => row.name === "reopen" && row.passed === true && row.retry !== true && row.skipped === undefined)), reopen);
  check(performance, "two-years/reopen", verdict(finite(reopen?.wallMs), reopen?.wallMs >= 0 && reopen.wallMs <= 45000),
    { actualMs: reopen?.wallMs ?? null, limitMs: 45000 });
  const control = await controls(path.join(directory, "control"), evidence);
  const controlSummary = controlChecks("two-years", control, events, [phase], reliability);
  check(reliability, "two-years/control-errors", verdict(Object.keys(control.counts).length > 0, !control.errors.length), control.errors);
  gatewayContinuity(control, events, phase, reliability);
  httpFaults(control, events, inputs, reliability);
  const nodeExits = [];
  for (const entry of await names(path.join(directory, "nodes"), evidence)) if (/^node-\d+\.jsonl$/.test(entry.name)) {
    await streamNdjson(path.join(directory, "nodes", entry.name), row => nodeExits.push(row), evidence);
  }
  check(resource, "two-years/node-exit-evidence", verdict(nodeExits.length > 0, control.exits.every(exit => nodeExits.some(row =>
    row.pid === exit.pid && Math.abs(row.startedAtMs - exit.startedAtMs) < 1000 && row.code === exit.code))),
  { nodeExitCount: nodeExits.length, normalExitCount: control.exits.length });
  const summaries = [];
  for (const entry of entries.filter(row => /^resource-summary(?:-.*)?\.json$/.test(row.name))) {
    const summary = await json(path.join(directory, entry.name), evidence);
    if (summary) summaries.push(summary);
  }
  const resourceSummary = await resources(directory, entries, summaries, control, nodeExits, phase, events, evidence);
  resourceChecks("two-years", resourceSummary, summaries, [phase], closed, resource);
  check(reliability, "run-completed", verdict(Boolean(run), (run?.kind === "windows-stability-recovery" || multitab && run.mode === "endurance") && run.baseAppendCount === baseCount &&
    run.baseRevisionCount === 1 && run.passed === true && !run.failure && !run.cleanupError && finite(run.endedAtMs) &&
    Array.isArray(run.phases) && run.phases.length === 1 && run.phases[0]?.mode === "endurance" && run.phases[0]?.passed === true), run);
  check(reliability, "evidence-readable", evidence.some(row => row.status === "invalid") ? "failed" : verdict(evidence.length === 0, true), evidence);
  finish(reliability); finish(resource); finish(performance);
  return { version: 1, kind: "windows-stability-recovery-analysis", root, analyzedAt: new Date().toISOString(),
    passed: reliability.passed && resource.passed && performance.passed, reliability, resource, performance, preflight, recovery,
    contexts: [{ label: "two-years", directory, phases: [phase], inputs, events, control: controlSummary, resources: resourceSummary, reopen, closed }],
    historicalResults: ["current", "year"].map(label => ({ label,
      file: path.join(project, "output/windows-stability-20261109/formal-v2/diagnostic", label, "result-diagnostic.json"),
      scope: "Prior result only; not evaluated or accepted in this run." })), evidence,
    scope: `Same-path two-year recovery plus one new continuous eight-hour run. The retained ${baseCount} appends and one revision are excluded from new input denominators. Historical current/year verdicts remain in their original files.` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [root, output] = process.argv.slice(2);
  const result = await analyzeWindowsStabilityRecovery(root);
  if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  else console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
