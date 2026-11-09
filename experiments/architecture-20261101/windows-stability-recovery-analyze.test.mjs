import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { analyzeWindowsStabilityRecovery,closeoutObservationErrors,analyzeWindowsCloseout } from "./windows-stability-recovery-analyze.mjs";
import { phaseAnalysis,resources,gates } from "./windows-stability-analyze.mjs";
import { stabilitySchedule,closeoutSchedule, STABILITY_KINDS } from "./windows-stability-schedule.mjs";

const MiB = 1048576, hour = 3600000, start = 1800000000000;
const save = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };
const ndjson = async (file, rows) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n"); };
const projection = { candidate: null, orphanDatabases: [], walBytes: 0, databaseCount: 1 };

test("closeout v2 rejects a wrong tab, empty version and out-of-range selected proof",()=>{
  const input={eventId:"new-1",operation:"append",kind:"workbuddy",kindCount:1,timestampMs:1000,landedAtMs:1100,
    viewPage:0,viewPreset:"week",viewUsageVersion:"fresh",viewResponseSequence:1,viewVisibleAtMs:1200,viewLandingToPaintMs:100,
    paintedPage:1,usageVersion:"fresh-all",responseSequence:2,paintedAtMs:1400,landingToPaintMs:300};
  const responses=[{page:0,preset:"week",usageVersion:"fresh",sequence:1,atMs:1150,counts:{workbuddy:1},range:{start:new Date(0).toISOString(),end:new Date(2000).toISOString()}},
    {page:1,preset:"all",usageVersion:"fresh-all",sequence:2,atMs:1350,counts:{workbuddy:1}}];
  assert.deepEqual(closeoutObservationErrors([input],responses),[]);
  for(const change of [{viewPage:1},{viewUsageVersion:""},{timestampMs:3000},{paintedPage:0},{viewLandingToPaintMs:-1}])assert.deepEqual(closeoutObservationErrors([{...input,...change}],responses),["new-1"]);
});

test("closeout canonical 144-input phase requires independent continuous publication in every cycle",()=>{
  const schedule={...closeoutSchedule("closeout-soak"),startedAtMs:start,ordinalOffset:135},reliability=gates(),performance=gates();
  const inputs=schedule.events.filter(row=>row.type==="append").map(row=>({...row,eventId:row.id,operation:"append",ordinal:row.ordinal+135,
    landedAtMs:start+row.atMs,paintedAtMs:start+row.atMs+100,landingToPaintMs:100,viewVisibleAtMs:start+row.atMs+50,viewLandingToPaintMs:50,viewUsageVersion:row.id}));
  const ledger=new Map(inputs.map(row=>[row.eventId,row])),result={passed:true,errors:[],startedAtMs:start,observedDurationMs:schedule.durationMs,drainMs:0,inputs,oracle:{passed:true}};
  phaseAnalysis("two-years","closeout-soak",schedule,result,ledger,{scopes:[]},reliability,performance,false,135,true);
  assert.ok(reliability.checks.every(row=>row.status==="passed"));assert.ok(performance.checks.every(row=>row.status==="passed"));
  assert.equal(reliability.checks.filter(row=>row.id.endsWith("continuous-publication")).length,4);
  inputs.filter(row=>row.cycle===4&&row.inputClass==="continuous").forEach(row=>row.viewUsageVersion="one-stale-version");
  const failed=gates();phaseAnalysis("two-years","closeout-soak",schedule,result,ledger,{scopes:[]},failed,gates(),false,135,true);
  assert.equal(failed.checks.find(row=>row.id.includes("cycle-4/continuous-publication")).status,"failed");
});

