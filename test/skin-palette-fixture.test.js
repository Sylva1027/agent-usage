import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createUsageServer, describeImportEntry } from "../src/server.js";
import { classifyImportDirectory } from "../src/usage-core.js";
import { setSummaryFilters, summarize } from "../public/app.js";
import { hasSelectedCodexSource } from "../public/timeline-utils.js";
import {
  FIXTURE_DIRECTORY_PREFIX,
  FIXTURE_EVENT_COUNT,
  FIXTURE_LOG_SCHEMA,
  FIXTURE_LONG_NAME_EVENT_MIN_COUNT,
  FIXTURE_LONG_NAME_MIN_LENGTH,
  FIXTURE_MISSING_PRICE_MODEL,
  FIXTURE_TOTAL_TOKENS,
  FIXTURE_VERSION,
  createPaletteFixture,
  createPaletteServerOptions,
  createTimelineWarningFixture,
  getPaletteFixtureHash,
  getTimelineWarningFixtureHash,
  getTimelineWarningFixtureHashDescriptor,
} from "../test-support/skin-palette-fixture.mjs";
import { sha256Canonical } from "../scripts/skin-palette/contracts.mjs";
import { ROLES_VERSION } from "../scripts/skin-palette/roles.mjs";

const PREVIOUS_BASE_FIXTURE_HASH = "c447d75873564124964a2327f9133a5455a4dfd0c6033af430ad75d41b981445";
const BASE_FIXTURE_HASH = "53856bb4c64c7629f80728416ff8e41b073ce13915454c8bc00396836f24a005";
const TIMELINE_WARNING_MESSAGE = "Time range exceeds 2000 timeline slots.";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function assertEmptyCodexSessions(fixture) {
  const sessionsPath = path.join(fixture.homeDir, ".codex", "sessions");
  assert.equal((await stat(sessionsPath)).isDirectory(), true);
  assert.deepEqual(await readdir(sessionsPath), []);
}

async function readFixtureRows(fixture) {
  const imports = JSON.parse(await readFile(fixture.importStoreFile, "utf8"));
  assert.equal(imports.imports.length, 2);
  const projectRoot = imports.imports[0].path;
  const unavailablePath = imports.imports[1].path;
  assert.equal(path.resolve(projectRoot), path.resolve(path.join(path.dirname(fixture.homeDir), "palette-workspace")));
  assert.equal(path.resolve(unavailablePath), path.resolve(fixture.unavailablePath));
  assert.equal((await stat(unavailablePath)).isDirectory(), true);
  assert.deepEqual(await readdir(unavailablePath), [], "已保存的不可用来源目录必须为空");
  const rawBytes = await readFile(path.join(projectRoot, ".codex-usage", "usage.jsonl"));
  const rows = rawBytes
    .toString("utf8")
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  return { projectRoot, unavailablePath, rawBytes, rawSha256: sha256(rawBytes), rows };
}

async function assertSavedUnsupportedImport(fixture, { imports, homes = [], events = [] }) {
  const classified = await classifyImportDirectory(fixture.unavailablePath);
  const described = await describeImportEntry(fixture.unavailablePath);
  assert.deepEqual(described, classified, "API 描述必须沿用真实目录分类结果");
  assert.equal(described.type, "unsupported");
  assert.ok(described.reason.trim().length > 0);
  assert.deepEqual(
    imports.find((entry) => path.resolve(entry.path) === path.resolve(fixture.unavailablePath)),
    described,
    "真实 usage API metadata.imports 必须包含当前分类和 reason",
  );
  assert.equal(
    homes.some((home) => home.path && path.resolve(home.path) === path.resolve(fixture.unavailablePath)),
    false,
    "不支持的导入项不能混入可用 homes",
  );
  assert.equal(
    events.some((event) => JSON.stringify(event).includes(fixture.unavailablePath)),
    false,
    "不支持的导入项不能生成 usage 事件",
  );
}

function normalizeProjectLogRow(row, projectRoot) {
  const relativeCwd = path.relative(projectRoot, row.cwd).split(path.sep).join("/");
  assert.ok(relativeCwd && !relativeCwd.startsWith("../"));
  return {
    ...row,
    project_root: "$PROJECT_ROOT",
    cwd: `$PROJECT_ROOT/${relativeCwd}`,
  };
}

