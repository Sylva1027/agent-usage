# Codex 数据源

更新：2026-10-01。共同发现、统计和读取边界见[数据来源](../10-data-sources.md)。

## 目录与记录

默认 home 为 `~/.codex`，自动发现也检查本机 JetBrains 集成目录；`CODEX_USAGE_HOMES` 可追加 home。会话来源为 `sessions`、`archived_sessions` 下的 JSONL。目录存在不代表其中一定有可用用量，分类、读取和事件校验分别进行。

`session_meta` 提供会话 ID、cwd、来源与客户端信息；模型来自请求上下文，Token 记录提供累计或最近请求的用量。只为实际有用量或限额观察值的记录构造统计结果。

## 累计与请求增量

同一会话可在多个 rollout 文件中出现。累计计数先换算请求增量，并处理续写、跨文件基线与新文件继承累计值；不能把累计值逐行相加。缓存命中属于输入，推理属于输出。

明确的最近请求用量与累计增量一致时，可作为单次请求上下文证据；累计或聚合输入本身不足以证明长上下文。缓存写入和服务档位未知时保留 unknown，不用旧模型或缺失字段补出确定档位。

## 限额与服务档位

Codex rate-limit 观察值提供当前窗口和重置边界，限额统计冻结相应时点的观察值；缺失可靠数据时不猜测。服务档位可由记录或独立证据解析，不改写原始 Token。

Codex home kinds 是限额资格的判据。ZCode、DSH、OpenCode 和项目日志即使使用同名模型也不会进入 Codex 限额窗口。

## 实现与回归

- [usage-core.js](../../src/usage-core.js)：发现、日志解析、增量与内存报告。
- [usage-store.js](../../src/usage-store.js)：文件索引、限额观察值和查询。
- [service-tier-evidence.js](../../src/service-tier-evidence.js)：服务档位证据。
- [usage-core 测试](../../test/usage-core.test.js)、[usage-store 测试](../../test/usage-store.test.js)、[三路一致测试](../../test/three-path-parity.test.js)：请求增量、旧版本重扫及内存/SQLite/导出一致性。
