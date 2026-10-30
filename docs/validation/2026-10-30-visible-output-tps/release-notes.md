# v0.8.0：恢复本地实际输出速度采集

本次更新接通 Codex、DSH 与 WorkBuddy CLI 的 tps-v6 采集。新请求按统一的本地分词器统计正文与工具参数，token 数和计时来自同一传输窗口，原始计费用量、费用和限额保持独立。

- Codex 提供经过 release 构建和完整 helper 校验的 Windows 并排包；DSH 使用本地 Cordis 插件；WorkBuddy CLI 使用专用启动器。
- 正确排除首批全部输出，不再用整条回复的 token 数减 1，也不把缓冲事件的解析耗时当成生成时间；没有固定倍率、速度截断或 E2E 回退。
- 测量保存在本机，不依赖 Magpie 遥测，不改变模型认证和路由。历史版本保持原归属；缓存、冻结、冷归档及导入恢复不会混入旧口径数值。
- 保留平均 TPS 降序、样本数和区间条，不新增 UI 说明；保留 RANGE/SYNC、本地汇总、按需计算进程、额度筛选与十款皮肤。

需要 Node.js 23.8 或更新版本。下载 `agent-usage-v0.8.0.zip` 或 `.tar.gz`，其中已附带本地分词依赖，解压后运行 `node src/cli.js run`。Git clone 和 GitHub 自动源码包先执行 `npm ci --omit=dev`（Windows PowerShell 7 可用 `npm.cmd`）。采集启用步骤见仓库 `docs/10-data-sources.md`。

额外的 `codex-generation-0.165.0-alpha.1.2-release-64cac13a-side-by-side.zip` 是完整 Windows Codex 采集包；保留整个目录，按包内说明使用启动器。采用 Desktop 前先正常退出并准备手动恢复聊天，不覆盖官方安装文件。

本机全仓 3,584 项检查：3,559 通过、0 失败、25 项既有跳过；UI 与启动器 51 项全部通过。真实 release 的 CLI/app-server × SSE/WebSocket × 正常/同批缓冲共 8 条传输闭环通过。DSH 和 WorkBuddy 使用实际安装运行时完成 localhost 验证，Codex 已通过自然请求到正式看板的逐条核对。

旧日志缺少的接收批次无法回算。WorkBuddy Desktop、Claude、OpenCode、ZCode 的统一采集尚未接入；DSH 与 WorkBuddy 的日常自然请求采集仍待观察。完整实现与验证见同目录 `README.md`。
