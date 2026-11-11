# TPS harness 修复执行方案

已暂停（2026-11-01）：用户决定先把 TPS 封存成可复用的独立研究盒子，再准备[无 TPS 发行版](2026-11-01-tps-removal-release-plan.md)，之后重构技术栈。本文保留已完成结果与边界，并收入研究盒子；不继续派发采集、插件或热启停实现卡。

## 2026 年 11 月 1 日收敛决定

用户已选择“允许原生 token，优先免安装”。目标调整为：普通用户连接已有来源后，优先从客户端本机记录取得可用的生成速度；统一分词采集作为已有能力保留，不再是所有来源的必备条件。下文的上游补丁、接口研究与全量 v8 覆盖计划保留为历史记录，不再驱动默认安装路径。

本轮进一步核验后，用户明确选用了 **DSH 客户端日志流速估计**。已有日志中的最终原生 token 总量缺少首批计数，不能直接配首末输出时间；恢复路径使用日志中已保存的正文/工具参数重新作参考分词，以独立 `tps-log-v1` 方法记录客户端模型流时间。它复用现有依赖，普通用户无需安装插件。

本次纠正三个问题：当前内核只允许最新方法参与数值统计，部分来源仍固定产出 v5 候选；为取得完全一致的传输窗口，普通安装被引入多套插件、日志配置和启动器；独立插件复制了完整分词包。已有测试通过只能说明受测路径成立，不能代表普通用户已可使用全部来源。

### 收敛后的规则

- 优先消费原生生成时长或原生计数增量与对应时间。原生 token 和参考 token 内部保留单位；同一模型行在所选范围内采用一种口径，不把两种计数相加。保留已有有效 v8 结果，同一请求只计一次；原生路径证实后才替换该行的主口径。
- 原生 token 不自动解决计时缺口。首个 chunk 不一定是一个 token；不能重新采用全回复计数除以局部时间、TBT 倒数或整次请求耗时。已知错误的旧测量不恢复；旧版本是否可读与是否可参与当前统计分别处理。
- 默认接入以读取现成日志和数据库为中心。不再把定制引擎、上游未合入补丁、私有 bundle 修改或转发服务当作产品安装步骤。
- 已经可用的 Codex 日志、DSH 标准插件、WorkBuddy CLI 和 OpenCode 子集继续保留。插件走客户端正式安装入口；历史有效测量在关闭采集后仍可读取。现有用户配置不随本轮评估自动改变。
- 页面继续使用现有 TPS 数值、样本数、区间与降序。口径来源保留在数据契约和文档，不增加常驻说明、警告或新控件。

### 最小施工顺序

1. **先去掉确定的包体浪费，已完成 DSH。** 保留现有分词入口的五个运行/来源文件，无需切换 lite 或改变统计：压缩包从 10,661,525 降至 2,557,982 字节（减少 76.01%），解包从 23,751,729 降至 5,789,150 字节。独立目录加载、分词、目的目录保护测试通过；最终 tar 中五个依赖文件及十个采集运行文件均与原件逐字节一致。审查包未安装，原 `dist` 和已安装插件保持原样；主程序发行包缩减尚未实施。
2. **原生 reader 按来源恢复。** 每个来源先给出一条现存记录的计数、时间、身份与独立复算；成立后接入该来源，缺少的字段明确记录。DSH 的 canonical stream、WorkBuddy 的 `qua.end`、ZCode 的 TTFT/usage 是候选证据，不直接把它们视作已经恢复的能力。Claude/OpenCode 普通记录缺生成边界时，不以扩大采集工程代替结论。
3. **收口统计和安装。** 复用现有 reader、样本身份、汇总与归档；取消“所有来源都达到同一采集层才能交付”的全局门槛。旧方法在读取边界保留归属，不再把新采集改动传播成整套历史重写。删除没有使用路径的运行代码须先确认引用与包清单，实验材料不混入发行包。

每张实现卡必须同时说明普通用户的安装步骤、实际支持子集和新增资源成本。验证只覆盖这张卡可能破坏的行为：计数/时间错配、身份重复、既有数值与历史读取、脱离源码目录的安装。稳定后集中运行受影响的集成检查；无代码变更不重跑全仓测试。RANGE 和其他进行中的改动保持独立。

