# Q6 独立审查：第一卡“完整变化清单”能力（有限 scope 定稿）

> 历史材料，2026-11-11 归档。本文命令与状态属于原记录日期；源码及恢复方法见[归档入口](../README.md)。

**后续状态：** 本文件保留首轮独立审查。其初始化及并发闭环疑点已由后续[补验报告](Q6-INITIALIZATION-CLOSURE-REPORT.md)中的 10 项初始化、16 项并发/故障/对照和两个独立检查补齐；第一卡在限定范围内具备准入依据，正式接入仍未开始。

日期：2026-11-04，开始 13:19:41 UTC；收口依据为已冻结的 `output/architecture-20261104/q6/directory/result.json` 最新一次运行。独立审查 worker；只审查卡一，未实施卡二。版本库唯一写入为本文件；诊断仅放 `output/architecture-20261104/q6/audit/`。未改 `src/`、`public/`、`native/`、活跃数据或系统 journal；未创建后代、未 commit。

## 给主的结论

**在主代理提出的有限 scope 准入条件下，建议有条件批准卡二开始实现。** 批准的是“底层能力准入”，条件是：完整基线身份清单与初始化 seal、每轮读取全区间到预先 captured cut、对每个已消费变更文件逐文件 seal、只 ack captured cut、namespace / 别名 / 无法解析 / 不支持 reparse / 任何覆盖疑义全轮回退既有完整检查。按这些条件，我无法给出一个确定的“区间内无该 file ID 记录却已有应处理变化”的底层遗漏反例；所以该路线应写为**有条件可行**。缺 list op、产品 collector、事实/进度/发布事务尚未实现，是卡二的实现工作；把它们当作底层能力否决会形成循环依赖。完整产品 collector 与发布事务仍**未实现、未验收**，不能写成卡一 8 组已逐组通过。

**若按卡一字面要求“可运行 collector 对 8 组各给预期集合与实际集合”，则卡一尚未全过。** 这两种口径必须分开：能力准入通过有条件结论；产品实现验收未发生。主可据此决定按有限 scope 放行卡二，或坚持完整 collector 验收后再放行。

**naive 反例不是全路线阻断。** 最新 `result.json` 的 `decision` 是 `complete-collector-not-established; naive-delta-and-per-file-seal-control-reported-separately`，`completeChangeSetEstablished:false`；早期 `blocked-by-real-open-handle-counterexample` 已过时。仅推进游标的方案实测漏 19 次；每次消费后逐文件 seal 的 20 轮实测 `missed:0`。因此“必须永久维护全部打开句柄活动集”不再是当前最强阻断点。旧报告里把首次无效对照归因于 warmup 不合格也是错的；实际是 V2/V3 file ID 匹配错误，已由主修正，旧对照不能当有效反例。

**最强剩余阻断点 / 卡二首个必验收点：** epoch 边界。强制 CLOSE 记录不是实际关闭，官方文档只说明它写入带当前 reasons 的 close record 并返回 USN，没有承诺普遍清除累计 reason；20/20 重出是本机此卷此运行的实测。若并发写入恰好落在 seal USN 前，它可能只体现在自生成的 CLOSE 记录里；collector 若把自生成 CLOSE 当噪声丢弃、只处理普通 DATA_EXTEND，或错误 ack 处理结束的新 cut，就是具体遗漏反例：该区间后续无普通记录，文件被发布为“未变化”。**这是条件削弱后的理论反例，不是已实测失败，也不否定用户给出的完整准入条件。** 准入条件必须严格解释为：captured cut 之后的全部记录（包括自生成 CLOSE）留在未 ack 区间供重放；CLOSE 记录中的 cumulative reasons 不能默默丢弃，无法区分“已消费写入”和“seal 前并发新写入”时按覆盖疑义全轮完整回退；用 seal 返回的精确 USN 与文件内容/offset 快照绑定，再提交事实、依赖、版本和 captured-cut ack。只有这些边界成立，才能说“无该 file record 即可跳过”。

## 证据分类

### 代码事实（静态阅读）

