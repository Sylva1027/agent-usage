import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertQ4Matrix, Q4_ROOT, ROOT } from './q3-benchmark-support.mjs';

const label=process.argv[2];assert.match(label||'',/^q4-[a-z0-9-]+$/);
const base=path.join(Q4_ROOT,label),here=path.join(ROOT,'experiments/architecture-20261101');
const read=async file=>JSON.parse(await readFile(file,'utf8'));
const matrix=await read(path.join(base,'matrix.json'));assertQ4Matrix(matrix,label);
const progress={startedAt:new Date().toISOString(),completed:[],running:null,passed:false};
const publish=()=>writeFile(path.join(base,'suite-progress.json'),JSON.stringify(progress,null,2)+'\n',{flush:true});
async function run(name,file,args) {
  progress.running={name,args,startedAt:new Date().toISOString()};await publish();
  console.log(JSON.stringify({stage:'start',...progress.running}));
  const log=await open(path.join(base,`suite-${name}.log`),'wx');
  try {
    await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[path.join(here,file),...args],{cwd:ROOT,windowsHide:true,stdio:['ignore',log.fd,log.fd]});
      child.once('error',reject);child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`${name} exited ${code}/${signal}`)));
    });
  } finally {await log.close();}
  progress.completed.push({...progress.running,endedAt:new Date().toISOString()});progress.running=null;await publish();
  console.log(JSON.stringify({stage:'done',name}));
}
async function cold(cell,variant,rep) {
  const trial=matrix.trials.find(row=>row.cell===cell&&row.variant===variant&&row.rep===rep);
  try {const existing=await read(trial.resultFile);assert.equal(existing.passed,true,trial.resultFile);return;}
  catch(error){if(error.code!=='ENOENT')throw error;}
  await run(`cold-${cell}-${variant}-${rep}`,'q1-summary-run.mjs',trial.args);
  assert.equal((await read(trial.resultFile)).passed,true);
}
// Alternate versions, keeping both scales together for each repetition.
for(const rep of [1,2])for(const variant of ['baseline','candidate'])for(const cell of ['1x-sha','10x-sha'])await cold(cell,variant,rep);
await run('cold-analysis-first','q1-summary-analyze.mjs',[base,'--q4','--mode','cold']);
let analysis=await read(path.join(base,'analysis-cold.json'));
for(const group of analysis.needsSupplement)await cold(group.cell,group.variant,3);
if(analysis.needsSupplement.length){await run('cold-analysis-final','q1-summary-analyze.mjs',[base,'--q4','--mode','cold']);analysis=await read(path.join(base,'analysis-cold.json'));}
assert.equal(analysis.complete,true);
for(const seed of analysis.pageSeeds) {
  await run(`page-${seed.cell}-${seed.variant}`,'q1-summary-run.mjs',[
    '--generation','q4','--label',label,'--cell',seed.cell,'--variant',seed.variant,'--mode','page','--rounds','10','--prepared-result',seed.preparedResult]);
}
await run('page-analysis','q1-summary-analyze.mjs',[base,'--q4','--mode','page']);
assert.equal((await read(path.join(base,'analysis-page.json'))).complete,true);
await run('cost-ledger','q3-cost-ledger.mjs',[base,'--q4']);
progress.passed=true;progress.endedAt=new Date().toISOString();await publish();
console.log(JSON.stringify({passed:true,completed:progress.completed.length,base}));
