import {createHash} from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";

const rootArg = process.argv[2];
if (!rootArg) throw new Error("Usage: node content-measure.mjs <baseline|contentRoot>");
const root = path.resolve(rootArg);
const sourceFile = path.join(root, "src", "usage-core.js");
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "content-measure-"));
const file = path.join(fixture, "rollout.jsonl");
fs.writeFileSync(file, Buffer.alloc(1536 * 1024 + 137, 0x61));

const counters = {
  syncReads: 0,
  syncBytes: 0,
  asyncReads: 0,
  asyncBytes: 0,
};
const originalReadSync = fs.readSync;
fs.readSync = function (...args) {
  const bytes = originalReadSync.apply(this, args);
  counters.syncReads += 1;
  counters.syncBytes += bytes;
  return bytes;
};
const originalOpen = fsp.open;
fsp.open = async function (...args) {
  const handle = await originalOpen.apply(this, args);
  const read = handle.read;
  handle.read = async function (...readArgs) {
    const result = await read.apply(this, readArgs);
    counters.asyncReads += 1;
    counters.asyncBytes += result.bytesRead;
    return result;
  };
  return handle;
};
syncBuiltinESMExports();

function reset() {
  counters.syncReads = 0;
  counters.syncBytes = 0;
  counters.asyncReads = 0;
  counters.asyncBytes = 0;
}

try {
  const module = await import(pathToFileURL(sourceFile).href);
  const home = {kind: "codex"};
  reset();
  const sync = module.perfHomeContentFingerprint(home, [file], null, true);
  const syncIo = {...counters};
  reset();
  const asyncValue = await module.codexPlanningFingerprintAsync(home, [file]);
  const asyncIo = {...counters};
  const bytes = fs.readFileSync(file);
  const expectedDigest = createHash("sha256").update(bytes).digest("hex");
  if (sync.filePrefixEvidence[file].digest !== expectedDigest) throw new Error("sync prefix digest mismatch");
  if (asyncValue.filePrefixEvidence[file].digest !== expectedDigest) throw new Error("async prefix digest mismatch");
  console.log(
    JSON.stringify(
      {
        root,
        fileBytes: bytes.length,
        sync: {io: syncIo, fingerprint: sync.fileFingerprints[file]},
        async: {io: asyncIo, fingerprint: asyncValue.fileFingerprints[file]},
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(fixture, {recursive: true, force: true});
}
