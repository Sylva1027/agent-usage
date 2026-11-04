import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { UsageStore } from "../../src/usage-store.js";
import { WindowsSourceProof } from "../../src/usage-source-native.js";

const script = fileURLToPath(import.meta.url);
const label = process.argv[2] && process.argv[2] !== "--child" ? process.argv[2] : "recovery";
assert.match(label, /^[a-z0-9-]+$/);
const output = path.resolve("output/architecture-20261104/q6-implementation", label);
const helper = path.resolve("output/architecture-20261104/q6-implementation/native-target/release/windows-source-proof.exe");
const line = (total) => JSON.stringify({ type: "event_msg", timestamp: `2026-11-05T01:00:${total === 10 ? "00" : "01"}Z`,
  payload: { type: "token_count", info: { total_token_usage: { total_tokens: total, input_tokens: total } } } }) + "\n";

function openStore(config, mode) {
  const store = new UsageStore(config);
  const native = mode === "native" ? new WindowsSourceProof(helper) : null;
  store.sourceProof.provider = async () => native;
  store.sourceProof.close = () => native?.close();
  store.repositoryResolver = (cwd) => ({ key: `directory:${cwd}`, path: cwd, kind: "directory" });
  return store;
}

function park(stage) {
  writeSync(1, JSON.stringify({ stage, pid: process.pid }) + "\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
  throw new Error("parent failed to terminate parked child");
}

async function child(configFile, mode, stage) {
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const store = openStore(config, mode);
  await store.open();
  const exec = store.database.exec.bind(store.database);
  if (stage === "before-facts") store.database.exec = (sql) => {
    if (sql === "COMMIT" && Number(store.database.prepare("SELECT SUM(total) n FROM events").get().n) === 20)
      park(stage);
    return exec(sql);
  };
  const { UsageSourceAcquisition } = await import("../../src/usage-source-acquisition.js");
  const acquisition = new UsageSourceAcquisition(store);
  store.sourceAcquisition = acquisition;
  const complete = acquisition.complete.bind(acquisition);
  acquisition.complete = async (...args) => {
    if (stage === "before-publication") park(stage);
    const result = await complete(...args);
    if (stage === "after-publication") { assert.ok(result || mode === "sha"); park(stage); }
    return result;
  };
  await store.sync();
  throw new Error("termination marker not reached");
}

async function terminateAt(configFile, mode, stage) {
  const processChild = spawn(process.execPath, [script, "--child", configFile, mode, stage],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let errors = "", text = "";
  processChild.stderr.on("data", (chunk) => { errors += chunk; });
  const exit = new Promise((resolve) => processChild.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    const marker = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("recovery child marker timeout")), 15_000);
      processChild.once("exit", () => { clearTimeout(timer); reject(new Error(`early child exit: ${errors}`)); });
      processChild.stdout.on("data", (chunk) => {
        text += chunk;
        if (!text.includes("\n")) return;
        try {
          const parsed = JSON.parse(text.split("\n")[0]);
          assert.equal(parsed.stage, stage);
          clearTimeout(timer); resolve(parsed);
        } catch (error) { clearTimeout(timer); reject(error); }
      });
    });
    assert.equal(marker.pid, processChild.pid);
    processChild.kill("SIGKILL");
    return { ...marker, ...await exit };
  } finally {
    if (processChild.exitCode === null && processChild.signalCode === null) processChild.kill("SIGKILL");
    await exit;
  }
}

async function main() {
  await mkdir(output, { recursive: true });
  const results = [];
  for (const [mode, stage] of [["native", "before-facts"], ["native", "before-publication"],
    ["native", "after-publication"], ["sha", "before-facts"], ["sha", "after-publication"]]) {
    const directory = path.join(output, `${mode}-${stage}`);
    await mkdir(directory); // Refuse to overwrite evidence from a previous run.
    const root = await mkdtemp(path.join(os.tmpdir(), "q6-production-recovery-"));
    let store;
    try {
      const file = path.join(root, ".codex", "sessions", "source.jsonl");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify({ type: "session_meta", payload: { id: "recovery", cwd: root, source: "cli" } }) + "\n" +
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-5" } }) + "\n" + line(10));
      const config = { homeDir: root, env: {}, importDirs: [], databaseFile: path.join(directory, "index.sqlite") };
      const configFile = path.join(directory, "config.json");
      await writeFile(configFile, JSON.stringify(config));
      store = openStore(config, mode);
      let initial;
      const initialization = [];
      for (let attempt = 0; attempt < 3; attempt++) {
        initial = await store.sync();
        initialization.push(store.lastAcquisitionWork);
        if (mode === "sha" || initial.acquisition) break;
      }
      if (mode === "native") assert.ok(initial.acquisition, JSON.stringify(store.lastAcquisitionWork));
      const oldCut = initial.acquisition?.cuts;
      store.close(); store = null;
      await appendFile(file, line(20));
      const killed = await terminateAt(configFile, mode, stage);
      store = openStore(config, mode);
      await store.open();
      const beforeRecovery = Number(store.database.prepare("SELECT SUM(total) n FROM events").get().n);
      assert.equal(beforeRecovery, stage === "before-facts" ? 10 : 20);
      const recovered = await store.sync();
      assert.equal(store.database.prepare("SELECT SUM(total) n FROM events").get().n, 20);
      assert.equal(store.database.prepare("SELECT COUNT(*) n FROM events").get().n, 2);
      assert.equal(store.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
      const quiet = await store.sync();
      assert.equal(quiet.updatedFileCount, 0);
      results.push({ mode, stage, initialization, killed, beforeRecovery, total: 20, eventCount: 2,
        oldCut, recoveredCut: recovered.acquisition?.cuts, recoveredFiles: recovered.updatedFileCount,
        quietFiles: quiet.updatedFileCount, integrity: "ok", passed: true });
      await writeFile(path.join(directory, "result.json"), JSON.stringify(results.at(-1), null, 2));
    } finally {
      store?.close();
      assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
      assert.ok(path.basename(root).startsWith("q6-production-recovery-"));
      await rm(root, { recursive: true, force: true });
    }
  }
  await writeFile(path.join(output, "result.json"), JSON.stringify({ passed: results.every((r) => r.passed), cases: results }, null, 2));
  console.log(JSON.stringify({ passed: true, cases: results.length, result: path.join(output, "result.json") }));
}

if (process.argv[2] === "--child") await child(...process.argv.slice(3));
else if (process.argv[1] && path.resolve(process.argv[1]) === script) await main();
