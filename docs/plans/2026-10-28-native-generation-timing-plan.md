# 原生生成 TPS：缺口探索与实施计划

日期：2026-10-28；执行更新：2026-10-29。状态：**首批隔离实现与验收完成，未部署。** 按用户接受的建议，首批为 Codex 原生摘要原型及读侧、WorkBuddy 历史纯正文恢复、DSH 条件计数映射及流读取。具体实现和检查以[实施验收记录](../validation/2026-10-29-native-generation-implementation/README.md)为准；下文的普通安装覆盖门槛继续有效。验收期间 RANGE 在共享目录继续施工，TPS 通过固定哈希副本验收，不宣称最终组合工作树已全绿。

目标是让未安装 Magpie 的普通用户也能从工具自身记录获得模型生成速度。实施分两条线：先验证并利用已有原生记录能恢复的请求；同时在确实缺字段的客户端流处理点补记逐响应摘要。不能把缺口变成对中继、改路由或启动新代理的要求，也不能仅交付计算内核就宣布采集完成。页面沿用现有数值、样本数和区间。

本计划承接[生成速度口径](2026-10-27-generation-tps-plan.md)，补充前稿缺失的采集位置、安装版本、失败分支、任务依赖和验收办法。工程基线仍为 `852034bac2932b67189e34c66819364a792c2023`；以当前工作树为施工输入，保留已完成的 SYNC/Q2/Q3 和前轮 v3 修改。

2026-10-29 续验见[普通安装与官方 usage 核验](../validation/2026-10-29-installed-generation-validation/README.md)：当前普通 CLI/Desktop 引擎均无生成摘要，完整补丁 CLI 构建及 22 个本地验收路径通过；唯一一次获准的 DSH 官方请求 HTTP 200，但开始/结束 usage 均未返回可选 reasoning 明细。普通安装接入与 DSH 服务端计数契约仍需完成，未部署。

同日后继研究已形成[普通安装接入与 DSH 方案](2026-10-29-local-generation-adoption-plan.md)：Codex 的进程级 `CODEX_CLI_PATH` 选择器通过真实函数 10 项离线检查，建议完整并排包加专用启动器；DSH 从 881 条官方成功响应中恢复 873 条可配对全部生成窗口，建议新方法版本允许全部生成范围，区分显示数值与非推理排名。该方案取代“所有 DSH 工作都先等待 reasoning 明细”的后继顺序；本计划下述非推理公式仍描述已实现 v3，尚未部署或切换 v4。证据见[本轮核验](../validation/2026-10-29-local-generation-adoption/README.md)。

## 1. 本轮探索改变了哪些判断

### Codex：已有 OTel 不能直接补齐

检查了独立 CLI `0.164.0`、Desktop 内置引擎 `0.165.0-alpha.1.2` 及其对应公开源码，并用已安装二进制完成四种本机固定响应探针。

- data-only SSE 的日志把九个不同类型事件都记成 `message`。
- 带 `event:` 的 SSE 虽记录 text delta，却不区分空 delta 与有效输出；完成事件还有原始完成与 usage 完成两条同名记录。
- WebSocket 没有逐块 log，只有共享 usage 完成记录。
- 流日志缺响应 ID 和可用 trace 关联；TTFT 以 `OutputItemAdded` 为触发点，可能早于正文或落在 reasoning。
- typed 事件层忽略普通函数参数 delta；只监听这个下游层会漏掉工具生成。

因此撤回“启用原生 OTel，再做接收器即可”的路线。正确先后次序是**补齐 producer 摘要 → 验证载荷 → 接已有读侧**。[源码与运行证据](../validation/2026-10-28-native-generation-timing/discovery/codex.md)、[四例探针结果](../validation/2026-10-28-native-generation-timing/discovery/codex-probe-summary.json)。这四例证明事件语义，未测试真实模型速度或普通 Desktop 宿主启动路径。

### WorkBuddy：已有正文间隔，值得先验证可恢复子集

现有 `qua.end` 日志已保存 `text_total_cost_ms` 与 `message_id`。本机有 729 条可解析 end，其中 94 条正文间隔为正；716 条能唯一匹配 session usage，706 条能唯一形成 log/session/trace 三方关联。

