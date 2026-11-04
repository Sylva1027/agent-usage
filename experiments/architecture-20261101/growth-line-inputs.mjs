import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { finished } from "node:stream/promises";
import { createZstdCompress } from "node:zlib";

const GROWTH_START_MS = Date.parse("2026-08-01T00:00:00.000Z");
const GROWTH_END_MS = GROWTH_START_MS + 90 * 24 * 60 * 60 * 1000;
const GROWTH_SPAN_MS = GROWTH_END_MS - GROWTH_START_MS;
const KINDS = new Set(["codex", "dsh", "claude", "workbuddy"]);
const KEY_PATTERN = /^[A-Za-z0-9]{1,32}$/;
const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PADDING_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const MAX_PADDING_CHARS = 256 * 1024;
const PREFIX_ROWS = Object.freeze({ codex: 2, dsh: 2, claude: 0, workbuddy: 1 });

function requireInteger(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function scaledInteger(value, scale, label) {
  const result = value * scale;
  if (!Number.isSafeInteger(result)) {
    throw new TypeError(`${label} * scale exceeds the safe integer range`);
  }
  return result;
}

function normalizeFile(file, scale) {
  if (!file || typeof file !== "object" || Array.isArray(file)) {
    throw new TypeError("each file must be an object");
  }
  if (typeof file.key !== "string" || !KEY_PATTERN.test(file.key)) {
    throw new TypeError("file.key must be a 1-32 character alphanumeric id");
  }
  if (!KINDS.has(file.kind)) {
    throw new TypeError(`unsupported file kind: ${file.kind}`);
  }
  if (typeof file.compressed !== "boolean") {
    throw new TypeError(`${file.key}.compressed must be a boolean`);
  }
  if (file.kind === "dsh" && !file.compressed) {
    throw new TypeError(`${file.key}: DSH input is always session.v4.jsonl.zstd`);
  }
  if ((file.kind === "claude" || file.kind === "workbuddy") && file.compressed) {
    throw new TypeError(`${file.key}: ${file.kind} line inputs are plain JSONL`);
  }
  if (typeof file.sessionKey !== "string" || !SESSION_PATTERN.test(file.sessionKey)) {
    throw new TypeError(`${file.key}.sessionKey must be a safe synthetic session id`);
  }

  const events = requireInteger(file.events, `${file.key}.events`);
  const rows = requireInteger(file.rows, `${file.key}.rows`);
  if (rows < events) {
    throw new TypeError(`${file.key}.rows must be at least events`);
  }
  const decodedBytes = requireInteger(file.decodedBytes, `${file.key}.decodedBytes`, 1);
  const sourceBytes = requireInteger(file.sourceBytes, `${file.key}.sourceBytes`, 1);
  const frames = requireInteger(file.frames, `${file.key}.frames`);
  const quotaObservations =
    file.kind === "codex" ? requireInteger(file.quotaObservations, `${file.key}.quotaObservations`) : 0;
  if (file.kind === "dsh" && frames < 1) {
    throw new TypeError(`${file.key}: compressed DSH inputs need at least one baseline frame`);
  }
  if (!file.compressed && frames !== 0) {
    throw new TypeError(`${file.key}: plain inputs must use frames=0`);
  }

  const eventCount = scaledInteger(events, scale, `${file.key}.events`);
  const quotaObservationCount = scaledInteger(quotaObservations, scale, `${file.key}.quotaObservations`);
  const targetRows = scaledInteger(rows, scale, `${file.key}.rows`);
  const quotaOnlyRows = Math.max(0, Math.ceil((quotaObservationCount - eventCount * 2) / 2));
  const requiredRows = PREFIX_ROWS[file.kind] + eventCount + quotaOnlyRows;
  return {
    ...file,
    events: eventCount,
    quotaObservations: quotaObservationCount,
    quotaOnlyRows,
    targetRows,
    rowCount: Math.max(targetRows, requiredRows),
    prefixRows: PREFIX_ROWS[file.kind],
    targetDecodedBytes: scaledInteger(decodedBytes, scale, `${file.key}.decodedBytes`),
    targetSourceBytes: scaledInteger(sourceBytes, scale, `${file.key}.sourceBytes`),
    targetFrames: scaledInteger(frames, scale, `${file.key}.frames`),
  };
}

function buildEventOrdinals(files) {
  const ordinals = files.map((file) => new Float64Array(file.events));
  const previous = new Int32Array(files.length);
  const next = new Int32Array(files.length);
  previous.fill(-1);
  next.fill(-1);
  const endingAt = new Map();
  let head = -1;
  let tail = -1;

  for (let index = 0; index < files.length; index += 1) {
    const count = files[index].events;
    if (count === 0) continue;
    previous[index] = tail;
    if (tail === -1) head = index;
    else next[tail] = index;
    tail = index;
    const ending = endingAt.get(count);
    if (ending) ending.push(index);
    else endingAt.set(count, [index]);
  }

  let ordinal = 0;
  let round = 0;
  while (head !== -1) {
    for (let index = head; index !== -1; index = next[index]) {
      ordinals[index][round] = ordinal;
      ordinal += 1;
    }
    round += 1;
    for (const index of endingAt.get(round) || []) {
      const before = previous[index];
      const after = next[index];
      if (before === -1) head = after;
      else next[before] = after;
      if (after === -1) tail = before;
      else previous[after] = before;
    }
  }
  return ordinals;
}

function eventTimestamp(ordinal, eventCount) {
  if (eventCount <= 1) return GROWTH_START_MS;
  return GROWTH_START_MS + Math.floor((ordinal * GROWTH_SPAN_MS) / (eventCount - 1));
}

function iso(timestampMs) {
  return new Date(timestampMs).toISOString();
}

function syntheticCwd(file) {
  return `/synthetic/${file.kind}/${file.key}`;
}

function syntheticEventId(file, ordinal) {
  return `${file.key}:${ordinal}`;
}

function hashSeed(file) {
  return createHash("sha256").update(`${file.kind}\0${file.key}\0${file.sessionKey}`).digest().readUInt32LE(0);
}

function paddingAlphabet(file) {
  const ratio = Math.max(1 / 64, Math.min(1, file.targetSourceBytes / file.targetDecodedBytes));
  const bits = Math.max(1, Math.min(6, Math.round(ratio * 8)));
  return PADDING_ALPHABET.slice(0, 2 ** bits);
}

function mixedSeed(value) {
  let mixed = (value + 0x9e3779b9) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
  return (mixed ^ (mixed >>> 15)) >>> 0;
}

function deterministicPadding(length, alphabet, seed) {
  let state = mixedSeed(seed);
  const parts = [];
  let remaining = length;
  while (remaining > 0) {
    const size = Math.min(remaining, 8192);
    const bytes = Buffer.allocUnsafe(size);
    for (let index = 0; index < size; index += 1) {
      state = (state + 0x9e3779b9) >>> 0;
      let mixed = state;
      mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad);
      mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
      mixed ^= mixed >>> 15;
      bytes[index] = alphabet.charCodeAt((mixed >>> 0) % alphabet.length);
    }
    parts.push(bytes.toString("latin1"));
    remaining -= size;
  }
  return parts.join("");
}

