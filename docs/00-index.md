# Agent Usage 文档入口

更新：2026-10-29（TPS v4 本地切换）。现有功能、待办、计划与历史分别维护；历史稿不作为新的施工授权。

## 使用与接手

- [使用与启动](../README.md)与 [English](../README.en.md)：快速开始、看板功能、来源与隐私。
- [路线图与项目边界](01-roadmap.md)：已交付能力与后续工作的范围。
- [任务清单](02-tasks.md)：当前规划、尚未验证的边界与维护候选。
- [开发与接手](03-development.md)：代码入口、检查、[怎么跑测试](03-development.md#怎么跑测试)、PC 界面基准与历史验证规则。

## 当前计划

[TPS v4 本地切换](validation/2026-10-29-tps-cutover/README.md)：看板已切至包含 RANGE 的冻结快照 `abc831c025c1`、PID 28920，固定历史数值和页面资源核对通过，schema23 完整恢复点已保留。Codex release 已并排安装；用户已允许本次 Desktop 重启，实际引擎采用状态由[独立重启结果](validation/2026-10-29-tps-cutover/desktop-result.md)记录。下列“未部署/未重启”均是对应前轮验收的历史状态，不覆盖本次结果。

[Codex release 并排包与 helper 验收](validation/2026-10-29-codex-release/README.md)已完成：同源码 release 引擎、host、runner、setup 全部组包，四条原生采集闭环、真实 JavaScript、runner 正向执行/写隔离、setup RX ACL refresh 和 unelevated command/exec 通过。启动器 11/11，21 条 worker 配置匹配；原 debug 包、RANGE 和 UI 保留。纯本地运行，不依赖 Magpie；Desktop 实际采用、完整账号 provisioning 与 service SCM 模式未执行，未部署、未重启。

[本轮性能优化已切换生产](validation/2026-10-27-performance-production-cutover/README.md)：2026-10-27 按[切换与回滚方案](plans/2026-10-27-performance-production-cutover-plan.md)完成备份、回退包兼容核对和有限功能冒烟，当前运行 `852034b`、PID 42844。恢复点与回退包保留，服务树硬限 7 GiB、控制侧预算 1 GiB；未追加性能实验。

[Q2/Q3 投影复用施工计划](plans/2026-10-27-q2-q3-projection-implementation-plan.md)已完成局部验收，最终状态与后续范围见[主计划 §13](plans/2026-10-27-codex-incremental-visibility-and-tps-plan.md)和[验收记录](validation/2026-10-27-q2-q3-projection/README.md)：**Q2 静止/ledger-only 各 20/20 更快，配对合计节省中位数 801/875 ms；Q3 真实 executor 20/20 更快且接收，节省中位数 1,492 ms，收益不相加。v4 完整门禁通过，正常 60 s 浏览器各 3 次、共 6 次完成且数值/TPS 正确，最终 SHA 核验与清理完成；整体 max 与新鲜度目标未达，浏览器 p95 未验；其后已另行完成上述生产切换。** 资源预算为 7 GiB 重任务 + 1 GiB 控制侧。后续性能实验已按用户要求暂停；普通追加、perf 与 N2 研究仅保留为候选，不继续执行。

[模型生成速度 TPS 调整方案](plans/2026-10-27-generation-tps-plan.md)按用户要求改为**仅依靠工具原生本机记录**，Magpie 只作采集方法参考。通用 v3 内核与请求级采样已实现；前轮依赖 Magpie 的完成结论撤回，运行链路已移除其读取、导入和指纹，当前原生采集仍未完成，未部署。各来源的真实能力和缺口见[原生计时核验](validation/2026-10-28-native-generation-timing/README.md)；[前轮工程结果](validation/2026-10-28-generation-tps/README.md)保持版本归属，不代替本轮验收。页面保持现有简洁布局。

[原生生成计时深入探索与实施计划](plans/2026-10-28-native-generation-timing-plan.md)已进入首批施工：Codex 独立 SSE/WS producer 补丁及本仓 reader、WorkBuddy 现有纯正文恢复、DSH 条件计数映射与原生流 reader 已整合，见[实施验收](validation/2026-10-29-native-generation-implementation/README.md)。WorkBuddy 最终 reader 在真实历史恢复 17 条样本；Codex 未替换普通安装引擎，DSH 可选 reasoning 字段尚无实际返回证据；六来源普通安装覆盖未完成，未部署。[探索验收](validation/2026-10-28-native-generation-timing/discovery/README.md)与本轮工程检查分别记录，不依赖 Magpie。

[普通 Codex 安装与 DSH 官方 usage 核验](validation/2026-10-29-installed-generation-validation/README.md)已完成本轮检查：普通 CLI/Desktop 引擎缺生成摘要，隔离补丁版完整构建及 22 个本地路径通过；一次获准的 DSH 官方请求成功，但两个 usage 事件均缺 reasoning 明细。该结果收紧后继实施条件，不代表采集覆盖已全部完成；RANGE 改动保留，未部署。

[Codex 普通安装接入与 DSH 后续方案](plans/2026-10-29-local-generation-adoption-plan.md)已完成本轮本地实现与[隔离验收](validation/2026-10-29-local-generation-implementation/README.md)：完整并排包和 CLI/Desktop 启动器、DSH 官方全部生成 reader、v4 数值/排名分离及 v3 Codex/WorkBuddy 归档恢复已接通。DSH 881 个官方候选中 870 个有效、8 个无正窗口、3 个身份冲突。Codex 四条本地 SSE/WS 闭环、rg/code-mode host 协议及非管理员沙箱 command/exec 通过；Desktop 实际采用及 elevated runner/service 尚未验证。RANGE 保留，产品前端零改动，未部署。[前期研究](validation/2026-10-29-local-generation-adoption/README.md)保持原版本归属。

[预扫移除、状态切换与真实读侧投影复测](validation/2026-10-27-codex-refresh-followup/README.md)记录 Q2/Q3 施工前阶段：预扫移除已实施，状态专项 6/6 与既有回归 38/38 通过。独立双 Store 按 AB/BA 交替，静止与 ledger-only 各 20 对，sync p95 分别为 3,660→2,904 ms、4,905→3,905 ms；绝对值不可与上轮单 Store 直接比较。同步 readSync 读量减少 170,361,023 bytes。真实 executor 已确认临时 reader 投影空槽与 writer 的 `total_changes` miss，投影缓存未放宽。

该阶段浏览器四项控制正确，Codex 新文件 8,722 ms、普通追加 8,486 ms 均为当轮 >8 s 反例，ledger-only 为 5,932 ms；这是控制样本，不是新 p95，未重跑 40 周期。217 个测试文件为分段覆盖：首轮 S1 旧断言失败并触及 900 s 超时，修正后尾段与整份 perf-store 共 316 pass / 0 fail，不能写成一次全绿。未切生产、未提交或推送。

上一阶段的[Codex 增量可见等待与 TPS 后续优化](plans/2026-10-27-codex-incremental-visibility-and-tps-plan.md)入选范围已实施并复测：大 home 有界前缀 worker 与 timeline 分组融合，后台 Codex p95 4.92→3.96 s，today/month 暖查询改善。40 个真实周期数值/目标帧全部正确，新鲜度通过；可见 p95 仍为 Codex 6.01 s、ledger-only TPS 3.87 s，3 s 目标未达。完整门禁、8 GiB 资源、输入 SHA、保留事实与清理见[实施与验收](validation/2026-10-27-codex-incremental-visibility/README.md)。预扫移除阶段裁定见上述复测；Q2/Q3 当前进展见本轮施工与验收入口；该阶段的 40 周期结果保持版本归属。

[自动刷新同步延迟治理方案](plans/2026-10-26-refresh-sync-latency-plan.md)已收口为 **v6：入选范围实施完成，延迟部分未达**。D/P、增量 Magpie、定向发布、ledger-only、quota busy 与最小 all perf 投影已完成；同源静止 sync p95 8.13→2.81 s，同上下文 all 暖查询 685→70 ms。21 个真实周期新值均正确，Codex 可见等待仍约 8.1–8.5 s；G1/G2 及部分 G3 未达。下一优先级见方案 §16，最终数据与工程门禁见[实施验收](validation/2026-10-26-refresh-sync-latency-implementation/README.md)。原生多 agent 编写、整文件单写和唯一测试槽均已执行，合计 8 GiB；[旧复测](validation/2026-10-26-refresh-sync-latency-reeval/README.md)只读。未切换生产，继续暂缓分块存证、通用缓存及读侧架构。

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

[历史保留与转移操作](history-retention.md)提供备份、候选、正式提交、完整包导入/独立实例、HTTP和恢复用法。[Implementation Plan](plans/2026-10-22-history-retention-implementation-plan.md)定义施工契约；当前 **20/20 已完成**，容量差距、最终门禁及未证边界见[执行账本](validation/2026-10-22-history-retention/README.md)和[操作交付](validation/2026-10-22-history-retention/usage-and-restore.md)。交付不等于生产封存/迁移或原性能目标全部达标。旧第二稿保留研究过程，不作为已验收实现。

## 现行专题

- [10 数据来源与统计口径](10-data-sources.md)：发现、导入、索引、范围、隐私与 TPS；各来源细节见 [Codex](data-sources/codex.md)、[ZCode](data-sources/zcode.md)、[DSH](data-sources/dsh.md)、[OpenCode](data-sources/opencode.md)、[Claude Code](data-sources/claude-code.md)、[WorkBuddy](data-sources/workbuddy.md)。
- [11 计价与自动更新](11-pricing.md)：模型解析、免费/缺价、缓存场景、来源更新、手动覆盖与汇率。
- [12 看板行为](12-dashboard.md)：周期、排序、刷新、语言、主题、角色和聚光。
- [14 项目日志接入](14-project-log.md)：其他项目的 JSONL 字段、语义与最小校验。

旧 HTML 导出说明已融入[开发说明](03-development.md#旧-html-导出与历史验证)，不再维护独立专题。旧版 TPS 的最终审核仅适用于对应历史版本；当前生成速度与分享、配色方案的状态分别由各自任务入口维护。

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
