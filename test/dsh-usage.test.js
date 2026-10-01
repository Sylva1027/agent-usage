import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import { estimateEventCost } from "../src/pricing.js";
import { USAGE_DETAIL_MASK, USAGE_DETAIL_INCONSISTENT, validateUsageDetails } from "../public/usage-fields.js";
import {
  buildUsageFingerprint,
  buildUsageIndex,
  buildUsageReport,
  classifyImportDirectory,
  discoverDshHomes,
  discoverUsageSources,
} from "../src/usage-core.js";
import {
  DSH_SESSION_FORMAT_VERSION,
  dshHomeLooksUsable,
  dshSessionFiles,
  dshSessionHeader,
  dshSourceStat,
  dshUsageFromRaw,
  parseDshSessions,
  readDshSessionRows,
  streamDshSessionEvents,
} from "../src/dsh-usage.js";

// 正文哨兵：若任何产出事件里出现这些字符串，说明解析器读了不该读的字段。
const PROMPT_SENTINEL = "PROMPT-SENTINEL-不要出现在事件里";
const STREAM_SENTINEL = "STREAM-SENTINEL-不要出现在事件里";
const TOOL_SENTINEL = "TOOL-ARGS-SENTINEL-不要出现在事件里";

/** 用真实结构的记录造一个会话日志；frame 是「每个 zstd 帧里的记录数组」。 */
async function makeDshHome({ sessionId = "session-test-0001", frames = [] } = {}) {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-usage-dsh-"));
  const sessionDir = path.join(homeDir, "sessions", "--E-work-dshproj--", sessionId);
  await mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `session.v${DSH_SESSION_FORMAT_VERSION}.jsonl.zstd`);

  // 每帧独立压缩后拼接 —— 与 DSH 的流式追加写法一致，这是本模块的核心回归点。
  const buffers = frames.map((rows) =>
    zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8")),
  );
  await writeFile(filePath, Buffer.concat(buffers));
  return { homeDir, filePath };
}

function sessionHeader(overrides = {}) {
  return {
    type: "session",
    version: DSH_SESSION_FORMAT_VERSION,
    id: "session-test-0001",
    createdAt: Date.parse("2026-09-27T10:00:00.000Z"),
    cwd: "E:\\work\\dshproj",
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: "standard",
    ...overrides,
  };
}

function requestHeader(model = "deepseek-flash", provider = "deepseek-account") {
  return {
    type: "request/header",
    seq: 2,
    time: Date.parse("2026-09-27T10:00:01.000Z"),
    data: {
      header: { config: { provider, model, reasoningEffort: "max", maxTokens: 256000 } },
      reason: "turn-start",
    },
  };
}

/** 用量事件记录。默认值取自真实日志实测样本（input/cacheRead/write/output/total）。 */
function assistantMessage({
  seq = 3,
  time = Date.parse("2026-09-27T10:00:02.000Z"),
  turn = 1,
  step = 1,
  usage = { inputTokens: 1614, outputTokens: 127, cacheReadTokens: 6784, cacheWriteTokens: 0, totalTokens: 8525 },
} = {}) {
  return {
    type: "assistant/message",
    seq,
    time,
    surfaceOp: "append",
    data: {
      turn,
      step,
      message: { content: [{ text: PROMPT_SENTINEL }] },
      usage,
      stream: [{ type: "delta", time, chunk: { text: STREAM_SENTINEL } }],
    },
  };
}

function collect(filePath, source, options = {}) {
  const events = [];
  const warnings = [];
  const merged = { onWarning: (warning) => warnings.push(warning), ...options };
  return streamDshSessionEvents(filePath, source, (event) => events.push(event), merged).then(() => ({
    events,
    warnings,
  }));
}

const SOURCE = { id: "dsh-test", label: "Main DSH", path: "C:\\Users\\test\\.dsh" };

// ---------------------------------------------------------------- 语义测试 1：多帧解压