function workflowUuid(file) {
  const hex = createHash("sha256").update(`workbuddy\0${file.sessionKey}\0${file.key}`).digest("hex");
  const chars = hex.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  return `${chars.slice(0, 8).join("")}-${chars.slice(8, 12).join("")}-${chars.slice(12, 16).join("")}-${chars
    .slice(16, 20)
    .join("")}-${chars.slice(20).join("")}`;
}

function targetPath(root, file) {
  if (file.kind === "codex") {
    return path.join(
      root,
      ".codex",
      "sessions",
      "fixture",
      file.compressed ? `${file.key}.jsonl.zst` : `${file.key}.jsonl`,
    );
  }
  if (file.kind === "dsh") {
    return path.join(root, ".dsh", "sessions", "fixture", file.key, "session.v4.jsonl.zstd");
  }
  if (file.kind === "claude") {
    return path.join(root, ".claude", "projects", "fixture", `${file.key}.jsonl`);
  }
  return path.join(root, ".workbuddy-ai", "projects", "fixture", `${workflowUuid(file)}.jsonl`);
}

function codexRateLimits(timestampMs, roles) {
  if (roles.length === 0) return undefined;
  const limits = { limit_id: "codex" };
  for (const role of roles) {
    const windowMinutes = role === "primary" ? 300 : 10080;
    limits[role] = {
      window_minutes: windowMinutes,
      resets_at: Math.floor(timestampMs / 1000) + windowMinutes * 60,
      used_percent: 42.5,
    };
  }
  return limits;
}

