# Agent Usage 文档入口

更新：2026-10-14（新增 D8u28-R4 几何裁切诊断记录）。现有功能、待办、计划与历史分别维护；历史稿不作为新的施工授权。

## 使用与接手

- [使用与启动](../README.md)与 [English](../README.en.md)：快速开始、看板功能、来源与隐私。
- [路线图与项目边界](01-roadmap.md)：已交付能力与后续工作的范围。
- [任务清单](02-tasks.md)：当前规划、尚未验证的边界与维护候选。
- [开发与接手](03-development.md)：代码入口、检查、PC 界面基准与历史验证规则。

## 当前计划

GPT-6.1 Sol 的 Codex / ChatGPT Work 500K 与全长度短档计费已于 2026-10-12 实施，规则见[计价说明](11-pricing.md)，前后影响与验证限制见[验收记录](validation/2026-10-12-codex-work-billing/README.md)，原[实施计划](archive/2026-10-12/gpt-6.1-sol-codex-work-billing-plan.md)保留归档。

[看板刷新性能修复方案与验收规格](plans/2026-10-09-dashboard-refresh-performance-plan.md)保留两轮复核的性能预算、早期容量验证、可恢复还原点及告警/历史/冻结约束。其 [Implementation Plan](plans/2026-10-09-dashboard-refresh-performance-implementation-plan.md)拆为 28 个基础单元、5 个条件单元，按 1 名主审与最多 3 名 worker 并发实施；共享文件单写者，每单元交审通过再释放依赖，不达标及时返工，容量/执行器只在实测触发时启用。状态：**已实施并逐卡验收**（2026-10-10 收口；`G_BASE`/`G_CAP`/`G_RESP` 三门口禁见账本，墙钟延迟 `:59`/`:77` 未达、`:60` 部分未达）。唯一施工进度表在 Implementation Plan 中；最终报告见[看板刷新性能修复最终报告](validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/FINAL-REPORT.md)。

[模型输出吞吐指标（TPS）计划](plans/2026-10-03-model-latency-throughput-plan.md)是已实现功能的规格入口。按来源/代理/模型展示历史输出吞吐及样本覆盖率，ZCode、DSH、OpenCode 使用请求端到端时长，Codex 使用明确标注的轮级 item 时窗估算；不交付 TTFT。M0–M8及TPS G4已于2026-10-08完成[最终独立审核](validation/2026-10-04-perf-metrics/20261004T035100/handoffs/M8.3-G4-主审最终复核-20261008.md)，见[M8 总览](validation/2026-10-04-perf-metrics/20261004T035100/handoffs/M8.md)与[最终审核包](validation/2026-10-04-perf-metrics/20261004T035100/final-audit.md)。旧调查和改判过程见[历史归档](archive/2026-10-04/model-tps-investigation-history.md)。

其[Implementation Plan](plans/2026-10-04-model-tps-implementation-plan.md)共9个模块、37张小卡，已实施并在原路径标完成；保留施工接口、证据和历史链接，不将正文的原施工顺序恢复成新任务。

用户于2026-10-08否决原TPS界面；新任务为[独立模型吞吐区域重构](plans/2026-10-08-tps-ui-restructure.md)，目前完整交互原型已完成，具体布局待用户审阅。旧 G4 是原受测版本的技术证据，不代替新设计接受。

[分享图片融合计划](plans/2026-10-03-mobile-share-card-consolidated-plan.md)是分享功能的唯一现行入口，状态为只做计划、未实施。生成界面面向 PC，产物面向普通读者；已确认总用量与常用模型优先、费用默认关闭且保持次要、有限自定义与缓存命中率可选，跟随当前皮肤统一浅色出图。人物位于角部或侧边、保持数据快速判读，隐藏后保留主题色；不设独立文案标题。完整十角色范围为 21 种主题组合；推荐 3:4 竖版和本地 PNG 保存。独立新名称、品牌标识与版式待收敛，不将设计方向确认视为已获实施或改名授权。

[皮肤配色融合方案](plans/2026-10-03-skin-palette-consolidated-plan.md)是配色工作的唯一现行入口，状态为只做方案、未实施。用户明确十套角色全部重设配色，已发布五套同样调整。融合风格策划、OKLCH 候选求解、实际背景可读性门槛与真实页面评审，推荐先试点 ChatGPT、Grok，再完成其余八套并统一协调；原两份草案已合并清理。

其[Implementation Plan](plans/2026-10-03-skin-palette-implementation-plan.md)已拆为 7 个模块、32 张任务卡，供其他 agent 按卡执行；包含文件归属、固定数据/API 契约、求解细节、真实页面检查和交接模板。实施计划已成文，工具与正式配色接入仍未执行。

## 现行专题

- [10 数据来源与统计口径](10-data-sources.md)：发现、导入、索引、范围、隐私与 TPS；各来源细节见 [Codex](data-sources/codex.md)、[ZCode](data-sources/zcode.md)、[DSH](data-sources/dsh.md)、[OpenCode](data-sources/opencode.md)。
- [11 计价与自动更新](11-pricing.md)：模型解析、免费/缺价、缓存场景、来源更新、手动覆盖与汇率。
- [12 看板行为](12-dashboard.md)：周期、排序、刷新、语言、主题、角色和聚光。
- [14 项目日志接入](14-project-log.md)：其他项目的 JSONL 字段、语义与最小校验。

旧 HTML 导出说明已融入[开发说明](03-development.md#旧-html-导出与历史验证)，不再维护独立专题。以上专题描述现有实现，TPS已完成最终审核；分享与配色方案状态仍由各自任务入口维护。

## 验证与归档

- [验证索引](validation/00-index.md)：按日期查看实际检查、脚本、截图和未测条件。
- [皮肤配色 M5.2.C-D8u28-R4 固定夹具验证](validation/2026-10-03-skin-palette-redesign/20261003T185748/handoffs/M5.2.C-D8u28-R4-fixed-fixtures.md)：31 条几何前提、G1–G11 和三个守卫通过；R1 的采样裁切断言疑似混用滚动前后坐标，完整验收保持 `NEEDS_REVIEW`。
- [看板刷新性能修复最终报告](validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/FINAL-REPORT.md)：逐卡交付/证据路径/复跑命令/未达标清单/已知限制；证据树唯一权威入口是同目录 [README.md](validation/2026-10-09-refresh-performance-fix/2026-10-09T0525+0800/README.md)（主审账本）。
- [旧导出清理验收](validation/2026-10-03-export-removal/README.md)：清理后在线冻结、导入、计价和皮肤回归。
- [v0.6.0 发布验收](validation/2026-10-03-release/README.md)：该次发布的五款皮肤与原在线/离线范围。
- [历史归档索引](archive/00-index.md)：已完成、已取消或被替代的计划与调查。
- [本轮文档整理](validation/2026-10-03-documentation-cleanup/README.md)：融合、迁移、删除与链接检查结果。

## 放置与维护

README 面向使用者；00—03 管导航、方向、任务与接手；专题描述长期行为。`plans/` 只放当前计划，状态由 02 指向，详细规格不多处复制。完成或被取代后，先提炼规则、转移遗留项，再归档原文并记录原因。

`validation/` 保留日期证据，不能用旧结果替代新版本验收；历史脚本按其对应 revision 使用。`archive/` 保留决策过程，归档不等于旧清单全部完成。`docs/README.md` 与根目录 `log-README.md` 保留为有引用的兼容导航页。
