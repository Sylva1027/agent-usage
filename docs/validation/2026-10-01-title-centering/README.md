# 2026-10-01 标题最终居中验收

受测版本为当前未提交工作区，延续看板修正和模型列表反馈。本轮仅修改标题字体布局与手机横向间距。

## 问题与实现

此前固定上移 6px，且用包含下伸笔画的整体包围框评估视觉中心，导致主体偏上。真实截图首字母 A 的字面中心高出框体中心约 4.5px。取消固定偏移，改用 `text-box-trim: trim-both`、`text-box-edge: cap alphabetic`，由 Flex 居中字体主体。连续框体、同色凹刻、字号/字重保留；手机按钮宽度与 flex-basis 同步为 60px，容纳宽回退字体。

## 原始像素与回归

- [截图脚本](title-audit.mjs)读取最终源码，并在隔离 Edge 中分别验证标准模式源码页面及本地真实服务 `127.0.0.1:3765`。外部请求禁用，真实页只保存顶部框体截图。
- 每页检查 1440/1280/1024/390px × 深浅主题 × 默认/Segoe UI/Arial，共 **48/48**。默认设备像素比为 1；这不是原生浏览器缩放测试。
- [像素脚本](measure-title.py)对显示/隐藏标题截图做 RGB 差分，测量首字母 A 主体的真实绘制上下界，避免下伸笔画影响。两页最大中心偏差均为 **1px**，上下留白差最多 **2px**；手机保持同排、操作区在框体内。[源码结果](pixels-final.json)、[真实页结果](pixels-live-final.json)。
- 新版 **137/137** [浏览器验收](browser-audit.mjs)替换了旧基线标记/Canvas 断言，检查字体裁切、主体布局盒居中和操作区包含关系；该几何断言与独立原始像素证据配合使用。[结果](results.json)、[日志](browser.log)。
- 完整测试 **312/312**；类型、Lint、格式检查退出 0。Lint 为既有 38 条 CSS 警告。[测试](test.log)、[类型](typecheck.log)、[Lint](lint.log)、[格式](format-check.log)。

已人工查看真实页[桌面深色截图](live-header-1440-dark-default-visible.png)和[手机深色截图](live-header-390-dark-default-visible.png)。字体裁切能力已在本机 Edge 验证；未验证更旧浏览器。内置 Browser 内核启动失败，改用独立隔离 Edge，不使用用户登录会话。未重启个人服务或创建提交。

同目录探索阶段的 capture/trim/live 测量仅用于诊断，最终证据是带 `final` 的 JSON、`header-`/`live-header-` 截图及本 README 链接结果。上一轮[历史记录](../2026-10-01-dashboard-feedback/README.md)保留并标注其标题代理结论无效。
