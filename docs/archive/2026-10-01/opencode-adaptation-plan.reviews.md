# 为 OpenCode 增加用量数据源 — 实施计划

> **历史归档 · 2026-10-01**。原路径：`docs/opencode-adaptation-plan.reviews.md`。相关实现已纳入提交 `28568ef`。正文中的旧进度、测试数字、路径与施工指令保留当时语境，不作为当前任务。现行说明见[OpenCode 数据源](../../data-sources/opencode.md)，遗留验证见[任务清单](../../02-tasks.md)，资料关系见[本批归档索引](00-index.md)。

状态：**Gate 0（探针）已完成并实测通过**；P1–P5 待做。
范围：完整对齐 ZCode/DSH —— 自动发现 + 增量索引 + 三路一致（内存 / SQLite / 静态导出）+ 测试
原则：分步实施，每步完成后停下等核准；只做加法，不改 Codex / ZCode / DSH 既有解析路径。

基线：`node --test` 245 pass / 0 fail（2026-09-30 实测）。

## 1. 背景

看板已有三类数据源：Codex home（`sessions/**/rollout-*.jsonl`）、ZCode home（`cli/db/db.sqlite`）、
DSH home（`sessions/**/session.v*.jsonl.zstd`）。OpenCode 的位置与格式与三者都不同，
需要新增第四个 source kind `opencode`，与 `zcode` 基本对称（单个 SQLite 只读打开 + 全量扫描映射）。

## 2. 已探明的事实（本机实测）

探针：`.opencode-probe.mjs`（只读）。本机 `C:\Users\Silver\.local\share\opencode\opencode.db`
（主库 12 559 36 字节 + `-wal` 7 399 552 字节 + `-shm`，WAL 模式，运行中只读打开成功）。

### 2.1 表结构与公开文档不符

没有 `session / message / part` 表（v1.2.0 之前的布局），实际是 **`session_v2` + `session_message`**
（本机版本 v2.0.19）。`project`、`event`（空）、`session_pending`（空）、`session_inbox`（空）等表存在但与用量无关。
数据目录下无旧 JSON 树（只有 `log / repos / shell / snapshot`）。

| 表 | 行数 | 用途 |
|---|---|---|
| `session_v2` | 2 | 会话级聚合：`tokens_input/output/reasoning/cache_read/cache_write`、`directory`、`title`、`model` JSON、`agent`、`time_created/updated`（ms epoch） |
| `session_message` | 33 | 事件粒度：`type`（assistant 31 / user 3 / idle 2 / system 1）+ `data` JSON |

`data.tokens = {input, output, reasoning, cache:{read,write}}`，时间 `data.time.completed ?? created`
（ms epoch，已验证），模型 `data.model.id` + `providerID`。`cost` 全 0（免费模型），忽略。

### 2.2 用量粒度：per-assistant-message

事件只从 `type='assistant'` 且含 `data.tokens` 的行产出。`session_v2` 的聚合值与消息求和有微小出入
（input 差约 500，output 差约 50，疑似 compaction / title 生成量），且聚合值没有事件时间戳，
因此 `session_v2` 只提供 `directory`（仓库归属）与 `title`（会话名），**不做事件来源**。

### 2.3 口径陷阱已实锤（与 DSH 一模一样）

某会话 `SUM(cache.read)=2,020,429 >> SUM(input)=193,363`，且 cache 求和与会话聚合**精确相等**。
=> `input` 是未命中输入，与 `cache.read` **并列**，必须重构成看板要求的超集：

```
input     = data.tokens.input + data.tokens.cache.read   // 例：5870 + 3825 = 9695（总输入）
cached    = data.tokens.cache.read                       // 3825（其中命中）
cacheWrite= data.tokens.cache.write                      // 0
output    = data.tokens.output                           // 81
reasoning = data.tokens.reasoning                        // 29（单列，置 mask 位；DSH 置零的做法不适用）
total     = input + output                               // 9776（reasoning 单列，对标 ZCode：100+20=120，reasoning 5 另计）
```

若直接把 `input ← tokens.input`、`cached ← tokens.cache.read`，会同时踩三个坑
（见 §3，与 `docs/dsh-adaptation-plan.md` §3.2 镜像）。

### 2.4 其余映射

| 看板字段 | 来源 |
|---|---|
| `requestInputTokens` | `input + cache.read`（总输入），用于上下文分级 |
| `detailMask` | input \| cached \| output \| reasoning 全置 + cacheWrite 位 |
| `channel` / `source` | 恒为 `OpenCode` / `opencode`（本机 `parent_id/fork` 全空、`agent` 全 `build`，无 subagent 信号，v1 不发明拆分规则） |
| `model` / `modelProvider` | `data.model.id` / `data.model.providerID`；缺省回落 `Unknown model` |
| `cwd` / 仓库归属 | `session_v2.directory`，经 `createRepositoryResolver()` |
| `conversationName` | `session_v2.title`，截断到 120 字符 |
| `serviceTier` | `unknown`（未提供） |
| `priceVersion` | `pricingVersionForTimestamp(timestamp)` |

### 2.5 无限额数据（已确认）

OpenCode 无配额存储 => 与 ZCode、DSH、project-log 同类：只进普通范围统计，
**不进** Codex 5h/week 限额窗口。

## 3. 关键设计约束

