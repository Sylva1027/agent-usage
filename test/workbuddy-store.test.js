// S1-S4：WorkBuddy 索引（文件展开、v17 迁移、harness 桶、trace 预扫与时长注入）的验收。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { STORE_SCHEMA_VERSION, UsageStore } from "../src/usage-store.js";

const SESSION_A = "21201ca7-ac0f-4672-9745-084a3dfeb70d";
const SESSION_B = "bd7e6ac4-720f-4c77-8280-8d2687320b1a";

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function usageRecord(messageId, { outputTokens = 200 } = {}) {
  return {
    timestamp: 1792537466382,
    type: "function_call",
    providerData: {
      messageId,
      model: "deepseek-v4.1-flash",
      usage: {
        inputTokens: 1000,
        outputTokens,
        totalTokens: 1000 + outputTokens,
        inputTokensDetails: [{ cached_tokens: 0 }],
        outputTokensDetails: [{ reasoning_tokens: 10 }],
      },
    },
    sessionId: SESSION_A,
    cwd: "/work/demo",
  };
}

function traceRow(messageId, { duration = 15455, status = "ok", toolOutput } = {}) {
  return {
    type: "span_end",
    span: {
      traceId: "trace_1",
      spanId: "span_1",
      name: "generation",
      type: "generation",
      endedAt: "2026-10-21T00:08:56.704Z",
      duration,
      status,
      toolOutput: toolOutput === undefined ? JSON.stringify([{ id: messageId }]) : toolOutput,
    },
  };
}

async function withWorkspace(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "workbuddy-store-"));
  try {
    const home = path.join(root, ".workbuddy-ai");
    const projectDir = path.join(home, "projects", "slug");
    const traceDir = path.join(home, "traces", "102284");
    await mkdir(projectDir, { recursive: true });
    await mkdir(traceDir, { recursive: true });
    const options = { homeDir: root, env: {} };
    return await fn({ root, home, projectDir, traceDir, options, storeFile: path.join(root, "index.sqlite") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeSessions(projectDir, rowsBySession) {
  for (const [sessionId, rows] of Object.entries(rowsBySession)) {
    await writeFile(path.join(projectDir, `${sessionId}.jsonl`), jsonl(rows));
  }
}

async function writeTraces(traceDir, rows) {
  await writeFile(path.join(traceDir, "trace_a.jsonl"), jsonl(rows));
}

async function openStore(root, storeFile) {
  const store = new UsageStore({ homeDir: root, databaseFile: storeFile });
  await store.open();
  return store;
}

function countSamples(store) {
  return Number(
    store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples WHERE source_kind = 'workbuddy'").get().n || 0,
  );
}

function durationRows(store) {
  return store.database
    .prepare("SELECT message_id, duration_ms, capture_version FROM workbuddy_generation_durations ORDER BY message_id")
    .all()
    .map((row) => ({ ...row }));
}

test("S1：usageFiles 展开多个会话文件，不返回 tool-results/**", async () => {
  await withWorkspace(async ({ home, projectDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("m-1")], [SESSION_B]: [usageRecord("m-2")] });
    const toolResults = path.join(projectDir, SESSION_A, "tool-results");
    await mkdir(toolResults, { recursive: true });
    await writeFile(path.join(toolResults, "big.txt"), "x");

    const store = await openStore(options.homeDir, storeFile);
    try {
      const { files, failedHomes } = await store.usageFiles([
        { id: "workbuddy-1", label: "Main WorkBuddy", path: home, kind: "workbuddy" },
      ]);
      assert.equal(files.length, 2);
      assert.equal(failedHomes.length, 0);
      assert.equal(
        files.every((file) => file.filePath.endsWith(".jsonl")),
        true,
      );
      assert.equal(
        files.some((file) => file.filePath.includes("tool-results")),
        false,
      );
    } finally {
      store.close();
    }
  });
});

test("S1：目录不可读 ⇒ 进 failedHomes 且不抛", async () => {
  await withWorkspace(async ({ options, storeFile }) => {
    const store = await openStore(options.homeDir, storeFile);
    try {
      const { files, failedHomes } = await store.usageFiles([
        { id: "workbuddy-x", label: "WorkBuddy x", path: path.join(options.homeDir, "missing"), kind: "workbuddy" },
      ]);
      // 不存在的 home：projects 目录不存在 ⇒ 0 文件（不是失败），也不抛。
      assert.equal(files.length, 0);
      assert.equal(failedHomes.length, 0);
    } finally {
      store.close();
    }
  });
});

test("S2：全新库直接 v17 且时长表存在", async () => {
  await withWorkspace(async ({ options, storeFile }) => {
    const store = await openStore(options.homeDir, storeFile);
    try {
      assert.equal(STORE_SCHEMA_VERSION, 17);
      assert.equal(Number(store.database.prepare("PRAGMA user_version").get().user_version), 17);
      const table = store.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workbuddy_generation_durations'")
        .get();
      assert.ok(table);
    } finally {
      store.close();
    }
  });
});

test("S2：v16 真库升级到 v17，重复打开幂等", async () => {
  await withWorkspace(async ({ options, storeFile }) => {
    const store = await openStore(options.homeDir, storeFile);
    store.close();
    // 把库退回 v16 并删掉新表 ⇒ 模拟"本卡之前的真库"。
    const raw = new DatabaseSync(storeFile);
    raw.exec("DROP TABLE workbuddy_generation_durations; PRAGMA user_version = 16;");
    raw.close();

    const upgraded = await openStore(options.homeDir, storeFile);
    try {
      assert.equal(Number(upgraded.database.prepare("PRAGMA user_version").get().user_version), 17);
    } finally {
      upgraded.close();
    }
    const again = await openStore(options.homeDir, storeFile);
    try {
      assert.equal(Number(again.database.prepare("PRAGMA user_version").get().user_version), 17);
    } finally {
      again.close();
    }
  });
});

test("S2：迁移中途失败 ⇒ 回滚，user_version 仍 16", async () => {
  await withWorkspace(async ({ options, storeFile }) => {
    const store = await openStore(options.homeDir, storeFile);
    store.close();
    const raw = new DatabaseSync(storeFile);
    raw.exec("DROP TABLE workbuddy_generation_durations;");
    // 同名错形状表：`CREATE TABLE IF NOT EXISTS` 会静默通过 ⇒ 必须靠事务内自检拦下。
    raw.exec("CREATE TABLE workbuddy_generation_durations (message_id TEXT PRIMARY KEY, duration_ms INTEGER);");
    raw.exec("PRAGMA user_version = 16;");
    raw.close();

    await assert.rejects(
      () => openStore(options.homeDir, storeFile),
      /WORKBUDDY|列数|列 1|workbuddy_generation_durations/,
    );
    const check = new DatabaseSync(storeFile);
    try {
      assert.equal(Number(check.prepare("PRAGMA user_version").get().user_version), 16);
    } finally {
      check.close();
    }
  });
});

test("S3：channel=WorkBuddy 的模型进 WorkBuddy 桶，不进 Codex；空桶输出 []", async () => {
  await withWorkspace(async ({ projectDir, traceDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("m-1")] });
    await writeTraces(traceDir, [traceRow("m-1")]);
    const store = await openStore(options.homeDir, storeFile);
    try {
      await store.sync({ options });
      const metadata = store.metadata();
      assert.deepEqual(metadata.harnessModels.WorkBuddy, ["deepseek-v4.1-flash"]);
      assert.deepEqual(metadata.harnessModels.Codex, []);
      assert.deepEqual(metadata.harnessModels.Claude, []);
    } finally {
      store.close();
    }
  });
});

