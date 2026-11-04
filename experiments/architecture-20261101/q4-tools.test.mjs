import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { BUSINESS_FIELDS, CELLS, Q3_ROOT, Q4_ROOT, Q4_VARIANTS, ROOT, assertQ4Matrix,
  coldDecision, coldMatrix, coldStageFailures, finalQ4Cold, q4PageSeed, inside, runOptions, versionSpec } from './q3-benchmark-support.mjs';
import { prepareQ4 } from './q4-prepare.mjs';
import { createQ4Hook } from './q4-summary-hook.mjs';

const here = path.join(ROOT,'experiments/architecture-20261101');
const label = name => `q4-tools-selfcheck-${process.pid}-${name}`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file,'utf8'));
const write = async (file,value) => { await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value)); };
async function clean(directory) {
  assert.ok(inside(Q4_ROOT,directory));assert.match(path.basename(directory),/^q4-tools-selfcheck-/);
  await fs.rm(directory,{recursive:true,force:true});
}
function cli(file,args=[],extra={}) {
  return spawnSync(process.execPath,[path.join(here,file),...args],{cwd:ROOT,encoding:'utf8',windowsHide:true,timeout:15000,...extra});
}
function successful(result) { assert.equal(result.status,0,result.stderr+'\n'+result.stdout);return JSON.parse(result.stdout); }
const flags = name => ['--generation','q4','--label',name];

test('page-only fixed pricing returns the loaded catalog status without fetching or changing money inputs',async()=>{
  const input={format:'module',source:'let fetched=0; function getAutomaticPricingStatus(){return {rate:6.6505};} async function refreshAutomaticPricing(){fetched++;throw Error("remote request");}'};
  const url=pathToFileURL(path.join(ROOT,'src/pricing-store.js')).href;
  assert.equal(createQ4Hook('candidate').load(url,{},()=>input),input);
  const hook=createQ4Hook('candidate',undefined,true);
  const loaded=hook.load(url,{},()=>input);
  const inspect=vm.runInNewContext(loaded.source+'\nasync()=>({result:await refreshAutomaticPricing(),fetched});');
  const {result,fetched}=await inspect();assert.equal(fetched,0);assert.equal(result.changed,false);assert.equal(result.rate,6.6505);
});

test('source retry classification requires the expected error, successful enclosing source and a completed retry',()=>{
  const parent={type:'span',spanId:'p',label:'store.replaceFile',start:0,duration:10};
  const error={type:'span',spanId:'e',parentSpanId:'p',label:'source.streamUsageFileEvents',start:1,duration:2,error:'SOURCE_PROGRESS_UNSUPPORTED: zstd frame decompression failed'};
  const retry={type:'span',spanId:'r',parentSpanId:'p',label:'store.replaceFile',start:4,duration:5,parsedBytes:100};
  assert.equal(coldStageFailures([parent,error,retry]).recovered.length,1);
  for(const rows of [[parent,error],[{...parent,error:'failed'},error,retry],[parent,{...error,error:'LIVE_SOURCE_CHANGED'},retry],
    [parent,error,{...retry,error:'failed'}],[parent,error,{...retry,parentSpanId:'other'}],[parent,error,{...retry,start:0}],
    [parent,error,{...retry,duration:20}]])assert.ok(coldStageFailures(rows).unhandled.length>0);
});
const matrix = name => ({generation:'q4',label:name,base:path.join(Q4_ROOT,name),prepared:true,trials:coldMatrix(name,'q4')});

