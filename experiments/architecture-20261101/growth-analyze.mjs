import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

const base = path.resolve('output/architecture-20261103/growth-baseline');
const label = process.argv[2]; assert.match(label || '', /^[a-z0-9-]+$/i);
const manifest = JSON.parse(await readFile(path.join(base, label, 'manifest.json'), 'utf8'));
const mib = value => value / 1024 ** 2;
const gib = value => value / 1024 ** 3;
const runs = [];
for (const run of manifest.runs) {
  const result = JSON.parse(await readFile(path.join(run.output, 'result.json'), 'utf8'));
  const resources = JSON.parse(await readFile(path.join(run.output, 'resource-summary.json'), 'utf8'));
  const files = await readdir(run.output);
  const processes = [];
  for (const name of files.filter(f => /^process-.*\.ndjson$/.test(f))) {
    const records = (await readFile(path.join(run.output, name), 'utf8')).trim().split('\n').map(JSON.parse);
    const first = records[0], exit = records.findLast(r => r.type === 'exit');
    const external = resources.processes.find(p => p.pid === first.pid);
    processes.push({ pid: first.pid, executor: first.argv.some(a => a.endsWith('usage-executor.js')),
      command: first.argv.includes('gateway') ? 'launcher' : first.argv.includes('run') ? 'gateway' : 'executor',
      heapLimit: first.heapLimit, execArgv: first.execArgv, exited: Boolean(exit), exitCode: exit?.code,
      cpuSeconds: exit ? (exit.cpu.user + exit.cpu.system) / 1e6 : external?.peakCpuSeconds || 0,
      cpuComplete: Boolean(exit), peakRssMiB: exit ? exit.resource.maxRSS / 1024 : mib(external?.reportedPeakWorkingSetBytes || Math.max(...records.map(r => r.rss))),
      peakIsLifetime: Boolean(exit), maxSampledHeapUsedMiB: mib(Math.max(...records.map(r => r.heapUsed))),
      maxSampledExternalMiB: mib(Math.max(...records.map(r => r.external))) });
  }
  const fatal = [];
  for (const name of files.filter(f => /^report\..*\.json$/.test(f))) {
    const report = JSON.parse(await readFile(path.join(run.output, name), 'utf8'));
    fatal.push({ file: name, event: report.header?.event, trigger: report.header?.trigger, pid: report.header?.processId,
      heapLimit: report.javascriptHeap?.memoryLimit, heapUsed: report.javascriptHeap?.usedMemory,
      cpuSeconds: (report.resourceUsage?.userCpuSeconds || 0) + (report.resourceUsage?.kernelCpuSeconds || 0),
      peakRssBytes: report.resourceUsage?.maxRss, freeMachineMemoryBytes: report.resourceUsage?.free_memory });
  }
  for (const report of fatal) {
    const process = processes.find(p => p.pid === report.pid);
    if (process && !process.exited) {
      process.cpuSeconds = Math.max(process.cpuSeconds, report.cpuSeconds);
      process.peakRssMiB = Math.max(process.peakRssMiB, mib(report.peakRssBytes || 0));
      process.fatalReport = true;
    }
  }
  const source = JSON.parse(await readFile(path.join(base, run.dataset, 'dataset.json'), 'utf8'));
  const db = new DatabaseSync(path.join(run.output, 'state/usage-index.sqlite'), { readOnly: true });
  let stored, facts, integrity;
  try { stored = db.prepare(`SELECT (SELECT COUNT(*) FROM events) events,(SELECT COUNT(*) FROM source_files) files,
    (SELECT COUNT(DISTINCT home_id) FROM source_files) homes,(SELECT COUNT(*) FROM archive_segments) coldSegments,
    (SELECT COUNT(*) FROM rate_limit_observations) quota,(SELECT COUNT(*) FROM (SELECT DISTINCT home_id,session_id FROM events)) sessions`).get();
    facts = db.prepare(`SELECT s.kind,COUNT(e.id) events,SUM(e.total) total,SUM(e.input) input,SUM(e.cached) cached,
      SUM(e.output) output,SUM(e.reasoning) reasoning FROM source_files s LEFT JOIN events e ON e.source_path=s.path GROUP BY s.kind`).all()
      .map(r => ({ ...r, kind: ['main','extra','jetbrains'].includes(r.kind) ? 'codex' : r.kind })).sort((a,b) => a.kind.localeCompare(b.kind));
    integrity = db.prepare('PRAGMA quick_check').all().map(row => row.quick_check);
  }
  finally { db.close(); }
  const factsComplete = isDeepStrictEqual(facts, source.expected.toSorted((a,b) => a.kind.localeCompare(b.kind))) &&
    stored.files === source.expectedFiles && stored.homes === source.expectedHomes && stored.quota === source.expectedQuota;
  let sharingError = false;
  for (const file of files.filter(f => f.startsWith('child-stderr-'))) {
    const stderr = await readFile(path.join(run.output,file),'utf8');
    if (stderr.includes('EBUSY') && stderr.includes('startup-telemetry.mjs')) sharingError = true;
  }
  const serviceProcesses = resources.processes.filter(p => p.role === 'service');
  runs.push({ name: run.name, dataset: run.dataset, implementation: run.implementation || manifest.implementation || 'before-b1', valid: run.exitCode === 0 && run.verification?.passed === true && !result.failure && !run.verificationFailure && !resources.failure,
    firstPaintSeconds: result.firstPaintMs ? result.firstPaintMs / 1000 : null,
    apiCompleteSeconds: result.apiCompleteMs ? result.apiCompleteMs / 1000 : null,
    failureResponseSeconds: result.failure && result.apiCompleteMs ? result.apiCompleteMs / 1000 : null,
    elapsedSeconds: run.wallMs / 1000, failure: result.failure || run.verificationFailure || null,
    cpuSeconds: processes.reduce((n,p) => n + p.cpuSeconds, 0), cpuComplete: processes.every(p => p.cpuComplete),
    executorPeakRssMiB: Math.max(...processes.filter(p => p.executor).map(p => p.peakRssMiB)),
    servicePeakSampledRssMiB: mib(resources.service.peakSampledWorkingSetBytes),
    servicePeakSampledPrivateMiB: mib(resources.service.peakSampledPrivateBytes),
    serviceSumOfProcessPeaksMiB: processes.reduce((n,p) => n + p.peakRssMiB, 0),
    logicalReadGiBLowerBound: gib(serviceProcesses.reduce((n,p) => n + p.maxLogicalReadBytes, 0)),
    logicalWriteGiBLowerBound: gib(serviceProcesses.reduce((n,p) => n + p.maxLogicalWriteBytes, 0)),
    statePeakSampledMiB: mib(resources.sqlite.peakTotalBytes),
    indexFinalMiB: mib(run.stateFiles.filter(f => /^usage-index\.sqlite(?:-wal|-shm)?$/.test(f.file)).reduce((n,f) => n + f.bytes, 0)),
    summaryFinalMiB: mib(run.stateFiles.filter(f => f.file.startsWith('usage-index.sqlite.summaries.sqlite')).reduce((n,f) => n + f.bytes, 0)),
    walPeakSampledMiB: mib(Math.max(0, ...resources.sqlite.files.filter(f => f.relativePath.endsWith('-wal')).map(f => f.peakBytes))),
    browserPeakSampledRssMiB: mib(resources.browser.peakSampledWorkingSetBytes),
    browserCpuLowerBound: resources.processes.filter(p => p.role === 'browser').reduce((n,p) => n + p.peakCpuSeconds, 0),
    observerCpuSeconds: resources.observer.cpuSecondsUsed, samples: resources.sampleCount, samplerFailure: resources.failure,
    stored, facts, factsComplete, integrity, sourceBytes: source.totals.sourceBytes, decodedBytes: source.totals.decodedBytes, rows: source.totals.rows,
    expectedEvents: source.expected.reduce((n,f) => n + f.events, 0), sourceFiles: source.expectedFiles,
    measuredService: resources.service.peakSampledWorkingSetBytes > 0 && !sharingError,
    outcome: sharingError ? 'instrumentation-file-sharing-error' : fatal.some(f => f.trigger === 'OOMError') ? 'oom' : run.verification?.passed && !run.verificationFailure ? 'success' : resources.service.peakSampledWorkingSetBytes === 0 ? 'service-disappeared-before-sampling' : 'failure',
    processes, fatal });
}
const range = values => {
  const sorted = values.toSorted((a,b) => a-b), n = sorted.length;
  return n ? { n, median: (sorted[Math.floor((n-1)/2)] + sorted[Math.floor(n/2)]) / 2, min: sorted[0], max: sorted.at(-1) } : null;
};
const groups = {};
const metrics = ['firstPaintSeconds', 'failureResponseSeconds', 'cpuSeconds', 'executorPeakRssMiB', 'servicePeakSampledRssMiB', 'servicePeakSampledPrivateMiB',
  'logicalReadGiBLowerBound', 'logicalWriteGiBLowerBound', 'statePeakSampledMiB', 'indexFinalMiB', 'summaryFinalMiB', 'walPeakSampledMiB', 'browserPeakSampledRssMiB', 'observerCpuSeconds'];