test("readDshSessionRows 逐个 zstd 帧解压，不会只读出第一帧", async () => {
  // 4 个独立帧。zstdDecompressSync 整文件解压只会出第一帧且不报错，
  // 所以「只读到 4 行」正是这个 bug 的症状。
  const { filePath } = await makeDshHome({
    frames: [
      [sessionHeader()],
      [requestHeader(), assistantMessage({ seq: 3 })],
      [assistantMessage({ seq: 4, step: 2 })],
      [assistantMessage({ seq: 5, step: 3 }), { type: "turn/end", seq: 6, time: 0, data: { turn: 1 } }],
    ],
  });

  const rows = await readDshSessionRows(filePath);
  assert.equal(rows.length, 6, "应该读出全部 6 条记录，而不是第一帧的 1 条");
  assert.equal(rows[0].type, "session");
  assert.equal(rows.at(-1).type, "turn/end");
  assert.deepEqual(
    rows.map((row) => row.seq ?? null).filter((seq) => seq !== null),
    [2, 3, 4, 5, 6],
    "seq 应严格递增且连续",
  );
});

test("streamDshSessionEvents 跨全部帧产出事件", async () => {
  const { filePath } = await makeDshHome({
    frames: [
      [sessionHeader()],
      [requestHeader(), assistantMessage({ seq: 3, step: 1 })],
      [assistantMessage({ seq: 4, step: 2 })],
    ],
  });

  const { events, warnings } = await collect(filePath, SOURCE);
  assert.equal(warnings.length, 0);
  assert.equal(events.length, 2, "两帧各一条 assistant/message，应产出 2 个事件");
  assert.deepEqual(
    events.map((event) => event.step),
    [1, 2],
  );
});

// ---------------------------------------------------------------- 语义测试 2：映射不变量

test("dshUsageFromRaw 把并列计数重构成 cached <= input 的超集", () => {
  const mapped = dshUsageFromRaw({
    inputTokens: 1614,
    outputTokens: 127,
    cacheReadTokens: 6784,
    cacheWriteTokens: 0,
    totalTokens: 8525,
  });

  // 真实样本自证：inputTokens(1614) 是未命中部分，与 cacheReadTokens(6784) 并列。
  assert.deepEqual(mapped.usage, { total: 8525, input: 8398, cached: 6784, output: 127, reasoning: 0 });
  assert.equal(mapped.requestInputTokens, 8398);
  assert.equal(mapped.cacheWriteTokens, 0);
  assert.equal(mapped.cacheWriteKnown, true);
  assert.equal(
    mapped.detailMask,
    USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.cached | USAGE_DETAIL_MASK.output | USAGE_DETAIL_MASK.cacheWrite,
  );
  assert.ok(mapped.usage.cached <= mapped.usage.input, "cached 必须是 input 的子集");
});

test("真实样本经 validateUsageDetails 无一致性缺口，且不撤销缓存明细", () => {
  const mapped = dshUsageFromRaw({
    inputTokens: 1614,
    outputTokens: 127,
    cacheReadTokens: 6784,
    cacheWriteTokens: 0,
    totalTokens: 8525,
  });
  const validated = validateUsageDetails(mapped.usage, mapped.detailMask);

  assert.equal(validated.reconciliationGap, 0, "不应产生对账缺口");
  assert.equal(validated.detailMask & USAGE_DETAIL_INCONSISTENT, 0, "不应被标记为不一致");
  assert.ok(validated.detailMask & USAGE_DETAIL_MASK.cached, "缓存明细必须保留");
  // total 恰好等于 input + output（DSH 的 totalTokens 定义就是四项之和）。
  // 这条一旦被打破，看板会静默转入「最低费率估算」，所以在此锁死。
  assert.equal(mapped.usage.total, mapped.usage.input + mapped.usage.output);
});

test("天真映射（input ← inputTokens）会触发缓存明细撤销与不一致标记", () => {
  // 反向断言：证明 §3.3 的重构不是可选优化，而是必需。
  const naive = { total: 8525, input: 1614, cached: 6784, output: 127, reasoning: 0 };
  const mask = USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.cached | USAGE_DETAIL_MASK.output;
  const validated = validateUsageDetails(naive, mask);

  assert.ok(validated.reconciliationGap > 0, "天真映射会产生对账缺口");
  assert.ok(validated.detailMask & USAGE_DETAIL_INCONSISTENT, "天真映射会被标记为不一致");
  assert.equal(validated.detailMask & USAGE_DETAIL_MASK.cached, 0, "天真映射会丢掉缓存明细");
});

