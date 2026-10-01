# 2026-10-01 模型列表与连续顶部框体反馈修正

受测版本：`28568ef` 加前一批及本次未提交工作区修改。对应 [Implementation Plan 的追加要求](../../plans/2026-10-01-dashboard-corrections-implementation-plan.md#用户追加要求优先于原-r1) 与 [TODO 22–26](../../plans/2026-10-01-dashboard-corrections-todos.md#m6-用户追加反馈修正)。前批截图和 104 项结果保留在[原验收](../2026-10-01-dashboard-corrections/README.md)，不覆盖成当前版本。

## 原因与修复

3765 的运行服务仍使用旧契约：计价响应包含覆盖率 21，但无 modelActivity；用量元数据有四组 harnessModels，但无 activeHarnessModels。当前前端源码从磁盘加载，旧服务不因刷新页面而重新加载服务端模块。前一版将缺少活动字段当成空名单，因此出现覆盖率非零、列表为空。

现在列表和覆盖率共用同一数据选择：先找有效近期名单（计价响应优先、用量元数据次之），其次从最后使用时间重建；完全没有近期信息的旧服务显示已观测名单，并提示重启后恢复近月筛选。新版明确空名单仍为有效结果，不能回填历史；一个月退出与静态冻结规则保持有效。

顶部按最新用户要求使用一个连续框体，标题和操作区移除各自独立外框。保留同色凹刻与字号/字重，行高为 1，标题上移 6px。390px 收紧横向间距后标题与按钮同排。浏览器用实际基线与字形上下界测量视觉中心，32 种布局的偏差都在 3px 内。

## 最终证据

- 测试 **312/312**：[test.log](test.log)。新增旧契约、混合字段、明确空名单与最后使用时间重建回归；原月边界/退出检查仍通过。
- 类型、Lint、格式退出 0：[typecheck.log](typecheck.log)、[lint.log](lint.log)、[format.log](format.log)。Lint 为 38 条 CSS 警告，无新增错误。
- 隔离浏览器 **137/137**：[results.json](results.json)、[browser.log](browser.log)、[脚本](browser-audit.mjs)。沿用前批合成 fixture，新增 32 种标题字形中心检查和旧 API 契约列表检查。
- 真实旧服务的隔离只读页面：**21 个可见模型行、4 个来源分组、0 个页面异常**，见 [live-contract.json](live-contract.json)。不保存个人模型名、用量、路径或截图；GET 用量带 skipCheck=1，阻断外部请求，不保存任何编辑或修改真实服务。

截图抽查：[桌面深色](online-1440-dark-zh-CN-top.png)、[手机浅色](online-390-light-en-US-top.png)、[旧响应恢复列表](legacy-used-models.png)。除真实检查的计数文件外，截图与 fixture 都是合成数据。

## 环境与重跑

Windows、Node v24.19.0、隔离 Microsoft Edge、Asia/Shanghai；1440/1280/1024/390px × 中英文 × 深浅主题 × 在线/离线。Browser 技能在当前会话的 node_repl 内核因 Windows 沙箱初始化失败不可用，沿用隔离 Edge 验收。登记文件读取被自动审批拒绝后，使用更安全的 Node 监听端口及本地 API 检查完成诊断，未读取服务凭据。

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
node docs/validation/2026-10-01-dashboard-feedback/browser-audit.mjs
```

脚本默认使用 bundled Playwright 与 Edge，可配置 AGENT_USAGE_PLAYWRIGHT_MODULE 和 AGENT_USAGE_EDGE_PATH。本次没有重启真实旧服务；兼容提示因此仍显示，重启运行服务后使用新版近期名单。未知近期时间不能保证旧服务列表已排除过期模型，提示明确区分了这两种状态。

## 标题验收纠错

本页“上移 6px”及基线标记/Canvas 中心断言为历史结果。用户后续截图确认标题主体偏上，代理包含下伸笔画，不能证明主体视觉居中。已取消固定上移；最终实现、48 组真实像素验证与重跑回归见[标题最终验收](../2026-10-01-title-centering/README.md)。本目录原日志与截图保留，不作为最终标题居中的证据。
