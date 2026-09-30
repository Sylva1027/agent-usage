# OpenCode 数据源

OpenCode 是看板的第四个数据源（另三个是 Codex、ZCode 与 DSH）。本文记录它的存储布局、
表结构、字段口径，以及若干**容易踩错的地方**。上位实施计划见
[OpenCode 适配实施计划](opencode-adaptation-plan.md)。

> **本节数字均为探针快照，非契约。** OpenCode 的 schema 无文档且仍在变
> （JSON 树 → 单库 → v2 表只用了几个月，消息类型还在增加），实现只依赖
> §能力探测 列出的最小列集，其余一律按"缺失则降级"处理。

## 存储布局

| 项目 | 位置 |
|---|---|
| OpenCode 数据目录 | `~/.local/share/opencode`、`%APPDATA%/opencode`、`%LOCALAPPDATA%/opencode`、`~/Library/Application Support/opencode`（逐个探测；可用 `CODEX_USAGE_OPENCODE_HOMES` 追加，`CODEX_USAGE_OPENCODE=0` 关闭） |
| 会话库 | 数据目录下 `opencode*.db`（覆盖 `opencode-<channel>.db` 变体；`-wal`/`-shm` 不是 `.db` 结尾，自然不匹配） |
| 子代理 | 无独立信号（`parent_id`/`fork` 全空、`agent` 全 `build`），v1 不拆分渠道 |
| 导入 | v1 只收**目录**，不收 `.db` 文件路径（与 ZCode 一致） |

OpenCode 没有限额/配额存储，因此**不参与** Codex 的 5 小时与每周限额窗口。

## 表结构（`session_v2` + `session_message`）

公开文档里的 `session / message / part` 表是 v1 布局，实测已不存在。实际用量在这两张表：

| 表 | 用途 |
|---|---|
| `session_v2` | 会话级：`directory`（仓库归属）、`title`（会话名）、`model`（JSON）、`version`（**版本守护用**）、聚合 `tokens_*` |
| `session_message` | 事件级：`id, session_id, type, seq, time_created, time_updated, data(JSON TEXT)`；`type` 取值不稳定（已见 `assistant / user / idle / system / model-switched`），事件白名单放在 SQL 层（`WHERE type='assistant'`） |

`data` 顶层键：`time, agent, model, content, snapshot, finish, providerState, cost, tokens, rawFinish`。
用量在 `data.tokens = {input, output, reasoning, cache:{read, write}}`，时间 `data.time.completed ?? created`，
模型 `data.model.id` + `providerID`（已见 `opencode`、`opencode-go`；`variant` 可缺）。
个别 assistant 行无 `tokens`（`time/agent/model/content/snapshot` 形状，疑似中断消息，约占 1%），直接跳过。

### 能力探测

解析前 `PRAGMA table_info(session_message)` 校验 `id, session_id, type, seq, time_created, data` 齐全；
缺列则整来源跳过并记可诊断警告。`session_v2` 缺失只影响 cwd/title/版本守护，不阻断事件。

### 版本守护

上游历史上改过一次 `output` 的含义（旧语义已含 reasoning，新语义为可见输出）。
按 `session_v2.version` 主版本号守护：**< 2 整会话跳过并告警**（折叠会重复计数）；
行缺失或版本号无法解析 ⇒ 放行并告警一次（宁可多统计，不丢整库）。

### `cost` 恒 0 不能当免费证据

实测 `cost` 全 0，但上游 v2 runner 在 `step-finish` 里硬编码 `cost: 0`（不调价格计算）。
"是否免费"只按模型名判断（名称以 `-free` 结尾且不在价目表的，见 README 费用估算段），不用 `cost` 字段。

## 用量字段与口径

```jsonc
{ "type": "assistant", "seq": 5, "time_created": 1790671788961,
  "data": { "model": {"id": "muse-spark-1.3-contributor-free", "providerID": "opencode"},
            "time": {"created": 1790671788961, "completed": 1790671792126},
            "tokens": {"input": 5870, "output": 81, "reasoning": 29,
                       "cache": {"read": 3825, "write": 0}} } }
```