// ---------------------------------------------------------------- 语义测试 3：计价分档

test("DSH 用量走正常计价分档，币种为 CNY", () => {
  const mapped = dshUsageFromRaw({
    inputTokens: 1614,
    outputTokens: 127,
    cacheReadTokens: 6784,
    cacheWriteTokens: 0,
    totalTokens: 8525,
  });
  const cost = estimateEventCost({
    model: "deepseek-flash",
    channel: "DSH",
    usage: mapped.usage,
    total: mapped.usage,
    detailMask: mapped.detailMask,
    cacheWriteTokens: mapped.cacheWriteTokens,
    cacheWriteKnown: mapped.cacheWriteKnown,
    requestInputTokens: mapped.requestInputTokens,
    contextLevel: "short",
    serviceTier: "unknown",
  });

  assert.equal(cost.currency, "CNY", "DSH 的 DeepSeek 用量必须按人民币计价");
  assert.equal(cost.pricingStatus, "estimated", "应走正常分档，而不是最低费率估算");
  assert.equal(cost.minimumEstimatedTokens, 0, "不应有最低费率兜底的 token");
  assert.ok(!cost.unpricedReasons.includes("unknown-model-price-minimum-scenario"));
  assert.ok(!cost.unpricedReasons.includes("input-detail-inconsistent-minimum-scenario"));
  assert.ok(cost.totalUsd > 0);
  // 未命中 1614、命中 6784 应分别计价，而不是合并按同一费率。
  assert.ok(cost.inputUsd > 0);
  assert.ok(cost.cachedInputUsd > 0);
  assert.ok(cost.inputUsd > cost.cachedInputUsd, "未命中单价高于命中单价");
});

// 价目表未收录的模型只能按渠道兜底判币种（currencyForEvent 的 model.key 为空分支）。
test("未知模型名的 DSH 用量按 CNY 而非 USD 兜底", () => {
  const event = {
    model: "totally-unknown-model-xyz",
    usage: { total: 100, input: 100, cached: 50, output: 10, reasoning: 0 },
    detailMask: USAGE_DETAIL_MASK.input | USAGE_DETAIL_MASK.cached | USAGE_DETAIL_MASK.output,
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    requestInputTokens: 100,
    contextLevel: "short",
  };

  assert.equal(estimateEventCost({ ...event, channel: "DSH" }).currency, "CNY");
  assert.equal(estimateEventCost({ ...event, channel: "DSH Subagent" }).currency, "CNY");
  assert.equal(estimateEventCost({ ...event, channel: "ZCode" }).currency, "CNY");
  // source 兜底路径同样要认 dsh。
  assert.equal(estimateEventCost({ ...event, source: "dsh" }).currency, "CNY");
  // Codex 仍应是美元：别把范围扩过头。
  assert.equal(estimateEventCost({ ...event, channel: "CLI" }).currency, "USD");
  assert.equal(estimateEventCost({ ...event, channel: "Codex Desktop" }).currency, "USD");
});

// ---------------------------------------------------------------- 发现与元数据

test("dshHomeLooksUsable 与 dshSessionFiles 只认 sessions 目录下的会话日志", async () => {
  const { homeDir, filePath } = await makeDshHome({ frames: [[sessionHeader()]] });

  assert.equal(await dshHomeLooksUsable(homeDir), true);
  assert.equal(await dshHomeLooksUsable(path.join(homeDir, "nope")), false);

  assert.deepEqual(await dshSessionFiles(homeDir), [filePath]);
});

test("dshSourceStat 返回 size 与 mtimeMs", async () => {
  const { filePath } = await makeDshHome({ frames: [[sessionHeader()]] });
  const info = await dshSourceStat(filePath);
  assert.ok(info.size > 0);
  assert.ok(Number.isFinite(info.mtimeMs));
});

