import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const Q3_ROOT = path.join(ROOT, 'output/architecture-20261104/q3');
export const VARIANTS = ['preq2', 'baseline', 'candidate'];
export const CELLS = ['1x-sha', '10x-sha'];
export const BUSINESS_FIELDS = ['totals','costEstimate','eventCount','sessionCount','homeCount','timeline','timelineError','channels','models'];

export function versionSpec(variant) {
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
  assert.ok(['q1', 'q2', 'q3'].includes(generation));
  const label = arg('--label');
  assert.match(label || '', new RegExp('^' + generation + '-[a-z0-9-]+$'));
  const cell = arg('--cell', '1x-sha');
  assert.match(cell, generation === 'q3' ? /^(1|10)x-sha$/ : /^(1|10)x-(sha|native)$/);
  const variant = arg('--variant', 'candidate');
  assert.ok((generation === 'q3' ? VARIANTS : ['baseline','candidate']).includes(variant));
  const mode = arg('--mode', generation === 'q3' ? 'cold-only' : 'full');
  assert.ok(['full','cold-only','page'].includes(mode));
  const rounds = Number(arg('--rounds', generation === 'q3' ? '20' : '3'));
  assert.ok(Number.isSafeInteger(rounds) && rounds > 0 && rounds <= 20);
  const preparedResult = arg('--prepared-result');
  if (mode === 'page') assert.ok(preparedResult, '--mode page requires --prepared-result');
  if (generation === 'q3') {
    assert.notEqual(mode, 'full', 'Q3 uses separate cold-only and page runs.');
    if (mode === 'page') assert.notEqual(variant, 'preq2', 'Q3 page cells compare baseline/candidate only.');
    if (mode === 'cold-only') assert.equal(preparedResult, undefined, 'Cold runs require their independent empty fixture.');
  }
  const rep = Number(arg('--rep', '1'));
  assert.ok(Number.isSafeInteger(rep) && rep >= 1 && rep <= 3);
  if (generation === 'q3' && mode === 'page') assert.equal(argv.includes('--rep'), false, 'Page results have no cold rep.');
  const base = path.join(ROOT, generation === 'q3' ? 'output/architecture-20261104' : 'output/architecture-20261103', generation, label);
  const trial = generation === 'q3'
    ? path.join(base, mode === 'page' ? 'page' : 'cold', cell, variant, ...(mode === 'page' ? [] : ['rep-' + rep]))
    : path.join(base, cell, variant);
  return { generation, label, cell, scale: cell.startsWith('10') ? '10x' : '1x', variant, mode,
    rep: generation === 'q3' && mode !== 'page' ? rep : null, rounds, preparedResult, base, trial };
}

export function coldMatrix(label) {
  const trials = [];
  for (const cell of CELLS) for (const variant of VARIANTS) for (const rep of [1,2,3]) {
    const options = runOptions(['--generation','q3','--label',label,'--cell',cell,'--variant',variant,'--rep',String(rep)]);
    trials.push({ cell, variant, rep, reserve: rep === 3, directory: options.trial,
      preparedFile: path.join(options.trial, 'prepared.json'), resultFile: path.join(options.trial, 'result.json'),
      args: ['--generation','q3','--label',label,'--cell',cell,'--variant',variant,'--mode','cold-only','--rep',String(rep)] });
  }
  return trials;
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
