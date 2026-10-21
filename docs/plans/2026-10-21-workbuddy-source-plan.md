# WorkBuddy 数据源接入计划

更新：2026-10-21。状态：**已实施，本机真实来源已验收（2026-10-21）**。本机证据来自 `~/.workbuddy-ai`（WorkBuddy 桌面端，2026-10-19 安装；实施时复测为 4 个会话文件、453 条用量记录、458 个 generation span）与安装包 `resources/app.asar(.unpacked/cli/dist/codebuddy-lite-wb.mjs)`。

施工拆卡见[实施计划](2026-10-21-workbuddy-implementation-plan.md)，验收证据见[WorkBuddy 验收记录](../validation/2026-10-21-workbuddy-implementation/README.md)，字段映射与限制见[数据源专题](../data-sources/workbuddy.md)。实施计划修正了本文 §5.4 的七处字段与落点写法（`timingSource`/`methodVersion`/`tokenScope` 取值、reader 无法访问 DB、trace 指纹存哪、缺时长的上报通道），**实际落地以实施计划为准**，本文保留数据事实与决策论证。

## 0 决策摘要

| 事项 | 结论 |
| --- | --- |
| 可行性 | 可行。解析难度低于 Claude Code；数据自带归一化 usage |
| 去重 | 按 `providerData.messageId` 取一条，**不能累加**（并行工具调用会挂多条同 id 记录） |
| 输入口径 | `inputTokens` **已含缓存**，与 Claude 相反，不能再加 `cache_read` |
| Auto 模式 | **整体排除**，不计 token、不计费用、不参与 TPS（2026-10-21 用户决定，见 §2） |
| TPS | **必须做**。唯一时长来源是 `traces/<pid>/trace_*.jsonl` 的 generation span（见 §5） |
| 保留期 | 会话不自动清理；traces **30 天**；看板索引在来源文件消失时删历史（见 §3） |
| 失败/中断请求 | 结构上不产生用量记录；是否计费无法从本机验证（见 §4） |

## 1 已核实的数据事实

### 1.1 存储布局

- 会话：`<home>/projects/<cwd-slug>/<sessionId>.jsonl`，旁挂 `<sessionId>/tool-results/*.txt`（**跳过**，可能数十 MB）。
- 遥测：`<home>/traces/<pid>/trace_<32hex>.jsonl`，一行一个 span 事件（`trace_start` / `span_start` / `span_end`）。
- 本机 home 为 `%USERPROFILE%\.workbuddy-ai`；`~/.codebuddy` 只有 `logs/`、`diagnostics/`，无会话。
- 分类冲突：`.workbuddy-ai` 同时含 `sessions/` 与 `projects/<slug>/*.jsonl`，会被现有 `claudeHomeLooksUsable()`（只看结构）判成 `claude-home`，也会被 `codexHomeLooksUsable()`（只看 `sessions/`）判成 `codex-home`。**WorkBuddy 判定必须排在 Claude 与 Codex 之前，且内容感知**（文件内出现 `session-meta` / `function_call`）。

### 1.2 记录结构

| type | 用途 | 是否带用量 |
| --- | --- | --- |
| `session-meta` | 会话元数据（`meta["codebuddy.ai/hostKind"]`） | 否 |
| `message` | 用户/助手文本；助手文本回复的用量在这里 | 部分是 |
| `function_call` | 一次工具调用（一个响应可有多条） | 仅其中一条 |
| `function_call_result` | 工具结果 | 否 |
| `reasoning` | 思维链 | 否 |
| `ai-title` | 会话标题（`aiTitle`） | 否 |
| `file-history-snapshot` | 文件快照（体积不可控） | 否 |

用量字段（同一记录内三份，**同值冗余，只能取一份**）：

