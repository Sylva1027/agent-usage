import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claudeHomeLooksUsable,
  claudeSessionFiles,
  claudeSourceStat,
  claudeUsageFromRaw,
  parseClaudeSessions,
  streamClaudeSessionEvents,
} from "../src/claude-code-usage.js";
import { USAGE_DETAIL_INCONSISTENT, USAGE_DETAIL_MASK } from "../public/usage-fields.js";

const HOME = { id: "claude-test", label: "Main Claude Code", path: "/home/.claude" };

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

let messageSequence = 0;

/** @param {Record<string, any>} [overrides] */
function assistantRow(overrides = {}) {
  messageSequence += 1;
  const usage = {
    input_tokens: 100,
    cache_read_input_tokens: 900,
    cache_creation_input_tokens: 50,
    output_tokens: 20,
    ...(overrides.usage || {}),
  };
  const messageId = overrides.messageId === undefined ? `msg_${messageSequence}` : overrides.messageId;
  const { messageId: _ignored, model, usage: _usage, ...record } = overrides;
  return {
    type: "assistant",
    uuid: `uuid-${messageSequence}`,
    timestamp: "2026-10-19T20:00:00.000Z",
    sessionId: "session-a",
    cwd: "/work/project",
    version: "2.1.299",
    ...record,
    message: {
      ...(messageId === null ? {} : { id: messageId }),
      // 显式传空串表示"线路模型缺失"，不能被默认值掩盖。
      model: model === undefined ? "claude-sonnet-4-5-20250929" : model,
      usage,
    },
  };
}

async function makeClaudeHome({ sessions = [] } = {}) {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-usage-claude-"));
  const homePath = path.join(homeDir, ".claude");
  const projects = path.join(homePath, "projects");
  await mkdir(projects, { recursive: true });
  for (const session of sessions) {
    const projectDir = path.join(projects, session.project || "E--work-project");
    await mkdir(projectDir, { recursive: true });
    if (session.subagentRows) {
      const subagentsDir = path.join(projectDir, session.id, "subagents");
      await mkdir(subagentsDir, { recursive: true });
      await writeFile(path.join(subagentsDir, `agent-${session.agentId || "a1"}.jsonl`), jsonl(session.subagentRows));
      // 子代理目录里的大工具输出必须被忽略。
      await mkdir(path.join(projectDir, session.id, "tool-results"), { recursive: true });
      await writeFile(path.join(projectDir, session.id, "tool-results", "huge.txt"), "SENTINEL-TOOL-OUTPUT");
    }
    await writeFile(path.join(projectDir, `${session.id}.jsonl`), jsonl(session.rows || []));
  }
  return { homeDir, homePath };
}

async function collect(filePath, options = {}) {
  const events = [];
  const warnings = [];
  await streamClaudeSessionEvents(filePath, HOME, (event) => events.push(event), {
    ...options,
    onWarning: (warning) => warnings.push(warning),
  });
  return { events, warnings };
}

test("同一 message.id 的多个内容块只产生一个事件，取 token 最大的一条", async () => {
  const { homePath } = await makeClaudeHome({
    sessions: [
      {
        id: "session-a",
        rows: [
          assistantRow({ messageId: "msg_shared", usage: { input_tokens: 10, cache_read_input_tokens: 0 } }),
          assistantRow({ messageId: "msg_shared", usage: { input_tokens: 100, cache_read_input_tokens: 900 } }),
          assistantRow({ messageId: "msg_shared", usage: { input_tokens: 100, cache_read_input_tokens: 900 } }),
        ],
      },
    ],
  });
  const [file] = await claudeSessionFiles(homePath);
  const { events } = await collect(file);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventId, "msg_shared");
  assert.equal(events[0].usage.input, 1_050);
  assert.equal(events[0].usage.cached, 900);
  assert.equal(events[0].cacheWriteTokens, 50);
  assert.equal(events[0].usage.output, 20);
  assert.equal(events[0].usage.total, 1_070);
});

