# 开发与接手

更新：2026-10-01。先读[文档入口](00-index.md)和[任务清单](02-tasks.md)，再按任务阅读现行专题。

## 环境与启动

项目使用 Node ESM，`package.json` 与锁文件要求 Node `>=23.8`。运行看板和静态导出只依赖 Node 内置模块及本仓库文件；开发检查需要安装 devDependencies。

```powershell
node --version
npm.cmd ci
node src/cli.js run
```

看板默认监听 `127.0.0.1:3765`，前台运行用 Ctrl+C 停止。后台服务、网关与重启命令见 [CLI 帮助](../src/cli.js)；只整理文档无需重启真实服务或更新用户缓存。

Windows 使用 `npm.cmd` / `npx.cmd` 可避免 PowerShell 的 `npm.ps1` 执行策略问题，无需修改系统策略。

## 代码入口

- `src/cli.js`：命令、前台/后台服务和网关管理。
- `src/server.js`：本地 HTTP API、导入、索引刷新、自动价格发现调度。
- `src/usage-core.js`：来源发现与分类、标准事件、内存报告、时间与周期统计。
- `src/usage-store.js`：SQLite 增量索引、迁移、查询、元数据与限额聚合。
- `src/zcode-usage.js`、`src/dsh-usage.js`、`src/opencode-usage.js`：各来源适配器。
- `src/repository-identity.js`、`src/service-tier-evidence.js`：仓库身份和服务档位证据。
- `src/pricing.js`：有效价目、费用估算与不确定性标记。
- `src/pricing-auto.js`、`src/pricing-store.js`：公开来源解析、刷新、发现、持久化与手动覆盖。
- `public/pricing-models.js`、`public/usage-fields.js`、`public/timeline-utils.js`：前后端共享的纯逻辑。
- `public/app.js`、`public/app-state.js`、`public/calendar.js`、`public/i18n.js`、`public/styles.css`：页面、状态、日期、语言和样式。
- `public/skins.js`、`public/skin-palettes.js`、`public/skin-ui.js`、`public/skin-picker.js`、`public/skins.css`：角色注册表、配色、运行时和选择器；`scripts/prepare-skin-assets.mjs` 生成并校验资源 manifest 与首屏脚本。
- `src/static-export.js`：显式模块内联与自包含检查，见[静态导出约定](13-static-export.md)。

## 检查命令

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run skins:check
npm.cmd run skins:palette
```

按实际影响选择验证，不以旧文档中的测试数量为通过条件。

- 来源与字段映射：适配器测试、`test/usage-core.test.js`、`test/usage-store.test.js`、`test/three-path-parity.test.js`。
- 计价与更新：`test/pricing.test.js`、`test/pricing-models.test.js`、`test/pricing-auto.test.js`、`test/server.test.js`。
- 界面与时间：`test/app-render.test.js`、`test/app-toolbar.test.js`、`test/recent-selections.test.js` 及对应日期、语言测试；布局和焦点需浏览器检查。
- 导出：`test/static-export.test.js` 和三路一致回归；新浏览器模块需同时进入导出闭包。
- 仅文档整理：检查本地链接和路径、历史状态、原始证据完整性及被移动的重跑脚本；无需重跑全产品测试来证明文字调整。

2026-09-30 的浏览器脚本已移入[日期验收目录](validation/2026-09-30-ui-pricing/README.md)。它依赖本机 Edge 和外部提供的 Playwright，可用环境变量指定，未增加生产依赖。

## 数据与并行工作

用隔离 home、fixture 和独立导出路径验证；保留真实 `pricing.json`、`pricing-auto.json`、用量索引与原始日志。活库持续写入，顺序执行两次汇总不能作为同一快照的对照证据。

多个任务使用独立分支和 worktree；有前置依赖时基于共同提交，合并后验证。只创建分支并不能保存尚未提交或未跟踪的文件。暂存与提交由一个会话协调，先查看 `git diff --cached`，确保受测业务文件与待提交快照一致。

## 文档维护

长期行为写入现行专题；优先级和完成状态只写入 02。验证记录包含日期、受测 revision/工作区、条件、命令、结果及未测部分。价格、测试数和探针总量只作为带日期的快照。

计划完成或被替代时，先把有效规则合入专题，把遗留项纳入 02，再归档原文并加历史说明。调整路径时修复 Markdown 引用；保留少量确有用途的兼容入口，不复制多份正文。原始截图、JSON 和检查日志保留原内容，历史命令与路径的语境由归档说明解释。
