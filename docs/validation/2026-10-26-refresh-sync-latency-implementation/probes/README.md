# 复跑本轮探针

从仓库根目录、PowerShell 7 执行。本目录保存受测脚本的审查副本；模块相对路径按 `output/refresh-sync-latency-implementation/` 布局编写，**先复制回该目录再运行**，不要直接在本目录执行。原私有冻结来源、价目与 seed 不随文档复制；必须保留 `.codex-usage/refresh-latency-20261026/freeze.json` 及其副本。严禁重新运行 freeze 来替换受测输入。

```powershell
$refreshWork = 'output/refresh-sync-latency-implementation'
New-Item -ItemType Directory -Path $refreshWork -Force | Out-Null
Get-ChildItem -LiteralPath 'docs/validation/2026-10-26-refresh-sync-latency-implementation/probes' -File |
  Where-Object Extension -in '.mjs','.ps1' |
  Copy-Item -Destination $refreshWork
```

只允许一个本地测试槽。下列重型命令串行，Job 固定 7,168 MiB、Node heap 1,536 MiB；保留约 1 GiB 控制余量。完整浏览器包含 Chromium 子进程，须放在同一 Job。需要临时 rename/junction 或 Chromium 启动的权限时，保持上述额度，不提高内存。before 另需开工前像目录 `output/refresh-sync-latency-implementation/preimage`，只替换本轮目标文件且保留原 module URL。

受限运行示例，mode 改为 before/after；before 设置 `REFRESH_PRODUCT_BEFORE=1`，after 移除。再次运行会覆写同名结果，先保留原证据，不将新跑数据混入历史样本。

```powershell
$env:REFRESH_TRACE_FILE = 'after-stages.jsonl'
& pwsh -NoProfile -File scripts/run-with-memory-limit.ps1 `
  -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentsJson '["--max-old-space-size=1536","--import","./output/refresh-sync-latency-implementation/hook.mjs","./output/refresh-sync-latency-implementation/ab.mjs","after"]' `
  -LimitMiB 7168 -TimeoutSeconds 600 -WorkingDirectory (Get-Location).Path *> "$refreshWork/after-run.txt"
$refreshExit = $LASTEXITCODE
```

- `ab.mjs before/after`：每次独立复制 seed，固定 now，追赶并稳定后做 20 次静止同步与三档各 first+20 warm。完整摘要仅存私有目录，输出保留原始哈希。`compare.mjs` 对拍全部 63 个摘要哈希、表计数、来源指纹并计算 nearest-rank；仅去掉三项预声明时间字段。
- `changed.mjs`：新线程预热后，Codex 追加、ledger-only、Claude 追加各 20 次，逐次断言精确 token/计时增量，timeout 900 秒。
- `http-browser.mjs --probe-smoke --browser-only`：四场景人工触发，先验证探针，不计真实周期。默认不带参数运行包含 HTTP、21 个真实 60 秒周期、最后双标签页，timeout 2,100 秒；`REFRESH_RESULT_FILE=browser-final-results.json`、`REFRESH_TRACE_FILE=browser-final-stages.jsonl`。变化轮必须实际目标帧与非空时序，G1 从真实 tick 起算；浏览器 errors 必须空。最多两个标签页。
- `quota-branch.mjs`：受控 quota metadata 纠正；先 `REFRESH_PRODUCT_BEFORE=1`，要求重现提前结束 busy，再取消该变量跑 after，要求提前结束次数为零。每次设 `REFRESH_QUOTA_RESULT_FILE=quota-before-results.json` / `quota-after-results.json`，timeout 300 秒。before/after 同日、相同初始范围；这是合成分支，不能外推自然发生频率。
- `summarize.mjs`：全部场景完成后检验计数/错误/非空时序，生成 summary.json；每个浏览器子组不足 20 个，不把其描述性 p95 写成逐场景正式通过。
- `preimage-test-hook.mjs`：只用于旧版 P 反例，旧源码理应在稳定缺源规划断言失败，预期 exit 1；不是通过证据。

三个写来源场景结束后，**不论测试退出码、超时或内存触限，都先恢复再校验，然后才能开始下一场**。内部 Date utimes 只具毫秒精度，不能代替独立恢复。这里只操作私有副本；合成 rollout 的前缀限定为本探针所有。

```powershell
& './output/refresh-sync-latency-implementation/restore-inputs.ps1'
& './scripts/run-with-memory-limit.ps1' -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentsJson '["--max-old-space-size=512","output/refresh-sync-latency-implementation/check-inputs.mjs"]' `
  -LimitMiB 1024 -TimeoutSeconds 60 -WorkingDirectory (Get-Location).Path
if ($LASTEXITCODE -ne 0) { throw 'Input restoration differs' }
if ($refreshExit -ne 0) { throw "Probe failed: $refreshExit" }
```

stdout 持久捕获采用原生内层 pwsh，再对它重定向；不要在当前 shell 直接点调用限制器后以空日志判断执行成功。成功而无 stdout 的 tsc 以持久退出码证明执行。

trace 可用 `REFRESH_TRACE=0` 关闭计数，隔离映射仍保留。不同阶段存在包含关系，不将它们相加当端到端延迟。资源 JSON 的 RSS 是 Node 口径，整树硬限来自 Job，未测得 Job 峰值时不冒称浏览器整树峰值。