test("子代理转录被纳入，零用量占位块被真实块取代，渠道合并为 Claude Code", async () => {
  const { homePath } = await makeClaudeHome({
    sessions: [
      {
        id: "session-a",
        agentId: "agent-7",
        rows: [assistantRow({ messageId: "msg_main" })],
        subagentRows: [
          assistantRow({
            messageId: "msg_sub",
            sessionId: "session-a",
            isSidechain: true,
            agentId: "agent-7",
            usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
          }),
          assistantRow({
            messageId: "msg_sub",
            sessionId: "session-a",
            isSidechain: true,
            agentId: "agent-7",
            usage: { input_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 0, output_tokens: 3 },
          }),
        ],
      },
    ],
  });
  const files = await claudeSessionFiles(homePath);
  assert.equal(files.length, 2);
  const parsed = await parseClaudeSessions(homePath, HOME);
  assert.equal(parsed.events.length, 2);
  const subagent = parsed.events.find((event) => event.id === "msg_sub");
  assert.ok(subagent, "子代理事件必须存在");
  assert.equal(subagent.channel, "Claude Code");
  assert.equal(subagent.total.input, 12);
  assert.equal(subagent.total.output, 3);
  // 子代理使用父会话 id，会话数不虚增。
  assert.equal(parsed.sessions.length, 1);
  assert.equal(parsed.sessions[0].eventCount, 2);
});

test("并列输入计数重构成超集，明细校验不产生不一致位", async () => {
  const { usage, detailMask, cacheWrite } = claudeUsageFromRaw({
    input_tokens: 1_000,
    cache_read_input_tokens: 20_000,
    cache_creation_input_tokens: 4_000,
    output_tokens: 500,
    output_tokens_details: { thinking_tokens: 120 },
  });
  assert.deepEqual(usage, { total: 25_500, input: 25_000, cached: 20_000, output: 500, reasoning: 120 });
  assert.equal(cacheWrite.tokens, 4_000);
  assert.equal(cacheWrite.known, true);
  assert.equal(
    detailMask,
    USAGE_DETAIL_MASK.input |
      USAGE_DETAIL_MASK.cached |
      USAGE_DETAIL_MASK.output |
      USAGE_DETAIL_MASK.reasoning |
      USAGE_DETAIL_MASK.cacheWrite,
  );
  assert.equal(detailMask & USAGE_DETAIL_INCONSISTENT, 0);
});

test("零用量记录被跳过，模型身份取 message.model（线路模型），别名只在占位或缺失时回退", async () => {
  const { homePath } = await makeClaudeHome({
    sessions: [
      {
        id: "session-a",
        rows: [
          assistantRow({
            messageId: "msg_zero",
            usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
          }),
          // 网关路由名：requestedModel 是 mythos-magpie-*，线路模型才是真实上游模型。
          assistantRow({
            messageId: "msg_gateway",
            requestedModel: "mythos-magpie-3145220055",
            model: "deepseek-v4.1-flash",
          }),
          // harness 的 tier 别名（内置子代理的 model:"haiku"），线路模型仍是真实上游模型。
          assistantRow({ messageId: "msg_tier", requestedModel: "haiku", model: "deepseek-v4.1-flash" }),
          // <synthetic> 是本地生成的记录，不是模型响应 ⇒ 回退到 requestedModel。
          assistantRow({ messageId: "msg_synthetic", requestedModel: "claude-opus-4-5", model: "<synthetic>" }),
          // message.model 缺失 ⇒ 回退到 requestedModel。
          assistantRow({ messageId: "msg_fallback", requestedModel: "claude-haiku-4-5", model: "" }),
          // 两者都缺失 ⇒ Unknown model。
          assistantRow({ messageId: "msg_unknown", requestedModel: "", model: "" }),
        ],
      },
    ],
  });
  const [file] = await claudeSessionFiles(homePath);
  const { events } = await collect(file);
  assert.deepEqual(
    events.map((event) => [event.eventId, event.model]),
    [
      // 同一时间戳按 eventId 排序，因此这里同时钉住"身份"和"排序稳定"。
      ["msg_fallback", "claude-haiku-4-5"],
      ["msg_gateway", "deepseek-v4.1-flash"],
      ["msg_synthetic", "claude-opus-4-5"],
      ["msg_tier", "deepseek-v4.1-flash"],
      ["msg_unknown", "Unknown model"],
    ],
  );
});

