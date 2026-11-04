import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { openRolloutStream } from '../../src/codex-rollout.js';

const base = path.resolve('output/architecture-20261102/full-startup');
const output = path.resolve('output/architecture-20261103/growth-baseline');
await mkdir(output, { recursive: true });
const captureFile = JSON.parse(await readFile(path.join(base, 'capture-pointer.json'), 'utf8')).file;
const capture = JSON.parse(await readFile(captureFile, 'utf8'));
const byPath = new Map(capture.files.map(file => [path.resolve(file.logicalPath).toLowerCase(), file]));
const db = new DatabaseSync(path.join(base, 'formal-index-stage-empty-detail/state/usage-index.sqlite'), { readOnly: true });
const key = text => createHash('sha256').update(text).digest('hex').slice(0, 20);
const family = kind => ['main','extra','jetbrains','codex'].includes(kind) ? 'codex' : kind;
function countLines(bytes) { let count = 0; for (let p = bytes.indexOf(10); p !== -1; p = bytes.indexOf(10, p + 1)) count++; return count; }
const files = [];
try {
  const rows = db.prepare(`SELECT s.*,COUNT(e.id) event_count,COUNT(DISTINCT e.session_id) session_count
    FROM source_files s LEFT JOIN events e ON e.source_path=s.path GROUP BY s.path ORDER BY s.path`).all();
  const dominant = db.prepare('SELECT session_id,COUNT(*) n FROM events WHERE source_path=? GROUP BY session_id ORDER BY n DESC,session_id LIMIT 1');
  const quota = db.prepare('SELECT COUNT(*) n FROM rate_limit_observations WHERE source_path=?');
  for (const [index, row] of rows.entries()) {
    const captured = byPath.get(path.resolve(row.path).toLowerCase());
    if (!captured) throw Error('Usage input missing from fixed capture');
    const kind = family(row.kind);
    const entry = { key: key(row.path), kind, events: Number(row.event_count), sourceBytes: Number(row.size),
      sessionKey: `session-${key(`${row.home_id}:${dominant.get(row.path)?.session_id || row.path}`)}`,
      sessions: Number(row.session_count), quotaObservations: Number(quota.get(row.path).n), rows: 0, decodedBytes: 0, frames: 0,
      compressed: String(row.path).endsWith('.jsonl.zst') || kind === 'dsh',
      capturedPath: path.resolve(capture.captureDirectory, captured.capturedPath),
      logicalPath: row.path, originalHome: row.home_path };
    if (kind === 'zcode' || kind === 'opencode') {
      entry.rows = entry.events;
    } else if (kind === 'dsh') {
      const bytes = await readFile(entry.capturedPath);
      const magic = Buffer.from([0x28,0xb5,0x2f,0xfd]);
      const offsets = []; for(let p=bytes.indexOf(magic);p!==-1;p=bytes.indexOf(magic,p+4)) offsets.push(p);
      let last = 10;
      for(let i=0;i<offsets.length;i++) {
        try { const text=zstdDecompressSync(bytes.subarray(offsets[i],offsets[i+1]??bytes.length));
          entry.decodedBytes+=text.length;entry.rows+=countLines(text);entry.frames++;if(text.length)last=text.at(-1);
        } catch { /* Match the existing DSH frame tolerance during profiling. */ }
      }
      if(last!==10)entry.rows++;
    } else {
      // Preserve the extension so the production rollout stream chooses the original decoder.
      const stream = entry.compressed ? openRolloutStream(entry.capturedPath) : createReadStream(entry.capturedPath);
      let last = 10;
      for await(const chunk of stream) {
        const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
        entry.decodedBytes+=bytes.length;entry.rows+=countLines(bytes);if(bytes.length)last=bytes.at(-1);
      }
      if(last!==10)entry.rows++;
    }
    files.push(entry);
    if(index%200===0)console.log(JSON.stringify({profiled:index+1,total:rows.length}));
  }
} finally { db.close(); }
const summary = {};
for(const f of files){const s=summary[f.kind]??={files:0,events:0,rows:0,sourceBytes:0,decodedBytes:0,compressedFiles:0};
  for(const k of ['events','rows','sourceBytes','decodedBytes'])s[k]+=f[k];s.files++;s.compressedFiles+=Number(f.compressed);}
const profile={captureFile,sourceVersion:'6d458ca+session-index+dsh-single-pass',files,summary};
await writeFile(path.join(output,'profile.json'),JSON.stringify(profile,null,2));
console.log(JSON.stringify({profileComplete:true,summary},null,2));
