# 模型输出吞吐指标（TPS）计划

更新：2026-10-08。状态：**已实施，TPS G4通过最终独立审核**，见[主审裁定](../validation/2026-10-04-perf-metrics/20261004T035100/handoffs/M8.3-G4-主审最终复核-20261008.md)。指标与行为规范为 §1、§3–§5、§7–§11 与 §17；逐卡施工、文件归属和交接见已完成的[Implementation Plan](2026-10-04-model-tps-implementation-plan.md)。原 §2、§6、§13–§16、§18 的调查和旧任务卡已移入[历史调查归档](../archive/2026-10-04/model-tps-investigation-history.md)。§19 是 2026-10-03 的历史诊断，不作为当前阻塞或永久数值基线。

目标：在现有历史数据上算出**各来源（渠道）× 各代理（agent）× 各模型**的输出吞吐（TPS），按 `(来源/渠道, 代理, 模型)` 分组呈现分位数与样本量，并明确标注每个来源的分母口径差异。**不产出、不展示任何首 Token 时延（TTFT）。**

## 1. 结论

**四源功能已交付并完成最终审核。** ZCode、DSH、OpenCode提供请求端到端TPS，Codex提供轮级item时窗TPS估计，两种指标分组展示。原施工顺序及调查过程保留为历史，不恢复为尚未实施状态。

四源已有的历史文件包含可用计数和时间元数据。**Codex 的 `event_msg/item_completed` 也带 `started_at_ms`、`completed_at_ms`，JSONL 是首选跨度来源**；§15.3 关于“JSONL 无时间字段、SQLite 是唯一载体”的结论已被 §19 否证。`thread_history_1.sqlite` 降为可选校验/补缺来源，`state_5.sqlite` 仅可补充代理身份，不作为历史轮次模型的优先来源。

| 来源 | 粒度 | 观测时长 `duration_ms` | 输出分子 | 当前判定 |
| --- | --- | --- | --- | --- |
| ZCode | `model_usage` 请求尝试行 | `duration_ms`；缺失时用 `completed_at − started_at` | `output_tokens` | 请求端到端 TPS；只将成功、无重试等合格样本纳入分布 |
| DSH | 同会话、同 `(turn, step)` 的一次请求 | `assistant/message.time − step/start.time` | `data.usage.outputTokens` | 请求端到端 TPS；不取用 `data.stream`，不包含消息落盘后的 step 收尾段 |
| OpenCode | 一条 assistant 消息 | `time.completed − time.created` | v2 的 `tokens.output + tokens.reasoning` | 请求端到端 TPS；沿用 v2 版本守护，不使用 `streamed` 作分母 |
| Codex | 同 `(home_id, thread_id, turn_id)` 的一轮 | 去重后 `AgentMessage + Reasoning` 的完整正 item 跨度之和 | 去重请求的 `usage.output_tokens` 之和 | **轮级 item 时窗估算**；分子与时窗是否完全对应仍待验证，不称“纯生成速度” |

首轮只读复核中，三源端到端 TPS p50 约为 ZCode 34.5、DSH 97.4、OpenCode 54.5 tok/s；ZCode 应用现行过滤规则后 p50 约 34.8、总量比约 40.0。这些数字是日期快照，**不是跨模型排名或永久验收常量**。

Codex 当前“正输出轮次中可配到正跨度”的全历史比例约为 JSONL 56%、SQLite 49%，近期约 95%；这是**有跨度率，不是最终有效样本率**。必须进一步扣除不完整跨度、未结束轮次、模型冲突等情况，按来源和当前筛选范围实时计算覆盖率（§17.5、§19）。

继续保留范围约束：不产出 TTFT；DSH 不取用 stream；缺失不补零；历史排名可展示，但口径、样本量、供应商、推理配置和覆盖率必须可见。Codex 估算与三源端到端 TPS 不进入同一排名池。

## 2. 历史调查记录（已归档）

