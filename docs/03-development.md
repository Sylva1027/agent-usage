# 开发与接手

更新：2026-10-30（轻量服务与索引检查优化）。先读[文档入口](00-index.md)和[任务清单](02-tasks.md)，再按任务阅读现行专题。

## 环境与启动

项目使用 Node ESM，`package.json` 与锁文件要求 Node `>=23.8`。本地输出采集另依赖锁定版本 `tiktoken@1.0.22`，汇总 reader 延迟加载分词器；release ZIP/TAR.GZ 已附带运行依赖，源码安装执行 `npm ci --omit=dev`。开发检查执行 `npm ci` 安装全部依赖。

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
- `src/codex-quota-cache.js`：本地额度快照与单机授权后的缺窗只读恢复；默认关闭联网补齐。
- `src/usage-executor.js`：**唯一**持有 `DatabaseSync` 的 worker 执行器（2026-10-10 引入）；主线程只从它发布的读侧快照应答轻量端点。
- `src/zcode-usage.js`、`src/dsh-usage.js`、`src/opencode-usage.js`、`src/claude-code-usage.js`、`src/workbuddy-usage.js`：各来源适配器。
- `src/repository-identity.js`、`src/service-tier-evidence.js`：仓库身份和服务档位证据。
- `src/pricing.js`：有效价目、费用估算与不确定性标记。
- `src/pricing-auto.js`、`src/pricing-store.js`：公开来源解析、刷新、发现、持久化与手动覆盖。
- `public/pricing-models.js`、`public/usage-fields.js`、`public/timeline-utils.js`：前后端共享的纯逻辑。
- `public/app.js`、`public/app-state.js`、`public/calendar.js`、`public/i18n.js`、`public/styles.css`：页面、状态、日期、语言和样式。
- `public/skins.js`、`public/skin-palettes.js`、`public/skin-ui.js`、`public/skin-picker.js`、`public/skins.css`：角色注册表、配色、运行时和选择器；`scripts/prepare-skin-assets.mjs` 生成并校验资源 manifest 与首屏脚本。

皮肤配色的唯一手写源是 `public/skin-palettes.js`（10 套 × 浅深 × 12 个 token）；`public/skin-bootstrap.js` 与 `public/skin-assets.json` 只能由 `npm.cmd run skins:prepare` 从当前源生成，`npm.cmd run skins:check` 只读核对发布内容（manifest、40 个 WebP 副本哈希、bootstrap），`npm.cmd run skins:check:sources` 再把副本与作者源 PNG 绑定。候选生成→捕获→报告→选择→production 的准确 CLI、隔离参数和输出位置以 [B 的 CLI 兼容调查](validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m62-reaccept-20261020/engineering-gates/cli-compatibility.md)为准；旧轮 `--production` 只绑定旧迁移来源，不能写成当前新轮通过或据此新增兼容层。任何源字节变化都会使旧摘要/capture 过期，须按受影响范围重测；本轮证据根为 [新轮验收](validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m62-reaccept-20261020/README.md)。本轮全仓工程门禁独立登记，不以旧 CLI 或本段生成/核对命令代替。

## 轻量服务、计算进程与本地汇总（2026-10-29）

重活（`sync`、`summarize`、`periodComparison`）由 `src/usage-executor.js` 启动独立计算进程执行，空闲 200 ms 后关闭索引连接并退出。HTTP 服务保存轻量状态，`src/usage-summary-cache.js` 将汇总写入索引旁的 `.summaries.sqlite`；主服务只对索引做短只读查询，检查已发布版本。来源及统计边界未变时，刷新和服务重启均可复用汇总，无需启动计算进程。冻结快照沿用独立数据库和相同计算入口。

2026-10-30 正式接入的 Node 优化：DSH 在异步交接前只保留统计与性能必需字段；Codex 前缀完整校验与头尾探针合并读取，大 home 使用同一计算器内的有界异步 reader；SQLite 样本迭代消费，及时释放旧集合。只有成功发布时已经确认缺失且仍然缺失的历史依赖可以复用候选；新增缺失、返回、内容或归属改变仍重建。完整哈希及发布稳定性检查保留。历史冠军计价复用请求内模型字典，额度观测每个读事务只读取一次。真实输入与现场测量见[性能验收](validation/2026-10-30-node-performance/README.md)。

额度恢复由 `src/server.js` 在当前 5h/7d 缺窗响应后按单机授权触发，官方凭据交客户端管理；默认不调用。规范观测同时用于内存报告、Store 元数据和冻结结果，`src/usage-summary-cache.js` 把其内容纳入签名并在真实 reset 失效，重试时间不使统计缓存失效。缺窗不数学续期，已有有效窗口不查询。行为与验证见[看板说明](12-dashboard.md)及[7d 验收](validation/2026-10-30-quota-recovery/README.md)。

