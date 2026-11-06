import assert from "node:assert/strict";
import { copyFile, cp, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, hashFile, read, save, verifyRuntime } from "./remaining-harness-delivery-prepare.mjs";

const base=path.join(ROOT,"output/b3-mixed-history-20261107");
const previous=await read(path.join(ROOT,"output/opencode-regression-20261106/matrix.json"));
const frozen=await read(path.join(base,"baseline-hashes.json"));
const versions={};
for(const variant of ["baseline","candidate"]){
  const directory=path.join(base,"versions",variant), hashes={};
  const entries=Object.keys(previous.versions.candidate.hashes).filter(name=>!/^(src|public)[\\/]/.test(name));
  const source=variant==="baseline"?path.join(base,"baseline"):ROOT;
  for(const folder of ["src","public"]) for(const name of await readdir(path.join(source,folder),{recursive:true})){
    const relative=path.join(folder,name); if((await stat(path.join(source,relative))).isFile()) entries.push(relative);
  }
  for(const relative of entries){
    const production=/^(src|public)[\\/]/.test(relative);
    const input=production?path.join(source,relative):path.join(previous.versions.candidate.directory,relative);
    const target=path.join(directory,relative); await mkdir(path.dirname(target),{recursive:true});await copyFile(input,target);
    hashes[relative]=await hashFile(target);
    if(variant==="baseline"&&production) assert.equal(hashes[relative],frozen.find(item=>item.path===relative).sha256.toLowerCase());
    if(!production) assert.equal(hashes[relative],previous.versions.candidate.hashes[relative]);
  }
  versions[variant]={directory,hashes,commit:variant==="baseline"?"4c5b176":"B3 working candidate"};
  await verifyRuntime(versions[variant]);
}
for(const file of previous.files){
  assert.equal(await hashFile(file.original),file.sha256);
  if(!Object.values(previous.selected).some(selected=>selected.filePath===file.filePath)) assert.equal(await hashFile(file.filePath),file.sha256);
}
await cp(path.join(ROOT,"output/opencode-regression-20261106/seed-state"),path.join(base,"seed-state"),{recursive:true,force:false,errorOnExist:true});
await mkdir(path.join(base,"working-state"));await mkdir(path.join(base,"seed"));
await copyFile(path.join(ROOT,"output/opencode-regression-20261106/seed/result.json"),path.join(base,"seed/result.json"));
const matrix={...previous,versions,baselines:undefined,opencodeRegression:false,prefixPublication:true,
  sqliteStability:true,firstUpdateCache:true,zcodeFirstPrefix:true,
  telemetryModule:fileURLToPath(new URL("first-update-telemetry.mjs",import.meta.url)),createdAt:new Date().toISOString()};
await save(path.join(base,"matrix.json"),matrix);
await save(path.join(base,"environment.json"),{node:process.version,exec:process.execPath,versions:process.versions,
  browser:previous.runtime,heapsMiB:{gateway:512,executor:224,semiSpace:4},baseline:"4c5b176"});
console.log(JSON.stringify({prepared:true,baselineProduction:frozen.length,candidateProduction:Object.keys(versions.candidate.hashes).filter(name=>/^(src|public)[\\/]/.test(name)).length,files:previous.files.length}));
