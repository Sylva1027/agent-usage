import assert from "node:assert/strict";
import test from "node:test";
import { stabilitySchedule,closeoutSchedule,CLOSEOUT_PROFILE,quantiles,protectionPassed,STABILITY_KINDS } from "./windows-stability-schedule.mjs";

test("closeout has six paired short groups and four independent thirty-minute resource cycles",()=>{
  const shorts=["current","year","two-years"].flatMap(label=>["baseline","candidate"].map(()=>closeoutSchedule("closeout-short",label)));
  assert.equal(shorts.reduce((n,s)=>n+s.appendCount,0),72);
  assert.equal(shorts.flatMap(s=>s.events).filter(e=>e.type==="revision").length,6);
  const s=closeoutSchedule("closeout-soak");
  assert.equal(s.profile,CLOSEOUT_PROFILE);assert.equal(s.version,3);assert.equal(s.observationVersion,2);
  assert.equal(s.durationMs,120*60_000);assert.equal(s.appendCount,144);
  for(const [category,count] of [["ordinary",24],["burst",24],["continuous",96]])assert.equal(s.events.filter(e=>e.inputClass===category).length,count);
  for(const cycle of s.cycles){
    const rows=s.events.filter(e=>e.cycle===cycle.cycle),offset=(cycle.cycle-1)*30*60_000;
    assert.deepEqual(rows.filter(e=>e.inputClass==="ordinary").map(e=>e.atMs-offset),[0,2,4,6,8,10].map(n=>n*60_000));
    assert.ok(rows.filter(e=>e.inputClass==="burst").every(e=>e.atMs-offset===12*60_000));
    assert.deepEqual(rows.filter(e=>e.inputClass==="continuous").map(e=>e.atMs-offset),Array.from({length:24},(_,i)=>15*60_000+i*5000));
    assert.ok(cycle.drainDeadlineAtMs<cycle.idleFromMs);assert.equal(cycle.idleToMs-cycle.idleFromMs,8*60_000);
  }
  assert.equal(s.events.filter(e=>e.type==="revision"||e.type.startsWith("arm-")).length,0);
  assert.equal(new Set(s.events.map(e=>e.id)).size,s.events.length);
  assert.equal(stabilitySchedule("endurance").durationMs,480*60_000);
});

test("eight-hour manifest has exactly 384 append records and 40 ordinary inputs per source",()=>{
  const schedule=stabilitySchedule("endurance");
  assert.equal(schedule.durationMs,8*60*60*1000);
  assert.equal(schedule.appendCount,384);
  for(const kind of STABILITY_KINDS) assert.equal(schedule.events.filter(row=>row.kind===kind&&row.inputClass==="ordinary").length,40);
  for(const [type,count] of [["ordinary",240],["burst",24],["continuous",120]])assert.equal(schedule.events.filter(row=>row.inputClass===type).length,count);
  assert.equal(schedule.events.filter(row=>row.type==="revision").length,2);
  assert.deepEqual(schedule.events.filter(row=>row.type==="revision").map(row=>row.outputDelta),[-7,11]);
  assert.equal(new Set([0,19,12,23]).size,4,"correction prefixes must have distinct totals");
  assert.equal(new Set(schedule.events.map(row=>row.id)).size,schedule.events.length);
  assert.ok(schedule.events.every((row,i)=>row.atMs<schedule.durationMs&&(!i||row.atMs>=schedule.events[i-1].atMs)));
});
test("diagnostic inputs and fault classification are fixed before execution",()=>{
  const schedules=["current","year","two-years"].map(label=>stabilitySchedule("diagnostic",label));
  assert.equal(schedules.flatMap(row=>row.events).filter(row=>row.inputClass==="ordinary").length,18);
  assert.equal(schedules[0].appendCount,9);
  assert.equal(schedules[1].appendCount,7);
  assert.equal(schedules[2].appendCount,13);
  assert.equal(schedules[2].events.filter(row=>row.late).length,1);
  const schedule=stabilitySchedule("endurance");
  assert.equal(schedule.events.find(row=>row.type==="append"&&row.atMs===122*60_000).category,"ordinary-during-price-change");
  assert.equal(schedule.events.find(row=>row.type==="append"&&row.atMs===62*60_000).category,"ordinary-during-arm-before-commit");
});
test("quantiles retain all finite samples and relative protection requires both thresholds",()=>{
  assert.deepEqual(quantiles([1,2,3,4]),{count:4,p50:2,p95:4,max:4});
  assert.equal(quantiles([]),null);
  assert.equal(protectionPassed(100,150),true);
  assert.equal(protectionPassed(1000,1101),false);
});
