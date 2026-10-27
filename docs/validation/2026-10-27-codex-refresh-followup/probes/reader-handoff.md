# W2 reader：交还 Main，待唯一槽运行

只新增本目录 `reader-hook.mjs`、`reader-executor.mjs` 和本文；未启动 Node/npm/SQLite/browser、语法检查或测试。Main 当前 formal before 基线结束后再执行。W2 到此归还全部 reader 文件写权。

## Main 准确命令

固定 cwd `E:/12 AI/ccusage/codex-usage`，PowerShell 7。默认 3 轮；同一进程只有真实 executor 和产品按需创建的 prefix worker。Job 7168 MiB，控制侧预留约 1 GiB，合计 8 GiB；不与 formal 基线、其它验证并行。

```powershell
Set-Location -LiteralPath 'E:/12 AI/ccusage/codex-usage'
$readerProbe = './docs/validation/2026-10-27-codex-refresh-followup/probes'
$readerNode = 'C:\Program Files\nodejs\node.exe'
foreach ($readerScript in @('reader-hook.mjs', 'reader-executor.mjs')) {
    $readerCheckArgs = @('--check', "$readerProbe/$readerScript") | ConvertTo-Json -Compress
    pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 -FilePath $readerNode -ArgumentsJson $readerCheckArgs -LimitMiB 1024 -TimeoutSeconds 60 -WorkingDirectory 'E:/12 AI/ccusage/codex-usage'
    if ($LASTEXITCODE) { throw "Reader syntax check failed: $readerScript" }
}
if ($env:NODE_OPTIONS) { throw 'Reader probe requires empty NODE_OPTIONS and its own --import only' }
$readerPreviousRun = $env:READER_RUN
$env:READER_RUN = 'reader-before-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
try {
    $readerArgs = @('--max-old-space-size=1536', '--import', "$readerProbe/reader-hook.mjs", "$readerProbe/reader-executor.mjs", '3') | ConvertTo-Json -Compress
    pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 -FilePath $readerNode -ArgumentsJson $readerArgs -LimitMiB 7168 -TimeoutSeconds 900 -WorkingDirectory 'E:/12 AI/ccusage/codex-usage'
    if ($LASTEXITCODE) { throw 'Reader probe failed; retain the private run and raw events' }
} finally {
    if ($null -eq $readerPreviousRun) { Remove-Item Env:READER_RUN -ErrorAction SilentlyContinue }
    else { $env:READER_RUN = $readerPreviousRun }
}
```

环境仅需唯一的新 `READER_RUN=reader-*`；其余不设。hook 固定读取 Main 本轮 `output/codex-refresh-followup-20261027/probes/identity-before.json`，复用其中输入列表和 `.codex-usage/refresh-latency-20261026/seed.sqlite`。该 identity 必须指向本轮 preimage；`identity-after.json` 当前指向活动工作树，故本探针不把它误当私有源码副本。每次新建 `output/codex-refresh-followup-20261027/reader-*/`，复制 seed 一次，保留 SQLite 和结果供诊断，不覆写原身份、不重冻结、不改来源。

## 顺序与读数

catchup + 最多四次 settle 属准备，不计测量轮；需连续两次 `updatedFileCount=0` 才开始。每轮依次：all dashboard → 同上下文 dashboard → 连续发送真实 sync/dashboard 两条消息 → sync 完成后 dashboard → no-op sync → dashboard。固定 now `2026-10-26T15:00:00.000Z`、local、day、无详情。五个 dashboard 的规范摘要逐条对拍，只移除 generatedAt/perf indexedAt 两类例行时刻。没有 ledger 写入、source 修改或人造修订。

`results.json` 有主线程 dashboard 往返成本、worker handler 成本、方法包含时间、读实例切换、key 跨请求差异和 `concurrentCoverage`。`events-<threadId>.jsonl` 分线程留原始证据：

