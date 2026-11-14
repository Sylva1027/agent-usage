import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pricingVersionForTimestamp } from "./pricing.js";
import { createRepositoryResolver } from "./repository-identity.js";
import { UsageSourceRows } from "./usage-source-rows.js";
import { sqliteSourceStat } from "./sqlite-source-stat.js";
import {
  USAGE_DETAIL_INCONSISTENT,
  USAGE_DETAIL_MASK,
  isZeroUsage,
  validateUsageDetails,
} from "../public/usage-fields.js";

const IDENTITY = ["session_id", "model", "billing_provider", "billing_base_url", "billing_mode", "task"];
const COUNTS = ["input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens", "reasoning_tokens"];
const SESSION_META = ["source", "cwd", "git_repo_root", "last_activity_at", "started_at"];

function columns(database, table) {
  return database.prepare(`PRAGMA table_info(${table})`).all();
}

function schema(database) {
  const sessions = columns(database, "sessions");
  const sessionColumns = new Set(sessions.map((row) => row.name));
  if (!["id", "source", "started_at", "input_tokens", "output_tokens"].every((name) => sessionColumns.has(name))) {
    throw new Error("Unsupported Hermes sessions schema");
  }
  const modelRows = columns(database, "session_model_usage");
  const modelColumns = new Set(modelRows.map((row) => row.name));
  if (modelRows.length) {
    if (!["session_id", "model", "input_tokens", "output_tokens"].every((name) => modelColumns.has(name))) {
      throw new Error("Unsupported Hermes model usage schema");
    }
    const key = modelRows
      .filter((row) => row.pk)
      .sort((a, b) => a.pk - b.pk)
      .map((row) => row.name);
    if (![5, 6].includes(key.length) || key.some((name, index) => name !== IDENTITY[index])) {
      throw new Error("Unsupported Hermes model usage identity");
    }
  }
  return { sessionColumns, modelColumns };
}

function projection(alias, names, available, prefix = "") {
  return names.map((name) => `${available.has(name) ? `${alias}."${name}"` : "NULL"} AS "${prefix}${name}"`).join(", ");
}

export async function hermesDatabaseFile(homePath) {
  const file = path.join(homePath, "state.db");
  try {
    if ((await stat(file)).isFile()) return file;
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
  }
  return "";
}

export async function hermesHomeLooksUsable(homePath, options = {}) {
  const file = await hermesDatabaseFile(homePath);
  if (!file) return false;
  let database;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    database.exec("PRAGMA query_only=ON");
    schema(database);
    return true;
  } catch (error) {
    options.onError?.(error);
    return false;
  } finally {
    database?.close();
  }
}

function count(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid Hermes token count");
  }
  return value;
}

function normalize(row, source, kind, identity) {
  const [input, cached, write, output, reasoning] = COUNTS.map((field) => count(row[field]));
  const usage = { input: input + cached + write, cached, output, reasoning, total: input + cached + write + output };
  if (!Number.isSafeInteger(usage.total)) throw new Error("Invalid Hermes token total");
  if (isZeroUsage(usage)) return null;
  const mask =
    (input && cached && write ? USAGE_DETAIL_MASK.input : 0) |
    (cached ? USAGE_DETAIL_MASK.cached : 0) |
    (output ? USAGE_DETAIL_MASK.output : 0) |
    (reasoning ? USAGE_DETAIL_MASK.reasoning : 0);
  let { detailMask, reconciliationGap } = validateUsageDetails(usage, mask);
  if (reasoning > output && detailMask & USAGE_DETAIL_MASK.reasoning) {
    detailMask = (detailMask & ~USAGE_DETAIL_MASK.reasoning) | USAGE_DETAIL_INCONSISTENT;
    reconciliationGap += reasoning - output;
  }
  const timestampMs = [row.last_seen, row.first_seen, row.session_last_activity_at, row.session_started_at]
    .map((value) => (value === null || value === undefined ? NaN : Math.trunc(Number(value) * 1000)))
    .find((value) => Number.isSafeInteger(value) && value > 0 && Number.isFinite(new Date(value).getTime()));
  if (timestampMs === undefined) throw new Error("Hermes usage has no valid timestamp");
  const sessionId = String(row.session_id ?? "");
  if (!sessionId) throw new Error("Hermes usage has no session identity");
  const digest = createHash("sha256")
    .update(JSON.stringify([source.id, kind, identity]))
    .digest("hex");
  const sourceEventId = `hermes:${kind}:v1:${digest}`;
  return {
    eventId: sourceEventId,
    sourceEventId,
    timestampMs,
    timestamp: new Date(timestampMs).toISOString(),
    sessionId,
    homeId: source.id,
    homeLabel: source.label,
    homePath: source.path,
    channel: row.session_source === "subagent" ? "Hermes Subagent" : "Hermes",
    source: "hermes",
    sourceKind: "hermes",
    project: String(row.session_git_repo_root || row.session_cwd || "").trim(),
    model: kind === "session" ? "Unknown model" : String(row.model || "").trim() || "Unknown model",
    usage,
    detailMask,
    reconciliationGap,
    cacheWriteTokens: write,
    cacheWriteKnown: write > 0,
    requestInputTokens: 0,
    contextLevel: "unknown",
    serviceTier: "unknown",
    priceVersion: pricingVersionForTimestamp(new Date(timestampMs).toISOString()),
  };
}

