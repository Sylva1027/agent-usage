import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeWindowsStability, streamNdjson } from "./windows-stability-analyze.mjs";
import { stabilitySchedule, STABILITY_KINDS } from "./windows-stability-schedule.mjs";
import { parseResourceSample } from "./resource-identity-analysis.mjs";

const MiB = 1048576, hour = 3600000, epoch = 1800000000000;
const save = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
const ndjson = async (file, rows) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n"); };
const projection = { candidate: null, orphanDatabases: [], walBytes: 0, databaseCount: 1 };

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "windows-stability-analyze-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("windows-stability-analyze-"));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function sample(atMs, { bytes = 100 * MiB, handles = 100, running = true, outsider = false, tempFiles = 0 } = {}) {
  const process = (pid, role, start, memory) => ({ pid, role, parentPid: role === "runner" ? 0 : 1,
    name: "node.exe", startTimeUtc: new Date(start).toISOString(), workingSetBytes: memory, privateBytes: memory,
    reportedPeakWorkingSetBytes: memory, handleCount: handles, cpuAvailable: true, cpuSeconds: 1,
    cpuSecondsIncrement: .01, ioAvailable: true, logicalReadBytes: 100, logicalWriteBytes: 50,
    logicalReadBytesIncrement: 1, logicalWriteBytesIncrement: 1 });
  const processes = [process(1, "runner", epoch - 10000, 1)];
  if (running) processes.push(process(42, "service", epoch, bytes));
  if (outsider) processes.push(process(999, "service", epoch - 20000, 900 * MiB));
  const measure = { processCount: running ? 1 : 0, memoryAvailableProcessCount: running ? 1 : 0,
    workingSetBytes: running ? bytes : 0, reportedPeakWorkingSetBytes: running ? bytes : 0 };
  return { atUnixMs: atMs, processes, service: outsider ? { ...measure, processCount: measure.processCount + 1,
    memoryAvailableProcessCount: measure.processCount + 1, workingSetBytes: measure.workingSetBytes + 900 * MiB,
    reportedPeakWorkingSetBytes: measure.reportedPeakWorkingSetBytes + 900 * MiB } : measure,
    browser: { workingSetBytes: 200 * MiB }, state: { complete: true, observedBytes: 123, categoryBytes: {} },
    sqlite: { complete: true, categoryBytes: { wal: 0 } },
    temp: { complete: true, observedBytes: tempFiles * 16, fileCount: tempFiles } };
}

async function fixture(t, { latency = {}, missingHandleHour = -1, idleGrowth = 0, tempGrowth = false, killMarkers = true,
  historicalFailure = false, badZcode = false, nativePeakMiB = 100, independentSse = true } = {}) {
  const root = await temporary(t), referenceFile = path.join(root, "reference.json"), upgradeFile = path.join(root, "upgrade.json");
  const directories = {};
  for (const [index, label] of ["current", "year", "two-years"].entries()) {
    const directory = path.join(root, "diagnostic", label);
    directories[label] = directory;
    const base = epoch + index * 20 * hour;
    const events = [], controls = [], resourceRows = [], idle = [];
    let finalAt = base;
    const born = { event: "process-born", pid: 42, instance: `${label}-gateway`, role: "gateway", atMs: base,
      startedAtMs: epoch, ppid: 1 };
    controls.push(born);
    for (const [phaseIndex, mode] of (label === "two-years" ? ["diagnostic", "endurance"] : ["diagnostic"]).entries()) {
      const schedule = { ...stabilitySchedule(mode, label), startedAtMs: base + phaseIndex * 20 * 60000,
        ordinalOffset: mode === "endurance" ? stabilitySchedule("diagnostic", label).appendCount : 0 };
      const inputs = [];
      let revisionOrdinal = phaseIndex;
      for (const event of schedule.events) {
        // The runner spreads details last: scheduled-event becomes append/scopes/etc.
        events.push({ type: event.type, ...event });
        if (event.type === "disconnect" && independentSse) for (const [name, offset] of [["error", 100], ["open", 3100]]) {
          const atMs = schedule.startedAtMs + event.atMs + offset;
          events.push({ type: "browser", kind: "page-receipt", page: 0, event: name, clock: atMs, atMs });
        }
        if (event.type === "append" || event.type === "revision") {
          const kind = event.kind ?? "zcode", landedAtMs = schedule.startedAtMs + event.atMs;
          const landingToPaintMs = latency[kind] ?? (event.type === "revision" ? 2000 : event.category === "gateway-recovery" ? 5422 : 1000);
          const input = { eventId: event.id, operation: event.type, kind, category: event.category,
            ordinal: event.type === "append" ? event.ordinal + schedule.ordinalOffset : ++revisionOrdinal,
            filePath: `${kind}.log`, outputDelta: event.outputDelta, landedAtMs, landingToPaintMs,
            paintedAtMs: landedAtMs + landingToPaintMs, usageVersion: event.id };
          inputs.push(input);
          events.push({ ...input, type: "input-landed", paintedAtMs: undefined, landingToPaintMs: undefined, atMs: landedAtMs });
          events.push({ ...input, type: "input-visible", atMs: input.paintedAtMs });
          if (input.category === "ordinary") {
            controls.push({ event: "source-end", kind: kind === "codex" ? "main" : kind, atMs: landedAtMs + 50,
              method: "reuseSourcePrefix", committed: true, insertedEvents: 1, reusedEvents: 100, durationMs: 20 });
            for (const method of ["prepare", "applyDelta", "publish"]) controls.push({ event: "projection", atMs: landedAtMs + 100,
              method, coldCopied: 0, fullRebuild: false, work: { delta: { added: 1, removed: 0 } } });
            if (kind === "zcode") controls.push({ event: "zcode-projection-delta", sourcePath: input.filePath,
              atMs: landedAtMs + 100, added: badZcode ? 2 : 1, removed: 0, netAdded: badZcode ? 2 : 1 });
          }
        }
        if (event.type.startsWith("arm-") && killMarkers) {
          const atMs = schedule.startedAtMs + event.atMs + (event.type === "arm-gateway-exit" ? 7000 : 1234), pid = 1000 + event.atMs;
          const point = event.type === "arm-after-commit" ? "after-commit-before-notify" : "before-commit";
          const park = { event: "fault-parked", commandId: event.id, point, pid, ppid: 42, instance: `${label}-${event.id}`,
            atMs, startedAtMs: atMs - 100, role: "executor", usage: { maxRSS: 20, userCPUTime: 100, systemCPUTime: 100 } };
          controls.push({ ...park, event: "process-born", atMs: atMs - 50 }, park,
            { event: "executor-exit", childPid: pid, atMs: atMs + 20, signal: "SIGKILL" });
          const sampled = sample(atMs);
          sampled.processes.push({ ...sampled.processes[1], pid, parentPid: 42, startTimeUtc: new Date(atMs - 100).toISOString(),
            workingSetBytes: 20 * 1024, reportedPeakWorkingSetBytes: 20 * 1024 });
          sampled.service.processCount++;
          sampled.service.memoryAvailableProcessCount++;
          sampled.service.workingSetBytes += 20 * 1024;
          sampled.service.reportedPeakWorkingSetBytes += 20 * 1024;
          resourceRows.push(sampled);
          events.push({ ...park, type: "fault-observed" }, { type: event.type === "arm-gateway-exit" ? "gateway-restarted" : "executor-killed",
            atMs: atMs + 10, pid: event.type === "arm-gateway-exit" ? 43 : pid, point });
          if (event.type === "arm-gateway-exit") events.push(
            { type: "browser", kind: "page-receipt", page: 0, event: "error", clock: atMs + 5, atMs: atMs + 250 },
            { type: "browser", kind: "page-receipt", page: 0, event: "open", clock: atMs + 1012, atMs: atMs + 1270 });
        }
      }
      finalAt = schedule.startedAtMs + schedule.durationMs + 10000;
      await save(path.join(directory, `schedule-${mode}.json`), schedule);
      await save(path.join(directory, `result-${mode}.json`), { mode, label, passed: true, inputs, errors: [],
        observedDurationMs: schedule.durationMs, startedAtMs: schedule.startedAtMs, endedAtMs: finalAt,
        drainMs: 1000, oracle: { passed: true, retry: false } });
      if (mode === "endurance") for (let i = 0; i < 8; i++) {
        const atMs = schedule.startedAtMs + i * hour + 61000;
        resourceRows.push(sample(atMs, { handles: i === missingHandleHour ? null : 100, bytes: (100 + (i === 7 ? idleGrowth : 0)) * MiB,
          outsider: i === 0, tempFiles: tempGrowth ? i : 0 }));
        idle.push({ atMs });
      }
    }
    if (label === "current") controls.push({ event: "watch-hint-dropped", commandId: "drop", atMs: base + 120000 });
    if (label === "year") events.push({ type: "write-lock", durationMs: 3000 });
    controls.push({ event: "request-queued", instance: born.instance, depth: 1, atMs: base + 1 },
      { event: "request-finished", instance: born.instance, depth: 0, atMs: base + 2 });
    let finalNode = born;
    if (label === "current" && killMarkers) {
      const restart = events.find(row => row.type === "gateway-restarted");
      finalNode = { ...born, pid: 43, instance: "current-restarted", startedAtMs: restart.atMs, atMs: restart.atMs };
      controls.push(finalNode);
      const reopened = sample(finalAt - 2000);
      reopened.processes[1].pid = 43;
      reopened.processes[1].startTimeUtc = new Date(restart.atMs).toISOString();
      resourceRows.push(reopened);
    }
    controls.push({ ...finalNode, event: "process-exit", atMs: finalAt, code: 0, usage: { maxRSS: nativePeakMiB * 1024 } });
    if (!idle.length) { idle.push({ atMs: base + 61000 }); resourceRows.push(sample(base + 61000)); }
    const firstCounts = Object.fromEntries(STABILITY_KINDS.map(kind => [kind, 0]));
    const lastCounts = { ...firstCounts };
    for (const row of events.filter(row => row.type === "input-landed" && row.operation === "append")) lastCounts[row.kind]++;
    events.push({ type: "response", preset: "all", counts: firstCounts, atMs: base - 1 },
      { type: "response", preset: "all", counts: lastCounts, atMs: finalAt });
    events.push({ type: "oracle", name: "reopen", atMs: finalAt, result: { passed: true } });
    await ndjson(path.join(directory, "events.ndjson"), events);
    await ndjson(path.join(directory, "control/events-42.ndjson"), controls);
    await ndjson(path.join(directory, `nodes/node-${finalNode.pid}.jsonl`), [{ pid: finalNode.pid, role: "gateway", startedAtMs: finalNode.startedAtMs,
      endedAtMs: finalAt, code: 0, usage: { maxRSS: nativePeakMiB * 1024 } }]);
    await ndjson(path.join(directory, "resources/resources.ndjson"), resourceRows);
    await ndjson(path.join(directory, "resources-final-reopen/resources.ndjson"), [sample(finalAt + 1000, { running: false })]);
    await save(path.join(directory, "resource-summary.json"), { idle });
    await save(path.join(directory, "closed.json"), { failed: false, rawRestored: true, errors: [], projection, atMs: finalAt + 2000 });
    await save(path.join(directory, "final-reopen.json"), { wallMs: 1000, startedAtMs: finalAt - 1000, endedAtMs: finalAt });
  }
  await save(path.join(root, "result.json"), { passed: true, startedAtMs: epoch, endedAtMs: epoch + 100 * hour });
  await save(upgradeFile, { passed: true, candidate: { passed: true, reopen: { wallMs: 1000 } }, maintenance: {
    result: { projection: { coldCopied: 0, rebuilt: false } }, observed: { peakBytes: 100 * MiB } },
    latencies: [{ name: "first", baselineMs: 80000, candidateMs: 46000, passed: true }] });
  await save(referenceFile, { groups: ["current", "year", "two-years"].flatMap(label => (label === "two-years" ? ["mixed"] : ["hot", "mixed"]).map(layout => ({
    label, layout, variant: "candidate", passed: true, scene: { changes: STABILITY_KINDS.map(kind => ({ name: `append-${kind}`, kind, actualPaintMs: 1000 })),
      reopen: { wallMs: 1000 } }, latencies: historicalFailure && label === "two-years" ? [{ name: "revision-zcode", candidateMs: 80519.5, passed: false }] : [] }))) });
  return { root, directories, options: { referenceFile, upgradeFile }, analyze: () => analyzeWindowsStability(root, { referenceFile, upgradeFile }) };
}