DSH 免安装日志 reader、方法准入、v8 优先和缓存刷新已实现。真实旧会话在不提供 companion 时恢复 20/26 条估计样本：1,957 参考 tokens / 8,970 ms，均速 218.1716833890747 tok/s；保留 companion 时仍为原有 20 条 v8、218.06437242454615 tok/s。两种方法按模型和所选范围择一，内存、SQLite、重开、正常同步及冻结 API 已验证。页面没有修改，新方法没有扩大冷归档删除源数据的权限。

原生计费 token 的独立生成速度仍未恢复：DSH 26 条只有最终 usage；WorkBuddy 21 条日志中的两条纯正文候选缺首批 token 数；ZCode 最近 200 条没有独立生成时长。没有通过扩大采集层或恢复旧 E2E 数值填补这些空缺。DSH 标准插件热启停仍按用户选择暂缓实机启动，与本次免安装 reader 分开。本轮未部署、重启、提交或发布。

## 以下为此前执行记录

更新：2026-10-31。目标是补齐真实可用的生成 TPS，以复用已确认的结论、并行推进独立链路、集中验证来提高效率。计量质量、数据完整性和实际运行覆盖不降低。用户已授权按本方案开工。

当前执行：原版 OpenCode Responses HTTP、Bun WebSocket 与 Chat 工具调用子集已验收；本轮 OpenCode、ZCode 的本地上游候选与 WorkBuddy Desktop、Claude 最小接口方案已交付，见下方“本地上游候选施工”。候选尚未应用到官方安装，仍未满足全 harness 支持门槛，未 commit/push。已完成采集子集的证据位于 `.codex-usage/tps-harness-implementation-20261031/` 及其 `continuation/`，本轮候选证据位于 `.codex-usage/tps-upstream-20261031/`。

## 基线与剩余范围

当前基线是 `9300a78` 加已有工作区改动，不能把 Git HEAD 当作全部待修代码。DSH CLI/Desktop、WorkBuddy CLI 与官方原版 Codex 的现有有效 v8 数据继续保留。Codex Windows 常态日志已配置，下次普通 Desktop 启动生效；尚未部署新看板，也没有为新配置重启当前 Desktop。

剩余缺口是 WorkBuddy Desktop，以及没有完整 v8 观测的 Claude Code、OpenCode、ZCode。它们是已核验的覆盖缺口，不因测试通过而消失。既有结果可作为开工基线：

- 全仓 3,702 项：3,677 通过、25 跳过、0 失败；Codex 专项 99/99。
- DSH/WorkBuddy 专项 193/193；Claude/OpenCode/ZCode 专项 294/294。两组含部分相同的 parity/历史用例，不相加计数。
- 证据位于本机 `.codex-usage/tps-finalization-20261031/`。源码、依赖、运行环境和验证问题均未变化时，复用相应结果；不为“重新开工”再跑一遍。

## 委派方式

**当前采用主代理直接带 pinned-workers。** 本轮只做过一次 xhigh 协调层探测：主代理可以创建它，但该子代理没有原生 subagent 创建接口，因此无法继续派发 DeepSeek。未发生模型拒绝或已证实的深度上限拒绝；不能把努力等级当作委派深度已生效的证据。

- 用户选择 Ultra 作为主代理的推理档位。主代理保留计量口径、采集边界、核心设计与最终取舍，不把未分析清楚的问题丢给 worker。
- 施工 worker 一律显式指定 `model=group/deepseek`、`reasoning_effort=max`、`fork_context=false`。当前不常驻额外的 xhigh Sol，不用高档代理代替 pinned 施工模型。
- 按已就绪、写入范围互不冲突的完整任务卡决定人数。先并行推进两个独立入口；有新就绪卡再增员，进入共享层整合时收缩。每名 worker 每次只拿当前一张卡，交付后优先复用。
- 如果切换模式后子代理工具清单确实变化，可再做一次能产生实际任务产物的能力核验；清单未变则复用本次结果。若能委派，先只启用一名显式 `xhigh` 协调代理，由它按同一技能管理 DeepSeek worker，不自动为每个 harness 建一层 Sol。
- 两层方式只有在独立施工组足够多、能节省主代理的调度工作时采用。协调层负责拆卡和验收，DeepSeek 叶 worker 不再派发；全局仍由主代理分配文件 owner 和并发额度。不用新聊天、外部 CLI 或未授权模型绕过工具限制。

