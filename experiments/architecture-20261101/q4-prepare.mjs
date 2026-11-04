import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CELLS, Q4_ROOT, Q4_VARIANTS, ROOT, coldMatrix, inside, versionSpec } from './q3-benchmark-support.mjs';

export async function prepareQ4(label, { planOnly = false, prepare, datasets, seedDirectories } = {}) {
  const trials = coldMatrix(label, 'q4'), base = path.join(Q4_ROOT, label);
  const manifest = { schemaVersion: 1, generation: 'q4', label, base, prepared: false,
    minimumColdRuns: 8, maximumColdRuns: 12, pageCells: 4, pageRoundsPerSource: 10, pageAppends: 80,
    spreadRule: 'abs(rep1-rep2)/min(rep1,rep2) > 0.05 requires rep3; at most one supplement per group.',
    versions: Q4_VARIANTS.map(variant => versionSpec(variant, { generation: 'q4' })), datasets: {}, trials,
    page: CELLS.flatMap(cell => Q4_VARIANTS.map(variant => ({ cell, variant,
      args: ['--generation','q4','--label',label,'--cell',cell,'--variant',variant,'--mode','page','--rounds','10',
        '--prepared-result',path.join(base,'cold',cell,variant,'rep-2/result.json')],
      note: 'Use analysis-cold.json pageSeeds after all cold groups complete; rep3 replaces rep2 only when required.' }))) };
  if (planOnly) return manifest;
  // A completion manifest is published only after every hard link (including reserves) exists: links change ctime.
  await mkdir(base);
  const tools = prepare ? { prepareScale: prepare } : await import('./b2-page-diagnostic.mjs');
  const loaded = {};
  for (const scale of ['1x','10x']) {
    const file = path.join(ROOT,'output/architecture-20261103/growth-baseline',scale,'dataset.json');
    const text = datasets?.[scale] ? JSON.stringify(datasets[scale]) : await readFile(file,'utf8');
    loaded[scale] = JSON.parse(text);
    manifest.datasets[scale] = { file, sha256: createHash('sha256').update(text).digest('hex'),
      inputs: loaded[scale].inputs.map(input => ({ path:input.path, sha256:input.sha256, sourceBytes:input.sourceBytes, role:input.role, kind:input.kind })) };
  }
  const mutableInodes = new Set();
  for (const trial of trials) {
    const scale = trial.cell.startsWith('10') ? '10x' : '1x';
    await mkdir(trial.directory, { recursive:true });
    const seed = seedDirectories?.[scale] ?? path.join(ROOT,'output/architecture-20261103/b2/page-e1-final-v8',scale,'.codex-usage');
    const prepared = await tools.prepareScale(loaded[scale], path.join(trial.directory,'fixture'), seed);
    assert.ok(inside(trial.directory, prepared.databaseFile));
    assert.ok(inside(trial.directory, prepared.home));
    await assert.rejects(stat(prepared.databaseFile), error => error.code === 'ENOENT');
    for (const kind of ['codex','dsh']) {
      const selected = prepared.selected[kind];
      assert.ok(inside(prepared.home, selected.targetPath));
      const info = await stat(selected.targetPath, { bigint:true });
      assert.equal(info.nlink, 1n, 'Append targets must be independent copies.');
      const inode = `${info.dev}:${info.ino}`;
      assert.equal(mutableInodes.has(inode), false);mutableInodes.add(inode);
    }
    await writeFile(trial.preparedFile, JSON.stringify(prepared,null,2)+'\n', { flag:'wx', flush:true });
    console.log(JSON.stringify({cell:trial.cell,variant:trial.variant,rep:trial.rep,reserve:trial.reserve,prepared:true}));
  }
  manifest.prepared = true;manifest.completedAt = new Date().toISOString();
  await writeFile(path.join(base,'matrix.json'), JSON.stringify(manifest,null,2)+'\n', { flag:'wx', flush:true });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === '--plan-only'));
  console.log(JSON.stringify(await prepareQ4(process.argv[2], { planOnly:process.argv.includes('--plan-only') }),null,2));
}
