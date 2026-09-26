
import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  COMPARISON_PERIOD_KEYS,
  buildUsageFingerprint,
  discoverSessionFiles,
  discoverUsageSources,
  isQuotaPreset,
  previousUsageRange,

  resolveDateRange,
  selectQuotaWindows,
  streamUsageFileEvents,
  usageComparisonFromAggregates,
} from "./usage-core.js";
import { createRepositoryResolver } from "./repository-identity.js";
import { createCostEstimateAccumulator, estimateCostForEvents, estimateEventCost, getPricingCatalog } from "./pricing.js";
import { loadServiceTierEvidence } from "./service-tier-evidence.js";
import { zcodeSourceStat } from "./zcode-usage.js";
import { buildTimelineRows } from "../public/timeline-utils.js";

const STORE_SCHEMA_VERSION = 7;

function localDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localHourKey(date) {
  const hour = String(date.getHours()).padStart(2, "0");
  return `${localDateKey(date)} ${hour}:00`;
}

function startOfLocalWeek(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = start.getDay() || 7;
  start.setDate(start.getDate() - day + 1);
  return start;
}

function usageFromRow(row) {
  const values = row || {};
  return {
    total: Number(values.total || 0),
    input: Number(values.input || 0),
    cached: Number(values.cached || 0),
    output: Number(values.output || 0),
    reasoning: Number(values.reasoning || 0),
  };
}

function rangeParameters(range) {
  const start = range.start ? range.start.getTime() : null;
  const end = range.end ? range.end.getTime() : null;
  return [start, start, end, end];
}

function eventRangeFilter(range) {
  if (!isQuotaPreset(range?.preset)) {
    return {
      sql: "(? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?)",
      params: rangeParameters(range),
    };
  }
  const predicates = [];
  const params = [];
  if (range.start) {
    predicates.push("timestamp_ms >= ?");
    params.push(range.start.getTime());
  }
  if (range.end) {
    predicates.push("timestamp_ms <= ?");
    params.push(range.end.getTime());
  }
  return { sql: predicates.length ? predicates.join(" AND ") : "1 = 1", params };
}

function eventRangeScope(range, scope) {
  const filter = eventRangeFilter(range);
  return {
    sql: withScope(filter.sql, scope),
    params: [...filter.params, ...scope.params],
  };
}

function scopeFilterSql(excludeHomes = []) {
  const ids = (excludeHomes || []).map((value) => String(value)).filter(Boolean);
  if (!ids.length) {
    return { sql: "", params: [] };
  }
  return { sql: `home_id NOT IN (${ids.map(() => "?").join(", ")})`, params: ids };
}

// New Record 系统的指标定义：sum 系按周期求和求最大，ratio 按命中率最大，
// count 按去重数量最大；cost 系按汇率折算后的可比金额最大。
const RECORD_METRICS = Object.freeze({
  totalTokens: { kind: "sum", field: "total", title: "总 tokens 最高" },
  inputTokens: { kind: "sum", field: "input", title: "总输入最高" },
  cachedTokens: { kind: "sum", field: "cached", title: "缓存读取最高" },
  outputTokens: { kind: "sum", field: "output", title: "输出最高" },
  reasoningTokens: { kind: "sum", field: "reasoning", title: "推理输出最高" },
  sessionCount: { kind: "count", field: "sessions", title: "会话最多" },
  modelCount: { kind: "count", field: "models", title: "模型数量最多" },
  cacheHitRate: { kind: "ratio", title: "缓存命中最高" },
  totalCost: { kind: "cost", field: "total", title: "总花销最高" },
  inputCost: { kind: "cost", field: "input", title: "普通输入花销最高" },
  cachedCost: { kind: "cost", field: "cached", title: "缓存读取花销最高" },
  outputCost: { kind: "cost", field: "output", title: "输出花销最高" },
});

const RECORD_UNIT_LABELS = Object.freeze({ day: "一日", week: "一周", month: "一个月" });

function recordUnitBoundaries(key, unit) {
  if (unit === "day") {
    const start = parseDateKey(key);
    return start ? [start.getTime(), addDaysMs(start, 1)] : null;
  }
  if (unit === "week") {
    const start = parseDateKey(key);
    return start ? [start.getTime(), addDaysMs(start, 7)] : null;
  }
  const match = /^(\d{4})-(\d{2})$/.exec(key || "");
  if (!match) return null;
  const start = new Date(Number(match[1]), Number(match[2]) - 1, 1);
  return [start.getTime(), new Date(Number(match[1]), Number(match[2]), 1).getTime()];
}

function parseDateKey(key) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || "");
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null;
}

function addDaysMs(date, days) {
  return date.getTime() + days * 24 * 60 * 60 * 1000;
}

function withScope(baseSql, scope) {
  return scope.sql ? `${baseSql} AND ${scope.sql}` : baseSql;
}

export class UsageStore {
  constructor(options = {}) {
    this.options = options;
    this.metadataCache = null;
    this.periodComparisonCache = new Map();
    this.databaseFile =
      options.databaseFile || path.join(options.homeDir || os.homedir(), ".codex-usage", "usage-index.sqlite");
    this.database = null;
    this.homes = [];
    this.warnings = [];
    this.generatedAt = "";
    this.fingerprint = "";
    this.checkedAt = "";
    this.repositoryResolver = createRepositoryResolver();
    this.serviceTierEvidence = null;
  }

