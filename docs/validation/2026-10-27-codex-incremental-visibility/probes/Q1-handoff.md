# Q1：已有 timeline 分组融合，交回 Main

产品只改 src/usage-store.js：将原 all 投影资格中的完整 SQL 读/非 quota/非写事务条件提为 groupingEligible，使 month/today/week/custom 等原本就遍历 timeline 的查询用 createFusedSummaryGroups 同轮收集分组。all 静态投影仍只允许 all；不增加 month 响应缓存，不改变 key、now、revision 或 total_changes。

冷数据门槛保留：存在 event/perf authority 而 verifiedHistorySqlRead 未激活时，groupingEligible=false，维持 SQL 回退/完整 carrier 路径。repository 与 metadata observation 两个收集器另加 projectionCacheable，保留原先仅 all 的范围，不借此扩大非 all 行为。原 helper 的 ties => null => groupedRange SQL 顺序完全保留。

新增 test/codex-incremental-query-projection.test.js，共三项小夹具测试：

1. month/today/week/custom/all、UTC/local、排除集（含重复）、details 开关、价目/FX/模型映射及新 revision 的完整 summary 与写事务门下原 SQL 分组参考逐字段一致。
2. 相等 totals 及 Unicode 项目名仍按维度回退 SQL；未并列维度保持融合。
3. 创建并注册真实冷 archive、设置 authority 并移走热事件：未激活 verified SQL 的直接读保持两次分组 SQL；cold-aware month 保留完整 carrier，完整紧凑摘要与封存前对拍。

未启动 Node/npm/SQLite/browser、测试或格式器。仅作源码/调用点静态核对；Main 已接受的 sync-fixed 归因不因这次 Q1 改动变成新 after 结果。src/usage-store.js 写权交回 Main，此后本卡不再修改。

Main 唯一槽待执行（仓库根，PowerShell 7）：

```powershell
$q1Node = (Get-Command node.exe -CommandType Application).Source
$q1Args = @('--max-old-space-size=768', '--test', '--test-concurrency=1', 'test/codex-incremental-query-projection.test.js', 'test/history-summary-fused-groups.test.js', 'test/history-summary-projection.test.js') | ConvertTo-Json -Compress
pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 -FilePath $q1Node -ArgumentsJson $q1Args -LimitMiB 1024 -TimeoutSeconds 180
```

固定 8 GiB 总预算及 Main 原定 after/最终门禁/40 周期安排不变。I2 按外写交错反例不实施；worker hook 适配后排，不用尚未适配的 hook 对新 worker 候选报读取为零。
