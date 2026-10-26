// W1：WorkBuddy 适配器（`src/workbuddy-usage.js`）的验收。
//
// 夹具全部**手写**（不调用被测函数生成期望值），逐条对应实施计划 §3 W1 的必测清单。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WORKBUDDY_CHANNEL,
  parseWorkbuddySessions,
  streamWorkbuddySessionEvents,
  workbuddyGenerationSpans,
  workbuddyHomeLooksUsable,
  workbuddySessionFiles,
} from "../src/workbuddy-usage.js";
import { USAGE_DETAIL_MASK } from "../public/usage-fields.js";

const HOME = { id: "workbuddy-test", label: "Main WorkBuddy", path: "/home/.workbuddy-ai" };
const SESSION_ID = "21201ca7-ac0f-4672-9745-084a3dfeb70d";

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

/**
 * 一条带用量的 `function_call` 记录（真实形状的最小化）。
 * @param {Record<string, any>} [overrides]
 */
function usageRow(overrides = {}) {
  const providerUsage = {
    requests: 1,
    inputTokens: 1000,
    outputTokens: 200,
    totalTokens: 1200,
    inputTokensDetails: [{ cached_tokens: 400 }],
    outputTokensDetails: [{ reasoning_tokens: 50 }],
    ...(overrides.providerUsage || {}),
  };
  const providerData = {
    messageId: "msg-1",
    model: "deepseek-v4.1-flash",
    requestModelName: "Deepseek-V4.1-Flash",
    rawUsage: { cache_creation_input_tokens: 0 },
    ...(overrides.providerData || {}),
    usage: providerUsage,
  };
  return {
    id: "record-1",
    timestamp: 1792537466382,
    type: "function_call",
    providerData,
    sessionId: SESSION_ID,
    cwd: "e:\\12 AI\\ccusage\\codex-usage",
    message: { usage: { input_tokens: 1000, output_tokens: 200, total_tokens: 1200 } },
    ...(overrides.record || {}),
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "workbuddy-usage-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function collect(filePath, options = {}) {
  const events = [];
  await streamWorkbuddySessionEvents(filePath, HOME, (event) => events.push(event), options);
  return events;
}

test("同一 messageId 的 5 条记录里只有 1 条带 usage ⇒ 1 个事件", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "session.jsonl");
    const rows = [
      usageRow({ providerData: { messageId: "shared" } }),
      { ...usageRow({ providerData: { messageId: "shared" } }), providerData: { messageId: "shared" } },
      { ...usageRow({ providerData: { messageId: "shared" } }), providerData: { messageId: "shared" } },
      { ...usageRow({ providerData: { messageId: "shared" } }), providerData: { messageId: "shared" } },
      { ...usageRow({ providerData: { messageId: "shared" } }), providerData: { messageId: "shared" } },
    ];
    // 后 4 条**不带** usage，模拟"一次响应只有一条记录挂用量"。
    for (const row of rows.slice(1)) delete row.providerData.usage;
    await writeFile(file, jsonl(rows));
    const events = await collect(file);
    assert.equal(events.length, 1);
    assert.equal(events[0].messageId, "shared");
  });
});

test("重复的 messageId 即使都带 usage 也只产一次", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "session.jsonl");
    await writeFile(file, jsonl([usageRow(), usageRow()]));
    const events = await collect(file);
    assert.equal(events.length, 1);
  });
});

test("Auto 记录整体排除，同文件的非 Auto 记录不受影响", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "session.jsonl");
    await writeFile(
      file,
      jsonl([
        usageRow({ providerData: { messageId: "auto-1", model: "default-model" } }),
        usageRow({
          providerData: { messageId: "auto-2", model: "deepseek-v4.1-flash", requestModelName: "Auto" },
        }),
        usageRow({ providerData: { messageId: "real-1" } }),
      ]),
    );
    const events = await collect(file);
    assert.deepEqual(
      events.map((event) => event.messageId),
      ["real-1"],
    );
  });
});

test("口径：input 已含缓存、total = input + output、三份冗余只取第一份", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "session.jsonl");
    await writeFile(file, jsonl([usageRow()]));
    const events = await collect(file);
    assert.equal(events.length, 1);
    const { usage, detailMask, requestInputTokens } = events[0];
    assert.equal(usage.input, 1000);
    assert.equal(usage.cached, 400);
    assert.ok(usage.input >= usage.cached);
    assert.equal(usage.output, 200);
    assert.equal(usage.reasoning, 50);
    assert.equal(usage.total, 1200);
    assert.equal(usage.total, usage.input + usage.output);
    assert.equal(detailMask, USAGE_DETAIL_MASK.complete);
    // 与 Claude 相反：input 本身就是请求侧总量。
    assert.equal(requestInputTokens, 1000);
  });
});