test("four-cycle resources use the fixed 22-to-30-minute idle windows and retain WAL growth",async t=>{
  const root=await mkdtemp(path.join(tmpdir(),"closeout-cycle-resources-"));t.after(()=>rm(root,{recursive:true,force:true}));
  const samples=[0,1,2,3].map(i=>sample(start+(i*30+24)*60_000,{bytes:(100+i)*MiB,handles:100+i}));
  samples.forEach((row,i)=>row.sqlite.categoryBytes.wal=i*100);
  const outside=sample(start+15*60_000,{bytes:400*MiB});
  await ndjson(path.join(root,"resources/resources.ndjson"),[outside,...samples]);
  const entries=[{name:"resources",isDirectory:()=>true}],phase={expectedSchedule:closeoutSchedule("closeout-soak"),schedule:{startedAtMs:start}};
  const data=await resources(root,entries,[{idle:[outside,...samples].map(row=>({atMs:row.atUnixMs}))}],{processes:[],exits:[],faults:[]},[],phase,{faults:[]},[]);
  assert.equal(data.idleCycles.length,4);assert.deepEqual(data.idleCycles.map(row=>row.memory.p50),[100,101,102,103].map(n=>n*MiB));
  assert.equal(data.walGrowth.status,"failed");assert.equal(data.handleGrowth.status,"failed");assert.equal(data.sampledPeakBytes,400*MiB);
});

test("an absent closeout group stays incomplete and never borrows legacy eight-hour success",async()=>{
  const result=await analyzeWindowsCloseout(path.join(tmpdir(),`missing-closeout-${process.pid}`));
  assert.equal(result.passed,false);assert.equal(result.statisticalP95Claim,false);assert.match(result.originalEightHourAcceptance,/incomplete/);
});

function sample(atMs, { bytes = 100 * MiB, handles = 100, tempFiles = 0, running = true } = {}) {
  const process = (pid, role, born, memory) => ({ pid, role, name: "node.exe", parentPid: role === "runner" ? 0 : 1,
    startTimeUtc: new Date(born).toISOString(), workingSetBytes: memory, privateBytes: memory,
    reportedPeakWorkingSetBytes: memory, handleCount: handles, cpuAvailable: true, cpuSeconds: 1,
    ioAvailable: true, logicalReadBytes: 100, logicalWriteBytes: 50 });
  return { atUnixMs: atMs, processes: [process(1, "runner", start - 20000, 1),
    ...(running ? [process(42, "service", start - 10000, bytes)] : [])],
  service: { processCount: running ? 1 : 0, memoryAvailableProcessCount: running ? 1 : 0,
    workingSetBytes: running ? bytes : 0, reportedPeakWorkingSetBytes: running ? bytes : 0 },
  browser: { workingSetBytes: MiB }, state: { complete: true, observedBytes: 123 },
  sqlite: { complete: true, categoryBytes: { wal: 0 } },
  temp: { complete: true, observedBytes: tempFiles * 16, fileCount: tempFiles } };
}

