# 为 DS Harness（DSH）增加用量数据源 — 实施计划

> **历史归档 · 2026-10-01**。原路径：`docs/dsh-adaptation-plan.md`。相关实现已纳入提交 `28568ef`。正文中的旧进度、测试数字、路径与施工指令保留当时语境，不作为当前任务。现行说明见[DSH 数据源](../../data-sources/dsh.md)，遗留验证见[任务清单](../../02-tasks.md)，资料关系见[本批归档索引](00-index.md)。

状态：**M1（数据通路）已完成并实测通过**；M2（表现层）待做。见 §14 实施记录。
范围：完整对齐 ZCode —— 自动发现 + 增量索引 + 三路一致（server / SQLite / 静态导出）+ 测试
原则：分步实施，每步完成后停下等核准。

## 1. 背景

看板目前有两类数据源：Codex home（`sessions/**/rollout-*.jsonl`）与 ZCode home（`cli/db/db.sqlite`）。
DSH（DeepSeek Harness）的位置与格式与二者都不同，需要新增第三个 source kind `dsh`，与 `zcode` 完全对称。

## 2. 已探明的事实（本机实测）

### 2.1 DSH 安装位置

| 项目 | 实测路径 |
|---|---|
| 安装根目录 | `E:\DeepSeek Harness\` |
| 打包归档（DSH 全部 JS 在此） | `E:\DeepSeek Harness\resources\app.asar`（117 445 671 字节 / 11 380 个文件） |
| 未打包树 | `E:\DeepSeek Harness\resources\app.asar.unpacked\dsh\node_modules\` |
| 随附 Node | `E:\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\node.exe` |
| Electron userData | `C:\Users\Silver\AppData\Roaming\@deepseek-ai\dsh-desktop\` |

`@deepseek-ai/dsh-base` 与 `dsh-web-app` 只在 `app.asar` 内。本机**没有安装 CLI `dsh`**。
> 适配层**不需要**读安装目录，这里记录只是为了后续查证源码时有据可依。

### 2.2 DSH 数据位置

| 项目 | 实测值 |
|---|---|
| DSH home | `C:\Users\Silver\.dsh`（即 `~/.dsh`） |
| 会话日志 | `~/.dsh/sessions/<slugified-cwd>/<sessionId>/session.v4.jsonl.zstd` |
| 目录名 slug 规则 | cwd 中 `\`→`-`、`:`→`~`、空格→`~0020` |
| 子代理 | 子代理会话有**自己的** session 目录 |
| 会话投影缓存 | `~/.dsh/storages/session_projcache/sessions/<sessionId>.json` |
| 工作区映射 | `~/.dsh/storages/workspace.json` |
| 存储单元 | `~/.dsh/storages/` 下**只有** `session_projcache` 与 `workspace` |

### 2.3 无限额数据（已确认）

`~/.dsh/storages/` 下不存在任何 `rateLimit` / `quota` / `usage` 单元。
=> DSH 与 ZCode、project-log 同类：只进普通范围统计，**不进** Codex 5h/week 限额窗口。

### 2.4 会话日志格式（实测，Gate 1 结果）

以最大样本 `session-b5804091-…` 实测：

| 指标 | 实测值 |
|---|---|
| 文件大小 | 525 247 字节 |
| zstd 魔数位置 | **409 个，全部能独立解压成帧（409/409，0 失败）** |
| 分帧方式 | **多帧拼接**（每帧 1–2 条 JSONL 记录） |
| 解压后 | 1 875 627 字节 / **662 行**；JSON 解析失败 **0** 行 |

> **实现含义（关键）**：`zstdDecompressSync` 整文件解压**只出第一帧且不报错**（静默截断）。
> 因此「整体解压成功」**绝不能**作为单帧判据。`readDshSessionRows()` 必须：
> 扫描魔数 `28 b5 2f fd` → 以相邻魔数位置为帧边界逐帧解压 → 拼接成 JSONL 流。

记录类型分布（每条记录都带 `seq` 与 `time`，`time` 为 epoch ms）：

| type | 条数 | 是否有用量 |
|---|---|---|
| `tool/call` | 127 | 否 |
| `tool/result` | 127 | 否 |
| `session-log-deepseek/delivery-accepted` | 90 | 否 |
| `step/start` | 89 | 否 |
| **`assistant/message`** | **89** | **是 ← 唯一用量来源** |
| `step/end` | 89 | 否 |
| `agent/inbox/spliced` | 14 | 否 |
| `user/message` | 9 | 否 |
| `turn/start` / `turn/end` | 6 / 6 | 否 |
| `workspace/changes` | 5 | 否 |
| `session/title` | 2 | 否 |
| 其余各 1 | | `session`、`permission/preset`、`sandbox/mode`、`approval/policy`、`system/message`、`request/header`、`request/context`、`session/title-llm-request`、`subagent/catalog` |

**每条记录都带 `time`（epoch ms）** => 时间分布图可做到事件级精度。

会话头（第一帧，唯一没有 `seq`/`time`/`data` 的记录）：

```jsonc
{ "type": "session", "version": 4, "id": "<44 字符>", "createdAt": 1790546296138,
  "cwd": "E:\\12 AI\\ccusage\\codex-usage", "isSeeded": false,
  "delegationDepth": 0, "agentPreset": "standard" }
