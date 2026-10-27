# 本轮探针与复跑

仅供隔离复测，不连接或切换生产。全部使用 PowerShell 7；Main 唯一持有 Node/npm/SQLite/browser 运行槽，worker 只编写或审查。小检查 Job 1,024 MiB / heap≤768 MiB，真实库、全仓、浏览器整树 Job 7,168 MiB / heap≤1,536 MiB，控制侧留约 1 GiB，合计预算 8 GiB。

本目录的 Main 脚本是审查副本，相对路径按仓库根的 `output/codex-refresh-followup-20261027` 编写，执行前复制到该位置；I/O 的 `hook-workers.mjs` / `short.mjs` 对应其 `probes/` 子目录。`reader-*.mjs` 可直接从本目录运行。不要从 docs 中直接执行 Main 脚本。所有旧结果、身份和运行目录只读；复跑另设 stage / run 名并调整脚本常量，避免覆盖证据。写日志用原生内层 pwsh 重定向。

## 起点

本轮 preimage 为 §12 已验收版本：store SHA-256 `5a67983eed03d3224ba337980990d7392e64c7b1e154b5c14481fc0e3bbf1504`；after-code 为预扫移除版本：`ef1d21a1a55239662cc46a82aeadbc81bcb5d172b56c8dcf421dbba9b0128303`。两棵树均需保留 `src/`、`public/`、`package.json`。输入仍用 `.codex-usage/refresh-latency-20261026/freeze.json` 与原 seed；禁止重新冻结生产，禁止打开 `tools/out` SQLite。

`probes/identity-before.json` / `identity-after.json` 固定本轮源码和冻结输入哈希。实际读实例 hook 另外校验模块 URL、SQLite 物理路径和 worker preload；不能把不同版本源码静默路由成同一个模块。旧 `runtime-hook` 的 trace 功能不用于本轮读取归因，正式计时一律 `REFRESH_TRACE=0`。

## 入口

- `paired.mjs`：两个独立模块树、两份 DB，同进程 AB/BA 交替，静止/ledger 各 20 对；完整无详情摘要、来源指纹、累计计时输出对拍。它用于性能与 A/B 等价；不把相同输出量请求的累计计数当作逐 response 精确验证。
- `ledger-exact.mjs`：本轮最终产品，20 个不同输出量请求；21 次状态、420 个 turn 检查，保存实际 sample/evidence/link/lookup 行，独立核对五项 token 与 pooled TPS。`finalize-results.mjs` 另从请求参考计算并验证 TPS / duration 分位。
- `query-paired.mjs`：顺序查询出现整体漂移后增加的对照。today/month/all 各 20 个 AB/BA 暖查询对，每个范围先预热一次；完整摘要相等，并断言五个查询方法源码未变。
- `runtime-ab.mjs before|after`：独立单实例、静止同步及 today/month/all 暖查询各 20。baseline 设 `REFRESH_PRODUCT_BEFORE=1`；after 删除该变量。63 个摘要哈希、完整最终摘要、表计数及指纹在汇总时比较。顺序运行的绝对漂移与交错结果分别保留。
- `hook-workers.mjs` + `short.mjs sync`：直接 UsageStore 与前缀 worker 的 I/O 归因；支持新版本没有 prescan 的锚点，分区/阶段命中必须通过。设置 `I1_IDENTITY` 指向 before/after，`I1_RUN` 必须唯一。拒绝 executor worker，不能用它代替真实读链。
- `reader-hook.mjs` + `reader-executor.mjs 3`：本轮前像上的真实 executor，15 次 dashboard、3 次同步中 published reader 覆盖。详见 [reader-handoff.md](reader-handoff.md)。源码符号没有 getSummary，记录实际 dashboard/summary 方法。
- `reader-ledger-hook.mjs` + `reader-ledger-executor.mjs`：真实 executor 的单条匹配 ledger。`READER_LEDGER_IDENTITY` 指向 after 身份，`READER_LEDGER_CODE_ROOT` 指向 after-code，`READER_LEDGER_RUN=reader-ledger-<unique>`。只写 runDirectory 内 ledger overlay，冻结来源只读；找不到唯一原生匹配时报告 notMeasured。受控 duration 用于验证发布，不是该原生请求的生产耗时。
- `runtime-retained.mjs`：六条缺源的 events/samples/owners/dependencies 原始行，三轮同步前后严格对拍。
- `runtime-controls.mjs --probe-smoke --browser-only`：Claude、新文件、追加、ledger 四个真实浏览器控制与双 tab；使用既有 60 s 检查回调手动触发，保留文本与双 rAF 目标帧。不是 60 s 周期分布，不能据此给 p95 或新鲜度认证。
- `state-before-loader.mjs`：仅替换源码、不映射文件系统，运行新状态测试的 before 反例。通用冻结来源映射会干扰测试夹具的 Sandbox Temp 路径，首个这种尝试已排除。
- `gates.mjs`：未来完整复跑的串行类型/lint/格式/全仓控制器，整 Job 上限不变，child 时间上限已改为 1,800 s，外层使用 2,100 s。实际首轮为 [gates-v1.mjs](../evidence/gates-v1.mjs)，其 900 s 时间上限导致超时；随后 `gates-tail.mjs` 从已知文件边界补齐，清单与日志单列。不把该续跑脚本当成新源码的全量入口。
- `gates-post.mjs`：测试下界修正后的最终 lint / format:check，Job 1,024 MiB / heap 512 MiB；不改写首轮门禁。
- `runtime-verify-inputs.mjs`：1 MiB buffer 流式校验 1,633 个输入与 98 个产品文件（36 src / 62 public），写入本轮 inputs-final。
- `cleanup.ps1`：仅清理本轮登记且已经关闭的五份测量 DB 及其 sidecar；复跑需调整为新 run 的明确路径，不扫描删除旧证据或 seed。
- `finalize-results.mjs`：离线校验配对、逐 turn 参考、查询对照、门禁覆盖及续跑测试源码、浏览器请求、清理和最终输入证据；Job 1,024 MiB / heap 512 MiB。

