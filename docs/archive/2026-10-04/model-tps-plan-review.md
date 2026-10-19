# TPS 计划评审意见（第三方只读复核）

日期：2026-10-04。评审对象：[模型输出吞吐指标（TPS）计划](../../plans/2026-10-03-model-latency-throughput-plan.md)（评审当时为 798 行 / 101KB，状态"只做计划，未实施"）。

> 归档说明：本篇保留评审当时的原始意见与代码坐标。2026-10-04 的采纳、修正和未采纳结果已体现在现行计划；旧行号和旧任务卡映射不作为当前施工依据。

**性质：评审意见，不是规格，不含施工授权。** 与计划冲突时以计划的 §10（任务卡）与 §17（实现契约）为准。本文按计划 §12 的"同主题调查优先并入本文件"规则处理：条目被采纳后应并入计划原文，本文随后归档，不与计划长期并存（§18 已为 `duration-tps-survey.md` 立过同一先例）。

复核方法：只读核对计划引用的全部代码坐标与仓库现状，未运行任何全量扫描。因此**本文不评价任何实测数值的正确性**——ZCode 4160 行、DSH 2953 样本、Codex 有跨度率 56.1% 这些数字我无法廉价复现，只能评价它们与代码现状、与彼此、与计划自身规则的一致性。

---

## 1. 总评

口径部分是这份计划最有价值的资产，我认为不需要再改。工程排期部分把风险压错了位置。文档形态本身已经成为交付风险。

一句话立场：**该停止调查、开始实现了。**

## 2. 计划做对的三件事（建议原样保留）

**一、用否证而不是用偏好定口径。** 六个候选分母被实测逐个杀掉：`stream` 内部跨度（3.2% 荒谬样本）、OpenCode `completed − streamed`（62.9% 荒谬，极值 186 万 tok/s）、Codex `task_complete.duration_ms`（轮级墙钟含人审等待，`gpt-6.1-sol` 均值 13 分钟）、DSH `step/end`（把 p90 4965ms 的工具收尾段算进模型吞吐）、"仅单请求轮"白名单（会让样本被 auto-review 占满）、`duration_ms − ttft`（TTFT 取消后失去服务对象）。每一次改判都带数字，这是这份计划最难被替代的部分。

**二、覆盖率契约（§17.5）比指标本身更严格。** `eligible = sampled + dropped + pending` 的恒等式、`sampleRate` 用 eligible 而非"成功连接的对象"当分母、缺 `ts_ms` 单列 `unplaced` 而不进当前范围、分母为 0 返回 null 而不是写 0% 或 100%——这几条直接堵住了"宣传 100% 覆盖"的常见自欺。§15.3 那句"覆盖 100% 必须加时间限定"（新时段 ≈99.8%、全历史 ≈72%）是同一种诚实。

**三、把估算标成估算。** Codex 强制 `confidence = estimated`、强制 `timing_kind` 与 `token_scope` 进分组 key、明确"模型名表示历史请求配置，不证明服务端物理模型"、拒绝把轮级时窗与请求端到端放进同一根柱。这些约束会让首版看起来"没那么能打"，但它们是这个功能唯一可信的理由。

## 3. 与项目现状脱节的四处

### 3.1 "四路"里有一路已在 2026-10-03 被删除

§5 要求"浏览器报告的输入需要单独带性能观测及方法元数据""旧报告缺 `perfSamples` 时视为未提供性能数据，不填零"；§8 与 §10 P1.4 要求"覆盖四路"。但旧 HTML 导出器、包脚本与前端离线分支已在同日移除（`docs/02-tasks.md` 已交付段、`docs/validation/2026-10-03-export-removal/README.md`；`test-support/report-projection.js:6` 注释即 "without generating or loading an HTML export"）。

现存四个汇总实现的实际状态：

| 实现 | 位置 | 生产调用点 |
| --- | --- | --- |
| `summarizeUsage(report)` | `src/usage-core.js:2834` | `src/cli.js:268`、`src/server.js:709`（`detail=full`） |
| `UsageStore.summarize()` | `src/usage-store.js` | `src/server.js:746`（看板主路径） |
| `summarizeUsageIndex(index)` | `src/usage-core.js:2739` | src/ 与 public/ 内**未发现**，仅 `test/usage-core.test.js` |
| `summarize(report)` | `public/app.js:1064` | app.js 内**未发现**；浏览器直接用 `state.summary = data.summary`（`public/app.js:4070`） |

