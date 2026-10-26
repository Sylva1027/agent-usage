# 历史保留：Implementation Plan 与三 worker 执行单

创建：2026-10-22；当前修订：2026-10-26。状态：**已按最新用户范围完成20项交付；性能保留参考目标的逐项差距**。

用户已授权主审编制本计划，并在实时监督下调度指定的三个 worker 并行实施。本文是唯一施工契约；[第二稿](2026-10-21-history-retention-plan.md)保留动机、历史测量和产品构想，发生冲突时以本文为准。状态、受测文件摘要、命令和主审裁定只记入[执行账本](../validation/2026-10-22-history-retention/README.md)。

## 0. 当前指令、进度与推进规则

**2026-10-26最终交付：已完成20/20，进行中0项，待开始0项。按用户“估计目标、适度优化、剩余性能由其他计划承接”的最新范围完成，不宣称原p95/SLA已达。最新源码全测试3272项：3247通过、0失败、25条件跳过（820882.954ms），此前17个资源受限真实浏览器用例全部实际通过；typecheck/lint/format均exit0，330输入前后零漂移。正式冷热百万实测首次14.887s、真实调价3.467s、稳定0.880/0.910s、health0.128s、服务峰值317288448B；逐项目标差距与未测范围见操作交付说明。未部署/迁移/重启生产，自动封存保持关闭，workers待命、无本轮后台基准/测试。**

**历史暂停记录（已被顶部最新收口指令覆盖）：2026-10-26用户提议暂停源码修改与测试，换模型先定位性能并留下方案。已结束本轮实跑，三位worker无施工窗口；后继直接读[性能接手点](2026-10-26-history-retention-performance-handoff.md)，不自动恢复旧派工或基准。固定进度仍18/20。**

**2026-10-26最新资源授权：用户明确允许测试使用7GiB DRAM。整树Windows Job提交内存上限现在可显式选7168MiB；小夹具仍默认1024MiB、主审统一串行，运行前Available≥8GiB，不并发放大、不提高到7GiB以上。此前1GiB触限记录保留；该授权不等于性能达标或生产操作授权。**

**2026-10-26用户新增内存约束：暂停10万/百万基准、全仓并发测试与全仓复制。2026-10-26用户重启后要求继续完成：先静态补Windows Job Object整树提交内存硬限制，验证前仅≤1000行小夹具且主审统一串行；运行前核对整机可用内存，子进程设堆上限并监视整棵进程树OS内存，低余量即停。未建立可靠OS内存硬限制前，不恢复容量实跑；不把Node堆上限当RSS上限。**

**2026-10-26此前用户要求：继续你的工作，把事情做完。** 计划整理已完成，先独立审查暂停点产物，再按§6释放必要文件和短卡；历史暂停记录保留。生产库提交、迁移、服务切换及自动封存未获授权。

固定口径：**已完成20/20，进行中0项，待开始0项**。1–18已有验收及限制保留，19按用户最新参考目标/停止追加优化要求完成容量验证与差距交接，20最终源码门禁与交付已完成；子任务、修复或测量次数不改变分母。整项达到§6完成条件并经主审独立验收才更新，回归可以退回。

2026-10-26用户在既有UI chat选择移除主页常驻历史归档框，UI线已完成；本线保留该最新决定，不恢复框体或将其当回归返工。第18项原renderer/浏览器验收保留受测版本边界，主页常驻入口从当前终验要求撤回；历史数据、CLI与HTTP操作继续保留。门禁期间四文件漂移导致的九条摘要失败，已在稳定源码下9/9定向复核通过，原受漂移/资源限制影响的整套仍未通过。

本次调整针对实际停滞：单点反例/探针过多，没有及时收成可用路径；旧状态和已完成队列混入当前计划；真实封存提交入口仍缺。以后从§6的交付出口选卡，每张注明对应交付项、剩余缺口、验收后解锁什么。已验能力不重复拆卡。

短卡保持一个行为、一个可审diff、1–3项核心断言，通常10–20分钟；15分钟交实物/失败，超过30分钟诊断依赖并收窄。**小的是单次改动，验收的是完整用户行为。** 红测、修复和独立复核属于同一缺口，连续返修沿用同一卡，不为每次校验另建编号。

并行最多三条有出口的支线：B的冷读/修订/提交，A的转移/CLI/API配合，C的页面或整站性能（两者选一）；主审审查、接公共调用方、管文档与真数据副本演练。每位最多一张在施卡。受共享锁或依赖阻塞时转到另一已就绪交付项或明确待命，不制造边缘测试填满人员。

当前独立审查结果与释放（2026-10-26）：

内存闸门最新状态：Windows Job整棵子树默认1GiB提交内存硬限额及900秒超时已Main独立小自检3/3，另整体超时exit124通过。运行入口为pwsh -File scripts/run-with-memory-limit.ps1 -FilePath node -ArgumentsJson JSON字符串数组；显式参数避免pwsh -File吞空参数。只放行Main串行必要诊断/门禁，worker不独立跑，100k/百万仍暂停。

2026-10-26后继放行：上述未建立可靠Job时的容量暂停，在整树超限/关闭清理均实际验证、当前10k完整oracle通过且宿主余量≥8GiB后，仅释放Main一次100k结构改动诊断；仍使用1024MiB硬限制、heap512MiB、180秒、同一既有工具和default scheduler。此次不是20组终验，不复制产品树，任何触限/超时保留失败并停止，不提高限额或重复择优；百万及20组仍未释放。

当前10k CPU不能解释既有100k暖请求4.2秒，Main只释放一次同100k输入的CPU归因窗口：复用原工具及第二次dashboard inspector hook，98产品hash绑定、不改产品；Available≥8GiB、串行1024MiB Job/heap512MiB/180秒，触限即止。目的只查真实规模下的主耗时，不是候选择优/容量验收，不启动百万或20组，也不根据小样本猜SQL/缓存改动。

上述100k归因已完成，完整oracle通过，服务峰值441MiB；第二次dashboard2.181s中union1.156s、summary0.766s，候选验证/原生取行/timeline分散占用。未改产品而计时较旧轮变快，不能声称优化收益。A准备串入旧卡且无实物，已停止待命；Main接管5事件SQL并集proof，两scope完整业务对拍/原事实及候选hash不变通过，目录仅在临时读投影对齐既有cold口径，货币仅既定1e-12尾差。SQL adapter尚未推广，缓存隔离、overlay、并发读快照未证。

