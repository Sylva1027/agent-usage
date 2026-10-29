// M4.3：两个 API 的 `summary.perf`、公开 report 投影与冻结快照。
//
// 卡片：docs/plans/2026-10-04-model-tps-implementation/M4-summary-and-api.md:24-28
//
// 三条独立断言面：
//   ① 形状：`/api/usage`（默认、`view=dashboard`）、`/api/summary`、`/api/usage?detail=full`
//      都返回同形状的完整 summary.perf；view=dashboard 只掉重详情，不掉 perf。
//   ② 脱敏：`detail=full` 的 `report` 与 CLI `json` **不得**序列化 `perfSamples`/`sampleKey`/
//      `sourcePath`/会话路径/`perfMeta`（冻结契约 §3 第 10 条；上游方案 :73）；
//   ③ 来源排除：`exclude=` 必须**同时**作用于两条路径的内部 perf 候选与统计口径；
//   ④ 冻结：`freeze=1` 后继续追加 live 源，旧 snapshot 的 `groups/models/coverage/meta` 一字不变；
//      过期 snapshot 仍是 410。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createUsageServer, withoutExcludedHomes } from "../src/server.js";
import { buildUsageReport, discoverUsageSources, summarizeUsage } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";
import { createPerfCodexIntegrationFixture, createPerfIntegrationFixture } from "../test-support/perf-fixture.mjs";

const ROW_FIELDS = [
  "id",
  "session_id",
  "status",
  "started_at",
  "completed_at",
  "duration_ms",
  "input_tokens",
  "output_tokens",
  "model_id",
  "provider_id",
];

/** 与 `src/perf-sources/zcode.js` 的 `ZCODE_SELECT_COLUMNS` 保持同形的行集合。 */
const BASE = 1_700_000_000_000;

/** 建一个真实 ZCode 物理库（`<root>/<name>/cli/db/db.sqlite`）。 */
function makeZcodeHome(root, name, rows = 25) {
  const dir = path.join(root, name, "cli", "db");
  mkdirSync(dir, { recursive: true });
  const dbFile = path.join(dir, "db.sqlite");
  const db = new DatabaseSync(dbFile);
  db.exec(`CREATE TABLE "model_usage" (${ROW_FIELDS.map((c) => `"${c}"`).join(", ")})`);
  const insert = db.prepare(
    `INSERT INTO "model_usage" (${ROW_FIELDS.map((c) => `"${c}"`).join(", ")}) VALUES (${ROW_FIELDS.map(() => "?").join(", ")})`,
  );
  for (let i = 0; i < rows; i += 1) insertZcodeRow(insert, name, i);
  db.close();
  return path.join(root, name);
}

function insertZcodeRow(insert, name, i) {
  insert.run(
    `${name}-row-${i}`,
    `${name}-session`,
    "completed",
    BASE + i * 1000,
    BASE + i * 1000 + 500,
    500,
    10,
    100 + i,
    "fixture-model",
    "fixture-provider",
  );
}

/** 往已有库追加一行（用于"冻结后 live 源变化"）。 */
function appendZcodeRow(root, name, i) {
  const db = new DatabaseSync(path.join(root, name, "cli", "db", "db.sqlite"));
  try {
    insertZcodeRow(
      db.prepare(
        `INSERT INTO "model_usage" (${ROW_FIELDS.map((c) => `"${c}"`).join(", ")}) VALUES (${ROW_FIELDS.map(() => "?").join(", ")})`,
      ),
      name,
      i,
    );
  } finally {
    db.close();
  }
}