function gate(result, group, id) {
  const row = result[group].checks.find(row => row.id === id);
  assert.ok(row, `missing gate ${id}`);
  return row;
}

async function addIdleContinuation(f) {
  const directory = f.directories.year, base = epoch + 20 * hour, resumedAtMs = base + 21 * 60000;
  const originalIdle = { atMs: base + 61000, bytes: 100 * MiB, handles: 100, tempFiles: 0 };
  const misclassified = { atMs: base + 62000, bytes: 300 * MiB, handles: 200, tempFiles: 0 };
  const resumedIdle = { atMs: resumedAtMs + 61000, bytes: 120 * MiB, handles: 100, tempFiles: 0 };
  const originalRun = { passed: false, startedAtMs: epoch, endedAtMs: resumedAtMs - 1000,
    failure: { message: "Idle service tree exceeded 256 MiB", stack: "original failure stack" } };
  const originalClosed = { failed: true, rawRestored: false, errors: [], projection, atMs: resumedAtMs - 1000 };
  const originalResources = { samples: 2, sampledPeakBytes: 300 * MiB, idle: [originalIdle, misclassified] };
  const correction = { discarded: [{ ...misclassified, reason: "query/executor activity" }], kept: 1,
    limitBytes: 256 * MiB, standardsChanged: false };
  const record = { atMs: resumedAtMs, reason: "finish year idle/reopen after correcting activity classification", original: "result-idle-interruption.json" };
  const paths = { original: path.join(f.root, record.original), closed: path.join(directory, "failed-idle-closed.json"),
    summary: path.join(directory, "failed-idle-resource-summary.json"), correction: path.join(directory, "idle-classification-correction.json") };
  await save(paths.original, originalRun);
  await save(paths.closed, originalClosed);
  await save(paths.summary, originalResources);
  await save(paths.correction, correction);
  const runFile = path.join(f.root, "result.json"), run = JSON.parse(await readFile(runFile, "utf8"));
  run.continuation = record;
  await save(runFile, run);
  // Deliberately leave the discarded row in the latest summary to catch accidental union with the old idle ledger.
  await save(path.join(directory, "resource-summary.json"), { idle: [originalIdle, misclassified, resumedIdle] });
  await ndjson(path.join(directory, "resources/resources.ndjson"), [sample(originalIdle.atMs), sample(misclassified.atMs, { bytes: misclassified.bytes })]);
  const resumedSample = sample(resumedIdle.atMs, { bytes: resumedIdle.bytes });
  resumedSample.processes[1].pid = 44;
  resumedSample.processes[1].startTimeUtc = new Date(resumedAtMs).toISOString();
  await ndjson(path.join(directory, "resources-resume/resources.ndjson"), [resumedSample]);
  const end = resumedIdle.atMs + 3000;
  await ndjson(path.join(directory, "control/events-44.ndjson"), [
    { event: "process-born", pid: 44, role: "gateway", instance: "year-resume", atMs: resumedAtMs, startedAtMs: resumedAtMs },
    { event: "process-exit", pid: 44, role: "gateway", instance: "year-resume", atMs: end, code: 0, usage: { maxRSS: 120 * 1024 } },
  ]);
  await ndjson(path.join(directory, "resources-final-reopen/resources.ndjson"), [sample(end, { running: false })]);
  await save(path.join(directory, "closed.json"), { failed: false, rawRestored: true, errors: [], projection, atMs: end });
  await save(path.join(directory, "final-reopen.json"), { wallMs: 1000, startedAtMs: end - 1000, endedAtMs: end });
  return { paths, originalRun, originalClosed, originalResources, correction, resumedIdle, resumedSample, record };
}

