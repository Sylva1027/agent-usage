import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

const root = process.argv[2];
const output = process.argv[3];
if (!root || !output) throw new Error("root and output paths are required");

const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(fullPath);
    else if (entry.isFile() && /^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
}
await walk(root);

const rows = [];
for (const file of files) {
  const buffer = await readFile(file);
  let at = buffer.indexOf(magic);
  let next;
  let decompressedBytes = 0;
  let failedFrames = 0;
  let frameCount = 0;
  while (at !== -1) {
    next = buffer.indexOf(magic, at + magic.length);
    const end = next === -1 ? buffer.length : next;
    frameCount += 1;
    try {
      const decompressed = zstdDecompressSync(buffer.subarray(at, end));
      if (decompressed.length === 0) failedFrames += 1;
      else decompressedBytes += decompressed.length;
    } catch {
      failedFrames += 1;
    }
    at = next;
  }
  rows.push({
    path: path.relative(root, file).replaceAll("\\", "/"),
    compressedBytes: buffer.length,
    decompressedBytes,
    frameCount,
    failedFrames,
  });
}
rows.sort((left, right) => right.decompressedBytes - left.decompressedBytes);

const result = {
  root,
  count: rows.length,
  compressedBytes: rows.reduce((sum, row) => sum + row.compressedBytes, 0),
  decompressedBytes: rows.reduce((sum, row) => sum + row.decompressedBytes, 0),
  frameCount: rows.reduce((sum, row) => sum + row.frameCount, 0),
  failedFrames: rows.reduce((sum, row) => sum + row.failedFrames, 0),
  largestCompressed: [...rows].sort((left, right) => right.compressedBytes - left.compressedBytes)[0],
  largestDecompressed: rows[0],
  files: rows,
};

const { writeFile } = await import("node:fs/promises");
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");
