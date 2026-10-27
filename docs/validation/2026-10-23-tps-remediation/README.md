# TPS 审计修复执行账本

日期：2026-10-23，Asia/Shanghai。用户已授权开始实施，并要求进度使用“任务已完成 X/Y”格式。

计划：[双 worker 实施计划](../../plans/2026-10-23-tps-audit-remediation-implementation-plan.md)。

## 进度口径

任务总数 **27**：A1–A9、B1–B9 共 18 张，主审 M0、M1a、M1b、M2a、M2b、M3、M4、M5 共 8 张，另加实证触发的L1 1张。仅主审验收 accepted 才计入完成。条件接入卡、超时续卡如需增加，会明确修改分母及原因；证据调查卡验收不表示原生计时已恢复。

**任务已完成 27/27。** 卡片完成不等于全仓门禁通过或原生计时恢复。

- accepted：M0、M1a、M1b、M2a、M2b、M3、M4、M5、A1、A2、A3、A4、A5、A6、A7、A8、A9、B1、B2、B3、B4、B5、B6、B7、B8、B9、L1。
- running/pending：无。本轮范围内工作结束。
- evidence_gap：原生 Codex 请求级计时、DSH account/official 外部对账尚未解决。
- 服务状态：未重启用户服务，未导入真实索引库，未发送在线测速请求。

## M0 — accepted

- A/B 当前 chat 采用用户给定的 reTPS-worker-A / reTPS-worker-B；首轮仅 A1、B1，完成停止等待验收。
- 开工前局部测试：`node --test --test-reporter=spec test/perf-models.test.js test/perf-request-timing-kernel.test.js`，30 passed，0 failed。
- [基线清单](../../../output/tps-audit/remediation/baseline.json)保存 28 个相关文件的 SHA-256 及原始副本路径，副本使用 `.baseline` 后缀。相对开工工作文件审查，不把已有脏改动算成本轮差异。
- [开工 git 状态](../../../output/tps-audit/remediation/baseline-git-status.txt)保留已有修改范围；不 reset/stash/revert/commit。存储层接线仅由主审处理，并在动手前复核文件漂移。
- 采用计划第 4 节 DTO、provider 四元 key、默认 minSamples=20、当前方法 Codex 覆盖和旧响应不可用语义。A 独占类型文件，B 独占 perf-ui/i18n；公共 app/store/parity 由主审独占。

## 独立完成状态

- 统计与展示修正：数据/接线/单测已验收，严格cohort及浏览器检查待收口。
- 已有证据补齐：mock/临时库正常sync发布已通过，真实索引未导入；隔离API/DOM时序仍待验。
- 原生/官 key 计量验证：原生有限调查为evidence_gap；官key边界待B6，不得标为修复。

每卡记录追加在此；A/B 分别维护自己的 worker-A.md、worker-B.md，主审依据实际差异、测试与报告验收。

## A1 — accepted

主审逐项检查相对开工基线的三文件差异：仅 provider 四元 key、公开字段和对应测试；同 provider 跨 home 仍合并，未知 provider 独立。主审重新执行模型测试 12 passed、0 failed。公式与排名未变。A2 已派，B1 继续独立进行。

## B1 — rework

主审复跑 UI/i18n：37 passed、0 failed；尚未验收。要求保持原生 td 的 table-cell 格式化上下文，仅内层文本两行显示；并撤回本卡对旧 groups UI 的无关改动。

另发现既有 parity 测试 ★M4.2-j 的精确键集漏了早已存在的 missingSources（本轮公共汇总尚未修改）；已最小复现，后续 M1 同步正确公开契约，不将其归咎于 provider 修正。开工 typecheck 通过，lint 退出0、56 warnings/4 infos，日志已保存。

## A2 / B1 — accepted

A2相对A1 checkpoint已复核：rankState及默认20门槛、eligible优先、参考行不编号；原groups公式不变。B1退回项均修正：td保持table-cell、旧groups入口无额外差异。主审联合执行models/summary/perf-ui/i18n共88 passed，0 failed。开始A3/B2。

## A3 — accepted

