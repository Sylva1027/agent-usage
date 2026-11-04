import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CELLS, Q3_ROOT, ROOT, coldMatrix, versionSpec } from './q3-benchmark-support.mjs';

export async function prepareQ3(label, { planOnly = false, prepare, datasets, seedDirectories } = {}) {
  const trials = coldMatrix(label);
  const base = path.join(Q3_ROOT, label);
  const manifest = { schemaVersion: 1, generation: 'q3', label, base, prepared: false,
    minimumColdRuns: 12, maximumColdRuns: 18, pageCells: 4, pageRoundsPerSource: 20, pageAppends: 160,
    spreadRule: 'abs(rep1-rep2)/min(rep1,rep2) > 0.05 requires rep3; at most one supplement per group.',
    versions: ['preq2','baseline','candidate'].map(versionSpec), datasets:{}, trials,
    page: CELLS.flatMap(cell => ['baseline','candidate'].map(variant => ({ cell, variant,
      args: ['--generation','q3','--label',label,'--cell',cell,'--variant',variant,'--mode','page','--rounds','20',
        '--prepared-result',path.join(base,'cold',cell,variant,'rep-2/result.json')],
      note: 'Use the last completed cold rep (rep3 if required); the page run validates its published starting state.' }))) };
  if (planOnly) return manifest;
  await mkdir(base);
  const tools = prepare ? { prepareScale: prepare } : await import('./b2-page-diagnostic.mjs');
  const loaded={};
  for(const scale of ['1x','10x']){
    const file=path.join(ROOT,'output/architecture-20261103/growth-baseline',scale,'dataset.json');
    const text=datasets?.[scale]?JSON.stringify(datasets[scale]):await readFile(file,'utf8');
    loaded[scale]=JSON.parse(text);
    manifest.datasets[scale]={file,sha256:createHash('sha256').update(text).digest('hex'),
      inputs:loaded[scale].inputs.map(input=>({path:input.path,sha256:input.sha256,sourceBytes:input.sourceBytes,role:input.role,kind:input.kind}))};
  }
  // All 18 mirrors, including reserves, must exist before the first certification.
  for (const trial of trials) {
    const scale = trial.cell.startsWith('10') ? '10x' : '1x';
    const dataset = loaded[scale];
    await mkdir(trial.directory, { recursive: true });
    const seed = seedDirectories?.[scale] ?? path.join(ROOT,'output/architecture-20261103/b2/page-e1-final-v8',scale,'.codex-usage');
    const prepared = await tools.prepareScale(dataset, path.join(trial.directory,'fixture'), seed);
    await assert.rejects(stat(prepared.databaseFile), error => error.code === 'ENOENT');
    await writeFile(trial.preparedFile, JSON.stringify(prepared,null,2)+'\n', { flag: 'wx', flush: true });
    console.log(JSON.stringify({ cell:trial.cell,variant:trial.variant,rep:trial.rep,reserve:trial.reserve,prepared:true }));
  }
  manifest.prepared = true;
  manifest.completedAt = new Date().toISOString();
  await writeFile(path.join(base,'matrix.json'), JSON.stringify(manifest,null,2)+'\n', { flag:'wx',flush:true });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv.length === 3 || (process.argv.length === 4 && process.argv[3] === '--plan-only'));
  console.log(JSON.stringify(await prepareQ3(process.argv[2], { planOnly:process.argv.includes('--plan-only') }),null,2));
}
