// Offline investigation reference; the application does not import this reader.
import { open } from "node:fs/promises";

import {
  generationMatchesKnownReasoning,
  mergeRequestTimingEvidence,
  normalizeGenerationTiming,
} from "../src/perf-request-timing.js";

export const MAGPIE_TIMING_ORIGIN = "magpie-local-request-e2e-v1";

const CODEX_ENDPOINT = /^\/(?:backend-api\/codex\/responses|v1\/responses)(?:$|\?| → \/)/;
const CLAUDE_ENDPOINT = /^\/(?:(?:anthropic|claude)\/)?v1\/messages(?:$|\?| → \/)/;
const CLAUDE_AGENTS = new Set(["claude", "claude-code", "claude-desktop"]);

/**
 * @typedef {object} MagpieRequestTimingLookup
 * @property {"missing" | "available" | "conflict"} state
 * @property {number | null} durationMs
 * @property {number | null} reportedOutputTokens
 * @property {string} requestedModel
 * @property {import("../src/perf-request-timing.js").GenerationTiming | null} generation
 */

function knownNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function firstKnownInteger(row, fields) {
  for (const field of fields) {
    const value = knownNonNegativeInteger(row[field]);
    if (value !== null) return value;
  }
  return null;
}

function confirmedOneShot(row) {
  return row.single_chunk === true || row.one_shot === true || row.streamed === false;
}

function reasoningForRow(row, nativeReasoningTokens) {
  const native = knownNonNegativeInteger(nativeReasoningTokens);
  if (native !== null) return native;
  return knownNonNegativeInteger(row.reasoning);
}

/**
 * @param {Record<string, unknown>} row
 * @param {number | null | undefined} reasoningTokens
 * @returns {import("../src/perf-request-timing.js").GenerationTiming | null}
 */
function generationWindow(row, reasoningTokens) {
  if (row.generation !== undefined) {
    try {
      return normalizeGenerationTiming(row.generation);
    } catch {
      return null;
    }
  }

  const reportedOutputTokens = knownNonNegativeInteger(row.out);
  const durationMs = knownNonNegativeInteger(row.ms);
  const reasoning = reasoningForRow(row, reasoningTokens);
  if (reportedOutputTokens === null || durationMs === null || durationMs <= 0 || reasoning === null) return null;
  if (reasoning > reportedOutputTokens) return null;

  const outputTokens = reportedOutputTokens - reasoning;
  if (outputTokens <= 0 || confirmedOneShot(row)) return null;
  const firstOutputMs = firstKnownInteger(row, ["first_output_ms", "first_content_ms"]);
  const lastOutputMs = firstKnownInteger(row, ["last_output_ms", "last_content_ms"]);
  const firstOutputTokens = firstKnownInteger(row, ["first_output_tokens", "first_content_tokens"]);
  const startOutputTokens = firstOutputTokens === null ? 1 : firstOutputTokens;

  if (
    startOutputTokens < outputTokens &&
    firstOutputMs !== null &&
    lastOutputMs !== null &&
    firstOutputMs < lastOutputMs &&
    lastOutputMs <= durationMs
  ) {
    return {
      outputTokens,
      durationMs: lastOutputMs - firstOutputMs,
      startOutputTokens,
      timingKind: "first_last_output",
    };
  }

  const explicitDurationMs = firstKnownInteger(row, ["generation_ms", "output_ms", "decode_ms"]);
  if (explicitDurationMs !== null && explicitDurationMs > 0 && explicitDurationMs <= durationMs) {
    return {
      outputTokens,
      durationMs: explicitDurationMs,
      startOutputTokens: 0,
      timingKind: "explicit",
    };
  }

  if (row.stop === "tool_calls" || row.stop === "tool_use") return null;

  if (startOutputTokens >= outputTokens) return null;

  if (firstOutputMs !== null && firstOutputMs < durationMs) {
    return {
      outputTokens,
      durationMs: durationMs - firstOutputMs,
      startOutputTokens,
      timingKind: "first_output_response_end",
    };
  }

  const firstTextMs = firstKnownInteger(row, ["first_text_ms"]);
  const ttftMs = firstKnownInteger(row, ["ttft_ms"]);
  if (firstTextMs !== null && ttftMs === firstTextMs && firstTextMs < durationMs) {
    return {
      outputTokens,
      durationMs: durationMs - firstTextMs,
      startOutputTokens: 1,
      timingKind: "first_output_response_end",
    };
  }
  return null;
}

/**
 * Build one generation window from a Magpie ledger row. The raw totals remain
 * on the evidence record; this helper only selects a matching timing boundary.
 *
 * @param {Record<string, unknown>} row
 * @param {number | null | undefined} [nativeReasoningTokens]
 * @returns {import("../src/perf-request-timing.js").GenerationTiming | null}
 */
export function generationFromMagpieRow(row, nativeReasoningTokens) {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
  return generationWindow(row, nativeReasoningTokens);
}

function supportedLedgerRow(row) {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return false;
  if (
    row.status !== 200 ||
    typeof row.response_id !== "string" ||
    row.response_id.trim() === "" ||
    !Number.isSafeInteger(row.out) ||
    row.out < 0 ||
    !Number.isSafeInteger(row.ms) ||
    row.ms <= 0 ||
    (row.tries !== undefined && (!Number.isSafeInteger(row.tries) || row.tries < 1)) ||
    (row.retried_ms !== undefined && (!Number.isSafeInteger(row.retried_ms) || row.retried_ms < 0)) ||
    row.handed_on === true ||
    row.err ||
    row.rejected ||
    (row.stop &&
      !["completed", "stop", "tool_calls", "tool_use", "end_turn", "stop_sequence", "length", "max_tokens"].includes(
        row.stop,
      )) ||
    typeof row.ep !== "string"
  ) {
    return false;
  }
  if (row.agent === "codex") return CODEX_ENDPOINT.test(row.ep);
  if (CLAUDE_AGENTS.has(row.agent)) return CLAUDE_ENDPOINT.test(row.ep);
  return false;
}

