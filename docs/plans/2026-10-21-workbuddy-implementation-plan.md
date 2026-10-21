# WorkBuddy 接入：实施计划（并行执行版）

更新：2026-10-21。状态：**已实施（W1 / C1–C3 / S1–S4 / P1–P3 / U1 / V1–V3 全部完成），本机真实来源已验收**。验收记录见 [WorkBuddy 验收](../validation/2026-10-21-workbuddy-implementation/README.md)，字段映射见[数据源专题](../data-sources/workbuddy.md)。

产品与数据依据是[WorkBuddy 数据源接入计划](2026-10-21-workbuddy-source-plan.md)（下称"评估稿"），其中三条裁决已由用户拍定：

1. Auto（`model=default-model`）事件整体排除；
2. duration 用 side table；
3. trace 扫描只在会话文件变化时触发，分母不含 Auto。

本稿只回答三件事：**拆成哪些卡、谁能和谁同时跑、每张卡怎么算通过**。数据事实不再重复论证，只写施工需要的那部分。

## 0 本稿对评估稿的七处修正

并行施工的前提是契约稳定。核对现有代码后，评估稿 §5.4 有七处写法会在落地时直接触发失败或无效，先在这里改掉，执行者按本稿执行，**不要照抄评估稿的字段值**。

| # | 评估稿写法 | 实际约束（已核对源码） | 本稿改为 |
| --- | --- | --- | --- |
| 1 | `timingSource = workbuddy.trace.generation` | `PERF_TIMING_SOURCES` 只接受 `explicit`/`timestamp_fallback`/`mixed`/`unknown`，其它值告警并降为 `unknown`（`src/perf-stats.js:122,859-865`） | `explicit`（时长是 span 直接观测值，不是时间戳相减） |
| 2 | `methodVersion = workbuddy.generation.v1` | `PERF_METHOD_VERSION = "tps-v1"`，传其它值会产生版本不匹配诊断（`src/perf-stats.js:17,866-868`） | **留空**，取默认 `tps-v1`；采集方法版本写进 duration 表的 `capture_version` 列 |
| 3 | `tokenScope = output` | 该字段由 `PERF_SOURCE_SEMANTICS` 按 kind 决定，reader 传值会被覆盖并告警（`src/perf-stats.js:99-107,833-839`） | 在语义表新增 `workbuddy: { window:"request", timingKind:"request_e2e", tokenScope:"reported_output_includes_reasoning" }` |
| 4 | "从会话文件产出样本，duration 查表" | reader 拿不到 DB，也拿不到 home：调用点把 `source.path` 覆盖成 `filePath`（`src/usage-store.js:3053-3055`） | store 注入 `lookupGenerationDuration(messageId)` 回调（与 `previousCumulativeForSession` 同模式），`index.js` 白名单透传 |
| 5 | "指纹持久化到 meta，启动后第一轮强制扫" | 落 meta 要新增序列化路径，且 trace 文件会随 PID 目录增删 | 改为**进程内 `Map`**：跨轮保留、进程重启自然清空 ⇒ 首轮自动全扫，零 schema 成本 |
| 6 | "扫描按 (size,mtime) 指纹跳过" | 未指定指纹存哪 | 指纹只存进程内 `Map<path,{size,mtimeMs}>`；**不建 trace 指纹表** |
| 7 | "覆盖率如实显示" | `PERF_SOURCE_WARNING_CODES` 是冻结码域（`src/perf-stats.js:1804-1815`），不能加 `MISSING_DURATION` | 缺 duration 的计数走 store 的普通 warning 字符串（`onWarning` 通道），每 home 每轮一条；不改码域、不加 API 字段 |

另有一条实现顺序约束：**trace 预扫必须落在 `replaceFile` 之外**。`src/usage-store.js:2933` 已注明那是唯一跨 `await` 的写事务，在事务内做文件 I/O 会把读路径钉在快照上（也正是 WAL 诊断里的那个根因）。

## 1 冻结契约

以下内容在开工前定死。任何执行者发现"必须改契约"，停下来交主审，**不得自行放宽**。

### 1.1 字面量

| 项 | 值 |
| --- | --- |
| `source.kind` | `"workbuddy"` |
| `classifyImportDirectory().type` | `"workbuddy-home"` |
| `channel` | `"WorkBuddy"` |
| home label | `"Main WorkBuddy"` / `"WorkBuddy <basename>"` |
| `source.id` | `sourceId("workbuddy", resolvedPath)` |
| perf `sourceKind` | `"workbuddy"` |
| `sampleKey` | `JSON.stringify(["workbuddy", homeId, messageId])` |
| 环境变量 | `CODEX_USAGE_WORKBUDDY_HOMES`（路径分隔符分隔）、`CODEX_USAGE_WORKBUDDY=0` 关闭 |
| `capture_version` | `"workbuddy.trace.v1"` |
| schema | `STORE_SCHEMA_VERSION` 16 → **17** |