当前已接受Main同事务候选读：withVerifiedHistoryBackup将新鲜全文件验证、候选校验和同步reader放进同一SQLite读事务，消除验证后再开连接的间隙。至多8份完整manifest/当前字节绑定的候选语义证明可复用；每次仍两遍完整文件SHA，WAL不复用。原69项闭包首轮66通过，三条旧第二连接注入改到共享事务首读前后4项定向（含新proof用例）通过，另native/perf反例2项通过，typecheck/Biome均0；不称完整仓库门禁通过。当前store a82b5746…、archive4895f3ef…、backup4d56edbb…，没有新容量数字。下一卡只接单段、无typed overlay/perf权威的SQL dashboard：保留完整字节检查、独立读侧缓存、并发发布/WAL释放，条件不符沿原完整并集。先小夹具与真实HTTP，不直接启动100k/百万。

最新覆盖状态：用户已恢复施工，当前仅事实/报价失效短卡在施，后面的暂停记录为历史交接。当前store582db005…、archive70380d53…、backup4cfaf173…；schema21与UI撤回主页框决定保持。最新一组1M正式冷热完整oracle通过，first18.976s、价目切换重算12.515s、稳定暖0.782–0.785s、服务OS峰值205967360B；first/切价目重算仍超限，19与20未完成。7GiB Job/heap512MiB串行，无运行中的本轮测试或基准。源码、真实前像、CPU瓶颈、验证及排除方案见性能接手点与账本，不把历史结果当当前全套通过。

- 15–18已按§6声明范围完成；schema22→21/index回退按用户要求保留，不恢复。当前schema21百万派生就绪诊断first20.288s、skip141.249ms；first仍超15秒上限，非p95/RSS全验收。
- 19：四维融合已推广；分进程百万诊断ready180.3443ms、first18504.9156ms、skip174.1000ms、server OS峰值164638720B，完整oracle通过但first仍超15s，非p95/冷热/WAL全验收。随后A period区间裁剪100k配对1442.804→1271.158ms、独立根专测通过并窄推广；B metadata有效UTC汇总计数100k完整payload相等、metadata312.940→202.622ms，已窄推广，主审根组合15/15通过，A接点及schema21保留。PRICE R09已独立43+1通过；server真实闭包39/39、backend真实闭包115/115后已窄合并交回，根历史再验6pass/1skip。新98文件冻结源million已独立核验：ready140.219ms、first12593.132ms、skip11233.472ms、server OS峰值192307200B，完整SQL oracle及98hash一致。默认scheduler在两请求间切价目，skip不是同价目warm；first仅低于15s上限且高于10s目标，skip超5s，19仍未过。C同价目归因1000/100k已主审独立接受：100k first1340.704ms、三个warm31.272/32.063/32.187ms，完整费用/价目/业务载荷相等，真实未切价目；不外推million。A SQL UDF候选因实际输入仅rollup组而非百万事件否决。B局部modelCount候选通过完整费用对拍但100k first1314.654→1315.463ms无收益，已拒绝推广。主审已接受当前100k SQL/CPU归因：timeline约1.26s、扫描active259ms，CPU样本指向原生行桥接/行转换。A原生数组行候选主审逐20字段/缺API fallback核验及小对拍1/1通过（156.0084ms），完整HTTP100k配对已独立接受：1284.474→1102.454ms，完整业务相等；数组窄推广root aa047aed…，六文件60/60及typecheck/Biome通过。A永久测试修旧Node fallback兼容，B metadata功能候选仅output；C独占当前冻结源一次1M/3skip诊断，默认scheduler保留。单对14.17%不代表million/p95通过。 最新数组后百万已独立核验：ready605.520ms、first16886.076ms，价目切换重算13484.261ms、稳定warm179.729/158.776ms，server峰值171769856B；完整SQL/费用/98hash通过但首次超15s，19仍未过。B metadata初稿回归未推广并停止；Main最小D4行复用候选功能三断言通过，仅output交C一对100k；A接1000条正式冷热smoke。
- 20：真实staging/恢复证据保留版本边界；两例全局tmp census并发误报已隔离，主审独立2/2接受。第三轮全仓3188项/3163通过/0失败/25跳过，272387.7492ms，当时静态三门禁均exit0。其后PRICE与融合窄改均定向通过；最新typecheck/lint0，其他UI线app/roles/skin测试格式差异仍待收口，不覆盖并行工作。20工程子门槛保留受测摘要，整项仍依赖19及最终新摘要门禁。PRICE pricing-store与period接点已交回。生产无写入/重启。

原automation入口不存在，未确认有后台定时监督。不得以“静默”推断后台持续施工；恢复后按实际worker状态和产物推进，监控恢复单独记录。

## 1. 交付目标与完成边界

交付一个能长期保留历史、能验证恢复、能从全量明细重建汇总、能将历史完整转移到另一实例的实现。事实保留、查询加速、明细分卷分阶段交付，不能用某一阶段通过代表全计划完成。

1. 源文件、整个来源目录或导入目录消失后，已成功发布的用量历史继续可查询；其他来源正常刷新。
2. 成功重解析可以纠正统计，但被替换的事实必须有持久恢复证据；不以旧、新两份直接相加维持“总量不降”。
3. 每轮写入完成、发布读快照关闭后，WAL 获得真实可完成的 checkpoint；外部读者受阻有明确诊断，不能阻塞刷新数秒或掩盖原异常。
4. 汇总切换前后，所有受影响的业务字段保持等价；小时、部分日、配额、UTC 与计价不能降精度。
5. 卷宗包含重建所需事实与来源身份；封存、恢复、导出、导入和缺失段查询均可验证，崩溃窗口不丢数据。
6. 在现有 PC 页面提供归档边界、展开和不可用状态，保留键盘操作、语言切换、冻结语义。

不增加依赖，不重写来源适配器，不扩展皮肤或模型速度 UI，不用永久跳过内容检查换性能。自动清理事实、压成唯一总数、后台静默接受破坏性重解析均不在设计内。

## 2. 当前证据与必须纠正的旧假设

