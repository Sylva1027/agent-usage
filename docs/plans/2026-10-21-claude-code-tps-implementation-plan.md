# Claude Code TPS：多 subagent 并行实施计划

日期：2026-10-21。状态：**待开工**。本稿把[Claude Code TPS 方案](2026-10-21-claude-code-tps-plan.md)的 §6–§8 拆成可并行派发的卡片：谁改哪些文件、开工条件、验收命令、失败怎么停。方法口径（锚点、分子、排名准入）以方案为准，本稿不重新论证。

本计划由**本会话独立推进**：派发、复核、收口都在这里完成，不依赖[三 worker 执行单](2026-10-21-tps-measurement-parallel-execution.md)的分工或排期——那是 Codex v2 另一条线的内部安排。当前工作区已带那批未提交改动（`src/perf-stats.js`、`src/usage-core.js` 等），本计划把它们当作**基线现状**：在其上做加法，不等待、不接管、也不回滚。

## 0 使用方式

本会话按 §3 的依赖图派发自己起的 subagent；每个 subagent 拿到 §5 对应的启动提示，只写 §2 分配给它的文件。**不使用独立 worktree**：本轮改动依赖工作区里未提交的 tps-v2 代码，worktree 从 HEAD 切出会丢掉这些文件。隔离靠**单写者**，不靠目录。

每个 agent 只回三样东西：改了什么（文件 + 行为）、跑了什么（命令 + exit + 通过数）、还缺什么。报告写到 `output/claude-tps/reports/<卡号>.md`（未跟踪、可写；不要写 `docs/validation/`，那条路径被 hook 拒绝且被 git exclude）。

## 1 冻结契约（开工前必读，实现不得偏离）

### C-1 reader 签名

```js
export async function streamClaudePerfSamples(filePath, source, onSample, options = {})
// → { state: "enabled", stats: { candidates, skippedZeroUsage, skippedNoAnchor, missingMessageId, malformedLines } }
```

- `filePath`：一个物理转录文件（主转录或 `subagents/agent-*.jsonl`）。
- `source`：`{ id, path, kind, label }`；`homeId = String(source.id || source.path).trim()`。
- `onSample(raw)`：**只**对 `bestOutput > 0` 且锚点可用的消息各调用一次。
- `onWarning({ sourceKind: "claude", homeId, code, count })`：`code` 只能是 `MALFORMED_JSON`（坏行）或 `UNKEYABLE_RECORD`（`assistant` 行有 usage 但缺 `message.id`）。方案 §5.5 写的 `CLAUDE_MALFORMED_JSON:n` 是契约写法；本 reader 自己解析行，直接产出结构化对象，**不要**先拼字符串再解析。
- 逐行问题不抛异常；只有读取本身失败才向上抛（由 `replaceFile` 回滚）。
- 复用 `readRolloutLines`（`src/codex-rollout.js:150`，处理 U+2028/U+2029）与 `claudeUsageFromRaw`（`src/claude-code-usage.js:144`）。**不要**复用 `streamClaudeSessionEvents`：它丢行时间戳，且会做仓库解析。
- `stats.candidates` = 该文件里**去重后**的 `message.id` 数（不含 `model` 以 `<` 开头的 synthetic 行）；`skippedZeroUsage` 与 `skippedNoAnchor` 是其子集；`emitted = candidates − skippedZeroUsage − skippedNoAnchor`。写测试时按这个恒等式断言。

### C-2 raw 候选（键名固定）

```js
{
  sourceKind: "claude", homeId, sourcePath,
  identity: [messageId], messageId, sessionId,
  channel: "claude",
  agentKind: "main" | "subagent",
  agent: attributionAgent || "",
  model: message.model, modelProvider: "",
  reasoningEffort: effort || "", modelEvidence: "request_scope",
  window: "request", timingKind: "request_e2e",
  timingSource: "timestamp_fallback",
  tokenScope: "reported_output_includes_reasoning",
  status: "completed" | "unverified",
  tsMs: lastTs, windowStartMs: anchorTs, windowEndMs: lastTs,
  durationMs: lastTs - anchorTs,
  outputTokens: bestOutput, inputTokens: bestInput, requestCount: 1,
}
```

