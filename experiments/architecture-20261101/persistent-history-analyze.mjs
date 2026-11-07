import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { BASE, KINDS, read, save } from "./c1-datasets.mjs";
import { hashFile } from "./remaining-harness-delivery-prepare.mjs";
import { CONDITIONS, RESULT_ROOT, fingerprint, verifyEntries, verifyFrozenRuntime, assertMatrix, REPLAY_PHASES, replayMutationTimes } from "./persistent-history-prepare.mjs";

export const CASES = ["default", "initial-all", "today", "week", "custom", "back-all",
  ...KINDS.map(kind => `append-${kind}`), "revision-zcode", "reopen-all"];
export const VALIDATION_CHECKS = ["semantic-exact", "zcode-one-row", "recovery-main-committed",
  "recovery-projection-interrupted", "recovery-before-notify", "recovery-input-changed"];

export function storageCoverage(samples) {
  const scopes = samples.flatMap(row => [row.state, row.temp]);
  const inventory = scope => scope && Array.isArray(scope.files) && scope.files.every(file =>
    typeof file.relativePath === "string" && Number.isFinite(file.bytes) && file.bytes >= 0) &&
    scope.observedBytes === scope.files.reduce((sum, file) => sum + file.bytes, 0) &&
    (scope.complete || scope.warnings?.length > 0 && scope.warnings.every(warning => /^allocation: .+: unavailable$/.test(warning)));
  return { inventoryComplete: samples.length > 0 && scopes.every(inventory),
    allocationComplete: samples.length > 0 && scopes.every(scope => scope.complete && Number.isFinite(scope.allocatedBytes)),
    allocationUnavailableScopes: scopes.filter(scope => !Number.isFinite(scope?.allocatedBytes)).length };
}

export function assertSameMeasurementTools(before, after) {
  const analysisOnly = new Set(["persistent-history-analyze.mjs", "persistent-history-tools.test.mjs"]);
  const measured = tools => tools.filter(row => !analysisOnly.has(path.basename(row.file)));
  assert.deepEqual(measured(before), measured(after), "measurement tools changed; a new scene is required");
}

export function assertUnchangedCurrentReplayHook(before, after) {
  const start = '    if (url.endsWith("/src/server.js") && process.env.C1_BUSINESS_CLOCK_FILE) {';
  const end = '    if (url.endsWith("/src/history-backup.js")) {';
  const activeCurrentCode = source => {
    assert.equal(source.split(start).length, 2, "missing unique historical-only hook");
    assert.equal(source.split(end).length, 2, "missing unique next hook");
    const begin = source.indexOf(start), finish = source.indexOf(end);
    assert.ok(finish > begin);
    return source.slice(0, begin) + source.slice(finish);
  };
  assert.equal(activeCurrentCode(before), activeCurrentCode(after), "current measurement code changed");
}

async function lines(file, visit) {
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) if (line.trim()) visit(JSON.parse(line));
}
export function regressionPassed(baselineMs, candidateMs) {
  assert.ok([baselineMs, candidateMs].every(value => Number.isFinite(value) && value >= 0), "missing latency");
  return !(candidateMs > baselineMs * 1.1 && candidateMs - baselineMs > 100);
}
export function memoryGate(samples, nodes, gateways) {
  const active = samples.filter(row => row.service.processCount > 0);
  const sampledPeakBytes = Math.max(0, ...active.map(row => row.service.workingSetBytes || 0));
  const reportedPeakBytes = Math.max(0, ...active.map(row => row.service.reportedPeakWorkingSetBytes || 0));
  const otherPeakBytes = Math.max(0, ...samples.map(row => row.processes.filter(item => item.role === "service" && item.name.toLowerCase() !== "node.exe")
    .reduce((sum, item) => sum + (item.reportedPeakWorkingSetBytes || 0), 0)));
  // Same complete-lifecycle envelope as C1, including processes missed between 250 ms samples.
  const nodePeakEnvelopeBytes = Math.max(0, ...nodes.map(point => nodes.filter(row => row.startedAtMs <= point.startedAtMs && row.endedAtMs >= point.startedAtMs)
    .reduce((sum, row) => sum + row.usage.maxRSS * 1024, 0)));
  const lastArg = (row, name) => row.execArgv.filter(arg => arg.startsWith(name + "=")).at(-1)?.split("=")[1];
  const complete = active.length > 0 && active.every(row => row.service.memoryAvailableProcessCount === row.service.processCount &&
    Number.isFinite(row.service.workingSetBytes) && Number.isFinite(row.service.reportedPeakWorkingSetBytes)) && gateways > 0 &&
    nodes.filter(row => row.role === "gateway").length === gateways && nodes.some(row => row.role === "executor") &&
    nodes.every(row => row.code === 0 && Number.isFinite(row.usage.maxRSS) && row.usage.maxRSS > 0 && Number.isFinite(row.startedAtMs) &&
      Number.isFinite(row.endedAtMs) && row.endedAtMs >= row.startedAtMs && lastArg(row, "--max-old-space-size") === (row.role === "executor" ? "224" : "512") &&
      (row.role !== "executor" || lastArg(row, "--max-semi-space-size") === "4"));
  const envelopeBytes = Math.max(sampledPeakBytes, reportedPeakBytes, nodePeakEnvelopeBytes + otherPeakBytes);
  return { sampledPeakBytes, reportedPeakBytes, nodePeakEnvelopeBytes, otherPeakBytes, envelopeBytes, complete,
    passed: complete && envelopeBytes <= 512 * 1048576 };
}