- 2026-10-22 01:31 +08:00 只读基线：schema **19**，87,454 个 events；此前 01:30 采样有 45,786 个 perf_samples、1,115 个 source_files。活动数据会增长，施工验收重新冻结基线。
- 当时主库约 249.8 MB；相邻采样 WAL 39.5 → 49.0 MB。临时库四轮持有读快照均 checkpoint busy，关闭读者后 TRUNCATE 成功。`journal_size_limit` 不是活动 WAL 的硬上限。
- 15:47 恢复副本与本轮库相比，10-20 及之前每日行数和 token 总量相等；这不解释第二稿 08 点 93,977 → 84,029 的差额。没有原时点副本就记录证据缺失，不能无限复扫或臆断丢失/去重。
- 已用临时夹具证实 Codex 与 DSH 删除单个源文件后 events 被删除；不能继续写“只有非 Codex 会丢”。
- H3 的整轮路径/size/mtime memo 会吃掉同轮改写检测；保留读取前、读取后、发布前各自的新鲜观测。已有 S2/C2 接缝优先复用。
- 当前 GLM 分档反例：同组两条 input=1000、output=100 请求，分别计价 ¥0.0056；先求和再套价为 ¥0.0088。金额、pricedRecords、不确定性记录数必须分别验收。
- v18 已由 request timing、v19 已由 WorkBuddy 时长冲突观测占用。新迁移由 B 独占分配，从实际版本继续，不复用 18。
- 只搬 events/perf_samples 会漏 request timing 原始证据、原生关联、来源 kind 和有效 tier；只从热库重建又会漏已封存日期。

## 3. 人员、文件所有权与协作规则

保留现有工作区全部未提交内容；禁止reset、stash、整文件覆盖及把HEAD当本卡前像。写入前保存真实前像、SHA-256及允许接点，结束相对该前像审diff。历史临时移交留账本；以下是责任划分，不是一次释放全部文件。

- A（01a15f8b-d037-7da1-a572-02913fa68d9c）：archive/backup内核、CLI、executor必要接点和测试。与B共用archive helper时先移交文件再改。
- B（01a15f8c-74a9-7dd0-921f-9e85d35b1774）：唯一store/事实写入、修订、authority、热删除事务owner。迁移确有必要才分配，不为占版本加schema。
- C（01a15f8d-2156-7b91-8ef3-9a1ccc0cf3df）：归档renderer/i18n/相关测试，或固定源码副本上的整站性能。其他public/rollup/fixture接点逐卡释放，不同时维护多套fixture。
- 主审：server/API、公共core/types/pricing接点、计划与总账、独立验收及真数据副本。worker仅写各自A/B/C-report。

用户已授权协调既有TPS、PRICE两个chat；历史释放不等于永久独占。触碰共享源码/类型/迁移/parity前核对两线最新所有权与摘要，记录唯一owner、接点和释放条件，保留TPS/Magpie与PRICE等已有改动。其他线报完成不能替代文件已释放证明。

暂停期间不新增源码锁，已交源码保持待审；原写锁交付后归还。恢复只释放必要文件，主审不与worker并改。worker不访问生产写库、不改真实来源/账户文件、不启停正式服务。

统一pwsh。审批超时/硬链接EPERM与功能失败分开记；已授权隔离夹具可由主审宿主复核。审批超时仅重试一次，仍不可用就保留实物/阻塞，避免多人反复申请同一操作。

## 4. 先冻结的语义与接口

### 4.1 历史、当前投影与修订

`events` / `perf_samples` 是当前已接受解析结果，不把错误旧值永久累加进统计。事实保留包括可恢复的旧解析版本：来源缺失不等于用户删除历史，重新发现也不新增第二份相同事实。

首波 B0 解决来源缺失：保留最后成功用量、性能及依赖归属；将来源标成 retained/missing，标签和 kind 仍可解释。不用 failed/degraded 把所有历史从查询中隐藏，也不把 retained 宣称为本轮成功读取。物理源真实恢复并稳定验证后可正常更新，原生键去重。

B1 冻结修订存储形态前必须测两种最小实现的增长成本：保存每次全库快照，或只保存被替换/消失的规范化事实。选择**按内容身份去重、只保留被替换事实**，避免每次追加复制整份历史。可以直接使用少量 SQLite 历史表；不建立通用事件溯源框架。每份旧事实必须能还原来源身份、方法版本、原生身份和 payload；摘要排除自增 id、抓取时间等不影响事实的字段。相同旧事实反复遇到只存一份。

写入旧事实恢复证据与替换当前投影必须同事务提交；失败两者都回滚。普通追加不产生每轮重复旧版本。合法解析修订允许当前统计下降，但保留前值及修订原因；稳定但截断/坏行导致的缩水必须诊断，不作为无告警 ready 发布。`force` 不能绕过保全。

Codex 跨 rollout/线程需按原生样本键和依赖集合保留；部分文件消失不能删除仍需保留的完整旧样本，也不能将缺分母新样本当作完整替代。新 turn 仍应正常更新。压缩迁移、路径改名、同键修订分别测试，不能用“从不删除 source_files”一行代替完整去重规则。

冷区修订短卡契约（2026-10-23主审冻结）：复用store_meta的history_archive_event_revisions，JSON为{formatVersion:1,revisions:[{segmentId,databaseSha256,sourceIdentity,removed:[{payload,count}],added:[{payload,count}]}]}。每段/来源仅一个相对原不可变段的当前累计multiset delta；payload沿canonicalFactPayload排除id，只保存变化份数，不每次复制整个冷前缀。读union在同SAVEPOINT捕获，原段仍必须验证，authorized后应用、再过滤范围；错误格式/绑定/份数或不存在的扣除项必须明确失败。同源值修订、迟到新增与project-log非空纯删除已有账本所列独立证据；删除有持久缩水诊断，其他来源删除、混合迁移、全空与多段并发仍未支持。此处仅描述events，不授权perf/timing复用events载荷格式。

冷区纯删除短卡裁定（2026-10-23T15:09Z）：稳定合法重解析可投影下降，但任何冷identity消失须明确持久缩水诊断，不宣称可区分合法删除与意外截短。首卡仅effective的非空子集，混合新增/迁移/重复/全空仍拒绝；原段原值为恢复证据，overlay有效旧值沿既有恢复facts保全。 当前实现限定project-log；其他kind继续拒绝，不能无诊断放开。

### 4.2 WAL 与备份

A0 在 executor 内提供 checkpoint，store.open 的连接级 pragma 配置由 B 在 A 的明确接缝请求后接入。不得为此让两个 worker 同改 store。

