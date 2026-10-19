# TPS 计划历史调查与改判记录

整理日期：2026-10-04。原位置：docs/plans/2026-10-03-model-latency-throughput-plan.md 的原 §2、§6、§13–§16、§18。原章节编号与正文保留，文档相对链接按新位置修复。

这些章节记录 2026-10-03 的调查、被推翻的分母、旧任务卡和当时的决策过程，不是当前实施规格。现行规则以[模型输出吞吐指标计划](../../plans/2026-10-03-model-latency-throughput-plan.md)的 §1、§3–§5、§7–§11、§17 为准；§19 是同日后续诊断证据。

<a id="historical-section-2"></a>
## 2. 本轮只读实测（带日期快照，不是永久基线）

> **本节为第一遍抽样实测，保留作过程记录。** 其中 Codex 的「多请求轮 35 条」与 OpenCode 的三条抽样推断已被 §14 的全量复算更正；当前覆盖率与分位数请看 §1、§17 和 §19，以下旧数字只对应当时快照。**本节以及 §13–§15 中出现的 TTFT 数字、以及 DSH 的 A/B 口径判定，一律只是过程记录**——TTFT 已于同日移出交付范围、DSH 已改判为不读 `stream`（§16）；当前有效口径看 §1、§3 与 §17；§16.7 同样是历史记录。

复算条件：本机 `~/.codex`、`~/.zcode`、`~/.dsh`、`~/.local/share/opencode`，2026-10-03 读取，只读打开数据库。上游版本或目录变化后须重测。

- **Codex**：`sessions/2026/**` 166 个 rollout JSONL 中，`event_msg/task_complete` 共 3308 条，其中 3236 条（**97.8%**）带 `time_to_first_token_ms`；这 3236 条里 3201 条能按 `turn_id` 精确配对到**恰好一条** `token_usage_record`，35 条配到多条，0 条配不到（**该分布已在 §13.2 更正：多请求轮远不止 35 条**）。含该字段的文件 187 / 236（含 `archived_sessions`）。样例：`{"type":"task_complete","turn_id":"…","started_at":1789698211,"completed_at":1789698216,"duration_ms":5224,"time_to_first_token_ms":4125}`（`started_at`/`completed_at` 为**秒**，`duration_ms` 为毫秒）。
- **Codex 实测数值**：`codex-auto-review` 3197 个样本，平均 TTFT 2791ms、平均轮时长 3894ms；由 `(duration_ms − ttft)` 与输出 token 推出的吞吐多在 50–140 tok/s 区间，离群值可达 400+（输出 token 极小所致）。
- **Codex 的反例（关键）**：`gpt-6.1-sol` 18 个样本平均 TTFT 9295ms，但平均 `duration_ms` = **806184ms（约 13 分钟）**；`gpt-6-luna` 平均 1694462ms。这直接证明 `duration_ms` 是含工具执行与人审等待的轮级墙钟，**不得**当作模型生成耗时。
- **ZCode**：`~/.zcode/cli/db/db.sqlite` 的 `model_usage` 共 4066 行，`duration_ms` 非空 4066 行（100%）、`output_tokens > 0` 4023 行（98.9%）、`time_to_first_token_ms` 非空 3157 行（**77.6%**）。按模型：GLM-5.3-Flash 2425 请求 / 均值 TTFT 5304ms / 均值时长 26487ms；mimo-v2.6-pro 586 / 26510ms / 55498ms；step-5-preview 484 / 5362ms / 46010ms；deepseek-flash 438 / 4230ms / 12087ms。`agent` 列天然给出子代理维度：`zcode-agent` 3607、`zcode-general-purpose` 280、`zcode-Explore` 179。
- **DSH**：`~/.dsh/sessions` 下 66 个 `session.v4.jsonl.zstd`。最大单会话解出 1940 行，含 `assistant/message` 317 行、`step/start` 318、`step/end` 318、`turn/start` 29。`assistant/message` 的 `data` 键为 `turn, step, message, usage, stream`；`data.usage` 为请求级增量（如 `{"inputTokens":12552,"outputTokens":384,"totalTokens":12936}`）；`data.stream` 20 项，元素含绝对 `time`（毫秒）与 `{type,time0,index,dt,texts}` 两种形态，末两块为 `usage`/`finish`。`step/start` 与 `step/end` 的 `time` 差给出干净的请求级窗口（样例 step 1 = 6915ms）。模型来自 `request/header` 的 `data.header.config.{provider,model}`。
- **OpenCode**：`opencode.db` 中 `type='assistant'` 消息 503 条。`data.time` 三键 `{created, streamed, completed}`，三条抽样中 `completed − streamed` 仅 5 / 72 / 67ms，而 `streamed − created` 为 6827 / 3093 / 1955ms → 判断 `streamed` 是**流写入完成**时刻而非首 token。`data.agent`、`data.model.id`、`data.tokens.output` 齐备。

<a id="historical-section-6"></a>
## 6. DSH 读取 `stream`：**已作废（改判 B，2026-10-03）**

> **本节整节不作为施工依据。** 用户 2026-10-03 确认改走 **B：DSH 完全不读 `data.stream`**，分母改用纯元数据；**具体用哪一对元数据时间戳随后由 §18.2 定为 `message.time − step/start.time`**（不是本条写的 `step/end`）。本节保留是为了记下"为什么曾经要读"，避免后来者重新发明 A。
>
> 作废的部分：**窄读取清单**（`:236` 允许读取的 key / 禁止读取的 key）、**撤回隐私承诺**、**`docs/data-sources/dsh.md` 与 `docs/10-data-sources.md` 的边界改写**、P2 卡的文档写入作用域。B 路径下 `src/dsh-usage.js:236` 的现有承诺**原样有效，一字不改**。
>
> 仍然有效的部分：
> - **`turn:step` 复合键**（本节末与 §14.6）。B 路径同样要把 `assistant/message` 与同 `(turn, step)` 的 `step/start`/`step/end` 配对，step 编号按 turn 重置，只按 `step` 建映射会跨轮碰撞——A 下表现为负 TTFT，B 下表现为**跨度取错端点**，同样产出假数。
> - **"`stream` 不能当窗口、`dt[]` 不是逐 token 节奏"**（§14.6、§15.6）。这是**否证记录**：正是它加上"TTFT 取消"让 A 的收益归零，从而支持改判 B。

`src/dsh-usage.js:236` 现有承诺是："只读用量与元数据字段；message/content/stream/tool 参数与结果一律不读"。A 路径要撤回其中关于 `stream` 的部分，必须按下面的窄口径落地：

- **允许读取的 key**：元素的 `type`、`time`、`time0`，以及 `chunk.type`、`chunk.blockType`（仅用于判别"首个内容块"这一结构事件）。
- **禁止读取**：`texts[]`、`chunk.block.text`、`reasoning` 正文、`dt[]`（见下）、`replayState`、以及 `message.content` 整枝。解出后不进入事件对象、不进入 `perf_samples`、不落索引、不打日志。
- **必须同步改写**：`:236` 注释、[DSH 专题](../../data-sources/dsh.md) 的字段与边界小节、`docs/10-data-sources.md` 的"读取与数据边界"（补一句"`stream` 的结构事件与时间标量会被读取，正文与 `texts` 增量不会"）。三处都要改，否则注释与实现漂移。

**关键实测约束：`stream` 只能当锚点，不能当窗口。** `data.stream` 是**合并重放日志**：只有 `block-start` / `block-end` / `usage` / `finish` 这类结构块带绝对 `time`，承载 token 体积的 `text-chunks` / `tool-call-chunks` 元素只有 `time0` + `dt[]`，且 `dt.length = texts.length − 1`（实测 16 texts / 15 dt，大量 `dt` 为 0）。用 stream 内部跨度算 TPS 会在 **91/2880（3.2%）** 样本上得到 >1000 tok/s 的鬼数（极值 1943 token / 862ms）。因此：

