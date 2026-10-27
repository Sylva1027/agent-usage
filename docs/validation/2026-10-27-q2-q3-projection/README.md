# Q2 / Q3 用量投影复用验收

日期：2026-10-27。版本：**v4 局部净收益、完整工程门禁和 6 个真实浏览器周期的数值校验完成；整体延迟与新鲜度目标未达，浏览器 p95 未验。** 施工入口为[主计划](../../plans/2026-10-27-q2-q3-projection-implementation-plan.md)。此前项目成果已提交并推送 `0cee6ce51814863dee8afd14fe222e0df10aaf5e`；用户确认的原始产物保留本地，`output/` 忽略。本轮代码、计划与精简验收资料纳入提交；后续性能实验按用户指令暂停，未切生产。

## 结论与实施范围

Q2、Q3 均满足各自的局部准入：正确性反例通过、20/20 配对合计更快、配对节省中位数超过 100 ms。Q2 静止与 ledger-only 各省约 **801 / 875 ms**；Q3 同步中真实 reader 请求合计省约 **1,492 ms**。这是不同场景的配对节省，不相加。普通追加 20 对近中性，不能宣称整个 Codex 追加流程已提速。

产品仅改 `src/usage-store.js` 和 `src/usage-executor.js`，新增两个专用测试，并调整 `test/usage-store.test.js` 的回滚及查询计数验收。未改 TPS 定义、raw SHA、前后/发布复核、60 s 检查频率、持久格式、依赖或 UI。独立的模型生成 TPS 计划仍属于另一范围。

Q2 将静态用量与 perf 分键。连接私有 TEMP 逐行计数只排除已证明无热用量依赖的写入；未知写入、schema/TEMP 变化、递归触发模式与历史 authority 均保守失效。perf 保留完整写入键，状态、时间和 TPS 每次读取其有效输入。metadata、period、quota 等独立缓存仍能发现同连接原始用量写。

v4 首次普通 hot 同步完成、既有 rollup 初始化之后安装 tracker；安装前先检查未观察写入。仅 open 未 sync 的实例保留首次 hot all 安装路径。已有 tracker 失效后不会重新认证。此修正让从未预热 all 的范围查询也保留 no-op 缓存。

Q3 捕获已有暖槽，在新 reader 实际 SELECT 固定 WAL 快照后重查来源，绑定构建时连接、strict data_version、物理数据库身份及证据上下文。仅复制静态用量，不共享 perf、quoteInputs 或动态 metadata/period/quota 缓存；目标 perf 独立读取。原始事务中构建、回滚后复用的事实不取得新转交认证。冷 authority 等不适用路径回退原计算。

## 工程与正确性验收

- v4 定向 **205/205**：Q2 20 项、Q3 60 项（含子例），以及既有投影、增量查询、perf-store 和整份 usage-store。该子集包含在全仓覆盖中，不重复相加。
- v4 全仓串行完整运行：**3,397 tests，3,372 pass / 0 fail / 25 skip**，约 23.5 分钟。typecheck、lint、format:check 均退出 0。跳过项保留环境原因，不计为 pass。
- 反例覆盖真实 ledger-only、不同 response 精确输出、混入原始 usage/quota、触发器副作用、回滚、外部提交、schema/TEMP 损坏、reader pin 各窗口、不同物理库、证据/价格变化、复制失败、关闭/discard 及小夹具冷 authority。
- 未预热 all 的真实 today/month 各 3 对，12 个单侧样本均保留同一个 metadata 与 period 缓存对象，完整摘要、来源指纹相等。另有小夹具三轮 no-op、查询后缓存身份与后续 raw 更新断言。
- 20 组不同 response 输出的 ledger 发布逐条核验通过；六条缺源经过三轮 sync 后，14,416 events / 359 samples / 6 owners / 359 dependencies 的数量与摘要全部相等。
- 独立 reviewer 仅静态复核，未发现必要阻断项；全部运行验收由 Main 执行。[复核记录](evidence/review-v4.txt)、[门禁](evidence/gates.json)、[全仓日志](evidence/full-test.txt)、[定向日志](evidence/q23-regressions-v8.txt)。

## 正式性能对照

Q2 before 为检查点前像，Q3 before 为保留的 Q2-only 模块树 `after-q2-v4`；after 均为冻结 `final-v4`。源码与测试由[摘要](evidence/code-and-tests-final-v4-sha.json)固定；真实 executor 日志验证实际 worker、私有来源映射、writer/reader 身份、pin 内 perf 读取与两次来源校验。只预热一次 writer，连续各轮均查询新 published reader。

每组 20 对，AB/BA 交错，固定来源、now、价目和 calendarZone。完整摘要仅预先排除 `generatedAt`、`perf.indexedAt`、`perf.meta.indexedAt` 三个时钟；metadata 其余字段及完整 periodComparison 精确相等，生成时钟逐侧严格对应自己的上一轮发布。顺序 A/B 的发布时刻不同，原值保留。所有分位数采用 nearest rank；配对节省先逐对相减后统计。

