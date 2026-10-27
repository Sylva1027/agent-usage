# Q2 事实依赖与投影失效验收合同

本文归档施工前独立研究，下面“未运行/待创建”指合同作者当时的状态。实际收窄规则、施工和 Main 验收结果以[主计划](2026-10-27-q2-q3-projection-implementation-plan.md)及其施工账本为准；不把旧候选反例改写成最终实现失败。

日期：2026-10-27。状态：**只读研究与待执行验收合同；未运行任何测试、SQLite、Node/npm 或浏览器，未实施产品。** 用户给定起点为已提交推送的 `0cee6ce`；本侧没有运行 Git 核验或写 Git。本文承接[现计划 §13](2026-10-27-codex-incremental-visibility-and-tps-plan.md)；后续 Main 对计数候选的收窄及运行证据见主计划，本文保留施工前研究口径。

本侧独占写集仅本文。产品、现有测试、旧证据、生产均不改；下面的新测试文件和探针路径均为**任务卡拟交付路径**，不是已经创建或通过的文件。Main 研究及实现机制，独立反例作者攻击机制，真实 reader 作者取证；所有运行交给 Main 的唯一执行槽，合计预算仍为 8 GiB，暂不切生产。

## 1. 本轮首先需要裁定的事情

Main 提交独立复核的候选是：perf 仍按原 `total_changes()` 失效；usage 投影改用 `K = T - 2C`，其中 `T = total_changes()`，`C = TEMP 单行 ignoredRowCount`。仅对已证明与 usage/timeline 无关的 perf/timing 表、精确 `store_meta` 键，安装 TEMP AFTER INSERT/UPDATE/DELETE 触发器；每个被豁免原始行恰 UPDATE 一次 TEMP 计数行。因此正常被豁免行对 `T` 贡献原始行 + 计数行共 2，对 `C` 贡献 1，`K` 不变。保留原始 usage/quota/触发器副作用，不按提交 reason 豁免，不滚动整事务 baseline，不改持久格式。

**静态否决条件已找到：`recursive_triggers=ON` 下 REPLACE 的隐式删除，能使 `K` 倒退，并抵消真实 usage 写入。** §5 给出独立 SQL 最小复现和真实 Store 版本；这是由官方计数语义推导的反例，尚未在项目所用 SQLite 上运行。不能用“REPLACE 仅多一次 miss”关闭：把它和真实 usage 更新组合后，旧 usage key 可以完全相等，而 perf 的原始 `T` 正常变化。

因此当前不能宣布 `T-2C` 已覆盖任意同连接 SQL。先运行这个小反例，再裁定是否有仍然最小、可证明的修正；无修正则保留现有 miss。此裁定不否定 TEMP 机制整体，也不预设要换成持久代际或通用 SQL 包装器。

未知手工事务里 `writeTransactionDepth` 未反映原始 BEGIN/SAVEPOINT，是已有写深度合同问题。本轮只做前后差异记录；**不把全面修复未知手工事务静默扩成 Q2 的前置条件**。如果新 key、缓存拆分或缓存保留扩大其影响，新增影响必须有反例、门禁和范围说明。§5 的核心反例全部使用自动提交，不依赖此旧问题。

## 2. 只读依据与当前结构

以下依据是本次读到的工作树；以文件和函数名为稳定锚点，行号仅作定位，Main 集成前重新核对实际源码。旧报告数值只说明研究动机，不是 Q2 已测收益。

