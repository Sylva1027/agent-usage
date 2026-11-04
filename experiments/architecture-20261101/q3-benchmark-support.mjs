import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const Q3_ROOT = path.join(ROOT, 'output/architecture-20261104/q3');
export const Q4_ROOT = path.join(ROOT, 'output/architecture-20261104/q4');
export const Q5_ROOT = path.join(ROOT, 'output/architecture-20261104/q5');
export const Q5_CELLS = ['1x-sha', '10x-sha', '1x-native', '10x-native'];
export const VARIANTS = ['preq2', 'baseline', 'candidate'];
export const Q4_VARIANTS = ['baseline', 'candidate'];
export const CELLS = ['1x-sha', '10x-sha'];
export const BUSINESS_FIELDS = ['totals','costEstimate','eventCount','sessionCount','homeCount','timeline','timelineError','channels','models'];

export function versionSpec(variant, { generation = 'q3' } = {}) {
  if (generation === 'q5') {
    assert.ok(Q4_VARIANTS.includes(variant), `Unknown Q5 variant: ${variant}`);
    const directory = variant === 'baseline' ? path.join(Q5_ROOT, 'baseline') : ROOT;
    return { variant, directory, frozen: variant === 'baseline', expectedFiles: 101,
      hashesFile: path.join(Q5_ROOT, 'baseline-hashes.json'),
      nativeHashesFile: path.join(Q5_ROOT, 'baseline-native-hashes.json'),
      nativeBinary: path.join(directory, 'native/windows-source-proof/bin/windows-source-proof.exe') };
  }
  if (generation === 'q4') {
    assert.ok(Q4_VARIANTS.includes(variant), `Unknown Q4 variant: ${variant}`);
    if (variant === 'candidate') return { variant, directory: ROOT, frozen: false };
    const directory = path.join(Q4_ROOT, 'baseline');
    return { variant, directory, hashesFile: path.join(directory, '../baseline-hashes.json'), frozen: true, expectedFiles: 100 };
  }
  assert.ok(VARIANTS.includes(variant), `Unknown Q3 variant: ${variant}`);
  if (variant === 'candidate') return { variant, directory: ROOT, frozen: false };
  const directory = path.join(ROOT, variant === 'preq2' ? 'output/architecture-20261103/q2/baseline' : 'output/architecture-20261104/q3/baseline');
  return { variant, directory, hashesFile: path.join(directory, '../baseline-hashes.json'), frozen: true,
    expectedFiles: variant === 'preq2' ? 98 : 99 };
}

