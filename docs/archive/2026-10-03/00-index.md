# 2026-10-03 归档索引

本批归档 15 份原计划、TODO 和方案稿。原文保留，只增加历史说明并修复相对链接；原内容哈希与结构一致性检查见[整理记录](../../validation/2026-10-03-documentation-cleanup/README.md)。归档表示不再作为当前施工入口，不表示每个旧待办都已完成。

## 分享参考稿

四稿融合为[分享图片融合计划](../../plans/2026-10-03-mobile-share-card-consolidated-plan.md)，状态仍为只做计划。保留原稿的不同思考角度：

- [产品设计简报](plans/2026-10-03-share-experience-design-brief.md)：信息层级、PC/图片使用场景、阅读尺度与后续校准。
- [独立技术方案](plans/2026-10-03-mobile-share-card-plan.md)：布局、材质、模块、边界和测试建议。
- [原收敛方案](plans/2026-10-03-mobile-share-card-consolidated-plan.md)：工程分层与里程碑草案。
- [原 TODO](plans/2026-10-03-mobile-share-card-todos.md)：原阶段检查清单。

原稿中的“已拍板”、4:5/9:16 同步实现、离线 HTML 内联和手机页面验收不再作为现行要求；实际授权与最新建议以融合计划为准。

## 角色皮肤与视觉修改

- [原产品方案](plans/2026-10-01-model-character-skin-plan.md)、[原 TODO](plans/2026-10-01-model-character-skin-todos.md)、[原实施计划](plans/2026-10-02-model-character-skin-implementation-plan.md)。
- [弹窗视觉修改](plans/2026-10-02-skin-dialog-refinement-implementation-plan.md)、[聚光方案](plans/2026-10-02-spotlight-metric-cards-plan.md)、[面部居中方案](plans/2026-10-02-skin-face-centering-proposal.md)。

五款皮肤范围已按 [v0.6.0 验收](../../validation/2026-10-03-release/README.md)交付。长期规则已融入[看板行为](../../12-dashboard.md)与[开发约定](../../03-development.md)；旧十卡/离线矩阵及自定义配色接入不再排期。聚光最终强度和当前范围的联合复核保留在[任务清单](../../02-tasks.md)，没有因归档宣称完成。

## 已完成的计价与看板批次

- Claude：[实施计划](plans/2026-10-01-claude-pricing-plan.md)、[TODO](plans/2026-10-01-claude-pricing-todos.md)。有效价格与缓存规则见[计价](../../11-pricing.md)和[DSH 专题](../../data-sources/dsh.md)，证据见[Claude 验收](../../validation/2026-10-01-claude-pricing/README.md)。
- 看板修正：[实施计划](plans/2026-10-01-dashboard-corrections-implementation-plan.md)、[TODO](plans/2026-10-01-dashboard-corrections-todos.md)。周期、排序、来源、刷新及材质规则已融入[看板行为](../../12-dashboard.md)，证据从[验证索引](../../validation/00-index.md)进入。

## 已终止的 Qoder 探索

[难度评估与计划大纲](plans/2026-10-02-qoder-adaptation-outline.md)：用户于 2026-10-02 终止，本机受测版本仅有 credits、缺少可信 token 明细；不作为待办，也不推断未来版本。原来的方案选择与探测记录保留供追溯。

## 其他合并与保留

旧 `docs/13-static-export.md` 的移除说明融入[开发说明](../../03-development.md#旧-html-导出与历史验证)，原独立入口删除。验收脚本、截图、JSON 和日志留在原日期目录；旧脚本依赖已删除导出器时须在对应历史 revision 重跑。
