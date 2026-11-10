import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { launchServer } from "./windows-stability-run.mjs";
import { stop } from "./c1-run.mjs";
import { assertArchiveRequestStartup } from "./archive-request-prepare.mjs";
import { analyzeWindowsCloseout, analyzeCloseoutMatrix } from "./windows-stability-recovery-analyze.mjs";

const root = path.resolve("output/archive-memory-budget-20261110");
const previous = path.resolve("output/archive-request-lifetime-20261110");
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const save = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", flush: true });
};
const hash = async file => createHash("sha256").update(await fs.readFile(file)).digest("hex");
const within = file => {
  const relative = path.relative(root, path.resolve(file));
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Private output escaped");
};
async function files(directory, relative = "") {
  const result = [];
  for (const item of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const next = path.join(relative, item.name);
    assert(!(await fs.lstat(path.join(directory, next))).isSymbolicLink(), "Refuse recursive links");
    if (item.isDirectory()) result.push(...await files(directory, next));
    else { assert(item.isFile()); result.push(next); }
  }
  return result;
}
function facts(state) {
  const db = new DatabaseSync(path.join(state, "usage-index.sqlite"), { readOnly: true });
  try {
    return Object.fromEntries(["events", "history_replaced_facts", "archive_segments"].map(table => {
      const digest = createHash("sha256"); let rows = 0;
      const order = table === "events" ? "id" : table === "archive_segments" ? "segment_id" : "fact_table,source_kind,home_id,source_path,payload_digest";
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) { digest.update(JSON.stringify(row) + "\n"); rows++; }
      return [table, { rows, sha256: digest.digest("hex") }];
    }));
  } finally { db.close(); }
}
async function verify(config, name, expected) {
  const directory = path.join(root, "preparations", config.label, name), control = path.join(directory, "control");
  await fs.mkdir(control, { recursive: true });
  const dataset = await read(config.datasetFile), before = facts(config.state), started = Date.now();
  const server = await launchServer({ ...config, dataset, directory, control, closing: false });
  let body;
  try {
    for (const preset of ["today", "all"]) {
      const r = await fetch(server.ready.url + `/api/usage?preset=${preset}&view=dashboard&calendarZone=utc`, { signal: AbortSignal.timeout(600000) });
      body = await r.json(); assert.equal(r.status, 200, JSON.stringify(body)); assert.equal(body.summary.timelineError, null);
    }
  } finally { await stop(server); }
  const events = [];
  for (const file of await fs.readdir(control)) if (/^events-\d+\.ndjson$/.test(file))
    for (const line of (await fs.readFile(path.join(control, file), "utf8")).trim().split("\n")) if (line) events.push(JSON.parse(line));
  const guard = assertArchiveRequestStartup(events), after = facts(config.state);
  assert.deepEqual(after, before); if (expected) assert.deepEqual(after, expected);
  await save(path.join(directory, "receipt.json"), { wallMs: Date.now() - started, guard, facts: after,
    business: { totals: body.summary.totals, events: body.metadata.eventCount, sessions: body.metadata.sessionCount, cost: body.summary.costEstimate } });
  return after;
}
async function restore(config) {
  within(config.startState);
  const primary = path.join(config.state, "usage-index.sqlite"), identity = await fs.stat(primary, { bigint: true });
  assert.equal(identity.nlink, 1n);
  const saved = await files(config.startState), expected = new Set(saved);
  for (const relative of await files(config.state)) if (!expected.has(relative)) await fs.unlink(path.join(config.state, relative));
  for (const relative of saved) {
    const destination = path.join(config.state, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(config.startState, relative), destination);
  }
  const after = await fs.stat(primary, { bigint: true });
  assert.equal(after.ino, identity.ino); assert.equal(after.dev, identity.dev);
}
async function freeze() {
  const baseline = await read(path.join(previous, "baseline-runtime.json"));
  const receipts = [];
  for (const variant of ["baseline", "candidate"]) {
    const directory = path.join(root, `${variant}-runtime`), entries = [];
    await fs.mkdir(directory);
    for (const item of baseline.files) {
      assert.equal(await hash(path.join(baseline.directory, item.relative)), item.sha256);
      const changed = variant === "candidate" && item.relative.replaceAll("\\", "/") === "src/usage-store.js";
      const source = changed ? path.resolve(item.relative) : path.join(baseline.directory, item.relative);
      if (item.relative.replaceAll("\\", "/") !== "src/usage-store.js")
        assert.equal(await hash(path.resolve(item.relative)), item.sha256, "Unexpected product delta");
      const destination = path.join(directory, item.relative);
      await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination);
      entries.push({ relative: item.relative, sha256: await hash(destination) });
    }
    receipts.push({ variant, directory, files: entries });
  }
  await save(path.join(root, "runtimes.json"), receipts);
}
async function main() {
  assert.equal(path.resolve(process.env.WINDOWS_CLOSEOUT_ROOT || ""), root);
  const resume = process.argv.includes("--resume");
  if (resume) {
    for (const runtime of await read(path.join(root, "runtimes.json"))) for (const item of runtime.files) {
      assert.equal(await hash(path.join(runtime.directory, item.relative)), item.sha256);
      if (runtime.variant === "candidate") assert.equal(await hash(path.resolve(item.relative)), item.sha256);
    }
  } else await freeze();
  const progress = resume ? await read(path.join(root, "progress.json")) : { passed: false, groups: [] };
  try {
    for (const label of ["current", "year", "two-years"]) {
      const old = await read(path.join(previous, "configs", `${label}-baseline.json`));
      assert(path.resolve(old.state).startsWith(previous + path.sep));
      const config = { ...old, mode: "closeout-memory", startState: path.join(root, "snapshots", label), runtime: path.join(root, "baseline-runtime") };
      if (resume && progress.groups.filter(group => group.label === label).length === 2 &&
        await fs.stat(path.join(root, "cleanup", `${label}-snapshot.json`)).then(() => true, () => false)) continue;
      const initialFile = path.join(root, "preparations", label, "initial", "receipt.json");
      const expected = resume && await fs.stat(initialFile).then(() => true, () => false) ? (await read(initialFile)).facts : await verify(config, "initial");
      if (!await fs.stat(config.startState).then(() => true, () => false))
        await fs.cp(config.state, config.startState, { recursive: true, errorOnExist: true, force: false });
      for (const variant of label === "year" ? ["candidate", "baseline"] : ["baseline", "candidate"]) {
        const group = { ...config, variant, runtime: path.join(root, `${variant}-runtime`), directory: path.join(root, "short", label, variant) };
        if (resume && await fs.stat(path.join(group.directory, "result.json")).then(() => true, () => false)) {
          assert.equal((await read(path.join(group.directory, "result.json"))).passed, true);
          assert.equal((await read(path.join(group.directory, "closed.json"))).rawRestored, true);
          const analysis = await analyzeWindowsCloseout(group.directory);
          await fs.copyFile(path.join(group.directory, "analysis.json"), path.join(group.directory, "analysis-before-probe-fix.json"), fs.constants.COPYFILE_EXCL);
          await fs.writeFile(path.join(group.directory, "analysis.json"), JSON.stringify(analysis, null, 2));
          assert.equal(analysis.reliability.passed, true);
          if (!progress.groups.some(row => row.label === label && row.variant === variant))
            progress.groups.push({ label, variant, directory: group.directory, resource: analysis.resource.status, performance: analysis.performance.status });
          continue;
        }
        await restore(config);
        await verify(group, `before-${variant}`, expected);
        const configFile = path.join(root, "configs", `${label}-${variant}.json`); await save(configFile, group);
        await fs.mkdir(path.dirname(group.directory), { recursive: true });
        const output = await fs.open(path.join(root, `${label}-${variant}.log`), "wx"); let code;
        console.log(JSON.stringify({ stage: "start", label, variant, atMs: Date.now() }));
        try {
          const child = spawn(process.execPath, ["experiments/architecture-20261101/windows-stability-run.mjs", "closeout-run", configFile],
            { env: process.env, windowsHide: true, stdio: ["ignore", output.fd, output.fd] });
          code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
        } finally { await output.close(); }
        assert.equal(code, 0, "Group failed; stop and preserve evidence");
        const analysis = await analyzeWindowsCloseout(group.directory); await save(path.join(group.directory, "analysis.json"), analysis);
        assert.equal(analysis.reliability.passed, true, "Correctness/measurement failure; inspect before further timings");
        progress.groups.push({ label, variant, directory: group.directory, resource: analysis.resource.status, performance: analysis.performance.status });
        await fs.writeFile(path.join(root, "progress.json"), JSON.stringify(progress, null, 2));
        console.log(JSON.stringify({ stage: "complete", ...progress.groups.at(-1), atMs: Date.now() }));
      }
      await restore(config); await verify(config, "restored", expected);
      const target = await fs.realpath(config.startState); within(target); assert.equal(target.toLowerCase(), path.resolve(config.startState).toLowerCase());
      await save(path.join(root, "cleanup", `${label}-snapshot.json`), { target, files: (await files(target)).length, retainedState: config.state, facts: expected });
      await fs.rm(target, { recursive: true });
    }
    const result = await analyzeCloseoutMatrix(root); await save(path.join(root, "analysis.json"), result); progress.passed = result.passed;
  } finally { await fs.writeFile(path.join(root, "progress.json"), JSON.stringify(progress, null, 2)); }
  console.log(JSON.stringify(progress));
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve("experiments/architecture-20261101/source-snapshot-memory-run.mjs")) await main();