function codexQuotaRoles(file, startOrdinal) {
  const roles = [];
  if (startOrdinal < file.quotaObservations) roles.push("primary");
  if (startOrdinal + 1 < file.quotaObservations) roles.push("secondary");
  return roles;
}

function codexUsageRow(file, ordinal, timestampMs, quotaStart, paddingText) {
  const rateLimits = codexRateLimits(timestampMs, codexQuotaRoles(file, quotaStart));
  return {
    id: syntheticEventId(file, ordinal),
    timestamp: iso(timestampMs),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 5,
          reasoning_output_tokens: 1,
          cache_write_input_tokens: 0,
          total_tokens: 15,
        },
      },
      ...(rateLimits ? { rate_limits: rateLimits } : {}),
    },
    ...(paddingText !== "" ? { synthetic_padding: paddingText ?? "" } : {}),
  };
}

function codexZeroUsageRow(file, rowIndex, timestampMs, quotaStart, paddingText) {
  const rateLimits = codexRateLimits(timestampMs, codexQuotaRoles(file, quotaStart));
  return {
    id: `${file.key}-quota-${rowIndex}`,
    timestamp: iso(timestampMs),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 0,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          cache_write_input_tokens: 0,
          total_tokens: 0,
        },
      },
      ...(rateLimits ? { rate_limits: rateLimits } : {}),
      synthetic_padding: paddingText,
    },
  };
}

function dshUsageRow(file, ordinal, timestampMs, paddingText) {
  return {
    type: "assistant/message",
    seq: ordinal + 1,
    time: timestampMs,
    data: {
      turn: ordinal + 1,
      step: 1,
      message: { content: [{ type: "text", text: "Synthetic assistant response." }] },
      usage: {
        inputTokens: 8,
        cacheReadTokens: 2,
        cacheWriteTokens: 0,
        outputTokens: 5,
        totalTokens: 15,
      },
    },
    ...(paddingText !== "" ? { synthetic_padding: paddingText ?? "" } : {}),
  };
}

function claudeUsageRow(file, ordinal, timestampMs, paddingText) {
  return {
    type: "assistant",
    uuid: `${file.key}-uuid-${ordinal}`,
    parentUuid: null,
    timestamp: iso(timestampMs),
    sessionId: file.sessionKey,
    cwd: syntheticCwd(file),
    version: "2.1.299",
    message: {
      id: syntheticEventId(file, ordinal),
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5-20250929",
      content: [{ type: "text", text: "Synthetic assistant response." }],
      usage: {
        input_tokens: 8,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 0,
        output_tokens: 5,
        output_tokens_details: { thinking_tokens: 0 },
      },
    },
    ...(paddingText !== "" ? { synthetic_padding: paddingText ?? "" } : {}),
  };
}

function workbuddyUsageRow(file, ordinal, timestampMs, paddingText) {
  return {
    id: `${file.key}-record-${ordinal}`,
    timestamp: timestampMs,
    type: "function_call",
    sessionId: file.sessionKey,
    cwd: syntheticCwd(file),
    functionCall: { name: "synthetic_tool", arguments: "{}" },
    providerData: {
      messageId: syntheticEventId(file, ordinal),
      model: "deepseek-v4.1-flash",
      requestModelName: "Deepseek-V4.1-Flash",
      rawUsage: { cache_creation_input_tokens: 0 },
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokensDetails: [{ cached_tokens: 2 }],
        outputTokensDetails: [{ reasoning_tokens: 1 }],
      },
    },
    ...(paddingText !== "" ? { synthetic_padding: paddingText ?? "" } : {}),
  };
}

function codexPaddingRow(file, rowIndex, paddingText) {
  return {
    id: `${file.key}-padding-${rowIndex}`,
    timestamp: iso(GROWTH_START_MS),
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: paddingText }],
    },
  };
}