`test/three-path-parity.test.js` 比的是第 1、2、4 路；第 3 路在 `test/usage-core.test.js:387` 单独比。

**建议**：① §5 改写为"两个用户可达实现 + 两个纯函数镜像"，删掉"旧报告缺 `perfSamples`"这条兼容分支——没有旧报告了；② 明确决定浏览器是否自行计算 perf。§17.3 已规定"API 不做展示舍入、UI 最后格式化"，即浏览器只渲染不算分位。若确认如此，统计模块放 `src/` 即可，第 3、4 路只需透传，P1.5 的 parity 负担消失；若仍坚持 `public/perf-stats.js` 浏览器可 import，需说明镜像的价值（`src/` 已从 `public/` import `usage-fields.js`、`timeline-utils.js`、`period-comparison.js`，方向本身没问题）。

### 3.2 计划未登记，是它一直膨胀的直接原因

`docs/00-index.md` 的"当前计划"与 `docs/02-tasks.md` 都已挂上另两份 2026-10-03 计划，只有这份没挂（§13.6、§15.9 自己也记着）。2026-10-03 的文档整理刚确立"`plans/` 只放当前计划，状态由 02 指向"，这份是唯一的例外。两行指针的成本，换掉"下次接手看不到它"和"只能靠往同一文件追加章节来记录进展"两个问题。

### 3.3 文档规模已超过横幅能保护的范围

现行规范只占 §1、§3–§5、§7–§11、§17（约 250 行），其余六节是历史，其中 DSH 分母改判三次（A→B→C）、ZCode 改判两次。§12/§19.8 用横幅管理这件事，但横幅要求读者自己维护一张"哪条已被谁取代"的表——而 §16.2 与 §10 的直接矛盾（见 4.2）说明这张表已经失守。

**建议**：按 `docs/00-index.md` 的归档规则（"先提炼规则、转移遗留项，再归档原文并记录原因"）把 §2、§6、§13–§16、§18 移入 `docs/archive/2026-10-03/`，正文留纯契约。`docs/archive/` 已存在且当次整理刚归档 15 份。

### 3.4 正文数字仍在累积，与 §17.7 的规则相冲突

同一天内 ZCode 行数为 4066（§2）→ 4079（§15.5）→ 4150（§18.1）→ 4160（§19.2）；DSH 为 2874 → 2879 → 2886 → 2929 → 2953。§17.7 已写明"不硬编码 n=2929/4107 或精确分位数"，§12 已写明补充证据时应同步修改现行规则。但 §19 是第六遍全量扫描，数字仍写进正文。

**建议**：自下一次调查起，数值只落 `docs/validation/<date>-perf-metrics/` 快照，正文引用快照而不复制数值。这正是 P0.1 固化 `scripts/perf-probe.mjs` 的意义（`scripts/` 目前只有三个皮肤脚本，不冲突）。

## 4. 排期上的两个建议

### 4.1 跨文件重建机制只有 Codex 需要，应整体后置到 P4

§4 最复杂的一块是 `perf_sample_sources` 依赖表 + "替换/删除某文件前先读旧依赖、收集受影响线程、用该线程剩余全部 rollout 重建候选"。但优先交付的三源没有跨文件身份问题：

- ZCode = 单库内 `(home_id, row.id)`
- DSH = 单会话文件内 `(home_id, session_id, turn, step)`，`step/start` 与 `assistant/message` 必在同一文件
- OpenCode = 单库内 `(home_id, database_identity, message.id)`

**建议**：P1.2 只做 `perf_samples` 建表 + v12 迁移 + 按 `source_path` 的 `ON DELETE CASCADE` 失效（与 `events` 表 `src/usage-store.js:238` 同款）；跨文件依赖表与线程级重建整体移入 P4.1。首个可交付版本的存储层因此是平凡的，风险集中在最后一张卡而不是第一张。