- 正常和异常 sync 的 finally 先关闭 published reader，再尝试 checkpoint；首轮无 reader 也覆盖。
- checkpoint 使用短/零等待策略，恢复原 busy_timeout；读者占用只记录 busy/log/checkpointed 和耗时，不忙等、不掩盖原 sync 错误。
- `journal_size_limit` 每个写连接设置；TRUNCATE 的收敛性靠正确时点，不能只验 pragma 已赋值。
- 沿用 `node:sqlite` backup，禁止对活动主库单独 Copy-Item 当备份；完整备份包括最新已提交 WAL 内容。
- 输出先写临时文件，完成检查后原子命名；manifest 含 schema、程序/方法版本、价目摘要、事实/证据表清单与摘要。文件摘要放外置 manifest，避免自引用摘要。
- 恢复先在另一个目录/新进程打开并校验，不覆盖在线库；坏 manifest、缺文件、未知 schema 明确失败。
- 字节绑定证明只在同进程至多8份复用：backup与candidate每次仍新鲜完整哈希文件，且在同一个SQLite读锁内再次全文件校验；仅DELETE日志模式可复用此前同完整manifest/字节已完成的表/候选语义校验，WAL必须重新扫描。候选内容、schema、方法或manifest变化不能命中；同步reader在该锁内完成，异步reader拒绝并关闭连接。

### 4.3 汇总表与查询契约

C0 先提供事实夹具和旧读路径 oracle。C1 独立模块接收调用方传入的 DatabaseSync，不自行发现来源、打开真库或改 user_version。建议最小接口 `createUsageRollups(db)`、`rebuildUsageRollups(db, args)`、`queryUsageRollups(db, args)`；实际形状在 G1 固定，避免先写未使用的通用 query builder。

- 日粒度维度至少覆盖 home_id/home_label/source_kind/channel/model/project/repository_key、有效 tier、有效上下文档、输出价档/峰谷价档与 detail 状态。
- 不对 detail_mask 求和。各 known/inconsistent/reconciliation 统计按现有 CASE 结果预派生；事件计数与费用状态计数分别保留。
- session DISTINCT 保留“会话×日×实际出现的查询维度组合”；路径关系保留日期、home、仓库及排除条件所需维度，不能存一个全局 project→cwd 集合代替区间计数。
- 第一版仅切整日 token/计数路径与可证明等价的冠军；费用继续复用现有逐事件计价/memo，直到成本全载荷对拍通过。不得拿聚合行直接喂 estimateEventCost。
- UTC 与 local 日界分别支持；跨机导入以事实 timestamp 重新派生当地日界。部分日/配额窗口使用明细边界查询，整日中段可用汇总；小时桶保留精确路径。
- metadata 保存精确 MAX(timestamp_ms)，不能以 MAX(day) 近似；未来事件与模型活跃截止仍按既有规则。
- 同步维护受影响的**旧日期并集新日期**，包含删除/身份迁移/坏轮回滚；汇总与事实按同一 revision 原子发布，不暴露半重建状态。
- rollup_version 落后采用构建新版本后原子切换；冷启动不每次全量回填，失败继续读取完整旧版本/明细。
- 全量重建从**热区＋所有已登记卷宗**读取权威事实；缺失段必须失败并保留旧汇总，不能重建成不完整结果。

### 4.4 卷宗与转移

卷宗是可独立读取的 SQLite 文件及外置 manifest。必须包含 events、perf 样本及其原生依赖/版本、被替换事实恢复证据、request timing evidence 与 thread 关联、WorkBuddy 时长观测、来源元数据和有效 tier 证据；确属可重建的索引可以省略，但须证明重建输入齐全。

唯一权威副本规则：同一事实不能同时从主库与段重复计入；段以稳定 segment_id/事实身份幂等登记，导入顺序不改变查询。路径不能成为跨机原生事实身份的唯一分量。输出副本的 JSONL 不替代 SQLite 可重放载体。

封存采用明确两阶段流程，不依赖 WAL 模式下 ATTACH 跨库原子提交：

1. 在单写者执行器内冻结源 revision 与候选事实清单；新段用自己的事务写临时文件并 COMMIT。
2. 关闭写连接后验证各类事实逐行摘要、计数、token/样本统计和外键/完整性，写 manifest，持久化并发布最终文件名。
3. 主库短事务重新验证源 revision/候选事实集合，登记段并只移除已验证且将从段读取的热区副本，原子 COMMIT；revision 不符重选，不删。
4. 崩溃恢复区分临时段、已发布未登记段、已登记段；残留前两类不进入查询，重跑幂等。任何损坏最多留下可检查的多余副本。

归档依据事件/证据的逻辑身份和日期，不按一个物理文件整段拒收。跨界文件重解析只更新热区当前投影；已封存事实的修订进入可重放补充段或事务性修订记录，查询按明确版本择一。不能丢弃冷区修订，也不能让热区新增停止。跨文件累计 baseline 必须从热区＋冷区或单独可重建的累计检查点取得。

下钻通过独立只读连接访问段，不把主写连接设 query_only。摘要不符/文件缺失返回具名 HISTORY_SEGMENT_UNAVAILABLE 及受影响范围；历史汇总若沿用旧已验证版本必须明确明细不可用，不能假装当前重建成功。冻结快照绑定同一revision的热库和私有段副本。live段被移动时live读具名不可用，完整frozen副本继续原版本；只有snapshot自身副本不可用/过期时才报错，不把live文件状态混入冻结视图。

封存阈值沿用 ≥400,000 热区 events 且最老事实 ≥180 天，保留最近 180 天为初始热区目标；没有完整冷日期就不封存。阈值只管理驻留体积，历史保全从第一天生效。序号命名，不按自然年一次封存；段之间允许无事件空日期，验收的是逻辑时间区间无重叠与事实并集，而不是要求每天都有行。

CLI 在 A3 固定：`history backup`、`history verify`、`history export`、`history import`、`history archive` 的最小入口；沿用现有 CLI 帮助/错误风格。归档支持 dry-run 和明确输出目录，默认不触碰来源日志。若现有 CLI 语法更适合顶层子命令，由主审一次调整，不维护两套别名。自动封存在所有离线/隔离验收通过前不接入轮询。

### 4.5 冷区 perf/timing 权威、依赖与修订契约（W1）

当前已验能力与待施工边界如下；各次短卡前像/摘要/人员临时释放与测量保留在执行账本，不以旧短卡说明覆盖当前状态。