主审复核实际members日期、window与mixed禁止编号；17项模型回归通过。已准备公共parity/API断言，测试明确因codexTimingCoverage尚未接线而失败（undefined而非null），作为M1的失败前例，未将M1计为完成。A4开始。

## A4 — accepted

当前方法Codex计数复用同一selection与coverage算法；v1保留在旧诊断，缺时长候选仍在分母，unplaced单列。主审复跑stats/summary 100 passed、0 failed，记录于output/tps-audit/remediation/A4-review-tests.log；A补齐返回注释及完整selection类型，typecheck通过。A5只补token汇总。

## B2 — accepted；M1 接线进行中

主审复核仅eligible显示数字rank、旧rank不冒充新认证、n及不编号原因可见、后端顺序直接渲染。UI/i18n 42 passed（B2-review-tests.log）。主审core/store只加字段透传和rebuilding覆盖为null，M1-before副本保留并行留存改动；先前M4.2-a失败例及h/j共3例已转绿。token字段尚待A5，M1暂不计完成。

## A5 — accepted

主审检查已知0/未知、sampled子集、unplaced和独立溢出保护；stats/summary 104 passed（A5-review-tests.log）。完整parity/state组合72 passed、3 failed，详见M1-parity-state.log：1项Windows rename EPERM，2项DSH删除后的保留/告警断言，需与并行历史留存策略核对；不宣称整组通过。M1继续按本轮具体契约验收。A6开始只读证据预检。

## M1a / M1b / M2b — accepted

字段契约与当前方法覆盖已贯通内存、索引、四个API/全文入口、执行器及冻结快照。M1-contract-parity.log：15 passed、0 failed（范围、排除、uninitialized/rebuilding、Codex日期及发布过滤）；API20项通过；执行器旧10字段期望已同步15字段，修正后14项全部通过（M2-executor-corrected.log）。red-api-coverage.log中的缺字段失败已在API验证中转绿。保留源路径/session等私密字段断言，modelProvider按新公开契约显示。

M1-before相对差异已复核：core仅返回注释及两处覆盖字段，store仅一处字段透传；并行留存逻辑无覆盖。M1-parity-state.log的3项较宽检查失败仍单列，M4须给出边界，未通过排除失败来声称全仓绿。

## B3 — accepted

实际成员日期按local/utc显示、样本单位与p90说明已检查；主审UI/i18n/app-render联合105 passed、0 failed（B3-app-review.log）。app两处已透传calendarZone，旧合并key失效和现有key保留均有回归。B4补覆盖解释；M2a待B4整区联调再验收。

## 隔离基线对照：3 项已有失败已复现

使用baseline-control-loader.mjs的只读ESM加载钩子，按manifest校验SHA-256后，在内存恢复开工时stats/types/core/store和原parity测试，未覆盖工作文件。只运行之前失败的3项，仍为0 passed、3 failed，具体分别是Windows rename EPERM、DSH样本删除后实际6/期望5、删除后UNKEYABLE_RECORD告警仍保留。日志baseline-control-failures.log；这3项失败在保存的开工源码下可重现，不是本轮字段/排名变更新增。M4仍保留全仓结果边界，不修改并行留存策略以迎合旧删除断言。

## A6 — accepted（预检完成，真实批次仍缺审核）

既有导出/导入边界8项通过，无产品差异。当前producer版本与旧认证不同，HTTP端点响应不等于计时语义审核；未导出真实账本或导入真实索引。不将研究卡结束记作所有Codex请求恢复。A7的mock/临时库与正常sync回归已在用户实施授权内，无需重复申请许可。

## A7 — accepted

检查增量测试仅补“导入前无duration、正常sync后summary可用”和rollout逐字未变断言；复用幂等/冲突/回滚/部分请求保护。export8、C1发布1、C0回滚3、kernel/request27项通过；未动计时内核和真实库。发现该文件迁移测试仍写schema19（开工源码已21），主审接管此测试的字面量兼容修正，以重新执行此前被过时guard挡住的迁移断言；不改schema。A8只读原生证据调查开始。

## B4 / M2a — accepted

