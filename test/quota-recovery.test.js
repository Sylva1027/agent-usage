import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";
import { buildUsageIndex, buildUsageReport, summarizeUsage, summarizeUsageIndex } from "../src/usage-core.js";
import { setSummaryFilters, summarize } from "../public/app.js";
import { pricedReport } from "../test-support/report-projection.js";

test("missing native boundaries recover once and persist identically in SQL, reports and frozen snapshots", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "quota-recovery-"));
  const now = Math.floor(Date.now() / 1000) * 1000;
  const reset = now / 1000 + 5 * 86400;
  const options = {
    homeDir,
    env: {},
    databaseFile: path.join(homeDir, "usage.sqlite"),
    importStoreFile: path.join(homeDir, "imports.json"),
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
  };
  const sessions = path.join(homeDir, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  for (const [id, model, tokens] of [
    ["native", "gpt-6.1-sol", 100],
    ["external", "deepseek-flash", 500],
  ]) {
    await writeFile(
      path.join(sessions, `${id}.jsonl`),
      `${[
        { type: "session_meta", payload: { id, cwd: homeDir, model_provider: "openai", model } },
        { type: "turn_context", payload: { model } },
        {
          type: "event_msg",
          timestamp: new Date(now - 1000).toISOString(),
          payload: {
            type: "token_count",
            info: { total_token_usage: { total_tokens: tokens, input_tokens: tokens, output_tokens: 0 } },
            rate_limits: { limit_id: "codex", primary: null, secondary: null },
          },
        },
      ]
        .map(JSON.stringify)
        .join("\n")}\n`,
    );
  }
  let reads = 0;
  const readOfficialCodexQuota = async () => {
    reads++;
    return {
      accountFingerprint: "a".repeat(64),
      planType: "prolite",
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          planType: "prolite",
          primary: { usedPercent: 29, windowDurationMins: 10080, resetsAt: reset },
          secondary: null,
        },
      },
    };
  };
  let server = createUsageServer({ ...options, readOfficialCodexQuota });
  const start = async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  let base = await start();
  const get = async (query) => {
    const response = await fetch(`${base}/api/summary?calendarZone=utc&${query}`);
    return { status: response.status, body: await response.json() };
  };
  try {
    assert.equal((await get("preset=quota_week")).status, 409);
    assert.equal(reads, 0, "default remains offline");
    await server.close();
    server = createUsageServer({ ...options, officialQuotaRecoveryEnabled: true, readOfficialCodexQuota });
    base = await start();
    const recovered = await get("preset=quota_week&freeze=1");
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(reads, 1);
    assert.equal(recovered.body.summary.totals.total, 100);
    assert.equal(recovered.body.quota.windows.quota_week.windowEndExclusive, new Date(reset * 1000).toISOString());
    assert.equal((await get("preset=quota_week")).status, 200);
    assert.equal((await get("preset=quota_week")).status, 200);
    const short = Object.keys(recovered.body.quota.windows).find((key) => key !== "quota_week");
    assert.equal((await get(`preset=${short}`)).status, 409);
    assert.equal(reads, 1, "absent 5h must not query again during a known 7d window");
    assert.equal((await get(`preset=quota_week&snapshot=${recovered.body.snapshotId}`)).status, 200);
    await server.close();

    const filters = { preset: "quota_week", now: new Date(), calendarZone: "utc", bucket: "quota_24h" };
    const report = await buildUsageReport(options);
    const index = await buildUsageIndex(options);
    setSummaryFilters(filters);
    const store = new UsageStore(options);
    await store.open();
    try {
      const summaries = [
        store.summarize(filters),
        summarizeUsage(report, filters),
        summarizeUsageIndex(index, filters),
        summarize(pricedReport(report, filters.now.toISOString())),
      ];
      for (const summary of summaries) {
        assert.equal(summary.totals.total, 100);
        assert.equal(new Date(summary.range.windowEndExclusive).getTime(), reset * 1000);
      }
      const cached = JSON.parse(await readFile(path.join(homeDir, ".codex-usage", "codex-quota.json"), "utf8"));
      assert.equal(cached.snapshots.length, 1);
      await rm(path.join(homeDir, ".codex-usage", "codex-quota.json"));
      assert.equal(
        store.summarize(filters).totals.total,
        100,
        "persisted SQL metadata is independent of live cache files",
      );
    } finally {
      store.close();
    }
    server = createUsageServer({ ...options, readOfficialCodexQuota });
    base = await start();
    assert.equal((await get("preset=quota_week")).status, 200);
    assert.equal(reads, 1, "restart uses stored boundary without another account read");
  } finally {
    await server.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