- 显式读取标记：history_archive_perf_authority={formatVersion:1,segments:[{segmentId,databaseSha256,sourceKinds:[kind],methodVersions:["tps-v2"]}]}。segments非空且唯一；每段kind恰好一个，仅zcode或codex。逐段绑定同一热读快照捕获的registry、event authority、数据库摘要及实际sample kind，四个基础verified perf组件齐全才读summary；Codex还须原生request事实及有效版本数值校验。组件gate与有效版本原生数值校验均已主审独立接受；这段只读标记不授权实际热删或自动封存。相同完整payload按sample_key去重，不同payload无显式修订则整读冲突。
- 来源组件：history_archive_perf_sources_v1={formatVersion:1,sources:[{path,kind,homeId,homeLabel,homePath,sampleCount,sampleKeysSha256,methodVersions}]}。有限ts范围样本按source归组；sampleKeysSha256为按sample_key排序数组JSON的SHA-256，方法去重排序。
- payload组件：history_archive_perf_samples_v1={formatVersion:1,startMs,endMs,rows,sha256}。有限范围完整原始列按sample_key摘要，header绑定表名/范围/列序。
- index组件：history_archive_perf_index_v1={formatVersion:1,startMs,endMs,tables:{perf_sample_sources:{rows,sha256},perf_rollout_threads:{rows,sha256},source_files:{rows,sha256}}}。绑定样本引用关系、原生owner和五字段来源身份。
- timing组件：history_archive_perf_timing_v1={formatVersion:1,startMs,endMs,tables:{perf_request_timing_threads:{rows,sha256},perf_request_timing_evidence:{rows,sha256}}}。按有限样本引用owner→home/thread→home/response取全部origin/variant，固定完整列/PK摘要；不按时间猜关系，不包含meta/dirty/projection。
- WorkBuddy组件：history_archive_workbuddy_observations_v1={formatVersion:1,startMs,endMs,scope:"referenced-homes",tables:{workbuddy_generation_duration_observations:{rows,sha256},source_files:{rows,sha256}}}。按bounded WorkBuddy events/samples引用home保守保存全部原始观察及身份，不猜ended_at，不裁热观察；legacy无home留热。它没有授予WorkBuddy冷summary或热删。
- 上述组件均在候选事务内写、verify同读快照重算。旧events-v1候选缺组件仍可验证events，但不授perf读取。已有native必要guard：bounded completed codex、explicit/request_e2e样本，owner存在但全无可解析raw timing evidence的关联时，create/verify精确HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_DEPENDENCIES_MISSING，不发布候选。无owner拒绝也已独立接受，全部匹配样本均须可解析owner→link→evidence。单response全部证据缺失且sibling证据仍在也已独立拒绝；原始候选的最小request事实数值校验已独立接受；应用overlay后的有效证据数值一致性尚未通过。
- 原生request事实施工契约：history_archive_codex_requests_v1={formatVersion:1,startMs,endMs,turns:[{sampleKey,sourceKind,homeId,sourcePath,threadId,turnId,model,requestSetComplete,requests:[{responseId,outputTokens}]}]}。从已持久原生投影经既有fold提取最小request事实，同候选事务冻结；不复制整projection或把其控制状态当authority。sample/response排序唯一，严格绑定sample_key/来源/owner及完整性。verify仅依赖此事实与已保存timing evidence/links，复用现有lookupRequestTiming和resolveCodexTurnRequestTiming核对completed explicit Codex duration/request_count；缺新组件的legacy只保留既有events能力，不能标native数值闭包完成。候选写入/验证已独立接受；typed overlay自动writer、单发布事务回滚及离线转移已有限定验收。有效overlay还须用同一事实契约重新核数值，B组件存在性gate报告仅待审。
- typed perf修订范围：history_archive_perf_revisions v1当前仅允许perf_samples和perf_request_timing_evidence；形状沿下文第4点，每段/表/五字段sourceIdentity一个相对不可变原段累计delta。完整列/类型复用PERF_SAMPLE_FIELDS及原生timing schema，NULL/0/reasonChain保持；未知表/字段、错身份、越界、移除不足整读拒绝。同热SAVEPOINT捕获，验证原段后应用delta。既有owner/response links不修订，新增evidence须有原关联。显式读取、Codex真实迟到writer、物理淘汰key重staging、具名发布失败/重试及完整bundle转移已独立接受限定行为；import raw timing先提交，不声称whole import+sync原子。有效版本数值RED与正式authority/淘汰入口仍须按§6收口。

以下是完整能力目标，仍未全部实现/验收。候选当前整库backup保留perf表、只裁剪events，不能据此证明完整依赖闭包或所有kind可淘汰。已支持的ZCode/Codex显式读取也不授权实际热删。

1. **同一发布版本。** events、perf样本、timing证据、WorkBuddy时长及来源身份共用segment目录与一次发布快照，不建立独立perf目录/后台切换链。既有event authority marker仅授权events；perf淘汰前须显式发布perf能力清单（段id/摘要、方法版本、各类事实数量/摘要及依赖闭包），与events选择、修订和热副本删除同一主库事务提交。旧v1段没有该能力时仍可读events，perf只能保留热路径；不可把已有event授权自动升级为perf授权。
2. **事实与依赖闭包。** perf归属按有限ts_ms的[start,end)及现有原生sample_key确定，不能仅由events来源反推。manifest来源清单覆盖样本、timing、时长引用的全部home/kind/原生键及source关系，包括没有events的来源；保存完整PERF_SAMPLE_FIELDS、NULL/0区别、methodVersion、flags/原因链及perf_sample_sources等所需关系。request timing evidence/thread关联与WorkBuddy时长观测按引用关系随样本入段，跨边界依赖可重复保存但按各表既有原生主键去重；其共享热副本只有在无任何热事实引用且冷副本可验证时才允许删除。ts_ms为空的unplaced样本及无法证明闭包的候选/依赖首版留热，不猜日期、不丢coverage分母；包中须列明这些保留事实。
3. **合并与失败。** 完整carrier在同一热库读快照捕获registry、能力清单、overlay、热样本/依赖和发布状态，再验证冷段。样本以现有sample_key为键，连同home/source/method身份校验；跨home同键冲突不得擅拼新key掩盖。相同事实重复副本只计一次，权威冷版本及其修订覆盖同键旧副本；同键冲突无明确修订、依赖缺失、段损坏或未知格式须整体失败，不能返回热样本部分结果。统计复用原buildPerfStatsBlock/selection，分位数从有效原样本重算；不得均分或平均各段TPS/分位数。来源missing只改变可用性说明，不抹掉有效历史，kind保持原始来源语义。
4. **修订形态。** 复用events的“不可变原段＋相对原段累计差分”规则与校验/保全算法，不把perf payload塞进events-v1 JSON。保留history_archive_event_revisions v1；perf及原生timing/时长使用专用版本化history_archive_perf_revisions v1，形状为{formatVersion:1,revisions:[{segmentId,databaseSha256,factTable,sourceIdentity,removed:[{payload,count}],added:[{payload,count}]}]}。factTable只允许本卡明确列出的样本/依赖事实表，原生复合主键、完整列和schema约束沿各表现有定义校验，禁止动态任意表名。每段/表/来源仅一个累计delta，不逐轮复制整个冷前缀；原始段中的旧值由段保全，曾被overlay覆盖的旧有效值沿history_replaced_facts保全。timing脏队列/投影及发布revision属于控制状态，从选中的完整证据重建后一起发布，不作为跨代可随意相加的事实。迟到timing导致已有冷样本重算时，证据delta、样本delta、旧值保全、dirty/缓存失效及发布标记同事务。尚无支持的kind/修订形态明确拒绝并保留旧事实，禁止静默接受；不得将有诊断的缩水宣称为已确认用户主动删除。
5. **转移与门槛。** 完整bundle/export/import、freeze、重建都携带上述能力清单、两类overlay、旧值恢复证据与原生依赖；导入后不依赖原home或本机外部数据库。修订或段清理不得丢这些元数据。先以独立source-SQL oracle验证进段逐列保真，再逐卡验证冷热重叠去重/不同payload冲突、perf-only来源、跨界依赖/unplaced、迟到timing修订、真实提交前失败与retry、缺段整体失败、离线转移重算。已有reader测试的candidate-SQL oracle只证明reader，不证明source到candidate完整性。实际支持的kind/方法逐个登记；未支持候选保留热副本，不能标第15/16项完成。