async function addPaintContinuation(f, { interruptedLatency = 240000, echoes = true, lateLanding = false } = {}) {
  const directory = f.directories["two-years"], phaseFile = path.join(directory, "result-diagnostic.json");
  const phase = JSON.parse(await readFile(phaseFile, "utf8")), originalInputs = structuredClone(phase.inputs.filter(row => row.operation === "append").slice(0, 5));
  const workbuddy = phase.inputs.find(row => row.kind === "workbuddy"), zcode = phase.inputs.find(row => row.kind === "zcode");
  const interruptedAtMs = workbuddy.landedAtMs + 120100, resumedAtMs = interruptedAtMs + 60000;
  for (const row of originalInputs.filter(row => [workbuddy.eventId, zcode.eventId].includes(row.eventId))) {
    delete row.paintedAtMs; delete row.landingToPaintMs; delete row.usageVersion;
  }
  const failure = { message: `Unpublished input exceeded 120000ms: ${workbuddy.eventId}`, stack: "original paint timeout stack" };
  const originalPhase = { ...phase, passed: false, inputs: originalInputs, errors: [failure], endedAtMs: interruptedAtMs };
  if (lateLanding) originalPhase.inputs = originalInputs.filter(row => row.eventId !== zcode.eventId);
  delete originalPhase.observedDurationMs; delete originalPhase.oracle; delete originalPhase.drainMs;
  const runFile = path.join(f.root, "result.json"), run = JSON.parse(await readFile(runFile, "utf8"));
  const originalRun = { ...run, passed: false, failure, endedAtMs: interruptedAtMs + 1000 };
  Object.assign(workbuddy, { paintedAtMs: workbuddy.landedAtMs + 28859.5, landingToPaintMs: 28859.5, responseSequence: 40 });
  Object.assign(zcode, { paintedAtMs: zcode.landedAtMs + interruptedLatency, landingToPaintMs: interruptedLatency, responseSequence: 41,
    timingInterruption: { reason: "Service was closed by the probe while this input was landing", atMs: resumedAtMs } });
  const correction = { corrected: [structuredClone(workbuddy)], interrupted: [zcode.eventId], standardsChanged: false };
  const record = { atMs: resumedAtMs, reason: "resume after proven paint/response ordering race", original: "result-paint-interruption.json" };
  const paths = { original: path.join(f.root, record.original), phase: path.join(directory, "result-diagnostic-paint-interruption.json"),
    closed: path.join(directory, "failed-paint-closed.json"), summary: path.join(directory, "failed-paint-resource-summary.json"),
    correction: path.join(directory, "paint-order-correction.json") };
  await save(paths.original, originalRun);
  await save(paths.phase, originalPhase);
  await save(paths.closed, { failed: true, rawRestored: false, errors: [], projection });
  await save(paths.summary, { samples: 3, sampledPeakBytes: 100 * MiB, idle: [] });
  await save(paths.correction, correction);
  phase.continuation = { originalStartedAtMs: phase.startedAtMs, resumeOffsetMs: interruptedAtMs - phase.startedAtMs, pauseMs: 60000 };
  await save(phaseFile, phase);
  run.continuations = [run.continuation, record].filter(Boolean);
  await save(runFile, run);
  const eventsFile = path.join(directory, "events.ndjson");
  const events = (await readFile(eventsFile, "utf8")).trim().split("\n").map(JSON.parse)
    .filter(row => !(row.type === "input-visible" && [workbuddy.eventId, zcode.eventId].includes(row.eventId)));
  for (const input of [workbuddy, zcode]) events.push({ ...input, type: echoes ? "input-landed" : "input-visible", atMs: input.landedAtMs });
  await ndjson(eventsFile, events);
  const mutations = events.filter(row => row.type === "input-landed" && !Number.isFinite(row.paintedAtMs)).map(row => {
    const { type, atMs, eventId, usageVersion, responseSequence, paintedAtMs, landingToPaintMs, ...mutation } = row;
    return mutation;
  });
  const mutationFile = path.join(directory, "mutations/mutations.ndjson");
  await ndjson(mutationFile, mutations);
  return { paths, record, originalRun, originalPhase, correction, workbuddy, zcode, eventsFile, events, mutationFile, mutations };
}

async function addSessionsInterruption(f) {
  const directory = f.directories["two-years"], resultFile = path.join(directory, "result-endurance.json"), scheduleFile = path.join(directory, "schedule-endurance.json");
  const result = JSON.parse(await readFile(resultFile, "utf8")), schedule = JSON.parse(await readFile(scheduleFile, "utf8"));
  const inputs = structuredClone(result.inputs.filter(row => row.operation === "append").slice(0, 3));
  const delta = 10 * 60000, stoppedAtMs = schedule.startedAtMs + 5 * 60000;
  const failure = { message: "range distinct sessions\n17 !== 15", stack: "original session-selection assertion" };
  const originalPhase = { ...result, passed: false, inputs, errors: [failure], endedAtMs: stoppedAtMs };
  delete originalPhase.observedDurationMs; delete originalPhase.oracle; delete originalPhase.drainMs;
  const runFile = path.join(f.root, "result.json"), run = JSON.parse(await readFile(runFile, "utf8"));
  const originalRun = { ...run, passed: false, failure, endedAtMs: stoppedAtMs + 1000 };
  const paths = { original: path.join(f.root, "result-sessions-interruption.json"), result: path.join(directory, "result-endurance-sessions-interruption.json"),
    schedule: path.join(directory, "schedule-endurance-sessions-interruption.json"), closed: path.join(directory, "failed-sessions-closed.json"),
    summary: path.join(directory, "failed-sessions-resource-summary.json"), oracle: path.join(directory, "oracle-week-stop-scoped-result.json") };
  await save(paths.original, originalRun);
  await save(paths.result, originalPhase);
  await save(paths.schedule, schedule);
  await save(paths.closed, { failed: true, rawRestored: false, errors: [], projection });
  await save(paths.summary, { samples: 3, sampledPeakBytes: 100 * MiB, idle: [] });
  const oracle = { passed: true, ok: true, retry: false, checks: { totals: true, events: true, sessions: true, cost: true, ledger: false },
    actual: { sessionCount: 17, eventCount: 560, costEstimate: { totalUsd: .0407787 } }, oracle: { costEvents: 560, costOrder: "timestamp-history-ordinal" } };
  await save(paths.oracle, oracle);
  const acceptedId = id => typeof id === "string" ? id.replace(/^endurance-/, "endurance-accepted-") : id;
  const shift = row => {
    for (const field of ["atMs", "clock", "landedAtMs", "paintedAtMs", "startedAtMs", "endedAtMs"]) if (row[field] >= schedule.startedAtMs) row[field] += delta;
    return row;
  };
  const accepted = { ...schedule, startedAtMs: schedule.startedAtMs + delta, ordinalOffset: 16, eventIdPrefix: "endurance-accepted",
    events: schedule.events.map(row => ({ ...row, id: acceptedId(row.id) })) };
  for (const row of result.inputs) { row.eventId = acceptedId(row.eventId); row.usageVersion = acceptedId(row.usageVersion); if (row.operation === "append") row.ordinal += 3; shift(row); }
  result.startedAtMs += delta; result.endedAtMs += delta;
  await save(scheduleFile, accepted);
  await save(resultFile, result);
  const eventsFile = path.join(directory, "events.ndjson"), events = (await readFile(eventsFile, "utf8")).trim().split("\n").map(JSON.parse);
  for (const row of events) {
    if (row.eventId?.startsWith("endurance-")) { row.eventId = acceptedId(row.eventId); row.usageVersion = acceptedId(row.usageVersion); if (row.operation === "append") row.ordinal += 3; }
    row.id = acceptedId(row.id); row.commandId = acceptedId(row.commandId);
    if (row.type === "response" && row.atMs >= schedule.startedAtMs) for (const input of inputs) row.counts[input.kind]++;
    shift(row);
  }
  for (const row of inputs) events.push({ ...row, type: "input-landed", atMs: row.landedAtMs, paintedAtMs: undefined, landingToPaintMs: undefined },
    { ...row, type: "input-visible", atMs: row.paintedAtMs });
  await ndjson(eventsFile, events);
  for (const name of await readdir(path.join(directory, "control"))) {
    const file = path.join(directory, "control", name), rows = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
    rows.forEach(row => { row.commandId = acceptedId(row.commandId); shift(row); });
    if (name === "events-42.ndjson") for (const input of inputs) rows.push({ event: "source-end", kind: input.kind, atMs: input.landedAtMs + 50,
      method: "reuseSourcePrefix", committed: true, insertedEvents: 1, reusedEvents: 0, durationMs: 20 });
    await ndjson(file, rows);
  }
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && /^resources(?:-|$)/.test(entry.name)) {
      const file = path.join(directory, entry.name, "resources.ndjson"), rows = [];
      await streamNdjson(file, row => { if (row.atUnixMs >= schedule.startedAtMs) row.atUnixMs += delta;
        for (const process of row.processes) if (Date.parse(process.startTimeUtc) >= schedule.startedAtMs) process.startTimeUtc = new Date(Date.parse(process.startTimeUtc) + delta).toISOString();
        rows.push(row); });
      await ndjson(file, rows);
    }
    if (/^resource-summary.*\.json$/.test(entry.name)) {
      const file = path.join(directory, entry.name), value = JSON.parse(await readFile(file, "utf8"));
      value.idle.forEach(row => { if (row.atMs >= schedule.startedAtMs) row.atMs += delta; });
      await save(file, value);
    }
  }
  for (const name of await readdir(path.join(directory, "nodes"))) {
    const file = path.join(directory, "nodes", name), rows = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
    rows.forEach(shift); await ndjson(file, rows);
  }
  for (const name of ["closed.json", "final-reopen.json"]) { const file = path.join(directory, name); await save(file, shift(JSON.parse(await readFile(file, "utf8")))); }
  const mutationFile = path.join(directory, "mutations/mutations.ndjson");
  await ndjson(mutationFile, events.filter(row => row.type === "input-landed" && !Number.isFinite(row.paintedAtMs)));
  const record = { atMs: accepted.startedAtMs - 1000, reason: "restart eight hours after test session-selection error", original: "result-sessions-interruption.json" };
  run.interruptedEndurance = { result: "diagnostic/two-years/result-endurance-sessions-interruption.json", schedule: "diagnostic/two-years/schedule-endurance-sessions-interruption.json",
    reason: record.reason, inputs };
  run.continuations = [...(run.continuations ?? (run.continuation ? [run.continuation] : [])), record];
  await save(runFile, run);
  return { paths, originalRun, originalPhase, originalSchedule: schedule, oracle, accepted, inputs, eventsFile, events, mutationFile, record };
}