`anchorTs` 规则见方案 §2.2：锚点只取运行最大值的 prompt 行（`user`/`attachment`）；首行时若 `assistantTs > promptTs` ⇒ 不采样。`assistantTs` 只用于判陈旧。raw 里**不含** `methodVersion`：落库时由内核填当前常量（工作区现为 `tps-v2`），见方案 §6.3。

### C-3 内核四处（`src/perf-stats.js`）

1. `PERF_SOURCE_SEMANTICS`（`:100-117`）追加：
   ```js
   claude: Object.freeze({ window: "request", timingKind: "request_e2e", tokenScope: "reported_output_includes_reasoning" }),
   ```
2. `PERF_SOURCE_KINDS`（`:120`）改为 `["zcode", "dsh", "opencode", "codex", "workbuddy", "claude"]`。
3. `canonicalPerfSourceKind`（`:310-314`）的字符串分支加 `"claude"`；**JSDoc `@returns` 的联合类型也要加 `"claude"`**，否则 `npm.cmd run typecheck` 会因 checkJs 推断失败。
4. `isPerfRankAdmitted`（`:1069-1079`）按方案 §6.5 改写：共享条件（methodVersion / timingKind / tokenScope / METHOD_ESTIMATE）先判，Codex 分支逐字保留，新增 `claude` 分支（`window === "request" && timingSource === "timestamp_fallback"`）；同步改写 `:1055-1064` 的准入注释。

### C-4 注册

`src/perf-sources/index.js:46-54` 的 Map **末尾**追加 `["claude", streamClaudePerfSamples]`，并在文件顶部加 import。这一行是唯一的停车开关：V1 若不通过，删掉它即可禁用整个来源，不必回滚内核。

### C-5 文件发现

`src/usage-core.js:2253-2261` 的 `perfPhysicalFilesForHome` 增加一行：

```js
if (home.kind === "claude") return await claudeSessionFiles(home.path);
```

`claudeSessionFiles` 从 `src/claude-code-usage.js:88` 导入。不加这一行会出现内存路径 0 条、SQLite 有样本的 parity 破裂（方案 §6.4 第 4 条）。

### C-6 界面

`public/perf-ui.js:77-88` 的 `sourceLabel` 加 `claude: "Claude"`。`public/timeline-utils.js` 已含 claude 映射，**不改**。

### C-7 禁止改动

`src/usage-store.js` 的 schema/迁移与 `usageFiles()`、`STORE_SCHEMA_VERSION`、`PERF_METHOD_VERSION`、`resolvePerfSampleKey`、`src/claude-code-usage.js` 的导出面、`scripts/perf-probe.mjs`、`public/skin-bootstrap.js`、`tools/out/**`、`.claude/**`。任何卡都不提交、不推送。

## 2 文件所有权与冲突矩阵

| 文件 | 本计划 owner | 工作区现状 | 规则 |
| --- | --- | --- | --- |
| `src/perf-sources/claude.js`（新） | R1 | 不存在 | 独占新建 |
| `test/perf-claude.test.js`（新） | R1 | 不存在 | 独占新建 |
| `test-support/claude-perf-fixture.mjs`（新） | R1 | 不存在 | 独占新建 |
| `src/perf-stats.js` | K1 | 有未提交改动（tps-v2） | 只做 C-3 四处，**加法式**，既有 Codex 分支逐字不动 |
| `test/perf-stats.test.js` | K1 | 有未提交改动 | 只追加 claude 语义行 |
| `test/perf-models.test.js` | K1 | 有未提交改动 | 只追加准入/拒绝用例；不要重建整个文件 |
| `src/perf-sources/index.js` | S1 | 有未提交改动 | 独占；等 R1 的 reader 文件存在后再注册 |
| `src/usage-core.js` | S1 | 有未提交改动 | 只加 C-5 一行 |
| `test/perf-store.test.js` | S1 | 有未提交改动 | 只改两处注册表列表钉住 |
| `test/perf-workbuddy.test.js` | S1 | 有未提交改动 | **只改 `:62`、`:183` 两个数组字面量** |
| `public/perf-ui.js`、`test/perf-ui.test.js` | U1 | 有未提交改动 | 只加 `claude` 键；G4 由本会话复核 |
| `README.md`、`README.en.md`、`docs/{10,12,02}-*.md`、`docs/data-sources/claude-code.md`、修订方案 `:61` | U1 | 有未提交改动 | 只加 Claude 相关句子，不重排、不格式化；先看 `git diff` 再改 |
| `output/claude-tps/**` | 所有人 | 无 | 报告与临时库；未跟踪 |

