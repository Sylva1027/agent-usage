// Claude Code generation TPS reader 的合成夹具验收。
//
// 本文件只断言 raw 候选，不运行真实转录。旧 prompt 锚点只作为历史事实，
// 不再参与候选准入或 TPS 分母。
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
  T0,
  assistantRow,
  promptRow,
  withClaudeFile,
  withClaudeFiles,
  ZERO_AND_SYNTHETIC,
} from "../test-support/claude-perf-fixture.mjs";

/** 本 reader 的 raw 候选键名。 */
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

async function collect(filePath, source, options = {}) {
  const samples = [];
  const warnings = [];
  const result = await streamClaudePerfSamples(filePath, source, (sample) => samples.push(sample), {
    ...options,
    onWarning: (warning) => warnings.push(warning),
  });
  return { ...result, samples, warnings };
}

function assertIdentity({ stats, samples }) {
  assert.equal(
    stats.candidates,
    samples.length + stats.skippedZeroUsage,
    "candidates 必须等于 emitted + skippedZeroUsage",
  );
  assert.equal(stats.skippedNoAnchor, 0, "prompt 锚点不再参与准入");
}

function withKnownThinking(row, tokens) {
  row.message.usage.output_tokens_details = { thinking_tokens: tokens };
  return row;
}

test("v3：同一 message.id 聚合为请求候选；旧 prompt E2E 不进入 duration", async () => {
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
    assert.equal(sample.timingKind, "generation");
    assert.equal(sample.timingSource, "unknown");
    assert.equal(sample.tokenScope, "non_reasoning_output");
    assert.equal(sample.modelEvidence, "request_scope");
    assert.equal(sample.requestCount, 1);
    assert.equal(sample.modelProvider, "");
    assert.equal(sample.outputTokens, null, "thinking known 位缺失时不得把总 output 冒充非推理 output");
    assert.equal(sample.inputTokens, DEDUPE.expected.sample.inputTokens);
    assert.equal(sample.tsMs, DEDUPE.expected.sample.tsMs);
    assert.equal(sample.durationMs, null);
    assert.equal(sample.windowStartMs, null);
    assert.equal(sample.windowEndMs, null);
    assert.equal(sample.status, "completed");
    assert.equal(sample.agentKind, "main");
    assert.equal(sample.model, "deepseek-flash");
  });
});

test("v3：最终 output 与 thinking 必须取自同一行", async () => {
  const rows = [
    promptRow(T0),
    withKnownThinking(assistantRow({ ts: T0 + 1000, messageId: "msg-paired", outputTokens: 100 }), 20),
    withKnownThinking(
      assistantRow({ ts: T0 + 2000, messageId: "msg-paired", outputTokens: 140, stopReason: "end_turn" }),
      90,
    ),
  ];
  await withClaudeFile(rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    const [sample] = result.samples;
    assert.equal(sample.outputTokens, 50, "必须计算 140 - 90；不能拼成 140 - 20 或 max(output)-max(thinking)");
    assert.equal(sample.durationMs, null);
  });
});

test("v3：精确 lookup 查询携带原始总 output 与 known reasoning，并只消费 generation", async () => {
  const rows = [
    promptRow(T0),
    withKnownThinking(
      assistantRow({ ts: T0 + 2000, messageId: "msg-lookup", outputTokens: 140, stopReason: "end_turn" }),
      90,
    ),
  ];
  await withClaudeFile(rows, async ({ files, source }) => {
    const queries = [];
    const result = await collect(files[0], source, {
      lookupRequestTiming(query) {
        queries.push(query);
        return {
          state: "available",
          requestedModel: "deepseek-flash",
          reportedOutputTokens: 140,
          durationMs: 9999,
          generation: {
            outputTokens: 80,
            durationMs: 400,
            startOutputTokens: 1,
            timingKind: "first_last_output",
          },
        };
      },
    });

    assert.deepEqual(queries, [
      {
        homeId: HOME_ID,
        responseId: "msg-lookup",
        model: "deepseek-flash",
        outputTokens: 140,
        reasoningOutputTokens: 90,
      },
    ]);
    const [sample] = result.samples;
    assert.equal(sample.outputTokens, 79);
    assert.equal(sample.durationMs, 400);
    assert.equal(sample.timingSource, "explicit");
  });
});

test("v3：reasoning known 位缺失时查询传 null；lookup 缺失/异常/不匹配仍保留候选", async () => {
  await withClaudeFile(
    [promptRow(T0), assistantRow({ ts: T0 + 1000, messageId: "msg-missing-timing", outputTokens: 40 })],
    async ({ files, source }) => {
      const queries = [];
      const result = await collect(files[0], source, {
        lookupRequestTiming(query) {
          queries.push(query);
          throw new Error("timing unavailable");
        },
      });
      assert.equal(queries[0].outputTokens, 40);
      assert.equal(queries[0].reasoningOutputTokens, null);
      assert.equal(result.samples.length, 1);
      assert.equal(result.samples[0].outputTokens, null);
      assert.equal(result.samples[0].durationMs, null);
      assert.equal(result.samples[0].timingSource, "unknown");
    },
  );
});