test("S4：会话文件变化 ⇒ 预扫一次；同轮第二个 WorkBuddy 文件不再触发", async () => {
  await withWorkspace(async ({ projectDir, traceDir, options, storeFile }) => {
    await writeSessions(projectDir, {
      [SESSION_A]: [usageRecord("m-1")],
      [SESSION_B]: [usageRecord("m-2")],
    });
    await writeTraces(traceDir, [traceRow("m-1"), traceRow("m-2")]);
    const store = await openStore(options.homeDir, storeFile);
    try {
      const outcomes = [];
      const original = store.refreshWorkbuddyDurations.bind(store);
      store.refreshWorkbuddyDurations = async (homePath, refreshOptions) => {
        const outcome = await original(homePath, refreshOptions);
        outcomes.push(outcome);
        return outcome;
      };
      await store.sync({ options });
      assert.equal(outcomes.length, 1, "两个会话文件共享同一份 trace ⇒ 每轮只预扫一次");
      assert.equal(outcomes[0].filesParsed, 1);
      assert.equal(durationRows(store).length, 2);
      assert.equal(countSamples(store), 2);
    } finally {
      store.close();
    }
  });
});

test("S4：会话文件未变化 ⇒ 不触发预扫", async () => {
  await withWorkspace(async ({ projectDir, traceDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("m-1")] });
    await writeTraces(traceDir, [traceRow("m-1")]);
    const store = await openStore(options.homeDir, storeFile);
    try {
      await store.sync({ options });
      let calls = 0;
      const original = store.refreshWorkbuddyDurations.bind(store);
      store.refreshWorkbuddyDurations = async (homePath, refreshOptions) => {
        calls += 1;
        return original(homePath, refreshOptions);
      };
      await store.sync({ options });
      assert.equal(calls, 0);
    } finally {
      store.close();
    }
  });
});

