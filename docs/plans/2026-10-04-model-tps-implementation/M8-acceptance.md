# M8：集成验收、真实来源复核与长期文档

前置：M5.4、M7.4 的模块报告。[实施总计划](../2026-10-04-model-tps-implementation-plan.md)规定只以受测快照和实际命令结果宣称完成。M8 不“补做”遗漏的 M1–M7 卡；发现缺陷退回原卡所有者修复并重跑受影响检查。模块由一名集成者持有 `docs/00-index.md / 02-tasks.md / 10-data-sources.md / 12-dashboard.md / data-sources/*.md`、本次 validation 索引/总报告；产品代码仅在明确退回卡片后由原文件所有者改。

## M8.1 固定 fixture 的整链路门禁

在同一个临时 HOME、临时 SQLite 索引和不变 fixture 摘要上，分别运行四源合成输入的内存报告、store、默认 `/api/usage`、`view=dashboard`、`detail=full`、`/api/summary`、freeze/snapshot。对照 `groups/coverage/methodVersion`、`eligible=sampled+dropped+pending`、每个 group 的分位/pooled/整数和，并确认现有用量 `totals/timeline/cost/quota` 不因性能样本多计数。`summarizeUsageIndex` 与浏览器本地 `summarize(report)` 只复核旧用量字段，不当新的 TPS 路径。

在隔离测试索引演练 v11→当前版本、空库、重开、全来源 `size=-1/mtime=-1`、替换/删除/归档/WAL-only 变化、重复同步、插入失败回滚、Codex 多 rollout 跨文件失效。逐例说明表行数、候选 key、依赖数和 state/indexVersion。运行 `npm.cmd test`、`npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run format:check`，保存原始退出码/日志；M0.1 已将新探测脚本纳入 Biome，另对 `scripts/perf-probe.mjs` 和来源子目录中每个实际 `.mjs` 文件逐个运行 `node --check <文件>`。typecheck 仍只覆盖 `src/**`，不宣称覆盖 scripts/public/test。既有告警按基线比对，不在本卡顺手清理。若环境缺浏览器或某命令失败，状态只能 `NEEDS_REVIEW`，记录阻断范围，不写 PASS 占位。

## M8.2 日期真源与真实页面复核

对当前可访问四源只读采样，记录来源指纹前后、scan 范围、版本、方法、raw/positive/full-span/finalized 与最终 `sampled` 的区别。来源变动时标 `liveSourceChanged` 并重新取稳定样本或只报告诊断；不能拿 §19 的 2026-10-03 数字硬对比。原始 ID、绝对会话路径和正文不进入持久 validation。若某来源本机不可用，报告 `SOURCE_UNAVAILABLE`，该源的固定 fixture 仍须跑；不得伪称真源验证。

以当前整合代码在隔离浏览器重跑 M5.4 矩阵，特别检查真实 Codex estimated/legacy 覆盖、三源端到端标签、n<20 不编号、n=0 诊断、源筛选、日期/UTC、快照过期恢复、浅/深和中英文。对性能模式和三个原时间模式各留截图与键盘路径记录；隐藏 canvas 不获焦点、旧 tooltip/aria 不残留。截图含数据时只用合成 fixture；真源页面若检查，只记录非敏感聚合/遮盖信息，不保存原始模型之外的私人元数据。

## M8.3 文档、模块报告与最终审核包

把已实现行为写入 `docs/10-data-sources.md`、各来源专题和 `docs/12-dashboard.md`；`docs/02-tasks.md` 更新完成/未完状态，`docs/00-index.md` 与 `docs/validation/00-index.md` 链接本次验证。现行计划的未解范围继续保留；**只有 G4 确认后**才按项目归档规则把实施计划移走或标完成，不能因“已有代码”提前归档。若 Codex 可选 SQLite 未启用、某来源 degraded 或部分 UI 未测，明确写成残留事项和证据链接。

集成者先审阅 `M0.md`–`M7.md` 及每张卡：状态、文件摘要、接口兼容、测试退出码、偏差。生成 `handoffs/M8.md` 与 `final-audit.md`，列最终受测 Git HEAD+dirty SHA-256、所有模块状态、每个 gate 证据路径、未测/失败与下一步。再交独立审核者逐模块抽查；审核者实际核对 diff 和至少一条成功/失败路径，把退回意见放在独立 review 记录，不让执行者自评即发布。`DONE` 只表示这张卡满足本卡验收，不自动代表整体 G4 通过。
