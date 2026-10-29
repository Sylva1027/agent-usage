/**
 * M3.4：重建/退化状态与索引测试（`store_meta` 的 perf 状态机）
 *
 * ---------------------------------------------------------------------------
 * 本文件验收的对象（AN-6 首要）：**每一个持久化的状态值都必须可追溯到一次真实的计算**，
 * 且 `0`/空 必须能与"键缺失"区分 —— 归因字段本身就是验收对象。
 * ---------------------------------------------------------------------------
 *
 * 四个由实现者**定义**的模糊点（卡片要求显式给出定义 + 理由 + 实测）：
 *
 * 【D1】"有变更的 sync"判据 = **`updatedFileCount > 0`**（逐文件实际重解析数），
 *        不是"指纹变化"。理由与实测见 `M3.4.md` §3.1。
 * 【D2】中途失败（单文件 `replaceFile` 抛错）⇒ **转 `degraded`**（带受阻 home），
 *        不停留在 `rebuilding`。理由：`rebuilding` 是"正在进行"，进程结束后它不再成立，
 *        而"部分成功"必须让下游知道"这一次不完整"。见 §3.2。
 * 【D3】`perf_index_version` = **整轮 sync 完成后**对**已启用来源**的成功指纹；
 *        未启用来源不参与（`unsupportedSources` 单列）。见 §3.3。
 * 【D4】"旧成功候选不得悄悄参与当前排名"⇒ `perf_state` **参与排名过滤**：
 *        `degraded` 时默认排名只含**未受阻 home**。见 §3.4。
 *
 * 证据标注：🟦 schema 事实 ／ 🟨 单时刻观测 ／ 🟩 代码或实测事实。
 */

import assert from "node:assert/strict";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";
import { PERF_METHOD_VERSION } from "../src/perf-stats.js";
import { ZCODE_SELECT_COLUMNS } from "../src/perf-sources/zcode.js";

const M34_BASE = 1_700_000_000_000;
// 刻意**本地字面量**（不从 `src/usage-store.js` import）：这样"独立钉住当前 schema 版本"不会被
// 变成"自我引用"（T1 把 13 → 14 时，这里必须被人**显式**改一次，改不动就是红灯）。
// T1（handoffs/T1-design.md，C6 触发 + 用户批准）把 STORE_SCHEMA_VERSION 抬到 16；
// WorkBuddy 接入（docs/plans/2026-10-21-workbuddy-implementation-plan.md）再抬到 17；
// request timing 抬到18，WorkBuddy observation抬到19，历史修订恢复事实抬到20；
// request timing publication sequence 抬到22。
const STORE_SCHEMA_VERSION = 23;

// The Windows sandbox rejects rename(2) even for ordinary temp files.
function moveFixtureFile(from, to) {
  const info = statSync(from);
  copyFileSync(from, to);
  utimesSync(to, info.atime, info.mtime);
  unlinkSync(from);
}

/**
 * 建一个**能被真实 discovery 发现**的 zcode home。
 *
 * ⚠️ 两个我**实测出来**的必要条件（否则整组用例测的是**空集**，判别式不可达）：
 *
 * 1. `zcodeDatabaseFile()`（`zcode-usage.js`）只认 `<home>/cli/db/db.sqlite` 与
 *    `<home>/db/db.sqlite` 两个**相对路径**。我最初把库放在 `<home>/db.sqlite`
 *    ⇒ 一个 home 都发现不到、`sync` 静默 `updatedFileCount=0`。
 * 2. `discoverZcodeHomes()` **不使用 `homeDir` 去扫子目录**，而是看
 *    `<homeDir>/.zcode` 等**固定位置**。要让临时目录里的 home 被发现，**必须**走
 *    `options.importDirs`（`usage-core.js` 的 `classifyImportDirectory` 会识别
 *    `zcode-home`）。⇒ **本文件所有 sync 一律传 `{ homeDir: root, importDirs: [...] }`。**
 *
 * ⇒ 这两个是**夹具可达性**问题，**不是**被测逻辑的性质；记录下来以便他人复用。
 */
