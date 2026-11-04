const CACHE_BYTE_LIMIT = 1_048_576;
const CACHE_ENTRY_OVERHEAD_BYTES = 256;

function storedState(row) {
  if (!row) return null;
  return {
    time: Number(row.timestamp_ms),
    source: String(row.quota_source || "unknown"),
    until: Number(row.until_ms),
  };
}

function cacheKey(kind, homeId, sessionId) {
  return JSON.stringify([kind, homeId, sessionId]);
}

function utf16Bytes(value) {
  return value === null || value === undefined ? 0 : String(value).length * 2;
}

/**
 * Builds the database-backed equivalent of quotaSourceResolver without
 * retaining every quota source row. Threads and accounts share one LRU, with
 * one recent time segment per thread/home/session identity.
 *
 * The cache belongs to one read snapshot. The caller MUST call clearCache()
 * whenever quota_usage_sources changes or a new read snapshot starts.
 *
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {{ resolve: Function } | null | undefined} evidence
 * @param {{ maxBytes?: number }} [options]
 */
export function createStoredQuotaSourceResolver(database, evidence, { maxBytes = 1_048_576 } = {}) {
  const selectThreadLatest = database.prepare(`
    SELECT timestamp_ms, quota_source, until_ms
    FROM quota_usage_sources
    WHERE home_id = ? AND session_id = ? AND timestamp_ms <= ?
    ORDER BY timestamp_ms DESC, rowid DESC
    LIMIT 1
  `);
  const selectAccountLatest = database.prepare(`
    SELECT timestamp_ms, quota_source, until_ms
    FROM quota_usage_sources
    WHERE home_id = ? AND timestamp_ms <= ? AND quota_source IN ('credits', 'plan')
    ORDER BY timestamp_ms DESC, rowid DESC
    LIMIT 1
  `);
  const selectNextThreadChange = database.prepare(`
    SELECT timestamp_ms
    FROM quota_usage_sources
    WHERE home_id = ? AND session_id = ? AND timestamp_ms > ?
      AND (
        ? IS NULL
        OR (CASE WHEN quota_source = '' THEN 'unknown' ELSE quota_source END) <> ?
        OR until_ms <> ?
      )
    ORDER BY timestamp_ms ASC, rowid ASC
    LIMIT 1
  `);
  const selectNextAccountChange = database.prepare(`
    SELECT timestamp_ms
    FROM quota_usage_sources
    WHERE home_id = ? AND timestamp_ms > ? AND quota_source IN ('credits', 'plan')
      AND (
        ? IS NULL
        OR (CASE WHEN quota_source = '' THEN 'unknown' ELSE quota_source END) <> ?
        OR until_ms <> ?
      )
    ORDER BY timestamp_ms ASC, rowid ASC
    LIMIT 1
  `);

  const cache = new Map();
  const requestedBytes = Number(maxBytes);
  const byteLimit = Number.isFinite(requestedBytes)
    ? Math.min(CACHE_BYTE_LIMIT, Math.max(0, requestedBytes))
    : CACHE_BYTE_LIMIT;
  let cachedBytes = 0;

  function findCached(key, time) {
    const segment = cache.get(key);
    if (segment && segment.start <= time && time < segment.end) {
      cache.delete(key);
      cache.set(key, segment);
      return segment;
    }
    return null;
  }

  function remember(key, segment) {
    const previous = cache.get(key);
    if (previous) {
      cachedBytes -= previous.bytes;
      cache.delete(key);
    }
    const bytes =
      CACHE_ENTRY_OVERHEAD_BYTES +
      utf16Bytes(key) +
      utf16Bytes(segment.homeId) +
      utf16Bytes(segment.sessionId) +
      utf16Bytes(segment.source);
    if (bytes > byteLimit) return segment;

    while (cachedBytes + bytes > byteLimit && cache.size > 0) {
      const oldestKey = cache.keys().next().value;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      cachedBytes -= oldest.bytes;
    }
    cache.set(key, { ...segment, bytes });
    cachedBytes += bytes;
    return segment;
  }

  function loadThreadSegment(homeId, sessionId, time) {
    const key = cacheKey("thread", homeId, sessionId);
    const cached = findCached(key, time);
    if (cached) return cached;

    const state = storedState(selectThreadLatest.get(homeId, sessionId, time));
    const next = selectNextThreadChange.get(
      homeId,
      sessionId,
      time,
      state?.source ?? null,
      state?.source ?? null,
      state?.until ?? 0,
    );
    return remember(key, {
      kind: "thread",
      homeId,
      sessionId,
      hasEntry: Boolean(state),
      start: state?.time ?? -Infinity,
      source: state?.source ?? "unknown",
      until: state?.until ?? 0,
      end: next ? Number(next.timestamp_ms) : Infinity,
    });
  }

  function loadAccountSegment(homeId, time) {
    const key = cacheKey("account", homeId, null);
    const cached = findCached(key, time);
    if (cached) return cached;

    const state = storedState(selectAccountLatest.get(homeId, time));
    const next = selectNextAccountChange.get(
      homeId,
      time,
      state?.source ?? null,
      state?.source ?? null,
      state?.until ?? 0,
    );
    return remember(key, {
      kind: "account",
      homeId,
      sessionId: null,
      start: state?.time ?? -Infinity,
      source: state?.source ?? null,
      until: state?.until ?? 0,
      end: next ? Number(next.timestamp_ms) : Infinity,
    });
  }

  function resolver(homeId, sessionId, time, recordedSource = "unknown") {
    const storedHomeId = String(homeId);
    const storedSessionId = String(sessionId);
    const thread = loadThreadSegment(storedHomeId, storedSessionId, time);
    let source = recordedSource !== "unknown" ? recordedSource : thread.source || "unknown";
    if (source === "credits" && thread.hasEntry && thread.until <= time) source = "unknown";

    const account = loadAccountSegment(storedHomeId, time);
    source = evidence?.resolve(homeId, sessionId, time, source) || source;
    if (!["api", "external"].includes(source) && account.source === "credits" && time < account.until) {
      source = "credits";
    }
    return source;
  }

  resolver.clearCache = () => {
    cache.clear();
    cachedBytes = 0;
  };
  return resolver;
}
