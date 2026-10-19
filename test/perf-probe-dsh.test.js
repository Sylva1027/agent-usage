/**
 * M0.3 DSH 来源探测契约测试。
 *
 * 夹具是**人工合成**的多帧 `.jsonl.zstd`（每帧独立 zstd 压缩后拼接，复现 DSH 的流式追加写法），
 * 覆盖 step 重置、模型变更、重复帧、坏帧、缺 start、缺 usage 与负时长。所有临时目录都落在系统
 * 临时目录里，写入 `runPerfProbe(argv, { outputRoot, sourceModuleRoot })` 注入的输出根；
 * `~/.dsh` 通过 user profile 指向空目录隔离，夹具 home 走生产 env 注入点 `CODEX_USAGE_DSH_HOMES`。
 *
 * **正文哨兵**：message content 与 stream 里各塞一个独特魔法串，step/end 的 data 里再塞一个；
 * 断言产物 JSON 完全不含它们 —— 这是"不访问正文/stream/step-end"的直接证据，
 * 而不是只依赖 `fields.*Accessed === false` 的自我声明。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { PERF_FLAG_NAMES, PROBE_EXIT_CODES, runPerfProbe } from "../scripts/perf-probe.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROBE_SCRIPT = path.join(REPO_ROOT, "scripts", "perf-probe.mjs");
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const T0 = Date.parse("2026-10-01T00:00:00.000Z");
const BODY_SENTINEL = "DSH-BODY-SENTINEL-7f3c1a9e-不得进入产物";
const STREAM_SENTINEL = "DSH-STREAM-SENTINEL-2b8d4e";
const STEP_END_SENTINEL = "DSH-STEP-END-SENTINEL-9a1f";
const SESSION_ID = "session-fixture-0001";
const ENV_KEYS = ["CODEX_USAGE_DSH_HOMES", "CODEX_USAGE_DSH", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH"];

function frame(rows) {
  return zstdCompressSync(Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8"));
}

/** 无法解压的坏帧：zstd 魔数 + 垃圾字节，且垃圾里不再出现魔数。 */
function corruptFrame() {
  return Buffer.concat([ZSTD_MAGIC, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])]);
}

function sessionRow(overrides = {}) {
  return {
    type: "session",
    version: 4,
    id: SESSION_ID,
    cwd: "E:\\fixture\\proj",
    createdAt: T0,
    delegationDepth: 0,
    agentPreset: "standard",
    ...overrides,
  };
}

function requestRow({ seq = 2, time = T0 + 500, model = "fixture-model-a", provider = "fixture-provider" } = {}) {
  return {
    type: "request/header",
    seq,
    time,
    data: { header: { config: { provider, model, reasoningEffort: "max" } }, reason: "turn-start" },
  };
}

function stepStartRow({ seq = 3, time = T0 + 1000, turn = 1, step = 1 } = {}) {
  return { type: "step/start", seq, time, data: { turn, step } };
}

function stepEndRow({ seq = 4, time = T0 + 1500, turn = 1, step = 1 } = {}) {
  return { type: "step/end", seq, time, data: { turn, step, marker: STEP_END_SENTINEL } };
}

function messageRow({ seq = 5, time = T0 + 2000, turn = 1, step = 1, outputTokens = 100, includeUsage = true } = {}) {
  const data = {
    turn,
    step,
    message: { content: [{ type: "text", text: BODY_SENTINEL }] },
    stream: [{ type: "delta", time, chunk: { text: STREAM_SENTINEL } }],
  };
  if (includeUsage) {
    data.usage = { inputTokens: 1614, cacheReadTokens: 6784, cacheWriteTokens: 0, outputTokens, totalTokens: 8525 };
  }
  return { type: "assistant/message", seq, time, surfaceOp: "append", data };
}

function makeFixtureHome() {
  return mkdtempSync(path.join(os.tmpdir(), "perf-probe-dsh-home-"));
}

function writeSessionFile(homeDir, { sessionId = SESSION_ID, version = 4, frames }) {
  const sessionDir = path.join(homeDir, "sessions", "--E-fixture-proj--", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `session.v${version}.jsonl.zstd`);
  // 每帧独立压缩后拼接；Buffer 形式的帧（坏帧）直接使用。
  const buffers = frames.map((rows) => (Buffer.isBuffer(rows) ? rows : frame(rows)));
  writeFileSync(filePath, Buffer.concat(buffers));
  return filePath;
}

/**
 * 在隔离的 user profile 下探测夹具 home。
 * `outputRoot` 与 `sourceModuleRoot` 都注入临时根：产品输出守卫仍由外壳实现，测试不复制它。
 */
