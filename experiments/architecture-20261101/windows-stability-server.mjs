import assert from "node:assert/strict";
import { readFile,writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const read=async file=>JSON.parse(await readFile(file,"utf8"));
if(process.argv[2]==="prepare-state"){
  process.once("message",async()=>{
    try{
      const config=await read(process.argv[3]),started=performance.now();
      const {UsageStore}=await import(pathToFileURL(path.join(config.runtime,"src/usage-store.js")));
      const {switchHistoryArchivePackages}=await import(pathToFileURL(path.join(config.runtime,"src/history-archive-compaction.js")));
      const {upgradeMapping}=await import("./archive-compaction-upgrade.mjs");
      const store=new UsageStore(config.options);let result;
      try{
        await store.open();const records=store.database.prepare("SELECT * FROM archive_segments ORDER BY start_ms,segment_id").all();
        result=await switchHistoryArchivePackages(store,upgradeMapping(records,config.packages,store.databaseFile));
        assert.equal(result.switched,config.packages.length);
      }finally{store.close();}
      await writeFile(path.join(process.argv[4],"work.json"),JSON.stringify({result,wallMs:performance.now()-started,resourceUsage:process.resourceUsage()},null,2)+"\n",{flag:"wx"});
      process.disconnect();
    }catch(error){console.error(error);process.exitCode=1;process.disconnect();}
  });
}else{
  const config=await read(process.argv[2]);const {createUsageServer}=await import(pathToFileURL(path.join(config.runtime,"src/server.js")));
  let closing=false;const server=createUsageServer({...config.options,onShutdown:()=>{
    if(closing)return;closing=true;server.close(()=>process.exit(0));
  }});
  server.on("error",error=>{console.error(error);process.exit(1);});
  server.listen(config.port,"127.0.0.1",()=>console.log(JSON.stringify({stage:"server-ready",pid:process.pid,port:server.address().port,url:`http://127.0.0.1:${server.address().port}`})));
}