test("dshSessionHeader 解析会话头，缺头时返回 null", async () => {
  const header = dshSessionHeader([{ type: "turn/start", seq: 0 }]);
  assert.equal(header, null);

  const parsed = dshSessionHeader([
    sessionHeader({ id: "abc", delegationDepth: 2, cwd: "E:\\x", createdAtMs: 123 }),
    { type: "turn/start" },
  ]);
  assert.equal(parsed.id, "abc");
  assert.equal(parsed.version, DSH_SESSION_FORMAT_VERSION);
  assert.equal(parsed.cwd, "E:\\x");
  assert.equal(parsed.delegationDepth, 2);
});

test("事件带 channel、模型、仓库与上下文分级", async () => {
  const { filePath } = await makeDshHome({
    frames: [[sessionHeader()], [requestHeader("deepseek-flash", "deepseek-account"), assistantMessage()]],
  });

  const { events } = await collect(filePath, SOURCE);
  assert.equal(events.length, 1);
  const event = events[0];
  assert.equal(event.channel, "DSH");
  assert.equal(event.source, "dsh");
  assert.equal(event.model, "deepseek-flash");
  assert.equal(event.modelProvider, "deepseek-account");
  assert.equal(event.sessionId, "session-test-0001");
  assert.equal(event.project, "E:\\work\\dshproj");
  assert.equal(event.repositoryKind, "directory");
  assert.equal(event.serviceTier, "unknown");
  assert.equal(event.requestInputTokens, 8398);
  assert.equal(event.contextLevel, "short");
  assert.ok(event.priceVersion);
  assert.equal(event.timestamp, "2026-09-27T10:00:02.000Z");
});

test("delegationDepth 大于 0 时渠道为 DSH Subagent", async () => {
  const { filePath } = await makeDshHome({
    frames: [[sessionHeader({ delegationDepth: 1 })], [requestHeader(), assistantMessage()]],
  });

  const { events } = await collect(filePath, SOURCE);
  assert.equal(events[0].channel, "DSH Subagent");
});

test("模型跟随 request/header 变化，未出现时回落 Unknown model", async () => {
  const { filePath } = await makeDshHome({
    frames: [
      [sessionHeader()],
      [requestHeader("deepseek-flash"), assistantMessage({ seq: 3, step: 1 })],
      [requestHeader("deepseek-v4-pro"), assistantMessage({ seq: 4, step: 2 })],
    ],
  });

  const { events } = await collect(filePath, SOURCE);
  assert.deepEqual(
    events.map((event) => event.model),
    ["deepseek-flash", "deepseek-v4-pro"],
  );

  const { filePath: noHeaderFile } = await makeDshHome({ frames: [[sessionHeader()], [assistantMessage()]] });
  const fallback = await collect(noHeaderFile, SOURCE);
  assert.equal(fallback.events[0].model, "Unknown model");
});

test("session/title 取最后一条并截断到 120 字符", async () => {
  const long = "阿".repeat(200);
  const { filePath } = await makeDshHome({
    frames: [
      [sessionHeader()],
      [
        { type: "session/title", seq: 3, time: 1, data: { title: "早期粗稿" } },
        { type: "session/title", seq: 4, time: 2, data: { title: long } },
        requestHeader(),
        assistantMessage({ seq: 5 }),
      ],
    ],
  });

  const { events } = await collect(filePath, SOURCE);
  assert.equal(events[0].conversationName.length, 121, "120 字符 + 省略号");
  assert.ok(events[0].conversationName.endsWith("…"));
});

// ---------------------------------------------------------------- 容错

test("损坏帧只记警告，其余帧照常解析", async () => {
  const { filePath } = await makeDshHome({
    frames: [[sessionHeader()], [requestHeader(), assistantMessage()]],
  });
  // 在第一帧与第二帧之间插入「带 zstd 魔数但内容非法」的字节，模拟写入中断。
  // 注意要在**帧边界**上插，否则会破坏会话头那一帧。
  const headerFrame = zstdCompressSync(Buffer.from(`${JSON.stringify(sessionHeader())}\n`, "utf8"));
  const usageFrame = zstdCompressSync(
    Buffer.from(`${JSON.stringify(requestHeader())}\n${JSON.stringify(assistantMessage())}\n`, "utf8"),
  );
  const corrupt = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03]);
  await writeFile(filePath, Buffer.concat([headerFrame, corrupt, usageFrame]));

  const { events, warnings } = await collect(filePath, SOURCE);
  assert.ok(
    warnings.some((warning) => warning.includes("损坏帧")),
    `应报告损坏帧，实际 warnings=${JSON.stringify(warnings)}`,
  );
  assert.equal(events.length, 1, "完好帧仍应产出事件");
});