test('Q4 paths, versions, exact 8+4 matrix and 4x10+10 page plan; plan-only writes nothing',async()=>{
  const name=label('plan'),plan=await prepareQ4(name,{planOnly:true});
  assert.equal(plan.base,path.join(Q4_ROOT,name));assert.equal(plan.trials.length,12);
  assert.equal(plan.minimumColdRuns,8);assert.equal(plan.maximumColdRuns,12);
  assert.equal(plan.trials.filter(row=>!row.reserve).length,8);assert.equal(plan.trials.filter(row=>row.reserve).length,4);
  assert.equal(new Set(plan.trials.map(row=>row.directory)).size,12);
  assert.equal(plan.page.length,4);assert.equal(plan.pageRoundsPerSource,10);assert.equal(plan.pageAppends,80);
  assert.deepEqual(plan.versions.map(row=>row.variant),Q4_VARIANTS);
  assert.equal(versionSpec('baseline',{generation:'q4'}).expectedFiles,100);
  assert.equal(versionSpec('baseline',{generation:'q4'}).directory,path.join(Q4_ROOT,'baseline'));
  assert.equal(versionSpec('candidate',{generation:'q4'}).directory,ROOT);
  for(const trial of plan.trials) {
    const options=successful(cli('q1-summary-run.mjs',[...trial.args,'--describe']));
    assert.equal(options.trial,trial.directory);assert.equal(options.rep,trial.rep);assert.equal(options.rounds,10);
    assert.equal(options.mode,'cold-only');assert.ok(inside(plan.base,options.trial));
  }
  for(const page of plan.page) {
    const options=runOptions(page.args);assert.equal(options.rep,null);
    assert.equal(options.trial,path.join(plan.base,'page',page.cell,page.variant));
  }
  assert.equal(successful(cli('q4-prepare.mjs',[name,'--plan-only'])).prepared,false);
  await assert.rejects(fs.stat(plan.base),error=>error.code==='ENOENT');
  for(const args of [['--variant','preq2'],['--cell','1x-native'],['--mode','full'],['--rounds','20'],['--rep','4'],
    ['--mode','page'],['--mode','page','--prepared-result','x','--rep','1'],['--prepared-result','x']])
    assert.throws(()=>runOptions([...flags(name),...args]));
  for(const invalid of ['q4-../escape','q3-wrong','q4-a/b','q4-a\\b','q4-'])
    assert.throws(()=>coldMatrix(invalid,'q4'));
  assertQ4Matrix(matrix(name),name);
  for(const mutate of [m=>{m.prepared=false;},m=>{m.trials.pop();},m=>{m.trials[0]=m.trials[1];},m=>{m.trials[0].directory=ROOT;}]) {
    const value=matrix(name);mutate(value);assert.throws(()=>assertQ4Matrix(value,name));
  }
  assert.equal(coldMatrix('q3-compat').length,18);assert.equal(versionSpec('preq2').expectedFiles,98);
  assert.equal(versionSpec('baseline').expectedFiles,99);assert.equal(path.dirname(versionSpec('baseline').directory),Q3_ROOT);
  for(const generation of ['q1','q2','q3']) {
    const options=runOptions(['--generation',generation,'--label',generation+'-compat']);
    assert.equal(options.rounds,generation==='q3'?20:3);assert.equal(options.mode,generation==='q3'?'cold-only':'full');
  }
});

test('cold decisions preserve strict 5% threshold, reject invalid reps and stop at three',()=>{
  assert.equal(coldDecision([]).nextRep,1);assert.equal(coldDecision([{rep:2,wallMs:100}]).nextRep,1);
  assert.equal(coldDecision([{rep:1,wallMs:100}]).nextRep,2);
  for(const runs of [[{rep:1,wallMs:100},{rep:2,wallMs:105}],[{rep:1,wallMs:105},{rep:2,wallMs:100}]])
    assert.deepEqual(coldDecision(runs),{spreadFraction:0.05,supplementRequired:false,complete:true,nextRep:null});
  const runs=[{rep:1,wallMs:100},{rep:2,wallMs:106}];
  assert.equal(coldDecision(runs).nextRep,3);assert.equal(coldDecision(runs).complete,false);
  assert.equal(coldDecision([...runs,{rep:3,wallMs:10000}]).nextRep,null);
  for(const runs of [[{rep:0,wallMs:1}],[{rep:1,wallMs:0}],[{rep:1,wallMs:NaN}],
    [{rep:1,wallMs:Infinity}],[{rep:1,wallMs:1},{rep:1,wallMs:2}],Array.from({length:4},(_,i)=>({rep:i+1,wallMs:1}))])
    assert.throws(()=>coldDecision(runs));
});

