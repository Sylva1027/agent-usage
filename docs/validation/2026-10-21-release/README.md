# 2026-10-21 v0.7.0 发布验收

目标仓库为 `Sylva1027/codex-usage` 的 main；用户授权提交、推送、发布及更新 README / About。版本从 v0.6.0 迭代至 [v0.7.0](https://github.com/Sylva1027/codex-usage/releases/tag/v0.7.0)，交付范围见[发布说明](release-notes.md)。

## 验证范围

发布检查覆盖完整测试、类型、Lint、格式及皮肤资产／配色；[CI](https://github.com/Sylva1027/codex-usage/actions/workflows/ci.yml) 在 Windows Node.js 22 / 24 上运行完整套件，另在 Linux Node.js 24 上运行核心来源、统计、服务端和刷新回归。浏览器检查显式配置 Playwright，使用 Windows runner 的 Edge，不以缺失浏览器跳过必需检查。测试设有超时，避免单项卡住后无限等待。

首次 Linux 全量运行暴露了历史套件中的 Windows 文件锁、AppData 来源、路径大小写及字体几何假设，尚不能作为 Linux 全量验收。自动刷新夹具已改为从合成事件生成，不再依赖本机未入库的验收抓包；浮点数断言允许 1e-12 的平台数值差异，3:1 阈值判断保持不变。Linux 全量兼容仍是保留边界，不以核心回归通过替代。

旧测试修正为当前合同：上一轮限额持续至下一轮实际开始，稀疏时间图只保留有用量的时间段，皮肤矩阵包含 45 个单模式状态。历史迁移测试使用已有的迁移前 picker fixture 和对应源码摘要，保留转换、来源稳定性和篡改拒绝检查；不为当前产品增加旧迁移兼容层。

干净 checkout 固定源码为 LF，历史摘要绑定的验收文件保留原字节；CI 显式使用 Asia/Shanghai 和 runner 的规范临时路径。浏览器回归先选“全部”并等待历史示例数据，关闭自动刷新，价格请求使用固定离线响应，避免依赖运行日期和公网返回；补齐旧 S8 回归所需的合成捕获元数据。Node.js 22 的 CLI 静默导入测试仅屏蔽运行时自带的 ExperimentalWarning。

## README 图片

- [DeepSeek 浅色看板](../../images/dashboard-deepseek-light.png)：1920×1080，16:9，真实页面截图。
- [皮肤选择器](../../images/skin-picker.png)：五款皮肤的浅深预览、当前选择及角色设置。

使用隔离临时目录中的 189 条合成项目日志，涵盖三个示例仓库和三个渠道，不读取真实用量、配置或价格缓存。Edge 无头浏览器使用中文、Asia/Shanghai、DPR 1；确认 DeepSeek / light 状态、页面无加载错误及 JavaScript 异常，等待字体和图片解码后截图。两张图片均经过视觉检查。

此前故障修复已完成独立 Worker 256 / 512 MiB 对照和“自定义范围 → 本月 → 全部”实测，以及四种桌面宽度下 13 项错误展示与键盘操作检查。512 MiB 是 V8 老生代堆预算，不是进程总内存上限；本次发布不宣称完成长期压力测试或目标机真实 OS 缩放验收。
