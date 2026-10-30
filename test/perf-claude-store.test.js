// S1：Claude Code 性能候选的 SQLite 接线 —— 发现（C-5）、注册（C-4）与落库。
//
// 全部使用 `mkdtemp` 临时 HOME + 临时索引库（夹具自带清理）；**不打开** `tools/out` 下任何库。
// 夹具行来自 `test-support/claude-perf-fixture.mjs`（R1 产物，本卡不改它）。
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";
import {
  DEDUPE,
  SUBAGENT,
  T0,
  assistantRow,
  attachmentRow,
  promptRow,
  withClaudeFile,
  withClaudeFiles,
} from "../test-support/claude-perf-fixture.mjs";

const DB_NAME = "index.sqlite";

async function openStore(root) {
  const store = new UsageStore({ homeDir: root, databaseFile: path.join(root, DB_NAME) });
  await store.open();
  return store;
}

function syncOptions(root) {
  return { homeDir: root, env: {} };
}

function claudeSamples(store) {
  return store.database
    .prepare(
      `SELECT sample_key, source_path, home_id, window, timing_kind, timing_source, token_scope,
              method_version, duration_ms, output_tokens, agent_kind, status
       FROM perf_samples
       WHERE source_kind = 'claude'
       ORDER BY sample_key`,
    )
    .all()
    .map((row) => ({ ...row, messageId: JSON.parse(String(row.sample_key))[2] }));
}

function sampleCount(store) {
  return Number(store.database.prepare("SELECT COUNT(*) AS n FROM perf_samples WHERE source_kind = 'claude'").get().n);
}

test("S1：首次 sync 自动回填 —— 无指纹 ⇒ 提取，样本数等于夹具预期", async () => {
  await withClaudeFiles(
    [
      {
        rows: DEDUPE.rows,
        dirs: [".claude", "projects", "fixture-project"],
        name: "session-fixture.jsonl",
      },
      {
        rows: SUBAGENT.rows,
        dirs: [".claude", "projects", "fixture-project", "parent-session", "subagents"],
        name: "agent-explore.jsonl",
      },
    ],
    async ({ root, files }) => {
      const store = await openStore(root);
      try {
        const round = await store.sync({ options: syncOptions(root) });
        assert.equal(round.updatedFileCount, 2, "两个物理转录都必须被首次提取");

        const samples = claudeSamples(store);
        assert.equal(samples.length, 2, "DEDUPE 1 条 + 子代理 1 条");

        // `perfFileNeedsExtraction` 无指纹 ⇒ true：首轮成功后逐文件指纹已发布。
        const fingerprints = JSON.parse(store.readMeta("perf_file_fingerprints") || "{}");
        for (const file of files) {
          assert.ok(Object.hasOwn(fingerprints, file), `首轮必须发布 ${file} 的内容指纹`);
        }

        const mainPath = path.join(root, ".claude", "projects", "fixture-project", "session-fixture.jsonl");
        const byId = new Map(samples.map((sample) => [sample.messageId, sample]));
        const dedupe = byId.get("msg-dedupe");
        assert.ok(dedupe, "主转录样本必须落库");
        // `source_path` 是**物理文件路径**，不是 home 目录。
        assert.equal(dedupe.source_path, mainPath);
        assert.notEqual(dedupe.source_path, root);
        assert.equal(dedupe.duration_ms, null);
        assert.equal(dedupe.output_tokens, null);
        assert.equal(dedupe.agent_kind, "main");
        assert.equal(dedupe.status, "completed");

        const subagent = byId.get("msg-subagent");
        assert.ok(subagent, "子代理转录样本必须落库");
        assert.equal(subagent.agent_kind, "subagent");
        assert.equal(subagent.duration_ms, null);
        assert.equal(subagent.output_tokens, null);
        assert.equal(
          subagent.source_path,
          path.join(
            root,
            ".claude",
            "projects",
            "fixture-project",
            "parent-session",
            "subagents",
            "agent-explore.jsonl",
          ),
        );

        // C-2：claude 样本的语义列按归一化结果落库。
        for (const sample of samples) {
          assert.equal(sample.window, "request");
          assert.equal(sample.timing_kind, "generation");
          assert.equal(sample.timing_source, "unknown");
          assert.equal(sample.token_scope, "non_reasoning_output");
          assert.equal(sample.method_version, "tps-v5");
        }
      } finally {
        store.close();
      }
    },
  );
});

