# 为 OpenCode 增加用量数据源 — 实施计划（v2.1，合并定稿）

状态：**Gate 0 完成；D1、D2 已关闭（见 §10）；可开工 P0。**
范围：完整对齐 ZCode/DSH —— 自动发现 + 增量索引 + 三路一致（内存 / SQLite / 静态导出）+ 测试，外加一条小的计价规则（`-free` 模型零费率）。
原则：分步实施，每步完成后停下等核准；不改 Codex / ZCode / DSH 既有**解析**路径。
基线：`node --test` 245 pass / 0 fail（2026-09-30 复测）。

> **本文是唯一的执行依据。** v1 原稿与三轮复审的原文保留在
> [`opencode-adaptation-plan.reviews.md`](opencode-adaptation-plan.reviews.md)（只读历史，
> **其中的映射与测试数字有错误，不要照它实现**）。谁提出了什么见文末 §12。
> v2.1 相对 v2 的实质变化：**映射补上 `cache.write`**、新增会话版本守护、D1/D2 决议与 `pricing.js` 的 `-free` 规则。

## 1. 背景

看板已有三类数据源：Codex home（`sessions/**/rollout-*.jsonl`）、ZCode home（`cli/db/db.sqlite`）、
DSH home（`sessions/**/session.v*.jsonl.zstd`）。OpenCode 与三者都不同，需要新增第四个
source kind `opencode`，与 `zcode` 基本对称（单个 SQLite 只读打开 + 流式扫描映射）。

## 2. 已探明的事实

本机数据库：`C:\Users\Silver\.local\share\opencode\opencode.db`（Windows 上也是 XDG 风格路径），
WAL 模式，运行中只读打开成功，`-wal` 体量与主库同量级、不可忽略。

> 探针数字（行数、字节数、各模型行数）是**活库快照**，几小时即过期，本文只写结论；
> 具体数字在 P5 写入 `docs/opencode-data-source.md` 时标注采集时间。

### 2.1 表结构（与公开文档不符，且仍在变）

没有 `session / message / part` 表（那是 v1 布局），实际是 **`session_v2` + `session_message`**（本机 v2.0.19 / 2.0.20）。

| 表 | 用途 |
|---|---|
| `session_v2` | 会话级：`directory`、`title`、`model`(JSON)、`agent`、`version`、`parent_id`、`fork_session_id`、聚合 `tokens_*`、时间 |
| `session_message` | 列 `id, session_id, type, seq, time_created, time_updated, data(JSON TEXT)`；`type` 取值不稳定（已见 `assistant / user / idle / system / model-switched`，Gate 0 之后新增过类型） |

事件白名单放在 **SQL 层**（`WHERE type='assistant'`），新类型自动被排除。
索引 `session_message_session_type_seq_idx` 存在；`(session_id, seq)` 观测上无重复，但**无 DB 级 UNIQUE 约束**，适配器不得假设唯一。

`data` 顶层键：`time, agent, model, content, snapshot, finish, providerState, cost, tokens, rawFinish`。
用量在 `data.tokens = {input, output, reasoning, cache:{read, write}}`；时间 `data.time.completed ?? created`（ms epoch）；
模型 `data.model.id` + `providerID`（已见 `opencode`、`opencode-go`；`variant` 可缺）。
个别 assistant 行**无 `tokens`**（形状：`time/agent/model/content/snapshot`，疑似中断消息，约占 1%），跳过。
非 assistant 行不携带 `tokens`（已查空）。

**`cost` 一律忽略，且不能当"免费"证据**：本机 `cost` 恒为 0，但上游 issue #30706 指出 v2 runner 在
`step-finish` 里**硬编码 `cost: 0`**（不调用价格计算），所以 0 不代表免费。"是否免费"只能按模型名判断（见 D1）。

### 2.2 用量粒度：per-assistant-message

事件只从 `type='assistant'` 且含 `data.tokens` 的行产出。`session_v2` 的聚合值**不做事件来源**：
无事件时间戳，且与消息求和**永远有差**（4/4 会话偏高，量级 58–557 不等，个别会话 cache 也不等）。
成因未确认，疑似未落 assistant 行的模型调用（如标题生成），**文档不写死成因**。该差值不收敛，
`opencode-data-source.md` 需写明，避免日后被反复提问。

