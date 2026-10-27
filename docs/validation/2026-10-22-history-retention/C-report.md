# C1-detail-count / C1-format2-upgrade / C1-detail-input-output / C1-detail-cached-reasoning / C1-detail-combined / C1-detail-store-parity / C2-model-day / C2-model-range / C2-model-range-store-parity / C2-model-window / C2-window-snapshot / C2-million-model-probe / C2-million-store-probe / C2-million-process-probe / C2-million-dashboard-probe / C2-million-after-cache / C2-dashboard-bottleneck / C2-dashboard-attribution / C-current-dashboard-profile / C-current-million-dashboard / C-timeline-consumer-split / C-bounded-memo-eviction-probe / C-memo-isomorphic-iterator / C-bounded-memo-iterator-write / C-memo-million-isolated / C-300k-post-memo-attribution / C-sync-cpu-leaf / C-sync-rollup-bootstrap-cause / C-warm-summary-cpu-leaf / C-timeline-memo-direct-control / C-timeline-direct-full-summary-control / C-timeline-direct-production-patch / C2-timeline-consumer / C2-minimum-rates-cache / C-browser-archive-freeze / C-archive-freeze-client-wire / C-archive-freeze-keyboard-language / C-archive-sealed-days-ui / C-sealed-days-browser / C-sealed-day-event-drilldown 报告：最小 oracle、UTC/local 日汇总、脏日队列、detail 位计数与 token、格式升级、缺失来源提示、API 接线与真实浏览器冻结反例

> 新增 C3-archive-status-panel：只读归档状态面板（待主审复核）。
> 新增 C-archive-sealed-days-ui：归档段展开后按需读取封存 UTC 日统计，语言重渲染复用缓存并保留展开态；主审已接受 mock 与静态层。
> C-sealed-days-browser 已由主审接受：真实 Edge 在 `1920×1080` 下完成 days/Space 焦点/语言/freeze/实际移走 live/unfreeze 全流程；`history-main-sealed-days-verified.json` 的 `17` 项行为断言加 `pass=true` 共 `18/18` 全真，预期 live-missing usage 500 精确绑定，5 张截图经主审目视验收。原始 `history-main-sealed-days-evidence.json` 与复验 JSON 均保持原 hash。
> C-sealed-day-event-drilldown 已由主审接受：真实 Edge `1920×1080`、105 事件夹具完成 `100 + 5` 分页、闭合日线、末页焦点、语言、四段 `2+1+1` 带、冻结后移走 live 仍读 snapshot 分页与解冻 missing；`20` 项行为断言加 `pass=true` 共 `21/21` 全真。renderer/i18n/test 已冻结，等待 17 冻结 context 接线与 15 原子提交，后续不再排边缘探针。
> 新增 C-browser-archive-freeze：真实 Microsoft Edge 1920×1080 冻结反例，归档面板在冻结期间仍被 live `/api/history/archives` 刷新（**RED，待主审释放单一 freeze 接线卡**）；本卡未改生产。
> C-archive-freeze-client-wire 已由主审独立接受：冻结时归档状态改用 usage snapshot，解除冻结先刷新 live archive；单段真实 Edge 复验通过，接受范围不表示 issue 18 已完整关闭。
> C-archive-freeze-keyboard-language 已由主审接受：本卡用真实 Edge 验证产品按钮冻结、`<summary>` 键盘折叠/展开、冻结请求仅带 snapshot，以及中英文重渲染后同一归档段范围和状态不变；接受范围仍是单段冻结限定行为。
> C20-timeline-currency-order 已由主审接受：同一模型的原生 USD/CNY 分桶、原有单币种形状及 detail/tooltip/legend 模型身份均通过 `82/82`；真实 staging 以 `108465` 个未归档 public events 对拍完整业务 summary，原 hash 严格不变，仅规范化集合顺序与 `2.6148e-12` 的最大 IEEE 尾差，币种身份严格相等。`#19` 仍失败，`#20` 整项不关闭。
> C-current-dashboard-profile 已由主审接受：固定 54 文件副本的 copy/source 前后哈希、原始结果 digest、100,000/256/6 与 raw oracle、cost trace 和共享 baseline 恢复均独立通过；接受的是单次 100k 诊断 `3,550.0667ms`，不是 #19 门槛。
> 新增 C-current-million-dashboard：从当前 55 文件只读快照运行一次 1M --dashboard-after-cache；first/skipCheck 38,617.3085 / 11,589.2531ms，均 HTTP 200、等于 SQL oracle、默认 120s 未覆盖。两组单次样本仍分别超过冻结的单次 15s/5s 门槛，且不是 20 进程 p95/SLA（待主审复核）。
> C-timeline-consumer-split 已由主审接受：54 文件摘要、raw result digest、两份 full-output deepEqual 标记、8 model / 100k match 分布与 nested 差值均独立通过；接受 `606.6424 / 424.9899 / 153.9394 / 116.7749ms` 为限定诊断，不是可相加的 905ms 拆分。
> 新增 C-bounded-memo-eviction-probe：只用固定快照的 `createBoundedKeyMemo` 与 100k 唯一短 key 做 4096/100000 entry 对照，并仅在确认差距后用本地 persistent-iterator control 验证假说（待主审复核）。
> 新增 C-memo-isomorphic-iterator：完整复制固定 pricing module，只复用 FIFO oldest iterator；生产全 stats/FIFO/bytes 相等下，4096 条逐出中位耗时从 `82.8841ms` 降至 `14.2477ms`，配对中位改善 `68.1171ms`（`82.18%`，待主审复核）。
> 新增 C-bounded-memo-iterator-write：把主审接受的同构 iterator 接点写入生产 `createBoundedKeyMemo`，并在 `clear()` 明确重置游标；新增一个 byte-to-empty、clear 复用与双循环 FIFO 的行为测试（待主审复核）。
> 新增 C-memo-million-isolated：在独立 54 文件副本中只替换已接受 pricing 字节，单次 1M `--dashboard-after-cache` 的两次请求均为 HTTP 200 且等于 SQL oracle；first/skipCheck 为 `48,316.0080 / 21,956.6286ms`（待主审复核）。
> C-300k-post-memo-attribution 已由主审接受：固定上一轮 memo 快照的独立 300k benchmark 副本，单次 HTTP 为 `14,152.9984ms` 且等于 SQL oracle；memo 记录 `300000` 次 miss 插入与 `212411` evictions，峰值同时越过 entry 与 64 MiB byte 门限。
> C-sync-cpu-leaf 已由主审接受：只在首次 worker `UsageStore.sync` 外套 1 ms V8 CPU profile；`sync 6,138.1291ms` 中 `4,037` 个 exclusive 样本落在 native SQLite `run`，归因到 rollup rebuild 的逐日插入语句；PositionTicks 仅是比例估计。
> C-sync-rollup-bootstrap-cause 已由主审接受：同一固定 300k seed 的首次 `sync` 为 `6,499.3201ms`、rollup 写入 `252570`；第二次 `sync` 为 `3.5136ms`、rollup 写入 `0`，三项事实/oracle 断言全部为真。
> 新增 C-warm-summary-cpu-leaf：固定 300k 快照只 profile 首次 `summarizeInReadTransaction`，应用 self `52.70%`、GC `2.24%`、`timelineRange` 祖先 inclusive `69.56%`；接受运行 HTTP `200`、`17,835.19ms`，完整 summary 数据对拍通过。前两次尝试分别因 volatile `quota.asOf` 和 hook 漏导入 `statSync` 失败，失败证据保留；最小待测接缝是 memo 的 key/byte 记账（待主审复核）。
> C-timeline-memo-direct-control 已由主审接受：同一批固定 300k 物化事件上的三对 memo/direct 轮换中，六份完整 timeline 输出深度相等，三份 stats 均为 `0` hits / `300000` misses / `209334` evictions；主审独立复跑 memo/direct median `2,669.6302 / 1,084.5986ms`、配对差 `1,585.0316ms`。接受范围是 consumer 因果，不是生产 SLA。
> 新增 C-timeline-direct-full-summary-control：固定 300k store 上对比完整 `summarizeInReadTransaction({ preset: "all" }, { includeDetails: true })` 的默认 memo timeline 与 timeline 内 direct estimate；两份规范化 summary 深度相等，summary `6,586.8760 → 4,397.7388ms`，timeline `4,424.1402 → 2,639.0234ms`，默认 memo `300000` misses / `209334` evictions，direct memo 增量为 `0`；接受范围是固定 300k 单次诊断，不是 SLA。
> 新增 C-timeline-direct-production-patch：timeline 内唯一替换为 direct estimate；原 `f59b` 生产 RED 保留，隔离单行 GREEN `1/1` 与相邻 `29/29` 通过；B 当前 live 不作为 patch 前像（待主审在 B 归还后的新前像上按唯一 anchor 应用）。

日期：2026-10-22。状态：**C0.1、C0.1b、C0.2、C0.3、C0.3b、C0.4、C1a、C1b、C1c、C1-home、C1-stale、C1-read-snapshot、C1-local、C1-zone-transfer、C1-DST、C1-session、C1-version、C1-home-count、C1-nested、C1-dirty-UTC、C1-local-from-UTC、C1-detail-count、C1-format2-upgrade、C1-detail-input-output、C1-detail-cached-reasoning、C1-detail-combined、C1-detail-store-parity、C2-model-day、C2-model-range、C2-model-range-store-parity、C2-model-window、C2-window-snapshot、C2-million-model-probe、C2-million-store-probe、C2-million-process-probe、UI-missing、C-regression-contract、UI-missing-API、UI-full-missing-oracle、UI-full-first、UI-full-usage-scope、UI-full-session-oracle、UI-full-quota-oracle、C-archive-freeze-client-wire、C-archive-freeze-keyboard-language、C-current-dashboard-profile、C-timeline-consumer-split、C-300k-post-memo-attribution、C-sync-cpu-leaf、C-sync-rollup-bootstrap-cause、C-timeline-memo-direct-control、C-sealed-day-event-drilldown 与 C-timeline-direct-full-summary-control 已通过主审复核**。C2-million-dashboard-probe、C2-dashboard-bottleneck、C2-dashboard-attribution 与 C2-timeline-consumer 已获有限归因接受；当前新增 **C2-million-after-cache、C2-minimum-rates-cache、C-bounded-memo-eviction-probe、C-memo-isomorphic-iterator、C-bounded-memo-iterator-write、C-memo-million-isolated、C-warm-summary-cpu-leaf 待主审复核；主审已接受 C-archive-sealed-days-ui 的 mock/静态层；当前新增 C-timeline-direct-production-patch 与待主审复核的 C-current-million-dashboard；C-sealed-days-browser 已由主审接受真实 Edge 全流程**。dashboard probe 在真实 loopback `createUsageServer` 上用百万行正式 schema 21 请求 `/api/summary?preset=all`，并超出默认 executor guard 完成测量；该 override 成功只作诊断证据，**不计性能达标**，生产 `120s` guard 的 #19 问题保持进行中。C2-million-after-cache 使用独立 `--dashboard-after-cache` 子模式且不覆盖 timeout，在同一 seed 上只跑一次 checked 与一次 `skipCheck`；两次均返回 HTTP 200 并等于 SQL oracle，但仍是单次、合成数据诊断，#19 仍未关闭。bottleneck 卡用同 seed 的 `100,000` 行、一次 `skipCheck=1` summary 定位实际调用路径，未改生产文件；attribution 卡修正该次计时口径，分开记录 iterator `activeMs` 与 `inclusiveMs`；timeline-consumer 卡在独立直接调用中定位 `buildTimelineRows` 内部计价与分桶成本，三者均未改生产文件。C-current-dashboard-profile 另用固定 54 文件源快照重跑一次 100k attribution，解决共享 `src/usage-store.js` 漂移后的可审计性；主审已独立接受该单次诊断，但它不代表生产优化或 #19 关闭。C-timeline-consumer-split 继续使用同一快照的既有 consumer 模式，在三份完整输出深等后拆分 pricing memo、estimate 与 precomputed-cost 分桶，主审已接受该限定诊断。C-bounded-memo-eviction-probe 只用固定快照的通用 memo 与 100k 唯一短 key，定位 4096 条逐出与无逐出的真实毫秒差，并用本地 persistent-iterator control 检查队列压力；仍不修生产。C-memo-isomorphic-iterator 把完整快照 pricing module 复制到 sibling 控制文件，仅新增惰性续建的 FIFO oldest iterator 并替换两处逐出取 oldest；生产 stats/FIFO/bytes 全等时三组交错 100k 配对中位减少 `68.1171ms`，足以建议后续聚焦生产修复，但本卡不改生产。C-bounded-memo-iterator-write 已把该接点迁入生产并显式重置 clear 后 iterator；既有 memo 文件加一项新行为断言 `9/9` 通过，未改计价、store、core、public 或其他 pricing 逻辑。C-memo-million-isolated 又从旧 54 文件快照复制新树，只替换已接受的 pricing 字节；单次 1M first/skipCheck 为 `48,316.0080 / 21,956.6286ms`，两份请求均为 HTTP 200 且等于 SQL oracle，固定 store 仍是旧 `f501e615…`，不是 B 当前 live 版本。C-300k-post-memo-attribution 在同一固定树的独立副本上只把本卡 `BOTTLENECK_EVENT_COUNT` 改为 `300000`，并用既有 worker hook 采样 memo stats；唯一 HTTP `200`、`14,152.9984ms`，300k/256/6 与五项 token 全等于 SQL oracle。memo 记录 `300000` 次 miss 插入与 `212411 evictions`，peak `262145 entries / 200821687 bytes`，round 后 `87589 entries / 67108541 bytes`；这证明首次全历史扫描仍存在真实 entry/byte 压力，但不把 consumer `3,535.9749ms` 猜成纯 memo 时间，也不受控解释完整 1M 剩余差值。C-sync-cpu-leaf 在同一 300k 固定树副本上只增加 `--sync-cpu-leaf` 与首次 worker `UsageStore.sync` 的 1 ms V8 CPU profile；唯一 HTTP `200`、`12,879.1460ms` 且等于 SQL oracle，`sync 6,138.1291ms` 的 `4,037` 个 exclusive samples 落在 rollup rebuild 的 native SQLite `run`，三个逐日 insert 调用点合计 `4,036` ticks，剩余 1 tick 位于 `deleteDay.run`；主审已接受 raw samples、timeDeltas、leaf 权重、祖先栈与 oracle。C2-million-model-probe 原 worker JSON 为 `benchmark-model-window-worker.json`，脚本默认输出 `benchmark-model-window.json` 是主审复跑数据；C2-million-store-probe 原 worker JSON 为 `benchmark-model-store-worker.json`，脚本默认输出 `benchmark-model-store.json` 是主审复跑数据；C2-million-process-probe 原 worker JSON 为 `benchmark-model-process-worker.json`，脚本默认输出 `benchmark-model-process.json` 是主审复跑数据。三组均通过各自的 raw 对拍。C2-window-snapshot 已由主审独立通过精确 target `1/1`（`182.2696ms`）并接受；C2-model-window 已由主审独立通过精确 target `1/1`（`135.6643ms`）并接受，格式仍为 v7；C2-model-range-store-parity、C2-model-range、C2-model-day 均已接受。v2→v3、v4 输入/输出、v5 cached/reasoning 与 v6 组合 detail 指标保留为已接受的历史证据。UI-full-quota-oracle 已由主审在 07:40 独立通过；此前 HTTP 500 与 `[]` 仅保留为历史失败记录。本报告只覆盖这些短卡，不代表完整保真夹具、通用 rollup、归档、retention 或界面阶段完成。

## 范围与结论

- C0.1：新增 `test/history-parity.test.js`，锁定 GLM 输出档位必须逐事件计算，不能先合并再套价。
- C0.1b：复用既有 `test/usage-store.test.js` 的 D2 跨日用例，并在固定 `TZ=Asia/Shanghai` 的子进程中运行；未复制测试、未新增通用 fixture、未修改 `src/`。
- C0.2：在 `test/history-parity.test.js` 新增同 session、同一天切模型的 project-log 用例，锁定整体与按模型分组的会话数都使用 DISTINCT。
- C0.3：在同一测试文件新增真实本地 Git 仓库下的窄日期/全区间对照，锁定 `projects` 与 `repositories[].pathCount` 随所选区间过滤。
- C0.3b：在同一测试文件新增两个 project-log home 的排除对照，锁定 `excludeHomes` 同时移除对应 cwd 与 pathCount。
- C0.4：在同一测试文件新增不同 known 位与 inconsistent 事件的 `periodComparison` 对照，锁定 detail 派生列逐事件计算，而不是相加 mask。
- C1a：新增独立 `src/usage-rollups.js`，只用调用方传入的 `DatabaseSync` 创建单表、重建并查询一个 UTC 日。
- C1b：同一模块把重建入口改为 `{ days }`，去重后在一个事务内重建所有受影响 UTC 日；事件从 A 移到 B 时同步清空 A、更新 B，B 写入失败时 A/B 旧汇总同时保留。
- C1c：新增 `queryUsageRollupsRange`，只对完整 UTC 日区间汇总 token/eventCount；逐日检查汇总行，缺日时带 `missingDays` 明确失败。
- C1-home：日汇总改为 `(day_key, home_id)`；新增独立已构建日标记表，range 查询支持 `excludeHomes`，空日与排除全部 home 都不会误报缺日。
- C1-stale：`createUsageRollups` 安装 `events` INSERT/UPDATE/DELETE 触发器；事实变化时在同一源事务内删除覆盖旧/新时间戳的已构建标记，未重建前查询明确失败。
- C1-read-snapshot：day 与 range 查询的完整性检查和汇总行读取包在同一个 SAVEPOINT 读快照内，避免另一连接部分重建造成新旧日混算。
- C1-local：`calendarZone` 显式支持 `utc`/`local`（默认 `utc`）；日标记存 `start_ms/end_ms`，触发器按时间范围失效，local 边界使用 JS 当地 0 点。
- C1-zone-transfer：day/range 完整性检查核对 marker 的 `start_ms/end_ms` 是否等于当前进程的日边界；跨时区拷入的 local 标记按未构建处理，重新 local rebuild 后恢复可读。
- C1-DST：纽约 2026 春季/秋季切换日分别验证 23h/25h 窗口、当地日首末事件计入、次日午夜排除，range 不漏不重日。
- C1-session：新增按 `(calendar_zone, day_key, home_id, session_id)` 去重的会话关系表；day/range 查询分别用 `COUNT(DISTINCT session_id)` 得到跨日、跨 home 精确的 `sessionCount`，不把每日会话数相加。
- C1-version：新增独立 `usage_rollup_format` 版本行；查询只接受当前格式，旧/未知/缺版本均按未构建处理。重建先删除全部旧派生表与触发器，再从 `events` 构建当前结构，事实表不变。
- C1-home-count：day/range 查询从有效 daily 行按 `home_id` 去重得到 `homeCount`；空日不计 home，`excludeHomes` 后按剩余 home 计算，不把每日 home 数相加。
- C1-nested：`createUsageRollups` 与 `rebuildUsageRollups` 共用固定名 `usage_rollups_write` 的 SAVEPOINT 包装；格式升级、缓存清写与调用方外层事务处于同一原子范围，失败不会留下半升级缓存或破坏外层事务。
- C1-dirty-UTC：缓存格式升到 v2 并新增 `usage_rollup_dirty_days(day_key PRIMARY KEY)`；首次创建只扫描一次 `events` 种入 UTC 日，之后 INSERT/UPDATE/DELETE 在同一事实事务内入队旧/新 UTC 日，成功重建 UTC 日后清理。
- C1-local-from-UTC：新增纯函数 `localUsageRollupDaysForUtcDays(days)`；把每个 UTC 日的 `[start, next)` 投影到当前当地，枚举首尾当地日并去重排序，供后续在清 UTC 队列前推导需要重建的 local 日。
- C1-detail-count：rollup 缓存格式当时升到 v3；每日每个 home 行新增输入/缓存/输出/推理 known 事件计数及非零 `reconciliation_gap` 事件计数，day/range 查询返回对应 camelCase 合计。逐事件 `CASE` 派生，不存或累加 `detail_mask`。
- C1-format2-upgrade：构造真实 v2 五表与三个事实触发器，写入 v2 格式行和旧汇总；验证 v2 day 查询拒读、重建后事实逐字段不变且 detail 计数正确、再次重建结果幂等。主审接受的原始证据为 v2→v3。
- C1-detail-input-output：rollup 缓存格式升到 v4；每日每个 home 行新增输入/输出 known 与 unavailable token 四列，day/range 查询返回四个 camelCase 合计。派生复用既有 `periodAggregate` 的逐事件 `CASE` 语义，raw `input`/`output`、既有计数、事实 schema 与 store 主查询映射不变。
- C1-detail-cached-reasoning：rollup 缓存格式升到 v5；每日每个 home 行新增 cached/reasoning known 与 unavailable token 四列，day/range 查询返回四个 camelCase 合计。bit2/bit8 逐事件 `CASE` 派生，raw `cached`/`reasoning`、既有计数、事实 schema 与 store 主查询映射不变。
- C1-detail-combined：rollup 缓存格式升到 v6；每日每个 home 行新增 uncached input、cache-rate、unattributed detail、inconsistent token 与 reconciliation gap 七列，day/range 查询返回对应 camelCase 合计。全部复用 store `periodAggregate` 的逐事件 `CASE` 语义；未扩费用、维度或主查询接线。
- C2-model-day：rollup 缓存格式升到 v7；只在本次重建目标日集合非空时，于同一写事务内新增按 `(calendar_zone, day_key, home_id, model)` 的 16 项 `periodAggregate` detail 指标表，并提供完整 UTC 日按 model 汇总查询。查询跨 home 合并同一 model、支持 `excludeHomes`、按 model 稳定排序；旧格式返回 `null`，事实表不变。未接 store、费用、仓库、partial window 或 session 关系。
- C2-model-range：新增完整 UTC 日区间的按 model 汇总查询；逐日验证已构建 marker，使用单一读快照，跨日/跨 home 合并同一 model，支持 `excludeHomes` 与稳定排序，缺任一日时抛出带精确 `missingDays` 的 `ROLLUP_DAYS_MISSING`，不返回部分结果。未接 store、费用、仓库、partial/local window 或 session 关系，也未改变 v7 格式。
- C2-model-range-store-parity：只改 `test/history-parity.test.js` 与本报告，生产 rollups/store 冻结。复用真实 project-log→`UsageStore` 夹具，两个 UTC 整日、两个 model、两个 home，用 `periodAggregate("model", "model", ...)` 的原 SQL 对照 `queryUsageRollupModelsRange` 的全部 16 项指标；覆盖 `excludeHomes` 和 UTC 末尾 `23:59:59.999`/次日 `00:00:00.000` 边界。未扩费用、session、仓库、local 或其他 store 接线。
- C2-model-window：新增半开 `[startMs, endMs)` 的按 model 汇总查询；完整 UTC 日从 rollup 读取，起止 partial 边缘直接读 `events`，全部检查与读取包在同一读 SAVEPOINT 内。完整日缺缓存时抛 `ROLLUP_DAYS_MISSING`，不静默改读 raw；跨 raw/rollup 的同一 model 稳定合并排序。未接 store、费用、仓库、local/DST 或 session 关系，也未改变 v7 格式。
- C2-window-snapshot：只改 `test/usage-rollups.test.js` 与本报告，`src/usage-rollups.js` 冻结。复用临时 WAL 与 `DatabaseSync.prepare` 注入：另一连接在完整日 model 行读取后、raw 边界读取前更新三个事件并重建完整日 cache；首次窗口读仍必须得到整套旧 16 指标，下一次读得到整套新值。未新增生产 hook，也未用 marker 状态或 shape 测试替代混合快照断言。
- C2-million-model-probe：只新增 `benchmark-model-window.mjs`、独立 JSON 结果与本报告；生产模块和既有测试冻结。固定种子写入恰好 1,000,000 条事件，跨 365 个 UTC 日、8 个 model、6 个 home、12 种 detail mask；建 v7 cache 后对固定长窗口直接 raw 16 指标 `GROUP BY model` 与 `queryUsageRollupModelsWindow` 冷/温结果逐字段对拍，并记录耗时、DB/WAL 字节和运行环境。只有全量事实相等后才报告性能。
- C2-million-store-probe：只新增 `benchmark-model-store.mjs`、独立 JSON 与本报告；生产与既有测试冻结。复用同一固定百万分布，但通过真实 `UsageStore` 创建正式 schema 21，预置 6 个 `source_files` 与全部必需 `events` 列；不发现现场源、不 `sync()`、不依赖 B 的 public 入口。测量 store 初开/重开、cache 重建、同一窗口 raw/cache 冷温和真实 DB/WAL 字节。
- C2-million-process-probe：只扩同一 benchmark 脚本的 `--process` 子模式，新增 worker 与主审复跑两份 JSON；默认单进程模式与输出不变。父进程建立同一百万行正式 schema 21 与 raw 16 指标 oracle，随后恰好启动三个独立 Node 子进程，每个只 `open()` 并做一次 process-cold window 查询；0 号子进程另做 10 次连续温读。所有子进程退出后，父进程执行一次 `PRAGMA wal_checkpoint(TRUNCATE)`，记录返回页数、耗时及 DB/WAL 前后字节。主审复跑已接受。
- C2-million-dashboard-probe：只扩同一 benchmark 脚本的 `--dashboard` 子模式并新增 `benchmark-model-dashboard.json`；生产模块与既有测试冻结。复用同一百万行正式 schema 21 与 v7 rollup，关闭 seed store 后启动真实 `createUsageServer`，在隔离临时文件中按 `preset=all` 依次发两次正常 checked 请求与一次 `skipCheck=1` 请求；用独立 SQL oracle 对拍 event/session/home/metadata 计数和五项 token 合计，同时记录响应、缺失来源、存储、进程内存与关闭行为。
- C2-million-after-cache：只扩同一 benchmark 脚本的独立 `--dashboard-after-cache` 子模式并新增 `benchmark-model-dashboard-after-cache.json`；既有 `--dashboard` JSON 与语义、生产模块和既有测试均不变。复用同一固定百万行正式 schema 21 与 v7 rollup，不覆盖 `120,000ms` executor timeout，先发一次 `preset=all`，成功后再发一次 `skipCheck=1`；失败响应记录为结果而不是转成断言，成功响应继续与独立 SQL 计数/token oracle 全量对拍。
- C2-dashboard-bottleneck：只扩同一 benchmark 脚本的 `--dashboard-bottleneck` 子模式并新增独立 JSON；生产模块与既有测试冻结。用同 seed 的 `100,000` 行、正式 schema 21 与 v7 rollup，发一次真实 loopback `skipCheck=1` summary；worker-only `--import` hook 临时计时实际 `UsageStore` 方法与 SQL，结束后不保留 hook。输出仍由独立 SQL totals/counts 对拍，只提出最小生产接线建议。
- C2-dashboard-attribution：只扩同一 benchmark 脚本的 `--dashboard-attribution` 子模式并新增独立 JSON；生产模块、server、store、rollup 与既有测试均未改。用同 seed 的 `100,000` 行与一次真实 loopback `skipCheck=1` summary，保留 `inclusiveMs` 并新增逐次 `iterator.next()` 的 `activeMs`；`all()` 的 rows 改为 `Array.length`。报告只比较 top1 cost event scan 的 active/inclusive、`timelineRange` inclusive 与消费者差额，不新增缓存或生产优化。
- C-current-dashboard-profile：只新增 `output/history-retention-profile-20261024/` 证据并更新本报告；生产模块、benchmark、既有测试与 1m 行为均未改。把 35 个 `src/**/*.js`、17 个 `public/**/*.js`、benchmark 和 `package.json` 共 54 个文件复制为只读源快照，完成一次 100k `--dashboard-attribution`，并在运行后逐文件确认快照哈希未变；共享 baseline JSON 保持原像。
- C-current-million-dashboard：只新增 output/history-retention-profile-20261025-current-million/ 证据并更新本报告；生产模块、共享 benchmark/结果、测试、app、CSS、store 与运行中服务均未改。把当前 35 个 src/**/*.js、17 个 public/**/*.js、benchmark、同相对路径 reference dashboard JSON 和根 package.json 共 55 个文件复制为只读快照；从该副本只运行一次 --dashboard-after-cache，不覆盖默认 120s，保留 first checked + skipCheck、完整 SQL oracle、stdout/stderr 与逐文件 hash。
- C-timeline-consumer-split：只在本卡证据目录转存结果并更新本报告；使用同一 54 文件只读快照中的既有 `--timeline-consumer`，不新增 fixture、生产 instrumentation、p95、1m 或生产改动。一次 `100,000` 事件运行同时产出同源 `UsageStore.timelineRange` reference、带 production memo 的 instrumented rows 与预置 `costEstimate` 的 precomputed-cost bucketing rows，三者完整深等。
- C-bounded-memo-eviction-probe：只新增 `output/history-retention-profile-20261024/memo-eviction-probe.mjs`、结果 JSON 与本报告；源码与 54 文件快照只读冻结。复用快照导出的 `createBoundedKeyMemo`，对 `100,000` 个唯一短 key / 固定轻 value 分别设 `maxEntries=4096` 与 `100000`、其余 byte budget 足够，跑三组各三次；逐次断言返回、compute/miss 次数、FIFO 保留、逐出数与字节，并仅在确认差距后用本地 persistent-iterator control 检查迭代器假说。
- C-memo-isomorphic-iterator：只新增 `output/history-retention-profile-20261024/pricing-memo-isomorphic-control.js`、`memo-isomorphic-iterator-probe.mjs`、结果 JSON 并更新本报告；54 文件快照与全部生产源码冻结。控制文件完整复制快照 pricing module，仅把依赖路径改为既有 snapshot 的相对可达位置；语义只新增可复用并在耗尽时重建的 FIFO oldest iterator，替换两个逐出循环中的 fresh iterator，byte 统计、round、clear、返回值和其余逻辑保持同构。三组交错 100k 对照直接比较 production 强制逐出、同构控制强制逐出与 production 无逐出，且保存精确 unified diff。
- C-bounded-memo-iterator-write：只改 `src/pricing.js` 的 `createBoundedKeyMemo`、`test/w4-event-cost-memo.test.js` 与 C-report；其他 pricing 逻辑、store、core、public 与 54 文件快照冻结。施工前 `src/pricing.js` 与既有只读快照均为 `ddaf043e9a3b5a3540cb0ef45e60d56527e5b9b373ba581172dd2cc3830e45b2`；生产只迁入已由主审接受的 oldest-iterator helper 与两个逐出接点，并在 `clear()` 明确重置 iterator，其余 byte/entry 上限、stats、roundDepth、键与计价语义不变。新增一个行为测试覆盖 byte 逐出到空、clear 后复用和两个逐出循环共用 FIFO，不检查实现形状。
- C-memo-million-isolated：只新增 `output/history-retention-profile-20261025-memo/` 固定副本、结果与过程状态，并更新本报告；`src/`、既有 54 文件 snapshot、共享 benchmark 与共享 JSON 均未改。先从上一卡只读 snapshot 复制完整 54 文件树，再把唯一差异 `src/pricing.js` 从 `ddaf043e…` 替换为本卡已接受的 `12d39362…`；`store` 仍是旧快照 `f501e615…`，不是 B 正在改的 live store。复制既有 `benchmark-model-dashboard.json` 为同相对位置只读 reference，复用同一 `benchmark-model-store.mjs` 的 `--dashboard-after-cache` 单次 1M 模式，保留 first checked + skipCheck、SQL oracle、HTTP 状态/耗时、内存和临时 server 生命周期。
- C-300k-post-memo-attribution：只新增 `output/history-retention-profile-20261025-300k-memo-attribution/`、独立 benchmark 副本和 unified diff，并更新本报告；生产、共享 benchmark 与两套既有 snapshot 冻结。副本只把 `BOTTLENECK_EVENT_COUNT` 改为 `300000`、把导入指向 `history-retention-profile-20261025-memo/source-snapshot`，并在既有 `--dashboard-attribution` worker hook 中前后读取 `eventCostMemo.stats()`。一次真实 loopback `preset=all&skipCheck=1` 请求与独立 SQL oracle 全量对拍，同时记录 method/SQL inclusive-active-consumer、memo hit/miss/eviction/bytes；不重跑 1M、不做 20 组或生产优化。
- C-sync-cpu-leaf：只新增 `output/history-retention-profile-20261025-sync-cpu-leaf/`、独立 benchmark 副本/diff/profile 结果与结构化证据，并更新本报告；生产 `src/`、`public/`、测试、共享 benchmark、两套固定 snapshot 和旧证据均冻结。副本只新增 `--sync-cpu-leaf` 模式，把 `node:inspector` 的 1 ms V8 sampling 限定在 worker 首次 `UsageStore.sync` 前后，输出 raw `.cpuprofile`、exclusive/inclusive 栈摘要与 line `positionTicks`；不增加生产 instrumentation、缓存或优化。
- C-sync-rollup-bootstrap-cause：只新增 `output/history-retention-profile-20261025-sync-bootstrap-cause/` 的 probe、结果与日志，并更新本报告；生产 `src/`、`public/`、测试、共享 benchmark 和既有 snapshot 全部冻结。probe 复用固定 300k seed 的 UTC cache 构建，关闭 seed store 后在同一个临时 DB 上新建一个 `UsageStore` 并串行执行两次 `sync()`；只在该临时 DB 上加 rollup audit triggers，记录 local-zone meta、dirty days、UTC/local marker 与 rollup facts。三条断言分别锁定 bootstrap cause、第二次 sync 零 rollup 写入、raw/UTC/local facts 等于 oracle；不修生产、不新增通用 framework、不跑 1M。
- C-warm-summary-cpu-leaf：只新增 `output/history-retention-profile-20261025-warm-summary-cpu-leaf/` 的独立 benchmark 副本、raw/profile/result/oracle/失败尝试与结构化证据，并更新本报告；生产 `src/`、`public/`、测试、共享 benchmark、固定 snapshot 和旧证据均冻结。副本在 `sync` 完成后只对首次 `summarizeInReadTransaction(..., { includeDetails: true })` 外套 1 ms `node:inspector` CPU profile；唯一接受运行同时记录 method/SQL/memo trace，并把完整 HTTP summary 与同一临时 DB 的未采样 summary 逐字段对拍。唯一归一字段是请求后才变化的 `quota.asOf` 实时时钟值，区间、usage、配额窗口及其他字段未剔除。
- C-timeline-memo-direct-control：只新增 `output/history-retention-profile-20261025-timeline-memo-direct-control/` 的 benchmark 副本、diff、结果、验证与日志，并更新本报告；生产 `src/`、`public/`、测试、共享 benchmark、固定 snapshot 和旧证据均冻结。该控制模式先物化同一批固定 300k production store events，再在同一批事件上按 `memo→direct`、`direct→memo`、`memo→direct` 跑三对；memo 每轮新建默认预算实例、`beginRound()/endRound()` 且不跨轮复用，direct 直接调用 `estimateEventCost` 且不保存 `costEstimate`。六份完整 timeline 输出全部深度相等；只比较 consumer 追加成本，不改默认 cache/memo 策略，不提供生产修复。
- C-timeline-direct-full-summary-control：只新增 `output/history-retention-profile-20261025-full-summary-direct-control/` 并更新本报告；生产 `src/`、`public/`、测试、共享 benchmark、54 文件固定 snapshot 与旧证据均冻结。先以 10k 事件验证完整 summary 深等，再在同一固定 300k seed 上对默认 memo timeline 与“仅 timelineRange 调用期间临时用 direct estimate”跑一对 `summarizeInReadTransaction({ preset: "all" }, { includeDetails: true })`；每次恢复 `eventCostMemo.estimate` 并记录前后 stats。两轮只规范化 `generatedAt` 与 `quota.asOf`，完整对象必须深等和 SQL 计数/token 对拍；不改默认 memo/cache/budget，不做 HTTP 或 1M。
- C2-timeline-consumer：只扩同一 benchmark 脚本的 `--timeline-consumer` 子模式并新增独立 JSON；生产模块、server、store、rollup 与既有测试均未改。把同 seed 的 `100,000` 行、production store events 先物化，再独立调用 `buildTimelineRows`，用 production memo wrapper 计时 `estimateEventCost`，并分别 replay `eventCostMemoKey`、`resolvePricingModel` 与 `timelineBucketKey`。完整 13 行输出必须与 `UsageStore.timelineRange` 深度相等；不新增通用框架、缓存或计价语义变更。
- C2-minimum-rates-cache：只改 `src/pricing.js` 与 `test/pricing.test.js`，并新增本卡前后对照 JSON；benchmark 脚本、store、rollup、UI、server 与既有计价语义冻结。`minimumRatesFor()` 的纯最低费率结果按 `modelKey + contextLevel + currency` 缓存，`setPricingCatalog()` / `resetPricingCatalog()` 全清；不缓存最终事件金额，不合并 GLM 分档，不扩模型匹配或日历缓存。
- C3-archive-status-panel：新增 `public/history-archives-ui.js`，并在 `public/index.html`、`public/app.js`、`public/i18n.js` 接线；只消费既有 `GET /api/history/archives`，未改 server、store、rollup、pricing、timeline、perf、skin 或 CSS。面板用原生 `<details><summary>` 提供键盘折叠，显示登记范围与已登记事件数；`present` 明确仅表示文件存在，`missing`/`unreadable` 保留范围并显示事件数不可用，加载与请求失败不显示伪造的零计数。
- C-browser-archive-freeze：只新增 `output/playwright/history-archive-freeze-*` 隔离夹具、Playwright 采证脚本、四张真实浏览器截图与 JSON 证据，并更新本报告；`src/`、`public/`、既有测试和服务均未改。真实 Microsoft Edge 在 `1920×1080` 下先确认归档面板为 `present`，通过产品 `#autoRefreshToggle` 冻结并取得 snapshot，再移除临时归档段、以 `data-preset="week"` 触发冻结 usage 刷新。冻结请求 URL 实际使用 `snapshot=36d81046-508e-4eca-a429-e181ccebd684` 且 HTTP 200，但同一轮 live `/api/history/archives` 返回 `missing` 后，面板也变为 `missing`。证据 verdict 固定为 **RED / pass=false**。
- C-archive-freeze-client-wire：只改 `public/history-archives-ui.js`、`public/app.js`、`test/history-archives-ui.test.js` 与 `output/playwright/history-archive-freeze-fixed-*` 夹具/采证脚本，并更新本报告；未改 server、store、index、i18n、CSS、既有 RED 证据或运行中服务。`refreshHistoryArchives()` 冻结时请求 `/api/history/archives?snapshot=<encoded id>`，live 时省略参数；成功 `loadUsage()` 把 `state.snapshotId` 传入归档刷新，解除冻结时先清空 snapshot 并立即刷新 live 归档，再启动可能失败的 live usage。既有 generation guard 继续阻止旧 snapshot 响应覆盖较新的 live 响应。
- C-archive-freeze-keyboard-language：只新增 `output/playwright/history-archive-freeze-keyboard-*` 采证脚本/截图/JSON，并更新本报告；`public/`、server、store、既有测试和旧证据均未改。使用原始 host hard-link 临时夹具，在真实 Microsoft Edge `1920×1080` 下通过产品 `#autoRefreshToggle` 冻结；`Space` 在聚焦的 `#historyArchivesPanel > summary` 上先折叠再展开，随后通过产品 `#languageToggle` 从 `zh-CN` 切到 `en-US`。冻结后唯一一次 `/api/history/archives` 请求带 snapshot，且没有 live 归档请求；两种语言中的范围均对应同一 `1790910245000..1790910305000` 区间，状态均为 `present` 的“仅表示文件存在”文案。
- C-archive-sealed-days-ui：只改 `public/history-archives-ui.js`、`test/history-archives-ui.test.js`、`public/i18n.js` 与本报告；`public/app.js`、`public/index.html`、CSS、server、store、executor、timeline、perf 与其他 public 文件均未改。`present` 段使用惰性 `<details>`，首次展开才读取封存 UTC 日统计；`missing`/`unreadable` 不请求日统计，只保留段范围并显示不可用。
- C-sealed-days-browser：worker 只新增 `output/playwright/history-sealed-days-*` 浏览器/API oracle、前像与 diff，并更新本报告；真实 days/list/snapshot API 与两项最小修复已验证，但真实 Edge DOM 因 worker 审批门超时未执行。主审随后在正常 host 原 fixture 与真实 Edge 接手完成全流程并接受：`17` 项行为断言加 `pass=true` 共 `18/18` 全真，预期 live-missing usage 500 精确绑定，5 张截图已目视验收；`public/app.js`、`public/index.html`、CSS、server、store、executor 与其他 public 文件均冻结。
- C1-detail-store-parity：只改 `test/history-parity.test.js`，`src/usage-rollups.js` 冻结。用两个真实 project-log home 复用三条 detail 事件，经真实 `UsageStore.sync()` 建完整 UTC 日 rollup，再以半开日区间对照 `store.periodAggregate(null, ...)` 的原 SQL（闭区间传 `end-1ms`）；覆盖全部 detail token 指标、一个 home 排除和重复重建不变。
- UI-missing：`renderPerfCoverageHtml` 在 `summary.perf.missingSources` 非空时追加一条 `role="status"` 的“部分来源已缺失，已保留历史数据。”；为空或字段不存在时不显示，不改变 ready/degraded 或排名。
- C-regression-contract：只更新 `test/perf-codex-index.test.js` 中两处过期的 schema 19 契约；精确断言当前 schema 20、`history_replaced_facts` 与 `sync()` 创建的五张 rollup 表。生产代码、store、rollup 与 public 未改。
- UI-missing-API：新增 `test/history-retention-api.test.js`，通过临时 loopback server 验证真实 `/api/summary` 的 missing 状态、历史统计保留、覆盖提示中英文出现与恢复后消失；未改生产代码。
- UI-full-missing-oracle：在同一测试增加 `/api/usage?detail=full&preset=all` 对照；实际失败为持久 `missingSources[0].kind="extra"` 而 full 为 `[]`，恢复后两者均清空。未改生产代码。
- UI-full-first：缺失与恢复两轮都先请求 full、再请求 summary；full 自身返回精确原路径与 `kind="extra"`，其 `groups/models/coverage` 在缺失和恢复后均等于初始值，证明不依赖先访问 summary 刷新。生产模块冻结，仅改测试与报告。
- UI-full-usage-oracle：新增一个真实非零 project-log 来源，先发布后删除 `usage.jsonl`；full 先请求时 `summary.totals` 全为 0、`report.events` 为空，而持久 summary 保留 `total=123` 及原事件。恢复文件后，full/summary 总量和唯一事件均回到初始值。生产模块冻结，仅改测试与报告。
- UI-full-usage-scope：在已接受的 `publishedUsageEvents` 接线后，同一用例扩为两个真实 project-log 来源，`123 + 77 = 200`；删除 `123` 来源后 full 仍为 `200` 与两条事件，排除该 home 后为 `77` 与保留事件，恢复后总量和两条事件不重复。生产模块冻结，仅改测试与报告。
- UI-full-session-oracle：在同一缺失/恢复状态检查 `report.sessions` 保留两个原 session、`metadata.sessionCount` 等于报告内唯一 session 数，并检查 `report.homes` 保留两个原 project-log home 的 id/kind/path；恢复后同样逐字对拍且不重复。主审独立复跑时先取得失败反例，生产接线完成后已通过。生产模块冻结，仅改测试与报告。
- UI-full-quota-oracle：新增一个小测试，在现有 Codex rollout 追加一条原生 `token_count`/`rate_limits.primary` 观察，发布后删除该 rollout；先请求 full，再要求 `report.rateLimitObservations` 与已发布原观测身份/字段逐字相等，恢复后仍等于原观测且不重复。生产模块冻结，仅改测试与报告。
- 六条路径都使用真实计价或 store 读接口，不是单独测试 `Date`。

## C0.1：GLM 两事件输出档

`test/history-parity.test.js` 构造两个 `glm-4.7` / `ZCode` 事件，每个 `input=1000`、`output=100`、`total=1100`，并构造一个合并事件 `input=2000`、`output=200`、`total=2200`。四项独立断言：

| 路径 | 独立手算 | 断言 |
| --- | --- | --- |
| 两事件分别计价 | `2 × (1000×2 + 100×8) / 1e6` | `totalCny = 0.0056` |
| 两事件分别计价 | 每条均未达到输出阈值 200 | `pricedRecords = 2` |
| 合并后套价 | `(2000×3 + 200×14) / 1e6` | `totalCny = 0.0088` |
| 合并后套价 | 合并输出达到 200，切 `shortLongOutput` | `pricedRecords = 1` |

金额容差为 `1e-12`。该测试只验证计价入口；不验证来源解析、store 持久化或浏览器汇总。

## C0.1b：UTC/local 跨日

复用 `test/usage-store.test.js:2307` 的 `D2 · 时区（local/utc）与跨日边界`：

- 真实 rollout 事件时间：`2026-07-12T23:30:00.000Z`。
- `store.recordsForRange({ zone: "local" })` 断言日键 `2026-07-13`、token `500`。
- `store.recordsForRange({ zone: "utc" })` 断言日键 `2026-07-12`、token `500`。
- 两路径 token 总量相同，只有日历日归属不同；断言还覆盖跨日窗口与 1 ms 边界。

固定时区后精确运行该用例，已通过。未复制到 `history-parity.test.js`。

## C0.2：同 session 同日切模型的 DISTINCT 会话数

临时目录中的单个 project-log 文件写入三条事件：

- 三条事件都使用 `session_id=switch-session`，时间为 `2026-07-12T02:00/02:01/02:02Z`。
- `gpt-6-sol` 两条，`gpt-6-luna` 一条；token 总量分别为 10、20、30。
- 通过真实 `store.sync()` 导入，再用 `store.summarize({ preset: "custom", startDate: "2026-07-12", endDate: "2026-07-12", bucket: "day", calendarZone: "utc" })` 汇总。

| 断言 | 手算 | 实际字段 |
| --- | --- | --- |
| 整体会话数 | 三条事件共享一个 session | `sessionCount = 1` |
| `gpt-6-sol` 会话数 | 两条事件共享一个 session | `models[...].sessions = 1` |
| `gpt-6-luna` 会话数 | 一条事件对应一个 session | `models[...].sessions = 1` |

用例在 `finally` 中关闭 store 并删除临时目录；不验证浏览器、compact index 或其他日期范围。

## C0.3：区间路径计数

临时目录内建立真实本地 Git 仓库，并写入单个 project-log：

- 同一仓库下 `cwd-A` 于 `2026-07-12T02:00:00Z`、`cwd-B` 于 `2026-07-13T02:00:00Z` 各一条事件。
- `project_root` 同为该仓库根目录；真实 repository resolver 将两天都归到同一 `git:` repository。
- 窄日期查询 `2026-07-12..2026-07-12` 只应见 `cwd-A`；全区间 `2026-07-12..2026-07-13` 应见 `cwd-A`、`cwd-B`。

| 断言 | 手算 | 实际字段 |
| --- | --- | --- |
| 窄区间路径 | 仅日 1 的 `cwd-A` | `projects[].name = [cwd-A]`，`pathCount = 1` |
| 全区间路径与计数 | 日 1 + 日 2，两个不同 cwd | `projects[].name = [cwd-A, cwd-B]`，`pathCount = 2` |

`repositories[].pathCount` 来自 `COUNT(DISTINCT NULLIF(cwd, ''))`；`projects` 来自区间过滤后的 `events.cwd` 分组。用例在 `finally` 中关闭 store 并删除临时目录。

## C0.3b：排除 home 的路径计数

同一临时 Git 仓库下建立两个独立 project-log home：

- `log-a` 的事件使用 `cwd-A`，`log-b` 的事件使用 `cwd-B`；两者归到同一 `git:` repository。
- 整体 `summarize({ preset: "all", bucket: "day", calendarZone: "utc" })` 应得到 `pathCount = 2`。
- 传入 `excludeHomes: [store.homes[0].id]` 后，应只剩另一个 home 的 cwd，`pathCount = 1`。

| 断言 | 手算 | 实际字段 |
| --- | --- | --- |
| 整体路径计数 | 两个 home 各一个 cwd | `repositories[0].pathCount = 2` |
| 排除后的路径与计数 | 仅保留 `log-b` 的 `cwd-B` | `projects[].name = [cwd-B]`，`pathCount = 1` |

两个 home 的 ID 从 `store.homes` 取得；排除直接传给真实 `store.summarize`，未绕过业务读路径。

## C0.4：detail 位掩码派生列

单个 project-log 写入三条同一天、同一模型事件：

- 事件 A 只提供 `input=80`、`output=20`，`detailMask = 5`。
- 事件 B 只提供 `cached=5`、`reasoning=5`，`detailMask = 10`。
- 事件 C 的 `input` 与 `output` 已知但都为 0，`validateUsageDetails` 将其标成 `detailMask = 16`、`reconciliationGap = 40`。
- 真实 `store.periodComparison({ now: "2026-07-12T12:00:00.000Z", calendarZone: "utc" }).totals.today` 汇总。

| 断言 | 手算 | 实际字段 |
| --- | --- | --- |
| known 位各自生效 | A 的 input 80；B/C 的 input 未知，合计 50+40 | `input=80`、`inputUnavailableTokens=90` |
| output known 位各自生效 | A 的 output 20；B/C 的 output 未知，合计 50+40 | `output=20`、`outputUnavailableTokens=90` |
| 不完整与不一致记录总量 | 三条都不完整，总量 100+50+40；仅 C 不一致 | `unattributedDetailTokens=190`、`inconsistentTokens=40`、`reconciliationGap=40` |

第三条断言要求 `comparison.models[0].periods.today` 与整体 `today` 逐字相等。若把 `detailMask` 当作可加值（`5+10+16=31`），known 位会全部误判为已知；前两条断言会直接失败。

## C1a：单日 token 汇总

`src/usage-rollups.js` 的输入输出接缝：

| 函数 | 输入 | 输出 |
| --- | --- | --- |
| `createUsageRollups(db)` | 调用方已打开的 `DatabaseSync` | 在最小 SAVEPOINT 内创建版本表、日标记表、按 home 汇总表、会话关系表与事实失效触发器；旧/未知格式先清空派生缓存；不改 `user_version` |
| `rebuildUsageRollups(db, { days, calendarZone? })` | 同一数据库、严格 `YYYY-MM-DD` 日数组与可选 `utc`/`local` | 去重并校验后，在一个可嵌套 SAVEPOINT 内升级格式、按 zone 删除旧行、写 `start_ms/end_ms` 标记并汇总 |
| `queryUsageRollups(db, { day, calendarZone? })` | 同一数据库、日键与可选 zone | `{ day, eventCount, sessionCount, homeCount, total, input, cached, output, reasoning, inputKnownTokens, inputUnavailableTokens, outputKnownTokens, outputUnavailableTokens, cachedKnownTokens, cachedUnavailableTokens, reasoningKnownTokens, reasoningUnavailableTokens, uncachedInput, uncachedInputUnavailableTokens, cacheRateInput, cacheRateCached, unattributedDetailTokens, inconsistentTokens, reconciliationGap, ...counts }`，无该日返回 `null` |
| `queryUsageRollupsRange(db, { startDay, endDay, excludeHomes?, calendarZone? })` | 同一数据库与包含两端的日区间 | 与 day 相同的 token/detail 合计，以 `startDay/endDay` 代替 `day`；任一日未重建则抛 `ROLLUP_DAYS_MISSING` |

`test/usage-rollups.test.js` 建立最小 `events` 表，使用真实形状的 `timestamp_ms` 与 local `day_key`：

- `2026-07-12T02:00Z`、`day_key=2026-07-12`，计入 UTC 7 月 12 日。
- `2026-07-12T23:30Z`、`day_key=2026-07-13`（Asia/Shanghai local 次日），仍计入 UTC 7 月 12 日。
- `2026-07-13T00:00Z`、`day_key=2026-07-13`，必须排除。

前两条的手算合计为 `eventCount=2`、`total=30`、`input=22`、`cached=7`、`output=8`、`reasoning=3`。连续重建同一 UTC 日两次后仍得到该结果；`2026-07-13` 未被重建，查询为 `null`。测试刻意让 local `day_key` 与 UTC 日不同，若实现继续按 `day_key` 过滤会直接失败。

该模块**尚未接入** `UsageStore`、主查询、迁移或浏览器；只验证独立模块的指定日重建和读取。

## C1b：跨日移动的原子重建

`rebuildUsageRollups` 不再接受单日 `{ day }`；唯一现有调用方已改为 `{ days: [...] }`。数组先去重，再一次性校验所有 UTC 日；任一日非法时不会开始事务。

跨日移动用例先为 UTC A/B 建立汇总，再把一条事件从 A 改到 B，并调用：

```js
rebuildUsageRollups(db, { days: ["2026-07-12", "2026-07-13", "2026-07-12"] })
```

- 重复的 A 只重建一次。
- A 汇总变为全零：`eventCount=0`、`total=0`。
- B 汇总为新值：`eventCount=1`、`total=40`，没有保留旧事件或重复计数。

故障注入用例先保存 A/B 旧汇总，再把事件从 A 移到 B，并创建临时触发器拒绝向 B 插入汇总行：

```sql
CREATE TEMP TRIGGER fail_rollup_b
BEFORE INSERT ON usage_rollup_daily
WHEN NEW.day_key = '2026-07-13'
BEGIN
  SELECT RAISE(ABORT, 'injected rollup B failure');
END
```

`rebuildUsageRollups(db, { days: ["2026-07-12", "2026-07-13"] })` 抛出该错误后，A/B 查询结果都与调用前逐字段相等。该用例证明删除与两次写入处于同一事务，不是每日各自提交。

两张用例都只使用临时数据库；没有接入 store、`user_version`、费用或维度汇总。

## C1c：完整 UTC 日区间查询

`queryUsageRollupsRange` 复用 `utcDayBounds` 校验两端日期；倒序区间直接抛 `RangeError`，不会查询或返回部分总数。日期枚举按 UTC 固定 24 小时推进，因此闰日与月末不依赖本地时区。

查询先确认 `usage_rollup_daily` 存在，再读取区间内所有 `day_key`，并与枚举出的完整日集合逐日比对。任一缺失日都会抛出：

```js
Object.assign(new Error("usage rollups missing for UTC day(s): ..."), {
  code: "ROLLUP_DAYS_MISSING",
  missingDays: [...],
});
```

真实 `UsageStore` 用例在临时 project-log 中写入两条事件，分别位于 UTC `2026-07-12` 与 `2026-07-13`。`store.sync()` 后，测试：

1. 用 `store.summarize({ preset: "custom", startDate: "2026-07-12", endDate: "2026-07-13", bucket: "day", calendarZone: "utc" })` 取得旧读路径 oracle。
2. 分别重建两个 UTC 日。
3. 断言 `queryUsageRollupsRange` 的 `eventCount` 与五项 token 合计逐字段等于 oracle。
4. 查询 `2026-07-12..2026-07-14` 时断言 `code=ROLLUP_DAYS_MISSING`、`missingDays=["2026-07-14"]`。
5. 查询倒序区间时断言明确报错。

该用例只比较整日 token 总量与事件数；没有接入 `UsageStore.summarize`、迁移、费用、DISTINCT、local 日界或配额。DISTINCT 会话数由后续 C1-session 补齐。

## C1-home：按 home 汇总与排除

汇总表主键从单列 `day_key` 改为 `(day_key, home_id)`；重建 SQL 按 `home_id` 分组。是否已构建不再由“是否有汇总行”推断，而由最小表 `usage_rollup_days(day_key PRIMARY KEY)` 单独标记。重建在原有单事务内先删当日汇总、再写标记、最后写 home 行，因此空日也有已构建标记，排除全部 home 也不会被误判为缺日。

`queryUsageRollupsRange` 先只读已构建日标记表判断完整性，再按可选的 `excludeHomes` 数组过滤汇总行。全部 home 被排除时返回全零，而不是绕过过滤读取未过滤总行。

真实 `UsageStore` 双 home 用例（C1-session 已扩展为两日，C1-home-count 复用并加入 `aggregateRange` 对拍）：

- 两个 project-log home 分别写入 UTC `2026-07-12` 与 `2026-07-13` 事件，总量分别为 10、20，共用同一 `session_id`。
- 重建 `2026-07-12..2026-07-14`，其中 `2026-07-14` 为空日。
- 排除第一个 home 后，与 `store.summarize({ ..., excludeHomes: [第一个 home] })` 的 `eventCount` 和五项 token 合计逐字段相等。
- 排除全部 home 后，同一完整区间仍成功返回全零。
- 原有的“区间含未构建日”断言仍要求 `ROLLUP_DAYS_MISSING` 和精确 `missingDays`。

该用例只覆盖 home 排除与空日标记；未接入 store 迁移、业务主查询、model/project 维度或费用。

## C1-stale：事实变化使旧汇总不可读取

`createUsageRollups` 额外安装三个最小触发器，均按 `timestamp_ms` 是否落入已构建标记的 `[start_ms, end_ms)` 判断失效日，不使用 local `day_key`：

- INSERT：删除覆盖 `NEW.timestamp_ms` 的已构建标记。
- UPDATE：同时删除覆盖 `OLD.timestamp_ms` 与 `NEW.timestamp_ms` 的标记。
- DELETE：删除覆盖 `OLD.timestamp_ms` 的标记。

这些触发器会删除 `usage_rollup_days` 标记，C1-dirty-UTC 起还会向 UTC dirty 队列入队；它们不重建、不修改汇总行，也不改 `user_version` 或业务主读。由于缓存失效与事实写共享源事务，源写回滚时标记和 dirty 入队也回滚，旧汇总继续可读。

真实临时 `UsageStore` 用例：

1. 导入一条 UTC `2026-07-12` 事件并重建该日。
2. 在 savepoint 内把事件跨日改到 `2026-07-13`，随后回滚；A 日旧汇总仍可读。
3. 再次执行跨日 UPDATE，不重建就查询 `2026-07-12..2026-07-13`，断言 `ROLLUP_DAYS_MISSING` 且 `missingDays` 精确为 A/B 两日。
4. 重建两日后，A 为全零、B 为修改后的新值，证明旧汇总不可读取且重建后恢复正确。

该用例覆盖跨日移动；同日修改与单独 INSERT/DELETE 由同一组触发器覆盖，但本卡未各自构造独立断言。

## C1-read-snapshot：完整性与汇总行同快照

`queryUsageRollups` 与 `queryUsageRollupsRange` 都通过 `withReadSnapshot` 执行：

1. `SAVEPOINT usage_rollups_read`。
2. 在同一快照内读取 `usage_rollup_days` 判断完整性。
3. 读取 `usage_rollup_daily` 汇总行。
4. 成功则 `RELEASE`；异常则回滚到 savepoint 后重新抛出。

使用 SAVEPOINT 而不是 `BEGIN`，因此查询可嵌套在外层事务中。读路径没有 test-only hook；测试通过包装 `DatabaseSync.prepare`，在读取 built 标记与读取汇总行之间插入另一 WAL 连接的写入。

确定性双连接用例：

- 初始 A 有事件、B 为空，A/B 都已重建。
- 读连接读取 built 标记后，测试包装器在另一连接把事件从 A 移到 B，并只重建 B。
- 写连接提交后，A 标记被触发器删除，B 为新汇总。
- 读连接仍返回完整旧快照：`eventCount=1`、`total=10`，未混入 B 的新值。
- 写连接随后查询 A 明确缺日，B 返回新值，证明穿插写入确实发生。

该卡只解决读一致性；未接入业务主读或全局 revision。

## C1-local：JS 当地日界与 zone 隔离

`calendarZone` 只接受 `"utc"` 或 `"local"`，缺省为 `"utc"`。日标记主键改为 `(calendar_zone, day_key)`，并保存 `start_ms/end_ms`；汇总表主键改为 `(calendar_zone, day_key, home_id)`。

- UTC 日边界仍为 `Date.UTC` 的 `[start, next)`。
- local 日边界为 JS `new Date(year, month - 1, date)` 与下一日当地 0 点，不按固定 24 小时推进。
- 触发器不再用 SQL `localtime`，而是判断 `OLD/NEW.timestamp_ms` 是否落入任意已建标记的 `[start_ms, end_ms)`；同一事实可同时失效 UTC 与 local 两个日标记。

固定 `TZ=Asia/Shanghai` 的子进程用例使用真实临时 `UsageStore`：

- 唯一事件时间为 `2026-07-12T23:30:00Z`。
- UTC `2026-07-12` 汇总 `total=10`；local `2026-07-13` 汇总同样为 `total=10`，两 zone 独立存在。
- local range 查询传入该 home 的 `excludeHomes`，返回全零，证明 zone 查询仍支持 home 过滤。

该卡未覆盖 DST 遍历或其他时区；`local` 语义依赖进程 `TZ`，与现有 store local 口径一致。

## C1-zone-transfer：跨进程时区不读旧 local

`usage_rollup_days` 已保存 `calendar_zone/day_key/start_ms/end_ms`。查询时现在同时验证：

1. `(calendar_zone, day_key)` 标记存在。
2. `start_ms/end_ms` 等于当前进程 `dayBounds(day, calendarZone)` 的结果。

任一不符都按未构建处理：day 查询返回 `null`，range 查询把该日放入 `ROLLUP_DAYS_MISSING`。UTC 标记只比较 UTC 边界，不受进程 `TZ` 影响。

同一临时数据库的两个子进程用例：

- 上海进程（`TZ=Asia/Shanghai`）导入 `2026-07-12T23:30Z` 事件，重建 UTC `07-12` 与 local `07-13`。
- UTC 进程（`TZ=UTC`）读取旧 local `07-13`：day 查询返回 `null`，range 查询明确缺该日。
- 同一 UTC 进程读取 UTC `07-12` 仍得到 `total=10`。
- UTC 进程重新重建 local `07-12`/`07-13` 后，事件落在 local `07-12`，`07-13` 为空日，均可读。

该用例只覆盖上海→UTC 迁移；不新增全局时区配置、DST 遍历或其他维度。

## C1-DST：local 非 24 小时日

在 `TZ=America/New_York` 子进程中直接使用现有 rollup 模块与临时 `events` 表，不修改生产逻辑：

| 当地日 | 起点 UTC | 末日最后 1 ms | 次日午夜 | 窗口 |
| --- | --- | --- | --- | --- |
| `2026-03-08` | `05:00Z` | `2026-03-09T03:59:59.999Z` | `04:00Z` | 23h |
| `2026-11-01` | `04:00Z` | `2026-11-02T04:59:59.999Z` | `05:00Z` | 25h |

每个窗口写入三条事件：起点 `total=10`、最后 1 ms `total=20`、次日午夜 `total=999`。重建 local 日后：

- 标记窗口长度分别精确为 23h、25h。
- 平台 `Intl` 实测 offset 从 `GMT-05:00` 切到 `GMT-04:00`（春季），以及反向（秋季）。
- day 与 range 查询都只含两条窗口内事件：`eventCount=2`、`total=30`；次日午夜不计入，也没有跨日重复。

该卡只补 DST 行为证据，不改生产代码；未扩展其他时区或历史 DST 规则。

## C1-session：day/range 精确会话数

`usage_rollup_sessions` 按 `(calendar_zone, day_key, home_id, session_id)` 存去重关系，重建时在同一事务内先删除该日关系，再从 `events` 写入 `session_id IS NOT NULL` 的不同值。查询用 `COUNT(DISTINCT session_id)`：

- day 查询按 `(calendar_zone, day_key)` 去重，因此同一 session 的多条事件只计 1。
- range 查询跨全部完整日一次性去重，因此同一 session 跨日或跨 home 仍只计 1。
- `excludeHomes` 在会话关系查询中同样生效；全部 home 排除时返回 `sessionCount=0`。
- 连续重建同一日先清后写，不会重复累计。

真实 `UsageStore` 双 home 用例改为两日、两个 home 共用同一 `session_id`，分别与 `store.summarize({ ..., calendarZone: "utc" })` 的过滤/全量 `sessionCount` 对拍，并断言全区间 `sessionCount=1`、排除全部 home 后为 0。单日/跨日移动用例覆盖同 session 两事件、不同 session 两事件和 NULL session 排除。

## C1-version：旧派生缓存拒读与按事实重建

`usage_rollup_format` 只有一行。C1-version 当时为 `(id=1, format_version=2)`，C1-detail-count 当时升到 `3`，C1-detail-input-output 升到 `4`，C1-detail-cached-reasoning 升到 `5`，C1-detail-combined 升到 `6`，C2-model-day 当前值为 `7`，与 store 的 `user_version` 完全独立。查询在读取 marker 前先检查版本：

- 版本表不存在、行缺失或 `format_version` 不是当前值（现为 `7`）：day 查询返回 `null`，range 查询把区间内全部日放入 `ROLLUP_DAYS_MISSING`；dirty 日读取抛 `ROLLUP_CACHE_MISSING`，不自动建表。
- `rebuildUsageRollups` 与 `createUsageRollups` 遇到非当前格式时，在同一 SAVEPOINT 内先删除三个失效触发器及 `usage_rollup_models`、`usage_rollup_daily`、`usage_rollup_sessions`、`usage_rollup_dirty_days`、`usage_rollup_days`、`usage_rollup_format`，再创建当前结构；不会把旧 marker 直接贴成新版本，失败时旧版本与旧 marker 一起保留。
- 删除范围仅限派生缓存；`events` 与 store 业务表不参与 DDL/DML。

回归用例先构造旧形状数据库：`usage_rollup_days` 有 UTC `2026-07-12` 的有效边界 marker，`usage_rollup_daily` 有对应汇总行，但不存在 sessions 表与版本表。断言：

1. day 查询返回 `null`，range 查询明确报缺该日，而不是返回 `sessionCount=0`。
2. 再写入未知版本 `999` 后仍拒读。
3. `rebuildUsageRollups` 后同日返回 `eventCount=1`、`sessionCount=1` 与正确 token 合计。
4. 重建前后 `SELECT * FROM events ORDER BY timestamp_ms` 逐字段相等，事实表未变。

## C1-home-count：跨日精确 home 数

`homeCount` 不存入每日汇总行，也不对每日 `COUNT(DISTINCT home_id)` 求和。day/range 查询在同一 SAVEPOINT 读快照内直接对 `usage_rollup_daily` 的有效行执行 `COUNT(DISTINCT home_id)`，并要求 `event_count > 0`：

- 同一 home 跨两日只计 1。
- 空 built 日没有 daily 行，不贡献 home。
- `excludeHomes` 同时过滤 daily 与 session 查询，因此 home/session/token/event 均基于同一剩余范围。
- 全部 home 排除时为 0。

复用两日、两 home、共用 session 的 `UsageStore` 夹具，重建 `2026-07-12..2026-07-14`（第三日为空）后：

1. day `2026-07-12` 与 range 全量分别与 `store.aggregateRange` 的 `event_count/session_count/home_count` 及五项 token 逐字段相等。
2. 排除第一个 home 与排除全部 home 两轮，也逐字段与 `aggregateRange` 对拍；全部排除时 `homeCount=0`。
3. 两日全量 `homeCount=2`，同 home 跨日没有被重复累计；空日没有增加 home。

## C1-nested：加入调用方事务与原子格式升级

`createUsageRollups` 和 `rebuildUsageRollups` 不再使用顶层 `BEGIN IMMEDIATE`/`COMMIT`，而是共用：

```text
SAVEPOINT usage_rollups_write
  ensureCurrentRollupFormat
  delete/insert daily + sessions + marker
RELEASE usage_rollups_write
```

失败时 `ROLLBACK TO` 后 `RELEASE`，再原样抛出。由于 SAVEPOINT 可嵌套，调用方已有事务时重建会加入该事务；调用方最终 `ROLLBACK` 时，事实修改与缓存升级一起消失。格式升级位于同一 SAVEPOINT 内，旧格式清理与新结构创建不会留下半套状态。

两条核心用例：

1. 真实外层 `BEGIN` 内修改一条事件并重建，查询看到新值；外层 `ROLLBACK` 后，事件与旧缓存均恢复为修改前的值。
2. 旧格式 `format_version=999` + 有效旧 marker，在测试侧包装 `db.prepare`，于新 `usage_rollup_daily` 首次准备 INSERT 时安装真实 `BEFORE INSERT` 触发器。实际 `run` 抛 SQLite `ABORT` 后：
   - 旧 `format_version=999` 与旧 marker 仍存在；
   - `events` 仍为 1 行；
   - 外层事务仍可执行 SQL；
   - 测试 `finally` 恢复原始 `prepare`。

## C1-detail-count：逐位 known 事件与非零 reconciliation gap

该卡施工时 rollup 缓存格式升到 v3；随后 C1-detail-input-output 升到 v4、C1-detail-cached-reasoning 升到 v5、C1-detail-combined 升到 v6，并保留下列五列。`usage_rollup_daily` 每个 `(calendar_zone, day_key, home_id)` 行新增五个整数列：

```sql
input_known_count INTEGER NOT NULL,
cached_known_count INTEGER NOT NULL,
output_known_count INTEGER NOT NULL,
reasoning_known_count INTEGER NOT NULL,
reconciliation_gap_count INTEGER NOT NULL
```

重建 SQL 对每个事件独立判定位，不保存或累加 `detail_mask`：

```sql
COUNT(CASE WHEN (detail_mask & 1) != 0 THEN 1 END) AS input_known_count,
COUNT(CASE WHEN (detail_mask & 2) != 0 THEN 1 END) AS cached_known_count,
COUNT(CASE WHEN (detail_mask & 4) != 0 THEN 1 END) AS output_known_count,
COUNT(CASE WHEN (detail_mask & 8) != 0 THEN 1 END) AS reasoning_known_count,
COUNT(CASE WHEN reconciliation_gap != 0 THEN 1 END) AS reconciliation_gap_count
```

day/range 查询返回 `inputKnownCount`、`cachedKnownCount`、`outputKnownCount`、`reasoningKnownCount`、`reconciliationGapCount`，range 只累加各 home 行；`excludeHomes` 同时过滤这些计数。现有 store 的 `aggregateRange` 映射只取既有 token/event/session/home 字段，因此公开 summary 形状未因新增列改变。

定向用例写入同一天的三个事件：

| 事件 | home | `detail_mask` | `reconciliation_gap` | 贡献 |
| --- | --- | ---: | ---: | --- |
| A | `home-a` | 5（input + output） | 0 | input、output known |
| B | `home-a` | 10（cached + reasoning） | 0 | cached、reasoning known |
| C | `home-b` | 16（inconsistent） | 40 | 非零 gap |

测试先以原 SQL 的 `COUNT(CASE ...)` 作 oracle，逐项断言四项 known 各为 1、gap count 为 1；再验证 day、range、排除 `home-a`、排除 `home-b` 四路结果的计数与 home 过滤一致。若把 mask 当可加值，三个 mask 会得到错误的全 known，原 SQL 对拍与排除断言会失败。

该卡只覆盖独立 rollup 接口与 `UsageStore` 的既有映射；未把新增计数接入费用、`periodComparison` 或浏览器，也未证明公开 API 已消费这些字段。

## C1-format2-upgrade：真实 v2 缓存升级到 v3

该卡接受的用例直接构造 v2 的完整缓存形状，而不是只写一个未知版本号：

- `usage_rollup_format(id=1, format_version=2)`；
- `usage_rollup_days`、旧列形状的 `usage_rollup_daily`、`usage_rollup_sessions`、`usage_rollup_dirty_days`；
- `usage_rollup_invalidate_insert/update/delete` 三个真实事实失效触发器；
- 一条有效 v2 UTC day marker 和一条故意错误的旧 daily 行（`event_count=99`、`total=999`）；
- 三个带 `detail_mask=5/10/16` 与 `reconciliation_gap=40` 的真实事件。

用例当时只做三条断言：

1. 在 v2 格式下调用 `queryUsageRollups`，day 查询返回 `null`，不会读取旧汇总。
2. 调用 `rebuildUsageRollups` 后，一个 deep assertion 同时锁定 `events` 全表逐字段未变，以及 v3 结果：`eventCount=3`、`sessionCount=3`、`homeCount=2`、`total=170`、四项 known 各 1、`reconciliationGapCount=1`。
3. 再次重建同一日，查询结果与第一次逐字段相等，证明清空/重建幂等。

升级仍复用 `ensureCurrentRollupFormat` 的 SAVEPOINT：检测到非当前格式后删除旧派生表与触发器，再从 `events` 构建当前结构；没有新增迁移框架、版本链或后台任务。主审在 07:45 以精确名称 `upgrades a real v2 cache` 独立通过 `1/1`、`146.9619ms`，接受当时实际的 v2→v3 模块升级。

C1-detail-input-output 落地后，同一用例改名为 `upgrades a real v2 cache to v4 without changing facts`，并由主审接受 v4 输入/输出指标。C1-detail-cached-reasoning 升到 v5，C1-detail-combined 升到 v6，C2-model-day 升到 v7；用例改名为 `upgrades a real v2 cache to v7 without changing facts`，从 v2 直接重建到当前 v7，并在同一个 deep assertion 中覆盖全部 token 期望。这证明实际 v2 缓存可升级到当前格式，但不单独证明 v3→v4、v4→v5、v5→v6 或 v6→v7 的中间版本路径；通用版本链、并发升级与崩溃恢复仍未覆盖。

## C1-detail-input-output：日级输入/输出 known 与 unavailable token

该卡当时把 `FORMAT_VERSION` 升到 4，并在既有 raw `reasoning` 列之后新增四个整数列：

```sql
input_known_tokens INTEGER NOT NULL,
input_unavailable_tokens INTEGER NOT NULL,
output_known_tokens INTEGER NOT NULL,
output_unavailable_tokens INTEGER NOT NULL
```

重建时逐事件复用 store `periodAggregate` 的 `CASE` 语义，不从 raw 合计反推：

```sql
SUM(CASE WHEN (detail_mask & 1) != 0 THEN input ELSE 0 END) AS input_known_tokens,
SUM(CASE WHEN (detail_mask & 1) = 0 THEN total ELSE 0 END) AS input_unavailable_tokens,
SUM(CASE WHEN (detail_mask & 4) != 0 THEN output ELSE 0 END) AS output_known_tokens,
SUM(CASE WHEN (detail_mask & 4) = 0 THEN total ELSE 0 END) AS output_unavailable_tokens
```

day/range 查询返回 `inputKnownTokens`、`inputUnavailableTokens`、`outputKnownTokens`、`outputUnavailableTokens`。range 逐 home 行求和，`excludeHomes` 同时过滤这四个字段。既有 raw `input`/`output`、known 事件计数、事实 schema 21 与 store 的 `aggregateRange` 映射均未改变，因此公开 summary 形状不受影响。

核心用例仍使用 C1-detail-count 的三条事件：

| 查询 | 输入 known | 输入 unavailable | 输出 known | 输出 unavailable |
| --- | ---: | ---: | ---: | ---: |
| 全部 home | 80 | 90（50+40） | 20 | 90（50+40） |
| 排除 `home-a` | 0 | 40 | 0 | 40 |
| 排除 `home-b` | 80 | 50 | 20 | 50 |

测试把四个 `SUM(CASE ...)` 加入原 SQL oracle，并让 day、range、两种 home 排除共用同一组 detail 字段断言。默认 `detail_mask=0` 的旧夹具期望 known 为 0、unavailable 等于 raw total；完整 project-log 事件期望 known 等于 raw input/output、unavailable 为 0。

该卡只覆盖独立 rollup 接口；未接主查询、费用、其他维度、迁移框架或浏览器。当时没有独立的 v3→v4 定向用例，v2→v4 用例只证明直接重建结果正确。主审已独立通过 rollups `21/21`（`1034.6039ms`），接受当前四项输入/输出指标，不冒充主查询接线或专门的 v3→v4 夹具。

## C1-detail-cached-reasoning：日级 cached/reasoning known 与 unavailable token

该卡施工时 `FORMAT_VERSION=5`；C1-detail-combined 已升到 v6，并保留下列四列。`usage_rollup_daily` 在输入/输出四列之后新增：

```sql
cached_known_tokens INTEGER NOT NULL,
cached_unavailable_tokens INTEGER NOT NULL,
reasoning_known_tokens INTEGER NOT NULL,
reasoning_unavailable_tokens INTEGER NOT NULL
```

重建时逐事件复用 store `periodAggregate` 的 bit2/bit8 `CASE` 语义：

```sql
SUM(CASE WHEN (detail_mask & 2) != 0 THEN cached ELSE 0 END) AS cached_known_tokens,
SUM(CASE WHEN (detail_mask & 2) = 0 THEN total ELSE 0 END) AS cached_unavailable_tokens,
SUM(CASE WHEN (detail_mask & 8) != 0 THEN reasoning ELSE 0 END) AS reasoning_known_tokens,
SUM(CASE WHEN (detail_mask & 8) = 0 THEN total ELSE 0 END) AS reasoning_unavailable_tokens
```

day/range 查询返回 `cachedKnownTokens`、`cachedUnavailableTokens`、`reasoningKnownTokens`、`reasoningUnavailableTokens`。range 逐 home 行求和，`excludeHomes` 同时过滤这四个字段。既有 raw `cached`/`reasoning`、known 事件计数、事实 schema 21 与 store 的 `aggregateRange` 映射均未改变。

复用 C1-detail-count 的三条事件，并把事件 A 的 raw `cached`/`reasoning` 改为 `2`/`3`、事件 B 的 raw `reasoning` 改为 `7`，使 bit2/bit8 未知但 raw 非零：

| 事件 | home | `detail_mask` | raw `cached` | raw `reasoning` | 贡献 |
| --- | --- | ---: | ---: | ---: | --- |
| A | `home-a` | 5 | 2 | 3 | cached/reasoning 均未知，但 raw 非零 |
| B | `home-a` | 10 | 5 | 7 | cached/reasoning known，known/raw 确有差异 |
| C | `home-b` | 16 | 0 | 0 | cached/reasoning 均未知 |

| 查询 | cached known | cached unavailable | reasoning known | reasoning unavailable |
| --- | ---: | ---: | ---: | ---: |
| 全部 home | 5 | 120（80+40） | 7 | 120（80+40） |
| 排除 `home-a` | 0 | 40 | 0 | 40 |
| 排除 `home-b` | 5 | 80 | 7 | 80 |

测试把四个 `SUM(CASE ...)` 加入原 SQL oracle，并让 day、range、两种 home 排除共用同一组 detail 字段断言。raw cached/reasoning 合计为 `7/10`，而 known 为 `5/7`；若错误地用 raw 合计填充 known，事件 A 的 `2/3` 会让断言直接失败。默认 `detail_mask=0` 的旧夹具期望 known 为 0、unavailable 等于 raw total；完整 project-log 事件期望 known 等于 raw cached/reasoning、unavailable 为 0。v2 缓存直接重建到 v6 的 deep assertion 同时锁定 cached/reasoning 为 `5/120` 与 `5/120`，以及事实逐字段不变。

该卡只覆盖独立 rollup 接口；未扩费用、维度汇总、主查询或浏览器。当前没有独立的 v4→v5 或 v5→v6 定向用例，v2→v6 用例只证明直接重建结果正确。

## C1-detail-combined：补齐 periodAggregate 剩余组合指标

`FORMAT_VERSION=6`。`usage_rollup_daily` 继续新增七个整数列，逐事件复刻 store `periodAggregate` 的剩余字段：

```sql
uncached_input_tokens INTEGER NOT NULL,
uncached_input_unavailable_tokens INTEGER NOT NULL,
cache_rate_input_tokens INTEGER NOT NULL,
cache_rate_cached_tokens INTEGER NOT NULL,
unattributed_detail_tokens INTEGER NOT NULL,
inconsistent_tokens INTEGER NOT NULL,
reconciliation_gap_tokens INTEGER NOT NULL
```

重建 SQL 直接复用相同表达式，不在查询期重新组合：

```sql
SUM(CASE WHEN (detail_mask & 3) = 3 THEN MAX(input - cached, 0) ELSE 0 END) AS uncached_input_tokens,
SUM(CASE WHEN (detail_mask & 3) != 3 THEN total ELSE 0 END) AS uncached_input_unavailable_tokens,
SUM(CASE WHEN (detail_mask & 3) = 3 THEN input ELSE 0 END) AS cache_rate_input_tokens,
SUM(CASE WHEN (detail_mask & 3) = 3 THEN cached ELSE 0 END) AS cache_rate_cached_tokens,
SUM(CASE WHEN (detail_mask & 15) != 15 THEN total ELSE 0 END) AS unattributed_detail_tokens,
SUM(CASE WHEN (detail_mask & 16) != 0 THEN total ELSE 0 END) AS inconsistent_tokens,
SUM(reconciliation_gap) AS reconciliation_gap_tokens
```

day/range 查询返回 `uncachedInput`、`uncachedInputUnavailableTokens`、`cacheRateInput`、`cacheRateCached`、`unattributedDetailTokens`、`inconsistentTokens`、`reconciliationGap`。range 逐 home 行求和；`excludeHomes` 沿用同一过滤。既有 `reconciliationGapCount` 仍是非零事件数，与新 `reconciliationGap` 的 gap 总和是两个不同字段。

复用三条原事件并新增事件 D（`home-b`、`detail_mask=3`、`total=90`、`input=10`、`cached=20`、`output=30`、`reasoning=4`），专门锁定 `MAX(input - cached, 0)` 不产生负数，同时 `uncachedInputUnavailableTokens` 不为该事件贡献：

| 指标 | 全部 home | 排除 `home-a` | 排除 `home-b` |
| --- | ---: | ---: | ---: |
| `uncachedInput` | 0 | 0 | 0 |
| `uncachedInputUnavailableTokens` | 170（80+50+40） | 40 | 130（80+50） |
| `cacheRateInput` | 10 | 10 | 0 |
| `cacheRateCached` | 20 | 20 | 0 |
| `unattributedDetailTokens` | 260 | 130 | 130 |
| `inconsistentTokens` | 40 | 40 | 0 |
| `reconciliationGap` | 40 | 40 | 0 |

测试把七个 `SUM(CASE ...)`/`SUM(reconciliation_gap)` 加入原 SQL oracle，并对 day、range、两种 home 排除复用同一组字段断言；v2 直接重建到 v6 的 deep assertion 同时覆盖新字段。若把 `MAX` 去掉或把 mask-3 误判为 unavailable，事件 D 会让 `uncachedInput` 或 unavailable 断言失败；若把 `reconciliationGap` 与事件 count 混用，40 与 1 会直接不等。

该卡只补独立 rollup 的日级派生行为；未接主查询、费用、维度、公开 summary 或浏览器。没有独立 v5→v6 夹具，v2→v6 只证明直接重建。

## C1-detail-store-parity：真实 store 原 SQL 对拍

该卡只改 `test/history-parity.test.js`，不改 `src/usage-rollups.js`。复用 C0.4 的三条真实 project-log detail 事件，拆到两个 home：

- `log-a`：事件 A（`mask=5`，`total=100`、`input=80`、`output=20`）与事件 C（`mask=16`，`total=40`、`input=0`、`output=0`，gap 40）；
- `log-b`：事件 B（`mask=10`，`total=50`、`cached=5`、`reasoning=5`）。

真实 `UsageStore.sync()` 建出完整 UTC 日 rollup。对拍范围是 `[2026-07-12T00:00:00.000Z, 2026-07-13T00:00:00.000Z)`；`queryUsageRollupsRange` 直接使用半开边界，`store.periodAggregate(null, ...)` 的原 SQL 则传 `end = 2026-07-12T23:59:59.999Z`。两侧都覆盖 16 个 token/detail 字段，并由手算对象独立校验，不只依赖共享字段 helper。

| 指标 | 全部 home | 排除 `log-a` |
| --- | ---: | ---: |
| `total` | 190 | 50 |
| `input` | 80 | 0 |
| `inputUnavailableTokens` | 90 | 50 |
| `cached` | 5 | 5 |
| `cachedUnavailableTokens` | 140 | 0 |
| `uncachedInput` | 0 | 0 |
| `uncachedInputUnavailableTokens` | 190 | 50 |
| `cacheRateInput` / `cacheRateCached` | 0 / 0 | 0 / 0 |
| `output` | 20 | 0 |
| `outputUnavailableTokens` | 90 | 50 |
| `reasoning` | 5 | 5 |
| `reasoningUnavailableTokens` | 140 | 0 |
| `unattributedDetailTokens` | 190 | 50 |
| `inconsistentTokens` | 40 | 0 |
| `reconciliationGap` | 40 | 0 |

第一个核心断言把 `rollupAll`、`rollupExcluded`、`oracleAll`、`oracleExcluded` 与上述手算对象一起比较；若把 known 与 unavailable 混用，或把 gap 总和与 gap 事件数混用，会直接不等。第二个核心断言在再次 `rebuildUsageRollups` 后比较完整 range 对象与重建前相等。

## C2-model-day：按 day/home/model 持久化并查询单一 UTC 日

该卡只改 `src/usage-rollups.js`、`test/usage-rollups.test.js` 与本报告；`test/history-parity.test.js` 冻结，未接 store、费用、仓库、partial window 或 session 关系。

`FORMAT_VERSION` 升到 `7`。`rebuildUsageRollups` 只在本次重建目标日集合非空时，于既有同一写 SAVEPOINT 内创建 `usage_rollup_models`，主键为 `(calendar_zone, day_key, home_id, model)`，保存 `periodAggregate` 的 16 项字段：`total`、known/unavailable 的 input/cached/output/reasoning、uncached input、cache rate、unattributed、inconsistent 与 reconciliation gap。表的 `input`/`cached`/`output`/`reasoning` 是 known-only 值，不是 raw 合计；`input` 等 `CASE` 表达式与日表共用同一组 `DETAIL_SUM` SQL，未复制第二套业务公式。

同一事务先删除该 zone/day 的旧 model 行，再按 `home_id, model` 从 `events` 聚合写入；查询接缝为：

```js
queryUsageRollupModels(db, { day, excludeHomes = [], calendarZone = "utc" })
```

查询沿用完整日 marker 校验，跨 home 合并同一 model，按 `model ASC` 稳定输出；本卡只测试完整 UTC 日。旧格式、缺失日标记或缺失 model 表返回 `null`，未接 range、store 或费用接线。

测试事件：

| home | model | mask | total | input | cached | output | reasoning | gap |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `home-a` | `gpt-6-sol` | 5 | 100 | 80 | 0 | 20 | 0 | 0 |
| `home-b` | `gpt-6-sol` | 10 | 50 | 0 | 5 | 0 | 5 | 0 |
| `home-a` | `gpt-6-luna` | 16 | 40 | 0 | 0 | 0 | 0 | 40 |

核心断言：

1. 完整 UTC 日输出严格等于手算数组，两个 model 分开，且 `gpt-6-sol` 的跨 home 合计为 `total=150`、`input=80`、`cached=5`、`output=20`、`reasoning=5`。
2. 排除 `home-a` 后只剩 `gpt-6-sol` 的 `home-b` 行；再次重建后完整结果不变。
3. 将 marker 改成旧格式 `6` 后模型查询返回 `null`，并逐字段确认 `events` 未变。

该卡只覆盖一个完整 UTC 日和一个 model 分组形状；未验证 local/DST、range、store 接线、费用、仓库、partial window 或 session 关系。主审已独立运行 model+v2 定向用例 `2/2`（`193.6503ms`）并接受本卡。

## C2-model-range：完整 UTC 日区间的 model 汇总查询

本卡只改 `src/usage-rollups.js`、`test/usage-rollups.test.js` 与本报告；不升格式，仍为 v7。新增接缝：

```js
queryUsageRollupModelsRange(
  db,
  { startDay, endDay, excludeHomes = [], calendarZone: zone = "utc" },
)
```

实现先用既有 `calendarDays` 展开并校验区间，再在同一读 SAVEPOINT 内检查当前格式、`usage_rollup_days` 与 `usage_rollup_models`。每个展开日的 `start_ms/end_ms` 必须与当前进程的日边界完全一致；任一未构建日都会抛 `ROLLUP_DAYS_MISSING`，`missingDays` 按展开顺序列出全部缺失日，函数不返回部分数组。全部日完整后才按 `model` 聚合，跨天、跨 home 合并同一 model，应用 `excludeHomes`，并以 `model ASC` 排序。

测试写入两个完整 UTC 日：

| day | home | model | mask | total | input | cached | output | reasoning | gap |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `2026-07-12` | `home-a` | `gpt-6-sol` | 5 | 100 | 80 | 0 | 20 | 0 | 0 |
| `2026-07-12` | `home-b` | `gpt-6-sol` | 10 | 50 | 0 | 5 | 0 | 5 | 0 |
| `2026-07-12` | `home-a` | `gpt-6-luna` | 16 | 40 | 0 | 0 | 0 | 0 | 40 |
| `2026-07-13` | `home-a` | `gpt-6-sol` | 15 | 30 | 10 | 3 | 17 | 2 | 0 |
| `2026-07-13` | `home-c` | `gpt-6-luna` | 0 | 20 | 0 | 0 | 0 | 0 | 0 |

核心断言：

1. 无排除时，`gpt-6-sol` 跨两日、两 home 合计 `total=180`、`input=90`、`cached=8`、`output=37`、`reasoning=7`、`uncachedInput=7`、`cacheRateInput/cacheRateCached=10/3`、`reconciliationGap=0`；`gpt-6-luna` 独立为 `total=60`、`inconsistentTokens=40`、`reconciliationGap=40`。完整对象同时锁定 16 项字段与 `model ASC` 顺序。
2. 排除 `home-a` 后，`gpt-6-sol` 只保留 `home-b` 的 `total=50`、`cached=5`、`reasoning=5`，`gpt-6-luna` 只保留 `home-c` 的 `total=20`；排除条件在 SQL 聚合前生效，不依赖 JS 事后扣除。
3. 已构建 `07-12`、`07-13` 后请求 `07-12..07-14`，断言错误码为 `ROLLUP_DAYS_MISSING`、`missingDays` 精确为 `["2026-07-14"]`，并确认赋值结果仍为 `undefined`，没有返回前两日的部分数组。

本卡只覆盖两个完整 UTC 日、两个 model 与三个 home；未验证 local/DST、跨月/闰日、partial/local window、store、费用、仓库、session 关系或浏览器，也未新增独立 v6→v7 升级夹具。

主审已独立运行精确 target `1/1`（`121.5805ms`）并接受本卡。

## C2-model-range-store-parity：真实 project-log → UsageStore 与 model range 逐字段对拍

本卡只改 `test/history-parity.test.js` 与本报告；`src/usage-rollups.js` 与 `src/usage-store.js` 冻结，rollup 格式仍为 v7。未新增通用 fixture，复用两个真实 project-log home 的 `.codex-usage/usage.jsonl`，经真实 `UsageStore.sync()` 写入事实并构建完整 UTC 日 rollup；事件如下：

| home | UTC timestamp | model | usage |
| --- | --- | --- | --- |
| `log-a` | `2026-07-12T02:00:00.000Z` | `gpt-6-sol` | `total=100,input=80,cached=20,output=20,reasoning=5` |
| `log-a` | `2026-07-12T23:59:59.999Z` | `gpt-6-luna` | `total=30,input=12,cached=4` |
| `log-b` | `2026-07-13T00:00:00.000Z` | `gpt-6-sol` | `total=50,output=10` |
| `log-b` | `2026-07-13T03:00:00.000Z` | `gpt-6-luna` | `total=70,input=40,cached=10,output=30` |

detail mask 由 project-log 中实际存在的字段派生，测试不手写 mask。oracle 直接调用 `store.periodAggregate("model", "model", now, ranges, { excludeHomes })`；该 SQL 的闭区间是 `timestamp_ms >= start AND timestamp_ms <= end`。rollup range 的 `[startDay, endDay]` 是半开区间，因此换算为：

- 两日：`2026-07-12..2026-07-13` ↔ oracle `[2026-07-12T00:00:00.000Z, 2026-07-14T00:00:00.000Z - 1ms]`。
- 单日：`2026-07-12..2026-07-12` ↔ oracle `[2026-07-12T00:00:00.000Z, 2026-07-13T00:00:00.000Z - 1ms]`。

核心断言：

1. 两日均不排除时，rollup 的 `model` 集合精确为 `gpt-6-luna`、`gpt-6-sol`，且每个 model 的 16 项指标与 `periodAggregate` 逐字段完全相等；不挑选字段或使用近似比较。
2. 排除 `log-a` 对应 home 后，rollup 与 oracle 在同一两日 window、同一 `excludeHomes` 下再次完全相等。
3. 单日 `07-12` 对拍 oracle 的 `07-12T23:59:59.999Z` 闭区端：`23:59:59.999Z` 的 `gpt-6-luna` 事件计入，`07-13T00:00:00.000Z` 的 `gpt-6-sol` 事件排除；两日断言再证明后者在跨日 window 中计入。

本次施工精确 target 为 `1/1`（`155.7202ms`），scoped Biome 无问题；主审已独立通过精确 target `1/1`（`163.2933ms`）并接受本卡。本卡仍不宣称主查询、费用、session、仓库、local/DST 或浏览器已接。

## C2-model-window：半开毫秒窗口的 raw/rollup 混合查询

本卡只改 `src/usage-rollups.js`、`test/usage-rollups.test.js` 与本报告；不升格式，仍为 v7。新增接缝：

```js
queryUsageRollupModelsWindow(db, { startMs, endMs, excludeHomes = [] })
```

`startMs`/`endMs` 必须是 safe integer，且 `startMs <= endMs`；查询区间固定为半开 `[startMs, endMs)`。`excludeHomes` 必须是数组。完整 UTC 日的包含范围按以下公式选择：

```text
firstFullDayStart = ceil(startMs / DAY_MS) * DAY_MS
lastFullDayEnd = floor(endMs / DAY_MS) * DAY_MS
完整日 = [firstFullDayStart, lastFullDayEnd)
```

若 `firstFullDayStart >= lastFullDayEnd`，没有完整 UTC 日可读，只查询 raw `events`。否则在同一读 SAVEPOINT 内先通过既有 range 逻辑检查并读取全部完整日；`startMs < firstFullDayStart` 时用 `[startMs, firstFullDayStart)` raw 补齐起始边缘，`lastFullDayEnd < endMs` 时用 `[lastFullDayEnd, endMs)` raw 补齐结束边缘。完整日缺缓存时抛 `ROLLUP_DAYS_MISSING`，不静默回退为 raw；raw 与 rollup 行随后按 model 合并、求和并以 `model ASC` 稳定排序。空窗口返回 `[]`。

测试写入 9 条事件，覆盖 `2026-07-12`、`07-13`、`07-14`，两个 home 与两个 model；只重建 `07-13`。查询 `[07-12T12:00:00.000Z, 07-14T02:00:00.000Z)` 因而需要读取左侧 partial raw、`07-13` 完整 rollup 与右侧 partial raw。raw oracle 使用同一半开边界和相同 detail `CASE` 表达式，逐字段对照全部 16 项指标及 model 顺序。

核心断言：

1. 混合窗口与 raw oracle 完全相等，包含 `23:59:59.999Z` 与次日 `00:00:00.000Z` 两侧边界；`excludeHomes: ["home-a"]` 后仍逐字段相等。
2. 同一完整日内的纯 partial 窗口 `[07-13T00:00:00.000Z, 07-13T13:00:00.000Z)` 不读取 rollup，直接与 raw oracle 相等。
3. 请求尚未构建的 `07-14` 时抛 `ROLLUP_DAYS_MISSING`，`missingDays` 精确为 `["2026-07-14"]`，赋值结果仍为 `undefined`，没有返回部分结果。

施工精确 target 为 `1/1`（`138.9257ms`），全量 `test/usage-rollups.test.js` 为 `24/24`（`1136.3932ms`）；scoped Biome 与 `node --check src/usage-rollups.js` 均通过。主审已读共享字段、raw 边界、日切分与单外层 SAVEPOINT，并独立通过精确 target `1/1`（`135.6643ms`）接受本卡；`src/usage-rollups.js` 现冻结供 B 接线。本卡未接 store、费用、仓库、local/DST 或 session 关系。后续若把 store `periodAggregate` 的闭区间端接入本函数，必须把闭端 `endInclusive` 转成半开端 `endInclusive + 1`，不能直接透传。

## C2-window-snapshot：完整日 cache 与 raw 边界必须同快照

本卡只改 `test/usage-rollups.test.js` 与本报告；`src/usage-rollups.js` 冻结供 `model periodAggregate` 接线使用，格式仍为 v7。复用既有 range snapshot 的临时 WAL、真实 `UsageStore` 与 `DatabaseSync.prepare` 注入方式，不新增生产 hook。

测试写入三个同 model、全字段已知的 project-log 事件：

| 位置 | timestamp | 旧 total/input/cached/output/reasoning | 新 total/input/cached/output/reasoning |
| --- | --- | --- | --- |
| 左侧 raw 边界 | `2026-07-12T13:00:00.000Z` | `20/15/5/5/2` | `200/150/50/50/20` |
| 完整日 `07-13` cache | `2026-07-13T12:00:00.000Z` | `10/7/2/3/1` | `100/70/20/30/10` |
| 右侧 raw 边界 | `2026-07-14T01:00:00.000Z` | `30/20/10/10/3` | `300/200/100/100/30` |

只重建 `2026-07-13`。窗口为 `[2026-07-12T12:00:00.000Z, 2026-07-14T02:00:00.000Z)`，因此必定读取左侧 raw、完整日 rollup 与右侧 raw。读者连接通过 Proxy 在 `usage_rollup_models` 的完整日聚合 `all()` 返回后、raw 边界读取前，确定性地让另一 WAL 连接更新三个事件并重建 `07-13` cache；插入只发生一次。

核心断言是两次完整窗口输出：

1. 第一次仍为整套旧值：`total=60`、`input=42`、`cached=17`、`uncachedInput=25`、`cacheRateInput/cacheRateCached=42/17`、`output=18`、`reasoning=6`，其余 8 项为 0。若没有同快照，就会得到旧 cache `10` + 新两侧 raw `500` 等混合结果，不能通过。
2. 上一次读结束后，下一次读为整套新值：`total=600`、`input=420`、`cached=170`、`uncachedInput=250`、`cacheRateInput/cacheRateCached=420/170`、`output=180`、`reasoning=60`，其余 8 项为 0；证明快照只在单次查询内保持，不会泄漏到后续读取。

本卡使用真实混合路径行为证明，不以 marker 仍存在、表 shape 或单独 raw/rollup 结果冒充快照一致性。施工精确 target 为 `1/1`（`161.6917ms`）；主审已独立通过精确 target `1/1`（`182.2696ms`）并接受本卡。scoped Biome 通过，按卡片未跑全套。未覆盖并发多写者、cache 重建失败、local/DST 或 store 接线。

## C2-million-model-probe：百万事件的单组长窗口测量

本卡只新增 `benchmark-model-window.mjs`、JSON 结果与本报告；生产代码、既有测试与 B 的 store 实现均冻结。原始 worker 输出现单独保存为 `benchmark-model-window-worker.json`；脚本默认输出 `benchmark-model-window.json` 已被主审复跑覆盖。两份结果都是同一脚本的实际输出，不能混称。脚本在系统临时目录使用 Node SQLite 与真实 rollup 模块，不引用 `UsageStore.periodAggregate` 作为 oracle。

数据固定种子 `0x5eed1234`，恰好 `1,000,000` 条事件。事件时间均匀落在 `2025-10-01T00:00:00.000Z` 到 `2026-10-01T00:00:00.000Z`（365 个 UTC 日）；model、home、detail mask 均匀选择，session 为 `session-0..255` 轮转。model 为 8 个、home 为 6 个，detail mask 为 `0,1,2,3,4,5,8,10,15,16,19,31`。usage 五字段与 reconciliation gap 都由同一固定 RNG 顺序生成。

固定查询窗口：

- `[2025-10-01T12:00:00.000Z, 2026-09-30T12:00:00.000Z)`
- `excludeHomes: ["home-f"]`
- 完整 UTC 日 363 个，左右各有 12 小时 raw 边缘。

运行环境为 Node `v24.19.0`、Windows `win32/x64`、OS release `10.0.26200`。两次实测：

| 项目 | Worker 原跑 | 主审复跑 |
| --- | ---: | ---: |
| 插入 1,000,000 事件 | `1058.20ms` | `1056.51ms` |
| 建立 timestamp 索引 | `335.05ms` | `334.66ms` |
| 创建 rollup schema | `67.93ms` | `64.81ms` |
| 重建 365 日 cache | `14947.63ms` | `14875.33ms` |
| cache 合计 | `15015.58ms` | `14940.16ms` |
| rollup window 冷读 | `22.19ms` | `22.46ms` |
| rollup window 温读 | `22.26ms` | `20.77ms` |
| raw 16 指标 oracle | `3563.98ms` | `3585.72ms` |
| 整脚本墙钟 | `20.38s` | 未记录 |

两次的存储记录一致：DB `132,165,632` bytes，WAL `73,785,112` bytes，SHM `163,840` bytes，DB+WAL 合计 `205,950,744` bytes；rollup 行为 daily `2,190`、models `17,520`、sessions `466,439`。冷读定义为重建后关闭并重开同一进程内的首次 window 调用；构建与 OS page cache 未清空。

`queryUsageRollupModelsWindow` 的冷、温两次输出都与直接 raw SQL 的 8 个 model、每个 16 项指标逐字段 `deepEqual`；只有该事实相等断言通过后才写出 JSON。这里只有一个固定参数组，不是正式库压力、不是整站吞吐，也不是 cold-authority 延迟；DB 为最小 rollup events schema，不代表完整 store 表宽。脚本结束时关闭连接并删除临时库。

脚本命令两次实际 exit 0，`node --check` 通过。`docs/validation` 被项目 Biome 配置忽略，因此本卡没有把“Biome checked”写成已执行结果。两份结果分别见 `benchmark-model-window-worker.json` 与 `benchmark-model-window.json`，各自包括 8 行完整 16 字段输出。

## C2-million-store-probe：正式 schema 21 的百万行宽测量

本卡已由主审接受。原始 worker 输出现单独保存为 `benchmark-model-store-worker.json`；脚本默认输出 `benchmark-model-store.json` 已被主审复跑覆盖。两份结果是同一脚本的两次实际运行，不能混称。本卡只新增 `benchmark-model-store.mjs`、上述 JSON 与本报告；生产代码与既有测试冻结。脚本用 `new UsageStore({ homeDir: 临时目录, env: {}, importDirs: [], databaseFile: 临时目录/usage-index.sqlite })` 后 `await open()` 建立正式 schema 21，不发现现场源、不调用 `sync()`，也不依赖 B 的 public 入口或 `UsageStore.periodAggregate` 作为 oracle。

数据集沿用窄 probe 的固定种子 `0x5eed1234` 与完全相同的 RNG 调用顺序：恰好 `1,000,000` 事件、365 个 UTC 日、8 model、6 home、12 detail mask、`session-0..255`。额外字段不消耗 RNG：预置 6 个 `source_files`，每个事件填写正式 schema 的全部必需列，`source_path` 与 home 对应，hour/week/month key 由 UTC 日派生，cache-write/context/service-tier/repository 字段使用固定值。

运行环境仍为 Node `v24.19.0`、Windows `win32/x64`、OS release `10.0.26200`。两次实测：

| 项目 | Worker 原跑 | 主审复跑 |
| --- | ---: | ---: |
| `PRAGMA user_version` | `21` | `21` |
| store 初开（空库建 schema） | `26.07ms` | `25.81ms` |
| store 重开 | `2.06ms` | `1.88ms` |
| 插入 1,000,000 条完整事件 | `17632.19ms` | `17553.82ms` |
| 创建 rollup schema | `107.83ms` | `126.02ms` |
| 重建 365 日 cache | `25196.60ms` | `23347.94ms` |
| cache 合计 | `25304.47ms` | `23474.00ms` |
| rollup window 冷读 | `27.24ms` | `26.74ms` |
| rollup window 温读 | `25.81ms` | `24.47ms` |
| raw 16 指标 oracle | `5553.19ms` | `5549.35ms` |
| 整脚本墙钟 | `46.05s` | 未记录 |

真实存储：DB `477,016,064` bytes，WAL `67,108,864` bytes，SHM `851,968` bytes，DB+WAL 合计 `544,124,928` bytes；journal 为 WAL，`synchronous=2`（FULL），`journal_size_limit=67,108,864`，page size 4096。rollup 行数与窄 probe 相同：daily `2,190`、models `17,520`、sessions `466,439`。

对照最小行宽 probe（`benchmark-model-window-worker.json`）：DB 从 `132,165,632` 增至 `477,016,064` bytes，DB+WAL 从 `205,950,744` 增至 `544,124,928` bytes（约 `2.64×`）；rollup window 冷读从 `22.19ms` 增至 `27.24ms`。这是正式行宽、正式索引与 store 默认 `synchronous=FULL` 等共同影响，不是纯行宽系数，也不是受控 A/B。

两次运行的 `queryUsageRollupModelsWindow` 冷、温输出都与正式 schema 上直接 raw SQL 的 8 model、每个 16 项指标逐字段 `deepEqual`；只有该断言通过后才写出 JSON。脚本结束关闭 store 并删除临时目录。本卡仍未覆盖现场来源发现、`sync()`、B public 入口、并发、多配置、浏览器或 cold-authority。

## C2-million-process-probe：三个独立子进程与 WAL truncate

本卡只扩 `benchmark-model-store.mjs` 的内部 `--process` 子模式，并更新本报告；生产模块与既有测试冻结。默认命令和 `benchmark-model-store.json` 输出路径保持不变。原始 worker 输出现单独保存为 `benchmark-model-process-worker.json`；脚本默认输出 `benchmark-model-process.json` 已被主审复跑覆盖。两份结果是同一脚本的两次实际运行，不能混称。父进程用与 store probe 相同的固定种子和 RNG 顺序建立恰好 `1,000,000` 行正式 schema 21，再直接执行同一 raw 16 指标 SQL 得到固定 oracle；该 oracle 不含 `UsageStore.periodAggregate`。

父进程随后同时启动恰好三个独立 Node 子进程。每个子进程只创建 `new UsageStore({ homeDir: 临时目录, env: {}, importDirs: [], databaseFile })`、`await open()`、调用 `queryUsageRollupModelsWindow` 一次；0 号子进程在此后连续调用 10 次。父进程逐个解析子进程 stdout，并断言三个 process-cold 输出与十次温读输出全部等于同一 raw oracle。子进程 stderr 均为空，退出码均为 0。

主审复跑已接受；worker 与主审复跑的关键值如下：

| 项目 | Worker 原跑 | 主审复跑 |
| --- | ---: | ---: |
| 0/1/2 号 process-cold `openMs` | `3.86 / 3.01 / 3.64ms` | `3.33 / 3.00 / 2.88ms` |
| 0/1/2 号 process-cold `queryMs` | `29.31 / 31.03 / 31.40ms` | `28.99 / 30.91 / 30.29ms` |
| 0/1/2 号 `maxRSS`（KiB） | `83,976 / 79,376 / 80,208` | `84,460 / 79,972 / 80,080` |
| 0/1/2 号结束时 RSS（bytes） | `83,939,328 / 79,929,344 / 80,252,928` | `84,422,656 / 79,917,056 / 80,019,456` |
| 温读 nearest-rank `p50 / p95` | `22.1165 / 25.9829ms` | `21.8659 / 24.8107ms` |
| WAL truncate 耗时 | `4.50ms` | `4.59ms` |
| 3 份冷输出 + 10 份温读等于 oracle | 是 | 是 |

这里只有一组 10 次样本，不是稳定的生产分位数。

Node API 文案称 `process.resourceUsage().maxRSS` 为 kilobytes；本次运行时按 `×1024` 与 bytes RSS 对齐，因此报告明确记为 KiB，而不是 bytes。独立启动检查得到 `maxRSS=65,772` 与 `process.memoryUsage().rss=67,325,952` bytes，量级与 `65,772 × 1024` 一致；JSON 同时保存 `maxRssKiB`、派生 `maxRssBytes` 和结束时 `rssBytes`，不把原始值误写成 bytes。

两次运行中，所有子进程退出后，父进程只执行一次 `PRAGMA wal_checkpoint(TRUNCATE)`，均返回 `busy=0`、`logPages=0`、`checkpointedPages=0`；DB 保持 `477,016,064` bytes，WAL 从 `67,108,864` bytes 截断为 `0` bytes。零页返回与 WAL 文件从预分配大小截到 0 同时成立，不能据此推断没有发生 truncate。脚本 `finally` 终止仍未退出的子进程、关闭父 store、删除临时目录；实测无 `codex-model-store-benchmark-*` 目录残留。

这里的“process-cold”只表示每个独立进程 `open()` 后的首次 window 调用；OS page cache 与磁盘缓存均未驱逐，因此不是 physical cold disk、cold-authority、整站吞吐或生产 SLA。正式 schema 与窄 schema 的耗时差还包含行宽、索引、WAL/`synchronous` 等共同因素，不能解释为纯行宽因果。

## C2-million-dashboard-probe：百万行 summary 的 loopback 实测

本卡只扩 `benchmark-model-store.mjs` 的内部 `--dashboard` 子模式，新增 `benchmark-model-dashboard.json`，并更新本报告；生产模块与既有测试冻结。脚本复用同一固定种子，写入恰好 `1,000,000` 行正式 schema 21，并用 v7 rollup 预构建 `365` 个 UTC 日；随后关闭 seed store，用隔离临时 `importStoreFile`、`pricingFile` 与 `automaticPricingFile` 启动真实 `createUsageServer`，监听 `127.0.0.1:0`，并关闭自动定价发现。

独立 SQL oracle 与三次响应均为：

| 指标 | 值 |
| --- | ---: |
| event / metadata event | `1,000,000 / 1,000,000` |
| session / home | `256 / 6` |
| total | `2,526,208,168` |
| input | `1,642,750,198` |
| cached | `656,167,060` |
| output | `883,457,970` |
| reasoning | `176,040,976` |

请求均为 HTTP 200、`83,083` bytes，且五项 token、计数与 oracle 逐字段相等：

| 请求 | 耗时 | 说明 |
| --- | ---: | --- |
| 首次 checked `preset=all` | `191,523.06ms` | 含 executor 启动、首次 sync、缺失来源保留与 summary 生成 |
| 第二次 checked `preset=all` | `144,626.34ms` | `checkedAt` 从 `19:02:40.186Z` 变为 `19:05:51.675Z`，不是 skipCheck 缓存读 |
| `preset=all&skipCheck=1` | `121,897.32ms` | 跳过正常 check，但仍重新生成 summary；沿用第二次 `checkedAt` |

三次响应都保留同一组 6 个虚构缺失来源 `/benchmark/home-a..f/usage.jsonl`，没有因 summary 生成丢失覆盖提示。

**关键边界：** 在未修改生产代码的首次尝试中，默认 executor timeout `120,000ms` 使首次 dashboard 请求在观测 `159,114.11ms` 后返回 HTTP 500 `EXECUTOR_TIMEOUT`。为完成本 probe，`--dashboard` 仅在 benchmark 进程内包装 `globalThis.setTimeout`，把精确的 `120000ms` 延迟改为 `600000ms`，并在 JSON 的 `server.executorTimeoutOverride` 中披露。上述成功耗时超过生产 guard，因此不代表默认生产配置下的正常行为。

seed store 关闭后、server 请求前为 DB `477,016,064`、WAL `67,108,864`、SHM `851,968` bytes；三次请求后为 DB `522,833,920`、WAL `0`、SHM `98,304` bytes；`await server.close()` 后为 DB `522,833,920`、WAL `0`、SHM `0` bytes。DB/WAL 变化包含 SQLite checkpoint 与 summary 写入的共同影响，不能归因为单一原因。server create/listen/close 分别为 `2.44 / 21.59 / 6.66ms`；关闭 await 返回时 executor 已释放数据库连接。

整 benchmark 进程的 `maxRSS=1,152,812KiB`（`1,180,479,488` bytes），结束时 `rssBytes=1,125,785,600`；该高水位包含百万行 seed，不是 server-only 内存。脚本 `finally` 删除临时 home；本次验证未发现残留 `codex-model-store-benchmark-*` 目录。

## C2-million-after-cache：默认 timeout 下的 checked 与 skipCheck

本卡只改 `benchmark-model-store.mjs`、新增 `benchmark-model-dashboard-after-cache.json` 并更新本报告；生产模块、server、store、rollup、UI 与既有测试均未改。新增 `--dashboard-after-cache` 是独立子模式，既有 `--dashboard` 仍保留原先的三次请求与 `600,000ms` benchmark override，输出文件也不变。新流程只允许一次 `preset=all` checked 请求；仅当它成功后才发一次 `preset=all&skipCheck=1`，不自动重试。`timedDashboardSummary()` 的 `allowFailure` 仅在新模式启用，HTTP 非 200 或非法 JSON 会写入 JSON，供报告区分 timeout/error 与业务断言失败；既有 probe 仍在失败时直接抛出。

该次 `--dashboard-after-cache` 退出 0，默认 `120,000ms` executor timer 未覆盖（`executorTimeoutOverridden=false`），两次请求均为 HTTP 200、`83,110` bytes：

| 请求 | 本次耗时 | 结果 |
| --- | ---: | --- |
| 首次 checked `preset=all` | `141,217.44ms` | 计数与五项 token 等于 SQL oracle |
| `preset=all&skipCheck=1` | `103,419.98ms` | 计数与五项 token 等于 SQL oracle |

独立 SQL oracle 与两份响应一致：`eventCount=metadataEventCount=1,000,000`、`sessionCount=256`、`homeCount=6`，`total/input/cached/output/reasoning` 分别为 `2,526,208,168 / 1,642,750,198 / 656,167,060 / 883,457,970 / 176,040,976`。两次响应都保留同一组 6 个缺失来源；`skipCheck` 的 `checkedAt=2026-10-22T23:08:32.859Z` 与首次完全相同。

与旧 `benchmark-model-dashboard.json` 的单次参考相比，首次 checked 从 `191,523.06ms` 降到 `141,217.44ms`（`-50,305.62ms`），`skipCheck` 从 `121,897.32ms` 降到 `103,419.98ms`（`-18,477.33ms`）。旧参考使用了 `600,000ms` override，本次没有；差值只描述这两次运行，不是 SLA、吞吐或 cache 命中率证明。

存储与内存实际值：

| 时点 | DB bytes | WAL bytes | SHM bytes |
| --- | ---: | ---: | ---: |
| seed 后、server 前 | `477,016,064` | `67,108,864` | `851,968` |
| 请求前 | `477,016,064` | `0` | `0` |
| 两次请求后 | `522,833,920` | `0` | `98,304` |
| `await server.close()` 后 | `522,833,920` | `0` | `0` |

整个 benchmark 进程的 `maxRSS=1,037,012KiB`（`1,061,900,288` bytes），包含百万行 seed，不是 server-only 内存。seed insert/cache create/cache rebuild 分别为 `21,047.47 / 120.79 / 27,986.41ms`；server close 为 `4.57ms`。

**Timeout 边界：** 本次未观察到 `EXECUTOR_TIMEOUT`，但不能据此说单次 executor 消息可以运行超过 `120s`。`src/usage-executor.js` 的 timer 在 `request()` 内按 executor 消息创建，首次 HTTP 请求还包含独立的 `sync` executor 消息，之后才调用 `dashboard`；日志里的 `141.22s` 是整条 HTTP 墙钟，不是单一消息耗时。本次只证明默认代码下这两条请求成功且输出正确，不证明 120s 的端到端保护已被移除或 #19 已解决。

## C2-dashboard-attribution：区分 iterator active 与 inclusive

本卡只改 `benchmark-model-store.mjs`、新增 `benchmark-model-dashboard-attribution.json` 并更新本报告；生产模块、server、store、rollup 与既有测试均未改。上一回复提到的 rollups v7 与 45 tests 是更早 C1/C2 卡的历史状态回顾，不是本卡改动或验证；本卡没有重跑那 45 个旧测试。

新子模式 `--dashboard-attribution` 复用同 seed 的 `100,000` 行正式 schema 21 与 v7 rollup，只发一次真实 loopback `GET /api/summary?preset=all&skipCheck=1`。请求返回 HTTP 200、`81,564` bytes、总计 `6,513.92ms`，计数与五项 token 继续等于独立 SQL oracle；首次请求仍包含初始 sync `1,750.84ms`。

计时口径现在显式分开：

- `activeMs`：逐次 `iterator.next()` 耗时累加，包含第一次和最后的 `done` step，但不包含 `yield` 后消费者执行的时间。
- `inclusiveMs`：从第一次 `iterator.next()` 到迭代结束的总墙钟时间，包含消费者在 `yield` 期间的计价与分桶。
- `all()` 的 `rows`：改为实际 `Array.length`，不再恒记 1；本次例如 `SELECT DISTINCT date(...) FROM events` 记录 365 rows。

| 指标 | 本次结果 |
| --- | ---: |
| cost event scan `activeMs` | `417.01ms` |
| cost event scan `inclusiveMs` | `3,418.37ms` |
| 消费者差额（inclusive − active） | `3,001.36ms` |
| `UsageStore.timelineRange` inclusive | `3,469.80ms` |

event scan 共 `100,000` rows、`100,001` 次 `next()`，因此最后 `done` step 确实计入。`activeMs` 仍不是“纯 SQLite 执行时间”：它包含每次 SQLite statement step 与计时包装开销，但已排除消费者在 yield 期间的逐行转换、计价和分桶。`costEventsForRange` generator 的 inclusive 为 `3,419.44ms`（其自身 `next()` active 为 `666.93ms`），同样不能把 inclusive 直接写成 SQLite 或 generator active 耗时。

因此上一卡把 `3,129.64ms` 作为主要耗时定位是正确的 inclusive 证据，但不能把它归因成 SQLite 执行；本次 active/inclusive 差额把主要成本明确指向消费者处理。未新增缓存或生产优化，首次请求的 `120s` guard #19 仍未解决。

## C-current-dashboard-profile：固定源快照下的 10 万行归因

本卡只在 `output/history-retention-profile-20261024/` 新增证据并更新本报告；`src/`、`public/`、benchmark、测试和 1m 行为均未改。施工前的未冻结 `3,181.3046ms` 运行没有固定源树，随后另一任务又把 `src/usage-store.js` 从 SHA-256 `3e5e23fb…` 改为 `f501e615…`，因此它只保留为 `unfrozen-source-diagnostic`，不能作为稳定对照。

为消除源漂移歧义，本卡复制当前 35 个 `src/**/*.js`、17 个 `public/**/*.js`、benchmark 与根 `package.json`，共 `54` 个文件到 `source-snapshot/`。`snapshot-manifest.json` 记录每份文件复制前、复制后与运行后的哈希；三者逐一相等，全部 `54` 个哈希在运行后未变，模块副本保持只读。实际加载的关键文件哈希为：

- `src/usage-store.js`：`f501e615b93054bed272fc000466778f978444a57ebc0dc85ee9963168faef89`
- `public/timeline-utils.js`：`ce55a5e5ff742b366aa09448052c36377be7bf2241d8be0fc31ff6c72f1d3c32`
- `src/usage-core.js`：`c13784231143d31b1847fcdf71d1910866ac7f6a33c17dc88536b71a62a8fd5e`
- `src/server.js`：`8eaf97eb4009f7481ccdff5f813d12ee886647bcdfb823c94e3f5c858e0d3740`
- `src/pricing.js`：`ddaf043e9a3b5a3540cb0ef45e60d56527e5b9b373ba581172dd2cc3830e45b2`
- benchmark：`e28db4dbedc36646e6d7aa4b2571df3e6b4f127b5b97621fbde60bd08ea336c4`

命令与结果：

```powershell
node output/history-retention-profile-20261024/source-snapshot/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard-attribution
# exit 0; 100,000 rows; one skipCheck=1 summary in 3,550.0667ms
# HTTP 200, 81,564 bytes; executorTimeoutOverridden=false
```

独立 SQL oracle 与响应完全相等：events `100,000`、sessions `256`、homes `6`；totals 为 `total=252,603,269`、`input=164,368,399`、`cached=65,763,785`、`output=88,234,870`、`reasoning=17,585,661`，并保留 `6` 个 missing sources。请求 headers/body 分别为 `3,539.0566 / 10.5658ms`。

| 排名 | 实际路径 | 本次计时 | 含义 |
| ---: | --- | ---: | --- |
| 1 | `sync` | `1,385.91ms` | 首次请求 source/index sync，不是 warm summary 热点 |
| 2 | `costEventsForRange` event scan + consumer | inclusive `1,141.42ms` | SQL iterator active `234.94ms`，yield 期间 consumer `905.23ms` |
| 3 | `groupedRange` | `381.66ms` | 4 次分组 SQL scan，最慢一次 `151.32ms` |

容器指标为 `summarizeInReadTransaction=1,665.18ms`、`timelineRange=1,175.90ms`；支持项为 `metadata=231.48ms`、`periodComparison=211.87ms`、`periodAggregate=207.33ms`。因此本轮最小优化缝仍是 `UsageStore.timelineRange → costEventsForRange` 对 `public/timeline-utils.js buildTimelineRows` 的逐事件 consumer，而不是 SQLite stepping 本身。建议先做一个 request-local resolved pricing plan，以 model + 规范化 context/service-tier 形状为键，在 `estimateEventCost` 内复用，但仍逐事件计算金额；不缓存最终事件金额，且 `minimumRatesFor()` 的纯费率缓存本卡施工前已经存在，不再重复。现有 trace 没有把计价与分桶拆开，因此真正改代码前必须先测这个拆分，不能先宣称收益。

本卡明确限制：只有一次固定 seed 的合成 `100,000` 行运行；首次请求包含 `sync`，不代表 warm steady state；单次墙钟含主机噪声；consumer 仍混合计价与分桶；没有生产改动、重复轮次、并发、1m、浏览器或真实来源验证，#19 仍未关闭。共享 `benchmark-model-dashboard-attribution.json` 已恢复为主审前 SHA-256 `b9747c13638ae76ff6723ed61ab9408f644d80aa3675760efcf29bfa5ee85051`，本次不可变结果单独保存在 `immutable-source-benchmark-model-dashboard-attribution.json`（SHA-256 `9b02a720e995f63601be9bf8c998a6b0bb5bc7998145c0ef66dc54097e7eedec`）。

## C-current-million-dashboard：当前接受源的单次百万 after-cache

本卡只新增 `output/history-retention-profile-20261025-current-million/` 并更新本报告；生产 `src/`、`public/`、测试、共享 benchmark、共享 `benchmark-model-dashboard*.json`、app、CSS、store 与运行中服务 `3765` 均未改。为把测量固定在施工时字节，本卡复制当前 35 个 `src/**/*.js`、17 个 `public/**/*.js`、原相对路径 benchmark、其 reference `benchmark-model-dashboard.json` 和根 `package.json`，共 `55` 个文件到 `source-snapshot/`。`snapshot-manifest.json` 逐文件记录 source-before、copied 与 source-after SHA-256；复制件全部只读。运行后 `55/55` 副本仍等于记录 hash 且保持只读。

关键固定字节：

| 文件 | bytes | SHA-256 |
| --- | ---: | --- |
| `src/usage-store.js` | `472551` | `edf21f09ab7f9a2fb5b87a58e14ba88450109eb1ecd108917d6bb4fa35cefb52` |
| `src/pricing.js` | `78245` | `12d39362f05027807634a66df9e2b08ed3812cfaafb4d327082102fd4fac4e58` |
| `src/usage-core.js` | `171727` | `764c3411c756ed4273907c675bb8eaa00738b167baa3a33a4232a8f9cc1b1d8b` |
| `src/server.js` | `41418` | `b2965302c7cb99886122ad4ebf0474128e59bb86588f031d589b07426a4cdd1d` |
| `src/usage-rollups.js` | `35777` | `66b7fe319703c10f64807f76aac7ddd642a6066a61d660923d14cb28d546cdf4` |
| `public/timeline-utils.js` | `31660` | `ce55a5e5ff742b366aa09448052c36377be7bf2241d8be0fc31ff6c72f1d3c32` |
| benchmark | `69879` | `e28db4dbedc36646e6d7aa4b2571df3e6b4f127b5b97621fbde60bd08ea336c4` |

运行命令与结果：

```powershell
node output/history-retention-profile-20261025-current-million/source-snapshot/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard-after-cache
# exit 0; wall 93,586.1731ms
# first checked: HTTP 200, 83,110 bytes, 38,617.3085ms
# skipCheck:     HTTP 200, 83,110 bytes, 11,589.2531ms
# default executor timeout 120,000ms; executorTimeoutOverridden=false
```

两次请求都与独立 SQL oracle 完全相等：events `1,000,000`、sessions `256`、homes `6`、metadata events `1,000,000`；totals 为 `total=2,526,208,168`、`input=1,642,750,198`、`cached=656,167,060`、`output=883,457,970`、`reasoning=176,040,976`。两次响应均保留 `6` 个 missing sources；`checkedAt` 相同只表示 `skipCheck=1` 跳过 normal check，不表示纯 cache read。请求 headers/body 分别为 `38,615.6374 / 1.1878ms` 与 `11,566.3141 / 22.5740ms`。

按施工计划冻结的单次门槛，本轮 first `38.62s > 15s`、skipCheck `11.59s > 5s`，**仍明显远离目标**。这只证明一个固定 seed 的单次合成样本超限，不是 p95、20 进程或 SLA；也没有证明任何新的性能回退归因。

源漂移已显式记录：快照建立后、运行结束前，并行任务改写了 live `src/history-archive.js`（`fbd26eb3… → 3cdac6da…`）和 `src/usage-store.js`（`edf21f09… → b8f8afed…`，随后继续变动）。benchmark 只导入只读副本，因此本卡结果仍绑定上表字节，但不能再把当前 live 源称作同一前像。

| 证据 | bytes | SHA-256 |
| --- | ---: | --- |
| `snapshot-manifest.json` | `23469` | `9c04298ae49d2f813e51645c5c5b6c2af13ebc93045f9c6258273dd38e2aeba7` |
| `current-million.stdout.json` | `8124` | `f74cec807bb67878d012e98ca872ab86cf8d29f0a554c8f65d9a5439b7323eba` |
| `current-million.stderr.log` | `1402` | `d3bb45fec9ae6ecdd4ba6f2d680efaf76764d56a6422f19fbe337b7c889dd168` |
| copied result `benchmark-model-dashboard-after-cache.json` | `8124` | `f74cec807bb67878d012e98ca872ab86cf8d29f0a554c8f65d9a5439b7323eba` |
| `run-meta.json` | `546` | `a7c76b6f370b9095eb80e27ec4626e3ff8b1d864bfb420b40a2e34c3e8cd9c62` |
| `evidence.json` | `6985` | `d0e2e91607f96f921af2bc3c76a0ff4d61efc68f5e3eb53f991017feb173cf19` |

共享 `docs/validation/2026-10-22-history-retention/benchmark-model-dashboard-after-cache.json` 保持施工前 SHA-256 `2117702f375a9b7114df1aa3d2e27c3f21853ab442711b9c8ce9e64064586b4e`；共享 reference dashboard JSON 保持 `fbf32eb01811284c77da53e797bc145e49a4898a38c0c2ec482d6fafadcb1a9e`。临时 benchmark home 已由脚本 finally 清理，本卡未留下新的 listener；生产 `3765` 未接触。

限制：只有一组固定 seed 的合成 1M 顺序 loopback；首请求包含该请求必要 sync，不是 warm-only 延迟；单次主机/JIT/page-cache 噪声未消；RSS 是整个 benchmark 进程峰值且含 seed，不是 server/executor 合计验收；没有 20 个新进程、全热/冷热两布局、20 次暖请求、WAL 稳态矩阵、并发、真实来源或新 profile。`#19` 仍未关闭。

## C-timeline-consumer-split：905ms reference 与 606.64ms direct consumer

本卡只把同一 `source-snapshot/` 中既有 `--timeline-consumer` 的一次输出转存到 `output/history-retention-profile-20261024/` 并更新本报告；没有新增 fixture、生产 instrumentation 或其他 benchmark 模式，也未修改 54 个快照文件、共享 source 或既有结果。运行仍是同 seed 的 `100,000` events、`256` sessions、`6` homes、`8` models，最终 `13` rows。

三份完整输出都通过 `deepStrictEqual`：production `UsageStore.timelineRange` reference、带 production event-cost memo 的 instrumented `buildTimelineRows`、以及预先填充每个 `event.costEstimate` 后只走分桶/分组/finalization 的 precomputed-cost 路径。实际计时如下：

| 路径 | 本次计时 | 口径 |
| --- | ---: | --- |
| `referenceTimelineRange` | `905.0998ms` | 同 store、同 range/bucket；包含 `costEventsForRange` 迭代/转换与 `buildTimelineRows` |
| instrumented `timelineConsumer` | `606.6424ms` | 对已物化 production events 直接调用 `buildTimelineRows`，排除 `costEventsForRange` |
| pricing memo callback | `424.9899ms` | 上述 instrumented 路径内，包含 memo key/lookup/callback |
| `estimateEventCost` compute | `153.9394ms` | memo miss 内的实际逐事件计算 |
| pricing callback overhead | `271.0505ms` | `424.9899 - 153.9394ms` |
| precomputed-cost bucketing | `116.7749ms` | 独立完整 `buildTimelineRows`，只保留日历分桶/分组/finalization |
| approximate residual | `64.8776ms` | instrumented − pricing callback − precomputed 路径；仅用于量级说明 |

reference 与 direct instrumented 的差为 `298.4574ms`，但两者 output 虽然相同，输入路径并不相同：reference 还包含事件 SQL 迭代与转换，物化本身本次为 `289.9165ms`，因此不能把这 `298.46ms` 整体归给“纯分桶”。在 direct instrumented 内部，pricing callback 占 `70.06%`；其中 estimate 主体只占 callback 的 `36.22%`，其余 `63.78%` 是 memo key、查找和 callback 开销。precomputed-cost 路径占 instrumented 的 `19.25%`。pricing callback、estimate、precomputed 和 residual 存在嵌套/独立运行关系，不能严格相加。

**模型分布不能丢：** `8` 个 model 中 `5` 个 missing、`3` 个 exact；事件数为 missing `62,544`、exact `37,456`。missing models 是 `gpt-6-terra`、`deepseek-v3.2`、`claude-sonnet-4.5`、`kimi-k2`、`gpt-5-codex`；exact models 是 `glm-4.7`、`gpt-6-luna`、`gpt-6-sol`。`estimateEventCostMsByMatchType` 为 missing `104.9980ms`、exact `48.9414ms`，折算约 `1.679 / 1.307µs` per event。`minimumRatesFor()` 的纯费率缓存本卡施工前已修复，因此不能把 `424.9899ms` 的 memo callback 整体误归 unknown fallback；真正落到 missing model estimate 的只有 `104.9980ms`。

独立 replay 只作旁证，不与嵌套 callback 相加：`eventCostMemoKey=73.5237ms`、`resolvePricingModel=42.0661ms`、`timelineBucketKey=13.1405ms`。结果已转存为 `timeline-consumer-split-benchmark-model-timeline-consumer.json`（SHA-256 `81d533f77a595759586cd9f80284025c3760a07f9d76bc81221c792986f84e30`），结构化摘要为 `timeline-consumer-split-evidence.json`。共享 `benchmark-model-timeline-consumer.json` 仍为 `c59e5037…`，`benchmark-model-dashboard-attribution.json` 仍为 `b9747c13…`，54 文件快照哈希未变。

限制：这是单次 100k 合成运行，含正常主机噪声；reference 与 direct instrumented 口径不同；callback、estimate、precomputed 与 replay 不能严格相加；没有 p95、1m、并发、浏览器或生产改动，#19 仍未关闭。

## C-bounded-memo-eviction-probe：逐出开销与队列压力

本卡只新增 `output/history-retention-profile-20261024/memo-eviction-probe.mjs`、`memo-eviction-probe.json` 与本报告；`src/`、`public/`、既有 benchmark、测试及 54 文件只读 snapshot 均未改。探针直接导入 snapshot 的 `createBoundedKeyMemo`，使用 `100,000` 个唯一短 key（`k000000..k099999`）和固定 value `1`，`maxBytes=hardMaxBytes=1,000,000,000` 足够大，因此只观察 `maxEntries` 分支：`4096` 强制逐出与 `100000` 不逐出。每组各 3 次，执行顺序轮换。

| 路径 | 三次实际 ms | 中位数 |
| --- | --- | ---: |
| production，`maxEntries=4096` | `78.9370 / 81.6531 / 81.1973` | `81.1973ms` |
| production，`maxEntries=100000` | `11.1056 / 7.4186 / 6.5600` | `7.4186ms` |
| 本地 persistent-iterator control，`4096` | `7.9848 / 7.2947 / 7.0176` | `7.2947ms` |

production 逐出组相对无逐出的配对差为 `67.8314 / 74.2345 / 74.6373ms`，中位数 `74.2345ms`，按 `95,904` 次逐出折算约 `774.05ns/eviction`。本地 control 的配对差为 `-3.1208 / -0.1239 / +0.4576ms`，中位数 `-0.1239ms`，在该合成负载中与无逐出基本同量级；production 减 control 的中位差为 `74.1797ms`（约 `773.48ns/eviction`）。control 只复刻 entry 上限与 FIFO，不含 production 的 byte-budget、stats 等逻辑，所以这只能定位 fresh-key-iterator 假说，不能外推为整站可省 `74ms`，也不能据此删除 memo 的内存上限或语义。

队列压力检查排除了“越接近队尾越慢”的简单增长模型：强制逐出组第 1–23 个满 batch 的中位成本为早期 `3.3689ms`、晚期 `3.3569ms`，斜率 `+0.0016147ms/batch`（跨 23 个 batch 约 `+0.037ms`）。无逐出斜率为 `+0.0014003ms/batch`，persistent control 为 `-0.0032051ms/batch`。本探针因此支持“每次逐出新建 `entries.keys()` iterator 的常数级开销”，不支持“队列压力增长导致逐出变慢”；这是定位结论，不是生产 patch。

九次测量的返回值与 compute 次数均为 `100,000`，`hits=0`、`misses=100000`。`4096` 组每次都精确保留最后 `4096` 个 key、`evictions=95904`、`entries=4096`、`peakSize=4097`、`retainedBytes=32768`；`100000` 组保留全部 key、零逐出、`retainedBytes=800000`。control 额外断言 `clear()` 后 iterator 重置，以及 iterator 耗尽后再插入仍为 done、必须重建 iterator 才能看到新 key。结果 SHA-256 为 `1bf040f90a5387ada240827b3446a2352080329814ff5f18d412e755ab5bf76e`，脚本为 `c3b2ad665a83c8f8e8ff58d79f8e482f7ed40057f54e13da6bad0334c0d33b2e`；加载的 snapshot `src/pricing.js` 仍为 `ddaf043e…`。

限制：只用短 key、固定轻 value 与 ample byte budget，未覆盖真实事件 key/value、byte-budget 逐出、轮次收敛或生产调用栈；每组只有 3 次且是单进程墙钟；本地 control 不是生产实现，不能直接作为修复。没有 1m、SQL、并发或整站验证，也没有修改 memo 语义，#19 仍未关闭。

## C-memo-isomorphic-iterator：同构控制验证

本卡只新增 `output/history-retention-profile-20261024/pricing-memo-isomorphic-control.js`、`memo-isomorphic-iterator-probe.mjs`、`memo-isomorphic-iterator-probe.json` 并更新本报告；54 文件只读 snapshot、`src/`、`public/`、既有 benchmark 与测试均未改。控制文件完整复制 snapshot 的 `src/pricing.js`，唯一非语义 diff 是把 `../public/pricing-models.js` 改为从 output sibling 可解析的 `./source-snapshot/public/pricing-models.js`；FIFO 语义 diff 只保留一个 `oldestIterator = entries.keys()`，由一个惰性 helper 在 iterator 耗尽时重建，并把 `evictTo` 与 entry-limit 两个逐出循环里的 fresh `entries.keys().next().value` 都改为同一 helper。byte 统计、两个逐出循环、`beginRound`/`endRound`、`clear`、返回值和其余代码均与快照一致。精确 unified diff 已原样保存到 JSON 的 `sources.exactDiff`，SHA-256 为 `d2cfc46e8fcbfb242fe93c124d116b76bcc2839e51da39166ded094a80956797`。

三组各 3 次，按轮换顺序交错；每组都使用同一组 `100,000` 个 `k000000..k099999` 轻 key 和固定 value：

| 路径 | 三次实际 ms | 中位数 |
| --- | --- | ---: |
| production，`maxEntries=4096` | `82.8841 / 80.1326 / 83.4334` | `82.8841ms` |
| 同构 oldest-iterator control，`maxEntries=4096` | `14.7670 / 14.2477 / 11.5565` | `14.2477ms` |
| production，`maxEntries=100000` 无逐出 | `12.9310 / 16.5104 / 10.2789` | `12.9310ms` |

同 pass 配对差为 `-68.1171 / -65.8849 / -71.8769ms`，中位数 `-68.1171ms`，相对 production 中位数减少 `82.18%`。同构控制的 median 只比无逐出高 `1.3167ms`（约 `10.18%`），而 production 强制逐出比无逐出高 `69.9531ms`；因此本轮把差距主要归因到每次逐出 fresh iterator，而不是 key/value、byte 统计或 stats 逻辑。结论是**值得做一个聚焦生产修复**：把 FIFO oldest iterator 作为 memo 实例的游标复用，并保留耗尽后重建；但本卡仍只交隔离 probe，不建议直接粘贴整份控制文件或删除任何内存上限。

三条核心断言均通过：

1. 三 pass 的同构控制与 production 全 `stats()` 深度相等，FIFO 精确保留最后 `4096` 条；每条 `100000` returns/compute、零 hits、`100000` misses、`95904` evictions、`4096` entries、peak `4097`、`32768` retained bytes，生产/控制完全一致。
2. 小预算 round 场景同时触发 byte-budget 与 entry-limit 之外的轮末收敛，生产/控制的完整 stats、保留 key 与 bytes 相等；clear 后继续插入、淘汰也已对拍。
3. `maxEntries=1` 连续 `a,b,c,d` 强制 iterator 耗尽后再次插入，生产/控制的完整 stats、最终 `d` 保留与 bytes 相等，惰性重建没有漏掉新 key。

源快照 `src/pricing.js` 仍为 `ddaf043e9a3b5a3540cb0ef45e60d56527e5b9b373ba581172dd2cc3830e45b2`；控制 module 为 `de6aed8348a3979732e7dc5f59c2291c4068044372e8402078ac2e7580c2b6b8`；probe 为 `0e5102d352ffc3d4081e048e6538b0f7d81c1190d34aa773d0f47ec11e859c1c`；结果 JSON 为 `5c9466e5c409d231eef3c65c9aa89a938dcb2fc77ae2ecfa55f47abdf912001b`。`node --check` 通过；Biome 配置忽略整个 `output/`，因此 scoped Biome 没有处理这两个新 JS 文件，不能记为通过。

限制：仍是短 key、固定轻 value、三组各三次单进程墙钟，不能代表真实事件分布、1m、并发、整站或生产 timeout；没有改生产源码，#19 仍未关闭。控制文件的 import-path 差异也必须与语义 diff 分开审，后续生产 patch 仍需正式单测、重复统计和真实调用栈对拍。

## C-bounded-memo-iterator-write：生产迁入已验证 FIFO 游标

本卡只改 `src/pricing.js` 的 `createBoundedKeyMemo`、`test/w4-event-cost-memo.test.js` 与 C-report；其他 pricing 逻辑、store、core、public 与 54 文件只读快照均未改。施工前生产文件 SHA-256 为 `ddaf043e9a3b5a3540cb0ef45e60d56527e5b9b373ba581172dd2cc3830e45b2`，与既有只读快照 `output/history-retention-profile-20261024/source-snapshot/src/pricing.js` 完全一致，因此该快照继续作为可复查前像。生产迁入只包含主审已接受的接点：每个 memo 持有 `oldestIterator = entries.keys()`；`oldestKey()` 在游标耗尽时重建并取下一个 key；byte-budget `evictTo()` 与 entry-limit 循环共同调用 `oldestKey()`；`clear()` 清空 entries 后明确重建 iterator。`maxBytes`/`hardMaxBytes`/`maxEntries`、byte 统计、`roundDepth`、键函数、`compute`、返回值和全部计价逻辑未改。

精确生产 diff（相对上述前像）：

```diff
@@ -1653,6 +1653,7 @@ export function createBoundedKeyMemo({
   const entryLimit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : Number.POSITIVE_INFINITY;
   /** @type {Map<string, { value: any, bytes: number }>} */
   const entries = new Map();
+  let oldestIterator = entries.keys();
   let bytes = 0;
   let roundDepth = 0;
   const stats = {
@@ -1670,9 +1671,18 @@ export function createBoundedKeyMemo({
     hardMaxBytes: hard,
   };
 
+  const oldestKey = () => {
+    let next = oldestIterator.next();
+    if (next.done) {
+      oldestIterator = entries.keys();
+      next = oldestIterator.next();
+    }
+    return next.value;
+  };
+
   const evictTo = (target) => {
     while (bytes > target && entries.size > 0) {
-      const oldest = entries.keys().next().value;
+      const oldest = oldestKey();
       const evicted = entries.get(oldest);
       entries.delete(oldest);
       bytes -= evicted?.bytes ?? 0;
@@ -1699,7 +1709,7 @@ export function createBoundedKeyMemo({
       if (entries.size > stats.peakSize) stats.peakSize = entries.size;
       evictTo(roundDepth > 0 ? hard : limit);
       while (entries.size > entryLimit) {
-        const oldest = entries.keys().next().value;
+        const oldest = oldestKey();
         const evicted = entries.get(oldest);
         entries.delete(oldest);
         bytes -= evicted?.bytes ?? 0;
@@ -1719,6 +1729,7 @@ export function createBoundedKeyMemo({
     },
     clear(reason = "") {
       entries.clear();
+      oldestIterator = entries.keys();
       bytes = 0;
       stats.clears += 1;
       stats.lastClearReason = String(reason);
```

该 diff 的 SHA-256 为 `8e92c9b03d441e96dace0ee6d584e00cf4e304434d909231dba3b8baf39ceab1`；当前 `src/pricing.js` 为 `12d39362f05027807634a66df9e2b08ed3812cfaaafb4d327082102fd4fac4e58`。与已接受同构控制 module 再对拍时，生产只少了 sibling import-path 差异并增加 `clear()` 重置 iterator 一行，符合本卡限定。

新增一个行为测试，不检查 helper 形状：

- `byteToEmpty` 在 `5 B` 上限下连续插入 4 个各 `6 B` 的条目，每次都逐出到空；断言最终 size/bytes 为 0 且 evictions 为 4。
- `cleared` 在条目上限逐出后调用 `clear("iterator-write")`，再插入 3 条；保留最后两条，clears 为 1、evictions 为 2。
- `bothLoops` 的 `valueBytes` 仅在 value 为 2 时返回 1；第 2 条走 entry-limit，第 3 条以 size 3 加旧 2 超过 4 触发 byte-budget。最终只留 `d2`，retainedBytes 为 3、evictions 为 2，证明同一游标跨两个循环后仍保持 FIFO。

当前测试文件 SHA-256 为 `92d996fa2242b42d18f7f507fc809bea415ce793c056b20f41749f148be3a326`，相对 HEAD 的 test diff SHA-256 为 `229a1f50060792ad6db4547fe1169944ba08e4e9da063d1f769f42b0df5775e3`。主审可运行：

```powershell
node --test --test-name-pattern="FIFO cursor survives empty byte eviction" test/w4-event-cost-memo.test.js
node --test test/w4-event-cost-memo.test.js
node --check src/pricing.js
node --check test/w4-event-cost-memo.test.js
.\node_modules\.bin\biome.cmd check --formatter-enabled=false src/pricing.js test/w4-event-cost-memo.test.js
git diff --no-index --no-color -- output/history-retention-profile-20261024/source-snapshot/src/pricing.js src/pricing.js
```

本次定向行为用例 `1/1` 通过（`66.8865ms`），完整 memo 文件 `9/9` 通过（`139.3079ms`）；两个 `node --check` 与 scoped Biome（`1` file，`7ms`）通过。`git diff --no-index` 在存在差异时按 Git 约定返回 `1`。未重跑性能 probe、百万、SQL、并发、真实调用栈或全仓测试；生产收益仍引用主审独立接受的 sibling 诊断，本卡只证明语义保持与回归行为，#19 未关闭。

## C-memo-million-isolated：固定树单次百万 after-cache

本卡只新增 `output/history-retention-profile-20261025-memo/` 下的固定副本、结果与过程状态，并更新本报告；`src/`、`output/history-retention-profile-20261024/source-snapshot/`、共享 `benchmark-model-store.mjs` / JSON 与 production `3765` 均未改。新树从旧只读 snapshot 完整复制 54 文件，逐文件 SHA 对拍后只有 `src/pricing.js` 不同：

| 组件 | 固定 SHA-256 | 说明 |
| --- | --- | --- |
| `src/pricing.js` | `12d39362f05027807634a66df9e2b08ed3812cfaaafb4d327082102fd4fac4e58` | 本卡已接受 iterator 修复 |
| `src/usage-store.js` | `f501e615b93054bed272fc000466778f978444a57ebc0dc85ee9963168faef89` | 旧 snapshot，不是 B 当前 live store |
| `src/server.js` | `8eaf97eb4009f7481ccdff5f813d12ee886647bcdfb823c94e3f5c858e0d3740` | 旧 snapshot |
| `src/usage-core.js` | `c13784231143d31b1847fcdf71d1910866ac7f6a33c17dc88536b71a62a8fd5e` | 旧 snapshot |
| `public/timeline-utils.js` | `ce55a5e5ff742b366aa09448052c36377be7bf2241d8be0fc31ff6c72f1d3c32` | 旧 snapshot |
| benchmark | `e28db4dbedc36646e6d7aa4b2571df3e6b4f127b5b97621fbde60bd08ea336c4` | 未改脚本 |

新树同相对路径复制 `benchmark-model-dashboard.json` 作为只读 reference；源/副本 SHA 均为 `fbf32eb01811284c77da53e797bc145e49a4898a38c0c2ec482d6fafadcb1a9e`。54 文件 manifest 为 `snapshot-manifest.json`（SHA-256 `3a21c1c7a3114b08a4272a929f9f791db65c11dadc180555e71b3aff08705219`），其中 `fileCount=54`、`onlyChangedFile=src/pricing.js`、其余文件全部逐字相等且只读。

启动命令：

```powershell
node output/history-retention-profile-20261025-memo/source-snapshot/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard-after-cache
```

实际 launcher exec session 为 `91166`；启动调用在 `10s` 时返回 “Process running with session ID 91166”。通过该 session 的 `write_stdin` 轮询，stderr 先出现 `inserted 425000/1000000`，随后到 `1000000/1000000` 并打印两次 HTTP 200；最终 `write_stdin` 返回 exit code `0`。stdout/stderr 时间戳从 `2026-10-24T20:04:27Z` 到 `20:06:22Z`，约 `115s`，没有开启第二个同任务进程。

单次 1M 结果：

| 请求 | HTTP | response bytes | headers ms | body ms | total ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| first checked `preset=all` | 200 | 83,110 | 48,313.7029 | 1.3258 | 48,316.0080 |
| `preset=all&skipCheck=1` | 200 | 83,110 | 21,955.5852 | 0.5912 | 21,956.6286 |

两次 `checkedAt` 均为 `2026-10-24T20:05:07.442Z`，default executor timeout 为 `120000ms` 且 `executorTimeoutOverridden=false`，均保留 6 个 missing sources。独立 SQL oracle 与两份响应均为：`eventCount=1000000`、`sessionCount=256`、`homeCount=6`、`metadataEventCount=1000000`；totals `total=2526208168`、`input=1642750198`、`cached=656167060`、`output=883457970`、`reasoning=176040976`。`oracleEquality.firstCheck/skipCheck/bothSuccessfulRequestsEqualOracle` 全为 true。

脚本内置 comparison 的 reference 是旧 `benchmark-model-dashboard.json`（600s override 单次）：first `191523.0602ms`、skipCheck `121897.3159ms`；本卡分别为 `48316.0080 / 21956.6286ms`，差为 `-143207.0522 / -99940.6873ms`。这不是同一 timeout 的受控 A/B。共享旧 `benchmark-model-dashboard-after-cache.json` 也给出历史上下文 first `113161.5950ms`、skipCheck `61909.8594ms`，当前差为 `-64845.5870 / -39953.2308ms`，但旧 files 没有记录本卡同款源哈希，不能当作受控 A/B。结论只支持“在固定 54 文件树、只换 pricing 的单次 1M 运行中，两请求均成功并显著低于这两份历史 reference”，不是 20 组门槛或生产 SLA。

内存与资源口径保留在结果 JSON：`maxRSS=998856KiB / 1022828544 bytes`，scope 明确为 whole benchmark process peak RSS（包含百万行 seed），不是 server-only。server close `11.1517ms`；DB 从 seed 前 `477024256 bytes` 到关闭后 `522842112 bytes`，WAL 为 0。运行结束后 matching `codex-model-store-benchmark-*` 临时目录数为 0；最终检查 `3765` 为 not listening，本任务未连接、启动或修改该端口。

结果与过程证据：

- `benchmark-model-dashboard-after-cache.json` 与 `run.stdout.json` 完全同字节，SHA-256 `b855c7f7f4ae93ecd26261a9412f9e8f45d21f9a7161a225c700091565a9b843`。
- `run.stderr.log` SHA-256 `930b8f7fa576ea7a238bc327cd96b40a34fdd5b26b2c0f213a8339dbf373778a`，包含 25k 进度和两请求状态。
- `process-state.json` 保存 session id、命令、启动返回、轮询结果、exit code、请求与清理证据，SHA-256 `f23be5a82e9ea8cc86f2f24112b16041726c2395f47c89e1619118257f077ea1`。

限制：只跑一次固定 seed 的本机顺序 loopback，不是 20 组、p50/p95、并发、真实用户来源、磁盘冷缓存或整站吞吐；first 包含 normal check 与首次 sync，skipCheck 仅跳过 normal check；`maxRSS` 包含 seed。临时 DB/server 已删除，无法后验磁盘冷读。固定 store 是 `f501e615…` 旧快照，不能外推 B 当前 live store；本卡不改生产，#19 未关闭。

## C-300k-post-memo-attribution：300k 全历史扫描的 memo 压力

本卡只新增 `output/history-retention-profile-20261025-300k-memo-attribution/`，并更新本报告；`src/`、`public/`、共享 benchmark、`history-retention-profile-20261024/source-snapshot/` 与 `history-retention-profile-20261025-memo/source-snapshot/` 均未改。独立 benchmark 副本从上一轮新快照复制，只把本副本的 `BOTTLENECK_EVENT_COUNT` 从 `100000` 改为 `300000`，把导入指向该固定快照，并在既有 worker-only `--dashboard-attribution` hook 中旁路采样 `UsageStore.eventCostMemo.stats()`；未增加 production 配置、缓存、修复或第二组运行。

| 固定输入 | SHA-256 | 说明 |
| --- | --- | --- |
| `src/usage-store.js` | `f501e615b93054bed272fc000466778f978444a57ebc0dc85ee9963168faef89` | 上一轮旧 store 快照 |
| `src/pricing.js` | `12d39362f05027807634a66df9e2b08ed3812cfaafb4d327082102fd4fac4e58` | 已接受的 memo iterator 字节 |
| `src/server.js` | `8eaf97eb4009f7481ccdff5f813d12ee886647bcdfb823c94e3f5c858e0d3740` | 上一轮快照 |
| `src/usage-core.js` | `c13784231143d31b1847fcdf71d1910866ac7f6a33c17dc88536b71a62a8fd5e` | 上一轮快照 |
| `public/timeline-utils.js` | `ce55a5e5ff742b366aa09448052c36377be7bf2241d8be0fc31ff6c72f1d3c32` | 上一轮快照 |
| 原 benchmark | `e28db4dbedc36646e6d7aa4b2571df3e6b4f127b5b97621fbde60bd08ea336c4` | 未改固定快照 |
| 本卡 benchmark 副本 | `8ad3cf1a71f2549784da444b0f5308018e9c6ef29b074cabc83c103856a761f0` | 仅计数、路径和 memo 采样差异 |

上一轮 snapshot manifest 仍为 `3a21c1c7a3114b08a4272a929f9f791db65c11dadc180555e71b3aff08705219`。本卡副本相对原 benchmark 的 unified diff 保存为 `benchmark-model-store-300k.diff`，SHA-256 `27ef9c8c6ef2b975aeb6f3e016c4cf663be5468f989ca58be2cb2e73df39ae99`；`node --check` 通过。Biome 配置忽略整个 `output/`，因此本卡不声称 scoped Biome 通过。

命令只执行一次：

```powershell
node output/history-retention-profile-20261025-300k-memo-attribution/benchmark-model-store-300k.mjs --dashboard-attribution
git diff --no-index --no-color -- output/history-retention-profile-20261025-memo/source-snapshot/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs output/history-retention-profile-20261025-300k-memo-attribution/benchmark-model-store-300k.mjs
```

launcher exec session 为 `87719`；首次 `10s` 返回 running，下一次轮询仍在运行，随后以 exit code `0` 完成。唯一 HTTP 请求为 `200`、响应 `82,113` bytes、total `14,152.9984ms`（headers `14,151.3653ms`、body `1.2208ms`），default executor timeout `120000ms` 未 override，保留 6 个 missing sources。响应与独立 SQL oracle 均为 `eventCount=300000`、`sessionCount=256`、`homeCount=6`、`metadataEventCount=300000`；totals `total=758641693`、`input=493432757`、`cached=197006265`、`output=265208936`、`reasoning=52865447`。

| 实际路径 | 本次计时 | 说明 |
| --- | ---: | --- |
| first request 内 `sync` | `6,197.4510ms` | 首次启动仍需同步 |
| `summarizeInReadTransaction` | `6,307.5868ms` | 单次 summary 主体 |
| `timelineRange` | `4,526.4940ms` | 全历史 300k leaf |
| `costEventsForRange` method | active `1,597.4902ms` / inclusive `4,504.6310ms` | active 是 iterator next 包装口径，不是纯 SQLite |
| cost event scan SQL | active `968.0764ms` / inclusive `4,504.0513ms` | `300000` rows / `300001` next calls |
| cost scan consumer 差额 | `3,535.9749ms` | inclusive 减 SQL active；包含计价、memo key、分桶等，不能当纯 memo 时间 |
| `groupedRange` | `1,459.4534ms` | 4 次调用 |
| `metadata` | `848.5406ms` | 2 次调用 |

memo 采样给出本卡第一个直接压力证据：

| 指标 | 数值 |
| --- | ---: |
| hit / miss | `0 / 300000` |
| evictions | `212411` |
| peak entries / `maxEntries` | `262145 / 262144` |
| peak bytes / `maxBytes` / `hardMaxBytes` | `200821687 / 67108864 / 201326592` |
| round 后 retained entries / bytes | `87589 / 67108541` |
| clears | `0` |

本轮 stats 记录 `300000` 次 miss 插入，说明这次全历史扫描没有 intra-request 命中；这不证明 key 全局唯一，已逐出的 key 后续仍可能重访。峰值同时越过 entry 与 64 MiB byte 门限，但未达到 192 MiB round hard limit。由于 miss 插入数为 `300000`、peak entry 为 `262145`，且 round 内未触发 192 MiB hard limit，`212411` 次逐出可按现有控制流拆成 `300000 - 262144 = 37856` 次 entry-limit 逐出与 round 结束时 `174555` 次 byte 收缩逐出；这是从 stats 与控制流推导，不是额外计时。

这组结果把剩余 consumer 区间缩到 `timelineRange` 的 `3,535.9749ms`，并证明整事件 memo 在首次 300k 全历史扫描中仍逐事件 miss、发生 21 万次逐出；它**不**说明该 consumer 区间全部由 memo 造成，也没有把 aggregate timer 直接猜成某个函数热点。`300k` 单次结果不能受控解释 1M `48.3160 / 21.9566s` 的全部剩余差值；已接受的 helper 只复用 FIFO oldest iterator，不改变 miss、key 或逐出数量。`minimumRatesFor` 已另有已接受缓存，本卡不重复该项。#19 仍未关闭。

证据文件：

- `benchmark-model-dashboard-attribution.json` 与 `run.stdout.json` 字节相同，SHA-256 `99289a9a3412e6513fbfa7b3f79534e42303f9c90bd52495b62fa3d101509458`。
- `run.stderr.log` SHA-256 `72ce25e4e34ad5daf3466edb93a6005940e931c7079d4d159e684dd0d09e1183`，包含 300k 插入进度与唯一请求。
- `evidence.json` 保存固定模块哈希、benchmark diff、oracle、trace 与 memo 派生；SHA-256 `2f8552822b15f13c9169948d501260544308fd50f1d397a23aa0da5f0619c3d0`。
- `process-state.json` 保存 session、exit code 与清理状态；SHA-256 `080784dac2fdb900b0ac373f7bf933a901ec6599ea24af9706baaf9e69979a74`。

限制：只跑一次固定 seed 的合成 300k loopback，不是 p50/p95、并发、真实用户分布或磁盘冷读；请求同时包含首次 `sync`，`consumerMs` 不是纯 memo timer，memo 单次计数也不能换算成 1M 时差。临时 DB/server/hook 已清理，production `3765` 未接触。#19 未关闭。

## C-sync-cpu-leaf：首次 sync 的 CPU 落在 rollup 原生 SQLite run

主审已接受本卡。它只新增 `output/history-retention-profile-20261025-sync-cpu-leaf/` 与对应报告内容；生产 `src/`、`public/`、测试、共享 benchmark、两套既有 snapshot 和旧证据均未改。benchmark 副本从上一卡固定 300k 文件复制，只新增 `--sync-cpu-leaf` 模式：在 worker 首次 `UsageStore.sync` 前启动 `node:inspector` profiler，以 `1000µs` 间隔采样，并在 `finally` 中停止和写出 raw `.cpuprofile`；seed、主线程等待和其他请求阶段不在 isolate profile 内。没有修改 store、rollup、server 或 benchmark 默认行为。

| 固定输入 | SHA-256 | 说明 |
| --- | --- | --- |
| 固定 snapshot manifest | `3a21c1c7a3114b08a4272a929f9f791db65c11dadc180555e71b3aff08705219` | 上一轮 54 文件固定树 |
| `src/usage-store.js` | `f501e615b93054bed272fc000466778f978444a57ebc0dc85ee9963168faef89` | 旧 store 快照 |
| `src/pricing.js` | `12d39362f05027807634a66df9e2b08ed3812cfaafb4d327082102fd4fac4e58` | 已接受的 memo iterator 字节 |
| 上一卡 benchmark | `8ad3cf1a71f2549784da444b0f5308018e9c6ef29b074cabc83c103856a761f0` | 未改 300k 输入 |
| 本卡 benchmark 副本 | `991a5ee84bbb01bd35f09647316ae63d5b120ac18904ac67df132b2b646a7793` | 只增加 profile 模式与输出 |
| 精确 unified diff | `107c34c3ec5b2941cee19c2a37a083b14d3f472a943ad9c9a07b15e0cbab15ce` | benchmark 副本相对上一卡 |

命令只执行一次：

```powershell
node output/history-retention-profile-20261025-sync-cpu-leaf/benchmark-model-store-sync-cpu-leaf.mjs --sync-cpu-leaf
```

exec session 为 `93507`，exit code `0`。唯一 HTTP 请求为 `200`、响应 `82,113` bytes、total `12,879.1460ms`，default executor timeout `120,000ms` 未 override，保留 6 个 missing sources；响应与独立 SQL oracle 均为 `eventCount=300000`、`sessionCount=256`、`homeCount=6`、`metadataEventCount=300000`，totals 为 `total=758641693`、`input=493432757`、`cached=197006265`、`output=265208936`、`reasoning=52865447`。

| Profile / trace 指标 | 数值 | 说明 |
| --- | ---: | --- |
| `sync` | `6,138.1291ms` | 1 次调用；profile 只包住首次 worker sync |
| V8 samples / nodes | `4,143 / 38` | `1000µs` 采样；sampled `6,160.499ms`、duration `6,160.578ms` |
| exclusive native `run` | `4,037 samples / 5,984.812ms` | parent 为 `usage-rollups.js:345:28` |
| `syncRound` inclusive | `6,131.089ms` | profile 内的 sync 主栈 |
| rollup rebuild inclusive | `5,987.587ms` | `rebuildUsageRollupsFromSource` |
| native `exec` / `all` | `91.811 / 26.414ms` | 与 `run` leaf 分开 |

唯一主导 leaf 是 rollup rebuild transaction 内的 native SQLite `run`，栈为 `run → usage-rollups.js:345 → withWriteTransaction → rebuildUsageRollupsFromSource → rebuildUsageRollups → syncRound`。因此本次 `sync` CPU 主要不在来源发现、seed 或主线程等待，而在全历史 rollup 的写事务。

| 调用点行号 | 语句 | ticks | tick 占比 | 按 leaf 比例折算 |
| --- | --- | ---: | ---: | ---: |
| `446` | `insertDay.run(zone, day, start, end);` | `1294` | `32.05%` | `1,918.34ms` |
| `447` | `insertModels.run(zone, day, start, end);` | `1259` | `31.19%` | `1,866.45ms` |
| `448` | `insertSessions.run(zone, day, start, end);` | `1483` | `36.74%` | `2,198.53ms` |

三个 insert 调用点合计 `4,036` 个 position ticks；剩余 `1` tick 位于同循环的 `deleteDay.run`。折算毫秒只是把 `run` leaf 的 sampled time 按 ticks 比例分配，不是独立 timer；这些行也不能区分 UTC/local 两次 rollup、具体天数或单条 SQL 的内部 SQLite 成本。

证据文件：

- `benchmark-model-sync-cpu-leaf.json` 与 `run.stdout.json` 字节相同，SHA-256 `682f2cfa44623fa3c27da24fc0f16a52a317bb408376fdc0293ac676800a2611`。
- `run.stderr.log` SHA-256 `dec1b5f354a9c01fc51194e82832d1fcecdc0111f05f51c915a8146f6413246d`，包含 300k 插入进度与唯一请求。
- raw `sync-first.cpuprofile` SHA-256 `11a32be0434e4463b68bba16975dab9a63a95ec5a6a2aec7add6b4b5d45d7817`；profile summary SHA-256 `dcdfd59d2bfd62a51fbb816a6f61483b0be9620570af4944eb48dd062bdf45f1`。
- line attribution SHA-256 `615758a197966e934ce2371984f19fd9c7fdb036e3ae671cc78ae271b77f67d3`；`evidence.json` SHA-256 `239eb382d8c046d1ca5999b6c4ed4745da2a703cd5fc1c902ed8a84525e274eb`。

主审独立接受 `main-review.json` 的 raw `4,143` samples、timeDeltas、leaf 权重、祖先栈与 oracle；该文件 SHA-256 为 `381a09bc3c23f933f500df7606ffa237d22ca547b7469ee158f46c344222b5a8`。PositionTicks 仍只是按 leaf 比例分配的估计，不是独立 SQL timer。复核工具时钟从 `20:23` 跳到 `22:41`，因此不声称该区间内连续执行。

本卡只定位 CPU leaf，不实施 rollup 写路径优化，也不声称提升 SLA。单次合成 300k、首次 `sync`、1 ms 采样噪声、positionTicks 折算和未拆分的 UTC/local/day 维度仍限制结论；#19 未关闭。

## C-sync-rollup-bootstrap-cause：seed 未写 local-zone meta，首次 sync 补建 local rollup

本卡只新增 `output/history-retention-profile-20261025-sync-bootstrap-cause/` 与对应报告内容；生产源码、测试、共享 benchmark 和既有 snapshot 均未改。probe 复用固定 300k seed，先按 benchmark 的 seed 流程执行 `createUsageRollups()` 与 UTC-only `rebuildUsageRollups({ days: dayKeys })`，关闭 seed store 后在同一个临时 DB 上新建一个 `UsageStore`，串行执行两次 `sync()`。rollup audit triggers 只存在于该临时 DB，运行结束随临时目录删除。

| 固定输入 | SHA-256 |
| --- | --- |
| 固定 snapshot manifest | `3a21c1c7a3114b08a4272a929f9f791db65c11dadc180555e71b3aff08705219` |
| `src/usage-store.js` | `f501e615b93054bed272fc000466778f978444a57ebc0dc85ee9963168faef89` |
| `src/usage-rollups.js` | `66b7fe319703c10f64807f76aac7ddd642a6066a61d660923d14cb28d546cdf4` |
| `src/pricing.js` | `12d39362f05027807634a66df9e2b08ed3812cfaafb4d327082102fd4fac4e58` |
| 上一卡 300k benchmark | `8ad3cf1a71f2549784da444b0f5308018e9c6ef29b074cabc83c103856a761f0` |

命令只执行一次，exit code `0`：

```powershell
node output/history-retention-profile-20261025-sync-bootstrap-cause/probe-sync-bootstrap-cause.mjs
```

seed/cache 构建总计 `9,504.0443ms`（insert `3,311.5043ms`、create `35.8728ms`、UTC rebuild `6,156.6672ms`）。关闭 seed store 后：

| 阶段 | local-zone meta | dirty days | UTC markers | local markers | rollup writes | raw / UTC / local facts |
| --- | --- | --- | ---: | ---: | ---: | --- |
| seed 后、首次 sync 前 | `null` | `[]` | `365` | `0` | 已由 seed UTC rebuild 完成 | raw `300000`；UTC `300000`；local `0` |
| 第一次 sync | 写入 `Asia/Shanghai` | `[]` | `365` | `366` | `252570` | 全部 `300000` |
| 第二次 sync | 保持 `Asia/Shanghai` | `[]` | `365` | `366` | `0` | 全部 `300000` |

第一次 sync 耗时 `6,395.3546ms`、`total_changes=505159`；`252570` 条 rollup audit changes 全部位于 local zone，分别为 `usage_rollup_days=366`、`usage_rollup_daily=2196`、`usage_rollup_models=17568`、`usage_rollup_sessions=232440`。第二次 sync 耗时 `3.0562ms`、`total_changes=15`，但 rollup audit changes 为 `0`。

三次断言的 `checks` 均为 `true`：

- `bootstrapCause`：首次 sync 前 local-zone meta 缺失、dirty 队列为空、UTC marker 为 `365`、local marker 为 `0`；第一次 sync 只写 local rollup 并写入当前 zone。
- `steadyNoRollupWrites`：第二次 sync 的 rollup writes 为 `0`，且 sync 后 rollup state 与第一次完全相同。
- `factsAndOracleEqual`：raw facts 在 sync 前后、UTC/local rollup facts 在 sync 后均精确等于 `eventCount=300000`、`sessionCount=256`、`homeCount=6` 与五项 token totals；首次 sync 前 local rollup facts 明确为零。

代码路径与观测一致：固定 benchmark 在 `createUsageRollups()` 后只调用 UTC rebuild（seed 文件 `1692/1695` 行），UTC rebuild 清空 dirty day（`usage-rollups.js:449`）；新 store 第一次 sync 读到 dirty `[]`，但 `readMetaRaw("usage_rollup_local_zone_identity")` 为空，使 `localRollupZoneChanged=true`（`usage-store.js:7732-7735`），扫描 event UTC days 后重建 local rows 并写入 meta（`usage-store.js:7789-7803`）。第二次 sync 既无 dirty，也无 zone change，因此跳过整个 rollup block。

证据文件：

- probe SHA-256 `876cb8e1a7460debc62246aeafdbb0a6aca5f11f496369ddbbe88e6d01d1fd32`，结果 JSON SHA-256 `0fbba23e295a3d76c8c7e93d33ee61563be15d0f4cea3ad8555763147e8466d6`。
- stdout SHA-256 `c91877e301fa294b25b26edaea33743d896db84490e10bace2beb627635d9bfe`；stderr SHA-256 `be706dabed47e7e7faccec4fed1b26b897984dd5e345274ac93a267d87b4b097`，仅含 300k 插入进度。

本卡证明的是该固定 seed 与当前 store 门禁下的因果，不证明所有 bootstrap 路径、所有时区或生产来源都会走同一分支；临时 DB 已清理，未做真实来源、p95、并发、冷盘或 1M。

## C2-timeline-consumer：计价压过日历分桶

本卡只改 `benchmark-model-store.mjs`、新增 `benchmark-model-timeline-consumer.json` 并更新本报告；生产模块、server、store、rollup、`public/` 与既有测试均未改。使用同 seed 的 `100,000` 行，先通过 `UsageStore.costEventsForRange` 物化 production event 对象（`357.27ms`，不计入 consumer），再对固定 `month`/`local` 全范围独立调用 `buildTimelineRows`。两个测量分支的完整 `13` 行输出都与 `UsageStore.timelineRange` 通过 `deepStrictEqual`。

| 实际调用/路径 | 本次计时 | 说明 |
| --- | ---: | --- |
| `eventCostMemo.estimate` | `1,733.18ms` | 在 `buildTimelineRows` 内逐事件调用的 production pricing memo wrapper |
| `estimateEventCost` | `1,310.33ms` | 仅计 memo miss 后的真实计价计算 |
| 非计价缓冲路径 | `214.43ms` | 使用已缓存 `costEstimate` 重新跑完整 `buildTimelineRows` |
| `eventCostMemoKey` replay | `90.41ms` | 对同一批事件独立 replay 键构造，近似值，不与上面求和 |
| `resolvePricingModel` replay | `76.64ms` | 对同一批事件独立 replay 模型价格匹配 |
| `timelineBucketKey` replay | `20.79ms` | 对同一批事件独立 replay 日历分桶 |

本次 `buildTimelineRows` 总耗时为 `2,052.70ms`，其中 pricing memo callback 占约 `84.4%`、`estimateEventCost` 主体占约 `63.8%`，非计价缓冲路径约占 `10.4%`；日历时间键和 grouping/finalization 的非计价路径均不是主因。最慢的两个真实调用因此是 `eventCostMemo.estimate` 和它内部的 `estimateEventCost`，而不是 `timelineBucketKey`。

模型集合只有 `8` 个，但价格匹配 replay 只有 `76.64ms`：`gpt-6-luna`、`gpt-6-sol`、`glm-4.7` 命中 exact，`gpt-6-terra`、`deepseek-v3.2`、`claude-sonnet-4.5`、`kimi-k2`、`gpt-5-codex` 为 missing。按模型匹配类型汇总的真实 `estimateEventCost` 时间为：missing `1,226.56ms`，exact `83.77ms`。因此“重复价格匹配”本身不大，主要成本是 missing model 在逐事件计价中的 fallback/rate-plan 计算；100,000 个事件也形成了 100,000 个不同 memo key（首轮全部 miss，无 eviction，峰值约 `74.0MB`），不能指望现有整事件 memo 在首次全量扫描中命中。

最小可行建议（本卡**未实施**；后继 `C2-minimum-rates-cache` 已按此范围落地）：只缓存与 token 无关的 pricing rate-plan 选择，特别是 unresolved model 的 `minimumRatesFor` 结果，键至少包含 catalog identity、currency 与 context tier；峰值判定如依赖时间戳，应继续逐事件或单独按日缓存。不要缓存最终事件金额、不要改计价语义，也不要把它宣称为已验证优化。该建议不解决 #19，仍需独立实现和语义/性能证明。

## C2-minimum-rates-cache：只缓存 unknown fallback 的纯最低费率

本卡只改 `src/pricing.js` 与 `test/pricing.test.js`，并新增本卡 benchmark 对照 JSON；未改 `benchmark-model-store.mjs`、store、rollup、UI、server 或既有价目语义。施工前像保存于 `baseline/C2-minimum-rates-cache/`：`src/pricing.js` SHA-256 `f21c08d750f3cbf9ae29dd385bcb7c07c8d96de03ff80012e8c949d6f020818e`，`test/pricing.test.js` SHA-256 `b9295cd0487723588a717ad18bcef9037aeef051716e5bd33da493fa3e4e8801`。

根因保持上一卡结论：每个未收录模型事件都会对 `activePricing.models` 执行一次 `Object.entries` 过滤并求各费率字段最小值。本卡只给 `minimumRatesFor()` 增加一个小型 `Map`，键为 `modelKey + contextLevel + currency`，缓存其返回的费率对象或 `null`。`setPricingCatalog()` 与 `resetPricingCatalog()` 都清空该 Map，因此同 `checkedAt` 不同内容、A→B→A 以及 reset 都不会命中旧目录。现有唯一调用方只读该对象，没有原地修改；没有缓存最终事件金额、逐事件峰谷、GLM 输出分档或 model 匹配结果。

核心正确性：

- 同目录未知模型的完整 `estimateEventCost` 对象与测试内独立实现的旧 `Object.entries` 最低费率 oracle `deepEqual`，包括金额拆分、token 数、原因与 `priceVersion`。
- 两个同 `checkedAt`、不同内容的目录得到不同 catalog hash；USD/CNY 与 short/long 四组金额分别匹配各自 oracle，B 不复用 A，恢复 A 后完整结果与首次 A 相同；随后 `resetPricingCatalog()` 的结果匹配默认目录 oracle。
- 既有 `GLM-4.7 按输入上下文与输出长度分档计价` 定向通过，逐事件 short/long 与 shortLongOutput 金额未变。

同 seed、同 `100,000` events / `13` rows 的既有 `--timeline-consumer` 前后对照：

| 路径 | 缓存前 | 缓存后 | 差值 |
| --- | ---: | ---: | ---: |
| `buildTimelineRows` | `2,052.70ms` | `1,111.83ms` | `-940.87ms` |
| pricing memo callback | `1,733.18ms` | `767.62ms` | `-965.56ms` |
| `estimateEventCost` 主体 | `1,310.33ms` | `302.67ms` | `-1,007.66ms` |
| missing model | `1,226.56ms` | `198.56ms` | `-1,027.99ms` |
| exact model | `83.77ms` | `104.11ms` | `+20.34ms` |

两条完整输出仍都与 production `UsageStore.timelineRange` `deepStrictEqual`。整条 consumer 下降约 `45.8%`，missing model 的逐事件计算下降约 `83.8%`；exact model 的单次上升保留为运行噪声，不解释成 cache 回归。`eventCostMemoKey` replay 仍约 `90ms`、`timelineBucketKey` replay 约 `18–21ms`，说明本卡没有把缓存扩展到键构造或日历分桶。

本卡限制：只跑一次 100k 墙钟对照，未暴露 cache 命中计数，未跑百万行、并发、真实服务或其他 bucket/zone；缓存只覆盖 `minimumRatesFor` 的纯结果，不解决整事件 memo 首次仍全 miss 的问题。#19 仍未完成。

## C2-dashboard-bottleneck：一次 10 万行 skipCheck summary 的耗时归属

> 观测口径修正：以下旧卡的 `3,129.64ms`、`3,130.57ms` 与 `3,180.82ms` 均为 inclusive 计时，包含 yield 期间消费者；旧 JSON 保留不改，新的 active/inclusive 拆分见上一节。

本卡只扩 `benchmark-model-store.mjs` 的 `--dashboard-bottleneck` 子模式并新增独立 JSON；生产模块、server、store 和既有测试均未修改。复用同 seed、同 distribution 的 `100,000` 行正式 schema 21 与 v7 rollup，只请求一次：

```text
GET /api/summary?preset=all&skipCheck=1
```

请求返回 HTTP 200、`81,564` bytes，耗时 `6,442.82ms`。独立 SQL oracle 与响应均为 `eventCount=100,000`、`sessionCount=256`、`homeCount=6`，totals：`total=252,603,269`、`input=164,368,399`、`cached=65,763,785`、`output=88,234,870`、`reasoning=17,585,661`。响应大小与百万行 probe 的 `83,083` bytes接近，因此本次主要不是 JSON 体积或传输导致。

这次 `skipCheck=1` 是 store 的第一次请求，`storeStatus===null` 仍触发一次初始 sync；trace 中 `sync` 为 `1,812.74ms`，必须从 warm `skipCheck` 的耗时归属中排除。排除 sync 后，`summarizeInReadTransaction + metadata + periodComparison` 合计约 `4,573ms`。主要项目如下：

| 函数/路径 | 调用次数 | 耗时 | 证据 |
| --- | ---: | ---: | --- |
| `UsageStore.costEventsForRange` | 1 | `3,130.57ms` | 消费 `100,000` 行，命中 `timelineRange` |
| `UsageStore.timelineRange` | 1 | `3,180.82ms` | 其内部耗时几乎全部来自上一条 |
| `UsageStore.groupedRange` | 4 | `588.72ms` | channel `231.37ms`、model `207.10ms`、home `87.66ms`、project `61.86ms` |
| `UsageStore.metadata` | 2 | `364.92ms` | 第一次建缓存，第二次约 `0.25ms` |
| `UsageStore.periodComparison` | 1 | `291.63ms` | 其中 `periodAggregate` 两次共 `284.97ms` |

最慢具体 SQL 是 `timelineRange → costEventsForRange` 的整段事件读取：

```sql
SELECT timestamp_ms, session_id, home_id, channel, model, detail_mask,
  cache_write_tokens, cache_write_known, request_input_tokens, context_level,
  service_tier, price_version, total, input, cached, output, reasoning
FROM events
WHERE (? IS NULL OR timestamp_ms >= ?)
  AND (? IS NULL OR timestamp_ms <= ?)
```

trace 记录该 statement 的 `iterate` 消费 `100,000` 行耗时 `3,129.64ms`。该计时包含消费者逐行映射与 `costEventFromRow`，不能误写成纯 SQLite 执行时间；但它已足以把主要耗时定位到“全范围逐事件读取与转换”，而不是响应序列化。`summarizeInReadTransaction` 总计 `3,916.44ms`，`costEventsForRange` 占其余 warm summary 路径约 `68.5%`。`metadata` 的 `GROUP BY home_id` 为 `168.81ms`、`MAX(timestamp_ms) GROUP BY channel,model,home_id` 为 `118.48ms`；它们是次级成本，不是主因。

最小生产建议（**未实施，交主审接线**）：沿用 `recordsForRange` 已有的 revision/价目/汇率/service-tier/zone/排除集 memo 键，为相同 range、bucket 与排除集的已完成 `timelineRange` 结果（含 cost accumulator）增加一条结果 memo。这样可避免重复 `skipCheck` 再次扫描和转换全量事件；它只针对重复请求，**不解决首次请求的 120s guard #19**，首次 dashboard 仍需另做 rollup/SQL 方案评估。不要把这个建议或 benchmark override 当作性能达标。

## C1-dirty-UTC：同事实事务的 UTC 脏日队列

`usage_rollup_dirty_days` 只存 `day_key`，不带 zone；本卡只接 UTC。日期统一由一个 SQL 表达式生成，得到 `YYYY-MM-DD`，不依赖事实表已有的 local `day_key`：

```sql
date(timestamp_ms / 1000.0, 'unixepoch')
```

除数必须是 `1000.0`；整数 `/ 1000` 会把 `-1 ms` 截断为 `0`，误入 `1970-01-01`。

格式首次创建（C1-dirty-UTC 施工时为 v2，旧格式升级）在 `ensureCurrentRollupFormat` 的同一 SAVEPOINT 内执行一次：

```sql
INSERT OR IGNORE INTO usage_rollup_dirty_days (day_key)
SELECT DISTINCT date(timestamp_ms / 1000.0, 'unixepoch') FROM events;
```

之后三个事实触发器在原事务内入队：

- INSERT：`NEW.timestamp_ms` 的 UTC 日。
- UPDATE：`OLD.timestamp_ms` 与 `NEW.timestamp_ms` 的 UTC 日，`PRIMARY KEY` 加 `INSERT OR IGNORE` 去重。
- DELETE：`OLD.timestamp_ms` 的 UTC 日。

原有 built marker 失效逻辑保留。`rebuildUsageRollups` 成功重建后，仅 `calendarZone === "utc"` 时删除对应 dirty 日；local 重建不清 UTC 队列。`listDirtyUsageRollupDays(db)` 在只读 SAVEPOINT 内按 `day_key` 升序返回字符串数组；格式不匹配时抛 `ROLLUP_CACHE_MISSING`，不建表、不写入。

五条新增用例：

1. 先写入乱序两日事实，再首次 `createUsageRollups`；dirty 为排序后的 `["2026-07-12", "2026-07-13"]`。随后跨日 UPDATE 到 `2026-07-14`，再同日 UPDATE 一次；队列为三日且没有重复。再 DELETE `2026-07-13` 的事件，队列保持不变（该日已在队列中）；INSERT 新日 `2026-07-15` 后队列扩为四日。
2. 对已排队日注入 `BEFORE INSERT ON usage_rollup_daily` 的 `RAISE(ABORT)`；失败后 dirty 仍保留。移除触发器并成功 UTC 重建后 dirty 为空。再次修改事实并只做 local 重建，UTC dirty 仍保留。
3. 已排队日在 `BEGIN` 内成功重建并清空，`ROLLBACK` 后队列恢复；另在已清空状态下修改事实、重建并回滚，事实与旧汇总恢复，队列不残留未提交清理。
4. 写入旧格式 `format_version=999` 与一条事实后调用 `listDirtyUsageRollupDays`，断言 `ROLLUP_CACHE_MISSING`，并确认版本行原样保留、没有创建 `usage_rollup_dirty_days`。
5. 极小边界：先写入 `timestamp_ms=-1` 再首次创建，dirty 为 `["1969-12-31"]`；再经 INSERT 触发器写入 `timestamp_ms=0`，队列为 `["1969-12-31", "1970-01-01"]`。两者同时断言 bootstrap 与触发器使用同一精确表达式。

本卡未接 `UsageStore`、sync、local 队列、后台调度或每轮全量扫描；格式首次种入后，后续依赖触发器增量入队。

## C1-local-from-UTC：UTC 脏日投影为当地日

新增纯函数：

```js
localUsageRollupDaysForUtcDays(days)
```

输入是 UTC `YYYY-MM-DD` 数组，输出是当前进程时区下可能受影响的当地日，升序去重。实现复用现有 `dayBounds(day, "utc")` 与 `calendarDays(first, last, "local")`：

1. 每个输入 UTC 日取半开区间 `[start, next)`。
2. 首当地日取 `localDayKey(new Date(start))`。
3. 尾当地日取 `localDayKey(new Date(next - 1))`，避免把恰好落在当地午夜的 `next` 多算一天。
4. 枚举首尾之间的每个当地日历日，再跨输入日去重排序。

不新增 local SQL 触发器、`localtime` 调用或持久队列；也不改 store。输入日复用模块既有 `dayBounds` 校验，非法日期直接抛 `RangeError`。

两条新增用例：

1. 上海下 UTC `2026-07-12` 映射 `["2026-07-12", "2026-07-13"]`；纽约春季 UTC `03-07..03-08` 映射连续 `03-06..03-08`，秋季 UTC `10-31..11-01` 映射连续 `10-30..11-01`，覆盖 DST 前后无漏日。
2. 上海下重复输入 `07-12,07-12,07-11` 去重排序为 `07-11..07-13`；`2026-02-30` 按现有 UTC 校验抛 `RangeError`。

本卡只提供纯推导，不清 UTC 队列、不调用重建、不保证对应 local 日已有缓存；B 后继卡需在清 UTC 队列前捕获 UTC days，再重建这里返回的 local 日。

## UI-missing：缺失来源的保留历史提示

本卡只改现有覆盖区 notice 渲染，文件 owner 范围为：

- `public/perf-ui.js`：`renderPerfCoverageHtml` 内一条条件；
- `public/i18n.js`：仅新增这一条英文翻译；
- `test/perf-ui.test.js`：新增一条用例，覆盖非空、空数组、字段缺失三态。

`summary.perf.missingSources` 非空时，notices 增加：

```html
<p class="perf-notice status" role="status">部分来源已缺失，已保留历史数据。</p>
```

复用既有 `copy(text, locale)`，因此英文由翻译字典提供，文本统一经过现有 HTML 转义。提示只输出固定文案，不读取或显示 `homeId`、原始路径、日志或缺失条目内容。`missingSources=[]` 与旧包无该字段均不显示；ready 状态、degraded 判定、unsupported/warning notice 与排名逻辑不变。`public/index.html`、样式和其他性能页面未改。

断言覆盖：

1. ready 且 `missingSources` 非空时，中文出现带 `class="perf-notice status"`、`role="status"` 的固定提示；英文出现对应翻译。
2. 测试夹具中的私有 home 与 Windows 路径不出现在输出，且不误触发既有“部分数据来源不可用”告警。
3. 同一 ready 夹具在 `missingSources` 非空时仍有 `perf.state=ready`、`perf.meta.state=ready`；清空为 `[]` 与删除字段后提示均消失，旧包字段缺失兼容。

本卡只接读侧反馈，不加载持久 missing 状态、不扩覆盖展开、不做归档 UI；数据侧需后续把真实 missing 状态投影到 `summary.perf.missingSources`。

## UI-missing-API：真实 missing 状态到达 API 与覆盖提示

本卡只新增 `test/history-retention-api.test.js` 并更新本报告；未改 `src/server.js`、`public/*`、store、rollup 或旧测试。

用例复用 `createPerfCodexIntegrationFixture()`，先以 `UsageStore` 同步夹具并写入请求计时证据，再启动仅监听 `127.0.0.1` 随机端口的临时 server。选择该顺序是因为执行器不会传递不可克隆的 `lookupRequestTiming` 函数，预写库可让 API 返回真实 groups/models。

1. 首次 `GET /api/summary?preset=all` 断言 `summary.perf.missingSources=[]`。
2. 删除第二个 rollout 后再次请求，默认 sync 刷新持久 missing 状态；精确断言 `[{ path: 被删路径, kind: "extra" }]`，并逐字比较删除前后的 `groups`、`models` 与 `coverage`，证明历史统计未被截断。
3. 把同一 API 响应的 `summary.perf` 直接传给 `renderPerfCoverageHtml`，断言中文“部分来源已缺失，已保留历史数据。”与英文翻译出现。
4. 按原内容及原 `atime/mtime` 恢复 rollout，再请求一次；断言 missing 清空、历史统计仍相同，中英文提示均消失。

这是 HTTP API 到渲染函数的集成验证，不是浏览器实测；没有验证真实 DOM 挂载、视觉布局或其他页面。

## UI-full-missing-oracle：full 报告未继承持久 missing 状态

本卡只扩展 `test/history-retention-api.test.js` 与本报告，未改 `src/server.js`、`src/usage-core.js`、store、rollup 或 public。

同一删除/恢复状态新增 `GET /api/usage?detail=full&preset=all`，直接与同一时刻的持久 `/api/summary?preset=all` 对照：

1. 删除第二个 rollout 后，持久 summary 的 `missingSources` 精确为单条 `{ path: 被删路径, kind: "extra", ... }`；full summary 实际返回 `[]`。删除后的 full 与持久 `groups/models/coverage` 在该次运行中仍一致，缺口只在 missing 投影。
2. 恢复原内容及原 `atime/mtime` 后，持久 summary 与 full summary 的 `missingSources` 均为 `[]`。
3. 该次施工运行在恢复后的历史统计比较前失败，因此当时只确认删除时 full 历史统计一致；恢复后的统计一致性仍由已接受的 UI-missing-API 用例覆盖。主审后续已修复 full missing 投影与历史统计并接受该卡，以上失败仅保留为施工历史。

当前断言按真实契约要求 full 与持久 summary 的 missing 数组逐字相等，不使用“full 应为空”的弱化预期。失败信息同时输出 full 删除/恢复值与持久删除/恢复值，便于 owner 复现：

```text
full missingSources=[]; persisted kind=extra
```

判定：UI-missing-API 的 summary→组件链已接受；full 路径未接线，本卡失败并交 owner 修 `usage-core`/full 报告装载，不在本测试卡修改生产代码。未扩 freeze、浏览器或全部 API。

## UI-full-first：full 自身刷新且保留历史统计

本卡只改 `test/history-retention-api.test.js` 与本报告；生产模块冻结，未改 server/core/store/public。

请求顺序改为每轮都先 full、后 summary，避免 summary 先行触发 sync 造成假阳性：

1. 初始 summary 取得 `groups/models/coverage` oracle 并确认 `missingSources=[]`。
2. 删除第二个 rollout 后先请求 `/api/usage?detail=full&preset=all`，再请求 `/api/summary?preset=all`。
3. 两条路径的 `missingSources` 都精确映射为单条 `{ path: 被删路径, kind: "extra" }`；full 的 `groups/models/coverage` 与初始 oracle 逐字相等。
4. 恢复原内容及原 `atime/mtime` 后仍先 full、后 summary；两者的 `missingSources` 均为 `[]`，full 与 summary 的 `groups/models/coverage` 也都与初始 oracle 逐字相等。

该顺序证明 full 响应自身会刷新并投影持久 missing 状态，不依赖先访问 summary。删除后与恢复后的 full 统计都对拍初始值，不只看缺失时的一次读数。

本卡仍不是浏览器实测，也不证明用量 totals 或 raw report 的历史完整性；只覆盖单个 Codex 夹具 rollout 的删除/恢复。

## UI-full-usage-oracle：缺失 project-log 后 full 用量与事件丢失

本卡只扩展 `test/history-retention-api.test.js` 与本报告；生产模块冻结，未改 server/core/store/public。

在既有 Codex 性能夹具的临时 `homeDir` 下增加一个真实 `project-log` 来源，写入：

```text
<projectRoot>/.codex-usage/usage.jsonl
```

单条事件为 `session_id=history-api-usage-session`、`timestamp=2026-07-12T02:00:00.000Z`、`model=gpt-6-luna`、`channel=Test`，token 为 `total=123, input=100, cached=20, output=23, reasoning=5`。用 `{ ...fixture.serverOptions, importDirs: [projectRoot] }` 预发布后关闭 store，再启动临时 loopback server。

1. 初始先请求 full，断言 `summary.totals.total=123`，并保存该 project-log 事件的 `{ sessionId, timestamp, total }` 作为原始载荷。
2. 删除 `usage.jsonl` 但保留 `projectRoot`；先请求 full，再请求 `/api/summary`。持久 summary 保留 `123` tokens 和原事件；full 实际返回：

| 路径 | `summary.totals` | project-log 事件 |
| --- | --- | --- |
| full（缺失时） | `{ total: 0, input: 0, cached: 0, output: 0, reasoning: 0 }` | `[]` |
| 持久 summary（缺失时） | `{ total: 123, input: 100, cached: 20, output: 23, reasoning: 5 }` | 原载荷 1 条 |

断言逐字比较 `full.summary.totals` 与持久 `missing.summary.totals`，并比较 full 的 project-log 事件投影与 `[originalEvent]`。实际失败为 full 两项均为空，故本卡不改生产代码，也不弱化断言。
3. 按原内容及原 `atime/mtime` 恢复文件后仍先 full、后 summary；两者 `summary.totals` 都等于初始值，full 的 project-log 事件仍恰好 1 条且载荷等于初始值，证明恢复不重复计数。该恢复断言位于失败点之后，本卡未执行到。

判定：持久 store 的用量历史和 project-log 事件仍可读，但 full 内存报告在来源缺失时未接入这些历史事实；owner 需把保留的 usage totals/raw report 数据接入 full 路径，不在本测试卡修改生产代码。

## UI-full-usage-scope：两来源保留、排除与恢复去重

本卡只扩展 `test/history-retention-api.test.js` 与本报告；生产模块冻结，未改 server/core/store/public。以下保留原始 oracle 的 `123` 单来源反例作为历史缺陷证据，不把它写成当前失败。

在同一 Codex 性能夹具下新增两个真实 project-log 来源：

| 来源 | session | model | total | 删除对象 |
| --- | --- | --- | ---: | --- |
| `usage-project` | `history-api-usage-session` | `gpt-6-luna` | 123 | `usage.jsonl` |
| `retained-usage-project` | `history-api-retained-session` | `gpt-6-sol` | 77 | 保留 |

初始 full 请求必须得到 `total=200` 与两条公开 project-log 事件。删除第一个来源后，full 必须仍返回持久 summary 的总量 `200` 和原两条事件；持久 summary 也保留同样结果。随后以缺失来源的 home id 排除该来源，full 与 summary 都必须只剩 `77` 和保留来源的事件。按原内容及原 `atime/mtime` 恢复文件后，full 与 summary 的总量都等于初始 `200`，full 事件恰好等于初始两条，证明恢复没有重复计数。

该卡已由主审依赖 `publishedUsageEvents` 后独立复跑，API 4/4 通过，耗时 `5918.8944ms`。它只证明已发布事件与 totals 的保留/排除/恢复；不把 token 保留当作 `sessions` 或 `homes` 元数据已完整，也不验证浏览器。

## UI-full-session-oracle：sessions 与 homes 的缺失态保留

本卡只扩展 `test/history-retention-api.test.js` 与本报告；生产模块冻结，未改 server/core/store/public，也未新增 fixture。

在 UI-full-usage-scope 的同一初始 full 响应中，从两条公开 project-log 事件取得两个 `sessionId`，断言 `report.sessions` 中存在且仅存在对应的两个原 session；对每个 session 保存 `{ id, homeId, eventCount }` 作为 oracle。初始 `report.homes` 的 project-log 子集保存 `{ id, kind, path }` 两项 oracle。

删除 `123` 来源后，在同一缺失状态下增加三项核心断言：

1. `report.sessions` 的对应 session 集合逐字等于初始 oracle，两个原 session 都保留。
2. `metadata.sessionCount` 等于 `report.sessions` 中唯一 `id` 的数量，避免只保留事件而报告元数据继续按缺失来源重新计算。
3. `report.homes` 的 project-log 子集逐字等于初始 oracle，保留两个 home 的原 `id`、`kind` 与 `path`。

恢复文件后重复三项对拍，并要求事件集合仍等于初始两条，证明 session/home 恢复不重复。

实际定向运行先通过了初始 `total=200`、两条事件和两个 project-log home 的前置断言；删除来源后的 full 请求返回 `200`，totals/events 保留断言通过，但新增 session 断言得到精确反例：

```text
actual session ids: [history-api-retained-session]
expected session ids: [history-api-retained-session, history-api-usage-session]
```

因此当前缺口是 `report.sessions` 只保留未缺失来源的 session；`metadata.sessionCount`、`report.homes` 与恢复后的去重断言位于该失败点之后，本卡未执行到。断言保持严格相等，不改成按事件重新生成 session，也不把缺失来源的 session 当成可以省略。

判定：UI-full-usage-scope 的 tokens/events 已接受；UI-full-session-oracle 给出 `sessions` 未随 `publishedUsageEvents` 一起保留的真实反例，交 owner 接线 `publishedUsageSessions`（或等价持久 session 投影）并同步 home/metadata 口径。不在本测试卡修改生产代码。

## UI-full-quota-oracle：rate-limit observations 的缺失态保留

本卡只扩展 `test/history-retention-api.test.js` 与本报告；生产模块冻结，未改 server/core/store/public，也未新增 fixture 或直接 SQL 种子。

复用 `createPerfCodexIntegrationFixture()`，在第二个真实 rollout 末尾追加一条原生 Codex `event_msg`：

```json
{
  "type": "event_msg",
  "timestamp": "2026-10-04T12:00:05.000Z",
  "payload": {
    "type": "token_count",
    "info": { "last_token_usage": { "total_tokens": 100, "input_tokens": 80, "output_tokens": 20 } },
    "rate_limits": {
      "limit_id": "codex",
      "primary": { "window_minutes": 300, "resets_at": 1788589205, "used_percent": 37 }
    }
  }
}
```

该行先经真实 `UsageStore.sync()` 发布，再启动临时 loopback server。测试保存初始 full 的 `report.rateLimitObservations` 作为 oracle，删除上述 rollout，先请求 full，要求观测数组逐字相等；随后按原内容及原 `atime/mtime` 恢复，再次要求观测数组逐字相等且没有重复。

施工早期定向运行曾通过初始观察数前置断言（`rateLimitObservations.length=1`），但删除 rollout 后的 full 请求返回 HTTP 500，未到达观测对拍：

```text
500 {"code":"EXECUTOR_ERROR","error":"store.publishedUsageSessions is not a function"}
```

这是并发接线中的历史中间态：`src/server.js:752` 已调用 `publishedUsageReport()`，但当时 `UsageStore`/执行器尚未提供该聚合入口；`publishedUsageSessions` 也未完成。该 500 不是 quota 观测已证实的错误，不能当作 quota 反例。测试始终保留严格 200 与逐字数组断言，不降级为“缺失时为空”，也不改用 SQL 直接验证。

判定：该接线缺口已由 owner 修复。主审在 2026-10-22 07:40 +08 独立复跑真实 API，初始原生观察、删除 rollout 后 full 完整数组保留、恢复后不重复均执行通过；此前 HTTP 500 与 `[]` 仅作为历史失败记录保留。本卡只证明单个 primary 观察的删除/恢复，不证明 secondary、多观察顺序或浏览器。

## C-regression-contract：schema 20 与表清单

定向运行 `test/perf-codex-index.test.js` 的 M7 迁移与 C3 生命周期用例时，旧断言实际得到 `20 !== 19`；这与 `src/usage-store.js` 的 `STORE_SCHEMA_VERSION = 20` 一致。本卡只修正测试契约，不修改生产行为。

- M7 的 `open()` 路径断言 schema 常量与 `PRAGMA user_version` 均为 20；迁移失败仍保留 v12，重试后回到当前 v20。
- C3 在 `store.sync()` 后断言 schema 20，并继续使用精确 `deepEqual` 锁定全部表名，不改成包含式或删除断言。
- v20 迁移在 `open()` 中创建 `history_replaced_facts`；`sync()` 调用 `createUsageRollups` 创建 `usage_rollup_format`、`usage_rollup_days`、`usage_rollup_daily`、`usage_rollup_sessions`、`usage_rollup_dirty_days`。C2-model-day 的 `usage_rollup_models` 只在重建目标日集合非空时于同一写事务创建；无事件的 no-op sync 不提前创建该表，保持既有精确表清单契约。
- 因此 M7 的 `open()` 用例只更新版本数字，不断言尚未由 `sync()` 安装的五张 rollup 表；C3 的表清单精确新增 `history_replaced_facts` 与这五张表，共 20 张。
- C3 原有“投影缓存不落盘”的 meta 键断言保留；过时的“禁止任何新增表”说明已改为“精确表清单仍锁定，但 rollup 表不新增 projection meta 键”。

## C3-archive-status-panel：轻量只读归档状态面板

本卡只改 `public/history-archives-ui.js`、`public/index.html`、`public/app.js`、`public/i18n.js`、`test/history-archives-ui.test.js` 与本报告。既有 `GET /api/history/archives`、server、store、rollup、pricing、`public/styles.css`、timeline、perf 与 skin 均未改。

面板放在 dashboard 底部，用原生 `<details><summary>` 提供键盘可操作的展开/收起；`#historyArchivesList` 按接口返回顺序展示归档段范围。聚合行使用“已登记归档段 / 已登记事件”措辞；行内 `eventCount` 只在 `present` 时展示，`missing`、`unreadable` 与未知状态不把登记元数据伪装成当前可用事件数。

| 状态 | 行内文案 | 事件数 |
| --- | --- | --- |
| `present` | `已登记（仅表示文件存在，未验证内容）` | 显示 `已登记事件：N` |
| `missing` | `文件缺失（范围保留，事件数不可用）` | 文案已说明不可用，不显示行内计数 |
| `unreadable` | `文件不可读（范围保留，事件数不可用）` | 文案已说明不可用，不显示行内计数 |

`refreshHistoryArchives()` 使用单调 request generation 丢弃过期响应；启动时请求一次，随后每次 `/api/usage` 成功刷新后再次请求。语言切换只重渲染缓存状态，不重新取数。HTTP 非 200、JSON 解析失败或网络异常统一进入错误态，不渲染伪造的 `0` 段/`0` 事件。

三个核心 Node 用例分别覆盖：`present` 的范围、登记事件数与“仅表示文件存在”文案；`missing`/`unreadable` 同时保留两条范围、显示不可用文案且不出现 `present` 文案或行内登记事件数；HTTP 非 200 与 fetch rejection 都显示明确错误且不出现零计数。i18n 静态标签与既有翻译守卫同批通过。

## C-browser-archive-freeze：真实 1920×1080 冻结反例（RED）

本卡只新增 `output/playwright/history-archive-freeze-server.mjs`、`history-archive-freeze-run-code.js`、`history-archive-freeze-post-error-code.js`、`history-archive-freeze-finalize.mjs`、JSON 证据与四张截图，并更新本报告；`src/`、`public/`、既有测试、production DB 与运行中服务均未改。夹具使用 workspace 内临时 runtime 目录启动真实 `createUsageServer`，登记一个 `present` archive authority 段，再按 authority 要求保留 live source identity、移除已归档 hot events；测试控制接口只临时把 `segment.sqlite` 改名为 `.bak`，用于模拟 live archive 消失。

静态接点与运行结果一致：`public/app.js:4383` 在每次成功 `loadUsage()` 后无条件调用 `historyArchives.refresh()`；`public/history-archives-ui.js:109` 固定请求 `/api/history/archives`；`src/server.js:686` 固定读取当前 `usageStore.historyArchives()`，没有 snapshot/freeze 参数。因此 `/api/usage` 的冻结快照不能约束归档状态面板。

浏览器为 Microsoft Edge `155.0.4283.62`（Playwright `browserType=chromium`、headless），requested/observed viewport 均为 `1920×1080`、DPR `1`。冻结由产品 `#autoRefreshToggle` 触发，取得 `snapshotId=36d81046-508e-4eca-a429-e181ccebd684`；移除临时段后点击产品 `data-preset="week"`，让 `loadUsage()` 在仍冻结时再次成功刷新。

| 阶段 | live archive API | 冻结 usage 请求 | 面板 DOM | 结论 |
| --- | --- | --- | --- | --- |
| 冻结前 | `200`, `present`, `1` 段 / `1` 登记事件 | 尚未冻结 | `present`，显示“已登记（仅表示文件存在，未验证内容）” | 基线成立 |
| 改为 missing、冻结刷新前 | `200`, `missing` | snapshot 尚未再次请求 | 仍显示 `present` | API 已变化，但仅因面板尚未刷新 |
| 冻结刷新后 | `200`, `missing` | `200`，URL 含 `snapshot=36d81046-508e-4eca-a429-e181ccebd684` | 变为 `missing`，显示“文件缺失（范围保留，事件数不可用）” | **RED：usage 冻结，但面板泄漏 live 状态** |
| 解除冻结后 | `200`, `missing` | live `/api/usage` 无 snapshot/freeze，`500`，`ENOENT` 指向临时 `segment.sqlite` | 仍为 `missing`；顶部错误详情可见完整 `ENOENT` | 面板与 live archive 状态一致，但 live usage 走明确错误路径 |

证据 JSON 中 `assertions.preFreezePresent=true`、`liveArchiveChangedToMissing=true`、`frozenRefreshUsedSnapshot=true`、`panelStayedFrozen=false`、`postUnfreezeArchivePanelMatchesLiveState=true`、`postUnfreezeUsageRequestOk=false`、`postUnfreezeErrorVisible=true`、`pass=false`；`verdict.status` 固定为 `RED`。

| 截图 | 像素 / bytes | SHA-256 |
| --- | --- | --- |
| `output/playwright/history-archive-freeze-pre.png` | `1920×1080` / `239994` | `d8700838ff19b41c96f6bd11c16dad37ee35d0cfa7e945566362e958d5888628` |
| `output/playwright/history-archive-freeze-changed-while-frozen.png` | `1920×1080` / `238409` | `31b0593f786019cd146b0ba4451ee9b6eb2ea7f5840732e1d63be5f2e70262e1` |
| `output/playwright/history-archive-freeze-post-unfreeze.png` | `1920×1080` / `238409` | `31b0593f786019cd146b0ba4451ee9b6eb2ea7f5840732e1d63be5f2e70262e1` |
| `output/playwright/history-archive-freeze-post-unfreeze-error.png` | `1920×1080` / `421333` | `4f25067e2751454bcfd7dec0bca53192185260ac8d23ace5ae21bbf1ee596465` |

`post-unfreeze` 与 `changed-while-frozen` 的截图 hash 相同，是因为解除冻结后的归档面板仍保持 live `missing` 状态；顶部 live usage 的 `500/ENOENT` 由第四张独立截图和 `phases.postUnfreezeError` 记录。最终 JSON 位于 `output/playwright/history-archive-freeze-evidence.json`；`history-archive-freeze-finalize.mjs` 会重新读取四张 PNG 的 IHDR、字节数与 SHA-256，并断言以上 red 状态。

## C-archive-freeze-client-wire：冻结归档状态接线（loopback GREEN，浏览器待复验）

本卡修复 `C-browser-archive-freeze` 记录的泄漏，不改变 server 既有 snapshot API。`public/history-archives-ui.js` 的 `refreshHistoryArchives()` 在传入 `snapshotId` 时请求 `/api/history/archives?snapshot=<encodeURIComponent(id)>`，否则请求 live `/api/history/archives`；`public/app.js` 在成功 `/api/usage` 后使用当前 `state.snapshotId` 刷新归档，并在解除冻结时先清空 snapshot、立即发起 live 归档刷新，然后才启动 live usage。旧 snapshot 请求即使晚到，也会被单调 generation 丢弃，不能覆盖 live 状态。

loopback 使用真实 `createUsageServer`、真实 snapshot API 和经 `verifyHistoryArchiveCandidate()` 验证的候选归档。Windows sandbox 不允许硬链接，且临时路径接近 MAX_PATH，因此夹具仅在 freeze 期间暂时隐藏 live 注册，再把候选数据库与 manifest 复制进 snapshot 目录并分别注册到 live / snapshot SQLite；这不改变 production 的 snapshot、归档读取或状态 API 路径。结果：

| 阶段 | live archive | snapshot archive | 冻结 usage | 结论 |
| --- | --- | --- | --- | --- |
| 启动 | `200 present` | 尚未冻结 | 未请求 | 基线成立 |
| freeze + 注册候选 | `200 present` | `200 present` | `200` | snapshotId 已绑定 |
| 删除 live segment | `200 missing` | `200 present` | `200` | 冻结状态未泄漏 |
| 解除冻结 | `200 missing` | 不再使用 | live usage `500 ENOENT` | live 归档仍可独立刷新 |

本次 loopback 的 snapshot id 为 `7348b0eb-7b0d-4271-9ac0-098a1a9274ea`；live usage 的 `500` 明确是删除临时 `segment.sqlite` 后的 `ENOENT`，不是把失败包装成通过。真实 Microsoft Edge 复验尚未执行：Playwright Edge 启动和 CUA 打开 origin 均被当前环境的审批门阻塞，不能声称浏览器通过或生成截图/JSON。既有 RED 的截图、JSON 与 hash 保持不变。

| 当前文件 | SHA-256 |
| --- | --- |
| `public/app.js` | `60c27f82b73ddc623846d9594706c6f98448b4613a4f3a60e083be3bc7570f35` |
| `public/history-archives-ui.js` | `f2a548b3a939bc40ecdf705d0efbd364310972c83e0eadaae676a3d88c04c7f2` |
| `test/history-archives-ui.test.js` | `329f96a68d2999c0606bf31a6ec545ef34ede3b0e5cbc7bdb5ef5da56e9d9035` |
| `output/playwright/history-archive-freeze-fixed-server.mjs` | `0dfe63f6e44bb14416cada3a6ac9bb6263ba934093dd6b5313446f7159f90320` |
| `output/playwright/history-archive-freeze-fixed-run-code.js` | `e8f9d534bbfefbdd46b865f349ce4d92ec4881e1c047d1f0d3ffcb39ddaeeac2` |

## C-archive-freeze-keyboard-language：键盘与语言复验（GREEN，主审已接受）

主审已独立接受 `C-archive-freeze-client-wire`：聚焦测试 `77/77`、`218.3942ms`，scoped Biome 通过；其原始夹具使用正常 host hard-link snapshot，在移除 live segment 后，冻结 usage 仍为 `200`、snapshot 归档 URL 仍为 `200 present`，解除冻结才切到 live `200 missing`。接受范围仅为单段 freeze 接线；issue 18 仍未完整关闭。

本卡不重复实现或修改生产接线，只在原始临时夹具上用真实 Microsoft Edge `155.0.4283.62`（User-Agent 含 `Edg/155.0.0.0`，headless，`1920×1080`）验证产品交互。夹具只有一个 `present` 归档段：

| 字段 | 值 |
| --- | --- |
| segment id | `47eb8d04a0b4a86b117d88b6d56a68da5bcfe024226a51bdd6ee438fe02766b7` |
| half-open range | `1790910245000` 至 `1790910305000` |
| registered events | `1` |
| snapshot id | `9cfa1ad9-65c2-478f-99de-a5b17f74e943` |
| run duration | `1136ms` |

通过产品按钮冻结后，`/api/history/archives?snapshot=9cfa1ad9-65c2-478f-99de-a5b17f74e943` 是冻结阶段唯一归档请求；没有 live `/api/history/archives` 请求。`summary` 获得焦点后，Space 使 `<details>.open` 从 `true` 变为 `false`，再次 Space 恢复 `true`；折叠和展开两个阶段焦点都仍在 `SUMMARY`。随后一次语言按钮点击把 locale 从 `zh-CN` 切到 `en-US`，面板保持展开，段状态与范围同步重渲染。证据 JSON 的 12 项断言全部为 `true`，最终 `assertions.pass=true`、`verdict.status=GREEN`。

| 截图 | 像素 / bytes | SHA-256 |
| --- | --- | --- |
| `output/playwright/history-archive-freeze-keyboard-collapsed-zh.png` | `1920×1080` / `308633` | `86391fed03f4241773050c0391281a14d8442b29028f3723229803d007cda68a` |
| `output/playwright/history-archive-freeze-keyboard-english-open.png` | `1920×1080` / `246090` | `132f2e00fda5d689a493dd0d5941474ad68fb77251970551e3a59e16ecfca760` |

断言固定为：初始中文、冻结来自产品控件、首个归档响应使用 snapshot、键盘折叠、键盘重新展开、中文范围与状态、英文重渲染后保持展开、英文范围与状态、冻结阶段全部归档请求带同一 snapshot、冻结阶段无 live 归档请求、无采证阶段 console error、无 page error。中文显示 `范围：2026年10月2日 11:04:05 至 2026年10月2日 11:05:05`，英文显示 `Range: Oct 2, 2026, 11:04:05 AM – Oct 2, 2026, 11:05:05 AM`，两者是同一段范围。2026-10-24 12:03 的 CLI 首次打开探针在采证 listener 安装前记录一次 `/favicon.ico` 404；正式 run-code 的 goto、冻结、键盘和语言阶段没有 console/page error。

主审另在 `history-review` 会话对原始 `3884` 正常 fixture 独立复跑，`1125ms` 完成，取得另一 snapshot `f2dc77bc-409b-4086-ac7e-a77d33b91c83`，全部 `13/13` 断言为 `true`，并目视检查英文主视图截图。主审接受键盘/语言冻结限定行为；该接受不表示多段、axe、移动端或其他浏览器已覆盖。

| 采证文件 | SHA-256 |
| --- | --- |
| `output/playwright/history-archive-freeze-keyboard-run-code.js` | `0ae512906caa3655cb6563b5a0bbf202e6616a12513e33c936b0154e4bfd76b7` |
| `output/playwright/history-archive-freeze-keyboard-finalize.mjs` | `27b7cdaae0b41d20a5ff0ca7794f067ffebc8a5de1ecb8356f4be93ebfe40ae0` |
| `output/playwright/history-archive-freeze-keyboard-evidence.json` | `7d84a3584ad9fdd48ba212c3e5702e1b3134b61ee6c73ca6ada5294449f5c86e` |

## C-archive-sealed-days-ui：按需展开封存 UTC 日统计（mock-only，待主审复核）

本卡只改 `public/history-archives-ui.js`、`test/history-archives-ui.test.js`、`public/i18n.js` 与本报告。日统计请求沿用既有封闭接口契约：`GET /api/history/archives/{encodeURIComponent(segmentId)}/days`，活动归档视图带 snapshot 时追加 `?snapshot={encodeURIComponent(snapshotId)}`。响应必须精确匹配：

```json
{
  "segmentId": "<requested segment id>",
  "calendarZone": "utc",
  "view": "sealed",
  "days": [
    {
      "day": "YYYY-MM-DD",
      "eventCount": 0,
      "totals": { "total": 0, "input": 0, "cached": 0, "output": 0, "reasoning": 0 }
    }
  ]
}
```

每个 `present` 段渲染自己的原生 `<details><summary>`。初始只显示“展开后读取封存日统计”；打开后才发请求，并按 `segmentId` 缓存 `idle/loading/loaded/error` 状态。`missing`、`unreadable` 段即使展开也不请求，直接显示封存日统计不可用。日 payload 会校验 segment id、`calendarZone="utc"`、`view="sealed"`、`YYYY-MM-DD` 日键，以及事件数和五项 token 均为非负安全整数；HTTP 非 200、JSON 失败或格式错误都在原段范围下显示明确错误和不可用，不伪造 `0` 计数。

`archiveLoadId` 隔离旧的归档列表刷新，`archiveDayLoadIds` 再按段隔离旧日统计响应；任一需要的新刷新会递增 generation，使旧 snapshot 的晚到响应不能覆盖当前 live 或更新后的段状态。语言切换只调用 `rerenderHistoryArchives()`，保留已打开段和已加载日数据，不重新请求。列表级刷新会清空日缓存、打开集合和日请求 generation，避免把上一段/上一 snapshot 的封存数据带入新列表。

八个 UI 用例中，本卡新增的三个核心场景覆盖：首次展开前零日请求、展开后真实日 payload 渲染且语言重渲染保持 open/数据/请求数不变；frozen day URL 携带 snapshot，随后 live 列表刷新使旧 frozen 日响应失效；`missing` 段不发日请求，`present` 段 HTTP 500 保留两段范围并禁止伪造零计数。完整验证：

```powershell
node --test test/history-archives-ui.test.js test/i18n.test.js test/app-render.test.js
# exit 0; 80 tests, 80 pass (259.7632ms)

npx --no-install biome check public/history-archives-ui.js public/i18n.js test/history-archives-ui.test.js
# exit 0; 3 files checked, no fixes applied (17ms)

node --check public/history-archives-ui.js
node --check public/i18n.js
node --check test/history-archives-ui.test.js
# exit 0 for each
```

| 当前文件 | SHA-256 |
| --- | --- |
| `public/history-archives-ui.js` | `ecac450a3b400ef03b1d6fa32ccf8a958fe1184ef880238fe7d2bdc68613327f` |
| `public/i18n.js` | `b2392b9b759fc54ce6d243fc064cee89a9209e7c57cbae5d67a23b5b8073fed9` |
| `test/history-archives-ui.test.js` | `86d86556c53da297b846510509324175de49502ac895bf9fb5dd571aeeda4fe0` |

本卡没有启动真实 API、DOM 监听器或浏览器；`mountHistoryArchives()` 的 capture-phase `toggle` 接线只做了直接 handler 单测。未覆盖 1920 视觉、真实键盘展开、landed endpoint、并发多段展开或 overlay 混合；server/store/executor 与 production 数据均未改。

## C-sealed-days-browser：主审真实 Edge 全流程已接受

本卡只新增 `output/playwright/history-sealed-days-*` 并更新本报告；允许范围内只改 `public/history-archives-ui.js` 与 `test/history-archives-ui.test.js`。`public/i18n.js`、`public/app.js`、`public/index.html`、CSS、server、store、executor、timeline 与 perf 均未改。施工前具名拷本：

| 前像 | SHA-256 | 当前 | SHA-256 |
| --- | --- | --- | --- |
| `output/playwright/history-sealed-days-pre-public-history-archives-ui.js` | `ecac450a3b400ef03b1d6fa32ccf8a958fe1184ef880238fe7d2bdc68613327f` | `public/history-archives-ui.js` | `b91361027f0dc4a78e357183267e889bd78810d700c35a2d0b8aef34b0f87acb` |
| `output/playwright/history-sealed-days-pre-test-history-archives-ui.test.js` | `86d86556c53da297b846510509324175de49502ac895bf9fb5dd571aeeda4fe0` | `test/history-archives-ui.test.js` | `238198f2d6cf37890cec819f432cf7968f07097aac279e09a82038441ca8c1f3` |

精确 unified diff 为 `output/playwright/history-sealed-days-fix.diff`（SHA-256 `40e7333f9949ad6c20821c9e24d75c997730b0366a2a01aa4e59082119c7dc2a`）。修复只有两点：

- sealed day 的 `eventCount` 仍必须为非负安全整数；五项 token totals 改为有符号安全整数，合法负修订不再被误判格式无效。一个小回归同时证明负 totals 渲染、负 `eventCount` 仍拒绝。
- `rerenderHistoryArchives()` 在替换 `innerHTML` 前记录目标段内 focused `SUMMARY`，替换后按同一 `data-archive-segment-id` 恢复 focus 并 `preventScroll`。这直接覆盖 days loading/loaded rerender 与语言 rerender 的 list replacement，但真实 capture-phase toggle 接线仍需浏览器确认。

真实 API oracle 使用原始 `history-archive-freeze-server.mjs` 正常 hard-link 夹具，URL `http://127.0.0.1:7224`，segment `3c775c65ff05f851833efe5928896448e8c1c196d67c14746b0809e3f2ef73e2`。live days 为 HTTP 200 且精确等于 sealed UTC oracle：`2026-10-02`、`eventCount=1`、总/输入/缓存/输出/推理 `20/18/0/2/0`。产品同路径 freeze 取得 snapshot `b1455ad7-4941-4ea3-a337-4d17d2f46619`；移走 live segment 后，snapshot archive 仍 `present` 且 snapshot days HTTP 200 等于同一 oracle，live archive 为 `missing`，live days 为 HTTP 500；随后恢复 live archive 为 `present`。六项 API 断言全部为真，证据在 `output/playwright/history-sealed-days-api-oracle.json`。

worker 环境未执行真实 Microsoft Edge：Playwright run-code 自动审批连续两次超时；CUA 对 `http://127.0.0.1:7224` 的 origin gate 连续两次超时；固定本地 runner 也连续两次未获审批。原 Edge 已批准标签中没有该 fixture origin。失败记录保留在 `output/playwright/history-sealed-days-browser-blocked.json`，这只是 worker 环境限制，不是产品失败，也未据此伪造 DOM 断言、截图或 GREEN。

主审已在正常 host 的原 fixture 与真实 Microsoft Edge 接手，并完成 days/Space 焦点/语言/freeze/实际移走 live/unfreeze 全流程。主审原始证据 `output/playwright/history-main-sealed-days-evidence.json` 为 `1981ms`、Edge `155.0.4283.62`、`1920×1080`、snapshot `a8dcbca8-c1f0-4e2f-a10a-9a76b4904d11`；16 项行为断言全部为 `true`，只有 `noConsoleErrors=false`，唯一 console 是故意移走 live 段后 `/api/usage` 的 500，因此首轮 `pass=false`。该原证据保持原样。

主审随后复制脚本，只精确绑定该预期 live-missing usage 500 URL，不泛化忽略 console；复验证据 `output/playwright/history-main-sealed-days-verified.json` 为 `1940ms`、snapshot `8741107e-b27c-4792-9103-07c8b901186e`，全部 `18/18` 断言为 `true`，包括 `expectedLiveMissingUsageFailure=true`、`noUnexpectedConsoleErrors=true`、`noPageErrors=true` 与 `pass=true`。唯一 console 条目的 URL 固定为 `http://127.0.0.1:1649/api/usage?preset=week&bucket=day&calendarZone=local&view=dashboard`。五张 `history-main-sealed-days-*.png` 已由主审目视验收；`17` 项行为断言加 `pass=true` 共 `18/18` 全真，预期 live-missing usage 500 只按精确 URL 绑定。

| 主审证据 | bytes | SHA-256 |
| --- | ---: | --- |
| `output/playwright/history-main-sealed-days-evidence.json` | `22718` | `131b9952f381406a2272d2c367e974bb8ddb4b140900916758eee5163640a159` |
| `output/playwright/history-main-sealed-days-verified.json` | `31228` | `b709a0e0376202905f9d3cc0e69ff271e71414020af69fecc5c9ed53736e3a34` |

worker 的 `history-sealed-days-run-code.js`、`history-sealed-days-finalize.mjs` 与阻断记录仅作历史证据保留；renderer 与 tests 现已冻结，不再重试审批，也不扩复制 harness。

验证命令：

```powershell
node --test test/history-archives-ui.test.js test/i18n.test.js test/app-render.test.js
# exit 0; 82 tests, 82 pass (217.3223ms)
# 主审独立复跑：82 tests, 82 pass (225.7113ms)

npx --no-install biome check public/history-archives-ui.js test/history-archives-ui.test.js
# exit 0; 2 files checked, no fixes applied (10ms)

node --check public/history-archives-ui.js
node --check test/history-archives-ui.test.js
node --check output/playwright/history-sealed-days-run-code.js
node --check output/playwright/history-sealed-days-finalize.mjs
# exit 0 for each

node output/playwright/history-sealed-days-api-check.mjs http://127.0.0.1:7224
# exit 0; six real loopback API assertions true
```

| 证据文件 | SHA-256 |
| --- | --- |
| `output/playwright/history-sealed-days-run-code.js` | `6af1bb01c45298579ba4c0166931e87c3eb71bad6b692c81c1295dc402ae9411` |
| `output/playwright/history-sealed-days-run.ps1` | `fbab8e0b9587490890a2e4e175ea13bf5f1007c018a1e6f4ba3953f034a50d4d` |
| `output/playwright/history-sealed-days-finalize.mjs` | `db285e77fa54bb15947da790e20311e108fa454064bce70ede4b632755f2c0df` |
| `output/playwright/history-sealed-days-api-check.mjs` | `18281c770f95fcc6fb204e970f368a2365764428f26f6d6b46b08271fd4ef4ac` |
| `output/playwright/history-sealed-days-api-oracle.json` | `b85eb81dcb02c330b2cf9bc9f75bc58f6eb644e6db55c7a6141a397353f30b3d` |
| `output/playwright/history-sealed-days-browser-blocked.json` | `ccc02d48449720e12091c6b16cce51cf2b496370e6a7b943c135031e00dbc7e2` |

## C-sealed-day-event-drilldown：按需读取封存原始事件（主审真实 Edge 已接受）

本卡只改 `public/history-archives-ui.js`、`public/i18n.js` 与 `test/history-archives-ui.test.js`，并新增专属 `output/history-retention-profile-20261025-sealed-day-event-drilldown/` 证据。server、executor、store、`public/app.js`、`public/index.html`、CSS、timeline、perf 与既有 benchmark 均未改。施工前像、当前文件大小与 SHA-256 如下：

| 文件 | 前像 bytes / SHA-256 | 当前 bytes / SHA-256 |
| --- | --- | --- |
| `public/history-archives-ui.js` | `14048` / `AA116650776479F552B18CA04B1C221A040EFEFFB8E30F7B5AF600323E1AA971` | `25322` / `EE265D12E80E3E186F920C892F40234CF0182D2BE8A0454C5BB64D61962791A2` |
| `public/i18n.js` | `47729` / `445E3479C4C868A75028DE53C8F44F5D4EC5B7D7E1F2F8D87A2E434BBE6E729B` | `48215` / `D60436DF5213B5983ED5A3B540F00DC9644F452D8CB0E4308BF27285CF016BB1` |
| `test/history-archives-ui.test.js` | `18026` / `71062FA90C8BF7B4C7E0556216C7A419622DB6479663F3009D9D9E344753BFCF` | `28512` / `05FF5508E153E1EFE19D08E84F1FB88F3AE5D2D3D045907519203B341441588B` |

封存日行现在是嵌套的原生 `<details><summary>`。已加载日的日期、事件数和五项 token 总数保留在闭合 `summary` 内，用户不必展开或加载逐事件即可继续查看原 dayline；展开某日才请求 `GET /api/history/archives/{encodeURIComponent(segmentId)}/events`。查询固定为 `startMs=<UTC 日 00:00>`、`endMs=<下一 UTC 日 00:00>`、`limit=100`，活动 snapshot 存在时追加 `snapshot`。响应必须精确绑定请求段与日界，`view="sealed"`，事件 id/时间/五项 token 均为安全整数；首屏省略 `afterId`，只有 `nextAfterId !== null` 才显示“下一页”，后续页发送该精确游标，不预载整段。

事件行显示本地时间、模型、总量/输入/缓存/输出/推理，并明确标注“原始封存版本，不含当前覆盖层”。段列表刷新沿用 `archiveLoadId`，日请求按段、事件页按日分别用 generation guard；旧 snapshot 或同日旧响应不能覆盖当前 live 视图。事件页响应完成时重新读取当前 locale，因此加载中切语言不会再被旧响应刷回旧语言；已加载日的语言重渲染保留 open 状态与响应缓存，不重复请求。`missing`/`unreadable` 段不请求日或事件，HTTP/格式失败只显示明确不可用，不伪造事件。

焦点恢复覆盖段 summary、日 summary 与下一页按钮。下一页 loading 态使用 `aria-disabled="true"` 而不是原生 `disabled`，避免替换聚焦按钮后无法恢复键盘焦点；handler 仍只在当前页为 `loaded` 时发送后续请求。最后一页使按钮消失时，焦点回退到同段同日 summary，再回退到段 summary，不落到 `body`。

本卡新增的三个核心用例覆盖：只请求被展开 UTC 日的首页并核验完整 URL、snapshot、事件字段和下一页，且在加载中切到中文后最终使用中文重渲染；使用精确 `afterId=42` 翻页且旧 snapshot 晚到响应被丢弃，并断言 loading 按钮保持可聚焦；`missing` 段零请求、事件页失败不伪造行，以及末页按钮消失后的 summary 焦点回退。闭环日统计仍在 `summary` 内的断言也由现有 dayline 用例覆盖。完整聚焦验证：

```powershell
node --test test/history-archives-ui.test.js test/i18n.test.js test/app-render.test.js
# worker: exit 0; 86 tests, 86 pass (204.5828ms)
# 主审独立复跑: 86 tests, 86 pass (229.8068ms)

.\node_modules\.bin\biome.cmd check public/history-archives-ui.js public/i18n.js test/history-archives-ui.test.js
# exit 0; biome: ok

node --check public/history-archives-ui.js
node --check public/i18n.js
node --check test/history-archives-ui.test.js
# exit 0 for each
```

结构化前像、当前哈希、命令与限制在 `output/history-retention-profile-20261025-sealed-day-event-drilldown/evidence.json`（`4853` bytes，SHA-256 `1B68AB5DE6EFD141AB60B7551407CDDBA415FD2F3CBFC63A8A605B2970E42000`）。`test/history-archive-event-page.test.js` 在 worker 沙箱内因 hard-link fixture 返回 Windows `EPERM`，未作为产品失败或 landed endpoint 通过；server 与 landed endpoint 代码未改。

主审已在真实 Microsoft Edge `155.0.4283.62`（headless）、`1920×1080` 下完成本卡验收，run `2294ms`、snapshot `88ccb0f0-0aad-4882-882d-633e9daabd95`。105 事件夹具的首日页请求为 `limit=100` 并返回 id `1..100`、`nextAfterId=100`，第二页用精确 cursor 返回 id `101..105`、`nextAfterId=null`；闭合日 summary 直接显示 `105 / 2,100 / 1,890 / 0 / 210 / 0`。键盘展开后焦点留在 summary，切换中英文后展开态、日线和焦点保持。四个归档段形成 `2+1+1` 的三个年带；产品按钮冻结后移走真实 live 段，snapshot 的首末页仍为 HTTP 200 且各自带同一 snapshot，解冻后 live 列表显示 missing、范围保留且事件数不可用。`20` 项行为断言加 `pass=true` 共 `21/21` 全真，无 page error，唯一 console error 是精确绑定的预期 live-missing `/api/usage` 500。五张 `history-main-details-*.png` 已随证据保存。

首轮 `2446ms` 运行使用另一 snapshot `c231b8df-af8c-4f9e-a3ca-937b8e24739e`，仅有 `sealedDaysOracleRendered` 与 `languageSwitchPreservedOpenAndData` 两项行为为 false，原因是脚本预期字符串未写千分位 `2,100`；该结果已原样保存为 initial-number-format 证据，修正脚本预期后得到上述 GREEN，不是产品失败。

| 主审证据 | bytes | SHA-256 |
| --- | ---: | --- |
| `output/playwright/history-main-details-evidence.json` | `187622` | `56443AE7492D8D9DFD47ADD626D8677287230EDC58BCC8E97C8F560E6D9688E7` |
| `output/playwright/history-main-details-initial-number-format.json` | `188158` | `C6639C6B67659D908ECA9787E538A2E3D79D779699AB744310B1297C7C5D8F5E` |

接受范围是本卡 18 项 UI 子行为及其真实 Edge 闭环；axe、移动端、其他浏览器、并发多段与 overlay 混合仍未覆盖。`public/history-archives-ui.js`、`public/i18n.js` 与 `test/history-archives-ui.test.js` 自本轮证据起冻结，不再接收边缘探针；后续归 17 冻结 context 接线与 15 原子提交。

## 实际命令

```powershell
node --test --test-name-pattern='model range rollups match raw periodAggregate models across UTC boundaries' test/history-parity.test.js
# exit 0; 1 test, 1 pass (155.7202ms)

.\node_modules\.bin\biome.cmd check test/history-parity.test.js
# exit 0; 1 file checked, no fixes applied

node --test --test-name-pattern='v2' test/usage-rollups.test.js
# exit 0; 1 test, 1 pass (47.2105ms; current name: upgrades a real v2 cache to v7)

node --test --test-name-pattern='model' test/usage-rollups.test.js
# exit 0; 2 tests, 2 pass (146.7438ms)

node --test --test-name-pattern='reads model metrics across partial, complete, and boundary UTC windows' test/usage-rollups.test.js
# exit 0; 1 test, 1 pass (138.9257ms)

node --test --test-name-pattern='model window keeps complete-day and raw-edge values on one snapshot' test/usage-rollups.test.js
# exit 0; 1 test, 1 pass (161.6917ms)

.\node_modules\.bin\biome.cmd check test/usage-rollups.test.js
# exit 0; 1 file checked, no fixes applied

node docs/validation/2026-10-22-history-retention/benchmark-model-window.mjs
# exit 0; wall time 20.38s
# 1,000,000 events; cold/warm rollup outputs equal raw oracle

node --check docs/validation/2026-10-22-history-retention/benchmark-model-window.mjs
# exit 0

node docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs
# exit 0; wall time 46.05s
# real UsageStore schema 21; 1,000,000 events; cold/warm outputs equal raw oracle

node docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --process
# exit 0; wall time 33.36s
# 3 independent child processes; all cold outputs and 10 warm outputs equal raw oracle
# WAL truncate 67,108,864 -> 0 bytes; temporary directory removed

node docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard
# exit 0; all three HTTP 200 responses equal the SQL oracle
# benchmark-only setTimeout override: executor guard 120,000ms -> 600,000ms

node docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard-after-cache
# exit 0; 1,000,000 events; both HTTP 200 responses equal the SQL oracle
# timeout not overridden; no EXECUTOR_TIMEOUT observed
# first checked 141,217.44ms; skipCheck 103,419.98ms

node docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard-bottleneck
# exit 0; 100,000 rows; one skipCheck=1 summary in 6,442.82ms
# HTTP 200 and all counts/totals equal the SQL oracle
# worker-only method/SQL trace; no production change and no timeout override

node docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard-attribution
# exit 0; 100,000 rows; one skipCheck=1 summary in 6,513.92ms
# HTTP 200 and all counts/totals equal the SQL oracle
# event scan active 417.01ms / inclusive 3,418.37ms; timelineRange inclusive 3,469.80ms

node output/history-retention-profile-20261024/source-snapshot/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard-attribution
# C-current-dashboard-profile: exit 0; 100,000 rows; one skipCheck=1 summary in 3,550.0667ms
# HTTP 200 and all counts/totals equal the SQL oracle; timeout not overridden
# sync 1,385.91ms; cost scan active 234.94ms / inclusive 1,141.42ms

node output/history-retention-profile-20261024/source-snapshot/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --timeline-consumer
# C-timeline-consumer-split: exit 0; 100,000 events / 13 rows
# reference 905.0998ms; instrumented 606.6424ms; precomputed-cost bucketing 116.7749ms
# pricing memo 424.9899ms; estimate 153.9394ms; all three complete outputs deepEqual

node --check output/history-retention-profile-20261024/memo-eviction-probe.mjs
# C-bounded-memo-eviction-probe: exit 0

node output/history-retention-profile-20261024/memo-eviction-probe.mjs
# exit 0; 9 passes (3 forced, 3 no-eviction, 3 persistent-iterator control)
# medians: 81.1973 / 7.4186 / 7.2947ms; forced-vs-control delta 74.1797ms

node docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --timeline-consumer
# exit 0; 100,000 events / 13 rows; complete output deepEqual to UsageStore.timelineRange
# buildTimelineRows 2,052.70ms; estimateEventCost 1,310.33ms; timelineBucketKey replay 20.79ms

node --test test/pricing.test.js
# C2-minimum-rates-cache: exit 0; 34 tests, 34 pass (140.7150ms)

node --test --test-name-pattern="GLM-4.7|未知模型完整|最低费率缓存" test/pricing.test.js
# exit 0; 3 tests, 3 pass (97.9163ms)

node --test test/w4-event-cost-memo.test.js
# exit 0; 8 tests, 8 pass (177.1819ms)

node --test test/pricing-models.test.js
# pass with the same pricing batch; 6 tests, 6 pass

node --test test/claude-pricing.test.js
# host run after sandbox rename EPERM: exit 0; 11 tests, 11 pass (375.6746ms)

npx biome check --formatter-enabled=false src/pricing.js test/pricing.test.js
# exit 0; checked 2 files, no fixes applied

node docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --timeline-consumer
# C2-minimum-rates-cache: exit 0; 100,000 events / 13 rows; both outputs deepEqual
# buildTimelineRows 1,111.83ms; estimateEventCost 302.67ms; missing 198.56ms / exact 104.11ms

node --check docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs
# exit 0

node --test test/usage-rollups.test.js
# C2-model-window 施工时: exit 0; 24 tests, 24 pass (1136.3932ms)

node --test test/history-rollup-store.test.js
# exit 0; 16 tests, 12 pass, 4 skip (1206.0875ms)

.\node_modules\.bin\biome.cmd check src/usage-rollups.js test/usage-rollups.test.js
# exit 0; 2 files checked, no fixes applied

node --check src/usage-rollups.js
# exit 0

node --test test/perf-ui.test.js
# exit 0; 25 tests, 25 pass

node --test --test-name-pattern='M7 migration creates v13|C3 · 生命周期与不落盘' test/perf-codex-index.test.js
# exit 0; 2 tests, 2 pass

$env:TZ='Asia/Shanghai'; node --test --test-name-pattern='D2 · 时区' test/usage-store.test.js
# exit 0; 1 test, 1 pass

node --test test/history-retention-api.test.js
# UI-missing-API: exit 0; 1 test, 1 pass

node --test test/history-retention-api.test.js
# UI-full-missing-oracle: exit 1; 1 test, 0 pass, 1 fail
# fullMissingSources=[]; persisted kind=extra

node --test test/history-retention-api.test.js test/history-summary.test.js
# UI-full-first: exit 0; 2 tests, 2 pass

node --test test/history-retention-api.test.js
# UI-full-usage-oracle: exit 1; 2 tests, 1 pass, 1 fail
# actual: totals all zero, project events []
# expected: retained totals total=123, original project event 1

node --test --test-name-pattern="usage after a project-log source disappears" test/history-retention-api.test.js
# UI-full-session-oracle: exit 1; 1 test, 0 pass, 1 fail
# initial full passed: total=200, 2 events, 2 project-log homes
# missing full passed totals/events retention
# actual session ids: [history-api-retained-session]
# expected session ids: [history-api-retained-session, history-api-usage-session]
# metadata.sessionCount, report.homes and restore assertions not reached

node --test --test-name-pattern="preserves published rate-limit observations" test/history-retention-api.test.js
# UI-full-quota-oracle: exit 0; 1 test, 1 pass
# initial full passed: rateLimitObservations.length=1
# missing full retained the exact original observation
# restored full retained the exact original observation without duplication

node --test test/history-archives-ui.test.js test/i18n.test.js
# C3-archive-status-panel: exit 0; 16 tests, 16 pass (170.9485ms)

node --test test/app-render.test.js
# exit 0; 59 tests, 59 pass (233.9734ms)

.\node_modules\.bin\biome.cmd check --formatter-enabled=false public/history-archives-ui.js public/app.js public/i18n.js test/history-archives-ui.test.js
# exit 0; 4 files checked, no fixes applied

node --check public/history-archives-ui.js
node --check public/app.js
node --check public/i18n.js
node --check test/history-archives-ui.test.js
# exit 0

node output/playwright/history-archive-freeze-server.mjs
# isolated fixture; URL http://127.0.0.1:3004
# segmentId=7f7b237fea9d3091bb7e2b8fd191c7f6798512e3cb73c6c12872d8bc96b59aaa
# one present registered segment; hot events removed after authority registration

npx --yes --package @playwright/cli playwright-cli -s=history-archive-freeze open http://127.0.0.1:3004 --browser msedge
# Microsoft Edge 155.0.4283.62

npx --yes --package @playwright/cli playwright-cli -s=history-archive-freeze --raw run-code --filename output/playwright/history-archive-freeze-run-code.js > output/playwright/history-archive-freeze-evidence.json
# exit 0; viewport 1920x1080; panelStayedFrozen=false; pass=false
# snapshot=36d81046-508e-4eca-a429-e181ccebd684

npx --yes --package @playwright/cli playwright-cli -s=history-archive-freeze --raw run-code --filename output/playwright/history-archive-freeze-post-error-code.js > output/playwright/history-archive-freeze-post-error.json
# exit 0; visible error details: 500 ENOENT for the removed temporary segment.sqlite

node output/playwright/history-archive-freeze-finalize.mjs
# exit 0; verdict=RED; all four PNGs verified 1920x1080

node --check output/playwright/history-archive-freeze-server.mjs
node --check output/playwright/history-archive-freeze-run-code.js
node --check output/playwright/history-archive-freeze-post-error-code.js
node --check output/playwright/history-archive-freeze-finalize.mjs
# exit 0

node --test test/history-archives-ui.test.js test/i18n.test.js test/app-render.test.js
# C-archive-freeze-client-wire: exit 0; 77 tests, 77 pass (205.1267ms)

.\node_modules\.bin\biome.cmd check --formatter-enabled=false public/history-archives-ui.js public/app.js test/history-archives-ui.test.js output/playwright/history-archive-freeze-fixed-server.mjs output/playwright/history-archive-freeze-fixed-run-code.js output/playwright/history-archive-freeze-fixed-finalize.mjs
# exit 0; 3 files checked, no fixes applied (output/ is ignored by Biome)

node --check public/history-archives-ui.js
node --check public/app.js
node --check test/history-archives-ui.test.js
node --check output/playwright/history-archive-freeze-fixed-server.mjs
node --check output/playwright/history-archive-freeze-fixed-run-code.js
node --check output/playwright/history-archive-freeze-fixed-finalize.mjs
# exit 0

node output/playwright/history-archive-freeze-fixed-server.mjs
# isolated fixture URL printed on stdout; one verified archive candidate
# POST /_fixture/archive-stage {"action":"strip-live-archive"}
# GET /api/usage?freeze=1 -> 200 + snapshotId
# POST /_fixture/archive-stage {"action":"register-snapshot","snapshotId":"..."}
# GET /api/history/archives -> present; GET /api/history/archives?snapshot=... -> present
# POST /_fixture/archive-stage {"action":"remove-live-segment"}
# GET /api/history/archives -> missing; GET /api/history/archives?snapshot=... -> present
# GET /api/usage?snapshot=... -> 200; GET /api/usage -> 500 ENOENT

node --check output/playwright/history-archive-freeze-keyboard-run-code.js
# exit 0

npx --yes --package @playwright/cli playwright-cli -s=history-archive-freeze-keyboard open http://127.0.0.1:3884 --browser msedge
# exit 0; Microsoft Edge 155.0.4283.62; initial /favicon.ico 404 only

npx --yes --package @playwright/cli playwright-cli -s=history-archive-freeze-keyboard --raw run-code --filename output/playwright/history-archive-freeze-keyboard-run-code.js > output/playwright/history-archive-freeze-keyboard-evidence.json
# exit 0; 1920x1080; snapshot=9cfa1ad9-65c2-478f-99de-a5b17f74e943
# keyboard collapse/expand and zh-CN -> en-US rerender passed
# only frozen archive request: GET /api/history/archives?snapshot=...

node --check output/playwright/history-archive-freeze-keyboard-finalize.mjs
node output/playwright/history-archive-freeze-keyboard-finalize.mjs
# exit 0; verdict=GREEN; 12/12 assertions true
# both PNGs verified 1920x1080

node --check output/history-retention-profile-20261025-timeline-memo-direct-control/benchmark-model-store-timeline-memo-direct-control.mjs
# C-timeline-memo-direct-control: exit 0

node output/history-retention-profile-20261025-timeline-memo-direct-control/benchmark-model-store-timeline-memo-direct-control.mjs --timeline-memo-direct-control 1> output/history-retention-profile-20261025-timeline-memo-direct-control/run.stdout.json 2> output/history-retention-profile-20261025-timeline-memo-direct-control/run.stderr.log
# exit 0; 300000 events / 13 rows; six consumer runs in three alternating pairs
# every memo run: 0 hits / 300000 misses / 209334 evictions
# all six complete outputs deepEqual; direct did not add event.costEstimate

node --check output/history-retention-profile-20261025-timeline-memo-direct-control/verify.mjs
node output/history-retention-profile-20261025-timeline-memo-direct-control/verify.mjs > output/history-retention-profile-20261025-timeline-memo-direct-control/verification.json
# exit 0; pass=true; hashes, oracle assertions, pair arithmetic and stderr checked

# Scoped Biome was run on a temporary copy under src/, then the copy was deleted.
# Raw full-file check still reports upstream formatting plus existing line-1382 noAssignInExpressions.
# Temporary copy formatting + suppressing only that pre-existing line: write_exit=0, check_exit=0.

node --check output/history-retention-profile-20261025-full-summary-direct-control/benchmark-full-summary-memo-bypass.mjs
# C-timeline-direct-full-summary-control: exit 0

$env:CODEX_FULL_SUMMARY_DIRECT_CONTROL_EVENT_COUNT = "10000"
node output/history-retention-profile-20261025-full-summary-direct-control/benchmark-full-summary-memo-bypass.mjs --full-summary-direct-control 1> output/history-retention-profile-20261025-full-summary-direct-control/small-run.stdout.json 2> output/history-retention-profile-20261025-full-summary-direct-control/small-run.stderr.log
Copy-Item output/history-retention-profile-20261025-full-summary-direct-control/full-summary-direct-control.json output/history-retention-profile-20261025-full-summary-direct-control/small-run.result.json
Copy-Item output/history-retention-profile-20261025-full-summary-direct-control/normalized-summaries.json output/history-retention-profile-20261025-full-summary-direct-control/small-run.normalized-summaries.json
Remove-Item Env:CODEX_FULL_SUMMARY_DIRECT_CONTROL_EVENT_COUNT
# small-run gate: complete normalized summaries deepEqual; default 10000 misses, direct 0

node output/history-retention-profile-20261025-full-summary-direct-control/benchmark-full-summary-memo-bypass.mjs --full-summary-direct-control 1> output/history-retention-profile-20261025-full-summary-direct-control/run.stdout.json 2> output/history-retention-profile-20261025-full-summary-direct-control/run.stderr.log
# one 300k run; 300000 events / 256 sessions / 6 homes / 13 timeline rows
# complete normalized summaries deepEqual; default 300000 misses / 209334 evictions, direct all zero

node --check output/history-retention-profile-20261025-full-summary-direct-control/verify.mjs
node output/history-retention-profile-20261025-full-summary-direct-control/verify.mjs 1> output/history-retention-profile-20261025-full-summary-direct-control/verification.stdout.json
# exit 0; verification.json == verification.stdout.json; all 54 snapshot hashes unchanged
```

## 比较规则

- 边界、日键、计数和身份：完全相等。
- 金额：绝对误差小于 `1e-12`。
- 没有删除任意字段或使用无条件 skip。

## C-timeline-memo-direct-control：全 miss 时 memo 相对 direct 的追加成本

本卡只新增 `output/history-retention-profile-20261025-timeline-memo-direct-control/` 的独立 benchmark 副本、diff、结果、验证与日志，并更新本报告；生产源码、`public/`、测试、共享 benchmark、固定 snapshot 与旧证据均冻结。实验不启动 HTTP，不跑 1M，不改默认 memo/cache/budget，也不把 direct 计算当作生产修复。

| 固定输入 | SHA-256 | 说明 |
| --- | --- | --- |
| 上游 300k benchmark | `8ad3cf1a71f2549784da444b0f5308018e9c6ef29b074cabc83c103856a761f0` | 只读原件 |
| 本卡 benchmark 副本 | `cb0f74e4291096e2345e2f756c05e30798f66d16c7fb3d79db155e9036b8f064` | 只新增 `--timeline-memo-direct-control` |
| 精确 unified diff | `6876604876e56fab98999bdac58f28e9a4bb52850ec2c9e2d669da557d53977c` | 相对上游 300k benchmark |
| `src/usage-store.js` | `f501e615b93054bed272fc000466778f978444a57ebc0dc85ee9963168faef89` | 固定 snapshot |
| `src/pricing.js` | `12d39362f05027807634a66df9e2b08ed3812cfaafb4d327082102fd4fac4e58` | 固定 snapshot |
| `public/timeline-utils.js` | `ce55a5e5ff742b366aa09448052c36377be7bf2241d8be0fc31ff6c72f1d3c32` | 固定 snapshot |

同一固定 300k seed 先写入临时正式 schema，再由 `store.costEventsForRange()` 一次物化 `300000` 个事件（`1,267.1339ms`，不计入六轮对比）。固定范围为 `preset=all`、`calendarZone=local`、`bucket=month`，输出均为 `13` 行。memo 只在每轮调用时新建，使用默认 `maxEntries=262144`、`maxBytes=67108864`、`hardMaxBytes=201326592`，并在 `beginRound()/endRound()` 内调用；不跨轮复用。direct 每轮直接调用 `estimateEventCost(event)`，不写 `event.costEstimate`。三对轮换用于避免固定先后顺序：

| Pair | 顺序 | memo | direct | memo - direct | 相对差 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | memo → direct | `2,669.6917ms` | `1,350.7848ms` | `+1,318.9069ms` | `+97.64%` |
| 2 | direct → memo | `2,816.0806ms` | `1,054.4366ms` | `+1,761.6440ms` | `+167.07%` |
| 3 | memo → direct | `2,178.6944ms` | `1,078.6135ms` | `+1,100.0809ms` | `+101.99%` |

三个 memo 样本中位 `2,669.6917ms`，三个 direct 样本中位 `1,078.6135ms`；配对绝对差中位 `1,318.9069ms`，相对差中位 `101.9903%`。首轮 direct `1,350.7848ms` 明显慢于后两轮约 `1.05–1.08s`，说明本次仍有首次执行/JIT 噪声；因此只报告配对与中位数，不称 p95，也不把差值机械外推到别的 bucket、zone、SQL 或请求路径。

三次 memo stats 完全一致：

| 指标 | 每轮值 |
| --- | ---: |
| hits / misses | `0 / 300000` |
| evictions | `209334` |
| peak entries / `maxEntries` | `262145 / 262144` |
| peak bytes / `maxBytes` / `hardMaxBytes` | `194005917 / 67108864 / 201326592` |
| round 后 entries / bytes | `90666 / 67108835` |
| clears | `0` |

这组 stats 证明本控制实验确实处于持续 miss 与 entry/byte churn 状态，而不是 memo 命中场景。六次 `buildTimelineRows` 的完整输出（含 cost summary 与 uncertainty）互相 `deepStrictEqual`；direct 前后事件不具有 own `costEstimate` 字段，direct 也不保存 estimates。`verify.mjs` 重新校验 result/stdout 字节相等、所有哈希、六轮输出标记、stats、配对算术、中位数与 stderr 仅含 300k 插入进度，`verification.json` 为 `pass=true`。

结论限定为：在同一固定合成 300k consumer 上，fresh default-budget memo 相对于直接逐事件计价的追加成本，本次配对中位约 `1.3189s`。它证明缓存并非“无成本”，尤其全 miss/churn 时；但不证明删除 memo、改为 direct、长期不复用缓存或修改默认预算会改善生产请求。生产 memo 在后继 range/形状重叠时仍可能有收益，本卡没有测该场景。

主审已独立接受该限定 consumer 因果：复跑 memo/direct median 为 `2,669.6302 / 1,084.5986ms`，paired difference `1,585.0316ms`，三份 stats 仍是 `0 hits / 300000 misses / 209334 evictions`。接受不等于生产 SLA、默认 memo 应删除或完整 1M 请求收益；`#19` 仍按原状态处理。

证据文件：

- 结果 JSON 与 `run.stdout.json` 字节相同，SHA-256 `cecf3b823259bf95995d43858d94be58e16541c1e5d388b7ae0fd3a25d15ffa9`。
- `run.stderr.log` SHA-256 `be706dabed47e7e7faccec4fed1b26b897984dd5e345274ac93a267d87b4b097`，仅含 12 行 300k 插入进度。
- `verify.mjs` SHA-256 `9ae9c90eef92d9337bae6756bdf78f6f2f20979786989f87a72392aed1604631`；`verification.json` SHA-256 `ed1e7d567a55756b72c37d51084a85941aa66f35be9ce0b5512c261b8ed80365`。
- `biome-raw.log` SHA-256 `62a6b835f2f3f46ed463b4cdf98e748a1810bc6be044ed968ee42b0bbe446b84`；只保留 upstream 格式差异与既有 `noAssignInExpressions`。临时副本格式化且仅 suppress 该既有行后，Biome `write_exit=0` / `check_exit=0`，日志 SHA-256 `790216b23476ea205da12d3850eba24e6675c6f243f233b00c2fe412d1d9c971`。

限制：只测一组固定 seed 的合成 300k、一个 `local/month` consumer 输入和单进程六轮墙钟；不覆盖 SQL、HTTP、store sync、并发、冷盘、真实用户来源、其他 bucket/zone、p95、1M 或整站。`direct` 是控制变量，不是生产补丁；不改变默认 cache/memo/budget，也不提供 SLA 结论。#19 仍未关闭。

## C-timeline-direct-full-summary-control：完整 summary 内 timeline memo 增量

本卡只新增 `output/history-retention-profile-20261025-full-summary-direct-control/` 并更新本报告；生产源码、`public/`、测试、共享 benchmark、固定 54 文件 snapshot 与旧证据均未改。对照不启动 HTTP、不跑 1M、不改默认 memo/cache/budget，也不把 direct 当作生产修复。

| 固定输入 | SHA-256 |
| --- | --- |
| 上一卡 benchmark 基线 | `cb0f74e4291096e2345e2f756c05e30798f66d16c7fb3d79db155e9036b8f064` |
| 本卡 benchmark 副本 | `da8cf6d0b564e082cab55ab7405d567c46f9c00dfb2c373791b7310e48821010` |
| 相对基线的精确 diff | `46156f18f4436bdb76dc103699ae28136f6dd757c67bd6882b536266669327f7` |
| 固定 snapshot manifest | `3a21c1c7a3114b08a4272a929f9f791db65c11dadc180555e71b3aff08705219` |
| `src/usage-store.js` | `f501e615b93054bed272fc000466778f978444a57ebc0dc85ee9963168faef89` |
| `src/pricing.js` | `12d39362f05027807634a66df9e2b08ed3812cfaafb4d327082102fd4fac4e58` |
| `src/usage-rollups.js` | `66b7fe319703c10f64807f76aac7ddd642a6066a61d660923d14cb28d546cdf4` |
| `public/timeline-utils.js` | `ce55a5e5ff742b366aa09448052c36377be7bf2241d8be0fc31ff6c72f1d3c32` |

每个 run 使用同一临时正式 schema 新建 `UsageStore`，先执行一次 `SELECT SUM(total) FROM events` 暖 DB，再计时完整 `summarizeInReadTransaction({ preset: "all" }, { includeDetails: true })`。默认 run 保持 production memo；direct run 只在 `store.timelineRange()` 调用期间把 `eventCostMemo.estimate` 替换为 `estimateEventCost`，`finally` 恢复原函数并断言 identity。memo round、summary 聚合、SQL 扫描、行转换及其他消费者逻辑不变。

先以 `10000` 事件做门槛：仅把 `generatedAt` 与 `quota.asOf` 替换为固定占位后，两份完整 summary 深度相等，归一化 SHA-256 同为 `65cf755f0413ea9bc7d8e652c7af597864126627a92038f21860dace24375c42`；默认 timeline memo delta 为 `10000` misses，direct 为 `0`。门槛通过后才执行唯一一次 300k：

| 指标 | 默认 memo | timeline direct | direct - default |
| --- | ---: | ---: | ---: |
| 完整 summary | `6,586.8760ms` | `4,397.7388ms` | `-2,189.1372ms` |
| `timelineRange` | `4,424.1402ms` | `2,639.0234ms` | `-1,785.1168ms` |
| 完整 summary bytes | `62,375` | `62,375` | `0` |
| timeline memo delta | `0 hit / 300000 miss / 209334 evictions` | `0 hit / 0 miss / 0 evictions` | direct 全零 |

300k 两轮均为 `13` timeline rows；事件数 `300000`、session 数 `256`、home 数 `6` 和五项 token totals 全部等于独立 raw SQL oracle：total `758641693`、input `493432757`、cached `197006265`、output `265208936`、reasoning `52865447`。只归一化 `generatedAt` 和 runtime `quota.asOf` 后，完整 summary 深度相等，归一化 SHA-256 同为 `689aaf45647e095c1e6468b534bef32e264752dc494a11f65c79158cdaaff00d`。`verify.mjs` 重新检查 result/stdout 字节相等、小数据门槛、oracle、memo delta、函数恢复、stderr 和全部 54 个 snapshot 文件哈希；`verification.json` 为 `pass=true`。

主要证据：

- `full-summary-direct-control.json` 与 `run.stdout.json` 字节相同，SHA-256 `917dbe57c8cc8d13c15fcd7872cb172c91322e84266e7a45b9ac97ea10c4269d`；`run.stderr.log` SHA-256 `be706dabed47e7e7faccec4fed1b26b897984dd5e345274ac93a267d87b4b097`，只含 12 行 300k 插入进度。
- `normalized-summaries.json` SHA-256 `2e8b90747429bc75fcf8a314341fe67f3283bb7d78eef0659c46416df514a4ce`；小数据 result/stdout `36311ac983540372227c4c4aed275fa23b012a33bf410ad8b7192a6d0cbd22bd`。
- `verify.mjs` SHA-256 `c672d25424c654e05e36f70588efdda8c359a38b3f97aa09df4edcc7aaabcf28`；`verification.json` 与 `verification.stdout.json` 相同，SHA-256 `29846f129f2f09a416b5804608a246b0547bb94c841c1a5c61e9ab1bb2fd2a18`。
- 临时 `src/__full_summary_direct_control.mjs` 已删除；Biome 格式化后仅抑制上游既有 `noAssignInExpressions`，pass log SHA-256 `80edbca3c49fbe8ab1f704a444d5f69a13ee81067696ef346d67b29c1a342d2e`。

限制：只跑一次固定 seed 的合成 300k，且顺序固定为 default→direct；direct 可能额外受益于前一轮 JIT 与 OS page cache，因此毫秒差只能作诊断，不能把全部 `2,189.1372ms` / `1,785.1168ms` 都归因于 memo。较稳健的因果证据是完整输出相等且同一 timeline 调用的 memo delta 从 `300000` misses / `209334` evictions 降为全零。未覆盖反向顺序、重复轮次、p95、HTTP、executor guard、并发、冷盘、真实来源、1M 或整站；`#19` 仍未关闭。

## C-timeline-direct-production-patch：timeline 内 direct estimate

本卡只新增 `test/history-timeline-direct-cost.test.js`、`output/history-retention-profile-20261025-timeline-direct-production-patch/` 并更新本报告；生产 `src/usage-store.js` 未由本卡修改。原前像、隔离后像与原像唯一替换如下：

| 项 | 值 |
| --- | --- |
| 原前像 `a/src/usage-store.js` | `469879` bytes，`F59BBF1E5417694188ABE63838BBCBE8F2007EDE72CD40076089C4A1F6F16C27` |
| 隔离后像 `b/src/usage-store.js` | `469869` bytes，`D6A0BDAB87C3AD0DDF0C97E16BBAF1D398DCA255A6BCE5FC04D969ABA13E38FB` |
| patch `usage-store-timeline-direct.patch` | `536` bytes，`625E06461BBD8F4E134E071D496DB64BE32948ACEB1E835DF66F331F6EE04EA1` |
| `git apply --check` / apply 后哈希 | exit `0 / 0`，精确等于 `D6A0…`，`exact=true` |

唯一替换为：

```diff
-        estimateCost: (event) => this.eventCostMemo.estimate(event),
+        estimateCost: (event) => estimateEventCost(event),
```

该 anchor 在原前像和后像中各恰好出现一次。`timelineRange` 仍保留 `withEventCostMemoRound()`；这里只让 timeline 的逐事件 estimate 不读写 store memo，其他计价、bucket、aggregation 与 memo API 不变。

新增测试用一个 UTC 日、一个 `day` bucket 和五条真实 project-log 事件，覆盖 timeline 逐事件 direct estimate 等于 `estimateEventCost` oracle、accumulator 聚合等于 `estimateCostForEvents`、GLM-4.7 两个输出档、unknown model、missing detail、service/context/cache-write uncertainty、inconsistent detail fallback、`onEstimate` 每事件恰一次、timeline 不读写 memo，以及随后 `costEstimateRange()` 仍使用 memo 且结果等于 oracle。原 `f59b` 生产前像上的 RED 为 `0/1`，唯一失败是 memo delta 实际 `misses=5`、期望 `0`；所有成本与 uncertainty 断言均先通过。RED 使用测试 SHA-256 `E4B6DC999004F95EB5F2F5A46A85BB2A3C741F442E323C2D74692D0ACCFBA9BC`。

隔离副本只应用上述单行替换后，唯一新测试 `1/1`、测试耗时 `80.1427ms`、runner `203.5812ms`；与 `w4-event-cost-memo.test.js`、`timeline-utils.test.js` 合并为 `29/29`、runner `240.0636ms`。格式化后当前测试 SHA-256 为 `E4D2B5FB17896C0283AECA752A81B88FECA713F2DFB4EA0D49046154BEC25B99`；隔离 `src/usage-store.js` 与测试的 `node --check` 均通过，对新测试的 scoped Biome 格式化/检查 exit `0`。结构化哈希、RED/GREEN 与 apply-check 记录在 `output/history-retention-profile-20261025-timeline-direct-production-patch/evidence.json`。

本卡明确未跑 benchmark、CPU profile、HTTP、并发、冷盘或 1M，也未改生产 store。B 当前 live `src/usage-store.js` 在本卡证据收口时为 `472174` bytes、`28971F8C3B3F28791B4BB74FC6A215EBCE983C5D7652D389BC9F975BEF242507`，只记为并行修改后的当前文件，不能作为本 patch 前像；主审应在 B 归还后的新前像上按上述唯一 anchor 应用。

## 未覆盖与限制

- 未覆盖 C0 的通用多来源 fixture、同会话跨日与切模型的组合、配额、timing 和 retention；C3 只覆盖归档状态的轻量只读面板，不覆盖完整归档、备份或 retention 阶段。
- C0.1b 只证明 `Asia/Shanghai` 下这一时刻的 local/UTC 归属；未证明其他时区、DST 或完整 `summarizeUsage`/浏览器路径。
- C0.1 只证明计价函数逐事件与合并后的档位差异；未证明真实 ZCode 来源解析。
- C0.2 只证明单日、单来源的 SQLite 汇总；未证明 compact index、浏览器渲染或其他日历范围。
- C0.3 只证明本地 Git 仓库在同一来源下的窄日期/全区间过滤；未证明非 Git 多 cwd 合并、compact index 或浏览器路径。
- C0.3b 只证明两个 project-log home 的排除；未证明多来源混合、compact index 或浏览器路径。
- C0.4 只证明 `periodComparison` 的 detail 派生列；未证明未来 rollup 表、compact index 或浏览器渲染。
- C1a/C1b 只覆盖 UTC token 汇总、事件数和受影响日原子重建；未覆盖明细维度、费用、版本切换或主查询接线。
- C1b 未覆盖空 `days`、批次内非法日期的显式测试，也未覆盖真实 store 写事务嵌套。
- C1c 只覆盖连续两日的完整区间；未覆盖跨月/闰日、空日标记的独立断言、并发重建与主查询接线。
- C1-home 只覆盖两个 home、一个空日与排除全部；未覆盖空 `excludeHomes` 元素、重复 home、迁移旧表形状、并发重建或主查询接线。
- C1-stale 只对跨日 UPDATE 做了独立故障/回滚断言；同日 UPDATE、INSERT、DELETE 的 built marker 失效未分别测试，批量多行变化也未覆盖。C1-dirty-UTC 只单独证明这些事实变化会进入 dirty 队列，不替代 marker 失效断言。
- C1-read-snapshot 只覆盖 range 查询中的 built/rows 间隙；day 查询复用同一包装，但未单独做双连接穿插断言。
- SAVEPOINT 名固定；同一连接嵌套调用同名查询时依赖 SQLite 的 savepoint 栈语义，未覆盖并发嵌套或外部同名 savepoint。
- C1-local 只覆盖 `Asia/Shanghai` 的 23:30Z 与一天范围；DST 由 C1-DST 单独覆盖，跨月/闰日 local 枚举仍未覆盖。
- local 日标记依赖构建进程当时的 `TZ`；跨时区导入必须按目标当地重新构建，本卡未接导入流程。
- C1-zone-transfer 只覆盖上海→UTC 的 local 标记拒绝与重建；未覆盖 UTC→上海反向、DST 变更或其他时区。
- C1-DST 只覆盖 `America/New_York` 的 2026 两次切换；未覆盖其他时区、历史规则或更早/更晚的本地日枚举。
- C1-session 只覆盖 `utc` zone 的 session 去重与 home 过滤；未单独验证 local/DST 下跨日 session，也未接入 model/project 维度的会话数。
- C1-version 的通用拒读用例覆盖单日旧 marker、缺版本与未知版本 `999`；C1-format2-upgrade 已补实际 v2→v3 的完整五表/触发器、拒读、事实不变与幂等。仍未覆盖更早版本、多版本连续升级、并发升级或进程崩溃。旧缓存清理已由 C1-nested 纳入同一 SAVEPOINT，升级失败时旧版本与旧 marker 完整保留。
- C1-detail-count 只覆盖独立 rollup 接口的 day/range、home 排除与原 SQL 对拍；未把四个 known 计数与 gap count 接入费用、`periodComparison`、公开 summary 或浏览器。现有 store mapper 主动忽略这些字段，不能据此宣称 API 已暴露它们。
- C1-detail-input-output 只覆盖独立 rollup 的 day/range、home 排除与原 SQL 对拍；未把四个 token 字段接入费用、`periodComparison`、公开 summary 或浏览器。`inputKnownTokens + inputUnavailableTokens` 与 output 同理各等于 raw total，但本卡不把该恒等式扩展到其他维度。
- C1-detail-cached-reasoning 只覆盖独立 rollup 的 day/range、home 排除与原 SQL 对拍；未接主查询、费用、维度或浏览器。没有独立 v4→v5 夹具，v2→v5 只证明直接重建结果正确。
- C1-detail-combined 只覆盖独立 rollup 的 day/range、home 排除与原 SQL 对拍；未接主查询、费用、维度、公开 summary 或浏览器。没有独立 v5→v6 夹具，v2→v6 只证明直接重建结果正确。
- C1-detail-store-parity 只覆盖一个完整 UTC 日、两个 project-log home 与三条复用事件；未覆盖 local/DST、跨日、维度、费用、主查询接线或浏览器，也不替代独立 v5→v6 升级夹具。
- C2-model-day 只覆盖一个完整 UTC 日、两个 model、两个 home 和三条手写事件；未接 store、费用、仓库、partial window、session 关系、range、local/DST 或浏览器。`usage_rollup_models` 只在重建目标日集合非空时创建，不提前改变无事件 no-op sync 的表清单；也没有独立构造 v6→v7 升级夹具。
- C2-model-range 只覆盖两个完整 UTC 日、两个 model、三个 home、一次排除和一次缺失末日；未接 store、费用、仓库、partial/local window 或 session 关系，未覆盖 local/DST、跨月/闰日、并发写者或浏览器。该卡不升格式，仍不能替代独立 v6→v7 升级夹具。
- C2-model-range-store-parity 只覆盖两个真实 project-log home、两个 UTC 整日、两个 model、一次排除和一个 UTC 日界；未覆盖 local/DST、跨月/闰日、partial/local window、费用、session、仓库、主查询接线、浏览器或并发写者。该卡只跑精确 target 与 scoped Biome，未重跑 full history-parity，也不替代独立 v6→v7 升级夹具。
- C2-model-window 只覆盖 UTC 半开毫秒窗口、一个完整日与两侧 partial raw，以及一次同日内纯 partial 和一次缺日拒绝；未覆盖 local/DST、跨月/闰日、空窗口、更宽的多完整日窗口、store/费用/仓库/session 接线或浏览器。混合快照由 C2-window-snapshot 单独覆盖，但仍未覆盖并发多写者。当前 store/`periodAggregate` 使用闭区间，后续接入必须把闭端转换为半开端；本卡未验证该转换、调用方时间戳合法性或 `endInclusive + 1` 的溢出边界。
- C2-window-snapshot 只覆盖一个完整 UTC 日、左右各一 raw 边界、单次确定性的另一连接更新与一次 cache 重建；未覆盖多个并发写者、cache 重建失败/回滚、跨多完整日、local/DST、store/费用/仓库/session 接线或浏览器。测试固定注入 `usage_rollup_models` 聚合后的时点，不证明其他 SQL 编排下的等价性，也不以 marker/shape 结果替代两次完整输出断言。
- C2-million-model-probe 只测一组固定种子、固定分布、固定窗口和单个 `excludeHomes`；未做多参数矩阵、重复运行统计、并发、完整 store 表宽、真实来源解析、费用、session、仓库、local/DST、浏览器或整站压力。所谓冷读只是同进程重开数据库后的首次调用，构建与 OS page cache 未清空，不能当作 cold-authority 或生产 SLA。DB/WAL 字节是测量时点值，会受 SQLite checkpoint 与平台文件系统影响。
- C2-million-store-probe 使用真实 schema 21 与完整 events 列，但仍手工种入 6 个虚构 `source_files`，未执行现场发现、`sync()`、来源解析、B public 入口或真实 store 读入口；同一组固定分布、一个窗口分 worker/主审两次运行，不做并发/多配置矩阵/重复统计。窄 probe 与正式库 probe 的耗时差包含索引、行宽、WAL/`synchronous` 默认值差异，不能归因于单一变量。冷读仍是同进程重开 store 后首次调用，OS page cache 未清空，不是 cold-authority。DB/WAL 字节与 SQLite checkpoint、`journal_size_limit` 和文件系统有关。
- C2-million-process-probe 只测三个同时启动的独立子进程、一个固定窗口、一个 child 的 10 次温读与一次 WAL truncate；不做进程数矩阵、重复轮次、并发写者、真实来源发现、`sync()`、B public 入口、费用、session、仓库、local/DST、浏览器或整站压力。0 号 child 的温读循环可能与其他 child 的冷查询重叠，因此耗时包含共享主机资源竞争，不是隔离的单请求延迟。所谓 process-cold 只到进程与 store open 边界，OS page cache 未驱逐，不是 physical cold disk 或 cold-authority。10 个温读样本的 nearest-rank p50/p95 只描述本次运行；`maxRSS` 是 process 生命周期高水位，不是精确工作集或内存上限。零 checkpoint 页返回与 WAL 文件截断并存，字节数仍受 SQLite/平台行为影响。
- C2-million-dashboard-probe 只做一次本机 loopback 顺序请求，未做重复轮次、并发、浏览器、production port、正式来源发现、自动定价网络或整站吞吐，不能当作 production-wide latency/SLA 或 disk-cold 结果。默认生产 executor timeout 已实际拒绝该百万行首次 dashboard 请求；成功数据依赖 benchmark-only `120000→600000ms` timer override，因此不能声称默认生产配置可以完成这些请求。`skipCheck=1` 仍耗时约 `121.9s`，不是 pure cache read；`checkedAt` 未变化只证明跳过 normal check。`maxRSS` 包含 seed；DB/WAL 字节变化同时受 summary 写入、checkpoint 与平台文件系统影响，不能做单一因果归因。
- C2-million-after-cache 只做一次固定 seed 的百万行本机 loopback 顺序运行，未做重复轮次、统计区间、并发、浏览器、真实来源发现、自动定价网络或整站吞吐，不能当作 production SLA。两次成功只证明该次默认 timeout 配置下没有返回 `EXECUTOR_TIMEOUT`；timeout 按 executor 消息计时，整条 HTTP 还包含其他消息，因此不能反推单个耗时 141s 的消息可通过 120s guard，#19 仍未解决。`skipCheck` 仍耗时 `103.42s`，不是 pure cache read；相同 `checkedAt` 只证明跳过 normal check。`maxRSS` 包含 seed；DB/WAL/SHM 字节变化受 summary 写入、checkpoint 与平台文件系统共同影响。
- C2-dashboard-bottleneck 只跑一次 `100,000` 行本机 loopback summary，且该次同时包含首次 sync `1,812.74ms`，所以 `6,442.82ms` 不能直接当作 warm `skipCheck` 延迟；排除 sync 后的 `4,573ms` 也只描述本次样本。SQL `iterate` 计时包含消费者逐行映射，不是纯 SQLite profile；没有做 10k/100k/1m 缩放矩阵、重复运行、并发、浏览器、真实来源、费用/仓库接线或生产 timeout 行为验证。最小生产 memo 建议未实施，首次请求的 `120s` guard #19 仍未解决。
- C2-dashboard-attribution 只跑一次 `100,000` 行本机 loopback summary，且首次请求仍包含 sync `1,750.84ms`；`activeMs` 是逐次 `iterator.next()` 的累计墙钟时间，不是 SQLite 内核 profile，也不消除计时包装或 100,001 次调用的观测开销。inclusive/active 差额可说明消费者占比，但不能进一步拆成逐行转换、计价和分桶的单一因果。没有做重复轮次、并发、1m 扩展、浏览器、真实来源或生产 timeout 验证，也没有新增缓存或生产优化；#19 仍未解决。
- C-current-dashboard-profile 只跑一次固定 seed 的合成 `100,000` 行 loopback 诊断，首次请求仍包含 `sync`，单次墙钟含主机噪声；`54` 文件快照只固定本卡实际导入图，不覆盖整个仓库或运行环境。consumer trace 没有拆开 `estimateEventCost`、bucket 与 aggregation，因此只能提出 request-local resolved pricing plan 的待测接缝，不能宣称优化收益。没有重复轮次、并发、1m、浏览器、真实来源或其他 bucket/zone 验证，也未改生产代码，#19 仍未解决。
- C-current-million-dashboard 只跑一次固定 seed 的合成 1,000,000 行顺序 loopback；首请求包含必要 sync，单次墙钟含主机/JIT/page-cache 噪声，skipCheck 仍是完整 summary 而非纯 cache read。55 文件只读快照固定本卡实际导入图，但运行期间 live src/history-archive.js 与 src/usage-store.js 被并行任务继续改写；结果只绑定快照字节。RSS 是整个 benchmark 进程峰值且包含 seed，不是 server/executor 合计峰值；未做 20 新进程、全热/冷热两布局、p95、并发、真实来源、WAL 稳态矩阵或新 profile，也未改生产代码。单次 first 38.62s、skip 11.59s 均超过冻结单次门槛，但不足以单独归因回退或关闭 #19。
- C-timeline-consumer-split 只跑一次固定 seed 的 `100,000` 事件 direct consumer，reference `UsageStore.timelineRange` 还包含事件迭代/转换，而 instrumented `buildTimelineRows` 只消费已物化事件，因此 `905.0998 → 606.6424ms` 的差不能整体归因于分桶。pricing memo callback、其内部 `estimateEventCost`、独立 precomputed-cost 路径和 standalone replay 的计时互相嵌套或分属不同执行，不能严格相加。模型 missing/exact 分布仍是合成数据，不能代表真实用户；未做 p95、1m、并发、浏览器或生产改动，#19 仍未关闭。
- C-bounded-memo-eviction-probe 只用 100k 个唯一短 key、固定轻 value 与足够大的 byte budget，只观察 `maxEntries` 的 FIFO 逐出；不能代表真实事件 key/value、byte-budget 逐出、轮次收敛或整站调用栈。每组只有 3 次单进程墙钟，本地 persistent-iterator control 不含 production byte/stats 逻辑，不是可直接落地的修复；`74ms` 与 `~773ns/eviction` 只描述本合成负载，不能外推整站，也不能据此删除内存上限或 memo 语义。未做 1m、SQL、并发或生产改动，#19 仍未关闭。
- C-memo-isomorphic-iterator 仍只用 100k 个唯一短 key、固定轻 value 和每路径 3 次单进程墙钟，不能代替真实事件 key/value 分布、byte-pressure 矩阵、1m、并发、整站或生产 timeout 验证。控制文件是完整 module 副本，额外 import-path hunk 只用于从 output sibling 解析 snapshot 依赖；语义 hunk 只有 oldest iterator，但完整 diff 必须保留审阅。生产全 stats 相等只覆盖本卡三个核心断言与合成场景，后续生产 patch 仍需正式单测、重复统计和真实调用栈对拍；本卡不改生产，#19 仍未关闭。
- C-bounded-memo-iterator-write 只跑 `test/w4-event-cost-memo.test.js`、两个 `node --check` 与 scoped Biome，没有重跑全仓、重复 100k probe、百万、SQL、并发或真实调用栈。新增测试是行为/正确性回归，不负责重新证明性能；生产收益仍引用主审独立接受的同构 sibling probe。`clear()` 明确重置 iterator，但未覆盖并发调用同一 memo 实例；现有 API 仍按单线程同步使用设计。未改计价键、金额、store/core/public 或其他 pricing 语义，#19 仍未关闭。
- C-memo-million-isolated 只做一次固定 seed 的本机 1M loopback 顺序运行，不是 20 组统计门槛，也没有 p50/p95、并发、真实用户来源、磁盘冷缓存或整站吞吐。树内 `store` 固定为旧 snapshot `f501e615…`，只适合与同一代码树语境对拍，不能代表 B 当前 live store；pricing 是当前已接受字节，其他 53 文件仍是旧快照。first checked 仍包含正常价格检查与首次 store sync，skipCheck 只跳过 normal check；两者都包含 1M 全范围 summary 和响应序列化。`maxRSS` 包含百万行 seed，不是 server-only working set。临时 DB/server 已不在，无法后验磁盘冷读；未开第二个同任务进程，生产 `3765` 未接触。#19 仍未关闭。
- C-300k-post-memo-attribution 只跑一次固定 seed 的合成 `300000` 行 loopback，首次请求同时包含 `sync 6,197.4510ms`，所以 `14,152.9984ms` 不是 warm 延迟，也不能直接外推 1M。memo stats 记录 `300000` 次 miss 插入与 `212411` evictions，峰值越过 entry 与 64 MiB byte 门限，但 consumer 差额 `3,535.9749ms` 仍混有 memo key、`estimateEventCost`、分桶与 aggregation，不能把全部差值归给 memo。entry/byte 逐出拆分是按 `300000` miss 插入与未达 192 MiB hard limit 推导，不是额外计时；未做 p95、并发、真实来源、磁盘冷读或生产改动，#19 未关闭。
- C-sync-cpu-leaf 只跑一次固定 seed 的合成 `300000` 行 loopback，首次请求仍包含 rollup rebuild 与 `sync 6,138.1291ms`，所以 `12,879.1460ms` 不是 warm 延迟，也不能直接外推 1M。V8 profiler 只在首次 worker `UsageStore.sync` 外套 1 ms sampling，不影响结论方向但会增加观测开销；`4,037` 个 exclusive `run` samples 与 line ticks 都是诊断数据，三个 insert 行只合计 `4,036` ticks、另 1 tick 在 `deleteDay.run`，折算毫秒不是独立 timer，也不能拆 UTC/local 两次 rollup 或具体天数。未做 p95、并发、真实用户来源、磁盘冷读或生产改动，#19 仍未关闭。
- C-sync-rollup-bootstrap-cause 只跑一次固定 seed 的合成 `300000` 行、同一临时 DB 上的两次串行 `sync`，不覆盖 p50/p95、并发、冷盘、真实来源或其他 bootstrap 分支。结论严格绑定该 benchmark 的 UTC-only seed/cache 与当前 `f501e615…` store 门禁；`Asia/Shanghai` 的 local day 边界只代表本次运行环境。rollup audit 记录的是临时 trigger 观测到的 DML 数，不是 SQLite 内部耗时；未改生产，#19 仍未关闭。
- C-warm-summary-cpu-leaf 只接受一次固定 seed 的合成 `300000` 行、单请求、单 CPU profile；第一次尝试因 `quota.asOf` 与请求后未采样 oracle 的实时值不同而失败，第二次因 hook 漏导入 `statSync` 在 profile 写盘后被误标失败，二者均不等于接受运行。第一次 raw stderr/profile 在保留指令到达前被同名路径复用，无法原样恢复；可恢复的精确 `asOf` diff 已写入 `failed-attempt-1.json`，第二次 raw profile/stdout/stderr 已另名保留。V8 只采 leaf 样本，不能把 self/inclusive 比例拆成精确墙钟或 SQLite 内核时间；本运行首次请求仍含 profiler 启动前的 `sync`，不代表 warm 延迟。未做 1M、p95、并发、冷盘、真实来源或整站验证，也未实施 memo/计价优化，#19 仍未关闭。
- C-timeline-memo-direct-control 已由主审接受限定 consumer 因果（复跑 memo/direct median `2,669.6302 / 1,084.5986ms`、paired difference `1,585.0316ms`、`0 hits / 300000 misses / 209334 evictions`），但仍只用一组固定 seed 的合成 300k 事件、一个 `local/month` 全范围 consumer 输入和三对单进程墙钟；SQL、HTTP、store sync、并发、冷盘、真实来源、其他 bucket/zone、p95、1M 与整站均未覆盖。首轮执行含 JIT/预热噪声，memo 与 direct 的毫秒差不能外推为生产收益或损失；direct 是控制变量，不是修复，也没有改变默认 memo/cache/budget 或测试生产调用栈。#19 仍未关闭。
- C-timeline-direct-full-summary-control 只跑一次固定 seed 的合成 300k 完整 summary，且固定为 default→direct；direct 可能额外受益于前一轮 JIT 与 OS page cache，两轮 summary/timeline 毫秒差不是纯 memo 因果，也不是 p95 或 SLA。完整 summary 相等只覆盖 `preset=all`、`includeDetails=true`、当前 fixed snapshot 与一个时区；未覆盖反向顺序、重复轮次、其他 filters/bucket/zone、HTTP、executor guard、并发、冷盘、真实来源、1M 或整站，也未实施生产 cache/memo 改动。#19 仍未关闭。
- C-timeline-direct-production-patch 只在一个隔离副本上验证 `5` 条 project-log 事件、一个 UTC 日和 `day` bucket，只证明计价语义与 memo 隔离，不代表性能、生产 SLA 或真实来源分布；未做 HTTP、并发、冷盘、重复运行、p95、benchmark、CPU profile 或 1M。生产 store 未由本卡修改；timeline 仍保留 `withEventCostMemoRound()`，但不再写入 memo，因此后续消费者失去 timeline 产生的暖缓存，这是预期的语义变化。patch 必须由主审在 B 归还后的新前像按唯一 anchor 应用，不能套到当前 live 文件。
- C2-timeline-consumer 只跑一次固定 `100,000` 事件、一个 local/month 全范围与一个合成模型分布；事件已先从 production store 物化，因此排除了 SQL 和 `costEventsForRange` 转换。Standalone replay 的 `eventCostMemoKey`、`resolvePricingModel`、`timelineBucketKey` 不在原调用栈内，不能与 callback 计时直接相加；`eventCostMemo.estimate` 与 `estimateEventCost` 是嵌套关系。模型 missing 比例为合成数据 5/8，不能代表真实用户模型覆盖；未做重复轮次、1m、并发、其他 bucket/calendarZone、真实来源或生产改动，当卡未实施缓存建议。
- C2-minimum-rates-cache 只缓存 `minimumRatesFor` 的纯费率结果，键覆盖 modelKey/context/currency，并由 set/reset 全清；未暴露 hit/miss 计数。100k 前后各一次墙钟对照含运行噪声，exact model 分组本次上升不能归因于 cache；未跑百万行、并发、真实服务或其他 bucket/zone，也未缓存最终事件金额或逐事件峰谷结果。#19 仍未解决。
- C1-format2-upgrade 的 v2 DDL 按上一版当前形状手工构造；未从历史构建产物加载，也未覆盖更早 sessions 形状、批量跨日升级或升级期间的并发读者。三条断言只证明该夹具下的拒读、事实不变、正确计数和重复重建。当前 v2→v7 用例没有独立构造 v3/v4/v5/v6 中间态，不能声称已单独验证 v3→v4、v4→v5、v5→v6 或 v6→v7。
- C1-home-count 只覆盖 `utc` zone、两日两 home 与全排除；未覆盖 local/DST 跨日 home、并发重建或主查询接线。
- C1-nested 只验证外层事务回滚与一次格式升级失败；未覆盖并发写者、嵌套同名 SAVEPOINT、进程崩溃或 `createUsageRollups` 与重建同时交错。`usage_rollups_write` 在同一连接上重入仍依赖 SQLite 同名 SAVEPOINT 栈语义。
- C1-dirty-UTC 只覆盖 `utc` 日、单进程与最小 `events` 表；未接 store、sync、local 队列或调度。首次种入会扫描一次 `events`；跨日 UPDATE 的旧/新日、同日去重、DELETE 入队（已存在日）、INSERT 新日、`-1 ms`/`0 ms` 日界、失败保留与外层回滚已覆盖，但批量多行 DML、非有限/非法时间戳和并发写者未单独测试。`listDirtyUsageRollupDays` 的 `ROLLUP_CACHE_MISSING` 只用于格式不匹配，未改变 day/range 查询的既有缺日错误。
- C1-local-from-UTC 只证明当前进程时区下的保守日投影；未接 UTC 队列、sync、local 重建或 store。只覆盖上海与纽约 2026 DST 前后，不覆盖极端日期变更线跳日、历史规则、运行中改 `TZ`、空数组或非字符串数组。函数可能多返回相邻空日，调用方不能据此宣称这些日已有缓存。
- UI-missing 只覆盖 `renderPerfCoverageHtml` 的 ready、空数组与字段缺失三态。UI-missing-API 已补真实 Codex 夹具、`/api/summary`、持久 missing 状态与组件直接调用，但仍未验证浏览器 DOM、视觉布局、其他来源或其他性能页面；只覆盖单个 rollout 删除/恢复，不覆盖长时间后台刷新或多来源同时缺失。
- UI-full-missing-oracle 只比较同一 Codex 夹具、单个 rollout 的删除/恢复；未扩 freeze、浏览器、其他来源或全部 API。其反例已由主审修复 full missing 投影与历史统计后通过。
- UI-full-first 只覆盖 full 先行时的 missing 身份、恢复清空及 `groups/models/coverage`；未验证浏览器、用量 totals、raw report 历史完整性、freeze、其他来源或全部 API。
- UI-full-usage-oracle 只覆盖单个 project-log 文件删除/恢复后的 full totals 与一条公开事件载荷；未验证浏览器、其他来源、冻结、多事件顺序、分页或其他 API。其施工期恢复后去重断言因前置反例未执行；当前恢复去重由已接受的 UI-full-usage-scope 两来源用例覆盖。
- UI-full-usage-scope 只覆盖两个 project-log 来源的 full totals/events、单 home 排除与恢复；未覆盖持久 summary 的排除、浏览器、其他来源、冻结、多事件顺序或分页。
- UI-full-session-oracle 只覆盖两个 project-log session 与两个 home 的身份/计数保留；未验证 session 字段的完整业务含义、其他来源、浏览器、冻结或全部 API。施工期失败停在 session 集合；主审后续已完成生产接线并独立通过 `metadata.sessionCount`、`report.homes` 与恢复去重。
- UI-full-quota-oracle 只覆盖单个 Codex rollout 的单条 primary quota 观察；未覆盖 secondary 窗口、多观察顺序、配额窗口计算、浏览器、冻结或其他来源。主审 07:40 已独立通过删除/恢复对拍，早期 HTTP 500 与 `[]` 不再是当前阻断。
- C-regression-contract 只更新两个既有用例的版本号与 C3 精确表清单；未重跑该测试文件全量、未运行全仓测试或全仓 lint，也未验证其他测试中可能存在的旧 schema 文案。
- C3-archive-status-panel 只验证纯 renderer、成功/缺失/不可读状态、HTTP 失败与网络异常、错误文案和静态 i18n；请求 generation 已实现但未用双请求交错单测。未启动真实浏览器、未做 1920 视觉回归、未做冻结快照交互、axe/键盘实测或移动端检查。`present` 仅表示归档文件存在，不验证 SQLite 内容、哈希或事件可读性；面板不展开事件明细，也不改变存档、恢复或 retention 行为。
- C-browser-archive-freeze 只证明单段、单次冻结切换、一次 live archive 删除和一个真实 Edge 1920×1080 会话下的面板泄漏；未覆盖 `unreadable`、多段、恢复后重新出现、自动刷新间隔、并发请求、键盘/axe、移动端或其他浏览器。夹具按时限临时移走 segment 文件，但没有在 production DB、正式端口或真实用户目录上运行；主应用 live `/api/usage` 在归档文件缺失时返回 `500/ENOENT`，本卡只记录该错误路径，不把“面板状态一致”包装成整页通过或修复完成。
- C-archive-freeze-client-wire 已由主审接受，范围是单段、一次产品按钮冻结/解除冻结和真实 Edge 1920×1080 DOM 复验；该接受不表示 issue 18 已完整关闭。辅助 fixed harness 因 Windows sandbox 限制使用复制数据库/manifest，主审接受的原始夹具使用正常 host hard-link；仍未覆盖真实 archive staging 的并发写者、多段或 live usage 非快照刷新。`present` 仍只表示文件存在，不验证内容。
- C-archive-freeze-keyboard-language 只覆盖单段、单 snapshot、中文到英文一次语言切换和键盘 Space 折叠/展开；未覆盖 axe、移动端、其他浏览器、多段、自动刷新间隔、并发请求或本卡内的解除冻结。夹具是 workspace 临时 runtime，不触碰 production DB、正式端口或用户目录；初始 CLI 打开探针有一次 `/favicon.ico` 404，正式采证阶段无 console/page error。
- C-archive-sealed-days-ui 只做 mock 单测，不启动 landed API、真实 DOM 事件监听或浏览器；未做 1920 视觉、键盘展开、并发多段、snapshot 过期/错误码、overlay 与 sealed 版本混合或移动端检查。日统计被明确展示为原始封存版本，不含当前覆盖层；本卡不证明两者可组合。server、store、executor 和 production 数据冻结。
- C-sealed-days-browser 已由主审接受：worker 环境被 origin/approval gate 阻塞，主审在正常 host 原 fixture 与真实 Edge 完成 days/Space 焦点/语言/freeze/实际移走 live/unfreeze；首轮只有预期 live-missing usage 500，精确 URL 复验 `17` 项行为断言加 `pass=true` 共 `18/18` 全真，5 张 1920×1080 截图已目视验收。server/store/executor/app/CSS 未改。
- 本卡 scoped Biome 检查已通过 `src/pricing.js` 与 `test/pricing.test.js`；未运行全仓测试、全仓 Biome、浏览器或压力测试。

## C2-million-after-cache 交接

已完成待主审复核：只改 `docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs`、新增 `benchmark-model-dashboard-after-cache.json` 并更新本报告；`src/`、`test/` 与既有 `--dashboard` JSON/语义均未改。`--dashboard-after-cache` 使用同一固定 seed 的 `1,000,000` 行正式 schema 21 与 v7 rollup，默认 `120,000ms` executor timeout 不覆盖；首次 checked 为 `141,217.44ms`，随后 `skipCheck` 为 `103,419.98ms`，两次 HTTP 200、`83,110` bytes，全部计数与五项 token 等于独立 SQL oracle，且均保留 6 个缺失来源。与旧 600s override 单次参考相比分别少 `50,305.62 / 18,477.33ms`，只能作单次参考。未观察到 `EXECUTOR_TIMEOUT`；timer 按 executor 消息计时，首次 HTTP 还包含独立 `sync`，所以不能把整条 `141.22s` 当作单一消息通过 120s guard，也不能据此关闭 #19。

## C2-minimum-rates-cache 交接

已完成待主审复核：只改 `src/pricing.js` 与 `test/pricing.test.js`，未改 benchmark 脚本、store、rollup、UI 或 server。`minimumRatesFor()` 的纯结果现按 `modelKey + contextLevel + currency` 缓存，`setPricingCatalog()` / `resetPricingCatalog()` 清空；不缓存最终事件金额，也不改变 GLM 逐事件分档。施工前像在 `baseline/C2-minimum-rates-cache/manifest.json`。

完整 `test/pricing.test.js` 34/34 通过，核心三 target 3/3 通过；同轮 W4 memo 8/8、pricing-models 6/6、Claude pricing host 11/11，scoped Biome 通过。新增独立 oracle、同 `checkedAt` A/B 内容差异、A→B→A 恢复、reset 回默认目录和既有 GLM 分档断言。既有 `--timeline-consumer` 跑同 seed `100,000` events / `13` rows：`buildTimelineRows` 从 `2,052.70ms` 降至 `1,111.83ms`，`estimateEventCost` 从 `1,310.33ms` 降至 `302.67ms`，missing 从 `1,226.56ms` 降至 `198.56ms`；两条完整输出仍与 production `timelineRange` `deepStrictEqual`。默认 timeline JSON 已恢复主审前像，本卡对照写入 `benchmark-model-minimum-rates-cache.json`。

未测 cache hit/miss 计数、重复轮次、并发、1m 或真实服务；exact model 本次 `83.77→104.11ms` 保留为单次运行噪声。最小 cache 不解决整事件 memo 首次全 miss，#19 仍未解决。

## C2-timeline-consumer 交接

已完成待主审复核：`--timeline-consumer` 退出 0，`100,000` events / `13` rows，instrumented 与 buffered-estimate 两条完整输出均 `deepStrictEqual` 于 production `UsageStore.timelineRange`。本次 `buildTimelineRows=2,052.70ms`，pricing memo callback `1,733.18ms`，其中 `estimateEventCost=1,310.33ms`；非计价缓冲路径仅 `214.43ms`，日历桶 replay `20.79ms`，价格匹配 replay `76.64ms`。5 个 missing model 消耗 `1,226.56ms`，3 个 exact model 仅 `83.77ms`。最小建议只是缓存 unresolved model 的 rate-plan/`minimumRatesFor` 中间结果（按 catalog + currency + context tier），本卡未实现；后继 `C2-minimum-rates-cache` 已实现该范围的 cache。不缓存最终金额，不改语义，#19 仍未解决。

## C2-dashboard-attribution 交接

本轮实际改动只有 `docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs`、新增的 `benchmark-model-dashboard-attribution.json` 与本报告；未改 `src/`、`public/`、`test/` 或旧 JSON，也未重跑旧的 45 tests。新命令 `--dashboard-attribution` 返回 HTTP 200 且计数/token 对拍通过；top cost event scan 为 `100,000` rows / `100,001` next calls，`activeMs=417.01`、`inclusiveMs=3,418.37`、消费者差额 `3,001.36ms`，`timelineRange inclusive=3,469.80ms`。`all()` rows 已按实际数组长度记录。这里的三数只用于诊断，不能把 active 当纯 SQLite，也不能把 inclusive 当 active；生产未改、无缓存优化，`120s` guard #19 仍未解决。

## C-current-dashboard-profile 交接

主审已独立接受：只新增 `output/history-retention-profile-20261024/` 证据并更新本报告；共享 `src/`、`public/`、benchmark、测试与 1m 行为均未改。首次未冻结诊断 `3,181.3046ms` 因 `src/usage-store.js` 随后漂移而降级为诊断材料；随后从 `54` 文件只读快照运行一次 `100,000` 行 `--dashboard-attribution`，HTTP `200`、`81,564` bytes、`3,550.0667ms`、未覆盖 timeout，全部计数与五项 token 等于独立 SQL oracle。运行后 `54` 个快照哈希全部未变，共享 baseline JSON 恢复为 `b9747c13638ae76ff6723ed61ab9408f644d80aa3675760efcf29bfa5ee85051`。top hotspots 为首次 `sync 1,385.91ms`、cost event scan inclusive `1,141.42ms`（iterator active `234.94ms`、consumer `905.23ms`）与 `groupedRange 381.66ms`。最小待测接缝是 `buildTimelineRows` 的逐事件 resolved pricing plan；`minimumRatesFor` 已修复，不再重复。单次运行、首次 sync、计时噪声与未拆分的 consumer 仍限制结论，#19 未关闭。主审已独立复跑 54 文件 copy/source 前后哈希、原始结果 digest、`100000/256/6` 与 raw oracle 完整 totals、cost trace rows/nextCalls/consumer 差值及共享旧结果恢复 hash；接受的是固定副本 100k 单次诊断，不是 #19 门槛。

## C-current-million-dashboard 交接

已完成待主审复核：只新增 `output/history-retention-profile-20261025-current-million/` 并更新本报告；生产、测试、共享 benchmark/结果和运行中服务均未改。当前 55 文件只读快照只运行一次 `--dashboard-after-cache`：first checked HTTP `200` / `83,110` bytes / `38,617.3085ms`，skipCheck HTTP `200` / `83,110` bytes / `11,589.2531ms`，默认 `120,000ms` 未覆盖。两次的 `1,000,000 / 256 / 6`、metadata 1M 与五项 token 均等于独立 SQL oracle，均保留 6 missing sources。运行后 55/55 快照 hash 未变且仍只读；共享 after-cache/reference JSON 未动。并行任务在运行期间继续改写 live `src/history-archive.js` 与 `src/usage-store.js`，结果只绑定快照 hash。按冻结单次门槛，first `38.62s > 15s`、skip `11.59s > 5s`，仍明显远离目标；这只是一个合成单组，不是 20 进程 p95/SLA，#19 未关闭。

## C-timeline-consumer-split 交接

已完成待主审复核：只在本卡 `output/history-retention-profile-20261024/` 转存既有 `--timeline-consumer` 的一次输出、stdout/stderr 与结构化证据，并更新本报告；54 文件快照源、共享 source 和既有结果均未改。同 seed `100,000` events / `256` sessions / `6` homes / `8` models / `13` rows；reference `905.0998ms`、instrumented `606.6424ms`、precomputed-cost bucketing `116.7749ms`，三份完整输出全部 `deepStrictEqual`。pricing memo callback `424.9899ms`，其中 estimate compute `153.9394ms`、callback/key/lookup 差额 `271.0505ms`；不能把这 424.99ms 整体归为已修复的 unknown fallback。missing/exact 为 5/3 models、62,544/37,456 events，estimate 分别为 `104.9980 / 48.9414ms`。reference 还包含物化/SQL 转换，和 direct instrumented 口径不同；未做 p95、1m、并发、浏览器或生产改动，#19 未关闭。

## C-bounded-memo-eviction-probe 交接

已完成待主审复核：只新增 `output/history-retention-profile-20261024/memo-eviction-probe.mjs`、`memo-eviction-probe.json` 并更新本报告；`src/`、`public/`、既有 benchmark、测试及 54 文件只读 snapshot 均未改。探针直接导入 snapshot 的 `createBoundedKeyMemo`，以 100,000 个唯一短 key、固定轻 value 和足够大的 byte budget，分别跑 3 次强制 `maxEntries=4096` 逐出、3 次 `maxEntries=100000` 无逐出，以及 3 次本地 persistent-iterator control。强制逐出中位数 `81.1973ms`，无逐出 `7.4186ms`，配对差中位数 `74.2345ms`；按 `95,904` 次逐出约为 `774.05ns/eviction`，production 减 control 约为 `773.48ns/eviction`。满队列第 1–23 个 batch 的早期/晚期中位数为 `3.3689 / 3.3569ms`，斜率 `+0.0016147ms/batch`，支持每次逐出新建 key iterator 的常数级开销，不支持开销随队列压力增长；这不是生产修复。九次运行均断言 `100000` 返回值/compute、零 hits、`100000` misses 和精确 FIFO；`4096` 组每次为 `95904` evictions、`4096` entries、peak `4097`、`32768` retained bytes。脚本 SHA-256 为 `c3b2ad665a83c8f8e8ff58d79f8e482f7ed40057f54e13da6bad0334c0d33b2e`，结果 SHA-256 为 `1bf040f90a5387ada240827b3446a2352080329814ff5f18d412e755ab5bf76e`。限制为短 key、固定轻 value、ample byte budget、每组 3 次单进程墙钟与不含 production byte/stats 逻辑的本地 control；未做 1m、SQL、并发或整站验证，不能据此删除内存上限或 memo 语义，#19 仍未关闭。

## C-memo-isomorphic-iterator 交接

已完成待主审复核：只新增完整同构的 pricing 控制 module、probe 与 JSON，并更新本报告；54 文件只读 snapshot 与全部生产源码未改。精确 diff 存在 JSON `sources.exactDiff`（SHA-256 `d2cfc46e8fcbfb242fe93c124d116b76bcc2839e51da39166ded094a80956797`）：一个 import-path 可解析性 hunk，加一个 oldest-iterator 复用 hunk；byte 统计、两逐出循环、round、clear、返回值与其余 production 逻辑保持同构。三组 100k 轻 key 各 3 次交错：production `4096` 中位 `82.8841ms`，同构控制 `4096` 中位 `14.2477ms`，production 无逐出中位 `12.9310ms`；配对中位减少 `68.1171ms`（`82.18%`），控制只比无逐出高 `1.3167ms`。三条核心断言通过生产全 `stats()`/FIFO/bytes 相等、round+byte 与 clear 后续用相等、iterator 耗尽后再插入相等。结论：值得为旧 FIFO iterator 复用做一个聚焦生产修复，但本卡不改生产；短 key/3 次/无 1m/并发/整站限制仍在，#19 未关闭。

## C-bounded-memo-iterator-write 交接

已完成待主审复核：只改 `src/pricing.js` 的 `createBoundedKeyMemo`、`test/w4-event-cost-memo.test.js` 与 C-report；其他 pricing、store、core、public 与 54 文件快照未改。施工前生产 `src/pricing.js` 与只读快照同为 `ddaf043e…`，前像继续保存在 `output/history-retention-profile-20261024/source-snapshot/src/pricing.js`。生产 diff 只迁入已接受的共享 FIFO oldest iterator、两处逐出调用与 `clear()` 明确重置；精确 diff SHA-256 为 `8e92c9b03d441e96dace0ee6d584e00cf4e304434d909231dba3b8baf39ceab1`。新增单测覆盖 byte 逐出到空、clear 后复用与 entry/byte 两个循环；`bothLoops` 用 `value===2 ? 1 : 0` 使第 3 条为 3 B，最终 retainedBytes 3、evictions 2。定向用例 `1/1`（`66.8865ms`）、完整 memo `9/9`（`139.3079ms`）、`node --check` 与 scoped Biome 均通过。未重跑性能/百万/SQL/并发/全仓，#19 未关闭。

## C-memo-million-isolated 交接

已完成待主审复核：只新增 `output/history-retention-profile-20261025-memo/` 固定副本、结果、日志、manifest 与 process-state，并更新本报告；`src/`、旧 54 文件 snapshot、共享 benchmark/JSON 与 production `3765` 均未改。新树逐文件对拍后 54 文件中只有 `src/pricing.js` 从 `ddaf043e…` 换成本卡已接受的 `12d39362…`；store 固定为旧 snapshot `f501e615…`，明确不是 B 当前 live。复制既有 `benchmark-model-dashboard.json`（`fbf32eb0…`）作只读 reference，原脚本 `e28db4db…` 单次 `--dashboard-after-cache` 运行：exec session `91166`，10s 返回 running，轮询见 425k→1M 插入和两请求，最终 exit 0。first/skipCheck 均 HTTP 200、83,110 bytes，times `48,316.0080 / 21,956.6286ms`；1M/256/6、1000000 metadata events 与五项 token 全部等于 SQL oracle，6 个 missing sources、120s timeout 未 override。`maxRSS=1,022,828,544 bytes` 含 seed；server close `11.1517ms`，temp dirs 0，未开第二进程。结果 SHA-256 `b855c7f7…`、stderr `930b8f7f…`、process-state `f23be5a8…`。单次不是 20 组门槛；旧 store 与旧 reference 限制结论，#19 未关闭。

## C-300k-post-memo-attribution 交接

主审已接受：只新增 `output/history-retention-profile-20261025-300k-memo-attribution/` 与 C-report；`src/`、`public/`、共享 benchmark 和两套既有 snapshot 未改。原 benchmark `e28db4db…` 的独立副本 `8ad3cf1a…` 只改 300k 计数、固定快照导入和 memo stats 采样，精确 diff `27ef9c8c…` 已落盘。exec session `87719` 只跑一次 `--dashboard-attribution`，exit `0`；唯一 HTTP `200`、82,113 bytes、`14,152.9984ms`，300k/256/6、metadata 300k 与五项 token 全等于 SQL oracle，timeout 未 override，6 missing sources 保留。trace：`sync 6,197.4510ms`、summary `6,307.5868ms`、`timelineRange 4,526.4940ms`、cost scan SQL active/inclusive `968.0764 / 4,504.0513ms`、consumer `3,535.9749ms`、`groupedRange 1,459.4534ms`。memo `300000` 次 miss 插入 / `212411` evictions，peak `262145 entries / 200821687 bytes`，round 后 `87589 / 67108541`；推导 entry-limit `37856`、round-end byte `174555`。结果/stdout `99289a9a…`、stderr `72ce25e4…`、evidence `2f855282…`、process-state `080784da…`。单次合成运行不解释完整 1M 残差，consumer 非纯 memo timer；#19 未关闭。

## C-sync-cpu-leaf 交接

主审已接受：只新增 `output/history-retention-profile-20261025-sync-cpu-leaf/` 与 C-report；`src/`、`public/`、测试、共享 benchmark、固定 snapshot 和旧证据均未改。上一卡 benchmark `8ad3cf1a…` 的独立副本 `991a5ee8…` 只新增 `--sync-cpu-leaf` 与首次 worker `UsageStore.sync` 的 1 ms V8 profiler，精确 diff `107c34c3…` 已落盘。exec session `93507` 只跑一次，exit `0`；唯一 HTTP `200`、82,113 bytes、`12,879.1460ms`，300k/256/6、metadata 300k 与五项 token 全等于 SQL oracle，timeout 未 override，6 missing sources 保留。profile `status=written`、1 次调用，`4,143` samples / `38` nodes；`sync=6,138.1291ms`，exclusive native `run=4,037 samples / 5,984.812ms`，parent 为 rollup rebuild 的 `usage-rollups.js:345`。line ticks 分别落在 `insertSessions` `1483`、`insertDay` `1294`、`insertModels` `1259`，合计 `4,036`；剩余 1 tick 在 `deleteDay.run`，折算时间只作比例诊断。结果/stdout `682f2cfa…`、stderr `dec1b5f3…`、raw profile `11a32be0…`、profile summary `dcdfd59d…`、attribution `615758a1…`、evidence `239eb382…`、主审复核 `381a09bc…`。主审已核对 raw samples、timeDeltas、leaf 权重、祖先栈与 oracle；PositionTicks 仍只是比例估计，且工具时钟从 `20:23` 跳到 `22:41`，不声称连续执行。单次合成运行、首次 sync、采样噪声与未拆分的 UTC/local/day 维度限制结论；#19 未关闭。

## C-sync-rollup-bootstrap-cause 交接

主审已接受：只新增 `output/history-retention-profile-20261025-sync-bootstrap-cause/` 与 C-report；生产源码、测试、共享 benchmark、固定 snapshot 和旧证据均未改。probe 固定复用 300k seed，先执行 `createUsageRollups()` 与 UTC-only `rebuildUsageRollups()`，再在同一临时 DB 新建 store 串行执行两次 `sync()`。首次 sync 前 local-zone meta 为 `null`、dirty 为 `[]`、UTC/local markers 为 `365/0`、UTC/local rollup events 为 `300000/0`；第一次 sync 为 `6,499.3201ms`，写入 `Asia/Shanghai` 并补建 local rows，rollup audit changes 为 `252570`（days `366`、daily `2196`、models `17568`、sessions `232440`）；第二次 sync 为 `3.5136ms` 且 rollup changes 为 `0`。raw facts 在前后、UTC/local rollup facts 在两次 sync 后均精确等于 `300000/256/6` 与五项 token oracle，`checks.bootstrapCause / steadyNoRollupWrites / factsAndOracleEqual` 全为 `true`。主审已独立复跑同一三项断言；初始化 warm 工作不能被移出正式首次请求来“通过”阈值。probe/result/stdout/stderr SHA-256 分别为 `876cb8e1… / 0fbba23e… / c91877e3… / be706dab…`。单次合成 300k、一个时区、无 p95/并发/冷盘/1M、无生产改动；#19 未关闭。

## C-warm-summary-cpu-leaf 交接

已完成待主审复核：只新增 `output/history-retention-profile-20261025-warm-summary-cpu-leaf/` 与 C-report，生产源码、测试、共享 benchmark、固定 snapshot 和旧证据均未改。benchmark 副本固定上游 `8ad3cf1a…`，只在 `sync` 完成后对 worker 首次 `summarizeInReadTransaction({ preset: "all" }, { includeDetails: true })` 外套 1 ms `node:inspector` sampling；`sync` 记录在 method trace 中但不在 profile 窗口内。固定输入 manifest/store/rollups/pricing 分别为 `3a21c1c7… / f501e615… / 66b7fe31… / 12d39362…`，运行后未变。

接受尝试为 HTTP `200`、`82,113` bytes、headers/total `17,835.1926 / 17,837.4217ms`；300,000 events / 256 sessions / 6 homes 与五项 token 全等于 SQL oracle，timeout 未 override。`sync 8,564.2559ms`、`summarizeInReadTransaction 7,324.9986ms`、`timelineRange 5,279.5150ms`、cost scan active/inclusive `1,101.3161 / 5,243.1220ms`、consumer `4,141.8059ms`；memo 为 `300000` misses、`212411` evictions、peak `262145 entries / 200,821,687 bytes`。完整 summary 与同一临时 DB 的未采样 `includeDetails=true` summary 深度相等于 `5d2c3bc7…`；唯一归一字段是请求后实时变化的 `quota.asOf`，区间、usage、配额窗口及其他字段未剔除。

raw profile 为 `4,925` samples / `7,356.330ms`，reported profile duration `7,356.669ms`，覆盖目标调用 `1.0043x`；目标 `summarizeInReadTransaction` 有 `4,806` samples / `97.22%`。应用 self `3,876.457ms / 52.70%`、GC `164.569ms / 2.24%`、其他 `3,315.304ms / 45.07%`。祖先 inclusive 主要为 `summarizeHistory 97.65%`、`summarizeInReadTransaction 97.22%`、`withEventCostMemoRound/timelineRange 69.56%`。应用 self top5 为 `memo.get 5.78%`、`valueByteEstimate 5.27%`、`buildTimelineRows 5.26%`、`estimateEventCost 4.39%`、`eventCostMemoKey 4.33%`；memo `get/key/valueBytes/estimate` self leaves 合计 `19.77%`，高于单纯计价函数。

唯一最小待测接缝是 `pricing.js:1705` 的 `createBoundedKeyMemo.get -> valueByteEstimate(value)`：每次 miss 后为取得 UTF-16 长度而对整个 estimate 执行 `JSON.stringify`，该 leaf 单独占 `5.27%`。下一实验只应替换该 byte-length 计算，保持现有 byte budget、memo、key 与计价语义，不删除 memo、不跳过计价；本卡不提供生产 patch。前两次尝试分别因 volatile `quota.asOf` 和 hook 漏导入 `statSync` 失败：第一次 raw stderr/profile 在保留指令到达前被同名复用而不能原样恢复，精确 `asOf` diff 保留在 `failed-attempt-1.json`；第二次 raw profile/stdout/stderr 已另名保留。接受结果/stdout `a755b8b7…`、raw profile `0e882834…`、profile summary `b4b5ef82…`、derived `0bf127c9…`、benchmark copy `0dee2fb7…`、diff `cb6da8e0…`、evidence `ffc0eb34…`、verification `b273f81a…`。单次合成 300k、单次采样和主机噪声限制结论；未做 1M、p95、并发、冷盘、真实来源或整站验证，#19 未关闭。

## C-timeline-memo-direct-control 交接

主审已接受限定 consumer 因果：只新增 `output/history-retention-profile-20261025-timeline-memo-direct-control/` 并更新本报告；生产源码、`public/`、测试、共享 benchmark、固定 snapshot 与旧证据未改。上游 300k benchmark `8ad3cf1a…` 的独立副本 `cb0f74e4…` 只新增 `--timeline-memo-direct-control`、main 模式接线、300k dispatch 与三对 consumer 控制；精确 diff `68766048…`。同一批 300k 物化事件固定为 `local/month`、`13` 行；memo 每轮新建默认预算实例并使用 `beginRound()/endRound()`，direct 不保存 `costEstimate`。六份完整输出全部深度相等，三次 memo stats 均为 `0 hits / 300000 misses / 209334 evictions`、peak `262145 entries / 194005917 bytes`。施工 memo/direct 中位 `2,669.6917 / 1,078.6135ms`、配对绝对差中位 `1,318.9069ms`；主审复跑为 `2,669.6302 / 1,084.5986ms`、paired difference `1,585.0316ms`，stats 相同。结果/stdout `cecf3b82…`、stderr `be706dab…`、verification `ed1e7d56…`、verify `9ae9c90e…`、Biome raw/pass logs `62a6b835… / 790216b2…`。接受范围不包含 HTTP、1M、p95、并发、冷盘、真实来源、整站或生产 patch；#19 未关闭。

## C-timeline-direct-full-summary-control 交接

已完成待主审复核：只新增 `output/history-retention-profile-20261025-full-summary-direct-control/` 并更新本报告；生产源码、`public/`、测试、共享 benchmark、固定 54 文件 snapshot 与旧证据未改。上一卡 `cb0f74e4…` 的独立副本 `da8cf6d0…` 只新增 `--full-summary-direct-control`、10k env 门槛与完整 summary 两个 run；精确 diff `46156f18…`。固定 300k seed 上，默认 memo 完整 summary 为 `6,586.8760ms`，仅在 `timelineRange` 内 direct estimate 为 `4,397.7388ms`；timeline 为 `4,424.1402 / 2,639.0234ms`，summary 均 `62,375` bytes、`13` rows。仅 normalize `generatedAt` / `quota.asOf` 后完整 summary 深等，SHA-256 `689aaf45…`，300000/256/6 与五项 token 等于 SQL oracle。默认 timeline memo delta 为 `0 hit / 300000 miss / 209334 evictions`，direct 全零且 estimate 在 `finally` 恢复。结果/stdout `917dbe57…`、stderr `be706dab…`、normalized `2e8b9074…`、verify `c672d254…`、verification/stdout `29846f12…`。固定顺序 default→direct 仍有 JIT/page-cache 偏差，毫秒差只作诊断；未做反向顺序、p95、HTTP、并发、冷盘、真实来源、1M、整站或生产 patch，#19 未关闭。

## C-timeline-direct-production-patch 交接

已完成待主审复核：只新增 `test/history-timeline-direct-cost.test.js`、`output/history-retention-profile-20261025-timeline-direct-production-patch/` 并更新本报告；生产 `src/usage-store.js` 未由本卡修改。原前像 `F59BBF1E…`、隔离后像 `D6A0BDAB…`，patch `625E06461BBD8F4E134E071D496DB64BE32948ACEB1E835DF66F331F6EE04EA1` 在 `git apply --check` 与原前像上均 exit `0`，apply 后精确等于后像。原前像 RED 为 `0/1`，唯一失败是 memo `misses=5`；隔离 GREEN 为 `1/1`（`80.1427ms`，runner `203.5812ms`），相邻 `w4-event-cost-memo` 与 `timeline-utils` 合计 `29/29`（`240.0636ms`）。本卡未跑 benchmark、CPU profile、HTTP 或 1M。当前 B live store 已漂移到 `28971f8c…`，仅作为并行改动记录；主审需在 B 归还后的新前像按唯一 anchor 应用，不可直接套用当前文件。

## C2-dashboard-bottleneck 交接

已完成待主审复核：同 seed `100,000` 行、一次真实 `skipCheck=1` summary 返回 `200`，计数和五项 token 均等于独立 SQL oracle；总耗时 `6,442.82ms`，其中首次 sync `1,812.74ms`、`summarizeInReadTransaction` `3,916.44ms`。最慢实际路径是 `timelineRange → costEventsForRange` 的 `100,000` 行 iteration，`3,130.57ms`；次级为 `groupedRange` 四调用 `588.72ms` 和 `metadata` 两调用 `364.92ms`。生产 file 未改，benchmark hook 只在 worker 临时加载并在结束后删除。最小建议仅是复用现有 memo 键缓存相同 range 的 timeline/cost accumulator，未实施；它不解决首次请求的 120s guard #19，override 成功仍不计性能达标。

## C3-archive-status-panel 交接

已完成待主审复核：新增独立 `public/history-archives-ui.js` 和三个核心 Node 用例，只接既有 `/api/history/archives`。面板在 boot 与每次成功 usage refresh 后刷新，语言切换重渲染缓存状态；原生 `<details>` 提供折叠。`present` 文案固定为“仅表示文件存在，未验证内容”，缺失/不可读状态保留范围并显示事件数不可用，请求失败不显示零计数。与 i18n 合并运行 `16/16`（`170.9485ms`），`app-render` `59/59`（`233.9734ms`），scoped Biome 与四个 `node --check` 通过。

未做真实 1920 浏览器、视觉/冻结交互、axe、键盘实测或移动端检查；这些留给下一卡。未验证归档内 SQLite 内容、哈希或事件可读性，也未改 server/store/styles。

## C-browser-archive-freeze 交接

已完成待主审处理，结论为 **RED，不是通过项**。只新增 `output/playwright/history-archive-freeze-*` 隔离夹具/采证/证据并更新本报告，未改 `src/`、`public/`、既有测试或服务。真实 Microsoft Edge `155.0.4283.62` 在 `1920×1080` 下取得 snapshot `36d81046-508e-4eca-a429-e181ccebd684`；冻结后的 `/api/usage` 仍使用该 snapshot 并返回 200，但 live archive 被移除后，面板照样从 `/api/history/archives` 刷成 `missing`。最终 `panelStayedFrozen=false`、`pass=false`。解除冻结后 live usage 返回 `500/ENOENT`，面板仍一致显示 `missing`，错误详情可见；这证明 live 错误路径，不抵消冻结泄漏红例。

证据 JSON、四张截图 hash、完整 API/DOM/request 时间线均在 `output/playwright/history-archive-freeze-evidence.json`。后续单一 freeze 接线卡应让归档状态与 `/api/usage` 共用 snapshot 语义；本卡停止在反例与交接，不提供生产 patch。

## C-archive-freeze-client-wire 交接

主审已独立接受：生产接线只改 `public/history-archives-ui.js`、`public/app.js` 与 `test/history-archives-ui.test.js`，并更新 fixed harness 与本报告；未改 server、store、index、i18n、CSS 或既有 RED 证据。`77/77` 聚焦测试通过，scoped Biome 通过；主审原始夹具使用正常 host hard-link snapshot，删除 live segment 后 frozen usage 仍为 `200`、snapshot archive 为 `200 present`，解除冻结才切到 live archive `missing`。接受范围仅为单段 freeze 接线；issue 18 仍未完整关闭。

## C-archive-freeze-keyboard-language 交接

主审已接受限定行为：只新增 `output/playwright/history-archive-freeze-keyboard-*` 脚本、两张截图与 JSON，并更新本报告；`public/`、server、store、既有测试和旧证据未改。本卡真实 Microsoft Edge `155.0.4283.62` 在 `1920×1080` 下通过产品按钮取得 snapshot `9cfa1ad9-65c2-478f-99de-a5b17f74e943`；冻结阶段唯一归档请求带该 snapshot，无 live 归档请求。`summary` 使用 Space 从展开到折叠再恢复，焦点保持 `SUMMARY`；切到英文后面板仍展开，同一段范围和 `present` 状态正确重渲染。证据 `12/12` 断言通过，最终 GREEN。主审独立复跑为 `1125ms`、snapshot `f2dc77bc-409b-4086-ac7e-a77d33b91c83`、`13/13` 断言通过并目视英文截图。未做 axe、移动端、其他浏览器、多段或本卡内解除冻结。

## C-archive-sealed-days-ui 交接

已完成待主审复核：只改归档 UI、i18n、聚焦测试与本报告。`present` 段展开后按需请求 `/api/history/archives/<encoded segment>/days`，frozen 视图附带 `snapshot`；严格校验 sealed UTC payload，按段保留 open/loading/loaded/error 状态，语言重渲染不重新请求。段级与列表级 generation guard 均丢弃旧响应；missing/unreadable 不请求日统计，HTTP 失败不显示伪造零计数。聚焦 `80/80`（`259.7632ms`）、scoped Biome 和三个 `node --check` 通过。

未运行真实 API、DOM 监听器或浏览器；1920 视觉/键盘与 landed endpoint 验证留给下一张短真实浏览器卡。未验证 overlay 混合、并发多段、snapshot 过期码或移动端；server/store/executor 未改。

## C-sealed-days-browser 交接

主审已接受：worker 环境的 origin/Playwright 审批门超时后，主审在正常 host 原 fixture 与真实 Edge 接手，完成 days/Space 焦点/语言/freeze/实际移走 live/unfreeze 全流程。主审原始 `history-main-sealed-days-evidence.json` 保留首轮 `16` 项行为通过、唯一预期 live-missing usage 500 与 `pass=false`；精确绑定该 500 URL 的 `history-main-sealed-days-verified.json` 保留 `17` 项行为断言加 `pass=true` 共 `18/18` 全真。5 张 1920×1080 截图已经主审目视验收。

worker 的 loopback API oracle、signed token totals 修复与 rerender focused-summary 恢复均已完成；主审独立 mock 为 `82/82`、`225.7113ms`。renderer/tests 现已冻结，不再重试审批，也不扩复制 harness。真实浏览器验收已完成，后续进入整站性能实测卡。

## C-dashboard-major-seam 交接

本卡结论为 **不接收生产 patch，交当前主要接点**。只使用 `output/history-retention-profile-20261025-next/` 的两份 56 文件专属副本做小规模 `100,000` 行实验，并更新本报告；共享 `src/`、`public/`、测试、共享 benchmark/结果和运行中服务均未改。副本来自已接受 `20261025-current-million` 快照；施工前 `benchmark-model-store.mjs / src/pricing.js / src/usage-store.js / public/timeline-utils.js` 的 SHA-256 分别为 `e28db4db… / 12d39362… / edf21f09… / ce55a5e5…`。执行期间 live `src/usage-store.js` 已漂移到 `9757fb59…`，因此本卡结果只绑定固定副本；共享 `benchmark-model-dashboard-attribution.json` 仍为 `b9747c13…`，live `src/pricing.js` 仍为 `12d39362…`。

基线一次真实 `preset=all&skipCheck=1` 为 HTTP `200`、`81,564` bytes、`2,886.6478ms`，`100000 / 256 / 6`、metadata event count 与五项 token 全等于独立 SQL oracle，6 个 missing source 保留，timeout 未 override。绝对热点仍是首次 `sync 1,365.0686ms`，其后为 `summarizeInReadTransaction 1,068.4131ms`、`timelineRange 644.8940ms`、`groupedRange 336.0610ms`、`metadata 210.7193ms`。在 `timelineRange` 内，cost event scan 的 iterator active 为 `181.8396ms`、inclusive 为 `643.8497ms`，两者差额 `462.0101ms` 是提交给消费者的计价/bucket 工作。当前固定副本 `src/usage-store.js:9224` 明确调用 `estimateCost: (event) => estimateEventCost(event)`，**没有走** `eventCostMemo`；因此旧 CPU profile 的 `valueByteEstimate` / memo bookkeeping 路径不是当前 HTTP timeline 的直接热路径。

尝试 A 只替换 `createEventCostMemo` 内部的 `valueByteEstimate(value)` 为专用 event-cost byte counter，保持 budget、key、逐出和最终金额语义不变；前像、单一 patch `pricing.diff` 与三条本地断言均保留在 `attempt-value-bytes/`。同一 `100,000` events 的三条断言通过：完整输出 digest 均为 `748aed38…`，memo stats 完全相等（`0 hits / 100000 misses / 10039 evictions`），峰值 `74,603,504` bytes、round 后 `67,108,665` bytes。但 focused timeline consumer 从 `566.8053ms` 升到 `582.3239ms`，pricing memo callback 从 `396.4665ms` 升到 `421.6989ms`；HTTP 也从 `2,886.6478ms` 升到 `2,970.3119ms`，两边仍均为 HTTP `200`、完整 SQL oracle 相等、6 missing sources、无 timeout override。两项都回退，故 A 判负且不复活。

尝试 B 的 request-local pricing-plan prototype 只留在 `attempt-pricing-plan/pricing-plan.diff`，**未跑性能、未接收**。它原本包 `estimateEventCost()` 的 model/tier/entry/currency/fast-multiplier 解析，plan key 为 `model + serviceTier + sourceKind + channel + source`，仅在 `activePricing.version` 改变或达到 `1024` 项时清空；次级 rates key 为 `contextLevel + longOutput + peak`。这不是本卡允许的 byte-estimator 接点，而且 plan key 不含 catalog object identity，同 version 替换时可能读到旧 plan/rates；原型还一度把有 Fast 费率的 Claude Fast 事件误标 unavailable，归档前已修正但整个 prototype 随后回滚。`patched/src/pricing.js` 已恢复为基线 `12d39362…`，diff SHA-256 为 `fce0f77e…`。已修复的 `minimumRatesFor()` 不再重复作为建议。

结构化证据在 `evidence.json`，独立复核脚本 `verify-evidence.mjs` 已用 `node --check` 和实跑断言验证：两份 HTTP 输出都等于 SQL oracle；两份 complete timeline 输出均等于各自 production `timelineRange`；A 的 digest/stats 相等；A 的 focused/HTTP 都慢于基线；恢复后的 pricing hash 等于前像。下一最小测量只能是拆开当前 `buildTimelineRows` 内 direct `estimateEventCost` 与 bucket/grouping 的耗时，再决定是否存在可实施接缝；不能据此关闭 #19。限制是一次合成 `100k`、每种变体单次运行、首次请求含 sync、未做 1M/p95/并发/冷盘/真实来源/浏览器，且当前 HTTP consumer 尚未拆成 estimate 与分组两段。

## C-minimum-rate-allocation 交接

本卡结论为 **有限推广候选，不是 #19 完成**。只新增 `output/history-retention-profile-20261025-minimum-rate-allocation/` 并更新本报告；共享 `src/`、`public/`、测试、共享 benchmark/结果和运行中服务未改。两份隔离树来自已接受的 56 文件 manifest 副本 `696B31B1…`（其来源 snapshot manifest 为 `9C04298A…`）；56 个基线文件全部等于 manifest，补丁树中只有 `src/pricing.js` 不同。

唯一 diff 把 `minimumRateSets()` 的 `filter/map + Math.min(...spread)` 改为单次候选遍历，并逐字段计算最小值；基线 `12D39362…`、后像 `A0F1D597…`，patch `9CD5531B…`。`node verify-pricing.mjs` 对 6 个代表性场景比较完整 `estimateEventCost` 输出并比较聚合结果，`pass=true`、digest `d2dfbe13…`；两棵树的 `test/pricing.test.js` 均为 `34/34` 通过（`125.4281 / 114.2846ms`）。

每棵树各跑一次固定 seed 的 `100,000` 行 `--dashboard-attribution`：两边均 HTTP `200`、`81,564` bytes，`100000 / 256 / 6` 和五项 token 全等于独立 SQL oracle，保留 6 个 missing source，timeout 未 override。HTTP 总时从 `2,925.8518ms` 降到 `2,909.7231ms`（`-16.1287ms / -0.5512%`）；`timelineRange` 从 `666.3884ms` 降到 `643.7551ms`（`-3.3964%`），其中 cost consumer 从 `479.4739ms` 降到 `458.4858ms`（`-4.3773%`），`summarizeInReadTransaction` 从 `1,090.5068ms` 降到 `1,069.3715ms`。首次 `sync` 反向 `+0.5987ms`、`groupedRange` 反向 `+3.4943ms`，`metadata` 基本持平，因此只接受有限收益，不宣称这些路径改善。

结构化证据在 `evidence.json`；`verify-evidence.mjs` 已 `node --check` 和实跑通过，确认 56 文件 hash、唯一源码差异、patch 与双侧测试、oracle、timeout、missing sources 及上述 timing，`verification.json` 为 `pass=true`。scoped Biome lint 和源码 `node --check` 通过。live `src/pricing.js` 仍为基线 `12D39362…`，共享 `benchmark-model-dashboard-attribution.json` 仍为 `B9747C13…`。限制是只有一次固定 seed 的 `100k` 配对运行，含首次 sync，单次墙钟有噪声；未做 1M、p95、并发、冷盘、真实来源、浏览器或整站验证，#19 仍未关闭。

## C-sealed-day-event-drilldown 交接

主审已接受 18 项 UI 子行为并释放 renderer/i18n/test。独立 UI+i18n+render 为 `86/86`（`229.8068ms`）；真实 Edge `1920×1080`、`2294ms` 的 105 事件夹具完成首 100/末 5、稳定 id、末页 summary 焦点、语言、四段 `2+1+1` 带、冻结后移走 live 仍读 snapshot 分页、解冻 missing；`20` 项行为断言加 `pass=true` 共 `21/21` 全真。首轮仅千分位脚本预期两项 false，已保留 initial-number-format 原证据后修正，不是产品失败。最终证据 `56443AE7…`，初始证据 `C6639C6B…`。

`public/history-archives-ui.js`、`public/i18n.js` 与 `test/history-archives-ui.test.js` 现已冻结，不再接边缘探针；后续由主审完成 17 冻结 context 接线与 15 原子提交。axe、移动端、其他浏览器、并发多段或 overlay 混合未覆盖；server、store、executor 与 production 数据未改。

## C19-pricing-resolution-major-seam 交接

本卡结论为 **候选未接收：主路径没有达到稳定 `>10%` 改善，`#19` 仍未关闭**。只新增 `output/history-retention-profile-20261025-request-pricing-resolution/` 的固定副本、候选 diff、三组配对结果与复核脚本，并更新本报告；live `src/`、`public/`、测试、共享 benchmark/结果和运行中服务均未改。

主审已读候选 diff 并独立运行 `verify-evidence.mjs` 通过，接受本卡的 **拒绝结论**，不是接受性能门槛：六个 HTTP 请求全部等 SQL oracle，HTTP 配对中位 `-3.3484%`、均值 `-2.2662%`，没有稳定达到主要收益要求，因此候选不合入 live 源码，`#19` 保持打开。停止同类叶子计价优化和百万重跑；副本写入释放待命，供下一卡使用。下一卡由主审重排整请求重复扫描或现有 rollup 覆盖范围的结构接点，不能再用微收益候选填队列。

基准取自已接受的 `output/history-retention-profile-20261025-current-million/source-snapshot`：55 文件 manifest 仍为 `9C04298A…`，逐文件与 manifest 相等。两份可写树仅有候选允许的两个文件不同：`src/pricing.js` 从 `12D39362…` 变为 `6CAB338F…`，`src/usage-store.js` 从 `EDF21F09…` 变为 `F22596E4…`。完整候选 diff 为 `candidate.patch`（SHA-256 `57B43C4F…`），在原 baseline 上 `git apply --check` 通过。

候选择不重复上卡已拒绝的 `minimumRateSets` 分配微调，而是在 `timelineRange` 请求内创建一个 resolver：按模型缓存 `normalizeModel`/entry，按规范化 service tier 缓存，并按 model、currency、tier、context、long-output、peak 缓存只读 rate plan。每个事件的 token 阈值、用量分支、金额和最终 estimate 仍逐条计算；resolver 捕获 `activePricing` 对象身份，任何同版本重建或价目替换都会清空模型/tier/plan map，不引入跨请求状态或全局同版本缓存。

完整计价等价断言覆盖全部 `103` 个内置模型 × 五档 service tier × `short`/`long`/unknown context、缺 detail、未知模型 USD/CNY、Fast、Claude cache-write、长上下文/长输出、峰谷、`codex-auto-review`、`-free` 与 GPT-6.1 Codex policy，共 `1,656` 条；直接调用与复用 estimator 的完整对象均等于 baseline，digest `684DAAf4…`。同版本价目对象替换、同 `checkedAt` 内容变更和 A→A-replacement→B→A 的 estimator 复用也全部等于当前 baseline，`estimateCostForEvents` 聚合相等。两侧 `test/pricing.test.js` 均为 `34/34` 通过（`109.9313 / 110.3470ms`）。

三组 `100,000` 行 `--dashboard-attribution` 按 base→patch、patch→base、base→patch 交错执行。六个请求均 HTTP `200`、`81,564` bytes，`100000 / 256 / 6`、metadata `100000` 与五项 token 全等于独立 SQL oracle，均保留 6 个 missing source，默认 `120,000ms` executor timeout 未 override。

| 组 | 顺序 | HTTP total baseline → patched | Δ | timelineRange Δ | cost consumer baseline → patched | Δ |
|---|---|---|---:|---:|---|---:|
| 1 | base→patch | `2,875.6598 → 2,765.3331ms` | `-3.8366%` | `630.7672 → 553.7808ms` | `451.5602 → 380.9401ms` | `-15.6391%` |
| 2 | patch→base | `2,886.4879 → 2,789.8355ms` | `-3.3484%` | `625.7145 → 563.3716ms` | `449.3362 → 386.4333ms` | `-13.9991%` |
| 3 | base→patch | `2,839.9886 → 2,850.9593ms` | `+0.3863%` | `628.7827 → 563.6490ms` | `451.3762 → 388.2835ms` | `-13.9778%` |

HTTP 配对分布为中位 `-3.3484%`、均值 `-2.2662%`；三个 pair 分别为 `-3.8366% / -3.3484% / +0.3863%`，没有一组达到 `>10%`，其中第三组反向。cost consumer 中位 `-13.9991%`，三组均改善，但这只覆盖 `~450ms` 的时间线消费者，不能抵消首次 `sync`（约 `1.33–1.39s`）和其余 summary 工作。故本卡把该候选保留为可复查的有限消费者优化证据，不做生产推广；没有继续第三个 leaf 实验。

结构化证据在 `evidence.json`，独立复核脚本 `verify-evidence.mjs` 已实跑通过并写出 `verification.json`：确认 55 个 snapshot hash、baseline/patched 唯一两文件差异、patch apply、`1656` 条完整计价等价、两侧 `34/34`、六请求 oracle/timeout/missing-source、三组切换顺序、同版本价目替换和 A→A/B→A 无串价。共享 `benchmark-model-dashboard-attribution.json` 仍为 `B9747C13…`；复核时 live `src/pricing.js` 为 `12D39362…`、`public/timeline-utils.js` 为 `CE55A5E5…`、benchmark 为 `E28DB4DB…`。live `src/usage-store.js` 已被并行任务改写为 `4A4DBFE4…`，只作环境记录，不参与本卡比较。

命令：

```powershell
node output/history-retention-profile-20261025-request-pricing-resolution/verify-pricing.mjs
node --test output/history-retention-profile-20261025-request-pricing-resolution/baseline/test/pricing.test.js
node --test output/history-retention-profile-20261025-request-pricing-resolution/patched/test/pricing.test.js
node output/history-retention-profile-20261025-request-pricing-resolution/baseline/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard-attribution
node output/history-retention-profile-20261025-request-pricing-resolution/patched/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard-attribution
node output/history-retention-profile-20261025-request-pricing-resolution/verify-evidence.mjs
Set-Location output/history-retention-profile-20261025-request-pricing-resolution/baseline
git apply --check ../candidate.patch
```

限制：三组是固定 seed 的合成 `100k` 顺序请求，每组首次请求都包含 `sync`，单次墙钟受主机/JIT/page-cache 噪声影响；不是 p95、20-process、并发、冷盘、真实来源或整站验收。没有重跑 1M、没有改生产源码，也没有继续从 `minimumRateSets` 分配路径做第三个 leaf；`#19` 未关闭。

## C19-channel-source-join 交接

本卡结论为 **不推广：次级 SQL/UDF 接点，不是百万 `38/11s → 目标` 的主要方案，`#19` 保持打开**。主审从既有 `100k` attribution 看到 channel grouped SQL active 为 `116.26ms`、整 HTTP 约 `2,900ms`；即使把该 SQL 耗时完全消掉，理论上限也仅约 `4.0%`，达不到稳定 `>10%`。因此按新优先级立即停止剩余 HTTP 配对、百万重跑和追加 helper/leaf；本卡只交付未合入源码的单一候选 diff、结构等价测试和报告。

范围只新增 `output/history-retention-profile-20261025-channel-source-join/` 并更新本报告；live `src/`、`public/`、测试、共享 benchmark/结果和运行中服务均未改。两棵专属副本取自已接受的 `output/history-retention-profile-20261025-current-million/source-snapshot`，manifest 为 `9C04298A…`，55 个受管文件在 baseline 中逐文件相等；patched 只有 `src/usage-store.js` 从 `EDF21F09…` 变为 `95A867B8…`。唯一 diff 为 `candidate.patch`（SHA-256 `F9B90534…`），在原 baseline 上 `git apply --check` 通过；聚焦测试文件以 SHA-256 `E89E8DF2…` 同值复制到两侧，不进入候选 diff。

候选只改非 quota 的 `groupedRange("channel")`：`range_source_channels` 先从区间内 events 取实际 distinct `source_path + channel`，`grouped_source` 再复用 `source_files` 一次计算 `usage_source_group(channel, kind)`，最后按 `source_path + channel` JOIN 回 ranged events。quota 仍走原 raw `channel` 路径，`codex-auto-review` 仍在 `eventRangeFilter` 排除；source 身份仍只来自 `source_files`，没有改 `sourceGroup` 规则。`groupedRange` 的调用仍只有 `summarizeInReadTransaction` 的 channels/models/homes/projects 四处，只有非 quota channels 使用候选。

`verify-equivalence.mjs` 对完整 `groupedRange` 输出做 `deepStrictEqual`，五项均通过：同 source 多 channel、不同 kind 合并同组、跨 source 同 session 的 `COUNT(DISTINCT session_id)`、`excludeHomes`、quota raw channel 且排除 auto-review；夹具实际 distinct source/channel 对为 `6`。`equivalence.json` 记录的查询计划包含 `MATERIALIZE range_source_channels`、`MATERIALIZE grouped_source` 与按 `source_path` 查找，证明原逐事件 correlated source lookup/UDF 已移出主 group 路径。两侧既有 `SQLite product grouping deduplicates shared sessions without rewriting raw channels` 均为 `1/1` 通过；源码和验证脚本 `node --check` 通过。

停止令前已有四个原始 `100k` 请求落盘在 `groups/`，但三组配对未完成、没有 `pairing.json`，其 timing 不参与结论、不用于推广。限制：没有完整三组 HTTP 对比、1M、p95、并发、冷盘、真实来源、浏览器或整站验收；结构等价只证明该 CTE/JOIN 写法保持现有输出，不证明它是主请求热点。主审后续把 `#19` 拆为首次 `sync` 初始化与 skip summary 两条大路径，先出可审结构方案，再释放下一张源码卡；本卡不换另一个叶子。

命令：

```powershell
node output/history-retention-profile-20261025-channel-source-join/verify-equivalence.mjs
node --test --test-name-pattern "SQLite product grouping" output/history-retention-profile-20261025-channel-source-join/baseline/test/usage-store.test.js
node --test --test-name-pattern "SQLite product grouping" output/history-retention-profile-20261025-channel-source-join/patched/test/usage-store.test.js
Set-Location output/history-retention-profile-20261025-channel-source-join/baseline
git apply --check ../candidate.patch
```

## C19-major-path-plan 交接

本卡结论为 **下一张源码卡只做一个持久化 usage publication/rollup 主接点，不再做 pricing、memo、channel SQL 或单 visit 叶子；`#19` 保持打开**。只新增 `output/history-retention-profile-20261026-major-path-plan/` 的 `plan.md`、`evidence.json`、`verify-evidence.mjs` 与复核结果，并更新本报告；没有改 live `src/`、`public/`、测试、共享 benchmark/结果，没有跑新 benchmark 或百万请求。

现有 `1,000,000` 行固定样本只有一次 first+skip 序列：first `38,617.3085ms`、skipCheck `11,589.2531ms`，差值 `27,028.0554ms`（first 的 `69.9895%`）。这个差值只能称首次 checked 比 skipCheck 多出的未拆分部分，包含首次 native check/sync、冷启动/JIT 等，不能全部归因于 sync；两次 `checkedAt` 相同，`skipCheck` 仍执行 summary，不是纯结果缓存。若把 skipCheck 路径完全降到零，first 仍至少保留当前 `27,028.0554ms` 差值，仍高于 `15s` 单次上限，所以主结构必须同时覆盖首次 sync/bootstrap（rollup 一次性发布/初始化）与重复 summary 事件工作，不能只缓存 skipCheck 结果。

旧固定 `300,000` 行 profile 显示 `summarizeInReadTransaction 7,324.9986ms` 中 `timelineRange 5,279.5150ms`（`72.0753%`）、cost consumer `4,141.8059ms`；`groupedRange 1,663.0086ms`、`metadata 1,068.5480ms`、`periodComparison 733.4979ms`。这些 inclusive 值有重叠，不能相加冒充整页预算；仅把旧 timeline 份额机械套到当前 skipCheck，理论上限约 `8,352.9894ms`、剩余 `3,236.2637ms`，只能证明量级，不能当作当前源码预测。`sync-bootstrap-cause` 的旧 `300,000` 行首次 sync `6,499.3201ms`，补写 `252,570` 条 local rollup（days `366`、daily `2196`、models `17568`、sessions `232440`），第二次 sync `3.5136ms` 且零 rollup 写，说明首次 bootstrap 是必须一起处理的独立大份额。

主要接点定为：`src/server.js:923 GET /api/summary` → `usage-executor` → `src/usage-store.js:10022 summarizeHistory()` → `10217 summarizeInReadTransaction()`；构建侧 `7011 sync()` → `7125 syncRound()` → `8917` rollup 维护 → `src/usage-rollups.js:339 rebuildUsageRollupsFromSource()` / `454 rebuildUsageRollupsFromEvents()`。新增 publication 与现有 UTC/local rollup 共用 `usage_rollup_format`、dirty-day triggers、`usage_rollup_local_zone_identity`、`storeRevision/derivedRevision`、`writeTransactionDepth` 和同一写事务/rollback；`FORMAT_VERSION` 从 `7` 升到 `8`，不另建 TTL 或请求结果缓存。publication 按 `calendar_zone + hour bucket + home/model/channel_group/project/repository` 保存 count、token、已求和 cost-estimate、pricing status 与 reason，并有独立 session membership 供精确 distinct；day/week/month 由索引范围求和，partial-hour/无法证明完整边界回退 raw events。仅 `preset=all`、无排除、无 quota 且 publication 完整时走快路，其余继续 raw fallback。

失效契约覆盖 events INSERT/UPDATE/DELETE、local-zone identity、history archive authority/authorized segment/revision、source kind/home label、service-tier evidence signature、pricing catalog 内容或对象身份（含同 version 替换）、USD/CNY rate 与 format mismatch；任一不匹配即回退或同步重建，失败必须原子回滚。等价 oracle 要求 old/new 完整 `/api/summary` `deepStrictEqual`（仅规范化确属 volatile 的字段）、独立 SQL count/token、逐字段 `timeline/costEstimate/channels/models/homes/projects/repositories/metadata`，并覆盖 UTC/local、DST 23h/25h、完整/partial day、空 bucket、缺 detail、unknown pricing、same-version replacement、archive present/missing/unreadable 与 quota/exclude fallback。

证据新鲜度明确不足：`current-million` measured snapshot 的 `src/usage-store.js=EDF21F09…`、`src/server.js=B2965302…`；plan 时 live 为 `4A4DBFE4… / 92C07279…`，复核时 live usage-store 又漂移到 `29B1B379…`，因此本卡只证明结构接点选择，不证明现源码速度。下一卡先做源码对齐实现，用 `100,000` 行隔离副本跑 first+skip，要求完整输出等于 independent oracle/raw baseline、timeout 不 override、fast path 不再调用 `costEventsForRange()`，并分别记录 sync/publication build 与 summary 读时；whole-request 未稳定 `>10%` 改善即停止，不进入百万。通过后再用 `300,000` 行验证 bootstrap 一次遍历、dirty-day 增量、rollback 与 archive/pricing 失效；只有这些门槛全过才允许下一次百万验证，本卡未执行。

命令：

```powershell
node --check output/history-retention-profile-20261026-major-path-plan/verify-evidence.mjs
node output/history-retention-profile-20261026-major-path-plan/verify-evidence.mjs
```

`verification.json` 的 `pass=true`，断言 current-million first/skip/oracle/target、first−skip 差值、sync bootstrap counts、旧 profile 份额、上界计算、source freshness 与 `#19` open；复核时 live usage-store 漂移被记录为 `liveHashesChangedSincePlan`。限制：没有实现 publication、没有 current-source 100k/300k/1M 性能证明，没有 p95/20-process/并发/冷盘/真实来源/浏览器；旧 300k 结果不能外推。`#19` 未关闭。

## C19-local-bootstrap-batch

本卡结论为 **不推广候选：多日 batch 的持久 rollup 结果完全等价，但唯一要求的 100k first+skip 配对没有整请求收益，回滚后同连接可继续重建；`#19` 保持打开**。只新增 `output/history-retention-profile-20261026-local-bootstrap-batch/` 并更新本报告；live `src/`、`public/`、测试、共享 benchmark/结果和运行中服务均未改。

基线取自已接受的 `output/history-retention-profile-20261025-current-million/source-snapshot`，manifest `9C04298A…` 共 55 个受管文件。baseline 的 `src/usage-rollups.js` 为 `66B7FE31…`；patched 只把该文件改为 `86393F85…`，`FORMAT_VERSION` 仍为 `7`。完整 diff 为 `candidate.patch`（SHA-256 `4070707F…`，`+94/-0`），在原 baseline 上 `git apply -p2 --check` 通过。两侧 benchmark 副本都把 `EVENT_COUNT` 从 `1,000,000` 改成 `100,000`，该副本差异不进入候选。

候选只在 `targets.length > 1` 时走 batch：用现有 JS `dayBounds()` 结果填充事务内 TEMP target 表，一次删除目标日的 daily/models/sessions，一次写 day markers，再用三条 `INSERT ... SELECT` 重建 daily/models/sessions；UTC dirty days 也按 target 集合一次清理。单日继续走原 prepared statements 和逐日循环；所有工作仍在原 `SAVEPOINT usage_rollups_write` 内；TEMP target 在 `finally` 删除，不改变持久 schema。

`verify-parity.mjs` 对 `usage_rollup_days`、`usage_rollup_daily`、`usage_rollup_models`、`usage_rollup_sessions` 与 `usage_rollup_dirty_days` 的完整行逐字段相等，并通过：

- UTC 三日 batch：目标 5 个事件，目标外前后边界不泄漏，只清除 `2026-07-12..14` dirty days。
- 单日 path：仍走原循环，完整行相等。
- local New York 春/秋 DST：23h/25h marker、边界不泄漏，完整行相等。
- 在 batch model insert 注入故障后，五表恢复到故障前；`sqlite_temp_schema` 证明 TEMP target 已不存在；移除 trigger 后同连接再做一次 batch 成功，最终 3 days / 6 events，dirty 只余边界日。

最小 `verify-parity.mjs` 夹具只有一张无索引的 `events` 表，因此其 `EXPLAIN QUERY PLAN` 为每条 batch statement 的 `SCAN source`、`SCAN target`、`USE TEMP B-TREE FOR GROUP BY`（sessions 为 `DISTINCT`）。这个结果不能外推到正式 schema，也不能据此声称“一条 SQL 就是一次物理扫描”。为回应主审质疑，`real-schema-plan.mjs` 用真实 `UsageStore` 打开 schema `21`、创建既有 `events_timestamp_idx` 等正式索引，再写入 3 个 UTC 日、42 个事件并捕获同一候选的三处实际计划；三处均为 `SCAN target`、`SEARCH source USING INDEX events_timestamp_idx (timestamp_ms>? AND timestamp_ms<?)`、临时 B-tree 聚合。baseline 与 candidate 在该真实 schema 小库上的五张 rollup 表完整行相等（days `3`、daily `6`、models `12`、sessions `42`、dirty `0`），所以没有依据再做 join/驱动侧窄改。

两侧既有 `test/usage-rollups.test.js` 均 `25/25` 通过（`1132.3759 / 1211.2473ms`）；候选与三个验证脚本 `node --check` 通过。`output/` 被仓库 Biome 配置忽略，因此新增证据脚本只记录 `node --check` 与实跑结果，不声称 Biome 覆盖。

唯一性能配对按 baseline→candidate 顺序运行 100k `--dashboard-after-cache`。两次 HTTP 均 `200`、`81,564` bytes，`100000 / 256 / 6`、metadata `100000` 与五项 token 全等于独立 SQL oracle，均保留 6 个 missing source，默认 `120,000ms` executor timeout 未 override。

| 指标 | baseline → candidate | Δ |
|---|---:|---:|
| `cacheRebuild` | `1,259.3998 → 1,295.2067ms` | `+35.8069ms / +2.8432%` |
| first checked | `2,850.9272 → 2,831.1477ms` | `-19.7795ms / -0.6938%` |
| skipCheck | `1,024.0862 → 1,048.2668ms` | `+24.1806ms / +2.3612%` |
| first + skip | `3,875.0134 → 3,879.4145ms` | `+4.4011ms / +0.1136%` |

因此候选停留在隔离副本：rollup 重建本身回退 `2.84%`，first 的单次小幅改善不足以抵消 skip 回退，合并请求基本持平；没有继续 leaf 或百万重跑。`verify-evidence.mjs` 已实跑通过并写出 `verification.json`，复核 snapshot/patch hash、唯一源码差异、五表 parity、DST、rollback/recovery、真实 schema 的 target-outer/index-range 计划与小库对拍、两侧 25/25、oracle/timeout/missing sources 和共享结果 `B9747C13…`；live `src/usage-rollups.js` 仍为 `66B7FE31…`，共享 benchmark 仍为 `E28DB4DB…`。

命令：

```powershell
$env:TZ = "America/New_York"
node output/history-retention-profile-20261026-local-bootstrap-batch/verify-parity.mjs
node output/history-retention-profile-20261026-local-bootstrap-batch/real-schema-plan.mjs
node --test output/history-retention-profile-20261026-local-bootstrap-batch/baseline/test/usage-rollups.test.js
node --test output/history-retention-profile-20261026-local-bootstrap-batch/patched/test/usage-rollups.test.js
node output/history-retention-profile-20261026-local-bootstrap-batch/baseline/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard-after-cache
node output/history-retention-profile-20261026-local-bootstrap-batch/patched/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard-after-cache
node output/history-retention-profile-20261026-local-bootstrap-batch/verify-evidence.mjs
Set-Location output/history-retention-profile-20261026-local-bootstrap-batch/baseline
git apply -p2 --check ../candidate.patch
```

限制：只有一组固定 seed 的合成 `100k` 顺序配对，不是稳定分布、p95、20-process、并发、冷盘、真实来源、浏览器或整站验收；timed `cacheRebuild` 是 365 个 UTC target days，local 23h/25h 只做等价、不做独立计时。真实 schema 小库只证明计划方向与五表行相等，不提供耗时结论。没有 1M、没有生产推广，`#19` 未关闭。

## C19-derived-reuse-audit

本卡结论为 **现有 `derivedRevision` 缓存不能复用主 summary 的 timeline+cost 组件；`#19` 保持打开，首次 bootstrap 仍单列**。只新增 `output/history-retention-profile-20261026-derived-reuse-audit/audit.md` 并更新本报告；live `src/`、`public/`、测试、C19 候选与共享 benchmark/结果均未改，也没有重跑 benchmark、创建新夹具或新增持久 schema。

`derivedRevision` 只是修订标记（`src/usage-store.js:4084-4085`），统一失效入口会清 metadata、观测、period comparison、quota observation 与 event memo（`src/usage-store.js:4579-4593`），但本身不保存 timeline/cost 结果。主路径每次在 `summarizeInReadTransaction()` 新建 cost accumulator（`src/usage-store.js:10259`），调用 `timelineRange()`（`:10261`），后者经 `costEventsForRange()` 逐事件直接调用 `estimateEventCost`（`:9515-9524`）；`buildTimelineRows()` 在构造 bucket 行时执行该回调（`public/timeline-utils.js:586-669`），不返回可复用的 accumulator。

| 现有缓存 | 内容 | 为何不适用 |
|---|---|---|
| `metadataCache` / `metadataObservationCache` | 全历史 metadata 与静态观测输入 | 不含所选范围的 timeline/cost |
| `periodComparisonCache` | 日/周/月 comparison 聚合 | 范围不同，且无 timeline/cost |
| `quotaObservationCache` | 已提交 quota 观测行 | 仅原始观测，不含 timeline |
| `recordChampionCache` | 全历史记录冠军 | 只有冠军结果，不含逐事件 timeline |
| `eventCostMemo` | 有界、实例私有的逐事件金额 | 主 timeline 明确绕过；不含 bucket/accumulator |

最小一行实验是把 `timelineRange()` 的回调改为 `this.eventCostMemo.estimate(event)`；本卡**未实施**。它最多复用逐事件金额，不能复用 timeline rows、分组或 cost accumulator，且既有全 miss/逐出证据显示该路径可能更慢，因此不能当作本卡的整段复用方案。若以后另立内存结果 memo，键至少需覆盖 store/DB 实例、storeRevision（含外部提交与 home 形状）、规范化范围/asOf/bucket/calendarZone/quota、service-tier 签名、规范化排除集、pricing catalog 对象身份（含同版本替换）、汇率及所有影响分组/成本的选项；写事务内不得读写，且不能跳过 cold/missing 验证。

审计时 `src/usage-store.js`、`public/timeline-utils.js`、`src/pricing.js` 的 SHA-256 分别为 `29B1B379…`、`CE55A5E5…`、`12D39362…`；C19 `candidate.patch` 仍为 `4070707F…`，`verification.json` 仍为 `4959144F…`，共享 benchmark 结果仍为 `B9747C13…`。本卡只做源码静态审计，未重跑 100k/300k/1M，未做 p95、并发、冷盘、真实来源或浏览器验证；一行 event memo 候选仍不是整请求缓存，`#19` 未关闭。

## C20-timeline-currency-order 交接

本卡结论为 **主审已接受混币修复；`#19` 仍失败，`#20` 整项不关闭**：同一未知模型在 `ZCode` CNY 与 `CLI` USD 下原会按模型名合并，并让首个事件的币种决定整桶币种；现在按 `(model, native currency)` 分桶，USD/CNY 金额不再相加，单币种模型的既有 key 与形状保持不变。生产范围只改 `public/timeline-utils.js` 与 `public/app.js`，并新增 `test/history-timeline-currency-order.test.js`；未改 CSS、i18n、pricing、store、server 或其他卡片。

RED 已保留：修复前 forward/reverse 都把两种金额合成 `0.00001274`，仅 currency 随事件顺序在 CNY/USD 间变化；`red-exit-code.txt` 为 `1`。最终 `public/timeline-utils.js` 为 `CBA7B6CE…`（原 `CE55A5E5…`），`public/app.js` 为 `81D0C2A1…`（原 `60C27F82…`）。主审先读的语义 patch 为 `c20-public-timeline-utils.patch` 与 `c20-public-app.patch`；最终含 formatter 输出的 patch 为 `c20-final-public-timeline-utils.patch`（`0B58E2CA…`）与 `c20-final-public-app.patch`（`51E56544…`）。

混合币种桶使用 composite key，并在桶内保留原模型名；detail、chart segment、tooltip 与 legend 都解码回原模型名。图表比例继续复用 `scaledCost()`，native 金额保持独立。新测试覆盖 forward/reverse 等价、单币种形状不变、detail 按 model+currency 分组以及 tooltip/legend 不泄漏 composite key。

验证为：新测试 `4/4`、聚焦 timeline/app/i18n `122/122`；最终格式化后本地定向 currency+timeline-utils+app-render `82/82`（`201.2780ms`），主审独立复跑 `82/82`（`216.6833ms`）。三文件 `node --check`、scoped Biome `Checked 3 files` 且无 fix。主审在真实 staging 用新代码从实际 restore 的未归档 `108465` public events 重建完整业务 summary，与 commit 副本逐字段对拍通过；`108465` events 原 hash `17a20995…edf93` 严格不变。对拍仅规范化集合顺序与货币最大 IEEE 尾差 `2.6148e-12`，币种严格相等。原错误 oracle 与 RED 证据保留。

全部 stdout/stderr/exit code 与最终 patch 在 `output/history-retention-c20-timeline-currency-order/`；`verification.json` 的 RED 保留、最终 `82/82`、formatter/lint/syntax 退出码和当前文件 hash 全通过；测试文件最终为 `7B5B5924…`。`public/` 与测试改动可交还锁，不再改语义或扩跑。限制是本卡未重跑 1M，也未把该修复表述为整站或 `#19` 性能验收；`#19` 仍失败，`#20` 整项不关闭。

## C-static-summary-projection 交接

本卡结论为 **限定组件候选通过，但不作 live 推广，`#19` 仍未关闭**。只新增/修改 `output/history-retention-profile-20261026-static-summary-projection/` 的隔离副本、证据与本报告；live `src/`、`public/`、测试、共享 benchmark/结果和运行中服务均未改。共享 `benchmark-model-dashboard-attribution.json` 仍为 `B9747C13…`；复核时 live `src/usage-store.js`、`src/server.js`、`src/pricing.js`、`public/timeline-utils.js` 分别为 `29987D57…`、`92C07279…`、`12D39362…`、`CBA7B6CE…`。

本卡沿用目录中既有的 baseline/candidate 隔离树，但不把它冒充旧 `20261025-current-million` manifest：该 manifest 的 55 个文件中已有 11 个与当前 baseline 不同，因此只以本卡实测前像为准。baseline `src/usage-store.js` 为 `CC4DA6E3…`，唯一源码后像为 `36A3AD98…`；两棵 101 文件树逐文件比较，除该源码和各自运行结果 `benchmark-model-dashboard-after-cache.json` 外无差异。归一化后的 `candidate.patch` 为 `62916E06…`，`+88/-24`，使用标准 `a/src/usage-store.js` / `b/src/usage-store.js` 路径，在 baseline 目录执行 `git apply --check ../candidate.patch` 通过。

候选为 `UsageStore` 实例私有的单槽 `summaryProjectionCache`，只对 `preset=all`、无 quota、无写事务、且无归档 authority 的请求生效。键含 `storeRevision`、`derivedRevision`、SQLite `total_changes()`、`data_version`、价目版本与汇率、service-tier 输入签名、解析后的 range、bucket、规范化排除集和 `includeDetails`；open/revision invalidate/close 均清空。缓存只保存 timeline/timelineError/costEstimate、channels/models 和可选 homes/projects/repositories，命中时 `structuredClone` 后返回；`generatedAt`、quota、metadata、periodComparison、perf 等动态字段仍在槽外重算。没有跨请求全局缓存、TTL、持久 schema 或结果级 memo。

`verify-projection.mjs` 实跑通过：同 revision 结果相等且调用方修改不污染缓存；新增事件推进 revision 后失效；价目内容变化在同一个 `checkedAt` 下得到新版本并改变费用；standard→fast service-tier 签名只触发 timeline 重建，fast 重复调用命中；`tierTimelineRebuilds=2`、`cachedKey=true`。完整计价相关输出仍保持逐事件金额语义，候选没有缓存最终事件费用。

反向次序的一次 `100,000` 行 `--dashboard-after-cache` 配对为 candidate→baseline。四份 HTTP 请求均 `200`、`81,564` bytes，`100000 / 256 / 6`、metadata event count 与五项 token 全部等于独立 SQL oracle；均保留 6 个 missing source，默认 `120,000ms` executor timeout 未 override。`verify-payload-equality.mjs` 只规范化 `checkedAt`、top-level `quota.asOf`、`summary.generatedAt`/perf `indexedAt`/range/quota `asOf`、`metadata.generatedAt`/`modelUsageAsOf`、`periodComparison.asOf` 与每个 `missingSources[].missingSinceMs`，其余完整 `summary + metadata + periodComparison` 逐字段比较；first/skip 及两边共四份 payload 全部相等，统一 digest 为 `EB8F913D…`（summary `18` keys、metadata `11` keys、periodComparison `5` keys）。首次捕获遗漏了后两个 volatile 字段，benchmark 副本已补齐，`payload-verification.json` 对已捕获 payload 重新归一化后通过。

| 配对 | 顺序 | first | skipCheck | first + skip |
|---|---|---:|---:|---:|
| 初次 | baseline→candidate | `2831.6482 → 3752.2154ms`（`+32.5099%`） | `1096.7974 → 35.7000ms`（`-96.7451%`） | `3928.4456 → 3787.9154ms`（`-3.5772%`） |
| 反向 | candidate→baseline | candidate `2829.2450ms` vs baseline `2799.9141ms`（`+1.0476%`） | candidate `32.2219ms` vs baseline `1030.8270ms`（`-96.8742%`） | candidate `2861.4669ms` vs baseline `3830.7411ms`（`-25.3025%`） |

`skipCheck` 的约 `97%` 降幅在两次配对中重复，是真实的 warm summary 静态部分收益；初次 first 的 `+32.5%` 在反向配对没有重复（仅 `+1.05%`），只能按当前两次样本记为 order/JIT/process 噪声，不能宣称稳定回归。候选按设计无法帮助首次 cache miss，且首次请求仍包含 sync；两组 first+skip 收益为 `-3.58% / -25.30%`，跨组波动明显，不能据此宣称稳定整请求门槛或关闭 `#19`。因此保留该候选作为后续首次 bootstrap 结构方案的限定组件证据，本卡不把 patch 推入 live。

证据：`projection-verification.json`（SHA-256 `10054BA0…`）、`payload-verification.json`（`0C5FC3EE…`）、reverse candidate/baseline stdout（`F22AE3D1… / 02E4547A…`）。benchmark 两副本同为 `52B58E4A…`。两条 JS 验证脚本与两份 benchmark 副本的 `node --check` 通过；scoped Biome lint（`--formatter-enabled=false`）通过。formatter 未应用：`src/usage-store.js` 的 Biome formatter 会重排大量未触碰的旧行，应用它会破坏最小 diff；最终 patch 保持原基线格式。

命令：

```powershell
node output/history-retention-profile-20261026-static-summary-projection/verify-projection.mjs
node output/history-retention-profile-20261026-static-summary-projection/verify-payload-equality.mjs
node output/history-retention-profile-20261026-static-summary-projection/candidate/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard-after-cache
node output/history-retention-profile-20261026-static-summary-projection/baseline/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard-after-cache
Set-Location output/history-retention-profile-20261026-static-summary-projection/baseline
git apply --check ../candidate.patch
```

限制：只有两组固定 seed 的合成 `100k` 顺序请求，first 都包含首次 `sync`，单次墙钟受主机/JIT/page-cache 噪声影响；没有 1M、p95、20-process、并发、物理冷盘、真实来源、浏览器或整站验收。归档 authority 绕过由代码条件和 key 设计覆盖，但本卡没有单独存档/turnover 夹具；没有生产合入，`#19` 未关闭。

## C19-static-summary-projection-promotion

本卡把已审阅的限定候选推进 live：只改 `src/usage-store.js`、新增 `test/history-summary-projection.test.js` 并更新本报告；未改 `public/`、server、pricing、rollup、schema/index、共享 benchmark/结果或运行中服务。前像已保存到 `output/history-retention-profile-20261026-c19-static-summary-projection-promotion/preimage/`：`src/usage-store.js` 为 `F7D746DF7B0B7900A1A5E1B0E18D7BD5B9358FFC74BF48029259D97EB775356A`（`492331` bytes），本报告为 `D8B1C7EB6A7172BC318BDC5C93E31459583CE8A60CFE75E12D2B18BA3611019F`（`334274` bytes）。

生产接缝仍是 `UsageStore` 实例私有的单槽 `summaryProjectionCache`，只覆盖 `preset=all`、非 quota、`writeTransactionDepth === 0` 且无 event/perf 归档 authority 的请求。键包含 `storeRevision`、`derivedRevision`、SQLite `total_changes()`、`data_version`、价目版本与汇率、service-tier 输入签名、解析后 range、bucket、规范化排除集和 `includeDetails`。只缓存 timeline/timelineError/costEstimate、channels/models 与可选 homes/projects/repositories；命中后 `structuredClone`，动态 `generatedAt`、quota、metadata、periodComparison、perf 仍逐次计算。`open()`、修订失效入口和 `close()` 都清空该槽；没有跨请求全局缓存、TTL、持久 schema 或最终事件费用缓存。非 `all`、写事务内和归档 authority 路径保持完整重算。

真实前像窄 diff 已固定为 `output/history-retention-profile-20261026-c19-static-summary-projection-promotion/promotion.patch`（SHA-256 `B02904CB7F10FAF039AFBF3923E3E3E56764E498DEE835C774F4CB62DF1B0D95`，`19933` bytes），前向应用与对 live 的反向检查均通过。最终 `src/usage-store.js` 为 `E51DA1B09C03E700E5F06EE7F73206B6696275E4C5285186717C5532FE20EAB7`（`495306` bytes，相对前像 `+89/-25`），新测试为 `1493D48F4E7F267CBC04F441D580B157672A0AD4A178CFE3FAA2B35027D59ED2`（`8099` bytes）；`final-manifest.json` 为 `88DFCD5C41E139308A58F49A0AA7F9974C49174E24222C8EFEB59C741E0B9C70`。`node --test test/history-summary-projection.test.js` 本地最终为 `1/1` 通过（`180.9694ms`），主审独立正常复跑为 `1/1`（test `58.3068ms` / runner `101.3241ms`）：同输入真实命中、调用方修改隔离、事件失效、同 `checkedAt` 价目内容替换、service-tier 签名变化和非 `all` 热库路径不误用该槽都通过；diagnostic 为 `cachedKey=true / mutationIsolated=true / eventInvalidation=true / tierInvalidation=true / tierRevisionUnchanged=true / nonAllAlwaysRebuilds=true / timelineCalls=7`。`nonAllFilters` 只是 `preset=today` 的正常热库断言，不是 cold/missing 证明。相关既有 `history-summary`、`usage-store`、`history-timeline-direct-cost` 为 `54/54` 通过（`3821.8767ms`）；另跑既有真实 cold/missing 回归 `history-cold-summary-prepared` 与 `history-cold-dashboard-api`，正常 host 为 `3/3` 通过（`5694.9153ms`），sandbox 内先因既有 hard-link 夹具 `EPERM` 失败，不是产品失败。主审独立真实两段 perf 移走整次失败回归 `history-cold-perf-multisegment-missing.test.js` 为 `1/1`（test `360.1089ms` / runner `442.3964ms`）。变更后测试 scoped Biome（`--formatter-enabled=false`）为 `6ms` 通过，测试 `node --check` 通过。主审已接受上述行为；`src/usage-store.js` 与本测试现已冻结，不再改写，供后续整树快照使用。

生产推广只证明限定缓存语义；`nonAllFilters` 不是真实冷段覆盖，cold/missing 仅有上述既有回归且由主审另选最小运行，没有新造 fixture。推广后没有重跑 `100k`/`1M`、重复整请求、p95、并发、物理冷盘、真实来源、浏览器或整站验收，也不把隔离候选的 warm `skipCheck` 收益外推为整 HTTP 结论。首次 cache miss 仍完整执行 timeline/cost/grouping，首次 `sync` 不在本缓存范围；`#19` 仍未关闭。

## C20-cold-perf-fixture-contract

本卡只更新 `test/history-cold-perf-eviction.test.js`、`test/history-cold-perf-revision-overlay.test.js` 与本报告；本卡未修改 `src/`，没有放宽生产 guard，也没有新增全能 fixture。复核时 live `src/usage-store.js` 为 `EA6A01BC4D53246F009A4C1132D6D9B23FDF6BDE356D899E9570ECDD79D6B857`，仅作并行任务环境记录。即时前像保存在 `output/history-retention-c20-cold-perf-fixture-contract/preimage/`；`preimage-manifest.json` 为 `3F1C0B467DE479132411719562B6458F46099601D78E9B690439B1C626025EBB`。前像测试 hash 分别为 `B3F8E4E66425946B8019F662AC5C11459E2DC58D5F50F523FACC04A93FF9D1D2` 与 `BCD4334164944B84FE60CFC0DD58048E083B235B4548FF7D17F3DD5E46DE5126`。

正常 host 的两条 RED 已精确定位。`history-cold-perf-eviction.test.js` 旧夹具只手写 event authority，candidate 虽含已验 perf components，却未声明 perf capability；随后热库删除所选 sample 时，`summarizeHistory` 只能回退到 hot perf，因而比未删除的 oracle 少一条 sample，coverage 从 `34/30` 变为 `33/29`。修复不改生产门槛，而是复用正式能力链：`createHistoryArchiveCandidate → prepareHistoryArchiveCommit → commitHistoryArchiveEvents`，由 commit 原子声明 event/perf authority 并移走 cold events/perf；断言 plan 明确包含所选 cold sample，commit 后同一 SQL 快照确认 cold sample key 已不在 hot `perf_samples` 且 hot sample key 仍存在，读取前后 segment 不变，并将 `eventCount/sessionCount/homeCount/totals` 与完整 `perf`（含全部 models/coverage/meta，仅规范化 `indexedAt`）对拍 un-evicted oracle。SQL 存活断言可排除 commit 错误 no-op 时仅靠 summary 等价误绿。

`history-cold-perf-revision-overlay.test.js` 的原 `removedOnlyRevision` 删除了 candidate sample，却保留引用该 sample 的 native Codex request facts；新数值验证按契约报 `HISTORY_ARCHIVE_REVISION_INVALID`，提示 `Codex request facts reference a missing effective sample […]`，因此旧的“coverage 减一”成功预期已过期。夹具改为断言该 removed-only revision 必须被拒绝且错误包含原 sample key；合法 sample+timing revision 仍与完整 perf oracle 相等，dedupe、缺 native evidence、重复移除、错误 source identity 与过量移除等非法 payload 拒绝均保留。两处都是真实夹具契约更新，不是生产回归，未提交 `src` seam。

聚焦命令 `node --test test/history-cold-perf-eviction.test.js test/history-cold-perf-revision-overlay.test.js` 为 `2/2` 通过（`605.8912ms`）；scoped Biome（`--formatter-enabled=false`）为 `7ms` 通过，两文件 `node --check` 通过。最终 `history-cold-perf-eviction.test.js` 为 `AD4DB2A259BD1E7C3585C76BCF6CFBB67FBE3E9F57BFCF967B8F334CD95B0D1C`（`4180` bytes），revision overlay 为 `355FD4E11D96EFD67EADBCB72746115E1A974E2BE73A405EB130D650AFDC154F`（`14336` bytes）。窄 diff 分别为 `98EA35837CBD7959E2B7A582842007A4A906A2AC0628F5E995FF88E2294E2502` 与 `34C311DF580329EB813CE461746BC269D60CF91EAD1352EBEA55C1476859F0C8`，前向及反向 apply check 均通过；`final-manifest.json` 为 `3E8DB972B658723AD98615D97FA76BBC76005D78B3DF739A348CA2D39068A03D`。本卡未跑全仓 `npm test`、百万基准、浏览器或整站验收；没有生产改动。

## C19-model-resolution-reuse

本卡结论为 **隔离候选保留，不作 live 推广；`#19` 保持打开**。只新增 `output/history-retention-profile-20261026-model-resolution-reuse/` 并更新本报告；live `src/`、`public/`、测试、共享 benchmark/结果和运行中服务均未改。单组 `100k` candidate→baseline HTTP 为 `1494.1102 / 1618.9112ms`（候选改善 `124.8010ms / 7.7089%`），cost consumer 为 `426.7917 / 534.4720ms`（改善 `107.6803ms / 20.1470%`）。该整请求幅度不足以把既有 1M first 约 `20.3s` 带到 `15s`，且候选新增跨请求 cache，因此本卡不推广，也未分配下一张叶子卡或新百万实验。

baseline 是新复制卡开始时的当前 root，包含 PRICE 合入后的新 resolver，不能与旧 million 冻结混称同 hash：`public/pricing-models.js` 为 `D579C6C5…`（旧 million 为 `97DC1088…`），`src/pricing.js` 同为 `12D39362…`，`src/usage-store.js` 为 `EA6A01BC…`（旧 million 为 `EDF21F09…`），`public/timeline-utils.js` 为 `CBA7B6CE…`（旧 million 为 `CE55A5E5…`）。两棵初始树各 101 文件且逐文件相等；排除运行时必写的 benchmark result 后，baseline manifest 为 100 文件 / `DDB67795…`，candidate 为 100 文件 / `CB72B2DD…`，唯一源码差异为 `src/pricing.js`。

候选只在 `src/pricing.js` 增加模块私有 `createBoundedKeyMemo`：键含当前 pricing version 和完整 trimmed raw model，只缓存既有 `{name,key,free}` resolution，固定上限 `4096` entries / `1 MiB`，不缓存 rate、estimate 或最终事件费用；`setPricingCatalog()` 与 `resetPricingCatalog()` 都显式清空。归一化 `candidate.patch` 为 `+17/-2`、SHA-256 `EDD906DB…`，在独立临时 Git 树且 `core.autocrlf=false` 下前向应用得到候选 `5A3956A7…`，反向应用恢复 baseline `12D39362…`；临时树已删除。

`verify-pricing.mjs` 对 104 个目录模型、6 类事件比较完整 `estimateEventCost` 与 aggregate：默认价目、正常、unknown、routed Claude、auto-review、unknown-free、suffix match，以及相同 `checkedAt` 下先替换 model key、再替换 price content。所有候选输出等于 baseline，替换都产生新 version，不误用旧 resolution/金额；digest 为 `34DD3651…`。本卡没有跑全仓测试，也没有扩成 1,656 条大验证。

唯一 `100k --dashboard-attribution` 配对为 candidate→baseline，两边均为 HTTP `200`、`81,564` bytes、`100000 / 256 / 6`、metadata `100000`、6 个 missing source，默认 `120,000ms` executor timeout 未 override。五项 token 均等于 independent SQL oracle：`252603269 / 164368399 / 65763785 / 88234870 / 17585661`。只规范化已知 volatile 时间字段后，完整 `summary + metadata + periodComparison` payload 深等，digest 为 `EB8F913D…`。headers 为 `1492.7123 / 1617.4243ms`；`timelineRange` inclusive 为 `600.1098 / 718.0789ms`；event scan 为 active `172.2433 / 182.5618ms`、inclusive `599.0350 / 717.0338ms`。

共享根 `benchmark-model-dashboard-attribution.json` 的卡前像和当前值均为 `B9747C13…`；A19 first-ready 的 `A28974B4…` 是隔离 output 树中的另一份结果，没有覆盖共享根文件。两者已写入 `shared-result-preimage.json` 并分别断言，未改共享结果来凑保护 hash。`verification.json` 对同源 stdout/树内 result、完整 payload、oracle、timeout/missing sources、唯一源码 diff、A19 隔离结果身份和共享根前像全部通过；实际 patch round-trip 单独记录在 `patch-verification.json`。

限制：只有一组固定 seed 的合成 `100k` 顺序请求，candidate 在前，仍含首次 executor startup/sync；不是重复组、p95、20-process、并发、物理冷盘、真实来源、浏览器或整站验收。没有 1M 重跑；单组约 `8%` 的整请求变化只作本卡证据，不新增百分比门槛，也不外推为 `#19` 关闭。

命令：

```powershell
node output/history-retention-profile-20261026-model-resolution-reuse/verify-pricing.mjs
node output/history-retention-profile-20261026-model-resolution-reuse/run-http-pair.mjs
node output/history-retention-profile-20261026-model-resolution-reuse/verify-evidence.mjs
```

## C19-catalog-warm

本卡结论为 **稳定 catalog 下的 warm 归因已由主审接受，但不作生产改动，`#19` 仍保持打开**。只新增 `output/history-retention-profile-20261026-catalog-warm/` 并更新本报告；live `src/`、`public/`、测试、共享 benchmark/结果和运行中服务均未改。冻结来源是 `output/history-retention-profile-20261026-period-metadata-shared/` 的已审树；`frozen-manifest.json` 的 98 个源/包文件逐文件等于 `review-freeze.json`（`mismatches=[]`），只把 evidence benchmark 改成一次 checked 加三次连续 `skipCheck`。`frozen`/`run-tree` 各 99 文件，唯一变化是 `docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs`；冻结 benchmark 为 `fc80b860…`，run-tree 工具为 `c5077a1f…`，规范化 `tool.patch` 为 `434fe11e…`。

唯一 100k 运行 exit `0`；stdout `100k.stdout.json` 为 `962293` bytes、SHA-256 `47abab03…`，stderr 为空（`e3b0c442…`），`100k-verification.json` 为 `fd01af4a…`。四次请求均为 HTTP `200`、完整响应 `107900` bytes，事件/会话/home 为 `100000 / 256 / 6`，metadata event count 为 `100000`，五项 token 与独立 SQL oracle 精确相等，并保留 6 个 missing source；默认 `120000ms` executor timer 未 override。first checked 为 `1340.7040ms`，三次 warm `skipCheck` 为 `31.2722 / 32.0633 / 32.1869ms`。四次都使用 catalog `2026-10-01-824959549cbc`，每次相邻 `catalogSame=true`；本 run 实际 `catalogSwitched=false`，不能把结果表述成发生过 scheduler switch。每次响应都保留完整 `summary.costEstimate`、pricing catalog、timeline、statistics 与 metadata，且响应内 `priceVersions` 和汇率与自身 catalog 一致；同 catalog 相邻请求的完整 catalog 与仅去掉已知 volatile 时间字段后的业务 payload 深等。

1,000-event smoke 同样 exit `0`：`smoke.stdout.json` 为 `912857` bytes、SHA-256 `7e1325d0…`，`smoke-verification.json` 为 `a118187d…`；四请求均为 HTTP `200`，`1000 / 256 / 6` 与 oracle 相等，四请求 catalog 均为 `2026-10-01-824959549cbc`，warm times 为 `72.8531 / 12.7219 / 20.4013 / 12.0893ms`，本 run 也未发生 switch。`verify-evidence.mjs` 为 `50feb540…`，`node --check`、`verify-evidence.mjs manifests` 和两档 `run` 均通过；主审已独立复跑 manifests、smoke 与 100k。

命令：

```powershell
node output/history-retention-profile-20261026-catalog-warm/verify-evidence.mjs manifests
node output/history-retention-profile-20261026-catalog-warm/verify-evidence.mjs run output/history-retention-profile-20261026-catalog-warm/smoke.stdout.json 1000
node output/history-retention-profile-20261026-catalog-warm/verify-evidence.mjs run output/history-retention-profile-20261026-catalog-warm/100k.stdout.json 100000
```

限制：只有一次固定 seed 的合成 100k 运行，first 包含首次 sync；没有 1M、p95、20-process、并发、物理冷盘、真实来源、浏览器或整站验收，也没有生产 patch。`catalogSwitched=false` 是本 run 的观测事实，不是强制切换证明；warm 数值只作稳定 catalog 下的限定归因，不外推为 #19 关闭。

## C19-current-attribution

本卡结论为 **只完成当前定价路径下的一次有效 100k 归因，不推广候选、不关闭 `#19`**。只新增 `output/history-retention-profile-20261026-current-attribution/` 并更新本报告；live `src/`、`public/`、测试、共享 benchmark/结果和运行中服务均未改。冻结输入从已审 `output/history-retention-profile-20261026-catalog-warm/frozen/` 复制，98 个产品/包文件逐文件相等；本卡唯一工具差异是 evidence benchmark 的 hook label 与 launcher trace 落盘。

第一次 100k 尝试在 HTTP `200`、`107900` bytes 后停在 `costEventsForRange event scan was not traced`。根因是旧 hook 匹配 `SELECT timestamp_ms, session_id, home_id, channel, model, detail_mask`，而当前 `COST_EVENT_COLUMNS` 已扩展为 `home_label, source_path, project, ...`；SQL 已记录，只是 `label=null`。失败原始 stdout/stderr/exit 已保留为 `failed-hook-label.*`，不是产品失败。修正只在本 output 的 `labelSql()` 改为当前完整成本查询前缀并同时要求 `FROM events WHERE`，where 条件未改；launcher 在临时目录清理前把完整 trace 复制到 `dashboard-bottleneck-trace.json`，失败也保留。`hook-label.patch` 为 `+6/-2`、SHA-256 `620727C3…`，修改前/后 benchmark 为 `FC80B860…` / `BBEE7BBB…`。

修正后唯一一次 `100k --dashboard-attribution` exit `0`。HTTP `200`、`107900` bytes，headers/total 为 `1763.6659 / 1764.9048ms`；事件/会话/home 为 `100000 / 256 / 6`，metadata event count 为 `100000`，6 个 missing source 保留，默认 `120000ms` executor timeout 未 override。响应五项 token 与独立 SQL oracle 精确相等：`252603269 / 164368399 / 65763785 / 88234870 / 17585661`。catalog 为 `2026-10-01-824959549cbc`，payload fingerprint 为 `74eb57be…`。stdout 为 `235770` bytes、SHA-256 `ACA269DD…`，stderr 为 `318` bytes、SHA-256 `F917EB35…`，完整 trace 为 `13354` bytes、SHA-256 `080412FC…`。`run-inputs.json` 列出实际加载的 99 个输入（`1 package + 35 src + 62 public + 1 benchmark`，`21633552` bytes，SHA-256 `6933AA9B…`）；97 个 `src/public` 产品文件与 frozen 树逐 hash 相等。

trace 实际热点：`summarizeInReadTransaction` inclusive `1354.0748ms`；`timelineRange` `1255.7960ms`；`costEventsForRange` inclusive `1255.2760ms`，其中 event scan iterator active `259.2764ms`、inclusive `1254.6909ms`，consumer 差值约 `995.4145ms`，扫描 `100000` 行 / `100001` next calls。其余为 `metadata` `173.8454ms`、`periodComparison` `145.0815ms`、`periodAggregate` `140.2390ms`、`repositoriesRange` `61.7713ms`、`aggregateRange` `28.8342ms`、`sync` `14.8742ms`。因此本 trace 直接支持“consumer 占主耗时”，不是 cache miss 猜测；这里 consumer 差值包含 row 构造与消费，不是纯 SQLite 时间。`summarizeInReadTransaction`、`timelineRange`、`costEventsForRange` 是嵌套容器，trace 的 inclusive 字段不能互相相加。

命令：

```powershell
node output/history-retention-profile-20261026-current-attribution/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --dashboard-attribution
node --check output/history-retention-profile-20261026-current-attribution/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs
```

限制：这是 worker-hook、单请求、`skipCheck=1` 的合成 100k 诊断，first request 仍含 executor startup/sync；不是普通默认 scheduler 分进程计时，也不能据此判断 SLA/RSS、p95、并发、冷盘、真实来源或 1M。没有生产 patch，`#19` 保持打开。

## C19-cost-row-arrays-http

本卡结论为 **结构接点已由主审接受并窄 apply 到 root；HTTP 证据只支持限定 warm 收益，`#19` 保持打开**。只新增 `output/history-retention-profile-20261026-cost-row-arrays-http/` 并更新本报告；本卡没有改生产源码、测试、共享 benchmark/结果或运行中服务，也没有重跑 1M。主审已独立核验输入/hash 与完整 `payload/costEstimate/perf`，接受新 array seam，并实际将 `src/usage-store.js` apply 为 `AA047AED…`；本卡记录该外部验收与 root 状态，不把它表述成本地计时结论。

输入取自已接受的 catalog-warm run-tree，并只替换两侧 `src/usage-store.js`：baseline `D27616C8…`、candidate `AA047AED…`。`input-manifest.json` 有 198 项（每侧 99 文件、零 hash 失败），唯一差异为 `src/usage-store.js`；baseline/candidate tree 分别为 `72C0CCA8… / 3635A1DA…`，包与 evidence benchmark 两侧同 hash。候选沿用已接受的 `StatementSync.setReturnArrays(true)` 原生数组路径，按固定 20 个位置映射，并在 API 不存在时回退原名对象路径；`candidate.diff` 为 `+38/-0`、SHA-256 `E56D893E…`，旧 A 卡单测 `1/1`、`156.0084ms` 已覆盖 native/fallback 与完整 summary 相等。

唯一一次固定顺序 baseline→candidate 的 `100,000` 行 separated-server 运行，两侧 exit `0`、stderr 为空；每侧一次 checked 加三次 `skipCheck`，四个请求均 HTTP `200`、`107900` bytes，`100000 / 256 / 6`、metadata `100000` 与五项 token 均等于独立 SQL oracle，每个请求各保留 6 个 missing source，catalog 始终为 `2026-10-01-824959549cbc`，默认 `120000ms` executor timeout 未 override。

| 请求 | baseline | candidate | Δ |
|---|---:|---:|---:|
| first checked | `1284.4739ms` | `1102.4538ms` | `-182.0201ms / -14.1708%` |
| skipCheck 1 | `41.1914ms` | `31.3776ms` | `-9.8138ms / -23.8249%` |
| skipCheck 2 | `38.6589ms` | `29.2268ms` | `-9.4321ms / -24.3983%` |
| skipCheck 3 | `31.0968ms` | `43.0506ms` | `+11.9538ms / +38.4406%` |

三次 warm 平均为 `36.9824 → 34.5517ms`（`-2.4307ms / -6.5726%`），但第三个 warm 样本回退，因此不能把 `-14.17%` 的 first 或 warm 平均写成稳定 p95/整站收益；first 仍含首次 executor startup/sync。完整 `payload`、`pricingCatalog`、`summary.costEstimate` 与 `summary.perf` 在四次逐位置对拍均相等；只按字段名规范化 `checkedAt / generatedAt / modelUsageAsOf / asOf / indexedAt / missingSinceMs`，其余业务对象不删。四份 normalized digest 同为 `7DA5A3D2…`。

`verify-pair.mjs` 只读取已落盘证据，断言输入 manifest、唯一源码差异、artifact hash、四次 oracle/timeout/missing-source、完整归一化 payload、catalog/cost/perf 相等、树内 result 等于 stdout 和共享 `benchmark-model-dashboard-attribution.json` 仍为 `B9747C13…`；实跑写出 `pair-verification.json`，`pass=true`。baseline/candidate stdout 分别为 `C0BFEFEF… / FDA83621…`，stderr 均为空，exit 均为 `0`。旧 A 卡 root verifier 在 Main apply 后其末条“baseline copy must equal frozen root”会按设计失败，原证据保留，不改旧断言。

命令：

```powershell
node output/history-retention-profile-20261026-cost-row-arrays-http/baseline/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --separated-server --events=100000
node output/history-retention-profile-20261026-cost-row-arrays-http/candidate/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --separated-server --events=100000
node output/history-retention-profile-20261026-cost-row-arrays-http/verify-pair.mjs
node --check output/history-retention-profile-20261026-cost-row-arrays-http/verify-pair.mjs
```

限制：只有一组固定顺序的合成 `100k` 请求，单次墙钟含主机/JIT/page-cache 噪声，warm 三次中一次回退；没有 1M、p95、20-process、并发、物理冷盘、真实来源、浏览器或整站验收，也没有重新生成百万源。`output/` 被仓库 Biome 忽略，因此新 verifier 只记 `node --check` 与实跑，不声称 Biome 覆盖。A 的永久 root 回归测试与 Main 根调用方回归、B 的 metadata 重复扫描候选仍未完成；待这些 gate 收敛后再冻结新的 million 源，`#19` 未关闭。

## C19-array-current-million

本卡结论为 **当前 root schema 21 与已接受 row-array store `AA047AED…` 的一次 1M separated-server 诊断完成；正确性与完整 payload 通过，但首次 `16.8861s` 未达 `10s/15s` 门槛，`#19` 保持打开**。只新增 `output/history-retention-profile-20261026-array-current-million/` 并更新本报告；live `src/`、`public/`、测试、共享 benchmark/结果与运行中服务均未改。冻结树含 `98` 个产品/包文件（`35 src + 62 public + package.json`），`FREEZE-root-before.sha256 == FREEZE-copy.sha256 == FREEZE-root-after.sha256`；product tree SHA-256 为 `BE144B66…`，`src/usage-store.js` 为 `AA047AED…`。运行使用已接受的三次 skip benchmark `C5077A1F…`；root 共享 benchmark 仍为 `E28DB4DB…`，override 已记录在 `freeze-manifest.json`。主审另写 `review-input-verification.json`，98/98、store 与工具 hash 均通过。

第一次启动在 Node 前因 card 相对输出路径重复拼接失败；第二次已正确启动但被操作者 Ctrl-C 中止，stdout/stderr 均为 0 bytes、exit `1`。两次都记录在 `launch-attempts.json`，不计产品失败。随后 Main 在**同一冻结树**接管唯一有效运行，日志为 `main-million.*`；本地只复核终态，不再启动或停止进程。有效运行 exit `0`、stderr 为空、墙钟 `248111.8971ms`；stdout/树内 result 均为 `970991` bytes、SHA-256 `B6CE4B47…`。

进程先后为 driver `83104` → seed `99940` → server `520672`；server parent 为 driver，seed exit `0` 且 `processExitedBeforeServerSpawn=true`。schema `21`，dataset 为固定 seed `0x5eed1234`、365 天、`1,000,000` events、`256` sessions、`6` homes、`8` models。health 为 HTTP `200`，create/listen 为 `2.9172 / 14.6576ms`。默认生产 executor timeout 保持 `120000ms`，没有 override；server-only 峰值 RSS 为 `171769856` bytes，PID 去重后仅 server `520672`，seed 排除。

| 请求 | HTTP | bytes | 总耗时 | catalog | 结果 |
|---|---:|---:|---:|---|---|
| first checked | `200` | `109446` | `16886.0761ms` | `2026-10-01-824959549cbc` | 含首次 sync；未达 15s |
| skipCheck 1 | `200` | `109696` | `13484.2612ms` | `2026-10-26-8802db5dfcf8` | scheduler 切 catalog 后重算 |
| skipCheck 2 | `200` | `109696` | `179.7285ms` | `2026-10-26-8802db5dfcf8` | 稳定 warm |
| skipCheck 3 | `200` | `109696` | `158.7762ms` | `2026-10-26-8802db5dfcf8` | 稳定 warm |

四次响应均完整保留，payload bytes 与 HTTP response bytes 逐次相等；事件/会话/home 与 metadata event count 均为 `1000000 / 256 / 6 / 1000000`。五项 token 在四次请求中均等于独立 SQL oracle：total `2526208168`、input `1642750198`、cached `656167060`、output `883457970`、reasoning `176040976`。每次均保留 6 个 missing source（`home-a` 至 `home-f`），`oracleEqual=true`。首次 catalog 与后三次不同，`skip1.catalogSame=false`、`skip2/3=true`；因此 `skip1` 的 `13.4843s` 不是稳定 warm，不能拿来替代首次门槛，也不能把 `skip2/3` 写成首次通过。

命令（仅由 Main 执行一次有效运行）：

```powershell
node docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --separated-server
```

限制：这是一次固定 seed 的合成 1M 单跑，不提供 p95/20-process/并发/物理冷盘/真实来源/浏览器或整站 SLA；首次包含 sync，`skip1` 包含 scheduler 切价目后的重算，`skip2/3` 才是稳定 warm。没有生产 patch，也没有把主机噪声归因于产品；后续由 Main 决定。`#19` 未关闭。

## C19-metadata-model-scan

本卡结论为 **metadata 模型列表复用候选功能正确，但唯一 100k baseline→candidate 配对未显示收益，保留负结果，不推广、不关闭 `#19`**。只新增 `output/history-retention-profile-20261026-metadata-model-scan-main/` 并更新本报告；live `src/`、`public/`、测试、共享 benchmark/结果与运行中服务均未改。两个运行树均取自刚冻结的 array-current-million 98 个产品/包文件，工具继续使用已接受的 `C5077A1F…`；baseline store 为 `AA047AED…`，candidate store 为 `DDEF8E5F…`，两棵 103 文件树除 `src/usage-store.js` 与各自运行结果外逐文件相等，candidate 唯一源码 patch 为 `+57/-39`、SHA-256 `D248D8A9…`。

candidate 只做两处最小接缝：把既有 D4 静态观测行初始化提前到 `metadataCache` 构建之前，并让模型列表从该已缓存行集合派生；非 cacheable/写事务路径仍执行原 `SELECT DISTINCT channel, model FROM events`，`metadataObservationCache` 形状与未来 `asOf` 过滤保持不变。功能验证 `verify-functional.mjs` exit `0`，三组核心断言均通过：完整 baseline metadata（含 future/alias/multi-home）、warm 零重扫且提交 revision 刷新、事务内完整 inventory 与 rollback 不污染 memo；query counts baseline/candidate 分别为 distinct `4/1`、unfiltered `2/2`、filtered `2/2`。baseline/candidate/verifier 的 `node --check` 均通过；`output/` 被 Biome 忽略，scoped Biome 返回 `1`（未处理任何文件），不声称 lint 覆盖。

唯一一次固定顺序的合成 `100,000` 行 separated-server 配对，两侧均 exit `0`、stderr 为空。每侧一次 checked 加三次 `skipCheck`，四次响应均 HTTP `200`、`107900` bytes；事件/会话/home 与 metadata event count 均为 `100000 / 256 / 6 / 100000`，五项 token 均为 `252603269 / 164368399 / 65763785 / 88234870 / 17585661`，catalog 均为 `2026-10-01-824959549cbc`，默认 `120000ms` executor timeout 未 override，每次各保留 6 个 missing source。完整 `costEstimate`、`perf`、`pricingCatalog` 与 missing-source 身份逐请求对拍通过；只规范化 `checkedAt / generatedAt / modelUsageAsOf / asOf / indexedAt / missingSinceMs` 后，四份 payload digest 均为 `3353885E…`，baseline/candidate 完全相等。

| 请求 | baseline | candidate | Δ |
|---|---:|---:|---:|
| first checked | `1310.4965ms` | `1386.2673ms` | `+75.7708ms / +5.7818%` |
| skipCheck 1 | `37.3710ms` | `38.0651ms` | `+0.6941ms / +1.8573%` |
| skipCheck 2 | `32.1006ms` | `34.3370ms` | `+2.2364ms / +6.9668%` |
| skipCheck 3 | `35.7924ms` | `55.9533ms` | `+20.1609ms / +56.3273%` |

三次 warm 平均为 `35.0880 → 42.7851ms`（`+7.6971ms / +21.9367%`），因此这次 ordered pair 不支持候选性能收益；首次仍含 sync/startup，单次结果受主机/JIT/page-cache 噪声影响，不能据此断言稳定回归。baseline/candidate stdout 分别为 `962297 / 962284` bytes、SHA-256 `7A159561… / DF4A9E1B…`，树内结果与 stdout 逐字节相等；`pair-verification.json` 为 `581A8810…`。

命令：

```powershell
node output/history-retention-profile-20261026-metadata-model-scan-main/verify-functional.mjs
node output/history-retention-profile-20261026-metadata-model-scan-main/baseline/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --separated-server --events=100000
node output/history-retention-profile-20261026-metadata-model-scan-main/candidate/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --separated-server --events=100000
```

限制：只有一次固定顺序的合成 100k 配对，首次含 sync/executor startup，warm 只有三个样本且候选后两次回退；没有反向配对、p95、20-process、并发、物理冷盘、真实来源、浏览器或 1M，也没有生产 patch。候选的功能通过不等于整请求收益；`#19` 未关闭。

## C19-model-suffix-single-pass

本卡结论为 **`longestSuffixKey()` 单遍扫描候选功能正确，但唯一一次固定顺序的 100k 配对没有稳定整请求收益，正式拒绝推广，`#19` 保持开放**。只新增 `output/history-retention-profile-20261026-model-suffix-single-pass/` 并更新本报告；live `src/`、`public/`、测试、共享 benchmark/结果与运行中服务均未改。两棵运行树各 99 个输入（35 个 `src/**/*.js`、62 个 `public/**`、根 `package.json`、冻结的 accepted benchmark），逐文件比对只有 `public/pricing-models.js` 不同；输入清单 SHA-256 分别为 `BFF04052… / A4A759ED…`，benchmark 仍为 `C5077A1F…`。产品差异仅为 `longestSuffixKey()`：baseline 的 `keys → filter → sort → [0]` 改成一次 `for` 循环选择最长匹配 key，没有新增缓存或跨请求状态。

Main 独立运行 `review-pair-main.mjs` 通过：99 输入中唯一产品差异为 `public/pricing-models.js`；两侧各一次 checked 加三次 `skipCheck`，四次响应均 HTTP `200`、`107900` bytes；事件/会话/home 与 metadata event count 均为 `100000 / 256 / 6 / 100000`；五项 token 均为 `252603269 / 164368399 / 65763785 / 88234870 / 17585661`；catalog 均为 `2026-10-01-824959549cbc`；默认 `120000ms` executor timeout 未 override；每次保留 6 个 missing source（`home-a` 至 `home-f`）。完整 payload、`costEstimate`、`perf`、`pricingCatalog` 与 missing-source 身份在只规范化 `checkedAt / generatedAt / modelUsageAsOf / asOf / indexedAt / missingSinceMs` 后逐请求相等，四份 normalized payload SHA-256 均为 `E89BC1FE…`。

| 请求 | baseline | candidate | Δ |
|---|---:|---:|---:|
| first checked | `1231.2102ms` | `1221.6202ms` | `-9.5900ms / -0.7789%` |
| skipCheck 1 | `31.9725ms` | `42.4370ms` | `+10.4645ms / +32.7297%` |
| skipCheck 2 | `36.0370ms` | `33.2626ms` | `-2.7744ms / -7.6988%` |
| skipCheck 3 | `37.5494ms` | `32.4392ms` | `-5.1102ms / -13.6093%` |

首次仅 `-0.7789%`；三次 warm 平均为 `35.1863 → 36.0463ms`（`+0.8600ms / +2.4440%`），方向混合。首次包含 sync/executor startup，单次 pair 受主机/JIT/page-cache 噪声影响，因此不能宣称稳定收益，也不允许追加择优跑。baseline/candidate stdout 为 `962291 / 962297` bytes、SHA-256 `DBB421D7… / BF4B81C8…`，树内结果与 stdout 逐字节相等；Main 的 `review-pair-verification.json` 为 `F3C64CB6…`。本地先写的 `verify-pair.mjs` 在 Windows 大对象 diff 时失败，已原样保留但不作为证据。

命令（唯一一次有效 pair，由 Main 执行）：

```powershell
node output/history-retention-profile-20261026-model-suffix-single-pass/baseline/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --separated-server --events=100000
node output/history-retention-profile-20261026-model-suffix-single-pass/candidate/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --separated-server --events=100000
```

限制：只有一次固定顺序的合成 100k 配对，首次含 sync/executor startup，warm 只有三个样本；没有反向配对、p95、20-process、并发、物理冷盘、真实来源、浏览器或 1M，也没有生产 patch。`#19` 未关闭。

## C19-cold-layout-separated

本卡复核既有 cold/hot 分进程布局证据并更新本报告；未重跑 benchmark、未启动服务、未改产品/工具/共享结果。工具窄审仍为：`benchmark.before.mjs` accepted `C5077A1F…`，`benchmark-model-store.mjs` `5ACB66C4…`，diff 仅 `+27/-0`；改动只在 separated seed 阶段新增 `HISTORY_BENCH_COLD_LAYOUT=1` 路径，用既有 `createHistoryArchiveCandidate → prepareHistoryArchiveCommit → createHistoryBackup → verifyHistoryBackup → commitHistoryArchiveEvents` 把早半 events 归档，并把 `archiveLayout` 写进 handoff/结果。产品 98 文件与冻结 `AA047AED…` 源逐文件相等，`node --check` 通过。既有 1000 条 smoke 由 Main 验证：冷 `514` / 热 `486`、1 个授权 segment、seed/server 分进程、schema 21，四次 HTTP 200 且完整 oracle 相等、6 个 missing source 保留、server peak RSS `169517056` bytes；`review-tool.json` 为 `1987AF86…`，`review-verification.json` 为 `3732CB95…`。

此前本地 Windows 沙箱的 100k 尝试仍保留为历史审计证据：exit `1`、duration `17047.8860ms`、stdout `0` bytes、stderr `2928` bytes，失败为 `HISTORY_BACKUP_FAILED: EPERM ... link ...`，发生在 `createHistoryArchiveCandidate → createHistoryBackup → publishFile`，即 seed 完成后、server spawn 之前，HTTP 请求数为 `0`。失败证据与摘要保留为 `cold100k.*`、`cold100k.blocked.json`（`D43E11AA…`）；独立 hard-link 探针同样返回 `EPERM`。这证明当时沙箱不能硬链接，不是 cold/hot 100k 结果。旧的 `review-verification.json` 仍记录 `cold100kBlocked=true`，属于本地阶段结论，不能覆盖下面的宿主运行。

主审已在宿主完成 100k cold/hot 运行。`review-cold100k.json` 为 `pass: true`，98 个产品输入未变；候选只改 `src/usage-executor.js` 与 `src/usage-store.js`。`review-cold100k-pair.json` 的 `completeBusinessFieldsEqual` 与 `moneyValuesRetainedExactly` 均为 `true`。基线布局为 1 个已授权冷 segment、`50,073` cold / `49,927` hot events（合计 `100,000`）；baseline raw SHA-256 为 `49538563eaa7204358a3229b6634258d86df47685b5b88963808940237f96c70`。

业务/目录边界：四请求的完整业务字段相等，金额值精确保留；基线目录为 `2026-10-26-787c2822fed3`，候选目录为 `2026-10-26-8802db5dfcf8`。候选四个请求使用同一目录，`catalogSwitched=false`；但基线/候选目录不同，因此这里只记录观测时间，不宣称严格的同目录因果加速百分比。

100k 宿主结果（4 个 HTTP 200、完整 SQL oracle 相等、保留 6 个 missing source、executor timeout 仍为默认 `120000ms`）：

| 运行 | first | skipCheck 1 | skipCheck 2 | skipCheck 3 | server peak RSS |
|---|---:|---:|---:|---:|---:|
| baseline | `20.218322600007057s` | `10.706964500069618s` | `16.610491900086403s` | `14.576015300035477s` | `1,054,306,304` bytes |
| candidate | `16.136333999991417s` | `5.894066900014877s` | `5.198574599981308s` | `5.107438400030136s` | `1,047,072,768` bytes |

baseline 原始结果：`output/history-retention-profile-20261026-cold-layout-separated/main-cold100k.stdout.json`（SHA-256 `49538563eaa7204358a3229b6634258d86df47685b5b88963808940237f96c70`）；候选原始结果：`output/history-retention-profile-20261026-dashboard-shared-carrier/candidate-cold100k.stdout.json`（SHA-256 `09f83c1d07d726ca6ae13bd3aaf3c0be9c09e157363549140db2f91f798c8a9e`）。主审执行的两条命令为：

```powershell
$env:HISTORY_BENCH_COLD_LAYOUT = "1"
node output/history-retention-profile-20261026-cold-layout-separated/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --separated-server --events=100000
node output/history-retention-profile-20261026-dashboard-shared-carrier/docs/validation/2026-10-22-history-retention/benchmark-model-store.mjs --separated-server --events=100000
```

Dashboard shared-carrier 变更已由主审窄范围提升（`3→1` 冷读）；root tests `11/11`，executor tests `19 pass / 1 skip`。这不改变本卡边界：只证明该固定 100k 布局下的四次请求与容量观测。

限制：只有一个固定顺序的 100k cold-layout pair；候选与基线目录不同，不能给出严格的同目录因果速度百分比；warm 只有三个样本，含主机负载/JIT/page-cache 噪声；100k server peak RSS 仍约 `1 GiB`（`1,047,072,768` bytes），未达到容量目标，不能宣称 capacity-complete；没有 1M、p95、20-process、并发、物理冷盘、真实来源或浏览器验证。`#19` 未关闭。

## C19-backup-stream-cold100k

本卡只复核已完成的实测，不重跑 benchmark 或测试，只更新本报告。三条核心断言：

1. **备份窄改等价且真实 tamper 被拒。** `src/history-backup.js` 唯一改动是 `tableFingerprint()` 从 `SELECT * ... .all()` 改为 `.iterate()`，并在循环内 `count += 1`；SQL、16 表集合、行顺序、列、`JSON.stringify(row) + "\n"` 和错误路径不变。宿主 `verify-backup-fingerprint.mjs` 对同一 fixture 的前像/候选逐表比较 16 个 fingerprint 字段，`{"tables":16,"fingerprintsEqual":true,"tamperRejected":true}`；真实修改一条 `events.total` 后，候选 `verifyHistoryBackup()` 以 `HISTORY_BACKUP_TABLE_MISMATCH` 拒绝。根 `history-backup.js` 与候选 SHA-256 均为 `ee40eafa147fe2068edd715528c79bc6057e51ae8c591090047bf3b184ca1f99`，`history-backup.before.js` 为 `053ffe2650555819927d7d5e951158fce691807104926ffafa653ca70c217d24`；Main 已窄推广，root 13/13（`5467.9969ms`）。

2. **100k 实测有效，但没有可靠计时改善。** `stream-cold100k.stdout.json` 为 exit `0`、`100,000` events、schema 21、seed/server 分进程、1 个授权冷 segment（`50,073` cold / `49,927` hot）、完整 oracle 相等、6 个 missing source 保留、默认 executor timeout `120000ms`；raw SHA-256 为 `d29442ef1e453635c7375997b2662c18a0ebcd086ff2af9186eb5f6c87306744`。first `17.798270200014114s`、三次 skip `9.009203700065613 / 6.439493600010872 / 5.191997600078583s`、server peak RSS `828,813,312` bytes。与历史基线相比，first 和 skip 方向/幅度不足以支持可靠计时收益；只能支持“减少一次整表行数组”和观测到的内存下降，不能宣称速度改善或 SLA。

3. **每个响应都与历史基线的完整 catalog 精确匹配，业务不丢。** 默认 scheduler 期间 catalog 切换，`review-result.mjs` 对每个新响应在 `history-retention-profile-20261026-cold-layout-separated/main-cold100k.stdout.json` 的四个响应中查找 `isDeepStrictEqual(complete pricingCatalog)` 的引用，再对同一完整 catalog 下的 normalized business payload 做深等；结果 `pass: true`、`products: 98`、`fullBusinessEqual: true`、`allMonetaryValuesRetained: true`，包含 uncertainty 与全部金额字段。四次 catalog 依次为 `2026-10-01-824959549cbc`、`2026-10-01-824959549cbc`、`2026-10-26-787c2822fed3`、`2026-10-26-787c2822fed3`；我已只读复核四次均存在完整对象精确匹配。`review-differences.json` 的 43 条差异来自旧的不匹配 catalog 诊断，已被最终 reviewer 结果取代，不作为验收证据。

关键证据：`output/history-retention-profile-20261026-backup-stream-cold100k/{review-result.mjs,review-result.json,stream-cold100k.stdout.json,inputs.json}`；16 表/tamper 证据在 `output/history-retention-profile-20261026-backup-fingerprint/{README.md,verify-backup-fingerprint.mjs}`。证据重放命令（本卡未运行）：

```powershell
node output/history-retention-profile-20261026-backup-fingerprint/verify-backup-fingerprint.mjs
node output/history-retention-profile-20261026-backup-stream-cold100k/review-result.mjs
```

限制：这是默认 scheduler 的一次 100k 诊断，catalog 在运行中切换，历史基线与本次的调度/前序 carrier 不同，因此没有因果速度百分比；只有一次 first 与三个 warm 样本，未测 p95、并发、20-process、物理冷盘、真实来源、浏览器或 1M。`#19` 未关闭。

## 最新门禁口径（2026-10-26 校正）

- PRICE 已明确释放全部后端锁，Main 为唯一共享后端 owner；不再把 PRICE 记为当前持锁。
- `#19` 最新实测为 all-hot 1M first `16.8860761s`；cold 100k first `17.798270200014114s`，skip `9.009203700065613 / 6.439493600010872 / 5.191997600078583s`。较早的 `38.6173085s`、`11.5892531s` 等仅为历史样本；不得把最新单次结果写成低于 `15s`，`#19` 仍未关闭。
- 最终工程门禁只先跑真正相关的窄回归，随后在整树 OS 内存硬限额下执行一次 `npm.cmd test -- --test-concurrency=1`；不先另跑两大分组再重复完整套件。schema21 边界保持不变。

## 交接

C0.1 已由主审独立运行通过。C0.4 的断言换行已按审阅意见改为单行，报告中的“排除 home / detail 混合”过时限制已删除。C1a 的 UTC 选日、C1b 的跨日原子重建、C1c 的完整区间查询、C1-home 的按 home 汇总、C1-stale 的事实失效、C1-read-snapshot 的读一致性、C1-local 的 JS 当地日界、C1-zone-transfer 的跨时区拒读、C1-DST 的 23h/25h 窗口、C1-session 的跨日/跨 home DISTINCT、C1-version 的旧缓存拒读/重建、C1-home-count 的跨日 home 去重、C1-nested 的外层事务/升级原子性、C1-dirty-UTC 的 UTC 脏日队列、C1-local-from-UTC 的保守当地日投影、UI-missing 的中英文 `role="status"` 提示、C-regression-contract 的 schema 20/精确表清单、UI-missing-API 的 summary→覆盖提示链、UI-full-missing-oracle 的真实反例、UI-full-first 的 full 先行统计保留与 UI-full-usage-scope 的两来源 `200→200→77→200` 均已由主审独立复核并接受。C1-format2-upgrade 的 v2→v3 已由主审独立复核接受（`1/1`，`146.9619ms`）；C1-detail-combined 已由主审独立通过 detail+v2 `2/2`（`165.3675ms`），接受模块但明确不代表主读/费用已接。当前 C1-detail-store-parity 已由主审独立通过 target `1/1`（`178.5053ms`）并接受；C2-model-day 已由主审独立通过 model+v2 `2/2`（`193.6503ms`）并接受，C2-model-range 已由主审独立通过 target `1/1`（`121.5805ms`）并接受，C2-model-range-store-parity 已由主审独立通过 target `1/1`（`163.2933ms`）并接受，C2-model-window 已由主审独立通过 target `1/1`（`135.6643ms`）并接受，C2-window-snapshot 已由主审独立通过 target `1/1`（`182.2696ms`）并接受；v2→v7、cached/reasoning 与组合 detail 字段已随 C1-detail-combined 模块接受，但不代表主读/费用已接。`src/usage-rollups.js` 已冻结供 B 接 model `periodAggregate`。C2-million-model-probe 已由主审独立复跑接受：同一脚本 cacheBuild `14940.16ms`、window 冷/温 `22.46/20.77ms`、raw `3585.72ms`，8 model × 16 字段精确相等；原 worker JSON 在 `benchmark-model-window-worker.json`，默认 JSON 为主审复跑数据。该窄 schema 结果不是整站或 cold-authority 测量，脚本已清理临时库。C2-million-store-probe 已由主审接受：worker 原跑 store 初开/重开 `26.07/2.06ms`、cache 重建 `25196.60ms`、window 冷/温 `27.24/25.81ms`、raw `5553.19ms`；主审复跑为 `25.81/1.88ms`、`23347.94ms`、`26.74/24.47ms`、`5549.35ms`；两次均与 raw 16 指标逐字段相等，DB+WAL 均为 `544,124,928` bytes。原 worker JSON 在 `benchmark-model-store-worker.json`，默认 JSON 为主审复跑数据。C2-million-process-probe 已由主审复跑接受：三个 process-cold `open/query` 为 `3.33/28.99ms`、`3.00/30.91ms`、`2.88/30.29ms`，三份冷输出与 10 次温读全部等于 raw oracle；温读 nearest-rank `p50/p95` 为 `21.8659/24.8107ms`，WAL truncate 将 `67,108,864` bytes 截为 `0`。原 worker JSON 在 `benchmark-model-process-worker.json`，默认 JSON 为主审复跑数据；该结果只称 process-cold，不是 physical cold disk。C2-million-dashboard-probe 已完成待主审复核：三次 HTTP 200 均与独立 SQL oracle 相等，首次 checked、第二次 checked 与 `skipCheck` 分别为 `191,523.06 / 144,626.34 / 121,897.32ms`，响应均 `83,083` bytes 并保留 6 个缺失来源；默认 `120,000ms` executor guard 已实际让首次尝试返回 `EXECUTOR_TIMEOUT`，成功数据依赖 benchmark-only `600,000ms` override，不能当作默认生产行为。后续接入 store 闭区间时必须使用 `endInclusive + 1` 转为半开端。UI-full-usage-oracle 的 `123` 单来源反例作为历史缺陷证据保留。UI-full-session-oracle 已独立复现 `0/1`、`5388.3654ms`，缺失态 tokens 正确但 `report.sessions` 只剩 `history-api-retained-session`，缺 `history-api-usage-session`；该反例已接受，`metadata.sessionCount`、`report.homes` 与恢复断言未执行。UI-full-quota-oracle 已加入单个原生 quota 观察的发布/删除/恢复对拍，并已由主审在 07:40 独立通过；此前缺失态 full 的 500（`store.publishedUsageSessions is not a function`）仅保留为历史中间态。