test('Q4 frozen 100-file baseline and bd2a1fc receipt are read only; hook serves frozen source/public and default executor args',async()=>{
  const version=versionSpec('baseline',{generation:'q4'}),hashes=await read(version.hashesFile);
  assert.equal(Object.keys(hashes).length,100);
  for(const [relative,expected] of Object.entries(hashes))assert.equal(hash(await fs.readFile(path.join(version.directory,relative))),expected);
  const receipt=await read(path.join(Q4_ROOT,'baseline-receipt.json'));
  assert.match(receipt.head,/^bd2a1fc/);assert.equal(receipt.files,100);
  const hook=createQ4Hook('baseline');
  const frozen=file=>hook.load(pathToFileURL(path.join(ROOT,'src',file)).href,{},()=>{throw Error('must load frozen source');}).source;
  assert.ok(frozen('server.js').includes(JSON.stringify(path.join(version.directory,'public'))));
  assert.equal(frozen('usage-executor.js'),await fs.readFile(path.join(version.directory,'src/usage-executor.js'),'utf8'));
  assert.match(frozen('usage-executor.js'),/execArgv: \[\.\.\.process\.execArgv, \.\.\.EXECUTOR_EXEC_ARGV\]/);
  assert.ok(!frozen('usage-rollups.js').includes('globalThis.__q4ColdWrap(tryInitializeUsageRollups,'));
  const candidateFiles=[];
  for(const folder of ['src','public'])for(const name of await fs.readdir(path.join(ROOT,folder),{recursive:true})) {
    if((await fs.stat(path.join(ROOT,folder,name))).isFile())candidateFiles.push(path.join(folder,name));
  }
  assert.equal(candidateFiles.length,101);assert.ok(candidateFiles.includes(path.join('src','usage-insert-batch.js')));
  assert.throws(()=>createQ4Hook('preq2'));
  const incoming={format:'module',source:'// untouched executor'};
  assert.equal(createQ4Hook('candidate').load(pathToFileURL(path.join(ROOT,'src/usage-executor.js')).href,{},()=>incoming),incoming);
});