`public/usage-fields.js:36` 的 `validateUsageDetails()`、`src/pricing.js:1070-1085` 的分档计价、
缓存命中率（`缓存读取 ÷ 总输入`）都依赖 **`cached <= input`** 不变量。
天真映射（`input ← 5870`、`cached ← 3825`）会同时踩三个坑：

1. `cached > input` → 缓存明细被撤销并置 `USAGE_DETAIL_INCONSISTENT`；
2. 计价退化为「最低费率估算」分支；
3. 缓存命中率显示为 3825 / 5870 ≈ 65%（本例）乃至远超 100%（cache.read >> input 的会话）。

§2.3 的超集重构是唯一正确映射，必须有回归测试锁定（见 §6）。

计价币种：OpenCode 是多 provider，`src/pricing.js:948` 的 `currencyForEvent` 回退保持现状
（非 zcode/dsh 渠道 → USD），**本次不改 pricing.js**。未知模型按 USD 兜底是既有通用行为，
加测试锁定即可（免费模型显示 API 等价估算符合 README 口径，并非账单）。

## 4. 设计

新增第四个 source kind `opencode`，与 `zcode` 基本对称。

新增 **`src/opencode-usage.js`**（预计 250–350 行）：

| 导出 | 作用 |
|---|---|
| `opencodeDatabaseFiles(dataDir)` | glob `opencode*.db`（覆盖默认库与 `opencode-<channel>.db` 变体） |
| `opencodeHomeLooksUsable(homePath)` | 数据目录下存在可用数据库 |
| `opencodeSourceStat(dbFile)` | `{ size, mtimeMs }`，**必须含 `-wal`**（本机 7.4MB 不可忽略），抄 `zcodeSourceStat` |
| `streamOpencodeDbEvents(dbFile, source, onEvent, options)` | 只读打开（WAL 恢复失败回退，抄 `zcode-usage.js:56-63`）→ `session_message WHERE type='assistant' ORDER BY time_created, seq` 流式 `iterate` → 归一化事件 |
| `parseOpencodeDb(dbFile, source, options)` | 供 report 路径，返回 `{ sessions, events }` |

实现要点：

1. 列名显式枚举，禁止 `SELECT *`；禁止 `.all()` 全量加载（主库 12MB + WAL 7MB 且持续增长）。
2. 时间戳取 `data.time.completed ?? data.time.created ?? 行 time_created`；非法时间戳跳过（与既有容错口径一致）。
3. 只读 `data.tokens`、`data.model`、`data.time` 与 `session_v2` 的 `directory/title`。
   **绝不读取、绝不落地** `content`、`reasoningEncryptedContent`、`snapshot`、`providerState` 等正文字段。
4. 全程只读，不写入、不修改数据目录。

发现候选（Windows 优先，本机实测为 XDG 风格路径）：`~/.local/share/opencode`、
`%APPDATA%/opencode`、`%LOCALAPPDATA%/opencode`、`~/Library/Application Support/opencode`，
环境变量 `CODEX_USAGE_OPENCODE_HOMES` 追加、`CODEX_USAGE_OPENCODE=0` 关闭（沿用本项目惯例，
不用 `OPENCODE_DB` 语义）。

## 5. 改动清单（按依赖顺序）

### A. 数据源模块

1. 新增 `src/opencode-usage.js`（见 §4）。

### B. `src/usage-core.js`（~7 处，抄 DSH 接线）

2. `classifyImportDirectory()` 加 `opencode-home` 分支；`unsupported` 的 reason 文案补上 OpenCode。
   注意 DSH 修过的优先级坑（`usage-core.js:296`）：OpenCode 判据必须在 Codex 之前。
3. 新增 `export async function discoverOpencodeHomes(options)`，对称于 `discoverZcodeHomes`。
4. `discoverUsageSources()` 并入 OpenCode，并在 import-dir 循环里加 `opencode-home` 分支。
5. `buildUsageFingerprint()` 加 OpenCode 单文件分支（stat 含 wal）。
6. `streamUsageFileEvents()` 加 `source.kind === "opencode"` 分派。
7. `buildUsageReport()` 加 OpenCode 分支。

### C. `src/usage-store.js`（3 处）+ `src/server.js`（1 处）

8. `usageFiles()` 加 OpenCode 单文件分支（`zcodeSourceStat` 对称）。
9. `STORE_SCHEMA_VERSION` 9 → 10 并加 `version === 9` 迁移。**本次不改表结构**，只抬版本号；
   注意 DSH 修过的"常量当参数"坑：旧迁移落点用字面量，新迁移用常量。
10. `metadata()` 的 `harnessModels` 由 `{Codex, ZCode, DSH}` 扩为四元，分桶判据改按 channel 前缀。
    `nonCodexHomeIds()` 的 SQL 是白名单，`opencode` 自动被排除，**无需改**。
11. `server.js:187` `describeImportEntry()` 加 `opencode-home` 标签分支（`OpenCode <basename>`）。
12. 审计 `service-tier-evidence.js:56` 的来源过滤（DSH 是否漏加），一并处理。

### D. 前端 `public/`（3 处；DSH M2-1 已抽象化，比 DSH 当时容易）

13. `public/app.js:2589` `HARNESS_ORDER` 加 `"OpenCode"`，`bucketForChannel` 加 `opencode` 前缀分支。
    `claimHarnessKeys` / `pricingHarnessGroups` 自动生效；顺手验证"同一模型多 harness 去重"对 OpenCode 的表现。
