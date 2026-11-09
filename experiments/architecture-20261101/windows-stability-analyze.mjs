import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { correctResourceIdentity, parseResourceSample, resourceSnapshotRows } from "./resource-identity-analysis.mjs";
import { stabilitySchedule, closeoutSchedule, CLOSEOUT_PROFILE, STABILITY_KINDS, quantiles, protectionPassed } from "./windows-stability-schedule.mjs";

const MiB = 1048576, hour = 3600000;
const project = fileURLToPath(new URL("../../", import.meta.url));
const defaultRoot = path.join(project, "output/windows-stability-20261109/formal-v2");
const defaultReference = path.join(project, "output/archive-compaction-20261108/analysis-all-continuation.json");
const defaultUpgrade = path.join(project, "output/archive-compaction-20261108/upgrades/two-years/result.json");
const finite = Number.isFinite;
const maximum = (a, b) => finite(b) ? Math.max(a ?? 0, b) : a;
const sum = values => values.reduce((a, b) => a + b, 0);
const verdict = (known, passed) => !known ? "incomplete" : passed ? "passed" : "failed";

function gates() {
  return { status: "incomplete", passed: false, checks: [] };
}
function check(group, id, status, evidence) {
  group.checks.push({ id, status, evidence });
}
function finish(group) {
  group.status = group.checks.some(row => row.status === "failed") ? "failed"
    : group.checks.length && group.checks.every(row => row.status === "passed") ? "passed" : "incomplete";
  group.passed = group.status === "passed";
  return group;
}

async function json(file, evidence) {
  try { return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, "")); }
  catch (error) {
    evidence.push({ file, status: error.code === "ENOENT" ? "missing" : "invalid", message: error.message });
    return null;
  }
}
async function names(directory) {
  try { return await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}

async function originalContinuation(root, record, evidence) {
  const issues = [];
  const originalFile = typeof record.original === "string" && record.original ? path.resolve(root, record.original) : null;
  const relative = originalFile && path.relative(root, originalFile);
  const inside = relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  const originalRun = inside ? await json(originalFile, evidence) : null;
  if (!inside) issues.push("Continuation original must name a separate evidence file inside the run directory");
  return { originalFile, originalRun, issues };
}

async function readContinuationAudit(root, run, evidence, record = run?.continuation) {
  if (!record) return null;
  const directory = path.join(root, "diagnostic/year");
  const { originalFile, originalRun, issues } = await originalContinuation(root, record, evidence);
  const closedFile = path.join(directory, "failed-idle-closed.json"), summaryFile = path.join(directory, "failed-idle-resource-summary.json");
  const correctionFile = path.join(directory, "idle-classification-correction.json");
  const originalClosed = await json(closedFile, evidence), originalResources = await json(summaryFile, evidence);
  const correction = await json(correctionFile, evidence);
  const baseline = new Map((Array.isArray(originalResources?.idle) ? originalResources.idle : []).map(row => [row.atMs, row]));
  const discarded = new Map((Array.isArray(correction?.discarded) ? correction.discarded : []).map(row => [row.atMs, row]));
  const correctedIdle = [...baseline.values()].filter(row => !discarded.has(row.atMs));
  const complete = Boolean(originalRun && originalClosed && originalResources && correction);
  if (complete) {
    if (originalRun.passed !== false || originalRun.failure?.message !== "Idle service tree exceeded 256 MiB" ||
      originalRun.cleanupError || originalClosed.failed !== true || originalClosed.errors?.length) issues.push("Original evidence is not solely the recorded idle-classification interruption");
    if (!Array.isArray(originalResources.idle) || !Array.isArray(correction.discarded) ||
      baseline.size !== originalResources.idle?.length || discarded.size !== correction.discarded?.length ||
      [...discarded.values()].some(row => !baseline.has(row.atMs) || baseline.get(row.atMs).bytes !== row.bytes)) issues.push("Discarded timestamps/bytes do not match the original idle ledger");
    if (correction.standardsChanged !== false || correction.limitBytes !== 256 * MiB || correction.kept !== correctedIdle.length)
      issues.push("Correction changed the idle standard or has inconsistent retained counts");
    if (![...discarded.values()].some(row => row.bytes > 256 * MiB) || correctedIdle.some(row => !finite(row.bytes) || row.bytes > 256 * MiB))
      issues.push("Correction does not resolve the original over-budget idle sample");
  }
  const status = !complete ? "incomplete" : issues.length ? "failed" : "passed";
  return { status, type: "idle-classification", scope: "year", classification: status === "passed" ? "tool-idle-misclassification" : "unverified-continuation", issues, record,
    originalFailureExists: originalRun?.passed === false && Boolean(originalRun.failure),
    originalRun: { file: originalFile, result: originalRun },
    year: { originalClosed: { file: closedFile, result: originalClosed }, originalResources: { file: summaryFile, result: originalResources },
      correction: { file: correctionFile, result: correction },
      resourceDecision: { source: "corrected original idle timestamps plus current/resumed idle timestamps; discarded original timestamps stay excluded",
        originalIdleCount: baseline.size, discardedIdleCount: discarded.size, correctedOriginalIdleCount: correctedIdle.length } },
    currentRun: { passed: run.passed, startedAtMs: run.startedAtMs, endedAtMs: run.endedAtMs ?? null,
      failure: run.failure ?? null, cleanupError: run.cleanupError ?? null } };
}

async function readPaintContinuationAudit(root, run, record, evidence) {
  const directory = path.join(root, "diagnostic/two-years");
  const { originalFile, originalRun, issues } = await originalContinuation(root, record, evidence);
  const phaseFile = path.join(directory, "result-diagnostic-paint-interruption.json"), closedFile = path.join(directory, "failed-paint-closed.json");
  const summaryFile = path.join(directory, "failed-paint-resource-summary.json"), correctionFile = path.join(directory, "paint-order-correction.json");
  const originalPhase = await json(phaseFile, evidence), originalClosed = await json(closedFile, evidence);
  const originalResources = await json(summaryFile, evidence), correction = await json(correctionFile, evidence);
  const originals = new Map((Array.isArray(originalPhase?.inputs) ? originalPhase.inputs : []).map(row => [row.eventId, row]));
  const corrected = Array.isArray(correction?.corrected) ? correction.corrected : [];
  const interrupted = Array.isArray(correction?.interrupted) ? correction.interrupted : [];
  const plannedInputs = new Set(stabilitySchedule("diagnostic", "two-years").events.filter(row => row.type === "append").map(row => row.id));
  const timeoutEvent = /^Unpublished input exceeded 120000ms: (.+)$/.exec(originalRun?.failure?.message ?? "")?.[1];
  const complete = Boolean(originalRun && originalPhase && originalClosed && originalResources && correction);
  if (complete) {
    if (originalRun.passed !== false || !timeoutEvent || originalRun.cleanupError || originalPhase.passed !== false ||
      originalClosed.failed !== true || originalClosed.errors?.length) issues.push("Original evidence is not the recorded paint-order interruption");
    if (correction.standardsChanged !== false || !Array.isArray(correction.corrected) || !Array.isArray(correction.interrupted) ||
      !corrected.some(row => row.eventId === timeoutEvent) || new Set([...corrected.map(row => row.eventId), ...interrupted]).size !== corrected.length + interrupted.length ||
      interrupted.some(id => !plannedInputs.has(id))) issues.push("Paint correction has missing, duplicate, or unknown input references");
    if (corrected.some(row => {
      const original = originals.get(row.eventId);
      return !original || original.paintedAtMs != null || row.kind !== original.kind || row.category !== original.category ||
        row.ordinal !== original.ordinal || row.landedAtMs !== original.landedAtMs || !finite(row.paintedAtMs) ||
        !finite(row.landingToPaintMs) || row.landingToPaintMs < 0 || row.landingToPaintMs > 120000 ||
        Math.abs(row.paintedAtMs - row.landedAtMs - row.landingToPaintMs) > 1 || row.paintedAtMs > originalPhase.endedAtMs ||
        !row.usageVersion || !Number.isSafeInteger(row.responseSequence) || row.responseSequence <= 0;
    })) issues.push("Corrected paint does not match an original unconfirmed input and a pre-interruption visible value");
  }
  const status = !complete ? "incomplete" : issues.length ? "failed" : "passed";
  return { status, type: "paint-order", scope: "two-years", record, issues,
    classification: status === "passed" ? "tool-paint-order-race" : "unverified-continuation",
    originalFailureExists: originalRun?.passed === false && Boolean(originalRun.failure), originalRun: { file: originalFile, result: originalRun },
    twoYears: { originalPhase: { file: phaseFile, result: originalPhase }, originalClosed: { file: closedFile, result: originalClosed },
      originalResources: { file: summaryFile, result: originalResources }, correction: { file: correctionFile, result: correction },
      timingPolicy: "Interrupted inputs retain their category, ordinal, raw elapsed latency, and denominator. Their latency gates cannot pass solely because the probe was corrected." },
    currentRun: { passed: run.passed, startedAtMs: run.startedAtMs, endedAtMs: run.endedAtMs ?? null, failure: run.failure ?? null } };
}

function canonicalSchedule(mode, label, prefix) {
  if(mode.startsWith("closeout-"))return closeoutSchedule(mode,label);
  const schedule = stabilitySchedule(mode, label);
  if (mode === "endurance" && prefix === "endurance-accepted") {
    schedule.eventIdPrefix = prefix;
    schedule.events = schedule.events.map(row => ({ ...row, id: row.id.replace(/^endurance-/, "endurance-accepted-") }));
  }
  return schedule;
}

async function readSessionContinuationAudit(root, run, record, evidence) {
  const directory = path.join(root, "diagnostic/two-years");
  const { originalFile, originalRun, issues } = await originalContinuation(root, record, evidence);
  const phaseFile = path.join(directory, "result-endurance-sessions-interruption.json"), scheduleFile = path.join(directory, "schedule-endurance-sessions-interruption.json");
  const closedFile = path.join(directory, "failed-sessions-closed.json"), summaryFile = path.join(directory, "failed-sessions-resource-summary.json");
  const oracleFile = path.join(directory, "oracle-week-stop-scoped-result.json");
  const originalPhase = await json(phaseFile, evidence), originalSchedule = await json(scheduleFile, evidence);
  const originalClosed = await json(closedFile, evidence), originalResources = await json(summaryFile, evidence), oracle = await json(oracleFile, evidence);
  const metadata = run.interruptedEndurance, inputs = Array.isArray(originalPhase?.inputs) ? originalPhase.inputs : [];
  const expected = stabilitySchedule("endurance"), early = expected.events.filter(row => row.type === "append").slice(0, 3);
  const complete = Boolean(originalRun && originalPhase && originalSchedule && originalClosed && originalResources && oracle && metadata);
  if (complete) {
    if (originalRun.passed !== false || !originalRun.failure?.message?.includes("17 !== 15") || originalRun.cleanupError ||
      originalPhase.passed !== false || originalClosed.failed !== true || originalClosed.errors?.length) issues.push("Original evidence is not the recorded session-selection failure");
    if (metadata.result !== path.relative(root, phaseFile).split(path.sep).join("/") || metadata.schedule !== path.relative(root, scheduleFile).split(path.sep).join("/") ||
      !Array.isArray(metadata.inputs) || inputs.length !== 3 || metadata.inputs.length !== 3 ||
      inputs.some((input, i) => ["eventId", "operation", "kind", "ordinal", "category", "landedAtMs", "id", "identity", "filePath"].some(key => input[key] !== metadata.inputs[i]?.[key])))
      issues.push("Interrupted endurance pointers or original three inputs do not match the archive");
    if (originalSchedule.durationMs !== expected.durationMs || originalSchedule.appendCount !== 384 || originalSchedule.ordinalOffset !== 13 ||
      JSON.stringify(originalSchedule.events) !== JSON.stringify(expected.events) ||
      inputs.some((row, i) => row.eventId !== early[i]?.id || row.operation !== "append" || row.kind !== early[i]?.kind || row.category !== early[i]?.category || row.ordinal !== 14 + i))
      issues.push("Interrupted endurance is not the original canonical attempt with exactly its first three ordinary appends");
    if (oracle.passed !== true || oracle.ok !== true || oracle.retry !== false ||
      ["totals", "events", "sessions", "cost"].some(key => oracle.checks?.[key] !== true) ||
      oracle.actual?.sessionCount !== 17 || oracle.actual?.eventCount !== 560 || oracle.oracle?.costEvents !== 560)
      issues.push("The retained week response lacks the exact 17-session/560-event SQL and ordered-cost proof");
  }
  const status = !complete ? "incomplete" : issues.length ? "failed" : "passed";
  return { status, type: "session-selection", scope: "two-years", record, issues,
    classification: status === "passed" ? "tool-session-selection-error" : "unverified-continuation",
    originalFailureExists: originalRun?.passed === false && Boolean(originalRun.failure), originalRun: { file: originalFile, result: originalRun },
    twoYears: { originalPhase: { file: phaseFile, result: originalPhase }, originalSchedule: { file: scheduleFile, result: originalSchedule },
      originalClosed: { file: closedFile, result: originalClosed }, originalResources: { file: summaryFile, result: originalResources },
      scopedOracle: { file: oracleFile, result: oracle, scope: "Retained week response only; this proof does not assert a complete mutation-ledger check." } },
    interruptedEndurance: { ...metadata, inputs, status: "interrupted", countedInAcceptedEndurance: false, distributions: distributions(inputs) },
    currentRun: { passed: run.passed, startedAtMs: run.startedAtMs, endedAtMs: run.endedAtMs ?? null, failure: run.failure ?? null } };
}

function continuationIdleRows(audit, summaries) {
  const original = new Map(audit.year.originalResources.result.idle.map(row => [row.atMs, row]));
  const discarded = new Set(audit.year.correction.result.discarded.map(row => row.atMs));
  // The archived ledger supplies only corrected timestamps, never its original over-budget idle list.
  const selected = new Map([...original].filter(([atMs]) => !discarded.has(atMs)));
  for (const summary of summaries) for (const row of summary.idle ?? []) if (!original.has(row.atMs)) selected.set(row.atMs, row);
  audit.year.resourceDecision.resumedIdleCount = selected.size - audit.year.resourceDecision.correctedOriginalIdleCount;
  audit.year.resourceDecision.decisionIdleCount = selected.size;
  return [...selected.values()];
}

// Snapshot the byte boundary: a live runner's later writes belong to the next analysis.
export async function streamNdjson(file, visit, evidence = [], parse = JSON.parse) {
  let size;
  try { size = (await stat(file)).size; }
  catch (error) { evidence.push({ file, status: error.code === "ENOENT" ? "missing" : "invalid", message: error.message }); return 0; }
  if (!size) return 0;
  const input = createReadStream(file, { end: size - 1 });
  let count = 0, lineNumber = 0;
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (let line of lines) {
      lineNumber++;
      if (lineNumber === 1) line = line.replace(/^\uFEFF/, "");
      if (!line.trim()) continue;
      let row;
      try { row = parse(line); }
      catch (error) { evidence.push({ file, line: lineNumber, status: "invalid", message: error.message }); continue; }
      visit(row, { file, line: lineNumber, raw: line });
      count++;
    }
  } catch (error) { evidence.push({ file, line: lineNumber, status: error.code === "ENOENT" ? "missing" : "invalid", message: error.message }); }
  finally { lines.close(); input.destroy(); }
  return count;
}

