import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { formatUsageTooltip, formatTimelineTooltip, usageTooltipPosition } from "../public/app.js";
import { state } from "../public/app-state.js";
import { formatLocalDateTime, setLocale } from "../public/i18n.js";

function sourceBetween(source, startMarker, endMarker) {
  const startIndex = source.indexOf(startMarker);
  const endIndex = source.indexOf(endMarker, startIndex);
  assert.notEqual(startIndex, -1, `missing ${startMarker}`);
  assert.notEqual(endIndex, -1, `missing ${endMarker}`);
  return source.slice(startIndex, endIndex);
}

test("tooltip bodies are only rewritten when the node does not already show them", async () => {
  // A pointermove that keeps hitting the same row must only reposition the tooltip. Both writers
  // hand the formatted body to one publisher, which decides by reading what the node currently
  // holds, so an external change to the tooltip is re-asserted instead of being skipped.
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const region = sourceBetween(source, "function publishUsageTooltipBody", "function bindUsageRows");
  assert.match(source, /const publishedTooltipBodies = new WeakMap\(\)/);
  assert.equal(
    (region.match(/\.innerHTML\s*=/g) || []).length,
    1,
    "the shared publisher must be the only tooltip-body writer",
  );
  assert.match(region, /published\.html === html && published\.dom === tooltip\.innerHTML/);
  assert.match(region, /publishUsageTooltipBody\(tooltip, formatUsageTooltip\(/);
  assert.match(region, /publishUsageTooltipBody\(tooltip, formatTimelineTooltip\(/);
  // Visibility is re-asserted from the node's own state instead of being assigned unconditionally.
  assert.match(region, /if \(tooltip && !tooltip\.hidden\)/);
  assert.match(region, /if \(tooltip\.hidden\) tooltip\.hidden = false;/);
  // The chart's accessible label is compared before it is written again.
  assert.match(region, /chart\.getAttribute\?\.\("aria-label"\) !== label/);
});

test("usageTooltipPosition keeps the measured tooltip inside each viewport edge", () => {
  const viewportWidth = 320;
  const viewportHeight = 240;
  const width = 268;
  const height = 224;
  for (const [anchorX, anchorY] of [
    [0, 0],
    [319, 0],
    [0, 239],
    [319, 239],
    [160, 120],
    [-20, -20],
    [350, 270],
  ]) {
    const { left, top } = usageTooltipPosition(anchorX, anchorY, width, height, viewportWidth, viewportHeight);
    assert.ok(left >= 8 && left + width <= viewportWidth - 8);
    assert.ok(top >= 8 && top + height <= viewportHeight - 8);
  }
});

test("formatUsageTooltip renders token details for a usage row", () => {
  const html = formatUsageTooltip({
    name: "2026-05-26",
    count: 3,
    sessions: 2,
    total: {
      total: 1234567,
      input: 1000000,
      cached: 250000,
      output: 234567,
      reasoning: 34567,
    },
  });

  assert.match(html, /2026-05-26/);
  assert.match(html, /总 tokens/);
  assert.match(html, /1,234,567/);
  assert.match(html, /输入/);
  assert.match(html, /1,000,000/);
  assert.match(html, /缓存读取/);
  assert.match(html, /250,000/);
  assert.match(html, /输出/);
  assert.match(html, /234,567/);
  assert.match(html, /推理输出/);
  assert.match(html, /34,567/);
  assert.match(html, /事件/);
  assert.match(html, /3/);
  assert.match(html, /会话/);
  assert.match(html, /2/);
});

test("formatUsageTooltip renders timeline channel breakdowns", () => {
  const html = formatUsageTooltip({
    name: "2026-05-26",
    count: 3,
    sessions: 2,
    total: { total: 300, input: 250, cached: 50, output: 50, reasoning: 5 },
    channels: [
      { name: "JetBrains PyCharm", total: { total: 200 } },
      { name: "Codex Desktop", total: { total: 100 } },
    ],
  });

  assert.match(html, /渠道/);
  assert.match(html, /JetBrains PyCharm/);
  assert.match(html, /200/);
  assert.match(html, /Codex Desktop/);
  assert.match(html, /100/);
});

test("formatTimelineTooltip keeps costs concise and never labels unpriced usage as free", () => {
  const priced = formatTimelineTooltip(
    {
      key: "2026-05-01",
      total: { total: 90, input: 80, cached: 20, output: 10 },
      costByModel: { "gpt-6-luna": { totalUsd: 0.0000001, pricedTokens: 10 } },
      pricedTokens: 10,
      unpricedTokens: 80_000_000,
      serviceTierUnknownTokens: 10,
      cacheWriteUnknownTokens: 80,
    },
    "cost",
  );
  assert.match(priced, /2026-05-01/);
  assert.match(priced, /估算金额/);
  assert.match(priced, /\$0\.00/);
  assert.match(priced, /未计价 tokens<\/span><span class="usage-tooltip-value">80\.00M/);
  assert.doesNotMatch(priced, /缓存写入明细未知|服务等级未知|usage-tooltip-note|费用估算/);

  const unpriced = formatTimelineTooltip(
    {
      key: "2026-05-02",
      costByModel: { "unknown-model": { totalUsd: 0, pricedTokens: 0 } },
      pricedTokens: 0,
      unpricedTokens: 15,
    },
    "cost",
  );
  assert.match(unpriced, /无可计价费用/);
  assert.doesNotMatch(unpriced, /\$0\.00/);
});

test("all timeline tooltips use M/B/T token values without changing event and session counts", () => {
  for (const [value, text] of [
    [188_483_039, "188.48M"],
    [1_392_280_000, "1.39B"],
    [1_395_280_000_000, "1.40T"],
  ]) {
    const row = {
      key: "2026-11-11",
      count: 17,
      sessions: 23,
      total: { total: value, input: value, cached: value, output: value, reasoning: value },
      models: [{ name: "gpt-6-sol", total: { total: value } }],
      channels: [{ name: "Codex", total: { total: value } }],
      pricedTokens: value,
      costByModel: { "gpt-6-sol": { totalUsd: 12.34, currency: "USD" } },
    };
    for (const mode of ["channel", "model", "cost"]) {
      const html = formatTimelineTooltip(row, mode);
      assert.ok(html.includes(`>${text}</span>`), `${mode}: ${text}`);
      assert.ok(!html.includes(value.toLocaleString("en-US")), `${mode}: no exact token count`);
      if (mode === "channel") {
        assert.match(html, /事件<\/span>\s*<span class="usage-tooltip-value">17</);
        assert.match(html, /会话<\/span>\s*<span class="usage-tooltip-value">23</);
      }
    }
  }
});

test("quota tooltip titles contain only dates and times, with one short note for an unfinished slot", () => {
  const saved = { preset: state.preset, summary: state.summary, quotaSnapshot: state.quotaSnapshot };
  const start = new Date(2026, 10, 11, 3, 50, 25);
  const end = new Date(2026, 10, 12, 3, 50, 25);
  const asOf = new Date(2026, 10, 12, 1, 35, 26);
  const row = { slotStartMs: start.getTime(), slotEndExclusiveMs: end.getTime(), total: { total: 188_483_039 } };
  try {
    state.summary = null;
    for (const locale of ["zh-CN", "en-US"]) {
      setLocale(locale, { persist: false });
      for (const preset of ["quota_5h", "quota_week"]) {
        state.preset = preset;
        for (const partial of [true, false]) {
          state.quotaSnapshot = { asOf: (partial ? asOf : end).toISOString() };
          for (const mode of ["channel", "model", "cost"]) {
            const html = formatTimelineTooltip(row, mode);
            assert.ok(html.includes(`${formatLocalDateTime(start)} – ${formatLocalDateTime(end)}</div>`));
            assert.doesNotMatch(html, /UTC|Asia|时间槽|自然日|夏令时|continuous|daylight|Interval/);
            assert.equal((html.match(/usage-tooltip-note/g) || []).length, partial ? 1 : 0);
            if (partial)
              assert.ok(html.includes(`${locale === "zh-CN" ? "统计截至" : "As of"} ${formatLocalDateTime(asOf)}`));
          }
        }
      }
    }
  } finally {
    Object.assign(state, saved);
    setLocale("zh-CN", { persist: false });
  }
});
