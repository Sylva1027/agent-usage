// WorkBuddy generation TPS reader 的直接验收。
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PERF_METHOD_VERSION,
  PERF_SOURCE_KINDS,
  canonicalPerfSourceKind,
  normalizePerfSample,
} from "../src/perf-stats.js";
import { enabledPerfSourceKinds, isPerfSourceEnabled, streamPerfSamplesForFile } from "../src/perf-sources/index.js";
import { streamWorkbuddyPerfSamples } from "../src/perf-sources/workbuddy.js";

const HOME = { id: "workbuddy-home-1", label: "Main WorkBuddy", path: "/home/.workbuddy-ai" };
const SESSION_ID = "21201ca7-ac0f-4672-9745-084a3dfeb70d";

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function usageRecord({
  messageId = "msg-1",
  inputTokens = 1000,
  outputTokens = 200,
  reasoningTokens = 10,
  includeReasoning = true,
  model = "deepseek-v4.1-flash",
} = {}) {
  const outputTokensDetails = includeReasoning ? [{ reasoning_tokens: reasoningTokens }] : [];
  return {
    timestamp: 1792537466382,
    type: "function_call",
    providerData: {
      messageId,
      model,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        inputTokensDetails: [{ cached_tokens: 0 }],
        outputTokensDetails,
      },
    },
    sessionId: SESSION_ID,
    cwd: "/work/demo",
  };
}

