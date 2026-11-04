import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DAY_MS = 86_400_000;
const WINDOW_MS = 90 * DAY_MS;
const START_MS = Date.parse("2026-08-01T00:00:00.000Z");
const PAGE_SIZE = 4096;
const OPENCODE_CONTENT = "x".repeat(8192);
const TRANSACTION_ROWS = 1024;

const ZCODE_SESSION_SCHEMA = `
  CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workspace_id TEXT,
    parent_id TEXT,
    slug TEXT NOT NULL,
    directory TEXT NOT NULL,
    path TEXT,
    title TEXT NOT NULL,
    version TEXT NOT NULL,
    share_url TEXT,
    summary_additions INTEGER,
    summary_deletions INTEGER,
    summary_files INTEGER,
    summary_diffs TEXT,
    revert TEXT,
    permission TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_compacting INTEGER,
    time_archived INTEGER,
    task_type TEXT NOT NULL DEFAULT 'interactive',
    title_source TEXT NOT NULL DEFAULT 'first_input',
    title_message_id TEXT,
    time_title_updated INTEGER,
    trace_id TEXT,
    time_deleted INTEGER,
    last_outcome TEXT
  );
`;

const ZCODE_MODEL_USAGE_SCHEMA = `
  CREATE TABLE model_usage (
    id TEXT PRIMARY KEY,
    logical_request_id TEXT NOT NULL,
    attempt_index INTEGER NOT NULL DEFAULT 0,
    session_id TEXT NOT NULL,
    turn_id TEXT,
    trace_id TEXT,
    span_id TEXT,
    assistant_message_id TEXT,
    parent_user_message_id TEXT,
    query_source TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    variant TEXT,
    agent TEXT,
    mode TEXT,
    task_type TEXT,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    first_token_at INTEGER,
    completed_at INTEGER,
    duration_ms INTEGER,
    time_to_first_token_ms INTEGER,
    finish_reason TEXT,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens INTEGER NOT NULL DEFAULT 0,
    cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
    cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
    provider_total_tokens INTEGER,
    computed_total_tokens INTEGER NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0, 1)),
    cancelled_by_user INTEGER NOT NULL DEFAULT 0 CHECK(cancelled_by_user IN (0, 1)),
    context_exceeded INTEGER NOT NULL DEFAULT 0 CHECK(context_exceeded IN (0, 1)),
    error_type TEXT,
    error_code TEXT,
    error_message TEXT,
    raw_usage_json TEXT,
    provider_metadata_json TEXT
  );
  CREATE INDEX model_usage_query_source_idx ON model_usage(query_source);
  CREATE INDEX model_usage_session_turn_idx ON model_usage(session_id, turn_id);
  CREATE INDEX model_usage_started_model_idx ON model_usage(started_at, provider_id, model_id);
  CREATE INDEX model_usage_trace_idx ON model_usage(trace_id);
`;

const OPENCODE_SESSION_SCHEMA = `
  CREATE TABLE session_v2 (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    workspace_id TEXT,
    parent_id TEXT,
    fork_session_id TEXT,
    fork_boundary TEXT,
    slug TEXT NOT NULL,
    directory TEXT NOT NULL,
    path TEXT,
    title TEXT,
    version TEXT NOT NULL,
    share_url TEXT,
    summary_additions INTEGER,
    summary_deletions INTEGER,
    summary_files INTEGER,
    summary_diffs TEXT,
    metadata TEXT,
    cost REAL DEFAULT 0 NOT NULL,
    tokens_input INTEGER DEFAULT 0 NOT NULL,
    tokens_output INTEGER DEFAULT 0 NOT NULL,
    tokens_reasoning INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
    tokens_cache_write INTEGER DEFAULT 0 NOT NULL,
    revert TEXT,
    permission TEXT,
    agent TEXT,
    model TEXT,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_idle INTEGER,
    time_viewed INTEGER,
    idle_outcome TEXT,
    time_compacting INTEGER,
    time_archived INTEGER,
    time_suspended INTEGER,
    resume_attempts INTEGER DEFAULT 0 NOT NULL
  );
  CREATE INDEX session_v2_parent_idx ON session_v2(parent_id);
  CREATE INDEX session_v2_project_idx ON session_v2(project_id);
  CREATE INDEX session_v2_time_suspended_idx ON session_v2(time_suspended) WHERE time_suspended IS NOT NULL;
  CREATE INDEX session_v2_workspace_idx ON session_v2(workspace_id);
`;