```

- `cwd` —— 直接给仓库归属，**无需**解 slug 目录名或读 projcache。
- `delegationDepth` —— 子代理会话的干净判据（`> 0` → `DSH Subagent` channel）。
- `createdAt` —— 会话起点（`session.firstAt`）。

### 2.5 用量字段（实测，字段路径已确证）

用量记录样例（`assistant/message`，`data.usage`）：

```jsonc
{ "type": "assistant/message", "seq": 18, "time": 1790546383242, "surfaceOp": "append",
  "data": { "turn": 1, "step": 1,
            "message": { /* 正文，不读 */ },
            "usage": { "inputTokens": 1614, "outputTokens": 127,
                       "cacheReadTokens": 6784, "cacheWriteTokens": 0, "totalTokens": 8525 },
            "stream": [ /* 15 条流式块，不读 */ ] } }
```

字段路径统计（89 条记录，每条都有全部 5 个字段）：

```
89  data.usage.inputTokens      =  1614
89  data.usage.outputTokens     =  127
89  data.usage.cacheReadTokens  =  6784
89  data.usage.cacheWriteTokens =  0
89  data.usage.totalTokens      =  8525
```

**语义自证（不需要读源码）**：

```
inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
  1614     +      6784       +        0          +      127        = 8525 = totalTokens ✓
```

若 `inputTokens` 已含 `cacheReadTokens`，总和会是 15 211，与该记录的 `totalTokens` 不符。
=> **`inputTokens` 是与 `cacheReadTokens` 并列的「未命中输入」**。

模型是逐请求记录的（照搬 Codex 适配里 `turn_context` 的做法维护「当前模型」变量）：

```jsonc
{ "type": "request/header", "data": { "header": { "config": {
    "provider": "deepseek-account", "model": "deepseek-flash",
    "reasoningEffort": "max", "maxTokens": 256000 } }, "reason": "..." } }
{ "type": "request/context", "data": { "provider": "...", "model": "...",
    "contextWindow": 1000000, "systemPromptUpdate": "..." } }