### 1.2 `src/workbuddy-usage.js`（新文件）导出

```js
export const WORKBUDDY_KIND = "workbuddy";
export const WORKBUDDY_CHANNEL = "WorkBuddy";

export async function workbuddyHomeLooksUsable(homePath): Promise<boolean>;
export async function workbuddySessionFiles(homePath): Promise<string[]>;
export async function streamWorkbuddySessionEvents(filePath, source, onEvent, options): Promise<void>;
export async function workbuddyGenerationSpans(homePath, options): Promise<Array<{messageId, durationMs, endedAtMs}>>;
```

`workbuddyHomeLooksUsable`：`<home>/projects/` 存在，且**最多 3 个** `projects/*/*.jsonl` 的前 64 KiB 中出现 `"type":"session-meta"` 或 `"type":"function_call"`。纯目录结构判断不够——`.workbuddy-ai` 同时满足 `claudeHomeLooksUsable`（`projects/*.jsonl`）和 `codexHomeLooksUsable`（`sessions/`），必须靠内容区分。

`workbuddySessionFiles`：`projects/**/*.jsonl`，**显式跳过** `<sessionId>/tool-results/**`（外部化的大工具输出，可达数十 MB）。

`workbuddyGenerationSpans`：扫 `<home>/traces/*/trace_*.jsonl`，只取 `row.type === "span_end" && row.span.type === "generation" && row.span.status === "ok"`；解析 `row.span.toolOutput`（JSON 字符串）取 `[0].id` 与 `row.span.duration`、`row.span.endedAt`。已实测 15 个文件、170 个 span、169 个 `ok`，`toolOutput` 全部可解析。

### 1.3 事件对象（`onEvent` 回调）

沿用 Claude 的事件形状（`src/claude-code-usage.js:309` 附近），**额外携带 `messageId`**：

```js
{
  timestampMs, sessionId, homeId, homeLabel, channel: "WorkBuddy",
  project, model, messageId,
  usage: { total, input, cached, output, reasoning },
  detailMask, reconciliationGap: 0, cacheWriteTokens, cacheWriteKnown,
  requestInputTokens, contextLevel, serviceTier, priceVersion
}
```

`messageId` 只供 perf reader 使用：`insertEvent` 不读它，`parseSessionFileForIndex` 的投影也不带它，因此**不会进库、不会进 API**。这是让 reader 复用同一套解析、避免二次读文件的关键，不是随手加的字段。

口径映射（已实测）：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `input` | `providerData.usage.inputTokens` | **已含缓存**，不能再加 `cache_read` |
| `cached` | `inputTokensDetails[0].cached_tokens` | `input >= cached` 恒成立 |
| `output` | `usage.outputTokens` | 含 reasoning |
| `reasoning` | `outputTokensDetails[0].reasoning_tokens` | |
| `total` | `usage.totalTokens` | 实测 `== input + output` |
| `model` | `providerData.model` | 线路模型；Auto 已排除 |
| `detailMask` | 四位齐全 ⇒ `15` | bit1 input / bit2 cached / bit4 output / bit8 reasoning |
| `requestInputTokens` | `usage.input` | 与 Claude 相反，这里 input 本身就是请求侧总量 |
| `cacheWriteTokens` | `rawUsage.cache_creation_input_tokens` | 本机恒 0 |

三份冗余（`providerData.usage` / `providerData.rawUsage` / `message.usage`）**只取第一份**，不做交叉校验、不累加。

### 1.4 perf reader 签名

```js
// src/perf-sources/workbuddy.js
export async function streamWorkbuddyPerfSamples(filePath, source, onSample, options);
// options.lookupGenerationDuration(messageId) -> { durationMs, endedAtMs } | null
```

候选形状：

```js
{
  sourceKind: "workbuddy",
  homeId: source.id,
  messageId,                    // 身份
  tsMs: event.timestampMs,
  outputTokens: event.usage.output,
  inputTokens: event.usage.input,
  durationMs,                   // 查表得来，不是自己算
  status: "completed",
  timingSource: "explicit",
  agentKind: "main"
}
```

返回值：`{ state: "enabled", stats: { candidates, skippedNoDuration, malformedLines } }`。`stats` 只用于测试与 warning，不参与统计。

### 1.5 duration 表（v17 唯一新增）

```sql
CREATE TABLE IF NOT EXISTS workbuddy_generation_durations (
  message_id TEXT PRIMARY KEY,
  duration_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  capture_version TEXT NOT NULL,
  captured_at TEXT NOT NULL
);
```

- 写入：`INSERT OR IGNORE`（幂等、先到先得；同 id 多 span 只留第一条）。
- 读取：`SELECT duration_ms, ended_at_ms WHERE message_id = ?`，`replaceFile` 内按调用建局部 `Map` 缓存，跨调用不复用。
- 不建 trace 指纹表，不做 `home_id` 列：ULID 全局唯一，重复导入同一份数据的副本时先到先得（写入已知限制）。
- 不主动清理。10 万条约 10 MB；若将来要回收，另开 CLI，不在本稿。