test("empty or still running formal evidence can never pass", async t => {
  const root = await temporary(t);
  const result = await analyzeWindowsStability(root, { referenceFile: path.join(root, "reference.json"), upgradeFile: path.join(root, "upgrade.json") });
  assert.equal(result.passed, false);
  assert.equal(result.reliability.status, "incomplete");
  assert.equal(result.resource.status, "incomplete");
  assert.equal(result.performance.notExecuted.length, 4);
  assert.ok(result.evidence.every(row => row.status === "missing"));
});

test("complete tiny ledgers cross-check all 384 scheduled inputs and stream corrected resource identities", async t => {
  const f = await fixture(t);
  const result = await f.analyze();
  assert.equal(result.reliability.status, "passed", JSON.stringify(result.reliability.checks.filter(row => row.status !== "passed")));
  assert.equal(result.resource.status, "passed", JSON.stringify(result.resource.checks.filter(row => row.status !== "passed")));
  assert.equal(result.passed, true);
  assert.equal(result.continuationAudit, null);
  const context = result.contexts[2], phase = context.phases[1];
  assert.equal(phase.inputs.length, 386);
  assert.equal(phase.schedule.ordinalOffset, 13);
  assert.equal(phase.inputs.find(row => row.operation === "append").ordinal, 14);
  assert.equal(phase.inputs.filter(row => row.operation === "append").at(-1).ordinal, 397);
  assert.equal(gate(result, "reliability", "two-years/endurance/append-ordinals").status, "passed");
  assert.deepEqual(phase.counts, { ordinary: 240, burst: 24, continuous: 120 });
  assert.deepEqual(Object.values(phase.ordinaryBySource), Array(6).fill(40));
  assert.equal(phase.bursts.length, 4);
  assert.ok(phase.distributions.every(row => row.latencyMs.count === row.count));
  assert.equal(context.resources.excludedIdentities[0].pid, 999);
  assert.equal(context.resources.sampledPeakBytes, 100 * MiB + 20 * 1024);
  assert.equal(context.resources.killed.length, 2);
  assert.match(context.resources.killed[0].bound, /no measured upper bound/);
  assert.equal(result.contexts[0].resources.killed.find(row => row.kind === "gateway-tree").pid, 42);
  assert.equal(gate(result, "resource", "current/exit-resource-coverage").status, "passed");
  assert.equal(gate(result, "reliability", "current/independent-network-disconnection").status, "passed");
  const source = context.control.sources.find(row => row.source === "codex" && row.category === "ordinary");
  assert.equal(source.netAdded, source.count, "reused prefix facts must not be subtracted from source net growth");
  assert.ok(context.control.projection.samples > context.control.projection.ordinarySamples / 3);
  assert.equal(context.control.projection.coldCopiedMax, 0);
});

test("original R failures retain three-tab context and historical shortfalls stay outstanding", async t => {
  const f = await fixture(t, { latency: { dsh: 4550 }, historicalFailure: true });
  const result = await f.analyze();
  const protection = gate(result, "performance", "prior-protection/current/mixed/append-dsh");
  assert.equal(protection.status, "failed");
  assert.equal(protection.evidence.samples[0].context.plannedTabs, 3);
  assert.equal(protection.evidence.current.count, 1);
  assert.equal(result.performance.retainedHistoricalFailures[0].candidateMs, 80519.5);
  assert.equal(result.passed, false);
  assert.equal(result.reliability.passed, true);
});

test("missing handles and idle memory growth remain resource hard gates", async t => {
  const f = await fixture(t, { missingHandleHour: 7, idleGrowth: 33, tempGrowth: true });
  const result = await f.analyze();
  assert.equal(gate(result, "resource", "two-years/idle-handle-growth").status, "incomplete");
  assert.equal(gate(result, "resource", "two-years/idle-memory-growth").status, "failed");
  assert.equal(gate(result, "resource", "two-years/idle-temp-file-growth").status, "failed");
  assert.equal(result.resource.passed, false);
});

test("park/kill evidence, normal WAL, and ZCode net-one are checked independently of runner passed", async t => {
  const f = await fixture(t, { killMarkers: false, badZcode: true });
  const file = path.join(f.directories["two-years"], "closed.json");
  const closed = JSON.parse(await readFile(file, "utf8"));
  closed.projection = { ...projection, walBytes: 4096, orphanDatabases: ["orphan.sqlite"] };
  await save(file, closed);
  const result = await f.analyze();
  assert.equal(gate(result, "reliability", "two-years/ordinary-zcode-net-added").status, "failed");
  assert.equal(result.reliability.checks.filter(row => row.id.endsWith("/real-fault")).length, 3);
  assert.ok(result.reliability.checks.filter(row => row.id.endsWith("/real-fault")).every(row => row.status === "failed"));
  assert.equal(gate(result, "resource", "two-years/normal-close-projection").status, "failed");
});

test("native exit high-water catches peaks between samples; ordinary and revision absolute limits remain separate", async t => {
  const f = await fixture(t, { nativePeakMiB: 513, latency: { codex: 35001, zcode: 78001 } });
  const result = await f.analyze();
  assert.equal(gate(result, "resource", "current/active-memory").status, "failed");
  const ordinary = result.performance.checks.find(row => row.evidence?.source === "codex" && row.evidence?.limitMs === 35000);
  const revision = result.performance.checks.find(row => row.evidence?.category === "revision");
  assert.equal(ordinary.status, "failed");
  assert.equal(revision.evidence.limitMs, 78000);
  assert.equal(revision.status, "failed");
});

test("stream parser preserves malformed lines, BOM/CRLF, precision, and partial input evidence", async t => {
  const directory = await temporary(t), file = path.join(directory, "tiny.ndjson"), errors = [], rows = [];
  await writeFile(file, '\uFEFF{"a":1}\r\n{bad}\r\n{"a":2}\r\n{"partial":');
  assert.equal(await streamNdjson(file, row => rows.push(row), errors), 2);
  assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(errors.map(row => row.line), [2, 4]);
  await writeFile(file, '{"startTimeUtcTicks":639297570421934806}\n');
  const ticks = [];
  await streamNdjson(file, row => ticks.push(row.startTimeUtcTicks), errors, parseResourceSample);
  assert.deepEqual(ticks, ["639297570421934806"]);
  const f = await fixture(t);
  const phaseFile = path.join(f.directories["two-years"], "result-endurance.json");
  const phase = JSON.parse(await readFile(phaseFile, "utf8"));
  phase.inputs.pop();
  await save(phaseFile, phase);
  const result = await f.analyze();
  assert.equal(gate(result, "reliability", "two-years/endurance/inputs").status, "failed");
});