### 2.3 口径：三条并列陷阱，必须同时处理

**上游依据（D2 已核实）**：v2 runner（`packages/core/src/session/runner/publish-llm-event.ts`）写入的是

```
input  = usage.nonCachedInputTokens   // 不含 cache.read，也不含 cache.write
output = usage.visibleOutputTokens    // 可见输出，不含 reasoning
reasoning = usage.reasoningTokens
cache  = { read: cacheReadInputTokens, write: cacheWriteInputTokens }
```

即 `tokens` 是**互不重叠**的拆分。看板要求 `cached + cacheWrite ⊆ input`、`reasoning ⊆ output`
（`pricing.js:1074-1077` 按 `input − cached − cacheWrite` 计未命中；`usage-fields.js` 校验 `reasoning <= output`），
所以三处都要重构成超集：

```
input      = tokens.input + tokens.cache.read + tokens.cache.write   // 总输入
cached     = tokens.cache.read
cacheWrite = tokens.cache.write
output     = tokens.output + tokens.reasoning                        // 总输出（折叠）
reasoning  = tokens.reasoning                                        // output 的子集
total      = input + output
requestInputTokens = input
```

> **v2 之前的版本都漏了 `cache.write`。** 本机 `cache.write` 恒为 0（没有 Anthropic 类 provider），
> 任何基于本机数据的测试都抓不到；但 Anthropic/Bedrock 用户的 `cache.write` 很大。漏加的后果：
> `cached + cacheWrite > input` → 走 `input-detail-inconsistent-minimum-scenario`，或 input 被多减而少计费。
> ZCode 的 `input_tokens` 已是含 write 的超集（fixture：`input 100 ≥ cached 40 + write 10`，`total=120=100+20`），与此口径一致。

依据（均已对源码核对）：

- `public/usage-fields.js:36`：`cached > input` → 撤销 cached 明细并置 INCONSISTENT。
- `public/usage-fields.js:43`：`reasoning > output` → 撤销 reasoning 明细并置 INCONSISTENT。
- `public/usage-fields.js:40`：`total !== input + output` → 置 INCONSISTENT。
- `src/pricing.js:1059-1066`：INCONSISTENT ⇒ **整条事件**退化为最低费率估算。
- `src/pricing.js:1094`：只对 `usage.output` 收费，`reasoning` 从不参与计价 ⇒ reasoning 必须在 output 内才会计价。
- 真库：`reasoning > output` 的行约占四分之一，且 `SUM(reasoning)` 数倍于 `SUM(output)`；跨多个模型、多个 provider。

`reasoning` 的 detailMask 位**要置**（与 ZCode 一致；DSH 无 reasoning 所以不置）；cacheWrite 位（32）要置。

**⚠️ 折叠只对 v2 语义成立。** 上游历史上 `output` 的含义变过：较早的 v1 `getUsage` 写的是 `output = outputTokens`（**已含 reasoning**），
并在计费时再加一遍 reasoning；后来才改成 `output = outputTokens − reasoning`（可见输出）。
对旧语义的行做折叠会**重复计 reasoning**。本计划只支持 v2 表，v2 runner 写的是 `visibleOutputTokens`，折叠正确；
但库里可能存在迁移而来的旧会话 ⇒ 见 §4 的**版本守护**。

### 2.4 其余字段映射

| 看板字段 | 来源 |
|---|---|
| `channel` / `source` | 恒为 `OpenCode` / `opencode`（真库无 subagent 信号：`parent_id`/`fork` 全空、`agent` 全 `build`，v1 不发明拆分规则） |
| `model` / `modelProvider` | `data.model.id` / `data.model.providerID`；缺省回落 `Unknown model`；**不硬编码 provider 取值** |
| `cwd` / 仓库归属 | `session_v2.directory` → `createRepositoryResolver()`；`session_v2` 行缺失或 `directory` 为空 ⇒ `cwd=""`（走 unknown），**不做 parent 链递归**（真库无此用例，不可覆盖的分支不进 P1） |
| `conversationName` | `session_v2.title`，截断 120 字符，缺失留空 |
| `serviceTier` | `unknown` |
| `contextLevel` | 由 `requestInputTokens` 对 `LONG_CONTEXT_INPUT_THRESHOLD`（272_000，`pricing.js:7`）判定。真库单事件总输入远低于阈值，全部为 `short`；**聚合比高≠事件分布高**，无需任何口径说明 |
| `eventId` | `` `${session_id}:${seq}` `` |
| `priceVersion` | `pricingVersionForTimestamp(timestamp)` |