- **窗口起点锚点** = 首个非 reasoning `block-start` 的 `time`（**不再对外产出为 TTFT**，只用于构造 `gen_ms` 的起点）。实测该锚点出现在同 `(turn, step)` 的 `step/start` 之后 972–25149ms，覆盖 2885 行（≈100%）。
- **生成窗口** = `step/end.time` − 首块 `time`（跨度端点用元数据行，起点用 stream 锚点），**不是** stream 内部首末块之差。
- **`dt[]` 不用于逐 token 节奏**：它不具可信的单调性，也无法与 `texts` 等长对齐；§3 原文写的"`DSH = 末内容块 time − 首内容块 time`"已作废。

`step/start` 的 key 必须是 `turn:step` 复合键——step 编号**按 turn 重置**，只按 `step` 建映射会让锚点跨轮碰撞，实测把 TTFT 打成 −1932043ms 这类负值假数（第一遍复算就踩过）。

<a id="historical-section-13"></a>
## 13. 第二遍独立复核（2026-10-03 晚，只读）

> **历史记录：本节含已被 §19 否证或由现行契约替代的结论/任务卡，不直接作为施工依据。** 阅读当前规则请回到 §1、§3–§5、§7–§11 与 §17。

另一个 agent 在不改动任何产品代码的前提下复核了 §1–§2 的关键前提。**结论：§1 的可行性判定成立**——四个来源的历史文件确实带时延字段，且不需要新增采集链路。同时发现一处必须更正的分布数字和一处环境阻塞。

### 13.1 本轮已独立复核（非转述）

| 复核项 | 证据 |
| --- | --- |
| Codex 轮级时延字段真实存在 | `~/.codex/sessions/2026/09/29/**` 与 `2026/10/03/**` 的 JSONL 中，`event_msg/task_complete` 稳定带 `turn_id`、`started_at`、`completed_at`（epoch **秒**）、`duration_ms`、`time_to_first_token_ms`（毫秒）。实测样例：`duration_ms: 6599, time_to_first_token_ms: 5461`。 |
| Codex 请求级用量可与轮配对 | `~/.codex/sessions/2026/10/**` 存在独立记录类型 `token_usage_record`，`payload` 带 `turn_id`、`response_id`、`usage`、`turn_token_usage`（轮内累计）、`thread_token_usage`（线程累计）。这是 §2「按 `turn_id` 配对」的实际载体。 |
| 该字段尚未被适配器读取 | `src/usage-core.js` 只处理 `event_msg/token_count`（`:1147`、`:1518`）；全仓 `src/`+`public/`+`test/` 检索 `perf_samples\|perf-stats\|time_to_first_token_ms\|tokensPerSecond` 零命中。 |
| §4/§5/§7/§8 的代码位置仍有效 | `STORE_SCHEMA_VERSION = 11`（`src/usage-store.js:39`）、`groupedRange`/`allowedColumns`（`:808`/`:809`）、`requestFilters`（`src/server.js:74`）、`/api/summary`（`:763`）、`includeDetails` 门控（`:746`）、`formatTokens`（`public/app.js:159`）、`renderBarListHtml`（`:1460`）、`timelineDetailRows`（`:1519`）、`UsageSummary`（`src/usage-types.js:110`）、`summaryFields`（`test/three-path-parity.test.js:160`）。 |

### 13.2 更正：Codex 的「多请求轮」不止 35 条

§2 的「3201 条配到恰好一条、35 条配到多条」来自 auto-review / guardian 子代理会话占绝对多数的那批样本。本轮读今天的真实主会话（`rollout-2026-10-03T20-37-00-*.jsonl`）可见：**同一个 `turn_id` 连续出现 12 条以上 `token_usage_record`**，`turn_token_usage` 逐条累加——一个 agentic 轮次里本来就有多次 API 请求。

影响必须写进实现：

- Codex 的 **TTFT 不受影响**：每轮一个 `time_to_first_token_ms`，覆盖率仍按 §2 的 97.8% 量级复核。
- Codex 的 **TPS 可信样本会被 auto-review / guardian 这类「单请求轮」占满**，真正写代码的主代理轮次大多落进「多请求轮」而不出 TPS——这正是 §2 反例的同一个坑。因此 §3 的「仅单请求轮次」白名单**必须与 `agent` 维度同时呈现**，并在 UI 明确标注「该模型/该代理无 TPS 样本」，不得让读者以为主代理没有 TPS 等于没有数据。
- **P0 必须重测**「每个 `turn_id` 的 `token_usage_record` 条数分布」，不得沿用 §2 数字。

### 13.3 本轮未复核（仍属 §2 转述，P0 必须重算）

ZCode 的 `time_to_first_token_ms` / `duration_ms` / `agent` 列，DSH 的 `data.stream` 时间标量形态，OpenCode 的 `time.streamed` 语义——本轮没有独立复算。它们需要能跑 Node 的 shell 去只读打开 SQLite 并逐帧解压 zstd，而本会话的 shell 被 Windows 文件权限挡住（§13.4）。**这三项必须在 P0 一次性复算后才允许进入 P1。**

> 2026-10-03 更新：上述三项已在 §14 用可运行 Node 的会话完成全量只读复算，ZCode 与 DSH 判定成立（DSH 覆盖率强于本文原假设），OpenCode 的 `streamed` 语义被**否证**。§13.2 关于 Codex 多请求轮的判断也被 §14.2 证实并量化。

### 13.4 环境阻塞（**已解除**，见 §15.9）

原记录：本会话 `pwsh` 每次调用均失败 `SetNamedSecurityInfoW failed (Win32 5)`，`node`/`npm.cmd test`/`tsc`/`biome` 全部无法运行。**该状态已结束**：会话切到「完全权限」后恢复，§14 与 §15 的全部数字都是在该状态下只读跑出来的，P0 复算与后续门禁命令均可执行。

### 13.5 施工任务卡（每卡一个写入者，按依赖串行）

写作用域是建议边界；同一文件同时只能有一个写入者。

| 卡 | 内容 | 写入作用域 | 前置 |
| --- | --- | --- | --- |
| **P0.1** | 只读复算脚本：按 `(来源, agent, 模型)` 统计字段存在率、`turn_id` 配对条数分布、剔除率、覆盖率；产出 JSON 快照 | `scripts/perf-probe.mjs`（新增）、`docs/validation/<date>-perf-metrics/`（新增） | 无 |
| **P0.2** | 依据 P0.1 结果复核 §2/§13.2/§13.3 数字，冻结口径与阈值（`gen_ms` 上限、`n < 20` 门槛）；不通过则停 | 本文件、`docs/10-data-sources.md` | P0.1 |
| **P1.1** | 分位数纯函数：p50/p90、奇偶样本、全同值、n=1、剔除后为空 | `src/perf-stats.js`（新增）、`test/perf-stats.test.js`（新增） | P0.2 |
| **P1.2** | 各来源原始行 → perf 样本的纯映射与剔除规则 | `src/perf-samples.js`（新增）、`test/perf-samples.test.js`（新增） | P1.1 |
| **P1.3** | `perf_samples` 表 + `STORE_SCHEMA_VERSION` 11→12 + `UPDATE source_files SET size = -1, mtime_ms = -1` 全量重索引 | `src/usage-store.js`、`test/usage-store.test.js` | P1.2 |
| **P1.4** | 内存路径采集（先 ZCode，后 Codex） | `src/usage-core.js`、`src/zcode-usage.js`、各来源测试 | P1.3 |
| **P1.5** | 四路汇总接线（内存 / 紧凑索引 / SQLite / 浏览器快照）+ `summary.perf` 段 + `summaryFields` 白名单 | `src/usage-core.js`、`src/usage-store.js`、`public/app.js`、`src/usage-types.js`、`src/server.js`、`test/three-path-parity.test.js` | P1.4 |
| **P1.6** | 「按性能」模式 + 下钻 dialog + `formatDurationMs` + 中英文案 + 皮肤变量 | `public/app.js`、`public/i18n.js`、`public/index.html`、`public/styles.css`、`test/i18n.test.js`、`test/app-*.test.js` | P1.5 |
| **P2** | DSH：**按 §16.7 已改判的 B 路径实现**——分母 `step/end − step/start`、`turn:step` 复合键、`data.stream` 整枝不读；**不改**边界注释、**不改**任何文档 | `src/dsh-usage.js`、其来源测试 | P1.2 |
| **P3** | OpenCode：只出「含首 Token 段的请求吞吐」并标注口径 | `src/opencode-usage.js`、专题 | P1.6 |
| **P4** | 文档与验收：新增性能口径专题、`docs/validation/<date>-perf-metrics/` 记录真实来源检查与未测条件 | `docs/` | P1–P3 |

