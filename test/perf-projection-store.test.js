// T1（`handoffs/T1-design.md`）：Codex 私有投影持久化的 **schema/迁移 + 读写接缝** 测试。
//
// 覆盖设计页 §6 的 6 条验收里可由 in-repo 测试守护的部分：
//   1) 13 → 14 迁移成功 / 幂等 / 中断可重入 / **不回填**（空表 ⇒ 迁移不清空、不标脏，首个 sync 不重读）
//   2) 方法版本变更**只**失效必要行（复合版本**两个组成部分各自**被测到）+ 不无条件标脏全库
//   3) 写一半失败 ⇒ **无半行**（事务性）；未提交即中断 ⇒ 重开后无半行
//   4) 损坏 blob ⇒ miss + 删行、不抛错；**真 sync 不被打断**
//   5) `rollback` 不写库、`prune`/`retainHomes` 与内存同一淘汰契约、`clear()` **不清表**
//   6) **对拍**：DB 行的 `path`/`method_version`/`bytes`/`fingerprint` 与真实
//      `createCodexProjectionCache().entries()` 逐字节相同（含大小写变体）
//
// 本文件**只读** `src/perf-sources/codex-thread.js`（import 真实缓存用于对拍），不修改任何产品文件。
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  CODEX_PROJECTION_STORE_TABLE,
  STORE_SCHEMA_VERSION,
  UsageStore,
  createPersistentCodexProjectionCache,
  projectionStoreByteEstimate,
} from "../src/usage-store.js";
import { createCodexProjectionCache } from "../src/perf-sources/codex-thread.js";

const TABLE = CODEX_PROJECTION_STORE_TABLE;

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

/** T1 夹具：一个 codex home + 两份 rollout（每份一个线程）—— 与 `makeC5CodexHome` 同型。 */
function codexRollout(threadId, turnId, { ordinalBase = 0, outputTokens = 500, startMs = 1_700_000_000_000 } = {}) {
  return jsonl([
    { type: "session_meta", ordinal: ordinalBase + 0, payload: { id: threadId, session_id: threadId, source: "cli" } },
    {
      type: "turn_context",
      ordinal: ordinalBase + 1,
      payload: { thread_id: threadId, turn_id: turnId, model: "gpt-fixture", effort: "medium" },
    },
    {
      type: "token_usage_record",
      ordinal: ordinalBase + 2,
      timestamp: new Date(startMs).toISOString(),
      payload: {
        thread_id: threadId,
        turn_id: turnId,
        response_id: `resp-${threadId}`,
        usage: { output_tokens: outputTokens },
      },
    },
    {
      type: "event_msg",
      ordinal: ordinalBase + 3,
      payload: {
        type: "item_completed",
        thread_id: threadId,
        turn_id: turnId,
        item: { id: `item-${threadId}`, type: "AgentMessage" },
        started_at_ms: startMs,
        completed_at_ms: startMs + 1500,
      },
    },
    {
      type: "event_msg",
      ordinal: ordinalBase + 4,
      payload: {
        type: "task_complete",
        thread_id: threadId,
        turn_id: turnId,
        started_at: Math.floor(startMs / 1000),
        completed_at: Math.floor(startMs / 1000) + 2,
        duration_ms: 1500,
      },
    },
  ]);
}

/** 追加一帧**合法**的 token_usage（同 thread/turn，新 ordinal）⇒ 内容与指纹真变、归属不变。 */
function extraTokenFrame(threadId, turnId, ordinal, outputTokens, timestamp) {
  return {
    type: "token_usage_record",
    ordinal,
    timestamp,
    payload: {
      thread_id: threadId,
      turn_id: turnId,
      response_id: `resp-${turnId}`,
      usage: { output_tokens: outputTokens },
    },
  };
}

async function makeCodexHome() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-t1-projection-"));
  const sessionDir = path.join(homeDir, ".codex", "sessions", "2026", "10", "09");
  await mkdir(sessionDir, { recursive: true });
  const rolloutA = path.join(sessionDir, "rollout-t1-a.jsonl");
  const rolloutB = path.join(sessionDir, "rollout-t1-b.jsonl");
  await writeFile(rolloutA, codexRollout("t1-thread-a", "t1-turn-a1"));
  await writeFile(rolloutB, codexRollout("t1-thread-b", "t1-turn-b1", { ordinalBase: 10, outputTokens: 700 }));
  return {
    homeDir,
    sessionDir,
    rolloutA,
    rolloutB,
    databaseFile: path.join(homeDir, ".codex-usage", "usage-index.sqlite"),
  };
}

