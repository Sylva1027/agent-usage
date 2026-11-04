import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import sqlite from 'node:sqlite';
import zlib from 'node:zlib';
import path from 'node:path';

if (process.env.ARCH_DSH_PROBE_DIR) {
  const stats = { reads: 0, compressedReadBytes: 0, decompressCalls: 0, decompressedBytes: 0,
    temporaryDatabases: 0, stagedRows: 0, stagedPayloadBytes: 0, temporaryPageBytes: 0 };
  const read = fsp.readFile;
  fsp.readFile = async function(file, ...args) {
    const value = await Reflect.apply(read, this, [file, ...args]);
    if (String(file).endsWith('.jsonl.zstd')) { stats.reads++; stats.compressedReadBytes += Buffer.byteLength(value); }
    return value;
  };
  const decompress = zlib.zstdDecompressSync;
  zlib.zstdDecompressSync = function(...args) {
    stats.decompressCalls++;
    const value = Reflect.apply(decompress, this, args); stats.decompressedBytes += value.length; return value;
  };
  const statements = new WeakSet();
  const prepare = sqlite.DatabaseSync.prototype.prepare;
  sqlite.DatabaseSync.prototype.prepare = function(sql, ...args) {
    const statement = Reflect.apply(prepare, this, [sql, ...args]);
    if (sql === 'INSERT INTO projections VALUES (?)') statements.add(statement);
    return statement;
  };
  const run = sqlite.StatementSync.prototype.run;
  sqlite.StatementSync.prototype.run = function(...args) {
    const result = Reflect.apply(run, this, args);
    if (statements.has(this)) { stats.stagedRows++; stats.stagedPayloadBytes += args[0].byteLength; }
    return result;
  };
  const close = sqlite.DatabaseSync.prototype.close;
  sqlite.DatabaseSync.prototype.close = function(...args) {
    const files = Reflect.apply(prepare, this, ['PRAGMA database_list']).all();
    if (files.find(row => row.name === 'main')?.file === '') {
      stats.temporaryDatabases++;
      const pages = Reflect.apply(prepare, this, ['PRAGMA page_count']).get().page_count;
      const size = Reflect.apply(prepare, this, ['PRAGMA page_size']).get().page_size;
      stats.temporaryPageBytes += Number(pages) * Number(size);
    }
    return Reflect.apply(close, this, args);
  };
  syncBuiltinESMExports();
  process.once('exit', () => {
    fs.mkdirSync(process.env.ARCH_DSH_PROBE_DIR, { recursive: true });
    fs.writeFileSync(path.join(process.env.ARCH_DSH_PROBE_DIR, `dsh-${process.pid}.json`), JSON.stringify(stats));
  });
}