async function withSessionFile(rows, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "perf-workbuddy-"));
  try {
    const file = path.join(dir, "session.jsonl");
    await writeFile(file, jsonl(rows));
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("规范 kind 与 v5 来源语义", () => {
  assert.equal(canonicalPerfSourceKind("workbuddy"), "workbuddy");
  assert.deepEqual([...PERF_SOURCE_KINDS], ["zcode", "dsh", "opencode", "codex", "workbuddy", "claude"]);

  const { sample } = normalizePerfSample({
    sourceKind: "workbuddy",
    homeId: "home-1",
    messageId: "msg-1",
    tsMs: 1792537466382,
    outputTokens: 190,
    inputTokens: 1000,
    durationMs: 15455,
    status: "completed",
    timingSource: "explicit",
    agentKind: "main",
  });
  assert.ok(sample);
  assert.equal(sample.window, "request");
  assert.equal(sample.timingKind, "generation");
  assert.equal(sample.tokenScope, "non_reasoning_output");
  assert.equal(sample.methodVersion, PERF_METHOD_VERSION);
  assert.equal(sample.sampleKey, JSON.stringify(["workbuddy", "home-1", "msg-1"]));
});

test("自定义 timingSource / methodVersion 仍按既有规则告警", () => {
  const result = normalizePerfSample({
    sourceKind: "workbuddy",
    homeId: "home-1",
    messageId: "msg-1",
    tsMs: 1792537466382,
    outputTokens: 190,
    durationMs: 1000,
    status: "completed",
    timingSource: "workbuddy.trace.generation",
    methodVersion: "workbuddy.generation.v1",
  });
  assert.equal(result.sample.timingSource, "unknown");
  assert.equal(result.sample.methodVersion, "workbuddy.generation.v1");
  assert.ok(result.warnings.includes("UNRECOGNIZED_PROVENANCE"));
  assert.ok(result.warnings.includes("UNRECOGNIZED_METHOD_VERSION"));
});

test("trace generation duration 与整批 output counter 只保留诊断，不进入生成 TPS", async () => {
  await withSessionFile([usageRecord()], async (file) => {
    const samples = [];
    const result = await streamWorkbuddyPerfSamples(file, HOME, (sample) => samples.push(sample), {
      lookupGenerationDuration: (messageId) => (messageId === "msg-1" ? { durationMs: 15455, endedAtMs: 1 } : null),
    });
    assert.equal(result.state, "enabled");
    assert.equal(samples.length, 1);
    assert.equal(samples[0].sampleKey, undefined);
    assert.equal(samples[0].messageId, "msg-1");
    assert.equal(samples[0].outputTokens, null, "没有首批 token offset，整批 output 不能作为窗口分子");
    assert.equal(samples[0].reportedOutputTokens, 200);
    assert.equal(samples[0].reportedReasoningTokens, 10);
    assert.equal(samples[0].inputTokens, 1000);
    assert.equal(samples[0].durationMs, null);
    assert.equal(samples[0].reportedDurationMs, 15455);
    assert.equal(samples[0].timingSource, "unknown");
    assert.equal(samples[0].window, "request");
    assert.equal(samples[0].timingKind, "generation");
    assert.equal(samples[0].tokenScope, "non_reasoning_output");
    assert.equal(result.stats.candidates, 1);
    assert.equal(result.stats.skippedNoDuration, 0);
    assert.equal(result.stats.missingGenerationDuration, 1);
  });
});

test("无 lookup 也产出候选；reasoning known 位缺失时不猜非推理 output", async () => {
  await withSessionFile([usageRecord({ includeReasoning: false })], async (file) => {
    const samples = [];
    const result = await streamWorkbuddyPerfSamples(file, HOME, (sample) => samples.push(sample), {});
    assert.equal(samples.length, 1);
    assert.equal(samples[0].outputTokens, null);
    assert.equal(samples[0].reportedOutputTokens, 200);
    assert.equal(samples[0].reportedReasoningTokens, null);
    assert.equal(samples[0].durationMs, null);
    assert.equal(result.stats.candidates, 1);
    assert.equal(result.stats.missingGenerationDuration, 1);
  });
});

test("同一 messageId 只产一个候选", async () => {
  await withSessionFile([usageRecord(), usageRecord()], async (file) => {
    const samples = [];
    const result = await streamWorkbuddyPerfSamples(file, HOME, (sample) => samples.push(sample));
    assert.equal(samples.length, 1);
    assert.equal(result.stats.candidates, 1);
  });
});

test("原始 output 真 0 仍产候选，但可测 output 仍未知", async () => {
  await withSessionFile([usageRecord({ outputTokens: 0, reasoningTokens: 0 })], async (file) => {
    const samples = [];
    await streamWorkbuddyPerfSamples(file, HOME, (sample) => samples.push(sample));
    assert.equal(samples.length, 1);
    assert.equal(samples[0].outputTokens, null);
    assert.equal(samples[0].reportedOutputTokens, 0);
    assert.equal(samples[0].durationMs, null);
  });
});

test("Auto 事件在 reader 之前已被排除", async () => {
  await withSessionFile(
    [
      usageRecord({ messageId: "auto-1", model: "default-model" }),
      usageRecord({ messageId: "real-1" }),
      usageRecord({ messageId: "real-2" }),
    ],
    async (file) => {
      const samples = [];
      const result = await streamWorkbuddyPerfSamples(file, HOME, (sample) => samples.push(sample));
      assert.equal(result.stats.candidates, 2);
      assert.deepEqual(
        samples.map((sample) => sample.messageId),
        ["real-1", "real-2"],
      );
    },
  );
});

test("注册与透传：workbuddy 已启用，lookup 仍到达 reader 但旧 span duration 不采用", async () => {
  assert.equal(isPerfSourceEnabled("workbuddy"), true);
  assert.deepEqual(enabledPerfSourceKinds(), ["zcode", "dsh", "opencode", "codex", "workbuddy", "claude"]);
  assert.equal(isPerfSourceEnabled("unknown-kind"), false);

  await withSessionFile([usageRecord()], async (file) => {
    const seen = [];
    const samples = [];
    const result = await streamPerfSamplesForFile(
      file,
      { id: HOME.id, path: file, kind: "workbuddy", label: HOME.label },
      (sample) => samples.push(sample),
      {
        lookupGenerationDuration: (messageId) => {
          seen.push(messageId);
          return { durationMs: 1234 };
        },
      },
    );
    assert.equal(result.state, "enabled");
    assert.deepEqual(seen, ["msg-1"]);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].sampleKey, JSON.stringify(["workbuddy", HOME.id, "msg-1"]));
    assert.equal(samples[0].methodVersion, PERF_METHOD_VERSION);
    assert.equal(samples[0].outputTokens, null);
    assert.equal(samples[0].durationMs, null);
    assert.equal(samples[0].reportedDurationMs, undefined, "normalize 出口不保留私有诊断字段");
  });
});

test("未注册 kind 仍为 not_enabled", async () => {
  const result = await streamPerfSamplesForFile("/tmp/none", { kind: "project-log", id: "x" }, () => {});
  assert.equal(result.state, "unsupported");
  const unknown = await streamPerfSamplesForFile("/tmp/none", { kind: "nope", id: "x" }, () => {});
  assert.equal(unknown.state, "not_enabled");
});