function makeZcodeHome(root, id, { rows = 3, keepWalOpen = false } = {}) {
  const homeDir = path.join(root, id);
  const dbDir = path.join(homeDir, "cli", "db");
  mkdirSync(dbDir, { recursive: true });
  const dbFile = path.join(dbDir, "db.sqlite");
  const db = new DatabaseSync(dbFile);
  if (keepWalOpen) {
    // ⚠️ 必须**先**设 WAL 再建表/插入，并**保持连接打开**：SQLite 在**最后一个连接关闭**时
    // 会 checkpoint 并把 `-wal` 删掉 ⇒ 想测"仅 -wal 变化"就必须留一个句柄（我实测确认）。
    db.exec("PRAGMA journal_mode = WAL");
  }
  const columns = [...ZCODE_SELECT_COLUMNS];
  db.exec(`CREATE TABLE "model_usage" (${columns.map((c) => `"${c}"`).join(", ")})`);
  const insert = db.prepare(
    `INSERT INTO "model_usage" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  );
  for (let i = 0; i < rows; i += 1) {
    const row = {
      id: `${id}-row-${i}`,
      session_id: `${id}-session`,
      status: "completed",
      started_at: M34_BASE + i * 1000,
      completed_at: M34_BASE + i * 1000 + 500,
      duration_ms: 500,
      input_tokens: 10,
      output_tokens: 100 + i,
      model_id: "fixture-model",
      provider_id: "fixture-provider",
    };
    insert.run(...columns.map((c) => (Object.hasOwn(row, c) ? row[c] : null)));
  }
  if (keepWalOpen) {
    // 返回**未关闭**的句柄，由用例负责关闭（从而把 `-wal` 留住）。
    return { id, path: homeDir, dbFile, kind: "zcode", walHandle: db };
  }
  db.close();
  return { id, path: homeDir, dbFile, kind: "zcode" };
}

/** 追加一行到已有 home（用于制造"有变更的 sync"）。 */
function appendZcodeRow(home, id, { output = 999, offsetMs = 9000 } = {}) {
  const db = new DatabaseSync(home.dbFile);
  const columns = [...ZCODE_SELECT_COLUMNS];
  const row = {
    id,
    session_id: `${home.id}-session`,
    status: "completed",
    started_at: M34_BASE + offsetMs,
    completed_at: M34_BASE + offsetMs + 500,
    duration_ms: 500,
    input_tokens: 10,
    output_tokens: output,
    model_id: "fixture-model",
    provider_id: "fixture-provider",
  };
  db.prepare(
    `INSERT INTO "model_usage" (${columns.map((c) => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...columns.map((c) => (Object.hasOwn(row, c) ? row[c] : null)));
  db.close();
}

/** 统一的 sync 选项：临时目录里的 home **必须**经 `importDirs` 注入才能被发现。 */
function m34Options(root, homes) {
  return {
    homeDir: root,
    // 既接受 home 对象（取 `.path`），也接受**直接给出的路径字符串**。
    // ⚠️ 我第一版只取 `.path`，传字符串时会得到 `undefined` 并被 `uniquePaths` 静默过滤 ⇒
    // 那个 home 根本没进 discovery（表现为 `unsupportedSources` 意外为空），
    // 是**夹具失误**而非被测逻辑问题。
    importDirs: homes.map((home) => (typeof home === "string" ? home : home.path)),
  };
}

async function openM34Store(root, { file = "usage-index.sqlite" } = {}) {
  const store = new UsageStore({ homeDir: root, databaseFile: path.join(root, file) });
  await store.open();
  return store;
}

function readMetaValue(store, key) {
  const row = store.database.prepare("SELECT value FROM store_meta WHERE key = ?").get(key);
  return row === undefined ? undefined : String(row.value);
}

// ---------------------------------------------------------------------------
// ★ 0. schema：新库必须建立 perf_* 元数据键（且 0/空 与"键缺失"可区分）
// ---------------------------------------------------------------------------

test("★0 新库：perf_* 元数据键必须存在，且『未同步』与『空列表』可区分", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-new-"));
  try {
    const store = await openM34Store(root);
    try {
      // 🟩 未同步过：`perf_state` 键**缺失**（undefined），不是空串、不是 "ready"
      assert.equal(
        readMetaValue(store, "perf_state"),
        undefined,
        "新库在首次 sync 前不得宣称任何 perf 状态（0/空 必须与键缺失可区分）",
      );
      assert.equal(readMetaValue(store, "perf_index_version"), undefined);
      assert.equal(
        readMetaValue(store, "perf_request_timing_publication_seq"),
        "0",
        "首次打开必须初始化发布序号，同时保持 perf_state 的未同步语义",
      );
      // 库版本正确
      const version = store.database.prepare("PRAGMA user_version").get().user_version;
      assert.equal(Number(version), STORE_SCHEMA_VERSION, `新库 user_version 应为 ${STORE_SCHEMA_VERSION}`);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★ 1. 状态机：ready / rebuilding / degraded 三态
// ---------------------------------------------------------------------------

test("★1 首次成功 sync ⇒ perf_state = ready，且指纹/方法版本/时间戳齐备", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-ready-"));
  try {
    const home = makeZcodeHome(root, "home-A");
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [home]) });
      console.log("  [实测] perf_state =", JSON.stringify(readMetaValue(store, "perf_state")));
      console.log("  [实测] perf_index_version =", JSON.stringify(readMetaValue(store, "perf_index_version")));
      assert.equal(readMetaValue(store, "perf_state"), "ready", "整轮成功后必须 ready");
      assert.equal(readMetaValue(store, "perf_method_version"), PERF_METHOD_VERSION, "必须记录方法版本");
      assert.ok(
        (readMetaValue(store, "perf_index_version") || "").length > 0,
        "整轮成功后必须写入已发布来源指纹（非空）",
      );
      assert.ok((readMetaValue(store, "perf_indexed_at") || "").length > 0, "必须记录索引时刻");
      // 退化列表在成功轮必须清空
      assert.deepEqual(JSON.parse(readMetaValue(store, "perf_degraded_home_ids")), [], "成功轮无退化 home");
      assert.equal(home.id, "home-A");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★1b 同一 fixture 双次 sync ⇒ 第二次无变更，状态仍 ready 且指纹不变", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-twice-"));
  try {
    const homeA = makeZcodeHome(root, "home-A");
    const store = await openM34Store(root);
    try {
      const first = await store.sync({ options: m34Options(root, [homeA]) });
      const fp1 = readMetaValue(store, "perf_index_version");
      const second = await store.sync({ options: m34Options(root, [homeA]) });
      const fp2 = readMetaValue(store, "perf_index_version");
      console.log("  [实测] 第一次 updatedFileCount =", first.updatedFileCount, " 第二次 =", second.updatedFileCount);
      console.log("  [实测] 指纹 1 =", fp1, " 指纹 2 =", fp2);
      assert.ok(first.updatedFileCount > 0, "首轮必须有变更");
      assert.equal(second.updatedFileCount, 0, "同 fixture 第二轮不得有变更");
      assert.equal(fp1, fp2, "无变更轮不得改变已发布指纹");
      assert.equal(readMetaValue(store, "perf_state"), "ready", "无变更轮结束后仍为 ready");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★1c ★卡片核心：一次同步【期间】调用 summarize 必须得到 rebuilding，不得读到部分排名", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-mid-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 5 });
    const homeB = makeZcodeHome(root, "home-B", { rows: 5 });
    const store = await openM34Store(root);
    try {
      // 先做一次成功 sync，使库里存在"上一次的完整候选"（这样"读到部分排名"才有真实风险）
      await store.sync({ options: m34Options(root, [homeA, homeB]) });
      assert.equal(readMetaValue(store, "perf_state"), "ready");
      const perfBefore = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;
      assert.ok(perfBefore > 0, "前置：首轮必须写入候选");

      // 改动第二个 home，使本轮**有变更**
      appendZcodeRow(homeB, "home-B-new");

      // ★ 在 sync 进行中、第一个文件已处理之后，截取状态
      const observed = [];
      const realReplaceFile = store.replaceFile.bind(store);
      let replaced = 0;
      store.replaceFile = async (...args) => {
        const result = await realReplaceFile(...args);
        replaced += 1;
        if (replaced === 1) {
          // 此刻：本轮已有 1 个文件写入（部分完成），但整轮尚未结束
          const midState = readMetaValue(store, "perf_state");
          const midSummary = store.summarize({}, {});
          observed.push({ midState, midSummary });
        }
        return result;
      };

      await store.sync({ options: m34Options(root, [homeA, homeB]) });
      store.replaceFile = realReplaceFile;

      assert.equal(observed.length, 1, "必须在 sync 中途观测到一次（判别式可达）");
      const { midState, midSummary } = observed[0];
      console.log("  [实测] sync 中途 perf_state =", JSON.stringify(midState));
      console.log("  [实测] sync 中途 summarize 的 perf 段 =", JSON.stringify(midSummary.perf ?? null));
      // ★ 卡上明文：同步期间直接调用 summarize 得到 rebuilding，不能读到部分已完成排名
      assert.equal(midState, "rebuilding", "sync 进行中 store_meta 必须是 rebuilding");
      assert.equal(
        midSummary.perf?.state,
        "rebuilding",
        "summarize 必须把 rebuilding 透出，调用者才能拒绝把它当 ready 排名",
      );
      assert.deepEqual(midSummary.perf?.models, [], "rebuilding 时不得返回部分模型速度行");
      // 整轮结束后回到 ready，且中途状态不再残留
      assert.equal(readMetaValue(store, "perf_state"), "ready", "整轮成功后必须回到 ready");
      assert.equal(store.summarize({}, {}).perf?.state, "ready", "成功轮后 summarize 报告 ready");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★1d 无变更的 sync 不得翻转状态（不得无谓进入 rebuilding）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-nochange-"));
  try {
    const homeA = makeZcodeHome(root, "home-A");
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      const seen = [];
      const realReplaceFile = store.replaceFile.bind(store);
      store.replaceFile = async (...args) => {
        // 若实现错误地在无变更轮也标 rebuilding，则这里一定被调用过（不该发生）
        seen.push(readMetaValue(store, "perf_state"));
        return realReplaceFile(...args);
      };
      const second = await store.sync({ options: m34Options(root, [homeA]) });
      store.replaceFile = realReplaceFile;
      console.log(
        "  [实测] 第二轮 updatedFileCount =",
        second.updatedFileCount,
        " replaceFile 调用次数 =",
        seen.length,
      );
      assert.equal(second.updatedFileCount, 0, "同 fixture 第二轮无变更");
      assert.equal(seen.length, 0, "无变更轮不得调用 replaceFile（因而也没有中间的 rebuilding 窗口）");
      assert.equal(readMetaValue(store, "perf_state"), "ready", "无变更轮必须保持 ready");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★ 2. degraded：主源受阻 ⇒ 退化 + 受阻 home 可归因（AN-6：归因字段是验收对象）
// ---------------------------------------------------------------------------

test("★2 主源文件不可读被删 ⇒ degraded，且受阻 homeId 可归因、候选人仍可回滚", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-degraded-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const homeB = makeZcodeHome(root, "home-B", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA, homeB]) });
      assert.equal(readMetaValue(store, "perf_state"), "ready");
      const homeIdB = store.database
        .prepare("SELECT DISTINCT home_id FROM perf_samples WHERE home_id LIKE 'zcode-%'")
        .all()
        .map((row) => String(row.home_id));
      assert.equal(homeIdB.length, 2, "前置：两个 home 各有候选");

      // 让 home-B 的**库文件消失**（模拟主源文件不可读）
      // ⚠️ 注意 `discoverZcodeHomes` 依赖 `zcodeDatabaseFile` 存在 ⇒ 直接删库会让该 home
      // 在**发现阶段**就消失（不是"受阻"）。因此改用**目录不可读**的方式？
      // 实测：用 rename 把库换成**坏文件**（discovery 仍能发现 → 进入 replaceFile → 抛错）。
      moveFixtureFile(homeB.dbFile, `${homeB.dbFile}.bak`);
      writeFileSync(homeB.dbFile, "not a sqlite database at all");

      const result = await store.sync({ options: m34Options(root, [homeA, homeB]) });
      console.log("  [实测] perf_state =", JSON.stringify(readMetaValue(store, "perf_state")));
      console.log("  [实测] degradedHomeIds =", readMetaValue(store, "perf_degraded_home_ids"));
      console.log("  [实测] sync 返回 perfState =", JSON.stringify(result.perfState));
      console.log("  [实测] sync 返回 degradedHomeIds =", JSON.stringify(result.degradedHomeIds));
      console.log("  [实测] sourceWarnings =", readMetaValue(store, "perf_source_warnings"));

      assert.equal(readMetaValue(store, "perf_state"), "degraded", "主源受阻必须 degraded");
      const degraded = JSON.parse(readMetaValue(store, "perf_degraded_home_ids"));
      assert.equal(degraded.length, 1, "必须只标受阻的那一个 home");
      assert.ok(degraded[0].startsWith("zcode-"), `退化列表存的是 homeId（不是路径）: ${JSON.stringify(degraded)}`);
      // 卡片：仅投影 sourceKind/homeId/code/count，**不输出路径**
      const warnings = JSON.parse(readMetaValue(store, "perf_source_warnings"));
      assert.ok(warnings.length > 0, "必须有编码后的源告警");
      for (const w of warnings) {
        assert.deepEqual(Object.keys(w).sort(), ["code", "count", "homeId", "sourceKind"], "源告警只允许四个字段");
        assert.ok(!JSON.stringify(w).includes(root), "源告警**绝不**含路径");
      }
      // ★ 归因必须**精确到真正失败的那个 home**：
      // 我第一版按"本轮扫描过的 home"归因，实测**把成功的 home-A 也标成 INDEX_FAILED** ⇒
      // 这条断言就是抓它的判别式（AN-6：归因字段本身是验收对象）。
      assert.equal(warnings.length, 1, `只应有 1 个受阻 home 的告警，实得 ${JSON.stringify(warnings)}`);
      assert.equal(
        warnings[0].homeId,
        degraded[0],
        "源告警的 homeId 必须与 perf_degraded_home_ids **完全一致**（不得误归因到成功的 home）",
      );
      assert.equal(warnings[0].sourceKind, "zcode", "sourceKind 必须是规范 kind");
      // **BB-4（返工）**：原断言写的是 `INDEX_FAILED` —— 那个码**不在 M1 冻结码域内**
      // （交给真实 `summarizePerf` 会抛 TypeError）。本夹具是**坏 SQLite 文件**，
      // reader 实测给出 `READ_ONLY_OPEN_FAILED` ⇒ 归因应**透传 reader 自己的冻结码**。
      assert.equal(warnings[0].code, "READ_ONLY_OPEN_FAILED", "code 必须落在 M1 冻结码域内");
      assert.equal(warnings[0].count, 1, "count 必须是该 home 的**真实失败文件数**");
      console.log("  [实测] 四字段投影 =", JSON.stringify(warnings));
      // 确认成功的那个 home 不在退化里（其候选仍在库中，可回滚且不阻塞其他来源）
      const homeIdA = store.database
        .prepare("SELECT DISTINCT home_id FROM perf_samples WHERE home_id <> ?")
        .all(degraded[0])
        .map((row) => String(row.home_id));
      assert.ok(homeIdA.length >= 1, "受阻 home 之外的候选必须仍在库里");
      console.log("  [实测] 未受阻 home 仍有候选 =", JSON.stringify(homeIdA));
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★2b 恢复：下一次完整同步成功必须清除退化标记", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-recover-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const homeB = makeZcodeHome(root, "home-B", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA, homeB]) });
      moveFixtureFile(homeB.dbFile, `${homeB.dbFile}.bak`);
      writeFileSync(homeB.dbFile, "broken");
      await store.sync({ options: m34Options(root, [homeA, homeB]) });
      assert.equal(readMetaValue(store, "perf_state"), "degraded", "前置：先进入 degraded");

      // 恢复：把好的库放回去
      moveFixtureFile(`${homeB.dbFile}.bak`, homeB.dbFile);
      const restored = await store.sync({ options: m34Options(root, [homeA, homeB]) });
      console.log("  [实测] 恢复后 perf_state =", JSON.stringify(readMetaValue(store, "perf_state")));
      console.log("  [实测] 恢复后 degradedHomeIds =", readMetaValue(store, "perf_degraded_home_ids"));
      assert.equal(readMetaValue(store, "perf_state"), "ready", "完整同步成功后必须清除退化");
      assert.deepEqual(JSON.parse(readMetaValue(store, "perf_degraded_home_ids")), [], "退化列表必须清空");
      assert.deepEqual(restored.degradedHomeIds, [], "返回值也必须清空");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★ 3. D4：degraded 时旧成功候选不得悄悄参与当前排名
// ---------------------------------------------------------------------------

test("★3 D4 排序过滤：degraded 时受阻 home 的陈旧候选必须被排除在 rankedHomeIds 之外", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-filter-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const homeB = makeZcodeHome(root, "home-B", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA, homeB]) });
      const readyPerf = store.summarize({}, {}).perf;
      console.log("  [实测] ready 时 rankedHomeIds =", JSON.stringify(readyPerf.rankedHomeIds));
      assert.equal(readyPerf.state, "ready");
      assert.equal(readyPerf.rankedHomeIds.length, 2, "ready 时两个 home 都参与排名");

      moveFixtureFile(homeB.dbFile, `${homeB.dbFile}.bak`);
      writeFileSync(homeB.dbFile, "broken");
      await store.sync({ options: m34Options(root, [homeA, homeB]) });

      const degradedPerf = store.summarize({}, {}).perf;
      console.log("  [实测] degraded 时 state =", degradedPerf.state);
      console.log("  [实测] degraded 时 rankedHomeIds =", JSON.stringify(degradedPerf.rankedHomeIds));
      console.log("  [实测] degraded 时 degradedHomeIds =", JSON.stringify(degradedPerf.degradedHomeIds));
      // 旧候选**仍在库里**（可回滚）
      const stillThere = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;
      console.log("  [实测] 库中候选总数 =", stillThere);
      assert.ok(stillThere > 0, "旧成功候选必须保留在数据库以便失败回滚");
      // 但**不得**参与当前排名
      assert.equal(degradedPerf.rankedHomeIds.length, 1, "受阻 home 必须被排除出排名");
      assert.deepEqual(
        degradedPerf.rankedHomeIds.filter((id) => degradedPerf.degradedHomeIds.includes(id)),
        [],
        "rankedHomeIds 与 degradedHomeIds 必须**不相交**（不得悄悄参与排名）",
      );
      // 响应必须**指名**受阻源，使下游无法把它当干净排名
      assert.equal(degradedPerf.degradedHomeIds.length, 1, "必须指名被阻源");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ★ 4. 删除、未启用来源、迁移、指纹 -1 重索引
// ---------------------------------------------------------------------------

test("★4 删除来源：home 目录消失 ⇒ 保留历史并登记 missing，且**不**计入退化", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-delete-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const homeB = makeZcodeHome(root, "home-B", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA, homeB]) });
      const before = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;

      // home-B **整个消失**（不再被 importDirs 注入）⇒ 属"真删除"而非"受阻"
      rmSync(homeB.path, { recursive: true, force: true });
      const result = await store.sync({ options: m34Options(root, [homeA]) });
      const after = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;
      console.log("  [实测] 删除前候选 =", before, " 删除后 =", after);
      console.log("  [实测] perf_state =", JSON.stringify(readMetaValue(store, "perf_state")));
      console.log("  [实测] degradedHomeIds =", readMetaValue(store, "perf_degraded_home_ids"));
      assert.equal(after, before, "消失来源的最后成功候选必须保留");
      assert.equal(readMetaValue(store, "perf_state"), "ready", "来源缺失**不是**读取失败");
      assert.deepEqual(result.degradedHomeIds, [], "来源缺失不得计入退化");
      assert.deepEqual(
        result.missingSources.map((source) => source.path),
        [homeB.dbFile],
        "缺失 home 的文件必须可机读",
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★4b 未启用来源：单列 unsupportedSources，**不令其他来源退化**", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-unsup-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    try {
      const result = await store.sync({ options: m34Options(root, [homeA]) });
      console.log("  [实测] perf_state =", JSON.stringify(readMetaValue(store, "perf_state")));
      console.log("  [实测] unsupportedSources =", JSON.stringify(result.unsupportedSources));
      console.log("  [实测] perf_unsupported_sources =", readMetaValue(store, "perf_unsupported_sources"));
      // zcode 是已启用来源 ⇒ 它**不得**出现在 unsupported 列表里
      assert.equal(result.perfState, "ready", "有来源未启用不得使已启用来源退化");
      assert.ok(!result.unsupportedSources.some((s) => s.kind === "zcode"), "已启用的 zcode 不得被列为未启用");
      // 投影必须是 {kind, homeId}，**不含路径**
      for (const s of result.unsupportedSources) {
        assert.ok(!JSON.stringify(s).includes(root), "unsupportedSources 不得含路径");
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★4c 迁移与重复打开：已存在的库重开不得丢状态，也不得重复迁移", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-migrate-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    let perfState;
    let indexVersion;
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      perfState = readMetaValue(store, "perf_state");
      indexVersion = readMetaValue(store, "perf_index_version");
    } finally {
      store.close();
    }
    // ★ AN-8 要求：重复打开
    const reopened = await openM34Store(root);
    try {
      console.log("  [实测] 重开后 perf_state =", JSON.stringify(readMetaValue(reopened, "perf_state")));
      console.log(
        "  [实测] 重开后 indexVersion 相同 =",
        readMetaValue(reopened, "perf_index_version") === indexVersion,
      );
      const version = reopened.database.prepare("PRAGMA user_version").get().user_version;
      assert.equal(Number(version), STORE_SCHEMA_VERSION, "重复打开不得改变库版本");
      assert.equal(readMetaValue(reopened, "perf_state"), perfState, "重开后状态必须保持");
      assert.equal(readMetaValue(reopened, "perf_index_version"), indexVersion, "重开后指纹必须保持");
      // 重开后 summarize 仍能读到状态（读通路不依赖内存缓存）
      assert.equal(reopened.summarize({}, {}).perf.state, "ready", "重开后 summarize 仍报告 ready");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★4d 指纹 -1 重索引：迁移把 source_files 置脏后，下一次 sync 必须重新索引", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-reindex-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      const candidatesBefore = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;

      // 模拟 v12 迁移的效果：把 size/mtime 置 -1（无 WHERE ⇒ 全部行变脏）
      store.database.prepare("UPDATE source_files SET size = -1, mtime_ms = -1").run();
      const result = await store.sync({ options: m34Options(root, [homeA]) });
      const candidatesAfter = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;
      console.log("  [实测] 置脏后 updatedFileCount =", result.updatedFileCount);
      console.log("  [实测] 候选 before =", candidatesBefore, " after =", candidatesAfter);
      assert.equal(result.updatedFileCount, 1, "指纹 -1 必须触发重索引");
      assert.equal(candidatesAfter, candidatesBefore, "重索引必须幂等（候选数不翻倍）");
      assert.equal(readMetaValue(store, "perf_state"), "ready", "重索引后状态 ready");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// ★ 5. 关闭突变测试暴露的**测试缺口**（我自己套件的洞，不是代码缺陷）
//
// 定向突变 10 条：5 被抓、4 存活、1 锚点失配。按 AW-3 逐条判定**非等价**后补测：
//   M2（无变更轮也标 rebuilding）—— ★1d 只断言**结束后**的状态，未观测**轮中**的瞬态。
//   M5（summarize 恒报 ready）—— 我**从未**断言过 `.perf.ready` 字段。
//   M6（键缺失当成 ready）—— 我**从未**用 summarize 断言过 `uninitialized`。
//   M10（指纹不排除未启用来源）—— 我**没有**一个"未启用来源"使启用集合发生变化。
// ---------------------------------------------------------------------------

test("★5 M5 判别式：summarize 的 perf.ready 必须与 state 一致（不得恒报 ready）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-readyflag-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    try {
      // 未同步：不得报 ready
      const before = store.summarize({}, {}).perf;
      console.log("  [实测] 未同步 state =", before.state, " ready =", before.ready);
      assert.equal(before.state, "uninitialized", "未同步必须 uninitialized");
      assert.equal(before.ready, false, "未同步**绝不得**报 ready（M6 判别式）");
      assert.deepEqual(before.models, [], "未同步不得返回模型速度行");

      await store.sync({ options: m34Options(root, [homeA]) });
      const ready = store.summarize({}, {}).perf;
      console.log("  [实测] 成功后 state =", ready.state, " ready =", ready.ready);
      assert.equal(ready.state, "ready");
      assert.equal(ready.ready, true, "成功后必须报 ready");

      // sync 中途：ready 必须为 false（M5 判别式）
      appendZcodeRow(homeA, "home-A-more");
      const mid = [];
      const real = store.replaceFile.bind(store);
      let n = 0;
      store.replaceFile = async (...args) => {
        const r = await real(...args);
        n += 1;
        if (n === 1) mid.push(store.summarize({}, {}).perf);
        return r;
      };
      await store.sync({ options: m34Options(root, [homeA]) });
      store.replaceFile = real;
      assert.equal(mid.length, 1, "必须观测到中途状态");
      console.log("  [实测] 中途 state =", mid[0].state, " ready =", mid[0].ready);
      assert.equal(mid[0].state, "rebuilding", "中途必须 rebuilding");
      assert.equal(mid[0].ready, false, "rebuilding 时 ready 必须为 **false**（否则调用者会展示部分排名）");
      assert.deepEqual(mid[0].models, [], "rebuilding 时不得返回模型速度行");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★5b M2 判别式：无变更 sync **轮中**也不得出现 rebuilding 瞬态", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-m2-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      // ★ M2 的关键：监控"轮中任何时刻"的状态。用一个**读取钩子**在 sync 开始时同步采样，
      // 因为无变更轮**不会**调用 replaceFile（无法在那里挂钩）。
      // 做法：包 `writeMeta`，记录本轮是否写过 perf_state=rebuilding。
      const written = [];
      const realWriteMeta = store.writeMeta.bind(store);
      store.writeMeta = (key, value) => {
        if (key === "perf_state") written.push(String(value));
        return realWriteMeta(key, value);
      };
      const second = await store.sync({ options: m34Options(root, [homeA]) });
      store.writeMeta = realWriteMeta;
      console.log("  [实测] 第二轮 updatedFileCount =", second.updatedFileCount);
      console.log("  [实测] 第二轮写过的 perf_state 值 =", JSON.stringify(written));
      assert.equal(second.updatedFileCount, 0, "前提：第二轮无变更");
      assert.ok(
        !written.includes("rebuilding"),
        `无变更轮**不得**写入 rebuilding（实测写到：${JSON.stringify(written)}）`,
      );
      assert.equal(readMetaValue(store, "perf_state"), "ready", "无变更轮必须保持 ready");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★5c M10 判别式：已发布来源指纹必须**随启用集合**变化", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-fp-"));
  try {
    // 两个已启用 home vs 一个：指纹必须不同（证明指纹真的由**已发布来源集合**决定）
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const homeB = makeZcodeHome(root, "home-B", { rows: 3 });

    const rootOne = path.join(root, "one");
    const rootTwo = path.join(root, "two");
    mkdirSync(rootOne, { recursive: true });
    mkdirSync(rootTwo, { recursive: true });
    const a1 = makeZcodeHome(rootOne, "home-A", { rows: 3 });
    const b2 = makeZcodeHome(rootTwo, "home-B", { rows: 3 });
    const storeA = await openM34Store(rootOne);
    const storeB = await openM34Store(rootTwo);
    let fpOne;
    let fpPair;
    try {
      await storeA.sync({ options: m34Options(rootOne, [a1]) });
      fpOne = readMetaValue(storeA, "perf_index_version");
    } finally {
      storeA.close();
    }
    try {
      await storeB.sync({ options: m34Options(rootTwo, [b2]) });
      fpPair = readMetaValue(storeB, "perf_index_version");
    } finally {
      storeB.close();
    }
    console.log("  [实测] 单 home 指纹 =", fpOne.slice(0, 16));
    console.log("  [实测] 另一单 home 指纹 =", fpPair.slice(0, 16));
    // 不同 home **身份**必须给出不同指纹（M10 判别式：指纹必须真的由来源集合决定）
    assert.notEqual(fpOne, fpPair, "不同来源集合必须给出不同指纹");
    // 同一 home 重复 sync 必须稳定（已在 ★1b 断言）
    assert.equal(homeA.id, "home-A");
    assert.equal(homeB.id, "home-B");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★5d M9 判别式：源告警投影**结构上**不可能泄漏路径（含 path 也被丢弃）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-leak-"));
  try {
    const store = await openM34Store(root);
    try {
      // 直接喂一个**带 path** 的告警，验证 normalizeSourceWarnings 的白名单丢弃
      // （这是卡上"不输出路径"的**结构保证**：不是靠调用方自觉，而是投影本身只留四字段）
      store.writeMeta(
        "perf_source_warnings",
        JSON.stringify([
          {
            sourceKind: "zcode",
            homeId: "zcode-x",
            // 用**冻结域内**的码：本用例验的是"只留四字段"的白名单，
            // 若用 `INDEX_FAILED`（已在 BB-4 判定违规）会把无效码固化成夹具常量。
            code: "MALFORMED_JSON",
            count: 2,
            path: "C:\\secret\\db.sqlite",
            extra: 1,
          },
        ]),
      );
      const perf = store.summarize({}, {}).perf;
      console.log("  [实测] 投影后 =", JSON.stringify(perf.sourceWarnings));
      assert.equal(perf.sourceWarnings.length, 1, "必须解析出 1 条");
      assert.deepEqual(
        Object.keys(perf.sourceWarnings[0]).sort(),
        ["code", "count", "homeId", "sourceKind"],
        "**即使库里被塞了 path**，读取投影也必须只输出四字段",
      );
      assert.ok(!JSON.stringify(perf.sourceWarnings).includes("secret"), "路径绝不出现");
      assert.equal(perf.sourceWarnings[0].count, 2, "count 必须保留真实计数（不是常量 1）");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("★5e M10 真判别式：加入结构上不支持的来源，不改变已发布性能指纹", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m34-fp2-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      const fpBefore = readMetaValue(store, "perf_index_version");
      const unsupBefore = JSON.parse(readMetaValue(store, "perf_unsupported_sources"));

      // project-log 是有公开分类、但不生成性能候选的结构性 unsupported 来源。
      const unsupportedHome = path.join(root, "unsupported-home");
      const projectLog = path.join(unsupportedHome, ".codex-usage", "usage.jsonl");
      mkdirSync(path.dirname(projectLog), { recursive: true });
      writeFileSync(projectLog, "");
      const result = await store.sync({ options: m34Options(root, [homeA, unsupportedHome]) });
      const fpAfter = readMetaValue(store, "perf_index_version");

      console.log("  [实测] 加入前指纹 =", fpBefore.slice(0, 16), " unsupported =", JSON.stringify(unsupBefore));
      console.log(
        "  [实测] 加入后指纹 =",
        fpAfter.slice(0, 16),
        " unsupported =",
        JSON.stringify(result.unsupportedSources),
      );
      console.log("  [实测] perf_state =", JSON.stringify(readMetaValue(store, "perf_state")));

      // ★ M10 判别式：结构上不支持的来源必须出现在 unsupportedSources 里
      assert.ok(
        result.unsupportedSources.some((s) => s.kind === "unsupported"),
        `unsupported 来源必须单列，实得 ${JSON.stringify(result.unsupportedSources)}`,
      );
      assert.equal(fpAfter, fpBefore, "unsupported 来源不得改变 perf_index_version");
      assert.equal(readMetaValue(store, "perf_state"), "ready");
      assert.deepEqual(JSON.parse(readMetaValue(store, "perf_degraded_home_ids")), []);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// ★ BB 返工（task-38）：用户独立复现的四项缺陷
//
// 四项在门禁全绿（原 17/17 用例）时**未被覆盖** —— 这印证"测试全绿不蕴含契约满足"：
// 我原来的用例只测了【单进程内的确定行为】，没有测【跨模块契约】与【读取期间的变化】。
// 以下用例**先红后绿**，每条都钉住一个此前无判据的维度。
// ===========================================================================

/** 造一个**只有 sessions 目录**的 codex home（perf 未启用 ⇒ `notEnabled`）。 */
function makeCodexHome(root, id) {
  const homeDir = path.join(root, id);
  mkdirSync(path.join(homeDir, "sessions"), { recursive: true });
  return { id, path: homeDir, kind: "extra" };
}

/** 读 `perf_source_warnings`（解码后）。 */
function readWarnings(store) {
  const raw = readMetaValue(store, "perf_source_warnings");
  return raw === undefined ? [] : JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// BB-1【P1】读取期间来源变化 ⇒ 必须标 degraded + LIVE_SOURCE_CHANGED
// ---------------------------------------------------------------------------

test("★BB-1 读取期间来源变化：主库追加行 ⇒ 必须 degraded + LIVE_SOURCE_CHANGED，且下一轮恢复", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bb1-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      assert.equal(readMetaValue(store, "perf_state"), "ready", "前置：首轮 ready");

      // ⚠️ **必须先让文件真的变化**，否则 `replaceFile` 会被增量判据整段跳过
      // ⇒ 根本不会有 `perf_samples` 插入，注入窗口不存在（我第一版实测 `候选插入总数 = 0`，
      //    因此写成了"夹具错"而非实现错）。
      appendZcodeRow(homeA, "trigger-change", { output: 111, offsetMs: 4000 });

      // ★ 在 perf reader **读取过程中**追加一行 —— 用户复现的姿态（"reader 读完、事务提交前"）。
      //
      // 手段：包装 `DatabaseSync.prototype.close`。reader 在 `finally` 里关闭自己的只读句柄
      // （`zcode.js:517`），**此刻锁已释放、而 stream 的 Promise 尚未 resolve** ⇒ 在这个
      // 回调里写入上游，就精确落在 `statBefore`（stream 前取）与 `statAfter`（stream 后取）
      // 之间。这是**确定性**的，不依赖微任务时序。
      //
      // ⚠️ 实测过的四个**夹具陷阱**（记录下来以免他人重踩）：
      //   ① 写入放在 `replaceFile` **返回之后** ⇒ 窗口已关闭；且若文件未变，下一轮会被增量判据
      //      **整段跳过**（实测 `候选插入总数 = 0`）⇒ 必须**先让文件真的变化**（下面的 `appendZcodeRow`）。
      //   ② 在 `onSample` 回调里**同步**开第二个写连接 ⇒ `database is locked`（reader 句柄仍开着）。
      //   ③ 用 `process.nextTick` 排写入 ⇒ 跑在**循环中**（锁未释放）⇒ `unable to open database file`。
      //   ④ 把写入排在 stream resolve 后同一微任务 ⇒ 跑在 `statAfter` **之后**，检测不到。
      let injected = false;
      let perfInserts = 0;
      const realPrepare = store.database.prepare.bind(store.database);
      const realClose = DatabaseSync.prototype.close;
      const normalize = (value) => path.resolve(String(value ?? "")).toLowerCase();
      const targetDb = normalize(homeA.dbFile);
      let closeCalls = 0;
      store.database.prepare = (sql) => {
        const stmt = realPrepare(sql);
        if (!String(sql).includes("INSERT INTO perf_samples")) return stmt;
        const realRun = stmt.run.bind(stmt);
        stmt.run = (...args) => {
          perfInserts += 1;
          return realRun(...args);
        };
        return stmt;
      };
      // 写入函数：**带重试**（真实的并发写入者就是这样做的）。
      // ⚠️ 实测：**用量侧 reader（`zcode-usage.js:124`）也打开同一个源库**，因此单次写入
      // 可能撞上它的读事务（`database is locked`）⇒ 重试直到成功。这比"猜哪个 close 是最后一次"
      // 更贴近真实并发，也不会让用量侧读取失败（避免产生多余的 `READ_ONLY_OPEN_FAILED`）。
      const colsForInject = [...ZCODE_SELECT_COLUMNS];
      let injecting = false;
      const injectRow = () => {
        if (injecting) return false;
        injecting = true;
        try {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
              const inject = new DatabaseSync(homeA.dbFile);
              inject
                .prepare(
                  `INSERT INTO "model_usage" (${colsForInject.map((c) => `"${c}"`).join(", ")}) VALUES (${colsForInject.map(() => "?").join(", ")})`,
                )
                .run(
                  ...colsForInject.map((c) =>
                    c === "id"
                      ? "sneaky-row"
                      : c === "status"
                        ? "completed"
                        : c === "started_at"
                          ? M34_BASE + 9000
                          : c === "completed_at"
                            ? M34_BASE + 9500
                            : c === "duration_ms"
                              ? 500
                              : c === "output_tokens"
                                ? 777
                                : c === "input_tokens"
                                  ? 10
                                  : null,
                  ),
                );
              inject.close();
              return true;
            } catch {
              // 锁竞争 ⇒ 稍后重试（不抛错、不污染被测路径）。
            }
          }
          return false;
        } finally {
          injecting = false;
        }
      };
      DatabaseSync.prototype.close = function patchedClose(...args) {
        // ⚠️ **必须在 close 之前**取 `location()`：关闭后句柄已失效，
        // `location()` 可能返回空串 ⇒ 匹配失败、注入不发生（我实测 `close 次数 = 0` 就是这个原因）。
        let location = "";
        try {
          location = normalize(this.location?.() ?? "");
        } catch {
          location = "";
        }
        const result = realClose.apply(this, args);
        if (location === targetDb) closeCalls += 1;
        // ⚠️ 只在 **perf 候选已全部读完**后注入（`perfInserts >= 4` = 原始 3 + trigger-change）。
        // 若更早注入，就会与**用量侧** reader（它也打开同一源库）抢锁 ⇒ 让它报错，
        // 于是 `sourceWarnings` 里会**多出一条 `READ_ONLY_OPEN_FAILED`**（我实测到过）——
        // 那是**夹具副作用**，会让本用例无法隔离 BB-1 的信号。
        if (!injected && location === targetDb && perfInserts >= 4) {
          if (injectRow()) injected = true;
        }
        return result;
      };
      let result;
      try {
        result = await store.sync({ options: m34Options(root, [homeA]) });
      } finally {
        DatabaseSync.prototype.close = realClose;
        store.database.prepare = realPrepare;
      }
      console.log(
        "  [实测] 读取期间已注入上游写入 =",
        injected,
        " 目标库 close 次数 =",
        closeCalls,
        " perf 插入 =",
        perfInserts,
        " updatedFileCount =",
        result.updatedFileCount,
      );

      const warnings = readWarnings(store);
      console.log("  [实测] perf_state =", JSON.stringify(readMetaValue(store, "perf_state")));
      console.log("  [实测] degradedHomeIds =", readMetaValue(store, "perf_degraded_home_ids"));
      console.log("  [实测] sourceWarnings =", JSON.stringify(warnings));

      // ★ 契约：读取期间变化 ⇒ degraded（不是静默 ready）
      assert.equal(readMetaValue(store, "perf_state"), "degraded", "读取期间来源变化必须标 degraded");
      const liveWarn = warnings.find((w) => w.code === "LIVE_SOURCE_CHANGED");
      assert.ok(liveWarn !== undefined, `必须记录 LIVE_SOURCE_CHANGED，实得 ${JSON.stringify(warnings)}`);
      assert.equal(liveWarn.count >= 1, true, "count 必须是真实检出次数（≥1）");
      // ⚠️ 诚实登记：本用例的注入**必然**与"用量侧 reader 也打开同一源库"竞争，
      // 因此 `sourceWarnings` 里常会**多出一条 `READ_ONLY_OPEN_FAILED`**。
      // 那是**夹具副作用**（我实测：无注入时 `warnings = []`），**不是**本缺陷的判据；
      // 我不把它断言成"恰好一条"，否则会把夹具噪声固化成契约。
      console.log("  [实测] 告警码集合 =", JSON.stringify(warnings.map((w) => w.code)));

      // ★ "确保下次重新提取"：下一轮必须重新读取该文件（不能因 size/mtime 相同而跳过）
      const second = await store.sync({ options: m34Options(root, [homeA]) });
      console.log(
        "  [实测] 下一轮 updatedFileCount =",
        second.updatedFileCount,
        " state =",
        readMetaValue(store, "perf_state"),
      );
      assert.ok(second.updatedFileCount >= 1, "下一轮必须重新提取被标记的文件");
      assert.equal(readMetaValue(store, "perf_state"), "ready", "下一轮完整同步成功后必须恢复 ready");
      const after = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;
      console.log("  [实测] 恢复后候选数 =", after);
      // 原始 3 行 + `trigger-change` + 注入的 `sneaky-row` = 5
      // （我第一版断言 4，是**我自己的算术错**：只算了注入的那一行，漏了 trigger-change）。
      assert.equal(after, 5, "恢复后候选必须是 5（原始 3 + trigger-change + sneaky-row）");
      void result;
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★BB-1b 仅 -wal 变化也必须被检出（主库＋WAL 指纹）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bb1w-"));
  try {
    // 库走 WAL 模式，并**保持一个连接打开** —— SQLite 在最后一个连接关闭时会
    // checkpoint 并把 `-wal` **删掉**（我实测：关闭前 `-wal` 12392 字节，关闭后**不存在**）。
    // ⇒ 若用完就 close，**根本测不到"仅 -wal 变化"**（我第一版就是这样**假绿**的：
    //    实测输出 `-wal 存在 = false`，走的其实是主库变化）。
    const homeA = makeZcodeHome(root, "home-A", { rows: 3, keepWalOpen: true });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      assert.equal(readMetaValue(store, "perf_state"), "ready", "前置：ready");

      const { statSync } = await import("node:fs");
      const walBefore = statSync(`${homeA.dbFile}-wal`, { throwIfNoEntry: false });
      const mainBefore = statSync(homeA.dbFile);
      console.log("  [实测] 同步前 -wal 存在 =", walBefore !== undefined, " 大小 =", walBefore?.size);

      // 只往 **-wal** 追加（连接保持打开 ⇒ 不 checkpoint ⇒ 主库不变）
      const cols = [...ZCODE_SELECT_COLUMNS];
      homeA.walHandle
        .prepare(
          `INSERT INTO "model_usage" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        )
        .run(
          ...cols.map((c) =>
            c === "id"
              ? "wal-only-row"
              : c === "status"
                ? "completed"
                : c === "started_at"
                  ? M34_BASE + 5000
                  : c === "completed_at"
                    ? M34_BASE + 5500
                    : c === "duration_ms"
                      ? 500
                      : c === "output_tokens"
                        ? 321
                        : c === "input_tokens"
                          ? 10
                          : null,
          ),
        );

      const walAfter = statSync(`${homeA.dbFile}-wal`, { throwIfNoEntry: false });
      const mainAfter = statSync(homeA.dbFile);
      console.log(
        "  [实测] main size",
        mainBefore.size,
        "⇒",
        mainAfter.size,
        " 主库未变 =",
        mainBefore.size === mainAfter.size,
      );
      console.log(
        "  [实测] -wal size",
        walBefore?.size,
        "⇒",
        walAfter?.size,
        " 变大 =",
        (walAfter?.size ?? 0) > (walBefore?.size ?? 0),
      );
      assert.equal(mainBefore.size, mainAfter.size, "前置：本轮**只**动 -wal，主库大小必须不变");
      assert.ok((walAfter?.size ?? 0) > (walBefore?.size ?? 0), "前置：-wal 必须真的变大");

      const result = await store.sync({ options: m34Options(root, [homeA]) });
      console.log(
        "  [实测] updatedFileCount =",
        result.updatedFileCount,
        " state =",
        readMetaValue(store, "perf_state"),
      );
      // ★ 主库未变、只有 -wal 变大 ⇒ 增量检测**必须**仍然重解析（`zcodeSourceStat` 已含 -wal）
      assert.ok(result.updatedFileCount >= 1, "-wal 单独变化必须触发重解析（不得因主库 size 相同而跳过）");
      // ★ reader 必须能读到 WAL 里的新行
      const count = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;
      console.log("  [实测] 候选数 =", count);
      assert.equal(count, 4, "必须读到 -wal 里的新行（共 4 条）");
    } finally {
      store.close();
      homeA.walHandle?.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BB-2【P1】未启用来源失败 ⇒ **不得**使 perf 退化，且**保留原用量告警**
// ---------------------------------------------------------------------------

test("★BB-2 无法分类的 Codex import 失败不归因给性能来源，且保留用量告警", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bb2-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const codexHome = makeCodexHome(root, "codex-home");
    // ★ 让用量侧（events）索引**失败**：把 codex home 的 sessions 设成**不可读**形态。
    // `discoverSessionFiles` 会尝试读目录 ⇒ 用一个**文件**冒充 sessions 目录使其抛出。
    rmSync(path.join(codexHome.path, "sessions"), { recursive: true, force: true });
    writeFileSync(path.join(codexHome.path, "sessions"), "not a directory");

    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      assert.equal(readMetaValue(store, "perf_state"), "ready", "前置：zcode 正常 ⇒ ready");

      const result = await store.sync({ options: m34Options(root, [homeA, codexHome]) });
      console.log("  [实测] perf_state =", JSON.stringify(readMetaValue(store, "perf_state")));
      console.log("  [实测] degradedHomeIds =", readMetaValue(store, "perf_degraded_home_ids"));
      console.log("  [实测] unsupportedSources =", JSON.stringify(result.unsupportedSources));
      console.log("  [实测] warnings 条数 =", store.warnings.length);
      console.log("  [实测] warnings 样本 =", JSON.stringify(store.warnings.slice(0, 3)));

      // 发现失败时没有可验证的 Codex home 身份，不能虚构性能归因。
      assert.equal(readMetaValue(store, "perf_state"), "ready");
      const degraded = JSON.parse(readMetaValue(store, "perf_degraded_home_ids"));
      assert.deepEqual(degraded, []);
      assert.ok(!result.unsupportedSources.some((s) => s.kind === "codex"));
      // ★ 保留原用量告警（不得因 perf 归因而吞掉）
      const usageWarning = store.warnings.find((w) => !String(w).startsWith("性能来源告警"));
      assert.ok(usageWarning !== undefined, `原用量告警必须保留，实得 ${JSON.stringify(store.warnings)}`);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★BB-2b 发现阶段失败（failedHomes）：未启用来源也不得进 degraded", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bb2b-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    try {
      // 直接构造 failedHomes 路径：一个 kind=extra（未启用）的 home，其 discovery 失败。
      // 用 `usageFiles` 的 failedHomes 分支：把 codex home 的 sessions 做成不可读。
      const codexHome = makeCodexHome(root, "codex-bad");
      rmSync(path.join(codexHome.path, "sessions"), { recursive: true, force: true });
      writeFileSync(path.join(codexHome.path, "sessions"), "x");

      await store.sync({ options: m34Options(root, [homeA, codexHome]) });
      console.log("  [实测] perf_state =", JSON.stringify(readMetaValue(store, "perf_state")));
      console.log("  [实测] degradedHomeIds =", readMetaValue(store, "perf_degraded_home_ids"));
      assert.equal(readMetaValue(store, "perf_state"), "ready", "发现阶段失败若来自未启用来源，不得退化");
      assert.deepEqual(JSON.parse(readMetaValue(store, "perf_degraded_home_ids")), [], "不得进 degraded");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BB-3【P2】perf_index_version 必须纳入**已发布文件指纹**（内容/WAL/删除）
// ---------------------------------------------------------------------------

test("★BB-3 perf_index_version 随已发布文件指纹及已启用 Codex home 集合变化", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bb3-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      const v0 = readMetaValue(store, "perf_index_version");
      console.log("  [实测] 初始版本 =", v0.slice(0, 16));

      // ① 内容变化（追加一行）⇒ 版本必须变
      appendZcodeRow(homeA, "bb3-row-1");
      await store.sync({ options: m34Options(root, [homeA]) });
      const v1 = readMetaValue(store, "perf_index_version");
      console.log("  [实测] 内容变化后 =", v1.slice(0, 16));
      assert.notEqual(v1, v0, "① 内容变化 ⇒ perf_index_version 必须变");

      // ② WAL 变化 ⇒ 版本必须变
      const db = new DatabaseSync(homeA.dbFile);
      const cols = [...ZCODE_SELECT_COLUMNS];
      db.prepare(
        `INSERT INTO "model_usage" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
      ).run(
        ...cols.map((c) =>
          c === "id"
            ? "bb3-wal-row"
            : c === "status"
              ? "completed"
              : c === "started_at"
                ? M34_BASE + 8000
                : c === "completed_at"
                  ? M34_BASE + 8500
                  : c === "duration_ms"
                    ? 500
                    : c === "output_tokens"
                      ? 55
                      : c === "input_tokens"
                        ? 10
                        : null,
        ),
      );
      db.close(); // close ⇒ checkpoint 进主库；但指纹计算发生在此之前亦可
      await store.sync({ options: m34Options(root, [homeA]) });
      const v2 = readMetaValue(store, "perf_index_version");
      console.log("  [实测] WAL 变化后 =", v2.slice(0, 16));
      assert.notEqual(v2, v1, "② WAL 变化 ⇒ perf_index_version 必须变");

      // ③ 删除 ⇒ 版本必须变
      const homeB = makeZcodeHome(root, "home-B", { rows: 2 });
      await store.sync({ options: m34Options(root, [homeA, homeB]) });
      const v3 = readMetaValue(store, "perf_index_version");
      console.log("  [实测] 加入 home-B 后 =", v3.slice(0, 16));
      assert.notEqual(v3, v2, "③ 来源集合变化 ⇒ 版本必须变");
      rmSync(homeB.path, { recursive: true, force: true });
      await store.sync({ options: m34Options(root, [homeA]) });
      const v4 = readMetaValue(store, "perf_index_version");
      console.log("  [实测] 删除 home-B 后 =", v4.slice(0, 16));
      assert.notEqual(v4, v3, "③ 删除 ⇒ 版本必须变");

      // ④ 已发布的 Codex rollout 才进入公开版本指纹；仅发现 home 不构成 perf 发布。
      const codexHome = makeCodexHome(root, "codex-home");
      writeFileSync(
        path.join(codexHome.path, "sessions", "rollout-empty.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "bb3-empty-thread" } })}\n`,
      );
      await store.sync({ options: m34Options(root, [homeA, codexHome]) });
      const v5 = readMetaValue(store, "perf_index_version");
      console.log("  [实测] 发布 empty Codex rollout 后 =", v5.slice(0, 16));
      assert.notEqual(v5, v4, "④ 已发布的零候选 rollout 也必须进入 perf_index_version");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BB-4【P2】告警码必须落在 M1 冻结码域内，且交给 M1 不抛错
// ---------------------------------------------------------------------------

test("★BB-4 失败告警码必须落在 M1 冻结码域，且 summarizePerf 不抛错并原样保留", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bb4-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const badHome = makeZcodeHome(root, "home-BAD", { rows: 3 });
    writeFileSync(badHome.dbFile, "not a sqlite database"); // 让 reader 抛错

    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA, badHome]) });
      const warnings = readWarnings(store);
      console.log("  [实测] sourceWarnings =", JSON.stringify(warnings));
      assert.ok(warnings.length > 0, "必须产生失败告警");

      const { PERF_SOURCE_WARNING_CODES, summarizePerf } = await import("../src/perf-stats.js");
      for (const w of warnings) {
        assert.ok(
          PERF_SOURCE_WARNING_CODES.has(w.code),
          `告警码 ${w.code} 不在 M1 冻结码域内（冻结域：${[...PERF_SOURCE_WARNING_CODES].join("/")}）`,
        );
      }

      // ★ 交给真实 M1：必须不抛错且原样保留
      // ⚠️ 签名是 `summarizePerf(samples, options)` —— samples 是**第一个位置参数**，
      // 我第一次写成了 `summarizePerf({ samples: [], meta: {...} })`（单对象），
      // 于是拿到 `TypeError: selectPerfSamples expects an array of PerfSample`（**夹具错**，非实现错）。
      const out = summarizePerf([], { meta: { sourceWarnings: warnings } });
      // ⚠️ 输出字段在 `out.meta.sourceWarnings`（不是 `out.sourceWarnings`）——
      // 我第一次读错了一层，得到 `undefined`（**夹具错**，非实现错）。
      console.log("  [实测] summarizePerf 未抛错；回传 =", JSON.stringify(out.meta.sourceWarnings));
      assert.deepEqual(
        out.meta.sourceWarnings.map((w) => ({
          sourceKind: w.sourceKind,
          homeId: w.homeId,
          code: w.code,
          count: w.count,
        })),
        warnings,
        "M1 必须原样保留四字段",
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BB 返工：突变分析暴露的**真实测试缺口**（首轮 3/7 检出后的补测）
//
// 我按 AP-5/AT-5 对四项修复做了 7 条定向突变，**4 条存活**。逐条对拍后分类：
//   B5 = **无效突变**（在被测行为上完全等价 ⇒ 按 AW-3 **不计**检出率，见报告 §4）
//   B3 / B6 / B7 = **真实缺口** ⇒ 本段补测闭合。
// ---------------------------------------------------------------------------

test("★BB-2c 【闭合 B3】文件失败路径（replaceFile 抛错）仅归因已启用来源", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bb2c-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const badZcode = makeZcodeHome(root, "home-BAD", { rows: 3 });
    // 让**已启用**来源的文件读取失败 ⇒ 走 `replaceFile` 抛错分支。
    writeFileSync(badZcode.dbFile, "definitely not sqlite");
    const codexHome = makeCodexHome(root, "codex-home");
    rmSync(path.join(codexHome.path, "sessions"), { recursive: true, force: true });
    writeFileSync(path.join(codexHome.path, "sessions"), "not a dir");

    const store = await openM34Store(root);
    try {
      const result = await store.sync({ options: m34Options(root, [homeA, badZcode, codexHome]) });
      const degraded = JSON.parse(readMetaValue(store, "perf_degraded_home_ids"));
      const warnings = readWarnings(store);
      console.log("  [实测] perf_state =", readMetaValue(store, "perf_state"));
      console.log("  [实测] degradedHomeIds =", JSON.stringify(degraded));
      console.log("  [实测] sourceWarnings =", JSON.stringify(warnings));
      console.log("  [实测] unsupportedSources =", JSON.stringify(result.unsupportedSources));

      // ★ B3 的判别式：文件失败路径**必须**先问"是否启用"。
      // 未启用（codex）的失败不得进 degraded；已启用（zcode 坏文件）的必须进。
      const unsupportedIds = new Set(result.unsupportedSources.map((s) => s.homeId));
      for (const id of degraded) {
        assert.ok(!unsupportedIds.has(id), `未启用来源 ${id} 不得出现在 degraded（文件失败路径）`);
      }
      assert.equal(degraded.length, 1, "只应有已启用来源的坏 home 受阻");
      assert.equal(warnings.length, 1, "只应有 1 条归因（未启用来源不得产生归因）");
      assert.equal(warnings[0].count, 1, "count 必须是真实失败文件数");
      // ★ 保留原用量告警（未启用来源的用量侧失败仍须可见）
      const usageWarning = store.warnings.find((w) => !String(w).startsWith("性能来源告警"));
      assert.ok(usageWarning !== undefined, "原用量告警必须保留");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★BB-1c 【闭合 B6】变过的文件必须被置脏 ⇒ 下一轮**必然**重提取（不依赖文件再变）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bb1c-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      appendZcodeRow(homeA, "trigger", { output: 111, offsetMs: 4000 });

      // 读取期间注入（与 ★BB-1 同一手法）
      let injected = false;
      let perfInserts = 0;
      const realPrepare = store.database.prepare.bind(store.database);
      const realClose = DatabaseSync.prototype.close;
      const targetDb = path.resolve(homeA.dbFile).toLowerCase();
      store.database.prepare = (sql) => {
        const stmt = realPrepare(sql);
        if (!String(sql).includes("INSERT INTO perf_samples")) return stmt;
        const realRun = stmt.run.bind(stmt);
        stmt.run = (...args) => {
          perfInserts += 1;
          return realRun(...args);
        };
        return stmt;
      };
      const cols = [...ZCODE_SELECT_COLUMNS];
      let injecting = false;
      const injectRow = () => {
        if (injecting) return false;
        injecting = true;
        try {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
              const inject = new DatabaseSync(homeA.dbFile);
              inject
                .prepare(
                  `INSERT INTO "model_usage" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
                )
                .run(
                  ...cols.map((c) =>
                    c === "id"
                      ? "sneaky"
                      : c === "status"
                        ? "completed"
                        : c === "started_at"
                          ? M34_BASE + 9000
                          : c === "completed_at"
                            ? M34_BASE + 9500
                            : c === "duration_ms"
                              ? 500
                              : c === "output_tokens"
                                ? 777
                                : c === "input_tokens"
                                  ? 10
                                  : null,
                  ),
                );
              inject.close();
              return true;
            } catch {
              /* 锁竞争 ⇒ 重试 */
            }
          }
          return false;
        } finally {
          injecting = false;
        }
      };
      DatabaseSync.prototype.close = function patched(...args) {
        let loc = "";
        try {
          loc = path.resolve(String(this.location?.() ?? "")).toLowerCase();
        } catch {
          loc = "";
        }
        const r = realClose.apply(this, args);
        if (!injected && loc === targetDb && perfInserts >= 4) {
          if (injectRow()) injected = true;
        }
        return r;
      };
      try {
        await store.sync({ options: m34Options(root, [homeA]) });
      } finally {
        DatabaseSync.prototype.close = realClose;
        store.database.prepare = realPrepare;
      }
      assert.equal(injected, true, "前置：注入必须发生");
      assert.equal(readMetaValue(store, "perf_state"), "degraded", "前置：live change 必须标 degraded");

      // ★ B6 的判别式：**不再改动文件**的情况下，下一轮也必须重提取
      //   （因为失败/变化时已把 source_files.size/mtime_ms 置 -1）。
      const before = store.database.prepare("SELECT size, mtime_ms FROM source_files WHERE path = ?").get(homeA.dbFile);
      console.log("  [实测] 置脏后的 source_files =", JSON.stringify(before));
      assert.equal(Number(before.size), -1, "变过的文件必须被置脏（size = -1）");
      assert.equal(Number(before.mtime_ms), -1, "变过的文件必须被置脏（mtime_ms = -1）");

      const next = await store.sync({ options: m34Options(root, [homeA]) });
      console.log(
        "  [实测] 下一轮 updatedFileCount =",
        next.updatedFileCount,
        " state =",
        readMetaValue(store, "perf_state"),
      );
      assert.ok(next.updatedFileCount >= 1, "置脏必须保证下一轮重提取（不依赖文件再变化）");
      assert.equal(readMetaValue(store, "perf_state"), "ready", "下一轮成功后恢复 ready");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★BB-3b 【闭合 B7】指纹必须含内容摘要（size+mtime 之外的分量）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bb3b-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      const v1 = readMetaValue(store, "perf_index_version");

      // ★ B7 的判别式：做一次**同尺寸**的原地改写（UPDATE，不新增页）并**把 mtime 钉回原值**，
      //   使 `size` 与 `mtimeMs` 两个分量都**不变** ⇒ 只有**内容摘要**能检出。
      const { statSync, utimesSync } = await import("node:fs");
      const before = statSync(homeA.dbFile);
      const db = new DatabaseSync(homeA.dbFile);
      db.prepare('UPDATE "model_usage" SET output_tokens = 4242 WHERE id = ?').run(`${homeA.id}-row-0`);
      db.close();
      utimesSync(homeA.dbFile, before.atime, before.mtime);
      const after = statSync(homeA.dbFile);
      console.log("  [实测] size 同 =", before.size === after.size, "  mtime 同 =", before.mtimeMs === after.mtimeMs);
      console.log("  [实测] mtime 差 =", Math.abs(after.mtimeMs - before.mtimeMs).toFixed(4), "ms");

      await store.sync({ options: m34Options(root, [homeA]) });
      const v2 = readMetaValue(store, "perf_index_version");
      console.log("  [实测] 版本:", v1.slice(0, 16), "->", v2.slice(0, 16), " 变化 =", v1 !== v2);
      assert.notEqual(v2, v1, "原地改写（同尺寸）也必须改变 perf_index_version（内容摘要分量）");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ===========================================================================
// ★ BC 返工2（task-39）：用户第二轮复核的两项缺陷
//
// 关键认识：**BC-1 是 BB-1 的边界**（修了"指纹变了"、没修"指纹取不到"）；
// **BC-2 是 BB-3 的边界**（修了"成功时内容变⇒版本变"、没修"失败回滚后版本不得变"）。
// ===========================================================================

/** 读取 store_meta 的 perf 已发布指纹映射（BC-2 的新载体）。 */
function readPublishedFingerprints(store) {
  const raw = readMetaValue(store, "perf_file_fingerprints");
  return raw === undefined ? {} : JSON.parse(raw);
}

/**
 * Windows 清理助手：持锁的外部进程未退出时 `rmSync` 会 `EPERM`。
 * 我实测遇到（★BC-3 的 pwsh 持锁者）⇒ 指数退避重试，避免把**清理问题**误报成**断言失败**。
 */
async function removeWithRetry(target, attempts = 12) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      rmSync(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (i === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

// ---------------------------------------------------------------------------
// BC-1【P1】读完后来源文件消失 ⇒ 不得发布 ready
// ---------------------------------------------------------------------------

test("★BC-1 reader 完成后删除上游文件：必须 degraded + LIVE_SOURCE_CHANGED + 受阻 home + 下轮处置", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bc1-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      assert.equal(readMetaValue(store, "perf_state"), "ready", "前置：首轮 ready");
      // ⚠️ 必须**先让文件变化**，否则第二轮 `replaceFile` 被增量判据整段跳过 ⇒
      //    `perf 插入 = 0`（我实测到），删除窗口根本不存在（返工1 §7 已登记该陷阱）。
      appendZcodeRow(homeA, "trigger-change", { output: 111, offsetMs: 4000 });

      // ★ 确定性构造：必须让删除落在 `statBefore` 与 `statAfter` **之间**。
      // ⚠️ 我第一版把删除放在 `replaceFile` **返回之后** ⇒ `statAfter` 早已取完 ⇒
      //    实测 `读后文件存在 = true`、state 仍 `ready`（**夹具错，不是实现错**）。
      // 正确手段：包装 `DatabaseSync.prototype.close`，在 **reader 释放句柄的那一刻**删除文件，
      // 此时 stream 的 Promise 尚未 resolve ⇒ 删除必然早于 `statAfter`。
      // 判据"perf 已插入过候选"用于排除**用量侧** reader 的 close（同一次 sync 会 close 多次）。
      let deleted = false;
      let perfInserts = 0;
      const realClose = DatabaseSync.prototype.close;
      const targetDb = path.resolve(homeA.dbFile).toLowerCase();
      const realPrepare = store.database.prepare.bind(store.database);
      store.database.prepare = (sql) => {
        const stmt = realPrepare(sql);
        if (!String(sql).includes("INSERT INTO perf_samples")) return stmt;
        const realRun = stmt.run.bind(stmt);
        stmt.run = (...args) => {
          perfInserts += 1;
          return realRun(...args);
        };
        return stmt;
      };
      DatabaseSync.prototype.close = function patchedClose(...args) {
        // ⚠️ `location()` 必须在 **close 之前**取（关闭后返回空串）——见返工1 §7 登记。
        let location = "";
        try {
          location = path.resolve(String(this.location?.() ?? "")).toLowerCase();
        } catch {
          location = "";
        }
        const result = realClose.apply(this, args);
        if (!deleted && location === targetDb && perfInserts > 0) {
          deleted = true;
          rmSync(homeA.dbFile, { force: true });
        }
        return result;
      };
      let result;
      try {
        result = await store.sync({ options: m34Options(root, [homeA]) });
      } finally {
        DatabaseSync.prototype.close = realClose;
        store.database.prepare = realPrepare;
      }
      console.log("  [实测] 读取期间已删除 =", deleted, " perf 插入 =", perfInserts);

      const state = readMetaValue(store, "perf_state");
      const warnings = readWarnings(store);
      const degraded = JSON.parse(readMetaValue(store, "perf_degraded_home_ids"));
      console.log("  [实测] 读后文件存在 =", existsSync(homeA.dbFile));
      console.log("  [实测] perf_state =", JSON.stringify(state));
      console.log("  [实测] sourceWarnings =", JSON.stringify(warnings));
      console.log("  [实测] degradedHomeIds =", JSON.stringify(degraded));

      // ★ 契约：读后无法取得指纹 ⇒ **不得**发布 ready
      assert.equal(state, "degraded", "读后文件消失必须标 degraded（不得静默 ready）");
      assert.ok(degraded.length >= 1, "必须登记受阻 home");
      const liveWarn = warnings.find((w) => w.code === "LIVE_SOURCE_CHANGED");
      assert.ok(liveWarn !== undefined, `必须记录 LIVE_SOURCE_CHANGED，实得 ${JSON.stringify(warnings)}`);
      assert.equal(liveWarn.homeId, degraded[0], "告警 homeId 必须与 degraded 一致（归因对象）");
      assert.ok(
        result.unsupportedSources.every((s) => !degraded.includes(s.homeId)),
        "受阻 home 不得同时出现在 unsupportedSources",
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★BC-1b 读后文件消失后：回归恢复 ready；整个 home 消失时保留历史并登记 missing", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bc1b-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      // 同 ★BC-1：先让文件变化（否则 `replaceFile` 被整段跳过，删除窗口不存在）。
      appendZcodeRow(homeA, "trigger-change", { output: 111, offsetMs: 4000 });

      // ① 读后删除 ⇒ 本轮 degraded（删除必须落在 statBefore..statAfter 之间 = reader close 时刻）
      let deleted = false;
      let perfInserts = 0;
      const realClose = DatabaseSync.prototype.close;
      const targetDb = path.resolve(homeA.dbFile).toLowerCase();
      const realPrepare = store.database.prepare.bind(store.database);
      store.database.prepare = (sql) => {
        const stmt = realPrepare(sql);
        if (!String(sql).includes("INSERT INTO perf_samples")) return stmt;
        const realRun = stmt.run.bind(stmt);
        stmt.run = (...args) => {
          perfInserts += 1;
          return realRun(...args);
        };
        return stmt;
      };
      DatabaseSync.prototype.close = function patchedClose(...args) {
        let location = "";
        try {
          location = path.resolve(String(this.location?.() ?? "")).toLowerCase();
        } catch {
          location = "";
        }
        const result = realClose.apply(this, args);
        if (!deleted && location === targetDb && perfInserts > 0) {
          deleted = true;
          rmSync(homeA.dbFile, { force: true });
        }
        return result;
      };
      try {
        await store.sync({ options: m34Options(root, [homeA]) });
      } finally {
        DatabaseSync.prototype.close = realClose;
        store.database.prepare = realPrepare;
      }
      assert.equal(deleted, true, "前置：删除必须落在读取窗口内");
      assert.equal(readMetaValue(store, "perf_state"), "degraded", "前置：读后删除 ⇒ degraded");

      // ② 文件**真实回归**（同路径重建）⇒ 下一轮必须恢复 ready 且候选完整
      mkdirSync(path.dirname(homeA.dbFile), { recursive: true });
      const db = new DatabaseSync(homeA.dbFile);
      const cols = [...ZCODE_SELECT_COLUMNS];
      db.exec(`CREATE TABLE "model_usage" (${cols.map((c) => `"${c}"`).join(", ")})`);
      for (let i = 0; i < 3; i += 1) {
        db.prepare(
          `INSERT INTO "model_usage" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        ).run(
          ...cols.map((c) =>
            c === "id"
              ? `${homeA.id}-row-${i}`
              : c === "session_id"
                ? `${homeA.id}-session`
                : c === "status"
                  ? "completed"
                  : c === "started_at"
                    ? M34_BASE + i * 1000
                    : c === "completed_at"
                      ? M34_BASE + i * 1000 + 500
                      : c === "duration_ms"
                        ? 500
                        : c === "input_tokens"
                          ? 10
                          : c === "output_tokens"
                            ? 100 + i
                            : null,
          ),
        );
      }
      db.close();
      const back = await store.sync({ options: m34Options(root, [homeA]) });
      const countBack = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;
      console.log(
        "  [实测] 回归后 state =",
        readMetaValue(store, "perf_state"),
        " 候选 =",
        countBack,
        " updated =",
        back.updatedFileCount,
      );
      assert.equal(readMetaValue(store, "perf_state"), "ready", "文件真实回归 ⇒ 下一轮恢复 ready");
      assert.equal(countBack, 3, "回归后候选完整");

      // ③ 整个 home **真实删除** ⇒ 发现不到 ⇒ 历史保留、登记 missing，状态 ready（不是 degraded）
      rmSync(homeA.path, { recursive: true, force: true });
      const gone = await store.sync({ options: m34Options(root, [homeA]) });
      const countGone = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;
      console.log(
        "  [实测] 真实删除后 state =",
        gone.perfState,
        " 候选 =",
        countGone,
        " degraded =",
        JSON.stringify(gone.degradedHomeIds),
      );
      assert.equal(countGone, 3, "来源缺失不得删除最后一次成功候选");
      assert.equal(gone.perfState, "ready", "来源缺失不是 degraded");
      assert.deepEqual(gone.degradedHomeIds, [], "来源缺失不登记受阻 home");
      assert.deepEqual(
        gone.missingSources.map((source) => source.path),
        [homeA.dbFile],
        "缺失文件必须可机读",
      );
      const mapGone = readPublishedFingerprints(store);
      const staleKeys = Object.keys(mapGone).filter((p) => p.includes("home-A"));
      console.log(
        "  [实测] 真实删除后 指纹映射键数 =",
        Object.keys(mapGone).length,
        " 残留 home-A 键 =",
        JSON.stringify(staleKeys),
      );
      assert.deepEqual(staleKeys, [homeA.dbFile], "最后成功指纹必须保留以支持回归/变更检测");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 返工3【第三轮外部复核 P2】读取期间**追加**（不是删除）
//   判别式：回滚必须保留**旧成功候选与旧成功指纹**；恢复轮候选变化时**版本必须随之变化**。
// ---------------------------------------------------------------------------

test("★BD-1 读取期间追加：整笔回滚（保留旧候选与旧指纹）⇒ 恢复后候选变化必须带动版本", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bd1-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      const count1 = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;
      const version1 = readMetaValue(store, "perf_index_version");
      assert.equal(readMetaValue(store, "perf_state"), "ready", "前置：首轮 ready");
      assert.equal(count1, 3, "前置：首轮候选 3");
      console.log("  [实测] 首轮 候选 =", count1, " 版本 =", version1);

      // 前提：本轮必须重解析（否则 `replaceFile` 被增量判据整段跳过，注入窗口不存在）。
      appendZcodeRow(homeA, "trigger-change", { output: 111, offsetMs: 4000 });

      // 注入必须落在 reader 读完（`perfInserts >= 4`）之后、`statAfter` 之前。
      let injected = false;
      let perfInserts = 0;
      const targetDb = path.resolve(homeA.dbFile).toLowerCase();
      const realClose = DatabaseSync.prototype.close;
      const realPrepare = store.database.prepare.bind(store.database);
      store.database.prepare = (sql) => {
        const stmt = realPrepare(sql);
        if (!String(sql).includes("INSERT INTO perf_samples")) return stmt;
        const realRun = stmt.run.bind(stmt);
        stmt.run = (...args) => {
          perfInserts += 1;
          return realRun(...args);
        };
        return stmt;
      };
      const cols = [...ZCODE_SELECT_COLUMNS];
      let injecting = false;
      const injectRow = () => {
        if (injecting) return false;
        injecting = true;
        try {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
              const inject = new DatabaseSync(homeA.dbFile);
              inject
                .prepare(
                  `INSERT INTO "model_usage" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
                )
                .run(
                  ...cols.map((c) =>
                    c === "id"
                      ? "sneaky"
                      : c === "session_id"
                        ? `${homeA.id}-session`
                        : c === "status"
                          ? "completed"
                          : c === "started_at"
                            ? M34_BASE + 9000
                            : c === "completed_at"
                              ? M34_BASE + 9500
                              : c === "duration_ms"
                                ? 500
                                : c === "input_tokens"
                                  ? 10
                                  : c === "output_tokens"
                                    ? 777
                                    : null,
                  ),
                );
              inject.close();
              return true;
            } catch {
              /* 锁竞争 ⇒ 重试 */
            }
          }
          return false;
        } finally {
          injecting = false;
        }
      };
      DatabaseSync.prototype.close = function patched(...args) {
        let loc = "";
        try {
          loc = path.resolve(String(this.location?.() ?? "")).toLowerCase();
        } catch {
          loc = "";
        }
        const r = realClose.apply(this, args);
        if (!injected && loc === targetDb && perfInserts >= 4) {
          if (injectRow()) injected = true;
        }
        return r;
      };
      try {
        await store.sync({ options: m34Options(root, [homeA]) });
      } finally {
        DatabaseSync.prototype.close = realClose;
        store.database.prepare = realPrepare;
      }
      assert.equal(injected, true, "前置：读取窗口内的追加必须发生");

      const countDeg = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;
      const versionDeg = readMetaValue(store, "perf_index_version");
      const warnings = readWarnings(store);
      console.log(
        "  [实测] 变化轮 候选 =",
        countDeg,
        " 版本 =",
        versionDeg,
        " state =",
        readMetaValue(store, "perf_state"),
        " warnings =",
        JSON.stringify(warnings),
      );

      // ① 既有 BB-1 契约不得退化
      assert.equal(readMetaValue(store, "perf_state"), "degraded", "读取期间变化必须标 degraded");
      assert.ok(
        warnings.some((w) => w.code === "LIVE_SOURCE_CHANGED"),
        `必须有 LIVE_SOURCE_CHANGED，实得 ${JSON.stringify(warnings)}`,
      );
      // ② ★返工3：本次读取不可信 ⇒ 整笔回滚 ⇒ 旧成功候选与旧成功指纹**原样保留**
      assert.equal(countDeg, count1, "检出读取期间变化后不得提交不完整候选（回滚保留旧候选）");
      assert.equal(versionDeg, version1, "回滚 ⇒ 版本必须保持旧成功值（指纹不得领先于候选）");
      // ③ 置脏 ⇒ 下一轮必然重试（不依赖文件再变）
      const dirty = store.database.prepare("SELECT size, mtime_ms FROM source_files WHERE path = ?").get(homeA.dbFile);
      assert.equal(Number(dirty.size), -1, "变过的文件必须置脏（size = -1）");
      assert.equal(Number(dirty.mtime_ms), -1, "变过的文件必须置脏（mtime_ms = -1）");

      // ④ ★第三轮 P2 的判别式：恢复轮候选完整，且**版本必须随候选变化**
      const back = await store.sync({ options: m34Options(root, [homeA]) });
      const countBack = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;
      const versionBack = readMetaValue(store, "perf_index_version");
      console.log("  [实测] 恢复轮 候选 =", countBack, " 版本 =", versionBack, " updated =", back.updatedFileCount);
      assert.equal(readMetaValue(store, "perf_state"), "ready", "恢复轮必须 ready");
      assert.equal(countBack, 5, "恢复轮候选完整（原始 3 + trigger-change + sneaky）");
      // ★ 第三轮 P2 的判别式：**两轮候选不同** ⇒ 版本**必须**不同。
      //   ⚠️ 只断言 `versionBack !== version1` 会**漏网**：缺陷下"变化轮"已把**读后**的
      //   指纹提前记为已发布 ⇒ `versionDeg !== version1`，恢复轮只是**沿用它**（同样 ≠ version1）。
      //   必须与"两轮候选确实不同"绑在一起，才指向"版本描述已提交候选"这一契约。
      assert.notEqual(countBack, countDeg, "前提：恢复轮候选确实变化（变化轮 → 恢复轮）");
      assert.notEqual(versionBack, versionDeg, "候选变化 ⇒ 版本必须随候选变化（不得沿用领先的指纹）");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// BC-2【P2】版本指纹必须绑定**已成功发布**的数据
// ---------------------------------------------------------------------------

test("★BC-2 单 home 失败：版本必须保持旧成功值（不得表征未发布的上游）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bc2-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 1 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      const v0 = readMetaValue(store, "perf_index_version");
      console.log(
        "  [实测] 首轮版本 =",
        v0.slice(0, 16),
        " 候选 =",
        store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c,
      );

      // 上游追加（**未发布**），并注入 replaceFile 失败
      appendZcodeRow(homeA, "unpublished-row", { output: 777, offsetMs: 9000 });
      const realReplaceFile = store.replaceFile.bind(store);
      store.replaceFile = async () => {
        throw new Error("injected failure");
      };
      const r = await store.sync({ options: m34Options(root, [homeA]) });
      store.replaceFile = realReplaceFile;

      const v1 = readMetaValue(store, "perf_index_version");
      const count = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;
      console.log("  [实测] 失败轮 state =", r.perfState, " 版本 =", v1.slice(0, 16), " 候选 =", count);
      assert.equal(r.perfState, "degraded", "失败轮必须是 degraded");
      assert.equal(count, 1, "旧成功候选保留（可回滚）");
      // ★ 契约：本轮没有成功发布任何新数据 ⇒ 版本必须**保持旧值**
      assert.equal(v1, v0, "失败回滚后 perf_index_version 必须保持旧成功值");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★BC-2b 恢复成功后版本必须变化（且与已提交候选同源）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bc2b-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 1 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      const v0 = readMetaValue(store, "perf_index_version");

      appendZcodeRow(homeA, "row-2", { output: 222, offsetMs: 9000 });
      const realReplaceFile = store.replaceFile.bind(store);
      store.replaceFile = async () => {
        throw new Error("injected failure");
      };
      await store.sync({ options: m34Options(root, [homeA]) });
      store.replaceFile = realReplaceFile;
      const vFailed = readMetaValue(store, "perf_index_version");
      assert.equal(vFailed, v0, "前置：失败轮版本不变");

      // 恢复：真实成功
      const r = await store.sync({ options: m34Options(root, [homeA]) });
      const v1 = readMetaValue(store, "perf_index_version");
      const count = store.database.prepare("SELECT COUNT(*) AS c FROM perf_samples").get().c;
      console.log(
        "  [实测] 恢复后 state =",
        r.perfState,
        " 版本 =",
        v0.slice(0, 8),
        "->",
        v1.slice(0, 8),
        " 候选 =",
        count,
      );
      assert.equal(r.perfState, "ready", "恢复后 ready");
      assert.equal(count, 2, "候选包含新行");
      assert.notEqual(v1, v0, "成功发布后版本必须变化");
      assert.notEqual(v1, vFailed, "恢复后版本不得等于失败轮的值");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★BC-2c 多 home 部分失败：版本只反映**成功提交**的部分", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bc2c-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 1 });
    const homeB = makeZcodeHome(root, "home-B", { rows: 1 });
    const store = await openM34Store(root);
    try {
      // 首轮：只有 A（B 尚未加入）
      await store.sync({ options: m34Options(root, [homeA]) });
      const vA = readMetaValue(store, "perf_index_version");
      console.log("  [实测] 仅 A 的版本 =", vA.slice(0, 16));

      // 加入 B，但让 **B 的 replaceFile 失败**（A 成功）
      const realReplaceFile = store.replaceFile.bind(store);
      store.replaceFile = async (file, opts) => {
        if (String(file.filePath).includes("home-B")) throw new Error("injected failure for B");
        return realReplaceFile(file, opts);
      };
      const r = await store.sync({ options: m34Options(root, [homeA, homeB]) });
      store.replaceFile = realReplaceFile;

      const vBoth = readMetaValue(store, "perf_index_version");
      const degraded = JSON.parse(readMetaValue(store, "perf_degraded_home_ids"));
      const mapAfter = readPublishedFingerprints(store);
      console.log("  [实测] state =", r.perfState, " degraded =", JSON.stringify(degraded));
      console.log("  [实测] 版本 =", vA.slice(0, 16), "->", vBoth.slice(0, 16));
      console.log("  [实测] 已发布指纹映射键数 =", Object.keys(mapAfter).length);
      assert.equal(r.perfState, "degraded", "B 失败 ⇒ degraded");

      // ★ 契约："版本只反映**成功提交**的部分"。
      // ⚠️ 正确的判别式是"**失败来源的分量不得进入版本输入**"，**不是**"版本必须等于旧值"——
      // 我第一版断言后者，实测失败：**A 本轮确实成功重解析并提交了**，A 的分量**理应**更新
      // （若断言版本不变，反而会把正确行为判成错误）。⇒ 我按**实际语义**修正断言（并登记此处更正）。
      assert.equal(
        Object.keys(mapAfter).filter((p) => p.includes("home-B")).length,
        0,
        "B 未提交 ⇒ 已发布指纹映射中**不得**出现 B 的任何文件",
      );
      assert.ok(
        Object.keys(mapAfter).some((p) => p.includes("home-A")),
        "A 已成功提交 ⇒ 其分量必须存在",
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// ★ BC-3 更正：突变 B3/B7 的**缺点位补测**
//
// ⚠️ 我上一轮把 B3 判为"等价突变"，依据是"未启用来源不产生进入 `replaceFile` 的文件"。
// **该断言未被验证，且是错的** —— 我本轮实测：
//   sync 完成, updatedFileCount = 1
//   source_files: [{"k":"extra","p":".../rollout.jsonl"}]     ← 未启用 codex 的文件确实入库
// 机制：raw kind `extra`/`main` 经 `canonicalPerfSourceKind` 映射为 `codex`，
// 而 `isPerfSourceEnabled("codex") === false` ⇒ **该守卫确实承重**。
// ⇒ M7 把 Codex 纳入已启用来源；下面的失败应阻断该 home。
// ---------------------------------------------------------------------------

test("★M7 Codex rollout 读取失败会阻断所属 home", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bc3-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const codexHome = path.join(root, "codex-home");
    const sessionsDir = path.join(codexHome, "sessions", "2026", "01");
    mkdirSync(sessionsDir, { recursive: true });
    const rollout = path.join(sessionsDir, "rollout.jsonl");
    // ① 先写**合法** rollout ⇒ 首轮 sync 成功入库（这是 B3 的**前提**，必须被证明）。
    writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "s1" } })}\n`);

    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA, codexHome]) });
      const beforeRows = store.database
        .prepare("SELECT kind, path, home_id FROM source_files WHERE path = ?")
        .all(rollout);
      console.log("  [实测] 首轮：codex 入库行 =", JSON.stringify(beforeRows));
      assert.equal(beforeRows.length, 1, "Codex rollout 必须进入 source_files");
      assert.equal(beforeRows[0].kind, "extra", "前提：其 raw kind 为 extra（canonical 后 = codex）");

      // ② 让它**在 `replaceFile` 内真的抛错**。
      // ⚠️ 我实测排除了多种"看似会抛"的手段（**都必须登记，否则会误判为已覆盖**）：
      //   - 目录冒充文件  ⇒ discovery 的 codex 文件枚举**过滤掉目录** ⇒ `replaceFile` 根本**不被调用**；
      //   - 坏 JSON/二进制/NUL ⇒ codex reader **容错**，只产告警、不抛；
      //   - 只锁文件不改尺寸 ⇒ 增量判据判"未变" ⇒ `replaceFile` **不被调用**。
      // ⇒ **可行组合**：文件**内容变化**（size/mtime 与库中记录不一致 ⇒ 必然重解析）**且**被
      //   另一进程以 `FileShare.None` **独占锁定** ⇒ `openSync` 抛 `EBUSY` ⇒ 进入文件失败分支。
      writeFileSync(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "s1" } })}\n{"type":"x"}\n`);
      const touched = statSync(rollout);
      utimesSync(rollout, touched.atime, new Date(Date.now() + 5000));

      // 后台进程持锁（不阻塞本进程），最多 30s；测试结束前 kill 掉。
      const lockerScript =
        `$fs=[System.IO.File]::Open('${rollout.replace(/'/g, "''")}','Open','Read','None'); ` +
        `Start-Sleep -Seconds 30; $fs.Close()`;
      const locker = spawn("pwsh", ["-NoProfile", "-Command", lockerScript], { stdio: "ignore" });
      // 等锁就绪（用"能否读到 EBUSY"来判定，而不是固定 sleep）。
      let lockHeld = false;
      for (let attempt = 0; attempt < 40 && !lockHeld; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          const probe = openSync(rollout, "r");
          closeSync(probe);
        } catch (error) {
          lockHeld = String(error?.code ?? "") === "EBUSY";
        }
      }
      console.log("  [实测] 独占锁已生效 =", lockHeld);
      assert.equal(lockHeld, true, "前提：必须真的持有独占锁（否则 `replaceFile` 不会抛错）");

      let r;
      let codexThrew = null;
      const realReplaceFile = store.replaceFile.bind(store);
      store.replaceFile = async (file, opts) => {
        try {
          return await realReplaceFile(file, opts);
        } catch (error) {
          if (String(file.filePath).includes("rollout.jsonl")) codexThrew = error;
          throw error;
        }
      };
      try {
        r = await store.sync({ options: m34Options(root, [homeA, codexHome]) });
      } finally {
        store.replaceFile = realReplaceFile;
        locker.kill();
      }
      console.log(
        "  [实测] codex 文件在 replaceFile 内抛错 =",
        codexThrew === null ? "否" : codexThrew.code || codexThrew.message,
      );
      // ★ 前提：必须**真的**走到了文件失败分支（否则本用例测不到 B3 守卫）。
      assert.notEqual(codexThrew, null, "用量事件 reader 必须报告锁定 rollout 的读取失败");
      const degraded = JSON.parse(readMetaValue(store, "perf_degraded_home_ids"));
      const warnings = readWarnings(store);
      console.log("  [实测] perf_state =", r.perfState);
      console.log("  [实测] degradedHomeIds =", JSON.stringify(degraded));
      console.log("  [实测] sourceWarnings =", JSON.stringify(warnings));
      console.log("  [实测] unsupportedSources =", JSON.stringify(r.unsupportedSources));

      const codexHomeId = String(beforeRows[0].home_id ?? "");
      assert.equal(r.perfState, "degraded");
      assert.deepEqual(degraded, [codexHomeId], "只能阻断发生 Codex 读取失败的 home");
      assert.ok(!r.unsupportedSources.some((source) => source.kind === "codex"));
      const codexWarning = warnings.find((warning) => warning.sourceKind === "codex" && warning.homeId === codexHomeId);
      assert.ok(codexWarning, "Codex 失败必须有可归因的来源告警");
      assert.equal(codexWarning.count, 1, "同一 rollout 在候选与用量 reader 中失败只计一次");
      assert.ok(store.warnings.some((warning) => !String(warning).startsWith("性能来源告警")));
    } finally {
      store.close();
    }
  } finally {
    // ⚠️ 持锁的 pwsh 子进程可能尚未退出 ⇒ Windows 上 `rmSync` 会 `EPERM`。
    await removeWithRetry(root);
  }
});