export function inside(directory, file) {
  const relative = path.relative(path.resolve(directory), path.resolve(file));
  return Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function runOptions(argv) {
  const arg = (name, fallback) => {
    const at = argv.indexOf(name);
    if (at < 0) return fallback;
    assert.ok(argv[at + 1] && !argv[at + 1].startsWith('--'), `${name} requires a value`);
    return argv[at + 1];
  };
  const generation = arg('--generation', 'q1');
  assert.ok(['q1', 'q2', 'q3', 'q4', 'q5'].includes(generation));
  const modern = generation === 'q3' || generation === 'q4' || generation === 'q5';
  const label = arg('--label');
  assert.match(label || '', new RegExp('^' + generation + '-[a-z0-9-]+$'));
  const cell = arg('--cell', '1x-sha');
  assert.match(cell, modern && generation !== 'q5' ? /^(1|10)x-sha$/ : /^(1|10)x-(sha|native)$/);
  const variant = arg('--variant', 'candidate');
  assert.ok((generation === 'q3' ? VARIANTS : ['baseline','candidate']).includes(variant));
  const mode = arg('--mode', modern ? 'cold-only' : 'full');
  assert.ok(['full','cold-only','page',...(generation==='q5'?['setup-only']:[])].includes(mode));
  const rounds = Number(arg('--rounds', ['q4','q5'].includes(generation) ? '10' : generation === 'q3' ? '20' : '3'));
  assert.ok(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 20);
  const preparedResult = arg('--prepared-result');
  if (mode === 'page' && generation !== 'q5') assert.ok(preparedResult, '--mode page requires --prepared-result');
  if (modern) {
    assert.notEqual(mode, 'full', `${generation.toUpperCase()} uses separate cold-only and page runs.`);
    if (mode === 'page') assert.notEqual(variant, 'preq2', 'Q3 page cells compare baseline/candidate only.');
    if (mode === 'cold-only') assert.equal(preparedResult, undefined, 'Cold runs require their independent empty fixture.');
  }
  if (generation === 'q4') assert.equal(rounds, 10, 'Q4 requires ten appends per source in each page cell.');
  if (generation === 'q5') {
    assert.equal(rounds, 10, 'Q5 requires ten appends per source in each page cell.');
    assert.equal(preparedResult, undefined, 'Q5 uses canonical-home fixtures; Q4 warm seeds stay untouched.');
    if (mode === 'cold-only') {
      assert.equal(variant, 'candidate', 'Q5 cold regressions are candidate-only.');
      assert.ok(CELLS.includes(cell), 'Q5 cold regressions use SHA.');
    }
    if (mode === 'setup-only')assert.ok(variant==='baseline'&&cell.endsWith('native'),'Q5 native seed setup is baseline-only.');
  }
  const rep = Number(arg('--rep', '1'));
  assert.ok(Number.isSafeInteger(rep) && rep >= 1 && rep <= 3);
  if (generation === 'q5') assert.equal(argv.includes('--rep'), false, 'Q5 has two independent cold regressions, without repeats.');
  if (modern && mode === 'page') assert.equal(argv.includes('--rep'), false, 'Page results have no cold rep.');
  const base = path.join(ROOT, modern ? 'output/architecture-20261104' : 'output/architecture-20261103', generation, label);
  const trial = modern
    ? path.join(base, mode === 'page' ? 'page' : mode === 'setup-only' ? 'setup' : 'cold', cell, variant, ...(mode === 'page' || generation === 'q5' ? [] : ['rep-' + rep]))
    : path.join(base, cell, variant);
  return { generation, label, cell, scale: cell.startsWith('10') ? '10x' : '1x', variant, mode,
    rep: modern && mode !== 'page' && generation !== 'q5' ? rep : null, rounds, preparedResult, base, trial };
}

export function coldMatrix(label, generation = 'q3') {
  assert.ok(['q3', 'q4'].includes(generation));
  const trials = [];
  for (const cell of CELLS) for (const variant of generation === 'q4' ? Q4_VARIANTS : VARIANTS) for (const rep of [1,2,3]) {
    const options = runOptions(['--generation',generation,'--label',label,'--cell',cell,'--variant',variant,'--rep',String(rep)]);
    trials.push({ cell, variant, rep, reserve: rep === 3, directory: options.trial,
      preparedFile: path.join(options.trial, 'prepared.json'), resultFile: path.join(options.trial, 'result.json'),
      args: ['--generation',generation,'--label',label,'--cell',cell,'--variant',variant,'--mode','cold-only','--rep',String(rep)] });
  }
  return trials;
}

export function assertQ4Matrix(matrix, label) {
  assert.equal(matrix.generation, 'q4');
  assert.equal(matrix.label, label);
  assert.equal(matrix.prepared, true, 'Prepare all twelve Q4 mirrors, including reserves, before certification.');
  assert.deepEqual(matrix.trials, coldMatrix(label, 'q4'), 'Q4 matrix must contain exactly the twelve independent mirrors.');
}

export async function finalQ4Cold(base, cell, variant) {
  assert.ok(CELLS.includes(cell) && Q4_VARIANTS.includes(variant));
  const runs = [];
  for (const rep of [1,2,3]) {
    const file = path.join(base, 'cold', cell, variant, `rep-${rep}`, 'result.json');
    let run;
    try { run = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    assert.equal(run.generation, 'q4');assert.equal(run.mode, 'cold-only');
    assert.equal(run.cell, cell);assert.equal(run.variant, variant);assert.equal(run.rep, rep);
    assert.equal(run.passed, true);assert.equal(run.appends.length, 0);
    assert.deepEqual(run.sourceBefore, run.sourceAfter);
    runs.push({ file, run, rep, wallMs: run.first.endedAtMs - run.first.startedAtMs });
  }
  const decision = coldDecision(runs);
  assert.ok(decision.complete, 'Q4 page seed requires a completed cold group, including rep3 when spread exceeds 5%.');
  assert.ok(decision.supplementRequired || !runs.some(run => run.rep === 3), 'Q4 rep3 is conditional, not an extra scheduled run.');
  return runs.find(run => run.rep === (decision.supplementRequired ? 3 : 2));
}

export async function q4PageSeed(base,cell,variant,retry=false) {
  const final=await finalQ4Cold(base,cell,variant);
  if(!retry)return final;
  const file=path.join(base,'cold',cell,variant,'rep-1/result.json'),run=JSON.parse(await readFile(file,'utf8'));
  assert.equal(run.passed,true);assert.equal(run.generation,'q4');assert.equal(run.mode,'cold-only');assert.equal(run.rep,1);
  assert.equal(run.cell,cell);assert.equal(run.variant,variant);assert.equal(run.appends.length,0);
  assert.equal(run.datasetSha256,final.run.datasetSha256);
  assert.deepEqual(run.sourceBefore,run.sourceAfter);assert.deepEqual(run.sourceBefore,final.run.sourceBefore);
  assertSeedParity(run.first.all,final.run);
  return {file,run,rep:1,wallMs:run.first.endedAtMs-run.first.startedAtMs};
}

export function coldDecision(runs) {
  assert.ok(runs.length <= 3);
  assert.equal(new Set(runs.map(run => run.rep)).size, runs.length);
  for (const run of runs) assert.ok([1,2,3].includes(run.rep) && Number.isFinite(run.wallMs) && run.wallMs > 0);
  const first = runs.find(run => run.rep === 1), second = runs.find(run => run.rep === 2);
  const spread = first && second ? Math.abs(first.wallMs-second.wallMs) / Math.min(first.wallMs,second.wallMs) : null;
  const supplementRequired = spread !== null && spread > 0.05;
  return { spreadFraction: spread, supplementRequired,
    complete: Boolean(first && second && (!supplementRequired || runs.some(run => run.rep === 3))),
    nextRep: !first ? 1 : !second ? 2 : supplementRequired && !runs.some(run => run.rep === 3) ? 3 : null };
}

export function publishedAll(run) {
  return run.published?.firstAll ?? run.reopen?.firstAll ?? (run.mode === 'cold-only' ? run.first?.all : undefined);
}

export function coldStageFailures(rows) {
  const spans=rows.filter(row=>row.type==='span'),byId=new Map(spans.map(row=>[row.spanId,row]));
  const recovered=[],unhandled=[];
  for(const row of spans.filter(row=>row.error)) {
    const parent=byId.get(row.parentSpanId);
    const retry=parent&&spans.find(next=>next.parentSpanId===parent.spanId&&next.label==='store.replaceFile'
      &&!next.error&&Number.isFinite(next.parsedBytes)&&next.parsedBytes>=0
      &&next.start>=row.start+row.duration&&next.start+next.duration<=parent.start+parent.duration);
    if(row.label==='source.streamUsageFileEvents'&&/^SOURCE_PROGRESS_UNSUPPORTED:/.test(row.error)
      &&parent?.label==='store.replaceFile'&&!parent.error&&retry)recovered.push({...row,retrySpanId:retry.spanId});
    else unhandled.push(row);
  }
  return {recovered,unhandled};
}

export function assertSeedParity(actual, seed) {
  const expected = publishedAll(seed);
  assert.ok(expected?.body?.summary, 'Seed needs a successfully published page snapshot.');
  assert.equal(actual.eventCount, expected.eventCount);
  assert.equal(actual.total, expected.total);
  for (const key of BUSINESS_FIELDS) assert.deepEqual(actual.body.summary[key], expected.body.summary[key], `continuation ${key}`);
  return { fields: BUSINESS_FIELDS.length, passed: true };
}

export function normalizeBody(value, run, final = false) {
  const ids = new Map((run.first.all.body.metadata?.homes || []).map(home => [home.id, home.kind + ':' + path.relative(run.prepared.home,home.path)]));
  function walk(item) {
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item)
      .filter(([key]) => !['generatedAt','asOf','modelUsageAsOf'].includes(key) && !(final && ['modelLastSeen','activeHarnessModels'].includes(key)))
      .map(([key, child]) => [key, walk(child)]));
    if (typeof item === 'string') return ids.get(item) ?? item.split(run.prepared.home).join('<home>');
    return item;
  }
  return walk(value);
}
