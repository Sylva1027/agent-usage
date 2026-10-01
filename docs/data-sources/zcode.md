# ZCode 数据源

更新：2026-10-01。共同发现、统计和读取边界见[数据来源](../10-data-sources.md)。

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

## 增量与打开方式

指纹包含主库和 `-wal` 的大小/修改时间，避免只检查主库而漏掉新写入。优先只读打开，失败时当前实现退回普通 SQLite 打开；恢复过程可能操作辅助文件，应用不主动改写上游用量记录。

## 实现与回归

- [zcode-usage.js](../../src/zcode-usage.js)：数据库探测、字段映射和流式读取。
- [usage-core.js](../../src/usage-core.js)、[usage-store.js](../../src/usage-store.js)：发现、指纹、标准事件与索引。
- [ZCode 测试](../../test/zcode-usage.test.js)与[三路一致测试](../../test/three-path-parity.test.js)：来源、子代理、明细和费用的一致性。
