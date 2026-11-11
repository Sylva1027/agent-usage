# 旧实验与过时材料归档

2026-11-11，按用户要求将旧实验源码、手动原型 CI、一次性架构图与 TPS 交接笔记移出工作区。应用继续使用 Node.js、SQLite 和浏览器界面；现用 Windows 来源证明／归档锁助手仍保留在 `native/windows-source-proof/`。

## 保留的历史结论

| 原实验 | 报告入口 | 当前用途 |
| --- | --- | --- |
| 四后端原型及后续重构 | [语言选择结论](architecture-20261101/FULL-STARTUP-REPORT.md)、[最终短验收](architecture-20261101/WINDOWS-CLOSEOUT-SHORT-REPORT.md)、[历史实验说明](architecture-20261101/README.md) | 保留选型依据、已完成验收与尚未通过的性能边界 |
| Rust 接入与聚合 | [报告](rust-integration-20261030/README.md) | 历史对比，未作为现用主程序 |
| Rust DSH 解析 | [报告](rust-parsing-20261029/README.md) | 历史解析吞吐对比 |
| Node 索引优化 | [报告](node-index-20261030/README.md) | 旧版本成本与候选对照 |
| Node 首次响应 | [报告](node-startup-20261030/README.md) | 旧版本重复工作调查 |
| TPS worker 交接 | [原笔记](numeric-worker-A.md) | 已退役功能的历史调查，非当前待办 |

历史报告中的命令、源码路径、版本、PID、测试数和“下一步”只描述对应日期，不能作为现行任务。正文里的本地报告链接已迁移；已移出的源码、补丁和原始图件通过下面的外部归档恢复。

## 恢复归档

本机外部归档：`E:\12 AI\ccusage\project-archives\2026-11-11-cleanup`。这份本机归档不随发行包交付。

- `retired-materials.zip`：413 个原文件，5,541,374 bytes，逐个解压流 SHA-256 校验通过；包括一份未跟踪的 892-byte 压缩实验夹具。SHA-256：`2fe4840d547f8a6857216f8cf68e8be7b6cb354abffe60b333333d8ddab5f3e1`。
- `source-snapshot.zip`：归档基线 `3a395c0708349bf2db16a16e7a86e9314a3bbaa1` 的 Git 源码包，用于补齐实验依赖的原 Node 程序及相对路径。SHA-256：`150a366e9f681c8ca5acf0ce31e73b74ba6a1d0f913554fd16d776902f374ce1`。
- `manifest.json`、`receipt.json`：原路径、文件大小、逐文件摘要及压缩包摘要。

复现时在独立目录先解开源码包，再覆盖解开旧材料包；保持原相对路径，按历史实验说明安装其依赖。源码包遵守原 `.gitattributes`，不包含用户数据、私有冻结输入、源 PNG 和多数历史验收附件。这些数据保留原位，不随归档清理。

## 现行消费者保留

- 两份现行回归测试使用的夹具与分析函数已迁入 `test-support/remaining-harness-delivery-{fixture,analysis}.mjs`；原有 11 项测试通过。
- 仍在使用的生成物盘点／清理工具迁入 [scripts/windows-closeout-cleanup.ps1](../../../scripts/windows-closeout-cleanup.ps1)，只调整默认工作区的相对层级。
- 原型 CI 只供手动执行，随旧原型退役；现行 `.github/workflows/ci.yml` 保持不变。
- `clear/ontology` 的外部工具用途尚未确认，继续保留；原始来源、恢复备份、皮肤素材和测试绑定证据不按“旧”字删除。

本轮实际验证与提交见[清理记录](../../validation/2026-11-11-workspace-cleanup.md)。

## 全部历史说明与报告

<details>
<summary>展开报告目录</summary>