### 1.6 精确改动点

| 文件 | 位置 | 改什么 |
| --- | --- | --- |
| `src/usage-core.js` | `333` `classifyImportDirectory` | 在 `claudeHomeLooksUsable`（`:361`）**之前**插入 workbuddy 判定 |
| `src/usage-core.js` | `585` `discoverClaudeHomes` 之后 | 新增 `discoverWorkbuddyHomes`，并在 `discoverUsageSources` 里 push |
| `src/usage-core.js` | `727` | 新增 `classified.type === "workbuddy-home"` 分支，push `kind:"workbuddy"` 的 source |
| `src/usage-core.js` | `814-880` `buildUsageFingerprint` | 新增 `home.kind === "workbuddy"` 分支 |
| `src/usage-core.js` | `1756-1778` `streamUsageFileEvents` | 新增 workbuddy 分派 |
| `src/usage-core.js` | `3043` 内存路径 | 新增 workbuddy 分支 + `parseWorkbuddyForIndex` 私有函数 |
| `src/server.js` | `196-214` `describeImportEntry` | label 加 `WorkBuddy <name>` |
| `src/usage-store.js` | `2803` `usageFiles` | 新增 `home.kind === "workbuddy"` 分支 |
| `src/usage-store.js` | `2155-2214` 迁移段 | 新增 `version === 16` → 17；`version === 0` 分支同步建表 |
| `src/usage-store.js` | `3811-3858` 跳过判定 | 最小重构，把 `continue` 改成 `needsRefresh` 标志 |
| `src/usage-store.js` | `3023-3067` perf 段 | 注入 `lookupGenerationDuration` |
| `src/usage-store.js` | `4471` `harnessModels` | 加 `WorkBuddy` 桶与前缀判断 |
| `src/perf-stats.js` | `99-111,301,523` | 语义表、kind 列表、canonical、sampleKey |
| `src/perf-sources/index.js` | `45,129-171` | 注册 reader、透传 `lookupGenerationDuration` |
| `public/app.js` | `2821,2824` | `HARNESS_ORDER`、`bucketForChannel` |
| `public/perf-ui.js` | `78` | 来源标签加 `workbuddy` |
| `public/timeline-utils.js` | `4-29` `sourceGroup` | `homeKind === "workbuddy"` → `"WorkBuddy"` |
| `public/i18n.js` | `333,375,675` | 目录提示文案加 WorkBuddy |

## 2 文件所有权与并行波次

### 2.1 所有权矩阵（一人一文件，禁止交叉写）

| 角色 | 独占写入 | 可读 |
| --- | --- | --- |
| **W** 适配器 | `src/workbuddy-usage.js`（新）、`test/workbuddy-usage.test.js`（新） | 全部 |
| **C** 接线 | `src/usage-core.js`、`src/server.js`、`test/workbuddy-core.test.js`（新）、追加 `test/usage-core.test.js`、`test/server.test.js` | 全部 |
| **S** 索引 | `src/usage-store.js`、`test/workbuddy-store.test.js`（新）、追加 `test/perf-store.test.js` | 全部 |
| **P** TPS | `src/perf-sources/workbuddy.js`（新）、`src/perf-sources/index.js`、`src/perf-stats.js`、`test/perf-workbuddy.test.js`（新） | 全部 |
| **U** 界面 | `public/app.js`、`public/perf-ui.js`、`public/i18n.js`、`public/timeline-utils.js`、追加 `test/app-render.test.js`、`test/i18n.test.js`、`test/perf-ui.test.js` | 全部 |
| **V** 验收 | `docs/validation/2026-10-21-workbuddy-implementation/**`、`docs/**`、`README.md` | 全部 |

`src/usage-types.js` 不需要改：`sourceKind` 已是 `string`，`PerfSourceKind` 没有字面量联合。

### 2.2 三波

```text
波 1（并行，互不阻塞）
  W  适配器全量实现          ← 关键路径，最厚
  C  接线（按 §1.2 签名写，W 未落地时测试红属预期）
  U  界面（用字面量数据，完全不依赖后端）

波 2（等 W 合并后并行）
  S  索引 + 迁移 + 预扫注入
  P  perf-stats + reader + 注册

波 3（串行）
  V1 三路一致 → V2 真机 → V3 门禁与文档
```

波 1 里 C 会短时间红：它 import 的符号在 W 落地前不存在。**允许**。C 的完成判据是"W 落地后测试一次转绿"，不是"从第一分钟就绿"。

### 2.3 冲突处置