test("speed=fast 映射为 fast 档，缺失时为 unknown", async () => {
  const { homePath } = await makeClaudeHome({
    sessions: [
      {
        id: "session-a",
        rows: [
          assistantRow({ messageId: "msg_fast", usage: { speed: "fast", service_tier: "standard" } }),
          assistantRow({ messageId: "msg_standard", usage: { service_tier: "standard" } }),
          assistantRow({ messageId: "msg_unknown", usage: { service_tier: "mystery" } }),
        ],
      },
    ],
  });
  const [file] = await claudeSessionFiles(homePath);
  const { events } = await collect(file);
  assert.deepEqual(
    events.map((event) => event.serviceTier),
    ["fast", "standard", "unknown"],
  );
});

test("坏行只告警不中断；乱序时间按时间排序输出", async () => {
  const { homePath } = await makeClaudeHome({
    sessions: [
      {
        id: "session-a",
        rows: [
          assistantRow({ messageId: "msg_late", timestamp: "2026-10-19T22:00:00.000Z" }),
          assistantRow({ messageId: "msg_early", timestamp: "2026-10-19T20:00:00.000Z" }),
        ],
      },
    ],
  });
  const [file] = await claudeSessionFiles(homePath);
  await writeFile(file, `${await readFile(file, "utf8")}{not json}\n`);
  const { events, warnings } = await collect(file);
  assert.deepEqual(
    events.map((event) => event.eventId),
    ["msg_early", "msg_late"],
  );
  assert.ok(warnings.some((warning) => warning.startsWith("CLAUDE_MALFORMED_JSON:1")));
});

test("标题取 custom-title / agent-name，缺失会话 id 时按文件告警", async () => {
  const { homePath } = await makeClaudeHome({
    sessions: [
      {
        id: "session-a",
        rows: [
          { type: "custom-title", customTitle: "修复登录流程", sessionId: "session-a" },
          assistantRow({ messageId: "msg_title" }),
          assistantRow({ messageId: null, uuid: "uuid-only" }),
        ],
      },
    ],
  });
  const [file] = await claudeSessionFiles(homePath);
  const { events, warnings } = await collect(file);
  assert.equal(events[0].conversationName, "修复登录流程");
  assert.ok(events.some((event) => event.eventId === "uuid-only"));
  assert.ok(warnings.some((warning) => warning.startsWith("CLAUDE_MISSING_MESSAGE_ID:1")));
});

test("claudeHomeLooksUsable 与文件发现跳过 tool-results", async () => {
  const { homePath } = await makeClaudeHome({
    sessions: [{ id: "session-a", rows: [assistantRow()], agentId: "a1", subagentRows: [assistantRow()] }],
  });
  assert.equal(await claudeHomeLooksUsable(homePath), true);
  const files = await claudeSessionFiles(homePath);
  assert.equal(files.length, 2);
  assert.ok(files.every((file) => !file.includes("tool-results")));
  assert.deepEqual(await claudeSessionFiles(path.join(homePath, "missing")), []);
  assert.equal(await claudeHomeLooksUsable(path.join(homePath, "missing")), false);
});

test("claudeSourceStat 返回文件 size 与 mtime", async () => {
  const { homePath } = await makeClaudeHome({ sessions: [{ id: "session-a", rows: [assistantRow()] }] });
  const [file] = await claudeSessionFiles(homePath);
  const info = await claudeSourceStat(file);
  assert.ok(info.size > 0);
  assert.ok(info.mtimeMs > 0);
});

test("空 home 与空转录不产生事件", async () => {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-usage-claude-empty-"));
  try {
    const parsed = await parseClaudeSessions(homeDir, HOME);
    assert.deepEqual(parsed, { sessions: [], events: [] });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
