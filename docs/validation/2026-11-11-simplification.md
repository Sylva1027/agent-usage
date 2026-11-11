# 项目精简实施记录

基线：`5d93578`；实施计划：[复审版](../plans/2026-11-11-project-simplification-plan.md)。使用当前工作区、Windows、Node 26.13.0、`TZ=Asia/Shanghai`。提交按批次独立回退；不操作活动数据库或已安装服务。

## 入口核查

- 产品根：`src/cli.js`（两个 bin、summary/serve 命令）、`public/index.html` 的 `app.js` 与 `skin-bootstrap.js`、独立 `skin-palette-studio.html` 的工作室模块。
- TypeScript AST 跟踪静态 import/export 与字符串 dynamic import，产品根可达 61 个模块。`usage-executor.js` 的自 fork、`usage-source-proof.js` 的动态 native 导入及 CLI 的动态压实入口已另行核对。
- `src/public` 未被上述运行图覆盖的 JS 只有 `history-archives-ui.js` 和 `usage-types.js`。前者退场且只被专属测试导入；后者是 JSDoc 类型契约，保留。
- npm、两份 CI、HTML、原生协议、测试夹具和实验源码变换分别作为独立消费者核对；没有将测试引用直接视为产品入口。

## 七组审查结论

| 范围 | 已核查的入口与维护职责 | 结论 |
| --- | --- | --- |
| 索引、执行器、投影 | CLI/server → executor 消息分发 → store 的 sync/dashboard/metadata/periodComparison；projection、rollup、records、quota 和 summary 的持久化/缓存路径 | 保留执行器隔离、修订发布、外部提交检测、缓存失效及增量路径；只删除无消费者的投影表名清单 |
| 来源发现与证明 | usage-core/store → 六来源适配器；source-inputs/acquisition/progress/rows/proof/native；JSONL/DSH 与 SQLite reader | 合并四个完全相同的 knownToken；保留 WAL 检测、前缀校验与解析后复验，两次校验保护不同截点 |
| 归档、备份、压实 | CLI history 子命令、server 的 archive/import 路由、executor 操作分发及 history-query | 后端仍有现行入口；保留冷历史、覆盖层、receipt、备份和回滚。只删除闲置 schema 别名，不改变 schema |
| 前端、CSS、工具 | HTML 实际加载链、loadUsage → state.summary → render；palette browser-measure → adjacent analyzer | 删除退场归档 UI、旧焦点测量链；旧统计参考计算移出浏览器。共享样式、键盘操作、工作室与源码哈希校验保留 |
| 测试与支持 | test 由 CI 通配符执行；report-projection 及现有行为/独立预期断言 | 保留独立统计对照；删除只验证退场 UI/测量算法的测试；合并字节完全相同的日志和供应商页面夹具 |
| 五个实验目录 | architecture 有专用 CI、verify/collector-parity；node-index 的 matrix/report；node-startup 的 matrix 与源码变换；rust-integration 的 dsh/perf/compact-build；rust-parsing 的 node-baseline 与 native 内核 | 均有文档记录的历史复现用途；保留脚本、源码快照、证据及相对路径，不重新运行大矩阵，不因产品退出 TPS 删除研究材料 |
| 原生、脚本、配置、文档 | native main 分发 begin/verify/advance、journal/object/resolve/changes、archiveLock/Check/Unlock，与 JS 请求逐项对应；build.ps1、npm、CI、TypeScript 工具调用 | 保留协议边界、内存限制、构建和工具依赖。没有新增或删除 npm 依赖；deepFreeze 保留局部实现，避免扩大 solver/templates 依赖 |

这是全仓文件分类、入口/引用核查及候选与关键路径的定向审查，不是逐行证明约 32.7 万行代码不存在其他问题。没有消费者证据支持删除的模块维持现状；未重新验证历史实验的性能结论。

## 实施前完整基线

命令：`node --test --test-reporter=tap --test-concurrency=4 --test-timeout=720000 "test/**/*.test.js"`。

结果：3293 tests，3209 pass，15 fail，69 skipped，0 cancelled，330.3 秒。所有失败均出现在生产/测试代码改动之前。完整日志保存在本机忽略目录 `output/simplification-20261111/baseline.log`；本轮环境为 Node 26，仓库 CI 矩阵为 Node 22/24，不能把本机结果称为 CI 矩阵通过。