- [归档压实后的长期容量续验](architecture-20261101/ARCHIVE-COMPACTION-CAPACITY-REPORT.md)
- [归档压实：安全切换通过，当前混合刷新未过门](architecture-20261101/ARCHIVE-COMPACTION-REPORT.md)
- [多归档请求的校验复用：结果、标准与判定](architecture-20261101/ARCHIVE-REQUEST-LIFETIME-REPORT.md)
- [归档验证去重与持久复用：交付验收](architecture-20261101/ARCHIVE-VERIFICATION-REUSE-REPORT.md)
- [B1：有界历史查询与持久业务视图](architecture-20261101/B1-REPORT.md)
- [B2 active-USN open-writer probe](architecture-20261101/B2-ACTIVE-USN-PROBE.md)
- [B2 整页成本归因：分段与资源账本](architecture-20261101/B2-COST-ATTRIBUTION.md)
- [B2 growth diagnostic: source, facts, and dashboard](architecture-20261101/B2-GROWTH-DIAGNOSTIC.md)
- [B2 Windows native source proof: W3](architecture-20261101/B2-NATIVE-PROOF.md)
- [B2：Windows append proof V1 发现与 V2 闭环审查](architecture-20261101/B2-NATIVE-REVIEW.md)
- [B2 page diagnostic: source landing to painted refresh](architecture-20261101/B2-PAGE-DIAGNOSTIC.md)
- [B2 S1：UsageReplacementFacts 独立复核](architecture-20261101/B2-REPLACEMENT-REVIEW.md)
- [B2：来源级增量实施与验证](architecture-20261101/B2-REPORT.md)
- [B2 Windows reliable-append preflight: W1](architecture-20261101/B2-WINDOWS-PROBE.md)
- [B3：多归档与近期数据查询结果](architecture-20261101/B3-MIXED-HISTORY-REPORT.md)
- [来源业务贡献接口](architecture-20261101/BUSINESS-PARTS.md)
- [C1：长期历史容量验收与修复](architecture-20261101/C1-LONG-HISTORY-REPORT.md)
- [持续写入期间发布完成批次](architecture-20261101/COMMITTED-PUBLICATION-PROGRESS-REPORT.md)
- [四原型共享契约（实施用）](architecture-20261101/CONTRACT.md)
- [正式交付收尾记录](architecture-20261101/DELIVERY-HANDOFF-REPORT.md)
- [DSH 单遍导入实施与完整重建复测](architecture-20261101/DSH-STAGE-REPORT.md)
- [首次更新重复采集修复（2026-11-06）](architecture-20261101/FIRST-UPDATE-CACHE-REPORT.md)
- [正式完整启动分段与同口径原型对照](architecture-20261101/FULL-STARTUP-PHASE.md)
- [正式完整冷启动：分段实测与四原型同口径对照](architecture-20261101/FULL-STARTUP-REPORT.md)
- [阶段 A：完整重建的历史量增长基线](architecture-20261101/GROWTH-BASELINE-REPORT.md)
- [来源增量发布与业务视图预计算（2026-11-02）](architecture-20261101/INCREMENTAL-PHASE.md)
- [来源增量发布与业务视图预计算复测](architecture-20261101/INCREMENTAL-REPORT.md)
- [会话累计复合索引：首个实施子阶段](architecture-20261101/INDEX-STAGE-REPORT.md)
- [持续写入来源恢复：结果、标准与判定](architecture-20261101/LIVE-SOURCE-RECOVERY-REPORT.md)
- [OpenCode 退化定位与来源通知生命周期修复（2026-11-06）](architecture-20261101/OPENCODE-REGRESSION-REPORT.md)
- [持久冷热投影：V14 实施与验收报告](architecture-20261101/PERSISTENT-MIXED-HISTORY-REPORT.md)
- [2026-11-02 Windows 看板链路与性能初筛](architecture-20261101/PRODUCT-PHASE.md)
- [Q1：all 主摘要持久增量复用](architecture-20261101/Q1-ALL-SUMMARY-REPORT.md)
- [Q10：刷新防退化与重开问题收口](architecture-20261101/Q10-REFRESH-REOPEN-REPORT.md)
- [Q2：元数据与周期对比持久增量复用](architecture-20261101/Q2-METADATA-PERIOD-REPORT.md)
- [Q3：额度增量与完整重建](architecture-20261101/Q3-QUOTA-REBUILD-REPORT.md)
- [Q4：有界批量构建](architecture-20261101/Q4-BULK-BUILD-REPORT.md)
- [Q5：刷新提速与通知闭环](architecture-20261101/Q5-REFRESH-DELIVERY-REPORT.md)
- [Q6 第二卡：正式采集与发布接入](architecture-20261101/Q6-ACQUISITION-IMPLEMENTATION-REPORT.md)
- [Q6 对比报告：日常刷新变快，初始化与增长目标仍有缺口](architecture-20261101/Q6-FILE-CAPABILITY-REPORT.md)
- [Q6 第一卡补验：完整初始化与并发写入闭环](architecture-20261101/Q6-INITIALIZATION-CLOSURE-REPORT.md)
- [Q6 第三卡：缩减对照提前停止](architecture-20261101/Q6-PERFORMANCE-DIRECTION-REPORT.md)
- [Q6 第一卡：来源变化清单的能力验证](architecture-20261101/Q6-SOURCE-CAPABILITY-REPORT.md)
- [Q7 已有索引重开：对照、标准与剩余问题](architecture-20261101/Q7-INDEX-REOPEN-REPORT.md)
- [Q8：SHA 重复同步修复与防回退结果](architecture-20261101/Q8-SHA-SYNC-REUSE-REPORT.md)
- [Q9：新会话、新目录增量登记结果](architecture-20261101/Q9-NEW-SESSION-REPORT.md)
- [四个架构原型](architecture-20261101/README.md)
- [四来源原页面交付验收（2026-11-06）](architecture-20261101/REMAINING-HARNESSES-DELIVERY-REPORT.md)
- [其余四来源：有界采集基础交付](architecture-20261101/REMAINING-HARNESSES-INGESTION-REPORT.md)
- [四来源相同前缀增量发布（2026-11-06）](architecture-20261101/SOURCE-PREFIX-PUBLICATION-REPORT.md)
- [完整同步的来源快照内存：结果、标准与判定](architecture-20261101/SOURCE-SNAPSHOT-MEMORY-REPORT.md)
- [SQLite 空 WAL 重复同步修复（2026-11-06）](architecture-20261101/SQLITE-EMPTY-WAL-REPORT.md)
- [上游与当前实现对照，以及完整重建的下一步](architecture-20261101/UPSTREAM-COMPARISON.md)
- [Windows主线短验收收尾](architecture-20261101/WINDOWS-CLOSEOUT-SHORT-REPORT.md)
- [Windows 最后验收包：结果、标准与判定](architecture-20261101/WINDOWS-FINAL-ACCEPTANCE-REPORT.md)
- [Windows多标签验收：前置通过，长测与资源预算未通过](architecture-20261101/WINDOWS-MULTITAB-ACCEPTANCE-REPORT.md)
- [Windows 并行收尾：结果、标准与判定](architecture-20261101/WINDOWS-PARALLEL-CLOSEOUT-REPORT.md)
- [Windows 看板架构原型：真实页面初筛](architecture-20261101/WINDOWS-REPORT.md)
- [Windows稳定性续验：短验证与现场恢复通过，8小时仍未完成](architecture-20261101/WINDOWS-STABILITY-RECOVERY-REPORT.md)
- [Windows连续运行与恢复验收](architecture-20261101/WINDOWS-STABILITY-REPORT.md)
- [ZCode 首次追加前缀回退修复（2026-11-06）](architecture-20261101/ZCODE-FIRST-PREFIX-REPORT.md)
- [Storage backends](architecture-20261101/native/BACKENDS.md)
- [Native architecture prototype](architecture-20261101/native/README.md)
- [Q6 独立审查：第一卡“完整变化清单”能力（有限 scope 定稿）](architecture-20261101/q6-coverage-audit.md)
- [Node 索引检查与 DSH 内存实验](node-index-20261030/README.md)
- [Node 首次响应：重复工作隔离实验](node-startup-20261030/README.md)
- [numeric worker A - Magpie timing reader](numeric-worker-A.md)
- [Rust 接入与全部范围内存实验](rust-integration-20261030/README.md)
- [native-dsh](rust-integration-20261030/native-dsh/README.md)
- [native-perf](rust-integration-20261030/native-perf/README.md)
- [Rust DSH parsing experiment](rust-parsing-20261029/README.md)

</details>
