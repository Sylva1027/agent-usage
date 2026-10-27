# TPS-worker-A D1-D3 收尾报告

日期：2026-10-21

结论：D1、D2、D3 数据侧工作完成，V3 静态门禁已通过，D3 等待主审最终复核。D1/D2 已由主审定向复核通过。

## 基线

- 开工 HEAD：`b717d9156d0b211de101ee5f28dd236c12889485`
- 未提交、未推送、未重启真实服务、未主动执行真实来源 smoke/重扫、未执行全仓门禁。首次 D3 的 W1 漏隔离测试曾意外只读发现默认真实来源，失败与修正过程保留在下方。
- 日志目录：`docs/validation/2026-10-21-model-speed-implementation/D/`

## 文件边界

产品代码：

- `src/perf-stats.js`
- `src/usage-core.js`
- `src/usage-store.js`
- `src/usage-types.js`

测试：

- `test/perf-models.test.js`
- `test/perf-summary-parity.test.js`
- `test/perf-state.test.js`
- `test/cli.test.js`
- `test/perf-server.test.js`
- `test/perf-codex-api.test.js`
- `test/w1-executor.test.js`

未修改 `public/`、UI 测试、服务端分支、SQL/schema、来源 reader、执行器产品代码或服务管理。

## 实现摘要

- D1：从同一 sampled 集合投影 `summary.perf.models`；按规范 `sourceKind/model/reasoningEffort` 合并，跨 home/channel/provider/main-subagent 折叠；均值使用输出 token 总和除以时长总和，分位使用 nearest-rank，溢出行三个统计值与 `rank` 为 null 并排在有效行后。
- D2：内存路径与 store 路径都显式透传 `models`；`PerfSummary` 增加四件套形状；`rebuilding`/`uninitialized` 返回空 `models`；`PerfModelRow` 固定为 10 个公开字段。
- D3：验证 `/api/usage`、dashboard、`/api/summary`、`detail=full`、Codex live/冻结快照、执行器消息及 dashboard 崩溃恢复都保留同一模型速度行；冻结后 live 变化不污染旧快照；project-log 不生成模型行；公开模型行不含内部载体键。

## 验证结果

| 卡 | 命令 | 结果 | 日志 |
| --- | --- | --- | --- |
| D1 基线 | `node --test test/perf-stats.test.js test/perf-summary.test.js` | 95/95，exit 0 | `D1-baseline.log` |
| D1 完成 | `node --test test/perf-stats.test.js test/perf-summary.test.js test/perf-models.test.js` | 101/101，exit 0 | `D1.log` |
| D2 | `node --test test/perf-summary-parity.test.js test/perf-state.test.js test/perf-codex-index.test.js` | 152/152，exit 0 | `D2.log` |
| D3 API/CLI | `node --test test/perf-server.test.js test/perf-codex-api.test.js test/cli.test.js` | 27/27，exit 0 | `D3.log` |
| D3 执行器定向 | `node --test --test-name-pattern "dashboard skipCheck|summarize / periodComparison" test/w1-executor.test.js` | 2/2，exit 0 | `D3.log` |

D3 最终合计：29/29 通过，exit 0。收口时仅合并了一次重复冻结读取，`test/perf-codex-api.test.js` 复跑 2/2 通过。另执行 `node --test test/perf-models.test.js`，6/6 通过；`git diff --check` 无输出。

## V3 静态收口

- 仅对 D 所属的 `src/perf-stats.js`、`test/perf-models.test.js`、`test/w1-executor.test.js` 做了格式化修正，逻辑未变。
- `npm run typecheck`：exit 0。
- `npm run format:check`：exit 0，检查 180 个文件。
- `npm run lint`：exit 0；剩余 54 warnings、4 infos，无 error。
- `node --test test/perf-models.test.js`：6/6 通过。
- `node --test --test-name-pattern "dashboard skipCheck|summarize / periodComparison" test/w1-executor.test.js`：2/2 通过。
- 按主审要求未重跑全仓测试；主审报告的现状为 2607 pass / 3 fail / 30 skip，3 个失败均为浏览器运行时的 HOME 隔离问题，不属于 D 数据逻辑。

## 失败与修正轨迹

- D3 首次新增的 project-log 用例把公开 unsupported 条目的字段误写成 `kind`；当前索引路径公开形状是 `sourceKind/homeId/code/count`。用例已改为先由 `metadata.homes` 定位 project-log 的 `homeId`，再验证该 home 出现在 `unsupportedSources`，同时保留“不出现 project-log-model、模型行恰好 10 字段、无路径外泄”的断言。
- D3 首次执行器中用例得到 7 条模型行而非 1 条。原因是测试 `sync({ options: { force: true } })` 覆盖了执行器初始化时的完整 discovery options，导致再次按进程环境发现真实来源；修正为传 `{ ...fixture.reportOptions, force: true }`，并在本次触及的 executor/server 隔离入口显式使用 `env: {}`。这是测试隔离修正，不改产品代码。
- 首个 D3 日志在取得上述失败堆栈后停止，原文保存在 `D3-initial.log`；最终通过版本为 `D3.log`。

## 已知边界

- 既有 `summary.perf.unsupportedSources` 在索引路径与 `detail=full` 内存路径的条目形状不同：索引路径为 `sourceKind/homeId/code/count`，内存路径为 `kind/homeId`。本卡未改既有投影；D3 用共同可见的 `homeId` 验证 project-log 被单列且不进入模型行。
- 未运行全仓门禁、真实用户来源 smoke、真实服务重启或浏览器验证；这些由主审的 V 阶段承担。
- 未修改并行进行中的 UI/文档工作；工作区中的 `public/`、UI 测试及其他非 D 文件变更不属于本报告。

## 下一卡状态

- D1：完成，主审定向复核通过。
- D2：完成，主审定向复核通过。
- D3：完成，V3 静态门禁通过，待主审最终复核。
- 后续：主审完成最终复核；本轮不重复全仓测试。
