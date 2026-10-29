/**
 * Isolated persistence for normalized Codex request timing evidence.
 *
 * C0 keeps this adapter off the production schema. The caller supplies the
 * SQLite connection and explicit native request links; no file discovery,
 * gateway access, body storage, or model/time inference happens here.
 */

import {
  generationMatchesKnownReasoning,
  mergeRequestTimingEvidence,
  normalizeGenerationTiming,
  normalizeRequestTimingEvidence,
} from "./perf-request-timing.js";

const META_TABLE = "perf_request_timing_meta";
const EVIDENCE_TABLE = "perf_request_timing_evidence";
const THREAD_TABLE = "perf_request_timing_threads";
const DIRTY_TABLE = "perf_request_timing_dirty_threads";

/** @typedef {import("./perf-request-timing.js").GenerationTiming} GenerationTiming */
/**
 * @typedef {object} RequestTimingLookup
 * @property {"missing" | "available" | "conflict"} state
 * @property {number | null} durationMs
 * @property {number | null} reportedOutputTokens
 * @property {string} requestedModel
 * @property {GenerationTiming | null} generation
 */

function evidenceTableSql(table = EVIDENCE_TABLE) {
  return `
  CREATE TABLE ${table} (
    home_id TEXT NOT NULL CHECK (length(home_id) > 0),
    evidence_origin TEXT NOT NULL CHECK (length(evidence_origin) > 0),
    response_id TEXT NOT NULL CHECK (length(response_id) > 0),
    variant_key TEXT NOT NULL CHECK (length(variant_key) > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
    requested_model TEXT NOT NULL CHECK (length(requested_model) > 0),
    reported_output_tokens INTEGER NOT NULL CHECK (reported_output_tokens >= 0),
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    status TEXT NOT NULL CHECK (status = 'completed'),
    completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= 0),
    generation_json TEXT,
    PRIMARY KEY (home_id, evidence_origin, response_id, variant_key)
  ) STRICT;`;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ${META_TABLE} (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0)
  ) STRICT;
  INSERT INTO ${META_TABLE} (singleton, revision)
  SELECT 1, 0
  WHERE NOT EXISTS (SELECT 1 FROM ${META_TABLE} WHERE singleton = 1);

  CREATE TABLE IF NOT EXISTS ${EVIDENCE_TABLE} (
    home_id TEXT NOT NULL CHECK (length(home_id) > 0),
    evidence_origin TEXT NOT NULL CHECK (length(evidence_origin) > 0),
    response_id TEXT NOT NULL CHECK (length(response_id) > 0),
    variant_key TEXT NOT NULL CHECK (length(variant_key) > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version IN (1, 2)),
    requested_model TEXT NOT NULL CHECK (length(requested_model) > 0),
    reported_output_tokens INTEGER NOT NULL CHECK (reported_output_tokens >= 0),
    duration_ms INTEGER NOT NULL CHECK (duration_ms > 0),
    status TEXT NOT NULL CHECK (status = 'completed'),
    completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= 0),
    generation_json TEXT,
    PRIMARY KEY (home_id, evidence_origin, response_id, variant_key)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS ${THREAD_TABLE} (
    home_id TEXT NOT NULL CHECK (length(home_id) > 0),
    response_id TEXT NOT NULL CHECK (length(response_id) > 0),
    thread_id TEXT NOT NULL CHECK (length(thread_id) > 0),
    PRIMARY KEY (home_id, response_id, thread_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS ${DIRTY_TABLE} (
    home_id TEXT NOT NULL CHECK (length(home_id) > 0),
    thread_id TEXT NOT NULL CHECK (length(thread_id) > 0),
    PRIMARY KEY (home_id, thread_id)
  ) STRICT;

`;

let savepointCounter = 0;

function timingError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireDatabase(database) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("A SQLite DatabaseSync connection is required");
  }
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw timingError("REQUEST_TIMING_INVALID_INPUT", `${field} must be a non-empty string`);
  }
  return value;
}

function normalizedEvidence(record) {
  try {
    return normalizeRequestTimingEvidence(record);
  } catch (error) {
    if (isRecord(error) && error.code === "REQUEST_TIMING_INVALID_INPUT") {
      throw timingError("REQUEST_TIMING_INVALID_INPUT", String(error.message));
    }
    throw error;
  }
}

function evidenceVariantKey(record) {
  // Origin and identity are primary-key columns. Every other normative value is
  // part of the variant, so conflicting observations are retained side by side.
  const values = [
    record.schemaVersion,
    record.requestedModel,
    record.reportedOutputTokens,
    record.durationMs,
    record.status,
    record.completedAtMs,
  ];
  if (record.schemaVersion === 2) values.push(record.generation ?? null);
  return JSON.stringify(values);
}

function generationJson(record) {
  return record.generation === null || record.generation === undefined ? null : JSON.stringify(record.generation);
}

function tableExists(database, name) {
  return (
    database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
  );
}

function tableColumns(database, name) {
  return database
    .prepare(`PRAGMA table_info(${name})`)
    .all()
    .map((row) => String(row.name));
}

const EXPECTED_COLUMNS = Object.freeze([
  [META_TABLE, ["singleton", "revision"]],
  [
    EVIDENCE_TABLE,
    [
      "home_id",
      "evidence_origin",
      "response_id",
      "variant_key",
      "schema_version",
      "requested_model",
      "reported_output_tokens",
      "duration_ms",
      "status",
      "completed_at_ms",
      "generation_json",
    ],
  ],
  [THREAD_TABLE, ["home_id", "response_id", "thread_id"]],
  [DIRTY_TABLE, ["home_id", "thread_id"]],
]);

function assertSchema(database) {
  for (const [table, expectedColumns] of EXPECTED_COLUMNS) {
    const actualColumns = tableColumns(database, table);
    if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
      throw timingError(
        "REQUEST_TIMING_SCHEMA_MISMATCH",
        `${table} columns ${actualColumns.join(",")} do not match the timing contract`,
      );
    }
    const ddl = String(
      database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)?.sql ?? "",
    );
    if (!ddl.includes("STRICT")) {
      throw timingError("REQUEST_TIMING_SCHEMA_MISMATCH", `${table} is not a STRICT table`);
    }
  }
}

function migrateEvidenceTable(database) {
  const columns = tableColumns(database, EVIDENCE_TABLE);
  const ddl = String(
    database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(EVIDENCE_TABLE)?.sql ?? "",
  );
  if (columns.includes("generation_json") && !/schema_version\s*=\s*1/i.test(ddl)) return;

  const temporaryTable = `${EVIDENCE_TABLE}_v2`;
  const generationSelect = columns.includes("generation_json") ? "generation_json" : "NULL";
  database.exec(`
    DROP INDEX IF EXISTS perf_request_timing_evidence_response;
    DROP TABLE IF EXISTS ${temporaryTable};
    ALTER TABLE ${EVIDENCE_TABLE} RENAME TO ${temporaryTable};
    ${evidenceTableSql()}
    INSERT INTO ${EVIDENCE_TABLE}
      (home_id, evidence_origin, response_id, variant_key, schema_version,
       requested_model, reported_output_tokens, duration_ms, status, completed_at_ms, generation_json)
    SELECT home_id, evidence_origin, response_id, variant_key, schema_version,
           requested_model, reported_output_tokens, duration_ms, status, completed_at_ms, ${generationSelect}
    FROM ${temporaryTable};
    DROP TABLE ${temporaryTable};
  `);
}

function ensureSchema(database) {
  database.exec(SCHEMA_SQL);
  migrateEvidenceTable(database);
  const index = "perf_request_timing_evidence_response";
  if (database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index) === undefined) {
    database.exec(`CREATE INDEX ${index} ON ${EVIDENCE_TABLE} (home_id, response_id); ANALYZE ${index}`);
  }
  assertSchema(database);
}

function storedRevision(database) {
  if (!tableExists(database, META_TABLE)) return 0;
  const row = database.prepare(`SELECT revision FROM ${META_TABLE} WHERE singleton = 1`).get();
  if (row === undefined) {
    throw timingError("REQUEST_TIMING_STORE_CORRUPT", `${META_TABLE} has no revision row`);
  }
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw timingError("REQUEST_TIMING_STORE_CORRUPT", "Timing revision is not a non-negative safe integer");
  }
  return revision;
}

export function validateStoredEvidence(row) {
  const schemaVersion = Number(row.schema_version);
  const reportedOutputTokens = Number(row.reported_output_tokens);
  const durationMs = Number(row.duration_ms);
  const completedAtMs = row.completed_at_ms === null ? null : Number(row.completed_at_ms);
  if (
    (schemaVersion !== 1 && schemaVersion !== 2) ||
    typeof row.evidence_origin !== "string" ||
    row.evidence_origin === "" ||
    typeof row.requested_model !== "string" ||
    row.requested_model === "" ||
    row.status !== "completed" ||
    !Number.isSafeInteger(reportedOutputTokens) ||
    reportedOutputTokens < 0 ||
    !Number.isSafeInteger(durationMs) ||
    durationMs <= 0 ||
    (completedAtMs !== null && (!Number.isSafeInteger(completedAtMs) || completedAtMs < 0))
  ) {
    throw timingError("REQUEST_TIMING_STORE_CORRUPT", "Stored request timing evidence is invalid");
  }

  let generation = null;
  if (schemaVersion === 2) {
    if (row.generation_json !== null && row.generation_json !== undefined) {
      let raw;
      try {
        raw = JSON.parse(String(row.generation_json));
      } catch {
        throw timingError("REQUEST_TIMING_STORE_CORRUPT", "Stored generation timing is not valid JSON");
      }
      try {
        generation = normalizeGenerationTiming(raw);
      } catch {
        throw timingError("REQUEST_TIMING_STORE_CORRUPT", "Stored generation timing is invalid");
      }
      if (
        generation !== null &&
        (generation.outputTokens > reportedOutputTokens || generation.durationMs > durationMs)
      ) {
        throw timingError("REQUEST_TIMING_STORE_CORRUPT", "Stored generation timing exceeds its request totals");
      }
    }
  } else if (row.generation_json !== null && row.generation_json !== undefined) {
    throw timingError("REQUEST_TIMING_STORE_CORRUPT", "Stored v1 request timing evidence contains generation data");
  }
  return { requestedModel: row.requested_model, reportedOutputTokens, durationMs, generation };
}

/** @returns {RequestTimingLookup} */
function missingLookup() {
  return {
    state: "missing",
    durationMs: null,
    reportedOutputTokens: null,
    requestedModel: "",
    generation: null,
  };
}

/** @returns {RequestTimingLookup} */
function conflictLookup() {
  return {
    state: "conflict",
    durationMs: null,
    reportedOutputTokens: null,
    requestedModel: "",
    generation: null,
  };
}

/**
 * Import one explicit batch of normalized evidence plus its native request-to-
 * thread links. Exact duplicates are idempotent; conflicting values remain
 * stored and later resolve as a conflict. Any failure rolls back the entire
 * batch, including schema creation.
 *
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {{homeId: string, records: object[], requestLinks: Array<{responseId: string, threadId: string}>}} input
 * @returns {{revision: number, changed: boolean, affectedThreadIds: string[]}}
 */
export function importRequestTimingEvidence(database, input) {
  requireDatabase(database);
  if (!isRecord(input)) throw new TypeError("Timing import input must be an object");
  const homeId = requiredString(input.homeId, "homeId");
  if (!Array.isArray(input.records) || !Array.isArray(input.requestLinks)) {
    throw new TypeError("Timing import requires records and requestLinks arrays");
  }

  const records = input.records.map(normalizedEvidence);
  if (records.length === 0) {
    savepointCounter += 1;
    const savepoint = `perf_request_timing_import_${savepointCounter}`;
    database.exec(`SAVEPOINT ${savepoint}`);
    try {
      ensureSchema(database);
      const revision = storedRevision(database);
      database.exec(`RELEASE ${savepoint}`);
      return { revision, changed: false, affectedThreadIds: [] };
    } catch (error) {
      try {
        database.exec(`ROLLBACK TO ${savepoint}`);
      } catch {
        // The original failure remains authoritative.
      }
      try {
        database.exec(`RELEASE ${savepoint}`);
      } catch {
        // Same as above.
      }
      throw error;
    }
  }

  const responseIds = new Set(records.map((record) => record.responseId));
  /** @type {Map<string, Set<string>>} */
  const threadsByResponse = new Map();
  for (const link of input.requestLinks) {
    if (!isRecord(link)) throw new TypeError("Timing request links must be objects");
    const responseId = requiredString(link.responseId, "requestLinks.responseId");
    const threadId = requiredString(link.threadId, "requestLinks.threadId");
    if (!responseIds.has(responseId)) continue;
    const threadIds = threadsByResponse.get(responseId) ?? new Set();
    threadIds.add(threadId);
    threadsByResponse.set(responseId, threadIds);
  }
  for (const responseId of responseIds) {
    const threadIds = threadsByResponse.get(responseId);
    if (!threadIds || threadIds.size === 0) {
      throw timingError("REQUEST_TIMING_LINK_MISSING", `No native thread link for response ${responseId}`);
    }
    if (threadIds.size > 1) {
      throw timingError("REQUEST_TIMING_THREAD_CONFLICT", `Response ${responseId} maps to multiple native threads`);
    }
  }

  savepointCounter += 1;
  const savepoint = `perf_request_timing_import_${savepointCounter}`;
  database.exec(`SAVEPOINT ${savepoint}`);
  try {
    ensureSchema(database);
    const insertEvidence = database.prepare(`
      INSERT INTO ${EVIDENCE_TABLE}
        (home_id, evidence_origin, response_id, variant_key, schema_version,
         requested_model, reported_output_tokens, duration_ms, status, completed_at_ms, generation_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(home_id, evidence_origin, response_id, variant_key) DO NOTHING
    `);
    const insertThread = database.prepare(`
      INSERT INTO ${THREAD_TABLE} (home_id, response_id, thread_id)
      VALUES (?, ?, ?)
      ON CONFLICT(home_id, response_id, thread_id) DO NOTHING
    `);
    const existingThreads = database.prepare(`
      SELECT thread_id
      FROM ${THREAD_TABLE}
      WHERE home_id = ? AND response_id = ?
      ORDER BY thread_id
    `);
    for (const [responseId, threadIds] of threadsByResponse) {
      const incomingThreadId = [...threadIds][0];
      const stored = existingThreads.all(homeId, responseId);
      if (stored.length > 1) {
        throw timingError("REQUEST_TIMING_STORE_CORRUPT", `Response ${responseId} has multiple native thread links`);
      }
      if (stored.length === 1 && String(stored[0].thread_id) !== incomingThreadId) {
        throw timingError(
          "REQUEST_TIMING_THREAD_CONFLICT",
          `Response ${responseId} is already linked to another native thread`,
        );
      }
    }
    const changedResponseIds = new Set();
    for (const record of records) {
      const result = insertEvidence.run(
        homeId,
        record.evidenceOrigin,
        record.responseId,
        evidenceVariantKey(record),
        record.schemaVersion,
        record.requestedModel,
        record.reportedOutputTokens,
        record.durationMs,
        record.status,
        record.completedAtMs,
        generationJson(record),
      );
      if (Number(result.changes) > 0) changedResponseIds.add(record.responseId);
    }
    for (const [responseId, threadIds] of threadsByResponse) {
      const threadId = [...threadIds][0];
      const result = insertThread.run(homeId, responseId, threadId);
      if (Number(result.changes) > 0) changedResponseIds.add(responseId);
    }

    let revision = storedRevision(database);
    const changed = changedResponseIds.size > 0;
    if (changed) {
      if (revision === Number.MAX_SAFE_INTEGER) {
        throw timingError("REQUEST_TIMING_STORE_CORRUPT", "Timing revision overflow");
      }
      const result = database.prepare(`UPDATE ${META_TABLE} SET revision = revision + 1 WHERE singleton = 1`).run();
      if (Number(result.changes) !== 1) {
        throw timingError("REQUEST_TIMING_STORE_CORRUPT", `${META_TABLE} revision row is missing`);
      }
      revision += 1;
    }

    const affectedThreadIds = [
      ...new Set(
        [...changedResponseIds]
          .map((responseId) => [...(threadsByResponse.get(responseId) ?? [])][0])
          .filter((threadId) => typeof threadId === "string" && threadId !== ""),
      ),
    ];
    affectedThreadIds.sort();
    database.exec(`RELEASE ${savepoint}`);
    return { revision, changed, affectedThreadIds };
  } catch (error) {
    try {
      database.exec(`ROLLBACK TO ${savepoint}`);
    } catch {
      // The original failure remains authoritative; close() discards an
      // unrecoverable open transaction.
    }
    try {
      database.exec(`RELEASE ${savepoint}`);
    } catch {
      // Same as above.
    }
    throw error;
  }
}

/**
 * Read timing evidence for one native response. A thread supplied by the
 * caller must match the persisted native link. When model or output is supplied
 * by the native request, the selected evidence must match those values exactly.
 *
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {{homeId: string, threadId?: string, turnId?: string, responseId: string, model?: string | null, outputTokens?: number, reasoningOutputTokens?: number | null}} query
 * @returns {RequestTimingLookup}
 */
export function lookupRequestTiming(database, query) {
  requireDatabase(database);
  if (!isRecord(query)) throw new TypeError("Timing lookup query must be an object");
  const homeId = requiredString(query.homeId, "homeId");
  const responseId = requiredString(query.responseId, "responseId");
  const threadId =
    query.threadId === undefined || query.threadId === "" ? "" : requiredString(query.threadId, "threadId");

  if (!tableExists(database, EVIDENCE_TABLE)) return missingLookup();
  if (!tableExists(database, THREAD_TABLE)) {
    throw timingError("REQUEST_TIMING_STORE_CORRUPT", "Timing evidence exists without a thread mapping table");
  }

  const generationColumn = tableColumns(database, EVIDENCE_TABLE).includes("generation_json")
    ? "generation_json"
    : "NULL AS generation_json";
  const rows = database
    .prepare(`
      SELECT evidence_origin, schema_version, requested_model, reported_output_tokens,
             duration_ms, status, completed_at_ms, ${generationColumn}
      FROM ${EVIDENCE_TABLE}
      WHERE home_id = ? AND response_id = ?
      ORDER BY evidence_origin, variant_key
    `)
    .all(homeId, responseId);
  if (rows.length === 0) return missingLookup();

  const links = database
    .prepare(`SELECT thread_id FROM ${THREAD_TABLE} WHERE home_id = ? AND response_id = ? ORDER BY thread_id`)
    .all(homeId, responseId);
  if (links.length !== 1) {
    throw timingError("REQUEST_TIMING_STORE_CORRUPT", "Each response must have exactly one native thread link");
  }
  if (threadId !== "" && String(links[0].thread_id) !== threadId) return missingLookup();

  const evidence = rows.map((row) => {
    const variant = validateStoredEvidence(row);
    return {
      schemaVersion: Number(row.schema_version),
      evidenceOrigin: String(row.evidence_origin),
      responseId,
      requestedModel: variant.requestedModel,
      reportedOutputTokens: variant.reportedOutputTokens,
      durationMs: variant.durationMs,
      status: "completed",
      completedAtMs: row.completed_at_ms === null ? null : Number(row.completed_at_ms),
      ...(Number(row.schema_version) === 2 ? { generation: variant.generation } : {}),
    };
  });
  const merged = mergeRequestTimingEvidence(evidence);
  if (merged.state !== "available" || merged.evidence === null) return conflictLookup();
  if (
    query.model !== undefined &&
    query.model !== null &&
    query.model !== "" &&
    (typeof query.model !== "string" || merged.evidence.requestedModel !== query.model)
  ) {
    return conflictLookup();
  }
  if (
    query.outputTokens !== undefined &&
    (!Number.isSafeInteger(query.outputTokens) ||
      query.outputTokens < 0 ||
      merged.evidence.reportedOutputTokens !== query.outputTokens)
  ) {
    return conflictLookup();
  }
  if (
    !generationMatchesKnownReasoning(
      merged.evidence.generation ?? null,
      merged.evidence.reportedOutputTokens,
      query.reasoningOutputTokens,
    )
  ) {
    return conflictLookup();
  }
  return {
    state: "available",
    durationMs: merged.evidence.durationMs,
    reportedOutputTokens: merged.evidence.reportedOutputTokens,
    requestedModel: merged.evidence.requestedModel,
    generation: merged.evidence.generation ?? null,
  };
}

/**
 * Read the durable evidence revision without creating any table.
 *
 * @param {import("node:sqlite").DatabaseSync} database
 * @returns {number}
 */
export function readRequestTimingRevision(database) {
  requireDatabase(database);
  return storedRevision(database);
}
