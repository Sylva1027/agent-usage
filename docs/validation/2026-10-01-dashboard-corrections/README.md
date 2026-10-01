# 2026-10-01 看板九项修正验收

受测版本：`28568ef` 加本批工作区修改，未创建提交。保留了实施前已有的文档重组和其他未提交内容。需求与拆分见 [Implementation Plan](../../plans/2026-10-01-dashboard-corrections-implementation-plan.md) 和 [TODOs](../../plans/2026-10-01-dashboard-corrections-todos.md)。

## 最终结果

- 完整测试 **311/311**：[test.log](test.log)。渠道归组、原字段/费用保留、SQL 会话去重、三路一致、日历月边界、未来时间排除、模型退出/回归、冻结覆盖率、Git 最高优先和静态导出均通过。
- 类型检查退出 0：[typecheck.log](typecheck.log)。
- Lint 退出 0，38 条 CSS 警告：[lint.log](lint.log)。对 HEAD 样式单独运行相同工具，基线为 39 条；没有将新增错误当作已有警告忽略。
- 格式检查退出 0：[format.log](format.log)。只格式化本批修改的源码/测试。
- 浏览器 **104/104**：[results.json](results.json)、[browser.log](browser.log)、[可重跑脚本](browser-audit.mjs)。

浏览器覆盖在线/离线 × 1440/1280/1024/390px × 浅色/深色 × 中文/英文，共 32 种布局组合。验证无横向溢出、标题同色/字号/字重、独立框体阴影、桌面三框上下边缘一致、刷新内凹槽和开关邻接、范围文字容纳。交互覆盖时区方向键/Home/End/Enter/Escape/Tab、选择持久化、外部点击、焦点恢复、扫描目录来源入口、计价与时间分布共享凹槽和选中材质、60 秒轮询失败换行、静态禁用变更和离线时区重算。额外验证普通范围四产品合并、Codex 限额 CLI/Exec 分列、Git 在四周期三态下始终首位、过期模型退出在用并保留于全部模型，以及八种桌面/手机主题/语言计价弹窗的等分按钮和文字容纳。无页面运行异常或外部请求。

## 截图抽查

- 桌面：[浅色中文](online-1440-light-zh-CN-top.png)、[深色中文](online-1440-dark-zh-CN-top.png)。
- 手机：[浅色英文](online-390-light-en-US-top.png)、[离线深色中文](offline-390-dark-zh-CN-top.png)。
- 控件：[时区菜单](timezone-menu.png)、[计价共享凹槽](pricing-shared-well.png)、[手机英文计价](pricing-390-dark-en-US.png)、[刷新异常换行](refresh-error-mobile.png)。

所有矩阵截图与几何/计算样式数据位于本目录。已人工抽查桌面、手机、深浅主题与计价弹窗；具体日期和字体/浏览器环境见结构化结果。

## 环境与重跑

Windows，Node v24.19.0，隔离 Microsoft Edge，时区 Asia/Shanghai。合成项目日志、Codex 限额与计价 fixture 使用独立临时 home/SQLite，不写入个人索引、日志、价目或用户服务。合成多产品渠道、低用量 Git 仓库与超过一个月未出现的模型同时用于可见业务断言。价格下载由 fixture 阻断，轮询异常为模拟 HTTP 503。

Browser 技能已读取并尝试启动；node_repl 内核因 Windows 沙箱初始化失败退出，未选中任何用户浏览器。随后使用隔离 Edge 完成验收。测试程序依赖 Playwright，默认读取 Codex bundled runtime；可用 `AGENT_USAGE_PLAYWRIGHT_MODULE`、`AGENT_USAGE_EDGE_PATH` 指定替代路径。

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
node docs/validation/2026-10-01-dashboard-corrections/browser-audit.mjs
```

## 修复记录与边界

首轮浏览器发现旧 toolbar 的 `align-items: start` 导致外框高度不齐，已改为 stretch 并复跑。来源弹窗的测试选择器已纠正；轮询失败测试使用真实 60 秒计时器的虚拟时间推进。完整测试首轮唯一失败为 ZCode 子代理旧分列断言，按普通范围合并要求更新。最终日志与 JSON 对应全部修复后的版本。

本批不证明真实 DSH/OpenCode 全部 UI 组合、真实上游价格下载、原生浏览器缩放或新模型自动补录后的所有页面路径；这些历史维护候选继续保留在[任务入口](../../02-tasks.md)。退出机制已用边界 fixture 验证，不要求真实近期名单立即缩短。P2 十渠道归属来自实施前只读踪迹核对，普通/限额归组随后由隔离回归验证。
