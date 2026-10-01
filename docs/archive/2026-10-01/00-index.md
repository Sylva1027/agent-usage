# 2026-10-01 归档索引

归档依据：相关实现已合入 `28568ef`，当前需要长期维护的规则已提炼。原文保留当时进度、调查数字、旧路径和施工指令；每篇顶部说明其历史状态。

## UI 与计价

- [UI 与计价实施计划](agent-usage-ui-pricing-implementation-plan.md)：19 项实施过程、来源扩展和最后验收。现行约定分入[看板行为](../../12-dashboard.md)与[计价](../../11-pricing.md)。
- [UI 与计价 TODO 快照](agent-usage-ui-pricing-todos.md)：当时 19/19 完成及覆盖率记录，现行状态只看[任务清单](../../02-tasks.md)。
- [GPT-6.1 Sol 缺价调查](gpt-6.1-sol-pricing-improvement-plan.md)：保留修复前服务与索引快照；“没有该价目”“待实施”等描述已经被后续实现取代。
- [GPT-6.1 Sol 实施计划](gpt-6.1-sol-pricing-implementation-plan.md)：保留 P0/P1/P2、失败检查和当时未完成的浏览器清单；后续 UI 验收只覆盖其中一部分，剩余验证进入 02。

## DSH

- [适配计划与实施记录](dsh-adaptation-plan.md)：保留多帧日志调查、M1/M2 与真库对照；正文顶部旧 M2 状态不代表现在。
- [提交交接清单](dsh-change-summary.md)：保留共享工作区背景与修复记录，按文件/hunk 提交的命令已失效。

当前字段规则见 [DSH 数据源](../../data-sources/dsh.md)；非零缓存写入疑点仍待核实。

## OpenCode

- [适配计划 v2.1](opencode-adaptation-plan.md)：保存表结构探查、计数语义、决议与一期边界；P0—P5 已实现，不再执行原来的阶段核准指令。
- [原稿与复审](opencode-adaptation-plan.reviews.md)：原稿和三轮评审包含已纠正的口径与数字，只供追溯。
- [进度快照](opencode-adaptation-todos.md)：P0—P5 的当时结果；“待提交”已被整体提交取代。
- [提交 hunk 清单](opencode-commit-hunk-guide.md)：说明当时三批混合改动，固定提交顺序和文件归属现在不适用。

当前字段规则与免费计价分别见 [OpenCode 数据源](../../data-sources/opencode.md)和[计价](../../11-pricing.md)。

## 路径迁移

上述十篇由 `docs/` 顶层移动到本目录。`dsh-data-source.md`、`opencode-data-source.md` 分别转为 `docs/data-sources/dsh.md`、`opencode.md`；`static-export-contract.md` 整合为 `docs/13-static-export.md`；根目录 `log-README.md` 的正文迁入 `docs/14-project-log.md`，旧根路径保留导航页。

旧 QA 目录 `docs/qa/agent-usage-ui-retry/` 移到[日期验收目录](../../validation/2026-09-30-ui-pricing/README.md)。历史正文中的旧命令与路径仍是当时记录，Markdown 链接已修复；原始验收脚本、JSON、截图与日志保持内容。

返回[归档总索引](../00-index.md)或[文档入口](../../00-index.md)。