本任务若使用协调层，用户已明确允许其继续委派，优先于技能中 worker 不生成后代的默认约束；不修改全局技能文件。模型、努力等级和工具可用性分别记录实际请求与返回，不声称已验证不可见的物理后台模型。

## 施工顺序与任务边界

### 先解决会阻止实现的疑问

主代理沿用下方共同契约，给入口核验卡一个具体问题：是否能在合批前取得实际接收批次，并精确绑定成功 response/attempt。卡片只补缺失证据，不重复研究已经确认的所有日志和字段。

首批可并行核验 OpenCode 的官方 hook/插件入口与 WorkBuddy Desktop 的实际消费入口。Claude/ZCode 先复用已有缺口结论，只有新版本、新接口或明确未决问题才重新核验。任一路径先具备条件，就先进入实现，不等待其它来源全部研究完。

入口核验的产物是：安装版本和入口位置、字段与时间边界、身份关联、一个有界 localhost 对照的设计，以及能否进入实现的结论。没有所需字段时，记录明确的上游缺口和所需 producer 增量，停止该路径的无效试错，继续其它可做路径。不以换倍率、改标签或保留空值行宣布完成。

### 按来源交付最小可用链路

每张实现卡交付一个可独立验收的运行模式：采集 → 标量 companion/ledger → 精确身份 reader → 内存/SQLite 中一个真实 v8 正例。不要先把四个 collector 都写完再一起接 reader，也不要扩展到未验证的其它运行模式。

worker 可同时拥有自己来源的采集文件、reader 与对应测试。共享分词、窗口、统计内核、store/core、归档和统一发布入口同一时间只有一个 owner；需要改共享层时向主代理提交具体依赖，由主代理串行整合。主代理同时推进共享接线和已交付链路，不与 worker 重复写源文件。

每卡只交付代码差异、关键字段证据、实际运行的命令及结果、未覆盖的具体运行模式。沿用现有计划和日志记录，不另造任务平台、测试注册系统或大型报告框架。

### 复用已有公共实现

优先复用现有统一分词、stream capture、观测校验、来源指纹和 typed history revision。适配器负责把来源事件和身份送入这些实现，不各自重写窗口算法、百分位、归档系统或分词器。

只有来源的真实协议要求现有公共接口增加信息时，才由主代理修改公共契约，并补该新增语义的一组测试。接口没有改变时，直接用既有公共测试结果，不复制整套数学边界到每个来源。

## 共同计量契约

新观测必须绑定同一个成功 response/attempt，具备本地 session、message/response、模型/provider 与完成状态。完整可见输出 lane 使用既有统一参考分词和 UTF-8 token 结束偏移，沿用 v8 的 100 ms 基线及有效窗口规则；reasoning/服务端工具打断窗口，客户端工具执行时间不计入。

接收批次来自被证明的实际接收边界。失败重试不提交；message ID 被 retry 复用时仍按 attempt 隔离。只保存身份、计数、时钟和窗口，不增加正文副本，也不改变原生计费用量。

不将 E2E、TTFT、落盘时间、TBT 倒数、倍率或原生计费 token 数塞进 v8。一个请求缺测不撤销其它有效请求；旧日志不能补出的接收时间不回算。不得仅把 `tps-v5` 标签改成 `tps-v8`。

## 各来源的当前卡

### OpenCode

确认官方插件/hook 是否在约 100 ms 发布合批之前提供原始 text/tool delta 与 attempt 边界。可用则实现标量插件及精确 companion reader；retry 按 attempt 重置，只提交成功 attempt。

现有 `created/streamed/completed` 继续只作诊断。如果入口不暴露所需阶段，交付 producer 字段增量要求，不用发布回调时间冒充接收时间。

### WorkBuddy Desktop

确认实际网络消费 runtime、支持的扩展/逐事件日志与稳定本地 message/session 身份。当前 Node HTTP CLI 启动器不自动覆盖 Desktop。