同一文件只有一个写入者，这是唯一的硬规则。上表"有未提交改动"的文件不是禁区，也不需要谁批准：开工前先 `git diff -- <file>` 看清现状，改动只做加法，不重排、不格式化、不回滚既有改动。派发后若发现该文件在派发后被外部修改（内容或 mtime 与派发时不符），该卡立即停手写报告，由本会话裁定，**不接受两个 agent 同时写同一个文件**。

## 3 依赖图与开工条件

```text
R1 (reader) ──────────────→ S1 (注册/发现/存储) ─┐
K1 (内核) ───────────────────────────────────────┤─→ V1 (独立验收)
U1 (界面/文档) ──────────────────────────────────┘
```

- **现在就能并行**：R1、K1、U1，三张卡的文件两两不相交，互不等待。K1 只动 `perf-stats.js` 的加法面，不依赖 reader 存在。
- **并行度**：任一时刻最多 3 个 agent。第一批正好三张；S1 等 R1 的 `claude.js` 落地与 K1 落地后单独跑，体量小；V1 最后独占一轮，避免边改边验。
- **S1 的开工条件**：`src/perf-sources/claude.js` 已存在（import 目标）；K1 已落地（否则 `normalizePerfSample` 以 `UNSUPPORTED_SOURCE_KIND` 拒绝 claude，集成测试必红）。
- **V1 的开工条件**：K1、S1、U1 全部落地并通过各自定向测试。

共享工作区的副作用要提前说明（2026-10-21 实测校正）：K1 落地后只有 `test/perf-workbuddy.test.js:62`（`PERF_SOURCE_KINDS`）变红；`test/perf-store.test.js` 与 `test/perf-workbuddy.test.js:183` 断言的是 `enabledPerfSourceKinds()`，它按 `PERF_SOURCE_READERS` 过滤，**要等 S1 注册后**才变红。这两个文件都由 S1 一次改完，中间态不要顺手去修。

## 4 卡片

### R1：Claude reader 与合成夹具

**写**：`src/perf-sources/claude.js`、`test/perf-claude.test.js`、`test-support/claude-perf-fixture.mjs`。

1. 按 C-1/C-2 实现单遍 reader：文件顺序扫描；`promptTs`/`promptKind`/`assistantTs` 三个游标；按 `message.id` 聚合 `bestOutput`/`bestInput`/`lastTs`/`stop_reason`/`model`/`effort`/`isSidechain`/`attributionAgent`；扫描结束后统一决定是否产出。
2. `agentKind`：文件路径含 `/subagents/` 或任一行 `isSidechain === true` ⇒ `"subagent"`；否则 `"main"`。`sessionId` 取行上的 `sessionId`（子代理文件继承父会话，缺失为空串）。
3. `status`：该消息任一行 `stop_reason != null` ⇒ `"completed"`，否则 `"unverified"`。
4. `model` 以 `<` 开头（`<synthetic>`）⇒ 整条忽略，不进 `candidates`。
5. 夹具用**字面量数组**构造临时 JSONL，不读真实转录、不含对话正文。至少覆盖：
   - 同一 `message.id` 三行（首行零用量占位）⇒ 1 个样本，output 取最大、duration 取末行 − 锚点；
   - 时间倒退的 attachment 行 ⇒ 锚点不回退；
   - 锚点之后写过 assistant 行的续写 ⇒ 0 个样本、`skippedNoAnchor = 1`（用 6,306 / 9,693 ms 的真实形态：允许 assistant 锚点会得 6,306，退回旧 prompt 会得 9,693，本实现两者都不产出）；
   - 全零消息 ⇒ `skippedZeroUsage`；`<synthetic>` ⇒ 不计候选；
   - 子代理文件 ⇒ `agentKind = "subagent"`、`agent` 带值；
   - 坏 JSON 行 ⇒ `MALFORMED_JSON` 计数；缺 `message.id` ⇒ `UNKEYABLE_RECORD` 计数；
   - 同 `sessionId` 但无 `message.id` 的行不得被并入其他样本（方案 §5.8 回归）。
