import assert from "node:assert/strict";
import test from "node:test";

import {
  datePickerMonthModel,
  drawTimeline,
  filterPeriodComparisonRows,
  getChannelColors,
  getModelColors,
  renderTimelineLegendHtml,
  getRange,
  maxTimelineValue,
  nextComparisonSort,
  formatTokenMillions,
  renderBarListHtml,
  renderCostDetailHtml,
  renderComparisonHtml,
  renderDatePickerHtml,
  renderHomesHtml,
  renderSourceOptionsHtml,
  formatCostAmount,
  formatCostPair,
  costPairFromSlots,
  costScaleValue,
  fitTextToWidth,
  renderPeriodComparisonTableHtml,
  setSummaryFilters,
  timelineAxisLabels,
  timelineDetailRows,
} from "../public/app.js";

test("token values use two decimal places in millions and retain exact hover values", () => {
  assert.equal(formatTokenMillions(62_617_267), "62.62M");

  const barHtml = renderBarListHtml([
    { key: "gpt-6-luna", name: "gpt-6-luna", total: { total: 62_617_267 } },
  ]);
  assert.match(barHtml, /title="62,617,267">62\.62M/);

  const comparisonHtml = renderPeriodComparisonTableHtml([
    {
      key: "gpt-6-luna",
      name: "gpt-6-luna",
      periods: { today: { total: 62_617_267 }, week: { total: 0 }, month: { total: 0 }, all: { total: 0 } },
    },
  ], {
    totals: { today: { total: 62_617_267 }, week: { total: 0 }, month: { total: 0 }, all: { total: 0 } },
  });
  assert.match(comparisonHtml, /title="62,617,267">62\.62M/);
  assert.doesNotMatch(comparisonHtml, /aria-controls="model-period-0-detail"/);

  const expandedHtml = renderPeriodComparisonTableHtml([
    {
      key: "gpt-6-luna",
      name: "gpt-6-luna",
      periods: { today: { total: 62_617_267 }, week: { total: 0 }, month: { total: 0 }, all: { total: 0 } },
    },
  ], {
    expanded: { kind: "model", key: "gpt-6-luna", period: "today" },
  });
  assert.match(expandedHtml, /aria-controls="model-period-0-detail"/);
  assert.match(expandedHtml, /id="model-period-0-detail"/);
});

test("timeline details follow channel, model, and cost modes", () => {
  const channels = [{ name: "CLI", total: { total: 20 } }];
  const models = [{ name: "gpt-6-sol", total: { total: 20 } }];
  const summary = {
    channels,
    models,
    timeline: [
      { costByModel: { "gpt-6-sol": { totalUsd: 0.3 }, "gpt-6-luna": { totalUsd: 0.1 } } },
      { costByModel: { "gpt-6-sol": { totalUsd: 0.2 }, "gpt-6-luna": { totalUsd: 0.5 } } },
    ],
  };
  assert.equal(timelineDetailRows(summary, "channel"), channels);
  assert.equal(timelineDetailRows(summary, "model"), models);
  assert.deepEqual(timelineDetailRows(summary, "cost"), [
    { name: "gpt-6-luna", totalUsd: 0.6, currency: "USD", scaleValue: 0.6 },
    { name: "gpt-6-sol", totalUsd: 0.5, currency: "USD", scaleValue: 0.5 },
  ]);
  assert.deepEqual(timelineDetailRows({ ...summary, timelineError: "too many slots" }, "cost"), []);
});