生产API→UI、i18n及app-render联合113 passed、0 failed，日志B4-M2a-production-ui.log。完整/部分/零计时分别显示100%/95.6%/0覆盖，零计时保留25候选和2800已记录输出，但无伪造TPS行。覆盖原因使用互斥dropped计数；未知输出、溢出、旧响应和索引状态均有说明。A7迁移guard已同步当前schema21，完整store18/18通过（A7-store-migration-review.log），未修改产品迁移。

## A8 — accepted（调查完成，evidence_gap）

有限两份原生Codex CLI0.163.0活会话日志未发现同response ID请求E2E；4547个response ID与item/call ID无可用精确边界关联。四个reader/fold/candidate/timing代码指纹独立核对不变。活文件计数仅时间点证据，未声称覆盖其他版本或路线。不启N1，不以turn/item/TTFT凑分母；原生TPS仍未恢复。原recheck脚本/JSON的开工哈希亦确认未变。

## B5 — accepted（聚合可比，旧逐样本身份不可恢复）

主审核对独立脚本语法、输出/脚本哈希及严格cohort6行；6/6明细、4个provider总体和20个长度桶与历史聚合一致。新快照run-2026-10-22T22-49-17-944Z.json记录范围/单位/tokenScope与三量守恒，原历史文件未变。ZCode max422拆为421+1，provider424仍为421max+3disabled；DSH419拆416+2+1。旧临时DB不在，不能证明逐样本集合相同；日期/单位/输出范围未对齐，不能声称公平速度排名。新Codex3216候选/6计时、233379/29673621已记录输出为新时点，不改01:45旧值。

## A9 — accepted；B7 转交 A

数据侧174项通过证据逐命令列出，当前models另由M4运行中日志核对17项通过；不是单次最终174套件。不重复已通过且未变更组合。A原队列结束，B7依赖已满足，主审将B7隔离时序卡转交A，与B6并行，总卡数仍26。仅新增独立夹具/测量证据，不转交产品文件；B8/B9仍由B处理。

## M4 — 检查完成，门禁未通过

任务卡验收仅表示检查与失败分类完成，不表示全仓绿。npm test：2824pass/119fail/45skip；本轮漏改CLI精确键集已定向修正1/1通过，未算术改写全仓结果。typecheck因并行归档补齐import后复查通过，lint退出0但55warnings/4infos。完整分类、局部基线对照与边界见[工程检查](../../../output/tps-audit/remediation/M4-engineering.md)和M4-failures.json。产品worker文件在本次全仓运行前已停止写入；后续若浏览器返工改产品则只复验受影响项并追加。git diff --check本轮相关产品/测试通过。

## B6 / B7 — accepted

B6有限调查确认official两条各2token均completed；provider/title-route只为标签，无共享response ID能与外部账本精确相连，官key归属/线路/执行模型保持evidence_gap。B7由A交付隔离脚本，主审独立复跑退出0（B7-main-review.log）：25候选无分母→导入未发布仍0→普通sync后25/25，usage/summary一致且冻结响应一致。A测量单次候选发布至API可用178.086ms，包含手动阶段，不是p95或线上SLA。脚本关闭服务/临时库并清理，不跨turn占端口；B8须用确定性今日副本重新启动。

## M3 — accepted（条件接入裁决）

- 既有实现已覆盖：完整外部证据导出/审核边界/导入/普通sync与API发布在临时库通过；G1无具体缺陷，不创建wrapper、daemon或自动拉取器。
- 缺producer输入：原生CLI0.163.0有限样本没有同response ID的E2E，N1不具备可靠输入，不启N2/N3，不使用turn/task/item/TTFT代理。下一步需要producer补请求起止/终态/attempt与模型绑定，而非继续无界搜索。
- DSH外部认证：account/official标签不证明账号、endpoint或执行模型；样本无共享request ID，保持evidence_gap。需先获得精确关联键、route/身份及输出/reasoning范围，再开展有范围的受控测量。本轮不发在线请求或读取凭据。
- 刷新缺陷：B7未复现发布缺陷，不开L1；浏览器B8仍独立待验，若出现新实证再单列最小续卡并明确调整分母，不提前宣称前端无问题。
- 实际启用：未向真实索引导入、未重启用户服务、未承诺当前运行服务已经加载新代码。