6. 断言 `candidates === emitted + skippedZeroUsage + skippedNoAnchor`。
7. 不在本卡注册来源、不改 `index.js`；测试直接 import `streamClaudePerfSamples` 与 `normalizePerfSample` 的**组合**只在 K1 落地后加，R1 内保留 raw 断言。

**通过**：`node --test test/perf-claude.test.js` 全绿；不依赖 K1。

**报告**：`output/claude-tps/reports/R1.md`。

### K1：内核语义与排名准入

**写**：`src/perf-stats.js`（C-3 四处）、`test/perf-stats.test.js`（追加 claude 行）、`test/perf-models.test.js`（准入/拒绝用例）。

1. 按 C-3 逐项改；Codex 分支逐字不动。`isPerfRankAdmitted` 的等价性自检：把改动前后对 Codex 四种样本（v1、future、explicit、estimate）的返回值逐条比对，必须完全一致。
2. `test/perf-stats.test.js` 的语义表追加 `["claude", "request", "request_e2e", "reported_output_includes_reasoning", false]`。
3. `test/perf-models.test.js` 增加：claude 合格样本 ⇒ 模型行与分组行 `rank` 非 null；把 `window` 改成 `turn`、`timingSource` 改成 `explicit`、`methodVersion` 改成 `tps-v1`、`methodEstimate` 置真，四种变体分别 ⇒ `rank === null`；Codex 桶与 Claude 桶同时准入时名次连续，排序仍按未舍入均值。
4. 不改 `PERF_SOURCE_WARNING_CODES`（冻结 8 个）、不改 `PERF_METHOD_VERSION`、不改 `summarizePerf` 的聚合逻辑。

**通过**：`node --test test/perf-stats.test.js test/perf-models.test.js` 全绿；`npm.cmd run typecheck` 通过。

**报告**：`output/claude-tps/reports/K1.md`，列出 Codex 等价性比对结果。

### S1：注册、发现与存储接线

**写**：`src/perf-sources/index.js`、`src/usage-core.js`（C-5 一行）、`test/perf-store.test.js`（两处列表）、`test/perf-workbuddy.test.js`（`:62`、`:183` 两个数组）、新增 `test/perf-claude-store.test.js`。

1. 注册（C-4）与发现（C-5）；import 路径与导出名以 R1 的实际文件为准，不自行改名。
2. 更新四处列表断言为六元：`["zcode", "dsh", "opencode", "codex", "workbuddy", "claude"]`——`test/perf-store.test.js:1714-1715`（同一条测试里 `PERF_SOURCE_READERS.keys()` 与 `enabledPerfSourceKinds()` 两个数组）、`test/perf-workbuddy.test.js:62`（`PERF_SOURCE_KINDS`）、`:183`（`enabledPerfSourceKinds()`）。两个函数的顺序都由 `PERF_SOURCE_KINDS` 决定，claude 必须在末尾；`test/perf-store.test.js` 里测试名中的"五类"一并改成"六类"。若开工时发现该文件正被外部改动，这两行由本会话代改。
3. `test/perf-claude-store.test.js`：用**临时目录**里的夹具 JSONL 与**临时 SQLite**（`output/claude-tps/tmp/` 或 `mkdtemp`）验证：
   - 首次 sync 自动回填（`perfFileNeedsExtraction` 无指纹 ⇒ true），样本数 = R1 夹具预期；
   - 重复 sync 幂等，行数不变；
   - 追加一行后 `LIVE_SOURCE_CHANGED` 触发整文件回滚，指纹置 -1；
   - 删除文件后 `perf_samples` 级联为 0；
   - 写入的 `source_path` 等于物理文件路径。
