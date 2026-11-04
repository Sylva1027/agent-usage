import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Q5_CELLS, Q5_ROOT, Q4_VARIANTS, ROOT, runOptions, versionSpec } from './q3-benchmark-support.mjs';

export function q5Trials(label) {
  const trial = (cell,variant,mode) => {
    const args=['--generation','q5','--label',label,'--cell',cell,'--variant',variant,'--mode',mode];
    const options=runOptions(args);
    return {cell,variant,mode,directory:options.trial,preparedFile:path.join(options.trial,'prepared.json'),
      resultFile:path.join(options.trial,'result.json'),args};
  };
  return [...Q5_CELLS.flatMap(cell=>Q4_VARIANTS.map(variant=>trial(cell,variant,'page'))),
    ...['1x-sha','10x-sha'].map(cell=>trial(cell,'candidate','cold-only')),
    ...['1x-native','10x-native'].map(cell=>trial(cell,'baseline','setup-only'))];
}

export function nativeEligibility(cell, availability) {
  if (!cell.endsWith('-native')) return {eligible:true,status:'sha',reason:'SHA requested'};
  const evidence=availability?.[cell];
  if (evidence?.available===true) return {eligible:true,status:'available',evidence};
  return {eligible:false,status:evidence?.available===false?'ineligible':'pending',
    reason:evidence?.reason || 'Main native preflight pending',evidence};
}

export async function verifyQ5Frozen() {
  const version=versionSpec('baseline',{generation:'q5'});
  const hashes=JSON.parse(await readFile(version.hashesFile,'utf8'));
  const nativeHashes=JSON.parse(await readFile(version.nativeHashesFile,'utf8'));
  assert.equal(Object.keys(hashes).length,101);
  assert.ok(Object.hasOwn(nativeHashes,'native/windows-source-proof/bin/windows-source-proof.exe'));
  for (const [relative,expected] of Object.entries({...hashes,...nativeHashes})) {
    assert.match(expected,/^[a-f0-9]{64}$/);
    assert.ok(!relative.split(/[\\/]/).includes('..')&&!path.isAbsolute(relative));
    const actual=createHash('sha256').update(await readFile(path.join(version.directory,relative))).digest('hex');
    assert.equal(actual,expected,`Frozen Q5 file changed: ${relative}`);
  }
  return {hashes,nativeHashes,nativeBinary:version.nativeBinary};
}