const OPENCODE_MESSAGE_SCHEMA = `
  CREATE TABLE session_message (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    data TEXT NOT NULL
  );
  CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);
  CREATE INDEX session_message_session_time_created_id_idx ON session_message(session_id, time_created, id);
  CREATE INDEX session_message_session_type_seq_idx ON session_message(session_id, type, seq);
  CREATE INDEX session_message_time_created_idx ON session_message(time_created);
`;

const ZCODE_USAGE_INSERT_COLUMNS = [
  "id",
  "logical_request_id",
  "session_id",
  "query_source",
  "provider_id",
  "model_id",
  "task_type",
  "status",
  "started_at",
  "completed_at",
  "duration_ms",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "provider_total_tokens",
  "computed_total_tokens",
];
const ZCODE_USAGE_INSERT = `
  INSERT INTO model_usage (${ZCODE_USAGE_INSERT_COLUMNS.join(", ")})
  VALUES (${ZCODE_USAGE_INSERT_COLUMNS.map(() => "?").join(", ")})
`;

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length !== 2) {
    throw new TypeError("files must contain exactly one zcode and one opencode source");
  }
  const kinds = new Set();
  const keys = new Set();
  return files.map((file, index) => {
    if (!file || typeof file !== "object") {
      throw new TypeError(`files[${index}] must be an object`);
    }
    if (typeof file.key !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(file.key)) {
      throw new TypeError(`files[${index}].key must be a 1-64 character safe id`);
    }
    if (file.kind !== "zcode" && file.kind !== "opencode") {
      throw new TypeError(`files[${index}].kind must be zcode or opencode`);
    }
    if (keys.has(file.key)) {
      throw new TypeError(`duplicate source key: ${file.key}`);
    }
    if (kinds.has(file.kind)) {
      throw new TypeError(`duplicate source kind: ${file.kind}`);
    }
    keys.add(file.key);
    kinds.add(file.kind);
    return {
      key: file.key,
      kind: file.kind,
      events: positiveInteger(file.events, `files[${index}].events`),
      sourceBytes: positiveInteger(file.sourceBytes, `files[${index}].sourceBytes`),
      sessions: positiveInteger(file.sessions, `files[${index}].sessions`),
    };
  });
}

function timestampAt(index, count) {
  return count === 1 ? START_MS : START_MS + Math.round((index * WINDOW_MS) / (count - 1));
}

function syntheticDirectory(key) {
  return `/synthetic/${key}/project`;
}

function sessionId(kind, key, index) {
  return `${kind}-${key}-session-${String(index + 1).padStart(4, "0")}`;
}

function expectedTotals(eventCount) {
  return {
    total: eventCount * 15,
    input: eventCount * 10,
    cached: eventCount * 2,
    output: eventCount * 5,
    reasoning: eventCount,
  };
}

function openSourceDatabase(filePath) {
  const database = new DatabaseSync(filePath);
  database.exec(`
    PRAGMA page_size = ${PAGE_SIZE};
    PRAGMA journal_mode = OFF;
    PRAGMA synchronous = OFF;
    PRAGMA temp_store = MEMORY;
  `);
  return database;
}