### 2.5 无限额数据

OpenCode 无配额存储 ⇒ 只进普通范围统计，**不进** Codex 5h/week 限额窗口。

## 3. 关键设计约束

- §2.3 的三处超集重构是**唯一正确映射**，必须由测试锁定（§6），且测试必须覆盖 `cache.write > 0`。
- **币种**：`currencyForEvent`（`pricing.js:943-949`）回退保持现状（非 zcode/dsh 渠道 → USD）。
- **`-free` 模型零费率（D1 决议）需要改 `pricing.js`**，这是本计划唯一的计价改动，规格见 §5-F；
  它让计划原则从"不改 pricing.js"变为"只加一条规则、不动既有费率"。

## 4. 设计

新增 **`src/opencode-usage.js`**（预计 250–350 行）：

| 导出 | 作用 |
|---|---|
| `opencodeDatabaseFiles(dataDir)` | 数据目录下 `opencode*.db`（覆盖 `opencode-<channel>.db`；`-wal`/`-shm` 不以 `.db` 结尾，自然不匹配） |
| `opencodeHomeLooksUsable(homePath)` | 目录下存在可用数据库 |
| `opencodeSourceStat(dbFile)` | `{ size, mtimeMs }`，**必须并入 `-wal`**，抄 `zcodeSourceStat` |
| `streamOpencodeDbEvents(dbFile, source, onEvent, options)` | 只读打开（失败回退普通打开，抄 `zcode-usage.js:56-63`）→ 能力探测 → 流式 `iterate` → 归一化 |
| `parseOpencodeDb(dbFile, source, options)` | 供 report 路径，返回 `{ sessions, events }` |

实现要点：

1. **能力探测**：解析前 `PRAGMA table_info(session_message)` 校验 `id, session_id, type, seq, time_created, data` 齐全；缺列 ⇒ 整来源跳过并记**可诊断**警告（该库已多次变 schema，仅靠 try/catch 不够）。`session_v2` 缺失只影响 cwd/title/版本守护，不阻断事件。
2. **会话版本守护**（D2 引出）：按 `session_v2.version` 取主版本号；**主版本 < 2 的会话整会话跳过并记警告**（旧语义 `output` 已含 reasoning，折叠会重复计数）；
   `session_v2` 行缺失或 `version` 无法解析 ⇒ **放行**并记一次警告（宁可多统计一个有提示的会话，也不因元数据缺失丢整库）。
3. 查询：`session_message WHERE type='assistant' ORDER BY time_created, seq`，列名显式枚举，禁止 `SELECT *`、禁止 `.all()`（库持续增长）。`data` 平均约 10KB、最大约 100KB，流式内存无风险。
4. 时间戳 `data.time.completed ?? created ?? 行 time_created`；非法则跳过。
5. **隐私（措辞以此为准）**：要取 `.tokens` 必须 `JSON.parse` 整条 `data`，故正文**会进入内存**；但**只提取 `tokens / model / time` 白名单字段**，
   `content / snapshot / providerState / reasoningEncryptedContent` 等**不进入任何产出事件、SQLite 索引、日志与静态导出**。不要写"绝不读取"。
6. 全程只读，不写入、不修改数据目录。
7. 折叠规则的口径来源写进代码注释（上游 `visibleOutputTokens` / `nonCachedInputTokens` + 真库实证）。

发现候选：`~/.local/share/opencode`、`%APPDATA%/opencode`、`%LOCALAPPDATA%/opencode`、`~/Library/Application Support/opencode`；
`CODEX_USAGE_OPENCODE_HOMES` 追加、`CODEX_USAGE_OPENCODE=0` 关闭（沿用本项目惯例，不用 `OPENCODE_DB` 语义）。
**v1 只收目录，不收 `.db` 文件路径导入**（与 ZCode 一致）。

