import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { BUSINESS_FIELDS, CELLS, Q3_ROOT, ROOT, VARIANTS, assertSeedParity, coldDecision, coldMatrix,
  inside, publishedAll, runOptions, versionSpec } from './q3-benchmark-support.mjs';
import { prepareQ3 } from './q3-prepare.mjs';
import { createQ3Hook } from './q3-summary-hook.mjs';

const here=path.join(ROOT,'experiments/architecture-20261101');
const flags=['--max-old-space-size=224','--max-semi-space-size=4'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));};
const label=name=>`q3-tools-selfcheck-${process.pid}-${name}`;
async function clean(directory){assert.ok(inside(Q3_ROOT,directory));assert.match(path.basename(directory),/^q3-tools-selfcheck-/);await fs.rm(directory,{recursive:true,force:true});}
function cli(file,args=[]){
  const result=spawnSync(process.execPath,[...flags,path.join(here,file),...args],{cwd:ROOT,encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  return JSON.parse(result.stdout);
}

test('Q1/Q2 paths and defaults survive; Q3 has 12 planned cold runs, 6 reserves and four 20+20 page cells',async()=>{
  for(const generation of ['q1','q2']){
    const options=runOptions(['--generation',generation,'--label',generation+'-compat']);
    assert.equal(options.mode,'full');assert.equal(options.rounds,3);
    assert.equal(options.trial,path.join(ROOT,'output/architecture-20261103',generation,generation+'-compat/1x-sha/candidate'));
    assert.equal(runOptions(['--generation',generation,'--label',generation+'-compat','--rounds','20']).rounds,20);
  }
  const plan=await prepareQ3(label('plan'),{planOnly:true});
  assert.equal(plan.trials.filter(row=>!row.reserve).length,12);assert.equal(plan.trials.length,18);
  assert.equal(new Set(plan.trials.map(row=>row.directory)).size,18);
  assert.equal(plan.page.length,4);assert.equal(plan.pageAppends,160);
  await assert.rejects(fs.stat(path.join(Q3_ROOT,label('plan'))),error=>error.code==='ENOENT');
  for(const variant of VARIANTS){
    const described=cli('q1-summary-run.mjs',['--generation','q3','--label',label('plan'),'--variant',variant,'--rep','2','--describe']);
    assert.equal(described.trial,path.join(Q3_ROOT,label('plan'),'cold/1x-sha',variant,'rep-2'));
    assert.equal(described.mode,'cold-only');assert.equal(described.rounds,20);
  }
  for(const rounds of ['0','21','1.5'])assert.throws(()=>runOptions(['--generation','q3','--label',label('plan'),'--rounds',rounds]));
  assert.throws(()=>runOptions(['--generation','q2','--label','q2-test','--variant','preq2']));
  assert.throws(()=>runOptions(['--generation','q3','--label',label('plan'),'--mode','page']));
  assert.throws(()=>runOptions(['--generation','q3','--label',label('plan'),'--mode','page','--prepared-result','test','--variant','preq2']));
});

test('supplement threshold is strictly over 5%, never more than a third rep',()=>{
  assert.equal(coldDecision([{rep:1,wallMs:100},{rep:2,wallMs:105}]).complete,true);
  assert.equal(coldDecision([{rep:1,wallMs:100},{rep:2,wallMs:105.1}]).nextRep,3);
  assert.equal(coldDecision([{rep:1,wallMs:100},{rep:2,wallMs:106},{rep:3,wallMs:200}]).complete,true);
  assert.equal(coldDecision([]).nextRep,1);assert.equal(coldDecision([{rep:1,wallMs:100}]).nextRep,2);
  assert.throws(()=>coldDecision([{rep:1,wallMs:100},{rep:1,wallMs:100}]));
  assert.throws(()=>coldDecision([{rep:4,wallMs:100}]));
});

test('published cold snapshots and old reopened Q1/Q2 snapshots both validate continuation',()=>{
  const all={eventCount:2,total:30,body:{summary:Object.fromEntries(BUSINESS_FIELDS.map(key=>[key,key]))}};
  const cold={mode:'cold-only',first:{all},published:{firstAll:all}};
  assert.equal(publishedAll(cold),all);assert.equal(assertSeedParity(all,cold).passed,true);
  assert.equal(assertSeedParity(all,{reopen:{firstAll:all}}).passed,true);
  assert.throws(()=>assertSeedParity({...all,total:31},cold));
  const changed=structuredClone(all);changed.body.summary.models=['changed'];
  assert.throws(()=>assertSeedParity(changed,cold));
});

test('frozen hooks verify all 98/99 files, serve frozen assets, and log real or absent quota work',async()=>{
  const directory=path.join(Q3_ROOT,label('hook'));
  await fs.mkdir(directory);
  try{
    for(const variant of ['preq2','baseline']){
      const version=versionSpec(variant),hashes=await read(version.hashesFile);
      assert.equal(Object.keys(hashes).length,version.expectedFiles);
      for(const [relative,expected] of Object.entries(hashes))assert.equal(hash(await fs.readFile(path.join(version.directory,relative))),expected);
      const hook=createQ3Hook(variant);
      const loaded=hook.load(pathToFileURL(path.join(ROOT,'src/server.js')).href,{},()=>{throw new Error('must load frozen source');});
      assert.ok(loaded.source.includes(JSON.stringify(path.join(version.directory,'public'))));
      assert.ok(loaded.source.includes('const __dirname = path.dirname(fileURLToPath(import.meta.url))'));
      const executor=hook.load(pathToFileURL(path.join(ROOT,'src/usage-executor.js')).href,{},()=>{throw new Error('must load frozen executor');});
      assert.equal(executor.source,await fs.readFile(path.join(version.directory,'src/usage-executor.js'),'utf8'));
      assert.match(executor.source,/execArgv: \[\.\.\.process\.execArgv, \.\.\.EXECUTOR_EXEC_ARGV\]/);
    }
    const hook=createQ3Hook('candidate',directory);
    const incoming={format:'module',source:'// existing import hooks and executor arguments'};
    assert.equal(hook.load(pathToFileURL(path.join(ROOT,'src/usage-executor.js')).href,{},()=>incoming),incoming);
    const original='class UsageStore { prepareQuotaProjection() { return 7; } async syncRound() { throw new Error("expected failure"); } }';
    const loaded=hook.load(pathToFileURL(path.join(ROOT,'src/usage-store.js')).href,{},()=>({format:'module',source:original}));
    const Store=vm.runInNewContext(loaded.source+'\nUsageStore;',{globalThis,performance});
    const store=new Store();assert.equal(store.prepareQuotaProjection({preset:'all'}),7);
    const quotaWork={rebuilt:false,reused:false,changes:2,promotedTimes:1,endpoints:2,cycles:1,fallback:true};
    store.lastQuotaWork=quotaWork;store.prepareQuotaProjection({preset:'all'});
    await assert.rejects(store.syncRound(),/expected failure/);
    const lines=(await fs.readFile(path.join(directory,`component-${process.pid}.ndjson`),'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(Object.hasOwn(lines[0],'work'),false);assert.equal(Object.hasOwn(lines[0],'quotaWork'),false);
    assert.deepEqual(lines[1].work,quotaWork);assert.deepEqual(lines[1].quotaWork,quotaWork);
    assert.equal(lines[2].error,'expected failure');assert.equal(lines[1].variant,'candidate');
  }finally{await clean(directory);}
});

test('real prepareScale makes all tiny mirrors before the completion manifest, with independent mutable source files and no DB',async()=>{
  const name=label('mirrors'),base=path.join(Q3_ROOT,name),source=path.join(Q3_ROOT,label('source'));
  await fs.mkdir(source);
  try{
    const home=path.join(source,'home'),seed=path.join(source,'seed');
    const inputs=[];
    for(const [relative,content,kind] of [['.codex/sessions/a.jsonl','tiny codex','codex'],['.dsh/a.zst','tiny dsh','dsh'],
      ['.codex/config.toml','tiny config'],['.dsh/settings.json','{}']]){
      const file=path.join(home,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);
      if(kind)inputs.push({path:file,key:kind,kind,role:'usage-file',compressed:kind==='dsh',sourceBytes:Buffer.byteLength(content),sha256:hash(content)});
    }
    await fs.mkdir(seed);await fs.writeFile(path.join(seed,'pricing-auto.json'),'{}');await fs.writeFile(path.join(seed,'codex-quota.json'),'{}');
    const datasets=Object.fromEntries([['1x',1],['10x',10]].map(([key,scale])=>[key,{root:home,scale,inputs}]));
    const manifest=await prepareQ3(name,{datasets,seedDirectories:{'1x':seed,'10x':seed}});
    assert.equal(manifest.prepared,true);assert.equal((await read(path.join(base,'matrix.json'))).trials.length,18);
    const mutableInodes=new Set();
    for(const trial of manifest.trials){
      const prepared=await read(trial.preparedFile);
      assert.ok(inside(trial.directory,prepared.databaseFile));
      await assert.rejects(fs.stat(prepared.databaseFile),error=>error.code==='ENOENT');
      for(const selected of Object.values(prepared.selected)){
        assert.equal(hash(await fs.readFile(selected.targetPath)),selected.sourceSha256);
        const inode=String((await fs.stat(selected.targetPath)).ino);
        assert.equal(mutableInodes.has(inode),false);mutableInodes.add(inode);
      }
    }
    assert.equal(mutableInodes.size,36);
  }finally{await clean(base);await clean(source);}
});

function body(){return {summary:{totals:{total:30},costEstimate:{total:1},eventCount:2,sessionCount:1,homeCount:1,
  timeline:[],timelineError:null,channels:[],models:[]},metadata:{homes:[]},periodComparison:{current:30}};}
async function syntheticRun(directory,{cell,variant,rep,mode='cold-only',wall=100,seedFile}={}){
  const firstAll={eventCount:2,total:30,wallMs:20,body:body()};
  const resource={service:{peakSampledWorkingSetBytes:10},browser:{peakSampledWorkingSetBytes:20},observer:{cpuSecondsUsed:0.1},state:{},temp:{}};
  const run={generation:'q3',cell,variant,rep,mode,rounds:20,passed:true,endedAt:new Date(200).toISOString(),
    sourceBefore:{synthetic:'self-test only'},sourceAfter:{synthetic:'self-test only'},datasetSha256:'synthetic-input',
    prepared:{home:path.join(directory,'fixture/home'),databaseFile:'not-opened-by-Q3-analysis'},
    first:{startedAtMs:1,endedAtMs:wall+1,all:firstAll},published:{firstAll},initialView:null,
    progress:[{validation:{kind:variant==='candidate'?'sha256-prefix-v2':'sha256-prefix-v1'}},{validation:{kind:variant==='candidate'?'sha256-prefix-v2':'sha256-prefix-v1'}}],appends:[],scopes:[],
    resourceSpans:[{name:'initial',directory,servicePid:100}]};
  if(mode==='page'){
    run.seedParity={passed:true};run.continuedFrom=seedFile;run.reopen={startedAtMs:150,endedAtMs:180,firstAll};
    for(const kind of ['codex','dsh'])for(let round=0;round<20;round++)run.appends.push({kind,startedAtMs:110,endedAtMs:120,wallMs:10});
    const reopened=path.join(directory,'resources-reopen');
    run.resourceSpans.push({name:'reopen',directory:reopened,servicePid:200});
    await write(path.join(reopened,'resources.json'),{...resource,service:{peakSampledWorkingSetBytes:99}});
  }
  await write(path.join(directory,'result.json'),run);
  await write(path.join(directory,'resources.json'),resource);
  await fs.writeFile(path.join(directory,'resources.ndjson'),JSON.stringify({atUnixMs:115,service:{workingSetBytes:10,privateBytes:10}})+'\n');
  await fs.mkdir(path.join(directory,'components'),{recursive:true});
  await fs.writeFile(path.join(directory,'components/component-self-test.ndjson'),JSON.stringify({label:'prepareQuotaProjection',start:112,duration:2,quoteBytes:0,work:{selfTest:true}})+'\n');
  return run;
}

test('Q3 analysis requests only necessary reserves, retains raw reps, selects the last seed and separates reopened resource roots',async()=>{
  const name=label('analysis'),base=path.join(Q3_ROOT,name),trials=coldMatrix(name);
  await write(path.join(base,'matrix.json'),{generation:'q3',prepared:true,trials});
  try{
    for(const trial of trials.filter(row=>!row.reserve))await syntheticRun(trial.directory,{...trial,wall:trial.cell==='1x-sha'&&trial.variant==='baseline'&&trial.rep===2?106:100});
    const first=cli('q1-summary-analyze.mjs',[base,'--q3','--mode','cold']);
    assert.equal(first.complete,false);assert.equal(first.needsSupplement.length,1);
    const extra=trials.find(row=>row.cell==='1x-sha'&&row.variant==='baseline'&&row.rep===3);
    await syntheticRun(extra.directory,extra);
    assert.equal(cli('q1-summary-analyze.mjs',[base,'--q3','--mode','cold']).complete,true);
    const analysis=await read(path.join(base,'analysis-cold.json'));
    assert.equal(analysis.results.length,13);assert.equal(analysis.coldGroups.length,6);
    assert.equal(analysis.pageSeeds.find(row=>row.cell==='1x-sha'&&row.variant==='baseline').preparedResult,extra.resultFile);
    for(const cell of CELLS)for(const variant of ['baseline','candidate']){
      const seed=analysis.pageSeeds.find(row=>row.cell===cell&&row.variant===variant);
      await syntheticRun(path.join(base,'page',cell,variant),{cell,variant,mode:'page',seedFile:seed.preparedResult});
    }
    assert.equal(cli('q1-summary-analyze.mjs',[base,'--q3','--mode','page']).complete,true);
    const page=await read(path.join(base,'analysis-page.json'));
    assert.equal(page.results.reduce((n,row)=>n+row.windows.length,0),160);
    assert.ok(page.results.every(row=>row.wholeServiceRssMax===10&&row.reopenServiceRssMax===99));
    assert.ok(page.results.every(row=>row.windows[0].quotaWork[0].selfTest));
    assert.match(page.quotaWorkSemantics.changes,/not SQL scanned rows/);
  }finally{await clean(base);}
});

test('existing Q1/Q2 result layouts still analyze without Q3 fixtures or quota work',async()=>{
  const base=path.join(Q3_ROOT,label('legacy'));
  try{
    for(const cell of CELLS)for(const variant of ['baseline','candidate']){
      const directory=path.join(base,cell,variant),run=await syntheticRun(directory,{cell,variant});
      delete run.generation;delete run.mode;delete run.rep;delete run.resourceSpans;
      for(const progress of run.progress)progress.validation.kind='sha256-prefix-v1';
      run.prepared.databaseFile=':memory:';run.reopen={startedAtMs:150,endedAtMs:180,firstAll:run.first.all};
      await write(path.join(directory,'result.json'),run);
    }
    assert.equal(cli('q1-summary-analyze.mjs',[base]).parity.passed,true);
    assert.equal(cli('q1-summary-analyze.mjs',[base,'--q2']).parity.passed,true);
  }finally{await clean(base);}
});

test('runner cold-only/page and failure cleanup execute with fake services, no real server or browser',async()=>{
  const name=label('runner'),base=path.join(Q3_ROOT,name),trials=coldMatrix(name);
  await fs.mkdir(base);
  try{
    const originals={};
    for(const kind of ['codex','dsh']){const file=path.join(base,kind+'-original');await fs.writeFile(file,kind);originals[kind]=file;}
    for(const trial of trials){
      const home=path.join(trial.directory,'fixture/home'),stateDirectory=path.join(trial.directory,'fixture/state');
      await fs.mkdir(home,{recursive:true});await fs.mkdir(stateDirectory);
      const selected={};
      for(const kind of ['codex','dsh']){
        const targetPath=path.join(home,kind);await fs.copyFile(originals[kind],targetPath);
        selected[kind]={targetPath,sourcePath:originals[kind],sourceSha256:hash(kind)};
      }
      await write(trial.preparedFile,{home,stateDirectory,selected,databaseFile:path.join(stateDirectory,'fake-facts.json')});
    }
    await write(path.join(base,'matrix.json'),{generation:'q3',label:name,prepared:true,trials});
    const loader=path.join(base,'fake-loader.mjs');
    // Test-only replacements exercise the real driver's branches without launching its services.
    await fs.writeFile(loader,`
      import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';
      import {createHash} from 'node:crypto';import {EventEmitter} from 'node:events';import {registerHooks} from 'node:module';
      import {fileURLToPath} from 'node:url';
      const log=record=>fs.appendFileSync(process.env.Q3_TOOLS_LOG,JSON.stringify(record)+'\\n');
      const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));let prepared,pid=4000;
      const facts=()=>read(prepared.databaseFile);
      const body=()=>({summary:{totals:{total:facts().total},eventCount:facts().n,sessionCount:1,homeCount:1,timeline:[],models:[],channels:[]},metadata:{homes:[]},periodComparison:{}});
      const all=()=>({eventCount:facts().n,total:facts().total,body:body(),wallMs:1});
      class Child extends EventEmitter{constructor(){super();this.pid=++pid;this.exitCode=null;this.stdout=new EventEmitter();this.stderr=new EventEmitter();}kill(){this.exitCode=1;this.emit('exit',1);}}
      const spawn=(command,args)=>{
        const child=new Child();log({type:'spawn',command,args,pid:child.pid});
        if(command==='pwsh'){
          const directory=args[args.indexOf('-ResultDir')+1],stop=args[args.indexOf('-StopFile')+1];
          fs.mkdirSync(directory,{recursive:true});
          fs.writeFileSync(path.join(directory,'resources.json'),JSON.stringify({service:{peakSampledWorkingSetBytes:1},browser:{},observer:{},state:{},temp:{}}));
          fs.writeFileSync(path.join(directory,'resources.ndjson'),'');
          const timer=setInterval(()=>{if(fs.existsSync(stop)){clearInterval(timer);child.exitCode=0;child.emit('exit',0);log({type:'sampler-stop',pid:child.pid});}},2);
        }else{assert.ok(args.includes('--max-old-space-size=512'));assert.ok(args.some(arg=>arg.endsWith('q3-summary-hook.mjs')));}
        return child;
      };
      class DatabaseSync{constructor(file){this.file=file;}prepare(sql){return {get:()=>{
        if(/PRAGMA quick_check/i.test(sql))return {quick_check:'ok'};
        if(/count\\(\\*\\).*FROM events/i.test(sql))return {n:read(this.file).n};
        if(/sum\\(total\\)/i.test(sql))return {n:read(this.file).total};
      },all:()=>[]};}close(){}}
      const tools={
        prepareScale:()=>{throw new Error('must reuse prepared fixture');},
        serverOptions:p=>{prepared=p;return {homeDir:p.home,databaseFile:p.databaseFile};},
        waitForServer:async child=>({pid:child.pid,url:'http://self-test.invalid'}),
        stopServer:async server=>{server.child.exitCode=0;server.child.emit('exit',0);log({type:'service-stop',pid:server.ready.pid});},
        openPage:async()=>{
          if(!fs.existsSync(prepared.databaseFile))fs.writeFileSync(prepared.databaseFile,JSON.stringify({n:2,total:30}));
          const page={evaluate:async()=>{},waitForResponse:async()=>({json:async()=>body(),status:()=>200,headers:()=>({})})};
          return {page,all:all(),bootstrapMs:1,errors:[],browser:{close:async()=>log({type:'browser-close'})}};
        },
        painted:async()=>{},
        appendAndPaint:async(page,p,state,kind,mode,result,expected)=>{
          const value=facts();assert.equal(value.total,expected-(kind==='codex'?1000:1900));
          fs.appendFileSync(p.selected[kind].targetPath,'+');fs.writeFileSync(p.databaseFile,JSON.stringify({n:value.n+1,total:expected}));
          result.appends.push({kind,responseEventCount:value.n+1,wallMs:1});log({type:'append',kind});
        },
        progressRows:()=>Object.values(prepared.selected).map(selected=>({sourcePath:selected.targetPath,checkpoint:{offset:fs.statSync(selected.targetPath).size,state:{previousCumulative:{}}},validation:{kind:'sha256-prefix-v1'}})),
        hashFile:async file=>{const bytes=fs.readFileSync(file);return {sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};},
        sourceInventory:()=>({selfTest:true}),compareInventory:()=>{log({type:'source-gate'});if(process.env.Q3_TOOLS_FAIL_GATE)throw new Error('expected source gate failure');},sleep:async()=>{},
      };
      globalThis.__q3Tools={spawn,DatabaseSync,tools};
      registerHooks({load(url,context,next){
        if(url==='node:child_process')return {format:'module',source:'export const spawn=globalThis.__q3Tools.spawn;',shortCircuit:true};
        if(url==='node:sqlite')return {format:'module',source:'export const DatabaseSync=globalThis.__q3Tools.DatabaseSync;',shortCircuit:true};
        if(url.startsWith('file:')&&fileURLToPath(url).endsWith('b2-page-diagnostic.mjs'))return {format:'module',source:Object.keys(tools).map(name=>'export const '+name+'=globalThis.__q3Tools.tools.'+name+';').join('\\n'),shortCircuit:true};
        return next(url,context);
      }});
    `);
    function drive(args,fail=false){
      const logFile=path.join(base,fail?'failure-log.ndjson':args.includes('page')?'page-log.ndjson':'cold-log.ndjson');
      return spawnSync(process.execPath,[...flags,'--import',pathToFileURL(loader).href,path.join(here,'q1-summary-run.mjs'),
        '--generation','q3','--label',name,'--variant','baseline',...args],
        {cwd:ROOT,encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,Q3_TOOLS_LOG:logFile,...(fail?{Q3_TOOLS_FAIL_GATE:'1'}:{})}});
    }
    const cold=drive(['--rep','2']);assert.equal(cold.status,0,cold.stderr+'\n'+cold.stdout);
    const seed=trials.find(row=>row.cell==='1x-sha'&&row.variant==='baseline'&&row.rep===2);
    const coldResult=await read(seed.resultFile);
    assert.equal(coldResult.passed,true);assert.equal(coldResult.appends.length,0);assert.equal(coldResult.resourceSpans.length,1);
    assert.equal(coldResult.reopen,undefined);
    const page=drive(['--mode','page','--prepared-result',seed.resultFile]);assert.equal(page.status,0,page.stderr+'\n'+page.stdout);
    const pageResult=await read(path.join(base,'page/1x-sha/baseline/result.json'));
    assert.equal(pageResult.passed,true);assert.equal(pageResult.seedParity.passed,true);assert.equal(pageResult.appends.length,40);
    assert.equal(pageResult.published.firstAll.eventCount,42);assert.equal(pageResult.resourceSpans.length,2);
    assert.notEqual(pageResult.resourceSpans[0].directory,pageResult.resourceSpans[1].directory);
    assert.ok(pageResult.resourceSpans[0].endedAtMs<=pageResult.resourceSpans[1].startedAtMs);
    const failed=drive(['--rep','1'],true);assert.equal(failed.status,1,failed.stderr+'\n'+failed.stdout);
    const failedResult=await read(trials.find(row=>row.cell==='1x-sha'&&row.variant==='baseline'&&row.rep===1).resultFile);
    assert.equal(failedResult.passed,false);assert.match(failedResult.failure.message,/source gate failure/);
    for(const file of ['cold-log.ndjson','page-log.ndjson','failure-log.ndjson']){
      const records=(await fs.readFile(path.join(base,file),'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(records.filter(row=>row.type==='sampler-stop').length,records.filter(row=>row.type==='spawn'&&row.command==='pwsh').length);
      assert.equal(records.filter(row=>row.type==='service-stop').length,records.filter(row=>row.type==='spawn'&&row.command!=='pwsh').length);
    }
  }finally{await clean(base);}
});
