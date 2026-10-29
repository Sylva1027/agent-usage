/**
 * DSH generation TPS reader 契约测试。
 *
 * 夹具是**人工合成**的多帧 `.jsonl.zstd`（每帧独立 zstd 压缩后拼接，复现 DSH 的流式追加写法），
 * 直接驱动 `streamDshPerfSamples(filePath, source, onSample, { onWarning })`。
 *
 * **正文哨兵**：message 文本、流式载荷、步骤结束帧的产物里各塞一个独特魔法串；断言交给
 * `onSample` 的规范候选完全不含它们。合法 packed stream 只贡献计数、时间与空串边界，
 * text/args 原文不离开 reader。
 *
 * 帧序判别式（裁定 G）：`step/end` 必须**严格晚于**本组最后一条 `assistant/message`。
 * 本文件用一段**静态访问证明**锁定"步骤结束帧只读 `{turn,step}` + 帧序、不读 `time`"。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { streamDshPerfSamples } from "../src/perf-sources/dsh.js";
import { PERF_FLAGS, PERF_METHOD_VERSION, perfFlagNamesOf } from "../src/perf-stats.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const READER_FILE = path.join(REPO_ROOT, "src", "perf-sources", "dsh.js");
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const SESSION_ID = "session-reader-0001";
const HOME_ID = "home-reader-0001";
const BODY_SENTINEL = "DSH-READER-BODY-SENTINEL-3d71";
const STREAM_SENTINEL = "DSH-READER-STREAM-SENTINEL-9c02";
const STEP_END_SENTINEL = "DSH-READER-STEP-END-SENTINEL-5abe";
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const NO_REASONING_FIELD = Symbol("missing reasoning field");

function frame(rows) {
  return zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8"));
}

/** 逐字写入原始文本帧：用于构造坏 JSON 行。 */
function textFrame(text) {
  return zstdCompressSync(Buffer.from(text, "utf8"));
}

function corruptFrame() {
  return Buffer.concat([ZSTD_MAGIC, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])]);
}

function sessionRow(overrides = {}) {
  return {
    type: "session",
    version: 4,
    id: SESSION_ID,
    cwd: "E:\\fixture\\reader",
    createdAt: T0,
    delegationDepth: 0,
    agentPreset: "standard",
    ...overrides,
  };
}

function requestRow({ seq = 2, time = T0 + 500, model = "model-a", provider = "prov-a" } = {}) {
  return {
    type: "request/header",
    seq,
    time,
    data: { header: { config: { model, provider, reasoningEffort: "max" } }, reason: "turn-start" },
  };
}

function stepStartRow({ seq = 3, time = T0 + 1000, turn = 1, step = 1 } = {}) {
  return { type: "step/start", seq, time, data: { turn, step } };
}

function retryStartedRow({ seq = 4, time = T0 + 1500, turn = 1, step = 1 } = {}) {
  return { type: "llm/retry-started", seq, time, data: { turn, step } };
}

/** 步骤结束帧：产物里带哨兵，`time` 故意是"若被读取就会污染结果"的值。 */
function stepEndRow({ seq = 4, time = T0 + 999_000, turn = 1, step = 1, includeTime = true } = {}) {
  const row = { type: "step/end", seq, data: { turn, step, marker: STEP_END_SENTINEL } };
  if (includeTime) {
    row.time = time;
  }
  return row;
}

function messageRow({
  seq = 5,
  time = T0 + 2000,
  turn = 1,
  step = 1,
  outputTokens = 100,
  includeUsage = true,
  includePayload = true,
} = {}) {
  const data = { turn, step };
  if (includePayload) {
    data.message = { content: [{ type: "text", text: BODY_SENTINEL }] };
    data.stream = [{ type: "delta", time, chunk: { text: STREAM_SENTINEL } }];
  }
  if (includeUsage) {
    data.usage = {
      inputTokens: 1614,
      cacheReadTokens: 6784,
      cacheWriteTokens: 0,
      outputTokens,
      totalTokens: 8525,
    };
  }
  return { type: "assistant/message", seq, time, surfaceOp: "append", data };
}

function generationMessageRow({
  seq = 5,
  time = T0 + 2000,
  turn = 1,
  step = 1,
  outputTokens = 12,
  reasoningTokens = NO_REASONING_FIELD,
  stream,
} = {}) {
  const row = messageRow({
    seq,
    time,
    turn,
    step,
    outputTokens,
    includePayload: false,
  });
  row.data.stream = stream;
  if (reasoningTokens !== NO_REASONING_FIELD) {
    row.data.usage.reasoningTokens = reasoningTokens;
  }
  return row;
}

function textChunks(time0, texts, dt, index = 0) {
  return { type: "text-chunks", time0, index, dt, texts };
}

function reasoningChunks(time0, texts, dt, index = 0) {
  return { type: "reasoning-chunks", time0, index, dt, texts };
}

function toolChunks(time0, args, dt, { index = 0, id = "tool-fixture", name = "fixture-tool" } = {}) {
  return {
    type: "tool-call-chunks",
    time0,
    index,
    dt,
    id,
    ...(name === undefined ? {} : { name }),
    args,
  };
}

function writeLog(frames, { fileName = "session.v4.jsonl.zstd" } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "perf-dsh-reader-"));
  const file = path.join(dir, fileName);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat(frames.map((entry) => (Buffer.isBuffer(entry) ? entry : frame(entry)))));
  return { dir, file };
}

async function readLog(file, { source = { id: HOME_ID, label: "DSH", path: "/fixture/.dsh" } } = {}) {
  const samples = [];
  const warnings = [];
  const result = await streamDshPerfSamples(file, source, (sample) => samples.push(sample), {
    onWarning: (warning) => warnings.push(warning),
  });
  return { samples, warnings, result };
}

/**
 * 与 `readLog` 相同，但**额外**捕获 reader 交给 `normalizePerfSample` 之前的 `raw`。
 *
 * 用途：断言"reader **没有写**某个字段"（如裁定 AU / D3 的 `filterReason`）。规范化后的样本
 * 会把缺省字段补成 `""`，因此**不能**用规范化样本来证明"reader 没写" —— 必须看 raw。
 *
 * 做法：把 reader 源码**复制到临时目录**、只改这一份副本（`normalizePerfSample(x)` →
 * `__spyNormalize(x)`，并在其 import 行插入 spy 的 import），再从副本 import。
 * **仓库里的 `src/perf-sources/dsh.js` 逐字节不动**（副本用完即删）。
 * 若写法变了导致替换匹配不上 ⇒ **立即抛错**，不会静默退化成"没观察到"。
 */
async function readLogWithRaw(file, { source = { id: HOME_ID, label: "DSH", path: "/fixture/.dsh" } } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-raw-"));
  try {
    const original = readFileSync(READER_FILE, "utf8");
    const callPattern = /normalizePerfSample\((\w+)\)/g;
    if (!callPattern.test(original)) {
      throw new Error("reader 里找不到 normalizePerfSample(<标识符>) 调用，spy 需要同步更新");
    }
    const spySource = [
      `import { normalizePerfSample as __real } from ${JSON.stringify(
        pathToFileURL(path.join(REPO_ROOT, "src", "perf-stats.js")).href,
      )};`,
      "export const __captured = [];",
      "function __spyNormalize(raw) { __captured.push(raw); return __real(raw); }",
      "",
    ].join("\n");
    // 副本换目录后相对 import 会失效 ⇒ 把相对路径统一改写为绝对 file:// URL（跨平台安全）
    const readerDirUrl = pathToFileURL(path.join(REPO_ROOT, "src", "perf-sources") + path.sep).href;
    const absolutized = original.replace(
      /from\s+"(\.[^"]*)"/g,
      (_match, relative) => `from ${JSON.stringify(new URL(relative, readerDirUrl).href)}`,
    );
    const patched = absolutized.replace(callPattern, "__spyNormalize($1)");
    const readerCopy = path.join(dir, "dsh-spy.mjs");
    writeFileSync(readerCopy, spySource + patched, "utf8");
    const mod = await import(pathToFileURL(readerCopy).href);
    const samples = [];
    const warnings = [];
    const result = await mod.streamDshPerfSamples(file, source, (sample) => samples.push(sample), {
      onWarning: (warning) => warnings.push(warning),
    });
    return { samples, warnings, result, rawSamples: mod.__captured };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sampleKeyOf(sessionId, turn, step) {
  return JSON.stringify(["dsh", HOME_ID, sessionId, turn, step]);
}

function flagsOf(sample) {
  return perfFlagNamesOf(sample.sampleFlags);
}

function rawByIdentity(rawSamples) {
  return new Map(rawSamples.map((raw) => [JSON.stringify(raw.identity), raw]));
}

function identityKey(turn, step) {
  return JSON.stringify([SESSION_ID, turn, step]);
}

function assertMissingGeneration(sample) {
  assert.equal(sample.window, "request");
  assert.equal(sample.timingKind, "generation");
  assert.equal(sample.tokenScope, "non_reasoning_output");
  assert.equal(sample.timingSource, "unknown");
  assert.equal(sample.windowStartMs, null);
  assert.equal(sample.windowEndMs, null);
  assert.equal(sample.durationMs, null);
  assert.equal(sample.outputTokens, null);
  assert.ok(flagsOf(sample).includes("MISSING_DURATION"));
  assert.ok(flagsOf(sample).includes("MISSING_OUTPUT"));
}

// ---------------------------------------------------------------- 主夹具：身份、字段、缺失生成速度

/**
 * 主夹具（一帧一会话头，5 帧）：
 * - turn1/step1：model-a 作用域，step 诊断时长 2000ms、原始 output 600
 * - turn1/step2：**同 turn 无新 header**，沿用 model-a，诊断时长 1500ms、原始 output 300
 * - turn2/step1：新 header（model-b）→ **跨 turn 的 step 重置**（与 turn1/step1 同 step 值）；
 *   末尾接 `step/end` → 唯一一个 `completed` 的形态
 */