每卡在交接前跑 `npm.cmd test`、`npm.cmd run typecheck`、`npm.cmd run lint` 并把结果写进验收记录。**P0.2 是唯一的停止点**：覆盖率不足就停在这里，不进 P1。

### 13.6 仍未登记

本计划仍未写进 `docs/00-index.md` 的「当前计划」与 `docs/02-tasks.md`（§12 的理由：多 agent 并行编辑导航页）。P0.2 通过后应补上指针，否则下次接手会看不到它。

<a id="historical-section-14"></a>
## 14. 第三遍全量复算（2026-10-03 更晚，只读，覆盖 §2 抽样与 §13.3）

> **历史记录：本节含已被 §19 否证或由现行契约替代的结论/任务卡，不直接作为施工依据。** 阅读当前规则请回到 §1、§3–§5、§7–§11 与 §17。

复算方式：可运行 Node 24 的会话，只读打开 `~/.zcode/cli/db/db.sqlite`、`~/.local/share/opencode/opencode.db`，用 `src/dsh-usage.js` 的 `readDshSessionRows` 解全部 66 个 zstd 会话，逐行流式扫描 `~/.codex/sessions/2026/**`（168 个 JSONL）。**全部改为全量统计，不再使用抽样。** 临时脚本用完即删，未写入仓库。

### 14.1 否证：OpenCode 的 `time.streamed` 不是首 Token

504 条可用 assistant 消息（三时间戳齐备且 `output + reasoning > 0`）：

| 区间 | p10 | p50 | p90 | max |
| --- | --- | --- | --- | --- |
| `created → streamed` | 1490ms | 5375ms | 21662ms | — |
| `streamed → completed` | — | **216ms** | 2147ms | 120096ms |
| `created → completed` | — | 6197ms | 24042ms | — |

若 `streamed` 是首 Token，则生成窗口 = `completed − streamed`，**317/504（62.9%）** 的样本会算出 TPS > 1000 tok/s，最高一条为 465 token / 5ms = **93000 tok/s**——不可能。而 `created → streamed` 占 `created → completed` 的 87%，符合"streamed = 流写入完成"。按 `created → completed` 算出的请求吞吐是合理量级：`muse-spark-1.3-contributor-free` n=373 p50=50 tok/s、`space-bunny-free` n=62 p50=67、`claude-sonnet-5-5` n=10 p50=107、`longcat-2.5-preview-free` n=35 p50=22。

**结论**：OpenCode 有请求总时长真值（≈99% 行可用），**没有 TTFT 真值**。改动点 `src/opencode-usage.js:58`（`timestampMsFor` 已经在读 `time.completed`）成立。

### 14.2 修正：Codex 的 TPS 分母必须换成 item 跨度

按 `(session_meta.source, turn_context.model)` 分组统计每个 `turn_id` 的 `token_usage_record` 条数：

| 分组 | 轮数 | reqs/轮 p50 / p90 / max | 单请求轮 | 多请求轮 | 有 item 跨度 | TPS p50（墙钟分母） |
| --- | --- | --- | --- | --- | --- | --- |
| `subagent/other` · codex-auto-review | 3213 | 1 / 1 / 2 | 3211 | 2 | 1596（50%） | ≈76 |
| `vscode` · gpt-6.1-sol | 18 | **11 / 29 / 39** | 1 | 17 | 18（**100%**） | ≈23 |
| `vscode` · gpt-6-sol | 7 | 6 / 22 / 22 | 1 | 6 | 7（100%） | ≈31 |
| `vscode` · gpt-6-luna | 5 | 5 / **680** / 680 | 0 | 5 | 5（100%） | ≈51 |
| `vscode`/`cli` · gpt-6-astra | 4 | 4 / 16 / 16 | 0 | 4 | 4（100%） | ≈19–28 |

- **§2 的"多请求轮仅 35 条"作废**：那是 `codex-auto-review` 子代理会话占 98.9% 样本造成的假象。**§13.2 的判断正确**：真实主代理轮次平均 11 次以上请求，一条 `gpt-6-luna` 轮次内出现 680 次请求。
- **好消息**：`item_completed` 的 `started_at_ms`/`completed_at_ms` 跨度（`AgentMessage` 1484、`Reasoning` 128 等，PascalCase 判别式）在主代理会话覆盖 **100%**，恰好在墙钟口径最失真的地方可用。求和即"该轮纯模型生成时间"，用它做分母：`gpt-6.1-sol` 约 **68 tok/s**，墙钟口径约 23 tok/s，差约 3 倍。
- **口径要求**：item 跨度分母下，分子是该轮全部请求的输出 token 之和，语义为"该轮 LLM 生成时间的平均吞吐"，不是单请求速度；UI 与文档必须这样写。
- **附带更正**：`time_to_first_token_ms` 是**每轮一个**（轮内首次请求），不是每请求一个；多请求轮的后续请求无 TTFT。
- **注意**：item 类型判别式为 PascalCase（`AgentMessage`/`Reasoning`/`CommandExecution`/`McpToolCall`），与事件名的 snake_case（`task_complete`）不同，写匹配时不要想当然。

### 14.3 证实且强于原假设：DSH 覆盖率 100%

66/66 会话可解码；**2874 条 `assistant/message` 行全部**带非空 `data.stream`（平均 9 个块）且能配到同 step 的 `step/start`，即 **TTFT 可算率 100%**；2871 条带 `data.usage` 且 `outputTokens > 0`。55 个会话含此类行（另 11 个为空/仅标题会话）。

因此 §6 的路径 A（读 `stream` 时间标量）收益高于本文原估：DSH 是四源中唯一同时具备真 TTFT、真生成窗口和请求级 token 的来源。`stream` 元素含 `texts` 文本增量的边界冲突仍在，需按 §6 决策。

### 14.4 复述成立：ZCode

`model_usage` 4066 行：`duration_ms` 非空 4066（100%）、`time_to_first_token_ms` 非空 3157（**77.6%**）、`output_tokens > 0` 4023（98.9%）；`agent` 维度 `zcode-agent` 3607 / `zcode-general-purpose` 280 / `zcode-Explore` 179。§2 数字不变，改动点 `src/zcode-usage.js:138`（`SELECT * FROM model_usage`）成立——该查询已是 `SELECT *`，新字段无需改 SQL，只需在映射里取用。

### 14.5 对施工计划的影响

- **P0.1 的复算已完成**（§14 即其结果），P0 只需把本轮脚本固化为 `scripts/perf-probe.mjs` 并落一份带 revision 的快照，不必重做分析。
- **P1 顺序调整**为 ZCode → DSH → Codex → OpenCode，其中 DSH 受 §6 决策阻塞。
- **新增必然工作量**：Codex 采集需在一次流式扫描内按 `turn_id` 缓冲 item 跨度，再于 `task_complete` 时定档；样本写入要独立于现有 `events` 推送（`src/usage-core.js:1147` 之后目前直接 `continue`，整轮时延信息全部丢失）。每轮缓冲常数大小，不得缓存整文件。
- **§11 第 1 点（DSH 是否读 `stream`）现在是主要阻塞项**：100% 覆盖意味着 A 路径收益明确，B 路径会明显降级。
- 本节所有数字是 2026-10-03 的本机快照，不是永久基线；上游版本变化后按 §10 的 P0 重测。

