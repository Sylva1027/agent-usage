// W3：执行器**硬崩溃**故障注入 + 退出无泄漏。
//
// 与 `test/w1-executor.test.js` 的分工（不重复家族①）：
//   W1-b 已覆盖：超时/执行器内失败以**可重试错误**结算、`close()` 迅速落定、半发布形状、`syncPromise` 合并。
//   W3 补：① worker 被**强制终止**（真故障注入，不靠代码契约）时在途请求可重试且不挂死；
//          ② 崩溃后**下一个请求**能恢复（新执行器、库重开、读侧快照不脏）；
//          ③ 崩溃发生在**发布中途**不留半发布可见状态；④ `close()` 期间崩溃仍**必须落定**；
//          ⑤ 多次 `close()` / `close()` 后再请求 / 异常路径 ⇒ 库文件与临时目录**立即可删**（Windows EBUSY/EPERM 硬判据）；
//          ⑥ worker 数量/句柄在关闭前后对比（无连接/进程泄漏）。
//
// W4-FIX（task-24，**只动清理/超时/生命周期，判据一条未放宽**）：
//   · ⑧ 的子进程：`stdio: "ignore"`（不继承任何管道）+ 标记文件报到（不再读 stdout）+ `unref()` +
//     **finally 兜底必杀** + 子进程自保（父一消失就自退）⇒ 父/runner 再不会被"孤儿持管道烧 CPU"卡住；
//   · 各处内部**保护值**放宽（10 s→90/120 s 等），因为争用下单用例本就 30.9–77.7 s ⇒ 不再把**负载**误判成**失败**；
//   · 证据产物 `W3/out/fault-matrix.json` 由 `writeMatrix()`（+`test.after` 兜底）**无条件**落盘，未执行的格写
//     `MISSING` 占位 ⇒ 一条红不再带出第二条红；"每格必须有真实实测值"的严格判据由 `W3/verify-w3.mjs` 承担。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createUsageExecutor } from "../src/usage-executor.js";
import { createPerfCodexIntegrationFixture } from "../test-support/perf-fixture.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(
  HERE,
  "..",
  "docs",
  "validation",
  "2026-10-09-refresh-performance-fix",
  "2026-10-09T0525+0800",
  "W3",
  "out",
);
const EXECUTOR_URL = new URL("../src/usage-executor.js", import.meta.url).href;

/** 故障注入矩阵（逐格 期望 vs 实测），最后一个用例落盘成证据。 */
const matrix = [];
const record = (row) => {
  matrix.push(row);
  console.log(
    `  格 ${row.cell}: ${row.expected} ⇒ ${row.observed}${row.detail === undefined ? "" : ` (${JSON.stringify(row.detail)})`}`,
  );
  return row;
};

/** 8 格的固定顺序（落盘时按此补齐 `MISSING` 占位 ⇒ 一条红**不再**带出"矩阵落盘"这条第二红）。 */
const expectedCells = 8;
const CELL_ORDER = [
  "①在途崩溃",
  "②崩溃后恢复",
  "③发布中途崩溃",
  "④close() 期间崩溃",
  "⑤多次 close()/close 后再请求",
  "⑥异常路径退出",
  "⑦存活 worker 线程不累积",
  "⑧外部 kill",
];

/**
 * 落盘故障矩阵：**总是**写出 8 格（未执行的格 = 显式 `MISSING` 占位）。
 * 由第 9 个用例调用，并额外挂 `test.after` 兜底（即使 runner 提前中断，产物也在）。
 */
async function writeMatrix() {
  const cells = CELL_ORDER.map(
    (cell) =>
      matrix.find((row) => row.cell === cell) ?? {
        cell,
        status: "MISSING",
        expected: "(未执行)",
        observed: "用例未完成（红/超时/被跳过）",
      },
  );
  const report = {
    card: "W3 执行器故障恢复与清理（task-17）",
    generatedAt: new Date().toISOString(),
    node: process.version,
    cells,
    summary: { cells: cells.length, recorded: matrix.length, allRecorded: matrix.length >= expectedCells },
  };
  await mkdir(OUT, { recursive: true });
  await writeFile(path.join(OUT, "fault-matrix.json"), JSON.stringify(report, null, 2));
  return report;
}

// 兜底：任何情况下都保证证据产物存在（写的是"当前已记录 + MISSING 占位"）。
test.after(async () => {
  await writeMatrix();
});

