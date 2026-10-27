# Q2 / Q3 投影复用施工计划

日期：2026-10-27。状态：v4 已实施，局部净收益与完整工程门禁通过，6 个真实浏览器周期及输入/清理验收完成；整体延迟与新鲜度目标未达，浏览器 p95 未验。基线为已推送的 `0cee6ce51814863dee8afd14fe222e0df10aaf5e`，承接[原计划 §13](2026-10-27-codex-incremental-visibility-and-tps-plan.md#13-12-后续结果与剩余优先级2026-10-27)。用户授权计划后自动实施，合计 RAM 8 GiB，暂不切生产。原始产物留本地；本轮产物在 `output/q2-q3-projection-20261027/`，验收在 `docs/validation/2026-10-27-q2-q3-projection/`。已有失败和旧分布保持版本归属。

## 1. 范围、基线和目标

Q2 解决同一 writer 在 no-op / ledger-only 后重新扫描 timeline 的等待。Q3 解决同步期间临时 published reader 的空投影槽。两者均保持当前 tokens、费用、TPS、coverage、状态、quota、metadata、periodComparison 和历史完整性合同。当前一次真实调用的 timeline 871 ms / perf 611 ms / periodComparison 420 ms 只作研究入口，不相加或承诺固定收益。

施工前浏览器控制 Codex 新文件/追加为 8,722 / 8,486 ms，ledger TPS 5,932 ms，仅作研究起点。v4 正常真实周期检查到帧：Codex 8,654–8,935 ms，ledger TPS 4,501–4,546 ms；浏览器 p95 未验，8 s max 与最不利相位新鲜度目标未达。Q2/Q3 可接受部分净收益，不以完整 3 s 目标作为单补丁唯一准入条件，也不凭 cache hit 宣称提速。完整 raw SHA、双 hash worker、发现/前后/发布校验、TPS 分母、60 s 检查频率和用户界面均不改。

不新增持久 schema、索引文件格式、依赖或常驻进程；不开放通用响应缓存，不自动纳入 N2、计价、归档或 UI 改造。

## 2. 入口与实际依赖

- `UsageStore.summarizeInReadTransactionCore`：动态 bounds、quota、范围、totals、comparison 每次读取；单槽静态投影目前混合 timeline/cost/groups/repositories 与 perf。
- `summaryProjectionKeys`：实例/派生修订、连接 total_changes/data_version、范围/时区/bucket/排除 home/details、service-tier、价目键集/版本/汇率。冷 authority 未验证路径不准进入热投影。
- `syncDerivedRevision` 与 `syncRound` 尾段：修订变化会影响其它派生缓存；不能只修改 summary key，遗留独立 metadata/period/quota 的旧输入。
- 用量静态部分直接或间接读 `events`、`source_files`、有效 service-tier / pricing 输入；quota 和 period 还读 quota/rollup/history authority。任何未知写入先保守失效。
- perf 部分读 perf samples、归属/候选/计时、状态、missing sources、warnings、indexedAt 等；本轮仍用原完整连接写入键判断其有效性，时刻/状态不并入可保留的用量部分。
- `usage-executor.js`：sync 建立 reader、`BEGIN` 后 SELECT 固定 WAL 快照，接着才启动 writer sync；dashboard 在 `publishedReady` 后选择 reader，finally 回滚/close/checkpoint。
- `HistoryQuoteInputs`：有上限、可 discard 的连接级计价输入。跨 reader 不共享它；Q3 移交的 reader 槽中不带 quoteInputs，重计价按已有 SQL 路径回退。

详细独立反例依据见 [Q2 合同](2026-10-27-q2-test-contract.md)；reader 快照/关闭合同见 [Q3 合同](2026-10-27-q3-reader-contract.md)。Main 在产品改动前核对这两份合同，冲突以保留事实正确性和最小可验证实现为准，不要求用户再次批准。

## 3. Q2 候选机制与失败回退

施工收窄：v4 在首次普通 hot 同步完成、既有 rollup 初始化之后安装 tracker；先通过 `syncDerivedRevision` 检查旧写入，再记录新的观察键。仅 open 未 sync 的实例仍在首个可缓存 hot all 查询惰性安装；open 只记录连接身份及初始写入数。这样从未预热 all 的 today/month/metadata 也不因例行写入重复重算。已有 tracker 发生 schema/TEMP 变化仍保守回退，不重新认证。`history_replaced_facts` 对普通 hot 用量投影也逐行扣除；任一 event/perf authority marker 行存在（包括空值）均回退原始完整键，冷 SQL carrier 不安装 tracker。此表的热用量依赖边界已由独立 reviewer 复核，不能外推到归档或备份。受控写事务内的读取不清共享已提交投影。

先用独立 SQLite 小实验验证逐行计数，而非先改缓存。保留原始 `total_changes()` 给 perf 完整键。为用量部分建立一个连接私有 TEMP 单行计数器；仅在已证明无用量依赖的 perf/timing 表和精确白名单 store_meta 键上创建 TEMP AFTER INSERT / UPDATE / DELETE 触发器。每次被排除的原始行恰增加一次 TEMP UPDATE，因此候选用量写入计数为 `total_changes() - 2 * ignored_rows`。必须用本仓 SQLite 版本实测，不把推导当结果。

这个规则按实际行计数：同一 perf 事务夹入的 events/quota/source_files/未知表写入、其它触发器及级联写入仍留在计数里。TEMP 计数随回滚恢复，而 total_changes 包含已执行写入，回滚可保守 miss；禁止按整个事务的开始/结束重新设置基准，也不按最后提交 reason 认证。

白名单由实际 SQL 路径逐个列明；不得用 `perf_%` 或所有 store_meta 的前缀规则。store_meta 的 INSERT 不扣除，避免 REPLACE 通过隐藏 rowid 删除非白名单元数据；正常已有行 UPSERT 仍走 UPDATE。UPDATE 改元数据 key 时，OLD 与 NEW 都必须在白名单内且 OLD.rowid=NEW.rowid 才能扣除，避免 UPDATE OR REPLACE 的 rowid 冲突删除。来源删除、历史 authority/revision、rollup、quota、未知键均不排除。TEMP 不改变持久 user_version / schema；在 open 的迁移之后安装，close/open 重建。

主/临时 schema 版本或计数器/触发器身份发生变化、算术不安全、数据库不是安装时连接，立即使用原始完整键并失效；不能因为插桩失效继续保留。`recursive_triggers=ON` 时 REPLACE 的隐式删除触发器会破坏扣除公式：每条触发器在实际执行时也检查该 PRAGMA，ON 期间的行不扣除；读取时 ON 再按完整键回退。验 OFF→ON→REPLACE/usage 写→OFF 的跨窗口反例，不能只观察两个读点都是 OFF。新 tracker 不安装到临时冷 SQL carrier；其路径维持已有行为。TEMP 的主表绑定显式使用 `main.`，避免跨 schema 意外重新绑定。

接入时拆开用量事实键、有效价目键和 perf 键。只有用量键及上下文匹配才复用 timeline/cost/groups；perf 键不匹配就重建 perf，返回本轮状态与时间。原始用量写入还必须让独立 metadata/period/quota/record 缓存看见变化。先保留它们原有修订失效，不为追求更多命中扩大本补丁。

Q2 单槽继续只有一份用量投影与一份可选计价输入，不累计每个修订。现有受控写事务内不读写共享投影，回滚后重建或命中旧已提交事实；手工事务反例要明确入口，不能把未标记写事务当普通已提交查询认证。候选若不能通过错误/回滚计数反例，放弃行扣除，回到保守 miss；再评估更小范围的子计算复用，不引入未经证明的代际。

计数依据：[SQLite total_changes](https://www.sqlite.org/c3ref/total_changes.html)、[TEMP triggers](https://www.sqlite.org/lang_createtrigger.html#temp_triggers_on_non_temp_tables)。特别检查 REPLACE 的删除计数例外、ON CONFLICT FAIL/ABORT/ROLLBACK/IGNORE、触发器执行顺序；任何规则失配先拒绝候选。

## 4. Q3 候选机制与失败回退

施工细节：连接打开时记录 `PRAGMA database_list` 的真实 main 文件及 realpath/dev/ino、初始 total_changes。接收仅服务新开的 reader，拒绝除 tracker 初始一行之外的本地写入；接收时再实际 SELECT 固定读快照，然后检查 source。构建时保存 strict data_version/连接/物理身份/resolver 守卫，捕获不能重新认证旧槽。仅 perf 重建也必须先匹配原 resolver；每轮仍加载 service-tier，只有不可变快照内容精确相等才保留 resolver 身份，内容变化即重建。executor 复制 evidenceInput，捕获引用在 writer sync 前释放。

最终 v3 收窄：事实复用一律继承原 guard，包括 `null`；只有新扫描事实且读事务由 store 自持时才取得新 guard。原始事务内的未提交投影，在 rollback 后不能通过 perf 重建或重新定价获得认证。已补实际反例，153 项定向回归及类型/修改文件 lint/格式检查通过，独立 reviewer 复核未发现新的必要阻断项。

只移交 Q2 已证明可保留的用量静态投影；TPS 在 reader 的真实快照重新读取。采用“捕获来源有效槽及守卫 → await reader.open → 固定 WAL 快照 → 再次核对来源守卫 → 深拷贝并以目标连接上下文建键”的顺序。

来源守卫必须证明从缓存构建到 reader pin 之间没有用量事实变化：来源连接的有效用量键、data_version、schema、数据库身份、连接存活与槽身份。前后检查都比较来源同一连接；禁止比较 writer 与 reader 的 total_changes/data_version 数值。外连接即使只改 events、不改 fingerprint/generatedAt，也必须拒绝旧投影。pin 后外提交可保守拒绝，不能放宽为只对比持久发布标记。

reader 的 homes、warnings、service-tier 输入在固定快照前取受保护副本；上下文和范围不一致时 miss。移交 payload 采用 structuredClone，`quoteInputs=null`，不能共享可 discard 容器或把来源缓存对象挂给目标。源槽关闭/失效不影响已接受的 reader 副本；reader 关闭不触碰 writer。价目/FX 变化时沿现有重计价/重建路径，不能复用旧费用。

捕获/校验/复制只为已暖的普通 hot all 槽服务，不在 sync 启动前主动执行一遍 dashboard 来制造暖槽。冷 authority、其它 DB、没有暖槽、未完成写事务、服务证据未对齐、关闭/更换连接、字段不完整、clone 失败均回退到当前 reader 计算；投影优化失败不得中止正常同步或隐藏真实查询失败。保持 releasePublishedReader 的错误处理与 WAL 回收。

只允许增加 UsageStore 内部捕获/接收方法及 executor 固定快照处的一次调用，不增消息类型、不改主线程 SQLite 所有权。若保护成本抵消收益，Q3 记录不入选，保留 Q2。

## 5. 多 subagents 卡片、依赖与文件所有权

主线程是唯一执行槽；最多两名 worker 加一名阶段性 reviewer。worker 只读/写所属文件，禁止自行启动 Node/npm/SQLite/browser。每卡必须附具体 diff、源码起点、反例、命令待执行清单和未证项；Main 独立运行并验收，worker 不自报“通过”。

- **P0 / Main**：提交推送现有成果（已完成 0cee6ce），记录新阶段基线/输入身份/资源账本，写本计划。独占主计划、验收 README、三个文档入口和本阶段 probes。
- **P1 / W1，与 P0 并行**：独占 `docs/plans/2026-10-27-q2-test-contract.md`；列 Q2 写入矩阵、现有夹具和独立攻击反例。Main 审核后归档。
- **P2 / W2，与 P0 并行**：独占 `docs/plans/2026-10-27-q3-reader-contract.md`；列 Q3 保护窗口、生命周期、冷回退和实测方案。Main 审核后归档。
- **A0 / Main，P0–P2 后**：独占本轮 `probes/sqlite-accounting.mjs`；验证行扣除和 schema 回退，测量额外写入成本。失败则裁定机制不入选，不给 worker 一份错误 API。
- **A1 / W1，计划及 A0 API 明确后**：独占新 `test/q2-usage-projection.test.js`；使用现有 perf fixture/小 SQLite 夹具编写独立 Q2 反例，不改 store 或旧 perf-store 文件。
- **A2 / Main，与 A1 并行**：整文件独占 `src/usage-store.js`，接入最小 Q2 tracker/分键和必要派生失效；独占 `test/perf-store.test.js` 中与新预期直接相关的既有断言。完整门禁发现的 `test/usage-store.test.js` 旧计数/回滚断言也由 Main 整文件单写；仍保留 no-op 身份与原始写正确性要求。新 helper 若必要先在 store，不能任意扩充通用框架。
- **A3 / W2，Q3 方法约定明确后，与 A1/A2 并行**：独占新 `test/q3-published-projection.test.js`；构造双连接 pin、外提交、关闭/discard、重计价与冷 authority 的确定性反例。
- **A4 / Main，Q2 正确性和短收益接受后**：继续独占 store，另独占 `src/usage-executor.js`，接入 Q3 捕获/接收；不按函数把 store 同时交给 worker。Q3 的必要计价回退优先复用现有代码，不改 `history-quote-inputs.js`。
- **R1 / 独立 reviewer，A2/A4 后只读**：查计数错误、状态复用、原始写与跨连接假证明、生命周期/历史回退。只返回可复现发现；Main 运行修复验证。
- **V1 / Main，逐卡后**：执行所有小测试与必要旧回归；修复产品只由 Main 完成，测试 worker 原文件继续单写直到归还。确认源码摘要后执行短配对，决定 Q2/Q3 各自入选。
- **H1 / Main，最终产品冻结后**：一次正式配对、一次最终门禁和一次有界真实浏览器周期核验；worker 归还测试文件后关闭，剩余 reviewer 只读。完成输入恢复/哈希、WAL 和测量 DB 清理，更新计划/报告/入口。产品变动后只重跑相关反例与受影响正式场景，不反复重启整套长测。

除上述文件外默认不改产品。若验收发现调用者必须调整，Main 先在账本登记路径和所有者；无需用户重复确认。任何整文件移交须先等旧 owner 停写并确认摘要。

## 6. 正确性验收矩阵

Q2 必须实际执行：

1. 暖 all → no-op 和真实 ledger-only：用量/timeline/费用等价，timeline 不再执行扫描，perf 的精确样本/coverage/状态/时间仍更新；当轮 dirty=0。
2. request-timing→perf 两笔提交之间插入同连接原始 events/quota 写入；summary、metadata、period、quota 均显示新事实，不能只检查总 tokens。
3. perf 或白名单 meta 触发器反写 events/source_files/quota；未知 meta、源删除、同线程删候选伴随 usage-delete 均使应变部分失效。
4. UPDATE 元数据 key 进出白名单、INSERT OR REPLACE、FK cascade、ABORT/FAIL/ROLLBACK/IGNORE、嵌套 SAVEPOINT、零行 UPDATE：独立读库事实与缓存摘要相等。失败 SQL 保留首个错误，不能被 tracker 覆盖。
5. 单连接受控事务内读取不污染共享槽，commit/rollback 后都正确；同连接 raw SQL 的独立缓存也检查。外提交不改发布 marker 仍检出；schema 改动、TEMP tracker 失效/重开、另实例不误复用。
6. 精确范围毫秒、日界/时区、excludeHomes、details、home/source 身份、service-tier、价目/汇率变化；保持当前 cold authority 路径和六条缺源保留事实。

Q3 必须实际执行：

1. 相同发布且暖 all：真实 executor 同步中使用不同 pinned reader，用量静态部分确实复用；TPS、动态范围/quota/status 读取 reader 本身事实。
2. cache 构建→捕获→await open→pin→接收各窗口中，来源自身 usage 写、外提交（含 marker 未变）、槽更换/源关闭都拒绝不成立的转交；不能只用两连接相同小整数证明。
3. reader 与 source 的本地计数刻意不同仍可在来源守卫成立时转交；相同计数但不同数据库必须拒绝。
4. 修改返回 payload 不污染来源；reader close/discard 与 writer 后续定价均独立。catalog/FX 改变必须得出精确新费用；不带 quoteInputs 的回退也验证。
5. 无暖槽、其它范围、details/context 不同、冷 authority、打开/复制失败、sync 成功/失败和双 tab；同步错误传播、reader 关闭和 WAL=0 维持。

独立参考优先冷读 SQL/未缓存实例及固定字面值，不能让两边调用同一新失效规则自证。逐 response/turn 的 TPS 精确检查复用上轮不同输出夹具，不能只用累计输出证明匹配。

## 7. 资源、测量和收益准入

跨实例时钟验收补充：metadata.generatedAt 逐侧严格等于该侧真实发布时钟，原值保留；顺序 A/B 的两个发布时刻不要求相等，其余 metadata 字段与完整 periodComparison 精确对拍。Q3 的 status.checkedAt/fingerprint 必须对应 reader pin 前的上一轮发布。summary 仍只忽略既定三个时钟字段，不新增业务字段排除。

默认路径补充：today/month 的 skip-check 暖查询不能代替默认同步刷新。另用从未预热 all 的独立实例，对 today/month 各做至少 3 对 no-op 同步＋dashboard 短筛，并记录 period cache 是否被保留；若发现新重复计算或退化，再修复/收窄并复验，不能用 all 已安装 tracker 后的命中掩盖它。

**8 GiB 是任务合计上限**。Main 唯一持有 Node/npm/SQLite/browser 执行槽。小夹具整树 Job 1,024 MiB、heap≤768 MiB；真实库、全仓和浏览器整树 Job 7,168 MiB、heap≤1,536 MiB，控制侧留约 1 GiB。统一 `scripts/run-with-memory-limit.ps1`，PowerShell 只用 pwsh。测试 `--test-concurrency=1`，浏览器最多两 tab；不得每 agent 各领一套预算。Node RSS 与整 Job 峰值分开，不测就明确未测。

沿用 `.codex-usage/refresh-latency-20261026` 的 seed/冻结来源，不打开 `tools/out` SQLite，不重冻结生产。前像从 0cee6ce 流式复制，after 每次正式前记录摘要；复制/DB/测量都串行。源写探针必须有外层 finally 运行现有精确恢复器，再核对 1,630 文件；最终流式 SHA 核对全部 1,633 输入及当前产品文件。出现超时/内存中止，先恢复核验再运行下一场。

先各做 3–5 对短测筛选，接受候选后最终各做至少 20 对 AB/BA。Q2 单实例同轮 no-op/ledger-only 的 sync、dashboard、合计分开计时；Q3 必须用真实 executor 的同步中请求，分别记录来源/reader 身份、命中、复制成本和整请求，不把直接 UsageStore 数据代替 executor。完整摘要只预先忽略 `generatedAt`、`perf.indexedAt`、`perf.meta.indexedAt`；metadata/period/quota 另作精确对拍。基线与 after 同输入、now、价目、时区；保存每对值和方向，不相减两个分布的分位数。

各候选准入要求：正确性反例全过、目标场景至少 15/20 对整请求更快、配对节省中位数至少 100 ms 且来源于目标计算减少；报告 p50/p95/max 和全部反向样本。today/month/all 暖读与普通追加作对照；若有持续退化，交错复核并保留两组结果，不能挑样本或静默合并。写入 tracker 额外成本也纳入 sync/追加计时，不能只测读端收益。证据不足则不入选对应卡，保持已接受补丁。

本轮浏览器保留真实 60 s 频率，Codex 普通追加、ledger-only 各 3 次，用于数值、接线和测量校准，不计算或宣称浏览器 p95 验收；记录写入、实际 tick、status/usage 请求响应、DOM、双 rAF 目标值、排队/busy，以及最坏写入相位。新鲜度仍为实际检查周期+5 s；3 s p95 / 8 s max 作为目标如实报告，超限不得以旧版本通过或缩短手动 tick 覆盖。另做 Claude/新文件/native+ledger/筛选/quota/双 tab 控制，控制不冒充子组 p95。

最坏写入相位另做 Codex 追加、ledger 各一次：等待真实 60 s 检查返回未变化并结束，再于 1 s 内写入，等待下个真实 tick。单列错过本轮检查后的写入等待、新鲜度超额和目标帧；不混入上述 3+3 正常周期，不改变实际轮询频率。有并发机器负载时保留原值和只读负载抽样，跨时绝对值不充当补丁收益。

最终一次 typecheck/lint/format:check 和全仓串行测试；控制器给足合理时间，原始失败/超时与续跑分开保存。最终检查 input SHA、六条缺源历史事实、WAL 关闭归零、所建 DB 清理和剩余进程。冷盘、实际冷归档、2×/4×、长期运行仅实际测过才写通过。

## 8. 完成、回退与交付

每卡标记 ACCEPTED / 待修 / 证据不入选，记录当前产品摘要、所有者、已运行命令/退出码/资源和未证项。性能未入选只移除本轮对应产品 diff，保留测试/失败证据，不回滚其它任务。Q3 可独立回退而保留 Q2；不以半成品 tracker 或单边 executor API 结束。

完成后交付：实现 diff、完整验收记录、原计划 §13 与三个入口同步、资源/输入/清理证据、剩余瓶颈。先前检查点已推送；用户现已要求提交并推送本轮代码、计划及必要验收资料；原始产物留本地，后续性能实验暂停，暂不切生产。

## 9. 施工账本（持续更新）

- P0/P1/P2：完成。检查点 0cee6ce 已推送；两个独立合同归档为施工前研究，本文与最终报告记录实际裁定。
- A0：SQLite 3.53.3 逐行计数初验 19 项通过；后续实际重现递归切换及隐藏 rowid 的三类碰撞，修正版三类均拒绝。旧候选、失败短对照保留，不写成最终通过。
- A1/A2/A3/A4：已实施。v4 Q2 新回归 20 项；Q3 新回归及子例 60 项；连同旧投影/增量查询/perf-store 与整份 usage-store，定向 205/205 通过。源代码、executor 与测试文件均已归还 Main 单写。
- R1：完成。除计数碰撞外，修复连续同步 resolver 变化造成的永久 miss，以及 perf 重建给旧 usage 重签守卫两项。只读 reviewer 复核未发现新的必要阻断项；运行结果由 Main 取证。
- V1：v4 正式准入完成。Q2 静止/ledger 各 20 对，40/40 完整摘要相等且合计更快，配对节省中位数 801/875 ms；Q3 真实 executor 20/20 接收且合计更快，配对节省中位数 1,492 ms。普通追加 20 对近中性（10 对更快，中位节省 −9.82 ms），暖范围各 20 对无持续退化。Q2/Q3 满足局部净收益门槛，整体目标仍由 H1 单独报告。
- 资源失败记录：Q3 第一轮失败断言展开大型缓存对象，1 GiB Job 中止；GC hook 无效。改用简短身份断言定位受控事务清槽后修复，原始失败保留。未将中止算成通过，也未扩大总 RAM 预算。冷夹具硬链接的沙箱 EPERM 已在同一 1 GiB Job 的隔离临时目录回归通过。
- H1 版本归属：第一组 Q2 正式静止/ledger 各 20 对，40/40 完整摘要相等、合计更快；后因上述转交守卫修正，作为旧候选证据保留。v2 浏览器主动停止于 11 周期（追加 6、ledger 5），输入恢复零差异，不作最终分布。随后以 v3 冻结源码重新执行正式配对、控制与完整门禁，其门禁失败和 v4 修正如下。
- H1 门禁修正：v3 全仓串行完整跑完 3,396 项（3,365 pass / 6 fail / 25 skip）；三项暴露未预热 all 的实际 no-op 缓存退化，另外三项为回滚保守 miss 与 SQL 守卫增加后的旧计数断言。默认 today/month 各 3 对复现约 1.8 s 额外重算，完整摘要仍相等；失败探针误用 all 总量的独立错误也保留。v4 修复首次 tracker 安装时机；回滚仍不推进修订、首次重建后必须稳态命中，periodComparison 改验实际聚合次数。新 no-all 回归加旧 store/投影/perf 合计 205/205 通过，已复测默认路径并重新冻结 v4 正式证据。
- H1 v4：typecheck/lint/format 与全仓串行门禁通过（3,372 pass / 0 fail / 25 skip），1,633 输入与 98 产品模块 SHA 全等。默认 today/month 各 3 对的 12 个单侧样本均保留两种缓存对象身份。最不利写入相位数值正确但新鲜度超额：Codex +7,308 ms、ledger +46 ms（单次观测）；它们不混入正常分布。最终 6 个真实 60 s 周期数值/TPS 全部正确、errors=[]、WAL=0；Codex 检查到帧 8,654/8,685/8,935 ms，ledger TPS 4,502/4,501/4,546 ms。正常周期未超实际周期+5 s，但不抵消上述最不利相位反例；浏览器 p95 未验，整体目标未达。最终 1,633 输入/98 模块 SHA 再验全等，7 个本轮测试库及附属文件已精确清理，无残留测试进程。重任务 Job 最大记录约 2.31 GiB，v4 全仓约 2.11 GiB，最终浏览器约 1.71 GiB；均沿用 7 GiB Job 加 1 GiB 控制预算。未切生产。


- 浏览器范围裁定：20 对正式 A/B 已证明局部净收益，完整工程门禁通过，最不利相位已经给出整体目标未达反例；本轮无需再花 40 分钟估计仍粗糙的尾部分布。正常周期收窄为每类 3 次，p95 明确未验。旧探针在跨 Node/浏览器时钟断言处失败，3 个已完成周期单独保留且不合并；新探针将实际 fetch 与同一浏览器内的同步 interval tick 绑定，并保存每次尝试。产品 v4 未变化，不重复完整工程门禁。

- 后续候选（按用户要求暂停性能实验）：恢复前不再追加测量或实施。若后续重新启动，先归因普通追加（本组同步/查询中位数约 8.56/4.31 s）和独立 perf（约 1.15 s），分开测 raw SHA/前缀证明、发布与变更后查询。只有瓶颈分解仍支持前缀方向才研究 N2；本轮不扩大产品改动，不切生产。最终数据和未证项见[验收报告](../validation/2026-10-27-q2-q3-projection/README.md)。
