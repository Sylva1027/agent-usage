import assert from "node:assert/strict";
import test from "node:test";
import {DAY,KINDS,longPlan} from "./c1-datasets.mjs";

const profile={days:49,startMs:0,endMs:49*DAY,files:KINDS.flatMap((kind,index)=>{
  const file={key:`file${index}`,sessionKey:`session-${index}`,kind,events:kind==="codex"?20:10,
    sessions:2,sourceBytes:10000,decodedBytes:20000,rows:30,frames:kind==="dsh"?2:0,
    compressed:kind==="dsh",quotaObservations:kind==="codex"?11:0,projectKey:`project${index}`,projects:2,
    timeRange:{startMs:10*DAY,endMs:20*DAY}};
  return kind==="codex"?[file,{...file,key:"fragment",events:2}]:[file];
})};

test("calendar growth increases files and distinct sessions while retaining the latest source block",()=>{
  const a=longPlan(profile,365),b=longPlan(profile,730);
  assert.equal(a.endMs-a.startMs,365*DAY);assert.equal(b.endMs-b.startMs,730*DAY);
  assert.deepEqual(a.lines.filter(file=>file.key.startsWith("b000")),b.lines.filter(file=>file.key.startsWith("b000")));
  assert.ok(b.expectedFiles>a.expectedFiles);assert.ok(b.expectedSessions>a.expectedSessions);
  const latest=a.lines.filter(file=>file.key.startsWith("b000")&&file.kind==="codex");
  assert.equal(new Set(latest.map(file=>file.sessionKey)).size,1,"shared source fragments keep one session");
  assert.equal(new Set(a.lines.filter(file=>file.kind==="codex").map(file=>file.projectKey)).size,1,"history growth does not invent a repository per file");
  for(const file of b.lines){assert.ok(file.timeRange.startMs>=b.startMs);assert.ok(file.timeRange.endMs<b.endMs);assert.ok(file.timeRange.endMs>file.timeRange.startMs);}
});

test("growth has independently calculable token, quota and file totals",()=>{
  const plan=longPlan(profile,730);
  assert.equal(plan.expectedFiles,plan.lines.length+2);
  assert.equal(plan.expectedQuota,plan.lines.filter(file=>file.kind==="codex").reduce((sum,file)=>sum+file.quotaObservations,0));
  for(const row of plan.expected){assert.equal(row.total,row.events*15);assert.equal(row.input,row.events*10);assert.equal(row.output,row.events*5);}
  assert.throws(()=>longPlan(profile,48));assert.throws(()=>longPlan(profile,NaN));
});
