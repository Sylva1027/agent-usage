import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

// Independent literal oracle: frozen M0.6 fixture-cases X-05..X-09 and N-02.
// No product reader, normalization or statistics imports are allowed here.
const COLUMNS = [
  "id",
  "session_id",
  "status",
  "started_at",
  "completed_at",
  "duration_ms",
  "input_tokens",
  "output_tokens",
  "agent",
  "query_source",
  "model_id",
  "provider_id",
];
const DAY_A = Date.parse("2026-10-03T12:00:00Z");
const DAY_B = Date.parse("2026-10-04T12:00:00Z");

function row(id, base, output, duration, extra = {}) {
  return {
    id,
    session_id: "fixture-session",
    status: "completed",
    started_at: base,
    completed_at: base + duration,
    duration_ms: duration,
    input_tokens: 10,
    output_tokens: output,
    agent: "",
    query_source: "",
    model_id: "small-model",
    provider_id: "fixture-provider",
    ...extra,
  };
}

const SMALL = {
  sourceKind: "zcode",
  channel: "zcode",
  modelProvider: "fixture-provider",
  reasoningEffort: "",
  timingKind: "request_e2e",
  tokenScope: "reported_output_unspecified",
  model: "small-model",
  agentKind: "unknown",
  agent: "",
  n: 5,
  rank: null,
  insufficientSamples: true,
  tps: { p10: 1, p50: 3, p90: 5, pooled: (55 * 1000) / 15000 },
  durationMs: { p50: 3000, p90: 5000 },
  sums: { outputTokens: 55, durationMs: 15000 },
};
const RANKED = {
  sourceKind: "zcode",
  channel: "zcode-subagent",
  modelProvider: "fixture-provider",
  reasoningEffort: "",
  timingKind: "request_e2e",
  tokenScope: "reported_output_unspecified",
  model: "ranked-model",
  agentKind: "subagent",
  agent: "worker",
  n: 25,
  rank: null,
  insufficientSamples: false,
  tps: { p10: 204, p50: 224, p90: 244, pooled: 224 },
  durationMs: { p50: 500, p90: 500 },
  sums: { outputTokens: 2800, durationMs: 12500 },
};
const REASONS = {
  record_conflict: 0,
  model_ambiguous: 0,
  terminal_unverified: 0,
  source_filtered: 1,
  output_missing_zero_invalid: 1,
  duration_missing_nonpositive_invalid: 1,
  partial_item_span: 0,
  overlapping_item_span: 0,
};
const SMALL_COVERAGE = {
  eligible: 9,
  positiveOutput: 8,
  timedPositiveOutput: 7,
  completeTimedPositiveOutput: 7,
  sampled: 5,
  dropped: 3,
  pending: 1,
  unplaced: 1,
  droppedByReason: REASONS,
  timingRate: 7 / 8,
  completeTimingRate: 7 / 8,
  sampleRate: 5 / 9,
  byEra: null,
};

const DSH_GROUP = {
  sourceKind: "dsh",
  channel: "dsh-subagent",
  agentKind: "subagent",
  agent: "fixture-worker",
  model: "dsh-model",
  modelProvider: "fixture-provider",
  reasoningEffort: "",
  timingKind: "request_e2e",
  tokenScope: "reported_output_unspecified",
  n: 4,
  rank: null,
  insufficientSamples: true,
  tps: { p10: 10, p50: 20, p90: 40, pooled: 30 },
  durationMs: { p50: 2000, p90: 4000 },
  sums: { outputTokens: 300, durationMs: 10000 },
};

const OPENCODE_GROUP = {
  sourceKind: "opencode",
  channel: "opencode",
  modelProvider: "fixture-provider",
  reasoningEffort: "",
  timingKind: "request_e2e",
  tokenScope: "visible_plus_reasoning",
  model: "opencode-model",
  agentKind: "unknown",
  agent: "fixture-agent",
  n: 3,
  rank: null,
  insufficientSamples: true,
  tps: { p10: 100 / 3, p50: 100, p90: 120, pooled: 70 },
  durationMs: { p50: 2000, p90: 3000 },
  sums: { outputTokens: 420, durationMs: 6000 },
};