async function fixture(t,{multitab=false}={}) {
  const baseCount=multitab?82:48;
  const root = await mkdtemp(path.join(tmpdir(), "windows-recovery-analyze-")), directory = path.join(root, "two-years");
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("windows-recovery-analyze-"));
    await rm(root, { recursive: true, force: true });
  });
  const schedule = { ...stabilitySchedule("endurance"), startedAtMs: start, ordinalOffset: baseCount };
  const end = start + 8 * hour + 10000;
  const born = { event: "process-born", pid: 42, instance: "gateway", role: "gateway", atMs: start - 10000, startedAtMs: start - 10000 };
  const controls = [born], events = [], inputs = [], mutations = [], resourceRows = [], idle = [];
  const counts = Object.fromEntries(STABILITY_KINDS.map(kind => [kind,Array.from({length:baseCount},(_,i)=>STABILITY_KINDS[i%6]).filter(value=>value===kind).length]));
  events.push({ type: "response", preset: "all", atMs: start - 2000, sequence: 1, usageVersion: "old47", counts: { ...counts, dsh: 7 } },
    { type: "response", preset: "all", atMs: start - 1000, sequence: 2, usageVersion: "baseline48", counts: { ...counts } });
  let revision = 1, sequence = 2;
  for (const event of schedule.events) {
    events.push({ type: "scheduled-event", event, atMs: start + event.atMs });
    if (["append", "revision"].includes(event.type)) {
      const kind = event.kind ?? "zcode", landedAtMs = start + event.atMs;
      if (event.type === "append") counts[kind]++;
      const input = { eventId: event.id, operation: event.type, kind, category: event.category,
        ordinal: event.type === "append" ? event.ordinal + baseCount : ++revision, outputDelta: event.outputDelta,
        id: event.id, identity: event.id, filePath: `${kind}.log`, kindCount: counts[kind], expectedEventDelta: event.type === "append" ? 1 : 0,
        expectedDelta: event.type === "append" ? 160 : event.outputDelta,
        landedAtMs, paintedAtMs: landedAtMs + 1000, landingToPaintMs: 1000, usageVersion: event.id, responseSequence: ++sequence };
      inputs.push(input);
      const { eventId, paintedAtMs, landingToPaintMs, usageVersion, responseSequence, ...mutation } = input;
      mutations.push(mutation);
      events.push({ ...mutation, eventId, type: "input-landed", atMs: landedAtMs },
        { ...input, type: "input-visible", atMs: paintedAtMs });
      if (input.category === "ordinary") {
        controls.push({ event: "source-end", kind, atMs: landedAtMs + 50,
          method: "reuseSourcePrefix", committed: true, insertedEvents: 1, reusedEvents: 100, durationMs: 20 },
        { event: "projection", method: "applyDelta", atMs: landedAtMs + 100, coldCopied: 0, fullRebuild: false });
        if (kind === "zcode") controls.push({ event: "zcode-projection-delta", sourcePath: input.filePath,
          atMs: landedAtMs + 100, added: 1, removed: 0, netAdded: 1 });
      }
    }
    if (event.type.startsWith("arm-")) {
      const atMs = start + event.atMs + 60000 + 100, pid = 1000 + controls.length;
      const point = event.type === "arm-after-commit" ? "after-commit-before-notify" : "before-commit";
      const park = { event: "fault-parked", commandId: event.id, point, pid, ppid: 42, instance: event.id,
        atMs, startedAtMs: atMs - 100, role: "executor", usage: { maxRSS: 20 } };
      controls.push({ ...park, event: "process-born", atMs: atMs - 50 }, park,
        { event: "executor-exit", childPid: pid, atMs: atMs + 20, signal: "SIGKILL" });
      events.push({ ...park, type: "fault-observed" }, { type: "executor-killed", commandId: event.id, pid, point, atMs: atMs + 10 });
      const row = sample(atMs);
      row.processes.push({ ...row.processes[1], pid, parentPid: 42,
        startTimeUtc: new Date(park.startedAtMs).toISOString(), workingSetBytes: 20 * 1024, reportedPeakWorkingSetBytes: 20 * 1024 });
      row.service.processCount++;
      row.service.memoryAvailableProcessCount++;
      row.service.workingSetBytes += 20 * 1024;
      row.service.reportedPeakWorkingSetBytes += 20 * 1024;
      resourceRows.push(row);
    }
  }
  events.push({ type: "response", preset: "all", atMs: end, sequence: ++sequence, usageVersion: "final432", counts: { ...counts } },
    { type: "normal-close", atMs: end - 2000, projection },
    { type: "oracle", name: "endurance-final", atMs: end - 3000, result: { passed: true } },
    { type: "oracle", name: "reopen", atMs: end, result: { passed: true } });
  controls.push({ ...born, event: "process-exit", atMs: end + 1000, code: 0, usage: { maxRSS: 100 * 1024 } });
  for (let i = 0; i < 8; i++) { const atMs = start + i * hour + 61000; idle.push({ atMs }); resourceRows.push(sample(atMs)); }
  const base = { appendCount: baseCount, revisionCount: 1, entries: [
    ...Array.from({ length: baseCount }, (_, i) => ({ operation: "append", kind: STABILITY_KINDS[i % 6], ordinal: i + 1 })),
    { operation: "revision", kind: "zcode", ordinal: 1 },
  ] };
  const phase = { mode: "endurance", label: "two-years", passed: true, inputs, errors: [],
    startedAtMs: start, endedAtMs: end - 3000, observedDurationMs: 8 * hour, drainMs: 1000, oracle: { passed: true, retry: false } };
  const files = { run: path.join(root, "result.json"), preflight: path.join(root, "preflight.json"),
    recovery: path.join(directory, "recovery.json"), base: path.join(directory, "base-ledger.json"),
    phase: path.join(directory, "result-endurance.json"), schedule: path.join(directory, "schedule-endurance.json"),
    events: path.join(directory, "events.ndjson"), mutations: path.join(directory, "mutations/mutations.ndjson"),
    controls: path.join(directory, "control/events-42.ndjson"), resources: path.join(directory, "resources/resources.ndjson"),
    summary: path.join(directory, "resource-summary.json"), closed: path.join(directory, "closed.json"), reopen: path.join(directory, "final-reopen.json") };
  await save(files.run, { kind: multitab?"windows-multitab":"windows-stability-recovery",mode:"endurance", baseAppendCount: baseCount, baseRevisionCount: 1,
    passed: true, phases: [{ mode: "endurance", label: "two-years", passed: true }], startedAtMs: start - 10000, endedAtMs: end + 2000 });
  await save(files.preflight, { passed: true, baseAppendCount:baseCount, groups: (multitab?["combined-normal","combined-before","combined-after"]:["before-commit", "after-commit", "sse", "resources"]).map(name => ({ name, passed: true })), toolHashes: { runner: "a".repeat(64) } });
  await save(files.recovery, { passed: true, wallMs: 1000, expectedAppends: baseCount, beforeRecent: multitab?baseCount:47, afterRecent: baseCount,
    samePrimaryIdentity: true, sameProjectionFile: true, coldCopied: 0, fullRebuild: false, oracle: { passed: true } });
  if(multitab)await save(path.join(directory,"pending-recovery.json"),{passed:true,wallMs:1000,expectedAppends:80,beforeRecent:79,afterRecent:80,
    samePrimaryIdentity:true,sameProjectionFile:true,coldCopied:0,fullRebuild:false,oracle:{passed:true,retry:false}});
  await save(files.base, base);
  await save(files.schedule, schedule);
  await save(files.phase, phase);
  await save(files.summary, { idle });
  await save(files.closed, { failed: false, rawRestored: true, errors: [], projection, atMs: end + 2000 });
  await save(files.reopen, { wallMs: 1000, startedAtMs: end - 1000, endedAtMs: end });
  await ndjson(files.events, events);
  await ndjson(files.mutations, [...mutations, { operation: "restore", landedAtMs: end + 1500 }]);
  await ndjson(files.controls, controls);
  await ndjson(files.resources, resourceRows);
  await ndjson(path.join(directory, "nodes/node-42.jsonl"), [{ pid: 42, role: "gateway", startedAtMs: born.startedAtMs, endedAtMs: end + 1000, code: 0, usage: { maxRSS: 100 * 1024 } }]);
  await ndjson(path.join(directory, "resources-final-reopen/resources.ndjson"), [sample(end + 2000, { running: false })]);
  return { root, directory, files, schedule, phase, events, controls, inputs, mutations, resourceRows, analyze: () => analyzeWindowsStabilityRecovery(root) };
}

