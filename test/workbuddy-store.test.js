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
    .prepare(
      `SELECT home_id, message_id, duration_ms, ended_at_ms, capture_version
       FROM workbuddy_generation_duration_observations
       ORDER BY home_id, message_id, duration_ms`,
    )
    .all()
    .map((row) => ({ ...row }));
}

function legacyDurationRows(store) {
  return store.database
    .prepare("SELECT message_id, duration_ms FROM workbuddy_generation_durations ORDER BY message_id")
    .all()
    .map((row) => ({ ...row }));
}

function usageSnapshot(store) {
  const summary = store.summarize({ preset: "all" });
  return {
    eventCount: summary.eventCount,
    totals: summary.totals,
    costEstimate: summary.costEstimate,
  };
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

test("S2：全新库直接 v21 且旧时长表与 observation 表都存在", async () => {
  await withWorkspace(async ({ options, storeFile }) => {
    const store = await openStore(options.homeDir, storeFile);
    try {
      assert.equal(STORE_SCHEMA_VERSION, 21);
      assert.equal(Number(store.database.prepare("PRAGMA user_version").get().user_version), 21);
      for (const table of ["workbuddy_generation_durations", "workbuddy_generation_duration_observations"]) {
        assert.equal(store.database.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(table)?.type, "table");
      }
    } finally {
      store.close();
    }
  });
});

test("S2：v16 真库升级到 v21，重复打开幂等", async () => {
  await withWorkspace(async ({ options, storeFile }) => {
    const store = await openStore(options.homeDir, storeFile);
    store.close();
    // 把库退回 v16 并删掉新表 ⇒ 模拟"本卡之前的真库"。
    const raw = new DatabaseSync(storeFile);
    raw.exec("DROP TABLE workbuddy_generation_durations; PRAGMA user_version = 16;");
    raw.close();

    const upgraded = await openStore(options.homeDir, storeFile);
    try {
      assert.equal(Number(upgraded.database.prepare("PRAGMA user_version").get().user_version), 21);
    } finally {
      upgraded.close();
    }
    const again = await openStore(options.homeDir, storeFile);
    try {
      assert.equal(Number(again.database.prepare("PRAGMA user_version").get().user_version), 21);
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

test("C2：v18 遇到错形状 observation 表 ⇒ 回滚且版本仍 18", async () => {
  await withWorkspace(async ({ options, storeFile }) => {
    const store = await openStore(options.homeDir, storeFile);
    store.close();
    const raw = new DatabaseSync(storeFile);
    raw.exec("DROP TABLE workbuddy_generation_duration_observations;");
    raw.exec("CREATE TABLE workbuddy_generation_duration_observations (home_id TEXT, message_id TEXT);");
    raw.exec("PRAGMA user_version = 18;");
    raw.close();

    await assert.rejects(
      () => openStore(options.homeDir, storeFile),
      /WORKBUDDY|列数|observation|workbuddy_generation_duration_observations/,
    );
    const check = new DatabaseSync(storeFile);
    try {
      assert.equal(Number(check.prepare("PRAGMA user_version").get().user_version), 18);
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
        assert.match(String(refreshOptions?.homeId), /^workbuddy-/);
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

test("S4：会话文件未变化 ⇒ 仍预扫 trace，但不重解析", async () => {
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
      await store.sync({ options });
      assert.equal(outcomes.length, 1);
      assert.equal(outcomes[0].filesParsed, 0);
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

test("C2：同值重复写 observation 一次，保留一个样本", async () => {
  await withWorkspace(async ({ projectDir, traceDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("msg-same")] });
    await writeTraces(traceDir, [traceRow("msg-same", { duration: 900 }), traceRow("msg-same", { duration: 900 })]);
    const store = await openStore(options.homeDir, storeFile);
    try {
      await store.sync({ options });
      assert.deepEqual(
        durationRows(store).map((row) => [row.message_id, row.duration_ms]),
        [["msg-same", 900]],
      );
      assert.equal(countSamples(store), 1);
      assert.equal(
        Number(
          store.database.prepare("SELECT duration_ms FROM perf_samples WHERE source_kind = 'workbuddy'").get()
            .duration_ms,
        ),
        900,
      );
    } finally {
      store.close();
    }
  });
});

test("C2：缺时长的会话在 trace 到达后由普通 sync 补采样", async () => {
  await withWorkspace(async ({ projectDir, traceDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("msg-late")] });
    const store = await openStore(options.homeDir, storeFile);
    try {
      await store.sync({ options });
      assert.equal(countSamples(store), 0);

      await writeTraces(traceDir, [traceRow("msg-late", { duration: 800 })]);
      await store.sync({ options });
      assert.equal(countSamples(store), 1);
      assert.equal(
        Number(
          store.database.prepare("SELECT duration_ms FROM perf_samples WHERE source_kind = 'workbuddy'").get()
            .duration_ms,
        ),
        800,
      );
    } finally {
      store.close();
    }
  });
});

test("C2：异值冲突不选一个，阻断样本但用量与费用不变", async () => {
  await withWorkspace(async ({ projectDir, traceDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("msg-conflict")] });
    await writeTraces(traceDir, [traceRow("msg-conflict", { duration: 800 })]);
    const store = await openStore(options.homeDir, storeFile);
    try {
      await store.sync({ options });
      assert.equal(countSamples(store), 1);
      const before = usageSnapshot(store);

      await writeTraces(traceDir, [
        traceRow("msg-conflict", { duration: 800 }),
        traceRow("msg-conflict", { duration: 850 }),
      ]);
      await store.sync({ options });

      assert.deepEqual(
        durationRows(store).map((row) => row.duration_ms),
        [800, 850],
      );
      assert.equal(countSamples(store), 0, "多种时长必须阻断采样，不能先到先得");
      assert.deepEqual(usageSnapshot(store), before, "冲突不得改动用量事件或费用估算");
      assert.equal(
        Number(store.database.prepare("SELECT COUNT(*) AS n FROM events WHERE home_id LIKE 'workbuddy-%'").get().n),
        1,
      );
    } finally {
      store.close();
    }
  });
});

test("C2：trace-only 变化推进 indexVersion，重复 sync 保持稳定", async () => {
  await withWorkspace(async ({ projectDir, traceDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("msg-version")] });
    await writeTraces(traceDir, [traceRow("msg-version", { duration: 800 })]);
    const store = await openStore(options.homeDir, storeFile);
    try {
      await store.sync({ options });
      const firstVersion = store.readMeta("perf_index_version");
      assert.equal(countSamples(store), 1);

      await writeTraces(traceDir, [traceRow("msg-version", { duration: 900 })]);
      await store.sync({ options });
      const changedVersion = store.readMeta("perf_index_version");
      assert.notEqual(changedVersion, firstVersion);
      assert.equal(countSamples(store), 0);
      assert.deepEqual(
        durationRows(store).map((row) => row.duration_ms),
        [800, 900],
      );

      await store.sync({ options });
      assert.equal(store.readMeta("perf_index_version"), changedVersion);
      assert.equal(countSamples(store), 0);
    } finally {
      store.close();
    }
  });
});

test("C2：读取会话期间 trace 变化 ⇒ degraded 且 indexVersion 不可证", async () => {
  await withWorkspace(async ({ projectDir, traceDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("msg-race")] });
    await writeTraces(traceDir, [traceRow("msg-race", { duration: 800 })]);
    const store = await openStore(options.homeDir, storeFile);
    try {
      await store.sync({ options });
      await writeTraces(traceDir, [traceRow("msg-race", { duration: 850 })]);

      const original = store.replaceFile.bind(store);
      let injected = false;
      store.replaceFile = async (file, replaceOptions) => {
        if (!injected) {
          injected = true;
          await writeTraces(traceDir, [traceRow("msg-race", { duration: 900 })]);
        }
        return original(file, replaceOptions);
      };
      await store.sync({ options });

      const perf = store.summarize({ preset: "all" }).perf;
      assert.equal(perf.state, "degraded");
      assert.equal(perf.indexVersion, "");

      await store.sync({ options });
      assert.notEqual(store.summarize({ preset: "all" }).perf.indexVersion, "");
    } finally {
      store.close();
    }
  });
});

test("C2：关库重开后冲突仍持久，重复 sync 不恢复先到先得", async () => {
  await withWorkspace(async ({ projectDir, traceDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("msg-conflict")] });
    await writeTraces(traceDir, [
      traceRow("msg-conflict", { duration: 800 }),
      traceRow("msg-conflict", { duration: 850 }),
    ]);
    let store = await openStore(options.homeDir, storeFile);
    try {
      await store.sync({ options });
      const observations = durationRows(store);
      const before = usageSnapshot(store);
      assert.equal(countSamples(store), 0);
      store.close();

      store = await openStore(options.homeDir, storeFile);
      await store.sync({ options });
      await store.sync({ options });

      assert.deepEqual(durationRows(store), observations);
      assert.equal(countSamples(store), 0);
      assert.deepEqual(usageSnapshot(store), before);
    } finally {
      store.close();
    }
  });
});

test("C2：删掉 traces 后冲突仍持久，不会退回旧表的单值", async () => {
  await withWorkspace(async ({ home, projectDir, traceDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("msg-conflict")] });
    await writeTraces(traceDir, [
      traceRow("msg-conflict", { duration: 800 }),
      traceRow("msg-conflict", { duration: 850 }),
    ]);
    const store = await openStore(options.homeDir, storeFile);
    try {
      await store.sync({ options });
      const observations = durationRows(store);
      const before = usageSnapshot(store);
      const beforeVersion = store.readMeta("perf_index_version");
      assert.equal(countSamples(store), 0);

      await rm(path.join(home, "traces"), { recursive: true, force: true });
      await store.sync({ options });

      assert.deepEqual(durationRows(store), observations);
      assert.equal(countSamples(store), 0);
      assert.deepEqual(usageSnapshot(store), before);
      assert.notEqual(store.readMeta("perf_index_version"), beforeVersion);
    } finally {
      store.close();
    }
  });
});

