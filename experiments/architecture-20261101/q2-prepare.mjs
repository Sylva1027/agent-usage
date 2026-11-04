import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prepareScale } from './b2-page-diagnostic.mjs';

const label=process.argv[2];assert.match(label||'',/^q2-[a-z0-9-]+$/);
const base=path.resolve('output/architecture-20261103/q2',label);
await mkdir(base);
// Finish creating every hard link before any source fingerprint is certified.
for(const scale of ['1x','10x'])for(const variant of ['baseline','candidate']){
  const trial=path.join(base,scale+'-sha',variant);await mkdir(trial,{recursive:true});
  const dataset=JSON.parse(await readFile(path.join('output/architecture-20261103/growth-baseline',scale,'dataset.json'),'utf8'));
  const prepared=await prepareScale(dataset,path.join(trial,'fixture'),path.resolve('output/architecture-20261103/b2/page-e1-final-v8',scale,'.codex-usage'));
  await writeFile(path.join(trial,'prepared.json'),JSON.stringify(prepared,null,2)+'\n',{flush:true});
  console.log(JSON.stringify({scale,variant,prepared:true,files:prepared.mirror.files,bytes:prepared.mirror.bytes}));
}
