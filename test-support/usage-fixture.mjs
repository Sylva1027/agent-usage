import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";

// Independent literal oracle. Product readers and normalizers are intentionally not imported.
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
const FIXTURE_NOW = "2026-10-04T13:00:00.000Z";

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

const ZCODE_USAGE = {
  eventCount: 34,
  totals: { total: 3495, input: 340, cached: 0, output: 3155, reasoning: 0 },
};
const DSH_USAGE = {
  eventCount: 40,
  totals: { total: 3955, input: 400, cached: 0, output: 3555, reasoning: 0 },
};
const ALL_SOURCES_USAGE = {
  eventCount: 45,
  totals: { total: 5415, input: 400, cached: 0, output: 5015, reasoning: 130 },
};

/** Fixed, disposable source data. Indexes are created by the real store/server, never preseeded. */
export function createUsageIntegrationFixture({ sources = ["zcode"] } = {}) {
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
  const root = mkdtempSync(path.join(tempParent, "usage-integration-"));
  const rootReal = realpathSync(root);
  let closed = false;
  const close = () => {
    if (closed) return;
    assert.equal(path.dirname(root), tempParent);
    assert.ok(path.basename(root).startsWith("usage-integration-"));
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
      now: FIXTURE_NOW,
      sources: [...sources],
      physicalRows: sources.includes("opencode") ? 62 : sources.includes("dsh") ? 57 : 35,
      usage: structuredClone(
        sources.includes("opencode") ? ALL_SOURCES_USAGE : sources.includes("dsh") ? DSH_USAGE : ZCODE_USAGE,
      ),
    };
    return {
      reportOptions,
      serverOptions: {
        ...reportOptions,
        databaseFile: path.join(root, "api-index.sqlite"),
        importStoreFile: path.join(root, "imports.json"),
      },
      expected,
      fixtureHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

/** Fixed Codex rollout identities; tests append their own explicit usage events. */
export function createCodexIntegrationFixture() {
  const tempParent = realpathSync(tmpdir());
  const root = mkdtempSync(path.join(tempParent, "codex-integration-"));
  const rootReal = realpathSync(root);
  let closed = false;
  const close = () => {
    if (closed) return;
    assert.equal(path.dirname(root), tempParent);
    assert.ok(path.basename(root).startsWith("codex-integration-"));
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
  for (const rolloutRows of rows) {
    rolloutRows.push({
      type: "session_meta",
      payload: { id: threadId, source: "vscode", cwd: root },
    });
  }
  for (let turn = 1; turn <= 25; turn++) {
    const turnId = `turn-${String(turn).padStart(2, "0")}`;
    rows[0].push({
      type: "turn_context",
      payload: { thread_id: threadId, turn_id: turnId, model: "codex-fixture-model", effort: "high" },
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
    };
    return {
      reportOptions,
      codexHome,
      serverOptions: {
        ...reportOptions,
        databaseFile: path.join(root, "api-index.sqlite"),
        importStoreFile: path.join(root, "imports.json"),
      },
      expected: {
        now: FIXTURE_NOW,
        threadId,
        model: "codex-fixture-model",
        usage: {
          eventCount: 0,
          sessionCount: 0,
          totals: { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
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
