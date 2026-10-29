// T2 卡 —— 把 T1 的**私有持久投影**接进 Codex planner 之后的**产品级**端到端验证。
//
// 为什么单独一个文件：T1 的 `test/perf-projection-store.test.js` 验证的是**接缝本身**（把
// `createPersistentCodexProjectionCache` 手工挂到实例上）；本文件的靶子是**产品的缺省接线**
// —— `open()` 之后 `UsageStore` 自己就把这个包装装上（T2 的那一行），因此这里**不**注入任何东西，
// 走的就是 `sync()` 的真实路径。
//
// 判据口径（必须写清楚，否则"没有重读"只是口号）：
//   * 产品 sync 使用 lazy transient lookup：持久行命中只计 `persistence.hydratedRows`，不会把整个
//     home 的 parsed projection 留在内存；
//   * 指纹、方法版本或损坏 blob 失配时，持久层定向删行并分别计入
//     `staleFingerprintRows` / `invalidatedRows` / `corruptRows`；
//   * 只有受影响线程的 lazy 读取会进入 `stage()`，并在该线程构建前提交，计入 `persistedRows`；
//   * `stats().entries` 在 lazy planner 路径保持 0；跨实例复用由 `persistedRowCount()` 与上述
//     persistence 计数共同证明。
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexProjectionCache } from "../src/perf-sources/codex-thread.js";
import { UsageStore } from "../src/usage-store.js";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "t2-planner-wiring-"));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));

/** 钉住的 mtime（秒，带小数）：让夹具与断言不受墙钟影响。 */
const PINNED_SECONDS = 1_800_000_000.123;
let caseSeq = 0;

/** 一条健康回合序列（与 `test/perf-codex-index.test.js` 的 C3 夹具同型，独立实现避免跨文件耦合）。 */
function rolloutLines(threadId, { output = 120, turn = "Turn-1" } = {}) {
  return [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, session_id: threadId, source: "cli" } }),
    JSON.stringify({ type: "turn_context", payload: { thread_id: threadId, turn_id: turn, model: "T2-Model" } }),
    JSON.stringify({
      type: "token_usage_record",
      timestamp: "2026-10-04T12:00:01.000Z",
      payload: {
        thread_id: threadId,
        turn_id: turn,
        response_id: `resp-${threadId}-${turn}`,
        usage: { output_tokens: output },
        turn_token_usage: { output_tokens: output },
      },
    }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: threadId,
        turn_id: turn,
        item: { id: `I-${turn}`, type: "AgentMessage" },
        started_at_ms: 1000,
        completed_at_ms: 1400,
      },
    }),
  ];
}