  async open() {
    if (this.database) {
      return;
    }
    this.metadataCache = null;
    this.periodComparisonCache.clear();
    await mkdir(path.dirname(this.databaseFile), { recursive: true });
    this.database = new DatabaseSync(this.databaseFile);
    this.database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS store_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS source_files (
        path TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        home_path TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        indexed_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        timestamp_ms INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        home_id TEXT NOT NULL,
        home_label TEXT NOT NULL,
        channel TEXT NOT NULL,
        project TEXT NOT NULL,
        model TEXT NOT NULL,
        hour_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        week_key TEXT NOT NULL,
        month_key TEXT NOT NULL,
        cwd TEXT NOT NULL DEFAULT '',
        repository_key TEXT NOT NULL DEFAULT 'unknown:cwd',
        repository_path TEXT NOT NULL DEFAULT 'Unknown cwd',
        repository_kind TEXT NOT NULL DEFAULT 'unknown',
        detail_mask INTEGER NOT NULL DEFAULT 0,
        reconciliation_gap INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_known INTEGER NOT NULL DEFAULT 0,
        request_input_tokens INTEGER NOT NULL DEFAULT 0,
        context_level TEXT NOT NULL DEFAULT 'unknown',
        service_tier TEXT NOT NULL DEFAULT 'unknown',
        price_version TEXT NOT NULL DEFAULT '',
        total INTEGER NOT NULL,
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        output INTEGER NOT NULL,
        reasoning INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS rate_limit_observations (
        source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE,
        line_number INTEGER NOT NULL CHECK (line_number > 0),
        role TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
        observed_at_ms INTEGER NOT NULL,
        limit_id TEXT NOT NULL,
        limit_name TEXT,
        plan_type TEXT,
        window_minutes REAL NOT NULL CHECK (window_minutes > 0),
        resets_at_ms INTEGER NOT NULL,
        used_percent REAL CHECK (used_percent IS NULL OR (used_percent >= 0 AND used_percent <= 100)),
        PRIMARY KEY (source_path, line_number, role)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS events_timestamp_idx ON events(timestamp_ms);
      CREATE INDEX IF NOT EXISTS events_home_idx ON events(home_id);
      CREATE INDEX IF NOT EXISTS events_channel_idx ON events(channel);
      CREATE INDEX IF NOT EXISTS events_project_idx ON events(project);
      CREATE INDEX IF NOT EXISTS events_model_idx ON events(model);
      CREATE INDEX IF NOT EXISTS rate_limit_window_lookup_idx ON rate_limit_observations(limit_id, window_minutes, observed_at_ms DESC);
      CREATE INDEX IF NOT EXISTS rate_limit_source_line_idx ON rate_limit_observations(source_path, line_number);
    `);
    let version = Number(this.database.prepare("PRAGMA user_version").get().user_version || 0);
    const migrate = (sql, nextVersion) => {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(sql);
        this.database.exec("PRAGMA user_version = " + nextVersion);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        this.database.close();
        this.database = null;
        throw error;
      }
    };
    if (version === 1) {
      migrate([
        "ALTER TABLE events ADD COLUMN cwd TEXT NOT NULL DEFAULT '';",
        "ALTER TABLE events ADD COLUMN repository_key TEXT NOT NULL DEFAULT 'unknown:cwd';",
        "ALTER TABLE events ADD COLUMN repository_path TEXT NOT NULL DEFAULT 'Unknown cwd';",
        "ALTER TABLE events ADD COLUMN repository_kind TEXT NOT NULL DEFAULT 'unknown';",
        "ALTER TABLE events ADD COLUMN detail_mask INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE events ADD COLUMN reconciliation_gap INTEGER NOT NULL DEFAULT 0;",
        "UPDATE events SET cwd = project;",
        "UPDATE source_files SET size = -1, mtime_ms = -1;",
      ].join("\n"), 2);
      version = 2;
    }
    if (version === 2) {
      migrate([
        "ALTER TABLE events ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE events ADD COLUMN cache_write_known INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE events ADD COLUMN request_input_tokens INTEGER NOT NULL DEFAULT 0;",
        "ALTER TABLE events ADD COLUMN context_level TEXT NOT NULL DEFAULT 'unknown';",
        "ALTER TABLE events ADD COLUMN service_tier TEXT NOT NULL DEFAULT 'unknown';",
        "ALTER TABLE events ADD COLUMN price_version TEXT NOT NULL DEFAULT '';",
        "UPDATE source_files SET size = -1, mtime_ms = -1;",
      ].join("\n"), 3);
      version = 3;
    }
    if (version === 3) {
      migrate(`
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE path IN (SELECT DISTINCT source_path FROM events WHERE context_level = 'unknown' AND total > 0);
      `, 4);
      version = 4;
    }
    if (version === 4) {
      migrate(`
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE path IN (
          SELECT source_path FROM events WHERE session_id IN (
            SELECT session_id FROM events GROUP BY session_id HAVING COUNT(DISTINCT source_path) > 1
          )
        );
      `, 5);
      version = 5;
    }
    if (version === 5) {
      migrate(`
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE kind IN ('main', 'jetbrains', 'extra', 'codex')
          AND lower(path) LIKE '%.jsonl';
      `, 6);
      version = 6;
    }
    if (version === 6) {
      // Earlier quota parsing looked for limit_id inside primary/secondary.
      // Codex writes it on rate_limits, so unchanged session files need a reindex.
      migrate(`
        UPDATE source_files SET size = -1, mtime_ms = -1
        WHERE kind IN ('main', 'jetbrains', 'extra', 'codex')
          AND lower(path) LIKE '%.jsonl';
      `, STORE_SCHEMA_VERSION);
      version = STORE_SCHEMA_VERSION;
    }
    if (version !== 0 && version !== STORE_SCHEMA_VERSION) {
      this.database.close();
      this.database = null;
      throw new Error("不支持的用量索引版本：" + version);
    }
    if (version === 0) this.database.exec("PRAGMA user_version = " + STORE_SCHEMA_VERSION);
    this.database.exec("CREATE INDEX IF NOT EXISTS events_repository_idx ON events(repository_key)");
    this.generatedAt = this.readMeta("generated_at");
    this.fingerprint = this.readMeta("fingerprint");
  }

  readMeta(key) {
    return this.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(key)?.value || "";
  }

  writeMeta(key, value) {
    this.database
      .prepare("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, String(value));
  }

  async usageFiles(homes) {
    const files = [];
    const warnings = [];
    const failedHomes = [];
    for (const home of homes) {
      try {
        if (home.kind === "project-log" && home.usageLogPath) {
          files.push({ filePath: home.usageLogPath, source: home, info: await stat(home.usageLogPath) });
          continue;
        }
        if (home.kind === "zcode" && home.usageLogPath) {
          files.push({ filePath: home.usageLogPath, source: home, info: await zcodeSourceStat(home.usageLogPath) });
          continue;
        }
        for (const filePath of await discoverSessionFiles(home.path)) {
          files.push({ filePath, source: home, info: await stat(filePath) });
        }
      } catch (error) {
        failedHomes.push({ id: home.id, path: home.path });
        warnings.push(`无法读取 ${home.path}: ${error.message}`);
      }
    }
    return { files, warnings, failedHomes };
  }

  async replaceFile({ filePath, source, info }, { onWarning } = {}) {
    const database = this.database;
    const insertSource = database.prepare(`
      INSERT INTO source_files (path, kind, home_id, home_label, home_path, size, mtime_ms, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        kind = excluded.kind,
        home_id = excluded.home_id,
        home_label = excluded.home_label,
        home_path = excluded.home_path,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        indexed_at = excluded.indexed_at
    `);
    const insertEvent = database.prepare(`
      INSERT INTO events (
        source_path, timestamp_ms, session_id, home_id, home_label, channel, project, model,
        hour_key, day_key, week_key, month_key, cwd, repository_key, repository_path, repository_kind,
        detail_mask, reconciliation_gap, cache_write_tokens, cache_write_known, request_input_tokens,
        context_level, service_tier, price_version, total, input, cached, output, reasoning
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertRateLimitObservation = database.prepare(`
      INSERT INTO rate_limit_observations (
        source_path, line_number, role, observed_at_ms, limit_id, limit_name,
        plan_type, window_minutes, resets_at_ms, used_percent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const previousStatement = database.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total,
        COALESCE(SUM(input), 0) AS input, COALESCE(SUM(cached), 0) AS cached,
        COALESCE(SUM(output), 0) AS output, COALESCE(SUM(reasoning), 0) AS reasoning,
        MIN(detail_mask & 1) AS input_known, MIN(detail_mask & 2) AS cached_known,
        MIN(detail_mask & 4) AS output_known, MIN(detail_mask & 8) AS reasoning_known,
        COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens,
        MIN(cache_write_known) AS cache_write_known
      FROM events WHERE session_id = ? AND home_id = ? AND source_path <> ? AND timestamp_ms < ?
    `);
    const previousCumulativeForSession = (sessionId, timestamp) => {
      const timestampMs = Date.parse(timestamp);
      if (!Number.isFinite(timestampMs)) return null;
      const earlier = previousStatement.get(sessionId, source.id, filePath, timestampMs);
      if (!earlier.count) return null;
      return {
        usage: usageFromRow(earlier),
        detailMask: Number(earlier.input_known || 0) | Number(earlier.cached_known || 0) |
          Number(earlier.output_known || 0) | Number(earlier.reasoning_known || 0),
        cacheWrite: { tokens: Number(earlier.cache_write_tokens || 0), known: Boolean(earlier.cache_write_known) },
      };
    };
    database.exec("BEGIN IMMEDIATE");
    try {
      insertSource.run(
        filePath,
        source.kind || "codex",
        source.id,
        source.label,
        source.path,
        info.size,
        info.mtimeMs,
        new Date().toISOString(),
      );
      database.prepare("DELETE FROM events WHERE source_path = ?").run(filePath);
      database.prepare("DELETE FROM rate_limit_observations WHERE source_path = ?").run(filePath);
      await streamUsageFileEvents(filePath, source, (event) => {
        const date = new Date(event.timestampMs);
        insertEvent.run(
          filePath,
          event.timestampMs,
          event.sessionId,
          event.homeId,
          event.homeLabel,
          event.channel,
          event.project || "Unknown cwd",
          event.model || "Unknown model",
          localHourKey(date),
          localDateKey(date),
          localDateKey(startOfLocalWeek(date)),
          localDateKey(date).slice(0, 7),
          event.project || "",
          event.repositoryKey || "unknown:cwd",
          event.repositoryPath || "Unknown cwd",
          event.repositoryKind || "unknown",
          Number(event.detailMask || 0),
          Number(event.reconciliationGap || 0),
          Number(event.cacheWriteTokens || 0),
          event.cacheWriteKnown ? 1 : 0,
          Number(event.requestInputTokens || 0),
          event.contextLevel || "unknown",
          event.serviceTier || "unknown",
          event.priceVersion || "",
          event.usage.total,
          event.usage.input,
          event.usage.cached,
          event.usage.output,
          event.usage.reasoning,
        );
      }, {
        repositoryResolver: this.repositoryResolver,
        previousCumulativeForSession,
        onRateLimit: ["main", "jetbrains", "extra", "codex"].includes(source.kind)
          ? (observation) => insertRateLimitObservation.run(
              filePath,
              observation.lineNumber,
              observation.role,
              observation.observedAtMs,
              observation.limitId,
              observation.limitName,
              observation.planType,
              observation.windowMinutes,
              observation.resetsAtMs,
              observation.usedPercent,
            )
          : undefined,
        onWarning,
      });
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  async sync({ options } = {}) {
    await this.open();
    const syncOptions = options || this.options;
    this.options = syncOptions;
    const homes = await discoverUsageSources(syncOptions);

    const { files, warnings, failedHomes = [] } = await this.usageFiles(homes);
    const status = await buildUsageFingerprint({ ...syncOptions, homes, scannedFiles: files, failedHomes });
    const knownFiles = new Set(files.map((file) => file.filePath));
    const failedHomeIds = new Set(failedHomes.map((home) => home.id));
    const failedHomePaths = new Set(failedHomes.map((home) => home.path));
    let updatedFileCount = 0;
    const changedSessions = new Set();

    for (const file of files) {
      const existing = this.database
        .prepare("SELECT size, mtime_ms, kind, home_id, home_label, home_path FROM source_files WHERE path = ?")
        .get(file.filePath);
      const previousSessions = existing
        ? this.database.prepare("SELECT DISTINCT session_id FROM events WHERE source_path = ?").all(file.filePath).map((row) => row.session_id)
        : [];
      const earlierFileChanged = previousSessions.some((sessionId) => changedSessions.has(sessionId));
      if (!earlierFileChanged && existing && Number(existing.size) === file.info.size && Number(existing.mtime_ms) === file.info.mtimeMs &&
          existing.kind === (file.source.kind || "codex") && existing.home_id === file.source.id &&
          existing.home_label === file.source.label && existing.home_path === file.source.path) {
        continue;
      }
      try {
        await this.replaceFile(file, { onWarning: (warning) => warnings.push(warning) });
        for (const row of this.database.prepare("SELECT DISTINCT session_id FROM events WHERE source_path = ?").all(file.filePath)) {
          changedSessions.add(row.session_id);
        }
        updatedFileCount += 1;
      } catch (error) {
        warnings.push(`无法索引 ${file.filePath}: ${error.message}`);
      }
    }

    for (const row of this.database.prepare("SELECT path, home_id, home_path FROM source_files").all()) {
      if (!knownFiles.has(row.path) && !failedHomeIds.has(row.home_id) && !failedHomePaths.has(row.home_path)) {
        this.database.prepare("DELETE FROM source_files WHERE path = ?").run(row.path);
      }
    }

    this.serviceTierEvidence = loadServiceTierEvidence(homes);
    this.homes = homes;
    this.warnings = warnings;
    this.generatedAt = new Date().toISOString();
    this.fingerprint = status.fingerprint;
    this.checkedAt = status.checkedAt;
    this.writeMeta("generated_at", this.generatedAt);
    this.writeMeta("fingerprint", this.fingerprint);
    this.metadataCache = null;
    this.periodComparisonCache.clear();
    return { ...status, updatedFileCount };
  }

  quotaObservations() {
    return this.database.prepare(`
      SELECT source_path, line_number, role, observed_at_ms, limit_id, limit_name,
        plan_type, window_minutes, resets_at_ms, used_percent
      FROM rate_limit_observations INDEXED BY rate_limit_window_lookup_idx
      ORDER BY limit_id ASC, window_minutes ASC, observed_at_ms DESC
    `).all().map((row) => ({
      sourcePath: row.source_path,
      lineNumber: Number(row.line_number),
      role: row.role,
      observedAtMs: Number(row.observed_at_ms),
      limitId: row.limit_id,
      limitName: row.limit_name,
      planType: row.plan_type,
      windowMinutes: Number(row.window_minutes),
      resetsAtMs: Number(row.resets_at_ms),
      usedPercent: row.used_percent === null ? null : Number(row.used_percent),
    }));
  }

  metadata() {
    if (this.metadataCache) return structuredClone(this.metadataCache);
    const totals = this.database
      .prepare("SELECT COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count FROM events")
      .get();
    const homeRows = new Map(
      this.database
        .prepare(`
          SELECT home_id, COUNT(*) AS event_count, COUNT(DISTINCT session_id) AS session_count
          FROM events GROUP BY home_id
        `)
        .all()
        .map((row) => [row.home_id, row]),
    );
    // 按实际使用记录给出各 harness（Codex / ZCode）用到的模型名称。
    const harnessModels = { Codex: new Set(), ZCode: new Set() };
    for (const row of this.database.prepare("SELECT DISTINCT channel, model FROM events").all()) {
      const model = String(row.model || "").trim();
      if (!model || model.toLocaleLowerCase() === "unknown model") continue;
      const bucket = String(row.channel || "").toLowerCase().startsWith("zcode") ? "ZCode" : "Codex";
      harnessModels[bucket].add(model);
    }
    this.metadataCache = {
      generatedAt: this.generatedAt,
      eventCount: Number(totals.event_count || 0),
      sessionCount: Number(totals.session_count || 0),
      homeCount: this.homes.length,
      harnessModels: {
        Codex: [...harnessModels.Codex].sort((a, b) => a.localeCompare(b)),
        ZCode: [...harnessModels.ZCode].sort((a, b) => a.localeCompare(b)),
      },
      homes: this.homes.map((home) => {
        const row = homeRows.get(home.id);
        return {
          ...home,
          status: row ? "active" : "no-events",
          eventCount: Number(row?.event_count || 0),
          sessionCount: Number(row?.session_count || 0),
        };
      }),
      warnings: this.warnings,
    };
    return structuredClone(this.metadataCache);
  }

  aggregateRange(range, excludeHomes = []) {
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    return this.database
      .prepare(`
        SELECT
          COUNT(*) AS event_count,
          COUNT(DISTINCT session_id) AS session_count,
          COUNT(DISTINCT home_id) AS home_count,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE ${where.sql}
      `)
      .get(...where.params);
  }

  groupedRange(column, range, orderBy = "total DESC", excludeHomes = []) {
    const allowedColumns = new Set(["channel", "home_label", "model", "project", "hour_key", "day_key", "week_key", "month_key"]);
    if (!allowedColumns.has(column)) {
      throw new Error(`不支持的聚合字段：${column}`);
    }
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    const rows = this.database
      .prepare(`
        SELECT
          ${column} AS key,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS sessions,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE ${where.sql}
        GROUP BY ${column}
        ORDER BY ${orderBy}
      `)
      .all(...where.params);
    return rows.map((row) => ({
      key: row.key,
      name: row.key,
      count: Number(row.count || 0),
      sessions: Number(row.sessions || 0),
      total: usageFromRow(row),
    }));
  }

  costEstimateRange(range, excludeHomes = []) {
    const tierEvidence = this.serviceTierEvidence;
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    const statement = this.database.prepare(`SELECT timestamp_ms, session_id, channel, model, detail_mask, cache_write_tokens, cache_write_known, request_input_tokens, context_level, service_tier, price_version, total, input, cached, output, reasoning FROM events WHERE ${where.sql}`);
    function* events() {
      for (const row of statement.iterate(...where.params)) {
        yield {
          timestamp: Number(row.timestamp_ms),
          sessionId: row.session_id,
          channel: row.channel,
          model: row.model,
          detailMask: Number(row.detail_mask || 0),
          cacheWriteTokens: Number(row.cache_write_tokens || 0),
          cacheWriteKnown: Boolean(row.cache_write_known),
          requestInputTokens: Number(row.request_input_tokens || 0),
          contextLevel: row.context_level,
          serviceTier: tierEvidence?.resolve(row.session_id, Number(row.timestamp_ms), row.service_tier) || row.service_tier,
          priceVersion: row.price_version,
          total: usageFromRow(row),
        };
      }
    }
    return estimateCostForEvents(events());
  }

  timelineRange(range, bucket, { onEstimate, excludeHomes = [] } = {}) {
    const tierEvidence = this.serviceTierEvidence;
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    const statement = this.database.prepare(`SELECT timestamp_ms, session_id, channel, model, detail_mask, cache_write_tokens, cache_write_known, request_input_tokens, context_level, service_tier, price_version, total, input, cached, output, reasoning FROM events WHERE ${where.sql}`);
    function* events() {
      for (const row of statement.iterate(...where.params)) {
        yield {
          timestamp: Number(row.timestamp_ms),
          sessionId: row.session_id,
          channel: row.channel,
          model: row.model,
          detailMask: Number(row.detail_mask || 0),
          cacheWriteTokens: Number(row.cache_write_tokens || 0),
          cacheWriteKnown: Boolean(row.cache_write_known),
          requestInputTokens: Number(row.request_input_tokens || 0),
          contextLevel: row.context_level,
          serviceTier: tierEvidence?.resolve(row.session_id, Number(row.timestamp_ms), row.service_tier) || row.service_tier,
          priceVersion: row.price_version,
          total: usageFromRow(row),
        };
      }
    }
    return buildTimelineRows(events(), range, bucket, { estimateCost: estimateEventCost, onEstimate });
  }

  repositoriesRange(range, excludeHomes = []) {
    const scope = scopeFilterSql(excludeHomes);
    const where = eventRangeScope(range, scope);
    const rows = this.database
      .prepare(`
        SELECT
          repository_key AS key,
          MIN(repository_path) AS name,
          MAX(repository_kind) AS kind,
          COUNT(DISTINCT NULLIF(cwd, '')) AS path_count,
          COUNT(*) AS count,
          COUNT(DISTINCT session_id) AS sessions,
          json_group_array(DISTINCT session_id) AS session_ids,
          COALESCE(SUM(total), 0) AS total,
          COALESCE(SUM(input), 0) AS input,
          COALESCE(SUM(cached), 0) AS cached,
          COALESCE(SUM(output), 0) AS output,
          COALESCE(SUM(reasoning), 0) AS reasoning
        FROM events
        WHERE ${where.sql}
        GROUP BY repository_key
        ORDER BY total DESC, name ASC
      `)
      .all(...where.params);
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      kind: row.kind,
      pathCount: Number(row.path_count || 0),
      count: Number(row.count || 0),
      sessions: Number(row.sessions || 0),
      sessionIds: JSON.parse(row.session_ids || "[]"),
      total: usageFromRow(row),
    }));
  }

  periodAggregate(groupColumn, nameColumn, now, ranges, { includeKind = false, excludeHomes = [] } = {}) {
    const dimensionKey = groupColumn;
    const dimensions = dimensionKey
      ? `${dimensionKey} AS dimension_key, ${includeKind ? `MIN(${nameColumn}) AS dimension_name, MIN(repository_kind) AS dimension_kind, COUNT(DISTINCT NULLIF(cwd, '')) AS path_count` : `${nameColumn} AS dimension_name`},`
      : "";
    const fields = [
      ["total", "total"],
      ["input", "CASE WHEN (detail_mask & 1) != 0 THEN input ELSE 0 END"],
      ["inputUnavailableTokens", "CASE WHEN (detail_mask & 1) = 0 THEN total ELSE 0 END"],
      ["cached", "CASE WHEN (detail_mask & 2) != 0 THEN cached ELSE 0 END"],
      ["cachedUnavailableTokens", "CASE WHEN (detail_mask & 2) = 0 THEN total ELSE 0 END"],
      ["uncachedInput", "CASE WHEN (detail_mask & 3) = 3 THEN MAX(input - cached, 0) ELSE 0 END"],
      ["uncachedInputUnavailableTokens", "CASE WHEN (detail_mask & 3) != 3 THEN total ELSE 0 END"],
      ["cacheRateInput", "CASE WHEN (detail_mask & 3) = 3 THEN input ELSE 0 END"],
      ["cacheRateCached", "CASE WHEN (detail_mask & 3) = 3 THEN cached ELSE 0 END"],
      ["output", "CASE WHEN (detail_mask & 4) != 0 THEN output ELSE 0 END"],
      ["outputUnavailableTokens", "CASE WHEN (detail_mask & 4) = 0 THEN total ELSE 0 END"],
      ["reasoning", "CASE WHEN (detail_mask & 8) != 0 THEN reasoning ELSE 0 END"],
      ["reasoningUnavailableTokens", "CASE WHEN (detail_mask & 8) = 0 THEN total ELSE 0 END"],
      ["unattributedDetailTokens", "CASE WHEN (detail_mask & 15) != 15 THEN total ELSE 0 END"],
      ["inconsistentTokens", "CASE WHEN (detail_mask & 16) != 0 THEN total ELSE 0 END"],
      ["reconciliationGap", "reconciliation_gap"],
    ];
    const parameters = [];
    const measures = [];
    for (const period of COMPARISON_PERIOD_KEYS) {
      for (const [field, expression] of fields) {
        measures.push(
          `COALESCE(SUM(CASE WHEN (? IS NULL OR timestamp_ms >= ?) AND (? IS NULL OR timestamp_ms <= ?) THEN ${expression} ELSE 0 END), 0) AS "${period}__${field}"`,
        );
        parameters.push(...rangeParameters(ranges[period]));
      }
    }
    const select = `SELECT ${dimensions} ${measures.join(", ")} FROM events`;
    const scope = scopeFilterSql(excludeHomes);
    const where = scope.sql ? ` WHERE ${scope.sql}` : "";
    const groupBy = dimensionKey ? ` GROUP BY ${dimensionKey}` : "";
    const orderBy = dimensionKey ? " ORDER BY all__total DESC, dimension_name ASC" : "";
    const rows = this.database.prepare(`${select}${where}${groupBy}${orderBy}`).all(...parameters, ...scope.params);
    return rows.map((row) => {
      const result = {
        key: dimensionKey ? String(row.dimension_key) : "all",
        name: dimensionKey ? String(row.dimension_name) : "全部",
        periods: Object.fromEntries(
          COMPARISON_PERIOD_KEYS.map((period) => [
            period,
            Object.fromEntries(fields.map(([field]) => [field, Number(row[`${period}__${field}`] || 0)])),
          ]),
        ),
      };
      if (includeKind) {
        result.kind = row.dimension_kind;
        result.pathCount = Number(row.path_count || 0);
      }

      return result;
    });
  }

  periodComparison(options = {}) {
    const now = options.now ? new Date(options.now) : new Date();
    const excludeHomes = options.excludeHomes || [];
    const cacheKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}|${[...excludeHomes].map(String).sort().join(",")}`;
    const cached = this.periodComparisonCache.get(cacheKey);
    if (cached) return { ...structuredClone(cached), asOf: now.toISOString() };
    const scope = scopeFilterSql(excludeHomes);
    const bounds = this.database
      .prepare(`SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events${scope.sql ? ` WHERE ${scope.sql}` : ""}`)
      .get(...scope.params);
    const timestamps = bounds.minimum === null
      ? []
      : [
          { timestamp: new Date(Number(bounds.minimum)).toISOString() },
          { timestamp: new Date(Number(bounds.maximum)).toISOString() },
        ];
    const ranges = Object.fromEntries(
      COMPARISON_PERIOD_KEYS.map((key) => [key, resolveDateRange({ preset: key, now }, timestamps)]),
    );
    const models = this.periodAggregate("model", "model", now, ranges, { excludeHomes });
    const totals = models.length
      ? Object.fromEntries(COMPARISON_PERIOD_KEYS.map((period) => {
          const periodTotals = {};
          for (const model of models) {
            for (const [field, value] of Object.entries(model.periods[period])) {
              periodTotals[field] = (periodTotals[field] || 0) + value;
            }
          }
          return [period, periodTotals];
        }))
      : this.periodAggregate(null, null, now, ranges, { excludeHomes })[0].periods;
    const value = {
      periods: COMPARISON_PERIOD_KEYS.map((key) => ({
        key,
        start: ranges[key].start?.toISOString() || null,
        end: ranges[key].end?.toISOString() || null,
      })),
      totals,
      models,
      repositories: this.periodAggregate("repository_key", "repository_path", now, ranges, { includeKind: true, excludeHomes }),
    };
    this.periodComparisonCache.clear();
    this.periodComparisonCache.set(cacheKey, value);
    return { ...structuredClone(value), asOf: now.toISOString() };
  }

  // New Record：对日/周/月三种自然周期求各指标的历史最高期（严格新高、至少两期可比），
  // 只有纪录期完整落在所选范围内时才计为“在所选时间范围创下”。
  recordsForRange(range, excludeHomes = []) {
    const scope = scopeFilterSql(excludeHomes);
    const where = scope.sql ? `WHERE ${scope.sql}` : "";
    const rate = Number(getPricingCatalog().usdToCnyRate);
    const usdToCnyRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    const periods = { day: new Map(), week: new Map(), month: new Map() };
    const ensureSlot = (unit, key) => {
      let slot = periods[unit].get(key);
      if (!slot) {
        slot = {
          key,
          total: 0, input: 0, cached: 0, output: 0, reasoning: 0,
          sessions: new Set(), models: new Set(),
          cost: { total: 0, input: 0, cached: 0, output: 0 },
        };
        periods[unit].set(key, slot);
      }
      return slot;
    };

    const statement = this.database.prepare(`
      SELECT day_key, week_key, month_key, session_id, model, channel,
        total, input, cached, output, reasoning, detail_mask, cache_write_tokens,
        cache_write_known, request_input_tokens, context_level, service_tier
      FROM events ${where}
    `);
    for (const row of statement.iterate(...scope.params)) {
      const estimate = estimateEventCost({
        model: row.model,
        channel: row.channel,
        detailMask: Number(row.detail_mask || 0),
        cacheWriteTokens: Number(row.cache_write_tokens || 0),
        cacheWriteKnown: Boolean(row.cache_write_known),
        requestInputTokens: Number(row.request_input_tokens || 0),
        contextLevel: row.context_level,
        serviceTier: row.service_tier,
        total: {
          total: Number(row.total || 0),
          input: Number(row.input || 0),
          cached: Number(row.cached || 0),
          output: Number(row.output || 0),
          reasoning: Number(row.reasoning || 0),
        },
      });
      // 跨币种比较与图表比例一致：统一折算到人民币。
      const scale = estimate.currency === "CNY" ? 1 : usdToCnyRate;
      for (const unit of ["day", "week", "month"]) {
        const slot = ensureSlot(unit, String(row[`${unit}_key`] || ""));
        slot.total += Number(row.total || 0);
        slot.input += Number(row.input || 0);
        slot.cached += Number(row.cached || 0);
        slot.output += Number(row.output || 0);
        slot.reasoning += Number(row.reasoning || 0);
        slot.sessions.add(row.session_id);
        slot.models.add(row.model);
        slot.cost.total += Number(estimate.totalUsd || 0) * scale;
        slot.cost.input += Number(estimate.inputUsd || 0) * scale;
        slot.cost.cached += Number(estimate.cachedInputUsd || 0) * scale;
        slot.cost.output += Number(estimate.outputUsd || 0) * scale;
      }
    }

    const slotValues = (slot) => ({
      totalTokens: slot.total,
      inputTokens: slot.input,
      cachedTokens: slot.cached,
      outputTokens: slot.output,
      reasoningTokens: slot.reasoning,
      sessionCount: slot.sessions.size,
      modelCount: slot.models.size,
      cacheHitRate: slot.input > 0 ? slot.cached / slot.input : null,
      totalCost: slot.cost.total,
      inputCost: slot.cost.input,
      cachedCost: slot.cost.cached,
      outputCost: slot.cost.output,
    });

    const rangeStartMs = range?.start ? range.start.getTime() : null;
    const rangeEndMs = range?.end ? range.end.getTime() : null;
    const records = {};
    for (const [metric, definition] of Object.entries(RECORD_METRICS)) {
      for (const unit of ["day", "week", "month"]) {
        const ranked = [...periods[unit].values()]
          .map((slot) => ({ key: slot.key, value: slotValues(slot)[metric] }))
          .filter((entry) => Number.isFinite(entry.value) && entry.value > 0)
          .sort((left, right) => right.value - left.value);
        if (ranked.length < 2 || ranked[0].value <= ranked[1].value) continue;
        const boundaries = recordUnitBoundaries(ranked[0].key, unit);
        if (!boundaries) continue;
        const [periodStart, periodEnd] = boundaries;
        if (rangeStartMs !== null && periodStart < rangeStartMs) continue;
        if (rangeEndMs !== null && periodEnd - 1 > rangeEndMs) continue;
        records[metric] = {
          title: `${definition.title}的${RECORD_UNIT_LABELS[unit]}`,
          unit,
          period: ranked[0].key,
          value: ranked[0].value,
        };
        break;
      }
    }
    return records;
  }

  summarize(filters = {}, options = {}) {
    this.database.exec("BEGIN");
    try {
      const summary = this.summarizeInReadTransaction(filters, options);
      this.database.exec("COMMIT");
      return summary;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  summarizeInReadTransaction(filters = {}, { includeDetails = true } = {}) {
    const excludeHomes = filters.excludeHomes || [];
    const asOf = filters.now ? new Date(filters.now) : new Date();
    const quota = selectQuotaWindows(this.quotaObservations(), asOf);
    const scope = scopeFilterSql(excludeHomes);
    const bounds = this.database
      .prepare(`SELECT MIN(timestamp_ms) AS minimum, MAX(timestamp_ms) AS maximum FROM events${scope.sql ? ` WHERE ${scope.sql}` : ""}`)
      .get(...scope.params);
    const boundaryEvents = [];
    if (bounds.minimum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.minimum)).toISOString() });
    }
    if (bounds.maximum !== null) {
      boundaryEvents.push({ timestamp: new Date(Number(bounds.maximum)).toISOString() });
    }
    const range = resolveDateRange({ ...filters, now: asOf, quota }, boundaryEvents);
    const aggregate = this.aggregateRange(range, excludeHomes);
    const totals = usageFromRow(aggregate);
    const quotaPreset = isQuotaPreset(range.preset) || Boolean(range.quotaWindow);
    const previousRange = quotaPreset ? null : previousUsageRange(range);
    const previousAggregate = previousRange ? this.aggregateRange(previousRange, excludeHomes) : null;
    const comparison = quotaPreset ? null : usageComparisonFromAggregates({
      range,
      currentTotals: totals,
      previousTotals: usageFromRow(previousAggregate),
      previousEventCount: Number(previousAggregate?.event_count || 0),
      previousSessionCount: Number(previousAggregate?.session_count || 0),
      now: asOf,
    });
    const bucket = range.bucket || (quotaPreset
      ? range.preset === "quota_5h" ? "quota_30m" : "quota_24h"
      : filters.bucket || "day");
    let timeline = [];
    let timelineError = null;
    let costEstimate;
    const costAccumulator = createCostEstimateAccumulator();
    try {
      timeline = this.timelineRange(range, bucket, {
        onEstimate: (event, estimate) => costAccumulator.add(event, estimate),
        excludeHomes,
      });
      costEstimate = costAccumulator.result();
    } catch (error) {
      if (error.code !== "TIMELINE_RANGE_TOO_LARGE") throw error;
      timelineError = error.message;
      costEstimate = this.costEstimateRange(range, excludeHomes);
    }
    const summary = {
      generatedAt: this.generatedAt,
      range: {
        preset: range.preset,
        start: range.start ? range.start.toISOString() : null,
        end: range.end ? range.end.toISOString() : null,
        bucket,
        rolling: Boolean(range.rolling),
        ...(quotaPreset ? {
          quotaWindow: true, recentValue: range.recentValue, quotaPreset: range.quotaPreset,
          asOf: range.asOf.toISOString(),
          windowStart: range.start.toISOString(),
          windowEndExclusive: range.windowEndExclusive.toISOString(),
          observedAt: range.observedAt?.toISOString() || null,
          usedPercent: range.usedPercent,
          percentStale: range.percentStale,
          limitId: range.limitId,
          quotaState: range.quotaState,
          quotaReason: range.quotaReason,
        } : {}),
      },
      totals,
      comparison,
      costEstimate,
      records: quotaPreset || range.preset === "all" ? {} : this.recordsForRange(range, excludeHomes),
      eventCount: Number(aggregate.event_count || 0),
      sessionCount: Number(aggregate.session_count || 0),
      homeCount: Number(aggregate.home_count || 0),
      timeline,
      timelineError,
      quota,
      channels: this.groupedRange("channel", range, "total DESC", excludeHomes),
      models: this.groupedRange("model", range, "total DESC", excludeHomes),
    };
    if (includeDetails) {
      summary.homes = this.groupedRange("home_label", range, "total DESC", excludeHomes);
      summary.projects = this.groupedRange("project", range, "total DESC", excludeHomes);
      summary.repositories = this.repositoriesRange(range, excludeHomes);
    }
    return summary;
  }

  close() {
    if (!this.database) {
      return;
    }
    this.database.close();
    this.database = null;
  }
}