这些数量**不是有效 TPS 样本数**。正文间隔不覆盖工具参数与 refusal，end 也不独立证明输出类型和阶段完整性。下一张卡先确定其中多少响应能由同身份记录证实为完整纯正文，再决定是否实现读取；不能用 94 或 706 宣称已经恢复速度。完整输出仍需 producer 补记。[计数、持久化与关联证据](../validation/2026-10-28-native-generation-timing/discovery/zcode-workbuddy.md)。

### ZCode：部分 token 语义已闭合，时间仍缺

当前 `3.16.3.8992` bundle 中定位到 Responses 与 OpenAI-compatible 两条 adapter：总 output、reasoning、非推理 text 分开映射，最终 usage fact 写入 `model_usage`。这些已知路径可以采用 `N=output-reasoning`，但不能扩大成所有 provider 都已核验。

`ModelStreaming` 是 transient；现有 `first_token_at` 混合正文和 reasoning，现有日志/Model IO 未保存末输出。因此只能先恢复有证明的 N；生成窗口需要 producer 新增。[具体符号、字节位置和限制](../validation/2026-10-28-native-generation-timing/discovery/zcode-workbuddy.md)。

### DSH：非推理拆分缺失，全部生成已有恢复路线

原生成功 `assistant/message.data.stream` 保留 chunk 接收时间。压缩 `dt` 是相邻毫秒差，展开规则是 `time[i]=time[i-1]+dt[i-1]`；失败 attempt 另存，不应混入成功响应。