## 5. 已验基础与当前基线

原A0/B0/C0、A1/B1/C1等阶段号只供追溯，已完成内容不再进派工队列；原阶段文本保存在2026-10-25修订前像，实际裁定在账本。恢复只从§6选卡。

1–14涵盖缺源保留、旧事实保全、截短/坏行诊断、WAL、backup/verify/restore、价目/tier冻结、汇总维护/模型读取、候选/登记/完整bundle与离线CLI。集成边界仍须20统一核验，旧绿结果不能外推任意新源码。

源码当前：CLI已有显式events-only commit入口，先验证候选并创建/校验新完整bundle backup，再复用executor单写者事务；原dry-run默认400k/180天不变。正式perf淘汰仍缺，不能据events入口宣称15完成。GET归档目录/sealed UTC日/有界明细及完整bundle导入均已接真实HTTP并接受，显式导入实例保持包内计价/tier；既有/api/imports仍是来源目录管理。PC多段年份带与逐事件下钻真实browser已接受。显式perf只覆盖受测ZCode/Codex范围，不能据此删除其他kind或不完整依赖。

复用现有真实fixture、node:sqlite backup、发布事务和原生timing resolver；不重造全能fixture、第二套registry或任务框架。缺少用户行为时补一个小型测试。worker报告均待主审独立验收。

恢复第一轮先审A/B/C现有产物，登记确切源码基线与失败归属，不先跑全仓或全部百万基准。

## 6. 剩余六项的完成条件、依赖与顺序

这是交付地图，不能整节派工。新发现的正确性缺口须说明阻挡哪条完成条件；可选特性单列。一次复核不通过就返回具体缺口，保留已过证据。

### 6.1 第16项：有效版本、跨冷热累计与修订闭环

本项已于2026-10-25按已声明events修订与ZCode/Codex tps-v2范围接受；原段验证→有效证据→原生数值→完整公开统计→具名失败重试→转移/重开已有独立证据。范围外行为继续拒绝或留热，whole import+sync不宣称跨事务原子。

- gate与有效overlay原生数值校验已独立接受。Codex同一路径物理样本淘汰→迟到timing修订→完整公开events/费用/perf→移走原来源转移→重开不翻倍已过；A现收口ZCode完整公开结果与no-op/reopen，不另起存在性guard系列。
- 后继用同一真实来源完成边界后的新增/值修订、迟到timing更新；累计baseline含冷前缀，旧有效值保全，no-op不重复保存。未支持的身份迁移/破坏性删除明确拒绝并保留旧值，已支持project-log删除沿现有诊断契约。
- 收口独立对照events与完整perf/coverage/费用，覆盖物理热sample删除后更新、确切发布COMMIT前失败后同store重试、移走原来源/段路径的新runtime重算。已有rollback/transfer证据复用，只补新接线影响面。

**完成条件：** 声明支持的kind/方法从公开路径等oracle；有效样本与原生证据数值一致；旧事实可恢复、失败无半发布、同步/重开不翻倍。组件存在或元数据形状不能替代此条件。

### 6.2 第15项：正式封存提交与热区淘汰

本项已于2026-10-26按以下完成条件及已声明纯ZCode、Codex tps-v2显式计时范围独立接受。正式CLI热删/并集等价、保护事实、具名依赖级联回滚与重放均通过；未支持/NULL/段外留热，legacy仍可events-only提交及重放。任意kind、并发及崩溃全部窗口不在已验声明内。

- 提交准备卡：扩既有dry-run，固定revision、完整日范围、各类保留/搬移事实数量及多重集摘要、原生PK删除集合和已verify候选；自身不改热事实，单范围/候选起步。
- 提交行为卡：B接单写者事务，重验revision/事实集合/段摘要，同一主库事务登记、选择authority、删除指定热副本并失效相关dirty/revision。源变化取消；失败保留旧完整读，成功才返回结果。A先交还共用helper文件锁。
- 入口接线卡：A将同一实现接executor/CLI显式commit；候选/verify/新backup后提交，自动封存关闭。测试经正式入口，不能手写authority＋DELETE冒充提交路径。
- 初版仅搬移能证明冷读等价的events与受支持ZCode/Codex样本；unplaced、不支持kind/方法、无法证明闭包的事实留热。跨界共享依赖保守留热并列清单，热删依赖另须无热引用及冷副本完整证明。完整包仍带齐重建事实；不承诺首版删除所有依赖表。
- 按持久化点取最小故障：临时段失败；段发布未登记；登记/删除后COMMIT前失败；COMMIT后响应前退出/重试。结果为旧完整或新完整版本，残留未登记段不参与查询，重跑不重复计数。已验backup不再每卡重测。

**完成条件：** 从正式commit入口证明热行数减少、全量事实/业务并集等价、保护行不删、故障可恢复。默认400k/180天和完整日边界不变；只在隔离库及后续staging执行。

### 6.3 第17项：归档查询与完整包导入API

本项已于2026-10-25按下列完成条件独立接受；新进程完整I3-T仍在20，不代表生产服务采用。导入实例通过显式createHistoryArchiveImportServer启动，full detail明确400，计价修改明确405；普通实例保持原行为。