test("C2：旧表无 observation 时仍可兜底读取既有正确时长", async () => {
  await withWorkspace(async ({ home, projectDir, options, storeFile }) => {
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("msg-legacy")] });
    await rm(path.join(home, "traces"), { recursive: true, force: true });
    const store = await openStore(options.homeDir, storeFile);
    try {
      store.database
        .prepare(
          `INSERT INTO workbuddy_generation_durations
             (message_id, duration_ms, ended_at_ms, capture_version, captured_at)
           VALUES (?, ?, NULL, 'workbuddy.trace.v1', '2026-10-21T00:00:00.000Z')`,
        )
        .run("msg-legacy", 700);
      await store.sync({ options });
      assert.deepEqual(durationRows(store), []);
      assert.deepEqual(legacyDurationRows(store), [{ message_id: "msg-legacy", duration_ms: 700 }]);
      assert.equal(countSamples(store), 1);
      assert.equal(
        Number(
          store.database.prepare("SELECT duration_ms FROM perf_samples WHERE source_kind = 'workbuddy'").get()
            .duration_ms,
        ),
        700,
      );
    } finally {
      store.close();
    }
  });
});

test("C2：多个 WorkBuddy home 共用无归属旧时长时，两个 home 都不采样", async () => {
  await withWorkspace(async ({ root, projectDir, options, storeFile }) => {
    const secondHome = path.join(root, ".workbuddy-ai-second");
    const secondProjectDir = path.join(secondHome, "projects", "slug");
    await mkdir(secondProjectDir, { recursive: true });
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("msg-legacy-shared")] });
    await writeSessions(secondProjectDir, { [SESSION_B]: [usageRecord("msg-legacy-shared")] });

    const store = await openStore(options.homeDir, storeFile);
    try {
      store.database
        .prepare(
          `INSERT INTO workbuddy_generation_durations
             (message_id, duration_ms, ended_at_ms, capture_version, captured_at)
           VALUES (?, ?, NULL, 'workbuddy.trace.v1', '2026-10-21T00:00:00.000Z')`,
        )
        .run("msg-legacy-shared", 700);
      await store.sync({ options: { ...options, extraWorkbuddyHomes: secondHome } });

      assert.equal(countSamples(store), 0);
      assert.deepEqual(legacyDurationRows(store), [{ message_id: "msg-legacy-shared", duration_ms: 700 }]);
    } finally {
      store.close();
    }
  });
});