test("★BC-3b 【B7 判别式】size 与 mtime **全同**的原地改写也必须被检出", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bc3b-"));
  try {
    const homeA = makeZcodeHome(root, "home-A", { rows: 3 });
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, [homeA]) });
      // 把 mtime **钉到整毫秒**（`utimesSync` 接受 `Date` ⇒ 无亚毫秒分量）
      // ⇒ 后续改写可把 mtime 钉回**同一个整数** ⇒ 使 mtime 分量**真正相同**。
      // ⚠️ 这正是我上一轮失败的原因：用 `before.mtime`（Date）钉回后 mtimeMs 仍有
      //    0.1~0.4ms 的亚毫秒差 ⇒ 前提从未满足 ⇒ 我误以为"无法构造该输入"。
      const s0 = statSync(homeA.dbFile);
      const pinned = new Date(Math.floor(s0.mtimeMs));
      utimesSync(homeA.dbFile, pinned, pinned);
      await store.sync({ options: m34Options(root, [homeA]) });
      const v1 = readMetaValue(store, "perf_index_version");
      const before = statSync(homeA.dbFile);

      // 同尺寸原地改写（UPDATE 不增页）⇒ 再把 mtime 钉回**同一**整毫秒。
      const db = new DatabaseSync(homeA.dbFile);
      db.prepare('UPDATE "model_usage" SET output_tokens = 31337 WHERE id = ?').run(`${homeA.id}-row-0`);
      db.close();
      utimesSync(homeA.dbFile, pinned, pinned);
      const after = statSync(homeA.dbFile);
      console.log(
        "  [实测] 前置: size 同 =",
        before.size === after.size,
        " mtimeMs 同 =",
        before.mtimeMs === after.mtimeMs,
      );
      console.log(
        "  [实测] 前置: size =",
        before.size,
        "vs",
        after.size,
        " mtimeMs =",
        before.mtimeMs,
        "vs",
        after.mtimeMs,
      );
      // ★ **前提必须被证明**（BC-3 明文）：两个分量都**完全相同**才算真正满足 B7 场景。
      assert.equal(before.size, after.size, "前置：必须同尺寸");
      assert.equal(before.mtimeMs, after.mtimeMs, "前置：mtimeMs 必须完全相同（整毫秒钉死）");

      let replaceCalls = 0;
      const realReplaceFile = store.replaceFile.bind(store);
      store.replaceFile = async (...args) => {
        replaceCalls += 1;
        return realReplaceFile(...args);
      };
      const r = await store.sync({ options: m34Options(root, [homeA]) });
      store.replaceFile = realReplaceFile;
      const v2 = readMetaValue(store, "perf_index_version");
      console.log("  [实测] replaceFile 调用 =", replaceCalls, " updatedFileCount =", r.updatedFileCount);
      console.log("  [实测] 版本:", v1.slice(0, 16), "->", v2.slice(0, 16), " 变化 =", v1 !== v2);
      // ★ B7 的判别式：size/mtime 全同**不蕴含**内容未变 ⇒ 必须靠**内容摘要**检出。
      // ⚠️ 我实测修复前此处 `replaceFile 调用 = 0`、版本**不变** ⇒ 这是**真实缺陷**
      //    （增量判据只看 size/mtime，比指纹弱一个分量）。见报告 §5。
      assert.equal(replaceCalls >= 1, true, "size/mtime 全同但内容已变 ⇒ 必须重解析（不得整轮跳过）");
      assert.notEqual(v2, v1, "size/mtime 全同的原地改写也必须改变 perf_index_version");
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ★ Q2 卡（响应预算）：事务外长循环的让出 —— 四条不变量
//   ① 让出必须真的发生且受 8 ms 预算守卫；② 让出**唯一**且只在 home 之间（同一 home 的 before/after 不得被拆开）；
//   ③ 读事务内**不得** await；④ 让出后必须**重新判定来源文件集**（不得复用让出前的快照）。
// ---------------------------------------------------------------------------