/** 无 codex 内容的最小夹具（只测迁移时无需任何真源）。 */
async function makeBareStore() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "codex-t1-bare-"));
  return { homeDir, databaseFile: path.join(homeDir, ".codex-usage", "usage-index.sqlite") };
}

const columnNames = (database, table) =>
  database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name));

const rowCount = (database, sql = `SELECT COUNT(*) AS n FROM ${TABLE}`) => Number(database.prepare(sql).get()?.n ?? 0);

const storeRows = (database) =>
  database
    .prepare(
      `SELECT path, home_id, kind, method_version, fingerprint, bytes, projection, updated_at FROM ${TABLE} ORDER BY path`,
    )
    .all();

/** 故障注入：只在第 `failOnRun` 次 `INSERT INTO perf_codex_projections` 上抛错，其余全部透传。 */
function failingDatabase(real, { failOnRun = 2 } = {}) {
  let runs = 0;
  return {
    exec: (sql) => real.exec(sql),
    prepare(sql) {
      const statement = real.prepare(sql);
      if (!sql.includes(`INSERT INTO ${TABLE}`)) return statement;
      return {
        run(...args) {
          runs += 1;
          if (runs >= failOnRun) throw new Error("T1-injected-write-failure");
          return statement.run(...args);
        },
      };
    },
  };
}

/** 一份任意但稳定的"规范投影"（形状不重要，接缝只要求是对象）。 */
function sampleProjection(seed) {
  return {
    threadId: `t1-thread-${seed}`,
    events: [{ ordinal: 0, kind: "session_meta", payload: { id: `t1-thread-${seed}`, note: "T1 对拍用" } }],
    totals: { output: 500 + seed, nested: { a: [1, 2, 3], b: null } },
  };
}

// ---------------------------------------------------------------------------
// 1) 迁移 13 → 14：只建表 + 索引、不回填、幂等
// ---------------------------------------------------------------------------

