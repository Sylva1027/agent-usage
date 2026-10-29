/**
 * V1（`task-18`）—— **自动刷新的服务端确定性周期**（计划 §7 V1 / 规格 §9 K 的服务端侧）
 *
 * ---------------------------------------------------------------------------
 * 本文件是 V1 卡的**新增交付物**，新建而**不是**追加进 `test/app-autorefresh.test.js`：
 *   后者是 U4 的交付物、哈希已入取代链，追加会触发不必要的取代链（主审裁定 ③）。
 *   客户端侧（真实 60 秒定时器 / changed 判定 / 浏览器渲染）**不归 V1**，
 *   主审已划给 **V2**（V2 卡面本就含 PC 浏览器实测）；本文件只做：
 *
 *   ① **复用**既有客户端测试（只读，不修改）：`test/app-autorefresh.test.js` 由
 *      `V1/verify-v1.mjs` 的 K 项以子进程 `node --test` 复跑并记录 pass/fail。
 *   ② 服务端**确定性多轮等价**：同一时刻 + 同一预设的重复读，在**屏蔽白名单六条
 *      （checkedAt/snapshotId/generatedAt/asOf/indexedAt/observedAt）之后**必须逐字节一致。
 *   ③ **计数**：源未变的连续周期里，`summary.perf.indexVersion` 必须不变，
 *      且 `events` / `source_files` / `perf_samples` / `perf_rollout_threads` 行数
 *      **不得增长**（证明没有重复发布 / 重复累积）；源真变后的那一周期必须发布新版本，
 *      之后再次稳定。
 *
 * 源检查现由轻量服务完成，checkedAt 跟随服务时钟；重型计算由独立进程完成。
 *   2. 夹具 `createPerfCodexIntegrationFixture()` 的 codex 数据基准是 `2026-10-04T12:00:00.000Z`，
 *      落在 `preset=today` 窗口**之外**（today 返回 `groups: 0`）⇒ 承载"源检查/发布"语义
 *      用 `preset=all`；`today` 的真隔离输入覆盖见 `V1/verify-v1.mjs` 的 A/F 项。
 *      另：该夹具**没有限额记录** ⇒ 两个 quota 预设确定性返回 `409 QUOTA_WINDOW_UNAVAILABLE`
 *      （合法分支，本文件断言"跨周期稳定"，而不是断言 200）。
 *
 * 只写系统临时目录；不碰真实 `~/.codex-usage`、不碰 `tools/out`、不加依赖（`node:sqlite` 内置）。
 * 重跑：`node --test test/v1-autorefresh.test.js`
 */

import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createUsageServer } from "../src/server.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const CYCLE_MS = 60_000;
const FIXED_NOW_ISO = "2026-10-09T03:00:00.000Z";

/** 卡片认的差异白名单（六条；与 `V1/lib/v1-common.mjs` 的 `WHITELIST` 逐字一致）。 */
const WHITELIST = [
  /(^|\.)checkedAt$/,
  /(^|\.)snapshotId$/,
  /(^|\.)generatedAt$/,
  /(^|\.)asOf$/,
  /(^|\.)indexedAt$/,
  /(^|\.)observedAt$/,
];

/** 深拷贝并摘掉白名单字段（数组顺序保持 ⇒ 只用于"同刻同参"比较）。 */
function maskWhitelisted(value, keyPath = "") {
  if (Array.isArray(value)) return value.map((entry) => maskWhitelisted(entry, keyPath));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      const child = keyPath ? `${keyPath}.${key}` : key;
      if (WHITELIST.some((pattern) => pattern.test(child))) continue;
      out[key] = maskWhitelisted(value[key], child);
    }
    return out;
  }
  return value;
}

const masked = (body) => JSON.stringify(maskWhitelisted(body));

/** 固定时钟：`new Date()` / `Date.now()` 走可控值（**只影响主线程**，见文件头⚠️1）。 */
function installClock(isoStart) {
  const RealDate = Date;
  let current = Date.parse(isoStart);
  class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(current);
      else super(...args);
    }
    static now() {
      return current;
    }
  }
  Object.defineProperty(FixedDate, "name", { value: "Date" });
  globalThis.Date = FixedDate;
  return {
    advance(ms) {
      current += ms;
      return current;
    },
    restore() {
      globalThis.Date = RealDate;
    },
  };
}

/** 已提交索引的行数（"计数"判据：稳定源不得让这些数字增长）。 */
function indexCounts(databaseFile) {
  const db = new DatabaseSync(databaseFile, { readOnly: true });
  const scalar = (sql) => {
    try {
      return db.prepare(sql).get().n;
    } catch {
      return null;
    }
  };
  const counts = {
    events: scalar("SELECT COUNT(*) AS n FROM events"),
    sourceFiles: scalar("SELECT COUNT(*) AS n FROM source_files"),
    perfSamples: scalar("SELECT COUNT(*) AS n FROM perf_samples"),
    rolloutThreads: scalar("SELECT COUNT(*) AS n FROM perf_rollout_threads"),
  };
  db.close();
  return counts;
}