1. `src/usage-store.js :: constructor / open / close`：`summaryProjectionCache` 是实例私有 all 单槽；另有 `metadataCache`、`metadataObservationCache`、`periodComparisonCache`、`quotaObservationCache`、`recordChampionCache`、`historySqlDashboardCache`。open/close 清理连接级缓存；`storeRevision` 可以跨重开保留，不能充当连接身份。
2. `UsageStore.summaryProjectionKeys`（当前约 11109）：factsKey 包含 store/derived revision、`total_changes()`、同连接 data_version、pricingModels 键集、service-tier 输入签名、完整 resolved range、bucket、规范排除集合、includeDetails；完整 key 再加价目版本和汇率。
3. `UsageStore.summarizeInReadTransactionCore`：先读 quota、eventBounds、解析范围；仅 all 且 groupingEligible 可缓存。当前单槽实际包含 timeline、timelineError、costEstimate、perf、channels/models、可选 homes/projects/repositories 以及 reader 的 repositoryPeriods。总量/comparison/quota 等在槽外。不能将“槽外动态”误说成其输入已有全部失效保护。
4. `UsageStore.commitStoreRevision`：仅累加实例修订并保存最后 reason，不记完整事务写集。`detectExternalCommit / readDataVersion`：检测其它连接提交并重载 generatedAt/fingerprint；同连接原始 SQL 不走这条检测。
5. `UsageStore.syncDerivedRevision`：修订前进后同时清 metadata、period、observation、quota、**整个 summary 槽**和 eventCostMemo。只替换 summary key 中的 T，无法跨 request-timing/perf 修订保留旧 timeline，必须同时交代这个清理入口。
6. `UsageStore.rollbackReplaceFileTransaction`：清 metadata/period/observation 并恢复产品写深度；不能据此声称所有直接 SQL 事务、所有候选新缓存均已有回滚卫生。
7. `UsageStore.importRequestTimingEvidence`：BEGIN IMMEDIATE → native links / evidence 导入 / dirty threads → COMMIT → `commitStoreRevision("request-timing")`。`publishMagpieRequestTimings`：候选及 dependencies/dirty/history-replaced-facts 和发布元数据同笔提交，之后 `commitStoreRevision("perf")`、`syncDerivedRevision()`。真实链是两次提交，最后 reason 不是写集。
8. `UsageStore.replaceFile / syncRound`：用量、quota 观测替换；Codex perf 发布可以同事务 DELETE source_files，提交后分别推进 perf 与 usage-delete；非 Codex 真删也删 source_files。已有 ON DELETE CASCADE 涉及 events、quota 与 perf 相关行。缺源保留不等于真删。
9. `UsageStore.perfSummaryForRange / capturePerfCarrier / buildPerfSummaryForRange / perfState`：perf 不只是样本统计，也含状态、缺源、degraded/partial 发布策略、method/indexVersion/indexedAt、warnings、unsupportedSources、排名身份及内存 homes。
10. `UsageStore.metadata / metadataHistory / readMetadataUsageCounts`、`periodComparison / periodComparisonHistory / periodAggregateCore`、`quotaObservations / quotaObservationsFromDatabase`：各自有独立缓存/快照入口。仅 summary 使用 K，不能兜底独立 metadata、period、quota 读。
11. `src/usage-rollups.js :: createUsageRollups / ensureCurrentRollupFormat / rebuildUsageRollups / queryUsageRollupsRange / queryUsageRollupModelsRange / queryUsageRollupModelsWindow`：持久事件触发器置脏 UTC 日期、移除覆盖旧/新事件时间的 complete marker；读侧有完整日与 raw fallback。一个 events UPDATE 的 T 增量未必等于 1，需按夹具证明。
12. `src/usage-executor.js :: handle("sync") / handle("dashboard") / releasePublishedReader`：同步前新建独立 UsageStore，BEGIN 后实际 SELECT events 固定已发布 WAL 快照；同步期间 dashboard 选择此 reader，结束 ROLLBACK/close，再回 writer。`dashboardHistory` 可能依次走 summary/metadata/period 或冷 SQL/完整 carrier，不能把普通 hot 的各组件承诺成天然同一个事务。
13. `src/history-quote-inputs.js :: HistoryQuoteInputs.append / finish / discard / events`：有 128 MiB 上限，discard 会清空可变容器。保留/转交投影必须证明 quoteInputs 完整性与所有权，不能共享一个可被对方 discard 的对象。
14. [上轮后续验收](../validation/2026-10-27-codex-refresh-followup/README.md)：真实 writer 的 ledger-only 已观察到 request-timing→perf、用量不变但 timeline 重算；原 R3 同连接交错只是静态候选反例。本合同不将这些文字变成已执行的 Q2 测试。

## 3. 依赖清单与豁免边界

### 3.1 usage 静态投影

- 直接事实：`events` 的 token/detail、timestamp、session/home、channel/model/project、repository 身份及计价字段；`source_files.path/kind` 决定 fused 来源分组。`timelineRange / costEventsForRange / groupedRange / repositoriesRange` 与 `createFusedSummaryGroups / createFusedSummaryRepositories` 必须逐项对应。相同总量、行数而 model/home/repository 改变也必须失效。
- 间接输入：`usage_rollup_daily / usage_rollup_days / usage_rollup_models / usage_rollup_sessions / usage_rollup_format / usage_rollup_dirty_days`，相关 local 时区标记；它们会影响 aggregate、period、metadata 的实际读法。默认不把它们当 perf/timing 表豁免；若不进当前 timeline，仍不能把它们从整个 dashboard 的依赖清单删除。
- 外部/内存输入：`homes` 的形状和 source kinds、serviceTierEvidence 及其输入签名、pricingModels 键集/模型解释、目录内容版本、USD/CNY、精确范围/时区/bucket、excludeHomes、includeDetails。SQL 计数不能代替这些上下文。
- authority 输入：`store_meta` 中 event/perf authority、revisions 及 `archive_segments` 会改变可用 reader/carrier 和 groupingEligible。一律不以 metadata 名义整体豁免。完整 range JSON、毫秒边界和冷门禁保持原义。

### 3.2 perf 与 timing

- `perf_samples` 是统计及排名身份的直接读表；`perf_sample_sources / perf_rollout_threads / perf_codex_projections` 是发布、归属与重建依赖，不能因当次 summary 没直接 SELECT 就省略发布正确性验证。
- timing 实际表为 `perf_request_timing_meta / perf_request_timing_evidence / perf_request_timing_threads / perf_request_timing_dirty_threads`；证据尚未发布时，不能提前把 lookup 结果当成已经发布的 summary TPS。
- `perfState / capturePerfCarrier` 读取的精确 meta 键至少包括 `perf_state / perf_degraded_home_ids / perf_source_warnings / perf_missing_sources / perf_codex_publication_policy / perf_index_version / perf_method_version / perf_indexed_at / perf_unsupported_sources`。这些是 **perf 必须失效** 的输入，即便允许它们不影响 usage key。
- `perf_file_fingerprints / perf_file_warnings`、timing published revision/publication seq、Magpie ledger fingerprint 是发布输入与状态线，按真实读写函数确认；不能仅凭 `perf_` 前缀加入 usage 豁免清单。
- 最小方案可以只拆出 usage 槽，perf 每次仍按原 T 重算/失效。不得借 Q2 强制新增 perf 精细代际；但 perf 的原 T 必须保持原始值，不能误接 K。

### 3.3 metadata、period、quota