function mainFixtureFrames() {
  return [
    [sessionRow()],
    [
      requestRow({ seq: 2, time: T0 + 500, model: "model-a", provider: "prov-a" }),
      stepStartRow({ seq: 3, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 4, time: T0 + 3000, turn: 1, step: 1, outputTokens: 600 }),
    ],
    [
      stepStartRow({ seq: 5, time: T0 + 5000, turn: 1, step: 2 }),
      messageRow({ seq: 6, time: T0 + 6500, turn: 1, step: 2, outputTokens: 300 }),
    ],
    [
      requestRow({ seq: 7, time: T0 + 7000, model: "model-b", provider: "prov-b" }),
      stepStartRow({ seq: 8, time: T0 + 8000, turn: 2, step: 1 }),
      messageRow({ seq: 9, time: T0 + 10000, turn: 2, step: 1, outputTokens: 250 }),
    ],
    [stepEndRow({ seq: 10, time: T0 + 11000, turn: 2, step: 1 })],
  ];
}

test("主夹具：身份元组、请求作用域模型、原始诊断值与缺失生成速度", async () => {
  const { dir, file } = writeLog(mainFixtureFrames());
  try {
    const { samples, warnings, result, rawSamples } = await readLogWithRaw(file);
    assert.deepEqual(warnings, []);
    assert.equal(result.sampleCount, 3);
    assert.equal(result.stepEndFrames, 1);
    assert.equal(samples.length, 3);

    const byKey = new Map(samples.map((sample) => [sample.sampleKey, sample]));
    // 身份元组逐字断言：['dsh', homeId, sessionId, turn, step]
    const first = byKey.get(sampleKeyOf(SESSION_ID, 1, 1));
    const second = byKey.get(sampleKeyOf(SESSION_ID, 1, 2));
    const third = byKey.get(sampleKeyOf(SESSION_ID, 2, 1));
    assert.ok(first && second && third, "三个 (turn,step) 必须是三个不同身份");
    assert.equal(byKey.size, 3, "turn 参与身份：turn1/step1 与 turn2/step1 不得合并");

    const rawByKey = rawByIdentity(rawSamples);
    const firstRaw = rawByKey.get(identityKey(1, 1));
    const secondRaw = rawByKey.get(identityKey(1, 2));
    const thirdRaw = rawByKey.get(identityKey(2, 1));
    assert.equal(firstRaw.reportedOutputTokens, 600);
    assert.equal(firstRaw.reportedDurationMs, 2000);
    assert.equal(secondRaw.reportedOutputTokens, 300);
    assert.equal(secondRaw.reportedDurationMs, 1500);
    assert.equal(thirdRaw.reportedOutputTokens, 250);
    assert.equal(thirdRaw.reportedDurationMs, 2000);

    // 请求作用域：header 生效于其后帧；同 turn 无新 header 沿用；新 turn 有新 header 则切换
    for (const [sample, model, provider] of [
      [first, "model-a", "prov-a"],
      [second, "model-a", "prov-a"],
      [third, "model-b", "prov-b"],
    ]) {
      assert.equal(sample.model, model);
      assert.equal(sample.modelProvider, provider);
      assert.equal(sample.modelEvidence, "request_scope");
    }

    // 语义与来源口径：没有首/末有效输出证据时，完整 step 时窗与原始 output 只留在 raw 诊断。
    for (const sample of samples) {
      assert.equal(sample.sourceKind, "dsh");
      assert.equal(sample.homeId, HOME_ID);
      assert.equal(sample.sessionId, SESSION_ID);
      assert.equal(sample.methodVersion, PERF_METHOD_VERSION);
      assert.equal(sample.channel, "dsh", "channel 冻结为小写 kebab-case（裁定 AL-5）");
      assert.equal(sample.agentKind, "unknown", "depth=0 不给 main");
      assert.equal(sample.agent, "standard");
      assert.equal(sample.sourcePath, file);
      assertMissingGeneration(sample);
    }

    // 终态：只有 turn2/step1 的步骤结束帧严格晚于其 message
    assert.equal(first.status, "unverified");
    assert.equal(second.status, "unverified");
    assert.equal(third.status, "completed");
    assert.ok(flagsOf(first).includes("TERMINAL_UNVERIFIED"));
    assert.ok(!flagsOf(third).includes("TERMINAL_UNVERIFIED"));

    // 正文哨兵：候选里不得出现 message 文本/流式载荷/步骤结束帧产物
    const raw = JSON.stringify(samples);
    for (const sentinel of [BODY_SENTINEL, STREAM_SENTINEL, STEP_END_SENTINEL]) {
      assert.equal(raw.includes(sentinel), false, `候选泄露了哨兵 ${sentinel}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 旧载荷对照 + 静态访问证明

test("无 reasoning/合法 packed stream 的旧载荷：删除 message 与无效 stream 后候选不变", async () => {
  const poisoned = writeLog(mainFixtureFrames());
  const stripped = writeLog([
    [sessionRow()],
    [
      requestRow({ seq: 2, time: T0 + 500, model: "model-a", provider: "prov-a" }),
      stepStartRow({ seq: 3, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 4, time: T0 + 3000, turn: 1, step: 1, outputTokens: 600, includePayload: false }),
    ],
    [
      stepStartRow({ seq: 5, time: T0 + 5000, turn: 1, step: 2 }),
      messageRow({ seq: 6, time: T0 + 6500, turn: 1, step: 2, outputTokens: 300, includePayload: false }),
    ],
    [
      requestRow({ seq: 7, time: T0 + 7000, model: "model-b", provider: "prov-b" }),
      stepStartRow({ seq: 8, time: T0 + 8000, turn: 2, step: 1 }),
      messageRow({ seq: 9, time: T0 + 10000, turn: 2, step: 1, outputTokens: 250, includePayload: false }),
    ],
    // 步骤结束帧连 `time` 都删掉：若 reader 读了它，结果必然不同
    [stepEndRow({ seq: 10, turn: 2, step: 1, includeTime: false })],
  ]);
  try {
    const withPayload = await readLog(poisoned.file);
    const withoutPayload = await readLog(stripped.file);
    assert.equal(withPayload.samples.length, 3);
    assert.equal(withoutPayload.samples.length, 3);
    // sourcePath 是唯一允许不同的字段（不同物理文件），其余必须逐字节一致
    const project = (samples) => JSON.stringify(samples.map((sample) => ({ ...sample, sourcePath: "" })));
    assert.equal(project(withPayload.samples), project(withoutPayload.samples));
    assert.deepEqual(withPayload.warnings, []);
    assert.deepEqual(withoutPayload.warnings, []);
  } finally {
    rmSync(poisoned.dir, { recursive: true, force: true });
    rmSync(stripped.dir, { recursive: true, force: true });
  }
});

test("静态访问证明：只读成功 message 的生成 usage/stream；步骤结束帧不读 time，输入侧用量不读", () => {
  const source = readFileSync(READER_FILE, "utf8");
  // 生成侧只允许 output/reasoning 与 packed stream；正文、输入侧用量仍不得进入投影。
  for (const forbidden of [
    ".content",
    '"content"',
    "inputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
    "localeCompare",
  ]) {
    assert.equal(source.includes(forbidden), false, `reader 源码不得引用 ${forbidden}`);
  }
  assert.ok(source.includes("outputTokens"));
  assert.ok(source.includes("reasoningTokens"));
  assert.ok(source.includes("reasoningEffort"), "scope must include the reviewed effort range");
  assert.ok(source.includes('record.type === "text-chunks"'));
  assert.ok(source.includes('record.type === "tool-call-chunks"'));
  assert.ok(source.includes('value !== ""'), "空串边界判据必须保留，不能 trim");
  assert.equal(source.includes("reasoningSequences"), false, "reasoning 穿插只保留 scalar phase 状态");
  // 步骤结束帧分支：只允许 data 的 turn/step + 帧序，不得出现时间读取
  const branchStart = source.indexOf("if (type === STEP_END_TYPE)");
  assert.ok(branchStart > 0, "必须存在步骤结束帧分支");
  const branchEnd = source.indexOf("\n    }\n", branchStart);
  assert.ok(branchEnd > branchStart, "步骤结束帧分支必须可定位");
  const branch = source.slice(branchStart, branchEnd);
  assert.ok(branch.includes("data?.turn"));
  assert.ok(branch.includes("data?.step"));
  assert.equal(branch.includes("time"), false, "步骤结束帧分支不得读取 time");
  // 帧序必须逐帧递增（M0.3 的 P1 就是把它写在了循环外）
  assert.ok(source.includes("frameIndex += 1"));
});

// ---------------------------------------------------------------- 裁定 G：五种终态形态

test("无完整 stream 终态时，只有『end 严格晚于最后一条 message』才 completed", async () => {
  const { dir, file } = writeLog([
    [sessionRow()],
    // (1,1) end 在 message 之后 → 唯一可判完成的形态
    [
      stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 2, time: T0 + 2000, turn: 1, step: 1, outputTokens: 200 }),
      stepEndRow({ seq: 3, time: T0 + 2500, turn: 1, step: 1 }),
    ],
    // (1,2) end 在 message 之前
    [
      stepEndRow({ seq: 4, time: T0 + 3000, turn: 1, step: 2 }),
      stepStartRow({ seq: 5, time: T0 + 3500, turn: 1, step: 2 }),
      messageRow({ seq: 6, time: T0 + 4000, turn: 1, step: 2, outputTokens: 210 }),
    ],
    // (1,3) 没有 end
    [
      stepStartRow({ seq: 7, time: T0 + 5000, turn: 1, step: 3 }),
      messageRow({ seq: 8, time: T0 + 6000, turn: 1, step: 3, outputTokens: 220 }),
    ],
    // (1,4) 同 step 跨两段重复（取值不同 → 冲突）后接 end
    [
      stepStartRow({ seq: 9, time: T0 + 7000, turn: 1, step: 4 }),
      messageRow({ seq: 10, time: T0 + 8000, turn: 1, step: 4, outputTokens: 230 }),
    ],
    [
      stepStartRow({ seq: 11, time: T0 + 8500, turn: 1, step: 4 }),
      messageRow({ seq: 12, time: T0 + 9000, turn: 1, step: 4, outputTokens: 240 }),
      stepEndRow({ seq: 13, time: T0 + 9500, turn: 1, step: 4 }),
    ],
    // (1,5) end 先于 message（同组更早）
    [
      stepStartRow({ seq: 14, time: T0 + 11000, turn: 1, step: 5 }),
      stepEndRow({ seq: 15, time: T0 + 11500, turn: 1, step: 5 }),
      messageRow({ seq: 16, time: T0 + 12000, turn: 1, step: 5, outputTokens: 250 }),
    ],
  ]);
  try {
    const { samples, result, rawSamples } = await readLogWithRaw(file);
    assert.equal(result.stepEndFrames, 4, "四条步骤结束帧都被读到了判别式");
    assert.equal(samples.length, 5, "五个分组各一个候选");
    const byKey = new Map(samples.map((sample) => [sample.sampleKey, sample]));

    const form1 = byKey.get(sampleKeyOf(SESSION_ID, 1, 1));
    assert.equal(form1.status, "completed", "end 在 message 之后 → 唯一进采样的形态");
    for (const step of [2, 3, 5]) {
      const sample = byKey.get(sampleKeyOf(SESSION_ID, 1, step));
      assert.equal(sample.status, "unverified", `(1,${step}) 不得判完成`);
      assert.ok(flagsOf(sample).includes("TERMINAL_UNVERIFIED"));
    }
    // 冲突形态：保留一个候选 + RECORD_CONFLICT（下游据此扣除），且不因"有 end"而变成干净完成
    const form4 = byKey.get(sampleKeyOf(SESSION_ID, 1, 4));
    assert.ok(flagsOf(form4).includes("RECORD_CONFLICT"));
    assertMissingGeneration(form4);
    const form4Raw = rawByIdentity(rawSamples).get(identityKey(1, 4));
    assert.equal(form4Raw.reportedDurationMs, 1000, "诊断值取文档顺序第一对（8000-7000）");
    assert.equal(form4Raw.reportedOutputTokens, 230, "诊断值不任选末条、不求和");
    assert.equal(form4.status, "completed", "end 确实晚于最后一条 message；扣除由 RECORD_CONFLICT 负责");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 折叠、冲突与诊断值选择

test("一致重复折叠：同 (turn,step) 的相同 start/message 只产出一个候选", async () => {
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 }),
      stepStartRow({ seq: 2, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 3, time: T0 + 3000, turn: 1, step: 1, outputTokens: 400 }),
      messageRow({ seq: 4, time: T0 + 3000, turn: 1, step: 1, outputTokens: 400 }),
    ],
  ]);
  try {
    const { samples, rawSamples } = await readLogWithRaw(file);
    assert.equal(samples.length, 1, "一致重复必须折叠成一条");
    assertMissingGeneration(samples[0]);
    assert.equal(rawSamples[0].reportedDurationMs, 2000);
    assert.equal(rawSamples[0].reportedOutputTokens, 400);
    assert.ok(!flagsOf(samples[0]).includes("RECORD_CONFLICT"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("冲突不任选较快诊断时窗：慢窗口在前、快窗口在后时，取文档顺序第一对", async () => {
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      // 第一对：10000ms（慢）
      stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 }),
      stepStartRow({ seq: 2, time: T0 + 20000, turn: 1, step: 1 }),
      messageRow({ seq: 3, time: T0 + 11000, turn: 1, step: 1, outputTokens: 100 }),
      // 第二对：500ms（快）——若实现"选较快时窗"就会取到它
      messageRow({ seq: 4, time: T0 + 20500, turn: 1, step: 1, outputTokens: 100 }),
    ],
  ]);
  try {
    const { samples, rawSamples } = await readLogWithRaw(file);
    assert.equal(samples.length, 1, "冲突保留一个候选");
    assert.ok(flagsOf(samples[0]).includes("RECORD_CONFLICT"));
    assertMissingGeneration(samples[0]);
    assert.equal(rawSamples[0].reportedDurationMs, 10000, "文档顺序第一对，而不是 500ms 的快窗口");
    assert.equal(rawSamples[0].reportedOutputTokens, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- P1-3：组内模型/provider 歧义

/**
 * P1-3：`modelAmbiguous` 必须看**全部成员**的**已证明**证据。
 *
 * 修复前只比较代表对（首条 start × 首条 message），因此同组后续成员关联到另一个模型
 * **完全不报**：实测 A/B 与 B/A 两组同身份记录都只留下一个**干净**候选（无 `MODEL_AMBIGUOUS`）。
 *
 * 判据是计数式（"已证明取值集合大小 ≤ 1"），因此**对顺序天然对称**：正序与反序结果一致 ——
 * 这正是下面用 A→B / B→A 两个方向各自断言的原因（只测一侧等于没测"顺序无关"）。
 * 只取 `proven` 的成员：`claimScope` 把"新 turn 且无 header"标为 `proven:false, model:""`，
 * 那是**未证明**而非**不一致**，放进来会造成误报（见第三个用例的反例侧）。
 */
test("P1-3 组内模型歧义：A→B 与 B→A 都必须标记，且两个方向得到同一结论", async () => {
  const makeFrames = (firstModel, secondModel) => [
    [sessionRow()],
    [
      requestRow({ seq: 2, time: T0 + 100, model: firstModel, provider: "prov-a" }),
      stepStartRow({ seq: 3, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 4, time: T0 + 2000, turn: 1, step: 1, outputTokens: 100 }),
    ],
    [
      requestRow({ seq: 5, time: T0 + 2100, model: secondModel, provider: "prov-a" }),
      stepStartRow({ seq: 6, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 7, time: T0 + 2000, turn: 1, step: 1, outputTokens: 100 }),
    ],
  ];
  const ab = writeLog(makeFrames("model-a", "model-b"));
  const ba = writeLog(makeFrames("model-b", "model-a"));
  try {
    const forward = await readLogWithRaw(ab.file);
    const reverse = await readLogWithRaw(ba.file);

    for (const [label, run] of [
      ["A→B", forward],
      ["B→A", reverse],
    ]) {
      assert.equal(run.samples.length, 1, `${label}：冲突保留**一个**诊断候选，不得丢弃`);
      const flags = flagsOf(run.samples[0]);
      assert.ok(flags.includes("MODEL_AMBIGUOUS"), `${label}：组内模型变化必须标记歧义`);
      assert.equal(run.samples[0].modelEvidence, "request_scope", `${label}：证据类型仍是请求作用域`);
    }
    // 顺序无关：两方向的模型歧义结论必须一致（只测一侧 = 没测"对称"）
    assert.equal(
      flagsOf(forward.samples[0]).includes("MODEL_AMBIGUOUS"),
      flagsOf(reverse.samples[0]).includes("MODEL_AMBIGUOUS"),
      "正反顺序必须得到同一歧义结论",
    );
    // 代表值仍是文档顺序第一条（不因歧义换代表）
    assert.equal(forward.samples[0].model, "model-a");
    assert.equal(reverse.samples[0].model, "model-b");
    // 裁定 AU / D3：**不得**借 `filterReason` 表达细分 —— `filterReason !== ""` 会被 M1 **无条件**
    // 映射为 `SOURCE_FILTERED`（语义是"来源侧失败"），一个模型歧义样本不该同时声称来源侧失败。
    for (const [label, run] of [
      ["A→B", forward],
      ["B→A", reverse],
    ]) {
      // reader **完全不写**该字段（M1 因此不产出该键，不是 reader 写了 `""`）—— 这才是"不借道"的判据
      assert.ok(!("filterReason" in run.rawSamples[0]), `${label}：reader 不得写 filterReason`);
      assert.ok(!flagsOf(run.samples[0]).includes("SOURCE_FILTERED"), `${label}：模型歧义 ≠ 来源侧失败`);
      assert.notEqual(run.samples[0].sourceFiltered, true, `${label}：不得声称来源侧被过滤`);
    }
  } finally {
    rmSync(ab.dir, { recursive: true, force: true });
    rmSync(ba.dir, { recursive: true, force: true });
  }
});

test("P1-3 provider 歧义：p1→p2 与 p2→p1 都必须标记（与模型变化分开论断）", async () => {
  const makeFrames = (firstProvider, secondProvider) => [
    [sessionRow()],
    [
      requestRow({ seq: 2, time: T0 + 100, model: "model-a", provider: firstProvider }),
      stepStartRow({ seq: 3, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 4, time: T0 + 2000, turn: 1, step: 1, outputTokens: 100 }),
    ],
    [
      requestRow({ seq: 5, time: T0 + 2100, model: "model-a", provider: secondProvider }),
      stepStartRow({ seq: 6, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 7, time: T0 + 2000, turn: 1, step: 1, outputTokens: 100 }),
    ],
  ];
  const forward = writeLog(makeFrames("prov-a", "prov-b"));
  const reverse = writeLog(makeFrames("prov-b", "prov-a"));
  try {
    const fwd = await readLogWithRaw(forward.file);
    const rev = await readLogWithRaw(reverse.file);
    for (const [label, run] of [
      ["p1→p2", fwd],
      ["p2→p1", rev],
    ]) {
      assert.equal(run.samples.length, 1, `${label}：保留一个诊断候选`);
      assert.ok(flagsOf(run.samples[0]).includes("MODEL_AMBIGUOUS"), `${label}：provider 变化必须标记`);
      assert.equal(run.samples[0].model, "model-a", `${label}：模型未变，代表仍是 model-a`);
    }
    // 裁定 AU / D3：provider-only 变化同样不得借 `filterReason` 通道
    for (const [label, run] of [
      ["p1→p2", fwd],
      ["p2→p1", rev],
    ]) {
      assert.ok(!("filterReason" in run.rawSamples[0]), `${label}：reader 不得写 filterReason`);
      assert.ok(!flagsOf(run.samples[0]).includes("SOURCE_FILTERED"), `${label}：provider 歧义 ≠ 来源侧失败`);
    }
  } finally {
    rmSync(forward.dir, { recursive: true, force: true });
    rmSync(reverse.dir, { recursive: true, force: true });
  }
});

test("P1-3 反例：完全一致的重复不得误报；未证明的空模型不得参与冲突判定", async () => {
  // 反例一：两条完全一致的记录（同模型/provider/时间/输出）⇒ 折叠成一条且**不报**歧义
  const identical = writeLog([
    [sessionRow()],
    [
      requestRow({ seq: 2, time: T0 + 100, model: "model-a", provider: "prov-a" }),
      stepStartRow({ seq: 3, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 4, time: T0 + 2000, turn: 1, step: 1, outputTokens: 100 }),
      stepStartRow({ seq: 5, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 6, time: T0 + 2000, turn: 1, step: 1, outputTokens: 100 }),
    ],
  ]);
  // 反例二：**跨 turn** 的两组各自干净（turn1 有 header ⇒ 已证明；turn2 无 header ⇒ 未证明）。
  // ⚠️ **认知更正（裁定 AW）**：我原先在这里写过"同一 `(turn,step)` 内**既有已证明成员又有未证明成员**
  // 是不可能的，因此不可构造" —— **该结论错误**。我试的方向是"header **消失**"，而正确构造是
  // "header 在**两条 start 之间出现**"：`claimScope`（`dsh.js:125-133`）让**随后第一条**带
  // `(turn,step)` 的帧获得 `proven:true` 的作用域，因此 `start → header → start` 会让首条 start
  // 保持"未证明、model=''"，第二条 start 拿到已证明的 `model-a` ⇒ **同组内混合是可构造的**。
  // 组内混合的负方向用例见下一条 `P1-3 反例：组内已证明/未证明混合不得误报`。
  const noHeaderTurn = writeLog([
    [sessionRow()],
    [
      requestRow({ seq: 1, time: T0 + 100, model: "model-a", provider: "prov-a" }),
      stepStartRow({ seq: 2, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 3, time: T0 + 2000, turn: 1, step: 1, outputTokens: 100 }),
    ],
    // turn2 无 header：作用域未证明
    [
      stepStartRow({ seq: 4, time: T0 + 3000, turn: 2, step: 1 }),
      messageRow({ seq: 5, time: T0 + 4000, turn: 2, step: 1, outputTokens: 100 }),
    ],
  ]);
  try {
    const same = await readLog(identical.file);
    assert.equal(same.samples.length, 1, "完全一致 ⇒ 折叠成一条");
    assert.ok(!flagsOf(same.samples[0]).includes("MODEL_AMBIGUOUS"), "一致重复**不得**误报歧义");

    const crossTurn = await readLog(noHeaderTurn.file);
    const byKey = new Map(crossTurn.samples.map((sample) => [sample.sampleKey, sample]));
    const proven = byKey.get(sampleKeyOf(SESSION_ID, 1, 1));
    const unproven = byKey.get(sampleKeyOf(SESSION_ID, 2, 1));
    assert.ok(!flagsOf(proven).includes("MODEL_AMBIGUOUS"), "已证明组只有单一取值，不得误报");
    assert.ok(!flagsOf(unproven).includes("MODEL_AMBIGUOUS"), "**未证明**（空模型）不是**不一致**");
    assert.equal(unproven.model, "", "未证明就留空");
    assert.equal(unproven.modelEvidence, "", "未证明不写 request_scope");
  } finally {
    rmSync(identical.dir, { recursive: true, force: true });
    rmSync(noHeaderTurn.dir, { recursive: true, force: true });
  }
});

/**
 * P1-3 反例（**裁定 AW 要求的负方向**）：**同一组内**"已证明"与"未证明"成员混合时**不得**误报歧义。
 *
 * ⚠️ **这条用例补的是一个真实缺口** —— `proven` 过滤此前只在"整组未证明"上验过（上一条用例的
 * 跨 turn 形态），**未覆盖组内混合**。构造机制（我实测确认，`dsh.js:125-133`）：`request/header`
 * 只开启作用域，**归随后第一条**带 `(turn,step)` 的帧所有 ⇒ **在两条 `step/start` 之间**插入 header，
 * 首条 start 留在"未证明、`model=''`"，第二条 start 拿到已证明的 `model-a`。
 *
 * **为什么这必须是一条独立用例**：去掉 `.filter((entry) => entry.proven)` 的突变（称 V2）
 * 对"整组未证明"形态**不产生影响**（那种形态下两组取值集合都是 `{""}`），
 * **只在组内混合形态上暴露** ⇒ 没有本条用例，V2 会**存活**。
 *
 * **V2 是有效突变，不是等价突变**（我独立对拍过，见 `M2.2-返工2.md` §9）：
 * 去掉 `proven` 过滤后这两种形态都会**误报** `MODEL_AMBIGUOUS`，而 F1（全已证明）不受影响。
 * ⇒ **不得**把 V2 记作"等价突变、无需处理"（AS-6：那会把一个真实缺口洗成合格）。
 */
test("P1-3 反例：组内已证明/未证明混合不得误报（V2 突变的目标用例）", async () => {
  // F2：start → header → start → message（首条 start 未证明、第二条 start 已证明）
  const f2 = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 2, time: T0 + 1000, turn: 1, step: 1 }),
      requestRow({ seq: 3, time: T0 + 1100, model: "model-a", provider: "prov-a" }),
      stepStartRow({ seq: 4, time: T0 + 1200, turn: 1, step: 1 }),
      messageRow({ seq: 5, time: T0 + 2000, turn: 1, step: 1, outputTokens: 100 }),
    ],
  ]);
  // F3：start → message → header → start（header 更晚，首条 start 未证明、末尾 start 已证明）
  const f3 = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 2, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 3, time: T0 + 2000, turn: 1, step: 1, outputTokens: 100 }),
      requestRow({ seq: 4, time: T0 + 2100, model: "model-a", provider: "prov-a" }),
      stepStartRow({ seq: 5, time: T0 + 2200, turn: 1, step: 1 }),
    ],
  ]);
  try {
    for (const [label, fixture] of [
      ["F2 start→header→start→msg", f2],
      ["F3 start→msg→header→start", f3],
    ]) {
      const { samples } = await readLog(fixture.file);
      assert.equal(samples.length, 1, `${label}：同组折叠成一条候选（保留诊断候选）`);
      const flags = flagsOf(samples[0]);
      assert.ok(
        !flags.includes("MODEL_AMBIGUOUS"),
        `${label}：同组内"未证明(model='')"不是"另一个模型"，**不得**误报歧义`,
      );
      // 该组内确实发生过 start 快照（RECORD_CONFLICT 由"同一组多条 start"触发），
      // 证实这两条用例走的确实是"组内有多个成员"的路径，而不是被折叠成单成员。
      assert.ok(flags.includes("RECORD_CONFLICT"), `${label}：前置条件成立（同组确有多个 start 快照）`);
    }
  } finally {
    rmSync(f2.dir, { recursive: true, force: true });
    rmSync(f3.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 缺失与异常分支

test("缺 start：保留候选与原始 output 诊断，生成时长/输出均为 null，且不回填模型", async () => {
  const { dir, file } = writeLog([
    [sessionRow()],
    [messageRow({ seq: 1, time: T0 + 3000, turn: 1, step: 1, outputTokens: 120 })],
  ]);
  try {
    const { samples, rawSamples } = await readLogWithRaw(file);
    assert.equal(samples.length, 1);
    assertMissingGeneration(samples[0]);
    assert.equal(samples[0].tsMs, T0 + 3000);
    assert.equal(rawSamples[0].reportedOutputTokens, 120);
    assert.equal(rawSamples[0].reportedDurationMs, null, "没有 start 就没有请求诊断时窗");
    assert.equal(samples[0].model, "", "无 header 作用域时不回填任何模型");
    assert.equal(samples[0].modelEvidence, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("同 step 的诊断时窗以最后一条早于 message 的 retry-started 为起点；该时窗不进入生成速度", async () => {
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 }),
      retryStartedRow({ seq: 2, time: T0 + 5000, turn: 1, step: 1 }),
      messageRow({ seq: 3, time: T0 + 8000, turn: 1, step: 1, outputTokens: 90 }),
      stepStartRow({ seq: 4, time: T0 + 1000, turn: 1, step: 2 }),
      retryStartedRow({ seq: 5, time: T0 + 4000, turn: 1, step: 2 }),
      retryStartedRow({ seq: 6, time: T0 + 6000, turn: 1, step: 2 }),
      messageRow({ seq: 7, time: T0 + 9000, turn: 1, step: 2, outputTokens: 90 }),
      stepStartRow({ seq: 8, time: T0 + 1000, turn: 1, step: 3 }),
      messageRow({ seq: 9, time: T0 + 3000, turn: 1, step: 3, outputTokens: 90 }),
      retryStartedRow({ seq: 10, time: T0 + 5000, turn: 1, step: 3 }),
      stepStartRow({ seq: 11, time: T0 + 1000, turn: 1, step: 4 }),
      messageRow({ seq: 12, time: T0 + 3000, turn: 1, step: 4, outputTokens: 90 }),
    ],
  ]);
  try {
    const { samples, rawSamples } = await readLogWithRaw(file);
    const rawByKey = rawByIdentity(rawSamples);
    assert.equal(rawByKey.get(identityKey(1, 1)).reportedDurationMs, 3000, "单次重试从 retry-started 起算");
    assert.equal(rawByKey.get(identityKey(1, 2)).reportedDurationMs, 3000, "多次重试取最后一条早于 message 的起点");
    assert.equal(
      rawByKey.get(identityKey(1, 3)).reportedDurationMs,
      2000,
      "message 后的 retry-started 不得倒灌进已完成样本",
    );
    assert.equal(rawByKey.get(identityKey(1, 4)).reportedDurationMs, 2000, "无重试仍使用 step/start");
    for (const sample of samples) assertMissingGeneration(sample);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺 usage 与真 0 原始输出：诊断值区分缺值和 0，生成输出都保持 null", async () => {
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 2, time: T0 + 2000, turn: 1, step: 1, includeUsage: false }),
      stepStartRow({ seq: 3, time: T0 + 3000, turn: 1, step: 2 }),
      messageRow({ seq: 4, time: T0 + 4000, turn: 1, step: 2, outputTokens: 0 }),
    ],
  ]);
  try {
    const { samples, rawSamples } = await readLogWithRaw(file);
    assert.equal(samples.length, 2);
    const sampleByKey = new Map(samples.map((sample) => [sample.sampleKey, sample]));
    const rawByKey = rawByIdentity(rawSamples);
    const missing = sampleByKey.get(sampleKeyOf(SESSION_ID, 1, 1));
    const zero = sampleByKey.get(sampleKeyOf(SESSION_ID, 1, 2));
    assert.equal(rawByKey.get(identityKey(1, 1)).reportedOutputTokens, undefined, "缺值不得写成 0");
    assert.equal(rawByKey.get(identityKey(1, 2)).reportedOutputTokens, 0, "真 0 必须保留为 0");
    for (const sample of [missing, zero]) assertMissingGeneration(sample);
    assert.ok(!flagsOf(zero).includes("OUTPUT_ZERO"), "生成分子未提供，不能用原始 0 冒充有效零输出");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("0 与负诊断时长：原值只留在 reportedDurationMs，生成 durationMs 保持 null", async () => {
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 1, time: T0 + 5000, turn: 1, step: 1 }),
      messageRow({ seq: 2, time: T0 + 5000, turn: 1, step: 1, outputTokens: 50 }),
      stepStartRow({ seq: 3, time: T0 + 8000, turn: 1, step: 2 }),
      messageRow({ seq: 4, time: T0 + 7000, turn: 1, step: 2, outputTokens: 60 }),
    ],
  ]);
  try {
    const { samples, rawSamples } = await readLogWithRaw(file);
    const sampleByKey = new Map(samples.map((sample) => [sample.sampleKey, sample]));
    const rawByKey = rawByIdentity(rawSamples);
    const zero = sampleByKey.get(sampleKeyOf(SESSION_ID, 1, 1));
    const negative = sampleByKey.get(sampleKeyOf(SESSION_ID, 1, 2));
    assert.equal(rawByKey.get(identityKey(1, 1)).reportedDurationMs, 0);
    assert.equal(rawByKey.get(identityKey(1, 2)).reportedDurationMs, -1000);
    for (const sample of [zero, negative]) assertMissingGeneration(sample);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 请求诊断时窗单位

/**
 * **秒级 start + 毫秒 message** 不能相减后成为一个约 56 年的诊断时长。
 *
 * 判别式的可达性前提（已实测）：真实 epoch 毫秒 ≥ `PERF_EPOCH_MS_MIN`（1e12，约
 * 2001-09-09T01:46:40Z），秒级出现在 1e9 量级，两者相差三个数量级。本用例用
 * **同一个 `T0`** 派生出两种单位的端点，因此"混合"本身就是唯一变量。
 */
test("请求诊断时窗：混合单位不产生 reportedDurationMs，正常毫秒仅保留诊断值", async () => {
  const msLog = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 2, time: T0 + 3000, turn: 1, step: 1, outputTokens: 100 }),
    ],
  ]);
  const mixedLog = writeLog([
    [sessionRow()],
    [
      // 秒级 start（1e9 量级） + 毫秒 message（1e12 量级）
      stepStartRow({ seq: 1, time: Math.floor((T0 + 1000) / 1000), turn: 1, step: 1 }),
      messageRow({ seq: 2, time: T0 + 3000, turn: 1, step: 1, outputTokens: 100 }),
    ],
  ]);
  try {
    const ok = await readLogWithRaw(msLog.file);
    const mixed = await readLogWithRaw(mixedLog.file);

    // 正例侧：正常毫秒只产生请求诊断值，不进入生成速度。
    assert.equal(ok.samples.length, 1);
    assertMissingGeneration(ok.samples[0]);
    assert.equal(ok.rawSamples[0].reportedDurationMs, 2000);
    assert.ok(!flagsOf(ok.samples[0]).includes("TIME_INVALID"));
    assert.ok(!flagsOf(ok.samples[0]).includes("LONG_WINDOW"));

    // 反例侧：混合单位仍保留可归属候选，但诊断差值不可计算。
    assert.equal(mixed.samples.length, 1, "异常数据必须保留候选，不能靠丢弃变干净");
    assertMissingGeneration(mixed.samples[0]);
    assert.equal(mixed.rawSamples[0].reportedDurationMs, null, "绝不把混合单位相减的结果交给诊断字段");
    const mixedFlags = flagsOf(mixed.samples[0]);
    assert.ok(!mixedFlags.includes("TIME_INVALID"), "混合诊断时窗未进入样本时间字段");
    assert.ok(!mixedFlags.includes("LONG_WINDOW"));
    assert.equal(mixed.rawSamples[0].reportedOutputTokens, 100);
    assert.equal(mixed.samples[0].sampleKey, ok.samples[0].sampleKey);
  } finally {
    rmSync(msLog.dir, { recursive: true, force: true });
    rmSync(mixedLog.dir, { recursive: true, force: true });
  }
});

test("诊断时窗的三个邻接形态：两端毫秒、两端秒级、缺 start 均不进入生成速度", async () => {
  const bothMs = writeLog([
    [sessionRow()],
    [stepStartRow({ seq: 1, time: T0, turn: 1, step: 1 }), messageRow({ seq: 2, time: T0 + 1500, turn: 1, step: 1 })],
  ]);
  // 两端同为**秒级**：单位一致，但都低于毫秒阈值 ⇒ 量级问题，交给 M1 的 tsMs/时间位，不冒充"混淆"
  const bothSeconds = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 1, time: Math.floor(T0 / 1000), turn: 1, step: 1 }),
      messageRow({ seq: 2, time: Math.floor(T0 / 1000) + 2, turn: 1, step: 1 }),
    ],
  ]);
  const noStart = writeLog([
    [sessionRow()],
    [messageRow({ seq: 1, time: T0 + 3000, turn: 1, step: 1, outputTokens: 120 })],
  ]);
  try {
    const ms = await readLogWithRaw(bothMs.file);
    const seconds = await readLogWithRaw(bothSeconds.file);
    const missing = await readLogWithRaw(noStart.file);

    assertMissingGeneration(ms.samples[0]);
    assert.equal(ms.rawSamples[0].reportedDurationMs, 1500);

    // 两端秒级不形成诊断差值；message 作为样本时间仍由 M1 的单位闸门拦下。
    assertMissingGeneration(seconds.samples[0]);
    assert.equal(seconds.rawSamples[0].reportedDurationMs, null);
    assert.ok(flagsOf(seconds.samples[0]).includes("TIME_INVALID"), "秒级 tsMs 由 M1 的时间单位闸门拦下");
    assert.equal(seconds.samples[0].diagnosticReasonChain.includes("timestamp_unit_unsupported"), true);
    assert.equal(seconds.samples[0].tsMs, null);

    // 缺 start：只是诊断值缺失，不得误报成时间单位非法。
    assertMissingGeneration(missing.samples[0]);
    assert.equal(missing.rawSamples[0].reportedDurationMs, null);
    assert.equal(missing.samples[0].windowStartMs, null, "缺 start 时不得伪造一个窗口端点");
    assert.equal(missing.samples[0].windowEndMs, null, "缺 start 时不得伪造一个窗口端点");
    assert.ok(!flagsOf(missing.samples[0]).includes("TIME_INVALID"), "缺失 ≠ 单位非法");
  } finally {
    rmSync(bothMs.dir, { recursive: true, force: true });
    rmSync(bothSeconds.dir, { recursive: true, force: true });
    rmSync(noStart.dir, { recursive: true, force: true });
  }
});

test("非整数/缺失的 (turn,step) 与坏时间：不形成稳定身份时只记 UNKEYABLE_RECORD", async () => {
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      { type: "step/start", seq: 1, time: T0 + 1000, data: { turn: 1 } },
      { type: "assistant/message", seq: 2, time: T0 + 2000, data: { turn: 1, step: "x", usage: { outputTokens: 10 } } },
      stepStartRow({ seq: 3, time: T0 + 3000, turn: 1, step: 1 }),
      messageRow({ seq: 4, time: "not-a-timestamp", turn: 1, step: 1, outputTokens: 80 }),
      stepStartRow({ seq: 5, time: T0 + 6000, turn: 1, step: 2 }),
      // 完全没有 `time` 键：与"有值但不可用"必须是两个不同状态
      { type: "assistant/message", seq: 6, data: { turn: 1, step: 2, usage: { outputTokens: 90 } } },
    ],
  ]);
  try {
    const { samples, warnings } = await readLog(file);
    assert.equal(samples.length, 2, "只有可形成身份的两组成候选");
    const byKey = new Map(samples.map((sample) => [sample.sampleKey, sample]));
    const badTime = byKey.get(sampleKeyOf(SESSION_ID, 1, 1));
    const noTime = byKey.get(sampleKeyOf(SESSION_ID, 1, 2));
    // reader 传**原值**，分类与置位由 M1 负责（不在 reader 里做隐式转换）；
    // 时窗不可算时 `duration_missing` 优先级更高，因此断言查 reasonChain 而不是主 reason。
    assert.equal(badTime.tsMs, null);
    assert.ok(flagsOf(badTime).includes("TIME_INVALID"));
    assert.ok(badTime.diagnosticReasonChain.includes("timestamp_not_a_number"));
    assert.equal(noTime.tsMs, null);
    assert.ok(flagsOf(noTime).includes("TIME_UNPLACED"));
    assert.ok(noTime.diagnosticReasonChain.includes("timestamp_missing"));
    assert.deepEqual(warnings, [{ sourceKind: "dsh", homeId: HOME_ID, code: "UNKEYABLE_RECORD", count: 2 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 请求作用域与代理

test("头配置按当前请求作用域关联：新 turn 无 header 时模型留空，绝不沿用上一轮", async () => {
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      requestRow({ seq: 1, time: T0 + 100, model: "model-a", provider: "prov-a" }),
      stepStartRow({ seq: 2, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 3, time: T0 + 2000, turn: 1, step: 1, outputTokens: 10 }),
    ],
    // turn2 **没有** header：不得继承 model-a
    [
      stepStartRow({ seq: 4, time: T0 + 3000, turn: 2, step: 1 }),
      messageRow({ seq: 5, time: T0 + 4000, turn: 2, step: 1, outputTokens: 20 }),
    ],
    // turn3 有新 header：切换
    [
      requestRow({ seq: 6, time: T0 + 5000, model: "model-c", provider: "prov-c" }),
      stepStartRow({ seq: 7, time: T0 + 6000, turn: 3, step: 1 }),
      messageRow({ seq: 8, time: T0 + 7000, turn: 3, step: 1, outputTokens: 30 }),
    ],
    // turn4：start 在 model-a 作用域，message 之前又出现 header(model-d) → 模型归属歧义
    [
      requestRow({ seq: 9, time: T0 + 8000, model: "model-a", provider: "prov-a" }),
      stepStartRow({ seq: 10, time: T0 + 9000, turn: 4, step: 1 }),
      requestRow({ seq: 11, time: T0 + 9500, model: "model-d", provider: "prov-d" }),
      messageRow({ seq: 12, time: T0 + 10000, turn: 4, step: 1, outputTokens: 40 }),
    ],
  ]);
  try {
    const { samples } = await readLog(file);
    const byKey = new Map(samples.map((sample) => [sample.sampleKey, sample]));
    const scoped = byKey.get(sampleKeyOf(SESSION_ID, 1, 1));
    const unscoped = byKey.get(sampleKeyOf(SESSION_ID, 2, 1));
    const switched = byKey.get(sampleKeyOf(SESSION_ID, 3, 1));
    const ambiguous = byKey.get(sampleKeyOf(SESSION_ID, 4, 1));
    assert.equal(scoped.model, "model-a");
    assert.equal(unscoped.model, "", "新 turn 无 header → 留空");
    assert.equal(unscoped.modelProvider, "", "provider 同样不得沿用");
    assert.equal(unscoped.modelEvidence, "", "没证明作用域就不写 request_scope");
    assert.equal(switched.model, "model-c");
    assert.equal(switched.modelProvider, "prov-c");
    assert.ok(flagsOf(ambiguous).includes("MODEL_AMBIGUOUS"), "同 step 内 start/message 作用域不同");
    assert.equal(ambiguous.model, "model-d", "报告 message 所在作用域");
    assert.equal(ambiguous.modelEvidence, "request_scope");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("代理：delegationDepth 只证 subagent，名与 kind 分离，depth=0 不给 main", async () => {
  const subagent = writeLog([
    [sessionRow({ id: "session-sub", delegationDepth: 2, agentPreset: "explore" })],
    [
      stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 2, time: T0 + 2000, turn: 1, step: 1, outputTokens: 10 }),
    ],
  ]);
  const main = writeLog([
    [sessionRow({ id: "session-main", delegationDepth: 0, agentPreset: "" })],
    [
      stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 2, time: T0 + 2000, turn: 1, step: 1, outputTokens: 10 }),
    ],
  ]);
  try {
    const sub = await readLog(subagent.file);
    const plain = await readLog(main.file);
    assert.equal(sub.samples[0].agentKind, "subagent");
    assert.equal(sub.samples[0].agent, "explore", "名字来自 agentPreset，与 kind 分开");
    assert.equal(sub.samples[0].channel, "dsh-subagent", "depth>0 ⇒ 小写 kebab（裁定 AL-5）");
    assert.equal(plain.samples[0].agentKind, "unknown");
    assert.notEqual(plain.samples[0].agentKind, "main");
    assert.equal(plain.samples[0].agent, "", "未知名称为空串");
    assert.equal(plain.samples[0].channel, "dsh", "depth=0 ⇒ 小写 kebab（裁定 AL-5）");
    // 正反两侧的字面量约束：不得含空格或大写，且两者必须是同一口径的两个取值
    for (const sample of [sub.samples[0], plain.samples[0]]) {
      assert.equal(sample.channel, sample.channel.toLowerCase(), "channel 不得含大写");
      assert.equal(/\s/.test(sample.channel), false, "channel 不得含空格");
    }
    assert.equal(
      sub.samples[0].channel.startsWith("dsh") && plain.samples[0].channel.startsWith("dsh"),
      true,
      "两侧都必须以来源 kind 的小写形式开头，否则 perfGroupKey 会拆组",
    );
    assert.notEqual(plain.samples[0].channel, "DSH", "旧字面量已废弃，不得回退");
  } finally {
    rmSync(subagent.dir, { recursive: true, force: true });
    rmSync(main.dir, { recursive: true, force: true });
  }
});

test("两会话相同的 (turn,step)：身份含 sessionId，原始诊断值也不串会话", async () => {
  const first = writeLog([
    [sessionRow({ id: "session-alpha" })],
    [
      stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 2, time: T0 + 3000, turn: 1, step: 1, outputTokens: 100 }),
    ],
  ]);
  const second = writeLog([
    [sessionRow({ id: "session-beta" })],
    [
      stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 2, time: T0 + 5000, turn: 1, step: 1, outputTokens: 200 }),
    ],
  ]);
  try {
    const alpha = await readLogWithRaw(first.file);
    const beta = await readLogWithRaw(second.file);
    assert.equal(alpha.samples[0].sampleKey, JSON.stringify(["dsh", HOME_ID, "session-alpha", 1, 1]));
    assert.equal(beta.samples[0].sampleKey, JSON.stringify(["dsh", HOME_ID, "session-beta", 1, 1]));
    assert.notEqual(alpha.samples[0].sampleKey, beta.samples[0].sampleKey, "同 (turn,step) 不同会话不得同键");
    assertMissingGeneration(alpha.samples[0]);
    assertMissingGeneration(beta.samples[0]);
    assert.equal(alpha.rawSamples[0].reportedDurationMs, 2000);
    assert.equal(beta.rawSamples[0].reportedDurationMs, 4000);
    assert.equal(alpha.rawSamples[0].reportedOutputTokens, 100);
    assert.equal(beta.rawSamples[0].reportedOutputTokens, 200);
  } finally {
    rmSync(first.dir, { recursive: true, force: true });
    rmSync(second.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 坏帧 / 坏行 / 版本 / 致命

test("坏帧：sourceWarnings 记 MALFORMED_FRAME（文件 degraded），坏帧之后的记录仍然产出候选", async () => {
  const { dir, file } = writeLog([
    [sessionRow()],
    corruptFrame(),
    [
      stepStartRow({ seq: 2, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 3, time: T0 + 2000, turn: 1, step: 1, outputTokens: 42 }),
    ],
  ]);
  try {
    const { samples, warnings, result, rawSamples } = await readLogWithRaw(file);
    assert.deepEqual(warnings, [{ sourceKind: "dsh", homeId: HOME_ID, code: "MALFORMED_FRAME", count: 1 }]);
    assert.deepEqual(result.warnings, warnings);
    assert.equal(samples.length, 1, "坏帧不得让整文件的合法记录消失");
    assertMissingGeneration(samples[0]);
    assert.equal(rawSamples[0].reportedOutputTokens, 42);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("坏 JSON 行：sourceWarnings 记 MALFORMED_JSON 且 count 为真实坏行数（不是 1）", async () => {
  const validStart = JSON.stringify(stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 }));
  const validMessage = JSON.stringify(messageRow({ seq: 3, time: T0 + 2000, turn: 1, step: 1, outputTokens: 77 }));
  const { dir, file } = writeLog([
    [sessionRow()],
    textFrame(`${validStart}\n{ 这不是 JSON\n"also-broken\n${validMessage}\n`),
  ]);
  try {
    const { samples, warnings, rawSamples } = await readLogWithRaw(file);
    assert.deepEqual(warnings, [{ sourceKind: "dsh", homeId: HOME_ID, code: "MALFORMED_JSON", count: 2 }]);
    assert.equal(samples.length, 1, "坏行之后的合法行仍然解析");
    assertMissingGeneration(samples[0]);
    assert.equal(rawSamples[0].reportedOutputTokens, 77);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("来源版本非 v4：UNSUPPORTED_SCHEMA、零候选、不按 v4 硬解", async () => {
  const { dir, file } = writeLog(
    [
      [sessionRow({ version: 5 })],
      [
        stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 }),
        messageRow({ seq: 2, time: T0 + 2000, turn: 1, step: 1, outputTokens: 10 }),
      ],
    ],
    { fileName: "session.v5.jsonl.zstd" },
  );
  try {
    const { samples, warnings, result } = await readLog(file);
    assert.equal(samples.length, 0);
    assert.equal(result.sampleCount, 0);
    assert.deepEqual(warnings, [{ sourceKind: "dsh", homeId: HOME_ID, code: "UNSUPPORTED_SCHEMA", count: 1 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺会话头：UNKEYABLE_RECORD、零候选（无稳定身份不写表）", async () => {
  const { dir, file } = writeLog([
    [
      stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 }),
      messageRow({ seq: 2, time: T0 + 2000, turn: 1, step: 1, outputTokens: 10 }),
    ],
  ]);
  try {
    const { samples, warnings } = await readLog(file);
    assert.equal(samples.length, 0);
    assert.deepEqual(warnings, [{ sourceKind: "dsh", homeId: HOME_ID, code: "UNKEYABLE_RECORD", count: 1 }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("有 start 无 message：不产候选、不置 pending、不报错", async () => {
  const { dir, file } = writeLog([[sessionRow()], [stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 })]]);
  try {
    const { samples, warnings, result } = await readLog(file);
    assert.equal(samples.length, 0, "无 message 就没有可统计的输出");
    assert.deepEqual(warnings, []);
    assert.equal(result.sampleCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("致命错误：整文件坏帧与文件不存在都必须抛出，且不产出候选", async () => {
  const broken = writeLog([corruptFrame()]);
  const missing = mkdtempSync(path.join(os.tmpdir(), "perf-dsh-reader-"));
  try {
    const collected = [];
    await assert.rejects(
      streamDshPerfSamples(broken.file, { id: HOME_ID }, (sample) => collected.push(sample), {}),
      /无法解压/,
    );
    assert.deepEqual(collected, []);
    await assert.rejects(
      streamDshPerfSamples(path.join(missing, "does-not-exist.jsonl.zstd"), { id: HOME_ID }, () => {}, {}),
      (error) => error?.code === "ENOENT",
    );
  } finally {
    rmSync(broken.dir, { recursive: true, force: true });
    rmSync(missing, { recursive: true, force: true });
  }
});

test("source 允许只给 homeId 字符串；onWarning 省略时不报错", async () => {
  const { dir, file } = writeLog(mainFixtureFrames());
  try {
    const samples = [];
    const result = await streamDshPerfSamples(file, HOME_ID, (sample) => samples.push(sample));
    assert.equal(samples.length, 3);
    assert.equal(result.sampleCount, 3);
    assert.equal(samples[0].homeId, HOME_ID);
    assert.deepEqual(result.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 成功 message 的 N/D 直连

test("同一成功 message 的 known reasoning 与 packed stream：N=8、B=1、D=末边界-首边界", async () => {
  const stream = [
    reasoningChunks(T0 + 800, [STREAM_SENTINEL], []),
    textChunks(T0 + 1000, ["", "a", " "], [20, 80]),
    toolChunks(T0 + 1200, ["", "\t"], [30], { index: 1, name: STREAM_SENTINEL }),
  ];
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 1, time: T0 + 100, turn: 1, step: 1 }),
      generationMessageRow({
        seq: 2,
        time: T0 + 1500,
        outputTokens: 12,
        reasoningTokens: 4,
        stream,
      }),
    ],
  ]);
  try {
    const { samples, rawSamples } = await readLogWithRaw(file);
    assert.equal(samples.length, 1);
    const [sample] = samples;
    assert.equal(sample.outputTokens, 7, "N=12-4=8；首输出已含 B=1，分子为 7");
    assert.equal(sample.durationMs, 210);
    assert.equal(sample.windowStartMs, T0 + 1020);
    assert.equal(sample.windowEndMs, T0 + 1230);
    assert.equal(sample.timingSource, "explicit");
    assert.equal(sample.window, "request");
    assert.equal(sample.timingKind, "generation");
    assert.equal(sample.tokenScope, "non_reasoning_output");
    assert.equal(rawSamples[0].reportedOutputTokens, 12);
    assert.equal(rawSamples[0].reportedReasoningTokens, 4);
    assert.equal(JSON.stringify(rawSamples).includes(STREAM_SENTINEL), false);
    assert.equal(JSON.stringify(samples).includes(STREAM_SENTINEL), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("已识别 stream 记录的多余 metadata 不影响 N/D；未知输出事件语义不猜测", async () => {
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 1, time: T0 + 500, turn: 1, step: 1 }),
      generationMessageRow({
        seq: 2,
        time: T0 + 1500,
        step: 1,
        outputTokens: 10,
        reasoningTokens: 2,
        stream: [
          {
            ...reasoningChunks(T0 + 900, ["reasoning"], []),
            recordMetadata: "ignored",
          },
          {
            ...textChunks(T0 + 1000, ["", "a", " "], [20, 80]),
            recordMetadata: { ignored: true },
          },
          {
            ...toolChunks(T0 + 1100, ["{", "}"], [10], { index: 1 }),
            recordMetadata: ["ignored"],
          },
          {
            type: "chunk",
            time: T0 + 1200,
            recordMetadata: "ignored",
            chunk: { type: "usage", usage: { output_tokens: 999 }, metadata: true },
          },
        ],
      }),
    ],
    [
      stepStartRow({ seq: 3, time: T0 + 1600, turn: 1, step: 2 }),
      generationMessageRow({
        seq: 4,
        time: T0 + 2600,
        step: 2,
        outputTokens: 10,
        reasoningTokens: 2,
        stream: [
          textChunks(T0 + 2000, ["a", "b"], [10]),
          { type: "future-output-chunks", time0: T0 + 2100, index: 0, dt: [], texts: ["?"] },
        ],
      }),
    ],
    [
      stepStartRow({ seq: 5, time: T0 + 2700, turn: 1, step: 3 }),
      generationMessageRow({
        seq: 6,
        time: T0 + 3700,
        step: 3,
        outputTokens: 10,
        reasoningTokens: 2,
        stream: [
          textChunks(T0 + 3000, ["a", "b"], [10]),
          { type: "chunk", time: T0 + 3100, chunk: { type: "future-output-delta", text: "?" } },
        ],
      }),
    ],
  ]);
  try {
    const { samples } = await readLog(file);
    const byKey = new Map(samples.map((sample) => [sample.sampleKey, sample]));
    const metadata = byKey.get(sampleKeyOf(SESSION_ID, 1, 1));
    assert.equal(metadata.outputTokens, 7);
    assert.equal(metadata.windowStartMs, T0 + 1020);
    assert.equal(metadata.windowEndMs, T0 + 1110);
    assert.equal(metadata.durationMs, 90);
    assert.equal(metadata.timingSource, "explicit");

    for (const step of [2, 3]) {
      const unknownEvent = byKey.get(sampleKeyOf(SESSION_ID, 1, step));
      assert.equal(unknownEvent.outputTokens, 7, "未知 stream 事件不得污染已知 N");
      assert.equal(unknownEvent.durationMs, null, "未知事件语义不得被猜成可计时输出");
      assert.ok(flagsOf(unknownEvent).includes("MISSING_DURATION"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning 缺/null/非整数/负数/超 output 均为 unknown；known 0 保留", async () => {
  const streams = new Map();
  const cases = [
    ["missing", NO_REASONING_FIELD],
    ["null", null],
    ["string", "4"],
    ["fraction", 1.5],
    ["negative", -1],
    ["over-output", 9],
    ["zero", 0],
  ];
  const frames = [[sessionRow()]];
  for (let index = 0; index < cases.length; index += 1) {
    const step = index + 1;
    const stream = [textChunks(T0 + 1000 + step * 100, ["a", "b"], [10])];
    streams.set(step, stream);
    frames.push([
      stepStartRow({ seq: step * 2, time: T0 + 500 + step * 100, turn: 1, step }),
      generationMessageRow({
        seq: step * 2 + 1,
        time: T0 + 1200 + step * 100,
        step,
        outputTokens: 8,
        reasoningTokens: cases[index][1],
        stream,
      }),
    ]);
  }
  const { dir, file } = writeLog(frames);
  try {
    const { samples, rawSamples } = await readLogWithRaw(file);
    const byKey = new Map(samples.map((sample) => [sample.sampleKey, sample]));
    const rawByKey = rawByIdentity(rawSamples);
    for (let index = 0; index < cases.length - 1; index += 1) {
      const step = index + 1;
      const sample = byKey.get(sampleKeyOf(SESSION_ID, 1, step));
      assert.equal(sample.outputTokens, null, `${cases[index][0]} reasoning 必须保持 unknown`);
      assert.equal(sample.durationMs, 10, "D 仍可由同一 message 的 stream 独立成立");
      assert.ok(flagsOf(sample).includes("MISSING_OUTPUT"));
    }
    const zeroStep = cases.length;
    const zero = byKey.get(sampleKeyOf(SESSION_ID, 1, zeroStep));
    assert.equal(zero.outputTokens, 7, "known reasoning=0 ⇒ N=8，B=1 后为 7");
    assert.equal(rawByKey.get(identityKey(1, zeroStep)).reportedReasoningTokens, 0);
    for (const [step, stream] of streams) {
      assert.equal(rawByKey.get(identityKey(1, step)).durationMs, 10);
      assert.ok(stream.length > 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("N-B<=0 不把 0/负分子写成样本：N=1 与 N=0 都保持 MISSING_OUTPUT", async () => {
  const stream1 = [textChunks(T0 + 1000, ["a", "b"], [10])];
  const stream2 = [textChunks(T0 + 2000, ["a", "b"], [10])];
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 1, time: T0 + 500, turn: 1, step: 1 }),
      generationMessageRow({
        seq: 2,
        time: T0 + 1500,
        step: 1,
        outputTokens: 2,
        reasoningTokens: 1,
        stream: stream1,
      }),
    ],
    [
      stepStartRow({ seq: 3, time: T0 + 1600, turn: 1, step: 2 }),
      generationMessageRow({
        seq: 4,
        time: T0 + 2500,
        step: 2,
        outputTokens: 1,
        reasoningTokens: 1,
        stream: stream2,
      }),
    ],
  ]);
  try {
    const { samples } = await readLog(file);
    assert.equal(samples.length, 2);
    for (const sample of samples) {
      assert.equal(sample.outputTokens, null);
      assert.equal(sample.durationMs, 10);
      assert.ok(flagsOf(sample).includes("MISSING_OUTPUT"));
      assert.ok(!flagsOf(sample).includes("OUTPUT_ZERO"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("空串不设边界，真实空白设边界；tool name 元数据与空 args 不设边界", async () => {
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 1, time: T0 + 500, turn: 1, step: 1 }),
      generationMessageRow({
        seq: 2,
        time: T0 + 1500,
        step: 1,
        outputTokens: 10,
        reasoningTokens: 2,
        stream: [textChunks(T0 + 1000, ["", " ", "\n"], [5, 5])],
      }),
    ],
    [
      stepStartRow({ seq: 3, time: T0 + 1600, turn: 1, step: 2 }),
      generationMessageRow({
        seq: 4,
        time: T0 + 2600,
        step: 2,
        outputTokens: 10,
        reasoningTokens: 2,
        stream: [toolChunks(T0 + 1005, [""], [], { name: STREAM_SENTINEL }), textChunks(T0 + 1020, ["a", "b"], [10])],
      }),
    ],
    [
      stepStartRow({ seq: 5, time: T0 + 2700, turn: 1, step: 3 }),
      generationMessageRow({
        seq: 6,
        time: T0 + 3700,
        step: 3,
        outputTokens: 10,
        reasoningTokens: 2,
        stream: [textChunks(T0 + 1040, ["a"], []), toolChunks(T0 + 1100, ["\t", ""], [100])],
      }),
    ],
  ]);
  try {
    const { samples } = await readLog(file);
    const byKey = new Map(samples.map((sample) => [sample.sampleKey, sample]));
    const whitespaceText = byKey.get(sampleKeyOf(SESSION_ID, 1, 1));
    assert.equal(whitespaceText.windowStartMs, T0 + 1005);
    assert.equal(whitespaceText.windowEndMs, T0 + 1010);
    assert.equal(whitespaceText.durationMs, 5);

    const nameMetadata = byKey.get(sampleKeyOf(SESSION_ID, 1, 2));
    assert.equal(nameMetadata.windowStartMs, T0 + 1020, "tool name 不能成为更早边界");
    assert.equal(nameMetadata.windowEndMs, T0 + 1030);
    assert.equal(nameMetadata.durationMs, 10);

    const whitespaceTool = byKey.get(sampleKeyOf(SESSION_ID, 1, 3));
    assert.equal(whitespaceTool.windowEndMs, T0 + 1100, "空白 args 有效，随后空 args 无效");
    assert.equal(whitespaceTool.durationMs, 60);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("多个 packed run 按各自 time0+累计 dt 重建，usage/finish chunk 不更新边界", async () => {
  const stream = [
    textChunks(T0 + 1010, ["a", "b", ""], [20, 30]),
    { type: "chunk", time: T0 + 1150, chunk: { type: "usage", usage: { output_tokens: 999 } } },
    toolChunks(T0 + 1200, ["x", "y"], [40], { index: 1 }),
    { type: "chunk", time: T0 + 1300, chunk: { type: "finish" } },
    textChunks(T0 + 1400, ["z"], [], 2),
  ];
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 1, time: T0 + 500, turn: 1, step: 1 }),
      generationMessageRow({
        seq: 2,
        time: T0 + 1500,
        outputTokens: 20,
        reasoningTokens: 5,
        stream,
      }),
    ],
  ]);
  try {
    const { samples } = await readLog(file);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].windowStartMs, T0 + 1010);
    assert.equal(samples[0].windowEndMs, T0 + 1400);
    assert.equal(samples[0].durationMs, 390);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reasoning 完全位于正文前/后可排除；穿插在两个有效输出之间拒绝 D", async () => {
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 1, time: T0 + 500, turn: 1, step: 1 }),
      generationMessageRow({
        seq: 2,
        time: T0 + 1500,
        step: 1,
        outputTokens: 10,
        reasoningTokens: 2,
        stream: [
          reasoningChunks(T0 + 900, ["before"], []),
          textChunks(T0 + 1000, ["a", "b"], [20]),
          reasoningChunks(T0 + 1100, ["after"], []),
        ],
      }),
    ],
    [
      stepStartRow({ seq: 3, time: T0 + 1600, turn: 1, step: 2 }),
      generationMessageRow({
        seq: 4,
        time: T0 + 2600,
        step: 2,
        outputTokens: 10,
        reasoningTokens: 2,
        stream: [textChunks(T0 + 2000, ["a", "b"], [100]), reasoningChunks(T0 + 2050, ["interleaved"], [])],
      }),
    ],
  ]);
  try {
    const { samples } = await readLog(file);
    const byKey = new Map(samples.map((sample) => [sample.sampleKey, sample]));
    const separated = byKey.get(sampleKeyOf(SESSION_ID, 1, 1));
    assert.equal(separated.durationMs, 20);
    assert.equal(separated.windowStartMs, T0 + 1000);
    assert.equal(separated.windowEndMs, T0 + 1020);

    const interleaved = byKey.get(sampleKeyOf(SESSION_ID, 1, 2));
    assert.equal(interleaved.durationMs, null);
    assert.equal(interleaved.timingSource, "unknown");
    assert.ok(flagsOf(interleaved).includes("MISSING_DURATION"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("失败 assistant/attempt 与另一条 message 的 stream 不得补成功 message 的 D", async () => {
  const successfulStream = [textChunks(T0 + 1000, ["only-one-boundary"], [])];
  const failedAttempt = {
    type: "assistant/attempt",
    seq: 3,
    time: T0 + 1500,
    data: {
      turn: 1,
      step: 1,
      usage: { outputTokens: 100, reasoningTokens: 0 },
      stream: [textChunks(T0 + 900, ["failed-a", "failed-b"], [50])],
    },
  };
  const otherMessageStream = [textChunks(T0 + 1900, ["other-a", "other-b"], [50])];
  const repaired = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 1, time: T0 + 500, turn: 1, step: 1 }),
      generationMessageRow({
        seq: 2,
        time: T0 + 1200,
        outputTokens: 10,
        reasoningTokens: 2,
        stream: successfulStream,
      }),
      failedAttempt,
    ],
    [
      stepStartRow({ seq: 4, time: T0 + 1700, turn: 1, step: 2 }),
      generationMessageRow({
        seq: 5,
        time: T0 + 1800,
        step: 2,
        outputTokens: 10,
        reasoningTokens: 2,
        stream: successfulStream,
      }),
      (() => {
        const row = messageRow({
          seq: 6,
          time: T0 + 2000,
          step: 2,
          includeUsage: false,
          includePayload: false,
        });
        row.data.stream = otherMessageStream;
        return row;
      })(),
    ],
  ]);
  try {
    const { samples } = await readLog(repaired.file);
    const byKey = new Map(samples.map((sample) => [sample.sampleKey, sample]));
    const failedIgnored = byKey.get(sampleKeyOf(SESSION_ID, 1, 1));
    assert.equal(failedIgnored.durationMs, null);
    assert.equal(failedIgnored.outputTokens, 7, "失败 attempt 不影响成功 message 的 N");
    const noCrossJoin = byKey.get(sampleKeyOf(SESSION_ID, 1, 2));
    assert.equal(noCrossJoin.durationMs, null, "首条成功 message 只有一个边界");
    assert.ok(flagsOf(noCrossJoin).includes("RECORD_CONFLICT"));
  } finally {
    rmSync(repaired.dir, { recursive: true, force: true });
  }
});

test("packed dt 长度/索引/回退时间非法时 D unknown；step 时长仍只作诊断", async () => {
  const { dir, file } = writeLog([
    [sessionRow()],
    [
      stepStartRow({ seq: 1, time: T0 + 500, turn: 1, step: 1 }),
      generationMessageRow({
        seq: 2,
        time: T0 + 2500,
        step: 1,
        outputTokens: 10,
        reasoningTokens: 2,
        stream: [{ type: "text-chunks", time0: T0 + 1000, index: 0, dt: [], texts: ["a", "b"] }],
      }),
    ],
    [
      stepStartRow({ seq: 3, time: T0 + 2600, turn: 1, step: 2 }),
      generationMessageRow({
        seq: 4,
        time: T0 + 3600,
        step: 2,
        outputTokens: 10,
        reasoningTokens: 2,
        stream: [{ type: "text-chunks", time0: T0 + 3000, index: -1, dt: [10], texts: ["a", "b"] }],
      }),
    ],
    [
      stepStartRow({ seq: 5, time: T0 + 3700, turn: 1, step: 3 }),
      generationMessageRow({
        seq: 6,
        time: T0 + 4700,
        step: 3,
        outputTokens: 10,
        reasoningTokens: 2,
        stream: [{ type: "text-chunks", time0: T0 + 4000, index: 0, dt: [-10], texts: ["a", "b"] }],
      }),
    ],
  ]);
  try {
    const { samples, rawSamples } = await readLogWithRaw(file);
    for (const sample of samples) {
      assert.equal(sample.durationMs, null);
      assert.equal(sample.outputTokens, 7, "非法 D 不污染同一 message 的 known N");
    }
    for (const raw of rawSamples) {
      assert.ok(raw.reportedDurationMs > 0, "step 差值只留在诊断字段");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PERF_FLAGS 常量与本文件断言自洽（防止把未知名写成断言）", () => {
  for (const name of [
    "TERMINAL_UNVERIFIED",
    "RECORD_CONFLICT",
    "MODEL_AMBIGUOUS",
    "MISSING_DURATION",
    "MISSING_OUTPUT",
    "OUTPUT_ZERO",
    "DURATION_NONPOSITIVE",
  ]) {
    assert.equal(typeof PERF_FLAGS[name], "number", `${name} 必须在册`);
  }
});