**上游依据**：v2 runner 写入的是互不重叠的拆分 —— `input = nonCachedInputTokens`、
`output = visibleOutputTokens`，`reasoning` 与 `cache.{read,write}` 各自独立。
**三条都是并列关系**（真库实证：`SUM(cache.read)` 数倍于 `SUM(input)`；
`reasoning > output` 的行约占四分之一），必须重构成看板的超集口径：

| 看板字段 | 取值 |
|---|---|
| `input` | `input + cache.read + cache.write`（总输入；样本为 9695） |
| `cached` | `cache.read`（3825） |
| `cacheWriteTokens` | `cache.write`（0；`cache.write` 缺失只影响明细位，不污染 `input`） |
| `output` | `output + reasoning`（110；折叠） |
| `reasoning` | `reasoning`（29，`output` 的子集，置 mask 位） |
| `total` | `input + output`（9805；构造值，恒满足总量恒等） |
| `requestInputTokens` | 总输入，用于上下文分级 |
| `detailMask` | input \| cached \| output \| reasoning 全置 + cacheWrite 位（`15 \| 32 = 47`） |

天真映射会同时踩三个坑：`cached > input` 撤销缓存明细、`reasoning > output` 撤销推理明细、
两者都会让**整条事件**退化为最低费率估算（`pricing.js:1059-1066`），且 reasoning 脱离 output 会零计价
（计价只对 `usage.output` 收费）。`test/opencode-usage.test.js` 里有三组 fixture（病态、三陷阱齐全、常规）
与两条天真映射回归测试把这一点钉死，其中"三陷阱齐全"是唯一覆盖 `cache.write > 0` 的样本
（本机真库里没有这种数据，必须合成；注意 `validateUsageDetails` 抓不到漏 write，必须断言计价 reasons）。

### 其他映射

| 看板字段 | 来源 |
|---|---|
| `channel` / `source` | 恒为 `OpenCode` / `opencode` |
| `sessionId` / `eventId` | `session_id` / `` `${session_id}:${seq}` `` |
| `cwd` / 仓库归属 | `session_v2.directory`，经 `createRepositoryResolver()`；缺失 ⇒ `""`（走 unknown，不做 parent 递归） |
| `model` / `modelProvider` | `data.model.id` / `data.model.providerID`；缺省回落 `Unknown model` |
| `conversationName` | `session_v2.title`，截断到 120 字符 |
| `serviceTier` | `unknown`（未提供） |
| `priceVersion` | `pricingVersionForTimestamp(timestamp)` |

### 聚合值永不收敛

`session_v2` 的聚合值与消息求和**永远有差**（4/4 会话 input/output/reasoning 全部偏高，量级不定，
个别会话 cache 也不等），成因未确认（疑似未落 assistant 行的模型调用）。因此聚合值不做事件来源；
看到总量对不上时先查这一条，不要当 bug 报。

### 上下文分级说明

`requestInputTokens` 用总输入判定，但真库单事件总输入远低于长上下文阈值（272_000），目前全部为 `short`。
**聚合缓存比高不等于事件分布高**，不要因为"8 倍缓存"去改分级口径。

## 增量索引

单个数据目录下可能有多个数据库，`UsageStore.usageFiles()` 按目录展开逐个纳入，
各自按 `size + mtime`（含 `-wal`，见 `opencodeSourceStat`）判定是否重解析。

## 隐私口径

要取 `.tokens` 必须 `JSON.parse` 整条 `data`，故正文**会进入内存**；但**只提取
`tokens` / `model` / `time` 白名单字段**。`content`、`snapshot`、`providerState`、
`reasoningEncryptedContent` 等正文字段**不进入任何产出事件、SQLite 索引、日志与静态导出**。
`test/opencode-usage.test.js` 里有哨兵字符串回归测试守着这条。

全程只读，不写入、不修改数据目录。

## 相关文件

| 文件 | 作用 |
|---|---|
| `src/opencode-usage.js` | 解析与归一化 |
| `src/usage-core.js` | 发现、分类、指纹、索引、report 接线 |
| `src/usage-store.js` | SQLite 增量索引（含 `-wal` 的多库展开） |
| `src/server.js` | 导入标签 |
| `test/opencode-usage.test.js` | 单元与语义测试 |
| `test/three-path-parity.test.js` | 内存 / SQLite / 静态快照三路一致 |
