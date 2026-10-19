# Qoder 数据源接入 —— 难度评估与计划大纲

> **历史归档 · 2026-10-03**。本稿被后续交付或融合计划替代；旧状态、待办与离线要求仅供追溯。现行规则与遗留事项见[文档入口](../../../00-index.md)和[任务清单](../../../02-tasks.md)，归档原因见[本批索引](../00-index.md)。

状态：**已终止（2026-10-02，用户决定）**。本机 Qoder 不提供 token 明细，接入收益不足，本专项不进入施工；本页仅作可行性判断与探测记录保留，**不是待办**。若将来某个 Qoder 版本或产品形态（国际版／IDE 版）写入真实 usage，可据 §5 重新判定难度。

探测基线：2026-10-02 本机只读扫描 `~/.qoder-cn`（`product=qodercn`，CLI `version=1.1.64`，app `0.4.3`）。数量为当日快照，不代表未来版本。

## 1. 结论先行

- **机械接线部分不难**：OpenCode 是最新一例（索引 v10），适配契约、三路一致测试和接线清单都已成型。照抄一遍约 19 个登记点、10 个文件，一到两天能连完。
- **真正的难度在数据本身**：本机 Qoder 把 token 四字段写成 **0**，唯一可信的量化信号是厂商计费单位 `credits`。看板的整个事件契约、计价引擎和一半以上的 UI 列都以 token 为前提，所以这不是"字段映射难"，而是**口径冲突**。
- 因此推荐顺序是：**先做可行性判定（P0）→ 由你拍板口径（P1）→ 才谈接线**。跳过 P1 直接接线的结果是静默产出 0 条事件（见 §3），比不接更糟。

## 2. 探测证据（全部只读，未改动上游）

### 存储布局

| 项目 | 位置 |
|---|---|
| home | `~/.qoder-cn`（`installation_id`、`.auth`、`logs`、`projects`、`tasks`、`file-history`、`.models`） |
| 会话 transcript | `projects/<cwd-slug>/<sessionId>.jsonl`（Anthropic 风格记录：`user` / `assistant` / `attachment` / `active-leaf` / `runtime-config` / `last-prompt` / `file-history-snapshot`） |
| 子代理 | `<sessionId>/subagents/agent-<name>-<hash>.jsonl`（独立文件，带 `agentId`、`parent_tool_use_id`、`isSidechain`） |
| 遥测日志 | `logs/sessions/<cwd-slug>/<sessionId>/segments/<时间戳>.jsonl`（`model.request.started` / `model.response.completed` / `turn.finished`） |
| 会话状态 | `<sessionId>/state.json`（字段名为单字母、内容混淆，未见用量聚合） |
| 数据库 | **无 SQLite**（`*.db` / `*.sqlite*` 命中 0） |

### 用量字段实测

- 11 个 transcript、1566 条记录、688 条 `assistant`，其中 234 条带 `message.usage`（261 条含 usage 记录）；token 四字段 **全部为 0**。
- 遥测日志 9791 条里，`input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens` **非零计数为 0**。
- 非零信号：`credits`（261 条，合计 ≈ 56.05，单条区间 0.0466–2.2780）、`original_credits`（当前与 `credits` 相等）、`context_usage_ratio`、`billable:false`、`service_tier:"standard"`、`request_id`。
- `usage` 形状是 Anthropic 派生但被扩展：`{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_creation:{ephemeral_1h/5m}, server_tool_use:{...}, service_tier, speed, iterations:[], inference_geo, credits, original_credits, billable, request_id, context_usage_ratio}`。
- 模型名：全部为别名 `qfmodel`；`.models/<uid>/catalog-v6`（90 KB）是混淆/加密 blob，**本机无法把别名解析回真实模型**。
- `requestTokenAnchor` 是 `{request, response}` 两个 SHA-256 内容哈希 + `requestId`，不是 token 计数（不能误用）。
- 可用于归属的元数据齐全：`cwd`、`gitBranch`、`sessionId`、`entrypoint:"cli"`、`userType:"external"`、`version:"1.1.64"`、`isSidechain`（601 条 / 365 条 assistant，6 个 `agentId`，6/11 文件来自子代理）。
- 存在清理机制（`.last-cleanup` 有 2026-10-01 时间戳，`logs/**/segments/` 按时间分片）⇒ 历史可得性窗口需要探明。

## 3. 口径冲突（为什么不能照搬 OpenCode 的映射）

1. `public/usage-fields.js` 的契约是 `total = input + output`、`cached ⊆ input`、`reasoning ⊆ output`；`isZeroUsage()` 在 4 个适配器和 `usage-core` 共 6 处丢弃全零事件。**直接映射 → Qoder 来源一条事件都不产生**，看板显示为空且不报错。
2. 计价是 `token × 公开价目 = API 等价估算`，`01-roadmap.md` 明确"费用是估算，不是实际账单、订阅扣费或服务商配额消耗"。Qoder 给的恰是 `credits`（实际扣费侧）。要显示它，等于引入**第二种计量与费用口径**——这是产品边界变更，需要你决定，不属于适配技术细节。
3. 别名 `qfmodel` 无法解析 ⇒ 模型维度、缺价标记、自动价格发现都落不到实处。
4. 明确排除：`credits → $ → 反推 token`。这是用缺失数据伪造明细，违反"不用缺失日志推算""不把简化猜测记作来源核验成功"两条现行规则。

