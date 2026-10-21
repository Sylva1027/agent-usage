// R1：Claude Code TPS reader 的合成夹具验收。
//
// 本文件**只断言 raw 候选**，不 import `normalizePerfSample`、不依赖 K1 的内核改动：
// claude 还没进 `PERF_SOURCE_KINDS`，规范化会以 UNSUPPORTED_SOURCE_KIND 拒绝它。
// 夹具全部由 `test-support/claude-perf-fixture.mjs` 在 mkdtemp 临时目录里合成，不读真实转录。
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { streamClaudePerfSamples } from "../src/perf-sources/claude.js";
import {
  ATTACHMENT_ANCHOR,
  BACKWARD_ATTACHMENT,
  DEDUPE,
  FILE_ORDER,
  HOME_ID,
  MALFORMED_UNKEYABLE,
  NO_PROMPT,
  SIDECHAIN_IN_MAIN,
  STALE_ANCHOR,
  SUBAGENT,
  SUBAGENT_PATH_ONLY,
  withClaudeFile,
  withClaudeFiles,
  ZERO_AND_SYNTHETIC,
} from "../test-support/claude-perf-fixture.mjs";

/** C-2 冻结的 raw 候选键名（多一个少一个都算契约漂移）。 */
const RAW_KEYS = [
  "sourceKind",
  "homeId",
  "sourcePath",
  "identity",
  "messageId",
  "sessionId",
  "channel",
  "agentKind",
  "agent",
  "model",
  "modelProvider",
  "reasoningEffort",
  "modelEvidence",
  "window",
  "timingKind",
  "timingSource",
  "tokenScope",
  "status",
  "tsMs",
  "windowStartMs",
  "windowEndMs",
  "durationMs",
  "outputTokens",
  "inputTokens",
  "requestCount",
];

async function collect(filePath, source) {
  const samples = [];
  const warnings = [];
  const result = await streamClaudePerfSamples(filePath, source, (sample) => samples.push(sample), {
    onWarning: (warning) => warnings.push(warning),
  });
  return { ...result, samples, warnings };
}

/** C-1 恒等式：candidates === emitted + skippedZeroUsage + skippedNoAnchor。 */
function assertIdentity({ stats, samples }) {
  assert.equal(
    stats.candidates,
    samples.length + stats.skippedZeroUsage + stats.skippedNoAnchor,
    "candidates 必须等于 emitted + skippedZeroUsage + skippedNoAnchor",
  );
}

test("R1 去重：同一 message.id 三行（首行零用量占位）只产出 1 个样本", async () => {
  await withClaudeFile(DEDUPE.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);

    assert.equal(result.state, "enabled");
    assert.deepEqual(result.stats, {
      candidates: 1,
      skippedZeroUsage: 0,
      skippedNoAnchor: 0,
      missingMessageId: 0,
      malformedLines: 0,
    });
    assertIdentity(result);
    assert.equal(result.samples.length, 1);

    const [sample] = result.samples;
    assert.deepEqual(Object.keys(sample).sort(), [...RAW_KEYS].sort());
    assert.deepEqual(sample.identity, ["msg-dedupe"]);
    assert.equal(sample.messageId, "msg-dedupe");
    assert.equal(sample.sourceKind, "claude");
    assert.equal(sample.homeId, HOME_ID);
    assert.equal(sample.sourcePath, source.path);
    assert.equal(sample.channel, "claude");
    assert.equal(sample.window, "request");
    assert.equal(sample.timingKind, "request_e2e");
    assert.equal(sample.timingSource, "timestamp_fallback");
    assert.equal(sample.tokenScope, "reported_output_includes_reasoning");
    assert.equal(sample.modelEvidence, "request_scope");
    assert.equal(sample.requestCount, 1);
    assert.equal(sample.modelProvider, "");

    // output 取最大（250，不在末行）；input 取最佳行的输入超集（900+20+5）。
    assert.equal(sample.outputTokens, DEDUPE.expected.sample.outputTokens);
    assert.equal(sample.inputTokens, DEDUPE.expected.sample.inputTokens);
    // duration 取末行 − 锚点，而不是首行或最佳行。
    assert.equal(sample.windowStartMs, DEDUPE.expected.sample.windowStartMs);
    assert.equal(sample.windowEndMs, DEDUPE.expected.sample.windowEndMs);
    assert.equal(sample.tsMs, DEDUPE.expected.sample.tsMs);
    assert.equal(sample.durationMs, DEDUPE.expected.sample.durationMs);
    assert.equal(sample.status, "completed");
    assert.equal(sample.agentKind, "main");
    assert.equal(sample.model, "deepseek-flash");
  });
});