test("T1 · schema 13 → 14 只建表 + 索引、不回填（表存在且为空）", async () => {
  const { homeDir, databaseFile } = await makeBareStore();
  const store = new UsageStore({ homeDir, databaseFile });
  try {
    await store.open();
    assert.equal(STORE_SCHEMA_VERSION, 16, "本卡唯一的 schema 变化就是 13 → 14");
    assert.equal(Number(store.database.prepare("PRAGMA user_version").get().user_version), 16);
    assert.deepEqual(columnNames(store.database, TABLE), [
      "path",
      "home_id",
      "kind",
      "method_version",
      "fingerprint",
      "bytes",
      "projection",
      "updated_at",
    ]);
    const indexes = store.database
      .prepare(`PRAGMA index_list(${TABLE})`)
      .all()
      .map((row) => String(row.name));
    assert.ok(indexes.includes("perf_codex_projections_home_idx"), "索引 (home_id) 必须存在");
    assert.deepEqual(
      store.database
        .prepare("PRAGMA index_info(perf_codex_projections_home_idx)")
        .all()
        .map((row) => String(row.name)),
      ["home_id"],
    );
    const ddl = String(
      store.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE).sql,
    );
    assert.ok(ddl.includes("STRICT"), "与本仓其它新表一致：STRICT");
    assert.ok(!/raw|jsonl/i.test(ddl), "严禁 raw JSONL 列");
    assert.equal(rowCount(store.database), 0, "迁移**不回填** ⇒ 新表为空");
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("T1 · 迁移幂等：重复 open 不再建、不清表；已存在的行跨实例保留", async () => {
  const { homeDir, databaseFile } = await makeBareStore();
  const first = new UsageStore({ homeDir, databaseFile });
  await first.open();
  first.database
    .prepare(
      `INSERT INTO ${TABLE} (path, home_id, kind, method_version, fingerprint, bytes, projection, updated_at)
       VALUES ('c:\\t1\\sentinel.jsonl', 'home-1', 'codex', 'v:0', 'fp-1', 2, '{}', '2026-10-09T00:00:00.000Z')`,
    )
    .run();
  first.close();

  const second = new UsageStore({ homeDir, databaseFile });
  try {
    await second.open();
    assert.equal(Number(second.database.prepare("PRAGMA user_version").get().user_version), 16);
    assert.equal(rowCount(second.database), 1, "重复 open 不得清表");
    assert.equal(storeRows(second.database)[0].path, "c:\\t1\\sentinel.jsonl");
  } finally {
    second.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("T1 · 迁移中断可重入：未提交的建表 + v13 版本号 ⇒ 重开后重试并成功", async () => {
  const { homeDir, databaseFile } = await makeBareStore();
  const seed = new UsageStore({ homeDir, databaseFile });
  await seed.open();
  seed.close();

  // 把库退回 v13（真实 v13 库的形状：有业务表、**没有**投影表）。
  const raw = new DatabaseSync(databaseFile);
  raw.exec(`DROP TABLE ${TABLE}; PRAGMA user_version = 13;`);
  assert.equal(Number(raw.prepare("PRAGMA user_version").get().user_version), 13);
  // 模拟"迁移中途中断"：建了表但**从不 RELEASE / COMMIT**，直接关连接 ⇒ SQLite 回滚。
  raw.exec("BEGIN IMMEDIATE");
  raw.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (path TEXT PRIMARY KEY) STRICT`);
  raw.close();

  const after = new DatabaseSync(databaseFile);
  assert.equal(Number(after.prepare("PRAGMA user_version").get().user_version), 13, "中断后版本必须仍是 13");
  assert.equal(
    after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name=?").get(TABLE).n,
    0,
    "未提交的建表必须被回滚（不留半成品）",
  );
  after.close();

  const retried = new UsageStore({ homeDir, databaseFile });
  try {
    await retried.open();
    assert.equal(Number(retried.database.prepare("PRAGMA user_version").get().user_version), 16, "重开必须重试成功");
    assert.deepEqual(columnNames(retried.database, TABLE).length, 8);
  } finally {
    retried.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("T1 · v13 → v14 不标脏全库：既有 source_files 不被标 -1，首个 sync 不重读未变文件", async () => {
  const { homeDir, databaseFile } = await makeCodexHome();
  const seed = new UsageStore({ homeDir, databaseFile });
  const firstSync = await seed.sync();
  assert.ok(firstSync.updatedFileCount >= 2, "夹具里至少两份 rollout");
  seed.close();

  const raw = new DatabaseSync(databaseFile);
  raw.exec(`DROP TABLE ${TABLE}; PRAGMA user_version = 13;`);
  const dirtyBefore = Number(
    raw.prepare("SELECT COUNT(*) AS n FROM source_files WHERE size = -1 OR mtime_ms = -1").get().n,
  );
  assert.equal(dirtyBefore, 0, "前置：种子库没有脏行");
  raw.close();

  const migrated = new UsageStore({ homeDir, databaseFile });
  try {
    await migrated.open();
    assert.equal(Number(migrated.database.prepare("PRAGMA user_version").get().user_version), 16);
    assert.equal(
      Number(
        migrated.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE size = -1 OR mtime_ms = -1").get().n,
      ),
      0,
      "13 → 14 迁移**不得**做无条件标脏（`UPDATE source_files SET size = -1` 是 v12 段的老做法）",
    );
    assert.equal(rowCount(migrated.database), 0, "不回填 ⇒ 空表");
    const secondSync = await migrated.sync();
    assert.equal(secondSync.updatedFileCount, 0, "迁移后第一个 sync 不得重读未变文件（无回填 ⇒ 与今日等价）");
  } finally {
    migrated.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 2) 对拍：DB 行 vs 真实 createCodexProjectionCache().entries()
// ---------------------------------------------------------------------------

test("T1 · 对拍：DB 行的 path/method_version/bytes/fingerprint 与内存 entries() 逐字节相同", async () => {
  const { homeDir, databaseFile } = await makeBareStore();
  const store = new UsageStore({ homeDir, databaseFile });
  try {
    await store.open();
    const inner = createCodexProjectionCache();
    const cache = createPersistentCodexProjectionCache({ database: store.database, inner });
    const filePath = path.join(homeDir, "case-parity", "Rollout-A.jsonl");
    const fingerprints = { [filePath]: "fingerprint-parity-1" };
    const projection = sampleProjection(1);

    assert.equal(cache.stage({ homeId: "home-parity", kind: "codex", filePath, fingerprints, projection }), true);
    assert.equal(cache.commit("home-parity"), 1);

    const memory = inner.entries();
    assert.equal(memory.length, 1, "内存里必须恰好一条");
    const rows = storeRows(store.database);
    assert.equal(rows.length, 1, "库里必须恰好一条");

    // 逐字节相同（不是"看起来一样"）：path / method_version / fingerprint / bytes。
    assert.equal(rows[0].path, memory[0].path, "path 必须与内存键逐字节相同");
    assert.equal(rows[0].method_version, memory[0].methodVersion, "method_version 必须与内存逐字节相同");
    assert.equal(rows[0].fingerprint, memory[0].fingerprint, "fingerprint 必须与内存逐字节相同");
    assert.equal(rows[0].bytes, memory[0].bytes, "bytes 必须与内存同一口径");
    // 方法版本 = 复合版本，且与真实缓存的 stats() 自述一致。
    assert.equal(rows[0].method_version, inner.stats().methodVersion);
    assert.equal(cache.methodVersion(), inner.stats().methodVersion);
    assert.ok(rows[0].method_version.includes(":"), `复合版本必须含两个组成部分（实测 ${rows[0].method_version}）`);
    // bytes = projectionByteEstimate() 的镜像口径。
    assert.equal(rows[0].bytes, JSON.stringify(projection).length);
    assert.equal(rows[0].bytes, projectionStoreByteEstimate(projection));
    // 落盘的是**规范投影 JSON**，不是 raw JSONL：可解析回同一对象。
    assert.deepEqual(JSON.parse(rows[0].projection), projection);
    assert.equal(rows[0].kind, "codex");
    assert.equal(rows[0].home_id, "home-parity");
    // updated_at 只是墙钟诊断，不参与失效判定。
    assert.ok(!Number.isNaN(Date.parse(rows[0].updated_at)), "updated_at 必须是可解析的 ISO 墙钟");
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("T1 · 对拍：大小写变体（win32 折叠）下同一物理文件只落**一行**且等于内存键", async () => {
  const { homeDir, databaseFile } = await makeBareStore();
  const store = new UsageStore({ homeDir, databaseFile });
  try {
    await store.open();
    const inner = createCodexProjectionCache();
    const cache = createPersistentCodexProjectionCache({ database: store.database, inner });
    const upper = path.join(homeDir, "CaseVariant", "Rollout-C.jsonl").toUpperCase();
    const lower = upper.toLowerCase();

    // 第一次：路径键与窗口键**逐字相同** ⇒ 走 `Object.hasOwn` 快路径。
    assert.equal(
      cache.stage({
        homeId: "home-case",
        kind: "codex",
        filePath: upper,
        fingerprints: { [upper]: "fp-upper" },
        projection: sampleProjection(2),
      }),
      true,
    );
    assert.equal(cache.commit("home-case"), 1);
    // 第二次：窗口键是**小写**写法、查询路径是大写 ⇒ 必须走折叠索引并落到同一个键。
    assert.equal(
      cache.stage({
        homeId: "home-case",
        kind: "codex",
        filePath: lower,
        fingerprints: { [lower]: "fp-lower" },
        projection: sampleProjection(3),
      }),
      true,
    );
    assert.equal(cache.commit("home-case"), 1);

    const memory = inner.entries();
    const rows = storeRows(store.database);
    const folded = process.platform === "win32";
    assert.equal(memory.length, 1, "内存缓存按规范路径只保留当前版本（一条）");
    assert.equal(
      rows.length,
      folded ? 1 : 2,
      folded ? "win32：同一物理文件的两种写法必须只落一行" : "非 win32：大小写是不同路径",
    );
    assert.equal(rows[0].path, memory[0].path, "DB 主键必须与内存键逐字节相同");
    if (folded) {
      assert.equal(rows[0].path, lower, "win32 折叠后应是全小写");
      assert.deepEqual(JSON.parse(rows[0].projection), sampleProjection(3), "同一行被替换（只保留当前版本）");
    }
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3) 方法版本变更：只失效必要行（复合版本两个组成部分各自被测到）
// ---------------------------------------------------------------------------

test("T1 · 方法版本变更只失效必要行：复合版本两个组成部分各自 bump 都失效、且不波及无关行", async () => {
  const { homeDir, databaseFile } = await makeBareStore();
  const store = new UsageStore({ homeDir, databaseFile });
  try {
    await store.open();
    const current = createCodexProjectionCache().stats().methodVersion; // `${PERF_METHOD_VERSION}:${CODEX_PROJECTION_METHOD_VERSION}`
    const separator = current.indexOf(":");
    assert.ok(separator > 0, `复合版本必须有分隔符（实测 ${current}）`);
    const perfPart = current.slice(0, separator);
    const projectionPart = current.slice(separator + 1);
    const perfBumped = `${perfPart}+bump:${projectionPart}`;
    const projectionBumped = `${perfPart}:${projectionPart}+bump`;
    assert.notEqual(perfBumped, current);
    assert.notEqual(projectionBumped, current);

    const seed = () => {
      store.database.prepare(`DELETE FROM ${TABLE}`).run();
      const insert = store.database.prepare(
        `INSERT INTO ${TABLE} (path, home_id, kind, method_version, fingerprint, bytes, projection, updated_at)
         VALUES (?, 'home-ver', 'codex', ?, 'fp', 2, '{}', '2026-10-09T00:00:00.000Z')`,
      );
      insert.run("c:\\t1\\v-current.jsonl", current);
      insert.run("c:\\t1\\v-perf-bump.jsonl", perfBumped);
      insert.run("c:\\t1\\v-projection-bump.jsonl", projectionBumped);
    };
    const eventsBefore = Number(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n);
    const sourcesBefore = Number(store.database.prepare("SELECT COUNT(*) AS n FROM source_files").get().n);

    const cases = [
      { label: "两个组成部分都不变", next: current, survivor: "c:\\t1\\v-current.jsonl" },
      { label: "只 bump PERF_METHOD_VERSION", next: perfBumped, survivor: "c:\\t1\\v-perf-bump.jsonl" },
      {
        label: "只 bump CODEX_PROJECTION_METHOD_VERSION",
        next: projectionBumped,
        survivor: "c:\\t1\\v-projection-bump.jsonl",
      },
    ];
    for (const item of cases) {
      seed();
      const cache = createPersistentCodexProjectionCache({ database: store.database, methodVersion: item.next });
      const report = cache.invalidateStaleMethodVersions();
      // 前后行数：3 → 1，只删 2 行（= 版本不符的两行）。
      assert.deepEqual(
        { before: report.before, after: report.after, deleted: report.deleted },
        { before: 3, after: 1, deleted: 2 },
        `${item.label}：必须给出前后行数且只删不符的行`,
      );
      const survivors = storeRows(store.database).map((row) => row.path);
      assert.deepEqual(survivors, [item.survivor], `${item.label}：只有与当前版本相符的那行存活`);
    }

    // 按需路径（`lookup`）也必须同规则：版本不符 ⇒ miss + 删该行，**不**波及无关行。
    seed();
    const cache = createPersistentCodexProjectionCache({ database: store.database, methodVersion: perfBumped });
    const hit = cache.lookup({
      homeId: "home-ver",
      kind: "codex",
      filePath: "c:\\t1\\v-perf-bump.jsonl",
      fingerprints: { "c:\\t1\\v-perf-bump.jsonl": "fp" },
    });
    assert.deepEqual(hit, {}, "版本相符 + 指纹相符 ⇒ 命中（投影是空对象字面量）");
    assert.equal(
      cache.lookup({
        homeId: "home-ver",
        kind: "codex",
        filePath: "c:\\t1\\v-current.jsonl",
        fingerprints: { "c:\\t1\\v-current.jsonl": "fp" },
      }),
      undefined,
      "版本不符 ⇒ miss",
    );
    const left = storeRows(store.database)
      .map((row) => row.path)
      .sort();
    assert.deepEqual(
      left,
      ["c:\\t1\\v-perf-bump.jsonl", "c:\\t1\\v-projection-bump.jsonl"],
      "只删被查到的那个版本不符行",
    );

    // **不**无条件标脏全库：业务表一个字节都不动。
    assert.equal(Number(store.database.prepare("SELECT COUNT(*) AS n FROM events").get().n), eventsBefore);
    assert.equal(Number(store.database.prepare("SELECT COUNT(*) AS n FROM source_files").get().n), sourcesBefore);
    assert.equal(
      Number(store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE size = -1 OR mtime_ms = -1").get().n),
      0,
    );
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4) 事务性：写一半失败 / 未提交中断 ⇒ 无半行
// ---------------------------------------------------------------------------

test("T1 · 同 home 批量写单事务：第二行失败 ⇒ 整体回滚，库里**无半行**且不抛错", async () => {
  const { homeDir, databaseFile } = await makeBareStore();
  const store = new UsageStore({ homeDir, databaseFile });
  try {
    await store.open();
    const inner = createCodexProjectionCache();
    const cache = createPersistentCodexProjectionCache({
      database: failingDatabase(store.database, { failOnRun: 2 }),
      inner,
    });
    const fingerprints = { "c:\\t1\\w1.jsonl": "fp-1", "c:\\t1\\w2.jsonl": "fp-2" };
    cache.stage({
      homeId: "home-w",
      kind: "codex",
      filePath: "c:\\t1\\w1.jsonl",
      fingerprints,
      projection: sampleProjection(10),
    });
    cache.stage({
      homeId: "home-w",
      kind: "codex",
      filePath: "c:\\t1\\w2.jsonl",
      fingerprints,
      projection: sampleProjection(11),
    });
    // 内存侧照常提升（与今日一致）；库侧必须整体回滚。
    assert.equal(cache.commit("home-w"), 2);
    assert.equal(rowCount(store.database), 0, "**不得**留下半行（第 1 行也必须被回滚）");
    const stats = cache.stats().persistence;
    assert.equal(stats.writeFailures, 1);
    assert.equal(stats.persistedRows, 0);
    assert.equal(stats.writeTransactions, 0);
    // 失败后接缝仍可用（降级而不是崩）。
    assert.equal(cache.persistedRowCount(), 0);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("T1 · 未提交即中断（关连接）⇒ 重开后无半行（模拟进程在事务中途被杀）", async () => {
  const { homeDir, databaseFile } = await makeBareStore();
  const store = new UsageStore({ homeDir, databaseFile });
  await store.open();
  assert.equal(rowCount(store.database), 0);
  // 与接缝内部同款：SAVEPOINT → 写 1 行 → **不** RELEASE，直接关连接。
  store.database.exec("SAVEPOINT t1_crash");
  store.database
    .prepare(
      `INSERT INTO ${TABLE} (path, home_id, kind, method_version, fingerprint, bytes, projection, updated_at)
       VALUES ('c:\\t1\\crash.jsonl', 'home-crash', 'codex', 'v:0', 'fp', 2, '{}', '2026-10-09T00:00:00.000Z')`,
    )
    .run();
  store.close(); // 模拟进程消失：未提交的事务随连接关闭被回滚

  const reopened = new UsageStore({ homeDir, databaseFile });
  try {
    await reopened.open();
    assert.equal(rowCount(reopened.database), 0, "未提交的写必须被回滚 ⇒ 库里没有半行");
    assert.equal(Number(reopened.database.prepare("PRAGMA user_version").get().user_version), 16);
  } finally {
    reopened.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5) 损坏 blob ⇒ miss + 删行、不抛错；真 sync 不被打断
// ---------------------------------------------------------------------------

test("T1 · 损坏 blob ⇒ 视为 miss + 删该行，不抛错（失效即重算）", async () => {
  const { homeDir, databaseFile } = await makeBareStore();
  const store = new UsageStore({ homeDir, databaseFile });
  try {
    await store.open();
    const inner = createCodexProjectionCache();
    const cache = createPersistentCodexProjectionCache({ database: store.database, inner });
    const filePath = "c:\\t1\\corrupt.jsonl";
    const fingerprints = { [filePath]: "fp-corrupt" };
    cache.stage({ homeId: "home-c", kind: "codex", filePath, fingerprints, projection: sampleProjection(20) });
    assert.equal(cache.commit("home-c"), 1);
    store.database
      .prepare(`UPDATE ${TABLE} SET projection = '{ this is not json' WHERE path = 'c:\\t1\\corrupt.jsonl'`)
      .run();

    // 新的内存缓存 ⇒ 只有持久层能被查（不复用同进程内存命中）。
    const cold = createPersistentCodexProjectionCache({
      database: store.database,
      inner: createCodexProjectionCache(),
    });
    let result;
    assert.doesNotThrow(() => {
      result = cold.lookup({ homeId: "home-c", kind: "codex", filePath, fingerprints });
    }, "损坏 blob **不得**抛错");
    assert.equal(result, undefined, "损坏 blob 必须视为 miss（⇒ 调用方重新全文读）");
    assert.equal(rowCount(store.database), 0, "损坏行必须被删掉");
    assert.equal(cold.stats().persistence.corruptRows, 1);
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("T1 · 真 sync 不被打断：私有表被损坏后，一个有真变的轮次仍跑完且坏行被重算覆盖", async () => {
  const { homeDir, sessionDir, rolloutA, databaseFile } = await makeCodexHome();
  // 第三份 rollout：本轮**既不变也不损坏** ⇒ 它是"必须靠私有表水合"的那一份。
  const rolloutC = path.join(sessionDir, "rollout-t1-c.jsonl");
  await writeFile(rolloutC, codexRollout("t1-thread-c", "t1-turn-c1", { ordinalBase: 20, outputTokens: 900 }));
  // ── 实例 1：冷启动预热私有表 ─────────────────────────────────────────────────
  const first = new UsageStore({ homeDir, databaseFile });
  await first.open();
  // **测试侧**把接缝接到产品实例上（等价于 T2 的那一行接线；产品文件不改一个字节）。
  first.codexProjections = createPersistentCodexProjectionCache({ database: first.database });
  const firstSync = await first.sync();
  assert.ok(firstSync.updatedFileCount >= 3);
  const rowsAfterFirst = storeRows(first.database);
  assert.ok(rowsAfterFirst.length >= 3, `稳定 sync 后应落盘投影（实测 ${rowsAfterFirst.length} 行）`);
  first.close();

  // ── 让第 1 份 rollout **真变**（追加一帧合法 token_usage，新 turn：归属不变、内容与指纹必变）──
  await appendFile(
    rolloutA,
    `${JSON.stringify(extraTokenFrame("t1-thread-a", "t1-turn-a2", 5, 321, "2026-10-09T02:30:00.000Z"))}\n`,
  );

  // ── 同时把**第 2 份**的 blob 弄坏（第 3 份保持干净）────────────────────────────
  const victim = rowsAfterFirst.find((row) => row.path.includes("rollout-t1-b.jsonl"));
  assert.ok(victim, "夹具里必须有 rollout-t1-b 的行");
  const raw = new DatabaseSync(databaseFile);
  raw.prepare(`UPDATE ${TABLE} SET projection = 'not json at all' WHERE path = ?`).run(victim.path);
  raw.close();

  // ── 实例 2：冷态 + 真变轮 ⇒ 未变文件从私有表水合、坏 blob miss 重算、sync 不抛 ──────────
  const second = new UsageStore({ homeDir, databaseFile });
  try {
    await second.open();
    second.codexProjections = createPersistentCodexProjectionCache({ database: second.database });
    const result = await second.sync(); // 必须**不抛**
    assert.ok(Number.isFinite(Number(result.updatedFileCount)));
    const stats = second.codexProjections.stats().persistence;
    assert.ok(stats.corruptRows >= 1, `损坏 blob 必须被计到（实测 ${stats.corruptRows}）`);
    assert.ok(
      stats.hydratedRows >= 1,
      `冷态真变轮必须从私有表水合未变文件（实测 ${stats.hydratedRows}）—— 证明 planner 真的走了接缝`,
    );
    // 坏行被重算后覆盖回**合法** JSON。
    const restored = second.database.prepare(`SELECT projection FROM ${TABLE} WHERE path = ?`).get(victim.path);
    assert.ok(restored, "重算后该路径必须重新落盘");
    assert.equal(typeof JSON.parse(String(restored.projection)), "object", "重算后的 blob 必须是合法 JSON");
    for (const row of storeRows(second.database)) {
      assert.doesNotThrow(() => JSON.parse(String(row.projection)), `${row.path} 的 blob 必须是合法 JSON`);
    }
    assert.equal(Number(second.database.prepare("PRAGMA foreign_key_check").all().length), 0);
  } finally {
    second.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6) rollback / prune / retainHomes / clear 与 close 的淘汰契约
// ---------------------------------------------------------------------------

test("T1 · rollback 不写库；prune/retainHomes 与内存同一淘汰契约；clear 不清表", async () => {
  const { homeDir, databaseFile } = await makeBareStore();
  const store = new UsageStore({ homeDir, databaseFile });
  try {
    await store.open();
    const inner = createCodexProjectionCache();
    const cache = createPersistentCodexProjectionCache({ database: store.database, inner });
    const fp = { "c:\\t1\\r1.jsonl": "fp-1", "c:\\t1\\r2.jsonl": "fp-2" };

    // rollback ⇒ 不写库
    cache.stage({
      homeId: "home-r",
      kind: "codex",
      filePath: "c:\\t1\\r1.jsonl",
      fingerprints: fp,
      projection: sampleProjection(30),
    });
    cache.rollback("home-r");
    assert.equal(rowCount(store.database), 0, "rollback 不得写库");
    assert.equal(inner.entries().length, 0, "rollback 也不得提升内存条目");

    // commit ⇒ 两条
    cache.stage({
      homeId: "home-r",
      kind: "codex",
      filePath: "c:\\t1\\r1.jsonl",
      fingerprints: fp,
      projection: sampleProjection(30),
    });
    cache.stage({
      homeId: "home-r",
      kind: "codex",
      filePath: "c:\\t1\\r2.jsonl",
      fingerprints: fp,
      projection: sampleProjection(31),
    });
    assert.equal(cache.commit("home-r"), 2);
    assert.equal(rowCount(store.database), 2);

    // prune(homeId, expectedPaths) ⇒ 删本 home 不在当前路径集的行
    assert.equal(cache.prune("home-r", ["c:\\t1\\r1.jsonl"]), 1);
    assert.deepEqual(
      storeRows(store.database).map((row) => row.path),
      ["c:\\t1\\r1.jsonl"],
    );
    assert.equal(cache.stats().persistence.prunedRows, 1);

    // 另一个 home 的行 + retainHomes 只留指定 home
    const fp2 = { "c:\\t1\\r3.jsonl": "fp-3" };
    cache.stage({
      homeId: "home-other",
      kind: "codex",
      filePath: "c:\\t1\\r3.jsonl",
      fingerprints: fp2,
      projection: sampleProjection(32),
    });
    assert.equal(cache.commit("home-other"), 1);
    assert.equal(rowCount(store.database), 2);
    assert.equal(cache.retainHomes([]), 2, "内存侧淘汰 2 条（home-r 的 r1 + home-other 的 r3）");
    assert.equal(rowCount(store.database), 0, "retainHomes([]) ⇒ 库里的行全删");
    assert.equal(cache.stats().persistence.retainedRows, 2);

    // clear() 只清内存：先造回一行，再 clear
    cache.stage({
      homeId: "home-r2",
      kind: "codex",
      filePath: "c:\\t1\\r1.jsonl",
      fingerprints: fp,
      projection: sampleProjection(33),
    });
    assert.equal(cache.commit("home-r2"), 1);
    assert.equal(inner.entries().length, 1);
    cache.clear();
    assert.equal(cache.stats().entries, 0, "stats().entries 是**纯内存**口径：clear()/close() 后必须归零");
    assert.equal(inner.entries().length, 0, "clear() 必须清内存");
    assert.equal(cache.persistedRowCount(), 1, "持久行数**另开**（persistedRowCount），不得混入 stats()");
    assert.equal(rowCount(store.database), 1, "clear()/close() **不得**清表（跨实例复用正是 T2 的目的）");
  } finally {
    store.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("T1 · 跨实例复用：水合命中 + commit 不重写行（updated_at 不变）", async () => {
  const { homeDir, databaseFile } = await makeBareStore();
  const filePath = "c:\\t1\\cross.jsonl";
  const fingerprints = { [filePath]: "fp-cross" };
  const projection = sampleProjection(40);
  const store = new UsageStore({ homeDir, databaseFile });
  let stamp = "2026-10-09T01:00:00.000Z";
  try {
    await store.open();
    const first = createPersistentCodexProjectionCache({
      database: store.database,
      inner: createCodexProjectionCache(),
      now: () => stamp,
    });
    first.stage({ homeId: "home-x", kind: "codex", filePath, fingerprints, projection });
    assert.equal(first.commit("home-x"), 1);
    const before = storeRows(store.database)[0];
    assert.equal(before.updated_at, stamp);
  } finally {
    store.close();
  }

  // 新实例、新内存缓存、**不同** now：跨实例只能靠私有表命中。
  stamp = "2026-10-09T02:00:00.000Z";
  const reopened = new UsageStore({ homeDir, databaseFile });
  try {
    await reopened.open();
    const inner = createCodexProjectionCache();
    const second = createPersistentCodexProjectionCache({ database: reopened.database, inner, now: () => stamp });
    const hit = second.lookup({ homeId: "home-x", kind: "codex", filePath, fingerprints });
    assert.deepEqual(hit, projection, "关闭/重开后必须能从私有表水合出同一份投影");
    assert.equal(second.stats().persistence.hydratedRows, 1);
    // 水合后 commit：内存提升，但**不**重写库里的行（避免每轮全表写放大）。
    assert.equal(second.commit("home-x"), 1);
    assert.equal(second.stats().persistence.persistedRows, 0, "水合回来的行不得再写一遍");
    const after = storeRows(reopened.database);
    assert.equal(after.length, 1);
    assert.equal(after[0].updated_at, "2026-10-09T01:00:00.000Z", "水合+commit 不得改写 updated_at");
    assert.deepEqual(
      inner.entries().map((entry) => entry.path),
      [after[0].path],
    );
  } finally {
    reopened.close();
    await rm(homeDir, { recursive: true, force: true });
  }
});