- **Q2 静止**：20/20 更快，无反向对。合计 p50/p95/max：**3,751/3,939/3,991 → 2,921/3,264/3,321 ms**；配对节省中位数 **801 ms**。timeline 每轮 1→0，perf 两侧每轮各 1 次。
- **Q2 ledger-only**：20/20 更快，无反向对。合计 p50/p95/max：**5,302/5,690/5,747 → 4,395/4,859/4,899 ms**；配对节省中位数 **875 ms**。完整摘要相等，timeline 1→0，TPS/perf 独立更新。
- **Q3 真实同步中请求**：20/20 更快、20/20 接收、无反向对。合计 p50/p95/max：**6,463/7,485/7,511 → 5,173/5,777/5,810 ms**；dashboard：**3,871/4,908/4,946 → 2,550/3,192/3,229 ms**。合计/dashboard 配对节省中位数 **1,492/1,315 ms**。
- **Q3 成本来源**：timeline 中位数 **1,320→0 ms**；perf **1,139→1,150 ms**，没有把它冻结。接收守卫、tracker 与复制合计 p50/p95/max **3.54/5.69/7.38 ms**，均已含在整请求中。

完整 sync、dashboard、合计分布及逐对反向值见[统计](evidence/summary.json)、[Q2 原始配对](evidence/q2-formal-v4-results.json)、[Q3 精简证据](evidence/q3-formal-results.json)。Q3 完整响应 payload 仍在本地原始文件，精简版保留时钟、指纹、执行日志与身份等证明。

## 控制与环境

普通 Codex 追加 20 对全部摘要一致、两侧 timeline/perf 各 1 次。10 对更快、10 对反向；配对节省中位数 **−9.82 ms**。合计 p50/p95/max **12,866/13,003/13,191 → 12,902/13,037/13,128 ms**，结论为近中性。反向序号为 3、5、7、10、11、12、13、14、16、17（从 0 起），逐值全部保留于[统计](evidence/summary.json)和[配对](evidence/append-control-results.json)。

暖读 today/month/all 各 20 对，完整摘要相等；p95 分别 **790→777 / 2,773→2,758 / 118→116 ms**，未显示持续退化。默认刷新独立实例从未预热 all，缓存身份另验，不能以 skip-check 暖读替代。[范围控制](evidence/query-paired-results.json)、[today 默认](evidence/default-today-results.json)、[month 默认](evidence/default-month-results.json)。

Q3 后段、追加及后续测试期间出现并发游戏负载；只读抽样 CPU 约 66%。A/B 两侧同时显著变慢，不能把跨时绝对值变化归因给补丁，也不能用早先空闲分布代替这一组。原始进程清单留本地，仓库[负载证据](evidence/device-load-append-v4.json)只保留匿名应用类别与数值。

手动浏览器控制验证 Claude、新文件、普通追加、ledger、筛选、双 tab 与 quota。当前负载下，从检查到目标帧的 Codex 新文件/追加/ledger 分别 **13,017/13,076/7,018 ms**；这些是控制样本，不是子组 p95。quota 无窗口仍为预期 409、summary=null、总数显示 `—`；无浏览器错误，关闭后 WAL=0。详见[控制证据](evidence/browser-controls-results.json)。

## 真实 60 s 浏览器验收

本组按实际 interval tick、status/usage 请求与响应、精确 DOM 值及双 rAF 目标帧测量。双 rAF 是渲染完成的测量代理，不是逐像素屏幕录制。正常控制为 Codex 追加、ledger-only 各 3 个真实周期，不估计浏览器 p95；独立 duration oracle 同时核验精确 sampled/recorded 输出、模型 n、average/p10/p90，不能以 UI 文本变化代替数值正确。

6/6 周期全部通过精确数值、TPS 与 tick/fetch 绑定断言，6 次尝试均无失败，浏览器 errors=[]，关闭后 WAL=0。实测值如下，仅描述本轮观测：

- Codex 检查到 tokens/TPS 目标帧：**8,654 / 8,685 / 8,935 ms**，中位数 8,685 ms；三次均超过 8 s 目标。写入到帧范围 **63,993–64,276 ms**，实际检查间隔 60,003–60,010 ms。
- ledger 检查到 TPS 目标帧：**4,502 / 4,501 / 4,546 ms**，中位数 4,502 ms。写入到帧范围 **55,390–55,642 ms**，实际间隔 59,991–60,001 ms。ledger 不改变用量总数，既有 tokens 值在检查后 4–10 ms 仍相等不代表重新计算耗时。
- 正常 6 周期均未超过各自实际检查周期+5 s；首次页面加载 **18,043 ms** 单列，不能并入刷新分布。双 tab 加载/筛选控制约 5,186 ms。

浏览器 p95 **未验**，不能据此宣布尾延迟达标。原始时刻、请求、目标值、各次尝试与摘要见[正常周期](evidence/browser-final-results.json)、[运行/恢复结果](evidence/browser-final-run.json)、[统计](evidence/summary.json)。