const settledWithin = async (promise, ms) => {
  let timer;
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ state: "resolved", value }),
      (error) => ({ state: "rejected", error }),
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ state: "hung" }), ms);
    }),
  ]);
  clearTimeout(timer);
  return outcome;
};

async function makeExecutor({ root, fixture, options = {} }) {
  return createUsageExecutor({
    homeDir: root,
    databaseFile: path.join(root, "usage-index.sqlite"),
    importDirs: [fixture.codexHome],
    automaticDiscoveryEnabled: false,
    ...options,
  });
}

/**
 * **活着的 worker 线程数**（硬计数）：`process.report.getReport().workers` 每个存活线程一份子报告。
 * 注意 `process._getActiveHandles()` 在 Node 24 **看不到** Worker（实测 before/during 都是 0），
 * 所以句柄面用 report 计数，不用 `_getActiveHandles`。
 */
const liveWorkerThreads = () => {
  try {
    return process.report.getReport().workers.length;
  } catch {
    return -1;
  }
};

test("W3 · 崩溃①：worker 被强制终止 ⇒ 在途请求以可重试错误结算，不挂死", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w3-crash-inflight-"));
  const fixture = createPerfCodexIntegrationFixture();
  const executor = await makeExecutor({ root, fixture });
  try {
    await executor.sync({ options: { force: true } }); // 预热：库已建、快照已发布
    // 同一 tick 内提交 + 终止：主线程还没让出事件环 ⇒ 该请求**必然**仍在 `pending` 里。
    const inFlight = executor.sync({ options: { force: true } });
    const crashed = await executor.crashWorkerForTest();
    const outcome = await settledWithin(inFlight, 90_000); // 争用下在途结算可能被拖到分钟级（只放宽**保护值**，判据不变）
    assert.equal(crashed, true, "故障注入必须真的终止了执行器线程");
    assert.notEqual(outcome.state, "hung", "在途请求必须结算（不得挂死到超时）");
    assert.equal(outcome.state, "rejected", "硬崩溃必须让在途请求 reject");
    assert.equal(outcome.error.retryable, true, "崩溃必须标记**可重试**（调用方可重试）");
    assert.equal(outcome.error.code, "EXECUTOR_EXITED", "错误码必须是 EXECUTOR_EXITED");
    record({
      cell: "①在途崩溃",
      expected: "reject + retryable + EXECUTOR_EXITED，且不挂死",
      observed: `${outcome.state}/${outcome.error.code}/retryable=${outcome.error.retryable}`,
      detail: { message: outcome.error.message },
    });
  } finally {
    await executor.close();
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("W3 · 崩溃②：崩溃后下一个请求就地恢复（新执行器 / 库重开 / 快照不脏）", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w3-crash-recover-"));
  const fixture = createPerfCodexIntegrationFixture();
  const executor = await makeExecutor({ root, fixture });
  try {
    await executor.sync({ options: { force: true } });
    assert.ok(executor.metadata()?.harnessModels, "预热后必须已发布完整快照");
    await executor.crashWorkerForTest();
    // 崩溃后：线程已死、可见状态清空（不得留下陈旧/半发布快照）。
    assert.equal(executor.alive, false, "崩溃后执行器线程必须已死");
    assert.equal(executor.metadata(), null, "崩溃后读侧快照必须清空（不留陈旧状态）");
    assert.equal(executor.restarts, 0, "尚未重启");
    // **下一个请求**必须能恢复：就地拉起新执行器、库能重开、快照重新变完整。
    const status = await settledWithin(executor.sync({ options: { force: true } }), 120_000); // 同上：保护值放宽，判据不变
    assert.equal(status.state, "resolved", `崩溃后下一个请求必须成功（实测 ${status.state}）`);
    assert.ok(status.value, "恢复后的 sync 必须返回状态");
    assert.equal(executor.alive, true, "恢复后执行器线程必须活着");
    assert.equal(executor.restarts, 1, "必须恰好重启一次（不做无限重试）");
    const metadata = executor.metadata();
    assert.ok(metadata?.harnessModels, "恢复后必须重新发布完整快照");
    assert.ok(Array.isArray(metadata.homes), "恢复后 homes 必须是数组");
    record({
      cell: "②崩溃后恢复",
      expected: "崩溃清空状态 ⇒ 下一个请求成功 + restarts=1",
      observed: `resolved/alive=${executor.alive}/restarts=${executor.restarts}`,
      detail: { metadataNullAfterCrash: true, homes: metadata.homes.length },
    });
  } finally {
    await executor.close();
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("W3 · 崩溃③：发布中途崩溃不留半发布可见状态（采样全部为空或完整）", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w3-crash-publish-"));
  const fixture = createPerfCodexIntegrationFixture();
  const executor = await makeExecutor({ root, fixture });
  try {
    await executor.sync({ options: { force: true } });
    const isComplete = (state) =>
      state !== null && state !== undefined && Boolean(state.harnessModels) && Array.isArray(state.homes);
    /** 半发布 = 有 metadata 却**不完整**（`null`/空态是"崩溃后清空"，不算半成品）。 */
    const isPartial = (state) =>
      state !== null && state !== undefined && state.metadata !== null && !isComplete(state.metadata);
    const samples = [];
    let settled = false;
    // 在飞一次同步（重活），**同时**硬崩溃：崩溃点落在"发布中途"附近。
    // 注意：先启动采样、再 `await` 崩溃，否则崩溃一落定循环就退出、一次样本都采不到（断言空转）。
    const inFlight = executor
      .sync({ options: { force: true } })
      .then((value) => {
        settled = true;
        return value;
      })
      .catch(() => {
        settled = true;
      });
    const crashStarted = performance.now();
    const crash = executor.crashWorkerForTest();
    while (!settled && samples.length < 5000) {
      await new Promise((resolve) => setImmediate(resolve));
      samples.push(executor.state);
    }
    await crash;
    const crashMs = performance.now() - crashStarted;
    await inFlight;
    const partial = samples.filter(isPartial);
    const complete = samples.filter((item) => isComplete(item.metadata ?? null) || isComplete(item));
    assert.equal(
      partial.length,
      0,
      `崩溃期间不得观测到半发布状态（采样 ${samples.length} 次，半成品 ${partial.length} 次，首个样例 ${JSON.stringify(partial[0])?.slice(0, 200)}）`,
    );
    assert.ok(samples.length >= 1, "必须真的采到样本（否则断言空转）");
    assert.ok(complete.length >= 1, "崩溃前必须采到过完整快照（否则这条不变量没被压到）");
    // 崩溃落定后：可见状态被清空 ⇒ 之后看到的要么为空、要么完整。
    assert.equal(executor.metadata(), null, "崩溃后必须清空可见快照");
    record({
      cell: "③发布中途崩溃",
      expected: "采样全部为空或完整（半发布 0 次），崩溃后清空",
      observed: `samples=${samples.length}/partial=${partial.length}/complete=${complete.length}/nullAfter=${executor.metadata() === null}`,
      detail: { crashSettleMs: Number(crashMs.toFixed(1)) },
    });
  } finally {
    await executor.close();
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("W3 · 崩溃④：close() 期间崩溃不得让 close() 永不落定，且之后库可立即删除", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w3-crash-close-"));
  const fixture = createPerfCodexIntegrationFixture();
  const executor = await makeExecutor({ root, fixture });
  await executor.sync({ options: { force: true } });
  const started = performance.now();
  // 同一 tick 内：发起 close() + 立刻把执行器打崩（关闭握手与崩溃竞争）。
  const closing = executor.close();
  await executor.crashWorkerForTest();
  const outcome = await settledWithin(closing, 30_000); // 保护值放宽（close() 落定本身另有 < 8 s 断言，未放宽）
  const ms = performance.now() - started;
  fixture.close();
  assert.equal(outcome.state, "resolved", `close() 必须落定（实测 ${outcome.state}，${ms.toFixed(1)} ms）`);
  assert.ok(ms < 8_000, `close() 必须在崩溃竞争下迅速落定，实测 ${ms.toFixed(1)} ms`);
  // 硬判据：不重试地删库目录（连接必须已释放）。
  await rm(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false, "close() 崩溃竞争后必须能立即删除库目录");
  record({
    cell: "④close() 期间崩溃",
    expected: "close() 落定（< 8 s）且库目录立即可删",
    observed: `resolved/${ms.toFixed(1)}ms/deletable=true`,
  });
});

test("W3 · 泄漏①：多次 close() 幂等；close() 后再请求以 EXECUTOR_UNAVAILABLE 结算", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w3-leak-multiclose-"));
  const fixture = createPerfCodexIntegrationFixture();
  const executor = await makeExecutor({ root, fixture });
  try {
    await executor.sync({ options: { force: true } });
    const first = await settledWithin(executor.close(), 30_000);
    assert.equal(first.state, "resolved", "第一次 close() 必须落定");
    const started = performance.now();
    const second = await settledWithin(executor.close(), 30_000);
    const secondMs = performance.now() - started;
    assert.equal(second.state, "resolved", "第二次 close() 必须落定（幂等）");
    assert.ok(secondMs < 200, `第二次 close() 必须立即返回，实测 ${secondMs.toFixed(1)} ms`);
    assert.equal(executor.alive, false, "close() 后执行器必须已死");
    // close() 之后**不得重启**：请求以不可用错误结算（不是挂死、不是偷偷拉起新线程）。
    const after = await settledWithin(executor.sync({ options: { force: true } }), 60_000);
    assert.equal(after.state, "rejected", "close() 后再请求必须 reject");
    assert.equal(after.error.code, "EXECUTOR_UNAVAILABLE", "close() 后必须报 EXECUTOR_UNAVAILABLE");
    assert.equal(executor.restarts, 0, "close() 之后**绝不**重启");
    record({
      cell: "⑤多次 close()/close 后再请求",
      expected: "两次 close() 均落定；再请求 EXECUTOR_UNAVAILABLE；restarts=0",
      observed: `resolved/resolved(${secondMs.toFixed(1)}ms)/${after.error.code}/restarts=0`,
    });
  } finally {
    fixture.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("W3 · 泄漏②：异常路径（执行器内失败）后 close() ⇒ 库文件与临时目录立即可删", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w3-leak-errorpath-"));
  const fixture = createPerfCodexIntegrationFixture();
  const executor = await makeExecutor({ root, fixture });
  await executor.sync({ options: { force: true } });
  // 故意让执行器内的 backup 失败（目标目录不存在）⇒ 走异常路径。
  const failure = await settledWithin(
    executor.snapshot({ databaseFile: path.join(root, "no-such-dir", "copy.sqlite"), asOf: Date.now() }),
    60_000, // 保护值放宽（争用下执行器内失败结算也可能被拖慢）；判据仍是 rejected + retryable
  );
  assert.equal(failure.state, "rejected", "异常路径必须 reject");
  assert.equal(failure.error.retryable, true, "异常路径必须标记可重试");
  await settledWithin(executor.close(), 30_000);
  fixture.close();
  // 不重试：这就是"连接/句柄已释放"的可执行判据（Windows EBUSY/EPERM）。
  await rm(root, { recursive: true, force: true });
  assert.equal(existsSync(root), false, "异常路径 close() 后必须能立即删除库目录");
  record({
    cell: "⑥异常路径退出",
    expected: "执行器内失败可重试 ⇒ close() ⇒ 目录立即可删",
    observed: `rejected(retryable=${failure.error.retryable})/deletable=true`,
  });
});

test("W3 · 泄漏③：反复 create→sync→close 三个循环，存活 worker 线程数不累积（无孤儿线程）", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w3-leak-handles-"));
  const fixture = createPerfCodexIntegrationFixture();
  const baseline = liveWorkerThreads();
  const cycles = [];
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const executor = await makeExecutor({ root, fixture });
    await executor.sync({ options: { force: true } });
    const during = liveWorkerThreads();
    const aliveDuring = executor.alive;
    await executor.close();
    await new Promise((resolve) => setTimeout(resolve, 150)); // 给线程退出留一拍
    cycles.push({ cycle, during, after: liveWorkerThreads(), aliveDuring, aliveAfter: executor.alive });
  }
  fixture.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  assert.ok(
    cycles.every((row) => row.aliveDuring === true && row.aliveAfter === false),
    `每个循环：活着时必须 alive、close() 后必须 !alive（${JSON.stringify(cycles)}）`,
  );
  assert.ok(
    cycles.every((row) => row.during === baseline + 1 && row.after === baseline),
    `活着时恰好 +1 个 worker 线程、close() 后回到基线（baseline=${baseline}，${JSON.stringify(cycles)}）`,
  );
  record({
    cell: "⑦存活 worker 线程不累积",
    expected: "3 个 create→close 循环：活着 +1、close() 后回基线；每次 close() 后 !alive",
    observed: `baseline=${baseline}/during=[${cycles.map((row) => row.during).join(",")}]/after=[${cycles.map((row) => row.after).join(",")}]/aliveAfter=[${cycles.map((row) => row.aliveAfter).join(",")}]`,
    detail: cycles,
  });
});

test("W3 · 泄漏④：外部 kill 子进程（真进程级故障）后库目录可删、无孤儿", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "w3-leak-kill-"));
  const fixture = createPerfCodexIntegrationFixture();
  // 报到改用**标记文件**（不用 stdout 管道）：子进程 `stdio: "ignore"` ⇒ 不持有任何继承管道，
  // 即便父进程异常退出，runner 也不会被"子进程持着管道烧 CPU"卡住（W4 挂死根因）。
  const marker = path.join(root, "child-ready.marker");
  const script = `
    import { writeFileSync } from "node:fs";
    const { createUsageExecutor } = await import(${JSON.stringify(EXECUTOR_URL)});
    const executor = createUsageExecutor({
      homeDir: ${JSON.stringify(root)},
      databaseFile: ${JSON.stringify(path.join(root, "usage-index.sqlite"))},
      importDirs: [${JSON.stringify(fixture.codexHome)}],
      automaticDiscoveryEnabled: false,
    });
    await executor.sync({ options: { force: true } });
    writeFileSync(${JSON.stringify(marker)}, "CHILD-READY");
    // 自保：父进程一消失就自行退出（绝不做孤儿；且它只终止自己）。
    const parentPid = ${process.pid};
    const guard = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        clearInterval(guard);
        process.exit(0);
      }
    }, 1000);
    guard.unref?.();
    setInterval(() => {}, 1000); // 挂住，等外部 kill
  `;
  const scriptFile = path.join(root, "child.mjs");
  await mkdir(root, { recursive: true });
  await writeFile(scriptFile, script);
  const child = spawn(process.execPath, [scriptFile], {
    cwd: process.cwd(),
    // 不继承 stdio：无管道可持 ⇒ 父/runner 永不被它挂住。
    stdio: "ignore",
  });
  child.unref(); // 句柄不阻止事件环退出（真正的清理仍由下面的 finally 负责）
  const killChild = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
    try {
      child.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
    const exited = await Promise.race([
      new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
      new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: "KILL-TIMEOUT" }), 10_000)),
    ]);
    return exited;
  };
  let ready = false;
  let dbExists = false;
  let deleted = false;
  let exitCode = null;
  try {
    // 争用下"完成一次同步"可能远超静默机器（主审实测单用例 30.9–77.7 s）⇒ 保护值取 180 s，
    // 避免把**负载**误判成**失败**；无论结果如何，finally 都会杀掉子进程。
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (existsSync(marker)) {
        ready = true;
        break;
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    dbExists = existsSync(path.join(root, "usage-index.sqlite"));
    assert.equal(ready, true, "子进程必须完成一次同步并报到（否则这条检查空转）");
    exitCode = await killChild();
    fixture.close();
    // 进程被外部杀死后：库文件句柄随进程释放 ⇒ 目录必须可删（无孤儿线程/进程残留）。
    for (let attempt = 0; attempt < 10 && !deleted; attempt += 1) {
      try {
        await rm(root, { recursive: true, force: true });
        deleted = !existsSync(root);
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    assert.equal(dbExists, true, "子进程必须真的建过库");
    assert.equal(deleted, true, "外部 kill 后库目录必须可删（无连接/进程泄漏）");
  } finally {
    // 兜底：**任何路径**（成功 / 断言失败 / 超时 / 抛错）都必须杀掉自己起的子进程并释放 fixture。
    await killChild();
    try {
      fixture.close();
    } catch {
      /* 已关 */
    }
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
  record({
    cell: "⑧外部 kill",
    expected: "子进程建库并报到 ⇒ SIGKILL ⇒ 目录可删",
    observed: `ready=${ready}/db=${dbExists}/deleted=${deleted}`,
    detail: exitCode,
  });
});

test("W3 · 证据：故障注入矩阵落盘（W3/out/fault-matrix.json）", async () => {
  // 证据产物**不再依赖前面用例是否通过**（W4 级联红教训）：落盘由 `writeMatrix()` 负责，
  // 未完成的格写成显式 `status: "MISSING"` 占位 ⇒ 本用例只断言"8 格结构齐全"，
  // "每一格都必须有**真实**实测值"这条更严的判据交给 `W3/verify-w3.mjs` 的 `fault.*` 检查（见 handoff）。
  const report = await writeMatrix();
  assert.equal(report.cells.length, expectedCells, `故障矩阵必须有 ${expectedCells} 格（实测 ${report.cells.length}）`);
  assert.ok(
    report.cells.every((row) => row.cell && row.expected && row.observed),
    "每格都必须有 名称/期望/实测（含 MISSING 占位）",
  );
  console.log(
    `  故障矩阵已落盘：${path.relative(process.cwd(), path.join(OUT, "fault-matrix.json"))}（${report.cells.length} 格，真实记录 ${report.summary.recorded} 格）`,
  );
});