- **内存预算**：后台 `gateway` / `restart` 的默认父服务参数仍为 `--max-old-space-size=512`，计算进程单独限制为 old-space 224 MiB、semi-space 4 MiB，计价 memo 为 8/16 MiB。它们都是堆或缓存预算，不能当作总内存上限；验收统计同一时刻服务与活跃计算进程的工作集、私有提交之和。性能投影按需加载，性能样本与 DSH 行流式消费，批量写样本复用 prepared statement。整合实测与限制见[验收记录](validation/2026-10-29-local-summary-adoption/README.md)。
- **并发合并**：`src/server.js` 的 `loadUsageStore()` 用 `syncPromise` 把并发重请求合并成一次同步（"两轮并发只允许发出一次 `sync` 消息"由 `test/w1-executor.test.js` 的计数断言把守）。
- **故障恢复**：执行器崩溃 ⇒ 在途请求以 `EXECUTOR_EXITED`（`retryable: true`）结算而不挂死；下一次请求就地重启一次（**无重试循环**）；`close()` 幂等且显式等待 flush/退出（`test/w3-fault.test.js`）。
- **发布原子性**：读侧快照要么为空、要么完整；发布中途不得出现半成品（`F2-half-publish` 突变机械钉住）。
- **时钟源**：源检查的 `checkedAt` 由服务盖戳；汇总命中后用共享公式更新流速、模型活动期及额度陈旧状态。跨日、未来事实生效、额度边界、来源或索引发布变化会使相关汇总失效。冻结结果始终使用冻结时刻。
- **对账纪律**：`tools/out` 是只读锚点，**禁止对其中任何 `.sqlite` 做打开（含 `readOnly:true`）**——WAL 库只读打开也会生成 `-wal`/`-shm`。跑会写它的套件前先逐字节快照、跑后还原，并用 `lead-acceptance/T1/pre-run-hashes.txt` 复核 0 变更/0 缺失。