export async function streamHermesDbEvents(dbFile, source, onEvent, options = {}) {
  const rows = new UsageSourceRows(options.maxBytes);
  const repositories = new UsageSourceRows(options.maxBytes);
  const warnings = new UsageSourceRows(options.maxBytes);
  let database;
  try {
    const before = await sqliteSourceStat(dbFile);
    database = new DatabaseSync(dbFile, { readOnly: true });
    database.exec("PRAGMA query_only=ON");
    const dataVersion = database.prepare("PRAGMA data_version").get().data_version;
    database.exec("BEGIN");
    const { sessionColumns, modelColumns } = schema(database);
    const meta = projection("s", SESSION_META, sessionColumns, "session_");
    if (modelColumns.size) {
      const fields = projection("u", [...IDENTITY, ...COUNTS, "first_seen", "last_seen"], modelColumns);
      for (const row of database
        .prepare(`SELECT ${fields}, ${meta} FROM session_model_usage u LEFT JOIN sessions s ON s.id=u.session_id
          ORDER BY ${IDENTITY.filter((field) => modelColumns.has(field))
            .map((field) => `u.${field}`)
            .join(",")}`)
        .iterate()) {
        const identity = IDENTITY.map((field) => (modelColumns.has(field) ? [true, row[field]] : [false]));
        const event = normalize(row, source, "model", identity);
        if (event) {
          if (rows.has(event.sourceEventId)) throw new Error("Duplicate Hermes usage identity");
          rows.set(event.sourceEventId, event);
        }
      }
      if (options.onWarning) {
        const shared = [...COUNTS, "api_call_count"].filter(
          (field) => sessionColumns.has(field) && modelColumns.has(field),
        );
        const totals = shared
          .map((field) => `CASE WHEN COUNT(${field})=COUNT(*) THEN SUM(${field}) END AS "${field}"`)
          .join(",");
        const fields = shared
          .map((field) => `s.${field} AS "session_${field}", u.${field} AS "model_${field}"`)
          .join(",");
        for (const row of database
          .prepare(`SELECT s.id, ${fields} FROM sessions s JOIN
          (SELECT session_id, ${totals} FROM session_model_usage GROUP BY session_id) u ON u.session_id=s.id
          ORDER BY s.id`)
          .iterate()) {
          const differences = shared.flatMap((field) => {
            const session = row[`session_${field}`],
              model = row[`model_${field}`];
            return typeof session !== "number" || typeof model !== "number" || session === model
              ? []
              : [`${field}=${session - model}`];
          });
          if (differences.length)
            warnings.set(
              row.id,
              `Hermes 会话 ${row.id} 账本差额（sessions - session_model_usage）：${differences.join(", ")}；采用模型账本，不补算差额`,
            );
        }
      }
    }
    const fallback = projection("s", COUNTS, sessionColumns);
    const where = modelColumns.size
      ? "WHERE NOT EXISTS (SELECT 1 FROM session_model_usage u WHERE u.session_id=s.id)"
      : "";
    for (const row of database
      .prepare(`SELECT s.id AS session_id, ${fallback}, ${meta} FROM sessions s ${where} ORDER BY s.id`)
      .iterate()) {
      const event = normalize(row, source, "session", [row.session_id]);
      if (event) rows.set(event.sourceEventId, event);
    }
    database.exec("COMMIT");
    const assertStable = async () => {
      const after = await sqliteSourceStat(dbFile);
      if (
        before.sqliteObservation !== after.sqliteObservation ||
        dataVersion !== database.prepare("PRAGMA data_version").get().data_version
      ) {
        throw Object.assign(new Error("Hermes source changed while indexing"), {
          code: "LIVE_SOURCE_CHANGED",
          retryable: true,
        });
      }
    };
    await assertStable();
    for (const warning of warnings.values()) options.onWarning?.(warning);
    for (const event of rows.ordered(
      (a, b) => a - b,
      (event) => event.timestampMs,
    )) {
      let repository = repositories.get(event.project);
      if (!repository) {
        repository = await (options.repositoryResolver || createRepositoryResolver())(event.project);
        repositories.set(event.project, repository);
      }
      await onEvent({
        ...event,
        repositoryKey: repository.key,
        repositoryPath: repository.path,
        repositoryKind: repository.kind,
      });
    }
    await assertStable();
  } finally {
    if (database) {
      if (database.isTransaction) database.exec("ROLLBACK");
      database.close();
    }
    rows.close();
    repositories.close();
    warnings.close();
  }
}

/** Metadata alone cannot certify a mutable ledger; hash the same bounded projection used for import. */
export async function hermesSourceStat(dbFile) {
  const before = await sqliteSourceStat(dbFile);
  const hash = createHash("sha256").update("hermes-snapshot-v1\0");
  await streamHermesDbEvents(
    dbFile,
    { id: "", label: "", path: "" },
    (event) => {
      hash.update(JSON.stringify(event)).update("\n");
    },
    {
      repositoryResolver: async (cwd) => ({ key: cwd, path: cwd, kind: "directory" }),
      onWarning: (warning) => {
        hash.update(JSON.stringify(warning)).update("\n");
      },
    },
  );
  const after = await sqliteSourceStat(dbFile);
  if (before.sqliteObservation !== after.sqliteObservation) {
    throw Object.assign(new Error("Hermes source changed while observing"), {
      code: "LIVE_SOURCE_CHANGED",
      retryable: true,
    });
  }
  return { ...after, contentDigest: hash.digest("hex") };
}