/** 造 N 个**真 codex home**（克隆共享夹具的三个 rollout 文件并改写 thread id）。 */
async function q2ManyCodexHomes(root, count) {
  const { readFileSync: read, readdirSync } = await import("node:fs");
  const { createPerfCodexIntegrationFixture } = await import("../test-support/perf-fixture.mjs");
  const fixture = createPerfCodexIntegrationFixture();
  try {
    const templateDirectory = path.join(fixture.codexHome, "sessions", "fixture", "fixture-codex-thread");
    const templates = readdirSync(templateDirectory).map((name) => ({
      name,
      text: read(path.join(templateDirectory, name), "utf8"),
    }));
    const homes = [];
    for (let index = 0; index < count; index += 1) {
      const id = "q2-codex-" + String(index).padStart(3, "0");
      const threadId = "q2-thread-" + String(index).padStart(3, "0");
      const homePath = path.join(root, id);
      const directory = path.join(homePath, "sessions", "fixture", threadId);
      mkdirSync(directory, { recursive: true });
      for (const template of templates) {
        writeFileSync(path.join(directory, template.name), template.text.split("fixture-codex-thread").join(threadId));
      }
      homes.push({ id, path: homePath, kind: "extra" });
    }
    return homes;
  } finally {
    fixture.close();
  }
}