test("R1 文件顺序：时间倒退的 attachment 行不能让锚点回退", async () => {
  await withClaudeFile(BACKWARD_ATTACHMENT.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    assertIdentity(result);
    assert.equal(result.samples.length, 1);

    const [sample] = result.samples;
    // 运行最大值的 prompt 行是 T0+10000 的 user；后出现的 T0+5000 attachment 不得覆盖它。
    assert.equal(sample.windowStartMs, BACKWARD_ATTACHMENT.expected.sample.windowStartMs);
    assert.equal(sample.durationMs, BACKWARD_ATTACHMENT.expected.sample.durationMs);
    assert.notEqual(sample.durationMs, BACKWARD_ATTACHMENT.expected.latestRowAnchorDurationMs);
  });
});

test("R1 文件顺序：不按时间排序（排序会把结果从 2 条改成 1 条）", async () => {
  await withClaudeFile(FILE_ORDER.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    assertIdentity(result);
    assert.equal(result.samples.length, FILE_ORDER.expected.fileOrderSamples.length);
    assert.notEqual(result.samples.length, FILE_ORDER.expected.sortedSamples);

    const byId = new Map(result.samples.map((sample) => [sample.messageId, sample]));
    for (const expected of FILE_ORDER.expected.fileOrderSamples) {
      const sample = byId.get(expected.messageId);
      assert.ok(sample, `missing sample ${expected.messageId}`);
      assert.equal(sample.windowStartMs, expected.windowStartMs);
      assert.equal(sample.durationMs, expected.durationMs);
    }
  });
});

test("R1 锚点陈旧：同轮续写 0 样本、skippedNoAnchor = 1，且既非 6,306 也非 9,693 ms", async () => {
  await withClaudeFile(STALE_ANCHOR.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    assertIdentity(result);

    assert.equal(result.samples.length, STALE_ANCHOR.expected.emitted);
    assert.equal(result.stats.candidates, STALE_ANCHOR.expected.candidates);
    assert.equal(result.stats.skippedNoAnchor, STALE_ANCHOR.expected.skippedNoAnchor);
    assert.equal(result.stats.skippedZeroUsage, STALE_ANCHOR.expected.skippedZeroUsage);

    // 两个反事实时长都不得出现在输出里：不许拿旧 prompt 计时，也不许拿 assistant 占位行补锚点。
    const durations = result.samples.map((sample) => sample.durationMs);
    assert.ok(!durations.includes(STALE_ANCHOR.expected.assistantAnchorDurationMs));
    assert.ok(!durations.includes(STALE_ANCHOR.expected.oldPromptDurationMs));
  });
});

test("R1 零用量与 <synthetic>：不产出样本，synthetic 不计候选", async () => {
  await withClaudeFile(ZERO_AND_SYNTHETIC.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    assertIdentity(result);

    assert.equal(result.samples.length, ZERO_AND_SYNTHETIC.expected.emitted);
    assert.equal(result.stats.candidates, ZERO_AND_SYNTHETIC.expected.candidates);
    assert.equal(result.stats.skippedZeroUsage, ZERO_AND_SYNTHETIC.expected.skippedZeroUsage);
    assert.equal(result.stats.skippedNoAnchor, ZERO_AND_SYNTHETIC.expected.skippedNoAnchor);
    assert.ok(!result.samples.some((sample) => sample.messageId === ZERO_AND_SYNTHETIC.expected.ignoredMessageId));
    assert.deepEqual(result.warnings, []);
  });
});

