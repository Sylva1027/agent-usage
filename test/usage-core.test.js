import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildUsageIndex,
  buildUsageReport,
  buildUsageFingerprint,
  classifyImportDirectory,
  discoverCodexHomes,
  discoverUsageSources,
  parseSessionFile,
  selectQuotaWindows,
  streamUsageFileEvents,
  summarizePeriodComparison,
  summarizeUsage,
  summarizeUsageIndex,
  usageIndexMetadata,
} from "../src/usage-core.js";

function jsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

function tokenRow(timestamp, total, input = total - 10, cached = 0, output = 10) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          total_tokens: total,
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 2,
        },
        last_token_usage: {
          total_tokens: total,
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: 2,
        },
      },
    },
  };
}

function usageEvent(timestamp, total) {
  return {
    timestamp,
    sessionId: `session-${total}`,
    channel: "CLI",
    homeId: "main-codex",
    homeLabel: "Main Codex",
    cwd: "/work/project",
    model: "gpt-5.5",
    total: { total, input: total, cached: 0, output: 0, reasoning: 0 },
  };
}

function indexedUsageEvent(timestamp, total) {
  return {
    t: new Date(timestamp).getTime(),
    s: total,
    h: 0,
    c: 1,
    l: 2,
    m: 3,
    p: 4,
    total,
    input: total,
    cached: 0,
    output: 0,
    reasoning: 0,
  };
}

function usageIndex(events) {
  return {
    generatedAt: "2026-06-03T00:00:00.000Z",
    homes: [],
    warnings: [],
    strings: ["main-codex", "CLI", "Main Codex", "gpt-5.5", "/work/project"],
    events: events.map((event) => indexedUsageEvent(event.timestamp, event.total.total)),
    sessionCount: events.length,
  };
}

test("streamUsageFileEvents 逐条输出标准化会话事件", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-usage-stream-"));
  const file = path.join(root, "rollout.jsonl");
  await writeFile(
    file,
    jsonl([
      {
        timestamp: "2026-07-12T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "stream-session", source: "cli", originator: "codex-tui", cwd: "/work/stream" },
      },
      tokenRow("2026-07-12T01:01:00.000Z", 100, 80, 20, 20),
      tokenRow("2026-07-12T01:02:00.000Z", 160, 120, 30, 40),
    ]),
  );
  const source = { id: "main", label: "Main Codex", path: root, kind: "main" };
  const events = [];

  await streamUsageFileEvents(file, source, (event) => events.push(event));

  assert.deepEqual(
    events.map((event) => ({
      timestampMs: event.timestampMs,
      sessionId: event.sessionId,
      homeId: event.homeId,
      channel: event.channel,
      project: event.project,
      total: event.usage.total,
    })),
    [
      {
        timestampMs: Date.parse("2026-07-12T01:01:00.000Z"),
        sessionId: "stream-session",
        homeId: "main",
        channel: "CLI",
        project: "/work/stream",
        total: 100,
      },
      {
        timestampMs: Date.parse("2026-07-12T01:02:00.000Z"),
        sessionId: "stream-session",
        homeId: "main",
        channel: "CLI",
        project: "/work/stream",
        total: 60,
      },
    ],
  );
});

test("period comparison groups non-Git usage by working directory", async () => {
  const homePath = await mkdtemp(path.join(tmpdir(), "codex-usage-thread-names-"));
  const sessionsPath = path.join(homePath, "sessions");
  await mkdir(sessionsPath, { recursive: true });
  await writeFile(
    path.join(homePath, "session_index.jsonl"),
    jsonl([{ id: "conversation-1", thread_name: "更新个人主页" }]),
  );
  await writeFile(
    path.join(sessionsPath, "rollout-conversation-1.jsonl"),
    jsonl([
      {
        timestamp: "2026-07-12T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "conversation-1", source: "cli", originator: "codex-tui", cwd: "/work/notes" },
      },
      tokenRow("2026-07-12T01:01:00.000Z", 100, 80, 10, 20),
    ]),
  );

  const home = { id: "main", label: "Main Codex", path: homePath, kind: "main" };
  const report = await buildUsageReport({ homes: [home] });
  const comparison = summarizePeriodComparison(report.events, { now: "2026-07-12T12:00:00.000Z" });

  assert.equal(report.events[0].conversationName, "更新个人主页");
  assert.equal(comparison.repositories[0].name, "/work/notes");
  assert.equal(comparison.repositories[0].key, "directory:/work/notes");
  assert.equal(comparison.repositories.length, 1);
});

