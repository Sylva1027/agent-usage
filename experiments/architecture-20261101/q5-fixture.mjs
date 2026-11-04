import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { inside, versionSpec } from './q3-benchmark-support.mjs';
import { catalogDigest, readCapturedPricing } from './q5-summary-hook.mjs';
import { readUsageSourceProgress, writeUsageSourceProgress, readUsageSourceBaseline,
  writeUsageSourceBaseline } from '../../src/usage-source-progress.js';
import { captureUsageSourcePrefix, usageSourceIdentity } from '../../src/usage-source-proof.js';

async function hashFile(file) {
  const hash=createHash('sha256'),handle=await open(file,'r');let bytes=0;
  try{for await(const chunk of handle.createReadStream()){hash.update(chunk);bytes+=chunk.length;}}
  finally{await handle.close();}
  return {sha256:hash.digest('hex'),bytes};
}

export async function captureQ5Pricing(base,seed) {
  const directory=path.join(base,'pricing-input');await mkdir(directory);
  for(const name of ['pricing-auto.json','pricing.json']) {
    try{await copyFile(path.join(seed,name),path.join(directory,name),constants.COPYFILE_EXCL);}
    catch(error){if(error.code!=='ENOENT'||name!=='pricing.json')throw error;}
  }
  const version=versionSpec('baseline',{generation:'q5'});
  const pricing=await import(pathToFileURL(path.join(version.directory,'src/pricing.js')).href);
  const store=await import(pathToFileURL(path.join(version.directory,'src/pricing-store.js')).href);
  await store.loadPricingFile({pricingFile:path.join(directory,'pricing.json'),automaticPricingFile:path.join(directory,'pricing-auto.json')});
  const catalog=pricing.getPricingCatalog(),catalogSha256=catalogDigest(catalog),file=path.join(base,'captured-pricing.json');
  await writeFile(file,JSON.stringify({catalog,catalogSha256,automaticStatus:store.getAutomaticPricingStatus()},null,2)+'\n',{flag:'wx',flush:true});
  readCapturedPricing(file,catalogSha256);
  return {file,catalogSha256,requiredFrom:'process-start',inputDirectory:directory};
}

export async function prepareCanonical(entry,dataset,seed,{prepareScale}={}) {
  assert.equal(entry.scale,`${dataset.scale}x`);
  await mkdir(entry.directory,{recursive:true});
  const prepare=prepareScale??(await import('./b2-page-diagnostic.mjs')).prepareScale;
  const prepared=await prepare(dataset,entry.directory,seed);
  for(const selected of Object.values(prepared.selected)) {
    assert.ok(inside(prepared.home,selected.targetPath));
    assert.equal((await stat(selected.targetPath)).nlink,1);
    assert.equal((await hashFile(selected.targetPath)).sha256,selected.sourceSha256);
  }
  const canonical={...prepared,canonicalId:entry.id,canonicalDirectory:entry.directory,seedDatabaseFile:entry.seedDatabaseFile};
  await writeFile(path.join(entry.directory,'canonical.json'),JSON.stringify(canonical,null,2)+'\n',{flag:'wx',flush:true});
  return canonical;
}

export async function prepareCellState(canonical,directory) {
  const stateDirectory=path.join(directory,'state');await mkdir(stateDirectory,{recursive:true});
  for(const name of ['pricing-auto.json','codex-quota.json'])
    await copyFile(path.join(canonical.stateDirectory,name),path.join(stateDirectory,name),constants.COPYFILE_EXCL);
  return {...canonical,stateDirectory,databaseFile:path.join(stateDirectory,'usage-index.sqlite'),
    importStoreFile:path.join(stateDirectory,'imports.json'),pricingFile:path.join(stateDirectory,'pricing.json'),
    automaticPricingFile:path.join(stateDirectory,'pricing-auto.json')};
}