test("late-hour R uses the same source and retains a small absolute regression", async t => {
  const f = await fixture(t), directory = f.directories["two-years"];
  const phaseFile = path.join(directory, "result-endurance.json");
  const phase = JSON.parse(await readFile(phaseFile, "utf8"));
  const changed = new Map();
  for (const input of phase.inputs.filter(row => row.kind === "codex" && row.category === "ordinary" && row.landedAtMs >= phase.startedAtMs + 7 * hour)) {
    input.landingToPaintMs = 1101;
    input.paintedAtMs = input.landedAtMs + 1101;
    changed.set(input.eventId, input);
  }
  await save(phaseFile, phase);
  const file = path.join(directory, "events.ndjson");
  const events = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  for (const event of events.filter(row => row.type === "input-visible" && changed.has(row.eventId))) Object.assign(event, changed.get(event.eventId));
  await ndjson(file, events);
  const result = await f.analyze();
  assert.equal(gate(result, "performance", "two-years/endurance/early-late/codex").status, "failed");
  assert.equal(gate(result, "performance", "two-years/endurance/early-late/dsh").status, "passed");
  assert.equal(result.reliability.passed, true);
});

test("missing evidence cannot erase an observed failure or be supplied by result.passed", async t => {
  const f = await fixture(t), directory = f.directories.current;
  const file = path.join(directory, "events.ndjson");
  const rows = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  rows.splice(rows.findIndex(row => row.type === "input-landed"), 1);
  await ndjson(file, rows);
  const overLimit = sample(epoch + 19000, { bytes: 513 * MiB });
  overLimit.service.memoryAvailableProcessCount = 0;
  await ndjson(path.join(directory, "resources/resources.ndjson"), [overLimit]);
  const stopped = sample(epoch + hour, { running: false });
  stopped.sqlite.categoryBytes.wal = 4096;
  await ndjson(path.join(directory, "resources-final-reopen/resources.ndjson"), [stopped]);
  const result = await f.analyze();
  assert.equal(gate(result, "reliability", "current/raw-input-evidence").status, "failed");
  assert.equal(gate(result, "resource", "current/active-memory").status, "failed");
  assert.equal(gate(result, "resource", "current/normal-close-primary-wal").status, "failed");
  assert.equal(gate(result, "resource", "current/normal-close-projection").status, "passed");
});

test("gateway SSE recovery is shared evidence while an offline action alone leaves independent coverage incomplete", async t => {
  const f = await fixture(t, { independentSse: false, latency: { dsh: 57694, workbuddy: 5422 } });
  const result = await f.analyze(), current = result.contexts[0], sse = current.sse;
  assert.equal(sse.pairs.length, 1);
  assert.equal(sse.pairs[0].sharedWithGatewayFault, true);
  assert.equal(sse.pairs[0].gatewayFaultCommandId, stabilitySchedule("diagnostic", "current").events.find(row => row.type === "arm-gateway-exit").id);
  assert.equal(sse.pairs[0].loggedErrorToOpenMs, 1020);
  assert.equal(sse.pairs[0].browserErrorToOpenMs, 1007);
  assert.equal(gate(result, "reliability", "current/sse-recovery-observed").status, "passed");
  assert.equal(gate(result, "reliability", "current/independent-network-disconnection").status, "incomplete");
  assert.equal(sse.independentNetworkDisconnection.windows[0].inputs[0].landingToPaintMs, 57694);
  assert.equal(current.phases[0].inputs.length, 9);
  assert.equal(gate(result, "reliability", "current/source-net-growth").status, "passed");
  assert.equal(gate(result, "reliability", "current/diagnostic/exact-business").status, "passed");
  assert.equal(result.reliability.status, "incomplete");
  assert.equal(result.passed, false);
});

test("initial opens, another tab's open, and a new page after normal close cannot stand in for SSE reconnect", async t => {
  const f = await fixture(t, { independentSse: false, killMarkers: false });
  const file = path.join(f.directories.current, "events.ndjson");
  const rows = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  const receipt = (event, page, offset) => ({ type: "browser", kind: "page-receipt", event, page, atMs: epoch + offset, clock: epoch + offset });
  rows.push(receipt("open", 0, 0), receipt("error", 1, 10), receipt("open", 0, 20),
    receipt("error", 0, 30), { type: "normal-close", atMs: epoch + 40 }, receipt("open", 0, 50));
  await ndjson(file, rows);
  const result = await f.analyze(), sse = result.contexts[0].sse;
  assert.equal(sse.pairs.length, 0);
  assert.equal(sse.unpairedErrors.length, 2);
  assert.equal(gate(result, "reliability", "current/sse-recovery-observed").status, "incomplete");
  assert.equal(gate(result, "reliability", "current/independent-network-disconnection").status, "incomplete");
});

test("hot scores remain historical display and only mixed append/reopen/scope scores enter R gates", async t => {
  const f = await fixture(t), reference = JSON.parse(await readFile(f.options.referenceFile, "utf8"));
  for (const group of reference.groups.filter(row => row.layout === "hot")) {
    group.scene.changes.forEach(row => { row.actualPaintMs = 1; });
    group.scene.reopen.wallMs = 1;
    group.latencies = [{ name: "scope-today", candidateMs: 1, passed: false }];
  }
  reference.groups.find(row => row.label === "current" && row.layout === "mixed").latencies.push({ name: "scope-today", candidateMs: 1000, passed: true });
  await save(f.options.referenceFile, reference);
  const eventsFile = path.join(f.directories.current, "events.ndjson");
  const events = (await readFile(eventsFile, "utf8")).trim().split("\n").map(JSON.parse);
  events.push({ type: "scope", preset: "today", wallMs: 1000, startedAtMs: epoch + 90000, endedAtMs: epoch + 91000 });
  await ndjson(eventsFile, events);
  const result = await f.analyze();
  assert.equal(result.passed, true);
  assert.ok(result.performance.checks.every(row => !row.id.includes("/hot/")));
  assert.equal(gate(result, "performance", "prior-protection/current/mixed/scope-today").status, "passed");
  assert.equal(result.performance.retainedHistoricalFailures.length, 0);
  assert.ok(result.reference.scores.filter(row => row.layout === "hot").every(row => row.comparisonStatus === "not-comparable" && row.layoutExecutedThisRun === false));
  assert.equal(result.reference.scores.find(row => row.layout === "hot").latencies[0].passed, false, "preserve the original historical result");
  reference.groups = reference.groups.filter(row => !(row.label === "current" && row.layout === "mixed"));
  await save(f.options.referenceFile, reference);
  const missing = await f.analyze();
  assert.equal(gate(missing, "performance", "prior-protection/current").status, "incomplete", "hot must not substitute for a missing mixed reference");
});

test("endurance ordinals honor the thirteen diagnostic appends even when runner passed is true", async t => {
  const f = await fixture(t), directory = f.directories["two-years"];
  const phaseFile = path.join(directory, "result-endurance.json"), eventsFile = path.join(directory, "events.ndjson");
  const phase = JSON.parse(await readFile(phaseFile, "utf8"));
  const first = phase.inputs.find(row => row.operation === "append");
  const events = (await readFile(eventsFile, "utf8")).trim().split("\n").map(JSON.parse);
  first.ordinal = 1;
  for (const event of events.filter(row => row.eventId === first.eventId && ["input-landed", "input-visible"].includes(row.type))) event.ordinal = 1;
  await save(phaseFile, phase);
  await ndjson(eventsFile, events);
  let result = await f.analyze();
  const ordinal = gate(result, "reliability", "two-years/endurance/append-ordinals");
  assert.equal(ordinal.status, "failed");
  assert.deepEqual(ordinal.evidence.ordinalMismatches, [{ eventId: first.eventId, actual: 1, expected: 14 }]);
  assert.equal(gate(result, "reliability", "two-years/endurance/inputs").status, "failed");
  for (const event of events.filter(row => row.eventId === first.eventId && ["input-landed", "input-visible"].includes(row.type))) event.ordinal = 14;
  await ndjson(eventsFile, events);
  result = await f.analyze();
  assert.equal(gate(result, "reliability", "two-years/input-record-agreement").status, "failed");
  first.ordinal = 14;
  await save(phaseFile, phase);
  const scheduleFile = path.join(directory, "schedule-endurance.json");
  const schedule = JSON.parse(await readFile(scheduleFile, "utf8"));
  schedule.ordinalOffset = 0;
  await save(scheduleFile, schedule);
  result = await f.analyze();
  assert.equal(gate(result, "reliability", "two-years/endurance/schedule").status, "failed");
  assert.equal(gate(result, "reliability", "two-years/endurance/append-ordinals").status, "failed");
});

