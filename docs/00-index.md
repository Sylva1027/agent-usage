# Agent Usage 文档入口

更新：2026-10-26（修订自动刷新同步延迟计划的证据与优先级）。现有功能、待办、计划与历史分别维护；历史稿不作为新的施工授权。

## 使用与接手

- [使用与启动](../README.md)与 [English](../README.en.md)：快速开始、看板功能、来源与隐私。
- [路线图与项目边界](01-roadmap.md)：已交付能力与后续工作的范围。
- [任务清单](02-tasks.md)：当前规划、尚未验证的边界与维护候选。
- [开发与接手](03-development.md)：代码入口、检查、[怎么跑测试](03-development.md#怎么跑测试)、PC 界面基准与历史验证规则。

## 当前计划

[自动刷新同步延迟治理方案](plans/2026-10-26-refresh-sync-latency-plan.md)于 2026-10-26 完成 v2 静态复核修订：区分原报告历史测量、代码已确认路径与待复测归因，撤回前端数秒空窗已定位、无条件每轮全文哈希、缓存即可证明刷新达标等结论，修正摘要复用与分块哈希验收条件。优先级为新实例基线 → 映射复制/重复同步去重 → 增量 Magpie 与折叠复用 → 按残余证据选择前端、哈希、查询及读写解耦/缓存。真实新数据可见时间、用户等待和后台成本分别验收。**本轮仅修文档，未改产品代码、未运行性能探针、未重启服务；等历史保留计划完成后按 §15 复测并决定实施范围，前端小修也不提前开工。**

[价目覆盖与汇率：双 worker Implementation Plan](plans/2026-10-26-pricing-two-worker-implementation-plan.md)是 2026-10-26 新施工入口：用户确认同时纳入模型合并与官方价、覆盖、刷新状态和 FX 改进。23 张约 15–20 分钟小卡按价目/服务与聚合/界面分给两位现有 worker；其中 2 张官方来源扩展卡等完整证据，前三批独立交付。本批 21/23 卡已验收：后端已合根，界面通过真实根副本与浏览器验收、等待共享 UI 窗口；来源扩展两卡待材料，见[验收](validation/2026-10-26-pricing/FINAL-REPORT.md)。旧 A/B 整包作废的决定保持。

[价目覆盖、代理线路与汇率计划](plans/2026-10-22-pricing-coverage-and-route-pricing-plan.md)：保留 2026-10-21/22 的只读诊断与价格快照，2026-10-24 已合并两轮评审并统一交付顺序。采用 API 等价估算与当前价目回算；先做未知份额、普通模型手动纠正和刷新状态说明，再分批支持明确线路手动价、独立后台调度及逐提供商发现。自动缓存继续更新、手动字段优先，账本仅作可选离线核验。[A 实施计划](plans/2026-10-24-pricing-implementation-A.md)交用户手动派给外部 agent，负责界面与交互；[B 实施计划](plans/2026-10-24-pricing-implementation-B.md)由 Codex 监督两个用户指定的 worker，负责内核、存储与服务。按约 15–20 分钟小卡并行开发，A 成果回交 Codex 验收。**2026-10-25：A经独立复核与修正，已与B联合通过隔离副本G1/G2/G3；最终318项定向测试、类型和lint通过，G4等完整来源证据。AB补丁当时检查可应用，但现已无法整包应用（两处冲突），详见[执行记录](validation/2026-10-24-pricing-implementation/README.md)。** 同日用户重定方向：pricing 是「从金额看出满足感」的展示功能，不探测 plan、不按卖家定价。线路定价（原方案 §5）由[模型合并与官方价计价](plans/2026-10-25-model-merge-and-official-pricing.md)取代——同一模型的多条命名（`<provider>/` 前缀、`-sg` 后缀、`group/<id>`、官方改名）在投影层合并成一行，统一按官方 API 价含峰谷计价。2026-10-25 用户决定 **AB 补丁整包作废、不合并任何一行**，产物留作归档；「缺价模型手动补价」记为独立后继。新方案已于 2026-10-26 按双 worker 计划开工，实际窗口与逐卡接受见新执行记录。

[TPS 计量口径修订与历史恢复方案](plans/2026-10-21-tps-measurement-correction-plan.md)保留v1范围错配与v2修订过程；当前源码已具备按请求证据关联的v2内核，旧认证仅覆盖已审核的326请求批次。2026-10-23后续[双worker修复计划](plans/2026-10-23-tps-audit-remediation-implementation-plan.md)正在逐卡验收provider拆行、排名门槛、实际日期/单位、Codex覆盖解释与证据发布链路，状态见[执行账本](validation/2026-10-23-tps-remediation/README.md)。原生请求时长及DSH account/official外部计量仍有证据缺口，不能由旧G4或展示验收替代。

GPT-6.1 Sol 的 Codex / ChatGPT Work 500K 与全长度短档计费已于 2026-10-12 实施，规则见[计价说明](11-pricing.md)，前后影响与验证限制见[验收记录](validation/2026-10-12-codex-work-billing/README.md)，原[实施计划](archive/2026-10-12/gpt-6.1-sol-codex-work-billing-plan.md)保留归档。

[看板刷新性能修复方案与验收规格](plans/2026-10-09-dashboard-refresh-performance-plan.md)保留两轮复核的性能预算、早期容量验证、可恢复还原点及告警/历史/冻结约束。其 [Implementation Plan](plans/2026-10-09-dashboard-refresh-performance-implementation-plan.md)拆为 28 个基础单元、5 个条件单元，按 1 名主审与最多 3 名 worker 并发实施；共享文件单写者，每单元交审通过再释放依赖，不达标及时返工，容量/执行器只在实测触发时启用。状态：**已实施并逐卡验收**（2026-10-10 收口；`G_BASE`/`G_CAP`/`G_RESP` 三门口禁见账本，墙钟延迟 `:59`/`:77` 未达、`:60` 部分未达）。唯一施工进度表在 Implementation Plan 中；最终报告见[看板刷新性能修复最终报告](validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/FINAL-REPORT.md)。

[模型输出吞吐指标（TPS）计划](plans/2026-10-03-model-latency-throughput-plan.md)是已实现功能的规格入口。按来源/代理/模型展示历史输出吞吐及样本覆盖率，ZCode、DSH、OpenCode 使用请求端到端时长，Codex 使用明确标注的轮级 item 时窗估算；不交付 TTFT。M0–M8及TPS G4已于2026-10-08完成[最终独立审核](validation/2026-10-04-perf-metrics/20261004T035100/handoffs/M8.3-G4-主审最终复核-20261008.md)，见[M8 总览](validation/2026-10-04-perf-metrics/20261004T035100/handoffs/M8.md)与[最终审核包](validation/2026-10-04-perf-metrics/20261004T035100/final-audit.md)。旧调查和改判过程见[历史归档](archive/2026-10-04/model-tps-investigation-history.md)。

其[Implementation Plan](plans/2026-10-04-model-tps-implementation-plan.md)共9个模块、37张小卡，已实施并在原路径标完成；保留施工接口、证据和历史链接，不将正文的原施工顺序恢复成新任务。

用户于2026-10-08否决原 TPS 界面；当前视觉基线为 [round5](validation/2026-10-20-tps-detail-panel-samples/round5.html)，产品口径见[模型速度视图方案](plans/2026-10-20-model-speed-view-plan.md)。[2026-10-21 后续工作计划](plans/2026-10-21-model-speed-implementation-plan.md)拆为数据、界面、集成验收三个模块、10 张小卡，已完成数据和独立界面实现，并通过隔离生产链路与整页浏览器验收；工程门禁及旧服务激活边界见[实施账本](validation/2026-10-21-model-speed-implementation/README.md)。[旧重构稿](plans/2026-10-08-tps-ui-restructure.md)留作历史。旧 G4 不代替新界面验收。

[分享图片融合计划](plans/2026-10-03-mobile-share-card-consolidated-plan.md)是分享功能的唯一现行入口，状态为只做计划、未实施。生成界面面向 PC，产物面向普通读者；已确认总用量与常用模型优先、费用默认关闭且保持次要、有限自定义与缓存命中率可选，跟随当前皮肤统一浅色出图。人物位于角部或侧边、保持数据快速判读，隐藏后保留主题色；不设独立文案标题。完整十角色范围为 21 种主题组合；推荐 3:4 竖版和本地 PNG 保存。独立新名称、品牌标识与版式待收敛，不将设计方向确认视为已获实施或改名授权。

[皮肤配色融合方案](plans/2026-10-03-skin-palette-consolidated-plan.md)是配色工作的现行规格入口。十套角色的浅深 20 个模式已按用户选定颜色接入正式 `public/skin-palettes.js`，当前 picker 仍只开放原五款。2026-10-20 当前代码重新验收取得自动技术矩阵 900/900、关键几何 120/120，20 图 dense-data 复查及 classic、五款 picker、在线冻结通过；大视口整页高度差 +16px 限制保留。整体仍为 incomplete：目标机真实 OS 显示缩放/browser zoom 经用户确认未测。最终全仓工程门禁待独立登记，发布不在本轮范围。证据见[新轮验收](validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m62-reaccept-20261020/README.md)；旧正式 production CLI 只绑定旧迁移来源，见[CLI 兼容调查](validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m62-reaccept-20261020/engineering-gates/cli-compatibility.md)，不作为本轮通过门禁。

其[Implementation Plan](plans/2026-10-03-skin-palette-implementation-plan.md)中的候选生成、十套选择与 20 模式正式接入已完成；实施顺序和固定契约仍保留。M6 整体仍未完成，旧 `--production` 不能写成当前新轮通过。

## 当前：UI 几何稳定性

[UI 几何稳定性计划](plans/2026-10-25-ui-geometry-stability-plan.md)为设计规格入口，[双 worker Implementation Plan](plans/2026-10-26-ui-geometry-stability-implementation-plan.md)记录 15 张任务卡的交付。状态：**UI 施工与专项验收完成，报告字段契约失败已修复并通过定向回归**。16 项真实 UI 回归、八组合主页面及四弹窗 40 图、类型/lint/格式/配色检查完成；报告相关 17 项及计价快照 1 项通过，分次全仓结果见[验收](validation/2026-10-26-ui-geometry-stability.md)。worker 均显式使用 `group/deepseek`，已关闭；主审完成后期测试与整合。机制说明默认收起、陶瓷视觉和主列结构保留，不自动缩字号。旧测量记录的适用范围及技术纠错见主方案 §8。

## 当前：历史保留实施

[历史保留与转移操作](history-retention.md)提供备份、候选、正式提交、完整包导入/独立实例、HTTP和恢复用法。[Implementation Plan](plans/2026-10-22-history-retention-implementation-plan.md)定义施工契约；当前18/20，剩余容量及最终门禁，主审状态见[执行账本](validation/2026-10-22-history-retention/README.md)。旧第二稿保留研究过程，不作为已验收实现。

## 现行专题

- [10 数据来源与统计口径](10-data-sources.md)：发现、导入、索引、范围、隐私与 TPS；各来源细节见 [Codex](data-sources/codex.md)、[ZCode](data-sources/zcode.md)、[DSH](data-sources/dsh.md)、[OpenCode](data-sources/opencode.md)、[Claude Code](data-sources/claude-code.md)、[WorkBuddy](data-sources/workbuddy.md)。
- [11 计价与自动更新](11-pricing.md)：模型解析、免费/缺价、缓存场景、来源更新、手动覆盖与汇率。
- [12 看板行为](12-dashboard.md)：周期、排序、刷新、语言、主题、角色和聚光。
- [14 项目日志接入](14-project-log.md)：其他项目的 JSONL 字段、语义与最小校验。

旧 HTML 导出说明已融入[开发说明](03-development.md#旧-html-导出与历史验证)，不再维护独立专题。以上专题描述现有实现，TPS已完成最终审核；分享与配色方案状态仍由各自任务入口维护。

## 验证与归档

- [验证索引](validation/00-index.md)：按日期查看实际检查、脚本、截图和未测条件。
- [皮肤配色当前代码重新验收](validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m62-reaccept-20261020/README.md)：十套 900/900、关键几何 120/120、20 图 dense-data 复查及 classic、五款 picker、在线冻结通过；整体 `incomplete`，真实 OS 缩放/browser zoom 未测，+16px 大视口高度差单列保留。旧 production CLI 绑定旧迁移来源，不能作为本轮通过门禁。
- [皮肤配色 M5.2.C-D8u28-R4 固定夹具验证](validation/2026-10-03-skin-palette-redesign/20261003T185748/handoffs/M5.2.C-D8u28-R4-fixed-fixtures.md)：31 条几何前提、G1–G11 和三个守卫通过；R1 的采样裁切断言疑似混用滚动前后坐标，完整验收保持 `NEEDS_REVIEW`。
- [看板刷新性能修复最终报告](validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/FINAL-REPORT.md)：逐卡交付/证据路径/复跑命令/未达标清单/已知限制；证据树唯一权威入口是同目录 [README.md](validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/README.md)（主审账本）。
- [WorkBuddy 数据源验收](validation/2026-10-21-workbuddy-implementation/README.md)：适配器、接线、索引与 TPS 全部落地；三路一致与真机 446 事件 / 446 TPS 样本通过。
- [旧导出清理验收](validation/2026-10-03-export-removal/README.md)：清理后在线冻结、导入、计价和皮肤回归。
- [v0.7.0 发布验收](validation/2026-10-21-release/README.md)：来源、配色、刷新恢复及 README 示例图。
- [v0.6.0 发布验收](validation/2026-10-03-release/README.md)：该次发布的五款皮肤与原在线/离线范围。
- [历史归档索引](archive/00-index.md)：已完成、已取消或被替代的计划与调查。
- [本轮文档整理](validation/2026-10-03-documentation-cleanup/README.md)：融合、迁移、删除与链接检查结果。

## 放置与维护

README 面向使用者；00—03 管导航、方向、任务与接手；专题描述长期行为。`plans/` 只放当前计划，状态由 02 指向，详细规格不多处复制。完成或被取代后，先提炼规则、转移遗留项，再归档原文并记录原因。

`validation/` 保留日期证据，不能用旧结果替代新版本验收；历史脚本按其对应 revision 使用。`archive/` 保留决策过程，归档不等于旧清单全部完成。`docs/README.md` 与根目录 `log-README.md` 保留为有引用的兼容导航页。