function requestedModelFor(row) {
  if (typeof row.req === "string" && row.req.trim() !== "") return row.req;
  if (CLAUDE_AGENTS.has(row.agent) && typeof row.model === "string" && row.model.trim() !== "") return row.model;
  return "";
}

function timingSource(row) {
  return {
    out: row.out,
    ms: row.ms,
    reasoning: knownNonNegativeInteger(row.reasoning),
    reasoning_hidden: row.reasoning_hidden,
    generation: row.generation,
    first_output_ms: knownNonNegativeInteger(row.first_output_ms),
    first_content_ms: knownNonNegativeInteger(row.first_content_ms),
    last_output_ms: knownNonNegativeInteger(row.last_output_ms),
    last_content_ms: knownNonNegativeInteger(row.last_content_ms),
    first_output_tokens: knownNonNegativeInteger(row.first_output_tokens),
    first_content_tokens: knownNonNegativeInteger(row.first_content_tokens),
    generation_ms: knownNonNegativeInteger(row.generation_ms),
    output_ms: knownNonNegativeInteger(row.output_ms),
    decode_ms: knownNonNegativeInteger(row.decode_ms),
    first_text_ms: knownNonNegativeInteger(row.first_text_ms),
    ttft_ms: knownNonNegativeInteger(row.ttft_ms),
    flow_ms: Object.hasOwn(row, "flow_ms") ? row.flow_ms : undefined,
    flow: row.flow,
    single_chunk: row.single_chunk,
    one_shot: row.one_shot,
    streamed: row.streamed,
    stop: row.stop,
  };
}

/**
 * @param {"missing" | "available" | "conflict"} state
 * @returns {MagpieRequestTimingLookup}
 */
function emptyTimingLookup(state) {
  return {
    state,
    durationMs: null,
    reportedOutputTokens: null,
    requestedModel: "",
    generation: null,
  };
}

/** Read only request identity, model, output, elapsed time, and timing scalars from the local gateway ledger. */
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
    /** @type {Map<string, Map<string, {requestedModel: string, reportedModel: string, provider: string, outputTokens: number, durationMs: number, source: Record<string, unknown>}>>} */
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
    if (!supportedLedgerRow(row)) return;
    const requestedModel = requestedModelFor(row);
    if (requestedModel === "") return;

    const record = {
      requestedModel,
      reportedModel: typeof row.model === "string" ? row.model : "",
      provider: typeof row.provider === "string" ? row.provider : "",
      outputTokens: row.out,
      durationMs: row.ms,
      source: timingSource(row),
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
   * @param {number | null | undefined} [nativeReasoningTokens] known non-negative native reasoning count
   * @returns {import("../src/perf-request-timing.js").RequestTimingEvidence[]}
   */
  recordsForRequest(responseId, model, _outputTokens, nativeReasoningTokens) {
    if (typeof model !== "string" || model === "") return [];
    const rows = [...(this.requests.get(responseId)?.values() ?? [])];
    return rows.map((row) => ({
      schemaVersion: 2,
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
      generation: generationFromMagpieRow(row.source, nativeReasoningTokens),
    }));
  }

  /**
   * Resolve one in-memory response without guessing which home owns it. The
   * caller-supplied model and total output must match the selected evidence.
   *
   * @param {{responseId: string, model: string, outputTokens: number, reasoningOutputTokens?: number | null}} query
   * @returns {MagpieRequestTimingLookup}
   */
  lookupRequestTiming(query) {
    if (query === null || typeof query !== "object" || Array.isArray(query)) {
      throw new TypeError("Timing lookup query must be an object");
    }
    if (typeof query.responseId !== "string" || query.responseId === "") return emptyTimingLookup("missing");

    const records = this.recordsForRequest(
      query.responseId,
      query.model,
      query.outputTokens,
      query.reasoningOutputTokens,
    );
    const sources = [...(this.requests.get(query.responseId)?.values() ?? [])];
    if (
      sources.some((row, index) => {
        const record = records[index];
        return (
          record !== undefined &&
          !generationMatchesKnownReasoning(
            record.generation ?? null,
            record.reportedOutputTokens,
            reasoningForRow(row.source, query.reasoningOutputTokens),
          )
        );
      })
    ) {
      return emptyTimingLookup("conflict");
    }
    const merged = mergeRequestTimingEvidence(records);
    if (merged.state !== "available" || merged.evidence === null) return emptyTimingLookup(merged.state);
    if (
      !Number.isSafeInteger(query.outputTokens) ||
      query.outputTokens < 0 ||
      merged.evidence.requestedModel !== query.model ||
      merged.evidence.reportedOutputTokens !== query.outputTokens
    ) {
      return emptyTimingLookup("conflict");
    }
    return {
      state: "available",
      durationMs: merged.evidence.durationMs,
      reportedOutputTokens: merged.evidence.reportedOutputTokens,
      requestedModel: merged.evidence.requestedModel,
      generation: merged.evidence.generation ?? null,
    };
  }
}