- metadata：`readMetadataUsageCounts` 读 events/完整 UTC rollups 与 authority；`metadata` 还用 homes/warnings/generatedAt、events 的 channel/model/home/time 观测及 source kinds。未来事件按真实 asOf 过滤，不能把上次有效模型观测冻结。
- period：eventBounds、periodAggregate 的 events/rollups、模型解释、repository 形状、排除 homes 和 UTC/local 日历边界；`periodComparisonKey` 目前按日历日期等上下文区分，asOf 回包需当次更新。已验证 reader 的 repositoryPeriods 只是可选复用，不能跨日期强用。
- quota：`rate_limit_observations` 的规范原始行；`selectQuotaWindows / resolveDateRange / quotaRecordsForRange` 每次使用当前或冻结 asOf。source_files.kind 还影响 nonCodexHomeIds。5h、weekly、previous 周期和 reset 临界毫秒不能被 all 的暖槽吃掉。
- 对上述缓存有两种合法交付：本次仍保守清理并证明完整结果正确；或接入同样已证明的事实失效。不得只保住 timeline 而把独立缓存留在旧 revision 上，也不得为凑收益强制优化这三项。

### 3.4 精确豁免清单的交付格式

Main 为每个拟豁免表/键交：实际读函数、实际写函数、为何 usage/timeline 不消费、触发器的 INSERT/DELETE/UPDATE 条件、影响的剩余输出。UPDATE meta 若能更改 key，必须同时检查 OLD 与 NEW 的语义；只按 NEW.key 命中白名单会漏掉“authority 键被改名为 perf_indexed_at”。未列出的表/键/SQL仍按原 T 保守失效，不按正则前缀或提交 reason 推断无关。

## 4. 最小机制比较：只比较真正能满足任务的选项

1. **现有全槽 T + revision + data_version**：作为 before；能因本连接原始 DML 和 perf 元数据重写而 miss。代价就是 no-op/ledger 后重算 timeline。保留是合法退出，不能写成 Q2 已提速。
2. **删除 T、只按最后 reason、滚动 metadata 事务 baseline**：不入选。先 raw UPDATE events/quota，再完成 request-timing/perf 或 metadata，最后标签看不见先前写入；metadata 上触发器也可写 usage。加一个 usageRevision 但只在已知 API 路径推进仍有同一反例。
3. **完整事实表 TEMP 代际**：有希望覆盖普通同连接 DML 和触发器落地写入；它不需要 main 持久表/版本迁移，但必须覆盖真实依赖、外提交、DDL、rollback、生命周期。事务性 TEMP 代际可回退，不能把它包装成跨连接单调发布号。此项供比较，不替 Main 改选机制或写产品。
4. **最新 K=T-2C**：正常 I/U/D 可以省去无关写的增量，且保留 perf 原 T；但要求“每次 C+1 对应恰好 2 次被 T 计入的变化”。REPLACE、失败语句和跳过触发器正是攻击这一守恒式。只证明普通成功 UPDATE 正确，不足以接受该式。