### 14.6 DSH 按 A 路径实装前的口径试算（同一晚，只读）

> **2026-10-03 改判横幅**：本节第 3 行标的"**采用口径**"（`step/end − 首块`）与末段的"应视为**上界估计**"，都只反映当时选定 A 的判定。用户随后改判不读 `stream`（§16.7），而**最终口径由 §18.2 定为第三个选项 C：`message.time − step/start.time`，2929 样本、p50 97.2 / p90 188.9、0 荒谬样本、总量比 104.6**——本节的 A、以及 §16.7 第 4 条的 B（`step/end − step/start`：2879 样本、p50 73 / p90 155）**都已被取代**。表格数字本身是实测记录，不作改动。§14.5 里"§11 第 1 点是主要阻塞项"也随该决策解除。

§6 决策确定后，对全部 66 个会话做了三种分母的对照试算，用来冻结 DSH 口径。**§3 原先写的 `DSH = 末内容块 − 首内容块` 是错的，已作废**：

| 分母口径 | 样本 | TPS p50 | TPS p90 | 荒谬样本（>1000 tok/s） |
| --- | --- | --- | --- | --- |
| `stream` 内部跨度（`max(time) − min(time)`） | 2880 | 192 | 313 | **91（3.2%）**，极值 1943 token / 862ms |
| `step/end − step/start`（纯元数据，不含 stream） | 2879 | 73 | 155 | 0 |
| `step/end − 首个内容块 time`（**采用口径**） | 2886 | 136 | 258 | 待 P0 复核 |

TTFT（首块 − `step/start`）：n = 2885，**p50 2151ms / p90 4511ms**；按模型 p50：`deepseek-flash` 1633ms、`deepseek-v4.1-flash` 4020ms、`muse-spark-1.3-contributor` 4054ms、`step-5-preview` 4411ms、`kimi-k3` 3783ms。

两条必须记住的结构性事实：

- `stream` 是**合并重放日志**：结构块带绝对 `time`，token 体积所在的 `text-chunks` / `tool-call-chunks` 只有 `time0` + `dt[]`，且 `dt.length = texts.length − 1`（16 texts / 15 dt，`dt` 大量为 0）。所以 stream 只能提供"第一个内容块何时到"这一个信息量，不能提供跨度或逐 token 节奏。
- `step/start` 的 key 必须是 `turn:step`：step 编号按 turn 重置，只按 `step` 建映射会跨轮碰撞，实测产出 −1932043ms 这类负 TTFT 假数。

未能分离的一项（转入 §9 待核实）：93% 的 step 内含 `tool/call` 行，无法确认 `step/end` 是否覆盖工具执行时间。有 tool 的 step 跨度 p50 = 6052ms、无 tool 的 p50 = 7949ms（反而更长，因为多为最终回答），说明工具时间不是跨度的主导项，但不足以证明它不在内。因此 DSH 的"采用口径"TPS 应视为**上界估计**并在 UI 标注。

<a id="historical-section-15"></a>
## 15. 第四遍独立复核：决策落定与 Codex item 跨度的落地依据（2026-10-03 晚，只读）

> **历史记录：本节含已被 §19 否证或由现行契约替代的结论/任务卡，不直接作为施工依据。** 阅读当前规则请回到 §1、§3–§5、§7–§11 与 §17。

本节由另一会话在 §14 之后独立复算，不新增/修改任何产品代码。与 §14 一致处只做固化，不一致处明确指出。

### 15.1 跨来源排名：用户已放行（§9、§11（旧第 2 项） 已同步改写）

三条硬约束，排版与 UI 必须照此实现：

> **2026-10-03 更新（§18 整合勘察报告后，约束本身不变，只是分组更简单）**：第一条里的分母已收敛为"一族 + 一个例外"——**请求总时长**（ZCode `duration_ms`、DSH `message.time − step/start.time`、OpenCode `completed − created`）与 **Codex 的生成窗口**（轮级 item 跨度）。"单独成组"从三组收为两组。第二条里"Codex 只有 82.6% 是单请求轮"不再是限制条件：单请求轮白名单已随 §16.5 作废，Codex 的样本按"能否拿到正 item 跨度"取，多请求轮照样入组。

- **口径必须先统一再比较。** 四源分母定义不同：ZCode `duration_ms`；DSH `message.time − step/start.time`；OpenCode `completed − created`（以上三源同属**端到端请求总时长**）；Codex 该轮 `agentMessage + reasoning` 的 item 跨度之和（**唯一例外：轮级，且只有生成段**）。排名视图**不得**把 Codex 的生成窗口与其余三源的请求总时长放进同一根柱，必须单独成组或明确标注。
- **图上必须带口径标签与样本量。** 排名天然诱导"谁快谁慢"的结论，而同族的 ZCode / DSH / OpenCode 采样单位并不相同（逻辑请求 / step / assistant 消息），Codex 更是轮级且只有生成段；再叠加 Codex item 跨度在 2026-09-28 之前基本缺失（§15.3，全历史 ≈72%）。缺样本显示"—"且不参与排名，不得当 0。
- **跨来源只在同一 `agent` 语义内比较。** 各源 agent 命名体系不同（ZCode `agent`；DSH `agentPreset` + `delegationDepth`；OpenCode `data.agent`；Codex `state_5.threads.source` / `thread_source`），**不建立跨来源的 agent 等价映射**；只在同一来源内按 agent 分组后横向排模型。

### 15.2 Codex 全量配对普查（238 个 rollout、866 MB）

| 指标 | 实测 |
| --- | --- |
| `task_complete` 总数 | 4103，其中带 `time_to_first_token_ms` **3658（89.2%）** |
| `token_usage_record` | 12660 行，覆盖 3664 个不同 `turn_id` |
| 有 `task_complete` 的轮次 | 3933 |
| 配对到**恰好 1** 条请求 | **3250（82.6%）** |
| 配对到 2–5 / 6–20 / 21+ 条 | 115 / 192 / 102，合计 **409（10.4%）** |
| 完全配不到请求记录 | **274（7.0%）** |
| `duration_ms <= time_to_first_token_ms` | 0（不变式成立，可作校验） |

**与 §14.2 不矛盾**：全局 82.6% 是单请求轮，是因为 auto-review/guardian 轮次数量压倒性多且几乎都是单请求；主代理（vscode）轮次少但每轮 11+ 次请求。因此 §13.2 的判断（Codex 的可信 TPS 样本被单请求轮占满）成立，无需改。

### 15.3 Codex item 跨度的真实来源是 `thread_history_1.sqlite`（**新增读取链路**）

§3/§14.2 要求用 `agentMessage`/`reasoning` 的 `started_at_ms`/`completed_at_ms`。必须写清楚：**这些字段不在 rollout JSONL 里**。全量扫描 238 个 rollout、866 MB 后确认：JSONL 中不存在任何 `*_at_ms` 字段，`response_item` 也只有 `type/id/content/...`，**没有任何时间**。真实载体是：

`~/.codex/thread_history_1.sqlite` → `thread_items(thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type, updated_at_ordinal, started_at_ms, completed_at_ms)` —— 34690 行 / 135 线程 / 2331 轮。

同库另有 `thread_turns(thread_id, turn_id, started_at, completed_at, duration_ms, ...)` —— 2501 轮（2470 completed / 18 failed / 12 interrupted / 1 inProgress），`duration_ms` 均值 115s、**最大 10395s（约 2.9 小时）**，可直接给出轮级墙钟并再次佐证"轮级时长含等待"。

`item_type` 实测取值（PascalCase，与 §14.2 判别式一致）：`reasoning` 14053、`commandExecution` 8446、`agentMessage` 8014、`fileChange` 1814、`userMessage` 1120、`mcpToolCall` 706、`webSearch` 235、`imageView` 157、`contextCompaction` 97、`collabAgentToolCall` 17、`subAgentActivity` 15、`sleep` 10、`dynamicToolCall` 5、`plan` 1。