function dshPaddingRow(rowIndex, seq, paddingText) {
  return {
    type: "turn/end",
    seq,
    time: GROWTH_START_MS + (rowIndex % (GROWTH_SPAN_MS + 1)),
    data: {
      turn: rowIndex + 1,
      synthetic_padding: paddingText,
    },
  };
}

function claudePaddingRow(file, rowIndex, paddingText) {
  return {
    type: "user",
    uuid: `${file.key}-padding-${rowIndex}`,
    parentUuid: null,
    timestamp: iso(GROWTH_START_MS + (rowIndex % (GROWTH_SPAN_MS + 1))),
    sessionId: file.sessionKey,
    cwd: syntheticCwd(file),
    message: {
      role: "user",
      content: [{ type: "text", text: paddingText }],
    },
  };
}

function workbuddyPaddingRow(file, rowIndex, paddingText) {
  return {
    id: `${file.key}-padding-${rowIndex}`,
    timestamp: GROWTH_START_MS + (rowIndex % (GROWTH_SPAN_MS + 1)),
    type: "reasoning",
    sessionId: file.sessionKey,
    cwd: syntheticCwd(file),
    providerData: {
      messageId: `${file.key}:padding`,
      model: "deepseek-v4.1-flash",
      requestModelName: "Deepseek-V4.1-Flash",
    },
    text: paddingText,
  };
}