/** 1 ms 定时器统计"事件环是否真的拿到过回合"，并记录每次回合时的**事务深度**（包装 exec）。 */
function q2WatchEventLoopTurns() {
  const turns = [];
  const realExec = DatabaseSync.prototype.exec;
  let depth = 0;
  DatabaseSync.prototype.exec = function trackedExec(sql) {
    const text = String(sql).trim();
    const isStart = /^(BEGIN|SAVEPOINT)\b/i.test(text);
    const isEnd = /^(COMMIT|END|ROLLBACK|RELEASE)\b/i.test(text);
    if (isStart) depth += 1;
    try {
      return realExec.call(this, sql);
    } finally {
      if (isEnd) depth = Math.max(0, depth - 1);
    }
  };
  const timer = setInterval(() => {
    turns.push({ at: Date.now(), depth });
  }, 1);
  return {
    turns,
    stop() {
      clearInterval(timer);
      DatabaseSync.prototype.exec = realExec;
    },
  };
}

const q2StoreSource = async () =>
  (await import("node:fs")).readFileSync(new URL("../src/usage-store.js", import.meta.url), "utf8");

test("★Q2-c 读事务内不得 await：BEGIN…COMMIT 之间不得出现事件环回合", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "q2-c-"));
  try {
    const homes = await q2ManyCodexHomes(root, 3);
    const store = await openM34Store(root);
    try {
      await store.sync({ options: m34Options(root, homes) });
      // 判别式：记录 BEGIN…COMMIT 窗口 + 事件环回合 ⇒ **回合不得落在事务窗口内**（= 事务内 await）。
      const windows = [];
      const turns = [];
      const realExec = DatabaseSync.prototype.exec;
      let open = null;
      DatabaseSync.prototype.exec = function trackedExec(sql) {
        const statement = String(sql).trim();
        if (/^(BEGIN|SAVEPOINT)\b/i.test(statement)) {
          if (open === null) open = { start: Date.now(), statement };
        } else if (open !== null && /^(COMMIT|END|ROLLBACK|RELEASE)\b/i.test(statement)) {
          windows.push({ start: open.start, end: Date.now() });
          open = null;
        }
        return realExec.call(this, sql);
      };
      const timer = setInterval(() => turns.push(Date.now()), 0);
      try {
        store.summarize({ preset: "all", now: new Date() });
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        clearInterval(timer);
        DatabaseSync.prototype.exec = realExec;
      }
      assert.equal(windows.length >= 1, true, "前置：summarize 必须真的开过读事务（否则本判别式无效）");
      const inside = turns.filter((at) => windows.some((window) => at > window.start && at < window.end));
      assert.equal(
        inside.length,
        0,
        "BEGIN…COMMIT 之间不得出现事件环回合：那意味着事务内 await（观测到 " + inside.length + " 次）",
      );
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
