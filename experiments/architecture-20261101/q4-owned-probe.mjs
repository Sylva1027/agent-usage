import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const variant = process.argv[2];
assert.ok(['baseline','candidate'].includes(variant));
const base = path.resolve('output/architecture-20261104/q4');
const root = variant === 'baseline' ? path.join(base,'baseline') : process.cwd();
const { UsageStore } = await import(pathToFileURL(path.join(root,'src/usage-store.js')));
const store = new UsageStore({ databaseFile: ':memory:', homeDir: base });
await store.open();
store.installUsageProjectionTracker();
const results=[];
try {
  for (let round=0; round<3; round++) {
    const key=store.usageProjectionChangeKey();
    const started=performance.now();
    store.withBusinessProjection(()=>store.database.exec(`BEGIN;
      WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<300000)
      INSERT INTO usage_all_summary_members SELECT 'probe-${round}',printf('%d',n),n,n FROM rows;
      COMMIT;`));
    const wallMs=performance.now()-started;
    assert.equal(store.usageProjectionChangeKey(),key);
    results.push({round,wallMs,
      countedRows:Number(store.database.prepare('SELECT value FROM usage_projection_ignored_rows').get().value)});
  }
} finally { store.close(); }
await mkdir(path.join(base,'probe'),{recursive:true});
await writeFile(path.join(base,'probe',variant+'-owned.json'),JSON.stringify({variant,results},null,2)+'\n');
console.log(JSON.stringify({variant,results}));
