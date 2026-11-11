import assert from "node:assert/strict";
import test from "node:test";

import {
  costPairFromSlots,
  formatTimelineTooltip,
  renderTimelineLegendHtml,
  timelineDetailRows,
} from "../public/app.js";
import { buildTimelineRows } from "../public/timeline-utils.js";
import { state } from "../public/app-state.js";
import { estimateEventCost } from "../src/pricing.js";

const baseEvent = {
  model: "mystery-model",
  timestamp: "2026-07-01T10:00:00.000Z",
  detailMask: 15,
  cacheWriteTokens: 0,
  cacheWriteKnown: true,
  contextLevel: "short",
  serviceTier: "standard",
  total: { total: 110, input: 100, cached: 20, output: 10, reasoning: 0 },
};

const cnyEvent = { ...baseEvent, channel: "ZCode" };
const usdEvent = { ...baseEvent, channel: "CLI" };

function timelineRow(events) {
  return buildTimelineRows(events, { calendarZone: "utc" }, "day", { estimateCost: estimateEventCost })[0];
}

function nativeBuckets(row) {
  const buckets = {};
  for (const cost of Object.values(row.costByModel)) {
    const bucket = buckets[cost.currency] || {
      totalUsd: 0,
      pricedTokens: 0,
      minimumEstimatedTokens: 0,
    };
    bucket.totalUsd += cost.totalUsd;
    bucket.pricedTokens += cost.pricedTokens;
    bucket.minimumEstimatedTokens += cost.minimumEstimatedTokens;
    buckets[cost.currency] = bucket;
  }
  return buckets;
}

test("same unknown model keeps independent native USD/CNY buckets in either event order", () => {
  const cnyEstimate = estimateEventCost(cnyEvent);
  const usdEstimate = estimateEventCost(usdEvent);
  assert.equal(cnyEstimate.currency, "CNY");
  assert.equal(usdEstimate.currency, "USD");
  assert.ok(cnyEstimate.totalUsd > 0);
  assert.ok(usdEstimate.totalUsd > 0);

  const forward = timelineRow([cnyEvent, usdEvent]);
  const reverse = timelineRow([usdEvent, cnyEvent]);
  const expectedBuckets = {
    CNY: {
      totalUsd: cnyEstimate.totalUsd,
      pricedTokens: 110,
      minimumEstimatedTokens: 110,
    },
    USD: {
      totalUsd: usdEstimate.totalUsd,
      pricedTokens: 110,
      minimumEstimatedTokens: 110,
    },
  };

  assert.deepEqual(forward.costByModel, reverse.costByModel);
  assert.equal(Object.keys(forward.costByModel).length, 2);
  assert.deepEqual(
    Object.values(forward.costByModel)
      .map((cost) => cost.currency)
      .sort(),
    ["CNY", "USD"],
  );
  assert.deepEqual(nativeBuckets(forward), expectedBuckets);
  assert.deepEqual(costPairFromSlots(forward.costByModel), {
    usd: usdEstimate.totalUsd,
    cny: cnyEstimate.totalUsd,
  });
  assert.equal(forward.pricedTokens, 220);
});

test("single-currency model keeps the existing model-name key and cost shape", () => {
  const row = timelineRow([cnyEvent]);
  assert.deepEqual(Object.keys(row.costByModel), ["mystery-model"]);
  assert.equal(Object.hasOwn(row.costByModel["mystery-model"], "model"), false);
  assert.equal(row.costByModel["mystery-model"].currency, "CNY");
});

test("cost details convert before merging same-model native currencies and preserve source amounts", () => {
  const previous = { costScaleTarget: state.costScaleTarget, usdToCnyRate: state.usdToCnyRate };
  const summary = {
    timeline: [
      { costByModel: { "mystery-model": { totalUsd: 1, currency: "USD", pricedTokens: 10 } } },
      { costByModel: { "mystery-model": { totalUsd: 2, currency: "CNY", pricedTokens: 20 } } },
      { costByModel: { "usd-only": { totalUsd: 3, currency: "USD", pricedTokens: 30 } } },
      { costByModel: { "cny-only": { totalUsd: 7, currency: "CNY", pricedTokens: 40 } } },
      { costByModel: { "mystery-model": { totalUsd: 0.001, currency: "CNY", pricedTokens: 1 } } },
    ],
  };
  const original = structuredClone(summary);
  try {
    state.usdToCnyRate = 7;
    for (const currency of ["USD", "CNY", "USD"]) {
      state.costScaleTarget = currency;
      const rows = timelineDetailRows(summary, "cost");
      const multiplier = currency === "USD" ? 1 : 7;
      assert.deepEqual(
        rows.map((row) => row.name),
        ["usd-only", "mystery-model", "cny-only"],
      );
      assert.ok(Math.abs(rows[1].value - (1 + 2.001 / 7) * multiplier) < 1e-12);
      assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.value, 0) - (4 + 9.001 / 7) * multiplier) < 1e-12);
      assert.deepEqual(summary, original);
    }
  } finally {
    Object.assign(state, previous);
  }
});

test("tooltip and legend show one model with the selected currency", () => {
  const row = {
    key: "2026-07-01",
    costByModel: {
      "mystery-model\u0000CNY": {
        model: "mystery-model",
        totalUsd: 2,
        currency: "CNY",
        pricedTokens: 20,
      },
      "mystery-model\u0000USD": {
        model: "mystery-model",
        totalUsd: 1,
        currency: "USD",
        pricedTokens: 10,
      },
    },
    pricedTokens: 30,
    unpricedTokens: 0,
  };

  const previous = { costScaleTarget: state.costScaleTarget, usdToCnyRate: state.usdToCnyRate };
  try {
    state.usdToCnyRate = 7;
    for (const [currency, amount, other] of [
      ["USD", "$1.29", "¥"],
      ["CNY", "¥9.00", "$"],
    ]) {
      state.costScaleTarget = currency;
      const tooltip = formatTimelineTooltip(row, "cost");
      assert.equal(tooltip.split(amount).length - 1, 2);
      assert.equal((tooltip.match(/usage-tooltip-label">mystery-model/g) || []).length, 1);
      assert.equal(tooltip.includes("\u0000"), false);
      assert.equal(tooltip.includes(other), false);
      assert.doesNotMatch(tooltip, /≈/);
    }
  } finally {
    Object.assign(state, previous);
  }

  const legend = renderTimelineLegendHtml(
    { timeline: [row] },
    "cost",
    new Map(),
    new Map([["mystery-model", "#123456"]]),
  );
  assert.equal((legend.match(/timeline-legend-item/g) || []).length, 1);
  assert.match(legend, />mystery-model</);
  assert.equal(legend.includes("\u0000"), false);
});
