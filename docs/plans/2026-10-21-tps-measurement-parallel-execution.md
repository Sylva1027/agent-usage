# TPS 计量修订：三 worker 并行执行单

日期：2026-10-21。状态：**A/B/C 实现与三路接线专项通过，主审已完成原六轮真实历史隔离 API→DOM；最终全仓仍有皮肤浏览器失败，未切换正式服务。三 worker 本轮收口，不重复派发已过测试**。当前裁定见[执行账本](../validation/2026-10-21-tps-measurement-correction/README.md)。本稿将[计量修订方案](2026-10-21-tps-measurement-correction-plan.md)的 R1–R6 分配给用户指定的三名 worker；不扩展界面设计或其他项目。原方案控制“为什么修、修成什么”，本稿控制“谁现在做什么、何时接线”。

## 1. 人员与唯一入口

- [TPS-worker-A](codex://threads/01a15a06-0712-7fb2-bddd-6d2c7cf6be0d)：计时来源认证、证据格式/导出、其他来源审计。
- [TPS-worker-B](codex://threads/01a15a06-21e8-79f3-929d-6c934d62d926)：Codex 纯计算、公共采样规则及排名准入。
- [TPS-worker-C](codex://threads/01a15c4c-9450-74e1-b755-a1584dcf61fd)：计时证据持久化、store/memory 接线、版本迁移与 API 一致性。
- 主审：冻结接口、复核阶段产物、协调共享文件、认证来源准入、最终工程和页面验收。worker 不相互派活或改对方文件。

工作目录均为 `E:/12 AI/ccusage/codex-usage`，共享现有未提交修改。禁止 reset、checkout、stash、批量格式化或把 HEAD 当作本轮唯一基线；此次开工前文件快照见[基线清单](../validation/2026-10-21-tps-measurement-correction/review/baseline/manifest.json)。

三个 worker 都先读本稿、主方案及[接口契约](../validation/2026-10-21-tps-measurement-correction/contract.md)，然后执行当前已释放卡。进度与主审裁定只在[账本](../validation/2026-10-21-tps-measurement-correction/README.md)维护。

## 2. 先固定的共同边界

1. 主视图比较完整请求的有效输出速度：包含请求等待/TTFT，排除模型响应完成后的工具执行；不宣称纯解码性能。
2. Codex 保留 turn 粒度和 `[codex, homeId, threadId, turnId]` key。轮分母改为同轮全部已识别请求的完整时长之和；缺一项不能配全轮分子。
3. 均值使用总输出/总时长；Codex p10/p90 仍是轮级，不将六轮变成 326 个样本。来源之间不同粒度的分位数不能被解释成同粒度稳定性。
4. `request_e2e` 字符串不等于 producer 已认证；未经认证的范围不进入新的统一排名。来源列不能代替可比性判断。
5. 本机 326 次调用精确匹配账本、候选 133.9112 tok/s 是既有调查，不是预先规定的产品答案。A 必须先核实 `ms` 起止、重试和流式完成语义。
6. 第一波不改当前 `PERF_METHOD_VERSION`、source semantics、正式候选算法及真实数据库。B/C 可直接实现最终要用的隔离模块与测试，避免等待 A 时空转，也避免用临时 feature flag 把半成品接到生产。
7. 同一文件只有一个写入者。跨边界的需求写入报告“待接口协调”，由主审裁定和通知原 owner；不自行修复别人的门禁错误。
8. 当前 UI、原始来源、鉴权配置、服务进程及生产索引均不在 worker 修改范围；正式切换由主审在隔离验收后单独执行。

## 3. 第一波：三人现在就做，互不等待

### A0：认证计时并交付六轮可复算夹具

立即执行：

1. 从[既有调查](../validation/2026-10-21-tps-scope-audit/README.md)接续，不重新跑全套审计。定位当前账本 producer 的代码/可信版本规范，核实 `ms` 的开始、结束、流式完成、失败重试及工具执行范围。只读本机已明确的账本端点；不读取密钥后自行联网。
2. 若需补查原生计时，只作一次有界核查，最多两个目标线程各 1,000 条日志；已有工具/压缩 duration 不能当请求计时。没有新字段证据就结束该分支，给出具体缺口，不回到重复扫描循环。
3. 在 A 的 review 目录产出六轮脱敏夹具：326 个合成响应身份、每请求输出和候选时长、六轮归属、期望均值/分位数。真实 ID 只在本地临时内存或私有输入中用于关联，不写进报告/提交夹具；不包含对话、工具参数、URL 密钥或账号。
4. 用独立手算/断言核对总量和逐轮值。若 `ms` 不符合契约，保留关联事实并明确否决理由；不得为了凑 133.9 改分母。
5. 更新 `A-report.md` 并结束本卡，交主审读取。主审会根据实际证明释放后续，而不是要求用户再次批准已经授权的例行修改。

产物要求：producer 证据位置/版本、语义结论、六轮逐请求脱敏 JSON、独立验证脚本与运行结果。不得只写“没有问题”或复述旧状态。

### B0：完成可注入计时的纯内核与确定性回归

立即执行：

1. 新建 `src/perf-sources/codex-request-timing.js`，实现契约中的 `resolveCodexTurnRequestTiming(homeId, turn, lookupRequestTiming)`。只读现有 fold ledger；不依赖 SQLite、网络、浏览器或 A 尚未生成的模块。
2. 使用测试注入的 lookup，覆盖完整匹配、缺一请求、计数/模型冲突、显式冲突、非法时长、工具-only、重复身份及安全整数溢出。不要按模型名猜测快慢，不使用旧 item 时长补缺。
3. 加入 100+900 token、1+9 秒的手算夹具：完整轮为 100 tok/s，缺 B 计时整轮无完整分母；改变工具执行/文字 item 时长不影响完整请求结果。
4. 在 `test/perf-request-timing-kernel.test.js` 验证固定粒度、状态和 flags。第一波只接隔离 helper，不改 `codex-candidates.js` 的正式调用、公共方法版本或旧测试期望。
5. 在 `B-report.md` 标明后续调用方列表、将修改的 flag 生成条件及完整测试命令，运行定向测试并交审；不用等 A0 才开始上述工作。

通过条件：纯函数和真实执行的确定性测试完成，缺失和冲突可机器判读，未接入生产路径。

### C0：完成隔离计时存储与迁移原型

立即执行：

1. 新建 `src/perf-request-timing-store.js`，在传入的 SQLite 连接上提供计时证据的建表、导入、lookup 及 revision 接口。只在临时测试库建表，不打开/迁移真实 usage-index。
2. 按契约保存 home、origin、response ID 与完整规范证据；精确重复幂等，异值保留冲突，不采用先到先得。实现异常回滚、重开后冲突仍在、来源自然过期不删除证据。
3. `test/perf-request-timing-store.test.js` 证明导入顺序对称、跨 home 隔离、重复批次不变更 revision、坏批次整体回滚、可取得与 B0 契约相同的 lookup 结果。
4. 计算需要重建的最小 thread 集合，在测试库证明新增/冲突只影响相关线程，不顺手修改用量事件。第一波不改真实 schema 版本，也不将 adapter 接入 `UsageStore`。
5. 将当前实际 schema 号、迁移落点、memory/store 调用点和 cache 失效点写入 `C-report.md`，定向测试后交审。

通过条件：真正执行过 SQLite 临时库回归，不是只有迁移设计文字；无需等待 A 的真机认证即可完成。

## 4. 第一检查点 G1：主审一次整合接口

主审读取 A0/B0/C0 的报告和实际代码，检查 producer 证据、复算结果、纯函数边界与临时库测试。

- A0 证明计时范围成立：冻结该 evidenceOrigin 的 producer 版本与边界，释放 A1/B1/C1。
- A0 否决某字段：不强行放行，主审亲自缩小该 producer 问题；B0/C0 的确定性成果保留，A2 的其他来源认证可继续。已经失败两次的同一推断不得让 worker 原样重跑。
- 接口差异由主审在 `contract.md` 一处裁定；不让 A/B/C 各自产生一套同名字段或临时分支。

这是内部工程依赖，不是让用户反复确认的审批流程。没有明确释放的卡不越界修改；worker 完成当前卡后提交产物，不用用“收到，等待”替代实际工作。

## 5. 第二波：在已固定接口上并行实现

### A1：证据导入格式与显式采集工具

主要写入：`src/perf-request-timing.js`、`scripts/export-perf-request-timings.mjs`、`test/perf-request-timing.test.js`、A 的报告/证据。

- 实现规范证据校验和冲突归并，导出格式遵循 contract；普通 summary 不访问网关。
- 提取工具必须显式传 endpoint/home 与有界日期，分页有上限；只输出白名单计时元数据，不自行发现 endpoint 或读取鉴权配置。生产/受测 origin 必须有 G1 认证，不能接受任意 `request_e2e` 自我声明。
- 将真机私有提取与可提交的脱敏夹具分开；原始 ID 可作为本地关联键，但不得进入共享报告和公开夹具。
- 接入六轮固定夹具验证规范化与 B/C 结果一致。

### A2：其他来源认证与独立 reader 修补

主要写入：`src/perf-sources/{dsh,opencode,zcode,workbuddy}.js`、`src/workbuddy-usage.js`、其各自 reader/usage 测试、数据源专题；**不写 store/core/stats**。

- 每来源核对计数/起止写入点、reasoning 包含关系、重试与工具边界，各留纯文字/工具调用例。结论只能是已认证、需修复或明确缺证据；不能仅因既有测试通过就认证。
- 对发现的 reader 缺陷给出最小复现、最小修补和定向回归。需要改共享 store 的部分只提出精确接口与夹具，交 C2 实施。
- WorkBuddy 重点给出重复 trace 同值/异值、跨文件及旧采集版本的测试输入；持久化冲突由 C 处理。不能在 reader 随机丢掉冲突成员以维持样本数。
- 来源准入建议提交主审，由 B2 固化到公共规则，A 不直接修改 `perf-stats.js`。

### B1：Codex 采样改为完整请求时长

主要写入：`src/perf-sources/codex-{fold,candidates,thread}.js`、`test/perf-codex.test.js`、`test/perf-projection-planner.test.js`、B 的报告/证据。

- 给现有 builder 增加可选 `options.lookupRequestTiming`，沿用同一回调向下传；无 lookup 即缺计时，不允许回退到旧 item 比值。
- 接入 B0，保留 request/turn 去重、累计量、模型强度、日期归属和样本 key；完整时长覆盖后不再以目标 item span 的完整性否决它。
- ownership、paginated child、WebSearch 注册、publication policy 保持原语义；候选重算与解析投影复用兼容性分开处理。
- 为 C 提供投影版本兼容的明确接口/规则，不直接编辑 `usage-store.js`。

### B2：统计语义与排名准入

主要写入：`src/perf-stats.js`、`src/usage-types.js`、`test/perf-{stats,models,summary}.test.js`。

- 按主方案升级 tps-v2 和 Codex request_e2e，修正“只要是 Codex 就 METHOD_ESTIMATE”等旧规则；保留正确的 pooled、nearest-rank、overflow 与稳定排序。
- 只有主审根据 A 的证据认证的来源范围才获得统一排名资格；不能按 E2E 字段名、TPS 高低或 source 名称拍脑袋放行。将准入与旧数据隔离规则做成明确测试，不增加 UI 标签墙。
- 公共 flags 和 API 结构能复用就复用，不临时扩张持久化码域。涉及结构变化先在报告指出，由主审协调 C。

### C1：memory/store 接线与迁移

主要写入：`src/usage-store.js`、`src/usage-core.js`、`scripts/import-perf-request-timings.mjs`、`test/perf-request-timing-store.test.js`、`test/perf-{store,codex-index,projection-store}.test.js`。

- 将 C0 接入正式数据库迁移，但只用隔离库执行；实施时登记实际下一个 schema 号，遇到其他项目占用先报主审，不覆盖迁移。
- 增加显式本地证据导入入口，复用 A1 校验；正常 query 不联网。导入 revision 与最小 thread 重建挂钩。
- memory/store 向 B1 builder 注入同一个语义的 lookup；禁止在 store 路径另算一次 TPS。
- 旧解析投影通过结构/方法兼容验证后复用；旧候选必须按 v2 重新判定。解决 query/cache/indexVersion 失效，不全量标脏其他来源或删除用户索引。

### C2：跨路径与 WorkBuddy 持久化冲突

主要写入：`test/perf-{codex-api,summary-parity,server}.test.js`、`test/workbuddy-store.test.js`；确有缓存失效缺口才改 `src/usage-executor.js`，不改 `src/server.js` 或公开新端点。

- 消费 A2 的冲突夹具，将 WorkBuddy `INSERT OR IGNORE` 的异值冲突改为可持续阻断误采样的状态；由 A 处理解析层，C 处理库与重开恢复。
- 同一夹具核对 memory/SQLite/API、models/groups；证明用量、费用、目录/时间筛选不受影响。
- 测试 v1→v2、重复 sync、缺一计时、冲突恢复策略、事务中断和在线冻结；不把旧 snapshot 静默改名成 v2。

## 6. 单写文件规则与交付

- A 独占：证据纯模块/导出工具、非 Codex 四个 reader、WorkBuddy 原始解析、相应单元测试及数据源专题。
- B 独占：Codex fold/candidates/thread、公共 perf-stats/types 及纯统计/Codex 核心测试。
- C 独占：新存储 adapter/导入工具、usage-store/core、必要的 executor 缓存修补及持久化/API/三路测试。
- 主审独占：两份计划、contract、总账本、总体验收、`public/**`（本轮默认不改）、全仓测试记录与正式服务切换。
- `codex-jsonl.js` 本轮默认无人修改；若确需扩投影字段，由主审另行指派，先说明为什么现有响应 ID/usage 不足。
- worker 不更新根 README、全局任务清单或对方报告，不提交/推送；不得使用格式化整个目录来修自己的一行。

每人只维护一份滚动报告：[A](../validation/2026-10-21-tps-measurement-correction/A/A-report.md)、[B](../validation/2026-10-21-tps-measurement-correction/B/B-report.md)、[C](../validation/2026-10-21-tps-measurement-correction/C/C-report.md)。每卡写：当前卡/状态、完成的具体文件与行为、失败复现、测试命令/exit/数量、来源证据/版本、剩余问题和下一可开工卡。不得只报测试总数，不得把 R0 的旧调查记成自己已完成的生产修复。

不要求例行文件哈希或重复冻结清单；审核以实际代码、可复现反例、来源边界和定向测试为依据。第一次完整定向检查通过后，不因等待其他 worker 重复跑同一集合。语义变化才补受影响测试，全仓测试只由主审在最终整合后运行一次。

worker 的最终回复就是阶段交付，须列出报告路径、行为变化、测试结果和剩余阻塞；主审负责主动使用 read/wait 收取、审核并发出下一卡，不要求用户转交报告，不依赖 worker 跨 chat 自动回传。需要接口协调时写清阻塞字段和最小建议，继续本人无依赖任务；不空等，不越权。

## 7. 主审接下来做什么

1. 第一波开工前留存共享脏工作区的受测文件基线，三条执行提示发送到指定 A/B/C；确认三个 chat 实际开始工作。
2. 读取 G1 的首批产物，直接复核 producer 时长语义、独立手算、纯内核和数据库事务。通过后更新账本并明确释放下一卡，不让 worker 自己猜是否“已经授权”。
3. 第二波 A1/A2、B1/B2、C1/C2 按文件边界推进；C 接线需要 B/A 接口到位时，先完成隔离迁移/故障测试，不反复改接口或扫描真实源。
4. 检查新方法真正排除了旧 item 比值；对缺少原生完整计时的 Sol 等来源如实记录覆盖缺口，不能拿 DeepSeek 的 gateway 时长填其他模型。
5. 完成一次最终定向矩阵、工程门禁和真实 API→DOM；按主方案 R6 复核界面/过滤/冻结。真实读数先有稳定证据和独立库验证，再考虑正式切换；不要求用户反复 restart/refresh。

本轮用户批准的是三 worker 分工执行；完成状态仍以实际代码、证据与主审验收为准，不因任务已派发就标记修复完成。


## 2026-10-21 最终收口

A/B/C 已经主审验收。原六轮 326 请求的审核计时已正式导入，3765 服务 schema19/tps-v2，API→DOM 为 133.9 / 62.3 / 148.2 / n=6。在线备份和独立旧版 HTTP 回滚烟测通过。两项皮肤门禁采集前提已修订，严格像素与低对比判据不变；最后全仓 2,796 通过、0 失败、20 跳过，定向 19/19。详细边界见 [主审整合记录](../validation/2026-10-21-tps-measurement-correction/review/final-integration/README.md)。不认证其余历史，不干预用户并行工作。
