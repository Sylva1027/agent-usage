import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { drawTimeline, renderTimelineLegendHtml } from "../public/app.js";
import { state } from "../public/app-state.js";

// 时间图只有三种模式（渠道/模型/花销）。历史遗留的"按性能"入口已从界面移除，
// 这里钉住"没有第四种模式"的契约：绘图与图例只认这三种，页面也不再提供性能视图节点。
test("timeline modes stay channel/model/cost and reject the retired performance sentinel", () => {
  assert.ok(["channel", "model", "cost"].includes(state.timelineMode));
  assert.ok(!("activeView" in state), "性能视图的 activeView 状态已随入口删除");
  assert.ok(!("selectedPerfGroupKey" in state), "性能详情选择状态已随入口删除");
  assert.throws(
    () => drawTimeline(null, [], [], new Map(), null, "performance", [], new Map()),
    /unsupported timeline mode/,
  );
  assert.throws(() => renderTimelineLegendHtml({}, "performance", new Map(), new Map()), /unsupported timeline mode/);

  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "all dashboard ids remain unique");
  for (const retired of ["perfModeButton", "perfPanel", "perfCoverage", "perfList", "perfDetailList"]) {
    assert.ok(!ids.includes(retired), `${retired} 不应再出现在页面上`);
  }
  assert.doesNotMatch(html, /data-active-view="performance"/);
  assert.match(html, /id="timelineModes"[^>]*aria-label="查看方式"/);
  assert.match(html, /id="timelineChart"[^>]*tabindex="0"/);
});