function rowFor(file, eventOrdinals, rowIndex, eventCount, paddingText) {
  const eventStart = file.prefixRows;
  const eventEnd = eventStart + file.events;
  if (rowIndex >= eventStart && rowIndex < eventEnd) {
    const eventIndex = rowIndex - eventStart;
    const ordinal = eventOrdinals[eventIndex];
    const timestampMs = eventTimestamp(ordinal, eventCount);
    if (file.kind === "codex") return codexUsageRow(file, ordinal, timestampMs, eventIndex * 2, paddingText);
    if (file.kind === "dsh") return dshUsageRow(file, ordinal, timestampMs, paddingText);
    if (file.kind === "claude") return claudeUsageRow(file, ordinal, timestampMs, paddingText);
    return workbuddyUsageRow(file, ordinal, timestampMs, paddingText);
  }

  if (file.kind === "codex" && rowIndex === 0) {
    return {
      timestamp: iso(GROWTH_START_MS),
      type: "session_meta",
      payload: {
        id: file.sessionKey,
        timestamp: iso(GROWTH_START_MS),
        cwd: syntheticCwd(file),
        source: "cli",
        originator: "codex_cli_rs",
        cli_version: "synthetic",
        model_provider: "openai",
      },
      ...(paddingText !== "" ? { synthetic_padding: paddingText ?? "" } : {}),
    };
  }
  if (file.kind === "codex" && rowIndex === 1) {
    return {
      timestamp: iso(eventTimestamp(0, eventCount)),
      type: "turn_context",
      payload: {
        cwd: syntheticCwd(file),
        model: "gpt-6-sol",
        effort: "high",
        summary: "auto",
      },
      ...(paddingText !== "" ? { synthetic_padding: paddingText ?? "" } : {}),
    };
  }
  if (file.kind === "dsh" && rowIndex === 0) {
    return {
      type: "session",
      version: 4,
      id: file.sessionKey,
      createdAt: GROWTH_START_MS,
      cwd: syntheticCwd(file),
      isSeeded: false,
      delegationDepth: 0,
      agentPreset: "standard",
      ...(paddingText !== "" ? { synthetic_padding: paddingText ?? "" } : {}),
    };
  }
  if (file.kind === "dsh" && rowIndex === 1) {
    const firstOrdinal = file.events ? eventOrdinals[0] : 0;
    return {
      type: "request/header",
      seq: firstOrdinal,
      time: eventTimestamp(0, eventCount),
      data: {
        header: {
          config: {
            provider: "deepseek",
            model: "deepseek-chat",
            reasoningEffort: "max",
            maxTokens: 256000,
          },
        },
        reason: "synthetic",
        ...(paddingText !== "" ? { synthetic_padding: paddingText ?? "" } : {}),
      },
    };
  }
  if (file.kind === "workbuddy" && rowIndex === 0) {
    return {
      type: "session-meta",
      id: `${file.key}-session-meta`,
      sessionId: file.sessionKey,
      timestamp: GROWTH_START_MS,
      cwd: syntheticCwd(file),
      version: "synthetic",
      ...(paddingText !== "" ? { synthetic_padding: paddingText ?? "" } : {}),
    };
  }

  const paddingIndex = rowIndex - eventEnd;
  if (file.kind === "codex") {
    if (paddingIndex < file.quotaOnlyRows) {
      const timestampMs = eventTimestamp(Math.min(paddingIndex, Math.max(0, eventCount - 1)), eventCount);
      return codexZeroUsageRow(
        file,
        paddingIndex,
        timestampMs,
        file.events * 2 + paddingIndex * 2,
        paddingText,
      );
    }
    return codexPaddingRow(file, paddingIndex, paddingText);
  }
  if (file.kind === "dsh") {
    const lastOrdinal = file.events ? eventOrdinals[eventOrdinals.length - 1] : -1;
    return dshPaddingRow(paddingIndex, lastOrdinal + paddingIndex + 2, paddingText);
  }
  if (file.kind === "claude") return claudePaddingRow(file, paddingIndex, paddingText);
  return workbuddyPaddingRow(file, paddingIndex, paddingText);
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    stream.write(chunk, "utf8", (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function writePlain(filePath, lines) {
  const output = createWriteStream(filePath, { flags: "wx" });
  try {
    for (const line of lines()) await writeChunk(output, line);
    output.end();
    await finished(output);
  } catch (error) {
    output.destroy();
    throw error;
  }
}

async function writeSingleZstdFrame(filePath, lines) {
  const output = createWriteStream(filePath, { flags: "wx" });
  const compressor = createZstdCompress();
  compressor.once("error", (error) => output.destroy(error));
  compressor.pipe(output);
  try {
    for (const line of lines()) await writeChunk(compressor, line);
    compressor.end();
    await finished(output);
  } catch (error) {
    compressor.destroy();
    output.destroy();
    throw error;
  }
}

async function writeDshFrames(filePath, file, lineAt) {
  const output = createWriteStream(filePath, { flags: "wx" });
  const frameCount = Math.min(file.rowCount, Math.max(1, file.targetFrames));
  const rowsPerFrame = Math.floor(file.rowCount / frameCount);
  const extraRows = file.rowCount % frameCount;
  let rowIndex = 0;
  try {
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const compressor = createZstdCompress();
      compressor.once("error", (error) => output.destroy(error));
      compressor.pipe(output, { end: false });
      const rowsInFrame = rowsPerFrame + (frameIndex < extraRows ? 1 : 0);
      for (let index = 0; index < rowsInFrame; index += 1) {
        await writeChunk(compressor, lineAt(rowIndex));
        rowIndex += 1;
      }
      compressor.end();
      await finished(compressor);
    }
    output.end();
    await finished(output);
  } catch (error) {
    output.destroy();
    throw error;
  }
  return frameCount;
}

async function writeFileContents(filePath, file, lineAt) {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (file.kind === "dsh") {
    return writeDshFrames(filePath, file, lineAt);
  }
  if (file.compressed) {
    await writeSingleZstdFrame(filePath, function* lines() {
      for (let rowIndex = 0; rowIndex < file.rowCount; rowIndex += 1) yield lineAt(rowIndex);
    });
    return 1;
  }
  await writePlain(filePath, function* lines() {
    for (let rowIndex = 0; rowIndex < file.rowCount; rowIndex += 1) yield lineAt(rowIndex);
  });
  return 0;
}

/**
 * Build deterministic synthetic line-protocol inputs from a caller-authored profile.
 *
 * The returned byte fields are measured from the generated files. DSH zstd header
 * overhead is intentionally included in sourceBytes and frames.
 */
export async function generateLineInputs({ root, scale, files, onProgress }) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new TypeError("root must be a non-empty path");
  }
  const resolvedRoot = path.resolve(root);
  const rootInfo = await stat(resolvedRoot);
  if (!rootInfo.isDirectory()) {
    throw new TypeError("root must be an existing directory");
  }
  requireInteger(scale, "scale", 1);
  if (!Array.isArray(files) || files.length === 0) {
    throw new TypeError("files must be a non-empty array");
  }
  if (onProgress !== undefined && typeof onProgress !== "function") {
    throw new TypeError("onProgress must be a function when provided");
  }

  const prepared = files.map((file) => normalizeFile(file, scale));
  const keys = new Set();
  for (const file of prepared) {
    if (keys.has(file.key)) throw new TypeError(`duplicate file.key: ${file.key}`);
    keys.add(file.key);
  }

  const eventCount = prepared.reduce((sum, file) => sum + file.events, 0);
  if (eventCount > GROWTH_SPAN_MS + 1) {
    throw new RangeError("event slots exceed the 90-day millisecond time span");
  }
  const eventOrdinals = buildEventOrdinals(prepared);

  const actualFiles = [];
  for (let fileIndex = 0; fileIndex < prepared.length; fileIndex += 1) {
    const file = prepared[fileIndex];
    const filePath = targetPath(resolvedRoot, file);
    const paddingRows = file.rowCount - file.prefixRows - file.events;
    const calibrationRows = paddingRows || file.rowCount;
    let baseBytes = 0;
    for (let rowIndex = 0; rowIndex < file.rowCount; rowIndex += 1) {
      const sizingPadding = paddingRows === 0 ? null : "";
      baseBytes += Buffer.byteLength(
        jsonLine(rowFor(file, eventOrdinals[fileIndex], rowIndex, eventCount, sizingPadding)),
      );
    }
    const extraBytes = Math.max(0, file.targetDecodedBytes - baseBytes);
    const basePadding = Math.floor(extraBytes / calibrationRows);
    const paddedRows = extraBytes % calibrationRows;
    if (basePadding + (paddedRows ? 1 : 0) > MAX_PADDING_CHARS) {
      throw new RangeError(`${file.key}: decodedBytes target needs padding beyond ${MAX_PADDING_CHARS} characters per row`);
    }

    const alphabet = paddingAlphabet(file);
    const seed = hashSeed(file);
    let decodedBytes = 0;
    const lineAt = (rowIndex) => {
      const postEventOrdinal = rowIndex - file.prefixRows - file.events;
      const paddingOrdinal =
        postEventOrdinal >= 0 ? postEventOrdinal : paddingRows === 0 && extraBytes > 0 ? rowIndex : -1;
      const paddingLength = paddingOrdinal < 0 ? 0 : basePadding + (paddingOrdinal < paddedRows ? 1 : 0);
      const padding = paddingLength
        ? deterministicPadding(paddingLength, alphabet, (seed + paddingOrdinal * 0x9e3779b9) >>> 0)
        : "";
      const line = jsonLine(rowFor(file, eventOrdinals[fileIndex], rowIndex, eventCount, padding));
      decodedBytes += Buffer.byteLength(line);
      return line;
    };
    const frames = await writeFileContents(filePath, file, lineAt);
    const info = await stat(filePath);
    const fileResult = {
      key: file.key,
      kind: file.kind,
      sessionKey: file.sessionKey,
      compressed: file.compressed,
      path: filePath,
      rows: file.rowCount,
      events: file.events,
      quotaObservations: file.quotaObservations,
      decodedBytes,
      sourceBytes: info.size,
      frames,
      baseline: {
        rows: file.rows,
        events: file.events / scale,
        quotaObservations: file.quotaObservations / scale,
        decodedBytes: file.decodedBytes,
        sourceBytes: file.sourceBytes,
        frames: file.frames,
      },
    };
    actualFiles.push(fileResult);
    await onProgress?.(fileResult, fileIndex, prepared.length);
  }

  return {
    scale,
    files: actualFiles,
    totals: {
      fileCount: actualFiles.length,
      events: actualFiles.reduce((sum, file) => sum + file.events, 0),
      quotaObservations: actualFiles.reduce((sum, file) => sum + file.quotaObservations, 0),
      rows: actualFiles.reduce((sum, file) => sum + file.rows, 0),
      decodedBytes: actualFiles.reduce((sum, file) => sum + file.decodedBytes, 0),
      sourceBytes: actualFiles.reduce((sum, file) => sum + file.sourceBytes, 0),
      frames: actualFiles.reduce((sum, file) => sum + file.frames, 0),
    },
    time: {
      start: iso(GROWTH_START_MS),
      end: iso(GROWTH_END_MS),
      eventSlots: eventCount,
    },
  };
}