原有失败分布：history-period-executor 的 publication gate（database locked）；history-rollup-store 的重试更新计数及 Shanghai 子进程；q4-bulk-build 的 initial build 两项；refresh-sync-regressions 的 indexed_at 对比；skin-palette-quality 的 Edge 场景；SQLite 来源 WAL 回归中的 ZCode/OpenCode；usage-metadata-store-integration 的 source warnings、usage-store 的 scan failure 和 metadata warnings；v1-autorefresh；w1-executor 的 crash 后 skipCheck。最终按测试名称逐项比较，不用降低断言或跳过用例消除失败。

## 分批实施

### 01：退场归档 UI 和无调用声明

删除 `public/history-archives-ui.js` 及专属测试（14 个顶层用例），依据是 2026-10-26 的明确退场记录与运行入口核查。移除独占翻译，保留仍有其他用途的「事件数」；删除 englishCopyEntries、SKIN_PALETTE_DOCS、SKIN_RUNTIME_CONSTANTS、HISTORY_BACKUP_SCHEMA_VERSION 和 USAGE_HISTORY_PROJECTION_TABLE_NAMES。后端归档接口与共享样式继续保留。

验证：i18n、skins、app-render、app-autorefresh、history-backup、history-projection-*、history-archive-api，共 186 项通过，0 失败、0 跳过。遗漏引用扫描与 git diff --check 通过。

### 02：退出调用链的焦点测量

删除 measureFocusOutlinePixels、analyzeFocusOutlinePixels 及独占的读取、差分、恢复和 envelope 辅助代码；删除 9 个旧算法顶层测试，保留 6 个 adjacent 顶层测试及全部子断言。现行独立几何夹具只生成需要的 focused 帧。工具/测试净减少 630 行。

验证：focus-outline-browser、focus-outline-pixels、skin-palette-quality 共 517 项，516 通过、1 个原有失败、0 跳过。唯一失败与基线同名、同位置、同断言（quality:9275，搜索 x 得到空结果）；没有新增失败。现行焦点测量及释放、异常传播场景通过。未改历史源码哈希。

### 03：无消费者的计价入口

删除 API_TOKEN_PRICES 派生表、isPeakPricingTimeExact 及其专属 peakWindowsHitNaive；时区校准使用的 peakLocalTupleExact 保留。pricing、claude-pricing、w4-event-cost-memo 共 59 项全部通过，0 跳过；没有更改计价规则或边界断言。

### 04/05：旧前端统计链与日期重复

app.js 删除 694 行没有运行入口的范围解析、分组、费用与趋势计算、metadata 推导。独立逐事件参考迁至 test-support/summary-reference.js；只保留现行测试消费的计算，metadata 对照缩为 modelActivityFromReport。参考函数体与原版本逐项 AST 打印比较一致。所有调用方已迁移；渲染测试直接设置现有 state，纯范围断言迁到 app-summary。统计测试名称改为 reference，避免称为真实浏览器覆盖。

最终保留时间轴本地的日初/周初与页面 addCalendarDays：依赖复查发现，复用 period-comparison 会让浏览器额外加载 period-comparison 和 usage-fields 两个模块，仅减少 14 行函数不值得扩大加载链。timeline-utils 已恢复为基线原文。第 05 卡随旧生产统计链删除关闭，不合并独立参考算法与被测后端。

验证：12 个相关文件（页面渲染/刷新、timeline、recent、usage-core/store、quota、Claude 计价与统计对拍）共 255 项，253 通过、2 个原有 usage-store warnings 失败、0 跳过。两项失败名称/位置/断言与基线一致；没有新增失败。差异和遗漏引用检查通过。

### 06：四来源 Token 解析

四份 knownToken 函数体逐字核对相同后移到已有 usage-fields.js，调用者沿用既有依赖；删除无入口的 zcodeHomeLooksUsable。加入通过 OpenCode 适配器验证缓存写入零值、数值字符串、缺失、非有限数和负数的表驱动用例。

八个文件共 83 项，原有 82 项通过；新增用例最初缺少常量 import，补齐后单独重跑 OpenCode 全部 17 项通过。本批所有 83 个用例均已通过，没有未解决失败。

### 07：字面量测试夹具

14 个日志构造器合并到无依赖的 codex-log-fixture.mjs，两个测试文件的三种供应商页面复用 pricing-official-fixture.mjs。合并前逐函数比较源码，并验证生成文本逐字节相同；各测试临时目录、故障注入与断言保留。

16 个测试文件共 106 项：104 通过、1 个原有 publication gate/database locked 失败、1 跳过，没有新增失败。

### 08：有意保留的局部重复

五份 deepFreeze 和短路径/事务辅助保持原样，没有引入 contracts 依赖或新生产依赖。

### 09：入口核查收尾