test("summarizeUsageIndex 支持大规模索引的全部日期范围", () => {
  const eventCount = 170_000;
  const start = new Date(2026, 0, 2, 8).getTime();
  const end = new Date(2026, 6, 11, 18).getTime();
  const events = Array.from({ length: eventCount }, (_, index) => ({
    ...indexedUsageEvent(index === eventCount - 1 ? end : start, 1),
    s: index,
  }));
  const index = {
    generatedAt: "2026-07-12T00:00:00.000Z",
    homes: [],
    warnings: [],
    strings: ["main-codex", "CLI", "Main Codex", "gpt-5.5", "/work/project"],
    events,
    sessionCount: eventCount,
  };

  const summary = summarizeUsageIndex(index, { preset: "all", bucket: "day" });
  const rangeStart = new Date(summary.range.start);
  const rangeEnd = new Date(summary.range.end);

  assert.equal(summary.eventCount, eventCount);
  assert.deepEqual(
    [rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate(), rangeStart.getHours()],
    [2026, 0, 2, 0],
  );
  assert.deepEqual(
    [rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate(), rangeEnd.getHours(), rangeEnd.getMinutes()],
    [2026, 6, 11, 23, 59],
  );
});

test("parseSessionFile derives incremental token events from cumulative totals", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-usage-"));
  const file = path.join(root, "rollout.jsonl");
  await writeFile(
    file,
    jsonl([
      {
        timestamp: "2026-05-01T01:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "session-1",
          source: "vscode",
          originator: "JetBrains.PyCharm",
          cwd: "/work/project",
          cli_version: "1.0.0",
        },
      },
      { type: "turn_context", payload: { model: "gpt-5.5" } },
      tokenRow("2026-05-01T01:01:00.000Z", 100, 80, 40, 20),
      tokenRow("2026-05-01T01:02:00.000Z", 160, 120, 70, 40),
    ]),
  );

  const parsed = await parseSessionFile(file, {
    homeId: "jetbrains-pycharm",
    homeLabel: "JetBrains PyCharm",
    homePath: root,
  });

  assert.equal(parsed.session.total.total, 160);
  assert.equal(parsed.events.length, 2);
  assert.deepEqual(
    parsed.events.map((event) => event.total.total),
    [100, 60],
  );
  assert.equal(parsed.session.channel, "JetBrains PyCharm");
});

test("source IDs stay attached to paths when the import list changes", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-stable-sources-"));
  const extraA = path.join(homeDir, "import-a");
  const extraB = path.join(homeDir, "import-b");
  await mkdir(path.join(homeDir, ".codex", "sessions"), { recursive: true });
  await mkdir(path.join(extraA, "sessions"), { recursive: true });
  await mkdir(path.join(extraB, "sessions"), { recursive: true });
  const env = { CODEX_USAGE_HOMES: "", CODEX_USAGE_IMPORT_DIRS: "" };

  const before = await discoverUsageSources({ homeDir, importDirs: [extraB], env });
  const after = await discoverUsageSources({ homeDir, importDirs: [extraA, extraB], env });
  const beforeB = before.find((source) => source.path === extraB);
  const afterB = after.find((source) => source.path === extraB);

  assert.ok(beforeB);
  assert.ok(afterB);
  assert.equal(beforeB.id, afterB.id);
  assert.equal(before.find((source) => source.path === path.join(homeDir, ".codex")).id,
    after.find((source) => source.path === path.join(homeDir, ".codex")).id);
});

test("full and streaming parsers both skip token events without valid timestamps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-invalid-time-"));
  const file = path.join(root, "rollout.jsonl");
  await writeFile(
    file,
    jsonl([
      {
        timestamp: "2026-05-01T01:00:00.000Z",
        type: "session_meta",
        payload: { id: "invalid-time-session", source: "cli", cwd: "/work/project" },
      },
      tokenRow("not-a-timestamp", 100, 80, 10, 20),
      tokenRow("2026-05-01T01:02:00.000Z", 150, 120, 20, 30),
    ]),
  );
  const source = { id: "home", label: "Test", path: root };
  const parsed = await parseSessionFile(file, source);
  const streamed = [];
  await streamUsageFileEvents(file, source, (event) => streamed.push(event));

  assert.equal(parsed.events.length, 1);
  assert.equal(streamed.length, 1);
  assert.equal(parsed.events[0].total.total, streamed[0].usage.total);
  assert.equal(parsed.events[0].total.total, 50);
});

test("discoverCodexHomes finds main Codex and JetBrains homes", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-home-"));
  await mkdir(path.join(fakeHome, ".codex", "sessions"), { recursive: true });
  await mkdir(path.join(fakeHome, "Library", "Caches", "JetBrains", "PyCharm2026.1", "aia", "codex", "sessions"), {
    recursive: true,
  });

  const homes = await discoverCodexHomes({ homeDir: fakeHome });

  assert.deepEqual(
    homes.map((home) => home.label),
    ["Main Codex", "JetBrains PyCharm2026.1"],
  );
});