- 同一文件被两个角色需要改 ⇒ **停下来交主审**，由主审决定归属，不允许"顺手改一行"。
- 发现契约必须变 ⇒ 主审改本稿 §1，再通知受影响角色；口头约定无效。
- 波 2 的 S 与 P 有接口耦合（表名、回调名），但**都在 §1 里写死了**，实现时按字面量对齐，不需要互相等。

## 3 W 模块：适配器（1 卡）

### W1 — `src/workbuddy-usage.js`

依赖：无。写入：`src/workbuddy-usage.js`、`test/workbuddy-usage.test.js`。

动作：

1. 行解析：逐行 `JSON.parse`，单行失败计数并继续（截断行、`file-history-snapshot` 大行都不能中断整文件）。
2. 只认 `providerData.usage && providerData.messageId` 的记录，其余类型（`session-meta` / `function_call_result` / `reasoning` / `ai-title` / `file-history-snapshot`）直接跳过。
3. **Auto 排除**：`providerData.model === "default-model"` 或 `String(providerData.requestModelName).toLowerCase() === "auto"`，任一成立即 `continue`。
4. **同 id 只产一次**：文件内用 `Set` 记已见 `messageId`，重复则丢弃后者。结构上用量只挂一条记录，`Set` 是防御，不是主路径。
5. 口径按 §1.3 映射；`project` 取 `row.cwd`，缺失用 `"Unknown cwd"`；`sessionId` 取 `row.sessionId`，缺失用文件名去扩展名。
6. 会话名：不参与事件，但 `workbuddySessionFiles` 的排序需稳定（按路径 code-unit）。
7. `workbuddyGenerationSpans` 按 §1.2 实现，只收 `status === "ok"`；`toolOutput` 解析失败计入 `malformedLines` 并跳过该 span。

必测（夹具手写，不调用被测函数生成期望）：

- 5 条 `function_call` 同 `messageId`、仅 1 条带 usage ⇒ **1 个事件**。
- Auto 记录（`default-model` / `requestModelName:"Auto"`）⇒ **0 个事件**；同一文件里的非 Auto 记录不受影响。
- `input >= cached`，且 `total === input + output`；三份 usage 同值时结果只取一份（改第二份的值不应改变输出）。
- `reasoning_tokens` 缺失 ⇒ `detailMask` 去掉 bit8，不是 `15`。
- `file-history-snapshot` 里若带 `providerData.usage`（构造）⇒ 仍不产事件（类型白名单优先）。
- 半行 JSON（末尾截断）⇒ 不抛异常，前面的行照常产出。
- `cwd` 缺失 ⇒ `project === "Unknown cwd"`。
- 空文件、只有 `session-meta` 的文件 ⇒ 0 事件、无异常。
- `workbuddyHomeLooksUsable`：真 WorkBuddy 夹具 true；纯 Claude 结构（`projects/*.jsonl` 无 `session-meta`）false；空目录 false。
- `workbuddySessionFiles`：不返回 `tool-results/**`。

通过条件：上述逐条断言；`node --test test/workbuddy-usage.test.js` 全绿；文件不含任何 DB、网络或时间依赖。

## 4 C 模块：接线（3 卡，同一执行者串行）

### C1 — 分类与发现

依赖：无（按 §1.2 签名写）。写入：`src/usage-core.js`、`src/server.js`。

动作：

1. `classifyImportDirectory`：在 `claudeHomeLooksUsable`（`:361`）**之前**插入 `if (await workbuddyHomeLooksUsable(resolved)) return { type: "workbuddy-home", path: resolved };`。
   - 位置不可挪到 Claude 之后：`.workbuddy-ai/projects/*.jsonl` 会被 Claude 判据命中。
   - 也不能挪到 Codex 之前的最前面：ZCode/DSH/OpenCode 判据更具体，保持现有顺序。
2. `discoverWorkbuddyHomes`：仿 `discoverClaudeHomes`（`:585`），`addHome` 内做 `seen` 去重 + `workbuddyHomeLooksUsable`；默认 `path.join(homeDir, ".workbuddy-ai")`；`CODEX_USAGE_WORKBUDDY === "0"` 直接返回空；`CODEX_USAGE_WORKBUDDY_HOMES` 追加。
3. `discoverUsageSources`：在 Claude 之后 push；沿用 `seenPaths` 去重。
4. `:727` 的 importDirs 分支：新增 `workbuddy-home` ⇒ `{ id: sourceId("workbuddy", path), label: \`WorkBuddy ${basename}\`, path, kind: "workbuddy", imported: true }`。
5. `src/server.js:208`：`describeImportEntry` 的 label 链加 `workbuddy-home → \`WorkBuddy ${name}\``。
6. `classifyImportDirectory` 末尾的 `reason` 文案加 WorkBuddy（`:396`）。

必测：

