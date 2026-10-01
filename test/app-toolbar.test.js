import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("toolbar embeds the fillable recent dropdown inside the range segments", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.ok(html.indexOf('data-preset="all"') < html.indexOf('data-preset="recent"'));
  assert.ok(html.indexOf('data-preset="all"') < html.indexOf('id="recentValue"'));
  assert.ok(html.indexOf('id="quotaPresetToggle"') < html.indexOf('data-preset="today"'));
  assert.match(
    html,
    /id="quotaPresetToggle"[\s\S]*data-quota-mode="quota_5h">5h<\/span>[\s\S]*data-quota-mode="quota_week">7d<\/span>/,
  );
  assert.match(html, /id="quotaPresetStatus"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /data-preset="today" class="active">今日<\/button>/);
  assert.match(html, /data-preset="week" data-i18n-en="Week">本周<\/button>/);
  assert.match(html, /data-preset="month" data-i18n-en="Month">本月<\/button>/);
  assert.match(html, /data-preset="all" data-i18n-en="All">全部<\/button>/);
  assert.doesNotMatch(html, /customRangeButton|data-preset="custom"/);
  assert.doesNotMatch(html, /recent-segment-label/);
  assert.doesNotMatch(html, /<button[^>]+data-preset="recent"[^>]*>最近<\/button>/);
  assert.doesNotMatch(html, /class="control-group recent-range"/);
  assert.doesNotMatch(html, /id="recentPresetSelect"/);
  assert.doesNotMatch(html, /<datalist/);
  assert.doesNotMatch(html, /list="recentRangeOptions"/);
  assert.match(html, /<input[^>]+id="recentValue"/);
  assert.match(html, /id="recentRangeMenu"/);
  assert.match(html, /id="recentMenuButton"/);
  assert.doesNotMatch(html, /<input[^>]+id="(?:start|end)Date"/);
  assert.match(html, /id="dateRangePicker"/);
  assert.match(html, /id="dateRangeButton"[^>]*aria-controls="dateRangePicker"/);
  assert.doesNotMatch(html, /id="(?:start|end)DatePicker"/);
  // 粒度选择已移除：时间粒度随范围预设自动推导。
  assert.doesNotMatch(html, /id="bucketSelect"/);
  assert.doesNotMatch(html, /粒度/);
  assert.match(css, /#presetButtons\s*>\s*button\[data-preset\][^{]*{[^}]*flex:\s*0 0 76px;/s);
  assert.match(css, /#presetButtons\s*>\s*\.quota-preset-toggle\s*{[^}]*flex:\s*0 0 76px;/s);
  assert.match(css, /\.quota-preset-mode\.is-selected\s*{[^}]*color:\s*var\(--blue\);/s);
  assert.match(css, /\.segmented\s+\.recent-segment\s*{[^}]*padding:\s*0 3px;/s);
  assert.match(css, /\.recent-combobox\s*{[^}]*border:\s*1px solid var\(--line\);/s);
  assert.match(css, /\.recent-combobox\s*{[^}]*height:\s*26px;/s);
  assert.match(css, /\.recent-combobox\s*{[^}]*position:\s*relative;/s);
  assert.match(css, /\.recent-segment-input\s*{[^}]*border:\s*0;/s);
  assert.match(css, /\.segmented\s+\.recent-menu-button\s*{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.segmented\s+\.recent-menu-button\s*{[^}]*border:\s*0;/s);
  assert.match(css, /\.segmented\s+\.recent-menu-button\s*{[^}]*background:\s*transparent;/s);
  assert.match(css, /\.segmented\s+\.recent-menu-button:hover\s*{[^}]*background:\s*transparent;/s);
  assert.match(css, /\.recent-range-menu\s*{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.recent-range-menu\s+button\[aria-selected="true"\]\s*{/);
  assert.match(css, /\.date-picker-popover\s*{[^}]*position:\s*absolute;/s);
  assert.match(css, /\.date-picker-grid\s*{[^}]*grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\);/s);
  assert.match(css, /\.date-picker-day\.outside-month\s*{[^}]*color:\s*var\(--muted\);/s);

  for (const value of ["上一个5h", "上周", "上个月", "今年"]) {
    assert.match(html, new RegExp(`data-recent-option="${value}"`));
  }
  assert.match(html, /data-recent-option="上个月"[^>]+aria-selected="true"/);
});

test("title, range, refresh, and timezone controls use separate compact groups", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const header = html.match(/<header class="topbar">([\s\S]*?)<\/header>/)?.[1];
  const toolbar = html.match(/<section class="toolbar"[\s\S]*?<\/section>/)?.[0];
  assert.ok(header);
  assert.ok(toolbar);
  assert.match(header, /<h1>Agent Usage<\/h1>/);
  assert.match(header, /class="topbar-actions"/);
  assert.doesNotMatch(header, /autoRefresh|lastSuccessfulCheck|calendarZoneSelect/);

  const rangeIndex = toolbar.indexOf('class="control-group range-controls"');
  const dateIndex = toolbar.indexOf('class="control-group date-range-controls"');
  const refreshIndex = toolbar.indexOf('id="autoRefreshStatus" class="control-group auto-refresh-status"');
  assert.ok(rangeIndex >= 0 && dateIndex > rangeIndex && refreshIndex > dateIndex);
  const refresh = toolbar.slice(refreshIndex);
  assert.ok(refresh.indexOf('id="calendarZoneSelect"') < refresh.indexOf('id="lastSuccessfulCheck"'));
  assert.match(refresh, /id="calendarZoneSelect"[^>]*role="combobox"[^>]*aria-controls="calendarZoneMenu"/);
  assert.match(refresh, /class="auto-refresh-well"/);
  assert.match(refresh, /auto-refresh-heading[\s\S]*?id="autoRefreshToggle"[\s\S]*?<\/span>/);
  assert.doesNotMatch(header, /importButton/);
});
