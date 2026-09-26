import { statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const cachedLogs = new Map();
const TIER_FIELD = /^service_tier: (None|Some\(None\)|Some\(Some\("(fast|priority|default|standard)"\)\)), collaboration_mode:/;
const SUBMISSION = /Submission sub=Submission \{ id: "[^"]+", op: (TurnInput|ThreadSettings) \{/;

function readTierLog(filePath) {
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
        SELECT id, ts, ts_nanos, thread_id, feedback_log_body
        FROM logs WHERE id > ? AND target = 'codex_core::session::handlers'
          AND thread_id IS NOT NULL AND feedback_log_body LIKE '%service_tier:%'
        ORDER BY id
      `);
      for (const row of statement.iterate(previous.lastId)) {
        const message = row.feedback_log_body || "";
        const operation = SUBMISSION.exec(message)?.[1];
        const masked = message.replace(/"(?:\\.|[^"\\])*"/g, (quoted) => " ".repeat(quoted.length));
        const fieldPosition = masked.indexOf("service_tier: ");
        const field = fieldPosition < 0 ? null : TIER_FIELD.exec(message.slice(fieldPosition));
        if (!operation || !field) continue;
        rows.push({
          threadId: row.thread_id,
          time: Number(row.ts) * 1000 + Math.floor(Number(row.ts_nanos || 0) / 1_000_000),
          id: Number(row.id),
          operation,
          field: field[1],
          tier: field[2] || "unknown",
        });
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

export function loadServiceTierEvidence(homes = []) {
  const filePaths = [...new Set(homes.filter((home) => home.kind !== "project-log" && home.kind !== "zcode")
    .map((home) => path.join(home.path, "logs_2.sqlite")))];
  const byThread = new Map();
  for (const filePath of filePaths) {
    for (const row of readTierLog(filePath)) {
      const entries = byThread.get(row.threadId) || [];
      entries.push(row);
      byThread.set(row.threadId, entries);
    }
  }
  const turnsByThread = new Map();
  for (const [threadId, entries] of byThread) {
    entries.sort((left, right) => left.time - right.time || left.id - right.id);
    const turns = [];
    let setting = "unknown";
    for (const entry of entries) {
      if (entry.operation === "ThreadSettings") {
        if (entry.field !== "None") setting = entry.tier;
      } else {
        turns.push({
          time: entry.time,
          tier: entry.field === "None" ? setting : entry.tier,
        });
      }
    }
    turnsByThread.set(threadId, turns);
  }
  return {
    resolve(threadId, timestampMs, recordedTier = "unknown") {
      if (["fast", "priority", "default", "standard"].includes(recordedTier)) return recordedTier;
      const turns = turnsByThread.get(threadId);
      if (!turns?.length || !Number.isFinite(timestampMs)) return "unknown";
      let low = 0;
      let high = turns.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (turns[middle].time <= timestampMs) low = middle + 1;
        else high = middle;
      }
      return low ? turns[low - 1].tier : "unknown";
    },
  };
}
