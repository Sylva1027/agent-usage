# 2026-10-03 v0.6.0 发布验收

用户授权 commit、push、release，目标仓库为 `Sylva1027/codex-usage` 的 main，发布版本为 [v0.6.0](https://github.com/Sylva1027/codex-usage/releases/tag/v0.6.0)。[发布说明](release-notes.md)描述当前五款皮肤的实际交付范围，较早的十卡截图与计划保留历史语境。

## 本地检查

- [完整测试](test.log)：355/355 通过，无失败、取消或跳过。
- [类型检查](typecheck.log)、[Lint](lint.log)、[格式检查](format-check.log)：全部退出 0；Lint 保留 41 条已有警告，无错误。
- 皮肤资产检查：40 个资源、40 个 URL，源图、WebP、manifest 和 bootstrap 一致且新鲜。
- [配色校验](palettes.log)：20/20 槽位通过；7 条现有次要文字对比度告警保留，未擅自修改用户配色。
- [在线／离线 UI](ui-results.json)：155 项检查、10 个布局状态通过，零页面异常，离线零 HTTP 请求；实际内嵌 40 张角色资源，共 19,361,238 字节。

浏览器使用隔离的空用量合成报告，不读取真实 home、索引或价格缓存。验证五款皮肤及浅深模式的选择、7px 泛光选中圆点、双模式缩略图、重载恢复、简洁模式、键盘循环、中英标题与“上一个7d”文案；1440／1024 桌面一行，768／390 窄屏自动换行，短屏仅卡片区滚动，凹陷框随内容高度收缩。

截图：[在线浅色](online-light.png)、[在线深色](online-dark.png)、[离线浅色](offline-light.png)、[离线深色](offline-dark.png)。复跑 `node docs/validation/2026-10-03-release/ui-audit.mjs`；需要已有 Playwright 与 Edge，可通过 `AGENT_USAGE_PLAYWRIGHT_MODULE`、`AGENT_USAGE_EDGE_PATH` 指定。

## 发布流程

只暂存产品、角色资源和相关文档／验证证据。临时配色工作台保留在本地工作区，自定义配色编辑器不纳入主程序。提交后推送 main，以该提交的 Node.js 22／24 CI 为发布门槛；通过后创建 v0.6.0 正式标签和 Release，并设为 Latest。运行要求保持 Node.js 23.8 或更新版本，GitHub 自动提供源码 ZIP／TAR。
