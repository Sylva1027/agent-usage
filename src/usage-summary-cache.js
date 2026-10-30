import { createHash } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildModelActivity } from "../public/pricing-models.js";
import { calendarPresetRange } from "../public/period-comparison.js";
import { automaticPricingFile, pricingFile } from "./pricing-store.js";
import { readRequestTimingRevision } from "./perf-request-timing-store.js";
import {
  buildUsageFingerprint,
  discoverUsageSources,
  QUOTA_PERCENT_STALE_AFTER_MS,
  usageComparisonFromAggregates,
} from "./usage-core.js";
import { workbuddyTraceFiles } from "./workbuddy-usage.js";
import { readCodexQuotaObservations } from "./codex-quota-cache.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
// Bump when payload formulas or executor snapshot semantics change.
const SUMMARY_CACHE_VERSION = 1;

/** Recompute clock fields from cached aggregates, using the shared formulas. */
export function refreshSummaryClock(payload, now) {
  const summary = payload.summary;
  const range = summary.range;
  const comparison = summary.comparison;
  const quota = summary.quota;
  const asOf = now.toISOString();
  if (quota) {
    quota.asOf = asOf;
    for (const window of Object.values(quota.windows || {})) {
      if (window.state === "available") {
        window.percentStale = now.getTime() - Date.parse(window.observedAt) > QUOTA_PERCENT_STALE_AFTER_MS;
      }
    }
  }
  if (range.quotaWindow) {
    range.asOf = asOf;
    range.end = new Date(Math.min(now.getTime(), Date.parse(range.windowEndExclusive)) - 1).toISOString();
    range.percentStale = now.getTime() - Date.parse(range.observedAt) > QUOTA_PERCENT_STALE_AFTER_MS;
    for (const row of summary.timeline || []) {
      if (Number.isFinite(row.slotStartMs)) row.future = row.slotStartMs >= now.getTime();
    }
  }
  if (comparison) {
    summary.comparison = usageComparisonFromAggregates({
      range: {
        ...range,
        start: range.start ? new Date(range.start) : null,
        end: range.end ? new Date(range.end) : null,
      },
      currentTotals: summary.totals,
      previousTotals: comparison.previousTotals,
      previousEventCount: comparison.previousEventCount,
      previousSessionCount: comparison.previousSessionCount,
      previousRange: comparison.previousRange
        ? { start: new Date(comparison.previousRange.start), end: new Date(comparison.previousRange.end) }
        : null,
      now,
    });
  }
  const observations = Object.entries(payload.metadata.modelLastSeen || {}).flatMap(([harness, models]) =>
    Object.entries(models).map(([model, timestamp]) => ({ harness, model, timestamp })),
  );
  Object.assign(payload.metadata, buildModelActivity(observations, now));
  payload.periodComparison.asOf = asOf;
  return payload;
}

export function summaryCacheKey(filters, includeDetails, pricing) {
  if (filters.preset === "recent" && String(filters.recentValue || "").replace(/\s+/g, "") === "1天") return null;
  const { now = new Date(), pricingModels: _models, ...shape } = filters;
  const day = calendarPresetRange("today", new Date(now), filters.calendarZone);
  return digest(
    JSON.stringify({
      ...shape,
      version: SUMMARY_CACHE_VERSION,
      excludeHomes: [...(shape.excludeHomes || [])].sort(),
      includeDetails,
      day: day.start.toISOString(),
      pricing,
    }),
  );
}

/** Small persistent results; the source index is opened only for short read queries. */
export class UsageSummaryCache {
  constructor(options = {}) {
    this.options = options;
    this.databaseFile =
      options.databaseFile || path.join(options.homeDir || os.homedir(), ".codex-usage", "usage-index.sqlite");
    this.file = `${this.databaseFile}.summaries.sqlite`;
    this.database = null;
    this.source = null;
    this.sourceIdentity = "";
    this.publication = null;
    this.observedVersion = null;
    this.samePublicationRevision = 0;
  }

