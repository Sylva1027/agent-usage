import { statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const AUTH_TARGET = "feedback_tags";
const REQUEST_TARGET = "codex_http_client::client";
const CODEX_HOME_KINDS = new Set(["main", "jetbrains", "extra", "codex"]);
const QUOTA_SOURCES = new Set(["api", "external", "plan", "credits", "unknown"]);
const SOURCE_RANK = { api: 4, external: 3, plan: 2, unknown: 1 };
// shortcut: nearby thread diagnostics estimate routing; replace this bound when native request linkage is available.
const EVIDENCE_WINDOW_MS = 5 * 60 * 1000;
const REQUEST_LOOKAHEAD_MS = 5 * 1000;
const AUTH_UNQUOTED =
  /(?:^|[\s:])auth_mode=(?:Some\((Chatgpt|ApiKey|OpenaiApiKey)\)|(Chatgpt|ApiKey|OpenaiApiKey))(?=$|[\s,}])/;
const AUTH_QUOTED = /(?:^|[\s:])auth_mode="(Chatgpt|ApiKey|OpenaiApiKey)"(?=$|[\s,}])/;
const RESPONSES_REQUEST = /\bRequest (?:started|completed|failed) method=(?:POST|GET) url=([^\s]+)/;
const cachedLogs = new Map();
const resolverEntries = new WeakMap();

export const QUOTA_SOURCE_EVIDENCE_SNAPSHOT_FORMAT_VERSION = 1;

/**
 * @typedef {"api" | "external" | "plan" | "credits" | "unknown"} QuotaSource
 * @typedef {{ homeId: string, sessionId: string, time: number, source: QuotaSource }} QuotaSourceEvidenceEntry
 * @typedef {{
 *   resolve: (homeId: string, sessionId: string, timestampMs: number, recordedSource?: string) => QuotaSource
 * }} QuotaSourceEvidenceResolver
 * @typedef {{
 *   id: number,
 *   time: number,
 *   threadId: string,
 *   kind: "auth" | "route",
 *   source: QuotaSource,
 *   routeSource?: QuotaSource
 * }} RawQuotaEvidence
 */

function maskQuotedStrings(message) {
  return message.replace(/"(?:\\.|[^"\\])*"/g, (quoted) => " ".repeat(quoted.length));
}

/** @param {string} mode @returns {QuotaSource} */
function authSource(mode) {
  return mode === "Chatgpt" ? "plan" : "api";
}

/** @param {string} target @param {string} message @returns {QuotaSource | null} */
function parseAuth(target, message) {
  if (target !== AUTH_TARGET) return null;
  const masked = maskQuotedStrings(message);
  const unquoted = AUTH_UNQUOTED.exec(masked);
  const mode = unquoted?.[1] || unquoted?.[2] || AUTH_QUOTED.exec(message)?.[1];
  return mode ? authSource(mode) : null;
}

/** @param {string} host */
function isLoopback(host) {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127(?:\.\d{1,3}){3}$/.test(host) ||
    host === "::1" ||
    host === "[::1]"
  );
}

/** @param {string} rawUrl @returns {QuotaSource | null} */
function routeSource(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (isLoopback(host)) return "unknown";
  if (url.protocol === "https:" && host === "api.openai.com" && /^\/v1(?:\/|$)/.test(url.pathname)) {
    return "api";
  }
  if (url.protocol === "https:" && host === "chatgpt.com" && /^\/backend-api\/codex(?:\/|$)/.test(url.pathname)) {
    return "plan";
  }
  return "external";
}

/** @param {string} target @param {string} message @returns {QuotaSource | null} */
function parseResponseRoute(target, message) {
  if (
    target !== REQUEST_TARGET ||
    !message.includes('transport="responses_http"') ||
    !message.includes('api.path="/responses"')
  ) {
    return null;
  }
  const rawUrl = RESPONSES_REQUEST.exec(message)?.[1];
  return rawUrl ? routeSource(rawUrl) : null;
}

