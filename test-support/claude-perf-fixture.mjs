// Claude Code TPS reader 的**合成**夹具（不读真实转录、不含对话正文/工具参数）。
//
// 每个场景都是字面量行数组 + 手算期望值。行对象由 `assistantRow` / `promptRow` / `attachmentRow`
// 构造，坏 JSON 行直接用字符串表示（`toJsonl` 原样写出）。时间戳全部显式给出，便于按
// `末行 − 锚点` 手算 `durationMs`。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const HOME_ID = "claude-home-fixture";
export const SESSION_ID = "fixture-claude-session";
export const PARENT_SESSION_ID = "fixture-claude-parent-session";

export const T0 = Date.parse("2026-10-20T10:00:00.000Z");

function iso(ms) {
  return new Date(ms).toISOString();
}

export function promptRow(ts, sessionId = SESSION_ID) {
  return { type: "user", timestamp: iso(ts), sessionId };
}

export function attachmentRow(ts, sessionId = SESSION_ID) {
  return { type: "attachment", timestamp: iso(ts), sessionId };
}

/**
 * 一条 assistant 行。`messageId` 省略 ⇒ 该行没有 `message.id`（用于 UNKEYABLE_RECORD）。
 * `outputTokens` 默认 0 ⇒ 零用量占位行的形状。
 */
export function assistantRow({
  ts,
  messageId,
  model = "deepseek-flash",
  outputTokens = 0,
  inputTokens = 100,
  cacheReadInputTokens = 0,
  cacheCreationInputTokens = 0,
  thinkingTokens = 0,
  stopReason = null,
  sessionId = SESSION_ID,
  isSidechain,
  attributionAgent,
  effort,
}) {
  const row = {
    type: "assistant",
    timestamp: iso(ts),
    sessionId,
    message: {
      model,
      stop_reason: stopReason,
      usage: {
        input_tokens: inputTokens,
        cache_read_input_tokens: cacheReadInputTokens,
        cache_creation_input_tokens: cacheCreationInputTokens,
        output_tokens: outputTokens,
      },
    },
  };
  if (messageId !== undefined) row.message.id = messageId;
  if (thinkingTokens > 0) row.message.usage.output_tokens_details = { thinking_tokens: thinkingTokens };
  if (isSidechain !== undefined) row.isSidechain = isSidechain;
  if (attributionAgent !== undefined) row.attributionAgent = attributionAgent;
  if (effort !== undefined) row.effort = effort;
  return row;
}

/** 坏 JSON 行（原样写出，不经过 JSON.stringify）。 */
export const MALFORMED_LINE = '{"type":"assistant", this is not json';

/** 行数组 → JSONL 文本；字符串行原样输出。 */
export function toJsonl(rows) {
  return `${rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n")}\n`;
}

/** 与 `UsageStore` 一致的来源对象；`path` 是 home 目录（store 会替换成物理文件路径）。 */
export function claudeSource(root) {
  return { id: HOME_ID, path: root, kind: "claude", label: "Claude" };
}

/**
 * 在 mkdtemp 临时目录里写多个转录文件，然后运行 `run({ root, files, source })`。
 * `spec.dirs` 决定文件所在目录（子代理场景用 `[project, sessionId, "subagents"]`）。
 */