**"覆盖 100%" 必须加时间限定**（本节对 §14.2 的唯一实质修正）：

| 口径 | 数值 |
| --- | --- |
| 全库 item 有 `started_at_ms` | 16368 / 34690（**47%**） |
| 旧时段 item（`created_at_ms <= 2026-09-28T01:00:57Z`） | 23253 行，有时间戳仅 **4931（21%）** |
| 新时段 `agentMessage` 正跨度 | 2129 / 2133（**99.8%**） |
| 新时段 `reasoning` 正跨度 | 5411 / 5415（**99.9%**） |
| 新时段有模型跨度的轮次 | 1720 / 1723（**99.8%**） |
| 全部轮次有模型跨度 | 1808 / 2501（**72.3%**） |

→ 准确表述是"**2026-09-28 之后的轮次 ≈99.8%，全历史 ≈72%**"。早于该切点的历史缺 item 时间戳，不能按 100% 宣传覆盖率；UI 的覆盖率标注必须**按来源 + 时间段**给出（见 P1.8 卡）。

**落地影响（§4 数据层要改）**：这不是"从现有来源多取两个字段"，而是**新增一条读取链路**——当前适配器从不打开 `thread_history_1.sqlite`。需要：发现与指纹（`size + mtime`，含 `-wal`/`-shm`，沿用 ZCode/OpenCode 既有写法）、`_sqlx_migrations` 版本守护、以及"该库是 rollout 投影"这一前提的失效处理（`thread_history_projection_state` 记录 `next_rollout_byte_offset`，投影可被重建，重建后 item 时间可能变化）。**§1 的"不需要新增采集链路"对 ZCode/DSH/OpenCode 成立，对 Codex 的 TPS 口径不成立**，按此修正。

**连接键**：`thread_items`、`thread_turns` 与 rollout 的 `token_usage_record` 都带 `turn_id` → 按 `turn_id` 连接即可；`rollout_ordinal` 100%（34702/34702）非空，可作第二键。**不要用 `item_id`**：它是 `msg_…` 形态，在 rollout 全量检索为 0 命中。

**隐私**：`item_json` 含正文（实测含完整回复文本）。只许取 `item_type`/`started_at_ms`/`completed_at_ms`/`turn_id`/`rollout_ordinal`；`item_json` 不解析、不入事件、不入索引、不入日志。与 §6 当初为 DSH 设计的窄读取同一标准（**该 DSH 窄读取已随 §16.7 改判作废，Codex 这一项不受影响、仍必须做**），需在 OpenCode 之外**新增一处隐私边界说明**。

### 15.4 更准的 agent 归因：`state_5.sqlite` → `threads`

§4 建议 Codex 的 agent 用 `session_meta.payload.source`。实测 `~/.codex/state_5.sqlite` 的 `threads` 表直接给出规范字段：`model`、`source`、`originator`、`thread_source`、`agent_role`、`agent_nickname`、`title`、`cli_version`。样例：`model = codex-auto-review`、`source = {"subagent":{"other":"guardian"}}`、`thread_source = guardian_review`、`title = "Guardian review"`。

这比在 rollout 里解析 `session_meta` 更省事，并直接支撑"各 agents 下的各模型"。代价是又多一处 sqlite 读取；建议与 §15.3 合并为同一张"Codex sqlite 附加源"卡（P1.0）。

### 15.5 ZCode 全列清单（实现直接可用）

`model_usage` 完整列（2026-10-03 快照，4079 行）：

`id, logical_request_id, attempt_index, session_id, turn_id, trace_id, span_id, assistant_message_id, parent_user_message_id, query_source, provider_id, model_id, variant, agent, mode, task_type, status, started_at, first_token_at, completed_at, duration_ms, time_to_first_token_ms, finish_reason, tool_call_count, input_tokens, output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, provider_total_tokens, computed_total_tokens, retry_count, retryable, cancelled_by_user, context_exceeded, error_type, error_code, error_message, raw_usage_json, provider_metadata_json`

- §3 的全部 ZCode 剔除规则都有对应列，无需猜字段；`status` 实测 `completed` 4037 / `error` 25 / `cancelled` 17。
- `first_token_at`（绝对时间，与 `time_to_first_token_ms` 同时非空 3170 行）**只在内部用于算分母**；TTFT 移出后（§16）它不作为产出字段，也不进 `perf_samples`。
- 覆盖复算：`duration_ms > 0` 4079/4079（100%）、`time_to_first_token_ms` 非空 3170/4079（**77.7%**）、`output_tokens > 0` 4036/4079（99.0%）。行数比 §14.4 的 4066 多 13，属正常增长。

### 15.6 DSH / OpenCode 独立复核结论

- **DSH**：最大会话（2.4 MB / 1039 帧 / 1940 行 / 0 坏帧）中 `step/start` 与 `step/end` 的 `data` 都是 `{turn, step}`，与 `assistant/message` 精确配对 **731/731**；`stream` 三种形态 `chunk|time`、`reasoning-chunks|text-chunks|time0|dt|texts`、`tool-call-chunks|time0|dt|id|name|args`；`dt` 元素数仅为 `outputTokens` 的 1/3–1/2（output 2875 / dt 931；output 505 / dt 279），且 `sum(dt)` 远小于首末 `chunk.time` 之差（893 vs 86；2294 vs 1369）→ **独立证实 §6 与 §14.6 的"dt 不能当逐 token 节奏、stream 只能当锚点"**。
- **OpenCode**：`completed − streamed` 118ms 而 `streamed − created` 2037ms，再次否证 `streamed` 为首 token；唯一可能提供更细时间的 `event` 表（列 `id, aggregate_id, seq, created, type, data`）本机 **0 行**，因此"无 TTFT 真值"在本机是**有界证据**而非推断。

### 15.7 §1 表格的两处数字修正

- ~~Codex TTFT 覆盖率：§2 写 97.8%~~ —— 全量 238 个 rollout（含 `archived_sessions`）实测 `task_complete` 4103 条、带 `time_to_first_token_ms` **3658 条 = 89.2%**。**该指标已随 §16 移出范围**，此处只保留为历史更正记录。
- Codex item 跨度覆盖：按 §15.3 改为"**2026-09-28 之后 ≈99.8%，全历史 ≈72%**"，不得写 100%。

### 15.8 任务卡增补（接 §13.5）

| 卡 | 内容 | 写入作用域 | 前置 |
| --- | --- | --- | --- |
| **P1.0** | Codex sqlite 附加源：`thread_history_1.sqlite`（item 跨度）+ `state_5.sqlite`（agent/model 归因）的发现、指纹（含 `-wal`/`-shm`）、`_sqlx_migrations` 版本守护、按 `turn_id` 连接、`item_json` 窄读取 | `src/codex-thread-store.js`（新增）、来源测试 | P0.2 |
| **P1.7** | 跨来源排名视图：按 §15.1 三条约束实现（OpenCode 单独成组、口径标签 + 样本量、只在同来源 agent 分组内排模型） | `public/app.js`、`public/perf-stats.js`、`test/app-*.test.js` | P1.6 |
| **P1.8** | Codex 覆盖率分时段标注：UI 与文档必须区分"2026-09-28 之后"与"全历史"，不得展示单一 100% | `public/app.js`、`docs/` | P1.7 |

### 15.9 状态更新

- §13.4 的 shell 阻塞**已解除**：会话切到「完全权限」后 `node v24.19.0` 可正常运行，§14 与 §15 全部数字均如此只读跑出。探测脚本写在本机临时目录、**未进入仓库**；四个来源的库与日志全程只读，未改动。
- §13.6 仍未登记：`docs/00-index.md` 与 `docs/02-tasks.md` 尚未挂本计划指针。

<a id="historical-section-16"></a>
## 16. 范围与口径变更：TTFT 全部移出 + DSH 改判不读 `stream`（2026-10-03，用户决定）

