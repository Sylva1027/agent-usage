import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createUsageServer, isFullDetailHeapAvailable, readJsonBody } from "../src/server.js";

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function localHourKey(value) {
  // API tests derive the expected bucket with the same local-time semantics as the dashboard.
  const date = new Date(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:00`;
}

function quotaTokenRow(timestamp, { resetsAtMs, windowMinutes = 300, limitId = "codex", usedPercent = 42 } = {}) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } },
      rate_limits: {
        limit_id: limitId,
        primary: {
          window_minutes: windowMinutes,
          resets_at: resetsAtMs / 1000,
          used_percent: usedPercent,
        },
      },
    },
  };
}

async function makeFixtureHome() {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-server-"));
  const sessionDir = path.join(fakeHome, ".codex", "sessions", "2026", "05", "01");
  const sessionFile = path.join(sessionDir, "rollout.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    sessionFile,
    jsonl([
      {
        timestamp: "2026-05-01T02:00:00.000Z",
        type: "session_meta",
        payload: { id: "server-1", source: "cli", originator: "codex-tui", cwd: "/work/cli" },
      },
      {
        timestamp: "2026-05-01T02:01:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 123,
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 23,
              reasoning_output_tokens: 5,
            },
          },
        },
      },
    ]),
  );
  return {
    homeDir: fakeHome,
    // Keep server tests independent from the developer's real ~/.codex-usage/imports.json.
    importStoreFile: path.join(fakeHome, ".codex-usage", "imports.json"),
    databaseFile: path.join(fakeHome, ".codex-usage", "usage-index.sqlite"),
    sessionFile,
  };
}

test("server serves the dashboard and usage API", async () => {
  const { homeDir, importStoreFile, databaseFile } = await makeFixtureHome();
  const server = createUsageServer({ homeDir, importStoreFile, databaseFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const page = await fetch(`${baseUrl}/`);
    const api = await fetch(`${baseUrl}/api/usage`);
    const recent = await fetch(`${baseUrl}/api/usage?preset=recent&recentValue=${encodeURIComponent("14天")}`);
    const hourly = await fetch(`${baseUrl}/api/usage?bucket=hour`);
    const json = await api.json();
    const recentJson = await recent.json();
    const hourlyJson = await hourly.json();

    assert.equal(page.status, 200);
    assert.match(await page.text(), /Agent Usage/);
    assert.equal(api.status, 200);
    assert.equal(json.summary.totals.total, 123);
    assert.equal(json.quota.asOf, json.summary.quota.asOf);
    assert.equal(json.quota.windows.quota_5h.state, "missing");
    assert.equal(recent.status, 200);
    assert.equal(recentJson.summary.range.preset, "recent");
    assert.equal(recentJson.summary.totals.total, 0);
    assert.equal(hourly.status, 200);
    assert.equal(hourlyJson.summary.range.bucket, "hour");
    assert.equal(hourlyJson.summary.timeline.length, 24);
    const activeTimelineRows = hourlyJson.summary.timeline.filter((row) => row.total.total > 0);
    assert.deepEqual(
      activeTimelineRows.map((row) => [row.key, row.total.total]),
      [[localHourKey("2026-05-01T02:01:00.000Z"), 123]],
    );
    const activeTimelineRow = activeTimelineRows[0];
    assert.equal(
      activeTimelineRow.models.reduce((sum, model) => sum + model.total.total, 0),
      activeTimelineRow.total.total,
    );
    assert.equal(typeof activeTimelineRow.costByModel, "object");
    assert.equal(typeof activeTimelineRow.pricedTokens, "number");
    assert.equal(typeof activeTimelineRow.unpricedTokens, "number");
    const timelineCost = hourlyJson.summary.timeline.reduce(
      (sum, row) => sum + Object.values(row.costByModel).reduce((slot, cost) => slot + cost.totalUsd, 0),
      0,
    );
    assert.ok(Math.abs(timelineCost - hourlyJson.summary.costEstimate.totalUsd) < 1e-12);
    assert.equal(json.metadata.eventCount, 1);
    assert.equal(json.metadata.sessionCount, 1);
    assert.equal(json.metadata.homes[0].status, "active");
    assert.equal(json.metadata.homes[0].eventCount, 1);
    assert.equal(json.report, undefined);
    assert.ok((await stat(databaseFile)).size > 0);

    const invalidDate = await fetch(baseUrl + "/api/summary?preset=custom&startDate=2026-02-30");
    const invalidBucket = await fetch(baseUrl + "/api/summary?bucket=fortnight");
    const invalidPreset = await fetch(baseUrl + "/api/summary?preset=quarter");
    const unavailableQuota = await fetch(baseUrl + "/api/usage?preset=quota_5h");
    const malformedPath = await fetch(baseUrl + "/%E0%A4%A");
    assert.equal(invalidDate.status, 400);
    assert.equal(invalidBucket.status, 400);
    assert.equal(invalidPreset.status, 400);
    assert.equal((await invalidPreset.json()).code, "INVALID_PRESET");
    assert.equal(unavailableQuota.status, 409);
    const unavailableQuotaBody = await unavailableQuota.json();
    assert.equal(unavailableQuotaBody.code, "QUOTA_WINDOW_UNAVAILABLE");
    assert.equal(unavailableQuotaBody.quota.windows.quota_5h.state, "missing");
    assert.equal(unavailableQuotaBody.summary, undefined);
    assert.equal(malformedPath.status, 400);

    const detailed = await fetch(`${baseUrl}/api/usage?detail=full`).then((response) => response.json());
    assert.equal(detailed.report.events[0].channel, "CLI");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("server accepts named recent reset windows and calendar ranges", async () => {
  const fixture = await makeFixtureHome();
  const end = Date.now() - 60_000;
  const observed = new Date(end - 60_000).toISOString();
  await appendFile(fixture.sessionFile, jsonl([
    quotaTokenRow(observed, { resetsAtMs: end }),
    quotaTokenRow(observed, { resetsAtMs: end, windowMinutes: 10080 }),
  ]));
  const server = createUsageServer(fixture);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    for (const [value, bucket, slots] of [["上一个5h", "quota_30m", 10], ["上周", "quota_24h", 7], ["上个月", "day", null], ["今年", "month", null]]) {
      const query = new URLSearchParams({ preset: "recent", recentValue: value, bucket });
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/usage?${query}`);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.summary.range.bucket, bucket);
      if (slots) {
        assert.equal(body.summary.timeline.length, slots);
        assert.deepEqual(body.summary.records, {});
      }
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("server reports unsupported stored imports instead of hiding them", async () => {
  const { homeDir, importStoreFile } = await makeFixtureHome();
  const unsupportedPath = path.join(homeDir, "plain-project");
  await mkdir(unsupportedPath, { recursive: true });
  await mkdir(path.dirname(importStoreFile), { recursive: true });
  await writeFile(importStoreFile, JSON.stringify({ imports: [{ path: unsupportedPath }] }));

  const server = createUsageServer({ homeDir, importStoreFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const imports = await fetch(`http://127.0.0.1:${port}/api/imports`).then((response) => response.json());

    assert.equal(imports.imports[0].type, "unsupported");
    assert.equal(imports.imports[0].path, unsupportedPath);
    assert.match(imports.imports[0].reason, /目录需要是 Codex home/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("server keeps full detail reports behind the documented 512MB heap budget", () => {
  assert.equal(isFullDetailHeapAvailable(511 * 1024 * 1024), false);
  assert.equal(isFullDetailHeapAvailable(512 * 1024 * 1024), true);
});

test("server reports status changes and refreshes cached usage reports", async () => {
  const { homeDir, importStoreFile, sessionFile } = await makeFixtureHome();
  const server = createUsageServer({ homeDir, importStoreFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const firstUsage = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    const unchanged = await fetch(`${baseUrl}/api/status?since=${firstUsage.fingerprint}`).then((response) => response.json());

    assert.equal(firstUsage.summary.totals.total, 123);
    assert.match(firstUsage.fingerprint, /^[a-f0-9]{64}$/);
    assert.equal(unchanged.changed, false);

    await appendFile(
      sessionFile,
      JSON.stringify({
        timestamp: "2026-05-01T02:02:00.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              total_tokens: 200,
              input_tokens: 160,
              cached_input_tokens: 30,
              output_tokens: 40,
              reasoning_output_tokens: 7,
            },
          },
        },
      }) + "\n",
    );

    const changed = await fetch(`${baseUrl}/api/status?since=${firstUsage.fingerprint}`).then((response) => response.json());
    const refreshed = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());


    assert.equal(changed.changed, true);
    assert.notEqual(changed.fingerprint, firstUsage.fingerprint);
    assert.equal(refreshed.summary.totals.total, 200);


  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("paused usage keeps the same indexed data across range changes", async () => {
  const { homeDir, importStoreFile, databaseFile, sessionFile } = await makeFixtureHome();
  const server = createUsageServer({ homeDir, importStoreFile, databaseFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const paused = await fetch(`${baseUrl}/api/usage?preset=all&freeze=1`).then((response) => response.json());
    assert.equal(paused.summary.totals.total, 123);
    assert.ok(paused.snapshotId);

    await appendFile(sessionFile, JSON.stringify({
      timestamp: "2026-05-01T02:02:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: 200, input_tokens: 160, cached_input_tokens: 30,
            output_tokens: 40, reasoning_output_tokens: 7,
          },
        },
      },
    }) + "\n");

    const live = await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    assert.equal(live.summary.totals.total, 200);

    for (const preset of ["all", "week", "month", "custom"]) {
      const range = preset === "custom" ? "&startDate=2026-05-01&endDate=2026-05-01" : "";
      const frozen = await fetch(`${baseUrl}/api/usage?preset=${preset}&snapshot=${paused.snapshotId}${range}`)
        .then((response) => response.json());
      assert.equal(frozen.summary.totals.total, preset === "all" || preset === "custom" ? 123 : 0);
      assert.equal(frozen.checkedAt, paused.checkedAt);
      assert.equal(frozen.snapshotId, paused.snapshotId);
      assert.equal(frozen.periodComparison.asOf, paused.periodComparison.asOf);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("quota API forces its server bucket, returns capability state, and keeps snapshots frozen", async () => {
  const { homeDir, importStoreFile, databaseFile, sessionFile } = await makeFixtureHome();
  const quotaFile = path.join(path.dirname(sessionFile), "quota.jsonl");
  const liveUsageFile = path.join(path.dirname(sessionFile), "live-usage.jsonl");
  const estimateNow = Date.now();
  const observedAtMs = estimateNow - 30_000;
  const resetsAtMs = estimateNow + 300 * 60_000 - 60_000;
  const quotaRow = quotaTokenRow(new Date(observedAtMs).toISOString(), { resetsAtMs });
  quotaRow.payload.rate_limits.secondary = {
    window_minutes: 10080,
    resets_at: (estimateNow + (10080 - 60) * 60_000) / 1000,
    used_percent: 5,
  };
  await writeFile(quotaFile, jsonl([
    { type: "session_meta", timestamp: new Date(observedAtMs - 1_000).toISOString(), payload: { id: "quota-window" } },
    quotaRow,
  ]));
  const liveUsageAt = new Date(estimateNow - 10_000).toISOString();
  await writeFile(liveUsageFile, jsonl([
    { type: "session_meta", timestamp: liveUsageAt, payload: { id: "quota-usage", source: "cli", originator: "codex-tui", cwd: "/work/quota" } },
    {
      timestamp: liveUsageAt,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: { total_token_usage: { total_tokens: 50, input_tokens: 40, cached_input_tokens: 5, output_tokens: 10, reasoning_output_tokens: 0 } },
      },
    },
  ]));
  const server = createUsageServer({ homeDir, importStoreFile, databaseFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const liveResponse = await fetch(`${baseUrl}/api/usage?preset=quota_5h&bucket=month&detail=full`);
    const live = await liveResponse.json();
    assert.equal(liveResponse.status, 200);
    assert.equal(live.summary.range.bucket, "quota_30m");
    assert.equal(live.summary.range.quotaState, "available");
    assert.equal(live.summary.range.quotaReason, null);
    assert.equal(live.summary.range.asOf, live.quota.asOf);
    assert.equal(live.quota.windows.quota_5h.state, "available");
    assert.equal(live.summary.timeline.length, 10);
    assert.equal(live.summary.totals.total, 50);
    assert.equal(live.summary.comparison, null);
    assert.deepEqual(live.summary.records, {});
    assert.equal(live.report, undefined);

    const liveWeekResponse = await fetch(`${baseUrl}/api/usage?preset=quota_week&bucket=month&view=dashboard`);
    const liveWeek = await liveWeekResponse.json();
    assert.equal(liveWeekResponse.status, 200);
    assert.equal(liveWeek.summary.range.bucket, "quota_24h");
    assert.equal(liveWeek.summary.range.quotaState, "available");
    assert.equal(liveWeek.summary.range.quotaReason, null);
    assert.equal(liveWeek.summary.timeline.length, 7);
    assert.equal(liveWeek.summary.totals.total, 50);

    const paused = await fetch(`${baseUrl}/api/usage?preset=quota_5h&freeze=1`).then((response) => response.json());
    assert.ok(paused.snapshotId);
    const frozen = await fetch(`${baseUrl}/api/usage?preset=quota_5h&snapshot=${paused.snapshotId}&bucket=month`).then((response) => response.json());
    assert.equal(frozen.quota.asOf, paused.quota.asOf);
    assert.deepEqual(frozen.quota, paused.quota);
    assert.equal(frozen.summary.range.bucket, "quota_30m");
    assert.equal(frozen.summary.range.quotaState, "available");

    const excluded = await fetch(`${baseUrl}/api/summary?preset=quota_5h&exclude=${encodeURIComponent(live.metadata.homes[0].id)}`).then((response) => response.json());
    assert.equal(excluded.quota.windows.quota_5h.state, "available");
    assert.equal(excluded.summary.totals.total, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("server imports project usage log directories and refreshes usage data", async () => {
  const { homeDir, importStoreFile } = await makeFixtureHome();
  const projectRoot = path.join(homeDir, "openai_codex");
  await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".codex-usage", "usage.jsonl"),
    jsonl([
      {
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-05-31T12:00:00.000Z",
        source: "codex-oauth",
        channel: "Codex OAuth",
        project_root: projectRoot,
        cwd: projectRoot,
        session_id: "oauth-session",
        model: "gpt-5.5",
        usage: { total: 77, input: 50, cached: 10, output: 27, reasoning: 6 },
      },
    ]),
  );

  const server = createUsageServer({ homeDir, importStoreFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const before = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    const imported = await fetch(`${baseUrl}/api/imports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: projectRoot }),
    }).then((response) => response.json());
    const imports = await fetch(`${baseUrl}/api/imports`).then((response) => response.json());
    const after = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());

    assert.equal(before.summary.totals.total, 123);
    assert.equal(imported.import.type, "project-log");
    assert.equal(imported.import.path, projectRoot);
    assert.deepEqual(imports.imports.map((entry) => entry.path), [projectRoot]);
    assert.equal(after.summary.totals.total, 200);
    assert.deepEqual(
      after.summary.channels.map((channel) => [channel.name, channel.total.total]),
      [
        ["CLI", 123],
        ["Codex OAuth", 77],
      ],
    );
    assert.equal(after.metadata.homes.some((home) => home.kind === "project-log" && home.path === projectRoot), true);

    await fetch(`${baseUrl}/api/imports?path=${encodeURIComponent(projectRoot)}`, { method: "DELETE" });
    const removed = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());

    assert.equal(removed.summary.totals.total, 123);
    assert.equal(removed.metadata.homes.some((home) => home.kind === "project-log" && home.path === projectRoot), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("server returns a picked directory from the local directory picker", async () => {
  const { homeDir, importStoreFile } = await makeFixtureHome();
  const pickedPath = path.join(homeDir, "picked-project");
  const server = createUsageServer({
    homeDir,
    importStoreFile,
    // Tests inject the picker so they never open an OS dialog.
    pickDirectory: async () => pickedPath,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/pick-directory`, {
      method: "POST",
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, { path: pickedPath });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});


test("JSON request parsing preserves UTF-8 split across chunks and returns client errors", async () => {
  const payload = Buffer.from(JSON.stringify({ path: "项目" }), "utf8");
  const split = payload.indexOf(Buffer.from("项目", "utf8")) + 1;
  const request = {
    async *[Symbol.asyncIterator]() {
      yield payload.subarray(0, split);
      yield payload.subarray(split);
    },
  };

  assert.deepEqual(await readJsonBody(request), { path: "项目" });

  await assert.rejects(
    readJsonBody({
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("{invalid", "utf8");
      },
    }),
    (error) => error.statusCode === 400,
  );
  await assert.rejects(
    readJsonBody({
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(16_385, 32);
      },
    }),
    (error) => error.statusCode === 413,
  );
});

test("server starts directly when its script path contains spaces", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex server launch "));
  const homeDir = path.join(root, "fake home");
  const projectRoot = path.resolve(import.meta.dirname, "..");
  const scriptFile = path.join(projectRoot, "src", "server.js");
  const child = spawn(process.execPath, [scriptFile], {
    cwd: projectRoot,
    env: {
      ...process.env,
      USERPROFILE: homeDir,
      HOME: homeDir,
      APPDATA: path.join(homeDir, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(homeDir, "AppData", "Local"),
      CODEX_USAGE_HOMES: "",
      CODEX_USAGE_IMPORT_DIRS: "",
      HOST: "127.0.0.1",
      PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    const output = await new Promise((resolve, reject) => {
      let text = "";
      const timer = setTimeout(() => reject(new Error("Timed out waiting for server startup: " + text)), 5_000);
      child.stdout.on("data", (chunk) => {
        text += chunk.toString();
        if (text.includes("Agent Usage dashboard:")) {
          clearTimeout(timer);
          resolve(text);
        }
      });
      child.stderr.on("data", (chunk) => { text += chunk.toString(); });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        reject(new Error("Server exited before startup with code " + code + ": " + text));
      });
    });
    assert.match(output, /http:\/\/127\.0\.0\.1:\d+/);
  } finally {
    if (child.exitCode === null) child.kill();
    if (child.exitCode === null) {
      await new Promise((resolve) => child.once("close", resolve));
    }
    await rm(root, { recursive: true, force: true });
  }
});


test("pricing API validates, persists, and reprices indexed history", async () => {
  const fixture = await makeFixtureHome();
  const projectRoot = path.join(fixture.homeDir, "priced-project");
  await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
  await writeFile(path.join(projectRoot, ".codex-usage", "usage.jsonl"), jsonl([{
    schema_version: "codex-usage.project-log.v1",
    timestamp: "2026-05-31T12:00:00.000Z",
    session_id: "priced-session",
    request_id: "priced-request",
    model: "gpt-6-sol",
    cwd: projectRoot,
    usage: { total: 110, input: 100, cached: 20, cache_write_input_tokens: 0, output: 10 },
    service_tier: "standard",
  }]));
  const options = { ...fixture, importDirs: [projectRoot] };
  let server = createUsageServer(options);
  const listen = async () => {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const close = async () => new Promise((resolve) => server.close(resolve));
  try {
    let baseUrl = await listen();
    const original = await fetch(`${baseUrl}/api/pricing`).then((response) => response.json());
    const before = await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    assert.equal(original.models["gpt-6-sol"].short.input, 2);
    assert.ok(before.summary.costEstimate.totalUsd > 0);

    const invalid = structuredClone(original);
    invalid.models["gpt-6-sol"].short.input = -1;
    const rejected = await fetch(`${baseUrl}/api/pricing`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(invalid),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await fetch(`${baseUrl}/api/pricing`).then((response) => response.json())).models["gpt-6-sol"].short.input, 2);

    const updated = structuredClone(original);
    updated.checkedAt = "2026-09-24";
    updated.models["gpt-6-sol"].short.input = 4;
    const saved = await fetch(`${baseUrl}/api/pricing`, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(updated),
    });
    assert.equal(saved.status, 200);
    const savedCatalog = await saved.json();
    const after = await fetch(`${baseUrl}/api/usage?preset=all&skipCheck=1`).then((response) => response.json());
    assert.equal(savedCatalog.checkedAt, "2026-09-24");
    assert.equal(after.summary.costEstimate.priceCheckedAt, "2026-09-24");
    const changedStatus = await fetch(`${baseUrl}/api/status?since=${encodeURIComponent(before.fingerprint)}`).then((response) => response.json());
    assert.equal(changedStatus.changed, true);
    assert.equal(changedStatus.fingerprint, after.fingerprint);
    assert.ok(Math.abs(after.summary.costEstimate.totalUsd - before.summary.costEstimate.totalUsd - 0.00016) < 1e-12);
    assert.equal(after.summary.totals.total, before.summary.totals.total);
    assert.ok((await stat(path.join(fixture.homeDir, ".codex-usage", "pricing.json"))).size > 0);

    await close();
    server = createUsageServer(options);
    baseUrl = await listen();
    const restarted = await fetch(`${baseUrl}/api/usage?preset=all`).then((response) => response.json());
    assert.equal(restarted.summary.costEstimate.totalUsd, after.summary.costEstimate.totalUsd);
    assert.equal(restarted.summary.costEstimate.priceCheckedAt, "2026-09-24");
  } finally {
    if (server.listening) await close();
    await rm(fixture.homeDir, { recursive: true, force: true });
  }
});

test("usage API 按 exclude 参数过滤数据来源", async () => {
  const { homeDir, importStoreFile, databaseFile } = await makeFixtureHome();
  const server = createUsageServer({ homeDir, importStoreFile, databaseFile });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const base = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    assert.equal(base.summary.totals.total, 123);
    const homeId = base.metadata.homes[0].id;

    const filtered = await fetch(`${baseUrl}/api/usage?exclude=${encodeURIComponent(homeId)}`).then((response) => response.json());
    assert.equal(filtered.summary.totals.total, 0);
    assert.equal(filtered.summary.eventCount, 0);
    assert.equal(filtered.periodComparison.models.length, 0);
    // 过滤只影响统计口径，来源列表要保持完整。
    assert.equal(filtered.metadata.homes[0].eventCount, 1);

    const summary = await fetch(`${baseUrl}/api/summary?exclude=${encodeURIComponent(homeId)}`).then((response) => response.json());
    assert.equal(summary.summary.totals.total, 0);
    assert.equal(summary.periodComparison.models.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