14. `public/timeline-utils.js:177` `NON_CODEX_SOURCE_KINDS` 加 `"opencode"` —— 否则选中 OpenCode 来源会错误点亮 Codex 限额按钮。
15. `public/i18n.js` 新增文案（中英各一份）：空状态、导入提示、`INVALID_IMPORT_DIRECTORY`。

### E. 文档（3 处）

16. `README.md` / `README.en.md` 数据来源章节补 OpenCode（数据目录候选、只读、`CODEX_USAGE_OPENCODE_HOMES` / `CODEX_USAGE_OPENCODE`）；限额按钮保持"只统计 Codex 来源"的说明。
17. `docs/` 补 `opencode-data-source.md`（表结构、并列→超集推导过程用真数、隐私口径、v2 vs legacy 说明）。
18. `docs/README.md` 加本文与数据源说明的链接。

## 6. 测试

新增 `test/opencode-usage.test.js`，对照 `test/zcode-usage.test.js` 的结构。
fixture 在 tmp 现场建最小 `session_v2` / `session_message` 库，**不需要二进制夹具入库**。

**必须覆盖的语义测试（最关键）**：

1. **超集映射**：用 §2.3 的真实数字（5870 / 81 / 29 / 3825 / 0）构造 fixture，断言
   `input === 9695`、`cached === 3825`、`total === 9776`、`reconciliationGap === 0`、
   `detailMask` 含全部明细位。**这条直接锁定 §3 的三个坑，防止回归。**
2. **天真映射回归**：`input ← tokens.input` 会触发缓存明细撤销与不一致标记（与 DSH 测试镜像）。
3. **粒度**：多 assistant 行 → N 事件；`session_v2` 聚合值不做事件；`user/idle/system` 不产出事件；
   缺 `data.tokens` 的行跳过。
4. **计价**：正常分档（非"最低费率估算"分支）；未知模型按 USD 兜底（锁定 §3 决策）。

其余覆盖：

- 自动发现数据目录；`CODEX_USAGE_OPENCODE=0` 关闭；`CODEX_USAGE_OPENCODE_HOMES` 追加；
  `classifyImportDirectory` 识别 `opencode-home` 且判据顺序正确（DSH 优先级坑的镜像断言）。
- 模型/provider/cwd/title 映射与缺省回落；title 截断 120 字符。
- 容错：空库、坏 `data` JSON、非法时间戳、缺表（仅记警告，不影响其他来源）。
- 隐私回归：fixture 里的正文哨兵字符串**不出现在任何产出事件中**。
- `opencodeSourceStat` 把 `-wal` 计入增量检测（与 `zcodeSourceStat` 测试镜像）。

更新受影响的既有断言：`test/three-path-parity.test.js`（加 OpenCode 四路一致断言，fixture 须含
cache.read > input 的行，并断言限额排除）、`test/usage-store.test.js`（metadata 四元）、
`test/app-render.test.js`（harness 归组）、`test/recent-selections.test.js`（来源判定）、
`test/server.test.js`（OpenCode home 导入）、`test/i18n.test.js`（新文案）。

收尾门禁：`node --test`、`npx tsc -p tsconfig.checkjs.json`、
`npx biome check --formatter-enabled=false .`、`npx biome format .`、`node src/static-export.js`。
（Windows 注意：`npm.ps1` 被执行策略禁止，请用 `npm.cmd` / `npx.cmd`。）

## 7. 明确不做（一期范围外）

- **legacy `message/part` 表与旧 JSON 树兼容**：本机已是 v2 布局；除非实施中发现用户群仍大量停留旧版。
- **`OPENCODE_DB` 单文件覆盖语义**：用本项目 `CODEX_USAGE_*` 惯例代替。
- **OpenCode 限额窗口**：无配额数据，不伪造。
- **不读正文**：`content` / `reasoningEncryptedContent` / `snapshot` / 工具参数与结果一律不读（§4 隐私口径）。
- **不用 `session_v2` 聚合值做事件**：无时间戳且与消息求和有微小出入（§2.2）。
- **不改 Codex / ZCode / DSH 既有解析路径**。

## 8. 实施顺序与验证点

| 阶段 | 内容 | 验证 |
|---|---|---|
| Gate 1 | §2 剩余微问题（tokens 缺失行占比）+ legacy 是否兼容的二选一 | 探针输出贴入 `docs/opencode-data-source.md` |
| P1 | `src/opencode-usage.js` + `test/opencode-usage.test.js` | §6 的四个语义测试通过 |
| P2 | `usage-core.js` 接线 | 单测 + `node src/cli.js summary` 出现 OpenCode 来源 |
| P3 | `usage-store.js` + `server.js` + service-tier 审计 | `usage-store` / `server` 单测 |
| P4 | `public/` + i18n | 来源列表出现 OpenCode、**限额按钮不被 OpenCode 点亮**、缓存命中率 ≤100% |
| P5 | 四路一致 + 文档 | parity 通过；`export` 后静态快照含 OpenCode 且可切换语言；删除 `.opencode-probe.mjs` |

真库对照（P5 验收核心）：`summary` 的 OpenCode totals 与独立 SQL
（per session `SUM(input+cache.read)`）逐位一致；`/api/usage` 含 `Main OpenCode [opencode] active`。

## 9. 风险与回退