> **历史记录：本节含已被 §19 否证或由现行契约替代的结论/任务卡，不直接作为施工依据。** 阅读当前规则请回到 §1、§3–§5、§7–§11 与 §17。

**决定一**：四个来源一律**不产出、不展示首 Token 时延（TTFT）**。本功能只交付**输出吞吐（TPS）**——按 `(来源, agent, 模型)` 分组的分位数与样本量。本文标题、目标与 §1、§3、§4、§6、§7、§9、§10、§11 均已按此改写。
**决定二**：DSH **完全不读 `data.stream`**，分母改用 `step/end − step/start`（落地条款 §16.7，量化依据 §16.6）；§6 的窄读取方案与隐私承诺撤回**一并作废**，`src/dsh-usage.js:236` 原注释保持不动。

### 16.1 作废清单

| 位置 | 原内容 | 现状 |
| --- | --- | --- |
| 标题 / 目标 | "时延与吞吐（TTFT / TPS）"、"首 Token 时延与输出吞吐" | 改为"输出吞吐指标（TPS）" |
| §1 表格 | 四行的 TTFT 证据与覆盖率 | 删除，改为"吞吐分母 `gen_ms`"列 |
| §2、§13–§15 | 大量 TTFT 覆盖率、p50/p90、字段语义 | **只作过程记录**，不得作为待实现项引用；§2 顶部已加横幅 |
| §3 | "**TTFT**：ZCode、Codex 采用上游显式字段…" | 删除，改为"**TTFT：不做**" |
| §4 `perf_samples` | 字段列表含 `ttft_ms` | **删除该列** |
| §6 | "TTFT = 首块 − `step/start`，是 `stream` 的唯一不可替代用途" | 先改为"窗口起点锚点"，随后**整节作废**：用户改判 B，`stream` 一律不读（§16.7） |
| §7 | "复用 bar-list 表达 p50 TTFT / p50 TPS" | 改为只表达 p50 / p90 TPS 与 n |
| §9 | Codex `time_to_first_token_ms` 语义列入待核实 | 移出待核实清单（不再影响产出） |
| §10 / §11 | "P1 结束就能看 ZCode 的 TTFT/TPS"、"stream 许可用于 TTFT" | 改为只提 TPS；DSH 一项随 §16.7 改判为不读 `stream` |

### 16.2 取消 TTFT 本身只减一个产出字段（DSH 的额外简化见 §16.7）

单看"取消 TTFT"这个动作，它**不减少读取链路**，只减少一个产出字段：

- **ZCode**：`time_to_first_token_ms` 仍要读——它就是 `gen_ms` 的减数。少的是"把它显示出来"。
- **DSH**：本节原判定"`stream` 仍要读（方案 A），用途收窄为分母起点锚点"——**已被 §16.7 的改判推翻**。B 路径下整枝 `stream` 不读。
- **Codex**：`thread_history_1.sqlite` 仍要读，item 跨度本来就是分母（§15.3）。
- **OpenCode**：本来就拿不到真值，无变化。

因此 §15.3 的"新增读取链路"、§15.8 的 **P1.0 / P1.8** 卡、§13.5 的 **P1.1–P1.6** 卡继续有效；只有 §7 的解构目标与 §13.5 的 UI 卡内容从"TTFT + TPS"收为"TPS"。**§6 的隐私承诺撤回不再需要**（§16.7）。

### 16.3 仍然生效的三个口径约束

- **分母族已由 §18 收敛**：ZCode / DSH / OpenCode 是端到端**请求总时长**（含首 Token 等待），Codex 是**生成窗口**（轮级，只有生成段）。排名按这两组分柱，不互相换算。本节以下两条仍是硬约束。
- **同族不等于同粒度**：ZCode 分母是单请求、DSH 是单 step、OpenCode 是单条 assistant 消息，Codex 是**轮内多个请求的跨度之和**（`perf_samples.window` 分别为 `request` / `step` / `message` / `turn`）。同柱显示时 Codex 必须额外标"轮级"，否则读者会把轮吞吐当请求吞吐。
- **Codex 分母只在 2026-09-28 之后可靠**（≈99.8%；全历史 ≈72%），UI 必须按来源 + 时间段标注覆盖率（P1.8）。

### 16.4 一个可选的进一步简化（**已采纳：改判 B**，2026-10-03 用户确认）

既然 TTFT 不再产出，DSH 也可以**完全不读 `stream`**，分母改用纯元数据 `step/end − step/start`。代价：DSH 变成"请求总时长"口径、与 OpenCode 同类，四源里只剩 ZCode、Codex 是生成窗口口径。收益：`src/dsh-usage.js:236` 的现有隐私承诺原样保留，不需要任何文档边界改写。**本节原写"未采纳、默认保留 A"，用户 2026-10-03 确认改判 B**，落地条款见 §16.7，量化对比见 §16.6。

### 16.5 取消 TTFT 真正省掉与作废的东西（对 §16.2 的补充）

§16.2 的"不减少任何一条读取链路"要加一条例外，其余结论不变：

- **Codex 不再需要 `task_complete`。** 它是 rollout JSONL 里唯一承载时延的事件，而 TPS 的分子来自 `token_usage_record`、分母来自 `thread_items`，两边都自带 `turn_id`。因此 §14.5 的"在 `task_complete` 时定档"可以去掉，rollout 扫描只为 token 事件保留。**这是唯一一条因取消 TTFT 而消失的输入。**
- **`perf_samples` 少一列**（`ttft_ms`），连带 v12 迁移、四路汇总、`summaryFields` 白名单与 §7 的列宽/对比度重排各少一处——parity 校验面从"两个指标 × 四份实现"收为"一个指标 × 四份实现"。
- **「仅单请求轮次」白名单作废**（§3 剔除规则、§10 P2 已按此改写；§13.2 第三条与 §13.5 的 P3 卡里仍留着旧措辞，实施时以 §3/§10 为准，不改写它们的历史记录）。白名单是为"每轮一个 TTFT、每轮一次请求"的旧配对口径服务的；分母换成 item 跨度之和后，多请求轮（全量 409 条 = 10.4%，§15.2）恰恰是真实主代理的工作轮，剔除它们只会让可信样本被 auto-review / guardian 的单请求轮占满——那正是 §13.2 担心的后果。**改由 `agent` 维度分列呈现**，而不是用剔除来规避。
- **恢复成本要写清**：日后若加回 TTFT，需要 `perf_samples` v12→v13 迁移 + 再一次 `UPDATE source_files SET size = -1, mtime_ms = -1` 全量重索引 + 撤回 `src/dsh-usage.js:236` 的 `stream` 承诺 + 同步两份文档边界描述。所以取消 TTFT 省的是"一次重索引 + 一列契约"，不是无痛可回补的开关。

### 16.6 §16.4 的量化对比（复用 §14.6 全量试算，已据此拍板）

| 项 | A：读 `stream` 锚点（原默认，**已弃**） | B：不读 `stream`（纯元数据，**已采纳**） |
| --- | --- | --- |
| DSH 分母 | `step/end.time − 首个内容块 time` | `step/end.time − step/start.time` |
| TPS p50 / p90 | 136 / 258（2886 样本，荒谬样本待 P0 复核） | 73 / 155（2879 样本，**0 荒谬**） |
| 所属口径族 | 生成窗口（与 ZCode、Codex 同族） | 请求总时长（与 OpenCode 同族） |
| 隐私与文档 | 需撤回 `:236` 关于 `stream` 的承诺，并同步改 `docs/data-sources/dsh.md`、`docs/10-data-sources.md` | 现有承诺原样保留，**零文档改动** |
| P2 卡写入作用域 | `src/dsh-usage.js` + 2 份文档 | 仅 `src/dsh-usage.js` + 其测试 |
| 残留不确定性 | `step/end` 是否含工具执行时间未分离（§9） | 同上，且分母额外含首 Token 段，数值更保守 |

