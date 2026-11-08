import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { switchHistoryArchivePackages } from "../../src/history-archive-compaction.js";
import { getPricingCatalog, setPricingCatalog as setCurrentPricing } from "../../src/pricing.js";
import { clean, makeCompactionFixture } from "../../test-support/history-compaction-fixture.mjs";
import { verifyFrozenRuntime } from "./persistent-history-prepare.mjs";

const runtimeFile=path.resolve(process.argv[2]), output=path.resolve(process.argv[3]);
const runtime=JSON.parse(await readFile(runtimeFile,"utf8")); await verifyFrozenRuntime(runtime);
const {UsageStore}=await import(pathToFileURL(path.join(runtime.directory,"src/usage-store.js")));
const {setPricingCatalog}=await import(pathToFileURL(path.join(runtime.directory,"src/pricing.js")));
const catalog=structuredClone(getPricingCatalog());
setCurrentPricing(catalog);setPricingCatalog(catalog);
const rows=[];
for(const pending of [false,true]) {
  const cleanups=[],f=await makeCompactionFixture({after:callback=>cleanups.push(callback)});
  let old;
  try {
    f.reviseCold(3);f.append();
    const expected=clean(await f.read()),mapping=await f.prepareMapping();
    if(pending)f.store.withSqlHistoryReader=()=>{throw new Error("leave committed rebind pending")};
    if(pending)await assert.rejects(switchHistoryArchivePackages(f.store,mapping),/leave committed rebind pending/);
    else await switchHistoryArchivePackages(f.store,mapping);
    const homes=f.store.homes,evidence=f.store.serviceTierEvidence,input=f.store.serviceTierEvidenceInput;
    f.store.close();
    old=new UsageStore({databaseFile:f.file,homeDir:f.root,env:{},importDirs:[],automaticDiscoveryEnabled:false});
    await old.open();old.homes=homes;old.serviceTierEvidence=evidence;old.serviceTierEvidenceInput=input;
    const report=await old.dashboardHistory(f.filters,{includeDetails:false});
    assert.deepEqual(clean(report),expected);
    rows.push({pending,exact:true,events:report.summary.eventCount,projection:old.lastHistoryQueryWork.projection});
  } finally {old?.close();for(const cleanup of cleanups.reverse())await cleanup();}
}
await writeFile(output,JSON.stringify({runtimeFile,rows,passed:true},null,2),{flag:"wx"});
console.log(JSON.stringify({passed:true,cases:rows.length,pendingFallbackRebuilt:rows[1].projection.rebuilt}));
