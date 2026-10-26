import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";

function projectLogLine({
  timestamp,
  sessionId,
  cwd,
  usage,
  requestId = `request-${sessionId}`,
  channel = "Test",
  model = "gpt-6-sol",
}) {
  return `${JSON.stringify({
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel,
    request_id: requestId,
    project_root: cwd,
    cwd,
    session_id: sessionId,
    model,
    service_tier: "priority",
    usage,
  })}\n`;
}

test("publishedUsageEvents returns complete events after source loss without duplication", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-published-events-"));
  const projectRoot = path.join(root, "project");
  const repositoryRoot = path.join(root, "repository");
  const cwd = path.join(repositoryRoot, "package");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const timestamp = "2026-07-12T02:00:00.000Z";
  const usage = {
    total: 1100,
    input: 1000,
    cached: 200,
    output: 100,
    reasoning: 40,
    cache_write_input_tokens: 300,
  };
  const line = projectLogLine({ timestamp, sessionId: "published-session", cwd, usage });
  const options = { homeDir: root, env: {}, importDirs: [projectRoot] };
  mkdirSync(path.join(repositoryRoot, ".git"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(path.dirname(usageFile), { recursive: true });
  writeFileSync(usageFile, line);
  const store = new UsageStore({ ...options, databaseFile: path.join(root, "index.sqlite") });
  try {
    await store.sync({ options });
    const source = store.database
      .prepare("SELECT kind, home_id, home_label FROM source_files WHERE path = ?")
      .get(usageFile);
    const stored = store.database
      .prepare("SELECT repository_key, price_version FROM events WHERE source_path = ?")
      .get(usageFile);
    const [published] = store.publishedUsageEvents();

    assert.deepEqual(Object.keys(published).sort(), [
      "cacheWriteKnown",
      "cacheWriteTokens",
      "channel",
      "contextLevel",
      "cwd",
      "detailMask",
      "homeId",
      "homeLabel",
      "model",
      "priceVersion",
      "project",
      "reconciliationGap",
      "repositoryKey",
      "repositoryKind",
      "repositoryPath",
      "requestInputTokens",
      "serviceTier",
      "sessionId",
      "sourceKind",
      "timestamp",
      "total",
    ]);
    assert.deepEqual(
      {
        timestamp: published.timestamp,
        sessionId: published.sessionId,
        homeId: published.homeId,
        homeLabel: published.homeLabel,
        sourceKind: published.sourceKind,
        channel: published.channel,
        project: published.project,
        model: published.model,
        cwd: published.cwd,
        repositoryKind: published.repositoryKind,
        repositoryPath: published.repositoryPath,
        detailMask: published.detailMask,
        reconciliationGap: published.reconciliationGap,
        cacheWriteTokens: published.cacheWriteTokens,
        cacheWriteKnown: published.cacheWriteKnown,
        requestInputTokens: published.requestInputTokens,
        contextLevel: published.contextLevel,
        serviceTier: published.serviceTier,
      },
      {
        timestamp,
        sessionId: "published-session",
        homeId: source.home_id,
        homeLabel: source.home_label,
        sourceKind: "project-log",
        channel: "Test",
        project: cwd,
        model: "gpt-6-sol",
        cwd,
        repositoryKind: "git",
        repositoryPath: repositoryRoot,
        detailMask: 15,
        reconciliationGap: 0,
        cacheWriteTokens: 300,
        cacheWriteKnown: true,
        requestInputTokens: 1000,
        contextLevel: "short",
        serviceTier: "priority",
      },
    );
    assert.equal(published.repositoryKey, stored.repository_key);
    assert.ok(published.repositoryKey.startsWith("git:"));
    assert.equal(published.priceVersion, stored.price_version);
    assert.ok(published.priceVersion);
    assert.deepEqual(published.total, {
      total: usage.total,
      input: usage.input,
      cached: usage.cached,
      output: usage.output,
      reasoning: usage.reasoning,
    });

    const resolvedTiers = [];
    store.serviceTierEvidence = {
      resolve(sessionId, timestampMs, serviceTier) {
        resolvedTiers.push([sessionId, timestampMs, serviceTier]);
        return "resolved-tier";
      },
    };
    assert.equal(store.publishedUsageEvents()[0].serviceTier, "resolved-tier");
    assert.deepEqual(resolvedTiers, [["published-session", Date.parse(timestamp), "priority"]]);
    store.serviceTierEvidence = null;

    const beforeLoss = store.publishedUsageEvents();
    unlinkSync(usageFile);
    const missing = await store.sync({ options: { ...options, importDirs: [] } });
    assert.deepEqual(
      missing.missingSources.map((entry) => entry.path),
      [usageFile],
    );
    assert.deepEqual(store.publishedUsageEvents(), beforeLoss);

    writeFileSync(usageFile, line);
    await store.sync({ options });
    assert.deepEqual(store.publishedUsageEvents(), beforeLoss);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishedUsageEvents keeps every source and event for a shared session", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-published-shared-"));
  const projectRoot = path.join(root, "project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const codexHome = path.join(root, "extra-codex");
  const rolloutFile = path.join(codexHome, "sessions", "2026", "07", "rollout-shared.jsonl");
  const projectTimestamp = "2026-07-12T02:00:00.000Z";
  const codexTimestamp = "2026-07-12T02:01:00.000Z";
  mkdirSync(path.dirname(usageFile), { recursive: true });
  mkdirSync(path.dirname(rolloutFile), { recursive: true });
  writeFileSync(
    usageFile,
    projectLogLine({
      timestamp: projectTimestamp,
      sessionId: "shared-session",
      cwd: "/work/project",
      usage: { total: 12, input: 9, cached: 1, output: 3, reasoning: 1 },
    }),
  );
  writeFileSync(
    rolloutFile,
    [
      { type: "session_meta", payload: { id: "shared-session", source: "cli", cwd: "/work/codex" } },
      { type: "turn_context", payload: { model: "codex-model" } },
      {
        type: "event_msg",
        timestamp: codexTimestamp,
        payload: {
          type: "token_count",
          service_tier: "priority",
          info: {
            last_token_usage: {
              total_tokens: 120,
              input_tokens: 80,
              cached_input_tokens: 10,
              output_tokens: 30,
              reasoning_output_tokens: 5,
              cache_write_input_tokens: 7,
            },
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const options = {
    homeDir: root,
    env: {},
    extraHomes: codexHome,
    importDirs: [projectRoot],
  };
  const store = new UsageStore({ ...options, databaseFile: path.join(root, "index.sqlite") });
  try {
    await store.sync({ options });
    const published = store.publishedUsageEvents();
    assert.deepEqual(
      published.map((event) => [event.timestamp, event.sessionId, event.sourceKind]),
      [
        [projectTimestamp, "shared-session", "project-log"],
        [codexTimestamp, "shared-session", "extra"],
      ],
    );

    store.homes = store.homes.map((home) => ({ ...home, kind: "wrong-caller-kind" }));
    assert.deepEqual(
      store.publishedUsageEvents().map((event) => event.sourceKind),
      ["project-log", "extra"],
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishedUsageHomes keeps persistent identities after home loss without duplication", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-published-homes-"));
  const projectRoot = path.join(root, "project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const codexHome = path.join(root, "extra-codex");
  const firstRollout = path.join(codexHome, "sessions", "2026", "07", "rollout-a.jsonl");
  const secondRollout = path.join(codexHome, "sessions", "2026", "07", "rollout-b.jsonl");
  const rollout = (sessionId, timestamp) =>
    [
      { type: "session_meta", payload: { id: sessionId, source: "cli", cwd: "/work/codex" } },
      { type: "turn_context", payload: { model: "codex-model" } },
      {
        type: "event_msg",
        timestamp,
        payload: {
          type: "token_count",
          info: { last_token_usage: { total_tokens: 10, input_tokens: 8, output_tokens: 2 } },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n");
  const projectLine = projectLogLine({
    timestamp: "2026-07-12T02:00:00.000Z",
    sessionId: "published-home",
    cwd: "/work/project",
    usage: { total: 10, input: 8, cached: 0, output: 2, reasoning: 0 },
  });
  mkdirSync(path.dirname(usageFile), { recursive: true });
  mkdirSync(path.dirname(firstRollout), { recursive: true });
  writeFileSync(usageFile, projectLine);
  writeFileSync(firstRollout, rollout("codex-home-a", "2026-07-12T02:01:00.000Z"));
  writeFileSync(secondRollout, rollout("codex-home-b", "2026-07-12T02:02:00.000Z"));
  const options = {
    homeDir: root,
    env: {},
    extraHomes: codexHome,
    importDirs: [projectRoot],
  };
  const store = new UsageStore({ ...options, databaseFile: path.join(root, "index.sqlite") });
  const identify = (sourcePath) =>
    store.database
      .prepare("SELECT home_id, home_label, home_path, kind FROM source_files WHERE path = ?")
      .get(sourcePath);
  const factSnapshot = () =>
    JSON.stringify({
      sources: store.database.prepare("SELECT * FROM source_files ORDER BY path").all(),
      events: store.database.prepare("SELECT * FROM events ORDER BY id").all(),
    });
  try {
    await store.sync({ options });
    const projectSource = identify(usageFile);
    const codexSource = identify(firstRollout);
    const expected = [
      {
        id: projectSource.home_id,
        label: projectSource.home_label,
        path: projectSource.home_path,
        kind: projectSource.kind,
      },
      {
        id: codexSource.home_id,
        label: codexSource.home_label,
        path: codexSource.home_path,
        kind: codexSource.kind,
      },
    ].sort((left, right) => left.id.localeCompare(right.id));
    const factsBefore = factSnapshot();
    assert.deepEqual(store.publishedUsageHomes(), expected);
    assert.deepEqual(factSnapshot(), factsBefore);

    rmSync(projectRoot, { recursive: true, force: true });
    await store.sync({ options: { ...options, importDirs: [] } });
    assert.deepEqual(store.publishedUsageHomes(), expected);

    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, projectLine);
    await store.sync({ options });
    assert.deepEqual(store.publishedUsageHomes(), expected);

    store.database
      .prepare("UPDATE source_files SET home_label = 'conflicting label' WHERE path = ?")
      .run(secondRollout);
    assert.throws(
      () => store.publishedUsageHomes(),
      (error) => error.code === "PUBLISHED_HOME_IDENTITY_CONFLICT",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishedUsageSessions aggregates per home and survives source loss", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-published-sessions-"));
  const projectRoot = path.join(root, "project");
  const usageFile = path.join(projectRoot, ".codex-usage", "usage.jsonl");
  const codexHome = path.join(root, "extra-codex");
  const rolloutFile = path.join(codexHome, "sessions", "2026", "07", "rollout-shared.jsonl");
  const firstTimestamp = "2026-07-12T02:00:00.000Z";
  const lastTimestamp = "2026-07-12T02:02:00.000Z";
  const codexTimestamp = "2026-07-12T02:03:00.000Z";
  const lines = [
    projectLogLine({
      timestamp: firstTimestamp,
      sessionId: "shared-session",
      cwd: "/work/first",
      requestId: "project-event-1",
      channel: "First channel",
      model: "first-model",
      usage: { total: 110, input: 100, cached: 10, output: 10, reasoning: 3 },
    }),
    projectLogLine({
      timestamp: lastTimestamp,
      sessionId: "shared-session",
      cwd: "/work/last",
      requestId: "project-event-2",
      channel: "Last channel",
      model: "last-model",
      usage: { total: 220, input: 200, cached: 20, output: 20, reasoning: 7 },
    }),
  ].join("");
  mkdirSync(path.dirname(usageFile), { recursive: true });
  mkdirSync(path.dirname(rolloutFile), { recursive: true });
  writeFileSync(usageFile, lines);
  writeFileSync(
    rolloutFile,
    [
      { type: "session_meta", payload: { id: "shared-session", source: "cli", cwd: "/work/codex" } },
      { type: "turn_context", payload: { model: "codex-model" } },
      {
        type: "event_msg",
        timestamp: codexTimestamp,
        payload: {
          type: "token_count",
          info: { last_token_usage: { total_tokens: 12, input_tokens: 9, output_tokens: 3 } },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const options = {
    homeDir: root,
    env: {},
    extraHomes: codexHome,
    importDirs: [projectRoot],
  };
  const store = new UsageStore({ ...options, databaseFile: path.join(root, "index.sqlite") });
  const identify = (sourcePath) =>
    store.database.prepare("SELECT home_id, home_label, home_path FROM source_files WHERE path = ?").get(sourcePath);
  const factSnapshot = () =>
    JSON.stringify({
      sources: store.database.prepare("SELECT * FROM source_files ORDER BY path").all(),
      events: store.database.prepare("SELECT * FROM events ORDER BY id").all(),
    });
  try {
    await store.sync({ options });
    const projectHome = identify(usageFile);
    const codexHomeIdentity = identify(rolloutFile);
    const factsBefore = factSnapshot();
    const sessions = store.publishedUsageSessions();
    assert.deepEqual(factSnapshot(), factsBefore);
    assert.deepEqual(
      sessions.map(({ id, homeId, eventCount, firstAt, lastAt }) => ({
        id,
        homeId,
        eventCount,
        firstAt,
        lastAt,
      })),
      [
        {
          id: "shared-session",
          homeId: projectHome.home_id,
          eventCount: 2,
          firstAt: firstTimestamp,
          lastAt: lastTimestamp,
        },
        {
          id: "shared-session",
          homeId: codexHomeIdentity.home_id,
          eventCount: 1,
          firstAt: codexTimestamp,
          lastAt: codexTimestamp,
        },
      ],
    );
    assert.deepEqual(sessions[0], {
      id: "shared-session",
      homeId: projectHome.home_id,
      homeLabel: projectHome.home_label,
      homePath: projectHome.home_path,
      firstAt: firstTimestamp,
      lastAt: lastTimestamp,
      eventCount: 2,
      total: { total: 330, input: 300, cached: 30, output: 30, reasoning: 10 },
      channel: "Last channel",
      cwd: "/work/last",
      model: "last-model",
    });
    assert.equal(sessions[1].homeLabel, codexHomeIdentity.home_label);
    assert.equal(sessions[1].homePath, codexHomeIdentity.home_path);

    rmSync(projectRoot, { recursive: true, force: true });
    await store.sync({ options: { ...options, importDirs: [] } });
    assert.deepEqual(store.publishedUsageSessions(), sessions);

    mkdirSync(path.dirname(usageFile), { recursive: true });
    writeFileSync(usageFile, lines);
    await store.sync({ options });
    assert.deepEqual(store.publishedUsageSessions(), sessions);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("publishedUsageReport reads one carrier snapshot and survives failures", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "history-published-report-"));
  const codexHome = path.join(root, "codex");
  const rolloutFile = path.join(codexHome, "sessions", "2026", "07", "rollout-report.jsonl");
  const databaseFile = path.join(root, "index.sqlite");
  const timestamp = "2026-07-12T02:00:00.000Z";
  const timestampMs = Date.parse(timestamp);
  const resetsAt = Date.parse("2026-07-12T07:00:00.000Z") / 1000;
  mkdirSync(path.dirname(rolloutFile), { recursive: true });
  writeFileSync(
    rolloutFile,
    [
      { type: "session_meta", payload: { id: "report-session", source: "cli", cwd: "/work/report" } },
      { type: "turn_context", payload: { model: "codex-model" } },
      {
        type: "event_msg",
        timestamp,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              total_tokens: 12,
              input_tokens: 9,
              cached_input_tokens: 1,
              output_tokens: 3,
              reasoning_output_tokens: 1,
            },
          },
          rate_limits: {
            limit_id: "codex",
            primary: { window_minutes: 300, resets_at: resetsAt, used_percent: 37 },
            secondary: { window_minutes: 10080, resets_at: resetsAt + 604800, used_percent: null },
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const options = { homeDir: root, env: {}, extraHomes: codexHome };
  const store = new UsageStore({ ...options, databaseFile });
  const factSnapshot = () =>
    JSON.stringify({
      sources: store.database.prepare("SELECT * FROM source_files ORDER BY path").all(),
      events: store.database.prepare("SELECT * FROM events ORDER BY id").all(),
      quota: store.database.prepare("SELECT * FROM rate_limit_observations ORDER BY source_path, role").all(),
    });
  try {
    await store.sync({ options });
    const factsBefore = factSnapshot();
    const report = store.publishedUsageReport();
    assert.deepEqual(Object.keys(report), ["events", "homes", "sessions", "rateLimitObservations"]);
    assert.deepEqual(factSnapshot(), factsBefore);
    assert.deepEqual(report.events, store.publishedUsageEvents());
    assert.deepEqual(report.homes, store.publishedUsageHomes());
    assert.deepEqual(report.sessions, store.publishedUsageSessions());
    const warmedQuota = store.quotaObservations();
    assert.deepEqual(report.rateLimitObservations, warmedQuota);
    assert.deepEqual(
      report.rateLimitObservations.map(({ role, windowMinutes, resetsAtMs, usedPercent }) => ({
        role,
        windowMinutes,
        resetsAtMs,
        usedPercent,
      })),
      [
        { role: "primary", windowMinutes: 300, resetsAtMs: resetsAt * 1000, usedPercent: 37 },
        { role: "secondary", windowMinutes: 10080, resetsAtMs: (resetsAt + 604800) * 1000, usedPercent: null },
      ],
    );

    const originalHome = report.homes[0];
    const originalEventCount = report.events.length;
    const originalSession = report.sessions[0];
    const originalEvent = store.database.prepare("SELECT id FROM events ORDER BY id LIMIT 1").get();
    const writer = new DatabaseSync(databaseFile);
    writer.exec("PRAGMA busy_timeout = 5000");
    const publishedEvents = store.publishedUsageEvents;
    let interleaved = false;
    store.publishedUsageEvents = () => {
      const events = publishedEvents.call(store);
      if (!interleaved) {
        interleaved = true;
        writer.exec("BEGIN IMMEDIATE");
        try {
          writer.prepare("UPDATE source_files SET home_label = 'after commit' WHERE home_id = ?").run(originalHome.id);
          writer.prepare("UPDATE events SET home_label = 'after commit' WHERE home_id = ?").run(originalHome.id);
          writer.prepare("UPDATE rate_limit_observations SET used_percent = 58 WHERE role = 'primary'").run();
          writer
            .prepare(
              `INSERT INTO events (
                source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
                hour_key, day_key, week_key, month_key, cwd, repository_key, repository_path,
                repository_kind, detail_mask, reconciliation_gap, cache_write_tokens,
                cache_write_known, request_input_tokens, context_level, service_tier, price_version,
                total, input, cached, output, reasoning
              )
              SELECT
                source_path, ?, session_id, home_id, 'after commit', channel, project, model,
                hour_key, day_key, week_key, month_key, cwd, repository_key, repository_path,
                repository_kind, detail_mask, reconciliation_gap, cache_write_tokens,
                cache_write_known, request_input_tokens, context_level, service_tier, price_version,
                total, input, cached, output, reasoning
              FROM events WHERE id = ?`,
            )
            .run(timestampMs + 1000, originalEvent.id);
          writer.exec("COMMIT");
        } catch (error) {
          writer.exec("ROLLBACK");
          throw error;
        }
      }
      return events;
    };
    try {
      const snapshot = store.publishedUsageReport();
      assert.equal(interleaved, true);
      assert.equal(snapshot.events.length, originalEventCount);
      assert.ok(snapshot.events.every((event) => event.homeLabel === originalHome.label));
      assert.deepEqual(snapshot.homes, [originalHome]);
      assert.deepEqual(snapshot.sessions, [originalSession]);
      assert.deepEqual(snapshot.rateLimitObservations, report.rateLimitObservations);
      assert.equal(snapshot.rateLimitObservations.find(({ role }) => role === "primary").usedPercent, 37);
    } finally {
      delete store.publishedUsageEvents;
      writer.close();
    }
    const afterCommit = store.publishedUsageReport();
    assert.equal(afterCommit.events.length, originalEventCount + 1);
    assert.equal(afterCommit.homes[0].label, "after commit");
    assert.equal(afterCommit.sessions[0].eventCount, 2);
    assert.equal(afterCommit.rateLimitObservations.find(({ role }) => role === "primary").usedPercent, 58);

    store.database.exec("BEGIN IMMEDIATE");
    try {
      store.database.prepare("UPDATE rate_limit_observations SET used_percent = 99 WHERE role = 'primary'").run();
      const uncommitted = store.publishedUsageReport();
      assert.equal(uncommitted.rateLimitObservations.find(({ role }) => role === "primary").usedPercent, 99);
    } finally {
      store.database.exec("ROLLBACK");
    }
    assert.equal(
      store.publishedUsageReport().rateLimitObservations.find(({ role }) => role === "primary").usedPercent,
      58,
    );

    store.database.exec("BEGIN IMMEDIATE");
    const publishedSessions = store.publishedUsageSessions;
    store.publishedUsageSessions = () => {
      throw new Error("injected report failure");
    };
    try {
      assert.throws(() => store.publishedUsageReport(), /injected report failure/);
    } finally {
      delete store.publishedUsageSessions;
      store.database.exec("ROLLBACK");
    }
    assert.equal(store.publishedUsageReport().events.length, originalEventCount + 1);
    assert.equal(publishedSessions, UsageStore.prototype.publishedUsageSessions);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