test("畸形帧或解出空内容的帧都不能作为 DSH 记录", async () => {
  const { filePath } = await makeDshHome({ frames: [] });
  // zstd 对畸形帧可能抛错，也可能返回空 buffer；验证解析器契约，不锁定平台行为。
  // 合法的零内容帧确定覆盖不抛错但返回空内容的分支，DSH 不写这种帧。
  for (const frame of [
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02, 0x03]),
    zstdCompressSync(Buffer.alloc(0)),
  ]) {
    await writeFile(filePath, frame);
    await assert.rejects(() => readDshSessionRows(filePath), /无法解压 DSH 会话日志/);
  }
});

test("无法解压时抛错，由上层记录警告", async () => {
  const { filePath } = await makeDshHome({ frames: [] });
  await writeFile(filePath, Buffer.from("not a zstd file at all"));

  await assert.rejects(() => readDshSessionRows(filePath), /无法解压 DSH 会话日志/);
});

test("坏 JSON 行被跳过", async () => {
  const { homeDir } = await makeDshHome({ frames: [[sessionHeader()]] });
  const sessionDir = path.join(homeDir, "sessions", "--E-work-dshproj--", "session-test-0001");
  const filePath = path.join(sessionDir, `session.v${DSH_SESSION_FORMAT_VERSION}.jsonl.zstd`);
  await writeFile(filePath, zstdCompressSync(Buffer.from(`${JSON.stringify(sessionHeader())}\n{ 坏行\n`, "utf8")));

  const rows = await readDshSessionRows(filePath);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, "session");
});

test("格式版本不是 v4 时跳过并告警", async () => {
  const { filePath } = await makeDshHome({
    frames: [[sessionHeader({ version: 3 })], [requestHeader(), assistantMessage()]],
  });

  const { events, warnings } = await collect(filePath, SOURCE);
  assert.equal(events.length, 0, "不应按 v4 硬解其它版本");
  assert.ok(warnings.some((warning) => warning.includes("格式版本")));
});

test("全部用量为零的记录不产出事件", async () => {
  const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 };
  const { filePath } = await makeDshHome({
    frames: [[sessionHeader()], [requestHeader(), assistantMessage({ usage: zero })]],
  });

  const { events } = await collect(filePath, SOURCE);
  assert.equal(events.length, 0);
});

test("缺少 data.usage 的 assistant/message 被忽略", async () => {
  const { filePath } = await makeDshHome({
    frames: [
      [sessionHeader()],
      [requestHeader(), { type: "assistant/message", seq: 3, time: 1, data: { turn: 1, step: 1 } }],
    ],
  });

  const { events } = await collect(filePath, SOURCE);
  assert.equal(events.length, 0);
});

test("没有会话头的日志被跳过", async () => {
  const { filePath } = await makeDshHome({ frames: [[requestHeader(), assistantMessage()]] });
  const { events, warnings } = await collect(filePath, SOURCE);
  assert.equal(events.length, 0);
  assert.equal(warnings.length, 0);
});

// ---------------------------------------------------------------- 隐私

test("正文与工具参数不会进入任何产出事件", async () => {
  const { filePath } = await makeDshHome({
    frames: [
      [sessionHeader()],
      [
        requestHeader(),
        {
          type: "tool/call",
          seq: 4,
          time: 1,
          data: { turn: 1, step: 1, callId: "c1", name: "read", arguments: TOOL_SENTINEL },
        },
        { type: "tool/result", seq: 5, time: 2, data: { turn: 1, step: 1, message: { text: TOOL_SENTINEL } } },
        assistantMessage({ seq: 6 }),
      ],
    ],
  });

  const events = [];
  await streamDshSessionEvents(filePath, SOURCE, (event) => events.push(event));
  const serialized = JSON.stringify(events);

  assert.ok(!serialized.includes(PROMPT_SENTINEL), "不得带出 message 正文");
  assert.ok(!serialized.includes(STREAM_SENTINEL), "不得带出 stream 分片");
  assert.ok(!serialized.includes(TOOL_SENTINEL), "不得带出工具参数或结果");
  assert.ok(!serialized.includes("message"), "事件形状里不应出现 message 字段");
});

