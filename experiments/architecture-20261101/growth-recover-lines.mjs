import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib';

// Recover the completed 10x log stage after a SQLite padding calibration failure.
const base = path.resolve('output/architecture-20261103/growth-baseline');
const one = JSON.parse(await readFile(path.join(base, '1x/dataset.json'), 'utf8'));
const profile = JSON.parse(await readFile(path.join(base, 'profile.json'), 'utf8'));
const root = path.join(base, '10x/home');
const files = [];
for (const original of one.inputs.filter(f => f.key)) {
  const baseline = profile.files.find(f => f.key === original.key);
  assert.ok(baseline);
  const file = path.join(root, path.relative(one.root, original.path));
  async function* chunks() {
    if (original.kind === 'dsh') {
      const bytes = await readFile(file), magic = Buffer.from([0x28,0xb5,0x2f,0xfd]);
      const offsets = []; for (let p = bytes.indexOf(magic); p !== -1; p = bytes.indexOf(magic,p+4)) offsets.push(p);
      for (let i=0; i<offsets.length; i++) yield zstdDecompressSync(bytes.subarray(offsets[i], offsets[i+1] ?? bytes.length));
    } else {
      const input = createReadStream(file);
      yield* original.compressed ? input.pipe(createZstdDecompress()) : input;
    }
  }
  let rows = 0, decodedBytes = 0, last = 10;
  for await (const bytes of chunks()) {
    decodedBytes += bytes.length;
    for (let p = bytes.indexOf(10); p !== -1; p = bytes.indexOf(10, p + 1)) rows += 1;
    if (bytes.length) last = bytes.at(-1);
  }
  if (last !== 10) rows += 1;
  assert.equal(rows, baseline.rows * 10, `${original.kind} row count`);
  assert.equal(decodedBytes, baseline.decodedBytes * 10, `${original.kind} decoded bytes`);
  files.push({ ...original, path: file, events: baseline.events * 10,
    quotaObservations: baseline.quotaObservations * 10, rows, decodedBytes, sourceBytes: (await stat(file)).size,
    frames: original.kind === 'dsh' ? Math.min(rows, baseline.frames * 10) : original.compressed ? 1 : 0 });
  if (files.length % 200 === 0) console.log(JSON.stringify({ recovered: files.length, total: 1966 }));
}
assert.equal(files.length, 1966);
await writeFile(path.join(base, '10x/line-inputs.json'), JSON.stringify({ scale: 10, files,
  recoveredAt: new Date().toISOString(), recovery: 'All log bytes decompressed and line/byte counts checked against profile before resuming SQLite construction.' }, null, 2));
console.log(JSON.stringify({ recovered: files.length, complete: true }));
