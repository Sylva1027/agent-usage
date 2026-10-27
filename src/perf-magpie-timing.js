import { open } from "node:fs/promises";

export const MAGPIE_TIMING_ORIGIN = "magpie-local-request-e2e-v1";

// shortcut: cross-entry fallback lacks a linked start; extend timing when the ledger records that chain.
/** Read only request identity, model, output and elapsed time from the local gateway ledger. */
export class MagpieRequestTimings {
  constructor() {
    this.revision = 0;
    /** @type {Set<string>} */
    this.pendingResponseIds = new Set();
    this.clear();
  }

  clear() {
    // Reset invalidates associations without acknowledging unpublished changes.
    this.revision += 1;
    this.pendingReset = true;
    this.filePath = "";
    this.identity = "";
    this.offset = 0;
    this.mtimeMs = 0;
    /** @type {Map<string, Map<string, {requestedModel: string, reportedModel: string, provider: string, outputTokens: number, durationMs: number}>>} */
    this.requests = new Map();
  }

  /** @returns {{revision: number, responseIds: Set<string>, reset: boolean}} */
  pendingChanges() {
    return {
      revision: this.revision,
      responseIds: new Set(this.pendingResponseIds),
      reset: this.pendingReset,
    };
  }

  /** @param {number} revision */
  acknowledge(revision) {
    if (revision !== this.revision) return false;
    this.pendingResponseIds.clear();
    this.pendingReset = false;
    return true;
  }

  /** @param {string} filePath */
  async read(filePath) {
    let file;
    try {
      file = await open(filePath, "r");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (this.filePath) this.clear();
      return false;
    }
    try {
      const stat = await file.stat();
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      if (
        filePath !== this.filePath ||
        identity !== this.identity ||
        stat.size < this.offset ||
        (stat.size === this.offset && stat.mtimeMs !== this.mtimeMs)
      ) {
        this.clear();
        this.filePath = filePath;
        this.identity = identity;
      }
      if (stat.size === this.offset) {
        this.mtimeMs = stat.mtimeMs;
        return false;
      }
      const buffer = Buffer.alloc(64 * 1024);
      let position = this.offset;
      let pending = Buffer.alloc(0);
      while (position < stat.size) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - position), position);
        if (bytesRead === 0) break;
        position += bytesRead;
        const bytes = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
        let start = 0;
        let end = bytes.indexOf(10, start);
        while (end !== -1) {
          this.addLine(bytes.subarray(start, end).toString("utf8"));
          start = end + 1;
          end = bytes.indexOf(10, start);
        }
        pending = Buffer.from(bytes.subarray(start));
      }
      // An unfinished append is retried from its first byte on the next sync.
      this.offset = position - pending.length;
      this.mtimeMs = stat.mtimeMs;
      return true;
    } finally {
      await file.close();
    }
  }

  /** @param {string} line */
  addLine(line) {
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return;
    }
    if (
      row?.agent !== "codex" ||
      row.status !== 200 ||
      typeof row.response_id !== "string" ||
      row.response_id.trim() === "" ||
      typeof row.req !== "string" ||
      row.req.trim() === "" ||
      !Number.isSafeInteger(row.out) ||
      row.out < 0 ||
      !Number.isSafeInteger(row.ms) ||
      row.ms <= 0 ||
      (row.tries !== undefined && (!Number.isSafeInteger(row.tries) || row.tries < 1)) ||
      (row.retried_ms !== undefined && (!Number.isSafeInteger(row.retried_ms) || row.retried_ms < 0)) ||
      row.handed_on === true ||
      row.err ||
      row.rejected ||
      (row.stop && !["completed", "stop", "tool_calls", "end_turn", "length", "max_tokens"].includes(row.stop)) ||
      typeof row.ep !== "string" ||
      !/^\/(?:backend-api\/codex\/responses|v1\/responses)(?:$| → \/)/.test(row.ep)
    )
      return;
    const record = {
      requestedModel: row.req,
      reportedModel: typeof row.model === "string" ? row.model : "",
      provider: typeof row.provider === "string" ? row.provider : "",
      outputTokens: row.out,
      durationMs: row.ms,
    };
    const variants = this.requests.get(row.response_id) ?? new Map();
    const key = JSON.stringify(record);
    if (variants.has(key)) return;
    variants.set(key, record);
    this.requests.set(row.response_id, variants);
    this.pendingResponseIds.add(row.response_id);
    this.revision += 1;
  }

  /**
   * @param {string} responseId
   * @param {string} model
   * @param {number} _outputTokens checked against the native request by the timing kernel
   * @returns {import("./perf-request-timing.js").RequestTimingEvidence[]}
   */
  recordsForRequest(responseId, model, _outputTokens) {
    if (typeof model !== "string" || model === "") return [];
    const rows = [...(this.requests.get(responseId)?.values() ?? [])];
    return rows.map((row) => ({
      schemaVersion: 1,
      evidenceOrigin: MAGPIE_TIMING_ORIGIN,
      responseId,
      // Codex's own provider explicitly routes codex/model to the same bare model.
      requestedModel:
        row.provider === "codex" && row.requestedModel === `codex/${model}` && row.reportedModel === model
          ? model
          : row.requestedModel,
      reportedOutputTokens: row.outputTokens,
      durationMs: row.durationMs,
      status: "completed",
      completedAtMs: null,
    }));
  }
}
