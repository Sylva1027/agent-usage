# 模型生成速度 TPS 调整方案

日期：2026-10-27；2026-10-28 修订原生来源边界。状态：通用计算内核已实现，原生生成计时采集尚未完成；未部署。

TPS 的目标改为**模型生成输出时的速度**。采用统一的生成阶段口径，覆盖 Codex、Claude Code、OpenCode、ZCode、DSH 和 WorkBuddy；缺计时按请求处理，已有可测请求正常显示。页面继续使用现有模型速度表、速度条、样本数和区间，不增加口径说明、警告、徽标、覆盖率区块或切换开关。

**来源必须独立于 Magpie。** 沿用[项目边界](../01-roadmap.md)：读取各工具已保存在本机的原生记录，不主动请求账户、不增加代理、不要求修改路由。Magpie 仅供研究流采集方法，其账本、接口和私有响应头不作为产品采样来源。前轮“Codex/Claude 通过 Magpie 恢复计时即完成”的实现与完成结论已撤回；原生能力事实及缺口见[核验记录](../validation/2026-10-28-native-generation-timing/README.md)。

2026-10-28 深入探索已形成[原生计时实施计划](2026-10-28-native-generation-timing-plan.md)：包含安装版本与 producer 证据、Codex 四例离线实测、各来源具体修改点、任务依赖及普通安装验收。已纠正“打开 OTel/事件持久化即可补齐”的判断；本文保留指标与已有工程链路规格，后续采集施工以新计划为准。

本方案取代旧方案中“主视图使用请求 E2E”“Codex 必须整轮计时齐全”“ZCode 不读取 TTFT”的决定。旧方案保留历史记录，其展示性补丁和准入限制不自动延续到新口径。

## 1. 统一计算规则

统一测量**非推理输出的生成阶段**，包括正文、代码、拒绝文本和工具调用的生成内容。这个范围用于比较回答与工具输出的生成速度；隐藏推理的起点在订阅渠道不可见，不能把思考等待反推成解码时间。推理 token 仍正常进入用量和费用统计。

```text
N = 来源报告的非推理输出 tokens
B = 计时起点已包含的输出 tokens
D = 末个有效输出时间 − 首个有效输出时间，单位毫秒
请求 TPS = (N − B) × 1000 / D
平均 TPS = 所有有效请求的 (N − B) 之和 × 1000 / D 之和
```

