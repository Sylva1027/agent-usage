# 开发与接手

更新：2026-10-03。先读[文档入口](00-index.md)和[任务清单](02-tasks.md)，再按任务阅读现行专题。

## 环境与启动

项目使用 Node ESM，`package.json` 与锁文件要求 Node `>=23.8`。运行看板只依赖 Node 内置模块及本仓库文件；开发检查需要安装 devDependencies。

```powershell
node --version
npm.cmd ci
node src/cli.js run
```

看板默认监听 `127.0.0.1:3765`，前台运行用 Ctrl+C 停止。后台服务、网关与重启命令见 [CLI 帮助](../src/cli.js)；只整理文档无需重启真实服务或更新用户缓存。

Windows 使用 `npm.cmd` / `npx.cmd` 可避免 PowerShell 的 `npm.ps1` 执行策略问题，无需修改系统策略。

## 界面设计与验收基准

2026-10-03 用户明确：本项目的用量来源和操作场景是 PC，本地主页、设置、角色选择器与分享弹窗以 16:9 高分辨率桌面大屏为设计基准。手机使用本地软件页面不属于当前需求，不应据此压缩桌面信息密度、改变主布局或增加专门的移动端交互。

桌面布局应重视横向空间、完整表格与图表、鼠标键盘操作和角色在真实留白中的构图。验证优先覆盖 1920×1080、2560×1440 等代表性桌面显示场景，并记录实际 CSS 视口、系统显示缩放、浏览器缩放和侧栏占用；显示器分辨率不能直接当成页面可用宽度。

窗口缩小、并排使用与浏览器侧栏导致的空间变化按桌面场景处理，保持操作可达和必要的滚动。既有窄窗口适配可以保留；390px 一类历史验证不代表新增的手机产品需求，也不自动成为每次界面工作的交付门槛。

分享功能中，生成图片的操作界面仍以 PC 为基准；导出的图片会被接收者在手机上阅读，因此图片自身需要检查约 360px 显示宽度下的文字和信息层级。页面适配与图片阅读分别验收，不能把成品图的手机阅读要求扩展到整个软件。

## 代码入口

- `src/cli.js`：命令、前台/后台服务和网关管理。
- `src/server.js`：本地 HTTP API、导入、索引刷新、自动价格发现调度。
- `src/usage-core.js`：来源发现与分类、标准事件、内存报告、时间与周期统计。
- `src/usage-store.js`：SQLite 增量索引、迁移、查询、元数据与限额聚合。
- `src/usage-executor.js`：**唯一**持有 `DatabaseSync` 的 worker 执行器（2026-10-10 引入）；主线程只从它发布的读侧快照应答轻量端点。
- `src/zcode-usage.js`、`src/dsh-usage.js`、`src/opencode-usage.js`、`src/claude-code-usage.js`：各来源适配器。
- `src/repository-identity.js`、`src/service-tier-evidence.js`：仓库身份和服务档位证据。
- `src/pricing.js`：有效价目、费用估算与不确定性标记。
- `src/pricing-auto.js`、`src/pricing-store.js`：公开来源解析、刷新、发现、持久化与手动覆盖。
- `public/pricing-models.js`、`public/usage-fields.js`、`public/timeline-utils.js`：前后端共享的纯逻辑。
- `public/app.js`、`public/app-state.js`、`public/calendar.js`、`public/i18n.js`、`public/styles.css`：页面、状态、日期、语言和样式。
- `public/skins.js`、`public/skin-palettes.js`、`public/skin-ui.js`、`public/skin-picker.js`、`public/skins.css`：角色注册表、配色、运行时和选择器；`scripts/prepare-skin-assets.mjs` 生成并校验资源 manifest 与首屏脚本。

皮肤配色的唯一手写源是 `public/skin-palettes.js`（10 套 × 浅深 × 12 个 token）；`public/skin-bootstrap.js` 与 `public/skin-assets.json` 只能由 `npm.cmd run skins:prepare` 从当前源生成，`npm.cmd run skins:check` 只读核对源、资产和生成物。候选生成→捕获→报告→选择→production 的准确 CLI、隔离参数和输出位置以 [B 的 CLI 兼容调查](validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m62-reaccept-20261020/engineering-gates/cli-compatibility.md)为准；旧轮 `--production` 只绑定旧迁移来源，不能写成当前新轮通过或据此新增兼容层。任何源字节变化都会使旧摘要/capture 过期，须按受影响范围重测；本轮证据根为 [新轮验收](validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m62-reaccept-20261020/README.md)。本轮全仓工程门禁独立登记，不以旧 CLI 或本段生成/核对命令代替。

## 单执行器与读侧快照（2026-10-10）