function runTransaction(database, operation) {
  database.exec("BEGIN");
  try {
    operation();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function runBatches(database, count, operation) {
  for (let start = 0; start < count; start += TRANSACTION_ROWS) {
    const end = Math.min(count, start + TRANSACTION_ROWS);
    runTransaction(database, () => {
      for (let index = start; index < end; index += 1) {
        operation(index);
      }
    });
  }
}

function padToBytes(database, targetBytes) {
  const pageSize = Number(database.prepare("PRAGMA page_size").get().page_size);
  const currentPages = Number(database.prepare("PRAGMA page_count").get().page_count);
  const targetPages = Math.ceil(targetBytes / pageSize);
  if (targetPages < currentPages) {
    throw new RangeError(`sourceBytes is too small for generated data: ${targetBytes} < ${currentPages * pageSize}`);
  }
  let pagesToAdd = targetPages - currentPages;
  if (pagesToAdd === 0) {
    return 0;
  }

  // Bounded blobs also work when a 5x/10x source exceeds SQLite's single-value limit.
  const usableBytes = pageSize - 4;
  const minimumLocalBytes = Math.floor(((usableBytes - 12) * 32) / 255) + 4;
  const insert = database.prepare("INSERT INTO fixture_padding (payload) VALUES (zeroblob(?))");
  let rows = 0;
  while (pagesToAdd > 0) {
    const payloadBytes = minimumLocalBytes + Math.min(pagesToAdd, 8192) * usableBytes;
    insert.run(payloadBytes);
    rows += 1;
    pagesToAdd = targetPages - Number(database.prepare("PRAGMA page_count").get().page_count);
  }
  const finalPages = Number(database.prepare("PRAGMA page_count").get().page_count);
  // Final padding insertion can also split b-tree pages; manifests retain actual file bytes.
  if (finalPages < targetPages || finalPages > targetPages + 8) {
    throw new Error(`padding calibration failed: wanted ${targetPages} pages, got ${finalPages}`);
  }
  return rows;
}

async function createZcodeInput(root, source, scale) {
  const relativePath = path.posix.join(".zcode", "cli", "db", "db.sqlite");
  const dbFile = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(dbFile), { recursive: true });
  const eventCount = source.events * scale;
  const directory = syntheticDirectory(source.key);
  const database = openSourceDatabase(dbFile);
  let paddingRows = 0;
  try {
    database.exec(`
      ${ZCODE_SESSION_SCHEMA}
      ${ZCODE_MODEL_USAGE_SCHEMA}
      CREATE INDEX session_parent_idx ON session(parent_id);
      CREATE INDEX session_project_idx ON session(project_id);
      CREATE TABLE fixture_padding (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
    `);
    const insertSession = database.prepare(`
      INSERT INTO session (
        id, project_id, slug, directory, path, title, version, time_created, time_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    runBatches(database, source.sessions, (index) => {
      const id = sessionId("zcode", source.key, index);
      insertSession.run(
        id,
        `synthetic-project-${source.key}`,
        `synthetic-session-${index + 1}`,
        directory,
        directory,
        `Synthetic ZCode session ${index + 1}`,
        "synthetic",
        START_MS,
        START_MS + WINDOW_MS,
      );
    });

    const insertUsage = database.prepare(ZCODE_USAGE_INSERT);
    runBatches(database, eventCount, (index) => {
      const completedAt = timestampAt(index, eventCount);
      const id = `zcode-${source.key}-event-${String(index).padStart(8, "0")}`;
      insertUsage.run(
        id,
        `request-${source.key}-${index}`,
        sessionId("zcode", source.key, index % source.sessions),
        "main_turn",
        "synthetic-zcode",
        "gpt-6-sol",
        "interactive",
        "completed",
        completedAt - 1000,
        completedAt,
        1000,
        10,
        5,
        1,
        0,
        2,
        15,
        15,
      );
    });
    paddingRows = padToBytes(database, source.sourceBytes * scale);
  } finally {
    database.close();
  }
  const physicalBytes = Number((await stat(dbFile)).size);
  return {
    kind: "zcode",
    relativePath,
    eventCount,
    sessionCount: source.sessions,
    sourceBytes: physicalBytes,
    rawRows: eventCount,
    expectedTotals: expectedTotals(eventCount),
    schemaDifferences: {
      readerTables: ["session", "model_usage"],
      omittedNonReaderTables: ["part", "message", "session_entry", "tool_usage", "workflow_*", "dwf_*"],
      syntheticTables: ["fixture_padding"],
      note:
        "Reader-facing tables and indexes retain the captured column shape; non-reader tables, " +
        "foreign keys, and unused triggers are omitted. Padding stays outside model_usage.",
      paddingRows,
    },
  };
}

async function createOpencodeInput(root, source, scale) {
  const relativePath = path.posix.join(".opencode", "opencode.db");
  const dbFile = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(dbFile), { recursive: true });
  const eventCount = source.events * scale;
  const directory = syntheticDirectory(source.key);
  const database = openSourceDatabase(dbFile);
  let paddingRows = 0;
  try {
    database.exec(`
      ${OPENCODE_SESSION_SCHEMA}
      ${OPENCODE_MESSAGE_SCHEMA}
      CREATE TABLE fixture_padding (id INTEGER PRIMARY KEY, payload BLOB NOT NULL);
    `);
    const insertSession = database.prepare(`
      INSERT INTO session_v2 (
        id, project_id, slug, directory, path, title, version, agent, model, time_created, time_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    runBatches(database, source.sessions, (index) => {
      insertSession.run(
        sessionId("opencode", source.key, index),
        `synthetic-project-${source.key}`,
        `synthetic-session-${index + 1}`,
        directory,
        directory,
        `Synthetic OpenCode session ${index + 1}`,
        "2.0.20",
        "synthetic",
        "deepseek-flash",
        START_MS,
        START_MS + WINDOW_MS,
      );
    });

    const insertMessage = database.prepare(`
      INSERT INTO session_message (
        id, session_id, type, seq, time_created, time_updated, data
      ) VALUES (?, ?, 'assistant', ?, ?, ?, ?)
    `);
    runBatches(database, eventCount, (index) => {
      const timestamp = timestampAt(index, eventCount);
      const data = JSON.stringify({
        time: { created: timestamp, completed: timestamp },
        agent: "synthetic",
        model: { id: "deepseek-flash", providerID: "synthetic-opencode" },
        tokens: {
          input: 8,
          output: 4,
          reasoning: 1,
          cache: { read: 2, write: 0 },
        },
        cost: 0,
        content: [{ type: "text", text: OPENCODE_CONTENT }],
      });
      insertMessage.run(
        `opencode-${source.key}-message-${String(index).padStart(8, "0")}`,
        sessionId("opencode", source.key, index % source.sessions),
        index + 1,
        timestamp,
        timestamp,
        data,
      );
    });
    paddingRows = padToBytes(database, source.sourceBytes * scale);
  } finally {
    database.close();
  }
  const physicalBytes = Number((await stat(dbFile)).size);
  return {
    kind: "opencode",
    relativePath,
    eventCount,
    sessionCount: source.sessions,
    sourceBytes: physicalBytes,
    rawRows: eventCount,
    expectedTotals: expectedTotals(eventCount),
    schemaDifferences: {
      readerTables: ["session_v2", "session_message"],
      omittedNonReaderTables: ["project", "kv", "instruction_blob", "credential", "migration", "workspace"],
      syntheticTables: ["fixture_padding"],
      note:
        "Reader-facing v2 tables and indexes retain the captured column shape; unused source tables, " +
        "foreign keys, and triggers are omitted. Event JSON content preserves parse load while excess " +
        "bytes stay in fixture_padding.",
      paddingRows,
    },
  };
}

export async function generateSqliteInputs({ root, scale, files } = {}) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new TypeError("root must be a non-empty string");
  }
  const rootPath = path.resolve(root);
  if (!(await stat(rootPath)).isDirectory()) {
    throw new TypeError("root must be an existing directory");
  }
  const normalizedScale = positiveInteger(scale, "scale");
  const normalizedFiles = validateFiles(files);
  const outputs = [];
  for (const source of normalizedFiles) {
    if (
      !Number.isSafeInteger(source.events * normalizedScale) ||
      !Number.isSafeInteger(source.sourceBytes * normalizedScale)
    ) {
      throw new RangeError(`files entry ${source.key} exceeds safe integer range at scale ${scale}`);
    }
    const output =
      source.kind === "zcode"
        ? await createZcodeInput(rootPath, source, normalizedScale)
        : await createOpencodeInput(rootPath, source, normalizedScale);
    outputs.push(output);
  }
  return outputs;
}
