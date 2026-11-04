import ts from 'typescript';
import path from 'node:path';
import {readFileSync,writeFileSync} from 'node:fs';
const functions = {
  'src/usage-core.js': ['discoverUsageSources','buildUsageFingerprint','usageOptions','streamUsageFileEvents'],
  'src/usage-source-progress.js': ['writeUsageSourceBaseline','markUsageSourceDependents','writeUsageSourceProgress'],
  'src/usage-store.js': ['usageSourceFingerprint','createFusedSummaryGroups','createFusedSummaryRepositories','createFusedMetadataObservations'],
  'src/usage-source-proof.js': ['verifyUsageSourcePrefix','captureUsageSourcePrefix'],
  'src/service-tier-evidence.js': ['loadServiceTierEvidence'],
  'src/quota-source-evidence.js': ['loadQuotaSourceEvidence'],
  'src/usage-rollups.js': ['rebuildUsageRollups','rebuildDirtyUsageRollups','rebuildUsageRollupsFromEvents','queryUsageRollupsRange','queryUsageRollupRepositories'],
  'src/usage-record-store.js': ['buildStoredRecordChampions','appendStoredRecordChampions','readStoredRecordChampions'],
  'src/usage-quota-store.js': ['selectStoredQuotaWindows','createObservationSource','chooseLimit','currentStoredWindow','lastCompletedWindow','createCycleTable','dropObservationSource'],
  'src/pricing.js': ['createEventPricing','createCostEstimateAccumulator'],
  'public/timeline-utils.js': ['buildTimelineRows'],
  'public/period-comparison.js': ['summarizePeriodComparison'],
  'src/server.js': ['loadUsageStore','requestUsageWake','broadcastUsageSync','sendJson','handleRequest'],
  'src/usage-executor.js': ['spawn','ensureChild','request','executeMessage','handle','initialize','send','toWire','toTransferable'],
};
const classes = {
  'src/usage-store.js': ['UsageStore','open','sync','syncRound','appendFile','replaceFile','repairSourceDependencies','prepareHotRollups','prepareQuotaProjection','prepareRecordProjection','summarizeInReadTransactionCore','summaryProjectionKeys','dashboardHistory','summarizeHistory','metadataHistory','periodComparisonHistory','aggregateRange','timelineRange','costEstimateRange','recordsForRange','periodAggregate','groupedRange','repositoriesRange','metadata','periodComparison','stateSnapshot','persistSourceProgress','close'],
  'src/usage-summary-cache.js': ['UsageSummaryCache','open','readSourceState','readPublication','stateFor','get','publish'],
  'src/usage-source-proof.js': ['UsageSourceProof','begin','verify','capture'],
  'src/usage-source-native.js': ['WindowsSourceProof','begin','verify','advance'],
  'src/history-quote-inputs.js': ['HistoryQuoteInputs','finish','discard'],
  'src/usage-session-members.js': ['UsageSessionMembers','createSet','spill','close'],
};
const names = {'src/usage-store.js':'store','src/usage-executor.js':'executor','src/server.js':'server','src/history-quote-inputs.js':'quote','src/usage-source-proof.js':'source.proof'};
export function transform(source, file) {
  const label = names[file] || path.basename(file,'.js');
  const targets = new Set(functions[file] || []);
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), edits=[];
  const walk = node => {
    if(file==='src/usage-store.js' && ts.isIfStatement(node) && node.expression.getText(tree)==='memberBytes > 1024 * 1024')
      edits.push({pos:node.thenStatement.statements[0].getStart(tree),text:'globalThis.__q0.note({type:"fused-groups-budget-exceeded",memberBytes});\n'});
    if(file==='src/server.js' && ts.isIfStatement(node) && node.expression.getText(tree).includes('afterRead.inputs === source.inputs'))
      edits.push({pos:node.getStart(tree),text:'globalThis.__q0.note({type:"publish-guard",inputsEqual:afterRead.inputs===source.inputs,publicationEqual:afterRead.publication?.signature===source.publication?.signature,beforePublication:source.publication?.signature,afterPublication:afterRead.publication?.signature});\n'});
    if(ts.isFunctionDeclaration(node) && node.name && targets.has(node.name.text)) {
      edits.push({pos:node.end,text:`\n${node.name.text} = globalThis.__q0.wrap(${node.name.text}, ${JSON.stringify(label+'.'+node.name.text)});\n`});
    }
    if(ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && targets.has(node.name.text) && node.initializer && (ts.isArrowFunction(node.initializer)||ts.isFunctionExpression(node.initializer))) {
      edits.push({pos:node.initializer.getStart(tree),text:'globalThis.__q0.wrap('},{pos:node.initializer.end,text:`, ${JSON.stringify(label+'.'+node.name.text)})`});
    }
    if(file==='src/server.js' && ts.isFunctionExpression(node) && node.name?.text==='handleRequest') {
      edits.push({pos:node.getStart(tree),text:'globalThis.__q0.wrap('},{pos:node.end,text:', "server.handleRequest")'});
    }
    ts.forEachChild(node,walk);
  }; walk(tree);
  for(const e of edits.sort((a,b)=>b.pos-a.pos)) source=source.slice(0,e.pos)+e.text+source.slice(e.pos);
  if(classes[file]) {
    const [cls,...methods]=classes[file];
    source += `\nfor (const n of ${JSON.stringify(methods)}) { const d=Object.getOwnPropertyDescriptor(${cls}.prototype,n); if(d && typeof d.value==='function') Object.defineProperty(${cls}.prototype,n,{...d,value:globalThis.__q0.wrap(d.value,${JSON.stringify(label+'.')}+n)}); }\n`;
    if(file==='src/usage-store.js') source += '\nUsageStore.prototype.costEventsForRange=globalThis.__q0.iterator(UsageStore.prototype.costEventsForRange,"cost.rows");\n';
  }
  return source;
}
export function compile(file) {
 const output={};
 for(const name of new Set([...Object.keys(functions),...Object.keys(classes)])) output[name]=transform(readFileSync(name,'utf8'),name);
 writeFileSync(file,JSON.stringify(output));
}