async function runProbeWithFixtureHome({ homeDir = null, extraHomes = [], argvExtra = [] } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "perf-probe-dsh-run-"));
  const runDirectory = path.join(root, "2026-10-04-perf-metrics", "testrun");
  const profile = path.join(root, "empty-profile");
  mkdirSync(profile, { recursive: true });
  const saved = new Map();
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
  }
  const homes = [homeDir, ...extraHomes].filter(Boolean);
  if (homes.length > 0) {
    process.env.CODEX_USAGE_DSH_HOMES = homes.join(path.delimiter);
  } else {
    delete process.env.CODEX_USAGE_DSH_HOMES;
  }
  process.env.USERPROFILE = profile;
  process.env.HOME = profile;
  process.env.HOMEDRIVE = "";
  process.env.HOMEPATH = profile;
  delete process.env.CODEX_USAGE_DSH;
  try {
    const lines = [];
    const exitCode = await runPerfProbe(["--source", "dsh", "--output", runDirectory, ...argvExtra], {
      log: (line) => lines.push(line),
      outputRoot: root,
    });
    const outputFile = path.join(runDirectory, "dsh-probe.json");
    const raw = existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "";
    return {
      exitCode,
      raw,
      envelope: raw ? JSON.parse(raw) : null,
      lines,
      root,
      runDirectory,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } finally {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/** 主夹具：一帧一会话头，12 帧拼接，含一个坏帧。 */
function writeMainFixtureHome() {
  const homeDir = makeFixtureHome();
  writeSessionFile(homeDir, {
    frames: [
      [sessionRow()],
      [
        requestRow({ seq: 2, time: T0 + 500, model: "fixture-model-a" }),
        stepStartRow({ seq: 3, time: T0 + 1000, turn: 1, step: 1 }),
        messageRow({ seq: 4, time: T0 + 2000, turn: 1, step: 1, outputTokens: 100 }),
      ],
      [
        stepStartRow({ seq: 5, time: T0 + 3000, turn: 1, step: 2 }),
        messageRow({ seq: 6, time: T0 + 4000, turn: 1, step: 2, outputTokens: 0 }),
      ],
      [
        requestRow({ seq: 7, time: T0 + 5000, model: "fixture-model-b" }),
        stepStartRow({ seq: 8, time: T0 + 6000, turn: 2, step: 1 }),
        messageRow({ seq: 9, time: T0 + 7000, turn: 2, step: 1, outputTokens: 50 }),
      ],
      [
        stepStartRow({ seq: 10, time: T0 + 8000, turn: 2, step: 2 }),
        stepStartRow({ seq: 11, time: T0 + 8000, turn: 2, step: 2 }),
        messageRow({ seq: 12, time: T0 + 9000, turn: 2, step: 2, outputTokens: 30 }),
      ],
      [messageRow({ seq: 13, time: T0 + 10000, turn: 3, step: 3, outputTokens: 40 })],
      [
        stepStartRow({ seq: 14, time: T0 + 11000, turn: 3, step: 4 }),
        messageRow({ seq: 15, time: T0 + 12000, turn: 3, step: 4, includeUsage: false }),
      ],
      [
        stepStartRow({ seq: 16, time: T0 + 51_000, turn: 4, step: 1 }),
        messageRow({ seq: 17, time: T0 + 47_000, turn: 4, step: 1, outputTokens: 10 }),
      ],
      corruptFrame(),
      [
        stepStartRow({ seq: 18, time: T0 + 14000, turn: 5, step: 4 }),
        messageRow({ seq: 19, time: T0 + 15000, turn: 5, step: 4, outputTokens: 7 }),
      ],
      [stepEndRow({ seq: 20, time: T0 + 16000, turn: 5, step: 4 })],
      // M0.6 决议 DSH-G1 的五种终态证据形态（每个 turn/step 独立）：
      // 6/1：step/end 落在 message **之后** → 唯一可进 sampled 的形态
      [
        stepStartRow({ seq: 21, time: T0 + 17000, turn: 6, step: 1 }),
        messageRow({ seq: 22, time: T0 + 18000, turn: 6, step: 1, outputTokens: 200 }),
        stepEndRow({ seq: 23, time: T0 + 19000, turn: 6, step: 1 }),
      ],
      // 6/2：step/end 落在 message **之前** → 不得当作收尾证据
      [
        stepEndRow({ seq: 24, time: T0 + 20000, turn: 6, step: 2 }),
        stepStartRow({ seq: 25, time: T0 + 21000, turn: 6, step: 2 }),
        messageRow({ seq: 26, time: T0 + 22000, turn: 6, step: 2, outputTokens: 210 }),
      ],
      // 6/3：无任何 step/end，但有 turn/end → 仍不构成终态证据
      [
        stepStartRow({ seq: 27, time: T0 + 23000, turn: 6, step: 3 }),
        messageRow({ seq: 28, time: T0 + 24000, turn: 6, step: 3, outputTokens: 220 }),
      ],
      // 6/4：同 step 在**同一文件内**跨两段重复出现，末次为 message 后接 step/end
      [
        stepStartRow({ seq: 29, time: T0 + 25000, turn: 6, step: 4 }),
        messageRow({ seq: 30, time: T0 + 26000, turn: 6, step: 4, outputTokens: 230, includeUsage: false }),
      ],
      [
        stepStartRow({ seq: 31, time: T0 + 25000, turn: 6, step: 4 }),
        messageRow({ seq: 32, time: T0 + 26000, turn: 6, step: 4, outputTokens: 230 }),
        stepEndRow({ seq: 33, time: T0 + 27000, turn: 6, step: 4 }),
      ],
      // 6/5：step/end 先于 message（同组更早），message 之后无 step/end
      [
        stepStartRow({ seq: 34, time: T0 + 28000, turn: 6, step: 5 }),
        stepEndRow({ seq: 35, time: T0 + 28500, turn: 6, step: 5 }),
        messageRow({ seq: 36, time: T0 + 29000, turn: 6, step: 5, outputTokens: 240 }),
      ],
    ],
  });
  return homeDir;
}

// ---------------------------------------------------------------- 主夹具：配对与哨兵

test("M0.3 主夹具：step 重置 + 模型变更 + 重复/缺失/坏帧/负时长全部有编码结果", async () => {
  const homeDir = writeMainFixtureHome();
  const run = await runProbeWithFixtureHome({ homeDir });
  try {
    assert.equal(run.exitCode, PROBE_EXIT_CODES.ok, run.lines.join("\n"));
    const { envelope, raw } = run;
    assert.equal(envelope.status, "ok");
    assert.equal(envelope.source, "dsh");
    // 外壳白名单全部命中：任何越界字段都会出现在 fieldRejections 里。
    assert.deepEqual(envelope.fieldRejections, []);

    const scanned = envelope.scanned;
    assert.equal(scanned.files, 1);
    assert.equal(scanned.filesDiscovered, 1);
    assert.equal(scanned.filesScanned, 1);
    assert.equal(scanned.rowsScanned, 36);
    assert.equal(scanned.rowsRead, 36);
    assert.equal(scanned.homes, 1);
    assert.equal(scanned.bounded, true);
    assert.equal(scanned.truncated, false);
    assert.equal(scanned.complete, false, "含坏帧的来源不得称为完整来源");
    assert.equal(scanned.readOnly, true);

    // 帧类型原始计数
    assert.equal(scanned.sessionHeaderCount, 1);
    assert.equal(scanned.requestHeaderCount, 2);
    assert.equal(scanned.stepStartCount, 14);
    assert.equal(scanned.assistantMessageCount, 14);

    // 配对与重复
    // 本夹具没有"有 start 无 message"的分组：`unpairedCandidates=1` 是唯一的
    // message-only 组（turn3/step3）。message-less 组（若有）既不进 eligible 也不进 pending。
    assert.equal(scanned.pairedCandidates, 11, "11 个身份无冲突的配对；缺 start 的 message-only 不计入配对");
    assert.equal(scanned.unpairedCandidates, 1);
    assert.equal(scanned.duplicateStartFrames, 2);
    assert.equal(scanned.duplicateMessageFrames, 1);
    assert.equal(scanned.multipleStartCount, 2);
    assert.equal(scanned.consistentDuplicateCount, 1);
    assert.equal(scanned.conflictingRecords, 1, "6/4 段的两次 message 取值不同 → 恒计数组，但时间一致故仍可配对");
    assert.equal(
      scanned.identityDuplicateGroupCount,
      1,
      "6/4 段的两次 message 取值不同 → 恒计数组，但时间一致故仍可配对",
    );
    assert.equal(scanned.uniqueIdentities, 12);

    // 缺失与异常
    assert.equal(scanned.missingStart, 1);
    assert.equal(scanned.missingUsage, 2);
    assert.equal(scanned.outputMissingCount, 1);
    assert.equal(scanned.outputZeroCount, 1);
    assert.equal(scanned.negativeDurations, 1);
    assert.equal(scanned.badFrames, 1);
    assert.equal(scanned.malformedFrameCount, 1);
    assert.equal(scanned.missingSessionHeader, 0);
    assert.equal(scanned.versionNonV4Count, 0);
    assert.equal(scanned.unplaced, 0);

    // step 重置与模型变更
    assert.equal(scanned.stepReuseAcrossTurns, 4, "step 1/2/4 跨 turn 复用，另加 6/3 的 step 3");
    assert.equal(scanned.headerChanges, 1, "model a → model b 记一次变更");
    assert.equal(envelope.fields.stepResetObserved, true);
    assert.equal(envelope.fields.modelChangedMidSession, true);
    assert.equal(envelope.fields.distinctModels, 2);
    assert.equal(envelope.fields.distinctProviders, 1);

    // 时间单位：11 个配对全部是毫秒 epoch
    assert.equal(scanned.timeUnitCheckedCount, 11);
    assert.equal(scanned.timeUnitMatchedCount, 11);
    assert.equal(scanned.milliSecondUnitCount, 11);
    assert.equal(scanned.secondUnitCount, 0);
    assert.equal(envelope.fields.timeUnit, "milliseconds");
    assert.equal(envelope.fields.unitAmbiguous, false);

    // §17.5 分层与恒等式
    // eligible = 12 个"有 start 有 message"的分组 + 1 个 message-only 分组（turn3/step3）；
    // 冲突组（6/4）仍计入 eligible，但在其后的判据里被诊断为 RECORD_CONFLICT 而不进 sampled。
    assert.equal(scanned.eligible, 13);
    assert.equal(scanned.positiveOutput, 10);
    assert.equal(scanned.timedPositiveOutput, 8);
    assert.equal(scanned.completeTimedPositiveOutput, 8);
    // M0.6 决议 DSH-G1：`step/end` 出现在最后一条 message **之后**才算收尾证据。
    // 主夹具里只有 turn5/step4（seq 20 在 message 之后）与 turn6/step1 命中，共 2 个。
    // 其余 3 条 `step/end` 分别落在 message 之前（6/2、6/5）或属于冲突组（6/4）→ 不构成终态证据。
    assert.equal(scanned.stepEndFrames, 5);
    assert.equal(scanned.completeEvidenceCount, 2, "帧序必须逐帧递增，end 才能落在 message 之后");
    assert.equal(scanned.sampled, 2, "只有 message 之后跟着 step/end 的 step 才可计样本");
    assert.equal(scanned.pending, 0, "DSH 没有「明确进行中」的证据：pending 恒为 0");
    assert.equal(scanned.dropped, 11);
    assert.equal(scanned.eligible, scanned.sampled + scanned.dropped + scanned.pending);
    assert.ok(scanned.dropped >= 0, "dropped 不得为负");
    assert.equal(scanned.sampled, scanned.completeEvidenceCount);
    assert.ok(scanned.sampled <= scanned.completeTimedPositiveOutput);
    assert.ok(scanned.completeTimedPositiveOutput <= scanned.timedPositiveOutput);
    assert.ok(scanned.timedPositiveOutput <= scanned.positiveOutput);
    assert.ok(scanned.positiveOutput <= scanned.eligible);
    // 终态决议随证据变化：turn5/step4 与 turn6/step1 的 `step/end` 落在其 message 之后 →
    // 有终态证据 → `completed`；另外 3 条 end 不构成收尾证据（见上）。
    assert.equal(envelope.fields.statusKind, "completed");
    assert.equal(envelope.fields.terminalEvidenceDecision, "proven_completed");
    assert.equal(envelope.fields.terminalFieldKind, "step_end_frame");
    assert.equal(envelope.fields.diagnosticReason, "none");

    // flag 计数
    const flags = envelope.decisions.flagCounts;
    assert.equal(flags.OUTPUT_ZERO, 1);
    assert.equal(flags.MISSING_OUTPUT, 1);
    assert.equal(flags.MISSING_DURATION, 1);
    assert.equal(flags.DURATION_NONPOSITIVE, 1);
    // 8 个走到终态判据的样本里 2 个有终态证据（turn5/step4、turn6/step1），其余 6 个仍无终态证据。
    assert.equal(flags.TERMINAL_UNVERIFIED, 6);
    assert.equal(flags.RECORD_CONFLICT, 1, "6/4 段的两次 message 取值不同 → 同身份冲突");
    for (const name of Object.keys(flags)) {
      assert.ok(PERF_FLAG_NAMES.includes(name), `flag ${name} 必须在册`);
    }
    assert.equal(envelope.decisions.warningCounts.MALFORMED_FRAME, 1);

    // 逐列存在性：容器 + 在册子键
    assert.equal(envelope.fields.columns.session, "present");
    assert.equal(envelope.fields.columns.step_start, "present");
    assert.equal(envelope.fields.columns.assistant_message, "present");
    assert.equal(envelope.fields.columns.output_tokens_usage, "present");
    assert.equal(envelope.fields.columns.step_end, "present", "只据 type 判别式判定存在");
    assert.equal(envelope.fields.columns.context, "absent", "全文件覆盖下未观察到 request/context");
    assert.equal(envelope.fields.columns.agent_preset, "present");
    assert.equal(envelope.fields.columns.delegation_depth, "present");
    assert.equal(envelope.fields.allColumnsPresent, true);
    assert.equal(envelope.fields.columnStates.total, 10);

    // 访问守卫：只读谓词是实测结果。
    // M0.6 决议 DSH-G1 之后，`step/end` 的**判别式**与 (turn,step) 归属会被读取
    // （这是终态证据所必需），因此 `stepEndAccessed` 由恒 false 变为实测正值；
    // 其 `data` 其余键与 `time` 仍从未访问，由 STEP_END_SENTINEL 不落盘锁定。
    assert.equal(envelope.fields.streamAccessed, false);
    assert.equal(envelope.fields.contentAccessed, false);
    assert.equal(envelope.fields.stepEndAccessed, true, "step/end 判别式已读：终态证据所必需");
    assert.equal(envelope.fields.bodySentinelFound, false);

    // 正文哨兵：产物里不得出现任何正文/流式/step-end 载荷
    for (const sentinel of [BODY_SENTINEL, STREAM_SENTINEL, STEP_END_SENTINEL]) {
      assert.equal(raw.includes(sentinel), false, `产物泄露了哨兵 ${sentinel}`);
    }
    // 模型名/供应商/会话 ID/路径同样不得落盘
    for (const secret of ["fixture-model-a", "fixture-model-b", "fixture-provider", SESSION_ID, homeDir]) {
      assert.equal(raw.includes(secret), false, `产物泄露了原始标识 ${secret}`);
    }

    // 指纹与只读策略
    assert.match(envelope.sourceFingerprintBefore.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(envelope.sourceFingerprintBefore.fileCount, 1);
    assert.equal(envelope.liveSourceChanged, false);
    assert.equal(envelope.fields.readOnly, true);
    assert.equal(envelope.decisions.readOnlyEnforced, true);
    assert.equal(envelope.decisions.optionalSourceUsed, false);
  } finally {
    run.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 坏帧不冒充完整来源

test("坏帧后剩余记录仍解析，但来源状态明确降级且不得称为完整", async () => {
  const homeDir = makeFixtureHome();
  writeSessionFile(homeDir, {
    frames: [
      [sessionRow()],
      corruptFrame(),
      [stepStartRow({ seq: 2, time: T0 + 1000 }), messageRow({ seq: 3, time: T0 + 2000, outputTokens: 42 })],
    ],
  });
  const run = await runProbeWithFixtureHome({ homeDir });
  try {
    assert.equal(run.exitCode, PROBE_EXIT_CODES.ok);
    const { scanned, fields, decisions, warnings } = run.envelope;
    assert.equal(scanned.badFrames, 1);
    assert.equal(scanned.complete, false);
    assert.equal(fields.coverageState, "degraded");
    assert.equal(decisions.coverageState, "degraded");
    assert.ok(scanned.eligible > 0, "坏帧之后的合法记录仍应被解析（而不是整文件丢弃）");
    assert.deepEqual(warnings, [{ code: "MALFORMED_FRAME", count: 1 }]);
    assert.equal(decisions.warningCounts.MALFORMED_FRAME, 1);
  } finally {
    run.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 缺会话头 / 版本不支持

test("缺 session 头的文件：记录计入 unplaced，不进入 eligible", async () => {
  const homeDir = makeFixtureHome();
  writeSessionFile(homeDir, {
    frames: [[stepStartRow({ seq: 1, time: T0 + 1000 }), messageRow({ seq: 2, time: T0 + 2000, outputTokens: 9 })]],
  });
  const run = await runProbeWithFixtureHome({ homeDir });
  try {
    assert.equal(run.exitCode, PROBE_EXIT_CODES.ok);
    const { scanned, fields } = run.envelope;
    assert.equal(scanned.missingSessionHeader, 1);
    assert.equal(scanned.unplaced, 2);
    assert.equal(scanned.eligible, 0);
    assert.equal(fields.columns.session, "absent");
    assert.equal(fields.pairingConsistent, true);
    assert.equal(scanned.complete, false);
    assert.equal(fields.coverageState, "degraded");
  } finally {
    run.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("版本 4 之外：UNSUPPORTED_SCHEMA 告警且不按 v4 硬解", async () => {
  const homeDir = makeFixtureHome();
  writeSessionFile(homeDir, {
    version: 5,
    frames: [
      [sessionRow({ version: 5 })],
      [
        requestRow(),
        stepStartRow({ seq: 3, time: T0 + 1000 }),
        messageRow({ seq: 4, time: T0 + 2000, outputTokens: 11 }),
      ],
    ],
  });
  const run = await runProbeWithFixtureHome({ homeDir });
  try {
    assert.equal(run.exitCode, PROBE_EXIT_CODES.ok);
    const { scanned, fields, warnings, decisions } = run.envelope;
    assert.equal(scanned.versionNonV4Count, 1);
    assert.equal(scanned.unsupportedVersionCount, 1);
    assert.equal(scanned.eligible, 0);
    assert.equal(scanned.pairedCandidates, 0);
    assert.equal(fields.sourceVersion, "unknown");
    assert.equal(scanned.complete, false);
    assert.ok(warnings.some((entry) => entry.code === "UNSUPPORTED_SCHEMA"));
    assert.equal(decisions.warningCounts.UNSUPPORTED_SCHEMA, 1);
  } finally {
    run.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 时间单位与冲突

test("秒级时间戳：secondUnitCount 计数、TIME_INVALID 置位、不产正时长样本", async () => {
  const homeDir = makeFixtureHome();
  writeSessionFile(homeDir, {
    frames: [
      [sessionRow()],
      [stepStartRow({ seq: 1, time: 1_700_000_000 }), messageRow({ seq: 2, time: 1_700_000_060, outputTokens: 25 })],
    ],
  });
  const run = await runProbeWithFixtureHome({ homeDir });
  try {
    assert.equal(run.exitCode, PROBE_EXIT_CODES.ok);
    const { scanned, fields, decisions } = run.envelope;
    assert.equal(scanned.timeUnitCheckedCount, 1);
    assert.equal(scanned.timeUnitMatchedCount, 0);
    assert.equal(scanned.secondUnitCount, 1);
    assert.equal(fields.timeUnit, "unknown");
    assert.equal(fields.unitAmbiguous, true);
    assert.equal(scanned.positiveOutput, 1);
    assert.equal(scanned.timedPositiveOutput, 0);
    assert.equal(decisions.flagCounts.TIME_INVALID, 1);
    assert.equal(decisions.flagCounts.TERMINAL_UNVERIFIED, undefined);
  } finally {
    run.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("同身份冲突帧：计数并置 RECORD_CONFLICT，不任选末条、不相加", async () => {
  const homeDir = makeFixtureHome();
  writeSessionFile(homeDir, {
    frames: [
      [sessionRow()],
      [
        stepStartRow({ seq: 1, time: T0 + 1000 }),
        stepStartRow({ seq: 2, time: T0 + 1500 }),
        messageRow({ seq: 3, time: T0 + 2000, outputTokens: 10 }),
        messageRow({ seq: 4, time: T0 + 2500, outputTokens: 20 }),
      ],
    ],
  });
  const run = await runProbeWithFixtureHome({ homeDir });
  try {
    assert.equal(run.exitCode, PROBE_EXIT_CODES.ok);
    const { scanned, fields, decisions } = run.envelope;
    assert.equal(scanned.conflictingRecords, 1);
    assert.equal(scanned.pairedCandidates, 0);
    assert.equal(scanned.duplicateStartFrames, 1);
    assert.equal(scanned.duplicateMessageFrames, 1);
    assert.equal(scanned.identityDuplicateGroupCount, 1);
    assert.equal(scanned.identityDuplicateCount, 2);
    assert.equal(scanned.uniqueIdentities, 1);
    assert.equal(scanned.consistentDuplicateCount, 0);
    assert.equal(scanned.eligible, 1);
    assert.equal(scanned.dropped, 1);
    assert.equal(fields.conflictDetected, true);
    assert.equal(fields.pairingConsistent, false);
    assert.equal(fields.diagnosticReason, "record_conflict");
    assert.equal(decisions.flagCounts.RECORD_CONFLICT, 1);
    // 冲突组的两条 message 输出（10/20）都没有被当成样本或求和
    assert.equal(scanned.positiveOutput, 0);
  } finally {
    run.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 帧序与终态证据（P1-1 回归）

test("帧序回归：step/end 在 message 之后才算终态证据，在之前一律不判完成", async () => {
  // (1) start → message → end：唯一可进 sampled 的形态。
  const afterHome = makeFixtureHome();
  writeSessionFile(afterHome, {
    frames: [
      [sessionRow()],
      [
        stepStartRow({ seq: 1, time: T0 + 1000 }),
        messageRow({ seq: 2, time: T0 + 2000, outputTokens: 80 }),
        stepEndRow({ seq: 3, time: T0 + 2500 }),
      ],
    ],
  });
  const after = await runProbeWithFixtureHome({ homeDir: afterHome });
  try {
    assert.equal(after.exitCode, PROBE_EXIT_CODES.ok, after.lines.join("\n"));
    const { scanned, fields, decisions } = after.envelope;
    assert.equal(scanned.eligible, 1);
    assert.equal(scanned.stepEndFrames, 1);
    assert.equal(scanned.completeEvidenceCount, 1, "同文件内 end 的帧序必须严格大于其组内最后一条 message");
    assert.equal(scanned.sampled, 1);
    assert.equal(scanned.pending, 0);
    assert.equal(scanned.dropped, 0);
    assert.equal(scanned.eligible, scanned.sampled + scanned.dropped + scanned.pending);
    assert.ok(scanned.dropped >= 0);
    assert.equal(fields.statusKind, "completed");
    assert.equal(fields.terminalFieldKind, "step_end_frame");
    assert.equal(fields.terminalEvidenceDecision, "proven_completed");
    assert.equal(fields.diagnosticReason, "none");
    // 无任何 flag 时外壳允许省略整个 `flagCounts` 容器，故此处按"缺席即 0"断言。
    assert.equal(decisions.flagCounts?.TERMINAL_UNVERIFIED ?? 0, 0);
  } finally {
    after.cleanup();
    rmSync(afterHome, { recursive: true, force: true });
  }

  // (2) end → start → message：end 在 message **之前** → 不得当终态证据（§17.4 位 10 防推定成功）。
  const beforeHome = makeFixtureHome();
  writeSessionFile(beforeHome, {
    frames: [
      [sessionRow()],
      [
        stepEndRow({ seq: 1, time: T0 + 500 }),
        stepStartRow({ seq: 2, time: T0 + 1000 }),
        messageRow({ seq: 3, time: T0 + 2000, outputTokens: 80 }),
      ],
    ],
  });
  const before = await runProbeWithFixtureHome({ homeDir: beforeHome });
  try {
    assert.equal(before.exitCode, PROBE_EXIT_CODES.ok, before.lines.join("\n"));
    const { scanned, fields, decisions } = before.envelope;
    assert.equal(scanned.eligible, 1);
    assert.equal(scanned.stepEndFrames, 1, "end 被数到了，但必须被帧序判别式挡掉");
    assert.equal(scanned.completeEvidenceCount, 0);
    assert.equal(scanned.sampled, 0, "有 end 不等于完成：顺序不对就不构成终态证据");
    assert.equal(scanned.pending, 0);
    assert.equal(scanned.dropped, 1);
    assert.equal(fields.statusKind, "unverified");
    assert.equal(fields.terminalFieldKind, "absent");
    assert.equal(fields.terminalEvidenceDecision, "unverified");
    assert.equal(fields.diagnosticReason, "terminal_unverified");
    assert.equal(decisions.flagCounts.TERMINAL_UNVERIFIED, 1);
  } finally {
    before.cleanup();
    rmSync(beforeHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 孤立 start 与分层非负（P1-2 回归）

test("孤立 start（无 message）：不进 eligible、不判 pending、dropped 不为负", async () => {
  const homeDir = makeFixtureHome();
  writeSessionFile(homeDir, {
    frames: [[sessionRow()], [stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 })]],
  });
  const run = await runProbeWithFixtureHome({ homeDir });
  try {
    assert.equal(run.exitCode, PROBE_EXIT_CODES.ok, run.lines.join("\n"));
    const { scanned, fields } = run.envelope;
    assert.equal(scanned.sessionHeaderCount, 1);
    assert.equal(scanned.stepStartCount, 1);
    assert.equal(scanned.assistantMessageCount, 0);
    assert.equal(scanned.unpairedCandidates, 1);
    assert.equal(scanned.eligible, 0, "无 message 的 start 不是产出候选");
    assert.equal(scanned.sampled, 0);
    assert.equal(scanned.pending, 0, "「有 start 无 message」不是「明确进行中」，不得回填 pending");
    assert.equal(scanned.dropped, 0);
    assert.ok(scanned.dropped >= 0, "dropped 曾因 pending 回填变成 -1，必须回归为非负");
    assert.equal(scanned.dropped, scanned.eligible - scanned.sampled - scanned.pending);
    assert.equal(scanned.completeTimedPositiveOutput, 0);
    assert.equal(fields.statusKind, "unverified");
  } finally {
    run.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("M0 返工第4项：DSH 产物不得出现「未统计却上报 0」的键（逐键复核）", async () => {
  const homeDir = makeFixtureHome();
  writeSessionFile(homeDir, {
    frames: [
      [sessionRow()],
      [stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 })],
      [messageRow({ seq: 2, time: T0 + 3000, turn: 1, step: 1 })],
      [stepEndRow({ seq: 3, time: T0 + 4000, turn: 1, step: 1 })],
    ],
  });
  const run = await runProbeWithFixtureHome({ homeDir });
  try {
    assert.equal(run.exitCode, PROBE_EXIT_CODES.ok, run.lines.join("\n"));
    const scanned = run.envelope.scanned;

    // DSH 的每个在册计数键**都有真实累加点**，因此 0 一律是"实测为 0"或"结构事实"，
    // 不存在 Codex 那种写死 0 的"未统计"键。本用例锁死该结论：
    // 若将来有人新增一个未统计的键（或把它写死 0），这里必须失败。
    //
    // 结构事实类（本来源**没有**这个概念，0 是定义而非观测）：
    //   pending —— 本来源只承认"明确进行中"的证据，dsh.mjs:534 注释明示故恒为 0。
    // 观测类（真实累加器，见 dsh.mjs 增量点）：其余全部。
    assert.equal(scanned.pending, 0, "结构事实：本来源没有「明确进行中」证据");
    assert.equal(run.envelope.fields.readOnly, true, "只读纪律——未统计键的省略不得以牺牲只读为代价");

    // 未统计键的判定：本来源当前**不存在**这类键。断言两个典型"未统计"候选在产物中
    // 只能出现为**真实计数**（有累加点），而不是被写死。
    // 用"能在合成输入下被算出非 0"来证明"有计算逻辑"。
    assert.equal(scanned.badFrames, 0, "本 fixture 无坏帧——0 由真实计数得出");
    assert.equal(scanned.outputZeroCount, 0, "本 fixture 无零输出——0 由真实计数得出");
    assert.ok(
      Object.hasOwn(scanned, "stepEndFrames") && scanned.stepEndFrames > 0,
      "stepEndFrames 有真实增量（证明该类计数不是写死）",
    );

    // 省略不是本来源的修复手段，故**不得**因为本卡而少报任何既有键。
    assert.deepEqual(run.envelope.fieldRejections, []);
  } finally {
    run.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("混合候选：同会话内正常完成与孤立 start 互不影响", async () => {
  const homeDir = makeFixtureHome();
  writeSessionFile(homeDir, {
    frames: [
      [sessionRow()],
      [
        stepStartRow({ seq: 1, time: T0 + 1000, turn: 1, step: 1 }),
        messageRow({ seq: 2, time: T0 + 2000, turn: 1, step: 1, outputTokens: 100 }),
        stepEndRow({ seq: 3, time: T0 + 2500, turn: 1, step: 1 }),
      ],
      [stepStartRow({ seq: 4, time: T0 + 3000, turn: 1, step: 2 })],
    ],
  });
  const run = await runProbeWithFixtureHome({ homeDir });
  try {
    assert.equal(run.exitCode, PROBE_EXIT_CODES.ok, run.lines.join("\n"));
    const { scanned, fields } = run.envelope;
    assert.equal(scanned.stepStartCount, 2);
    assert.equal(scanned.assistantMessageCount, 1);
    assert.equal(scanned.pairedCandidates, 1);
    assert.equal(scanned.unpairedCandidates, 1);
    assert.equal(scanned.uniqueIdentities, 1);
    assert.equal(scanned.eligible, 1);
    assert.equal(scanned.completeEvidenceCount, 1);
    assert.equal(scanned.sampled, 1);
    assert.equal(scanned.pending, 0, "孤立 start 不得把 pending 抬起来");
    assert.equal(scanned.dropped, 0);
    assert.equal(scanned.eligible, scanned.sampled + scanned.dropped + scanned.pending);
    assert.ok(scanned.dropped >= 0);
    assert.equal(fields.statusKind, "completed");
    assert.equal(fields.diagnosticReason, "none");
  } finally {
    run.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("跨会话：不同会话各自的孤立 start 不互相配对，也不互相影响分层", async () => {
  const homeDir = makeFixtureHome();
  // 会话 A：只有孤立 start（turn1/step1）。
  writeSessionFile(homeDir, {
    sessionId: "session-fixture-orphan",
    frames: [[sessionRow({ id: "session-fixture-orphan" })], [stepStartRow({ seq: 1, time: T0 + 1000 })]],
  });
  // 会话 B：同一个 (turn1,step1) 正常完成 —— 与 A 同身份键但不同会话，绝不可跨会话配对。
  writeSessionFile(homeDir, {
    sessionId: "session-fixture-complete",
    frames: [
      [sessionRow({ id: "session-fixture-complete" })],
      [stepStartRow({ seq: 1, time: T0 + 1000 })],
      [messageRow({ seq: 2, time: T0 + 2000, outputTokens: 60 })],
      [stepEndRow({ seq: 3, time: T0 + 2500 })],
    ],
  });
  const run = await runProbeWithFixtureHome({ homeDir });
  try {
    assert.equal(run.exitCode, PROBE_EXIT_CODES.ok, run.lines.join("\n"));
    const { scanned, fields } = run.envelope;
    assert.equal(scanned.filesScanned, 2);
    assert.equal(scanned.sessionHeaderCount, 2);
    assert.equal(scanned.stepStartCount, 2);
    assert.equal(scanned.assistantMessageCount, 1);
    assert.equal(scanned.duplicateStartFrames, 0, "两个 (1,1) 分属不同会话，不得并成同身份重复");
    assert.equal(scanned.pairedCandidates, 1);
    assert.equal(scanned.unpairedCandidates, 1);
    assert.equal(scanned.uniqueIdentities, 1);
    assert.equal(scanned.eligible, 1);
    assert.equal(scanned.completeEvidenceCount, 1);
    assert.equal(scanned.sampled, 1);
    assert.equal(scanned.pending, 0);
    assert.equal(scanned.dropped, 0);
    assert.ok(scanned.dropped >= 0);
    assert.equal(fields.statusKind, "completed");
  } finally {
    run.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 代理身份语义

test("delegationDepth 只证 subagent：depth>0 给 subagent，depth=0 不得反推 main", async () => {
  const subagentHome = makeFixtureHome();
  writeSessionFile(subagentHome, {
    frames: [
      [sessionRow({ delegationDepth: 1, agentPreset: "explore" })],
      [stepStartRow({ seq: 1, time: T0 + 1000 }), messageRow({ seq: 2, time: T0 + 2000, outputTokens: 12 })],
    ],
  });
  const subagent = await runProbeWithFixtureHome({ homeDir: subagentHome });
  try {
    assert.equal(subagent.exitCode, PROBE_EXIT_CODES.ok);
    assert.equal(subagent.envelope.fields.agentKind, "subagent");
    assert.equal(subagent.envelope.fields.agentKindMapping, "explicit_subagent_flag");
    assert.equal(subagent.envelope.fields.agentRoleProvenance, "delegation_depth");
    assert.equal(subagent.envelope.fields.agentNameEvidence, "agent_preset");
  } finally {
    subagent.cleanup();
    rmSync(subagentHome, { recursive: true, force: true });
  }

  const mainHome = makeFixtureHome();
  writeSessionFile(mainHome, {
    frames: [
      [sessionRow({ delegationDepth: 0 })],
      [stepStartRow({ seq: 1, time: T0 + 1000 }), messageRow({ seq: 2, time: T0 + 2000, outputTokens: 12 })],
    ],
  });
  const main = await runProbeWithFixtureHome({ homeDir: mainHome });
  try {
    assert.equal(main.exitCode, PROBE_EXIT_CODES.ok);
    assert.equal(main.envelope.fields.agentKind, "unknown", "depth=0 不是 main 的证据");
    assert.notEqual(main.envelope.fields.agentKind, "main");
  } finally {
    main.cleanup();
    rmSync(mainHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 有界与全量

function writeManyRowHome(fileCount, rowsPerFile) {
  const homeDir = makeFixtureHome();
  for (let index = 0; index < fileCount; index += 1) {
    const rows = [sessionRow({ id: `session-fixture-${String(index).padStart(4, "0")}` })];
    for (let row = 0; row < rowsPerFile; row += 1) {
      const turn = index + 1;
      const step = row + 1;
      const at = T0 + row * 1000;
      rows.push(stepStartRow({ seq: 1, time: at, turn, step }));
      rows.push(messageRow({ seq: 2, time: at + 500, turn, step, outputTokens: 10 + row }));
    }
    writeSessionFile(homeDir, {
      sessionId: `session-fixture-${String(index).padStart(4, "0")}`,
      frames: [rows],
    });
  }
  return homeDir;
}

test("有界探测：文件按首尾取样，行预算截断并明确置位", async () => {
  const homeDir = writeManyRowHome(5, 10);
  // 行预算够扫完首尾两个文件（每个 21 行：1 会话头 + 10 对），但文件仍有 3 个未扫描。
  const wide = await runProbeWithFixtureHome({ homeDir, argvExtra: ["--max-files", "2", "--max-rows", "60"] });
  try {
    assert.equal(wide.exitCode, PROBE_EXIT_CODES.ok);
    const { scanned, fields, decisions } = wide.envelope;
    assert.equal(scanned.filesDiscovered, 5);
    assert.equal(scanned.filesScanned, 2, "首尾各取一半");
    assert.equal(scanned.bounded, true);
    assert.equal(scanned.truncated, true, "有文件未扫描即非完整来源");
    assert.equal(scanned.complete, false);
    assert.equal(scanned.truncatedCount, 0, "该次没有行级截断");
    assert.equal(fields.coverageState, "degraded");
    assert.equal(decisions.full, false);
    assert.equal(decisions.maxFiles, 2);
    // 首尾文件都被扫到了：turn 1 与 turn 5 都应出现
    assert.equal(fields.turnCount, 2);
  } finally {
    wide.cleanup();
  }
  // 行预算不足以扫完一个文件：行级截断、filesScanned 只算实际扫到的文件。
  const narrow = await runProbeWithFixtureHome({ homeDir, argvExtra: ["--max-files", "2", "--max-rows", "6"] });
  try {
    assert.equal(narrow.exitCode, PROBE_EXIT_CODES.ok);
    const { scanned, decisions } = narrow.envelope;
    assert.equal(scanned.filesDiscovered, 5);
    assert.equal(scanned.filesScanned, 1);
    assert.equal(scanned.rowsScanned, 6);
    assert.ok(scanned.rowsRead >= 6);
    assert.ok(scanned.truncatedCount > 0);
    assert.equal(scanned.capped, true);
    assert.equal(scanned.complete, false);
    assert.equal(decisions.maxRows, 6);
  } finally {
    narrow.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("--full：已发现文件全部扫描，计数自洽且结果合格", async () => {
  const homeDir = writeManyRowHome(2, 3);
  const run = await runProbeWithFixtureHome({ homeDir, argvExtra: ["--full"] });
  try {
    assert.equal(run.exitCode, PROBE_EXIT_CODES.ok);
    const { scanned, decisions } = run.envelope;
    assert.equal(scanned.filesDiscovered, 2);
    assert.equal(scanned.filesScanned, 2);
    assert.equal(scanned.bounded, false);
    assert.equal(scanned.truncated, false);
    assert.equal(scanned.complete, true);
    assert.equal(decisions.full, true);
    assert.equal(decisions.maxFiles, null);
    assert.equal(decisions.fullScanRequested, true);
    assert.equal(run.envelope.fields.coverageState, "ready");
  } finally {
    run.cleanup();
    rmSync(homeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 无来源

test("没有任何 DSH 来源：files=0 必须带编码原因，不伪造样本", async () => {
  const emptyHome = mkdtempSync(path.join(os.tmpdir(), "perf-probe-dsh-empty-"));
  const run = await runProbeWithFixtureHome({ homeDir: emptyHome });
  try {
    assert.equal(run.exitCode, PROBE_EXIT_CODES.ok);
    const { scanned, warnings } = run.envelope;
    assert.equal(scanned.files, 0);
    assert.equal(scanned.rowsScanned, 0);
    assert.equal(run.envelope.status, "ok");
    assert.ok(warnings.some((entry) => entry.code === "NO_SOURCE_FILES"));
  } finally {
    run.cleanup();
    rmSync(emptyHome, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- 跨进程接线

function runDriveScript({ root, validationRoot, argv, env }) {
  const script = [
    `import { runPerfProbe } from ${JSON.stringify(pathToFileURL(PROBE_SCRIPT).href)};`,
    `process.exitCode = await runPerfProbe(${JSON.stringify(argv)}, { outputRoot: ${JSON.stringify(validationRoot)} });`,
  ].join("\n");
  const scriptFile = path.join(root, "drive.mjs");
  writeFileSync(scriptFile, `${script}\n`, "utf8");
  // spawnSync 与 execFileSync 不同：非零退出下仍返回 stdout/status。
  const result = spawnSync(process.execPath, [scriptFile], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  if (result.error) throw result.error;
  return { exitCode: result.status ?? 1, stdout: String(result.stdout || ""), stderr: String(result.stderr || "") };
}

test("跨进程真实 CLI 接线：pathToFileURL 驱动、产物无正文哨兵、非零退出可取 stdout", () => {
  const homeDir = writeMainFixtureHome();
  const root = mkdtempSync(path.join(os.tmpdir(), "perf-probe-dsh-drive-"));
  const validationRoot = path.join(root, "validation");
  const runDirectory = path.join(validationRoot, "2026-10-04-perf-metrics", "testrun");
  const profile = path.join(root, "empty-profile");
  mkdirSync(profile, { recursive: true });
  const env = {
    ...process.env,
    CODEX_USAGE_DSH_HOMES: homeDir,
    USERPROFILE: profile,
    HOME: profile,
    HOMEDRIVE: "",
    HOMEPATH: profile,
  };
  delete env.CODEX_USAGE_DSH;
  try {
    const ok = runDriveScript({
      root,
      validationRoot,
      argv: ["--source", "dsh", "--output", runDirectory],
      env,
    });
    assert.equal(ok.exitCode, PROBE_EXIT_CODES.ok, ok.stderr);
    const raw = readFileSync(path.join(runDirectory, "dsh-probe.json"), "utf8");
    const envelope = JSON.parse(raw);
    assert.equal(envelope.status, "ok");
    assert.equal(envelope.fields.streamAccessed, false);
    assert.equal(envelope.fields.contentAccessed, false);
    assert.equal(envelope.fields.stepEndAccessed, true, "step/end 判别式已读：终态证据所必需");
    for (const sentinel of [BODY_SENTINEL, STREAM_SENTINEL, STEP_END_SENTINEL]) {
      assert.equal(raw.includes(sentinel), false);
    }

    const bad = runDriveScript({
      root,
      validationRoot,
      argv: ["--source", "nope", "--output", runDirectory],
      env,
    });
    assert.equal(bad.exitCode, PROBE_EXIT_CODES.usage);
    assert.match(bad.stdout, /INVALID_SOURCE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