test('Q4 component work and nested cold spans preserve returns, errors, async parents and index DDL',async()=>{
  const directory=path.join(Q4_ROOT,label('hook'));await fs.mkdir(directory);
  try {
    const hook=createQ4Hook('candidate',directory);
    const source='class UsageStore { prepareQuotaProjection(){ return 7; } async syncRound(){ await Promise.resolve();this.prepareQuotaProjection();throw Error("synthetic failure"); } }';
    const loaded=hook.load(pathToFileURL(path.join(ROOT,'src/usage-store.js')).href,{},()=>({format:'module',source}));
    const Store=vm.runInNewContext(loaded.source+'\nUsageStore;',{globalThis,performance});
    const store=new Store();assert.equal(store.prepareQuotaProjection(),7);
    store.lastQuotaWork={reused:true,endpoints:2};await assert.rejects(store.syncRound(),/synthetic failure/);
    const db=new DatabaseSync(':memory:');
    try { db.exec('CREATE TABLE synthetic(x); CREATE INDEX synthetic_idx ON synthetic(x)'); } finally { db.close(); }
    const components=(await fs.readFile(path.join(directory,`component-${process.pid}.ndjson`),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(Object.hasOwn(components[0],'work'),false);assert.deepEqual(components[1].work,store.lastQuotaWork);
    assert.equal(components.at(-1).error,'synthetic failure');
    const stages=(await fs.readFile(path.join(directory,`cold-stage-${process.pid}.jsonl`),'utf8')).trim().split('\n').map(JSON.parse);
    const parent=stages.find(row=>row.label==='store.syncRound');
    assert.equal(stages.find(row=>row.parentSpanId===parent.spanId).label,'store.prepareQuotaProjection');
    assert.ok(stages.some(row=>row.label==='sqlite.indexDDL'&&row.sql.includes('synthetic_idx')));
    assert.ok(stages.every(row=>row.duration>=0));
    const rollups=hook.load(pathToFileURL(path.join(ROOT,'src/usage-rollups.js')).href,{},()=>({
      format:'module',source:'function tryInitializeUsageRollups(){ return 13; }',
    }));
    const initialize=vm.runInNewContext(rollups.source+'\ntryInitializeUsageRollups;',{globalThis});
    assert.equal(initialize(),13);
    const after=(await fs.readFile(path.join(directory,`cold-stage-${process.pid}.jsonl`),'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(after.some(row=>row.label==='rollups.tryInitializeUsageRollups'));
  } finally { await clean(directory); }
});

test('tiny real mirrors include all reserves before completion, independent append targets and no database',async()=>{
  const name=label('prepare'),base=path.join(Q4_ROOT,name),source=path.join(Q4_ROOT,label('source'));
  try {
    const home=path.join(source,'home'),seed=path.join(source,'seed'),inputs=[];
    for(const [relative,content,kind] of [['.codex/sessions/a.jsonl','synthetic codex','codex'],['.dsh/a.zst','synthetic dsh','dsh'],
      ['.codex/config.toml','synthetic config'],['.dsh/settings.json','{}']]) {
      const file=path.join(home,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);
      if(kind)inputs.push({path:file,key:kind,kind,role:'usage-file',compressed:kind==='dsh',sourceBytes:Buffer.byteLength(content),sha256:hash(content)});
    }
    await write(path.join(seed,'pricing-auto.json'),{});await write(path.join(seed,'codex-quota.json'),{});
    const datasets=Object.fromEntries([['1x',1],['10x',10]].map(([key,scale])=>[key,{root:home,scale,inputs}]));
    const {prepareScale}=await import('./b2-page-diagnostic.mjs');let count=0;
    const manifest=await prepareQ4(name,{datasets,seedDirectories:{'1x':seed,'10x':seed},prepare:async(...args)=>{
      await assert.rejects(fs.stat(path.join(base,'matrix.json')),error=>error.code==='ENOENT');count++;
      return prepareScale(...args);
    }});
    assert.equal(count,12);assertQ4Matrix(await read(path.join(base,'matrix.json')),name);
    const inodes=new Set();
    for(const trial of manifest.trials) {
      const prepared=await read(trial.preparedFile);await assert.rejects(fs.stat(prepared.databaseFile),error=>error.code==='ENOENT');
      for(const selected of Object.values(prepared.selected)) {
        const info=await fs.stat(selected.targetPath);assert.equal(info.nlink,1);inodes.add(String(info.ino));
        assert.equal(hash(await fs.readFile(selected.targetPath)),selected.sourceSha256);
      }
    }
    assert.equal(inodes.size,24);
    for(const input of inputs)assert.equal(hash(await fs.readFile(input.path)),input.sha256);
    await assert.rejects(prepareQ4(name,{datasets}),error=>error.code==='EEXIST');
  } finally { await clean(base);await clean(source); }
});

function body() { return {summary:Object.fromEntries(BUSINESS_FIELDS.map(key=>[key,key==='totals'?{total:30}:key==='eventCount'?2:[]])),metadata:{homes:[]},periodComparison:{current:30}}; }
async function syntheticRun(directory,{cell,variant,rep,mode='cold-only',wall=100,seedFile}={}) {
  const all={eventCount:2,total:30,wallMs:20,body:body()};
  const resource={service:{peakSampledWorkingSetBytes:10},browser:{peakSampledWorkingSetBytes:20},observer:{cpuSecondsUsed:0.1},state:{},temp:{}};
  const run={generation:'q4',cell,variant,rep,mode,rounds:10,passed:true,endedAt:new Date(200).toISOString(),
    sourceBefore:{synthetic:'self-test only'},sourceAfter:{synthetic:'self-test only'},datasetSha256:'synthetic-input',
    prepared:{home:path.join(directory,'fixture/home'),databaseFile:'not-opened-by-analysis'},
    first:{startedAtMs:1,endedAtMs:wall+1,all},published:{firstAll:all},initialView:null,
    initialQ4Storage:[{name:'future_projection',tableName:'future_projection',type:'table',bytes:4096}],
    finalQ4Storage:[{name:'future_projection',tableName:'future_projection',type:'table',bytes:8192}],
    progress:[{validation:{kind:'sha256-prefix-v2'}},{validation:{kind:'sha256-prefix-v2'}}],appends:[],scopes:[],
    resourceSpans:[{name:'initial',directory,servicePid:100}]};
  if(mode==='page') {
    run.rep=null;run.seedParity={passed:true};run.continuedFrom=seedFile;run.prepared=(await read(seedFile)).prepared;
    run.reopen={startedAtMs:150,endedAtMs:180,firstAll:all};run.reopenQ4Storage=run.finalQ4Storage;
    for(const kind of ['codex','dsh'])for(let round=0;round<10;round++)run.appends.push({kind,startedAtMs:110,endedAtMs:120,wallMs:10});
    const reopened=path.join(directory,'resources-reopen');run.resourceSpans.push({name:'reopen',directory:reopened,servicePid:200});
    await write(path.join(reopened,'resources.json'),{...resource,service:{peakSampledWorkingSetBytes:99}});
  }
  await write(path.join(directory,'result.json'),run);await write(path.join(directory,'resources.json'),resource);
  await fs.writeFile(path.join(directory,'resources.ndjson'),JSON.stringify({atUnixMs:115,service:{workingSetBytes:10,privateBytes:10}})+'\n');
  await fs.mkdir(path.join(directory,'components'),{recursive:true});
  await fs.writeFile(path.join(directory,'components/component-self-test.ndjson'),JSON.stringify({label:'prepareQuotaProjection',start:112,duration:2,work:{synthetic:true}})+'\n');
  await fs.writeFile(path.join(directory,'components/cold-stage-self-test.jsonl'),JSON.stringify({type:'span',label:'store.open',start:1,duration:1})+'\n');
  return run;
}

test('Q4 analysis: exactly eight minimum, conditional reserves up to twelve, final seed selection, 80 appends, dynamic storage and parity',async()=>{
  const name=label('analysis'),base=path.join(Q4_ROOT,name),manifest=matrix(name);
  const analyze=mode=>cli('q1-summary-analyze.mjs',[base,'--generation','q4','--mode',mode]);
  await write(path.join(base,'matrix.json'),manifest);
  try {
    for(const trial of manifest.trials.filter(row=>!row.reserve))await syntheticRun(trial.directory,trial);
    assert.equal(successful(analyze('cold')).complete,true);
    let result=await read(path.join(base,'analysis-cold.json'));assert.equal(result.results.length,8);assert.equal(result.coldGroups.length,4);
    const first=manifest.trials[0],second=manifest.trials[1],third=manifest.trials[2];
    assert.equal((await q4PageSeed(base,first.cell,first.variant)).file,second.resultFile);
    assert.equal((await q4PageSeed(base,first.cell,first.variant,true)).file,first.resultFile);
    const originalFirst=await read(first.resultFile),badFirst=structuredClone(originalFirst);
    badFirst.first.all.body.summary.models=['wrong'];await write(first.resultFile,badFirst);
    await assert.rejects(q4PageSeed(base,first.cell,first.variant,true));await write(first.resultFile,originalFirst);
    await syntheticRun(second.directory,{...second,wall:106});
    result=successful(analyze('cold'));assert.equal(result.complete,false);assert.equal(result.needsSupplement.length,1);
    assert.equal(result.pageSeeds.find(row=>row.cell===first.cell&&row.variant===first.variant).preparedResult,null);
    await assert.rejects(finalQ4Cold(base,first.cell,first.variant),/completed cold group/);
    await syntheticRun(third.directory,third);assert.equal(successful(analyze('cold')).complete,true);
    assert.equal((await finalQ4Cold(base,first.cell,first.variant)).file,third.resultFile);
    for(const reserve of manifest.trials.filter(row=>row.reserve&&row!==third)) {
      const second=manifest.trials.find(row=>row.cell===reserve.cell&&row.variant===reserve.variant&&row.rep===2);
      await syntheticRun(second.directory,{...second,wall:106});await syntheticRun(reserve.directory,reserve);
    }
    result=successful(analyze('cold'));assert.equal(result.complete,true);
    assert.equal((await read(path.join(base,'analysis-cold.json'))).results.length,12);
    for(const seed of result.pageSeeds)await syntheticRun(path.join(base,'page',seed.cell,seed.variant),{...seed,mode:'page',seedFile:seed.preparedResult});
    assert.equal(successful(analyze('page')).complete,true);
    const page=await read(path.join(base,'analysis-page.json'));
    assert.equal(page.schemaVersion,4);assert.equal(page.generation,'q4');assert.equal(page.parity.kind,'q4-page');
    assert.equal(page.results.reduce((n,row)=>n+row.windows.length,0),80);
    assert.ok(page.results.every(row=>row.reopenServiceRssMax===99&&row.wholeServiceRssMax===10&&row.coldStages.length===1));
    assert.equal(page.results[0].q4Storage.final[0].name,'future_projection');
    const pageFile=path.join(base,'page',first.cell,first.variant,'result.json'),saved=await read(pageFile);
    await write(pageFile,{...saved,continuedFrom:second.resultFile});assert.notEqual(analyze('page').status,0);
    await write(pageFile,saved);const changed=structuredClone(saved);changed.published.firstAll.body.summary.models=['drift'];
    await write(pageFile,changed);assert.notEqual(analyze('page').status,0);
    await write(pageFile,saved);
    await syntheticRun(second.directory,second);await assert.rejects(finalQ4Cold(base,first.cell,first.variant),/conditional/);
    assert.notEqual(analyze('cold').status,0);
  } finally { await clean(base); }
});

test('real Q4 runner uses synthetic services: all reserves gate launch, final cold continuation, 10+10 appends, heaps, reopen and failure cleanup',async()=>{
  const name=label('runner'),base=path.join(Q4_ROOT,name),manifest=matrix(name);
  try {
    const originals={};
    for(const kind of ['codex','dsh']) {
      const file=path.join(base,kind+'-original');await fs.mkdir(base,{recursive:true});await fs.writeFile(file,kind);originals[kind]=file;
    }
    for(const trial of manifest.trials) {
      const home=path.join(trial.directory,'fixture/home'),stateDirectory=path.join(trial.directory,'fixture/state'),selected={};
      await fs.mkdir(home,{recursive:true});await fs.mkdir(stateDirectory);
      for(const kind of ['codex','dsh']) {
        const targetPath=path.join(home,kind);await fs.copyFile(originals[kind],targetPath);
        selected[kind]={targetPath,sourcePath:originals[kind],sourceSha256:hash(kind)};
      }
      await write(trial.preparedFile,{home,stateDirectory,selected,databaseFile:path.join(stateDirectory,'fake-facts.json')});
    }
    await write(path.join(base,'matrix.json'),manifest);
    const loader=path.join(base,'fake-loader.mjs');
    await fs.writeFile(loader,`
      import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
      import {createHash} from 'node:crypto';import {EventEmitter} from 'node:events';import {registerHooks} from 'node:module';
      import {fileURLToPath} from 'node:url';
      const log=record=>fs.appendFileSync(process.env.Q4_TOOLS_LOG,JSON.stringify(record)+'\\n');
      const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));let prepared,pid=4000;
      const facts=()=>read(prepared.databaseFile);
      const body=()=>({summary:{totals:{total:facts().total},eventCount:facts().n,sessionCount:1,homeCount:1,timeline:[],models:[],channels:[]},metadata:{homes:[]},periodComparison:{}});
      const all=()=>({eventCount:facts().n,total:facts().total,body:body(),wallMs:1});
      class Child extends EventEmitter{constructor(){super();this.pid=++pid;this.exitCode=null;this.stdout=new EventEmitter();this.stderr=new EventEmitter();}kill(){this.exitCode=1;this.emit('exit',1);}}
      const spawn=(command,args,options)=>{
        const child=new Child();log({type:'spawn',command,args,pid:child.pid});
        if(command==='pwsh'){
          const directory=args[args.indexOf('-ResultDir')+1],stop=args[args.indexOf('-StopFile')+1];
          fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'resources.json'),JSON.stringify({service:{peakSampledWorkingSetBytes:1},browser:{},observer:{},state:{},temp:{}}));
          fs.writeFileSync(path.join(directory,'resources.ndjson'),'');
          const timer=setInterval(()=>{if(fs.existsSync(stop)){clearInterval(timer);child.exitCode=0;child.emit('exit',0);log({type:'sampler-stop'});}},2);
        }else{
          assert.ok(args.includes('--max-old-space-size=512'));assert.ok(args.some(arg=>arg.endsWith('q4-summary-hook.mjs')));
          assert.equal(options.env.Q4_VARIANT,process.env.Q4_TOOLS_VARIANT);assert.equal(options.env.Q3_VARIANT,undefined);assert.equal(options.env.NODE_OPTIONS,undefined);
          const config=read(args.at(-1));assert.equal(config.gatewayHeapMb,512);assert.equal(config.executorHeapMb,224);
        }
        return child;
      };
      class DatabaseSync{constructor(file){this.file=file;}prepare(sql){return {get:()=>{
        if(/PRAGMA quick_check/i.test(sql))return {quick_check:'ok'};
        if(/count\\(\\*\\).*FROM events/i.test(sql))return {n:read(this.file).n};
        if(/sum\\(total\\)/i.test(sql))return {n:read(this.file).total};
      },all:()=>/COALESCE/.test(sql)?[{name:'future_q4_table',tableName:'future_q4_table',type:'table',bytes:4096}]:[]};}close(){}}
      const tools={
        prepareScale:()=>{throw Error('must reuse prepared fixture');},serverOptions:p=>{prepared=p;return {homeDir:p.home,databaseFile:p.databaseFile};},
        waitForServer:async child=>({pid:child.pid,url:'http://self-test.invalid'}),
        stopServer:async server=>{server.child.exitCode=0;server.child.emit('exit',0);log({type:'service-stop'});},
        openPage:async()=>{
          await new Promise(resolve=>setTimeout(resolve,5));
          if(!fs.existsSync(prepared.databaseFile))fs.writeFileSync(prepared.databaseFile,JSON.stringify({n:2,total:30}));
          const page={evaluate:async()=>{},waitForResponse:async()=>({json:async()=>body(),status:()=>200,headers:()=>({})})};
          return {page,all:all(),bootstrapMs:1,errors:[],browser:{close:async()=>log({type:'browser-close'})}};
        },painted:async()=>{},
        appendAndPaint:async(page,p,state,kind,mode,result,expected)=>{
          const value=facts();assert.equal(value.total,expected-(kind==='codex'?1000:1900));
          fs.appendFileSync(p.selected[kind].targetPath,'+');fs.writeFileSync(p.databaseFile,JSON.stringify({n:value.n+1,total:expected}));
          result.appends.push({kind,responseEventCount:value.n+1,wallMs:1});log({type:'append',kind});
        },
        progressRows:()=>Object.values(prepared.selected).map(selected=>({sourcePath:selected.targetPath,checkpoint:{offset:fs.statSync(selected.targetPath).size,state:{previousCumulative:{}}},validation:{kind:'sha256-prefix-v2'}})),
        hashFile:async file=>{const bytes=fs.readFileSync(file);return {sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};},
        sourceInventory:()=>({synthetic:true}),compareInventory:()=>{if(process.env.Q4_TOOLS_FAIL_GATE)throw Error('synthetic source gate failure');},sleep:async()=>{},
      };
      globalThis.__q4Tools={spawn,DatabaseSync,tools};registerHooks({load(url,context,next){
        if(url==='node:child_process')return {format:'module',source:'export const spawn=globalThis.__q4Tools.spawn;',shortCircuit:true};
        if(url==='node:sqlite')return {format:'module',source:'export const DatabaseSync=globalThis.__q4Tools.DatabaseSync;',shortCircuit:true};
        if(url.startsWith('file:')&&fileURLToPath(url).endsWith('b2-page-diagnostic.mjs'))return {format:'module',source:Object.keys(tools).map(name=>'export const '+name+'=globalThis.__q4Tools.tools.'+name+';').join('\\n'),shortCircuit:true};
        return next(url,context);
      }});
    `);
    let sequence=0;const logs=[];
    function drive(args,{variant='baseline',fail=false}={}) {
      const logFile=path.join(base,`drive-${++sequence}.ndjson`);logs.push(logFile);
      // Only the driver runs; spawn, SQLite, server, browser and appends are synthetic.
      return spawnSync(process.execPath,['--import',pathToFileURL(loader).href,path.join(here,'q1-summary-run.mjs'),...flags(name),'--variant',variant,...args],{
        cwd:ROOT,encoding:'utf8',windowsHide:true,timeout:15000,
        env:{...process.env,Q4_TOOLS_LOG:logFile,Q4_TOOLS_VARIANT:variant,Q3_VARIANT:'must-be-cleared',
          ...(fail?{Q4_TOOLS_FAIL_GATE:'1'}:{})},
      });
    }
    const missing=manifest.trials.at(-1),saved=await read(missing.preparedFile);await fs.rm(missing.preparedFile);
    const blocked=drive(['--rep','2'],{variant:'candidate'});assert.notEqual(blocked.status,0);
    assert.equal((await read(manifest.trials.find(row=>row.cell==='1x-sha'&&row.variant==='candidate'&&row.rep===2).resultFile)).passed,false);
    await write(missing.preparedFile,saved);
    successful(drive(['--rep','1']));successful(drive(['--rep','2']));
    const first=manifest.trials[0],second=manifest.trials[1],cold=await read(second.resultFile),firstRun=await read(first.resultFile);
    firstRun.first.endedAtMs=firstRun.first.startedAtMs+cold.first.endedAtMs-cold.first.startedAtMs;await write(first.resultFile,firstRun);
    assert.equal(cold.appends.length,0);assert.equal(cold.resourceSpans.length,1);assert.equal(cold.reopen,undefined);
    assert.equal(cold.finalQ4Storage[0].name,'future_q4_table');
    const wrong=drive(['--mode','page','--prepared-result',first.resultFile]);assert.notEqual(wrong.status,0);
    const pageDir=path.join(base,'page/1x-sha/baseline');assert.ok(inside(base,pageDir));
    assert.match((await read(path.join(pageDir,'result.json'))).failure.message,/matching final cold result/);
    await fs.rm(pageDir,{recursive:true});
    successful(drive(['--mode','page','--prepared-result',second.resultFile]));
    const page=await read(path.join(pageDir,'result.json'));
    assert.equal(page.appends.length,20);assert.equal(page.seedParity.passed,true);assert.equal(page.published.firstAll.eventCount,22);
    assert.equal(page.resourceSpans.length,2);assert.equal(page.reopenQ4Storage[0].name,'future_q4_table');
    assert.ok(page.resourceSpans[0].endedAtMs<=page.resourceSpans[1].startedAtMs);
    assert.notEqual(page.resourceSpans[0].directory,page.resourceSpans[1].directory);
    for(const kind of ['codex','dsh'])assert.equal(page.appends.filter(row=>row.kind===kind).length,10);
    const failure=drive(['--rep','1'],{variant:'candidate',fail:true});assert.notEqual(failure.status,0);
    const failed=await read(manifest.trials.find(row=>row.cell==='1x-sha'&&row.variant==='candidate'&&row.rep===1).resultFile);
    assert.match(failed.failure.message,/synthetic source gate failure/);assert.equal(failed.passed,false);
    for(const logFile of logs) {
      let records;try { records=(await fs.readFile(logFile,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
      catch(error) { if(error.code==='ENOENT')continue;throw error; }
      assert.equal(records.filter(row=>row.type==='sampler-stop').length,records.filter(row=>row.type==='spawn'&&row.command==='pwsh').length);
      assert.equal(records.filter(row=>row.type==='service-stop').length,records.filter(row=>row.type==='spawn'&&row.command!=='pwsh').length);
    }
    for(const kind of ['codex','dsh'])assert.equal(await fs.readFile(originals[kind],'utf8'),kind);
  } finally { await clean(base); }
});