4. **绝不打开 `tools/out` 下任何 `.sqlite`**，含 `readOnly: true`（WAL 会生成 `-wal`/`-shm`）。测试库一律新建。
5. 不改 `usage-store.js`、不改 schema 版本号（当前工作树 18）。

**通过**：`node --test test/perf-store.test.js test/perf-workbuddy.test.js test/perf-claude-store.test.js` 全绿。

**报告**：`output/claude-tps/reports/S1.md`，附隔离库路径与行数。

### U1：界面与文档

**写**：`public/perf-ui.js`、`test/perf-ui.test.js`、`README.md`、`README.en.md`、`docs/10-data-sources.md`、`docs/12-dashboard.md`、`docs/02-tasks.md`、`docs/data-sources/claude-code.md`、修订方案 `:61`。

1. `sourceLabel` 加 `claude: "Claude"`；`test/perf-ui.test.js` 在现有 WorkBuddy 断言旁加两行（zh-CN / en-US）。
2. 按方案 §9 的表格逐行改：不重写历史快照，只加"该结论已由本方案取代"；`docs/02-tasks.md` 是进度来源，改结论时要指向本实施计划。
3. `docs/data-sources/claude-code.md` 必须写清三件容易被误解的事：
   - 只对紧随 prompt/attachment 行的请求计时，**同轮续写不采样**；
   - TPS 分子比事件路径的 output 总和少 0.0137%（597 token）；
   - Claude 已进入统一排名：池化均值可比，p10/p90 仍是请求级分布。
4. 改动前先 `git diff -- <file>`，只插入 Claude 行，不重排既有段落、不跑格式化。README 中英文保持同义。
5. 不碰 `public/app.js`、`public/styles.css`、`public/skin-bootstrap.js`。

**通过**：`node --test test/perf-ui.test.js` 全绿；`git diff --stat` 只涉及上列文件；人工确认没有把 3,263 写成 3,264。

**报告**：`output/claude-tps/reports/U1.md`。

### V1：独立验收（只读 + 报告）

**写**：只写 `output/claude-tps/reports/V1.md` 与临时脚本（`output/claude-tps/tmp/`）。不改产品代码、不改测试。

1. **夹具回放**：对 R1 的合成夹具逐条核对锚点、`durationMs`、`outputTokens`、`agentKind`；断言 `candidates` 恒等式。
2. **真实语料只读扫描**（不进库、不写索引）：样本数应为 3,263 量级（语料在长，只断言结构不变量）：`durationMs > 0`、无样本超过 `PERF_LONG_WINDOW_MS`、`skippedNoAnchor ≥ 0`、`<synthetic>` 无样本、同一 `message.id` 只出现一次。
3. **分子核对**：采样集内 TPS 输出总和 == 同批消息的事件路径输出总和；与全量事件输出的差恰为被跳过的消息（本机 597 token）。
4. **两路 parity**：同一夹具下 memory 报告与隔离 SQLite 的 `sampleKey`/`durationMs`/`outputTokens` 逐条相等。内存路径用 `buildUsageReport({ homeDir: <临时 HOME>, env: {} })` 的 `perfSamples`（`src/usage-core.js:2987`，调用形态参照 `test/claude-pricing.test.js:351`）；SQLite 路径用 S1 的隔离库夹具。不相等就是 S1 的缺陷，不是 V1 的。
5. **排名**：Claude 合格样本有 rank；四种不合格变体无 rank；Codex 样本的 rank 行为与改动前一致。
6. **告警域**：grep 新增代码里没有冻结 8 码之外的 string code；`summarizePerf` 对真实来源不抛 `TypeError`。
7. **边界**：`git status --short` 里除本计划与 R1/S1/U1 的文件外无其他改动；`STORE_SCHEMA_VERSION`、`PERF_METHOD_VERSION` 未变。
8. 定向矩阵：`node --test test/perf-claude.test.js test/perf-claude-store.test.js test/perf-stats.test.js test/perf-models.test.js test/perf-store.test.js test/perf-workbuddy.test.js test/perf-ui.test.js`，再跑 `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run format:check`。