test("discoverCodexHomes finds Windows JetBrains homes from app data directories", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-win-home-"));
  const localAppData = path.join(fakeHome, "AppData", "Local");
  const roamingAppData = path.join(fakeHome, "AppData", "Roaming");
  await mkdir(path.join(fakeHome, ".codex", "sessions"), { recursive: true });
  await mkdir(path.join(localAppData, "JetBrains", "PyCharm2026.1", "aia", "codex", "sessions"), {
    recursive: true,
  });
  await mkdir(path.join(roamingAppData, "JetBrains", "IntelliJIdea2026.1", "aia", "codex", "sessions"), {
    recursive: true,
  });

  const homes = await discoverCodexHomes({
    homeDir: fakeHome,
    platform: "win32",
    env: {
      LOCALAPPDATA: localAppData,
      APPDATA: roamingAppData,
    },
  });

  assert.deepEqual(
    homes.map((home) => home.label),
    ["Main Codex", "JetBrains PyCharm2026.1", "JetBrains IntelliJIdea2026.1"],
  );
});

test("discoverCodexHomes ignores missing extra homes", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-missing-"));
  await mkdir(path.join(fakeHome, ".codex", "sessions"), { recursive: true });

  const homes = await discoverCodexHomes({
    homeDir: fakeHome,
    extraHomes: path.join(fakeHome, "does-not-exist"),
  });

  assert.deepEqual(
    homes.map((home) => home.label),
    ["Main Codex"],
  );
});

test("classifyImportDirectory detects project usage logs and Codex homes", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-import-kind-"));
  const projectRoot = path.join(fakeHome, "oauth-project");
  const codexHome = path.join(fakeHome, "extra-codex");
  await mkdir(path.join(projectRoot, ".codex-usage"), { recursive: true });
  await writeFile(path.join(projectRoot, ".codex-usage", "usage.jsonl"), "");
  await mkdir(path.join(codexHome, "sessions"), { recursive: true });

  const project = await classifyImportDirectory(projectRoot);
  const home = await classifyImportDirectory(codexHome);

  assert.equal(project.type, "project-log");
  assert.equal(project.path, projectRoot);
  assert.equal(project.usageLogPath, path.join(projectRoot, ".codex-usage", "usage.jsonl"));
  assert.equal(home.type, "codex-home");
  assert.equal(home.path, codexHome);
});

test("summarizeUsage filters recent natural-day month ranges", () => {
  const events = [
    usageEvent("2026-05-02T12:00:00", 100),
    usageEvent("2026-05-03T00:00:00", 200),
    usageEvent("2026-06-03T23:59:59", 400),
    usageEvent("2026-06-04T00:00:00", 500),
    usageEvent("2026-06-03T12:00:00", 300),
  ];
  const report = { generatedAt: "2026-06-03T00:00:00.000Z", events };
  const filters = {
    preset: "recent",
    recentValue: "1个月",
    bucket: "day",
    now: "2026-06-03T12:00:00",
  };

  const summary = summarizeUsage(report, filters);
  const indexedSummary = summarizeUsageIndex(usageIndex(events), filters);

  assert.equal(summary.totals.total, 900);
  assert.equal(indexedSummary.totals.total, 900);
});

test("summarizeUsage uses rolling recent day ranges", () => {
  const events = [
    usageEvent("2026-06-22T10:44:59", 10),
    usageEvent("2026-06-22T10:45:00", 20),
    usageEvent("2026-06-23T10:45:00", 30),
    usageEvent("2026-06-23T10:45:01", 40),
  ];
  const filters = {
    preset: "recent",
    recentValue: "1天",
    bucket: "hour",
    now: "2026-06-23T10:45:00",
  };

  const summary = summarizeUsage({ generatedAt: "", events }, filters);
  const indexedSummary = summarizeUsageIndex(usageIndex(events), filters);

  assert.equal(summary.totals.total, 50);
  assert.equal(indexedSummary.totals.total, 50);
  assert.equal(summary.timeline[0].key, "2026-06-22 10:00");
  assert.equal(summary.timeline.at(-1).key, "2026-06-23 10:00");
  assert.equal(summary.timeline.length, 25);
  assert.deepEqual(indexedSummary.timeline, summary.timeline);
});