// ---------------------------------------------------------------- parseDshSessions

test("parseDshSessions 汇总多个会话并按会话去重", async () => {
  const { homeDir } = await makeDshHome({
    sessionId: "session-aaa",
    frames: [[sessionHeader({ id: "session-aaa" })], [requestHeader(), assistantMessage({ seq: 3, step: 1 })]],
  });
  // 同一 home 下第二个会话。
  const secondDir = path.join(homeDir, "sessions", "--E-work-other--", "session-bbb");
  await mkdir(secondDir, { recursive: true });
  await writeFile(
    path.join(secondDir, `session.v${DSH_SESSION_FORMAT_VERSION}.jsonl.zstd`),
    Buffer.concat([
      zstdCompressSync(
        Buffer.from(`${JSON.stringify(sessionHeader({ id: "session-bbb", cwd: "E:\\work\\other" }))}\n`),
      ),
      zstdCompressSync(
        Buffer.from(
          `${JSON.stringify(requestHeader())}\n${JSON.stringify(assistantMessage({ seq: 3, step: 1, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 120 } }))}\n`,
        ),
      ),
    ]),
  );

  const { sessions, events } = await parseDshSessions(homeDir, SOURCE);
  assert.equal(events.length, 2);
  assert.equal(sessions.length, 2);

  const first = sessions.find((session) => session.id === "session-aaa");
  assert.equal(first.eventCount, 1);
  assert.equal(first.model, "deepseek-flash");
  assert.equal(first.modelProvider, "deepseek-account");
  assert.deepEqual(first.total, { total: 8525, input: 8398, cached: 6784, output: 127, reasoning: 0 });

  const second = sessions.find((session) => session.id === "session-bbb");
  assert.equal(second.cwd, "E:\\work\\other");
  assert.deepEqual(second.total, { total: 120, input: 100, cached: 0, output: 20, reasoning: 0 });
});

// ---------------------------------------------------------------- usage-core 接线

/** 造一个只含 DSH home 的临时 homeDir，避免测试看到真实机器上的 Codex/ZCode。 */
async function makeIsolatedHome() {
  const { homeDir, filePath } = await makeDshHome({
    frames: [[sessionHeader()], [requestHeader(), assistantMessage()]],
  });
  // makeDshHome 直接建在 homeDir 下，这里补上 .dsh 这一层。
  const dshDir = path.join(homeDir, ".dsh");
  await mkdir(path.join(dshDir, "sessions"), { recursive: true });
  const target = path.join(dshDir, "sessions", "--E-work-dshproj--", "session-test-0001");
  await mkdir(target, { recursive: true });
  await copyFile(filePath, path.join(target, `session.v${DSH_SESSION_FORMAT_VERSION}.jsonl.zstd`));
  return { homeDir, dshDir };
}

test("discoverDshHomes 发现 ~/.dsh，支持环境变量追加与整体关闭", async () => {
  const { homeDir, dshDir } = await makeIsolatedHome();

  const homes = await discoverDshHomes({ homeDir, env: {} });
  assert.equal(homes.length, 1);
  assert.equal(homes[0].label, "Main DSH");
  assert.equal(homes[0].kind, "dsh");
  assert.equal(homes[0].path, dshDir);
  // DSH 的用量分散在多个会话文件里，因此刻意不设 usageLogPath。
  assert.equal(homes[0].usageLogPath, undefined);

  assert.deepEqual(await discoverDshHomes({ homeDir, env: { CODEX_USAGE_DSH: "0" } }), []);

  const other = await makeIsolatedHome();
  const withExtra = await discoverDshHomes({
    homeDir,
    env: { CODEX_USAGE_DSH_HOMES: other.dshDir },
  });
  assert.equal(withExtra.length, 2);
  assert.ok(withExtra.some((home) => home.path === other.dshDir));
});

