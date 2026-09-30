# DSH（DeepSeek Harness）数据源

DSH 是看板的第三个数据源（另两个是 Codex 与 ZCode）。本文记录它的存储布局、日志格式、
字段口径，以及若干**容易踩错的地方**。上位设计文档见
[DSH 适配实施计划](dsh-adaptation-plan.md)。

## 存储布局

| 项目 | 位置 |
|---|---|
| DSH home | `~/.dsh`（可用 `CODEX_USAGE_DSH_HOMES` 追加，`CODEX_USAGE_DSH=0` 关闭） |
| 会话日志 | `~/.dsh/sessions/<slugified-cwd>/<sessionId>/session.v<N>.jsonl.zstd` |
| slug 规则 | cwd 中 `\`→`-`、`:`→`~`、空格→`~0020` |
| 子代理 | 子代理会话有**自己的** session 目录 |
| 投影缓存 | `~/.dsh/storages/session_projcache/sessions/<sessionId>.json`（**本适配层不使用**） |

DSH 没有限额/配额存储，因此**不参与** Codex 的 5 小时与每周限额窗口。

## 日志格式（`formatVersion: 4`）

文件是**多帧拼接**的 zstd（流式追加，每帧 1–2 条 JSONL 记录）。由于 DSH 会持续往同一个文件追加，
帧数与体积没有固定值（同一会话在不同时间实测到过 409 帧 / 749 条与 1531 帧 / 2403 条，
对应 436 KB 与 1.5 MB）。每条记录带 `seq` 与 `time`（epoch ms）。

### 两个必须注意的 zstd 行为

1. **`zstdDecompressSync` 整文件解压只出第一帧，且不报错**（静默截断）。
   因此「整体解压成功」**不能**作为单帧判据，必须扫描魔数 `28 b5 2f fd` 并以相邻位置为帧边界逐帧解压。
2. **`zstdDecompressSync` 对畸形帧不抛错，而是返回空 buffer。**
   所以靠 `try/catch` 判坏帧是死代码，必须把「解出空内容」也算作坏帧。
   DSH 从不写空帧（每帧至少一条 JSON），该判据安全。

`readDshSessionRows()` 同时处理这两点，坏帧只记警告、不中断整个文件。

### 记录类型

| type | 用途 |
|---|---|
| `session` | 会话头（仅首帧）：`id`、`cwd`、`delegationDepth`、`createdAt`、`agentPreset`、`version` |
| `request/header` | `data.header.config.{provider,model}` —— **模型按请求记录** |
| `request/context` | 同上，作为模型/provider 的兜底来源 |
| `session/title` | `data.title` —— 会话标题，可能出现多条，取最后一条 |
| `assistant/message` | **唯一用量来源**：`data.usage` |
| 其余 | `tool/call`、`tool/result`、`step/*`、`turn/*`、`workspace/changes` 等，一律不读 |

### 用量字段与口径

```jsonc
{ "type": "assistant/message", "seq": 18, "time": 1790546383242,
  "data": { "turn": 1, "step": 1,
            "usage": { "inputTokens": 1614, "outputTokens": 127,
                       "cacheReadTokens": 6784, "cacheWriteTokens": 0, "totalTokens": 8525 } } }
```

**这四个计数是并列关系**，由 `totalTokens` 自证：

```
inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens = totalTokens
   1614     +      6784       +        0          +      127     = 8525  ✓
```

而看板要求 `cached` 是 `input` 的**子集**（`public/usage-fields.js` 与 `src/pricing.js`
都依赖 `cached <= input`）。所以 `dshUsageFromRaw()` 做一次超集重构：

| 看板字段 | 取值 |
|---|---|
| `input` | `inputTokens + cacheReadTokens`（总输入；样本为 8398） |
| `cached` | `cacheReadTokens`（6784） |
| `cacheWriteTokens` | `cacheWriteTokens`（0） |
| `output` | `outputTokens`（127） |
| `reasoning` | `0`，且**不置** detailMask 的 reasoning 位（DSH 未单列） |
| `total` | `totalTokens`（8525） |
| `requestInputTokens` | `inputTokens + cacheReadTokens`，用于上下文分级 |
| `detailMask` | input \| cached \| output \| cacheWrite = `39` |

若直接把 `inputTokens` 当 `input`，会同时踩三个坑：`cached > input` 导致缓存明细被撤销并标记
inconsistent、计价退化为「最低费率估算」、缓存命中率显示超过 100%。`test/dsh-usage.test.js`
里有正反两条断言把这一点钉死。

### 其他映射

| 看板字段 | 来源 |
|---|---|
| `channel` | `delegationDepth > 0` → `DSH Subagent`，否则 `DSH` |
| `sessionId` | 会话头的 `id` |
| `cwd` / 仓库归属 | 会话头的 `cwd`，经 `createRepositoryResolver()` |
| `model` / `modelProvider` | 最近一条 `request/header`（或 `request/context`）；缺省回落 `Unknown model` |
| `conversationName` | 最后一条 `session/title`，截断到 120 字符 |
| `serviceTier` | `unknown`（DSH 未提供） |
| `priceVersion` | `pricingVersionForTimestamp(timestamp)` |

### 版本守护

只按 `formatVersion === 4` 解析。遇到其它版本**显式跳过并告警**，不按 v4 硬解 ——
宁可少统计，也不要静默算错。

## 增量索引

DSH 的用量按会话分散在**多个**日志文件里（不像 ZCode 只有一个数据库），
因此 `UsageStore.usageFiles()` 会把每个日志文件各自纳入增量索引，
按 `size + mtime` 判定是否需要重解析。日志是追加写入的，已完整写入的帧不会变化，整文件重解析是安全的。

## 隐私口径

适配层**只读**用量与元数据字段：`session` 头、`request/header`、`request/context`、
`session/title`、`assistant/message` 的 `data.usage`。

**绝不读取、绝不落地** `data.message`、`data.content`、`data.stream`、
`tool/call.arguments`、`tool/result.message` 等正文字段。
`test/dsh-usage.test.js` 里有哨兵字符串回归测试守着这条。

全程只读，不写入、不修改 `~/.dsh`。

## Node 版本要求

zstd 解压需要 Node ≥ 22.15，压缩需要 ≥ 23.8。由于测试 fixture 用 `zstdCompressSync`
现场生成多帧日志，`package.json` 的 `engines` 定为 `>=23.8`。

## 相关文件

| 文件 | 作用 |
|---|---|
| `src/dsh-usage.js` | 解析与归一化 |
| `src/usage-core.js` | 发现、分类、指纹、索引、report 接线 |
| `src/usage-store.js` | SQLite 增量索引 |
| `test/dsh-usage.test.js` | 单元与语义测试 |
| `test/three-path-parity.test.js` | 内存 / SQLite / 静态快照三路一致 |

### 已知的既存设计味道（本次未改）

「Codex home kinds」散落在 4 处且形式不一（`usage-store.js` 的 SQL、`app.js` 的
`CODEX_HOME_KINDS`、`timeline-utils.js` 的反向列表、`service-tier-evidence.js` 的另一处）。
对 DSH 而言都是 fail-open（不在 allowlist 内即被排除），行为正确，
但将来新增数据源需要同步改多处。
