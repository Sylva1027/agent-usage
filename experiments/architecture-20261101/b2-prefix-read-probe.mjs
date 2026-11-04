import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const label = process.argv[2];
assert.match(label || '', /^[a-z0-9-]+$/i);
const parent = path.resolve('output/architecture-20261103/b2');
await mkdir(parent, { recursive: true });
const directory = path.join(parent, label);
await mkdir(directory);
const inputs = [];
for (const scale of ['1x', '10x']) {
  const data = JSON.parse(await readFile(`output/architecture-20261103/growth-baseline/${scale}/dataset.json`, 'utf8'));
  for (const kind of ['codex', 'dsh']) {
    const file = data.inputs.filter(row => row.kind === kind && row.role === 'usage-file')
      .toSorted((a, b) => b.sourceBytes - a.sourceBytes)[0];
    assert.ok(file);
    inputs.push({ scale, kind, ...file });
  }
}
const runs = [];
for (let round = 1; round <= 3; round++) {
  for (const input of round === 2 ? [...inputs].reverse() : inputs) {
    const before = await stat(input.path);
    assert.equal(before.size, input.sourceBytes);
    const cpuStart = process.cpuUsage(), start = performance.now();
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(input.path)) {
      hash.update(chunk); bytes += chunk.length;
    }
    const elapsedMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
    assert.equal(hash.digest('hex'), input.sha256);
    assert.equal(bytes, input.sourceBytes);
    const after = await stat(input.path);
    assert.equal(after.size, before.size); assert.equal(after.mtimeMs, before.mtimeMs);
    const result = { round, scale: input.scale, kind: input.kind, bytes, elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1000 };
    runs.push(result); console.log(JSON.stringify(result));
  }
}
const groups = [];
for (const input of inputs) {
  const selected = runs.filter(row => row.scale === input.scale && row.kind === input.kind);
  const times = selected.map(row => row.elapsedMs).sort((a, b) => a - b);
  const cpu = selected.map(row => row.cpuMs).sort((a, b) => a - b);
  groups.push({ scale: input.scale, kind: input.kind, bytes: input.sourceBytes,
    medianMs: times[1], minMs: times[0], maxMs: times[2], medianCpuMs: cpu[1] });
}
const result = { passed: true, execArgv: process.execArgv, groups, runs,
  processLifetimePeakMiB: process.resourceUsage().maxRSS / 1024,
  boundary: 'Read-only full SHA256 of each longest source, three repetitions, mixed OS-cache conditions. Includes no parsing, SQL, source discovery, publication or painting. This is a lower-cost component diagnostic, not an end-to-end result or p95.' };
await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ passed: true, groups }));