| 风险 | 应对 |
|---|---|
| schema 无文档且有过一次大迁移（JSON 树 → 单库 → v2 表） | 未知表/列只记警告跳过；`session_message` 缺失时整个来源跳过，不影响其他来源 |
| 活库 WAL 恢复问题（agent-walker 记录过只读打不开的个例） | 抄 ZCode 的只读→普通打开回退；打不开则记警告跳过，不碰原库 |
| 首扫性能（12MB + 7MB WAL，持续增长） | 流式 `iterate` + 整库 `size+mtime` 指纹，沿用 `replaceFile` 整库重解析策略 |
| `session_v2` 聚合与消息求和的微小出入 | 只用消息做事件；parity 测试用 fixture 而非真库，避免把 trôi 值写死 |
| 工作区混有 DSH / 定价自动更新等未提交改动 | 本计划只新增文件 + 小 hunk；`src/server.js`、`public/app.js` 等混合文件用 `git add -p` 挑 hunk（见 `docs/dsh-change-summary.md` §22） |
| 隐私 | 只读用量与元数据，正文字段不读不落地；§6 有哨兵回归测试 |

## 10. 难度评估

**4 / 10**，**一次全绿约 75–80%，一轮修复内收敛约 95%**。DSH 是 5/10 且当时要新建
harness 抽象（`HARNESS_ORDER` / `bucketForChannel` / `claimHarnessKeys`）；现在抽象现成，
OpenCode 只是第四个桶。设计风险已在 Gate 0 归零，剩下的是约 15 处改动点的机械同步
（漏 `timeline-utils` 排除列表或 `HARNESS_ORDER` 即静默错）与既有测试的四元期望连锁。
建议 M1（P1–P3，后端可 `summary` 实测）与 M2（P4–P5）分两步投放。

---

## 11. 独立复审意见（复审模型：MiMo-v2.6-Flash，非原计划作者）

> 本节由复审模型 MiMo-v2.6-Flash 独立追加，**不是原计划作者（muse-spark-1.3）的意见**。
> 原计划正文 §1–§10 保持原作者定稿不动；复审发现的错误只在本节列出，
> **实施时以本节的修正为准**。复审方式：逐条对照 `public/usage-fields.js`、`src/pricing.js`
> 源码与本机真库数据，§1–§10 的其余结论经复核成立。

### 11.1 P0 — §2.3 的 reasoning 口径错误（必须先修再进 P1）

原计划 §2.3 写 `output ← tokens.output`、`reasoning 单列另计`。复审核验认为该映射有实质错误，
依据如下：

1. `public/usage-fields.js:43`：**`reasoning > output` 会撤销 reasoning 明细并置 INCONSISTENT** ——
   看板的硬不变量不止 `cached <= input` 一条，还有一条 `reasoning <= output`（子集关系）。
2. `public/usage-fields.js:40`：`total !== input + output` 同样置 INCONSISTENT。
3. `src/pricing.js` 全文中 `reasoning` 只出现在两个模型名（`grok-4.20-*`）里 ——
   **计价从不单独给 reasoning 收费**，reasoning 必须包含在 `output` 内才会计价。
4. **真库已有反例**：本机第一行 assistant 消息即 `output=45, reasoning=420`。
   按原映射执行，这条会踩 `reasoning > output` → inconsistent，且 420 个 reasoning token
   完全不计价。原计划 §2.3 选的样例（`81 > 29`）恰好能过校验，把 bug 藏住了 ——
   DSH 计划是样例数字救了它，本计划是样例数字害了它。
5. 交叉印证：agent-walker（第三方 opencode 消费统计工具）独立得出同样结论 ——
   它把 reasoning 折叠进 output 以对齐其他 provider 的 inclusive 口径。

**修正映射（折叠法）**：

```
input     = data.tokens.input + data.tokens.cache.read    // 9695（超集，同原计划，无误）
cached    = data.tokens.cache.read                        // 3825
output    = data.tokens.output + data.tokens.reasoning    // 81 + 29 = 110（折叠；原计划 81，错误）
reasoning = data.tokens.reasoning                         // 29（output 的子集）
cacheWrite= data.tokens.cache.write                       // 0
total     = input + output                                // 9695 + 110 = 9805（原计划 9776，错误）
```

折叠后 `reasoning <= output` 恒真（与 Codex/ZCode 口径一致：reasoning 是 output 的细分，
不另计入 total —— ZCode 的 `total = 100 + 20 = 120`、reasoning 5 另置 mask 位而不进 total
正说明这一点，原计划 §2.3 "reasoning 5 另计" 的注释应按此理解）。

**连带修正**（均以本节为准）：

- §6.1 测试数字：`output === 110`（非 81）、`total === 9805`（非 9776）；
- §6.2 回归测试新增 reasoning 版：`output ← tokens.output` 单独取值会触发
  reasoning 明细撤销与不一致标记（与 DSH 的 cached 版镜像）；
- Gate 1 补一条探针统计：`tokens.output < tokens.reasoning` 的行数（预期 > 0，已实锤 1 条）。

### 11.2 非阻塞修正

1. **三路/四路术语打架**：标题与 §1 写"三路一致"，§6/§8 写"四路一致"。
   parity 测试就是内存 / SQLite / 静态导出**三路**（DSH 的"独立手写实现"只是一次性人工验证，
   不在测试里）。**统一改为"三路"。**
2. **§9 错误引用**："`docs/dsh-change-summary.md` §22" 不存在，应指向该文档的
   「⚠️ 提交前必读：工作区里混有非本次改动」小节。
3. **两处笔误**：§2 "12 559 36 字节" 应为 **12,455,936**；§9 "避免把 **trôi** 值写死"
   混入越南语词，应为"易变值"。
