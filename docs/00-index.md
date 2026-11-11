# Agent Usage 文档入口

更新：2026-11-11。主技术栈为 Node.js、SQLite 和浏览器原生 JavaScript。Windows 来源证明与归档锁使用配套原生助手；旧 Rust 主程序方案已归档。

## 从这里开始

| 需要做什么 | 阅读入口 |
| --- | --- |
| 安装、启动和使用 | [中文 README](../README.md) · [English](../README.en.md) |
| 查看当前任务与范围 | [任务清单](02-tasks.md) · [路线图](01-roadmap.md) |
| 接手代码、运行检查 | [开发说明](03-development.md) |
| 构建助手、升级与回滚 | [交付与升级](15-delivery-upgrade.md) |
| 备份、转移与保留历史 | [历史操作](history-retention.md) |

## 现行专题

| 主题 | 内容 |
| --- | --- |
| [数据来源与统计口径](10-data-sources.md) | 来源发现、统一事件、范围、索引与读取边界 |
| [计价与自动更新](11-pricing.md) | 模型映射、免费规则、缺价、汇率与手动覆盖 |
| [看板行为](12-dashboard.md) | 时间范围、刷新、冻结、语言和布局 |
| [皮肤与配色维护](13-skins.md) | 十款皮肤、源素材、工作室、生成与验证 |
| [项目日志接入](14-project-log.md) | 其他项目如何提供真实 Token 用量 |

来源细节：[Codex](data-sources/codex.md) · [ZCode](data-sources/zcode.md) · [DSH](data-sources/dsh.md) · [OpenCode](data-sources/opencode.md) · [Claude Code](data-sources/claude-code.md) · [WorkBuddy](data-sources/workbuddy.md)。

## 计划、验证与历史

- [待实施计划](plans/README.md)：追加需求和分享图片，均未因本次整理开始实现。
- [验证索引](validation/00-index.md)：近期回归、实际启用与按日期保留的验收材料。
- [历史归档索引](archive/00-index.md)：旧施工计划、被替代方案、TPS 研究和实验报告。
- [本轮清理记录](validation/2026-11-11-workspace-cleanup.md)：提交、外部归档、缓存清理与文档验证。

现行规则只在专题中维护，任务状态只在任务清单维护。历史文档中的“当前”“待实施”、PID、版本和测试数均属于原记录日期；归档不把失败或未测项目改成通过。
