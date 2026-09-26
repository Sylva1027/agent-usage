import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function sourceBetween(source, startFunction, endFunction) {
  const startIndex = source.indexOf(`function ${startFunction}`);
  const endIndex = source.indexOf(`function ${endFunction}`, startIndex);
  assert.notEqual(startIndex, -1);
  assert.notEqual(endIndex, -1);
  return source.slice(startIndex, endIndex);
}

test("auto refresh preference gates polling, preserves manual refresh, and disables static snapshots", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const check = sourceBetween(source, "checkForUpdates", "startAutoRefresh");
  const start = sourceBetween(source, "startAutoRefresh", "stopAutoRefresh");
  const stop = sourceBetween(source, "stopAutoRefresh", "refreshViewForFilters");
  const toggle = sourceBetween(source, "setAutoRefreshEnabled", "initializeAutoRefresh");
  const initialize = sourceBetween(source, "initializeAutoRefresh", "setImportControlsDisabled");
  const visibilityStart = source.indexOf('document.addEventListener("visibilitychange"');
  const visibilityEnd = source.indexOf("setTheme(preferredTheme()", visibilityStart);
  const visibility = source.slice(visibilityStart, visibilityEnd);

  assert.match(source, /AUTO_REFRESH_STORAGE_KEY/);
  assert.match(source, /localStorage\.setItem\(AUTO_REFRESH_STORAGE_KEY/);
  assert.match(check, /isStaticSnapshot\(\).*state\.autoRefreshEnabled/s);
  assert.match(check, /state\.autoRefreshCheckInFlight/);
  assert.match(check, /runId !== state\.autoRefreshRunId/);
  assert.match(check, /await loadUsage\(\)/);
  assert.match(check, /status\.changed \|\| isQuotaPreset\(state\.preset\)/);
  assert.match(start, /state\.autoRefreshTimer/);
  assert.match(stop, /window\.clearInterval/);
  assert.match(toggle, /stopAutoRefresh\(\)/);
  assert.match(toggle, /if \(checkNow\) void loadUsage\(\)/);
  assert.match(toggle, /loadUsage\(\{ skipCheck: true, freeze: true \}\)/);
  assert.match(initialize, /isStaticSnapshot\(\) \? false/);
  assert.match(visibility, /!document\.hidden && state\.autoRefreshEnabled/);
  assert.match(source, /params\.set\("snapshot", state\.snapshotId\)/);
  assert.match(source, /params\.set\("freeze", "1"\)/);
  assert.match(source, /if \(error\.body\?\.quota\) state\.quotaSnapshot = error\.body\.quota/);
  assert.match(source, /renderUnavailableQuota\(reason\)/);
  assert.match(source, /state\.summary = null/);
  assert.doesNotMatch(source, /force: true/);
});
