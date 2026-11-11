import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CONFIG_FILE = path.resolve("output/node-index-20261030/experiment.json");
const WORKER_IMPORT = 'import { Worker, parentPort, workerData } from "node:worker_threads";\n';
const FS_IMPORT = 'import { readdir, stat } from "node:fs/promises";';
const FS_IMPORT_WITH_OPEN = 'import { open, readdir, stat } from "node:fs/promises";';
const SYNC_FINGERPRINT = "function perfHomeContentFingerprint(";
const EXPORTED_SYNC_FINGERPRINT = "export function perfHomeContentFingerprint(";
const OLD_PLANNING_START = [
  "/** @param {any} home @param {string[]} files */",
  "async function codexPlanningFingerprint(home, files) {",
].join("\n");
const OLD_PLANNING_END = [
  "/**",
  " * M4.1 返工1（复核 P1）：**已启用性能来源**的内容指纹聚合",
].join("\n");

export const PROFILE_ANCHORS = Object.freeze([
  "    before = await codexPlanningFingerprint(home, files);",
  "      plan = await planCodexHomeThreads(",
  "      after = perfHomeContentFingerprint(home, afterFiles);",
  "  if (scanError !== null || before === null || after === null || afterFiles === null) {",
]);

function occurrences(text, anchor) {
  return text.split(anchor).length - 1;
}

function replaceOnce(text, anchor, replacement) {
  const count = occurrences(text, anchor);
  if (count !== 1) throw new Error(`Expected one anchor, found ${count}: ${anchor}`);
  return text.replace(anchor, replacement);
}

function assertAnchors(text) {
  for (const anchor of PROFILE_ANCHORS) {
    const count = occurrences(text, anchor);
    if (count !== 1) throw new Error(`Expected one profile anchor, found ${count}: ${anchor}`);
  }
  for (const forbidden of ["node:worker_threads", "new Worker(", "parentPort.postMessage"]) {
    if (text.includes(forbidden)) throw new Error(`Worker anchor remains: ${forbidden}`);
  }
}

export function rebuildPrefixSource(source) {
  let text = replaceOnce(source, WORKER_IMPORT, "");
  text = replaceOnce(text, FS_IMPORT, FS_IMPORT_WITH_OPEN);
  text = replaceOnce(text, SYNC_FINGERPRINT, EXPORTED_SYNC_FINGERPRINT);

  const start = text.indexOf(OLD_PLANNING_START);
  const end = text.indexOf(OLD_PLANNING_END, start + OLD_PLANNING_START.length);
  if (start < 0 || end < 0) throw new Error("Missing existing codexPlanningFingerprint block");
  const oldBlock = text.slice(start, end);
  for (const anchor of ["new Worker(", "workerData", "codex-prefix-window"]) {
    if (!oldBlock.includes(anchor)) throw new Error(`Missing old worker anchor: ${anchor}`);
  }

  const replacement = `const PERF_PREFIX_READER_COUNT = 2;
const PERF_PREFIX_READ_BYTES = 1024 * 1024;

/**
 * Hash one file with an async reader that reuses the shard's buffer.
 *
 * @param {string} filePath
 * @param {Buffer} buffer
 * @returns {Promise<{ size: number, digest: string } | null>}
 */
async function perfFilePrefixEvidenceAsync(filePath, buffer) {
  let handle = null;
  try {
    const size = statSync(filePath).size;
    const hash = createHash("sha256");
    handle = await open(filePath, "r");
    let offset = 0;
    while (offset < size) {
      const length = Math.min(buffer.length, size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead <= 0) return null;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return { size, digest: hash.digest("hex") };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function perfCodexPrefixShard(home, files, buffer) {
  /** @type {Record<string, string>} */
  const fileFingerprints = {};
  /** @type {Record<string, { size: number, digest: string }>} */
  const filePrefixEvidence = {};
  let complete = true;
  for (const filePath of files) {
    const fingerprint = perfContentFingerprint(home?.kind, filePath);
    if (fingerprint === null) complete = false;
    else fileFingerprints[filePath] = fingerprint;
    if (canonicalPerfKind(home?.kind) === "codex" && fingerprint !== null) {
      const prefix = await perfFilePrefixEvidenceAsync(filePath, buffer);
      if (prefix === null) complete = false;
      else filePrefixEvidence[filePath] = prefix;
    }
  }
  return { complete, fileFingerprints, filePrefixEvidence };
}

/** @param {any} home @param {string[]} files */
export async function codexPlanningFingerprintAsync(home, files) {
  const shards = Array.from({ length: PERF_PREFIX_READER_COUNT }, () => ({ bytes: 0, files: [] }));
  const entries = files.map((file) => {
    try {
      return { file, size: statSync(file).size };
    } catch {
      return { file, size: 0 };
    }
  });
  for (const entry of entries.sort((left, right) => right.size - left.size)) {
    const shard = shards[0].bytes <= shards[1].bytes ? shards[0] : shards[1];
    shard.files.push(entry.file);
    shard.bytes += entry.size;
  }
  const windows = await Promise.allSettled(
    shards.map(({ files: shard }) =>
      perfCodexPrefixShard(home, shard, Buffer.alloc(PERF_PREFIX_READ_BYTES)),
    ),
  );
  const failure = windows.find((window) => window.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  const hash = createHash("sha256");
  /** @type {Record<string, string>} */
  const fileFingerprints = {};
  /** @type {Record<string, { size: number, digest: string }>} */
  const filePrefixEvidence = {};
  let complete = true;
  for (const window of windows) {
    if (window.status !== "fulfilled") continue;
    complete &&= window.value.complete;
    Object.assign(fileFingerprints, window.value.fileFingerprints);
    Object.assign(filePrefixEvidence, window.value.filePrefixEvidence);
  }
  for (const file of files) hash.update(\`\${file}\\t\${fileFingerprints[file] ?? "!"}\\n\`);
  return { fingerprint: hash.digest("hex"), complete, fileFingerprints, filePrefixEvidence };
}

/** @param {any} home @param {string[]} files */
async function codexPlanningFingerprint(home, files) {
  // Only the serialized store sync opts in; concurrent full reports stay synchronous.
  if (!home.parallelPrefix) return perfHomeContentFingerprint(home, files, null, true);
  // Small homes keep the synchronous path; async setup costs more than their hash work.
  let entries;
  try {
    entries = files.map((file) => ({ file, size: statSync(file).size }));
  } catch {
    return perfHomeContentFingerprint(home, files, null, true);
  }
  if (files.length < 2 || entries.reduce((sum, entry) => sum + entry.size, 0) < 256 * 1024 * 1024) {
    return perfHomeContentFingerprint(home, files, null, true);
  }
  return codexPlanningFingerprintAsync(home, files);
}

`;
  text = `${text.slice(0, start)}${replacement}${text.slice(end)}`;
  assertAnchors(text);
  return text;
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function main() {
  const experiment = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const sourceFile = path.join(experiment.baselineRoot, "src", "usage-core.js");
  const candidateFile = path.join(experiment.candidateRoot, "src", "usage-core.js");
  const source = fs.readFileSync(sourceFile, "utf8");
  const output = rebuildPrefixSource(source);
  fs.writeFileSync(candidateFile, output);
  console.log(
    JSON.stringify(
      {
        sourceFile,
        candidateFile,
        sourceSha256: hashText(source),
        candidateSha256: hashText(output),
        profileAnchors: PROFILE_ANCHORS.length,
        prefixReaders: 2,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
