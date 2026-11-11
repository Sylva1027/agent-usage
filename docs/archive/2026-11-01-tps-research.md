# TPS 研究封存记录

2026-11-01，模型速度（TPS）及其采集、插件、日志 DLC、定制引擎补丁和研究测试从当前运行项目退役。退役边界、旧数据兼容和发布条件见[TPS 研究封存与无 TPS 发行版计划](2026-11-11/plans/2026-11-01-tps-removal-release-plan.md)。

独立研究盒子位于：

```text
E:\12 AI\ccusage\tps-research-box\2026-11-01
```

压缩归档为 `tps-research-box-20261101.zip`。外部验收记录：

- 解包文件：756 个
- 解包字节数：80,742,855
- ZIP SHA-256：`0158e753e425a57f286f4db845d16e47154fe29747ecc6f8ad16d175515162c0`
- 外部复制的文件清单与 hash 复核通过；核心离线测试 69/69 通过。初轮 67/69 的两项失败受沙箱硬链接限制，在允许所需硬链接的复跑中补齐；历史文件 4/4 正常执行。

盒子包含退役前工作树、未提交修复、参考分词与窗口实现、各 harness 的采集和 reader、插件、启动器、定制引擎补丁、相关测试、fixture、研究文献与复用说明；不包含凭据、原始用户会话正文、生产数据库或真实模型请求。

盒子入口为 `box/README.md`，完整文件清单与 hash 为 `box/manifest.json`。核心离线复现使用盒子内的源码、依赖和合成 fixture，不借用当前工作区。DSH 热启停等未解决项及各 harness 的实际支持范围保留在盒子内，源码存在不表示完整支持。

封存当时拟用 `v0.9.0`，该版本号属于旧发行计划。后续实际无 TPS 发行与切换采用 `v0.8.5`，见[发行验收](../validation/2026-11-01-no-tps-cutover/README.md)；当前版本与安装方式以[README](../../README.md)和[交付说明](../15-delivery-upgrade.md)为准。研究盒子继续独立保留，不随运行包交付。

2026-11-11 复查清理了主仓库遗留的 `test-support/codex-generation-fake-process.cs`。它只供已退役的 TPS 引擎测试使用，现行代码和测试没有消费者；原文件与盒子目录及 ZIP 中的 `source/test-support/codex-generation-fake-process.cs` 均逐字节一致（5,164 bytes，SHA-256：`8b2f8f2e362395eaf1ac92eb8c2c55ab72cc08a9a8489c961191870302fc4c47`）。原安装说明仍在盒子的 `source/docs/10-data-sources.md` 中，不能作为当前项目安装步骤。