4. **§2.2 聚合出入没说全**：除 input 差约 500、output 差约 50 外，**reasoning 也差 845**
   （消息求和 2,905 vs 会话聚合 3,750），一并写入。
5. **§5 item 12 可从"审计"改成"确认"**：`service-tier-evidence.js:56` 对非 Codex 来源是
   fail-open（拼 `logs_2.sqlite` 找不到即返回空行），DSH 漏加 `kind` 排除实测无害；
   OpenCode 同理无害，顺手补 `kind` 排除属可选清理，**不应占用 P3 注意力**。
6. **§4 补两条设计细节**（复审新增，原计划未覆盖）：
   - `session_v2` 与消息是 **LEFT JOIN** 关系：某会话只有消息没有聚合行（或反向）时，
     `directory/title` 缺失的回退为 `cwd="" → repositoryResolver` 走 unknown、title 留空。
     别留给实现时临场决定。
   - **v1 只收目录、不收 `.db` 文件路径导入**（与 ZCode 一致），在此明写为既定决策。

### 11.3 对 §10 难度评估的补充

难度 4/10 与一次通过率评估**不变**。但应在 §10 追加一句提醒：

> 本次口径验证必须**逐条覆盖 reasoning 行** —— DSH 因为没有 reasoning 字段而逃过
> `reasoning <= output` 这一课，OpenCode 是第一个同时带 reasoning 与 cache 并列陷阱的来源。
> 11.1 的 P0 若不在 P1 前修入，第一版解析器拿真实库一跑就是满屏 inconsistent，
> 并复现 DSH 那种"计价悄悄退化为最低费率"的隐性错。

---

## 12. 二次复审（复审模型：space-bunny，非前两任作者）

> 本节由复审模型 **space-bunny** 在 §11（MiMo-v2.6-Flash 复审）之后追加，**不是原计划作者
> （muse-spark-1.3）也不是 §11 复审的意见**。§1–§11 全部保持原样不动。
> 本节结论均以**本机真库重新实测** + **源码逐行核对**得出，实施时与 §11 冲突处以本节为准。
> 复审基线：`node --test` 245 pass / 0 fail；真库 `opencode.db` 12,455,936 B + `-wal` 7,399,552 B。
> 探针脚本为一次性只读命令，未入库。

### 12.1 P0 复核：§11.1 成立，且**危害被低估了一级**

§11.1 的结论正确，本节用真库重新确认并补上它漏掉的传导链。

**实测证据**：46 条带 `tokens` 的 assistant 行中，**9 行 `reasoning > output`**（不是个例）：

| 模型 | 行数 | `reasoning > output` |
|---|---|---|
| `muse-spark-1.3-contributor-free` | 35 | 4 |
| `space-bunny-free` | 6 | 3 |
| `mimo-v2.6-flash-free` | 5 | 2 |

跨三个模型系统性出现；`session_v2.model` 带 `variant: "xhigh"`（重度思考 + 短回答），
与"reasoning 与 output 不相交的拆分口径"吻合。真库反例：`out=45, rea=420`。

**§11.1 未说到的关键一环 —— 危害不止是显示标记**。`src/pricing.js` 的完整传导：

```
public/usage-fields.js:43-46   reasoning > output → 撤 reasoning 明细位 + 置 INCONSISTENT
public/usage-fields.js:47-49   gap > 0            → 补置 USAGE_DETAIL_INCONSISTENT
src/pricing.js:1059-1063       countsInconsistent = usage.inconsistent || …
src/pricing.js:1064-1066       if (countsInconsistent) { addMinimum(total, allCategories) }
```

即：踩中该不变量 ⇒ 该事件的 `inconsistent` 置位 ⇒ **整条事件的
input + cached + cacheWrite + output 全部退化为"最低费率估算"分支**，
而不只是 reasoning 那一部分计价丢失。原计划 §2.3 的映射会让约 **20% 的事件整条塌进最低费率分支**。

叠加 `src/pricing.js:1094` `if (usage.outputKnown) addCost(usage.output, "output")` ——
**计价全文只对 `usage.output` 收费，`reasoning` 从不参与计价**。真库
`sumOutput = 19061`、`sumReasoning = 15460`，即 **15460 个 token（占输出量 45%）会完全不计价**。

**结论不变**：§11.1 的折叠映射（`output ← tokens.output + tokens.reasoning`）是唯一正确解。
连带修正（§6.1 `output === 110` / `total === 9805`）继续有效。

### 12.2 P0-连带：§6.1 主 fixture 结构上抓不住 §11.1 的 P0 ⚠️

§11.1 要求把 §6.1 的断言改成 `output === 110`，但**沿用的仍是 §2.3 那组
`5870 / 81 / 29 / 3825` —— 其中 `reasoning(29) < output(81)`**。
该 fixture 在任何实现下都过不了不一致分支，**它永远不会红**。

真正能红的是真库那组 `out=45, rea=420`。

**修正（覆盖 §6.1）**：

1. **主语义测试的 fixture 换成病态样本**（`output=45`、`reasoning=420`、`input=9648`、
   `cache.read=0`），断言 `output === 465`、`reasoning === 420`、`total === 10113`、
   `reconciliationGap === 0`、**`detailMask` 不含 `USAGE_DETAIL_INCONSISTENT`**、
   且计价落在正常分档分支（断言不含 `usage-detail-inconsistent-minimum-scenario` reason）。
   理由：主测试应当就是那个会当场炸的测试，而不是一个恒绿的装饰。
