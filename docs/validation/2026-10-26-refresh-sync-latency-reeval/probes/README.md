# 本次诊断脚本与复跑

这是本机固定快照的诊断工具，不是产品代码、通用性能框架或生产迁移入口。脚本逐步加入观测字段，本目录保存最终版及其 SHA-256；正式样本保留原阶段字段，不把新增计数补写成历史测量。

原执行目录是仓库根下 `output/refresh-sync-latency-reeval-20261026/`，`.mjs` 的 `../../src` 导入依赖该层级。复跑时先把本目录脚本复制回这个目录，从仓库根执行。保留的固定输入与 seed 在 `.codex-usage/refresh-latency-20261026/`，包含真实私人数据，不提交该目录。

本机依赖是 Node `C:\Program Files\nodejs\node.exe`，Playwright Core 来自本机 bundled runtime，Chromium 来自已安装 `chromium-1248`；路径在浏览器脚本中显式记录，换机器须相应调整。未新增 npm 依赖。

## 固定输入复跑

PowerShell 必须使用 `pwsh`。同一时间只运行一棵测量树，控制侧约留 1 GiB；沿用仓库 Job Object 限制，不能只设置 Node heap。

```powershell
$env:REFRESH_TRACE = '1'
$env:REFRESH_TRACE_FILE = 'repeat-stages.jsonl'
& './scripts/run-with-memory-limit.ps1' `
  -FilePath 'C:\Program Files\nodejs\node.exe' `
  -ArgumentsJson '["--max-old-space-size=1536","--import","./output/refresh-sync-latency-reeval-20261026/hook.mjs","output/refresh-sync-latency-reeval-20261026/direct.mjs","repeat"]' `
  -LimitMiB 7168 -TimeoutSeconds 600 `
  -WorkingDirectory (Get-Location).Path
```

`direct.mjs` 每次从 seed 复制独立可写库，先追赶，再验证两轮 updatedFileCount=0，最后测 20 次静止 sync 和每档 20 次查询。首次查询与后续暖查询分列。`control-on`/`control-off` 模式各只测 3 次；关闭计数用 `REFRESH_TRACE=0`，来源重定向仍保持。`check-controls.mjs` 在相同 now 下比较二者完整结果，仅排除三个具名发布墙钟字段。

浏览器使用同样的 Job 参数运行 `http-browser.mjs --browser-only --ten-cycles`，另设置唯一的 `REFRESH_RESULT_FILE` 和 `REFRESH_TRACE_FILE`，超时至少 900 秒。它测真实 60 秒定时器，追加只写隔离来源，精确核对 token 增量；价目刷新端点被固定为无变化，所有配置写入目标都在私有目录。成功结束会还原追加内容；强制中止后先确认整个 Job 已退出，再运行 `restore-inputs.ps1` 恢复自己的副本。时间戳还原后可能需要重新追赶，预热不作为正式零变化样本。

`quota-branch.mjs` 是单次受控 metadata 转换，第一 quota 响应中去掉可选来源，其余业务数据和纠正后的第二请求来自本地真实服务；不要把它称为自然生产复现。它额外检查可见输出 textContent 变化。

## 建立新输入

`prepare.mjs --freeze`、`repair-snapshot.mjs` 和 `preserve-file-times.ps1` 记录本次准备方法。SQLite 使用只读在线 backup，普通文件按初始长度流式复制，时间戳使用 Windows 精度；ZCode 再核对非空表结构与行数，不能只依赖空库也会通过的 quick_check。

**不要对现有冻结目录重新运行 prepare --freeze 当作新快照。** 它会复用已有来源文件；新的独立基线应先在脚本中指定全新的隔离/输出目录，并更新所有脚本对应常量。只复跑本次输入时，无需重新访问生产来源或重新 backup。

## 留存与自检

- `inspect-baseline.mjs`：缺源保留的来源/事件/性能计数和正式基线摘要。
- `summarize.mjs`：nearest-rank 统计，浏览器两组内分别算间隔，不把组间重启间隔混入周期。
- `finalize-evidence.mjs`：断言两组各 10 周期、12 个精确 token 增量、每次 output 增量、18 个真实约 60 秒间隔、插桩结果对拍以及 58 个产品文件零漂移，复制脱敏证据并记录 seed/脚本摘要。

本次已结束全部测量进程。可写工作库只用于本次运行；证据复制完成后清理这些副本，保留来源快照和 seed 供复跑。源码身份以 `evidence/baseline.json` / `evidence/integrity.json` 为准，未修改 `src`、`public`、产品测试或限制器脚本。