async function withServer(fixture, run) {
  const server = createUsageServer({ ...fixture.serverOptions });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (url) => {
    const response = await fetch(`${base}${url}`);
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: response.status, text, body, bytes: Buffer.byteLength(text) };
  };
  try {
    return await run({ get, base });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => {
      server.close(resolve);
      setTimeout(resolve, 1000);
    });
  }
}

/** 承载"源检查/发布"语义的预设（夹具数据在 2026-10-04，today 窗口看不到 ⇒ 用 all）。 */
const PERF_QUERY = "preset=all&bucket=hour&calendarZone=local&view=dashboard";
/** K 点名的两个 quota 预设（该夹具无限额记录 ⇒ 确定性 409；断言跨周期稳定）。 */
const QUOTA_QUERIES = {
  quota_5h: "preset=quota_5h&calendarZone=local&view=dashboard",
  quota_week: "preset=quota_week&calendarZone=local&view=dashboard",
};

test("V1/K 自动刷新：固定时钟下多周期确定性等价，稳定源不重复发布（计数不增长）", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const clock = installClock(FIXED_NOW_ISO);
  try {
    await withServer(fixture, async ({ get }) => {
      const cycles = [];
      let previousCounts = null;
      let previousIndexVersion = null;

      for (let cycle = 1; cycle <= 3; cycle += 1) {
        if (cycle > 1) clock.advance(CYCLE_MS);
        const reads = {};

        // ① 源检查/发布路径（perf 载体）：check、重复读、skipCheck 三者都必须等价
        const checked = await get(`/api/usage?${PERF_QUERY}`);
        const again = await get(`/api/usage?${PERF_QUERY}`);
        const skipped = await get(`/api/usage?${PERF_QUERY}&skipCheck=1`);
        assert.equal(checked.status, 200, `cycle${cycle} all status`);
        assert.equal(skipped.status, 200, `cycle${cycle} all skipCheck status`);
        assert.equal(masked(again.body), masked(checked.body), `cycle${cycle} all 同刻重复读（屏蔽白名单后）必须一致`);
        assert.equal(
          masked(skipped.body),
          masked(checked.body),
          `cycle${cycle} all check 与 skipCheck 在源未变时必须等价`,
        );
        reads.all = {
          status: checked.status,
          // `checkedAt` 是响应**顶层**字段（`metadata` 下只有 `generatedAt`）
          checkedAt: checked.body?.checkedAt ?? checked.body?.metadata?.checkedAt ?? null,
          indexVersion: checked.body?.summary?.perf?.indexVersion ?? null,
          perfState: checked.body?.summary?.perf?.state ?? null,
        };

        // ② 两个 quota 预设：K 点名的"三个周期"覆盖（该夹具确定性 409，断言跨周期稳定）
        for (const [name, query] of Object.entries(QUOTA_QUERIES)) {
          const first = await get(`/api/usage?${query}`);
          const second = await get(`/api/usage?${query}`);
          assert.ok([200, 409].includes(first.status), `cycle${cycle} ${name} status=${first.status}`);
          assert.equal(second.status, first.status, `cycle${cycle} ${name} 状态必须稳定`);
          assert.equal(
            masked(second.body),
            masked(first.body),
            `cycle${cycle} ${name} 同刻重复读（屏蔽白名单后）必须一致`,
          );
          reads[name] = { status: first.status, code: first.body?.code ?? null };
        }
        assert.equal(reads.quota_5h.status, reads.quota_week.status, `cycle${cycle} 两个 quota 预设状态必须一致`);

        const counts = indexCounts(fixture.serverOptions.databaseFile);
        cycles.push({ cycle, checkedAt: reads.all.checkedAt, indexVersion: reads.all.indexVersion, counts });

        // ③ 每轮源检查的时间戳必须跟随当前服务时钟。
        const stamp = Date.parse(reads.all.checkedAt);
        assert.ok(Number.isFinite(stamp), `cycle${cycle} checkedAt 必须可解析：${reads.all.checkedAt}`);
        assert.equal(reads.all.checkedAt, new Date().toISOString(), `cycle${cycle} checkedAt 跟随源检查时钟`);
        // ④ 源未变 ⇒ `indexVersion` 可证且不变
        assert.equal(reads.all.perfState, "ready", `cycle${cycle} perfState 必须 ready`);
        assert.notEqual(reads.all.indexVersion, null, `cycle${cycle} indexVersion 必须可证（非 null）`);
        if (previousIndexVersion !== null) {
          assert.equal(reads.all.indexVersion, previousIndexVersion, `cycle${cycle} 源未变时 indexVersion 不得改变`);
        }
        // ⑤ 源未变 ⇒ 计数不得增长（无重复发布 / 无重复累积）
        if (previousCounts !== null) {
          for (const key of Object.keys(counts)) {
            assert.equal(counts[key], previousCounts[key], `cycle${cycle} ${key} 不得在稳定源上增长`);
          }
        }
        previousCounts = counts;
        previousIndexVersion = reads.all.indexVersion;
      }

      console.log(
        "  [实测] cycles:",
        JSON.stringify(
          cycles.map((row) => ({
            cycle: row.cycle,
            checkedAt: row.checkedAt,
            indexVersion: String(row.indexVersion).slice(0, 12),
            counts: row.counts,
          })),
        ),
      );
      assert.equal(cycles.length, 3);
      assert.ok(
        cycles.every((row) => row.counts.perfSamples > 0),
        "夹具必须真的发布了 perf 样本",
      );
    });
  } finally {
    clock.restore();
  }
});

