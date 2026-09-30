# 静态导出约定

静态快照必须是一份能从 `file://` 打开的自包含 HTML。导出命令只依赖 Node 内置模块和仓库内的 `src/`、`public/` 文件，不依赖 `node_modules`。

当前导出器将样式、用量数据、`timeline-utils.js`、`i18n.js`、`html-utils.js`、`calendar.js`、`app-state.js`、`usage-fields.js`、`period-comparison.js`、`pricing-models.js` 和 `app.js` 内联。`assertSelfContainedStaticHtml` 在写文件前拒绝外部脚本/样式引用、动态导入，以及仍留在内联脚本中的静态导入或重导出；它同时检查脚本语法。新增前端模块时，先保持其为无循环依赖的命名导出模块，在**同一次改动**中把它接入导出器的内联闭包和依赖绑定。新的引用若未接入，导出应失败。这样无需增加运行时打包器或安装步骤；模块图复杂到不适合显式内联时，再单独评估构建方案。

第一轮拆分继续把共享浏览器模块放在 `public/`：本地服务原有的静态文件路由即可提供模块，浏览器相对导入路径不变。`app.js` 继续导出日期选择器的纯函数，供现有 Node 测试导入；刷新竞态计数器随整个 `state` 对象迁至 `app-state.js`，刷新函数的逻辑保持原样。

验证命令：`npm run typecheck`、`npm test`。其中静态导出测试会将 `src/` 和 `public/` 复制到没有 `node_modules` 的临时目录并直接运行导出脚本。最后仍需在浏览器里以 `file://` 打开产物，检查首屏数据与脚本错误。