function gate(result, group, id) {
  const row = result[group].checks.find(row => row.id === id);
  assert.ok(row, `missing ${group} gate ${id}`);
  return row;
}

test("complete recovery and canonical new 384+2 pass independently of prior current/year failures", async t => {
  const f = await fixture(t);
  for (const label of ["current", "year"]) await save(path.join(f.root, "diagnostic", label, "result-diagnostic.json"), { passed: false });
  const result = await f.analyze();
  assert.equal(result.passed, true, JSON.stringify([result.reliability, result.resource, result.performance].flatMap(row => row.checks.filter(check => check.status !== "passed"))));
  assert.equal(result.contexts.length, 1);
  assert.equal(result.contexts[0].inputs.length, 386);
  assert.equal(result.contexts[0].phases[0].inputs.length, 386);
  assert.deepEqual(result.contexts[0].phases[0].counts, { ordinary: 240, burst: 24, continuous: 120 });
  assert.equal(result.contexts[0].events.firstAllResponse.usageVersion, "baseline48");
  assert.equal(result.contexts[0].events.initialAllResponse.usageVersion, "old47");
  assert.equal(result.contexts[0].control.sourceProgress.reduce((n, row) => n + row.observedNetAdded, 0), 384);
  assert.equal(result.historicalResults.length, 2);
  assert.ok(result.historicalResults.every(row => row.passed === undefined));
});

