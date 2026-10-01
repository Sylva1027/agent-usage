# 2026-10-02 皮肤系统实施前保存点

依据用户“再开始做皮肤系统之前，先 commit 一下”的要求，在 `main` 创建本地保存点。检查基于父提交 `d3228fff4bfe7a0e5a88b136a5442e3548354e98` 和当前工作区；本记录与下列内容一同提交，不增加新版本发布或远端推送。

## 保存内容

- Claude 内置价格、精确别名、Anthropic 更新、计费场景说明、DSH 缓存写入与索引迁移，以及对应测试、文档和原始验收证据。
- 关闭刷新后不显示多余状态文字的看板修正及已有验收证据。
- 十角色皮肤计划与待办、ChatGPT 独立透明线稿预览、原图对照及浏览器证据。最新 50% 透明度、功能布局固定、衣服入口、独立弹窗和浅深配色比较为待实施规格，未冒充已实现。
- `lineart assets/` 中 ChatGPT、Claude、GLM、Gemini、DeepSeek、Kimi、Qwen、Grok、Muse、Mimo 共二十张 PNG。文件名匹配每角色的正／侧视，均为可读 RGBA PNG，尺寸包含 941×1671、941×1672 和 1024×1536；原图未修改，实际画面和全套透明内容仍需在皮肤实施时核验。

本机浏览器配置目录、根目录临时截图、`.dsh-probe.mjs`、`.archify/`、`.zcode/` 留在本机，不进入保存点。`docs/validation/` 中已记录的合成数据、截图和日志按项目惯例保存。

## 本次实际检查

Windows、Node v24.19.0；当前业务代码完整执行一次检查：

- `npm.cmd test`：323 项通过，失败、取消和跳过均为 0。
- `npm.cmd run typecheck`：退出 0。
- `npm.cmd run lint`：退出 0，保留 41 条既有警告，主要为原有 CSS 规则及 DSH 测试未用 import；本次未进行无关清理。
- `npm.cmd run format:check`：退出 0。
- 二十张素材的命名、PNG 格式、尺寸、RGBA 模式和文件完整性只读检查通过。
- 暂存区的代码与文档执行空白检查；原始工具日志和生成 HTML 保留原样，未为消除日志中的空白诊断而重写历史证据。已有验收脚本两处行尾空白仅作格式清理。

此次是保存点检查，未重复运行历史浏览器验收，也未启动正式皮肤实施。已有浏览器检查分别见 [Claude 验收](2026-10-01-claude-pricing/README.md)、[关闭刷新验收](2026-10-01-refresh-off/README.md)和 [ChatGPT 探索预览](2026-10-02-gpt-skin-preview/README.md)。新功能布局及比较弹窗的后续验收依据 [皮肤计划](../plans/2026-10-01-model-character-skin-plan.md)。
