# 历史文档归档

更新：2026-10-01。按归档日期浏览。历史方案和旧清单保留当时语境，当前行为从[文档入口](../00-index.md)进入，任务状态只看 [02](../02-tasks.md)。

## 2026-10-01：DSH、OpenCode、计价与 UI

[本批归档索引](2026-10-01/00-index.md)收录十份原计划、调查、TODO、评审和提交交接文档。相关业务已在 `28568ef` 整体提交；旧文中的“待实施”“可开工”“M2 待做”“待提交”和按 hunk 排队的建议已失去当前执行意义。

有效内容分别提炼到[数据来源](../10-data-sources.md)、[计价](../11-pricing.md)、[看板行为](../12-dashboard.md)及数据源专题。尚未证实的 DSH 非零缓存写入、专项 UI 和迁移维护边界保留在任务清单，没有随归档宣称完成。

当时的正式 QA 文件保存在[2026-09-30 验收目录](../validation/2026-09-30-ui-pricing/README.md)，日期结果与归档计划分开索引。

## 2026-09-27：早期设计与施工计划

八份既有归档保持原目录和内容：

- 最近范围筛选：[设计](2026-09-27/superpowers/specs/2026-06-03-recent-range-filter-design.md)、[计划](2026-09-27/superpowers/plans/2026-06-03-recent-range-filter.md)。现行范围规则见[看板行为](../12-dashboard.md)。
- 大规模时间戳范围：[设计](2026-09-27/superpowers/specs/2026-07-12-large-timestamp-range-design.md)、[计划](2026-09-27/superpowers/plans/2026-07-12-large-timestamp-range.md)。保留当时问题和回归流程。
- SQLite 增量索引：[设计](2026-09-27/superpowers/specs/2026-07-12-sqlite-incremental-usage-index-design.md)、[计划](2026-09-27/superpowers/plans/2026-07-12-sqlite-incremental-usage-index.md)。旧 schema 和施工顺序不代表当前版本，现行规则见[增量索引](../10-data-sources.md#增量索引与版本)。
- [模型与仓库周期对比](2026-09-27/superpowers/plans/2026-09-23-model-repository-period-comparison.md)：旧元数据判断、测试数量和未勾选状态保留历史；目前周期比较与排序已实现。
- [自动刷新、时间图与计价](2026-09-27/superpowers/plans/2026-09-23-refresh-timeline-pricing.md)：当时的实现核查已过时，现行说明分别在 [11](../11-pricing.md)和 [12](../12-dashboard.md)。

## 归档维护

归档不是删除证据，也不表示其中每项都曾完成。旧调查、失败尝试和已取消方案仍可追溯。新增归档先补现行说明与遗留状态，再记录原路径、归档原因和替代入口。

本地忽略的私有笔记不进入公共索引，本次整理没有移动或公开这些文件。