- `native/windows-source-proof/src/main.rs:9-22`、`:98-156` 只接受 `stats/begin/verify/advance`，请求和响应都是单个已知 `path` 与单文件 `offset/token/journalBytes`；`src/usage-source-native.js:112-174` 同样只传一个 `filePath`，`close()`（`:176-181`）只停 helper。没有 list、root、parent、name 或 changed-set 输出。**这是当前接口表达范围，不是 Windows 底层无法实现清单的证据。**
- `native/windows-source-proof/src/usn.rs:99-111` 的产品记录只留 `usn`/identity/reason，丢弃 parent/name；`:595-616` 只累积目标 identity；`:335-353` 的 `FSCTL_WRITE_USN_CLOSE_RECORD` 作用于传入文件句柄，`:253-258` 的卷根仅用于 journal 查询/读取；`:355-490`、`:544-627` 是单文件旧/新 seal 区间。`:315-332`、`:493-530` 检查 journal ID / first USN / lowest valid USN；`:759-766` 按 V2 FRN64 / V3 128-bit file ID 匹配。当前代码没有打开句柄清单，也没有 HARDLINK / reparse 自动回退。
- `src/usage-source-watch.js:45-70` 将不同文件名事件合并成无参数 hint；`src/server.js:726-737` 也是无路径回调。`src/usage-store.js:4206-4238` 的既有完整发现与逐文件指纹仍是当前兜底。`src/usage-source-proof.js:151-178`、`src/usage-store.js:4006-4007`、`:4144-4148` 提供单文件验证失败的完整替换/事务回滚，不等价于目录覆盖不成立的结果。
- 实验探针 `experiments/architecture-20261101/q6-journal-probe.rs:29-47` 证明原始 V2/V3 记录可解析 parent/name；产品 parser 丢掉这些字段不构成底层能力限制。已有 `docs/plans/2026-11-04-source-acquisition-publication-plan.md:30` 引用微软 Change Journal Records 与 FSCTL 官方页，本轮无需重复联网查基本语义。

### 本审查已跑轻量用例（实测）

`output/architecture-20261104/q6/audit/node-tests.log`，`pwsh` 中定向 `node --test --test-name-pattern=...`：**5 passed / 0 failed / 0 skipped，`NODE_EXIT=0`**。

1. `test/usage-source-native.test.js`：缺失 binary / closed helper 返回 `null`。
2. 同文件：malformed JSON、非法 UTF-8、截断输出、`available:false`、错误 kind、超大响应、超时均返回 `null`。
3. `test/usage-source-append.test.js`：`verify` 返回 `null` 后 full replace 且事实与 oracle 一致；`capture` 抛错后事实、progress、revision、事务深度回滚。
4. `test/source-wake.test.js`：不同文件名事件合并成一个固定窗口的无路径 hint。
5. 同文件：丢 wake 后首轮仍读旧值，随后既有完整 checked sync 恢复新值。

私有 `helper-close-probe.mjs` / `.log`：坏协议 helper 写回 pid 并保持心跳，`begin()` 返回 `null`，`helperAliveAfterProbe:false`，`PROBE_EXIT=0`，补足“bad protocol 会关 helper”的进程级断言；机制见 `src/usage-source-native.js:218-247`、`:275-284`。首次探针因脚本未把 pid 路径交给 helper 报 `ENOENT`，是脚本错误。未跑 raw journal、W3 集成、Rust 测试、整站回归、大夹具、lint/类型检查或性能矩阵。

### 主 raw 结果（实测，主执行；我复核冻结文件）