test("cost details show model amounts and escape model names", () => {
  const oldDocument = globalThis.document;
  globalThis.document = { documentElement: { dataset: { theme: "light" } } };
  try {
    const html = renderCostDetailHtml([
      { name: '<img src=x onerror="alert(1)">', totalUsd: 1.25 },
      { name: "gpt-6-sol", totalUsd: 0.5 },
      { name: "gpt-6-luna", totalUsd: 1.256 },
    ]);
    assert.match(html, /\$1\.25/);
    assert.match(html, /\$0\.50/);
    assert.match(html, /\$1\.26/);
    assert.doesNotMatch(html, /\$1\.256/);
    assert.match(html, /width: 40%/);
    assert.doesNotMatch(html, /<img/);
    assert.match(html, /&lt;img/);
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});
test("comparison sort cycles through descending, ascending, and default order", () => {
  const defaultSort = { period: "today", direction: "desc", showIndicator: false };
  const descending = nextComparisonSort(defaultSort, "today");
  const ascending = nextComparisonSort(descending, "today");
  const cancelled = nextComparisonSort(ascending, "today");
  assert.deepEqual(descending, { period: "today", direction: "desc", showIndicator: true });
  assert.deepEqual(ascending, { period: "today", direction: "asc", showIndicator: true });
  assert.deepEqual(cancelled, defaultSort);
  assert.deepEqual(nextComparisonSort(ascending, "week"), { period: "week", direction: "desc", showIndicator: true });

  const rows = [
    { key: "directory:large", name: "/work/large", kind: "directory", periods: { today: { total: 100 } } },
    { key: "git:small", name: "/work/small", kind: "git", periods: { today: { total: 10 } } },
    { key: "git:medium", name: "/work/medium", kind: "git", periods: { today: { total: 20 } } },
  ];
  const rowNames = (sort, kind) => [...renderPeriodComparisonTableHtml(rows, { kind, sort })
    .matchAll(/class="comparison-row-label"[^>]*>([^<]+)<\/span>/g)].map((match) => match[1]);
  assert.deepEqual(rowNames(defaultSort, "repository"), ["medium", "small", "large"]);
  assert.deepEqual(rowNames(ascending, "repository"), ["small", "medium", "large"]);
  assert.deepEqual(rowNames(cancelled, "repository"), ["medium", "small", "large"]);
  assert.deepEqual(rowNames(defaultSort, "model"), ["/work/large", "/work/medium", "/work/small"]);
  assert.deepEqual(rowNames(ascending, "model"), ["/work/small", "/work/medium", "/work/large"]);
  assert.match(renderPeriodComparisonTableHtml(rows, { sort: cancelled }), /aria-sort="none"/);
});

test("natural week comparison headings and accessible sort labels use 本周", () => {
  const rows = [{
    key: "gpt-6-luna",
    name: "gpt-6-luna",
    periods: {
      today: { total: 1 },
      week: { total: 2 },
      month: { total: 3 },
      all: { total: 4 },
    },
  }];
  const html = renderPeriodComparisonTableHtml(rows, {
    kind: "model",
    expanded: { kind: "model", key: "gpt-6-luna", period: "week" },
  });
  assert.match(html, /本周/);
  assert.match(html, /aria-label="按本周用量排序"/);
  assert.match(html, /title="按本周用量排序"/);
  assert.match(html, /本周明细/);
  assert.doesNotMatch(html, /本自然周明细/);
});

test("period comparison includes the union of all four periods and reconciles totals", () => {
  const models = filterPeriodComparisonRows([
    {
      key: "gpt-6-luna",
      periods: {
        today: { total: 120 },
        week: { total: 200 },
        month: { total: 300 },
        all: { total: 400 },
      },
    },
    {
      key: "gpt-6-sol",
      periods: {
        today: { total: 0 },
        week: { total: 4 },
        month: { total: 4 },
        all: { total: 4 },
      },
    },
    {
      key: "gpt-6-astra",
      periods: {
        today: { total: 0 },
        week: { total: 0 },
        month: { total: 0 },
        all: { total: 0 },
      },
    },
  ]);
  assert.deepEqual(models.map((row) => row.key), ["gpt-6-luna", "gpt-6-sol"]);
  for (const [period, total] of Object.entries({ today: 120, week: 204, month: 304, all: 404 })) {
    assert.equal(models.reduce((sum, row) => sum + row.periods[period].total, 0), total);
  }

  const repositories = filterPeriodComparisonRows([
    {
      key: "directory:shared",
      kind: "directory",
      periods: { today: { total: 12 }, week: { total: 12 }, month: { total: 12 }, all: { total: 12 } },
    },
    {
      key: "directory:inactive",
      kind: "directory",
      periods: { today: { total: 0 }, week: { total: 0 }, month: { total: 0 }, all: { total: 0 } },
    },
    {
      key: "git:repo",
      kind: "git",
      sourceKeys: ["git:repo"],
      periods: { today: { total: 0 }, week: { total: 30 }, month: { total: 30 }, all: { total: 30 } },
    },
  ]);
  assert.deepEqual(repositories.map((row) => row.key), ["directory:shared", "git:repo"]);
});

test("event date range handles enough records to exceed argument spread limits", () => {
  setSummaryFilters({ preset: "all", now: null, startDate: "", endDate: "" });
  const firstTimestamp = Date.parse("2026-01-01T00:00:00.000Z");
  const lastTimestamp = firstTimestamp + 124_999 * 1000;
  const events = Array.from({ length: 125_000 }, (_, index) => ({
    timestamp: new Date(firstTimestamp + index * 1000).toISOString(),
  }));

  const range = getRange(events);
  assert.ok(range.start instanceof Date);
  assert.ok(range.end instanceof Date);
  assert.ok(range.start.getTime() <= firstTimestamp);
  assert.ok(range.end.getTime() >= lastTimestamp);
});

test("timeline maximum handles enough values to exceed argument spread limits", () => {
  const values = Array(125_000).fill(1);
  values[values.length - 1] = 42;
  assert.equal(maxTimelineValue(values), 42);
});

test("channel colors remain attached to channels when row order changes", () => {
  const oldDocument = globalThis.document;
  const oldGetComputedStyle = globalThis.getComputedStyle;
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  try {
    const channels = [{ name: "CLI" }, { name: "IDE" }, { name: "API" }, { name: "Unknown" }];
    const first = getChannelColors(channels);
    const reordered = getChannelColors([...channels].reverse());
    for (const channel of channels) {
      assert.equal(reordered.get(channel.name), first.get(channel.name));
    }
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
    if (oldGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = oldGetComputedStyle;
  }
});

test("timeline model and channel legends assign distinct colors in both themes", () => {
  const oldDocument = globalThis.document;
  const rows = ["gpt-5.6-luna", "gpt-6-luna", "gpt-5.6-sol", "gpt-6-sol", "gpt-6-astra", "codex-auto-review"]
    .map((name, index) => ({ name, total: { total: 600 - index * 100 } }));
  const rgb = (hex) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  try {
    for (const theme of ["light", "dark"]) {
      globalThis.document = { documentElement: { dataset: { theme } } };
      for (const colorsFor of [getModelColors, getChannelColors]) {
        const colors = colorsFor(rows);
        const reordered = colorsFor([...rows].reverse());
        const swatches = [...colors.values()];
        assert.equal(new Set(swatches).size, rows.length);
        for (const row of rows) assert.equal(colors.get(row.name), reordered.get(row.name));
        if (colorsFor === getModelColors) {
          assert.equal(colors.get("gpt-6-luna"), getModelColors([{ name: "gpt-6-luna" }]).get("gpt-6-luna"));
        }
        for (let i = 0; i < swatches.length; i += 1) {
          for (let j = i + 1; j < swatches.length; j += 1) {
            const first = rgb(swatches[i]);
            const second = rgb(swatches[j]);
            assert.ok(Math.hypot(...first.map((value, channel) => value - second[channel])) > 85);
          }
        }
      }
    }
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

test("timeline legend shows every model directly without a heading or expand control", () => {
  const oldDocument = globalThis.document;
  globalThis.document = { documentElement: { dataset: { theme: "dark" } } };
  try {
    const names = ["gpt-5.6-luna", "gpt-6-luna", "gpt-5.6-sol", "gpt-6-sol",
      "gpt-6-astra", "codex-auto-review", "Unknown model"];
    const colors = getModelColors(names.map((name) => ({ name })));
    const timeline = [{
      models: names.map((name, index) => ({ name, total: { total: index + 1 } })),
      costByModel: Object.fromEntries(names.map((name, index) => [name, { totalUsd: index + 1 }])),
    }];
    for (const mode of ["model", "cost"]) {
      const html = renderTimelineLegendHtml({ timeline }, mode, new Map(), colors);
      assert.equal((html.match(/role="listitem"/g) || []).length, names.length);
      for (const name of names) assert.ok(html.includes(`>${name}</span>`));
      assert.doesNotMatch(html, /<details|timeline-legend-title|其余/);
    }
  } finally {
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

test("render helpers escape usage row names before inserting HTML", () => {
  const rows = [
    {
      name: '<img src=x onerror="alert(1)">',
      total: { total: 42, input: 40, cached: 0, output: 2, reasoning: 0 },
    },
  ];

  const barHtml = renderBarListHtml(rows);

  assert.doesNotMatch(barHtml, /<img/i);
  assert.match(barHtml, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
});

test("renderHomesHtml shows escaped statuses and removable imported directories", () => {
  const html = renderHomesHtml(
    [
      {
        label: "Project <unsafe>",
        kind: "project-log",
        path: "/tmp/project&one",
        imported: true,
        status: "active",
        eventCount: 3,
      },
    ],
    { canModify: true },
  );

  assert.doesNotMatch(html, /Project <unsafe>/);
  assert.match(html, /Project &lt;unsafe&gt;/);
  assert.match(html, /\/tmp\/project&amp;one/);
  assert.match(html, /data-import-action="remove"/);
  assert.match(html, /有用量记录/);
});

test("renderSourceOptionsHtml 勾选默认选中的来源并跳过无 id 项", () => {
  const homes = [
    { id: "main-1", label: "Main Codex", kind: "main", path: "/u/.codex", eventCount: 5, sessionCount: 2 },
    { id: "zcode-1", label: "Main ZCode", kind: "zcode", path: "/u/.zcode", eventCount: 9, sessionCount: 3 },
    { label: "导入 <unsafe>", kind: "unsupported", path: "/tmp/x", eventCount: 0 },
  ];
  const html = renderSourceOptionsHtml(homes, ["zcode-1"]);

  assert.match(html, /data-source-id="main-1" checked/);
  assert.doesNotMatch(html, /data-source-id="zcode-1" checked/);
  assert.match(html, /Main ZCode/);
  // 没有稳定 id 的条目（如不支持的导入）不进入多选列表。
  assert.doesNotMatch(html, /unsafe/);
  assert.equal(renderSourceOptionsHtml([], []), `<div class="empty">没有可统计的来源</div>`);
});

test("renderHomesHtml 标记被排除统计的来源", () => {
  const html = renderHomesHtml(
    [
      { id: "zcode-1", label: "Main ZCode", kind: "zcode", path: "/u/.zcode", status: "active", eventCount: 9, sessionCount: 3 },
      { id: "main-1", label: "Main Codex", kind: "main", path: "/u/.codex", status: "active", eventCount: 5, sessionCount: 2 },
    ],
    { excludedIds: ["zcode-1"] },
  );

  assert.match(html, /home-row excluded/);
  assert.match(html, /不计入统计/);
  assert.equal((html.match(/不计入统计/g) || []).length, 1);
});

test("费用金额按币种显示符号，混合币种并列展示", () => {
  assert.match(formatCostAmount(1.5, "USD"), /\$1\.50/);
  assert.match(formatCostAmount(1.5, "CNY"), /1\.50/);
  assert.match(formatCostAmount(1.5, "CNY"), /¥/);
  assert.equal(formatCostPair(null, null), "—");
  assert.match(formatCostPair(1, null), /^\$1\.00$/);
  assert.match(formatCostPair(null, 2), /2\.00/);
  assert.match(formatCostPair(1, 2), /\$1\.00 \+ .*2\.00/);

  const pair = costPairFromSlots({
    a: { totalUsd: 3, currency: "USD" },
    b: { totalUsd: 4, currency: "CNY" },
    c: { totalUsd: 0, currency: "CNY" },
  });
  assert.deepEqual(pair, { usd: 3, cny: 4 });
  assert.deepEqual(costPairFromSlots({}), { usd: null, cny: null });
});

test("fitTextToWidth 只缩小字号且不破下限，放得下时不改动", () => {
  const oldGetComputedStyle = globalThis.getComputedStyle;
  const makeElement = (fitsAtSize) => {
    const element = { style: { fontSize: "" }, clientWidth: 100 };
    Object.defineProperty(element, "scrollWidth", {
      get() {
        const size = this.style.fontSize ? parseFloat(this.style.fontSize) : 22;
        return size <= fitsAtSize ? 100 : 140;
      },
    });
    return element;
  };
  globalThis.getComputedStyle = () => ({ fontSize: "22px" });
  try {
    const needsShrink = makeElement(16);
    fitTextToWidth(needsShrink);
    assert.equal(needsShrink.style.fontSize, "16px");

    const hopeless = makeElement(5);
    fitTextToWidth(hopeless);
    assert.equal(hopeless.style.fontSize, "11px");

    const alreadyFits = makeElement(22);
    fitTextToWidth(alreadyFits);
    assert.equal(alreadyFits.style.fontSize, "");
  } finally {
    globalThis.getComputedStyle = oldGetComputedStyle;
  }
});

test("图例按名称字母排序，跨币种费用按汇率折算比较", () => {
  const summary = {
    timeline: [
      {
        channels: [{ name: "ZCode", total: { total: 500 } }],
        models: [{ name: "aaa-model", total: { total: 200 } }, { name: "zzz-model", total: { total: 500 } }],
      },
    ],
  };
  const legendHtml = renderTimelineLegendHtml(summary, "model", new Map(), new Map([
    ["aaa-model", "#111111"],
    ["zzz-model", "#222222"],
  ]));
  // 字母序：aaa 在前；若按用量排 zzz 会在前。
  assert.ok(legendHtml.indexOf("aaa-model") < legendHtml.indexOf("zzz-model"));

  // ¥75.51 按 7.2 汇率约合 $10.49，排序应低于 $60.11。
  assert.ok(costScaleValue(75.51, "CNY", 7.2, "CNY") < costScaleValue(60.11, "USD", 7.2, "CNY"));
  assert.ok(costScaleValue(75.51, "CNY", 7.2, "USD") < costScaleValue(60.11, "USD", 7.2, "USD"));
  assert.equal(costScaleValue(75.51, "CNY", 7.2, "CNY"), 75.51);
  assert.ok(Math.abs(costScaleValue(60.11, "USD", 7.2, "CNY") - 432.792) < 1e-9);
});

test("renderComparisonHtml renders trend, average trend, and previous totals", () => {
  const html = renderComparisonHtml({
    label: "较上周",
    previousRange: {
      start: "2026-06-15T00:00:00.000Z",
      end: "2026-06-21T23:59:59.999Z",
    },
    previousTotals: { total: 62_617_267, input: 62_617_267, cached: 0, output: 0, reasoning: 0 },
    previousSessionCount: 2,
    totalDelta: -25_518_704,
    percentChange: -57.14,
    averageBaselineTotal: 50,
    averageDelta: 8_581_809,
    averagePercentChange: 500,
  });

  assert.match(html, /较上周/);
  assert.match(html, /平均趋势变化/);
  assert.match(html, /上周 tokens/);
  assert.match(html, /<strong title="-25,518,704">-25\.52M<\/strong>/);
  assert.match(html, /<strong title="\+8,581,809">\+8\.58M<\/strong>/);
  assert.match(html, /<strong title="62,617,267">62\.62M<\/strong>/);
  assert.match(html, /2 个会话/);
});

test("renderComparisonHtml names the previous token period for day, week, and month", () => {
  const labels = [
    ["较昨日", "昨日 tokens"],
    ["较上周", "上周 tokens"],
    ["较上月", "上月 tokens"],
  ];

  for (const [comparisonLabel, expected] of labels) {
    const html = renderComparisonHtml({
      label: comparisonLabel,
      previousRange: { start: "2026-06-01T00:00:00.000Z", end: "2026-06-01T23:59:59.999Z" },
      previousTotals: { total: 1_000_000 },
      previousSessionCount: 1,
      totalDelta: 0,
      percentChange: 0,
      averageDelta: 0,
      averagePercentChange: 0,
    });

    assert.ok(html.includes(`<span>${expected}</span>`), `expected ${comparisonLabel} to render ${expected}`);
  }
});

test("renderComparisonHtml explains all-time comparisons and dates custom baselines", () => {
  const allTimeHtml = renderComparisonHtml({ label: "暂无对比", previousRange: null });
  assert.match(allTimeHtml, /全部范围没有可比较的上一周期/);
  assert.doesNotMatch(allTimeHtml, /上一周期 tokens/);
  const incompleteCustomHtml = renderComparisonHtml({ label: "较上一等长周期", previousRange: null });
  assert.match(incompleteCustomHtml, /当前范围没有可比较的上一周期/);

  const customHtml = renderComparisonHtml({
    label: "较上一等长周期",
    previousRange: {
      start: new Date(2026, 7, 31),
      end: new Date(2026, 8, 9, 23, 59, 59, 999),
    },
    previousTotals: { total: 12_345_678 },
    previousSessionCount: 4,
    totalDelta: 1_000_000,
    percentChange: 8.1,
    averageDelta: 500_000,
    averagePercentChange: 4.2,
  });
  assert.match(customHtml, /前一等长区间 tokens/);
  assert.match(customHtml, /2026-08-31 至 2026-09-09 · 4 个会话/);
});

test("datePickerMonthModel starts weeks on Monday and keeps outside-month days selectable", () => {
  const model = datePickerMonthModel(new Date("2026-07-15T12:00:00"), "2026-06-30");

  assert.deepEqual(model.weekdays, ["一", "二", "三", "四", "五", "六", "日"]);
  assert.deepEqual(
    model.cells.slice(0, 7).map((cell) => [cell.date, cell.inCurrentMonth]),
    [
      ["2026-06-29", false],
      ["2026-06-30", false],
      ["2026-07-01", true],
      ["2026-07-02", true],
      ["2026-07-03", true],
      ["2026-07-04", true],
      ["2026-07-05", true],
    ],
  );
  assert.equal(model.cells[1].selected, true);
});

test("renderDatePickerHtml marks outside-month dates as dim but selectable buttons", () => {
  const html = renderDatePickerHtml({
    field: "start",
    viewDate: new Date("2026-07-15T12:00:00"),
    selectedValue: "2026-06-30",
  });

  assert.match(html, /<div class="date-picker-weekday">一<\/div>/);
  assert.match(html, /data-date="2026-06-29"[^>]*class="date-picker-day outside-month"/);
  assert.match(html, /data-date="2026-06-30"[^>]*class="date-picker-day outside-month selected"/);
  assert.match(html, /data-date="2026-07-01"[^>]*class="date-picker-day"/);
  assert.match(html, /type="button"[^>]*data-date="2026-06-29"/);
});

test("timelineAxisLabels shows all 24 labels for a single hourly day", () => {
  // Single-day hourly charts should label every hour from midnight through the last hour.
  const rows = Array.from({ length: 24 }, (_, hour) => ({
    key: `2026-06-18 ${String(hour).padStart(2, "0")}:00`,
  }));

  assert.deepEqual(
    timelineAxisLabels(rows, {
      bucket: "hour",
      range: {
        start: "2026-06-18T00:00:00",
        end: "2026-06-18T23:59:59.999",
      },
      maxLabels: 8,
    }).map((label) => label.label),
    Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")),
  );
});

test("timelineAxisLabels samples hourly labels outside a single day", () => {
  // Multi-day hourly charts keep labels evenly distributed instead of drawing every hour.
  const rows = Array.from({ length: 48 }, (_, index) => {
    const day = index < 24 ? "18" : "19";
    const hour = String(index % 24).padStart(2, "0");
    return { key: `2026-06-${day} ${hour}:00` };
  });
  const labels = timelineAxisLabels(rows, {
    bucket: "hour",
    range: {
      start: "2026-06-18T00:00:00",
      end: "2026-06-19T23:59:59.999",
    },
    maxLabels: 8,
  });

  assert.equal(labels.length, 8);
  assert.deepEqual(
    labels.map((label) => label.index),
    [0, 7, 13, 20, 27, 34, 40, 47],
  );
  assert.deepEqual(
    [labels[0].label, labels.at(-1).label],
    ["06-18 00", "06-19 23"],
  );
});

test("drawTimeline does not draw visible bars for zero-token rows", () => {
  // Empty hourly buckets should keep hit areas and labels without painting 2px fake bars.
  const calls = [];
  const context = {
    clearRect: (...args) => calls.push(["clearRect", ...args]),
    scale: (...args) => calls.push(["scale", ...args]),
    beginPath: (...args) => calls.push(["beginPath", ...args]),
    moveTo: (...args) => calls.push(["moveTo", ...args]),
    lineTo: (...args) => calls.push(["lineTo", ...args]),
    stroke: (...args) => calls.push(["stroke", ...args]),
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    fillText: (...args) => calls.push(["fillText", ...args]),
    save: (...args) => calls.push(["save", ...args]),
    translate: (...args) => calls.push(["translate", ...args]),
    rotate: (...args) => calls.push(["rotate", ...args]),
    restore: (...args) => calls.push(["restore", ...args]),
  };
  const canvas = {
    clientWidth: 960,
    clientHeight: 320,
    dataset: {},
    getContext: () => context,
  };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: () => "",
  });

  try {
    drawTimeline(canvas, [
      {
        key: "2026-06-18 00:00",
        total: { total: 0 },
        channels: [],
      },
    ]);

    assert.equal(calls.filter(([name]) => name === "fillRect").length, 0);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});

test("drawTimeline renders model and cost stacks and rejects missing breakdowns", () => {
  const calls = [];
  let currentFillStyle = "";
  const context = {
    clearRect: () => {},
    scale: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fillRect: (...args) => calls.push({ type: "rect", fillStyle: currentFillStyle, args }),
    fillText: (text) => calls.push({ type: "text", text }),
    save: () => {},
    translate: () => {},
    rotate: () => {},
    restore: () => {},
    set fillStyle(value) { currentFillStyle = value; },
    get fillStyle() { return currentFillStyle; },
  };
  const canvas = {
    clientWidth: 960,
    clientHeight: 320,
    dataset: {},
    getContext: () => context,
  };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });

  try {
    const row = {
      key: "2026-09-23 12:00",
      total: { total: 100 },
      channels: [],
      models: [{ name: "gpt-6-sol", total: { total: 100 } }],
      costByModel: {
        "gpt-6-sol": { totalUsd: 0.25, pricedTokens: 100, unpricedTokens: 0 },
      },
      pricedTokens: 100,
      unpricedTokens: 0,
    };
    const modelRows = [{ name: "gpt-6-sol", total: { total: 100 } }];

    const allPeriodColors = new Map([["gpt-6-sol", "#123456"]]);
    drawTimeline(canvas, [row], [], new Map(), null, "model", modelRows, allPeriodColors);
    const modelBars = calls.filter((call) => call.type === "rect");
    assert.equal(modelBars.length, 1);
    assert.equal(modelBars[0].fillStyle, allPeriodColors.get("gpt-6-sol"));

    calls.length = 0;
    drawTimeline(canvas, [row], [], new Map(), null, "cost", modelRows, allPeriodColors);
    const costBars = calls.filter((call) => call.type === "rect");
    assert.equal(costBars.length, 1);
    assert.equal(costBars[0].fillStyle, modelBars[0].fillStyle);
    assert.ok(calls.some((call) => call.type === "text" && call.text === "$0.25"));

    const staleRow = { key: row.key, total: row.total };
    for (const [mode, message] of [
      ["model", "模型明细不可用"],
      ["cost", "费用明细不可用"],
    ]) {
      calls.length = 0;
      drawTimeline(canvas, [staleRow], [], new Map(), null, mode, modelRows);
      assert.equal(calls.filter((call) => call.type === "rect").length, 0);
      assert.ok(calls.some((call) => call.type === "text" && call.text.includes(message)));
    }
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});
test("drawTimeline keeps dense hourly bars inside the chart width", () => {
  // Dense all-time hourly charts must shrink visual bars instead of pushing later bars off-canvas.
  const calls = [];
  const context = {
    clearRect: (...args) => calls.push(["clearRect", ...args]),
    scale: (...args) => calls.push(["scale", ...args]),
    beginPath: (...args) => calls.push(["beginPath", ...args]),
    moveTo: (...args) => calls.push(["moveTo", ...args]),
    lineTo: (...args) => calls.push(["lineTo", ...args]),
    stroke: (...args) => calls.push(["stroke", ...args]),
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    fillText: (...args) => calls.push(["fillText", ...args]),
    save: (...args) => calls.push(["save", ...args]),
    translate: (...args) => calls.push(["translate", ...args]),
    rotate: (...args) => calls.push(["rotate", ...args]),
    restore: (...args) => calls.push(["restore", ...args]),
  };
  const canvas = {
    clientWidth: 1200,
    clientHeight: 320,
    dataset: {},
    getContext: () => context,
  };
  const rows = Array.from({ length: 700 }, (_, index) => ({
    key: `2026-06-${String(Math.floor(index / 24) + 1).padStart(2, "0")} ${String(index % 24).padStart(2, "0")}:00`,
    total: { total: index === 699 ? 100 : 1 },
    channels: [],
  }));
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: () => "",
  });

  try {
    drawTimeline(canvas, rows);

    const visibleBars = calls.filter(([name]) => name === "fillRect");
    const lastBar = visibleBars.at(-1);
    assert.ok(lastBar[1] + lastBar[3] <= 1200 - 18);
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});

test("timeline labels show natural week weekdays and full month dates", () => {
  const weekRows = Array.from({ length: 7 }, (_, index) => ({
    key: `2026-05-${String(4 + index).padStart(2, "0")}`,
  }));
  assert.deepEqual(
    timelineAxisLabels(weekRows, {
      bucket: "day",
      range: { preset: "week", start: "2026-05-04T00:00:00", end: "2026-05-05T23:59:59" },
    }).map((label) => label.label),
    ["周一", "周二", "周三", "周四", "周五", "周六", "周日"],
  );

  const monthRows = Array.from({ length: 29 }, (_, index) => ({
    key: `2024-02-${String(index + 1).padStart(2, "0")}`,
  }));
  const labels = timelineAxisLabels(monthRows, {
    bucket: "day",
    range: { preset: "month", start: "2024-02-01T00:00:00", end: "2024-02-10T23:59:59" },
    chartWidth: 2000,
    maxLabels: 31,
  });
  assert.equal(labels.length, 29);
  assert.deepEqual([labels[0].label, labels.at(-1).label], ["01", "29"]);

  assert.equal(
    timelineAxisLabels([{ key: "2026-05-04" }], {
      bucket: "week",
      range: { preset: "all", start: "2026-05-04T00:00:00", end: "2026-05-10T23:59:59" },
    })[0].label,
    "05-04",
  );
});

test("drawTimeline centers date ticks under capped slot bars", () => {
  const calls = [];
  const context = {
    clearRect: (...args) => calls.push(["clearRect", ...args]),
    scale: (...args) => calls.push(["scale", ...args]),
    beginPath: (...args) => calls.push(["beginPath", ...args]),
    moveTo: (...args) => calls.push(["moveTo", ...args]),
    lineTo: (...args) => calls.push(["lineTo", ...args]),
    stroke: (...args) => calls.push(["stroke", ...args]),
    fillRect: (...args) => calls.push(["fillRect", ...args]),
    fillText: (...args) => calls.push(["fillText", ...args]),
    save: (...args) => calls.push(["save", ...args]),
    translate: (...args) => calls.push(["translate", ...args]),
    rotate: (...args) => calls.push(["rotate", ...args]),
    restore: (...args) => calls.push(["restore", ...args]),
  };
  const canvas = {
    clientWidth: 960,
    clientHeight: 320,
    dataset: {},
    getContext: () => context,
  };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "" });
  try {
    drawTimeline(canvas, [{ key: "2026-05-26", total: { total: 100 }, channels: [] }], [], new Map(), {
      preset: "custom", start: "2026-05-26T00:00:00", end: "2026-05-26T23:59:59",
    }, "channel");
    const bar = calls.find(([name]) => name === "fillRect");
    const tick = calls.find(([name]) => name === "translate");
    assert.ok(bar);
    assert.equal(bar[3], 30);
    assert.equal(bar[1] + bar[3] / 2, tick[1]);
    assert.ok(bar[3] < (960 - 64 - 18));
  } finally {
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.getComputedStyle;
  }
});