候选 3/4 的 TEMP 对象可以临时落到 SQLite 的临时存储，不应宣称绝不触盘；承诺仅是没有新的持久 main 格式。TEMP watcher 无法观察其它连接的写入，必须保留同连接前后 data_version 检测；跨连接两个 data_version 数值也不能直接比较。[SQLite TEMP trigger 说明](https://www.sqlite.org/lang_createtrigger.html#temp_triggers_on_non_temp_tables)、[data_version 说明](https://www.sqlite.org/pragma.html#pragma_data_version)。

## 5. 对 K=T-2C 的最小反例与针对性探针

### 5.1 REPLACE 的静态最小完整反例：不使用手工事务

官方语义：total_changes 包括触发器和外键动作写入，但不包括 REPLACE 冲突删除；recursive_triggers 打开时，REPLACE 的隐式删除会运行 DELETE 触发器。[total_changes](https://www.sqlite.org/c3ref/total_changes.html)、[REPLACE conflict](https://www.sqlite.org/lang_conflict.html)。由此推导：一次已有 ignored 行的 REPLACE 有原始 INSERT 1、TEMP UPDATE 2、C 增量 2，故 `ΔK=3-4=-1`。再发生一次未豁免的真实 usage UPDATE（`ΔT=1`），合计 `ΔK=0`。

下面是交给运行槽的**完整独立 SQL 夹具**，不是本侧执行记录。它只验证计数恒等式，真实 Store 验证见下一段。所有建表、建触发器及 PRAGMA 均在 warm 点之前；三个 AFTER watcher 与候选结构相同。两次 SELECT 的结果由测试保存，不能为了存快照再向同连接表写入而改变 T。

```sql
PRAGMA recursive_triggers = ON;
CREATE TABLE events(id INTEGER PRIMARY KEY, total INTEGER NOT NULL, input INTEGER NOT NULL);
INSERT INTO events VALUES(1, 100, 80);
CREATE TABLE store_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO store_meta VALUES('perf_indexed_at', 'old');
CREATE TEMP TABLE q2_ignored(n INTEGER NOT NULL);
INSERT INTO q2_ignored VALUES(0);
CREATE TEMP TRIGGER q2_ignore_i AFTER INSERT ON main.store_meta
WHEN NEW.key = 'perf_indexed_at'
BEGIN UPDATE q2_ignored SET n = n + 1; END;
CREATE TEMP TRIGGER q2_ignore_u AFTER UPDATE ON main.store_meta
WHEN OLD.key = 'perf_indexed_at' AND NEW.key = 'perf_indexed_at'
BEGIN UPDATE q2_ignored SET n = n + 1; END;
CREATE TEMP TRIGGER q2_ignore_d AFTER DELETE ON main.store_meta
WHEN OLD.key = 'perf_indexed_at'
BEGIN UPDATE q2_ignored SET n = n + 1; END;
SELECT total_changes() AS t, n AS c, total_changes() - 2*n AS k FROM q2_ignored;
UPDATE events SET total = total + 7, input = input + 7 WHERE id = 1;
INSERT OR REPLACE INTO store_meta(key, value) VALUES('perf_indexed_at', 'new');
SELECT total_changes() AS t, n AS c, total_changes() - 2*n AS k FROM q2_ignored;
SELECT total, input FROM events WHERE id = 1;
```

待执行断言：`ΔT=4、ΔC=2、ΔK=0`，而事件值变为 107/87。perf 使用原 T 能发现变化，usage 使用 K 会与旧 key 碰撞。再单独测 REPLACE（无 events UPDATE），应看到 `ΔK=-1`；这说明不能把 K 当单调代际。数值断言必须由实际项目 Node/SQLite 版本确认后才标通过。

真实 Store 对应步骤：

1. 复用 `history-summary-projection.test.js :: event / insertEvent` 的结构，在独立数据库先创建 source/events；选同日事件，确保该日 dirty 已存在且尚未 build complete rollup。预置被豁免的 perf_indexed_at，设置 recursive_triggers=ON，安装候选 watcher，**然后**暖 all summary。
2. 原始 `UPDATE events SET total=total+7,input=input+7 WHERE id=?`；先记录这一步 `ΔT=1`，证明没有额外 rollup 写量。若实际不是 1，保留真实增量 d，再执行 d 次 ignored REPLACE，每次验证 `ΔK=-1`，得到等价抵消，不能硬改断言蒙混过去。
3. 原始 REPLACE perf_indexed_at；不调用 commitStoreRevision、不 sync、不修改 range/model/evidence/homes。断言 revision、derived、data_version 与其余 usage key 上下文不变，T 已变而 K 回到旧值。
4. 读取同 filters summary，与独立 uncached 参考逐字段比较；至少 totals 已是新值、timeline/分组/费用不得仍是旧值。若 key 碰撞使 timeline 未重建且不等，保存为候选真实失败。此反例不依赖 metadata/period/quota 的旧 raw-SQL 合同。
5. 同样条件下 recursive_triggers=OFF 作控制；再做 warm 时已经 ON 的情况，避免把“切换 PRAGMA 导致一次 miss”误认作修复。仅把 recursive_triggers 值加入 key，不能修复 warm 与 after 都为 ON 的碰撞。

还可将 events UPDATE 放进 `AFTER INSERT ON store_meta WHEN NEW.key='perf_indexed_at'` 的测试触发器，建好后再 warm；这样一次 REPLACE 就同时产生被抵消的 usage 副作用。不得依赖多个同事件触发器的未定义执行顺序。

### 5.2 FAIL / ABORT / ROLLBACK：不能将“抛错”当成“没有提交事实”

每种情况都记录 SQL 前后和事务结束后的 `(T,C,K)`、实际行、isTransaction，以及暖/强制 fresh 输出；产品手工深度不作为计数实验的替身。以下为待验证命题，**除 §5.1 推导外不预写 delta 已成立**：

- **FAIL 留存**：在 ignored 表上安排 AFTER trigger：先写一条真实 usage，再 `RAISE(FAIL, 'q2')`。catch 后直接读取数据库和 K；FAIL 可以保留语句此前修改，不能因异常把整个 statement 当安全 ignored。另测两行 UPDATE 中第二行 FAIL，确认第一行实际保留与 watcher 次数。若计数 watcher 的执行先后影响结果，分别隔离测试，不假设创建顺序保证运行顺序。
- **ABORT 语句回退**：同样副作用后改为 ABORT；事务此前另一条真实 usage 写仍可存在，当前语句回滚不应抹掉先前变化。对照完整 ROLLBACK。TEMP C 回退而 T 的行为需实测，允许保守 miss，不允许碰撞隐藏实际仍存的行。
- **显式 rollback**：产品已管理的写事务读不发布新投影；rollback 后无幻影，下一次成功写可恢复。特别记录 rollback 后一次正常 ignored 写是否有机会把 K 拉回以前的键；不能只验刚 rollback 后那一个 miss。
- **IGNORE / 早退**：ignored 表 BEFORE trigger 执行 usage 副作用后 RAISE(IGNORE)，以及多行 INSERT OR IGNORE。原始行未落地不表示触发器副作用不存在。AFTER watcher 未执行时应保留真实副作用贡献，不能按输入行数减计数。
- **出错后重试**：先 evidence 已提交、perf 发布 FAIL/ABORT，随后无新字节重试；对原两次提交分别留快照，不将已提交 evidence 回滚成旧值，也不提前发布 TPS。

FAIL 与 ABORT 对此前变更的保留范围不同；RAISE(IGNORE) 也不能被理解为撤销全部副作用。[SQLite conflict 算法](https://www.sqlite.org/lang_conflict.html)、[RAISE 语义](https://www.sqlite.org/lang_createtrigger.html#the_raise_function)。不要用 API 返回 `.changes` 代替 T 或推算实际 trigger 次数。

### 5.3 cascade、精确键与其它 SQL

- **外键级联**：真实 DELETE source_files，同时有 events、quota、perf/dependencies。对每张被删表实测 ΔT/ΔC；只有 ignored perf/timing 行及其 watcher 可以抵消，真实 usage/quota 行必须留下正的净变化。再测 perf_sample 删除的 dependency cascade，不能把父行和子行算漏/重复。
- **REPLACE + cascade**：分别覆盖 source_files REPLACE 与 ignored 父表 REPLACE；递归开关各一组，验证隐式删除、外键删除和 TEMP 计数分别是否进入 T。不能从普通 DELETE 的结论外推。
- **meta key 迁移**：在真实 authority 夹具上把非豁免键 UPDATE 成豁免键，再逆向；以及 DELETE+INSERT、UPSERT DO UPDATE。要求看 OLD/NEW 的实际业务依赖，不能以最终 key 判整次操作无关。
- **原始入口**：`database.exec` 多语句；prepared statement 在 watcher 安装前准备、安装后 run；`UPDATE ... RETURNING`（实际消费结果）；`WITH ... UPDATE`；注释/引号/schema-qualified 名称；通过 VIEW/INSTEAD OF trigger 落地到真实表。测试真实 SQL，不 mock commitStoreRevision 或手改缓存键。
- **等总量换维度**：两个 events 交换 model/home/repository，或改变 detail_mask/服务等级，行数与 tokens 总和不变；单独更新 source_files.kind。完整分组/timeline/费用必须变化，不能只验 totals。
- **未知表/未知键**：新普通表的 DML、未列 meta 键均保留原 T 贡献。允许 miss，不能自动加入白名单。再与 §5.1 的负 ΔK 操作组合，证明“未知写会留在 T”本身并不能排除抵消。

### 5.4 schema 与 TEMP 生命周期

- 安装必须在 open 的迁移/建表结束后，目标明确 `main.<table>`；重复 open、close/open 和两个实例互不沿用 TEMP C。仅比较两个实例 K 数值不具有发布归属意义。
- 对普通 CREATE/DROP trigger、ALTER/重建目标表、TEMP 同名表遮蔽、已 ATTACH 数据库的同名表、temp_store 改变导致 TEMP 对象消失分别取证。DDL 不一定推进 T；发现 watcher 不完整或绑定变化时，保守丢弃候选 usage 槽/回到原失效路径，不能默认 K 仍有效。
- 用户所说任意 SQL 首先指未经过产品写函数的普通 SQL；测试删除/覆盖 tracker、手改 TEMP C 是额外的机制边界探针，不冒充正常产品路径。如果方案要求保留对象完整性假设，必须明确记账；不能宣称裸 TEMP watcher 对可任意改写自身的连接有无条件保证。
- main/user_version、main 持久 sqlite_schema 在安装/卸载 TEMP watcher 前后应不变（先完成旧 open/migration）；不落新 main 表、索引、trigger、meta 版本，不改变归档/备份格式。这里比较的是 schema/格式，不要求真实业务写入前后 DB 字节相同。

TEMP trigger 的连接可见性、显式 schema 绑定与 ATTACH 生命周期见[官方说明](https://www.sqlite.org/lang_createtrigger.html#temp_triggers_on_non_temp_tables)；普通 schema 变更计数可用于观察，不能写 schema_version 伪造比较值。[schema_version](https://www.sqlite.org/pragma.html#pragma_schema_version)。

## 6. 必须执行的业务反例

以下逐项有测试名和通过条件；全部是待执行。cache hit、slot 引用相等、行数相等只能是辅助证据。

### Q2-RAW：同连接实际原始 SQL

先暖 usage/perf/metadata/period/quota。逐项实际写 events I/U/D、source_files.kind、perf_samples、quota 观测、精确/未知 meta；不手动推进 revision。记录写前后修订、T/C/K/data_version、目标输出和 fresh 参考。每次写入后分别先读独立 metadata、period、quota，再读 summary；另一次颠倒顺序，防止“先 summary 修复缓存”掩盖其它入口。对已存在的 metadata/period/quota raw-SQL 缺口保留 before 结果；新方案不得新增或扩大影响，不把 baseline 失败写成 after 独有回归。

通过：新 usage 槽不吞实际事实；perf 原 T 保护仍成立；同连接原始写入与触发器副作用反例实际运行。§5.1 自动提交碰撞是硬门禁。

### Q2-TIMING：request-timing → perf 与 ledger-only

使用本地可关联原生线程，先有 native 缺 timing；暖 all，再真实 `importRequestTimingEvidence`，保存中间已提交 evidence/dirty/lookup/publication 状态，然后实际 sync 发布 perf。另一路追加 Magpie ledger，经真实 `sync()` 走导入与定向发布。不要用 `commitStoreRevision("perf")` 替代真实链。

通过：同一轮精确更新样本 duration/output、n/TPS/p10/p50/p90、coverage/codexTimingCoverage、groups/models、indexVersion 与 published timing revision；usage 事实、费用和维度保持与参考相等；eligible/pending/dropped 语义保留。纯 ledger 且 usage 上下文不变时，后续同 writer all 请求**不再执行 timelineRange**；若目录费率变更，允许既有 quote replay 重定价，另记扫描量。只重用 timeline 的行数据但重新执行整次 timeline 不能计为同一项零调用收益。

### Q2-MIX：同轮混合 usage/quota 与 timing/perf

至少两组：native+ledger 同轮；在真实导入的 await/受控阶段点插入 raw usage 或 quota 写，再继续 timing/perf。阶段点须先证明确实命中目标函数，不能靠 sleep 猜时序。记录 request-timing、usage/usage-delete、perf 的每个真实成功提交，而非只记 lastCommitReason。

通过：当前 summary 与独立参考完整相等；usage 有变化必须失效，quota 当次读新观测；不能因最终为 perf 或 metadata 而保留旧 timeline。纯 ledger 的复用与混合写的失效必须分别证明。

### Q2-DELETE：真删、缺源保留与删源伴随 perf

独立 raw DELETE source_files（外键打开）与真实 sync 删除路径都要测。构造 Codex perf 发布同时移除一个仍承载 events 的来源；该笔完成后再发生一次 perf-only 提交，攻击“最后 reason”规则。另复用 retained missing paths 场景：磁盘缺失但历史行保留，与真删分开。

通过：真删后的 tokens/timeline/费用/分组/metadata/period/quota 与 candidates/owners/dependencies 全部一致，外键检查空；未变兄弟线程保持；缺源保留的历史事实不误删。六条真实缺源事实的验收沿用 Main 的隔离 seed 检查，不从小夹具外推。

### Q2-EXTERNAL：外提交与快照

第二个 DatabaseSync 实际 COMMIT，至少连续两次，分别写 usage、perf、quota/meta；另一次 ROLLBACK 无提交。保留 read 事务固定前的外提交、固定后的外提交两种确定性交错。两个 data_version 只在各自连接上比较前后。

通过：未固定快照的后续读能发现外提交并清理相关缓存、重载必要元数据；已固定的读按其完整旧快照返回，释放后再看到新值。外部 metadata-only 提交允许保守全失效；Q2 不要求识别外连接的精细写集。禁止为了保留 timeline 删去 data_version。

### Q2-ROLLBACK：管理事务和发布失败

复用真实 replaceFile 与 perf 发布失败注入，测试已读未提交数据不会写回共享槽；失败后不伪造成功 revision、不留下幻影行；恢复时无需新源字节。对 TEMP C 的全回滚、ROLLBACK TO/RELEASE 和 ABORT/FAIL 分别保存 delta，不能混称“都回滚”。

通过：产品既有写深度路径保持隔离、错误、retry 语义；新分槽和保留路径不使未提交内容逃逸。未知手工 BEGIN/SAVEPOINT 只按 §1 做 before/after 审计，新增影响必须修正或拒绝候选；不扩大到全仓事务 API 改造。

### Q2-DYNAMIC：metadata / period / quota 与上下文

1. 同范围 all now+1s；跨 UTC/local 日、周、月；空库首个事件与最后事件删除；范围毫秒改变；excludeHomes 等价集合与真实换集合、includeDetails 开关、bucket 改变。
2. 模型映射增删、目录同 checkedAt 内容变化、纯汇率变化、service-tier 签名变化、homes/warnings 与 generatedAt/checkedAt 更新。费率/汇率重定价继续使用完整 quoteInputs；容量耗尽保留流式 SQL fallback。不要把 perf_indexed_at 等 perf 输出时间冻结。
3. metadata 未来观测在 asOf 前后跨过事件时间，完整 UTC rollup、dirty fallback、authority 已存在与移除；metadata 应反映其输入和本次时间。
4. period 当天暖命中仍刷新 asOf；跨日重新解析范围；repositoryPeriods 冷 SQL 复用仅在其 key 仍正确时发生。费率/汇率只改成本时 period token facts 保留原义，模型映射或事实变更必须更新。
5. quota 独立 I/U/D 与 source cascade；resetAt 前 1ms/等于/后 1ms、5h/weekly、previous 周期、迟到旧观测、future/ambiguous、冻结 asOf。检查 range、records、quota state、percentStale、observedAt、plannedResetAt、duration 和排除非 Codex homes，不只比较 usedPercent。

通过：完整输出与参考相等；上下文变化不能通过 K 恰好相等误命中；today/month 与既有 all 的正确性及 SQL fallback 保留。不新增 UI 说明、徽标或常驻框体来补偿缓存边界。

## 7. 可复用夹具与具体文件归属

不为复用几个函数导出测试模块或重构现有产品；已有 test 文件内的私有 helper 不能直接 import。新文件按需复制很小的本地 seed 模式，复用已经导出的 test-support 夹具。下列“已有覆盖”仅表示读到测试代码，不表示本侧重跑通过。

- `test/history-summary-projection.test.js :: event / insertEvent`：最小 all-hot seed、timelineCalls/factBuilds/costReads/repositoryCalls、完整 fresh 槽对照、调用者隔离、模型/价目/FX/tier、quote 捕获耗尽。新 Q2 raw/计数用它的字段模式，不复制全部长测试。
- `test/perf-store.test.js :: makeWritableStore / registerSource / validRow`，测试 `E-1 all perf projection follows local/external revisions and bypasses uncommitted writes`：原始 perf UPDATE、状态/meta 改变、第二连接和写深度回滚，保护 perf 原 T 基线。该文件 Main 保持单写，W1 不插入修改。
- `test/usage-store.test.js :: d1MakeProjectLogHome / d1ExternalCommit / d1WarmCaches / d1DataVersion`：真实 project-log、两次外提交、产品替换回滚、close/open/frozen。D2/D3/D4 既有缓存测试负责 records、quota 原始输入和未来观测；Q2 补新增影响，不整体复制它们。
- `test-support/perf-fixture.mjs :: createPerfCodexIntegrationFixture`（可直接复用）；`test/codex-incremental-tps-visibility.test.js :: ledgerLine / appendNativeTurn / withStores / published / assertTimingSummary`：native-only/ledger-only/same-cycle、完整事实表、独立重建参考、发布 FAIL 后不增字节重试。私有 helper 按最小需求采用，不 import 会注册全部 tests 的文件。
- `test/perf-request-timing-store.test.js :: makeCodexStoreFixture / makeTwoHomeCodexStoreFixture / sampleDuration`：evidence 导入、thread links、dirty、双 home 部分失败、冲突/重复导入、发布 retry。作为真实 request-timing→perf 回归，不用 mock reason 替代。
- `test/refresh-sync-regressions.test.js :: publishedFacts / syncWithPlanningCount`：retained missing、return/rename、最终 metadata 失败与外提交/close。与真删反例并列，不能混同。
- `test/metadata-rollup-counts.test.js :: insertSource / insertEvent / rawCounts / metadataCounts / guardCountQueries`：完整 rollup、dirty fallback、authority 热范围。`test/usage-rollups.test.js`：事实触发器、外层事务、回滚、跨连接固定快照、local/DST，按改动触及范围选跑。
- `test/previous-weekly-quota.test.js :: observation / rangeFor`，及 `test/usage-store.test.js` 已有 quota/D3：实际 previous 7d/5h 周期、精确边界、延迟重启、冲突、稀疏日期、records。纯函数断言必须再有 Store 原始观测更新的接线测试。
- `test/codex-incremental-query-projection.test.js :: compareWithSql / fixture`：Q1 grouping 的 SQL 参考与实际冷 authority fallback。`test/history-period-price-invalidation.test.js`、`test/pricing-request-context.test.js`：价目/FX 与模型解释边界。
- `test/history-dashboard-sql.test.js :: fixture / components / equivalent`：实际 cold archive、verified reader、metadata/repository facts 复用、quote replay/损坏、外写时快照。`test/history-period-executor.test.js`、`test/history-metadata-executor.test.js`：真实 executor 与 cold authority。暖 hot 夹具不能替代它们。
- 已有真实探针：`docs/validation/2026-10-27-codex-refresh-followup/probes/reader-hook.mjs / reader-executor.mjs / reader-ledger-hook.mjs / reader-ledger-executor.mjs`。复制到新阶段目录适配，旧文件/证据只读；保留模块 URL/SHA、worker preload、reader 身份及阶段命中断言。

## 8. 可执行任务卡与验收顺序

### 卡 A：独立计数机制反例（W1，先行，零产品写入）

- 拟唯一文件：`test/q2-ignored-change-accounting.test.js`。本合同作者没有取得该文件写权；Main 派卡后由其明确 owner 创建。
- 输入：§5 SQL 和拟候选的触发器精确定义；用项目现有 `node:sqlite`/node:test，无新依赖，无额外真实库。
- 用例名：`Q2 accounting normal I/U/D`、`Q2 accounting REPLACE cancels a usage write`、`Q2 accounting FAIL retains side effects`、`Q2 accounting ABORT versus full rollback`、`Q2 accounting cascade and meta-key moves`、`Q2 accounting schema and reopen`。每条保留 T/C/K 与实际行值。
- 先跑 §5.1；反例成立即把候选标待修，后续验证修正版本。机制演示可以断言旧公式发生碰撞；**产品回归断言必须是输出正确**，不能把“证明 bug 存在”测试通过当成产品通过。
- 退出：交实际 SQL、版本/recursive 设置、完整 delta、失败/控制结果；没有运行权时交待执行，不自报通过。

### 卡 B：产品独立输出合同（W1，A 后，Main 供候选）

- 拟唯一文件：`test/q2-summary-projection-invalidation.test.js`。测试作者不写 store，Main 不并行写此新测试文件。
- 用例组：`Q2 raw SQL and trigger side effects`、`Q2 REPLACE key collision cannot serve stale usage`、`Q2 ledger-only keeps usage and refreshes perf`、`Q2 mixed usage quota timing`、`Q2 source deletion and retained missing`、`Q2 external commit twice`、`Q2 rollback retry and dynamic contexts`。对应 §6 全部场景，不要求每组变成一张小卡。
- 输出 oracle：小夹具使用确定字面 token/TPS 与独立 full rebuild；缓存对照使用另一份相同已提交事实和相同 homes/evidence/catalog 的隔离 Store，**不执行 sync 改写输入**。若原 Store 强制 fresh，必须旁路/清理所有相关派生槽，不能只清 summary 而保留 stale metadata/period/quota。
- 允许预先移除的字段仅 generatedAt、perf.indexedAt、perf.meta.indexedAt；这三项另外断言实际应更新或应冻结的语义。metadata、period 的内容/asOf、quota、warnings、详情不列入忽略项；同 now 的测试优先不删任何字段。
- 退出：所有新 hard counterexamples 与完整输出通过；记录 baseline 已有的 raw transaction/raw cache 问题及 after 是否扩大，不将其静默修进无关范围。

### 卡 C：最小产品裁定与实现（Main，整文件独占）

- 独占 `src/usage-store.js` 及 Main 明确接管的现有测试；先交精确豁免清单、K 守恒证明/反例处理、summary 槽拆分和 syncDerivedRevision/close/open/rollback 的全路径处理，再实现。
- 正常与异常 SQL 的证明不足时保留原 T 路径。不能只给 REPLACE 临时改用最后 reason、吞掉 SQL 异常、放宽发布或删除验证来通过 A/B。
- 原 `summaryProjectionKeys` 所有非 T 上下文守卫保留；store/derived revision 变化如何保留 usage、仍清 perf 与相关派生槽要明确，不能简单删两个 revision 分量。
- 保持既有返回形状、fresh 摘要、错误、TPS 算法、同步完成含义、轮询、归档格式。quoteInputs 生命周期跟随其事实归属；不额外加通用缓存层或持久追踪服务。
- 退出：A/B 与受影响既有测试通过，代码审查确认旧全槽清理没有让复用永远不可达，也没有把 perf/metadata 冻结。

### 卡 D：真实 writer / reader 探针（W2，只写新阶段探针）

- 拟目录：`docs/validation/2026-10-27-q2-projection/probes/`，计划新文件 `q2-reader-hook.mjs / q2-reader-executor.mjs`；证据输出由 Main 运行槽写到新阶段 evidence/private output。开始前由 Main 确认该整目录所有权，不能改旧探针。
- 输出逐请求：模块与 DB 身份、writer/reader 身份、发布点、cache 冷暖、T/C/K/revision/data_version 的**同连接前后**变化、timeline 调用/事实扫描/quote replay、perf capture/build、metadata/period、完整 dashboard hash/断言。
- 序列：首次 all、同上下文暖读、no-op sync 后、ledger-only 后、混合 usage 后、同步中已发布 reader、回 writer、now 推进/价目变化。默认刷新真实经过 executor，不用直接反复调用一个 Store 代替。
- 退出：实际少做 timeline 且 summary/metadata/period/quota/TPS 全对；探针需断言命中真实模块与消费点。插桩包含耗时不能相加；关闭探针再量净耗时。

### 卡 E：接受与最终门禁（Main，C/D 后，单运行槽）

- 先小夹具，后一次短配对；有净收益且全部反例通过才进入正式统计。A/B 同源、独立副本、相同 now/价目/时区/受控变更，交替 AB/BA，保存全部样本。
- 查询分别测首次、暖命中、no-op 后、ledger-only、真实新 usage miss；today/month 与既有 all 单独报告。计数抵消方案每行增加 TEMP UPDATE，需报告 sync 写入开销和 sync+查询净值，不能只量查询省时。
- 若接受产品变化，按现计划 §13 对普通 Codex 追加、ledger-only 各补至少 20 个真实 60s 周期；tokens 与 TPS 的可见文本跨舍入阈值、精确载荷和目标帧各自验证。不以 hit 次数、旧轮数据或小夹具外推真实收益。
- 定向测试后执行全仓单并发、typecheck/lint/format:check；记录首轮失败/超时和续跑，不能重写为一次全绿。最终测试清单按实际触及路径收敛，不为无产品变化的文档交付启动全仓。
- 退出可为 ACCEPTED、待修、按证据不入选。缺少明确净收益或完整依赖证明时，保留原 miss 并给出残余；不承诺固定节省毫秒或 G1/G2 已达标。

## 9. 后续运行命令与资源合同（本侧未执行）

所有 PowerShell 必须 `pwsh`；沿用 `scripts/run-with-memory-limit.ps1`，不直接运行 node/npm 绕过 Job。Main 从其已知环境解析 Node 绝对路径，不把 npm.cmd 当执行文件；npm 门禁使用 Node 的 npm 入口。示例是后续执行模板：

```powershell
$q2Node = (Get-Command node -CommandType Application).Source
$q2Args = @('--max-old-space-size=768', '--test', '--test-concurrency=1', 'test/q2-ignored-change-accounting.test.js', 'test/q2-summary-projection-invalidation.test.js')
pwsh -NoProfile -File scripts/run-with-memory-limit.ps1 -FilePath $q2Node -ArgumentsJson (ConvertTo-Json -InputObject $q2Args -Compress) -LimitMiB 1024 -TimeoutSeconds 300 -WorkingDirectory 'E:\12 AI\ccusage\codex-usage'
```

新测试文件尚不存在，不能现在运行模板。由 Main 分批加入实际受影响的既有回归文件；不在此重发全仓庞大命令。真实库/全仓/浏览器整树 Job 上限 7,168 MiB、Node heap≤1,536 MiB，控制侧约 1 GiB；小夹具 Job 1,024 MiB、heap≤768 MiB。每次只有一个运行槽，多个 agent 不各领一套预算；最多两个浏览器 tab，不并行复制真实 seed，不打开 tools/out SQLite，不重冻结生产。

记录进程退出码/超时/Job 限制/已测内存口径；Node RSS 不是整 Job 峰值。真实来源如有 overlay 由外层恢复并复核原始摘要，不能只依赖 JS finally。旧 evidence/probes 保持只读；本合同不授权切换生产、提交/推送或自动任务。

## 10. Q3 接口与最终通过条件

Q2 的单连接 T/C/K 无法作为 Q3 的跨 reader 发布身份。已发布 reader 的 T 起点、TEMP C、data_version、revision 和 service-tier unsynced 值都可能与 writer 不同；数值碰巧相同不是同一快照证据。Q3 先证明 writer 投影属于 reader 已固定的那次发布，再考虑复制不可变事实。

Q3 必须另跑：writer 预热后 reader 在发布前固定；writer 提交后 reader 仍读完整旧版；writer rollback；reader close/discard 与 writer 后续重定价互不破坏 quoteInputs；外提交及下一代 reader；真实 cold authority、缺失/损坏段、event/perf authority/revisions 分别变化。不共享会被 discard 的容器，不将暖 writer 测量当作新临时 reader 的收益。

Q2 接受必须同时具备：

- §5.1 的自动提交 REPLACE 抵消反例已实际运行，修正/回退后不能造成 stale usage；FAIL/ABORT/cascade/schema/未知 SQL 的数据与计数证据齐全。
- 精确依赖清单与安装/事务/失效/回滚/open/close 路径可审查；perf 原 T 与全部原上下文守卫成立，未加 main 持久格式。
- 真实 request-timing→perf、ledger-only、混合 usage/quota、删源/缺源、外提交和管理事务回滚全正确；独立 metadata/period/quota 及 today/month 未被新复用破坏。
- 真实同 writer ledger-only all 少做 timeline，有完整 dashboard 对拍和净耗时证据；新增 TEMP 写开销、失败样本、未测冷档/长期边界如实记账。
- 单槽与 8 GiB 合计预算、外层恢复、必要工程门禁和未切生产均满足。Q3 未证时保留 reader 冷槽，不为跨 reader 命中扩范围。

截至本文交付：以上均为**计划/静态反例**，没有 Q2 运行通过数、实测提速或生产验收结论。
