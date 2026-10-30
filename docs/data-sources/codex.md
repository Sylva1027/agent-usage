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

## 实际输出速度（TPS）

当前 tps-v7 按单次响应采样，从原生 `token_usage_record.generation_timing` schema 4 读取本地统一分词计数与传输接收窗口。普通官方安装不写这些字段，须使用完整采集并排包；[安装步骤](../10-data-sources.md#本地采集安装)涵盖 CLI 和 Windows Desktop，保持原有认证、模型路由与 home。

窗口内实际正文和工具参数使用 `o200k_base` 计数，首批全部字节排除，分母为各窗口的时间并集。原始 output/reasoning 继续供用量和费用使用。新计量不读取 Magpie 账本，不从旧请求总耗时、item span 或整轮耗时回退。

性能 reader 仍按 home/thread 读取完整 rollout 集合并证明 ownership，再构造 response 候选。单条已完成响应可采样，不依赖整轮结束；其它请求缺测不连带淘汰它。旧 v1-v6 保留历史方法与模型身份，不能重标为 v7。有效原生测量不受旧外部计时冲突影响；原生身份或原生测量自相矛盾仍拒绝。

source 追加、改写与分页 child 的既有发布规则继续适用：可证明的活跃追加只暂缓对应线程，稳定兄弟线程继续发布；改写、路径集变化和未知归属按原 policy 隔离。分页 child 必须有完整父子 header、连续 ordinal 和有效边界，继承父记录在折叠前剔除。投影版本为 v8，正常同步重解析旧缓存，不需删除索引。

冷修订保存与 sample/source/home 绑定的原生标量窗口，完整导出、删除原来源、导入和 reopen 后仍能独立核验；缺少 witness 或篡改 token/duration 不通过。新测量仅保存计数、时钟和身份，不复制正文。详细契约和实际二进制验证见[本轮验收](../validation/2026-10-31-receive-clock-tps/README.md)。

## 实现与回归

- [usage-core.js](../../src/usage-core.js)：发现、日志解析、增量与内存报告。
- [usage-store.js](../../src/usage-store.js)：文件索引、限额观察值和查询。
- [Codex producer 补丁](../../scripts/patches/codex-native-generation-timing.patch)、[启动器](../../scripts/start-codex-generation.ps1)与[原生采集测试](../../test/codex-output-timing.test.js)：传输批次、窗口计数和普通安装接入。
- [service-tier-evidence.js](../../src/service-tier-evidence.js)：服务档位证据。
- [usage-core 测试](../../test/usage-core.test.js)、[usage-store 测试](../../test/usage-store.test.js)、[三路一致测试](../../test/three-path-parity.test.js)：请求增量、旧版本重扫及内存/SQLite/导出一致性。
- [性能来源目录](../../src/perf-sources/index.js)、[Codex 候选测试](../../test/perf-codex.test.js)、[索引测试](../../test/perf-codex-index.test.js)与[API 测试](../../test/perf-codex-api.test.js)：跨文件折叠、完整分母、分页 ownership、隔离与恢复。
