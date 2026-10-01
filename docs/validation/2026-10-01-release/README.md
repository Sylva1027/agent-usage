# 2026-10-01 v0.5.0 发布

用户明确授权 commit、push、release，以及按需更新 README 和 About。仓库为 `Sylva1027/codex-usage`，目标 main；版本从 0.4.0 升为 0.5.0。

本次包含业务修正、对应测试、中英 README 和既有文档迁移。显式暂存产品与文档路径；本地用量目录、浏览器配置、临时探针和预览截图留在工作区。

[发布说明](release-notes.md)，最终用户界面证据见[加载圈和菜单验收](../2026-10-01-refresh-dropdowns/README.md)。提交前检查结果将保存在本目录，推送和发布信息以远端回读结果记录。

## 发布结果

正式 Release：[Agent Usage v0.5.0](https://github.com/Sylva1027/codex-usage/releases/tag/v0.5.0)，非草稿、非预发布，并设为 Latest。发布标签提交为 `2b0c13b037786929d42666ef240e778ccb07d24c`。主实现提交 `42d2248`，后续 `8b22270` 与 `2b0c13b` 修正跨平台测试假设；最后追加发布状态文档提交，不修改发布代码。

[成功 CI](https://github.com/Sylva1027/codex-usage/actions/runs/36827051272) 的 Node.js 22/24 两项任务均通过。[远端 CI 回读](ci-success.json)、[Release 回读](release.json)、[提交前核对](preflight.json)。首次 CI 发现畸形 zstd 帧行为存在平台差异；第二轮 Node22 的模拟 fetch 没有网络句柄，AbortSignal.timeout 的 unref 计时器导致提前取消。测试现在验证解析器拒绝畸形/空帧，并为模拟请求提供有界句柄；[首次失败](ci-initial-failure.log)、[Node22记录](ci-node22-failure.log)保留。

[完整测试](test.log)312/312；[类型](typecheck.log)、[Lint](lint.log)、[格式](format-check.log)均退出0，Lint40条CSS警告无错误。原始Lint输出中的尾空格保留，业务/测试/README/包差异无空白错误。

中英README已同步版本、渠道归组、Git优先、模型活动退出和扫描入口；About更新为四类来源并保留已有topics，增加dsh/opencode。未创建npm发布或额外二进制附件；GitHub自动提供源码ZIP/TAR。
