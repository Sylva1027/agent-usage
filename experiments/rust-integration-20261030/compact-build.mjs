import fs from "node:fs";
import path from "node:path";
const file="output/rust-integration-20261030/experiment.json";
const exp=JSON.parse(fs.readFileSync(file,"utf8"));
const target=path.join(exp.work,"node-compact");
fs.cpSync(exp.baselineRoot,target,{recursive:true});
const source=path.join(target,"src/perf-stats.js");
const anchor="export function summarizePerf(samples, options = {}) {";
let value=fs.readFileSync(source,"utf8");
if(value.split(anchor).length!==2)throw Error("Ambiguous compact control injection");
value=value.replace(anchor,anchor+String.raw`
  if(!Array.isArray(samples)&&samples?.[PERF_UNIQUE_ITERABLE]===true){
    const original=samples;
    samples=Object.assign((function*(){
      for(const sample of original)yield {
        sampleKey:sample.sampleKey,sourceKind:sample.sourceKind,homeId:sample.homeId,channel:sample.channel,
        agentKind:sample.agentKind,agent:sample.agent,model:sample.model,modelProvider:sample.modelProvider,
        reasoningEffort:sample.reasoningEffort,timingKind:sample.timingKind,tokenScope:sample.tokenScope,
        window:sample.window,tsMs:sample.tsMs,outputTokens:sample.outputTokens,durationMs:sample.durationMs,
        sampleFlags:sample.sampleFlags,status:sample.status,methodVersion:sample.methodVersion,
      };
    })(),{[PERF_UNIQUE_ITERABLE]:true});
  }
`);
fs.writeFileSync(source,value);
exp.compactRoot=target;
fs.writeFileSync(file,JSON.stringify(exp,null,2));
console.log(JSON.stringify({compactRoot:target}));