test("discoverUsageSources 把 DSH 作为第三个来源并入", async () => {
  const { homeDir } = await makeIsolatedHome();

  const sources = await discoverUsageSources({ homeDir, env: {} });
  const dsh = sources.find((source) => source.kind === "dsh");
  assert.ok(dsh, "应发现 DSH 来源");
  assert.equal(dsh.label, "Main DSH");

  const disabled = await discoverUsageSources({ homeDir, env: { CODEX_USAGE_DSH: "0" } });
  assert.equal(
    disabled.find((source) => source.kind === "dsh"),
    undefined,
  );
});

test("classifyImportDirectory 识别 DSH home，且不会被 Codex 的 sessions 目录抢判", async () => {
  const { homeDir, dshDir } = await makeIsolatedHome();
  const codexDir = path.join(homeDir, ".codex");
  await mkdir(path.join(codexDir, "sessions", ".tmp"), { recursive: true });
  // Codex 的残留临时目录里也有 jsonl —— 不能因此把 .codex 判成 DSH。
  await writeFile(path.join(codexDir, "sessions", ".tmp", "rollout-x.jsonl"), "{}\n");

  assert.equal((await classifyImportDirectory(dshDir)).type, "dsh-home");
  assert.equal((await classifyImportDirectory(codexDir)).type, "codex-home");

  const bogus = await classifyImportDirectory(path.join(homeDir, "nope"));
  assert.equal(bogus.type, "unsupported");
  assert.match(bogus.reason, /DSH home/);
});

test("dshHomeLooksUsable 要求存在真正的 v4 会话日志", async () => {
  const { homeDir } = await makeIsolatedHome();
  // 只有空 sessions 目录的目录不算 DSH home。
  const empty = path.join(homeDir, "empty-home");
  await mkdir(path.join(empty, "sessions"), { recursive: true });
  assert.equal(await dshHomeLooksUsable(empty), false);
  assert.equal(await dshHomeLooksUsable(path.join(homeDir, ".dsh")), true);
});

test("buildUsageReport 汇总 DSH 事件与会话", async () => {
  const { homeDir } = await makeIsolatedHome();

  const report = await buildUsageReport({ homeDir, env: {} });
  const dshEvents = report.events.filter((event) => event.source === "dsh");
  assert.equal(dshEvents.length, 1);
  assert.equal(dshEvents[0].channel, "DSH");
  assert.equal(dshEvents[0].model, "deepseek-flash");
  assert.deepEqual(dshEvents[0].total, { total: 8525, input: 8398, cached: 6784, output: 127, reasoning: 0 });

  const dshSessions = report.sessions.filter((session) => session.source === "dsh");
  assert.equal(dshSessions.length, 1);
  assert.equal(dshSessions[0].eventCount, 1);
});

test("buildUsageIndex 产出 DSH 索引事件（未命中/命中拆分保持正确）", async () => {
  const { homeDir } = await makeIsolatedHome();

  const index = await buildUsageIndex({ homeDir, env: {} });
  const dshEvents = index.events.filter((event) => ["DSH", "DSH Subagent"].includes(index.strings[event.c]));
  assert.equal(dshEvents.length, 1);
  const event = dshEvents[0];
  assert.equal(index.strings[event.m], "deepseek-flash");
  assert.equal(event.total, 8525);
  assert.equal(event.input, 8398);
  assert.equal(event.cached, 6784);
  assert.equal(event.output, 127);
  assert.equal(event.detailMask, 39);
  assert.equal(event.cacheWriteKnown, true);
  assert.equal(event.requestInputTokens, 8398);
  // 索引路径也必须守住 cached <= input，否则计价会退化。
  assert.ok(event.cached <= event.input);
  // DSH 不提供限额观察值。
  assert.equal(index.rateLimitObservations.length, 0);
});

test("buildUsageFingerprint 把 DSH 会话文件计入指纹", async () => {
  const { homeDir } = await makeIsolatedHome();

  const first = await buildUsageFingerprint({ homeDir, env: {} });
  assert.equal(first.homeCount, 1);
  assert.equal(first.fileCount, 1);
  const unchanged = await buildUsageFingerprint({ homeDir, env: {} });
  assert.equal(unchanged.fingerprint, first.fingerprint, "文件未变时指纹应稳定");
});