function distributions(inputs) {
  const buckets = new Map();
  for (const row of inputs) {
    const key = `${row.kind ?? "unknown"}/${row.category ?? "unknown"}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  return [...buckets].map(([key, rows]) => ({ source: key.split("/")[0], category: key.split("/")[1],
    count: rows.length, visibleCount: rows.filter(row => finite(row.paintedAtMs)).length,
    missingEventIds: rows.filter(row => !finite(row.paintedAtMs)).map(row => row.eventId),
    timingInterruptedCount: rows.filter(row => row.timingInterruption).length,
    timingInterruptedEventIds: rows.filter(row => row.timingInterruption).map(row => row.eventId),
    latencyMs: quantiles(rows.map(row => row.landingToPaintMs)) }));
}

function mergeInput(ledger, row, conflicts) {
  const previous = ledger.get(row.eventId);
  for (const key of ["operation", "kind", "category", "ordinal", "filePath", "landedAtMs", "paintedAtMs", "landingToPaintMs", "usageVersion", "responseSequence", "outputDelta",
    "viewVisibleAtMs", "viewLandingToPaintMs", "viewUsageVersion", "viewResponseSequence", "viewPreset", "viewPage"]) {
    if (previous?.[key] !== undefined && row[key] !== undefined && previous[key] !== row[key]) {
      conflicts.push({ eventId: row.eventId, key, before: previous[key], after: row[key] });
    }
  }
  ledger.set(row.eventId, { ...previous, ...row });
}

function sseRecovery(events, phases, reliability) {
  const eventTime = row => finite(row.clock) ? row.clock : finite(row.at) ? row.at : row.atMs;
  const pending = new Map(), pairs = [], unpairedErrors = [];
  let openWithoutErrorCount = 0;
  for (const receipt of [...events.sse].sort((a, b) => eventTime(a) - eventTime(b))) {
    if (receipt.event === "error") {
      if (!pending.has(receipt.page)) pending.set(receipt.page, []);
      pending.get(receipt.page).push(receipt);
      continue;
    }
    const errors = pending.get(receipt.page);
    if (!errors) { openWithoutErrorCount++; continue; }
    pending.delete(receipt.page);
    const error = errors[0];
    // Page index 0 is reused at final reopen; a new page's first open is not a reconnect.
    if (events.normalCloses.some(row => row.atMs > eventTime(error) && row.atMs < eventTime(receipt))) {
      unpairedErrors.push(...errors); openWithoutErrorCount++; continue;
    }
    const fault = events.faults.find(row => row.type === "fault-observed" && row.atMs <= eventTime(error) &&
      events.faults.some(restart => restart.type === "gateway-restarted" && restart.atMs >= eventTime(error) &&
        restart.atMs <= eventTime(receipt) + 300000));
    pairs.push({ page: receipt.page, errors, error, open: receipt,
      browserErrorToOpenMs: eventTime(receipt) - eventTime(error), loggedErrorToOpenMs: receipt.atMs - error.atMs,
      sharedWithGatewayFault: Boolean(fault), gatewayFaultCommandId: fault?.commandId ?? null,
      inputs: phases.flatMap(row => row.inputs).filter(input => input.landedAtMs <= eventTime(receipt) && input.paintedAtMs >= eventTime(error))
        .map(input => ({ eventId: input.eventId, source: input.kind, category: input.category, landingToPaintMs: input.landingToPaintMs })) });
  }
  unpairedErrors.push(...[...pending.values()].flat());
  const windows = phases.flatMap(phase => (phase.schedule?.events ?? []).filter(row => row.type === "disconnect").map(row => {
    const startedAtMs = phase.schedule.startedAtMs + row.atMs;
    const independentPairs = pairs.filter(pair => !pair.sharedWithGatewayFault && eventTime(pair.error) >= startedAtMs &&
      eventTime(pair.error) <= startedAtMs + 3000 && eventTime(pair.open) <= startedAtMs + 300000);
    return { eventId: row.id, startedAtMs, plannedOfflineMs: 3000, independentPairs,
      status: independentPairs.length ? "passed" : "incomplete",
      inputs: phase.inputs.filter(input => input.category === "reconnect").map(input => ({ eventId: input.eventId, source: input.kind,
        landingToPaintMs: input.landingToPaintMs, paintedAtMs: input.paintedAtMs })) };
  }));
  const result = { receipts: events.sse, pairs, unpairedErrors, openWithoutErrorCount, independentNetworkDisconnection: {
    status: windows.length && windows.every(row => row.status === "passed") ? "passed" : "incomplete", windows,
    limitation: "A scheduled CDP offline action and a visible append do not prove an existing SSE disconnected. Gateway-fault error/open is shared recovery evidence, not independent network-disconnection coverage." } };
  check(reliability, "current/sse-recovery-observed", pairs.length ? "passed" : "incomplete", { pairs, unpairedErrors });
  check(reliability, "current/independent-network-disconnection", result.independentNetworkDisconnection.status, result.independentNetworkDisconnection);
  return result;
}

function phaseAnalysis(label, mode, schedule, result, ledger, events, reliability, performance, restartEndurance = false, baseAppendCount = null, selectedViewClock = false) {
  const id = `${label}/${mode}`, expected = canonicalSchedule(mode, label, schedule?.eventIdPrefix);
  const closeout=expected.profile===CLOSEOUT_PROFILE;
  const expectedOrdinalOffset = baseAppendCount ?? (mode === "endurance" ? stabilitySchedule("diagnostic", label).appendCount + (restartEndurance ? 3 : 0) : 0);
  const ordinalOffsetMatches = schedule?.ordinalOffset === expectedOrdinalOffset;
  const prefixMatches = mode === "endurance" && restartEndurance ? schedule?.eventIdPrefix === "endurance-accepted" : schedule?.eventIdPrefix === undefined;
  const planned = new Map(expected.events.map(row => [row.id, row]));
  const inputs = [...ledger.values()].filter(row => planned.has(row.eventId)).map(row => ({ ...row }));
  for (const input of inputs) {
    const event = planned.get(input.eventId);
    const atMs = finite(schedule?.startedAtMs) ? input.landedAtMs - schedule.startedAtMs : event.atMs;
    const tabsOpen = expected.events.filter(row => row.type === "tabs-open"&&row.atMs<=atMs).at(-1);
    const tabsClose = tabsOpen&&expected.events.find(row => row.type === "tabs-close"&&row.atMs>=tabsOpen.atMs);
    const inTabs = tabsOpen && atMs < (tabsClose?.atMs??Infinity);
    input.scheduleContext = { plannedAtMs: event.atMs, inputClass: event.inputClass ?? event.type,
      plannedTabs: inTabs ? 3 : 1, plannedTabsWindow: inTabs ? { fromMs: tabsOpen.atMs, toMs: tabsClose?.atMs??null } : null,
      plannedScopes: expected.events.filter(row => row.type === "scopes" && finite(schedule?.startedAtMs) &&
        schedule.startedAtMs + row.atMs >= input.landedAtMs && schedule.startedAtMs + row.atMs <= (input.paintedAtMs ?? input.landedAtMs)),
      observedScopes: events.scopes.filter(row => row.startedAtMs <= (input.paintedAtMs ?? input.landedAtMs) && row.endedAtMs >= input.landedAtMs),
      comparison: inTabs ? "Three-tab window differs from the previous single-tab reference; raw R verdict and denominator retained." : "Fixed schedule context; no concurrency exemption applied." };
  }
  const missing = expected.events.filter(row => ["append", "revision"].includes(row.type) && !ledger.has(row.id)).map(row => row.id);
  const mismatched = inputs.filter(row => {
    const event = planned.get(row.eventId);
    return row.operation !== event.type || row.kind !== (event.kind ?? "zcode") || row.category !== event.category ||
      (event.type === "append" && row.ordinal !== event.ordinal + schedule?.ordinalOffset) ||
      (event.type === "revision" && row.outputDelta !== event.outputDelta);
  }).map(row => row.eventId);
  const scheduleMatches = schedule && prefixMatches && ordinalOffsetMatches && schedule.durationMs === expected.durationMs && schedule.appendCount === expected.appendCount &&
    JSON.stringify(schedule.events) === JSON.stringify(expected.events)&&(!closeout||schedule.profile===CLOSEOUT_PROFILE&&schedule.version===3&&schedule.observationVersion===2&&JSON.stringify(schedule.cycles)===JSON.stringify(expected.cycles));
  check(reliability, `${id}/schedule`, schedule ? verdict(true, scheduleMatches) : "not-executed", {
    expectedAppends: expected.appendCount, expectedOrdinalOffset, actualOrdinalOffset: schedule?.ordinalOffset ?? null,
    missingInputs: missing, mismatchedInputs: mismatched,
  });
  const appendInputs = inputs.filter(row => row.operation === "append");
  const ordinalMismatches = appendInputs.filter(row => row.ordinal !== planned.get(row.eventId).ordinal + schedule?.ordinalOffset)
    .map(row => ({ eventId: row.eventId, actual: row.ordinal ?? null, expected: planned.get(row.eventId).ordinal + schedule?.ordinalOffset }));
  check(reliability, `${id}/append-ordinals`, verdict(Boolean(schedule) && appendInputs.length > 0,
    ordinalOffsetMatches && !ordinalMismatches.length), { expectedOrdinalOffset, actualOrdinalOffset: schedule?.ordinalOffset ?? null, ordinalMismatches });
  const counts = Object.fromEntries(["ordinary", "burst", "continuous"].map(category => [category,
    appendInputs.filter(row => planned.get(row.eventId).inputClass === category).length]));
  const bySource = Object.fromEntries(STABILITY_KINDS.map(kind => [kind,
    appendInputs.filter(row => row.kind === kind && planned.get(row.eventId).inputClass === "ordinary").length]));
  const bursts = [...new Set(expected.events.filter(row => row.inputClass === "burst").map(row => row.atMs))].map(atMs => ({ atMs,
    planned: expected.events.filter(row => row.inputClass === "burst" && row.atMs === atMs).length,
    landed: appendInputs.filter(row => planned.get(row.eventId).inputClass === "burst" && planned.get(row.eventId).atMs === atMs).length }));
  check(reliability, `${id}/inputs`, verdict(Boolean(result), !missing.length && !mismatched.length &&
    appendInputs.length === expected.appendCount && result?.inputs?.length === inputs.length), { counts, ordinaryBySource: bySource, bursts, missing });
  check(reliability, `${id}/completed`, result ? verdict(true, result.passed === true && !result.errors?.length &&
    result.observedDurationMs >= expected.durationMs && (mode !== "endurance" || result.startedAtMs === schedule?.startedAtMs)) : "not-executed", {
    passed: result?.passed ?? null, observedDurationMs: result?.observedDurationMs ?? null,
    plannedDurationMs: expected.durationMs, errors: result?.errors ?? [],
  });
  check(reliability, `${id}/exact-business`, verdict(Boolean(result?.oracle), result?.oracle?.passed === true &&
    result.oracle.retry !== true && result.oracle.skipped === undefined), result?.oracle ?? null);
  const paintedField=selectedViewClock?"viewVisibleAtMs":"paintedAtMs",latencyField=selectedViewClock?"viewLandingToPaintMs":"landingToPaintMs";
  const unpublished = inputs.filter(row => !finite(row[paintedField])).map(row => row.eventId);
  const overdue = inputs.filter(row => finite(row[latencyField]) &&
    row[latencyField] > (row.category === "ordinary" ? 120000 : 300000)).map(row => row.eventId);
  check(reliability, `${id}/publication-deadlines`, verdict(Boolean(result), !unpublished.length && !overdue.length && !missing.length), { clock:selectedViewClock?"versioned-selected-view":"all", unpublished, overdue });
  check(reliability, `${id}/drain`, verdict(finite(result?.drainMs), result?.drainMs <= 300000), { drainMs: result?.drainMs ?? null, limitMs: 300000 });
  const invalidLatency = inputs.filter(row => finite(row.paintedAtMs) && (!finite(row.landingToPaintMs) || row.landingToPaintMs < 0 ||
    Math.abs(row.paintedAtMs - row.landedAtMs - row.landingToPaintMs) > 1)).map(row => row.eventId);
  check(reliability, `${id}/latency-evidence`, verdict(inputs.length > 0, !invalidLatency.length), { invalidLatency });
  if (label === "two-years") for (const row of inputs.filter(row => row.category === "ordinary" || row.operation === "revision")) {
    const limitMs = row.operation === "revision" ? 78000 : row.kind === "zcode" ? 45000 : row.kind === "opencode" ? 42000 : 35000;
    const status = finite(row.landingToPaintMs) && row.landingToPaintMs > limitMs ? "failed"
      : row.timingInterruption ? "incomplete" : finite(row.landingToPaintMs) ? "passed" : "not-executed";
    check(performance, `${id}/${row.eventId}`, status,
      { source: row.kind, category: row.category, actualMs: row.landingToPaintMs ?? null, limitMs, timingInterruption: row.timingInterruption ?? null });
    if(selectedViewClock)check(performance,`${id}/selected-view/${row.eventId}`,verdict(finite(row.viewLandingToPaintMs),row.viewLandingToPaintMs<=limitMs),
      {source:row.kind,category:row.category,preset:row.viewPreset,actualMs:row.viewLandingToPaintMs??null,limitMs});
  }
  if(mode==="closeout-soak"){
    const start=schedule?.startedAtMs;
    for(const cycle of expected.cycles){
      const continuous=inputs.filter(row=>planned.get(row.eventId).cycle===cycle.cycle&&planned.get(row.eventId).inputClass==="continuous");
      const publications=continuous.filter(row=>row[paintedField]>=start+(cycle.cycle-1)*30*60000+15*60000&&row[paintedField]<=start+cycle.lastInputAtMs);
      const versions=new Set(publications.map(row=>selectedViewClock?row.viewUsageVersion:row.usageVersion).filter(Boolean));
      check(reliability,`${id}/cycle-${cycle.cycle}/continuous-publication`,verdict(Boolean(result),continuous.length===24&&versions.size>1),{planned:24,landed:continuous.length,versions:versions.size});
    }
    for(const category of ["ordinary","burst","continuous"]){
      const values=cycle=>inputs.filter(row=>planned.get(row.eventId).cycle===cycle&&planned.get(row.eventId).inputClass===category).map(row=>row.landingToPaintMs);
      const first=quantiles(values(1)),last=quantiles(values(4));
      check(performance,`${id}/first-fourth/${category}`,verdict(Boolean(first&&last),first&&last&&protectionPassed(first.p50,last.p50)),{firstCycle:first,fourthCycle:last});
    }
  }
  if (mode === "endurance") {
    const start = schedule?.startedAtMs;
    const continuous = inputs.filter(row => planned.get(row.eventId).inputClass === "continuous");
    const publications = continuous.filter(row => finite(start) && row[paintedField] >= start + 301 * 60000 && row[paintedField] < start + 311 * 60000);
    const versions = new Set(publications.map(row => selectedViewClock?row.viewUsageVersion:row.usageVersion).filter(Boolean));
    check(reliability, `${id}/continuous-intermediate-publication`, verdict(Boolean(result), continuous.length === 120 && versions.size > 1),
      { planned: 120, landed: continuous.length, visibleDuringWindow: publications.length, versions: versions.size,
        eventIds: publications.map(row => row.eventId) });
    for (const kind of STABILITY_KINDS) {
      const ordinary = inputs.filter(row => row.kind === kind && row.category === "ordinary");
      const early = quantiles(ordinary.filter(row => row.landedAtMs >= start && row.landedAtMs < start + hour).map(row => row.landingToPaintMs));
      const late = quantiles(ordinary.filter(row => row.landedAtMs >= start + 7 * hour && row.landedAtMs < start + 8 * hour).map(row => row.landingToPaintMs));
      check(performance, `${id}/early-late/${kind}`, verdict(Boolean(early && late && result?.passed), early && late && protectionPassed(early.p50, late.p50)),
        { source: kind, firstHour: early, lastHour: late, rule: "late p50 > early p50 * 1.10 AND delta > 100ms fails" });
    }
  }
  return { label, mode, status: result?.passed ? "completed" : result ? "failed" : schedule ? "running-or-interrupted" : "not-executed",
    schedule, expectedSchedule: expected, result: result ? { ...result, inputs: undefined } : null, inputs, counts, ordinaryBySource: bySource, bursts,
    distributions: distributions(inputs) };
}

async function controls(directory, evidence) {
  const out = { counts: {}, queuePeak: 0, serialPeak: 0, queueEndDepths: {}, queueEndEvents: {}, serialEndDepths: {}, queueWaitMs: [],
    sources: [], projections: [], zcode: [], rounds: [], faults: [], processes: [], exits: [], errors: [], notifications: 0 };
  const queued = new Map();
  for (const entry of (await names(directory)).filter(row => /^events-\d+\.ndjson$/.test(row.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    await streamNdjson(path.join(directory, entry.name), row => {
      out.counts[row.event] = (out.counts[row.event] ?? 0) + 1;
      if (row.event.startsWith("request-") || row.event === "requests-rejected") {
        out.queuePeak = maximum(out.queuePeak, row.depth);
        out.queueEndDepths[row.instance] = row.event === "requests-rejected" ? 0 : row.depth;
        out.queueEndEvents[row.instance] = row;
      }
      if (row.event.startsWith("serial-")) {
        out.serialPeak = maximum(out.serialPeak, row.depth);
        out.serialEndDepths[row.instance] = row.depth;
        if (row.event === "serial-queued") queued.set(row.queueId, row.atMs);
        if (row.event === "serial-start" && queued.has(row.queueId)) out.queueWaitMs.push(row.atMs - queued.get(row.queueId));
        if (row.event === "serial-end") queued.delete(row.queueId);
      }
      if (row.event === "source-end") out.sources.push(row);
      if (row.event === "round-end") out.rounds.push(row);
      if (row.event === "projection") out.projections.push(row);
      if (row.event === "zcode-projection-delta") out.zcode.push(row);
      if (["fault-parked", "fault-timeout", "watch-hint-dropped", "executor-exit", "control-consumed"].includes(row.event)) out.faults.push(row);
      if (row.event === "process-born") out.processes.push(row);
      if (row.event === "process-exit") out.exits.push(row);
      if (row.event === "usage-notify") out.notifications++;
      if (row.error || ["control-error", "fault-timeout"].includes(row.event)) out.errors.push(row);
    }, evidence);
  }
  out.queueWaitMs = quantiles(out.queueWaitMs);
  return out;
}

function classification(row, phases) {
  const matches = phases.flatMap(phase => phase.inputs).filter(input => row.atMs >= input.landedAtMs &&
    row.atMs <= (input.paintedAtMs ?? Infinity));
  if (!matches.length) return "outside-input-window";
  const categories = [...new Set(matches.map(input => input.category))];
  return categories.length === 1 ? categories[0] : `overlap:${categories.sort().join("+")}`;
}

export function classifyInterruptedGatewayQueues(control, events, phases) {
  const interrupted = [];
  for (const [instance, depth] of Object.entries(control.queueEndDepths).filter(([, depth]) => depth > 0)) {
    const gateway = control.processes.find(row => row.instance === instance && row.role === "gateway");
    const lastQueue = control.queueEndEvents[instance];
    if (!gateway || lastQueue?.pid !== gateway.pid) continue;
    for (const phase of phases) for (const planned of phase.schedule?.events?.filter(row => row.type === "arm-gateway-exit") ?? []) {
      const park = control.faults.find(row => row.event === "fault-parked" && row.commandId === planned.id &&
        row.role === "executor" && row.ppid === gateway.pid && row.atMs >= gateway.atMs &&
        !control.processes.some(node => node.role === "gateway" && node.pid === gateway.pid && node.instance !== instance &&
          node.atMs > gateway.atMs && node.atMs <= row.atMs));
      const observed = park && events.faults.find(row => row.type === "fault-observed" && row.commandId === park.commandId &&
        row.instance === park.instance && row.pid === park.pid && row.ppid === gateway.pid);
      const restart = observed && events.faults.find(row => row.type === "gateway-restarted" && row.atMs > park.atMs);
      const replacement = restart && control.processes.find(row => row.role === "gateway" && row.pid === restart.pid &&
        row.instance !== instance && row.atMs > park.atMs && row.atMs <= restart.atMs);
      const recovered = restart && phase.inputs.find(row => row.category === "gateway-recovery" && row.landedAtMs <= park.atMs &&
        row.paintedAtMs >= restart.atMs && finite(row.landingToPaintMs) && row.landingToPaintMs <= 300000 && row.usageVersion);
      const timedOut = park && control.faults.some(row => row.event === "fault-timeout" && row.commandId === park.commandId);
      if (replacement && recovered && !timedOut && lastQueue.atMs <= park.atMs &&
        phase.result?.passed === true && phase.result.oracle?.passed === true && !phase.result.oracle.retry && !phase.result.oracle.skipped) {
        interrupted.push({ instance, pid: gateway.pid, depth, classification: "fault-interrupted", lastQueue, gateway, park, observed, restart, replacement,
          recovery: { eventId: recovered.eventId, source: recovered.kind, landedAtMs: recovered.landedAtMs,
            paintedAtMs: recovered.paintedAtMs, landingToPaintMs: recovered.landingToPaintMs, usageVersion: recovered.usageVersion } });
      }
    }
  }
  return interrupted;
}

function controlChecks(label, control, events, phases, reliability, interruptedInputs = []) {
  const inputs = [...phases.flatMap(phase => phase.inputs), ...interruptedInputs];
  const classifications = interruptedInputs.length ? [...phases, { inputs: interruptedInputs.map(row => ({ ...row, category: `interrupted-endurance:${row.category}` })) }] : phases;
  const sourceRows = control.sources.map(row => ({ ...row, category: classification(row, classifications),
    kind: ["main", "extra", "jetbrains"].includes(row.kind) ? "codex" : row.kind,
    // Reused prefix events are unchanged facts, not removals. Replacement hooks expose no source-count delta.
    netAdded: row.method === "reuseSourcePrefix" && row.committed && finite(row.insertedEvents) ? row.insertedEvents : null }));
  const zcode = control.zcode.map(row => ({ ...row, category: classification(row, classifications) }));
  const projections = control.projections.map(row => ({ ...row, category: classification(row, classifications) }));
  const ordinaryProjection = projections.filter(row => ["ordinary", "interrupted-endurance:ordinary"].includes(row.category));
  const projectionViolations = ordinaryProjection.filter(row => row.coldCopied > 0 || row.fullRebuild === true);
  check(reliability, `${label}/ordinary-projection-reuse`, verdict(ordinaryProjection.length > 0,
    !projectionViolations.length && ordinaryProjection.every(row => row.coldCopied === 0 && row.fullRebuild === false)), projectionViolations);
  const ordinaryZcode = inputs.filter(row => row.kind === "zcode" && row.category === "ordinary");
  const zcodeChecks = ordinaryZcode.map(input => {
    const rows = zcode.filter(row => row.sourcePath === input.filePath && row.atMs >= input.landedAtMs && row.atMs <= input.paintedAtMs);
    return { eventId: input.eventId, count: rows.length, netAdded: sum(rows.map(row => row.netAdded)), rows };
  });
  check(reliability, `${label}/ordinary-zcode-net-added`, verdict(zcodeChecks.length > 0 && zcodeChecks.every(row => row.count > 0),
    zcodeChecks.every(row => row.netAdded === 1)), zcodeChecks);
  for (const phase of phases) {
    const expectedFaults = phase.expectedSchedule.events.filter(row => row.type.startsWith("arm-"));
    for (const expected of expectedFaults) {
      const point = expected.type === "arm-after-commit" ? "after-commit-before-notify" : "before-commit";
      const park = control.faults.find(row => row.event === "fault-parked" && row.commandId === expected.id && row.point === point);
      const observed = events.faults.find(row => row.type === "fault-observed" && row.commandId === expected.id);
      const killed = park && events.faults.find(row => row.atMs >= park.atMs &&
        (expected.type === "arm-gateway-exit" ? row.type === "gateway-restarted" : row.type === "executor-killed" && row.pid === park.pid && row.point === point));
      const exit = park && control.faults.find(row => row.event === "executor-exit" && row.childPid === park.pid && row.atMs >= park.atMs);
      const timedOut = control.faults.some(row => row.event === "fault-timeout" && row.commandId === expected.id);
      check(reliability, `${label}/${expected.id}/real-fault`, verdict(Boolean(park || phase.result), Boolean(park && observed && killed && !timedOut &&
        (expected.type === "arm-gateway-exit" || exit))), { point, park: park ?? null, observed: observed ?? null, kill: killed ?? null, executorExit: exit ?? null, timedOut });
    }
    if (phase.mode === "endurance" && phase.schedule?.eventIdPrefix === "endurance-accepted") {
      const start = phase.schedule.startedAtMs, end = start + phase.expectedSchedule.durationMs;
      const activeAtStart = control.processes.filter(row => row.role === "gateway" && row.atMs <= start &&
        !control.exits.some(exit => exit.instance === row.instance && exit.atMs <= start));
      const bornDuring = control.processes.filter(row => row.role === "gateway" && row.atMs > start && row.atMs < end);
      const exitedDuring = control.exits.filter(row => row.role === "gateway" && row.atMs >= start && row.atMs < end);
      const restartedDuring = events.faults.filter(row => row.type === "gateway-restarted" && row.atMs >= start && row.atMs < end);
      const complete = phase.result?.passed === true && phase.result.startedAtMs === start && phase.result.observedDurationMs >= phase.expectedSchedule.durationMs;
      const violation = activeAtStart.length > 1 || bornDuring.length || exitedDuring.length || restartedDuring.length;
      check(reliability, `${label}/endurance/gateway-continuity`, violation ? "failed" : verdict(complete && activeAtStart.length === 1, true),
        { start, end, activeAtStart, bornDuring, exitedDuring, restartedDuring });
    }
  }
  const expectedFaultIds = phases.flatMap(phase => phase.expectedSchedule.events.filter(row => row.type.startsWith("arm-")).map(row => row.id));
  const parked = control.faults.filter(row => row.event === "fault-parked");
  check(reliability, `${label}/fault-cardinality`, verdict(phases.every(row => row.result), parked.length === expectedFaultIds.length &&
    expectedFaultIds.every(id => parked.filter(row => row.commandId === id).length === 1)), { expectedFaultIds, observedCommandIds: parked.map(row => row.commandId) });
  if (label === "current"&&!phases.some(row=>row.expectedSchedule.profile===CLOSEOUT_PROFILE)) check(reliability, `${label}/real-dropped-hint`, verdict(control.faults.length > 0,
    control.faults.some(row => row.event === "watch-hint-dropped")), control.faults.filter(row => row.event === "watch-hint-dropped"));
  const fatal = control.errors.filter(row => ["control-error", "fault-timeout"].includes(row.event));
  check(reliability, `${label}/hook-control`, verdict(Object.keys(control.counts).length > 0, !fatal.length), fatal);
  const first = events.firstAllResponse, last = events.lastAllResponse;
  const sourceProgress = STABILITY_KINDS.map(kind => ({ source: kind, firstCount: first?.counts?.[kind] ?? null,
    lastCount: last?.counts?.[kind] ?? null, expectedNetAdded: inputs.filter(row => row.kind === kind && row.operation === "append").length,
    observedNetAdded: finite(first?.counts?.[kind]) && finite(last?.counts?.[kind]) ? last.counts[kind] - first.counts[kind] : null }));
  check(reliability, `${label}/source-net-growth`, verdict(Boolean(events.closed && first && last), sourceProgress.every(row =>
    finite(row.observedNetAdded) && row.observedNetAdded === row.expectedNetAdded)), sourceProgress);
  const exitedInstances = new Set(control.exits.map(row => row.instance));
  const interruptedQueues = classifyInterruptedGatewayQueues(control, events, phases);
  const interruptedInstances = new Set(interruptedQueues.map(row => row.instance));
  const pending = Object.entries(control.queueEndDepths).filter(([instance, depth]) => depth > 0 && !interruptedInstances.has(instance));
  const serialPending = Object.entries(control.serialEndDepths).filter(([instance, depth]) => depth > 0 && !exitedInstances.has(instance) &&
    !control.faults.some(row => row.event === "fault-parked" && row.instance === instance));
  check(reliability, `${label}/queue-drained`, verdict(Boolean(events.closed), !pending.length && !serialPending.length), { pending, serialPending, interruptedQueues });
  const unexpectedExits = control.exits.filter(row => row.code !== 0);
  check(reliability, `${label}/normal-node-exits`, verdict(control.processes.length > 0, !unexpectedExits.length), unexpectedExits);
  const sourceGroups = new Map();
  for (const row of sourceRows) {
    const key = `${row.kind}/${row.category}`;
    if (!sourceGroups.has(key)) sourceGroups.set(key, []);
    sourceGroups.get(key).push(row);
  }
  return { counts: control.counts, queuePeak: control.queuePeak, serialPeak: control.serialPeak, queueWaitMs: control.queueWaitMs,
    queueEndDepths: control.queueEndDepths, queueEndEvents: control.queueEndEvents, serialEndDepths: control.serialEndDepths, interruptedQueues,
    notifications: control.notifications, errors: control.errors, faults: control.faults, sourceProgress,
    rounds: control.rounds.map(row => ({ atMs: row.atMs, syncId: row.syncId, category: classification(row, classifications),
      durationMs: row.durationMs, sourceWork: row.sourceWork, rollupWork: row.rollupWork, error: row.error })),
    sources: [...sourceGroups].map(([key, rows]) => ({ source: key.split("/")[0], category: key.split("/")[1], count: rows.length,
      durationMs: quantiles(rows.map(row => row.durationMs)), insertedEvents: sum(rows.map(row => row.insertedEvents ?? 0)),
      reusedEvents: sum(rows.map(row => row.reusedEvents ?? 0)), netAdded: rows.every(row => finite(row.netAdded)) ? sum(rows.map(row => row.netAdded)) : null,
      netAddedCoverage: "Only committed reuseSourcePrefix exposes inserted-event net growth; append/replace source hooks do not expose fact counts.",
      errors: rows.filter(row => row.error) })),
    projection: { samples: projections.length, ordinarySamples: ordinaryProjection.length, violations: projectionViolations,
      // Work snapshots repeat across prepare/applyDelta/publish; never sum their counters.
      coldCopiedMax: projections.reduce((n, row) => maximum(n, row.coldCopied), null),
      fullRebuildSamples: projections.filter(row => row.fullRebuild).length },
    zcode: { ordinaryChecks: zcodeChecks, deltas: zcode } };
}

function growth(hours, field, count=8) {
  const values = hours.map(row => row[field]?.p50 ?? null);
  const complete = values.length === count && values.every(finite);
  const accumulating = complete && values.at(-1) > values[0] && values.every((value, i) => i === 0 || value >= values[i - 1]);
  return { status: verdict(complete, !accumulating), hourlyMedians: values,
    delta: finite(values[0]) && finite(values.at(-1)) ? values.at(-1) - values[0] : null,
    criterion: `${count} comparable idle-window medians; monotonic net growth fails` };
}

async function resources(directory, entries, summaries, control, nodeExits, endurance, events, evidence, idleRows) {
  const idleTimes = new Set((idleRows ?? summaries.flatMap(row => row?.idle ?? [])).map(row => row.atMs));
  const out = { samples: 0, correctedSamples: 0, sampledPeakBytes: null, reportedPeakBytes: null, browserPeakBytes: null,
    idleSamples: 0, idlePeakBytes: null, missingMemorySamples: 0, missingIdentitySamples: 0, otherHighWaterPeakBytes: 0,
    idleMissingHandles: 0, idleMissingTemp: 0,
    statePeakBytes: null, walPeakBytes: null, tempPeakBytes: null, tempFilePeakCount: null,
    incompleteStorageSamples: 0, lastSamples: [], excludedIdentities: [], processes: [], observerCpuSeconds: 0,
    costCoverage: "sampled cumulative CPU and logical byte counters per PID + creation time; native exits and parked counters reported separately",
    storageCoverage: "directory-visible SQLite artifacts; unlinked/anonymous files and non-SQLite temp files are not observed" };
  const excluded = new Map(), processes = new Map(), observers = new Map();
  const nodeBirths = new Map();
  for (const row of control.processes) {
    if (!nodeBirths.has(row.pid)) nodeBirths.set(row.pid, []);
    nodeBirths.get(row.pid).push(row.startedAtMs);
  }
  const closeout=endurance?.expectedSchedule?.profile===CLOSEOUT_PROFILE;
  const idle = Array.from({ length: closeout?4:8 }, () => ({ bytes: [], handles: [], tempFiles: [], tempBytes: [],walBytes:[] }));
  const start = endurance?.schedule?.startedAtMs;
  for (const entry of entries.filter(row => row.isDirectory() && /^resources(?:-|$)/.test(row.name)).sort((a,b) => a.name.localeCompare(b.name))) {
    let last = null;
    await streamNdjson(path.join(directory, entry.name, "resources.ndjson"), raw => {
      if (!Array.isArray(raw.processes) || !finite(raw.atUnixMs)) throw Error("Malformed resource sample");
      const correction = correctResourceIdentity(raw), sample = correction.sample, service = sample.service;
      if (!service) throw Error("Missing service resource counters");
      out.samples++;
      if (correction.excluded.length) out.correctedSamples++;
      for (const row of correction.excluded) excluded.set(`${row.pid}|${row.startTimeUtc}`, row);
      const snapshotRows = resourceSnapshotRows(sample);
      const snapshotServiceRows = snapshotRows.filter(row => row.role === "service");
      out.sampledPeakBytes = maximum(out.sampledPeakBytes, Math.max(service.workingSetBytes ?? 0,
        sum(snapshotServiceRows.map(row => row.workingSetBytes ?? 0))));
      out.reportedPeakBytes = maximum(out.reportedPeakBytes, service.reportedPeakWorkingSetBytes);
      out.browserPeakBytes = maximum(out.browserPeakBytes, sample.browser?.workingSetBytes);
      if (!finite(service.workingSetBytes) || service.memoryAvailableProcessCount !== service.processCount) out.missingMemorySamples++;
      out.statePeakBytes = maximum(out.statePeakBytes, sample.state?.observedBytes);
      out.walPeakBytes = maximum(out.walPeakBytes, sample.sqlite?.categoryBytes?.wal ?? (sample.sqlite?.complete ? 0 : null));
      out.tempPeakBytes = maximum(out.tempPeakBytes, sample.temp?.observedBytes);
      out.tempFilePeakCount = maximum(out.tempFilePeakCount, sample.temp?.fileCount);
      if (!sample.state?.complete || !sample.temp?.complete) out.incompleteStorageSamples++;
      const serviceRows = sample.processes.filter(row => row.role === "service");
      const otherPeak = sum(snapshotServiceRows.filter(row => !(nodeBirths.get(row.pid) ?? []).some(startedAtMs =>
        Math.abs(startedAtMs - Date.parse(row.startTimeUtc)) < 1000)).map(row => row.reportedPeakWorkingSetBytes ?? 0));
      out.otherHighWaterPeakBytes = Math.max(out.otherHighWaterPeakBytes, otherPeak);
      for (const row of snapshotServiceRows) {
        if (!row.startTimeUtc || !row.pid) { out.missingIdentitySamples++; continue; }
        const key = `${row.pid}|${row.startTimeUtc}`;
        if (!processes.has(key)) processes.set(key, { pid: row.pid, startTimeUtc: row.startTimeUtc, firstAtMs: sample.atUnixMs,
          lastAtMs: sample.atUnixMs, peakBytes: null, cpuSeconds: null, logicalReadBytes: null, logicalWriteBytes: null });
        const item = processes.get(key);
        item.firstAtMs = Math.min(item.firstAtMs, sample.atUnixMs);
        item.lastAtMs = Math.max(item.lastAtMs, sample.atUnixMs);
        item.peakBytes = maximum(item.peakBytes, row.reportedPeakWorkingSetBytes);
        if (row.cpuAvailable) item.cpuSeconds = maximum(item.cpuSeconds, row.cpuSeconds);
        if (row.ioAvailable) {
          item.logicalReadBytes = maximum(item.logicalReadBytes, row.logicalReadBytes);
          item.logicalWriteBytes = maximum(item.logicalWriteBytes, row.logicalWriteBytes);
        }
      }
      for (const row of snapshotRows.filter(row => row.role === "observer")) {
        const key = `${row.pid}|${row.startTimeUtc}`;
        observers.set(key, maximum(observers.get(key), row.cpuSeconds));
      }
      if (idleTimes.has(sample.atUnixMs) && serviceRows.length) {
        out.idleSamples++;
        if (!serviceRows.every(row => finite(row.handleCount))) out.idleMissingHandles++;
        if (!sample.temp?.complete || !finite(sample.temp.fileCount) || !finite(sample.temp.observedBytes)) out.idleMissingTemp++;
        out.idlePeakBytes = maximum(out.idlePeakBytes, service.workingSetBytes);
        const elapsed=sample.atUnixMs-start;
        const index = closeout?endurance.expectedSchedule.cycles.findIndex(row=>elapsed>=row.idleFromMs&&elapsed<row.idleToMs):Math.floor(elapsed / hour);
        if (index >= 0 && index < idle.length) {
          const bucket = idle[index];
          if (finite(service.workingSetBytes)) bucket.bytes.push(service.workingSetBytes);
          if (serviceRows.every(row => finite(row.handleCount))) bucket.handles.push(sum(serviceRows.map(row => row.handleCount)));
          if (sample.temp?.complete && finite(sample.temp.fileCount)) bucket.tempFiles.push(sample.temp.fileCount);
          if (sample.temp?.complete && finite(sample.temp.observedBytes)) bucket.tempBytes.push(sample.temp.observedBytes);
          if(sample.sqlite?.complete&&finite(sample.sqlite.categoryBytes?.wal))bucket.walBytes.push(sample.sqlite.categoryBytes.wal);
        }
      }
      if (!last || sample.atUnixMs > last.atMs) last = { atMs: sample.atUnixMs, serviceProcessCount: service.processCount, sqlite: sample.sqlite, temp: sample.temp };
    }, evidence, parseResourceSample);
    if (last) out.lastSamples.push({ directory: entry.name, ...last });
  }
  out.excludedIdentities = [...excluded.values()];
  out.processes = [...processes.values()];
  out.observerCpuSeconds = sum([...observers.values()].filter(finite));
  out.sampledCpuSeconds = sum(out.processes.map(row => row.cpuSeconds ?? 0));
  out.sampledLogicalReadBytes = sum(out.processes.map(row => row.logicalReadBytes ?? 0));
  out.sampledLogicalWriteBytes = sum(out.processes.map(row => row.logicalWriteBytes ?? 0));
  out.counterMissingProcesses = out.processes.filter(row => !finite(row.cpuSeconds) || !finite(row.logicalReadBytes) || !finite(row.logicalWriteBytes));
  out.idleHours = idle.map((row, index) => ({ hour: index + 1, memory: quantiles(row.bytes), handles: quantiles(row.handles),
    tempFiles: quantiles(row.tempFiles), tempBytes: quantiles(row.tempBytes),...(closeout?{cycle:index+1,walBytes:quantiles(row.walBytes)}:{}) }));
  if(closeout)out.idleCycles=out.idleHours;
  out.handleGrowth = growth(out.idleHours, "handles",idle.length);
  out.tempFileGrowth = growth(out.idleHours, "tempFiles",idle.length);
  out.tempByteGrowth = growth(out.idleHours, "tempBytes",idle.length);
  if(closeout)out.walGrowth=growth(out.idleHours,"walBytes",4);
  if (out.idleMissingHandles && out.handleGrowth.status !== "failed") out.handleGrowth.status = "incomplete";
  if (out.idleMissingTemp) {
    if (out.tempFileGrowth.status !== "failed") out.tempFileGrowth.status = "incomplete";
    if (out.tempByteGrowth.status !== "failed") out.tempByteGrowth.status = "incomplete";
  }
  const born = control.processes;
  out.nodeExits = nodeExits;
  out.nativeExits = control.exits;
  out.nativeExitCpuSeconds = sum(control.exits.map(row => ((row.usage?.userCPUTime ?? 0) + (row.usage?.systemCPUTime ?? 0)) / 1000000));
  const sampledFor = node => {
    const candidates = out.processes.filter(row => row.pid === node.pid && Math.abs(Date.parse(row.startTimeUtc) - node.startedAtMs) < 1000)
      .sort((a, b) => Math.abs(Date.parse(a.startTimeUtc) - node.startedAtMs) - Math.abs(Date.parse(b.startTimeUtc) - node.startedAtMs));
    return candidates.slice(0, 1);
  };
  const gatewayKills = born.filter(row => row.role === "gateway").flatMap(node => {
    const park = control.faults.find(row => row.event === "fault-parked" && row.ppid === node.pid && row.atMs >= node.atMs);
    const restart = park && events.faults.find(row => row.type === "gateway-restarted" && row.atMs > park.atMs);
    return restart ? [{ node, park, restart }] : [];
  });
  const killBound = "SIGKILL has no JS exit high-water/counter record. Parked and native samples are observed lower bounds; the final sampling gap has no measured upper bound.";
  out.killed = control.faults.filter(row => row.event === "fault-parked").map(park => {
    const samples = sampledFor(park);
    return { kind: "parked-executor", commandId: park.commandId, pid: park.pid, point: park.point, park, samples,
      jsExitObserved: control.exits.some(row => row.instance === park.instance),
      bound: killBound };
  });
  for (const killed of gatewayKills) out.killed.push({ kind: "gateway-tree", pid: killed.node.pid, instance: killed.node.instance,
    commandId: killed.park.commandId, triggerPark: killed.park, samples: sampledFor(killed.node), jsExitObserved: false, bound: killBound });
  out.identityCorrelation = "Sampler ownership uses exact PID + creation time. JS uptime-based start times are correlated to the nearest native generation within 1s; original native identities are retained.";
  const intervals = [];
  for (const process of born) {
    const exit = control.exits.find(row => row.instance === process.instance);
    const native = nodeExits.find(row => row.pid === process.pid && Math.abs(row.startedAtMs - process.startedAtMs) < 1000);
    const park = control.faults.find(row => row.event === "fault-parked" && row.instance === process.instance);
    const observedExit = control.faults.find(row => row.event === "executor-exit" && row.childPid === process.pid && row.atMs >= process.atMs);
    const gatewayKill = gatewayKills.find(row => row.node.instance === process.instance);
    const sampledPeak = sampledFor(process).reduce((n, row) => maximum(n, row.peakBytes), 0);
    const peak = Math.max(Math.max(exit?.usage?.maxRSS ?? 0, native?.usage?.maxRSS ?? 0, park?.usage?.maxRSS ?? 0) * 1024, sampledPeak);
    if (peak) intervals.push({ start: process.startedAtMs, end: exit?.atMs ?? native?.endedAtMs ?? observedExit?.atMs ?? gatewayKill?.restart.atMs ?? Infinity, bytes: peak });
  }
  const edges = intervals.flatMap(row => [{ atMs: row.start, delta: row.bytes }, { atMs: row.end, delta: -row.bytes }]).sort((a,b) => a.atMs-b.atMs || a.delta-b.delta);
  let concurrent = 0;
  out.nodeHighWaterEnvelopeBytes = 0;
  for (const edge of edges) { concurrent += edge.delta; out.nodeHighWaterEnvelopeBytes = Math.max(out.nodeHighWaterEnvelopeBytes, concurrent); }
  out.envelopeBytes = Math.max(out.sampledPeakBytes ?? 0, out.reportedPeakBytes ?? 0, out.nodeHighWaterEnvelopeBytes + out.otherHighWaterPeakBytes);
  out.nodeExitCoverage = born.map(row => ({ pid: row.pid, instance: row.instance,
    normalExit: control.exits.some(exit => exit.instance === row.instance),
    parked: control.faults.some(fault => fault.event === "fault-parked" && fault.instance === row.instance),
    controlledGatewayKill: gatewayKills.some(killed => killed.node.instance === row.instance) }));
  return out;
}

function resourceChecks(label, data, summaries, phases, closed, group) {
  check(group, `${label}/active-memory`, data.envelopeBytes > 512 * MiB ? "failed" : verdict(data.samples > 0 && !data.missingMemorySamples && !data.missingIdentitySamples,
    true), { limitBytes: 512 * MiB, sampledPeakBytes: data.sampledPeakBytes,
    reportedPeakBytes: data.reportedPeakBytes, nodeHighWaterEnvelopeBytes: data.nodeHighWaterEnvelopeBytes,
    otherHighWaterPeakBytes: data.otherHighWaterPeakBytes, envelopeBytes: data.envelopeBytes,
    killed: data.killed.map(row => ({ pid: row.pid, bound: row.bound })) });
  check(group, `${label}/idle-memory`, data.idlePeakBytes > 256 * MiB ? "failed" : verdict(data.idleSamples > 0 && summaries.length > 0,
    true), { peakBytes: data.idlePeakBytes, limitBytes: 256 * MiB, samples: data.idleSamples,
    criterion: "runner-certified idle timestamps (no pending actions/inputs, >=60s since last activity), recomputed from corrected raw samples" });
  const missingExits = data.nodeExitCoverage.filter(row => !row.normalExit && !row.parked && !row.controlledGatewayKill);
  check(group, `${label}/exit-resource-coverage`, verdict(data.nodeExitCoverage.length > 0 && Boolean(closed), !missingExits.length),
    { missingExits, killedUpperBoundMeasured: data.killed.length === 0 });
  check(group, `${label}/fault-resource-coverage`, verdict(Boolean(closed), data.killed.every(row => row.samples.length > 0 &&
    (row.kind === "gateway-tree" || finite(row.park?.usage?.maxRSS)))),
    data.killed.map(row => ({ pid: row.pid, kind: row.kind, sampledIdentities: row.samples.length, parkMaxRssKiB: row.park?.usage?.maxRSS ?? null,
      jsExitObserved: row.jsExitObserved, bound: row.bound })));
  check(group, `${label}/cpu-io-storage-cost`, verdict(data.samples > 0 && !data.counterMissingProcesses.length && !data.incompleteStorageSamples,
    true), { sampledCpuSeconds: data.sampledCpuSeconds, sampledLogicalReadBytes: data.sampledLogicalReadBytes,
    sampledLogicalWriteBytes: data.sampledLogicalWriteBytes, observerCpuSeconds: data.observerCpuSeconds,
    storageCoverage: data.storageCoverage, incompleteStorageSamples: data.incompleteStorageSamples });
  const finalSample = data.lastSamples.find(row => row.directory === "resources-final-reopen");
  const walKnown = finalSample?.serviceProcessCount === 0 && finalSample.sqlite?.complete === true;
  check(group, `${label}/normal-close-primary-wal`, verdict(Boolean(closed) && walKnown,
    (finalSample?.sqlite?.categoryBytes?.wal ?? 0) === 0), { finalSample: finalSample ?? null });
  const projection = closed?.projection;
  check(group, `${label}/normal-close-projection`, verdict(Boolean(projection) && Array.isArray(projection?.orphanDatabases) && finite(projection?.walBytes),
    projection?.walBytes === 0 && projection?.candidate === null && projection?.orphanDatabases?.length === 0), projection ?? null);
  if (phases.some(row => row.mode === "endurance")) {
    const first = data.idleHours[0].memory, last = data.idleHours[7].memory;
    check(group, `${label}/idle-memory-growth`, verdict(Boolean(first && last), first && last && last.p50 <= first.p50 + 32 * MiB),
      { firstHour: first, lastHour: last, allowanceBytes: 32 * MiB });
    check(group, `${label}/idle-handle-growth`, data.handleGrowth.status, data.handleGrowth);
    check(group, `${label}/idle-temp-file-growth`, data.tempFileGrowth.status, data.tempFileGrowth);
    check(group, `${label}/idle-temp-byte-growth`, data.tempByteGrowth.status, data.tempByteGrowth);
  }
  if(phases.some(row=>row.mode==="closeout-soak")){
    const first=data.idleCycles?.[0]?.memory,last=data.idleCycles?.[3]?.memory;
    check(group,`${label}/four-cycle-idle-memory-growth`,verdict(Boolean(first&&last),first&&last&&last.p50<=first.p50+32*MiB),{firstCycle:first,fourthCycle:last,allowanceBytes:32*MiB});
    for(const [name,value] of [["handles",data.handleGrowth],["temp-files",data.tempFileGrowth],["temp-bytes",data.tempByteGrowth],["wal",data.walGrowth]])check(group,`${label}/four-cycle-${name}`,value?.status??"incomplete",value);
  }
}

function references(reference, contexts, performance) {
  const groups = (reference?.groups ?? []).filter(row => row.variant === "candidate");
  const scores = groups.map(group => ({ label: group.label, layout: group.layout, passed: group.passed,
    comparisonStatus: group.layout === "mixed" ? "same-layout-historical-reference" : "not-comparable",
    currentRunLayout: "mixed", layoutExecutedThisRun: group.layout === "mixed",
    latencies: group.latencies ?? [], changes: group.scene?.changes?.map(row => ({ name: row.name, source: row.kind, actualMs: row.actualPaintMs })) ?? [],
    reopenMs: group.scene?.reopen?.wallMs ?? null }));
  for (const label of ["current", "year"]) {
    const context = contexts.find(row => row.label === label);
    for (const group of scores.filter(row => row.label === label && row.layout === "mixed")) {
      for (const referenceRow of group.changes) {
        const candidates = context.phases[0].inputs.filter(row => row.kind === referenceRow.source &&
          (referenceRow.name.startsWith("revision-") ? row.operation === "revision" : row.category === "ordinary" && row.operation === "append"));
        if (referenceRow.name.startsWith("revision-") && !candidates.length) continue;
        const observed = quantiles(candidates.map(row => row.landingToPaintMs));
        check(performance, `prior-protection/${label}/${group.layout}/${referenceRow.name}`, verdict(Boolean(observed) && finite(referenceRow.actualMs),
          observed && protectionPassed(referenceRow.actualMs, observed.p50)), { beforeMs: referenceRow.actualMs, current: observed,
            samples: candidates.map(row => ({ eventId: row.eventId, actualMs: row.landingToPaintMs, context: row.scheduleContext })),
            comparison: "previous-card candidate layout; protection reference only, not a same-round control", layoutMatches: group.layout === "mixed" });
      }
      check(performance, `prior-protection/${label}/${group.layout}/reopen`, verdict(finite(context.reopen?.wallMs) && finite(group.reopenMs),
        finite(context.reopen?.wallMs) && protectionPassed(group.reopenMs, context.reopen.wallMs)),
      { beforeMs: group.reopenMs, actualMs: context.reopen?.wallMs ?? null, comparison: "previous-card protection reference only", layoutMatches: group.layout === "mixed" });
      for (const previous of group.latencies.filter(row => row.name.startsWith("scope-"))) {
        const current = quantiles(context.events.scopes.filter(row => row.preset === previous.name.slice(6)).map(row => row.wallMs));
        check(performance, `prior-protection/${label}/${group.layout}/${previous.name}`,
          current && finite(previous.candidateMs) ? verdict(true, protectionPassed(previous.candidateMs, current.p50)) : "not-executed",
          { beforeMs: previous.candidateMs, current, comparison: "historical scope protection; tabs and background work may differ", layoutMatches: group.layout === "mixed" });
      }
    }
    if (!scores.some(row => row.label === label && row.layout === "mixed")) check(performance, `prior-protection/${label}`, "incomplete", "Missing previous-card mixed candidate scores; hot is not comparable");
  }
  return { comparison: "historical protection references, not a same-round control; mixed layout matches this run", scores,
    retainedFailures: scores.filter(group => group.layout === "mixed").flatMap(group => group.latencies.filter(row => row.passed === false).map(row => ({ label: group.label, layout: group.layout, ...row }))) };
}

export async function analyzeWindowsStability(root = defaultRoot, { referenceFile = defaultReference, upgradeFile = defaultUpgrade } = {}) {
  root = path.resolve(root);
  const evidence = [], reliability = gates(), resource = gates(), performance = gates();
  const run = await json(path.join(root, "result.json"), evidence);
  const records = new Map();
  for (const record of [...(Array.isArray(run?.continuations) ? run.continuations : []), run?.continuation].filter(Boolean)) {
    if (!records.has(record.original)) records.set(record.original, record);
  }
  const continuationAudits = [];
  for (const record of records.values()) {
    const paint = typeof record.original === "string" && record.original.endsWith("result-paint-interruption.json");
    const sessions = typeof record.original === "string" && record.original.endsWith("result-sessions-interruption.json");
    const audit = sessions ? await readSessionContinuationAudit(root, run, record, evidence)
      : paint ? await readPaintContinuationAudit(root, run, record, evidence) : await readContinuationAudit(root, run, evidence, record);
    continuationAudits.push(audit);
    check(reliability, sessions ? "continuation-audit/sessions" : paint ? "continuation-audit/paint" : "continuation-audit", audit.status, audit);
  }
  const continuationAudit = continuationAudits.find(row => row.scope === "year") ?? null;
  const paintAudit = continuationAudits.find(row => row.type === "paint-order");
  const sessionAudit = continuationAudits.find(row => row.type === "session-selection");
  if (run?.interruptedEndurance) check(reliability, "interrupted-endurance-audit", sessionAudit?.status ?? "incomplete", sessionAudit ?? run.interruptedEndurance);
  const contexts = [];
  for (const label of ["current", "year", "two-years"]) {
    const directory = path.join(root, "diagnostic", label), entries = await names(directory);
    const events = { counts: {}, faults: [], oracles: [], normalCloses: [], locks: [], scopes: [], errors: [], sse: [], recoveryVisibleEchoes: [] };
    const ledger = new Map(), landedIds = new Set(), visibleIds = new Set(), duplicateInputs = [], conflicts = [];
    const firstLandings = new Map(), correction = label === "two-years" ? paintAudit?.twoYears.correction.result : null;
    const recoveryIds = new Set([...(Array.isArray(correction?.corrected) ? correction.corrected.map(row => row.eventId) : []),
      ...(Array.isArray(correction?.interrupted) ? correction.interrupted : [])]);
    await streamNdjson(path.join(directory, "events.ndjson"), (row, source) => {
      events.counts[row.type] = (events.counts[row.type] ?? 0) + 1;
      if (["input-landed", "input-visible"].includes(row.type)) {
        const echo = row.type === "input-landed" && recoveryIds.has(row.eventId) && landedIds.has(row.eventId) &&
          finite(row.paintedAtMs) && typeof row.usageVersion === "string" && row.usageVersion.length > 0 &&
          Number.isSafeInteger(row.responseSequence) && row.responseSequence > 0;
        if (echo) events.recoveryVisibleEchoes.push({ classification: "recovery-visible-echo", source, originalRow: row,
          explanation: "Recovered input retained its original type/atMs; log details overwrote input-visible. This is a visibility receipt, not another source mutation." });
        if (row.type === "input-landed" && !echo) {
          if (landedIds.has(row.eventId)) duplicateInputs.push(row.eventId);
          landedIds.add(row.eventId);
          if (!firstLandings.has(row.eventId)) firstLandings.set(row.eventId, row);
        }
        if (row.type === "input-visible" || echo) visibleIds.add(row.eventId);
        mergeInput(ledger, row, conflicts);
      }
      if (["fault-observed", "executor-killed", "gateway-restarted"].includes(row.type)) events.faults.push(row);
      if (row.type === "oracle") events.oracles.push({ atMs: row.atMs, name: row.name, attempt: row.attempt,
        passed: row.result?.passed, retry: row.result?.retry, checks: row.result?.checks });
      if (row.type === "normal-close") events.normalCloses.push(row);
      if (row.type === "scope") events.scopes.push(row);
      if (row.type === "browser" && row.kind === "page-receipt" && ["error", "open"].includes(row.event)) events.sse.push(row);
      if (row.type === "response" && row.preset === "all") {
        const progress = { atMs: row.atMs, counts: row.counts, usageVersion: row.usageVersion };
        if (!events.firstAllResponse || row.atMs < events.firstAllResponse.atMs) events.firstAllResponse = progress;
        if (!events.lastAllResponse || row.atMs > events.lastAllResponse.atMs) events.lastAllResponse = progress;
      }
      if (row.type === "write-lock") events.locks.push(row);
      if (row.type === "http-error" || row.error) events.errors.push(row);
    }, evidence);
    const loaded = [];
    for (const mode of label === "two-years" ? ["diagnostic", "endurance"] : ["diagnostic"]) {
      const schedule = await json(path.join(directory, `schedule-${mode}.json`), evidence);
      const result = await json(path.join(directory, `result-${mode}.json`), evidence);
      for (const row of result?.inputs ?? []) mergeInput(ledger, row, conflicts);
      loaded.push({ mode, schedule, result });
    }
    const interrupted = label === "two-years" ? sessionAudit?.interruptedEndurance.inputs ?? [] : [];
    for (const row of interrupted) mergeInput(ledger, row, conflicts);
    if (label === "two-years" && (paintAudit || sessionAudit)) {
      const mutations = [], mutationFile = path.join(directory, "mutations/mutations.ndjson");
      await streamNdjson(mutationFile, row => mutations.push(row), evidence);
      const key = row => `${row.operation}/${row.kind}/${row.ordinal}`;
      const byMutation = new Map(mutations.map(row => [key(row), row]));
      const byLanding = new Map([...firstLandings.values()].map(row => [key(row), row]));
      const mismatches = [...firstLandings.values()].filter(row => {
        const mutation = byMutation.get(key(row));
        return !mutation || ["id", "identity", "filePath", "landedAtMs", "category", "expectedDelta", "expectedEventDelta", "outputDelta"]
          .some(field => mutation[field] !== row[field]);
      }).map(row => row.eventId);
      const mutationAgreement = { file: mutationFile, mutationCount: mutations.length, firstLandingCount: firstLandings.size,
        duplicateMutationKeys: mutations.length - byMutation.size, duplicateLandingKeys: firstLandings.size - byLanding.size,
        missingLandingKeys: [...byMutation.keys()].filter(value => !byLanding.has(value)), mismatches,
        firstLandings: [...firstLandings.values()] };
      check(reliability, `${label}/mutation-ledger-agreement`, verdict(mutations.length > 0, mutations.length === firstLandings.size &&
        mutations.length === byMutation.size && firstLandings.size === byLanding.size && !mismatches.length && !mutationAgreement.missingLandingKeys.length), mutationAgreement);
      if (paintAudit) paintAudit.twoYears.mutationAgreement = mutationAgreement;
      if (sessionAudit) sessionAudit.twoYears.mutationAgreement = mutationAgreement;
    }
    if (label === "two-years" && paintAudit) {
      const corrected = Array.isArray(correction?.corrected) ? correction.corrected : [], interrupted = Array.isArray(correction?.interrupted) ? correction.interrupted : [];
      const reconciliation = { correctedMismatches: corrected.filter(expected => {
        const actual = ledger.get(expected.eventId);
        return !actual || ["kind", "category", "ordinal", "landedAtMs", "paintedAtMs", "landingToPaintMs", "usageVersion", "responseSequence"].some(field => actual[field] !== expected[field]);
      }).map(row => row.eventId), missingTimingMarkers: interrupted.filter(id => !ledger.get(id)?.timingInterruption),
      missingFirstLandings: interrupted.filter(id => !firstLandings.has(id)),
      interruptedNotInOriginalPhase: interrupted.filter(id => !paintAudit.twoYears.originalPhase.result?.inputs?.some(row => row.eventId === id)),
      timingInterruptedInputs: interrupted.map(id => ledger.get(id) ?? { eventId: id }) };
      const visible = [...corrected.map(row => row.eventId), ...interrupted].every(id => finite(ledger.get(id)?.paintedAtMs));
      check(reliability, `${label}/paint-input-reconciliation`, verdict(visible, !reconciliation.correctedMismatches.length && !reconciliation.missingTimingMarkers.length && !reconciliation.missingFirstLandings.length), reconciliation);
      paintAudit.twoYears.inputReconciliation = reconciliation;
    }
    check(reliability, `${label}/duplicate-inputs`, verdict(landedIds.size > 0, !duplicateInputs.length), duplicateInputs);
    check(reliability, `${label}/input-record-agreement`, verdict(ledger.size > 0, !conflicts.length), conflicts);
    const missingRaw = [...ledger.keys()].filter(id => !landedIds.has(id) || !visibleIds.has(id));
    check(reliability, `${label}/raw-input-evidence`, verdict(loaded.every(row => row.result), !missingRaw.length), missingRaw);
    const expectedIds = new Set([...loaded.flatMap(row => canonicalSchedule(row.mode, label, row.schedule?.eventIdPrefix).events.map(event => event.id)), ...interrupted.map(row => row.eventId)]);
    const unexpected = [...ledger.keys()].filter(id => !expectedIds.has(id));
    check(reliability, `${label}/unexpected-inputs`, verdict(ledger.size > 0, !unexpected.length), unexpected);
    const phases = loaded.map(row => phaseAnalysis(label, row.mode, row.schedule, row.result, ledger, events, reliability, performance, label === "two-years" && Boolean(run?.interruptedEndurance)));
    const interruptedReport = label === "two-years" && sessionAudit ? { ...sessionAudit.interruptedEndurance,
      inputs: interrupted.map(row => ledger.get(row.eventId) ?? row),
      distributions: distributions(interrupted.map(row => ledger.get(row.eventId) ?? row)) } : null;
    const sse = label === "current" ? sseRecovery(events, phases, reliability) : null;
    const reopen = await json(path.join(directory, "final-reopen.json"), evidence);
    const closed = await json(path.join(directory, "closed.json"), evidence);
    events.closed = closed;
    check(reliability, `${label}/normal-close`, closed ? verdict(true, closed.failed === false && closed.rawRestored === true && !closed.errors?.length) : "not-executed", closed);
    check(reliability, `${label}/reopen-exact`, verdict(Boolean(reopen), finite(reopen?.wallMs) &&
      events.oracles.some(row => row.name === "reopen" && row.passed === true && !row.retry)), { reopen, oracles: events.oracles.filter(row => row.name === "reopen") });
    if (label === "two-years") check(performance, `${label}/reopen`, verdict(finite(reopen?.wallMs), reopen?.wallMs <= 45000),
      { actualMs: reopen?.wallMs ?? null, limitMs: 45000 });
    const control = await controls(path.join(directory, "control"), evidence);
    const controlSummary = controlChecks(label, control, events, phases, reliability, interruptedReport?.inputs ?? []);
    const nodeExits = [];
    for (const entry of (await names(path.join(directory, "nodes"))).filter(row => /^node-\d+\.jsonl$/.test(row.name))) {
      await streamNdjson(path.join(directory, "nodes", entry.name), row => nodeExits.push(row), evidence);
    }
    const summaries = [];
    for (const entry of entries.filter(row => /^resource-summary(?:-.*)?\.json$/.test(row.name))) {
      const value = await json(path.join(directory, entry.name), evidence);
      if (value) summaries.push(value);
    }
    const idleRows = label === "year" && continuationAudit?.status === "passed" ? continuationIdleRows(continuationAudit, summaries) : undefined;
    if (label === "year" && continuationAudit) {
      continuationAudit.year.currentClosed = closed;
      continuationAudit.year.reopen = reopen;
      check(resource, "year/idle-correction-audit", continuationAudit.status, continuationAudit.year);
    }
    if (label === "two-years" && paintAudit) {
      paintAudit.twoYears.currentClosed = closed;
      paintAudit.twoYears.reopen = reopen;
      check(resource, "two-years/paint-correction-audit", paintAudit.status, paintAudit.twoYears);
    }
    if (label === "two-years" && sessionAudit) {
      sessionAudit.twoYears.currentClosed = closed;
      sessionAudit.twoYears.reopen = reopen;
      check(resource, "two-years/session-selection-audit", sessionAudit.status, sessionAudit.twoYears);
    }
    const resourceSummary = await resources(directory, entries, summaries, control, nodeExits, phases.find(row => row.mode === "endurance"), events, evidence, idleRows);
    resourceSummary.longestInjectedWriteLockMs = events.locks.reduce((n, row) => maximum(n, row.durationMs), null);
    resourceSummary.writeLockEvidence = { scope: "controlled external write-lock injection only",
      productTransactionsDirectlyTracked: false, longestProductWriteLockMs: null,
      capturedSyncRoundMs: quantiles(control.rounds.map(row => row.durationMs)),
      limitation: "The injected lock is not the product's longest transaction. Completed sync-round spans bound only transactions wholly contained in those captured rounds; interrupted or untraced transactions have no measured upper bound." };
    if (label === "year") check(resource, "year/write-lock-cost", verdict(events.locks.length > 0,
      events.locks.every(row => finite(row.durationMs) && row.durationMs >= 3000)), { ...resourceSummary.writeLockEvidence, locks: events.locks });
    resourceChecks(label, resourceSummary, summaries, phases, closed, resource);
    contexts.push({ label, directory, phases, interruptedEndurance: interruptedReport, reopen, closed, events, sse, control: controlSummary, resources: resourceSummary,
      runnerResourceSummaries: summaries.map(row => ({ ...row, idle: undefined, excluded: undefined,
        idleCount: row.idle?.length ?? 0, excludedCount: row.excluded?.length ?? 0 })) });
  }
  const upgrade = await json(upgradeFile, evidence);
  check(reliability, "two-years/upgrade", verdict(Boolean(upgrade), upgrade?.passed === true && upgrade?.candidate?.passed === true &&
    upgrade?.maintenance?.result?.projection?.coldCopied === 0 && upgrade?.maintenance?.result?.projection?.rebuilt === false),
    { file: upgradeFile, passed: upgrade?.passed, projection: upgrade?.maintenance?.result?.projection });
  check(resource, "two-years/upgrade-maintenance-memory", verdict(finite(upgrade?.maintenance?.observed?.peakBytes),
    upgrade?.maintenance?.observed?.peakBytes <= 512 * MiB), upgrade?.maintenance?.observed ?? null);
  for (const row of upgrade?.latencies ?? []) check(performance, `upgrade-protection/${row.name}`,
    verdict(finite(row.baselineMs) && finite(row.candidateMs), finite(row.baselineMs) && finite(row.candidateMs) && protectionPassed(row.baselineMs, row.candidateMs)), row);
  check(performance, "two-years/upgrade-reopen-absolute", verdict(finite(upgrade?.candidate?.reopen?.wallMs), upgrade?.candidate?.reopen?.wallMs <= 45000),
    { actualMs: upgrade?.candidate?.reopen?.wallMs ?? null, limitMs: 45000, comparison: "absolute reopen target; upgrade R result remains separate" });
  const reference = references(await json(referenceFile, evidence), contexts, performance);
  for (const row of reference.retainedFailures) check(performance, `retained-prior-shortfall/${row.label}/${row.layout}/${row.name}`, "failed",
    { ...row, comparison: "prior-card shortfall retained separately from this run; not a new same-round measurement" });
  check(reliability, "run-completed", run ? verdict(true, run.passed === true && !run.failure && !run.cleanupError) : "not-executed",
    { startedAtMs: run?.startedAtMs ?? null, endedAtMs: run?.endedAtMs ?? null, failure: run?.failure ?? null, cleanupError: run?.cleanupError ?? null });
  check(reliability, "evidence-readable", verdict(evidence.length === 0, true), evidence);
  finish(reliability); finish(resource); finish(performance);
  const notExecuted = contexts.flatMap(row => row.phases.filter(phase => phase.status === "not-executed").map(phase => `${row.label}/${phase.mode}`));
  return { version: 1, kind: "windows-stability-analysis", root, analyzedAt: new Date().toISOString(),
    passed: reliability.passed && resource.passed && performance.passed && reference.retainedFailures.length === 0,
    reliability, resource, performance: { ...performance, notExecuted, retainedHistoricalFailures: reference.retainedFailures },
    contexts, continuationAudit, continuationAudits, reference: { file: referenceFile, ...reference }, upgrade: { file: upgradeFile, result: upgrade }, evidence,
    scope: "Formal-v2 only. Preparation attempts remain separate. Historical scores are protection references. No source hashing, live control, or timed-tool mutation. Previous accepted deviations do not accept any new regression." };
}

export { phaseAnalysis, controls, controlChecks, resources, resourceChecks, gates, check, finish, mergeInput };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [root, output, referenceFile, upgradeFile] = process.argv.slice(2);
  const result = await analyzeWindowsStability(root, { referenceFile, upgradeFile });
  if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  else console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
}