test("改第二份 usage（rawUsage）的值不改变输出", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "session.jsonl");
    await writeFile(
      file,
      jsonl([
        usageRow({
          providerData: {
            rawUsage: { prompt_tokens: 999999, completion_tokens: 888888, cache_creation_input_tokens: 0 },
          },
          record: { message: { usage: { input_tokens: 777777, output_tokens: 666666, total_tokens: 1 } } },
        }),
      ]),
    );
    const [event] = await collect(file);
    assert.equal(event.usage.input, 1000);
    assert.equal(event.usage.output, 200);
    assert.equal(event.usage.total, 1200);
  });
});

test("reasoning_tokens 缺失 ⇒ detailMask 去掉 bit8", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "session.jsonl");
    await writeFile(file, jsonl([usageRow({ providerUsage: { outputTokensDetails: [{}] } })]));
    const [event] = await collect(file);
    assert.equal(event.usage.reasoning, 0);
    assert.equal(event.detailMask, USAGE_DETAIL_MASK.complete & ~USAGE_DETAIL_MASK.reasoning);
  });
});

test("file-history-snapshot 即使带 providerData.usage 也不产事件（类型白名单优先）", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "session.jsonl");
    await writeFile(file, jsonl([usageRow({ record: { type: "file-history-snapshot" } })]));
    assert.equal((await collect(file)).length, 0);
  });
});

test("末尾半行 JSON 不抛异常，前面的行照常产出", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, "session.jsonl");
    const text = jsonl([usageRow({ providerData: { messageId: "good-1" } })]);
    const truncated = JSON.stringify(usageRow({ providerData: { messageId: "bad-1" } })).slice(0, 40);
    await writeFile(file, `${text}${truncated}`);
    const warnings = [];
    const events = await collect(file, { onWarning: (warning) => warnings.push(warning) });
    assert.deepEqual(
      events.map((event) => event.messageId),
      ["good-1"],
    );
    assert.ok(warnings.some((warning) => warning.startsWith("WORKBUDDY_MALFORMED_JSON:1")));
  });
});

test("cwd 缺失 ⇒ project 为 Unknown cwd；sessionId 缺失回退文件名", async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, `${SESSION_ID}.jsonl`);
    const row = usageRow();
    delete row.cwd;
    delete row.sessionId;
    await writeFile(file, jsonl([row]));
    const [event] = await collect(file);
    assert.equal(event.project, "Unknown cwd");
    assert.equal(event.sessionId, SESSION_ID);
    assert.equal(event.channel, WORKBUDDY_CHANNEL);
  });
});

test("空文件与只有 session-meta 的文件 ⇒ 0 事件、无异常", async () => {
  await withTempDir(async (dir) => {
    const empty = path.join(dir, "empty.jsonl");
    const meta = path.join(dir, "meta.jsonl");
    await writeFile(empty, "");
    await writeFile(meta, jsonl([{ type: "session-meta", sessionId: SESSION_ID }]));
    assert.equal((await collect(empty)).length, 0);
    assert.equal((await collect(meta)).length, 0);
  });
});

test("parseWorkbuddySessions 按 sessionId 汇总", async () => {
  await withTempDir(async (dir) => {
    const projectDir = path.join(dir, "projects", "slug");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "a.jsonl"),
      jsonl([usageRow({ providerData: { messageId: "m-1" } }), usageRow({ providerData: { messageId: "m-2" } })]),
    );
    const parsed = await parseWorkbuddySessions(dir, HOME);
    assert.equal(parsed.events.length, 2);
    assert.equal(parsed.sessions.length, 1);
    assert.equal(parsed.sessions[0].eventCount, 2);
    assert.equal(parsed.sessions[0].total.total, 2400);
  });
});

test("workbuddyHomeLooksUsable：真夹具 true / 纯 Claude 结构 false / 空目录 false", async () => {
  await withTempDir(async (dir) => {
    const workbuddy = path.join(dir, "workbuddy");
    await mkdir(path.join(workbuddy, "projects", "slug"), { recursive: true });
    await writeFile(path.join(workbuddy, "projects", "slug", "s.jsonl"), jsonl([{ type: "session-meta" }]));
    assert.equal(await workbuddyHomeLooksUsable(workbuddy), true);

    const claude = path.join(dir, "claude");
    await mkdir(path.join(claude, "projects", "slug"), { recursive: true });
    await writeFile(
      path.join(claude, "projects", "slug", "s.jsonl"),
      jsonl([{ type: "assistant", message: { id: "x", usage: { input_tokens: 1 } } }]),
    );
    assert.equal(await workbuddyHomeLooksUsable(claude), false);

    const empty = path.join(dir, "empty");
    await mkdir(empty, { recursive: true });
    assert.equal(await workbuddyHomeLooksUsable(empty), false);
  });
});

test("workbuddySessionFiles 不返回 tool-results/**", async () => {
  await withTempDir(async (dir) => {
    const projectDir = path.join(dir, "projects", "slug");
    const toolResults = path.join(projectDir, SESSION_ID, "tool-results");
    await mkdir(toolResults, { recursive: true });
    await writeFile(path.join(projectDir, "a.jsonl"), jsonl([{ type: "session-meta" }]));
    await writeFile(path.join(projectDir, SESSION_ID, "sub.jsonl"), jsonl([{ type: "session-meta" }]));
    await writeFile(path.join(toolResults, "big.jsonl"), jsonl([{ type: "session-meta" }]));
    const files = await workbuddySessionFiles(dir);
    assert.deepEqual(files, [path.join(projectDir, SESSION_ID, "sub.jsonl"), path.join(projectDir, "a.jsonl")]);
  });
});