两口径比值 ≈0.5–0.7，与"首块偏移 / step 跨度"的量级一致（首块偏移实测区间 972–25149ms，§6）。本轮复核当时倾向改用 B（0 荒谬样本更稳、不必动任何隐私边界描述；可比性损失被 §15.1 的"按口径分组成柱"吸收——B 让 DSH 与 OpenCode 合成同一根柱子，排名视图反而少一组），但当时维持默认 A 并等用户一句话；**用户已于 2026-10-03 确认采纳 B**，落地条款见 §16.7。**注：A 与 B 此后均被 §18.2 的第三个选项 C（`message.time − step/start.time`）取代——C 同样不读 `stream`、同样 0 荒谬样本，且不含 step 内工具执行段；本表的 A/B 对比自此只作决策过程记录。**

### 16.7 DSH 改判 B 的落地条款（2026-10-03 用户确认，覆盖 §6 全部内容）

1. **取用范围**：`assistant/message` 的 `data.usage.{inputTokens,outputTokens}`、`data.turn` / `data.step` 与其 **`row.time`**、`step/start` 的 `data.turn` / `data.step` 及 `row.time`、`request/header` 的 `data.header.config.{provider,model}`。`data.stream` **整枝不取用**（`time`、`time0`、`dt`、`texts` 一律不遍历、不进样本对象、不落索引、不打日志）。**其中 `step/end` 与 `message.time` 的取舍见 §18.2：分母已改用 `message.time − step/start.time`，因此本条还要取 `assistant/message` 的 `row.time`。**
2. **要说清的边界**：现有 `readDshSessionRows` 是整行 JSON 解析，`stream` 枝本来就会被解出来——B 省的是"取用与实现窄读取清单"，**不省解压与解析成本**（§10 风险里的"DSH 解压成本"不变）。若日后要连解析都窄化，那是独立优化项，不属于本计划。**另记**：`stream` 里带绝对 `time` 的 chunk 时间轴、以及 `text-chunks` 的 `time0 + dt[]`，是将来做"逐片解码 TPS"唯一可能的素材（其存在与形态已由勘察报告核实）——本期一律不取用，也不要因为"将来可能用得上"就提前读它。
3. **隐私承诺**：`src/dsh-usage.js:236` 的注释**原文保留、一字不改**；`docs/data-sources/dsh.md`、`docs/10-data-sources.md` 的"读取与数据边界"**不做任何改写**。§6 的允许/禁止 key 清单与"三处同步改写"整节作废。
4. **样本定义**：`window = 'step'`；`gen_ms = message.time − step/start.time`（**§18.2 取代本条的 `step/end` 版本**）；分子 = 该 step 的 `outputTokens`；配对键必须是 `turn:step` 复合键（step 编号按 turn 重置，§6 末与 §14.6 的这条约束**仍然有效**——错键的后果是取错端点，同样出假数）。三者配不齐 → 无样本，不补零。
5. ~~**预期基线**：2879 样本、TPS p50 73 / p90 155、荒谬样本 0。~~ —— **已被 §18.2 取代**：改口径后基线为 **2929 样本、p50 97.2 / p90 188.9、>1000 tok/s 荒谬样本 0**（总量比 **104.6**）。P0 复算以这组数为基准；若 p50 明显偏离，先查 `turn:step` 配对而不是查上游。
6. **方向性标注改了**：DSH 的 TPS 因分母含首 Token 等待而是**偏保守值**；§14.6 末段与 §15.9 里"应视为**上界估计**"的措辞只对当时的 A 口径成立，UI 与文档**不得沿用**。**本条随后又被 §18.2 修订**：改用 `message.time` 后分母不再含 step 内工具执行段，方向性表述以 §9 待核实条为准（"请求总时长（含首 Token 等待）"）。
7. ~~**口径族收为两族**：生成窗口 = ZCode、Codex；请求总时长 = DSH、OpenCode。~~ —— **已被 §18 取代**：请求总时长 = ZCode、DSH、OpenCode；Codex 单独为生成窗口（轮级）。排名视图按这两组分柱（§15.1），不互相换算。
8. **卡片影响**：§10 的 P2 与 §13.5 的 **P2 卡**写入作用域缩为 `src/dsh-usage.js` + 其来源测试，两份文档已从该卡移除（P0.2 仍会改 `docs/10-data-sources.md`，那是口径提炼，与读取边界无关）。§13.5 的 P1.1–P1.6、§15.8 的 P1.0 / P1.7 / P1.8 **均不受本次改判影响**。
9. **本次改判没有取消的东西**：Codex 的 `thread_history_1.sqlite` 新增链路与 `item_json` 窄读取（§15.3）仍然要做——那是分母的唯一载体，与 TTFT 无关。

<a id="historical-section-18"></a>
## 18. 整合 `duration-tps-survey` 勘察报告（2026-10-03，第五遍独立复核）

> **历史记录：本节含已被 §19 否证或由现行契约替代的结论/任务卡，不直接作为施工依据。** 阅读当前规则请回到 §1、§3–§5、§7–§11 与 §17。

> **原文件 `docs/duration-tps-survey.md` 已于 2026-10-03 并入本节后删除**（它当时尚未被 git 跟踪；其全部事实、冲突裁决与实现坐标都落在本节，没有内容丢失）。删除理由：它与本计划在五处口径上不同，两份并存会被后来者误引。此后的同主题勘察稿一律按 §12 的同一流程处理。

`docs/duration-tps-survey.md`（2026-10-03 并入本节后删除）是并行产出的第二份勘察报告。它与本计划在**五处**不同（ZCode / DSH / Codex 三处分母、数据层方案、聚合指标）。本节把它的**事实**逐条复算并吸收、把**冲突**逐条裁决、把它的**实现坐标**并入施工参考。**已按本节裁决改写 §1、§3、§4、§11（旧第 2 项）、§15.1、§16.3、§16.7、§17.1、§17.2、§17.7**；用户已拍板的三件事（不读 `stream`、不做 TTFT、允许跨来源排名）**一条都没有动**。

### 18.1 它带来的、本计划原先没有的事实（全部已独立复算）

| 事实 | 报告原值 | 本轮复核值（66 会话 / 62.9 万行级只读扫描） | 结论 |
| --- | --- | --- | --- |
| OpenCode `streamed` 当生成窗口的荒谬率 | 317/504 = 62.9%，最高 186 万 tok/s，中位 1786 | **332/525 = 63.2%**，最高 **1,861,000**，中位 1806.8 | **完全复现**，否证成立 |
| OpenCode 端到端 TPS | p50 ≈ 51 / p90 ≈ 128 | p50 **54.5** / p90 **127.7**（n=526） | 复现 |
| DSH 配对率 | 2851/2851，零负值 | **2929/2929** 挂到 `step/start`，**0 负值** | 复现（样本随时间增长） |
| ZCode 总时长 | 全量 4053 行，均值 31.5s | 4150 行，均值 **32.1s** | 复现 |
| project-log 无计时字段 | 不做 | 采纳 | 已写进 §4 与 §18.6 |
| 代码坐标 | `zcode-usage.js:138`、`opencode-usage.js:58`、`usage-core.js:1147`、`dsh-usage.js:264`、`usage-store.js:409`、`public/usage-fields.js` | **逐条读过源文件，全部准确** | 并入 §18.6 |

### 18.2 冲突一（最重要）：DSH 分母 —— 报告找到了本计划漏掉的第三个选项

§16.4 把选择框成"A 读 `stream` 锚点 / B 用 `step/end`"，**漏掉了报告用的 `message.time`**。三者实测（只读，66 个会话、2953 个 step、2931 条 assistant/message）：

| 选项 | 分母 | 需读 `stream`？ | 含 step 内工具执行？ | 分母 p50 | TPS p50 | >1000 tok/s 荒谬 |
| --- | --- | --- | --- | --- | --- | --- |
| 原 A | `首块time − step/start` | **要** | 否 | — | 136 | 待复核 |
| 原 B（§16.7 采纳） | `step/end − step/start` | 否 | **是** | 6173ms | 73.1（总量比 52.6） | 0 |
| **报告的 C** | `message.time − step/start` | **否** | **否** | **4517ms** | **97.2**（总量比 104.6） | **0** |