重活（`sync`、`summarize`、`periodComparison`）全部在 `src/usage-executor.js` 的 worker 里执行，**数据库连接只在执行器内**；主线程不打开库，只用执行器 `postMessage` 发布的**已提交读侧快照**应答 `/api/status`、`/api/pricing`、`/api/imports`、`/index.html`（判据 p95 ≤ 100 ms / max ≤ 250 ms）。要点：

- **并发合并**：`src/server.js` 的 `loadUsageStore()` 用 `syncPromise` 把并发重请求合并成一次同步（"两轮并发只允许发出一次 `sync` 消息"由 `test/w1-executor.test.js` 的计数断言把守）。
- **故障恢复**：执行器崩溃 ⇒ 在途请求以 `EXECUTOR_EXITED`（`retryable: true`）结算而不挂死；下一次请求就地重启一次（**无重试循环**）；`close()` 幂等且显式等待 flush/退出（`test/w3-fault.test.js`）。
- **发布原子性**：读侧快照要么为空、要么完整；发布中途不得出现半成品（`F2-half-publish` 突变机械钉住）。
- **时钟源**：`checkedAt` 由 worker 盖戳，与主线程注入的固定时钟**不同源** ⇒ 做"整响应逐字节对照"时必须屏蔽时刻/诊断字段（V1 用 7 条具名白名单，含 `^modelActivity\.modelUsageAsOf$`）。
- **对账纪律**：`tools/out` 是只读锚点，**禁止对其中任何 `.sqlite` 做打开（含 `readOnly:true`）**——WAL 库只读打开也会生成 `-wal`/`-shm`。跑会写它的套件前先逐字节快照、跑后还原，并用 `lead-acceptance/T1/pre-run-hashes.txt` 复核 0 变更/0 缺失。

## 检查命令

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run skins:check
npm.cmd run skins:palette
```

有意修改配色源后，先运行 `npm.cmd run skins:palette`，再用新 Node 进程运行 `npm.cmd run skins:prepare`，最后运行 `npm.cmd run skins:check`；日常只读核对不要执行 prepare。

按实际影响选择验证，不以旧文档中的测试数量为通过条件。

- 来源与字段映射：适配器测试、`test/usage-core.test.js`、`test/usage-store.test.js`、`test/three-path-parity.test.js`；三路指内存、SQLite 与浏览器纯统计，不再生成 HTML。
- 计价与更新：`test/pricing.test.js`、`test/pricing-models.test.js`、`test/pricing-auto.test.js`、`test/server.test.js`。
- 界面与时间：`test/app-render.test.js`、`test/app-toolbar.test.js`、`test/recent-selections.test.js` 及对应日期、语言测试；布局和焦点需浏览器检查。
- 仅文档整理：检查本地链接和路径、历史状态、原始证据完整性及被移动的重跑脚本；无需重跑全产品测试来证明文字调整。

2026-09-30 的浏览器脚本已移入[日期验收目录](validation/2026-09-30-ui-pricing/README.md)。它依赖本机 Edge 和外部提供的 Playwright，可用环境变量指定，未增加生产依赖。

## 数据与并行工作

用隔离 home、fixture 和独立验证目录；保留真实 `pricing.json`、`pricing-auto.json`、用量索引与原始日志。活库持续写入，顺序执行两次汇总不能作为同一快照的对照证据。

多个任务使用独立分支和 worktree；有前置依赖时基于共同提交，合并后验证。只创建分支并不能保存尚未提交或未跟踪的文件。暂存与提交由一个会话协调，先查看 `git diff --cached`，确保受测业务文件与待提交快照一致。

## 文档维护

### 旧 HTML 导出与历史验证

2026-10-03 已移除独立 HTML 导出器、包脚本和前端内嵌报告/资源分支。暂停自动刷新使用的服务端冻结快照、CLI `summary --json`、导入、计价和角色资源继续保留；新分享图片仍处于[计划阶段](plans/2026-10-03-mobile-share-card-consolidated-plan.md)。新增浏览器模块无需注册旧内联闭包或通过整页 `file://` 导出验收。

旧计划、发布截图与验收日志记录当时的实现，历史命令不能直接作为当前要求。依赖已删除导出器的验收脚本须在对应 revision 重跑。当前清理结果见[导出移除验收](validation/2026-10-03-export-removal/README.md)。

### 日常维护

长期行为写入现行专题；优先级和完成状态只写入 02。验证记录包含日期、受测 revision/工作区、条件、命令、结果及未测部分。价格、测试数和探针总量只作为带日期的快照。

计划完成或被替代时，先把有效规则合入专题，把遗留项纳入 02，再归档原文并加历史说明。调整路径时修复 Markdown 引用；保留少量确有用途的兼容入口，不复制多份正文。原始截图、JSON 和检查日志保留原内容，历史命令与路径的语境由归档说明解释。