function traceRow(overrides = {}) {
  return {
    type: "span_end",
    span: {
      traceId: "trace_1",
      spanId: "span_1",
      name: "generation",
      type: "generation",
      startedAt: "2026-10-21T00:08:41.249Z",
      endedAt: "2026-10-21T00:08:56.704Z",
      duration: 15455,
      status: "ok",
      toolOutput: JSON.stringify([{ id: "msg-span-1", content: "hi" }]),
      ...(overrides.span || {}),
    },
    ...overrides.row,
  };
}

test("workbuddyGenerationSpans 只收 ok 的 generation span，并跳过坏 toolOutput/非正时长", async () => {
  await withTempDir(async (dir) => {
    const traceDir = path.join(dir, "traces", "102284");
    await mkdir(traceDir, { recursive: true });
    await writeFile(
      path.join(traceDir, "trace_a.jsonl"),
      jsonl([
        traceRow(),
        traceRow({ span: { toolOutput: JSON.stringify([{ id: "msg-cancelled" }]), status: "cancelled" } }),
        traceRow({ span: { toolOutput: "{not-json", duration: 5000 } }),
        traceRow({ span: { toolOutput: JSON.stringify([{ id: "msg-zero" }]), duration: 0 } }),
        traceRow({ span: { toolOutput: JSON.stringify([{ id: "msg-float" }]), duration: 12.5 } }),
        traceRow({ span: { toolOutput: JSON.stringify([{ id: "msg-span-2" }]), duration: 900 } }),
      ]),
    );
    const spans = await workbuddyGenerationSpans(dir);
    assert.deepEqual(
      spans.map((span) => span.messageId),
      ["msg-span-1", "msg-span-2"],
    );
    assert.equal(spans[0].durationMs, 15455);
    assert.equal(spans[0].endedAtMs, Date.parse("2026-10-21T00:08:56.704Z"));
  });
});

test("trace 解析保留重复同值/异值、跨文件与旧 span 形状，不在这里选值", async () => {
  await withTempDir(async (dir) => {
    const traceDir = path.join(dir, "traces", "102284");
    await mkdir(traceDir, { recursive: true });
    const endedAtMs = Date.parse("2026-10-21T00:08:56.704Z");

    // 先写 b 再写 a：结果必须由文件路径排序决定，而不是创建/导入顺序。
    await writeFile(
      path.join(traceDir, "trace_b.jsonl"),
      jsonl([
        traceRow({ span: { toolOutput: JSON.stringify([{ id: "msg-cross" }]), duration: 900 } }),
        traceRow({
          span: {
            type: "generation",
            status: "ok",
            duration: 700,
            toolOutput: JSON.stringify([{ id: "msg-old-shape" }]),
          },
        }),
      ]),
    );
    await writeFile(
      path.join(traceDir, "trace_a.jsonl"),
      jsonl([
        traceRow({ span: { toolOutput: JSON.stringify([{ id: "msg-same" }]), duration: 900 } }),
        traceRow({ span: { toolOutput: JSON.stringify([{ id: "msg-cross" }]), duration: 1100 } }),
        traceRow({ span: { toolOutput: JSON.stringify([{ id: "msg-conflict" }]), duration: 800 } }),
        traceRow({ span: { toolOutput: JSON.stringify([{ id: "msg-conflict" }]), duration: 850 } }),
      ]),
    );
    await writeFile(
      path.join(traceDir, "trace_c.jsonl"),
      jsonl([traceRow({ span: { toolOutput: JSON.stringify([{ id: "msg-same" }]), duration: 900 } })]),
    );

    const spans = await workbuddyGenerationSpans(dir);
    const byId = new Map();
    for (const span of spans) byId.set(span.messageId, [...(byId.get(span.messageId) ?? []), span]);

    assert.deepEqual(
      byId.get("msg-same").map((span) => [span.durationMs, span.endedAtMs]),
      [
        [900, endedAtMs],
        [900, endedAtMs],
      ],
      "同值重复全部保留，不能提前折叠",
    );
    assert.deepEqual(
      byId.get("msg-conflict").map((span) => span.durationMs),
      [800, 850],
      "异值冲突全部保留，不能先到先得",
    );
    assert.deepEqual(
      byId.get("msg-cross").map((span) => span.durationMs),
      [1100, 900],
      "跨文件重复按稳定路径顺序返回，两个成员都在",
    );
    assert.equal(byId.get("msg-old-shape")[0].durationMs, 700, "旧 span 缺 trace/start 元数据仍可解析");
  });
});

test("traces 目录不存在 ⇒ 空数组，不抛", async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await workbuddyGenerationSpans(dir), []);
  });
});