- 真 WorkBuddy 夹具 ⇒ `workbuddy-home`；同夹具若删掉 `session-meta`/`function_call` 行 ⇒ 不再是 `workbuddy-home`（不得回退成 `claude-home` 之外的行为断言，只断言"不是 workbuddy"）。
- 纯 Claude home ⇒ 仍 `claude-home`（**回归**：证明没抢走 Claude）。
- 纯 Codex home ⇒ 仍 `codex-home`。
- `CODEX_USAGE_WORKBUDDY=0` ⇒ 发现结果里没有 workbuddy。
- 自定义 home 路径（非 `.workbuddy-ai` 名字）⇒ 仍被发现（证明判据不是看目录名）。
- `/api/imports` 描述条目 label 为 `WorkBuddy <name>`。

通过条件：`node --test test/workbuddy-core.test.js test/usage-core.test.js test/server.test.js` 全绿；分类顺序与现有四个来源的相对次序未变。

### C2 — 指纹与内存路径

依赖：C1。写入：`src/usage-core.js`。

动作：

1. `buildUsageFingerprint`（`:814-880`）：新增 `home.kind === "workbuddy"` 分支，`workbuddySessionFiles(home.path)` + 逐文件 `addFile`；目录读失败写 `!discover-failed:<code>`（与 DSH/Claude 同格式）。
2. 内存路径（`:3043` 附近）：新增 workbuddy 分支，新增私有 `parseWorkbuddyForIndex`，仿 `parseClaudeForIndex`——包一层 `streamWorkbuddySessionEvents`，把事件投影成紧凑字段（与 `parseSessionFileForIndex` 同形）。
3. 两处都要**独立文件级 try/catch**：单文件失败写 warning 继续，不中断整个 home。

必测：

- 同一夹具，指纹在文件追加 1 字节后变化、在 `touch` 不改内容时也变化（沿用现有指纹语义，不新增规则）。
- 内存路径的事件数与 store 路径一致（本卡只测"内存路径能产出"，逐项一致留给 V1）。
- 单文件损坏 ⇒ 其它文件仍被解析，warning 含该路径。

通过条件：`node --test test/workbuddy-core.test.js test/usage-core.test.js` 全绿；不改变 Claude/DSH/OpenCode 分支的既有断言。

### C3 — 分派

依赖：C2。写入：`src/usage-core.js`。

动作：

1. `streamUsageFileEvents`（`:1756`）在 `claude` 分支旁新增 `if (source.kind === "workbuddy") { await streamWorkbuddySessionEvents(filePath, source, onEvent, options); return; }`。
2. 保持 `project-log` 在首位、Codex 兜底在末尾的相对顺序不变。

必测：workbuddy source ⇒ 调用 workbuddy 解析器（用 spy 或产出特征断言）；未知 kind 仍落到 Codex 兜底。

通过条件：`node --test test/workbuddy-core.test.js` 全绿。

## 5 S 模块：索引（4 卡，同一执行者串行）

### S1 — 文件展开

依赖：W1。写入：`src/usage-store.js`。

动作：`usageFiles`（`:2803`）在 `claude` 分支旁新增：

```js
if (home.kind === "workbuddy") {
  for (const filePath of await workbuddySessionFiles(home.path)) {
    files.push({ filePath, source: home, info: await stat(filePath) });
  }
  continue;
}
```

用 `stat` 而不是自定义 stat：会话文件是普通 jsonl，没有 `-wal`；perf 指纹另由 `enabledPerfSourceStat` 统一处理。

必测：一个 home 多个 `projects/<slug>/*.jsonl` ⇒ 全部进入 files；`tool-results/*.txt` 不进入；目录不可读 ⇒ 进 `failedHomes` 且不抛。

通过条件：`node --test test/workbuddy-store.test.js test/perf-store.test.js` 全绿。

### S2 — 迁移 v17

依赖：S1。写入：`src/usage-store.js`。

动作：

1. `STORE_SCHEMA_VERSION` 改 17。
2. 在 `version === 15` 段之后加 `if (version === 16) { migrate(WORKBUDDY_DURATION_DDL, 17, () => assertWorkbuddyDurationSchema(this.database)); version = 17; }`。
3. `version === 0` 分支同步 `exec(WORKBUDDY_DURATION_DDL)` + assert（结构上与迁移不可互相覆盖，沿用现有约定）。
4. **不标脏任何既有文件**：新来源没有旧行，回填由首次 sync 自然触发。
5. 落点用**字面量** 17，不用常量（现有约定：用常量会让后续抬版本静默跳过）。
6. `assertWorkbuddyDurationSchema` 校验：表存在、5 个列名与类型、`message_id` 是主键。

必测：

- v16 真库副本打开后 `user_version === 17` 且表存在。
- 重复打开幂等。
- 迁移中途失败（构造：先占名建同名列缺失的表）⇒ 回滚，`user_version` 仍 16。
- 全新库直接 17。

通过条件：`node --test test/workbuddy-store.test.js test/perf-store.test.js` 全绿；既有索引副本升级后事件数不变。

### S3 — harness 桶与元数据

