# B 报告：来源消失保留与 events 修订证据

日期：2026-10-22。状态：**B0.1–B0.3、WAL pragma、B1a、B1b-E2、B1b-S-E、B1b-S-Q、B1c-E、B1-badline-warning 已复核；B1b-P、B1b-Q、B1b-C-P、B1d-growth、B1-truncation-oracle、B1-truncation-diagnostic、B1-truncation-persist、B1-badline-oracle、B1-badline-persist、B-retention-schema21-contract、B1-timing-audit、B1-workbuddy-evidence、B0.4-summary、I1-aggregate-UTC、I1-summary-UTC、I1-aggregate-local、I1-sync-UTC、I1-sync-local、I1-zone-reopen、B3-schema、B3-register-metadata、B3-read-segment、B3-read-snapshot、B3-union-oracle、B3-union-read、B3-union-cold-snapshot、B3-union-multisegment、B3-cold-authority-read、B3-cold-report-carrier、B3-cold-period、B3-period-authority-snapshot、B-cold-summary、B-cold-summary-records、B-cold-perf-capture、B-rollup-complete-events-seam（已实现并通过定向测试，待主审复核）、B-store-cold-rollup-day 已主审接受（独立 1/1，256.2822ms）、B-cold-rollup-writer-lock 已主审接受（独立 1/1，274.634ms）、B-rollup-multi-UTC 已主审接受（独立 1/1，249.3156ms）、B-store-full-UTC-rebuild 已主审接受（独立专用 3/3，609.9902ms）、B-rollup-complete-local-seam 已主审接受（独立 1/1，336.0237ms）、B-store-full-dual-zone 已主审接受（独立专用 4/4，824.102ms）、B-executor-history-rebuild 已主审接受（独立宿主 1/1，242.9082ms；sandbox 硬链接 EPERM 不计行为失败）、B-cold-rollup-sync-regression 红测已主审接受（独立宿主 0/1，197.2907ms；runner 272.1878ms）、B-cold-rollup-sync-fix 已主审接受（独立宿主 5/5，890.391ms）、B-cold-rollup-sync-local-rollback 已主审接受（独立宿主 1/1，314.4768ms；runner 392.1617ms）、B-cold-rollup-sync-zone-change 主审独立红测 0/1（330.5093ms；runner 384.4682ms）后已按 marker 契约返修并通过定向测试（1/1，334.7515ms；runner 385.9652ms），主审复核 1/1（332.3266ms；runner 385.4557ms），已接受、B-cold-prefix-revision-red 主审已接受（独立宿主 0/1，191.7172ms；runner 266.6594ms）、B-cold-revision-overlay-read 首轮 2/2（143.2875ms / 111.5249ms；runner 331.4101ms）；trust-boundary 返修红测 0/1（136.1249ms；runner 213.6268ms）、修复后 3/3（151.9709ms / 105.6082ms / 106.4779ms；runner 440.5796ms），待主审复核、B-cold-prefix-revision-write 已实现并通过定向测试，待主审复核、B-cold-prefix-revision-rollback 已主审独立接受（宿主专用 1/1，323.8271ms；runner 400.5888ms）、B-cold-prefix-late-add 已主审接受（独立宿主 2/2，427.8352ms；红测 0/1，154.6017ms；runner 230.699ms）、B-cold-revision-bundle-transfer 已主审接受（独立宿主 1/1，483.4578ms；runner 558.7514ms）、B-cold-prefix-removal-red 已主审接受（独立 0/1，186.9145ms；runner 257.7693ms）、B-cold-prefix-removal-write 已主审接受（独立专用 4/4，463.4824ms；返修前 forced-reparse 红测 0/1，263.0951ms；runner 340.9868ms）、B-cold-removal-rollback 已实现并通过定向测试（专用 3/3，591.9342ms；相邻 cold-prefix 5/5，1317.1345ms），待主审复核、B-cold-perf-eviction-red 已主审接受（独立 0/1，250.6412ms；runner 321.538ms）、B-cold-perf-read 已实现并通过定向测试（专用 1/1，190.0742ms；runner 259.8939ms），待主审复核、B-perf-reader-missing-file 已主审接受（独立 reader+source 2/2，243.4958ms；runner 314.7064ms）、B-cold-timing-source-candidate-fidelity 已主审接受（独立 1/1，134.7255ms；runner 207.2459ms）、B-cold-workbuddy-duration-fidelity 已主审接受（独立 1/1，113.7305ms；runner 196.628ms）、B-cold-unplaced-retention 已主审接受（独立 1/1，223.0628ms；两文件 runner 523.7559ms）、B-cold-perf-dependency-closure-red 已主审接受（独立 0/1，176.1064ms；runner 250.4974ms；Missing expected rejection）、B-cold-timing-manifest-red 已主审接受（独立 0/1，170.1274ms；runner 244.6421ms；Missing expected rejection）、B-cold-timing-manifest-write 已主审接受（timing 专用 2/2，190.5367ms / 254.5743ms；相邻 orphan 1/1，143.4912ms；相关 4/4，runner 526.0552ms）、B-workbuddy-observation-manifest-red 已主审接受（独立 0/1，146.6673ms；runner 225.9807ms；Missing expected rejection）、B-zcode-cold-perf-authority-red 已主审接受（独立 0/1，280.0496ms；runner 360ms）、B-zcode-cold-perf-carrier-write 已主审接受（独立 2/2，311.3838ms / 246.3352ms；runner 388.6528ms）、B-perf-authority-guards-red 已主审接受（独立 2/3，pass 174.4857ms / 203.9223ms，missing-event fail 204.2632ms；runner 661.7683ms；Missing expected rejection）、B-perf-authority-fastpath-fix 已主审接受（独立 4/4，219.6142ms / 169.4909ms / 196.312ms / 301.7177ms；runner 662.5349ms）；store 锁已收回冻结、B-cold-perf-overlap-conflict 已主审接受（独立 1/1，279.2963ms；runner 357.6076ms）、B-zcode-perf-multisegment-write 已主审接受（独立 multisegment/guards/conflict/single 共 6/6，runner 700.7185ms；两段 376.7494ms；接受数组捕获/顺序 verified 合并，store 冻结）、B-codex-cold-perf-authority-red 已主审接受（独立 0/1，163.105ms；runner 747.0542ms；HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID）、B-codex-cold-perf-authority-write 已主审接受（独立 Codex/guard/single/conflict 7/7，runner 883.9744ms；multisegment 1/1，307.2048ms）、B-codex-cold-perf-transfer 已实现并通过定向测试（1/1，398.2668ms；runner 476.3018ms），待主审复核、B-period-executor、B-summary-executor（含相邻 period fixture 返修）、B-cold-metadata、B-cold-summary-sync-seam、B-cold-freeze-HTTP-read 已主审接受（独立 1/1，runner 5482.2414ms；旧 server 3/3，runner 5628.4507ms）；B-cold-snapshot-cleanup 的淘汰与正常关闭行为已主审接受，创建后失败证据已用测试本地 `UsageStore.prototype.open` patch 返修，待复核；该卡整体仍不宣称完整验收；B-cold-freeze-pricing 已实现并通过定向 HTTP 验证，待主审复核；B-cold-hot-tail-revision 已实现并通过独立行为测试，待主审复核；B-C2-model-read 已主审接受分支行为（独立 3/3，268.0386ms）；B-C2-public-model-read 已主审接受反例证据（独立 0/1，181.9213ms）；B-C2-clamp-scoped-window 已实现并通过定向测试（公开反例 1/1，原 model 3/3；同文件 20 项：16 pass / 4 skip），模型窗口按 scoped facts 裁切、完全不相交 period 不查 rollup，待主审复核；I-full-events 已主审接受（store + 真实 API 4/4，typecheck 0）；I-full-homes 已主审接受（3/3，291.8967ms）；I-full-sessions 已主审接受（独立 store 4/4；合 API 7 项 6 过 1 配额失败，配额依赖待接线）；I-full-carrier-snapshot 已主审接受（store 5 + API 3，共 8/8）；I-full-quota-snapshot-cache 已实现并通过定向测试，待主审复核、B-perf-timing-revision-read 已主审接受首个 typed 只读能力（定向 1/1，537.7743ms；runner 632.3214ms；主审独立 overlay/conflict/multi/Codex/guards 8/8，runner 1086.2738ms；typecheck exit 0；测试进程禁用 effective guard 时精确 Missing expected rejection，506.1416ms；数值重算与自动 writer 不在本轮范围）；B-codex-late-timing-revision-write 已主审接受（独立 late 含第二 variant / overlay / multi 3/3，748.9862ms；store SHA `aef3ccbe07353c34da92d9f03cb1ff309ab326ba7d5ae43bcd8134585a8f30b5`；接受冷/热重叠迟到 timing 自动 delta 与 capture 输入版本拒绝，不宣称实际 perf 淘汰或完整原子性）、B-codex-evicted-late-timing-red 已主审接受（独立 0/1，398.8111ms；`HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT`；`evictedSampleRevised=false`；candidate 未变）、B-codex-evicted-late-timing-fix 已实现并通过 evicted+late 两个文件（2/2，344.7781ms / 410.7336ms；runner 911.3064ms），待主审复核、B-codex-revision-rollback 已主审接受（独立 1/1，451.1657ms；runner 537.1394ms；精确 metadata SQL trap 计数 1、具名 sentinel、真实 dirty 目标线程、非零 published counters、完整回滚与重试均通过）、B-codex-required-request-facts 已主审接受（独立 3/3，400.2124ms；定向反例 1/1，220.9008ms；红测 0/1 Missing expected rejection）、B-effective-Codex-numeric 已实现并通过定向测试（专用 1/1，351.7962ms；runner 435.8755ms），待主审复核、B15-commit-prepare 已实现并通过专用宿主测试（1/1，108.2968ms；runner 189.5695ms），待主审复核、B15-event-commit 已主审接受（独立宿主 3/3，128.3529ms / 80.6137ms / 91.9972ms；runner 382.7322ms；test SHA-256 4829e68452ccf96d61bc4c8cc8d39ad73e39b73f7351e8b7d170a2ec865b1d6d），proposal/shadow 已冻结、B15-executor-event-commit 已主审接受（shadow db3a8c… 对当前 executor diff，定向 1/1）、B15-ZCode-supported-perf-commit 已实现并通过定向测试（perf 专用 1/1，294.1399ms；相关 8/8，runner 17182.617ms；正式 CLI replay 1/1，10782.9345ms），待主审复核、B15-Codex-supported-perf-commit 已实现并通过定向测试（红测 0/1，253.5338ms；最终 1/1，391.0218ms；runner 469.7011ms；前次 Codex/ZCode 组合回归 2/2，ZCode 313.1382ms；runner 902.4032ms），已冻结待主审复核、B15-cli-explicit-event-commit 首轮已通过定向 archive CLI 3/3（5314.9269ms / 253.5774ms / 300.1209ms；runner 6020.6137ms）；主审发现第二次 CLI replay 缺口，复审红测 1 pass / 1 fail（失败 5409.9903ms；runner 5748.7759ms，HISTORY_ARCHIVE_SOURCE_CHANGED），最小 prepare 接缝返修后专用 2/2（10588.0066ms / 308.5808ms；runner 10974.0386ms）且相邻 7/7（runner 16818.678ms）；主审已独立接受显式 events-only CLI 与 replay（commit-cli+prepare+commit 6/6，runner 11019.7077ms；CLI 含新 backup replay 10656.6108ms；dry-run 1/1，325.5804ms；checkJs 0；5 文件 lint/whitespace 通过），不包含交付 15 的完整 perf 淘汰**；B20-legacy-migration-tests 已主审接受（完整 paired patch 三文件独立 108/108，3449.38ms）、B20-archive-test-isolation 已实现并通过宿主并发/合并定向测试（2/2，585.5046ms），待主审复核；B root narrow promotion / metadata rollup counts 已主审接受（根仓定向 15/15，runner 5523.4718ms；四文件 promotion-time post-image 已核验）；B19-cost-model-count 功能对拍通过（专用 2/2，81.096ms；主审独立 3/3，79.5085ms），但独占 HTTP 100k 配对无性能收益（baseline 1314.6544ms / candidate 1315.4628ms，+0.0615%；99 输入仅 pricing 差异且完整 cost/payload 相等），已拒绝推广并保持根仓 `src/pricing.js` 为 `671f1bc8…`；未重复全仓。本报告覆盖 B0、WAL pragma、B1a、B1b-E2、B1b-S-E、B1b-S-Q、B1b-P、B1b-C-P、B1d-growth、B1-truncation-oracle、B1-truncation-diagnostic、B1-truncation-persist、B1-badline-oracle、B1-badline-warning、B1-badline-persist、B-retention-schema21-contract、B1-timing-audit、B1-workbuddy-evidence、B0.4-summary、I1-aggregate-UTC、I1-summary-UTC、I1-aggregate-local、I1-sync-UTC、I1-sync-local、I1-zone-reopen、B3-schema、B3-register-metadata、B3-read-segment、B3-read-snapshot、B3-union-oracle、B3-union-read、B3-union-cold-snapshot、B3-union-multisegment、B3-cold-authority-read、B3-cold-report-carrier、B3-cold-period、B3-period-authority-snapshot、B-cold-summary、B-cold-summary-records、B-cold-perf-capture、B-rollup-complete-events-seam、B-store-cold-rollup-day、B-cold-rollup-writer-lock、B-rollup-multi-UTC、B-store-full-UTC-rebuild、B-rollup-complete-local-seam、B-store-full-dual-zone、B-executor-history-rebuild、B-cold-rollup-sync-regression、B-cold-rollup-sync-fix、B-cold-rollup-sync-local-rollback、B-cold-rollup-sync-zone-change、B-cold-prefix-revision-red、B-cold-revision-overlay-read、B-cold-prefix-revision-write、B-cold-prefix-revision-rollback、B-cold-prefix-late-add、B-cold-revision-bundle-transfer、B-cold-prefix-removal-red、B-cold-prefix-removal-write、B-cold-removal-rollback、B-cold-perf-eviction-red、B-cold-perf-read、B-perf-reader-missing-file、B-cold-timing-source-candidate-fidelity、B-cold-workbuddy-duration-fidelity、B-cold-unplaced-retention、B-cold-perf-dependency-closure-red、B-cold-timing-manifest-red、B-cold-timing-manifest-write、B-workbuddy-observation-manifest-red、B-zcode-cold-perf-authority-red、B-zcode-cold-perf-carrier-write、B-perf-authority-guards-red、B-perf-authority-fastpath-fix、B-cold-perf-overlap-conflict、B-zcode-perf-multisegment-write、B-codex-cold-perf-authority-red、B-codex-cold-perf-authority-write、B-codex-cold-perf-transfer、B-codex-required-request-facts、B-effective-Codex-numeric、B15-commit-prepare、B15-event-commit、B15-executor-event-commit、B15-ZCode-supported-perf-commit、B15-Codex-supported-perf-commit、B15-cli-explicit-event-commit、B15-cli-replay-prepare、B20-legacy-migration-tests、B20-archive-test-isolation、B root narrow promotion / metadata rollup counts、B-period-executor、B-summary-executor、B-cold-metadata、B-cold-summary-sync-seam、B-cold-freeze-HTTP-read、B-cold-freeze-pricing、B-cold-hot-tail-revision、B-cold-snapshot-cleanup、B-C2-model-read、B-C2-public-model-read、B-C2-clamp-scoped-window、I-full-events、I-full-homes、I-full-sessions、I-full-carrier-snapshot、I-full-quota-snapshot-cache、B-perf-timing-revision-read、B-codex-late-timing-revision-write、B19-cost-model-count、B1c-E 与 B1b-Q，不代表汇总、归档或界面阶段完成。**当前 2026-10-26 追加：dashboard-shared-carrier 根仓测试 1/1 通过，但当前单段不变范围走 trySqlHistoryDashboard（测试 calls=0），不再声称一次共享 carrier；history-backup fingerprint 候选已推广（历史根回归 13/13），当前根仓在其上另有 stream-hash/verified-evidence 改动；B19 cold dashboard summary phase 为 artifact-only，未推广 sessions 候选，待一次 warm phase 归因。**

后续状态（2026-10-23）：B3-cold-cumulative-oracle 已由主审接受为真实来源失败证据；B3-cold-reparse-prefix 在同一完整替换接点完成最窄修复并获接受（宿主独立 2/2，473.0789ms），retention 回归 19/19 通过。B3-cold-published-oracle 随后复用该成功夹具，公开读取当前 0/1（227.5402ms），archive store 16 pass / 1 fail（2311.4387ms），确认同步热读与 period 仍缺冷事实。B3-cold-published-carrier 初版新增异步完整 events 载体，主审指出的 bounds/capture 中间窗口由 **B3-carrier-snapshot** 返修：全历史 bounds、hot rows、registry、authority 和 source 身份现在在同一同步 `SAVEPOINT history_archive_union_read` 捕获，释放后才 await 冷文件校验；独立 GREEN `publishedHistoryUsageEvents matches an unarchived source oracle across cold and hot facts` 与确定性交错 `publishedHistoryUsageEvents captures bounds and hot rows in one snapshot` 均通过，缺段仍拒绝，同步 `publishedUsageEvents()` / `periodComparison()` 的独立红 target 保留。**B3-cold-report-carrier** 再把同一完整历史快照装成 `publishedHistoryUsageReport()`：hot homes 与 quota 和 events/source 身份在同一保存点内捕获，sessions 从同批 events 派生，保存点释放后才读取冷段；完整对象与未归档 oracle 对拍、确定性 home/quota/event 交错和缺段整体拒绝均通过，已由主审接受（独立 3/3，635.9003ms）。**B3-cold-period** 新增显式异步 `periodComparisonHistory()`：无 authority 时委托原同步缓存路径，有 authority 时使用已验证完整 events 并复用 `public/period-comparison.js#summarizePeriodComparison`；UTC/local/exclude 与未归档 oracle 完整深相等，缺段整体拒绝。主审指出 marker 探测与无 authority 首次读取之间的外部提交窗口后，**B3-period-authority-snapshot** 把两步放进同一同步 `SAVEPOINT period_comparison_history_read`：外连接在 marker 后提交 authority 并删除热段时，首次结果仍为旧快照 130；下一次同步热读为 110，完整冷感知读取为 130。22/22 archive tests 通过。**B-cold-summary** 新增显式异步 `summarizeHistory()`：无 authority 时在同一 `SAVEPOINT summary_history_read` 内读取 marker 和原同步热摘要，继续复用原 SQL、缓存和返回形状；有 authority 时取 `publishedHistoryUsageReport()` 的完整事件，按 `excludeHomes` 用既有 `withoutExcludedHomes()` 过滤，再交给共享 `summarizeUsage()`。真实 `100 cold + 30 hot` 的共享 usage 字段与未归档 oracle 深相等，UTC、`excludeHomes`、`includeDetails: false` 均覆盖；缺候选段整体拒绝。`summary.perf` 与 store-only `records` 仍需后继接线，本卡明确保留为待决依赖；完整 archive store 24/24 通过。**B-cold-summary-records** 随后只补普通范围 `records`：从同一批已验证冷热 events 按现有日/周/月槽位和严格新高算法重算冠军，再调用未改动的 `recordsWithinRange()` 做完整期范围判定；真实 8 日、2 home 冷夹具对未归档 `store.summarize().records` 深相等，覆盖无排除 10900、排除后 900、整周 1400 与不完整周不点亮，完整 archive store 25/25 通过；`summary.perf` 与配额窗口 records 仍留后继卡。**B-cold-perf-capture** 再把 perf 状态、全部 hot 候选、unplaced 样本、identity、known/unsupported sources 与 usage carrier 一起放进 `SAVEPOINT history_archive_union_read`；冷段 await 完成后只使用捕获值，并按最终冷热 events 解析出的 range/排除集交给原 `buildPerfStatsBlock()`，不再读取 live perf。真实非空 perf 夹具中 `summary.perf` 与未归档 oracle 深相等，July 12 最终范围只计入范围内样本；第二连接在冷读取期间提交新样本与 index/state 后，第一次结果仍全旧，第二次才全新生效。完整 archive store 27/27 通过。**B-summary-executor** 再把执行器独立 `summarize` 与 dashboard summary 接到 `summarizeHistory()`；dashboard 的 summary/period 共用 `publishedStore || store` 版本，并显式 await 两个异步入口。metadata 仍保持同步热读。真实 `100 cold + 30 hot` 专用测试中两处 summary 均为 130，`perf`、非配额 `records` 与未归档 oracle 深相等；删除候选段后 `summarize` 与 dashboard 都以 `ENOENT` 拒绝。

**B-cold-summary-sync-seam** 再把异步入口在完整 report 返回之后的纯计算尾段抽成同步 `summarizeHistoryReport(report, filters, options)`；`summarizeHistory()` 的行为不变，并以 store 内静态 `withoutExcludedHistoryHomes()` 取代动态导入 server helper，保留 events/sessions/perfSamples 的排除语义而不形成 store→server 依赖环。

**B-cold-freeze-HTTP-read** 把 server 的冻结读取分支接到自包含冷报告：有 `archive_segments` 时先 await `publishedHistoryUsageReport({ includePerfCarrier:true })`，再进入既有 frozen catalog `try/finally`，同步调用 `summarizeHistoryReport()` 与 `summarizePeriodComparison()`；metadata 仍取 `frozen.metadata`，无冷注册继续原同步 summary/period。executor 返回的 `cleanupDirectory` 当时只记入 snapshot 对象，淘汰/失败清理留给下一卡。

**B-cold-freeze-pricing** 只用真实 HTTP 夹具补冻结计价证据，生产文件未改。真实授权 `100 cold + 30 hot` 快照在 catalog A（`checkedAt=2026-10-22`，`gpt-6-sol` 全部 rate 类别上调）下 freeze，summary 总量仍为 130、费用非零且 `priceCheckedAt=A`；live catalog 切到 B（`2026-10-23`、再次上调）后 live summary 使用 B 且金额不同，已冻结 snapshot 的 summary 金额仍与 A 完全相等，snapshot `/api/pricing` 的 `version` 也仍是 A。测试再把 `UsageStore.prototype.summarizeHistoryReport` 临时替换为抛 `INJECTED_COLD_SUMMARY_FAILURE`：snapshot HTTP 返回 500 与该精确错误，server 的 `finally` 仍把全局 catalog 恢复为 live B；恢复方法后 snapshot 仍为 A、live 仍为 B。没有修改 server、pricing 或 store，也没有新增冻结价目实例或并发框架。

**B-cold-hot-tail-revision** 只新增真实行为测试，生产文件未改。测试复用同一 Codex `100 cold + 30 hot` 架构：候选段只覆盖 `02:00` 的 100 事件，显式 authority 后热侧只留 `02:01` 的累计差 30。随后保持 session/turn context 与冷前缀字节完全不变，只把同一热 turn 的累计从 130 修正为 120（`last_token_usage=20`），通过真实 source 重解析与 `sync()` 替换热事实；候选文件 digest 不变。冷热 events、period 与 summary 均与独立未归档 oracle 对拍为 `[100, 20]` / 120，不是旧的 130 或把热侧重复相加得到的 220。被替换的热 30 以 payload 形式进入 `history_replaced_facts` 且 `occurrence_count=1`；强制再次重解析完全相同的热尾后，替换事实集合逐行不变、总量仍为 120。该路径验证现有 cold-prefix 匹配允许热尾下降修订，不实现冷段重放、冷段修改或整阶段重建。

**B-cold-prefix-revision-red** 只新增真实行为测试，生产文件未改。夹具先登记并授权只覆盖 `02:00` 的冷事件 100，再让 `02:01` 的热尾以累计 130 / 增量 30 正常发布，得到冷热历史 `[100, 30]`。随后保持来源路径、session/turn context 与两个 timestamp 不变，把同一来源重写为冷累计 90、热累计 120 / 增量 30，并通过真实 source 重解析与普通 `sync()` 尝试替换。当前 `replaceFile()` 在逐段比较冷前缀多重集后于 `src/usage-store.js:5054` 抛 `HISTORY_ARCHIVE_COLD_REPARSE_CHANGED`，整笔替换回滚，`syncRound()` 按既有文件失败契约把它转成 `无法索引 ... reparsed source no longer matches authorized cold archive segment ...` warning，因此 `sync()` 本身不拒绝。失败后公开冷热历史仍为 `[100, 30]`，候选文件 digest 未变且旧 100 仍可恢复；最终未归档 source oracle 则是 `[90, 30]` / 120。红测在期望 events 深相等处失败（actual cold total 100，expected 90），因此 summary 120 断言尚未执行。这钉住的是“冷前缀修订没有事务性 supersession 语义”，不是热尾下降问题，也不提议新建全历史快照。

**B-cold-revision-overlay-read** 只接一个集中读取接点，生产写入、`sync()` reparse、恢复和备份均未改。既有 `historyArchiveEventUnionForRange()` 的 `SAVEPOINT history_archive_union_read` 现在同时捕获 `store_meta.history_archive_event_revisions`，并在释放保存点前解析成每段 revision 列表；原始段仍先由 `readHistoryArchiveSnapshot()` 验证真实 candidate digest、登记元数据与 source identity，只有显式 authorized 段才调用 delta overlay。overlay 结构固定为 `{formatVersion:1,revisions:[{segmentId,databaseSha256,sourceIdentity,removed,added}]}`，要求 exact keys、正整数份数、段已登记且 digest 匹配、每 segment/source 至多一个绑定、payload 使用 `canonicalFactPayload(row, ["id"])` 的完整 event columns、来源与该绑定一致且 timestamp 位于段半开范围内。主审退回的 trust-boundary 返修按既有 `events` STRICT 列约束补齐 payload 校验：文本列必须是 string，数值列必须是安全整数，`reconciliation_gap` 不额外禁止合法负值；`home_id`/`home_label` 必须与绑定 `sourceIdentity` 相等。source identity 也改为固定五字段逐项比较，不再依赖 JSON key 顺序。应用时先按 payload 多重集扣除 `removed` 并验证原冷事实足份，再追加 `added` 份数，之后才做请求 range 过滤和既有 timestamp/payload 排序；hot rows 不参与扣加，也不回填 cold。无 overlay 继续原路径。真实夹具手工事务提交 100→90 单 source delta 后，完整 `publishedHistoryUsageEvents()` 与范围 `mergeHistoryArchiveEventsForRange()` 都读出 `[90, 30]` / 120，hot `events` 仍只有 30，原 candidate digest 不变；不可足份扣除和错误 source binding 均以 `HISTORY_ARCHIVE_REVISION_INVALID` 拒绝。返修先用 `total:null` 与跨 home 两个真实读反例钉红（0/1，136.1249ms；runner 213.6268ms），修复后两者均在返回部分结果前拒绝，字段顺序不同的同值 source identity 仍正常得到 `[90, 30]`，完整 overlay 套件 3/3 通过。该测试只证明读语义，不表示 source 修订 writer 已实现。

**B-cold-prefix-revision-write** 在同一真实 `100 cold + 30 hot` 夹具上接上修订 writer。`historyArchiveReparsePrefixes()` 现在为每个授权冷段保留 immutable `originalRows`、应用既有 overlay 后的 `effectiveRows`，以及本轮真实重解析得到的 `observedRows`；`replaceFile()` 只在同一 `BEGIN IMMEDIATE` 内、所有冷行解析完成后，要求三者在同一 `(timestamp_ms, session_id)` 上保持一一对应，再以 immutable candidate 为基线生成本轮累计 `removed/added`。同一 `(segmentId, path)` 只更新一个 revision entry，不追加链条；第二次修订 `90→80` 会原地改成相对 100 的 `100→80`，而不是叠加成 `90→80`。被覆盖的 effective `90` 通过既有 `saveMissingHistoryFacts()` 写入 `history_replaced_facts`，immutable candidate 中的 `100` 继续由候选包保留。实测第一次真实 `sync()` 后公开历史与 summary 为 `[90, 30]` / 120，第二次真实 `sync()` 后为 `[80, 30]` / 110；hot `events` 仍只有 `[30]`，candidate digest 不变，no-op 重解析不重写 revision 或恢复事实。成功修订只把变化的 UTC 日加入既有 dirty 队列并失效覆盖该 timestamp 的 UTC/local day marker，轮末仍由现有完整冷热 union 重建两侧 rollup；无 schema、authority、API 或第二套聚合算法变化。

**B-cold-prefix-revision-rollback** 只扩展同一真实夹具，生产文件未改。测试先停在已接受的 `cold 90 + hot 30 = 120`，快照 immutable candidate digest、revision metadata 原始 JSON、hot `events`、`history_replaced_facts`、dirty days、三张 aggregate 表、公开冷热 union 与 `summarizeHistory()` 用量结果。随后安装仅测试期存在的 `BEFORE UPDATE OF value ON store_meta` trigger；当 writer 在已经删除/重插 hot 50、暂存被替代冷 90 并更新 metadata 时，以 `INJECTED_COLD_REVISION_META_FAILURE` 中止。`sync()` 按既有文件失败契约返回 `无法索引 <path>: INJECTED_COLD_REVISION_META_FAILURE`，marker 恰好出现一次；删除 trigger 前后所有快照逐项不变，hot 仍为 `[30]`、恢复事实仍为空、三张 aggregate 表与 dirty 队列不变、公开 union 仍为 `[90, 30]`、summary 仍为 120，candidate digest 与 revision 字节也相同。失败事务把 `source_files` 的失效指纹恢复为 `size/mtime=-1` 而磁盘已是新内容，因此删除 trigger 后无需再次手工 invalidate，下一次普通 `sync()` 必然重试：revision 从 `100→90` 改为 `100→80`，hot 变为 `[50]`，公开 union 为 `[80, 50]`、summary 与 UTC/local rollup 都为 130 并与未归档 oracle 相等；`history_replaced_facts` 各保留一次被替代冷 90 与旧热 30，immutable candidate digest 仍不变。没有生产测试 hook、schema、API 或事务框架变化。

**B-cold-prefix-late-add** 只改 `historyArchiveColdRevisionForRows()` 的身份集合门禁和 changed-row 收集。immutable 身份必须完整存在于当前 effective，effective 身份必须完整存在于 observed；因此 observed 可以严格超集，纯新增冷事件被接受，而旧身份缺失、删除/迁移仍以 `HISTORY_ARCHIVE_COLD_REPARSE_CHANGED` 拒绝，重复 `(timestamp_ms, session_id)` 继续由原 map 校验拒绝。delta 仍以 immutable candidate 对 observed 计算；新增身份进入 changedRows，但没有 effective row 时从 previousRows 过滤，避免 undefined 进入 rollup 日期维护。真实夹具保持原 cold `02:00=100`、hot `02:01=150/last30`（baseline 130），在授权段内追加 `02:00:30=120/last20` 并普通 reparse：revision 只有 `added:[20×1]`、`removed:[]`；public facts 与未归档 oracle 逐列相等为 `100/20/30=150`，hot 仍仅 30，immutable candidate 仍 `[100]` 且 digest 不变，新身份不写 `history_replaced_facts`，UTC/local `usage_rollup_daily` 均为 3 events/150。既有 100→90 值修订测试同批 2/2 通过。

**B-cold-snapshot-cleanup** 补全 server 自己的快照生命周期：淘汰和创建失败都先 `store.close()`，再删除该 id 的 `.sqlite`、`-wal`、`-shm` 与由主库路径推导出的 `.segments` 目录；executor 返回的 `cleanupDirectory` 字符串不作为删除路径。创建只有在校验 metadata/import 全部成功后才进入 `snapshots`，失败不会淘汰任何有效旧快照。server close 仍清理整个私有 `snapshotDirectory`，并让现有 `server.close()`/callback 契约等待该删除完成，因此冷段侧车也一并移除。

后续状态（2026-10-26）：`dashboard-shared-carrier` 已把 event-authority 冷 dashboard 接到 `dashboardHistory`；当前根仓的单段不变范围先走 `trySqlHistoryDashboard`，专用测试对 `historyArchiveEventUnionForRange` 记录 `calls=0`，因此不能把当前路径描述成一次共享 carrier。只有 SQL 快路返回 `null`（不满足快路条件或并发身份校验要求）时才回退到完整 carrier；只存在 perf authority 时仍走原 summary/metadata/period 三入口。根仓已包含省略 `filters.now` 的默认时点修复（`filters.now ?? new Date()`），真实专用测试 `1/1`（387.1639ms；runner 5568.2713ms）通过；`review-functional.json` 的 `combinedColdReads=1` 是早于该 SQL 快路的旧 artifact，不能作为当前根仓共享 carrier 证据。100k 单次配对为 baseline 20218.3226ms / candidate 16136.334ms，RSS 1054306304 / 1047072768 bytes，但两侧 catalog 不同，不能据此作同 catalog 因果加速或 SLA 声明；measured source 为 `9A3DC093…`，早于当前根仓 `4DE01334…` 的 omitted-now 修复。backup fingerprint 的 sealed candidate 为 `EE40EAFA…`，已由 Main 推广到当时的根仓并完成历史 13/13 回归 5467.9969ms；当前根仓 `src/history-backup.js` 已变为 `4D56EDBB…`，在其上另有 stream-hash/verified-evidence 改动，本次未重测或重跑性能。B19 cold dashboard summary phase 只交付 `phase-hook.patch` 与未测 `sessions-key-candidate.patch`（artifact `0A014BFB…` / `BB3C594F…` / `37FE4771…`），尚未推广；现有 10k warm cold 请求为 338.77/294.47/306.21ms，已记录 verification trace 仅约 80ms，仍有约 220–260ms 未归因，需先做一次 warm `skipCheck=1` 六阶段 trace。详见下方审查段。

## 结论

B0 解决的是：**已经成功发布过的来源，在后续发现轮次中消失时，不删除其最后成功历史及依赖归属，只登记当前缺失状态**。缺失不再被当成整轮读取失败，也不阻止其他来源继续刷新。

B1b-E 先解决了 `replaceFile` 的 **events 单接点**：捕获旧 source 身份和旧 events，只把被删除或修改的旧 payload 写入 `history_replaced_facts`。但它只证明“某摘要存在”，旧同内容 2 条缩成 1 条时会被 Set 全部视为命中，无法证明丢失了一份；旧重复 2 条全部消失时也只保存了一行，未记录原有份数。

B1b-E2 把比较改为 **payload 多重集**，并用单个 `occurrence_count` 列保存 `max(旧份数−新份数, 已有份数)`。一次重解析丢失的重复份数可还原为 N 份相同 payload；重复重解析或相同旧值再次出现不会让计数无限增长。普通追加仍不保存未变事实。当时 quota、`perf_samples`、sibling events 和 Codex 线程级修订仍未保全；其中当前路径 quota 已由后续 B1b-Q 补齐。

B1c-E 只补事务故障行为，不改 store：在临时测试库给 `history_replaced_facts` 加 `AFTER INSERT` 触发器，让真实 SQLite 错误发生在恢复行写入之后、`replaceFile` 提交之前。失败轮后旧 live events、旧 `source_files` 身份和恢复表全部保持替换前状态；移除触发器再次 sync，新 20 与旧 10 证据一次提交。没有加入 test-only 生产钩子。

B1b-Q 复用同一份 payload 多重集差集，只保全 **`replaceFile` 当前路径**的 `rate_limit_observations`：删除旧 quota 投影前捕获本路径旧行，新解析后只保存消失或修改的旧 payload。`fact_table` 为 `rate_limit_observations`，方法版本显式为 `rate_limit_observations.v1`；payload 保留 SQLite `NULL` 与来源事件真实的 `observed_at_ms`。未变追加不写新证据，schema 不升版。

B1b-S-E 在同一 `BEGIN IMMEDIATE` 内、删除 sibling 投影前捕获旧 sibling `source_files` 的完整身份和全部 events；新表示解析完成后，用同一 `saveMissingHistoryFacts()` 把这些旧 events 落到旧 sibling 身份下。当前压缩表示继续作为 live 数据，旧 plain 表示不再 live，但 live event 总数不变。

B1b-S-Q 在相同事务和相同接点、删除 sibling 投影前捕获旧 sibling `rate_limit_observations`，解析完成后按旧 sibling 的完整身份持久化。payload 保留完整旧行，包括 `source_path`、`limit_name` / `plan_type` / `used_percent` 的 `NULL` 与真实 `observed_at_ms`；旧 plain 路径 live quota 归零，当前压缩路径保留一套新行，总 live quota 数不变。schema 不升版，sibling perf 不在本卡范围内。

B1b-P 只覆盖非 Codex `replaceFile`：在删除 `perf_samples` 前捕获本路径旧样本，并通过 join 捕获这些样本的全部 `perf_sample_sources` 依赖；重解析后复用 `saveMissingHistoryFacts()`，分别以 `perf_samples`、`perf_sample_sources` 写入。样本 payload 是完整旧行，保留 `NULL`、`diagnostic_reason_chain`、`sample_key` 和每行 `method_version`；恢复行的来源上下文取自 upsert 前的旧 `source_files` 行。未变样本不产生新样本证据；级联删除后未回归的依赖按缺失差集保存。不触 Codex 线程发布或 request timing，schema 不升版。

B1b-C-P 只覆盖 Codex 线程发布：在既有发布 `BEGIN IMMEDIATE` 内、删除 `replaceOldThreadIds` 的旧样本前，按旧 `sample_key` 捕获完整旧样本与全部依赖，并按各自的 `source_path` 分组；发布/合并完成后，分别对 `perf_samples` 与 `perf_sample_sources` 复用 `saveMissingHistoryFacts()`。历史行来源身份取删除前仍存在的旧 `source_files` 行，payload 保留完整旧行；相同样本键的修改、真实消失和依赖角色变化会留下旧事实，未变样本或依赖不写新行。新 turn 的 merge 路径不删除旧键，因此不产生样本替换证据。不触 request timing，schema 不升版。

B1d-growth 只补普通追加的增长断言，不改 store：先用同长度但不同 total 的一次 project-log 重写制造 1 行旧 payload 基线，再对同一文件逐次追加 100 个唯一事件并每次真实 `sync()`。每轮要求更新文件数 1、live event 数按轮次从 1 增到 101；恢复表行数始终为 1，`occurrence_count` 总数始终为 1，payload 字节总量始终等于基线。测试没有引入 benchmark 框架、长历史清理策略或全仓回归。

B1-truncation-oracle 先用一次真实 `sync({ options: { ...options, force: true } })` 把 project-log 从 2 条事件截断为 1 条，不篡改 `source_files.size/mtime_ms`。主审已独立复现旧 total 20 payload 重开仍在、但 `perfState: "ready"` 且 `warnings: []`，接受该缺陷证据。B1-truncation-diagnostic 随后只对同一稳定 project-log 路径增加诊断：旧 `source_files.kind` 与当前 `source.kind` 均为 `project-log`、新文件 `size` 小于旧 `source_files.size`、且解析后 live events 行数减少时，生成既有字符串 `warnings`；不按 total 下降或普通合法重解析判错。warning 随 `replaceFile` 返回值只在 `COMMIT` 成功后由调用点发布，事务回滚不会留下“已接受截断”的告警；旧 events 与 `history_replaced_facts` 仍由同一替换事务保全。没有 schema、冻结告警码域或其他 parser 改动，也不强求 perf `degraded`。

B1-truncation-persist 只补这条诊断的跨轮存活：复用既有 `perf_file_warnings` sidecar，不新 schema、不扩冻结的 `PERF_SOURCE_WARNING_CODES`。成功替换时把 `{sourceKind: "project-log", homeId, code: "PROJECT_LOG_TRUNCATED", count}` 与 events、恢复事实写在同一事务；失败/回滚不会发布 marker。普通 project-log 重解析保留已有 marker，`syncRound()` 每轮从已提交 sidecar 重建稳定的人类可读 warning，因此 no-op 与关闭重开后再做 no-op 都看到同一条 warning。该码不进入 perf 的 `sourceWarnings` 聚合，`perfState` 保持 `ready`；测试还验证截断后追加一条普通事件不会清除 marker，也不会让恢复事实增长。

B1-badline-oracle 先用真实 `force` 重解析证明：稳定非法 JSONL 行被静默跳过时，合法首条仍在 live events，旧第二条 payload 进入 `history_replaced_facts` 且重开仍在，但 `perfState=ready` 且 `warnings=[]`。B1-badline-warning 只在 project-log 的 `readJsonlRows()` 接点接入回调：跳过坏行时发布包含来源路径与行号、但不含该行内容的当前轮 warning。store 在 `replaceFile()` 内暂存 project-log warning，仅在替换事务成功 `COMMIT` 后交给 `syncRound()`；回滚或读取期间变化不发布。其他 JSONL reader 不传回调，仍保持原静默跳过；`.jsonl.zst` 仍抛原有 `Invalid compressed rollout JSON at line N`。B1-badline-persist 复用同一 `perf_file_warnings` sidecar，把成功解析的坏行位置写成结构化 marker：`code: "PROJECT_LOG_MALFORMED_JSONL"`、`count`、排序去重后的 `lineNumbers`；行号来自 parser 在同一解析回调中传入的第二参数，不解析中文 warning 文本。`syncRound()` 从已提交 marker 重建与当前轮完全一致的人类可读消息，因此 no-op 与重开 no-op 仍可见。后续成功解析全合法文件会移除该 marker，但独立保留 `PROJECT_LOG_TRUNCATED`；失败/回滚不写 marker。没有新 schema、没有第二遍扫描，`perfState` 仍可保持 `ready`。

B-retention-schema21-contract 只校正 retention 测试文件内两条过时的 schema 20 固定断言，不改 store：`Codex partial and whole-home loss retains history, dependency ownership, and a stable version` 的新库检查，以及 `Reparse stores one recoverable old event fact for an old10-to-new20 replacement` 的模拟 v19 重开检查，都从期望 20 改为当前精确版本 21。后一项同时保留 `history_replaced_facts` 的 12 列断言，并补 `archive_segments` 的 7 列断言；没有放宽为版本范围、动态常量或跳过。

B20-legacy-migration-tests 只校正三份既有测试里把当前 `STORE_SCHEMA_VERSION` 写成 19 的过期期望：`perf-projection-store.test.js`、`perf-store.test.js` 与 `workbuddy-store.test.js` 的当前版本断言及直接误导的 v15/v19 标题，统一为当前精确版本 21；v11/v13/v16 fixture、事实、事务、幂等和失败回滚 oracle 均保留。首次两份文件定向运行 81 项中 70 pass / 11 fail，失败均为 `21 !== 19`；补齐第三份后宿主合计 108/108，3449.38ms，主审已接受。未改 `src`、未放宽动态版本或跳过测试，未重复全仓。

B20-archive-test-isolation 只修两例全仓并发误报。第二次全仓 trace 显示 `candidate creation…` 的 `newWorkDirectories` 为 `[ 'codex-usage-archive-lHhVba' ]`，`complete archive bundle…` 为 `[ 'codex-usage-archive-mcCRhG', 'codex-usage-archive-Nsp8ys' ]`；两项在宿主单独运行均通过。根因是测试在全局 `os.tmpdir()` 上对所有 `codex-usage-archive-*` 做前后 census，会看到其他 test 文件子进程的合法工作目录，不是候选/正式 bundle 泄漏或产品回归。修复只在这两例内创建 `root/product-temp`，临时设置 `TMPDIR`/`TMP`/`TEMP`，使产品 `mkdtemp` 与 census 都限定在本例子目录，`finally` 精确恢复原值。未删除目标不存在、`sourceState` 不变、正式 bundle 事实或自有临时目录清理断言。宿主并发分跑各 `1/1`，合并 `2/2`（585.5046ms）；Biome 与 paired patch 的 whitespace/apply-check 通过，`src` 未改，未重跑全仓。

B1-timing-audit 先检查 request timing 的持久化，再决定是否增加恢复账本：证据表和线程链接表本身是 append-only。证据主键包含观测的 `variant_key`，同键冲突只 `DO NOTHING`；不同观测会保留为新的 variant。线程链接同键也只 `DO NOTHING`，已有链接指向另一线程时直接抛 `REQUEST_TIMING_THREAD_CONFLICT`，没有覆盖旧链接的 SQL。import 只在 `perf_request_timing_meta` 推进 revision，失败由外层 `BEGIN IMMEDIATE` 整体回滚。Codex 发布成功时删除的只是 `perf_request_timing_dirty_threads` 重建标记，不删除 evidence 或 link。因此没有新增 `history_replaced_facts` 重复账本，也没有改 schema；只补了一条真实重解析测试。

B1-workbuddy-evidence 检查 WorkBuddy 时长观察的写入与清理：当前数据只写 v19 的 `workbuddy_generation_duration_observations`，主键是 `(home_id, message_id, duration_ms)`，入口使用 `INSERT OR IGNORE`。异值会新增一行，同值重复幂等；代码没有对 observation 的 UPDATE 或 DELETE。旧的 `workbuddy_generation_durations` 仅作为无 home 信息的历史兼容层，当前读路径在 observation 为空时才兜底，代码中没有新的写入或清理。真实 trace 重解析只追加新观察并更新内存指纹；旧 duration 仍可读，只是 `lookupGenerationDuration()` 在观察到多种时长时返回 `null`，因此 `perf_samples` 是可重建投影，会暂时消失，不能据此推断原始观察丢失。本卡没有修改 store/schema。

B0.4-summary 只把已存在的 `perfState().missingSources` 接成 `summary.perf.missingSources`，直接复用其原始来源身份形状，不把 `kind` 改写为 perf 规范来源。该字段只按本次 `scopeExclusions` 排除 home，不按事件日期过滤；来源可用性不是事件范围的一部分。`ready`、`degraded`、`rankedHomeIds`、分组、覆盖率和其他统计均未改变。内存汇总路径与 types 留给后续 owner，不在本卡改动。

I1-aggregate-UTC 只在 `UsageStore#aggregateRange` 对显式 `calendarZone === "utc"`、起止都落在整日边界、且非配额的范围优先查询现有 rollup。`ROLLUP_DAYS_MISSING` 回退原 events SQL；其他 SQLite/读取错误原样抛出。查询路径不建表、不重建、不启动 sync 或迁移；local、部分日、无界和配额范围继续走原 SQL。

B-C2-model-read 只把 `periodAggregate()` 的精确模型维度分支 `groupColumn === "model" && nameColumn === "model" && !includeKind` 接到已接受的 `queryUsageRollupModelsWindow()`。每个原始闭区间 `end` 在安全整数校验后转换为半开 `end + 1`；无界边界由同一保存点内按 `excludeHomes` 过滤的 `MIN/MAX(timestamp_ms)` 补齐。范围边界查询、按周期读取和源集模型补齐都在 `period_model_rollup` 保存点内；普通模型、仓库、`includeKind` 和原 SQL 形状不变。源集模型补齐只发生在 `all` 窗口没有覆盖已知来源范围时，确保模型即使不属于任何请求周期也保留为零值。只捕获 `ROLLUP_DAYS_MISSING` 回退原模型 SQL，其他 SQLite/读取错误原样抛出；没有新增缓存、schema 或冷段授权。

B-C2-public-model-read 只增加测试侧的公开入口反例，不改 `src/usage-store.js` 或 `src/usage-rollups.js`。测试用真实 `sync()` 写入两个 home 的 2026-07-12 至 2026-07-14 模型事件，再直接调用公开 `store.periodComparison({ now: "2026-07-15T12:00:00.000Z", calendarZone: "utc" })`。期望值由同一真实 store 删除全部 `usage_rollup_days` 标记后调用原 SQL 路径产生，随后恢复标记与缓存；完整输出和 `excludeHomes` 输出均已深度相等，模型排序也正确。修复前公开入口没有证明模型缓存读取：`today` 窗口为 2026-07-15 的完整空日，而 rollup marker 只为有事件或曾维护的日建立，07-15 没有 marker；`queryUsageRollupModelsWindow()` 因此抛 `ROLLUP_DAYS_MISSING`，精确模型分支回退到原 `events` SQL。实际 guard 计数为 `rollupDayChecks: 1`、`rollupModelQueries: 0`、`periodAggregateQueries: 2`、`modelPeriodAggregateQueries: 1`，修复前该用例保持失败，作为后继必须修复的空日 marker/窗口接入反例。

B-C2-clamp-scoped-window 只修 `periodAggregate()` 的精确模型接点。在已捕获的 scoped `events` 边界 `[minimum, maximum + 1)` 内，每个 period 先保留原有 inclusive `end` →半开 `end + 1` 转换，再把逻辑窗口与事实边界求交；交集为空时该 period 不调用 `queryUsageRollupModelsWindow()`，模型仍由来源全集或其他 period 初始化并输出 16 个零字段。部分重叠的 period 只把裁剪后的半开窗口送入 rollup 查询，因此事实范围外的空日不再要求 marker；事实范围内完整日仍要求 marker，缺失时仍只捕获 `ROLLUP_DAYS_MISSING` 回退原 SQL，其他错误原样传播。原始 `ranges` 仍用于 `periodComparison()` 的窗口输出，排序、`excludeHomes` 和返回形状不变；没有补空 marker、schema、缓存或冷段合并。

I1-summary-UTC 用 `prepare` guard 验证真实 `store.summarize()` 在完整 UTC 自定义日和 `excludeHomes` 场景都选中 rollup；完整 summary（含逐事件 cost/timeline）与标记失效后的 SQL 路径深度相等。`previousUsageRange()` 不带 `calendarZone`，比较期仍走 SQL。I1-aggregate-local 在同一接点接受显式 local 完整日：仅接受本地午夜起点及下一本地午夜前 1ms 终点，不按固定 86400000 判断；纽约 23h/25h 日选路及 summary 对拍通过，边界前后 1ms 仍走 SQL。

I1-sync-UTC / I1-sync-local 把 rollup 生命周期接进真实同步：每轮 `syncRound()` 在打开库并检出外部提交后先调用 `createUsageRollups()`，安装 dirty 触发器并在首次创建时由 C 模块一次性种入现有 UTC 日；等来源扫描、`replaceFile`、发布事务和既有 C5 派生缓存失效完成后，先读取并保存 dirty UTC 日，再在同一个外层 savepoint 内重建 UTC 日，并用 `localUsageRollupDaysForUtcDays()` 保守重建对应的 local 日。任一列表或重建错误都不捕获、不改写既有同步/发布异常；外层回滚会恢复 UTC dirty 队列和两侧缓存，避免半维护。缓存在维护前已定向失效，因此失败不会让后续读取命中旧缓存。首轮新增事件、跨日移动、local 日投影、故障回滚和 no-op 均由真实 `sync()` 覆盖。

I1-zone-reopen 解决“进程时区变了但 dirty UTC 队列为空”时旧 local marker 永远失效的问题。`syncRound()` 轮末读取 `store_meta.usage_rollup_local_zone_identity`，身份取自 `Intl.DateTimeFormat().resolvedOptions().timeZone`（缺失时才退回当前 offset），不使用 `process.env.TZ`。身份变化时，只在这次维护中查询一次 `events` 的 DISTINCT UTC 日，并合并现有 local marker 的 day key；再由当前 local 时区投影出需重建的 local 日。dirty UTC 非空时仍照常重建 UTC；dirty 为空时不做任何 UTC 重建。local 重建、UTC 重建（如有）和身份写入共用同一个外层 savepoint，身份在 local 成功后才写，失败会回滚身份、两侧 rollup 与 dirty，下一次 no-op 可重试。

B3-schema 只做 schema 20→21 的持久目录预留：`STORE_SCHEMA_VERSION = 21`，迁移事务内创建空的 `archive_segments`，并自检冻结列、`STRICT` 与两个 `CHECK`。本卡不登记任何段、不删除 live facts、不读取冷段，也不提供恢复 API；空表不代表已有权威归档。迁移只新增空表，现有 events、`history_replaced_facts` 和其他 facts 不重写。

B3-register-metadata 新增 `UsageStore#registerHistoryArchiveCandidate(candidateFile[, manifestFile])`。方法通过动态导入复用现有 `verifyHistoryArchiveCandidate()` 与 `assertHistoryArchiveSourceMatches()`，先完整验证候选包，再在短的 `BEGIN IMMEDIATE` 内核对源 events 与参与源身份集合，最后才写 `archive_segments`。登记身份取包内 `database.sha256`，保存绝对候选路径、半开区间、events 行数和首次登记时间；相同 digest 重登记幂等，不同 digest 的半开区间重叠明确拒绝。登记不删除任何热事实，`archive_segments` 也不参与用量、性能或汇总 SQL。

B3-read-segment 新增 `UsageStore#readHistoryArchiveEvents(segmentId)`，只按已登记 `segmentId` 读取一个候选段。未知 id 抛 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND`；读取前复用 `verifyHistoryArchiveCandidate()`，并要求包 `database.sha256`、起止边界和 events 行数与 `archive_segments` 完全一致，否则抛 `HISTORY_ARCHIVE_SEGMENT_MISMATCH`。验证通过后用 `DatabaseSync(..., { readOnly: true })` 打开段，返回 `SELECT * FROM events ORDER BY id` 的完整原始行并在 `finally` 关闭。该接缝不查询热表、不合并冷热、不登记/重建/删除，也不接入范围查询或统计。

B3-read-snapshot 只收紧单段读取中 verify 之后到首次查询之间的已接受窗口：只读连接打开后先 `BEGIN`，在同一连接/事务内复用 `assertHistoryArchiveSourceMatches()` 核对候选 events 与 source 身份完整摘要，成功后才执行返回查询，`finally` 中 `ROLLBACK` 并关闭。断言是快照内首次读取：verify 之后、快照建立之前发生的同数量改写会进入快照并被拒绝；快照建立后另一连接提交的改写不会混入本次返回。仍不合并热冷、不做范围查询、不登记/重建/删除。

B3-union-oracle 只定义下一张卡的合并契约，不实现生产合并。拟议接缝为 `UsageStore#mergeHistoryArchiveEventsForRange({ startMs, endMs })`：输入和输出都是原始 event rows，不经过 `publishedUsageEvents()`。同一事实按排除 `id` 后按列名排序的完整事件 payload 规范化为多重集键；同一 payload 在热侧出现 H 次、冷侧出现 C 次时合并保留 `max(H, C)` 份，而不是相加或改为 `Set`，因此同内容 1+1 得 1、2+2 得 2。热冷修订冲突不采用 last-write-wins：进入权威切换前，候选段的事件/来源完整摘要必须与热范围一致，任何行数或值差异继续由 `assertHistoryArchiveSourceMatches()` 抛 `HISTORY_ARCHIVE_SOURCE_CHANGED`；未来权威切换后的热范围若仍非空，则应明确拒绝 `HISTORY_ARCHIVE_HOT_COLD_CONFLICT`，不得逐行覆盖。输出按 `timestamp_ms` 再加规范 payload 排序，不使用 SQLite `id` 作为身份或顺序依据。缺失段继续抛 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND`、`ENOENT` 或 `HISTORY_BACKUP_*`，不得降级为空数组。该卡只有测试侧参考 oracle，没有新增 store 方法、schema、第二遍来源扫描或 `publishedUsageEvents()` 变更。

B3-union-read 实现只读接缝 `UsageStore#mergeHistoryArchiveEventsForRange({ startMs, endMs })`。它要求两个边界都是安全整数且 `startMs < endMs`；在 `await this.open()` 之后，先于一个同步 `SAVEPOINT history_archive_union_read` 内捕获请求范围 hot rows、所有相交的 registry 完整记录，以及每个相交段完整半开范围的 hot rows 和来源身份，然后 `RELEASE`，主写连接不跨 `await` 持有事务。B3-union-cold-snapshot 把冷段读取收成一个内部 `readHistoryArchiveSnapshot(record)`：public `readHistoryArchiveEvents()` 仍只返回 rows；union 直接用捕获的 `{segment_id, database_path, database_sha256, start_ms, end_ms, event_count, registered_at_ms}` 调用该内部接缝，因此不会在 `await` 后重新读取 live registry 来混合登记或路径。每次冷读取在同一个已执行 `assertHistoryArchiveSourceMatches()` 的只读 `BEGIN` 快照里同时读取 rows 和 `source_files` 来源身份，不再开第二冷连接。冷段事件按排除 `id` 的完整 payload 多重集与段内 hot 比较，任一 payload、份数或来源身份不同都抛 `HISTORY_ARCHIVE_HOT_COLD_CONFLICT`，hot 变空也不被解释为已授权删除。相等时保留捕获的 hot 行即为 `max` 份数；登记段外仍来自 hot，最后按请求范围返回并按 `timestamp_ms` 加规范 payload 排序。返回的是 `await open()` 后、首次同步捕获时的 hot 快照，而不是所有冷读取结束时的 live 视图；该方法不写表、不接 `publishedUsageEvents()`、不做权威选择、删除或 schema 变更。

B3-union-multisegment 只补测试，不冻结或修改生产接口：用两个独立 v20 来源副本生成两个不重叠的已登记段，中间保留只有 hot 的 gap；单个请求跨两段时返回段内重复 2 份、gap 1 条和第二段 1 条，不回退成热冷相加。第二段候选文件移走后，整个请求抛 `ENOENT`，不会返回已通过检查的第一段半份；成功和失败前后 hot facts 与 registry 均不变。该测试为下一张 C 时间窗接 `periodAggregate` 提供范围合并前置证据，但本卡未改 `src/usage-store.js`。

B3-cold-authority-read 在现有 `mergeHistoryArchiveEventsForRange()` 上增加只读权威选择：`store_meta.history_archive_event_authority` 是精确的 `{"formatVersion":1,"segmentIds":[...]}`；无 marker 时完全沿用热冷镜像检查。authority 中每个 id 必须是已登记 SHA-256，未知版本/形状/重复 id 抛 `HISTORY_ARCHIVE_AUTHORITY_INVALID`，未登记 id 抛 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND`。对相交且已授权的段，捕获到的完整段 hot rows 必须为空，否则抛 `HISTORY_ARCHIVE_HOT_COLD_CONFLICT`；空 hot 不再被当成镜像相等，而是从已通过 manifest/source 复核的冷快照返回该段 rows，并按请求半开范围过滤、保持原 payload 与重复份数。冷段来源身份必须逐项匹配保存点内捕获的 live `source_files` 身份，缺失或变更同样冲突；未授权段仍执行原多重集与来源镜像检查。该方法不提供 authority 切换/删除 API，不改变 schema、`publishedUsageEvents()` 或 perf/rollup。

B3-cold-cumulative-oracle 只新增测试，不修改生产 store。测试创建一个真实额外 Codex home 的 rollout，初始累计事件为 100；真实 `sync()` 后用 `createHistoryArchiveCandidate()` 生成并登记 `[firstTimestamp, secondTimestamp)` 段，再在同一 `BEGIN IMMEDIATE` 内写 v1 authority 并只删除该来源的 hot events。随后把实际 rollout 重写为原始累计 100 行加累计 130 / `last_token_usage=30` 行，把 `source_files.size/mtime_ms` 置为 `-1`，由真实 `sync()` 强制全文件替换。独立未归档 `UsageStore` 从同一来源真实同步得到 raw rows `[100, 30]`，公开 `publishedUsageEvents()` 合计也是 130；已归档 store 同步后 hot 同样变成 `[100, 30]`，因此 `mergeHistoryArchiveEventsForRange()` 在已授权段仍有 hot facts 时抛 `HISTORY_ARCHIVE_HOT_COLD_CONFLICT`。这拒绝是正确的现有授权门禁，但反例说明全文件替换会从文件头重放累计 100、再把累计 130 解析成 30，把一个本应保留在冷层的旧事件重新插入 hot；没有手工插入 30，也没有改生产逻辑取巧通过。合并成功后才执行的 no-op 与重开稳定性断言当前不可达；一旦冲突修复，测试会继续要求第二次真实 sync 不增加行数。

**B3-cold-reparse-prefix 修复了该反例，不扩大归档语义**：`replaceFile()` 在既有 `BEGIN IMMEDIATE` 内、实际插入事件前，从 `history_archive_event_authority` 选出显式授权段，并用现有 `readHistoryArchiveSnapshot()` 验证候选包、来源身份和已登记元数据。对被重解析来源，属于授权冷段半开范围的事件先按与合并器完全相同的“排除 `id` 后按列名排序”规范 payload 多重集暂存；只有整段多重集与冷行完全一致时才不插入 `hot`，其余事件仍按原逻辑写入。改值、增加、删除或多出任意冷事实都抛 `HISTORY_ARCHIVE_COLD_REPARSE_CHANGED`，让该文件整笔替换回滚；旧 hot、`history_replaced_facts`、`archive_segments`、authority 和来源身份保持替换前状态。没有 authority 时直接返回空前缀并保持原全文件替换语义；没有全局按日期跳过、没有解除 mirror guard、没有新增 schema/authority API/通用冷修订或淘汰流程。

B3-cold-published-oracle 只增加测试侧公开读取对照，不修改冻结的 store。它复用同一真实 `100 cold + 30 hot` 状态，在已验证 `mergeHistoryArchiveEventsForRange()` 返回 `[100, 30]` 且 no-op 稳定后调用现有 `publishedUsageEvents()` 与 `periodComparison({ now: "2026-07-15T12:00:00.000Z", calendarZone: "utc" })`，并与未归档 `UsageStore` 逐对象对拍。当前实际：public events 只有 `02:01` 的 30（input 30、output 0），缺 `02:00` 的 100（input 80、output 20）；period totals `month/all.total` 都是 30，oracle 是 130（input 110、output 20），同名 model 与同一 repository 的 `all.total` 也分别为 30 和 130。`today/week` 两边都是 0。这说明失败边界是公开读取仍只查 hot，而不是合并器或累积解析；测试没有新增 async API、没有在测试中手工拼冷事件，也没有改生产接线。

B3-carrier-snapshot 把 B3-cold-published-carrier 的公开读取窗口收敛为一个内部“全历史”模式。`publishedHistoryUsageEvents()` 不再先做两次 bounded SELECT 再调用 union；它直接调用 `historyArchiveEventUnionForRange(undefined, { completeHistory: true })`。内部 union 在 `await this.open()` 之后、同一个同步 `SAVEPOINT history_archive_union_read` 内依次读取 hot `MIN/MAX`、archive `MIN(start_ms)/MAX(end_ms)`、请求范围 hot rows、authority、相交 registry、每段完整 hot rows/source 身份和 live source 身份；这些动作之间没有 `await`。只有快照释放后才逐段 await 冷文件验证，并复用既有多重集/authority/sourceKind 检查，不复制第二套验证。range 模式仍要求原 `{startMs,endMs}` 并保持原返回契约；完整 carrier 只复用 `publishedUsageEventFromRow()` 与同一 verified `sourceKinds` 映射，缺包、篡改或未登记段明确拒绝，不返回部分/空结果。真实 `100 cold + 30 hot` GREEN target 与未归档 oracle 深度相等（总数 `[100, 30]`、`02:00`→`02:01`、两行 `sourceKind="extra"`）；另一个确定性交错用例在 hot bounds 读取后由第二连接追加旧界外事件，carrier 仍返回完整旧快照，下一次调用看到完整新快照。同步 `publishedUsageEvents()` 与 `periodComparison()` 的 30-vs-130 独立红 target 未删、未 skip。

B3-cold-report-carrier 新增异步 `UsageStore#publishedHistoryUsageReport()`，固定返回 `{events, homes, sessions, rateLimitObservations}`。`historyArchiveEventUnionForRange(..., { completeHistory: true, includeUsageCarrier: true })` 在释放 `history_archive_union_read` 前同时捕获全历史 bounds、hot rows、registry、authority、每段 source 身份、持久 homes 和原始 quota 映射；保存点释放后才 await 冷文件校验。events 复用同一条 verified `sourceKinds` 映射，sessions 从这同一批已映射 events 与捕获 homes 派生，quota 复用现有 row→`RateLimitObservation` codec 但绕过 memo；没有在冷读取之后再次查询 live homes/quota。同步 `publishedUsageReport()` 及其 hot-only 四项契约保持不变。真实 `100 cold + 30 hot` 的 event carrier 与完整 report 均和未归档 oracle 深度相等，session 为 2 条事件、总计 130；确定性交错在快照释放后由第二连接提交 home label、quota 与新增 event，第一次 report 完整保持旧值，第二次才看到三项新值；删除候选后 report 与 events carrier 一起以 `ENOENT` 整体拒绝。

B3-cold-period 新增显式异步 `UsageStore#periodComparisonHistory()`。无 authority marker 时直接委托原同步 `periodComparison()`，保留 hot-only 结果与既有 `periodComparisonCache`；有 authority 时先取 `publishedHistoryUsageEvents()` 的已验证完整事件，按 `homeId` 应用 `excludeHomes`，再调用共享 `public/period-comparison.js#summarizePeriodComparison()`，不复制聚合、模型或仓库统计算法。真实 `100 cold + 30 hot` 下，UTC、local 与 `excludeHomes` 的完整返回都与未归档同步 oracle 深度相等，month/all 都为 130；同步 `periodComparison()` 仍为 hot-only 30。候选段缺失时异步入口整体抛 `ENOENT`，不返回部分或降级零结果。没有新增缓存、schema、Dashboard/executor 接线或同步 API 替换。

B3-period-authority-snapshot 只修该异步入口的判定/读取边界：`periodComparisonHistory()` 先对齐一次修订，再开同步 `SAVEPOINT period_comparison_history_read`；marker SELECT 建立读快照，无 authority 分支在同一保存点内调用原 `periodComparison()`，并通过内部 `periodComparisonSnapshotRead` 标记跳过嵌套的修订探测。保存点内没有 `await`，返回后才 `RELEASE`；因此外连接在 marker 返回后提交 authority 并删热，不会改变本次 period 查询。保存点前已对齐修订，快照结果仍按旧修订写入既有 memo；下一次同步读由 `PRAGMA data_version` 检出外部提交并清缓存，不会把旧 130 当成新热视图复用。有 authority 时不跨 await 持保存点：marker 快照释放后才调用已验证完整 carrier。没有改 schema、公开参数、同步 `periodComparison()` 或 Dashboard/executor。

B-cold-summary 用同样的短保存点约束摘要入口，但不复制 store 的 SQL 聚合：无 authority 时保存点内的 marker 和 `summarizeInReadTransaction()` 共享同一读快照，`summarySnapshotRead` 只跳过该调用链里的嵌套修订探测，原 quota/记录缓存仍按快照前修订读写；有 authority 时释放短保存点后才取完整 report，再复用 `withoutExcludedHomes()` 与 `summarizeUsage()`。因此外连接在 marker 后提交 authority、删除热事件并改 quota 时，首次摘要仍是旧快照 130/used=11，下一次同步摘要检出提交后为 110/used=22；冷载体缺段时 `ENOENT` 整体抛出。`summarizeUsage()` 当前不生成 store 索引路径的 `records`，也没有完整的冷 perf 载体，所以本卡测试只对共享 usage 字段与 oracle 完整深相等；`perf` 和 `records` 明确留给后续卡，不伪装成已完成的“全字段摘要”。

B-cold-summary-records 只补普通范围的 `records`，不把热 SQL 冠军混入冷结果。实现把原 `buildRecordChampions()` 内的槽位累加与“至少两期可比、严格新高”排名提成 `src/usage-store.js` 的本地纯 helper；SQL 路径仍用存储的 local `day_key/week_key/month_key`，冷路径从同一批已发布 `UsageEvent.timestamp` 用现有 `localDateKey()` / `startOfLocalWeek()` 派生相同键。逐事件成本仍经既有 `estimateEventCost()` 与 event-cost memo，币种折算和 session/model 去重语义不变；冠军随后交给未改动的 `recordsWithinRange()`，因此 range 只决定冠军期是否完整包含，不参与冠军选择。`preset=all` 继续返回 `{}`，普通 `custom/today/week/month/recent` 从冷热合并 events 产生 records；配额窗口 records 与 `summary.perf` 仍不在本卡范围。失败、缺段和 authority 行为沿用 `summarizeHistory()` 原路径。

B-cold-perf-capture 只把既有 perf 构建拆成同步 capture/build 两段，没有第二套统计算法。`capturePerfCarrier()` 在 `history_archive_union_read` 内一次性读取 `perfState()`、当前 hot `perf_samples`（冷 carrier 捕获全表）、unplaced 样本、`perf_sample_identities`、known/unsupported sources 与 unsupported 元数据；`buildPerfSummaryForRange()` 在冷读取结束后只使用这份捕获和同一个 `buildPerfStatsBlock()`，并将 `summarizeUsage()` 从完整冷热 events 解析出的最终 range 转为 Date 边界，不使用 hot-only bounds。`publishedHistoryUsageReport({ includePerfCarrier:true })` 才附带内部载体，默认四键报告和同步 `summarize()` 的热路径不变。确定性交错中，第二连接在冷读取期间插入新样本并改 `perf_state`/index，第一次 `summary.perf` 与旧 oracle 完全相等，下一次调用才看到新值；非空夹具同时证明最终 July 12 范围不会误收 July 20 样本。perf 样本与 timing 仍是热事实，不读取或淘汰冷 perf 文件。

B-rollup-complete-events-seam 只在 rollup 模块增加“显式完整事件数组”入口：公开 `rebuildUsageRollupsFromEvents(db, { day, events })` 先把 carrier 的 `UsageEvent[]` 写入固定 TEMP 表（`timestamp`、`sessionId`、`homeId`、`model`、`detailMask`、`reconciliationGap` 与五个 token 字段），再复用原 `rebuildUsageRollupsFromSource()` 的同一 SQL、16 个 model 指标、daily/session/day 关系与 schema 重建一个 UTC 日。原 `rebuildUsageRollups(db, args)` 仍以 `events` 表为源，公开契约不变；TEMP 表在 `finally` 删除，热 `events` 不复制冷事实。真实 `100 cold + 20 hot` 夹具中，从 `publishedHistoryUsageEvents()` 得到 `[100, 20]`，清空 UTC 派生 rollup 后重建 `2026-07-12`，四张 rollup 表均与未归档 oracle 逐行深相等，热 `events` 仍只有 20。B-rollup-multi-UTC 随后把 `day` 扩展为 `days`，见下。

B-store-cold-rollup-day 新增异步 `UsageStore#rebuildHistoryRollupDay(day)`，只重建一个 UTC 日。方法先校验日键、`await this.open()` 并显式拒绝已有事务，再调用既有 `syncDerivedRevision()` 对齐修订；随后以 `BEGIN IMMEDIATE` 同时包住完整权威冷热 events 捕获、冷段验证和 rollup 写入。冷文件 await 期间外连接不能提交 authority、热 facts 或 rollup，因此本次 carrier 与最终四张表属于同一数据库视图。成功 `COMMIT` 后才结束 `writeTransactionDepth`、调用既有 `commitStoreRevision("history-rollup")` 并 `syncDerivedRevision()` 清理既有派生缓存；缺段、坏段或任一 rollup 写入抛错都执行外层 `ROLLBACK`，沿用 `rollbackReplaceFileTransaction()` 的深度/缓存卫生且不推进修订。同步 `summarize()`、`periodComparison()` 与普通 `sync()` 均未改走该入口，也没有回填热 `events`。

B-cold-rollup-writer-lock 只补专用测试，不改生产代码。测试在首次成功重建调用前临时替换实例的 `publishedHistoryUsageEvents()`：先启动原方法并确认 Promise 尚 unsettled，再用真实第二 `DatabaseSync` 连接在 `busy_timeout=0` 下对热尾行执行自动提交的 `UPDATE`。此时 store 的 `BEGIN IMMEDIATE` 仍覆盖冷读取，第二连接收到 SQLite `errcode=5` / `database is locked`，热行仍为 20；测试不读取第二个连接中的未提交状态。首次重建得到 120 并与 oracle 四表深相等。重建提交后，同一第二连接执行同一 `20→25` 更新成功，下一次 carrier 为 `[100,25]`，第二次重建的 125 与已同步 oracle 四表深相等，证明锁随事务结束释放且后续重建实际看到新热事实。实例方法 patch 在 `finally` 恢复。

B-rollup-multi-UTC 把 `rebuildUsageRollupsFromEvents()` 的输入从 `{day, events}` 改为 `{days, events}`：完整 events 仍只写入固定 TEMP 表一次，随后把 `days` 数组原样交给 `rebuildUsageRollupsFromSource()`，由其既有外层 savepoint 一次删除/重建全部目标日并统一提交或回滚；没有按日循环调用、没有重复扫描 events、没有兼容双参数或新框架。`UsageStore#rebuildHistoryRollupDay(day)` 只把调用适配为 `{days:[day],events}`，行为不变。

B-store-full-UTC-rebuild 新增无参数 `UsageStore#rebuildHistoryRollups()`，并把单日/全历史入口收进同一个很小的私有事务接缝。两者都在 `BEGIN IMMEDIATE` 内只调用一次 `publishedHistoryUsageEvents()` 获取并验证完整冷热 carrier，再把一次 `days` 数组交给模块的同一批次；不逐日重取 events、不重复验证所有段、不把冷事实复制进 hot `events`。全历史日期覆盖完整 events 的 UTC `min..max`（含中间空日），并与四张 UTC rollup 表中已有 `day_key` 合并，因此陈旧日期和空历史遗留聚合都会进入本批删除/重建。只有整批写成功后才 `COMMIT`、推进 `history-rollup` 修订并清理派生缓存；缺段或后续日写入失败都会回滚整批并保留旧修订/旧四表。单日公开方法及普通 `sync()`、executor、server、API、local 路径均未改变。

测试使用真实 Codex 累计夹具：`2026-07-12` 冷事件 100、`2026-07-13` 热事件 30、`2026-07-15` 热事件 40，并另造 `2026-07-10` 陈旧 rollup；`2026-07-14` 为无事件中间日。实例计数断言全历史入口只调用一次 carrier 读取。清空 UTC 派生表后调用全历史入口，四张表与未归档 oracle 逐列深相等，日期 marker 为 `10/12/13/14/15`，陈旧日和空日没有聚合行，hot `events` 仍只有 `[30,40]`。移走授权候选后入口以 `ENOENT` 拒绝，四表与 revision 不变；把首日 daily rollup 改成 `999/888` 哨兵后，在第二事件日注入真实 `RAISE(ABORT)`，整批回滚并保留该哨兵及所有旧表。最后删除 authority/registry/events 再调用同一入口，三张聚合表被清空且既有空日 marker 保留。

B-rollup-complete-local-seam 只把既有 `rebuildUsageRollupsFromEvents()` 的 `calendarZone` 透传给原 `rebuildUsageRollupsFromSource()`，默认值仍是 `utc`；日界仍由原 `calendarZone()`、`dayBounds()` 与同一批 SQL 计算，没有复制 DST/时区算法，也没有新增 calendar 配置。真实冷热载体测试在 `TZ=America/New_York` 独立子进程中跨 `2026-03-08` 春季 23 小时本地日：本地日前 1 毫秒和次日边界事件均不进入本地聚合，冷 20 + 热 20 得到本地 `event_count=2,total=40`，四张本地表与未归档 hot-events oracle 逐列深相等；同一 carrier 先按默认 UTC 重建时，UTC 日仍保留边界内的 3 事件/50 总量，再执行 local 重建后 UTC 四表仍与 oracle 相等。生产 store 的全历史入口本卡仍固定 UTC，local 事务性双 zone 接线留后继卡。

B-store-full-dual-zone 把 `UsageStore#rebuildHistoryRollups()` 的 UTC/local 两批发布收进原私有 `BEGIN IMMEDIATE`：只调用一次 `publishedHistoryUsageEvents()` 获取并验证完整冷热 carrier，随后先按 UTC、再按 local 调用既有 `rebuildUsageRollupsFromEvents()`，最后写入现有 `usage_rollup_local_zone_identity`，整批一次 `COMMIT`。日期 helper 仍使用完整 events 的首末时间：UTC 按既有 `min..max` 展开；local 先取首末事件的本地日期，再交给模块既有 `localUsageRollupDaysForUtcDays()` 迭代并在首末日期处裁切，因此跨 DST 不使用固定 24 小时步进，同时补齐中间空日。每个 zone 都把四张 rollup 表已有 `day_key` 并回目标集，旧的 local 日期聚合会在当前进程时区下重建或清成空日 marker；zone identity 只在同一个事务内随新聚合写入，所以跨 TZ 重建不会混留旧 local 日聚合。单日 `rebuildHistoryRollupDay(day)` 仍只发布一个 UTC 日。

专用子进程在 `TZ=America/New_York` 下复用真实 Codex 冷热夹具：启动时持久 marker 仍是父进程时区，提交后才断言为 `America/New_York`；本地首末覆盖 `2026-03-07..2026-03-10`，其中 `2026-03-08` 是 23 小时 DST 日、`2026-03-09` 是无事件 gap；另造 `2026-03-06` 陈旧 UTC/local 聚合。全历史入口只读取一次 union，UTC/local 四张表逐列等于未归档 oracle，陈旧日和 gap 日没有聚合行，既有空日 marker 按契约保留。先保留与新 UTC 值不同的 `999/888` 哨兵，再在 local `2026-03-08` 的 daily insert 注入 `RAISE(ABORT)`：UTC 批次已执行后 local 失败，两 zone 四表仍逐行等于失败前快照，`storeRevision` 不增。最后移走授权候选，入口仍以 `ENOENT` 拒绝且两 zone 旧表和 revision 不变。

B-period-executor 只接执行器的两个周期入口：独立 `periodComparison` 消息改为 `await store.periodComparisonHistory(args)`；dashboard 保持原 `reader = publishedStore || store`，并改为 `await reader.periodComparisonHistory(...)`，summary、metadata 与 period 因此共享同一发布读侧或同一当前 store 快照。`sync`/backup snapshot/`publishedUsage*` 串行队列未改。真实 Codex `100 cold + 30 hot` 夹具中，独立消息与 dashboard 的 month/all 均为 130，缺候选段时两者都以 `ENOENT` 整体拒绝。返修后的交错测试使用子进程 `NODE_OPTIONS` preload 在 worker 第二次 `syncRound()` 入口暂停：外部连接先提交 hot 200 与 authority 删除，pinned dashboard 仍为 summary 130 / period 130；未发布的独立 period 读 hot-only 230；释放后才发布 230 / 230。测试不使用 timeout 抹掉故障，也没有把未提交读当成已提交写者证据。

B-summary-executor 只把执行器的摘要读取接到已有的异步冷感知入口：独立 `summarize` 消息改为 `await store.summarizeHistory(filters, options)`；dashboard 保持原 `reader = publishedStore || store`，并在同一串行请求内 `await reader.summarizeHistory(...)` 与 `await reader.periodComparisonHistory(...)`。metadata 没有改名或替换，仍调用同步 `reader.metadata(filters.now)`，因此本卡不宣称 metadata 已支持冷事实。真实 `100 cold + 30 hot` 专用测试中，独立 summary 与 dashboard summary 的总量均为 130，`perf`、非配额 `records` 与未归档 `store.summarize()` oracle 深相等，`perf.state` 为 `ready`；删除候选包后两个入口均以 `ENOENT` 整体拒绝。相邻 period fixture 的返修另用子进程 `NODE_OPTIONS` preload 在 worker 第二次 `syncRound()` 入口建立确定性发布门；外部 writer 在 gate 打开后提交 hot 200 并删除 authority，pinned dashboard 仍为 summary 130 / period 130，独立 period 读 230，释放后才重新发布 230 / 230。**B-cold-metadata** 随后新增显式异步 `metadataHistory(asOf)`：无 authority 仍在同一保存点内委托原 `metadata()`；有 authority 时把 `generatedAt`、`this.homes`、`warnings` 与完整 cold+hot events 在同一 carrier 保存点捕获，再按原字段、计数、home 状态、warnings 和 `asOf` 观察窗口派生；真实 `100 cold + 30 hot` 对未归档 oracle 全字段深相等，cold-start `modelLastSeen` 取冷事件，缺候选段整体以 `ENOENT` 拒绝。返修前失败是同一 worker 的 sync publication `BEGIN IMMEDIATE` 在外部 writer 锁上同步等待，5s 后 `database is locked`，dashboard cold continuation 无法推进；这是 fixture 互等。Worker 不继承测试进程启动后修改的 `process.execArgv`，因此 gate 初版未生效；最终改由子进程启动时注入 `NODE_OPTIONS`，未在 production 加 test hook，也没有用 timeout 掩盖。没有改 server/public、没有启动生产服务，也没有新增缓存或同步热路径替换。

B-cold-summary-sync-seam 只抽出异步 `summarizeHistory()` 在 `publishedHistoryUsageReport()` await 返回之后的同步计算段，新增 `UsageStore#summarizeHistoryReport(report, filters, options)`。无 authority 的同步快路、carrier 读取和缺失段拒绝不变；原动态 `await import("./server.js")` 改为 `usage-store.js` 内的纯同步 `withoutExcludedHistoryHomes()`，对 `events`、`sessions`、`perfSamples` 采用与原 server helper 相同的排除语义，并消除 store→server 依赖环。新测试用真实 ZCode perf 夹具准备完整冷 report，断言 prepared 结果不是 Promise、与 `await summarizeHistory()` 完整深相等、`records` 与 `perf.models` 非空，并覆盖 `excludeHomes` 与 `includeDetails:false`。没有改 executor/server/public，也没有替换同步 `summarize()`。

B-cold-freeze-HTTP-read 只改 `src/server.js` 的 freeze 分支和对应 HTTP 测试。冻结 store 若在私有快照中登记了冷段，就在任何 `setPricingCatalog(frozen.pricingCatalog)` 之前 await 完整 `publishedHistoryUsageReport({ includePerfCarrier:true })`；报告就绪后，在既有价目 `try/finally` 内同步生成 `summary` 和 period comparison，周期数据复用同一报告 events、`excludeHomes`、`asOf` 与 `calendarZone`。metadata 继续使用 executor 已冻结的 `frozen.metadata`，恢复 live catalog 的 `finally` 前没有新的 await。无 `archive_segments` 的快路仍调用原同步 `store.summarize()` / `store.periodComparison()`，不改变已验证单库契约。新测试把原段移走后再次申请 freeze，要求 500 + `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND`，而不是返回 hot-only 30 或空 0。

B-cold-freeze-pricing 不新增接口或持久状态，只验证上述真实 server 接缝。测试沿 `GET /api/summary?preset=all&calendarZone=utc&freeze=1&skipCheck=1` 创建冷快照，以 A/B 两版完整 catalog 和 snapshot `/api/pricing` 核对冻结版本，再在 snapshot HTTP 请求期间临时 patch 同步 `summarizeHistoryReport`，证明错误从冷分支抛出时仍由同一 `finally` 恢复 live pricing。`skipCheck=1` 只绕过自动同步，不绕过 archive 分支；冷段仍来自真实登记与 authority。生产代码、server/public/store 与测试专用生产钩子均未增加。

B-cold-metadata 新增显式异步 `UsageStore#metadataHistory(asOf)`：先读同步 `metadata()` 契约，确认除 cold+hot events 外还含 `generatedAt`、来自 `this.homes` 的 home 状态/计数、`warnings` 与按 `asOf` 现算的 `modelLastSeen/activeHarnessModels`。有 authority 时在现有 `history_archive_union_read` 内同时捕获 `{generatedAt,homes,warnings}` 与 events，释放保存点后只从该批 carrier 派生，不 await 后读 live 字段；home/harness/event/session 计数、warning 和观察窗口均保持原形状。无 authority 时在 `SAVEPOINT metadata_history_read` 内直接调用原 `metadata(asOf)`，并只让该路径跳过嵌套修订探测，保留原缓存快路。真实 `100 cold + 30 hot` 对未归档 oracle 全字段深相等（仅把两边必然不同的最近 sync 时刻对齐后比较）；cold start 的 `modelLastSeen` 取冷事件时间；移除候选段后整体 `ENOENT`。没有接 executor、API/Dashboard，也不改同步 `metadata()`。

I-full-events 新增同步只读 `UsageStore#publishedUsageEvents()`：从热 `events` 表 join `source_files`，按 `timestamp_ms, id` 返回全部已发布事件的完整 `UsageEvent` 投影。`sourceKind` 取实际 `source_files.kind`，`timestamp` 转 ISO，扁平 token、repository/cwd、context、service-tier 与 price-version 字段均保留；service tier 复用 `costEventFromRow()` 相同的 evidence resolver。该方法不读来源文件、不按 missing/date/home 过滤、不合并热冷、不写表，也不自动 sync 或登记。

I-full-homes 新增同步只读 `UsageStore#publishedUsageHomes()`：从持久 `source_files` 按 `home_id` 去重返回完整来源身份 `{id, label, path, kind}`，不读取 `store.homes`、不把 `perf_missing_sources` 当成新来源、不修改同步状态或 fact。`source_files` 没有 `home_id` 身份唯一约束，因此实现不采用 first-wins：同一 `home_id` 若出现不同 label/path/kind，明确抛 `PUBLISHED_HOME_IDENTITY_CONFLICT`；正常两 home 同步与一 home 缺失/恢复路径无冲突。

I-full-sessions 新增同步只读 `UsageStore#publishedUsageSessions()`：复用 `publishedUsageEvents()` 与 `publishedUsageHomes()`，按 `(homeId, sessionId)` 派生 `{id, homeId, homeLabel, homePath, firstAt, lastAt, eventCount, total, channel, cwd, model}`。同一 session 跨 home 保留两条会话；token 五字段与 `eventCount` 从持久 events 累加，home 身份取持久 `source_files`；`channel/cwd/model` 冻结为事件按 `timestamp_ms, id` 排序后的最后一条。结果按 `lastAt, homeId, id` 排序。该方法不读现场来源、不修改 `store.homes` 或 fact，也不伪造数据库未保存的 `source/originator/cliVersion/modelProvider/filePath`。它是派生会话载体，不是原日志逐字恢复。

I-full-carrier-snapshot 新增同步 `UsageStore#publishedUsageReport()`：固定返回 `{events, homes, sessions, rateLimitObservations}`，四项依次复用 `publishedUsageEvents()`、`publishedUsageHomes()`、`publishedUsageSessions()` 与 `quotaObservations()`。方法用单个 `SAVEPOINT published_usage_report_read` 包住四次读取，成功 `RELEASE`，异常 `ROLLBACK TO` 后 `RELEASE` 再抛原错误；嵌套在外层事务中时不清空或提交外层事务。它不重写 quota codec、不新增缓存/TTL/通用参数框架，也不读取现场来源文件。

I-full-quota-snapshot-cache 暴露并修复 quota memo 在载体快照内的一个洞：报告实例已预热 `quotaObservations()` 缓存后，同一连接外层写事务把 primary `used_percent` 改为未提交值，原实现因 `storeRevision` 未变直接复用旧缓存，报告中读到 58 而实际事务值是 99。修复只给 `quotaObservations()` 增加内部 `{useCache:false}` 开关，并由 `publishedUsageReport()` 在快照内调用时关闭读写 memo；codec、SQL、缓存形状与其他调用方默认行为不变。修复后同一载体可读到未提交 quota，`ROLLBACK` 后再次报告恢复提交值，未把 99 留在 memo。

## 接口与持久化

- B0 新增 `store_meta.perf_missing_sources`，不新增表或列；B1b-E 单独把 `STORE_SCHEMA_VERSION` 从 19 接到 20，并为新库建表、为旧库执行 19→20 迁移及冻结 schema 自检。
- 新增 `history_replaced_facts`（`STRICT`，12 列）：`fact_table`、`source_kind`、`home_id`、`source_path`、`payload_digest`、`occurrence_count`、`payload`、`source_home_label`、`source_home_path`、`method_version`、`revision_reason`、`recorded_at`。
- 主键是 `(fact_table, source_kind, home_id, source_path, payload_digest)`。刻意不设 `source_files` 外键：来源身份后来被替换或消失时，旧事实仍可保留。
- `occurrence_count` 是正整数，表示该摘要**单次重解析中曾丢失的最大份数**；不是跨每次修订累加的历史总数。它足以把一次缩减还原为 `live + occurrence_count`，同时保持重复重解析幂等。
- `payload` 是旧 `events` 行的 JSON；摘要使用排除自增 `id`、按列名排序后的规范对象做 SHA-256。`method_version` 固定为 `events.v1`，`revision_reason` 为 `reparse_replaced`，`recorded_at` 是首次记录入库时间而不是来源事件时间。
- project-log 截断诊断复用 `store_meta.perf_file_warnings` 的 `path → warning[]` 结构，code 为 `PROJECT_LOG_TRUNCATED`，`count` 是本次减少的 live event 行数。marker 与替换事务同提交；普通重解析保留，`syncRound()` 按文件与 `count` 重建既有中文字符串 warning。它不进入 perf `sourceWarnings`，也不改 schema 版本。
- project-log 坏行诊断复用同一 `perf_file_warnings` 的 `path → warning[]` 结构，不新增表、列或 schema 版本。成功替换写入 `{sourceKind: "project-log", homeId, code: "PROJECT_LOG_MALFORMED_JSONL", count, lineNumbers}`；`lineNumbers` 是当前成功解析中跳过坏行的 1-based 行号，排序去重，不含行内容。它与截断 marker 独立：再次遇到坏行会更新位置，成功解析全合法文件会移除坏行 marker，但不会删除截断 marker。`syncRound()` 从已提交 sidecar 重建 warning，因此当前轮、no-op 与重开 no-op 的消息一致；失败/回滚事务不写 marker。
- sibling events 与 sibling quota 复用同一表，不新增 schema；events 使用 `events.v1`，quota 使用 `rate_limit_observations.v1`。恢复行的 `source_kind` / `home_id` / `source_path` / `source_home_label` / `source_home_path` 来自被删除前的旧 sibling `source_files` 行。因为 `source_path` 也在两类 payload 内，plain→压缩表示的替换即使业务字段完全相同，也会保存旧 plain payload；同路径未变追加仍不会产生恢复行。
- `perf_samples` / `perf_sample_sources` 复用同一张历史表且不排除任何列；历史行的 `method_version` 写 `PERF_METHOD_VERSION`，样本 payload 内仍保留旧行自己的 `method_version`。依赖 payload 保留其自身 `sample_key` / `source_path` / `role`，而历史行来源身份仍是被替换文件的旧 `source_files` 上下文。
- `history_replaced_facts` 的唯一 INSERT/occurrence 高水位 SQL 由 `HISTORY_REPLACED_FACT_INSERT_SQL` 共享，非 Codex 与 Codex 发布路径不会各维护一份易漂移的语句。
- B1b-E2 复用现有 `migrate(..., 20, assert...)` 和冻结列/`STRICT` 自检；B3-schema 再从 20 迁到 21，当前新库在建表成功后把 `user_version` 写成 21。
- `UsageStore#perfState()` 与 `sync()` 返回值新增 `missingSources`：

```js
{
  path,          // 最后成功发布的物理路径
  kind,          // source_files 中的原始来源 kind（如 extra / project-log）
  homeId,
  homeLabel,
  homePath,
  missingSinceMs // 同一 path/kind/homeId 连续缺失时保持稳定
}
```

- `kind` 是来源身份而不是 perf 规范 kind；`extra` 不会被改写成 `codex`，`project-log` 不会丢失成 `unsupported`。需要性能分组的消费者继续使用既有 `canonicalPerfSourceKind()`。
- `missingSources` 已纳入 `perf_index_version`。首次缺失、恢复和来源集合变化会改变版本；同一缺失状态的无变化轮保持版本稳定。
- 目前 `perfState()`、`sync()` 与索引汇总的 `summary.perf` 暴露该字段；`summary.perf.missingSources` 直接复用同一形状，只按本次 `scopeExclusions` 排除 home。内存汇总路径、公开类型、API 路由与页面不在 B0.4-summary 的修改范围内。
- `aggregateRange()` 的整 UTC 日路径把 `queryUsageRollupsRange()` 的 camelCase 结果映射回原 SQL 行字段；完整日集合由现有 rollup 标记校验，缺日/旧格式只以 `ROLLUP_DAYS_MISSING` 触发回退。
- `periodAggregate("model", "model", ..., { includeKind: false })` 把四个周期的闭区间终点加 1 后交给 `queryUsageRollupsModelsWindow()`，并按原 16 个字段名映射回 `{key, name, periods}`。同一 `period_model_rollup` 保存点内先按 scope 读取 `MIN/MAX(timestamp_ms)`，再读取所有周期；`all` 窗口未覆盖来源范围时额外读取一次来源范围以补齐模型集合。`excludeHomes` 同时作用于边界与每次读取，结果按 `periods.all.total DESC, name ASC` 排序。其他维度、`includeKind: true`、空库、无界/空窗口形状与旧路径一致；只有 `ROLLUP_DAYS_MISSING` 回退原 SQL。
- rollup 缓存由 `src/usage-rollups.js` 的独立 format 2 管理，不进入 `STORE_SCHEMA_VERSION` 或 SQLite `user_version`。`syncRound()` 在 `src/usage-store.js:4233` 安装触发器，在既有 C5 缓存失效完成后的 `:5909` 读取 dirty 日与 local 身份；UTC 与 local 重建包在 `:5914` 的同一个外层 savepoint 中。`create/rebuild` 使用内部 savepoint，不自行开启外层事务。
- `store_meta.usage_rollup_local_zone_identity` 保存当前 local 日界身份（IANA 时区名，无法取得时用 `offset:<分钟>`）。它是 rollup 维护状态，不新增 schema 版本，也不进入公开 summary。
- B3-schema 把 `STORE_SCHEMA_VERSION` 从 20 接到 21，并新增 `archive_segments`（`STRICT`，7 列）：`segment_id TEXT PRIMARY KEY`、`database_path TEXT NOT NULL`、`database_sha256 TEXT NOT NULL`、`start_ms INTEGER NOT NULL`、`end_ms INTEGER NOT NULL`、`event_count INTEGER NOT NULL`、`registered_at_ms INTEGER NOT NULL`；约束为 `end_ms > start_ms`、`event_count >= 0`。
- B3-register-metadata 提供异步 `UsageStore#registerHistoryArchiveCandidate(candidateFile, manifestFile = undefined)`。它不新增 schema；返回 `{ inserted, segmentId, databasePath, databaseSha256, startMs, endMs, eventCount, registeredAtMs }`。`databasePath` 是 `path.resolve()` 后的绝对路径，`segmentId` 与 `databaseSha256` 都取已验证包的 `database.sha256`。
- 登记先验证候选包，再在 `BEGIN IMMEDIATE` 内重新计算源 events 指纹与源身份集合；验证失败、源已变、已有段范围重叠或 INSERT 约束/触发器失败都回滚，目录保持调用前状态。同一 `segment_id` 且区间、events 行数一致的重复登记返回 `inserted: false` 和首次时间，不新增第二行；同 digest 的其他路径不会覆盖既有路径。不同 digest 的已登记半开区间只要满足 `new.start < old.end && new.end > old.start` 就拒绝。
- `segment_id` 是归档包数据库的 SHA-256，不是路径。`database_path` / `database_sha256` 只描述已登记候选；登记卡本身不读取冷段，后继单段读取卡也不选择权威段、不提供恢复 API，也不让 `archive_segments` 参与任何统计。
- B3-read-segment 提供异步 `UsageStore#readHistoryArchiveEvents(segmentId)`，返回候选数据库 `events` 表按 `id` 升序的完整行数组，不改变行字段。未知 id 或目录外路径没有登记记录时明确抛错；候选 manifest/数据库损坏、文件缺失、包 digest/边界/事件行数与目录不一致时都不会返回空数组。合法的 0-event 已登记候选仍会返回 `[]`。
- 读取只使用目录中的绝对 `database_path` 定位包，不接受调用方另行指定路径、范围或 manifest。候选验证后在同一只读连接内 `BEGIN` 并再次调用既有摘要断言，然后查询并回滚；因此 verify 之后到快照建立前的同数量改写会抛 `HISTORY_ARCHIVE_SOURCE_CHANGED`，快照建立后的外部提交不会混入 rows。数据库与 manifest 仍非双文件原子发布，也没有 fs 锁。
- B3-union-oracle 的下一卡接口建议固定为 `mergeHistoryArchiveEventsForRange({ startMs, endMs })`，只覆盖已登记段范围。相同事实的规范 payload 是完整事件行排除 `id` 后按列名排序的结果；重复份数按热/冷两侧同一 payload 的最大计数保留。冷段缺失、目录未知、包损坏或热冷摘要不一致都必须抛错，调用方不能把失败吞成 `[]`。冲突拒绝发生在合并前，不在合并中挑选胜者。
- B3-union-read 提供异步 `UsageStore#mergeHistoryArchiveEventsForRange({ startMs, endMs })`，返回请求范围内的原始 hot event rows。它先同步捕获请求 hot、相交目录段、每段完整 hot 与来源身份并释放保存点，再逐段调用 `readHistoryArchiveEvents()`；冷热事件多重集或来源身份不一致抛 `HISTORY_ARCHIVE_HOT_COLD_CONFLICT`，缺段沿原错误抛出。结果只代表捕获时快照，不写表、不改变 authority、不接公开 carrier。
- B3-union-cold-snapshot 抽出内部 `readHistoryArchiveSnapshot(record)`，返回 `{rows, sourceIdentities}`。它用调用方捕获的完整 registry record 校对 manifest digest、边界和事件数，在同一只读冷连接 `BEGIN` 后执行既有摘要断言，再在同一事务内读取 events 与来源身份，`finally` 里 `ROLLBACK`/关闭。public `readHistoryArchiveEvents(segmentId)` 只把该方法返回的 `rows` 原样交给调用方，调用契约不变；union 不再重新按 id 查询 live registry，也不另开第二冷连接。热范围仍在 `await this.open()` 之后用同步保存点捕获。
- B3-cold-authority-read 让 `mergeHistoryArchiveEventsForRange()` 在同步保存点内读取 `store_meta.history_archive_event_authority`。v1 形状固定为 `{"formatVersion":1,"segmentIds":["<sha256>", ...]}`；无 marker 时 authorized 集合为空，原有镜像路径不变。已授权段必须已登记且完整段 hot rows 为空，随后用已复核冷快照的 `rows/sourceIdentities` 回答请求范围；未授权段仍保留原 hot/cold 镜像门禁。method 不新增参数、写 SQL、schema、authority 切换入口或公开类型。
- B3-cold-report-carrier 提供异步 `UsageStore#publishedHistoryUsageReport()`，返回完整历史 `{events, homes, sessions, rateLimitObservations}`。内部 union 的 `includeUsageCarrier` 模式在同一个 `history_archive_union_read` 保存点内捕获 hot events、home 身份、quota 和 source 身份；释放保存点后才 await 冷段。events 使用捕获的 `sourceKinds`，sessions 从同批 events 派生，quota 使用现有 SELECT/codec 且不读 memo。同步 `publishedUsageReport()` 的 hot-only 接口不变；本卡没有接 executor、API、summary 或 period。
- B3-cold-period 提供异步 `UsageStore#periodComparisonHistory(options)`，参数形状与同步 `periodComparison()` 相同。无 authority 时返回 `periodComparison(options)` 的同步结果；有 authority 时 await `publishedHistoryUsageEvents()`，按 `options.excludeHomes` 的 home id 过滤完整事件，再把原 options 交给共享 `summarizePeriodComparison()`。返回值包含同一 `periods/totals/models/repositories/asOf` 形状，但不写入 `periodComparisonCache`。没有新增 authority 参数、写路径或 schema；同步 `periodComparison()` 保持原 hot-only 契约。
- B3-period-authority-snapshot 把无 authority 路径的 marker 与首次 period 读取固定在同一同步 SQLite 读快照中。`periodComparisonHistory()` 在保存点前调用一次 `syncDerivedRevision()`，保存点内不再探测外部提交；内部布尔标记只让被委托的 `periodComparison()` 跳过嵌套修订探测，缓存读写和返回形状仍走原路径。无 authority 分支不跨 `await` 持保存点；有 authority 分支释放短保存点后才调用 carrier，由 carrier 自己的完整历史快照负责一致性。没有新增持久状态、参数或 schema。
- B-cold-summary 提供异步 `UsageStore#summarizeHistory(filters, options)`。无 authority 时在 `SAVEPOINT summary_history_read` 内直接调用原 `summarizeInReadTransaction()`，保留原 SQL、缓存与 `includeDetails` 行为；`summarySnapshotRead` 只让该调用链在保存点内跳过嵌套外部修订探测。有 authority 时 await `publishedHistoryUsageReport()`，按 `filters.excludeHomes` 动态导入并复用 `src/server.js#withoutExcludedHomes()`，再调用 `usage-core.js#summarizeUsage()`；`includeDetails:false` 会移除 `homes/projects/repositories`。没有新增 schema、缓存、公开参数或同步入口替换；`summary.perf` 与 store-only `records` 不在本卡可用载体中。
- B-cold-perf-capture 给 `publishedHistoryUsageReport()` 增加内部 `includePerfCarrier` 选项；为 true 时 perf state、full hot samples、unplaced samples、sample identities、known/unsupported sources 与同一保存点的 usage carrier 一起捕获。返回值中的 `perfCarrier` 仅供 `summarizeHistory()` 调 `buildPerfSummaryForRange()`，默认四键 report 不带该字段。没有新增公开方法、参数、缓存或 schema。
- B-cold-prefix-revision-write 沿用 `store_meta.history_archive_event_revisions` 的 v1 形状，不新增 schema 或公开参数。每个 `(segmentId, sourceIdentity)` 只保存一条当前累计 delta；该 delta 始终相对 immutable candidate，而不是相对上一条 revision。writer 只存在于 `replaceFile()` 的既有替换事务内；只有覆盖一条既有 revision 时，旧的 effective rows 才按既有 `events.v1` / `reparse_replaced` 证据写入 `history_replaced_facts`。immutable candidate 自身仍由归档包保留。
- B-cold-prefix-revision-rollback 不新增生产接口、参数、schema、hook 或缓存；只在专用测试 SQLite 连接上临时创建并删除 metadata trigger。失败证据读取既有 `source_files`、`events`、`history_replaced_facts`、rollup 表、`store_meta`、公开 union 与 `summarizeHistory()`，重试仍走未改动的普通 `sync()`。
- B-codex-revision-rollback 同样不改生产源码、schema、公开 API 或持久格式；只在专用测试连接上临时安装 `store_meta` revision UPDATE trigger，并在测试进程内短暂包装 `DatabaseSync.prototype.prepare`，只捕获目标 `history_archive_perf_revisions` statement 的精确 `INJECTED_CODEX_REVISION_METADATA_FAILURE`。源码未接受该具名字符串作为业务状态，也未新增诊断码、重试框架或事务 hook。
- B-cold-prefix-late-add 不新增 schema、公开 API、参数、缓存或第二套 delta 格式；只放宽 `historyArchiveColdRevisionForRows()` 的身份集合检查，使 observed 可追加 identity。rollup dirty-day 维护继续使用既有 changed-row 接缝，新增 identity 的 absent previous row 在进入该接缝前被过滤。

- B-cold-prefix-removal-write 不新增 schema、公开 API、参数、缓存或警告码。`historyArchiveColdRevisionForRows()` 只在内部返回 `removedColdEventCount`，并把被删 identity 纳入既有 changed-row/rollup-dirty 接缝。纯删除只允许 `sourceIdentity.kind === "project-log"`；其他 kind 保持原拒绝，避免 facts 已删除却没有来源专属诊断。obsolete 的“original identity 必须全部存在于 effective”检查已移除，因为累计 `removed` 可以合法覆盖此前的原 identity。observed 仍必须非空，混合新增/删除仍拒绝。project-log 冷删除数与该文件同时发生的热事件损失相加后，继续写入既有 `perf_file_warnings` 中的 `PROJECT_LOG_TRUNCATED`。纯删除的 revision 仍相对 immutable candidate 累计；原始被删 payload 不复制进 `history_replaced_facts`，不可变候选段继续作为恢复证据。
- B-cold-removal-rollback 不新增生产接口、参数、schema、hook、缓存或警告码；只在专用测试连接上临时创建并删除 `store_meta` trigger。该 trigger 仅在 `history_archive_event_revisions` 已存在时拒绝 `perf_file_warnings` 的 UPDATE，因此用于证明冷删除 revision 元数据已暂存、`PROJECT_LOG_TRUNCATED` 尚未提交时，失败会回滚整个 `replaceFile()` 事务。失败快照覆盖 revision bytes、hot/recovery facts、persistent warnings、dirty days、三张 aggregate 表、公开冷热 union、summary、immutable segment 与 candidate digest；重试仍走未改动的普通 `sync()`。
- B-cold-perf-eviction-red 只新增专用行为测试，生产文件冻结。测试复用真实 ZCode perf 夹具和已登记 authority 冷段，选取冷范围 `small-1`（`output_tokens=1`、`duration_ms=1000`）与热范围 `ranked-0`（`output_tokens=100`、`duration_ms=500`），只在隔离主库删除冷 `perf_samples` 一行；`perf_sample_sources` / request-timing 表不进入淘汰范围，热样本保留。测试对未淘汰 oracle 比较 `summarizeHistory()` 的实际 `perf.coverage` 和 model 指标，并读取归档段确认 immutable payload 未变。当前接点是 `capturePerfCarrier()` 只枚举 live `perf_samples`，`buildPerfSummaryForRange()` 只接收该 hot carrier；归档段 candidate 虽随整库 backup 带有 perf 样本，但当前没有从该候选读取或合并冷 perf 的路径。
- B-cold-perf-read 新增 `UsageStore#readHistoryArchivePerfSamples(segmentId)`，只读取一个已登记冷候选在注册区间 `[start_ms, end_ms)` 内的 `perf_samples`。候选创建本来就是整库 backup 后再裁 events，因此 perf 行已经在既有 candidate 中；本卡没有新增 schema、表、文件格式、缓存或写入路径。读取先走既有 `verifyHistoryArchiveCandidate()` 和 registry metadata 比较，再以只读连接在事务内调用 `assertHistoryArchiveSourceMatches()`；随后显式检查 `perf_samples` 表存在、复用 `assertPerfSamplesSchema()`，按 `ts_ms >= start AND ts_ms < end ORDER BY sample_key` 查询并用 `decodePerfSample()` 全列解码。未登记 segment 抛 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND`，缺表抛 `HISTORY_ARCHIVE_PERF_TABLE_MISSING`，其余 digest/registry/schema 漂移沿用既有 archive 或 perf codec 错误。
- B-perf-reader-missing-file 复用现有真实 cold perf 夹具和 `UsageStore#readHistoryArchivePerfSamples(segmentId)`，不新增生产接口、参数、缓存或 schema。测试先把已登记候选数据库临时移走而保留 registry 与 manifest，读取必须以底层 `ENOENT` 拒绝，不能伪装成未登记 segment 或返回空数组；随后把同一文件移回，同一 store 再读必须恢复为与第一次逐字段深相等的 decoded rows，且文件 SHA-256 不变。该卡只覆盖候选数据库短暂缺失与同路径恢复，不覆盖 manifest 缺失、文件替换、并发 writer、损坏 backup 或运行中服务。
- B-cold-timing-source-candidate-fidelity 只新增真实行为测试，生产源码、schema、fixture 与归档格式均未改。测试用真实 Codex fixture 的冷样本经 `perf_sample_sources` 与 `perf_rollout_threads` 解析唯一线程，再快照该线程的 `perf_samples`、全部 sample-source 依赖、rollout owner、对应 `source_files` 身份，以及 `perf_request_timing_meta/evidence/threads/dirty_threads`；candidate 由既有整库 backup 生成，唯一裁剪对象仍是范围外 `events`，因此没有新增 perf/timing 存储或复制路径。该契约只证明 raw dependency fidelity，不定义冷 perf 合并、timing publication、淘汰或恢复语义。
- B-cold-workbuddy-duration-fidelity 只新增真实行为测试，生产源码、schema、fixture 与归档格式均未改。测试写入一条真实 WorkBuddy usage session JSONL 和两条同一 `messageId` 的原生 trace `generation span_end` 观察（`800ms` 与 `850ms`），先由普通 `sync()` 建立 `workbuddy_generation_duration_observations` 与对应 WorkBuddy `source_files` 身份，再用既有整库 backup 创建只裁剪范围外 `events` 的 candidate。断言 source 在 candidate 前后逐列不变，candidate 的 observation/source-identity 快照与 source 深相等，冲突观察不伪造 `perf_samples`，且只读检查不改 candidate SHA-256。
- B-cold-unplaced-retention 只新增真实行为测试，生产源码、fixture、schema 与归档格式均未改。测试直接复用 ZCode fixture 已有的 `started_at/completed_at = NULL` 记录，不手改时间戳；对隔离 store 建立冷段 candidate、登记并写显式 authority 后，只在同一 store 删除冷范围 `events`，不删除任何 `perf_samples`。断言封存前后 `unplacedPerfSamples()` 逐字段深相等，candidate 的 `history_archive_perf_sources_v1` 清单只对有限 `[start_ms,end_ms)` 样本计数/摘要，且 `readHistoryArchivePerfSamples()` 返回同一有限范围样本键和原始 `ts_ms`，不会为 NULL 时间猜日期。
- B-cold-perf-dependency-closure-red 只新增真实 Codex 行为测试，生产源码、fixture、schema、summary 与淘汰路径均未改。测试通过 `seedRequestTiming()` 建立原生 timing 关联，在创建 candidate 前从 source 锁定一个冷 `perf_samples` 样本、其 `perf_sample_sources` 中 `role = "dependency"` 的 rollout、rollout owner 与既有 timing link，并断言这些关系在 candidate 中逐列深相等；随后复制 candidate，只删除该 `(sample_key, source_path)` 主键并重新用 `createHistoryBackup()` 打包，使外层 manifest/checksum 有效。期望 `verifyHistoryArchiveCandidate()` 以 `HISTORY_ARCHIVE_CANDIDATE_PERF_DEPENDENCIES_MISMATCH` 拒绝该不完整图；这是待实现的依赖闭包契约，不是当前 verifier 的在线能力回退。
- B-cold-timing-manifest-red 只新增真实 Codex 行为测试，生产源码、fixture、schema、summary 与淘汰路径均未改。测试在 candidate 创建前从 source SQL 锁定一个冷样本 → `perf_sample_sources` → `perf_rollout_threads` owner → `perf_request_timing_threads` 原生 response/thread → 非空 `perf_request_timing_evidence` 的完整链路，不按时间猜测关联；candidate 通过既有整库 backup 生成后，逐列断言同一 source binding 与原始 evidence 保持不变。随后复制 candidate，只把被引用 evidence 的 `duration_ms` 改为另一个合法正数，保持真实复合主键及其余列不变；`createHistoryBackup()` 重打包后外层 checksum 有效，期望 `verifyHistoryArchiveCandidate()` 以 `HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH` 精确拒绝。
- B-cold-timing-manifest-write 只在 `src/history-archive.js` 增加 `history_archive_perf_timing_v1` 候选组件：`formatVersion:1`、候选范围，以及 `perf_request_timing_threads`/`perf_request_timing_evidence` 两张现有表的完整固定列与流式 `{rows,sha256}`。owner 来自范围内 `perf_samples` primary/dependency source paths 的 `perf_rollout_threads`；link 只按 owner 的原生 `home_id/thread_id`，evidence 只按 link 的 `home_id/response_id`，保留全部 origin/variant，不按 `completed_at_ms`、样本 turn 或时间邻近猜关联。创建与既有 events/sources/perf keys 在同一事务内写 key，验证在同一只读事务快照重算；缺失 key 的 legacy candidate 继续兼容，格式/范围为坏 meta，count/hash 与当前图不一致为 graph mismatch。
- B-workbuddy-observation-manifest-red 只新增真实 WorkBuddy 行为测试，生产源码、schema、fixture 与归档格式冻结。测试在 candidate 创建前锁定一条冷 usage event 所引用 message 的两条原生 duration observations 和五列 WorkBuddy source identity，创建后逐列对拍；随后复制 candidate，只把其中一条被引用 duration 从 `800` 改为 `801`，保持另一条观察及 message 引用不变，并用 `createHistoryBackup()` 重打包使外层 checksum 有效。未来 `verifyHistoryArchiveCandidate()` 必须以 `HISTORY_ARCHIVE_CANDIDATE_WORKBUDDY_MISMATCH` 拒绝该改写；当前 verifier 仍接受，因此这是待实现契约的预期红，不是已实现能力回归。
- B-zcode-cold-perf-authority-red 只新增真实 ZCode 行为测试，生产 store 保持只读；测试开始与结束时 `src/usage-store.js` 的 SHA-256 均为 `f501e615b93054bed272fc000466778f978444a57ebc0dc85ee9963168faef89`。既有 candidate 先由 `verifyHistoryArchiveCandidate()` 验证，并显式核对 `history_archive_perf_sources_v1`、`samples_v1`、`index_v1`、`timing_v1` 四个组件 key 同时存在；同段 registry 与既有 `history_archive_event_authority` 就绪后，测试手工提交冻结的 `history_archive_perf_authority={formatVersion:1,segments:[{segmentId,databaseSha256,sourceKinds:["zcode"],methodVersions:["tps-v2"]}]}`。冷侧全部样本必须是 `zcode` + `tps-v2`，测试只临时删除一个可计算冷样本，热样本与 unplaced 全列快照必须不变；不授权其他 source kind，不整段删除，也不接自动封存。当前生产没有消费该 perf marker，因此 `summarizeHistory()` 的 `coverage`、冷 model `n/p10/p90/averageTps` 仍与未删除样本的未归档 oracle 不同。
- B-zcode-cold-perf-carrier-write 在既有 summary union 保存点内同时捕获严格 `history_archive_perf_authority`、匹配的 registry record、既有 event authority 与 full hot perf carrier；保存点释放后才用捕获 record 读取已验证冷候选，绝不 await 后重查 live registry。公开 `readHistoryArchivePerfSamples(segmentId)` 保持单参数与原行为，完整 carrier 走私有 captured-record reader；同一只读候选事务内要求四个 perf component key 全部存在，再读取注册 `[start_ms,end_ms)`。marker 只允许一个 `zcode`/`tps-v2` 段，`segmentId` 必须等于 `databaseSha256`、存在于 event authority 与 registry 且 registry digest 相同。冷热样本按 `sampleKey` 合并：完整 payload 相同只计一次，不同则抛 `HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT`；hot/unplaced 行保持原对象，known source 与 identity 从同一批冷样本补充。没有 schema、writer、淘汰、路由或统计算法改动。
- B-perf-authority-guards-red 只新增 `test/history-cold-perf-authority-guards.test.js`，生产 store 冻结在 `f0118bdf3cbb2c2ec25ac2fad58c4a3ef4c5fe9a2bab0c48ae265fea2a64f8f6`。三个小 ZCode 真实夹具分别锁定：只留 perf marker 时必须 authority mismatch；未知 kind/method 必须精确 INVALID；删除一个 required perf component 并重新 backup/登记后，event 旧兼容仍可 verify，但 perf summary 必须精确 MISMATCH。没有新增 authority 写 API、schema、缓存、路由或通用 fixture。
- B-perf-authority-fastpath-fix 只改 `src/usage-store.js` 中 `summarizeHistory()` 的 authority 快路：原先只查 `history_archive_event_authority`，现在用一条 `SELECT 1 ... WHERE key IN (?, ?)` 同时探测 event/perf marker；任一存在都进入既有完整 authority 校验，不再在只有 perf marker 时返回 hot-only 成功。没有新增 API、schema、缓存、路由或校验实现；`metadataHistory()` 仍只按 event marker 判定，冷 metadata 的孤立 perf-marker 策略不在本卡。
- B-cold-perf-overlap-conflict 只新增 `test/history-cold-perf-conflict.test.js`，`src/usage-store.js` 保持冻结在 `eebda75e848e8cfe28b850e45bd1a3fbf085fc0d1f7552dc293a80ebbe9d9f5c`。测试使用一个真实 ZCode cold segment、同段 event/perf authority，以及 candidate/live 中完整 payload 相同的重叠样本；只对 live `perf_samples` 执行真实 SQL `UPDATE ... SET duration_ms = duration_ms + 1`，同一 `sample_key` 下完整 decoded payload 已不同，`summarizeHistory()` 必须以精确 `HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT` 拒绝而不是部分成功。恢复原 `duration_ms` 后，同一 store 的 `summary.perf`（仅归一本进程 `indexedAt`）与未归档 oracle 深等，candidate SHA-256 不变。没有新增 production 接口、schema、writer、自动淘汰或其它 source kind 逻辑。
- B-zcode-perf-multisegment-write 只改 `historyArchivePerfAuthority()` 与既有冷 perf record loop：非空 `segments` 数组逐项复用原 schema/`zcode`/`tps-v2`/digest/event+registry 校验，重复 `segmentId` 以 `HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID` 拒绝；原 `SAVEPOINT` 一次捕获全部 `{segmentId,record}`，释放后逐个复用已验证 private reader 与 `sample_key` 并集/冲突逻辑。没有新增 framework、authority writer、其它 source kind、并发控制或 TPS 算法。
- B-codex-cold-perf-authority-red 只新增 `test/history-cold-codex-perf-authority.test.js`，生产源码和既有测试冻结。测试复用真实 Codex fixture 与 `seedRequestTiming()`，并向首个原生 rollout 追加一条带 `token_count` 的合法 `event_msg`，使 event authority 有一个真实 cold event 可封存；source 在 candidate 前保存完整 `summary.perf` oracle。测试从 source SQL 选择一个 cold、completed、正输出/正时长的 Codex `tps-v2` 样本，解开 `sample_key` 后按原生 `home_id/response_id/thread_id` 读取 `perf_request_timing_evidence`，逐值确认样本输出量与时长确实来自导入的 request timing。随后 candidate 通过既有 verify 和四个 perf component key 检查并登记；`history_archive_event_authority` 与 `history_archive_perf_authority` 指向同一段，perf marker 明确写 `sourceKinds:["codex"]`、`methodVersions:["tps-v2"]`。测试提交删除全部 cold `events` 与恰好一个 cold perf sample，热和 unplaced perf 仍按全列快照不变；期望 `summarizeHistory()` 的完整稳定 `perf`（仅归一两处 `indexedAt`）等于 candidate 前的 source oracle。当前 `historyArchivePerfAuthority()` 仍只接受 `zcode`，实际在 summary 前以 `HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID` 拒绝，故本卡是预期红；没有放宽白名单或修改合并实现。
- B-codex-cold-perf-authority-write 只改 `src/usage-store.js` 的既有 perf authority parser、捕获 record 形状和 merge 接点，并新增一个 guards 用例；归档格式、reader、统计核心、authority writer、热删除与 revision 均不改。`sourceKinds` 仍必须恰好一项，允许集合仅为 `zcode` 或 `codex`，`methodVersions` 仍严格为 `["tps-v2"]`。parser 捕获每个 segment 声明的 `sourceKind` 到 `{segmentId,record,sourceKind}`；释放保存点后，每个已验证冷段只把该声明 kind 传给现有 merge。merge 对每条冷 sample 同时检查 `sample.sourceKind === declaredKind` 与 `methodVersion === "tps-v2"`，因此 codex authority 不会默认接受 ZCode 样本；差异以 `HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH` 整体拒绝，仍复用原 `sample_key` 并集/完整 payload 冲突逻辑。
- B-codex-cold-perf-transfer 只新增真实 Codex bundle/import 行为测试，生产源码、schema、reader、统计核心与 authority writer 均未改，`src/usage-store.js` SHA-256 保持 `925c8a3153faeeb66925a1d441f2912b5eff4ff1200772653500bd47a8c5f078`。测试用真实 perf fixture 与原生 `seedRequestTiming()`，追加一条带 `token_count` 的冷 event 以满足同段 event authority，并选择一个 cold、completed、`tps-v2` 样本；候选前先锁定 `perf_sample_sources`、rollout owner、timing thread/evidence 和四个 perf component payload。依次执行既有 `publishHistoryArchiveBundle()` 与 `publishHistoryArchiveImport()`，随后删除临时 live store 的一个冷 perf 行与全部冷 events，并移走原始 source tree、candidate 数据库和 manifest；只从导入 runtime 断言热/unplaced 行逐列不变、导入 `summary.perf` 与 candidate 前 source oracle 深等（仅归一 `indexedAt` 与 `meta.indexedAt`）。该卡证明既有 bundle/import 已能转移单个 Codex 冷 perf 依赖图，没有新增导入格式、在线 import、自动淘汰或通用迁移入口。
- B-codex-required-request-facts 只在既有 `requirePerfComponents` 能力声明接点增加一个来源条件：authority 每段已有的 `sourceKinds[0]` 继续作为 `sourceKind` 传入，只有显式 `sourceKind === "codex"` 时，才额外要求 candidate 中存在 archive 既有常量导出的 `history_archive_codex_requests_v1`。`zcode` 不要求该 key；缺少全部 perf 元数据的 legacy candidate 仍可按 events 读取。没有 GLOB 扫描、新 schema、新持久 key、通用框架或数值 overlay。
- B-effective-Codex-numeric 扩展既有 `validateCodexRequestEvidence()`，只在 perf revision overlay 存在时使用第五个内部参数 `{samples,timingEvidence}`：从 immutable candidate 读取并验证 Codex request facts 后，按 `sample_key` 取 effective sample，按 `(home_id,response_id)` 在 effective timing evidence 中解析，再用既有 resolver 比较 `timing_source`、`duration_ms` 与 `request_count`。`complete` 对应 `explicit`，非 complete 必须为 `unknown` 且 duration 为 null；合法 late revision 可把样本降为 unknown，但仍须通过校验。原四参数创建/verify 路径、SQL 投影与返回形状不变；overlay 校验失败在 store 层统一为 `HISTORY_ARCHIVE_REVISION_INVALID`。effective timing 分支不再复制 `validateStoredEvidence()`：该既有 helper 仅增加 export，archive 对候选 evidence 行 `map(validateStoredEvidence)` 后再按行数判 conflict，available 返回 helper 的 `durationMs/reportedOutputTokens/requestedModel` 标准字段；校验顺序与原 timing store 一致。没有新增 schema、第二套 validator、writer、缓存或临时数据库。主审已接受该有效数值缺口（独立四文件 `4/4`，runner `703.5557ms`；typecheck exit 0）；这不宣布 16 整项完成。
- B15-commit-prepare 只新增 `prepareHistoryArchiveCommit(database, candidateFile)`，不提交、不登记、不选 authority、不删除事件、不移动 perf/timing，也不接 CLI/HTTP。调用先 `await verifyHistoryArchiveCandidate()`；验证结束后才在 source 连接上开 `SAVEPOINT history_archive_commit_prepare`，复用 `assertHistoryArchiveSourceMatches()` 校验范围内 events 与来源身份，再从同一事务快照捕获 `PRAGMA database_list` 的 `main.file` 规范绝对路径、完整范围内 `events` 指纹、原生 `events.id[]`、五列 source identities 与 `{dataVersion,totalChanges}` 输入修订；`main.file` 缺失（如 `:memory:`）以 `HISTORY_ARCHIVE_COMMIT_DATABASE_UNSUPPORTED` 明确拒绝，保存点内前后修订不一致时以 `HISTORY_ARCHIVE_COMMIT_INPUT_CHANGED` 拒绝。返回仅含 JSON 值的 `{formatVersion:1,scope:"events",candidate,source,deletion:{table:"events",ids}}` plan；`source.databaseFile` 是后继 commit 必须重验的持久 DB 身份，`source.events.sha256` 与 candidate metadata 精确相等，`deletion.ids` 是唯一一份 source DB 原生 id 集合。source identity 查询从既有 `sourceEvidence()` 提取为唯一私有 iterator，避免第二套 SQL；没有新 schema、表、持久 marker、备份格式或依赖框架。
- B15-executor-event-commit 在既有固定 worker 消息集加入 `historyArchiveEventCommit`：worker 只 await `store.commitHistoryArchiveEvents(message.plan)`，成功后 `postState()` 并原样返回；消息复用既有串行写尾链，client 只增加 `commitHistoryArchiveEvents(plan)` Promise wrapper。plan 作为普通 JSON 跨线程，不复制 store writer、事务、verify 或 replay 逻辑。
- B15-cli-explicit-event-commit 只把 `history archive <sourceDB> --commit <verifiedCandidateDB> --backup <newBundleDir> [--home-dir <dir>]` 接到既有组件：只读 source 上先 `prepareHistoryArchiveCommit()`，再 `publishHistoryArchiveBundle()` 并显式 `verifyPublishedHistoryArchiveBundle()`，验证通过后才创建 executor 并 `commitHistoryArchiveEvents(plan)`。`--dry-run` 仍走原 planner 与阈值；命令不自动选候选/范围、不覆盖既有目录、不切换服务，也不新增 HTTP 写接口、schema、候选生成或归档框架。
- B15-cli-replay-prepare 只在既有 `prepareHistoryArchiveCommit()` 内增加 replay 识别：候选仍先完整 verify；若 `archive_segments` 行与 candidate 的规范路径、digest、范围、event count 精确相等，event authority 已包含该 digest，且 `[start,end)` 内热 events 为 0，则返回同形状 plan，但 `deletion.ids` 与 source rows 为空；否则仍走原 `assertHistoryArchiveSourceMatches()` fresh 路径。CLI 不读取 registry/authority，store 的 replay 分支仍重验 candidate/manifest、登记行、authority 与零热残留后才 no-op 回滚。
- B-perf-timing-revision-read 在既有 `HISTORY_ARCHIVE_PERF_REVISIONS_META` 上增加 typed in-memory overlay，不新增 schema、表、writer 或恢复 API。v1 只允许 `perf_samples` 与 `perf_request_timing_evidence` 两张表；每条 revision 必须精确绑定已登记、已授权、digest 匹配的 segment 与现存 `source_files` 身份，payload 必须恰含目标表完整列，`removed`/`added` count 必须为正整数。原始 revision value 与 hot perf carrier、authority、registry 在同一 `history_archive_union_read` 保存点内捕获，释放后才连同捕获 record 读取已验证候选；同一个 `removed` payload 的重复 delta 累计消耗 immutable rows，不能重复借用同一行。所有 revision 应用后，effective `completed + codex + request_e2e + explicit` 样本必须保留至少一条由 dependency → rollout owner → native timing link 可达的链路，且该样本的每条必要 link 都必须在 effective evidence 中存在；无 link/无 owner 或任一所需 response 缺证据都拒绝。`added` sample 仍要求原 candidate 已有同一 `sample_key` 的依赖图；本卡没有新增 writer，也不改变其他 timing mode 的保留策略。
- B15-ZCode-supported-perf-commit 只在既有 commit plan 中增加 `perfDeletion`，不新增 schema、公开 API 或独立 perf writer。仅当已登记段范围内每个 hot perf sample 都是 `zcode` + `tps-v2`、候选四个 perf component key 全部存在、且没有任何 `perf_sample_sources` 依赖会被级联删除时，prepare 才返回精确的 `{table:"perf_samples",sampleKeys:[...]}`；fresh commit 在同一事务内合并该段的 ZCode perf authority、按这些 key 删除 hot samples，并返回 `deletedPerfSampleCount`。replay 只接受精确登记/授权、candidate 与 manifest 重验成功、范围内 hot perf 已为 0 的同一段，随后 no-op 回滚且不推进 revision。timing、source identities 与 native dependencies 仍保持 hot；mixed-kind、有依赖或自动选择的 perf 淘汰不在本卡。
- B15-Codex-supported-perf-commit 复用同一 `perfDeletion` plan，不新增 schema、公开 API 或第二套 writer。仅当注册区间内全部 hot perf 都是 `codex` + `tps-v2`、`completed` / `request_e2e` / `explicit` 且每个样本都有 `perf_sample_sources` 时，才生成该计划；ZCode 的无依赖规则不变。candidate 仍先经完整 verify，且只有四个 perf component 与 `history_archive_codex_requests_v1` 都存在并通过既有 request facts 校验时才允许计划；candidate 明确给出可删计划时，fresh prepare 才对 source/candidate 的 `codexRequestEvidence()` 精确比较；缺原生 manifest 的 legacy candidate 不生成 `perfDeletion`，但 events 仍按原校验提交并 replay，perf 保持热区且不写 perf authority。fresh commit 在同一事务内写 `sourceKinds:["codex"]` authority、按计划删除 `perf_samples`，其 `perf_sample_sources` 随样本主键级联；source identities、rollout/projection 与 timing graph 继续留在热侧。replay 仍要求登记/授权、candidate/manifest、零热残留精确匹配。
- B-perf-timing-revision-read 在既有 `HISTORY_ARCHIVE_PERF_REVISIONS_META` 上增加 typed in-memory overlay，不新增 schema、表、writer 或恢复 API。v1 只允许 `perf_samples` 与 `perf_request_timing_evidence` 两张表；每条 revision 必须精确绑定已登记、已授权、digest 匹配的 segment 与现存 `source_files` 身份，payload 必须恰含目标表完整列，`removed`/`added` count 必须为正整数。原始 revision value 与 hot perf carrier、authority、registry 在同一 `history_archive_union_read` 保存点内捕获，释放后才连同捕获 record 读取已验证候选；同一个 `removed` payload 的重复 delta 累计消耗 immutable rows，不能重复借用同一行。所有 revision 应用后，effective `completed + codex + request_e2e + explicit` 样本必须保留至少一条由 dependency → rollout owner → native timing link 可达的链路，且该样本的每条必要 link 都必须在 effective evidence 中存在；无 link/无 owner 或任一所需 response 缺证据都拒绝。`added` sample 仍要求原 candidate 已有同一 `sample_key` 的依赖图；本卡没有新增 writer，也不改变其他 timing mode 的保留策略。
- B-codex-late-timing-revision-write 复用既有 history_archive_perf_revisions v1，不新增 schema、表或公开 API。Codex publication 在既有写事务前从已授权且已验证的 immutable candidate 捕获目标 sample、原生 linking evidence 和 `source_files` 五列来源身份；捕获前记录热连接 `PRAGMA data_version`/`total_changes()`，进入 `BEGIN IMMEDIATE` 后、任何写入前必须仍相等，否则以 `HISTORY_ARCHIVE_PERF_REVISION_INPUT_CHANGED` 拒绝并允许整轮重试。事务内只对同一 sample_key、同一 source_path 且来源五列仍与 candidate 精确相同的重算 sample 生成相对 candidate 的累计 delta：perf_samples 移除旧 candidate payload 并加入当前已发布 payload，perf_request_timing_evidence 只加入/移除 candidate 与当前原生 link 集合的真实差异；同一 native evidence 主键被多个 sample 共享时只贡献一份 delta。writer 按现有 (segmentId,factTable,sourceIdentity) binding 覆盖而不是追加，并以稳定排序序列化；sample 替换、恢复事实、dirty timing、perf revision metadata 与 publication 共用同一 COMMIT，no-op 不重写等价 bytes。
- B-rollup-complete-events-seam 引入模块级 `rebuildUsageRollupsFromEvents(db, { days, events })`；B-rollup-multi-UTC 将其输入从单个 `day` 扩展为 UTC `YYYY-MM-DD[]`。它把完整 `UsageEvent[]` 的重建字段只写入一次固定私有 TEMP 表，再把 `days` 数组直接交给 `rebuildUsageRollupsFromSource()` 一次执行，复用原 SQL、16 个 model 指标与 rollup 关系；没有持久 schema、表名参数、聚合实现或 hot event 回流。固定 TEMP 表名仍使该入口在同一 SQLite 连接内不可重入/并发调用，`UsageStore#rebuildHistoryRollupDay(day)` 只传 `days:[day]`。
- B-store-cold-rollup-day 提供异步 `UsageStore#rebuildHistoryRollupDay(day)`。它接受严格 UTC `YYYY-MM-DD`，要求 store 已打开且调用时没有活动事务；内部 `BEGIN IMMEDIATE` 覆盖 `publishedHistoryUsageEvents()` 的捕获/验证与 `rebuildUsageRollupsFromEvents()`，成功后只推进既有 `storeRevision` 并走原派生缓存失效入口，失败整体回滚。没有新增 schema、revision 系统、authority API、返回形状或同步读替换；固定 TEMP 表与完整 events 内存限制沿用冻结模块。
- B-cold-rollup-writer-lock 不新增生产接口、参数、schema 或 hook；只在专用测试内临时 patch `publishedHistoryUsageEvents()` 建立确定性 await 窗口，并在 `finally` 恢复。第二连接、`busy_timeout=0` 与热尾更新都属于测试夹具，不会被生产代码感知。
- B-store-full-dual-zone 扩展无参数 `UsageStore#rebuildHistoryRollups()`：同一 `BEGIN IMMEDIATE` 和同一完整 carrier 上，UTC/local 各调用一次既有 `rebuildUsageRollupsFromEvents()`，成功后写 `usage_rollup_local_zone_identity` 并只推进一次 revision。日期集由 events 首末范围（含空日）并四表已有 `day_key` 组成；单日 `rebuildHistoryRollupDay(day)` 仍只重建 UTC。未新增公开参数、schema、配置、缓存或算法。
- B-executor-history-rebuild 在既有固定 worker 消息集加入 `rebuildHistoryRollups`，worker 只 await `store.rebuildHistoryRollups()`，成功后 `postState()` 并返回 `{rebuilt:true}`；client 增加同名 Promise wrapper。该消息复用既有 sync/backup/snapshot 串行尾链，没有新增 worker、队列、HTTP/CLI 入口、facts 写路径或发布 reader 改写。
- B-cold-rollup-sync-regression 只新增 `test/history-cold-rollup-sync.test.js`，没有生产接口、schema、缓存或路由变化。测试复用真实 Codex 来源、归档候选、authority、完整双 zone 重建和未归档 oracle，只比较 hot facts 与 UTC/local 四张 rollup 表。
- B-cold-rollup-sync-fix 只改普通 `sync()` 轮末既有 rollup 维护分支：无授权段时继续原 hot `rebuildUsageRollups()` 快路；存在非空授权段且 day dirty 或 local zone 变化时，用 `BEGIN IMMEDIATE` 保持写锁，await `publishedHistoryUsageEvents()` 的完整冷热 union，再以 `rebuildUsageRollupsFromEvents()` 只发布原 dirty UTC 日及所需 local 日。没有新增公共 API、schema、参数、缓存或每轮全历史表重建。
- B-cold-rollup-sync-local-rollback 只扩展既有真实夹具，没有生产接口、schema、缓存或路由变化。测试用本地 `BEFORE INSERT` trigger 仅在该次 `sync()` 已把 UTC `2026-07-12` daily total 写成 `150` 后拒绝 local 同日插入，从而证明失败发生在 UTC 批次完成、local 批次进行时；`sync()` 拒绝后 hot facts 保留已提交的 `50`，UTC/local 三张聚合表仍全等失败前的 `140`，dirty 仍为 `["2026-07-12"]`。删除 trigger 后无需重解析源文件即可重试，四张表恢复为未归档 oracle `150`，dirty 清空；既有缺段阶段再推进到 `160` 并重复同一恢复契约。失败快照故意排除 `usage_rollup_days`，因为已提交的 event triggers 在轮末事务前已使 day markers 失效；本卡不宣称整个 `sync()` 原子。
- B-cold-rollup-sync-zone-change 只新增 `test/history-cold-rollup-sync-zone.test.js`，生产代码、schema、缓存和路由均未改。测试用两个子进程只覆盖 `TZ`，其余环境（含 `HOME`/`CODEX_HOME`）原样继承；旧 `Asia/Shanghai` 阶段以真实冷 authority 和普通 `sync()` 把 `23:30Z`、`23:50Z` 两个事件写入 local `2026-07-13`（2 事件/130），新 `America/Los_Angeles` 阶段无源变化（`updatedFileCount=0`）再次普通 `sync()`，只由 persisted local zone identity 触发轮末 local 重建。返修后逐列比较三张 aggregate 表并与 oracle 全等，oracle 已有 local marker 逐列匹配；目标额外的 `2026-07-13` marker 核对为洛杉矶真实日界 `[2026-07-13T07:00Z, 2026-07-14T07:00Z)`，不是旧上海日界。测试只在未归档 oracle 上调用既有 `rebuildUsageRollups()` 补建该空日，再用公开 `queryUsageRollups()` 对拍目标与 oracle：两边都返回已构建空日，event/session/home 与全部 token 计数为零。目标 store 没有显式重建；初红“四表物理全等”属于过严布局断言，不是已确认业务缺陷。
- B-period-executor 保持执行器 `periodComparison` 请求名和 client Promise wrapper 不变，只把独立消息分派目标改为 `store.periodComparisonHistory`；`dashboard.periodComparison` 改为 await 同一 `reader.periodComparisonHistory`，其中 reader 仍是 `publishedStore || store`。summary/metadata、metadata 时点参数、pricing 注入和串行队列均不改，也没有新增 server/public API。
- B-summary-executor 保持 `summarize` / `dashboard` 消息名和 client Promise wrapper 不变：独立 `summarize` 调用 `store.summarizeHistory()`，dashboard 对 `publishedStore || store` 调用 `reader.summarizeHistory()`，随后在同一请求内调用 `reader.periodComparisonHistory()`。`metadata` 仍是同步热读，不改变 `now` 参数、pricing 注入或串行队列；没有新增 server/public API、参数或持久状态。
- B-cold-metadata 提供异步 `UsageStore#metadataHistory(asOf)`，无 authority 时在 `SAVEPOINT metadata_history_read` 内委托原 `metadata(asOf)` 并保留缓存快路；有 authority 时在 `history_archive_union_read` 内额外捕获 `{generatedAt, homes: this.homes, warnings}`，与 cold+hot events 一起释放后才计算。返回字段保持原 `metadata()` 形状，不新增公开参数或 schema；executor/API/Dashboard 仍未接该入口。

- B-cold-summary-sync-seam 新增同步 `UsageStore#summarizeHistoryReport(report, filters, options)`。调用方必须先取得带内部 `perfCarrier` 的完整历史 report；方法只在其上同步执行 `excludeHomes`、共享 `summarizeUsage()`、records 与 `buildPerfSummaryForRange()`，返回与 `summarizeHistory()` 相同的摘要形状。async `summarizeHistory()` 在 report await 后委托该同步方法；无 authority 路径和缺段拒绝不变。静态 `withoutExcludedHistoryHomes()` 只过滤 `events`、`sessions`、`perfSamples`，与 server helper 同语义；没有新增持久状态、公开参数、缓存或 schema。

- B-cold-freeze-HTTP-read 的 server `createSnapshot()` 在 snapshot 对象中记录 executor 返回的 `cleanupDirectory`（无 staging 时为 `null`）；冻结读取分支以快照库的 `archive_segments` 是否存在区分冷快路与原同步快路。冷快路使用 `publishedHistoryUsageReport({ includePerfCarrier:true })`、同步 `summarizeHistoryReport()` 与 server 既有 `summarizePeriodComparison()`；没有新增 bundle、worker 消息、公开参数或持久状态。该卡当时不消费清理字段，生命周期由下一卡补齐。
- B-cold-freeze-pricing 没有新增接口，只把真实 HTTP freeze/snapshot 入口的既有 catalog `try/finally` 契约扩展为黑盒断言：A 在 freeze 时捕获，B 成为 live 后 snapshot summary 与 `/api/pricing` 都仍为 A；同步冷摘要抛错时响应为 500 且 live B 已恢复。测试内的 `UsageStore.prototype.summarizeHistoryReport` patch 只存在于单次请求窗口并在 `finally` 还原，不是生产 hook。
- B-cold-hot-tail-revision 不新增接口或持久状态，只验证现有 `historyArchiveReparsePrefixes()` 对未变冷前缀的匹配，以及 `replaceFile()` 对范围内热事件的正常替换与 `history_replaced_facts` 写入。测试不改 authority、候选包、schema、sync API 或冷报告接口；冷前缀通过源文件字节与候选 digest 双重锁定。
- B-cold-snapshot-cleanup 新增 server 私有 `removeSnapshotArtifacts(snapshot, snapshotDirectory)`：先关闭 snapshot store，再仅处理 resolve 后仍位于本 server `mkdtemp` 私有目录内的确切主库、WAL、SHM，以及由该主库路径推导出的 `<databaseFile>.segments`。executor 提供的任意 `cleanupDirectory` 字符串不参与删除。`createSnapshot()` 在打开 store、写入 homes/tier/warnings、读取 metadata 与 imports 全部成功后才 `snapshots.set()`；任一步失败只清理本次产物，不改变有效旧快照。第 9 个快照淘汰最旧项时使用同一 helper。server close 仍按整个私有目录递归删除，`server.close()` 的 Promise/callback settle 会等待该清理完成；没有生产 test hook、新依赖或通用资源框架。
- dashboard-shared-carrier 已在根仓接入异步 `UsageStore#dashboardHistory(filters, options)`，仅在 `store_meta.history_archive_event_authority` 存在时先尝试 `trySqlHistoryDashboard`；当前专用测试对单段不变范围记录 `historyArchiveEventUnionForRange` 的 `calls=0`，说明该范围走已验证 SQL 快路而不是完整 carrier。SQL 快路返回 `null` 时才使用 `historyArchiveEventUnionForRange({ completeHistory:true, includeUsageCarrier:true, includePerfCarrier:true, includeMetadataCarrier:true })` 构建 summary/metadata/period；只存在 perf authority 时仍按原 `summarizeHistory()`、`metadataHistory()`、`periodComparisonHistory()` 三入口调用，因此 summary 冷而 metadata/period 热的原语义不变。event-authority 分支的 metadata 默认时点已修为 `filters.now ?? new Date()`；当前专用测试覆盖省略 `now`、完整字段对拍、excludeHomes、缺段拒绝/恢复和 HTTP 130/2。回退路径仍会物化完整历史与 perf carrier；`publishedUsageEventsFromUnion()` 已在原数组原地投影，不再生成第二份完整事件数组。

- history-backup fingerprint 候选只改 `src/history-backup.js#tableFingerprint()`：`.all()` 改为 `.iterate()`，count 在迭代中累计；没有新增公开接口、schema、配置或缓存。固定 16 张必需表、SQL、行序、列、JSON 序列化、换行、count 与错误路径保持不变。sealed candidate 的候选/验证脚本/patch 分别为 `EE40EAFA…` / `9C9EDDED…` / `04DFBBC1…`，前像为 `053FFE26…`；Main 已推广该候选并记录历史根回归 13/13（runner 5467.9969ms），16 表 fingerprint 等价与 tamper 拒绝均通过。当前根仓 `src/history-backup.js` 为 `4D56EDBB…`，包含此 `.iterate()` 之外的 stream-hash/verified-evidence 改动，不能把当前根仓当作 sealed candidate 重测。`candidate.patch` 为 CRLF；LF 规范化副本 `EF27137C…` 才能对 clean preimage 直接 apply-check，应用后逐字节等于候选。没有性能测量，也没有改变其它 backup 路径。

- B19 cold dashboard summary phase 不新增生产接口，只交付两个未推广 patch：`phase-hook.patch` 以 `CODEX_COLD_SUMMARY_TRACE_FILE` 为唯一开关，在现有 `dashboardHistory()` 的 `carrier`、`events`、`sessions`、`summary`、`metadata`、`period` 接缝写 JSONL 阶段耗时；`sessions-key-candidate.patch` 只把 `publishedUsageSessionsFromEvents()` 的 `JSON.stringify([homeId, sessionId])` 键改为嵌套 `Map`，保留缺失 home 抛错、last-event channel/cwd/model、用量累计与最终排序。两者均未改根仓、未推广；phase hook 不改变返回值、不新增公开 option、不测量 hot SQL。
- I-full-events 提供同步 `UsageStore#publishedUsageEvents()`，要求 store 已打开，否则抛 `UsageStore is not open`。返回值为完整 `UsageEvent[]`，每项包含 `timestamp`、`sessionId`、`homeId`、`homeLabel`、`sourceKind`、`channel`、`project`、`model`、`cwd`、`repositoryKey`、`repositoryPath`、`repositoryKind`、`detailMask`、`reconciliationGap`、`cacheWriteTokens`、`cacheWriteKnown`、`requestInputTokens`、`contextLevel`、`serviceTier`、`priceVersion` 与 `total`。没有范围参数、分页参数或 side effect。
- I-full-homes 提供同步 `UsageStore#publishedUsageHomes()`，要求 store 已打开。它一次读取 `DISTINCT home_id, home_label, home_path, kind FROM source_files`，按 `home_id` 排序并去重为 `{id, label, path, kind}`；同一身份的多文件行折叠为一个 home，同一 `home_id` 的异身份行抛 `PUBLISHED_HOME_IDENTITY_CONFLICT`。没有写 SQL、sync、missing 推断、home 注册或调用方参数。
- I-full-sessions 提供同步 `UsageStore#publishedUsageSessions()`，要求 store 已打开。会话键是 `(homeId, sessionId)`，返回字段固定为 `id`、`homeId`、`homeLabel`、`homePath`、`firstAt`、`lastAt`、`eventCount`、五字段 `total`、`channel`、`cwd`、`model`；排序键为 `lastAt, homeId, id`。事件表没有 home 对应身份时明确抛 `PUBLISHED_SESSION_HOME_MISSING`；home 身份冲突仍由 `publishedUsageHomes()` 抛 `PUBLISHED_HOME_IDENTITY_CONFLICT`。没有写 SQL、sync、范围过滤或原日志额外字段。
- I-full-carrier-snapshot 提供同步 `UsageStore#publishedUsageReport()`，要求 store 已打开。返回对象键固定且顺序为 `events`、`homes`、`sessions`、`rateLimitObservations`；`rateLimitObservations` 直接复用现有 `quotaObservations()` 的规范映射，不另写 SQL codec。读取期间使用单一名为 `published_usage_report_read` 的保存点；成功释放，失败回滚到并释放该保存点，不提交或回滚外层事务。没有写入 SQL、source 文件读取或公开参数。
- I-full-quota-snapshot-cache 给 `quotaObservations([options])` 增加内部选项 `useCache`，默认 `true`，只有 `publishedUsageReport()` 传 `false`。关闭时仍执行同一 SELECT/codec 和 `syncDerivedRevision()`，但不读也不写 `quotaObservationCache`；因此外层未提交 quota 变更能被报告读取，保存点回滚后旧已提交 memo 保持有效。没有新增缓存、TTL、事件总线或第二套 quota codec。
- B19-cost-model-count 不新增公开接口、参数、schema 或全局缓存。`createCostEstimateAccumulator().add()` 在 accumulator 闭包内保存当前 `models` 对象身份与 raw-model → canonical 的局部 `Map`；对象身份改变时清空，单次 `add()` 仍读取当时生效的价目。baseline 为当前根仓 `src/pricing.js` 字节，候选仅替换该 canonical 调用点；功能对拍通过，但主审独占 100k 配对无性能收益，最终拒绝推广，根仓 pricing 保持 baseline。

## 行为

- Codex：单 rollout、部分线程和整个 home 消失时，保留 `source_files`、`perf_samples`、`perf_sample_sources`、`perf_rollout_threads` 及完整线程归属；保留最后完整候选和 ownership。
- Codex 压缩转换：用 `canonicalPerfProbePath(plainRolloutPath(...))` 识别 plain/zstd 是同一 rollout；替换前保全旧 plain sibling events 与 quota，转换成功后移除旧表示但 live event/quota 总数不变，也不重复累计性能事实。
- Codex 线程发布：受影响线程按旧 `sample_key` 捕获样本与依赖后删除并重建；新发布提交前按旧 `source_path` 做多重集差集。相同键的时间字段修改保留旧完整样本；依赖的 `role` 或 `source_path` 变化保留旧依赖行；未变依赖仍作为 live 行保留，不写入历史表。
- 通用改名：只有旧路径唯一、新路径唯一，且 kind/home/内容签名一致时才建立替换；新路径成功提交后才允许删除旧来源身份。若新路径本轮提交失败，即使它已有上轮成功行，也不会删除旧身份。
- 非 Codex：普通缺失只登记 missing；不再因“本轮未发现”直接删除 `source_files`。只有上述已提交替换/改名场景会删除旧行。
- 已覆盖 Claude、WorkBuddy、DSH、ZCode、OpenCode 和移除导入目录。一个来源缺失时，其他来源的新事件和样本继续入库。
- WorkBuddy 时长：trace 重解析只把新的 `(home_id, message_id, duration_ms)` 观察追加到 observation 表，旧观察不删除；同一 message 有多个不同时长时，投影选择返回 `null`，采样暂停但原始观察和 usage/source 身份仍保留。
- 不可读与缺失分离：仍被 discovery 发现但读取失败进入既有 degraded/告警路径；确实未被发现且 home 未失败才进入 missing。
- 恢复：文件或目录回归后按原路径重新解析，原生键去重；缺失标记被移除，历史行数不翻倍。
- 重解析：在 upsert 前读取旧 `source_files` 身份和该路径全部旧 events；Codex 还在删除 sibling 前读取 sibling 身份、全部旧 events 和 quota。新 events 与新 source 行写完后，分别统计新旧规范 payload 摘要的出现次数。只有 `旧份数 > 新份数` 时才记录差值，因此同内容 2→1 会留下丢失的 1 份证据。
- 非 Codex perf：同一事务在 `DELETE FROM perf_samples` 前读取本路径旧样本及其全部依赖；重解析后分别对样本和依赖做 payload 差集。样本未变不写新行；sample_key 变更或 payload 修改保存旧样本，级联删除后未重新出现的依赖保存旧依赖行。
- 去重与幂等：同一摘要复用主键，冲突时只把 `occurrence_count` 提升到已有值与本次缺失值的较大者；不会新增第二行，也不会把重复重解析累计成 2、3、4 份。
- 普通追加：旧份数不大于新份数时没有缺失差值，不写恢复表；合法修改或删除会产生缺失差值，旧 payload 和原 source 上下文随之保留。对 project-log 连续 100 次追加新事件，live event 数每轮增长，恢复表行数、`occurrence_count` 总数与 payload 字节总量不增长。
- quota：同一事务内比较当前路径新旧 `rate_limit_observations` 多重集，共用 `saveMissingHistoryFacts()`；Codex sibling quota 在删除前单独捕获并按旧 sibling 身份保存。payload 是旧表完整行，包含 `limit_name` / `plan_type` / `used_percent` 的 `NULL` 值和真实 `observed_at_ms`，不是入库时间。
- rollup 同步：首次同步先建表/触发器再写 facts，事件插入/删除/更新时间戳会由触发器把旧、新 UTC 日加入 dirty 并删除对应已建日标记；发布成功并完成 C5 缓存失效后，重建 dirty UTC 日及其保守 local 投影。local 时区身份变化时，即使 dirty 为空也会一次性从 events UTC 日与既有 local marker 推导 local 重建集合，UTC cache 原样保留。UTC 或 local 任一侧失败时外层 savepoint 回滚两侧已建标记/行、dirty 清除与身份更新；同 zone 的 no-op 轮只查询 dirty 列表，不扫描 events、不准备重建语句。
- 模型周期对比：完整、部分毫秒、local 风格、无界、空窗口及 `excludeHomes` 输入均以同一半开窗口规则读取 `usage_rollup_models`，并与原 `events` 模型聚合深度相等；模型即使只在来源范围而不在请求周期内仍以零周期保留。删除完整 rollup 日只触发一次原 SQL 回退，破坏日表列则原错误直接抛出。
- 冷感知周期对比：无 authority marker 时 marker 与首次 period SQL 在同一读快照内，保持原 hot-only 聚合与缓存；外连接在 marker 后提交 authority/删热不会把首次结果切成新热视图。有 marker 时释放短快照后用完整热冷事件载体重新计算，因此 period totals、models 与 repositories 能看到授权冷段。UTC、local 和排除 home 都使用与未归档 store 相同的共享聚合语义；缺失授权段时整个异步入口失败，不会退回只含 hot 的部分结果。同步调用方和同步缓存仍只看到各自修订的热事实。
- 冷感知摘要：无 authority 时 marker、quota、events 聚合、timeline、homes/projects/repositories 和原派生缓存都在同一 SQLite 读快照内，结果与同步 `summarize()` 一致；外连接在 marker 后提交 authority/删热/改 quota 时，首次摘要仍返回旧快照值，下一次调用才检出提交并清缓存。有 authority 时完整 report 的 events 按 `excludeHomes` 过滤后交给共享 `summarizeUsage()`，真实 `100 cold + 30 hot` 的 totals/range/timeline/channels/models/projects/repositories 与未归档 oracle 相同；`includeDetails:false` 也保留原裁剪形状。缺段时整个摘要失败。当前共享内存算法不产出 store-only `records` 和冷 `perf`，这两项未在本卡伪装为可用。
- 冷前缀值修订：同一物理来源、来源身份和 `(timestamp_ms, session_id)` 集合保持不变时，累计 token 值可以改写授权冷前缀。writer 比较原始/effective/observed 三者，新增、删除或时间戳/session 迁移仍抛 `HISTORY_ARCHIVE_COLD_REPARSE_CHANGED`；成功时 revision metadata、替换证据和源文件 facts 在同一事务提交，失败整体回滚。重复修订原地覆盖同一 entry，读取仍先应用 candidate 再应用当前累计 delta，因此不会把上一版 delta 叠加两次。
- schema 21 迁移：v20 库只执行冻结 DDL 建空 `archive_segments`，事务内自检成功后抬到 21；全新库在 version 0 建表路径创建同一张表。重开不插入、不删除、不读该表，已有事实表逐行不变。
- 归档登记：候选先通过 manifest、数据库摘要、区间事件指纹和候选内源身份指纹验证；随后在写事务内对源库重新核对相同 events 与 source 身份集合。事件值改变但行数不变、source 身份值改变但行数不变都会抛 `HISTORY_ARCHIVE_SOURCE_CHANGED`。同 digest 重登记不改变目录；不同 digest 的半开区间重叠抛 `HISTORY_ARCHIVE_SEGMENT_OVERLAP`。登记前后热事实逐行不变。
- 归档单段读取：未知 `segmentId` 明确拒绝；已登记段先重新验证候选包，再与目录的 digest、半开边界和 events 行数逐项比对。只读连接 `BEGIN` 后先用 `assertHistoryArchiveSourceMatches()` 在同一次 SQLite 快照内复核 events/source，成功才按 `id` 返回完整候选事件行，最后 `ROLLBACK`/关闭。缺段、篡改或 verify→快照之间的同数量改写都抛错而不是返回空数组；读取前后热事实与目录行逐行不变，不发生隐式登记、热冷合并或范围查询切换。
- 归档权威读取：存在 v1 authority 时，已授权段先检查同步捕获的完整段 hot rows；非空抛 `HISTORY_ARCHIVE_HOT_COLD_CONFLICT`，空则返回同一已验证冷快照中的原始 rows，并按请求 `[startMs,endMs)` 过滤。同一 payload 在冷段出现 N 份就保留 N 份，不因热侧为空而变少或翻倍；段间未登记 gap 和请求范围内段外 hot rows 继续返回。冷段 row 的每个 `source_path` 都必须有冷快照来源身份，且该来源与保存点内 live `source_files` 的身份逐字段相等；来源被改值或删除时明确冲突，不因 hot rows 为空而伪造“无来源”。未授权相交段仍要求完整 hot/cold 多重集和来源身份镜像。
- 完整热事件读取：来源文件消失但 `source_files` / `events` 仍保留时，`publishedUsageEvents()` 继续返回原事件；文件恢复后重新同步不会产生重复。不同来源共享同一 `sessionId` 时返回全部事件并分别保留各自实际 `sourceKind`，不按 session 合并或过滤。
- 完整来源身份读取：两个真实 home 成功发布后，来源目录消失仍从保留的 `source_files` 返回两 home 的原 `id/label/path/kind`；恢复来源再同步不增加重复 home。同一 home 的多个文件只返回一个身份；人为制造同 `home_id` 的异 label 会明确拒绝而不是任选一行。
- 原子性：删除当前投影、写入新 events、写 `history_replaced_facts` 都在 `replaceFile` 的同一个 `BEGIN IMMEDIATE` 事务内；任一步失败应随事务回滚。

## 实际写入与删除点

| 位置 | 当前行为 |
| --- | --- |
| `src/usage-store.js:2387` | 每个写连接设置 `PRAGMA journal_size_limit = 67108864`；它不是活动 WAL 的硬上限。 |
| `src/usage-store.js:3784` / `:3787` | `replaceFile` 在 upsert 和删除前捕获当前 `source_files` 身份及该路径旧 events。 |
| `src/usage-store.js:3788` / `:3791` / `:3798` / `:3801` | 同一事务内捕获当前路径旧 quota，并按 `path + home_id` 捕获 sibling 完整身份、全部旧 events 及全部旧 quota。 |
| `src/usage-store.js:3806` / `:3809` | 非 Codex 在删除前捕获本路径 `perf_samples`，并 join 捕获这些样本的全部 `perf_sample_sources` 依赖。 |
| `src/usage-store.js:3838` / `:3839` | sibling events 与 sibling quota 都从 live 表删除；两者均已在删除前捕获。 |
| `src/usage-store.js:3844` | 非 Codex `perf_samples` 按 `source_path` 删除；其依赖经 FK `ON DELETE CASCADE` 一并消失。 |
| `src/usage-store.js:306` | `saveMissingHistoryFacts()` 统一做规范 payload、多重集差值与 `occurrence_count` 写入，events 和 quota 共用。 |
| `src/usage-store.js:3750` / `:3907` / `:3917` / `:3927` / `:3938` | 同一插入语句分别接收当前 events、sibling events、sibling quota 与当前 quota 的缺失份数，写入 `history_replaced_facts`。 |
| `src/usage-store.js:3754` | 同摘要冲突时取 `MAX(existing occurrence_count, excluded occurrence_count)`，保证重复重解析不膨胀。 |
| `src/usage-store.js:3916` / `:3921` | sibling 旧 events 以旧 sibling 的完整身份写入；删除后该路径 currentRows 为空，因此旧 payload 全部进入恢复表。 |
| `src/usage-store.js:3926` / `:3934` | sibling 旧 quota 按同一旧身份写入，`fact_table='rate_limit_observations'`、`method_version='rate_limit_observations.v1'`。 |
| `src/usage-store.js:3937` / `:3943` | 当前路径 quota 差集继续使用相同 fact table 与方法版本写入。 |
| `src/usage-store.js:4104` / `:4113` | 非 Codex `perf_samples` 与 `perf_sample_sources` 分别按差集写入；样本未变不新增，旧依赖全部可恢复。 |
| `src/usage-store.js:5329` / `:5337` / `:5345` | Codex 发布事务在删除旧线程候选前，按 `replaceOldThreadIds` 的旧 `sample_key` 捕获完整样本与全部依赖，并按各自 `source_path` 分组。 |
| `src/usage-store.js:5355` | Codex 旧样本在捕获后才删除；依赖经既有 FK 级联删除。 |
| `src/usage-store.js:5407` / `:5415` / `:5428` | 重建/合并完成后，分别对 `perf_samples` 与 `perf_sample_sources` 做规范 payload 多重集差集并写恢复行；来源身份优先取发布前旧 `source_files` 行。 |
| `src/usage-store.js:4460` / `:4491` / `:6071` | 仅当稳定 project-log 的旧源大小为真且新文件更小、live events 行数减少时生成截断诊断；成功替换把 marker 写入 `perf_file_warnings`，`syncRound()` 从已提交 sidecar 重建 warning，回滚不发布。 |
| `src/usage-core.js:1473` / `:1802` | 非 zst JSONL 解析失败时把行号交给可选回调；只有 project-log 生成包含物理路径和行号、但不含行内容的 warning，其他 reader 不传回调。 |
| `src/usage-core.js:1803` | project-log 坏行 warning 在同一回调中附带 `{lineNumber}` 第二参数；不新增回调、不读取行内容，其他 caller 忽略该参数。 |
| `src/usage-store.js:4085` / `:4215` / `:4471` / `:5504` | 行号在替换事务内收集为结构化集合，成功提交后写入 `PROJECT_LOG_MALFORMED_JSONL` marker；全合法重解析删除该 marker，回滚/未提交替换不写。 |
| `src/usage-store.js:2262` / `:6074` | sidecar 解码只保留合法正整数的排序去重 `lineNumbers`；`syncRound()` 按已提交 marker 重建与当前轮一致的路径 + 行号 warning。 |
| `src/usage-store.js:5268` | `replacementCommitted()` 只承认本轮成功提交，或本轮未失败且上一轮已有成功行的替换目标。 |
| `src/usage-store.js:5276` | 未提交替换的缺失旧 rollout 及其线程被保留，不进入删除/重建候选。 |
| `src/usage-store.js:5313` / `:5388` | Codex 仅在本轮版本迁移/替换已提交时删除旧 rollout 的 `source_files` 行。 |
| `src/usage-store.js:5455` | 非 Codex 旧行只在唯一替换已提交时删除；普通缺失不进入 DELETE。 |
| `src/usage-store.js:5473` / `:5487` | 轮末根据当前 `source_files`、discovery、failed home 和替换结果重建 missing 集合。 |
| `src/usage-store.js:5749` / `:5752` | `perf_index_version` 与 missing 集合和发布状态等在同一轮末事务提交。 |
| `src/usage-store.js:6758` | 索引汇总构造 `summary.perf` 时复制 `perfState.missingSources`，只按本次 `scopeExclusions` 排除 home；不按事件日期过滤，也不改 `ready`、`degraded`、排名、分组、覆盖率或统计。 |
| `src/usage-store.js:910` / `:6122` / `:6126` | `completeRollupDays()` 只接受显式 UTC/local 整日非配额范围；UTC 用整日毫秒边界，local 用本地午夜与下一本地午夜校验。`aggregateRange()` 优先查询 rollup，仅捕获 `ROLLUP_DAYS_MISSING` 后回退原 SQL。 |
| `src/usage-store.js:6992` / `:6994` / `:7011` / `:7039` / `:7047` / `:7065` | 仅精确模型维度进入 `period_model_rollup`；同一保存点内读取 scoped `MIN/MAX`、把周期闭端转换为半开 `+1`、按需补齐来源模型集合并逐周期读取 `usage_rollup_models`。只把 `ROLLUP_DAYS_MISSING` 吞成原模型 SQL 回退，其他错误原样抛出。 |
| `src/usage-store.js:4233` | `syncRound()` 在任何来源事实写入前调用 `createUsageRollups()`；首次创建会种入现有 UTC dirty 日，已有 format 2 只做快速检查。 |
| `src/usage-store.js:5909` / `:5911` / `:5922` / `:5934` | 发布事务提交后先完成 C5 派生缓存失效与修订对齐，再读取 dirty UTC 日与 local 时区身份；仅身份变化时单次扫描 events UTC 日并合并既有 local marker，再由 `localUsageRollupDaysForUtcDays()` 投影。UTC 与 local 在同一外层 savepoint 中按需重建，成功后才写身份；任一侧失败时外层回滚身份、两侧缓存与 dirty 队列。 |
| `src/perf-request-timing-store.js:36` / `:108` | timing evidence 的联合主键包含 `variant_key`；variant 覆盖除 origin、response identity 外的规范观测值，所以改变观测不会覆盖旧证据。 |
| `src/perf-request-timing-store.js:288` / `:293` | evidence 使用 `INSERT ... ON CONFLICT DO NOTHING`；没有 evidence 的 UPDATE 或 DELETE。 |
| `src/perf-request-timing-store.js:296` / `:306` | thread link 同样只 `DO NOTHING`；已有 response→thread 链接不同则抛 `REQUEST_TIMING_THREAD_CONFLICT`，不会改写原链接。 |
| `src/perf-request-timing-store.js:341` / `:347` | import 唯一会变化的是 `perf_request_timing_meta.revision`；evidence 和 link 表不参与 revision 更新。 |
| `src/usage-store.js:3095` / `:3117` | timing import 包在 `BEGIN IMMEDIATE` 中；任一步失败走 `ROLLBACK`，不会留下部分 evidence/link。 |
| `src/usage-store.js:5444` | Codex 发布成功只删除 `perf_request_timing_dirty_threads` 标记；evidence 和 thread-link 表不在此删除路径。 |
| `src/usage-store.js:2794` / `:2796` | v20→21 在既有 `migrate()` 事务内创建空 `archive_segments`，自检列、`STRICT`、`CHECK` 后抬版本；失败整体回滚。 |
| `src/usage-store.js:2825` / `:2827` | 全新库在 version 0 路径建同一张表并用当前常量落版本。 |
| `src/usage-store.js:3252` | `UsageStore#registerHistoryArchiveCandidate()` 先动态导入 archive 校验，不引入顶层循环依赖。 |
| `src/usage-store.js:3266` / `:3268` | 验证候选后才开启短 `BEGIN IMMEDIATE`，并在事务内重算源 events 与 source 身份集合。 |
| `src/usage-store.js:3275` / `:3300` / `:3313` | 同 digest 返回既有单行；不同 digest 的半开范围重叠拒绝；通过后才 INSERT 绝对路径、区间、events 行数和登记时间。 |
| `src/usage-store.js:3342` / `:3357` | 单段读取按 id 查目录；未知 id 明确抛 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND`，然后复用候选验证。 |
| `src/usage-store.js:3360` / `:3373` / `:3376` / `:3378` | 包 digest、边界和 events 行数必须与目录一致；只读打开后 `BEGIN`，在同一快照内复用 events/source 摘要断言。 |
| `src/usage-store.js:3379` / `:3389` | 断言通过才按 id 返回完整 events；`finally` 中 `ROLLBACK` 并关闭只读连接。 |
| `src/usage-store.js:3478` / `:3499` / `:3591` / `:3612` | `mergeHistoryArchiveEventsForRange()` 读取 v1 authority；已授权段 hot 非空或 live source 身份变化都抛 `HISTORY_ARCHIVE_HOT_COLD_CONFLICT`，读取路径只 SELECT，不写 `store_meta`、`events` 或目录。 |
| `src/usage-store.js:546` / `:4326` / `:5437` | 冷重解析按 immutable/effective/observed 三组 rows 识别一一对应的值修订，并把当前累计 delta 原地更新为每段/source 一个 entry；新增、删除或身份迁移仍拒绝整笔替换。 |
| `src/usage-store.js:5450` / `:636` | 覆盖既有 revision 时用既有 `saveMissingHistoryFacts()` 保留上一 effective payload；成功修订把变化 timestamp 的 UTC 日标 dirty 并删除覆盖该时刻的 UTC/local day marker，随后由普通 sync 的完整冷热 rollup 路径重建两侧。 |
| `src/usage-store.js:6414` | `publishedUsageEvents()` 只执行一条 `events JOIN source_files` 的 SELECT；没有 INSERT、UPDATE、DELETE、sync、登记或冷段访问。 |
| `src/usage-store.js:6459` | `publishedUsageHomes()` 只执行一条 `source_files` 身份 SELECT，在内存按 `home_id` 去重；冲突抛 `PUBLISHED_HOME_IDENTITY_CONFLICT`，没有写 SQL、sync 或 fact 变更。 |
| `src/usage-store.js:282` / `:306` | 冻结 `archive_segments` DDL / 自检；生产写入点仅登记方法。authority 读取与范围冷读只 SELECT，仍无事件 DELETE 或统计引用。 |
| `src/usage-store.js:125` / `:132` | WorkBuddy observation 主键包含 `home_id`、`message_id`、`duration_ms`；不同 duration 是不同行，不是覆盖。 |
| `src/usage-store.js:3658` / `:3689` | trace 预扫只执行 `INSERT OR IGNORE`；没有 observation 的 UPDATE 或 DELETE，指纹更新在内存 Map 中。 |
| `src/usage-store.js:3989` / `:4003` | 读取时最多取两个不同 duration；恰好一个才生成 `perf_samples` 投影，多种 duration 明确返回 `null`。 |
| `src/usage-store.js:109` / `:3995` | `workbuddy_generation_durations` 是无 home 的旧兼容表；当前只在 observation 为空时读取，没有新的写入清理路径。 |

`codexProjections.prune()` / `retainHomes()` 仍会淘汰投影缓存，但不会删除本卡保留的用量或 perf 历史事实。

## 测试与命令

`test/history-retention.test.js` 现有 19 项测试覆盖（当前 19/19 通过）：

- Codex 单 rollout、部分线程、整 home 缺失及恢复，归属和业务载荷不变；部分线程缺失时，`summary.perf.missingSources` 在 `preset=today` 下仍返回该来源（不按事件日期过滤），排除其 home 后隐藏，恢复后清空，同时 sample/summary 统计保持不变。
- Codex compression transition 不翻倍；替换前 live plain 事件/quota 数等于替换后 live 压缩数，总 live 数不变。
- 部分 rollout 缺失后，幸存 rollout 的新 turn 仍进入 perf 事实和依赖。
- Claude/WorkBuddy 缺失互不阻塞。
- 既有 Claude 夹具改 output 与 duration 后，live 样本使用新值；旧 `sample_key` 的完整 payload（含 NULL、`diagnostic_reason_chain`、method version）和两条级联依赖都可从 `history_replaced_facts` 读取，no-op sync 不增长（B1b-P）。
- Codex 线程发布前先建立 request timing 基线并清空恢复表；随后把 turn 24 的请求时间后移并修改一条依赖角色。发布后 live 样本使用新 `ts_ms`、原 duration 仍保留，旧完整样本与旧依赖各写 1 行，历史来源身份与 `method_version` 和旧 `source_files` / `PERF_METHOD_VERSION` 一致；no-op sync 不增长（B1b-C-P）。
- Codex request timing 先真实 `sync()` 后导入 fixture evidence/link；把 turn 24 的 `token_usage_record.timestamp` 后移 2 秒并再次真实 `sync()`，确认本轮更新文件数为 1、evidence 原行和 thread link 原行逐列不变且仍存在，`lookupRequestTiming()` 仍返回 `available`、duration `1000`、reported output `123`（B1-timing-audit）。
- WorkBuddy 先写入 `messageId` 的唯一时长 900 正常采样；随后同时改写 usage 源文件和 trace 为 duration 850。真实 `sync()` 更新文件数为 1，observation 表仍保留 850/900 两行且两行 home_id 与保留的 usage `source_files` 身份一致；因观察冲突，`perf_samples` 投影为 0，但旧 duration 观察仍可读（B1-workbuddy-evidence）。
- project-log 先做 1 次真实修订并留下 1 行恢复事实，再逐次追加 100 个唯一事件并真实 sync；每轮 live eventCount 增长，恢复表行数、`occurrence_count` 总数和 payload 字节总量保持常数（B1d-growth）。
- project-log 从 2 条真实截断到 1 条并 `force: true` 重解析后，live 只剩保留项；被删除的 total 20 payload 以 `occurrence_count=1` 留在恢复表，关闭并以新 `UsageStore` 重开同一 SQLite 后仍存在。成功轮恰好发布 1 条“来源文件缩短（截断）”warning 且 `perfState=ready`；先用 `history_replaced_facts` INSERT 触发器令替换回滚，断言只有失败 warning、没有截断 warning；随后追加一条普通事件、再 no-op、关闭重开后 no-op，warning 数组保持不变，恢复表行数和 `occurrence_count` 也不增长（B1-truncation-diagnostic / B1-truncation-persist）。
- project-log 初始文件含合法行与空行，基线不产生坏行 warning；随后把第二条替换为稳定的非法 JSON 并用填充让文件不缩小。先用 `history_replaced_facts` INSERT 触发器令真实 `force` 轮回滚，断言只有注入失败、没有坏行 warning/marker，旧 live events 不变；移除触发器后成功解析，有效第一条仍可查询，旧第二条 payload 以 `occurrence_count=1` 留在恢复表。成功轮恰好有 1 条 warning，精确包含来源路径和“第 2 行”，不包含坏行内容标记，且 `perfState=ready`；sidecar marker 的 `lineNumbers` 为 `[2]`。再追加/删除合法事件制造截断，no-op 与关闭重开后的 no-op 同时保留坏行与截断 warning；随后写回全合法文件，坏行 marker 清除、截断 marker 保留（B1-badline-oracle / B1-badline-warning / B1-badline-persist）。
- ZCode/DSH/OpenCode 缺失、不可读与缺失分离、其他来源继续新增。
- 已发布替换目标本轮失败时不误删旧来源身份。
- 同尺寸同 mtime 不再授权缺内容指纹的通用改名，旧来源保留为 missing（B0.2）。
- 导入目录移除与恢复。
- 每次打开设置 WAL `journal_size_limit`。
- `old10→new20` 重解析保存 1 行旧 payload、`occurrence_count=2`；普通追加后行数和份数都稳定；模拟降到 v19 后重开迁移到当前精确版本 21，并确认 `history_replaced_facts` 12 列与 `archive_segments` 7 列（B1b-E/E2、B-retention-schema21-contract）。
- 同内容旧 2 条→新 1 条时 live 只剩 1 条，恢复证据恰好记录丢失的 1 份；强制重复重解析、再次追加到 2 条、再缩回 1 条后，证据仍只有 1 行且份数为 1（B1b-E2）。
- `history_replaced_facts` 的 `AFTER INSERT` 触发器真实抛错后，旧 live events 和完整 source 行不变、恢复表为 0；移除触发器后新 20 与旧 10 恢复证据成功提交（B1c-E）。
- 真实 Codex quota 输入重写后，live 显示新 `observed_at_ms` / `used_percent`；旧 primary 与 secondary payload 可读取，`NULL` 字段和旧源时间保留，方法版本为 `rate_limit_observations.v1`；追加非 quota 行不改 quota、证据仍为 2 行（B1b-Q）。
- Codex compression transition 先写入 1 条真实 plain usage event 和 primary/secondary quota；转换后旧 plain live events/quota 为 0，压缩表示保持原数量，恢复行中的完整 source 身份与旧 `source_files` 一致，payload × `occurrence_count` 的多重集与旧 facts 完全一致；secondary 的 `NULL used_percent` 和旧 plain `source_path` 保留；随后 no-op sync 不增加恢复行或份数（B1b-S-E/S-Q）。

B0 阶段已把原先断言“来源消失即删除 source_files/perf 候选”的路径改为保留历史并返回 missing；相关既有文件为 `test/perf-store.test.js`、`test/perf-codex-index.test.js`、`test/perf-claude-store.test.js`、`test/perf-state.test.js`。B1b-P 本轮没有重跑这组既有测试；B1-timing-audit 与 B1-workbuddy-evidence 只做本文件的定向与全量 retention 测试。

`test/history-rollup-store.test.js` 现有 20 项测试（当前 16 pass / 4 个环境或子进程 wrapper skip）；I1-sync-UTC 新增四项：

- 首次 `sync()` 后，`usage_rollup_days` 与 `usage_rollup_daily` 已包含两个完整 UTC 日及正确 totals。
- 将 day-12 事件重写到 day-14 后真实 `sync()`：day-12 仍有已建日标记但零 totals，day-13 保持原值，day-14 包含移动后的事件。
- 紧接一个 no-op `sync()`：`updatedFileCount === 0`，窄 `prepare` guard 只观察到 dirty 列表查询，没有出现 `INSERT INTO usage_rollup_daily`。
- 在 `usage_rollup_daily` 上安装真实 `RAISE(ABORT)` 触发器使重建失败：`sync()` 传播错误，但此前的 C5 已清空 `metadataCache` 并把 `derivedRevision` 对齐到当前修订；移除触发器后重试成功，`metadata()` 看到新增后的 3 条事件。

I1-sync-local 在同一文件新增两项断言：

- 在 `TZ=Asia/Shanghai` 下首次同步 `23:30Z` 事件后，local day 13/14 都由 rollup 读取（不触发 event SQL）；把 day-12 事件移到 day-14 后，local day 13 为零、day 14 保持原值、day 15 包含移动后的事件。
- 在 local 插入上安装真实 `RAISE(ABORT)` 触发器：UTC 已重建后 local 失败，但外层 savepoint 保留 dirty day 12/13，并回滚 UTC/local 两侧旧行与已建标记；移除触发器重试后 dirty 清空，UTC day 12 与 local day 13 都读到新的 total 50。

I1-zone-reopen 在同一文件新增真实跨进程测试：

- 上海子进程首次 `sync()` 建库并写入 `Asia/Shanghai` 身份，local day 13 的 marker 为上海边界；UTC 新进程打开同一库和来源时，该 marker 在 `sync()` 前按 UTC 边界已失效。
- UTC 进程的 no-op `sync()` 返回 `updatedFileCount === 0`，只准备一次 `INSERT INTO usage_rollup_daily` 且只扫描一次 events UTC 日；UTC 三张 rollup 表逐行保持不变，身份更新为当前 zone，local day 12/13 都在重建后由 rollup 读取且不触发 event SQL。
- 把身份改成 `stale/zone` 后安装真实 local `RAISE(ABORT)` 触发器：`sync()` 抛错，身份、local markers/daily/sessions 全部保持旧值，dirty 仍为空；移除触发器后的 no-op 重试只重建一次 local，更新身份并可由 rollup 读取。
- 同 zone 的既有 no-op 测试同时断言不扫描 events、不准备 rollup 重建语句。

B-C2-model-read 在同一文件新增三项：

- 精确 `periodAggregate("model", "model", ...)` 在事实范围内存在完整日时读取 `usage_rollup_models`、不准备原模型 period events 聚合；仓库维度和 `includeKind: true` 仍只走 events SQL。测试夹具补一条 `2026-07-13T23:59:59.999Z` 事件，使裁剪后的窗口含一个事实覆盖的完整日。
- 两个真实 home、多个模型、跨日事件下，完整 UTC 范围、起点 +1ms、终点平移 1ms、local 风格窗口、空窗口和无界窗口均与删除全部日标记后的原 SQL 结果深度相等；`excludeHomes` 同样对拍。完整日覆盖的 case 必须观察到模型 rollup SQL 且不准备原 period 聚合；只有 partial/无完整日的 case 允许走 model raw-events 分支。只在来源范围、四个周期都为零的模型仍保留并按原排序出现。
- 删除一个完整 rollup 日后只发生一次原 SQL 回退且结果相等；临时重命名 `usage_rollup_days.start_ms` 后原 `no such column` 错误直接抛出，回滚注入后同一读取恢复正常。

B-C2-public-model-read 在同一文件新增第四项和测试侧 helper：

- `sourceSqlPeriodComparison()` 先清 `periodComparisonCache`、删除全部 `usage_rollup_days` 标记，执行同一公开 `store.periodComparison()` 取得原 SQL oracle，再恢复原标记与清缓存；不写入 `src/usage-store.js`。
- 真实 `sync()` 后两个 home 的 2026-07-12/13/14 事件经公开 `periodComparison()` 读取；完整结果、`excludeHomes` 结果和模型排序与 oracle 相等，`today` 空日保留 16 个零字段。
- guard 新增 `modelPeriodAggregateQueries`，只识别原模型 `events` 聚合 SQL；B-C2-clamp-scoped-window 后公开反例通过，实际只准备 3 次模型 rollup 查询（`today` 不相交所以跳过），且没有原 period 聚合。测试仍不手工种空日 marker。

B-C2-clamp-scoped-window 在同一文件调整既有夹具和断言，没有新增第 21 项测试：第一项和“missing model rollup days”项各补一条 13 日末事件，使 scoped bounds 内确有完整日；第二个多项对拍项只要求完整日 case 命中 rollup，partial/无完整日 case 允许 raw model 分支；公开入口项额外断言 `today` 为零且模型 rollup 查询数为 3。内部 gap 空日仍未扩展 marker，缺 marker 时继续走明确的 SQL fallback。

新增 `test/history-archive-store.test.js`，共 22 项：

- 从带真实 `source_files`、`events` 与 `history_replaced_facts` 行的 v20 夹具打开：版本抬到 21，所有事实表逐行等价，`archive_segments` 为 0 行。
- 连续重开同一 v21 库：版本保持 21，目录表仍只有一张且不自动登记行。
- 冻结 DDL 断言 7 列、列序、`STRICT`、`end_ms > start_ms`、`event_count >= 0`；合法 0-count 行可写，空区间、负计数与重复 `segment_id` 分别被真实 SQLite 约束拒绝。
- 从真实 v20 来源通过现有 candidate builder 生成候选后登记：写入 1 行、绝对路径、候选起止和 events 行数正确，所有热事实逐行不变；相同候选再次登记 `inserted: false`，目录仍为 1 行且首次时间不变。
- 已登记段的源 events 同行数改值被 `HISTORY_ARCHIVE_SOURCE_CHANGED` 拒绝；source 身份同行数改值也同样拒绝；另一个不同 digest 的半开范围重叠被 `HISTORY_ARCHIVE_SEGMENT_OVERLAP` 拒绝。三次拒绝前后目录字符串完全一致。
- 在 `archive_segments` 上安装真实 `RAISE(ABORT)` INSERT 触发器后登记失败，目录为 0；移除触发器重试成功写入 1 行。
- 真实登记一段含 2 个事件的候选后，`readHistoryArchiveEvents()` 返回与候选数据库 `events ORDER BY id` 逐行相等的结果；热事实和目录逐行不变。未知 id 被明确拒绝，失败后二者仍不变。
- 在测试侧临时包装 `DatabaseSync.prototype.exec`，只拦截只读连接的 `BEGIN`，在 verify 完成之后、首次查询之前用另一连接把候选 events 同数量改值；读取因快照内复核抛 `HISTORY_ARCHIVE_SOURCE_CHANGED`，热事实与目录仍不变。没有增加生产 test hook。
- 删除已登记候选数据库后读取抛 `ENOENT`；从原副本恢复后直接改写候选 events，读取因 manifest/数据库摘要校验失败而抛 `HISTORY_BACKUP_*`。两次失败都没有清空热事实、修改目录或返回空数组。
- B3-union-oracle 用已登记候选和同一热范围构造测试侧多重集合并：把热/冷行 `id` 改成不同值后，镜像的 1+1 仍只返回 1；同 payload 两侧各 2 份时返回 2，不合并成 1 也不相加成 4。随后删除候选文件，经同一 `readHistoryArchiveEvents()` 接缝合并会抛 `ENOENT`，没有降级成空结果；调用前后热事实与 `archive_segments` 目录均不变。生产合并 API 未实现。
- B3-union-read 用真实登记段和两侧各 2 份同 payload 验证生产接缝：窄请求只返回 2 份，不返回段内另一事件或段外事件；扩大到覆盖未登记段后返回段内 3 条加段外 hot 1 条。把段内但不在请求范围内的一条 hot payload 改值后，完整段核对抛 `HISTORY_ARCHIVE_HOT_COLD_CONFLICT`；只改 hot `source_files.home_label` 也因来源身份不一致拒绝。非法非整数范围抛 `TypeError`；删除候选后抛 `ENOENT`。所有成功/冲突/缺段调用前后热事实和目录均不变。
- B3-union-cold-snapshot 用既有 `DatabaseSync.prototype.exec` 接缝做确定性交错：在 union 释放 hot 保存点后立即把 live registry 的 `database_path` 改成不存在路径，union 仍按捕获 record 成功读取原候选；恢复登记后，在冷连接 `BEGIN` 之后、首次 `assertHistoryArchiveSourceMatches()` 读取之前把候选 events 同数量改值，union 明确抛 `HISTORY_ARCHIVE_SOURCE_CHANGED`。测试没有生产 hook，且 live 事实和恢复后的目录保持逐行不变。public `readHistoryArchiveEvents()` 的原调用测试继续通过。
- B3-union-multisegment 用两个独立 v20 来源副本生成两个不重叠候选并分别登记，live 中间保留未登记 hot gap。跨两段的单请求返回 `in-range` 同 payload 2 份、`hot-gap` 1 份和 `second-segment` 1 份；重复事实不因热冷镜像翻倍，gap 不从冷层伪造，第二段不从第一段替代。删除第二段候选后整个请求抛 `ENOENT`，没有返回第一段的部分结果；调用前后 hot facts 和 `archive_segments` 目录逐行不变。
- B3-cold-authority-read 用真实临时库模拟已提交的 authority 状态：在单个 `BEGIN IMMEDIATE` 内写 v1 marker 并只删除两个授权段的 live events；保留中间 `hot-gap`、段外 `outside-range` 和段后 hot row。跨段请求返回第一段同 payload 原 2 份、hot gap、第二段 1 份、段外 hot 1 份和段后 hot 1 份；冷 payload 与候选文件逐字段相等，调用前后 facts、目录和 `store_meta` 不变。另一测试在 hot 尚未删除时明确抛 `HISTORY_ARCHIVE_HOT_COLD_CONFLICT`；删除后成功读取，但 live `source_files.home_label` 改值再次冲突；候选文件删除保留 `ENOENT`，篡改保留 `HISTORY_BACKUP_*`；authority v2 抛 `HISTORY_ARCHIVE_AUTHORITY_INVALID`，未登记 id 抛 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND`。所有失败都没有返回空/半份结果。
- B3-cold-cumulative-oracle 用真实 Codex rollout 和两个真实 `UsageStore` 对拍 cumulative `100 -> 130`：两边独立解析均得到 raw totals `[100, 30]` 与公开总数 130；修复前已归档 store 因全文件替换重新插入旧 100 并被新 30 触发已授权段 hot 残留，测试保留 `hot=[100,30]; oracle=[100,30]; oracleTotal=130` 作为失败证据。测试没有手工写 delta 30，也没有放宽 authority 门禁。
- B3-cold-reparse-prefix 单独运行时，同一真实用例的 hot 只剩累计增量 30；`mergeHistoryArchiveEventsForRange()` 返回冷 100 加 hot 30，raw payload 与独立未归档 oracle 深度相等，第二次真实 sync 的 `updatedFileCount=0` 且 hot 仍为 `[30]`。随后分别改写冷 100 为 110、在冷范围追加一条 10 的事件、删除冷 100，三种文件都通过真实 `sync()` 产生明确拒绝 warning，且 events、恢复事实、来源身份、目录和 authority 逐行不变。另一个无 authority 用例仍把 100→130 解析为 hot `[100, 30]`，确认原替换语义未被改写。
- B3-cold-published-oracle 在同一用例的 merge/no-op 之后新增公开读取断言：`publishedUsageEvents()` 实际只有 hot 30，oracle 有冷 100 与 hot 30；`periodComparison` 的 month/all、model 和 repository 合计实际都是 30，oracle 都是 130。测试保留边界摘要与完整对象对拍，当前在公开读取处失败，因此本卡没有继续执行其后的冷改值/增删断言；这些断言已由上一张接受卡独立覆盖。
- B3-carrier-snapshot 新增独立 GREEN `publishedHistoryUsageEvents matches an unarchived source oracle across cold and hot facts`：复用真实 `100 cold + 30 hot` 状态，carrier 与未归档 oracle 完整对象深度相等，并单独断言总数 `[100, 30]`、`02:00`/`02:01` 顺序和两行 `sourceKind="extra"`。第二个 GREEN `publishedHistoryUsageEvents captures bounds and hot rows in one snapshot` 在 store 第一次 bounds 读取后由独立 `DatabaseSync` 连接提交一条旧 max + 1 天的事件：carrier 仍返回完整旧快照，恢复连接后下一次 carrier 返回完整新快照，且新快照恰好多该事件，不出现 bounds 旧、rows 新的截断组合。缺段测试删除候选后要求 `mergeHistoryArchiveEventsForRange()` 与 `publishedHistoryUsageEvents()` 都抛 `ENOENT`。原 `authorized cold plus Codex cumulative delta matches an unarchived source oracle` 仍作为单独红 target，保留同步 hot-only `publishedUsageEvents()` 与 `periodComparison` 的 30-vs-130 失败。
- B3-cold-report-carrier 复用同一 `100 cold + 30 hot` fixture，`publishedHistoryUsageReport()` 的 events/homes/sessions/quota 与未归档 oracle 完整深度相等；session 断言为 `cumulative-session`、`eventCount=2`、五字段总计 `{total:130,input:110,cached:0,output:20,reasoning:0}`。第二个 GREEN 用真实候选段与一个额外 hot home/quota：包装 `readHistoryArchiveSnapshot()` 在 union 保存点释放后、首次冷读取前由另一 `DatabaseSync` 提交 home label、quota `11→22` 和新增事件；第一次 report 仍与调用前报告完整深度相等，下一次才看到新 label、quota 22 和 `eventCount=2`。缺段测试同时要求 `publishedHistoryUsageReport()` 抛 `ENOENT`，不返回部分 events/homes/sessions/quota。
- B3-cold-period 新增无 authority 测试：把 `periodComparison()` 与 `publishedHistoryUsageEvents()` 替换为测试包装，连续两次调用异步入口都委托同步方法，冷 carrier 从不执行，缓存只有 1 项且返回 total 仍为 30。既有真实 `100 cold + 30 hot` 用例改为调用 `periodComparisonHistory()`，与未归档 oracle 对 UTC、local、`excludeHomes` 完整深相等，month/all 为 130；同一用例仍显式断言同步 `periodComparison()` 为 30。缺候选文件时异步入口以 `ENOENT` 拒绝。
- B3-period-authority-snapshot 在 marker 的 prepared statement `get()` 返回后、period SQL 执行前，用独立 `DatabaseSync` 外连接提交 v1 authority 并删除冷段对应的 20 条 hot 事件。首次 `periodComparisonHistory()` 仍返回旧快照 total 130，且 memo 为 1 项；随后同步 `periodComparison()` 检出外部提交并返回 hot-only 110，证明没有复用 pinned 快照；下一次 `periodComparisonHistory()` 走完整冷载体并返回 130，与首次完整对象深相等。全文件现为 22/22。
- B-cold-summary 新增三组摘要证据：无 authority 时包装 `publishedHistoryUsageReport()` 为抛错，连续入口仍与同步 `summarize()` 完整深相等且 total 为 30；确定性交错在 marker `get()` 后由外连接提交空 authority 列表、删除 20 条热事件并把 quota 从 11 改为 22，首次摘要仍为旧快照 130/11，随后同步摘要检出外部提交为 110/22；完整 `100 cold + 30 hot` 用例对 UTC、`excludeHomes` 的共享 usage 字段与未归档 oracle 深相等，并覆盖 `includeDetails:false`，缺候选段以 `ENOENT` 整体拒绝。`summary.perf` 与 oracle 的 `records:{}` 被显式排除在本次共享算法对拍之外，未删缺段/权限回归。全文件现为 24/24。
- B-cold-summary-records 新建 2026-07-12 至 07-19 的 8 个事实日、2 个 home 冷候选：`07-12` 普通 home 为 900、excluded home 为 10000，其余 7 日普通 home 各 200。live 只保留 `source_files` 并把 events 全部替换为授权冷段，随后对四种请求逐步与未归档 `oracle.summarize(filters).records` 完整深相等：单日不排除为 day/10900；同一日排除 `excluded-home` 为 day/900；`07-13..19` 排除后为 week/1400；`07-14..19` 冠军周不被完整包含，`totalTokens` 不点亮。该用例同时证明冷 records 非空、单位/期/值正确、排除集合先于冠军选择，而不是把 live hot champion 混入。
- B-rollup-complete-events-seam 新增 `test/history-cold-rollup-rebuild.test.js`：真实 Codex 夹具先归档 `2026-07-12T02:00Z` 的 100，再在 hot 保留累计增量 20，并从真实 registered authority 取得完整 `[100, 20]`。清空该 UTC 日的 `usage_rollup_daily/models/sessions/days` 后，用 carrier events 调 `rebuildUsageRollupsFromEvents()`；四张表与未归档 oracle 逐行深相等，且 archived store 的 hot `events` 仍只有 `02:01Z` 的 20，只读方法没有把冷事实复制回 `events`。
- B-store-cold-rollup-day 把同一真实夹具改为调用 store 入口：先预热 `periodComparisonCache` 并清空该 UTC 日四张 rollup 表，`rebuildHistoryRollupDay("2026-07-12")` 后四表与未归档 oracle 逐列深相等，`storeRevision` 恰好前进一次、既有 period cache 被清空，热 `events` 仍只有 20。随后移走已登记候选文件，调用以 `ENOENT` 拒绝且四表逐行、`storeRevision` 均与调用前完全一致；恢复文件后安装 `BEFORE INSERT ON usage_rollup_daily` 的真实 `RAISE(ABORT)` 触发器，重建在已开始删写后失败，外层回滚仍恢复原四表并保持修订不变。
- B-cold-rollup-writer-lock 在同一测试中新增真实写者证据：首次重建的 `publishedHistoryUsageEvents()` 尚未完成时，第二连接 `UPDATE` 热尾 `20→25` 被 `database is locked` 拒绝（`errcode=5`），未留下任何提交；首次 120 仍与 oracle 四表逐列相等。重建事务结束后同一连接相同更新返回 `changes=1`，`publishedHistoryUsageEvents()` 从 `[100,20]` 变为 `[100,25]`，下一次重建的 125 与直接同步 oracle 的四表逐列相等。原缺段 `ENOENT` 与真实 insert 触发器失败的旧四表保留断言继续执行。
- B-rollup-multi-UTC 新增真实 `2026-07-12 cold 100 + 2026-07-13 hot 20` 夹具：清空所有 UTC 四表后，以 `days:[07-12,07-13]` 和同一完整 carrier 一次调用模块，四表与未归档 oracle 逐列深相等且两个 day marker 都存在。失败反例在调用前只克隆 carrier 的事件输入，把第一日事件从 `total/input=100/80` 改为 `150/130`，不改 cold/hot 事实或 oracle；随后安装只对第二日 `usage_rollup_daily` INSERT 生效的 `RAISE(ABORT)` 触发器。若第一日被单独提交，daily 会明显变成 150；实际失败后四表仍逐列等于重建前的 120 旧值，且 `sqlite_temp_master` 已无 `usage_rollup_complete_events`，证明同批第一日随第二日失败回滚且 TEMP 清理完成。该断言只证明模块原子性输入反例，不替代 store authority 验证。原单日、writer lock、缺段与单日 insert 失败断言继续保留。

- B-cold-summary-sync-seam 新增独立 `test/history-cold-summary-prepared.test.js`：真实 ZCode perf 夹具先归档前段事件并留下 hot 事实与 authority，再准备带 `perfCarrier` 的完整 report。prepared 结果断言为非 Promise，且与 `await summarizeHistory()` 完整深相等；`records` 与 `perf.models` 非空。同一 report 上的 `excludeHomes` 结果与 async oracle 深相等，且 eventCount 变小；`includeDetails:false` 只移除 `homes/projects/repositories`。

- B-cold-freeze-HTTP-read 的核心 HTTP 测试真实归档前 100、hot 30，首 freeze 与 snapshot 复读均为 130/2，period all 为 130；原段移走后旧 snapshot 仍为 130/2；之后再申请 freeze 明确 500 + `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND`，没有 30/0。修复前同一测试在首 freeze 即得到 summary 30/1、period 30，metadata 已是 2；修复后 1/1 通过。

- B-cold-snapshot-cleanup 新增 `test/history-cold-snapshot-cleanup.test.js`，三项都在真实临时 SQLite、真实冷段副本与真实 HTTP 服务上运行。第 1 项连续 freeze 9 次：前 8 次填充容量，第 9 次淘汰首快照；首 id 再读为 410 `SNAPSHOT_EXPIRED`，其主库、WAL、SHM、`.segments` 均不存在，第 9 次摘要仍为 130。第 2 项先保留一个 130 快照，再在测试主线程临时 patch `UsageStore.prototype.open`：只对新快照库先 await 原 `open()`，记录该主库与 `.segments` 均已实际存在后才抛出一次 `INJECTED_SNAPSHOT_POST_CREATE_FAILURE`，并在 `finally` 恢复 prototype；worker 使用自己的模块/原型，不受这个主线程 patch 影响。响应必须为 500 且错误文本精确匹配注入值；随后该主库、WAL、SHM、`.segments` 均被删除，目录只剩首快照的产物，首 snapshot 继续返回 130。上一版写坏 `imports.json` 的反例已废弃，因为 `loadUsageStore()` 会在 `usageOptions()` 处提前失败，无法证明 executor 创建后的 catch 清理。第 3 项创建一个带 `.segments` 的快照后 `await server.close()`，私有 `codex-usage-snapshot-*` 目录立即不存在，证明 close Promise 等待整个目录（含侧车）删除。

新增 `test/history-published-events.test.js`，共 5 项：

- 真实 project-log 同步写入完整事件后，`publishedUsageEvents()` 返回全部 `UsageEvent` 字段并保留 project/cwd、repository、context、五个 token、cache-write、`detailMask`、`sourceKind=project-log` 与 price version；测试把 evidence resolver 返回值接入 `serviceTier`，并确认调用参数为 session、事件毫秒与存储 tier。删除来源并同步为 missing 后结果逐字段不变；恢复文件再同步仍只有原事件，不重复。
- 额外 Codex home 与 project-log 使用同一 `sessionId` 时，两条事件都返回，按时间排序且各自实际 `sourceKind` 为 `extra` / `project-log`。测试还把内存 `store.homes.kind` 改成错误值，确认结果仍取 `source_files.kind`，不按 home 投影合并或过滤。
- 两个真实 home（额外 Codex home 的两个 rollout + project-log）成功同步后，`publishedUsageHomes()` 把同 home 的两个文件折叠为一个身份并返回两 home 的原 `id/label/path/kind`；调用前后 `source_files` 与 `events` 快照逐字相等。删除整个 project-log home 后仍返回两 home；恢复并再同步不增加重复。最后只改一条同 home 的 `home_label`，确认冲突抛 `PUBLISHED_HOME_IDENTITY_CONFLICT`，没有 first-wins。
- 同一 project-log session 的两条事件与另一 home 的同 id session 一起同步后，`publishedUsageSessions()` 返回两条独立会话：project home 的 `eventCount=2`、首末时间正确、五个 token 字段精确求和，且 `channel/cwd/model` 取最后一条事件；Codex home 会话保留自己的持久 label/path。调用前后 `source_files` 与 `events` 快照逐字相等；删除整个 project-log 目录并同步为 missing 后结果不变；恢复后再同步仍不重复。
- 真实 Codex rollout 同时写入事件与 primary/secondary quota 后，`publishedUsageReport()` 返回固定四键，四项与单独调用相同，quota 复用既有映射（含 `used_percent=null`），调用前后 `source_files`/`events`/`rate_limit_observations` 逐行不变；首个报告同时预热 quota memo。测试侧在首次事件读取后由第二个真实 `DatabaseSync` 连接同事务提交「home label 改写 + 新事件插入 + primary `used_percent` 37→58」，本次载体仍只返回旧事件、旧 home、旧 session 与旧 quota 37；提交后的新调用才看到新 label、新事件、`eventCount=2` 与新 quota 58。随后同一连接外层 `BEGIN IMMEDIATE` 把 quota 改为未提交 99，报告读到 99；`ROLLBACK` 后再次报告恢复 58，证明 memo 未被未提交值污染。最后在外层事务中注入会话读取失败，报告抛原错误后外层 `ROLLBACK` 仍成功，随后再次报告可正常读取。

另有 `Asia/Shanghai local rollup subprocess` 包装测试；固定 TZ 子进程避免依赖运行宿主的当前时区。本卡只覆盖进程重开时 zone 变化，不处理同一进程运行中切换 `TZ`。

原有 missing-marker fallback 测试先确认 sync 已把触发器删掉的 day 修好，再显式删除标记以继续验证 SQL 回退；不是把 sync 修复后的缺日当成正常状态。

实际结果：

```text
# B1-truncation-diagnostic 修复前，使用真实 force 且未篡改 source_files：
node --test --test-concurrency=1 --test-name-pattern="Stable project-log truncation" test/history-retention.test.js
exit 1; tests 1, pass 0, fail 1
AssertionError: truncation must produce an explicit diagnostic; {"perfState":"ready","warnings":[]}

# 修复后：
node --test --test-concurrency=1 --test-name-pattern="Stable project-log truncation" test/history-retention.test.js
exit 0; tests 1, pass 1, fail 0; duration 94.6027ms

# B1-truncation-persist（sidecar、普通追加、no-op 与重开）：
node --test --test-concurrency=1 --test-name-pattern="Stable project-log truncation" test/history-retention.test.js
exit 0; tests 1, pass 1, fail 0; duration 188.813ms; test duration 97.823ms

node --test --test-concurrency=1 --test-name-pattern="One hundred ordinary project-log appends" test/history-retention.test.js
exit 0; tests 1, pass 1, fail 0; duration 1160.3869ms; test duration 1068.5482ms

node --test --test-concurrency=1 test/history-retention.test.js
exit 0; tests 18, pass 18, fail 0; duration 2943.2275ms

# B1-badline-warning / B1-badline-persist：
node --test --test-concurrency=1 --test-name-pattern="Stable malformed project-log replacement" test/history-retention.test.js
exit 0; tests 1, pass 1, fail 0; duration 204.6580ms; test duration 111.9505ms

node --test --test-concurrency=1 --test-name-pattern="Stable project-log truncation" test/history-retention.test.js
exit 0; tests 1, pass 1, fail 0; duration 202.7359ms; test duration 102.4090ms

node --test --test-concurrency=1 test/history-retention.test.js
exit 0; tests 19, pass 19, fail 0; duration 3422.9148ms

npx.cmd biome check src/usage-core.js src/usage-store.js test/history-retention.test.js
exit 0; Checked 3 files in 84ms. No fixes applied.

npm.cmd run typecheck
exit 0

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-retention-schema21-contract 修复前：
node --test --test-concurrency=1 test/history-retention.test.js
exit 1; tests 18, pass 16, fail 2
# Codex partial and whole-home loss ...: user_version 21 !== 20
# Reparse stores ... old10-to-new20 ...: user_version 21 !== 20

# 修复后：
node --test --test-concurrency=1 test/history-retention.test.js
exit 0; tests 18, pass 18, fail 0; duration 2670.8511ms

# B20-legacy-migration-tests 修复前：
node --test --test-concurrency=1 test/perf-projection-store.test.js test/perf-store.test.js
exit 1; tests 81, pass 70, fail 11; duration 4006.0827ms
# 11 项均为当前 schema 21 !== 字面量 19

# 修复后：
node --test --test-concurrency=1 test/perf-projection-store.test.js test/perf-store.test.js
exit 0; tests 81, pass 81, fail 0; duration 3866.9097ms

npx.cmd biome check test/perf-projection-store.test.js test/perf-store.test.js
exit 0; Checked 2 files in 49ms. No fixes applied.

git diff --check -- test/perf-projection-store.test.js test/perf-store.test.js
exit 0
# B20-archive-test-isolation（全仓 trace；修复前两例宿主单跑 2/2）：
# candidate actual: { newWorkDirectories: [ 'codex-usage-archive-lHhVba' ], destinationExists: false, manifestExists: false }
# complete actual: [ 'codex-usage-archive-mcCRhG', 'codex-usage-archive-Nsp8ys' ]

# 修复后并发分跑：
node --test --test-concurrency=1 --test-name-pattern="candidate creation rejects a non-empty archive registry before creating output" test/history-archive.test.js
exit 0; tests 1, pass 1, fail 0; duration 155.1214ms
node --test --test-concurrency=1 --test-name-pattern="complete archive bundle stages hot facts and segments from one snapshot" test/history-archive.test.js
exit 0; tests 1, pass 1, fail 0; duration 532.8822ms

# 合并定向：
node --test --test-concurrency=1 --test-name-pattern="candidate creation rejects a non-empty archive registry before creating output|complete archive bundle stages hot facts and segments from one snapshot" test/history-archive.test.js
exit 0; tests 2, pass 2, fail 0; duration 585.5046ms

npx.cmd biome check test/history-archive.test.js
exit 0; Checked 1 file in 30ms. No fixes applied.

git apply --check --whitespace=error --directory=output/history-retention-resume-20261025/B20-archive-test-isolation/apply-check-20261026-final output/history-retention-resume-20261025/B20-archive-test-isolation/B20-archive-test-isolation.patch
git apply --whitespace=error --directory=output/history-retention-resume-20261025/B20-archive-test-isolation/apply-check-20261026-final output/history-retention-resume-20261025/B20-archive-test-isolation/B20-archive-test-isolation.patch
exit 0; applied test/report SHA-256 equal current files
# B1-truncation-oracle 加入前：
node --test --test-concurrency=1 test/history-retention.test.js
exit 0; tests 17, pass 17, fail 0; duration 2316.2568ms

node --test --test-concurrency=1 --test-name-pattern="Codex partial and whole-home loss" test/history-retention.test.js
exit 0; tests 1, pass 1, fail 0; duration 180.2721ms; total 274.4404ms

node --test --test-concurrency=1 --test-name-pattern="One hundred ordinary" test/history-retention.test.js
exit 0; tests 1, pass 1, fail 0; duration 838.1979ms

node --test --test-concurrency=1 --test-name-pattern="timing evidence" test/history-retention.test.js
exit 0; tests 1, pass 1, fail 0; duration 211.6973ms

node --test --test-concurrency=1 --test-name-pattern="WorkBuddy duration observations" test/history-retention.test.js
exit 0; tests 1, pass 1, fail 0; duration 168.7727ms

node --test --test-concurrency=1 test/history-rollup-store.test.js
exit 0; tests 16, pass 12, fail 0, skipped 4; duration 1209.2518ms

$env:TZ = "Asia/Shanghai"; node --test --test-concurrency=1 --test-name-pattern="Shanghai local rollup sync" test/history-rollup-store.test.js
exit 0; tests 2, pass 2, fail 0; duration 204.1743ms

$env:TZ = "America/New_York"; node --test --test-concurrency=1 --test-name-pattern="local DST rollup selection" test/history-rollup-store.test.js
exit 0; tests 1, pass 1, fail 0; duration 151.5825ms

$env:TZ = "UTC"; node --test --test-concurrency=1 --test-name-pattern="no-op sync lists|cross-zone reopen|zone identity failure|zone reopen subprocess phase" test/history-rollup-store.test.js
exit 0; tests 4, pass 3, fail 0, skipped 1; duration 537.0336ms

node --test test/history-archive-store.test.js
exit 0; tests 9, pass 9, fail 0; duration 813.0432ms

node --test test/history-published-events.test.js
exit 0; tests 5, pass 5, fail 0; duration 392.1351ms

node --test --test-concurrency=1 test/usage-rollups.test.js
exit 0; tests 19, pass 19, fail 0; duration 894.7811ms

npx.cmd biome check src/usage-store.js test/history-retention.test.js
exit 0; Checked 2 files in 77ms. No fixes applied.

npx.cmd biome check src/usage-store.js test/history-rollup-store.test.js
exit 0; Checked 2 files in 73ms. No fixes applied.

npx.cmd biome check src/usage-store.js test/history-archive-store.test.js
exit 0; Checked 2 files in 74ms. No fixes applied.

npx.cmd biome check src/usage-store.js test/history-published-events.test.js
exit 0; Checked 2 files in 77ms. No fixes applied.

# B3-union-oracle：
node --test --test-concurrency=1 test/history-archive-store.test.js
exit 0; tests 10, pass 10, fail 0; duration 622.0022ms

npx.cmd biome check test/history-archive-store.test.js
exit 0; Checked 1 file in 14ms. No fixes applied.

# B3-union-read：
node --test --test-concurrency=1 test/history-archive-store.test.js
exit 0; tests 11, pass 11, fail 0; duration 691.6453ms

npx.cmd biome check src/usage-store.js test/history-archive-store.test.js
exit 0; Checked 2 files in 79ms. No fixes applied.

# B3-union-cold-snapshot：
node --test --test-concurrency=1 test/history-archive-store.test.js
exit 0; tests 12, pass 12, fail 0; duration 758.5586ms

npx.cmd biome check src/usage-store.js test/history-archive-store.test.js
exit 0; Checked 2 files in 83ms. No fixes applied.

# B3-union-multisegment：
node --test --test-name-pattern="two registered segments" test/history-archive-store.test.js
exit 0; tests 1, pass 1, fail 0; duration 201.5708ms

node --test --test-concurrency=1 test/history-archive-store.test.js
exit 0; tests 13, pass 13, fail 0; duration 869.7591ms

npx.cmd biome check test/history-archive-store.test.js
exit 0; Checked 1 file in 16ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0

# B3-cold-authority-read：
node --test --test-concurrency=1 --test-name-pattern="authorized cold" test/history-archive-store.test.js
exit 0; tests 2, pass 2, fail 0; duration 372.1335ms

node --test --test-concurrency=1 test/history-archive-store.test.js
exit 0; tests 15, pass 15, fail 0; duration 1579.3691ms

npx.cmd biome check src/usage-store.js test/history-archive-store.test.js
exit 0; Checked 2 files in 83ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

# 最终复跑时 owner 在卡外改动了 src/perf-stats.js；本卡未触碰该文件。
npm.cmd run typecheck
exit 1; src/perf-stats.js(1988,7): error TS2322: Type 'string' is not assignable to type '"message" | "request" | "step" | "turn" | "mixed"'.

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B3-cold-cumulative-oracle（当前预期失败反例）：
node --test --test-concurrency=1 --test-name-pattern="authorized cold plus Codex cumulative" test/history-archive-store.test.js
exit 1; tests 1, pass 0, fail 1; duration 158.9411ms
AssertionError: HISTORY_ARCHIVE_HOT_COLD_CONFLICT: authorized archive segment ... still has hot facts; hot=[{"timestamp_ms":1783821600000,"total":100},{"timestamp_ms":1783821660000,"total":30}]; oracle=[100,30]; oracleTotal=130

node --test --test-concurrency=1 test/history-archive-store.test.js
exit 1; tests 16, pass 15, fail 1; duration 1892.0777ms

npx.cmd biome check test/history-archive-store.test.js
exit 0; Checked 1 file in 21ms. No fixes applied.

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B3-cold-reparse-prefix：
node --test --test-concurrency=1 --test-name-pattern="authorized cold plus Codex cumulative" test/history-archive-store.test.js
exit 0; tests 1, pass 1, fail 0; duration 299.2888ms

node --test --test-concurrency=1 test/history-archive-store.test.js
exit 0; tests 17, pass 17, fail 0; duration 2370.1829ms

node --test --test-concurrency=1 test/history-retention.test.js
exit 0; tests 19, pass 19, fail 0; duration 3881.432ms

npx.cmd biome check src/usage-store.js test/history-archive-store.test.js
exit 0; Checked 2 files in 146ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B3-cold-published-oracle（当前预期失败证据）：
node --test --test-concurrency=1 --test-name-pattern="authorized cold plus Codex cumulative" test/history-archive-store.test.js
exit 1; tests 1, pass 0, fail 1; duration 227.5402ms
public reads omit authorized cold facts:
mergedTotals=[100,30]; oracleTotals=[100,30]
publishedUsageEvents actual totals [30]; expected [100,30]
periodComparison actual month/all.total 30; expected 130

node --test --test-concurrency=1 test/history-archive-store.test.js
exit 1; tests 17, pass 16, fail 1; duration 2311.4387ms

npx.cmd biome check test/history-archive-store.test.js
exit 0; Checked 1 file in 27ms. No fixes applied.

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B3-carrier-snapshot：
node --test --test-concurrency=1 --test-name-pattern="publishedHistoryUsageEvents matches an unarchived source oracle|publishedHistoryUsageEvents captures bounds and hot rows" test/history-archive-store.test.js
exit 0; tests 2, pass 2, fail 0; duration 344.7369ms
✔ publishedHistoryUsageEvents matches an unarchived source oracle across cold and hot facts (210.1937ms)
✔ publishedHistoryUsageEvents captures bounds and hot rows in one snapshot (36.5267ms)

node --test --test-concurrency=1 --test-name-pattern="range merge checks the full registered segment" test/history-archive-store.test.js
exit 0; tests 1, pass 1, fail 0; duration 284.9289ms

node --test --test-concurrency=1 --test-name-pattern="authorized cold plus Codex cumulative" test/history-archive-store.test.js
exit 1; tests 1, pass 0, fail 1; duration 337.2274ms
historyPublishedTotals=[100,30]; historyPublishedMatchesOracle=true
synced publishedUsageEvents actual totals [30]; expected [100,30]
periodComparison actual month/all.total 30; expected 130

node --test --test-concurrency=1 test/history-archive-store.test.js
exit 1; tests 19, pass 18, fail 1; duration 2556.696ms

npx.cmd biome check src/usage-store.js test/history-archive-store.test.js
exit 0; Checked 2 files in 109ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B3-cold-report-carrier：
node --test --test-concurrency=1 --test-name-pattern="publishedHistoryUsageReport captures homes and quota|publishedHistoryUsageEvents matches an unarchived source oracle" test/history-archive-store.test.js
exit 0; tests 2, pass 2, fail 0; duration 448.6752ms
✔ publishedHistoryUsageEvents matches an unarchived source oracle across cold and hot facts (218.4625ms)
✔ publishedHistoryUsageReport captures homes and quota before cold reads (137.0517ms)

node --test --test-concurrency=1 --test-name-pattern="hot and cold union oracle keeps mirrored facts once and rejects a missing segment" test/history-archive-store.test.js
exit 0; tests 1, pass 1, fail 0; duration 238.4248ms
✔ hot and cold union oracle keeps mirrored facts once and rejects a missing segment (137.6647ms)

node --test --test-concurrency=1 test/history-archive-store.test.js
exit 1; tests 20, pass 19, fail 1; duration 2741.6925ms
唯一失败仍是保留的 authorized-cold sync `publishedUsageEvents()` / `periodComparison` 红 target（30 vs 130）

node --test --test-concurrency=1 test/history-published-events.test.js
exit 0; tests 5, pass 5, fail 0; duration 528.8663ms

npx.cmd biome check src/usage-store.js test/history-archive-store.test.js test/history-published-events.test.js
exit 0; Checked 3 files in 108ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B3-cold-period / B3-period-authority-snapshot：
node --test --test-concurrency=1 --test-name-pattern="periodComparisonHistory|authorized cold plus|authorized cold reads" test/history-archive-store.test.js
exit 0; tests 4, pass 4, fail 0; duration 677.464ms
✔ periodComparisonHistory without authority keeps the cached hot-only path (37.2201ms)
✔ periodComparisonHistory pins the no-authority marker and period read against an external commit (129.7453ms)
✔ authorized cold reads reject residual hot facts, changed sources, invalid authority and bad packages (142.1034ms)
✔ authorized cold plus Codex cumulative delta matches an unarchived source oracle (284.1218ms)

node --test --test-concurrency=1 --test-name-pattern="D4 · periodComparison" test/server.test.js
exit 0; tests 1, pass 1, fail 0; duration 106.3405ms
✔ test\server.test.js (101.5057ms)

node --test --test-concurrency=1 test/history-archive-store.test.js
exit 0; tests 22, pass 22, fail 0; duration 2408.0745ms

npx.cmd biome check test/history-archive-store.test.js
exit 0; Checked 1 file in 27ms. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-store.js
exit 0; Checked 1 file in 69ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-summary：
node --test --test-concurrency=1 --test-name-pattern="summarizeHistory|authorized cold plus Codex cumulative|hot and cold union oracle" test/history-archive-store.test.js
exit 0; tests 4, pass 4, fail 0; duration 566.1175ms
✔ hot and cold union oracle keeps mirrored facts once and rejects a missing segment (127.8247ms)
✔ summarizeHistory without authority keeps the synchronous hot-only summary (35.1081ms)
✔ summarizeHistory pins the no-authority marker and hot summary against an external commit (37.9001ms)
✔ authorized cold plus Codex cumulative delta matches an unarchived source oracle (284.6289ms)

node --test --test-concurrency=1 test/history-archive-store.test.js
exit 0; tests 24, pass 24, fail 0; duration 2605.0891ms

npx.cmd biome check test/history-archive-store.test.js
exit 0; Checked 1 file in 28ms. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-store.js
exit 0; Checked 1 file in 65ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-summary-records：
node --test --test-concurrency=1 --test-name-pattern="summarizeHistory records match" test/history-archive-store.test.js
exit 0; tests 1, pass 1, fail 0; duration 209.8236ms

node --test --test-concurrency=1 test/history-archive-store.test.js
exit 0; tests 25, pass 25, fail 0; duration 2870.7513ms

node --test --test-concurrency=1 --test-name-pattern="New Record|D2 ·" test/usage-store.test.js
exit 0; tests 7, pass 7, fail 0; duration 868.1536ms

node --test --test-concurrency=1 --test-name-pattern="D2 ·" test/three-path-parity.test.js
exit 0; tests 1, pass 1, fail 0; duration 282.1514ms

npx.cmd biome check test/history-archive-store.test.js
exit 0; Checked 1 file in 29ms. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-store.js
exit 0; Checked 1 file in 65ms. No fixes applied.

npx.cmd biome format src/usage-store.js
exit 1; only pre-existing unrelated line :3412 remains; the records changes are formatter-clean.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-perf-capture：
node --test --test-concurrency=1 --test-name-pattern="summarizeHistory captures perf with the carrier|summarizeHistory without authority|authorized cold plus Codex cumulative" test/history-archive-store.test.js
exit 0; tests 3, pass 3, fail 0; duration 562.3811ms

node --test --test-concurrency=1 test/history-archive-store.test.js
exit 0; tests 27, pass 27, fail 0; duration 3092.4748ms

node --test --test-concurrency=1 --test-name-pattern="M4.2-a|M4.2-d|M4.2-h" test/perf-summary-parity.test.js
exit 0; tests 3, pass 3, fail 0; duration 444.8859ms

npx.cmd biome check test/history-archive-store.test.js
exit 0; Checked 1 file in 28ms. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-store.js
exit 0; Checked 1 file in 68ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-rollup-complete-events-seam：
node --test --test-concurrency=1 test/history-cold-rollup-rebuild.test.js
exit 0; tests 1, pass 1, fail 0; test 167.8421ms, runner 242.5628ms（前次 test 165.4575ms, runner 241.8264ms）

node --test --test-concurrency=1 test/usage-rollups.test.js
exit 0; tests 25, pass 25, fail 0; duration 1143.7863ms

node --test --test-concurrency=1 test/history-rollup-store.test.js
exit 0; tests 16 pass, 4 skip, 0 fail; duration 1416.2062ms

npx.cmd biome check src/usage-rollups.js test/history-cold-rollup-rebuild.test.js
exit 0; Checked 2 files. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-store-cold-rollup-day：
node --test --test-concurrency=1 test/history-cold-rollup-rebuild.test.js test/usage-rollups.test.js
exit 0; tests 26, pass 26, fail 0; duration 1369.1887ms（前次 1325.471ms）

node --test --test-concurrency=1 test/history-rollup-store.test.js
exit 0; tests 16 pass, 4 skip, 0 fail; duration 1265.1236ms

npx.cmd biome check test/history-cold-rollup-rebuild.test.js
exit 0; Checked 1 file. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-store.js
exit 0; Checked 1 file. No fixes applied.
完整 biome check src/usage-store.js 仍只在原有 :3533 formatter 行失败；本卡新增行无格式错误。

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-rollup-writer-lock：
node --test --test-concurrency=1 test/history-cold-rollup-rebuild.test.js
exit 0; tests 1, pass 1, fail 0; test 216.324ms, runner 290.8196ms（前次 test 199.2714ms, runner 275.1448ms）

npx.cmd biome check test/history-cold-rollup-rebuild.test.js
exit 0; Checked 1 file in 7ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-rollup-multi-UTC：
node --test --test-concurrency=1 test/history-cold-rollup-rebuild.test.js test/usage-rollups.test.js
exit 0; tests 27, pass 27, fail 0; duration 1423.2797ms
✔ store rebuilds one UTC rollup day from authorized cold plus hot facts (197.3738ms)
✔ complete event carrier rebuilds multiple UTC days atomically (138.0839ms)

node --test --test-concurrency=1 test/history-rollup-store.test.js
exit 0; tests 16 pass, 4 skip, 0 fail; duration 1453.4027ms

npx.cmd biome check src/usage-rollups.js test/history-cold-rollup-rebuild.test.js
exit 0; Checked 2 files in 13ms. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-store.js
exit 0; Checked 1 file in 70ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-store-full-UTC-rebuild：
node --test --test-concurrency=1 --test-name-pattern="store rebuilds full UTC history" test/history-cold-rollup-rebuild.test.js
exit 0; tests 1, pass 1, fail 0; test 193.926ms, runner 268.8176ms

node --test --test-concurrency=1 test/history-cold-rollup-rebuild.test.js test/usage-rollups.test.js
exit 0; tests 28, pass 28, fail 0; duration 1583.8641ms
✔ store rebuilds full UTC history across gaps and publishes atomically (158.9592ms)

node --test --test-concurrency=1 test/history-rollup-store.test.js
exit 0; tests 16 pass, 4 skip, 0 fail; duration 1306.4556ms

npx.cmd biome check test/history-cold-rollup-rebuild.test.js
exit 0; Checked 1 file in 10ms. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-store.js
exit 0; Checked 1 file in 68ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-rollup-complete-local-seam：
node --test --test-concurrency=1 --test-name-pattern="complete event carrier rebuilds one local DST day" test/history-cold-rollup-rebuild.test.js
exit 0; tests 1, pass 1, fail 0; test 258.5075ms, runner 334.548ms

node --test --test-concurrency=1 test/history-cold-rollup-rebuild.test.js test/usage-rollups.test.js
exit 0; tests 29, pass 29, fail 0; duration 1861.9523ms
✔ complete event carrier rebuilds one local DST day and keeps UTC (222.8207ms)

npx.cmd biome check src/usage-rollups.js test/history-cold-rollup-rebuild.test.js
exit 0; Checked 2 files in 14ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check -- src/usage-rollups.js
exit 0

# B-store-full-dual-zone：
node --test --test-concurrency=1 --test-name-pattern="store rebuilds full dual-zone New York DST history atomically" test/history-cold-rollup-rebuild.test.js
exit 0; tests 1, pass 1, fail 0; test 274.4576ms, runner 350.895ms

node --test --test-concurrency=1 test/history-cold-rollup-rebuild.test.js test/usage-rollups.test.js
exit 0; tests 29, pass 29, fail 0; duration 1810.619ms
✔ store rebuilds full dual-zone New York DST history atomically (251.8543ms)

node --test --test-concurrency=1 test/history-rollup-store.test.js
exit 0; tests 20, pass 16, skip 4, fail 0; duration 1422.4721ms

npx.cmd biome check test/history-cold-rollup-rebuild.test.js
exit 0; Checked 1 file in 12ms. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-store.js
exit 0; Checked 1 file in 71ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-executor-history-rebuild：
node --test --test-concurrency=1 test/history-rollup-rebuild-executor.test.js
exit 0; tests 1, pass 1, fail 0; test 253.4706ms, runner 5355.3999ms

npx.cmd biome check test/history-rollup-rebuild-executor.test.js
exit 0; Checked 1 file in 6ms. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-executor.js
exit 0; Checked 1 file in 11ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-rollup-sync-regression（红测）：
node --test --test-concurrency=1 test/history-cold-rollup-sync.test.js
exit 1; tests 1, pass 0, fail 1; test 201.6561ms, runner 281.7411ms

npx.cmd biome check test/history-cold-rollup-sync.test.js
exit 0; Checked 1 file in 6ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-rollup-sync-fix：
node --test --test-concurrency=1 test/history-cold-rollup-sync.test.js
exit 0; tests 1, pass 1, fail 0; test 265.9697ms, runner 342.7806ms

node --test --test-concurrency=1 test/history-rollup-store.test.js test/history-cold-rollup-rebuild.test.js test/history-cold-hot-tail-revision.test.js
exit 0; tests 25, pass 21, fail 0, skipped 4; duration 2603.7503ms

npx.cmd biome check test/history-cold-rollup-sync.test.js
exit 0; Checked 1 file in 7ms. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-store.js
exit 0; Checked 1 file in 74ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-rollup-sync-fix（主审宿主复核结果）：
tests 5, pass 5, fail 0; duration 890.391ms

# B-cold-rollup-sync-local-rollback：
node --test --test-concurrency=1 test/history-cold-rollup-sync.test.js
exit 0; tests 1, pass 1, fail 0; test 319.4164ms, runner 395.7344ms

node --test --test-concurrency=1 test/history-cold-rollup-sync.test.js test/history-cold-rollup-rebuild.test.js
exit 0; tests 5, pass 5, fail 0; duration 1241.4682ms

npx.cmd biome check test/history-cold-rollup-sync.test.js
exit 0; Checked 1 file in 7ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-rollup-sync-local-rollback（主审复核）：
tests 1, pass 1, fail 0; test 314.4768ms, runner 392.1617ms

# B-cold-rollup-sync-zone-change（主审独立红测）：
node --test --test-concurrency=1 test/history-cold-rollup-sync-zone.test.js
exit 1; tests 1, pass 0, fail 1; test 330.5093ms, runner 384.4682ms
failure: only physical four-table strictness; extra local usage_rollup_days row for 2026-07-13, while UTC and all three aggregate tables matched

# B-cold-rollup-sync-zone-change（marker 契约返修）：
node --test --test-concurrency=1 test/history-cold-rollup-sync-zone.test.js
exit 0; tests 1, pass 1, fail 0; test 334.7515ms, runner 385.9652ms

npx.cmd biome check test/history-cold-rollup-sync-zone.test.js
exit 0; Checked 1 file in 5ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-rollup-sync-zone-change（主审复核）：
tests 1, pass 1, fail 0; test 332.3266ms, runner 385.4557ms

# B-period-executor：
node --test --test-concurrency=1 test/history-period-executor.test.js
exit 0; tests 1, pass 1, fail 0; duration 5324.2392ms; test 234.5775ms

node --test --test-concurrency=1 --test-name-pattern="W1 · summarize / periodComparison" test/w1-executor.test.js
exit 0; tests 1, pass 1, fail 0; duration 5319.9793ms

node --test --test-concurrency=1 test/history-executor-backup.test.js
exit 0; tests 10, pass 10, fail 0; duration 6593.0969ms

npx.cmd biome check src/usage-executor.js test/history-period-executor.test.js
exit 0; Checked 2 files in 13ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-summary-executor：
node --test --test-concurrency=1 test/history-summary-executor.test.js
exit 0; tests 1, pass 1, fail 0; test duration 202.4127ms; runner duration 5303.5338ms

node --test --test-concurrency=1 --test-name-pattern="W1 · summarize / periodComparison" test/w1-executor.test.js
exit 0; tests 1, pass 1, fail 0

node --test --test-concurrency=1 test/history-executor-backup.test.js
exit 0; tests 10, pass 10, fail 0

npx.cmd biome check src/usage-executor.js test/history-summary-executor.test.js
exit 0; Checked 2 files. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-summary-executor 返修（period publication gate）：
node --test --test-concurrency=1 test/history-period-executor.test.js
exit 0; tests 3, pass 2, fail 0, skipped 1; duration 5622.2012ms
  - main cold-aware fixture: 208.4943ms
  - gate child: 5335.8678ms（外部 writer 已 COMMIT；pinned 130；独立 period 230；释放后 republish 230）

node --test --test-concurrency=1 test/history-summary-executor.test.js
exit 0; tests 1, pass 1, fail 0; test duration 199.3152ms; runner duration 5289.7611ms

npx.cmd biome check test/history-period-executor.test.js test/history-summary-executor.test.js src/usage-executor.js
exit 0; Checked 3 files in 13ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-metadata：
node --test --test-concurrency=1 --test-name-pattern="metadataHistory without authority|authorized cold plus" test/history-archive-store.test.js
exit 0; tests 2, pass 2, fail 0; duration 405.2421ms

node --test --test-concurrency=1 test/history-archive-store.test.js
exit 0; tests 28, pass 28, fail 0; duration 3045.5756ms

npx.cmd biome check test/history-archive-store.test.js
exit 0; Checked 1 file in 33ms. No fixes applied.

npx.cmd biome lint src/usage-store.js
exit 0; Checked 1 file in 66ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-summary-sync-seam：
node --test --test-concurrency=1 test/history-cold-summary-prepared.test.js
exit 0; tests 1, pass 1, fail 0; duration 210.4853ms; runner duration 311.0308ms

node --test --test-concurrency=1 --test-name-pattern="authorized cold plus Codex cumulative delta" test/history-archive-store.test.js
exit 0; tests 1, pass 1, fail 0; duration 293.9625ms; runner duration 373.6586ms

npx.cmd biome lint src/usage-store.js
exit 0; Checked 1 file in 69ms. No fixes applied.

npx.cmd biome check test/history-cold-summary-prepared.test.js
exit 0; Checked 1 file in 5ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-freeze-HTTP-read（修复前反例）：
node --test --test-concurrency=1 test/history-cold-freeze-api.test.js
exit 1; tests 1, pass 0, fail 1; duration 269.4375ms; runner 5378.851ms
AssertionError: freeze response actual summary 30/1, metadata 2/1, period 30; expected 130/2/130

# 修复后：
node --test --test-concurrency=1 test/history-cold-freeze-api.test.js
exit 0; tests 1, pass 1, fail 0; duration 327.6398ms; runner 5427.57ms

node --test --test-concurrency=1 --test-name-pattern="paused usage keeps the same indexed data across range changes|pricing model activity keeps historical rates and honors a frozen usage snapshot|D4 · 周期 API 的 asOf 仍新鲜 \+ 改数据立即失效" test/server.test.js
exit 0; tests 3, pass 3, fail 0; durations 219.1756ms / 164.3394ms / 253.6584ms; runner 5770.5567ms

node --test --test-concurrency=1 --test-name-pattern="HTTP snapshot keeps priority tier evidence after the live tier log changes" test/history-retention-api.test.js
exit 0; tests 1, pass 1, fail 0; duration 183.6078ms; runner 5323.1694ms

npx.cmd biome check src/server.js test/history-cold-freeze-api.test.js
exit 0; Checked 2 files in 16ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-freeze-pricing：
node --test --test-concurrency=1 --test-name-pattern="cold HTTP freeze keeps catalog A costs" test/history-cold-freeze-api.test.js
exit 0; tests 1, pass 1, fail 0; duration 403.4785ms; runner 5507.3652ms

node --test --test-concurrency=1 test/history-cold-freeze-api.test.js
exit 0; tests 2, pass 2, fail 0; durations 321.6822ms / 357.2881ms; runner 5790.9744ms

npx.cmd biome check test/history-cold-freeze-api.test.js
exit 0; Checked 1 file in 8ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-hot-tail-revision：
# 候选包创建依赖硬链接，以下为宿主重跑：
node --test --test-concurrency=1 test/history-cold-hot-tail-revision.test.js
exit 0; tests 1, pass 1, fail 0; duration 230.9437ms; runner 309.0371ms

npx.cmd biome check test/history-cold-hot-tail-revision.test.js
exit 0; Checked 1 file in 7ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-prefix-revision-red：
# 候选包创建依赖硬链接，以下为宿主重跑：
node --test --test-concurrency=1 test/history-cold-prefix-revision.test.js
exit 1; tests 1, pass 0, fail 1; test 199.8548ms, runner 275.5997ms
failure: sync warning HISTORY_ARCHIVE_COLD_REPARSE_CHANGED; held events [100, 30], oracle [90, 30]; actual cold total 100 vs expected 90

npx.cmd biome check test/history-cold-prefix-revision.test.js
exit 0; Checked 1 file in 6ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-revision-overlay-read：
# candidate 创建依赖硬链接，以下为宿主重跑：
node --test --test-concurrency=1 test/history-cold-revision-overlay.test.js
exit 0; tests 2, pass 2, fail 0; durations 143.2875ms / 111.5249ms; runner 331.4101ms

node --test --test-concurrency=1 --test-name-pattern="publishedHistoryUsageEvents matches an unarchived source oracle|hot and cold union oracle keeps mirrored facts once" test/history-archive-store.test.js
exit 0; tests 2, pass 2, fail 0; durations 113.5618ms / 158.0283ms; runner 351.4302ms

npx.cmd biome check test/history-cold-revision-overlay.test.js
exit 0; Checked 1 file in 7ms. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-store.js
exit 0; Checked 1 file in 72ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-revision-overlay-read trust-boundary 返修：
node --test --test-concurrency=1 --test-name-pattern="validates added payloads" test/history-cold-revision-overlay.test.js
修复前 exit 1; tests 1, pass 0, fail 1; duration 136.1249ms; runner 213.6268ms; Missing expected rejection
修复后 exit 0; tests 1, pass 1, fail 0; duration 147.1381ms; runner 222.4562ms

node --test --test-concurrency=1 test/history-cold-revision-overlay.test.js
exit 0; tests 3, pass 3, fail 0; durations 151.9709ms / 105.6082ms / 106.4779ms; runner 440.5796ms

npx.cmd biome check test/history-cold-revision-overlay.test.js
exit 0; Checked 1 file in 7ms. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-store.js
exit 0; Checked 1 file in 71ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-prefix-revision-write：
# 候选包创建依赖硬链接，以下为宿主重跑：
node --test --test-concurrency=1 test/history-cold-prefix-revision.test.js
exit 0; tests 1, pass 1, fail 0; duration 330.9559ms; runner 409.5235ms

npx.cmd biome check test/history-cold-prefix-revision.test.js
exit 0; Checked 1 file in 9ms. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-store.js
exit 0; Checked 1 file in 76ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-prefix-revision-rollback：
# 候选包创建依赖硬链接，以下为宿主重跑：
node --test --test-concurrency=1 test/history-cold-prefix-revision.test.js
exit 0; tests 1, pass 1, fail 0; duration 325.3505ms; runner 400.1453ms

npx.cmd biome check test/history-cold-prefix-revision.test.js
exit 0; Checked 1 file in 9ms. No fixes applied.

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-prefix-late-add：
# 候选包创建依赖硬链接，以下为宿主重跑。
# 红测：strict identity-set check 拒绝追加，sync warning 后 revision metadata 不存在。
node --test --test-concurrency=1 test/history-cold-prefix-late-add.test.js
exit 1; tests 1, pass 0, fail 1; duration 154.6017ms; runner 230.699ms
failure: SyntaxError: "undefined" is not valid JSON at revisionMeta JSON.parse

# 最小修复后专用重跑：
node --test --test-concurrency=1 test/history-cold-prefix-late-add.test.js
exit 0; tests 1, pass 1, fail 0; duration 230.3517ms; runner 310.0735ms

# 既有 cold-prefix 值修订 + late add 回归：
node --test --test-concurrency=1 test/history-cold-prefix-revision.test.js test/history-cold-prefix-late-add.test.js
exit 0; tests 2, pass 2, fail 0; durations 238.4947ms / 335.7358ms; runner 721.6536ms

npx.cmd biome check test/history-cold-prefix-late-add.test.js
exit 0; Checked 1 file in 6ms. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-store.js
exit 0; Checked 1 file in 78ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-revision-bundle-transfer：
# 候选包与 bundle/import 创建依赖硬链接，以下为宿主重跑：
node --test --test-concurrency=1 test/history-cold-revision-bundle.test.js
exit 0; tests 1, pass 1, fail 0; duration 431.8746ms; runner 509.7743ms

npx.cmd biome check test/history-cold-revision-bundle.test.js
exit 0; Checked 1 file in 7ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-prefix-removal-red：
# 候选包创建依赖硬链接，以下为宿主重跑；此卡预期为 red。
node --test --test-concurrency=1 test/history-cold-prefix-removal.test.js
exit 1; tests 1, pass 0, fail 1; duration 192.0554ms; runner 262.7387ms
failure: syncError=null; warning="无法索引 <path>: reparsed source removes or migrates cold events in authorized segment <id>";
actual events [20, 100, 30], summary 150; oracle events [100, 30], summary 130; hot facts [30];
candidate digest unchanged, segment [20, 100], revisionRemoved=[], recoveryFacts=[]

npx.cmd biome check test/history-cold-prefix-removal.test.js
exit 0; Checked 1 file in 6ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-prefix-removal-write：
# 候选包创建依赖硬链接，以下为宿主重跑。主审返修先补 forced-reparse 红证据：
node --test --test-concurrency=1 test/history-cold-prefix-removal.test.js
exit 1; tests 1, pass 0, fail 1; duration 263.0951ms; runner 340.9868ms
failure: updatedFileCount=0；旧 guard 额外发布一次 `reparsed source removes or migrates cold events`；
committed events 仍为 [100, 30] / 130，revision metadata 稳定，`PROJECT_LOG_TRUNCATED count=1` 未被破坏；
但同内容 invalidate 后没有完成真实重解析（expected updatedFileCount=1）。

# 移除 obsolete original-effective 检查，并把纯删除限定到 project-log；同文件同时覆盖 Codex 拒绝：
node --test --test-concurrency=1 test/history-cold-prefix-removal.test.js
exit 0; tests 2, pass 2, fail 0; durations 254.9957ms / 157.7586ms; runner 488.7833ms
evidence: project-log forced reparse updatedFileCount=1、events/总用量仍为 [100, 30] / 130；
revision bytes 稳定、sidecar 仍只有一条 `PROJECT_LOG_TRUNCATED count=1`；
Codex 同类删除 updatedFileCount=0、公开仍为 [20, 100, 30]，不产生 project-log truncation marker。

node --test --test-concurrency=1 test/history-cold-prefix-removal.test.js test/history-cold-prefix-late-add.test.js test/history-cold-prefix-revision.test.js
exit 0; tests 4, pass 4, fail 0; durations 230.835ms / 240.0483ms / 121.373ms / 341.3164ms; runner 1144.2336ms

npx.cmd biome lint src/usage-store.js
exit 0; Checked 1 file in 76ms. No fixes applied.

npx.cmd biome check test/history-cold-prefix-removal.test.js
exit 0; Checked 1 file in 8ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-removal-rollback：
# 候选包创建依赖硬链接，以下为宿主重跑。
node --test --test-concurrency=1 test/history-cold-prefix-removal.test.js
exit 0; tests 3, pass 3, fail 0; duration 591.9342ms

node --test --test-concurrency=1 test/history-cold-prefix-removal.test.js test/history-cold-prefix-late-add.test.js test/history-cold-prefix-revision.test.js
exit 0; tests 5, pass 5, fail 0; durations 238.8818ms / 232.438ms / 123.9927ms / 174.6193ms / 335.1328ms; runner 1317.1345ms

npx.cmd biome check test/history-cold-prefix-removal.test.js
exit 0; Checked 1 file in 11ms. No fixes applied.

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-perf-eviction-red：
# 候选包创建依赖硬链接，以下为宿主重跑；此卡预期 red。
node --test --test-concurrency=1 test/history-cold-perf-eviction.test.js
exit 1; tests 1, pass 0, fail 1; duration 256.509ms; runner 328.22ms
failure: archived coverage eligible=33/sampled=29 vs oracle 34/30; cold small-model n=4, p10=2, averageTps=3.857142857142857 vs oracle n=5, p10=1, averageTps=3.6666666666666665; hot ranked-model n=25, averageTps=224 unchanged; segmentAfter==segmentBefore

npx.cmd biome check test/history-cold-perf-eviction.test.js
exit 0; Checked 1 file in 5ms. No fixes applied.

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-cold-perf-read：
# 候选包创建依赖硬链接，以下测试为宿主重跑。
node --test --test-concurrency=1 test/history-cold-perf-reader.test.js
exit 0; tests 1, pass 1, fail 0; duration 190.0742ms; runner 259.8939ms

npx.cmd biome check test/history-cold-perf-reader.test.js
exit 0; Checked 1 file in 4ms. No fixes applied.

npx.cmd biome check src/usage-store.js test/history-cold-perf-reader.test.js
exit 1; formatter仍报告该长文件既有的换行风格差异（例如 :568、:585、:661），均不在新增 reader 或其 helper 上；未自动改写

npx.cmd biome lint src/usage-store.js
exit 0; Checked 1 file in 75ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-perf-reader-missing-file：
# 同一宿主夹具；生产源码未改。
node --test --test-concurrency=1 test/history-cold-perf-reader.test.js
exit 0; tests 1, pass 1, fail 0; duration 212.331ms; runner 287.0129ms

npx.cmd biome check test/history-cold-perf-reader.test.js
exit 0; Checked 1 file in 14ms. No fixes applied.

git diff --check -- test/history-cold-perf-reader.test.js
exit 0

# B-cold-timing-source-candidate-fidelity：
# 候选包创建依赖硬链接，以下为宿主重跑；生产源码未改。
node --test --test-concurrency=1 test/history-cold-timing-source-candidate.test.js
exit 0; tests 1, pass 1, fail 0; duration 134.9768ms; runner 209.3127ms

npx.cmd biome check test/history-cold-timing-source-candidate.test.js
exit 0; Checked 1 file in 9ms. No fixes applied.

git diff --check -- test/history-cold-timing-source-candidate.test.js
exit 0

# B-cold-workbuddy-duration-fidelity：
# 候选包创建依赖硬链接，以下为宿主重跑；生产源码未改。
node --test --test-concurrency=1 test/history-cold-workbuddy-source-candidate.test.js
exit 0; tests 1, pass 1, fail 0; duration 96.7556ms; runner 167.0617ms

npx.cmd biome check test/history-cold-workbuddy-source-candidate.test.js
exit 0; Checked 1 file in 5ms. No fixes applied.

git diff --check -- test/history-cold-workbuddy-source-candidate.test.js
exit 0

# B-cold-unplaced-retention：
# 候选包创建依赖硬链接，以下为宿主重跑；生产源码未改。
node --test --test-concurrency=1 test/history-cold-unplaced-retention.test.js
exit 0; tests 1, pass 1, fail 0; duration 201.5495ms; runner 274.3322ms

npx.cmd biome check test/history-cold-unplaced-retention.test.js
exit 0; Checked 1 file in 5ms. No fixes applied.

git diff --check -- test/history-cold-unplaced-retention.test.js
exit 0

# B-cold-perf-dependency-closure-red：
# 候选包创建与重打包依赖硬链接；以下为宿主预期红，生产源码未改。
node --test --test-concurrency=1 test/history-cold-perf-dependency-closure.test.js
exit 1; tests 1, pass 0, fail 1; duration 185.3568ms; runner 261.6147ms; Missing expected rejection

npx.cmd biome check test/history-cold-perf-dependency-closure.test.js
exit 0; Checked 1 file in 5ms. No fixes applied.

git diff --check -- test/history-cold-perf-dependency-closure.test.js
exit 0

# B-cold-timing-manifest-red：
# 候选包创建与重打包依赖硬链接；以下为宿主预期红，生产源码未改。
node --test --test-concurrency=1 test/history-cold-timing-manifest.test.js
exit 1; tests 1, pass 0, fail 1; duration 167.1842ms; runner 240.0063ms; Missing expected rejection

npx.cmd biome check test/history-cold-timing-manifest.test.js
exit 0; Checked 1 file in 5ms. No fixes applied.

git diff --check -- test/history-cold-timing-manifest.test.js
exit 0

# B-cold-timing-manifest-write：
# 候选包创建与重打包依赖硬链接；以下为宿主定向验证。
node --test --test-concurrency=1 test/history-cold-timing-manifest.test.js
exit 0; tests 2, pass 2, fail 0; durations 185.8197ms / 286.6314ms; runner 546.3815ms

node --test --test-concurrency=1 test/history-cold-perf-dependency-closure.test.js
exit 0; tests 1, pass 1, fail 0; duration 168.1664ms; runner 239.7325ms

npx.cmd biome check src/history-archive.js test/history-cold-timing-manifest.test.js
exit 0; Checked 2 files in 23ms. No fixes applied.

git diff --check -- src/history-archive.js test/history-cold-timing-manifest.test.js
exit 0

# B-workbuddy-observation-manifest-red：
# 候选包创建与重打包依赖硬链接；以下为宿主预期红，生产源码未改。
node --test --test-concurrency=1 test/history-cold-workbuddy-manifest.test.js
exit 1; tests 1, pass 0, fail 1; duration 130.7875ms; runner 209.5344ms; Missing expected rejection

npx.cmd biome check test/history-cold-workbuddy-manifest.test.js
exit 0; Checked 1 file in 11ms. No fixes applied.

git diff --check -- test/history-cold-workbuddy-manifest.test.js
exit 0

# B-zcode-cold-perf-authority-red：
# 候选包创建依赖硬链接；以下为宿主预期红，生产 store 未改。
node --test --test-concurrency=1 test/history-cold-perf-authority.test.js
exit 1; tests 1, pass 0, fail 1; duration 251.5168ms; runner 329.2301ms

npx.cmd biome check test/history-cold-perf-authority.test.js
exit 0; Checked 1 file in 8ms. No fixes applied.

git diff --check -- test/history-cold-perf-authority.test.js
exit 0; src/usage-store.js SHA-256 保持 f501e615b93054bed272fc000466778f978444a57ebc0dc85ee9963168faef89

# B-zcode-cold-perf-carrier-write：
# 候选/归档测试依赖硬链接，以下为宿主运行。
node --test --test-concurrency=1 test/history-cold-perf-authority.test.js
exit 0; tests 1, pass 1, fail 0; duration 260.2924ms; runner 339.4847ms

node --test --test-concurrency=1 test/history-cold-perf-reader.test.js
exit 0; tests 1, pass 1, fail 0; duration 214.687ms; runner 297.5804ms

npx.cmd biome check test/history-cold-perf-authority.test.js
exit 0; Checked 1 file in 7ms. No fixes applied.

npx.cmd biome check --formatter-enabled=false src/usage-store.js test/history-cold-perf-authority.test.js
exit 0; Checked 2 files in 80ms. No fixes applied.
# 全文件 formatter 仍命中本卡范围外既有行；本卡新增源码行已按 formatter 手工收口。

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0

src/usage-store.js SHA-256: f501e615b93054bed272fc000466778f978444a57ebc0dc85ee9963168faef89 -> f0118bdf3cbb2c2ec25ac2fad58c4a3ef4c5fe9a2bab0c48ae265fea2a64f8f6
# B-perf-authority-guards-red：
# 候选创建/重打包依赖硬链接，以下为宿主运行。
node --test --test-concurrency=1 test/history-cold-perf-authority-guards.test.js
exit 1; tests 3, pass 2, fail 1; durations 193.4282ms / 161.7004ms / 209.3665ms; runner 646.4436ms
# fail: perf authority without event marker -> Missing expected rejection（预期红）

npx.cmd biome check test/history-cold-perf-authority-guards.test.js
exit 0; Checked 1 file in 7ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

src/usage-store.js SHA-256 before/after: f0118bdf3cbb2c2ec25ac2fad58c4a3ef4c5fe9a2bab0c48ae265fea2a64f8f6
# B-perf-authority-fastpath-fix：
node --test --test-concurrency=1 test/history-cold-perf-authority-guards.test.js test/history-cold-perf-authority.test.js
exit 0; tests 4, pass 4, fail 0; durations 186.6268ms / 162.1995ms / 193.0239ms / 259.4556ms; runner 953.2505ms

npx.cmd biome check --formatter-enabled=false src/usage-store.js
exit 0; Checked 1 file in 81ms. No fixes applied.

git diff --check -- src/usage-store.js
exit 0

src/usage-store.js SHA-256: f0118bdf3cbb2c2ec25ac2fad58c4a3ef4c5fe9a2bab0c48ae265fea2a64f8f6 -> eebda75e848e8cfe28b850e45bd1a3fbf085fc0d1f7552dc293a80ebbe9d9f5c
# 按 owner 指令未重跑 typecheck 或全仓套件。
# B-cold-perf-overlap-conflict：
# 真实 ZCode 重叠样本；候选创建依赖硬链接，以下为宿主运行。
node --test --test-concurrency=1 test/history-cold-perf-conflict.test.js
exit 0; tests 1, pass 1, fail 0; duration 275.5205ms; runner 352.9673ms

npx.cmd biome check test/history-cold-perf-conflict.test.js
exit 0; Checked 1 file in 6ms. No fixes applied.

git diff --check -- test/history-cold-perf-conflict.test.js
exit 0

src/usage-store.js SHA-256 before/after: eebda75e848e8cfe28b850e45bd1a3fbf085fc0d1f7552dc293a80ebbe9d9f5c
# 按 owner 指令未跑 typecheck 或全仓套件。
# B-zcode-perf-multisegment-write：
# A multisegment red before write: independent 0/1, HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID, 290.7575ms; runner 376.7086ms.
node --test --test-concurrency=1 test/history-cold-perf-multisegment.test.js test/history-cold-perf-authority.test.js test/history-cold-perf-authority-guards.test.js test/history-cold-perf-conflict.test.js
exit 0; tests 6, pass 6, fail 0; durations 189.817ms / 165.4088ms / 195.1847ms / 286.8694ms / 318.4478ms / 345.959ms; runner 1830.9297ms

npx.cmd biome check --formatter-enabled=false src/usage-store.js test/history-cold-perf-authority-guards.test.js
exit 0; Checked 2 files in 87ms. No fixes applied.

npx.cmd biome check test/history-cold-perf-authority-guards.test.js
exit 0; Checked 1 file in 8ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check -- src/usage-store.js test/history-cold-perf-authority-guards.test.js
exit 0

src/usage-store.js SHA-256: eebda75e848e8cfe28b850e45bd1a3fbf085fc0d1f7552dc293a80ebbe9d9f5c -> edaa14380291912f36e7da8c801bd75a48f0a23bee9017dd3e2c644683f7ce12
# B-codex-cold-perf-authority-red：
# 真实 Codex fixture + native request-timing seed；候选创建依赖硬链接，以下为宿主运行。
node --test --test-concurrency=1 test/history-cold-codex-perf-authority.test.js
exit 1; tests 1, pass 0, fail 1; duration 162.5831ms; runner 243.537ms
# Expected red: Codex cold perf authority must produce a summary, got HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID

npx.cmd biome check test/history-cold-codex-perf-authority.test.js
exit 0; Checked 1 file in 7ms. No fixes applied.

git diff --check -- test/history-cold-codex-perf-authority.test.js
exit 0

src/usage-store.js SHA-256 before/after: edaa14380291912f36e7da8c801bd75a48f0a23bee9017dd3e2c644683f7ce12
# 按 owner 指令未跑 typecheck 或全仓套件。
# B-codex-cold-perf-authority-write：
# Codex 红转绿 + ZCode single/guard/conflict/multisegment 回归，候选硬链接使用宿主运行。
node --test --test-concurrency=1 test/history-cold-codex-perf-authority.test.js test/history-cold-perf-authority-guards.test.js test/history-cold-perf-authority.test.js test/history-cold-perf-multisegment.test.js test/history-cold-perf-conflict.test.js
exit 0; tests 8, pass 8, fail 0; durations 174.0254ms / 178.5802ms / 152.7308ms / 177.9024ms / 184.4083ms / 257.5037ms / 268.1085ms / 300.0958ms; runner 2057.9682ms

npx.cmd biome check --formatter-enabled=false src/usage-store.js test/history-cold-perf-authority-guards.test.js
exit 0; Checked 2 files in 79ms. No fixes applied.

npx.cmd biome check test/history-cold-perf-authority-guards.test.js test/history-cold-codex-perf-authority.test.js
exit 0; Checked 2 files in 8ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check -- src/usage-store.js test/history-cold-perf-authority-guards.test.js test/history-cold-codex-perf-authority.test.js
exit 0

src/usage-store.js SHA-256: edaa14380291912f36e7da8c801bd75a48f0a23bee9017dd3e2c644683f7ce12 -> 925c8a3153faeeb66925a1d441f2912b5eff4ff1200772653500bd47a8c5f078

# B-codex-cold-perf-transfer：
# 真实 Codex fixture + native request-timing；bundle/import 依赖宿主硬链接。
node --test --test-concurrency=1 test/history-cold-codex-perf-transfer.test.js
exit 0; tests 1, pass 1, fail 0; duration 398.2668ms; runner 476.3018ms

npx.cmd biome check test/history-cold-codex-perf-transfer.test.js
exit 0; Checked 1 file in 9ms. No fixes applied.

git diff --check -- test/history-cold-codex-perf-transfer.test.js
exit 0

src/usage-store.js SHA-256 before/after: 925c8a3153faeeb66925a1d441f2912b5eff4ff1200772653500bd47a8c5f078
# 按 owner 指令未跑 typecheck、旧 transfer 测试或全仓套件。
# B-cold-snapshot-cleanup：
# 首次在受限沙箱运行因候选备份硬链接 EPERM 失败；断言未改，以下为宿主重跑：
# 上一版 invalid imports 反例不计证据；本版在第 2 项用测试本地 prototype patch 确保 executor 已创建主库与段副本后再失败。
node --test --test-concurrency=1 test/history-cold-snapshot-cleanup.test.js
exit 0; tests 3, pass 3, fail 0; durations 718.8019ms / 307.6707ms / 246.7467ms; runner 6368.6799ms

node --test --test-concurrency=1 test/history-cold-freeze-api.test.js
exit 0; tests 1, pass 1, fail 0; duration 340.8768ms; runner 5464.1066ms

node --test --test-concurrency=1 --test-name-pattern="paused usage keeps the same indexed data across range changes|pricing model activity keeps historical rates and honors a frozen usage snapshot|D4 · 周期 API 的 asOf 仍新鲜" test/server.test.js
exit 0; tests 3, pass 3, fail 0; durations 201.6528ms / 165.2176ms / 268.9031ms; runner 5744.4334ms

node --test --test-concurrency=1 --test-name-pattern="HTTP snapshot keeps priority tier evidence after the live tier log changes" test/history-retention-api.test.js
exit 0; tests 1, pass 1, fail 0; duration 191.4748ms; runner 5290.0293ms

npx.cmd biome check src/server.js test/history-cold-snapshot-cleanup.test.js
exit 0; Checked 2 files in 17ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-C2-model-read：
node --test --test-concurrency=1 test/history-rollup-store.test.js
exit 0; tests 19, pass 15, fail 0, skipped 4; duration 1365.5236ms

npx.cmd biome check src/usage-store.js test/history-rollup-store.test.js
exit 0; Checked 2 files in 85ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-C2-public-model-read（B-C2-clamp-scoped-window 修复前的反例）：
node --test --test-concurrency=1 --test-name-pattern="real periodComparison uses model rollups" test/history-rollup-store.test.js
exit 1; tests 1, pass 0, fail 1; duration 175.7385ms
AssertionError: {"windows":[{"key":"today","start":"2026-07-15T00:00:00.000Z","end":"2026-07-15T23:59:59.999Z"},{"key":"week","start":"2026-07-13T00:00:00.000Z","end":"2026-07-15T23:59:59.999Z"},{"key":"month","start":"2026-07-01T00:00:00.000Z","end":"2026-07-15T23:59:59.999Z"},{"key":"all","start":"2026-07-12T00:00:00.000Z","end":"2026-07-14T23:59:59.999Z"}],"utcRollupDays":["2026-07-12","2026-07-13","2026-07-14"],"counts":{"rollupDayChecks":1,"rollupQueries":0,"rollupModelQueries":0,"fallbackQueries":0,"periodAggregateQueries":2,"modelPeriodAggregateQueries":1,"costEventQueries":0}}

node --test --test-concurrency=1 test/history-rollup-store.test.js
exit 1; tests 20, pass 15, fail 1, skipped 4; duration 1476.0992ms

npx.cmd biome check test/history-rollup-store.test.js
exit 0; Checked 1 file in 19ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-C2-clamp-scoped-window：
node --test --test-concurrency=1 --test-name-pattern="real periodComparison uses model rollups" test/history-rollup-store.test.js
exit 0; tests 1, pass 1, fail 0; duration 173.2479ms

node --test --test-concurrency=1 --test-name-pattern="periodAggregate routes only|model periodAggregate matches|missing model rollup days" test/history-rollup-store.test.js
exit 0; tests 3, pass 3, fail 0; duration 276.8540ms

node --test --test-concurrency=1 test/history-rollup-store.test.js
exit 0; tests 20, pass 16, fail 0, skipped 4; duration 1439.1878ms

npx.cmd biome check src/usage-store.js test/history-rollup-store.test.js
exit 0; Checked 2 files in 85ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check
exit 0（仅工作树其他文件原有的 public/index.html CRLF 提示）

# B-perf-timing-revision-read 返修：
# 重复 removed 累计 + candidate-native timing evidence 全 link 闭包；真实 Codex candidate 使用宿主硬链接。
node --test --test-concurrency=1 test/history-cold-perf-revision-overlay.test.js
exit 0; tests 1, pass 1, fail 0; duration 537.7743ms; runner 632.3214ms

node --test --test-concurrency=1 test/history-cold-perf-revision-overlay.test.js test/history-cold-perf-authority.test.js test/history-cold-perf-authority-guards.test.js test/history-cold-perf-conflict.test.js test/history-cold-perf-multisegment.test.js
exit 0; tests 8, pass 8, fail 0; runner 3135.1353ms

npx.cmd biome check test/history-cold-perf-revision-overlay.test.js
exit 0; Checked 1 file in 14ms. No fixes applied.

npx.cmd biome lint src/usage-store.js
exit 0; Checked 1 file in 107ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check -- src/usage-store.js test/history-cold-perf-revision-overlay.test.js
exit 0

src/usage-store.js SHA-256: c4799d4c6fe1bf6fad2552223e38a78a7e5522da59635d2da2b69a33c3e16e55
test/history-cold-perf-revision-overlay.test.js SHA-256: c2577348ffb1f17b85e720cb1d201d3c78d3aa3313c957e5671cab5bf293c86b
# 本次返修前像（未覆盖）：
output/codex-usage-store-B-perf-timing-revision-read-fd0c9a37.js
SHA-256: fd0c9a37e6609224e864bc0d123736e180935b2243d293e1fa46f8e95ebc40d6
output/history-cold-perf-revision-overlay-B-perf-timing-revision-read-7cf8ad63.js
SHA-256: 7cf8ad63fba93957a345dd09d207c6c0adbf3840165a5874ed572133dfa06e34
# 基线说明：925c8a… 没有保存为独立原始前像；以下是从真实 edaa1438… 前像加已接受 Codex patch 正向重放所得。
output/history-retention-resume-20261024/usage-store.925c8a.reconstructed-from-edaa-and-accepted-codex-patch.js
SHA-256: 925c8a3153faeeb66925a1d441f2912b5eff4ff1200772653500bd47a8c5f078
output/history-retention-resume-20261024/usage-store.925c8a.reconstruction.json
# B-codex-late-timing-revision-write（三项主审根因返修）：
# candidate 创建/验证依赖硬链接，以下为宿主重跑。
node --test --test-concurrency=1 test/history-cold-codex-late-timing.test.js
exit 0; tests 1, pass 1, fail 0; duration 472.3911ms; runner 579.1202ms

npx.cmd biome check test/history-cold-codex-late-timing.test.js
exit 0; Checked 1 file in 13ms. No fixes applied.

npx.cmd biome lint src/usage-store.js
exit 0; Checked 1 file in 115ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check -- src/usage-store.js test/history-cold-codex-late-timing.test.js
exit 0

src/usage-store.js SHA-256: 28971f8c3b3f28791b4bb74fc6a215ebce983c5d7652d389bc9f975bef242507
test/history-cold-codex-late-timing.test.js SHA-256: 10d7cbd29e12ab3638d609a024e5bd7c34cb8f450727f36782eb4d384755f87c

# B-codex-revision-rollback（返修：精确具名失败与真实非空边界）：
# candidate 创建/验证依赖宿主硬链接。
node --test --test-concurrency=1 test/history-cold-codex-revision-rollback.test.js
exit 0; tests 1, pass 1, fail 0; duration 435.4473ms; runner 522.7224ms
# 主审独立复核：1/1，451.1657ms；runner 537.1394ms

npx.cmd biome check test/history-cold-codex-revision-rollback.test.js
exit 0; Checked 1 file in 10ms. No fixes applied.

git diff --check -- test/history-cold-codex-revision-rollback.test.js
exit 0

src/usage-store.js SHA-256: edf21f09ab7f9a2fb5b87a58e14ba88450109eb1ecd108917d6bb4fa35cefb52
test/history-cold-codex-revision-rollback.test.js SHA-256: 95ebdd71e6ac563822ba386067e4c46a21228703bed61acefc9657590b86bebe
```

**B-cold-timing-source-candidate-fidelity** 只新增真实行为测试，生产文件冻结。`createPerfCodexIntegrationFixture()` 先通过真实 Codex rollout sync 建立 25 个 turn 的 `perf_samples`、3 个 rollout 的 `perf_sample_sources` / `perf_rollout_threads` 关系、对应 `source_files` 身份，以及 26 条 request-timing response link 与 evidence。测试以 `2026-10-04T12:02:00.000Z` 为冷/热界创建一个真实 candidate；该候选从整库 backup 构造，只删除范围外 `events`，因此依赖表应完整保留。

测试由最早冷样本反查唯一 `home_id/thread_id`，再对该线程捕获全部 perf samples、sample sources、rollout owners、source identities 和 timing meta/evidence/thread rows。candidate 创建前后 source graph 深相等，证明备份构建没有改写 live 依赖；candidate 与 source graph 逐行深相等，且 source 与 candidate 的同一线程都同时含冷、热 perf samples 与 `dependency` source rows。candidate SHA-256 在只读打开、事务读取和关闭前后不变。该结果只证明候选包对现有依赖表的保真，不证明这些热依赖可以在归档淘汰后删除，也不证明冷 timing/merge 已实现。

返修增加一个独立 closure guard：`timingEvidence` 与 `timingThreads` 必须各等于 `fixture.timingRecords.length`，每条 evidence 的原生 `(home_id,response_id)` 必须存在 link，所有 `perf_sample_sources` / `perf_rollout_threads` 的 `source_path` 必须存在对应 `source_files` 身份。原有 source/candidate raw rows 逐列深相等断言保持不变，因此空 graph 不能再误绿。

**B-cold-workbuddy-duration-fidelity** 复用真实 WorkBuddy 解析路径，不构造数据库伪造行。夹具在同一 `.workbuddy-ai` 下写入一条 usage session 和一条 trace；trace 对同一 `messageId` 给出两个原生 `generation` `span_end` 时长 `800ms`、`850ms`。普通 `sync()` 后，source 的 `workbuddy_generation_duration_observations` 按稳定顺序同时保留这两条异值观察，observation 的每个 `home_id` 都能在 `source_files` 找到 `kind = "workbuddy"` 的身份；冲突没有补造任何 WorkBuddy `perf_samples`。测试随后用既有 `createHistoryArchiveCandidate()` 创建真实 candidate，并比较 source 在创建前后的 observation、来源身份和 sample-key 快照；再只读打开 candidate，逐列比较同一快照。source 与 candidate 的 observation 和身份完全相等，冲突仍对应零样本，候选 SHA-256 在打开、查询和关闭前后不变。该证据只固定原始原生时长观察与来源身份的 candidate 保真，不把冲突“修复”成单一样本，也不实现冷合并、投影、淘汰或恢复。

**B-cold-unplaced-retention** 用真实 ZCode fixture 自带的 `unplaced` 行验证“无时间位置”不会被事件封存误处理。测试先记录 `unplacedPerfSamples()` 的完整解码结果，再创建 `[coldStartMs, HOT_START_MS)` candidate、登记并写入显式 event authority；随后只在隔离 store 的同一事务中删除该冷范围 `events`，没有删除任何 perf 行。封存后 `unplacedPerfSamples()` 与封存前逐字段深相等，candidate 中也仍有该 `sample_key` 且 `ts_ms = NULL`。candidate 的 `history_archive_perf_sources_v1` 对 unplaced 来源只记录有限范围内样本的数量与 SHA-256，预期键集不包含 unplaced key；`readHistoryArchivePerfSamples()` 返回的 `(sample_key, ts_ms)` 与 candidate 有限范围 SQL 完全相等，因此没有为 NULL 行猜日期，也没有把它塞进范围统计。该证据只覆盖 event 冷段封存后的 hot perf 保留与现有 reader 边界；本卡没有执行或验证 perf 淘汰。

**B-cold-perf-dependency-closure-red** 复用真实 Codex fixture 和 `seedRequestTiming()`，在创建 candidate 前从 source 锁定冷样本 `["codex","<fixture-home>","fixture-codex-thread","turn-01"]` 及其 `perf_sample_sources` 原生依赖：同一 fixture home、`thread_id=fixture-codex-thread`、依赖 rollout `.../rollout-2.jsonl`、`role="dependency"`，并确认同一线程存在 `perf_request_timing_threads` 连接。创建 candidate 后重新读取同一关系，断言 sample/source、role、owner 与 timing-link 计数逐列深相等，先证明 candidate 保真。测试随后复制 candidate，只删除该 `(sample_key, source_path, role = "dependency")` 主键，确认被引用的 `perf_samples` 行仍存在；再以 `createHistoryBackup()` 重新打包并显式确认外层 `verifyHistoryBackup()` 通过。当前 `verifyHistoryArchiveCandidate()` 仍接受该不完整图，没有抛出预期错误，因此 `assert.rejects` 以 `Missing expected rejection` 失败。该断言把未来契约固定在候选验证接缝：每个冷样本实际引用的 `perf_sample_sources`/原生 timing 依赖必须闭合，缺失时应以 `HISTORY_ARCHIVE_CANDIDATE_PERF_DEPENDENCIES_MISMATCH` 拒绝，而不是把重打包后的备份保真当作 perf 图完整的证明；它不是对某个已实现 verifier 能力字段的回归测试。

**B-cold-timing-manifest-red** 复用真实 Codex fixture 与 `seedRequestTiming()`，从 source SQL 按显式关系锁定 `冷 perf_samples → perf_sample_sources → perf_rollout_threads owner → perf_request_timing_threads response/thread → perf_request_timing_evidence`，没有用 response 时间或样本时间推断配对。选中样本保留 primary 与 dependency 多个来源，原始 evidence 的复合主键为 `(home_id, evidence_origin, response_id, variant_key)`；本夹具命中 `response-1-1` 的非空行。测试先快照样本来源身份和 evidence 全列，再创建 candidate 并逐列深相等，证明整库 backup 未丢失该链路。随后只复制 candidate 并执行一条 `UPDATE perf_request_timing_evidence SET duration_ms = duration_ms + 1`：复合主键、`variant_key`、model、token 数、status 与 `completed_at_ms` 均不变，并断言恰好更新一行且回读后仅 `duration_ms` 不同。`createHistoryBackup()` 重新打包后 `verifyHistoryBackup()` 明确通过；当前 `verifyHistoryArchiveCandidate()` 仍接受该被改写的原始 timing 值，`assert.rejects` 因而以 `Missing expected rejection` 失败。期望的未来错误码是 `HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH`：候选 manifest 不能只摘要 sample/index 派生值，还必须覆盖被冷样本显式关联的 request timing 原始 evidence。该卡是未来 timing manifest 契约的预期红，不是现有 verifier 在线能力回退；不涉及 timing revision、summary 重算、热行删除或 WorkBuddy 时长。

**B-cold-timing-manifest-write** 在写入前核对 archive 基线 SHA-256 为 `4e76ff3ab6b82ecdc045e09ac202a7d93afc240a96f5f9b6f6100c0524026969`。生产增量只放在 `createHistoryArchiveCandidate()` 与 `verifyHistoryArchiveCandidate()`：前者在既有 `BEGIN IMMEDIATE` 中、与旧 events/sources/perf keys 同一 `COMMIT` 前写 `history_archive_perf_timing_v1`；后者在既有只读 `BEGIN` 快照中重算并比较。两张 timing 表使用完整列常量，threads 按原生主键 `(home_id,response_id,thread_id)`、evidence 按 `(home_id,evidence_origin,response_id,variant_key)` 排序；每张表的摘要头固定包含 table/range/columns，正文逐行流式写入 canonical JSON。owner CTE 只从范围内 `perf_samples.source_path` 与 `perf_sample_sources.source_path` 取 `perf_rollout_threads`；link/evidence 只沿 owner 的 `home_id/thread_id` 与 link 的 `home_id/response_id` 展开，所有 evidence origin/variant 都保留。没有计算 meta/dirty/projection 摘要，也没有改 timing revision、统计、淘汰或其它 source 文件。

测试侧新增独立 source SQL digest oracle 并与 candidate key 完整深相等；原 duration 改写红测现在以精确 `HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH` 通过。另一个真实 candidate 测试删除全部 perf 元数据 key，证明 legacy candidate 仍按 events 兼容且不会凭空获得 timing 能力；再分别改写 timing format、range、thread row count 和 evidence hash，前两者严格返回 `HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_BAD_METADATA`，后两者严格返回 `HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH`。旧 perf sources/samples/index key 的写入与验证逻辑未改；相邻 index dependency 回归仍通过。

**B-workbuddy-observation-manifest-red** 只新增真实 WorkBuddy 行为测试，生产文件、schema 与归档格式均未改。夹具写入一条原生 usage session JSONL 和一条 trace，trace 对同一 `messageId` 产生 `800ms`、`850ms` 两条 `generation span_end` 观察；普通 `sync()` 后二者与对应 WorkBuddy `source_files` 身份同时存在，冲突按既有契约不产生 `perf_samples`。测试从 source 选择该 home 的唯一冷 usage event，以其 timestamp 的单毫秒范围创建既有 candidate，并确认 source 在创建前后、candidate 在只读打开后，observation/source-identity 快照都与 source 深相等。随后复制 candidate，仅把第一条被引用观察从 `800` 改为 `801`，确认同一 message 仍有两条观察；`createHistoryBackup()` 重打包后外层 `verifyHistoryBackup()` 明确通过。当前 `verifyHistoryArchiveCandidate()` 仍接受该候选，因此期望的 `HISTORY_ARCHIVE_CANDIDATE_WORKBUDDY_MISMATCH` 拒绝没有发生，专用测试以 `Missing expected rejection` 失败：`0/1`，`130.7875ms`，runner `209.5344ms`。Biome 与 scoped `git diff --check` 通过。

**B-zcode-cold-perf-authority-red** 只新增真实 ZCode 行为测试，`src/usage-store.js` 读写前后 SHA-256 均为 `f501e615b93054bed272fc000466778f978444a57ebc0dc85ee9963168faef89`。夹具建立完整 ZCode small/ranked 冷热 perf；候选先经 `verifyHistoryArchiveCandidate()`，并确认 `perf_sources_v1`、`perf_samples_v1`、`perf_index_v1`、`perf_timing_v1` 四个组件 key 均为 verified candidate 的一部分。登记同段后，测试显式写入共享该 `segmentId`/`databaseSha256` 的 event authority，以及冻结形状、只声明 `sourceKinds:["zcode"]` 与 `methodVersions:["tps-v2"]` 的 perf authority；随后只删除一个可计算的冷 `small-model` 样本，`perf_sample_sources`、timing 依赖、全部热样本和 unplaced 样本均未删除。删除前后热样本与 unplaced 的完整解码列深相等。未归档 oracle 的 coverage 为 `eligible=34/sampled=30`，冷 `small-model` 为 `n=5/p10=1/averageTps=3.6666666666666665`；归档侧 `summarizeHistory()` 仍为 `33/29`、`n=4/p10=2/averageTps=3.857142857142857`，热 `ranked-model` 两边均为 `n=25/averageTps=224`。专用测试在精确 `n/分位/coverage` 对拍处失败：`0/1`，`251.5168ms`，runner `329.2301ms`；Biome、scoped `git diff --check` 与 store SHA-256 复核通过。精确接缝是 `capturePerfCarrier()` 仍只通过 live `perfCandidatesForRange()` 取当前库样本，完全没有读取 `history_archive_perf_authority` 或调用 `readHistoryArchivePerfSamples()`；本卡不选择自动封存、整段删除或其他 source kind 的授权语义。

**B-zcode-cold-perf-carrier-write** 从 `f501e615b93054bed272fc000466778f978444a57ebc0dc85ee9963168faef89` 基线实现显式冷 perf authority。`historyArchiveEventUnionForRange({includePerfCarrier:true})` 在既有 `SAVEPOINT history_archive_union_read` 内解析并校验 perf marker、捕获同一 `segmentId` 的 registry record、event authority 与 hot perf carrier；所有冷 await 都在释放保存点之后。公开 `readHistoryArchivePerfSamples(segmentId)` 的签名和普通 reader 行为未变，完整 carrier 改用私有 captured-record reader，因此 registry 在 await 期间变化不会把读取改选到另一段。内部 reader 先复用 `verifyHistoryArchiveCandidate()` 与 registry record 对拍，再在同一只读候选事务中调用 `assertHistoryArchiveSourceMatches()`、要求 `history_archive_perf_sources_v1`/`samples_v1`/`index_v1`/`timing_v1` 四个 key 全部存在，并读取注册范围 samples。

marker 校验是严格闭集：顶层只能有 `formatVersion/segments`，`formatVersion=1`，且恰好一个 segment；segment 只能有 `segmentId/databaseSha256/sourceKinds/methodVersions`，digest 与 id 相同，来源只能 `["zcode"]`，方法只能 `["tps-v2"]`。该段必须同时出现在既有 event authority 与 registry，registry digest 必须相同；marker 的未知字段、缺/多段、其他 kind/method、event authority 不匹配都在冷读前失败。事件 authority 本身不会授权 perf，没有 perf marker 时仍走 hot-only carrier。

冷读到 decoded rows 后，`mergeHistoryArchivePerfSamples()` 以 `sampleKey` 为唯一键合并 live 与 cold：完整 payload 相同只保留一份，payload 或 identity 不同以 `HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT` 拒绝；新增冷行只能是 `zcode`/`tps-v2`。live placed/unplaced 行不删不改，known source 与 identity 只补充同批已读样本，再由原 `buildPerfSummaryForRange()` 与共享统计核心计算。测试先在 candidate 与 live 中锁定重叠冷样本，只删除一个 live 冷 `small-model` 样本；candidate 保留被删样本，归档摘要仍与未删除样本的 oracle 完全相等：coverage 从红测的 `33/29` 恢复到 `34/30`，冷 `small-model n=5/p10=1/p90=5/averageTps=3.6666666666666665`，热 `ranked-model n=25/averageTps=224`，证明重叠样本已去重而不是重复计数。 专用测试 `1/1`，`260.2924ms`，runner `339.4847ms`；相邻 reader `1/1`，`214.687ms`，runner `297.5804ms`；typecheck 与 lint-only Biome 通过，post-change store SHA-256 为 `f0118bdf3cbb2c2ec25ac2fad58c4a3ef4c5fe9a2bab0c48ae265fea2a64f8f6`。
**B-perf-authority-guards-red** 用三个独立小 ZCode 夹具确认非法 perf 授权不能降级成热区部分成功。测试 1 先写入同段 event/perf marker，再显式删除 event marker、封存冷 events 并清空 rollup day markers，使 hot-only fallback 可观察；`summarizeHistory()` 当前直接返回热区摘要而不是拒绝，`assert.rejects` 以 `Missing expected rejection` 失败。这是本卡预期红，精确说明 `summarizeHistory()` 仍只按 event marker 决定快路，因而会忽略孤立 perf marker。

测试 2 在同段 event marker 存在时分别把 perf marker 的 `sourceKinds` 改为 `["dsh"]`、`methodVersions` 改为 `["tps-v1"]`；两次均以 `HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID` 拒绝。测试 3 先删除候选的 `history_archive_perf_index_v1`，再用 `backup()` + `createHistoryBackup()` 重打包并重新登记，让外层 manifest/digest 与 registry 自洽；`verifyHistoryArchiveCandidate()` 仍按 legacy event 契约通过，带完整 event/perf marker 的 `summarizeHistory()` 则以 `HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH` 拒绝，证明失败不是外层 checksum 偶然损坏。专用结果 `2/3`：pass `161.7004ms` / `209.3665ms`，预期 fail `193.4282ms`，runner `646.4436ms`；Biome、typecheck、文件换行/空白检查通过，store SHA-256 保持 `f0118bdf3cbb2c2ec25ac2fad58c4a3ef4c5fe9a2bab0c48ae265fea2a64f8f6`。主审独立复核为 `2/3`：invalid kind/method `174.4857ms`、missing component `203.9223ms`，missing-event 预期红 `204.2632ms`，runner `661.7683ms`。

**B-perf-authority-fastpath-fix** 在同一 preimage `f0118bdf3cbb2c2ec25ac2fad58c4a3ef4c5fe9a2bab0c48ae265fea2a64f8f6` 上只改 `summarizeHistory()` 的 authority 探测，共 3 insertions / 1 deletion：

```diff
-        this.database.prepare("SELECT 1 FROM store_meta WHERE key = ?").get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META),
+        this.database
+          .prepare("SELECT 1 FROM store_meta WHERE key IN (?, ?)")
+          .get(HISTORY_ARCHIVE_EVENT_AUTHORITY_META, HISTORY_ARCHIVE_PERF_AUTHORITY_META),
```

现在 event/perf 任一 marker 存在都会进入既有完整 authority 校验：孤立 perf marker 不再返回 hot-only，非法 kind/method 与缺 component 仍在原精确错误处失败，正常 carrier 路径保持原结果。专用 guards + carrier `4/4`：`186.6268ms` / `162.1995ms` / `193.0239ms` / `259.4556ms`，runner `953.2505ms`。`npx.cmd biome check --formatter-enabled=false src/usage-store.js` 与 scoped `git diff --check` 通过；post-change SHA-256 为 `eebda75e848e8cfe28b850e45bd1a3fbf085fc0d1f7552dc293a80ebbe9d9f5c`。按 owner 指令未重跑 typecheck 或全仓套件。主审独立复核为 `4/4`：`219.6142ms` / `169.4909ms` / `196.312ms` / `301.7177ms`，runner `662.5349ms`；接受根因修复，store 锁收回冻结。

**B-cold-perf-overlap-conflict** 只新增真实 ZCode 行为测试，生产 store 保持 `eebda75e848e8cfe28b850e45bd1a3fbf085fc0d1f7552dc293a80ebbe9d9f5c`。夹具在已登记并显式授权的同一 cold segment 中，从 candidate 与 live perf 选出 `sample_key` 和完整 decoded payload 均相同的样本；随后只用真实 SQL 把 live 行的非 key 字段 `duration_ms` 加一。`summarizeHistory()` 在冷热合并处以精确 `HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT` 拒绝，没有返回部分 summary。测试再把同一 `sample_key` 的 `duration_ms` 恢复为原值，仍使用同一 store 调用摘要，并与未归档 oracle 比较完整 `summary.perf`；仅把进程相关的 `indexedAt`（含 `meta.indexedAt`）归一为 `null`，其余 coverage、models、groups、metadata 与覆盖行全部深等。cold candidate 的 SHA-256 在冲突与恢复前后不变。专用测试 `1/1`，`275.5205ms`，runner `352.9673ms`；Biome 与 scoped `git diff --check` 通过。按 owner 指令未跑 typecheck 或全仓套件。
```text
# B-codex-required-request-facts：
# candidate 创建/验证依赖宿主硬链接。
node --test --test-concurrency=1 test/history-cold-codex-required-facts.test.js
# 修改前预期红：0/1，Missing expected rejection，213.8329ms（主审独立）
# 修改后：1/1，220.9008ms，runner 304.4454ms

node --test --test-concurrency=1 test/history-cold-codex-required-facts.test.js test/history-cold-codex-perf-authority.test.js test/history-cold-codex-perf-transfer.test.js
exit 0; tests 3, pass 3, fail 0; runner 1169.9931ms

node --test --test-concurrency=1 test/history-cold-codex-late-timing.test.js test/history-cold-codex-revision-rollback.test.js
exit 0; tests 2, pass 2, fail 0; runner 1146.049ms

node --test --test-concurrency=1 test/history-cold-perf-reader.test.js test/history-cold-perf-authority.test.js
exit 0; tests 2, pass 2, fail 0; runner 665.2462ms

node --test --test-concurrency=1 test/history-cold-codex-evicted-late-timing.test.js
exit 0; tests 1, pass 1, fail 0; runner 464.515ms

node --test --test-concurrency=1 test/history-cold-perf-authority-guards.test.js test/history-cold-perf-conflict.test.js test/history-cold-perf-multisegment.test.js
exit 0; tests 6, pass 6, fail 0; runner 1634.3861ms

npx.cmd biome lint src/usage-store.js src/history-archive.js
exit 0; Checked 2 files in 88ms. No fixes applied.

npx.cmd biome check test/history-cold-codex-required-facts.test.js
exit 0; Checked 1 file in 6ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check -- src/usage-store.js src/history-archive.js test/history-cold-codex-required-facts.test.js
exit 0

# 具名前像（未覆盖）：output/codex-usage-store-B-codex-required-request-facts-edf21f09.js
src/usage-store.js SHA-256: B8F8AFED335E6E1EB4B2B91D1DBADB75F9254407A25B1B1DA5C42FBA32D2E031
src/history-archive.js SHA-256: 3CDAC6DA24C9022C7C67A5D6705177C3C36AF7FAC3EC4249B1120D1D2DAFD03A
```

```text
# B-effective-Codex-numeric：
# candidate 创建/验证依赖宿主硬链接。
node --test --test-concurrency=1 test/history-cold-codex-effective-numeric.test.js
# 专用 1/1，351.7962ms，runner 435.8755ms

node --test --test-concurrency=1 test/history-cold-codex-required-facts.test.js test/history-cold-codex-perf-authority.test.js test/history-cold-codex-perf-transfer.test.js
exit 0; tests 3, pass 3, fail 0

node --test --test-concurrency=1 test/history-cold-codex-late-timing.test.js test/history-cold-codex-revision-rollback.test.js
exit 0; tests 2, pass 2, fail 0

node --test --test-concurrency=1 test/history-cold-perf-reader.test.js test/history-cold-perf-authority.test.js
exit 0; tests 2, pass 2, fail 0

node --test --test-concurrency=1 test/history-cold-codex-evicted-late-timing.test.js
exit 0; tests 1, pass 1, fail 0

node --test --test-concurrency=1 test/history-cold-perf-authority-guards.test.js test/history-cold-perf-conflict.test.js test/history-cold-perf-multisegment.test.js
exit 0; tests 6, pass 6, fail 0

npx.cmd biome lint src/usage-store.js src/history-archive.js
exit 0

npx.cmd biome check test/history-cold-codex-effective-numeric.test.js
exit 0

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check -- src/usage-store.js src/history-archive.js test/history-cold-codex-effective-numeric.test.js
exit 0

src/usage-store.js SHA-256: 9757fb59d323608ef2cd01830ed02c314002e3051e94c220f2368b83530892b1
src/history-archive.js SHA-256: ef36eae739485ccd8a9468041ae0c7b99eb74a9786ce3d1b84dd4d02ba9f69dd
test/history-cold-codex-effective-numeric.test.js SHA-256: 590ef8da1db0cbdc74906c8b377d7a5e2eb4f14cdb18821a1031c135adf10c80
test/history-cold-codex-required-facts.test.js SHA-256: 16D09F8724878B8E48EFAB85323DFAA800F844158509788A503482C9F0F920F0
```

```text
# B-effective-Codex-numeric 返修：复用 validateStoredEvidence，四文件同批宿主运行。
node --test --test-concurrency=1 test/history-cold-codex-effective-numeric.test.js test/history-cold-codex-late-timing.test.js test/history-cold-codex-revision-rollback.test.js test/history-cold-codex-perf-transfer.test.js
exit 0; tests 4, pass 4, fail 0; durations 347.5539ms / 430.0738ms / 456.5383ms / 421.7089ms; runner 1971.4205ms

npx.cmd biome lint src/history-archive.js src/perf-request-timing-store.js
exit 0; Checked 2 files in 25ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check -- src/history-archive.js src/perf-request-timing-store.js
exit 0

# 具名前像（逐字节保存，未覆盖）：
output/history-retention-resume-20261025/B-effective-codex-numeric-validator-reuse/src__history-archive.js.before
SHA-256: ef36eae739485ccd8a9468041ae0c7b99eb74a9786ce3d1b84dd4d02ba9f69dd
output/history-retention-resume-20261025/B-effective-codex-numeric-validator-reuse/src__perf-request-timing-store.js.before
SHA-256: 7cac0befcadbe9797c9d2e4b14db5698908d93383d46719399a5173a7472cf18

src/history-archive.js SHA-256: 5d76e8c9584fe7bdff581438ae442a06fa866349d5e8e62691348dfe1cc79cb7
src/perf-request-timing-store.js SHA-256: 7c3a156c6d7b51ee217095cb3ca7197d7d4139874040bebde81400cb24f554a
src/usage-store.js SHA-256: 9757fb59d323608ef2cd01830ed02c314002e3051e94c220f2368b83530892b1
test/history-cold-codex-effective-numeric.test.js SHA-256: 590ef8da1db0cbdc74906c8b377d7a5e2eb4f14cdb18821a1031c135adf10c80
```

# B15-commit-prepare：
# candidate 创建依赖宿主硬链接。
node --test --test-concurrency=1 test/history-archive-commit-prepare.test.js
exit 0; tests 1, pass 1, fail 0; duration 108.2968ms; runner 189.5695ms

npx.cmd biome check test/history-archive-commit-prepare.test.js
exit 0; Checked 1 file in 6ms. No fixes applied.

npx.cmd biome lint src/history-archive.js
exit 0; Checked 1 file in 25ms. No fixes applied.

npm.cmd run typecheck
exit 0; tsc -p tsconfig.checkjs.json

git diff --check -- src/history-archive.js test/history-archive-commit-prepare.test.js docs/validation/2026-10-22-history-retention/B-report.md
exit 0

# 具名前像（逐字节保存，未覆盖）：
output/history-retention-resume-20261025/B15-commit-prepare/src__history-archive.js.before
SHA-256: 5d76e8c9584fe7bdff581438ae442a06fa866349d5e8e62691348dfe1cc79cb7

src/history-archive.js SHA-256: 5d38b843bfc26d646ecea98a29101cda8a350c0fe6b162125ab26a4871e8609c
test/history-archive-commit-prepare.test.js SHA-256: d30f35487ee93cb3eba5d5f53de6be45f311aa2867319499859ab1fe291673d4
```

**B-codex-cold-perf-transfer** 在不改生产源码的前提下补齐 Codex 冷 perf 从 candidate 到离线 import 的完整证据。真实 fixture 的单个 cold `turn-01` 样本由原生 request-timing 生成，测试先把该样本的 `perf_sample_sources`、`perf_rollout_threads` owner、`perf_request_timing_threads` 与 evidence，以及 `perf_sources_v1`/`samples_v1`/`index_v1`/`timing_v1` 四个 component payload 锁定为 source oracle；candidate 通过既有 verify 后，测试删除临时 live 库中一个冷 perf 样本与全部冷 events，再发布 bundle 并从该 bundle 生成 import。随后原始 source tree、candidate database 和 manifest 被移走，导入 runtime 的 hot/unplaced perf 行仍逐列等于 pre-delete 快照，完整 `summary.perf` 与 candidate 前未归档 oracle 深等，只归一进程相关的 `indexedAt` 与 `meta.indexedAt`。专用宿主测试 `1/1`，`398.2668ms`，runner `476.3018ms`；Biome 通过，生产 store SHA-256 保持 `925c8a3153faeeb66925a1d441f2912b5eff4ff1200772653500bd47a8c5f078`。这证明既有 bundle/import 的主库与段文件复制已覆盖该单一 native 依赖图，不定义生产 import、自动热删除、revision、并发或损坏恢复。
**B-codex-required-request-facts** 在 `edf21f09…` 前像上只扩既有 `requirePerfComponents` 声明，不改 schema、authority 形状、统计、数值 overlay 或冷读算法。`history-archive.js` 仅把既有 `history_archive_codex_requests_v1` 常量改为导出；`usage-store.js` 在私有 perf reader 增加可选 `sourceKind`，现有两个 authority 消费点都把该段已校验的 `sourceKinds[0]` 传入。四个既有 perf component 仍全部必需；仅当该段声明 `codex` 时，再要求 candidate 中恰好存在该原生 request-facts key，缺失以 `HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH` 拒绝。`zcode` 的 key 集不变，legacy 无 perf authority 的 events-only 读取也不进入该 gate。

**B-codex-late-timing-revision-write（根因返修）** 在既有 Codex publication 接点补齐三项事务边界。`#readHistoryArchivePerfRecord()` 现在可在同一只读 candidate 事务中按 sample 读取 `source_files` 的 `path/kind/home_id/home_label/home_path`，writer 只使用这份 immutable candidate 身份；进入写事务后若 live 五列与之不完全相同，现有 revision 校验整体失败，绝不回填 live 身份。候选读取前记录的 `PRAGMA data_version` 与 `total_changes()` 在 `BEGIN IMMEDIATE` 后、首次写入前再次比较；变化时以 `HISTORY_ARCHIVE_PERF_REVISION_INPUT_CHANGED` 回滚并显式返回调用方，避免把旧 candidate delta 绑定到新 registry metadata。若多个重算 sample 共享同一 native evidence 主键，delta map 只保留该 payload 一份，不再按 sample 次数制造虚假 count。

测试在 late timing import 后、唯一一次 archived `sync()` 期间用第二个真实 `DatabaseSync` 连接持续提交无关 `store_meta` 键，直到精确捕获上述 retry error；停止并关闭外连接后，同一 `UsageStore` 的普通重试成功完成 late timing revision。随后原有断言不变：archived live sample 与未归档 oracle 新行逐列深等、完整 `summary.perf` 深等、旧 candidate payload 进入恢复事实、candidate SHA-256 不变，第二次 no-op 后 revision metadata、恢复事实和 candidate 仍逐字稳定。没有新增 schema、表、公开 API、后台 writer 或通用并发框架。

**B15-ZCode-supported-perf-commit** 在既有事件提交事务上补了受支持 ZCode perf 的最小迁移面。`historyArchivePerfDeletion()` 只在候选范围内全部 `perf_samples` 都为 `zcode` / `tps-v2`、四个既有 perf component metadata key 都可由 candidate verify、且没有 `perf_sample_sources` 依赖会被级联删除时，生成精确 sample-key 计划；其余混合 kind、有依赖或缺少验证元数据的范围保持拒绝。commit plan 校验包含 `perfDeletion`，fresh prepare 比较 source 与 candidate 计划，store 同时合并该段 ZCode perf authority、删除精确 key 并要求范围内 hot perf 归零。replay 在 candidate/manifest、digest、范围、event/source evidence、登记行与 ZCode authority 全部匹配且 hot perf 已为空时，才允许 no-op 回滚并返回 `replay:true`；不推进 revision，也不把 timing、source identities 或 native dependencies 从热侧移走。

复审发现的正式 CLI replay 缺口已由新的真实子进程测试覆盖：第一次 `history archive ... --commit ... --backup ...` 同步删除冷 events/perf，公开 events/totals/cost/perf 与未归档 oracle 深等，两个 bundle 均可独立 verify；第二次 CLI 以新的 backup 目录执行时输出 `Deleted events: 0` 与 `Replay: yes`，完整逻辑 DB 快照逐行不变。该测试证明 CLI 已能到达 store 的 perf replay 分支，不把每轮新 backup 目录误写成数据库写回。

冻结 artifact 位于 `output/history-retention-resume-20261025/B15-ZCode-supported-perf-commit/`。真实前像 `c9ace2f4d3909a48d3e6822c71d014fd0d7d1a5560ffa7c2169e16566a6a49a3` 与 `29b1b379756a457b40b41120e03307485af15f85a6e94943f84c83a1b87c81d8` 分别 apply 出当前 `5934183226df160f50cba131d0a9933ae15bb34d99c22e1ce43c2d3392beb2aa` 与 `29987d5703fa55aa0d1b9d983d179e77bdf4134395a5a20a5f2335f13dc9a405`，逐字节一致。两份 LF-only patch 的 SHA-256 为 `53147229e4c47224167fb1116bee9edbf8eb4d1930c8de6b5dd3c2d16bf404f6` 与 `62648c9521c6bbdf0778a4852b92e31bdaa76817b3aaa872190be40b7758bee2`；paired test 为 `1bed3dc99dcc451d50628e468ace1e4152a4f1736c2353e7309c23867ad4a0cb` 与 `9e6f421f36da5970720067df344b5ea4fc1712e4864d5af1791c040b8e82fc4c`。

```text
# B15-ZCode-supported-perf-commit
node --test --test-concurrency=1 test/history-archive-commit-perf.test.js
exit 0; tests 1, pass 1, fail 0; duration 294.1399ms; runner 376.0072ms

node --test --test-concurrency=1 test/history-archive-commit-prepare.test.js test/history-archive-commit.test.js test/history-archive-commit-executor.test.js test/history-archive-commit-cli.test.js test/history-archive-commit-perf.test.js
exit 0; tests 8, pass 8, fail 0; runner 17182.617ms

node --test --test-concurrency=1 test/history-archive-commit-perf-cli.test.js
exit 0; tests 1, pass 1, fail 0; duration 10782.9345ms; runner 10864.1901ms

npx.cmd biome check test/history-archive-commit-perf-cli.test.js
exit 0; Checked 1 file. No fixes applied.

npx.cmd biome lint src/history-archive.js src/usage-store.js test/history-archive-commit-perf.test.js test/history-archive-commit-perf-cli.test.js
exit 0; Checked 4 files. No fixes applied.

npm.cmd run typecheck
exit 0

git diff --check -- src/history-archive.js src/usage-store.js test/history-archive-commit-perf.test.js test/history-archive-commit-perf-cli.test.js
exit 0

git apply --check --whitespace=error --directory=output/history-retention-resume-20261025/B15-ZCode-supported-perf-commit/apply-check-history-archive output/history-retention-resume-20261025/B15-ZCode-supported-perf-commit/B15-ZCode-supported-perf-commit-history-archive.patch
git apply --whitespace=error --directory=output/history-retention-resume-20261025/B15-ZCode-supported-perf-commit/apply-check-history-archive output/history-retention-resume-20261025/B15-ZCode-supported-perf-commit/B15-ZCode-supported-perf-commit-history-archive.patch
exit 0; resulting SHA-256 5934183226df160f50cba131d0a9933ae15bb34d99c22e1ce43c2d3392beb2aa

git apply --check --whitespace=error --directory=output/history-retention-resume-20261025/B15-ZCode-supported-perf-commit/apply-check-usage-store output/history-retention-resume-20261025/B15-ZCode-supported-perf-commit/B15-ZCode-supported-perf-commit-usage-store.patch
git apply --whitespace=error --directory=output/history-retention-resume-20261025/B15-ZCode-supported-perf-commit/apply-check-usage-store output/history-retention-resume-20261025/B15-ZCode-supported-perf-commit/B15-ZCode-supported-perf-commit-usage-store.patch
exit 0; resulting SHA-256 29987d5703fa55aa0d1b9d983d179e77bdf4134395a5a20a5f2335f13dc9a405
```

**B15-Codex-supported-perf-commit** 把已有 `perfDeletion` 接点扩展到纯 Codex `tps-v2` 冷范围，没有复制 Codex request/timing 校验。`historyArchivePerfDeletion()` 仅接受区间内全部为 `codex`、`tps-v2`、`completed`、`request_e2e`、`explicit` 且存在 `perf_sample_sources` 的行；candidate 还必须有 `history_archive_codex_requests_v1`，并复用 `validateCodexRequestEvidence()` 校验原生 turn、依赖、rollout owner 与 request-timing evidence。candidate 明确给出可删计划时，fresh prepare 才对 source/candidate 的 `codexRequestEvidence()` 做完整 JSON 比较，保证即将级联删除依赖前的图与候选 package 一致；plan 校验、authority 写入和 replay 都从已验证的 `perfDeletion.sourceKind` 取值，不再硬编码 ZCode。

真实 Codex 夹具先给出 RED：`0/1`，`253.5338ms`，失败点是缺少 `plan.perfDeletion`。修复后的同一测试加入三条核心边界。第一，复制 candidate 并删除 `history_archive_codex_requests_v1` 后重新打包：新 package 仍是合法 legacy candidate 且 `verifyHistoryArchiveCandidate()` 通过；`prepareHistoryArchiveCommit()` 返回不含 `perfDeletion` 的同一 events plan，在独立 oracle store 上成功提交 events，`deletedPerfSampleCount=0`、冷 perf 行不变且不写 perf authority。同一 legacy plan 再次提交时进入 replay，仍返回 `deletedPerfSampleCount=0`，冷 perf 与 authority 保持提交后状态。该兼容分支不能只凭四个 perf key 从缺失原生 manifest 的库重算证据后补授权。第二，在真实 `perf_sample_sources` 级联上安装 `AFTER DELETE` trigger 并抛出具名 `INJECTED_CODEX_PERF_DEPENDENCY_FAILURE`；失败后范围内 events、冷 links、冷 perf、`archive_segments` 与两个 authority key 全部逐行回到提交前，candidate SHA-256 不变；删除 trigger 后同一 plan 成功提交。第三，成功路径继续断言冷依赖只随本样本级联、out-of-range 与 unplaced 样本不变、native graph 不变、candidate digest 不变、公开 events/totals/cost/perf 与未归档 oracle 深等，并证明 replay 不重复删除或改写。最终专用测试 `1/1`，`391.0218ms`，runner `469.7011ms`；前次 Codex/ZCode 相邻组合 `2/2`，ZCode `313.1382ms`，runner `902.4032ms`。

```text
# B15-Codex-supported-perf-commit
node --test --test-concurrency=1 test/history-archive-commit-codex.test.js
exit 0; tests 1, pass 1, fail 0; duration 391.0218ms; runner 469.7011ms

node --test --test-concurrency=1 test/history-archive-commit-codex.test.js test/history-archive-commit-perf.test.js
exit 0; tests 2, pass 2, fail 0; Codex 400.2494ms; ZCode 313.1382ms; runner 902.4032ms
```

`src/history-archive.js` SHA-256 为 `f227a174bccd7f0a7f18f12747496f2fb2717dbf36f21719cd614e8ee03da6dc`，`src/usage-store.js` 为 `f7d746df7b0b7900a1a5e1b0e18d7bd5b9358ffc74bf48029259d97eb775356a`，paired test 为 `c41d15ebb5929e87c861ef899fee628ca621eec1218dac155f6f5cb4524e5637`。
**B root narrow promotion / metadata rollup counts** 已由主审接受并完成根仓窄提升。主审复核覆盖受影响测试与相邻回归，结果为 `15/15`，runner `5523.4718ms`；根仓 post-image 已独立核验为：

```text
a3dba0b3fb030ac5f26cdd325dc46badec2d39c1e95a088472a915d79ced6471  src/usage-store.js
db2f3de81dc8c3735e5c33861a0c4f3b85ee8f2c3b78ee7d4ba64e315f4f944a  src/usage-rollups.js
2cdbceccfb3b1d158dc1a3ab1b7f65e8cab77ca8209d3b0235c06de0d77725af  test/usage-store.test.js
dd3fd9f69c098847ceca25ffba07e45b0061bbdd953a5b8e08deea23afa23780  test/metadata-rollup-counts.test.js
```

该能力只改变无 archive authority 且所有必需 UTC 日 marker 均为当前格式时的 `metadata()` 计数来源：`queryUsageRollupsRange(..., { includeHomeCounts: true })` 从 `usage_rollup_daily` 取精确每日事件数，从 `usage_rollup_sessions` 取精确 distinct session 数；总数与 per-home 分组均沿用既有 rollup 表。任一 archive authority marker 存在、边界不可证明、marker 缺失或格式陈旧时，仍执行原来的两条 raw `events` count 扫描，不把 hot-only rollup 冒充完整历史。`metadataHistory()`、冷段读取、archive authority 写入与 `summary()` 其它路径未改变。

窄提升的前像来源是**可验证重建**，不是当时同时保存的根仓快照；B 报告中的“同期根仓快照”指未保存的原始文件，不是这些从已接受 A 产物复制的字节：A 的 accepted candidate `output/history-retention-profile-20261026-A19-period-interval-pruning/candidate/src/usage-store.js`（`7f095705e6c83a2b58084e2a46f726f5cb2a0e4097bbf652b791b76791647859`）作为 B 前 `usage-store.js`，`src/usage-rollups.js` 前像为 `66b7fe319703c10f64807f76aac7ddd642a6066a61d660923d14cb28d546cdf4`，`test/usage-store.test.js` 前像为 `e89e8df2e2c0c035daefb65f131c40482efaf8c68d06d135ce927f3780b18908`；`test/metadata-rollup-counts.test.js` 在 B 前不存在。已把三份前像、隔离后的四个 post-image 副本与窄 patch 保存到 `output/history-retention-profile-20261026-metadata-rollup-counts/root-promotion-evidence/`，并在 README 中明确“重建/核验”而非“同期保存”。

窄 patch 为 `output/history-retention-profile-20261026-metadata-rollup-counts/root-promotion-evidence/narrow-patch/B-root-narrow-promotion.patch`，SHA-256 `098d15fb2667fc66ddb055166b1d2e15aa92dd68970e33dc8df87833f3e0ac34`。使用 `git apply --check --unsafe-paths --whitespace=error --directory=<evidence>/clean-preimage` 通过，并在同一隔离副本应用后逐字节复现上述四个 post-image hash；没有把 patch 应用到根仓。旧 `PROPOSED.patch` 的 reverse-check 也通过，证明当前根仓确实包含该窄 B 改动；当前 `usage-store.js` 与 accepted candidate 的差异仅是 A 保留的 `period_interval_pruning` 块。

```text
# B root narrow promotion / metadata rollup counts
# 主审独立复核（根仓已提升后）：
node --test --test-concurrency=1 <affected tests + adjacent regression>
exit 0; tests 15, pass 15, fail 0; runner 5523.4718ms

# 窄 patch 对重建 A 前像的隔离检查：
git apply --check --unsafe-paths --whitespace=error --directory=<evidence>/clean-preimage <evidence>/narrow-patch/B-root-narrow-promotion.patch
exit 0

# 隔离应用后的四个 post-image hash：
a3dba0b3fb030ac5f26cdd325dc46badec2d39c1e95a088472a915d79ced6471  src/usage-store.js
db2f3de81dc8c3735e5c33861a0c4f3b85ee8f2c3b78ee7d4ba64e315f4f944a  src/usage-rollups.js
2cdbceccfb3b1d158dc1a3ab1b7f65e8cab77ca8209d3b0235c06de0d77725af  test/usage-store.test.js
dd3fd9f69c098847ceca25ffba07e45b0061bbdd953a5b8e08deea23afa23780  test/metadata-rollup-counts.test.js
```

**B19-cost-model-count** 只在 `createCostSummaryState().add()` 内缓存 `canonicalModelName()`：cache 以当前 `currentPricing().models` 对象身份为世代，以 `estimate.model || "Unknown model"` 为局部 key；价目对象变化时清空。每次 `add()` 仍读取当时生效的 catalog，因此同一 accumulator 在 catalog 间切换时仍按各次调用归属。候选不改变费用加和、estimate 原始 model、unknown 过滤、`minimumRateModels`、`unplaced` 或 `models` Set 语义。

定向测试 2/2 通过（81.096ms）：一组重复 alias/未知模型与 baseline 完整结果深等；另一组先按 catalog A 估算一次，再固定同一 `providedEstimate`（其 `model` 为 `GROUP/fixture-alias`）在相同 version、不同 `models` 对象的 A/B 之间调用 `add()`。baseline 与 candidate 完整费用结果相等且 `modelCount=2`；version-only 或 raw-only 缓存都会得到 1。主审另用独立 `review-fixed-estimate.mjs` 以 `A,A,B,A` 序列复现同一结论（完整费用相等、`modelCount=2`）。

早期两次失败均为 oracle 准备误差，不是产品 RED：一次让 `estimateEventCost()` 在 catalog 切换时改了 `estimate.model`，另一次 alias 删除后仍返回原 raw canonical，无法单独击穿错误缓存。收口测试固定 `providedEstimate`，并保留 baseline 作为独立 oracle；没有改根仓 `src/pricing.js`，也没有把候选推广到产品。

主审随后在独占窗口完成一次真实 HTTP 100k 配对：baseline `1314.6544ms`，candidate `1315.4628ms`，变化 `+0.0615%`，无性能收益；99 输入仅 pricing 差异，完整 cost/payload 相等。结论是候选功能对拍成立但性能无收益，拒绝推广本地 `modelCount` 缓存；根仓 `src/pricing.js` 保持 `671f1bc8b3a5c6e3eee8061c876f19815dd84d89622f2fe2fdf51f14e3cc0391` 不变。不再补测试、重复 pair 或运行 million；叶子缓存试验到此停止。

```text
# B19-cost-model-count（artifact-only）
node --test --test-concurrency=1 output/history-retention-profile-20261026-cost-model-count/test/cost-model-count.test.js
exit 0; tests 2, pass 2, fail 0; duration 81.096ms

node output/history-retention-profile-20261026-cost-model-count/review-fixed-estimate.mjs
exit 0; {"pass":true,"modelCount":2,"sameEstimate":true,"sameVersion":true,"sequence":"A,A,B,A","completeCostEqual":true}

node --test --test-concurrency=1 --test-name-pattern="cost accumulator counts canonical model identities|unknown prices and incomplete details|request pricing context survives await" test/pricing.test.js
exit 0; tests 3, pass 3, fail 0; duration 84.1772ms

git apply --check --unsafe-paths --whitespace=error --directory=output/history-retention-profile-20261026-cost-model-count/apply-check-postimage output/history-retention-profile-20261026-cost-model-count/candidate.patch
exit 0; applied SHA-256 32809d5c93ef643e5dabb756e6fd931f9209250bbd8a1a429ce6016067b25e13 = candidate

git diff --check -- src/pricing.js output/history-retention-profile-20261026-cost-model-count/candidate.patch output/history-retention-profile-20261026-cost-model-count/test/cost-model-count.test.js
exit 0

# 主审独立 HTTP 100k 配对（单次，独占窗口）
baseline 1314.6544ms
candidate 1315.4628ms
delta +0.0615%; no performance benefit
99 inputs: only pricing differs; complete cost/payload equal

Get-FileHash -Algorithm SHA256 src/pricing.js
671F1BC8B3A5C6E3EEE8061C876F19815DD84D89622F2FE2FDF51F14E3CC0391
```

```text
# dashboard-shared-carrier（根仓已接入；当前单段 SQL 快路已通过）
当前根：
4DE01334D191499BC03EB572C9B7BE69F220D064476781C8F9CCE780282BC84A  src/usage-store.js
F70C9CF8DB992723DA486D5106E308D30EAC544D5471E3938F1CEA0F7B81B783  src/usage-executor.js
AE609E1217383D4FF71F8084C1F74DFC76B97B4F72CDC39EC8D61B084DCBC93C  test/history-dashboard-shared-carrier.test.js

artifact measured-src（100k 配对所用，早于 omitted-now 修复）：
9A3DC0931EBE0D76E1B78982500EC34F4A7F8964F5263AF33C9D15F4EFDC81C5  measured-src/usage-store.js
F70C9CF8DB992723DA486D5106E308D30EAC544D5471E3938F1CEA0F7B81B783  measured-src/usage-executor.js
3EDBC688C7D99F8B9CB3A3366B9112CAD16944C51316D2B2404ED86995C6CCA8  verify-functional.mjs

node --test --test-concurrency=1 test/history-dashboard-shared-carrier.test.js
exit 0; tests 1, pass 1, fail 0; duration 387.1639ms; runner 5568.2713ms

review-functional.json:
pass=true; hotUnionReads=0; separateColdReads=3; combinedColdReads=1;
completeBaselineFieldsEqual=true; missingRejectsAndRestores=true;
HTTP 200 total=130 eventCount=2; missingStatus=500
```

`dashboard-shared-carrier` 的 authority 收窄保持正确：只存在 perf authority 时仍走原 summary/metadata/period 三入口，不能为了“统一”而扩大冷读取范围。event-authority 分支的 `excludeHomes` 同时作用于 summary、period 与 perf 过滤；metadata 按既有契约不应用排除；metadata carrier 使用 `completeHistory:true`；perf 由 carrier 路径捕获一次并从最终范围/exclusions 构建。根仓已在 `dashboardHistory()` 的 metadata 调用点传入 `filters.now ?? new Date()`，因此省略 `now` 的真实 dashboard 回归测试通过。当前专用测试显示：基线独立调用 3 次冷 union，随后单段不变范围走 `trySqlHistoryDashboard`，`historyArchiveEventUnionForRange` 的 `calls=0`；因此不能再用旧 artifact 的 `combinedColdReads=1` 描述当前快路。完整字段对拍、缺段拒绝/恢复和 HTTP 130/2 仍通过；缺段请求返回 500。

100k 单次配对为 baseline `20218.3226ms` / candidate `16136.334ms`，RSS `1054306304` / `1047072768` bytes，两侧 catalog 分别为 `2026-10-26-787c2822fed3` 与 `2026-10-26-8802db5dfcf8`，因此这不是同 catalog 的受控因果加速或 SLA 结果。配对使用 `measured-src` 的 `9A3DC093…` 后像，早于当前根仓的 omitted-now 修复；该修复不改变显式 Date 的 HTTP 路径，但当前根仓 hash 应以 `4DE01334…` 为准。

**history-backup fingerprint candidate** 只把 `tableFingerprint()` 的 `.all()` 改为 `.iterate()`，在循环中累计 count；SQL、固定 16 张必需表、行序、列、JSON 序列化、换行、count 和错误路径均未改变。sealed candidate 的前像/候选/验证脚本/patch 的 SHA-256 分别为 `053FFE2650555819927D7D5E951158FCE691807104926FFAFA653CA70C217D24`、`EE40EAFA147FE2068EDD715528C79BC6057E51AE8C591090047BF3B184CA1F99`、`9C9EDDEDFDD4D3C89D88D275CFAB5E35521AD54DF4D831961C2D3C71E0DB3813` 与 `04DFBBC11A2E3DF49EDEFB18DFA168C34DE7B3C5E05B83AFCFAF06B67CA6D2A3`。候选推广时的根回归为 `13/13`（runner `5467.9969ms`），typecheck/Biome 通过；宿主验证输出 `{"tables":16,"fingerprintsEqual":true,"tamperRejected":true}`，篡改被 `HISTORY_BACKUP_TABLE_MISMATCH` 拒绝。当前根仓 `src/history-backup.js` 已变为 `4D56EDBB28D079D062FF3AFD234E8E6538AA7EEC0ADB665929C11F9B923BEE7B`，包含后续 stream-hash/verified-evidence 改动；`output/history-retention-profile-20261026-verified-bytes/review.json` 的 `14/14` backup/dashboard 与 `7/7` in-place 证据使用不同的期望 hash，只能作为历史 artifact，不能宣称当前根仓已重测。`candidate.patch` 本身为 CRLF，直接 `git apply --check` 不可用；LF 规范化副本 SHA-256 为 `EF27137CDB7EAF51A7FB925263315CF0B4F913A78B88EA1F98089B67116726D3`，对 clean preimage 检查并应用后逐字节得到候选。该候选没有性能测量。

**B19 cold dashboard summary phase** 是 artifact-only 归因草稿，未推广、未改根仓。`output/history-retention-profile-20261026-b19-cold-summary-phase/` 中 `README.md`、`phase-hook.patch`、`sessions-key-candidate.patch` 的 SHA-256 分别为 `0A014BFBF3CCA3164B93DDA67CE4C31B35E5F2FB1AA9F3B29E3A9B23EBBBF7AB`、`BB3C594F687AD51F06C70D6F93CD9C54DBE689D387CAB76DC871FD4D47D95709`、`37FE47716F4B0A0D1003AC648F51744FFA55F49D9C0B3692FB6DB652E7CD3015`；两个 patch 均通过当前根 `git apply --check --whitespace=error`，隔离副本 `node --check` 通过。`phase-hook.patch` 只按 `CODEX_COLD_SUMMARY_TRACE_FILE` 在现有冷 dashboard 接缝记录 `carrier`、`events`、`sessions`、`summary`、`metadata`、`period` 六个阶段，不改变返回数据、不新增公开选项、不测量 hot SQL。

现有 10k 诊断包含 10,000 events（5,067 cold / 4,933 hot）、256 sessions、6 homes、1 个授权段；warm cold 请求为 `338.77ms` / `294.47ms` / `306.21ms`，首个请求 `1011.8244ms`。已记录的 verification trace 平均为 `backup-read-hash` 约 `7.285ms`、`backup-database-evidence` 约 `44.467ms`、`candidate-event-source-semantics` 约 `28.015ms`，约 `80ms` 被验证覆盖，仍有约 `220–260ms` 未归因。当前冷路径约执行八次完整 events 扫描：projection、sessions、summary filtering、comparison、timeline/cost、grouped dimensions/repositories、metadata 与 period comparison。`sessions-key-candidate.patch` 仅把每事件 `JSON.stringify([homeId, sessionId])` 换成嵌套 `Map`，保留 missing-home 校验、last-event channel/cwd/model 语义、用量累计与最终排序，但尚未测试或测量，不得先于 warm phase 归因推广。

**#19 memory root cause / no-authority rollup SQL path（只读审查，未实现）** 这里讨论的只是 `rebuildUsageRollups(events)` 的无 event-authority 全量 SQL 重建快路：目标日全集沿用既有 `completeHistoryRollupDays()`，UTC/local 两批重建与 zone identity 写入由现有外层事务保留。快路是否启用由 `historyArchiveAuthorizedSegmentIds()` 的 events 权威决定；仅有 perf authority 不会把 events 移出热库，因此直接对热 `events` 做 SQL 重建正确，不需要冷 events union，也不会更改 perf authority。summary/perf 的冷读取是独立路径，不应与 events rollup 快路混为一谈。只读审查未见其他具体漏项；本次未改 source/test，未运行 Node、Biome、测试或访问生产 DB/服务，执行窗口仍由 Main 持有。

## 未测边界与风险

- dashboard-shared-carrier 已在根仓通过一个 event-authority 单段夹具的专用测试与 HTTP 对拍，覆盖省略 `now`、完整字段、`excludeHomes`、缺段拒绝/恢复及 perf carrier；未覆盖 perf-only authority 的独立回归、多段、多 home `excludeHomes`、authority 翻转、并发 writer、损坏段、真实生产 Dashboard 或生产服务重启。当前根仓的单段不变范围走 `trySqlHistoryDashboard`，专用测试记录 `historyArchiveEventUnionForRange` 的 `calls=0`；`review-functional.json` 的 `combinedColdReads=1` 属于早于 SQL 快路的旧 artifact，不能作为当前路径的共享 carrier 证据。SQL 快路只覆盖单段、`preset=all`、无 revision/perf overlay 的受限范围，fallback 仍完整物化 events/perf carrier；`publishedUsageEventsFromUnion()` 已在原数组原地投影，不再保留第二份完整事件数组。100k 配对两侧 catalog 不同，且 measured source 早于 omitted-now 修复，因此不能把 `20218.3226ms → 16136.334ms` 当作同 catalog 因果加速或 SLA。perf-only 分支必须继续保留原三方法调用，不能因 carrier 入口扩大成 metadata/period 冷读。

- history-backup fingerprint sealed candidate 只改变 `tableFingerprint()` 的 `.all()` → `.iterate()`，没有新增流式 API、缓存、分页或性能保证；Main 已推广该候选，但未做前后性能测量。验证脚本只覆盖固定 16 张必需表的小夹具、一次整表 fingerprint 等价和一次事件篡改拒绝，不覆盖超大表、WAL 并发写、损坏数据库、跨 schema、异常迭代器或其它 backup 路径。`candidate.patch` 为 CRLF，不能直接作为 clean apply-check 材料；LF 规范化副本应用后逐字节等于候选。当前根仓 `src/history-backup.js` 为 `4D56EDBB…`，在 sealed candidate 之上另有 stream-hash/verified-evidence 改动；历史 `verified-bytes/review.json` 的 14/14 与 7/7 使用不同期望 hash，不能替代当前根仓重测。`publishedUsageEventsFromUnion()` 的原地投影已在当前根仓存在，因此不能把旧的“第二份完整事件数组”风险算作本次 fingerprint 变更或当前 dashboard 的未实现项。

- B19 cold dashboard summary phase 只交付未推广的诊断 hook 与未测 sessions-key 候选，没有性能结论、根仓改动或功能测试。10k 数据与约 `220–260ms` 未归因区间来自既有诊断，不是同一 catalog/机器状态的受控 benchmark；verification trace 只解释约 `80ms`，不能把剩余时间归给任一阶段。当前冷 dashboard 仍完整物化 events、sessions 与 perf carrier，约八次完整扫描中的任何一次都可能是主耗时；必须先用一个 warm `skipCheck=1` 请求采集六阶段 trace，确认 `sessions` 是否重要后才可评估 `sessions-key-candidate.patch`。该候选尚未在真实 dashboard 上测试、未跑 typecheck/Biome、未测内存，也未实现持久化 summary publication、分页/流式读取或对 carrier 投影的进一步改写。

- B19-cost-model-count 的功能对拍通过，但主审独占 100k 配对无性能收益，已拒绝推广；根仓 `src/pricing.js` 保持 `671f1bc8b3a5c6e3eee8061c876f19815dd84d89622f2fe2fdf51f14e3cc0391` 不变，不再补 1000 smoke、100k、million 或全仓证明。该单次配对只用于裁定，不是通用性能保证。缓存大小上限是当前 catalog 下不同 raw model 的数量；同一 `models` 对象被原地增删 key 不在既有目录身份契约内，不能据此复用缓存。候选只覆盖 accumulator 的 canonical model 计数，不改变费用、未知模型诊断或 catalog 切换归属，也没有新增全局 memo 或跨请求失效机制。

- B root narrow promotion / metadata rollup counts 只证明已提升根仓在定向 `15/15` 回归和一次固定 100k pair 上保持既有公开 metadata 语义；没有 million-event、cold-layout、长时间并发或生产 DB/重启验证。优化仅覆盖无 archive authority 的 `metadata()`，且要求所有覆盖事件范围的 UTC rollup day marker 为当前格式并完整；authority、marker 缺失/陈旧或边界不可证明时仍走 raw scans。它不优化 `metadataHistory()`、summary、period 或 detail/full 路径，也不把 rollup 当作冷段事实来源。100k 数据只用于审查该实现，不等价于通用性能保证；现有根仓仍包含大量未提交 owner 改动，patch 的前像是可验证重建而非同期根仓快照。

- B-cold-revision-overlay-read 只实现手工提交 overlay 后的 union 读取；没有 source reparse writer、完整 delta 生成、重复修订累积、旧版本转存 `history_replaced_facts`、恢复 API、backup/import 转移或 authority 写入。overlay 只对 authorized 段应用，未授权段的已登记 overlay 不参与读取；未知 segment、错误 digest、结构错误、payload 列类型和 payload→sourceIdentity home binding 会在快照内失败，但冷 payload 足份、payload source path 与 candidate source identity 匹配仍要在该授权段真实读取时验证。每个 segment/source 只允许一个当前累计 delta，不提供历史 revision、合并协商或自动压缩；`added` 行使用 `id:null` 供现有只读投影，不建立新的持久事件身份。测试只覆盖一个段/source、手工事务写入、单个 removed 错误、一个坏数值与一个跨 home payload，不覆盖多段、多 source、并发 writer、候选包损坏窗口、超大 payload 或备份迁移。
- B-cold-prefix-revision-write 只覆盖同一来源、同一授权段、同一 `timestamp_ms + session_id` 集合上的一对一值修订；冷事件新增/删除、跨 timestamp/session 迁移、重复身份、多个同 timestamp 事件、多段重叠、来源身份变化和并发 writer 仍拒绝或未测。每个 segment/source 继续只保留一个当前累计 delta，不提供 revision 历史、压缩、恢复 API、authority 切换或 backup/import 转移。第二次修订的 `history_replaced_facts` 只保存上一 effective payload；immutable candidate 的原始 payload 仍依赖候选包本身，不另复制进恢复表。rollup 断言使用两个事件落在同一 UTC/local 日的固定夹具；跨本地日、DST、local zone 在修订间变化和全表并发压力未覆盖。测试只重跑专用文件，未运行完整仓库套件。
- B-cold-prefix-revision-rollback 只在 hot 重解析、cold supersession 证据暂存之后、revision metadata UPDATE 处注入一次确定性失败；不覆盖 reader/解析中途失败、cold payload 校验失败、candidate 读取失败、revision COMMIT 后、rollup 重建中或进程崩溃。失败后的重试证明依赖普通 `source_files` size/mtime 差异，未证明同尺寸同 mtime 的并发改写；快照比较只覆盖单个 segment/source/home、单个 UTC/local 日与三张 aggregate 表，不覆盖多段、跨日、DST、并发 writer、WAL 崩溃恢复或完整 `sync()` 原子性。测试仅运行专用文件。
- B-cold-prefix-late-add 只覆盖同一来源、同一授权段、一个纯新增 identity 及其单次 revision；不覆盖连续多次追加、冷删除/跨 timestamp/session 迁移、混合值修订与追加、多段、跨日/DST、并发 writer、backup/import 或恢复 API。新测试只验证正向追加；missing effective identity 与重复 identity 仍由既有检查明确拒绝，但没有在本卡新增独立负向 fixture。rollup 断言只覆盖同一 UTC/local 日，测试仅运行两个专用文件。
- B-cold-revision-bundle-transfer 只覆盖一个 Codex source、一个授权段、一个 home 和已有的值修订 overlay；不覆盖冷新增/删除、多段/多 home、跨日/DST、authority 切换、并发 writer、重复 import、bundle/import 损坏或恢复 API。`history_replaced_facts` 与 revision metadata 是随主库备份原样转移的，不是 bundle 单独建模的 revision 日志；不可变冷段仍只保存原 candidate `100`，离线 `80` 依赖 overlay。测试删除的是夹具原始 source 与 candidate 路径，不是生产归档策略；也没有证明后续 import 可以继续修订、清理或压缩 overlay。bundle/import 创建依赖宿主硬链接能力，受限沙箱会以 `EPERM` 假失败，测试只运行专用文件。
- B-cold-prefix-removal-red 只覆盖一个 project-log source、一个授权段、两个冷 identity 与一次中间删除；production 未改，因此这是失败证据而非删除语义已实现。它没有覆盖连续删除、混合新增与删除、同 timestamp 多 session、多段、跨日/DST、并发 writer、真实尾部截短或恢复 API。现有 truncation diagnostic 仅按文件缩短与事件数下降判断，无法区分中间删除和尾部截断；后续修复不能只放宽 identity guard，还必须明确 revision overlay、恢复事实与 truncation warning 的优先级及用户可见语义。当前断言以完整 composite 失败保留 events、summary、warning、hot facts、digest、immutable segment、revision 与 recovery 证据；只运行专用文件，不全仓。

- B-cold-prefix-removal-write 只对 project-log 接受“纯删除”；所有来源仍保留既有“纯追加”。必须至少保留一个 cold identity，同时新增与删除、全部冷 identity 消失、跨 timestamp/session 迁移仍拒绝；其他 kind 的纯删除也保持原拒绝，因为当前没有对应来源的持久诊断。真实 invalidate 后的同内容 project-log reparse 已覆盖：成功 `updatedFileCount=1`、revision metadata 字节不变、sidecar 仍只有一条 count=1，不重复膨胀。它仍未覆盖连续多次删除、混合新增与删除、同 timestamp 多 session、多段、多 home、跨日/DST、并发 writer、candidate 读取/COMMIT 后失败、恢复 API 或 backup/import 的后续再修订。`PROJECT_LOG_TRUNCATED` 仍是持久的高水位证据，不会在文件后来增长时自动清除，也不能区分合法事件删除与意外截断；用户可见文案因此只声明观测到缩短，不声明数据损坏。原 immutable cold payload 没有被复制进 `history_replaced_facts`，恢复仍依赖候选段；只有此前已被 overlay 覆盖的 effective payload 在消失时才进入恢复表。测试只运行三个专用 cold-prefix 文件，不全仓。
- B-cold-removal-rollback 只在 revision metadata 已暂存、`PROJECT_LOG_TRUNCATED` marker UPDATE 处注入一次确定性 SQLite trigger 失败；不覆盖 reader/解析失败、cold payload 校验失败、candidate 读取失败、revision COMMIT 之后、rollup 重建中或进程崩溃。快照比较覆盖单个 segment/source/home、单个 UTC/local 日、三张 aggregate 表、hot/recovery facts、公开 union 与 summary，不覆盖多段、多 home、跨日/DST、并发 writer、WAL 崩溃恢复或完整 `sync()` 原子性。trigger 属于测试本地 schema，不会被生产代码感知；成功重试证明该失败点回滚了 revision 与 warning 的同一替换事务，不能推广成通用警告或 revision 框架。
- B-cold-perf-eviction-red 只覆盖一个真实 ZCode 夹具、一个授权冷段、一个冷 perf 样本和一个热 perf 样本；它证明当前 `summary.perf` 在冷 perf 行被本地删除后仍只读 hot carrier，并不实现自动淘汰、迁移、冷 perf 文件读取、恢复或跨来源合并。`averageTps`、`p10`、`n` 与 coverage 差异都可能随时间范围、fixture 版本或统计核心变化；本卡没有声称这些数值是通用公式，只固定本次 fixture 的完整对拍。只删除 `perf_samples` 单行，未证明 timing 依赖行的清理/保留策略，也未覆盖多段、多 home、并发 writer、重复删除、超大表或生产服务。
- B-cold-perf-read 只提供单段 `perf_samples` 只读，不参与 `summary.perf` 合并、淘汰策略、冷热去重、timing 依赖解析、authority 选择或服务接线。返回值覆盖 candidate 中注册区间内的全部列，但区间是 registry 的整段范围；目前没有任意子范围参数、分页或流式读取，调用方若要小范围仍会把整段 cold samples 物化。候选验证沿用 event/source fingerprint，`source_files` 身份证据只覆盖在该段内有 events 的来源；perf-only 来源不会在本卡被伪造或补写身份，实际读取只信任已由 candidate manifest/digest 固定的 `perf_samples` 行列。缺表与 schema 漂移会在返回任何样本前失败；未覆盖多段、多 home、并发替换 candidate、损坏 backup、WAL 读写竞争、超大 perf 表或备份/导入材料化后的路径。测试只运行专用文件，未跑全仓套件。
- B-perf-reader-missing-file 只覆盖“候选数据库整文件暂时不在原路径，registry 与 manifest 不变，再恢复同一文件”的序列；底层错误必须保持 `ENOENT`，不要把它吞成 `[]` 或未登记 segment。它不覆盖 manifest 缺失、权限错误、半写/损坏数据库、读取过程中文件被替换、跨进程或跨 store 缓存、并发 writer、真实服务重启或生产归档目录。测试不改生产源码，只运行专用文件。
- B-cold-prefix-revision-red 只覆盖一个授权段、一个 home、一个 Codex source/session、两个同文件 timestamp，以及同路径冷累计 100→90、热尾保持增量的精确反例；不覆盖冷事件新增/删除、跨 timestamp、来源身份变化、多段重叠、authority 切换或并发 writer。当前失败是冷前缀多重集精确相等检查拒绝修订，`replaceFile()` 回滚后 `sync()` 以既有 warning 继续，旧候选 100 仍是可恢复事实；测试没有也不应把 `[100, 30]` 当作修订后的正确答案。后续需要 owner 明确定义候选段的事务性 supersession/替换证据语义，再决定允许哪些冷前缀差异；不能通过放宽成“只要 id 相同”或新建全历史快照绕过该契约。
- 来源至少要有一次成功发布的 `source_files` 行；从未入库的来源没有历史可保留。
- home 在 discovery 阶段整体失败时仍走 degraded，不登记 missing；这与“目录已不存在”不同。
- 通用改名的内容相等判据必须依赖内容指纹；没有指纹时保守保留旧来源，宁可留下 missing 也不据 size+mtime 删除。
- 通用成功改名未对每个来源适配器分别做端到端测试；已测 Codex 归档移动/压缩，以及非 Codex 的失败替换保守路径。
- B1b-C-P 只覆盖 Codex 发布事务里会删除的 `replaceOldThreadIds` 候选及依赖；`stagedThreadsToMerge` 只新增新 turn，不替换旧键，request timing 不在该卡的样本/依赖范围内。
- B1-timing-audit 只覆盖一次真实 Codex 重解析；没有证明重复导入、冲突 variant 的容量、清理策略或长期磁盘增长。audit 的结论是 evidence/link append-only，因而没有另建恢复账本；这不等于 evidence 已有公开恢复 API 或历史快照。
- B1-workbuddy-evidence 只覆盖一次真实 usage 源文件重写加 trace 时长改为异值；没有覆盖删除 trace、多个 home、同 message 大量冲突或清理策略。observation 表保留原始观察，不保证 `perf_samples` 在冲突期间可查询。
- 当前非 Codex reader 不自然产生 `perf_sample_sources`；B1b-P 测试用已存在 `source_files` 上的合法依赖行验证级联丢失与恢复，不声称非 Codex reader 已生成这些依赖。B1b-C-P 用真实 Codex 依赖集测试，但依赖角色变化是测试侧直接修改。
- sibling facts 的身份来自删除前的旧 `source_files` 行；如果该身份在本次替换前已经消失，就没有可捕获的旧身份，只能保留仍存在的 live facts。
- B1c-E 只覆盖恢复行插入后、提交前的 SQLite 触发器错误；后续 perf 写入失败、磁盘满、进程崩溃和 `COMMIT` 本身失败仍未做故障注入。
- B1d-growth 已覆盖 100 次普通追加，但没有 1,000/10,000 次追加、长历史体积、磁盘增长或清理策略的测量；不能据此声称长期容量已评估。
- B1-truncation-diagnostic 只覆盖同一物理路径、旧 `source_files.kind = project-log`、新文件 `size` 变小且 live event 行数减少的场景。同尺寸重写但行数减少、文件变小但行数不变、其他 parser 的缩短仍无此 warning；total 下降本身也不告警。
- B1-truncation-persist 只保证已经被接受的截断在后续 `sync()` 轮次继续显示；文件后来增长不会自动清除 marker，它表示“该路径曾有一次成功替换导致行数减少”，不是“当前文件仍比最初短”。marker 位于 perf 命名的 `perf_file_warnings` sidecar，未来 perf 清理不能把它当作纯 perf 条目删除。
- 截断 warning 仍只通过既有 `store.warnings` 展示，没有新增 API 字段或冻结 perf 告警码；`perfState` 保持 `ready`。测试覆盖 no-op 与进程重开后的 no-op，不覆盖其他长时间运行消费者是否调用 `sync()`。
- B1-badline-persist 只覆盖 project-log：warning 含路径与行号、不含行内容，marker 随成功替换事务提交，并在 no-op 与重开后从 sidecar 重建。它表示“最近一次成功解析时跳过了这些行”，不是持续实时的文件健康；只有后续成功解析全合法文件才清除，来源缺失或从未再次解析时旧 marker 会继续显示。marker 与截断 marker 共用 perf 命名的 `perf_file_warnings` sidecar，未来 perf 清理不能把 project-log code 当纯 perf 条目删除。测试覆盖单个坏行、`[2]` 行号、no-op/重开、全合法修复清除、截断 marker 保留和回滚不污染；没有覆盖多坏行跨轮移动、多个来源并发、同 size+mtime 修复、长期 marker 容量或旧 sidecar 损坏。其他 JSONL reader 仍按原契约静默跳过，`.jsonl.zst` 仍抛原压缩 rollout 解析异常；`perfState` 不因该 warning 降级。
- `history_replaced_facts` 目前只有持久化，没有公开列出/恢复 API，也没有自动清理或保留期限。
- `occurrence_count` 只保存同一规范 payload 的最大缺失份数，不保存每行的自增 `id`、原始顺序或彼此关系；恢复只能物化 N 份等价 payload，不能声称还原原表行身份。
- “最大缺失份数”是幂等高水位，不是跨多代同值事实的累计账本；相同 payload 若在不同代际分别消失，不会累计成总丢失次数。
- 恢复事实保留原物理路径与原 home 身份，不建立到当前替代来源的谱系。跨路径改名后的旧事实仍可读取，但消费者需自行解释来源已不在。
- B0.4-summary 只接索引汇总路径；内存汇总路径与 `usage-types` 的公开类型仍由各自 owner 同步。API handler/UI 源码未改，但索引路径的 `summary.perf` 已会进入现有 JSON 投影，因此 `test/perf-server.test.js` / `test/cli.test.js` 中按 13 键精确校验 `summary.perf` 的断言需要其 owner 更新。
- I1 的定向测试用窄 `prepare` 计数证明完整 UTC/local 日及公开 summary 选到 `usage_rollup_daily`、部分日完全不查 rollup；纽约 DST 日由固定 `TZ` 子进程覆盖。没有覆盖所有 `summarize()` 调用组合或性能收益。`previousUsageRange()` 派生范围不带 `calendarZone`，因此比较期仍走原 SQL。
- 成功重解析仍会替换 live events；只是当前路径的旧 events 现在有恢复证据。不能把 B1b-E 写成“全部事实永不删除”。
- B3-schema / B3-register-metadata / B3-read-segment / B3-read-snapshot / B3-union-read / B3-cold-authority-read 已接生产登记 INSERT、带快照复核的单段读取和按 marker 的范围冷读，但仍没有流式/分页读取、authority 写入/切换、恢复 API、热事件删除或目录行删除。`archive_segments` 有行且段可读，不等于热事实已移除，也不等于全部历史可由冷层回答。
- B3-register-metadata 的“同 digest 幂等”不比较路径：同一包若被复制到另一绝对路径，重登记仍复用首次路径。没有覆盖进程崩溃恰发生在候选生成后、登记前，或候选文件在验证后被替换的竞态；后者依赖 `verifyHistoryBackup` 对候选的同步读取与摘要校验。
- B3-read-segment 一次性把整段 events 物化到数组，没有分页、流式迭代或内存上限；大段读取的峰值内存与段行数线性增长。没有查询计划、读取耗时或并发读取测量。
- 单段读取仅覆盖“目录行→候选包→完整 events”的路径；没有把冷段时间范围、来源或统计接入 `aggregateRange()` / `summarize()`，所以不能把本卡称为“所有事实冷读”。
- 候选数据库与 manifest 不是双文件原子发布，也没有 fs 锁；B3-read-snapshot 只保证 verify 之后到首次读取之间的同数量改写会在 SQLite 快照内被摘要复核拒绝，不能把数据库/manifest 发布本身变成原子事务。快照建立后的外部改写不会混入本次 rows，但也不要求读到磁盘上“更新后”的版本。
- 快照反例通过测试侧包装 `DatabaseSync.prototype.exec` 注入，证明的是该接缝中的确定性代码路径；没有覆盖真实进程并发写、rename 替换、WAL 恢复、磁盘故障或文件锁竞争。
- B3-union-read / B3-union-cold-snapshot 的原有覆盖是单段有限临时库；多段证据由 B3-union-multisegment 补到两段。热快照发生在 `await this.open()` 之后、同步保存点内；返回结果是捕获时的 hot/authority 选择，不是所有冷读取完成时的 live 视图。冷段 rows 与来源身份共享同一个已验证 `BEGIN` 快照；但 `verifyHistoryArchiveCandidate()` 到随后只读连接 `BEGIN` 之间仍是既有候选文件发布窗口，不能替代双文件原子发布或 fs 锁。B3-cold-authority-read 仅增加 marker 驱动的只读选择，仍不提供 authority 写入/切换、热删除、统计或公开 API。
- B3-union-multisegment 只覆盖两个非重叠段、一个中间 hot gap 和一次第二段缺失；没有覆盖三段以上、多个 gap、相邻段边界、候选验证后到冷 `BEGIN` 的替换窗口、真实并发删除或超大范围内存。测试用显式 `id` 让独立来源副本满足既有整行指纹契约，不表示公共事实身份依赖 `id`；B-C2-model-read 只接模型分支，不把冷段并入该读取。
- B3-cold-authority-read 只证明“已提交 authority + 完整段 hot 为空”时范围读取会改走冷快照；没有提供 authority 写入/切换 API、热事件删除命令、归档执行器、恢复 API、rollup/`publishedUsageEvents()` 接线或公开 carrier 集成。authority 是所有历史的显式 v1 ID 列表，不是按范围逐次协商的协议；marker 存在但某个无关 id 未登记也会整体失败。
- B3-cold-reparse-prefix 只覆盖已显式授权、且完整替换文件仍包含与冷段完全相同的冷前缀；它不提供通用跨冷修订、authority 切换/热淘汰 API、部分增量读取、多段压力或非 Codex parser 支持。每次替换会对所有授权段调用现有冷快照 reader 来寻找当前来源，段数增加时有重复验证成本；来源身份比较覆盖将 upsert 的 path/kind/home，而非只比较旧 `source_files` 行。冷事实改值、增加或删除都会让该文件替换回滚，但 `sync()` 仍按既有契约把该文件错误转成 warning 并继续其他文件；测试没有覆盖进程并发、候选文件发布窗口、超大段内存或长期 authority 列表。没有 authority 时的旧替换语义由独立 100→130 用例锁定，未被当成冷过滤路径。
- B3-cold-published-oracle 只证明 `publishedUsageEvents()` 与 `periodComparison()` 当前都看不到冷段，没有把冷段接入任何生产读取，也没有新增 async API、缓存或范围合并。它使用一个 Codex model、一个 repository、UTC `periodComparison` 和该固定日期，不覆盖 summary/carrier、Dashboard、其他 period 时区、费用字段、缺失来源、多个授权段或冷热混合边界。修复前该断言位于同一真实测试的 merge/no-op 之后，故本卡运行会在公开读取处停止，后续同文件的改值/增删拒绝断言不会在本轮重跑。
- B3-carrier-snapshot 只修完整 events carrier 的快照边界，没有替换同步 `publishedUsageEvents()`、没有接 executor/API/Dashboard，也没有把冷段接入 `publishedUsageSessions()`、`publishedUsageReport()`、summary 或 `periodComparison()`。全历史 bounds 与 hot/registry/authority/source 捕获在同一同步 SQLite 读快照内完成；快照释放后仍逐段 await 冷文件验证和读取，因此方法不是全异步单事务，也不能阻止冷验证期间的外部提交。每次调用都会物化全部 hot 与相交冷段并读取完整候选文件，无范围参数、分页、流式读取、冷段缓存或内存上限。确定性交错只覆盖“bounds 读取后第二连接追加旧界外 hot 事件”这一条窗口，不覆盖并发登记/删除、冷包替换、authority 切换、多段交错或超大历史；green oracle 也只有一个 model/repository 和一个授权段。
- B3-cold-report-carrier 仍不是全异步单事务：events/home/quota/source 身份在保存点释放前已物化，但冷段验证和读取发生在释放后；因此 report 是“捕获时 hot 状态 + 随后通过指纹复核的冷包”组合，不能阻止冷验证期间另一连接提交新 hot 事实或替换已读取数据源。每次调用会把全部 events、homes、quota 和相交冷段留在内存，没有范围、分页、流式读取、冷段缓存或内存上限；sessions 虽从同一事件批派生，也没有日期范围参数。测试的确定性交错只覆盖额外 hot home/quota/event，不覆盖并发 authority 切换、registry/候选删除竞态、多段交错、超大历史或 executor/API/summary/period 接线；同步 `publishedUsageReport()` 仍是原有 hot-only 契约。
- B3-period-authority-snapshot 固定的是“marker 判定 + 无 authority 首次 period 读取”这一对；若 authority 在 marker 读取前已存在，随后释放短快照再进入 carrier，两者仍不是同一个全历史数据库事务，仍可能遇到 authority 在二者之间被删除/切换。该并发 authority 翻转没有测试。pinned 结果仍写回既有 `periodComparisonCache`，但修订保持快照前值；测试证明外连接提交后下一次同步读会清缓存并返回 hot-only 110，而不是复用旧 130。带 authority 时仍会把全部已验证历史事件物化到数组，再按 home 过滤后交给共享聚合，内存和 CPU 随完整历史线性增长；没有范围参数、分页、流式读取、冷聚合缓存或结果缓存。测试只覆盖一个授权段、一个 Codex model/repository、UTC/local/exclude，不覆盖多段、多 home 冲突、超大历史、summary/Dashboard/executor 接线或费用字段的独立对拍。无 authority 时仍是同步 hot-only 入口，不能把它误当成全局冷感知切换。
- B-cold-summary 的冷路径会先物化全部已验证历史 events，再按 `excludeHomes` 过滤后交给共享内存算法；没有范围参数、分页、流式读取或摘要结果缓存，CPU/内存随完整历史线性增长。无 authority 仍走同步 SQL/cache，只有调用方显式 await 新入口才获得冷感知；executor、server、Dashboard 和 CLI 尚未接线。`publishedHistoryUsageReport()` 不携带 `generatedAt`、`perfSamples/perfMeta` 或 store 索引路径的 `records`，本卡只补 `generatedAt` 与 `warnings` 的最小报告形状；store-only `records` 与未归档 `store.summarize()` 的完整形状仍未对齐。`excludeHomes` 分支动态导入 `src/server.js#withoutExcludedHomes()` 以复用现有过滤，不新增共享模块；若后续要避免 store→server 动态依赖，应把该纯函数迁到主审拥有的公共 core。确定性交错只覆盖 marker 后外连接提交 authority/删热/改 quota，不覆盖多段、超大历史、真实并发 writer 或 authority 翻转。
- B-cold-summary-records 只覆盖非配额 `recordsForRange()` 语义；配额窗口仍走 `quotaRecordsForRange()` 的既有路径，冷 `summarizeHistory()` 尚未为 quota preset 补 records，不能从本卡推断配额冷记录已等价。普通冠军仍按完整冷热 events 重新计价并扫描，虽复用 event-cost memo，但没有跨调用冠军缓存、流式/分页或内存上限，成本随完整历史线性增长。冷 local 日/周/月键由事件 timestamp 按当前本机时区重算；若历史事件曾按另一 local 时区写入，冷结果可能与热 SQL 存储的 `day_key/week_key/month_key` 不同；UTC 无此差异。`preset=all` 仍按原契约返回 `{}`；`summary.perf` 由 B-cold-perf-capture 单独补齐，配额窗口 records 仍缺失。
- B-cold-perf-capture 只让 `summary.perf` 读取 carrier 捕获的 hot perf 样本、state、identity 和 sources；冷 perf 文件尚未定义，也不读取、合并或淘汰。冷 carrier 为获得最终范围会物化 hot `perf_samples` 全表，摘要本身仍物化全部 verified events，没有分页、流式读取或内存上限。executor/server/Dashboard/CLI 仍未接 async `summarizeHistory()`；同步 `summarize()` 仍保持原 hot-only 路径。确定性交错只覆盖冷读取期间第二连接插入样本并修改 state/index，不覆盖 authority 翻转、多段交错或超大 perf 表。
- B-rollup-complete-events-seam 仍是模块级能力，不负责从 store 获取 events、验证 authority、建立发布事务、选择缺失段策略或保留旧 rollup。它只支持一个 UTC 日，不覆盖 local、多个 day、多段交错或超大事件数组；完整 events 由调用方先物化，TEMP 写入和原 SQL 重建成本随事件数线性增长。固定 TEMP 表名意味着同一 SQLite 连接内重入或并发调用会互相覆盖，调用方必须串行化；持久 schema 与 hot facts 均未改变。
- B-store-cold-rollup-day 的写锁覆盖整个冷段验证与重建窗口，因此大段冷文件会阻塞其他 writer 更久；这是本卡用 `BEGIN IMMEDIATE` 换取同修订视图的直接成本。它先通过 `publishedHistoryUsageEvents()` 物化完整历史 events，再把全部数组交给单日模块，内存仍随完整历史线性增长；固定 TEMP 表仍不可在同一连接重入。入口拒绝已活动事务，未设计嵌套事务复用；没有 schema/authority 切换、坏段独立 fixture、外部 writer 阻塞时序、local、多日循环、executor/server/Dashboard 或生产淘汰覆盖。
- B-cold-rollup-writer-lock 只证明一个确定性冷读取窗口内、`busy_timeout=0` 的单条自动提交更新会被 SQLite 拒绝且事务结束后同一更新可见；它不是外 writer 并发压力、WAL 调度、长等待、进程崩溃、多语句事务或 authority 并发切换的完整证明。测试依赖实例方法临时 patch 和 `setImmediate` 保持窗口，不覆盖所有冷读时序；生产代码仍未接 executor/server/Dashboard，也未扩展 local、多日或 HTTP。
- B-rollup-multi-UTC 仍是模块级批量能力，不新增 `UsageStore` 多日入口；多个目标日的原子性仅覆盖模块内部同一次 `rebuildUsageRollupsFromSource()` savepoint。调用方仍须先物化完整历史 events，TEMP 与单次 SQL 扫描成本随事件总数和目标日数增长；固定 TEMP 表仍不可在同一连接重入。未覆盖 local、空/重复 day 数组的额外契约、跨批失败恢复、executor/server/API 或多日 store 事务。
- B-store-full-UTC-rebuild 的日期跨度按完整 events 的 UTC `min..max` 展开，跨年历史会生成很长的 `days` 数组；完整 events 仍先整体物化，固定 TEMP 表仍不可重入，整批 `BEGIN IMMEDIATE` 的写锁会覆盖所有冷段验证与重建。空历史会清除三张聚合表行，但 `usage_rollup_days` 仍保留空日 marker；这是复用冻结模块的既有语义，不删除 marker 本身。它没有接普通 `sync()`、executor、server、API 或 local，也没有提供任意日集合入口、分页/流式读取或并发压力证明。
- B-rollup-complete-local-seam 只给模块批次增加 `calendarZone` 透传，不负责确认进程时区与持久 `local` zone identity 一致；错误 TZ 会生成错误的 local key，必须由未来 store 接线在同一发布边界内检查。新增真实载体只覆盖 America/New_York 春季 23 小时日；25 小时回拨日由 `usage-rollups.test.js` 的既有模块测试覆盖，不是本冷热载体 fixture 的直接证据。store 全历史入口仍只重建 UTC，未实现 UTC/local 双 zone 原子发布、local 日期覆盖或 stale local 清理。
- B-store-full-dual-zone 的 UTC/local 两批仍各自把完整 events 写入固定 TEMP 表一次，再按同一 carrier 重建；整条 `BEGIN IMMEDIATE` 同时覆盖冷段验证、两次 TEMP 写入与两 zone SQL，写锁和内存成本随完整历史线性增长。日期跨度为每个 zone 的完整首末范围（含空日）并 union 四表已有日期，超长历史会生成较长 day 数组；固定 TEMP 表仍不可在同一连接重入。local 以当前进程时区为身份来源，并只在成功提交时更新 marker；实现不独立校验进程 TZ 是否是用户期望的 TZ，错误进程时区仍会生成按该时区一致的错误本地日期，但会覆盖旧 local 聚合而不是与其混留。既有空日 marker 不会因聚合为空而删除。普通 `sync()`、单日 UTC 方法、executor/server/API 和生产接线均未改变，也没有新增任意日集合入口、分页/流式读取或并发压力证明。
- B-executor-history-rebuild 只暴露内部 worker 消息与 client 方法，没有加入普通 sync、HTTP、CLI 或启动调度；调用方仍需明确触发一次完整双 zone 重建。长冷历史的段验证、完整 events 物化、两次 TEMP 写入和 rollup SQL 会在共享写尾链与数据库 `BEGIN IMMEDIATE` 内串行完成，期间阻塞其它 sync/backup/snapshot/发布读取请求；内存和写锁成本沿用 store 入口。缺段时请求整体拒绝且旧四表保持上一成功快照，不会回退为部分重建。`postState()` 的 metadata 仍是 hot-only，因此执行器客户端 metadata 的事件数不等于冷感知 summary；测试用第二只读连接读取实际四表并经恢复候选后再检查 cold-aware summary 130/2。专用夹具只覆盖两个 UTC 日、一个授权段和当前宿主 local 时区，没有 25 小时冷载体、超长历史性能、并发 writer 或多段压力证明。
- B-cold-rollup-sync-regression 的红测证明普通 `sync()` 在已授权冷段存在时，同 UTC 日热尾修订会把该 dirty day 的四表重建为仅 hot facts；B-cold-rollup-sync-fix 随后修复该分支。红测夹具本身仍只覆盖一个授权段和当前宿主 local 时区：`02:00Z` 冷事件在 7 月 12 日、`23:01Z` 热事件在 7 月 13 日，其它时区的具体 local 行不同，但 oracle 对拍始终使用当前进程时区。
- B-cold-rollup-sync-fix 在存在非空授权段时，每次 dirty/local-zone 维护都会物化全部完整历史 events，再只写 dirty UTC 与所需 local 日；内存随完整历史线性增长，且 `BEGIN IMMEDIATE` 会跨冷文件 await 持写锁，阻塞其它 writer。不存在范围、分页、流式读取或冷事件缓存。轮末 rollup 是事实提交后的独立事务，不是整个 `sync()` 原子：缺段失败时 hot facts 可能已提交，event triggers 已删除 day markers，测试明确断言三张聚合表与 dirty 保留而不是声称四表回滚；恢复段后的下一次 `sync()` 才能补齐四表。没有新增普通无 authority 路径之外的冷修订重放、25 小时冷载体或并发 writer 压力证明。
- B-cold-rollup-sync-local-rollback 只证明同一外层 rollup 事务中的 local 插入失败会回滚 UTC/local 三张聚合表并保留 dirty，不证明 `usage_rollup_days` 或已提交 hot facts 回滚，也不证明整个 `sync()` 原子。trigger 依赖 UTC daily total 已为 `150`，覆盖的是 UTC 批次成功后的 local daily 写入点，不覆盖 local models/sessions 中途失败、多个 local day、zone 切换、第二次重试也失败、并发 writer、进程崩溃或 25 小时 DST 日。夹具仍只有一个授权段、单 home 和当前宿主 local 时区；`sync()` 重建时仍物化全部完整历史 events，并在跨越冷段 await 的 `BEGIN IMMEDIATE` 内阻塞其它 writer。
- B-cold-rollup-sync-zone-change 只覆盖 `Asia/Shanghai`→`America/Los_Angeles`、一个授权段、单 home、同一 UTC 日的两个事件，不测试整套时区、DST 回拨、多段或多日边界。返修证明的是该额外空 marker 的日界、公开 reader 返回值与空计数语义，不是通用 marker 清理策略；没有断言其它时区或其它空日的 marker 等价。测试通过子进程启动时覆盖 `TZ`，不改 `HOME`/`CODEX_HOME`；没有测试同步进行中的外部 writer、authority 翻转、冻结读取或生产 executor/server。初始红测只是把 day marker 的合法空日布局误当成聚合残留，不能表述成生产 bug；生产按本卡要求冻结。
- B-period-executor 的 dashboard 已让 summary/metadata/period 共用同一 `reader` 版本；但在发布 reader 窗口内 summary 仍只算 hot facts，period 会补冷段，所以两者计数天然可不同，不能再把这种冷覆盖差异解释成快照不一致。没有把 summary 或 metadata 改为 `summarizeHistory()`/冷感知 metadata，也没有改 server/public/Dashboard 客户端。每次 period 读取仍物化全部热事件与冷段，无范围、分页、流式读取或结果缓存；同步 `UsageStore#periodComparison()` 仍保持 hot-only。测试覆盖单授权段、单 home、UTC、缺候选文件，以及外部 writer 已提交 hot/authority 变更时由子进程 preload gate 固定的发布 reader 窗口；不覆盖多段、authority 切换延迟、超大历史或真实 server 接线。
- B-summary-executor 把 summary 接到 async `summarizeHistory()`，但 metadata 仍是同步热读，因此发布 reader 中 summary/period 可含冷段而 metadata 只反映捕获时的 hot 身份；不能把三者当作同一种历史覆盖。冷 summary 仍会物化全部 verified events 与 hot perf 样本，没有范围参数、分页、流式读取或结果缓存，CPU/内存随完整历史增长；本次只为专用测试启动临时执行器，没有启动生产 server、真实 Dashboard 客户端或完整 API 套件。相邻 period fixture 已改为外部 writer 先提交、worker 在第二次 `syncRound()` 入口被 preload gate 截停；因此 pinned dashboard 130、独立 period 230 与释放后 republish 230 都有已提交写者证据。剩余限制是 gate 依赖子进程启动时注入 `NODE_OPTIONS`，并未覆盖多进程调度、authority 翻转或真实 server 接线。也没有补配额窗口 records、冷 perf 文件读取/淘汰或同步 `summarize()` 的语义替换。
- B-cold-metadata 的 cold 路径会把全部 verified events 物化后重算 metadata，CPU/内存随完整历史线性增长；没有范围参数、分页、流式读取或结果缓存。`homes` 仍取捕获时的 `this.homes`，不是 archive `source_files` 的完整持久身份；这是为保持原 `metadata()` 契约。若同步等待期间外部提交改变 homes/warnings/generatedAt，cold carrier 固定的是捕获值。测试覆盖一个授权段、单 home、cold-start 与缺段，不覆盖多段、并发 authority 翻转、真实 executor/server 接线或超大历史。
- B-cold-summary-sync-seam 只把已返回的 report 投影成摘要，不负责建立或验证冷载体；调用方必须在 `publishedHistoryUsageReport({ includePerfCarrier:true })` 成功后再调用，不能把任意 report 或缺段错误吞成 hot-only。该同步方法仍读取当前 store 的 `generatedAt`、`warnings`、pricing/catalog 与 event-cost memo，因此正确接线应在准备 report 后立即、在同一 pricing 作用域内调用，不能跨任意 await 或全局 pricing 修改后再用。测试只覆盖单授权段、单 home 排除与 `includeDetails:false`，没有覆盖 server 接线、真实 HTTP、多 home、authority 翻转或超大历史。现有 `publishedHistoryUsageReport()` 仍会在 `archive_segments` 有行时复制段，即使没有 authority；这是快照载体的既有边界，本卡没有修复。

- B-cold-freeze-HTTP-read 只让 `archive_segments` 存在的冻结路径使用自包含冷报告；无冷注册仍走原同步单库路径。它只覆盖一个授权冷段、单 home、UTC 和 summary freeze，没有覆盖多段、多 home 排除、authority 翻转、live 源竞态或 `/api/usage?view=dashboard` 的冷 summary 细节。冷报告与 events 仍一次性物化，无范围、分页、流式读取或缓存。快照成功进入 `snapshots` 后，若后续读取时报告准备失败，快照仍保留以便重试；该失败不是创建失败，因此不能当作可安全删除。
- B-cold-freeze-pricing 只覆盖一个授权冷段、单 home、UTC 和一个真实 `100 cold + 30 hot` 快照；没有覆盖多段、多 home、dashboard 路由、并发 snapshot 请求或多个 server 实例，也不证明全局 pricing 在多进程下隔离。注入点只替换同步 `summarizeHistoryReport`，覆盖报告成功返回后的同步计算抛错，不覆盖 `publishedHistoryUsageReport()` 的异步冷读失败、进程退出/崩溃或 `setPricingCatalog()` 自身失败。`skipCheck=1` 避免测试 auto-sync 改库，但 archive/authority 与冷段读取仍是真实路径；pricing 断言只比较 `totalUsd`、`pricedTokens`、`priceCheckedAt` 与 catalog version，不是完整费用对象逐字段对拍。
- B-cold-hot-tail-revision 只覆盖一个授权冷段、单 home、UTC、一个 Codex session/turn，以及“热侧累计下降但仍位于候选段外”的修订；不覆盖冷前缀改变、冷段内事件修订、多段、多 home、authority 切换、并发 writer 或真实 HTTP/Dashboard。测试没有实现冷段重放或整阶段重建，只证明当前代码对未变冷前缀的热尾替换可成功提交；`summary` 对拍仅归一化必然不同的 `generatedAt`、`perf.indexedAt` 与 `perf.meta.indexedAt`，其余字段深相等。替换事实只验证了 payload 中总量为 30、`occurrence_count=1` 以及重复重解析不增行，没有验证 CLI/恢复 API 对该事实的读取或长期清理策略。
- B-cold-snapshot-cleanup 只处理 server 自己拥有的过期/失败快照与整个 `mkdtemp` 根目录，不清理 executor 或调用方创建的任意路径；即使冻结对象给出异常 `cleanupDirectory`，删除目标也只由私有 `databaseFile` 推导。它不改变 8 个快照的容量或淘汰顺序，不把空根目录在单次创建失败时立即删除（根目录由后续快照复用或 server close 清理），也不覆盖进程崩溃、强制终止或 close 期间仍有并发 freeze 的竞态。WAL/SHM 删除依赖 SQLite `close()` 已先释放句柄；rm 仍可能在磁盘/权限故障时失败，服务 close 会吞掉整目录清理错误，而淘汰路径会返回该错误。创建后失败测试依赖主线程 `UsageStore.prototype.open` 的一次性 patch，只证明主线程读取端 catch；它不模拟 worker/executor 内部在返回后失败，也不覆盖多段大目录、Windows 文件锁冲突、并发淘汰或报告读取失败后的重试。
- authority 读取会物化 `source_files` 身份表做保存点内比较，冷段仍整段物化后按请求过滤，没有分页、流式读取、按路径限定的来源查询或大段内存上限。它验证的是读取时捕获的 live 身份与冷快照身份一致，不是生产归档流程、并发删除或 authority 切换的事务原子性。
- B-C2-model-read 的模型来源补齐依赖 `events` 的 scoped `MIN/MAX`；若请求的 `all` 窗口未覆盖该范围，会额外查询一次完整来源窗口，因此最坏准备五次 `usage_rollup_models` SQL（补齐加四周期）。它没有把 `history_replaced_facts`、`archive_segments` 或权威段合并进模型结果，也不改变 `periodComparisonCache` 的键或生命周期。测试覆盖单进程真实临时库与普通宿主时区，不覆盖跨进程并发写、超长来源范围或所有模型名排序 collation；原 SQL 回退只测了完整日标记缺失和 SQLite 列错误，未遍历所有 I/O/磁盘故障。
- B-C2-clamp-scoped-window 只把模型 period 窗口裁到 scoped facts 的原始 `MIN/MAX+1`，不把边界扩到整日；因此没有完整事实日的 partial window 仍走 model raw-events 分支，事实范围内的无事件 gap 仍可能因缺 marker 明确 fallback。该卡没有补空 marker、没有扩展内部 gap 空日，也没有把冷段、恢复事实或未授权来源并入模型读取。若后续要求所有 partial window 都必须命中 rollup cache，需要另立卡片，不能从本卡推断已经满足。
- B3-read-snapshot 的 `typecheck` 已由主审修复既有 archive/backup JSDoc 后转绿；这属于 owner 接管后的配套修正，不由本卡改动那两个文件。
- I-full-events 只返回当前热 `events` 的已发布行；不读取 `history_replaced_facts`、不读取 `archive_segments`，也不合并冷热。因此它既不是“全部历史 events”，也不是恢复 API：已从 live events 替换掉、只存在于恢复表的旧事实不会被这个方法返回。
- `publishedUsageEvents()` 一次性物化全部行到数组，没有范围、missing/home 过滤、分页、流式迭代或内存上限；返回体积和峰值内存随 live event 数线性增长。它也不建立长事务或额外快照，单条 SELECT 只提供 SQLite 语句级的一致性。
- `sourceKind` 是当前 join 到的 `source_files.kind`；若来源已完成改名、压缩转换或身份替换，该方法返回当前存活 source 身份，不负责重建历史谱系。`serviceTier` 与 `costEventFromRow()` 同用实例内 evidence resolver，未命中时回退存储值。
- I-full-events / I-full-sessions / I-full-carrier-snapshot 没有接入 server、executor 或 Dashboard，也没有自动登记/删除/重建归档、伪造 quota 历史或替代 `timelineEvents()`。当前 executor 仍在调用方侧分别组装 events/homes/sessions，待 A 切换到单个 `publishedUsageReport()`；现有调用方仍不得把这些接缝当成已做日期范围过滤的结果。
- I-full-homes 只枚举 `source_files` 中仍有至少一条已发布文件的 home；从未成功发布任何文件、或所有 source 行已随已提交替换删除的 home 不会出现。它返回当前持久来源身份，不读取 `history_replaced_facts`、`archive_segments` 或 `perf_missing_sources` 来重建旧身份；missing 只是保留行仍存在，不会被解释成新 home。
- `source_files` 没有 `(home_id)` 唯一约束或身份唯一约束。实现按 `home_id` 去重，但同一 id 的 label/path/kind 分歧会抛 `PUBLISHED_HOME_IDENTITY_CONFLICT`，因此历史库若已有部分行被不同 label 更新，读取会失败而不是隐藏冲突。该错误没有额外修复 API；需要后续写入方与迁移方保证身份一致。
- `publishedUsageHomes()` 按 `home_id` 排序，不承诺 discovery/`store.homes` 顺序，也不包含 events 日期范围或 sessions 元数据。它与 `publishedUsageEvents()` / `publishedUsageSessions()` 都是基础载体，不是 server/API 路由，未接入 Dashboard、executor 或配额历史。
- I-full-sessions 的 `id` 只在 `(homeId, id)` 内唯一；同一原始 session id 出现在两个 home 时会保留两条会话，不会跨 home 合并。消费方不能只按 `id` 去重。
- `channel/cwd/model` 是稳定事件顺序中最后一条事件的当前投影，不是会话创建时的不可变元数据；后续重解析或来源替换可能改变这三个值。数据库未保存的 `source/originator/cliVersion/modelProvider/filePath` 等字段没有返回，不能从该派生载体恢复原日志全文或全部会话元数据。
- `publishedUsageSessions()` 复用两次同步读方法，先读 home 身份再扫描全部事件，然后一次性物化分组；没有与 `publishedUsageEvents()` 共用同一 SQLite 事务。另一连接恰在两次读取之间提交身份或事件变化时，没有跨语句快照保证。峰值内存随 live event 数与 session 数线性增长，也没有范围、分页或流式接口。
- `publishedUsageReport()` 的保存点是 SQLite 事务接缝，不是只读授权；它的一致性依赖被调用的四个方法当前只读。若后续在其中加入写操作，保存点会允许写入，必须另加约束或拆分。固定保存点名也要求该方法保持同步且不可重入；当前调用链没有这两类情况。
- 跨连接提交用例通过测试侧临时包装 `publishedUsageEvents()` 在精确语句间触发第二个真实 `DatabaseSync` 提交，证明的是保存点内后续读取不混入该提交；没有启动真实多线程/多进程并发压力，也没有覆盖保存点建立前的失败。该提交现在同时改 events/home 与 quota，current carrier 读取旧 37、下一 carrier 读取新 58。
- `quotaObservations({ useCache:false })` 只由 `publishedUsageReport()` 使用。直接调用 `quotaObservations()` 时仍保留原 memo 契约：受 `replaceFile` 管理的写事务靠 `writeTransactionDepth` 绕过缓存；测试中直接 `BEGIN` 的外部事务不会被该方法自身识别，但报告路径已显式关闭 memo。没有把 `DatabaseSync.isTransaction` 全局接入 quota 缓存，以免影响现有 read transaction 的复用。
- 候选生成仍受现有非空 `archive_segments` 备份拒绝约束，因此调用方必须先创建候选再登记；本卡没有新增“登记后可重新打包目录”的能力，也不修改 `src/history-backup.js` 的 schema 21 兼容范围。
- B3 的 v20 夹具由同一代码新建 v21 后仅 `DROP archive_segments` 并设回 20；这是精确的“少一张新表”的 v20 结构，但不是独立冻结的 v20 二进制备份。迁移仅断言事实表行集不变，没有做损坏 SQLite/磁盘满注入。
- `src/history-backup.js` 目前只支持 schema 19/20。schema 21 后备份兼容是明确的后继集成卡，本卡按范围未改 A 文件，也未批量修其他测试中的固定 20 断言。
- I1-sync-local / I1-zone-reopen 没有独立的 local dirty 队列。正常增量仍按 dirty UTC 日保守投影；zone 变化只在下一轮从 events UTC 日与既有 local marker 推导，日数可能多于真实受影响日。没有任何事件或旧 marker 的空 local 日本来就无法枚举，不会被主动预建；同一进程运行中切换 `TZ` 也未测试。一次 zone 变化的扫描与 local 重建成本随事件日数和 marker 数增长。
- 发布事务先提交、C5 缓存失效后执行 rollup 维护，因此 UTC 或 local 重建失败都会让本轮 `sync()` 在数据已发布后抛错；外层回滚会保留旧 `usage_rollup_daily` 行但由事件触发器先移除 day marker，查询因此回退 SQL；dirty 标记保留，下一次成功同步会重试。不能绕过 day marker 直接把旧 daily 行当缓存读取。
- `test/perf-codex-index.test.js` 的精确 `sqlite_master` 表清单断言现在还会看到五张 `usage_rollup_*` 表及 `archive_segments`；该文件原有的固定 schema 20 断言也属于待更新 owner，本次受文件范围限制未修改。

- B-cold-timing-source-candidate-fidelity 只证明一个真实 Codex fixture、一个线程和一个 candidate 的 raw dependency rows 一致；不覆盖 registry/verifier、冷 perf reader 合并、summary/perf 统计、timing publication、淘汰时依赖清理、恢复 API、bundle/import、多线程/多 home、并发 writer 或损坏 candidate。candidate 仍包含全库的 hot perf 与 timing 依赖，因为既有候选只裁 `events`；这是保真证据，不是“候选只含冷依赖”或“这些依赖可安全删除”的契约。测试读取仅验证文件字节未变，未验证 manifest 独立损坏、候选发布窗口或巨大依赖表的性能。测试只运行专用文件，未跑全仓套件。
- B-cold-workbuddy-duration-fidelity 只证明一个真实 WorkBuddy home、一个 message、两条冲突原生时长观察和一个 candidate 的 raw observation/source-identity fidelity。异值冲突按既有契约不产生 WorkBuddy `perf_samples`，该零样本是预期证据，不应为测试“补齐”。candidate 仍是整库 backup 后仅删除范围外 `events`，因此包含 hot 侧表和依赖；本卡不覆盖冷 perf/时长合并、projection/reconstruction、淘汰、删除、恢复、bundle/import、多 home、并发 writer、损坏 candidate 或超大表性能。测试只运行专用文件，未跑全仓套件，也未启动生产服务。
- B-cold-unplaced-retention 只证明一个真实 ZCode fixture、一个 `ts_ms IS NULL` 样本和一个 candidate 在 event-only 封存下的保留/读取边界；没有删除任何 `perf_samples`，因此不能作为 perf 淘汰、迁移、清理或恢复已实现的证据。测试只覆盖一个 identity/来源路径，不覆盖多个 NULL 样本、冷热重复、perf-only 来源、多个 candidate、多 home、并发 writer、损坏 candidate、bundle/import 或超大表。`readHistoryArchivePerfSamples()` 继续按 registry 的有限 `[start_ms,end_ms)` 查询，没有任意子范围、分页、日期推断或 NULL-time fallback；null 行只在 hot 诊断接口中保留。测试只运行专用文件，未跑全仓套件或 typecheck，也未启动生产服务。
- B-cold-perf-dependency-closure-red 只证明一个真实 Codex candidate、一个冷样本、一个被删除的 `perf_sample_sources` dependency 和一个重打包序列；当前是未来依赖闭包契约的预期红，不是生产已实现能力的回归。它没有测试删除 timing link、rollout owner、source identity、primary source 或冻结 `perf_samples` 的不同组合，也不覆盖冷热样本混合、多个依赖、无 timing 的合法样本、source inventory 变更、bundle/import、并发 writer、损坏 manifest 或 summary/淘汰接线。测试只删除候选副本中的依赖行，不修改 source store；`createHistoryBackup()` 只证明外层包完整性，不能被解释为 perf 图闭包。只运行专用文件，未跑全仓套件或 typecheck。
- B-cold-timing-manifest-red 只覆盖一个真实 Codex fixture、一个冷样本、一个原生 response/thread 链路和一条被改写的 evidence `duration_ms`；当前是未来原始 timing manifest 契约的预期红，不代表生产已实现该验证。它没有新增或合并多来源 evidence 冲突，也没有覆盖同一 response 多 variant/origin、替换 `variant_key`、删除 evidence、改写 timing link、多个 response、多个 sample/home、冷热混合、bundle/import、并发 writer、损坏内部数据库或 summary/淘汰接线。复合主键保持不变时，SQLite 约束允许 `duration_ms` 与 `variant_key` 内的旧摘要不一致；本卡正是利用这一点证明外层 checksum 和现有 sample/index 摘要不足以发现原始 timing 值改写。只运行专用文件，未跑全仓套件或 typecheck。
- B-cold-timing-manifest-write 只证明一个真实 Codex fixture、一个冷样本线程和该线程当前全部 linked evidence 的摘要/验证；测试数据没有同一 response 的多 origin/variant 异值，也没有多 owner、多 home、多段、UNIX 边界或超大 timing 表。timing 两张表缺失/列漂移会在创建或验证时归为 `HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH`，但本卡没有单独制造这些 schema 损坏；meta 的 JSON 语法、format、range、table 集合和 rows/hash 形状会严格拒绝，未证明所有 SQLite 错误都能无损归类。无 timing key 是 legacy 兼容分支，只说明按 events 仍可验证，不代表候选具备 timing 能力，也不触发任何 timing publication/revision。新 key 随主库 backup 转移的属性未在 bundle/import 中单独重测；没有改或测试 summary、perf 合并、淘汰、删除、恢复、并发 writer 或损坏 backup。只运行两个专用测试与相邻 index closure，未跑全仓套件或 typecheck。
- B-workbuddy-observation-manifest-red 只证明一个真实 WorkBuddy home、一个 message、一个冷 source、两条冲突原生时长和一次 observation 改写；当前 verifier 仍接受修改后的 `801ms`，所以这是未来 WorkBuddy observation manifest 契约的预期红，不代表生产已具备该验证。它没有分别覆盖删除 observation、保持主键但替换整行、多 home、多 message、旧式 global duration、bundle/import、revision、eviction、冷热合并、summary、并发 writer 或损坏 candidate；只运行专用文件，未跑全仓套件或 typecheck。
- B-zcode-cold-perf-authority-red 只证明一个 ZCode fixture、一个授权段、一个被临时删除的 cold `small-model` 样本，以及 `zcode`/`tps-v2` marker 形状下的 summary 漏样本反例；当前生产尚未消费 perf authority，所以这是未来显式冷 perf 读取/合并契约的预期红，不是已实现能力回归。它没有授权或测试其他 source kind、多段、多 home、整段 perf 淘汰、重复/缺失 sample、source identity/timing 依赖丢失、bundle/import、并发 writer、自动封存或恢复，也没有断言 marker 与 event authority 的冲突/重复字段校验。`perf_sample_sources` 和 timing 依赖被有意保留，不能从该卡推断它们可删除；热样本与 unplaced 只在本夹具中逐列不变，不代表生产淘汰策略已安全。只运行专用文件，未跑全仓套件或 typecheck。

- B-zcode-cold-perf-carrier-write 只证明一个真实 ZCode fixture、一个显式授权段和 `zcode`/`tps-v2` marker 形状；没有覆盖其他 source kind/method、多段、多 home、冷热跨越 range、无来源身份的 perf-only 样本、自动封存或 authority 切换。冷合并会把该注册段的全部 decoded perf rows 物化后再交给既有统计核心，因此没有分页、流式、子范围读取或内存上限保证；timing dependency/index 数据只由 candidate 四组件验证覆盖，不进入本卡的样本合并或 timing publication。marker 是持久授权证据，文件/候选后来增长时不会自动撤销；missing component、malformed marker 或异常冷包会整体失败，而不是回退 hot-only。测试没有覆盖并发 writer、candidate 文件在 verify/open 间替换、WAL 竞争、bundle/import、淘汰/恢复、HTTP/executor 接线或超大 perf 表；公开 reader 的普通调用仍先查 live registry，只有完整 carrier 的私有路径使用保存点 record。只运行专用 authority/reader 文件与 typecheck，未跑全仓套件。

- B-perf-authority-guards-red 只覆盖一个小 ZCode fixture 下的孤立 perf marker、两个非法 marker 变体和缺 index component；没有覆盖其它 source kind/method、多段、多 home、组件内容篡改、event marker 损坏、bundle/import、并发 writer 或 executor/HTTP 接线。测试 1 清空 rollup day markers 是为了让修复前的 hot-only fallback 可观测，不代表生产查询一定会看到相同总量；测试 3 只按 `createHistoryBackup()` 重建外层包与重新登记摘要，不证明 candidate 内其它 perf 组件仍完整。只运行专用文件与定向 carrier 回归，未跑全仓套件。
- B-perf-authority-fastpath-fix 只改 `summarizeHistory()` 的 authority 探测，没有改 `capturePerfCarrier()`、冷读/合并、schema、authority 写入或 executor/HTTP 路由；`metadataHistory()` 仍只按 event marker 判定，因此“孤立 perf marker + cold metadata”仍是未决边界，若产品需要该组合必须另卡定义。本卡也不证明 perf-only、无 event marker 的合法场景应被支持。按 owner 指令未重跑 typecheck 或全仓套件。
- B-cold-perf-overlap-conflict 只覆盖一个真实 ZCode home/授权段、一个 candidate/live 重叠样本和 `duration_ms` 单字段差异；没有覆盖其它非 key 字段、多个冲突样本、多段、多 home、source kind/method 变化、自动 writer、bundle/import、淘汰、并发 writer 或服务重启。它证明同 key 完整 payload 差异不会被掩盖，以及同一 store 恢复原值后立即回到 oracle；不定义通用冲突修复、选择、持久告警或恢复 API。全 perf parity 仅归一 `indexedAt` 与 `meta.indexedAt` 两个进程时刻，其余字段没有豁免。按 owner 指令只运行新单测与 Biome，未跑 typecheck 或全仓套件。
- B-zcode-perf-multisegment-write 只覆盖两个真实 ZCode 段与现有 single/guard/conflict；不覆盖其它 source kind、重叠段、多 home、bundle/import、并发 writer、服务重启、淘汰或 authority 写入。segment 顺序按 marker 读取，`sample_key` 冲突仍整次失败；duplicate `segmentId` 已拒绝，但没有新增通用排序、去重或恢复 API。
- B-codex-cold-perf-authority-red 只证明一个真实 Codex home/线程、一个 timing-derived cold sample、一条 cold event 和一个 candidate；当前 `codex` marker 在 summary 前以 `HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID` 拒绝，因此这是待实现来源白名单/冷合并行为的预期红，不是现有 Codex 冷 perf 能力的回归。它没有覆盖其它 Codex model/effort、多线程、多 home、多段、重叠或缺失 sample、timing link/evidence 损坏、event 非空的热侧、bundle/import、并发 writer、重启、淘汰或 authority 写入；fixture 没有 unplaced sample，测试只证明非空 hot 全列不变且空 unplaced 全列保持为空。测试追加以 `token_count` 表达的真实 cold usage event，只为满足同段 event authority；该事件不代表 candidate 已具备通用使用量封存契约。完整 perf parity 仅归一 `indexedAt` 与 `meta.indexedAt`。只运行专用单测与 Biome，按 owner 指令未跑 typecheck 或全仓套件。
- B-codex-cold-perf-authority-write 只把 source-kind 集合扩到单值 `zcode`/`codex`，并把每段声明 kind 绑定到该段全部冷 sample；没有实现 mixed-kind 段、多个 kind 的并集授权、authority writer、typed revision、淘汰或热删除。Codex 只覆盖一个真实线程/样本/事件和一个 `tps-v2` 原生 timing 形态；未覆盖无 timing、未知 timing variant、其他 Codex model/effort、多线程、多 home、多段混合 kind、重叠/缺失 sample、bundle/import、并发 writer、重启或服务路由。guard 只证明 codex marker 不接受实际 ZCode 段；反向 zcode marker 对实际 Codex 段由同一逐样本绑定逻辑保证，但没有单独夹具。统计仍物化整段 perf 并复用原统计/冲突实现，没有分页、流式或内存上限；unplaced fixture 仍为空。全仓套件未跑；typecheck、定向 `8/8`、两次 Biome 与 scoped diff check 通过。

- B-codex-cold-perf-transfer 只覆盖一个真实 Codex home/线程、一个 cold `tps-v2` 样本、一套 native request-timing 图、一个 bundle 和一次 import；没有覆盖其它 timing variant、无 timing 样本、其他 model/effort、多样本/多线程/多 home、mixed-kind 段、重叠或 revision overlay、自动热删除、在线 import、重复导入、并发 writer、服务重启或损坏/半写 bundle。可导入结果仍依赖既有 candidate/segment 文件与 manifest/checksum 完整；测试移走的是夹具原路径，不代表生产应删除原归档。导入 runtime 仍需物化完整 events 与 perf 表，没有分页、流式或内存上限，也没有 executor/HTTP/CLI 接线。全仓套件、typecheck 与旧 transfer 测试按 owner 指令未跑。
- B-perf-timing-revision-read 只覆盖一个真实 Codex fixture、一个 cold sample、一个目标 response 和一个 fixed removal 场景；required 集合严格限定为 `completed + codex + request_e2e + explicit`，其他 timing mode、未完成样本和未知 variant 的依赖语义不在本卡。闭包要求该样本每条可达 native response link 都有 effective evidence，仍不校验同一 response 的 variant/origin 数值一致性，也不从 timing evidence 重算 sample payload。没有自动 revision writer、持久 revision 历史、冲突协商、multi-variant 选择、bundle/import revision 转移、并发 writer、恢复 API、淘汰、executor/HTTP/Dashboard 接线或通用依赖框架。候选 timing evidence 与 revision payload 在内存中物化，没有分页或流式上限；测试只运行专用文件与相邻 8 项。
- B-codex-late-timing-revision-write 只覆盖一个真实 Codex home/thread、一个 cold sample、一个 late timing response 和一次外部 metadata commit；没有覆盖多 sample 同时修订、多 segment/home、mixed-kind、多 variant 冲突、bundle/import 后继续修订、重复 late import、进程崩溃或长时并发压力。共享 native evidence 的“一份 payload 只计一次”已在 writer 中收口，但当前 fixture 的自然 response 唯一，未新增共享 evidence 冲突夹具；因此只能声明去重实现正确，不能声明多 sample 冲突选择已验证。输入版本守卫会把捕获窗口内任何外部提交（包括无关 metadata）视为需要重试，这是刻意的保守语义；它不提供自动重试、锁等待策略或诊断历史。来源身份变化走既有 `HISTORY_ARCHIVE_REVISION_INVALID` 并整体回滚，但未新增专门身份迁移错误码或恢复 API。测试只运行专用文件、Biome、typecheck 与 scoped diff check，未跑全仓套件。
- B-codex-revision-rollback 只覆盖一个真实 Codex home/thread、一个冷样本和一次确定性 revision metadata UPDATE 失败。timing evidence import 先独立提交，再运行 sync，因此不证明整个 import+publication 跨事务原子；未覆盖进程崩溃、COMMIT 失败、自动重试/退避、多 home/段、bundle/import 后继续修订或其它失败点。测试内 `DatabaseSync.prototype.prepare` 包装只捕获目标 statement 的具名错误，不是生产诊断或通用事务 hook。
- B-effective-Codex-numeric 只覆盖一个真实 Codex home/thread、一个冷样本、一个 late timing response 和一个 `duration_ms` 数值反例；它证明 effective typed sample 的 duration/request-count 必须与 unchanged native timing 一致，不是通用 revision validator。校验只遍历 Codex request-facts turns，其他未进入 request facts 的样本不由此 effective 分支独立对拍；effective timing evidence 仍按 `(home_id,response_id)` 数组过滤，当前为 O(n*m) 查找，没有索引或分页。`validateStoredEvidence()` 的 export 只供 archive 复用同一 stored-evidence 规则；它不把该 helper 扩展成通用 schema/迁移 API，也不改变 timing store 原有 lookup 行为。测试未覆盖 `request_count` 单独反例、多 variant 冲突、其他 timing variant、多 response、多 sample/home/段、mixed-kind、bundle/import 后继续修订、并发 writer、崩溃恢复、自动 writer 或 executor/HTTP/Dashboard/CLI 接线；合法 `explicit→unknown` 降级只证明该形态不被误拒，不代表所有 unknown/partial timing 语义已定义。只运行四个指定定向文件、Biome lint、typecheck 和 scoped diff check，未跑全仓套件。
- B-codex-required-request-facts 只覆盖一个真实 Codex home/thread、一个冷样本和一个缺失 key 的反例；没有逐行验证 request facts 与样本/原生 timing 的数值一致性（该验证已在 archive 创建/verify 中发生，本卡只强制能力 key 存在），也没有覆盖多段、多 home、mixed-kind、bundle/import 后缺 key、并发 writer、key 损坏或服务接线。`zcode` 不要求该 key，legacy 无 perf authority 时仍只按 events 读取；不能把“key 存在”扩大成“所有 request facts 内容都已重新对拍”。生产 `usage-store.js` 在本卡前像之后已不再冻结，但后续 owner 不得移除 `sourceKind` 传参或把 Codex 检查降成可选。
- B15-commit-prepare 只证明一个真实 Codex candidate、一个候选范围、两条范围内事件、一个相关 source identity 和一次只读 prepare；它不实现 commit、候选登记、authority 选择、hot event 删除、rollup 重建、perf/timing 迁移、自动归档、阈值触发或 CLI/HTTP/executor 接线。plan 中的 `events.id[]` 是 source DB 原生 id，不是跨 backup/import 稳定的身份；`source.databaseFile` 固定本卡只接受持久主库，`:memory:`/无 main.file 会明确拒绝，临时库路径生命周期也由调用方负责。后继 writer 必须在自己的单一写事务中重验同一规范 DB 路径、candidate digest/metadata、完整 source fingerprint、原生 id 集合与 input revision，再按这些 id 删除，不能把本函数返回的 plan 当作提交授权或可长期缓存的令牌。`data_version` 只检测其它连接的提交，`total_changes()` 只覆盖本连接，因此路径绑定是防另一个 DB 使用相同计数的必要事实，但仍不能替代 commit 内的完整重验。保存点内的同步读取保持一致的 SQLite 快照，但 candidate verify 的 `await` 期间发生的外部写入不会被事务跨越，而是通过 source fingerprint 比较拒绝。测试未覆盖 WAL checkpoint、并发 writer 持续提交、candidate 在 verify 与 plan 返回之间被替换、跨进程崩溃、多候选/多段、超大事件集或生产性能；plan 会物化范围内全部 ids、source rows 与两条流式摘要，没有分页/流式返回。只运行专用文件、Biome lint/check、typecheck 与 scoped diff check，未跑全仓套件。
- B15-executor-event-commit 只证明 plan 经既有 worker 串行尾链进入 store writer，并证明一次外部 source mutation 后的拒绝与同 plan 的 commit/replay 顺序；它没有新增 HTTP/CLI 写入口、自动调度、崩溃恢复、跨进程信号、多候选、多来源或长时并发压力证明。plan 仍是普通 JSON，调用方不能把它当成提交授权；CLI 后继卡仍必须重新 prepare/verify。
- B15-cli-explicit-event-commit 是操作者显式指定已生成 candidate 与新 backup 目录的单次命令；不自动选择范围、不创建 candidate、不覆盖既有目录、不切换在线服务，也不证明生产服务停机窗口或备份目录跨卷发布。candidate 或 backup 失败在 executor 打开前拒绝；bundle 发布且独立 verify 后，若 commit 因源漂移失败，代码会保留该已验证的新 bundle，且源事务由既有 store commit 回滚。临时夹具没有单独注入“verify 成功后 commit 失败”的时序；重复 CLI replay 已由专用命令覆盖，但每次仍按不覆盖契约发布新的 backup；命令不会绕过 candidate/backup verify 来规避该成本。
- B15-cli-replay-prepare 只覆盖同一 candidate、同一规范路径、已登记且 event authority 已包含 digest、范围内热 events 已为 0 的精确 replay；非精确登记、未授权、非零热残留与正常 fresh prepare 均不由该分支放宽，仍由原 source-match 或 store replay 校验拒绝。prepare 对 authority 只做本接缝所需的 version/list/contains 检查，完整唯一性、全部段登记关系与 candidate/authority 重验责任仍在 store。每次 CLI replay 仍会先发布并 verify 一个全新的 backup 目录，这是显式不覆盖契约的一部分，不是 no-op 文件系统写；未覆盖 prepare 与 store 之间的并发 authority/registry/event 改动、重复 replay 的清理策略、生产服务停机窗口或跨卷发布。

- B15-ZCode-supported-perf-commit 只移动一个已登记段内全部为 `zcode` / `tps-v2`、四个 component 均可验证且没有 `perf_sample_sources` 级联依赖的 hot perf 样本；mixed-kind、有依赖、部分淘汰、多段/多 home、自动 writer、生产淘汰策略、服务重启、并发 writer、崩溃恢复、bundle/import 与全仓套件均未覆盖。replay 只处理精确登记/授权且 hot perf 已为零的 candidate；任何不同 hot perf 行、authority/registry 漂移或 candidate 变化都继续拒绝，不会静默清理。每次正式 CLI replay 仍发布新的 backup 目录，这不是数据库 no-op；timing、source identities 与 native dependencies 仍留在热侧。测试只运行上述定向文件和四项静态检查。
- B15-Codex-supported-perf-commit 只覆盖一个真实 Codex 线程/home、一个候选段、一组显式 request-timing 图和一个 `AFTER DELETE` 级联失败；不覆盖其它 timing mode、缺 timing 的 Codex 样本、mixed-kind 段、多线程/多 home、多段、重叠、bundle/import、并发 writer、进程崩溃或生产 CLI 接线。它只把 `perf_samples` 与对应 `perf_sample_sources` 从热侧移走，source identities、projection、rollout owner 与 request-timing graph 仍保留；没有通用依赖清理、部分淘汰、自动 writer、authority 切换或恢复 API。legacy candidate 分支只证明缺 `history_archive_codex_requests_v1` 时不会生成 `perfDeletion`，events-only commit/replay 成功且 perf 保持热区，不证明其它缺失 perf component 的组合已分别覆盖。测试只运行两个专用文件与最终静态检查，未跑全仓套件。

## 交接

dashboard-shared-carrier 已按当前根仓交接：event-authority 冷 dashboard 入口与 `filters.now ?? new Date()` 默认时点修复均已存在，专用测试与 `review-functional.json` 已覆盖省略 `now`、完整字段、excludeHomes、缺段拒绝/恢复和 HTTP 130/2；但当前单段不变范围走 `trySqlHistoryDashboard`，测试记录 `calls=0`，旧 artifact 的 `combinedColdReads=1` 不代表当前路径。后续 owner 不要用 `measured-src/usage-store.js`（`9A3DC093…`）覆盖根仓；当前根仓为 `4DE01334…`，executor 为 `F70C9CF8…`，测试为 `AE609E12…`。authority 仍只查 `history_archive_event_authority`，perf-only 必须保留原 summary/metadata/period 三入口；不要扩大冷读取范围。SQL 快路只覆盖单段/all/无 overlay，fallback 仍完整物化 events/perf carrier；`publishedUsageEventsFromUnion()` 已在原数组原地投影，不再有第二份完整事件数组。

history-backup fingerprint sealed candidate 已由 Main 推广并冻结：候选 `EE40EAFA…`，前像 `053FFE26…`，验证脚本 `9C9EDDED…`，窄 patch `04DFBBC1…`；候选推广时的历史根回归为 `13/13`（runner `5467.9969ms`），typecheck/Biome 通过，16 表 fingerprint 等价与 tamper 拒绝均已验证。当前根仓 `src/history-backup.js` 已变为 `4D56EDBB…`，在候选之上另有 stream-hash/verified-evidence 改动；`verified-bytes/review.json` 的 14/14 与 7/7 使用不同期望 hash，只能作为历史 artifact，不能声称当前根仓已重测。`candidate.patch` 是 CRLF，若需重新 apply-check，使用 LF 规范化副本 `EF27137C…`，不要把直接 apply 失败误判成候选不等价。未做性能测量，不能宣称该 `.iterate()` 改动降低延迟或内存；不要修改候选，也不要把它扩展成通用流式 backup 框架。

B19 cold dashboard summary phase 当前是 artifact-only，停在“先测再优化”边界。`output/history-retention-profile-20261026-b19-cold-summary-phase/phase-hook.patch` 可在当前根通过 clean apply-check，用于一次 warm `skipCheck=1` 的六阶段归因；`sessions-key-candidate.patch` 仅是将 session 复合键改为嵌套 Map 的未测候选，尚未推广。后续应先采集 `carrier/events/sessions/summary/metadata/period` trace，确认 sessions 占比，再决定是否评估该候选或转向持久化 summary publication；不要先推 leaf optimization、分页/流式读取或继续改写 carrier 投影。root production、生产 DB、服务与 benchmark 均未由本卡修改或重跑。

B-cold-snapshot-carrier 只改 `src/usage-executor.js` 并新增 `test/history-cold-snapshot-executor.test.js`。executor 在原有单库 `backup()` 后打开该备份，若有 `archive_segments` 则复用 `stageHistoryArchiveSegments()` 把已验证冷段复制到 `<databaseFile>.segments`，只更新备份库 `archive_segments.database_path` 指向私有副本；live registry/authority 未变。metadata 改由同一备份事实上的 `metadataHistory(asOf)` 生成，homes/warnings/tier/catalog 仍按原契约返回；无段时不创建 staging 目录、不返回 `cleanupDirectory`。成功后返回原 `databaseFile`，有冷段时额外返回唯一 `cleanupDirectory` 供 server 淘汰卡清理。失败时 finally 关闭备份句柄，并只删除本次创建的备份库、`-wal`、`-shm` 与 staging 目录；若调用方目标或目录原本存在则不清除。测试 1 在 snapshot 后移走原段，仍从备份冷读 summary 130/2 与 metadata eventCount 2，副本位于 `<databaseFile>.segments/segments` 且 live registry 保持原值；测试 2 原段缺失时 snapshot 以 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND` 拒绝且不留备份/侧车/staging 半成品。新测试 2 pass / 0 fail，runner 5464.8842ms；W1 snapshot 1/1（runner 5289.1792ms）、history-executor-backup 的 snapshot 相关 4/4（runner 5668.7909ms）；typecheck、Biome 与 `git diff --check` 通过（后者仅既有 `public/index.html` CRLF 提示）。本卡未接 server，HTTP freeze 红测仍应保持失败；下一卡需消费 `cleanupDirectory`、清理快照侧车并决定淘汰时删除 staging，server/snapshot 路由本卡未改。

B-cold-freeze-counterexample 仅新增 `test/history-cold-freeze-api.test.js` 并保留红测。真实 cold 100 + hot 30、来源仍在的夹具请求 `GET /api/summary?preset=all&calendarZone=utc&freeze=1`；首断言期望未归档 oracle 的 `summary.total/eventCount` 130/2、`metadata.eventCount` 2、`periodComparison.totals.all.total` 130，实际为 30/1、1、30。失败接点：`src/server.js` 的 freeze 分支用 `store.summarize(filters)`、冻结时保存的 `frozen.metadata` 和 `store.periodComparison(...)`，其中 `frozen.metadata` 来自 `src/usage-executor.js` snapshot 分支的同步 `store.metadata(asOf)`；备份只含 SQLite 热事实，没有冷段载体或独立冷段副本。因为首断言已失败，后续 snapshotId 读取与移走冷段后的快照独立性断言未执行；修复需另卡授权，不能把本测试改成接受 30/0。命令 `node --test --test-concurrency=1 test/history-cold-freeze-api.test.js`：0 pass / 1 fail，runner 5337.9083ms；Biome 通过，`git diff --check` 通过（仅既有 `public/index.html` CRLF 提示）。

B-cold-dashboard-API 仅新增 `test/history-cold-dashboard-api.test.js`，没有改 server/store/executor/public。夹具由真实 Codex rollout 产生 cold 100 + hot 30，归档后热表只留 30，但来源文件仍在；`/api/summary?preset=all&calendarZone=utc` 与非 `detail=full` 的 `/api/usage?preset=all&calendarZone=utc` 均返回 summary 总量 130 / 2 events / 1 session / 1 home、metadata 同计数与 `modelLastSeen`、period `all` 130，并与未归档 oracle 的关键字段深等。删除授权段后两条路由都整体返回 HTTP 500 / `ENOENT`，响应中没有 summary、metadata 或 periodComparison，而不是发布 hot-only 30 或空结果。命令 `node --test --test-concurrency=1 test/history-cold-dashboard-api.test.js`：2 pass / 0 fail，runner 5595.1889ms；`npx.cmd biome check test/history-cold-dashboard-api.test.js` 与 `git diff --check` 通过（后者仅既有 `public/index.html` CRLF 提示）。本卡未覆盖 `detail=full`、freeze/snapshot、import、perf 或生产服务；两个默认聚合路由复用已接线的 executor dashboard，cold metadata/summary/period 仍会物化完整历史，未新增分页、缓存或性能能力。

B1b-E2 的 `history_replaced_facts` 定义保持在 schema 20；B3-schema 按后继卡片明确把整体版本抬到 21，新增空 `archive_segments`，没有改变旧表，B-retention-schema21-contract 已把 retention 文件内两条 v20 固定断言收口到精确 v21 及 12/7 列契约。B1c-E 已补恢复行插入后的真实回滚证据；B1b-Q 已补当前路径 quota，B1b-S-E 已补 sibling events，B1b-S-Q 已补 sibling quota，B1b-P 已补非 Codex 样本与依赖，B1b-C-P 已补 Codex 线程发布样本与依赖，B1d-growth 已补 100 次普通追加的增长断言，B1-truncation-oracle 先复现稳定 2→1 截断无诊断，B1-truncation-diagnostic 再补成功提交后的 project-log 缩短 warning、回滚不误报、普通追加/同内容重解析不误报与恢复事实不膨胀，B1-truncation-persist 把成功截断 marker 写入现有 `perf_file_warnings`，并由后续 sync 从已提交 sidecar 重建，B1-badline-oracle 先固化坏行被静默跳过的反例，B1-badline-warning 在 project-log parser 回调中发布“路径 + 行号、不含内容”的当前轮 warning，并由 store 在成功提交后发布；B1-badline-persist 再复用同一回调的第二个结构化 `{lineNumber}` 参数和 `perf_file_warnings` sidecar，保存 `PROJECT_LOG_MALFORMED_JSONL` marker，使 no-op/重开可见，并在全合法成功重解析时清除，同时独立保留截断 marker，B1-timing-audit 已确认 request timing 的 evidence/link 本身 append-only，因此没有叠加重复 ledger；B1-workbuddy-evidence 已确认 WorkBuddy observation 为 append-only，异值冲突只停采样，不丢旧观察。I1 系列已完成 UTC/local 整日选路、同步维护和跨进程 zone reopen 的定向证据；local 日界身份只写在 `store_meta`，没有新增 local dirty 队列。

本卡对 `src/usage-core.js` 的唯一改动是在既有 project-log callback 消息后附带 `{lineNumber}` 第二参数；不改其他 reader 或解析行为。该接点完成后 core 所有权归还主审。

B-C2-public-model-read 只交付失败反例与测试 oracle，没有修改生产读取路径；B-C2-clamp-scoped-window 随后只在精确模型接点把每个 period 与 scoped facts 求交，完全不相交的 period 直接输出零字段并跳过 rollup 查询，事实范围内完整日仍按 marker 读取/缺日回退，公开反例因此转绿。没有补空 marker、删除 `today`、放宽 `modelPeriodAggregateQueries === 0`，也没有把冷段、恢复事实或未授权来源并入模型读取。内部无事件 gap 仍是明确 fallback 边界。

B3-cold-reparse-prefix 只处理“显式 authority 覆盖的来源再次完整解析”这一条写入接点：在替换事务内用现有冷快照 reader 验证授权段，按完整 canonical payload 多重集比较冷范围，匹配的冷前缀不写 hot，任何差异让该文件整笔回滚；无 authority 路径不改。它没有建立跨冷修订协议、没有把归档日期变成全局跳过条件，也没有新增热淘汰、authority 切换或 schema。后续若要支持冷范围局部修订，必须另立卡片并定义权威切换/证据语义，不能放宽本卡的完全相等检查。

B3-cold-published-oracle 已把下一处缺口钉在公开读取：存储合并能得到 130，但 `publishedUsageEvents()` 和 `periodComparison()` 仍只返回 hot 30。后续生产卡必须复用同一真实 100-cold/30-hot 夹具，在不改变 `sync()` 写入语义的前提下决定冷段如何进入两个公开入口；测试只做了完整对象对拍和最小 `periodComparison` 调用，没有授权任何缓存、异步接口或 Dashboard 大接线。

B3-carrier-snapshot 已把第一个明确的冷热完整 events 入口收紧为单次 bounds/hot/registry/authority/source 捕获，但不替换旧同步入口。现有同步 `publishedUsageEvents()` 的调用点是 `src/usage-store.js` 内 `publishedUsageSessions()` / `publishedUsageReport()`、`src/usage-executor.js:301` 的 worker dispatch 和 `:552` 的 client wrapper，以及 `test/history-published-events.test.js` / `test/history-executor-backup.test.js` / `test/history-archive-store.test.js`。下一张 executor 卡应只在 worker 增加 `publishedHistoryUsageEvents` 消息并 `await store.publishedHistoryUsageEvents()`，client 增加同名 Promise wrapper，保持原同步消息和方法不变；随后再由独立卡决定 summary/period 的冷热读取，不把本次 carrier 当成 Dashboard 或 period 接线完成。

B3-cold-report-carrier 已提供异步完整 `publishedHistoryUsageReport()`，其四键形状与同步报告一致，但 events 含冷段、homes/quota 在释放保存点前捕获、sessions 从同批 events 派生。它没有接到 executor/API/Dashboard，也没有改变同步 `publishedUsageReport()`；下一张接线卡应在 worker 增加异步 report 消息和 client Promise wrapper，并明确何时选择 async cold-aware report，不能直接把同步调用点替换成未 await 的 Promise。summary/period/rollup 仍只读 hot facts，需另卡处理。

B3-cold-period / B3-period-authority-snapshot 已提供显式异步 `periodComparisonHistory()`，并把无 authority 的 marker 与首次 period SQL 固定在同一读快照；有 authority 时短保存点先释放，再由 carrier 建立自己的完整历史快照。它仍不是全局 period 切换：没有接到 executor、API、Dashboard 或 summary 调用点，同步 `periodComparison()` 及同步缓存继续只读 hot facts。下一张接线卡必须显式选择 async 冷感知入口并 await，不能把同步调用点直接替换成 Promise；summary/rollup 仍只读 hot facts，需另卡处理。

B-cold-summary 已提供显式异步 `UsageStore#summarizeHistory(filters, options)`。无 authority 时 marker 与 `summarizeInReadTransaction()` 在同一 `SAVEPOINT summary_history_read` 内，内部 `summarySnapshotRead` 只抑制该调用链的嵌套外部修订探测，原同步 `summarize()`、缓存和返回形状不变；有 authority 时释放短快照后取完整 report，用现有 `withoutExcludedHomes()` 过滤再调用共享 `summarizeUsage()`。真实 `100 cold + 30 hot` 的共享 usage 字段、UTC/exclude 与 `includeDetails:false` 都已对拍，缺段整体拒绝；外连接在 marker 后提交 authority/删热/改 quota 的确定性交错证明首次仍为旧快照、后续同步读才失效。`summary.perf` 和 store-only `records` 仍缺完整冷载体，后续 owner 必须另卡决定 perf 分区与 records 聚合，不能把本入口宣称为与 `store.summarize()` 全字段相同。executor/server/Dashboard/CLI 尚未接线；接线时必须显式 await async 入口，并保留同步热路径。

B-cold-summary-records 已让带 authority 的 `summarizeHistory()` 对普通 `preset` 返回与未归档 `store.summarize()` 相同的 records。实现只抽出了 `usage-store.js` 内原有槽位累加/排名 helper，未新增通用 materializer；SQL 路径仍优先用持久 local keys，冷路径按 timestamp 用同一 local/UTC helper 派生，最后复用原 `recordsWithinRange()`。`preset=all` 返回 `{}`；配额窗口 records、executor/server/Dashboard/CLI 接线仍未完成。

B-cold-perf-capture 已让带 authority 的 `summarizeHistory()` 生成与未归档 oracle 深相等的 `summary.perf`。perf state/samples/identities/sources 在与 usage carrier 同一个同步保存点内捕获，冷读取结束后的第二次调用才会看到外连接新提交；最终 perf 范围取完整冷热 events 的摘要范围，而不是 hot bounds。perf 样本仍只来自 hot facts，不读取或淘汰冷 perf 文件。executor/server/Dashboard/CLI 尚未接线，同步 `summarize()` 也仍是 hot-only；下一张接线卡必须显式 await async 入口并保留同步路径。

B-rollup-complete-events-seam 已把现有 daily rollup 重建算法接到“显式完整 events”接缝：模块只负责把一个 UTC 日的 carrier events 写入临时源并复用原有 SQL，不修改 store 的 authority/事务/缺段处理，也不复制冷事件到 hot `events`。下一张接线卡必须负责从已发布完整载体取 events、在 store 层决定发布事务与缺失段时保留旧 rollup 的语义，并串行化固定 TEMP 表调用；本卡未接 store、executor、server 或 Dashboard，也未覆盖 local 日和多个 day。

B-store-cold-rollup-day 已补上单 UTC 日的 store 发布入口：`rebuildHistoryRollupDay(day)` 用 `BEGIN IMMEDIATE` 把完整权威冷热捕获、验证与 rollup 重建放入同一发布边界，成功才推进既有修订并清缓存，失败保留原四表。下一张若接 sync、executor 或 server，必须明确调用时机和缺段失败策略，不能把普通同步热路径隐式替换；local、多日批量、流式/分页事件读取与固定 TEMP 表的并发隔离仍未处理。

B-cold-rollup-writer-lock 现已用真实第二连接证明：事务内写者被 SQLite 锁定拒绝且无提交，事务结束后的同一更新成功进入下一次 carrier 与重建。若后续要求真实并发压力、长 busy_timeout 行为或多语句 writer 回滚，应另立卡，不要从本单窗口测试外推完整并发安全。

B-rollup-multi-UTC 已让冻结模块入口接受一次多日重建；B-store-full-UTC-rebuild 随后在 `UsageStore#rebuildHistoryRollups()` 内取一次完整 carrier，按 UTC 首末事件补齐中间空日并合并既有派生日期，再调用同一模块一次完成整批发布。单日公开方法仍只传 `[day]`，两个入口共享同一事务边界。若后续需要任意日集合的 store 入口，应另立卡片并明确日期契约；local、分页/流式 events 与 sync/executor/server 接线仍未处理。

B-rollup-complete-local-seam 已给同一完整载体模块入口补上 `calendarZone:'local'`，默认 `utc` 不变并直接复用原日界/SQL。下一张若做事务性双 zone，应在 store 的同一 `BEGIN IMMEDIATE` 内先校验当前 local zone identity，再分别把 UTC/local day 数组交给同一批次模块，最后一起提交并推进一次修订；不能在本卡基础上假定 stale local 清理或双 zone 原子性已经完成。

B-store-full-dual-zone 已把全历史 store 入口接成同一事务内的 UTC/local 双 zone 发布：一次完整 carrier、两个批次、一次修订；local 日期由首末事件覆盖并 union 四表旧日期，zone identity 随成功提交更新。专用纽约 DST 夹具已覆盖四表 oracle、单次 union、local 批次失败回滚 UTC 哨兵以及缺段拒绝。后续若接普通 sync、executor/server 或生产重建调度，必须明确何时触发全历史双 zone 重建；不能把单日 UTC 方法或普通同步局部 rollup 维护误当成该入口。

B-executor-history-rebuild 已把该 store 入口接到既有执行器串行尾链：worker 消息 `rebuildHistoryRollups` 只 await `store.rebuildHistoryRollups()`，成功后重新发布状态并返回 `{rebuilt:true}`；client 暴露同名 Promise 方法，固定消息集与同步/备份/快照共享尾链均未另建队列。专用真实夹具把 cold 100 + hot 30 登记/授权为一段，正常 sync 生成未归档 oracle 后删除 live 四张 rollup 表；执行器重建结果由第二只读连接与 oracle 全表对拍，facts 不变。夹具把热事件放在 `2026-07-13T23:01:00.000Z`，使普通 sync 的 UTC 日展开与全历史入口按首末本地日裁切得到相同 local 日集合，避免把相邻空 local 日差异误判为重建错误。移走候选段后重建以 `ENOENT` 拒绝且四表保持上次成功快照；恢复候选段后 `historyArchives()` 仍可用，cold-aware `summarize()` 返回 130/2。本卡没有增加普通 sync/HTTP/CLI 触发，也没有修改 store、server、public 或 archive 生产文件。

B-cold-rollup-sync-regression 用同一真实来源完成两阶段验证：cold 100 + hot 30 登记授权后，先显式 `rebuildHistoryRollups()` 并与未归档 oracle 130 的 UTC/local 四表全等；再把同一 UTC 日的热 turn 从累计 130/增量 30 改为 140/增量 40，经真实 source 重解析与普通 `sync()`。最终 hot `events` 只有 `[40]`，但四表比较出现 5 个差异：`utc.usage_rollup_daily` 实际 `event_count=1,total=40,input=40,output=0`，期望 `2,140,120,20`；`utc.usage_rollup_models` 同样为 `40/40/0` 对 `140/120/20`；`local.usage_rollup_daily` 实际只有 7 月 13 日 hot `40`，期望 7 月 12 日 cold `100` 加 7 月 13 日 hot `40`；`local.usage_rollup_models` 同样缺 7 月 12 日 cold 行；`local.usage_rollup_sessions` 实际只有 7 月 13 日，期望 7 月 12/13 两行。`utc.usage_rollup_sessions`、`utc.usage_rollup_days`、`local.usage_rollup_days` 与 oracle 相等。该证据把问题钉在普通 sync 的 dirty-day 重建：它覆盖了先前正确写入的冷热 rollup，而 cold-aware summary 仍能全量回退到 140，不能作为四表正确性的证据。

B-cold-rollup-sync-fix 在轮末只对“存在非空授权段且确有 dirty day 或 local zone 变化”的调用改走完整历史：`BEGIN IMMEDIATE` 后重新读取 dirty 队列，await `publishedHistoryUsageEvents()` 保持写锁跨冷段验证，UTC 只以 `rebuildUsageRollupsFromEvents(roundDirtyDays, events)` 重建原 dirty 日；local 以这些 UTC 日对应的 local 日为目标，zone 变化时再从完整 events 派生冷/热日期并 union 旧 local day key。UTC/local 任一失败都在同一外层事务 `ROLLBACK`，dirty 因此保留；成功后一次 `COMMIT` 才写 zone identity。无授权段时仍执行原 hot `rebuildUsageRollups()` savepoint 快路，没有每轮全历史重建。验证新增第三阶段：热尾从 140/40 再改为 150/50，并在事实提交后、轮末完整 union 前移走候选段；`sync()` 以 `ENOENT` 拒绝，hot facts 已提交为 50，三张聚合表仍为先前 140，dirty 仍为 `2026-07-12`，day markers 已因已提交 event trigger 失效。恢复候选段后无需重解析源文件，下一轮仅凭残留 dirty 重建出与未归档 oracle 150 完全相等的 UTC/local 四表并清空 dirty。该测试没有把缺段失败误报为整个 sync 原子，也没有用 summary 全量 fallback 代替 rollup 表证据。

B-cold-rollup-sync-local-rollback 已补上 UTC 批次完成后的 local 写入失败证据：测试本地 trigger 只在 UTC `2026-07-12` daily total 为 `150` 时拒绝同日 local 插入，`sync()` 拒绝后已提交 hot facts 为 `50`，UTC/local 三张聚合表仍为旧 `140`，dirty 保留 `2026-07-12`。移除 trigger 后下一轮直接重试到未归档 oracle `150` 并清空 dirty，既有缺段阶段再恢复到 `160`。该证据不把 `usage_rollup_days` 或已提交 facts 纳入回滚断言，也不宣称整个 `sync()` 原子；后续若要求全表（含 day markers）回滚、多个 local 失败位点或并发/崩溃恢复，应另立卡片。

B-cold-rollup-sync-zone-change 已按已验证的 module marker 契约返修测试：旧 `Asia/Shanghai` 的普通 sync 将 `2026-07-12T23:30Z/23:50Z` 两事件聚合到 local `2026-07-13` 的 130；改用 `America/Los_Angeles` 后源文件无变化、`updatedFileCount=0`，普通 sync 将 local `2026-07-12` 重建为 130 并清除三张旧日 aggregate。额外的 `2026-07-13` marker 是洛杉矶日界下已构建空日：在 oracle 上用既有 `rebuildUsageRollups()` 补建后，两边 `queryUsageRollups()` 返回相同零事件/零 token/零 session 日。初红只是四表物理布局预期过严，不是生产缺陷；生产代码未改。

B-period-executor 已把独立 `periodComparison` 消息接到 `store.periodComparisonHistory()`，dashboard 则接到同一 `publishedStore || store` reader 的 `periodComparisonHistory()`，并保留 summary/metadata 与原有串行队列。真实 `100 cold + 30 hot` 专用测试证明两个入口的 month/all 均为 130；删除候选段后两个入口都以 `ENOENT` 拒绝。外部 writer 已提交 hot/authority 变更的 preload gate 证明 dashboard 的 summary 与 period 都保持旧发布版本 130/130，独立 period 读 hot-only 230，释放后才同时更新到 230/230。summary/metadata 接 async 冷路径仍由后继卡处理；没有修改 server/public/history-archive 文件，也没有生产运行。

B-summary-executor 已把独立 `summarize` 消息与 dashboard summary 接到 `summarizeHistory()`；dashboard 的 summary 与 period 现在共用同一 `publishedStore || store` reader，并在同一请求内 await 两个异步入口。B-cold-metadata 已提供 store-only `metadataHistory(asOf)`：有 authority 的 cold+hot metadata 与未归档 oracle 全字段对拍，无 authority 保留原同步 metadata 快路，缺段拒绝；executor 的 `metadata` 消息仍保持同步热读，下一张接线卡需显式 await 新入口并处理发布 reader 的 metadata 版本语义。专用真实夹具验证冷 100 + 热 30 的总量为 130，summary 的 `perf`、非配额 `records` 与未归档 oracle 深相等，缺候选段时 summary 与 dashboard 都以 `ENOENT` 拒绝；相邻 period fixture 另用子进程 preload gate 覆盖外部 writer 已提交后的 pinned 130 与释放后 230。`metadata` 仍为同步热读，server/public/Dashboard 客户端、配额窗口 records、冷 perf 文件与完整生产服务仍未接线或验证；冷 summary 全量物化 events/perf，没有流式、分页或结果缓存。

B-cold-summary-sync-seam 已为下一张 server 接线卡提供同步尾段：server 应先 await `publishedHistoryUsageReport({ includePerfCarrier:true })`，再在现有 catalog `try/finally` 内调用 `summarizeHistoryReport()`，避免 await 期间临时全局 pricing 泄漏；本次没有修改 server/public，也没有新增 HTTP 行为。现有 `publishedHistoryUsageReport()` 在 `archive_segments` 有行时仍会复制段，即使没有 authority；这是既有快照载体边界，不能从本卡推断 authority 选择已收紧。

B-cold-freeze-pricing 已用真实 cold HTTP freeze/snapshot 证明 A 目录的 summary 费用与 `/api/pricing` version 不会在 live 切到 B 后漂移，并证明同步冷摘要抛错时 `finally` 仍恢复 live B。生产文件未改，server 所有权仍归主审；下一张若扩展并发/多段 pricing 覆盖，应新建独立 fixture，不要把本卡的单段 prototype 注入当作完整 server 并发验收。

B-cold-hot-tail-revision 已用独立真实夹具证明：冷前缀与候选包不变时，热尾累计可以从 130 降为 120，冷热合成结果为 120；旧热 30 进入 `history_replaced_facts`，重复同样重解析不增加事实。生产代码未改，也没有把该行为扩展为冷段修订协议；后续若需冷段内改值、删除或替换，必须另立卡片定义 authority/证据语义。

B-cold-prefix-revision-red 已把该后继缺口钉在冷前缀修订：同一 source 的冷累计 100 改为 90 时，`replaceFile()` 的精确多重集检查在 `src/usage-store.js:5054` 拒绝整笔替换，sync 以既有 warning 保留原候选，公开历史仍为 `[100, 30]`，而未归档 oracle 已是 `[90, 30]`。旧的不可变候选 digest 未变并可恢复其 100，说明问题不是证据丢失，而是没有“新修订是否取代旧候选”的事务/权威语义；下一 owner 应先定义 supersession 契约、替换/保留证据和失败可见性，不应直接把冷前缀比较放宽到 count 或 payload 子集，也不应实现新的全历史快照。

B-cold-revision-overlay-read 已让上述 100→90 的单 source delta 通过手工提交 `store_meta.history_archive_event_revisions` 被完整与范围读共同应用，结果为 `[90, 30]`，同时 hot facts 和原候选 digest 不变；错误 removed 份数、source binding、payload 数值/文本类型与 payload home binding 都会明确失败，JSON 字段顺序不同的同值 source identity 不会被误拒绝。后续 writer 卡应在同一 `replaceFile()` 事务内生成当前累计 delta、把被替换旧 payload 写入既有 `history_replaced_facts`，并定义重复修订如何覆盖而不是追加；reparse、writer、恢复、revision 移植和 backup/import 均未在本卡实现。

B-cold-prefix-revision-write 已把该 writer 接进真实 `replaceFile()`：immutable/effective/observed 一一对应时，第一次 `100→90` 成功，第二次 `90→80` 原地覆盖为相对 immutable 的 `100→80`，并将上一 effective `90` 写入 `history_replaced_facts`。两次真实 `sync()` 后 public events 分别为 `[90, 30]` / `[80, 30]`，summary 为 120 / 110，hot `events` 始终只有 `[30]`，candidate digest 不变；no-op 重解析不重写 revision 或证据，UTC/local rollup 都刷新到 110。本卡没有新增 schema、authority/API、全历史快照或恢复入口；冷新增/删除、迁移、多段、并发和跨日 rollup 仍由后继卡处理。

B-cold-prefix-revision-rollback 已在同一夹具证明 revision writer 的失败边界：metadata trigger 在 hot 50 已重建、旧冷 90 已暂存后被拒绝时，revision bytes、hot/cold facts、恢复证据、dirty 队列、三张 aggregate 表、公开 union 与 summary 全部保持失败前的 90+30/120；`sync()` 只发布一次精确 `无法索引 ... INJECTED_COLD_REVISION_META_FAILURE`。删除 trigger 后无需再次 invalidate，普通 `sync()` 用回滚恢复的失效指纹重试为 cold 80 + hot 50，summary/rollup 130，并将旧冷 90 与旧热 30 各保留一次。生产代码仍冻结；已由主审独立接受（宿主专用 1/1，323.8271ms；runner 400.5888ms）。该证据不覆盖 reader/校验/COMMIT 后/rollup/崩溃窗口，也不表示完整 `sync()` 已原子化。

B-cold-prefix-late-add 已把冷段身份门禁从“集合必须完全相等”收窄为“不得移除原/effective identity，observed 可以纯追加”：真实 append 产生相对 immutable candidate 的单个 `+20` delta，完整事实与 oracle 为 `100/20/30=150`，原候选 `100` 不被复制，hot 仍仅 30，新增 identity 不进入恢复表且 UTC/local 汇总刷新到 150。生产改动只在既有 revision helper；已由主审接受（独立宿主 2/2，427.8352ms），删除、迁移、重复身份和多次追加未由本卡扩展。

**B-cold-revision-bundle-transfer** 只新增真实行为测试，生产文件未改。夹具先形成已授权冷段 `02:00=100`、热尾 `02:01=30`，再通过两次真实 source 重解析把冷值修订为 `90`、`80`，热尾保持 30。最终 revision metadata 仍以 immutable candidate 为基线，表示为 removed `100` / added `80`；被上一 effective 取代的冷 `90` 在 `history_replaced_facts` 中恰好保留一次，payload 与 `occurrence_count=1` 原样存在。随后经既有 `publishHistoryArchiveBundle()` 与 `publishHistoryArchiveImport()` 生成离线 import，删除原 Codex source、原 candidate database 与 manifest 后再由 `loadHistoryArchiveImport()` 打开。导入 runtime 的公开冷热 events 为 `[80, 30]` 并与同步到同一最终 source 的未归档 oracle 深相等，summary totals 同为 110；导入后的 revision metadata 字节与原件完全相等，恢复事实逐行相等。bundle 内冻结段 digest 仍等于原 candidate digest，段库仍保留 immutable `100`，证明读取不依赖已被删除的原始段路径。没有新增 schema、authority、API、缓存、复制算法或第二套 overlay。

**B-cold-prefix-removal-red** 只新增真实行为测试，生产文件未改。夹具使用一个真实 project-log source，冷区依次包含 `02:00:00=20`（`removed-session`）与 `02:00:30=100`（`retained-session`），热尾为 `02:01:00=30`；登记并授权只覆盖前两条的 candidate 后，热表只保留 30，完整公开结果为 `[20, 100, 30]`。随后稳定重写同一合法 JSONL，仅删除第一条冷行，保留其后的冷 100 与热尾 30，因此不是尾部截短。当前普通 `sync()` 不抛错，但发布一次 `无法索引 <path>: reparsed source removes or migrates cold events in authorized segment <id>`；事务回滚后公开 events 仍为 `[20, 100, 30]`、summary 仍为 150，而未归档 oracle 已为 `[100, 30]` / 130。热 `events` 仍只有 `[30]`，原 candidate digest 未变且不可变段仍为 `[20, 100]`，同时 revision metadata 与 `history_replaced_facts` 都为空；目标状态应记录 removed `20` 且保留一次 20 的恢复事实。失败接点是 `historyArchiveColdRevisionForRows()` 对“effective identity 在 observed 中缺失”的统一拒绝，发生在 revision writer 与恢复证据写入之前。production 继续冻结；若要支持该合法中间删除，必须先裁定“冷身份缺失”与“删除/迁移攻击面”的契约，并同时处理 project-log 现有按文件缩短+事件数下降识别的 truncation diagnostic，因为该启发式不能仅凭输入区分中间删除与尾部截断。

**B-cold-prefix-removal-write** 对 `historyArchiveColdRevisionForRows()` 做两处收口：移除已过时的“original identity 必须全部仍存在于 effective”检查，因为累计 `removed` 可以合法覆盖首次删除；同时只允许 `sourceIdentity.kind === "project-log"` 的纯删除，其他 kind 保持原拒绝，避免 facts 被删除却没有来源专属诊断。observed 仍必须非空，混合新增/删除和跨 timestamp/session 迁移继续以 `HISTORY_ARCHIVE_COLD_REPARSE_CHANGED` 拒绝。真实 project-log 夹具从公开 `[20, 100, 30]` 只删除中间冷 20 后，普通 `sync()` 成功得到 `[100, 30]` / 130，并与未归档 oracle 深相等；revision 记录 removed `20×1`，`history_replaced_facts` 为空，因为原冷 20 的恢复证据仍是 immutable segment。主审返修新增真实 invalidate 后同内容重解析：修复前 `updatedFileCount=0` 并多出旧 guard warning；修复后 `updatedFileCount=1`、当前仍为 `[100, 30]` / 130、revision bytes 稳定、sidecar 仍只有一条 `PROJECT_LOG_TRUNCATED count=1`，不重复膨胀。另一个真实 Codex 删除反例仍被拒绝，公开保持 `[20, 100, 30]`，且不产生 project-log 警告。该诊断只表示“观测到 project-log 冷事件减少”，不区分合法删除与意外截断；若已有 overlay 的 effective row 消失，则继续通过既有恢复事实接缝保留该旧 effective payload。

B-cold-snapshot-cleanup 的淘汰与正常关闭行为已由主审接受；创建后失败证据已改为测试本地 `UsageStore.prototype.open` 一次性 patch，确认新快照主库与 `.segments` 已落盘后再注入明确异常，随后验证主库/WAL/SHM/段副本删除且旧快照仍为 130，待主审复核。server 仍由主审冻结，文件锁不进入返修；本卡整体不宣称完整验收，进程崩溃、强制终止与并发 freeze 限制保留。当前测试已证明 freeze 冷 summary/period、缺段拒绝、第 9 次淘汰无残留、创建后失败保留旧快照与 close 删除含侧车目录，不要回退到 hot-only 30。

B-cold-prefix-removal-write 返修后已覆盖真实中间冷删除及同内容强制重解析：project-log 删除 `20` 后发布 `[100, 30]` / 130，revision 记录 `removed 20×1`，immutable 冷段/hot facts/candidate digest 不变；invalidate 后同内容 reparse 能完成 `updatedFileCount=1`，meta 字节稳定，sidecar 仍只有一条 `PROJECT_LOG_TRUNCATED count=1`。纯删除现只对 project-log 开放，Codex 同类删除仍被拒绝且不产生错误来源警告；任何同时新增/删除、全部消失或身份迁移仍拒绝。下一 owner 不应把该门禁扩成通用迁移协议；若需要非 project-log 删除、区分合法删除与尾部截断、恢复入口、自动清 marker 或连续删除语义，应另立卡片。

**B-cold-removal-rollback** 用同一真实 project-log 夹具补上冷删除的失败边界：baseline 为公开 `[20, 100, 30]` / 150，冷段 `[20, 100]`、热事实 `[30]`。在 revision metadata 已暂存后，测试 trigger 拒绝 `perf_file_warnings` 的 UPDATE；`sync()` 只发布一次精确 `INJECTED_COLD_REMOVAL_MARKER_FAILURE`，随后 revision bytes、hot/recovery facts、persistent warnings、dirty days、三张 aggregate 表、公开 union、summary、immutable segment 与 candidate digest 全部保持 baseline。删除 trigger 后无需再次 invalidate，普通 `sync()` 重试为公开 `[100, 40]` / 140、热 `[40]`、旧热 30 恢复事实、removed cold 20 revision、`PROJECT_LOG_TRUNCATED count=1`，immutable 冷段仍为 `[20, 100]` 且 digest 不变；UTC rollup 为 2 事件 / 140。本卡生产文件冻结，新增测试独立 3/3（591.9342ms），相邻 cold-prefix 5/5（1317.1345ms），只证明该接点上的替换事务回滚，不宣称完整 `sync()` 原子化或通用警告/revision 框架。

`B-cold-prefix-removal-write` 返修后已由主审独立接受（专用 4/4，463.4824ms；返修前 forced-reparse 红测 0/1，263.0951ms；runner 340.9868ms）。`B-cold-removal-rollback` 已实现并通过定向测试，待主审复核；executor、HTTP/CLI、恢复入口、连续删除与自动清 marker 仍未接线。

**B-cold-perf-eviction-red** 只新增真实行为测试，生产文件未改。测试先让未归档 oracle 与带 authority 的 archived store 都同步同一 ZCode fixture；cold candidate 覆盖 `small-1` 所在冷范围，随后只删除 archived 主库的 cold `small-1` 行，保留 hot `ranked-0` 与所有 timing 依赖表。`summarizeHistory({preset:"all"})` 当前返回 archived coverage `eligible=33/sampled=29`，而 oracle 为 `34/30`；cold `small-model` 当前为 `n=4`、`p10=2`、`averageTps=3.857142857142857`，oracle 为 `n=5`、`p10=1`、`averageTps=3.6666666666666665`；hot `ranked-model` 两边都是 `n=25`、`averageTps=224`，证明淘汰边界只命中了冷样本。归档段读取 `segmentAfter` 与 `segmentBefore` 完全相等，原始冷事件 payload 仍保留。失败接点明确在 `src/usage-store.js`：`capturePerfCarrier()` 的 `perfCandidatesForRange()` 只查询 live `perf_samples`，`buildPerfSummaryForRange()` 只接收该 carrier；当前没有从冷段/归档包读取 perf 的接口。测试为预期红：`1` 项、`0` 通过、`1` 失败，`256.509ms`，runner `328.22ms`；Biome 通过。没有新增生产淘汰、迁移、恢复或服务接线。

**B-cold-perf-read** 补齐上述读取缺口的最小接缝。没有新建 perf 归档文件，也没有复制统计或范围算法：`createHistoryArchiveCandidate()` 的整库 backup 已经保留 `perf_samples`，reader 只沿既有 registry + `verifyHistoryArchiveCandidate()` + read-only transaction 路径读取注册的 cold 区间。真实 ZCode 冷/热夹具中，candidate 同时含冷 `small-*` 与热 `ranked-*` perf 行；查询结果与候选 SQL 的 cold 行逐字段深相等，所有返回 `tsMs` 都在 `[coldStartMs, HOT_START_MS)` 内，热 perf 不进入结果。候选文件 SHA-256 读取前后不变，未登记 segment 以 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND` 拒绝。该卡只提供单段只读证据，不把 cold samples 合入 `summary.perf`，也不改变 authority、淘汰、timing 依赖或 live carrier 语义。下一 owner 才应把该 reader 接入 perf carrier 的 cold 合并与 summary 统计，并同时裁定冷热重复样本、missing source 和 timing 依赖的合并契约。

**B-perf-reader-missing-file** 只扩展现有真实测试，生产源码冻结。已登记候选先成功读出全部 cold perf 行；测试随后仅把 registry 指向的候选数据库文件改名为同目录临时文件，保留 registry row 与相邻 manifest，再以同一 segment id 调用 reader。既有 `verifyHistoryArchiveCandidate()` 在读取数据库 bytes 时实际以 `ENOENT` 拒绝，调用没有落到 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND`，也没有返回 `[]`。`finally` 把原文件移回后，同一 `UsageStore` 无需重登或重启即可再次读取，恢复结果与第一次 decoded rows 逐字段深相等，候选 SHA-256 仍等于缺失前值。该证据只说明已登记文件短暂不可用会响亮失败且同路径恢复可重试；没有修改 reader、archive verifier、service、schema 或持久状态。

主审需要决定 `missingSources` 在 `summary.perf` 的公开形状，并保持 `kind` 的“原始来源身份”语义或在公共层新增规范 perf kind，避免两个语义混用。新增 `perf_missing_sources` 只表达当前可用性，不应作为事实快照；`history_replaced_facts` 才是当前可用于恢复的旧 facts 证据。B3-schema 交付目录形状，B3-register-metadata 交付受验证的登记入口，B3-read-segment / B3-read-snapshot 交付按 id 的单段只读快照接缝，B3-union-oracle 交付原始行多重集合并契约与“缺段不得为空”的参考断言，B3-union-read / B3-union-cold-snapshot 交付同步 hot 捕获后释放事务、用捕获 registry record 核验完整段，并从同一冷快照返回 rows 与来源身份的范围读取接缝，B3-union-multisegment 交付真实双段加 hot gap 与缺第二段整体拒绝证据，B3-cold-authority-read 交付 v1 authority marker 下的只读冷段替换、hot 残留/来源变化拒绝与缺包失败证据；I-full-events 交付完整热事件，I-full-homes 交付完整持久 home 身份，I-full-sessions 交付按 home/session 派生的会话载体，I-full-carrier-snapshot 把四项装进同一保存点，I-full-quota-snapshot-cache 证明 quota memo 不跨保存点混入未提交或跨连接新值。B-C2-model-read 只把精确模型周期分支接到现有 `usage_rollup_models` 时间窗 seam，保留原返回形状、排序、`excludeHomes` 与仅缺日回退；它不选择冷热 authority，也不合并归档段。B-cold-rollup-sync-fix 已把普通 sync 的 dirty-day 维护在非空授权段时切到完整冷热 union，并保留无 authority hot 快路；缺段仍可能留下已提交 facts 与失效 day markers，但三张聚合表和 dirty 保留，恢复后可重试；B-executor-history-rebuild 只提供执行器内部 worker 消息与 client wrapper，普通 sync/HTTP/CLI 触发仍未接线；API/Dashboard 客户端、范围查询、流式读取、authority 写入/切换、热删除/恢复 API、统计接线和 schema 21 备份支持仍由后继 owner 接线。

**B-cold-timing-source-candidate-fidelity** 已证明真实 Codex candidate 对单线程 request-timing dependency graph 的 raw fidelity：candidate 创建不改 source，candidate 与 source 的冷热样本/依赖/timing rows 深相等，读取不改候选 digest。下一 owner 若继续归档 perf/timing，必须先裁定 hot 依赖是否保留、何时清理，以及冷 perf 合并与 timing publication 的语义；不能从本卡推断依赖可删除或统计已完成。

**B-cold-workbuddy-duration-fidelity** 已证明真实 WorkBuddy candidate 对一个 message 的两条冲突原生时长观察和对应来源身份的 raw fidelity：candidate 创建不改 source，candidate 与 source 的 observation/identity 深相等，冲突样本缺失与读取前 digest 均保持不变。下一 owner 若继续归档 WorkBuddy perf，必须先裁定冲突观察的合并/弃用策略、hot 依赖保留与冷统计 publication；不能从本卡推断冷时长统计已实现。

**B-cold-unplaced-retention** 已证明 event 冷段封存不会自动处理 perf：`unplacedPerfSamples()` 在 candidate/登记/authority/冷 events 删除后仍逐字段等于封存前，candidate 的 perf source inventory 只覆盖有限时间范围，`readHistoryArchivePerfSamples()` 也只返回这些有限样本并保留原始时间戳。下一 owner 若实施 perf 淘汰，必须单独定义 hot NULL 行、sample dependencies、恢复证据与冷热合并契约；不能把本卡绿测当作 perf cold/hot 删除已完成。

**B-cold-perf-dependency-closure-red** 已把“候选包能读”与“perf 依赖图完整”之间的缺口钉在 `verifyHistoryArchiveCandidate()`：source 锁定关系在 candidate 中保持相等，但删掉一个冷样本实际引用的 `perf_sample_sources` 依赖并重打包后，外层 manifest/checksum 仍有效，当前 archive verify 仍接受不完整图。下一 owner 若实现闭包校验，应先固定本卡的 dependency inventory 读取与比较契约，再让候选验证在缺依赖时抛出 `HISTORY_ARCHIVE_CANDIDATE_PERF_DEPENDENCIES_MISMATCH`；不能只依赖备份 table hash、source inventory 或未定义的“完整能力”返回字段。

**B-cold-timing-manifest-red** 已把 sample/index 摘要与 request timing 原始值之间的缺口钉在 `verifyHistoryArchiveCandidate()`：样本来源、rollout owner、原生 response/thread 与 evidence 在 candidate 中源保真，但保持 evidence 复合主键不变、只改 `duration_ms` 并重打包后，外层 checksum 仍有效且当前 archive verify 仍接受。下一 owner 若要实现 timing manifest，必须从既有显式链路枚举被冷样本关联的原始 evidence，并在候选验证中比较其规范值；缺表、schema 漂移或值不一致应以 `HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH` 拒绝，不能用 sample/index 摘要、时间邻近或单一 source 猜测替代。该测试现冻结，后续另加独立绿测。

**B-cold-timing-manifest-write** 已把该未来门槛落到候选组件 `history_archive_perf_timing_v1`。后续 owner 可消费其中两张表的固定 rows/sha256 判断原始 timing 图是否与候选一致；不要修改列顺序、range/table/columns 摘要头或原生关联规则，也不要给无 key 的 legacy candidate 推断 timing 能力。若扩展 perf/timing publication、冷热合并、修订或淘汰，必须另卡定义范围与恢复语义；本卡只冻结候选摘要/验证，不授权任何热 timing 行清理。

`B-cold-timing-manifest-write` 已由主审独立接受（timing 专用 `2/2`，`190.5367ms` / `254.5743ms`；相邻 orphan `1/1`，`143.4912ms`；相关 `4/4`，runner `526.0552ms`）。

**B-workbuddy-observation-manifest-red** 已把候选包保真与 WorkBuddy 原生时长摘要之间的缺口钉在 `verifyHistoryArchiveCandidate()`：同一 message 的两条 conflict observation 在 candidate 中与 source 深相等，但只改其中一条 `duration_ms` 并重打包后，外层 backup checksum 仍有效，当前 verifier 仍接受。下一 owner 若实现 WorkBuddy observation manifest，必须先固定“哪些冷 source/message 引用哪些 observation”的 inventory 读取规则，再在候选验证中比较规范 observation 值；引用的观察被删除、新增或改值时应以 `HISTORY_ARCHIVE_CANDIDATE_WORKBUDDY_MISMATCH` 明确拒绝，不能用整库 backup hash、perf sample 或冲突时长猜测替代。该测试现冻结，后续另加独立绿测。

`B-workbuddy-observation-manifest-red` 已由主审完整审阅并接受为未来门槛反例（独立 `0/1`，`146.6673ms`，runner `225.9807ms`，`Missing expected rejection`）；archive 修复由 A 单独负责，本线不并行修改。

**B-zcode-cold-perf-authority-red** 已把显式 perf authority 的 summary 接缝钉在最窄的 `capturePerfCarrier()`：candidate 的四个 perf component key、同段 registry/event authority、冻结的 `history_archive_perf_authority` 形状、`zcode` 与 `tps-v2` 约束都作为前置条件成立，但只删除一个冷样本后，摘要仍只读 live perf，导致覆盖率和冷模型 `n/分位` 与未归档 oracle 不一致。后继释放 store 写入权后，应在既有同步 carrier 捕获之后、最终 `buildPerfSummaryForRange()` 之前读取并合并该授权段的已验证冷 perf；必须复用 `readHistoryArchivePerfSamples()` 和共享统计核心，不得改 sync/parser/迁移、隐式授权其他 kind、整段淘汰或另写一套分位算法。正式实现还需定义冷热重复、timing 依赖、unplaced 与失败传播语义；本卡只交反例和精确接缝。

**B-zcode-cold-perf-carrier-write** 已把显式 perf authority 的可发布冷样本接入 `summarizeHistory()` 的同一 carrier 快照：严格单段 `zcode`/`tps-v2` marker、四组件存在性、event+registry 同段绑定、捕获 record 冷读、sample-key 去重与 hot/unplaced 保真均已定向证明。后继 owner 可在此接缝上另卡覆盖多段/多 source kind、故障注入、并发替换、bundle/import、淘汰与 executor/HTTP 接线；不要复用公开 reader 在 await 后重选 live registry，也不要绕过 `perf_sample_sources`/timing 组件验证或把 payload 冲突静默去重。

**B-perf-authority-guards-red** 已由主审接受（独立 `2/3`，pass `174.4857ms` / `203.9223ms`，missing-event 预期红 `204.2632ms`，runner `661.7683ms`）。它把“perf marker 不得被 event-only 快路静默忽略”钉成回归门槛：孤立 perf marker 曾返回 hot-only 结果，非法 kind/method 为 INVALID，缺组件且外层 verify 成功的候选为 MISMATCH。生产缺口已由紧邻 fastpath fix 关闭。

**B-perf-authority-fastpath-fix** 已由主审接受（独立 `4/4`，`219.6142ms` / `169.4909ms` / `196.312ms` / `301.7177ms`，runner `662.5349ms`），store 锁已收回冻结。它只把 `summarizeHistory()` 的 authority 探测从 event-only 改为 event/perf `IN` 查询；任一 marker 存在都进入既有完整校验，修复孤立 perf marker 的静默降级。store SHA-256 为 `eebda75e848e8cfe28b850e45bd1a3fbf085fc0d1f7552dc293a80ebbe9d9f5c`。仍未处理 `metadataHistory()` 的 event-only 快路、其它 source kind/method、多段、bundle/import、并发 writer、淘汰或 executor/HTTP 接线。

**B-cold-perf-overlap-conflict** 已把“同 `sample_key` 不同完整 payload 不能被冷热合并掩盖”钉成真实行为测试：一个已授权 ZCode 段保留重叠冷样本，只改 live 行 `duration_ms` 即精确拒绝 `HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT`；恢复原值后同一 store 的完整稳定 perf 与未归档 oracle 深等，candidate digest 不变。专用测试 `1/1`，`275.5205ms`，runner `352.9673ms`；生产 store 与既有测试均未改。后续若需要冲突诊断/修复 API、其它 source kind 或自动 writer，必须另卡定义，不要放宽当前精确拒绝或静默选边。

**B-zcode-perf-multisegment-write** 已把显式 perf authority 从单段扩展到非空唯一 `segments[]`：每项仍复用原 `zcode`/`tps-v2`/digest/event+registry 严格校验，全部 record 在同一 `SAVEPOINT` 捕获，释放后按序复用既有 verified reader 与 `sample_key` 合并/冲突逻辑。A 两段红测已转绿并与 single/guard/conflict 共 `6/6`，runner `1830.9297ms`；duplicate `segmentId` 精确 `INVALID`。store SHA-256 从 `eebda75e848e8cfe28b850e45bd1a3fbf085fc0d1f7552dc293a80ebbe9d9f5c` 变为 `edaa14380291912f36e7da8c801bd75a48f0a23bee9017dd3e2c644683f7ce12`。未新增 authority writer、其它 kind、并发框架或 TPS 改动。

**B-codex-cold-perf-authority-red** 把下一个 source-kind 缺口钉在同一个 `historyArchivePerfAuthority()` 白名单：真实 Codex rollout 经 `seedRequestTiming()` 导入原生 request timing 后，cold `turn-01` perf 样本的 `100 tokens / 1000ms` 与 `perf_request_timing_evidence` 逐值一致，candidate 四组件和外层 verify 均有效。测试为 event authority 追加一条真实 `token_count` cold event，提交同段 event/perf marker（`sourceKinds:["codex"]`、`methodVersions:["tps-v2"]`），删除该 cold event 与恰好一个 cold perf sample；hot perf 全列和空 unplaced 全列保持不变，candidate digest 也不变。期望 `summarizeHistory()` 的完整 perf 与 candidate 前 source oracle 深等，但当前白名单只认 `zcode`，实际在进入冷读/合并前抛 `HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID`。专用测试 `0/1`，`162.5831ms`，runner `243.537ms`；生产 store 与既有测试均未改，SHA-256 保持 `edaa14380291912f36e7da8c801bd75a48f0a23bee9017dd3e2c644683f7ce12`。后继 owner 应先裁定 Codex 来源白名单与现有 merge 函数中的同源 kind guard，再让本绿测完整 perf parity 通过；不得无界扩大到其他 kind、改写 revision 或复制第二套统计实现。

**B-codex-cold-perf-authority-write** 只完成上述窄接点：authority parser 仍要求每段 `sourceKinds` 恰一项，只允许 `zcode` 或 `codex`，`methodVersions` 仍恰为 `tps-v2`；每段捕获 `{segmentId,record,sourceKind}` 后在释放保存点后的既有冷读循环中使用。`mergeHistoryArchivePerfSamples()` 新增该段声明 kind 参数，并对每条 cold sample 同时校验 kind 与 method；因此把 codex marker 指向实际 ZCode candidate 时，即使 marker 本身合法，也会以 `HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH` 拒绝，不会串授权。Codex 红测转绿并完成完整 `summary.perf` oracle 对拍；ZCode single/多段/guard/conflict 保留。最终相关集合 `8/8`，Codex 单测 `174.0254ms`，runner `2057.9682ms`；typecheck 与 Biome 通过。store SHA-256 从 `edaa14380291912f36e7da8c801bd75a48f0a23bee9017dd3e2c644683f7ce12` 变为 `925c8a3153faeeb66925a1d441f2912b5eff4ff1200772653500bd47a8c5f078`，具名 preimage 保持 `edaa1438…`。没有改 schema、reader、统计核心、authority writer、热删除或 revision；下一 owner 才能另卡定义 mixed-kind 段、其他 kind、多 home/bundle/import、并发与淘汰。
**B-codex-cold-perf-transfer** 把该窄能力延伸到真实 bundle/import：一个 Codex cold `tps-v2` 样本及其 native timing/owner 证据经既有 `publishHistoryArchiveBundle()` 与 `publishHistoryArchiveImport()` 转移后，在原始 source、candidate database 与 manifest 均不存在时仍由导入 runtime 恢复完整 `summary.perf`。专用宿主测试 `1/1`，`398.2668ms`，runner `476.3018ms`；Biome 与 scoped diff check 通过。生产 store 保持 `925c8a3153faeeb66925a1d441f2912b5eff4ff1200772653500bd47a8c5f078`。本卡不接 executor、HTTP/CLI 或生产 import，也不实现自动 hot deletion；下一 owner 若要求多样本/多 home、其它 timing variant、重复/在线 import、并发、重启或损坏恢复，必须另卡定义。

**B-codex-cold-perf-transfer（主审复核）** 已接受限定离线转移。命令：`node --test --test-concurrency=1 test/history-cold-codex-perf-transfer.test.js`；主审独立 `1/1`，`407.394ms`，runner `484.8078ms`。限制保持为一个真实 Codex home/线程、一个 cold `tps-v2` 样本、一套 native timing 图、一个 bundle/import；不接 executor、HTTP/CLI、生产 import、自动热删除、并发、重启或损坏恢复。

**B-codex-late-timing-red（主审复核）** 主审已独立复现预期红（`0/1`，`273.8827ms`，runner `355.618ms`）。返回该卡后补充了修订证据顺序与断言：在 archived `summarizeHistory()` 之前先执行 oracle summarize 并读取 oracle 同 `sample_key` 的新 `perf_samples` 行；断言 `importRequestTimingEvidence().changed === true`、oracle 新 payload 与旧值不同、archived live 重算行与 oracle 新行逐列深等（含 `duration_ms=null`、`timing_source=unknown`、`sample_flags=128` 与诊断字段）。candidate SHA-256 仍不变，原 `duration_ms=1000` effective sample 仍可从 `history_replaced_facts` 恢复。命令：`node --test --test-concurrency=1 test/history-cold-codex-late-timing.test.js`；收口后仍为预期红 `0/1`，`293.9195ms`，runner `378.5754ms`，精确失败为 `HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT`。准确语义是“原 cold sample 仍留在 hot，授权段与实际 hot 重算样本重叠冲突”，不是已发生物理冷淘汰；也不允许用单纯 hot 覆盖 cold，或只替换 sample 而留下旧 native timing。生产源码冻结在 `925c8a3153faeeb66925a1d441f2912b5eff4ff1200772653500bd47a8c5f078`；Biome 与 scoped `git diff --check` 通过。本卡未实现 overlay；下一 owner 需把 sample 与原生 timing evidence 共同版本化，并另卡定义 supersede、恢复、多 variant、并发及 bundle/import 后修订边界。

**B-perf-timing-revision-read** 已完成主审返修。基线核验采用已保存的真实 `edaa1438…` 前像加已接受 Codex 小 patch 正向重放；生成文件 `output/history-retention-resume-20261024/usage-store.925c8a.reconstructed-from-edaa-and-accepted-codex-patch.js` 与外层记录的 `925c8a3153faeeb66925a1d441f2912b5eff4ff1200772653500bd47a8c5f078` 精确相等，sidecar 为 `output/history-retention-resume-20261024/usage-store.925c8a.reconstruction.json`。这仍是“可验证正向重建”，不是“找到原始保存前像”；未用 Git HEAD 或当前工作文件冒充。

重复 `removed` 的根因是两个独立覆盖点：校验阶段每次都从 immutable rows 初始计数，执行阶段又按 payload 覆盖剩余计数。现在前者每消费一个 delta 就递减 `available`，后者按 payload 累加总移除数后再逐行消耗，因此两个相同 `removed` delta 不能再共同借用同一 candidate row；超过实际份数仍以 `HISTORY_ARCHIVE_REVISION_INVALID` 整体拒绝。测试先用单个 delta 证明旧 hot payload 被隐藏且 `coverage.eligible` 只减少 1，再提交两个同 payload removed，断言实际 `summarizeHistory()` 拒绝。

timing evidence 返修还修正了“任一 response 有证据就放行”的假阳性。test 现在在 late import/sync 之前直接用只读 `DatabaseSync` 查询 immutable candidate，保留目标 sample 经 dependency/owner/thread 可达的全部 evidence；该夹具的目标 response 会因多条 dependency path 在 raw join 中出现 3 次，但 `DISTINCT` 后只有一个 immutable evidence payload，测试只移除该唯一行并以 `count:1` 计算，不把 join 重复当三份事实。候选结果再只取本次生成 response 的原始 variants，断言每个候选 payload 主键唯一、目标 response 非空且 sibling response 证据仍存在。实现不再用 `links.some`，而是 `links.length > 0` 且每条必要 link 的 `(home_id,response_id)` 都必须命中 effective evidence；因此 sibling 证据不能掩盖目标 response 全缺，无 link/无 owner 也继续拒绝。实际 `summarizeHistory()` 以 `HISTORY_ARCHIVE_REVISION_INVALID` 拒绝，测试同时校验错误包含目标 `sample_key` 与 `without native request-timing evidence`，避免把 payload 不存在或其它 revision 校验误当成闭包证据。

同一测试还保留正向 oracle：人工 revision 显式替换 sample 与 timing payload 后，完整 `summary.perf` 与未归档结果深等，只归一 `indexedAt`/`meta.indexedAt`；同最终 payload 的 hot 重复仍正常去重，第三个不同 payload 仍以 `HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT` 拒绝。候选 SHA-256 在所有 reads/拒绝前后不变。本次返修前像已另存为 `output/codex-usage-store-B-perf-timing-revision-read-fd0c9a37.js` 与 `output/history-cold-perf-revision-overlay-B-perf-timing-revision-read-7cf8ad63.js`，没有覆盖旧证据；实现仍只在现有 `history_archive_perf_revisions` metadata 上做只读 overlay，没有 writer、新 schema/table、后台生成器或通用 dependency framework。

自动 Codex late timing revision writer 已落在既有 publication 事务内：候选 sample/evidence/五列身份先捕获，`data_version`/`total_changes()` 守卫输入未变，sample 与 native evidence delta 再和恢复事实、dirty timing、metadata 同事务提交。仍未实现自动重试退避、revision 历史/压缩、bundle/import 后继续修订、multi-variant 冲突选择、多 sample 共享 evidence 的自然夹具、executor/UI 接线或恢复 API。尤其不能把 timing delta 当成统计重算：当前 sample 的 timing-derived 字段仍必须由调用方在 sample delta 中显式给出，timing delta 只用于证据覆盖和最终闭包校验。

主审已独立复核并接受首个 typed 只读能力：overlay/conflict/multi/Codex/guards 共 `8/8`，runner `1086.2738ms`；typecheck `exit 0`。另仅在本测试进程禁用 effective guard 时，missing-evidence 断言精确得到 `Missing expected rejection`（`506.1416ms`），证明 candidate-native 移除不再被 sibling response 或不存在 payload 假阳性掩盖。数值重算与自动 writer 明确不在本轮接受范围。

**B-codex-evicted-late-timing-red（预期红）** 复用已通过的真实 late fixture，登记同段 event/perf authority 后删除 cold event 与该 cold `perf_samples` 行，保留 source、original segment、`perf_rollout_threads`、native request-timing link 和 evidence。删除后、late import 前，archived `summarizeHistory()` 已与未封存 oracle 的完整稳定 perf 深等，证明冷样本能从授权段恢复。随后两边真实导入 `durationMs + 500` 的 late variant 并 sync；oracle 正常，archived 在最终 summary 精确抛出 `HISTORY_ARCHIVE_PERF_SAMPLE_CONFLICT`。失败现场同时确认 revision metadata 存在但 `evictedSampleRevised=false`，candidate bytes 未变：这支持“`replacedSampleKeys` 只来自旧热样本，物理已淘汰的 cold sample 没有进入自动 delta”的缺口，不把冲突误归因为 candidate 改写。命令：`node --test --test-concurrency=1 test/history-cold-codex-evicted-late-timing.test.js`；结果 `0/1`，`407.3232ms`，runner `498.574ms`；Biome 与 scoped `git diff --check` 通过。生产 source 未改，仍为 `aef3ccbe07353c34da92d9f03cb1ff309ab326ba7d5ae43bcd8134585a8f30b5`；本卡不覆盖真实 perf 淘汰策略、删除后原始依赖清理、重试、并发、bundle/import 后继续修订或其它 source kind。

**B-codex-evicted-late-timing-fix** 已在 Codex publication 前唯一的 revision 候选 key 选择点补入本轮 `stagedThreads` 的真实 sample keys；旧热 sample keys 仍保留，因此物理已淘汰、但本轮由 staging 重算发布的 key 也会进入既有 candidate 读取、source 五列身份校验和 `BEGIN IMMEDIATE` 后的同事务 delta writer。没有增加 hot-first 兜底，也没有绕过 candidate verify、input-version guard、sample/evidence 独立 delta 或原段校验。编辑前具名前像保存为 `output/codex-usage-store-B-codex-evicted-late-timing-fix-aef3ccbe.js`，SHA-256 精确为 `aef3ccbe07353c34da92d9f03cb1ff309ab326ba7d5ae43bcd8134585a8f30b5`；对照该前像，生产 diff 仅为这 4 行 staged-key 合并。命令：`node --test --test-concurrency=1 test/history-cold-codex-evicted-late-timing.test.js test/history-cold-codex-late-timing.test.js`；结果 evicted `344.7781ms`、既有 late `410.7336ms`，合计 `2/2`，runner `911.3064ms`。同内容再次 sync 后 overlay metadata、`history_replaced_facts`、candidate bytes 与完整 perf 均保持稳定；Biome、typecheck、scoped `git diff --check` 通过。store 新 SHA-256 为 `edf21f09ab7f9a2fb5b87a58e14ba88450109eb1ecd108917d6bb4fa35cefb52`，test SHA-256 为 `9edda88a1848427577b95c2143750ea6573db4d763d15f8d6e0ac95043a88576`。仍未覆盖故障注入、自动重试、真实淘汰策略、并发 writer、多 home/多段 mixed-kind、bundle/import 后继续修订或崩溃恢复。

**B-codex-revision-rollback** 只新增真实行为测试，生产源码冻结在 `edf21f09ab7f9a2fb5b87a58e14ba88450109eb1ecd108917d6bb4fa35cefb52`。夹具先完成一次有效 late timing revision，再导入第二个 variant，并在回滚比较前断言目标 native evidence 非空、目标 `(home_id, thread_id)` 确实位于 dirty 队列，且既有 `perf_request_timing_published_revision` / `perf_request_timing_publication_seq` 都大于零；这些前置条件避免用空数组或零计数证明“状态未变”。随后临时 trigger 只在更新 `store_meta.history_archive_perf_revisions` 时抛出具名 `INJECTED_CODEX_REVISION_METADATA_FAILURE`，测试进程内的 `prepare` 包装只捕获该目标 statement 的 `run` 错误，并断言恰好触发一次且错误 message 含该具名字符串。普通 `sync()` 不抛错，而是沿既有 home 隔离路径返回目标 home degraded；`perf_state` 的编码 source warning 仍为 `READ_ONLY_OPEN_FAILED`，但不作为“精确触发”的证据。失败后 hot sample/sources、revision metadata、恢复事实、目标 evidence、dirty thread 与 timing publication counters 逐项等于失败前。删除 trigger 后不手工修 metadata，普通 `sync()` 重试成功；完整 `summary.perf` 与未归档 oracle 深等，candidate SHA-256 不变，恢复事实没有重复。该卡证明 Codex publication 内 revision metadata 写入失败会回滚该 publication 并保留已单独提交的 dirty timing 输入，不宣称 timing import 与后续 sync 跨事务原子。

B-effective-Codex-numeric 已把 typed perf revision 的数值闭包接到既有 Codex request-facts resolver：overlay 存在时，effective sample 与 effective timing evidence 必须和 immutable native links 解析出的 `timing_source`、`duration_ms`、`request_count` 一致；`explicit→unknown` 的合法降级仍保留。失败在 store 层统一为 `HISTORY_ARCHIVE_REVISION_INVALID`，并保持 candidate/原始 timing 不变。下一 owner 若要扩展其他 timing mode、任意未进入 request-facts 的样本、多段/mixed-kind、bundle/import 后继续修订或生产 API，应另立卡片；不能把该窄校验误当成通用 revision framework，也不能为通过测试过滤掉 unknown 样本。
**B-codex-required-request-facts** 的 sourceKind 条件已落在既有 capability gate：archive 常量导出 `history_archive_codex_requests_v1`，store 仅对 authority 声明的 `codex` 段额外要求该 key；`zcode` 与 legacy events-only 路径不受影响。专用反例已从 `Missing expected rejection` 转绿，Codex authority/transfer、late/rollback、ZCode reader/authority、evicted-late 与 guard/conflict/multisegment 回归均通过。剩余风险是只验证 key 存在，不重新校验其内容；数值 overlay 与请求事实逐行重算仍另卡。

主审已接受该返修：独立 `1/1`，`451.1657ms`，runner `537.1394ms`；确认精确 metadata SQL trap 计数为 1、具名 sentinel 命中、真实 dirty 目标线程、published counters 非零、完整状态回滚及重试成功。该证据仍只属于既有 Codex 发布事务；raw timing import 单独提交，不宣称 import+sync 跨事务原子。

**B-effective-Codex-numeric** 只扩既有 Codex request-facts 校验接缝，不改 schema、revision 格式、writer、统计核心或公开 API。真实 fixture 先让 archived store 与未归档 oracle 同步同一 Codex source，并由 `seedRequestTiming()` 导入原生 timing；选择一个 cold、completed、正输出/正时长的 `tps-v2` 样本及其 response，创建 candidate、登记同段 event/perf authority，再删除 cold events。随后两边导入 `durationMs + 500` 的 late timing 并 sync，archived `summarizeHistory()` 的完整稳定 `perf` 先与 oracle 深相等；该 revision 中 `turn-01` 被合法降为 `timing_source=unknown`、`duration_ms=null`，因此不能只过滤 explicit 样本，否则反例会被隐藏。

测试随后只把同一 typed effective payload 的 `duration_ms` 加一，并同步把 live `perf_samples` 改成该 payload；candidate SHA-256、candidate 内 request facts 与 archived 原生 timing evidence 均保持不变。`summarizeHistory()` 在 effective overlay 校验处以精确 `HISTORY_ARCHIVE_REVISION_INVALID` 拒绝，message 包含目标 `sample_key` 且明确含 `duration` 与 `native`；没有返回部分 summary，也没有改写 candidate。恢复原 typed payload 与 revision metadata 后，同一 store 的完整 `perf` 再次与 oracle 深相等，candidate digest 仍不变。实现复用 `validateCodexRequestEvidence()` 与既有 resolver：effective sample 按 `sample_key` 取，effective timing evidence 按 `(home_id,response_id)` 解析，immutable timing links 仍来自 candidate；`timing_source`、`duration_ms`、`request_count` 必须与 resolver 一致。

验证结果：专用测试 `1/1`，`351.7962ms`，runner `435.8755ms`；相邻 Codex required-facts/authority/transfer `3/3`，late/rollback `2/2`，ZCode reader/authority `2/2`，evicted-late `1/1`，guard/conflict/multisegment `6/6`。`npx.cmd biome lint src/usage-store.js src/history-archive.js`、`npx.cmd biome check test/history-cold-codex-effective-numeric.test.js`、`npm.cmd run typecheck` 与 scoped `git diff --check` 均通过。

主审随后指出 effective timing 分支复制了 `perf-request-timing-store.js` 的约 30 行 stored-evidence 校验，且原 lookup 先校验所有 rows 再判 conflict。返修只导出原 `validateStoredEvidence()` 并让 archive 调用它：候选 rows 先 `map(validateStoredEvidence)`，再判 conflict，available 直接使用 helper 返回的标准字段；没有保留第二套规则，也未改变 timing store 的 lookup。四文件定向同批复跑为 `4/4`，`347.5539ms / 430.0738ms / 456.5383ms / 421.7089ms`，runner `1971.4205ms`；主审最终独立复跑同四文件为 `4/4`，runner `703.5557ms`，typecheck `exit 0`。Biome lint、typecheck 与 scoped `git diff --check` 通过。逐字节前像保存在 `output/history-retention-resume-20261025/B-effective-codex-numeric-validator-reuse/`，最终 hash 为 `history-archive.js 5d76e8c9…`、`perf-request-timing-store.js 7c3a156c…`、`usage-store.js 9757fb59…`。当前卡只更新报告，不再跑广泛套件或改源码。

**B15-commit-prepare** 已把单候选提交前的只读事实捕获收在 `history-archive.js`：先验证候选，再在 source 保存点内复用现有 source-match 校验，并返回完整候选 metadata、规范 source DB 路径、范围内 event/source 指纹、唯一一份原生 event ids、五列 source identities 与输入修订。测试用真实 `UsageStore` 和真实 candidate 证明 `source.databaseFile` 等于持久主库规范路径、`:memory:` source 以 `HISTORY_ARCHIVE_COMMIT_DATABASE_UNSUPPORTED` 拒绝、plan 与未改数据库深等、JSON 往返稳定；event 或 source identity 改动均以 `HISTORY_ARCHIVE_SOURCE_CHANGED` 拒绝；篡改 candidate 后先以 `HISTORY_BACKUP_SIZE_MISMATCH` 拒绝，且 source events/source_files 与 DB/WAL bytes 不变。专用宿主测试 `1/1`，`108.2968ms`，runner `189.5695ms`；Biome、typecheck 与 scoped `git diff --check` 通过。前像 `5d76e8c9…` 已逐字节保存，最终 `history-archive.js` 为 `5d38b843…`，新测试为 `d30f3548…`。这是交付 15 的 preparation only，不包含 commit/CLI、登记、authority、删除、perf/dependency、阈值或自动归档；后继 writer 必须在自己的单一写事务中重验同一规范 DB 路径、candidate、原生 ids、多重集摘要与输入修订后才可使用 plan。

**B15-event-commit** 已由主审独立接受。冻结 artifact 的 shadow 路径为 `E:\12 AI\ccusage\codex-usage\output\history-retention-resume-20261025\B15-event-commit\verify-shadow-20261025-171341`；paired test SHA-256 为 `4829e68452ccf96d61bc4c8cc8d39ad73e39b73f7351e8b7d170a2ec865b1d6d`，两份 proposal patch 的 SHA-256 分别为 `a03d1c51a1a357b267c97733159fd7672f09915a698664d98a4cdcc1614244e3`（history helper）与 `d2c340255a76cc26ba409483955d7ee6c0dfe983472c355df92a82d7644c40`（usage store）。宿主独立运行专用测试为 `3/3`，`128.3529ms / 80.6137ms / 91.9972ms`，runner `382.7322ms`。

实现只增加同步 `assertHistoryArchiveCommitPlan(prepared, plan)` 与 `UsageStore.commitHistoryArchiveEvents(plan)`：fresh commit 在一个 `BEGIN IMMEDIATE` 内重新 prepare、比较 candidate/deletion/source evidence、登记 registry、合并 event authority、按 fresh ids 删除且要求范围内热事件为零，最后标记 rollup dirty 并提交；replay 重验原 candidate/manifest，要求范围内无热事件，回滚并返回 `replay:true` 而不推进 revision。两条新验收均已落在 paired test：首个成功 commit 前保存完整 `publishedHistoryUsageEvents()`，commit 后先断言范围内 `events=0`，再与 commit 前及 replay 后逐对象深等，证明公开事件确实由冷候选恢复；同时对 fixture 中所有非空受保护表逐表深等，包括 `source_files`、`history_replaced_facts`、`perf_samples`、`perf_sample_sources`、`perf_rollout_threads`、`perf_request_timing_meta`、`perf_request_timing_evidence`、`perf_request_timing_threads` 与 `perf_request_timing_dirty_threads`，不只检查 registry/authority 形状。dirty 故障使用 `BEFORE INSERT`，因为初始 `2026-01-02` 已存在使 `INSERT OR IGNORE` 不会触发 `AFTER INSERT`。本机 sandbox 仍因 hard-link `EPERM` 在 fixture 创建阶段得到 `0/3`，未进入断言；使用仅本地的 exclusive-copy 预载后三测试为 `3/3`，runner `460.9073ms`，该预载未进入 artifact。报告时主工作树 `src/history-archive.js`、`src/usage-store.js` 与 `test/history-archive-commit.test.js` 已分别等于 proposal 后像 `4786887c…`、`29b1b379…` 和上述 test hash；本线未执行该落源码动作，也未运行生产、完整套件或 writer/host 审批重试。边界仍是不覆盖并发 writer、崩溃恢复、多候选、多来源或生产 wiring。
**B15-executor-event-commit** 已由主审接受。审计基线采用此前真实 shadow `output/history-retention-resume-20261025/B15-event-commit/verify-shadow-20261025-171341/src/usage-executor.js`，其 SHA-256 为 `db3a8c282bab5d6722256f2ccef0f488a80988def682490e12784d66cad27fca`，与本卡开工记录一致；没有把反向重建文件当作前像依据。当前 `src/usage-executor.js` 为 `b73f173692730865437c0602a30669183cf65f8776d3284dfbd465b52e156367`，paired test 为 `ad437c6b09cfa3182a3cbe68bbac8a9033546c22e330c509a3ad60cf8e96f2f9`。规范化 diff 为 `output/history-retention-resume-20261025/B15-executor-event-commit/B15-executor-event-commit.patch`，SHA-256 `6c2e06d419bf4817d4a2d0d6a77382b749456574957d39e79cdc2a6bfc7b9471`；在 shadow 基线副本上 `git apply --check`/apply 后逐字节复现当前 executor hash。

执行器改动只包含固定消息注释、`historyArchiveEventCommit` worker case、既有串行写尾链条件与 client wrapper：worker 只 await `store.commitHistoryArchiveEvents(message.plan)`，成功后 `postState()`，plan 作为普通 JSON 跨线程；没有复制 commit writer、事务、verify 或 replay 逻辑。宿主行为测试 `1/1`，`159.2425ms`，runner `5240.0641ms`。测试用真实外部 source mutation 触发 `HISTORY_ARCHIVE_SOURCE_CHANGED`，随后排队读观察到该 mutation，证明复用原串行尾链；恢复 source 后两个并发 commit 恰好一个 insert、一个 replay，公开 events 与提交前深等。失败清理顺序在宿主行为运行后仅做过测试本地整理，最终 test hash 如上。

```text
# B15-executor-event-commit
node --test --test-concurrency=1 test/history-archive-commit-executor.test.js
exit 0; tests 1, pass 1, fail 0; duration 159.2425ms; runner 5240.0641ms

node --check src/usage-executor.js
node --check test/history-archive-commit-executor.test.js
exit 0

npx.cmd biome check src/usage-executor.js test/history-archive-commit-executor.test.js
exit 0; Checked 2 files in 15ms. No fixes applied.

npm.cmd run typecheck
exit 0

git diff --check -- src/usage-executor.js test/history-archive-commit-executor.test.js
exit 0
```

**B15-cli-explicit-event-commit** 新增 `src/cli.js` 显式入口与真实 CLI 子进程测试；复审 replay 缺口另在 `src/history-archive.js` 的既有 prepare 内增加窄接缝。CLI 即时前像逐字节保存为 `output/history-retention-resume-20261025/B15-cli-explicit-event-commit/src__cli.js.before`，SHA-256 `586ec70f16a5309d8357304256bed7cdd453b60505759e2b013525675decf457`；当前 CLI 为 `c4c8d1c187fc10575f2e746b5d1fda525b08bd145b663679e2cd61ddffd3b2a1`，当前测试为 `3247de6821ee4c827d1692d7f6f47f3630179182d62b90ee88eaaeb321827ea2`。CLI 规范化 patch 为同目录 `B15-cli-explicit-event-commit.patch`，SHA-256 `f452b032b565bd46c070949a3b1adfe7b1b8fa7e4dc72577c2490f7f05d83dca`；从真实前像 `git apply --check`/apply 后复现当前 CLI hash。replay 前像 `src__history-archive.js.before` 为 `4786887cb1438703b450cca011c9d981009262058f8b5da0fab0a740badbd93a`，当前 `history-archive.js` 为 `c9ace2f4d3909a48d3e6822c71d014fd0d7d1a5560ffa7c2169e16566a6a49a3`，窄 patch `B15-cli-replay-prepare.patch` 为 `63849bb19c42c9124ccecf663b7a594d4103b61700c4e2cd33990b77b66a6f2c`；clean apply-check 后逐字节复现当前 archive hash。

新入口为 `history archive <sourceDB> --commit <verifiedCandidateDB> --backup <newBundleDir> [--home-dir <dir>]`。CLI 先用只读 source 连接执行 `prepareHistoryArchiveCommit()`，再调用既有 `publishHistoryArchiveBundle()` 创建新目录，并显式调用 `verifyPublishedHistoryArchiveBundle()`；只有 bundle 独立验证成功后才关闭 source、打开既有 executor 并发送冻结 plan。候选验证或 backup 发布失败发生在 executor 打开前；commit 内仍按原实现重验同一 source DB、candidate、deletion/source evidence 与输入修订。`--dry-run` 继续原样走 `planHistoryArchive()`/阈值，无参数及 `--dry-run extra` 仍输出原 dry-run usage。命令不自动选候选或范围、不允许覆盖既有备份目录、不切换在线服务，也没有新增 HTTP 写接口、schema、候选生成框架或 planner 逻辑。复审新增的 prepare replay 分支只接受已登记、已授权且热范围已空的同一 candidate，并返回空 deletion/source rows 的既有 plan 形状；CLI 不读取 registry/authority，store 仍在自己的事务内完整重验后才返回 `replay:true`。

真实临时库成功路径把同一 candidate 连续执行两次 CLI，第二次使用新的 replay backup 目录。首轮新 bundle 可独立 verify，candidate 范围热 events 为 0，`publishedHistoryUsageEvents()` 与 commit 前完整 events oracle 深等，registry 恰有一条 segment。修复前第二轮在 prepare 以 `HISTORY_ARCHIVE_SOURCE_CHANGED` 退出，证明 CLI 到不了 store 已实现的 replay。replay 分支修复后第二轮退出 0，输出 `Deleted events: 0` 与 `Replay: yes`，新 bundle 独立 verify 通过；再次读取的完整 published events 仍与 oracle 深等，且首轮后的 events、archive registry 与全部 `store_meta` 快照在第二轮后逐行不变。失败路径逐项断言坏 candidate 为 `HISTORY_BACKUP_SIZE_MISMATCH`、已存在 backup 目录为 `HISTORY_ARCHIVE_STAGING_DESTINATION_EXISTS`，且两次失败前后的 events、archive registry 与全部 `store_meta` 逐行不变；既有目录 sentinel 也保持不变。受限 sandbox 在 fixture hard-link 处以 `EPERM` 假失败，宿主定向命令如下：

```text
# 修复前 replay 红测
node --test --test-concurrency=1 test/history-archive-commit-cli.test.js
exit 1; tests 2, pass 1, fail 1; failing duration 5409.9903ms; runner 5748.7759ms
# 第二 CLI 在 prepare 以 HISTORY_ARCHIVE_SOURCE_CHANGED 拒绝

# replay 接缝修复后
node --test --test-concurrency=1 test/history-archive-commit-cli.test.js
exit 0; tests 2, pass 2, fail 0; durations 10588.0066ms / 308.5808ms; runner 10974.0386ms

node --test --test-concurrency=1 --test-name-pattern="history archive" test/history-cli.test.js test/history-archive-commit-cli.test.js
exit 0; tests 3, pass 3, fail 0; durations 10582.2628ms / 327.3568ms / 284.7893ms; runner 11348.2406ms

node --test --test-concurrency=1 test/history-archive-commit-prepare.test.js test/history-archive-commit.test.js test/history-archive-commit-executor.test.js test/history-archive-commit-cli.test.js
exit 0; tests 7, pass 7, fail 0; runner 16818.678ms

node --check src/cli.js
node --check src/history-archive.js
node --check test/history-archive-commit-cli.test.js
exit 0

npx.cmd biome check test/history-archive-commit-cli.test.js
exit 0; Checked 1 file in 8ms. No fixes applied.

npx.cmd biome lint src/history-archive.js
exit 0; Checked 1 file in 24ms. No fixes applied.

npx.cmd biome check src/history-archive.js test/history-archive-commit-cli.test.js
exit 1; formatter only, with pre-existing diffs outside the replay seam; replay lint clean

npm.cmd run typecheck
exit 0

git diff --check -- src/cli.js test/history-archive-commit-cli.test.js
exit 0

git apply --check --whitespace=error --directory=output/history-retention-resume-20261025/B15-cli-explicit-event-commit/apply-check-history-archive output/history-retention-resume-20261025/B15-cli-explicit-event-commit/B15-cli-replay-prepare.patch
git apply --whitespace=error --directory=output/history-retention-resume-20261025/B15-cli-explicit-event-commit/apply-check-history-archive output/history-retention-resume-20261025/B15-cli-explicit-event-commit/B15-cli-replay-prepare.patch
exit 0; applied sha256 c9ace2f4d3909a48d3e6822c71d014fd0d7d1a5560ffa7c2169e16566a6a49a3

# 主审独立复核
node --test ... # archive commit CLI replay + prepare + commit
exit 0; tests 6, pass 6, fail 0; CLI replay duration 10656.6108ms; runner 11019.7077ms

node --test --test-concurrency=1 --test-name-pattern="history archive" test/history-cli.test.js
exit 0; dry-run 1/1, 325.5804ms

node --check # 5 audited files
exit 0

biome lint / scoped whitespace # 5 audited files
exit 0
```
**交接：** `src/usage-store.js` 已释放给 A 的有界 sealed reader 短卡；本线不再持有 store writer。`perf-request-timing-store.js` 仅保留 `validateStoredEvidence()` export，现已冻结，前像继续保留。B15-commit-prepare 已完成 `history-archive.js` 的单候选只读 prepare，现释放该文件；具体 commit writer 必须由主审另派单卡，并自行在同一写事务重验 candidate digest、metadata、source facts 与 input revision。不得并行启动第二个 `history-archive.js` writer，也不得把 prepare plan 当作提交授权。

**交接（B15-event-commit）：** proposal/shadow 与 paired test 已按上述 hash 冻结；本线不再修改 artifact、测试或源码，也不持有 `history-archive.js` / `usage-store.js` writer 锁。后续两线归属检查、正常审批、源码落地与生产外验证由主审负责；不要在 worker 重试 writer/host 审批，也不要把本卡扩展成并发、恢复或生产执行能力。
**交接（B15-executor-event-commit）：** 已由主审接受，shadow baseline 与当前 executor/test hash 已记录；执行器文件不再由本线修改。CLI 后继已按显式入口接上该 client，但没有改 worker、store 或 archive。

**交接（B15-cli-explicit-event-commit）：** 主审已独立接受显式 events-only CLI 入口与 replay，但这不等于交付 15 的完整 perf 淘汰。CLI/archive 即时前像与当前后像、更新后的 CLI test、两个规范化 patch 与 clean apply-check 均保存在 `output/history-retention-resume-20261025/B15-cli-explicit-event-commit/`；当前 CLI 为 `c4c8d1c187fc10575f2e746b5d1fda525b08bd145b663679e2cd61ddffd3b2a1`，当前 `history-archive.js` 为 `c9ace2f4d3909a48d3e6822c71d014fd0d7d1a5560ffa7c2169e16566a6a49a3`，当前 executor 为 `b73f173692730865437c0602a30669183cf65f8776d3284dfbd465b52e156367`，当前 store 为 `29b1b379756a457b40b41120e03307485af15f85a6e94943f84c83a1b87c81d8`，当前 CLI test 为 `3247de6821ee4c827d1692d7f6f47f3630179182d62b90ee88eaaeb321827ea2`，helper 前像为 `4786887cb1438703b450cca011c9d981009262058f8b5da0fab0a740badbd93a`。本线现冻结 `src/cli.js`、`src/history-archive.js`、`src/usage-executor.js` 与 `src/usage-store.js` 并交回锁；不再扩大 CLI、archive、executor、store、guards 或自动归档。主审的私有完整 bundle/import 与 staging 演练副本不得触碰；正式 perf 淘汰待该演练完成后另卡释放。

**交接（B15-ZCode-supported-perf-commit）：** 源码与测试已冻结，当前 `history-archive.js` / `usage-store.js` 为 `5934183226df160f50cba131d0a9933ae15bb34d99c22e1ce43c2d3392beb2aa` / `29987d5703fa55aa0d1b9d983d179e77bdf4134395a5a20a5f2335f13dc9a405`；两份 LF-only proposal、真实前像、paired tests 与 clean apply-check 均保存在 `output/history-retention-resume-20261025/B15-ZCode-supported-perf-commit/`。正式 CLI perf replay 缺口已由专用子进程测试覆盖；Codex 后继已由独立的 `B15-Codex-supported-perf-commit` 接续。下一步仅由主审复核本 artifact 与报告，不在本线重跑 broad tests、扩展 mixed-kind/依赖 perf 或执行生产写回。

**交接（B15-Codex-supported-perf-commit）：** 当前 `history-archive.js` / `usage-store.js` / paired test 为 `f227a174bccd7f0a7f18f12747496f2fb2717dbf36f21719cd614e8ee03da6dc` / `f7d746df7b0b7900a1a5e1b0e18d7bd5b9358ffc74bf48029259d97eb775356a` / `c41d15ebb5929e87c861ef899fee628ca621eec1218dac155f6f5cb4524e5637`；已完成纯 Codex `tps-v2` perf 删除、原生命令清单门禁、具名级联回滚/同 plan 重试，以及缺原生 manifest 的 events-only commit/replay 兼容。后续 owner 不得把 legacy candidate 或缺失 request facts 的库降为可删除，也不得移除 source/candidate `codexRequestEvidence()` 精确比较；本卡不扩 mixed-kind、其它 timing mode、bundle/import、自动 writer 或恢复 API。

**交接（B20-legacy-migration-tests）：** 主审已接受三文件完整 paired patch（`perf-projection-store.test.js`、`perf-store.test.js`、`workbuddy-store.test.js`，独立 108/108，3449.38ms）。只更新当前 schema 的固定期望，生产源码保持冻结；v11/v13/v16 fixture、事务回滚、事实保留、标脏、幂等与重试断言未放宽。
**交接（B root narrow promotion / metadata rollup counts）：** 根仓 A+B 已由主审接受，四个 post-image 与本报告已冻结；本线不再修改根仓 source/test、不重跑该 15 项，也不持有 `usage-store.js` / `usage-rollups.js` writer。窄 patch、可验证 A 前像、隔离 apply-check 与 post-image hash 位于 `output/history-retention-profile-20261026-metadata-rollup-counts/root-promotion-evidence/`。后续若要求 million-event 验证、冷布局收益或 `metadataHistory()` 优化，应另立卡片并重新采集基线；不要把本卡的无 authority rollup 快路扩成 archive authority 下的完整计数。**交接（B20-archive-test-isolation）：** 本卡只修改 `test/history-archive.test.js` 的两处临时目录 census 隔离，并更新本报告；即时前像保存在 `output/history-retention-resume-20261025/B20-archive-test-isolation/`。生产 `src`、候选格式、正式 bundle 事实和泄漏断言均冻结；未重复全仓。

**交接（B19-cost-model-count）：** 候选、baseline、定向测试、主审独立脚本、标准 `src/pricing.js` patch 与 clean apply-check post-image 均保存在 `output/history-retention-profile-20261026-cost-model-count/`。根仓 `src/pricing.js` 仍为 `671f1bc8b3a5c6e3eee8061c876f19815dd84d89622f2fe2fdf51f14e3cc0391`，候选为 `32809d5c93ef643e5dabb756e6fd931f9209250bbd8a1a429ce6016067b25e13`。主审独占 100k 配对为 baseline `1314.6544ms` / candidate `1315.4628ms`（`+0.0615%`，无收益），99 输入仅 pricing 差异且完整 cost/payload 相等；因此拒绝推广本地 `modelCount` 缓存，根仓 pricing 不变。早期 oracle 准备失败不是产品 RED。本线待命，不再补测试、重复 pair 或运行 million；C 接当前共享源的一次既有 100k attribution，寻找真实主耗时，停止叶子缓存试验。