export async function privateStateSnapshot(matrix) {
  const roots=[...matrix.canonical.flatMap(entry=>[entry.prepared?.stateDirectory,path.dirname(entry.seedDatabaseFile)]),
    ...[...matrix.trials,...matrix.setup,...matrix.page].map(entry=>path.join(entry.directory,'state'))].filter(Boolean);
  const directories=[];
  async function size(directory) {
    let bytes=0,files=0;
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory()){const nested=await size(file);bytes+=nested.bytes;files+=nested.files;}
      else if(entry.isFile()){bytes+=(await stat(file)).size;files++;}
    }
    return {bytes,files};
  }
  for(const directory of new Set(roots)) {
    try{directories.push({directory,...await size(directory)});}
    catch(error){if(error.code!=='ENOENT')throw error;}
  }
  return {at:Date.now(),directories,totalBytes:directories.reduce((n,row)=>n+row.bytes,0),
    scope:'all private canonical state, closed seeds and cell state; source mirrors and observer artifacts are separate'};
}

export async function lockCanonical(prepared) {
  assert.ok(inside(prepared.canonicalDirectory,prepared.home));
  const file=path.join(prepared.canonicalDirectory,'cell.lock');
  const handle=await open(file,'wx');await handle.writeFile(JSON.stringify({pid:process.pid,at:Date.now()}));
  return async()=>{await handle.close();await unlink(file);};
}

export async function publishCanonicalSeed(prepared,receipt) {
  assert.ok(prepared.seedDatabaseFile&&prepared.databaseFile!==prepared.seedDatabaseFile);
  await assert.rejects(stat(prepared.seedDatabaseFile),error=>error.code==='ENOENT');
  await mkdir(path.dirname(prepared.seedDatabaseFile),{recursive:true});
  const db=new DatabaseSync(prepared.databaseFile,{readOnly:true});let rawFacts;
  try{await backup(db,prepared.seedDatabaseFile);rawFacts=rawFactsDigest(db);}finally{db.close();}
  await writeFile(prepared.seedDatabaseFile+'.receipt.json',JSON.stringify({closed:true,sourceDatabaseFile:prepared.databaseFile,
    canonicalId:prepared.canonicalId,home:prepared.home,...receipt,rawFacts},null,2)+'\n',{flag:'wx',flush:true});
}

export function rawFactsDigest(db) {
  const tables={};
  for(const table of ['events','rate_limit_observations','quota_usage_sources','history_replaced_facts']) {
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;
    const statement=db.prepare(`SELECT * FROM ${table} ORDER BY rowid`);statement.setReturnArrays(true);
    const hash=createHash('sha256');let rows=0;
    hash.update(JSON.stringify(statement.columns().map(column=>column.name))+'\n');
    for(const row of statement.iterate()){hash.update(JSON.stringify(row)+'\n');rows++;}
    tables[table]={rows,sha256:hash.digest('hex')};
  }
  return tables;
}

// Matches the store's bounded file fingerprint; only the two restored sources need new metadata.
async function sourceFingerprint(file,info) {
  const hash=createHash('sha256'),handle=await open(file,'r'),length=Math.min(info.size,64*1024);
  try {
    for(const offset of info.size>length?[0,info.size-length]:[0]) {
      const bytes=Buffer.alloc(length);let read=0;
      while(read<length){const next=await handle.read(bytes,read,length-read,offset+read);assert.ok(next.bytesRead);read+=next.bytesRead;}
      hash.update(bytes);
    }
  }finally{await handle.close();}
  return `${info.size}:${info.mtimeMs}:${hash.digest('hex')}`;
}

