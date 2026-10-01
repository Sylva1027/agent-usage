# DSH（DeepSeek Harness）数据源

更新：2026-10-01。本文维护 DSH 的现行存储、字段与边界；共同规则见[数据来源](../10-data-sources.md)，原实施过程见[历史计划](../archive/2026-10-01/dsh-adaptation-plan.md)。

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

### 当前逐帧处理

当前实现依据受测 Node 环境和日志样本，扫描魔数 `28 b5 2f fd`，以相邻位置为帧边界逐帧解压，避免把整体解压成功当作所有帧均已处理。

坏帧既处理异常，也将空解压结果记作警告；已支持的日志帧至少包含一条 JSON。这里描述当前适配器策略，不把受测 zstd 行为当作所有 Node 版本的通用保证。

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

这组样本的计数为并列关系，`cacheWriteTokens` 为 0，`totalTokens` 与各项之和一致：

```
inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens = totalTokens
   1614     +      6784       +        0          +      127     = 8525  ✓
```

而看板要求 `cached` 是 `input` 的**子集**（`public/usage-fields.js` 与 `src/pricing.js`
都依赖 `cached <= input`）。所以 `dshUsageFromRaw()` 做一次超集重构：

| 看板字段 | 取值 |
|---|---|
| `input` | `inputTokens + cacheReadTokens + cacheWriteTokens`（总输入；样本为 8398） |
| `cached` | `cacheReadTokens`（6784） |
| `cacheWriteTokens` | `cacheWriteTokens`（0） |
| `output` | `outputTokens`（127） |
| `reasoning` | `0`，且**不置** detailMask 的 reasoning 位（DSH 未单列） |
| `total` | `totalTokens`（8525） |
| `requestInputTokens` | `inputTokens + cacheReadTokens + cacheWriteTokens`，用于上下文分级 |
| `detailMask` | input \| cached \| output \| cacheWrite = `39` |

若直接把 `inputTokens` 当 `input`，会同时踩三个坑：`cached > input` 导致缓存明细被撤销并标记
inconsistent、计价退化为「最低费率估算」、缓存命中率显示超过 100%。`test/dsh-usage.test.js`
里有正反两条断言把这一点钉死。

### 非零缓存写入已核实

2026-10-01 只读检查本机安装包 `E:/DeepSeek Harness/resources/app.asar`。包内 `dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js` 明确把 `usage.inputTokens` 视为 uncached input，并将输入、缓存读、缓存写、输出相加；`lib/types/turn-usage.js` 同时以这三类输入之和校验已知 prompt 与总量减输出。因此非零写入必须进入看板总输入和单次输入，缺少上游 total 时的兜底为重构输入加输出，不能再加一次写入。

新增 Claude fixture 包含普通输入 1,000、缓存读 8,000、缓存写 1,000、输出 500：看板输入为 10,000，总量为 10,500，Haiku 4.5 的 5 分钟 Standard 场景为 $0.00555。有无上游 total、费用拆分及内存/SQLite/静态三路均有回归，见[本批验收](../validation/2026-10-01-claude-pricing/README.md)。这次证据来自安装包源码与合成 fixture，不是非零写入真库样本。

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

索引 v10→v11 将 DSH 文件指纹标为待重新解析；下一次同步会重建未变化日志中的 DSH 事件，其他来源索引保留。9→10 使用固定落点 10，避免升级时跳过这个步骤。原始日志不改写，也无需手动删除真实索引。

## 隐私口径

适配层读取日志并解析 JSON 记录，只将 `session` 头、请求模型/provider、标题与 `assistant/message` 的用量选入标准事件。解压和 JSON 解析时正文可能进入内存，不能承诺原始正文从未被读取。

正常事件构建不提取 `data.message`、`data.content`、`data.stream`、工具参数和结果作为输出字段；`test/dsh-usage.test.js` 有隐私哨兵回归。

全程只读，不写入、不修改 `~/.dsh`。

## Node 版本要求

项目统一要求 Node `>=23.8`，`package.json` 与锁文件一致。DSH 读取使用 zstd 解压，测试 fixture 还现场生成压缩帧；环境要求以项目 engines 和实际回归为准。

## 相关文件

| 文件 | 作用 |
|---|---|
| `src/dsh-usage.js` | 解析与归一化 |
| `src/usage-core.js` | 发现、分类、指纹、索引、report 接线 |
| `src/usage-store.js` | SQLite 增量索引 |
| `test/dsh-usage.test.js` | 单元与语义测试 |
| `test/three-path-parity.test.js` | 内存 / SQLite / 静态快照三路一致 |

### 新增来源时的维护点

「Codex home kinds」散落在 4 处且形式不一（`usage-store.js` 的 SQL、`app.js` 的
`CODEX_HOME_KINDS`、`timeline-utils.js` 的反向列表、`service-tier-evidence.js` 的另一处）。
DSH 不在 Codex 白名单内，因此被排除出限额统计；新增来源时需同步核对这些判据，不能仅修改显示文案。