## 检查命令

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run skins:check
npm.cmd run skins:check:sources
npm.cmd run skins:palette
```

有意修改配色源后，先运行 `npm.cmd run skins:palette`，再用新 Node 进程运行 `npm.cmd run skins:prepare`，最后运行 `npm.cmd run skins:check:sources`；日常只读核对不要执行 prepare。`skins:check` 只验发布内容（manifest、40 个 WebP 副本哈希、bootstrap），在缺少 `lineart assets/` 的发布包中也能通过；`skins:check:sources` 额外把副本与作者源 PNG 绑定，源图缺失时明确打印 `SKIP` 而不是 `PASS`。

按实际影响选择验证，不以旧文档中的测试数量为通过条件（怎么跑、怎么读结果见下一节）。

- 来源与字段映射：适配器测试、`test/usage-core.test.js`、`test/usage-store.test.js`、`test/three-path-parity.test.js`；三路指内存、SQLite 与浏览器纯统计，不再生成 HTML。
- 计价与更新：`test/pricing.test.js`、`test/pricing-models.test.js`、`test/pricing-auto.test.js`、`test/server.test.js`。
- 界面与时间：`test/app-render.test.js`、`test/app-toolbar.test.js`、`test/recent-selections.test.js` 及对应日期、语言测试；布局和焦点需浏览器检查。
- 仅文档整理：检查本地链接和路径、历史状态、原始证据完整性及被移动的重跑脚本；无需重跑全产品测试来证明文字调整。

### 怎么跑测试

测试用 Node 内置的 `node:test`，没有 Jest/Vitest 之类的框架，90 个测试文件全部放在 `test/`。所有命令都在仓库根目录执行。

#### 第一次跑

```powershell
npm.cmd ci        # 装 devDependencies：typescript、biome、@types/node
npm.cmd test      # 全部测试，本机约 10–15 分钟
```

`npm.cmd test` 就是 `node --test "test/**/*.test.js"`：Node 会为每个测试文件起独立进程并行跑，一个文件失败不影响其他文件，最后打印 `tests / pass / fail / skipped` 汇总。任何 `fail` 都让退出码非 0。

测试依赖包括配色检查使用的 `typescript` 和实际输出采集使用的 `tiktoken`。完整检查前执行 `npm ci`；Windows PowerShell 7 使用 `npm.cmd ci` 可避开脚本执行策略限制。

#### 只跑关心的部分

```powershell
node --test test/skins.test.js                                    # 一个文件
node --test test/skins.test.js test/pricing.test.js               # 几个文件
node --test --test-name-pattern="skins:check" test/skins.test.js  # 名字匹配的用例
```

`--test-name-pattern` 是正则，匹配的是 `test("...")` 的名字。注意它只过滤用例，文件仍会被完整加载，所以文件级 import 错误照样出现。

**跑得慢是正常的**：完整套件里最慢的是两个皮肤集成用例——`D9f-2` 约 1 分钟、`E1` 约 3 分钟——它们会把 160 多个文件复制进验证沙箱并启动子进程。日常改文档或纯逻辑时只跑相关文件即可，不必每次跑全量（选哪些文件见上一节）。

#### 测试写到哪里

- 绝大多数用例用 `mkdtemp` 在系统临时目录下建独立目录，跑完删除。
- 皮肤配色的集成用例必须在仓库内的 `docs/validation/` 下建 `m4-4-*` 前缀的临时目录，因为被测代码会校验"证据目录必须是仓库的相对路径"。这些目录跑完也会删除；如果测试被强制中断，可能残留 `docs/validation/m4-4-*` 目录，可手动清理。
- 测试不会读写真实的 `~/.codex-usage`、`~/.codex` 或 `~/.claude`：需要 home 的用例把 `homeDir` / `HOME` 或索引、导入文件路径显式指向临时目录。

#### 跳过（skipped）是什么意思

跳过是**显式**的，每条都带原因，用 `t.skip("...")` 写在用例开头。当前只有三类：

1. **环境缺符号链接权限**：Windows 未开启开发者模式时创建文件符号链接会 `EPERM`，相关"拒绝符号链接"分支跳过（`file symlinks unavailable: EPERM`）。这是环境限制，不是功能缺失；2026-10-21 本机完整套件里 20 条属于这一类，条数随本机是否允许创建符号链接而变。
2. **发布包没有日期证据**：从 GitHub 源码压缩包解出的树里没有 `docs/validation/` 的历史截图/日志，读取它们的用例（`D6`、`D8u3B1`）跳过。
3. **发布包没有作者源图**：`lineart assets/` 不随源码包分发，直接读默认仓库根目录的用例跳过，共 12 个：`test/skin-palette-review-production.test.js` 里 8 个（`D9c` ×3、`D9d-2` ×4、"reads all registered generated assets"）、集成用例 `D9f-2` 与 `E1`、`test/skins.test.js` 里 `skins:check:sources` 的 2 个。作者仓库里这些用例正常执行。

**跳过不等于通过**，但也不该被当成失败。判断标准：日志里的 `﹣` 行后面写着原因；如果没有原因或原因不是上面三类，说明是意外跳过，需要查。

#### 浏览器用例

少数用例要真实浏览器来量像素、检查焦点和截图。查找顺序：

1. `AGENT_USAGE_PLAYWRIGHT_MODULE` 指向的 Playwright 入口；
2. `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs`（本机 Codex 自带的运行时）；
3. 都没有则视为无浏览器。

Edge 可执行文件由 `AGENT_USAGE_EDGE_PATH` 指定，不设则用系统默认安装位置。

有浏览器时这些用例真实执行。没有时**大部分会跳过**并标注 `ENVIRONMENT_BLOCKED`，但下面三处故意用 `assert.ok` 硬性要求浏览器，缺环境时是**失败**：

- `test/skin-palette-quality.test.js` 的 `E1c`、`E1d`
- `test/skin-palette-screenshot-caret.test.js` 的 `D8u11`

它们的存在就是为了防止把"没跑"记成"通过"——涉及像素级结论的检查不允许静默降级。

像素级用例在机器满载时可能偶发 1 级色差（例如"移除遮挡层后逐像素恢复"报告 194 个 `maxChannelDelta: 1` 的像素）。这类失败先单独重跑该文件确认；能稳定通过就不是代码回归，不要为此放宽断言。

#### 和 CI 的差别

CI 在 Windows 上跑 Node 22 和 24 两档，命令是：

```bash
node --test --test-reporter=spec --test-concurrency=4 --test-timeout=600000 "test/**/*.test.js"
```

`--test-concurrency=4` 限制并行进程数（避免浏览器用例互相抢资源），`--test-timeout=600000` 给单文件 10 分钟。CI 会先安装 Playwright 1.62.1 并导出 `AGENT_USAGE_PLAYWRIGHT_MODULE`，所以浏览器用例在 CI 里是真跑的。之后依次跑 `typecheck`、`lint`、`format:check`，见 [ci.yml](../.github/workflows/ci.yml)。

本地复现 CI 的测试阶段：

```powershell
node --test --test-reporter=spec --test-concurrency=4 --test-timeout=600000 "test/**/*.test.js"
```

#### 从源码压缩包跑测试

从 GitHub Releases 下载的源码包（`Source code (zip)`）由 `.gitattributes` 的 `export-ignore` 裁剪过，和 `git clone` 的仓库有两处不同：

- 没有 `docs/validation/` 下的日期证据 → 2 个用例跳过；
- 没有 `lineart assets/` 作者源图 → 12 个用例跳过。

因此源码包里的完整套件是 **0 失败、14 个发布包相关跳过**，再加本机符号链接限制的跳过（2026-10-21 实测：2658 项，2624 通过 / 0 失败 / 34 跳过）。`skins:check:sources` 也会打印 `SKIP` 而不是 `PASS`，因为源图不存在——这是如实报告，不是故障。页面运行、`skins:check`、其余测试都不受影响。

要在源码包里验证这些被跳过的用例，请 clone 仓库后运行。

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