test("summarizeUsage includes previous-period comparison totals", () => {
  const events = [
    usageEvent("2026-06-02T09:00:00", 100),
    usageEvent("2026-06-03T09:00:00", 300),
  ];
  const filters = {
    preset: "today",
    bucket: "day",
    now: "2026-06-03T12:00:00",
  };

  const summary = summarizeUsage({ generatedAt: "", events }, filters);
  const indexedSummary = summarizeUsageIndex(usageIndex(events), filters);

  assert.equal(summary.comparison.previousTotals.total, 100);
  assert.equal(summary.comparison.totalDelta, 200);
  assert.equal(summary.comparison.percentChange, 200);
  assert.equal(summary.comparison.averageBaselineTotal, 50);
  assert.equal(summary.comparison.averageDelta, 250);
  assert.equal(summary.comparison.averagePercentChange, 500);
  assert.equal(indexedSummary.comparison.previousTotals.total, 100);
  assert.equal(indexedSummary.comparison.totalDelta, 200);
  assert.equal(indexedSummary.comparison.percentChange, 200);
  assert.equal(indexedSummary.comparison.averageBaselineTotal, 50);
  assert.equal(indexedSummary.comparison.averageDelta, 250);
  assert.equal(indexedSummary.comparison.averagePercentChange, 500);
});

test("summarizeUsage compares week preset with the full previous natural week", () => {
  const events = [
    usageEvent("2026-06-15T09:00:00", 500),
    usageEvent("2026-06-21T09:00:00", 200),
    usageEvent("2026-06-22T09:00:00", 300),
  ];
  const filters = {
    preset: "week",
    bucket: "day",
    now: "2026-06-22T12:00:00",
  };

  const summary = summarizeUsage({ generatedAt: "", events }, filters);
  const indexedSummary = summarizeUsageIndex(usageIndex(events), filters);

  assert.equal(summary.totals.total, 300);
  assert.equal(summary.comparison.previousTotals.total, 700);
  assert.equal(summary.comparison.totalDelta, -400);
  assert.equal(summary.comparison.percentChange, -57.14);
  assert.equal(summary.comparison.averageBaselineTotal, 50);
  assert.equal(summary.comparison.averageDelta, 250);
  assert.equal(summary.comparison.averagePercentChange, 500);
  assert.equal(indexedSummary.comparison.previousTotals.total, 700);
  assert.equal(indexedSummary.comparison.averageBaselineTotal, 50);
  assert.equal(indexedSummary.comparison.averageDelta, 250);
});

test("summarizeUsage filters recent natural-day half-year and manual day ranges", () => {
  const halfYearEvents = [
    usageEvent("2025-12-02T12:00:00", 100),
    usageEvent("2025-12-03T00:00:00", 200),
    usageEvent("2026-06-03T12:00:00", 300),
  ];
  const manualDayEvents = [
    usageEvent("2026-05-20T23:59:59", 10),
    usageEvent("2026-05-21T00:00:00", 20),
    usageEvent("2026-06-03T23:59:59", 30),
    usageEvent("2026-06-04T00:00:00", 40),
  ];

  const halfYearFilters = {
    preset: "recent",
    recentValue: "半年",
    bucket: "day",
    now: "2026-06-03T12:00:00",
  };
  const manualDayFilters = {
    preset: "recent",
    recentValue: "14天",
    bucket: "day",
    now: "2026-06-03T12:00:00",
  };

  assert.equal(summarizeUsage({ generatedAt: "", events: halfYearEvents }, halfYearFilters).totals.total, 500);
  assert.equal(summarizeUsageIndex(usageIndex(halfYearEvents), halfYearFilters).totals.total, 500);
  assert.equal(summarizeUsage({ generatedAt: "", events: manualDayEvents }, manualDayFilters).totals.total, 50);
  assert.equal(summarizeUsageIndex(usageIndex(manualDayEvents), manualDayFilters).totals.total, 50);
});