2. 另配一组正常样本（`output >= reasoning`）单独锁 §2.3 的 5870/81/29/3825 数字。

这样 §6.1 与 §6.2 合并成"两个 fixture × 同一组断言"，覆盖面比原计划更宽，且不新增测试文件。

### 12.3 §2.1 的 type 普查**已经过期** —— schema 漂移正在发生

§2.1 记录 `assistant 31 / user 3 / idle 2 / system 1`。真库现状：

```
assistant 53 / idle 6 / model-switched 1 / system 1 / user 7   = 68 行
```

**Gate 0 之后新增了 `model-switched` 类型**，且无 `tokens`。消息分类法不稳定已被实证。

**修正**：

1. §2.1 的普查表须标注"快照，非契约"，`docs/opencode-data-source.md` 同样口径。
2. 事件白名单放在 **SQL 层**（`WHERE type='assistant'`）而非应用层枚举 —— 计划 §4 已是此写法，**正确，保持**。新类型自动被排除，不需改代码。
3. **P1 增加一道能力探测**：进入解析前先 `PRAGMA table_info(session_message)` 校验
   `id / session_id / type / seq / time_created / data` 存在，缺列则整来源跳过并记警告。
   理由：OpenCode 已在数小时内经历两次 schema 变更（JSON 树 → 单库 → v2 表 → 新消息类型），
   只靠 try/catch 兜底不足以在快速迁移期给出可诊断的失败信息。§9 风险表"未知表/列只记警告跳过"由此从被动兜底升级为主动校验。

### 12.4 §2.2 的聚合"微小出入"不是漂移，是**每会话固定多出一次调用**

§11.2.4 只补了 reasoning 的差值数字，未给出成因。真结构是差值**与会话规模无关、恒定**：

| 会话 | 消息数 | Δinput | Δoutput | Δreasoning |
|---|---|---|---|---|
| `ses_f145d99e…` | 1 | +520 | +44 | +755 |
| `ses_f13a4e63…` | 39 | +557 | +49 | +845 |
| `ses_f0f9b2ac…` | 8 | +548 | +13 | +0 |

每会话恒定多出 ~500 input / 少量 output / 不定 reasoning ⇒ **一次未被计入 assistant 行的
模型调用（推断为标题生成）**。

**影响与修正**：

1. 该 gap **永不收敛**。§2.2 与 `docs/opencode-data-source.md` 必须写死这一点，
   否则日后必然有人提"总量为何差 3%"。
2. 这**反向强化**了 §7"不用 `session_v2` 聚合值做事件"的决定 —— 若改用聚合值，
   会凭空多计每会话一次标题调用的量，且该量无时间戳、无法归因到具体事件。
3. §11.2.6 的 LEFT JOIN 回退提醒属实（`session_v2` 存在 `parent_id` / `fork_session_id`），
   建议直接仿 `src/zcode-usage.js:107-117` 的 `sessionDirectory()` 递归回退，
   而不是留空 `directory`。

### 12.5 §4.3 的隐私措辞在字面上不成立，须改为"不提取/不落地"

`data` 是单列 JSON TEXT，实测 key：`time, agent, model, content, finish, providerState,
cost, tokens, snapshot, rawFinish`。要取到 `.tokens` 就**必须 `JSON.parse` 整条**，
正文字段一定会进内存。故 §4 要点 3 与 §9 隐私行的"**绝不读取**"是假的。

**修正措辞**（§4 要点 3 / §9 / `docs/opencode-data-source.md` 三处同步）：

> `data` 整列不可避免地被读入并 parse，但**仅提取 `tokens` / `model` / `time` 白名单字段**；
> `content` / `snapshot` / `providerState` / `reasoningEncryptedContent` 等正文字段
> **不进入任何产出事件、SQLite、日志与静态导出**。

§6 的正文哨兵回归测试**照原样保留且继续有效**（它验证的是"不落地"，本来就是真正的目标）；
只是文档不要过度承诺一个做不到的"不读取"。

**附：内存是安全的。** 实测 `data` 平均 10,479 B / 最大 95,451 B。§4 的流式 `iterate()` +
禁 `.all()` 的设计成立，无内存风险。

### 12.6 §4 缺 `eventId` 构造规则（补齐）

§4 列了 5 个导出但**从未规定 `eventId` 怎么拼**。`session_message` 有 `id`（`msg_*`），
但增量走 `replaceFile` 整库重解析，建议直接钉死：

```
eventId = `${session_id}:${seq}`     // 跨 WAL checkpoint 稳定
```

配套索引现成（`session_message_session_type_seq_idx`）。**须补一条测试锁定**，
否则 `usage-store` 的事件去重行为无回归保护。

### 12.7 附注：`contextLevel` 会看起来像坏了（无需改代码，需写文档）

真库 `SUM(cache.read) = 3,314,674` vs `SUM(input) = 391,899` —— **缓存命中是未命中输入的 8.5 倍**。
按 §2.4 的 `requestInputTokens = input + cache.read`，OpenCode 几乎**每条事件**都会判为
`long` 上下文。

口径本身没错（总输入确实这么大），但看板上 OpenCode 的长上下文占比会接近 100%，
用户大概率会当 bug 报。**§17 的 README / `opencode-data-source.md` 需各写一句**说明这是
口径使然而非异常，并顺手核对 `LONG_CONTEXT_INPUT_THRESHOLD` 取值。