export async function cloneQ5Cell(prepared,{proofMode='sha',nativeBinary,variant='candidate',pricingSha256,datasetSha256}={}) {
  assert.ok(['sha','native'].includes(proofMode));
  const startedAtMs=Date.now();
  const receipt=JSON.parse(await readFile(prepared.seedDatabaseFile+'.receipt.json','utf8'));
  assert.equal(receipt.closed,true);assert.equal(receipt.home,prepared.home);assert.equal(receipt.canonicalId,prepared.canonicalId);
  if(pricingSha256)assert.equal(receipt.pricing?.catalogSha256,pricingSha256,'Canonical seed pricing differs.');
  if(datasetSha256)assert.equal(receipt.datasetSha256,datasetSha256,'Canonical seed dataset differs.');
  await assert.rejects(stat(prepared.databaseFile),error=>error.code==='ENOENT');
  const restored=[];
  for(const [kind,selected] of Object.entries(prepared.selected)) {
    assert.ok(inside(prepared.home,selected.targetPath));assert.notEqual(selected.targetPath,selected.sourcePath);
    assert.equal((await stat(selected.targetPath)).nlink,1,'Only independent selected inputs may be restored.');
    assert.equal((await hashFile(selected.sourcePath)).sha256,selected.sourceSha256);
    await copyFile(selected.sourcePath,selected.targetPath);
    const actual=await hashFile(selected.targetPath);assert.equal(actual.sha256,selected.sourceSha256);
    assert.equal(actual.bytes,selected.sourceBytes);
    restored.push({kind,path:selected.targetPath,...actual});
  }
  const source=new DatabaseSync(prepared.seedDatabaseFile,{readOnly:true});
  try{await backup(source,prepared.databaseFile);}finally{source.close();}
  const clonedAtMs=Date.now();
  const db=new DatabaseSync(prepared.databaseFile);
  let native;
  try {
    assert.ok(receipt.rawFacts,'Canonical seed needs a raw fact digest.');
    const rawFacts=rawFactsDigest(db);assert.deepEqual(rawFacts,receipt.rawFacts,'Cloned raw facts / event IDs differ from the canonical seed.');
    const factsVerifiedAtMs=Date.now();
    const cursors=restored.map(row=>{
      const saved=readUsageSourceProgress(db,row.path);assert.ok(saved,`Missing canonical checkpoint: ${row.kind}`);
      return {...row,saved,baseline:readUsageSourceBaseline(db,row.path)};
    });
    if(proofMode==='native') {
      assert.ok(nativeBinary,'Native cells require the version-specific helper.');
      const {WindowsSourceProof}=await import(pathToFileURL(path.join(versionSpec(variant,{generation:'q5'}).directory,'src/usage-source-native.js')).href);
      native=new WindowsSourceProof(nativeBinary);
    }
    const fingerprints=JSON.parse(db.prepare("SELECT value FROM store_meta WHERE key='usage_file_fingerprints'").get()?.value||'{}');
    const proofs=[];
    for(const row of cursors) {
      const info=await stat(row.path);assert.equal(row.saved.checkpoint.offset,info.size,'Seed checkpoint must cover restored bytes.');
      const fingerprint=await sourceFingerprint(row.path,info);
      let proof;
      if(native) {
        const fence=await native.begin(row.path,0,info);
        if(!fence)throw Object.assign(new Error(`Native begin unavailable for ${row.kind}`),{code:'Q5_NATIVE_INELIGIBLE'});
        proof=await native.advance(row.path,fence,info.size,info);
        if(!proof)throw Object.assign(new Error(`Native seal unavailable for ${row.kind}`),{code:'Q5_NATIVE_INELIGIBLE'});
        proof.validation={...proof.validation,identity:usageSourceIdentity(info),ctimeMs:info.ctimeMs};
      }else proof=await captureUsageSourcePrefix(row.path,info.size,info);
      assert.equal(proof.validation.kind,proofMode==='native'?'ntfs-usn-v1':'sha256-prefix-v2');
      fingerprints[row.path]=fingerprint;proofs.push({...row,info,proof});
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      for(const row of proofs) {
        // Source metadata updates clear cursors/baselines; reinsert both in this same transaction.
        db.prepare('UPDATE source_files SET size=?,mtime_ms=?,indexed_at=? WHERE path=?')
          .run(row.info.size,row.info.mtimeMs,new Date().toISOString(),row.path);
        assert.equal(writeUsageSourceProgress(db,row.path,row.saved.checkpoint,row.proof.validation),true);
        writeUsageSourceBaseline(db,row.path,row.baseline);
      }
      db.prepare("INSERT OR REPLACE INTO store_meta(key,value) VALUES('usage_file_fingerprints',?)").run(JSON.stringify(fingerprints));
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
    return {startedAtMs,clonedAtMs,factsVerifiedAtMs,endedAtMs:Date.now(),rawFacts,factsIdentical:true,
      accounting:'untimed-fixture-restoration-backup-fact-hash-recertification',
      canonicalId:prepared.canonicalId,sourceDatabaseFile:prepared.seedDatabaseFile,restored,
      proofs:proofs.map(row=>({kind:row.kind,proofKind:row.proof.validation.kind,readBytes:row.proof.readBytes??0,
        journalBytes:row.proof.journalBytes??0,identity:row.proof.validation.identity}))};
  }finally{native?.close();db.close();}
}