test("multitab continuation keeps all 82 prior appends outside the new 384 and requires the actual 79-to-80 recovery",async t=>{
  const f=await fixture(t,{multitab:true});let result=await f.analyze();
  assert.equal(result.passed,true,JSON.stringify([result.reliability,result.resource,result.performance].flatMap(row=>row.checks.filter(check=>check.status!=="passed"))));
  assert.equal(result.contexts[0].inputs.filter(row=>row.operation==="append").length,384);
  assert.ok(result.contexts[0].inputs.filter(row=>row.operation==="append").every(row=>row.ordinal>=83));
  const file=path.join(f.directory,"pending-recovery.json"),original=JSON.parse(await readFile(file,"utf8"));
  await save(file,{...original,beforeRecent:80});result=await f.analyze();
  assert.equal(gate(result,"reliability","two-years/retained-pending-recovery").status,"failed");
  await save(file,original);
  const run=JSON.parse(await readFile(f.files.run,"utf8"));await save(f.files.run,{...run,kind:"windows-stability-recovery"});
  assert.equal((await f.analyze()).passed,false,"old protocol must retain its fixed original base");
});

test("observation v2 keeps selected-range publication and all-view speed independent and rejects unsupported range proofs",async t=>{
  const f=await fixture(t,{multitab:true}),run=JSON.parse(await readFile(f.files.run,"utf8"));await save(f.files.run,{...run,observationVersion:2});
  const target=f.inputs.find(row=>row.kind==="workbuddy"&&row.category==="ordinary");
  const inputs=f.inputs.map(row=>({...row,timestampMs:row.landedAtMs,viewVisibleAtMs:row.paintedAtMs,viewLandingToPaintMs:row.landingToPaintMs,
    viewUsageVersion:row.usageVersion,viewResponseSequence:row.responseSequence,viewPage:0,viewPreset:"all"}));
  const selected=inputs.find(row=>row.eventId===target.eventId);Object.assign(selected,{paintedAtMs:selected.landedAtMs+126027,landingToPaintMs:126027,
    viewVisibleAtMs:selected.landedAtMs+46027,viewLandingToPaintMs:46027,viewPreset:"week"});
  const byId=new Map(inputs.map(row=>[row.eventId,row]));
  const views=inputs.map(row=>({...row,type:"view-visible",atMs:row.viewVisibleAtMs}));
  const responses=inputs.map(row=>({type:"response",page:0,sequence:row.viewResponseSequence,preset:row.viewPreset,
    usageVersion:row.viewUsageVersion,atMs:row.viewVisibleAtMs-1,counts:{[row.kind]:row.kindCount},revisionCount:row.ordinal,
    range:{start:new Date(row.landedAtMs-1000).toISOString(),end:new Date(row.landedAtMs+1000).toISOString()}}));
  const recorded=f.events.map(row=>row.type==="input-visible"?{...row,...byId.get(row.eventId)}:row);
  await save(f.files.phase,{...f.phase,inputs});await ndjson(f.files.events,[...recorded,...views,...responses]);
  let result=await f.analyze();assert.equal(result.reliability.passed,true,JSON.stringify(result.reliability.checks.filter(row=>row.status!=="passed")));
  assert.equal(gate(result,"performance",`two-years/endurance/${target.eventId}`).status,"failed","126s all result still fails its original speed target");
  const selectedResponse=responses.find(row=>row.sequence===selected.viewResponseSequence);
  selectedResponse.range.start=new Date(selected.timestampMs+1).toISOString();await ndjson(f.files.events,[...recorded,...views,...responses]);
  result=await f.analyze();assert.equal(gate(result,"reliability","two-years/selected-view-evidence").status,"failed");
  selectedResponse.range.start=new Date(selected.timestampMs-1).toISOString();delete selectedResponse.counts;
  await ndjson(f.files.events,[...recorded,...views,...responses]);
  assert.equal(gate(await f.analyze(),"reliability","two-years/selected-view-evidence").status,"failed");
});

test("missing evidence, including recovery, never accepts and an absent root remains analyzable", async t => {
  const f = await fixture(t);
  for (const file of Object.values(f.files)) {
    const content = await readFile(file, "utf8");
    await rm(file);
    assert.equal((await f.analyze()).passed, false, file);
    await writeFile(file, content);
  }
  const missing = await analyzeWindowsStabilityRecovery(path.join(f.root, "missing"));
  assert.equal(missing.passed, false);
  assert.equal(missing.reliability.status, "incomplete");
});

