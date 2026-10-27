# 预扫移除、状态切换与真实读侧投影复测

日期：2026-10-27。承接[计划 §12–13](../../plans/2026-10-27-codex-incremental-visibility-and-tps-plan.md#12-冻结版本的结果与后续研究边界)。本轮前像是上一阶段已经验收的当前工作树；旧轮证据不改写。**本轮完成：接受预扫移除，投影缓存候选按证据不实施；Codex 可见等待仍有超过 8 s 的反例。** 未切生产、未提交或推送。

## 改动与接受范围

产品只改 `src/usage-store.js`：删除仅服务于状态标记的独立 `files.some` 预扫；结构性 Codex / WorkBuddy 变更仍在原位置标记 `rebuilding`，普通文件在首个实时判据确认需要刷新后、进入 `replaceFile` 的 try 之前标记一次。逐文件新鲜内容探针、原生规划的完整 raw SHA、前后及发布复核、事务和最终 ready/degraded 发布均保留。

状态轨迹有意改变：在前面未变文件的检查期间仍可读取旧完整排名；首次替换开始前才禁止读取部分排名。旧预扫之后发生的同尺寸、同 mtime 改写，也会在实际替换前标记。普通 Codex 追加原本通过 `codexPendingChange` 短路预扫，不能把本轮读量减少算成它的收益。

独立 R1 未发现该补丁新增的阻断项。`test/codex-prescan-state.test.js` 新增六条确定性测试，覆盖后面文件才变化、同尺寸同 mtime 交错、首次替换回滚及恢复、标记写失败、Codex 策略升级零替换、WorkBuddy trace targets 零替换。6/6 通过，已有状态/刷新回归 38/38 通过；C2 旧测试仅纠正预扫相关注释和断言说明。

“写失败中止”指本次 `syncRound` 不进入逐文件解析 catch。既有 timing enrichment 的第二轮 `syncRound` 位于更外层 catch 中，其失败仍保留第一轮发布并返回 `MAGPIE_TIMING_SYNC_FAILED`；不据首轮测试宣称所有错误都会端到端 reject。既有状态三次元数据写入、最终发布和逐文件提交的事务边界也未扩大。

## 读取与正式配对

带身份及阶段命中断言的 I/O 探针，静止同步从 **665,157,164 bytes / 10,870 readSync** 降到 **494,796,141 bytes / 8,089 readSync**，减少 **170,361,023 bytes（约 162.5 MiB）/ 2,781 次**。`decision.prescan` 阶段消失，rename、metadata、file 判据仍各自新鲜取样。这是同步 readSync 口径，不含 SQLite 内部或所有异步读量；插桩函数耗时不当作净收益。

正式配对采用一个有界进程中的两个独立模块树、两份串行复制的 seed DB，逐轮交替 A→B / B→A。静止和 ledger-only 各 20 对；同一次受控变更先写入冻结私有副本，再顺序同步两个版本。逐对比较完整的无详情摘要与来源指纹，仅删除预声明的 `generatedAt`、`perf.indexedAt`、`perf.meta.indexedAt`；ledger 当轮累计已计时输出必须恰为预期值，总 tokens 不变且 dirty 清零。同步、后续 all 查询、两者合计分别计时；双实例的绝对时间不冒称生产单实例或浏览器分布。

40/40 对无详情摘要和来源指纹严格相等。静止同步 p50 **3,401→2,626 ms**、p95 **3,660→2,904 ms**；ledger-only 同步 p50 **4,564→3,685 ms**、p95 **4,905→3,905 ms**。逐对同步节省的中位数分别为 **790 / 914 ms**；这里不把两个分布的分位数之差当成“配对 p95 节省”。

后续 all 查询基本未受益：静止 p50 **1,393→1,390 ms**，ledger-only **2,448→2,438 ms**。同步加该查询的 p95 分别 **5,117→4,367 ms**、**7,476→6,611 ms**。静止后台的 3 s p95 子项在该配对达到，ledger 和合计等待仍未达；它不是浏览器帧验收。首次 dashboard 计入样本，前面只预热同步；共享进程/堆/GC 和系统缓存也限制了绝对时间的外推。

R2 确认 A/B 并非 A/A，但指出累计输出断言不能排除等输出量请求之间的错配。本轮将它限定为性能与前后等价证据，另补不同输出量的逐 response / turn / duration 正确性检查；不将 40 对 hash 相等写成独立 TPS 算法认证。配对未保存全部原始摘要，hash 由运行时 deepEqual 和受控脚本保证；metadata、periodComparison 和详情不在这项摘要对拍范围。

独立单实例的顺序查询对照也保留：today/month/all 暖查询 p95 分别 **379→520 / 1,234→1,785 / 69→88 ms**，三个范围整体变慢。因此额外执行同进程 AB/BA 交错查询，共 **60 对**，并断言五个查询方法的源码未变；完整无详情摘要逐对相等。交错 today 的 p50/p95 为 **441→430 / 494→502 ms**，month **1,503→1,484 / 1,972→1,759 ms**，all **61→58 / 80→75 ms**。顺序对照的整体退化未在交错控制中复现，不能据其认定产品查询回归，也不据交错抖动宣称本轮改善查询。两组原始样本与统计均保留在 [summary.json](evidence/summary.json)。

## 真实 executor 归因

[独立探针](probes/reader-handoff.md)实际运行 executor worker，主线程禁止打开 SQLite；模块 URL / SHA、私有 DB 路径和 worker preload 均有断言。3 轮、每轮 5 个 dashboard，共 15 次规范摘要完全一致，冻结输入哈希未变。

- 同步期间 3/3 次 dashboard 使用新建的已发布 WAL 读快照（不同 reader 身份），其投影槽起始为空，因此 miss。
- 同步完成后回到同一个长期 writer；6 次 post-sync / post-no-op 查询均仅因 `total_changes` 分量变化而 miss。store / derived revision、data_version 与其它上下文保持原值。
- 同上下文 writer 暖查询命中。该人为请求序列用于区分原因，不作为生产命中率抽样。
- 代表性 no-op 后查询的插桩包含时间：timeline 710 ms，perf 628 ms；perf 内 capture 326 ms、build 301 ms。它们是一次真实调用的归因，不能把父子时间重复相加，或外推为所有页面请求的固定成本。

首个 reader 探针因为前像缺少 `package.json` 而退出，原日志保留；补齐未变的运行依赖后才接受上面的结果。该失败属于探针前像准备，不作为产品回归。

ledger-only 另用 runDirectory 内 ledger overlay，冻结来源保持只读。选中一条确有原生归属、此前缺计时的请求后追加一条受控计时：本轮 `updatedFileCount=0`、writer 身份未变、修订 **7→9**，精确增加 **113 sampledOutputTokens**，目标模型 n/TPS 更新，dirty 清零；完整用量摘要（含时间线和费用）未变。同步中实际使用已发布 reader，随后回到 writer；暖读再次命中，下一次 no-op 又仅因 total_changes miss。控制用的 duration 不代表该真实请求的生产端实际耗时。

这次发布后查询约 **2,098 ms**，其中 timeline **871 ms**、perf **611 ms**、periodComparison **420 ms**；再一次 no-op 后查询约 **1,549 ms**，周期对比已命中，但时间线和 perf 仍重算。这里分别使用同 reader 的键差异和跨请求 reader 变化：临时 reader 的 service-tier input 仍是未同步值，不能把跨 reader 的该分量差异说成 writer 的证据变更。原始与聚合归因见 [reader-ledger-attribution.json](evidence/reader-ledger-attribution.json)。

逐请求补测在本轮最终产品上通过：20 个不同输出量请求、21 次发布状态检查，共 **420 个逐 turn 检查**。每个 response 的 lookup / 持久 evidence / thread link、对应 sample 的 duration/output 都精确匹配；尚未到达的计时保持缺失，五项 token 分量不变。独立参考为 n=20、output=20,191,850、duration=59,000 ms，TPS 与 p10/p50/p90、duration 分位逐值相等。该合成夹具用于校验关联及算法，不用于宣称生产吞吐。

## 投影裁定与剩余优先级

本轮不实施简单删 key、滚动 `total_changes` 或整笔 metadata 事务 rekey。缓存包含性能状态、missing sources、partial 排名与索引时刻；把元数据当无关写入会使旧 ready / 排名 / 时间字段命中。按键豁免也不能保留同连接原始 SQL、触发器副作用、外部提交与回滚的现有检查。

下一步应先给 usage 静态投影和 perf 投影分别列出实际依赖及写入边界，再用 ledger-only 证明可只重建 perf，同时保留任意同连接 SQL 和外提交的反例。收益门槛是省下实测的 timeline 重算；若必须增加通用写追踪、持久格式或不完整的认证规则，就维持当前 miss，不拿缓存命中替代正确发布。同步中读快照的投影转交另卡研究：跨连接计数不能直接比较，quoteInputs 的关闭/失效所有权也必须独立，不能直接复制 writer 的 key 或共享可被 discard 的容器。

R3 还否决了仅按提交理由新增 usageRevision 的简化：真实 ledger 先提交 request-timing，再提交 perf；部分 Codex perf 发布还伴随 source_files 删除和 usage-delete。真实导入 await 中若同连接 raw 写 quota/events，再保留旧用量缓存，就会隐藏该写入；summary 的 guard 不会替独立 metadata / period / quota 缓存兜底。这是代码路径上的候选反例，未执行该交错实验，不能记为已跑失败测试。完整方案需要能识别这些实际写入的事实代际，不能只检查最后一个 reason。事件计价 memo 的内容键允许更窄的保留研究，但本次 all 路径的 entries/hits/misses 全为 0，不能改善所测残余，故也未实施。

持续 mutable rollout 的完整前缀证明仍有线性读量。真实读侧重算和前缀证明分别记账；本次预扫优化不宣称已解决普通 Codex 的主要可见等待。

## 浏览器控制与当前未达项

最终产品上保留原 60 s timer，手动调用其检查回调，完成 Claude / Codex 新文件 / Codex 普通追加 / ledger 四个控制。前三项可见 token 均精确增加 **1,000,107**；ledger 总 tokens 不变、匹配 sampled output 增加 **1,000,007**，TPS 文本跨舍入阈值变化。目标值与双 rAF 帧内复读均通过。检查开始到正确帧依次为 **5,699 / 8,722 / 8,486 / 5,932 ms**；Codex 两项已构成本版本 **max≤8 s 的反例**，不能沿用 §12 旧版本的通过结论。

同一控制的请求记录中，`/api/status` 请求到响应依次为 **97 / 75 / 101 / 79 ms**，随后普通 `/api/usage?preset=all`（未设置 skipCheck）为 **5,597 / 8,647 / 8,386 / 5,850 ms**。可见等待主要落在这个请求内；该区间包含普通同步、查询以及序列化/传输，不能当成纯查询、纯服务端 CPU，或从其它场景的耗时相减后归因前端。详细阶段归因仍以上面的真实 reader 探针为准。

双 tab 控制完成约 **5,550 ms**，浏览器 errors 为空，关闭后 WAL 为 **0 bytes**。受控首次加载约 **14,062 ms**，不是冷盘样本。截图见 [browser-controls.png](evidence/browser-controls.png)，每轮精确数据和请求耗时见 [summary.json](evidence/summary.json)。四个手动控制不能给出新浏览器 p95、新鲜度分布或与旧 40 周期的因果速度比较。

## 资源、门禁与复跑

Main 持有唯一 Node/npm/SQLite/browser 执行槽；W1 编写状态测试，W2 编写读侧探针，R1/R2/R3 只读复核，收尾 worker 更新入口，各文件单写。小测试 Job 1,024 MiB / heap≤768 MiB；真实库、全仓、浏览器整树 Job 7,168 MiB / heap≤1,536 MiB，控制侧留约 1 GiB，合计预算 8 GiB。已归档测量中 Node 单进程 RSS 最高 **1,415.01 MiB（约 1.382 GiB）**，浏览器控制中的 Node 峰值 **1,122.84 MiB**；两者均不是任务合计峰值。整 Job 峰值未测，预算依据整树硬限与唯一执行槽。

源写入探针均由外层 finally 执行原精确恢复器，再核对 1,630 个来源文件。末尾 [inputs-final.json](evidence/inputs-final.json) 流式复核 **1,633 个输入 / 4,229,909,674 bytes** 和 **98 个产品文件（36 src / 62 public）**，全部相等；seed SHA-256 仍为 `cfc35c20b32efd09328fde9ba477d25be3ebac5da33e55a26d9555090a085bd5`。本轮最终 store SHA-256 为 `ef1d21a1a55239662cc46a82aeadbc81bcb5d172b56c8dcf421dbba9b0128303`。只用原私有 seed 与复制来源，未打开 `tools/out` SQLite，未重冻结生产。

类型、lint、格式首轮通过（63 warnings / 5 infos）。全仓首轮遇到一条沿用旧预扫访问下界的 S1 断言，随后在 UI 几何回归中触及控制器的 **900 s 时间上限**，没有完整用例汇总。修订 S1 下界（各减两次预扫访问），仍保持至多一次解码和实际复用要求；从中断文件起补跑剩余文件，并重跑整份 perf-store：**14 文件 / 316 pass / 0 fail**。首轮已完成的 204 文件与补跑共同覆盖全部 **217 个测试文件**，清单及当前测试摘要见 [gates-tail.json](evidence/gates-tail.json)；不是一次全绿计数，首轮失败/超时不改写。未来完整复跑控制器的时间上限已放宽，v1 与本轮结果分开保留。

修正测试断言后，最终 lint / format:check 再跑通过，见 [gates-post.json](evidence/gates-post.json)。类型检查通过对应未再修改的产品源码；没有再启动一轮全仓长测。首轮和续跑日志均在本目录 evidence 中保留。

六条缺源历史事实在最终产品三轮同步前后严格相等：**14,416 events / 359 samples / 6 owners / 359 dependencies**。本轮尚存的 **5 份**测量 DB 与其 sidecar 已按明确路径检查并清理，共 **3,716,403,200 bytes（约 3.46 GiB）**；此前各脚本已删除自己的配对/查询/夹具 DB，不把 5 写成本轮全部创建数。清理清单见 [cleanup.json](evidence/cleanup.json)，seed、来源、前像和全部证据保留。

浏览器只做 Claude / Codex 新文件 / 普通追加 / ledger 四个控制及双 tab，观察可见 tokens/TPS 与精确载荷；不重复上一阶段 40 个真实 60 s 周期，因此不产生本版本新的浏览器 p95 或新鲜度分布。冷盘、实际冷归档、2×/4× 和长期运行仍未测。

本轮私有前像、原始样本、失败日志和完整身份位于 `output/codex-refresh-followup-20261027/`；可审查的聚合证据位于本目录 `evidence/`，复跑脚本位于 `probes/`。旧阶段的[40 周期证据](../2026-10-27-codex-incremental-visibility/README.md)保持版本归属，不移作本轮通过证明。
