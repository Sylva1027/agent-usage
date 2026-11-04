import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";
import { BASE } from "./q6-performance-prepare.mjs";
import { publishCanonicalSeed } from "./q5-fixture.mjs";
import { readCapturedPricing } from "./q5-summary-hook.mjs";
import { serverOptions } from "./b2-page-diagnostic.mjs";

const read = async (file) => JSON.parse(await readFile(file, "utf8"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

export function codexFileRows(first, end, startMs) {
  assert.ok(Number.isInteger(first) && first >= 0 && end > first);
  const rows = [
    { type: "session_meta", timestamp: new Date(startMs).toISOString(), payload: {
      id: "q6-count-codex", source: "cli", originator: "codex-tui", cwd: "/q6-file-count" } },
    { type: "turn_context", payload: { model: "gpt-5" } },
  ];
  for (let j = first; j < end; j++) rows.push({ type: "event_msg", timestamp: new Date(startMs + j).toISOString(),
    payload: { type: "token_count", info: { total_token_usage: {
      input_tokens: j + 1, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: j + 1 },
    last_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 1 } } } });
  return rows;
}

async function prepare() {
  const matrix = await read(path.join(BASE, "matrix.json"));
  assert.ok(!matrix.cells.some((cell) => cell.fileCount), "Count cells already prepared");
  const baseline = matrix.versions.find((version) => version.variant === "baseline");
  const load = (relative) => import(pathToFileURL(path.join(baseline.directory, relative)).href);
  const { UsageStore } = await load("src/usage-store.js");
  const { WindowsSourceProof } = await load("src/usage-source-native.js");
  const { setPricingCatalog } = await load("src/pricing.js");
  setPricingCatalog(readCapturedPricing(matrix.pricing.file, matrix.pricing.catalogSha256).catalog);
  const template = matrix.cells.find((cell) => cell.id === "1x-native" && cell.variant === "baseline").prepared;
  await mkdir(path.join(BASE, "file-count"), { recursive: true });
  const setup = [];
  for (const fileCount of [2000, 20000]) {
    const startedAtMs = Date.now(), id = `files-${fileCount}-native`;
    const directory = path.join(BASE, "file-count", id);
    await mkdir(directory); // A fresh namespace keeps setup independent of timing samples.
    const canonicalDirectory = path.join(os.tmpdir(), `codex-${path.basename(BASE)}`, id);
    await mkdir(canonicalDirectory);
    const home = path.join(canonicalDirectory, "home"), stateDirectory = path.join(directory, "canonical-state");
    await mkdir(stateDirectory);
    const codexDirectory = path.join(home, ".codex", "sessions");
    const dshFile = path.join(home, ".dsh", "sessions", "project", "session", "session.v4.jsonl.zstd");
    await mkdir(codexDirectory, { recursive: true });
    await mkdir(path.dirname(dshFile), { recursive: true });
    const events = 20000, codexFiles = fileCount - 1, startMs = matrix.appendTimeMs - 30000;
    let codexFile;
    for (let j = 0; j < codexFiles; j++) {
      codexFile = path.join(codexDirectory, `${String(j).padStart(5, "0")}.jsonl`);
      await writeFile(codexFile, jsonl(codexFileRows(Math.floor(j * events / codexFiles), Math.floor((j + 1) * events / codexFiles), startMs)), { flag: "wx" });
    }
    await writeFile(dshFile, zstdCompressSync(Buffer.from(jsonl([
      { type: "session", version: 4, id: "q6-count-dsh", cwd: "/q6-file-count", createdAt: startMs, delegationDepth: 0 },
      { type: "request/header", seq: 1, time: startMs, data: { header: { config: { model: "deepseek-flash", provider: "deepseek-account" } } } },
      { type: "assistant/message", seq: 2, time: startMs + 1, data: { turn: 1, step: 1,
        usage: { inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 2, totalTokens: 14 }, message: { content: [] } } },
    ]))), { flag: "wx" });
    const selected = {}, prior = {};
    for (const [kind, targetPath] of Object.entries({ codex: codexFile, dsh: dshFile })) {
      const bytes = await readFile(targetPath), info = await stat(targetPath), sourcePath = path.join(directory, `${kind}-original`);
      await writeFile(sourcePath, bytes, { flag: "wx" });
      selected[kind] = { targetPath, sourcePath, sourceBytes: bytes.length, sourceSha256: sha(bytes) };
      prior[kind] = { file: sourcePath, path: targetPath, size: info.size, mtimeMs: info.mtimeMs };
    }
    const prepared = { home, stateDirectory, databaseFile: path.join(stateDirectory, "usage-index.sqlite"),
      canonicalDirectory, canonicalId: id, seedDatabaseFile: path.join(directory, "seed.sqlite"), selected,
      scaleRoot: directory, importStoreFile: path.join(canonicalDirectory, "imports.json"),
      pricingFile: path.join(canonicalDirectory, "pricing.json"), automaticPricingFile: path.join(canonicalDirectory, "pricing-auto.json") };
    await copyFile(template.automaticPricingFile, prepared.automaticPricingFile);
    const rawReadyAtMs = Date.now(), store = new UsageStore(serverOptions(prepared));
    const native = new WindowsSourceProof(baseline.nativeBinary);
    store.sourceProof.provider = async () => native;
    store.sourceProof.close = () => native.close();
    let counts;
    try {
      await store.sync();
      counts = store.database.prepare("SELECT COUNT(*) n,SUM(total) total,COUNT(DISTINCT session_id) sessions FROM events").get();
      assert.equal(counts.n, events + 1); assert.equal(counts.total, events + 14); assert.equal(counts.sessions, 2);
      assert.equal(store.database.prepare("SELECT COUNT(*) n FROM source_files").get().n, fileCount);
    } finally { store.close(); }
    await publishCanonicalSeed(prepared, { pricing: matrix.pricing, scope: "synthetic-fixed-logical-events-file-count-only" });
    for (const variant of ["baseline", "candidate"]) {
      const cellDirectory = path.join(BASE, "page", id, variant), cellState = path.join(cellDirectory, "state");
      await mkdir(cellState, { recursive: true });
      const auxiliary = path.join(canonicalDirectory, variant); await mkdir(auxiliary);
      const cellPrepared = { ...prepared, stateDirectory: cellState, databaseFile: path.join(cellState, "usage-index.sqlite"),
        importStoreFile: path.join(auxiliary, "imports.json"), pricingFile: path.join(auxiliary, "pricing.json"),
        automaticPricingFile: path.join(auxiliary, "pricing-auto.json") };
      await copyFile(prepared.automaticPricingFile, cellPrepared.automaticPricingFile);
      await writeFile(path.join(cellDirectory, "prepared.json"), JSON.stringify(cellPrepared, null, 2), { flag: "wx" });
      matrix.cells.push({ id, variant, fileCount, proofMode: "native", rounds: 1, directory: cellDirectory, prepared: cellPrepared, prior });
    }
    const receipt = { id, fileCount, counts, startedAtMs, rawReadyAtMs, endedAtMs: Date.now(),
      scope: "synthetic seed construction; not a real-history full rebuild or timed append" };
    setup.push(receipt); console.log(JSON.stringify(receipt));
  }
  await writeFile(path.join(BASE, "file-count-setup.json"), JSON.stringify(setup, null, 2), { flag: "wx" });
  await writeFile(path.join(BASE, "matrix.json"), JSON.stringify(matrix, null, 2), { flush: true });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepare();
