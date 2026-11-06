import "./first-update-telemetry.mjs";
import { registerHooks } from "node:module";

if (process.env.REMAINING_DELIVERY_TRACE) registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith("/src/usage-store.js")) return result;
    return { ...result, source: `${result.source}\n
import {appendFileSync as c1HistoryAppend} from 'node:fs';
import c1HistoryPath from 'node:path';
const c1HistoryOriginal = UsageStore.prototype.withSqlHistoryReader;
UsageStore.prototype.withSqlHistoryReader = async function(...args) {
 const startedAtMs=Date.now();let error;
 try{return await c1HistoryOriginal.apply(this,args);}
 catch(failure){error=String(failure.stack||failure);throw failure;}
 finally{c1HistoryAppend(c1HistoryPath.join(process.env.REMAINING_DELIVERY_TRACE,'history-'+process.pid+'.ndjson'),
  JSON.stringify({startedAtMs,endedAtMs:Date.now(),work:this.lastHistoryQueryWork,error,
   tempPages:this.database?.prepare('PRAGMA temp.page_count').get(),memory:process.memoryUsage()})+'\\n');}
};\n` };
  },
});