test("recovery requires the real 47-to-48 value, same files, no copies/rebuild, exact oracle, and 300s", async t => {
  const f = await fixture(t), original = JSON.parse(await readFile(f.files.recovery, "utf8"));
  for (const patch of [{ afterRecent: 47 }, { beforeRecent: 48 }, { samePrimaryIdentity: false }, { sameProjectionFile: false },
    { coldCopied: 1 }, { fullRebuild: true }, { wallMs: 300001 }, { oracle: { passed: false } }, { oracle: { passed: true, retry: true } }]) {
    await save(f.files.recovery, { ...original, ...patch });
    const result = await f.analyze();
    assert.equal(gate(result, "reliability", "two-years/same-path-recovery").status, "failed", JSON.stringify(patch));
    assert.equal(result.passed, false);
  }
});

test("missing publication fields, preflight proof, base records or node exits cannot pass", async t => {
  const f = await fixture(t);
  for (const field of ["landedAtMs", "paintedAtMs", "landingToPaintMs", "usageVersion", "responseSequence"]) {
    const inputs = structuredClone(f.inputs); delete inputs[0][field];
    const events = f.events.map(row => {
      if (row.eventId !== inputs[0].eventId) return row;
      const copy = { ...row }; delete copy[field]; return copy;
    });
    const mutations = structuredClone(f.mutations); delete mutations[0][field];
    await save(f.files.phase, { ...f.phase, inputs });
    await ndjson(f.files.events, events); await ndjson(f.files.mutations, mutations);
    assert.equal((await f.analyze()).passed, false, field);
  }
  await save(f.files.phase, f.phase); await ndjson(f.files.events, f.events); await ndjson(f.files.mutations, f.mutations);
  for (const [file, patch] of [[f.files.preflight, { passed: true, groups: Array(4).fill({ passed: true }) }],
    [f.files.base, { appendCount: 48, revisionCount: 1, entries: [] }],
    [f.files.run, { kind: "windows-stability-recovery", baseAppendCount: 48, baseRevisionCount: 1, passed: true, phases: [] }]]) {
    const original = await readFile(file, "utf8"); await save(file, patch);
    assert.equal((await f.analyze()).passed, false, file);
    await writeFile(file, original);
  }
  await rm(path.join(f.directory, "nodes/node-42.jsonl"));
  assert.equal((await f.analyze()).passed, false);
});

test("preflight requires exactly the four unique named passing groups", async t => {
  const f = await fixture(t), original = JSON.parse(await readFile(f.files.preflight, "utf8"));
  const names = ["before-commit", "after-commit", "sse", "resources"];
  for (const groupNames of [Array(4).fill("before-commit"), [...names.slice(0, 3), "sse"],
    [...names.slice(0, 3), "unknown"], [undefined, ...names.slice(1)], names.slice(0, 3), [...names, "extra"]]) {
    await save(f.files.preflight, { ...original, groups: groupNames.map(name => ({ name, passed: true })) });
    const result = await f.analyze();
    assert.equal(gate(result, "reliability", "preflight").status, "failed", JSON.stringify(groupNames));
    assert.equal(result.passed, false);
  }
  await save(f.files.preflight, { ...original, groups: original.groups.map((row, i) => ({ ...row, passed: i !== 0 })) });
  assert.equal(gate(await f.analyze(), "reliability", "preflight").status, "failed");
  await save(f.files.preflight, { ...original, groups: original.groups.toReversed() });
  assert.equal((await f.analyze()).passed, true);
});

test("a short or interrupted endurance cannot borrow old wall time or claim gateway continuity", async t => {
  const f = await fixture(t);
  for (const patch of [{ observedDurationMs: 8 * hour - 1 }, { startedAtMs: start - hour }, { endedAtMs: start + 7 * hour }, { passed: false }]) {
    await save(f.files.phase, { ...f.phase, ...patch });
    const result = await f.analyze();
    assert.notEqual(gate(result, "reliability", "two-years/endurance/gateway-continuity").status, "passed");
    assert.equal(result.passed, false);
  }
});

test("missing input and unplanned inputs fail the exact denominator", async t => {
  const f = await fixture(t), missing = f.inputs[0];
  await save(f.files.phase, { ...f.phase, inputs: f.inputs.slice(1) });
  await ndjson(f.files.events, f.events.filter(row => row.eventId !== missing.eventId));
  await ndjson(f.files.mutations, f.mutations.slice(1));
  let result = await f.analyze();
  assert.equal(result.contexts[0].inputs.length, 385);
  assert.equal(gate(result, "reliability", "two-years/new-input-counts").status, "failed");
  const extra = { ...missing, eventId: "old-retained-event", ordinal: 999 };
  await ndjson(f.files.events, [...f.events, { ...extra, type: "input-landed" }, { ...extra, type: "input-visible" }]);
  result = await f.analyze();
  assert.equal(result.contexts[0].inputs.length, 387);
  assert.equal(result.passed, false);
});

