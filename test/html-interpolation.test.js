import assert from "node:assert/strict";
import test from "node:test";

import {
  renderBarListHtml,
  renderComparisonHtml,
  renderPeriodComparisonTableHtml,
  renderPricingSourceLinksHtml,
  renderTimelineLegendHtml,
} from "../public/app.js";
import { renderDatePickerHtml } from "../public/calendar.js";

const markup = '<img src=x onerror="alert(1)">';

test("text, quoted attributes, and trusted fragments stay in their HTML contexts", () => {
  const row = {
    key: `repo\" onclick=\"alert(1)${markup}`,
    name: markup,
    periods: { today: { total: 10 } },
  };
  const html = renderPeriodComparisonTableHtml([row], {
    kind: "repository",
    expanded: { kind: "repository", key: row.key, period: "today" },
  });
  assert.match(html, /data-key="repo&quot; onclick=&quot;alert\(1\)/);
  assert.doesNotMatch(html, /<img\b|onclick="alert\(1\)"/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);

  const picker = renderDatePickerHtml({ field: 'start" onclick="alert(1)', viewDate: new Date(2026, 8, 1) });
  assert.match(picker, /data-date-picker-field="start&quot; onclick=&quot;alert\(1\)"/);
  assert.doesNotMatch(picker, /onclick="alert\(1\)"/);

  const git = renderPeriodComparisonTableHtml([{ ...row, kind: "git" }], { kind: "repository" });
  assert.match(git, /<svg class="repository-git-icon"/);
  assert.doesNotMatch(git, /<img\b/);
});

test("pricing links require HTTP URLs and label only the exact known host", () => {
  const html = renderPricingSourceLinksHtml([
    "https://developers.openai.com/api/docs/pricing",
    "https://developers.openai.com/api/docs/pricing",
    "https://example.test/path?next=developers.openai.com",
    "http://constructor/",
    "javascript:alert(1)",
    "data:text/html,<img src=x onerror=alert(1)>",
    "https://user@example.test/path",
  ], ["USD"]);
  assert.equal((html.match(/OpenAI 价格表/g) || []).length, 1);
  assert.match(html, />example\.test<\/a>/);
  assert.match(html, />constructor<\/a>/);
  assert.doesNotMatch(html, /javascript:|data:text|<img\b|user@/);
  assert.equal(renderPricingSourceLinksHtml(["https://developers.openai.com/pricing"], ["CNY"]), "");
});

test("chart colors cannot break out of style attributes", () => {
  const color = '#123456" onmouseover="alert(1)';
  const row = { name: markup, total: { total: 10 } };
  const bars = renderBarListHtml([row], new Map([[row.name, color]]));
  const legend = renderTimelineLegendHtml({ timeline: [{ channels: [row] }] }, "channel", new Map([[row.name, color]]), new Map());
  assert.doesNotMatch(bars + legend, /onmouseover=|background: #123456/);
  assert.match(bars + legend, /var\(--green\)/);
  assert.match(bars + legend, /&lt;img/);
});

test("malformed comparison percentages cannot become HTML", () => {
  const html = renderComparisonHtml({
    label: "较昨日", previousRange: { start: "2026-09-26", end: "2026-09-26" },
    previousTotals: { total: 5 }, previousSessionCount: 1,
    totalDelta: 5, averageDelta: 5,
    percentChange: markup, averagePercentChange: markup,
  });
  assert.doesNotMatch(html, /<img\b/);
  assert.match(html, /无基准/);
});
