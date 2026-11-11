import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const exp=JSON.parse(fs.readFileSync("output/rust-integration-20261030/experiment.json","utf8"));
const source=fs.readFileSync(path.join(exp.baselineRoot,"src/perf-stats.js"),"utf8");
const anchor="export function summarizePerf(samples, options = {}) {";
if(source.split(anchor).length!==2)throw Error("Ambiguous native perf injection");
const bridge=pathToFileURL(path.resolve("experiments/rust-integration-20261030/perf-adapter.mjs")).href;
const functionText=String.raw`
function summarizeRustPerf(samples, opts) {
  const { excludedSet, bounds } = perfSelectionContext(opts);
  const knownSources = opts.knownSources ?? [];
  const eraCutoffMs = resolvePerfEraCutoffMs(opts.meta?.eraCutoffMs);
  const minSamples = opts.meta?.minSamples ?? PERF_MIN_SAMPLES;
  if (typeof minSamples !== "number" || !Number.isFinite(minSamples) || minSamples < 0) throw new TypeError("meta.minSamples must be a non-negative finite number");
  const state = opts.meta?.state ?? "ready";
  if (!PERF_SUMMARY_STATES.includes(state)) throw new TypeError("Invalid perf summary state");
  const sourceWarnings=opts.meta?.sourceWarnings??[];
  if(!Array.isArray(sourceWarnings)) throw new TypeError("Invalid source warnings");
  for(const warning of sourceWarnings) if(!PERF_SOURCE_WARNING_CODES.has(warning?.code))throw new TypeError("Invalid source warning code");
  const meta={methodVersion:opts.meta?.methodVersion??PERF_METHOD_VERSION,state,indexVersion:opts.meta?.indexVersion??null,indexedAt:opts.meta?.indexedAt??null,minSamples,longWindowMs:opts.meta?.longWindowMs??PERF_LONG_WINDOW_MS,eraCutoffMs,sourceWarnings};
  const codexApplicable=knownSources.some(source=>source&&canonicalPerfSourceKind(source.kind)==="codex"&&typeof source.homeId==="string"&&source.homeId.trim()!==""&&!excludedSet.has(source.homeId.trim()));
  const compact=(function*(){
    for(const sample of samples){
      if(!sample||typeof sample!=="object"||excludedSet.has(sample.homeId))continue;
      const placement=typeof sample.tsMs!=="number"?"unplaced":"eligible";
      if(placement==="eligible"&&!perfTsInRange(sample.tsMs,bounds))continue;
      const flags=perfFlagSetOf(sample);
      const sampled=isPerfSampled(sample,flags);
      const model=trimmedString(sample.model),sourceKind=canonicalPerfSourceKind(sample.sourceKind);
      const reasoningEffort=trimmedString(sample.reasoningEffort),modelProvider=trimmedString(sample.modelProvider);
      yield {
        sourceKind:sample.sourceKind,homeId:sample.homeId,channel:sample.channel,agentKind:sample.agentKind,agent:sample.agent,
        model:sample.model,modelProvider:sample.modelProvider,reasoningEffort:sample.reasoningEffort,timingKind:sample.timingKind,
        tokenScope:sample.tokenScope,window:sample.window,tsMs:sample.tsMs,outputTokens:sample.outputTokens,durationMs:sample.durationMs,
        sampleFlags:sample.sampleFlags,methodVersion:sample.methodVersion,status:sample.status,placement,
        groupKey:perfGroupKey(sample),modelKey:JSON.stringify([sourceKind,model,reasoningEffort,modelProvider]),
        sampled,rankAdmitted:isPerfRankAdmitted(sample,flags),
        modelSampled:sampled&&!flags.has("METHOD_ESTIMATE")&&sourceKind!=="unsupported"&&model!=="",
        codexCurrent:sample.sourceKind==="codex"&&isGenerationPerfMethod(sample.methodVersion),
        missingCandidate:hasGenerationPerfSemantics(sample)&&typeof sample.tsMs==="number"&&!(sample.durationMs!==null&&sample.durationMs>0)&&model!==""&&!flags.has("MODEL_AMBIGUOUS")&&!flags.has("METHOD_ESTIMATE")&&sample.timingKind==="generation",
        droppedReason:placement==="eligible"&&sample.status!=="in_progress"&&!sampled?perfDroppedByReason(sample):null,
      };
    }
  })();
  return runRustPerf({minSamples,eraCutoffMs,codexApplicable,flagNames:PERF_FLAG_BITS,droppedReasons:PERF_DROPPED_BY_REASONS,unkeyedGroupBucket:PERF_UNKEYED_GROUP_BUCKET,meta},compact);
}
`;
const injected="import { runRustPerf } from "+JSON.stringify(bridge)+";\n"+source.replace(anchor,functionText+"\n"+anchor+"\n  if(process.env.RUST_PERF_BIN&&!Array.isArray(samples)&&samples?.[PERF_UNIQUE_ITERABLE]===true)return summarizeRustPerf(samples, options??{});\n");
fs.writeFileSync(path.join(exp.candidateRoot,"src/perf-stats.js"),injected);
console.log(JSON.stringify({candidate:exp.candidateRoot,nativePerfBridge:bridge}));