- `preload-ready/module-loaded/sqlite-open`：真实 executor/prefix worker、物理模块 URL、源码 SHA-256、数据库物理路径。每个被加载模块与本轮 before identity 比对，worker 校验同一 hook/setup/input identity；没有产品预导入。主线程禁止打开 SQLite。
- `reader-opened/reader-published/dashboard-reader/reader-release/reader-closed`：实例 ID 为 `threadId:serial`；同时给出 writer/published 的选择、事务深度、实例修订及缓存单槽/行数、quoteRows/quoteEstimatedBytes、periodComparison 条目数。quoteEstimatedBytes 是现有容器预算计数，不是整个缓存的精确堆占用。
- `state-posted`：实际 state 消息发送后递增 `stateSerial`，保留原 status、perfIndexVersion、perfTimingRevision、fingerprint、checkedAt 等。`publishedSerial` 是临时 WAL reader 发布次数；它们都不是持久数据版本，真实业务版本看原字段和 storeRevision/derivedRevision。
- `projection-keys`：12 个实际 key 分量保留完整值；按第一个 NUL 分割，排除集合后续 NUL 不丢。记录 key 构建耗时、slotPresent、factsHit/fullHit、同实例前一次/现存槽的差异。`results.json` 另列跨请求 reader 切换和分量差异。
- `request-complete`：sync/dashboard 原 handler 内方法成本，`summarizeInReadTransaction/Core` 对应摘要计算；也记录 timeline/grouped/perf/costEvents 等包含时间，不能相加当净收益。costEvents 是 generator，计时覆盖真正遍历至结束，也含 yield 间消费者耗时，不等于纯 SQL 成本。源码没有 `getSummary` 符号，未伪造该函数计时；外层 dashboard 往返包含序列化、排队及诊断开销。

并发消息不插入 barrier，不延长 sync、不循环追赶。若 `-during-sync` 最终选择 writer，`concurrentCoverage.publishedReader` 如实为零，不宣称命中过临时 reader。模块和数据库守卫及摘要对拍通过前不接受性能结果；存在失败时保留原始结果。结束校验同一冻结输入列表的大小和 SHA-256。该热 seed 探针明确拒绝 SQLite ATTACH；没有实际冷段覆盖。

## 静态证据与最小候选

before 的 executor/store/core SHA-256 分别为 `415ffc1539b012df740652539b9542a83baff1e68f0305c0e4d92e068e17291e`、`5a67983eed03d3224ba337980990d7392e64c7b1e154b5c14481fc0e3bbf1504`、`18f8d3fd7339bc0395140e263a772bc46c2cfc3e8e6bff644f36006e5b233dcc`。8 个 executor 注入锚点经 pwsh 字符串计数均唯一；尚未经 JS 解析器验证。

1. preimage `src/usage-executor.js:426` 每次已有 status 的 sync 都 `new UsageStore({databaseFile})`，open 后 BEGIN + SELECT 固定旧视图，复制 homes/warnings/evidence；finally `releasePublishedReader()` 回滚并关闭。dashboard 在 `:475` 选择 publishedStore 或长期 store。因此临时 reader 的实例内 summaryProjectionCache 每轮从空开始，不能凭长期 writer 暖命中推断同步中读取也暖。最小研究候选是只在已验证同一发布上下文时把静态投影交给临时 reader；不延长读事务。依赖发布前修订对齐、范围/排除/详情/价格/证据一致、quoteInputs 生命周期独立、失败/回滚/WAL 释放不变。不同连接的 total_changes/data_version 不能直接比较数值或拷 key。是否值得实施等真实选择与成本样本。

2. preimage `src/usage-store.js:11174` 的 factsKey 含 storeRevision、derivedRevision、total_changes、data_version、pricing model keys、service-tier evidence、resolved range、bucket、排除集合及详情；完整 key 再加 catalog version/rate。`:9468` 附近每轮发布事务都调用 `writeMeta`，`:4991` 是无条件 UPSERT；例行元数据不推进业务修订，但会增加本连接 total_changes。最小候选是先定位并消除确实重复的元数据写入；若改 key，必须先证明所有影响投影的写入都推进专门发布修订，并保留外部提交、失败/回滚、原始 SQL 写入、价格、service-tier 与冷权限反例。不能只删 total_changes 或 data_version 换命中。

3. 投影命中仍会执行动态 aggregate/quota/metadata/periodComparison；all 热命中仅覆盖已缓存的静态部分。ledger-only 也可能只改变 perf 而失效整槽，但本探针没有写源、没有合成该场景；usage/perf 拆分的收益、完整依赖和正确性均未知，暂不建议产品改动。

尚未得到真实成本、命中率、no-op 实际 key 差异或发布 reader 并发覆盖；本次仅交可执行仪器和静态候选。

ledger-only 后续独立扩展：仅复制冻结 ledger 到新 runDirectory，并将 logical ledger 单路径映射到 overlay；冻结 ledger 和其它来源保持只读。至少一组真实 executor 的 before/after keys、cost、用量不变和 timing 变化归因。先从已有 native 确认未匹配 response_id；找不到可确定匹配时明确不测，不冒充已覆盖。当前交付没有启用 overlay 或追加 fixture。
