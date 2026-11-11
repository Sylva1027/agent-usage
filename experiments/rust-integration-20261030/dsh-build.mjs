import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const EXPERIMENT_FILE = path.join(REPO_ROOT, "output", "rust-integration-20261030", "experiment.json");
const BRIDGE_FILE = path.join(REPO_ROOT, "experiments", "rust-integration-20261030", "dsh-adapter.mjs");
const BRIDGE_SPECIFIER = "../../../../experiments/rust-integration-20261030/dsh-adapter.mjs";
const args = process.argv.slice(2);

if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error("usage: node experiments/rust-integration-20261030/dsh-build.mjs [--check]");
}

const checkOnly = args[0] === "--check";

function assertUnique(source, anchor, label) {
  const first = source.indexOf(anchor);
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    const count = source.split(anchor).length - 1;
    throw new Error(`${label} anchor must occur exactly once; found ${count}`);
  }
  return first;
}

function replaceOnce(source, anchor, replacement, label) {
  assertUnique(source, anchor, label);
  return source.replace(anchor, replacement);
}

function replaceRangeOnce(source, startAnchor, endAnchor, closingText, replacement, label) {
  const start = assertUnique(source, startAnchor, `${label} start`);
  assertUnique(source, endAnchor, `${label} end`);
  const end = source.indexOf(endAnchor, start + startAnchor.length);
  if (end < 0) throw new Error(`${label} end occurs before its start`);
  return source.slice(0, start) + replacement + source.slice(end + closingText.length);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function firstDifferentLine(left, right) {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const length = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < length; index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      return {
        line: index + 1,
        generated: leftLines[index] ?? "<missing>",
        existing: rightLines[index] ?? "<missing>",
      };
    }
  }
  return null;
}

const experiment = JSON.parse(fs.readFileSync(EXPERIMENT_FILE, "utf8"));
const sourceFile = path.join(experiment.baselineRoot, "src", "dsh-usage.js");
const targetFile = path.join(experiment.candidateRoot, "src", "dsh-usage.js");
let source = fs.readFileSync(sourceFile, "utf8");

const importsAnchor = `import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";
`;
const importsReplacement = `import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { streamDshRustRows } from ${JSON.stringify(BRIDGE_SPECIFIER)};`;
source = replaceOnce(source, importsAnchor, importsReplacement, "DSH imports");

const magicAnchor = "const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);\n";
source = replaceOnce(source, magicAnchor, "", "ZSTD_MAGIC");

const frameHelperAnchor = `function dshFrameOffsets(buffer) {
  const offsets = [];
  for (let at = buffer.indexOf(ZSTD_MAGIC); at !== -1; at = buffer.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length)) {
    offsets.push(at);
  }
  return offsets;
}

`;
source = replaceOnce(source, frameHelperAnchor, "", "dshFrameOffsets");

const streamStart = "export async function* streamDshSessionRows(filePath, { onWarning } = {}) {";
const streamEnd = "\n}\n\n/**\n * 兼容收集器";
const streamReplacement = `export async function* streamDshSessionRows(filePath, { onWarning } = {}) {
  const physicalPath = globalThis.__localSummaryPhysical?.(filePath) ?? filePath;
  yield* streamDshRustRows(physicalPath, { displayPath: filePath, onWarning });
}`;
source = replaceRangeOnce(
  source,
  streamStart,
  streamEnd,
  "\n}",
  streamReplacement,
  "streamDshSessionRows",
);

for (const [anchor, label] of [
  [`import { streamDshRustRows } from ${JSON.stringify(BRIDGE_SPECIFIER)};`, "Rust bridge import"],
  ["const physicalPath = globalThis.__localSummaryPhysical?.(filePath) ?? filePath;", "physical path mapping"],
  [
    "yield* streamDshRustRows(physicalPath, { displayPath: filePath, onWarning });",
    "logical warning path forwarding",
  ],
]) {
  assertUnique(source, anchor, label);
}
for (const [anchor, label] of [
  ['from "node:zlib"', "Node zlib import"],
  ["dshFrameOffsets", "Node frame scanner"],
  ["readFile(filePath)", "Node whole-file read"],
]) {
  if (source.includes(anchor)) throw new Error(`${label} remained in generated candidate`);
}

const bridgeSource = fs.readFileSync(BRIDGE_FILE, "utf8");
for (const [anchor, label] of [
  [
    "export async function* streamDshRustRows(filePath, { displayPath = filePath, onWarning } = {}) {",
    "adapter displayPath option",
  ],
  ["await writeRequest(state, { filePath, displayPath });", "adapter physical/display request"],
]) {
  assertUnique(bridgeSource, anchor, label);
}

const result = {
  mode: checkOnly ? "check" : "write",
  source: sourceFile,
  target: targetFile,
  bridge: BRIDGE_SPECIFIER,
  generatedSha256: sha256(source),
};

if (checkOnly) {
  const existing = fs.readFileSync(targetFile, "utf8");
  if (existing !== source) {
    throw new Error(`candidate dsh-usage.js is stale: ${JSON.stringify(firstDifferentLine(source, existing))}`);
  }
  result.existingSha256 = sha256(existing);
} else {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, source, "utf8");
}

console.log(JSON.stringify(result));
