import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE_PATH = path.resolve(scriptDirectory, "../../src/dsh-usage.js");
const started = process.hrtime.bigint();

function parseArgs(argv) {
  const result = {
    files: [],
    root: null,
    startup: false,
    mode: "semantic",
    source: process.env.DSH_SOURCE_PATH || DEFAULT_SOURCE_PATH,
    traceLimit: 0,
    fieldTraceRow: 0,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--startup") result.startup = true;
    else if (arg === "--mode") result.mode = argv[++index];
    else if (arg === "--source") result.source = argv[++index];
    else if (arg === "--root") result.root = argv[++index];
    else if (arg === "--file") result.files.push(argv[++index]);
    else if (arg === "--trace-limit") result.traceLimit = Number(argv[++index]);
    else if (arg === "--field-trace-row") result.fieldTraceRow = Number(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!["parser", "semantic"].includes(result.mode)) {
    throw new Error(`invalid mode: ${result.mode}`);
  }
  if (!result.source) throw new Error("--source requires a path");
  return result;
}

function emptyParserAggregates() {
  return {
    usageInputTokens: 0,
    usageCachedTokens: 0,
    usageCacheWriteTokens: 0,
    usageOutputTokens: 0,
    usageTotalTokens: 0,
  };
}

function putLength(hasher, value) {
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(BigInt(value));
  hasher.update(buffer);
}

function putString(hasher, value) {
  const bytes = Buffer.from(String(value), "utf8");
  hasher.update(Buffer.from("s"));
  putLength(hasher, bytes.length);
  hasher.update(bytes);
}

function putValue(hasher, value) {
  if (value === null) {
    hasher.update(Buffer.from("n"));
  } else if (typeof value === "boolean") {
    hasher.update(Buffer.from([0x62, value ? 1 : 0]));
  } else if (typeof value === "number") {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleBE(Number(value));
    hasher.update(Buffer.from("f"));
    hasher.update(buffer);
  } else if (typeof value === "string") {
    putString(hasher, value);
  } else if (Array.isArray(value)) {
    hasher.update(Buffer.from("a"));
    putLength(hasher, value.length);
    for (const item of value) putValue(hasher, item);
  } else if (value && typeof value === "object") {
    hasher.update(Buffer.from("o"));
    const keys = Object.keys(value).sort();
    putLength(hasher, keys.length);
    for (const key of keys) {
      putString(hasher, key);
      putValue(hasher, value[key]);
    }
  } else {
    throw new TypeError(`unsupported digest value: ${typeof value}`);
  }
}

function putField(hasher, value) {
  if (value === undefined) {
    hasher.update(Buffer.from([0]));
  } else {
    hasher.update(Buffer.from([1]));
    putValue(hasher, value);
  }
}

function numeric(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInt(value) {
  const number = numeric(value);
  return number === null || number < 0 ? 0 : Math.floor(number);
}

function truthyString(value) {
  return value ? String(value).trim() : "";
}

function normalizedSessionHeader(row) {
  return {
    id: truthyString(row.id),
    version: numeric(row.version),
    cwd: truthyString(row.cwd),
    delegationDepth: nonNegativeInt(row.delegationDepth),
    createdAtMs: numeric(row.createdAt),
    agentPreset: truthyString(row.agentPreset),
  };
}

function mappedUsage(raw) {
  const inputTokens = nonNegativeInt(raw?.inputTokens);
  const cacheReadTokens = nonNegativeInt(raw?.cacheReadTokens);
  const cacheWriteTokens = nonNegativeInt(raw?.cacheWriteTokens);
  const outputTokens = nonNegativeInt(raw?.outputTokens);
  const input = inputTokens + cacheReadTokens + cacheWriteTokens;
  const total = numeric(raw?.totalTokens);
  return {
    total: total === null ? input + outputTokens : Math.floor(total),
    input,
    cached: cacheReadTokens,
    output: outputTokens,
    reasoning: 0,
    cacheWriteTokens,
    requestInputTokens: input,
  };
}

function updateState(row, state) {
  const type = String(row?.type || "");
  const data = row?.data;
  if (type === "session" && state.header === null) {
    state.header = normalizedSessionHeader(row);
  }
  if (type === "request/header" || type === "request/context") {
    const config = data?.header?.config;
    state.model = String(config?.model || data?.model || state.model || "").trim();
    state.modelProvider = String(config?.provider || data?.provider || state.modelProvider || "").trim();
  }
  if (type === "session/title") {
    const title = String(data?.title || "").trim();
    if (title) {
      state.conversationName = title.length > 120 ? `${title.slice(0, 120)}…` : title;
    }
  }
}

function updateProjection(hasher, row, state) {
  const type = String(row?.type || "");
  const data = row?.data;
  putString(hasher, "row");
  putField(hasher, row?.type);
  putField(hasher, row?.seq);
  putField(hasher, row?.time);
  putField(hasher, row?.surfaceOp);
  putField(hasher, row?.sourceEventSeqs);
  putField(hasher, data?.header);
  putField(hasher, data?.usage);
  putField(hasher, data?.stream);
  putField(hasher, data?.title);
  putField(hasher, data?.messageSeqs);
  putField(hasher, data?.turn);
  putField(hasher, data?.step);
  putField(hasher, state.header ?? undefined);
  putString(hasher, state.model);
  putString(hasher, state.modelProvider);
  putString(hasher, state.conversationName);

  const mapped = type === "assistant/message" && data?.usage ? mappedUsage(data.usage) : undefined;
  putField(hasher, mapped);
  putField(hasher, data?.turn === undefined ? undefined : nonNegativeInt(data.turn));
  putField(hasher, data?.step === undefined ? undefined : nonNegativeInt(data.step));

  const streamItems = Array.isArray(data?.stream) ? data.stream.length : 0;
  const hasUsage = type === "assistant/message" && Boolean(data?.usage);
  const nonzeroEvent =
    mapped !== undefined &&
    numeric(row?.time) !== null &&
    ["total", "input", "cached", "output", "reasoning"].some((field) => mapped[field] !== 0);
  const hasHeader = type === "session" || type === "request/header" || type === "request/context";
  return { hasUsage, nonzeroEvent, streamItems, hasHeader };
}

function accumulateParserRow(row, aggregates) {
  const type = String(row?.type || "");
  const data = row?.data;
  const usage = type === "assistant/message" && data?.usage ? data.usage : null;
  let nonzeroEvent = false;

  if (usage) {
    const inputTokens = nonNegativeInt(usage.inputTokens);
    const cacheReadTokens = nonNegativeInt(usage.cacheReadTokens);
    const cacheWriteTokens = nonNegativeInt(usage.cacheWriteTokens);
    const outputTokens = nonNegativeInt(usage.outputTokens);
    const input = inputTokens + cacheReadTokens + cacheWriteTokens;
    const totalTokens = numeric(usage.totalTokens);
    const total = totalTokens === null ? input + outputTokens : Math.floor(totalTokens);
    aggregates.usageInputTokens += input;
    aggregates.usageCachedTokens += cacheReadTokens;
    aggregates.usageCacheWriteTokens += cacheWriteTokens;
    aggregates.usageOutputTokens += outputTokens;
    aggregates.usageTotalTokens += total;
    nonzeroEvent =
      numeric(row?.time) !== null &&
      [total, input, cacheReadTokens, outputTokens].some((value) => value !== 0);
  }

  const streamItems = Array.isArray(data?.stream) ? data.stream.length : 0;
  const hasHeader = type === "session" || type === "request/header" || type === "request/context";
  return { hasUsage: Boolean(usage), nonzeroEvent, streamItems, hasHeader };
}

function componentDigest(label, value) {
  const hasher = createHash("sha256");
  putString(hasher, label);
  putField(hasher, value);
  return hasher.digest("hex");
}

function fieldTrace(row, state) {
  const type = String(row?.type || "");
  const data = row?.data;
  const mapped =
    type === "assistant/message" && data?.usage ? mappedUsage(data.usage) : undefined;
  return {
    type: componentDigest("type", row?.type),
    seq: componentDigest("seq", row?.seq),
    time: componentDigest("time", row?.time),
    surfaceOp: componentDigest("surfaceOp", row?.surfaceOp),
    sourceEventSeqs: componentDigest("sourceEventSeqs", row?.sourceEventSeqs),
    header: componentDigest("header", data?.header),
    "header.config": componentDigest("header.config", data?.header?.config),
    "header.adapterDefaults": componentDigest("header.adapterDefaults", data?.header?.adapterDefaults),
    "header.tools": componentDigest("header.tools", data?.header?.tools),
    usage: componentDigest("usage", data?.usage),
    stream: componentDigest("stream", data?.stream),
    title: componentDigest("title", data?.title),
    messageSeqs: componentDigest("messageSeqs", data?.messageSeqs),
    turn: componentDigest("turn", data?.turn),
    step: componentDigest("step", data?.step),
    stateHeader: componentDigest("stateHeader", state.header ?? undefined),
    model: componentDigest("model", state.model),
    modelProvider: componentDigest("modelProvider", state.modelProvider),
    conversationName: componentDigest("conversationName", state.conversationName),
    mappedUsage: componentDigest("mappedUsage", mapped),
  };
}

async function collectFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath);
      else if (entry.isFile() && /^session\.v\d+\.jsonl\.zstd$/.test(entry.name)) files.push(fullPath);
    }
  }
  await walk(root);
  return files.sort();
}