test("R1 子代理：subagents 路径与 isSidechain 任一命中即 subagent", async () => {
  await withClaudeFiles([SUBAGENT, SUBAGENT_PATH_ONLY, SIDECHAIN_IN_MAIN], async ({ files, source }) => {
    const [subagent, pathOnly, sidechainMain] = await Promise.all(files.map((file) => collect(file, source)));

    assert.equal(subagent.samples.length, 1);
    const [sample] = subagent.samples;
    assert.equal(sample.messageId, SUBAGENT.expected.sample.messageId);
    assert.equal(sample.sessionId, SUBAGENT.expected.sample.sessionId);
    assert.equal(sample.agentKind, SUBAGENT.expected.sample.agentKind);
    assert.equal(sample.agent, SUBAGENT.expected.sample.agent);
    assert.equal(sample.reasoningEffort, SUBAGENT.expected.sample.reasoningEffort);
    assert.equal(sample.durationMs, SUBAGENT.expected.sample.durationMs);

    // 路径在 subagents/ 下即可判 subagent，即使行上没有 isSidechain。
    assert.equal(pathOnly.samples[0].agentKind, SUBAGENT_PATH_ONLY.expected.agentKind);

    // 行上 isSidechain === true 即可判 subagent，即使文件在主转录目录。
    assert.equal(sidechainMain.samples[0].agentKind, SIDECHAIN_IN_MAIN.expected.agentKind);
  });
});

test("R1 告警：坏 JSON 与缺 message.id 只发 MALFORMED_JSON / UNKEYABLE_RECORD", async () => {
  await withClaudeFile(MALFORMED_UNKEYABLE.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    assertIdentity(result);

    assert.equal(result.stats.malformedLines, MALFORMED_UNKEYABLE.expected.malformedLines);
    assert.equal(result.stats.missingMessageId, MALFORMED_UNKEYABLE.expected.missingMessageId);
    assert.equal(result.samples.length, 1);

    const [sample] = result.samples;
    // 同 sessionId 但没有 message.id 的行不得被并入 msg-real（output / lastTs 保持不变）。
    assert.equal(sample.messageId, "msg-real");
    assert.equal(sample.outputTokens, MALFORMED_UNKEYABLE.expected.sample.outputTokens);
    assert.equal(sample.tsMs, MALFORMED_UNKEYABLE.expected.sample.tsMs);
    assert.equal(sample.durationMs, MALFORMED_UNKEYABLE.expected.sample.durationMs);

    assert.deepEqual(
      result.warnings.map(({ sourceKind, code, count }) => ({ sourceKind, code, count })),
      MALFORMED_UNKEYABLE.expected.warnings,
    );
    for (const warning of result.warnings) {
      assert.equal(warning.homeId, HOME_ID);
      assert.equal(typeof warning.code, "string");
      assert.equal(typeof warning.count, "number");
    }
  });
});

test("R1 锚点：没有 prompt 行 ⇒ skippedNoAnchor；attachment-only 锚点正常产出", async () => {
  await withClaudeFile(NO_PROMPT.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    assertIdentity(result);
    assert.equal(result.samples.length, NO_PROMPT.expected.emitted);
    assert.equal(result.stats.candidates, NO_PROMPT.expected.candidates);
    assert.equal(result.stats.skippedNoAnchor, NO_PROMPT.expected.skippedNoAnchor);
    assert.equal(result.stats.skippedZeroUsage, NO_PROMPT.expected.skippedZeroUsage);
  });

  await withClaudeFile(ATTACHMENT_ANCHOR.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    assertIdentity(result);
    assert.equal(result.samples.length, 1);
    const [sample] = result.samples;
    assert.equal(sample.windowStartMs, ATTACHMENT_ANCHOR.expected.sample.windowStartMs);
    assert.equal(sample.durationMs, ATTACHMENT_ANCHOR.expected.sample.durationMs);
    assert.equal(sample.outputTokens, ATTACHMENT_ANCHOR.expected.sample.outputTokens);
  });
});

test("R1 reader 边界：空文件零计数；读取失败向上抛而不是吞掉", async () => {
  await withClaudeFile([], async ({ files, root, source }) => {
    const result = await collect(files[0], source);
    assert.deepEqual(result.stats, {
      candidates: 0,
      skippedZeroUsage: 0,
      skippedNoAnchor: 0,
      missingMessageId: 0,
      malformedLines: 0,
    });
    assert.deepEqual(result.samples, []);
    assert.deepEqual(result.warnings, []);

    await assert.rejects(() => streamClaudePerfSamples(path.join(root, "missing.jsonl"), source, () => {}), /ENOENT/);
  });
});
