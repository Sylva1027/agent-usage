// P1-P3：WorkBuddy TPS 语义、reader 与注册的验收。
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
  model = "deepseek-v4.1-flash",
} = {}) {
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
        outputTokensDetails: [{ reasoning_tokens: 10 }],
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

test("P1：workbuddy 的规范 kind、语义与 sampleKey 三元组", () => {
  assert.equal(canonicalPerfSourceKind("workbuddy"), "workbuddy");
  assert.deepEqual([...PERF_SOURCE_KINDS], ["zcode", "dsh", "opencode", "codex", "workbuddy"]);

  const { sample } = normalizePerfSample({
    sourceKind: "workbuddy",
    homeId: "home-1",
    messageId: "msg-1",
    tsMs: 1792537466382,
    outputTokens: 200,
    inputTokens: 1000,
    durationMs: 15455,
    status: "completed",
    timingSource: "explicit",
    agentKind: "main",
  });
  assert.ok(sample);
  assert.equal(sample.window, "request");
  assert.equal(sample.timingKind, "request_e2e");
  assert.equal(sample.tokenScope, "reported_output_includes_reasoning");
  assert.equal(sample.methodVersion, PERF_METHOD_VERSION);
  assert.equal(sample.sampleKey, JSON.stringify(["workbuddy", "home-1", "msg-1"]));
});

test("P1：自定义 timingSource / methodVersion 仍按既有规则告警，不被 WorkBuddy 特判绕过", () => {
  const result = normalizePerfSample({
    sourceKind: "workbuddy",
    homeId: "home-1",
    messageId: "msg-1",
    tsMs: 1792537466382,
    outputTokens: 200,
    durationMs: 1000,
    status: "completed",
    timingSource: "workbuddy.trace.generation",
    methodVersion: "workbuddy.generation.v1",
  });
  assert.equal(result.sample.timingSource, "unknown");
  // 既有规则：`methodVersion` 告警但**保留**调用方给的值（不静默改写），`timingSource` 才降级。
  assert.equal(result.sample.methodVersion, "workbuddy.generation.v1");
  assert.ok(result.warnings.includes("UNRECOGNIZED_PROVENANCE"));
  assert.ok(result.warnings.includes("UNRECOGNIZED_METHOD_VERSION"));
});

test("P2：有 duration ⇒ 产出候选，token 与时长与夹具一致", async () => {
  await withSessionFile([usageRecord()], async (file) => {
    const samples = [];
    const result = await streamWorkbuddyPerfSamples(file, HOME, (sample) => samples.push(sample), {
      lookupGenerationDuration: (messageId) => (messageId === "msg-1" ? { durationMs: 15455, endedAtMs: 1 } : null),
    });
    assert.equal(result.state, "enabled");
    assert.equal(samples.length, 1);
    assert.equal(samples[0].sampleKey, undefined, "raw 候选不带 sampleKey（由 normalize 计算）");
    assert.deepEqual(samples[0].messageId, "msg-1");
    assert.equal(samples[0].outputTokens, 200);
    assert.equal(samples[0].inputTokens, 1000);
    assert.equal(samples[0].durationMs, 15455);
    assert.equal(samples[0].timingSource, "explicit");
    assert.equal(samples[0].agentKind, "main");
    assert.equal(result.stats.candidates, 1);
    assert.equal(result.stats.skippedNoDuration, 0);
  });
});

test("P2：无 duration ⇒ 不产样本并计数；lookup 未提供也不抛", async () => {
  await withSessionFile([usageRecord()], async (file) => {
    const samples = [];
    const missing = await streamWorkbuddyPerfSamples(file, HOME, (sample) => samples.push(sample), {
      lookupGenerationDuration: () => null,
    });
    assert.equal(samples.length, 0);
    assert.equal(missing.stats.skippedNoDuration, 1);

    const absent = await streamWorkbuddyPerfSamples(file, HOME, (sample) => samples.push(sample), {});
    assert.equal(samples.length, 0);
    assert.equal(absent.stats.skippedNoDuration, 1);
  });
});

test("P2：同一 messageId 出现两次只产 1 个样本", async () => {
  await withSessionFile([usageRecord(), usageRecord()], async (file) => {
    const samples = [];
    const result = await streamWorkbuddyPerfSamples(file, HOME, (sample) => samples.push(sample), {
      lookupGenerationDuration: () => ({ durationMs: 900 }),
    });
    assert.equal(samples.length, 1);
    assert.equal(result.stats.candidates, 1);
  });
});

test("P2：outputTokens === 0 仍产候选（交给 perf-stats 的 OUTPUT_ZERO 规则）", async () => {
  await withSessionFile([usageRecord({ outputTokens: 0 })], async (file) => {
    const samples = [];
    await streamWorkbuddyPerfSamples(file, HOME, (sample) => samples.push(sample), {
      lookupGenerationDuration: () => ({ durationMs: 500 }),
    });
    assert.equal(samples.length, 1);
    assert.equal(samples[0].outputTokens, 0);
  });
});

test("P2：Auto 事件在 reader 之前已被排除", async () => {
  await withSessionFile(
    [
      usageRecord({ messageId: "auto-1", model: "default-model" }),
      usageRecord({ messageId: "real-1" }),
      usageRecord({ messageId: "real-2" }),
    ],
    async (file) => {
      const samples = [];
      const result = await streamWorkbuddyPerfSamples(file, HOME, (sample) => samples.push(sample), {
        lookupGenerationDuration: () => ({ durationMs: 1000 }),
      });
      assert.equal(result.stats.candidates, 2);
      assert.deepEqual(
        samples.map((sample) => sample.messageId),
        ["real-1", "real-2"],
      );
    },
  );
});

test("P3：注册与透传 —— workbuddy 已启用，lookupGenerationDuration 确实到达 reader", async () => {
  assert.equal(isPerfSourceEnabled("workbuddy"), true);
  assert.deepEqual(enabledPerfSourceKinds(), ["zcode", "dsh", "opencode", "codex", "workbuddy"]);
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
    // 归一化在集成层完成 ⇒ 出口样本已带 sampleKey 与方法版本。
    assert.equal(samples[0].sampleKey, JSON.stringify(["workbuddy", HOME.id, "msg-1"]));
    assert.equal(samples[0].methodVersion, PERF_METHOD_VERSION);
    assert.equal(samples[0].durationMs, 1234);
  });
});

test("P3：未注册 kind 仍为 not_enabled", async () => {
  const result = await streamPerfSamplesForFile("/tmp/none", { kind: "project-log", id: "x" }, () => {});
  assert.equal(result.state, "unsupported");
  const unknown = await streamPerfSamplesForFile("/tmp/none", { kind: "nope", id: "x" }, () => {});
  assert.equal(unknown.state, "not_enabled");
});
