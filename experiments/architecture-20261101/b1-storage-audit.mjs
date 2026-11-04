import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const label = process.argv[2];
assert.match(label || '', /^[a-z0-9-]+$/i);
const directory = path.resolve('output/architecture-20261103/growth-baseline', label);
const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
const rows = [];
for (const run of manifest.runs) {
  const database = new DatabaseSync(path.join(run.output, 'state/usage-index.sqlite'), { readOnly: true });
  try {
    const allocated = database.prepare(`SELECT COALESCE(m.tbl_name, s.name) AS owner,
      SUM(s.pgsize) bytes, SUM(s.payload) payload FROM dbstat s
      LEFT JOIN sqlite_master m ON m.name=s.name GROUP BY owner ORDER BY bytes DESC`).all();
    const record = allocated.filter(row => String(row.owner).startsWith('usage_record_'));
    const quota = allocated.filter(row => ['quota_revision', 'usage_quota_window_cache'].includes(String(row.owner)));
    const repository = allocated.filter(row => row.owner === 'usage_rollup_repositories');
    const revision = allocated.filter(row => row.owner === 'usage_business_revision');
    const business = [...record, ...quota, ...repository, ...revision];
    rows.push({ name: run.name, dataset: run.dataset, implementation: run.implementation,
      allocatedBytes: Number(database.prepare('PRAGMA page_count').get().page_count) * Number(database.prepare('PRAGMA page_size').get().page_size),
      freePages: database.prepare('PRAGMA freelist_count').get().freelist_count,
      newBusinessAllocatedBytes: business.reduce((sum, row) => sum + Number(row.bytes), 0),
      business, allocated });
  } finally { database.close(); }
}
const result = { label, note: 'SQLite allocated main-file pages, including indexes. WAL and sampled state peaks are in analysis.json. Anonymous files and transient sorters are not included.', rows };
await writeFile(path.join(directory, 'storage-audit.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify(rows.map(({ name, allocatedBytes, newBusinessAllocatedBytes }) => ({ name, allocatedBytes, newBusinessAllocatedBytes }))));