## 4. 机械成本：接线清单（照 OpenCode 逐点对应）

适配器需导出与 `opencode-usage.js` 同形的接口（可用性判定、文件展开、指纹、`parseX`、`streamXEvents`，两入口共用一个流式内核）。登记点：

- `src/usage-core.js`：`classifyImportDirectory`（判定顺序须先于 Codex，约 :307）、数据目录枚举与 `discoverXHomes` + `CODEX_USAGE_QODER{,_HOMES}` 开关（:500–545）、`discoverSources` 合并（:560–580）、显式导入建 source（:620–660）、`buildUsageFingerprint` 文件展开（:716–760）、`streamUsageFileEvents` 分派（:1665–1685）、`parseXForIndex`（:1857–1893）、`buildUsageReport` 分支（:1895–2010）、`buildUsageIndex` 分支（:2013–2070）
- `src/usage-store.js`：`STORE_SCHEMA_VERSION` 迁移落点（:398–410，字面量）、`usageFiles` 展开（:440–470）、harness 模型分组（:731–782）
- 非 Codex 限额排除：`public/timeline-utils.js:213` `NON_CODEX_SOURCE_KINDS`、`src/service-tier-evidence.js:56`、`public/app.js:52` `CODEX_HOME_KINDS`
- 展示分组与文案：`public/app.js:2612,2655–2662`（`HARNESS_ORDER`、渠道→桶、空态文案）、`public/timeline-utils.js:5–14`、`public/pricing-models.js:37`、`src/server.js:192–197`（导入标签）、`public/i18n.js:236,288,555`、`src/pricing.js:1018–1021`（币种兜底，Qoder 需明确选择）
- 若新增浏览器模块：`src/static-export.js` 内联闭包
- 测试：`test/qoder-usage.test.js`（含隐私哨兵）、`usage-core`、`usage-store`、`three-path-parity`、`server`、`i18n`、`app-render`
- 文档：`docs/data-sources/qoder.md` + `10`/`01`/`02` + `README.md`/`README.en.md` + `validation/<date>/`

子代理渠道按 DSH 做法由适配器直接写 `channel`（`Qoder Subagent`），不走 `classifyChannel`。

顺带可缓解的既有维护债（`data-sources/dsh.md` 已记录）：kind 判据散落多且形式不一。是否在本批收敛成单一注册表需单独权衡——收益是消除漏改，代价是改动波及全部来源，建议独立批次。

## 5. 三条候选路线

| 路线 | 内容 | 成本 | 代价 |
|---|---|---|---|
| **1（推荐先做）** | 只做发现/识别 + **版本守护式显式跳过并告警**："本机 Qoder 未提供 token 明细，来源已跳过"。约 0.5–1 天 | 低 | 看板不显示 Qoder 数据（这是诚实结果，不是缺陷） |
| 2 | credits 作为一等计量单位进入事件契约、时间线、模型表、周期对比、静态导出与三路一致 | 高（3–5 天 + 一轮 UI 决策） | 缓存命中率、输入/输出档位、缺价估算等半数语义失效；需先接受"实际扣费"口径 |
| 3 | 只统计请求数/会话数（不宣称用量） | 中 | 仍要在汇总里开一个非 token 维度，可看性有限 |

前置未知数会改变整体难度：**国际版 Qoder / IDE 版（`%APPDATA%\Qoder CN`、`com.qodercn.app.stable`）是否写真实 token**。若某版本写真实 usage 与真实模型名，路线直接变成"纯机械接入"，与 OpenCode 同难度；若同样只写 credits，才在 1/2/3 之间选。

## 6. 大纲（P0—P4）

- **P0 探针（只读，产出可行性判定）**：跨产品/版本枚举候选目录与文件形态；统计 token 非零率、`credits` 分布与语义、模型别名集合、子代理占比、追加写 vs 重写、`size+mtime` 指纹可靠性、清理策略保留窗口；证据落 `validation/2026-XX-XX-qoder-probe/`。**出口条件：明确"有 token / 只有 credits / 什么都没有"三选一**。
- **P1 口径决策（你拍板）**：路线 1/2/3；`credits` 是否允许进入费用侧（与"API 等价估算"边界的关系）；模型别名如何显示；限额排除确认；隐私边界（transcript 含完整 prompt 与文件快照，只取白名单字段并加哨兵回归）。
- **P2 最小接线**：按 §4 清单逐点接入；`version` 字段做版本守护（非受测版本 ⇒ 跳过并告警，宁可少统计）；缺价侧显式记为 unpriced，不做兜底猜测。
- **P3 回归与索引**：schema 11→12（沿用字面量落点写法）；kind 判据一致性测试（把 §4 的分散判据钉在一起）；三路一致；真库只读对照；SQLite 只读优先与回退行为说明沿用现有边界。
- **P4 文档与验收**：`data-sources/qoder.md`（含"只有 credits"这一实测边界）、更新 `10`/`01`/`02`、README 双语同步、日期验收目录与未覆盖清单。

## 7. 明确不做

不改动 `~/.qoder-cn` 任何文件；不解密 `.models/*/catalog-v6`；不上传本地用量、不调用 Qoder 远端接口取配额；不把 `credits` 折算成 token；不以"接上了"代替口径正确性验收。
