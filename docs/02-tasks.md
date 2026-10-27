# 任务清单

更新：2026-10-27（预扫移除与真实读侧复测结果）。本页维护当前状态与未完成边界；长期行为见专题，实施过程和旧清单见归档。仅有对应证据时标记完成，不因文档归档或代码存在宣称已验收。

## 当前：自动刷新同步延迟

本轮后续见[预扫移除、状态切换与真实读侧投影复测](validation/2026-10-27-codex-refresh-followup/README.md)：**预扫移除已实施，状态专项 6/6 与既有回归 38/38 通过**。独立双 Store 按 AB/BA 交替，静止与 ledger-only 各 20 对，sync p95 分别为 3,660→2,904 ms、4,905→3,905 ms；绝对值不可与上轮单 Store 直接比较。同步 readSync 读量减少 170,361,023 bytes。

真实 executor 已确认同步期间新建临时 reader 的投影槽为空，回到长期 writer 后因 `total_changes` 变化而 miss；投影缓存未放宽。usage/perf 依赖与写入边界、读快照投影转交仍待研究，剩余优先级见本轮记录。

本轮浏览器 Claude / Codex 新文件 / Codex 普通追加 / ledger 四项控制正确；Codex 新文件 8,722 ms、普通追加 8,486 ms 均为当前 >8 s 反例，ledger-only 为 5,932 ms。这些控制样本不是新 p95；本轮未重跑 40 个真实周期。

217 个测试文件由首轮已完成部分与补跑分段覆盖；首轮 S1 旧断言失败，随后触及 900 s 超时，修正后尾段与整份 perf-store 共 316 pass / 0 fail，不能写成一次全绿。资源仍为 8 GiB 合计预算和单测试槽，未切生产、未提交或推送。