当前 DeepSeek adapter 未映射权威 reasoning count，也未保留原始 provider usage，严格非推理范围仍不能恢复。同日扩展核验确认丰富的原生 reasoning/text/tool 流可与同响应总 output 配对；全部生成范围可以按来源限定的 Messages 契约推断推进，具体依据、873 条候选及跨范围比较规则见[后继方案 §3](2026-10-29-local-generation-adoption-plan.md#3-dsh-缺-reasoning-明细的解决路线)。早期[producer 与压缩时间证据](../validation/2026-10-28-native-generation-timing/discovery/dsh-opencode.md)保留历史归属。

### OpenCode：打开事件持久化也拿不到所需时间

当前安装 `@opencode/desktop 2.0.20` 的内部开关是 `events.persist`，默认 false，当前桌面启动路径未开放对应用户配置。更关键的是：text/reasoning/tool-input delta 为 ephemeral；text 发布存在约 100 ms 合批，tool input 还会聚合到结束后才发布。

因此前稿“打开 durable event 后读 `event.created`”不成立。应在合批前记录边界，把两个时间标量随成功 step 写入最终 assistant message。provider retry 复用 assistant ID，计时状态必须按 attempt 重置。[安装版本与实际事件链](../validation/2026-10-28-native-generation-timing/discovery/dsh-opencode.md)。

计数侧已追到当前安装 producer 的 `visibleOutputTokens → tokens.output` 赋值链，确认原始 message 中的 output 已扣 reasoning，不再减第二次。剩余 producer 定位工作是 Retry 的成功提交/失败重置接缝。

### Claude Code：公开入口只有局部候选，不能包办普通会话

官方 OTel 与 beta request trace 有请求量、TTFT/首内容偏移和总时长，缺末输出；hooks 是展示/回合事件。`-p --output-format stream-json --verbose --include-partial-messages` 可作为自愿采用的主会话观察候选，但改变启动模式，不覆盖普通交互 CLI、Desktop 或子代理 delta。

本机没有可独立运行的 `claude` CLI；当前 Desktop Appx 为 `3.6556.2.0`，旧 telemetry 中的 Code runtime `2.1.299` 只是历史证据。不能把文档支持当成当前版本已运行通过。[官方资料、安装面与候选验证步骤](../validation/2026-10-28-native-generation-timing/discovery/claude.md)。

## 2. 对缺口的具体处理顺序

1. **先做原生记录恢复验证。** WorkBuddy 检验纯正文子集；DSH 查清 N；ZCode 固定已知 adapter 的计数。只有同时形成同响应 N/D 的路径才交付读侧，不为“看起来有进展”接入半套 parser。
2. **Codex producer 原型优先。** 它直接对应用户最初的订阅渠道问题，且公开源码、两个版本和离线运行证据均可定位。准备独立源码补丁与隔离构建；普通 Desktop 覆盖以实际采用该补丁的引擎版本验收。
3. **其余缺时间的工具复用同一摘要语义。** 每个工具在自己的既有流处理与持久化链补两个边界，读侧复用已有归一化，不增加跨工具代理平台。
4. **最后才考虑受限的可选采集模式。** Claude headless wrapper、OTLP 接收等只服务明确采用这些模式的用户，不作为默认覆盖条件。

单靠被动读取，无法为从未落盘的事件补造历史时间。完整普通安装覆盖需要工具 producer 实际保存摘要；这是后续交付内容，不能用历史空值代替完成。

## 3. 统一口径与可比性

```text
N = 同一响应的非推理输出 tokens
B = 计时起点已经包含的输出 tokens
D = 末个有效输出 − 首个有效输出
TPS = (N − B) × 1000 / D
```

- 通常只有输出事件、没有真实首批计数时，沿用 `B=1` 约定；不从 SSE 条数或 `message_start.usage` 推 B。若 producer 真能提供首批 token 数则采用该值；覆盖全部 N 的真实生成阶段耗时才用 B=0。
- text、代码、refusal 与实际生成的工具参数进入同一范围。只有工具元数据中的完整 name、工具 ID、block start 不自动算生成；工具名只有在 producer 证明它是生成增量时才纳入边界。
- 空串无效；真实空格、换行和缩进有效。reasoning、usage、done、连接关闭和落盘不更新边界。若协议把 reasoning/服务端工具等待穿插进正文，必须证明阶段与分子匹配，不能任意删除 chunk 间停顿。
- `N-B<=0`、D 非正、整段一次性交付、身份不唯一或计数未知时不产生 TPS。正常返回且有最终 usage 的 length/tool-use 等终态由各 adapter 明确映射；网络中断、取消、失败 attempt 不凭部分 usage 伪装 completed。
- 均值保持总有效分子/总生成时间；P10/P90 和样本数使用同一请求集合。一个轮次 10 个请求只有 8 个可测，就用这 8 个。
- 请求前等待、失败重试、响应后工具执行均不进入成功响应 D。并发请求各自累计时间，不使用并发覆盖的墙上时间。

这里统一的是**客户端同一观测点看到的生成阶段速度**。流合批、网络 pacing、背压与 tokenizer 差异仍有实际影响；不能将它称为服务端逐 token 的纯推理引擎速度。验收在来源内部按模型、effort、实际服务档位、上下文/输出长度、正文/工具类型分层，再比较不同渠道；页面维持当前分组与呈现。

采集位置、端点类型、计数契约与边界近似只保存在内部证据。跨渠道不借平均延迟校正，不统一乘 2，不用缺失样本均值填补，也不新增 UI 解释或开关。

## 4. 最小 producer 契约

### 4.1 只保存一次响应摘要

以下是待实施字段语义，不是已经存在的新公共接口。各工具用已有记录格式承载，不先建设通用事件平台。

| 内容 | 必要性与用途 |
|---|---|
| native response/message ID、来源版本、原有 session 归属 | 精确连接 usage 与计时，限制到同一个 home/source；不能按相近时间或模型名配对 |
| 成功 attempt 身份或明确的成功提交规则 | 同一消息 ID 可被 retry 复用，防止拼接失败输出与成功 usage |
| 首/末有效输出的单调时钟偏移 | 在同一请求基准内计算 D；墙上完成时间仅用于日期归属 |
| 同一 attempt 的原始请求时长与最终完成时间 | 满足现有 evidence v2 的诊断时长约束；不把 D 冒充请求总时长 |
| 原始 output、reasoning 及 known/包含关系，或权威非推理计数 | 得到 N，缺字段与已知 0 分开；来源不提供的信息保持未知 |
| 现有 model/provider/effort 与完成状态 | 复用历史真实身份；不从当前配置给历史补值 |
| 契约版本与必要的输出类型/阶段标记 | 让消费者确认覆盖 text/tool/refusal，识别只支持正文的旧格式 |

普通流没有首批计数时无需增加它；也不保存每个 chunk、正文、工具参数或账户字段。首末更新是原生内存标量操作，完成后仅追加一条摘要。同步逐块写磁盘、逐块格式化 JSON 和全量 trace 均不在方案中。

### 4.2 时钟、合批与恢复

- 新 producer 在原始流消费点捕获单调时间，位于 UI/批量发布/工具执行之前；计时更新本身不得等待文件或 exporter。
- 可在原生摘要保留微秒偏移；进入现有整数毫秒合同前统一换算一次。亚毫秒结果不硬凑为 1 ms；若今后确有大量这类有效样本，再单独调整持久化精度。
- 已有 DSH 使用墙上毫秒时间，须检查有效成员时间有序及安全整数；发现时钟回退不改写原始事实，也不靠排序掩盖。
- exporter 可以延迟、重发和合批，但摘要内的 D 已在 producer 确定。接收时间、文件 mtime 和 event publish 时间均不重建 D。
- 终态摘要与 usage 使用同一 attempt 封口。摘要早于本地 usage 投影时，复用已有扫描/晚到补齐机制；只有关联后才发布，重复读取不重复计样本。

客户端现有流循环自身仍可能受背压影响；新计时器不应再增加这种等待。慢消费者/大块交付要单独做探针，不能在没有证明时承诺“完全不受客户端影响”。

### 4.3 持久化与本仓接入

默认路线是**原生本地记录 → 当前来源 reader → 既有 v3 统计/存储**。Codex 优先伴随原生 rollout/usage 记录追加摘要；OpenCode 写最终 message；ZCode 写同一 usage fact；WorkBuddy 写现有 monitor/trace；DSH 复用 stream 和 usage。

如果某工具只能经 OTel 输出合格摘要，再考虑复用已有 UsageServer 接收端，只接收已验证的一类标量摘要。先证明 producer 能产出，后写接收器；不另起常驻服务、不修改模型路由，不为 TPS 开启原始 request/response body 日志。

当前 `normalizeGenerationTiming()` 可以复用，但 `UsageStore.importRequestTimingEvidence()` 的 native link 仍依赖 Codex 投影。不能把这个入口假定成六来源通用导入：Codex 沿用它；其他来源先走自己的 reader 与身份链，只在真实共享需求出现时扩展窄接口。来源身份与字段有效性验证留在代码内部。

## 5. 各来源的实施落点

### 5.1 Codex

**Producer 原型：**

1. 在 `codex-rs/codex-api/src/sse/responses.rs` 的 SSE 解码点与 `endpoint/responses_websocket.rs` 的 WS 解码点，复用一个小型响应计时状态。捕获时间早于下游 `.send().await` 与 typed 事件过滤。
2. 从原始 JSON type 和载荷识别 text/refusal/function arguments/custom-tool input；普通函数参数不能因当前 typed 层忽略而漏采。
3. 每个生成 attempt 独立，`generate=false` prewarm 不采样；WS 连接复用、fallback 和 retry 不继承旧边界。
4. 将 response ID、最终 token usage 与摘要通过既有 client/core 路径带回原生持久化。新增记录名称、Rust protocol 与兼容序列化在该卡内一次确定，不新开面向 UI 的功能。
5. OTel 若同步输出，使用同一份完成摘要，不从现有 `codex.sse_event` 重新推导。

**本仓读侧：**`src/perf-sources/codex-jsonl.js`、`codex-fold.js`、`codex-candidates.js`、`codex-request-timing.js` 只读取已实施且版本明确的摘要；映射现有 v2 generation evidence。未知新事件应保留旧用量读取能力。store/core/executor、history 与公共测试由 Main 单写整合。

**覆盖门槛：**隔离自定义 CLI 构建通过，不等于 Desktop 覆盖。分别记录普通 CLI、普通 Desktop 的实际引擎版本和启动路径；只有真实采用 producer 的安装才标为已覆盖。不热改用户当前二进制。

### 5.2 WorkBuddy

先做 `WB-R0`：对唯一 messageId 关联的 `qua.end`、会话和必要 trace，核对终态、reasoning known 位、正文类型及阶段顺序，输出**真正满足同范围 N/D 的数量**。重点排除纯工具、混合、refusal、server-side tool，以及正文之后/之间无法分离的额外阶段。若现有记录无法证明，不把候选间隔升级成 TPS。

只有 WB-R0 存在可证实子集，才在 `src/workbuddy-usage.js` 与 `src/perf-sources/workbuddy.js` 增加最小日志读取与 join。按已有文件发现、指纹和增量读取模式工作，不能每次 SYNC 重扫本机约 764 MB 日志。零交集/旋转/晚到/重复 end 都有固定夹具；不要求三方记录处处齐全，只要求实际用于该样本的证据充分且唯一。

完整 producer 在 `SseStreamMonitorImpl` 的 parser 回调传入实际 text/tool/refusal 输出，补统一首末时间；`hasToolCall` 布尔不够。摘要与 `message_id` 同行写入 `qua.end`，需要时复用 `TraceCollectorProcessor.onSpanEnd` enrichment。`textStats.tokens` 是事件次数，永远不用作 token 数；旧 generation span 总 duration 仍仅诊断。

### 5.3 ZCode

先用 `raw_usage_json`/adapter 证据将已知 Responses、OpenAI-compatible 路径映射为 `N=output-reasoning`；两值须 known，未知 provider 不推断。当前缺 D 的行继续保留候选。

producer 在 `observeVisibleStreamEvent` 相邻的原始 `ModelStreaming` 消费点记录首末；不复用含 reasoning 的 `firstModelTokenAt`。两个偏移与相同 usage attempt 写入 `model_usage`，贯通 producer migration/insert/upsert；本仓在 `src/perf-sources/zcode.js` 做能力探测，旧 schema 正常读取。tool/refusal 必须核实实际生成事件，不按名称猜测。

不使用字符串替换直接修本机 minified bundle。交付可审阅 producer 补丁/字段契约；真实覆盖以携带该变更的版本验证。

### 5.4 DSH

已实现 v3 的严格非推理路径仍要求权威 reasoning 可扣除，或权威 output 已排除 reasoning。唯一一次官方实测无可选 detail，不能把映射补丁当作该路径已闭合。后继优先按[新方案](2026-10-29-local-generation-adoption-plan.md)研究 v4 全部生成：总 output 与 reasoning/text/tool 的完整首末窗口配对，不再把缺拆分作为所有读侧工作的前置阻塞。新方法尚未实施，不把 873 条候选宣称为当前 v3 有效样本。

读侧继续复用 `src/perf-sources/dsh.js`、成功 `assistant/message.data.usage` 与 `.stream` 及现有解压链。按每个 packed run 的 `time0 + 累计 dt` 恢复边界，所有成员按原顺序校验。工具 name 已核验是 block-start 元数据，只有非空实际参数增量进入边界；失败 attempt、重试等待、step/end 不扩大 D。

相应调整 `scripts/perf-probe-sources/dsh.mjs` 的旧 Proxy 限制和 reader 注释：允许检查必要流事件类型、时间与字符串长度，但不把内容带入候选、数据库或 API。不再把“旧 probe 没读 stream”解释成没有原生时间。

### 5.5 OpenCode

在 `SessionRunner.publishLLMEvent` 的合批前 text/tool-input 消费点按 provider attempt 记录首末。先定点确认 Retry 的成功提交与失败重置位置；同一 assistant ID 不能把多个 attempt 拼起来。continuation/compaction/overflow 创建新 message，边界随之重置。

成功 attempt 的摘要随 `session.step.ended` 进入现有 projector，落到 `session_message.data`；本仓 `src/perf-sources/opencode.js` 读取标量和对应原始 `tokens.output`。沿用本轮已核实的 producer 计数链，为它保留直接回归，不只依赖本仓注释。

不需要 `events.persist=true`，不需要逐 delta durable 事件，也不使用批量 publish 的 `created` 或含工具执行的 `time.completed`。当前旧消息缺边界，不能通过打开开关回填。

### 5.6 Claude Code

默认路线需要 producer 在内部 API stream 消费点保存 text/input-json 首末、最终 usage/thinking known 位与 `message.id`，并覆盖主/子代理及 CLI/Desktop。现有 hooks/聚合 OTel 不是替代。闭源运行时没有经验证的补丁部署通道时，先交付可复核的字段需求和最小事件夹具，不冒称读侧已可解决。

独立可选 `-p stream-json` 候选只在用户实际选择该运行方式时进入实现：先确认当前 CLI 版本/help，再用假 child 验证 wrapper 不改变输出、退出码和时序，最后在真实流量验证主会话的 line receipt 边界。事件中 `message.id` 可与现有 transcript 关联；`message_start.usage` 不作 B，`content_block_start` 的工具名不作生成。stdout pipe 合批与子代理缺 delta 未解决前，不发布为普通原生覆盖。

## 6. 可派发任务卡与依赖

本表保留全部施工依赖；首批实际进度见实施验收记录，不把后继卡写成已经执行。继续使用 pinned-workers 的 `group/deepseek/max`；按就绪卡决定人数，复用 worker，逐卡验收。共享 store/core/history/config 由 Main 单写；WorkBuddy reader 与日志解析由 worker 负责，core/store 缓存、晚到重算和持久化接缝由 Main 整合。生产安装、配置和数据库不在 worker 写入范围。

| 卡 | 工作与独占范围 | 前置条件 | 完成交付 |
|---|---|---|---|
| P0 / Main | 固定当前工作树、最小摘要语义、来源身份与终态；维护本计划 | 本轮发现完成 | 契约、夹具清单、受保护文件基线 |
| C0 / W1 | Codex 隔离源码中的 SSE/WS producer 原型及其直接测试；输出单独补丁 | P0 | 普通函数/自定义工具/text/refusal 的同响应摘要；离线运行载荷 |
| W0 / W2 | WorkBuddy 纯正文恢复可行性与唯一关联，只读研究工件 | P0 | 可发布子集数量或明确无法证明的字段；不预写 parser |
| D0 / W3 | DSH 计数契约及最小 provider 映射补丁；独占来源工件 | P0 | 可复核的 N 公式、known 位、成功 attempt 关联或准确缺口 |
| C1 / W1 | 本仓 Codex reader 与直接回归 | C0 载荷通过 | 新摘要到 v3 evidence，同请求不重复，旧日志不失用量 |
| W1 / W2 | WorkBuddy reader 或完整 monitor producer 补丁，按 W0 结果选一张就绪卡 | W0 | 有完整 N/D 的端到端子集；不交付只能暴露诊断值的半套功能 |
| D1 / W3 | DSH stream reader 与压缩/retry 回归 | D0 计数闭合 | 同成功 message N/D；旧格式保留；不重造计时器 |
| Z0 / 已空闲 worker | ZCode 已知计数适配与 producer 持久化补丁，独占来源文件 | P0；资源空闲 | 两个时间随同 usage attempt；旧 schema 兼容 |
| O0 / 已空闲 worker | OpenCode attempt hook、标量 projector 与 reader | producer 计数已核实；Retry 点仍需确认 | 合批前时间直达最终 message；不打开 event 库 |
| A0 / 后继卡 | Claude 默认 producer 交付路线；可选模式另立窄卡 | 明确可验证的运行时入口 | 不混淆默认/可选覆盖；正式支持版本有实测 |
| I0 / Main | usage core/store/executor、缓存/历史/导入导出与共享夹具 | 至少一个来源完整贯通 | 内存/store/API 一致；晚到局部更新；SYNC/Q2/Q3 行为保持 |
| G0 / Main | 普通安装真实验证、UI 几何与最终发布准备 | 相应 producer 实际可用 | 每来源独立验收状态；未通过来源不冒称完成 |

C0、W0、D0 可以独立推进。W0/D0 没闭合只阻塞自己的 reader，不阻塞 Codex 原型。Z0/O0 等前面 worker 释放后接续，不为占满并发增员。重型构建与浏览器/全仓测试串行，遵守 7 GiB 重任务 + 1 GiB 控制侧预算。

闭源 producer 卡的交付可以是精确、可审阅的上游改动需求与离线复现，不等于普通安装已经支持。若没有可交付的客户端版本，G0 对该来源保持未完成，不用 wrapper、自定义 CLI 或合成 fixture 替它过关。

## 7. 验收安排

### G1：时序与数学，固定响应即可完成

- 两个输出 token 相距 20 ms，B=1 时为 50 tok/s；不是 100。N 与 reasoning 的映射每个 provider 单独测。
- 首输出前增加 10 秒或末输出后增加 10 秒工具等待，TPS 均不变。
- 空 delta 不改变边界；真实空格、换行、缩进和工具参数空白改变边界。
- 纯正文、纯函数参数、custom tool、refusal、正文+工具、reasoning 后正文均有对应夹具。
- 首批多 token、最后 usage 延迟、单块交付、D=0、未知 reasoning、计数不自洽不产生虚假速度。
- SSE data-only、named SSE、WebSocket 使用相同 payload/时序时生成相同摘要；不依赖外层 SSE event 名。
- retry/fallback/prewarm、并发、连接重用、compaction、重复终态和 exporter 重发不污染身份或重复样本。
- 允许所有满足同语义的有效快请求；不照搬 Magpie 的经验速度上限/最小时长过滤。

### G2：当前工程链路，复用已有门禁

每张来源卡跑其直接回归；稳定后 Main 做一次受影响集成，再做要求的完整检查。重点是候选不丢、同响应窗口升级、重复读取、late timing、选定日期、冷归档恢复、备份/导入导出、冻结快照和发布指纹。重新扫描不能把成本或用量加倍，也不能重算无关静态用量。

沿用 `src/perf-request-timing.js`、已有 timing store/history 协议与 source reader 测试。只有实际新增持久化字段才做必要 migration，不预先为六来源新建一套库。`UsageStore.importRequestTimingEvidence` 的 Codex 身份限制必须在集成测试中保留，其他来源不得误连。

UI 使用现有几何、浅深主题、双语与悬停回归；只验证原有表格、行高、速度条和空值。没有新增说明、警告、徽标、覆盖率面板或 tooltip 的任务。

### G3：采集开销与普通安装真实样本

- 隔离 fixture 比较 producer 开/关，记录新增 CPU、内存和写入量，确认每响应一条摘要、没有逐块磁盘/JSON/export。完整 trace 不是基准配置。
- 慢消费者、stdout/队列背压、大块交付和 exporter 延迟分别验证。source 时间保持不被 exporter 到达时间替换。
- 对已支持的来源，在实际用户安装路径检查版本、启动配置和一段完整请求链；分别核验正文、工具、推理强度与子代理。用自然产生的调用优先，不为统计补样额外消耗订阅。
- 客户端本地观测值与 fixture 的已知发送时序对照；真实模型只能证明该运行环境的行为，不能从一次实测推出所有 provider 均无缓冲。
- 本轮四例 Codex 探针不计入真实 TPS，前轮 Magpie 配对请求也不作为本计划原生覆盖数。

## 8. 完成与发布边界

分开记录三项结果：**计数/时间契约已证实、隔离实现已贯通、普通安装已验证**。前两项不能代替第三项。六来源逐项接收，不设“全部缺失所以统一空值也算完成”的终点。

Codex 目标优先要求：无 Magpie 的实际 CLI 与 Desktop 支持版本产生正确的逐响应摘要；合格响应进入当前速度表；缺数据只影响自身；tool-only 和 retry 不能漏算或错算。其他来源按同一规则验收。

未记录的历史边界保持未知；历史存在可靠同范围字段时才回填。关闭 producer 后继续显示已经验证并持久化的历史样本，未来缺计时请求保留用量。发布/回滚沿用既有部署与备份流程，不在研究中更换生产服务。

## 9. 本轮交付与未完成项

本轮交付六来源的深入发现、Codex 四例实际引擎离线探针、固定源码/安装身份、具体采集点与以上任务卡。三名研究 worker 的执行配置及 Main 验收另附[探索验收记录](../validation/2026-10-28-native-generation-timing/discovery/README.md)。

REA 对 ZCode/WorkBuddy 产出部分文件事实，但主 bundle 语义分析遇到 heap/resource 限制。它不替代文中未知项，也不要求再跑全量 bundle 重构；后继按 adapter/attempt/持久化的小范围契约验证。

2026-10-28 的探索未实现 producer/reader；2026-10-29 的首批施工另见实施验收记录。尚未运行真实订阅捕获、未启用用户遥测、未改安装包或生产数据库、未提交或部署。当前 v3 通用计算与历史工程结果保留原有版本归属；隔离实现不能改写为普通安装已全部覆盖。

2026-10-29 后继实施以[本地接入方案 §7](2026-10-29-local-generation-adoption-plan.md#7-实施账本)及[验收记录](../validation/2026-10-29-local-generation-implementation/README.md)为准：Codex 完整并排包和专用启动器、DSH 官方全部生成 reader、TPS v4 与 v3 归档兼容已整合；官方 DSH 不再等待 reasoning 拆分。普通 Desktop 实际采用仍未执行，用户当前 Desktop 与 RANGE 保持运行，未部署。
