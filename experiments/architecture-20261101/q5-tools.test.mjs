import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { Q5_ROOT, ROOT, inside, runOptions, versionSpec } from './q3-benchmark-support.mjs';
import { assertQ5Matrix, nativeEligibility, prepareQ5, q5Trials, verifyQ5Frozen } from './q5-prepare.mjs';
import { appendQ5AndPaint, boundedTrace, catalogDigest, createQ5Hook, observeQ5Delivery,
  q5AppendEvidence, q5DiagnosticHook, q5PrivateRows, readCapturedPricing } from './q5-summary-hook.mjs';
import { getDefaultPricingCatalog, getPricingCatalog, setPricingCatalog } from '../../src/pricing.js';

const here=path.join(ROOT,'experiments/architecture-20261101');
const label=name=>`q5-tools-selfcheck-${process.pid}-${name}`;
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));};
function cli(file,args,env={}) {
  return spawnSync(process.execPath,[path.join(here,file),...args],{cwd:ROOT,env:{...process.env,...env},encoding:'utf8',windowsHide:true,timeout:20000});
}
async function clean(directory) {
  assert.ok(inside(Q5_ROOT,directory));assert.match(path.basename(directory),/^q5-tools-selfcheck-/);
  await fs.rm(directory,{recursive:true,force:true});
}
async function capture(directory) {
  const catalog=setPricingCatalog(getDefaultPricingCatalog()),file=path.join(directory,'captured-pricing.json');
  await write(file,{catalog});return {pricingFile:file,pricingSha256:catalogDigest(catalog),catalog};
}

test('Q5 plans eight page cells / 160 appends, two formal cold + two setup imports; Q1-4 paths survive',async()=>{
  const name=label('plan'),plan=await prepareQ5(name);
  assert.equal(plan.page.length,8);assert.equal(plan.pageAppends,160);assert.equal(plan.canonical.length,4);
  assert.equal(plan.initializations.length,4);assert.equal(plan.trials.length,2);assert.equal(plan.setup.length,2);
  assert.equal(new Set(q5Trials(name).map(row=>row.directory)).size,12);
  assert.deepEqual(plan.heaps,{gatewayMb:512,executorMb:224,executorSemiSpaceMb:4});
  for(const trial of q5Trials(name)) {
    const options=runOptions(trial.args);assert.equal(options.trial,trial.directory);assert.equal(options.rep,null);assert.equal(options.rounds,10);
    const result=cli('q1-summary-run.mjs',[...trial.args,'--describe']);assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).trial,trial.directory);
  }
  await assert.rejects(fs.stat(plan.base),error=>error.code==='ENOENT');
  assert.throws(()=>assertQ5Matrix(plan,name));
  const ready={...plan,prepared:true,pricing:{catalogSha256:'a'.repeat(64)}};assertQ5Matrix(ready,name);
  for(const generation of ['q1','q2','q3','q4']) {
    const options=runOptions(['--generation',generation,'--label',generation+'-compat']);
    assert.equal(options.rounds,generation==='q4'?10:generation==='q3'?20:3);
    assert.equal(options.mode,['q3','q4'].includes(generation)?'cold-only':'full');
  }
  for(const args of [['--mode','full'],['--rounds','20'],['--rep','1'],['--mode','cold-only','--variant','baseline'],
    ['--mode','cold-only','--cell','1x-native'],['--mode','page','--prepared-result','old-q4-result']])
    assert.throws(()=>runOptions(['--generation','q5','--label',name,...args]));
});

test('all 101 frozen src/public files and seven native files match, baseline helper resolves to frozen binary',async()=>{
  const frozen=await verifyQ5Frozen();assert.equal(Object.keys(frozen.hashes).length,101);assert.equal(Object.keys(frozen.nativeHashes).length,7);
  assert.equal(frozen.nativeBinary,versionSpec('baseline',{generation:'q5'}).nativeBinary);
  const directory=path.join(Q5_ROOT,label('frozen'));
  try {
    const pricing=await capture(directory),hook=createQ5Hook('baseline',directory,pricing);
    const next=()=>{throw Error('must load frozen source');};
    const native=hook.load(pathToFileURL(path.join(ROOT,'src/usage-source-native.js')).href,{},next);
    assert.ok(native.source.includes(JSON.stringify(frozen.nativeBinary)));
    const server=hook.load(pathToFileURL(path.join(ROOT,'src/server.js')).href,{},next);
    assert.ok(server.source.includes(JSON.stringify(path.join(Q5_ROOT,'baseline/public'))));
    for(const variant of ['baseline','candidate']) {
      const code=`await import('./src/server.js');await import('./src/usage-store.js');
        await import('./src/usage-source-proof.js');await import('./src/usage-source-watch.js');
        const {WindowsSourceProof}=await import('./src/usage-source-native.js');new WindowsSourceProof().close();`;
      const child=spawnSync(process.execPath,['--import',pathToFileURL(path.join(here,'q5-summary-hook.mjs')).href,'--input-type=module','-e',code],{
        cwd:ROOT,encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,Q5_VARIANT:variant,Q5_PROOF_MODE:'sha',
          Q5_TRACE_DIR:directory,Q5_PRICING_FILE:pricing.pricingFile,Q5_PRICING_SHA256:pricing.pricingSha256}});
      assert.equal(child.status,0,child.stderr);
    }
  }finally{await clean(directory);}
});