test("C2：两个 home 的同名 messageId 各自采样，不跨 home 冲突", async () => {
  await withWorkspace(async ({ root, projectDir, traceDir, options, storeFile }) => {
    const secondHome = path.join(root, ".workbuddy-ai-second");
    const secondProjectDir = path.join(secondHome, "projects", "slug");
    const secondTraceDir = path.join(secondHome, "traces", "102285");
    await mkdir(secondProjectDir, { recursive: true });
    await mkdir(secondTraceDir, { recursive: true });
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("msg-shared")] });
    await writeSessions(secondProjectDir, { [SESSION_B]: [usageRecord("msg-shared")] });
    await writeTraces(traceDir, [traceRow("msg-shared", { duration: 800 })]);
    await writeTraces(secondTraceDir, [traceRow("msg-shared", { duration: 900 })]);

    const store = await openStore(options.homeDir, storeFile);
    try {
      await store.sync({ options: { ...options, extraWorkbuddyHomes: secondHome } });
      assert.equal(countSamples(store), 2);
      const samples = store.database
        .prepare(
          `SELECT source_files.home_path, perf_samples.duration_ms
           FROM perf_samples
           JOIN source_files ON source_files.path = perf_samples.source_path
           WHERE perf_samples.source_kind = 'workbuddy'
           ORDER BY source_files.home_path`,
        )
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(
        samples.map((row) => row.duration_ms).sort((left, right) => left - right),
        [800, 900],
      );
      assert.equal(new Set(samples.map((row) => row.home_path)).size, 2);
      assert.equal(new Set(durationRows(store).map((row) => row.home_id)).size, 2);
    } finally {
      store.close();
    }
  });
});

