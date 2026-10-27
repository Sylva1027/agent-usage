# Codex 增量可见等待与 TPS 后续优化计划

日期：2026-10-27。状态：**N1/Q1、预扫移除与 Q2/Q3 已验收收口；Q2/Q3 局部收益接收、v4 完整门禁通过，正常 6 个浏览器周期完成；整体 max 与新鲜度目标未达，浏览器 p95 未验。** 用户授权整理后直接开工，保持 8 GiB 合计预算，暂不切生产。本文承接[上一轮验收](../validation/2026-10-26-refresh-sync-latency-implementation/README.md)与[旧方案 §16](2026-10-26-refresh-sync-latency-plan.md#16-本轮实施结果与后续优先级2026-10-27)，旧证据不改写。N1/Q1 结果在[首阶段验收](../validation/2026-10-27-codex-incremental-visibility/README.md)，预扫移除阶段见[后续验收](../validation/2026-10-27-codex-refresh-followup/README.md)，本轮最终结果与剩余优先级见 §13 和 [Q2/Q3 验收](../validation/2026-10-27-q2-q3-projection/README.md)。

## 1. 要解决的问题和已知边界

1. Codex 普通追加的后台同步 p95 6.89 s；浏览器检查开始到正确新值为 8.10–8.53 s。发现、原生候选校验、计时关联/发布、查询与 DOM 都要分别测，不能从两个不同样本相减推定“前端多耗时 1.6 秒”。
2. 一个文件变化会使 home 进入 planStableCodexHome；该函数目前在读取前对全部文件捕获 raw SHA-256 前缀证据。上轮约 1,389 次、2.803 GB。这主要服务于读取期间或发布前的并发追加证明，不等于 1,389 个文件都重新解析，更不等于 1,389 个线程都重建候选。
3. 静止其它同步读取约 665 MB，只证明读取字节仍大，尚不能全部归因给某个 stat 或指纹函数。已有 S2/C2 做过部分窗口复用，必须先查剩余调用与其区间，不能重复实现旧卡。
4. TPS 共用原生映射与发布链：native 变更可能改变候选与 coverage，ledger 提供可匹配时长（也可能早已读入等待原生映射）；随后性能修订、查询和页面统计才更新。TPS 分母是生产端记录的请求耗时，同步等待不计入分母，只影响何时可见。上轮 ledger-only 当轮发布正确，但后台 p95 3.35 s、页面 5.11–5.39 s，正确性与速度是两件事。
5. 同范围/修订的 all 暖查询已降到 p95 70 ms；today/month 本轮分别为 504/1,679 ms，未改善。普通 all 的范围按事件日期确定，now 每秒推进不必然 miss；新事实、例行元数据写引起的 total_changes、外提交、reader 更换与真正的范围变化须分别归因，不能外推为默认刷新总是 70 ms。

上轮 21 周期各子组不足 20；G1 已有超过 8 s 的反例，G2 只有一条超实际周期+5 s 41 ms。两项分别保留，不夸大或舍去小幅超限。当前真实冻结库 0 archives，实际冷段性能、2×/4× 和长期生产行为均未证。

## 2. 当前调用链与研究入口

- src/usage-store.js:8251–8288：保留缺源集合判据及 metadataChanged/dirty 等 shouldPlan 条件。
- src/usage-store.js:8396、8449：完整 home 规划后，已按受影响线程选择 builder；不再派一张“新增 dirty builder”的重复卡。
- src/usage-core.js:2589–2735：发现、before、planner、after、路径集比较及并发追加证明。
- src/usage-core.js:2376、2410、2503：前缀 raw SHA-256 采集及 proveCodexLiveAppend；原始字节证据不能从标准化投影重构。
- src/usage-store.js:8754–8838：用量读取之后、发布之前再次发现和校验，任何优化都要覆盖这个晚窗口。
- src/perf-sources/codex-thread.js:569：现有完整文件集合、投影归属证明和同线程多文件合并。
- src/usage-store.js:7456、7500、7567：sync、Magpie 增量关联和定向发布；已有外部提交与发布前物理依赖复核必须保留。
- src/usage-store.js:11171 起：现有 summaryProjectionKeys 与 all 静态投影；查询研究单独使用当前修订和真实 now。

行号只是本次起点，开工后以函数名和新源码摘要定位，不维护“签名永远不可改”的旧仪器限制；探针与接口如需调整一起更新，不为保留过时锚点扭曲产品结构。

## 3. 第一优先：普通 Codex 规划成本

**首先研究减少正常稳定窗口中无用的 eager 全文前缀采集，保留完整发现/归属/前后/发布校验。** 这比直接重写整个 planner 的作用域更小；只有短测确认 planner 本身仍显著，才进一步研究按线程缩小集合。

候选顺序：

1. 分开“本轮仍需的新鲜首尾指纹”和“只有源在窗口内继续增长时才会消费的 raw 前缀证明”。验证普通稳定路径能否不提前为整个 home 读完全文。
2. 并发追加需要前缀证明时，研究有界重验/严格路径；涉及 planning 中与首次 post-planning 追加两处。必须保留健康兄弟线程同轮可发布、活动线程保留旧事实并可恢复，以及原告警/partial 语义。不能仅把整个 home 永久标为 degraded 省成本。
3. 任何有界重验都要明确触发、最多次数、已提交用量如何累计计数、原生/TPS 发布及读侧快照边界。普通成功路径不重复完整 round；异常重验单列成本，禁止无限循环。
4. 若无法保留上述行为，就保留当前严格实现，记录该候选不入选，不把性能收益当成绕过反例的理由。

**不得采用**：只信 size/mtime；把首尾摘要当全文 SHA-256；拿同首尾指纹的旧 raw digest 冒充本窗口的全文证据；从已读后的文件补一个 digest 再称它是读取前证据；用同一个快照让 before/after/发布检查恒相等。是否引入持久新证据格式或分块算法不在默认范围。

## 4. 第二优先：重复读取归因和同窗口复用

先在隔离探针中记录“调用者、物理来源匿名键、验证窗口/阶段、同步或异步读取、字节数和次数”。区分：

- 元数据规划判据、planning before、planning after、预扫、逐文件判据、发布前复核；
- 首尾内容探测、全文前缀证明、JSONL/压缩解析、SQLite 来源/WAL；
- 使用量与 TPS 各自读取，主线程/worker 和互相包含阶段。

只能在已证明的相同验证区间内复用。跨 await、来源读取、文件变更、规划重试、home/owner/method 修订、外部提交、rollback、close 后失效；至少按实际会结束该验证区间的边界清除。before/after 和发布前的新鲜采样保留。优先复用现有 window/reused-signature 机制；若没有可证明的剩余复用点，就只交归因，不加通用缓存服务或多个近义 map。

bytes 减少与墙钟收益分别验收，不把所有 fs.readSync 字节都标成 prefix，也不相加重叠函数耗时。小夹具先验证探针不改变同步返回、异常和事务语义。

## 5. TPS 是独立的正确性与可见性验收线

必须覆盖：

| 场景 | 本轮必须可见的事实 |
|---|---|
| native-only，无匹配计时 | 精确 token、新候选/coverage、模型身份及缺失计时状态；不补造 TPS，不回退用 item spans。coverage.pending 仅指 in_progress，不解释为同步积压 |
| ledger-only | tokens 不变；匹配样本、sampledOutputTokens、TPS/分位及覆盖率当轮更新 |
| 同轮 native + ledger | 本轮就关联并发布，不能等下一轮才出现 TPS |
| 迟到映射、foreign evidence、冲突/重置 | 继续原优先级与冲突语义；证据不能因增量过滤被丢弃 |
| 读入成功但发布失败，随后无新字节 | dirty/pending 保留，下一轮重试；不提前确认 ledger 指纹 |
| 外部提交/构建期间源变 | 拒绝旧 context，重新校验；不暴露半发布候选、coverage 或 indexVersion |
| 冻结/skipCheck/imported/历史保留 | 读取对应已发布版本；冻结不观察后来的 ledger，本机 ledger 不污染 imported runtime |

逐个比较 samples、owners、dependencies、告警、coverage、codexTimingCoverage、groups/models、indexVersion、timing revision 和 acknowledged fingerprint；不能只验行数或 tokens。TPS 数值对拍完整参考，不能预设算法变更后理应“更高”。浏览器必须直接观察可见 TPS 文本变化以及完整载荷中的精确统计，测原生值与 TPS 两个目标的各自帧时刻。

若 native 与 ledger 有实际先后到达，分别记录“源数据到达”和“匹配计时到达”；不能把尚不存在的 duration 算作 TPS 性能迟到。

## 6. 第三优先：month 与刷新后投影 miss

先把成本分成 perf 统计、grouped/timeline、cost/quote、records、metadata、序列化和实际绘制；测首次、同上下文命中、now 推进、新修订和价目变化，不只重复固定 now。单独记录 key 各分量与 reader 身份，普通 all 在事件日期范围不变时应能命中；不能把 now 变化本身当作全部 miss 的解释。上轮 month 的 timeline、grouped 和 perf 均有实际成本，暖态 records 已很小，不先优化冠军扫描。

优先考虑现有投影机制内可严格失效的子计算复用或 SQL 查询改进。month 是否缓存由新证据决定，不先立整个响应缓存。任何 cache key 调整须保留精确毫秒范围、跨日、quota reset、排除 homes、includeDetails、method/revision、价目/汇率及外部提交；不能简单删除 total_changes/data_version 或把所有 now 舍入到同一分钟。

此线与 TPS 发布分别计时：统计慢会拖延 TPS 显示，但不据此宣称 duration 错算。若第一、二优先后已经满足可见预算，不为完成卡数强行加查询优化。

## 7. 多 agent 卡片与文件所有权

本次沿用原生 agents、默认继承主模型，无需给每个角色新建用户 chat。Main 维护计划、执行账本、入选裁定和最终证据；最多三名 worker，按实际依赖使用，不为凑并行拆碎任务。

| 卡 | owner / 前置 | 唯一交付和退出条件 |
|---|---|---|
| S0 | Main，立即 | 记录真实工作树/前像/源码摘要、冻结输入与资源槽；复用已有 seed，不读 tools/out SQLite、不重冻结生产 |
| N1 | Main，S0 | 规划/前缀严格语义研究、最小实现和现有 live-partial 反例；先短测，收益不成立即不入选 |
| T1 | W1，与 N1 并行 | 独立 TPS 时序反例与完整参考对拍，仅新测试文件；无测试权时只写待执行，不能自报通过 |
| I1 | W2，与 N1 并行 | 独立读取归因探针和消费点表；代码不改产品，拿到单槽后才运行 |
| V1 | Main，N1/T1/I1 | 正确性和短 A/B，确认实际残余，再裁定 I2/Q1 是否进入 |
| I2 | Main，I1/V1 | 只实现有证据的同验证区间复用；失效反例、字节与净耗时齐全 |
| Q1 | W2 条件卡，V1，整文件移交后 | month/刷新后 miss 最小实现；或以证据裁定不实施，二者都可关闭本卡 |
| R1 | 独立 reviewer，与集成并行只读 | 检查 prefix 证明、重试、外部提交、TPS 与查询失效反例；交明确发现，Main 运行验收 |
| H1 | Main，产品冻结 | 最终门禁、同源 A/B、按目标分组的真实浏览器周期、资源/恢复/残余和入口文档 |

**整文件单写**：Main 初始独占 src/usage-store.js、src/usage-core.js、src/perf-sources/codex-thread.js 和其现有 planner/live-partial 测试；W1 只写新 test/codex-incremental-tps-visibility.test.js 与现有 test/app-autorefresh.test.js；W2 初始只写本阶段 probes/输出。Q1 如需 store，必须在 I2 之后移交整个文件，Main 暂停写入；不能按函数区域假装不冲突。server/executor/app 默认不改，只有独立证据需要时另明确文件移交。各卡验收后归还所有权，不能整包覆盖前像。

卡片交付包含起点摘要、允许文件、实际 diff、已执行命令/退出码/资源限制、反例与未测；Main 读实际 diff、最小独立验证后接受。研究结论或 worker 自报完成不等于实施已接受。测试槽每次明确交接，未授权时 worker 不启动任何 Node/npm/SQLite/browser。

## 8. 资源、隔离与测量顺序

**8 GiB 是本任务合计预算**。唯一执行槽；真实库/全仓/浏览器整树 Job 7,168 MiB、Node heap≤1,536 MiB，控制侧约 1 GiB；小夹具 Job 1,024 MiB、heap 512–768 MiB。使用 scripts/run-with-memory-limit.ps1；PowerShell 只用 pwsh，npm 用 Node 入口，不绕过 Job 或按 agent 各给 8 GiB。最多两浏览器 tab。Node RSS 不冒称整 Job/Chrome 峰值。

复用上轮私有来源与 seed，流式复制，不并行复制多套真实输入。每场自己的 DB/合成 rollout 有固定前缀。任何退出码、超时或内存中止后均由外层恢复，再核对输入，不能依赖 JS finally。沿用 raw JSON decimal→100ns 的恢复器及原始摘要校验，避免 Date/PowerShell 丢时间精度。旧证据只读，完整路径摘要仍留私有目录。

顺序为小反例 → 一次短基线/阶段计数 → 入选实现 → 短对拍 → 冻结版本后的正式分布。全仓与长浏览器只在最终整合版本运行；新失败或产品变化才重跑必要部分，不为每卡重复一套 20 分钟基准。

## 9. 验收预算和足够的样本

- 保留旧候选目标：普通 Codex 检查 tick→目标帧 p95≤3 s、max≤8 s；后台静止/各增量 p95≤3 s、max≤8 s。这是验收目标，不是预先承诺，未达时保留实际差距。
- 新鲜度用每轮真实 tick 间隔+5 s，保留原 60 s 频率和最坏写入相位，超 41 ms 也如实保留，不以放慢轮询达标。
- tokens 与 TPS 都要有非空目标帧、可见文本跨舍入阈值和精确统计断言。DOM 与双 rAF 内重新读取；记录 tick/request/响应/DOM/frame、排队/合并和 busy；不能用旧总量命中假装新值已经显示。
- 最终后台对入选主要场景各≥20 暖样本。浏览器重点补齐 **Codex 普通追加≥20、ledger-only≥20** 个真实周期；同轮 native+ledger、新文件、Claude、切筛选、quota、双 tab 用明确控制样本回归，不冒充这些子组的 p95。正式长测只跑一次稳定版本，不重复沿用上一轮混合21周期的不足。
- before 使用本阶段开工前真实前像，after 独立副本，同 now/价目/来源/时区；完整摘要仅预先移除 generatedAt、perf.indexedAt、perf.meta.indexedAt。非静止场景用相同受控变更对拍业务和 TPS；来源指纹与 API clientFingerprint 各按职责验证，不要求两个函数字符串彼此相等。
- 原先“常规路径不全文读取未变历史”的候选已被 §11 的反例否决，不再把它作为本轮必须满足的验收条件。入选候选保留完整 raw SHA，分别验证字节量、并行墙钟收益和退出后的资源回收；完整发现、before/after 与发布复核继续独立取证。
- 必须保留同线程多文件、跨 home/owner 变更、首次晚追加、改旧前缀后增长、同尺寸同 mtime、截断/替换、压缩来源、稳定失败/部分失败恢复、外部提交交错、六条缺源历史事实和已确认 ledger 重试。
- query 命中、真实默认刷新、新修订 miss 分别报告，today/month/既有 all 不能静默退化。顺序 A/B 尽量交错短控制，保留全部样本，不凭几次抖动宣称因果回归。
- 最终 Node --test --test-concurrency=1，全仓 typecheck/lint/format:check；首轮失败和定向恢复分别保留，不改写为一次全绿。多轮资源、WAL 关闭收敛和失败恢复一起记录。

当前数据可验本机1×。2×/4× 只在实际入选方案需要证明增长特性时，用有界串行夹具检查“未变历史字节增加是否触发全文”；不复制成多份完整历史、不突破预算。实际冷段和长期运行未测就明确标出，不把热点夹具外推为生产保证。

## 10. 阶段收口

执行记录逐卡标 ACCEPTED / 待修 / 按证据不入选；仅最后冻结版本跑正式长测。报告分开给出 Codex tokens、TPS/coverage 发布、查询与可见等待的收益和未达项，更新本文、docs/00-index.md、docs/02-tasks.md。

用户已授权整理后自动开工，不再设置实施许可等待点；必要的范围判断由 Main 按测量作出。不重启或切换生产，不提交/推送，不安排自动任务。Merkle/分块新格式、通用响应缓存、独立读进程、轮询频率及无关计价/归档/UI 改造不自动纳入。

## 11. 开工研究更新

- 直接省略普通窗口全部 raw 前缀后，遇到一次性旧前缀改写再增长，事后重读无法重构原前像；直接重试并发布也会改变现有“活动线程保留旧候选，静止轮再恢复”的合同。该简化方案不实施。
- 64 KiB / 256 KiB / 1 MiB buffer 的交错全读约 2.0–2.15 s，完整摘要一致，但没有明确净收益，不改产品 buffer。
- 新有界候选：完整 SHA-256 流读并行化。冻结 1,388 文件/2.803 GB，1 worker 1.96–1.99 s、2 worker 1.00–1.01 s，摘要一致、微基准 Node 峰值约 183 MiB。先用最多两个短生命周期 hash worker 做小夹具语义/资源与真实默认路径短测，再决定接受；并非独立读服务或常驻 worker 池，不改变 TPS 算法、源数据、指纹格式或轮询。
- SHA 计算可以并行，before/after、完整发现与发布复核不能共用同一快照。worker 读取必须纳入探针和整树 Job；微基准不能直接当端到端提速。
- 并行只由已有串行 store sync 的临时 home 副本显式开启；内存/完整报告保持同步，防止多个请求叠加 worker。小于 256 MiB 或只有一个文件时保留同步路径；大 home 按字节平衡分成两个短生命周期 worker，逐文件仍先取首尾指纹、紧跟全文 raw SHA，全部退出后才开始 planner。
- I2 判定不实施：metadata/prescan/file 即使没有 await，外部进程仍可在它们之间同尺寸改写并恢复 mtime；跨阶段复用负向判断会漏检，未规划 home 也没有对应发布前窗口兜底。保留 665 MB 静止同步读取为明确残余，不加通用缓存。
- I1 首轮仪器虽 exit 0，但模块 realpath 路由绕过插桩，作为失败证据保留；修正版本增加模块身份和实际阶段命中断言。修正后的静止样本为 665,157,164 bytes / 10,870 readSync，主要是 rename、metadata、prescan 和 file 判据，并非全部全文前缀。
- 查询修正短测：all 同上下文与 now+1秒命中；no-op sync 后仅 total_changes 分量变化而 miss。暂不调整 key；Q1 仅研究复用已有 timeline 的分组融合及原 SQL fallback，不引入 month 响应缓存。

## 12. 冻结版本的结果与后续研究边界

N1/Q1 与 H1 已完成。后台各 20 样本，Codex 追加 p95 4,924→3,956 ms；ledger-only 2,374→2,355 ms、Claude 2,006→1,981 ms 基本持平。查询各 20 暖样本，today 614→399 ms、month 1,866→1,275 ms，all 69→71 ms；63 个完整公开摘要哈希与表计数/来源指纹等价。40 个真实周期数值及双目标帧全正确，Codex tokens/TPS p95 6,008 ms，ledger-only TPS 3,865 ms；G1 的 3 s p95 未达、max≤8 s 子项通过，G2 在本次已测相位 40/40 通过。全仓首次 3,285 pass/25 skip/1 bad-port fail，同源码 API 整文件复核 5/5 pass；类型/lint/格式通过。冻结 1,633 输入 SHA 与 57 模块复核相等，9 份临时 DB 已清理；保持 8 GiB 总预算，未切生产。完整数值、首次门禁失败及复核见执行记录，不用旧轮基准替代本阶段前像。

以下是 §12 收口时两个**当时尚未实施**的方向，先后按改动大小与当时证据安排；本次执行和最终裁定见 §13，不将旧状态当作当前阻塞：

1. **移除独立预扫，改为第一次实际刷新前标 rebuilding。** 独立只读复核确认 pendingChange 仅用于状态标记，不参与文件选择与发布。它可避开静止样本中 prescan 的 170,361,023 bytes，而不跨窗口复用摘要；普通 Codex 追加已经被 codexPendingChange 短路，不能把这份读量或 319 ms 归因耗时算作它的潜在收益。优先验证静止/ledger-only 的净收益。需要先明确状态轨迹差异：前面的未变文件处理期间保留旧完整排名；首次 replaceFile 前才标 rebuilding；预扫之后发生的同 size/mtime 改写也应在实际替换前正确标记。结构原因 codexPendingChange/WorkBuddy targets 仍按原时点标记；状态写入失败应直接中止，不能落入解析失败 catch。以“后面才有变化、同 size/mtime 交错、首次替换失败/rollback、标记写入失败、结构原因无实际替换”五类测试验收，新的探针锚点另版维护。
2. **分别研究 usage 与 perf 的投影失效边界。** ledger-only 不改变 token 事实，页面仍等待后续 all 统计；固定读实例短测中的重算 timeline 约 0.7 s、perf 约 0.64 s。先在真实 executor 链分别量化 reader 更换、发布修订与 key 变化，不能把直接 UsageStore 的 no-op 结果当成浏览器所有 miss 的原因。再证明哪些输出和修订可分别复用，决定是否拆分投影；同连接原始 SQL、外提交、reader 生命周期、source/home 身份、价目/汇率、service tier、冷 authority、dirty/rollback 和关闭都要保留。不能直接删 total_changes 或复制一个无完整依赖的响应缓存。

持续 mutable rollout 的完整前缀证明仍是线性读量；本轮只改善墙钟。若进一步研究文件系统代际、持久分块等结构方案，要另立格式/平台/恢复范围和原始改写反例，不能把它们作为本次简单缓存补丁。真实冷盘性能、2×/4× 和长期生产行为仍未证。

## 13. §12 后续结果与剩余优先级（2026-10-27）

用户已授权按 §12 顺序直接实施有明确收益的候选，保持多 agent、8 GiB 合计预算，暂不切生产。本轮前像为 §12 已验收的当前工作树，另存 `output/codex-refresh-followup-20261027/preimage`；不复用更早的 v6 前像当对照。证据另存[后续验收](../validation/2026-10-27-codex-refresh-followup/README.md)，旧轮原始证据保持只读。

- Main 独占产品，先移除独立预扫，保留逐文件实时判据和结构早标，再串行执行反例、实测、全仓与浏览器控制。
- W1 编写新状态反例，W2 编写真实 executor 探针，R1/R2/R3 分别复核状态、对照和失效候选，收尾 worker 更新索引；整文件单写。worker 未启动 Node/npm/SQLite/browser，运行槽始终由 Main 持有。
- **预扫移除 ACCEPTED。** 六条新状态反例、38 条既有回归通过。静止同步 readSync 减少 **170,361,023 bytes / 2,781 次**。两个独立 Store/DB 在同进程 AB/BA 交错，静止/ledger-only 各 20 对，完整无详情摘要和来源指纹均相等；sync p95 分别 **3,660→2,904 / 4,905→3,905 ms**，逐对节省中位数 **790 / 914 ms**。这不是上轮单实例分布，不能拿 ledger 的 3,905 ms 与 §12 的 2,355 ms 直接断言回归。普通 Codex 追加原本短路预扫，不认领此收益。
- **实际读实例归因完成。** 同步中 3/3 请求使用不同的已发布 reader，空投影槽 miss；回到同一 writer 后，6 次 miss 均仅有 total_changes 变化。真实 ledger overlay 当轮让 writer 修订 7→9、精确增加 113 sampledOutputTokens，完整用量事实未变；该调用仍重算 timeline 871 ms、perf 611 ms、periodComparison 420 ms。这些插桩包含时间只解释该调用，不相加外推成固定收益。
- **简化投影候选按证据不入选。** 不删除或滚动 total_changes，不豁免整笔 metadata，也不按最后提交 reason 新增 usageRevision。真实 request-timing→perf 提交链、可能伴随 usage/source 删除、同连接 SQL 与触发器使这些规则不足；R3 的交错 raw SQL 是静态候选反例，未作为已执行测试。计价 memo 在所测 all 路径 entries/hits/misses 均为 0，无实测收益。跨 reader 复制投影还缺独立 quoteInputs 所有权与快照证明，本轮不实现。
- **当前可见等待仍未达。** 最终浏览器四项手动检查控制数值/目标帧正确：Claude **5,699 ms**、Codex 新文件 **8,722 ms**、普通追加 **8,486 ms**、ledger TPS **5,932 ms**。两个 Codex 样本已反例 max≤8 s。普通追加同轮 status 请求 101 ms，随后普通 all usage 请求 8,386 ms；后者包含同步、查询和传输，不当作纯查询或前端成本。双 tab 与 WAL 关闭归零通过；本版本没有重跑旧 40 个真实周期，不给新 p95/新鲜度通过结论。
- **查询对照已收口。** 顺序 before/after 出现 today/month/all 整体变慢后，补充各 20 对交错暖查询，60/60 完整摘要相等，五个查询方法源码未变；顺序整体退化未复现。本轮既不认定因果回归，也不宣称查询提速，两组数值同时归档。
- **最终门禁及清理完成。** 类型/lint/格式通过，修正预扫删除后过时的 S1 访问下界并再次通过 lint/格式。首轮全仓 900 s 控制器超时和 S1 失败保留；原先已完成的 204 文件加尾段及 perf-store 14 文件续跑（316 pass / 0 fail）覆盖全部 217 文件，不能称为一次全绿运行。20 个不同输出请求、21 个发布状态、420 个逐 turn 检查通过；六条缺源历史事实保留。最终 1,633 输入与 98 个产品文件摘要相等，5 份尚存测量 DB 清理，seed 未变。真实库整 Job 硬限 7,168 MiB、控制侧留约 1 GiB；最高已记录 Node RSS 1,415 MiB，整 Job 峰值未测。

状态写失败的验收应精确到 `syncRound` 和逐文件 catch：该错误不能被误报为源文件解析失败。既有计时补充的第二轮 `syncRound` 位于 timing-enrichment catch 中，失败会保留首轮结果并给出 `MAGPIE_TIMING_SYNC_FAILED`；本轮不据首轮测试宣称所有端到端错误都会直接 reject。

以下独立卡承接上述预扫移除阶段；Q2/Q3 已按[投影复用施工计划](2026-10-27-q2-q3-projection-implementation-plan.md)实现并接收，正式配对、v4 完整工程门禁及正常 6 个浏览器周期均完成。整体 max 与新鲜度目标未达，浏览器 p95 未验；最终证据与未证项见[本轮验收](../validation/2026-10-27-q2-q3-projection/README.md)，上述旧阶段结果不替代本轮结果。

1. **Q2：事实依赖与投影失效。已实现并接收。** 静态用量与 perf 分键；已证明的 no-op / ledger-only 写入可保留 usage/timeline，其它事实变更仍使相应投影失效。静止/ledger-only 各 20 对全部更快，配对合计节省中位数分别为 **801/875 ms**；完整摘要与来源指纹相等，TPS/perf 独立更新。依赖与保护边界见本轮施工计划及验收。
2. **Q3：已发布临时 reader 的投影归属。已实现并接收。** 捕获已有暖槽，在真实 reader 固定快照后核对来源守卫，仅转交静态用量投影，perf 由 reader 重读，不共享 quoteInputs。真实 executor **20/20 更快、20/20 接收**，配对合计节省中位数 **1,492 ms**；与 Q2 属于不同场景，收益不相加。实际冷档仍未证，保护窗口、生命周期和冷回退边界见本轮施工计划及验收。
3. **N2：持续 mutable rollout 的线性前缀证明。先分解，再决定范围。** 普通追加 20 对近中性，10 对更快，配对节省中位数 **−9.82 ms**；after 同步/变更后查询中位数约 **8.56/4.31 s**，perf 中位数约 **1.15 s**。后续性能实验已按用户要求暂停；若重新启动，先分解 raw SHA/前缀证明、同步发布、变更后查询及 perf 的实际成本；只有证据仍表明前缀读取为主，才决定可验证文件代际或持久分块的 N2 范围。完整 raw SHA 与 before/after/发布复核继续保留；新增格式、平台恢复、旧前缀改写及并发追加须另定范围，不自动纳入简单缓存优化。

本轮 v4 全仓串行完整运行 **3,397 tests / 3,372 pass / 0 fail / 25 skip**，typecheck/lint/format:check 均退出 0。默认 today/month 各 3 对，metadata 与 period 缓存对象身份全部保留；不以 skip-check 暖读代替默认刷新验证。

最终正常浏览器采用 Codex 普通追加、ledger-only 各 **3 个真实 60 s 周期，共 6 次**，均已完成，数值/TPS 正确、`errors=[]`、关闭后 `WAL=0`。检查→目标帧只报范围与中位数：Codex **8,654–8,935 ms，中位数 8,685 ms**；ledger TPS **4,501–4,546 ms，中位数 4,502 ms**；浏览器 p95 未验。

最不利相位各一次观测单列：Codex 写入→目标帧 **72,307 ms**，超出新鲜度预算 **7,308 ms**；ledger 写入→TPS 帧 **65,046 ms**，超出 **46 ms**。两次观测数值正确，整体 max 与新鲜度目标仍未达；单次观测不外推尾部分布，不混入正常周期，旧阶段分布不替代本轮结果。

Q2/Q3 继续沿用 §7–9 的文件单写与唯一执行槽，资源预算为 **7 GiB 重 Job + 1 GiB 控制侧 ≤8 GiB**。已记录最高 Job 峰值为 v3 全仓 **2.31 GiB**；v4 全仓 **2.11 GiB**，最终浏览器 **1.71 GiB**。控制侧留 1 GiB，未连续采样全设备物理 RAM。

**Main 已完成最终 SHA 核验与清理。** 最终 **1,633 输入（4,229,909,674 bytes）及 98 产品模块 SHA 全等**；7 个本轮测试 DB 及其 WAL/SHM 已精确清理，WAL 为 0 或不存在，无残留任务进程。按用户新指令提交并推送本轮代码、计划与必要验收成果，原始产物留本地，后续性能实验暂停；未切生产，不更改轮询频率。

