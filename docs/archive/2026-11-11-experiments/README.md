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
