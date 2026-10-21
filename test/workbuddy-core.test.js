// C1-C3：WorkBuddy 接线（分类、发现、指纹、内存路径、分派）的验收。
//
// 夹具手写，逐条对应实施计划 §4 的必测清单。回归断言（纯 Claude / 纯 Codex 仍判原类型）
// 是本文件的一半价值：证明新增判据没有抢走既有来源。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildUsageFingerprint,
  buildUsageIndex,
  buildUsageReport,
  classifyImportDirectory,
  discoverUsageSources,
  streamUsageFileEvents,
} from "../src/usage-core.js";
import { describeImportEntry } from "../src/server.js";

const SESSION_ID = "21201ca7-ac0f-4672-9745-084a3dfeb70d";

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function usageRecord(overrides = {}) {
  return {
    id: "record-1",
    timestamp: 1792537466382,
    type: "function_call",
    providerData: {
      messageId: overrides.messageId || "msg-1",
      model: overrides.model || "deepseek-v4.1-flash",
      requestModelName: overrides.requestModelName || "Deepseek-V4.1-Flash",
      usage: {
        requests: 1,
        inputTokens: overrides.inputTokens ?? 1000,
        outputTokens: overrides.outputTokens ?? 200,
        totalTokens: (overrides.inputTokens ?? 1000) + (overrides.outputTokens ?? 200),
        inputTokensDetails: [{ cached_tokens: 400 }],
        outputTokensDetails: [{ reasoning_tokens: 50 }],
      },
    },
    sessionId: SESSION_ID,
    cwd: "e:\\12 AI\\ccusage\\codex-usage",
  };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "workbuddy-core-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** 造一个 WorkBuddy home：`projects/<slug>/<sessionId>.jsonl`。 */
async function makeWorkbuddyHome(dir, { name = ".workbuddy-ai", rows } = {}) {
  const home = path.join(dir, name);
  const projectDir = path.join(home, "projects", "e-12-AI-ccusage-codex-usage");
  await mkdir(projectDir, { recursive: true });
  const records = rows || [usageRecord(), usageRecord({ messageId: "msg-2", inputTokens: 500, outputTokens: 100 })];
  await writeFile(path.join(projectDir, `${SESSION_ID}.jsonl`), jsonl(records));
  return home;
}

test("真 WorkBuddy 夹具判为 workbuddy-home", async () => {
  await withTempDir(async (dir) => {
    const home = await makeWorkbuddyHome(dir);
    const classified = await classifyImportDirectory(home);
    assert.equal(classified.type, "workbuddy-home");
    assert.equal(classified.path, home);
  });
});

test("删掉内容判据后不再是 workbuddy-home", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, "bare");
    const projectDir = path.join(home, "projects", "slug");
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, "s.jsonl"), jsonl([{ type: "assistant", message: { id: "x" } }]));
    const classified = await classifyImportDirectory(home);
    assert.notEqual(classified.type, "workbuddy-home");
  });
});

test("回归：纯 Claude home 仍判 claude-home", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, ".claude");
    const projectDir = path.join(home, "projects", "-work-demo");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "abc.jsonl"),
      jsonl([
        {
          type: "assistant",
          timestamp: "2026-10-19T20:00:00.000Z",
          sessionId: "s",
          message: { id: "m", model: "claude-sonnet-4-5", usage: { input_tokens: 10, output_tokens: 2 } },
        },
      ]),
    );
    assert.equal((await classifyImportDirectory(home)).type, "claude-home");
  });
});

test("回归：纯 Codex home 仍判 codex-home", async () => {
  await withTempDir(async (dir) => {
    const home = path.join(dir, ".codex");
    await mkdir(path.join(home, "sessions"), { recursive: true });
    await writeFile(path.join(home, "sessions", "rollout-x.jsonl"), jsonl([{ type: "session_meta" }]));
    assert.equal((await classifyImportDirectory(home)).type, "codex-home");
  });
});

test("CODEX_USAGE_WORKBUDDY=0 关闭发现；自定义 home 名仍被发现", async () => {
  await withTempDir(async (dir) => {
    const home = await makeWorkbuddyHome(dir, { name: "custom-wb-dir" });
    const discovered = await discoverUsageSources({
      homeDir: dir,
      env: { CODEX_USAGE_WORKBUDDY_HOMES: home },
      platform: "linux",
    });
    assert.equal(
      discovered.some((source) => source.kind === "workbuddy" && source.path === home),
      true,
      "自定义目录名也必须被发现（判据不是看名字）",
    );
    const disabled = await discoverUsageSources({
      homeDir: dir,
      env: { CODEX_USAGE_WORKBUDDY: "0", CODEX_USAGE_WORKBUDDY_HOMES: home },
      platform: "linux",
    });
    assert.equal(
      disabled.some((source) => source.kind === "workbuddy"),
      false,
    );
  });
});

test("默认位置 ~/.workbuddy-ai 被发现，label 为 Main WorkBuddy", async () => {
  await withTempDir(async (dir) => {
    const home = await makeWorkbuddyHome(dir);
    const discovered = await discoverUsageSources({ homeDir: dir, env: {}, platform: "linux" });
    const entry = discovered.find((source) => source.kind === "workbuddy");
    assert.ok(entry);
    assert.equal(entry.path, home);
    assert.equal(entry.label, "Main WorkBuddy");
    assert.match(entry.id, /^workbuddy-[0-9a-f]{16}$/);
  });
});