/** 一个 Codex home（提供用量事件 + rate-limit 观测；性能候选不由它提供）。 */
function makeCodexHome(root) {
  const dir = path.join(root, ".codex", "sessions", "2026", "07", "12");
  mkdirSync(dir, { recursive: true });
  const lines = [
    {
      timestamp: "2026-07-12T11:30:00.000Z",
      type: "session_meta",
      payload: { id: "m43-session", source: "cli", originator: "codex-tui", cwd: "/work/m43" },
    },
    { type: "turn_context", payload: { model: "gpt-6-m43" } },
    {
      timestamp: "2026-07-12T11:30:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            total_tokens: 120,
            input_tokens: 100,
            cached_input_tokens: 0,
            output_tokens: 20,
            reasoning_output_tokens: 0,
          },
        },
        rate_limits: {
          limit_id: "codex",
          primary: { window_minutes: 300, resets_at: Date.parse("2026-07-12T14:37:00.000Z") / 1000, used_percent: 10 },
        },
      },
    },
  ];
  writeFileSync(path.join(dir, "rollout-m43.jsonl"), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

/** 一个结构上不支持性能观测的 project-log home。 */
function makeProjectLogHome(root, name) {
  const projectRoot = path.join(root, name);
  const usageDir = path.join(projectRoot, ".codex-usage");
  mkdirSync(usageDir, { recursive: true });
  writeFileSync(
    path.join(usageDir, "usage.jsonl"),
    `${JSON.stringify({
      schema_version: "codex-usage.project-log.v1",
      timestamp: "2026-07-12T12:00:00.000Z",
      source: "codex-oauth",
      channel: "Codex OAuth",
      project_root: projectRoot,
      cwd: projectRoot,
      session_id: "project-log-session",
      model: "project-log-model",
      usage: { total: 77, input: 50, cached: 10, output: 27, reasoning: 6 },
    })}\n`,
  );
  return projectRoot;
}

/** 起一个真实 server（`v8` 高堆 ⇒ `detail=full` 可用）。 */
async function startServer(homeDir, extra = {}) {
  const server = createUsageServer({
    homeDir,
    importStoreFile: path.join(homeDir, "imports.json"),
    databaseFile: path.join(homeDir, "usage-index.sqlite"),
    heapSizeLimitBytes: 4 * 1024 * 1024 * 1024,
    ...extra,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    baseUrl,
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
    json: (query) => fetch(`${baseUrl}/api/usage${query}`).then((response) => response.json()),
  };
}

/** 公开键，包含历史来源状态与当前方法的 Codex 计时覆盖。 */
const PERF_KEYS = [
  "state",
  "ready",
  "methodVersion",
  "indexVersion",
  "indexedAt",
  "degradedHomeIds",
  "missingSources",
  "sourceWarnings",
  "unsupportedSources",
  "rankedHomeIds",
  "groups",
  "models",
  "coverage",
  "codexTimingCoverage",
  "meta",
];

const MODEL_ROW_KEYS = [
  "key",
  "sourceKind",
  "model",
  "reasoningEffort",
  "modelProvider",
  "window",
  "firstSampleAtMs",
  "lastSampleAtMs",
  "rankState",
  "averageTps",
  "p10",
  "p90",
  "n",
  "state",
  "rank",
];

function perfKeys(value) {
  return Object.keys(value ?? {}).sort();
}

function assertModelRows(models, where) {
  assert.ok(Array.isArray(models), `${where}：models 必须是数组`);
  for (const [index, model] of models.entries()) {
    const expectedKeys =
      model.state === "missing_duration"
        ? [...MODEL_ROW_KEYS, "candidateCount", "firstCandidateAtMs", "lastCandidateAtMs"]
        : MODEL_ROW_KEYS;
    assert.deepEqual(
      Object.keys(model).sort(),
      [...expectedKeys].sort(),
      `${where}：models[${index}] 必须是普通 15 字段或缺失时长 18 字段`,
    );
    for (const internal of ["sampleKey", "sourcePath", "sessionId", "turnKey"]) {
      assert.equal(model[internal], undefined, `${where}：models[${index}] 不得泄露 ${internal}`);
    }
  }
}

function assertMissingZcodeModel(perf, candidateCount, where) {
  assert.deepEqual(perf.groups, [], `${where}：ZCode E2E 数据不得生成 v3 速度组`);
  const row = perf.models.find((model) => model.sourceKind === "zcode" && model.model === "fixture-model");
  assert.ok(row, `${where}：必须保留可归属模型的缺失时长行`);
  assert.equal(row.state, "missing_duration");
  assert.equal(row.n, 0);
  assert.equal(row.candidateCount, candidateCount);
  assert.equal(row.averageTps, null);
  assert.equal(row.p10, null);
  assert.equal(row.p90, null);
  assert.equal(row.rank, null);
}

function assertExpectedModels(models, expected, where) {
  assert.equal(models.length, expected.length, `${where}：模型行数`);
  const byIdentity = new Map(models.map((model) => [`${model.sourceKind}\u0000${model.model}`, model]));
  for (const expectedModel of expected) {
    const actual = byIdentity.get(`${expectedModel.sourceKind}\u0000${expectedModel.model}`);
    assert.ok(actual, `${where}：缺少 ${expectedModel.sourceKind}/${expectedModel.model}`);
    for (const [key, value] of Object.entries(expectedModel)) {
      assert.deepEqual(actual[key], value, `${where}：${expectedModel.sourceKind}/${expectedModel.model}.${key}`);
    }
  }
}

function assertFullPerfShape(perf, where) {
  assert.deepEqual(perfKeys(perf), [...PERF_KEYS].sort(), `${where}：summary.perf 必须是完整公开形状`);
  assert.ok(Array.isArray(perf.groups), `${where}：groups 必须是数组`);
  assertModelRows(perf.models, where);
  assert.ok(perf.coverage && typeof perf.coverage === "object", `${where}：coverage 必须是对象`);
  assert.ok(perf.codexTimingCoverage === null || typeof perf.codexTimingCoverage === "object");
  assert.equal(perf.meta.methodVersion, perf.methodVersion, `${where}：meta.methodVersion 与顶层一致`);
}

/** 公开 report **不得**出现的内部键（逐个断言，失败时报出具体键名）。 */
const INTERNAL_REPORT_KEYS = [
  "perfSamples",
  "perfMeta",
  "sampleKey",
  "sourcePath",
  "sessionId",
  "turnKey",
  "sourceKind",
];

test("★M4.3-a 四个入口都返回同形状的完整 summary.perf，dashboard 只掉重详情", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m43-a-"));
  try {
    const zcodePath = makeZcodeHome(root, "z-a", 25);
    makeCodexHome(root);
    const { close, json, baseUrl } = await startServer(root, { extraZcodeHomes: zcodePath });
    try {
      const def = await json("?preset=all");
      const dashboard = await json("?view=dashboard&preset=all");
      const full = await json("?detail=full&preset=all");
      const summaryApi = await fetch(`${baseUrl}/api/summary?preset=all`).then((response) => response.json());

      for (const [where, perf] of [
        ["/api/usage 默认", def.summary.perf],
        ["/api/usage view=dashboard", dashboard.summary.perf],
        ["/api/usage detail=full", full.summary.perf],
        ["/api/summary", summaryApi.summary.perf],
      ]) {
        assertFullPerfShape(perf, where);
      }
      console.log(
        "  [实测] 四个入口 groups =",
        [
          def.summary.perf.groups.length,
          dashboard.summary.perf.groups.length,
          full.summary.perf.groups.length,
          summaryApi.summary.perf.groups.length,
        ].join("/"),
        " state =",
        def.summary.perf.state,
        " models =",
        def.summary.perf.models.length,
      );

      // 前置判别力：候选仍在，并以缺失时长模型行保留；ZCode E2E 不得伪装成 generation。
      assertMissingZcodeModel(def.summary.perf, 25, "四入口");
      assert.equal(def.summary.perf.models.length, 1);
      assert.equal(def.summary.perf.meta.state, "ready");

      // 卡片明文：`view=dashboard` 仍包含分组与覆盖率（只掉重详情）
      assert.equal(dashboard.summary.homes, undefined, "前置：dashboard 确实掉了重详情");
      assert.equal(dashboard.summary.projects, undefined);
      assert.deepEqual(dashboard.summary.perf.groups, def.summary.perf.groups, "dashboard 的 perf 组必须完整");
      assert.deepEqual(dashboard.summary.perf.models, def.summary.perf.models, "dashboard 的模型速度行必须完整");
      assert.deepEqual(dashboard.summary.perf.coverage, def.summary.perf.coverage, "dashboard 的覆盖率必须完整");

      // 卡片明文：两个 API 返回**同形状** ⇒ perf 的 groups/models/coverage/meta 逐字相同
      //（`state/indexVersion/indexedAt` 按路径来源不同，M4.2 已裁定不锚）
      assert.deepEqual(summaryApi.summary.perf.groups, def.summary.perf.groups);
      assert.deepEqual(summaryApi.summary.perf.models, def.summary.perf.models);
      assert.deepEqual(summaryApi.summary.perf.coverage, def.summary.perf.coverage);
      // `indexedAt` 是"本进程何时索引的"时刻，两次请求间会前进（M4.2 已裁定不锚它）⇒ 只锚稳定部分
      const metaForParity = (meta) => ({ ...meta, indexedAt: null });
      assert.deepEqual(metaForParity(summaryApi.summary.perf.meta), metaForParity(def.summary.perf.meta));
    } finally {
      await close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.3-b 公开投影：detail=full 的 report 与 CLI json 都不序列化内部载体", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m43-b-"));
  try {
    const zcodePath = makeZcodeHome(root, "z-b", 25);
    makeCodexHome(root);
    const { close, json } = await startServer(root, { extraZcodeHomes: zcodePath });
    try {
      const full = await json("?detail=full&preset=all");
      assertMissingZcodeModel(full.summary.perf, 25, "detail=full");
      const serialized = JSON.stringify(full.report);
      console.log("  [实测] report 键 =", Object.keys(full.report).sort().join(","), " 长度 =", serialized.length);
      assertModelRows(full.summary.perf.models, "detail=full");
      for (const key of INTERNAL_REPORT_KEYS) {
        assert.equal(full.report[key], undefined, `公开 report 不得含内部键 ${key}`);
      }
      for (const key of ["perfSamples", "perfMeta", "sampleKey", "turnKey", "sampleFlags"]) {
        assert.ok(!serialized.includes(`"${key}"`), `公开 report 序列化后不得出现 ${key}`);
      }
      // 冻结契约 §3 第 10 条：**候选自身的路径**不得外泄。
      // ⚠️ 只锚"候选源路径"（`perfSamples[].sourcePath` = ZCode 库路径）—— 它是 M4.1 新引入的内部载体；
      // **不**锚 `events[].sessionId` / `homes[].path` / `rateLimitObservations[].sourcePath`，
      // 那些是**冻结前**的既有公开形状，本卡不改既有字段（改它们会动到既有消费者）。
      const candidatePath = path.join(zcodePath, "cli", "db", "db.sqlite");
      assert.ok(!serialized.includes(candidatePath), `公开 report 不得含候选源路径 ${candidatePath}`);
      // HTTP 完整报告携带本次计价快照；CLI 保持基础公开报告形状。
      assert.deepEqual(
        Object.keys(full.report).sort(),
        ["events", "generatedAt", "homes", "pricingCatalog", "rateLimitObservations", "sessions", "warnings"],
        "HTTP 完整报告必须包含基础公开字段与计价快照",
      );
      assert.deepEqual(full.report.pricingCatalog, full.pricingCatalog, "报告与响应使用同一份计价快照");
      // 公开报告只投影既有字段，且**不**把 `perfSamples`（候选内部载体）带出来
      assert.equal(full.report.perfSamples, undefined, "公开 report 不得携带内部候选");
      assert.ok(full.report.events.length >= 1, "公开报告的既有事件仍在");
      assert.equal(full.report.rateLimitObservations.length, 1, "既有限额观测仍在");
      assert.ok(full.report.sessions.length >= 1, "既有会话仍在");

      // CLI `codex-usage json`：同一投影。**用 `spawnSync` 而不是 `spawn`** ——
      // `spawn` 的管道子进程在本工作区会偶发挂死（`child.on("close")` 永不触发），
      // 而 `spawnSync` 有硬超时，失败会**响亮**报错而不是把测试跑成僵尸。
      const cli = runCliJsonSync(root, zcodePath);
      console.log("  [实测] CLI json 退出码 =", cli.status, " 输出长度 =", cli.stdout.length);
      assert.equal(cli.status, 0, cli.stderr || "CLI 未在超时内正常退出");
      for (const key of ["perfSamples", "perfMeta", "sampleKey", "turnKey", "sampleFlags"]) {
        assert.ok(!cli.stdout.includes(`"${key}"`), `CLI json 不得序列化 ${key}`);
      }
      assert.ok(cli.stdout.includes('"summary"'), "CLI json 仍须输出 summary（含公开的 summary.perf）");
      // CLI 的公开 report 同样只投影既有字段；`homes[].path` / `events[].sessionId` /
      // `rateLimitObservations[].sourcePath` 是**冻结前**的既有公开形状，不属本卡脱敏面。
      const cliPayload = JSON.parse(cli.stdout);
      assert.deepEqual(
        Object.keys(cliPayload.report).sort(),
        ["events", "generatedAt", "homes", "rateLimitObservations", "sessions", "warnings"],
        "CLI 公开 report 必须是既有 6 个公开字段",
      );
      assert.equal(cliPayload.report.perfSamples, undefined);
      assert.equal(cliPayload.report.perfMeta, undefined);
      assert.ok(cliPayload.summary.perf, "CLI 仍须公开 summary.perf");

      // CLI `summary --json` 是**轻量摘要**（复核 §1 裁定：不得新增 reports/results）：
      // 只输出 `{metadata, summary}`，且 `summary.perf` 与 CLI `json` 的 `summary.perf` parity。
      const summaryCli = runCliSync(root, zcodePath, ["summary", "--json"]);
      console.log("  [实测] summary --json 退出码 =", summaryCli.status, " 长度 =", summaryCli.stdout.length);
      assert.equal(summaryCli.status, 0, summaryCli.stderr || "CLI summary --json 未正常退出");
      const summaryPayload = JSON.parse(summaryCli.stdout);
      assert.deepEqual(
        Object.keys(summaryPayload).sort(),
        ["metadata", "summary"],
        "summary --json 必须保持轻量：恰好两个顶层键",
      );
      assert.equal(summaryPayload.reports, undefined, "summary --json 不得携带完整报告数组（复数）");
      assert.equal(summaryPayload.results, undefined, "summary --json 不得携带逐来源结果数组");
      assertFullPerfShape(summaryPayload.summary.perf, "CLI summary --json");
      // 两条生产路径的 perf parity（上游方案 :66"同 fixture 数值一致"）
      assert.deepEqual(
        summaryPayload.summary.perf.groups,
        cliPayload.summary.perf.groups,
        "索引 CLI 与 CLI json 的 perf 分组必须一致",
      );
      assert.deepEqual(summaryPayload.summary.perf.coverage, cliPayload.summary.perf.coverage);
      console.log(
        "  [实测] summary --json：顶层键 =",
        Object.keys(summaryPayload).sort().join(","),
        " eligible =",
        summaryPayload.summary.perf.coverage.eligible,
        " / CLI json =",
        cliPayload.summary.perf.coverage.eligible,
        " 字节 =",
        summaryCli.stdout.length,
        " / CLI json 字节 =",
        cli.stdout.length,
      );
      assert.equal(summaryPayload.summary.perf.coverage.eligible, 25);
      // 轻量语义：摘要输出必须显著小于完整报告命令（复核实测约 33 倍膨胀）
      // 轻量语义的两条硬指标：①不得携带完整报告数组（已在上面断言）；
      // ②事件数与报告路径的 `report.events.length` 解耦 —— 摘要是**索引聚合**，
      //    这里只有 1 条 Codex 事件，所以只钉"摘要里不得出现任何完整事件对象"。
      assert.ok(!summaryCli.stdout.includes(`"report"`), "summary --json 不得含 `report` 键（单数或复数）");
      for (const key of ["perfSamples", "perfMeta", "sampleKey", "turnKey", "sampleFlags"]) {
        assert.ok(!summaryCli.stdout.includes(`"${key}"`), `CLI summary --json 不得序列化 ${key}`);
      }
    } finally {
      await close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.3-c 来源排除必须同时作用于两条路径的内部候选与统计口径", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m43-c-"));
  try {
    // **两个** ZCode home：只排除其中一个 ⇒ 两条路径都必须留下另一个（eligible=25）。
    // ⚠️ 只用一个 home 是**没有判别力**的：`filters.excludeHomes` 本来就传给 `summarizePerf`，
    //    单独禁掉 `withoutExcludedHomes` 的 perfSamples 过滤**也**会得到 0 ⇒ 测试照样绿
    //    （本卡实测过这个假绿，见交接文档的变异 C2/D2）。
    const zcodeA = makeZcodeHome(root, "z-c1", 25);
    const zcodeB = makeZcodeHome(root, "z-c2", 25);
    const zcodePath = [zcodeA, zcodeB].join(path.delimiter);
    makeCodexHome(root);
    const { close, json } = await startServer(root, { extraZcodeHomes: zcodePath });
    try {
      const base = await json("?preset=all");
      const zcodeHomes = base.metadata.homes.filter((home) => String(home.id).startsWith("zcode-"));
      assert.equal(zcodeHomes.length, 2, "前置：两个 ZCode home 都被发现");
      assert.equal(base.summary.perf.coverage.eligible, 50, "前置：排除前有 50 条候选");
      const excludedId = zcodeHomes[1].id;
      const query = `preset=all&exclude=${encodeURIComponent(excludedId)}`;
      const indexed = await json(`?${query}`);
      const memory = await json(`?detail=full&${query}`);
      console.log(
        "  [实测] 排除一个后 eligible：索引 =",
        indexed.summary.perf.coverage.eligible,
        " 内存 =",
        memory.summary.perf.coverage.eligible,
        " 排除前 =",
        base.summary.perf.coverage.eligible,
      );
      assert.equal(indexed.summary.perf.coverage.eligible, 25, "索引路径必须排除该 home 且保留另一个");
      assert.equal(memory.summary.perf.coverage.eligible, 25, "内存路径必须**同样**排除该 home");
      // 与**同参数**的索引路径逐字对拍 ⇒ 任一实现漏做排除都会分叉
      assert.equal(memory.summary.perf.coverage.eligible, indexed.summary.perf.coverage.eligible);
      assert.deepEqual(indexed.summary.perf.coverage, memory.summary.perf.coverage);
      // 这一层（公开报告/内部载体）的排除是**独立实现**，必须**单独**钉住：
      // 下游 `summarizePerf` 的排除参数会兜住同样的数值，黑盒响应看不出这层有没有做
      // ⇒ 直接对该函数做定向断言（本卡实测：只禁掉这一层，5 个用例全绿）。
      const fakeReport = {
        events: [{ homeId: "keep" }, { homeId: "drop" }],
        sessions: [{ homeId: "keep" }, { homeId: "drop" }],
        perfSamples: [{ homeId: "keep" }, { homeId: "drop" }],
        rateLimitObservations: [],
        warnings: [],
        generatedAt: "x",
      };
      const filtered = withoutExcludedHomes(fakeReport, ["drop"]);
      assert.deepEqual(filtered.events, [{ homeId: "keep" }], "events 必须被排除");
      assert.deepEqual(filtered.sessions, [{ homeId: "keep" }], "sessions 必须被排除");
      assert.deepEqual(filtered.perfSamples, [{ homeId: "keep" }], "内部 perf 候选必须被排除");
      assert.equal(withoutExcludedHomes(fakeReport, []), fakeReport, "无排除时必须原样返回");
      assert.equal(indexed.summary.perf.coverage.positiveOutput, 0, "ZCode raw output 不是 v3 generation 输出");
      assert.equal(indexed.summary.perf.coverage.dropped, 25, "排除后仍保留 25 条缺失时长候选");
      assert.deepEqual(
        indexed.summary.perf.rankedHomeIds,
        zcodeHomes.map((home) => home.id).sort(),
        "M3.4 语义：`rankedHomeIds` 是**未受阻来源**的全集（与 `exclude` 筛选无关），本卡不改",
      );
      assert.equal(indexed.summary.perf.models.length, 1);
      assertMissingZcodeModel(indexed.summary.perf, 25, "排除一个 home 后的索引路径");
      assertMissingZcodeModel(memory.summary.perf, 25, "排除一个 home 后的内存路径");
      // 两条路径的 perf 必须逐字相同（上游方案 :66"同一候选过滤"）
      assert.deepEqual(indexed.summary.perf.groups, memory.summary.perf.groups);
      assert.deepEqual(indexed.summary.perf.models, memory.summary.perf.models);
      assert.deepEqual(indexed.summary.perf.coverage, memory.summary.perf.coverage);
      // `indexVersion`/`indexedAt` 按卡片 parity 面**不在**比较范围（M4.2 已裁定，两条路径
      // 的"何时索引/索引了哪个来源集合"本就不同）；这里锚 groups/coverage + 方法学字段。
      const methodMeta = (meta) => ({ ...meta, indexVersion: null, indexedAt: null });
      assert.deepEqual(methodMeta(indexed.summary.perf.meta), methodMeta(memory.summary.perf.meta));
      // 原有用量口径按设计**不**被来源排除影响（卡片明文"summary.perf 不影响 totals"）。
      assert.ok(indexed.summary.totals.total >= 0, "用量总量必须仍然存在");
      assert.ok(Array.isArray(memory.report.events), "公开报告的事件段仍然存在");
    } finally {
      await close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.3-f 冻结组合：全文/摘要入口不得静默忽略 snapshot，未知 id 一律 410", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m43-f-"));
  try {
    const zcodeA = makeZcodeHome(root, "z-f1", 25);
    const zcodeB = makeZcodeHome(root, "z-f2", 25);
    const zcodePath = [zcodeA, zcodeB].join(path.delimiter);
    makeCodexHome(root);
    const { close, json, baseUrl, port } = await startServer(root, { extraZcodeHomes: zcodePath });
    try {
      const frozen = await json("?freeze=1&preset=all");
      const snapshotId = frozen.snapshotId;
      assert.ok(snapshotId, "前置：freeze=1 必须给出 snapshotId");
      assert.equal(frozen.summary.perf.coverage.eligible, 50, "前置：冻结时 50 条候选");
      assertFullPerfShape(frozen.summary.perf, "组合冻结快照");

      // 冻结后让 live 真实变化：给两个 home 各追加 25 行
      for (let i = 100; i < 125; i += 1) {
        appendZcodeRow(root, "z-f1", i);
        appendZcodeRow(root, "z-f2", i);
      }
      const live = await json("?preset=all");
      assert.equal(live.summary.perf.coverage.eligible, 100, "前置：live 确实变了（50 → 100）");

      const get = (query) => fetch(`${baseUrl}/api/usage${query}`);
      const summaryEntry = (query) => fetch(`${baseUrl}/api/summary${query}`);

      // ① 默认入口：冻结值不变且带 snapshotId
      const defaultFrozen = await json(`?snapshot=${snapshotId}&preset=all`);
      assert.equal(defaultFrozen.summary.perf.coverage.eligible, 50, "默认入口必须用冻结数据");
      assert.deepEqual(defaultFrozen.summary.perf.models, frozen.summary.perf.models);
      assert.equal(defaultFrozen.snapshotId, snapshotId);

      // ② dashboard 入口：同上
      const dashboardFrozen = await json(`?snapshot=${snapshotId}&view=dashboard&preset=all`);
      assert.equal(dashboardFrozen.summary.perf.coverage.eligible, 50, "dashboard 必须用冻结数据");
      assert.deepEqual(dashboardFrozen.summary.perf.models, frozen.summary.perf.models);

      // ③ `/api/summary` 入口：复核点名它此前"始终读 live"（200 + eligible=100）
      const summaryFrozen = await summaryEntry(`?snapshot=${snapshotId}&preset=all`).then((r) => r.json());
      console.log(
        "  [实测] 冻结后 eligible：live =",
        live.summary.perf.coverage.eligible,
        " 默认 =",
        defaultFrozen.summary.perf.coverage.eligible,
        " dashboard =",
        dashboardFrozen.summary.perf.coverage.eligible,
        " /api/summary =",
        summaryFrozen.summary.perf.coverage.eligible,
      );
      assert.equal(summaryFrozen.summary.perf.coverage.eligible, 50, "/api/summary 必须用冻结数据");
      assert.equal(summaryFrozen.snapshotId, snapshotId, "/api/summary 必须回显 snapshotId");
      // 摘要入口不能"只冻结 perf、其余字段走 live" ⇒ metadata/asOf 也要绑定
      assert.deepEqual(summaryFrozen.summary.perf.groups, frozen.summary.perf.groups, "摘要入口分组不变");
      assert.deepEqual(summaryFrozen.summary.perf.models, frozen.summary.perf.models, "摘要入口模型速度行不变");
      assert.deepEqual(summaryFrozen.summary.perf.coverage, frozen.summary.perf.coverage, "摘要入口覆盖率不变");
      assert.deepEqual(summaryFrozen.summary.perf.meta, frozen.summary.perf.meta, "摘要入口 meta 不变");
      assert.deepEqual(
        summaryFrozen.metadata.generatedAt,
        frozen.metadata.generatedAt,
        "摘要入口的 metadata 也必须来自冻结 store（不能只冻结 perf）",
      );

      // ④ 全文入口：内存报告无法绑定冻结 SQLite ⇒ 必须**明确拒绝**，不得返回 200 的 live 结果
      const fullWithSnapshot = await get(`?detail=full&snapshot=${snapshotId}&preset=all`);
      const fullBody = await fullWithSnapshot.json();
      console.log("  [实测] detail=full&snapshot 状态码 =", fullWithSnapshot.status, " code =", fullBody.code);
      assert.equal(fullWithSnapshot.status, 400, "全文 + snapshot 必须被明确拒绝");
      assert.equal(fullBody.code, "SNAPSHOT_FULL_DETAIL_UNSUPPORTED");

      // ⑤ `freeze=1` + `detail=full` 同样拒绝（两个参数都要明确处理）
      const fullWithFreeze = await get("?detail=full&freeze=1&preset=all");
      assert.equal(fullWithFreeze.status, 400, "全文 + freeze=1 必须被明确拒绝");
      assert.equal((await fullWithFreeze.json()).code, "SNAPSHOT_FULL_DETAIL_UNSUPPORTED");

      // ⑥ 未知 snapshot id：三个入口都必须 410（复核实测全文/摘要此前是 200）
      const unknownId = "00000000-0000-4000-8000-000000000000";
      for (const [where, response] of [
        ["默认入口", await get(`?snapshot=${unknownId}&preset=all`)],
        ["dashboard", await get(`?snapshot=${unknownId}&view=dashboard&preset=all`)],
        ["全文入口", await get(`?detail=full&snapshot=${unknownId}&preset=all`)],
        ["摘要入口", await summaryEntry(`?snapshot=${unknownId}&preset=all`)],
      ]) {
        console.log("  [实测] 未知 id", where, "状态码 =", response.status);
        assert.equal(response.status, 410, `${where} 的未知 snapshot id 必须 410`);
        assert.equal((await response.json()).code, "SNAPSHOT_EXPIRED", `${where} 的错误码`);
      }

      // ⑦ 不带任何快照参数时，全文入口照常工作（拒绝只针对"与冻结组合"）
      const plainFull = await get("?detail=full&preset=all");
      assert.equal(plainFull.status, 200, "普通全文请求不受影响");
      const plainBody = await plainFull.json();
      assert.equal(plainBody.summary.perf.coverage.eligible, 100, "普通全文请求读的是 live（100）");
      assert.equal(plainBody.report.perfSamples, undefined, "普通全文请求仍走公开投影");

      assert.ok(port > 0);
    } finally {
      await close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.3-j 被拒绝的全文冻结请求不消耗快照名额，正常创建仍淘汰旧快照", async () => {
  const temporaryDirectory = path.resolve(tmpdir());
  const root = mkdtempSync(path.join(temporaryDirectory, "m43-rejected-freeze-"));
  try {
    const zcodePath = makeZcodeHome(root, "z-rejected", 25);
    const { close, json, baseUrl } = await startServer(root, { extraZcodeHomes: zcodePath });
    try {
      const frozen = await json("?freeze=1&preset=all");
      assert.ok(frozen.snapshotId);
      assert.equal(frozen.summary.perf.coverage.eligible, 25);

      for (let i = 100; i < 125; i += 1) appendZcodeRow(root, "z-rejected", i);
      assert.equal((await json("?preset=all")).summary.perf.coverage.eligible, 50);

      for (let i = 0; i < 8; i += 1) {
        const response = await fetch(`${baseUrl}/api/usage?detail=full&freeze=1&preset=all`);
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, "SNAPSHOT_FULL_DETAIL_UNSUPPORTED");
      }

      const preserved = await fetch(`${baseUrl}/api/usage?snapshot=${frozen.snapshotId}&preset=all`);
      assert.equal(preserved.status, 200, "8 次被拒绝的请求不得淘汰已有快照");
      assert.deepEqual(await preserved.json(), frozen, "已有快照的整份响应必须保持不变");

      const unknown = await fetch(`${baseUrl}/api/usage?detail=full&freeze=1&snapshot=unknown&preset=all`);
      assert.equal(unknown.status, 410, "未知 snapshot 的 410 校验仍优先于组合拒绝");
      assert.equal((await unknown.json()).code, "SNAPSHOT_EXPIRED");

      // 填满 8 个名额后，单次失败请求也不能挤掉最早的有效快照。
      for (let i = 0; i < 7; i += 1) assert.ok((await json("?freeze=1&preset=all")).snapshotId);
      const fullCapacity = await fetch(`${baseUrl}/api/usage?snapshot=${frozen.snapshotId}&preset=all`);
      assert.equal(fullCapacity.status, 200, "8 个有效快照仍应全部保留");
      const rejectedAtCapacity = await fetch(`${baseUrl}/api/usage?detail=full&freeze=1&preset=all`);
      assert.equal(rejectedAtCapacity.status, 400);
      assert.equal((await rejectedAtCapacity.json()).code, "SNAPSHOT_FULL_DETAIL_UNSUPPORTED");
      assert.deepEqual(await json(`?snapshot=${frozen.snapshotId}&preset=all`), frozen);

      const createdIds = new Set();
      for (let i = 0; i < 8; i += 1) {
        const response = await fetch(`${baseUrl}/api/summary?freeze=1&preset=all`);
        assert.equal(response.status, 200);
        const snapshot = await response.json();
        assert.ok(snapshot.snapshotId);
        assert.equal(snapshot.summary.perf.coverage.eligible, 50);
        createdIds.add(snapshot.snapshotId);
        if (i === 0) {
          const ninth = await fetch(`${baseUrl}/api/usage?snapshot=${frozen.snapshotId}&preset=all`);
          assert.equal(ninth.status, 410, "第 9 个有效快照应淘汰最早的快照");
        }
      }
      assert.equal(createdIds.size, 8, "受支持的请求仍创建独立快照");
      const evicted = await fetch(`${baseUrl}/api/usage?snapshot=${frozen.snapshotId}&preset=all`);
      assert.equal(evicted.status, 410, "真正创建 8 个新快照后仍按名额淘汰旧快照");
      assert.equal((await evicted.json()).code, "SNAPSHOT_EXPIRED");
    } finally {
      await close();
    }
  } finally {
    assert.equal(path.dirname(root), temporaryDirectory);
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.3-g 公开 sourceWarnings 两个字段必须同源（含 generation overflow）", async () => {
  const fixture = createPerfCodexIntegrationFixture();
  let running;
  try {
    // 26 条真实 generation 时长各 4e14 ms：每条仍在安全整数内，组内总和必然 overflow。
    const durationMs = 400_000_000_000_000;
    for (const timing of fixture.timingRecords) {
      timing.durationMs = durationMs + 500;
      timing.generation = { ...timing.generation, durationMs };
    }
    const store = new UsageStore(fixture.serverOptions);
    try {
      await store.sync({ options: fixture.reportOptions });
      await fixture.seedRequestTiming(store);
    } finally {
      store.close();
    }
    running = await startServer(fixture.reportOptions.homeDir, fixture.serverOptions);
    try {
      const body = await fetch(`${running.baseUrl}/api/usage?preset=all`).then((response) => response.json());
      const perf = body.summary.perf;
      const top = perf.sourceWarnings;
      const meta = perf.meta.sourceWarnings;
      console.log(
        "  [实测] 顶层 sourceWarnings =",
        JSON.stringify(top.map((w) => w.code)),
        " meta.sourceWarnings =",
        JSON.stringify(meta.map((w) => w.code)),
      );
      assert.ok(
        top.some((warning) => warning.code === "AGGREGATE_OVERFLOW"),
        "顶层必须带上 overflow 告警（复核 §3 的实测缺口）",
      );
      // 裁定：两条汇总路径的顶层与 meta 使用**同一份**规范结果
      assert.deepEqual(top, meta, "顶层与 meta.sourceWarnings 必须逐字相同");
      assert.equal(perf.groups.length, 1, "前置：确实产出了一个组（overflow 才可能出现）");
      // 13 键形状不变
      assert.deepEqual(Object.keys(perf).sort(), [...PERF_KEYS].sort());
      assert.equal(perf.models.length, 1);
      assert.equal(perf.models[0].state, "overflow");
      assert.equal(perf.models[0].rank, null);
      assert.equal(perf.models[0].averageTps, null);
      assert.equal(perf.models[0].p10, null);
      assert.equal(perf.models[0].p90, null);

      // **内存路径**（`/api/usage?detail=full` → `summarizeUsage`）也必须同源：
      // 只钉索引路径时，`summarizeUsage` 单独回退到原始状态告警不会被发现（本卡实测变异 L 未打死）。
      const memory = await fetch(`${running.baseUrl}/api/usage?detail=full&preset=all`).then((response) =>
        response.json(),
      );
      const memoryPerf = memory.summary.perf;
      console.log(
        "  [实测] 内存路径 顶层 =",
        JSON.stringify(memoryPerf.sourceWarnings.map((w) => w.code)),
        " meta =",
        JSON.stringify(memoryPerf.meta.sourceWarnings.map((w) => w.code)),
      );
      assert.deepEqual(memoryPerf.sourceWarnings, memoryPerf.meta.sourceWarnings, "内存路径两字段必须同源");
      assert.ok(
        memoryPerf.sourceWarnings.some((warning) => warning.code === "AGGREGATE_OVERFLOW"),
        "内存路径顶层也必须带 overflow 告警",
      );
    } finally {
      if (running) await running.close();
    }
  } finally {
    fixture.close();
  }
});

test("★M4.3-h 冻结后的告警稳定：顶层与 meta 一起冻结", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m43-h-"));
  try {
    makeZcodeHome(root, "z-h", 25);
    makeCodexHome(root);
    const { close, json, baseUrl } = await startServer(root, { extraZcodeHomes: path.join(root, "z-h") });
    try {
      const frozen = await json("?freeze=1&preset=all");
      const snapshotId = frozen.snapshotId;
      const before = frozen.summary.perf.sourceWarnings;
      const beforeModels = frozen.summary.perf.models;
      console.log("  [实测] 冻结时 sourceWarnings =", JSON.stringify(before.map((w) => w.code)));
      assert.deepEqual(before, frozen.summary.perf.meta.sourceWarnings, "冻结时两字段同源");

      // 冻结后追加会引入新的读取状态；旧快照的告警必须稳定
      for (let i = 100; i < 125; i += 1) appendZcodeRow(root, "z-h", i);
      const reread = await fetch(`${baseUrl}/api/summary?snapshot=${snapshotId}&preset=all`).then((r) => r.json());
      assert.deepEqual(reread.summary.perf.sourceWarnings, before, "旧快照告警不得随 live 变化");
      assert.deepEqual(reread.summary.perf.models, beforeModels, "旧快照模型速度行不得随 live 变化");
      assert.deepEqual(
        reread.summary.perf.sourceWarnings,
        reread.summary.perf.meta.sourceWarnings,
        "快照重读后两字段仍同源",
      );
      const live = await json("?preset=all");
      assert.deepEqual(live.summary.perf.sourceWarnings, live.summary.perf.meta.sourceWarnings, "live 也同源");
    } finally {
      await close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 读 DiskUsage `sqlite` 里 `perf_source_warnings` 的原始内容并对拍公开口径。 */
test("★M4.3-i 域外冻结码不得出现在任何公开字段（含顶层）", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m43-i-"));
  try {
    const zcodePath = makeZcodeHome(root, "z-i", 25);
    makeCodexHome(root);
    const { close, json } = await startServer(root, { extraZcodeHomes: zcodePath });
    try {
      // 先建立索引，再往库里塞一个**域外**冻结码
      const before = await json("?preset=all");
      const databaseFile = path.join(root, "usage-index.sqlite");
      const db = new DatabaseSync(databaseFile);
      try {
        db.exec("CREATE TABLE IF NOT EXISTS perf_source_warnings (home_id TEXT, code TEXT, detail TEXT)");
        db.prepare("INSERT INTO perf_source_warnings (home_id, code, detail) VALUES (?, ?, ?)").run(
          "zcode-evil",
          "UNKNOWN_FROZEN_CODE",
          "synthetic",
        );
      } finally {
        db.close();
      }
      const after = await json("?preset=all");
      const codes = after.summary.perf.sourceWarnings.map((warning) => warning.code);
      console.log("  [实测] 注入域外码后顶层 sourceWarnings =", JSON.stringify(codes));
      assert.ok(!codes.includes("UNKNOWN_FROZEN_CODE"), "域外码不得出现在顶层公开字段");
      assert.deepEqual(after.summary.perf.sourceWarnings, after.summary.perf.meta.sourceWarnings);
      assertMissingZcodeModel(before.summary.perf, 25, "域外告警前置");
    } finally {
      await close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.3-d 冻结快照：live 源变化不影响旧 snapshot；过期 snapshot 仍 410", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m43-d-"));
  try {
    const zcodePath = makeZcodeHome(root, "z-d", 25);
    makeCodexHome(root);
    const { close, json, baseUrl } = await startServer(root, { extraZcodeHomes: zcodePath });
    try {
      const frozen = await json("?freeze=1&preset=all");
      assert.ok(frozen.snapshotId, "前置：freeze=1 必须给出 snapshotId");
      assertFullPerfShape(frozen.summary.perf, "冻结快照");
      const before = {
        groups: frozen.summary.perf.groups,
        models: frozen.summary.perf.models,
        coverage: frozen.summary.perf.coverage,
        meta: frozen.summary.perf.meta,
      };
      assert.equal(before.coverage.eligible, 25);
      assert.equal(before.models[0].n, 0);
      assert.equal(before.models[0].state, "missing_duration");
      assert.equal(before.models[0].candidateCount, 25);

      // 冻结后改动 live 源：追加 25 行（另一个 home 也一起变，确保是"旧 snapshot 不变"而非"没变化"）
      for (let i = 100; i < 125; i += 1) appendZcodeRow(root, "z-d", i);

      const live = await json("?preset=all");
      console.log(
        "  [实测] 冻结时 eligible =",
        before.coverage.eligible,
        " 追加后 live =",
        live.summary.perf.coverage.eligible,
        " 追加后 snapshot =",
        frozen.summary.perf.coverage.eligible,
      );
      assert.equal(live.summary.perf.coverage.eligible, 50, "前置：live 索引确实变了");
      assert.equal(live.summary.perf.models[0].n, 0);
      assert.equal(live.summary.perf.models[0].candidateCount, 50, "live 缺失时长行必须反映新增候选");
      assert.notDeepEqual(live.summary.perf.models, before.models, "live 模型候选覆盖必须随来源变化");

      const reread = await json(`?snapshot=${encodeURIComponent(frozen.snapshotId)}&preset=all`);
      assert.deepEqual(reread.summary.perf.groups, before.groups, "旧 snapshot 的 groups 不得随 live 变化");
      assert.deepEqual(reread.summary.perf.models, before.models, "旧 snapshot 的 models 不得随 live 变化");
      assert.deepEqual(reread.summary.perf.coverage, before.coverage, "旧 snapshot 的 coverage 不得随 live 变化");
      assert.deepEqual(reread.summary.perf.meta, before.meta, "旧 snapshot 的 meta 不得随 live 变化");
      assert.equal(reread.snapshotId, frozen.snapshotId);

      // 过期 snapshot id 仍是 410 + SNAPSHOT_EXPIRED
      const expired = await fetch(`${baseUrl}/api/usage?snapshot=00000000-0000-4000-8000-000000000000`);
      assert.equal(expired.status, 410);
      assert.equal((await expired.json()).code, "SNAPSHOT_EXPIRED");
    } finally {
      await close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("★M4.3-e 冻结路径也走 store：dashboard/full/summary 的 perf 与冻结 store 同源", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "m43-e-"));
  try {
    const zcodePath = makeZcodeHome(root, "z-e", 25);
    makeCodexHome(root);
    const { close, json, baseUrl } = await startServer(root, { extraZcodeHomes: zcodePath });
    try {
      const frozen = await json("?freeze=1&view=dashboard&preset=all");
      const snapshotId = frozen.snapshotId;
      const dashboard = await fetch(`${baseUrl}/api/usage?snapshot=${snapshotId}&view=dashboard&preset=all`).then(
        (response) => response.json(),
      );
      const summaryApi = await fetch(`${baseUrl}/api/summary?preset=all`).then((response) => response.json());
      console.log(
        "  [实测] 冻结 dashboard groups =",
        dashboard.summary.perf.groups.length,
        " /api/summary groups =",
        summaryApi.summary.perf.groups.length,
      );
      assert.deepEqual(dashboard.summary.perf.groups, summaryApi.summary.perf.groups);
      assert.deepEqual(dashboard.summary.perf.models, summaryApi.summary.perf.models);
      assert.deepEqual(dashboard.summary.perf.coverage, summaryApi.summary.perf.coverage);
      assert.equal(dashboard.summary.homes, undefined, "dashboard 仍只掉重详情");
      assertFullPerfShape(dashboard.summary.perf, "冻结 dashboard");
    } finally {
      await close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 跑真实 `node src/cli.js <args>`（子进程，`spawnSync` 带硬超时，捕获真实退出码与 stdout）。 */
function runCliSync(root, zcodePath, args) {
  const cwd = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
  return spawnSync(process.execPath, ["src/cli.js", ...args, "--home-dir", root], {
    cwd,
    env: { ...process.env, CODEX_USAGE_ZCODE_HOMES: zcodePath },
    encoding: "utf8",
    timeout: 120_000,
  });
}

/** `codex-usage json` 的便捷包装。 */
function runCliJsonSync(root, zcodePath) {
  return runCliSync(root, zcodePath, ["json"]);
}

test("M4.4 ZCode vertical slice: both APIs, full report, filters and immutable snapshot", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  const discoveredHomes = await discoverUsageSources(fixture.reportOptions);
  const rankedHomeId = discoveredHomes.find((home) => home.path.endsWith("zcode-ranked")).id;
  let running;
  try {
    running = await startServer(fixture.reportOptions.homeDir, fixture.serverOptions);
    const get = async (route, query = "preset=all&skipCheck=1") => {
      const response = await fetch(`${running.baseUrl}/api/${route}?${query}`);
      assert.equal(response.status, 200, `${route}?${query}`);
      return response.json();
    };
    const assertExpected = (body, name) => {
      const actual = body.summary.perf;
      assertModelRows(actual.models, name);
      assert.equal(actual.state, "ready");
      assert.deepEqual(actual.sourceWarnings, []);
      assert.equal(actual.groups.length, fixture.expected[name].groups.length);
      assertExpectedModels(actual.models, fixture.expected[name].models, name);
      fixture.expected[name].groups.forEach((expected, i) => {
        for (const [key, value] of Object.entries(expected))
          assert.deepEqual(actual.groups[i][key], value, `${name}.${key}`);
      });
      for (const [key, value] of Object.entries(fixture.expected[name].coverage)) {
        assert.deepEqual(actual.coverage[key], value, `${name}.coverage.${key}`);
      }
      assert.equal(
        actual.coverage.eligible,
        actual.coverage.sampled + actual.coverage.dropped + actual.coverage.pending,
      );
      assert.ok(actual.groups.every((group) => group.agentKind !== "main"));
    };
    const usage = await get("usage", "preset=all");
    const summary = await get("summary");
    const dashboard = await get("usage", "preset=all&view=dashboard&skipCheck=1");
    const full = await get("usage", "preset=all&detail=full&skipCheck=1");
    for (const body of [usage, summary, dashboard, full]) assertExpected(body, "all");
    for (const body of [summary, dashboard, full]) {
      assert.deepEqual(body.summary.perf.groups, usage.summary.perf.groups);
      assert.deepEqual(body.summary.perf.coverage, usage.summary.perf.coverage);
    }
    assert.ok(full.report);
    assert.equal("perfSamples" in full.report, false);
    assert.equal("perfMeta" in full.report, false);
    for (const route of ["usage", "summary"]) {
      assertExpected(
        await get(route, `preset=all&exclude=${encodeURIComponent(rankedHomeId)}&skipCheck=1`),
        "smallOnly",
      );
      assertExpected(
        await get(route, "preset=custom&calendarZone=utc&startDate=2026-10-04&endDate=2026-10-04&skipCheck=1"),
        "dayB",
      );
    }
    assertExpected(
      await get("usage", `preset=all&detail=full&exclude=${encodeURIComponent(rankedHomeId)}`),
      "smallOnly",
    );
    const frozen = await get("usage", "preset=all&freeze=1&skipCheck=1");
    assert.ok(frozen.snapshotId);
    const frozenSummary = await get("summary", `preset=all&snapshot=${frozen.snapshotId}`);
    assertExpected(frozen, "all");
    assert.deepEqual(frozenSummary.summary.perf, frozen.summary.perf);
    // Change the real upstream SQLite file, then explicitly sync through the live API.
    const dbFile = path.join(fixture.reportOptions.homeDir, "zcode-small", "cli", "db", "db.sqlite");
    const db = new DatabaseSync(dbFile);
    try {
      assert.equal(db.prepare("UPDATE model_usage SET output_tokens=10 WHERE id='small-1'").run().changes, 1);
    } finally {
      db.close();
    }
    const live = await get("usage", "preset=all");
    const changedSmall = live.summary.perf.models.find(
      (model) => model.sourceKind === "zcode" && model.model === "small-model",
    );
    assert.equal(changedSmall.state, "missing_duration");
    assert.equal(changedSmall.candidateCount, 9);
    assert.deepEqual(live.summary.perf.groups, []);
    assert.notEqual(live.summary.perf.indexVersion, frozen.summary.perf.indexVersion);
    assert.deepEqual(
      await get("usage", `preset=all&snapshot=${frozen.snapshotId}`),
      frozen,
      "entire frozen usage response, including metadata/quota/comparison, must stay unchanged",
    );
    assert.deepEqual(await get("summary", `preset=all&snapshot=${frozen.snapshotId}`), frozenSummary);
    assertExpected(
      await get("summary", `preset=all&snapshot=${frozen.snapshotId}&exclude=${encodeURIComponent(rankedHomeId)}`),
      "smallOnly",
    );
    console.log(`M4.4 API fixtureHash=${fixture.fixtureHash}; ZCode rows stay missing_duration across live/frozen`);
  } finally {
    if (running) await running.close();
    fixture.close();
    fixture.close();
  }
});

test("M4.5 mixed DSH/ZCode APIs and frozen snapshot survive corrupted multiframe homes", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh"] });
  let running;
  try {
    running = await startServer(fixture.reportOptions.homeDir, fixture.serverOptions);
    const get = async (route, query = "preset=all&skipCheck=1") => {
      const response = await fetch(`${running.baseUrl}/api/${route}?${query}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const assertExpected = (perf, expected) => {
      assertModelRows(perf.models, "M4.5");
      assert.equal(perf.groups.length, expected.groups.length);
      assertExpectedModels(perf.models, expected.models, "M4.5");
      expected.groups.forEach((group, i) => {
        for (const [key, value] of Object.entries(group)) assert.deepEqual(perf.groups[i][key], value, key);
      });
      for (const [key, value] of Object.entries(expected.coverage)) assert.deepEqual(perf.coverage[key], value, key);
    };
    const initial = await get("usage", "preset=all");
    assert.equal(initial.summary.perf.state, "ready");
    const dshHomeId = (await discoverUsageSources(fixture.reportOptions)).find((home) => home.kind === "dsh").id;
    for (const [route, query] of [
      ["usage", "preset=all&skipCheck=1"],
      ["usage", "preset=all&view=dashboard&skipCheck=1"],
      ["summary", "preset=all&skipCheck=1"],
      ["usage", "preset=all&detail=full&skipCheck=1"],
    ]) {
      const body = await get(route, query);
      assertExpected(body.summary.perf, fixture.expected.all);
      assert.deepEqual(body.summary.perf.groups, initial.summary.perf.groups);
      assert.deepEqual(body.summary.perf.coverage, initial.summary.perf.coverage);
      assert.equal(JSON.stringify(body.summary.perf).includes("SENTINEL"), false);
      if (body.report) assert.equal("perfSamples" in body.report, false);
    }
    for (const route of ["usage", "summary"]) {
      assertExpected(
        (await get(route, `preset=all&exclude=${encodeURIComponent(dshHomeId)}&skipCheck=1`)).summary.perf,
        fixture.expected.zcodeOnly,
      );
      assertExpected(
        (await get(route, "preset=custom&calendarZone=utc&startDate=2026-10-04&endDate=2026-10-04&skipCheck=1")).summary
          .perf,
        fixture.expected.dayB,
      );
    }
    const frozen = await get("usage", "preset=all&freeze=1&skipCheck=1");
    const frozenSummary = await get("summary", `preset=all&snapshot=${frozen.snapshotId}`);
    const files = ["fixture-session-a", "fixture-session-b"].map((session) =>
      path.join(fixture.reportOptions.homeDir, "dsh-fixture", "sessions", "fixture", session, "session.v4.jsonl.zstd"),
    );
    const originals = files.map((file) => readFileSync(file));
    for (const file of files) appendFileSync(file, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
    const broken = await get("usage", "preset=all");
    for (const body of [broken, await get("summary"), await get("usage", "preset=all&detail=full")]) {
      const perf = body.summary.perf;
      assert.equal(perf.state, "degraded");
      assert.deepEqual(perf.degradedHomeIds, [dshHomeId]);
      assert.deepEqual(perf.sourceWarnings, [
        { sourceKind: "dsh", homeId: dshHomeId, code: "MALFORMED_FRAME", count: 2 },
      ]);
      assertExpected(perf, fixture.expected.zcodeOnly);
    }
    assert.deepEqual(await get("usage", `preset=all&snapshot=${frozen.snapshotId}`), frozen);
    assert.deepEqual(await get("summary", `preset=all&snapshot=${frozen.snapshotId}`), frozenSummary);
    files.forEach((file, i) => {
      writeFileSync(file, originals[i]);
    });
    const recovered = await get("usage", "preset=all");
    assert.equal(recovered.summary.perf.state, "ready");
    assert.deepEqual(recovered.summary.perf.sourceWarnings, []);
    assertExpected(recovered.summary.perf, fixture.expected.all);
    console.log(
      `M4.5 API fixtureHash=${fixture.fixtureHash}; two failed files -> one degraded home/count2; snapshot immutable`,
    );
  } finally {
    if (running) await running.close();
    fixture.close();
  }
});

test("M4.5 nonfatal DSH diagnostics match default, summary, full and remain in frozen responses", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh"] });
  let running;
  const files = ["fixture-session-a", "fixture-session-b"].map((session) =>
    path.join(fixture.reportOptions.homeDir, "dsh-fixture", "sessions", "fixture", session, "session.v4.jsonl.zstd"),
  );
  const originals = files.map((file) => readFileSync(file));
  const diagnostic = zstdCompressSync(
    Buffer.from(`${JSON.stringify({ type: "step/start", time: BASE, data: { turn: "invalid", step: 1 } })}\n`),
  );
  const dshHomeId = (await discoverUsageSources(fixture.reportOptions)).find((home) => home.kind === "dsh").id;
  try {
    for (const file of files) appendFileSync(file, diagnostic);
    running = await startServer(fixture.reportOptions.homeDir, fixture.serverOptions);
    const get = async (route, query) => {
      const response = await fetch(`${running.baseUrl}/api/${route}?${query}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const expected = [
      {
        sourceKind: "dsh",
        homeId: dshHomeId,
        code: "UNKEYABLE_RECORD",
        count: 2,
      },
    ];
    const defaultUsage = await get("usage", "preset=all&skipCheck=1");
    const summary = await get("summary", "preset=all&skipCheck=1");
    const full = await get("usage", "preset=all&detail=full&skipCheck=1");
    for (const body of [defaultUsage, summary, full]) {
      assert.deepEqual(body.summary.perf.sourceWarnings, expected);
      assert.equal(body.summary.perf.state, "ready", "ordinary identity diagnostics do not degrade a home");
    }

    const frozenUsage = await get("usage", "preset=all&freeze=1&skipCheck=1");
    const frozenSummary = await get("summary", `preset=all&snapshot=${frozenUsage.snapshotId}`);
    assert.deepEqual(frozenUsage.summary.perf.sourceWarnings, expected);
    assert.deepEqual(frozenSummary.summary.perf.sourceWarnings, expected);

    files.forEach((file, index) => {
      writeFileSync(file, originals[index]);
    });
    const repaired = await get("usage", "preset=all");
    assert.deepEqual(repaired.summary.perf.sourceWarnings, []);
    assert.deepEqual(await get("usage", `preset=all&snapshot=${frozenUsage.snapshotId}`), frozenUsage);
    assert.deepEqual(await get("summary", `preset=all&snapshot=${frozenUsage.snapshotId}`), frozenSummary);
  } finally {
    if (running) await running.close();
    fixture.close();
  }
});

test("M4.5 legacy warning-map backfill aligns APIs and preserves old frozen responses", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh"] });
  let running;
  const file = path.join(
    fixture.reportOptions.homeDir,
    "dsh-fixture",
    "sessions",
    "fixture",
    "fixture-session-a",
    "session.v4.jsonl.zstd",
  );
  const original = readFileSync(file);
  appendFileSync(
    file,
    zstdCompressSync(
      Buffer.from(`${JSON.stringify({ type: "step/start", time: BASE, data: { turn: "invalid", step: 1 } })}\n`),
    ),
  );
  try {
    running = await startServer(fixture.reportOptions.homeDir, fixture.serverOptions);
    const get = async (route, query) => {
      const response = await fetch(`${running.baseUrl}/api/${route}?${query}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const initial = await get("usage", "preset=all");
    const expected = initial.summary.perf.sourceWarnings;
    assert.equal(expected.length, 1);
    assert.equal(expected[0].code, "UNKEYABLE_RECORD");
    const oldFrozenUsage = await get("usage", "preset=all&freeze=1");
    const oldFrozenSummary = await get("summary", `preset=all&snapshot=${oldFrozenUsage.snapshotId}`);
    assert.deepEqual(oldFrozenUsage.summary.perf.sourceWarnings, expected);

    // Simulate an index created before per-file warnings existed, then partially
    // upgraded by another file: only this unchanged DSH file lacks its entry.
    const db = new DatabaseSync(fixture.serverOptions.databaseFile);
    try {
      const raw = db.prepare("SELECT value FROM store_meta WHERE key='perf_file_warnings'").get()?.value;
      assert.equal(typeof raw, "string");
      const warningMap = JSON.parse(raw);
      assert.equal(Object.hasOwn(warningMap, file), true);
      delete warningMap[file];
      db.prepare("UPDATE store_meta SET value=? WHERE key='perf_file_warnings'").run(JSON.stringify(warningMap));
      db.prepare("UPDATE store_meta SET value='[]' WHERE key='perf_source_warnings'").run();
    } finally {
      db.close();
    }

    const upgradedDefault = await get("usage", "preset=all");
    const upgradedSummary = await get("summary", "preset=all&skipCheck=1");
    const upgradedFull = await get("usage", "preset=all&detail=full&skipCheck=1");
    for (const body of [upgradedDefault, upgradedSummary, upgradedFull]) {
      assert.deepEqual(body.summary.perf.sourceWarnings, expected);
    }

    const verifyDb = new DatabaseSync(fixture.serverOptions.databaseFile, { readOnly: true });
    try {
      const raw = verifyDb.prepare("SELECT value FROM store_meta WHERE key='perf_file_warnings'").get().value;
      assert.equal(Object.hasOwn(JSON.parse(raw), file), true, "successful API sync publishes the missing file entry");
    } finally {
      verifyDb.close();
    }

    const newFrozenUsage = await get("usage", "preset=all&freeze=1");
    const newFrozenSummary = await get("summary", `preset=all&snapshot=${newFrozenUsage.snapshotId}`);
    assert.deepEqual(newFrozenUsage.summary.perf.sourceWarnings, expected);
    assert.deepEqual(newFrozenSummary.summary.perf.sourceWarnings, expected);
    assert.deepEqual(await get("usage", `preset=all&snapshot=${oldFrozenUsage.snapshotId}`), oldFrozenUsage);
    assert.deepEqual(await get("summary", `preset=all&snapshot=${oldFrozenUsage.snapshotId}`), oldFrozenSummary);
  } finally {
    writeFileSync(file, original);
    if (running) await running.close();
    fixture.close();
  }
});

test("M4.6 OpenCode is consistent across both APIs, full details and immutable snapshots", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode", "dsh", "opencode"] });
  let running;
  try {
    running = await startServer(fixture.reportOptions.homeDir, fixture.serverOptions);
    const get = async (route, query = "preset=all&skipCheck=1") => {
      const response = await fetch(`${running.baseUrl}/api/${route}?${query}`);
      assert.equal(response.status, 200, `${route}?${query}`);
      return response.json();
    };
    const assertExpected = (perf, expected) => {
      assert.equal(perf.state, "ready");
      assertModelRows(perf.models, "M4.6");
      assert.equal(perf.groups.length, expected.groups.length);
      assertExpectedModels(perf.models, expected.models, "M4.6");
      expected.groups.forEach((group, index) => {
        for (const [key, value] of Object.entries(group)) assert.deepEqual(perf.groups[index][key], value, key);
      });
      for (const [key, value] of Object.entries(expected.coverage)) assert.deepEqual(perf.coverage[key], value, key);
    };
    const initial = await get("usage", "preset=all");
    const opencodeHomeId = (await discoverUsageSources(fixture.reportOptions)).find(
      (home) => home.kind === "opencode",
    ).id;
    const warning = initial.summary.perf.sourceWarnings.find((entry) => entry.sourceKind === "opencode");
    assert.deepEqual(warning, {
      sourceKind: "opencode",
      homeId: opencodeHomeId,
      code: "UNSUPPORTED_SCHEMA",
      count: 2,
    });
    const entryRoutes = [
      ["usage", "preset=all&skipCheck=1"],
      ["usage", "preset=all&view=dashboard&skipCheck=1"],
      ["summary", "preset=all&skipCheck=1"],
      ["usage", "preset=all&detail=full&skipCheck=1"],
    ];
    for (const [route, query] of entryRoutes) {
      const body = await get(route, query);
      assertExpected(body.summary.perf, fixture.expected.all);
      assert.deepEqual(body.summary.perf.sourceWarnings, [warning]);
      assert.equal(JSON.stringify(body.summary.perf).includes("OPENCODE-INTEGRATION-BODY-SENTINEL"), false);
      if (body.report) {
        assert.equal("perfSamples" in body.report, false);
        assert.equal("perfMeta" in body.report, false);
      }
    }
    const frozen = await get("usage", "preset=all&freeze=1&skipCheck=1");
    const frozenSummary = await get("summary", `preset=all&snapshot=${frozen.snapshotId}`);
    assertExpected(frozen.summary.perf, fixture.expected.all);
    assert.deepEqual(frozenSummary.summary.perf, frozen.summary.perf);

    const dbFile = path.join(fixture.reportOptions.homeDir, "opencode-fixture", "opencode-extra.db");
    const db = new DatabaseSync(dbFile);
    try {
      const row = db
        .prepare("SELECT data FROM session_message WHERE id=? AND session_id=?")
        .get("same-message", "oc-v2-second");
      const changedData = JSON.parse(row.data);
      changedData.tokens.output = 250;
      assert.equal(
        db
          .prepare("UPDATE session_message SET data=? WHERE id=? AND session_id=?")
          .run(JSON.stringify(changedData), "same-message", "oc-v2-second").changes,
        1,
      );
    } finally {
      db.close();
    }
    const expectedChanged = structuredClone(fixture.expected.all);
    const changedInitial = await get("usage", "preset=all");
    assert.notEqual(changedInitial.summary.perf.indexVersion, frozen.summary.perf.indexVersion);
    assert.deepEqual(changedInitial.summary.perf.groups, [], "OpenCode raw output does not imply generation timing");
    for (const [route, query] of entryRoutes) {
      const body = await get(route, query);
      assertExpected(body.summary.perf, expectedChanged);
      assert.deepEqual(body.summary.perf.sourceWarnings, [warning]);
    }

    const newFrozen = await get("usage", "preset=all&freeze=1&skipCheck=1");
    const newFrozenSummary = await get("summary", `preset=all&snapshot=${newFrozen.snapshotId}`);
    assertExpected(newFrozen.summary.perf, expectedChanged);
    assert.deepEqual(newFrozenSummary.summary.perf, newFrozen.summary.perf);
    assert.deepEqual(await get("usage", `preset=all&snapshot=${frozen.snapshotId}`), frozen);
    assert.deepEqual(await get("summary", `preset=all&snapshot=${frozen.snapshotId}`), frozenSummary);
    console.log(
      "M4.6 API fixtureHash=" +
        fixture.fixtureHash +
        "; OpenCode mutation updates live/default/summary/full while prior usage+summary snapshots remain stable",
    );
  } finally {
    if (running) await running.close();
    fixture.close();
  }
});

test("D3 unsupported project-log sources stay out of model speed rows", async () => {
  const fixture = createPerfIntegrationFixture({ sources: ["zcode"] });
  let running;
  try {
    const projectRoot = makeProjectLogHome(fixture.reportOptions.homeDir, "project-log-unsupported");
    running = await startServer(fixture.reportOptions.homeDir, {
      ...fixture.serverOptions,
      importDirs: [projectRoot],
    });
    const get = async (route, query) => {
      const response = await fetch(`${running.baseUrl}/api/${route}?${query}`);
      assert.equal(response.status, 200, `${route}?${query}`);
      return response.json();
    };
    const bodies = [
      await get("usage", "preset=all&skipCheck=1"),
      await get("usage", "preset=all&view=dashboard&skipCheck=1"),
      await get("summary", "preset=all&skipCheck=1"),
      await get("usage", "preset=all&detail=full&skipCheck=1"),
    ];
    const baseline = bodies[0].summary.perf.models;
    assert.equal(baseline.length, 2);
    assert.ok(baseline.every((model) => model.model !== "project-log-model"));
    const unsupported = bodies[0].summary.perf.unsupportedSources;
    const projectHome = bodies[0].metadata.homes.find((home) => home.kind === "project-log");
    assert.ok(projectHome, "fixture must discover the project-log home");
    assert.ok(unsupported.some((source) => source.homeId === projectHome.id));
    assert.equal(JSON.stringify(unsupported).includes(projectRoot), false);
    for (const body of bodies) {
      const perf = body.summary.perf;
      assertModelRows(perf.models, "project-log");
      assert.deepEqual(perf.models, baseline);
      assert.ok(perf.unsupportedSources.some((source) => source.homeId === projectHome.id));
      assert.equal(JSON.stringify(perf.unsupportedSources).includes(projectRoot), false);
    }
  } finally {
    if (running) await running.close();
    fixture.close();
  }
});

test("C2 WorkBuddy API keeps trace-only messages as missing-duration candidates", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "c2-workbuddy-api-"));
  const homePath = path.join(root, ".workbuddy-ai");
  const projectDir = path.join(homePath, "projects", "fixture");
  const traceDir = path.join(homePath, "traces", "102284");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(traceDir, { recursive: true });
  const timestamp = Date.parse("2026-10-21T00:08:41.249Z");
  const usageRecord = (messageId) => ({
    timestamp,
    type: "function_call",
    providerData: {
      messageId,
      model: "deepseek-v4.1-flash",
      usage: {
        inputTokens: 1000,
        outputTokens: 200,
        totalTokens: 1200,
        inputTokensDetails: [{ cached_tokens: 0 }],
        outputTokensDetails: [{ reasoning_tokens: 10 }],
      },
    },
    sessionId: "c2-api-session",
    cwd: "/work/c2-api",
  });
  const traceRow = (messageId, duration) => ({
    type: "span_end",
    span: {
      type: "generation",
      status: "ok",
      duration,
      endedAt: "2026-10-21T00:08:56.704Z",
      toolOutput: JSON.stringify([{ id: messageId }]),
    },
  });
  const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  let running;
  try {
    writeFileSync(
      path.join(projectDir, "c2-api-session.jsonl"),
      jsonl([usageRecord("msg-same"), usageRecord("msg-conflict")]),
    );
    writeFileSync(
      path.join(traceDir, "trace_c2.jsonl"),
      jsonl([traceRow("msg-same", 900), traceRow("msg-conflict", 800), traceRow("msg-conflict", 850)]),
    );

    const options = { homeDir: root, env: {} };
    const homes = await discoverUsageSources(options);
    const memory = summarizeUsage(await buildUsageReport({ homeDir: root, homes }), {
      preset: "all",
      now: new Date("2026-10-21T01:00:00.000Z"),
    }).perf;

    running = await startServer(root);
    const usage = await running.json("?preset=all&skipCheck=1");
    const summary = await fetch(`${running.baseUrl}/api/summary?preset=all&skipCheck=1`).then((response) =>
      response.json(),
    );

    for (const perf of [usage.summary.perf, summary.summary.perf]) {
      assert.equal(perf.coverage.eligible, 2);
      assert.deepEqual(perf.groups, [], "trace-only generation spans cannot produce speed groups");
      assert.equal(perf.models.length, 1);
      assert.equal(perf.models[0].state, "missing_duration");
      assert.equal(perf.models[0].candidateCount, 2);
      assert.deepEqual(perf.groups, memory.groups);
      assert.deepEqual(perf.models, memory.models);
      assert.deepEqual(perf.coverage, memory.coverage);
    }
  } finally {
    if (running) await running.close();
    rmSync(root, { recursive: true, force: true });
  }
});
