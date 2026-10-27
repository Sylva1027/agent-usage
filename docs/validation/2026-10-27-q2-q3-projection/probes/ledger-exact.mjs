import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { UsageStore as AfterStore, decodePerfSample } from './final-v4/src/usage-store.js';
import { loadPricingFile } from './final-v4/src/pricing-store.js';
import { codexSampleThreadId } from './final-v4/src/perf-sources/codex-thread.js';
import { MAGPIE_TIMING_ORIGIN } from './final-v4/src/perf-magpie-timing.js';

assert.equal(process.env.REFRESH_TRACE, '0');
assert.notEqual(process.env.REFRESH_PRODUCT_BEFORE, '1');
assert.equal(typeof globalThis.__refreshMap, 'function', 'runtime-hook preload required');
const root = path.resolve('output/q2-q3-projection-20261027');
const privateRoot = path.resolve('.codex-usage/refresh-latency-20261026');
const frozen = JSON.parse(fs.readFileSync(path.join(privateRoot, 'freeze.json'), 'utf8'));
const physical = file => {
  const mapping = frozen.mappings.find(row => file.toLowerCase().startsWith(row.original.toLowerCase() + path.sep));
  assert.ok(mapping, 'private source mapping required');
  const copy = path.resolve(mapping.copy, path.relative(mapping.original, file));
  const relative = path.relative(privateRoot, copy);
  assert.ok(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  assert.equal(globalThis.__refreshMap(file), copy, 'preload must use the same private source');
  return copy;
};
const home = frozen.homes.find(row => row.kind === 'main');
assert.ok(home);
const threadId = randomUUID();
const logical = path.join(home.path, 'sessions', '2026', '10', '26', `rollout-refresh-diagnostic-${threadId}.jsonl`);
const native = physical(logical);
const ledger = physical(path.join(frozen.home, '.config/magpie/usage.jsonl'));
const ledgerSize = fs.statSync(ledger).size;
const databaseFile = path.join(privateRoot, `followup-ledger-exact-${process.pid}-${threadId}.sqlite`);
const requests = Array.from({ length: 20 }, (_, index) => {
  const turnId = randomUUID();
  return {
    index, turnId, responseId: 'resp_ledger_exact_' + randomUUID(),
    sampleKey: JSON.stringify(['codex', home.id, threadId, turnId]),
    input: 100 + index, cached: 7 + index, output: 1_000_007 + index * 1009,
    reasoning: 13 + index, durationMs: 2000 + index * 100,
  };
});
assert.equal(new Set(requests.map(row => row.output)).size, 20);
const sql = {
  samples: 'SELECT * FROM perf_samples WHERE source_path = ? ORDER BY sample_key',
  totals: 'SELECT COALESCE(SUM(total), 0) AS total, COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cached), 0) AS cached, COALESCE(SUM(output), 0) AS output, COALESCE(SUM(reasoning), 0) AS reasoning FROM events',
  evidence: 'SELECT home_id, response_id, evidence_origin, requested_model, reported_output_tokens, duration_ms, status FROM perf_request_timing_evidence WHERE home_id = ? AND response_id = ? ORDER BY evidence_origin, variant_key',
  links: 'SELECT home_id, response_id, thread_id FROM perf_request_timing_threads WHERE home_id = ? AND response_id = ? ORDER BY thread_id',
  aggregate: 'SELECT COUNT(*) AS n, SUM(output_tokens) AS outputTokens, SUM(duration_ms) AS durationMs FROM perf_samples WHERE source_path = ? AND duration_ms IS NOT NULL',
};
const result = {
  startedAt: new Date().toISOString(), rounds: 20, homeId: home.id, threadId,
  logicalSource: logical, privateSource: native, privateLedger: ledger, databaseFile,
  requests, sql, syncs: [], checks: [], completed: false,
};
const save = () => fs.writeFileSync(path.join(root, 'ledger-exact-results.json'), JSON.stringify(result, null, 2));
let store;
let databaseCopied = false;
let nativeCreated = false;
let ledgerTouched = false;
let baselineTotals;
let sourceTotals;
const totals = () => ({ ...store.database.prepare(sql.totals).get() });
const sourceEventTotals = () => ({ ...store.database.prepare(sql.totals + ' WHERE source_path = ?').get(logical) });
async function sync(label) {
  const started = performance.now();
  const status = await store.sync();
  const row = { label, ms: performance.now() - started, updatedFileCount: status.updatedFileCount };
  result.syncs.push(row);
  assert.equal(store.perfState().state, 'ready');
  assert.deepEqual(store.perfState().sourceWarnings, []);
  assert.equal(store.requestTimingDirtyThreadCount(), 0);
  return status;
}
function checkPublished(publishedCount) {
  const samples = store.database.prepare(sql.samples).all(logical).map(row => ({ ...row }));
  const check = {
    publishedCount, eventTotals: totals(), sourceEventTotals: sourceEventTotals(),
    dirtyThreadCount: store.requestTimingDirtyThreadCount(), samples, responses: [],
  };
  result.checks.push(check);
  assert.deepEqual(check.eventTotals, baselineTotals, 'ledger must preserve all five event token components');
  assert.deepEqual(check.sourceEventTotals, sourceTotals, 'native event components must remain unchanged');
  assert.equal(check.dirtyThreadCount, 0);
  assert.equal(samples.length, requests.length);
  const byKey = new Map(samples.map(row => [row.sample_key, row]));
  assert.equal(byKey.size, requests.length);
  for (const request of requests) {
    const published = request.index < publishedCount;
    const sample = byKey.get(request.sampleKey);
    assert.ok(sample, 'exact turn sample must exist: ' + request.sampleKey);
    const decoded = decodePerfSample(sample);
    // The frozen identity is the JSON tuple; session_id is not a thread identity contract.
    assert.deepEqual(JSON.parse(decoded.sampleKey), ['codex', home.id, threadId, request.turnId]);
    assert.equal(codexSampleThreadId(decoded), threadId);
    assert.equal(decoded.sourcePath, logical);
    assert.equal(decoded.outputTokens, request.output);
    assert.equal(decoded.requestCount, 1);
    assert.equal(decoded.durationMs, published ? request.durationMs : null);
    const query = { homeId: home.id, threadId, turnId: request.turnId, responseId: request.responseId };
    const lookup = store.lookupRequestTiming(query);
    const evidence = store.database.prepare(sql.evidence).all(home.id, request.responseId).map(row => ({ ...row }));
    const links = store.database.prepare(sql.links).all(home.id, request.responseId).map(row => ({ ...row }));
    check.responses.push({ query, lookup, evidence, links });
    assert.deepEqual(lookup, published ? {
      state: 'available', durationMs: request.durationMs,
      reportedOutputTokens: request.output, requestedModel: 'gpt-6-sol',
    } : { state: 'missing', durationMs: null, reportedOutputTokens: null, requestedModel: '' });
    assert.deepEqual(evidence, published ? [{
      home_id: home.id, response_id: request.responseId, evidence_origin: MAGPIE_TIMING_ORIGIN,
      requested_model: 'gpt-6-sol', reported_output_tokens: request.output,
      duration_ms: request.durationMs, status: 'completed',
    }] : []);
    assert.deepEqual(links, published ? [{ home_id: home.id, response_id: request.responseId, thread_id: threadId }] : []);
  }
  check.verified = true;
  save();
  console.log(JSON.stringify({ publishedCount, verified: true }));
  return samples;
}
try {
  await fsp.copyFile(frozen.database, databaseFile, fs.constants.COPYFILE_EXCL);
  databaseCopied = true;
  const options = { ...frozen.options, databaseFile, automaticDiscoveryEnabled: false, pricingRefreshSchedulerEnabled: false };
  await loadPricingFile(options);
  store = new AfterStore(options);
  await store.open();
  await sync('catchup');
  assert.equal((await sync('settle-0')).updatedFileCount, 0);
  assert.equal((await sync('settle-1')).updatedFileCount, 0);
  const seedTotals = totals();
  const timestamp = '2026-10-26T15:00:00.000Z';
  const rows = [{ timestamp, type: 'session_meta', payload: { id: threadId, session_id: threadId, source: 'cli', originator: 'codex-tui' } }];
  const cumulative = { total_tokens: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  for (const request of requests) {
    const usage = {
      total_tokens: request.input + request.output, input_tokens: request.input,
      cached_input_tokens: request.cached, output_tokens: request.output, reasoning_output_tokens: request.reasoning,
    };
    for (const key of Object.keys(cumulative)) cumulative[key] += usage[key];
    rows.push(
      { timestamp, type: 'turn_context', payload: { thread_id: threadId, turn_id: request.turnId, model: 'gpt-6-sol', effort: 'high' } },
      { timestamp, type: 'token_usage_record', payload: { thread_id: threadId, turn_id: request.turnId, response_id: request.responseId, usage } },
      { timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { ...cumulative } } } },
      { timestamp, type: 'event_msg', payload: { type: 'task_complete', thread_id: threadId, turn_id: request.turnId } },
    );
  }
  await fsp.mkdir(path.dirname(native), { recursive: true });
  const fd = fs.openSync(native, 'wx');
  nativeCreated = true;
  try { fs.writeFileSync(fd, rows.map(row => JSON.stringify(row)).join('\n') + '\n'); }
  finally { fs.closeSync(fd); }
  assert.equal((await sync('native-prime')).updatedFileCount, 1);
  sourceTotals = sourceEventTotals();
  const expectedNative = {
    total: cumulative.total_tokens, input: cumulative.input_tokens, cached: cumulative.cached_input_tokens,
    output: cumulative.output_tokens, reasoning: cumulative.reasoning_output_tokens,
  };
  assert.deepEqual(sourceTotals, expectedNative);
  baselineTotals = totals();
  for (const key of Object.keys(expectedNative)) assert.equal(baselineTotals[key] - seedTotals[key], expectedNative[key]);
  result.seedTotals = seedTotals;
  result.baselineTotals = baselineTotals;
  result.nativeTotals = sourceTotals;
  checkPublished(0);
  let samples;
  for (const request of requests) {
    ledgerTouched = true;
    await fsp.appendFile(ledger, JSON.stringify({
      agent: 'codex', provider: 'codex', req: 'codex/gpt-6-sol', model: 'gpt-6-sol',
      response_id: request.responseId, status: 200, ms: request.durationMs, out: request.output,
      stop: 'completed', ep: '/backend-api/codex/responses',
    }) + '\n');
    assert.equal((await sync('ledger-' + request.index)).updatedFileCount, 0);
    samples = checkPublished(request.index + 1);
  }
  const reference = {
    n: requests.length, outputTokens: requests.reduce((sum, request) => sum + request.output, 0),
    durationMs: requests.reduce((sum, request) => sum + request.durationMs, 0),
  };
  const aggregate = { ...store.database.prepare(sql.aggregate).get(logical) };
  const decoded = samples.map(decodePerfSample);
  const summary = store.buildPerfSummaryForRange({ preset: 'all', start: null, end: null }, [], false, {
    perfState: store.perfState(), samples: decoded, identities: decoded,
    knownSources: [{ kind: 'codex', homeId: home.id }], unsupportedSources: [],
  });
  result.finalSourcePerf = { reference, aggregate, summary };
  assert.deepEqual(aggregate, reference, 'independent fixture reference versus actual SQL');
  assert.equal(summary.ready, true);
  assert.equal(summary.groups.length, 1);
  assert.deepEqual({ n: summary.groups[0].n, ...summary.groups[0].sums }, reference);
  assert.equal(summary.models.length, 1);
  assert.equal(summary.models[0].n, reference.n);
  assert.equal(summary.models[0].averageTps, reference.outputTokens * 1000 / reference.durationMs);
  result.completed = true;
} catch (error) {
  result.failure = { message: error.message, stack: error.stack };
  save();
  throw error;
} finally {
  try { store?.close(); }
  finally {
    // Main's outer exact restore/check owns restoration of frozen timestamps.
    if (ledgerTouched) fs.truncateSync(ledger, ledgerSize);
    if (nativeCreated) fs.rmSync(native, { force: true });
    if (databaseCopied) for (const suffix of ['', '-wal', '-shm']) fs.rmSync(databaseFile + suffix, { force: true });
    result.finishedAt = new Date().toISOString();
    save();
  }
}