export function archiveProofSummary(rows) {
  const files = new Map();
  for (const row of rows) {
    assert.ok(typeof row.file === "string" && Number.isFinite(row.durationMs) && row.durationMs >= 0, "invalid archive hash telemetry");
    if (!row.error) assert.ok(Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.sha256, "missing measured archive hash bytes");
    const file = files.get(row.file) || { file: row.file, calls: 0, successfulCalls: 0, bytes: 0, durationMs: 0, errors: [] };
    file.calls++; file.durationMs += row.durationMs;
    if (row.error) file.errors.push(row.error);
    else { file.successfulCalls++; file.bytes += row.bytes; }
    files.set(row.file, file);
  }
  return { calls: rows.length, successfulCalls: rows.filter(row => !row.error).length, failedCalls: rows.filter(row => row.error).length,
    hashBytes: [...files.values()].reduce((n, file) => n + file.bytes, 0), hashMs: rows.reduce((n, row) => n + row.durationMs, 0), files: [...files.values()],
    coverage: "successful hashFile return bytes, counting each full call (including both archive verification hashes); failures have unknown partial bytes; not total filesystem I/O" };
}

export function spoolSummary(rows) {
  const events = [];
  let peakScratchBytes = 0, sumPeakScratchBytes = 0, peakMemoryBytes = 0, sumPeakMemoryBytes = 0;
  for (const row of rows) {
    assert.ok(Number.isFinite(row.start) && Number.isFinite(row.end) && row.end >= row.start && row.stats?.spilled === true, "invalid spool lifetime");
    const { peakScratchBytes: scratch, peakMemoryBytes: memory } = row.stats;
    assert.ok([scratch, memory].every(value => Number.isFinite(value) && value >= 0), "invalid spool peak stats");
    peakScratchBytes = Math.max(peakScratchBytes, scratch); sumPeakScratchBytes += scratch;
    peakMemoryBytes = Math.max(peakMemoryBytes, memory); sumPeakMemoryBytes += memory;
    events.push({ at: row.start, delta: scratch }, { at: row.end, delta: -scratch });
  }
  let active = 0, overlapPeakScratchUpperBoundBytes = 0;
  // Starts precede closes within the same millisecond, preserving a conservative overlap bound.
  for (const event of events.sort((a, b) => a.at - b.at || b.delta - a.delta)) {
    active += event.delta; overlapPeakScratchUpperBoundBytes = Math.max(overlapPeakScratchUpperBoundBytes, active);
  }
  return { containers: rows.length, failedCloses: rows.filter(row => row.error).length,
    peakScratchBytes, sumPeakScratchBytes, overlapPeakScratchUpperBoundBytes, peakMemoryBytes, sumPeakMemoryBytes,
    anonymousPhysicalBytes: null,
    coverage: "closed spilled UsageSourceRows only, from first spill through close; scratch is logical SQLite page high-water, memory is its existing estimate, neither is physical allocation or RSS; sums add container peaks, not I/O; overlap sums each lifetime peak as an upper bound; anonymous physical allocation, unclosed containers and other anonymous SQLite tables are not observed" };
}