## 条件卡 L1 已触发：分母26→27

B8主审独立捕获API证据（B8-main-fingerprint-before-after.json）：rollout不变，today n4→n5且perf indexVersion变化，/api/status及usage fingerprint保持同值，since返回changed=false。与“缺分母”不同，这是独立证据发布不会唤醒浏览器取数的失效点。按计划第8节启L1，仅修这一条指纹链与回归，由A转交server及必要独立测试，主审不并发写。M3先前“B7未复现故不启L1”是当时结论，本条据B8新实证更新。

## B8 — 浏览器检查完成，刷新缺陷转L1

B在IAB保存初始零计时截图，但工具等待批准后暂停；主审用独立隐藏IAB完成补充验证，未使用待批准CDP能力。B8-main-dom.json记录今日/本周/本月分别4/16/24可用回合及真实日期；冻结today4后完整补齐至live5，冻结保持4，恢复后5。独立live页可见且自动刷新true，导入发布后跨60秒仍停4，配合status指纹不变确认为L1。截图B8-main-stale-live.png与B8-main-resume-live.png保留前后。控制夹具误把month与today的expectedN混用，500是等待断言失败，API已提交成功；此误配单列，不当作产品错误。

B8卡验收表示真实检查与最小失败重现交付，不表示自动刷新已修好；L1通过后必须重演浏览器自动更新。B9由主审接管，避免等待批准的新能力阻塞普通界面检查。

## B9 — accepted（主审接管）

[视觉检查](../../../output/tps-audit/remediation/B9-review.md)记录四组中英/浅深/1280与390组合，含长provider/全参考/零计时；修复英文窄窗口列头溢出和样本日期裁切。修正后文档宽=视口，说明无隐藏溢出；生产页键盘焦点2px可见、Enter选中/详情一致，8行fixture五行滚动可达底部。109项UI/app-render/i18n通过，scoped style lint退出0但48warnings。多模型刷新滚动/旧key回退仅按现有单测覆盖，不冒充浏览器穷举。L1后仍需实际重演自动刷新。

## L1 — accepted（主审独立复跑及浏览器重演）

A交付轻量发布状态查询，status空闲时通过既有执行器连接查询，繁忙或50ms超时回退缓存。外部sync后的status-only探测与import-only pending唤醒、重复稳定、拒绝未审核输入和冻结一致性均在测试内；主审独立运行perf-codex-api/perf-server/W1合计36/36通过，日志L1-main-targeted.log。这里拒绝输入测试实际命中未审核origin；不要把它扩写成所有已审核冲突路径的新测试，冲突/回滚仍由A7存储测试证明。

11:33–11:37，主审重新启动隔离夹具服务，以真实IAB页重演0→4/5自然刷新；冻结4/5后，另一开启自动刷新的页从4/5自然变5/5，冻结仍4/5且原模型选择保留。最后导入发布11:35:31，页面统计截至11:36:21；观察仅单次，不外推p95或60秒SLA。证据：L1-browser-dom.json、L1-browser-final-publication.json、L1-browser-live.png；最终控制状态today/week/month为5/17/25，rolloutUnchanged=true。原B8失败证据保留。

纠正A报告的上限表述：执行器持续繁忙时可能连续回退，须空闲后的后续轮询才看到外部提交，不能保证“最迟下一60秒”。冻结响应仍只使用捕获的发布版本，pending本身不直接发布统计。

## M5 — accepted（范围内收尾）

审计§9追加修复结果、严格总体、原生/official证据边界及浏览器失败→修复重演；产品文档与旧计划supersession说明已更新。M5-final-verification.json确认两份历史recheck文件SHA-256与M0一致，7份本地文档链接无缺失，机器账本27/27且浏览器结果断言通过，并保存当前文件指纹。相关产品diff空白检查通过。

最终M5-final-typecheck.log退出0；前一次L1-main-typecheck.log曾记录并行归档返回值缺warnings，后续工作区已补齐，未覆盖其他任务代码。全仓仍以M4的2824pass/119fail/45skip为准，未重跑全仓、不宣称全绿。A/B检查时均已完成交付；尝试加派B只读交叉检查收到execution-config-loading，未成功派发，不算作独立二审。