- 一次初始 seal 后只推进游标：20 次同句柄追加中 19 次文件增大却无目标 ID 记录，250/1000 ms 后仍无；目录 root seal 成功但子 writer 不重出，逐文件 seal 的阳性控制通过。另 20 轮“写入→读取→逐文件 seal→drain→下一次追加”**20/20 有 fresh `DATA_EXTEND` 与 `CLOSE|DATA_EXTEND` 封口记录，`missed:0`**。该结果支持“逐文件 seal 重置累计 reason”的局部实测，不证明官方文档的通用 reset 保证，也不测试并发 seal/write。
- `FSCTL_READ_UNPRIVILEGED_USN_JOURNAL` 的 V3 记录本轮 `name` 全空，但 file ID / parent / reason 保留。主用普通权限卷根句柄作 hint 的 `OpenFileById` + `GetFinalPathNameByHandleW` 成功把未知新文件 ID resolve 为完整路径；带 `OPEN_REPARSE_POINT` 时 junction 的 attributes `0x400` 可见，硬链接 alias 与原文件 IDs 相同且 `links:2`。案例自述 `guard observations only; no production auto-fallback was added`：这些是 guard 可见性实测，不是产品自动回退实测，也没有测别名写入。
- 父目录改名、子树移出、移入范围都出现目录对象及 parent 变化；子文件可没有自己的记录，移入案例明确 `directory event requires subtree reconciliation`。处理 epochOne 截点后新建未知文件、seal 旧文件、重启 observer，从原 cut 读 ALL records（无 oracle 过滤、无 watcher）可 resolve 新文件；错误 ack 处理结束后的新 cut 会丢它。
- 扫描中写入案例通过暂停 raw scan 截点、恢复扫描验证：当前 captured cut 不含该文件，下一次从该 cut 起的扫描包含它。真实 `SIGKILL` helper 后从原未确认 cursor 重启得到 exact record replay；案例仍明确 `does not test a collector publication transaction; no such collector has been implemented`。非法 cursor / journal ID / 非活动卷是受控协议夹具，不是真实日志淘汰、重建或权限变化。所有 raw probe 源数据仍小于 2 KB。
- `result.json` 自述 `scope: raw journal capability witness; oracle IDs are obtained independently, not a production change collector`。以上均为能力证据；没有产品 facts / 依赖 / 发布游标 / 事务原子性验收。

## 卡一 8 组：哪些只审查、缺 collector 不能验收

| 组 | 证据性质 | 产品 collector 验收 |
| --- | --- | --- |
| 1 长开句柄 20 次追加 | naive 实测漏 19；逐文件 seal 实测 0 漏 | raw 能力部分通过；并发 seal/write、无自生成 CLOSE 误丢、完整实现未验收 |
| 2 追加 + 原地改写 / 恢复 mtime | 本审查只静态核对；另一单文件 worker 已在本轮实测 native/SHA 拒绝 | 单文件已测，缺 collector 预期/实际集合，不验收 |
| 3 截断 / 删除重建 / 同大小替换 | 本审查只静态核对；另一单文件 worker 已在本轮实测三类拒绝 | 单文件已测，缺 collector 清单与别名处理，不验收 |
| 4 新建 / 父改名 / 目录移入移出 | raw 记录、ID resolve、ALL records 及 cut 对照有实测 | 持久目录映射、递归旧/新路径集合与 bootstrap 未由 collector 输出，不验收 |
| 5 HARDLINK / reparse / 外部目标 | guard 观察实测：junction `0x400`、alias 同 ID / `links:2`；另一 worker 已实测别名追加 | 别名写入单文件契约已测；产品自动 fallback 未实现，不验收 |
| 6 丢 watch / 未知 / 重复 / 合并 | 本审查 2 个轻量用例实测合并与完整 checked sync 恢复 | 无路径 hint 保持原状；新快速 collector 未实现，不验收 |
| 7 journal 缺失 / 重置 / 权限 / helper 异常 | 轻量 fail-closed 5 项、坏协议 kill、受控非法 cursor / ID / inactive 卷实测 | 真实淘汰 / 重建 / 权限变化与目录级覆盖不成立返回未实测，不验收 |
| 8 扫描中写入 / 重启 / 完成前重启 | raw 扫描中写入、SIGKILL exact replay、旧 cut 重放与错误 ack 阴性对照实测 | 产品事实/依赖/发布事务和崩溃原子性未实现，不验收 |

“不验收”不等于“实测失败”或“底层 Windows 做不到”。当前最强剩余边界是自生成 CLOSE / 并发 seal epoch 与完整基线初始化；按有限 scope 的覆盖疑义全轮回退，正确性可保守维持，但快速通路可用率会受影响。卡二可有条件开工，须把上述 epoch 规则、完整基线、guard 回退和发布事务作为实现与验收内容。本审查到此停止，等待主验收，不进入卡二。