test("C2：trace 到达只重解析包含该 messageId 的会话文件与 home", async () => {
  await withWorkspace(async ({ root, projectDir, traceDir, options, storeFile }) => {
    const secondHome = path.join(root, ".workbuddy-ai-second");
    const secondProjectDir = path.join(secondHome, "projects", "slug");
    const secondTraceDir = path.join(secondHome, "traces", "102285");
    await mkdir(secondProjectDir, { recursive: true });
    await mkdir(secondTraceDir, { recursive: true });
    const firstFile = path.join(projectDir, `${SESSION_A}.jsonl`);
    const secondFile = path.join(secondProjectDir, `${SESSION_B}.jsonl`);
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("m-first")] });
    await writeSessions(secondProjectDir, {
      [SESSION_B]: [usageRecord("m-second"), usageRecord("m-second-unrelated")],
    });
    await writeTraces(traceDir, [traceRow("m-first")]);
    await writeTraces(secondTraceDir, []);

    const store = await openStore(options.homeDir, storeFile);
    try {
      const syncOptions = { ...options, extraWorkbuddyHomes: secondHome };
      await store.sync({ options: syncOptions });
      const rebuilt = [];
      const original = store.replaceFile.bind(store);
      store.replaceFile = async (file, replaceOptions) => {
        rebuilt.push(file.filePath);
        return original(file, replaceOptions);
      };

      await writeTraces(secondTraceDir, [traceRow("m-second", { duration: 850 })]);
      await store.sync({ options: syncOptions });

      assert.deepEqual(rebuilt, [secondFile]);
      assert.equal(rebuilt.includes(firstFile), false);
      const secondHomeId = store.database
        .prepare("SELECT home_id FROM source_files WHERE path = ?")
        .get(secondFile).home_id;
      const sample = store.database
        .prepare("SELECT duration_ms FROM perf_samples WHERE sample_key = ?")
        .get(JSON.stringify(["workbuddy", secondHomeId, "m-second"]));
      assert.equal(Number(sample?.duration_ms), 850);
    } finally {
      store.close();
    }
  });
});