真实 reader 的 fs 路径/模块诊断会增加同步成本；方法包含时间用于归因，不和父调用相加。不同连接的 data_version / total_changes 数值不能直接比较。Node RSS 为进程口径，整 Job 峰值未采集；Job 硬限不等于实测峰值。

## 源写入探针的外层恢复

`paired.mjs`、`ledger-exact.mjs` 和浏览器控制均必须用外层 finally；JS finally 不能覆盖 Job 超时或内存中止。下面以逐请求检查为例，日志名和 stage 已存在时先另设本轮目录，不覆盖原结果。

```powershell
$env:REFRESH_TRACE = '0'
Remove-Item Env:REFRESH_PRODUCT_BEFORE -ErrorAction SilentlyContinue
$probeExit = 1
try {
    pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 `
        -FilePath 'C:\Program Files\nodejs\node.exe' `
        -ArgumentsJson '["--max-old-space-size=1536","--import","./output/codex-refresh-followup-20261027/runtime-hook.mjs","./output/codex-refresh-followup-20261027/ledger-exact.mjs"]' `
        -LimitMiB 7168 -TimeoutSeconds 900 `
        *> ./output/codex-refresh-followup-20261027/evidence/ledger-exact-rerun.txt
    $probeExit = $LASTEXITCODE
} finally {
    pwsh -NoProfile -File ./output/refresh-sync-latency-implementation/restore-inputs.ps1
}
pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 `
    -FilePath 'C:\Program Files\nodejs\node.exe' `
    -ArgumentsJson '["--max-old-space-size=512","output/refresh-sync-latency-implementation/check-inputs.mjs"]' `
    -LimitMiB 1024 -TimeoutSeconds 60
if ($LASTEXITCODE) { throw 'Frozen inputs differ after restoration' }
if ($probeExit) { throw "Probe failed: $probeExit" }
```

恢复器使用 raw JSON decimal→100ns，不能改成 Date utimes 或先经过 Double 的近似恢复。每场失败/超时后先恢复并检查，再交下一场运行槽。停止进程和清理仅针对本轮登记的 DB/文件；旧阶段 seed、来源、证据和用户工作树保留。
