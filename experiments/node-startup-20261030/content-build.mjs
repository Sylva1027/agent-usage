import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CONFIG_FILE = path.resolve("output/node-startup-20261030/experiment.json");
const SYNC_LOOP_START = "  for (const filePath of [...files].sort()) {\n";
const SYNC_LOOP_END = "  if (dependency !== null) hash.update(`dependency\\t${dependency.fingerprint}\\n`);";
const PREFIX_HELPER_START = "/**\n * Hash the complete pre-append prefix.";
const ASYNC_CONST = "const PERF_PREFIX_READER_COUNT = 2;";
const ASYNC_HELPER_START = "/**\n * Hash one file with an async reader that reuses the shard's buffer.";
const ASYNC_SHARD_START = "async function perfCodexPrefixShard(";
const ASYNC_LOOP_START = "  for (const filePath of files) {\n";
const ASYNC_LOOP_END = "  return { complete, fileFingerprints, filePrefixEvidence };";

export const CONTENT_ANCHORS = Object.freeze([
  "export function perfHomeContentFingerprint(",
  "function perfCodexContentFingerprintAndPrefix(",
  "async function perfCodexContentFingerprintAndPrefixAsync(",
  "      ? await perfCodexContentFingerprintAndPrefixAsync(filePath, buffer)",
]);

function occurrences(text, anchor) {
  return text.split(anchor).length - 1;
}

function replaceOnce(text, anchor, replacement) {
  const count = occurrences(text, anchor);
  if (count !== 1) throw new Error(`Expected one anchor, found ${count}: ${anchor}`);
  return text.replace(anchor, replacement);
}

