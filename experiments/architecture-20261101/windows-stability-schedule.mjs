import assert from "node:assert/strict";

export const STABILITY_KINDS = ["codex", "dsh", "claude", "workbuddy", "zcode", "opencode"];
const minute = 60_000;

export function stabilitySchedule(mode, label = "two-years") {
  assert.ok(["diagnostic", "endurance"].includes(mode));
  assert.ok(["current", "year", "two-years"].includes(label));
  const durationMs = (mode === "endurance" ? 480 : 20) * minute;
  const events = [];
  const add = (at, type, options = {}) => events.push({ atMs: at * minute, type, ...options });
  if (mode === "endurance") {
    assert.equal(label, "two-years");
    for (let i = 0; i < 240; i++) add(i * 2, "append", { kind: STABILITY_KINDS[i % 6], inputClass: "ordinary" });
    for (const at of [91, 211, 331, 451]) for (const kind of STABILITY_KINDS) add(at, "append", { kind, inputClass: "burst" });
    for (let i = 0; i < 120; i++) add(301 + i / 12, "append", { kind: i % 2 ? "dsh" : "codex", inputClass: "continuous" });
    for (const [at, type] of [[121,"price-change"],[151,"price-restore"],[241,"evidence-change"],[271,"evidence-restore"],
      [181,"revision"],[361,"revision"],[61,"arm-before-commit"],[421,"arm-after-commit"],[60,"tabs-open"],[90,"tabs-close"]]) add(at,type);
    for (let at = 5; at < 480; at += 5) add(at, "scopes");
  } else {
    for (let i = 0; i < 6; i++) add(i * 2, "append", {kind: STABILITY_KINDS[i],inputClass:"ordinary"});
    add(1,"tabs-open"); add(1.5,"scopes"); add(3,"tabs-close");
    if (label === "current") {
      add(12,"drop-hint");add(12.1,"append",{kind:"codex",inputClass:"lost-hint"});
      add(14,"disconnect");add(14.02,"append",{kind:"dsh",inputClass:"reconnect"});
      add(16,"arm-gateway-exit");add(16.1,"append",{kind:"workbuddy",inputClass:"gateway-recovery"});
    } else if (label === "year") {
      for (const [at,type] of [[12,"price-change"],[14,"price-restore"],[15,"evidence-change"],[16,"evidence-restore"],[18,"writer-lock"]]) add(at,type);
      add(18.01,"append",{kind:"codex",inputClass:"writer-lock"});
    } else {
      for(const kind of STABILITY_KINDS) add(12,"append",{kind,inputClass:"burst"});
      add(15,"append",{kind:"codex",inputClass:"late",late:true});add(17,"revision");
    }
  }
  events.sort((a,b)=>a.atMs-b.atMs);
  let appendOrdinal=0,revisionOrdinal=0;
  for(const [index,event] of events.entries()) {
    event.id=`${mode}-${label}-${String(index+1).padStart(4,"0")}`;
    if(event.type==="append")event.ordinal=++appendOrdinal;
    if(event.type==="revision")event.outputDelta=mode==="endurance"?[-7,11][revisionOrdinal++]:19;
    event.category=plannedCategory(event,events);
  }
  return {version:1,mode,label,durationMs,events,appendCount:appendOrdinal};
}

function plannedCategory(event, events) {
  if(event.type!=="append")return event.type;
  if(event.inputClass!=="ordinary")return event.inputClass;
  const windows=events.filter(row=>/^(price-|evidence-|revision$|arm-)/.test(row.type));
  const overlap=windows.find(row=>event.atMs>=row.atMs&&event.atMs<row.atMs+5*minute);
  return overlap ? `ordinary-during-${overlap.type}` : "ordinary";
}

export function quantiles(values) {
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!sorted.length)return null;
  const at=p=>sorted[Math.max(0,Math.ceil(sorted.length*p)-1)];
  return {count:sorted.length,p50:at(.5),p95:at(.95),max:sorted.at(-1)};
}

export function protectionPassed(beforeMs,afterMs) {
  assert.ok(Number.isFinite(beforeMs)&&beforeMs>=0&&Number.isFinite(afterMs)&&afterMs>=0);
  return !(afterMs>beforeMs*1.1&&afterMs-beforeMs>100);
}