export async function prepareQ5(label, {planOnly=true,nativeAvailability={},datasets,seedDirectories,
  nativeRoot=path.join(os.tmpdir(),'codex-'+label,'canonical'),preflightFile,
  prepare,pricingCapture}={}) {
  const trials=q5Trials(label),base=path.join(Q5_ROOT,label);
  if(preflightFile) {
    const receipt=JSON.parse(await readFile(preflightFile,'utf8'));
    const native=receipt.results.find(row=>row.volume==='C');
    const begin=native?.steps.find(row=>row.op==='begin');
    const verified=native?.steps.find(row=>row.op==='append-verify');
    for(const cell of Q5_CELLS.filter(cell=>cell.endsWith('native')))nativeAvailability[cell]={
      available:begin?.available===true&&verified?.ok===true,reason:begin?.reason??verified?.reason,
      receipt:path.resolve(preflightFile),volume:'C'};
  }
  const canonical=Q5_CELLS.map(cell=>({id:cell,scale:cell.startsWith('10')?'10x':'1x',
    proofMode:cell.endsWith('native')?'native':'sha',volume:cell.endsWith('native')?'C':'E',
    directory:path.join(cell.endsWith('native')?nativeRoot:path.join(base,'canonical'),cell),
    seedDatabaseFile:path.join(base,'seeds',cell,'usage-index.sqlite')}));
  const manifest={schemaVersion:5,generation:'q5',label,base,prepared:false,planOnly:true,
    pageCells:8,pageRoundsPerSource:10,pageAppends:160,coldRegressions:2,
    canonicalInitializations:4,formalInitializations:2,setupInitializations:2,canonical,
    heaps:{gatewayMb:512,executorMb:224,executorSemiSpaceMb:4},
    versions:Q4_VARIANTS.map(variant=>versionSpec(variant,{generation:'q5'})),
    pricing:{file:path.join(base,'captured-pricing.json'),catalogSha256:null,requiredFrom:'process-start'},
    fixtureSeeding:{status:'confirmed',method:'four-canonical-homes-sequential-cells',
      reason:'Private SQLite backups retain canonical home/source IDs; restore and recertify only two selected inputs per page cell.'},
    nativeAvailability,trials:trials.filter(row=>row.mode==='cold-only'),
    setup:trials.filter(row=>row.mode==='setup-only'),
    initializations:trials.filter(row=>row.mode!=='page').map(row=>({...row,canonicalId:row.cell,
      accounting:row.mode==='cold-only'?'formal-cold-regression':'setup-native-initialization'})),
    page:trials.filter(row=>row.mode==='page').map(row=>({...row,native:nativeEligibility(row.cell,nativeAvailability)}))};
  if(planOnly)return manifest;
  await verifyQ5Frozen();
  await mkdir(base);
  const fixture=await import('./q5-fixture.mjs');
  manifest.pricing=pricingCapture??await fixture.captureQ5Pricing(base,seedDirectories?.['1x']
    ??path.join(ROOT,'output/architecture-20261103/b2/page-e1-final-v8/1x/.codex-usage'));
  manifest.datasets={};
  const loaded={};
  for(const scale of ['1x','10x']) {
    const file=path.join(ROOT,'output/architecture-20261103/growth-baseline',scale,'dataset.json');
    const text=datasets?.[scale]?JSON.stringify(datasets[scale]):await readFile(file,'utf8');
    loaded[scale]=JSON.parse(text);manifest.datasets[scale]={file,sha256:createHash('sha256').update(text).digest('hex')};
  }
  const prepareScale=prepare??(await import('./b2-page-diagnostic.mjs')).prepareScale;
  for(const entry of canonical) {
    if(!nativeEligibility(entry.id,nativeAvailability).eligible)continue;
    const seed=seedDirectories?.[entry.scale]??path.join(ROOT,'output/architecture-20261103/b2/page-e1-final-v8',entry.scale,'.codex-usage');
    const prepared=await fixture.prepareCanonical(entry,loaded[entry.scale],seed,{prepareScale});
    entry.prepared=prepared;
    for(const trial of trials.filter(row=>row.cell===entry.id)) {
      await mkdir(trial.directory,{recursive:true});
      const cellPrepared=await fixture.prepareCellState(prepared,trial.directory);
      await writeFile(trial.preparedFile,JSON.stringify(cellPrepared,null,2)+'\n',{flag:'wx',flush:true});
    }
  }
  manifest.prepared=true;manifest.planOnly=false;manifest.completedAt=new Date().toISOString();
  await writeFile(path.join(base,'matrix.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',flush:true});
  return manifest;
}

export function assertQ5Matrix(matrix,label) {
  assert.equal(matrix.generation,'q5');assert.equal(matrix.label,label);
  assert.equal(matrix.base,path.join(Q5_ROOT,label));
  const plan=q5Trials(label),strip=row=>Object.fromEntries(Object.entries(row).filter(([key])=>key!=='native'));
  assert.deepEqual(matrix.trials,plan.filter(row=>row.mode==='cold-only'));
  assert.deepEqual(matrix.setup,plan.filter(row=>row.mode==='setup-only'));
  assert.deepEqual(matrix.page.map(strip),plan.filter(row=>row.mode==='page'));
  assert.equal(matrix.prepared,true,'Q5 fixture seeding/rebase is not complete.');
  assert.equal(matrix.fixtureSeeding?.status,'confirmed');
  assert.match(matrix.pricing?.catalogSha256||'',/^[a-f0-9]{64}$/);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(3),at=args.indexOf('--preflight');
  assert.ok(args.every((value,index)=>['--plan-only','--prepare','--preflight'].includes(value)||index===at+1&&at>=0));
  assert.ok(!args.includes('--prepare')||!args.includes('--plan-only'));
  console.log(JSON.stringify(await prepareQ5(process.argv[2],{planOnly:!args.includes('--prepare'),preflightFile:at>=0?args[at+1]:undefined}),null,2));
}
