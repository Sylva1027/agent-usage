import "./remaining-harness-delivery-telemetry.mjs";
import { registerHooks } from "node:module";

if (process.env.REMAINING_DELIVERY_TRACE) registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith("/src/usage-store.js")) return result;
    return { ...result, source: `${result.source}\n
import { appendFileSync as prefixAuditAppend } from 'node:fs';
import pathForPrefixAudit from 'node:path';
const prefixOriginalReplace = UsageStore.prototype.replaceFile;
UsageStore.prototype.replaceFile = async function(file, options) {
  const revision = () => Number(this.database.prepare('SELECT revision FROM usage_business_revision WHERE singleton=1').get().revision);
  const startedAtMs = Date.now(), started = performance.now(), before = revision();
  let result, error;
  try { result = await prefixOriginalReplace.call(this, file, options); return result; }
  catch (failure) { error = String(failure.stack || failure); throw failure; }
  finally {
    prefixAuditAppend(pathForPrefixAudit.join(process.env.REMAINING_DELIVERY_TRACE, 'prefix-' + process.pid + '.ndjson'),
      JSON.stringify({ pid:process.pid, kind:file.source.kind, filePath:file.filePath, startedAtMs,
        endedAtMs:Date.now(), durationMs:performance.now()-started, eventMutations:revision()-before,
        result, error }) + '\\n');
  }
};
` };
  },
});
