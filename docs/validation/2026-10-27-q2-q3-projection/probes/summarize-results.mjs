import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.existsSync(path.join(root, name)) ? JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) : null;
const stats = values => {
  values = [...values].sort((a, b) => a - b);
  if (!values.length) return null;
  assert.ok(values.every(Number.isFinite));
  return { n: values.length, p50: values[Math.ceil(values.length * .5) - 1],
    p95: values[Math.ceil(values.length * .95) - 1], max: values.at(-1) };
};
const observed = values => {
  const value = stats(values);
  return value && { n: value.n, min: Math.min(...values), median: value.p50, max: value.max };
};
function paired(file) {
  const result = read(file);
  if (!result) return null;
  const scenes = {};
  for (const phase of new Set(result.pairs.map(pair => pair.phase))) {
    const pairs = result.pairs.filter(pair => pair.phase === phase).map(pair => {
      const a = result.samples.find(row => row.mode === 'before' && row.phase === phase && row.index === pair.index);
      const b = result.samples.find(row => row.mode === 'after' && row.phase === phase && row.index === pair.index);
      assert.equal(a.summaryHash, b.summaryHash);
      return { index: pair.index, savedMs: a.combinedMs - b.combinedMs, querySavedMs: a.queryMs - b.queryMs };
    });
    scenes[phase] = { pairs: pairs.length, faster: pairs.filter(pair => pair.savedMs > 0).length,
      saving: stats(pairs.map(pair => pair.savedMs)), querySaving: stats(pairs.map(pair => pair.querySavedMs)),
      reversePairs: pairs.filter(pair => pair.savedMs <= 0), versions: {} };
    for (const mode of ['before', 'after']) {
      const rows = result.samples.filter(row => row.mode === mode && row.phase === phase);
      scenes[phase].versions[mode] = Object.fromEntries(['syncMs', 'queryMs', 'combinedMs'].map(key => [key, stats(rows.map(row => row[key]))]));
      scenes[phase].versions[mode].timelineCalls = rows.map(row => row.timelineCalls);
      scenes[phase].versions[mode].perfCalls = rows.map(row => row.perfCalls);
      if (rows.every(row => Number.isInteger(row.periodCacheSizeBeforeQuery))) {
        scenes[phase].versions[mode].periodCacheSizeBeforeQuery = rows.map(row => row.periodCacheSizeBeforeQuery);
        scenes[phase].versions[mode].metadataSlotRetained = rows.map(row => row.metadataSlotRetained);
        scenes[phase].versions[mode].periodSlotsRetained = rows.map(row => row.periodSlotsRetained);
      }
    }
  }
  return { file, completed: result.completed, failure: result.failure, scenes, maxRSSKiB: result.maxRSSKiB,
    minFreeGiB: result.minFreeGiB };
}
const q3 = read('q3-formal-results.json');
const browser = read('browser-final-results.json');
const worstPhase = read('browser-worst-phase-results.json');
const queries = read('query-paired-results.json');
const output = {
  createdAt: new Date().toISOString(),
  q2: paired('q2-formal-v4-results.json'),
  q2BeforeDefaultFix: paired('q2-formal-v3-results.json'),
  q2PriorGuardVersion: paired('q2-formal-results.json'),
  append: paired('append-control-results.json'),
  defaultRefresh: Object.fromEntries(['today', 'month'].map(preset => [preset, paired(`default-${preset}-results.json`)])),
  q3: q3 && { completed: q3.completed, failure: q3.failure, pairs: q3.pairs.length,
    dashboard: Object.fromEntries(['before', 'after'].map(mode => [mode, stats(q3.pairs.map(pair => pair[mode].dashboardMs))])),
    combined: Object.fromEntries(['before', 'after'].map(mode => [mode, stats(q3.pairs.map(pair => pair[mode].ms))])),
    dashboardSaving: stats(q3.pairs.map(pair => pair.dashboardSavedMs)),
    combinedSaving: stats(q3.pairs.map(pair => pair.combinedSavedMs)),
    components: Object.fromEntries(['before', 'after'].map(mode => [mode,
      Object.fromEntries(['timelineRange', 'perfSummaryForRange'].map(method => [method,
        stats(q3.pairs.map(pair => pair[mode].execution.filter(event => event.method === method).reduce((sum, event) => sum + event.ms, 0))),
      ])),
    ])),
    faster: q3.pairs.filter(pair => pair.combinedSavedMs > 0).length,
    reversePairs: q3.pairs.filter(pair => pair.combinedSavedMs <= 0).map(pair => ({ index: pair.index, combinedSavedMs: pair.combinedSavedMs })),
    adoptionMs: stats(q3.pairs.flatMap(pair => pair.after.execution.filter(event => event.method === 'adoptUsageProjection').map(event => event.ms))),
    adopted: q3.pairs.filter(pair => pair.after.timelineCalls === 0).length },
  queries: queries && { completed: queries.completed, failure: queries.failure, summary: queries.summary },
  browserWorstPhase: worstPhase && { failure: worstPhase.failure, errors: worstPhase.errors, walAfterClose: worstPhase.walAfterClose,
    cycles: worstPhase.cycles.map(row => ({ kind: row.kind, writePhase: row.writePhase, fromWriteMs: row.fromWriteMs,
      fromCheckTokenMs: row.fromCheckTokenMs, fromCheckTpsMs: row.fromCheckTpsMs, actualIntervalMs: row.actualIntervalMs,
      freshnessBudgetMs: row.freshnessBudgetMs, freshnessOverMs: row.freshnessOverMs,
      writePhaseAfterPreviousTickMs: row.writePhaseAfterPreviousTickMs, missedCheckStartedAt: row.missedCheckStartedAt,
      idleResponseAt: row.idleResponseAt, writtenAt: row.writtenAt })) },
  browser: browser && { finishedAt: browser.finishedAt, failure: browser.failure, cycles: browser.cycles.length,
    errors: browser.errors, firstBrowserMs: browser.firstBrowserMs, walAfterClose: browser.walAfterClose,
    groups: Object.fromEntries(['codex-append', 'ledger'].map(kind => {
      const rows = browser.cycles.filter(row => row.kind === kind);
      return [kind, { n: rows.length, token: observed(rows.map(row => row.fromCheckTokenMs)),
        tps: observed(rows.map(row => row.fromCheckTpsMs)), fromWrite: observed(rows.map(row => row.fromWriteMs)),
        interval: observed(rows.map(row => row.actualIntervalMs)), freshnessOver: rows.filter(row => row.freshnessOverMs > 0).map(row => ({ index: row.index, ms: row.freshnessOverMs })),
        over8Seconds: rows.filter(row => Math.max(row.fromCheckTokenMs, row.fromCheckTpsMs) > 8000).map(row => row.index) }];
    })), twoTabs: browser.twoTabs, maxRSSKiB: browser.maxRSSKiB },
};
fs.writeFileSync(path.join(root, 'summary.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify(output));