## 5. 改动清单（按依赖顺序）

**F. `src/pricing.js` — `-free` 零费率（D1，最先做、单独提交）**

19. 规则：模型名（不区分大小写）以 `-free` 结尾、且**不是价目表里的精确键或别名**时，按**零费率**计价。优先级：
    `精确键 > PRICE_ALIASES > -free 零费率 > 前缀匹配 > 未知模型最低费率兜底`。
    **必须排在前缀匹配之前**：本机 4 个真实模型里有 2 个会被前缀规则（`pricing.js:862-863`）误吸收——
    `mimo-v2.6-flash-free` 会被当成付费的 `mimo-v2.6-flash`（人民币），`muse-spark-1.3-contributor-free` 会被当成
    `muse-spark-1.3-contributor`；另 2 个（`longcat-2.5-preview-free`、`space-bunny-free`）落入"未知模型最低费率"。
20. 落点：`normalizeModel()`（`:857`）在精确键与别名之后、前缀循环之前，对 `-free` 返回 `{ name, key: "", free: true }`；
    `estimateEventCost()`（`:964`）里 `free` 时 `rates` 取全零集合，且 `minimumModelRate = !model.key && !model.free`
    （否则仍会打上 `unknown-model-price-minimum-scenario` 并把 `minimumEstimatedTokens` 置满）。币种沿用 `currencyForEvent` 的渠道回退，金额为 0。
21. 影响面（需写进提交说明）：规则按**模型名**生效，不限 OpenCode 渠道——Codex/ZCode/DSH 里若出现 `-free` 模型，其估价也变 0。
    这是有意的（免费就是免费），且只改变此前走"最低费率兜底"或被前缀误吸收的那部分，不动任何已收录模型的费率。

**A. 数据源模块**
1. 新增 `src/opencode-usage.js`（§4）。

**B. `src/usage-core.js`**（抄 DSH 接线）
2. `classifyImportDirectory()`（约 :293）加 `opencode-home`，`unsupported` 文案补 OpenCode；判据须在 Codex 之前（DSH 踩过 `sessions` 同名的坑，约 :296）。
3. 新增 `discoverOpencodeHomes(options)`，对称 `discoverZcodeHomes`。
4. `discoverUsageSources()` 并入，并在 import-dir 循环加分支。
5. `buildUsageFingerprint()` 加单文件分支（含 wal）。
6. `streamUsageFileEvents()` 加 `source.kind === "opencode"` 分派。
7. `buildUsageReport()` 加分支。（不需要新增 `parse*ForIndex`。）

**C. `src/usage-store.js` + `src/server.js`**
8. `usageFiles()` 加单文件分支（对称 `zcodeSourceStat`）。
9. `STORE_SCHEMA_VERSION` 9→10，加 `version === 9` 空迁移。旧迁移落点保持字面量（DSH 踩过"常量当参数"的坑）。
10. `metadata()`（约 :705）`harnessModels` 扩为四元，分桶按 channel 前缀。`nonCodexHomeIds()` 是白名单 SQL，自动排除，**无需改**。
11. `server.js` `describeImportEntry()`（约 :187）加 `OpenCode <basename>` 分支。
12. `service-tier-evidence.js:56` 对非 Codex 来源是 fail-open（找不到 `logs_2.sqlite` 即空），DSH 漏加无害，OpenCode 同理；补 `kind` 排除**仅为可选清理**。

**D. 前端 `public/`**
13. `app.js`（约 :2589）`HARNESS_ORDER` 加 `"OpenCode"`，`bucketForChannel` 加 `opencode` 前缀；`claimHarnessKeys`/`pricingHarnessGroups` 自动生效，顺手验证跨 harness 去重。`CODEX_HOME_KINDS`（:46）fail-open，无需改。
14. `timeline-utils.js`（约 :177）`NON_CODEX_SOURCE_KINDS` 加 `"opencode"`，否则限额按钮会被误点亮。
15. `i18n.js` 三条文案中英（空状态、目录提示、`INVALID_IMPORT_DIRECTORY`）；i18n 测试要求每个静态标签都有英文。

