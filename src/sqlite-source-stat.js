import { stat } from "node:fs/promises";

/** Keep the legacy combined size/mtime and bind each nonempty SQLite file separately. */
export async function sqliteSourceStat(dbFile) {
  const main = await stat(dbFile);
  let wal;
  try {
    const candidate = await stat(`${dbFile}-wal`);
    if (candidate.size > 0) wal = candidate;
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
  const identity = (info) =>
    info ? [info.dev, info.ino, info.birthtimeMs, info.ctimeMs, info.size, info.mtimeMs] : null;
  return {
    size: main.size + (wal?.size || 0),
    mtimeMs: Math.max(main.mtimeMs, wal?.mtimeMs || 0),
    dev: main.dev,
    ino: main.ino,
    birthtimeMs: main.birthtimeMs,
    ctimeMs: main.ctimeMs,
    sqliteObservation: JSON.stringify([identity(main), identity(wal)]),
  };
}
