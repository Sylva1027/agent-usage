# Codex 数据源

更新：2026-10-24。共同发现、统计和读取边界见[数据来源](../10-data-sources.md)。

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

性能路径从 `sessions` 与 `archived_sessions` 的 JSONL 按 home/thread 汇总完整 rollout 集合，再折叠为 turn 候选；不能逐文件单独统计。`tps-v2` 核实完整、可识别的 request 集合后求和输出，再以同一集合全部请求的完整端到端时长之和作为分母，包含等待/TTFT，排除响应完成后的工具执行。轮级 key、日期归属及 n 不变，`timingKind=request_e2e`、`tokenScope=reported_output_includes_reasoning`。任一请求缺计时或模型/计数冲突，整轮无完整分母；不再回退到 `AgentMessage`/`Reasoning` item span、任务包络或相邻事件差。仍须有可靠终态与 ownership 证明。

正常索引同步会增量读取本机 `~/.config/magpie/usage.jsonl`，用账本 `response_id` 关联已发布的原生请求，再导入 `out` 和 `ms`。`out` 已包含上游报告的 reasoning 明细，不重复相加；`ms` 是网关记录的请求窗口，包含该入口内的等待与重试，排除响应后的客户端工具执行。Codex provider 明确的 `codex/model` 与同条记录的 `model` 可对应原生裸模型名，其他模型不猜测别名。请求输出、模型和完整请求集合仍由计时内核逐项核对。

账本不存在时正常同步继续运行；只消费完整 JSONL 行，未完成追加留待下轮，轮转或截断后重读。内存游标在进程退出时释放，重启依靠既有导入幂等。计时补录只重建相关线程，无变化同步跳过重复匹配。读取器仅保留身份、模型、输出量和耗时字段，不保存账号、密钥或正文，也不访问网关网络接口。

显式离线导入接口继续保留，`reviewedOrigins` 指定本批来源，原生 response 身份证明唯一线程；已有异源导入不会被自动账本重复覆盖。同源异值持久化为冲突，导入只标记相关线程待重建，成功发布才清除；失败保留重试标记。`tps-v1` 的 item-span 数值仅保留历史诊断。2026-10-21 的六轮 326 请求曾核对为 233,379 tokens / 1,742,789 ms = 133.9112 tok/s，n=6、p10=62.2810、p90=148.1587，见[当时的整合记录](../validation/2026-10-21-tps-measurement-correction/review/final-integration/README.md)。

Magpie 跨 `codexFallBack()` 入口会重新计时，现有账本不足以完整识别并还原跨入口之前的耗时。因此这里统计账本实际记录的请求窗口，不承诺覆盖客户端完整网络往返；缺失历史耗时也不会由日志间隔反推。

`WebSearch` 与其他已登记工具 item 一样，只保留 envelope 的归属证据，不把查询正文、工具时长写入 TPS 投影。2026-10-21 投影解析版本升至 `codex-projection-v3`，旧版本会按正常同步流程重新解析，包括旧版把 WebSearch 误判为未知类型的缓存；不需要删除索引。看板执行器仅在所有来源告警均为 Codex `LIVE_SOURCE_CHANGED` 时再尝试一次同步。

聊天持续追加时，路径集合不变、完整原始前缀不变且规划归属唯一的变化按整个线程暂缓发布，稳定兄弟线程继续显示。规划后首次追加也执行同样检查；变化路径的投影不留作可复用缓存，旧线程数据保留，下轮稳定后重试。文件改写、路径集合变化、无法证明归属的变化仍阻断整个 home，不把它们当作普通追加。

`recent` / `legacy` 以 summary metadata 中的 `eraCutoffMs` 划分（当前默认边界 `2026-09-28T01:00:57Z`），近期包含 cutoff 时刻。`coverage.byEra` 分别保留 eligible/sampled/dropped/pending，不能把 era 的候选数当作有效 TPS 样本数；缺时间候选归 unplaced。代理类别只有显式 spawn 证据才标 `subagent`，否则 `unknown`；模型需要 turn-context 证据，session 级 provider 的历史作用域未知，保持空值，不向 turn 继承。

Codex rollout 归属必须唯一且可证。普通单 header 需要全部显式身份一致；双 header 仅接受经验证的 paginated child 形态：父子 `session_meta`、明确 subagent/thread-spawn、双方分页字段、父子与 fork 关系、连续无缺的物理 ordinal、child 历史起点和边界均一致。边界证明失败、多个互相冲突 ID、未知 schema 或无法归属的记录继续 fail closed，不能回退到 `session_id`、旧 mapping 或删坏行。通过证明时，继承的 parent 前缀在 fold/去重之前剔除，child 是唯一 owner，而完整物理 rollout 文件仍保持依赖关系。publication policy revision `2` 是索引发布过滤版本；它与统计方法 `methodVersion=tps-v2` 各自独立。

SQLite 补缺路径没有启用：M6.4 的决议是 `NO_SQLITE_BY_EVIDENCE`，即现有证据未证明额外读取 Codex SQLite 能补齐有效数据，不是证明其永远无用。可靠归属的 malformed thread 整线程隔离；未知/坏边界可使 home `degraded` 或被整体阻断，必须通过 warning 与 coverage 观察，不跳过单行后发布半个 thread。

身份转移后新线程发布失败时，旧候选仍物理保留以便恢复，但新失败线程与保留的旧失败线程都进入 policy 排除集合。memory/store 使用同一规划，重复同步不让旧线程重入统计；修复后才解除排除并替换依赖。早期冻结副本验收见[主审验收](../validation/2026-10-04-perf-metrics/20261004T035100/handoffs/M8.2-C-主审最终验收-20261008.md)，本次数值补录与活动线程隔离见 [2026-10-24 验收记录](../../output/tps-audit/remediation/numeric-acceptance-2026-10-24.md)。

## 实现与回归

- [usage-core.js](../../src/usage-core.js)：发现、日志解析、增量与内存报告。
- [usage-store.js](../../src/usage-store.js)：文件索引、限额观察值和查询。
- [perf-magpie-timing.js](../../src/perf-magpie-timing.js)：本地网关请求耗时增量读取；[读取器测试](../../test/perf-magpie-timing.test.js)与[同步测试](../../test/perf-magpie-timing-store.test.js)。
- [service-tier-evidence.js](../../src/service-tier-evidence.js)：服务档位证据。
- [usage-core 测试](../../test/usage-core.test.js)、[usage-store 测试](../../test/usage-store.test.js)、[三路一致测试](../../test/three-path-parity.test.js)：请求增量、旧版本重扫及内存/SQLite/导出一致性。
- [性能来源目录](../../src/perf-sources/index.js)、[Codex 候选测试](../../test/perf-codex.test.js)、[索引测试](../../test/perf-codex-index.test.js)与[API 测试](../../test/perf-codex-api.test.js)：跨文件折叠、完整分母、分页 ownership、隔离与恢复。
