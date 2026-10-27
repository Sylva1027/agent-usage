# I1 prefix worker 适配：待 Main 唯一槽运行

文件：hook-workers.mjs。独立于已验收的 hook-fixed.mjs，后者、旧 identity、旧 run 均不改。产品 core/store/test 不修改。

## 最小接线

识别 `workerData.task === 'codex-prefix-window'`：子线程跳过全量 verifyInputs、mkdir、setup、UsageStore 动态导入及原型包装。它只读父进程固定的 identity/manifest，检查父进程传下的 identity/hook 摘要，安装相同冻结路径映射、canonical loader 和同步 helper 插桩；模块逐个核对固定源码摘要。

仅在 loader 内变换源码：worker 顶层的 postMessage 调用用独立同步 AsyncLocalStorage context 取得原 perfHomeContentFingerprint 的结果，在消息副本附带 `__i1ReadEvidence`。父线程原 message 回调合并并去掉这个私有字段，再交给原结果变量。磁盘产品源码和产品正常消息均不增加诊断字段，workerData/resourceLimits/execArgv 保持产品原契约。

父线程规划本来就是 async，只有这个函数外加 async window 作用域；原 perfContentFingerprint、prefix、fs.readSync 和同步 store 方法都保持同步。旧同步前像也能用同一个 hook 控制对照。

## 计数与失败检查

- reads 每行带 threadId；根 bytes/readCalls 包含本线程和已合并 worker 的互斥读取。localBytes/localReadCalls 仅当前主线程；workers 列表保留每个子线程的字节、次数、phases、ms 和 isolate heap 摘要。helper 及逐文件分桶只在根 reads，不在 workers 内重复保存。
- 原 worker 创建点递增 workersExpected。消息缺少证据、重复线程、identity/hook 不一致或根完成时消息数不符，均拒绝样本；不能漏记 worker 后退出 0。
- 每个 worker 的分桶总 bytes/readCalls 与原始计数一致；每个文件必须经过原 fingerprint helper，complete 窗口还要求每个文件确实经过 prefix helper。文件不可读导致 complete=false 时不伪造 prefix 成功。
- 主线程再核对 local + workers = root，并核对全部根分桶 = root。worker 计算/读取 ms 是包含时间，重叠的两线程与 helper 时间不能相加当墙钟；根 ms 自己记录。
- worker heapUsed/heapTotal 是线程 isolate 快照。根 RSS/maxRSS 继续按进程 API 含义记录，不把各 worker 的进程 RSS 相加，不声称测到了整棵 Job 峰值。
- 此 hook 仅用于直接 UsageStore 短探针及其 prefix workers；其它 executor/browser worker 入口明确拒测。40 周期沿 Main 自己的真实浏览器测量链运行。

## Main 待执行

固定 Main 已复制的 `output/codex-incremental-visibility-20261027/after-code`，不读取当前产品树。文本检查确认该树全部 16 个源码插桩锚点均唯一；core/store SHA-256 分别为 `18f8d3fd7339bc0395140e263a772bc46c2cfc3e8e6bff644f36006e5b233dcc` / `5a67983eed03d3224ba337980990d7392e64c7b1e154b5c14481fc0e3bbf1504`。创建新的 identity，不覆盖同步前像身份；准备和输入摘要扫描都在计时区间外。

```powershell
$i1ProbeRoot = './output/codex-incremental-visibility-20261027/probes'
$i1CodeRoot = './output/codex-incremental-visibility-20261027/after-code'
$i1Node = (Get-Command node.exe -CommandType Application).Source
pwsh -NoProfile -File "$i1ProbeRoot/prepare.ps1" -CodeRoot $i1CodeRoot -IdentityFile "$i1ProbeRoot/identity-workers-after.json"
if ($LASTEXITCODE) { throw 'Worker identity preparation failed' }

foreach ($i1Script in @('hook-workers.mjs', 'short.mjs')) {
    $i1Args = @('--check', "$i1ProbeRoot/$i1Script") | ConvertTo-Json -Compress
    pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 -FilePath $i1Node -ArgumentsJson $i1Args -LimitMiB 1024 -TimeoutSeconds 60
    if ($LASTEXITCODE) { throw "Syntax check failed: $i1Script" }
}

$env:I1_IDENTITY = "$i1ProbeRoot/identity-workers-after.json"
try {
    # 只在 Main 唯一槽依次运行；每个 mode 使用自己的新 run 目录。
    foreach ($i1Mode in @('sync', 'query')) {
        $env:I1_RUN = "i1-workers-after-$i1Mode"
        $i1Args = @('--max-old-space-size=1536', '--import', "$i1ProbeRoot/hook-workers.mjs", "$i1ProbeRoot/short.mjs", $i1Mode) | ConvertTo-Json -Compress
        pwsh -NoProfile -File ./scripts/run-with-memory-limit.ps1 -FilePath $i1Node -ArgumentsJson $i1Args -LimitMiB 7168 -TimeoutSeconds 300
        if ($LASTEXITCODE) { throw "Worker probe failed: $i1Mode" }
    }
} finally {
    Remove-Item Env:I1_IDENTITY, Env:I1_RUN -ErrorAction SilentlyContinue
}
```

沿用短驱动：每个 mode 各自复制一份 seed，catchup/settle 排除。sync 最后一次 unchanged；query 测 all 首次/同上下文/now+1秒/no-op 后及 month 两次，记录 reader、keys 分量差异和同步方法次数/耗时。查询 key miss 本身不能代称一次全文重读，须联看 methods、reads、bytes；本驱动不合成真实 revision 变更。单个 Node Job 限 7168 MiB，与 Main 控制侧合计维持 8 GiB，勿与全仓门禁或其它执行并跑。

worker 首尾/SHA 归因主要看 catchup 中 workersExpected、workers 和 window.before 的 prefix 行。若所有根 workersExpected=0，说明本次未进入 worker 分支，不能声称测过并行读取。输入校验、源码 loader 读及 worker 初始化读均不在被测根计数中；后续 before/after/publish 仍各自取证，没有跨窗口缓存。

若需同步前像仪器控制，复用原 identity.json，换新 run 名并使用本 hook 即可；helper 作用域与字节相等性比时间更适合先验证。未运行 Node/npm/SQLite/browser、语法检查或测试；Main 执行通过前不称适配验收完成。
