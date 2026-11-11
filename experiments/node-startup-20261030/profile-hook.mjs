import fs from "node:fs";
import fsp from "node:fs/promises";
import {syncBuiltinESMExports} from "node:module";
import path from "node:path";
import {pathToFileURL} from "node:url";

await import("../node-index-20261030/index-hook.mjs");
const config = JSON.parse(fs.readFileSync(process.env.LOCAL_SUMMARY_CASE_CONFIG, "utf8"));
if (config.source === "profile") {
  const io = {syncReads: 0, syncBytes: 0, asyncReads: 0, asyncBytes: 0, streamBytes: 0, fileReads: 0, fileBytes: 0};
  const originalStage = globalThis.__indexStage;
  const stage = (name, extra = {}) => originalStage(name, {...extra, io: {...io}});
  globalThis.__indexStage = stage;
  const readSync = fs.readSync;
  fs.readSync = function(...args) {
    const bytes = readSync.apply(this, args);
    io.syncReads++; io.syncBytes += bytes;
    return bytes;
  };
  const open = fsp.open;
  fsp.open = async function(...args) {
    const handle = await open.apply(this, args);
    const read = handle.read;
    handle.read = async function(...readArgs) {
      const result = await read.apply(this, readArgs);
      io.asyncReads++; io.asyncBytes += result.bytesRead;
      return result;
    };
    return handle;
  };
  const stream = fs.createReadStream;
  fs.createReadStream = function(...args) {
    const result = stream.apply(this, args);
    const emit = result.emit;
    result.emit = function(event, ...values) {
      if (event === "data") io.streamBytes += Buffer.isBuffer(values[0]) ? values[0].length : Buffer.byteLength(values[0]);
      return emit.call(this, event, ...values);
    };
    return result;
  };
  const readFile = fsp.readFile;
  fsp.readFile = async function(...args) {
    const value = await readFile.apply(this, args);
    io.fileReads++; io.fileBytes += Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value);
    return value;
  };
  syncBuiltinESMExports();
  const {UsageStore} = await import(pathToFileURL(path.join(config.sourceRoot, "src/usage-store.js")).href);
  for (const name of ["timelineRange", "aggregateRange", "quotaObservations", "groupedRange", "costEstimateRange", "periodComparison", "recordsForRange", "buildRecordChampions", "repositoriesRange", "perfSummaryForRange"]) {
    const original = UsageStore.prototype[name];
    if (typeof original !== "function") throw Error("Missing startup method: " + name);
    UsageStore.prototype[name] = function(...args) {
      stage(name + ".start");
      try {
        const result = original.apply(this, args);
        stage(name + ".done");
        return result;
      } catch (error) { stage(name + ".error"); throw error; }
    };
  }
  stage("startup.ready");
}
