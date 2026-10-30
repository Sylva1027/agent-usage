/**
 * Count completed visible-output tokens against final lane text and transport
 * receive windows. Invalid contracts return null; tokenizer failures propagate.
 */

import { createRequire } from "node:module";

const TOKENIZER = "o200k_base";
const require = createRequire(import.meta.url);

export const OUTPUT_TIME_RESOLUTION_MS = 100;

/** @type {import("tiktoken").Tiktoken | null} */
let tokenizer = null;

/**
 * @typedef {object} OutputWindow
 * @property {number} startMs
 * @property {number} endMs
 * @property {number} outputTokens
 */

/**
 * @typedef {object} MeasuredOutput
 * @property {"o200k_base"} tokenizer
 * @property {number} outputTokens
 * @property {number} durationMs
 * @property {OutputWindow[]} windows
 * @property {typeof OUTPUT_TIME_RESOLUTION_MS} [samplingWindowMs]
 */

/** @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @returns {value is number} */
function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function getTokenizer() {
  if (tokenizer === null) {
    tokenizer = require("tiktoken").get_encoding(TOKENIZER);
  }
  return tokenizer;
}

function firstTokenEndAfter(tokenEnds, byteOffset) {
  let low = 0;
  let high = tokenEnds.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (tokenEnds[middle] <= byteOffset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function unionDuration(windows) {
  const ordered = windows
    .map(({ startMs, endMs }) => ({ startMs, endMs }))
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  let durationMs = 0;
  let currentStart = null;
  let currentEnd = null;

  for (const window of ordered) {
    if (currentStart === null || currentEnd === null) {
      currentStart = window.startMs;
      currentEnd = window.endMs;
      continue;
    }
    if (window.startMs <= currentEnd) {
      currentEnd = Math.max(currentEnd, window.endMs);
      continue;
    }
    const segment = currentEnd - currentStart;
    if (durationMs > Number.MAX_SAFE_INTEGER - segment) return null;
    durationMs += segment;
    currentStart = window.startMs;
    currentEnd = window.endMs;
  }

  if (currentStart === null || currentEnd === null) return 0;
  const segment = currentEnd - currentStart;
  if (durationMs > Number.MAX_SAFE_INTEGER - segment) return null;
  return durationMs + segment;
}

/**
 * Validate and canonicalize a scalar-only measured-output summary.
 *
 * @param {unknown} raw
 * @returns {MeasuredOutput | null}
 */
export function normalizeMeasuredOutput(raw) {
  if (!isRecord(raw) || raw.tokenizer !== TOKENIZER || !isNonNegativeSafeInteger(raw.outputTokens)) {
    return null;
  }
  if (!isNonNegativeSafeInteger(raw.durationMs) || !Array.isArray(raw.windows) || raw.windows.length === 0) {
    return null;
  }
  const hasSamplingWindow = Object.hasOwn(raw, "samplingWindowMs");
  if (hasSamplingWindow && raw.samplingWindowMs !== OUTPUT_TIME_RESOLUTION_MS) return null;

  /** @type {OutputWindow[]} */
  const windows = [];
  let outputTokens = 0;
  for (const rawWindow of raw.windows) {
    if (
      !isRecord(rawWindow) ||
      !isNonNegativeSafeInteger(rawWindow.startMs) ||
      !isNonNegativeSafeInteger(rawWindow.endMs) ||
      rawWindow.startMs >= rawWindow.endMs ||
      !isNonNegativeSafeInteger(rawWindow.outputTokens) ||
      rawWindow.outputTokens === 0 ||
      (hasSamplingWindow && rawWindow.endMs - rawWindow.startMs < OUTPUT_TIME_RESOLUTION_MS) ||
      outputTokens > Number.MAX_SAFE_INTEGER - rawWindow.outputTokens
    ) {
      return null;
    }
    outputTokens += rawWindow.outputTokens;
    windows.push({
      startMs: rawWindow.startMs,
      endMs: rawWindow.endMs,
      outputTokens: rawWindow.outputTokens,
    });
  }

  const durationMs = unionDuration(windows);
  if (durationMs === null || durationMs === 0 || outputTokens !== raw.outputTokens || durationMs !== raw.durationMs) {
    return null;
  }
  return {
    tokenizer: TOKENIZER,
    outputTokens,
    durationMs,
    windows,
    ...(hasSamplingWindow ? { samplingWindowMs: OUTPUT_TIME_RESOLUTION_MS } : {}),
  };
}

/**
 * Measure final visible-output lanes. Each lane is tokenized exactly once.
 *
 * @param {unknown} lanes
 * @returns {MeasuredOutput | null}
 */
export function measureOutputWindows(lanes) {
  if (!Array.isArray(lanes)) return null;

  const normalizedLanes = [];
  for (const lane of lanes) {
    if (!isRecord(lane) || typeof lane.text !== "string" || !Array.isArray(lane.windows)) {
      return null;
    }
    const textBytes = Buffer.byteLength(lane.text);
    let previousEndBytes = 0;
    let previousEndMs = null;
    const windows = [];
    for (const window of lane.windows) {
      if (
        !isRecord(window) ||
        !isNonNegativeSafeInteger(window.startBytes) ||
        !isNonNegativeSafeInteger(window.endBytes) ||
        !isNonNegativeSafeInteger(window.startMs) ||
        !isNonNegativeSafeInteger(window.endMs) ||
        window.startBytes < previousEndBytes ||
        window.startBytes > window.endBytes ||
        window.endBytes > textBytes ||
        window.startMs > window.endMs ||
        (previousEndMs !== null && window.startMs < previousEndMs)
      ) {
        return null;
      }
      previousEndBytes = window.endBytes;
      previousEndMs = window.endMs;
      windows.push({
        startBytes: window.startBytes,
        endBytes: window.endBytes,
        startMs: window.startMs,
        endMs: window.endMs,
      });
    }
    normalizedLanes.push({ text: lane.text, textBytes, windows });
  }

  if (
    !normalizedLanes.some(
      (lane) =>
        lane.textBytes > 0 &&
        lane.windows.some((window) => window.startBytes < window.endBytes && window.startMs < window.endMs),
    )
  ) {
    return null;
  }

  const encoder = getTokenizer();
  /** @type {OutputWindow[]} */
  const windows = [];
  let outputTokens = 0;
  for (const lane of normalizedLanes) {
    if (lane.textBytes === 0) continue;

    const tokens = encoder.encode_ordinary(lane.text);
    const tokenEnds = [];
    let tokenEndBytes = 0;
    for (const token of tokens) {
      tokenEndBytes += encoder.decode_single_token_bytes(token).length;
      tokenEnds.push(tokenEndBytes);
    }
    if (tokenEndBytes !== lane.textBytes) return null;

    for (const window of lane.windows) {
      if (window.startBytes === window.endBytes || window.startMs === window.endMs) continue;
      const count = firstTokenEndAfter(tokenEnds, window.endBytes) - firstTokenEndAfter(tokenEnds, window.startBytes);
      if (count === 0) continue;
      if (outputTokens > Number.MAX_SAFE_INTEGER - count) return null;
      outputTokens += count;
      windows.push({
        startMs: window.startMs,
        endMs: window.endMs,
        outputTokens: count,
      });
    }
  }

  const durationMs = unionDuration(windows);
  if (durationMs === null || outputTokens === 0 || durationMs === 0) return null;
  return normalizeMeasuredOutput({
    tokenizer: TOKENIZER,
    outputTokens,
    durationMs,
    windows,
  });
}
