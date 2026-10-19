# Codex 数据源

更新：2026-10-14。共同发现、统计和读取边界见[数据来源](../10-data-sources.md)。

## 目录与记录

默认 home 为 `~/.codex`，自动发现也检查本机 JetBrains 集成目录；`CODEX_USAGE_HOMES` 可追加 home。会话来源为 `sessions`、`archived_sessions` 下的 `.jsonl` 和 `.jsonl.zst`。同名两种格式并存时优先读取 `.jsonl`，压缩格式流式解压而不落盘展开。目录存在不代表其中一定有可用用量，分类、读取和事件校验分别进行。

压缩读取逐帧核对结束边界、输入消费及声明的内容长度，并验证存在的校验和。截断、非法 UTF-8/JSON 或读取失败使整份替换回滚；格式切换时旧索引与新索引在同一事务内替换。没有校验和的等长合法内容变化无法仅由容器格式自证，完整帧边界后的数据缺失也需要可信历史对照。

日常日期筛选读取 SQLite 索引；后台同步期间使用同步开始前固定的 WAL 读视图，不等待全量重扫，也不读取尚未提交的统计。首次没有可用索引时仍需等待首次同步。

读取器版本升级会将既有 Codex 文件一次性标记为待重读，并使旧 TPS 投影失效；不删除既有事件、不修改原始日志，也不改变数据库表结构。第一次同步因此会补扫压缩历史及旧 JSONL，之后恢复增量读取。

`session_meta` 提供会话 ID、cwd、来源与客户端信息；模型来自请求上下文，Token 记录提供累计或最近请求的用量。只为实际有用量或限额观察值的记录构造统计结果。

## 累计与请求增量

同一会话可在多个 rollout 文件中出现。累计计数先换算请求增量，并处理续写、跨文件基线与新文件继承累计值；不能把累计值逐行相加。缓存命中属于输入，推理属于输出。

明确的最近请求用量与累计增量一致时，可作为单次请求上下文证据；累计或聚合输入本身不足以证明长上下文。缓存写入和服务档位未知时保留 unknown，不用旧模型或缺失字段补出确定档位。

## 限额与服务档位

Codex rate-limit 观察值提供当前窗口和重置边界，限额统计冻结相应时点的观察值；缺失可靠数据时不猜测。服务档位可由记录或独立证据解析，不改写原始 Token。

Codex home kinds 是限额资格的判据。ZCode、DSH、OpenCode 和项目日志即使使用同名模型也不会进入 Codex 限额窗口。

## 输出吞吐（TPS）

性能路径从 `sessions` 与 `archived_sessions` 的 JSONL 按 home/thread 汇总完整 rollout 集合，再折叠为 turn 候选；不能逐文件单独统计。请求输出计数先按完整、可识别的 request 身份集合核实后求和。目标 item 为 `AgentMessage` 和 `Reasoning`；只有具有安全整数起止时间、正时长且不重叠的目标 item span 纳入轮时长，轮时长是这些 span 之和，包络时间不替代 item 时长。要求 `task_complete` 终态及完整请求集合；缺失身份/部分请求/坏跨度不会借剩余跨度制造完整分母。`timingKind=item_span_estimate`、`tokenScope=reported_output_includes_reasoning`，因此这是轮级估算并明确含 reasoning。

`recent` / `legacy` 以 summary metadata 中的 `eraCutoffMs` 划分（当前默认边界 `2026-09-28T01:00:57Z`），近期包含 cutoff 时刻。`coverage.byEra` 分别保留 eligible/sampled/dropped/pending，不能把 era 的候选数当作有效 TPS 样本数；缺时间候选归 unplaced。代理类别只有显式 spawn 证据才标 `subagent`，否则 `unknown`；模型需要 turn-context 证据，session 级 provider 的历史作用域未知，保持空值，不向 turn 继承。

Codex rollout 归属必须唯一且可证。普通单 header 需要全部显式身份一致；双 header 仅接受经验证的 paginated child 形态：父子 `session_meta`、明确 subagent/thread-spawn、双方分页字段、父子与 fork 关系、连续无缺的物理 ordinal、child 历史起点和边界均一致。边界证明失败、多个互相冲突 ID、未知 schema 或无法归属的记录继续 fail closed，不能回退到 `session_id`、旧 mapping 或删坏行。通过证明时，继承的 parent 前缀在 fold/去重之前剔除，child 是唯一 owner，而完整物理 rollout 文件仍保持依赖关系。publication policy revision `2` 是索引发布过滤版本；它与统计方法 `methodVersion=tps-v1` 各自独立。

SQLite 补缺路径没有启用：M6.4 的决议是 `NO_SQLITE_BY_EVIDENCE`，即现有证据未证明额外读取 Codex SQLite 能补齐有效数据，不是证明其永远无用。可靠归属的 malformed thread 整线程隔离；未知/坏边界可使 home `degraded` 或被整体阻断，必须通过 warning 与 coverage 观察，不跳过单行后发布半个 thread。

身份转移后新线程发布失败时，旧候选仍物理保留以便恢复，但新失败线程与保留的旧失败线程都进入 policy 排除集合。memory/store 使用同一规划，重复同步不让旧线程重入统计；修复后才解除排除并替换依赖。完整冻结副本的真实验收已恢复 Codex 覆盖，记录见[主审验收](../validation/2026-10-04-perf-metrics/20261004T035100/handoffs/M8.2-C-主审最终验收-20261008.md)；它不保证实时目录之后不变，生产仍对 `LIVE_SOURCE_CHANGED` 拒绝发布。

## 实现与回归

- [usage-core.js](../../src/usage-core.js)：发现、日志解析、增量与内存报告。
- [usage-store.js](../../src/usage-store.js)：文件索引、限额观察值和查询。
- [service-tier-evidence.js](../../src/service-tier-evidence.js)：服务档位证据。
- [usage-core 测试](../../test/usage-core.test.js)、[usage-store 测试](../../test/usage-store.test.js)、[三路一致测试](../../test/three-path-parity.test.js)：请求增量、旧版本重扫及内存/SQLite/导出一致性。
- [性能来源目录](../../src/perf-sources/index.js)、[Codex 候选测试](../../test/perf-codex.test.js)、[索引测试](../../test/perf-codex-index.test.js)与[API 测试](../../test/perf-codex-api.test.js)：跨文件折叠、完整分母、分页 ownership、隔离与恢复。
