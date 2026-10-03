# 静态导出约定

更新：2026-10-01。使用入口见 [README](../README.md)，看板行为见 [12](12-dashboard.md)，价目与冻结费用见 [11](11-pricing.md)。

静态快照必须是一份能从 `file://` 打开的自包含 HTML。导出命令只依赖 Node 内置模块和仓库内的 `src/`、`public/` 文件，不依赖 `node_modules`。

当前导出器将样式、用量数据、`timeline-utils.js`、`i18n.js`、`html-utils.js`、`calendar.js`、`app-state.js`、`usage-fields.js`、`period-comparison.js`、`pricing-models.js` 和 `app.js` 内联。`assertSelfContainedStaticHtml` 在写文件前拒绝外部脚本/样式引用、动态导入，以及仍留在内联脚本中的静态导入或重导出；它同时检查脚本语法。新增前端模块时，先保持其为无循环依赖的命名导出模块，在**同一次改动**中把它接入导出器的内联闭包和依赖绑定。新的引用若未接入，导出应失败。这样无需增加运行时打包器或安装步骤；模块图复杂到不适合显式内联时，再单独评估构建方案。

共享浏览器模块位于 `public/`，本地服务器提供对应静态路由。`app.js` 暴露日期选择器的纯函数供测试；页面状态由 `app-state.js` 维护。导出器显式移除/绑定模块 import，不依赖浏览器联网补齐模块。

角色皮肤模块 `skin-palettes.js`、`skins.js`、`skin-ui.js` 和 `skin-picker.js` 在同一闭包内绑定，`skins.css` 与预绘制 `skin-bootstrap.js` 同步内联。注册表保留完整素材，全部 40 张 WebP 以 data URL 打包；选择器按当前提供范围显示五款皮肤，在线与离线共用该过滤规则。临时配色工作台不进入快照。

## 命令与快照边界

```powershell
node src/static-export.js
node src/static-export.js --out dist/agent-usage.html
```

默认写入 `dist/codex-usage.html`。快照内嵌导出时的事件、限额观察值、价目和汇率，不在线刷新、补录模型或保存服务器设置；重新导出才包含后续变化。时间范围、搜索、语言、主题和时区仍在本地可用。近期模型活跃度固定以报告 asOf/generatedAt 计算，渠道整合和限额例外与在线版本使用同一规则；共享活跃投影与渠道工具显式进入内联闭包。

产物可能包含模型名、会话元数据和本机路径，分享前检查实际内容。`dist/` 是生成物，不作为源码维护。

## 验证

开发检查见 [03](03-development.md)。`test/static-export.test.js` 会将 `src/` 和 `public/` 复制到没有 `node_modules` 的临时目录并直接运行导出脚本；`test/three-path-parity.test.js` 对照内存、SQLite 和内嵌快照。新增模块须保持离线、自包含检查通过。

浏览器另以 `file://` 打开产物，检查首屏、控制台、交互和无外部请求。已有合成数据记录见[2026-09-30 验收](validation/2026-09-30-ui-pricing/README.md)，不能据此宣称所有未来数据都已验收。