两条迁移细节：v11 先例带 `WHERE kind = 'dsh'`（`src/usage-store.js:411`），perf 需要全来源重读，**必须去掉 WHERE**；`events` 是 `) STRICT;` 表，§4 只列字段名未给类型，建议补齐类型与 STRICT 声明以符合本仓风格。`src/usage-store.js:399` 的"落点必须用字面量"注释印证了 §4 的同名规则。

### 4.2 §10 与 §16 对任务卡的表述互相矛盾

§10 抬头："§13.5、§15.8 为历史卡片，已被替代"。§16.2："§15.8 的 P1.0 / P1.8 卡、§13.5 的 P1.1–P1.6 卡继续有效"。§16.7 第 8 条："P1.0 / P1.7 / P1.8 均不受本次改判影响"。而 §19.3 已否掉 P1.0 的前提（rollout JSONL 自带 `started_at_ms`/`completed_at_ms`，无需新增 sqlite 链路）。

形式上 §16 有历史横幅、§10 胜出，但新接手的 agent 完全可能照 §16.2 去建 `thread_history_1.sqlite` 附加源。**建议在 §10 表下补一行映射**：P1.0 退役（sqlite 降为 P4.2 可选校验）；P1.7 的三条排名约束归 P4.3；P1.8 的分时段覆盖率归 P1.5/P4.3。

### 4.3 §7 未规定"按性能"模式下时间分布图的行为

`state.timelineMode` 现为 `channel | model | cost | quota_week`，`mode` 在 `public/app.js` 中出现 189 次，分支点至少 8 处（`:373`、`:1495`、`:1521`、`:1563`、`:2196`、`:2265`、`:2352`、`:2370`），图例 `renderTimelineLegendHtml`、明细 `timelineDetailRows(summary, mode)`（`:1519`）、tooltip 与 aria 文案全部按 mode 分支。

而 §3 明确"不按天拆分 token，不按窗口重叠比例分摊输出"，即不存在按时间桶的 TPS。§7 写"沿用 bar-list 和 dialog、不依赖新增图表包"，但 `#timelineChart` 区域在新模式下如何处理没有规定。

**建议**：v1 隐藏图表与图例、由性能面板独占该区域，并写进 §7；同时把上述 8 个分支点列进 P1.5 验收，避免漏掉 aria/tooltip 文案（`public/i18n.js` 的中文键/英文值机制要求新键成对补）。

## 5. 我对这个功能本身的看法

### 5.1 Codex 应当最后做，并且预先接受它的产出形状

把 §14.2 与 §19.4/§19.5 放在一起看：主代理（vscode/cli）轮次总计约 34 个，分散在 5 个模型上，**每个模型都低于 n<20 门槛**；`state_5.sqlite` 的 `agent_role` 非空 0、`agent_nickname` 非空 1，代理身份基本只能靠 `session_meta.source` / `thread_source`（229/238）；全历史有跨度率 56.1%，旧时段仅 17.7%。

Codex 首版的诚实输出是"`codex-auto-review` 一行有数，主代理各模型全部落在样本不足区"。这不是缺陷，是本机数据的真实形状。**建议在 §1 或 §7 明写这句预期**，否则实施时会被当成 bug 追查。它的实现成本（轮内缓冲 + 复合身份去重 + 分时段覆盖率 + 估算标签）与样本产出比是四源里最差的；建议三源上线、用户实际看过效果后再决定 P4 是否执行。

### 5.2 ZCode-first 比计划描述的还要便宜，建议定义成一条垂直切片

`src/zcode-usage.js:138` 是 `SELECT * FROM model_usage ORDER BY completed_at, id` 配 `.iterate()`，`duration_ms`、`status`、`retry_count`、`cancelled_by_user`、`agent`、`model_id` 全部已在手里——**无需改 SQL、无需新读取链路、无跨文件去重**。`:95` 的 `timestampMsFor` 已按 `completed_at → started_at` 回退，与 §17.1 的 `ts_ms` 定义一致。

因此"建表 + v12 迁移 + ZCode 解析 + `summary.perf` + 一个 bar-list 模式"是一条可以独立跑通、独立验收的垂直切片，比 §10 把它拆成 P1.1–P1.5 五张卡更能提早暴露契约问题。**建议在 §10 显式定义这条切片为首个里程碑**，其验收标准就是"看板出现 ZCode 三代理 × 四模型的真实 TPS，且覆盖率恒等式成立"。

