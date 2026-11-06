import "./source-prefix-publish-telemetry.mjs";
import { registerHooks } from "node:module";

// Keep the original pricing request and status write, with the same timing and unchanged rates in both versions.
registerHooks({ load(url, context, nextLoad) {
  const result = nextLoad(url, context);
  if (url.endsWith("/src/server.js")) {
    const source = String(result.source).replace("export function createUsageServer(options = {})",
      "function firstUpdateOriginalServer(options = {})");
    return { ...result, source: source + `\nexport function createUsageServer(options={}) {
      return firstUpdateOriginalServer({...options, pricingFetcher:async()=>{
        await new Promise(resolve=>setTimeout(resolve,1100));
        throw new Error('controlled unchanged-price refresh failure');
      }});
    }\n` };
  }
  if (!url.endsWith("/src/usage-store.js")) return result;
  return { ...result, source: result.source + `\n
import {appendFileSync as firstUpdateWrite} from 'node:fs';
import firstUpdatePath from 'node:path';
const firstUpdateOriginalSync = UsageStore.prototype.syncRound;
UsageStore.prototype.syncRound = async function(...args) {
 const start=Date.now(),clock=performance.now();let result,error;
 try{result=await firstUpdateOriginalSync.apply(this,args);return result;}
 catch(failure){error=String(failure.stack||failure);throw failure;}
 finally{firstUpdateWrite(firstUpdatePath.join(process.env.REMAINING_DELIVERY_TRACE,'sync-'+process.pid+'.ndjson'),
   JSON.stringify({start,end:Date.now(),durationMs:performance.now()-clock,updatedFiles:result?.updatedFileCount,
     work:this.lastSyncSourceWork,error})+'\\n');}
};
` };
} });