**E. 文档**
16. `README.md` / `README.en.md`：数据来源、只读、两个环境变量；限额仍"只统计 Codex 来源"；费用估算段补一句"名称以 `-free` 结尾的未收录模型按零费率估算"。
17. 新增 `docs/opencode-data-source.md`：表结构（标"快照非契约"）、三条并列陷阱的推导与上游依据、版本守护、聚合永不收敛、隐私措辞、`cost` 恒 0 的原因、schema 漂移警告。
18. `docs/README.md` 加链接。

## 6. 测试

### 6.1 `test/pricing.test.js`（对应 F，P0）

- `longcat-2.5-preview-free`、`space-bunny-free`：`totalUsd === 0`、`pricingStatus === "estimated"`、reasons **不含** `unknown-model-price-minimum-scenario`。
- **优先级**：`mimo-v2.6-flash-free`、`muse-spark-1.3-contributor-free` 估价为 0，且不按 `mimo-v2.6-flash`（CNY）/ `muse-spark-1.3-contributor` 计价。
- 不误伤：`mimo-v2.6-flash`（付费）费率不变；非 `-free` 的未知模型仍走最低费率兜底；`setPricingCatalog` 注入的**精确键** `xxx-free` 仍按其自定义费率计价；`-FREE` 大小写不敏感。
- 费用汇总：含 `-free` 事件的 `createCostEstimateAccumulator` 结果里 `minimumEstimatedRecords` 不把它们计入。

### 6.2 `test/opencode-usage.test.js`（P1）

新增，对照 `test/zcode-usage.test.js`；fixture 在 tmp 建最小 `session_v2`/`session_message` 库，不入库二进制。

**核心语义测试：三组 fixture × 同一组断言**（断言：`reconciliationGap === 0`、`detailMask` 不含 `USAGE_DETAIL_INCONSISTENT`、
`reasoning <= output`、`cached + cacheWrite <= input`、`total === input + output`、计价 reasons 不含
`usage-detail-inconsistent-minimum-scenario` 与 `input-detail-inconsistent-minimum-scenario`）

| 样本 | 原始 `input / output / reasoning / cache.read / cache.write` | 期望 `input / cached / cacheWrite / output / reasoning / total` |
|---|---|---|
| **病态（主，取自真库形状）** | `9648 / 45 / 420 / 0 / 0` | `9648 / 0 / 0 / 465 / 420 / 10113` |
| **三陷阱齐全（合成）** | `1000 / 10 / 300 / 5000 / 2000` | `8000 / 5000 / 2000 / 310 / 300 / 8310` |
| 常规 | `5870 / 81 / 29 / 3825 / 0` | `9695 / 3825 / 0 / 110 / 29 / 9805` |

> 常规样本任何实现下都不会触发 reasoning 不一致，**不能单独当护栏**；主护栏是前两组。
> "三陷阱齐全"是唯一覆盖 `cache.write > 0` 的样本，本机真库里没有这种数据，必须合成。

其余必须覆盖：

1. **天真映射回归**：(a) `output ← tokens.output`（不折叠）触发 reasoning 不一致；(b) `input ← tokens.input + cache.read`（漏 write）在"三陷阱齐全"样本上
   `cached + cacheWrite = 7000 > input = 6000`，计价落入 `input-detail-inconsistent-minimum-scenario`——注意这一条 `validateUsageDetails` **抓不到**，必须断言计价 reasons。
2. **粒度**：多 assistant 行 → N 事件；`session_v2` 聚合不产事件；`user/idle/system/model-switched` 不产事件；无 `tokens` 行（§2.1 形状）跳过；全零用量跳过。
3. **`eventId = session_id:seq`** 规则。
4. **高缓存判 short**：常规样本 `requestInputTokens = 9695 < 272_000 → short`。
5. **版本守护**：`session_v2.version = "1.x"` 的会话整会话跳过且有警告；`"2.0.19"` 放行；`session_v2` 行缺失或 version 非法 ⇒ 放行 + 警告；同库多会话互不影响。
6. **能力探测**：缺列 ⇒ 整来源跳过并有警告；缺 `session_v2` ⇒ 事件仍产出、`cwd=""`。
7. **发现 / 关闭 / 追加**（`CODEX_USAGE_OPENCODE=0`、`_HOMES`）；`classifyImportDirectory` 判据顺序；`opencodeSourceStat` 含 `-wal`。
8. 容错：空库、坏 `data` JSON、非法时间戳。
9. **隐私哨兵**：fixture 正文哨兵字符串不出现在任何产出事件中。