拆开 step 内部结构就能看到差别：收尾段 `step/end − message.time` 的 p50 只有 **146ms**，但 p90 = **4965ms**，其中 **1598/2930 = 54.5% ≥ 100ms**——也就是说 B 把这段工具执行时间算进了模型吞吐，而 C 把它排除在外，且**同样不需要读 `stream`**、**同样是 0 荒谬样本**。

**裁决：DSH 改用 C（`message.time − step/start.time`）。** ① 用户"不读 `stream`"的决定**原样保留**（C 是纯元数据），这不是推翻用户决定，而是找到了更好的实现方式；② §16.7 采纳 B 的两条理由（0 荒谬、不动隐私边界）C 全部满足；③ B 会系统性高估分母，与 §14.6 已记录的"step 内工具时间未分离"是同一个问题，C 直接消掉了它。
**代价**：口径族由"生成窗口"变为"请求总时长"（含首 Token 段），与 §18.3 的 ZCode 一起归入同一族。

### 18.3 冲突二：ZCode 分母 —— 建议一并收进"请求总时长"族

报告用裸 `duration_ms`（端到端，含首 Token 段）；本计划用 `duration_ms − time_to_first_token_ms`（生成窗口）。两者都成立，但**取消 TTFT 之后"扣掉首 Token 段"失去了服务对象**——它原本是为了让 TTFT 段与生成段不重叠，现在 TTFT 不产出了，扣掉它只会让 ZCode 与其他源不可比。实测同一批数据（n=4107）：端到端 **p50 34.5 / p90 97.9 / 总量比 37.1**。

**裁决：ZCode 分母改用 `duration_ms`（缺失回退 `completed_at − started_at`）**，与 DSH、OpenCode 同族。这样**四源里三源同口径**，跨来源排名只需隔离 Codex 一源（§15.1 的分柱约束从"两族各两源"简化为"一族三源 + 一个例外"）。

### 18.4 冲突三：Codex 分母 —— 不采纳报告的做法

报告写"Codex 真值（`task_complete.duration_ms`）"，并计划把 turn 时长挂到该轮的多个事件上（"第一遍建 `turn_id → duration_ms` 表，第二遍挂到现有增量事件上"）。**这条不能采纳**，本计划有三处独立证据：

- §2 反例：`gpt-6.1-sol` 18 个样本平均 `duration_ms` = **806184ms（≈13 分钟）**，`gpt-6-luna` 平均 1694462ms——它是**轮级墙钟**，含工具执行与人审等待。
- §14.2：用它做分母把 `gpt-6.1-sol` 压到 ≈**23 tok/s**，item 跨度口径 ≈**68 tok/s**。
- §15.2：主代理轮次平均含 **11 次以上**请求，把轮时长挂给每个请求 = 同一段分母被重复计入多次输出。

**裁决：维持 item 跨度口径**，Codex 是唯一"生成窗口（轮级）"来源，UI 必须标"轮级"（§16.3）。
**吸收报告的一点**：`task_complete` 每轮一条，可作为**轮总墙钟**单独成一个指标（"轮耗时"），与 TPS 分列——它回答"这一轮我总共等了多久"，不回答"模型多快"。因此 §16.5 说的"Codex 不再需要 `task_complete`"要打个折：**做 TPS 不需要，做轮耗时需要。**

### 18.5 冲突四：数据层方案

报告把 `duration_ms` 加进标准事件（`events` 表加列、四适配器透传 `events[]`）；本计划新建 `perf_samples` 表。**维持 `perf_samples`**（§4 已记录理由：`events` 一行是一次 token 增量、与"一个请求一行"粒度不同；加列会牵动 29 列插入语句、`COST_EVENT_COLUMNS` 与三路汇总）。报告里可吸收的是**迁移写法与坐标**：`insertEvent` + `ALTER TABLE` + `UPDATE source_files SET size = -1, mtime_ms = -1` 的先例（v11 迁移在 `src/usage-store.js:409`）正是 §4 要求的写法。

### 18.6 实现坐标（报告提供、已逐条核对源文件）

| 来源 | 现状（丢弃计时字段的位置） | 需改 |
| --- | --- | --- |
| ZCode | `src/zcode-usage.js:138` 遍历 `model_usage`；`:95` 只取 `completed_at` | 同轮取 `duration_ms`（回退 `completed_at − started_at`） |
| OpenCode | `src/opencode-usage.js:58 timestampMsFor` 先取 `completed`、`created` 仅作回退 | 需**同时**取 `created` 与 `completed` 做差 |
| Codex | `src/usage-core.js:1147` / `:830` / `:1518` 只认 `event_msg/token_count` | 新增 `thread_history_1.sqlite` 链路（§15.3）；`task_complete` 只用于轮耗时 |
| DSH | `src/dsh-usage.js:264 streamDshSessionEvents`，rows 已全量在内存 | 建 `turn:step → step/start.time` 索引，挂 `message.time − start` |
| 索引 | `src/usage-store.js:409`（v11 迁移先例） | v12 新增 `perf_samples` |
| project-log | 无任何计时字段 | 不出样本，UI 显示"—" |

### 18.7 聚合指标：报告建议的"总量比"并入为第二个指标

报告推荐 TPS 用 `Σoutput / Σ时长` 而非单次平均。**两者回答不同问题，本计划两个都出**（已写进 §3 与 §17.2）：

| 指标 | 定义 | 回答 |
| --- | --- | --- |
| **p50 / p90**（主） | §17.2 nearest-rank 单样本分位 | "典型的一个请求有多快" |
| **总量比**（辅） | `Σ output_tokens / (Σ gen_ms / 1000)` | "这段时间整体产出效率" |

实测两者**不可互换**：DSH(C) p50 **97.2** vs 总量比 **104.6**；ZCode p50 **34.5** vs 总量比 **37.1**；DSH(B) p50 73.1 vs 总量比 52.6（差异方向相反，因为长请求在总量比里权重更大）。**UI 主数字用 p50**（与看板其余分位口径一致），总量比作次要数字并在 tooltip 说明差异；文档不得只给一个数就称"这个模型的速度"。

### 18.8 本次整合对全文的改写点

| 位置 | 改动 |
| --- | --- |
| §1 表格 | ZCode 分母改 `duration_ms`；DSH 分母改 `message.time − step/start`；族说明改为"一族三源 + Codex 例外" |
| §3 | `gen_ms` 改名为"请求时长"并同步改写；TPS 段增加总量比；聚合量段增加辅指标 |
| §4 | 补 project-log 无计时字段、不出样本 |
| §11（旧第 2 项） / §15.1 / §16.3 | 分柱约束由"两族"改为"一族三源 + Codex 例外" |
| §16.7 | 第 1、4、5、7 条标记被 §18 取代（**`stream` 禁令与隐私条款不变**） |
| §17.1 / §17.2 / §17.7 | 取值表、分位与总量比定义、验收基线同步更新 |

### 18.9 当时的确认事项（历史记录，已由现行方案取代）

以下是当时的推荐与确认清单；当前不再作为待批准事项。现行读取/统计契约已经扩展，不能仅回退两行就改变口径，须同步方法版本、来源解析、覆盖率、API 和测试。

1. **DSH 用 `message.time`（C）** —— 依据最硬（0 荒谬 + 不含工具执行段 + 仍然不读 `stream`），建议直接定。
2. **ZCode 改端到端口径**（不再扣首 Token 段）—— 好处是三源同口径、跨来源可比；若你要"纯模型生成速度"，改回 `duration_ms − time_to_first_token_ms` 即回到两族。
3. **Codex 保持 item 跨度 + 单列"轮耗时"** —— 不建议采纳报告的 `task_complete.duration_ms` 做分母（§18.4）。