取得真实批次后复用公共 capture 和现有 reader；只针对 Desktop 特有的压缩、背压、取消、重试或关联方式新增验证。若仅有 `qua.end` 或全调用 trace，记录缺口，保留现有 CLI 的有效采集。

### Claude Code

确认官方逐事件入口能覆盖的具体运行模式。print/partial stream 只能作为候选：必须证明管道合批未改变所需时间边界，并绑定稳定 `message.id`；main session 的结果不外推到交互 CLI、Desktop 或子代理。

若默认日志、hooks 或 OTel 缺少末输出/首批偏移，只准备相应 producer 字段或交付已被证明的运行模式。新观测到达后增加当前样本，保留 transcript usage 与历史身份。

### ZCode

确认官方支持的 ModelStreaming 消费回调和 attempt 身份。现有 `first_token_at` 混合 reasoning 与正文，`duration_ms` 是请求时长，不能代替可见输出窗口。

入口可用才实施；没有支持的扩展入口则交付字段接口与必要负例，不用私有 bundle patch 宣称普通安装已经支持。

### 本轮入口核验结果

- **OpenCode 2.0.20**：官方 `http.response` 位于 provider parser 之前，支持读取或透明包装原响应；但 hook 没有 assistant ID/attempt。主代理未接受按 step/request FIFO 直接配对的建议：full recovery 可以不发布 step-start，HTTP 与 step 也不保证一一对应。优先验证 stream response ID 与最终 `providerState.responseId` 的精确连接。该字段本机只有 94/191 条 assistant 有值，不能据此声称所有 provider 已覆盖。
- **WorkBuddy Desktop 5.9.4**：Node sidecar 本身支持 preload，但正常启动会过滤 `NODE_OPTIONS`，内部 env 注入函数未开放为支持的用户入口；现有日志未保存完整接收批次。停止该路径，不改 bundle。CLI 保持原有支持。
- **Claude Desktop 4.4212.0.0**：版本有变化，已补查安装包。存在 SDK partial-message 消费，但展示 hook 合批且使用展示 UUID；尚未取得官方原始接收时间入口。不能把 debug-file 选项的存在当作逐接收日志已验证。
- **ZCode**：安装 bundle 指纹未变；官方七类 hook 不包含模型原始流，ModelStreaming 经队列发布，工具参数额外缓冲。已核验的日志缺少生成窗口；不重复旧库扫描。

后三项的最小上游增量相同：提供官方接收回调或等价本地标量证据，绑定成功 attempt 与最终本地 message；保留批次单调时间、可见输出与阶段边界。接入后直接复用公共分词、窗口和 reader，不新增一套统计算法。不要求为 TPS 增加请求原文存储、额外网络服务或完整请求生命周期 trace。

### 本轮已交付的 OpenCode 子集