依赖：S1。写入：`src/usage-store.js`。

动作：

1. `harnessModels`（`:4471`）加 `WorkBuddy: new Set()`。
2. 分桶链加 `channel.startsWith("workbuddy") ? "WorkBuddy"`，放在默认 `Codex` **之前**。
3. `metadata()` 输出加 `WorkBuddy: [...].sort(...)`。
4. 前端 `HARNESS_ORDER`（U1）与此处必须同名同序，跨角色靠 §1.1 字面量对齐。

必测：channel `WorkBuddy` 的模型进 `WorkBuddy` 桶、不进 `Codex`；空桶输出 `[]` 而不是缺键。

通过条件：`node --test test/workbuddy-store.test.js` 全绿。

### S4 — trace 预扫与 duration 注入（本稿最重的一卡）

依赖：W1、S2。写入：`src/usage-store.js`。

动作：

1. **控制流最小重构**（`:3811-3858`）：把"跳过"从 `continue` 改为标志，保持 `perfFileNeedsRefresh` 的调用位置、次数、参数完全不变：

```js
let needsRefresh = true;
if (!earlierFileChanged && existing && /* 原五个条件 */) {
  // 原 changedKind / windowedCurrent / reusedCurrent 三行原样保留
  needsRefresh = perfFileNeedsRefresh(...);
}
if (!needsRefresh) continue;
if (canonicalizeKind(file.source.kind) === "workbuddy" && !workbuddyRefreshedHomes.has(String(file.source.id))) {
  workbuddyRefreshedHomes.add(String(file.source.id));
  await this.refreshWorkbuddyDurations(file.source.path, { onWarning });
}
try { /* 原 replaceFile 调用 */ }
```

2. `refreshWorkbuddyDurations(homePath, { onWarning })`：
   - 列 `traces/*/trace_*.jsonl`；目录不存在 ⇒ 直接返回（正常状态，不告警）。
   - 逐文件 `stat`，与 `this.workbuddyTraceFingerprints`（**实例级 Map，构造时初始化、`sync()` 不清空**）比较；相同则跳过。
   - 变化文件**先读完并解析到内存数组**，再开 `BEGIN IMMEDIATE` 批量 `INSERT OR IGNORE`，`COMMIT`。文件 I/O 一律在事务外。
   - 写成功后才更新指纹；解析失败的文件不更新指纹（下轮重试），记一条 warning。
   - 单文件失败不影响其它文件。

3. duration 查询注入（`:3052` 之前）：

```js
const durationStatement = database.prepare(
  "SELECT duration_ms, ended_at_ms FROM workbuddy_generation_durations WHERE message_id = ?",
);
const durationCache = new Map();  // 每次 replaceFile 新建，不跨调用
const lookupGenerationDuration = (messageId) => { /* 空串返回 null；命中缓存直接返回；否则查表并缓存 */ };
```

4. 传给 reader：`streamPerfSamplesForFile(filePath, { ...source, path: filePath }, onSample, { onWarning, lookupGenerationDuration })`。
5. `skippedNoDuration > 0` 时，每 home 每轮追加一条普通 warning：`WorkBuddy <label>：N 个响应缺少 generation 时长`。走既有 `onWarning` 字符串通道，**不新增码域**（§0 第 7 条）。

必测：

- 会话文件变化 ⇒ 触发一次预扫；同一轮第二个 WorkBuddy 文件**不再触发**（`workbuddyRefreshedHomes` 生效）。
- 会话文件未变化 ⇒ 不触发（用 spy 断言 `refreshWorkbuddyDurations` 调用次数 0）。
- trace 未变化 ⇒ 第二次触发不重解析（断言解析函数调用次数）。
- 30 天场景：删掉全部 trace 后重解析会话文件 ⇒ 样本数**不变**（duration 从表里来）。
- 重解析幂等：连续两次全量重解析，`perf_samples` 行数与值不变。
- 非 `ok` 状态 span ⇒ 不写表。
- `toolOutput` 损坏 ⇒ 该 span 跳过，其它 span 正常入库。
- `duration <= 0` 或非整数 ⇒ 不写表（不制造 `DURATION_NONPOSITIVE` 样本）。
- 预扫失败（目录不可读）⇒ 本轮 sync 不失败，只加 warning。

通过条件：`node --test test/workbuddy-store.test.js test/perf-store.test.js test/perf-stats.test.js` 全绿；**既有 perf 回归一条不改**（控制流重构必须行为等价）。

## 6 P 模块：TPS（3 卡，同一执行者串行）

### P1 — `perf-stats` 语义

依赖：无。写入：`src/perf-stats.js`。

动作：