### 5.3 真正的风险不是算错，是不交付

这份计划已经消耗六遍只读全量扫描（其中两遍各扫 238–241 个 rollout、866MB），产品代码零行、`perf_samples`/`perf-stats`/`tokensPerSecond`/`time_to_first_token_ms` 在 `src/`、`public/`、`test/`、`scripts/` 中零命中。每一遍调查都找到一条需要补横幅的旧结论——这是好调查的特征，但也是这个项目当前的失效模式：**边际收益递减，而文档复杂度线性增长。**

调查该做的事已经做完了：它杀掉了六个错口径、确立了恒等式覆盖率、把估算与实测分开。剩下的问题（终态字段、tokenScope、Codex 分子/时窗对应关系）属于 §9 的待核实项，**在实现过程中用固定 fixture 验证比再跑一遍全量扫描更快也更准**。

**建议的下一步顺序**：登记（3.2）→ 归档历史章节（3.3）→ 修订 §5 四路表述与 §10 卡片映射（3.1、4.2）→ 冻结调查、固化 `scripts/perf-probe.mjs`（3.4）→ 实现 ZCode 垂直切片（5.2）。前四步都是纯文档，可以一次做完；第五步是唯一需要写产品代码的一步，也是唯一能让剩下的争议自动收敛的一步。

## 6. 本次核对的坐标（可复现）

以下坐标在 2026-10-04 只读核对，与计划表述一致：

| 计划声称 | 核对结果 |
| --- | --- |
| `STORE_SCHEMA_VERSION = 11`（§4、§13.1） | `src/usage-store.js:39` ✓；v11 迁移在 `:409-413` ✓；v12 未被占用（`docs/plans/` 内仅本计划提及 `usage-store`） |
| `groupedRange` / `allowedColumns`（§13.1） | `src/usage-store.js:808-809` ✓ |
| `requestFilters`、`/api/usage`、`includeDetails` 门控、`/api/summary`（§5、§13.1） | `src/server.js:74`、`:686`、`:746`、`:763` ✓；`view=dashboard` 确实关闭 details，§5"不能因 details 门控丢掉性能数据"是真约束 |
| ZCode `SELECT * FROM model_usage`（§14.4、§18.6） | `src/zcode-usage.js:138` ✓；`:95` `timestampMsFor` ✓ |
| OpenCode `timestampMsFor` 先取 `completed`（§14.1、§18.6） | `src/opencode-usage.js:58` ✓，`created` 仅作回退，确需同时取两者 |
| DSH 隐私注释原文（§6、§16.7 第 3 条） | `src/dsh-usage.js:236` 逐字一致 ✓；`docs/10-data-sources.md` 与 `docs/data-sources/*.md` 中 `TPS`/`吞吐`/`duration_ms`/`计时` **零命中**，故"零文档改动"成立 ✓ |
| DSH `row.time` 可用（§17.1 选项 C） | `src/dsh-usage.js:285` 已读 `numeric(row.time)` ✓；`:243` 全量 `rows` 在内存，建 `turn:step` 索引成本可忽略 ✓ |
| Codex 丢弃计时字段的位置（§18.6） | `src/usage-core.js:1147`、`:1518` 对非 `token_count` 直接 `continue` ✓；`:830` `parseRateLimitObservations` ✓；`:1142`/`:1513` 的 `turn_context` 只维护运行变量 `model`，**不记 `turn_id`**——§17.1 第 6 条要求的"精确 turn_context.turn_id 建模型表"确属新增逻辑 |
| `summaryFields` 白名单（§5、§13.1） | `test/three-path-parity.test.js:160` ✓，当前不含 perf |
| 统计模块的 import 方向（§5） | `src/` 已 import `public/usage-fields.js`、`public/pricing-models.js`、`public/timeline-utils.js`、`public/period-comparison.js` ✓，`public/` 不 import `src/` |

未核对项：任何实测 TPS 数值、覆盖率百分比、Codex item 计数字段在本机的存在性（§19.3 的 38473 条）、DSH zstd 解压结果。这些需要重新运行全量扫描，属 P0.1 的职责。