test("summarizeUsage uses natural-day recent day, week, and month ranges", () => {
  const twoDayEvents = [
    usageEvent("2026-06-21T23:59:59", 5),
    usageEvent("2026-06-22T00:00:00", 10),
    usageEvent("2026-06-23T23:59:59", 20),
    usageEvent("2026-06-24T00:00:00", 30),
  ];
  const weekEvents = [
    usageEvent("2026-06-16T23:59:59", 10),
    usageEvent("2026-06-17T00:00:00", 20),
    usageEvent("2026-06-23T10:45:00", 30),
    usageEvent("2026-06-24T00:00:00", 40),
  ];
  const monthEvents = [
    usageEvent("2026-05-22T23:59:59", 100),
    usageEvent("2026-05-23T00:00:00", 200),
    usageEvent("2026-06-23T10:45:00", 300),
    usageEvent("2026-06-24T00:00:00", 400),
  ];
  const twoDayFilters = {
    preset: "recent",
    recentValue: "2天",
    bucket: "hour",
    now: "2026-06-23T10:45:00",
  };
  const twoDaySummary = summarizeUsage({ generatedAt: "", events: twoDayEvents }, twoDayFilters);
  const indexedTwoDaySummary = summarizeUsageIndex(usageIndex(twoDayEvents), twoDayFilters);
  assert.equal(twoDaySummary.totals.total, 30);
  assert.equal(indexedTwoDaySummary.totals.total, 30);
  assert.equal(twoDaySummary.timeline[0].key, "2026-06-22 00:00");
  assert.equal(twoDaySummary.timeline.at(-1).key, "2026-06-23 23:00");
  assert.equal(twoDaySummary.timeline.length, 48);
  assert.deepEqual(indexedTwoDaySummary.timeline, twoDaySummary.timeline);

  const weekFilters = {
    preset: "recent",
    recentValue: "1周",
    bucket: "day",
    now: "2026-06-23T10:45:00",
  };
  const monthFilters = {
    preset: "recent",
    recentValue: "1个月",
    bucket: "day",
    now: "2026-06-23T10:45:00",
  };

  assert.equal(summarizeUsage({ generatedAt: "", events: weekEvents }, weekFilters).totals.total, 50);
  assert.equal(summarizeUsageIndex(usageIndex(weekEvents), weekFilters).totals.total, 50);
  assert.equal(summarizeUsage({ generatedAt: "", events: monthEvents }, monthFilters).totals.total, 500);
  assert.equal(summarizeUsageIndex(usageIndex(monthEvents), monthFilters).totals.total, 500);
});

test("summarizeUsage uses natural-day recent year ranges", () => {
  const events = [
    usageEvent("2025-06-22T23:59:59", 100),
    usageEvent("2025-06-23T00:00:00", 200),
    usageEvent("2026-06-23T23:59:59", 300),
    usageEvent("2026-06-24T00:00:00", 400),
  ];
  const filters = {
    preset: "recent",
    recentValue: "1年",
    bucket: "day",
    now: "2026-06-23T10:45:00",
  };

  assert.equal(summarizeUsage({ generatedAt: "", events }, filters).totals.total, 500);
  assert.equal(summarizeUsageIndex(usageIndex(events), filters).totals.total, 500);
});

test("buildUsageReport and summarizeUsage include imported project usage logs", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-project-log-"));
  const projectRoot = path.join(fakeHome, "openai_codex");
  const usageDir = path.join(projectRoot, ".codex-usage");
  await mkdir(path.join(fakeHome, ".codex", "sessions"), { recursive: true });
  await mkdir(usageDir, { recursive: true });
  await writeFile(
    path.join(usageDir, "usage.jsonl"),
    jsonl([
      {
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-05-31T10:00:00.000Z",
        source: "codex-oauth",
        channel: "Codex OAuth",
        project_root: projectRoot,
        cwd: projectRoot,
        session_id: "oauth-session-1",
        request_id: "request-1",
        model: "gpt-5.5",
        usage: { total: 120, input: 90, cached: 30, output: 30, reasoning: 8 },
      },
      {
        schema_version: "codex-usage.project-log.v1",
        timestamp: "2026-05-31T11:00:00.000Z",
        source: "codex-oauth",
        project_root: projectRoot,
        session_id: "oauth-session-1",
        model: "gpt-5.5",
        usage: { total: 80, input: 60, cached: 20, output: 20, reasoning: 4 },
      },
    ]),
  );

  const sources = await discoverUsageSources({ homeDir: fakeHome, importDirs: [projectRoot] });
  const report = await buildUsageReport({ homeDir: fakeHome, importDirs: [projectRoot] });
  const index = await buildUsageIndex({ homeDir: fakeHome, importDirs: [projectRoot] });
  const summary = summarizeUsage(report, { preset: "all", bucket: "day" });
  const indexedSummary = summarizeUsageIndex(index, { preset: "all", bucket: "day" });
  const fingerprint = await buildUsageFingerprint({ homeDir: fakeHome, importDirs: [projectRoot] });

  assert.deepEqual(
    sources.map((source) => [source.kind, source.label, source.path]),
    [
      ["main", "Main Codex", path.join(fakeHome, ".codex")],
      ["project-log", "Project openai_codex", projectRoot],
    ],
  );
  assert.equal(report.events.length, 2);
  assert.equal(report.sessions.length, 1);
  assert.equal(summary.totals.total, 200);
  assert.equal(indexedSummary.totals.total, summary.totals.total);
  assert.deepEqual(summary.channels.map((channel) => [channel.name, channel.total.total]), [["Codex OAuth", 200]]);
  assert.deepEqual(summary.projects.map((project) => [project.name, project.total.total]), [[projectRoot, 200]]);
  assert.equal(fingerprint.fileCount, 1);
});

