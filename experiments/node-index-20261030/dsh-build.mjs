import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const EXPERIMENT_FILE = path.join(REPO_ROOT, "output", "node-index-20261030", "experiment.json");
const args = process.argv.slice(2);

if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
  throw new Error("usage: node experiments/node-index-20261030/dsh-build.mjs [--check]");
}

const checkOnly = args[0] === "--check";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertUnique(source, anchor, label) {
  const first = source.indexOf(anchor);
  const count = first < 0 ? 0 : source.split(anchor).length - 1;
  if (first < 0 || count !== 1) {
    throw new Error(`${label} anchor must occur exactly once; found ${count}`);
  }
  return first;
}

function replaceOnce(source, anchor, replacement, label) {
  assertUnique(source, anchor, label);
  return source.replace(anchor, replacement);
}

function firstDifferentLine(left, right) {
  const leftLines = left.split("\n");
  const rightLines = right.split("\n");
  const length = Math.max(leftLines.length, rightLines.length);
  for (let index = 0; index < length; index += 1) {
    if (leftLines[index] !== rightLines[index]) {
      return {
        line: index + 1,
        generated: leftLines[index] ?? "<missing>",
        existing: rightLines[index] ?? "<missing>",
      };
    }
  }
  return null;
}

function buildDshUsage(source) {
  source = replaceOnce(
    source,
    ` * @param {{ onWarning?: (warning: string) => void }} [options]
 */
export async function* streamDshSessionRows(filePath, { onWarning } = {}) {`,
    ` * @param {{
 *   onWarning?: (warning: string) => void,
 *   projectRow?: (row: any) => any | null
 * }} [options] \`projectRow\` is the internal hot-path projection; omitting it preserves the public full-row stream.
 */
export async function* streamDshSessionRows(filePath, { onWarning, projectRow } = {}) {`,
    "stream options",
  );

  source = replaceOnce(
    source,
    `    const lines = \`\${pending}\${decompressed.toString("utf8")}\`.split("\\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        yield JSON.parse(line);
      } catch {
        // 写入中断可能留下半行：仍然跳过（用量事件行为不变），只把**行数**单独计数。
        malformedLines += 1;
      }
    }
`,
    `    let text = \`\${pending}\${decompressed.toString("utf8")}\`;
    pending = "";
    decompressed = null;
    let lineStart = 0;
    let line;
    let row;
    const projectedRows = projectRow ? [] : null;
    for (let newline = text.indexOf("\\n"); newline !== -1; newline = text.indexOf("\\n", lineStart)) {
      line = text.slice(lineStart, newline);
      lineStart = newline + 1;
      if (!line.trim()) {
        continue;
      }
      try {
        row = JSON.parse(line);
      } catch {
        // 写入中断可能留下半行：仍然跳过（用量事件行为不变），只把**行数**单独计数。
        malformedLines += 1;
        continue;
      }
      if (projectRow) {
        const projected = projectRow(row);
        if (projected !== null) {
          projectedRows.push(projected);
        }
      } else {
        yield row;
      }
    }
    pending = text.slice(lineStart);
    if (projectedRows) {
      row = undefined;
      line = undefined;
      text = "";
      decompressed = null;
      for (const projected of projectedRows) {
        yield projected;
      }
    }
`,
    "frame line scan",
  );

  source = replaceOnce(
    source,
    `  if (pending.trim()) {
    try {
      yield JSON.parse(pending);
    } catch {
      malformedLines += 1;
    }
  }
`,
    `  if (pending.trim()) {
    let row;
    try {
      row = JSON.parse(pending);
    } catch {
      malformedLines += 1;
    }
    if (row !== undefined) {
      pending = "";
      if (projectRow) {
        const projected = projectRow(row);
        row = undefined;
        if (projected !== null) {
          yield projected;
        }
      } else {
        yield row;
      }
    }
  }
`,
    "pending line",
  );

  source = replaceOnce(
    source,
    `/** 解析会话头；缺失时返回 null（调用方据此跳过该文件）。 */
export function dshSessionHeader(rows = []) {
  const row = rows.find((entry) => entry?.type === "session");
  if (!row) {
    return null;
  }
  const version = numeric(row.version);
  return {
    id: String(row.id || "").trim(),
    version,
    cwd: String(row.cwd || "").trim(),
    delegationDepth: nonNegativeInt(row.delegationDepth),
    createdAtMs: numeric(row.createdAt),
    agentPreset: String(row.agentPreset || "").trim(),
  };
}
`,
    `function dshSessionHeaderFromRow(row) {
  if (!row) {
    return null;
  }
  const version = numeric(row.version);
  return {
    id: String(row.id || "").trim(),
    version,
    cwd: String(row.cwd || "").trim(),
    delegationDepth: nonNegativeInt(row.delegationDepth),
    createdAtMs: numeric(row.createdAt),
    agentPreset: String(row.agentPreset || "").trim(),
  };
}

/** 解析会话头；缺失时返回 null（调用方据此跳过该文件）。 */
export function dshSessionHeader(rows = []) {
  return dshSessionHeaderFromRow(rows.find((entry) => entry?.type === "session"));
}
`,
    "session header helper",
  );

  source = replaceOnce(
    source,
    `  return { usage, detailMask, cacheWriteTokens, cacheWriteKnown: true, requestInputTokens: input };
}

/**
 * 两遍扫描一个会话日志，产出标准化用量事件。`,
    `  return { usage, detailMask, cacheWriteTokens, cacheWriteKnown: true, requestInputTokens: input };
}

function projectDshSessionHeaderRow(row) {
  return row?.type === "session"
    ? {
        type: "session",
        header: dshSessionHeaderFromRow(row),
      }
    : null;
}

/** Keep only fields consumed by usage events; message content and stream never cross the yield boundary. */
function projectDshUsageRow(row) {
  const type = row?.type;
  const data = row?.data;
  if (type === "request/header" || type === "request/context") {
    const config = data?.header?.config;
    return {
      type,
      data: {
        header: { config: { model: config?.model, provider: config?.provider } },
        model: data?.model,
        provider: data?.provider,
      },
    };
  }
  if (type === "session/title") {
    return { type, data: { title: data?.title } };
  }
  if (type === "assistant/message") {
    return {
      type,
      time: row?.time,
      seq: row?.seq,
      data: {
        usage: data?.usage,
        turn: data?.turn,
        step: data?.step,
      },
    };
  }
  return null;
}

/**
 * 两遍扫描一个会话日志，产出标准化用量事件。`,
    "usage projections",
  );

  source = replaceOnce(
    source,
    `  for await (const row of streamDshSessionRows(filePath, {
    onWarning: (warning) => parserWarnings.push(warning),
  })) {
    if (header === null && row?.type === "session") {
      header = dshSessionHeader([row]);
    }
  }
`,
    `  for await (const row of streamDshSessionRows(filePath, {
    onWarning: (warning) => parserWarnings.push(warning),
    projectRow: projectDshSessionHeaderRow,
  })) {
    if (header === null) {
      header = row.header;
    }
  }
`,
    "usage header pass",
  );

  source = replaceOnce(
    source,
    `  for await (const row of streamDshSessionRows(filePath)) {
    await processRow(row);
  }`,
    `  for await (const row of streamDshSessionRows(filePath, { projectRow: projectDshUsageRow })) {
    await processRow(row);
  }`,
    "usage projection pass",
  );

  assert.equal(source.includes('.split("\\n")'), false, "split-array scanner remained");
  return `${source.replace(/\n+$/, "")}\n`;
}

