import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const readPublic = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url), "utf8");

test("dashboard ships without TPS UI dependencies or placeholders", () => {
  const index = readPublic("index.html");
  const app = readPublic("app.js");
  const state = readPublic("app-state.js");
  const i18n = readPublic("i18n.js");
  const styles = readPublic("styles.css");

  assert.equal(existsSync(new URL("../public/perf-ui.js", import.meta.url)), false);
  assert.doesNotMatch(index, /perfModels|perf-model|模型速度|TPS/i);
  assert.doesNotMatch(app, /perf-ui|perfModels|renderPerf|selectedPerfModelKey|averageTps|summary\.perf/i);
  assert.doesNotMatch(state, /selectedPerfModelKey/);
  assert.doesNotMatch(i18n, /TPS|tok\/s|模型速度|生成速度|性能索引|计时覆盖|平均速度|慢端|快端|合并样本/);
  assert.doesNotMatch(styles, /perf-model/i);
});

test("ordinary usage, timeline, range, filters, and skin controls remain", () => {
  const index = readPublic("index.html");

  for (const id of [
    "totalTokens",
    "timelineChart",
    "timelineModes",
    "presetButtons",
    "dateRangeButton",
    "modelComparisonSearch",
    "repositoryComparisonSearch",
    "skinToggle",
  ]) {
    assert.match(index, new RegExp(`id="${id}"`), `${id} remains in the dashboard`);
  }
});
