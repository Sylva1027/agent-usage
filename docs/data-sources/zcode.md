# ZCode 数据源

更新：2026-10-08。共同发现、统计和读取边界见[数据来源](../10-data-sources.md)。

## 存储与发现

默认 home 为 `~/.zcode`；`CODEX_USAGE_ZCODE_HOMES` 追加目录，`CODEX_USAGE_ZCODE=0` 关闭自动发现。数据库依次探测 `cli/db/db.sqlite`、`db/db.sqlite`，导入接收 home 目录。

用量来自 `model_usage`；`session` 表用于 cwd、标题和 parent 归属。会话表缺失时仍尝试读取用量，缺少元数据不等于整个来源没有事件。

## 字段与渠道

- 输入取 `input_tokens`，缓存命中取 `cache_read_input_tokens`，输出取 `output_tokens`，推理取 `reasoning_tokens`。
- 缓存写入取 `cache_creation_input_tokens`，区分真实 0 和未知。
- 总量优先 `computed_total_tokens`，其次 `provider_total_tokens`，缺失时使用输入加输出。
- 时间优先 `completed_at`，其次 `started_at`；无有效时间的记录跳过。
- `query_source === subagent` 或 `task_type === subagent_child` 分为 `ZCode Subagent`，其余为 `ZCode`。
- cwd 来自会话 directory/path，缺失时有限深度查询 parent，不通过模型名称猜仓库。

数值先区分已知与未知，再执行标准明细校验；缺失或不一致的字段不当作确知零值。ZCode 没有 Codex 限额记录，只进入普通范围。

## 输出吞吐（TPS）

性能 reader 从 `model_usage` 逐行读取稳定 `id`、`model_id`、`provider_id`、`output_tokens`、时间字段和可用的子代理标志。`duration_ms` 是有效整数时直接作为时长（显式 0/负数不回退）；否则仅在 `started_at` 与 `completed_at` 都可规范为 epoch 毫秒且差值非负时，以完成减开始回退。统计时间点优先完成时间，缺失时用开始时间。

窗口为一条 request，`timingKind=request_e2e`；`tokenScope=reported_output_unspecified`，因为来源没有提供已验证的输出 token 子范围。稳定行 ID 是构造候选的前提；未完成、失败、取消、重试及终态未核实的记录保留为诊断候选，不进入 sampled。完成状态还须有完成时间证据；输出与时长必须为正且通过公共校验。身份不稳只报 `UNKEYABLE_RECORD`，不造候选。子代理类别只由 `query_source=subagent` 或 `task_type=subagent_child` 明确标记；否则 `agentKind=unknown`。模型与 provider 取该行证据，不从当前配置补值。

2026-10-01 Claude 接入时，没有找到可核验的 ZCode 上游写库源码，尚不能确认 `input_tokens` 与缓存读/写的包含关系。当前映射保持不变，不因模型名为 Claude 就额外累加缓存。已有字段校验和最低费率场景仍适用；Claude 价目接入不等于已证明 ZCode 所有 Claude 记录可以精确计费。后续应以版本化写库代码或可对照的脱敏原始请求补证据。

## 增量与打开方式

指纹包含主库和 `-wal` 的大小/修改时间，避免只检查主库而漏掉新写入。普通用量 reader 优先只读打开，失败时当前实现退回普通 SQLite 打开；恢复过程可能操作辅助文件，应用不主动改写上游用量记录。TPS reader 严格只读，打开失败即拒绝读取；两条路径的保证不同。

## 实现与回归

- [zcode-usage.js](../../src/zcode-usage.js)：数据库探测、字段映射和流式读取。
- [usage-core.js](../../src/usage-core.js)、[usage-store.js](../../src/usage-store.js)：发现、指纹、标准事件与索引。
- [ZCode 测试](../../test/zcode-usage.test.js)与[三路一致测试](../../test/three-path-parity.test.js)：来源、子代理、明细和费用的一致性。
- [TPS reader](../../src/perf-sources/zcode.js)与[性能回归](../../test/perf-zcode.test.js)：时长回退、终态、缺值、只读与候选诊断。
