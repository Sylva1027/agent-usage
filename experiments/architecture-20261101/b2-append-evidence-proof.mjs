import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { streamUsageFileEvents } from '../../src/usage-core.js';

const label = process.argv[2];
assert.match(label || '', /^[a-z0-9-]+$/i, 'Use a fresh output label');
const parent = path.resolve('output/architecture-20261103/b2');
await mkdir(parent, { recursive: true });
const directory = path.join(parent, label);
await mkdir(directory);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonl = row => Buffer.from(`${JSON.stringify(row)}\n`);
const timestamp = '2026-11-02T01:00:00.000Z';
const padding = 'x'.repeat(360);

// Raw Zstd blocks make equal-length, valid v4 frames without depending on compressor choices.
function frame(row) {
  const bytes = jsonl(row);
  assert.ok(bytes.length < 65_792);
  const small = bytes.length < 256;
  const header = Buffer.alloc(small ? 6 : 7);
  header.set([0x28, 0xb5, 0x2f, 0xfd, small ? 0x20 : 0x60]);
  if (small) header[5] = bytes.length;
  else header.writeUInt16LE(bytes.length - 256, 5);
  const block = Buffer.alloc(3);
  block.writeUIntLE((bytes.length << 3) | 1, 0, 3);
  return Buffer.concat([header, block, bytes]);
}
assert.deepEqual(zstdDecompressSync(frame({ check: padding })), jsonl({ check: padding }));

const codexRow = input => ({ type: 'event_msg', timestamp, payload: { type: 'token_count',
  info: { last_token_usage: { total_tokens: input + 200, input_tokens: input,
    cached_input_tokens: 0, output_tokens: 200, reasoning_output_tokens: 0 } }, padding } });
const dshRow = (input, seq) => ({ type: 'assistant/message', time: Date.parse(timestamp), seq,
  data: { usage: { inputTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 }, padding } });
const cases = [
  { kind: 'codex', name: 'rollout.jsonl', headers: [
    jsonl({ type: 'session_meta', payload: { id: 'proof-session', cwd: '/fixture', source: 'cli' } }),
    jsonl({ type: 'turn_context', payload: { model: 'gpt-6-sol' } }),
  ], encode: input => jsonl(codexRow(input)) },
  { kind: 'dsh', name: 'session.v4.jsonl.zstd', headers: [
    frame({ type: 'session', version: 4, id: 'proof-session', cwd: '/fixture', createdAt: Date.parse(timestamp) }),
    frame({ type: 'request/header', data: { header: { config: { model: 'deepseek-chat' } } } }),
  ], encode: (input, seq) => frame(dshRow(input, seq)) },
];

async function oracle(file, kind) {
  let events = 0, total = 0, input = 0;
  const warnings = [];
  await streamUsageFileEvents(file, { id: 'proof-home', label: 'proof', path: directory, kind }, event => {
    events += 1; total += event.usage.total; input += event.usage.input;
  }, { repositoryResolver: async () => ({ key: 'fixture', path: '/fixture', kind: 'directory' }),
    onWarning: warning => warnings.push(String(warning)) });
  assert.deepEqual(warnings, []);
  return { events, total, input };
}

async function observations(file, prefixLength) {
  const info = await stat(file);
  const bytes = await readFile(file);
  const sample = 65_536;
  return { size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino, birthtimeMs: info.birthtimeMs,
    first: sha(bytes.subarray(0, sample)),
    originalPrefixTail: sha(bytes.subarray(prefixLength - sample, prefixLength)),
    currentTail: sha(bytes.subarray(-sample)), suffix: sha(bytes.subarray(prefixLength)) };
}

const results = [];
for (const spec of cases) {
  const file = path.join(directory, spec.name);
  const rows = [...spec.headers, ...Array.from({ length: 2_000 }, (_, i) => spec.encode(1_000, i))];
  const baseline = Buffer.concat(rows);
  const middle = spec.headers.length + 1_000;
  const offset = rows.slice(0, middle).reduce((sum, row) => sum + row.length, 0);
  const replacement = spec.encode(9_000, 1_000);
  assert.equal(replacement.length, rows[middle].length);
  assert.ok(offset > 65_536 && baseline.length - offset - replacement.length > 65_536);
  await writeFile(file, baseline);
  const oldFacts = await oracle(file, spec.kind);
  const initialInfo = await stat(file);
  await appendFile(file, spec.encode(1_000, 2_000));
  const modified = new Date(Math.max(Date.now(), Math.ceil(initialInfo.mtimeMs) + 1));
  await utimes(file, modified, modified);
  const appendEvidence = await observations(file, baseline.length);
  const appendFacts = await oracle(file, spec.kind);
  const appendHash = sha(await readFile(file));
  const handle = await open(file, 'r+');
  try { assert.equal((await handle.write(replacement, 0, replacement.length, offset)).bytesWritten, replacement.length); }
  finally { await handle.close(); }
  await utimes(file, modified, modified);
  const correctionEvidence = await observations(file, baseline.length);
  const correctionFacts = await oracle(file, spec.kind);
  const correctionHash = sha(await readFile(file));
  assert.deepEqual(appendEvidence, correctionEvidence);
  assert.equal(appendEvidence.ino, initialInfo.ino);
  assert.equal(appendEvidence.birthtimeMs, initialInfo.birthtimeMs);
  assert.ok(appendEvidence.mtimeMs > initialInfo.mtimeMs);
  assert.notEqual(appendHash, correctionHash);
  assert.equal(appendFacts.events, 2_001);
  assert.equal(correctionFacts.events, 2_001);
  assert.equal(appendFacts.total, 2_001 * 1_200);
  assert.equal(correctionFacts.total, appendFacts.total + 8_000);
  results.push({ kind: spec.kind, prefixBytes: baseline.length, size: appendEvidence.size,
    sameSampledEvidence: true, fileIdentityPreserved: true, mtimeAdvanced: true, fullHashesDiffer: true,
    oldFacts, appendFacts, correctionFacts, numericDifference: correctionFacts.total - appendFacts.total,
    evidenceFields: Object.keys(appendEvidence) });
}
const result = { passed: true, results,
  boundary: 'This demonstrates equal sampled observations, not a SHA256 collision. mtime is controlled to compare the same observation contract. ctime supplies another change token, not the write range; change-journal coverage needs its own proof. No production files or user sources are modified.' };
await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
console.log(JSON.stringify(result, null, 2));