- `providerData.usage`：`{requests, inputTokens, outputTokens, totalTokens, inputTokensDetails:[{cached_tokens}], outputTokensDetails:[{reasoning_tokens}]}`
- `providerData.rawUsage`：OpenAI 风格 `prompt_tokens` / `completion_tokens` / `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `credit` 等
- `message.usage`：`input_tokens` / `cache_read_input_tokens` / `output_tokens`（snake_case）

实测三者一致：`rawUsage.prompt_tokens == usage.inputTokens == message.usage.input_tokens`，且 `prompt_cache_hit_tokens + prompt_cache_miss_tokens == prompt_tokens`。

### 1.3 去重与口径

- **一个模型响应 = 一个 `providerData.messageId`**；并行工具调用会写多条 `function_call`，用量只挂在其中一条（通常是最后一条）。本机实测 26 条 `function_call` 只对应 14 次响应，直接累加放大 1.86 倍。
- 映射：`input = inputTokens`（超集，已含缓存），`cached = inputTokensDetails[0].cached_tokens`，`output = outputTokens`，`reasoning = outputTokensDetails[0].reasoning_tokens`，`cacheWrite` 取 `rawUsage.cache_creation_input_tokens`（本机恒 0，非零语义未验证）。
- 时间戳为毫秒整数；`cwd`、`sessionId` 在 `function_call` / `message` 上均有；会话名取最后一条 `ai-title.aiTitle`。

### 1.4 模型身份

- `providerData.model` 是线路模型；`requestModelId` / `requestModelName` 是请求侧（`Deepseek-V4.1-Flash`）。
- `deepseek-v4.1-flash` 已在 `src/pricing.js` 价目表（USD 0.3 / 0.03 / 1.2，含北京时间峰谷 0.5 折）。
- Auto 模式写 `model=default-model`、`requestModelName=Auto`，无线路模型（本机 7/15 事件，旧会话全部如此）。

## 2 决策：Auto 事件整体排除

**规则**：`providerData.model === "default-model"`（或 `requestModelName` 忽略大小写等于 `auto`）的事件**不进入索引**——不计 token、不计费用、不参与 TPS、不参与会话统计。

**影响**：只跑 Auto 的会话（本机 `c:\Users\Silver\WorkBuddy AI\study`）在看板上完全消失。这是预期行为，不是 bug。

**理由**：

1. 无线路模型 ⇒ 价目表无法匹配，只能长期显示"缺费率"，污染模型列表与费用汇总。
2. `rawUsage.credit` 不能替代 token 计价：本机 Auto 事件 credit 为 0.77–2.21，而 deepseek 直连事件 credit 恒为 0，两者不可换算、也无法反推单价。
3. 用户明确选择"忽略不计"，优于显示一份不可解释的估算。

**落地位置**：适配器解析阶段直接 `continue`；`docs/data-sources/workbuddy.md`、`README.md`、`docs/10-data-sources.md`、看板来源说明各记一条；测试用夹具钉住"Auto 记录不产生事件"。

## 3 保留期与卸载：跨来源现状

### 3.1 看板自身行为（关键）

`src/usage-store.js` 在每轮 sync 结束时遍历 `source_files`：若某路径**不再被 discovery 发现**（home 整个消失，或文件被删），且该 home 没有读取失败，则删除 `source_files` 行，`events` 经 `ON DELETE CASCADE` 一并消失（`src/usage-store.js:4115` 附近）。**Codex 是唯一例外**：`if (canonicalizeKind(String(row.kind)) === "codex") continue;` 保留行与事件。

结论：**看板索引是镜像，不是归档**。卸载 agent 并清掉数据目录后，Claude / DSH / ZCode / OpenCode 的历史会从看板消失；Codex 不会。WorkBuddy 接入后默认走 Claude 这条路。

### 3.2 各来源的数据保留

| 来源 | 自身清理 | 依据 |
| --- | --- | --- |
| WorkBuddy 会话 | **不自动清理** | daemon 清理注册表 6 项策略无 `projects/`；CLI 侧清理被 `CODEBUDDY_DISABLE_SESSION_HISTORY_CLEANUP=1` 关闭 |
| WorkBuddy traces | **30 天** | 清理策略 `agent-traces`，`maxAgeMs: 2592e6` |
| Claude Code | 自带清理任务 | 本机 `~/.claude/.last-cleanup` 于 2026-10-20T23:07Z 更新；`settings.json` 未覆盖 `cleanupPeriodDays`，按上游默认 30 天（**待独立核实**） |
| Codex | 未见自动清理 | 索引侧另有豁免，文件消失也留历史 |
| DSH / ZCode / OpenCode | 未见自动清理 | 需各来源单独确认 |

### 3.3 建议（不在本次范围）

要"卸载也不丢历史"，需要在索引层改策略（对消失来源保留孤儿事件，像 Codex 那样），或提供导出/归档。这是跨来源的产品决策，不与 WorkBuddy 接入捆绑。

### 3.4 镜像 → 归档的存储成本（2026-10-21 实测）

索引库 `~/.codex-usage/usage-index.sqlite`：**240 MB**（58,666 页 × 4 KB），`events` 93,540 行。

| 对象 | 行数 | 表 + 索引 | 单位成本 |
| --- | --- | --- | --- |
| `events` | 93,540 | 44.2 MB + 29.4 MB | **787 B/事件** |
| `perf_samples` | 38,336 | 18.3 MB + 9.3 MB | **720 B/样本** |
| `perf_codex_projections` | — | 86.1 MB | 最大单表，与时长无关 |

按渠道（事件数 / 折算存储）：Codex 58,009 / 45.6 MB；DSH 22,989 / 18.1 MB；ZCode 7,949 / 6.3 MB；Editor 2,048 / 1.6 MB；Claude 1,977 / 1.6 MB；OpenCode 526 / 0.4 MB。

**关键结论：归档在稳态下不产生额外存储。** 只要来源文件还在，镜像与归档的增长完全一样；两者的差别只体现在"镜像会删、归档不删"的那部分。

额外成本 = 本会被删掉的事件：

| 场景 | 额外占用 |
| --- | --- |
| 卸载某个 agent（保留其全部历史） | 该来源累计量：Codex ≈ 46 MB、DSH ≈ 18 MB、Claude ≈ 1.6 MB（当前快照） |
| Claude 的 30 天滚动清理 | 归档把 30 天窗口变成永久：约 1,318 事件/天 × 787 B ≈ **31 MB/月**（按本机峰值；按 500/天 约 12 MB/月） |
| 从不回收（上界） | 当前强度 3,300–4,600 事件/天 + 同量级 TPS 样本 ≈ **150–210 MB/月，1.8–2.5 GB/年** |

参照：本机 C 盘剩 694 GB。索引库主文件 240 MB，但同目录的 `-wal` 已从 5.09 GB 涨到 5.43 GB 且仍在增长（约 23 MB/分钟，checkpoint 被 sync 期间的快照读者饿死）。现场与修法见[WAL 增长诊断](../validation/2026-10-21-wal-growth/wal-growth-diagnosis.md)。**先把 WAL 修好，再谈归档**——归档一年的增量还不到这个 WAL 的十分之一。

#### 为什么两种模式今天的体积一模一样

SQLite 的库文件是一本固定页数的册子（每页 4 KB）。`DELETE` 并不撕纸，只是把该页登记进 `freelist`（空闲页表），文件大小不变；后续插入优先填这些空位。因此：

- **镜像像白板**：擦掉旧的再写新的。板子不变大，但旧内容没了。
- **归档像卷轴**：只往后接。旧内容都在，卷轴越来越长。

只要来源文件都还在，镜像没有任何东西可擦，两种模式写入量完全相同。差别只在"某个来源被卸载或清理"之后：镜像把空间让给新数据（文件封顶），归档继续占用（文件继续增长）。当前 `freelist_count = 4 页（16 KB）`，正是"几乎没删过东西"的直接证据。

#### VACUUM 与空间回收

`VACUUM` 相当于**换一本新册子**：把还有用的页抄到新文件，丢掉旧文件。结果是文件变小、页连续、索引重建。

| 项 | 现状 / 代价 |
| --- | --- |
| 可回收量 | `freelist_count = 4 页` ⇒ **只有 16 KB**，现在做几乎没有意义 |
| 自动回收 | `auto_vacuum = 0`（关闭）；要小步回收需改 `INCREMENTAL` 并先做一次 VACUUM 生效 |
| 独占 | 期间不能有其它写连接，看板会卡住 |
| 临时空间 | 约等于库大小（240 MB） |
| WAL 模式 | 会把整库重写一遍，又往 WAL 写约 240 MB ⇒ **必须先 checkpoint 再 VACUUM** |
| 替代 | `VACUUM INTO 'new.db'` 生成紧凑副本后原子替换，适合一次性清理 |

结论：**归档模式下 VACUUM 基本是仪式**（freelist 不增长）；只有选镜像、且确实删掉大量历史（例如 Claude 30 天滚动清理）之后，VACUUM 或 `incremental_vacuum` 才有价值。是否启用 `auto_vacuum` 应与镜像/归档的选择一起定。

实现上还需要：`source_status`（在用/已移除）以便前端标注与筛选、一条"清除已归档来源"的回收出口。都是列级改动，存储可忽略。

## 4 失败/中断请求：结论与边界

- **结构**：用量只挂在已提交的助手记录上（`function_call` 或 `message`）。请求若在产出响应前失败/被中断，就没有助手记录，也就没有用量事件。看板看不到这次请求。
- **本机证据**：48/48 个 generation span 状态为 `ok`；4/4 个用户轮次（`startsNewUserRequest`）都有对应用量事件；没有 `error` 状态的会话记录。当前数据里**没有**可观测的缺口。
- **是否计费无法验证**：本地唯一带账单性质的字段是 `rawUsage.credit`，它只出现在完成响应上；deepseek 线路恒为 0，Auto 线路非零但已被排除。provider 对中断请求是否计费，本机无从判断。
- **可加的诊断（低成本）**：按 `conversationRequestId` 统计"有用户消息但零用量"的轮次，作为 warning 暴露。当前为 0；一旦非 0 即说明存在未记账请求。
- **结论**：按"可能少计"记入已知限制，不尝试补算，也不把缺失当 0。

## 5 TPS 方案（必须做）

### 5.1 数据来源

`traces/<pid>/trace_*.jsonl` 的 `generation` span：

```json
{"name":"generation","type":"generation","startedAt":"...","endedAt":"...","duration":3393,
 "status":"ok","toolOutput":"[{\"model\":\"deepseek-v4.1-flash\",\"created\":1792537465,
 \"usage\":{\"prompt_tokens\":37336,\"completion_tokens\":324,
 \"completion_tokens_details\":{\"reasoning_tokens\":135},...}}]"}