上一阶段已完成入选范围与复测，规格及剩余卡片见[Codex 增量可见等待与 TPS 计划 §12](plans/2026-10-27-codex-incremental-visibility-and-tps-plan.md#12-冻结版本的结果与后续研究边界)，证据见[实施与验收](validation/2026-10-27-codex-incremental-visibility/README.md)。后台 Codex p95 4.92→3.96 s，today/month 暖查询改善；40 个真实周期数值正确且新鲜度通过，但浏览器 Codex/TPS p95 6.01 s、ledger-only TPS 3.87 s，3 s 目标仍未达。这些结果归属上一阶段，不作为本版本的新分布。

状态（上一轮 v6）：**D/P、C/B/L、F、最小 E-1 及效果评估完成；当轮 G1/G2 和部分 G3 未达**。结果与下一优先级见[治理方案 §16](plans/2026-10-26-refresh-sync-latency-plan.md#16-本轮实施结果与后续优先级2026-10-27)，前像、原始样本、门禁和差距见[实施验收](validation/2026-10-26-refresh-sync-latency-implementation/README.md)，[原复测](validation/2026-10-26-refresh-sync-latency-reeval/README.md)只读。

上一轮 Main 与四个原生 subagent 的整文件单写协作已完成。静止 sync p95 8.13→2.81 s、同上下文 all 暖查询 685→70 ms；today/month 未改善。21 个真实周期的 15 次 token 增量和 5 次 ledger-only TPS 更新全部正确，但 Codex 新值仍需约 8.1–8.5 s。后台各 20 次 Claude/ledger/Codex p95 为 2.91/3.35/6.89 s。当轮下一优先级为缩小 Codex 规划范围、归因同轮重复探测，再处理 month/刷新后 miss；当前进展见上述本轮记录，不自动扩写产品。

所有本地验证共用一个串行执行窗口，任务总预算 8 GiB；真实树硬限 7 GiB、heap≤1.5 GiB，小夹具用 1 GiB。未重启正式服务或切换生产；当前真实副本 0 冷段，冷热语义由既有夹具回归，不能外推实际封存后的性能。分块存证、通用响应缓存、读侧架构及计价/归档扩展不纳入本轮默认范围。
## 当前：UI 几何稳定性

状态：**UI 施工与专项验收完成，报告字段契约失败已修复并通过定向回归**。设计要求见[主方案](plans/2026-10-25-ui-geometry-stability-plan.md)，施工交付唯一入口为[Implementation Plan](plans/2026-10-26-ui-geometry-stability-implementation-plan.md)；worker 均显式使用 `group/deepseek`，已关闭。实际检查见[验收](validation/2026-10-26-ui-geometry-stability.md)。

实施计划 15 张中等大小任务卡已完成：A 统一写入几何 CSS，B 交付生产样板、结构与文案；主审接回后期正式回归。16 项真实 UI 测试零失败零跳过，八组合主页面及四弹窗 40 图完成；类型、lint、最终格式和配色检查通过。HTTP 报告字段断言已包含现有 `pricingCatalog` 并补验快照一致性，报告相关 17 项与计价快照 1 项均通过；CLI 六字段不变。全仓首轮及后续复测分开登记，本次未重跑全仓。

文案约束立即生效，token 与生产样板先行；行高与间距按区域落实，正式测试按原定顺序后置。不因说明“可能有用”增加常驻提示，不为 `0.015625px` 改列结构，不用自动缩字号迁就框体。原测量数字的适用范围与修正结论见主方案 §8，不在本页复制历史快照。

## 当前：TPS 计量范围修订

状态：**v2内核已存在；2026-10-23展示修正与证据链验证正在逐卡验收**。当前施工入口为[双worker修复计划](plans/2026-10-23-tps-audit-remediation-implementation-plan.md)，进度与测试以[执行账本](validation/2026-10-23-tps-remediation/README.md)为准；[实测审计](../output/tps-audit/2026-10-23-tps-formula-audit.md)保留01:45历史快照并另列后续实施状态。provider拆行、排名门槛、成员日期/单位及当前方法覆盖已贯通内存/索引/API/界面；已有证据在临时库正常sync发布通过。真实索引未导入、用户服务未重启，原生逐请求时长与account/official精确外部对账仍缺输入，不宣称原生TPS已恢复。原[修订方案](plans/2026-10-21-tps-measurement-correction-plan.md)、[三worker执行单](plans/2026-10-21-tps-measurement-parallel-execution.md)和[只读调查证据](validation/2026-10-21-tps-scope-audit/README.md)保留历史。

## 当前：WorkBuddy 数据源

状态：**已实现，本机真实来源已验收（2026-10-21）**。规格见[WorkBuddy 数据源](data-sources/workbuddy.md)，评估与施工入口见[接入计划](plans/2026-10-21-workbuddy-source-plan.md)与[实施计划](plans/2026-10-21-workbuddy-implementation-plan.md)，证据见[验收记录](validation/2026-10-21-workbuddy-implementation/README.md)。

- 适配器 `src/workbuddy-usage.js`：`~/.workbuddy-ai/projects/<cwd-slug>/<sessionId>.jsonl`，按 `providerData.messageId` 去重；Auto（`model=default-model` 或 `requestModelName=auto`）整体排除，不计 token/费用/TPS。输入语义与 Claude Code 相反——`inputTokens` 已含缓存、`outputTokens` 已含推理，直接按超集口径映射，不做二次相加。
- 响应时长：`traces/<pid>/trace_*.jsonl` 中 `span.type = "generation"` 且 `status = "ok"` 的 `duration`（毫秒），用 `toolOutput[0].id` 关联 `messageId`；持久化到新表 `workbuddy_generation_durations`（`capture_version = workbuddy.trace.v1`）。
- 接线：`usage-core` 发现/分类/指纹/分派/报告/索引（内容判定必须排在 Claude Code 之前，两者目录形状相同）；`usage-store` schema 16→17、`usageFiles`、`harnessModels.WorkBuddy`；`perf-stats` 语义与 sampleKey（`["workbuddy", homeId, messageId]`）；`perf-sources` 注册；`server` 导入标签；前端 `sourceGroup` / `HARNESS_ORDER` / `bucketForChannel` / 限额排除 / i18n。
- 验证：新增 4 个测试文件 50 项（适配器 15、接线 13、索引 13、TPS 9）全绿；三路一致（内存 / SQLite / HTTP `/api/usage`）与真机冒烟结果见验收记录。真机 `~/.workbuddy-ai`：446 条事件 / 3 会话 / 69.98M 输入 / 281.6K 输出 / 446 个 TPS 样本，零告警，第二轮 `updatedFileCount = 0`。
- 残留边界：trace 只保留约 30 天，超窗记录没有时长，TPS 会少样本并以「N 个响应缺少 generation 时长」提示；会话文件被上游清理时看板同步删除对应历史（与 Codex 不同）。`perfSamples` 可能略多于事件数，因为 trace 表里会留下已被裁剪会话的 span。

## 当前：Claude Code 数据源

状态：**已实现，本机真实来源已验收（2026-10-20）**。规格见[Claude Code 数据源](data-sources/claude-code.md)，证据见[验收记录](validation/2026-10-20-claude-code-source/README.md)。

- 适配器 `src/claude-code-usage.js`：`~/.claude/projects/**/*.jsonl`（含 `subagents`），按 `message.id` 去重取 token 最大者，子代理并入主渠道 `Claude Code`，`input` 重构成 `input_tokens + cache_read + cache_creation` 超集。
- 接线：`usage-core` 发现/分类/指纹/分派/报告/索引；`usage-store` schema 14→15（表结构不变）、`usageFiles`、`harnessModels.Claude`；`server` 导入标签；前端 `sourceGroup` / `HARNESS_ORDER` / `bucketForChannel` / 限额排除 / i18n。
- 已确认口径：不借用旧 Claude 价，也不为 Claude 改 `src/pricing.js`。2026-10-20 起模型身份取**线路模型** `message.model`（`requestedModel` 只是 harness 别名/网关路由名），因此本机的 `mythos-magpie-*` 与 `claude-haiku-5-5` 都按真实上游 `deepseek-v4.1-flash`（含 `-sg` 后缀命中）计价，不再走未知模型回退；识别依据是转录 `message.id` = 网关账本 `response_id`（1,498/1,499，0 分歧）与逐项 token 计数（1,498/1,498 精确相等）两项独立核对，见[验收记录](validation/2026-10-20-claude-model-identity/README.md)。子代理计入并合并；TPS 见[Claude Code TPS 方案](plans/2026-10-21-claude-code-tps-plan.md)。
- 验证：`test/claude-code-usage.test.js` 10 项、`usage-core` 7 项、`usage-store` 3 项（含 v15→16 只标脏 Claude 的迁移）、三路一致 1 项、服务端导入 1 项，均通过；typecheck 通过；改动文件 lint/format 通过。完整套件 2,633 项：2,605 通过 / 8 失败 / 20 跳过，8 项均为既有问题（配额窗口 3 项 + 皮肤套件 5 项，见来源接入验收）。
- **验收（2026-10-20）**：本机 `~/.claude` 接入后，`GET /api/usage` 显示 `Main Claude Code` 活跃（1,167 事件 / 7 会话），`harnessModels.Claude` 4 个模型，渠道 `Claude` 独立成组，限额通道为空；headless Chromium 截图核对图例、模型视图、计价弹窗「缺少费率」、只选 Claude 时限额按钮禁用、TPS 列为「不支持来源」。子代理占事件 25.4% / tokens 24.2%。未点「重新匹配/保存并重算」（会写 `~/.codex-usage/pricing.json`）。另：`test/recent-selections.test.js` 3 项与 5 项皮肤套件在 HEAD 上即失败，属既有问题，未在本次修复。TPS 列为「不支持来源」是该次验收的历史快照，该结论已由[Claude Code TPS 方案](plans/2026-10-21-claude-code-tps-plan.md)取代。
- **Claude Code TPS：** 状态：**实施中：R1/K1/U1 已派发（2026-10-21），未验收**。按转录时间戳回退计算请求端到端 TPS，只对紧随 prompt/attachment 行的请求计时、同轮续写不采样，已纳入统一排名；施工与验收见[Claude Code TPS 实施计划](plans/2026-10-21-claude-code-tps-implementation-plan.md)，口径见[方案](plans/2026-10-21-claude-code-tps-plan.md)。

## 当前：看板刷新性能修复

2026-10-12 补充：GPT-6.1 Sol 的 Codex / Work 500K 能力说明及全长度短档计费已实施，无索引迁移。历史费用与耗时对比、已通过检查及全仓环境限制见[验收记录](validation/2026-10-12-codex-work-billing/README.md)。本次不替代下述刷新性能预算的既有未达标项。

状态：**已实施并逐卡验收（2026-10-10 收口）**。最终报告：[看板刷新性能修复最终报告](validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/FINAL-REPORT.md)（复跑命令、未达标清单与已知限制的单一入口）；证据树唯一权威入口是同目录 [README.md](validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/README.md)（主审账本，含逐卡 `ACCEPTED` 与取代链）。

**如实未达标（不许粉饰）**：计划 `:59` 今日默认刷新暖 p50 **1,520 ms** / p95 1,553 ms（目标 1,000/1,500）未达；`:77` 不变源暖 sync 墙钟 p50 ≈ **1,402 ms**（目标 800/1,100）未达，"全文解析 = 0" **待澄清**；`:60` **部分未达**（today/hour/local 命中 118/124 ms 达标，跨形状未命中 p95 **7,094 ms** 未达）；`:61` 单线程追加、P4 新库冷态、P8 CPU profile **未做**；`:70` 冷启动已有库首次打开 **7,081–7,086 ms**（无亚秒要求，但是最大的绝对延迟项）。**已达标**：`:62` 同步期轻量请求（p95 ≤ 100 / max ≤ 250：改前 429.2/431.5 ms → 改后 2.9/5.0/5.4 ms）、正确性（V1 A–G/K 与原版等价，白名单外差异 0）、容量（维持缺省 64 MiB）。[方案与验收规格](plans/2026-10-09-dashboard-refresh-performance-plan.md)维护正确性、性能和回退要求；[Implementation Plan](plans/2026-10-09-dashboard-refresh-performance-implementation-plan.md)为唯一施工入口，28 个基础单元、5 个实测触发的条件单元，按 1 名主审与最多 3 名 worker 并发。共享 store 单写者，计价/客户端/测量支线并行；worker 每卡交审，主审确认通过后续卡才能接续，不达标原卡及时返工。每卡多数 30–120 分钟，超预算先诊断并按行为边界拆小，不把整阶段交给一个 worker。

独立索引热修先行，完整基线通过后修热点、稳定失败与增量规划、读路径复用及网页响应。容量在增量阶段验证，必要持久化在该门禁内收口；独立执行器仅在残余阻塞实测触发时实施，不提前搭框架。

完整验收覆盖真实检查路径、单文件变更、失败隔离与恢复、冻结/计价/时钟、历史增长和内存；不以 TTL 命中、缩减归档数据或取消告警代替修复。本文仅登记计划状态，不将旧诊断的建议自动标为已实施，逐卡进度和审查证据只在 Implementation Plan 中维护。

## 当前：模型输出吞吐（TPS）

**2026-10-20 入口已删除：** 用户确认“按性能”不是 TPS 项目的实现路径，只是早期遗留入口；`#perfModeButton`、`#perfPanel`、`#perfDetailList`、对应渲染分支/样式/状态与浏览器性能视图测试已移除，时间图只剩渠道/模型/花销。当时保留数据侧；2026-10-21 新增 models 投影与独立区域接线，旧 groups/coverage/meta 行为保留。

**界面后续（2026-10-21）：** 当前以 [round5](validation/2026-10-20-tps-detail-panel-samples/round5.html)为视觉基线，[模型速度视图方案](plans/2026-10-20-model-speed-view-plan.md)已吸收本轮评审建议，[后续工作计划](plans/2026-10-21-model-speed-implementation-plan.md)分为数据、界面、集成验收三个模块、10 张小卡；用户本轮指定两位 worker 并授权实施，数据/界面及独立浏览器验收已完成；当前检查与服务激活边界见[实施账本](validation/2026-10-21-model-speed-implementation/README.md)。原优先级 SKIN → TPS → 计价 → SHARE 保留。[2026-10-08 稿](plans/2026-10-08-tps-ui-restructure.md)保留历史过程。下列 G4 结果只归属旧受测版本，不覆盖新界面。

状态：**功能已实现，M0–M8 收口，M8.3与TPS G4于2026-10-08通过最终独立审核**，见[主审裁定](validation/2026-10-04-perf-metrics/20261004T035100/handoffs/M8.3-G4-主审最终复核-20261008.md)。规格入口为[模型输出吞吐指标（TPS）计划](plans/2026-10-03-model-latency-throughput-plan.md)，实现细节见[来源与统计口径](10-data-sources.md)、来源专题与[看板行为](12-dashboard.md)。功能按来源、代理、模型展示 p10/p50/p90、样本量与覆盖率；ZCode/DSH/OpenCode 使用请求端到端时长，Codex 单列轮级 item 时窗估算，WorkBuddy 用 trace 中 generation span 的显式 `duration`（同为请求端到端，`timingSource = "explicit"`）；不交付 TTFT。

实施计划原地标完成并保留链接。M8.2已关闭真实Codex覆盖缺口，修复前四文件拒绝不能恢复成当前阻塞；后续CLI增量由主审定向复核覆盖，没有回滚其它任务。可靠归属坏线程隔离/degraded、Codex SQLite未启用、历史全仓两项symlink跳过继续保留，不扩写为未实现TPS或全仓重新通过。验收绑定报告中的受测摘要，不提前覆盖其它线程未来变更。入口：[M8 总览](validation/2026-10-04-perf-metrics/20261004T035100/handoffs/M8.md)、[最终审核包](validation/2026-10-04-perf-metrics/20261004T035100/final-audit.md)。

## 当前：分享图片规划

状态：**只做计划，未实施**。唯一规格入口为[融合计划](plans/2026-10-03-mobile-share-card-consolidated-plan.md)。已吸收独立方案的构图、材质、模块和验证建议：本地界面面向 PC，手机要求只针对分享图片，默认推荐 3:4，旧 HTML 导出不再兼容。2026-10-05 用户确认面向普通读者、总用量为主数字、常用模型为第二重点、费用默认关闭且开启后保持次要、有限自定义，以及当前皮肤统一浅色出图；完整十角色范围为 21 种主题组合。追加反馈明确人物占角部或侧边、不成为视觉中心，隐藏后仍保留主题色；不设独立文案标题或标题编辑；两个辅助指标位置需较完整候选，缓存命中率纳入首版可选项；拟建立新的独立品牌，名称待定。

下一步仍是方案与视觉样稿收敛。已建议人物/费用开关及八个辅助指标候选，具体集合、人物角位/边位、新品牌名称与标识、入口和格式数量尚待确定；费用默认关闭且次要、统一浅色、缓存命中率可选与无独立标题不再列为待定。此处不把产品取舍转为编码任务，也不执行项目改名或修改许可信息。

## 当前：皮肤配色实施与验收

状态：**十套 20 模式已接入，M6 整体仍未完成**。唯一规格入口为[皮肤配色融合方案](plans/2026-10-03-skin-palette-consolidated-plan.md)。产品 picker 仍只有 ChatGPT、Claude、DeepSeek、Kimi、Muse 五款。2026-10-20 当前代码新轮自动技术矩阵 900/900、关键几何 120/120，20 图 dense-data 视觉复查、classic、五款 picker 与在线冻结通过；大视口整页高度差 +16px 限制保留。目标机实际 OS 显示缩放/browser zoom 经用户确认未测，最终全仓工程门禁待独立登记，发布不在本轮。证据见[新轮验收](validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m62-reaccept-20261020/README.md)；旧正式 production CLI 只绑定旧迁移来源，见[CLI 兼容调查](validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m62-reaccept-20261020/engineering-gates/cli-compatibility.md)，不作为本轮通过门禁。

试点、十套候选生成、用户选择与正式接入均已完成；旧已发布五套的色值只保留为历史诊断/回退材料。十套正式色源与“picker 只开放五款”必须分开表述，不能把内部十套颜色写成十款已上线。候选报告仍不能替代本轮正式页面证据。

[Implementation Plan](plans/2026-10-03-skin-palette-implementation-plan.md)中的候选工具、十套选择、正式色值替换和首屏生成物已完成；延期五套仍不开放。剩余验收缺口是真机 OS 缩放/browser zoom，其余收口以本轮证据与独立工程门禁为准。自定义编辑器仍不接入主程序，PC 基准及已移除的旧 HTML 导出边界保持一致。

## 保留的视觉复核

- **聚光最终强度。** 当前 22% 与 reduced-motion 行为已有专项实现和验证，最终观感/强度仍待用户实际检查。归档未将该主观项标为已定稿；见[聚光证据](validation/2026-10-02-frame-spotlight/README.md)。
- **当前范围的联合复核。** v0.6.0 五款皮肤已交付，较早旧 P4 的十卡/离线/手机页面矩阵被后续范围取代；不宣称原整项已完成。后续若做联合复核，按五款皮肤、PC 缩放/侧栏/并排窗口及角色/聚光组合记录实际覆盖。已有发布与专项证据从[验证索引](validation/00-index.md)进入。
- **对比度与保留字标。** 旧 2026-10-03 的七条 textSecondary 告警仅作历史基线；当前 Agent Usage 弱对比字标经用户确认保留，不作为待修项。新轮自动技术矩阵不包含最终全仓工程门禁，不能据此写成全部对比度门禁通过。

自定义配色编辑器已被用户取消正式接入，不再列为实施任务；本地临时工作台不纳入主程序。十角色的内部素材/注册表仍保留，不据此扩展当前五款选择器范围。

## 来源、计价与验证候选

- **价目双 worker 实施计划（2026-10-26，21/23 卡已验收）。** 用户确认同时覆盖最新模型合并与官方计价、覆盖计数/费用详情、刷新状态与 FX 改进，见[统一实施计划](plans/2026-10-26-pricing-two-worker-implementation-plan.md)。W1 负责共用解析、目录、自动更新与服务，W2 负责聚合、缓存、时间图与界面；23 张约 15–20 分钟卡中 2 张来源扩展等待完整官方证据，前三批可独立验收。原始模型事实、现有混币修复与 TPS 维度保留，未知继续现行最低费率估算，不恢复旧 A/B 线路机制或新增模型入口。后端已合根，界面隔离通过后待共享 UI 窗口，来源扩展两卡等材料；见[验收与待合补丁](validation/2026-10-26-pricing/FINAL-REPORT.md)。

- **价目覆盖、代理线路与汇率（2026-10-24 计划统一修订）。** 原 2026-10-21/22 诊断快照保留，不视为最新价格或账单验证。费用采用 API 等价估算，历史按当前价目回算；交付顺序为费用可见性/状态说明/普通模型手动纠正、明确线路手动价、独立后台调度、逐提供商发现。自动缓存继续更新，手动字段优先且可撤销；账本差异检测为可选后续。统一边界与分批验收见[设计方案](plans/2026-10-22-pricing-coverage-and-route-pricing-plan.md)；[A 实施计划](plans/2026-10-24-pricing-implementation-A.md)由用户手动外派、外部 LLM 监工，成果回交 Codex 验收；[B 实施计划](plans/2026-10-24-pricing-implementation-B.md)由 Codex 监督两个用户指定的 worker。两线按约 15–20 分钟小卡并行。**2026-10-25：A经独立复核与修正，已与B联合通过隔离副本G1/G2/G3；最终318项定向测试、类型和lint通过，G4等完整来源证据。AB补丁当时检查可应用，但现已无法整包应用（两处冲突），详见[执行记录](validation/2026-10-24-pricing-implementation/README.md)。** 同日用户重定方向：pricing 不是账本而是「从金额看出满足感」的展示功能，不探测 plan、不按卖家定价；线路定价（原方案 §5）由[模型合并与官方价计价](plans/2026-10-25-model-merge-and-official-pricing.md)取代。**2026-10-25 用户决定：AB 补丁整包作废、不合并任何一行**（`routes` 与合并方案直接冲突，且补丁已无法整包应用），650 MB 产物在 `output/pricing-implementation-20261024/`（未跟踪、未 ignore）留作归档，不删除；「缺价模型手动补价」记为独立后继，不复用 AB 代码；「新增模型」入口本批不做。新方案已于 2026-10-26 按双 worker 计划开工，实际窗口与逐卡接受见新执行记录。
- **索引库 WAL 异常增长待修。** `~/.codex-usage/usage-index.sqlite-wal` 已涨到 **6.58 GB**（2026-10-21 08:25 复测，文档原记 5.4 GB），随轮询持续增长；根因是 executor 在整轮 sync 期间钉住读快照，提交时的自动 checkpoint 永远越不过它。归属、证据与修法见[WAL 增长诊断](validation/2026-10-21-wal-growth/wal-growth-diagnosis.md)。建议先做"sync 结束后 `wal_checkpoint(TRUNCATE)` + `journal_size_limit`"止血，再单独立项改快照生命周期。
- **历史保留与卷宗归档实施中（2026-10-22）。** 唯一施工入口：[Implementation Plan](plans/2026-10-22-history-retention-implementation-plan.md)；[执行账本](validation/2026-10-22-history-retention/README.md)记录主审监督的A/B/C三worker进度。先完成一致性备份与恢复、WAL收敛、源消失保留和成功修订保全，再做汇总对拍、冷热分卷/转移与归档界面。当前schema19，旧第二稿的v18落点、整轮指纹只读一次及费用汇总已保真结论均已修订。08点约一万行历史差额仍未定性；原[研究稿](plans/2026-10-21-history-retention-plan.md)保留为历史证据。
- **ZCode 缓存包含关系待核实。** 缺少上游写库证据，不能确认 input 是否包含缓存读写；保持当前映射。见 [ZCode 边界](data-sources/zcode.md#字段与渠道)。
- **缓存 TTL 明细待核实。** 当前来源未提供已核实的 TTL 字段，Claude 非零写入保留带提示的 5 分钟估算场景；不宣称支持精确的 1 小时或混合 TTL 账单。见[计价规则](11-pricing.md)。
- **真实来源专项 UI 待补证据。** 合成数据页面检查不能证明 DSH/OpenCode 真库的全部图例、提示和来源组合；新模型自动补录成功后的页面更新也需专项浏览器证据。相关后端已有回归，不据此勾选全部 UI 路径。旧候选来源见[归档 GPT 清单](archive/2026-10-01/gpt-6.1-sol-pricing-implementation-plan.md#v3-浏览器与三路验收)。

这些是验证边界与维护候选，没有新的实施排期。DSH 非零缓存写入和 SQLite v9/v10 迁移落点已在 Claude 批次修正，不再作为未解决问题；见[DSH 专题](data-sources/dsh.md#非零缓存写入已核实)及[Claude 验收](validation/2026-10-01-claude-pricing/README.md)。

## 已交付与已结束

- **源码包瘦身，2026-10-21。** `.gitattributes` 用 `export-ignore` 排除 `docs/validation/` 的日期证据与 `lineart assets/`（只保留测试要读的 `ink-bounds.json`）；`skins:check` 改为只验发布内容，新增 `skins:check:sources` 绑定 40 张作者源 PNG，源图缺失时打印 `SKIP`。`git archive --worktree-attributes | gzip -9` 实测 287.64 MB → 21.89 MB；plans/archive 按用户要求保留。发布包形态的树中 14 个读取日期证据或作者源图的用例改为显式跳过（`D6`、`D8u3B1`、`D9c`×3、`D9d-2`×4、`D9f-2`、`E1`、默认根资产读取 1 项、`skins:check:sources` 2 项），实测 2658 项 / 2624 通过 / 0 失败 / 34 跳过；[怎么跑测试](03-development.md#怎么跑测试)已重写。
- **旧 HTML 导出清理，2026-10-03。** 移除导出器、包脚本、离线分支与专属测试，保留在线冻结、JSON 汇总和现有功能；347 项测试与 28 项隔离桌面检查通过，见[验收](validation/2026-10-03-export-removal/README.md)。
- **角色皮肤与视觉修改，v0.6.0。** 五款选择器、浅深主题、简洁模式、双侧角色和聚光已交付；见[发布验收](validation/2026-10-03-release/README.md)。未确认观感与后续验证边界保留在上文。
- **Claude 计价。** 官方版本映射、缓存场景、手动覆盖、DSH 非零写入及索引迁移已实现；见[验收](validation/2026-10-01-claude-pricing/README.md)。
- **看板九项与追加反馈，v0.5.0。** 周期、排序、刷新、来源、模型退出、标题/工具栏及菜单修改已完成；规则见[看板行为](12-dashboard.md)，检查见[验证索引](validation/00-index.md)。
- **DSH/OpenCode 与共享计价基础。** 已进入统一事件、索引和统计；见[数据来源](10-data-sources.md)和[既有归档](archive/2026-10-01/00-index.md)。
- **Qoder 探索已终止。** 用户于 2026-10-02 取消接入；受测本机版本缺少 token 明细，不把 credits 反推为 token，不列为待办。见[历史探测](archive/2026-10-03/plans/2026-10-02-qoder-adaptation-outline.md)。
- **文档整理，2026-10-03。** 统一分享计划，归档 15 份旧稿，将旧导出说明融入开发文档并删除独立页。原文与链接完整性见[整理记录](validation/2026-10-03-documentation-cleanup/README.md)。

测试数量、价格与来源结构均为带日期证据，不是永久通过门槛。新问题先记录事实与复现，再确定范围；历史清单里的未勾选项不得自动恢复为当前任务。