test("buildUsageFingerprint changes when session files change", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-fingerprint-"));
  const sessionDir = path.join(fakeHome, ".codex", "sessions", "2026", "05", "01");
  const sessionFile = path.join(sessionDir, "rollout.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    sessionFile,
    jsonl([
      {
        timestamp: "2026-05-01T02:00:00.000Z",
        type: "session_meta",
        payload: { id: "fingerprint-1", source: "cli", originator: "codex-tui", cwd: "/work/cli" },
      },
      tokenRow("2026-05-01T02:01:00.000Z", 100, 80, 20, 20),
    ]),
  );

  const first = await buildUsageFingerprint({ homeDir: fakeHome });
  await appendFile(sessionFile, JSON.stringify(tokenRow("2026-05-01T02:02:00.000Z", 140, 110, 30, 30)) + "\n");
  const second = await buildUsageFingerprint({ homeDir: fakeHome });

  assert.match(first.fingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(second.fingerprint, first.fingerprint);
  assert.equal(second.fileCount, 1);
});

test("buildUsageReport and summarizeUsage aggregate totals by channel and period", async () => {
  const fakeHome = await mkdtemp(path.join(tmpdir(), "codex-report-"));
  const mainSessions = path.join(fakeHome, ".codex", "sessions", "2026", "05", "01");
  const jetbrainsSessions = path.join(fakeHome, "Library", "Caches", "JetBrains", "PyCharm2026.1", "aia", "codex", "sessions", "2026", "05", "08");
  await mkdir(mainSessions, { recursive: true });
  await mkdir(jetbrainsSessions, { recursive: true });

  await writeFile(
    path.join(mainSessions, "desktop.jsonl"),
    jsonl([
      {
        timestamp: "2026-05-01T02:00:00.000Z",
        type: "session_meta",
        payload: { id: "desktop-1", source: "vscode", originator: "Codex Desktop", cwd: "/work/a" },
      },
      tokenRow("2026-05-01T02:01:00.000Z", 200, 170, 50, 30),
    ]),
  );
  await writeFile(
    path.join(mainSessions, "cli.jsonl"),
    jsonl([
      {
        timestamp: "2026-05-01T03:00:00.000Z",
        type: "session_meta",
        payload: { id: "cli-1", source: "cli", originator: "codex-tui", cwd: "/work/c" },
      },
      tokenRow("2026-05-01T03:01:00.000Z", 100, 80, 20, 20),
    ]),
  );
  await writeFile(
    path.join(jetbrainsSessions, "jetbrains.jsonl"),
    jsonl([
      {
        timestamp: "2026-05-08T02:00:00.000Z",
        type: "session_meta",
        payload: { id: "jetbrains-1", source: "vscode", originator: "JetBrains.PyCharm", cwd: "/work/b" },
      },
      tokenRow("2026-05-08T02:01:00.000Z", 300, 260, 100, 40),
    ]),
  );

  const report = await buildUsageReport({ homeDir: fakeHome });
  const index = await buildUsageIndex({ homeDir: fakeHome });
  const all = summarizeUsage(report, { preset: "all", bucket: "week" });
  const indexedAll = summarizeUsageIndex(index, { preset: "all", bucket: "week" });
  const custom = summarizeUsage(report, {
    preset: "custom",
    startDate: "2026-05-07",
    endDate: "2026-05-08",
    bucket: "day",
  });
  const indexedCustom = summarizeUsageIndex(index, {
    preset: "custom",
    startDate: "2026-05-07",
    endDate: "2026-05-08",
    bucket: "day",
  });

  assert.equal(all.totals.total, 600);
  assert.equal(usageIndexMetadata(index).eventCount, 3);
  assert.equal(indexedAll.totals.total, all.totals.total);
  assert.deepEqual(
    indexedAll.channels.map((channel) => [channel.name, channel.total.total]),
    [
      ["JetBrains PyCharm", 300],
      ["Codex Desktop", 200],
      ["CLI", 100],
    ],
  );
  assert.deepEqual(
    all.channels.map((channel) => [channel.name, channel.total.total]),
    [
      ["JetBrains PyCharm", 300],
      ["Codex Desktop", 200],
      ["CLI", 100],
    ],
  );
  assert.deepEqual(
    all.timeline.find((row) => row.key === "2026-04-27").channels.map((channel) => [channel.name, channel.total.total]),
    [
      ["Codex Desktop", 200],
      ["CLI", 100],
    ],
  );
  assert.deepEqual(
    indexedAll.timeline.find((row) => row.key === "2026-04-27").channels.map((channel) => [channel.name, channel.total.total]),
    [
      ["Codex Desktop", 200],
      ["CLI", 100],
    ],
  );
  assert.equal(custom.totals.total, 300);
  assert.equal(indexedCustom.totals.total, custom.totals.total);
  assert.equal(custom.timeline[0].key, "2026-05-07");
  assert.equal(indexedCustom.timeline[0].key, "2026-05-07");
  assert.deepEqual(indexedAll.timeline, all.timeline);
});

