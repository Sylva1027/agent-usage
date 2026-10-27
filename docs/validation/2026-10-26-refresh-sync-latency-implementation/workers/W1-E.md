# W1 · E-1 小卡交付

2026-10-26。产品与测试已落盘，W1 停止产品编辑，整文件写权交还 Main；等待 Main 运行验收，不自报 ACCEPTED。

## 基线与实际 diff

- cwd 已核实为 `E:\12 AI\ccusage\codex-usage`；HEAD 为 `f7643b26e7c08f8d298b58d678a6201648e910ba`。
- 开始时当前 `src/usage-store.js` 与 `output/refresh-sync-latency-implementation/pre-e-usage-store.js` SHA-256 均为 `55757E4E104D00E9C2683528EE78375CBA7C1C6051EA2050D38F7B0A15F08767`。前 E 副本保持只读；在最新产品文件上局部修改，保留 Main 的 D/P/C/B/L 及 formatter 改动。
- 实际写入 `src/usage-store.js`：相对前 E **+3/-2**。all 投影命中时 `summary.perf = projection?.perf ?? this.perfSummaryForRange(...)`；写投影时加入完整 `perf: summary.perf`；更新投影注释。没有新缓存、key 或 schema，没有扩 month。
- 实际写入 `test/perf-summary-parity.test.js`：本卡 **+67/-0**，新增一条复用/独立返回/精确范围与排除测试。
- 实际写入 `test/perf-store.test.js`：本卡 **+75/-0**；相对 HEAD 合计 +113/-0，其中 Main 原有 D 改动 +38 全部保留。新增一条本连接/外连接修订、元数据及回滚测试。
- 实际写入本唯一 E 卡记录 `docs/validation/2026-10-26-refresh-sync-latency-implementation/workers/W1-E.md`。

## 复用边界与关键断言

沿用既有 projectionCacheable、完整 projection key 和读快照：store/derived revision、SQLite total_changes/data_version、解析后精确范围、bucket、exclude、includeDetails、service-tier evidence、价目键/版本/汇率均维持既有失效行为。仅完整 key 命中才复用 perf，价格变化也重建 perf。quota、非 all、写事务及未验证冷 authority 均继续原分支；验证后的 SQL 冷读沿用自己已有的投影槽，完整 carrier 分支不改。

完整 perf 块包含 coverage、codexTimingCoverage、groups/models、warnings、missingSources、indexedAt、状态及 meta；写入与读取继续使用既有 structuredClone，调用者不能改坏缓存。`summarize()`、`perfSummaryForRange()` 保持同步返回，独立 perf 调用不使用新增旁路。

已写但尚未运行的两条用例断言：

1. 相同 all 输入只构建一次 perf；完整块相等，嵌套 sums/coverage/models/warnings/missing/indexedAt 的调用者修改不影响下一次结果。
2. recent 窗口相差 1 ms 时，完成样本计数由 1 变 2，并与内存统计逐字段对拍；非 all 每次独立构建，不污染 all 槽。exclude 改变时重建后按新范围复用。
3. 本连接不推进 storeRevision 的原始 SQL 更新由 total_changes 使缓存失效；状态/warnings/missing/indexedAt 更新也失效，随后完整元数据可复用。
4. 外连接提交通过 data_version/读修订失效；显式 commitStoreRevision 也失效。写事务既不读取旧 perf 投影也不发布未提交投影，回滚后只返回已提交数据。

现有 `history-summary-projection.test.js` 的价格/FX/完整摘要对拍、`history-dashboard-sql.test.js` 及冷 perf 测试保留，交 Main 按受限测试槽串行复核。

## 已执行检查与 SHA-256

- `git diff --check -- src/usage-store.js test/perf-summary-parity.test.js test/perf-store.test.js`：退出码 0。
- `git --no-pager diff --no-index --numstat -- output/refresh-sync-latency-implementation/pre-e-usage-store.js src/usage-store.js`：退出码 1，表示存在预期 +3/-2 差异，不是检查失败。
- `Get-FileHash -Algorithm SHA256`、cwd/HEAD 读取：退出码 0。
- `src/usage-store.js`：`E2E7203D6CD223E8E52F62F8473824569149081DBF01E6160E6BEEB711F40CF7`。
- `test/perf-summary-parity.test.js`：`FDFD732C5F9C295874286C55416386F012F4D6BE6F2F4107C9E768FFA9165290`。
- `test/perf-store.test.js`：`39B89FE2DEB7D1CC1FB127628B752ACD651894F9257495096270235C3C139398`。
- 开始时测试 SHA-256 分别为 `67DDC0768082CF830430BF843CCEA4D5524CBACE814D42960110B063CA72DBF8`、`98EA5064C1EFF8767E26CE32C053554647529B0AC17C404B68E6830442F267B1`。

## 建议命令（全部待执行，仅 Main 持测试槽时）

小卡两条用例，Job 1024 MiB、heap 512 MiB、串行：

```powershell
pwsh -NoProfile -File scripts/run-with-memory-limit.ps1 -FilePath node -ArgumentsJson '["--max-old-space-size=512","--test","--test-concurrency=1","--test-name-pattern=E-1 all perf projection","test/perf-summary-parity.test.js","test/perf-store.test.js"]' -LimitMiB 1024 -TimeoutSeconds 180 -WorkingDirectory 'E:\12 AI\ccusage\codex-usage'
```

相关现有回归可由 Main 在同一测试树串行执行上述两文件全体，以及 `test/history-summary-projection.test.js`、`test/history-dashboard-sql.test.js`、`test/history-cold-perf-carrier-snapshot.test.js`、`test/history-cold-perf-authority.test.js`；最终门禁与 20 真实分钟周期由 Main 冻结源码后安排。

W1 无测试执行权，未启动 Node/npm/gates/bench/browser，没有提交/推送或改生产/旧证据。这里只完成静态实现和 diff 检查；没有 E 后运行结果或性能收益结论，不能沿用前 E/较早 D/P 短测作为 E 后数据。
