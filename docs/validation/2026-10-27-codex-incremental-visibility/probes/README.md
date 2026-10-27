# I1：读取及查询投影归因

本目录是可执行源；同名文件同步存放于本阶段 docs/validation 的 probes。旧 validation、旧 hook 和冻结来源均不写。本 agent 未运行 Node、npm、SQLite、浏览器或测试；以下命令只供 Main 在唯一执行槽调度。

首轮 `hook.mjs` 因物理前像 URL 绕过源码 loader 而仪器失败，原 hook 和两个 run 原样保留，见 [instrumentation-failures.md](instrumentation-failures.md)。同步前像控制使用 **hook-fixed.mjs** 和原 identity.json；Main 已完成 sync-fixed：unchanged 1681.984 ms、665157164 B / 10870 reads，helper/phase 成功归因。已有 identity 时不再执行 prepare。

冻结 after-code 的同步及查询短归因使用 **hook-workers.mjs**，新建独立身份并串行运行，完整命令见 [worker-hook.md](worker-hook.md)。Main 已以 identity-after.json 串行运行 i1-workers-after-sync/query，两轮 exit 0；catchup 的 2 个 worker、1,388 次完整 prefix、2,803,376,137 bytes 均通过消息/分桶总和断言。原 run 的 JSON、setup 和 stages 已保留，临时 SQLite 在 H1 结束后清理；不改 hook-fixed 或旧 identity。

## 输入与身份

从仓库根目录使用 PowerShell 7。先执行一次 prepare.ps1：默认固定本阶段 `output/codex-incremental-visibility-20261027/preimage`，复用 `.codex-usage/refresh-latency-20261026/freeze.json` 的隔离 mapping 和 seed。仅哈希冻结副本，不访问 mapping.original。identity.json 已存在时拒绝覆盖。

hook 在任何产品模块加载前校验 identity 内全部输入的 SHA-256/长度；模块从固定 codeRoot 读取，逐个比对摘要，不回退当前源码。结束后再校验冻结输入。摘要扫描在测量区间外，会预热文件缓存；本探针只用于暖态短测，不声称冷盘性能。切换代码版本时由 Main 用新的 IdentityFile 固定另一棵源码树，不覆盖本阶段 preimage。

所有写库仅用新 `probes/runs/<run>/usage-index.sqlite`；来源 SQLite 仅允许 readOnly 的冻结路径。未映射的文件访问会报错；不回退真实 home。每次保留一个隔离库供诊断，Main 按需要清理，不复制多套真实数据并行运行。

## 同步前像控制命令（既有 run 不重跑）

```powershell
# 只读已有冻结副本并写新的 identity；不启动 Node/SQLite。
pwsh -NoProfile -File ./output/codex-incremental-visibility-20261027/probes/prepare.ps1

# Main 先调度静态语法检查；仍使用现有 Job 包装器。
$i1ProbeRoot = './output/codex-incremental-visibility-20261027/probes'
$i1Node = (Get-Command node.exe -CommandType Application).Source
foreach ($i1Script in @('hook-fixed.mjs', 'short.mjs')) {
    $i1Args = @('--check', "$i1ProbeRoot/$i1Script") | ConvertTo-Json -Compress
    pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 -FilePath $i1Node -ArgumentsJson $i1Args -LimitMiB 1024 -TimeoutSeconds 60
    if ($LASTEXITCODE) { throw "Syntax check failed: $i1Script" }
}

# 一次读取归因：追赶 + 最多四轮 settle（排除）+ 一次静止正式样本。
$env:I1_RUN = 'i1-sync-fixed'
$i1Args = @('--max-old-space-size=1536', '--import', "$i1ProbeRoot/hook-fixed.mjs", "$i1ProbeRoot/short.mjs", 'sync') | ConvertTo-Json -Compress
pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 -FilePath $i1Node -ArgumentsJson $i1Args -LimitMiB 7168 -TimeoutSeconds 300

# 可选的独立短 query，串行调度；不是新分布/新大套。
$env:I1_RUN = 'i1-query-fixed'
$i1Args = @('--max-old-space-size=1536', '--import', "$i1ProbeRoot/hook-fixed.mjs", "$i1ProbeRoot/short.mjs", 'query') | ConvertTo-Json -Compress
pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 -FilePath $i1Node -ArgumentsJson $i1Args -LimitMiB 7168 -TimeoutSeconds 300
Remove-Item Env:I1_RUN
```

Main 的控制侧与整个 Job 继续共用 8 GiB；不能与其它 Node/npm/SQLite/browser 任务并跑。run 名已存在会拒绝覆盖。

## 输出及判读

- `results.json`：每个样本的前后 store/derived revision、data_version、total_changes、lastCommitReason、fingerprint、摘要哈希及耗时。catchup/settle 显式排除。
- `setup.json`：本次 hook 摘要、identity 摘要、实际加载模块 URL 及源码摘要。模块未被源码 loader 处理或 UsageStore 实例分叉时拒测；sync helper/phase 不激活时保存 instrumentation.valid=false 后失败。
- `stages.jsonl`：按 phase × helper × kind × 物理路径匿名 ID 分列 calls/readCalls/bytes/statCalls/statMs/ms；worker hook 另带 threadId，根 bytes/readCalls 合并各线程，localBytes/localReadCalls 只计主线程。字节和 readCalls 是互斥分桶，根结束用 assert 校验总和。helper ms 为包含子调用的时间，不能相加当净收益；只统计 fs.readSync，不是物理磁盘 I/O，也不包括 SQLite 内部读和异步 reader 字节。
- phase：rename、decision.metadata、decision.prescan、decision.file、window.before、window.after、window.publish、reader.before、reader.after；其它保留 unclassified，不硬归因。helper：enabledPerfSourceStat、perfContentFingerprint、prefix；真实 stat 操作单列。phases 另外记录判据/窗口调用次数；已有复用使某判据不读文件时，该处 readCalls=0，不代表判据没执行。
- `keys`：reader 实例 ID、key 每一分量的原值、相对上次 key/现存槽的变化字段、槽存在与 factsHit/fullHit。排除集含 NUL，不会截断为首个 home。reader ID 只在本进程内有效。
- query 只跑 all 首次/同上下文/now+1秒、no-op sync 后 all、month 两次；旧 after 报告只读取一次作背景参照，记录摘要身份，不能称为新配对 A/B。真实 revision 由其它增量场景通过同一个 trace 接口归因，本短驱动不合成真实来源变更。

同步 helper 和同步 store 方法保持普通同步函数，作用域断言禁止接收 Promise。加载器锚点必须唯一；源码调整导致锚点失配就终止，Main 对新冻结源码明确更新锚点，不能静默漏计。

本探针不实现缓存，不把同一个 phase 或相同指纹当作可复用 epoch 的证明；不改变 before/after/publish 独立取证、完整前缀 SHA、live-partial 或失败恢复。Q1 产品及摘要对拍测试已交回 Main，见 [Q1-handoff.md](Q1-handoff.md)；本次只交 worker probe。

worker hook 接入 usage-core 内 `workerData.task === 'codex-prefix-window'` 契约；子线程跳过重复全量输入校验和 store 导入，通过私有消息证据按线程合并 raw 读取。worker 消息缺失或重复会拒测。它仅支持直接 UsageStore 短探针；根 RSS/maxRSS 保留进程 API 口径，Job 峰值由 Main 外部包装器记录，不能相加线程 RSS。所有根 workersExpected=0 仅说明本次未走并行分支。