更新既有断言：`three-path-parity`（加 OpenCode **三路**断言，fixture 用"三陷阱齐全"样本 + 限额排除）、`usage-store`（metadata 四元）、
`app-render`（harness 归组）、`recent-selections`、`server`（OpenCode home 导入）、`i18n`。

门禁：`node --test`、`npx tsc -p tsconfig.checkjs.json`、`npx biome check --formatter-enabled=false .`、`npx biome format .`、`node src/static-export.js`
（Windows 用 `npm.cmd` / `npx.cmd`）。

## 7. 明确不做（一期范围外）

legacy `message/part` 表与旧 JSON 树（版本守护只负责**跳过**混在 v2 表里的旧会话，不去适配旧语义）；`OPENCODE_DB` 语义；OpenCode 限额窗口；
`session_v2` 聚合做事件；parent/fork 递归回退与 subagent 拆分；读取/落地正文；用 OpenCode 自带 `cost` 计价；
除 `-free` 规则外的任何 `pricing.js` 改动；改动 Codex/ZCode/DSH 既有解析路径。

## 8. 实施顺序与验证点

| 阶段 | 内容 | 验证 |
|---|---|---|
| **P0** | `pricing.js` 的 `-free` 规则 + §6.1（**单独提交**，与 OpenCode 解耦，便于审阅与回退） | `pricing.test.js` 全绿；`node --test` 245 + 新增全绿 |
| P1 | `opencode-usage.js` + `opencode-usage.test.js` | §6.2 核心语义测试 + 1–9 全绿 |
| P2 | `usage-core.js` 接线 | 单测 + `node src/cli.js summary` 出现 OpenCode |
| P3 | `usage-store.js` / `server.js` | 对应单测 |
| P4 | `public/` + i18n | 来源列表出现 OpenCode；**限额按钮不被点亮**；命中率 ≤100%；`-free` 模型在看板上花销为 0 |
| P5 | 三路一致 + 文档 | parity 通过；`export` 含 OpenCode 且可切语言；删除 `.opencode-*.mjs` 探针 |

**真库对照的做法（活库有竞态，不可先后各跑一次）**：先把 `opencode.db` 与 `-wal` 拷贝到临时目录，
`summary` 与独立 SQL 都读这份拷贝；或两边都加同一个 `time_created <= cutoff`。比对口径为
per-session `SUM(input + cache.read + cache.write)`、`SUM(output + reasoning)`。

## 9. 风险与回退

| 风险 | 应对 |
|---|---|
| schema 无文档且频繁变动 | SQL 层类型白名单 + `PRAGMA table_info` 能力探测 + 缺列整来源跳过并告警 |
| 上游 `tokens` 语义随版本变化（已发生过一次：`output` 由含 reasoning 改为可见输出） | 会话版本守护（主版本 < 2 跳过）；口径来源写进代码注释与数据源文档；未来若 v3 再变，以 `session_v2.version` 为开关扩展，而不是改折叠规则 |
| 迁移而来的旧会话版本号缺失/不可信 | 缺失放行并警告；如 P5 真库对照发现偏差，再收紧为"无版本则跳过" |
| 活库 WAL 只读打不开 | 只读→普通打开回退；仍失败则记警告跳过，不碰原库 |
| 首扫性能 | 流式 `iterate` + 整库 `size+mtime`（含 wal）指纹，沿用 `replaceFile` 整库重解析 |
| 聚合与消息求和永远有差 | 只用消息做事件；文档写明差值不收敛；parity 用 fixture 不用真库 |
| `-free` 规则误伤（名称以 `-free` 结尾的付费模型） | 精确键/别名优先，用户可在价目弹窗加精确键覆盖；提交说明写明影响面（§5-21） |
| 工作区混有 DSH / 定价自动更新等未提交改动 | 本计划只新增文件 + 小 hunk；混合文件（`server.js`、`app.js`、`pricing.js` 等）用 `git add -p`，见 `docs/dsh-change-summary.md`「⚠️ 提交前必读」小节；P0 尤其要单独提交 |
| 隐私 | 白名单提取 + 哨兵回归测试 |

