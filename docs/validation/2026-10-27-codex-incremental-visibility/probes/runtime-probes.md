# Main 端到端探针复跑说明

本目录 runtime-*.mjs 是审查副本。相对模块路径按仓库根的 output/codex-incremental-visibility-20261027 编写，执行前复制回该目录；不要直接在 docs 中执行。保留本阶段 preimage、after-code 和原私有 freeze/seed，不重新冻结生产。不覆盖已验收结果：复跑前另存输出，或为运行另建同结构目录并调整脚本中的输出常量。

全部使用 PowerShell 7。唯一执行槽，整棵 Node/Chromium/worker 树 Job 7,168 MiB、Node heap 1,536 MiB，控制侧预留约 1 GiB；小型检查 Job 1,024 MiB。任何主进程 exit、超时或触及内存上限后，都从外层 finally 恢复输入并在下一场之前核对。

## 入口与职责

- runtime-hook.mjs：逻辑来源映射到原冻结副本；REFRESH_PRODUCT_BEFORE=1 时从本阶段 preimage 读取产品源码，REFRESH_TRACE=0 关闭旧细分仪器。正式端到端计时使用 trace=0，不能拿它的旧 otherRead/prefix 标签描述新 worker 的字节量；读取计数使用独立 hook-workers。
- runtime-ab.mjs before/after：各自复制 seed、追赶/settle 排除、20 次静止同步与 today/month/all 各 first+20 warm。完整业务摘要写本阶段 output；runtime-compare.mjs 对拍全部 63 个摘要哈希、计数和来源指纹，仅移除预声明三项时间字段。
- runtime-changed.mjs：Codex 单 turn 追加、ledger-only、Claude 追加各 20；逐次断言精确 token/TPS 增量，before/after 结果分文件保存。原始输入恢复必须由外层完成。
- runtime-retained.mjs：六条缺源的 events/samples/owners/dependencies 原始行哈希，三轮同步前后严格相等。
- runtime-http-browser.mjs --probe-smoke --browser-only：四个人工触发控制，不计正式周期。无参数为 HTTP 控制加 40 个真实 60 s 周期，Codex 追加与 ledger-only 交替各 20；最后双 tab。
- runtime-controls.mjs --probe-smoke --browser-only：Claude、新文件、普通追加、ledger 的独立人工控制，不混入上述两类 20 样本。
- runtime-summary.mjs：在长测、控制与恢复结束后逐项断言计数/目标帧/独立 TPS 参考及输入核对，输出公开聚合 summary.json；不以性能目标未达删除原始样本。
- runtime-verify-inputs.mjs：复用一个 1 MiB buffer，核对 identity-after 的 1,633 个输入 SHA 和 57 个产品模块，仅用 1,024 MiB Job 即可。

浏览器每次 native 追加两个独立 turn，一个使用在测量前已到达的计时，另一个保持缺计时，随后 ledger-only 补齐。native tokens 精确 +2,000,214、两种场景各新增一条匹配计时。独立受控 duration 数组计算 n、pooled average TPS、nearest-rank p10/p90；浏览器载荷逐值对拍，目标帧还要满足 TPS 文本跨阈值和精确 sampledOutputTokens。首帧与双 rAF 重读分开记录；ledger 的 tokens 本来不变，不把它当新 token 延迟。

保留 interval 实际 tick/安装时刻、请求/响应、DOM/双 rAF 帧、写入相位及 busy。新鲜度按当轮实际 interval+5 s，初轮用定时器安装时刻作前一边界；不通过加大轮询间隔达标。资源 RSS 是 Node 进程 API 口径，整树只报告 Job 硬限与是否触限，不把 Node/线程 RSS 冒称整树峰值。

## 正式浏览器外层命令

下面保留实际换行与字面 JSON；输出名已存在时先另存，不覆盖旧证据。Chromium/归档硬链接需要正常文件权限时保持相同 Job 限额运行。

```powershell
Remove-Item Env:REFRESH_PRODUCT_BEFORE -ErrorAction SilentlyContinue
$env:REFRESH_TRACE = '0'
$env:REFRESH_RESULT_FILE = 'browser-final-results.json'
$probeExit = 1
try {
    pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 `
        -FilePath 'C:\Program Files\nodejs\node.exe' `
        -ArgumentsJson '["--max-old-space-size=1536","--import","./output/codex-incremental-visibility-20261027/runtime-hook.mjs","./output/codex-incremental-visibility-20261027/runtime-http-browser.mjs"]' `
        -LimitMiB 7168 -TimeoutSeconds 3000 `
        *> ./output/codex-incremental-visibility-20261027/browser-rerun.txt
    $probeExit = $LASTEXITCODE
} finally {
    pwsh -NoProfile -File ./output/refresh-sync-latency-implementation/restore-inputs.ps1
}
pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 `
    -FilePath 'C:\Program Files\nodejs\node.exe' `
    -ArgumentsJson '["--max-old-space-size=512","output/refresh-sync-latency-implementation/check-inputs.mjs"]' `
    -LimitMiB 1024 -TimeoutSeconds 60
if ($LASTEXITCODE) { throw 'Frozen inputs differ after restoration' }
if ($probeExit) { throw "Browser probe failed: $probeExit" }
```

恢复器使用 raw JSON decimal→100ns，不能改用 Date utimes 或先解析成 Double；来源只在私有副本内恢复。长测 stdout 由内层原生 pwsh 重定向，不能用空日志推定执行成功。