/** @param {Record<string, unknown>} row @returns {RawQuotaEvidence | null} */
function parseLogRow(row) {
  const threadId = typeof row.thread_id === "string" ? row.thread_id.trim() : "";
  if (!threadId) return null;
  const seconds = Number(row.ts);
  if (!Number.isFinite(seconds)) return null;
  const nanos = Number(row.ts_nanos || 0);
  const time = seconds * 1000 + (Number.isFinite(nanos) ? Math.floor(nanos / 1_000_000) : 0);
  const target = String(row.target || "");
  const message = String(row.feedback_log_body || "");
  const auth = parseAuth(target, message);
  if (auth) return { id: Number(row.id), time, threadId, kind: "auth", source: auth };
  const route = parseResponseRoute(target, message);
  return route ? { id: Number(row.id), time, threadId, kind: "route", source: route } : null;
}

/** @param {string} filePath @returns {RawQuotaEvidence[]} */
function readQuotaLog(filePath) {
  try {
    if (!statSync(filePath).isFile()) return [];
    const database = new DatabaseSync(filePath, { readOnly: true });
    try {
      const latestId = Number(database.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM logs").get().id);
      const cached = cachedLogs.get(filePath);
      if (cached?.lastId === latestId) return cached.rows;
      const previous = cached && cached.lastId < latestId ? cached : { lastId: 0, rows: [] };
      const rows = [...previous.rows];
      const statement = database.prepare(`
        SELECT id, ts, ts_nanos, thread_id, target, feedback_log_body
        FROM logs
        WHERE id > ? AND thread_id IS NOT NULL AND thread_id <> ''
          AND (
            (target = ? AND feedback_log_body LIKE '%auth_mode%')
            OR (
              target = ?
              AND feedback_log_body LIKE '%transport="responses_http"%'
              AND feedback_log_body LIKE '%api.path="/responses"%'
              AND feedback_log_body LIKE '%url=%'
            )
          )
        ORDER BY id
      `);
      for (const row of statement.iterate(previous.lastId, AUTH_TARGET, REQUEST_TARGET)) {
        const parsed = parseLogRow(row);
        if (parsed) rows.push(parsed);
      }
      cachedLogs.set(filePath, { lastId: latestId, rows });
      return rows;
    } finally {
      database.close();
    }
  } catch {
    return cachedLogs.get(filePath)?.rows || [];
  }
}

/** @param {QuotaSource} left @param {QuotaSource} right @returns {QuotaSource} */
function strongerSource(left, right) {
  return SOURCE_RANK[left] >= SOURCE_RANK[right] ? left : right;
}

/** @param {QuotaSource} route @param {QuotaSource} auth @returns {QuotaSource} */
function mergeRouteAndAuth(route, auth) {
  if (route === "api" || route === "external") return route;
  if (route === "plan" && auth === "api") return "api";
  return route === "unknown" ? auth : route;
}

/**
 * Auth and route messages can arrive as separate rows. Route evidence wins over
 * ChatGPT auth, while a later Responses request starts a fresh state.
 *
 * @param {RawQuotaEvidence[]} records
 * @returns {{ time: number, source: QuotaSource }[]}
 */
function reduceThreadRecords(records) {
  const entries = [];
  let lastAuth = null;
  let lastAuthEntry = null;
  let lastRouteEntry = null;
  for (const record of [...records].sort((left, right) => left.time - right.time || left.id - right.id)) {
    if (record.kind === "auth") {
      lastAuth = record;
      if (
        lastRouteEntry &&
        record.time >= lastRouteEntry.time &&
        record.time - lastRouteEntry.time <= EVIDENCE_WINDOW_MS
      ) {
        lastRouteEntry.source = mergeRouteAndAuth(lastRouteEntry.routeSource, record.source);
        continue;
      }
      if (lastAuthEntry && record.time - lastAuthEntry.time <= EVIDENCE_WINDOW_MS) {
        lastAuthEntry.source = strongerSource(lastAuthEntry.source, record.source);
        continue;
      }
      lastAuthEntry = { time: record.time, source: record.source };
      entries.push(lastAuthEntry);
      continue;
    }

    const authApplies = lastAuth && record.time >= lastAuth.time && record.time - lastAuth.time <= EVIDENCE_WINDOW_MS;
    const source = authApplies ? mergeRouteAndAuth(record.source, lastAuth.source) : record.source;
    if (lastAuthEntry && record.time >= lastAuthEntry.time && record.time - lastAuthEntry.time <= EVIDENCE_WINDOW_MS) {
      entries.splice(entries.indexOf(lastAuthEntry), 1);
      lastAuthEntry = null;
    }
    lastRouteEntry = { time: record.time, source, routeSource: record.source };
    entries.push(lastRouteEntry);
  }
  return entries.map(({ time, source }) => ({ time, source }));
}

/** @param {QuotaSourceEvidenceEntry} entry */
function evidenceKey(entry) {
  return `${entry.homeId}\u0000${entry.sessionId}\u0000${entry.time}`;
}

/** @param {QuotaSourceEvidenceEntry} left @param {QuotaSourceEvidenceEntry} right */
function compareEvidence(left, right) {
  if (left.homeId !== right.homeId) return left.homeId < right.homeId ? -1 : 1;
  if (left.sessionId !== right.sessionId) return left.sessionId < right.sessionId ? -1 : 1;
  return left.time - right.time;
}

/** @param {Map<string, QuotaSourceEvidenceEntry>} byKey @returns {QuotaSourceEvidenceResolver} */
function createResolver(byKey) {
  const entries = [...byKey.values()].sort(compareEvidence);
  const resolver = {
    resolve(homeId, sessionId, timestampMs, recordedSource = "unknown") {
      const recorded = String(recordedSource || "unknown").toLowerCase();
      if (recorded === "api" || recorded === "external") return recorded;
      const time = Number(timestampMs);
      if (!Number.isFinite(time) || typeof homeId !== "string" || typeof sessionId !== "string") {
        if (recorded === "credits" || recorded === "plan") return recorded;
        return "unknown";
      }

      let low = 0;
      let high = entries.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const entry = entries[middle];
        const before =
          entry.homeId < homeId ||
          (entry.homeId === homeId && entry.sessionId < sessionId) ||
          (entry.homeId === homeId && entry.sessionId === sessionId && entry.time <= time);
        if (before) low = middle + 1;
        else high = middle;
      }

      let match = null;
      for (const index of [low - 1, low]) {
        const entry = entries[index];
        if (!entry || entry.homeId !== homeId || entry.sessionId !== sessionId) continue;
        const delta = entry.time - time;
        if (delta > REQUEST_LOOKAHEAD_MS || delta < -EVIDENCE_WINDOW_MS) continue;
        if (!match || Math.abs(delta) < Math.abs(match.time - time)) match = entry;
      }
      const evidence = match?.source || "unknown";
      if (recorded === "credits") return evidence === "api" || evidence === "external" ? evidence : "credits";
      if (recorded === "plan") return evidence === "unknown" ? "plan" : evidence;
      return evidence === "unknown" ? "unknown" : evidence;
    },
  };
  resolverEntries.set(resolver, entries);
  return resolver;
}