test("skin palette fixture ingests through the real import chain with non-zero totals", async () => {
  const fixture = await createPaletteFixture();
  const server = createUsageServer(createPaletteServerOptions(fixture));
  const baseUrl = await listen(server);
  try {
    await assertEmptyCodexSessions(fixture);
    const policy = JSON.parse(await readFile(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));
    assert.equal(FIXTURE_VERSION, 3);
    assert.equal(policy.versions.fixture, FIXTURE_VERSION);
    assert.equal(policy.versions.roles, ROLES_VERSION);
    assert.equal(getPaletteFixtureHash(), BASE_FIXTURE_HASH);
    assert.notEqual(getPaletteFixtureHash(), PREVIOUS_BASE_FIXTURE_HASH, "新增逻辑导入项必须使旧 v2 摘要失效");
    assert.equal(fixture.fixtureHash, BASE_FIXTURE_HASH);
    const body = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
    assert.equal(body.metadata.eventCount, FIXTURE_EVENT_COUNT);
    assert.equal(body.summary.totals.total, FIXTURE_TOTAL_TOKENS);
    const homes = body.metadata.homes;
    const mainHomes = homes.filter((home) => home.kind === "main");
    const projectHomes = homes.filter((home) => home.kind === "project-log");
    assert.deepEqual(homes.map((home) => home.kind).sort(), ["main", "project-log"]);
    assert.equal(mainHomes.length, 1);
    assert.equal(projectHomes.length, 1);
    assert.equal(hasSelectedCodexSource(homes, []), true);
    assert.equal(
      hasSelectedCodexSource(
        homes,
        mainHomes.map((home) => home.id),
      ),
      false,
    );
    assert.equal(hasSelectedCodexSource(projectHomes, []), false, "project-log is not mistaken for Codex");
    assert.ok(body.summary.costEstimate.totalUsd > 0, "本地默认价目表应给出非零费用");
    assert.ok(
      body.summary.costEstimate.minimumRateModels.includes(FIXTURE_MISSING_PRICE_MODEL),
      "缺价模型应进入最低价兜底说明（minimum-fallback-scenario）",
    );
    assert.ok(body.summary.models.length >= 3, "至少 3 个可识别模型");
    assert.equal(body.summary.channels.length, 2, "恰好 2 个项目渠道");

    const detailed = await fetch(`${baseUrl}/api/usage?detail=full`).then((response) => response.json());
    const events = detailed.report.events;
    await assertSavedUnsupportedImport(fixture, {
      imports: detailed.metadata.imports,
      homes: detailed.report.homes,
      events,
    });
    assert.equal(events.length, FIXTURE_EVENT_COUNT);
    assert.equal(
      events.reduce((sum, event) => sum + event.total.total, 0),
      FIXTURE_TOTAL_TOKENS,
    );
    const { projectRoot, rows } = await readFixtureRows(fixture);
    const independentlyRebuiltHash = sha256Canonical({
      fixtureVersion: FIXTURE_VERSION,
      logSchema: FIXTURE_LOG_SCHEMA,
      range: { start: "2026-09-26", end: "2026-10-03" },
      imports: [{ path: "$PROJECT_ROOT" }, { path: "$UNAVAILABLE_PROJECT_ROOT" }],
      sourceHomes: [
        {
          kind: "main",
          homePath: "$HOME/.codex",
          sessionsPath: "$HOME/.codex/sessions",
          sessionFiles: [],
          quotaSnapshots: [],
        },
      ],
      events: rows.map((row) => ({
        timestamp: row.timestamp,
        source: row.source,
        channel: row.channel,
        model: row.model,
        providerProfile: { provider: row.provider, auth: row.auth, api_surface: row.api_surface },
        cwdInProject: path.relative(projectRoot, row.cwd).split(path.sep).join("/"),
        sessionId: row.session_id,
        requestId: row.request_id ?? null,
        serviceTier: row.service_tier ?? null,
        usage: row.usage,
      })),
    });
    assert.equal(independentlyRebuiltHash, BASE_FIXTURE_HASH, "重建事件与逻辑来源摘要，不依赖实现函数输出");
    const longNameEvents = events.filter(
      (event) =>
        event.channel.length >= FIXTURE_LONG_NAME_MIN_LENGTH || event.model.length >= FIXTURE_LONG_NAME_MIN_LENGTH,
    );
    assert.ok(
      longNameEvents.length >= FIXTURE_LONG_NAME_EVENT_MIN_COUNT,
      `至少 ${FIXTURE_LONG_NAME_EVENT_MIN_COUNT} 条带可显示长名称，实际 ${longNameEvents.length}`,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fixture.close();
  }
});

test("two fixture instances stay isolated with identical logical content", async () => {
  const left = await createPaletteFixture();
  const right = await createPaletteFixture();
  await assertEmptyCodexSessions(left);
  await assertEmptyCodexSessions(right);
  assert.notEqual(left.homeDir, right.homeDir);
  assert.notEqual(left.unavailablePath, right.unavailablePath);
  assert.match(left.fixtureHash, /^[0-9a-f]{64}$/);
  assert.equal(left.fixtureHash, BASE_FIXTURE_HASH);
  assert.notEqual(left.fixtureHash, PREVIOUS_BASE_FIXTURE_HASH);
  assert.equal(left.fixtureHash, right.fixtureHash, "逻辑内容相同 → 摘要相同（不含临时路径）");

  const servers = [
    createUsageServer(createPaletteServerOptions(left)),
    createUsageServer(createPaletteServerOptions(right)),
  ];
  const baseUrls = [];
  for (const server of servers) {
    baseUrls.push(await listen(server));
  }
  try {
    const bodies = [];
    for (const [index, baseUrl] of baseUrls.entries()) {
      const body = await fetch(`${baseUrl}/api/usage`).then((response) => response.json());
      bodies.push(body);
      await assertSavedUnsupportedImport([left, right][index], {
        imports: body.metadata.imports,
        homes: body.metadata.homes,
      });
      assert.equal(body.metadata.eventCount, FIXTURE_EVENT_COUNT, `实例 ${index} 事件数不串数据`);
      assert.equal(body.summary.totals.total, FIXTURE_TOTAL_TOKENS, `实例 ${index} 总量不串数据`);
      const activeHomes = body.metadata.homes.filter((home) => home.status === "active");
      assert.equal(activeHomes.length, 1, `实例 ${index} 只有 fixture 项目一个活跃家`);
      assert.equal(activeHomes[0].eventCount, FIXTURE_EVENT_COUNT);
    }
    const leftRoot = path.dirname(left.homeDir);
    const rightRoot = path.dirname(right.homeDir);
    assert.ok(!JSON.stringify(bodies[0]).includes(rightRoot), "左侧响应不得出现右侧临时路径");
    assert.ok(!JSON.stringify(bodies[1]).includes(leftRoot), "右侧响应不得出现左侧临时路径");
  } finally {
    for (const server of servers) {
      await new Promise((resolve) => server.close(resolve));
    }
    await left.close();
    await right.close();
  }
});

test("timeline-warning fixture preserves the base rows and hashes the normalized full variant", async () => {
  const base = await createPaletteFixture();
  const left = await createTimelineWarningFixture();
  const right = await createTimelineWarningFixture();
  const roots = [base, left, right].map((fixture) => path.dirname(fixture.homeDir));
  try {
    await Promise.all([base, left, right].map(assertEmptyCodexSessions));
    assert.equal(getPaletteFixtureHash(), BASE_FIXTURE_HASH);
    assert.equal(base.fixtureHash, BASE_FIXTURE_HASH);
    assert.notEqual(left.homeDir, right.homeDir);
    assert.notEqual(roots[0], roots[1]);
    assert.notEqual(roots[1], roots[2]);
    assert.equal(left.fixtureHash, right.fixtureHash);
    assert.equal(left.fixtureHash, getTimelineWarningFixtureHash());
    assert.notEqual(left.fixtureHash, BASE_FIXTURE_HASH);

    const [baseInput, warningInput] = await Promise.all([readFixtureRows(base), readFixtureRows(left)]);
    const baseRows = baseInput.rows.map((row) => normalizeProjectLogRow(row, baseInput.projectRoot));
    const variantRows = warningInput.rows.map((row) => normalizeProjectLogRow(row, warningInput.projectRoot));
    const descriptor = getTimelineWarningFixtureHashDescriptor();
    assert.equal(baseRows.length, FIXTURE_EVENT_COUNT);
    assert.equal(warningInput.rows.length, FIXTURE_EVENT_COUNT + 1);
    assert.equal(variantRows.length, FIXTURE_EVENT_COUNT + 1);
    assert.equal(
      variantRows.reduce((sum, row) => sum + row.usage.total, 0),
      FIXTURE_TOTAL_TOKENS + 1,
    );
    assert.deepEqual(variantRows.slice(0, FIXTURE_EVENT_COUNT), baseRows, "all original rows and order are preserved");
    assert.deepEqual(
      variantRows,
      descriptor.usageLog,
      "the normalized physical JSONL equals the declared logical input",
    );
    assert.equal(descriptor.schema, "codex-usage.skin-palette.timeline-warning-fixture.v1");
    assert.deepEqual(descriptor.variant, { name: "timeline-range-warning", version: 1 });
    assert.equal(descriptor.baseFixtureHash, BASE_FIXTURE_HASH);
    assert.equal(descriptor.fixtureVersion, FIXTURE_VERSION);
    assert.equal(descriptor.logSchema, FIXTURE_LOG_SCHEMA);
    assert.deepEqual(descriptor.range, { start: "1860-01-01", end: "2026-10-03" });
    assert.deepEqual(descriptor.imports, [{ path: "$PROJECT_ROOT" }, { path: "$UNAVAILABLE_PROJECT_ROOT" }]);
    assert.equal(
      sha256Canonical({ ...descriptor, usageLog: variantRows }),
      left.fixtureHash,
      "rebuild the variant digest from every normalized row on disk",
    );
    assert.equal(getTimelineWarningFixtureHash(), left.fixtureHash);
    assert.equal(warningInput.rawSha256.length, 64);
    assert.deepEqual(variantRows.at(-1), {
      schema_version: FIXTURE_LOG_SCHEMA,
      timestamp: "1860-01-01T00:00:00.000Z",
      source: "palette-cli",
      channel: "Palette CLI",
      provider: "openai",
      auth: "api-key",
      api_surface: "openai-chat-completions",
      project_root: "$PROJECT_ROOT",
      cwd: "$PROJECT_ROOT/src/importer",
      session_id: "sess-d8s1-timeline-range-186001",
      request_id: "req-d8s1-timeline-range-186001",
      model: "glm-5.3",
      usage: { total: 1, input: 1, cached: 0, output: 0 },
    });
  } finally {
    await Promise.all([base.close(), left.close(), right.close()]);
  }
  for (const root of roots) await assert.rejects(() => stat(root), { code: "ENOENT" });
});

test("timeline-warning fixture reaches app.summarize through the real usage import API", async () => {
  const fixture = await createTimelineWarningFixture();
  const fixtureRoot = path.dirname(fixture.homeDir);
  const previousTimeZone = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  let server;
  let serverClosed = false;
  let fixtureDeleted = false;
  try {
    server = createUsageServer(createPaletteServerOptions(fixture));
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/api/usage?detail=full`, { headers: { connection: "close" } });
    assert.equal(response.status, 200);
    const detailed = await response.json();
    const events = detailed.report.events;
    await assertSavedUnsupportedImport(fixture, {
      imports: detailed.metadata.imports,
      homes: detailed.report.homes,
      events,
    });
    assert.equal(events.length, FIXTURE_EVENT_COUNT + 1);
    assert.equal(
      events.reduce((sum, event) => sum + event.total.total, 0),
      FIXTURE_TOTAL_TOKENS + 1,
    );

    const report = { events, homes: detailed.report.homes, pricing: {} };
    const fixedNow = new Date("2026-10-13T04:00:00.000Z");
    setSummaryFilters({
      preset: "all",
      bucket: "day",
      calendarZone: "local",
      now: fixedNow,
      startDate: "",
      endDate: "",
      excludedHomes: [],
    });
    const all = summarize(report);
    assert.equal(all.eventCount, FIXTURE_EVENT_COUNT + 1);
    assert.equal(all.totals.total, FIXTURE_TOTAL_TOKENS + 1);
    assert.equal(all.range.bucket, "month");
    assert.equal(all.timelineError, TIMELINE_WARNING_MESSAGE);
    assert.deepEqual(all.timeline, []);

    setSummaryFilters({
      preset: "today",
      bucket: "hour",
      calendarZone: "local",
      now: fixedNow,
      startDate: "",
      endDate: "",
      excludedHomes: [],
    });
    const today = summarize(report);
    assert.equal(today.timelineError, null, "switching to Today clears the summary warning");
  } finally {
    try {
      if (server) await close(server);
      serverClosed = !server?.listening;
    } finally {
      try {
        await fixture.close();
        fixtureDeleted = !(await pathExists(fixtureRoot));
      } finally {
        setSummaryFilters({
          preset: "today",
          recentValue: "1个月",
          bucket: "hour",
          calendarZone: "local",
          now: null,
          startDate: "",
          endDate: "",
          excludedHomes: [],
        });
        if (previousTimeZone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimeZone;
      }
    }
  }
  assert.equal(serverClosed, true, "the short-lived usage server is closed");
  assert.equal(fixtureDeleted, true, "the isolated fixture temp root is removed");
});

test("fixture close removes its temp directory and is repeatable", async () => {
  const fixture = await createPaletteFixture();
  const rootDir = path.dirname(fixture.homeDir);
  const tempRoot = path.resolve(tmpdir());
  assert.ok(
    rootDir.startsWith(path.join(tempRoot, FIXTURE_DIRECTORY_PREFIX)),
    `目录必须带前缀位于系统临时目录下：${rootDir}`,
  );
  await assertEmptyCodexSessions(fixture);
  assert.equal((await stat(fixture.unavailablePath)).isDirectory(), true);
  assert.deepEqual(await readdir(fixture.unavailablePath), []);
  await stat(fixture.importStoreFile);
  await stat(fixture.pickedPath);

  await fixture.close();
  await assert.rejects(() => stat(rootDir), { code: "ENOENT" });
  await fixture.close();
  await assert.rejects(() => stat(fixture.databaseFile), { code: "ENOENT" });
});
