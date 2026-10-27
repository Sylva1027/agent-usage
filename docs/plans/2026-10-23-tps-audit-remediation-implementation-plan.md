# TPS 审计修复 implementation plan：双 worker 小卡执行

日期：2026-10-23，Asia/Shanghai。状态：**用户已授权开始实施；进度和验收以[执行账本](../validation/2026-10-23-tps-remediation/README.md)为准。** 以下保留初版计划的范围与待派指令，不能当作实施完成记录。

本计划依据[实测复核报告](../../output/tps-audit/2026-10-23-tps-formula-audit.md)、[机器可读证据](../../output/tps-audit/2026-10-23-recheck.json)和[复核脚本](../../output/tps-audit/recheck.mjs)。本轮只新增本文件。worker 使用用户提供的两个现有 chat：

- [reTPS-worker-A](codex://threads/01a164c6-f8e4-7cb2-9f05-d9d9467ef10f)：统计、数据契约、请求计时链路。
- [reTPS-worker-B](codex://threads/01a164c7-5e67-7ab0-bf31-308189ffb0bc)：界面、比较证据、浏览器验证。

核对时两者均待命，工作目录均为本仓库。这里的任务卡和指令是待执行内容，不代表已向 worker 发送消息。

## 1. 要解决的问题与完成边界

实施按三个结果分别验收，禁止用一个“全部修复”掩盖未解决的证据问题。

1. **统计与展示修正**：provider 拆行；排名与参考值分开；显示样本数、样本单位、实际样本日期；Codex 当期没有 TPS 时仍能解释候选和计时覆盖情况。
2. **已有请求证据的补齐链路**：复用已经实现的导出、审核、导入和正常同步发布，证明晚到的完整证据能补齐，重复或冲突证据不会污染结果。
3. **原生 Codex 与 DSH 官 key 的证据缺口**：在限定时间内查明可用信息；有可靠输入才安排接入，没有就交付具体缺口及后续接入卡，保持“未解决”。不承诺靠 UI 改动恢复所有原生 TPS，也不按预期指定谁排第一。

审计基线绑定 2026-10-23 01:45:30–01:45:37 的运行及源码指纹，不是以后任意时刻的固定总数。关键基线：

- Codex v2：3,061 个候选 turn，6 个完整计时 turn，底层 326 次请求；233,379 / 29,010,490 个已记录输出 token 可用于 TPS，约 0.80%。6 个 turn 的合并 TPS 为 133.9112。10/22 的 402 个候选均无可用计时。
- DSH 已匹配账本的 615 条来自 magpie 586 条、provider 未知 29 条；account / official 匹配均为 0。不能把这份对账认证扩展到官 key。
- DSH account 的生产有效样本为 416 条 / 190.0034 tok/s；ZCode deepseek 为 424 条 / 209.6152。模型行另有 effort/provider 合并，不能直接把这些总体互换。
- 221.0 是现有合并行的 p90，不是最快 10% 的平均值或服务上限。样本日期、输出长度和 token scope 也未形成受控对比。

旧[模型速度实施计划](2026-10-21-model-speed-implementation-plan.md)曾明确选择“合并 provider”和“n=1 也排名”。本稿提出替换这两项规则，属于本次审计后的方案调整，不能描述成旧实现漏做了既定要求。旧[计量修正执行记录](../validation/2026-10-21-tps-measurement-correction/README.md)中已完成的 v2 内核、导入发布和一致性工作继续复用。

## 2. 工作模式：完成一张、报告一张、验收后继续

采用**逐卡完成报告为主、超时检查为辅**。每位 worker 同时最多一张卡；主审同时最多发出两张，验收通过后才派该 worker 的下一张。不在实施过程中逐卡询问用户。

- 每卡目标 10–15 分钟，包括局部修改、针对性验证和报告；不是写代码 15 分钟后再开始测试。
- 约 10 分钟仍无完成或阻塞消息，主审做一次状态检查。到 15 分钟必须交出可检查的差异、失败用例或证据缺口；未完成部分改成明确的续卡，不把半成品标为通过。
- worker 以当前 chat 的结束报告交付，并追加自己的报告文件。主审用 `wait_threads` 和游标读取新报告；不依赖 worker 主动给主审 chat 发消息，也不让用户搬运报告。
- 等待调用每次至多 60 秒；主审可以同时处理不冲突的集成卡。状态没变化不重复播报；无需创建定时自动化或新 chat。
- 单个长测试任务超过 15 分钟，先报告进程状态和已取得的结果，继续同一次运行；不反复重启测试，也不将“已启动”当成“已通过”。

执行时建立 `docs/validation/2026-10-23-tps-remediation/`：主审维护 `README.md` 任务账本，A/B 分别只写 `worker-A.md`、`worker-B.md`。证据产物放在 `output/tps-audit/remediation/`。这些目录本轮不预建空文件。

每卡报告固定为：

```text
卡号 / 状态：done | partial | blocked
开始、结束时间与用时：
本卡实际修改的文件、入口及基线指纹：
解决的问题与可检查的差异：
执行命令、通过/失败数量、证据路径：
没有验证的内容及阻塞输入：
后续建议：等待验收；若超时，给出一张更小的续卡
```

`done` 仅表示卡内交付完成；全链路、外部计时语义和上线状态另行记录。主审在账本写明 accepted / rework / evidence_gap，不让 worker 自己验收自己的卡。

## 3. 文件归属和并行约束

当前工作树有大量未提交改动，另有历史留存工作正在修改存储路径。沿用当前 checkout，记录每卡开始时的文件版本；不从远端默认分支另起一个丢失当前 WIP 的实现环境。

- **A 独占**：`src/perf-stats.js`、`src/usage-types.js`、`test/perf-models.test.js`、`test/perf-stats.test.js`、`test/perf-summary.test.js`；证据卡可修改 `scripts/export-perf-request-timings.mjs`、`scripts/import-perf-request-timings.mjs` 及对应 request-timing 测试，但仅限已复现的问题。
- **B 独占**：`public/perf-ui.js`、`public/styles.css`、`public/i18n.js`、`test/perf-ui.test.js`、`test/i18n.test.js`；B5 需要新复核入口时另存 `output/tps-audit/2026-10-23-remediation-recheck.mjs`。原 `recheck.mjs` 和旧证据 JSON 只读，保留可复核的原版本。
- **主审独占**：`src/usage-core.js`、`src/usage-store.js`、`public/app.js`、`test-support/perf-fixture.mjs`、`test/app-render.test.js`，以及 summary parity、API、执行器、冻结缓存测试和全局文档。`src/usage-executor.js`、`src/server.js` 只有发现实际丢字段/失效问题时才改。
- `src/perf-request-timing*.js`、`src/perf-sources/**` 默认只读。确需修内核或接入新证据时，主审先将具体文件交给 A，并暂停同文件其他写入。

同一文件保持单写者。需要越界时先在报告中定位函数和最小改动，由主审调整归属；不自行扩大任务。共享夹具由主审更新，B 在前几卡使用字面量 DTO，不等待 A 的真实数据。

每卡差异相对**领卡时工作文件**检查；不能把 `git diff HEAD` 中原有改动全算成本卡成果。不得 reset/stash/revert、提交代码或批量覆盖文件。当前 `.git` 只读；本方案不依赖提交。存储层修改前再次读取当前内容和指纹，避免覆盖并行留存工作。

## 4. 开工前冻结的最小契约

### 4.1 聚合、分组和排名

1. 复用一次 `selectPerfSamples()` 和现有 sampled 判定；合并 TPS 仍为总输出 × 1000 / 总时长，p10/p90 仍为同一集合的 nearest-rank。缺任一 Codex 请求证据仍拒绝整个 turn 分母。保留 v1 诊断，继续禁止其进入模型表。
2. 模型 key 改为 `JSON.stringify([sourceKind, model, reasoningEffort, modelProvider])`，在原三元 key 后追加 provider。provider 缺失仍存空字符串、显示“provider 未知”；不从模型前缀猜 provider，不把 provider id 翻译成“官方直连”。home/channel/主子代理的既有合并不扩展为新的筛选功能。
3. `PerfModelRow` 在原字段上增加 `modelProvider`、`window`、`firstSampleAtMs`、`lastSampleAtMs`、`rankState`。日期取**实际进入该行统计的样本**的 `tsMs` 最小/最大值，使用 epoch ms；前端按当前日历时区显示。日期不是源文件修改时间、查询范围边界或全来源最后更新时间。
4. `window` 复用样本已有的 request/step/message/turn。若同一行出现不一致单位，保留 `mixed` 说明并禁止编号，不静默标成 request。Codex `n=6` 必须叫 6 个 turn，不能叫 326 个请求；本轮不额外增加请求数投影。
5. `rankState` 为 `overflow | unverified | insufficient_samples | eligible`，按上述顺序判定。`unverified` 表示未满足当前**代码计量准入规则**，不是对真实模型或物理 provider 的断言。
6. 编号要求原有 `isPerfRankAdmitted()` 成立且 `n >= meta.minSamples`，默认沿用 `PERF_MIN_SAMPLES=20`。将现有有效门槛传入模型投影，不新增用户配置。n=1/17/19 保留数值和区间但不编号，n=20 才可能编号；未知 token scope 不因样本多就自动获准入。
7. eligible 行排在前面，其余参考行随后，溢出最后；各段按未舍入平均值降序，同值按 key 的 code-unit 顺序。只有 eligible 连续编号。界面称“满足当前计量条件的历史样本排序”，不用“全局性能认证”。
8. 溢出继续保持统计值/rank 为 null。旧 groups 的聚合与门槛不重写。仅投影和展示变化不升级 `tps-v2` 或数据库 schema；真正变更采集语义时再单独评审版本迁移。

### 4.2 当前方法的 Codex 覆盖率

原 `coverage.bySource.codex` 可能包含 v1；`byEra` 是日期划分，不能冒充方法版本划分。因此新增一个最小汇总字段，复用现有计数算法：

```js
perf.codexTimingCoverage = {
  methodVersion,             // 当前 PERF_METHOD_VERSION
  counts,                    // 复用 PerfCoverageShape
  recordedOutputTokens,      // number | null，null 表示合计溢出
  sampledOutputTokens,       // number | null
  unknownOutputCandidates,   // 已入选但 outputTokens 未知的候选数
};
```

- 输入是同一次 selection 中的当前方法 Codex 候选，沿用 home 排除、发布健康性和日期筛选；不是重新读库或另做全局统计。只按 methodVersion 选择候选，不能先要求 sampled 或已计时，导致分母丢掉缺证据的 turn。
- `counts` 复用 `computePerfCoverage()` 的 pending/dropped/sampled 和互斥主原因。`byFlag` 可以重叠，不能求和后称“丢弃总数”。`duration_missing_nonpositive_invalid` 必须保留“缺失或无效时长”语义，不能改名成纯缺失。
- recordedOutputTokens 累计范围内候选的已知有效非负输出；sampledOutputTokens 仅累计 sampled 子集。未知输出另计，不能当作真实零。使用现有安全整数检查；不安全的和返回 null，不发布伪精确比例。
- UI 分别显示候选采样覆盖 `counts.sampleRate` 和可用于 TPS 的已记录输出比例 `sampledOutputTokens / recordedOutputTokens`。后者只描述**已记录输出**的覆盖，未知候选存在时必须同时提示；分母为 0 或和未知时显示未知，不显示 0%。
- unplaced 只放该方法、当前未排除 home 的全历史不可定位数，独立注明“无法定位日期”；不纳入当前范围的候选数或 token 分母。保留已有全局诊断，不将审计中的 490 条都写成 v2。
- 已配置且未排除的 Codex 来源在当前范围内没有候选时，返回零计数对象，表示“本范围无候选”；没有适用 Codex 来源时返回 null。旧响应缺字段和 rebuilding/uninitialized 属于“覆盖信息不可用”，不能推断成 0%、没有使用或没有同步问题。degraded 保留已发布的健康数据并说明状态。
- 只有候选但 sampled=0 时，模型表可以没有数值行，覆盖解释仍必须显示；不得造 n=0 的 TPS 行。存在 6 个 turn 时，详情也应能看到低覆盖情况。

### 4.3 展示和兼容

沿用现有左右面板、四列表格、五行滚动和区间带。provider 放在来源单元格及详情；n 和未编号原因作为现有行的简短附文，不加新列或工具栏。实际日期、单位及 p90 的“第 90 百分位，不是最高速度”放在详情。覆盖信息只出现一处简短摘要，不展开诊断墙。

新 key 使旧三元选择失效时，复用 `reconcilePerfModelSelection()` 选择当前第一条有效行；不猜原来应选哪个 provider。刷新保留仍存在的 key、滚动和键盘焦点。旧响应没有新字段时显示“信息不可用”，不能把合并行伪装成某个具体 provider、默认为 eligible 或把旧 rank 当成新规则的认证。

不新增任意 30 天过期阈值，不把“本月”改为滚动 30 天，不因排名结果不符合直觉而改公式。长度分桶只用于诊断；不合成一个未经设计的“归一化总排名”。

## 5. A 的任务卡：数据与证据链路

以下每卡目标均为 **10–15 分钟**。每卡交付局部差异、明确的针对性结果和第 2 节报告；超过时间按续卡规则执行。

### A1 — provider 拆行

- 依赖：M0；写入 A 的统计、类型及 `test/perf-models.test.js`。
- 只做四元 key 和 modelProvider 返回，调整旧“跨 provider 合并”断言；不顺手改排名。
- 验收：相同 source/model/effort、不同 provider 产生两行；同 provider 跨 home 仍合并；空 provider 独立；输入乱序稳定，旧采样过滤和 pooled 数值不变。
- 检查：运行 `test/perf-models.test.js`。交付可直接给 B1 使用的字面量 DTO 示例。

### A2 — 排名门槛与分段顺序

- 依赖：A1；只写 A 的统计、类型及模型测试。
- 增加 rankState，传递现有 minSamples，按第 4.1 节排序和编号；保留参考统计。
- 验收：n=1/17/19/20、未准入大样本、溢出、精确同值均有断言；无 eligible 时所有 rank=null；有 eligible 时其前面没有参考行。默认和显式门槛一致。
- 检查：模型测试；与该改动有关的 summary 断言。不能为了通过而删除旧 pooled/分位数测试。

### A3 — 实际样本日期与单位

- 依赖：A2；只写 A 的统计、类型及模型测试。
- 从同一行 members 生成 first/lastSampleAtMs 和 window；不添加样本明细到响应。
- 验收：范围/home 过滤改变日期和 n；v1 不拉宽 Codex v2 行的日期；turn 不被标为 request；混合单位不编号；溢出行日期仍有明确语义。
- 检查：模型测试。交付冻结后的完整新行，供 M1 接线和 B3 渲染。

### A4 — 当前方法 Codex 覆盖计数

- 依赖：A3；只写 A 的统计、类型及 stats/summary 测试。
- 先实现 codexTimingCoverage 的版本限定、适用来源判定与 counts，复用现有 coverage 函数。token 汇总留 A5。
- 验收：v1/v2 混合、范围无候选、有候选无计时、排除 home、pending、全历史 unplaced；`eligible = sampled + dropped + pending`，互斥原因合计等于 dropped。
- 检查：对应 stats/summary 测试；旧 coverage 输出不被改成 v2-only。

### A5 — 已记录输出的覆盖比例

- 依赖：A4；只补 token 三字段、安全求和和类型/针对性测试。
- 验收：已知 0、未知 output、正输出缺时长、仅 sampled 进入分子、零分母、整数溢出、unplaced 不进入 token 分母。用独立手算夹具断言比例。
- 检查：stats/summary 测试。交付与 B4 的 fixture 对照，不将历史 0.80% 硬编码为生产期望值。

### A6 — 既有网关补齐流程的有限预检

- 依赖：A5；正常只读导出/导入代码和已有证据，写 A 的报告及脱敏结果。此卡不写真实索引库。
- 明确实际 producer 版本、route、agent、home、provider、requested/reported model、日期范围和端点是否可用。复用既有导出参数与分页边界；已有输入足够就用，不扫描凭据或自行推测端点。
- 验收：提供一套参数完整且可重复的导出→审核→导入临时库→正常 sync 操作说明，或逐项列明缺失输入。导出文件中的 origin 自声明不是审核凭据；旧 326 次请求的认证不覆盖任意新版本。
- 检查：现有 `test/perf-request-timing-export.test.js` 及所涉及的导入边界。没有新缺陷就不加 wrapper、daemon 或重复验证框架。

### A7 — 晚到证据的正常发布回归

- 依赖：A6、M1；写 A 所属 request-timing 测试，内核代码默认不改。临时库和自造 fixture，禁止真实导入。
- 选择最短的一条既有测试链：候选已发布但无 duration → 完整证据导入 → 不改 rollout、不 force 的正常 sync → 新 summary 可用。
- 验收：重复导入幂等；缺一条请求仍无 turn 分母；冲突/非法证据不发布部分值；失败后的已发布健康结果保留。已有测试覆盖的情况直接引用结果，不重复造一套。
- 检查：对应 store/kernel 测试。发现 dirty/revision/rollback 缺陷时先交最小失败用例，由主审转交相应文件，不能在本卡改整个存储层。

### A8 — 原生 Codex 请求时长的有限调查

- 依赖：A7；只读当前 reader、候选构造及有限样本原始记录，输出脱敏证据说明。
- 对“有请求身份但没有网关账本”的路径，检查是否存在可绑定同一请求的开始、结束、完成状态、输出与模型。限定一个已知版本/一条路径，15 分钟停止扩散搜索。
- 验收：有证据则给出具体字段、单位、归属、重试/工具请求边界和一个可做 fixture 的例子；无证据则明确缺哪一端的记录、需哪个 producer 增补。turn/task/item 时长和 TTFT 差值不作为 request 时长兜底。
- 结果为 evidence_gap 也可结束调查卡，但“原生 TPS 恢复”仍未完成；有可靠输入才能进入第 8 节条件接入卡。

### A9 — 数据回归结果汇总

- 依赖：A7、M2；只运行针对本轮变化的统计和计时组合，写 A 的报告，不改主审独占的 parity/API 测试。
- 检查：models、stats、summary、request-timing kernel/store/export。记录实际命令、失败归属和对应文件指纹。
- 验收：本轮相关用例全部通过，或留下可复现失败；不重跑已经通过且代码未变的同一组合，不把全仓无关失败记成本轮产品修复。

## 6. B 的任务卡：界面与独立验证

以下每卡目标也均为 **10–15 分钟**。B1–B4 使用按第 4 节手写的 DTO，故不必等待 A 的实现逐卡到齐。

### B1 — 显示 provider 身份

- 依赖：M0；写 B 的 perf-ui、必要局部样式和 UI/i18n 测试。
- 来源单元格及详情显示 provider；四列、左右比例和区间带保持现有结构。缺失显示未知，旧 DTO 缺字段显示信息不可用。
- 验收：同名模型不同 provider 清楚可区分；空 provider、长名称及 HTML 特殊字符均正确；可访问名称包含相同身份。
- 检查：针对性 UI/i18n 测试。提供包含新旧 DTO 的字面量夹具，不改 app 状态接线。

### B2 — 排名与参考行说明

- 依赖：B1；写 B 的 UI、局部样式和相应测试。
- 渲染 eligible 与参考行边界、n 和不编号原因；取消“全局排名”的 aria 文案。数据顺序直接使用后端结果，不在前端重算门槛或排名。
- 验收：仅参考行、两段混合、溢出、旧响应均可理解；参考行仍可选；不把缺 rankState 的旧行默认为 eligible。保留语义列头及五行滚动行为。
- 检查：UI/i18n 测试；为主审 M2 提供 selection 所需的稳定 DOM 约定。

### B3 — 实际日期、样本单位与 p90

- 依赖：B2；写 B 的详情渲染、i18n 和针对性测试。
- 按现有时区入口显示实际样本日期；n 使用 request/step/message/turn/mixed 的准确名称；说明 p90 是百分位。若 render 函数需新增日历时区参数，先固定参数名，由主审接到现有状态。
- 验收：跨日时区、同日范围、缺日期、Codex 6 turn、p10=p90、均值在区间外均正确；不把 n 称为请求数、不改带状图几何。
- 检查：UI/i18n 测试；中英文都有等义文本。

### B4 — Codex 覆盖和无样本解释

- 依赖：B3；按冻结契约写 UI 与 fixture，真实字段由 M1 接通。
- 在现有区域渲染单处简短覆盖摘要；有候选但无 TPS 时保留解释，有模型行时仍可看覆盖。计数率与已记录输出比例使用不同标签。
- 验收：无适用来源、零候选、全缺时长、部分可用、未知输出、溢出、旧响应缺字段、rebuilding、degraded 均不混淆；日期不可定位数注明全历史。
- 检查：UI/i18n 测试。后端尚未到齐不伪造生产数据；若文案分支过多，先交最小闭环并拆 B4 续卡。

### B5 — 严格 cohort 的修复前后复核

- 依赖：B4、A3；优先复用已保存的 JSON。若需新快照，基于现有 recheck 另存独立入口，输出到 `output/tps-audit/remediation/run-<时间>.json`；原脚本固定写入旧 JSON，禁止直接重跑覆盖，原脚本及其指纹版本保留。
- 使用生产过滤，分别列 source/provider/model/effort/实际日期/window/tokenScope；保留长度分桶和总体守恒。明确 DSH 416 vs ZCode 424 的 provider 总体与 ZCode max 模型行不是同一集合。
- 验收：provider 拆行不丢有效样本、不跨 provider 相加；同一快照的 pooled/p90 不因展示策略被改写。对新快照增减单列说明，不要求活数据机械等于旧的 419/422。
- 检查：脚本语法和自检断言；输出脱敏摘要和新指纹。不把不同日期或 token scope 的结果升级为公平测速结论。

### B6 — DSH account / official 的证据边界

- 依赖：B5；只读已知会话和已配置的来源信息，按有限已知样本调查，不修改凭据或发送新付费请求。
- 区分 provider 标签、可核对的请求端点/route、账本匹配和实际执行模型证据。只记录脱敏的归属结论与依据。
- 验收：能支持哪一层就写哪一层；没有 request ID/精确计时对账时明确缺口。2 条各 2 tokens 的 completed official 样本不能改称失败，也不能据此推出速度能力。
- 交付：为后续接入或受控测速列出最少缺失条件。没有外部账本不阻止展示修正验收，但阻止“官 key 已完成外部计量验证”的结论。

### B7 — 分离候选缺证据与 API 更新延迟

- 依赖：A7、M2；使用临时来源/临时库启动隔离服务，不重启用户服务。
- 在固定夹具中记录 rollout 可读、候选进入发布索引、计时证据导入、正常 sync 后 API 返回各时间。第一段故意没有证据，第二段补齐完整证据。
- 验收：能明确区分“候选已到但无分母”和“证据已到而未发布”；记录采样次数、时钟、刷新配置和实际区间。至少一次完整链路，不以单次值声称 p95 或线上 SLA。
- 检查：优先复用现有 autorefresh/API 测试。若定位到具体延迟缺陷，只交失败步骤及最小续卡，不把整个刷新系统带入本卡。

### B8 — 浏览器可见性与刷新验证

- 依赖：B7；沿用同一隔离服务和确定性 fixture，使用现有浏览器工具。
- 记录 API 可用到 DOM 更新；切今日/本周/本月，验证范围变更、自动刷新和冻结读数。截图/日志必须能对应具体 fixture、API 响应和源文件版本。
- 验收：无计时时看得到原因；补齐后无需改 rollout 即出现可用 turn；冻结视图不跟随 live 数据；不能用模拟链路结果声称原生直连历史已恢复。
- 交付：实际测得区间及是否另有同步/刷新问题。工具不可用时明确未验，不能拿字符串渲染单测代替浏览器结论。

### B9 — 小范围视觉与可访问性回归

- 依赖：B8、M2；不再扩展布局设计，只检查本轮改动。
- 取四个代表性组合覆盖中/英文、深/浅主题和桌面/窄窗口；包含长 provider、只参考行和零计时三种数据状态。检查键盘选择、可见焦点、列头、文字裁切及区间标签。
- 验收：新信息可读且与选中行一致；刷新保持仍有效的选择与滚动；旧 key 失效时安全回落。保留截图及检查结果，不顺手改皮肤或公共主题 token。
- 检查：既有 UI/render/i18n 测试；若组合超时，先交已检查组合和剩余续卡，不写“所有主题/尺寸通过”。

## 7. 主审的小卡与派工顺序

主审卡也以 10–15 分钟形成可检查结果；耗时较长的检查进程适用第 2 节规则。

### M0 — 基线、归属和契约冻结

实施开始时保存相关文件指纹、既有局部测试结果和共享脏工作树范围；确认没有其他写者占用 A/B 的文件。创建执行账本，确认第 4 节 DTO 与 minSamples 的单一来源。**通过后仅派 A1、B1。**

### M1 — 显式汇总接线

依赖 A5 的完整 DTO 交付；两张小接线分别验收，不阻塞 B 的 fixture 工作。类型变更始终由 A 负责，主审不与 A 同时编辑 `src/usage-types.js`。

- M1a：核对 models 整行透传没有丢新增字段，将 codexTimingCoverage 接到 `buildPerfStatsBlock()` 和内存 summary；已有整对象透传不做无意义改写。尚未完成的 coverage 不作为已通过接口对外发布。
- M1b：再次读取当前 `usage-store.js`，只补 indexed summary 的显式字段及必要空状态处理；不触碰历史留存逻辑。复用当前发布过滤、dirty/revision/rollback，不增加库连接或 schema。

每张分别运行对应的 memory/index parity 和 state 子集。验证相同范围、排除 home、重建/降级时字段和值一致；不只检查字段存在。

### M2 — 页面接线、API 与快照

依赖 M1a/M1b、B4 和冻结后的行/覆盖 DTO；M2a 与 M2b 各自验收后，B7/B8 才能将真实链路结果计为通过。

- M2a（10–15 分钟）：将日历时区和覆盖数据接入页面；检查旧选择 key 安全失效、新 key 保留、滚动/焦点，以及增量选中详情更新。主写 `public/app.js` 和 app-render 相关用例。
- M2b（10–15 分钟）：覆盖 `/api/usage`、dashboard、summary、合法的 `detail=full`、执行器和冻结响应。已有缓存若基于磁盘字段或旧投影，按真实失效点修复；不无条件新增缓存版本框架。

验证健康发布、缺来源和 live/frozen 的一致性；冻结后新增 live evidence 不改旧快照。旧快照缺新字段走“信息不可用”，不能悄悄从 live 或旧 groups 补数据。新字段不暴露路径、session ID、原始请求或凭据。

### M3 — 证据接入裁决

依赖 A6/A8、B6/B7。把结论分成：既有实现已覆盖、可用证据可接入、缺 producer 输入、已复现刷新缺陷。只对确实需要的分支发第 8 节续卡；未发现缺陷不造新采集器，不重复重做已经通过的 v2 内核。

### M4 — 工程验收

在 worker 停写后运行一次 `npm run typecheck`、`npm run lint` 和 `npm test`；保留完整结果及文件指纹。先前 30 项通过只能说明旧审计基线，不能代替本轮验证。

针对性组合优先为：

```powershell
node --test --test-reporter=spec test/perf-models.test.js test/perf-stats.test.js test/perf-summary.test.js
node --test --test-reporter=spec test/perf-summary-parity.test.js test/perf-state.test.js test/perf-server.test.js test/perf-codex-api.test.js
node --test --test-reporter=spec test/perf-ui.test.js test/app-render.test.js test/i18n.test.js test/app-autorefresh.test.js
node --test --test-reporter=spec test/perf-request-timing-export.test.js test/perf-request-timing-store.test.js test/perf-request-timing-kernel.test.js
```

命令是检查目录，不要求每张卡重复执行四组。全仓失败按本轮引入、既有失败、环境限制分别给证据；不能把逻辑断言失败统称环境噪声。与修改无关的皮肤等问题不顺手修，且不得声称全仓绿。

### M5 — 文档和完成状态

更新审计中的“当前实现/待修复”段落、执行账本和必要的 docs 索引；保留历史测量日期、旧结果及未验证边界。记录三项结果各自的通过/未解决状态和服务是否实际启用，不把代码验证等同于已在用户运行的服务生效。

建议流水顺序是 A1/B1 → A2/B2 → A3/B3 → A4/B4 → A5/B5，其后 A6–A8 与 B6–B8 按依赖推进，最后 A9/B9。它是任务队列，不是每轮必须互等的栅栏：B 可用冻结 fixture 提前；A 等接线时可先做只读预检；主审插入 M1/M2。依赖未通过时不得自行绕过真实联调验收。

## 8. 有证据才进入的续卡

这些卡**不默认开工、不算已修复**，主审 M3 根据实际结果选择；每张仍限制 10–15 分钟。

- **G1（A）— 网关流程的一个已复现缺陷**：仅修 A6/A7 指明的参数、分页、身份绑定或正常补齐问题，并补一项最小失败用例。若既有显式流程已通，本卡删除。持续自动拉取若需要新认证或配置产品设计，另列方案，不能在本卡偷偷加后台网络任务。
- **N1（A）— 原生 producer 证据契约与 fixture**：只有 A8 找到可靠请求边界才开。固定请求身份、起止/时长单位、重试、工具请求、输出和模型的对应关系；给出正例及缺失/冲突反例。仅有 turn/item 时间不通过。
- **N2（A）— 一个 producer 的最小适配**：依赖 N1 审核和文件归属转交，复用现有 request-timing 内核；不改其他 reader。证明所有请求齐全才生成 turn 分母、token/model 不等拒绝。
- **N3（主审）— 新适配的正常同步与发布**：依赖 N2，验证 memory/store/API/frozen 对齐及失败回滚。适配未证明同等语义时单独版本处理；禁止混进既有认证范围。
- **L1（主审或转交具体文件的 worker）— 一个实测刷新缺陷**：只修 B7/B8 已定位的一段链路，保留失败重现及修复后时间记录。若只观察到缺证据，不创建“降低刷新间隔”补丁。

若 producer 根本没有请求级计时，下一步必须是 producer 增补记录或另立受控采集方案。届时缺少的是新输入，不能让 worker 无限搜索或用近似分母凑“今日可见”。需要新在线测速、真实数据写入或服务启用时，先准备好具体范围、命令和回退，再依据后续用户授权执行；本计划不启动这些动作。

## 9. 验收门槛与停止条件

**展示修正通过**需要 A1–A5、B1–B5、M1/M2 的结果一致：同模型不同 provider 拆行，n 门槛及参考行清晰，真实样本日期/单位正确，Codex 零计时时仍有基于当前方法的解释；旧诊断和失败保护没有倒退。

**既有证据补齐通过**需要 A6/A7 和隔离链路证明：完整证据能够经正常同步出现，部分/冲突证据不能出现，重复导入幂等且快照隔离。只在临时库通过时，状态写“集成验证通过，真实索引未导入”。

**原生/官 key 计量验证通过**需要精确请求证据及实际适用版本/route 的认证范围；account/official 的 provider 名称或同一个上游 usage 值相等都不足以单独通过。没有证据就保持 evidence_gap，不能填“已解决”。

任何改动若需要重写 v2 内核、跨 provider 身份规则、数据库迁移或大幅改变面板布局，当前卡停止扩散，先交最小重现与新卡边界。15 分钟目标约束交付粒度，不保证外部系统能提供不存在的证据。总工期以每卡验收推进，不预报所有缺口必在一轮内消失。

## 10. 准备好的首轮指令（尚未发送）

给 A：

> 只执行本计划 A1，目标 10–15 分钟。先记录领卡时相关文件指纹并检查现有改动，再在你的独占文件实现 provider 四元 key、modelProvider 和针对性用例。公式、排名、reader、数据库和公共接线不改。运行模型测试，按第 2 节格式在当前 chat 报告并写 worker-A.md；完成后停下等主审验收，超过 15 分钟交部分结果和续卡。

给 B：

> 只执行本计划 B1，目标 10–15 分钟。用第 4 节的手写 DTO 在独占的 perf-ui/i18n/局部样式测试中显示 provider，覆盖未知、旧响应、长名称、转义及可访问名称；保持四列表格和现有区间带。不要改 app.js、共享 fixture 或数据层。按第 2 节格式在当前 chat 报告并写 worker-B.md；完成后停下等验收，超过 15 分钟交部分结果和续卡。

初版仅交付计划；后续用户已授权开始实施。实际派工、产品改动和验证状态以执行账本为准，真实证据导入与服务启用独立记录。
