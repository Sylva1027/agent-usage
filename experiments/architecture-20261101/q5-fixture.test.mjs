import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';
import { Q5_ROOT, inside, versionSpec } from './q3-benchmark-support.mjs';
import { cloneQ5Cell, lockCanonical, prepareCanonical, prepareCellState, publishCanonicalSeed, rawFactsDigest, privateStateSnapshot } from './q5-fixture.mjs';
import { prepareScale } from './b2-page-diagnostic.mjs';
import { UsageStore } from '../../src/usage-store.js';
import { readUsageSourceProgress } from '../../src/usage-source-progress.js';
import { verifyUsageSourcePrefix } from '../../src/usage-source-proof.js';
import { WindowsSourceProof } from '../../src/usage-source-native.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const snapshot=db=>Object.fromEntries(['events','rate_limit_observations','quota_usage_sources','usage_source_baselines']
  .map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY ${table==='usage_source_baselines'?'source_path':'rowid'}`).all()]));
const T=Date.parse('2026-11-04T01:00:00Z');

test('six-source canonical setup restores only two private inputs; sequential SQLite clones retain every fact and event ID',async()=>{
  const base=path.join(Q5_ROOT,`q5-fixture-selfcheck-${process.pid}`),home=path.join(base,'original'),seed=path.join(base,'pricing-seed');
  let nativeRoot;
  try {
    await fs.mkdir(seed,{recursive:true});await fs.writeFile(path.join(seed,'pricing-auto.json'),'{}');await fs.writeFile(path.join(seed,'codex-quota.json'),'{}');
    const inputs=[];
    for(const kind of ['codex','dsh'])for(let n=0;n<3;n++) {
      const session=`smoke-${kind}-${n}`,file=path.join(home,kind==='codex'?`.codex/sessions/${session}.jsonl`:`.dsh/sessions/smoke/${session}/session.v4.jsonl.zstd`);
      let bytes;
      if(kind==='codex') {
        const usage={total_tokens:100+n,input_tokens:100+n,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0};
        bytes=Buffer.from([
          {timestamp:new Date(T).toISOString(),type:'session_meta',payload:{id:session,cwd:base,source:'cli',originator:'codex-tui'}},
          {type:'turn_context',payload:{model:'gpt-5.1-codex'}},
          {timestamp:new Date(T+n*1000).toISOString(),type:'event_msg',payload:{type:'token_count',info:{total_token_usage:usage,last_token_usage:usage}}},
        ].map(row=>JSON.stringify(row)).join('\n')+'\n');
      }else bytes=zstdCompressSync(Buffer.from([
        {type:'session',version:4,id:session,cwd:base,delegationDepth:0,createdAt:T},
        {type:'request/header',seq:1,time:T,data:{header:{config:{model:'deepseek-chat',provider:'deepseek'}}}},
        {type:'assistant/message',seq:2,time:T+n*1000,data:{turn:1,step:1,usage:{inputTokens:10,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:20+n,totalTokens:30+n}}},
      ].map(row=>JSON.stringify(row)).join('\n')+'\n'));
      await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);
      inputs.push({path:file,key:session,kind,role:'usage-file',compressed:kind==='dsh',sourceBytes:bytes.length,sha256:hash(bytes)});
    }
    for(const [file,content] of [['.codex/config.toml','model="gpt-5.1-codex"'],['.dsh/settings.json','{}']]) {
      await fs.mkdir(path.dirname(path.join(home,file)),{recursive:true});await fs.writeFile(path.join(home,file),content);
    }
    const dataset={root:home,scale:1,inputs};
    for(const proofMode of ['sha',...(process.platform==='win32'?['native']:[])]) {
    if(proofMode==='native')nativeRoot=await fs.mkdtemp(path.join(os.tmpdir(),'q5-fixture-selfcheck-'));
    const cellBase=path.join(base,proofMode),nativeBinary=versionSpec('baseline',{generation:'q5'}).nativeBinary;
    const entry={id:`1x-${proofMode}`,scale:'1x',directory:proofMode==='native'?nativeRoot:path.join(cellBase,'canonical'),
      seedDatabaseFile:path.join(cellBase,'closed-seed.sqlite')};
    const canonical=await prepareCanonical(entry,dataset,seed,{prepareScale});
    const initialized=await prepareCellState(canonical,path.join(cellBase,'initialization'));
    const store=new UsageStore({homeDir:canonical.home,databaseFile:initialized.databaseFile,env:{},importDirs:[]});
    if(proofMode==='sha')store.sourceProof.provider=async()=>null;
    else {store.sourceProof.native=new WindowsSourceProof(nativeBinary);store.sourceProof.nativePromise=Promise.resolve(store.sourceProof.native);}
    let expected;
    try {
      await store.sync();assert.equal(store.database.prepare('SELECT count(*) n FROM source_files').get().n,6);
      assert.equal(store.database.prepare('SELECT count(*) n FROM events').get().n,6);expected=snapshot(store.database);
    }finally{store.close();}
    await publishCanonicalSeed(initialized,{selfCheck:true});
    const originals=new Map(await Promise.all(inputs.map(async input=>[input.path,hash(await fs.readFile(input.path))])));
    const otherInputs=inputs.filter(input=>!Object.values(canonical.selected).some(selected=>selected.sourcePath===input.path));
    const untouched=new Map(await Promise.all(otherInputs.map(async input=>{
      const file=path.join(canonical.home,path.relative(home,input.path));return [file,{hash:hash(await fs.readFile(file)),info:await fs.stat(file)}];
    })));
    for(const variant of ['baseline','candidate']) {
      const prepared=await prepareCellState(canonical,path.join(cellBase,variant)),release=await lockCanonical(prepared);
      try {
        await assert.rejects(lockCanonical(prepared),error=>error.code==='EEXIST');
        for(const selected of Object.values(prepared.selected))await fs.appendFile(selected.targetPath,'intentional previous-cell append');
        const result=await cloneQ5Cell(prepared,{proofMode,nativeBinary,variant});assert.equal(result.restored.length,2);
        assert.equal(result.factsIdentical,true);
        assert.ok(result.proofs.every(row=>row.proofKind===(proofMode==='sha'?'sha256-prefix-v2':'ntfs-usn-v1')));
        const db=new DatabaseSync(prepared.databaseFile);
        try {
          assert.deepEqual(snapshot(db),expected,'Every raw fact and ID must survive restoration and recertification.');
          for(const selected of Object.values(prepared.selected)) {
            const progress=readUsageSourceProgress(db,selected.targetPath);assert.ok(progress);
            if(proofMode==='sha')assert.ok(await verifyUsageSourcePrefix(selected.targetPath,progress.validation,progress.checkpoint.offset,await fs.stat(selected.targetPath)));
            else {
              const proof=new WindowsSourceProof(nativeBinary);
              try{assert.ok(await proof.verify(selected.targetPath,progress.validation,progress.checkpoint.offset,await fs.stat(selected.targetPath)));}
              finally{proof.close();}
            }
            assert.equal(hash(await fs.readFile(selected.targetPath)),selected.sourceSha256);
          }
        }finally{db.close();}
        const warm=new UsageStore({homeDir:prepared.home,databaseFile:prepared.databaseFile,env:{},importDirs:[]});
        if(proofMode==='sha')warm.sourceProof.provider=async()=>null;
        else {warm.sourceProof.native=new WindowsSourceProof(nativeBinary);warm.sourceProof.nativePromise=Promise.resolve(warm.sourceProof.native);}
        try {
          await warm.sync();assert.deepEqual(snapshot(warm.database),expected);
          assert.equal(warm.lastSyncSourceWork.replacedFiles,0);assert.equal(warm.lastSyncSourceWork.appendedFiles,0);
        }finally{warm.close();}
        await assert.rejects(cloneQ5Cell(prepared),/Missing expected rejection/);
      }finally{await release();}
    }
    for(const [file,before] of untouched) {
      assert.equal(hash(await fs.readFile(file)),before.hash);const after=await fs.stat(file);
      assert.equal(after.mtimeMs,before.info.mtimeMs);assert.equal(after.ctimeMs,before.info.ctimeMs);
    }
    for(const [file,before] of originals)assert.equal(hash(await fs.readFile(file)),before);
    const closed=new DatabaseSync(entry.seedDatabaseFile,{readOnly:true});try{assert.deepEqual(snapshot(closed),expected);}finally{closed.close();}
    const state=await privateStateSnapshot({canonical:[{...entry,prepared:canonical}],setup:[],
      trials:[{directory:path.join(cellBase,'initialization')}],page:['baseline','candidate'].map(variant=>({directory:path.join(cellBase,variant)}))});
    assert.equal(state.directories.length,5);assert.ok(state.totalBytes>0);
    assert.ok(state.directories.some(row=>row.directory===canonical.stateDirectory));
    assert.ok(!state.directories.some(row=>row.directory===canonical.home));
    // A changed raw fact must fail before certification/timing even when SQLite backup itself succeeds.
    const corrupt=new DatabaseSync(entry.seedDatabaseFile);try{corrupt.exec('UPDATE events SET total=total+1 WHERE id=(SELECT min(id) FROM events)');}finally{corrupt.close();}
    const rejected=await prepareCellState(canonical,path.join(cellBase,'rejected'));
    await assert.rejects(cloneQ5Cell(rejected,{proofMode,nativeBinary}),/Cloned raw facts/);
    const check=new DatabaseSync(initialized.databaseFile,{readOnly:true});try{assert.equal(rawFactsDigest(check).events.rows,6);}finally{check.close();}
    }
  }finally {
    assert.ok(inside(Q5_ROOT,base)&&path.basename(base).startsWith('q5-fixture-selfcheck-'));
    await fs.rm(base,{recursive:true,force:true});
    if(nativeRoot) {
      assert.ok(inside(os.tmpdir(),nativeRoot)&&path.basename(nativeRoot).startsWith('q5-fixture-selfcheck-'));
      await fs.rm(nativeRoot,{recursive:true,force:true});
    }
  }
});