```

用量是 **per-request 增量**（每条自带 `turn`/`step`），**不是累计值**
=> 不需要 Codex 那边的 `diffUsage` 累计差分，也不需要 `cacheWriteForEvent`。

## 3. 关键设计约束（本计划最重要的部分）

### 3.1 现有代码的硬性不变量：`cached <= input`

`public/usage-fields.js:36` 的 `validateUsageDetails()`：

```js
if (inputKnown && cachedKnown && usage.cached > usage.input) {
  gap += usage.cached - usage.input;
  mask &= ~USAGE_DETAIL_MASK.cached;   // 缓存明细被撤销
}
if (gap > 0) mask |= USAGE_DETAIL_INCONSISTENT;
```

`src/pricing.js:1070-1085` 的分档计价：

```js
const cachedValid = usage.cachedKnown && usage.cached <= input;
if (cachedValid && writeValid && usage.cached + cacheWriteTokens <= input) {
  addCost(input - usage.cached - cacheWriteTokens, "input");   // 未命中
  addCost(usage.cached, "cachedInput");                        // 命中
  addCost(cacheWriteTokens, "cacheWrite");
} else { /* 退化为「按最低费率估算」，并标记 inconsistent */ }
```

`src/pricing.js:1209-1211` 的缓存命中率：`cacheRateInput += usage.input; cacheRateCached += usage.cached;`
`public/i18n.js:177` 的说明文案：`"缓存读取 ÷ 总输入"`。
ZCode 的既有断言（`test/zcode-usage.test.js:226`）：`input: 100, cached: 40, cacheWrite: 10` —— `cached <= input` 成立，`detailMask: 15`。

**结论：看板的 `input` 是「总输入（含缓存命中）」这个超集，`cached` 是 `input` 的子集，`input - cached - cacheWrite` 才是未命中部分。**

### 3.2 天真映射会踩三个坑

若直接把 `input ← inputTokens(1614)`、`cached ← cacheReadTokens(6784)`：

1. `cached > input` → `validateUsageDetails` 撤销 cached 明细并置 `USAGE_DETAIL_INCONSISTENT`。
2. `pricing.js` 走「最低费率估算」分支，费用不准并被标注不可计价。
3. 缓存命中率显示为 6784 / 1614 ≈ **420%**，明显异常。

### 3.3 正确映射：把 DSH 的并列字段重构成超集

```
input     = data.usage.inputTokens + data.usage.cacheReadTokens   // 8398（总输入）
cached    = data.usage.cacheReadTokens                            // 6784（其中命中）
cacheWrite= data.usage.cacheWriteTokens                           // 0
output    = data.usage.outputTokens                               // 127
reasoning = 0                                                     // DSH 未单列，不置 mask 位
total     = data.usage.totalTokens                                // 8525（或四项之和，二者恒等）
```

校验：`cached + cacheWrite = 6784 + 0 = 6784 <= input 8398` ✓
计价展开：未命中 `8398 - 6784 - 0 = 1614` ✓、命中 `6784` ✓、缓存写 `0` ✓ —— 与 DSH 原始语义完全一致。
缓存命中率：`6784 / 8398 ≈ 80.8%` ✓ 合理。

**另一个必须注意的点**：映射后 `total(8525) !== input(8398) + output(127) = 8525` ✓ 恰好相等。
但这是巧合性的对齐 —— DSH 的 `totalTokens` 定义就是四项之和（`inputTokens` 只是其中一项）。
因此 `validateUsageDetails` 的 `total !== input + output` 检查不会误报。**这一点必须有回归测试锁定**，
否则一旦 DSH 改动 `totalTokens` 定义，看板会静默转入 inconsistent 分支。

其余字段：

| 看板字段 | 来源 |
|---|---|
| `requestInputTokens` | `inputTokens + cacheReadTokens`（总输入；`= 8398`） |
| `contextLevel` | 依 `LONG_CONTEXT_INPUT_THRESHOLD` 由 `requestInputTokens` 判定 |
| `detailMask` | 四个明细位全置（`input\|cached\|output` 已知，`reasoning` 不置）→ `7`；cacheWrite 位按已知置 `32` |
| `reconciliationGap` | 经 `validateUsageDetails()` 计算（期望 0） |
| `serviceTier` | 无对应字段，置 `"unknown"` |
| `priceVersion` | `pricingVersionForTimestamp(timestamp)` |

### 3.4 价目已就绪

`src/pricing.js:166` 已有 `deepseek-flash`（CNY，含 DeepSeek 谷时 5 折的 `offPeakMultiplier`），
`request/header` 里的 `model: "deepseek-flash"` 正好命中。无需新增价目。

但 **`currencyForEvent()`（`src/pricing.js:943`）只看 `startsWith("zcode")`**：

```js
return channel.toLocaleLowerCase().startsWith("zcode") ? "CNY" : "USD";
```

DSH 的 channel 是 `"DSH"`，不改这条会被按 USD 计价。必须改成「zcode/dsh 前缀 → CNY」。

## 4. 设计

新增第三个 source kind `dsh`，与 `zcode` 完全对称。

新增 **`src/dsh-usage.js`**：

| 导出 | 作用 |
|---|---|
| `dshHomeLooksUsable(homePath)` | 探测 `<home>/sessions` 是否存在 |
| `dshSessionFiles(homePath)` | 递归收集 `sessions/**/session.v*.jsonl.zstd` |
| `dshSourceStat(filePath)` | `{ size, mtimeMs }`，供增量指纹 |
| `readDshSessionRows(filePath)` | async generator：**逐帧** zstd 解压 → 按行 `JSON.parse` |
| `streamDshSessionEvents(filePath, source, onEvent, options)` | 归一化为标准 event |
| `parseDshSessions(homePath, source, options)` | 供 report 路径，返回 `{ sessions, events }` |

`readDshSessionRows()` 的实现要点：

1. 读整个文件为 Buffer（样本最大 525 KB，可控）。
2. 扫描 zstd 魔数 `28 b5 2f fd` 的**全部**出现位置（样本实测 409 个位置 409 个真帧，但实现仍按「能否解压」容错）。
3. 以相邻魔数位置为边界逐帧 `zstdDecompressSync`；单帧失败只记警告、不中断整文件。
4. 拼接后按行 split + `JSON.parse`，跳过空行与坏行（与现有 `readJsonlRows` 的容错口径一致）。

事件构建（单遍扫描，维护状态）：

```
状态：sessionId / cwd / delegationDepth / channel / createdAt / currentModel / currentProvider
- 遇 type === "session"            → 取 id, cwd, delegationDepth, createdAt（只出现一次，首帧）
- 遇 type === "request/header"     → currentModel = data.header.config.model, currentProvider = data.header.config.provider
- 遇 type === "request/context"    → 同样可更新 model/provider（兜底）
- 遇 type === "session/title"      → conversationName = data.title
- 遇 type === "assistant/message"  → 若 data.usage 存在且非零，产出一个事件
- 其余 type                        → 忽略（tool/call、stream、正文一律不读）
```

channel：`delegationDepth > 0` → `"DSH Subagent"`，否则 `"DSH"`。
model 兜底：无 `request/header` 时先用 `"Unknown model"`；可选回退读 projcache 的 `modelSelection.lastUsed.model`（**建议一期不做**，保持单一数据来源，见 §7）。

**隐私口径（硬要求）**：只读 `data.usage`、`request/*` 的 model/provider、`session` 头、`session/title`。
**绝不读取、绝不落地** `data.message`、`data.content`、`data.stream`、`tool/call.arguments`、`tool/result.message` 等正文字段 —— 与现有 Codex/ZCode 适配一致。

## 5. 改动清单（按依赖顺序）

### A. 数据源模块
1. 新增 `src/dsh-usage.js`（见 §4）。

### B. `src/usage-core.js`（7 处）
2. `classifyImportDirectory()`（:292）增加 `dsh-home` 分支；`unsupported` 的 reason 文案（:331）补上 DSH。
3. 新增 `export async function discoverDshHomes(options)`（:394 之后），对称于 `discoverZcodeHomes`：
   默认 `~/.dsh`；`CODEX_USAGE_DSH_HOMES` 追加；`CODEX_USAGE_DSH=0` 关闭。
4. `discoverUsageSources()`（:433）并入 DSH，并在 import-dir 循环里加 `dsh-home` 分支。
5. `buildUsageFingerprint()`（:523）加 DSH 分支（逐个 session 文件 stat）。
6. `streamUsageFileEvents()`（:1472）加 `source.kind === "dsh"` 分派。
7. 新增 `parseDshForIndex()`（对称 `parseZcodeDbForIndex` :1566），输出索引事件形状
   `{ t, s, h, l, c, p, rk, rp, rt, m, total, input, cached, output, reasoning, detailMask, reconciliationGap, cacheWriteTokens, cacheWriteKnown, requestInputTokens, contextLevel, serviceTier, priceVersion }`。
8. `buildUsageReport()`（:1604）与 `buildUsageIndex()`（:1692）各加 DSH 分支。

### C. `src/usage-store.js`（4 处）
9. `usageFiles()`（:411）加 DSH 分支（展开为**多个**文件，不是单文件）。
10. `STORE_SCHEMA_VERSION` 8 → 9 并加 `version === 8` 迁移。
    **本次不改表结构**，但索引语义变了（新增来源），抬版本号以便未来演进；迁移体可为「把 `kind='dsh'` 的行标记重扫」或空操作 —— 实施时按是否改表决定。
11. `nonCodexHomeIds()`（:662）注释更新 —— **SQL 无需改**，`NOT IN ('main','jetbrains','extra','codex')` 已自动排除 `dsh`。
12. `metadata()`（:688）把 `harnessModels` 由 `{Codex, ZCode}` 扩为 `{Codex, ZCode, DSH}`，分桶判据改按 channel 前缀。

### D. `src/pricing.js`（1 处）
13. `currencyForEvent()`（:943）判据从 `startsWith("zcode")` 改为「zcode/dsh 前缀 → CNY」。
    **不改这条，DSH 的 DeepSeek 用量会被按 USD 计价。**

### E. `src/server.js`（1 处）
14. `describeImportEntry()`（:178）加 `dsh-home` 分支的 label（`DSH <basename>`）与路径透传。

### F. 前端 `public/`（4 处）
15. `public/timeline-utils.js:179` `hasSelectedCodexSource()` 的排除列表加 `"dsh"`
    —— 否则选中 DSH 来源会错误点亮 Codex 限额按钮。
16. `public/app.js:2545` 空状态文案、`:2589-2614` `metadataFromReport` 的 harnessModels 扩为三元（与 C12 对应）。
17. **`public/app.js:3083` `pricingHarnessGroups()`** —— 该函数把在用模型硬编码成 `{Codex, ZCode}` 二元分组
    （`:3085` 初始化、`:3090-3091` 取用、`:3140` `sections = ["Codex", "ZCode"]`）。
    C12 把 `harnessModels` 扩成三元后，若不改这里，**DSH 模型会在「计价」弹窗的「在用模型」分组里凭空消失**
    （`:3087` 的 `hasHarnessData` 只检查 Codex/ZCode，仍为真，所以不会走 `:3093` 的兜底分支）。
    必须同步扩为三元。这是本次最容易漏、且症状隐蔽的一处。
18. `public/i18n.js` 新增文案（中英各一份）：空状态「没有发现 Codex、ZCode 或 DSH 目录」、导入失败提示、harness 分组名 `DSH`。

### G. 文档（2 处）
19. `README.md` / `README.en.md` 数据来源章节补 DSH（`~/.dsh`、zstd 多帧、只读、`CODEX_USAGE_DSH_HOMES` / `CODEX_USAGE_DSH`）；
    「看板功能」里限额按钮保持「只统计 Codex 来源」的说明。
20. `docs/` 补一份 DSH 数据源说明（存储布局、逐帧解压、字段映射与 `cached <= input` 不变量的来龙去脉、隐私口径）。
    本文件转为该说明的上位设计文档。

## 6. 测试

新增 `test/dsh-usage.test.js`，对照 `test/zcode-usage.test.js` 的结构。
fixture 用 `zlib.zstdCompressSync` 现场生成 **多帧** `session.v4.jsonl.zstd`，**不需要二进制夹具入库**。

**必须覆盖的三个语义测试（最关键）**：

1. **多帧解压**：构造 3+ 帧的日志，断言全部记录都被读出（回归 `zstdDecompressSync` 静默截断的坑）。
2. **映射不变量**：用 §2.5 的真实数字（1614 / 6784 / 0 / 127 / 8525）构造 fixture，断言
   `input === 8398`、`cached === 6784`、`total === 8525`、`reconciliationGap === 0`、`detailMask` 含 cached 位。
   **这条直接锁定「天真映射会踩的三个坑」，防止回归。**
3. **计价分档**：断言 `estimateEventCost` 对 DSH 事件走的是正常分档而非「最低费率估算」分支，
   且币种为 CNY。

其余覆盖：

- 自动发现 `~/.dsh`；`CODEX_USAGE_DSH=0` 关闭；`CODEX_USAGE_DSH_HOMES` 追加；`classifyImportDirectory` 识别 `dsh-home`。
- `delegationDepth > 0` → channel `DSH Subagent`；`= 0` → `DSH`。
- 模型跟踪：`request/header` 改模型后，后续 `assistant/message` 用新模型；无 header 时回落 `Unknown model`。
- `cwd` 归组仓库；`session/title` 作为 conversationName。
- 容错：空文件、坏行、单帧损坏、`data.usage` 缺失或全零（跳过不产出事件）、正文字段不被读取。
- 隐私回归：断言 fixture 里的正文哨兵字符串**不出现在任何产出事件中**。

更新受影响的既有断言：`test/usage-core.test.js`、`test/usage-store.test.js`、`test/server.test.js`、
`test/static-export.test.js`、`test/i18n.test.js`（harnessModels 形状、文案、`hasSelectedCodexSource`）。
**在 `test/three-path-parity.test.js` 加入 DSH 的三路一致断言** —— 这是「完整对齐」的验收核心。

收尾门禁：`npm test`、`npm run typecheck`、`npm run lint`、`npm run format:check`（Biome：120 宽、双引号、2 空格）。

## 7. 明确不做（一期范围外）

- **不读 projcache 作为用量来源**：日志已足够，且 projcache 只有会话级累计值、无事件时间戳。仅在未来需要「无日志的会话」兜底时再引入。
- **不读正文**：`data.message` / `content` / `stream` / 工具参数与结果一律不读（§4 隐私口径）。
- **不做 DSH 限额窗口**：DSH 无配额数据，也无需伪造。
- **不改 Codex / ZCode 既有解析路径**：只做加法，不改既有行为，以保三路一致基线不动。

## 8. 实施顺序与验证点

| 阶段 | 内容 | 验证 |
|---|---|---|
| P1 | `src/dsh-usage.js` + `test/dsh-usage.test.js` | 三个语义测试通过（多帧 / 映射不变量 / 计价分档） |
| P2 | `usage-core.js` 7 处接线 | `usage-core` 单测 + `node src/cli.js summary` 出现 DSH 来源 |
| P3 | `usage-store.js` 4 处 + `pricing.js` 币种 + `server.js` | `usage-store` / `pricing` / `server` 单测 |
| P4 | `public/` 3 处 + i18n | 浏览器目检：来源列表出现 DSH、模型/仓库/时间分布正确、**限额按钮不被 DSH 点亮**、缓存命中率合理（非 420%） |
| P5 | 三路一致 + 文档 | `three-path-parity` 通过；`npm run export` 后静态快照含 DSH 且可切换语言 |

## 9. 风险与回退

| 风险 | 应对 |
|---|---|
| 增量索引：日志是**追加**写入，帧数随时间增长 | 沿用 `replaceFile` 的「整文件重解析」策略，以 size+mtime 指纹判定变化。已完整写入的帧不会变化，安全 |
| 单帧损坏（写入中途被杀） | 逐帧容错，坏帧记警告不中断；已实测 409/409 帧完整 |
| `session.v4` 是**带版本**的格式 | 仅在 `session.version === 4` 时按本文档解析；未来版本应显式拒绝或加迁移，**不要静默按 v4 解析** |
| DSH 未来把 `inputTokens` 改为含 cached | §6 的测试 2 会立刻失败。这是有意的护栏 |
| 大文件性能 | 样本最大 525 KB / 662 行，其余多为几百字节到 47 KB。整文件读入内存无压力 |
| Node 版本 | 需要 `zlib.zstdDecompressSync`（Node ≥ 22.15 / 23.8），而 `package.json` 的 `engines` 声明 `>=22.13`。**建议一并把 `engines` 抬到 `>=22.15` 并在 README 注明** |
| 隐私 | 只读用量与元数据，正文字段不读不落地；§6 有哨兵回归测试 |
| 只读原则 | 全程不写入、不修改 `~/.dsh` |

## 11. 计划定稿前的实测验证（已执行）

本节记录的不是推理，是**跑出来的结果**。

### 11.1 基线门禁（全部已实测通过）

| 门禁 | 结果 |
|---|---|
| `node --test` | **200 pass / 0 fail**，2.78 s |
| `tsc -p tsconfig.checkjs.json` | exit 0，**0 error** |
| `biome check --formatter-enabled=false .` | exit 0，40 warnings（**存量警告，非本次引入**） |
| `biome format .` | exit 0 |

> 环境注意：`npm.ps1` 被执行策略禁止，须用 `npm.cmd` / `npx.cmd`。
> 本会话的 `pwsh` 工具此前因沙箱初始化失败全程不可用，文件策略放开后已恢复正常。

### 11.2 逐帧解压算法（已用真实数据验证）

在真实日志上跑通「扫魔数 → 逐帧解压 → 按行 JSON.parse」：

| 样本 | 帧数 | 解压成功 | 行数 | 解析失败 |
|---|---|---|---|---|
| `session-b5804091-…` | 409 | 409 | 662 | 0 |
| 同一文件（后续追加） | 453 | 453 | 746 | 0 |

**98 条 `assistant/message` 全部带 `data.usage`（98/98）** —— 无需为缺失用量写兜底分支。

四项之和恒等式在整个会话上成立：

```
SUM(inputTokens) 110128
+ SUM(cacheReadTokens) 7904768
+ SUM(cacheWriteTokens) 0
+ SUM(outputTokens) 63881
= 8078777 = SUM(totalTokens) ✓
```

### 11.3 §3.3 映射方案（已跑真实生产代码验证）

把真实 DSH 数据按 §3.3 映射后，**喂进项目自己的 `validateUsageDetails()` 与 `estimateEventCost()`**：

| 检查项 | 结果 |
|---|---|
| 事件数 | 99 |
| `USAGE_DETAIL_INCONSISTENT` 命中 | **0** |
| `reconciliationGap` 合计 | **0** |
| `cached <= input` 不变量 | 全部成立 |
| 计价币种 | **CNY** ✓ |
| 退化为「最低费率估算」 | **0 次** ✓ |

=> §3.3 的「超集重构」映射已成为**实测结论**，而非设计推断。
=> §3.2 描述的「天真映射会踩的三个坑」是真实存在的，若按 `input ← inputTokens` 直映必踩。

## 12. 实施难度与一次通过概率（评估）

**难度：5 / 10**（可执行环境下）。**一次拿到全绿的把握：70–75%**；**一轮修复内收敛的把握：≈95%**。

### 12.1 为什么难度不高

- 设计完全冻结：字段语义自证、映射已用生产代码验证、分帧算法已在真实数据上跑通。
- 模板现成：`zcode-usage.js` + `zcode` 的 7 处接线是 1:1 可照搬的范式。
- 反馈闭环快：全套测试 2.8 s，typecheck 56 ms，lint 54 ms —— 改完立刻知道对错。
- 零新增依赖：测试 fixture 用 `zlib.zstdCompressSync` 现场生成。

### 12.2 难度来自哪里（不是算法，是机械一致性 + 一处隐蔽陷阱）

1. **19 处改动点必须同步**，其中 3 处漏改会「静默不报错但功能错」：
   - `pricing.js:943` 币种 → 错按 USD 计价
   - `timeline-utils.js:179` → 限额按钮被 DSH 错误点亮
   - **`app.js:3083` `pricingHarnessGroups()` → DSH 模型从计价弹窗消失**（本轮新发现，最隐蔽）
2. **`usage-core.js` 2545 行、7 个接线点**，且索引路径要求「部分写入状态」不报错。
3. **`app.js` 4138 行**，目标函数只读过片段。
4. **测试连锁**：改 `harnessModels` 形状会波及既有断言，可能来回几轮（但每轮 3 s，成本低）。
5. 若干小不确定项：`usage-store` 迁移的确切写法、`three-path-parity` 的断言接口。

### 12.3 为什么不是 90%+ 一次通过

真实分布更可能是「19 处里 18 处一次对 + 1 处需要一轮修复」（前端或测试连锁）。
但**一轮修复即全绿**的概率很高，且**设计风险已归零** —— 剩下的全是机械风险。

### 12.4 建议分两个里程碑，降低单次投放风险

| 里程碑 | 内容 | 一次通过把握 |
|---|---|---|
| **M1：数据通路**（A–E） | `dsh-usage.js` + `usage-core.js` + `usage-store.js` + `pricing.js` + `server.js` + `test/dsh-usage.test.js` | **≈90%**（纯后端、模板化、可实测交叉验证） |
| **M2：表现层**（F–G） | `app.js` + `timeline-utils.js` + `i18n.js` + 文档 + `three-path-parity` | **≈80%**（前端 `app.js` 熟悉度较低） |

M1 完成后可立刻用 `node src/cli.js summary` 与真实 DSH 数据对照，再进 M2。

## 13. 工作区临时文件

| 文件 | 说明 |
|---|---|
| `.dsh-probe.mjs` | 只读探针（`--analyze` / `--dump` / `--no-asar`）。保留，供后续真实数据交叉验证 |
| ~~`.dsh-probe.cjs`、`.dsh-probe2.cjs`、`.dsh-probe-scan.cjs`、`.dsh-probe-session.cjs`、`tmp-dsh-probe.mjs`~~ | 早期废弃版本，**已删除** |

## 14. 实施记录

### M1 数据通路（已完成）

| 步骤 | 内容 | 结果 |
|---|---|---|
| M1-1 | 新增 `src/dsh-usage.js` | 逐帧解压 + `data.usage` 抽取 + 模型/cwd/`delegationDepth` 跟踪 |
| M1-2 | 新增 `test/dsh-usage.test.js` | 三个语义测试 + 容错 + 隐私哨兵 |
| M1-3 | `usage-core.js` 接线 7 处 | 发现 / 分类 / 指纹 / 分派 / 索引 / report |
| M1-4 | `usage-store.js` 接线 4 处 | 多文件分支 / schema 8→9 / 注释 / `harnessModels` 三元 |
| M1-5 | `pricing.js` 币种判据 | `zcode`/`dsh` 前缀 → CNY |
| M1-6 | `server.js` 导入分支 | `dsh-home` 标签与路径透传 |
| M1-7 | 三路交叉验证 | 见下 |

**门禁（全绿）**：`node --test` 235 pass / 0 fail；`tsc` exit 0；`biome check` exit 0；`biome format` exit 0；`node src/static-export.js` exit 0。

**三路一致实测**（真实数据，三条独立路径）：

| 路径 | events | total | input | cached | output |
|---|---|---|---|---|---|
| 独立手写实现（不复用 `dsh-usage.js`） | 349 | 54,251,370 | 54,071,584 | 53,673,600 | 179,786 |
| `buildUsageReport` | 349 | 54,251,370 | 54,071,584 | 53,673,600 | 179,786 |
| `UsageStore` 索引 | 349 | 54,251,370 | 54,071,584 | 53,673,600 | 179,786 |

CLI 摘要拆分（`DSH` 49,429,153 + `DSH Subagent` 4,822,217）恰好等于 54,251,370，与上表一致。
静态快照 `dist/codex-usage.html` 已含 DSH（709 处）与 DSH Subagent（47 处）。

### 实施中发现并修掉的问题（计划阶段未预见）

1. **`zstdDecompressSync` 对畸形帧不抛错**，而是静默返回空 buffer。原先靠 `try/catch` 判坏帧是死代码 —— 已改为按空内容判坏帧，并加测试锁定该前提。
2. **`classifyImportDirectory` 优先级错误**：`codexHomeLooksUsable` 只看「有没有 `sessions` 目录」，而 `~/.dsh/sessions` 同名，导致 `~/.dsh` 被判成 `codex-home`。
3. **`dshHomeLooksUsable` 判据过松**（修完上一条后暴露）：`~/.codex/sessions/.tmp` 里也有 jsonl，导致 `~/.codex` 被判成 `dsh-home`。已改为必须存在 `sessions/<slug>/<sessionId>/session.v<N>.jsonl.zstd`。
4. **`STORE_SCHEMA_VERSION` 被 v7 迁移当参数用**：把常量从 8 改成 9 后，那条迁移的落点被静默改成 9，导致新的 v8→9 迁移永不执行。已改为字面量 8。

### M2 表现层（已完成）

| 步骤 | 内容 | 结果 |
|---|---|---|
| M2-1 | `app.js` 三处 + harness 去重 | 抽 `HARNESS_ORDER` / `bucketForChannel` / `newHarnessModelBuckets` / `harnessModelLists` / `claimHarnessKeys` |
| M2-2 | `timeline-utils.js` | `NON_CODEX_SOURCE_KINDS` 排除 `dsh`（并对齐 `project-log`） |
| M2-3 | `i18n.js` | 空状态 / 导入提示 / 错误码三条中英 |
| M2-4 | 三路一致断言 | 已固化进 `test/three-path-parity.test.js` |
| M2-5 | 文档 + `engines` | README 中英、`docs/dsh-data-source.md`；`engines` → `>=23.8` |
| M2-6 | 全量门禁 + 目检 | 见下 |

### M2-6 验证结论

**可程序化验证的部分（已实测通过）**：

| 检查项 | 结果 |
|---|---|
| `node --test` | 241 pass / 0 fail / 0 todo |
| `tsc` / `biome check` / `biome format` | exit 0（40 warnings 为存量） |
| `node src/static-export.js` | exit 0 |
| 有限额按钮：仅选中 DSH / ZCode | `hasSelectedCodexSource` → `false` ✓ |
| 限额按钮：仅选中 Codex | → `true` ✓ |
| `harnessModels` 三元 | `{Codex:[6], ZCode:[7], DSH:["deepseek-flash"]}` ✓ |
| DSH 缓存命中率 | 99.7% / 子代理 96.5% —— 均未超过 100%（非天真映射的 420%）✓ |
| `/api/usage` HTTP 实测 | 200；渠道含 `DSH` 与 `DSH Subagent`；homes 含 `Main DSH [dsh] active events=443 sessions=4` ✓ |

**仍需人工目检**（无浏览器自动化，且验证时未能截图）：

- 计价弹窗「在用模型」分组里 **DSH 分区为空**（`deepseek-flash` 已被 `ZCode` 分区按先到先得认领）。
  这是 M2-1 去重策略的既定取舍，已获确认。
- 时间分布图三种模式、悬浮提示、图例中 DSH 渠道的显示。
- 主题/语言切换后新增文案的呈现。

**注意**：验证时 3765 端口上运行的是**改动前启动的旧服务**，其 `/api/usage` 不含 DSH。
需要重启该服务才能看到 DSH（`node src/cli.js run`）。