export async function withClaudeFiles(specs, run) {
  const root = await mkdtemp(path.join(tmpdir(), "perf-claude-"));
  try {
    const files = [];
    for (const spec of specs) {
      const dir = path.join(root, ...(spec.dirs ?? ["fixture-project"]));
      await mkdir(dir, { recursive: true });
      const filePath = path.join(dir, spec.name);
      await writeFile(filePath, toJsonl(spec.rows));
      files.push(filePath);
    }
    return await run({ root, files, source: claudeSource(root) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** 单文件快捷方式。 */
export function withClaudeFile(rows, run, { dirs, name = "session-fixture.jsonl" } = {}) {
  return withClaudeFiles([{ rows, dirs, name }], run);
}

// ---------------------------------------------------------------------------
// 场景 1：同一 message.id 三行（首行零用量占位）⇒ 1 个样本。
// output 取最大（第三行不是最大），duration 取末行 − user 锚点。
// input_tokens 同时是"最佳行输入"和"最大输入"，不把两种取法混进期望值。
// ---------------------------------------------------------------------------
export const DEDUPE = {
  rows: [
    promptRow(T0),
    assistantRow({ ts: T0 + 1000, messageId: "msg-dedupe", outputTokens: 0, inputTokens: 40 }),
    assistantRow({
      ts: T0 + 4000,
      messageId: "msg-dedupe",
      outputTokens: 250,
      inputTokens: 900,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 5,
      stopReason: "tool_use",
    }),
    assistantRow({
      ts: T0 + 7000,
      messageId: "msg-dedupe",
      outputTokens: 180,
      inputTokens: 300,
      stopReason: "end_turn",
    }),
  ],
  expected: {
    candidates: 1,
    skippedZeroUsage: 0,
    skippedNoAnchor: 0,
    missingMessageId: 0,
    malformedLines: 0,
    sample: {
      messageId: "msg-dedupe",
      outputTokens: 250,
      inputTokens: 925, // 900 + cache_read 20 + cache_creation 5
      durationMs: 7000,
      tsMs: T0 + 7000,
      windowStartMs: T0,
      windowEndMs: T0 + 7000,
      status: "completed",
      agentKind: "main",
      model: "deepseek-flash",
    },
  },
};

// ---------------------------------------------------------------------------
// 场景 2：时间倒退的 attachment 行。锚点取 prompt 行的**运行最大值**（T0+10000），
// 不能回退到文件里后出现、时间戳更早的 attachment（T0+5000）。
// ---------------------------------------------------------------------------
export const BACKWARD_ATTACHMENT = {
  rows: [
    promptRow(T0 + 10_000),
    attachmentRow(T0 + 5000),
    assistantRow({ ts: T0 + 12_000, messageId: "msg-backward", outputTokens: 100, stopReason: "end_turn" }),
  ],
  expected: {
    candidates: 1,
    skippedZeroUsage: 0,
    skippedNoAnchor: 0,
    sample: { messageId: "msg-backward", windowStartMs: T0 + 10_000, durationMs: 2000, outputTokens: 100 },
    // 反事实：若取"最近一条 prompt 行"（attachment），会是 12000 − 5000。
    latestRowAnchorDurationMs: 7000,
  },
};

// ---------------------------------------------------------------------------
// 场景 3：不按时间排序。文件顺序里，T0+5000 的 user 行写在 msg-fileorder 首行之前；
// 若先按时间排序，msg-fileorder 首行只会看到 T0+1000 的 prompt 且 assistantTs=T0+1500，
// 会被判锚点陈旧 ⇒ 0 样本。本实现必须按文件顺序得到 1500 ms。
// ---------------------------------------------------------------------------
export const FILE_ORDER = {
  rows: [
    promptRow(T0 + 1000),
    assistantRow({ ts: T0 + 1500, messageId: "msg-previous", outputTokens: 5, stopReason: "end_turn" }),
    promptRow(T0 + 5000),
    assistantRow({ ts: T0 + 2000, messageId: "msg-fileorder", outputTokens: 0 }),
    assistantRow({ ts: T0 + 6500, messageId: "msg-fileorder", outputTokens: 25, stopReason: "end_turn" }),
  ],
  expected: {
    candidates: 2,
    skippedZeroUsage: 0,
    skippedNoAnchor: 0,
    fileOrderSamples: [
      { messageId: "msg-previous", windowStartMs: T0 + 1000, durationMs: 500 },
      { messageId: "msg-fileorder", windowStartMs: T0 + 5000, durationMs: 1500 },
    ],
    // 反事实：排序后 msg-fileorder 的锚点陈旧，样本数会从 2 变成 1。
    sortedSamples: 1,
  },
};

// ---------------------------------------------------------------------------
// 场景 4：锚点陈旧的同轮续写（§5.2 的真实形态）。
// 旧 prompt = BASE；之后写过零用量占位行 BASE+3387；目标消息首行在 BASE+6000。
// 允许 assistant 锚点会得 6306 ms，退回旧 prompt 会得 9693 ms —— 两者都不产出。
// ---------------------------------------------------------------------------
const STALE_BASE = Date.parse("2026-10-20T15:53:41.269Z");

export const STALE_ANCHOR = {
  rows: [
    promptRow(STALE_BASE),
    assistantRow({ ts: STALE_BASE + 3387, messageId: "msg-previous", outputTokens: 0 }),
    assistantRow({ ts: STALE_BASE + 6000, messageId: "msg-continuation", outputTokens: 0 }),
    assistantRow({ ts: STALE_BASE + 9693, messageId: "msg-continuation", outputTokens: 597, stopReason: "end_turn" }),
  ],
  expected: {
    // msg-previous：锚点可用但全零 ⇒ skippedZeroUsage；
    // msg-continuation：首行前已有 assistant 行 ⇒ skippedNoAnchor。
    candidates: 2,
    skippedZeroUsage: 1,
    skippedNoAnchor: 1,
    emitted: 0,
    assistantAnchorDurationMs: 6306, // BASE+9693 − (BASE+3387)
    oldPromptDurationMs: 9693, // BASE+9693 − BASE
  },
};

// ---------------------------------------------------------------------------
// 场景 5：全零消息与 `<synthetic>`。前者计 skippedZeroUsage；后者整条忽略、不进 candidates。
// ---------------------------------------------------------------------------
export const ZERO_AND_SYNTHETIC = {
  rows: [
    promptRow(T0),
    assistantRow({ ts: T0 + 1000, messageId: "msg-zero", outputTokens: 0 }),
    assistantRow({
      ts: T0 + 2000,
      messageId: "msg-synthetic",
      model: "<synthetic>",
      outputTokens: 0,
      stopReason: "stop_sequence",
    }),
  ],
  expected: {
    candidates: 1,
    skippedZeroUsage: 1,
    skippedNoAnchor: 0,
    emitted: 0,
    ignoredMessageId: "msg-synthetic",
  },
};

// ---------------------------------------------------------------------------
// 场景 6：子代理。路径含 /subagents/ 或任一行 isSidechain === true ⇒ subagent。
// ---------------------------------------------------------------------------
export const SUBAGENT = {
  dirs: ["fixture-project", "parent-session", "subagents"],
  name: "agent-explore.jsonl",
  rows: [
    promptRow(T0, PARENT_SESSION_ID),
    assistantRow({
      ts: T0 + 1500,
      messageId: "msg-subagent",
      outputTokens: 120,
      inputTokens: 300,
      stopReason: "end_turn",
      sessionId: PARENT_SESSION_ID,
      isSidechain: true,
      attributionAgent: "Explore",
      effort: "high",
    }),
  ],
  expected: {
    candidates: 1,
    skippedZeroUsage: 0,
    skippedNoAnchor: 0,
    sample: {
      messageId: "msg-subagent",
      sessionId: PARENT_SESSION_ID,
      agentKind: "subagent",
      agent: "Explore",
      reasoningEffort: "high",
      durationMs: 1500,
      outputTokens: 120,
    },
  },
};

export const SUBAGENT_PATH_ONLY = {
  dirs: ["fixture-project", "parent-session", "subagents"],
  name: "agent-path-only.jsonl",
  rows: [
    promptRow(T0, PARENT_SESSION_ID),
    assistantRow({
      ts: T0 + 900,
      messageId: "msg-subagent-path",
      outputTokens: 40,
      stopReason: "end_turn",
      sessionId: PARENT_SESSION_ID,
    }),
  ],
  expected: { agentKind: "subagent", agent: "" },
};

export const SIDECHAIN_IN_MAIN = {
  dirs: ["fixture-project"],
  name: "main-sidechain.jsonl",
  rows: [
    promptRow(T0),
    assistantRow({
      ts: T0 + 800,
      messageId: "msg-sidechain",
      outputTokens: 30,
      stopReason: "end_turn",
      isSidechain: true,
    }),
  ],
  expected: { agentKind: "subagent", agent: "" },
};

// ---------------------------------------------------------------------------
// 场景 7：坏 JSON + 缺 message.id + 同 sessionId 的无身份行。
// 无身份行不得变成样本，也不得并入 msg-real（output / lastTs 都保持 msg-real 自己的值）。
// ---------------------------------------------------------------------------
export const MALFORMED_UNKEYABLE = {
  rows: [
    promptRow(T0),
    assistantRow({ ts: T0 + 1000, messageId: "msg-real", outputTokens: 10, inputTokens: 100, stopReason: "end_turn" }),
    MALFORMED_LINE,
    assistantRow({ ts: T0 + 2000, outputTokens: 999, inputTokens: 5000, stopReason: "end_turn" }),
  ],
  expected: {
    candidates: 1,
    skippedZeroUsage: 0,
    skippedNoAnchor: 0,
    missingMessageId: 1,
    malformedLines: 1,
    sample: { messageId: "msg-real", outputTokens: 10, tsMs: T0 + 1000, durationMs: 1000 },
    warnings: [
      { sourceKind: "claude", code: "MALFORMED_JSON", count: 1 },
      { sourceKind: "claude", code: "UNKEYABLE_RECORD", count: 1 },
    ],
  },
};

// ---------------------------------------------------------------------------
// 场景 8：没有 prompt 行 ⇒ skippedNoAnchor；attachment-only 锚点 ⇒ 正常产出。
// ---------------------------------------------------------------------------
export const NO_PROMPT = {
  rows: [assistantRow({ ts: T0, messageId: "msg-no-prompt", outputTokens: 50, stopReason: "end_turn" })],
  expected: { candidates: 1, skippedZeroUsage: 0, skippedNoAnchor: 1, emitted: 0 },
};

export const ATTACHMENT_ANCHOR = {
  rows: [
    attachmentRow(T0),
    assistantRow({ ts: T0 + 2500, messageId: "msg-attachment", outputTokens: 80, stopReason: "end_turn" }),
  ],
  expected: {
    candidates: 1,
    skippedZeroUsage: 0,
    skippedNoAnchor: 0,
    sample: { messageId: "msg-attachment", windowStartMs: T0, durationMs: 2500, outputTokens: 80 },
  },
};