function dshRows(session, offset) {
  const rows = [
    {
      type: "session",
      version: 4,
      id: session,
      createdAt: DAY_B,
      cwd: "/fixture/dsh",
      delegationDepth: 1,
      agentPreset: "fixture-worker",
    },
  ];
  for (let turn = 1; turn <= 2; turn++) {
    const i = offset + turn;
    const start = DAY_B + i * 10000;
    const step = { type: "step/start", time: start, data: { turn, step: 1 } };
    const message = {
      type: "assistant/message",
      time: start + i * 1000,
      data: {
        turn,
        step: 1,
        usage: { inputTokens: 10, outputTokens: i * i * 10 },
        message: { content: "DSH-INTEGRATION-BODY-SENTINEL" },
      },
    };
    rows.push(
      {
        type: "request/header",
        time: start - 1,
        data: { header: { config: { model: "dsh-model", provider: "fixture-provider" } } },
      },
      step,
      message,
    );
    if (turn === 1) rows.push(structuredClone(step), structuredClone(message));
    rows.push({
      type: "step/end",
      time: start + 999000,
      data: { turn, step: 1, result: "DSH-INTEGRATION-END-SENTINEL" },
    });
  }
  return rows;
}

/** Fixed, disposable source data. Indexes are created by the real store/server, never preseeded. */
export function createPerfIntegrationFixture({ sources = ["zcode"] } = {}) {
  if (
    !Array.isArray(sources) ||
    sources[0] !== "zcode" ||
    !(
      sources.length === 1 ||
      (sources.length === 2 && sources[1] === "dsh") ||
      (sources.length === 3 && sources[1] === "dsh" && sources[2] === "opencode")
    )
  ) {
    throw new TypeError("Supported fixture sources: ['zcode'], ['zcode','dsh'], or ['zcode','dsh','opencode']");
  }
  const tempParent = realpathSync(tmpdir());
  const root = mkdtempSync(path.join(tempParent, "perf-integration-"));
  const rootReal = realpathSync(root);
  let closed = false;
  const close = () => {
    if (closed) return;
    assert.equal(path.dirname(root), tempParent);
    assert.ok(path.basename(root).startsWith("perf-integration-"));
    if (existsSync(root)) {
      assert.equal(realpathSync(root), rootReal, "refuse cleanup of a replaced/symlinked fixture root");
      rmSync(root, { recursive: true, force: true });
    }
    closed = true;
  };
  try {
    const a = [1, 2, 3, 4, 5].map((i) => row(`small-${i}`, DAY_A + i * 10000, i * i, i * 1000));
    a.push(
      row("failed", DAY_A, 100, 1000, { status: "failed" }),
      row("zero-duration", DAY_A, 100, 0),
      row("zero-output", DAY_A, 0, 1000),
      row("pending", DAY_A, 100, 1000, { status: "running" }),
      row("unplaced", DAY_A, 100, 1000, { started_at: null, completed_at: null }),
    );
    const b = Array.from({ length: 25 }, (_, i) =>
      row(`ranked-${i}`, DAY_B + i * 1000, 100 + i, 500, {
        agent: "worker",
        query_source: "subagent",
        model_id: "ranked-model",
      }),
    );
    // A has no TTFT columns; B has NULL TTFT columns. Neither determines eligibility.
    const manifest = {
      version: 1,
      sources,
      columns: COLUMNS,
      homes: [
        { name: "zcode-small", ttftColumns: [], rows: a },
        { name: "zcode-ranked", ttftColumns: ["first_token_at", "time_to_first_token_ms"], rows: b },
      ],
    };
    const homePaths = [];
    for (const home of manifest.homes) {
      const homePath = path.join(root, home.name);
      homePaths.push(homePath);
      const dbFile = path.join(homePath, "cli", "db", "db.sqlite");
      mkdirSync(path.dirname(dbFile), { recursive: true });
      const db = new DatabaseSync(dbFile);
      try {
        db.exec(`CREATE TABLE model_usage (${[...COLUMNS, ...home.ttftColumns].join(",")})`);
        const insert = db.prepare(
          `INSERT INTO model_usage (${COLUMNS.join(",")}) VALUES (${COLUMNS.map(() => "?").join(",")})`,
        );
        for (const entry of home.rows) insert.run(...COLUMNS.map((key) => entry[key]));
      } finally {
        db.close();
      }
      utimesSync(dbFile, DAY_B / 1000, DAY_B / 1000);
    }
    const dshHome = path.join(root, "dsh-fixture");
    if (sources.includes("dsh")) {
      manifest.dsh = {
        name: "dsh-fixture",
        sessions: [
          { id: "fixture-session-a", rows: dshRows("fixture-session-a", 0) },
          { id: "fixture-session-b", rows: dshRows("fixture-session-b", 2) },
        ],
      };
      for (const session of manifest.dsh.sessions) {
        const file = path.join(dshHome, "sessions", "fixture", session.id, "session.v4.jsonl.zstd");
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(
          file,
          Buffer.concat(session.rows.map((entry) => zstdCompressSync(Buffer.from(`${JSON.stringify(entry)}\n`)))),
        );
        utimesSync(file, DAY_B / 1000, DAY_B / 1000);
      }
    }
    const opencodeHome = path.join(root, "opencode-fixture");
    if (sources.includes("opencode")) {
      const opencodeMessages = [
        {
          db: "opencode.db",
          sessions: [
            { id: "oc-v2-first", version: "2.0.20" },
            { id: "oc-v1-session", version: "1.9.0" },
            { id: "oc-v2-missing-completed", version: "2.0.20" },
          ],
          rows: [
            {
              id: "same-message",
              session_id: "oc-v2-first",
              created: DAY_B + 1000,
              completed: DAY_B + 2000,
              output: 100,
              reasoning: 20,
            },
            {
              id: "legacy-only",
              session_id: "oc-v1-session",
              created: DAY_B + 3000,
              completed: DAY_B + 4000,
              output: 900,
              reasoning: 90,
            },
            {
              id: "missing-streamed",
              session_id: "oc-v2-missing-completed",
              created: DAY_B + 5000,
              completed: DAY_B + 6000,
              output: 40,
              reasoning: 10,
              omitStreamed: true,
            },
            {
              id: "unknown-version",
              session_id: "oc-unknown-version",
              created: DAY_B + 9000,
              completed: DAY_B + 12000,
              output: 90,
              reasoning: 10,
            },
          ],
        },
        {
          db: "opencode-extra.db",
          sessions: [{ id: "oc-v2-second", version: "2.0.20" }],
          rows: [
            {
              id: "same-message",
              session_id: "oc-v2-second",
              created: DAY_B + 6000,
              completed: DAY_B + 8000,
              output: 200,
              reasoning: 0,
            },
          ],
        },
      ];
      manifest.opencode = { name: "opencode-fixture", databases: opencodeMessages };
      for (const database of opencodeMessages) {
        const dbFile = path.join(opencodeHome, database.db);
        mkdirSync(path.dirname(dbFile), { recursive: true });
        const db = new DatabaseSync(dbFile);
        try {
          db.exec("PRAGMA journal_mode=WAL");
          db.exec(
            "CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
          );
          db.exec("CREATE TABLE session_v2 (id TEXT PRIMARY KEY, version TEXT)");
          const insertSession = db.prepare("INSERT INTO session_v2 (id, version) VALUES (?, ?)");
          for (const session of database.sessions) insertSession.run(session.id, session.version);
          const insertMessage = db.prepare(
            "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
          );
          for (const [index, message] of database.rows.entries()) {
            const data = {
              time: {
                created: message.created,
                ...(message.omitStreamed ? {} : { streamed: message.completed }),
                completed: message.completed,
              },
              tokens: { output: message.output, reasoning: message.reasoning },
              model: { id: "opencode-model", providerID: "fixture-provider" },
              agent: "fixture-agent",
              finish: "stop",
              content: [{ type: "text", text: "OPENCODE-INTEGRATION-BODY-SENTINEL" }],
            };
            insertMessage.run(
              message.id,
              message.session_id,
              "assistant",
              index + 1,
              message.created,
              message.created,
              JSON.stringify(data),
            );
          }
        } finally {
          db.close();
        }
        utimesSync(dbFile, DAY_B / 1000, DAY_B / 1000);
      }
    }
    const reportOptions = {
      homeDir: root,
      env: {},
      extraZcodeHomes: homePaths.join(path.delimiter),
      extraDshHomes: sources.includes("dsh") ? dshHome : "",
      extraOpencodeHomes: sources.includes("opencode") ? opencodeHome : "",
      importDirs: [],
      automaticDiscoveryEnabled: false,
      pricingRefreshSchedulerEnabled: false,
    };
    const expected = {
      provenance: "M0.6 frozen fixture-cases X-05..X-09/N-02; literal manual calculations, not product output",
      now: "2026-10-04T13:00:00.000Z",
      physicalRows: 35,
      candidates: 35,
      all: {
        groups: [RANKED, SMALL],
        coverage: {
          ...SMALL_COVERAGE,
          eligible: 34,
          positiveOutput: 33,
          timedPositiveOutput: 32,
          completeTimedPositiveOutput: 32,
          sampled: 30,
          timingRate: 32 / 33,
          completeTimingRate: 32 / 33,
          sampleRate: 30 / 34,
        },
      },
      smallOnly: { groups: [SMALL], coverage: SMALL_COVERAGE },
      dayB: {
        groups: [RANKED],
        coverage: {
          eligible: 25,
          positiveOutput: 25,
          timedPositiveOutput: 25,
          completeTimedPositiveOutput: 25,
          sampled: 25,
          dropped: 0,
          pending: 0,
          unplaced: 1,
          droppedByReason: Object.fromEntries(Object.keys(REASONS).map((key) => [key, 0])),
          timingRate: 1,
          completeTimingRate: 1,
          sampleRate: 1,
          byEra: null,
        },
      },
    };
    if (sources.includes("dsh")) {
      expected.physicalRows = 57; // 35 SQLite rows + 22 independently compressed JSON records.
      expected.candidates = 39;
      expected.dsh = { files: 2, frames: 22, candidates: 4, group: DSH_GROUP };
      expected.zcodeOnly = structuredClone(expected.all);
      expected.all.groups = [RANKED, DSH_GROUP, SMALL];
      Object.assign(expected.all.coverage, {
        eligible: 38,
        positiveOutput: 37,
        timedPositiveOutput: 36,
        completeTimedPositiveOutput: 36,
        sampled: 34,
        timingRate: 36 / 37,
        completeTimingRate: 36 / 37,
        sampleRate: 34 / 38,
      });
      expected.dayB.groups = [RANKED, DSH_GROUP];
      Object.assign(expected.dayB.coverage, {
        eligible: 29,
        positiveOutput: 29,
        timedPositiveOutput: 29,
        completeTimedPositiveOutput: 29,
        sampled: 29,
      });
      // In a mixed fixture smallOnly means excluding BOTH the ranked ZCode home and DSH home.
    }
    if (sources.includes("opencode")) {
      expected.zcodeDshOnly = structuredClone(expected.all);
      expected.physicalRows = 62;
      expected.candidates = 43;
      expected.opencode = { files: 2, rows: 5, candidates: 4, group: OPENCODE_GROUP };
      expected.all.groups = [RANKED, OPENCODE_GROUP, DSH_GROUP, SMALL];
      Object.assign(expected.all.coverage, {
        eligible: 42,
        positiveOutput: 41,
        timedPositiveOutput: 39,
        completeTimedPositiveOutput: 39,
        sampled: 37,
        dropped: 4,
        pending: 1,
        timingRate: 39 / 41,
        completeTimingRate: 39 / 41,
        sampleRate: 37 / 42,
        droppedByReason: { ...REASONS, duration_missing_nonpositive_invalid: 2 },
      });
      expected.dayB.groups = [RANKED, OPENCODE_GROUP, DSH_GROUP];
      Object.assign(expected.dayB.coverage, {
        eligible: 33,
        positiveOutput: 33,
        timedPositiveOutput: 32,
        completeTimedPositiveOutput: 32,
        sampled: 32,
        dropped: 1,
        pending: 0,
        timingRate: 32 / 33,
        completeTimingRate: 32 / 33,
        sampleRate: 32 / 33,
        droppedByReason: Object.fromEntries(
          Object.keys(REASONS).map((key) => [key, key === "duration_missing_nonpositive_invalid" ? 1 : 0]),
        ),
      });
    }
    return {
      reportOptions,
      serverOptions: {
        ...reportOptions,
        databaseFile: path.join(root, "api-index.sqlite"),
        importStoreFile: path.join(root, "imports.json"),
      },
      expected: structuredClone(expected),
      fixtureHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

/** Fixed Codex-only fixture: each 25-turn thread is spread over three rollouts. */
export function createPerfCodexIntegrationFixture() {
  const tempParent = realpathSync(tmpdir());
  const root = mkdtempSync(path.join(tempParent, "perf-codex-integration-"));
  const rootReal = realpathSync(root);
  let closed = false;
  const close = () => {
    if (closed) return;
    assert.equal(path.dirname(root), tempParent);
    assert.ok(path.basename(root).startsWith("perf-codex-integration-"));
    if (existsSync(root)) {
      assert.equal(realpathSync(root), rootReal, "refuse cleanup of a replaced/symlinked Codex fixture root");
      rmSync(root, { recursive: true, force: true });
    }
    closed = true;
  };
  const codexHome = path.join(root, "codex-fixture");
  const threadId = "fixture-codex-thread";
  const base = Date.parse("2026-10-04T12:00:00.000Z");
  const rows = [[], [], []];
  const timingRecords = [];
  const timingByThreadResponse = new Map();
  const timingKey = (threadId, responseId) => `${threadId}\u0000${responseId}`;
  const registerTiming = (record) => {
    timingByThreadResponse.set(timingKey(threadId, record.responseId), record);
    return record;
  };
  for (const rolloutRows of rows) {
    rolloutRows.push({ type: "session_meta", payload: { id: threadId, source: "vscode" } });
  }
  for (let turn = 1; turn <= 25; turn++) {
    const turnId = `turn-${String(turn).padStart(2, "0")}`;
    rows[0].push({
      type: "turn_context",
      payload: { thread_id: threadId, turn_id: turnId, model: "codex-fixture-model", effort: "high" },
    });
    const requestRollout = turn <= 9 ? 0 : turn <= 18 ? 1 : 2;
    const requestOutputs = turn === 25 ? [60, 64] : [99 + turn];
    let cumulativeOutput = 0;
    for (const [requestIndex, outputTokens] of requestOutputs.entries()) {
      cumulativeOutput += outputTokens;
      const responseId = `response-${turn}-${requestIndex + 1}`;
      rows[requestRollout].push({
        type: "token_usage_record",
        timestamp: new Date(base + turn * 10000 + 2500 + requestIndex * 1000).toISOString(),
        payload: {
          thread_id: threadId,
          turn_id: turnId,
          response_id: responseId,
          usage: { output_tokens: outputTokens },
          turn_token_usage: { output_tokens: cumulativeOutput },
        },
      });
      const timing = {
        schemaVersion: 1,
        evidenceOrigin: "fixture@1",
        responseId,
        requestedModel: "codex-fixture-model",
        reportedOutputTokens: outputTokens,
        durationMs: turn === 25 ? 200000 : 1000,
        status: "completed",
        completedAtMs: null,
      };
      timingRecords.push(registerTiming(timing));
    }
    const itemRollout = turn <= 18 ? 1 : 2;
    const startedAtMs = base + turn * 10000;
    const durationMs = turn === 25 ? 400000 : 1000;
    rows[itemRollout].push({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: threadId,
        turn_id: turnId,
        started_at_ms: startedAtMs,
        completed_at_ms: startedAtMs + durationMs,
        item: { id: `item-${turn}`, type: "AgentMessage" },
      },
    });
    rows[2].push({
      type: "event_msg",
      payload: {
        type: "task_complete",
        thread_id: threadId,
        turn_id: turnId,
        started_at: Math.floor(startedAtMs / 1000),
        completed_at: Math.floor((startedAtMs + durationMs) / 1000),
        duration_ms: durationMs,
      },
    });
  }

  const manifest = { threadId, model: "codex-fixture-model", rolloutRows: rows };
  try {
    rows.forEach((rolloutRows, index) => {
      const directory = path.join(codexHome, "sessions", "fixture", threadId);
      const file = path.join(directory, `rollout-${index + 1}.jsonl`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, `${rolloutRows.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      utimesSync(file, base / 1000, base / 1000);
    });
    const reportOptions = {
      homeDir: root,
      env: {},
      extraHomes: codexHome,
      importDirs: [],
      automaticDiscoveryEnabled: false,
      pricingRefreshSchedulerEnabled: false,
      lookupRequestTiming(query) {
        const timing = timingByThreadResponse.get(timingKey(query.threadId, query.responseId));
        return timing
          ? {
              state: "available",
              durationMs: timing.durationMs,
              reportedOutputTokens: timing.reportedOutputTokens,
              requestedModel: timing.requestedModel,
            }
          : { state: "missing", durationMs: null, reportedOutputTokens: null, requestedModel: "" };
      },
    };
    const registerThreadTiming = (targetThreadId, responsePrefix, records = timingRecords) => {
      const registered = records.map((record) => ({
        ...record,
        responseId: `${responsePrefix}${record.responseId}`,
      }));
      for (const record of registered) {
        timingByThreadResponse.set(timingKey(targetThreadId, record.responseId), record);
      }
      return registered;
    };
    const addRequestTiming = (targetThreadId, record) => {
      timingByThreadResponse.set(timingKey(targetThreadId, record.responseId), record);
      return record;
    };
    const seedRequestTiming = async (store, records = timingRecords) => {
      const home = store.homes.find((candidate) => path.resolve(candidate.path) === path.resolve(codexHome));
      assert.ok(home, "fixture must discover the Codex home before timing evidence can be imported");
      store.importRequestTimingEvidence({
        homeId: String(home.id),
        records,
        reviewedOrigins: ["fixture@1"],
      });
      await store.sync({ options: reportOptions });
    };
    return {
      reportOptions,
      timingRecords,
      registerThreadTiming,
      addRequestTiming,
      seedRequestTiming,
      codexHome,
      serverOptions: {
        ...reportOptions,
        databaseFile: path.join(root, "api-index.sqlite"),
        importStoreFile: path.join(root, "imports.json"),
      },
      expected: {
        model: "codex-fixture-model",
        agentKind: "unknown",
        timingKind: "request_e2e",
        tokenScope: "reported_output_includes_reasoning",
        n: 25,
        rank: 1,
        tps: { p10: 101, p50: 111, p90: 121, pooled: (2800 * 1000) / 424000 },
        durationMs: { p50: 1000, p90: 1000 },
        sums: { outputTokens: 2800, durationMs: 424000 },
        coverage: {
          eligible: 25,
          positiveOutput: 25,
          timedPositiveOutput: 25,
          completeTimedPositiveOutput: 25,
          sampled: 25,
          dropped: 0,
          pending: 0,
          unplaced: 0,
          timingRate: 1,
          completeTimingRate: 1,
          sampleRate: 1,
        },
      },
      fixtureHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
      rolloutFiles: rows.map((_, index) =>
        path.join(codexHome, "sessions", "fixture", threadId, `rollout-${index + 1}.jsonl`),
      ),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