test("CODEX_USAGE_WORKBUDDY_HOMES 追加自定义路径", async () => {
  await withTempDir(async (dir) => {
    const home = await makeWorkbuddyHome(dir, { name: "elsewhere" });
    const discovered = await discoverUsageSources({
      homeDir: path.join(dir, "nohome"),
      env: { CODEX_USAGE_WORKBUDDY_HOMES: home },
      platform: "linux",
    });
    const entry = discovered.find((source) => source.kind === "workbuddy");
    assert.ok(entry);
    assert.equal(entry.label, "WorkBuddy elsewhere");
  });
});

test("describeImportEntry 给出 WorkBuddy <name> 标签", async () => {
  await withTempDir(async (dir) => {
    const home = await makeWorkbuddyHome(dir);
    const described = await describeImportEntry(home);
    assert.equal(described.type, "workbuddy-home");
    assert.equal(described.label, `WorkBuddy ${path.basename(home)}`);
  });
});

test("指纹：追加 1 字节会变，touch 也会变", async () => {
  await withTempDir(async (dir) => {
    const home = await makeWorkbuddyHome(dir);
    const homes = [{ id: "workbuddy:test", label: "Main WorkBuddy", path: home, kind: "workbuddy" }];
    const first = await buildUsageFingerprint({ homes });
    assert.equal(first.fileCount, 1);

    const file = path.join(home, "projects", "e-12-AI-ccusage-codex-usage", `${SESSION_ID}.jsonl`);
    await writeFile(file, jsonl([usageRecord()]));
    const second = await buildUsageFingerprint({ homes });
    assert.notEqual(second.fingerprint, first.fingerprint);

    const later = new Date(Date.now() + 5000);
    await utimes(file, later, later);
    const third = await buildUsageFingerprint({ homes });
    assert.notEqual(third.fingerprint, second.fingerprint);
  });
});

test("内存路径（buildUsageIndex / buildUsageReport）能产出事件，且与解析器口径一致", async () => {
  await withTempDir(async (dir) => {
    const home = await makeWorkbuddyHome(dir);
    const homes = [{ id: "workbuddy:test", label: "Main WorkBuddy", path: home, kind: "workbuddy" }];
    const index = await buildUsageIndex({ homes });
    assert.equal(index.events.length, 2);
    assert.equal(index.sessionCount, 1);
    const total = index.events.reduce((sum, event) => sum + event.total, 0);
    assert.equal(total, 1800);
    assert.equal(index.strings[index.events[0].c], "WorkBuddy");

    const report = await buildUsageReport({ homes });
    assert.equal(report.events.length, 2);
    assert.equal(report.sessions.length, 1);
    assert.equal(report.sessions[0].total.total, 1800);
    assert.equal(report.events[0].channel, "WorkBuddy");
  });
});

test("单个文件损坏不中断其它文件，warning 带上该路径", async () => {
  await withTempDir(async (dir) => {
    const home = await makeWorkbuddyHome(dir);
    const projectDir = path.join(home, "projects", "e-12-AI-ccusage-codex-usage");
    const broken = path.join(projectDir, "broken.jsonl");
    // 截断 + 非法 JSON 行：解析器必须只记一条 warning 并继续，不能中断整个 home。
    await writeFile(broken, '{"type":"function_call","providerData":\n{"broken\n');
    const homes = [{ id: "workbuddy:test", label: "Main WorkBuddy", path: home, kind: "workbuddy" }];
    const index = await buildUsageIndex({ homes });
    assert.equal(index.events.length, 2);
    assert.ok(index.warnings.some((warning) => warning.includes(broken)));
  });
});

test("streamUsageFileEvents 把 workbuddy 分派给 WorkBuddy 解析器", async () => {
  await withTempDir(async (dir) => {
    const home = await makeWorkbuddyHome(dir);
    const file = path.join(home, "projects", "e-12-AI-ccusage-codex-usage", `${SESSION_ID}.jsonl`);
    const events = [];
    await streamUsageFileEvents(
      file,
      { id: "workbuddy:test", label: "Main WorkBuddy", path: home, kind: "workbuddy" },
      (event) => events.push(event),
    );
    assert.equal(events.length, 2);
    assert.equal(events[0].channel, "WorkBuddy");
    assert.equal(events[0].messageId, "msg-1");
  });
});

test("未知 kind 仍落到 Codex 兜底（不被 workbuddy 分支吃掉）", async () => {
  await withTempDir(async (dir) => {
    const home = await makeWorkbuddyHome(dir);
    const file = path.join(home, "projects", "e-12-AI-ccusage-codex-usage", `${SESSION_ID}.jsonl`);
    const events = [];
    await streamUsageFileEvents(file, { id: "x", label: "x", path: home, kind: "unknown-kind" }, (event) =>
      events.push(event),
    );
    // Codex 兜底不认识这些记录 ⇒ 0 事件（关键是**没有**走 WorkBuddy 解析器）。
    assert.equal(events.length, 0);
  });
});