1. `PERF_SOURCE_SEMANTICS` 加 `workbuddy`（值见 §0 第 3 条）。
2. `PERF_SOURCE_KINDS` **追加到末尾**：`["zcode","dsh","opencode","codex","workbuddy"]`。顺序决定 `enabledPerfSourceKinds()` 的输出顺序，插中间会让既有快照类断言变红。
3. `canonicalPerfSourceKind`：`if (value === "workbuddy") return value;`。
4. `resolvePerfSampleKey`：`if (sourceKind === "workbuddy") return perfSampleKey(sourceKind, raw.homeId, raw.messageId);`。

必测：`canonicalPerfSourceKind("workbuddy")`；`normalizePerfSample` 对最小候选产出 `window:"request"`、`timingKind:"request_e2e"`、`tokenScope:"reported_output_includes_reasoning"`、`methodVersion:"tps-v1"`；传自定义 `timingSource`/`methodVersion` 时按既有规则告警，不被 WorkBuddy 特判绕过；`sampleKey` 三元组形状。

通过条件：`node --test test/perf-stats.test.js test/perf-summary.test.js test/perf-models.test.js` 全绿；无既有 kind 的语义被改动。

### P2 — reader

依赖：W1（事件带 `messageId`）。写入：`src/perf-sources/workbuddy.js`、`test/perf-workbuddy.test.js`。

动作：

1. 复用 `streamWorkbuddySessionEvents` 拿事件，**不重新解析文件**。
2. 每个事件：`lookupGenerationDuration(event.messageId)`；`null` ⇒ `skippedNoDuration += 1` 并跳过（**不造 0 时长样本**）。
3. 按 §1.4 产出候选；`tsMs` 取事件时间；`agentKind` 恒 `main`（`providerData.agent` 若将来区分，另开卡）。
4. 返回 `{ state: "enabled", stats: {...} }`。

必测：

- 事件有 duration ⇒ 样本 `sampleKey` 为 `["workbuddy",homeId,messageId]`，`outputTokens`/`durationMs` 与夹具一致。
- 事件无 duration ⇒ 不产样本，`skippedNoDuration` 加 1。
- `lookupGenerationDuration` 未提供（undefined）⇒ 不抛异常，全部跳过并计数。
- 同一 messageId 出现两次 ⇒ 只产 1 个样本（reader 侧不重复）。
- `outputTokens === 0` ⇒ 仍产候选（让 perf-stats 按既有 `OUTPUT_ZERO` 规则处理，reader 不预判）。
- 夹具里混入 Auto 事件 ⇒ reader 看不到（已在 W1 排除），断言 `candidates === 非 Auto 数`。

通过条件：`node --test test/perf-workbuddy.test.js` 全绿。

### P3 — 注册与透传

依赖：P1、P2。写入：`src/perf-sources/index.js`。

动作：

1. `PERF_SOURCE_READERS` 加 `["workbuddy", streamWorkbuddyPerfSamples]`。
2. `streamPerfSamplesForFile` 的 reader options 加 `lookupGenerationDuration: options.lookupGenerationDuration`。
3. DSH 的 staged 分支保持不变；WorkBuddy 不进 staged（无"半份候选"语义）。

必测：`isPerfSourceEnabled("workbuddy")` 为 true；`enabledPerfSourceKinds()` 含且仅含 5 项；未注册 kind 仍 `not_enabled`；`lookupGenerationDuration` 确实到达 reader（spy）。

通过条件：`node --test test/perf-workbuddy.test.js test/perf-stats.test.js` 全绿；`PERF_UNSUPPORTED_KINDS` 未变。

## 7 U 模块：界面（1 卡）

### U1 — 来源分桶、标签与文案

依赖：无（字面量数据即可开工）。写入：`public/app.js`、`public/perf-ui.js`、`public/timeline-utils.js`、`public/i18n.js`、追加三个测试。

动作：

1. `HARNESS_ORDER`（`app.js:2821`）加 `"WorkBuddy"` 到末尾。
2. `bucketForChannel`（`:2824`）加 `if (name.startsWith("workbuddy")) return "WorkBuddy";`，放在默认 `Codex` 之前。
3. `sourceGroup`（`timeline-utils.js:4`）加 `if (homeKind === "workbuddy") return "WorkBuddy";`；channel 归一化分支加 `"workbuddy"`（单值即可，无 subagent 后缀）。
4. `perf-ui.js:78` labels 加 `workbuddy: "WorkBuddy"`。
5. `i18n.js`：`:333`、`:375`、`:675` 三处目录提示补 WorkBuddy；中英双语同时给。
6. 不新增专用样式、不改任何现有面板几何。

必测：`bucketForChannel("WorkBuddy")` 与 `sourceGroup("WorkBuddy","workbuddy")` 都归 `WorkBuddy`；`sourceGroup("WorkBuddy","")` 也归 `WorkBuddy`（channel 归一化兜底）；空态文案含 WorkBuddy 且中英一致；`HARNESS_ORDER` 长度 6。

通过条件：`node --test test/app-render.test.js test/i18n.test.js test/perf-ui.test.js` 全绿；既有 5 个来源的归组断言不变。