test("summarizeUsage and summarizeUsageIndex fill a single local day with 24 hourly rows", () => {
  // Report and index summaries must both expose empty local-hour buckets for single-day charts.
  const events = [
    usageEvent("2026-05-26T01:15:00", 100),
    usageEvent("2026-05-26T01:45:00", 200),
    usageEvent("2026-05-26T02:05:00", 300),
  ];
  const report = { generatedAt: "2026-05-26T00:00:00", events };
  const index = usageIndex(events);
  const summary = summarizeUsage(report, { preset: "all", bucket: "hour" });
  const indexedSummary = summarizeUsageIndex(index, { preset: "all", bucket: "hour" });

  assert.deepEqual(
    [summary.timeline[0], summary.timeline[1], summary.timeline[2], summary.timeline[23]].map((row) => [
      row.key,
      row.total.total,
    ]),
    [
      ["2026-05-26 00:00", 0],
      ["2026-05-26 01:00", 300],
      ["2026-05-26 02:00", 300],
      ["2026-05-26 23:00", 0],
    ],
  );
  assert.equal(summary.timeline.length, 24);
  assert.deepEqual(indexedSummary.timeline, summary.timeline);
});

test("parseSessionFile correlates last-token usage to request context and preserves billing metadata", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-request-pricing-"));
  const file = path.join(root, "rollout.jsonl");
  await writeFile(file, jsonl([
    {
      timestamp: "2026-07-20T10:00:00.000Z",
      type: "session_meta",
      payload: { id: "request-pricing", source: "cli", originator: "codex-tui", cwd: root },
    },
    { type: "turn_context", payload: { model: "gpt-6-sol", model_context_window: 1_050_000 } },
    {
      timestamp: "2026-07-20T10:01:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: 272_000, input_tokens: 272_000, cached_input_tokens: 0,
            cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0,
          },
          last_token_usage: {
            total_tokens: 272_000, input_tokens: 272_000, cached_input_tokens: 0,
            cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0,
          },
          response: { service_tier: "priority" },
        },
      },
    },
    {
      timestamp: "2026-07-20T10:02:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: 544_101, input_tokens: 544_001, cached_input_tokens: 0,
            cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0,
          },
          last_token_usage: {
            total_tokens: 272_101, input_tokens: 272_001, cached_input_tokens: 0,
            cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0,
          },
          response: { service_tier: "default" },
        },
      },
    },
  ]));
  const session = await parseSessionFile(file, { id: "home", label: "Test", path: root });
  assert.equal(session.events.length, 2);
  assert.equal(session.events[0].requestInputTokens, 272_000);
  assert.equal(session.events[0].contextLevel, "short");
  assert.equal(session.events[1].requestInputTokens, 272_001);
  assert.equal(session.events[1].contextLevel, "long");
  assert.equal(session.events[0].cacheWriteKnown, true);
  assert.equal(session.events[0].cacheWriteTokens, 0);
  assert.equal(session.events[1].cacheWriteKnown, true);
  assert.equal(session.events[1].serviceTier, "default");
  assert.equal(session.events[0].serviceTier, "priority");
});

test("parseSessionFile records zero-token Codex quota observations with physical JSONL line numbers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-quota-lines-"));
  const file = path.join(root, "rollout.jsonl");
  const row = tokenRow("2026-09-25T11:59:00.000Z", 0, 0, 0, 0);
  row.payload.info.total_token_usage.reasoning_output_tokens = 0;
  row.payload.info.last_token_usage.reasoning_output_tokens = 0;
  row.payload.rate_limits = {
    limit_id: "codex",
    primary: {
      window_minutes: 300,
      resets_at: Date.parse("2026-09-25T14:37:00.000Z") / 1000,
      used_percent: null,
    },
  };
  await writeFile(file, [
    JSON.stringify({ type: "session_meta", timestamp: "2026-09-25T11:00:00.000Z", payload: { id: "quota-zero" } }),
    "",
    "{ interrupted write",
    JSON.stringify(row),
  ].join("\n"));

  const parsed = await parseSessionFile(file, { id: "home", label: "Codex", path: root });

  assert.equal(parsed.session, null);
  assert.equal(parsed.events.length, 0);
  assert.equal(parsed.rateLimitObservations.length, 1);
  assert.equal(parsed.rateLimitObservations[0].lineNumber, 4);
  assert.equal(parsed.rateLimitObservations[0].usedPercent, null);
});