test('shared captured catalog freezes every process from module initialization; production repricing still works separately',async()=>{
  const directory=path.join(Q5_ROOT,label('pricing'));
  try {
    const pricing=await capture(directory);
    await write(pricing.pricingFile,{catalog:pricing.catalog,automaticStatus:{statusVersion:'fixed-self-check'}});
    readCapturedPricing(pricing.pricingFile,pricing.pricingSha256);
    assert.throws(()=>readCapturedPricing(pricing.pricingFile,'0'.repeat(64)),/changed/);
    for(const variant of ['baseline','candidate'])for(const mode of ['sha','native']) {
      const code=`import assert from 'node:assert/strict';
        import {getPricingCatalog,setPricingCatalog,resetPricingCatalog} from './src/pricing.js';
        import {loadPricingFile,refreshAutomaticPricing,getAutomaticPricingStatus} from './src/pricing-store.js';
        const first=getPricingCatalog();await loadPricingFile({pricingFile:'must-not-be-read'});
        setPricingCatalog({...first,usdToCnyRate:99});resetPricingCatalog();
        const result=await refreshAutomaticPricing({pricingFetcher:()=>{throw Error('network forbidden');}});
        assert.equal(result.changed,false);assert.equal(getAutomaticPricingStatus().statusVersion,'fixed-self-check');
        assert.deepEqual(getPricingCatalog(),first);console.log(first.usdToCnyRate);`;
      const child=spawnSync(process.execPath,['--import',pathToFileURL(path.join(here,'q5-summary-hook.mjs')).href,'--input-type=module','-e',code],{
        cwd:ROOT,encoding:'utf8',windowsHide:true,timeout:20000,env:{...process.env,Q5_VARIANT:variant,Q5_PROOF_MODE:mode,
          Q5_TRACE_DIR:directory,Q5_PRICING_FILE:pricing.pricingFile,Q5_PRICING_SHA256:pricing.pricingSha256}});
      assert.equal(child.status,0,child.stderr);assert.equal(Number(child.stdout),pricing.catalog.usdToCnyRate);
    }
    const rows=q5PrivateRows(directory),checks=rows.filter(row=>row.type==='pricing-verified');
    assert.ok(checks.length>=4);assert.ok(checks.every(row=>row.catalogSha256===pricing.pricingSha256));
    const original=getPricingCatalog();setPricingCatalog({...original,usdToCnyRate:original.usdToCnyRate+1});
    assert.equal(getPricingCatalog().usdToCnyRate,original.usdToCnyRate+1);setPricingCatalog(original);
  }finally{await clean(directory);}
});