- 主审核GET目录/日统计正常、missing、unknown、expired、freeze一致性，保留sealed与current overlay区别，真实经过executor/HTTP。
- 原计划的明细下钻保留为后继行为：指定segment与UTC日/精确毫秒范围，复用独立只读段reader；先固定分页上限、稳定游标和snapshot/错误契约，再单卡接HTTP。仍返回原封存版本，不混热行或overlay，不用一次传全段充当默认展开。
- 最小导入HTTP接点调用既有verify/materialize，只在新导入目录产出独立runtime，返回验证结果/runtime位置/具名错误；与来源/api/imports区分，不覆盖活跃DB或自动切服务。
- 原路径隔离后，以该runtime启动独立实例并通过HTTP对拍冻结源。坏manifest/缺段/目标存在按既有CLI契约失败，重复请求不覆盖、不二次计数；沿用现有路径保护，不加后台job框架。

**完成条件：** GET日线/有界明细和完整包导入均从HTTP真实运行，导入结果可供独立实例查询，失败不损原服务/已有目标。在线合并两库及自动服务切换不在最小交付内。

### 6.4 第18项：PC多段归档带与按需展开

依赖17稳定GET。本项已于2026-10-25按以下完成条件独立接受；移动端/多浏览器不在本项范围，回归可退回。

- 已用现有renderer将同年份相邻区间成带，gap/跨年拆开，segment身份及不可用范围仍可定位。一个最小fixture含相邻段、gap/另一年与missing，复用已有browser server。
- 展开先调用已有sealed UTC日查询，明确事件口径/原封存版本；日行再下钻到17的有界明细，只按需加载/翻页，日线不能冒充逐事件明细。复用原段身份与统一错误展示，不另建通用查询框架。
- 主审一次Edge1920×1080验证正常/展开/缺失，连同Space/Tab焦点、语言、产品freeze/unfreeze和旧响应隔离；复用单段证据，新归组须实际显示。

**完成条件：** 多段归档带、精确日线及有界明细下钻、范围/不可用说明可用，键盘/语言/冻结正确。移动端、多浏览器或皮肤重做不新增为本项要求。

### 6.5 第19项：百万容量验证、性能改善与差距交接

2026-10-26按用户最新要求完成：延迟数字是估计目标，剩余优化交由用户其他计划。本项不再要求为了逐项数字追加改动或重复20组实跑，不宣称旧SLA/p95已达。正确性、完整校验、金额次序和资源保护仍不可放宽。

- 保留既有全热及正式冷热容量记录、原始输入/hash、完整HTTP/SQL/费用/coverage oracle和缺源状态。最新正式499719冷/500281热百万诊断完整独立通过，默认scheduler及真实费率/FX PUT保留。
- 交付必须逐项报告参考目标、实测、绝对/相对差距和测量边界：health0.128s、首次14.887s、实际调价3.467s、同价目0.880/0.910s、服务峰值317288448B。服务与seed分开；单组不能当20组p95。
- 后继backup同步单行复用仅接受100k严格前像对照及73项回归，首次1326.521→1260.654ms；不重跑百万，不把小样本收益乘成百万新数字。
- 后续性能计划可沿保存的CPU/profile与原始证据继续；本轮不恢复schema22/覆盖索引、不加并行线程/大型框架、不改计价/验证语义。

**完成条件：** 已证百万容量与完整正确性，保留有净收益的有限结构优化，明确全部目标差距及未测范围。该条件由用户最新收口要求覆盖原数值强制门槛；不是将原目标改写成已达到。

### 6.6 第20项：集成、真实副本演练与可用交付

2026-10-26按声明支持范围完成。新进程完整包导入、真实私有staging events及Codex perf提交/具名故障/重试/实际restore的既有证据保留原schema/hash边界；最终源码330输入无漂移，全测试3272项3247pass/25条件skip/0fail、17个此前受限浏览器全部实际通过，typecheck/lint/format均exit0。第19项按用户最新参考目标与差距报告范围收口。

- I3-R：主审只读连接＋SQLite backup取一致性真数据副本，带齐冷段、价目/tier/证据。staging执行dry-run→候选verify→另建新backup并verify→15正式commit→故障/重试→实际restore对拍。隔离原来源兜底；未达阈值仅staging显式选范围，走同一提交实现，不冒称生产自然触发。
- I3-T：同revision完整包异目录/新进程，经17导入建立runtime，隔离原来源/段路径；按日/home/kind/model核events/perf/依赖数量和规范化多重集摘要、费用/coverage/原生timing。恢复旧版本另列，不加当前总数。
- 历史差额：93,977→84,029列两端快照/版本/口径，有原件才逐事实归因；缺件明确evidence_gap及可证明/不可追溯区间，不能用今日自洽包宣称旧差额已恢复。
- 冻结源码后一次typecheck/lint/format:check/全测试及受影响browser门禁；失败分新回归/已知基线/工具条件，修复后回跑必要范围，保留最终完整结论。影响交付的失败不能仅以baseline标签跳过。
- 交付可运行dry-run/commit/backup/verify/export/import命令、HTTP用法、恢复步骤、实测与支持范围。自动封存关闭；生产部署/迁移/切服务另需明确授权。

**完成条件：** I3-R/I3-T及工程门禁有主审实物，15–19无未收口项，旧差额按证据划界。仅合成fixture不能宣称20完成。

### 6.7 最终状态

1–20按本计划声明范围及用户最新性能收口要求完成。旧1GiB Job137与旧摘要结果保留，不覆盖最终7GiB整树硬限串行全套成功记录；所有17项先前排除浏览器已实际执行。原20×20/p95、百万有写WAL稳态未补测，保留为后续性能计划与差距，不追认为已验。

无待派卡、无运行中的本轮测试/基准或临时服务。生产部署、迁移、服务切换及启用自动封存不在本次授权中。操作、恢复、支持范围、性能差距及最终门禁见[交付说明](../validation/2026-10-22-history-retention/usage-and-restore.md)，证据见output/history-retention-closeout-20261026。

## 7. 验收清单与测试纪律

### 必过正确性

以下勾选按固定交付项已声明的kind/方法/故障与版本范围验收，具体未证边界保留；不表示任意kind或所有并发/崩溃组合均已测试。

