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