export async function resources(directory, scene) {
  const samples = [], nodes = [], history = [], fastHistory = [], methodSpans = [], sync = [], publications = [], archiveProofs = [], businessClocks = [], spools = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) if (entry.isDirectory() && entry.name.startsWith("resources")) {
    await lines(path.join(directory, entry.name, "resources.ndjson"), row => samples.push(row));
  }
  for (const file of await readdir(path.join(directory, "nodes"))) {
    const target = /^node-.*\.jsonl$/.test(file) ? nodes : /^history-.*\.ndjson$/.test(file) ? history :
      /^fast-history-.*\.ndjson$/.test(file) ? fastHistory : /^method-.*\.ndjson$/.test(file) ? methodSpans :
      /^sync-.*\.ndjson$/.test(file) ? sync : /^prefix-.*\.ndjson$/.test(file) ? publications : /^archive-proof-.*\.ndjson$/.test(file) ? archiveProofs : /^business-clock-.*\.ndjson$/.test(file) ? businessClocks : /^spool-.*\.ndjson$/.test(file) ? spools : null;
    if (target) await lines(path.join(directory, "nodes", file), row => target.push(row));
  }
  const peak = get => Math.max(0, ...samples.map(get));
  const sum = get => samples.reduce((n, row) => n + (get(row) || 0), 0);
  const projectionFiles = row => row.state.files.filter(file => /\.history-cache[\\/]/.test(file.relativePath));
  const coverage = storageCoverage(samples);
  const storageSnapshots = [...history.map(row => row.projectionStorage), ...(scene?.storage || [])].filter(Boolean);
  return { memory: memoryGate(samples, nodes, entries.filter(entry => /^server(?:-reopen)?\.json$/.test(entry.name)).length),
    samples: samples.length, browserPeakBytes: peak(row => row.browser.workingSetBytes || 0),
    statePeakBytes: peak(row => row.state.observedBytes || 0), walPeakBytes: peak(row => row.state.categoryBytes?.wal || 0),
    projectionPeakBytes: Math.max(peak(row => projectionFiles(row).reduce((n, file) => n + file.bytes, 0)), ...storageSnapshots.map(row => row.totalBytes)),
    maintenanceLockPeakBytes: Math.max(0, ...storageSnapshots.map(row => row.maintenanceLockBytes || 0)),
    projectionPeakAllocatedBytes: peak(row => projectionFiles(row).reduce((n, file) => n + (file.allocatedBytes || 0), 0)),
    projectionAllocationCoverage: "sampler SQLite-named files; maintenance.lock logical bytes included in snapshots, its allocation is not sampled",
    projectionDatabasePeakCount: peak(row => projectionFiles(row).filter(file => file.relativePath.endsWith(".sqlite")).length),
    visibleTempPeakBytes: peak(row => row.temp.observedBytes || 0), visibleTempPeakAllocatedBytes: peak(row => row.temp.observedAllocatedBytes || 0),
    storageEvidenceComplete: coverage.allocationComplete, storageInventoryComplete: coverage.inventoryComplete,
    storageCoverage: coverage,
    storageEvidenceScope: "directory-visible artifacts only; anonymous spool physical allocation is not observed",
    historyQueryPeakLogicalBytes: Math.max(0, ...history.map(row => row.work?.scratchBytes || 0)),
    historyScratchPeakLogicalBytes: Math.max(0, ...history.filter(row => !row.work?.projection).map(row => row.work?.scratchBytes || 0)),
    cpuSeconds: sum(row => row.service.cpuSecondsIncrement), logicalReadBytes: sum(row => row.service.logicalReadBytesIncrement),
    logicalWriteBytes: sum(row => row.service.logicalWriteBytesIncrement),
    initialization: scene ? { wallMs: scene.initialServiceWallMs, samples: samples.filter(row => row.atUnixMs <= scene.initialAll.endedAtMs).length,
      cpuSeconds: sum(row => row.atUnixMs <= scene.initialAll.endedAtMs ? row.service.cpuSecondsIncrement : 0),
      logicalReadBytes: sum(row => row.atUnixMs <= scene.initialAll.endedAtMs ? row.service.logicalReadBytesIncrement : 0),
      logicalWriteBytes: sum(row => row.atUnixMs <= scene.initialAll.endedAtMs ? row.service.logicalWriteBytesIncrement : 0),
      archiveProof: archiveProofSummary(archiveProofs.filter(row => row.endedAtMs <= scene.initialAll.endedAtMs)),
      peakBytes: Math.max(0, ...samples.filter(row => row.atUnixMs <= scene.initialAll.endedAtMs).map(row => row.service.workingSetBytes || 0)),
      storage: scene.storage.find(row => row.phase === "initial-all") } : null,
    spool: spoolSummary(spools), spools, archiveProof: archiveProofSummary(archiveProofs), archiveProofs, businessClocks, nodes, history, fastHistory, methodSpans, sync, publications };
}

