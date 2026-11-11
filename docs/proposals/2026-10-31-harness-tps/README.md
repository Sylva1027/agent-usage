# OpenCode 与 ZCode 本地 TPS 上游候选

这些补丁用于审阅和后续上游协作，不由 Agent Usage 安装器执行，也没有应用到本机客户端。当前继续使用官方原版引擎。补丁在独立源码副本中实现与验证；官方版本采纳后，仍须完成普通启动链与采集器接线验证，才能声明新增运行模式可用。

## OpenCode

基线：官方 `v2.0.20`，commit `84c9be93a56304a108f1a22df0c5d62c26d5b6ca`。

- [AI SDK bridge 响应 ID](opencode-aisdk-response-id.patch)：将原本被忽略的 `response-metadata.id` 保留到 `step-finish`、`finish` 和既有 `providerState` 持久化链。没有 ID 时不合成；各物理 stream 的状态独立，原生计费用量与 provider metadata 保留。
- [原生 Chat 响应 ID](opencode-native-chat-response-id.patch)：保留同一 stream 一致的非空原生 ID。缺失、非字符串或矛盾的 ID 不制造业务失败；矛盾状态保持到流结束，只停止发布可用身份，正文与 usage 照旧。
- [WebSocket 接收元数据](opencode-websocket-receive.patch)：在原生消息回调取单调时间，同一 Ready drain 共用批次，再把元数据穿过内部队列送到已有 `experimental.ws.receive`。原 `messages` 消费面保留，可选 `received` 是同一个队列的另一消费面，二者不能同时订阅。没有原生计时能力时省略元数据，不用 hook 的调用时间补值。

AI SDK bridge 与原生 Chat parser 是不同路径，不能互相代替验收。Node 使用的 `ws` 构造器也不同于 Bun 的全局 WebSocket；接收元数据候选在真正 Node 进程中单独验收，避免只验证 Bun 后外推。

AI SDK 的三项新增回归与下游 providerState 回归通过。原生 Chat 整文件一次执行为 83 项、79 通过、4 个旧 metadata 期望失败；只修正这四处新增响应 ID 的期望后，失败范围 4/4 通过，没有重复整文件或将聚焦用例相加。WS 的 AI 39 项、Core 36 项及真实 Node 两例通过，相关包类型检查通过。三个补丁在同一干净基线上联合应用后，15 个文件与最终已测源码一致。

当前已完成的来源子集仍见 [OpenCode 数据源](../../data-sources/opencode.md)。这些候选未改变当前安装版本，也未提前把缺少共享 ID 的纯文本请求认定为可测。

## ZCode

公开源码基线为 `v3.17.1`，commit `a60ba6a7e5a06742270ca605f5d2cc2766afa7e1`；本机已核验版本为 `3.16.3.8992`，无法唯一证明其 bundle 对应哪个公开 commit。本目录只对指定源码基线负责。

[宿主观察入口与消息身份补丁](zcode-host-transport-observer.patch)包含 11 个文件；运行代码为 22 行新增、2 行替换，其余为 spec 与回归。4 个文件共 47 项定向测试通过，四个受影响包的 typecheck 与依赖构建通过。真实本地 HTTP 对照覆盖首次失败、重试成功、两个物理 request ID 与同一已持久化 assistant 的关联，以及仅一条完成 usage。显式 lint 为 0 error，保留两个上游已配置的文件长度 warning。主代理另验最终补丁可应用，11 个文件与已测源码一致；交付前只清理了 spec 的实验过程措辞。

接入分为两个事实：首先在原始 body 接收点记录批次和单调时间；其次把成功物理 attempt 绑定到最终本地消息。`requestId` 与 `model_usage.id` 不相等，不能直接配对。既有 `assistantMessageId` 在请求前已经创建，状态事件可透传它，再与已完成用量行的 `assistant_message_id` 精确关联。

候选复用 adapter 已有的 `observeTransport`，将它从默认 App 宿主与 model factory 逐层转发。宿主可注入本项目已有的有界采集器；ZCode 不再新增另一套接收队列、parser 或 tokenizer。缺省不包装 response，已注入完整 adapter 时保持原优先级。该端口和状态身份不增加正文落盘、代理服务或数据库迁移。程序化端口不等于普通 Desktop/CLI 已自动启用。

仍需完成两段实际集成：官方发行版中的插件加载或宿主配置，以及 Agent Usage 对成功物理 request、状态事件、唯一已完成 usage 行的正式 reader 关联。compact/title 等缺少持久 assistant 的模式仍不能外推。这些后继没有因接口测试通过而标为完成。

## 闭源客户端与社区参考

[WorkBuddy Desktop、Claude 最小接口与社区方案](../../plans/2026-10-31-closed-client-tps-interface.md)列出所需回调、现有缺口，以及历史消息估计、滑动报告与网关方案的区别。社区方案尚未安装或实施；新增方案须先解释并获得用户批准。

## 验证与交付边界

补丁与测试清单见 [evidence.json](evidence.json)；详细原始记录位于本机 `.codex-usage/tps-upstream-20261031/`。测试使用本地合成流，不是实际模型速度跑分；没有发送真实模型请求。

本轮不重复此前工作区全仓测试。只对新增上游行为运行相关 parser、WS、observer、身份与类型检查，并对最终补丁组合检查可应用性和源码一致性。本项目运行代码、UI、RANGE 与 executor 的 200 ms idle 退出均保留。

没有对外 issue、PR、commit、push、部署、release 替换或 Desktop 重启。实际执行状态沿用 [TPS harness 修复方案](../../plans/2026-10-31-tps-harness-repair-plan.md)。