test('bounded traces retain sync errors, fingerprints/revisions and raw native rejection reasons; SHA fallback never claims fast path',async()=>{
  const directory=path.join(Q5_ROOT,label('trace'));
  try {
    const pricing=await capture(directory);createQ5Hook('candidate',directory,pricing);
    const owner={fingerprint:'facts-7',storeRevision:7};
    const fail=globalThis.__q5Wrap(async()=>{throw Error('retained failure');},'store.syncRound');
    await assert.rejects(fail.call(owner),/retained failure/);
    const rows=q5PrivateRows(directory);assert.ok(rows.some(row=>row.error==='retained failure'&&row.fingerprint==='facts-7'&&row.revision===7));
    const emit=boundedTrace(path.join(directory,'bounded.jsonl'),{},2);for(let n=0;n<5;n++)emit({n});
    const bounded=(await fs.readFile(path.join(directory,'bounded.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(bounded.length,3);assert.equal(bounded[2].type,'trace-truncated');
    emit({type:'span',label:'store.syncRound',fingerprint:'terminal-facts',revision:1968});
    const retained=(await fs.readFile(path.join(directory,'bounded.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(retained.at(-1).fingerprint,'terminal-facts');
    const filtered=path.join(directory,'selected-only');createQ5Hook('candidate',filtered,{...pricing,selectedPaths:['selected']});
    const commit=globalThis.__q5Wrap(function(){return ++this.storeRevision;},'store.commitStoreRevision');
    const replace=globalThis.__q5Wrap(()=>({committed:true,parsedBytes:1}),'store.replaceFile');
    const begin=globalThis.__q5Wrap(()=>({kind:'ntfs-usn-v1',readBytes:0}),'proof.begin');
    for(let n=0;n<1968;n++){replace({filePath:'other-'+n});begin('other-'+n);commit.call(owner,'usage');}
    globalThis.__q5Wrap(()=>true,'store.syncRound').call(owner);
    const fullCold=q5PrivateRows(filtered);assert.ok(fullCold.some(row=>row.label==='store.syncRound'));
    assert.ok(!fullCold.some(row=>row.type==='trace-truncated'));assert.ok(fullCold.length<2100);
    const append={appendStartedAtMs:10,endedAtMs:20};
    const trace=[{at:12,type:'native-response',path:'selected',available:false,reason:'Win32 error 1179'},
      {at:13,label:'proof.verify',path:'selected',proofKind:'sha256-prefix-v2',readBytes:40},
      {at:15,label:'proof.capture',path:'selected',proofKind:'sha256-prefix-v2',readBytes:41}];
    const evidence=q5AppendEvidence(trace,append,'selected',{validation:{kind:'sha256-prefix-v2'}});
    assert.equal(evidence.nativeFastPath,false);assert.equal(evidence.readBytes,81);assert.equal(evidence.native[0].reason,'Win32 error 1179');
    assert.equal(q5AppendEvidence(trace.map(row=>({...row,proofKind:'ntfs-usn-v1'})),append,'selected',
      {validation:{kind:'ntfs-usn-v1'}}).nativeFastPath,true);
    const b2=await fs.readFile(path.join(here,'b2-page-diagnostic.mjs'),'utf8');
    const loaded=q5DiagnosticHook.load(pathToFileURL(path.join(here,'b2-page-diagnostic.mjs')).href,{},()=>({source:b2}));
    assert.ok(loaded.source.indexOf('error.q5Delivery=')<loaded.source.indexOf('await browser.close();\n    throw error;'));
  }finally{await clean(directory);}
});

test('page observer records receipt, fetch, paint, errors and bounds records without replacing initial traces',async()=>{
  let mutation;
  class EventSource {constructor(){this.handlers={};}addEventListener(kind,fn){this.handlers[kind]=fn;}}
  const window={fetch:async()=>({status:200,clone:()=>({json:async()=>({summary:{totals:{total:10},eventCount:2},fingerprint:'f'})})}),
    EventSource,addEventListener(){}};
  const sandbox={window,Date,performance,URL,Request,JSON,location:{href:'http://unit.invalid/'},
    document:{querySelector:()=>({title:'10'})},MutationObserver:class {constructor(fn){mutation=fn;}observe(){}},requestAnimationFrame:fn=>fn()};
  vm.runInNewContext(`(${observeQ5Delivery.toString()})();`,sandbox);
  const stream=new window.EventSource('/events');stream.handlers['usage-synced']({data:JSON.stringify({fingerprint:'f',revision:2})});
  await window.fetch('/api/usage');await Promise.resolve();mutation();
  const rows=window.__q5Delivery.rows;
  assert.ok(rows.some(row=>row.kind==='page-receipt'&&row.fingerprint==='f'&&row.revision===2));
  assert.ok(rows.some(row=>row.kind==='fetch-body'&&row.eventCount===2));assert.ok(rows.some(row=>row.kind==='paint'));
  for(let n=0;n<5000;n++)stream.handlers.error({});assert.equal(rows.length,4096);assert.ok(window.__q5Delivery.dropped>0);
});

test('append failures persist a started record, landing, response and paint before each assertion',async()=>{
  const directory=path.join(Q5_ROOT,label('append'));
  try {
    const file=path.join(directory,'selected');await fs.mkdir(directory,{recursive:true});
    for(const failure of ['before','response','sse','cache','paint','none']) {
      await fs.writeFile(file,'seed');const details={appends:[],scopes:[]},snapshots=[];
      let evals=0;
      const response={url:()=> 'http://unit.invalid/api/usage?preset=all',json:async()=>({summary:{totals:{total:1000},eventCount:2}}),
        status:()=>failure==='response'?500:200,headers:()=>({'x-summary-cache':failure==='cache'?'hit':'miss'})};
      const page={evaluate:async()=>++evals===1?0:failure==='sse'?0:1,
        locator:()=>({getAttribute:async()=>failure==='before'?'999':'0'}),waitForResponse:async predicate=>{assert.equal(await predicate(response),true);return response;}};
      const tools={codexAppendRows:()=>Buffer.from('+'),painted:async()=>{if(failure==='paint')throw Error('paint failed');}};
      const pending=appendQ5AndPaint(page,{selected:{codex:{targetPath:file}}},{codex:{}},'codex',details,1000,
        async()=>snapshots.push(structuredClone(details.appends[0])),tools);
      if(failure==='none')await pending;else await assert.rejects(pending);
      assert.equal(snapshots[0].status,'started');assert.equal(details.appends.length,1);
      if(failure!=='before')assert.ok(snapshots.some(row=>row.status==='landed'&&Number.isFinite(row.appendLandedAtMs)));
      if(['sse','cache','none'].includes(failure))assert.ok(snapshots.some(row=>Number.isFinite(row.paintedAtMs)));
      assert.equal(details.appends[0].status,failure==='none'?'passed':'failed');
    }
  }finally{await clean(directory);}
});

test('native unavailable is recorded ineligible before fixture/service launch, with no fake sample',async()=>{
  const name=label('unavailable'),directory=path.join(Q5_ROOT,name);
  try {
    const availability={'1x-native':{available:false,reason:'DeviceIoControl failed with Win32 error 1179'}};
    assert.equal(nativeEligibility('1x-native',availability).status,'ineligible');
    assert.equal(nativeEligibility('10x-native',availability).status,'pending');
    const plan=await prepareQ5(name,{nativeAvailability:availability});await write(path.join(directory,'matrix.json'),plan);
    const trial=plan.page.find(row=>row.cell==='1x-native'&&row.variant==='baseline');
    const child=cli('q1-summary-run.mjs',trial.args);assert.notEqual(child.status,0);
    const run=await read(trial.resultFile);assert.equal(run.status,'ineligible');assert.equal(run.eligible,false);
    assert.match(run.failure.message,/1179/);assert.equal(run.appends.length,0);assert.equal(run.server,undefined);
  }finally{await clean(directory);}
});

test('analysis writes retained failed and ineligible records without promoting partial traces into measurements',async()=>{
  const name=label('analysis'),directory=path.join(Q5_ROOT,name);
  try {
    const plan=await prepareQ5(name),pricing=await capture(directory);
    plan.prepared=true;plan.pricing={file:pricing.pricingFile,catalogSha256:pricing.pricingSha256};
    await write(path.join(directory,'matrix.json'),plan);
    const failed=plan.page[0],unavailable=plan.page.find(row=>row.cell.endsWith('native'));
    await write(failed.resultFile,{generation:'q5',cell:failed.cell,variant:failed.variant,mode:'page',passed:false,
      sourceBefore:{same:'source'},sourceAfter:{same:'source'},failure:{message:'real retained failure from self-check'},
      appends:[{kind:'codex',status:'failed',startedAtMs:10,endedAtMs:11}],
      pageDelivery:{initial:{rows:[{at:10,kind:'fetch-error',error:'self-check'}],dropped:0},reopen:{rows:[],dropped:0}}});
    await write(unavailable.resultFile,{generation:'q5',cell:unavailable.cell,variant:unavailable.variant,mode:'page',passed:false,
      status:'ineligible',eligible:false,sourceBefore:{same:'source'},sourceAfter:{same:'source'},appends:[],failure:{message:'1179'}});
    const result=cli('q1-summary-analyze.mjs',[directory,'--generation','q5','--mode','page']);assert.equal(result.status,0,result.stderr);
    const analysis=await read(path.join(directory,'analysis-page.json'));assert.equal(analysis.complete,false);
    assert.equal(analysis.results.length,2);assert.equal(analysis.accounting.pageAppends,160);
    assert.equal(analysis.results[0].windows[0].pageTimeline[0].kind,'fetch-error');assert.equal(analysis.results[0].appends.codex,null);
    assert.equal(analysis.results[1].status,'ineligible');assert.ok(analysis.issues.length>0);
  }finally{await clean(directory);}
});