test("v3：lookup 返回格式错误的 generation 时安全退化为缺失，不丢候选", async () => {
  await withClaudeFile(
    [
      promptRow(T0),
      withKnownThinking(
        assistantRow({ ts: T0 + 1000, messageId: "msg-bad-generation", outputTokens: 60, stopReason: "end_turn" }),
        10,
      ),
    ],
    async ({ files, source }) => {
      const result = await collect(files[0], source, {
        lookupRequestTiming() {
          return {
            state: "available",
            requestedModel: "deepseek-flash",
            reportedOutputTokens: 60,
            generation: { outputTokens: 60, durationMs: 0, startOutputTokens: 0, timingKind: "explicit" },
          };
        },
      });
      assert.equal(result.samples.length, 1);
      assert.equal(result.samples[0].outputTokens, 50);
      assert.equal(result.samples[0].durationMs, null);
      assert.equal(result.samples[0].timingSource, "unknown");
    },
  );
});

test("v3：陈旧 prompt/同轮续写不再丢消息", async () => {
  await withClaudeFile(STALE_ANCHOR.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    assertIdentity(result);
    assert.equal(result.samples.length, 1);
    assert.equal(result.samples[0].messageId, "msg-continuation");
    assert.equal(result.samples[0].durationMs, null);
    assert.notEqual(result.samples[0].durationMs, STALE_ANCHOR.expected.assistantAnchorDurationMs);
    assert.notEqual(result.samples[0].durationMs, STALE_ANCHOR.expected.oldPromptDurationMs);
  });
});

test("v3：没有 prompt 也产出候选；文件顺序不再影响准入", async () => {
  await withClaudeFile(NO_PROMPT.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    assert.equal(result.samples.length, 1);
    assert.equal(result.samples[0].messageId, "msg-no-prompt");
    assert.equal(result.samples[0].durationMs, null);
  });

  await withClaudeFile(FILE_ORDER.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    assert.deepEqual(
      result.samples.map((sample) => sample.messageId),
      ["msg-previous", "msg-fileorder"],
    );
    assert.ok(result.samples.every((sample) => sample.durationMs === null));
  });
});

test("零用量与 <synthetic>：不产出零占位或 synthetic 候选", async () => {
  await withClaudeFile(ZERO_AND_SYNTHETIC.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    assertIdentity(result);
    assert.equal(result.samples.length, 0);
    assert.equal(result.stats.candidates, 1);
    assert.equal(result.stats.skippedZeroUsage, 1);
    assert.equal(result.stats.skippedNoAnchor, 0);
  });
});

test("子代理路径与 isSidechain 保留", async () => {
  await withClaudeFiles([SUBAGENT, SUBAGENT_PATH_ONLY, SIDECHAIN_IN_MAIN], async ({ files, source }) => {
    const [subagent, pathOnly, sidechainMain] = await Promise.all(files.map((file) => collect(file, source)));

    assert.equal(subagent.samples.length, 1);
    assert.equal(subagent.samples[0].messageId, SUBAGENT.expected.sample.messageId);
    assert.equal(subagent.samples[0].sessionId, SUBAGENT.expected.sample.sessionId);
    assert.equal(subagent.samples[0].agentKind, "subagent");
    assert.equal(subagent.samples[0].agent, SUBAGENT.expected.sample.agent);
    assert.equal(subagent.samples[0].reasoningEffort, SUBAGENT.expected.sample.reasoningEffort);
    assert.equal(subagent.samples[0].durationMs, null);
    assert.equal(pathOnly.samples[0].agentKind, "subagent");
    assert.equal(sidechainMain.samples[0].agentKind, "subagent");
  });
});

test("坏 JSON 与缺 message.id 仍只发既定 warning，合法消息保留", async () => {
  await withClaudeFile(MALFORMED_UNKEYABLE.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    assertIdentity(result);
    assert.equal(result.stats.malformedLines, MALFORMED_UNKEYABLE.expected.malformedLines);
    assert.equal(result.stats.missingMessageId, MALFORMED_UNKEYABLE.expected.missingMessageId);
    assert.equal(result.samples.length, 1);
    assert.equal(result.samples[0].messageId, "msg-real");
    assert.equal(result.samples[0].tsMs, MALFORMED_UNKEYABLE.expected.sample.tsMs);
    assert.equal(result.samples[0].durationMs, null);
    assert.deepEqual(
      result.warnings.map(({ sourceKind, code, count }) => ({ sourceKind, code, count })),
      MALFORMED_UNKEYABLE.expected.warnings,
    );
  });
});

test("attachment 与倒退时间只保留为历史事实，不形成 E2E 速度", async () => {
  await withClaudeFile(ATTACHMENT_ANCHOR.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    assert.equal(result.samples.length, 1);
    assert.equal(result.samples[0].durationMs, null);
  });

  await withClaudeFile(BACKWARD_ATTACHMENT.rows, async ({ files, source }) => {
    const result = await collect(files[0], source);
    assert.equal(result.samples.length, 1);
    assert.equal(result.samples[0].durationMs, null);
    assert.notEqual(result.samples[0].durationMs, BACKWARD_ATTACHMENT.expected.latestRowAnchorDurationMs);
  });
});

test("reader 边界：空文件零计数；读取失败向上抛", async () => {
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