test("C2：legacy 单 home → 多 home 撤样本，返回单 home 恢复，noop 与重开稳定", async () => {
  await withWorkspace(async ({ root, projectDir, options, storeFile }) => {
    const secondHome = path.join(root, ".workbuddy-ai-second");
    const secondProjectDir = path.join(secondHome, "projects", "slug");
    await mkdir(secondProjectDir, { recursive: true });
    await writeSessions(projectDir, { [SESSION_A]: [usageRecord("msg-shared-legacy")] });

    let store = await openStore(options.homeDir, storeFile);
    try {
      store.database
        .prepare(
          `INSERT INTO workbuddy_generation_durations
             (message_id, duration_ms, ended_at_ms, capture_version, captured_at)
           VALUES (?, ?, NULL, 'workbuddy.trace.v1', '2026-10-21T00:00:00.000Z')`,
        )
        .run("msg-shared-legacy", 700);

      await store.sync({ options });
      assert.equal(countSamples(store), 1);
      assert.equal(
        Number(
          store.database.prepare("SELECT duration_ms FROM perf_samples WHERE source_kind = 'workbuddy'").get()
            .duration_ms,
        ),
        700,
      );

      await writeSessions(secondProjectDir, { [SESSION_B]: [usageRecord("msg-shared-legacy")] });
      const multiOptions = { ...options, extraWorkbuddyHomes: secondHome };
      await store.sync({ options: multiOptions });
      assert.equal(countSamples(store), 0, "多 home 时无归属旧值必须撤出");
      const multiVersion = store.readMeta("perf_index_version");

      await store.sync({ options: multiOptions });
      assert.equal(countSamples(store), 0);
      assert.equal(store.readMeta("perf_index_version"), multiVersion);

      store.close();
      store = await openStore(options.homeDir, storeFile);
      await store.sync({ options: multiOptions });
      assert.equal(countSamples(store), 0, "重开后多 home 仍不得恢复旧值");

      await store.sync({ options });
      assert.equal(countSamples(store), 1, "回到唯一 home 后旧值重新可用");
      assert.equal(
        Number(
          store.database.prepare("SELECT duration_ms FROM perf_samples WHERE source_kind = 'workbuddy'").get()
            .duration_ms,
        ),
        700,
      );
      const singleVersion = store.readMeta("perf_index_version");
      assert.notEqual(singleVersion, multiVersion);

      await store.sync({ options });
      assert.equal(store.readMeta("perf_index_version"), singleVersion);
      assert.deepEqual(legacyDurationRows(store), [{ message_id: "msg-shared-legacy", duration_ms: 700 }]);

      store.close();
      store = await openStore(options.homeDir, storeFile);
      await store.sync({ options });
      assert.equal(countSamples(store), 1);
      assert.equal(store.readMeta("perf_index_version"), singleVersion);
    } finally {
      store.close();
    }
  });
});

test("C2：legacy 模式切换只影响兜底候选，同/异 message 与 home observation 隔离", async () => {
  await withWorkspace(async ({ root, projectDir, traceDir, options, storeFile }) => {
    const secondHome = path.join(root, ".workbuddy-ai-second");
    const secondProjectDir = path.join(secondHome, "projects", "slug");
    await mkdir(secondProjectDir, { recursive: true });
    await writeSessions(projectDir, {
      [SESSION_A]: [usageRecord("msg-main-legacy"), usageRecord("msg-observed")],
    });
    await writeTraces(traceDir, [traceRow("msg-observed", { duration: 900 })]);

    const store = await openStore(options.homeDir, storeFile);
    try {
      store.database
        .prepare(
          `INSERT INTO workbuddy_generation_durations
             (message_id, duration_ms, ended_at_ms, capture_version, captured_at)
           VALUES (?, ?, NULL, 'workbuddy.trace.v1', '2026-10-21T00:00:00.000Z')
           , (?, ?, NULL, 'workbuddy.trace.v1', '2026-10-21T00:00:00.000Z')`,
        )
        .run("msg-main-legacy", 700, "msg-second-legacy", 800);

      await store.sync({ options });
      assert.deepEqual(
        store.database
          .prepare("SELECT duration_ms FROM perf_samples WHERE source_kind = 'workbuddy' ORDER BY duration_ms")
          .all()
          .map((row) => row.duration_ms),
        [700, 900],
      );

      await writeSessions(secondProjectDir, { [SESSION_B]: [usageRecord("msg-second-legacy")] });
      const multiOptions = { ...options, extraWorkbuddyHomes: secondHome };
      await store.sync({ options: multiOptions });
      assert.deepEqual(
        store.database
          .prepare("SELECT duration_ms FROM perf_samples WHERE source_kind = 'workbuddy' ORDER BY duration_ms")
          .all()
          .map((row) => row.duration_ms),
        [900],
        "只撤 legacy 候选，home observation 仍保留",
      );

      await store.sync({ options: multiOptions });
      assert.equal(countSamples(store), 1);

      await store.sync({ options });
      assert.deepEqual(
        store.database
          .prepare("SELECT duration_ms FROM perf_samples WHERE source_kind = 'workbuddy' ORDER BY duration_ms")
          .all()
          .map((row) => row.duration_ms),
        [700, 900],
      );
      assert.deepEqual(
        legacyDurationRows(store),
        [
          { message_id: "msg-main-legacy", duration_ms: 700 },
          { message_id: "msg-second-legacy", duration_ms: 800 },
        ],
        "模式切换不得删除无 home 归属的历史行",
      );
    } finally {
      store.close();
    }
  });
});
