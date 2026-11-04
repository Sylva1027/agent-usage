import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function summarizeCpu(profile) {
  const nodes=new Map(profile.nodes.map(x=>[x.id,x])), totals=new Map();
  for(let i=0;i<(profile.samples||[]).length;i++) {
    const frame=nodes.get(profile.samples[i])?.callFrame||{}, key=JSON.stringify([frame.functionName,frame.url,frame.lineNumber]);
    const row=totals.get(key)||{function:frame.functionName,url:frame.url,line:(frame.lineNumber??-1)+1,samples:0,sampledMs:0};
    row.samples++;row.sampledMs+=(profile.timeDeltas?.[i]||0)/1000;totals.set(key,row);
  }
  return {elapsedMs:(profile.endTime-profile.startTime)/1000,samples:profile.samples?.length||0,
    top:[...totals.values()].sort((a,b)=>b.sampledMs-a.sampledMs).slice(0,40),
    semantics:'Profiler sample deltas attributed to sampled leaf frames; include idle/runtime gaps, are not exclusive OS CPU counters.'};
}
export function summarizeHeap(data) {
  const nf=data.snapshot.meta.node_fields, ef=data.snapshot.meta.edge_fields;
  const width=nf.length, ew=ef.length, typeAt=nf.indexOf('type'),nameAt=nf.indexOf('name'),sizeAt=nf.indexOf('self_size'),countAt=nf.indexOf('edge_count');
  const edgeType=ef.indexOf('type'),toAt=ef.indexOf('to_node');
  const nodeTypes=data.snapshot.meta.node_types[typeAt],edgeTypes=data.snapshot.meta.edge_types[edgeType];
  const nodes=data.nodes,edges=data.edges,strings=data.strings,groups=new Map();let total=0,target=null;
  const nameOf=off=>strings[nodes[off+nameAt]],typeOf=off=>nodeTypes[nodes[off+typeAt]];
  for(let off=0;off<nodes.length;off+=width) {
    const type=typeOf(off),name=nameOf(off),size=nodes[off+sizeAt];total+=size;
    const safeName=/string/.test(type)?'[string contents omitted]':name;
    const key=type+'\0'+safeName,row=groups.get(key)||{type,name:safeName,nodes:0,selfBytes:0};
    row.nodes++;row.selfBytes+=size;groups.set(key,row);
    if(target===null&&type==='native'&&/JSArrayBufferData/.test(name)&&size>1024*1024)target=off;
  }
  let frontier=target===null?[]:[{offset:target,path:[{type:typeOf(target),name:nameOf(target),selfBytes:nodes[target+sizeAt]}]}];
  const seen=new Set(frontier.map(x=>x.offset)), paths=[];
  for(let depth=0;depth<9&&frontier.length;depth++) {
    const wanted=new Map(frontier.map(x=>[x.offset,x])),next=[];let edge=0;
    for(let off=0;off<nodes.length;off+=width) {
      const count=nodes[off+countAt];
      for(let j=0;j<count;j++,edge+=ew) {
        if(edgeTypes[edges[edge+edgeType]]==='weak')continue;
        const child=wanted.get(edges[edge+toAt]);if(!child||seen.has(off))continue;
        const entry={offset:off,path:[...child.path,{type:typeOf(off),name:nameOf(off),selfBytes:nodes[off+sizeAt]}]};
        if(/HistoryQuoteInputs|UsageStore/.test(nameOf(off)))paths.push(entry.path);
        if(next.length<500){next.push(entry);seen.add(off);}
      }
    }
    frontier=next;
    if(paths.some(x=>x.at(-1).name==='UsageStore'))break;
  }
  return {nodes:nodes.length/width,totalSelfBytes:total,
    top:[...groups.values()].sort((a,b)=>b.selfBytes-a.selfBytes).slice(0,30),quoteRetainerPaths:paths.slice(0,6),
    semantics:'V8 heap graph self sizes and strong incoming paths; native SQLite/runtime allocations and resident-page sharing are not fully represented. String payloads omitted. Snapshot runs are excluded from normal latency/RSS scores.'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const file=path.resolve(process.argv[2]),data=JSON.parse(readFileSync(file,'utf8'));
  const result=file.endsWith('.heapsnapshot')?summarizeHeap(data):summarizeCpu(data);
  writeFileSync(file+'.analysis.json',JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({file,nodes:result.nodes,samples:result.samples,top:result.top.slice(0,12),quoteRetainerPaths:result.quoteRetainerPaths}));
}