### 12.8 前置风险的现实化修正（覆盖 §11.3）

§11.3 那句提醒成立，本节补两点：

1. DSH 至少是**整条事件**退化；OpenCode 会让**每个 provider 的每种模型**都踩到 ——
   折叠法漏一处就是全线不一致。
2. **前向风险**：`tokens.output` 的"不含 reasoning"是**当前 provider 群的经验口径**。
   若未来某个 provider 改为已含 reasoning 的上报，折叠会重复计数。
   **缓解**：在解析处写明该口径的来源（真库 9/46 行实证 + agent-walker 交叉印证），
   并在来源统计里附带 `reasoning > output` 的行数 —— 口径一旦漂移，这个计数会立刻可见，
   而不是等到账单对不上才发现。

### 12.9 本节对 §1–§11 的净修正清单

| # | 位置 | 修正 | 级别 |
|---|---|---|---|
| 1 | §6.1 | 主 fixture 换成病态样本 `45/420`（见 §12.2） | **P1 前必做** |
| 2 | §4 要点 3 / §9 | 隐私措辞"绝不读取" → "不提取/不落地"（见 §12.5） | 文档 |
| 3 | §2.1 | type 普查标注"快照非契约"（见 §12.3） | 文档 |
| 4 | §2.2 | 聚合 gap 写入成因 + "永不收敛"（见 §12.4） | 文档 |
| 5 | §4 | 补 `eventId = session_id:seq` 规则（见 §12.6） | **P1** |
| 6 | §5 A | P1 加 `PRAGMA table_info` 能力探测（见 §12.3） | **P1** |
| 7 | §11.2.6 | `sessionDirectory` 递归回退照 `zcode-usage.js:107-117` 抄 | P1 |
| 8 | §17 | README 补 `contextLevel` 口径说明（见 §12.7） | 文档 |
| 9 | §11.3 | 补前向漂移监控建议（见 §12.8） | 可选 |

**§11.1 的折叠映射本节复核成立，原样保留。** §5 B–E、§6 其余覆盖、§7 范围、
§8 阶段划分、§9 风险表、§10 难度 **4/10** 评估本节均无异议，**不因本节改动**。

净效果：改动仍是"只加文件 + 小 hunk"，但 **§12.2 / §12.6 / §12.3-#6 三项须在 P1 落地前定稿**，
其余为文档口径修正，可与 P4/P5 一并处理。

---

## 13. 三次复审（复审：本会话 agent，独立于原计划作者与 §11、§12 复审作者）

> 本节由本会话 agent 独立追加，**不是原计划作者（muse-spark-1.3），也不是 §11（MiMo-v2.6-Flash）
> 或 §12（space-bunny）的意见**。§1–§12 全文冻结不动；本节只记录本次用真库现况 + 源码逐行
> 重验的结果，与 §11、§12 冲突处以本节为准（冲突仅两处：§13.1、§13.2）。
> 复审基线：`node --test` 245 pass / 0 fail（复测通过，2.85s）；真库现况主库 13,840,384 B +
> `-wal` 8,289,472 B（活库，Gate 0 之后又涨了 1.4M/0.9M）；`LONG_CONTEXT_INPUT_THRESHOLD = 272_000`
>（`src/pricing.js:7`，已核对）。
> §5/§6/§11/§12 引用的行号本次全部抽查复核（usage-fields 36/40/43/47-49、pricing 948/1059-1066/
> 1072-1086/1094、usage-core 293-298、server 178-199、store 560/678/705、app 2589、
> timeline-utils 175-177、zcode 56-63/107-117、pricing 全文 `reasoning` 仅 2 处模型名、
> `usage-detail-inconsistent-minimum-scenario` 字符串存在）——**引用无误**。

### 13.1 §12.7 被证伪：没有"接近 100% long"，实际是 0%（覆盖 §12.9 清单第 8 项）

§12.7 预测"OpenCode 几乎每条事件都会判为 long 上下文"。实测：106 条带 tokens 的 assistant 事件中，
`(input + cache.read) > 272_000` 的是 **0 条**。

错因：§12.7 把"聚合 8.5x"直接外推到了单事件粒度，但缓存命中是摊在几十条事件上的
（ses_f13a… 44 条事件摊 3.5M，单条均值约 93k）。**聚合比率 ≠ 事件分布**，这是 §12.7 推理链的断裂点。

后果与修正：

- §12.9 清单第 8 项（README / 数据源文档补 `contextLevel` 口径说明）**撤销** ——
  为一个不存在的现象写文档反而制造 confusion，用户读到"接近 100% long"的说明对照看板一看是 0%，
  信任损失比不写更大。
- 替代动作（P1 测试）：加一条"高缓存事件仍判 short"的锁定断言（用 5870/3825 那组数字，
  `requestInputTokens = 9695 < 272_000 → short`），防止将来有人把这个"异常"当 bug"修掉"。
- §12.7 中"口径本身没错"一句保留 —— `requestInputTokens = input + cache.read` 不用改，不改代码。

### 13.2 §12.4 的"恒定"被证伪：gap 量级不恒定，"精确相等"也不再成立

4 会话现况（消息求和 vs `session_v2` 聚合）：