```

`toolOutput` 是完整 `chat.completion` 响应，含 `id`（**等于会话记录的 `providerData.messageId`**）、`model`、`usage`、`created`（秒）；`duration` 是请求端到端墙钟，符合项目对 TPS 的定义（非 TTFT）。本机 48/48 个 generation span 均可解析出 usage，`toolInput` 截断不影响 `toolOutput`。

### 5.2 与会话事件的关联：按响应 id 精确匹配

- 匹配键：trace `toolOutput[0].id` == 会话 `providerData.messageId`（同一响应的 ULID），**不需要时间窗**。
- 实测：会话侧 110 个用量 id 命中 109，唯一未命中的是 Auto 事件（本就要排除）⇒ 非 Auto **109/109 = 100%**。
- span 侧 112 个 id 中有 3 个不在会话里：标题生成、提示增强等辅助 generation，按 id 天然过滤，不需要白名单。
- `created`（秒）与记录时间戳（毫秒）、`completion_tokens` 与事件 output 只作一致性断言，不参与匹配。
- 先后顺序实测：span `endedAt` 比会话记录早 **38 ms**，trace 文件 mtime 与记录同秒（08:08:56）。即"先落 span，后写记录"，这是扫描策略（§5.4）能成立的前提。

### 5.3 30 天窗口与"重解析会丢样本"

两个独立陷阱：

1. traces 只保留 30 天：查询时现读，TPS 历史会在 31 天后凭空消失。
2. 会话文件每次追加都会触发 `replaceFile()` 全量重解析，而现有实现是"按 `source_path` 删除该文件的 `perf_samples` 再重建"。若 duration 只从 traces 现取，30 天后的一次普通追加就会把该会话的**全部历史样本**丢掉。

因此要持久化的是 **duration 本身**，不是只持久化样本：

- **（已定）**新增 `workbuddy_generation_durations(message_id TEXT PRIMARY KEY, duration_ms INTEGER, ended_at_ms INTEGER, method_version TEXT, captured_at TEXT)`，采集时 `INSERT OR IGNORE`（幂等、先到先得）。
- 重解析时按 `messageId` 查表补 duration；traces 是否还在都不影响。
- 行宽约 100 B，10 万条约 10 MB，可忽略；可随事件删除清理，也可长期保留。
- 迁移新增一版（v17），**不改 `events` 表结构**。

### 5.4 实现落点

**扫描策略（已定：会话文件变化时才扫）**

不做"每轮 sync 全量扫 traces"，只在**有 WorkBuddy 会话文件发生变化**的那一轮触发 trace 扫描；扫描本身仍按 `(size, mtime)` 指纹跳过未变文件。理由是 traces 总量会随 30 天窗口收敛（本机当前 14 个文件、约 4 MB），但每轮全 stat 在长期没有收益。

风险与处置：

| 风险 | 是否成立 | 处置 |
| --- | --- | --- |
| span 比会话记录晚落盘，扫的时候还没写 | **不成立**：实测 span 早 38 ms，trace mtime 与记录同秒 | 无需处理；仍保留"按 id 匹配"，即使晚到也能在下一轮补上 |
| 进程重启后指纹丢失，无会话变化就不扫 | 成立 | 指纹持久化到 meta；**启动后第一轮强制做一次增量扫**（只 stat，成本可忽略） |
| 导入新 home / 历史回填 | 成立 | 新文件必然触发会话变化，自然覆盖；导入时额外强制全扫一次 |
| 应用崩溃在"写完记录、未 flush span"的毫秒窗口 | 理论成立，概率极低 | 该请求会缺样本，计入覆盖率；不补猜 |
| 会话再也不会变化，且 span 当时没扫到 | **不成立**：span 先于记录落盘，触发扫描的那次变化必然能看到它 | — |
| 标题/增强等旁路 generation 只更新 trace | 成立 | 它们本来就没有会话事件，不需要采集 |

结论：会话变化触发 + 启动增量扫，覆盖率与"每轮扫"等价，长期开销更低。若后续发现 trace 落盘延迟变大（`endedAt` 与记录时间差 > 1 s），再退回"每轮增量扫"或加 10 分钟兜底扫。

**其余落点**

- 扫描只取 `span_end` 且 `type=generation` 的行，解析 `toolOutput[0].{id, duration}` 写入 duration 表；该步骤在 `replaceFile` 事务**之外**完成，避免事务内做文件 I/O。
- 新增 `src/perf-sources/workbuddy.js`：从会话文件产出样本，duration 查表；缺表项则跳过并计入覆盖率。
- 注册：`src/perf-sources/index.js` 增加 `workbuddy`；`src/perf-stats.js` 增加 `canonicalPerfSourceKind` 与 `resolvePerfSampleKey` 分支。
- 样本字段：`sampleKey = ${homeId}:${messageId}`、`methodVersion = workbuddy.generation.v1`、`timingKind = request`、`timingSource = workbuddy.trace.generation`、`tokenScope = output`、`tsMs` 取事件时间。
- 覆盖率分母 = **WorkBuddy 非 Auto 事件数**（Auto 已被整体排除，算进去会恒定拉低到约 93%）。

### 5.5 风险

| 风险 | 现状 | 处理 |
| --- | --- | --- |
| `toolOutput` 截断或解析失败 | 本机 0/48 | 跳过并计入覆盖率，不猜 |
| trace 文件缺失（未写/已清理/换 PID） | 非 Auto 109/109，0 缺口 | 覆盖率如实显示 |
| 会话重解析丢历史样本 | 结构上必然 | duration 表兜底（§5.3） |
| traces 30 天后清理 | 已确认策略 | 采集即落表 |
| 辅助 generation 混入 | 3 个 span | 按响应 id 过滤 |
| 同一 id 多个 span（重试） | 本机 0 例 | `INSERT OR IGNORE` 先到先得 |

### 5.6 跨来源对比：WorkBuddy 是唯一把时长放在旁路通道的来源

| 来源 | 时长字段 | 位置 | 与用量同源 | 生命周期 |
| --- | --- | --- | --- | --- |
| Codex | `payload.duration_ms` | rollout `.jsonl` / `.jsonl.zst`（`sessions`、`archived_sessions`） | **是** | 随会话文件长期保留（归档目录 1.8 GB） |
| DSH | `durationMs` | `sessions/**/session.v*.jsonl.zstd` | **是** | 随会话文件 |
| ZCode | `duration_ms` 列 | `db/db.sqlite` | **是**（同库） | 随库 |
| OpenCode | `completed - created` | 数据目录 `opencode*.db` | **是**（同库） | 随库 |
| Claude Code | 无 | 转录无时长；`~/.claude/telemetry` 只有 `tengu_*` 上传失败事件，无 duration/latency 字段 | — | 不支持 TPS（既有结论） |
| **WorkBuddy** | generation span `duration` | `traces/<pid>/trace_*.jsonl` | **否，旁路** | **30 天** |

结论：其它来源的时长与用量写在**同一条持久记录**里，TPS 的寿命等于用量寿命；只有 WorkBuddy 把时长放在独立的遥测通道，且该通道只有 30 天。所以"TPS 比用量短命"是 WorkBuddy 独有的问题，不是通用问题。Claude 是另一类：根本没有时长，谈不上寿命。

这意味着 WorkBuddy 的 TPS 不能照抄现有 reader 的"从同一文件取 duration"模式，必须做跨文件关联 + 入库持久化（§5.2、§5.3）；其它来源不需要改。

## 6 工作量重估（含 TPS）

| 模块 | 规模 |
| --- | --- |
| `src/workbuddy-usage.js` | 350–420 行 |
| `usage-core` 接线（分类/发现/指纹/分派/两处 parse） | 60–80 行，8 处 |
| `usage-store`（文件展开、sync、`harnessModels.WorkBuddy`、迁移 v17） | 40 行 |
| `src/perf-sources/workbuddy.js` + `perf-stats` 分支 + duration 表/迁移 + trace 预扫 | 520–670 行 |
| `server` 导入标签 / 前端（`HARNESS_ORDER`、`bucketForChannel`、空态、i18n、TPS 来源标签） | 40–60 行 |
| 测试（适配器 12、core 7、store 3、三路一致 1、TPS 8–10） | 550–700 行 |
| 文档（`data-sources/workbuddy.md`、10、README、02、本计划） | 2 篇 |

编码约 **1.5–2 个工作日**（TPS 占一半）；真机验收 3 天，其中"30 天窗口"只能靠策略代码与构造夹具验证，无法短期实测。

难度：解析 2/5，接线 2/5，**TPS 4/5**，验收 3/5。

## 7 待验证

1. 失败/中断请求是否留下 `error` 状态记录（验收阶段人为中断一次即可定性）。
2. trace 30 天清理的实际执行（策略已读到，未见执行日志）。
3. 并发会话下时间关联是否歧义。
4. 长会话 compaction 后旧用量是否仍在文件里。
5. `toolOutput` 截断阈值（多大响应会被截）。
6. `cache_creation_input_tokens` 非零时的语义（当前恒 0）。

## 8 验收标准

- `GET /api/usage` 出现 `Main WorkBuddy`，事件数与本机会话文件逐条对账一致（Auto 事件除外）。
- 并行工具调用不放大：同一 `messageId` 只产生 1 个事件。
- 输入超集成立：`input >= cached`，`total == input + output`，`validateUsageDetails` 不撤销明细。
- Auto 事件 0 条进入索引；只跑 Auto 的会话不出现在看板。
- TPS 区域出现 WorkBuddy 分组，样本数 = 可关联的 generation span 数，覆盖率如实显示；30 天后样本仍在（已入库）。
- 导入 `~/.workbuddy-ai` 被判为 `workbuddy-home`，不被误判为 Claude 或 Codex。
- 非 Codex 限额排除、渠道分组、i18n 文案、README 来源列表同步更新。