**通过**：以上 1–8 全满足；任何一项失败，V1 只交复现和最小证据，不改代码。

**报告**：`output/claude-tps/reports/V1.md`，逐项写命令、exit、数字。

## 5 启动提示（本会话复制给 subagent）

> **公共前缀**：工作目录 `E:/12 AI/ccusage/codex-usage`。先读 `docs/plans/2026-10-21-claude-code-tps-plan.md` 与 `docs/plans/2026-10-21-claude-code-tps-implementation-plan.md`。只写本卡列出的文件；其他文件即使看到问题也不改，写进报告。不 commit、不 push、不跑全量 `npm test`、不打开 `tools/out` 下任何 sqlite。Windows 用 `npm.cmd`。完成后把报告写到指定路径，最终回复列出：改动文件 + 行为、命令/exit/通过数、剩余阻塞。

- **R1**：按实施计划 §4 R1 执行。你独占 `src/perf-sources/claude.js`、`test/perf-claude.test.js`、`test-support/claude-perf-fixture.mjs`；不要注册到 `index.js`，不要改 `perf-stats.js`。测试只断言 raw 候选，不依赖 K1。
- **K1**：开工前先 `git diff -- src/perf-stats.js test/perf-stats.test.js test/perf-models.test.js`，在现有改动之上做加法。按 §1 C-3 改四处并补两个测试文件；Codex 分支必须逐字不变，交等价性比对。
- **S1**：开工前确认 R1 的 `claude.js` 已存在、K1 已落地；先 `git diff` 看清 `usage-core.js` 与三个测试文件的现状，只做加法。按 §4 S1 执行；注册表与发现各一处，列表断言四处；隔离库测试不得碰 `tools/out`。
- **U1**：按 §4 U1 执行。只插入 Claude 相关句子；改前先看 `git diff`；不重排、不格式化。
- **V1**：只读验收。按 §4 V1 的 1–8 逐项跑，失败只交复现，不改代码。

## 6 门禁

| 门 | 何时 | 判据 |
| --- | --- | --- |
| G0 | 派发前 | 契约冻结；共享文件现状已记录（`git diff --stat` + 哈希，无需入库），确认三张首批卡的文件不相交 |
| G1 | R1 完成 | `test/perf-claude.test.js` 全绿；夹具覆盖 §4 R1 第 5 条的七类 |
| G2 | K1 完成 | `perf-stats`/`perf-models` 全绿；Codex 准入等价性比对通过；typecheck 通过 |
| G3 | S1 完成 | 注册/发现/存储三组测试全绿；列表钉住更新；隔离库四项行为通过 |
| G4 | U1 完成 | UI 标签测试通过；文档无 3,264 残留；diff 仅涉及上列文件 |
| G5 | V1 完成 | §4 V1 的 1–8 全过；本会话再跑一次全量 `npm.cmd test` 与三项工程门禁 |
| G6 | 收口 | 本会话看 `git diff`，按用户要求决定是否暂存/提交；worker 不参与 |

## 7 失败与回退

- **R1 tests 红**：先在合成夹具上定位，不改真实转录；读数不符时报告"哪条不变量破了"，不调数字迁就。
- **K1 让既有 Codex 测试变红**：立即停手，报告具体断言；不允许改 Codex 期望值来"修绿"。
- **S1 parity 破裂**：先查 `perfPhysicalFilesForHome` 分支是否真的命中 `home.kind === "claude"`（方案 §6.4 第 4 条），再查 `source_path` 是否等于物理路径；不要用"内存路径少几条也无所谓"收口。
- **V1 失败**：删 `src/perf-sources/index.js` 的 claude 注册行即可让来源整体停车（内核改动保留、无副作用）；由本会话决定是修还是停。
- **看到别人的红灯**：定向测试若失败在一个你没改过的文件上，先 `git diff -- <file>` 判断是不是其他卡片的中间态；是就写进报告、继续自己的卡，**不修别人的代码**。共享工作区里这是常态，不是偶发。
- **所有卡**：发现需要改共享契约（字段名、签名、码域）时，停止并报告，由本会话在 §1 一处裁定；不自行发明同义字段。