  async open() {
    if (this.database) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    if (this.database) return;
    this.database = new DatabaseSync(this.file);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS summary_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), signature TEXT, state TEXT);
      INSERT OR IGNORE INTO summary_state VALUES (1, NULL, NULL);
      CREATE TABLE IF NOT EXISTS summaries (key TEXT PRIMARY KEY, signature TEXT NOT NULL, created_at REAL NOT NULL, valid_until REAL NOT NULL, payload TEXT NOT NULL);
    `);
    this.readState = this.database.prepare("SELECT signature,state FROM summary_state WHERE singleton = 1");
    this.readEntry = this.database.prepare("SELECT * FROM summaries WHERE key = ?");
    this.writeEntry = this.database.prepare("INSERT OR REPLACE INTO summaries VALUES (?, ?, ?, ?, ?)");
    const retained = this.readState.get();
    if (retained.state) {
      let saved;
      try {
        saved = JSON.parse(String(retained.state));
      } catch {
        // Rebuildable state must not prevent a fresh index query.
      }
      if (saved?.version !== SUMMARY_CACHE_VERSION) {
        this.database.exec("DELETE FROM summaries; UPDATE summary_state SET signature = NULL, state = NULL");
        return;
      }
      if (saved.publication && this.observedVersion === null) {
        this.publication = saved.publication;
        this.samePublicationRevision = Number(saved.publication.revision || 0);
      }
    }
  }

  async readSourceState(options = this.options) {
    await this.open();
    const homes = await discoverUsageSources(options);
    const usage = await buildUsageFingerprint({ ...options, homes });
    const files = new Set(
      [pricingFile(options), automaticPricingFile(options), options.importStoreFile].filter(Boolean),
    );
    for (const home of homes) {
      for (const name of ["config.toml", "settings.json", "config.json", "logs_2.sqlite", "logs_2.sqlite-wal"]) {
        files.add(path.join(home.path, name));
      }
      if (home.kind === "workbuddy") for (const file of await workbuddyTraceFiles(home.path)) files.add(file);
    }
    const input = createHash("sha256").update(`summary-v${SUMMARY_CACHE_VERSION}\0`).update(usage.fingerprint);
    const routing = createHash("sha256").update(usage.fingerprint);
    const quotaInput = JSON.stringify(readCodexQuotaObservations({ ...options, homes }));
    input.update("\0quota\0").update(quotaInput);
    routing.update("\0quota\0").update(quotaInput);
    const priceFiles = new Set([pricingFile(options), automaticPricingFile(options)]);
    for (const file of [...files].sort()) {
      let observation;
      try {
        const info = await stat(file);
        observation = JSON.stringify([file, info.size, info.mtimeMs]);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        observation = JSON.stringify([file, "missing"]);
      }
      input.update(observation);
      if (!priceFiles.has(file)) routing.update(observation);
    }
    const inputs = input.digest("hex");
    const publication = await this.readPublication();
    return {
      ...usage,
      inputs,
      routingFingerprint: routing.digest("hex"),
      publication,
      signature: digest(`${inputs}\0${publication?.signature || ""}`),
    };
  }

  async readPublication() {
    try {
      const info = await stat(this.databaseFile);
      const identity = `${info.dev}:${info.ino}`;
      if (this.source && identity !== this.sourceIdentity) {
        this.source.close();
        this.source = null;
        this.publication = null;
      }
      if (!this.source) {
        this.source = new DatabaseSync(this.databaseFile, { readOnly: true });
        this.source.exec("PRAGMA busy_timeout = 0");
        this.sourceIdentity = identity;
      }
      const hash = createHash("sha256");
      const versionBefore = Number(this.source.prepare("PRAGMA data_version").get().data_version);
      this.source.exec("BEGIN");
      let rawTimingRevision, publishedRevision, pending, indexVersion;
      try {
        for (const row of this.source.prepare("SELECT key,value FROM store_meta ORDER BY key").iterate()) {
          hash.update(String(row.key)).update("\0").update(String(row.value)).update("\0");
        }
        rawTimingRevision = readRequestTimingRevision(this.source);
        publishedRevision = Number(
          this.source.prepare("SELECT value FROM store_meta WHERE key = 'perf_request_timing_published_revision'").get()
            ?.value || 0,
        );
        pending =
          Boolean(this.source.prepare("SELECT 1 FROM perf_request_timing_dirty_threads LIMIT 1").get()) ||
          rawTimingRevision !== publishedRevision;
        indexVersion =
          this.source.prepare("SELECT value FROM store_meta WHERE key = 'perf_index_version'").get()?.value || "";
      } finally {
        this.source.exec("ROLLBACK");
      }
      const version = Number(this.source.prepare("PRAGMA data_version").get().data_version);
      if (version !== versionBefore) return null;
      const timingRevision = pending ? String(rawTimingRevision) : "";
      const durable = hash.update(String(timingRevision)).update(String(pending)).digest("hex");
      if (this.publication?.durable !== durable) this.samePublicationRevision = 0;
      else if (this.observedVersion !== null && version !== this.observedVersion) this.samePublicationRevision += 1;
      this.observedVersion = version;
      this.publication = {
        durable,
        revision: this.samePublicationRevision,
        signature: `${durable}:${this.samePublicationRevision}`,
        indexVersion,
        timingRevision,
        pending,
      };
      return this.publication;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (/locked|busy|no such table/.test(error.message)) return null;
      throw error;
    }
  }

  async stateFor(source) {
    await this.open();
    const row = this.readState.get();
    if (row.signature !== source.signature || !row.state) return null;
    const saved = JSON.parse(String(row.state));
    return saved.executor || saved;
  }

  async get(key, source, now) {
    if (!key) return null;
    await this.open();
    if (!source.publication || source.publication.pending) return null;
    const row = this.readEntry.get(key);
    if (
      !row ||
      row.signature !== source.signature ||
      now.getTime() < Number(row.created_at) ||
      now.getTime() >= Number(row.valid_until)
    )
      return null;
    let payload;
    try {
      payload = JSON.parse(String(row.payload));
    } catch {
      this.database.prepare("DELETE FROM summaries WHERE key = ?").run(key);
      return null;
    }
    return refreshSummaryClock(payload, now);
  }

  async publish(key, payload, state, source, now) {
    if (!key) return;
    await this.open();
    if (!this.source || !source.publication || source.publication.pending) return;
    // Cold carriers must be verified by their existing readers, including missing-segment checks.
    if (this.source.prepare("SELECT 1 FROM archive_segments LIMIT 1").get()) return;
    const next = this.source
      .prepare(`SELECT MIN(boundary) AS boundary FROM (
      SELECT MIN(timestamp_ms) AS boundary FROM events WHERE timestamp_ms >= ?
      UNION ALL SELECT MIN(ts_ms) FROM perf_samples WHERE ts_ms >= ?
      UNION ALL SELECT MIN(observed_at_ms) FROM rate_limit_observations WHERE observed_at_ms >= ?
      UNION ALL SELECT MIN(resets_at_ms) FROM rate_limit_observations WHERE resets_at_ms >= ?
      UNION ALL SELECT MIN(resets_at_ms - window_minutes * 60000) FROM rate_limit_observations WHERE resets_at_ms - window_minutes * 60000 >= ?
    )`)
      .get(...Array(5).fill(now.getTime())).boundary;
    const day = calendarPresetRange("today", now, payload.summary.range.calendarZone);
    const quotaResets = Object.values(payload.summary.quota?.windows || {})
      .filter((window) => window.state === "available")
      .map((window) => Date.parse(window.windowEndExclusive))
      .filter((time) => Number.isFinite(time) && time >= now.getTime());
    const validUntil = Math.min(day.end.getTime() + 1, next === null ? Infinity : Number(next), ...quotaResets);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (this.readState.get().signature !== source.signature) this.database.exec("DELETE FROM summaries");
      this.writeEntry.run(key, source.signature, now.getTime(), validUntil, JSON.stringify(payload));
      this.database
        .prepare("UPDATE summary_state SET signature = ?, state = ? WHERE singleton = 1")
        .run(
          source.signature,
          JSON.stringify({ version: SUMMARY_CACHE_VERSION, executor: state, publication: source.publication }),
        );
      this.database.exec(
        "DELETE FROM summaries WHERE key IN (SELECT key FROM summaries ORDER BY created_at DESC LIMIT -1 OFFSET 32)",
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async invalidate() {
    await this.open();
    this.database.exec("DELETE FROM summaries; UPDATE summary_state SET signature = NULL, state = NULL");
  }

  close() {
    this.source?.close();
    this.database?.close();
    this.source = null;
    this.database = null;
  }
}

export function publishedSummarySource(before, after) {
  return {
    ...after,
    inputs: before.inputs,
    fingerprint: before.fingerprint,
    routingFingerprint: before.routingFingerprint,
    signature: digest(`${before.inputs}\0${after.publication?.signature || ""}`),
  };
}