test("a killed gateway's residual queue retains its depth and needs parent, restart, and recovered-input proof", async t => {
  const f = await fixture(t), directory = f.directories.current;
  const controlFile = path.join(directory, "control/events-42.ndjson"), eventsFile = path.join(directory, "events.ndjson");
  const controls = (await readFile(controlFile, "utf8")).trim().split("\n").map(JSON.parse);
  const events = (await readFile(eventsFile, "utf8")).trim().split("\n").map(JSON.parse);
  const gateway = controls.find(row => row.event === "process-born" && row.role === "gateway");
  const park = controls.find(row => row.event === "fault-parked");
  controls.push({ ...gateway, event: "request-queued", childPid: park.pid, requestId: 31, depth: 1, atMs: park.atMs - 1 });
  await ndjson(controlFile, controls);
  let result = await f.analyze(), current = result.contexts[0];
  assert.equal(gate(result, "reliability", "current/queue-drained").status, "passed");
  assert.equal(current.control.queueEndDepths[gateway.instance], 1);
  assert.equal(current.control.interruptedQueues[0].classification, "fault-interrupted");
  assert.equal(current.control.interruptedQueues[0].depth, 1);
  assert.equal(current.control.interruptedQueues[0].restart.pid, 43);
  assert.equal(current.control.interruptedQueues[0].recovery.landingToPaintMs, 5422);
  for (const variant of ["wrong-parent", "missing-restart", "unrecovered-input", "new-pending", "pid-reused"]) {
    const changedEvents = structuredClone(events), changedControls = structuredClone(controls);
    const phaseFile = path.join(directory, "result-diagnostic.json");
    const phase = JSON.parse(await readFile(phaseFile, "utf8"));
    const savedPhase = structuredClone(phase);
    if (variant === "wrong-parent") changedEvents.find(row => row.type === "fault-observed").ppid = 999;
    if (variant === "missing-restart") changedEvents.splice(changedEvents.findIndex(row => row.type === "gateway-restarted"), 1);
    if (variant === "unrecovered-input") {
      const input = phase.inputs.find(row => row.category === "gateway-recovery");
      delete input.paintedAtMs;
      delete input.landingToPaintMs;
      changedEvents.splice(changedEvents.findIndex(row => row.type === "input-visible" && row.eventId === input.eventId), 1);
    }
    if (variant === "new-pending") {
      const replacement = controls.find(row => row.event === "process-born" && row.pid === 43);
      changedControls.push({ ...replacement, event: "request-queued", depth: 2, atMs: replacement.atMs + 100 });
    }
    if (variant === "pid-reused") changedControls.push({ ...gateway, instance: "another-generation", atMs: park.atMs - 2 });
    await ndjson(controlFile, changedControls);
    await ndjson(eventsFile, changedEvents);
    await save(phaseFile, phase);
    result = await f.analyze();
    assert.equal(gate(result, "reliability", "current/queue-drained").status, "failed", variant);
    await save(phaseFile, savedPhase);
  }
});