## 8 与工作区既有改动的关系

1. 共享文件里的未提交改动（`perf-stats.js` 的 tps-v2 语义、`usage-core.js` 的目标投影、列表钉住等）是**本计划的地基**，不是待办交接项。没有"释放"这一步，开工条件只有 §3 的代码依赖。
2. Claude 与 Codex 的样本都取当前 `PERF_METHOD_VERSION`（工作区现为 `tps-v2`，reader 不传该字段）；两者的区分靠 `sourceKind` 与准入元组，不靠版本号。历史上以 `tps-v1` 落库的 Codex 行不参与排名，但不会告警。将来抬版本号时须同轮复核 `claude` 准入分支。
3. 本计划**不参与** Codex v2 的正式切换，也不复用它的开关；Claude 的停车开关只有 `index.js` 那一行注册。
4. 若同一文件确实有另一条线在同步编辑，按 §2 的硬规则走：停手、报告、本会话裁定，不并行写。

## 9 交付与状态回填

- 每个 agent 的报告在 `output/claude-tps/reports/`，不提交。
- 2026-10-21 全量 `npm.cmd test`（G5）：2,816 tests / 2,795 pass / **0 fail** / 20 skipped / 1 cancelled，197 s。唯一 cancelled 的是 `test/skin-palette-review-production-isolated.integration.test.js:152`（E1 clean-source）：它把 `docs/validation` 与 `lineart assets` 复制成生产沙箱，本机这两份素材都在（记忆中的 18 GB 级证据目录），无超时会一直跑到几小时；CI/发布归档里缺 `lineart assets`，该用例走 `t.skip`。**与 Claude TPS 无关，也不由本批引入**——首次全量用 `--test-timeout=0` 跑了两小时十六分，就是卡在它；加 120 s 逐测试超时后它被取消、其余全部完成。`test/w1-executor.test.js` 单跑 14/14、11 s，全量里也全绿。
- 2026-10-21 额外改动：`biome.json` 的 `files.includes` 与 `formatter.includes` 各加一行 `test-support/claude-perf-fixture.mjs`——新夹具必须进 lint/format 门禁，否则不参与检查。`npm.cmd run format:check` 目前有 11 处红，全部来自另一条线的未提交文件（`usage-store.js`、`codex-request-timing.js` 等），与本计划无关。
- 本会话在 G5 后把最终结论回填到本稿 §10（占位见下）与 `docs/plans/2026-10-21-claude-code-tps-plan.md` 的状态行；`docs/02-tasks.md` 的进度由 U1 在 C3 里更新。
- 只有用户明确要求时才 commit；提交前看 `git diff --cached`，确认业务文件与受测快照一致。

## 10 执行状态（本会话回填）

| 卡 | 状态 | 报告 | 备注 |
| --- | --- | --- | --- |
| R1 | 完成（2026-10-21，G1 通过） | `output/claude-tps/reports/R1.md` | 9/9；真实语料 3,710 候选 → 3,708 样本，恒等式成立 |
| K1 | 完成（2026-10-21，G2 通过） | `output/claude-tps/reports/K1.md` | 70/70；Codex 准入等价；typecheck 通过 |
| S1 | 完成（2026-10-21，G3 通过） | `output/claude-tps/reports/S1.md` | 89/89；隔离库 2 行，parity smoke 一致 |
| U1 | 完成（2026-10-21，G4 通过） | `output/claude-tps/reports/U1.md` | 24/24；无 3,264 残留 |
| V1 | 完成（2026-10-21） | `output/claude-tps/reports/V1.md` | 8/8 通过；真实语料 3,865 候选 → 3,860 样本，分子差 1,248 = 651 + 597 |