复查 UsageStore 全部 102 个方法的引用。除下述两个维护/测试入口外，均找到其他产品引用；私有 rebuildHistoryRollupsTransaction 另外核对了两个直接调用。registerHistoryArchiveCandidate 用于归档夹具、注册冲突/重叠校验及 architecture 的 b3-history-benchmark；mergeHistoryArchiveEventsForRange 是现行冷热并集测试使用的两行 rows 包装。保留这两项，避免为了移动少量入口扩大约百处测试/复现改动。它们与已有明确退场记录的 UI 不同，没有删除其校验职责。

最终代码文件分类（JS/MJS/CJS/RS/PS1/CSS/HTML）：src 46、public 20、scripts 41、native 3、test 242、test-support 11；五个实验分别为 architecture 253、node-index 16、node-startup 17、rust-integration 22、rust-parsing 8；docs 136（含历史复现/图示）、.claude 2、.archify 1。文档/历史图示不作为产品入口，也不因没有普通 import 删除。全部文件按入口、测试/复现、历史证据归类；关键路径与删除候选的检查范围如上表。

集成静态检查发现 schema 别名删除后留下 STORE_SCHEMA_VERSION import，已清理；同时纠正过时的循环依赖注释。typecheck 通过；lint 回到基线 51 warning、3 info，无新增诊断。全仓 format:check 剩 40 个格式不合规文件，逐个取 5d93578 原文对照 formatter，确认全部为原有问题；未进行全仓格式重写。

最终复核：8 个生产/工具文件中保留的 326 个函数体，与基线 AST 打印结果相同。第一次集成全量出现 Q8 重启及 quota-recovery 两个 fetch failed，Q8 进程在清理时停滞；确认无子进程后仅结束该测试进程。单独 Q8 6 项通过，最后依赖调整后 Q8、quota-recovery、timeline、recent 共 32 项全部通过。保留第一次集成日志（final.log），重新运行全量于 final-recheck.log，不将该次瞬时失败隐藏为首次通过。

## 最终差异与验证边界

最终完整验证（final-recheck.log）：3264 项，3180 通过、15 失败、69 跳过、0 取消，319.0 秒。逐项比较失败名称，与实施前 15 项完全相同，**没有新增失败**。Q8 与 quota-recovery 的两项瞬时 fetch 失败在本次完整运行中均通过。

| 检查 | 实施前 | 最终 |
| --- | --- | --- |
| 完整测试 | 3293 项：3209 通过、15 失败、69 跳过 | 3264 项：3180 通过、相同 15 失败、69 跳过 |
| typecheck | 通过 | 通过 |
| lint | 51 warning、3 info | 51 warning、3 info，无新增 |
| format:check | 以基线原文逐文件对照 | 40 个原有格式问题；本轮新增格式问题已清除 |
| git diff --check | — | 通过 |

相对 `5d93578`，生产代码净减少 1,431 行、工具代码净减少 383 行、测试及支持代码净减少 704 行，合计 2,518 行（不含文档）。主页面可达 JS 源码在统一 LF 后减少 30,658 bytes；这是源码体积变化，没有据此声称启动或请求速度提升。没有新增 npm 依赖，数据 schema、SQL、页面 CSS 和生产计算函数体保持原样。

归档 UI 删除 14 个顶层测试；旧焦点算法删除 9 个顶层测试及 7 个子测试；来源边界新增 1 项。原有独立统计对照和现行焦点算法断言保留，测试总数因此从 3293 变为 3264。

未运行 Node 22/24 CI 矩阵、Rust 编译/测试、真实大数据库性能矩阵或部署；未逐行证明所有历史实验无冗余。本轮使用 Windows/Node 26 的现有完整测试、包含其中的真实浏览器场景，以及定向回归和静态检查。历史皮肤评审证据保留原哈希，未重新发布为新源码的证据。

已提交批次：`1c60bb7` 归档 UI、`b274a24` 焦点测量、`a9c9ca7` 计价死代码、`f1385f6` 统计参考迁移、`2abdace` Token 解析、`9def697` 测试夹具；最终收尾提交包含依赖复核修正及本记录。活动数据与服务未变更。

## 后续：修复原有失败与格式问题

用户继续授权修复上述 15 个失败和 40 个格式问题，起点为 `e6dee59`。沿用同一完整测试日志为修复前基线；每批核对根因、验证并独立提交，继续不操作活动数据库和已安装服务。

第一批：使用仓库 Biome 配置格式化 40 个文件，全部文件的 TypeScript 语法树在忽略位置和冗余括号后与原文相同。format:check、typecheck、lint 和 diff --check 通过；没有通过修改格式规则隐藏问题。完整行为回归随修复集成执行。
