import assert from "node:assert/strict";
import test from "node:test";

import {
  costPairFromSlots,
  formatTimelineTooltip,
  renderTimelineLegendHtml,
  timelineDetailRows,
} from "../public/app.js";
import { buildTimelineRows } from "../public/timeline-utils.js";
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

test("cross-bucket cost detail groups by model and native currency", () => {
  const rows = timelineDetailRows(
    {
      timeline: [
        { costByModel: { "mystery-model": { totalUsd: 1, currency: "USD", pricedTokens: 10 } } },
        { costByModel: { "mystery-model": { totalUsd: 2, currency: "CNY", pricedTokens: 20 } } },
      ],
    },
    "cost",
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(Object.fromEntries(rows.map((row) => [row.currency, { name: row.name, totalUsd: row.totalUsd }])), {
    CNY: { name: "mystery-model", totalUsd: 2 },
    USD: { name: "mystery-model", totalUsd: 1 },
  });
});

test("tooltip and legend reuse the original model name and keep native amounts separate", () => {
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

  const tooltip = formatTimelineTooltip(row, "cost");
  assert.match(tooltip, /\$1\.00/);
  assert.match(tooltip, /2\.00/);
  assert.equal((tooltip.match(/usage-tooltip-label">mystery-model/g) || []).length, 2);
  assert.equal(tooltip.includes("\u0000"), false);

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