function buildPerfSource(source) {
  source = replaceOnce(
    source,
    `/**
 * 输出一条规范候选。返回 \`true\` 表示已通过 \`normalizePerfSample()\` 并交给 \`onSample\`。`,
    `/**
 * Collapse a parsed row before it crosses the async-generator boundary. The successful message's
 * stream is inspected immediately; its text/args payload is not retained by the TPS groups.
 * @param {any} row
 */
function projectDshPerfRow(row) {
  const type = typeof row?.type === "string" ? row.type : "";
  const data = row?.data;
  if (type === "request/header" || type === "request/context") {
    const config = data?.header?.config;
    return {
      type,
      data: {
        header: {
          config:
            config && typeof config === "object"
              ? {
                  model: config.model,
                  provider: config.provider,
                  reasoningEffort: config.reasoningEffort,
                }
              : null,
        },
      },
    };
  }
  if (type === "step/start" || type === RETRY_STARTED_TYPE) {
    return {
      type,
      time: row?.time,
      data: { turn: data?.turn, step: data?.step },
    };
  }
  if (type === "assistant/message") {
    const turn = data?.turn;
    const step = data?.step;
    const source = data?.message?.source;
    return {
      type,
      time: row?.time,
      data: {
        turn,
        step,
        generation:
          identityInteger(turn) !== null && identityInteger(step) !== null ? inspectDshAssistantGeneration(data) : null,
        message:
          source && typeof source === "object" && !Array.isArray(source)
            ? { source: { model: source.model, provider: source.provider } }
            : undefined,
      },
    };
  }
  if (STEP_END_TYPE === type) {
    return { type, data: { turn: data?.turn, step: data?.step } };
  }
  return { type };
}

/**
 * 输出一条规范候选。返回 \`true\` 表示已通过 \`normalizePerfSample()\` 并交给 \`onSample\`。`,
    "perf projection helper",
  );

  source = replaceOnce(
    source,
    "      const generation = inspectDshAssistantGeneration(row?.data);",
    "      const generation = row?.data?.generation;",
    "perf generation handoff",
  );

  source = replaceOnce(
    source,
    `    },
  })) {
    if (header === null && row?.type === "session") {`,
    `    },
    projectRow: (row) => (row?.type === "session" ? row : null),
  })) {
    if (header === null && row?.type === "session") {`,
    "perf header pass",
  );

  source = replaceOnce(
    source,
    `  for await (const row of streamDshSessionRows(filePath)) {
    const currentFrameIndex = frameIndex;`,
    `  for await (const row of streamDshSessionRows(filePath, { projectRow: projectDshPerfRow })) {
    const currentFrameIndex = frameIndex;`,
    "perf projection pass",
  );

  assert.equal(source.includes("const generation = inspectDshAssistantGeneration(row?.data);"), false);
  return source;
}