test("selectQuotaWindows resolves each window independently and reports waiting, ambiguity, and ignored buckets", () => {
  const asOf = Date.parse("2026-09-25T12:00:00.000Z");
  const observedAtMs = asOf - 60_000;
  const observation = (overrides = {}) => ({
    sourcePath: "codex.jsonl",
    lineNumber: 1,
    role: "primary",
    observedAtMs,
    limitId: "codex",
    limitName: null,
    planType: null,
    windowMinutes: 300,
    resetsAtMs: Date.parse("2026-09-25T14:37:00.000Z"),
    usedPercent: null,
    ...overrides,
  });

  const onlyFiveHours = selectQuotaWindows([observation()], asOf);
  assert.equal(onlyFiveHours.windows.quota_5h.state, "available");
  assert.equal(onlyFiveHours.windows.quota_5h.usedPercent, null);
  assert.equal(onlyFiveHours.windows.quota_week.state, "missing");

  const expired = selectQuotaWindows([observation({ resetsAtMs: asOf })], asOf);
  assert.equal(expired.windows.quota_5h.state, "waiting");

  const tiedBuckets = selectQuotaWindows([
    observation({ limitId: "first" }),
    observation({ sourcePath: "other.jsonl", limitId: "second" }),
  ], asOf);
  assert.equal(tiedBuckets.limitId, null);
  assert.equal(tiedBuckets.windows.quota_5h.state, "ambiguous");

  const mainBucket = selectQuotaWindows([
    observation(),
    observation({ sourcePath: "codex.jsonl", lineNumber: 2, role: "secondary", windowMinutes: 10080, resetsAtMs: Date.parse("2026-10-02T14:37:00.000Z") }),
    observation({ sourcePath: "other.jsonl", limitId: "orphan" }),
  ], asOf);
  assert.equal(mainBucket.limitId, "codex");
  assert.equal(mainBucket.ignoredBucketCount, 1);

  const conflict = selectQuotaWindows([
    observation({ lineNumber: 1 }),
    observation({ lineNumber: 2, resetsAtMs: Date.parse("2026-09-25T14:38:00.000Z") }),
  ], asOf);
  assert.equal(conflict.windows.quota_5h.state, "ambiguous");
});

test("unknown usage presets are rejected rather than falling back to all", () => {
  assert.throws(
    () => summarizeUsage({ generatedAt: "2026-09-25T12:00:00.000Z", events: [] }, { preset: "unknown" }),
    (error) => error.code === "INVALID_PRESET",
  );
});

test("report and memory-index summaries share fixed quota slots and half-open event boundaries", () => {
  const startMs = Date.parse("2026-09-25T12:37:00.000Z");
  const asOfMs = Date.parse("2026-09-25T13:20:00.000Z");
  const endMs = Date.parse("2026-09-25T17:37:00.000Z");
  const events = [
    usageEvent(new Date(startMs - 1).toISOString(), 3),
    usageEvent(new Date(startMs).toISOString(), 5),
    usageEvent(new Date(startMs + 30 * 60 * 1000).toISOString(), 6),
    usageEvent(new Date(asOfMs).toISOString(), 11),
    usageEvent(new Date(endMs).toISOString(), 13),
  ];
  const rateLimitObservations = [{
    sourcePath: "codex.jsonl",
    lineNumber: 2,
    role: "primary",
    observedAtMs: asOfMs - 60_000,
    limitId: "codex",
    limitName: null,
    planType: null,
    windowMinutes: 300,
    resetsAtMs: endMs,
    usedPercent: 42.5,
  }];
  const report = { generatedAt: new Date(asOfMs).toISOString(), events, rateLimitObservations };
  const index = usageIndex(events);
  index.generatedAt = report.generatedAt;
  index.rateLimitObservations = rateLimitObservations;
  const filters = { preset: "quota_5h", bucket: "month", now: report.generatedAt };
  const reportSummary = summarizeUsage(report, filters);
  const indexSummary = summarizeUsageIndex(index, filters);

  assert.equal(reportSummary.range.bucket, "quota_30m");
  assert.equal(reportSummary.range.quotaState, "available");
  assert.equal(indexSummary.range.quotaState, "available");
  assert.equal(reportSummary.range.windowStart, new Date(startMs).toISOString());
  assert.equal(reportSummary.range.windowEndExclusive, new Date(endMs).toISOString());
  assert.equal(reportSummary.totals.total, 11);
  assert.equal(reportSummary.comparison, null);
  assert.equal(reportSummary.timeline.length, 10);
  assert.equal(reportSummary.timeline[0].total.total, 5);
  assert.equal(reportSummary.timeline[1].total.total, 6);
  assert.ok(reportSummary.timeline.slice(2).every((row) => row.future));
  assert.deepEqual(
    indexSummary.timeline.map((row) => [row.key, row.total.total, row.future]),
    reportSummary.timeline.map((row) => [row.key, row.total.total, row.future]),
  );
  assert.deepEqual(indexSummary.quota, reportSummary.quota);
});