- [x] 删除/卸载/移除导入不丢历史；恢复不重复；活跃线程新turn持续更新。
- [x] 成功修订保留旧事实和原因；追加不重复复制前缀；失败事务原子回滚。
- [x] 同尺寸同mtime跨轮与同轮改写仍检出；不能因 memo 假稳定。
- [x] 连续3轮有写sync后WAL可收敛；外部读者时有界返回，释放后恢复。
- [x] backup包含已提交WAL、新证据表及版本；新目录/新进程可恢复。
- [x] 汇总/费用全载荷、UTC/local/部分日/配额/排除源/未来事件等价。
- [x] session/path DISTINCT对真实维度组合与区间精确；模型last_seen不降为日。
- [x] 清空汇总后从热/冷重建逐列相等；缺段保留旧结果并报错。
- [x] 跨卷同键择一、修订可重放；累计100→130仍增30；TPS分位数精确。
- [x] 声明范围内具名封存故障及重试无缺失；未登记段不参与查询；重跑/重复导入幂等。
- [x] 无源目录、同价目条件下换目录重开，费用/来源/样本口径一致。
- [x] API/冻结/归档界面正常、展开、不可用态通过实际浏览器检查。
- [x] §4.5 perf/timing能力与修订契约已逐类验证，所有待淘汰事实及依赖可从完整包重算。
- [x] I3-R真数据staging封存/故障/回退演练与I3-T完整包导入/差额划界均有可审记录。
- [x] 第19项按最新用户要求交付容量实测及下列参考目标的逐项差距，不再以估计数字强制阻塞收口；第20项只验当前承诺与已证边界，旧差额未定性不能宣称已恢复。

### 工程门禁

每卡先跑所触及模块定向测试；主审只在新改动或未决失败需要时复跑。最终执行 `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run format:check` 与 `npm.cmd test`，记录实际失败归属，不用旧全仓绿结论。皮肤生成物未改则不重生成。不要在多个 worker 同时跑全仓/浏览器大套件。

`tools/out` 是既有只读证据锚点，不打开其中 SQLite 原件；需要时先复制到本轮临时目录。真库只读采样和完整备份由主审执行；worker 只操作自己 mkdtemp 的测试库，不自动启动/重启正式服务、不改来源/价目账户文件。

### 性能目标与记录方式

以下保留2026-10-24的估计参考目标及原测量方法。2026-10-26用户明确无需严格匹配、停止过度优化，故它们用于逐项差距报告，不再是本轮第19项强制完成门槛。单组实测不标成p95，未执行的20×20必须明示；不为追数字省略内容/放松正确性。

- 固定1,000,000个真实schema事件，使用既有seed0x5eed1234、365日/6home/8模型/256session及已记录分布，归档布局、perf/timing数量、价目和所有输入摘要一并冻结。分别验“全热”与“同一逻辑数据经支持封存后的冷热”两种布局，公开返回均与独立SQL/业务oracle相同；不复制相同主键、不用简化窄表代替整站。
- 已有库新进程启动至health ready不含seed/首次迁移：p95≤2.5s。health提前成功不代表首次完整dashboard成功，后者单独计时。
- 每个新服务进程首次默认完整dashboard HTTP（与现有百万脚本相同endpoint/参数，响应体接收完成，包含该请求必要sync/验证，不含seed）：p95≤10s，单次≤15s。相同revision下skipCheck完整HTTP：p95≤2s，单次≤5s；不得改响应为轻量status、仅模型窗口或偷偷省略perf/费用/冷段内容来过关。
- 服务及executor所在OS进程整个测量期合计峰值RSS≤1 GiB（1,073,741,824bytes），按PID去重（worker_threads的process RSS不能重复相加），seed进程单列；不得把每个进程各自上限当合计。记录测量采样间隔及各进程高水位，不能用结束时内存冒充峰值；无法完整量测则该指标未验收。
- WAL稳态<100MB，连续至少3轮有写sync均记录峰值及checkpoint busy/log/checkpointed/耗时；有外部reader例外时必须界定并补释放后收敛，不把卡住归为合格稳态。
- 原统计方案为每种布局20个独立新进程各取首HTTP/health与随后20次skipCheck原始值；本轮按用户最新收口要求未执行，留给后续性能计划，不补测以制造达标。已测记录p50/p95/max时须有相应样本、超时和oracle结果。这里“冷”为进程冷启动，不清OS页缓存、不声称冷磁盘；首次索引/全量重建另报耗时不混入已有库启动。配置/硬件/Node版本、git工作文件摘要、缺源状态和计时边界固定，失败/超时也计入，禁止删异常值或增大120秒消息guard换通过。

性能测量不要求每张短卡重复百万基准；只在实际修复/新布局或终验时复跑。已有狭窄model-query、首HTTP/skipCheck单组及含seed RSS测量保留为历史证据，不能追认为本节20组/进程合计峰值验收。

## 8. 监督、返修与交接

用户已要求继续施工，按当前短卡推进。每轮先用一次wait_threads紧凑快照取A/B/C状态；只有完成、失败、超时或需决定才读必要报告/diff。主审实际审改动并最小独立验证后标ACCEPTED、NEEDS_FIX或BLOCKED_WITH_EVIDENCE；worker自报通过不增加完成数。

每卡记录交付项编号、实际输入/源码摘要、唯一owner/接点、用户行为、1–3断言、验证命令、前像与完成出口。返修沿同缺口，不反复建立新“存在性→又一guard”卡；新增检查必须能定位到该完整行为。定向通过后不无故重复扩跑；跨模块变更在一次相关集成复核中收口，终验由主审统一运行。

15分钟无实物就取真实diff/错误诊断；30分钟未交由主审拆依赖/接手工具阻塞，不能只催报。审批超时与功能失败分栏，保存准确错误；若只能靠相同审批连续重试，就停止该路径并报告，继续其他无依赖工作。监督中断/会话关闭或automation不存在必须如实记状态，不能把已派任务等同于持续监督。

完成一项只改其固定交付状态。向用户有意义的通知先报“已完成N/20，进行中M项，待开始K项”，再说明本次可用行为/阻塞；不要求用户读账本。无变化或无可行动信息保持安静。

回退使用真实前像或新目录完整恢复包，不reset现有工作；不在迁移后的真库强改user_version。原库事实移除前，替代副本须完整、登记且可查询；未过门槛仅副本操作。自动封存默认关闭；新计划不授权生产部署或重启。

最终交付给出实际命令、HTTP/API与页面用法、restore步骤、支持的kind/方法/修订范围、工程与性能结果、历史证据缺口。15–20任何一项未达§6完成条件，都须保持未完成，不将计划完善或新派工当作交付完成。