另设各一次最不利相位：真实检查返回未变化后 1 s 内写入，等待下个真实检查。首个 Codex 控制数值正确，但写入→目标帧 **72,307 ms**、检查→帧 **12,434 ms**，已经出现实际周期+5 s 的新鲜度未达反例。两项最不利相位均数值正确：Codex 实际间隔 59,999 ms，预算 64,999 ms，观测超额 7,308 ms；ledger 写入等待 65,046 ms，检查到 TPS 5,144 ms，预算 65,000 ms，观测超额 46 ms。ledger 的单次微小超额不外推为稳定尾部结论。它们单列，不混入正常控制；正常 6 周期通过不能抵消该反例。详见[最不利相位](evidence/browser-worst-phase-results.json)。

## 资源、输入与清理

任务合计预算 8 GiB。Main 唯一持有 Node/npm/SQLite/browser 重执行槽；worker 只编写合同、测试和限定文件，reviewer 只读，均已关闭。小夹具 1,024 MiB Job、heap≤768 MiB；真实库、全仓与浏览器 7,168 MiB Job、heap≤1,536 MiB，控制侧留约 1 GiB。所有测试 `--test-concurrency=1`，浏览器最多双 tab。Job 峰值与 Node RSS 分开记录：本轮所有已记录 Job 峰值最大为旧 v3 全仓 **2,484,113,408 bytes（约 2.31 GiB）**；v4 全仓 **2,261,340,160 bytes（约 2.11 GiB）**；最终浏览器 **1,831,354,368 bytes（约 1.71 GiB）**。最终浏览器 Node maxRSSKiB 为 1,093,392（约 1.04 GiB），它与 Job 指标口径不同，不相加冒充合计峰值。控制侧预留 1 GiB，没有连续采样全设备物理 RAM。所有重任务串行沿用上述预算，[资源记录](evidence/resources-final.json)保留各日志峰值。

使用既有 `.codex-usage/refresh-latency-20261026`，未打开 `tools/out` 数据库。每场源写探针外层 finally 使用 100 ns 精度恢复器，随后核对 1,630 来源文件。全仓后已流式验证 **1,633 输入、4,229,909,674 bytes、98 产品模块** 全等，seed SHA-256 为 `cfc35c20b32efd09328fde9ba477d25be3ebac5da33e55a26d9555090a085bd5`。最终浏览器完成、测试库清理后再次流式核验同样 1,633 输入和 98 模块，全部相等。[最终输入证据](evidence/inputs-final.json)固定输入清单摘要和 seed；产品仍为 final-v4，未重复全仓长测。已按归属记录精确删除 7 个本轮自建数据库及其 WAL/SHM，删除时 WAL 为 0 或不存在；未动 seed、来源和原有约 50.66 GiB 原始产物。v2 主动停止的旧探针没有关闭字段，首次清理因此拒绝；补用实际 WAL=0 与已停止进程的证据后清理，没有将缺失字段写成成功关闭。[清理记录](evidence/database-cleanup.json)、[残留进程核验](evidence/processes-final.json)确认无本轮残留执行进程或 headless 浏览器。沙箱 CIM 读取失败另存为 unavailable，不将其空结果当证据。

## 版本归属与剩余范围

v3 全仓首次完整运行有 6 个失败：三项实际 no-all 缓存退化，另外三项是 raw 回滚首次保守 miss、增加连接守卫后的旧计数断言。v4 修复安装时机，保持 no-op 对象身份；raw 回滚不增加成功修订，首次重建后必须稳态命中；periodComparison 改验真实聚合次数。[旧门禁](evidence/gates-v3.json)、[旧完整日志](evidence/full-test-v3.txt)保留。

SQLite 初验、递归模式/隐藏 rowid 的旧失败候选、无 CLI preload 的 Q3 探针、探针范围/字段错误、断言展开触发 1 GiB 中止、v2 停止于 11 周期等均保留版本与失败状态，排除于最终分布。新转交守卫修复只覆盖本轮转交风险，不宣称修复所有历史 raw 手工事务的直接缓存行为。

以下仅保留为暂停后的候选，不继续追加性能实验。剩余首先是普通追加：本组 after 的同步/查询中位数约 **8.56/4.31 s**。下一步先分解当前 raw SHA/前缀证明、同步发布和变更后查询；只有实测仍以前缀为主，才进入原计划 N2 的可验证文件代际/分块研究。读侧仍有 perf 约 **1.15 s** 及动态 metadata/period 等计算，后续单列依赖与代价，不能扩大本补丁的缓存白名单。

真实冷盘、实际冷归档、2×/4× 数据规模和长期连续运行尚未覆盖；真实数据集 cold segments 为 0。3 s p95、8 s max 和所有写入相位的新鲜度仍属整体目标，当前不据局部净收益宣布达成，也不切生产。

本轮不继续强制 40 周期：局部收益已有正式配对，整体目标已有最不利相位反例，当前决策所需是有限真实周期的数值与接线确认。浏览器 p95 未验，不能把小样本范围写成尾部分布。旧探针跨 Node/浏览器时钟断言失败的 3 周期单独归档；新探针在浏览器内直接记录实际 fetch 所属 tick，并保存每次尝试，产品源码不变。正式周期开始阶段 CPU 抽样约 2%，说明负载在测试期间变化，跨阶段绝对值不能直接归因。