**首 token 的边界要配套扣除。** 常规首 token 到末 token 的测量取 `B=1`，即常见 TPOT 的倒数。两个 token 相隔 20 ms 时是 50 tok/s，不能用两个 token 除以这个间隔得到 100 tok/s。若来源提供首批的真实 token 数，使用该值；只有流事件而无首批计数时，使用统一的 `N−1` 约定，内部保留边界近似信息，不强求逐 token 日志。一条 SSE 事件不等于一个 token。来源若提供从生成开始、覆盖全部 N 的真实阶段耗时，则 `B=0`，不能再扣一次。[NVIDIA 指标定义](https://docs.nvidia.com/nim/benchmarking/llm/metrics)与[vLLM TPOT 说明](https://docs.vllm.ai/en/latest/benchmarking/cli/#understanding-the-latency-metrics)支持首 token 边界的处理。

**分子映射：**来源的 output 已含 reasoning 时减一次；已经单列非推理 output 时直接使用。Codex Responses 的 output 包含 reasoning；OpenCode v2 的原始 `tokens.output` 不含 reasoning，但本仓库 usage reader 已将两者相加，适配时要分清原始值与归一化值。Claude 的 `claudeUsageFromRaw` 已读取 `output_tokens_details.thinking_tokens` 并保留 known 位，性能 reader 应复用它。缺字段不等于零；有明确无推理语义的来源可直接使用 output。不能从思考摘要的长度估算隐藏推理，也不新增 tokenizer 或字符换算。

**时间边界：**优先使用同一观测点、同一时钟记录的首个与末个有效非推理输出。正文增量、拒绝文本和实际生成的工具名称/参数可以构成输出；空 chunk、只带 ID 的工具开始事件、角色声明、心跳、加密推理和推理摘要不能构成起点。`ttft_ms` 只有语义吻合时才能使用，不能因为数值存在就直接相减。新增采集使用单调时钟偏移，墙上时间只用于归属日期；不得把客户端起点与网关终点拼接。

**已有计时可以渐进改善。** 只有首有效输出与响应完成时间时，可以计算生成阶段的近似窗口，不因缺末 token 字段一概丢弃。需核对完成点是否夹带工具执行或独立收尾；已知包含这些等待时不能冒充生成时间。内部保留实际终点类型，新增末输出字段到达后替换同一请求的旧窗口。最后正文之后才到的 usage、`[DONE]`、连接关闭、客户端落盘均不更新新采集的末输出时间；首输出前的排队、预填充和前置重试也不进入 D。

正文后确有推理或服务端工具执行穿插时，仅按明确阶段事件累计非推理窗口及其对应分子，再合并为一个请求样本；不能把所有 chunk 间的停顿都扣掉。阶段内的正常流间隔保留。已知混合阶段却无法分离的响应不混入普通输出窗口；不为尚未出现的协议预建通用分段框架。只有推理、`N−B≤0`、无正时间间隔或整段一次性交付的响应不产生速度。

均值继续使用时间加权的总量比，不改为逐请求 TPS 的算术平均；P10/P90 则仍是请求分布。并发请求分别累计自己的生成时间，不能改用它们覆盖的墙上时间，否则并发数增加也会被误认为模型变快。

上轮调查中的 3,681 次配对请求是 Magpie 既有流速算法的对照集合，并非新方案的覆盖上限或最终纳入集合。其 `first_text_ms` 和纯推理回退分支不能直接照搬成新规则；需先核对正文、工具和混合响应的范围。

## 2. 各渠道的接入路径

统一内核只接收已经映射好的输出量和生成耗时。能提供同范围计数与时间的来源都可参与，不再只按 Codex / Claude 来源名称放行排名。

| 渠道 | 当前实现使用的数据 | 调整路径 |
|---|---|---|
| Codex，包括订阅、API 与自定义 provider | rollout 有 `response_id`、output/reasoning、item 生命周期；本机日志数据库未发现首/末输出 delta | 复用原生 ID 与计数。不能把 item 起止、整轮 duration/TTFT 或条目落盘时间当生成窗口；需工具自身保存逐响应输出边界 |
| Claude Code | `message.id`、`requestRef`、usage 与内容块完成时间；没有首/末 delta 时间 | 复用原生请求关联、thinking known 位和同 ID 多行合并；最终 output/thinking 从同一记录取值。需原生流处理点保存输出边界，不能回退 prompt 到完成 |
| ZCode | `first_token_at` 混合正文/reasoning；已定位 Responses 与 OpenAI-compatible 路径的 output 包含 reasoning | 已知路径用 output-reasoning；未知路径继续核验。原生 `ModelStreaming` 需补首/末非推理边界，不直接相减 TTFT |
| OpenCode | v2 原始 `tokens.output` 已扣 reasoning；当前版本关键 delta 为 ephemeral，且有批量发布 | 在合批前按成功 provider attempt 记录两个标量，随最终 message 持久化；开 durable event 也不能恢复。`streamed-created` 不作为生成时间 |
| DSH | `assistant/message.data.stream` 已有 raw/compressed chunk 时间；当前 DeepSeek adapter 未保存可信 reasoning 计数 | 时间不必依赖中继补采。先核对同范围计数；不能因为有 chunk 时间就把全部 output 当非推理输出 |
| WorkBuddy | output 含 reasoning；`qua.end` 已保存正文间隔与 messageId，但不覆盖工具/refusal | 先验证可由既有记录证明的纯正文子集；完整覆盖需 monitor/trace producer 补同范围边界。旧 generation span 总 duration 不进入速度 |

这里的“渠道”同时涉及使用工具和上游供应商。沿用现有来源、provider、模型、推理强度的行身份，订阅/API/中继按请求记录的真实归属处理，不从当前账号配置补写历史归属。不同来源也不因模型同名而合成同一行。

跨渠道比较统一的是计数、时间窗口、观测位置和样本粒度。优先在现有调用链最靠近上游的流接收处计时；服务端计时、网关接收、客户端接收的差别保存在内部证据里，不借平均网络延迟校正单条请求。验收按实际模型、推理强度、实际服务档位、输入上下文长度、输出长度和正文/工具类型分层。不同模型使用自己的 token 定义，不把 tok/s 解释为相同文字量；日常页面仍按现有分组展示实际调用，不增加筛选和说明区。

## 3. 缺少流式计时的请求

没有逐 token 时间戳，不等于一定不能计算。按以下顺序处理，每一步都作用于单次响应：

| 已有信息 | 处理 |
|---|---|
| 同范围的明确生成耗时和输出量 | 按其是否包含起点 token 映射后计算，不要求逐 token 明细 |
| 首/末非推理输出，或首输出与已核对语义的响应完成点 | 计算对应生成窗口；终点近似保留在内部证据中 |
| 本地主要记录缺首输出，但同一工具其它原生记录有精确请求 ID 和有效输出边界 | 补齐后计算；计时晚到时只重算受影响请求与分组，不借用中继账本 |
| 只有请求总耗时、首推理时间、整轮耗时或工具执行起止 | 保留该请求的用量、费用和原始事实，不参与 TPS 均值、区间和样本数 |
| 整个模型行都没有有效生成样本 | 保留模型行，速度和区间沿用 `—`，有效样本数为 0 |

一个轮次有 10 次请求，8 次能测，就用这 8 次计算；不再因为其余 2 次缺字段丢掉整轮。已经完成的响应可先进入统计，不等待整个 agent 轮次 `task_complete`。

“主要日志没记流式计时”与“上游真正非流式”要分开：前者只有在同一工具其它原生遥测已保存边界时才能恢复；后者若只有总耗时，无法把等待、思考与生成分离，不能靠补一个客户端接收时间解决。不为恢复历史速度额外发请求或自动改变调用模式。

缺失请求不填 0，不用模型均值、倍率或旧 E2E 补数，也不借用筛选范围之外的历史速度。缺失计数与原因复用内部诊断，供开发核查，不渲染到主界面或详情栏。

同一请求出现多份证据时，选择一份完整、语义明确的计时窗口：同观测点的首/末输出优于首输出/响应完成；同等边界按适配器固定的来源优先顺序选择，不挑最快的结果，也不把两个来源的起止各取一个。新增字段填补旧字段缺失，或较明确的窗口替换旧近似，均不应因为 `evidenceOrigin` 不同就被判冲突。真正相同事实的矛盾仍按既有冲突处理。每个响应最终只计一次，原始总 output 的对账继续使用原始总量，不能拿减过 reasoning/B 的性能分子与它比较。

样本粒度统一为一次已完成模型响应，P10/P90 使用同一批请求 TPS，样本数也是请求数。多个工具调用属于同一次模型响应时仍算一个样本；工具执行不算样本。一次失败重试后成功，使用成功响应自身的生成窗口，不把此前失败等待算进去，也不因存在重试记录就连带丢掉成功响应。

## 4. 补采优先级

先固定原生数据事实，再接入足够的字段。前轮 Magpie 对照只用于调查口径差异，不代表普通安装可取得的数据或覆盖率。

1. **核验原生历史记录。** 按实际格式检查请求身份、计数语义及时间边界。已核验的本机 Codex/Claude 没有足够时间；DSH 有流时间但缺计数语义；其余来源的具体缺口见核验记录。不能以仅支持虚构字段的夹具替代真实采集验收。
2. **学习采集方法。** 在工具原有流接收点，以同一时钟记录首/末有效非推理输出，保存最终 output/reasoning、请求身份及现成可得的首批 token 数。正文中的真实空格、换行、缩进也属于输出；只排除空字符串和无内容事件。只落必要标量，不增加 tokenizer 或逐 chunk 正文副本。
3. **接入工具实际落盘的数据。** 本仓库负责原生 reader、ID 关联、持久化与统一计算。需工具 producer 增加的字段逐项列出具体位置，待其真正可用后接入；不改本机安装包、不启用调试、不改路由，也不另建代理。没有可用证据的当前请求保留用量和空值，不能宣称原生采集已经完成。

补采验收必须覆盖纯工具响应。不能把工具执行开始时间、item 完成时间当成工具参数的生成起点。

正常的快慢样本均保留，不因“TPS 看起来异常”限速、缩尾或按固定倍率修正。只有计数/时间无效、范围不对应或事件证明窗口不可测时才不产生速度。首输出后只有 usage 或完成事件不算多个内容事件，不能把收尾时间当作一次性回包的生成时间。单凭缺少可选的 `flow_ms` 不淘汰有可用窗口的请求；它是内容字节分布的估算，不能当精确生成时长。旧网关的 100 ms / 10,000 tok/s 等阈值不直接复制成全渠道门槛。

## 5. 最小改动范围与历史迁移

方法版本升为 `tps-v3`，使用 `window=request`、`timingKind=generation`、`tokenScope=non_reasoning_output`。原始用量、计费与订阅额度计算不改；性能投影里的 output/duration 表示这一版的有效分子 `N−B` 与分母 D，证据保留原始计数和边界，便于重算。已有字段的 unknown/known 状态继续保留，不增加一套独立质量评分系统。

| 位置 | 必要调整 |
|---|---|
| `src/perf-stats.js`、`src/usage-types.js` | 按方法版本解释语义；统一生成样本、均值、请求级分位数和来源无关准入；缺样本模型行扩展到所有来源 |
| `src/perf-request-timing.js`、`src/perf-request-timing-store.js` | 保留通用边界/计数及证据版本；区分证据补齐、窗口替换和真实冲突，原始总量继续对账；旧证据仍按 E2E 读取。Magpie reader 移到离线调查参考，运行链路不加载 |
| `src/perf-sources/codex-jsonl.js`、`codex-fold.js`、`codex-candidates.js`、`codex-request-timing.js`、`codex-thread.js` | 保留 reasoning 等必要原始计数，按响应生成候选；复用线程归属、跨文件去重和冲突处理，解除完整轮计时要求 |
| 其余五个 `src/perf-sources/*` 及对应 usage/trace reader | 只增加本渠道能提供的必要字段和请求映射；输出同一生成语义，移除旧 E2E 自动进入速度表的路径 |
| `src/usage-store.js`、`src/usage-core.js`、`src/usage-executor.js`、`src/server.js` | 更新 SQLite timing 枚举约束、证据列、版本失效、增量发布和内存/store/API 一致性；重建性能投影 |
| `src/history-archive.js`、`src/history-backup.js`、相关 store 归档校验 | 旧 v1/v2 可读；v3 证据随归档、导出、导入和恢复保留；更新当前写死 v2 的判断 |
| `scripts/export-perf-request-timings.mjs`、`scripts/import-perf-request-timings.mjs` | 带上新增证据字段与版本，保留旧导入兼容；不把旧 E2E 证据补成生成计时 |
| `public/perf-ui.js`、必要的 i18n / app 接线 | 复用现有布局，读取 v3 数值和请求样本数；缺数据只显示现有空值，删除已不适用的“日志未记录请求耗时”常驻说明 |

Codex v3 的样本身份在现有 home/thread/turn 归属下增加 response ID，使请求样本与旧轮样本自然区分；原先的 response 全局重复/跨轮归属检查继续生效。其它来源沿用能定位单次响应的稳定键，真正聚合多次请求的记录先拆分，再进入样本数和分位统计。

历史按可恢复性处理：有原始生成计时的重建 v3；只有 v1/v2 数值的保留原版本供恢复和内部查看，不参与新速度表。不能仅把旧行的 method_version 改成 v3。旧库、旧归档的缺字段是旧数据的正常能力范围，不作为损坏库；新增证据晚到后仍可补算。

新旧 TPS 不在一次发布中混用。通过现有性能修订和发布机制整体切换，并使查询缓存、`since` 指纹和前端数据失效；新的冻结快照保留 v3 数值。旧快照保持原始内容与版本，打开旧快照时保留用量，旧 E2E 不以 v3 生成速度显示。

**实施基线为 `main@852034b`。** SYNC 的 Q2/Q3 已由 `32a3d5f` 提交，后续 `6356017`、`852034b` 是 Windows CI / 测试稳定性修正；相对 `0cee6ce`，产品代码仅变更 `src/usage-store.js`、`src/usage-executor.js`。施工前 schema 为 21、TPS 为 `tps-v2`，本轮工作区改为 schema 22 与 `tps-v3`。已有[生产切换记录](../validation/2026-10-27-performance-production-cutover/README.md)使用 `852034b` 固定发布包，本轮 TPS 改动未部署到该发布包。

Q2 已将静态用量的 `factsKey` 与性能的 `perfKey` 分开。v3 的计时补齐、分子变化和性能重建必须使 perf 更新，同时保留只受用量事实影响的 timeline/费用缓存；新增表或 meta key 按实际依赖接入现有 tracker，不退回“任意 perf 写入都重建全部用量”的旧路径。

Q3 已通过 `captureUsageProjection()` / `adoptUsageProjection()` 将静态用量复制给固定 WAL 快照的 reader，转交时不携带 perf。v3 保留这一边界：同步中的 TPS 从 reader 自己的快照计算，不能从 writer 一并复制。复用现有物理库、版本、证据上下文和生命周期检查，不另建一套缓存转交机制。

## 6. 页面行为

沿用现有表格列、五行高度、来源文字、速度条、右侧大数字和 P10–P90 区间。均值与区间换成生成速度，样本数换成有效请求数，已有日期和来源筛选继续作用于请求完成时间。

有一个有效样本就显示数值，所有渠道一致；本次不改变既有排序行为，也不把内部的 20 样本 rank 门槛变成页面隐藏条件。不新增“小样本不足”说明。全部缺失时使用现有 `—` 和空区间，不增加解释框体，也不保留旧 E2E 数值冒充新速度。同步和错误处理继续走现有产品机制。

口径、缺失原因、覆盖对比和迁移说明写在开发文档及内部诊断里。无需把本方案文字变成 UI 文案，不扩建详情、tooltip 或帮助入口。

## 7. 实施顺序与验收

1. **固定计算与盘点已有能力。** 用小夹具明确 N/B/D、内容事件与终点，再按原生数据列出各渠道的可计算量和缺失原因。分别核对计数与生成边界，不能以网关对照代替原生采集。
2. **交付本仓库的完整修正。** 实现 v3 内核、请求级样本和已有证据接入，优先解决本次 Codex 订阅问题；同步完成 store、归档、导入导出、执行器、API、缓存和冻结所需改动。在隔离副本回放并验证现有页面，原生真实样本验收通过后再按现有发布流程整体切换；当前缺口未闭合，不进入生产切换。
3. **按缺口增量补采。** 单独接入上游首/末输出及其它渠道新增字段。计时晚到后按稳定请求 ID 替换或补齐，不新增重复样本。六个来源共用同一规则，未具备字段的来源保留明确接入任务，不能宣称已全量覆盖。

必要测试集中在会改变结果的行为：

- 首输出前增加 10 秒等待，生成 TPS 不变；末输出后增加 10 秒工具执行、usage 收尾或连接关闭等待，使用首/末输出的 TPS 不变。
- 两个 token 相隔 20 ms 得到 50 tok/s；已知首批 token 数、仅有常规 N−1 边界和覆盖全量的显式阶段耗时各自映射正确；纯单次回包不制造高速样本。
- 同一生成响应与边界经各来源适配得到相同分子/分母；reasoning 已含、单列、已折叠三种输入均只处理一次；Claude 最终 output 与 thinking 成对读取。
- 纯正文、纯工具、正文与工具混合均正确；隐藏推理摘要不当首正文；无正文的有效工具响应不会因 `first_text_ms` 缺失而自动淘汰。
- 一轮 10 请求缺 2 条计时，只计 8 条；迟到补齐后变 10 条；重复导入不增加样本，失败重试不污染成功生成窗口。
- 两条并发请求的生成速度汇总不因重叠而翻倍；首/末输出证据替换响应完成点近似时只更新原请求，不触发无意义的来源冲突。
- 全缺失得到 `null` 和空区间；少量有效样本仍显示；旧 E2E 数值不进入 v3 均值、分位数和排名。
- 真实逐请求核对计数和时间：先在相同请求集合比较旧/新口径，再单独报告覆盖变化。按输入/输出长度、正文/工具、推理类型检查缺失是否集中在某类请求；不能只用长正文子集代表全部调用。已有完成点近似与新增末输出在配对请求上对照，检查尾部等待和首批边界造成的偏差，结果仅存开发验证记录。
- 同输入在内存、SQLite、API、导入导出和冷归档恢复中一致；切换版本、只追加计时、外部提交和冻结均正确失效或保持快照。
- 在新 SYNC 基线上，v3 计时单独晚到或被更完整窗口替换时，Q2 用量缓存保留而 perf 更新；Q3 同步中的 reader 复用静态用量但独立读取本快照的 v3 样本。扩展已有 `q2-usage-projection` / `q3-published-projection` 夹具，不只验证普通 writer 查询。
- 浏览器确认数字与请求样本数更新，五行布局和键盘操作保留，没有新增提示、徽标、解释区块或高度增长。

复用现有 `perf-*`、`history-cold-*-perf/timing-*`、`codex-incremental-tps-visibility`、UI 与 summary parity 测试，只补上述新语义需要的用例。文档方案阶段只检查引用和规则一致性；产品实施后运行相关测试、typecheck、lint/format 和一次最终全仓检查。

## 8. 依据

- [本次订阅渠道调查数据](../validation/2026-10-27-codex-subscription-tps/evidence.json)：830 个有效轮次、12,110 次请求全部对账相等；原始记录抽查 4,785 条。生成阶段与完整请求的差距随模型、推理强度和请求条件变化。
- [调查脚本](../validation/2026-10-27-codex-subscription-tps/audit.mjs)：保留既有 Magpie 算法的比较实现，用于回放对照，不作为 v3 的跨渠道规范。
- [TPS 内核](../../src/perf-stats.js)保留 v3 生成窗口计算；[Magpie 参考实现](../../scripts/perf-reference-magpie.mjs)仅保留离线调查用途，产品不加载。
- [Magpie v0.1.1666 流速算法](https://github.com/yetone/magpie/blob/v0.1.1666/internal/usage/usage.go#L561-L633)：有 reasoning 时从首正文起算，并从分子扣除 reasoning；其纯推理分支和经验阈值不直接作为本方案公共规则。
- [Responses 计数映射](https://github.com/yetone/magpie/blob/v0.1.1666/internal/gateway/responses.go#L1363-L1391)与[Codex 后端计时写入](https://github.com/yetone/magpie/blob/v0.1.1666/internal/gateway/codex_backend.go#L1350-L1384)。
- [Magpie 首输出分类](https://github.com/yetone/magpie/blob/v0.1.1666/internal/gateway/ttft.go#L180-L296)：首正文与首内容不同，工具开始事件可能早于实际参数输出；[Anthropic usage 映射](https://github.com/yetone/magpie/blob/v0.1.1666/internal/gateway/anthropic.go#L1336-L1365)在该版本未传递 thinking 分解。
- [本地 Claude 用量映射](../../src/claude-code-usage.js)已经保存 thinking 计数和 known 位；[证据合并](../../src/perf-request-timing.js)现已区分来源不同、证据升级和真实事实冲突。

## 9. 2026-10-28 施工合同与账本

基线 `852034b`；施工前工作区已有 UI 简化和文档改动，摘要及补丁保存在本地 `.codex-usage/tps-v3-20261028`。这些改动保留。worker 显式指定 `group/deepseek`、`max`，不生成后代；测试和真实数据重任务由 Main 串行运行，沿用项目 8 GiB 总预算，不触碰活动数据库或重启生产服务。

共享合同：原始 request timing 的 `reportedOutputTokens`、`durationMs` 仍是原始总 output 与请求 E2E，用于对账和旧版恢复。证据 schema v2 增加可空 `generation`，形状为 `{outputTokens: N, durationMs: D, startOutputTokens: B, timingKind: "first_last_output" | "first_output_response_end" | "explicit"}`。其中 N 是非推理输出，B 是起点已输出数；性能分子取 N−B。v1 无 generation，不能自动升级为生成时间。`normalizeGenerationTiming` / `generationPerfValues` 从 `perf-request-timing.js` 导出供各适配器共用；后者返回 `{outputTokens, durationMs}` 或 null。timing lookup 继续返回原始字段并增加 `generation`；native 请求的 reasoning 已知性必须保留。

- **T1 / W1，证据链：** 独占 `src/perf-request-timing.js`、`perf-request-timing-store.js`、`perf-magpie-timing.js`、请求 timing 导入导出脚本及对应独立 timing/Magpie 测试。接 schema v2、渐进补齐/替换、旧库迁移、现有网关字段与纯工具有效边界。Main 不写这些文件。
- **T2 / W2，Codex 原生链：** 独占 `src/perf-sources/codex-*.js` 及 Codex parser/fold/candidate/thread 的直接单元测试。保存原始 output/reasoning，按 response ID 出候选，单请求完成即可采样，不要求整轮完整；保留跨轮去重/归属冲突。使用 T1 lookup 合同，不修改共享内核、store 或全局夹具。
- **T3 / W3，其它渠道：** 独占 `src/perf-sources/{claude,zcode,opencode,dsh,workbuddy}.js` 与对应渠道直接单元测试。读现有真实生成字段，缺计时仍出可归属候选但不伪造 E2E 速度；Claude 对接可选精确请求 lookup，复用已知 thinking。依赖 T1 generation 合同，不写 usage reader、公共统计或公共夹具。
- **T4 / Main，整合：** 独占 `perf-stats.js`、`usage-types.js`、usage core/store/executor、history archive/backup、公共夹具、API/缓存/归档集成测试，以及已有 UI 文件所需的最小删除。完成方法/schema 迁移与 Q2/Q3 验收，更新本文状态。

T1–T3 已交付并进入 Main 验证；同一批 worker 继续以下已就绪卡，不新增 worker：T5 / W1 调整统计及迁移直接测试，保留 T1 文件的修复所有权；T6 / W3 接公共夹具及内存/store/API 对拍测试；T7 / W2 接 `history-archive.js` 与冷归档测试，保留 T2 文件的修复所有权。Main 继续独占 usage store/core、backup、Q2/Q3、Codex API/index、UI 和本文，已交接文件不再并行写入。

前轮已验证通用计算、请求独立采样、窗口替换、重复导入和持久化链路；当时以 Magpie 作真实计时来源。其串行全仓门禁 **3,435 tests / 3,410 pass / 0 fail / 25 skip** 只属于那个版本，不证明原生生成计时已交付。历史证据见[前轮记录](../validation/2026-10-28-generation-tps/README.md)，本轮移除依赖后的验证另记。

通用内核、schema 22、请求级采样和恢复链路已实现；“本仓库范围已完成”的原结论已撤回。六来源都必须按 §2 的原生事实逐项接入，不能把 Codex/Claude 的缺口隐藏成要求用户安装 Magpie。没有提交、推送、部署或重启生产服务。

**T12 模型约束偏差与 T13 复核：** W3 恢复后的一个测试适配轮实际记录为 `gpt-6.1-sol/xhigh`，Main 未在恢复后核验，违反 pinned-workers 要求。该轮只改 `test/workbuddy-store.test.js`。已停止原 worker，由新建且核实 `group/deepseek/max` 的 worker 独立复核，27 项原测试及关键行为覆盖完整，无需改动；复核 worker 已关闭。调用和逐轮模型证据见[验收记录](../validation/2026-10-28-generation-tps/README.md)。后续派卡必须核验实际轮配置，不再假定恢复会保留模型。

## 10. 原生来源修正

按用户指正及 RANGE 的本地边界，移除 memory/store/status/executor 对 Magpie 的读取、导入、指纹及发布状态；原 reader 迁至离线参考。旧离线导出只保存历史 E2E，不再从网关字段生成 v3 窗口。通用计时证据和历史兼容保留，测试中的显式证据仅用于核验计算链路，不作为真实原生采集证明。

N1/N2 两名 worker 显式指定并核实 `group/deepseek/max`，分别核验 Codex/Claude 和其余四来源。实际原生字段、样本范围与 producer 缺口记录在[原生计时核验](../validation/2026-10-28-native-generation-timing/README.md)。本轮不修改安装包、不增加代理，不读取 Magpie 真实账本，不主动请求账户；不涉及 RANGE 的额度归属或周期算法整改。

完成条件是各来源确有同范围原生计数和生成边界，并在普通未安装 Magpie 的环境实测。现阶段只能交付通用内核与依赖移除，原生采集仍未完成；不能把缺数据全部留空后宣称模型生成速度功能已完整交付。

本轮全仓运行发现两个 UI 子测试仍依靠旧 ledger 夹具（另记父测试失败），其余测试通过；改为显式合成证据后，完整 UI 文件 19 项复测通过，产品可执行代码未再变化。最终静态检查、375 文件哈希及六个既有文件保护检查通过；全仓首轮与定向复测按实际运行分开记录，见[工程验证](../validation/2026-10-28-native-generation-timing/README.md#工程验证)。这不替代尚缺的原生真实样本验收。