const experiment = JSON.parse(fs.readFileSync(EXPERIMENT_FILE, "utf8"));
const baselineRoot = experiment.nodeCompactBaseline;
const targetRoot = experiment.compactRoot;
const files = [
  {
    relative: path.join("src", "dsh-usage.js"),
    configFile: "dsh-usage.js",
    build: buildDshUsage,
  },
  {
    relative: path.join("src", "perf-sources", "dsh.js"),
    configFile: path.join("perf-sources", "dsh.js"),
    build: buildPerfSource,
  },
];

const results = [];
for (const file of files) {
  const sourceFile = path.join(baselineRoot, file.relative);
  const targetFile = path.join(targetRoot, file.relative);
  const source = fs.readFileSync(sourceFile, "utf8");
  const expected = experiment.files.find((entry) => entry.file === file.configFile)?.hash;
  assert.ok(expected, `missing baseline hash for ${file.configFile}`);
  assert.equal(sha256(source), expected, `Node compact baseline hash changed for ${file.configFile}`);

  const generated = file.build(source);
  const generatedHash = sha256(generated);
  if (checkOnly) {
    const existing = fs.readFileSync(targetFile, "utf8");
    if (existing !== generated) {
      throw new Error(`${file.relative} is stale: ${JSON.stringify(firstDifferentLine(generated, existing))}`);
    }
  } else {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, generated, "utf8");
  }
  results.push({
    file: file.relative,
    baseline: sourceFile,
    target: targetFile,
    generatedSha256: generatedHash,
  });
}

console.log(JSON.stringify({ mode: checkOnly ? "check" : "write", files: results }));