| 会话 | 事件数 | Δinput | Δoutput | Δreasoning | Δcache |
|---|---|---|---|---|---|
| ses_f145… | 1 | +520 | +44 | +755 | 0 |
| ses_f13a… | 44 | +557 | +49 | +845 | 0 |
| ses_f0f9…（新） | 26 | +548 | +13 | 0 | 0 |
| ses_f0f9…34（新） | 35 | **+58** | +9 | +39 | **+512** |

- "每会话恒定多出 ~500 input"**不成立**（58–557）；§2.3 的"cache 求和精确相等"也不再成立（+512）。
- 成立并保留的部分：**gap 永不为零**（4/4 会话全有）→ "永不收敛"结论成立；
  "不用聚合值做事件"的决定被强化（聚合侧 4 个维度全漂）。
- "一次标题生成调用"的因果解释**降级为假说**：量级随模型/上下文变化（且 4 会话分属 3 个模型、
  2 个 provider），文档措辞改为"疑似未落 assistant 行的模型调用（如标题生成）"，不要写死成因。

### 13.3 §12.1/§12.3 的数字已过期，但结论全部被加强

活库漂移实证（§12 快照 → 本次）：assistant 行 53→107（含 tokens 46→106）、
`reasoning > output` 行 9→**26（占 25%）**、模型 3→4（新增 `longcat-2.5-preview-free`）、
`model-switched` 1→2、session 级版本新增 2.0.20。

- §11.1 折叠映射**复核成立**，且更紧迫：`SUM(reasoning) = 141,575` ≈ `SUM(output) = 36,098`
  的 **3.9x**（§12.1 写 45% 还是保守了）。不折叠 = 14 万 token 零计价 + 25% 事件整条塌进最低费率。
- 文档卫生要求：§2、§12 的一切探针数字都是**快照**，本次起统一视为"截至复审时"，
  后续复审只更新结论、不再逐数勘误（否则每几小时过期一次）。§12 的表保留作历史，不删。
- 新增 provider 取值 `opencode-go`（原只有 `opencode`）：映射禁止硬编码 providerID，
  计划 §2.4 本就通用，加此备注即可。`model.variant` 可缺（space-bunny 的 model JSON 无该键），
  同理容忍缺失。

### 13.4 §12.6 配套主张验证通过，补两处限定

- `session_message_session_type_seq_idx` 存在 ✓；`(session_id, seq)` 无重复 ✓；
  `PRAGMA table_info` 七列与计划一致 ✓ —— PRAGMA 能力探测（§12.9-#6）可行，维持。
- 限定 1：该二元组**无 DB 级 UNIQUE 约束**（仅主键 autoindex + 普通索引），唯一性是观测性质。
  适配器不得假设它；`eventId = session_id:seq` 规则维持，测试只锁 fixture 行为（计划已是此写法）。
- 限定 2：Gate 1 微问题现可关闭两项 —— 无 tokens 的 assistant 行占比 **1/107 ≈ 1%**，
  其形状已探明（keys = `time/agent/model/content/snapshot`，无 `tokens/finish/cost`，疑似中断消息），
  fixture 照此形状构造；非 assistant 行带 tokens 的 Long 查询结果为 **空**，
  `WHERE type='assistant'` 充分，无需应用层二次过滤。

### 13.5 §12.4.3 的递归回退建议降级（无真实用例，不可覆盖）

`session_v2.parent_id / fork_session_id` 非空数为 **0**（4 会话全空），`agent` 全 `build`。
zcode 式 parent 链递归在 opencode 真库中**没有任何可覆盖的分支**。

修正：LEFT JOIN miss 一律回退 unknown（§11.2.6 前半句保留），递归后半句删除。
理由：不可覆盖的分支违反本项目的测试纪律 —— 参考 DSH 计划，坏帧判据都要有测试锁定，
一个永远走不到的递归没有资格进 P1。

### 13.6 对 §12.9 净修正清单的净修正

| # | §12.9 原项 | 本节裁决 |
|---|---|---|
| 1 | §6.1 主 fixture 换病态样本 | 维持；§12.2 算术复核通过（9695 / 465 / 10113，`420 ≤ 465` ✓）；追加要求两组 fixture 跑同一组断言，且主 fixture 建议含 `cache.read > 0` 的病态行（现主样本 `cr=0` 只覆盖了一半陷阱） |
| 2 | 隐私措辞修正 | 维持（本次核对 `data` 十个 key 与 §12.5 一致，`JSON.parse` 整列不可避免） |
| 3 | type 快照标注 | 维持，且本次 drift（53→107、新类型计数变化、新版本 2.0.20）就是 Put up or shut up 的证据 |
| 4 | gap 成因写入 | 按 §13.2 改写（量级不恒定 + 成因降级为假说），"永不收敛"保留 |
| 5 | eventId 规则 | 维持（索引与无重复均验证通过，补 §13.4 限定 1） |
| 6 | PRAGMA 探测 | 维持（列清单验证通过） |
| 7 | sessionDirectory 递归 | **删除**，见 §13.5 |
| 8 | README contextLevel 说明 | **撤销**，见 §13.1；改为"高缓存判 short"锁定断言 |
| 9 | 前向漂移监控 | 维持 |

**§11.1 折叠映射、§5 B–E 接线清单、§6 其余覆盖、§7 范围、§8 阶段划分、§9 风险表、
§10 难度 4/10 评估，本节均无异议。** P1 前必做项更新为：§12.2 fixture（含 §13.6-#1 追加）、
§12.6 eventId + PRAGMA 探测、§13.1 的 short 锁定断言；其余为文档口径修正，可与 P4/P5 一并处理。