主代理实现[本地插件](../../scripts/opencode-output-capture.mjs)及[目录入口](../../scripts/opencode-plugin/index.js)，复用已有有界 Response pump，不使用无界 clone tee、不等待正文读完才返回 hook、不替换全局 fetch。公共观测校验、OpenCode 标量 reader、memory/store 指纹均已接通；只有最终 DB 的 session、模型/provider 与唯一 responseId 精确匹配时才使用观测。安装配置见[本地采集安装](../10-data-sources.md#本地采集安装)。本阶段没有原生响应 ID、ID 冲突、旧历史与 WebSocket 继续保留现有用量；下文续修记录补充了后续实现的路径。

实际原版 `opencode-cli 2.0.20` localhost 对照确认：Responses 驱动一次 500 后重试，成功流 ID 与最终 `providerState.responseId` 完全一致；1400 字符分三批到达，首 900 个参考 token 为基线，后 500 个参考 token 的实测窗口为 311 ms。provider 原始 output 为 1403，未被参考计数替换。正式 reader → 内存、SQLite、重开均为 `v8/n=1`，用量一致；这些是合成传输对照，不是实际模型速度跑分。

同版 Chat Completions 对照完成但没有持久化 responseId；因此没有采用事件顺序回退。探针曾遇到 Windows 深路径 Git-dir 限制及 SQLite 汇总阶段 I/O 错误，原失败均保留；分别通过短路径预检、结束后只读恢复验证处理，没有改动产品来掩盖探针问题。关键本地证据：`worker-O/O3-evidence.json`、`opencode-acceptance.json`，均位于开工快照同目录。

专项 76/76、跨来源/历史一致性 60/60、typecheck 通过。稳定整合后完整套件只跑一遍：3708 项，3683 通过、25 跳过、0 失败，约 346 秒；相同代码没有为交接重复跑专项。受影响 JS 的 lint/format 与 `git diff --check` 通过，来源/计划文档的 62 个本地链接核对通过。本轮未更改 UI、计量公式、依赖、数据库 schema 或 executor idle 行为，也未部署、安装本机 OpenCode 插件、重启 Desktop 或发布。

### 剩余施工入口

- **OpenCode Chat Completions 纯文本**：driver 当前不持久化 stream ID，纯文本也没有可共享的原生工具 ID。最小增量是在官方 `providerState` 保存成功响应的原生 ID；现有 collector/reader 即可复用，无须新增时间配对。工具调用与 Bun 原生 WebSocket 已在下述续修中接通；其它 WS 实现仍需单独证明接收边界。
- **WorkBuddy Desktop**：需要官方子进程专用扩展/env 接口，让现有 HTTP collector 进入正常 sidecar，或等价的本地标量 producer。不能用全局 Node 设置影响 Desktop 根进程。
- **Claude、ZCode**：需要消费队列之前的官方接收入口或携带原始批次时间与精确身份的日志。展示/工具生命周期 hook 与整次请求 trace 均不足；取得接口前不写占位 reader。

这些条件满足后，各路径沿用本方案的单卡运行正例与影响范围测试，不重复本轮已经确认的历史字段调查。本轮两个 pinned worker 均沿用创建时的 `group/deepseek/max` 配置，未新增 Sol 协调层或后代，验收后均关闭。

### 已授权的续修

主代理负责设计、共享接线与验收，四名 `group/deepseek/max` worker 分别执行 WorkBuddy SDK 核验、Claude 日志核验、WS helper 和工具 ID 实现卡；WorkBuddy 卡结束后复用同一 worker 准备实际客户端对照。没有新增 Sol 协调层或后代。

- **WS 接收边界**：源码确认 `experimental.ws.receive` 在内部队列之后，不能使用该 hook 调用时间。Bun 原版 runtime 每次构造时动态读取原生 `WebSocket`；官方插件通过被动构造/消息监听取得队列之前的时间。官方握手 URL 与 outgoing frame 指纹唯一匹配后才观察该 socket；原生响应 ID 仍与最终 DB 精确关联。不改变帧、认证、路由或引擎文件。
- **Chat 工具身份**：`tool_calls[].id` 会原样保存在最终 `content[type=tool].id`。新增 schema 2 观测携带完整工具 ID 集合；DB 不保存 responseId 时才采用唯一的完整集合。显式 responseId 矛盾、重复/缺失 ID 或冲突不通过集合旁路。SQLite 内只提取工具 ID，正文和参数不进入该投影。
- **WorkBuddy SDK**：新查官方 extension service 与 `@genie/agent-harness` 公开导出。会话事件在 ACP/批处理之后，没有 sidecar provider/fetch/stream middleware；当前无法使用该入口修补实际接收窗口。
- **Claude 日志**：新查官方 2.1.309 debug、SDK partial stream、request retry logger 与 `_chunkTimes`。日志时间、请求 ID和最后 chunk 时间没有组成逐批次接收证据；当前没有可实现的正式日志入口。
- **ZCode provider**：补查 provider 配置与插件组件；配置选择模型/认证，未暴露消费前流式回调。继续沿用已确认的队列/缓冲缺口，不重扫旧账本。

OpenCode 只用三种新的 localhost 客户端对照验收：Chat 工具调用、WS 分批、WS 整批。没有真实模型请求或 Desktop 重启。单卡专项按实际变更运行，稳定后集中一次整体回归；正式部署与发布仍不在本次范围内。

续修结果：

- **WS 分批**：原版 2.0.20、1 次 WS upgrade、0 次 HTTP fallback。三批输出的参考尾部为 500 tokens / 306 ms；后续 receive hook 被故意逐帧延迟，窗口约 2246 ms，但采集仍记录原生接收的 306 ms。原生 output 保持 1403。
- **WS 整批**：10 帧一次 TCP cork/write，仍有慢消费者；数据库与原生 output 正常，companion 不产生测量。内存、SQLite、重开均为 n=0，无伪造 TPS。
- **Chat 工具调用**：wire tool ID 与最终 DB tool.id 精确相等，schema 2 完整集合恰好一条；参考尾部为 501 tokens / 315 ms。两轮原生 output 分别为 1403、17，三路汇总与重开均只使用那条可关联测量，n=1，用量不变。
- **证据提取**：首个 Chat run 的备份失败且原临时树被清理，因此未拿它冒充完整正例。修正保存顺序后仅补跑该用例一次；新的提取错误保留源树后只读恢复，未重复 runtime。WS 原断言/日志错误保留旧失败 receipt，通过现存 DB 与原始事件独立复核，没有重跑 WS。

完整套件本次只跑一遍：3730 项，3704 通过、25 跳过、1 失败；唯一失败是归档测试扫描共享临时目录，读到并行任务的目录。该测试改用同文件已有的私有 TEMP 模式，并主动创建一个共享同名前缀目录验证隔离，修复后整文件 21/21 通过；没有重复全仓碰运气。其余相关专项、typecheck、lint/format 通过。RANGE 的 executor/core/store 与本次基线指纹完全一致，未改 UI、引擎、路由、认证、依赖或部署配置，四名 worker 均已关闭。

主要本地证据：`continuation/acceptance-{chat-tools,ws-segmented,ws-batch}.json`、`worker-R1/{evidence.json,R2-evidence.json}`、`worker-C2/evidence.json`、`worker-W2/evidence.json` 与完整测试日志。所有传输对照都是 localhost 合成输出，不作为实际模型速度跑分。

### 本地上游候选施工

用户已授权优先推进 OpenCode、ZCode，本轮在 `.codex-usage/tps-upstream-20261031/` 保存新基线与源码副本，不修改已安装引擎。主代理先确定身份与接收边界，再给两名 `group/deepseek/max` worker 分配不重叠的当前卡；没有新增 Sol 协调层或后代。

- OpenCode O1：已修复 AI SDK bridge 丢弃 `response-metadata.id` 的路径；现有 finish/providerState 持久化可复用。真实 compatible parser、metadata 保留与失败 stream 隔离三项回归通过，下游 providerState 既有回归通过。随后单独推进 native Chat parser 的同类 ID 保留，不把 AI SDK 的结果外推到 native 路径。
- OpenCode O2：新增一名 pinned worker，在独立文件范围补 Node/Bun 公用接收元数据。保留旧 `messages` 消费面，用同一接收队列的可选带元数据视图，把原生时间与批次传到现有 receive hook。
- ZCode Z1：公开源码为 `v3.17.1` / `a60ba6a7e5a06742270ca605f5d2cc2766afa7e1`，本机安装为 `3.16.3.8992`，不能宣称二者精确对应。已确认物理 `requestId` 不等于 `model_usage.id`，adapter retry 可合并进一条 usage 行。最终 Z2 复用已有 `observeTransport`，补默认 App 与 model factory 的可选转发；网络调用前已创建的 `assistantMessageId` 透传到原状态事件，供未来与既有 `assistant_message_id` 精确关联。自建 raw receiver 草稿保留在私有实验记录，不进入正式候选。缺少该 ID 的模式不猜测补齐，普通启动装配仍须另行验证。
- WorkBuddy Desktop、Claude：主代理准备[最小接口与社区参考方案](2026-10-31-closed-client-tps-interface.md)。社区方案只作研究，解释后经用户批准才实施；不安装网关，不把历史消息时间或滑动报告速率写入 v8。

开源候选补丁的局部源码验证不等于普通官方安装已具备能力。正式覆盖须等相应官方版本提供接口，并验证普通启动链。当前不对外发 issue/PR、不部署、不替换 release，不重启客户端。

本轮候选已收口于 [补丁与验收清单](../proposals/2026-10-31-harness-tps/README.md)：

- OpenCode：AI SDK bridge、原生 Chat ID 与 Node/Bun 接收元数据三个补丁，联合应用后 15 个文件与已测源码一致。AI SDK 三项新增回归、下游 providerState 回归、WS 的 AI 39 项/Core 36 项、实际 Node 两例及相关类型检查通过。原生 Chat 整文件一次为 83 项、79 pass/4 fail；仅修复四处旧 metadata 期望后，失败范围 4/4 通过，不声称修后又跑过一次整文件。
- ZCode：最终复用既有 `observeTransport`，运行代码只有 22 行新增、2 行替换。4 个文件 47/47 定向测试、四个受影响包的 typecheck 与依赖构建通过；显式 lint 为 0 error。最终 11 文件补丁已独立应用并与源码一致。最初的 pnpm 链接权限与 sparse-checkout 缺补丁目录已解决；旧实验接收实现不进入候选。仍缺普通插件加载/安装、正式 collector 装配与成功 request 到唯一完成 usage 行的 reader 关联。
- WorkBuddy Desktop、Claude：已准备最小字段/回调要求，并检查社区 Profiler、transcript statusline、TokenScope 与网关的实际计数/计时方法。新的搜索方案仅保留文档，未实施或启用。

三名 worker 均显式以 `group/deepseek/max/fork_context=false` 创建，无后代，已关闭。本轮主项目 375 个运行代码/测试文件与开工基线一致，RANGE/UI/计费用量不变；仅交付本地源码候选和文档，没有重复此前全仓回归、发真实模型探针、重启或对外提交。

## 验证安排

测试按“本次改动能破坏什么”选择，不按 worker 数量或任务轮数重复。通过不等于覆盖完整；每个声称支持的运行模式都必须有 `v8 / n>0` 的真实采集正例。

### 每张卡只跑相关专项

- **只改来源 collector/reader**：验证该来源实际新增或改变的身份、成功/失败 attempt、完成状态和接收批次语义；至少有一个手算分子/分母的正例，以及一个能击中该来源实际风险的负例。已有公共分词/窗口边界不逐来源复制。
- **改共享计量逻辑**：集中跑 `perf-output-tokens`、`perf-stream-capture` 及受影响的 fetch/http capture 专项；Unicode、首批合并、单批、短窗口、reasoning/工具和并行窗口由公共层负责。只有这些公共语义改变时才重跑。
- **新增持久化或历史载体**：验证新增的指纹、迟到补证、冲突与重开行为；每种新增载体方式保留一次独立转移正例和篡改负例。相同载体不为每个来源重建整套归档矩阵。
- **只改配置/文档**：配置测幂等、并行改动保护、失败恢复与撤销；文档只查内容、链接和差异。没有相应行为改动，不跑 TPS/浏览器/全仓测试。

实现过程中按真实问题使用最小复现，交付前统一跑所需专项。主代理对同一代码指纹、同一环境、同一断言范围的可信结果直接验收，不为“接手”重跑。失败后修正代码，重跑失败相关与新增影响范围；不设“只能测一次”的硬上限，也不循环碰运气刷绿或削弱断言。

现有测试入口按改动选择，以下不是每张卡都要运行的固定清单：

- 公共分词和窗口：[perf-output-tokens](../../test/perf-output-tokens.test.js)、[perf-stream-capture](../../test/perf-stream-capture.test.js)；只有对应接收封装变更时，加 fetch/http capture 专项。
- OpenCode：[perf-opencode](../../test/perf-opencode.test.js)，以及待实现的官方 hook/attempt 实际采集正例。
- WorkBuddy Desktop：待实现的 Desktop runtime 正例，加 [perf-workbuddy](../../test/perf-workbuddy.test.js) 检查 reader 不退化；CLI 的既有正例不能代替 Desktop 验收。
- Claude：[perf-claude](../../test/perf-claude.test.js)；触及存储或迟到证据时再加 [perf-claude-store](../../test/perf-claude-store.test.js)。
- ZCode：[perf-zcode](../../test/perf-zcode.test.js)，新采集模式另补精确关联和真实窗口正例。
- 混合来源整合：[perf-summary-parity](../../test/perf-summary-parity.test.js)；涉及历史载体时选 [history-parity](../../test/history-parity.test.js) 和相应独立转移用例。把新来源放进同一矩阵，避免三个同构套件。

输出已经归一化成同一 PerfSample，不代表新的 hook/传输边界已被旧测试覆盖；是否可复用仍以实际改动和已有断言为准。

### 实际 runtime 验收有界且能区分错误

每个新增或改变的 runtime/传输路径集中做一次 localhost 实际客户端对照。复用公共测试覆盖的数学边界；实际对照重点证明 hook 真在所需消费点、接收合批没有被拆成假时间、稳定身份能关联到落盘 usage。

正常分批必须产生非零 v8 样本；整批返回必须无法伪造生成跨度；碎片输入与实际来源特有的 retry/取消等行为按已确认的风险加入。相同未改代码、依赖和 runtime 的既有验收可复用，不按任务卡重复跑整套传输组合。

localhost 不替代真实渠道字段语义证明。如果仍有本地无法回答的未决问题，先说明最小真实请求要证明什么、已有授权是否覆盖，再按授权执行；不为每次改动重复发模型请求。

### 整合阶段集中一次跨来源验收

主代理将新链路合到同一工作区后，使用现有 `perf-summary-parity`、`three-path-parity`、`history-parity` 的受影响范围验证混合来源、新旧方法、late evidence、usage/费用不变和冷转移。新增来源必须在实际混合样本中出现，不能只靠其它来源的既有正例代替。

同一份稳定整合快照统一运行一次本地完整套件及 typecheck、lint、format。worker 不各跑全仓，主代理不再为同一快照跑第二遍。现有完整套件包含的 UI 检查照常保留；没有前端改动时不额外开浏览器逐轮验收。

最终提交后的现有 CI Node 22/24 矩阵用于独立版本兼容验证，本地不再复制同一套多版本矩阵；若改动恰好涉及特定 Node 版本 API，则提前补相应版本验证。

每次新增运行都要对应代码/环境变化、已定位失败或尚未回答的具体验证问题。格式、注释、文档等不改行为的修订，不触发已通过功能测试重跑。整合后若再发生实质改动，只重测受影响范围；公共路径变化、旧全仓结果已不能覆盖新快照或强制检查要求时，再运行完整套件。不能把修复前的通过结果当作修复后的结果。

## 审阅与证据复用

施工 owner 交付前检查自己的差异及未通过项，不另开“自审任务”。主代理或获授权协调层对该卡进行一次有责任人的审阅；主代理重点审共享层、计量边界和跨来源接线，不让每一层代理重复通读同一份代码。真实缺陷退回原 owner，只阻塞依赖它的工作。

沿用已有记录，保留代码指纹、runtime/依赖版本、实际命令、退出码、断言范围、结果数和日志路径即可。重复结果按同一用例去重；基础设施错误与产品断言失败分开。Windows 直接使用已验证的正常临时目录和文件权限；已知沙箱 `EPERM` 不先重复撞一次，更不能改产品逻辑绕过它。

不统计“跑了多少轮”“审了多少次”作为质量证明。验收看实际正确性：接收窗口和计数一致、成功 attempt 精确关联、用量不变、历史可恢复、支持的 runtime 确实产出速度。

## 发布门槛与授权

只有每个声称支持的 harness/runtime 有真实可用的 v8 链路，现有 DSH、WorkBuddy CLI、Codex 不退化，且相关检查通过，才满足用户先前的 commit＋push 条件。真实缺口继续列出，不能以通过缺失值测试代替支持，也不把部分模式说成全部模式。

纯本地、官方原版、不做转发、不依赖 Magpie 遥测、不加 UI 说明、保留 RANGE 及其 200 ms idle 退出不变。每次 Desktop 重启先协调；部署与 release 更新仍不在当前授权内。当前已进入实施，commit＋push 仍须满足上面的实际支持与检查门槛。

Codex 现有启用/查询/撤销命令和私有恢复状态见[来源与安装](../10-data-sources.md#本地采集安装)与[官方 DLC 验收](../validation/2026-10-31-codex-dlc-gaps/README.md)，不在本轮重做该步骤。