test("S1：重复 sync 幂等 —— 行数与逐列值不变", async () => {
  await withClaudeFile(
    DEDUPE.rows,
    async ({ root }) => {
      const store = await openStore(root);
      try {
        const firstRound = await store.sync({ options: syncOptions(root) });
        assert.equal(firstRound.updatedFileCount, 1);
        const first = claudeSamples(store);
        assert.equal(first.length, 1);

        const secondRound = await store.sync({ options: syncOptions(root) });
        assert.equal(secondRound.updatedFileCount, 0, "未变化的文件不得重新提取");
        assert.deepEqual(claudeSamples(store), first, "重复 sync 不得改写样本");
        assert.equal(sampleCount(store), 1);
      } finally {
        store.close();
      }
    },
    { dirs: [".claude", "projects", "fixture-project"] },
  );
});

test("S1：读取期间追加 ⇒ LIVE_SOURCE_CHANGED、整文件回滚、指纹置 -1，下一轮恢复", async () => {
  await withClaudeFile(
    DEDUPE.rows,
    async ({ root, files }) => {
      const [mainFile] = files;
      const store = await openStore(root);
      try {
        await store.sync({ options: syncOptions(root) });
        assert.equal(sampleCount(store), 1, "前置：首轮 1 条");

        // 先让文件真的变化（增量判据才会进入 `replaceFile`）。
        appendFileSync(
          mainFile,
          `${[
            JSON.stringify(promptRow(T0 + 20_000)),
            JSON.stringify(
              assistantRow({ ts: T0 + 21_000, messageId: "msg-live", outputTokens: 40, stopReason: "end_turn" }),
            ),
          ].join("\n")}\n`,
        );

        // 在 reader **读完、statAfter 之前**再追加一行：包装 perf_samples 的 INSERT，
        // 第一次真正写入时追加（reader 已扫描完毕，此刻仍在 `statBefore`/`statAfter` 之间）。
        let injected = false;
        const realPrepare = store.database.prepare.bind(store.database);
        store.database.prepare = (sql) => {
          const statement = realPrepare(sql);
          if (!String(sql).includes("INSERT INTO perf_samples")) return statement;
          const realRun = statement.run.bind(statement);
          statement.run = (...args) => {
            const result = realRun(...args);
            if (!injected) {
              injected = true;
              appendFileSync(mainFile, `${JSON.stringify(attachmentRow(T0 + 60_000))}\n`);
            }
            return result;
          };
          return statement;
        };
        try {
          await store.sync({ options: syncOptions(root) });
        } finally {
          store.database.prepare = realPrepare;
        }
        assert.equal(injected, true, "夹具必须真的在读取窗口内追加");

        const warnings = JSON.parse(store.readMeta("perf_source_warnings") || "[]");
        assert.ok(
          warnings.some((warning) => warning.code === "LIVE_SOURCE_CHANGED"),
          `必须记录 LIVE_SOURCE_CHANGED，实得 ${JSON.stringify(warnings)}`,
        );
        assert.equal(store.readMeta("perf_state"), "degraded");
        assert.equal(sampleCount(store), 1, "整文件替换必须回滚，保留上一次成功候选");

        const row = store.database.prepare("SELECT size, mtime_ms FROM source_files WHERE path = ?").get(mainFile);
        assert.equal(Number(row.size), -1, "指纹必须置 -1 以强制下轮重提取");
        assert.equal(Number(row.mtime_ms), -1);

        // 下一轮：文件未再变化，但被置脏 ⇒ 必重新提取，样本恢复为 2。
        await store.sync({ options: syncOptions(root) });
        assert.equal(store.readMeta("perf_state"), "ready");
        assert.equal(sampleCount(store), 2);
        assert.deepEqual(
          claudeSamples(store).map((sample) => sample.messageId),
          ["msg-dedupe", "msg-live"],
        );
      } finally {
        store.close();
      }
    },
    { dirs: [".claude", "projects", "fixture-project"] },
  );
});

test("S1：删除物理文件 ⇒ 保留最后一次成功候选并登记 missing", async () => {
  await withClaudeFile(
    DEDUPE.rows,
    async ({ root, files }) => {
      const [mainFile] = files;
      const store = await openStore(root);
      try {
        await store.sync({ options: syncOptions(root) });
        assert.equal(sampleCount(store), 1, "前置：1 条样本");
        assert.equal(
          Number(store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE path = ?").get(mainFile).n),
          1,
        );

        await rm(mainFile);
        const round = await store.sync({ options: syncOptions(root) });

        assert.equal(sampleCount(store), 1, "来源消失不得删除最后一次成功候选");
        assert.equal(
          Number(store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE path = ?").get(mainFile).n),
          1,
          "source_files 行必须保留来源身份",
        );
        assert.deepEqual(
          round.missingSources.map((source) => [source.path, source.kind]),
          [[mainFile, "claude"]],
          "缺失状态必须可机读",
        );
      } finally {
        store.close();
      }
    },
    { dirs: [".claude", "projects", "fixture-project"] },
  );
});