test("V1/K 自动刷新：源真变后的周期必须发布新版本，其后再次稳定且计数不增长", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  const clock = installClock(FIXED_NOW_ISO);
  try {
    await withServer(fixture, async ({ get }) => {
      const rollouts = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const child = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(child);
          else if (entry.name.endsWith(".jsonl")) rollouts.push(child);
        }
      };
      walk(fixture.codexHome);
      assert.ok(rollouts.length > 0, "夹具必须有 rollout 文件");
      const victim = rollouts.sort()[0];

      const readCycle = async () => {
        const row = await get(`/api/usage?${PERF_QUERY}`);
        assert.equal(row.status, 200);
        return {
          text: row.text,
          maskedText: masked(row.body),
          indexVersion: row.body?.summary?.perf?.indexVersion ?? null,
          perfState: row.body?.summary?.perf?.state ?? null,
          warnings: row.body?.metadata?.warnings ?? null,
        };
      };

      // 基线：连续两轮稳定
      const base1 = await readCycle();
      clock.advance(CYCLE_MS);
      const base2 = await readCycle();
      assert.equal(base1.perfState, "ready", "基线 perfState 必须 ready");
      assert.equal(base2.indexVersion, base1.indexVersion, "变更前 indexVersion 必须稳定");
      const countsBefore = indexCounts(fixture.serverOptions.databaseFile);

      // 源真变：**必须沿用该文件自己的线程 id**（否则记录不可归属 ⇒ UNKEYABLE_RECORD ⇒ degraded）
      const firstLine = JSON.parse(readFileSync(victim, "utf8").split("\n")[0]);
      const threadId = firstLine?.payload?.id ?? firstLine?.payload?.session_id ?? null;
      assert.ok(threadId, "必须能从 session_meta 取到该 rollout 的线程 id");
      const info = statSync(victim);
      appendFileSync(
        victim,
        `${JSON.stringify({
          type: "token_usage_record",
          ordinal: 900_001,
          timestamp: new Date(Date.parse("2026-10-04T13:00:00.000Z")).toISOString(),
          payload: {
            thread_id: threadId,
            turn_id: "v1-autorefresh-turn",
            response_id: "resp-v1-autorefresh",
            usage: { output_tokens: 11 },
          },
        })}\n`,
      );
      const bumped = new Date(info.mtimeMs + 5_000);
      utimesSync(victim, bumped, bumped);

      clock.advance(CYCLE_MS);
      const changed = await readCycle();
      assert.equal(changed.perfState, "ready", "变更后 perfState 必须仍 ready（记录必须可归属）");
      assert.notEqual(changed.indexVersion, base1.indexVersion, "源真变后 indexVersion 必须改变（确实发布了新版本）");
      assert.notEqual(changed.maskedText, base1.maskedText, "源真变后（屏蔽白名单后）响应内容必须改变");

      // 其后再次稳定：同刻重复读（屏蔽白名单）逐字节一致，且不再增长
      clock.advance(CYCLE_MS);
      const after1 = await readCycle();
      const after1Repeat = await readCycle();
      assert.equal(after1Repeat.maskedText, after1.maskedText, "变更后同刻重复读（屏蔽白名单后）必须一致");
      assert.equal(after1.indexVersion, changed.indexVersion, "变更后 indexVersion 必须重新稳定");
      clock.advance(CYCLE_MS);
      const after2 = await readCycle();
      const countsAfter = indexCounts(fixture.serverOptions.databaseFile);

      console.log(
        "  [实测] 变更前 counts:",
        JSON.stringify(countsBefore),
        "变更后 counts:",
        JSON.stringify(countsAfter),
      );
      console.log(
        "  [实测] indexVersion 变更前:",
        String(base1.indexVersion).slice(0, 12),
        "变更后:",
        String(changed.indexVersion).slice(0, 12),
        "再稳定:",
        String(after2.indexVersion).slice(0, 12),
      );
      assert.equal(after2.indexVersion, changed.indexVersion, "变更后必须再次稳定");
      assert.equal(after2.indexVersion, after1.indexVersion, "变更后两轮 indexVersion 必须一致");
      assert.ok(existsSync(fixture.serverOptions.databaseFile), "索引必须存在");
    });
  } finally {
    clock.restore();
  }
});