function summaryPath(root, file) {
  return root ? path.relative(root, file).replaceAll("\\", "/") : path.basename(file);
}

async function summarizeFile(
  streamDshSessionRows,
  root,
  file,
  mode,
  traceLimit,
  fieldTraceRow,
) {
  const hasher = mode === "semantic" ? createHash("sha256") : null;
  hasher?.update(Buffer.from("dsh-rust-parsing-20261029\0"));
  const warnings = [];
  const state = { header: null, model: "", modelProvider: "", conversationName: "" };
  const parser = emptyParserAggregates();
  let rows = 0;
  let usageRows = 0;
  let nonzeroUsageEvents = 0;
  let streamItems = 0;
  let headerRows = 0;
  const trace = [];
  let tracedFields;

  for await (const row of streamDshSessionRows(file, {
    onWarning: (warning) => warnings.push(warning.replaceAll(file, "<file>")),
  })) {
    const counts = accumulateParserRow(row, parser);
    if (hasher) {
      updateState(row, state);
      updateProjection(hasher, row, state);
    }
    rows += 1;
    usageRows += Number(counts.hasUsage);
    nonzeroUsageEvents += Number(counts.nonzeroEvent);
    streamItems += counts.streamItems;
    headerRows += Number(counts.hasHeader);
    if (hasher && trace.length < traceLimit) {
      trace.push({ row: rows, digest: hasher.copy().digest("hex") });
    }
    if (hasher && rows === fieldTraceRow) tracedFields = fieldTrace(row, state);
  }

  if (hasher) {
    putString(hasher, "warnings");
    for (const warning of warnings) putString(hasher, warning);
  }
  const info = await stat(file);
  const summary = {
    path: summaryPath(root, file),
    bytes: info.size,
    rows,
    usageRows,
    nonzeroUsageEvents,
    streamItems,
    headerRows,
    parser,
    warnings,
  };
  if (hasher) summary.digest = hasher.digest("hex");
  if (trace.length > 0) summary.trace = trace;
  if (tracedFields) summary.fieldTrace = tracedFields;
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.startup) {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    console.log(JSON.stringify({ engine: "node", startup: true, elapsedMs }));
    return;
  }

  const sourcePath = path.resolve(options.source);
  const { streamDshSessionRows } = await import(pathToFileURL(sourcePath).href);
  const files = options.root ? await collectFiles(options.root) : options.files;
  const summaries = [];
  for (const file of files) {
    try {
      summaries.push(
        await summarizeFile(
          streamDshSessionRows,
          options.root,
          file,
          options.mode,
          options.traceLimit,
          options.fieldTraceRow,
        ),
      );
    } catch (error) {
      summaries.push({
        path: summaryPath(options.root, file),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const totals = {
    files: summaries.length,
    rows: summaries.reduce((sum, value) => sum + (value.rows ?? 0), 0),
    usageRows: summaries.reduce((sum, value) => sum + (value.usageRows ?? 0), 0),
    nonzeroUsageEvents: summaries.reduce((sum, value) => sum + (value.nonzeroUsageEvents ?? 0), 0),
    streamItems: summaries.reduce((sum, value) => sum + (value.streamItems ?? 0), 0),
    parser: emptyParserAggregates(),
    errors: summaries.filter((value) => value.error).length,
  };
  for (const summary of summaries) {
    if (!summary.parser) continue;
    for (const field of Object.keys(totals.parser)) {
      totals.parser[field] += summary.parser[field] ?? 0;
    }
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(
    JSON.stringify({
      engine: "node",
      mode: options.mode,
      sourcePath,
      elapsedMs,
      totals,
      files: summaries,
    }),
  );
}

await main();
