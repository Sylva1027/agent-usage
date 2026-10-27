# 价目实施：派工与独立验收

开工：2026-10-24；收口更新：2026-10-25。用户授权的[B计划](../../plans/2026-10-24-pricing-implementation-B.md)已与外部[A交付](../../plans/2026-10-24-pricing-implementation-A.md)联合完成隔离副本G1/G2/G3验收，G4等待来源证据；未合回共享源码。

本轮结果与交付入口见[最终报告](FINAL-REPORT.md)，下文保留各卡独立复核历史。

## 工作基线与归属

- K：[Price-worker-A](codex://threads/01a16b03-da82-70e3-8c27-02945d1869d4)，计价内核。
- D：[Price-worker-B](codex://threads/01a16b03-e8b0-7081-bb98-b0458c5e9ecc)，存储与服务。
- 主审：本 chat 的 Codex，逐卡独立复核、接线及验收。

历史保留恢复轮记录既有生产源码冻结、TPS 占用 store 接点。未解除该线锁，也未向其他 chat 擅自发协调消息。本轮采用计划允许的隔离副本施工。

隔离目录：`E:/12 AI/ccusage/codex-usage/output/pricing-implementation-20261024/workspace`。只读前像在相邻 `baseline/`，308 文件的 SHA-256 清单在 `baseline-manifest.json`，复制后核对原件无漂移。复制 src/public/test/test-support/scripts、工程配置和相关计划，包含开工时的未提交改动；没有复制真实账户目录、数据库或完整历史证据目录。隔离目录不能据此冒充完整仓库全套测试环境。

worker 只写隔离目录中的本卡归属文件，日志及简报分别放相邻 `logs/`、`reports/`。共享目录目前只更新本记录及计划入口。合回前须对照前像、当前共享源码和验收结果逐文件核对，不能复制整个目录覆盖其他施工线。

## 当前派工

- **A 原始交付：需修正；修正版G1/G2接受。** 累积补丁固定于 `reviews/A-original`，六文件摘要与外部产物一致。原版116项测试虽过，真实浏览器发现缓存、取消撤销和编辑版本缺口；修复后G1通过，随后完成真实线路与409草稿/移除/双语联调，A01–A11接受，A12仅准备。
- **A-fix-1 / A-bridge-1：独立接受。** 仅在隔离副本修UI及必要API元数据；bridge独立API10、store35及类型检查通过。11个已审文件已安全同步隔离workspace；原A交付与共享源码未动。详细证据见任务目录 `reports/A-acceptance.md`。
- **K04–K07：独立接受（隔离产物）。** 事件线路价、缺价口径、稳定费用版本/memo与四路径对拍通过；S01–S03的投影、日期传播、冷/冻结/恢复专测通过。
- **D06/D07：独立接受（隔离产物）。** schema3线路保存/撤销、API/快照/coverage与容量通过。价目PUT上限按实测改256 KiB，其他入口不变；显式空editVersion不允许绕过。

- **K01：窄修后独立接受（隔离产物）。** 严格新增入口、Fast 无依据推导限制及档位阈值完成；未合回共享源码。
- **K02：独立接受（隔离产物）。** routes 目录与校验完成，不提前改事件选价或缺价金额模式。
- **K03：窄修后独立接受（隔离产物）。** resolver/coverage 完成；同键收费线路不覆盖既有免费规则。
- **K08：证据调查收口，候选不完整。** opencode-go/deepseek-v4.1-flash 缺缓存写入与上下文计费政策，K09 等待证据，不发布价目；K04/K05 仍等 G1。
- **D01：独立接受（隔离产物）。** 价格部分失败、汇率来源与状态版本完成；未合回共享源码。
- **D04：窄修后独立接受（隔离产物）。** 终态、冷却、迁移/能力变化重评与 server 共用 due 判定。
- **D02：窄修后独立接受（隔离产物）。** 旧自定义条目兼容、FX 手动锁、无底值撤销及写失败已复核。
- **D03：窄修后独立接受（隔离产物）。** API、稀疏覆盖读取和并发提交通过；新编辑器须回传 editVersion。
- **D05：窄修后独立接受（隔离产物）。** schema3加载兼容完成，后继D06/D07已接通保存。
- **D08：窄修后独立接受（隔离产物）。** 按需抓源、真实部分失败与本次摘要范围通过。
- **D09：独立接受（隔离产物）。** K 临时独占 server 完成默认后台检查、固定 1h 定时及关闭清理，已与 D08 联合验收；server 归还 D。
- **D09-compat：独立接受（隔离产物）。** D 补齐其他测试/截图夹具的后台联网 opt-out，未扩展产品配置。
- 两位worker已停在卡间，K09–K11/D10/D11未派：首组provider缺缓存写入与上下文政策证据，不发布猜测报价或启用空壳行级刷新。

## 批次状态

**G1/G2/G3在隔离副本通过，尚未合回/发布；G4未通过。** G1固定旧金额算法的里程碑保留；最终G2采用已定价部分合计与明确线路价，A11实际联调通过。G4缺完整来源证据，A12行级功能关闭。

真实配置、正式服务、用户数据库与账本未触及。G1/G2页面用临时合成数据验收；G2缓存/冻结/冷热恢复已通过专测。S05类型与lint通过，318项定向测试通过；全套测试受spawn EPERM阻止，format剩余14项与baseline相同，本轮不代表B全部完成或全仓全绿。

当前可审阅代码：任务目录 `pricing-AB-reviewed.patch`，37个文件、421,758字节，最终冻结 `reviews/G2-final`；前后像在 `pricing-AB-reviewed-files.json`。共享根目录 `git apply --check --whitespace=nowarn`通过，**仅检查，未应用**。旧 `pricing-B-reviewed.patch`保留为早期22文件里程碑，不与AB新补丁叠加应用。合回仍须遵守原施工线归属/冻结，不可整目录覆盖。

## 独立验收记录

### 开工基线

主审在只读 baseline 中逐文件运行 `node --test --test-isolation=none test/<file>.test.js`：pricing 34/34、pricing-models 6/6、pricing-auto 21/21、claude-pricing 11/11，合计 72/72。普通 test runner 因沙箱限制 spawn 返回 EPERM，逐文件无隔离执行绕过 runner 子进程；没有把多文件模块状态混跑，也未修改产品来适应环境。日志在任务 `logs/baseline-*.log`。

主审接线预读：当前 costEventFromRow/COST_EVENT_COLUMNS、内存 timeline 解码均保留完整 model；费用路径仍逐事件经 memo，不需要为首版显式线路预建表。server 的旧冻结计价临界区同步 set/restore 价目，await 在临界区之前。以上只是源码预读，不代替 K04 之后 S01–S03 的动态对拍/冷热恢复验收。

### D01 — 接受（隔离产物）

主审检查 store diff 与全部新增断言，另在 `reviews/D01` 固定“原 baseline 内核 + D01 两文件”独立复跑：store 3/3、auto 21/21、Claude 11/11，typecheck 通过。日志 `D01-main-*.log`。复核副本最初缺 test-support，补齐原 baseline 支持文件后 Claude 复跑通过，未改产品处理该问题。

返回 pricePartialFailure 与 manual/automatic/built-in FX 来源；报价日、成功/尝试时间独立；失败旧值保留，statusVersion 包含可见状态。未验证真实网络、页面/API 或并发刷新；priceUpdatedAt 旧写入语义未改，消费方须结合部分失败状态解释。D04 已继续派发。

### K01 初稿 — 需修正

显式 strictNewModels 入口可以保留旧文件兼容，但把缺 Fast 规范化为 fast:null 会在字段级手动叠加时遮蔽未来自动 Fast 证据。主审退回原两文件，要求只禁无依据推导、明确 Fast 证据可自然生效，且新 Fast 档位必须完整、有阈值。

### K01 最终 — 接受（隔离产物）

改用 allowFastFallback:false，不生成 fast 字段覆盖；有明确 Fast 费率时直接生效。严格新增标准/Fast 任一组两档不同都须有阈值，新 Fast 不允许借标准 long 补全。默认旧文件调用不改变。

主审在 `reviews/K01` 独立跑 pricing36、models6、auto21、Claude11 共74项及 typecheck；最后仅阈值窄修后再跑 pricing36/typecheck 均通过。继承的 pricing 测试格式差异未顺改。快照摘要见 accepted-manifest.json，日志 K01-main-*.log。D02/D03 尚须从原始提交识别新增键，在旧校验复制 long 之前接入严格选项；未把纯函数通过冒充 API 已完成。K02 已派发。

### D04 预审 — 待修正

发现混合候选可能用 retry-after 覆盖终态原因、旧缓存动态签名导致能力变更不能重评、曾 matched 后缺失的模型可能永久封死。已交 D 在同卡窄修并补反例；尚未接受。实际线路绑定签名接入待后续 D05/D10，不把 options 注入测试冒充已经接通所有绑定。

### D04 最终 — 接受（隔离产物）

旧缓存使用稳定迁移身份，首次升级可重新评估并保存新状态，不每次用当前能力伪造旧签名。终态/冷却共用 due 判定，曾 added/matched 又缺失可以重评；automatic.discoveryResults 恢复冷却的真实原因/策略，当前 matched 按本次结果解释，不继续继承历史错误。refresh.discovery.results 的既有 retry-after 形状仍兼容。

主审固定 `reviews/D04` 独立 store9/9、auto21/21、现有 server discovery1/1 及 typecheck；状态投影最后窄修后 store/auto/typecheck 再过。日志 D04-main-*.log。终态不创建 server timer 的独立 API 反例仍未新增，真实 routes 绑定签名待 D05/D10。D02 已派发。

### K02 — 接受（隔离产物）

主审审共同 entry 校验提取及 get/default/set/reset/merge/validate 的 routes 贯通，在 `reviews/K02` 独立 pricing40、models6、auto21、Claude11 共78项和 typecheck 通过。两条同 canonical 的线路独立，规范化冲突/非法键/第513条拒绝，无线路旧目录兼容。日志 K02-main-*.log。

本卡没有让事件选择线路价，也没有保存 schema 3；这些仍待 K04、D05–D07，不把目录 round-trip 算作线路计价端到端交付。K03 已派发。

### K03 预审 — 待修正

初稿先查 routes、后查 -free，会让原本免费的完整名称被同键收费线路覆盖。已要求保留旧 exact/alias/free 的原有语义，并给同键收费线路的免费判定及 coverage 补反例。未接受，未派 K04；G1 尚未到齐，不提前切换默认金额算法。

### K03 最终 — 接受（隔离产物）

先取得旧模型规则结果，旧 free 结果保持；其余才选择明确 routes 精确命中。旧 exact/alias 在 -free 之前的既有语义保留，canonical 不参与借价，未知线路不剥前缀。

resolver 第三参 routes；coverage 保持第三参 ready 布尔，可选第四参 routes。A 的行清单/状态，D 的 server/store helpers，K04 的 normalizeModel 均须按同版目录传入；本卡不越界改调用者。

主审固定 `reviews/K03` 独立 models10、pricing40、auto21、Claude11 共82项及 typecheck 通过，日志 K03-main-*.log。K04/K05 未派，因为 G1 尚未完成；K08 仅证据/夹具准备已派发，不能据此提前发布自动价格。

### D02 — 窄修后接受（隔离产物）

主审两次退回具体反例：旧 custom 不应在无关保存时被重新当成新增严格校验；手动 FX 锁不能因自动价追平而消失；无底值的必需币种/长档及分档阈值撤销不能被默认值填充。最终采用按当前有效值识别编辑、保留既有稀疏覆盖、指定字段撤销和精确无底值保护。写失败测试改为目录占据 rename 目标，避免仅 chmod 普通文件在 POSIX 上仍可 rename 的假失败夹具。

固定 `reviews/D02` 独立 store15、auto21、Claude11 共47项及 typecheck 通过，日志 D02-main-*.log。K 持有的 auto 容量夹具仅增加对应内置模型真实分档阈值，未放宽新增校验。API 400/409 与并发交错还未由本卡验证，已派 D03。

### K08 — 调查收口，自动候选待证据

报告在隔离任务 `reports/K08.md`。公开目录精确 provider/model 可区分同名报价，但当前候选缺 cache-write 和上下文计费政策，未生成可发布正例或 parser。主审接受“证据不足”的调查结论，不把该卡记成 G4 自动发现交付。K09 待证据，K04/K05 待外部 A/G1；K 当前暂候，D 的无依赖后继继续。

主审未重新联网抓取该报价；其中观测价仅作调查记录。容量夹具修正已随 D02 独立复跑，和供应商证据分开记账。

### D03 — 窄修后接受（隔离产物）

主审发现 editVersion 与费用 version 的 OR 比较可绕过等价费率下的覆盖层冲突，已退回改成 editVersion 优先。新编辑器必须携带它，旧 version-only/无版本请求保持兼容但不获得同等覆盖层保护。A/B 契约已同步。PUT 原始提交进入 strict 校验；既有刷新合并入口的实际刷新与 PUT 共用最小串行提交点，慢刷新期间保存会等待。

固定 `reviews/D03` 独立 API7、store15、server 定价/发现3 共25项及 typecheck 通过，日志 D03-main-*.log。容量夹具补真实阈值并同步新版编辑 token，未放宽数量断言。第一次主审 server 复跑复制路径错误，实际跑到旧夹具；纠正路径后以上三例通过，没有据此改产品。

全 server 文件另有失败，尚未以同环境 baseline 对照归因，不能宣称全仓通过或一概归为旧问题。routes 保存/费用接线、真实页面、冷恢复和周期调度未由本卡验证。D05 已继续派发。

### D05 — 窄修后接受（隔离产物）

schema 2、旧全量、schema 3、无 routes 自动缓存兼容；自动 routes 与稀疏 routeOverrides 分层，未知版本和非法新字段明确失败，不在读取时重写。实际线路 key/canonical 派生发现映射签名，费率和核验日期不改变身份签名；server/store 的匹配调用已带 routes。

主审退回仅单向 differences 的写保护：它漏掉显式空目录和单条删除，可能返回成功但未执行请求。双向比较及反例补齐后，固定 `reviews/D05` 独立 store26、API8、auto21 共55项和 typecheck 通过，日志 D05-main-*.log。

过渡期加载了手动 routeOverrides 会拒绝普通模型保存；自动线路可由省略 routes 的旧请求保留。D06 前不能称线路写入可用。D08 与 D09 已分文件移交两位原定 worker，D09 的普通测试禁用后台公网，正式服务默认启用。

### D08 — 窄修后接受（隔离产物）

完整价格、两源发现、FX 各自按实际需要抓取；发现不再无条件请求四个 CNY 价源，也不移动原全量到期窗口。未尝试来源的旧价格、metadata 和失败 issue 保留。全量成功 24h、失败 1h 的到期逻辑继续用于后台检查。

主审追加两组反例：公开部分失败由当前保留的价格 issue 解释，不拿内部全量失败标记冒充所有最近来源状态；发现-only 的 attempted/providers/noValidMatch 摘要只统计实际覆盖的 USD 目录，不把未抓 CNY 模型算作已尝试。修正后固定 `reviews/D08` 独立 store34、auto21 共55项通过；typecheck 通过。K 仅同步 auto 测试的两处真实请求数 6→2，force 六价源加 FX 的语义保留。

### D09 / G3 — 隔离机制验收通过

正常服务监听且价目加载后开始非强制检查，固定每 1h 再查；store 决定是否真正到 24h/1h。复用刷新合并和 mutation tail，不另建队列。后台不发起 usage discovery；timer unref、异常捕获，close 入口同步取消，等待在途刷新且关闭后不重排。

固定最终 D08 store + D09 server 的 `reviews/D09` 独立 scheduler4、API8、server关键6 共18项与 typecheck 通过。测试无页面请求即可启动，以 fake clock/scheduler 和临时 HTTP 服务验证周期、并发 force 后继、opt-out、关闭等待和取消；未真实等待 24h 或联网。

### D09-compat / 本轮工程检查

11 个其他测试/截图夹具在既有 options 中禁用自动后台刷新，避免启动测试服务时额外联网或改价；没有修改生产入口。主审核对 diff 与调用清单，在固定 `reviews/D09-compat` 独立 history-archive-api4、W1 status1 通过。全部22个改动文件语法检查及 scoped Biome lint 通过；复核副本首次缺 `.gitignore` 导致 Biome 配置失败，补回原基线文件后通过，未改产品解决该环境问题。

未跑完整仓库 test/lint/format:check；未跑昂贵冷历史/截图回归。直接 spawn 生产入口的用例受 EPERM 限制，未为此改变生产行为；server 全文件其余失败仍未作完整 baseline 归因。周期调度已有定向证据，但跨所有生产入口/长期运行的验收仍不能据本轮推定。

### A/G1 — 窄修后接受（隔离产物）

原A六文件摘要与交付一致，原版116项定向测试通过仍有真实交互缺陷。K修resolver对象缓存、撤销草稿边界、editVersion回传和能力门控；D补manual-only权威元数据与未实现行级请求明确拒绝。主审冻结 `reviews/A-final`，逐文件独立复跑122项前端测试通过；桥接API10、store35及typecheck通过。

主审全新synthetic home真实浏览器证明：新增立即显示并保存后coverage3/4→4/4；取消恢复仍保留6，应用恢复后为4；custom仅可整条移除并持久化回缺价；英文Escape丢弃99，console无错误。旧混用fixture记录已排除，未触及真实服务。详细交付/缺陷/修正/截图在任务 `reports/A-acceptance.md`。A06接受；A11与A12实际能力仍等G2/G4。

### K04/K05 — 接受（隔离产物）

K04让事件读取精确线路entry，不借canonical价或政策，保留免费优先；主审冻结 `reviews/K04` 独立pricing42、models10、Claude11通过。缺Fast适用费率保持未定价，主审补双语说明与一个回归测试。

K05删除全局最低价扫描/缓存，未知全未定价，priceMode改priced-only-scenario；有价模型缺明细的minimum仍保留。未知Claude无价时不再声称使用Standard。冻结 `reviews/K05` 独立pricing41、Claude11、memo8、app-summary20及S01/S03两例通过。现有皮肤夹具缺价预期由主审按新口径修订，5例通过，未改夹具数据/哈希。

### S01/S03 — 线路事实与冷热恢复定向证据

新增隔离专测 `test/pricing-route-integration.test.js`：原始解析/compact index/SQLite保持完整线路，两个同canonical路线不折叠；热→授权冷段→原源消失→已发布bundle独立恢复的token/金额/未知份额等价，当前catalog改价后冷/恢复同时按C重算。既有投影足够，未修改store/core/schema/rollup。

普通history-backup明确拒绝非空archive_segments；首次误用后改为既有publishHistoryArchiveBundle/materialize恢复路径，不扩展备份产品能力。有效目录可随bundle恢复；独立manual覆盖文件的锁定来源并非该备份契约，D06仍须单独验其保存重开。S02真实保存、冻结与元数据传播尚待K06/D07，本记录不提前放行G2。

### S05-server — 基线对照

相同环境分别跑原baseline与固定K05的完整server.test：均22项、17过5失败，失败名称一致（四个导入后即时统计断言、一个spawn EPERM）。日志 `S05-server-baseline.log` / `S05-server-G1K05.log`。这次对照排除了这五项是当前价目修改新增失败；未修其他施工线的问题，也不宣称server全绿或全仓通过。

### G2/S04/S05/S06 — 2026-10-25收口

K06补递归稳定序列化，目录规范化/往返与纯日期不会误变费用版本；source影响memo输出，继续纳入版本。主审独立pricing44、memo11及执行器日期同步通过。D06保存schema3、手动线路撤销和最新底值复原独立store38通过，唯一auto旧schema2保存断言由K窄修后主审21项复跑通过。

D07独立API15、线路S01–S03四例和scheduler4例通过。代表性API载荷150,272/167,562字节成功，合法491,146字节超256 KiB返回413且旧配置不变；只调价目PUT上限。排空超限body保证错误送达且不继续缓存，其他入口默认16 KiB保持。显式空/null/0的editVersion也不能回退绕过。

K07独立11项四路径对拍通过，覆盖同canonical不同费率、免费、纯缺价、日期范围及ZCode排除。主审浏览器实际保存两线路1/3，移除A不改B，409保留2而取消重开回到已保存1，中英文金额卡明确已定价部分合计。A11接受，A12/G4保持未交付。

最终冻结 `reviews/G2-final`，格式收口后再次逐文件独立复跑17文件318项全过，typecheck/lint通过。全套runner受spawn EPERM阻止；format剩余14文件与baseline同名，本次新增格式问题已修，没有顺改其他线。新专测不新增schema/rollup或请求关联，使用既有完整线路model、memo和bundle恢复路径。用户计价说明的更新包含在隔离AB补丁，共享根使用说明不提前冒充已激活功能。

AB补丁和37文件摘要/验收manifest已生成，根apply-check通过但未应用；两位worker均停止实现。详见最终报告的范围、日志和未验边界。