原 §2 的调查与旧决策保存在[历史调查归档](../archive/2026-10-04/model-tps-investigation-history.md#historical-section-2)；当前施工以本计划的现行契约为准。

## 3. 指标定义与统计口径

- **观测时长**统一命名 `duration_ms`，单位毫秒；历史章节中的 `gen_ms` 是旧名称。用 `timing_kind = request_e2e | item_span_estimate` 明确含义，不能仅由一个字段名判断是不是生成时间。
- **单样本 TPS** = `output_tokens × 1000 / duration_ms`。两值都必须存在、为安全整数，且输出和时长均大于 0。缺字段、真 0、负数分别保留诊断；不从消息正文估算 token。
- **主数字 p50，辅助 p10 / p90 / 样本数 n**。p10 表达慢的一端，p90 表达快的一端；时长的 p90 才表达长等待的一端。不要把 TPS p90 称为“尾部慢请求”。分位算法统一为 nearest-rank（§17.2）。
- **总量比** = `Σoutput_tokens × 1000 / Σduration_ms`，使用与分位数完全相同的合格样本集合。它是按观测时长加权的平均 TPS，不是实际日历时间吞吐；并发请求的时长会相加，因此文案使用“合并样本 TPS”，不用“这段时间整体产出效率”。
- **分子语义**用 `token_scope` 显式记录。Codex 的 reasoning 是 output 的子集，不能再加一次；OpenCode v2 的 output 与 reasoning 并列，需要相加。ZCode/DSH 是否完整计入推理仍须按来源版本确认，未确认时用 `reported_output_unspecified`，不可借“分母同族”宣称完全可比。
- **过滤**：缺失/非正计数、缺失/非正时长、时间矛盾、来源失败/取消/重试（按来源证据）、Codex 部分跨度、轮内模型冲突进入诊断，不进入默认统计。进行中的请求/轮进入 pending。成功且完整的多请求 Codex 轮照常统计；未知代理独立分组，不自动称为主代理。
- **取消两条旧规则**：不比较观测时长与首 Token 等待的大小；Codex 累计时窗超过 300 秒只标记 `LONG_WINDOW`，不据此推断工具等待，也不因此剔除。实际失败/未完成/缺失才是剔除证据。
- **跨度完整性**：先按 item 身份去重，再判断所有目标 item 的起止字段是否齐全且结束晚于开始。仅有部分正跨度时，不允许用整轮输出除以残缺时长。新增重叠跨度视为方法异常；本轮未观察到目标 item 重叠，首版不悄悄改用区间并集代替求和。
- **时间范围**：沿用现有时区和范围过滤器，以样本 `ts_ms` 归属；不按天拆分 token，不按窗口重叠比例分摊输出。跨范围边界只作为查询期说明，不持久化成随筛选变化的 sample flag。
- **分组和排名**：主层级为来源/渠道 → 代理 → 模型；不同 `model_provider`、`reasoning_effort`、`timing_kind`、`token_scope` 保留独立子组。`n < 20` 照常展示但不排名；该门槛只是 UI 提醒，不是统计置信度保证。模型名表示历史记录的请求配置，不能证明服务端实际物理模型。

## 4. 数据层设计

**新增 `perf_samples`，保持性能观测与现有 token 增量 `events` 分离。** `perf_samples` 每行表示去重后的一个请求/轮候选观测，允许计时缺失和诊断行；只有通过筛选的行贡献 TPS。这样覆盖率不会因“无时长就不建行”而被人为抬高。

首批三源预计在 v12 建表；实施时以实际 schema 版本为准。候选字段：

`sample_key, source_path, source_kind, home_id, channel, agent_kind, agent, session_id, turn_key, model, model_provider, reasoning_effort, model_evidence, window, timing_kind, timing_source, token_scope, status, ts_ms, window_start_ms, window_end_ms, duration_ms, output_tokens, input_tokens, request_count, item_count, timed_item_count, sample_flags, diagnostic_reason, method_version`

- `sample_key` 为原始身份元组的规范序列化，不能直接拼接未转义的 `:` / `#`；唯一性含来源实例。字段缺失用 `NULL`，真实 0 用 0；`agent_kind = main | subagent | unknown`，缺名称用空串。`price_version` 不属于性能方法版本，本表不复用成本版本列。
- `source_kind` 保存规范来源 kind；现有 `main/jetbrains/extra/codex` 通过现有来源识别映射到 Codex，渠道显示名不充当来源证据。`home_id` 采用规范化后的来源实例身份，避免同一路径的别名重复导入。
- **首批存储**：`perf_samples` 用 `sample_key TEXT PRIMARY KEY`，`source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE`；表用 `STRICT`。身份、分组、口径、状态、原因和版本列用 `TEXT`，时间戳、时长、token、请求/item 数及 `sample_flags` 用 `INTEGER`；缺失数值允许 `NULL`，`sample_flags` 默认为 0，不存浮点 TPS。ZCode/OpenCode 以数据库、DSH 以会话文件为重建单位，每个候选由一个 `source_path` 归属。
- **首批失效**：源文件**被删除**时外键级联删除候选；源文件**内容被替换**时，现有 `replaceFile()` 会更新 `source_files` 行而不会触发级联，必须在同一事务内显式删除该 `source_path` 的旧候选并写入新候选。事务失败回滚旧样本，重复同步不得增加样本。ZCode/OpenCode 继续把主库和 WAL 的变化纳入现有来源指纹。
- **Codex 阶段**：P4.0 再新增 `perf_sample_sources(sample_key, source_path, role)` 依赖表及迁移，外键分别指向样本和来源文件；另用 `perf_rollout_threads(source_path, home_id, thread_id)` 定位尚未形成有效样本的 rollout。跨 rollout 的同一轮须登记所有输入文件；替换/删除前收集受影响的 `(home_id, thread_id)`，用该线程剩余全部 rollout 重建。不能只依赖最后一条 token 所在文件；依赖、候选和源指纹在同一完整发布中保持一致。
- `state_5.sqlite` / 可选 history 补缺如被启用，必须独立纳入性能专属指纹和依赖，主库与 WAL 都参与变更检测；附加库不作为普通用量 `source_files` 行，避免改变 Codex 限额来源资格。不能因为 rollout 未变就跳过附加源更新，也不能将 SQLite 投影行与 JSONL 当作两套样本相加。
- **方法版本**：首版 `method_version = tps-v1`；解析/筛选/token 语义改变时更新方法版本并重索引。只修改显示小数位或分位参数，可以基于已保存的原始观测重新聚合。
- **迁移**：当前 `STORE_SCHEMA_VERSION = 11`，首批预计 v12；实施时再次核对版本。使用字面量落点，建表和索引后执行**无来源 WHERE 限制**的 `UPDATE source_files SET size = -1, mtime_ms = -1;`，让已有三源重新提取候选。P4.0 按实施时的下一版本迁移依赖表并重建 Codex；并行功能若已占用版本号则顺延，不覆盖已有迁移。
- **发布**：重建中保持上一个完整性能快照，或显示“索引重建中”；不把部分重建结果标为 ready。`meta.state = rebuilding | ready | degraded`，`indexVersion` 与事件快照保持同一次发布的版本。
- **project-log** 没有计时字段，不生成性能观测；`coverage.unsupportedSources` 记录来源可用但性能不支持，UI 显示“—”，不按 0 TPS 排名。

性能候选与依赖表不保存回复、推理正文、工具参数、工具结果或 `item_json`。JSONL/zstd 仍是整行解析；这里限制的是字段取用和持久化，不宣称已实现选择性 JSON 解码。

## 5. 聚合、API 与冻结快照

性能汇总统一为 `summary.perf = { groups, coverage, meta }`，不混入现有模型用量的 `total`。用户可达的两条生产汇总路径是 `summarizeUsage(report)`（CLI JSON 与完整报告 API）和 `UsageStore.summarize()`（常规看板、摘要 API 与索引 CLI）。两者使用同一候选过滤、分组身份和统计函数；SQLite 取出原始整数对，不独立实现百分位。

共享统计和标志常量放在 `src/perf-stats.js`，不依赖 DOM；两条生产路径导入同一实现。`summarizeUsageIndex(index)` 与 `public/app.js` 导出的 `summarize(report)` 目前只被测试直接调用，可继续检验既有用量汇总，首版不要求它们自行计算 perf。现有 `test/three-path-parity.test.js` 保持原用量字段的 parity；性能另以相同 fixture 对两条生产路径、两个 API 和冻结快照做一致性验证。

- **页面入口是 `/api/usage`**（`public/app.js` 的 `loadUsage`，`src/server.js:686` 及 `:746`），不是只有 `/api/summary`。两端点返回相同 perf 契约；`view=dashboard` 仍包含分组与覆盖率，不能因 details 门控丢掉性能数据。
- 复用 `requestFilters` 的来源排除、限额范围、时间范围和 `calendarZone`。限额窗口沿用已有 Codex 来源资格，不因性能来源标签扩大范围。
- `/api/usage?freeze=1` 和带 snapshot id 的请求，必须从同一个冻结 store、同一个 `asOf` 读取性能、覆盖率和用量。改变 live 索引后旧 snapshot 不变；快照过期仍沿用 410 恢复流程。
- 内存报告路径须持有性能候选及方法元数据供服务端/CLI 汇总；索引路径须持久化对应候选。`/api/usage?detail=full` 与 CLI `json` 的公开 report 须在汇总后投影原有公开字段，不序列化内部 `perfSamples/sampleKey/sourcePath`。浏览器从 API 接收 `summary.perf`，仅排序展示和格式化，不自行从报告重算分位数；已移除的旧 HTML 报告不设 `perfSamples` 兼容分支。
- `meta` 至少含 `methodVersion, state, indexVersion, indexedAt, minSamples, longWindowMs, eraCutoffMs, sourceWarnings`，其中 300000ms 是**提示阈值**。查询时变化的范围标签不进入持久样本。
- `groups[]` 至少含稳定 `key`、来源/代理/模型子组维度、`window`、`timingKind`、`tokenScope`、`confidence`、`n`、`tps { p10, p50, p90, pooled }`、`durationMs { p50, p90 }`、`sumOutputTokens`、`sumDurationMs`。Codex 为 `confidence = estimated`，不能默认为精确生成速率。

API 返回未格式化数值，UI 最后格式化；类型定义补入 `src/usage-types.js`。显示排序用未舍入 p50，稳定同值排序用规范 key，避免 Node/浏览器 locale 差异。Codex 后续若新增请求级计时证据，必须另立 timingKind 和方法版本。

## 6. 历史调查记录（已归档）

原 §6 的调查与旧决策保存在[历史调查归档](../archive/2026-10-04/model-tps-investigation-history.md#historical-section-6)；当前施工以本计划的现行契约为准。

## 7. 界面与解释

**2026-10-08 前端重构：** 用户否决原性能入口与信息组织，并选定独立模型吞吐区域。下列原界面安排留作实施历史，不再约束后续前端；当前设计及待审原型见[独立区域重构方案](2026-10-08-tps-ui-restructure.md)。统计、分组、测量口径等数据契约继续有效，旧技术门禁不代表项目所有者已接受 UI。

首版在现有模式切换增加“按性能”，沿用 bar-list 和 dialog。来源/渠道 → 代理 → 模型为主层级，供应商或推理配置不同的同名模型展开为独立子组；不依赖新增图表包。

“按性能”不是时间分布模式，不生成按日或按时间槽的 TPS。切入时保留模式切换按钮和日期/来源筛选，隐藏时间图 `#timelineChart`、图例及时间图专属告警，使性能列表与覆盖率/诊断占用主区域；隐藏的 canvas 不可继续接受键盘焦点或保留旧 tooltip/aria 文案。切回原模式后恢复时间图。P1.5 须逐项检查现有 mode 分支、详情列表、tooltip、图例、键盘交互和中英文无障碍文字，不把 `performance` 传给只认识时间图模式的绘图分支。

- 主数字为 p50 TPS，旁边显示 n；展开后显示 p10、p90、合并样本 TPS、时窗时长 p50/p90、覆盖率和剔除原因。p10 标“慢的一端”，p90 标“快的一端”，所有时长标为观测时窗。
- ZCode / DSH / OpenCode 标签为“请求端到端 TPS（含请求等待）”；Codex 标签为“轮级 item 时窗 TPS 估算”。“纯生成速度”不进入文案。
- 缺代理证据显示“代理未知”；只有 `agent_kind=main` 才显示“主代理”。`agent` 名称为空与主代理身份是两个独立问题。Codex 来源 `vscode/cli` 是入口信息，不能替代 agent 身份证据。
- `n=0` 不出 TPS 排名行，但若 eligible > 0，则在覆盖率/诊断区域说明“有用量，暂无可用 TPS 样本”，区分来源未启用、格式不支持、缺时长与索引重建。
- 覆盖率按当前筛选范围展示“有跨度率 / 完整跨度率 / 有效样本率”，Codex 再区分近期与旧时段。日期切点只是此次探测的分析切片，不是上游的永久版本保证。
- 同口径排名使用未舍入的 p50 从高到低排序；n < 20 的组放入样本不足区域。同一排名池不得混入不同 timingKind/tokenScope；供应商与推理配置差异必须可见，结果只描述本机历史样本。
- 既有 Codex 诊断快照提示主代理按模型分组可能普遍低于 n=20；出现“样本不足、无可排名行”是允许的真实结果。实施时按新快照和当前筛选范围复核，不把历史样本数写成验收常量，也不为凑排名放宽过滤。
- 数值统一一位小数 `tok/s`；`duration_ms ≥ 1000` 显示秒，否则显示 ms。必要时提供原始值 tooltip，排序不依赖格式化字符串。
- 新字符串遵循中文键/英文值的 i18n 机制，新样式仅用现有主题变量；小样本、未知代理、估算标签和重建状态都须检查中英文及两种主题。

“轮总耗时”可作为后续独立指标；本期不因为读取 task_complete 的终态就自动扩大产品交付范围。

## 8. 测试与检查

以下是**实施时**的验收要求；本次计划修订不代表这些代码或测试已经存在。

- 统计函数：空数组、n=1、奇偶样本、重复值、p10/p50/p90 nearest-rank、非等长样本的合并 TPS、稳定同值排序、非法数值和整数累加越界；比较未舍入结果。
- ZCode：缺 duration 时使用毫秒时间戳回退；缺 TTFT 仍有样本；成功但重试/取消标志冲突须诊断；分别验证过滤前和过滤后数量；缓存输入不重复相加。
- DSH：step 编号在 turn 间重置；跨会话相同步号；header 缺模型/变更模型；消息缺 usage、缺 start、负跨度；多帧或坏帧。不能以访问 stream key 完成 TPS 计算。
- OpenCode：created/completed 足够、streamed 缺失不影响；完成时间缺失、错误消息、v1/v2 token 语义不同；output 与 reasoning 分别存在/缺失时按已知程度处理。
- Codex：不同线程相同 turn_id、同线程切换模型、轮内模型证据冲突、同 item/request 重复或冲突、跨 rollout 文件、部分 item 缺时长、完整多请求长轮、尚未结束轮次、JSONL/SQLite 类型大小写、可选数据库缺失/版本变化。
- 反例：完整 item 时长小于首 Token 等待仍被保留；完整多请求 item 时长 >300s 只提示不剔除；整轮 1000 输出而仅一半 item 可计时时不产生默认 TPS。
- 索引：v11→首批版本迁移、无 WHERE 的历史重索引、源文件替换时显式删除旧候选、删除/归档移动时级联失效、重复同步幂等和失败回滚；到 P4.0 再验证跨 rollout 依赖与可选库仅 WAL 更新。
- 汇总：时间范围与来源排除一致、同源限额资格一致、未知代理与主代理分开、不同 tokenScope/推理配置分开；两条生产路径对同一 fixture 的 `summary.perf` 及覆盖率一致，既有三路径用量 parity 保持原范围。
- API/UI：两个 API 契约一致；实际 `/api/usage?view=dashboard` 可见；freeze 后 live 变化不改变快照；过期 snapshot 恢复；性能模式无时间图/图例及旧 tooltip 焦点，模式切回可恢复；n=0 诊断、小样本不排名、估算标签/i18n/主题。

代码实施阶段跑对应来源和聚合测试，阶段交付时跑 `npm.cmd test`、`npm.cmd run typecheck`、`npm.cmd run lint`；浏览器视觉检查留到 UI 接入。计划文档只检查结构、链接和规则一致性，不用旧测试通过记录声称新功能已验收。

## 9. 待核实、降级与风险

- **Codex 分子/时窗范围**：usage 是整请求输出，目标 item 只包含 AgentMessage/Reasoning。工具调用参数输出、隐藏推理、上下文压缩等是否有对应时窗，需要以请求和 item 的结构元数据核对；不能阅读正文估 token 弥补缺证据。验证不成立时保留估算标签，并限制其排名用途，不改用轮墙钟冒充生成时间。
- **来源 token 语义**：Codex 的 reasoning/input cache 子集已由计数结构和现有适配器确认；OpenCode v2 的并列拆分由当前版本守护确认；ZCode/DSH 的跨 provider 推理范围仍须复核。未验证分组不与已验证语义合并。
- **终态**：请求是否结束与是否有非零输出是两件事。Codex 优先用同线程/同轮的 task_complete 元数据判定结束，具体错误/中断字段按 P0 当前版本确认；可选 SQLite 的 completed 状态只能在投影就绪且身份匹配时补证。无终态证据的候选不默认当完成。
- **附加源降级**：history/state 数据库缺失、schema 不支持或只读打开失败，不回退读写打开。JSONL 性能解析照常；身份缺失为 unknown，跨度缺失为无样本，诊断说明原因。
- **现有数据库读取兜底**：`src/zcode-usage.js` 和 `src/opencode-usage.js` 的现有读取器在只读打开失败后会回退到普通 `DatabaseSync(dbFile)`，可能以可写方式打开上游库。TPS 探测脚本和新增性能读取不得依赖这种兜底；P1 若复用现有读取器，须使 TPS 所经调用严格只读或改用独立的只读窄查询。无法只读访问时按来源降级，不能把当前产品读取器称作“全链路只读”。
- **跨度异常**：非正值、冲突记录、目标 item 区间重叠和截断轮次单列原因。超过 1000 tok/s 只是核查提示，不是通用模型上限或自动删样本条件。
- **比较限制**：输入长度、输出长度、缓存、推理 effort、服务 tier、模型 tokenizer、provider 路由和记录版本都会影响结果。同族表示计算公式接近，不表示进行了控制变量实验。
- **规模**：JSONL 流式读取，轮状态缓存只含元数据；跨文件去重允许按线程分批、必要时落在本项目索引暂存表，不将全部原始日志读进内存。DSH 当前整会话解压成本仍在；聚合先筛范围/来源，再按组排序，成本约 O(n log n)。

不做 TTFT、逐 token 节奏重建、正文计数、主动探测请求、上游数据库修复或“推荐模型”结论。本计划只使用历史记录；新增性能读取严格只读，现有读取器的可写兜底按上项处理。

## 10. 当前施工顺序与任务卡

下表保留 P0–P5 作为**范围和阶段摘要**；可直接分派的施工顺序、文件所有权、验收和逐卡交接以[Implementation Plan 的 M0–M8 卡片](2026-10-04-model-tps-implementation-plan.md)为准。归档中的原 §13.5、§15.8 为旧卡片。此处是尚未实施的计划，不代表任务已验收。

| 卡 | 交付 | 主要写入位置 | 前置/验收 |
| --- | --- | --- | --- |
| P0.1 | 固化可复现只读探测，针对尚未闭环的字段与身份条件生成一次新基线 | `scripts/perf-probe.mjs`、日期 validation 快照 | 记录覆盖、去重、终态、过滤前后样本、时窗范围及方法版本、源指纹、revision/dirty；不保存正文，不再追加临时全量调查章节 |
| P0.2 | 按来源冻结 token 语义、候选身份、过滤和指标可信级别 | 本计划、性能来源契约 | 单个来源不通过只阻塞该来源；不以旧 99% 覆盖率阻塞三源交付 |
| P1.1 | 共享统计、flag 和类型契约 | `src/perf-stats.js`、`src/usage-types.js`、纯函数测试 | nearest-rank、原始比值、合并 TPS、稳定分组 key |
| P1.2 | 单文件归属候选表、首批迁移和重建状态 | `src/usage-store.js`、索引测试 | 核对实际 schema 版本；替换显式失效、删除级联、事务回滚、幂等与全来源历史重索引 |
| P1.3 | ZCode 观测解析和内存/索引候选载体 | `src/zcode-usage.js`、`src/usage-core.js`、`src/usage-store.js`、来源/序列化测试 | 身份用尝试行 id；比较过滤前后，不要求 TTFT |
| P1.4 | 两条生产汇总路径、两个 API、冻结快照 | `src/usage-core.js`、`src/usage-store.js`、`src/server.js`、parity/server 测试 | 同一 fixture 的 perf 统计/覆盖率一致；页面入口和 snapshot 使用同一次索引数据 |
| P1.5 | 性能 UI、覆盖率、下钻与 i18n | `public/app.js`、`public/i18n.js`、HTML/CSS、UI 测试 | ZCode 端到端可独立交付；性能模式替换时间图且可切回，保留其他来源不支持/待接入状态 |
| P2 | DSH 请求时窗 | `src/dsh-usage.js`、来源/parity 测试 | message − start，session/turn/step 复合身份；不访问 stream |
| P3 | OpenCode 请求时窗 | `src/opencode-usage.js`、来源/parity 测试 | v2 guard、created/completed、reasoning 合并语义 |
| P4.0 | Codex 跨文件依赖表、迁移及按线程失效/重建 | `src/usage-store.js`、索引测试 | 替换/删除前收集旧依赖；同一线程剩余 rollout 重建；指纹、候选与依赖完整发布 |
| P4.1 | Codex JSONL 跨度、request/turn/item 身份和模型时序 | `src/usage-core.js` 或专门纯解析模块、来源测试 | 用 §19 样例与固定 fixture 核对；完整度、终态、多请求和跨文件一致 |
| P4.2 | 可选 agent 元数据与 history 校验/补缺 | Codex 附加源模块、索引/来源测试 | 只有 P0 证实必要和可靠才接入；只读、独立指纹、字段窄取 |
| P4.3 | Codex 估算汇总与分时段诊断、范围核对 | 共享统计接线、UI/parity 测试、本计划 | 估算标签与覆盖率真实；小样本可无排名；范围不明不宣称纯生成速率 |
| P5 | 文档提炼、真实来源复核与发布验收 | `docs/10-data-sources.md`、来源专题、日期 validation | 全套代码门禁与实际页面检查；旧勘察数字不充当新验收结果 |

首个验收里程碑是 P1.1–P1.5 的 **ZCode 垂直切片**：真实已观测的代理/模型组在看板显示 TPS，`eligible = sampled + dropped + pending` 成立，内存/索引路径与两个 API 一致，冻结快照稳定。按实际数据验收，不要求“三代理 × 四模型”的每一个组合都存在。随后交付 DSH、OpenCode，最后接入 Codex；四源仍是整体目标。同一文件同时只安排一个写入者，每阶段记录实际改动、验证结果和未闭环项。

旧卡片映射：原 P1.0“SQLite 是 Codex item 时间唯一来源”已被 §19.3 否证，退役；history/state 只在 P4.2 有可靠增益时接入。原 P1.7 的通用口径标签、样本量和同源代理语义已纳入 §3、§7、§17.6 与 P1.5，Codex 单独排名池由 P4.3 承接；旧按来源预设“OpenCode 单独成组”不沿用，实际排名池按 `timingKind` 和 `tokenScope` 分隔，OpenCode 的 tokenScope 不同时自然另组。原 P1.8 的 Codex 分时段覆盖率由 §17.5 和 P4.3 承接，不沿用旧百分比作门槛。

## 11. 现行范围与推荐默认值

原计划记录的范围约束继续保留：四源不交付 TTFT；DSH 不取用 stream；历史排名可展示，且来源与口径必须可见。

当前方案为 DSH message − start、ZCode 端到端时长、先三源后 Codex、p50 加 p10/p90、300 秒仅提示，以及按证据选择是否接入附加 SQLite。实施以本节任务卡及 §17 契约为准，不从旧稿恢复已否证的前置条件。

Codex item 时窗仍是估算，不把“轮总耗时”自动纳入首期交付。若未来用户改为要纯解码 TPS，需要新的计时证据和独立 timingKind；取消 TTFT 展示本身不能证明应该选择哪一种 TPS 分母。

## 12. 文档维护与阅读优先级

**现行指标入口是 §1、§3–§5、§7–§11、§17；执行入口是[Implementation Plan](2026-10-04-model-tps-implementation-plan.md)。** §19 保留 2026-10-03 的诊断证据与当时待验证项；文中引用的历史 §2、§6、§13–§16、§18 保留原编号并移入[历史调查归档](../archive/2026-10-04/model-tps-investigation-history.md)。旧字段、卡片、覆盖率与剔除规则不覆盖现行契约。

本计划已由[文档入口](../00-index.md)和[任务清单](../02-tasks.md)登记，状态仍为规划。功能实施或本计划被取代后，再按文档规则提炼长期行为、转移未完事项并归档。

此后新的全量探测数字、过滤条件和输入指纹只存入 `docs/validation/<date>-perf-metrics/` 日期快照；计划引用快照路径，只改受证据影响的现行规则和任务卡，不继续追加调查章节。固定 fixture 用于验证未闭环字段和算法；不要把 §19 的动态 n 或百分比写成产品验收常量。

## 13. 历史调查记录（已归档）

原 §13 的调查与旧决策保存在[历史调查归档](../archive/2026-10-04/model-tps-investigation-history.md#historical-section-13)；当前施工以本计划的现行契约为准。

## 14. 历史调查记录（已归档）

原 §14 的调查与旧决策保存在[历史调查归档](../archive/2026-10-04/model-tps-investigation-history.md#historical-section-14)；当前施工以本计划的现行契约为准。

## 15. 历史调查记录（已归档）

原 §15 的调查与旧决策保存在[历史调查归档](../archive/2026-10-04/model-tps-investigation-history.md#historical-section-15)；当前施工以本计划的现行契约为准。

## 16. 历史调查记录（已归档）

原 §16 的调查与旧决策保存在[历史调查归档](../archive/2026-10-04/model-tps-investigation-history.md#historical-section-16)；当前施工以本计划的现行契约为准。

## 17. 现行实现契约

本节与 §1、§3–§5、§7–§11 一起构成首版实施契约。§13–§16 和 §18 的旧字段、旧卡片和旧门槛均不能覆盖本节。以下字段尚未进入产品代码；施工前按 P0 核对实际来源版本。

### 17.1 候选身份与逐来源取值

| 字段 | ZCode | DSH | Codex | OpenCode |
| --- | --- | --- | --- | --- |
| `source_kind` | `zcode` | `dsh` | `codex` | `opencode` |
| `window` | `request` | `step` | `turn` | `message` |
| 原始身份元组 | `(home_id, row.id)` | `(home_id, session_id, turn, step)` | `(home_id, thread_id, turn_id)` | `(home_id, database_identity, message.id)` |
| `duration_ms` | 显式 duration；缺失回退两个 epoch 毫秒时间戳之差 | 同 `(session, turn, step)` 的 message.time − start.time | 完整去重目标 item 正跨度之和 | completed − created，两者均须存在 |
| `output_tokens` | 显式 output_tokens | 显式 usage.outputTokens | 去重 response 的 usage.output_tokens 之和 | v2 output + reasoning；缺字段不能冒充已知 0 |
| `input_tokens`（诊断） | input_tokens 原值；不再加 cache read/write | inputTokens + cacheReadTokens + cacheWriteTokens | 去重 response 的 usage.input_tokens 之和；不再加 cached | input + cache.read + cache.write |
| `ts_ms` | completed_at，缺失回退 started_at | message.time | 已结束轮的末条 token_usage_record.timestamp | completed，缺时长候选可用 created 定位诊断 |
| 代理证据 | agent、query_source、task_type | agentPreset、delegationDepth | session_meta.source；可选 state 的 source/thread_source/agent 字段 | data.agent 与经确认的角色元数据 |
| 模型证据 | model_id/provider_id/variant | 当前请求作用域的 header config | 同线程同轮 turn_context.model / effort | data.model.id 与对应 provider |

身份统一用规范 JSON 元组编码，字符串先按来源已有规范 trim，保留大小写语义；空/缺身份列诊断，不使用时间戳临时冒充稳定 id。无法形成稳定身份的原始行不写候选表，只累计编码 `sourceWarnings`，不进入可去重的 eligible；不能据此宣称来源全覆盖。`logical_request_id` 留作重试诊断，不作为 ZCode 尝试行的唯一键。OpenCode 优先使用 message.id，不能只靠全局 seq。

**Codex 去重和归属：**

1. 请求身份为 `(home_id, thread_id, response_id)`；轮身份为 `(home_id, thread_id, turn_id)`；item 身份为 `(home_id, thread_id, turn_id, item.id)`。必须跨同线程全部 rollout 去重，不能按 turn_id 或 item_id 全局建映射。
2. JSONL 顶层是 `event_msg`，`payload.type = item_completed`，item 判别式为 **PascalCase `AgentMessage` / `Reasoning`**。SQLite 的 `item_type` 是 **camelCase `agentMessage` / `reasoning`**，两处显式映射，不混用大小写。
3. 只取 `thread_id, turn_id, item.type, item.id, started_at_ms, completed_at_ms` 和记录时间/来源位置。item 的 content/summary_text/raw_content 不取用；SQLite 不 SELECT/解析 item_json。
4. 重复且计数/时间一致的记录折叠；缺值可由同身份一致记录补齐。非空计数、归属或起止值互相冲突则置 `RECORD_CONFLICT`，进入诊断，不能相加或静默取最后一条。
5. 去重请求 output 的和是分子主路径，末条 `turn_token_usage.output_tokens` 仅做交叉校验。本轮二者一致，但不把这个快照当作永久不变量；发生差异时标冲突并查重放/截断原因。
6. 按精确 turn_context.turn_id 建模型表；同轮模型证据冲突时暂不统计，等待更细请求级证据。不用“最近一个上下文”跨轮继承模型，也不优先取 state.threads.model。历史 model 表示请求配置，`model_evidence = turn_context`，不等同于服务端物理模型证明。
7. 默认统计已结束且所有目标 item 时长完整的轮。task_complete 仅读取同轮终态元数据，不读 last_agent_message 或 TTFT；终态丢失为 unverified，不靠“已经有 token”推定成功。明确进行中的轮进入 pending，更新后同身份替换。
8. 可选 SQLite 只能按同线程同轮同 item 身份验证或补缺，须确认投影就绪及来源版本；同 item 的非空跨度与 JSONL 冲突时保留 JSONL 证据并标冲突。补缺的 `timing_source` 要标 `mixed`，不把来源不一致静默混成一个确切测量。

**代理和 token 语义：** `agent_kind` 独立于名称。明确 subagent 标记/深度给出 subagent；只有 P0 验证过的主代理身份映射才给 main；其余 unknown。`threads.source` 中的 JSON 按结构规范化成标签，不将整个 JSON 文本当代理名；nickname/role 缺失不等于 main。

`token_scope` 首版允许 `reported_output_includes_reasoning`、`visible_plus_reasoning`、`reported_output_unspecified`。Codex 与 OpenCode v2 分别属于前两者；ZCode/DSH 在 provider 语义验证前属于第三者。input/cached 与 output/reasoning 的关系依据现有适配器及 [官方计数结构](https://github.com/openai/codex/blob/main/sdk/python/tests/app_server_harness.py)，不能把所有来源按“字段并列”一律求和。

`status = completed | failed | cancelled | in_progress | unverified`；缺字段不强制转 completed。所有时间单位和 fallback provenance 在 P0 固化，绝对秒时间戳必须先转毫秒。`window_start_ms/window_end_ms` 是观测边界，Codex 边界包围全部 item，**两边之差不是 duration_ms**。

### 17.2 唯一聚合算法

- 从相同合格观测集合计算 `r_i = output_tokens_i × 1000 / duration_ms_i`；排序后的 nearest-rank 为 `r[ceil(p × n) − 1]`，p 分别为 0.1、0.5、0.9。
- n=1 时三个分位相同；n=0 时不产出 TPS 统计行，返回对应诊断/覆盖信息。时长另算 p50/p90，不能通过 TPS 分位反推时长分位。
- `pooled = sumOutputTokens × 1000 / sumDurationMs`。分位、总量比、sum、n 使用同一集合；不把 pending、partial 或 filtered 行混入总量比。
- 原始整数和总和必须在 Number 安全整数范围内，累加溢出为诊断，不输出伪精确 TPS。排序和去重后稳定遍历，两条生产汇总路径共享同一函数。
- nearest-rank 是选定的统计契约；线性插值也是合法算法，排除它是为了固定产品语义，不是宣称插值本身会造成统计错误。
- 分组 key 为 `(source_kind, home_id, channel, agent_kind, agent, model, model_provider, reasoning_effort, timing_kind, token_scope)` 的规范序列化；不同 home 默认分开，跨 home 合并只能显式进行且保留完整来源组成。

### 17.3 API 数值与展示

数据库不存 TPS，API 不做展示舍入。UI 将 TPS 和合并样本 TPS 统一格式化为一位小数；覆盖率一位小数；时长小于 1000ms 用 ms，其他用秒。原始值负责排序与 parity，格式化后相同的两个数字不能被当作并列证据。

查询期 `crossPeriod` 根据完整观测边界与现有范围计算，不计入持久 flag，也不导致样本剔除。缺边界时该说明为 unknown，而不是 false。

### 17.4 持久标志与排除规则

| 位 | 名称 | 默认动作 |
| --- | --- | --- |
| 0 | `OUTPUT_ZERO` | 真 0 输出，诊断，不统计 TPS |
| 1 | `DURATION_NONPOSITIVE` | 真 0/负时长，诊断，不统计 |
| 2 | 保留 | 旧 GEN_BELOW_FIRST_TOKEN 已取消，不能置位 |
| 3 | 保留 | 旧 CROSS_PERIOD 移到查询期字段，不能置位 |
| 4 | `LONG_WINDOW` | duration_ms > 300000；只提示，仍统计完整有效样本 |
| 5 | `MULTI_REQUEST_TURN` | Codex 去重请求数 >1；只提示 |
| 6 | `PARTIAL_ITEM_SPAN` | Codex 部分目标 item 缺少有效跨度；默认不统计 |
| 7 | `MISSING_DURATION` | 分母缺失，不统计 |
| 8 | `MISSING_OUTPUT` | 分子缺失，不统计 |
| 9 | `MODEL_AMBIGUOUS` | 同轮模型冲突，不统计 |
| 10 | `TERMINAL_UNVERIFIED` | 无结束证据；诊断，不统计 |
| 11 | `SOURCE_FILTERED` | 失败/取消/重试等来源过滤，不统计，另留 reason |
| 12 | `RECORD_CONFLICT` | 同身份计数/时间/归属冲突，不统计 |
| 13 | `OVERLAPPING_ITEM_SPAN` | 目标 item 重叠，方法核查前不统计 |
| 14 | `TIME_INVALID` | 非有限数、时序矛盾、单位不支持，不统计 |
| 15 | `TIME_UNPLACED` | ts_ms 缺失，留全来源诊断，不进入范围内分母 |
| 16 | `METHOD_ESTIMATE` | Codex item 时窗估算，仍统计并明确标签 |
| 17 | `TOKEN_INVALID` | 输出为负数、非整数或非有限数，不统计 |

所有 flag 共用一个常量表。status=in_progress 的候选归 pending，不应假装是失败；同一候选可能有多个 flag。首版 longWindowMs 固定于方法元数据，若修改阈值必须同步重算该提示，不能让旧 flag 与新说明相矛盾。

### 17.5 覆盖率与诊断的精确契约

`coverage = { bySource, byGroup, unsupportedSources, eraCutoffMs }`，来源 key 含 source_kind 与 home_id。source 和 group 的计数共享同一形状：

```text
{ eligible, positiveOutput, timedPositiveOutput, completeTimedPositiveOutput,
  sampled, dropped, pending, unplaced, byFlag, droppedByReason,
  timingRate, completeTimingRate, sampleRate, byEra: { recent, legacy } | null }
```

- `eligible`：来源筛选后、可归属当前时间范围的**全部去重请求/轮候选**，包括缺计时、零输出、失败和未完成。不会因为缺 duration 就从分母消失。
- `positiveOutput`：eligible 中 output 已知且 >0；`timedPositiveOutput`：其中有正观测时长；`completeTimedPositiveOutput`：其中目标时窗完整。完整不保证状态或模型证据合格。
- `sampled`：通过默认筛选、贡献 n/分位/总量比的候选；`pending`：明确进行中的候选；`dropped`：其他不合格候选。保证 `eligible = sampled + dropped + pending`，且 `sampled <= completeTimedPositiveOutput <= timedPositiveOutput <= positiveOutput <= eligible`。
- `timingRate = timedPositiveOutput / positiveOutput`；`completeTimingRate = completeTimedPositiveOutput / positiveOutput`；`sampleRate = sampled / eligible`。分母为 0 时返回 null，不写 0% 或 100%。LONG_WINDOW 不降低有效样本率。
- `byFlag` 可以重叠，不能相加当 dropped；`droppedByReason` 给每个 dropped 一个主原因并满足总和等于 dropped。主原因固定优先级：record conflict → model ambiguous → terminal unverified → source filtered → missing/zero/invalid output → missing/nonpositive/invalid duration → partial → overlap；新原因加入常量契约。来源过滤的具体原因持久化为 diagnostic_reason（枚举，不保存原始错误正文），同一 flag 的失败/取消/重试仍可解释。
- `unplaced`：缺 ts_ms 的候选，无法分配给任一时间段，单列为所选来源的全历史定位诊断，**不进入当前范围 eligible**，UI 明示其范围。unknown model/agent 候选仍保留在 unknown 子组，不偷归主代理。
- Codex 的 byEra 按**同一个样本 ts_ms**切分；非 Codex 组的 byEra 为 null，不套用 Codex 格式分析切点。本次分析切点为 `2026-09-28T01:00:57Z`（北京时间 2026-09-28 09:00:57）。切点可在方法元数据中更新，不以 item.created_at、线程创建时间代替轮次归属，不声称该日是永久格式分界。
- coverage 的过滤器、snapshot/asOf 与 groups 完全一致。byGroup 存在 eligible>0、sampled=0 的组时只出诊断，不产生 0 TPS。
- eligible 表示本次成功观察到的候选，不代表上游所有 API 请求。坏帧、坏 JSON 行、不可读文件和版本不支持都进入 meta.sourceWarnings；读取不完整时 state=degraded，不能用恢复出的少量候选宣传全历史 100% 覆盖。

### 17.6 小样本、排序和可信级别

达标组先显示，按原始 p50 从高到低；同值按规范 key。1<=n<20 的组随后列出并标“样本不足”，不编号排名。n=0 的性能空缺放在诊断区。Codex 标 estimated；不完整跨度不因加了“估算”文字就进入默认统计。

跨来源排行须保留各来源原始代理语义，不把 ZCode Explore 与 DSH agentPreset 自动映射成同一身份。供应商、effort、tokenScope 不同须可辨认；没有日志证据的 effort/provider 记 unknown，不能套当前设置回填历史。

### 17.7 验收依据

| 验收对象 | 必须成立的行为 |
| --- | --- |
| 固定 fixture | 手工计算分位/pooled 与输出一致；缺失与 0 可区分；身份碰撞/重复不改变计数 |
| Codex 元数据 | JSONL PascalCase 匹配正确；turn/request/item 复合键正确；精确 turn_context 归模型；计数和累计校验一致 |
| Codex 剔除 | partial、冲突、未完成不统计；完整长轮/多请求轮仍统计；不比较 TTFT 大小 |
| 来源过滤 | ZCode 过滤前后分别验证；缺 TTFT 不影响；DSH 不访问 stream/不依赖 step.end；OpenCode 按 v2 guard |
| 覆盖率 | 计数恒等式、null 分母、group/source/era 范围一致；没有 recent≥99% 的硬门槛 |
| 汇总/API/页面 | 内存与 SQLite 的 perf 及覆盖率 parity；两个 API 返回相同契约；浏览器只消费 summary；实际 dashboard 返回性能，冻结快照不随 live 更新 |
| 迁移/失效 | 首批 schema 版本核对、全来源重索引、替换时显式失效、删除级联、WAL 更新、幂等及失败回滚；Codex 阶段再验跨文件依赖与线程重建 |
| 文案 | 三源端到端和 Codex 估算区分；未知代理不叫主代理；p10/p90方向正确；小样本不排名 |

本机动态数据用 §19 做排查参考，**不硬编码 n=2929/4107 或精确分位数**。只有固化输入指纹和过滤条件的同一快照才允许数值回归比较；观察到差异先比较候选集合、来源版本和方法版本。

### 17.8 可复现只读探测要求

P0 脚本应记录 `probeVersion, methodVersion, startedAt, endedAt, nodeVersion, gitRevision, dirtyState, sourceFingerprintBefore, sourceFingerprintAfter` 和读取范围；fingerprint 变化时标记 liveSourceChanged，不能宣称单一原子快照。2026-10-03 的临时脚本未入库，因此 P0 仍须固化；本阶段只针对未闭环字段和回归基线运行有界探测，不重复追加人工全量调查。

- JSONL 同时扫描 sessions 与 archived_sessions，以精确顶层类型过滤；统计 turn_context、token_usage_record、item_completed、task_complete 的元数据，并按复合身份归并。
- ZCode 只 SELECT 必需列，分别输出 all、positive、filtered；OpenCode 用 SQL JSON 标量提取计数/时间，避免取出正文；DSH 只取 header、usage、turn/step、row.time，不探测 stream。
- 若启用 SQLite 比对，显式只读、检查必需列，不把某个 _sqlx_migrations 最大值当作跨版本语义保证；比较的是同一候选宇宙与同一身份，另报告“投影自身覆盖率”。
- 调查可在内存或本项目临时索引处理元数据，但不保存原始正文中间结果。持久 validation 只含聚合计数、方法和脱敏指纹，不含 thread/response/item 原始 ID、会话路径、标题、content、args、item_json。
- 每份输出注明 raw counts / after-filter counts / full-span counts / finalized counts 的区别；脚本使用与产品同一筛选契约后，才称为验收样本数。结果及其输入指纹留在日期 validation 快照，计划只引用路径和吸收被证实的规则变化。

## 18. 历史调查记录（已归档）

原 §18 的调查与旧决策保存在[历史调查归档](../archive/2026-10-04/model-tps-investigation-history.md#historical-section-18)；当前施工以本计划的现行契约为准。

## 19. 本次只读评估与实施边界补全（2026-10-03）

本节整理本会话在文档修订前做的源码核对与只读全量复算。用户随后要求继续丰富本 plan，现行章节与 §17 已按证据同步修正。**本次交付是文档，不表示生产解析、数据库迁移或 UI 已实现。**

### 19.1 探测范围与可复现性限制

Node v24.19.0；扫描本机 `.codex/sessions` 与 `archived_sessions` 共 241 个 JSONL、DSH 66 个会话；只读打开 ZCode、OpenCode、Codex state/history 四个 SQLite 库。上游均使用 readOnly，没有执行库修复；探测过程不输出正文/工具参数。

各查询顺序执行在正在写入的历史源上，**不是跨库/跨文件原子快照**；少量计数随会话运行增长。以下保留每次查询自身的分母和分子，不把不同阶段的数字混合重算。没有保存完整输入快照或正式 probe 脚本，因此这些结果是诊断证据，正式数值验收仍由 P0 固化方法与指纹。

### 19.2 三源请求口径的复算

| 来源/阶段 | 数量 n | TPS p50 / p90 | 合并样本 TPS | 说明 |
| --- | --- | --- | --- | --- |
| ZCode 正输出/正时长，过滤前 | 4117（总行 4160） | 34.48 / 97.20 | 37.08 | duration 与 completed-start 一致；不是最终样本集合 |
| ZCode 按计划状态/重试等过滤后 | 4043 | 34.82 / 99.72 | 39.95 | 871 条缺 TTFT，但端到端 TPS 仍可用；logical_request_id 重复组 0 |
| DSH message − step.start | 2953（消息 2956） | 97.38 / 188.29 | 108.11 | 66 会话、配对缺失 0、非正跨度 0、零/缺输出 3、>1000 tok/s 为 0 |
| OpenCode completed − created | 526（assistant 529） | 54.47 / 127.71 | 57.94 | 402 样本 reasoning >0；候选序号碰撞 0；需沿用正式版本/终态过滤 |
| OpenCode 错用 completed − streamed | 525 | 1806.82 / 28270.59 | 826.26 | 332 条 >1000 tok/s，证明该字段不适合预期生成分母 |

OpenCode 正确端到端口径也有 2 条 >1000 tok/s，所以“高于 1000 就一定错误”不是通用剔除规则。DSH 计数增长和长样本会改变 pooled，不能把 §18 的 104.6 强制当当前验收值。

### 19.3 Codex JSONL 已有原生 item 时间

一次全量扫描识别 **38473 条 `event_msg/item_completed`**，payload 键为 `type, thread_id, turn_id, item, started_at_ms, completed_at_ms`；其中 29841 条 started 非空、28721 条为正跨度。目标 item 的正跨度分别为 `Reasoning 14190`、`AgentMessage 3362`。

因此 §15.3 的“JSONL 没有任何 *_at_ms”不能复现，并被当前数据直接否证。item.id 同样存在；本轮发现 5 个重复目标 item，应按复合身份折叠。JSONL 的 PascalCase 与 SQLite 的 camelCase 也是需要分别匹配的真实差异。[官方原生 item 事件的迁移测试](https://github.com/openai/codex/blob/main/codex-rs/thread-store/src/local/rollout_migration_tests.rs) 亦保留这两个时间字段；本机字段存在仍以上述实测为依据。

**成本变化**：首选已有 rollout 扫描即可同时取请求计数、模型上下文和 item 跨度，取消“必须新增 history 库链路”的前置依赖。state/history 仅在确有代理补充、来源校验或缺字段收益时增加；不上来就做两套采集再混合样本。

### 19.4 身份和历史模型归属

- history 的 thread_turns 中 **69 个 turn_id 跨线程复用**，涉及 239 行，id 长度 22–23。数据库本来就是 `(thread_id, turn_id)` 联合主键，不能忽略 thread_id。
- 12716 条 token_usage_record 的 payload 都带 thread_id/turn_id/response_id/usage/turn_token_usage；本轮 response 复合身份重复 0，usage 输出之和与末条 turn 累计输出一致。
- **23 个线程出现过多个上下文模型，3193 条请求的上下文模型不同于 state.threads.model**。会话级字段不能覆盖历史模型；精确 turn_context 对应才是首选。
- 简单“最近上下文”探测曾出现轮次错配；改按精确 turn_context.turn_id 关联后可归属模型。因此轮内模型冲突的处理规则是必要防线，但不能把初次探测错配当作已证实的真实换模型轮。
- 另一次 state 元数据查询为 238 线程：agent_role 非空 0、agent_nickname 非空 1、agent_path 非空 1、thread_source 非空 229。字段存在不等于身份值齐备；代理缺证据不能显示为 main。

### 19.5 跨来源连接后的覆盖率

以下候选宇宙是“扫描到正输出的全部 Codex 轮”，按末条 usage 时间切近期/旧时段；尚未应用当前契约的终态/冲突等全部过滤。与 §17 当前 valid sample rate 不同。

| 数据来源/范围 | 正输出轮数 | 有正跨度轮数 | 所有已观测目标 item 时长完整轮数 | 有跨度率 |
| --- | --- | --- | --- | --- |
| JSONL，全历史 | 3687 | 2069 | 2054 | 56.1% |
| JSONL，近期 | 1827 | 1739 | 1731 | 95.2% |
| JSONL，旧时段 | 1860 | 330 | 323 | 17.7% |
| SQLite，全历史（另一查询阶段） | 3683 | 1810 | 1798 | 49.1% |
| SQLite，近期 | 1823 | 1724 | 1716 | 94.6% |
| SQLite，旧时段 | 1860 | 86 | 82 | 4.6% |

这里“完整”只指已观测目标 item 的起止字段齐全，**不能证明日志没有截断或分子涵盖的全部请求都由这些 item 覆盖**。最终还需验证终态与 token/时间范围。旧 72%/99.8% 来自投影库内部轮次集合，不能替代使用者所选范围内全部 token 轮次的覆盖率。

没有正跨度的轮也必须进入候选宇宙和缺时长诊断；不允许只统计成功连接的对象后再宣传 100% 覆盖。

### 19.6 剔除规则的反例与可信边界

- JSONL 时窗和 task_complete 的对照查询：2065 个可比较轮中，**1602 个累计 item 时长小于首 Token 等待**。这是正常可能关系；若沿用旧 GEN_BELOW_FIRST_TOKEN 规则，将误删约 77.6% 的这批轮。
- 同一查询有 **72 个累计 item 时窗 >300s**；SQLite 查询的 42 个长轮中 41 个是多请求轮，请求数量可到 680。长度本身不足以推断等待，应标 LONG_WINDOW，不自动排除。
- JSONL 查询见 15 个部分跨度轮，SQLite 查询见 12 个；以全部 output 除以部分时长会把 TPS 抬高。首版明确剔除 partial，而不是只置 flag 后照常入统计。
- 两个来源的目标 item 本轮均未发现区间重叠；仍须保留回归 fixture。将来发现重叠时不能静默改变分母算法。
- item 窗口与整请求 output 之间的对应仍是未验证项。请求中工具调用参数生成和压缩等时间可能不在目标 item 类型内；本轮只确认字段和统计关系，**未证明纯模型解码速度**。

### 19.7 当前推荐方案与尚待闭环

请求端到端时长用于 ZCode/DSH/OpenCode，是为了固定可用、可解释的产品口径；取消 TTFT 展示并不自动决定 TPS 应否扣去等待。Codex 维持 item 时窗估算，先验证范围，不改用轮墙钟补齐缺失。

本节形成时仍待实施阶段闭环：固化 probe 与输入指纹；确认各来源终态和 tokenScope；确认 Codex token/时间范围；完成候选、版本及 Codex 阶段的依赖契约；补真实页面 `/api/usage` 与冻结快照；用固定 fixture 核对两条生产汇总路径。单个来源退化只阻塞该来源，三源可先独立交付。

### 19.8 本次修订核对清单

2026-10-03 的现行章节已据当时证据修正 JSONL 优先、复合身份、轮级模型、覆盖率、partial/长轮/未完成处理、输入缓存重复计数、p10 方向、API 和冻结快照。旧 GEN_BELOW_FIRST_TOKEN/SUSPECT_WAIT/CROSS_PERIOD 的持久规则不再生效。此处数字只对应当日非原子诊断；2026-10-04 起的实现安排以 §10 和 §17 为准。