/** @param {unknown} value @param {string[]} expected @param {string} label */
function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} must contain exactly ${wanted.join(", ")}`);
  }
}

/** @param {QuotaSourceEvidenceResolver} evidence */
export function quotaSourceEvidenceSnapshot(evidence) {
  const entries = resolverEntries.get(evidence);
  if (!Array.isArray(entries)) {
    throw new TypeError("expected quota-source evidence returned by this module");
  }
  return {
    formatVersion: QUOTA_SOURCE_EVIDENCE_SNAPSHOT_FORMAT_VERSION,
    entries: entries.map(({ homeId, sessionId, time, source }) => ({ homeId, sessionId, time, source })),
  };
}

/** @param {unknown} snapshot @returns {QuotaSourceEvidenceResolver} */
export function quotaSourceEvidenceFromSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new TypeError("quota-source evidence snapshot must be an object");
  }
  assertExactKeys(snapshot, ["formatVersion", "entries"], "snapshot");
  const candidate = /** @type {{ formatVersion: unknown, entries: unknown }} */ (snapshot);
  if (candidate.formatVersion !== QUOTA_SOURCE_EVIDENCE_SNAPSHOT_FORMAT_VERSION) {
    throw new TypeError(`unsupported quota-source evidence snapshot ${candidate.formatVersion}`);
  }
  if (!Array.isArray(candidate.entries)) throw new TypeError("snapshot entries must be an array");

  const byKey = new Map();
  /** @type {QuotaSourceEvidenceEntry | null} */
  let previous = null;
  for (const rawEntry of candidate.entries) {
    const entry = /** @type {Record<string, unknown>} */ (rawEntry);
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      throw new TypeError("snapshot entry must be an object");
    }
    assertExactKeys(entry, ["homeId", "sessionId", "time", "source"], "snapshot entry");
    if (typeof entry.homeId !== "string" || entry.homeId.trim() === "") {
      throw new TypeError("snapshot homeId must be a non-empty string");
    }
    if (typeof entry.sessionId !== "string" || entry.sessionId.trim() === "") {
      throw new TypeError("snapshot sessionId must be a non-empty string");
    }
    if (typeof entry.time !== "number" || !Number.isFinite(entry.time)) {
      throw new TypeError("snapshot time must be finite");
    }
    if (typeof entry.source !== "string" || !QUOTA_SOURCES.has(entry.source)) {
      throw new TypeError(`unsupported snapshot source ${entry.source}`);
    }
    const value = /** @type {QuotaSourceEvidenceEntry} */ ({
      homeId: entry.homeId,
      sessionId: entry.sessionId,
      time: entry.time,
      source: entry.source,
    });
    if (previous && compareEvidence(previous, value) >= 0) {
      throw new TypeError("snapshot entries must be sorted and unique");
    }
    previous = value;
    byKey.set(evidenceKey(value), value);
  }
  return createResolver(byKey);
}

/**
 * Loads native Codex log evidence. Passing the previous sanitized snapshot keeps
 * known history when a log is missing, rotated, or temporarily unreadable.
 *
 * @param {{ id?: string, homeId?: string, path: string, kind?: string }[]} [homes]
 * @param {unknown} [previousSnapshot]
 * @returns {QuotaSourceEvidenceResolver}
 */
export function loadQuotaSourceEvidence(homes = [], previousSnapshot = null) {
  const byKey = new Map();
  if (previousSnapshot) {
    const restored = quotaSourceEvidenceFromSnapshot(previousSnapshot);
    for (const entry of resolverEntries.get(restored)) byKey.set(evidenceKey(entry), entry);
  }

  const seen = new Set();
  for (const home of homes) {
    if (!CODEX_HOME_KINDS.has(String(home?.kind || ""))) continue;
    const homeId = String(home.homeId || home.id || "");
    if (!homeId || typeof home.path !== "string" || !home.path) continue;
    const filePath = path.join(home.path, "logs_2.sqlite");
    const identity = `${homeId}\u0000${filePath}`;
    if (seen.has(identity)) continue;
    seen.add(identity);

    const byThread = new Map();
    for (const record of readQuotaLog(filePath)) {
      const entries = byThread.get(record.threadId) || [];
      entries.push(record);
      byThread.set(record.threadId, entries);
    }
    for (const [sessionId, records] of byThread) {
      for (const entry of reduceThreadRecords(records)) {
        const value = { homeId, sessionId, time: entry.time, source: entry.source };
        const key = evidenceKey(value);
        const existing = byKey.get(key);
        if (!existing || value.source !== "unknown") byKey.set(key, value);
      }
    }
  }
  return createResolver(byKey);
}
