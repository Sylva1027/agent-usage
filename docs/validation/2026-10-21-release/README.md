# 2026-10-21 v0.7.0 发布验收

目标仓库为 `Sylva1027/codex-usage` 的 main；用户授权提交、推送、发布及更新 README / About。版本从 v0.6.0 迭代至 [v0.7.0](https://github.com/Sylva1027/codex-usage/releases/tag/v0.7.0)，交付范围见[发布说明](release-notes.md)。

## 验证范围

发布检查覆盖完整测试、类型、Lint、格式及皮肤资产／配色；[CI](https://github.com/Sylva1027/codex-usage/actions/workflows/ci.yml) 的 Node.js 22 / 24 两个任务作为正式发布门槛。浏览器检查显式配置 Playwright 与 Chromium 路径，不以缺失浏览器跳过必需检查。

旧测试修正为当前合同：上一轮限额持续至下一轮实际开始，稀疏时间图只保留有用量的时间段，皮肤矩阵包含 45 个单模式状态。历史迁移测试使用已有的迁移前 picker fixture 和对应源码摘要，保留转换、来源稳定性和篡改拒绝检查；不为当前产品增加旧迁移兼容层。

## README 图片

- [DeepSeek 浅色看板](../../images/dashboard-deepseek-light.png)：1920×1080，16:9，真实页面截图。
- [皮肤选择器](../../images/skin-picker.png)：五款皮肤的浅深预览、当前选择及角色设置。

使用隔离临时目录中的 189 条合成项目日志，涵盖三个示例仓库和三个渠道，不读取真实用量、配置或价格缓存。Edge 无头浏览器使用中文、Asia/Shanghai、DPR 1；确认 DeepSeek / light 状态、页面无加载错误及 JavaScript 异常，等待字体和图片解码后截图。两张图片均经过视觉检查。

此前故障修复已完成独立 Worker 256 / 512 MiB 对照和“自定义范围 → 本月 → 全部”实测，以及四种桌面宽度下 13 项错误展示与键盘操作检查。512 MiB 是 V8 老生代堆预算，不是进程总内存上限；本次发布不宣称完成长期压力测试或目标机真实 OS 缩放验收。
