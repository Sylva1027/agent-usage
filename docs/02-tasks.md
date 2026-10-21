# 任务清单

更新：2026-10-21（WorkBuddy 数据源已实施）。本页维护当前状态与未完成边界；长期行为见专题，实施过程和旧清单见归档。仅有对应证据时标记完成，不因文档归档或代码存在宣称已验收。

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
- 已确认口径：不借用旧 Claude 价，也不为 Claude 改 `src/pricing.js`。2026-10-20 起模型身份取**线路模型** `message.model`（`requestedModel` 只是 harness 别名/网关路由名），因此本机的 `mythos-magpie-*` 与 `claude-haiku-5-5` 都按真实上游 `deepseek-v4.1-flash`（含 `-sg` 后缀命中）计价，不再走未知模型回退；识别依据是转录 `message.id` = 网关账本 `response_id`（1,498/1,499，0 分歧）与逐项 token 计数（1,498/1,498 精确相等）两项独立核对，见[验收记录](validation/2026-10-20-claude-model-identity/README.md)。子代理计入并合并；不做 TPS（转录无请求时长）。
- 验证：`test/claude-code-usage.test.js` 10 项、`usage-core` 7 项、`usage-store` 3 项（含 v15→16 只标脏 Claude 的迁移）、三路一致 1 项、服务端导入 1 项，均通过；typecheck 通过；改动文件 lint/format 通过。完整套件 2,633 项：2,605 通过 / 8 失败 / 20 跳过，8 项均为既有问题（配额窗口 3 项 + 皮肤套件 5 项，见来源接入验收）。
- **验收（2026-10-20）**：本机 `~/.claude` 接入后，`GET /api/usage` 显示 `Main Claude Code` 活跃（1,167 事件 / 7 会话），`harnessModels.Claude` 4 个模型，渠道 `Claude` 独立成组，限额通道为空；headless Chromium 截图核对图例、模型视图、计价弹窗「缺少费率」、只选 Claude 时限额按钮禁用、TPS 列为「不支持来源」。子代理占事件 25.4% / tokens 24.2%。未点「重新匹配/保存并重算」（会写 `~/.codex-usage/pricing.json`）。另：`test/recent-selections.test.js` 3 项与 5 项皮肤套件在 HEAD 上即失败，属既有问题，未在本次修复。

## 当前：看板刷新性能修复

2026-10-12 补充：GPT-6.1 Sol 的 Codex / Work 500K 能力说明及全长度短档计费已实施，无索引迁移。历史费用与耗时对比、已通过检查及全仓环境限制见[验收记录](validation/2026-10-12-codex-work-billing/README.md)。本次不替代下述刷新性能预算的既有未达标项。

状态：**已实施并逐卡验收（2026-10-10 收口）**。最终报告：[看板刷新性能修复最终报告](validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/FINAL-REPORT.md)（复跑命令、未达标清单与已知限制的单一入口）；证据树唯一权威入口是同目录 [README.md](validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/README.md)（主审账本，含逐卡 `ACCEPTED` 与取代链）。

**如实未达标（不许粉饰）**：计划 `:59` 今日默认刷新暖 p50 **1,520 ms** / p95 1,553 ms（目标 1,000/1,500）未达；`:77` 不变源暖 sync 墙钟 p50 ≈ **1,402 ms**（目标 800/1,100）未达，"全文解析 = 0" **待澄清**；`:60` **部分未达**（today/hour/local 命中 118/124 ms 达标，跨形状未命中 p95 **7,094 ms** 未达）；`:61` 单线程追加、P4 新库冷态、P8 CPU profile **未做**；`:70` 冷启动已有库首次打开 **7,081–7,086 ms**（无亚秒要求，但是最大的绝对延迟项）。**已达标**：`:62` 同步期轻量请求（p95 ≤ 100 / max ≤ 250：改前 429.2/431.5 ms → 改后 2.9/5.0/5.4 ms）、正确性（V1 A–G/K 与原版等价，白名单外差异 0）、容量（维持缺省 64 MiB）。[方案与验收规格](plans/2026-10-09-dashboard-refresh-performance-plan.md)维护正确性、性能和回退要求；[Implementation Plan](plans/2026-10-09-dashboard-refresh-performance-implementation-plan.md)为唯一施工入口，28 个基础单元、5 个实测触发的条件单元，按 1 名主审与最多 3 名 worker 并发。共享 store 单写者，计价/客户端/测量支线并行；worker 每卡交审，主审确认通过后续卡才能接续，不达标原卡及时返工。每卡多数 30–120 分钟，超预算先诊断并按行为边界拆小，不把整阶段交给一个 worker。

独立索引热修先行，完整基线通过后修热点、稳定失败与增量规划、读路径复用及网页响应。容量在增量阶段验证，必要持久化在该门禁内收口；独立执行器仅在残余阻塞实测触发时实施，不提前搭框架。

完整验收覆盖真实检查路径、单文件变更、失败隔离与恢复、冻结/计价/时钟、历史增长和内存；不以 TTL 命中、缩减归档数据或取消告警代替修复。本文仅登记计划状态，不将旧诊断的建议自动标为已实施，逐卡进度和审查证据只在 Implementation Plan 中维护。

## 当前：模型输出吞吐（TPS）

**2026-10-20 入口已删除：** 用户确认“按性能”不是 TPS 项目的实现路径，只是早期遗留入口；`#perfModeButton`、`#perfPanel`、`#perfDetailList`、对应渲染分支/样式/状态与浏览器性能视图测试已移除，时间图只剩渠道/模型/花销。数据侧（`summary.perf.groups`、`src/perf-stats.js`、`src/perf-sources/*`、`public/perf-ui.js` 及其测试）保持不变，等独立吞吐区域方案恢复后再接 UI。

**界面后续：** 用户于2026-10-08否决原入口与信息布局，已选独立模型吞吐区域。[重构方案与交互原型](plans/2026-10-08-tps-ui-restructure.md)已完成，具体布局待用户审阅；正式页面尚未替换。下列 G4 结果保留原受测版本归属，不表示用户接受原 UI，也不覆盖新界面。

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
