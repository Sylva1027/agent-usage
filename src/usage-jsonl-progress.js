import { createReadStream } from "node:fs";

export const CODEX_JSONL_PROGRESS_FORMAT = 1;
export const CODEX_JSONL_PROGRESS_ADAPTER = "codex-jsonl";

export class SourceProgressUnsupportedError extends Error {
  constructor(message) {
    super(message);
    this.name = "SourceProgressUnsupportedError";
    this.code = "SOURCE_PROGRESS_UNSUPPORTED";
  }
}

/** @param {any} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isUsage(value) {
  return (
    isRecord(value) &&
    ["total", "input", "cached", "output", "reasoning"].every((field) => isFiniteNumber(value[field]))
  );
}

/** @param {any} checkpoint */
export function assertCodexJsonlCheckpoint(checkpoint) {
  if (!isRecord(checkpoint)) {
    throw new SourceProgressUnsupportedError("Codex JSONL progress checkpoint must be an object.");
  }
  if (checkpoint.format !== CODEX_JSONL_PROGRESS_FORMAT || checkpoint.adapter !== CODEX_JSONL_PROGRESS_ADAPTER) {
    throw new SourceProgressUnsupportedError("Unsupported Codex JSONL progress checkpoint version or adapter.");
  }
  if (!Number.isSafeInteger(checkpoint.offset) || checkpoint.offset < 0) {
    throw new SourceProgressUnsupportedError("Codex JSONL progress checkpoint offset is invalid.");
  }
  if (!Number.isSafeInteger(checkpoint.lineNumber) || checkpoint.lineNumber < 0) {
    throw new SourceProgressUnsupportedError("Codex JSONL progress checkpoint lineNumber is invalid.");
  }
  const state = checkpoint.state;
  if (!isRecord(state) || !isRecord(state.meta) || !isRecord(state.quota)) {
    throw new SourceProgressUnsupportedError("Codex JSONL progress checkpoint state is invalid.");
  }
  if (
    !["id", "source", "originator", "cwd"].every((field) => typeof state.meta[field] === "string") ||
    typeof state.model !== "string" ||
    !isUsage(state.previousCumulative) ||
    !Number.isSafeInteger(state.previousCumulativeMask) ||
    !isRecord(state.previousCumulativeCacheWrite) ||
    !isFiniteNumber(state.previousCumulativeCacheWrite.tokens) ||
    typeof state.previousCumulativeCacheWrite.known !== "boolean" ||
    typeof state.baselineLoaded !== "boolean" ||
    typeof state.hasUsageInFile !== "boolean" ||
    typeof state.firstAt !== "string" ||
    typeof state.lastAt !== "string" ||
    typeof state.quota.provider !== "string" ||
    typeof state.quota.hasCredits !== "boolean" ||
    !isFiniteNumber(state.quota.creditsUntil) ||
    state.quota.creditsUntil < 0 ||
    typeof state.quota.recovered !== "boolean"
  ) {
    throw new SourceProgressUnsupportedError("Codex JSONL progress checkpoint parser state is invalid.");
  }
  return checkpoint;
}

function physicalLine(bytes, lineNumber, offset, complete) {
  const text = bytes.toString("utf8");
  if (!text.trim()) return { row: null, parsed: false, lineNumber, offset, complete };
  try {
    return { row: JSON.parse(text), parsed: true, lineNumber, offset, complete };
  } catch {
    return { row: null, parsed: false, lineNumber, offset, complete };
  }
}

/**
 * Read physical JSONL lines without crossing a fixed byte boundary.
 * @param {string} filePath
 * @param {{ offset: number, lineNumber: number, endOffset?: number, onSourceBytes?: (bytes: Buffer) => void }} options
 */
export async function* readCodexJsonlProgressRows(filePath, { offset, lineNumber, endOffset, onSourceBytes }) {
  if (endOffset !== undefined && (!Number.isSafeInteger(endOffset) || endOffset < offset)) {
    throw new SourceProgressUnsupportedError("Codex JSONL progress endOffset is invalid.");
  }
  if (endOffset === offset) return;

  const stream = createReadStream(
    filePath,
    endOffset === undefined ? { start: offset } : { start: offset, end: endOffset - 1 },
  );
  let position = offset;
  let fragments = [];
  let fragmentBytes = 0;
  let readBytes = 0;

  try {
    for await (const chunk of stream) {
      readBytes += chunk.length;
      onSourceBytes?.(chunk);
      let from = 0;
      let newline = chunk.indexOf(10);
      while (newline !== -1) {
        let bytes;
        if (fragmentBytes) {
          fragments.push(chunk.subarray(from, newline));
          bytes = Buffer.concat(fragments, fragmentBytes + newline - from);
        } else {
          bytes = chunk.subarray(from, newline);
        }
        position += bytes.length + 1;
        lineNumber += 1;
        yield physicalLine(bytes, lineNumber, position, true);
        fragments = [];
        fragmentBytes = 0;
        from = newline + 1;
        newline = chunk.indexOf(10, from);
      }
      if (from < chunk.length) {
        const fragment = chunk.subarray(from);
        fragments.push(fragment);
        fragmentBytes += fragment.length;
      }
    }

    if (endOffset !== undefined && readBytes < endOffset - offset) {
      throw new SourceProgressUnsupportedError("Codex JSONL stream ended before the requested endOffset.");
    }
    if (fragments.length) {
      const bytes = Buffer.concat(fragments, fragmentBytes);
      position += bytes.length;
      lineNumber += 1;
      yield physicalLine(bytes, lineNumber, position, false);
    }
  } finally {
    stream.destroy();
  }
}