function stripClock(value) {
  if (Array.isArray(value)) return value.map(stripClock);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([name]) =>
    !["generatedAt", "asOf", "checkedAt"].includes(name)).map(([name, item]) => [name, stripClock(item)]));
  return value;
}
export function comparable(body, commonAsOf, crossLayout = false) {
  const summary = structuredClone(body.summary), comparison = summary.comparison, range = summary.range;
  if (comparison?.previousRange) {
    const trend = asOf => {
      const start = Date.parse(range.start), end = Date.parse(range.end), now = Date.parse(asOf);
      const duration = Date.parse(comparison.previousRange.end) - Date.parse(comparison.previousRange.start) + 1;
      assert.ok([start, end, now, duration].every(Number.isFinite) && duration > 0);
      const baseline = Math.round(comparison.previousTotals.total * Math.max(0, Math.min(end, Math.max(start, now)) - start + 1) / duration);
      return { averageBaselineTotal: baseline, averageDelta: summary.totals.total - baseline,
        averagePercentChange: baseline ? Math.round((summary.totals.total - baseline) / baseline * 10000) / 100 : null };
    };
    for (const [name, expected] of Object.entries(trend(body.metadata.modelUsageAsOf))) assert.equal(comparison[name], expected, `observation-time ${name}`);
    Object.assign(comparison, trend(commonAsOf));
  }
  // Only live window selection is clock-dependent; retained quota identity/history still compares exactly.
  const quota = value => value ? Object.fromEntries(Object.entries(value).filter(([key]) => !["asOf", "windows"].includes(key))) : value;
  if (summary.quota) summary.quota = quota(summary.quota);
  if (crossLayout) {
    const groups = rows => rows.map(({ key, count, sessions, total }) => ({ key, count, sessions, total })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    return stripClock({ summary: { range, totals: summary.totals, eventCount: summary.eventCount, sessionCount: summary.sessionCount,
      homeCount: summary.homeCount, channels: groups(summary.channels), models: groups(summary.models),
      timeline: summary.timeline.map(row => ({ key: row.key, count: row.count, sessions: row.sessions, total: row.total, channels: groups(row.channels), models: groups(row.models) })) },
      metadata: { eventCount: body.metadata.eventCount, sessionCount: body.metadata.sessionCount, homeCount: body.metadata.homeCount }, periodComparison: body.periodComparison });
  }
  const metadata = Object.fromEntries(["eventCount", "sessionCount", "homeCount", "harnessModels", "homes", "warnings", "imports"].map(key => [key, body.metadata[key]]));
  return stripClock({ summary, metadata, quota: quota(body.quota), pricingCatalog: body.pricingCatalog, periodComparison: body.periodComparison });
}
export function exactParity(now, old, crossLayout = false, replay = false) {
  const asOf = old.metadata.modelUsageAsOf;
  assert.deepEqual(comparable(now, asOf, crossLayout), comparable(old, asOf, crossLayout));
  if (replay) {
    assert.equal(now.metadata.modelUsageAsOf, asOf, "year response business asOf must match its exact C1 phase");
    assert.equal(now.periodComparison.asOf, old.periodComparison.asOf);
    for (const key of ["modelLastSeen", "activeHarnessModels"]) assert.deepEqual(now.metadata[key], old.metadata[key], key);
    assert.deepEqual(now.quota, old.quota); assert.deepEqual(now.summary.quota, old.summary.quota);
  }
}

export function clockReplayGate(scene, reference, businessClocks, plans) {
  const replay = reference.clockReplay;
  assert.equal(fingerprint(replay), reference.clockReplayFingerprint);
  assert.equal(scene.evidence.clockReplayFingerprint, reference.clockReplayFingerprint);
  assert.equal(scene.clockReplay.fingerprint, reference.clockReplayFingerprint);
  const expectedPhases = [...REPLAY_PHASES.slice(0, 6), "repeat-all", "after-executor-exit-all", ...REPLAY_PHASES.slice(6)];
  assert.deepEqual(scene.clockReplay.phaseWrites.map(row => row.phase), expectedPhases);
  for (const write of scene.clockReplay.phaseWrites) {
    const phase = ["repeat-all", "after-executor-exit-all"].includes(write.phase) ? "initial-all" : write.phase;
    const old = replay.phases.find(row => row.phase === phase); assert.ok(old);
    assert.equal(write.referencePhase, phase); assert.equal(write.asOf, old.asOf);
    assert.equal(write.referenceFile, old.file); assert.equal(write.referenceSha256, old.sha256);
    assert.ok(Number.isFinite(write.startedAtMs) && write.writtenAtMs >= write.startedAtMs);
    assert.ok(businessClocks.some(row => row.phase === write.phase && row.asOf === write.asOf && row.readAtMs >= write.startedAtMs), `missing active business-clock read: ${write.phase}`);
  }
  for (const row of businessClocks) {
    const write = scene.clockReplay.phaseWrites.find(write => write.phase === row.phase); assert.ok(write);
    assert.equal(row.asOf, write.asOf); assert.equal(row.referenceSha256, write.referenceSha256);
  }
  assert.deepEqual(plans.map(row => row.kind), KINDS);
  for (const mutation of replay.mutations) {
    const plan = plans.find(row => row.kind === mutation.kind); assert.ok(plan);
    assert.equal(plan.filePath, mutation.filePath); assert.equal(plan.replayTimestampMs, mutation.timestampMs);
    if (plan.deliveryPlan) assert.equal(plan.deliveryPlan.appendTimeMs + 1000, mutation.timestampMs);
  }
}

export function executorReuseParity(now, old, replay = false) {
  assert.equal(now.summary.range.preset, "all");
  assert.deepEqual(now.summary.range, old.summary.range);
  exactParity(now, old, false, replay);
}

export function latencies(scene) {
  assert.deepEqual(scene.changes.map(row => row.name), [...KINDS.map(kind => `append-${kind}`), "revision-zcode"]);
  assert.deepEqual(scene.scopes.map(row => row.preset), ["today", "week", "custom", "all"]);
  return { default: scene.defaultPaintWallMs, "startup-all": scene.initialServiceWallMs, "first-all": scene.initialAll.wallMs,
    reopen: scene.reopen.wallMs, ...Object.fromEntries(scene.changes.map(row => [row.name, row.actualPaintMs])),
    ...Object.fromEntries(scene.scopes.map(row => [`scope-${row.preset}`, row.wallMs])) };
}

export function workGate(scene, measured) {
  assert.ok(scene.reuseChecks?.executorExit?.code === 0, "executor-exit reuse evidence missing");
  const history = measured.history.filter(row => row.work), after = scene.initialAll.endedAtMs;
  const maintenance = history.filter(row => row.startedAtMs >= after);
  const failed = measured.history.filter(row => row.error);
  const windows = [...scene.changes.map(row => ({ name: row.name, start: row.landedAtMs, end: row.endedAtMs })),
    ...scene.scopes.map(row => ({ name: `scope-${row.preset}`, start: row.startedAtMs, end: row.endedAtMs })),
    { name: "reopen", start: scene.reopen.serviceStartedAtMs, end: scene.reopen.endedAtMs },
    ...["repeat", "afterExit"].map(name => ({ name, start: scene.reuseChecks[name].startedAtMs, end: scene.reuseChecks[name].endedAtMs }))];
  const operations = windows.map(window => {
    const rows = history.filter(row => row.startedAtMs >= Math.floor(window.start) && row.startedAtMs <= window.end);
    return { ...window, queries: rows.length, rebuilds: rows.filter(row => row.work.projection ? row.work.projection.rebuilt : true).length,
      coldCopied: rows.reduce((n, row) => n + (row.work.projection?.coldCopied || 0), 0),
      hotCopied: rows.reduce((n, row) => n + (row.work.projection?.hotCopied || 0), 0),
      netChanges: Object.fromEntries(["added", "removed", "scanned", "sorted"].map(key => [key,
        rows.reduce((n, row) => n + (row.work.projection?.delta?.[key] || 0), 0)])),
      archiveProof: archiveProofSummary(measured.archiveProofs.filter(row => row.startedAtMs >= Math.floor(window.start) && row.startedAtMs <= window.end)),
      fastHistory: (measured.fastHistory || []).filter(row => row.startedAtMs >= Math.floor(window.start) && row.endedAtMs <= window.end),
      projections: rows.map(row => ({ work: row.work.projection, views: row.work.views, inputVersion: row.inputVersion })),
      sync: measured.sync.filter(row => row.start >= Math.floor(window.start) && row.start <= window.end).map(row => ({ work: row.work, durationMs: row.durationMs, error: row.error })) };
  });
  const persistentRequired = scene.layout === "mixed" && scene.storage.some(row => row.databaseCount > 0);
  const projectionEvidence = !persistentRequired || history.some(row => row.work.projection) && history.every(row =>
    row.work.projection && typeof row.work.projection.rebuilt === "boolean" && Number.isFinite(row.work.projection.coldCopied) &&
    row.inputVersion && row.publishedVersion?.status === "ready" && fingerprint(JSON.parse(row.publishedVersion.inputs_json)) === fingerprint(row.inputVersion));
  const storagePassed = scene.storage.length >= 10 && scene.storage.every(row => row.databaseCount <= 2 && row.orphanDatabases.length === 0 &&
    (scene.layout !== "hot" || row.present === false)) &&
    ["closed", "reopen-closed"].every(phase => scene.storage.some(row => row.phase === phase && !row.candidate && row.databaseCount <= 1 && row.walBytes === 0)) &&
    measured.projectionDatabasePeakCount <= 2 && (measured.storageInventoryComplete ?? measured.storageEvidenceComplete);
  const zeroRebuilds = maintenance.every(row => row.work.projection && row.work.projection.rebuilt === false);
  const zeroColdCopy = operations.filter(row => row.name.startsWith("append-")).every(row => row.coldCopied === 0);
  const required = scene.label === "year" || scene.label === "two-years";
  const mixedEvidence = scene.layout !== "mixed" || !required || persistentRequired && history.length > 0;
  const exited = scene.reuseChecks.executorExit;
  const newExecutors = measured.nodes.filter(row => row.role === "executor" && row.pid !== exited.pid && row.startedAtMs >= exited.endedAtMs);
  const afterExitRows = history.filter(row => row.startedAtMs >= Math.floor(scene.reuseChecks.afterExit.startedAtMs) && row.startedAtMs <= scene.reuseChecks.afterExit.endedAtMs);
  const afterExitFastHistory = operations.find(row => row.name === "afterExit").fastHistory.filter(row =>
    row.success === true && !row.error && row.path === "single-archive-all" && row.requestedPreset === "all" && row.preset === "all" &&
    row.bucket === "day" && typeof row.segmentId === "string" && row.segmentId.length > 0 && typeof row.summaryProjectionCacheReused === "boolean" &&
    Number.isFinite(row.startedAtMs) && Number.isFinite(row.endedAtMs) && row.endedAtMs >= row.startedAtMs &&
    newExecutors.some(node => node.pid === row.pid && node.startedAtMs <= row.startedAtMs && node.endedAtMs >= row.endedAtMs));
  const diskReuse = scene.reuseChecks.afterExit.cache === "miss" && newExecutors.length > 0 &&
    (!persistentRequired || afterExitRows.some(row => newExecutors.some(node => node.pid === row.pid)) || afterExitFastHistory.length > 0);
  const allViews = afterExitRows.map(row => row.work.views?.all).filter(Boolean);
  const sameBusinessContext = scene.reuseChecks.afterExit.bucket === "day" && scene.reuseChecks.afterExit.recentValue === "今年" &&
    scene.reuseChecks.afterExit.cacheBypass === "unused recentValue only; same all/day business context" &&
    (!persistentRequired || allViews.length > 0 && allViews.every(row => row.readEvents === 0) || afterExitFastHistory.length > 0);
  const unchangedReuse = operations.filter(row => ["reopen", "repeat", "afterExit"].includes(row.name) || row.name.startsWith("scope-")).every(row =>
    row.coldCopied === 0 && row.hotCopied === 0 && row.netChanges.added === 0 && row.netChanges.removed === 0);
  const archiveProofPassed = measured.archiveProof.failedCalls === 0 && (scene.layout !== "mixed" || measured.archiveProof.successfulCalls > 0);
  return { operations, projectionEvidence, storagePassed, zeroRebuilds, zeroColdCopy, mixedEvidence,
    unchangedReuse, diskReuse, sameBusinessContext, afterExitAllViews: allViews, afterExitFastHistory, archiveProofPassed,
    initialBuilds: history.filter(row => row.endedAtMs <= after && row.work.projection?.rebuilt).length,
    initialization: history.filter(row => row.endedAtMs <= after),
    passed: failed.length === 0 && projectionEvidence && storagePassed && zeroRebuilds && zeroColdCopy && mixedEvidence && unchangedReuse && diskReuse && sameBusinessContext && archiveProofPassed &&
      measured.sync.every(row => !row.error) && measured.publications.every(row => !row.error) };
}

export async function analyze(manifestFile, validationFile, outputFile, selectionFile) {
  const manifest = await read(manifestFile), issues = [], scenes = [];
  const manifestSha256 = await hashFile(manifestFile);
  const originalManifestSha256 = manifest.frontGate ? (await read(manifest.frontGate.file)).manifestSha256 : manifestSha256;
  const check = (group, gate, action) => { try { action(); } catch (error) { issues.push({ group, gate, message: error.message }); } };
  assert.deepEqual(manifest.conditions, CONDITIONS); assertMatrix(manifest.groups);
  await verifyEntries(manifest.tools);
  assert.equal(fingerprint(manifest.tools), manifest.toolsFingerprint); await verifyEntries(manifest.workspace);
  for (const variant of ["baseline", "candidate"]) {
    const spec = await read(manifest[`${variant}File`]); await verifyFrozenRuntime(spec);
    assert.equal(fingerprint(spec.hashes), manifest[`${variant}Fingerprint`]);
  }
  for (const input of manifest.datasets) { assert.equal(fingerprint(input.entries), input.fingerprint); await verifyEntries(input.entries); }
  assert.equal(await hashFile(manifest.year.file), manifest.year.sha256);
  for (const reference of manifest.year.references) await verifyEntries(reference.entries);
  const selection = selectionFile ? await read(selectionFile) : {};
  const key = row => `${row.label}/${row.layout}/${row.variant}`;
  for (const selected of Object.keys(selection)) assert.ok(manifest.groups.some(group => key(group) === selected), "selection cannot expand matrix");
  for (const group of manifest.groups) {
    const id = key(group), name = selection[id] || group.name;
    try {
      assert.ok(name === group.name || new RegExp(`^${group.name}-retry-[1-9][0-9]*$`).test(name));
      const directory = path.join(manifest.resultRoot, "datasets", group.label, `scene-${name}`), scene = await read(path.join(directory, "result.json"));
      assert.equal(scene.label, group.label); assert.equal(scene.layout, group.layout); assert.equal(scene.evidence?.variant, group.variant);
      assert.equal(scene.evidence.runtimeFingerprint, manifest[`${group.variant}Fingerprint`]);
      assert.equal(scene.evidence.inputFingerprint, manifest.datasets.find(row => row.label === group.label).fingerprint);
      if (group.variant === "baseline") {
        // Keep the measured control's original receipt when only the candidate is corrected.
        const controlManifest = await read(scene.evidence.manifestFile);
        assert.equal(await hashFile(scene.evidence.manifestFile), scene.evidence.manifestSha256);
        assert.equal(controlManifest.baselineFingerprint, manifest.baselineFingerprint);
        assert.deepEqual(controlManifest.conditions, manifest.conditions);
        assert.deepEqual(controlManifest.runtime, manifest.runtime);
        assert.equal(controlManifest.dataRoot, manifest.dataRoot);
        assert.equal(controlManifest.datasets.find(row => row.label === group.label)?.fingerprint,
          manifest.datasets.find(row => row.label === group.label)?.fingerprint);
      } else if (scene.evidence.manifestSha256 !== (group.label === "two-years" ? manifestSha256 : originalManifestSha256)) {
        const measuredManifest = await read(scene.evidence.manifestFile);
        assert.equal(await hashFile(scene.evidence.manifestFile), scene.evidence.manifestSha256);
        assert.equal(measuredManifest.candidateFingerprint, manifest.candidateFingerprint);
        assert.deepEqual(measuredManifest.runtime, manifest.runtime);
        assert.deepEqual(measuredManifest.conditions, manifest.conditions);
        let comparedTools = manifest.tools;
        const proof = manifest.currentReplayCorrection;
        if (group.label === "current" && proof) {
          const previousHook = measuredManifest.tools.find(row => path.basename(row.file) === "c1-telemetry.mjs");
          const currentHook = manifest.tools.find(row => path.basename(row.file) === "c1-telemetry.mjs");
          if (previousHook.sha256 !== currentHook.sha256) {
            await verifyEntries([proof.before, proof.after]);
            assert.equal(previousHook.sha256, proof.before.sha256);
            assert.equal(currentHook.sha256, proof.after.sha256);
            assertUnchangedCurrentReplayHook(await readFile(proof.before.file, "utf8"), await readFile(proof.after.file, "utf8"));
            comparedTools = manifest.tools.map(row => row === currentHook ? { ...row, sha256: previousHook.sha256 } : row);
          }
        }
        assertSameMeasurementTools(measuredManifest.tools, comparedTools);
      }
      assert.deepEqual(scene.evidence.conditions, CONDITIONS);
      if (name !== group.name) assert.ok(scene.evidence.retryOf, "retry requires its retained failed original");
      const measured = await resources(directory, scene);
      const item = { ...group, id, name, directory, scene, measured }; scenes.push(item);
      check(id, "scene", () => { assert.equal(scene.passed, true); assert.equal(scene.rawRestored, true); assert.deepEqual(scene.errors, []); latencies(scene); });
      check(id, "memory", () => assert.equal(measured.memory.passed, true, JSON.stringify(measured.memory)));
      check(id, "archive-proof", () => {
        assert.equal(measured.archiveProof.failedCalls, 0);
        if (group.layout === "mixed") assert.ok(measured.archiveProof.successfulCalls > 0, "missing actual archive hash evidence");
      });
      if (group.label === "year") {
        const reference = manifest.year.references.find(row => row.layout === group.layout);
        const plans = await read(path.join(directory, "mutation-plans.json"));
        check(id, "clock-replay", () => clockReplayGate(scene, reference, measured.businessClocks, plans));
        const oldPlans = await read(reference.clockReplay.plansFile), oldResult = await read(reference.clockReplay.resultFile);
        check(id, "payload-replay", () => {
          const state = path.join(path.dirname(directory), `state-scene-${name}`, "usage-index.sqlite");
          assert.deepEqual(replayMutationTimes(state, reference.clockReplay.seedFile, oldPlans, oldResult.changes), reference.clockReplay.mutations);
        });
      } else check(id, "real-clock", () => { assert.equal(scene.clockReplay, undefined); assert.equal(measured.businessClocks.length, 0); });
      if (group.variant === "candidate") {
        item.work = workGate(scene, measured); check(id, "work/storage", () => assert.equal(item.work.passed, true, JSON.stringify(item.work)));
        assert.ok(scene.reuseChecks);
        const initial = await read(path.join(directory, "initial-all.json"));
        exactParity(await read(path.join(directory, "repeat-all.json")), initial);
        executorReuseParity(await read(path.join(directory, "after-executor-exit-all.json")), initial, group.label === "year");
      }
    } catch (error) { issues.push({ group: id, gate: "missing/invalid-evidence", message: error.message }); }
  }
  for (const item of scenes.filter(row => row.variant === "candidate")) {
    const old = item.label === "current" ? scenes.find(row => row.label === "current" && row.layout === item.layout && row.variant === "baseline") :
      item.label === "year" ? manifest.year.references.find(row => row.layout === item.layout) : null;
    if (!old) { if (item.label !== "two-years") issues.push({ group: item.id, gate: "reference-missing" }); continue; }
    const before = old.scene || (await read(manifest.year.file)).datasets.find(row => row.label === "year").scenes.find(row => row.layout === item.layout);
    check(item.id, "source-reset", () => {
      const reset = scene => scene.sourceReset.map(({ kind, sha256, mtimeMs }) => ({ kind, sha256, mtimeMs }));
      assert.deepEqual(reset(item.scene), reset(before));
      assert.deepEqual(item.scene.restoredSources?.map(({ kind, sha256, mtimeMs }) => ({ kind, sha256, mtimeMs })), reset(item.scene));
    });
    item.latencies = [];
    check(item.id, "latency", () => {
      const was = latencies(before), now = latencies(item.scene);
      if (item.label === "current") for (const name of ["repeat", "afterExit"]) {
        was[`reuse-${name}`] = before.reuseChecks?.[name]?.wallMs;
        now[`reuse-${name}`] = item.scene.reuseChecks?.[name]?.wallMs;
      }
      item.latencies = Object.entries(now).map(([name, candidateMs]) => {
        const baselineMs = was[name]; regressionPassed(baselineMs, candidateMs);
        const target80 = item.label === "year" && item.layout === "mixed" && (name === "reopen" || name.startsWith("append-") || name === "revision-zcode" || name.startsWith("scope-"));
        const jointGate = item.label === "current" || ["default", "startup-all", "first-all"].includes(name);
        return { name, baselineMs, candidateMs, limitMs: target80 ? baselineMs * 0.2 : null,
          passed: target80 ? candidateMs <= baselineMs * 0.2 : !jointGate || regressionPassed(baselineMs, candidateMs) };
      });
      assert.ok(item.latencies.every(row => row.passed), JSON.stringify(item.latencies.filter(row => !row.passed)));
    });
    for (const name of CASES) {
      const query = ["today", "week", "custom", "back-all"].includes(name);
      try { exactParity(await read(path.join(item.directory, `${name}.json`)), await read(path.join(query && old.queryDirectory ? old.queryDirectory : old.directory, `${name}.json`)), false, item.label === "year"); }
      catch (error) { issues.push({ group: item.id, gate: `exact/${name}`, message: error.message }); }
    }
  }
  for (const label of new Set(manifest.groups.map(row => row.label))) {
    const hot = scenes.find(row => row.label === label && row.layout === "hot" && row.variant === "candidate");
    const mixed = scenes.find(row => row.label === label && row.layout === "mixed" && row.variant === "candidate");
    if (!hot || !mixed) continue;
    for (const name of CASES) try { exactParity(await read(path.join(mixed.directory, `${name}.json`)), await read(path.join(hot.directory, `${name}.json`)), true); }
    catch (error) { issues.push({ group: `${label}/candidate`, gate: `hot-cold/${name}`, message: error.message }); }
  }
  for (const item of scenes.filter(row => row.label === "two-years" && row.variant === "candidate" && row.layout === "mixed")) {
    const year = scenes.find(row => row.label === "year" && row.layout === "mixed" && row.variant === "candidate");
    check(item.id, "fixed-projection-work", () => {
      assert.ok(year?.work && item.work);
      for (const operation of item.work.operations.filter(row => row.name.startsWith("append-"))) {
        const previous = year.work.operations.find(row => row.name === operation.name); assert.ok(previous);
        assert.equal(operation.hotCopied, 0); assert.equal(operation.coldCopied, 0);
        for (const counter of ["added", "removed", "scanned", "sorted"]) assert.ok(operation.netChanges[counter] <= previous.netChanges[counter], `${operation.name}/${counter} grew with unchanged cold history`);
      }
    });
  }
  let validation;
  try {
    validation = await read(validationFile); assert.equal(validation.candidateFingerprint, manifest.candidateFingerprint);
    for (const name of VALIDATION_CHECKS) {
      const row = validation.checks.find(row => row.name === name); assert.ok(row?.command && row.log && row.sha256, `missing validation: ${name}`);
      assert.equal(row.exitCode, 0); assert.equal(await hashFile(row.log), row.sha256, `validation log drift: ${name}`);
    }
  } catch (error) { issues.push({ group: "validation", gate: "semantics/recovery", message: error.message }); }
  const result = { version: 1, candidateFingerprint: manifest.candidateFingerprint, manifestFile: path.resolve(manifestFile),
    manifestSha256, standards: { conditions: CONDITIONS, maximumGroups: 8, serviceEnvelopeBytes: 512 * 1048576,
      currentRegression: "fails only when both >10% and >100ms", yearMixedRatio: 0.2, amountTolerance: 0,
      ioCoverage: "archiveProof counts returned hash bytes/time per actual complete call; source proof bytes remain in sync.work; OS logical read/write bytes are separate and neither is inferred from manifest size",
      exactComparison: { sameLayout: "full summary including costEstimate/records/order, metadata membership, periodComparison, pricing catalog, retained quota identity/history",
        crossLayout: "facts/sessions/groups/timeline/periods only; never a substitute for same-layout exact costs",
        clockNormalization: "generatedAt/asOf/checkedAt excluded; comparison averages independently verified before common-asOf alignment",
        quotaExcluded: "only asOf and live windows; limitId, ignoredBucketCount and previousWindows retained",
        metadataClockFields: "current: independent normalization plus semantic-exact validation; year: modelUsageAsOf/modelLastSeen/activeHarnessModels and full quota must also match the historical phase exactly" } },
    clockPolicy: "year candidate only: exact historical C1 phase asOf and added payload timestamps; current four groups and all measurement/receipt clocks remain real; repeat-all probes use initial-all clock, reopen default uses reopen-all clock",
    yearReference: manifest.year, validationFile, validation, issues, groups: scenes.map(item => ({ ...item, passed: !issues.some(issue =>
      issue.group === item.id || issue.group === `${item.label}/candidate`) })),
    frontGatePassed: scenes.filter(row => row.label !== "two-years").length === 6 && !issues.some(issue => !issue.group.startsWith("two-years")),
    passed: scenes.length === manifest.groups.length && issues.length === 0, createdAt: new Date().toISOString() };
  await save(outputFile, result);
  console.log(JSON.stringify({ passed: result.passed, frontGatePassed: result.frontGatePassed, groups: scenes.length, issues: issues.map(({ group, gate }) => ({ group, gate })) }));
  if (!result.passed) process.exitCode = 1;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv[3], "<manifest.json> <validation.json> [output.json] [selection.json]");
  await analyze(process.argv[2], process.argv[3], process.argv[4] || path.join(RESULT_ROOT, "analysis.json"), process.argv[5]);
}