test("cleanup landings later than a failed snapshot remain in the ledger, even with only a mutation receipt", async t => {
  const f = await fixture(t), late = f.inputs.at(-1);
  await save(f.files.phase, { ...f.phase, passed: false, inputs: f.inputs.slice(0, -1), endedAtMs: late.landedAtMs - 1 });
  let result = await f.analyze();
  assert.equal(result.contexts[0].inputs.length, 386);
  assert.ok(result.contexts[0].phases[0].inputs.some(row => row.eventId === late.eventId));
  assert.equal(gate(result, "reliability", "two-years/endurance/inputs").status, "failed");
  await ndjson(f.files.events, f.events.filter(row => row.eventId !== late.eventId));
  result = await f.analyze();
  assert.equal(result.contexts[0].inputs.length, 386);
  assert.ok(result.contexts[0].inputs.some(row => row.eventId.startsWith("mutation:")));
  assert.equal(gate(result, "reliability", "two-years/mutation-ledger-agreement").status, "failed");
  assert.equal(result.passed, false);
});

function faultRecovery(f) {
  const kill = f.events.find(row => row.type === "executor-killed");
  const input = f.inputs.find(row => row.landedAtMs <= kill.atMs && row.paintedAtMs >= kill.atMs);
  const error = { type: "http-error", status: 500, code: "EXECUTOR_EXITED", controlledFaultId: kill.commandId,
    requestStartedAtMs: kill.atMs - 10, atMs: kill.atMs + 5 };
  const response = { type: "response", preset: "all", atMs: input.paintedAtMs - 1, sequence: input.responseSequence,
    usageVersion: input.usageVersion, counts: { ...f.events[1].counts, [input.kind]: input.kindCount } };
  return { error, response };
}

test("a correlated executor 500 needs an actual response carrying the newly painted value", async t => {
  const f = await fixture(t), { error, response } = faultRecovery(f);
  await ndjson(f.files.events, [...f.events, error, response]);
  let result = await f.analyze();
  assert.equal(result.passed, true);
  assert.equal(result.contexts[0].events.expectedHttpErrors.length, 1);
  for (const patch of [{ usageVersion: "baseline48" }, { counts: f.events[1].counts }, { sequence: 9999 }, { atMs: error.atMs - 1 }]) {
    await ndjson(f.files.events, [...f.events, error, { ...response, ...patch }]);
    result = await f.analyze();
    assert.equal(gate(result, "reliability", "two-years/http-recovery/1").status, "failed", JSON.stringify(patch));
    assert.equal(result.passed, false);
  }
});

test("executor 500 recovery requires a finite request start at or before the kill", async t => {
  const f = await fixture(t), { error, response } = faultRecovery(f);
  for (const requestStartedAtMs of [undefined, null, String(error.requestStartedAtMs)]) {
    await ndjson(f.files.events, [...f.events, { ...error, requestStartedAtMs }, response]);
    const result = await f.analyze();
    assert.equal(gate(result, "reliability", "two-years/unexpected-errors").status, "failed", String(requestStartedAtMs));
    assert.equal(result.contexts[0].events.expectedHttpErrors.length, 0);
    assert.equal(result.passed, false);
  }
  const kill = f.events.find(row => row.type === "executor-killed");
  await ndjson(f.files.events, [...f.events, { ...error, requestStartedAtMs: kill.atMs }, response]);
  assert.equal((await f.analyze()).passed, true);
});

test("unknown 500, false fault IDs, post-kill requests, and unrelated errors fail", async t => {
  const f = await fixture(t), { error, response } = faultRecovery(f);
  for (const patch of [{ code: "UNKNOWN" }, { controlledFaultId: "unknown" }, { requestStartedAtMs: error.atMs },
    { status: 503 }, { type: "page-error", error: "unknown" }]) {
    await ndjson(f.files.events, [...f.events, { ...error, ...patch }, response]);
    const result = await f.analyze();
    assert.equal(gate(result, "reliability", "two-years/unexpected-errors").status, "failed", JSON.stringify(patch));
    assert.equal(result.passed, false);
  }
});