const groupKey = run => run.implementation === 'before-b1' && manifest.schedule.includes('1x-before') ? `before-${run.dataset}` : run.dataset;
for (const dataset of new Set(runs.map(groupKey))) {
  const selected = runs.filter(r => groupKey(r) === dataset);
  const success = selected.filter(r => r.valid);
  const measured = selected.filter(r => r.measuredService);
  groups[dataset] = { attempted: selected.length, successful: success.length, failed: selected.length-success.length,
    usableResourceRuns: measured.length,
    factsCompleteRuns: selected.filter(r => r.factsComplete).length,
    outcomes: Object.fromEntries([...new Set(selected.map(r => r.outcome))].map(outcome => [outcome, selected.filter(r => r.outcome === outcome).length])),
    metrics: Object.fromEntries(metrics.map(metric => [metric, range((metric === 'firstPaintSeconds' ? success : measured).map(r => r[metric]).filter(Number.isFinite))])) };
}
const completeFacts = runs.filter(r => r.factsComplete);
const fixedCardinalities = { files: [...new Set(completeFacts.map(r => r.stored.files))], sessions: [...new Set(completeFacts.map(r => r.stored.sessions))] };
assert.ok(fixedCardinalities.files.length <= 1 && fixedCardinalities.sessions.length <= 1, 'Successful growth runs changed fixed cardinalities');
const analysis = { label, groups, runs, fixedCardinalities, inputIntegrity: manifest.inputIntegrity,
  analysisScriptSha256: createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),
  notes: ['Samples are process-cold; OS cache was not flushed.', 'CPU includes recorded launcher/gateway/executors through exit; browser is separate.',
    'CPU for a process without exit telemetry is a sampled lower bound.', 'Tree RSS/private/WAL are sampled peaks, not guaranteed exact maxima.',
    'Logical process I/O includes cache hits and IPC; final samples can miss the exit tail. It is not physical disk traffic.',
    'Sum of process-lifetime RSS peaks is not a simultaneous tree peak.', 'Only the history-density axis is scaled; file/session sets and six source instances stay fixed.'] };
await writeFile(path.join(base, label, 'analysis.json'), JSON.stringify(analysis, null, 2));
console.log(JSON.stringify({ groups, runs: runs.map(({ name, valid, stored, firstPaintSeconds, fatal }) => ({ name, valid, stored, firstPaintSeconds, fatal })) }, null, 2));