function replaceBetween(text, startAnchor, endAnchor, replacement) {
  if (occurrences(text, startAnchor) !== 1) throw new Error(`Expected one start anchor: ${startAnchor}`);
  if (occurrences(text, endAnchor) !== 1) throw new Error(`Expected one end anchor: ${endAnchor}`);
  const start = text.indexOf(startAnchor);
  const end = text.indexOf(endAnchor, start + startAnchor.length);
  if (end < 0) throw new Error(`Missing end anchor after start: ${endAnchor}`);
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

const SYNC_LOOP = `  for (const filePath of [...files].sort()) {
    const captureCodex =
      capturePrefixEvidence && canonicalPerfKind(home?.kind) === "codex" && isPerfSourceEnabled(home?.kind);
    const combined = captureCodex ? perfCodexContentFingerprintAndPrefix(filePath) : null;
    const fingerprint = captureCodex
      ? (combined?.fingerprint ?? null)
      : perfContentFingerprint(home?.kind, filePath);
    if (fingerprint === null) complete = false;
    else fileFingerprints[filePath] = fingerprint;
    hash.update(\`\${filePath}\\t\${fingerprint ?? "!"}\\n\`);
    if (captureCodex) {
      if (combined?.prefix == null) complete = false;
      else filePrefixEvidence[filePath] = combined.prefix;
    }
  }
`;

const SYNC_HELPER = `/**
 * Hash the complete pre-append prefix and its stable head/tail probe in one
 * sequential read. The prefix digest is evidence only and never persisted.
 *
 * @param {string} filePath
 * @returns {{ fingerprint: string | null, prefix: { size: number, digest: string } | null }}
 */
function perfCodexContentFingerprintAndPrefix(filePath) {
  try {
    const main = statSync(filePath);
    let size = main.size;
    let mtimeMs = main.mtimeMs;
    const walPath = \`\${filePath}-wal\`;
    const wal = statSync(walPath, { throwIfNoEntry: false });
    const walSize = wal === undefined ? 0 : wal.size;
    if (wal !== undefined) {
      size += wal.size;
      mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
    }

    const probeHash = createHash("sha256");
    const prefixHash = createHash("sha256");
    const mainSize = main.size;
    {
      const handle = openSync(filePath, "r");
      try {
        const buffer = Buffer.alloc(PERF_CONTENT_PROBE_BYTES);
        const tailLength = mainSize > PERF_CONTENT_PROBE_BYTES ? PERF_CONTENT_PROBE_BYTES : 0;
        const tail = tailLength === 0 ? null : Buffer.alloc(tailLength);
        const tailStart = mainSize - tailLength;
        let offset = 0;
        while (offset < mainSize) {
          const length = Math.min(buffer.length, mainSize - offset);
          const read = readSync(handle, buffer, 0, length, offset);
          if (read <= 0) return null;
          const bytes = buffer.subarray(0, read);
          prefixHash.update(bytes);
          if (offset < PERF_CONTENT_PROBE_BYTES) {
            probeHash.update(bytes.subarray(0, Math.min(read, PERF_CONTENT_PROBE_BYTES - offset)));
          }
          if (tail !== null && offset + read > tailStart) {
            const sourceOffset = Math.max(0, tailStart - offset);
            const targetOffset = Math.max(0, offset - tailStart);
            bytes.copy(tail, targetOffset, sourceOffset);
          }
          offset += read;
        }
        if (tail !== null) probeHash.update(tail);
      } finally {
        closeSync(handle);
      }
    }
    if (walSize > 0) addPerfContentProbe(probeHash, walPath, walSize);
    return {
      fingerprint: \`\${size}:\${mtimeMs}:\${probeHash.digest("hex").slice(0, 32)}\`,
      prefix: { size: mainSize, digest: prefixHash.digest("hex") },
    };
  } catch {
    return { fingerprint: perfContentFingerprint("codex", filePath), prefix: null };
  }
}

function addPerfContentProbe(digest, filePath, fileSize) {
  if (fileSize <= 0) return;
  const handle = openSync(filePath, "r");
  try {
    const headLength = Math.min(fileSize, PERF_CONTENT_PROBE_BYTES);
    const buffer = Buffer.alloc(headLength);
    const read = readSync(handle, buffer, 0, headLength, 0);
    digest.update(buffer.subarray(0, read));
    if (fileSize > PERF_CONTENT_PROBE_BYTES) {
      const tailLength = Math.min(fileSize, PERF_CONTENT_PROBE_BYTES);
      const tailBuffer = Buffer.alloc(tailLength);
      const tailRead = readSync(handle, tailBuffer, 0, tailLength, fileSize - tailLength);
      digest.update(tailBuffer.subarray(0, tailRead));
    }
  } finally {
    closeSync(handle);
  }
}

`;

const ASYNC_HELPER = `/**
 * Async counterpart of the one-pass Codex fingerprint/prefix reader.
 *
 * @param {string} filePath
 * @param {Buffer} buffer
 * @returns {Promise<{ fingerprint: string | null, prefix: { size: number, digest: string } | null }>}
 */
async function perfCodexContentFingerprintAndPrefixAsync(filePath, buffer) {
  let handle = null;
  try {
    const main = statSync(filePath);
    let size = main.size;
    let mtimeMs = main.mtimeMs;
    const walPath = \`\${filePath}-wal\`;
    const wal = statSync(walPath, { throwIfNoEntry: false });
    const walSize = wal === undefined ? 0 : wal.size;
    if (wal !== undefined) {
      size += wal.size;
      mtimeMs = Math.max(mtimeMs, wal.mtimeMs);
    }

    const probeHash = createHash("sha256");
    const prefixHash = createHash("sha256");
    const mainSize = main.size;
    {
      handle = await open(filePath, "r");
      const tailLength = mainSize > PERF_CONTENT_PROBE_BYTES ? PERF_CONTENT_PROBE_BYTES : 0;
      const tail = tailLength === 0 ? null : Buffer.alloc(tailLength);
      const tailStart = mainSize - tailLength;
      let offset = 0;
      while (offset < mainSize) {
        const length = Math.min(buffer.length, mainSize - offset);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        if (bytesRead <= 0) return null;
        const bytes = buffer.subarray(0, bytesRead);
        prefixHash.update(bytes);
        if (offset < PERF_CONTENT_PROBE_BYTES) {
          probeHash.update(bytes.subarray(0, Math.min(bytesRead, PERF_CONTENT_PROBE_BYTES - offset)));
        }
        if (tail !== null && offset + bytesRead > tailStart) {
          const sourceOffset = Math.max(0, tailStart - offset);
          const targetOffset = Math.max(0, offset - tailStart);
          bytes.copy(tail, targetOffset, sourceOffset);
        }
        offset += bytesRead;
      }
      if (tail !== null) probeHash.update(tail);
    }
    if (walSize > 0) addPerfContentProbe(probeHash, walPath, walSize);
    return {
      fingerprint: \`\${size}:\${mtimeMs}:\${probeHash.digest("hex").slice(0, 32)}\`,
      prefix: { size: mainSize, digest: prefixHash.digest("hex") },
    };
  } catch {
    return { fingerprint: perfContentFingerprint("codex", filePath), prefix: null };
  } finally {
    await handle?.close().catch(() => {});
  }
}

`;

const ASYNC_LOOP = `  for (const filePath of files) {
    const combined = isPerfSourceEnabled(home?.kind)
      ? await perfCodexContentFingerprintAndPrefixAsync(filePath, buffer)
      : null;
    const fingerprint = combined?.fingerprint ?? null;
    if (fingerprint === null) complete = false;
    else fileFingerprints[filePath] = fingerprint;
    if (canonicalPerfKind(home?.kind) === "codex") {
      if (combined?.prefix == null) complete = false;
      else filePrefixEvidence[filePath] = combined.prefix;
    }
  }
`;

export function rebuildContentSource(source) {
  let text = replaceBetween(source, SYNC_LOOP_START, SYNC_LOOP_END, SYNC_LOOP);
  text = replaceBetween(text, PREFIX_HELPER_START, ASYNC_CONST, SYNC_HELPER);
  text = replaceBetween(text, ASYNC_HELPER_START, ASYNC_SHARD_START, ASYNC_HELPER);
  text = replaceBetween(text, ASYNC_LOOP_START, ASYNC_LOOP_END, ASYNC_LOOP);
  for (const anchor of CONTENT_ANCHORS) {
    if (occurrences(text, anchor) !== 1) throw new Error(`Expected one content anchor: ${anchor}`);
  }
  if (text.includes("perfFilePrefixEvidence")) throw new Error("Independent Codex prefix reader remains");
  return text;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function main() {
  const experiment = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  const sourceFile = path.join(experiment.baselineRoot, "src", "usage-core.js");
  const candidateFile = path.join(experiment.contentRoot, "src", "usage-core.js");
  const source = fs.readFileSync(sourceFile, "utf8");
  const expected = experiment.files.find((row) => row.file === "usage-core.js")?.hash;
  if (sha256(source) !== expected) throw new Error("Frozen content baseline hash changed");
  const output = rebuildContentSource(source);
  fs.writeFileSync(candidateFile, output);
  console.log(
    JSON.stringify(
      {
        sourceFile,
        candidateFile,
        sourceSha256: sha256(source),
        candidateSha256: sha256(output),
        anchors: CONTENT_ANCHORS.length,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