test("resource limits and eight comparable idle hours are not relaxed", async t => {
  const f = await fixture(t);
  const variants = [
    ["active-memory", i => ({ bytes: i === 0 ? 513 * MiB : 100 * MiB })],
    ["idle-memory", i => ({ bytes: i === 0 ? 257 * MiB : 100 * MiB })],
    ["idle-memory-growth", i => ({ bytes: (i === 7 ? 133 : 100) * MiB })],
    ["idle-handle-growth", i => ({ handles: 100 + i })],
    ["idle-temp-file-growth", i => ({ tempFiles: i })],
    ["idle-handle-growth", i => ({ handles: i === 3 ? null : 100 })],
  ];
  for (const [id, options] of variants) {
    await ndjson(f.files.resources, f.resourceRows.map(row => {
      const i = (row.atUnixMs - start - 61000) / hour;
      return Number.isInteger(i) ? sample(row.atUnixMs, options(i)) : row;
    }));
    const result = await f.analyze();
    assert.notEqual(gate(result, "resource", `two-years/${id}`).status, "passed", id);
    assert.equal(result.passed, false);
  }
});

test("canonical times, dependencies, fault points, prefix and offset must stay unchanged", async t => {
  const f = await fixture(t);
  for (const change of [s => s.durationMs--, s => s.appendCount++, s => s.ordinalOffset--,
    s => { s.eventIdPrefix = "endurance-accepted"; }, s => s.events.find(row => row.type === "price-change").atMs++,
    s => { s.events.find(row => row.type === "arm-before-commit").type = "arm-after-commit"; }]) {
    const schedule = structuredClone(f.schedule); change(schedule); await save(f.files.schedule, schedule);
    const result = await f.analyze();
    assert.equal(gate(result, "reliability", "two-years/endurance/schedule").status, "failed");
    assert.equal(result.passed, false);
  }
});

test("a gateway restart or normal close during the eight hours fails continuity", async t => {
  const f = await fixture(t);
  for (const event of [{ event: "process-born", role: "gateway", instance: "restart", pid: 99, atMs: start + hour },
    { event: "process-exit", role: "gateway", instance: "gateway", pid: 42, atMs: start + hour, code: 0 }]) {
    await ndjson(f.files.controls, [...f.controls, event]);
    const result = await f.analyze();
    assert.equal(gate(result, "reliability", "two-years/endurance/gateway-continuity").status, "failed");
    assert.equal(result.passed, false);
  }
  await ndjson(f.files.controls, f.controls);
  await ndjson(f.files.events, [...f.events, { type: "normal-close", atMs: start + hour }]);
  assert.equal(gate(await f.analyze(), "reliability", "two-years/endurance/gateway-continuity").status, "failed");
});

test("35/45/42 second refresh, 78 second revision, and 45 second reopen targets stay independent", async t => {
  const f = await fixture(t);
  for (const [kind, operation, limit] of [["codex", "append", 35000], ["zcode", "append", 45000], ["opencode", "append", 42000], ["zcode", "revision", 78000]]) {
    const input = f.inputs.find(row => row.kind === kind && row.operation === operation && (operation === "revision" || row.category === "ordinary"));
    const changed = { ...input, landingToPaintMs: limit + 1, paintedAtMs: input.landedAtMs + limit + 1 };
    await save(f.files.phase, { ...f.phase, inputs: f.inputs.map(row => row === input ? changed : row) });
    await ndjson(f.files.events, f.events.map(row => row.eventId === input.eventId && row.type === "input-visible" ? { ...row, ...changed } : row));
    const result = await f.analyze();
    assert.equal(result.reliability.passed, true);
    assert.equal(gate(result, "performance", `two-years/endurance/${input.eventId}`).status, "failed");
    assert.equal(result.passed, false);
  }
  await save(f.files.phase, f.phase); await ndjson(f.files.events, f.events);
  await save(f.files.reopen, { wallMs: 45001 });
  const result = await f.analyze();
  assert.equal(result.reliability.passed, true);
  assert.equal(gate(result, "performance", "two-years/reopen").status, "failed");
});
