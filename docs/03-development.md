# 开发与接手

更新：2026-11-11。先读[文档入口](00-index.md)和[任务清单](02-tasks.md)，交付操作见[构建、升级与回滚](15-delivery-upgrade.md)。

## 环境与启动

项目使用 Node ESM，运行要求以 `package.json` 的 `engines` 为准（当前 `>=23.8`）。没有生产 npm 依赖；三个开发依赖是 TypeScript、Biome 和 Node 类型声明。TypeScript 也被配色工具用于源码解析。

Windows 使用 PowerShell 7（`pwsh`），运行 `npm.cmd` / `npx.cmd` 无需修改执行策略：

```powershell
node --version
npm.cmd ci
node src/cli.js run
```

默认页面为 `http://127.0.0.1:3765`，前台服务用 Ctrl+C 停止。后台服务与网关参数见 `node src/cli.js --help`。Windows 配套助手由 `native:build` 显式构建，`native:check` 只读校验；Rust/Cargo 只用于构建该助手，普通运行不调用编译器。

## 界面设计与验收基准

页面面向 PC、鼠标键盘操作，以 16:9 高分辨率桌面为基准，优先检查 1920×1080、2560×1440 及实际并排／侧栏场景。记录 CSS 视口、OS 显示缩放和浏览器缩放，不能把显示器分辨率当成页面宽度。

既有窄窗口适配保持操作可达，不为手机场景压缩桌面信息密度。分享图片本身才需要检查接收端约 360px 的阅读效果。机制、估算和边界解释放在主动展开的详情，避免增加常驻说明框。

## 代码入口

| 位置 | 职责 |
| --- | --- |
| `src/cli.js`、`src/server.js` | 命令、服务与 HTTP API、导入、刷新和价格调度 |
| `src/usage-executor.js`、`src/usage-store.js` | 独立计算进程、SQLite 写入、迁移与查询 |
| `src/usage-summary-cache.js` | 持久摘要、读侧发布版本核对与重开复用 |
| `src/usage-core.js`、各 `*-usage.js` | 来源发现、标准事件、内存报告及六来源解析 |
| `src/usage-source-*.js`、`native/windows-source-proof/` | 来源指纹、增量证明、读取稳定性与 Windows 助手 |
| `src/usage-*-store.js`、`src/usage-history*.js` | 持久派生视图、历史查询与归档维护 |
| `src/pricing*.js`、`public/pricing-models.js` | 价目、费用、来源更新与共享模型映射 |
| `public/app*.js`、`calendar.js`、`i18n.js`、CSS | 页面状态、交互、日期、语言及布局 |
| `test-support/` | 夹具与独立统计对照；不进入浏览器加载链 |

皮肤源码、工作室和工具见[皮肤维护](13-skins.md)。[面板几何样板](panel-anatomy.html)直接复用生产 CSS，供布局维护参考。旧实验已移出，复现入口见[实验归档](archive/2026-11-11-experiments/README.md)。

## 执行、发布与数据边界

重同步和统计由独立计算进程执行，空闲后关闭索引连接并退出。服务持有轻量状态和摘要缓存，并短暂只读检查已发布版本；不能再把“只有执行器会打开任何 SQLite”当作架构约束。

并发重请求通过既有 `syncPromise` 合并；执行器崩溃时在途请求明确失败，后续请求可以重启并重新发布完整状态。保留 WAL 变化检测、来源前后稳定性校验、事实事务、读侧发布与缓存失效边界。

默认网关 old-space 为 512 MiB，执行器为 224 MiB、semi-space 4 MiB；这是堆预算，不是总内存保证。具体性能结论必须绑定测量版本和输入。

使用隔离 home、fixture 和独立验证目录。保护真实索引、原始日志、配置、冷包、manifest 与恢复备份；活库连续两次查询不能当作相同快照对照。历史 `tools/out` 若存在，继续作为只读证据保留，不打开其中 SQLite 或重建它。

## 检查命令

```powershell
npm.cmd run typecheck
npm.cmd run lint -- --error-on-warnings
npm.cmd run format:check
npm.cmd run skins:check
```

### 怎么跑测试

使用 Node 内置 `node:test`，测试入口为 `test/**/*.test.js`。按改动选择已有用例；完整集成使用与[CI](../.github/workflows/ci.yml)相同的并发和超时：

```powershell
node --test test/usage-core.test.js test/usage-store.test.js
node --test --test-name-pattern="skins:check" test/skins.test.js
node --test --test-reporter=spec --test-concurrency=4 --test-timeout=720000 "test/**/*.test.js"
```

`--test-name-pattern` 不阻止文件级 import。完整运行以退出码和 `pass / fail / skipped / cancelled` 汇总判断，不把旧文档中的固定测试数当成门槛。CI 当前配置为 Windows、Node 22/24；运行要求仍以 package engines 和实际依赖能力为准。

多数测试在系统临时目录构造并清理数据；皮肤工具的集成夹具可能创建于 `docs/validation/`，因为被测接口会核对输出位置。沙箱 EPERM、符号链接权限和路径限制需与代码失败区分，不能因此放宽断言。

浏览器测试使用 `AGENT_USAGE_PLAYWRIGHT_MODULE` 或本机 Codex Playwright 入口；Edge 可通过 `AGENT_USAGE_EDGE_PATH` 指定。CI 另行安装浏览器测试依赖，它不进入生产依赖。部分像素检查缺环境会明确失败，其余显式跳过；以各用例的实际原因判断。

原生助手行为测试可显式设置 `Q6_TEST_HELPER`；构建测试由 `AGENT_USAGE_TEST_NATIVE_BUILD=1` 启用。仅改文档时检查链接、命令与证据，不为文字调整重新构建助手。

源码 ZIP 会通过 `.gitattributes` 排除多数日期证据及作者 PNG；依赖它们的用例会显式跳过。`skins:check` 验证发布资源，`skins:check:sources` 才额外检查作者源图，缺源图时报告 SKIP。完整素材验收使用作者工作树。

## 文档维护

### 旧 HTML 导出与历史验证

独立 HTML 导出已退出，在线冻结、CLI `summary --json` 和导入继续保留；[分享图片](plans/2026-10-03-mobile-share-card-consolidated-plan.md)未实施。旧脚本依赖旧模块时，在对应版本或外部归档中复现。

### 日常维护

长期规则写入专题，状态写入 02，待实施方案放在 `plans/`。完成、暂停或被替代的施工材料移入 `archive/`，保留原失败和未完成项。日期截图、JSON、日志和哈希绑定夹具保持原样。

调整路径时同步本地链接与索引；删除只做重复跳转的旧页，目录 README 可保留简短导航。多任务使用独立 worktree 并协调提交，提交前核对暂存内容及受测快照。
