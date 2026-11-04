import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { catalogDigest, readCapturedPricing } from "./q5-summary-hook.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export function createQ6PerformanceHook({ version, output, proofMode, pricing, selected }) {
  const hashes = JSON.parse(fs.readFileSync(version.hashesFile, "utf8"));
  const capture = readCapturedPricing(pricing.file, pricing.catalogSha256);
  fs.mkdirSync(output, { recursive: true });
  const counters = { discoveries: 0, enumerations: 0, fingerprints: 0, proofReads: 0, nativeJournalBytes: 0 };
  const file = path.join(output, `trace-${process.pid}.ndjson`);
  const emit = (row) => fs.appendFileSync(file, JSON.stringify({ pid: process.pid, at: Date.now(), ...row }) + "\n");
  fs.writeFileSync(path.join(output, `process-${process.pid}.ndjson`), JSON.stringify({ type: "start", pid: process.pid, ppid: process.ppid }) + "\n");
  globalThis.__q6Event = (label) => emit({ label, counters: { ...counters } });
  if (process.env.Q6_CAPTURE_INTERVAL === "1") globalThis.__q6DirectoryTrace = (details) => emit({ label: "directory-diagnostic", ...details });
  globalThis.__q6Counters = counters;
  globalThis.__q6Pricing = (catalog) => {
    assert.equal(catalogDigest(catalog), pricing.catalogSha256);
    return catalog;
  };
  const selectedSet = new Set(selected);
  globalThis.__q6Wrap = (fn, label) => function (...args) {
    const start = performance.timeOrigin + performance.now();
    const before = { ...counters };
    const finish = (error, value) => {
      const filePath = typeof args[0] === "string" ? args[0] : args[0]?.filePath;
      if (label.startsWith("proof.")) {
        counters.proofReads += value?.readBytes || 0;
        counters.nativeJournalBytes += value?.journalBytes || 0;
        if (!selectedSet.has(filePath)) return;
      }
      emit({ label, start, duration: performance.timeOrigin + performance.now() - start,
        error: error?.message, errorCode: error?.code,
        certifiedOnly: args[0]?.certifiedOnly, eligible: label === "acquisition.prepare" ? Boolean(value) : undefined,
        returned: Boolean(value), receipt: Boolean(value?.acquisition),
        work: label === "store.sync" ? this.lastAcquisitionWork : label === "acquisition.prepare" ? this.work : undefined,
        sourceWork: label === "store.sync" ? this.lastSyncSourceWork : undefined,
        counters: { ...counters }, delta: Object.fromEntries(Object.keys(counters).map((key) => [key, counters[key] - before[key]])),
        path: label.startsWith("proof.") ? filePath : undefined, proofKind: value?.validation?.kind ?? value?.kind,
        readBytes: value?.readBytes, journalBytes: value?.journalBytes, fingerprint: this.fingerprint });
    };
    try {
      const value = Reflect.apply(fn, this, args);
      if (value?.then) return value.then((result) => { finish(null, result); return result; }, (error) => { finish(error); throw error; });
      finish(null, value); return value;
    } catch (error) { finish(error); throw error; }
  };
  const wrap = (type, names, prefix) => `\nfor(const name of ${JSON.stringify(names)}) {
    if(typeof ${type}.prototype[name] === 'function') ${type}.prototype[name]=globalThis.__q6Wrap(${type}.prototype[name],${JSON.stringify(prefix)}+'.'+name);
  }\n`;
  emit({ label: "hook-start", variant: version.variant, proofMode, heap: process.execArgv });
  return { load(url, context, next) {
    if (!url.startsWith("file:")) return next(url, context);
    const relative = path.relative(root, fileURLToPath(url)).replaceAll(path.sep, "/");
    if (!Object.hasOwn(hashes, relative)) return next(url, context);
    const bytes = fs.readFileSync(path.join(version.directory, relative));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hashes[relative], `Frozen runtime changed: ${relative}`);
    let source = bytes.toString();
    if (relative === "src/pricing.js") source += `\nconst q6OriginalPricing=setPricingCatalog;
      q6OriginalPricing(${JSON.stringify(capture.catalog)});globalThis.__q6Pricing(getPricingCatalog());
      setPricingCatalog=()=>globalThis.__q6Pricing(q6OriginalPricing(${JSON.stringify(capture.catalog)}));resetPricingCatalog=()=>setPricingCatalog();\n`;
    if (relative === "src/pricing-store.js") source += `\nloadPricingFile=async()=>{globalThis.__q6Pricing(getPricingCatalog());};
      ${capture.automaticStatus ? `getAutomaticPricingStatus=()=>structuredClone(${JSON.stringify(capture.automaticStatus)});` : ""}
      refreshAutomaticPricing=async()=>({changed:false,statusChanged:false,pricesUpdated:false,exchangeRateUpdated:false,
        errors:[],issues:[],...getAutomaticPricingStatus(),discovery:{addedModels:[],results:[]}});\n`;
    if (relative === "src/usage-source-native.js") {
      source += `\nexecutablePath=()=>${JSON.stringify(version.nativeBinary)};\n`;
      if (process.env.Q6_CAPTURE_INTERVAL === "1") source += `\nfor(const name of ['changes','resolve']) {
        const original=WindowsSourceProof.prototype[name];WindowsSourceProof.prototype[name]=async function(...args) {
          const value=await original.apply(this,args);globalThis.__q6DirectoryTrace({method:name,args,value});return value;
        };
      }\n`;
    }
    if (relative === "src/usage-source-proof.js") {
      if (proofMode === "sha") source += "\nUsageSourceProof.prototype.provider=async()=>null;\n";
      source += wrap("UsageSourceProof", ["verify", "capture"], "proof");
    }
    if (relative === "src/usage-core.js") source += `\nconst q6Discover=discoverUsageSources;
      discoverUsageSources=(...args)=>{globalThis.__q6Counters.discoveries++;globalThis.__q6Event('discovery');return q6Discover(...args);};\n`;
    if (relative === "src/usage-store.js") {
      source += `\nconst q6Files=UsageStore.prototype.usageFiles;
        UsageStore.prototype.usageFiles=function(...args){globalThis.__q6Counters.enumerations++;return q6Files.apply(this,args);};
        const q6Fingerprint=usageSourceFingerprint;usageSourceFingerprint=(...args)=>{globalThis.__q6Counters.fingerprints++;return q6Fingerprint(...args);};\n`;
      source += wrap("UsageStore", ["sync"], "store");
    }
    if (relative === "src/usage-source-acquisition.js") source += wrap("UsageSourceAcquisition", ["prepare"], "acquisition");
    if (relative === "src/server.js") {
      const original = source.match(/const PUBLIC_DIR = [^\n]+;/)?.[0];
      assert.ok(original); source = source.replace(original, `const PUBLIC_DIR = ${JSON.stringify(path.join(version.directory, "public"))};`);
    }
    return { source, format: "module", shortCircuit: true };
  } };
}

if (process.env.Q6_PERFORMANCE_CONFIG) {
  const config = JSON.parse(fs.readFileSync(process.env.Q6_PERFORMANCE_CONFIG, "utf8"));
  registerHooks(createQ6PerformanceHook(config));
}