test("S4：trace 未变化 ⇒ 第二次触发不重解析", async () => {
  await withWorkspace(async ({ projectDir, traceDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("m-1")] });
    await writeTraces(traceDir, [traceRow("m-1")]);
    const store = await openStore(options.homeDir, storeFile);
    try {
      await store.sync({ options });
      const outcomes = [];
      const original = store.refreshWorkbuddyDurations.bind(store);
      store.refreshWorkbuddyDurations = async (homePath, refreshOptions) => {
        const outcome = await original(homePath, refreshOptions);
        outcomes.push(outcome);
        return outcome;
      };
      // 追加一条新响应 ⇒ 会话文件变化 ⇒ 触发预扫，但 trace 没变 ⇒ filesParsed = 0。
      await writeFile(path.join(projectDir, `${SESSION_A}.jsonl`), jsonl([usageRecord("m-1"), usageRecord("m-2")]));
      await store.sync({ options });
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].filesParsed, 0);
      assert.equal(durationRows(store).length, 1);
    } finally {
      store.close();
    }
  });
});

test("S4：删掉 trace 目录后重解析会话文件 ⇒ 样本数不变（表兜底）", async () => {
  await withWorkspace(async ({ projectDir, traceDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("m-1")] });
    await writeTraces(traceDir, [traceRow("m-1")]);
    const store = await openStore(options.homeDir, storeFile);
    try {
      await store.sync({ options });
      assert.equal(countSamples(store), 1);
      const before = store.database.prepare("SELECT sample_key, duration_ms FROM perf_samples").all();

      await rm(path.join(options.homeDir, ".workbuddy-ai", "traces"), { recursive: true, force: true });
      // 标脏：模拟"30 天后会话文件被重新解析"。
      store.database.exec("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind = 'workbuddy'");
      await store.sync({ options });

      assert.equal(countSamples(store), 1);
      assert.deepEqual(store.database.prepare("SELECT sample_key, duration_ms FROM perf_samples").all(), before);
    } finally {
      store.close();
    }
  });
});

test("S4：重解析幂等 —— 连续两次全量重解析，行数与值不变", async () => {
  await withWorkspace(async ({ projectDir, traceDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("m-1")] });
    await writeTraces(traceDir, [traceRow("m-1")]);
    const store = await openStore(options.homeDir, storeFile);
    try {
      await store.sync({ options });
      const first = store.database.prepare("SELECT * FROM perf_samples ORDER BY sample_key").all();
      const firstDurations = durationRows(store);

      store.database.exec("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind = 'workbuddy'");
      await store.sync({ options });
      store.database.exec("UPDATE source_files SET size = -1, mtime_ms = -1 WHERE kind = 'workbuddy'");
      await store.sync({ options });

      assert.deepEqual(store.database.prepare("SELECT * FROM perf_samples ORDER BY sample_key").all(), first);
      assert.deepEqual(durationRows(store), firstDurations);
    } finally {
      store.close();
    }
  });
});

test("S4：非 ok 的 span、坏 toolOutput、非正时长都不写表", async () => {
  await withWorkspace(async ({ projectDir, traceDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("m-ok")] });
    await writeTraces(traceDir, [
      traceRow("m-ok"),
      traceRow("m-cancelled", { status: "cancelled" }),
      traceRow("m-broken", { toolOutput: "{not-json" }),
      traceRow("m-zero", { duration: 0 }),
      traceRow("m-float", { duration: 12.5 }),
    ]);
    const store = await openStore(options.homeDir, storeFile);
    try {
      await store.sync({ options });
      assert.deepEqual(
        durationRows(store).map((row) => row.message_id),
        ["m-ok"],
      );
      assert.equal(durationRows(store)[0].capture_version, "workbuddy.trace.v1");
      assert.equal(countSamples(store), 1);
    } finally {
      store.close();
    }
  });
});

test("S4：traces 不可用（是普通文件）⇒ sync 不失败，无时长行，样本被跳过", async () => {
  await withWorkspace(async ({ home, projectDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("m-1")] });
    await rm(path.join(home, "traces"), { recursive: true, force: true });
    await writeFile(path.join(home, "traces"), "not a directory");
    const store = await openStore(options.homeDir, storeFile);
    try {
      const round = await store.sync({ options });
      assert.ok(round);
      assert.equal(durationRows(store).length, 0);
      assert.equal(countSamples(store), 0);
      assert.ok(
        store.warnings.some((warning) => warning.includes("缺少 generation 时长")),
        "缺时长必须如实告警",
      );
    } finally {
      store.close();
    }
  });
});