## 10. 决议记录

**D1 — 已决议（用户，2026-09-30）：对 `-free` 模型按零费率处理。**
落地规格见 §5-F（19–21）与 §6.1，作为 P0 先做。补充发现：原以为只有"未知模型"受影响，实际本机 4 个模型中有 2 个被前缀规则误吸收为付费模型，
所以规则必须排在前缀匹配之前。

**D2 — 已核实（2026-09-30，读取上游源码与 issue）：**
- v2 runner 写入 `input = nonCachedInputTokens`、`output = visibleOutputTokens`、`reasoning` 与 `cache.{read,write}` 各自独立 ⇒ **折叠映射成立**，`reasoning > output` 监控可省（保留为可选）。
- 同一核实发现**两个计划缺陷**并已修入本文：① `input` 超集漏了 `cache.write`（§2.3）；② 上游历史上 `output` 语义变过，旧会话折叠会重复计数 ⇒ 版本守护（§4-2）。
- 上游 `cost` 在 v2 runner 里硬编码为 0（issue #30706），故不能用它判断免费（§2.1）。
- 未能核实的残余：迁移而来的旧会话在 `session_v2.version` 里记的是原版本还是迁移时版本。已按"缺失放行、< 2 跳过"处理并在 §9 留了收紧预案。
- 相邻问题（**未验证、不在本计划范围**）：`src/dsh-usage.js` 的 `input = inputTokens + cacheReadTokens` 同样没有并入 `cacheWriteTokens`，
  若 DSH 出现 `cacheWriteTokens > 0` 会有同类偏差；DSH 现有数据 `cacheWrite` 恒 0，所以此前测试没暴露。建议另开一项核查。

## 11. 难度评估

**4 / 10。** 一次全绿约 65–75%，一轮修复内收敛约 90–95%。口径风险已被 §2.3 与 §6.2 的三组样本收住（尤其"三陷阱齐全"）；
P0 的 `-free` 规则改动小但要守住优先级；剩余是约 15 处改动点的机械同步（漏 `timeline-utils` 排除列表或 `HARNESS_ORDER` 会静默出错）、
既有测试的四元期望连锁，以及活库带来的验收竞态。建议 P0 单独投放，M1（P1–P3，后端可 `summary` 实测）与 M2（P4–P5）分两步投放。

## 12. 变更记录（谁提出了什么）

| 来源 | 贡献 |
|---|---|
| **muse-spark-1.3**（原稿作者） | 整体结构、Gate 0 探针、`session_v2`/`session_message` 发现、per-message 粒度、`cache.read` 并列→超集、接线清单、隐私哨兵测试思路 |
| **MiMo-v2.6-Flash**（§11 复审） | 发现 reasoning/output 口径错误（`usage-fields.js:43` + pricing 不计 reasoning）并给出折叠映射；三路术语、笔误、错误引用、LEFT JOIN 回退、目录导入决策 |
| **space-bunny**（§12 复审） | 指出原 fixture 结构上恒绿，改用病态样本；`eventId` 规则；`PRAGMA table_info` 能力探测；隐私措辞"不提取/不落地"；type 普查非契约；聚合差永不收敛 |
| **本会话 agent**（§13 复审） | 用真库证伪"接近 100% long"与"聚合差恒定"；删除无用例的 parent 递归；病态样本补 `cache.read > 0`；关闭无 tokens 行等 Gate 1 微问题；复核全部行号 |
| **Claude Sonnet 5.5**（v2 合并 + v2.1） | 合并去冲突；活库验收竞态；提出 D1/D2；合成样本；**v2.1：读取上游源码完成 D2，发现并修复 `input` 漏 `cache.write`、`output` 语义的历史变化（版本守护）、`cost` 硬编码 0 不能当免费证据、`-free` 会被前缀规则误吸收（2/4 真实模型）；相邻的 DSH 同类疑点** |
| **用户** | D1 决议：`-free` 模型按零费率处理 |

原文与各复审全文见 [`opencode-adaptation-plan.reviews.md`](opencode-adaptation-plan.reviews.md)。
