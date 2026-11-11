import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {pathToFileURL} from "node:url";
import {createPerfCodexIntegrationFixture} from "../../test-support/perf-fixture.mjs";
import {transformHistory} from "./history-build.mjs";

const config = JSON.parse(fs.readFileSync("output/node-startup-20261030/experiment.json", "utf8"));
const {UsageStore: Baseline} = await import(pathToFileURL(path.join(config.baselineRoot, "src/usage-store.js")).href);
const {UsageStore: Candidate} = await import(pathToFileURL(path.join(config.historyRoot, "src/usage-store.js")).href);
function facts(store) {
  return Object.fromEntries([
    ["events", "id"], ["perf_samples", "sample_key"],
    ["perf_rollout_threads", "source_path,home_id,thread_id"],
    ["perf_sample_sources", "sample_key,source_path,role"],
  ].map(([table, order]) => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all()]));
}
const staged = store => [...store.codexThreadBuildPlan.values()].reduce((sum, plan) => sum + plan.staged.length, 0);

test("history candidate is the exact checked rebuild", () => {
  assert.equal(fs.readFileSync(path.join(config.historyRoot, "src/usage-store.js"), "utf8"),
    transformHistory(fs.readFileSync(path.join(config.baselineRoot, "src/usage-store.js"), "utf8")));
});

test("acknowledged missing dependencies reuse candidates across restart, with return and content guards", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  let baseline = new Baseline(fixture.serverOptions);
  const candidateOptions = {...fixture.serverOptions, databaseFile: fixture.serverOptions.databaseFile + ".candidate"};
  let candidate = new Candidate(candidateOptions);
  const missingPath = fixture.rolloutFiles[1];
  const bytes = fs.readFileSync(missingPath);
  const info = fs.statSync(missingPath);
  const sync = async () => {
    await baseline.sync({options: fixture.reportOptions});
    await candidate.sync({options: fixture.reportOptions});
    assert.deepEqual(facts(candidate), facts(baseline));
    assert.deepEqual(candidate.perfState().sourceWarnings, baseline.perfState().sourceWarnings);
    assert.deepEqual(candidate.perfState().missingSources.map(x => x.path), baseline.perfState().missingSources.map(x => x.path));
    assert.equal(candidate.perfState().indexVersion, baseline.perfState().indexVersion);
  };
  const reopen = () => {
    baseline.close(); candidate.close();
    baseline = new Baseline(fixture.serverOptions); candidate = new Candidate(candidateOptions);
  };
  try {
    await sync();
    fs.unlinkSync(missingPath);
    await sync();
    assert.equal(staged(candidate), 1, "newly missing dependency still builds once");
    reopen();
    await sync();
    assert.equal(staged(baseline), 1);
    assert.equal(staged(candidate), 0, "already acknowledged missing dependency must not rebuild");
    for (const [key, value] of [
      ["perf_state", "degraded"], ["perf_method_version", "old-method"],
      ["perf_missing_sources", "broken-json"], ["perf_codex_publication_policy", "broken-json"],
    ]) {
      reopen();
      await candidate.open();
      candidate.writeMeta(key, value);
      await sync();
      assert.equal(staged(candidate), 1, `${key} must refuse reuse`);
    }
    reopen();
    const live = fixture.rolloutFiles[0];
    const text = fs.readFileSync(live, "utf8");
    const liveInfo = fs.statSync(live);
    const changed = text.replace("codex-fixture-model", "codex-fixture-modeX");
    assert.notEqual(changed, text);
    fs.writeFileSync(live, changed);
    fs.utimesSync(live, liveInfo.atime, liveInfo.mtime);
    await sync();
    assert.equal(staged(candidate), 1, "same-size and same-mtime content changes must rebuild");
    fs.writeFileSync(live, text);
    fs.utimesSync(live, liveInfo.atime, liveInfo.mtime);
    fs.writeFileSync(missingPath, bytes);
    fs.utimesSync(missingPath, info.atime, info.mtime);
    reopen();
    await sync();
    assert.equal(staged(candidate), 1, "a returned dependency must rebuild");
    assert.deepEqual(candidate.database.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    baseline.close(); candidate.close(); fixture.close();
  }
});