## 8 V 模块：验收（3 卡，主审）

### V1 — 三路一致

依赖：C3、S4、P3、U1 全部落地。写入：`docs/validation/2026-10-21-workbuddy-implementation/`。

在隔离临时目录用夹具启动真实 `createUsageServer` + 执行器 + SQLite + 正式页面，核对：

1. 内存路径（`collectUsageInMemory`）、SQLite 路径（`sync` + `summarize`）、`GET /api/usage` 三者的**事件数、token 五项、会话数**逐项相等。
2. Auto 事件 0 条；只跑 Auto 的会话不出现在任何响应里。
3. 并行工具调用不放大：夹具里同 id 5 条记录 ⇒ 1 个事件。
4. TPS 样本数 == 有 duration 的非 Auto 事件数；`sampleKey` 形状正确；`methodVersion === "tps-v1"`。
5. 删掉 trace 目录后重跑 sync ⇒ 样本数不变（表兜底生效）。
6. 导入目录 `~/.workbuddy-ai` 判为 `workbuddy-home`。

通过条件：三路逐项一致，差异为 0；不一致必须定位到具体字段，不允许"大致相同"。

### V2 — 真机有界冒烟

依赖：V1。

1. 用真实 `~/.workbuddy-ai` 跑一次完整 sync，记录**实测**：会话文件数、带 usage 记录数、Auto 数、非 Auto 唯一 id 数、generation span 数、命中数。
   - 参考量级（本稿写作时）：2 个会话文件、166 条带 usage 记录、7 条 Auto、约 160 个非 Auto 唯一 id、15 个 trace 文件、170 个 generation span、命中率 100%。
   - **这些数字会随本机使用持续变化**（本次会话本身就在写这个目录），只作为量级参照，验收以当次实测为准。
2. 页面检查：WorkBuddy 出现在来源列表、渠道归组、TPS 区域；Auto-only 会话不出现。
3. 记录一条"缺 duration"的告警是否存在（当前预期为 0）。
4. 不修改用户真实索引以外的任何配置；若需重扫，用索引副本。

通过条件：真实数据与夹具结论一致；任何缺口（缺 span、缺 duration）如实记录，不补猜、不写成通过。

### V3 — 门禁与文档

依赖：V1/V2 缺陷已修。

1. 文档：新建 `docs/data-sources/workbuddy.md`（存储布局、去重键、输入口径反转、Auto 排除、30 天窗口与 duration 表、已知限制）；更新 `docs/10-data-sources.md`（来源列表、判定顺序、`STORE_SCHEMA_VERSION` 16→17 的迁移说明）；更新 `README.md` 第 5/30/31/33/40/50 行附近六处；更新 `docs/02-tasks.md` 的"WorkBuddy 数据源待实施"状态；把[评估稿](2026-10-21-workbuddy-source-plan.md)状态改为"已实施"并链到本稿与验收目录。
2. 门禁：

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
git diff --check
```

3. 主审给出明确结论：通过，或逐项列出未完成边界。**部署、commit、push 不在卡内**。

通过条件：受影响测试通过；全仓结果有当前日志并如实列明失败/跳过及归属；文档里的数字与 V2 实测一致。

## 9 命令清单

```powershell
# W
node --test test/workbuddy-usage.test.js

# C
node --test test/workbuddy-core.test.js test/usage-core.test.js test/server.test.js

# S
node --test test/workbuddy-store.test.js test/perf-store.test.js test/perf-stats.test.js

# P
node --test test/perf-workbuddy.test.js test/perf-stats.test.js test/perf-summary.test.js test/perf-models.test.js

# U
node --test test/app-render.test.js test/i18n.test.js test/perf-ui.test.js test/app-summary.test.js

# V3：全部改完后跑一次
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
git diff --check
```

不新增生产依赖。浏览器检查用本机已有 Edge/Playwright，不为本轮引入新工具。

## 10 交付与防返工

每次交付写清三件事：

- 完成的卡、实际改动的文件与行为、当前受测摘要；
- 具体命令、exit code、结果；有失败就列用例名与归属；
- 下一张可执行卡；有阻塞就写阻塞事实与解除条件。

规则：

- **不重扫真实目录凑数据**。夹具证明语义，真机只做一次有界冒烟。
- 同一失败第二次仍未缩小范围 ⇒ 交主审做最小复现，不原样重复全套。
- 不顺手修无关问题（WAL、归档策略、`auto_vacuum` 都在别的任务里）。
- 契约变更只能由主审改本稿 §1 后广播。

**波 1 执行者的第一步**：读本稿 §0、§1，确认工作区 diff 干净并记录基线；W 从 `workbuddyHomeLooksUsable` 与会话解析开始（其余角色依赖它），C 从 `classifyImportDirectory` 的顺序插入开始，U 从 `HARNESS_ORDER` 与 `bucketForChannel` 开始。不要先跑真实目录。