test("the measured external write lock is distinct from untracked product transaction locks", async t => {
  const f = await fixture(t), file = path.join(f.directories.year, "control/events-42.ndjson");
  const rows = (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  rows.push({ event: "round-end", atMs: epoch + 20 * hour + 1000, durationMs: 6000 });
  await ndjson(file, rows);
  const result = await f.analyze(), resources = result.contexts[1].resources;
  assert.equal(resources.longestInjectedWriteLockMs, 3000);
  assert.equal(resources.longestWriteLockMs, undefined);
  assert.equal(resources.writeLockEvidence.productTransactionsDirectlyTracked, false);
  assert.equal(resources.writeLockEvidence.longestProductWriteLockMs, null);
  assert.equal(resources.writeLockEvidence.capturedSyncRoundMs.max, 6000);
  assert.match(resources.writeLockEvidence.limitation, /interrupted or untraced transactions have no measured upper bound/);
  assert.equal(gate(result, "resource", "year/write-lock-cost").evidence.scope, "controlled external write-lock injection only");
});

test("continuation audit retains the formal failure and correction while using only corrected/resumed idle timestamps", async t => {
  const f = await fixture(t), saved = await addIdleContinuation(f), result = await f.analyze();
  const audit = result.continuationAudit, year = result.contexts[1];
  assert.equal(audit.status, "passed");
  assert.equal(audit.classification, "tool-idle-misclassification");
  assert.equal(audit.originalFailureExists, true);
  assert.deepEqual(audit.originalRun.result, saved.originalRun);
  assert.deepEqual(audit.year.originalClosed.result, saved.originalClosed);
  assert.deepEqual(audit.year.originalResources.result, saved.originalResources);
  assert.deepEqual(audit.year.correction.result, saved.correction);
  assert.deepEqual(audit.record, saved.record);
  assert.equal(audit.currentRun.passed, true);
  assert.equal(audit.year.currentClosed.failed, false);
  assert.equal(audit.year.reopen.wallMs, 1000);
  assert.equal(audit.year.resourceDecision.originalIdleCount, 2);
  assert.equal(audit.year.resourceDecision.discardedIdleCount, 1);
  assert.equal(audit.year.resourceDecision.correctedOriginalIdleCount, 1);
  assert.equal(audit.year.resourceDecision.resumedIdleCount, 1);
  assert.equal(audit.year.resourceDecision.decisionIdleCount, 2);
  assert.equal(year.resources.idleSamples, 2);
  assert.equal(year.resources.idlePeakBytes, 120 * MiB);
  assert.equal(year.resources.sampledPeakBytes, 300 * MiB, "discarding an idle classification must retain its active resource cost");
  assert.equal(gate(result, "resource", "year/idle-correction-audit").status, "passed");
  assert.equal(result.passed, true);
  assert.equal(year.phases[0].inputs.length, 7);
  assert.equal(result.contexts[2].phases[1].inputs.length, 386);
  assert.deepEqual(JSON.parse(await readFile(saved.paths.original, "utf8")), saved.originalRun, "analysis must not rewrite failure evidence");
});

test("every continuation audit artifact is required; missing originals or correction cannot pass", async t => {
  const f = await fixture(t), saved = await addIdleContinuation(f);
  for (const file of Object.values(saved.paths)) {
    const content = await readFile(file, "utf8");
    await rm(file);
    const result = await f.analyze();
    assert.equal(result.continuationAudit.status, "incomplete", file);
    assert.equal(result.continuationAudit.classification, "unverified-continuation", file);
    assert.equal(gate(result, "resource", "year/idle-correction-audit").status, "incomplete", file);
    assert.equal(result.resource.passed, false, file);
    assert.equal(result.passed, false, file);
    assert.ok(result.evidence.some(row => row.file === file && row.status === "missing"), file);
    await writeFile(file, content);
  }
});

test("inconsistent idle corrections cannot relabel the original formal failure as a tool error", async t => {
  const f = await fixture(t), saved = await addIdleContinuation(f);
  for (const change of [
    { kept: 2 }, { standardsChanged: true }, { limitBytes: 512 * MiB }, { discarded: { atMs: 1 } },
    { discarded: [{ ...saved.correction.discarded[0], bytes: 301 * MiB }] },
    { discarded: [{ ...saved.correction.discarded[0], atMs: saved.resumedIdle.atMs }] },
  ]) {
    await save(saved.paths.correction, { ...saved.correction, ...change });
    const result = await f.analyze();
    assert.equal(result.continuationAudit.status, "failed", JSON.stringify(change));
    assert.equal(result.continuationAudit.originalFailureExists, true);
    assert.equal(result.continuationAudit.classification, "unverified-continuation");
    assert.equal(gate(result, "resource", "year/idle-correction-audit").status, "failed");
    assert.equal(result.passed, false);
  }
});

test("an audited idle misclassification does not exempt new resumed idle violations", async t => {
  const f = await fixture(t), saved = await addIdleContinuation(f);
  saved.resumedSample.processes[1].workingSetBytes = 270 * MiB;
  saved.resumedSample.processes[1].reportedPeakWorkingSetBytes = 270 * MiB;
  saved.resumedSample.service.workingSetBytes = 270 * MiB;
  saved.resumedSample.service.reportedPeakWorkingSetBytes = 270 * MiB;
  await ndjson(path.join(f.directories.year, "resources-resume/resources.ndjson"), [saved.resumedSample]);
  const result = await f.analyze();
  assert.equal(result.continuationAudit.status, "passed");
  assert.equal(result.contexts[1].resources.idlePeakBytes, 270 * MiB);
  assert.equal(gate(result, "resource", "year/idle-memory").status, "failed");
  assert.equal(result.resource.passed, false);
  assert.equal(result.passed, false);
});

test("verified continuation evidence does not complete a running run or permit an original pointer outside the run directory", async t => {
  const f = await fixture(t);
  await addIdleContinuation(f);
  const file = path.join(f.root, "result.json"), run = JSON.parse(await readFile(file, "utf8"));
  run.passed = false;
  delete run.endedAtMs;
  await save(file, run);
  let result = await f.analyze();
  assert.equal(result.continuationAudit.status, "passed");
  assert.equal(result.continuationAudit.currentRun.passed, false);
  assert.equal(result.continuationAudit.currentRun.endedAtMs, null);
  assert.equal(result.passed, false);
  run.continuation.original = "../outside.json";
  await save(file, run);
  result = await f.analyze();
  assert.equal(result.continuationAudit.status, "incomplete");
  assert.match(result.continuationAudit.issues[0], /inside the run directory/);
  assert.equal(result.continuationAudit.originalRun.result, null);
});

test("idle and paint audit chains retain both formal failures and strictly classify recovery-visible echoes", async t => {
  const f = await fixture(t), idle = await addIdleContinuation(f), saved = await addPaintContinuation(f);
  const result = await f.analyze(), current = result.contexts[2];
  assert.equal(result.continuationAudits.length, 2, "legacy continuation and its array entry must not duplicate the idle chain");
  assert.deepEqual(result.continuationAudit.originalRun.result, idle.originalRun);
  const paint = result.continuationAudits.find(row => row.type === "paint-order");
  assert.equal(paint.status, "passed", JSON.stringify(paint.issues));
  assert.equal(paint.classification, "tool-paint-order-race");
  assert.deepEqual(paint.originalRun.result, saved.originalRun);
  assert.deepEqual(paint.twoYears.originalPhase.result, saved.originalPhase);
  assert.ok(result.continuationAudits.every(row => row.originalFailureExists));
  assert.equal(current.events.recoveryVisibleEchoes.length, 2);
  for (const echo of current.events.recoveryVisibleEchoes) {
    assert.equal(echo.classification, "recovery-visible-echo");
    assert.equal(echo.originalRow.type, "input-landed");
    assert.deepEqual(JSON.parse(echo.source.raw), echo.originalRow);
    assert.ok(echo.source.line > 0);
  }
  assert.equal(gate(result, "reliability", "two-years/duplicate-inputs").status, "passed");
  assert.equal(gate(result, "reliability", "two-years/raw-input-evidence").status, "passed");
  assert.equal(gate(result, "reliability", "two-years/mutation-ledger-agreement").status, "passed");
  assert.equal(paint.twoYears.mutationAgreement.mutationCount, 400);
  assert.equal(paint.twoYears.mutationAgreement.firstLandingCount, 400);
  assert.equal(gate(result, "reliability", "two-years/paint-input-reconciliation").status, "passed");
  const sample = current.phases[0].inputs.find(row => row.eventId === saved.zcode.eventId);
  assert.equal(sample.category, "ordinary");
  assert.deepEqual(sample.timingInterruption, saved.zcode.timingInterruption);
  const distribution = current.phases[0].distributions.find(row => row.source === "zcode" && row.category === "ordinary");
  assert.equal(distribution.count, 1);
  assert.equal(distribution.latencyMs.count, 1);
  assert.equal(distribution.latencyMs.max, 240000);
  assert.equal(distribution.timingInterruptedCount, 1);
  assert.equal(gate(result, "performance", `two-years/diagnostic/${saved.workbuddy.eventId}`).evidence.actualMs, 28859.5);
  assert.equal(gate(result, "performance", `two-years/diagnostic/${saved.zcode.eventId}`).status, "failed");
  assert.equal(result.passed, false);
  const runFile = path.join(f.root, "result.json"), run = JSON.parse(await readFile(runFile, "utf8"));
  delete run.continuation;
  await save(runFile, run);
  assert.equal((await f.analyze()).continuationAudits.length, 2, "the array also works without the legacy field");
});

test("an interrupted timing below the numeric limit remains unaccepted and stays in its original denominator", async t => {
  const f = await fixture(t), saved = await addPaintContinuation(f, { interruptedLatency: 1000, echoes: false });
  const result = await f.analyze();
  assert.equal(result.continuationAudit, null);
  assert.equal(result.continuationAudits[0].status, "passed");
  assert.equal(gate(result, "performance", `two-years/diagnostic/${saved.zcode.eventId}`).status, "incomplete");
  assert.equal(result.contexts[2].phases[0].ordinaryBySource.zcode, 1);
  assert.equal(result.contexts[2].phases[0].inputs.length, 14);
  assert.equal(result.passed, false);
});

test("recovery-visible compatibility never exempts genuine duplicate landings, unlisted echoes, or mutation-ledger mismatches", async t => {
  const f = await fixture(t), saved = await addPaintContinuation(f);
  const actual = saved.events.find(row => row.type === "input-landed" && row.eventId === saved.workbuddy.eventId && !Number.isFinite(row.paintedAtMs));
  for (const variant of ["duplicate", "unlisted", "missing-version", "duplicate-mutation", "changed-mutation"]) {
    const events = structuredClone(saved.events), mutations = structuredClone(saved.mutations);
    if (variant === "duplicate") events.push(structuredClone(actual));
    if (variant === "unlisted") {
      const other = saved.events.find(row => row.type === "input-landed" && row.kind === "codex");
      events.push({ ...other, paintedAtMs: other.landedAtMs + 1000, usageVersion: "unlisted", responseSequence: 99 });
    }
    if (variant === "missing-version") delete events.find(row => row.type === "input-landed" && row.eventId === saved.workbuddy.eventId && Number.isFinite(row.paintedAtMs)).usageVersion;
    if (variant === "duplicate-mutation") mutations.push(structuredClone(mutations[0]));
    if (variant === "changed-mutation") mutations[0].landedAtMs++;
    await ndjson(saved.eventsFile, events);
    await ndjson(saved.mutationFile, mutations);
    const result = await f.analyze();
    const expected = variant.includes("mutation") ? "two-years/mutation-ledger-agreement" : "two-years/duplicate-inputs";
    assert.equal(gate(result, "reliability", expected).status, "failed", variant);
    assert.equal(result.passed, false, variant);
  }
});

test("every paint audit artifact is required and missing correction cannot authenticate visibility echoes", async t => {
  const f = await fixture(t);
  await addIdleContinuation(f);
  const saved = await addPaintContinuation(f);
  for (const file of Object.values(saved.paths)) {
    const content = await readFile(file, "utf8");
    await rm(file);
    const result = await f.analyze(), paint = result.continuationAudits.find(row => row.type === "paint-order");
    assert.equal(paint.status, "incomplete", file);
    assert.equal(result.continuationAudit.status, "passed", "the idle correction remains independently audited");
    assert.equal(gate(result, "resource", "two-years/paint-correction-audit").status, "incomplete");
    if (file === saved.paths.correction) {
      assert.equal(result.contexts[2].events.recoveryVisibleEchoes.length, 0);
      assert.equal(gate(result, "reliability", "two-years/duplicate-inputs").status, "failed");
    }
    assert.equal(result.passed, false);
    await writeFile(file, content);
  }
});

test("an append still landing at the failure snapshot needs its original raw landing, mutation, and timing marker", async t => {
  const f = await fixture(t), saved = await addPaintContinuation(f, { lateLanding: true });
  let result = await f.analyze(), paint = result.continuationAudits[0];
  assert.equal(paint.status, "passed");
  assert.equal(paint.twoYears.originalPhase.result.inputs.length, 4);
  assert.deepEqual(paint.twoYears.inputReconciliation.interruptedNotInOriginalPhase, [saved.zcode.eventId]);
  assert.equal(gate(result, "reliability", "two-years/paint-input-reconciliation").status, "passed");
  assert.equal(gate(result, "reliability", "two-years/mutation-ledger-agreement").status, "passed");
  const phaseFile = path.join(f.directories["two-years"], "result-diagnostic.json");
  const phase = JSON.parse(await readFile(phaseFile, "utf8"));
  delete phase.inputs.find(row => row.eventId === saved.zcode.eventId).timingInterruption;
  const events = structuredClone(saved.events);
  delete events.find(row => row.type === "input-landed" && row.eventId === saved.zcode.eventId && Number.isFinite(row.paintedAtMs)).timingInterruption;
  await save(phaseFile, phase);
  await ndjson(saved.eventsFile, events);
  result = await f.analyze();
  assert.equal(gate(result, "reliability", "two-years/paint-input-reconciliation").status, "failed");
  assert.equal(result.passed, false);
});

test("session-selection audit preserves the failed attempt and counts its three inputs only in the complete ledger", async t => {
  const f = await fixture(t), saved = await addSessionsInterruption(f), result = await f.analyze();
  const audit = result.continuationAudits[0], context = result.contexts[2], phase = context.phases[1];
  assert.equal(audit.type, "session-selection");
  assert.equal(audit.status, "passed", JSON.stringify(audit.issues));
  assert.deepEqual(audit.originalRun.result, saved.originalRun);
  assert.deepEqual(audit.twoYears.originalPhase.result, saved.originalPhase);
  assert.deepEqual(audit.twoYears.originalSchedule.result, saved.originalSchedule);
  assert.deepEqual(audit.twoYears.scopedOracle.result, saved.oracle);
  assert.equal(audit.twoYears.scopedOracle.result.checks.ledger, false, "scoped SQL/cost proof must not claim a full-ledger proof");
  assert.equal(context.interruptedEndurance.inputs.length, 3);
  assert.equal(context.interruptedEndurance.countedInAcceptedEndurance, false);
  assert.ok(context.interruptedEndurance.inputs.every(row => row.eventId.startsWith("endurance-two-years-")));
  assert.equal(phase.schedule.eventIdPrefix, "endurance-accepted");
  assert.equal(phase.schedule.ordinalOffset, 16);
  assert.equal(phase.inputs.filter(row => row.operation === "append")[0].ordinal, 17);
  assert.equal(phase.inputs.filter(row => row.operation === "append").at(-1).ordinal, 400);
  assert.equal(phase.inputs.length, 386);
  assert.deepEqual(phase.counts, { ordinary: 240, burst: 24, continuous: 120 });
  assert.deepEqual(Object.values(phase.ordinaryBySource), Array(6).fill(40));
  assert.equal(phase.result.observedDurationMs, 480 * 60000);
  assert.ok(phase.inputs.every(row => row.eventId.startsWith("endurance-accepted-")));
  assert.equal(gate(result, "reliability", "two-years/unexpected-inputs").status, "passed");
  assert.equal(gate(result, "reliability", "two-years/mutation-ledger-agreement").evidence.mutationCount, 403);
  assert.equal(context.control.sourceProgress.reduce((n, row) => n + row.expectedNetAdded, 0), 400);
  assert.equal(gate(result, "reliability", "two-years/source-net-growth").status, "passed");
  assert.equal(context.control.sources.filter(row => row.category === "interrupted-endurance:ordinary").length, 3);
  const faults = result.reliability.checks.filter(row => row.id.startsWith("two-years/endurance-accepted-") && row.id.endsWith("/real-fault"));
  assert.equal(faults.length, 2);
  assert.ok(faults.every(row => row.status === "passed"));
  assert.equal(gate(result, "reliability", "two-years/endurance/gateway-continuity").status, "passed");
  assert.equal(result.passed, true, JSON.stringify([...result.reliability.checks, ...result.resource.checks, ...result.performance.checks].filter(row => row.status !== "passed")));
});

test("accepted endurance keeps strict canonical counts, categories, times, duration, ordinals, and fault points", async t => {
  const f = await fixture(t), saved = await addSessionsInterruption(f), directory = f.directories["two-years"];
  const file = path.join(directory, "schedule-endurance.json");
  for (const variant of ["duration", "count", "time", "category", "fault-point", "prefix", "ordinal"]) {
    const schedule = structuredClone(saved.accepted);
    if (variant === "duration") schedule.durationMs -= 5 * 60000;
    if (variant === "count") schedule.appendCount = 387;
    if (variant === "time") schedule.events[0].atMs++;
    if (variant === "category") schedule.events.find(row => row.inputClass === "continuous").category = "ordinary";
    if (variant === "fault-point") schedule.events.find(row => row.type === "arm-before-commit").type = "arm-after-commit";
    if (variant === "prefix") schedule.eventIdPrefix = "anything-accepted";
    if (variant === "ordinal") schedule.ordinalOffset = 13;
    await save(file, schedule);
    const result = await f.analyze();
    assert.equal(gate(result, "reliability", "two-years/endurance/schedule").status, "failed", variant);
    assert.equal(result.passed, false, variant);
  }
  await save(file, saved.accepted);
  const resultFile = path.join(directory, "result-endurance.json"), phase = JSON.parse(await readFile(resultFile, "utf8"));
  phase.observedDurationMs -= 5 * 60000;
  await save(resultFile, phase);
  const short = await f.analyze();
  assert.equal(gate(short, "reliability", "two-years/endurance/completed").status, "failed", "the original five minutes cannot complete the new eight hours");
  assert.equal(gate(short, "reliability", "two-years/endurance/gateway-continuity").status, "incomplete");
  phase.observedDurationMs += 5 * 60000;
  await save(resultFile, phase);
  const controlFile = path.join(directory, "control/events-42.ndjson"), rows = (await readFile(controlFile, "utf8")).trim().split("\n").map(JSON.parse);
  rows.find(row => row.event === "fault-parked" && row.point === "before-commit").point = "after-commit-before-notify";
  await ndjson(controlFile, rows);
  const badFault = await f.analyze();
  assert.ok(badFault.reliability.checks.some(row => row.id.startsWith("two-years/endurance-accepted-") && row.id.endsWith("/real-fault") && row.status === "failed"));
});

test("accepted endurance neither whitelists additional old inputs nor permits a gateway restart during its eight hours", async t => {
  const f = await fixture(t), saved = await addSessionsInterruption(f), directory = f.directories["two-years"];
  const events = structuredClone(saved.events), extra = structuredClone(saved.inputs[0]);
  extra.eventId = saved.originalSchedule.events.filter(row => row.type === "append")[3].id;
  events.push({ ...extra, type: "input-landed" }, { ...extra, type: "input-visible" });
  await ndjson(saved.eventsFile, events);
  let result = await f.analyze();
  assert.equal(gate(result, "reliability", "two-years/unexpected-inputs").status, "failed");
  await ndjson(saved.eventsFile, saved.events);
  const controlFile = path.join(directory, "control/events-42.ndjson"), rows = (await readFile(controlFile, "utf8")).trim().split("\n").map(JSON.parse);
  rows.push({ event: "process-born", pid: 99, role: "gateway", instance: "unplanned-restart", atMs: saved.accepted.startedAtMs + 60000 });
  await ndjson(controlFile, rows);
  result = await f.analyze();
  assert.equal(gate(result, "reliability", "two-years/endurance/gateway-continuity").status, "failed");
});

test("session-selection audit requires every original artifact and the exact independent scoped proof", async t => {
  const f = await fixture(t), saved = await addSessionsInterruption(f);
  for (const file of Object.values(saved.paths)) {
    const content = await readFile(file, "utf8");
    await rm(file);
    const result = await f.analyze();
    assert.equal(result.continuationAudits[0].status, "incomplete", file);
    assert.equal(result.passed, false);
    await writeFile(file, content);
  }
  for (const variant of ["sessions", "cost", "cost-count"]) {
    const oracle = structuredClone(saved.oracle);
    if (variant === "sessions") oracle.actual.sessionCount = 15;
    if (variant === "cost") oracle.checks.cost = false;
    if (variant === "cost-count") oracle.oracle.costEvents = 559;
    await save(saved.paths.oracle, oracle);
    const result = await f.analyze();
    assert.equal(result.continuationAudits[0].status, "failed", variant);
    assert.equal(result.continuationAudits[0].originalFailureExists, true);
    assert.equal(result.passed, false);
  }
});

test("idle, paint, and session-selection chains coexist without accepting earlier contaminated timing", async t => {
  const f = await fixture(t);
  await addIdleContinuation(f);
  const paint = await addPaintContinuation(f);
  await addSessionsInterruption(f);
  const result = await f.analyze();
  assert.equal(result.continuationAudits.length, 3);
  assert.ok(result.continuationAudits.every(row => row.status === "passed" && row.originalFailureExists), JSON.stringify(result.continuationAudits.map(row => row.issues)));
  assert.equal(gate(result, "reliability", "two-years/mutation-ledger-agreement").status, "passed");
  assert.equal(gate(result, "reliability", "two-years/endurance/inputs").status, "passed");
  assert.equal(gate(result, "performance", `two-years/diagnostic/${paint.zcode.eventId}`).status, "failed");
  assert.equal(result.passed, false);
});