本轮仅创建的隔离服务已通过control/shutdown关闭，两个验收页已关闭；未重启用户服务、未导入真实库、未在线测速。原生计时与DSH官方外部认证仍evidence_gap，后续须补可靠producer输入和精确请求关联再开新卡。本轮27/27为任务卡完成，不等于这些证据缺口已解决或全仓门禁通过。

## 用户反馈后的界面清理 — 3/3

按用户截图移除表格顶端说明、每行排名状态及缺provider/日期的占位文字；已知provider、样本数和真实日期保留，排名原因和分位数定义进入悬浮提示。删除右栏图下重复区间文字；左右面板统一274px高度、16px内边距，窄屏上下排列，正文完整显示。

110项UI/app-render/i18n回归通过（UI-cleanup-tests.log），scoped lint退出0、47warnings，diff空白检查通过。UI-cleanup-browser.json记录四组生产renderer/CSS隔离夹具检查：中文旧响应/深色1280、英文新响应/浅色1280与390、中文新响应/深色1024。四组均文档宽=视口，两个面板scrollHeight=clientHeight；桌面顶底坐标一致。截图UI-cleanup-desktop.png、UI-cleanup-mobile.png。夹具复现截图字段形状，非新增线上测量；本次未改统计/API，未重跑全仓或重启用户服务。

## 七项后续要求 — 6/7，Codex数值速度及运行服务接入仍待解决

1、3–7的六项界面要求已实现：删除排名列/参考段、左侧样本数和排序箭头，表头改“模型”；端点仅10%/90%且无竖线，平均线保留；多行表直接复用comparison-table的凹槽/表头/行分隔/滚动样式。UI-seven-desktop.png、UI-seven-mobile.png及UI-seven-browser.json为隔离浏览器证据，桌面顶底一致、窄屏不溢出。

第2项分开记录：Codex-visibility-recheck.json在12:16的真实只读索引快照有今日567个当前方法候选、0个请求计时；全历史3714个候选仅6个有计时，均在10月21日。旧投影将未计时Codex模型整行丢弃，现已补8行missing_duration，保留真实模型/记录数/候选日期，速度null、有效样本n=0；有效模型不覆盖、不重复。UI-seven-codex.png用该真实聚合快照验收，详情只解释“日志未记录请求耗时”。这修复模型可见性，数值TPS未恢复。

主审联合UI/app-render/i18n/models/API 137/137通过（UI-seven-final-tests.log）；worker的统计/计时相关86项通过；typecheck通过。未重跑全仓，扩展parity仍有3项失败，详见Codex-visibility-review.md。

实际生效：先发现3765旧API缺codexTimingCoverage，向用户询问启动方式后，用户确认`node src/cli.js run`。核对注册服务的端口、host、cwd及argv完全一致后，仅优雅关闭该服务，按原命令/工作目录重载3765。UI-seven-live-before/after.json记录真实API前后，新后端今日生成9行Codex、600个记录回合、0个计时样本；之后浏览器记录推进到602，属活数据增长。UI-seven-live-dom.json及UI-seven-live.png证明实际服务三列表头、无左侧样本/排名及可选择Codex详情已生效。原生数值速度仍未恢复，不以补行代替请求计时修复；任务仍6/7。

## Codex 数值接入完成 — 7/7（2026-10-25收尾）

自动同步现已读取本机Magpie请求耗时并按原生response身份匹配；补齐规划期及规划后首次追加的线程隔离，稳定兄弟线程继续发布。10月24日真实API已有509个有效计时样本；10月25日本周实际页面显示3,363/3,388、GPT high 32.4 tok/s，左右框体均274px且顶部对齐。服务按原命令重载后验收，未发付费探测请求。

性能184/184、用量/来源92/92、memory并发边界2/2分组通过，类型检查及相关lint通过。未重跑全仓，计时窗口与测试分组限制见[完整验收及截图](../../../output/tps-audit/remediation/numeric-acceptance-2026-10-24.md)。旧27/27和6/7段落为历史记录，本段为后续七项要求的最终状态。