function writeRollout(file, threadId, options) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${rolloutLines(threadId, options).join("\n")}\n`, "utf8");
  utimesSync(file, PINNED_SECONDS, PINNED_SECONDS);
  return file;
}

/** 3 份 rollout 的 codex home：A/B/C；`serverOptions` 里**同一个** `databaseFile`（跨实例复用的通道）。 */
function makeHome() {
  const root = path.join(ROOT, `case-${++caseSeq}`);
  const homeDir = path.join(root, "codex");
  const sessionsDir = path.join(homeDir, "sessions", "2026", "10");
  const options = {
    homeDir: root,
    env: {},
    extraHomes: homeDir,
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
  return {
    root,
    homeDir,
    sessionsDir,
    reportOptions: options,
    serverOptions: {
      ...options,
      databaseFile: path.join(root, "index.sqlite"),
      importStoreFile: path.join(root, "imports.json"),
    },
    write: (letter, extra = {}) => {
      const threadId = `Thread-${letter}`;
      const file = path.join(sessionsDir, `rollout-${letter.toLowerCase()}.jsonl`);
      return { file, threadId, write: writeRollout(file, threadId, extra) };
    },
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 追加一个探针可见（size 变）的新回合并把 mtime 钉住。 */
function appendTurn(file, threadId, turn) {
  const text = readFileSync(file, "utf8");
  writeFileSync(file, `${text}${rolloutLines(threadId, { turn }).slice(2).join("\n")}\n`, "utf8");
  utimesSync(file, PINNED_SECONDS + 1, PINNED_SECONDS + 1);
}

/** 该线程已发布的候选（`sample_key` 里带线程 id）。序列化成 JSON 便于逐字节比较。 */
function samplesJson(store, threadId) {
  const rows = store.database
    .prepare("SELECT sample_key, output_tokens FROM perf_samples WHERE sample_key LIKE ? ORDER BY sample_key")
    .all(`%"${threadId}"%`);
  return JSON.stringify(rows.map((row) => ({ sample_key: String(row.sample_key), output_tokens: row.output_tokens })));
}

/** lazy planner 的持久层计数（累计值，故一律使用前后差分）。 */
function persistenceDelta(before, after) {
  const fields = ["hydratedRows", "staleFingerprintRows", "invalidatedRows", "corruptRows", "persistedRows"];
  return Object.fromEntries(fields.map((field) => [field, after.persistence[field] - before.persistence[field]]));
}

/** 私有表里**方法版本仍是当前值**的行数（业务侧只读查询，用于"只失效必要行"的前后行数）。 */
function currentVersionRows(store) {
  const version = store.codexProjections.methodVersion();
  return Number(
    store.database.prepare("SELECT COUNT(*) AS n FROM perf_codex_projections WHERE method_version = ?").get(version).n,
  );
}

test("T2 · 缺省接线：open() 之前是纯内存缓存，open()（sync）之后是 T1 的持久投影包装", async () => {
  const fixture = makeHome();
  const store = new UsageStore(fixture.serverOptions);
  try {
    // 未 open：构造器给的仍是纯内存 `createCodexProjectionCache()`（与 T1 接线前逐字节等价）。
    // 这一条是"接线点必须在 open() 里"的守卫：若把接线挪回构造器，`this.database` 还是 `null`
    // ⇒ 持久层会拿到 `database = null`，而 `stats().persistence` 照样存在 ——
    // 所以下面必须**同时**断言"真的连上了库"（`persistedRowCount()` 是数字而不是 null）。
    assert.equal(store.codexProjections.stats().persistence, undefined, "未 open ⇒ 只有内存缓存");
    fixture.write("A");
    await store.sync({ options: fixture.reportOptions });
    const stats = store.codexProjections.stats();
    assert.equal(stats.persistence?.table, "perf_codex_projections", "open() 之后必须接上私有持久表");
    assert.equal(store.codexProjections.persistedRowCount(), 1, "真读到的 1 份必须落盘（不是 null、不是 0）");
    assert.equal(stats.entries, 0, "lazy planner 不保留整个 home 的 parsed projection");
    assert.equal(stats.stagedEntries, 0, "受影响线程提交后不得残留暂存");
    assert.equal(stats.bytes, 0, "lazy planner 的常驻内存投影字节为 0");
    assert.equal(stats.persistence.persistedRows, 1, "只有真实构建的线程投影落盘");
    assert.equal(Array.isArray(store.perfCandidatesForRange(null)), true, "公共统计查询继续返回数组");
    assert.equal(Array.isArray(store.unplacedPerfSamples()), true, "公共 unplaced 查询继续返回数组");
  } finally {
    store.close();
    fixture.close();
  }
});

test("T2 · 冷启动边界：close() 后重开实例 + 1 份真变 ⇒ 未变文件从持久投影水合、**不重读**，发布结果不变", async () => {
  const fixture = makeHome();
  const a = fixture.write("A");
  fixture.write("B");
  fixture.write("C");
  const first = new UsageStore(fixture.serverOptions);
  const second = new UsageStore(fixture.serverOptions);
  try {
    await first.sync({ options: fixture.reportOptions });
    assert.equal(first.codexProjections.stats().entries, 0, "lazy planner 冷同步后不保留 parsed projection");
    assert.equal(first.codexProjections.persistedRowCount(), 3, "3 份都必须落盘");
    const bBefore = samplesJson(first, "Thread-B");
    const cBefore = samplesJson(first, "Thread-C");
    const aBefore = samplesJson(first, "Thread-A");
    first.close();
    // `close()` 只清内存、**不清表**（T1 设计页 §4）。
    assert.equal(first.codexProjections.stats().entries, 0, "close() 必须清空实例私有内存投影（C3 断言保持）");
    assert.equal(
      first.codexProjections.persistedRowCount(),
      null,
      "连接已关 ⇒ `persistedRowCount()` 返回 null（T1：null = 读不到，区别于 0 行）",
    );

    // 新实例（生产里对应"重启进程"）：内存是空的，唯一可能的复用通道就是持久表。
    await second.open();
    assert.equal(second.codexProjections.persistedRowCount(), 3, "持久行跨 close()/实例存活");
    assert.equal(second.codexProjections.stats().entries, 0, "新实例的内存缓存必须是空的");
    const before = second.codexProjections.stats();

    appendTurn(a.file, a.threadId, "Turn-2");
    const status = await second.sync({ options: fixture.reportOptions });
    assert.equal(status.perfState, "ready");
    const after = second.codexProjections.stats();
    assert.deepEqual(
      persistenceDelta(before, after),
      {
        hydratedRows: 2,
        staleFingerprintRows: 1,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 1,
      },
      "B/C 由持久投影水合；只有被改的 A 定向失效并作为受影响线程重新落盘",
    );
    assert.equal(
      after.persistence.staleFingerprintRows - before.persistence.staleFingerprintRows,
      1,
      "被改那份的持久行指纹不符 ⇒ 定向删行（只删它）",
    );
    assert.equal(
      after.persistence.persistedRows - before.persistence.persistedRows,
      1,
      "重读的 1 份写回（水合的 2 份不重写）",
    );
    assert.equal(after.entries, 0, "lazy planner 不把三份 parsed projection 留在内存");
    assert.equal(after.stagedEntries, 0, "逐线程提交后不得残留暂存");

    // 发布面：A 多一条新候选（真变生效），B/C 的候选**逐字节不变** ⇒ 水合回来的投影是新鲜的
    // （它照样过了 `evaluateCodexProjection()` 与前后指纹/路径集比较 —— 那条路径本卡一个字节没改）。
    assert.notEqual(samplesJson(second, "Thread-A"), aBefore, "A 的新回合必须被发布");
    assert.equal(samplesJson(second, "Thread-B"), bBefore, "B 由持久投影水合 ⇒ 已发布候选逐字节不变");
    assert.equal(samplesJson(second, "Thread-C"), cBefore, "C 同上");
  } finally {
    first.close();
    second.close();
    fixture.close();
  }
});

test("T2 · `stats()` 仍是纯内存口径：持久行在 `persistedRowCount()`；`clear()` 只清内存（不清表）", async () => {
  const fixture = makeHome();
  fixture.write("A");
  fixture.write("B");
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    assert.equal(store.codexProjections.stats().entries, 0, "lazy planner 的 parsed projection 常驻数为 0");
    assert.equal(store.codexProjections.persistedRowCount(), 2);
    store.codexProjections.clear();
    assert.equal(store.codexProjections.stats().entries, 0, "clear() 后内存归零（内存口径）");
    assert.equal(store.codexProjections.stats().bytes, 0, "clear() 后内存字节归零");
    assert.equal(store.codexProjections.persistedRowCount(), 2, "**表一行都不能少**（跨实例复用正是目的）");
    // 清内存后同一实例再来一轮（无变更 ⇒ 不进 planner）⇒ 表仍然完好。
    await store.sync({ options: fixture.reportOptions });
    assert.equal(store.codexProjections.persistedRowCount(), 2, "稳态轮不得动持久表");
  } finally {
    store.close();
    fixture.close();
  }
});

test("T2 · 方法版本失效（显式入口）：只删版本不符的行 + **前后行数**，业务表一个字节不动", async () => {
  const fixture = makeHome();
  fixture.write("A");
  fixture.write("B");
  fixture.write("C");
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const cache = store.codexProjections;
    assert.equal(cache.persistedRowCount(), 3);
    assert.equal(currentVersionRows(store), 3, "前置：3 行都是当前复合版本");
    const businessBefore = JSON.stringify(
      store.database.prepare("SELECT * FROM perf_samples ORDER BY sample_key").all(),
    );

    const victim = String(
      store.database.prepare("SELECT path FROM perf_codex_projections ORDER BY path LIMIT 1").get().path,
    );
    store.database.prepare("UPDATE perf_codex_projections SET method_version = 'stale:1' WHERE path = ?").run(victim);
    const swept = cache.invalidateStaleMethodVersions();
    assert.deepEqual(
      { before: swept.before, after: swept.after, deleted: swept.deleted },
      { before: 3, after: 2, deleted: 1 },
      "定向失效：恰好删 1 行（前后行数可判定）",
    );
    assert.equal(cache.persistedRowCount(), 2);
    assert.equal(currentVersionRows(store), 2, "剩下 2 行仍是当前版本 ⇒ 不是'全库标脏'");
    assert.equal(
      JSON.stringify(store.database.prepare("SELECT * FROM perf_samples ORDER BY sample_key").all()),
      businessBefore,
      "业务表（perf_samples）逐字节不变",
    );
    assert.equal(
      Number(store.database.prepare("SELECT COUNT(*) AS n FROM source_files WHERE size = -1").get().n),
      0,
      "不得顺手标脏 source_files（那是'无条件全库重算'的做法）",
    );
  } finally {
    store.close();
    fixture.close();
  }
});

test("T2 · 方法版本失效（lookup 路径，跨实例）：版本不符的行由 `lookup()` 定向删除 + 只重读它", async () => {
  const fixture = makeHome();
  const a = fixture.write("A");
  const b = fixture.write("B");
  fixture.write("C");
  const first = new UsageStore(fixture.serverOptions);
  const second = new UsageStore(fixture.serverOptions);
  try {
    await first.sync({ options: fixture.reportOptions });
    const bBefore = samplesJson(first, "Thread-B");
    // 把 B 的行标成"旧方法版本"：这正是真实 bump 之后库里会出现的样子（比较在 `lookup ④`）。
    const bEntry = first.database
      .prepare("SELECT path FROM perf_codex_projections WHERE path LIKE ?")
      .get("%rollout-b.jsonl");
    assert.ok(bEntry, "前置：B 的行必须存在");
    first.database
      .prepare("UPDATE perf_codex_projections SET method_version = 'stale:1' WHERE path = ?")
      .run(bEntry.path);
    assert.equal(currentVersionRows(first), 2);
    first.close();

    // 新实例 ⇒ 内存全空 ⇒ 3 份都走持久表；A 真变 ⇒ 整 home 重新规划。
    await second.open();
    const before = second.codexProjections.stats();
    appendTurn(a.file, a.threadId, "Turn-2");
    const status = await second.sync({ options: fixture.reportOptions });
    assert.equal(status.perfState, "ready");
    const after = second.codexProjections.stats();
    assert.deepEqual(
      persistenceDelta(before, after),
      {
        hydratedRows: 1,
        staleFingerprintRows: 1,
        invalidatedRows: 1,
        corruptRows: 0,
        persistedRows: 1,
      },
      "C 水合；A 因真变、B 因旧方法版本各自 miss；只有受影响的 A 线程需要重新落盘",
    );
    assert.equal(
      after.persistence.invalidatedRows - before.persistence.invalidatedRows,
      1,
      "版本不符的行由 `lookup()` 定向删除（只删那 1 行）",
    );
    assert.equal(second.codexProjections.persistedRowCount(), 2, "未受影响的 B 不因 proof-only 读取而重新落盘");
    assert.equal(currentVersionRows(second), 2, "库里只剩 A/C 两条当前版本；B 等实际重建时懒修复");
    assert.equal(
      second.database
        .prepare("SELECT COUNT(*) AS n FROM perf_codex_projections WHERE path LIKE ?")
        .get("%rollout-b.jsonl").n,
      0,
      "旧方法版本行必须已经被 lookup 定向删除",
    );
    assert.equal(samplesJson(second, "Thread-B"), bBefore, "B 重读后候选值不变（内容没变）");

    // B 真正变化时才需要构建其线程；此时 lazy 读取把合法投影重新落盘。
    const beforeRepair = second.codexProjections.stats();
    appendTurn(b.file, b.threadId, "Turn-2");
    const repaired = await second.sync({ options: fixture.reportOptions });
    assert.equal(repaired.perfState, "ready");
    const afterRepair = second.codexProjections.stats();
    assert.deepEqual(
      persistenceDelta(beforeRepair, afterRepair),
      {
        hydratedRows: 2,
        staleFingerprintRows: 0,
        invalidatedRows: 0,
        corruptRows: 0,
        persistedRows: 1,
      },
      "B 真变后 lazy 构建只重新落盘 B；A/C 仍从持久行水合",
    );
    assert.equal(second.codexProjections.persistedRowCount(), 3, "懒修复后当前文件集恢复为 3 行");
    assert.equal(currentVersionRows(second), 3, "修复后的 B 行使用当前方法版本");
    assert.notEqual(samplesJson(second, "Thread-B"), bBefore, "B 真变后公共候选数组必须发布新值");
  } finally {
    first.close();
    second.close();
    fixture.close();
  }
});

test("T2 · 内存预算不变：缺省实例仍是 64 MiB LRU（接线只加一条二级来源，不改预算）", async () => {
  const fixture = makeHome();
  fixture.write("A");
  const store = new UsageStore(fixture.serverOptions);
  try {
    await store.sync({ options: fixture.reportOptions });
    const stats = store.codexProjections.stats();
    assert.equal(stats.maxBytes, 64 * 1024 * 1024, "缺省 LRU 预算必须仍是 64 MiB（C6 §2 的口径）");
    const bare = createCodexProjectionCache();
    assert.equal(bare.stats().maxBytes, stats.maxBytes);
    assert.equal(bare.stats().methodVersion, stats.methodVersion, "复合方法版本必须与内存缓存逐字相同");
  } finally {
    store.close();
    fixture.close();
  }
});
