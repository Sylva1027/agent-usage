# Hermes Harness 功能对等实施计划

> 日期：2026-11-14（Asia/Shanghai）。状态：**已实施并完成本机自动化验收**；受环境限制的跳过项和性能测量范围见[验收记录](2026-11-14-hermes-acceptance.md)。
>
> 目标：Hermes 与当前项目的其他 Harness 具有相等的适用产品功能，并尽可能共用实现、数据契约和验收方式。不能通过禁止 Hermes 冷封存、阻止混合来源归档或关闭冻结来完成适配。
>
> 本计划替代原重评计划的施工安排；原文仍作为调查记录保存。代码与验收已整理至独立 Hermes 分支；提交与合入记录见验收记录，尚未发布。

## 1. 审查结论与基线

原计划对 `state.db`、多维聚合、主辅调用、聚合计价和来源确认的调查基本成立，但其一期范围不符合最新明确的“功能对等”要求，不能原样施工。以下修订已经纳入后文任务，不留给实施者临时选择。

| 问题 | 审查依据 | 本计划的处理 |
| --- | --- | --- |
| **P1：Hermes 留热并阻止整个混合范围封存，主动减少了现有产品功能** | 原计划 §7.3、§8.2；其他 Harness 已接入归档、修订、完整包、压实与恢复 | 冷封存及完整生命周期列入本次必做；扩展现有历史机制，不另建 Hermes 历史系统 |
| **P1：只禁止新封存，遗漏“其他来源先归档，Hermes 后导入”** | `usage-store.js` 的 `historyArchiveReparsePrefixes()` 在冷包没有该来源时跳过；`historyArchiveEventUnionForRange()` 随后拒绝授权范围中的任何热事实 | 在既有冷段内接纳新来源的修订覆盖，保持授权范围内无热事实的现有约束；相关快路和投影同步支持 |
| **P2：聚合计价不能只修 request input** | `pricing.js` 的 `contextTierFor()`、`rateSetsFor()`、峰谷分支、旧 Claude 上下文提示分别使用累计量或归属时间 | 一次明确输入档、输出档、峰谷、TTL、原因与覆盖计数；保留现有费用返回结构 |
| **P2：明细正值、缺失和“完整覆盖”的实施口径未定** | 原计划 §4.2、§8.5 仍要求 P0 决定 mask 与持久字段 | 明确 mask 表示账本中的已记录分项；来源覆盖完整性另由 Hermes 来源语义和现有估算原因表达，不把正值宣称为 provider 全量 |
| 无模型归属的数据还可减少不必要的遗漏 | 原计划只在整张模型表缺失时回退；本机源码说明 absolute 更新可以只写 sessions | 无任何模型行的单个 session 也可以回退为“模型未知”的会话聚合；存在模型行则不补残差，避免重复 |

### 1.1 固定基线

- 当前工作区：`E:/12 AI/ccusage/codex-usage`。
- 受审源码：`d818b6c407631553a6b50d3555a533110fdea7b7`；package `0.9.5`、releaseVersion `0.95`；store schema **24**。
- 当前工作区有其他文档修改。本轮不清理、不覆盖这些修改。实施时复用合适的当前 checkout；只有实际隔离需要时才新建工作树，不无条件要求重建仓库。
- 原计划：`C:/Users/Silver/.codex/worktrees/799e/codex-usage/docs/plans/2026-11-14-hermes-adapter-reassessment-plan.md`。
- Hermes 源码核查来自原计划所指的本机 managed workspace，重点复核了 `hermes_state_usage.py`、`hermes_state_schema.py`、`hermes_constants.py`、`tools/delegate_tool_child_run.py`。不把另一份 checkout 的 SHA 当作运行包身份。
- 本轮未重新采集真实 Hermes 数据库；原计划中的会话数、调用数和数据库体积仍属于原作者的快照证据。

官方文档确认平台 home 与 profile 隔离规则，实际数据字段仍以能力探测和已核查源码为准：[Session Storage](https://hermes-agent.nousresearch.com/docs/developer-guide/session-storage)、[Profiles](https://hermes-agent.nousresearch.com/docs/user-guide/profiles)。

### 1.2 本轮实际验证

环境：Windows、PowerShell 7、Node `v26.13.0`。没有执行完整 suite 或真实 Hermes 导入。

| 验证 | 结果 |
| --- | --- |
| `test/pricing-request-context.test.js` | 3/3 通过 |
| `test/no-tps-store.test.js` | 2/2 通过 |
| `test/no-tps-ui.test.js` | 2/2 通过 |
| `test/no-tps-history.test.js` | 沙箱外复跑 4/4 通过 |
| `test/history-archive-import-instance.test.js` | 沙箱外仍失败于第 283 行：冻结返回 500，`ERR_SQLITE_ERROR / unable to open database file`，与原计划记录一致 |
| 聚合计价纯函数探针 | 对目录中有阈值的 GLM、Grok、Qwen、MiniMax 模型，累计 input=600,000、requestInputTokens=0、contextLevel=unknown 仍返回 long；不能按不存在的模型名称探针推断目录行为 |
| 冷归档重叠夹具 | 用现有 candidate→prepare→commit 建立正常 Codex 冷段；确认可读后，按未来 adapter 的持久形状加入同范围 Hermes 热行；查询稳定报 `HISTORY_ARCHIVE_HOT_COLD_CONFLICT` |

最初沙箱内的三个历史失败先发生在临时文件硬链接 `EPERM`，换 workspace 临时目录后也一样；沙箱外复跑消除了硬链接失败，只剩上述冻结问题。不能把这两类失败混为一个缺陷，也不能把既有失败记作 Hermes 实现回归。冷重叠夹具模拟的是入库后的状态，并非尚不存在的 adapter 端到端测试。

## 2. 功能对等的验收范围

下表每项都是交付条件。任务可以分批完成，但不能把前半部分完成称为“已支持 Hermes”。

| 能力 | Hermes 必须达到的结果 | 复用入口 |
| --- | --- | --- |
| CLI 与目录发现 | 默认 home、环境变量、profiles、手动目录与重复路径处理完整 | `usage-core.js` 的 discover/classify/sourceId |
| Web 扫描与导入 | 扫描只列候选；确认、重试、进度、重启恢复、移除确认均可用 | `source-imports.js`、server/executor 既有任务链 |
| 普通统计 | 总量、输入、缓存、输出、推理、会话、模型、仓库、Harness 均接入 | 统一 UsageEvent、report/index/store |
| 范围与比较 | 今日／周／月／全部／自定义／最近范围、UTC/local、周期比较与记录卡 | 现有 range、rollup、period、record 实现 |
| 模型与价格 | 全历史和近期模型、同模型多 Harness、目录规范化、手动价目、币种与汇率 | 共享 pricing 与模型活动投影 |
| 更新与重开 | WAL 更新、UPSERT 增减、日期迁移、错误隔离、重开复用、已提交版本发布 | 现有 SQLite 来源、replaceFile、publication 链路 |
| 冻结与分享 | 冻结绑定同一来源／费用／筛选版本，分享采用同一汇总与未知明细 | 现有 snapshot、share-card-data |
| 冷历史 | Hermes-only 和混合范围都能 candidate、prepare、register、commit | 现有 archive 生命周期，无 Hermes 禁用分支 |
| 冷修订 | 同毫秒多行、数值增减、跨日、跨段、冷转热、热转冷、整源正常 prune | 共享稳定事件身份＋既有修订覆盖 |
| 导出与恢复 | 完整备份、完整包、导入新实例、冻结上下文、冷热混合重开 | `history-backup.js`、`history-archive.js` |
| 压实与回滚 | Hermes 冷包与其他来源相同地验证、压实、切引用、回滚与恢复投影 | `history-archive-compaction.js`，沿用原生租约要求 |
| 来源筛选 | 排除、恢复、混合统计、同 session ID 多 home 互不误去重 | 现有来源身份、筛选和偏好 |
| 非 Codex 限额边界 | 与 ZCode/DSH/OpenCode/Claude/WorkBuddy 一样，不伪造 Codex 限额 | 基于 source kind 的既有规则 |
| UI 与交付 | 中英文、现有皮肤、普通／waifu 包、导入帮助与分享一致 | 现有组件、资源和打包脚本 |

“对等”不要求制造来源不存在的数据：Hermes 的聚合行不能恢复逐请求时间、精确请求长度或 provider 全量请求数；其他 Harness 专属的 Codex quota 也不凭模型名称授予 Hermes。当前产品已移除 TPS，本计划不恢复它。跨 Harness 自动去重不是当前统一保证，继续共用来源排除机制，不新增一个 Hermes 专用去重系统。

## 3. 实现原则与文件边界

### 3.1 保持单条产品链路

```text
Hermes home/state.db
  → hermes-usage 标准化事件
  → usage-core 的既有来源分派
  → report / compact index / UsageStore
  → 共用 pricing、metadata、rollup、history projection
  → 现有 server/executor、dashboard、snapshot、share、archive/backup
```

只在来源物理结构和数据语义不同的地方增加适配逻辑。不得增加 Hermes 专用 summary API、独立 store、第二套金额计算、独立归档文件格式或独立前端统计。共有 SQLite 观察代码可以作小范围提取，让三个 SQLite adapter 使用相同实现；不借此重构全部来源为插件框架。

### 3.2 文件清单

| 层 | 文件／符号 | 工作 |
| --- | --- | --- |
| Adapter | **新增** `src/hermes-usage.js` | 能力探测、只读快照、规范化、身份、诊断；导出形状与 ZCode/OpenCode 相近 |
| SQLite 共用部分 | **拟新增** `src/sqlite-source-observation.js`；`zcode-usage.js`、`opencode-usage.js` | 只提取 DB/WAL stat、身份与观察所需的重复逻辑；不改变其他 adapter 的计数语义 |
| 来源入口 | `src/usage-core.js`、`src/source-imports.js`、`src/server.js` | 发现、分类、显式确认、fingerprint、三路分派、监听与标签 |
| 类型与字段 | `src/usage-types.js`、`public/usage-fields.js` | 文档化 aggregate 语义、`sourceEventId`；保留现有 usage/mask 形状 |
| 持久化 | `src/usage-store.js` | schema 迁移、sourceEventRow、事件投影、replaceFile、metadata、稳定快照发布 |
| 来源证明 | `src/usage-source-acquisition.js`、`src/usage-source-inputs.js` | SQLite/WAL 复核、重试观察一致性、版本失效；不接 JSONL append proof |
| 定价 | `src/pricing.js`、`public/app.js` 的 `pricingScenarioNotes()` | 聚合场景选择、既有原因集合及详情翻译 |
| 冷包与备份 | `src/history-archive.js`、`src/history-backup.js`、`src/history-compact.js`、`src/history-archive-compaction.js` | 新 schema、修订版本、旧包读取、验证、导出恢复及压实 |
| 冷热查询 | `src/usage-history-query.js`、`src/usage-history-projection-store.js`、`src/history-quote-inputs.js` | 稳定身份传递、修订输入、投影失效、冷热读路径一致 |
| 派生统计 | `src/usage-rollups.js`、`src/usage-all-summary-store.js`、`src/usage-metadata-store.js`、`src/usage-record-store.js`、`public/period-comparison.js` | 检查并补齐修订、日期迁移、已知性传播；无需改变的函数只补回归 |
| 前端 | `public/timeline-utils.js`、`public/pricing-models.js`、`public/app.js`、`public/i18n.js`、`public/share-card-data.js` | Harness、全量／近期模型、quota、帮助和详情；分享沿用通用数据结构 |
| 命令／执行器 | `src/cli.js`、`src/usage-executor.js` | 现有入口的参数、错误、版本与发布屏障，不增加 Hermes 专属命令 |
| 测试夹具 | **新增** `test-support/hermes-usage-fixture.mjs`、`test/hermes-usage.test.js`；扩展既有集成测试 | 共用合成 SQLite fixture，独立手算 oracle；按第 9 节覆盖 |
| 文档 | README 双语、`docs/10-data-sources.md`、`docs/11-pricing.md`、`docs/03-development.md`、`docs/history-retention.md`、`docs/15-delivery-upgrade.md`、**新增** `docs/data-sources/hermes.md` | 支持范围、路径、计数、费用、迁移、完整生命周期与执行证据 |

符号以上述 SHA 为准，实施时用 `rg` 重定位，不依赖旧计划行号。涉及新增持久字段时，必须检查列清单、数组偏移、payload 校验、备份、projection 与 frozen carrier，不能只改 INSERT。

## 4. 已确定的数据契约

### 4.1 读取范围与能力探测

1. 每 home 一个 `state.db`；只读打开并设置 `query_only`。只读失败走既有来源失败路径，不回退可写打开。
2. 使用 `PRAGMA table_info`、主键和必要列探测。缺可选列用 NULL 投影；必要关联／计数结构不成立则解析失败，不返回空成功。
3. 主投影只包含六维身份、五项 token、必要时间、会话 source/cwd/git_repo_root，以及诊断需要的 api_call_count。`estimated_cost_usd`、`actual_cost_usd` 不作为产品费用输入。
4. 不查询 messages、正文、system_prompt、model_config、标题或凭据。账本与 session 必要元数据在同一短 read transaction 中复制到 `UsageSourceRows`；事务结束后才 await repository resolver 或消费者。
5. `UsageSourceRows` 沿用默认 32 MiB 预算和 spill。会话索引、待发布事件和 cwd→repository 缓存也要受预算约束；不能仅限制一个集合，另留无界 Map。测试使用小预算直接触发 spill，不靠巨量 fixture 碰运气。
6. 当前六维主键及已知旧布局分别定义能力版本。缺失维度与“列存在但值为空”不得在 identity 中合并。遇到不认识的额外主键维度先报不支持，不能默默丢维度合并。

### 4.2 稳定身份与模型归属

- 模型行身份原值：`(session_id, model, billing_provider, billing_base_url, billing_mode, task)`。
- `sourceEventId` 使用带版本和记录类型前缀的 SHA-256，输入包括稳定 home/source 作用域、能力布局和原始元组；不包含时间、计数、显示 fallback。
- 原始 `null`、空字符串、缺列使用不同编码。endpoint 只参与摘要，不进入 ID 明文、诊断或浏览器 payload。
- 会话回退使用不同前缀与 session ID，不拿当前模型／时间作身份。
- `model` 保留原字符串；空模型显示 Unknown model。普通模型行不能用 sessions.model 覆盖历史路由。
- `sourceKind="hermes"`，普通 channel=`Hermes`；明确 `sessions.source="subagent"` 才用 `Hermes Subagent`。已核查 `delegate_tool_child_run.py` 存在该写入证据。父会话关系及 background_review task 本身不等价于 subagent。
- `git_repo_root`／`cwd` 只用实际元数据；缺失继续走共用 unknown repository。不同 home 中相同 session ID 是不同会话。

### 4.3 数量、已知性与回退

标准数值：`input = input_tokens + cache_read_tokens + cache_write_tokens`；`cached = cache_read_tokens`；`output = output_tokens`；`reasoning = reasoning_tokens`；`total = input + output`。reasoning 不再次加到 output 或 total。

明细位的含义是“账本存在可识别的该项记录贡献”，不是“该 session 的所有 provider 调用都完整上报”。具体规则：

- 有限、非负、安全整数才进入标准计数。缺列／NULL 的未知项仅在数值运算中按 0；0 不证明真实已知零。
- 原始分项为正数才设置相应已记录位。input 位要求三个输入分项均有已知证据；output、cached、reasoning 各自判断。
- cacheWriteTokens 保留已记录值；正数才设 `cacheWriteKnown=true`。不因为列存在、默认值为 0 就设真。
- 不把 sourceKind 的聚合含义塞入新的 mask 位。所有 Hermes 费用保留聚合覆盖说明，使用现有原因集合；不新增一套 completeness 布尔列。
- 调用 `validateUsageDetails()`；另保证即使 output 位未知，`reasoning > output` 仍产生诊断、撤销 reasoning 位并设置 inconsistency/gap，不能因 validator 的位判断漏检或静默 clamp。
- 非法负数、非有限数、溢出和无法定位日期的行使该来源本次快照不完整：不得把它当作权威空缺去删除旧热／冷事实。统一以来源解析失败保留上一成功版本；合法但缺少可选元数据的行仍导入。

手工 oracle 固定以下核心例子，adapter 的 detailMask 不额外混入 cacheWrite 位，布尔字段单独传播：

| 原始 I/R/W/O/Q | 标准 input/total | detailMask | cacheWriteKnown | 预期 |
| --- | --- | --- | --- | --- |
| 100/20/10/40/5 | 130/170 | 15 | true | 已记录五项均可展示，但来源覆盖仍不宣称完整 |
| 100/0/0/40/0 | 100/140 | 4 | false | 缓存、写入、推理不变成已知零；费用可依现有 total/output 规则推断输入 |
| 100/20/10/40/60 | 130/170 | 23 | true | reasoning 位撤销，gap=20，保留原始不一致贡献与诊断 |

主源与回退：

1. 有模型用量行的 session：导入全部模型行及全部 task，包含 voice_chat 和辅助任务；不再叠加 sessions 总量，不补正残差。
2. 模型表缺失，或某 session 完全没有模型行：若 sessions 有有效用量，输出一个会话聚合，模型为 Unknown model，标明归属和辅助覆盖未知。以同一事务的 `NOT EXISTS` 判定，不能分两次快照。
3. session 已有模型行但 totals 有差额，包括“只有辅助行”的情况：只诊断差额，不猜主路由，不把差额套到 sessions 当前模型。
4. 回退 session 后来出现模型行：完整来源替换删除回退事件、加入模型行；100→150 的结果为 150，不是 250，冷热两层都如此。
5. 孤儿模型行可保留用量与未知元数据；不因 archived/hidden 或 compression lineage 再展开／删除记录。

api_call_count 用于来源诊断；不变成统一请求数，不把聚合行数称为调用次数。数值为零的无用量行沿用现有普通用量事件语义，不为了 call count 造 token 事件。

### 4.4 时间

依次选择 `last_seen → first_seen → sessions.last_activity_at → sessions.started_at`，验证 Unix 秒并转换为安全毫秒整数；不使用当前时间补位。日期是聚合归属日期，后续修订可能移动。功能上继续支持全部 range、比较和分享；来源详情说明粒度，不在主页增加常驻说明框或警告徽标。

## 5. 发现、SQLite 观察与三路接线

### 5.1 来源管理

- Windows：`%LOCALAPPDATA%/hermes`，缺 LOCALAPPDATA 时使用 home 下 `AppData/Local/hermes`；其他平台：`~/.hermes`。`HERMES_DATA_DIR_SUFFIX` 只按运行源码规则影响默认根。
- `HERMES_HOME` 增加候选；默认根的 `profiles/*` 只枚举一层。明确配置的根可探测其直接 profile 层，不递归扫描整个用户目录、不执行 Hermes Python 代码。
- 显式 `CODEX_USAGE_HERMES_HOMES` 按平台路径分隔符解析，并按现有配置契约视为确认来源；`CODEX_USAGE_HERMES=0` 关闭自动发现，不关闭独立显式导入入口。
- 目录识别先验证最小 Hermes schema，再进入 Codex 泛化 `sessions/` 判断；只有文件名 `state.db` 不够。看板仍导入 home，不直接导入单数据库文件。
- 共用 `importPathIdentity()` 的 realpath／Windows 大小写语义。确认后持久保存既有 source id；profile 或路径别名不制造重复来源。独立副本不因 session ID 相同自动删除。
- 空 confirmedSources 必须保持空；确认来源不可读时保留其身份和既有事实。profile 扫描遇到一个坏库不吞掉其他候选。

### 5.2 SQLite 观察

Hermes 属于完整快照来源，不接 JSONL offset／byte-append 或 `reuseSourcePrefix`。按既有来源协议提供 DB＋非空 WAL 的观察，确保 discovery、usageFiles、buildUsageFingerprint、acquisition、重试和最终校验使用同一口径。

共用 SQLite 观察至少区分主文件与 WAL 的身份、长度、mtime、ctime，空 WAL 视为无提交内容。不得把当前“主文件头尾 hash＋WAL size/mtime”称为 WAL 内容证明；也不得把跨连接的 `PRAGMA data_version` 当持久版本号。

本期正确性回退：无法证明来源未变时，重新读取短事务中的最小用量／元数据投影并计算规范化快照摘要，复用同一有界快照发布，不能靠 size/mtime 相同直接跳过 Hermes 账本。摘要包含身份布局和 parser 版本；不读取正文来计算业务摘要。native helper 可以提供变化提示／证明，但缺 helper 时必须有完整读取路径。

读取前后验证身份和观察；同一只读连接的 data_version 仅辅助检测读取期间提交。发生变化使用现有 `LIVE_SOURCE_CHANGED` 和有限重试；耗尽时保留上一已发布版本。重试不能把 WAL-aware info 替换为裸 `stat(db)`。只读创建或清空空 WAL 不应造成无限重扫。

### 5.3 三条读取路径

同时接入 `streamUsageFileEvents()`、`buildUsageReport()`、`buildUsageIndex()`，随后由 UsageStore 的现有 full replacement 使用同一 stream。三路必须保持 source kind、sourceEventId、mask、cacheWrite、unknown context、仓库和 session 作用域一致。

三路对拍不能只比 total，也不能三路互相复制错误作为唯一证明；应同时对独立手算 fixture 核对费用原因、会话数、分组、日期与明细不可用量。索引 mapper 继续使用既有 intern 结构，不新增第二套汇总器。

## 6. 共享计价方案

Hermes adapter 默认 `requestInputTokens=0`、`contextLevel="unknown"`、`serviceTier="unknown"`，不求每调用平均值。聚合能力由 sourceKind 在共享计价入口识别；无须为这一事实再加数据库列。

| 维度 | 行为 | 需要固定的回归 |
| --- | --- | --- |
| 输入上下文 | 可靠单请求长度优先；Hermes 无该证据时保持 unknown，不回退累计 input；旧调用方字段缺省的兼容行为单独保留 | 各目录阈值前后、累计 600k、真实 requestInputTokens、Codex 专属短档政策不泄漏 |
| 输出阈值 | Hermes 的累计 output 不决定单请求输出档；枚举 short、shortLongOutput、long 中适用费率，沿用最低场景规则 | GLM-4.7／4.5-air 的累计 199/200/400 不制造请求档变化；逐请求仍按阈值 |
| 峰谷 | last_seen 只用于统计归属；聚合费用比较可行峰谷场景，采用现有最低场景口径 | DeepSeek 同一聚合改 last_seen 不切换为“已证实峰价／谷价”；逐请求行为保持 |
| Cache write TTL | 有已记录写入但无 TTL 时沿用 Claude 5m 估算／unsupported 规则，不从累计数量推断 | 缺 TTL、5m、unsupported、unknown write 不互相覆盖 |
| 明细与模型 | 使用同一 `usageFields`／最低类别回退／共享 canonical resolver；缺价和免费规则保持 | 未知模型、免费模型、路由前缀、同模型多个 Harness |
| 服务档位 | unknown 使用现有 standard scenario，不从 billing_mode 猜 fast 或套餐 | 原生 Codex 模型在 Hermes 下仍属于 Hermes |

返回形状保持现有 `unpricedReasons`、`minimumEstimatedTokens`、`contextUnknownTokens`、`serviceTierUnknownTokens`、`cacheWriteUnknownTokens`。新增原因字符串可采用：`aggregate-usage-coverage-unknown`、`request-output-unknown-minimum-scenario`、`request-time-unknown-minimum-scenario`。字符串是拟定 API，应在此任务一次固定并补中英文详情映射。

对于因聚合未知而使用最低档／时段的报价，将受影响 priced tokens 纳入 `minimumEstimatedTokens`；本期允许保守地标记整个已报价事件，但不能重复叠加超过 pricedTokens。免费政策仍优先，不能给免费模型造非零费用或 unpriced tokens。来源覆盖说明与“未知模型最低费率”是不同原因，不能混作缺价。

采用人工费率 fixture：input=2、cached=0.2、write=2.5、output=10 USD/M，其他可行档费率更高，且无峰谷折扣。第 4.3 节第一行应为 `(100×2 + 20×0.2 + 10×2.5 + 40×10)/1e6 = 0.000629 USD`，context 为 unknown，并保留聚合原因。另设更便宜的输出／谷价场景独立核对选择，不使用生产 estimator 生成 expected。

修改算法后更新 `API_PRICING_VERSION`，让持久费用投影、全历史汇总、memo 和快照按既有版本机制失效。冻结实例仍绑定冻结的价目／输入，不被实时改价覆盖。不要以新增 reason 字符串为由改造整个费用 accumulator 格式。

## 7. 冷历史：扩展现有修订机制

这是本计划与原计划最大的区别，也是功能对等的必要工作。

### 7.1 保留哪些现有机制

- 冷包不可变，保留原始 sealed 事件；实时统计应用主库中的修订覆盖。
- `history_archive_event_authority` 继续按已授权时间段生效；授权段内不能残留热事实。
- 候选、证据、prepare、commit、投影、备份、完整包与压实继续用现有入口和提交屏障。
- 不通过删掉 `HISTORY_ARCHIVE_HOT_COLD_CONFLICT` 校验解决问题；不改成相交时间段可以随意重复登记。

### 7.2 Schema 与旧包兼容

本次需要持久稳定身份，明确安排 **schema 24→25**（若开工时 25 已被占用，使用当时下一版本）：

```sql
ALTER TABLE events ADD COLUMN source_event_id TEXT NOT NULL DEFAULT '';
CREATE INDEX events_source_event_id
  ON events(source_path, source_event_id)
  WHERE source_event_id <> '';
```

身份重复由事件表的 INSERT／UPDATE 触发器拒绝。使用非唯一索引是为了保留现有的元数据和汇总投影优化：这些优化会对任何唯一事件索引保守回退，而触发器可以直接拒绝相同来源的重复非空身份。

- 新 Hermes 事件总是有 `source_event_id`；旧来源默认空字符串，继续现有兼容路径。不凭 session/timestamp 为旧冷包伪造稳定 ID。
- 新增 `UsageEvent.sourceEventId` 与入库字段；adapter 的旧 eventId 可保持同值，不能再次停留在不持久化层。
- 同时更新 fresh schema、迁移、EVENT_INSERT_COLUMNS、sourceEventRow、冷 payload 校验、查询投影及相关格式标识。冷＋热有效视图中的唯一性由完整替换事务验证，不能只依赖热表 UNIQUE。
- `history-backup.js` 新增 schema 25 到现有 allowlist。备份容器本身没有必要因一个事件列变成第二套格式。
- 旧 schema 19–24 包先按其原始格式验证完整性，再在读取／投影边界补 `source_event_id=''`。不得先修改包或补列再比较旧 manifest/hash。
- v1 revision payload 按旧列集合验证，v2 按新列集合验证；运行时归一后再做 payload 对比。原始证据摘要和归一后的比较键必须分开。
- `history_replaced_facts` 的旧 JSON 保留原样，新增保存包含稳定身份；不重写旧恢复证据。
- 旧程序拒绝新版活动库；程序回退沿用“保存新状态＋旧程序使用升级前完整副本”的现有交付流程。压实回滚仍用当前主库与映射，不能拿升级前库覆盖当前库。

### 7.3 v2 修订覆盖：接纳冷包原来没有的来源

沿用 `history_archive_event_revisions`，新增 **formatVersion=2**。每条 revision 保留现有 segmentId、databaseSha256、sourceIdentity、removed、added，并明确 `binding: "base" | "introduced"`。

| binding | 含义 | 验证条件 |
| --- | --- | --- |
| base | 冷包原本就包含该来源 | 与包内 source identity 一致，removed 不超出原始 payload 及次数 |
| introduced | 冷包封存后才进入该范围的来源 | 原包在该范围的来源证据中没有该来源事实／绑定；removed 必须为空；sourceIdentity 与本次已验证并持久的 source_files 一致；added 均在段内，具有非空稳定 ID |

v1 读取保持原行为；v2 由已验证完整来源快照的替换事务生成，不接受外部请求直接提交任意增删 payload。首次使用 v2 时按明确规则转换旧 revision 记录；原包、旧 hash 不变。候选库可能保留范围外来源的 source_files 行，不能仅凭表中存在该行判为 base；以该段经过验证的来源证据为准。旧无稳定 ID 的 base revision 转为 v2 时仍保留旧限制，不因容器升级自动获得任意删除能力。

所有读取路径的“有效来源集合”都是包内来源与有效 introduced bindings 的并集。需一并覆盖 `applyHistoryArchiveEventRevisions()`、`validateHistoryArchiveSourceRevisions()`、`readHistoryArchiveSnapshot()`、published reader、磁盘 reader、持久 projection、metadata 与按日查询。introduced 来源后来消失时，source_files 的保留身份仍可用于恢复读取；不能要求真实 state.db 永远在线。

关键效果：已有 Codex 冷段覆盖某日，后来导入该日 Hermes 记录时，记录作为该段的 introduced revision 进入有效冷视图；主库 events 不插入这一日期的热行。这样既支持后导入，也保留现有范围授权约束。

### 7.4 完整快照的统一替换算法

在 `replaceFile()` 的既有写事务内，给具备稳定 sourceEventId 的完整快照增加一条共用替换路径；旧无稳定 ID 来源继续现有受限修订逻辑。

1. 来源快照先读完并通过结构、数值与稳定性验证；不一边读关系表一边向已发布视图追加。
2. 加载该来源当前有效热事实、冷原始事实及覆盖，使用 `UsageSourceRows` 建有界索引；稳定键为 source scope＋sourceEventId，时间只是可变属性。
3. 将新快照的每行按当前 timestamp 分配：落入已授权段→该段目标冷集合；否则→热集合。空快照是可表达的正常结果，来源不可读不是空快照。
4. 对每个受影响冷段，以**不可变原包**为基线生成累计 removed/added；不能把上一次 overlay 继续当新增量叠加。
5. 新来源进入已有段采用 introduced binding；该段原始来源证据已有绑定的来源采用 base，即使它的原始行后来已被覆盖删除。introduced 集合变空时可以移除这一空 revision；base 的删除覆盖必须保留，防止原始值重新出现。
6. 数值增减、旧 ID 消失、新 ID 出现、同一 ID 跨段／冷热迁移均在同一事务中写入。目标时间与旧时间同时标记 dirty；全历史、model activity、repository、period、record 投影同步失效。
7. 在写入前后核对有效视图中每个非空稳定 ID 最多一条。发生重复身份、非法 snapshot 或中途来源变化则回滚，不发布半个迁移。
8. 被替换／删除的旧有效 payload 写入现有 `history_replaced_facts`，包括**第一次**修改冷原始值；不能只在“已经存在旧 revision”时保存。
9. 主事实事务提交后，使用既有派生构建与 publication barrier。读者在目标版本可读前仍读上一完整已发布版本；不声称 sync 所有事务变成一个事务。

必须用下面的表作为行为 oracle：

| 前态→新来源快照 | 当前有效结果 | 历史包与恢复证据 |
| --- | --- | --- |
| 同 ID 100→150 | 150，一条 | 原包不改；旧有效 100 留恢复证据 |
| 同 ID 150→80 | 80，一条 | 不因下降拒绝可变快照 |
| 同毫秒同 session 不同 task/model | 每个六维 ID 各一条 | 不再用 timestamp/session 合并 |
| 冷 A→冷 B | A 移除、B 加入，一条 | 两段更新同一事实事务；旧包不改 |
| 冷→热／热→冷 | 仅目标层计入一次 | 来源身份、mask、费用输入不丢失 |
| 新来源→已授权旧冷段 | introduced 覆盖，正常查询 | 不制造热冷冲突，不要求用户撤销原归档 |
| 有效 DB 删除全部用量 | 当前该来源总量为 0 | 原包与 replaced facts 可恢复 |
| DB 丢失／坏库／拒绝读取 | 保留上一成功事实 | 既有来源错误状态，不伪装正常删除 |
| session fallback→模型行 | 仅新模型行计入 | 允许身份集合变化，原 fallback 退出当前视图 |

### 7.5 查询、快路与维护

- 不能只修 `historyArchiveEventUnionForRange()`。检查 usage-store 中全部 `HISTORY_ARCHIVE_HOT_COLD_CONFLICT`、source binding、native identity 与 revision 校验调用；有 v2 introduced revision 时，无法解释它的优化分支应走**共享完整历史读取**，不是关闭产品功能。
- `UsageHistoryQuery` 和 `HistoryProjectionStore` 在一个发布版本内同时应用所有受影响段、热行和来源 identity。修改 format/version，使旧 projection 不被误复用；旧 schema 冷包通过归一层加载。
- `HistoryQuoteInputs`、cost row arrays 不需要为了身份做额外计价字段，但不能丢 sourceKind 和明细。稳定身份如进入行数组必须显式更新偏移和测试。
- sealed archive 的 days/events 接口仍显示原始值；实时 summary 显示修订后值，语义与现有产品一致。不得把两个接口误判为应返回同一金额／数量。
- 完整包包含主库 v2 revisions、新 schema 与全部原包；导入实例验证 introduced bindings，即使源 DB 不在也可读取。
- 压实切换 segment/hash 时同步重绑定 v1/v2 revision；完整验证、故障重试、投影恢复和反向切换均保留 introduced bindings 与稳定 ID。不因 Hermes 绕过原生租约要求。
- 本计划不实现“来源粒度归档授权”或自动解封重建整个冷库：扩展现有 overlay 已能覆盖本次需求，避免并行维护两种授权模型。

## 8. 施工任务卡与顺序

每张卡包含实现、相关调用方、fixture 和必要回归。共享文件保持单写者；本计划本身不要求启动多个 agent。

### P0：冻结契约与基线（先做）

- 记录实际 HEAD、Node、依赖、dirty files、helper 和浏览器运行条件；不把本机失败写成远端 CI 仍红。
- 将第 2、4、6、7 节转为 fixture/oracle，固定 schema 25 与 revision v2 的精确 JSON shape。
- 定位现有冻结 500 的具体文件打开点和环境差异；用隔离最小 fixture 检查受支持 Windows 路径。不提前认定是 URI、空格或 TEMP 的根因。
- 新增冷重叠回归：候选→实际 commit→新增来源→查询，必须在接线完成后从当前预期失败变为通过。
- 退出：数据语义无待定参数；基线问题可单独追踪。冻结问题不阻止独立 parser 开发，但未有 Hermes 冻结成功证据不能最终验收。

### P1：Hermes fixture 与 parser

- 新增 `hermes-usage-fixture.mjs` 与 `hermes-usage.test.js`，沿用 node:sqlite 创建临时源。
- 实现第 4 节：能力布局、最小列投影、只读事务、六维身份、session fallback、主辅与子代理、仓库、mask、诊断、有界容器。
- 为正文／凭据／endpoint 放置哨兵；捕获输出与允许的 SQL，验证不查询禁用列、不输出敏感值。
- 退出：独立手算值全部通过；回退升级、重复身份、坏 schema 与资源释放有证据。

### P2：持久身份与旧数据兼容

- 实现 schema 迁移与 `source_event_id` 全链路；迁移前后旧来源数量、金额、业务列与恢复证据不变。
- 更新 schema allowlist、冷 payload v1/v2 解码、投影格式、旧包归一读取；构造旧 schema 19/20/21/22/23/24 与新 25 fixture。
- 更新 no-TPS 测试中的“当前 fresh schema”断言为 25，同时仍测试 23→24 的历史边界和升级到当前版；不恢复旧 TPS 表的读取逻辑。
- 退出：新库、24→25、旧冷包＋新热库、完整备份恢复均通过；旧包字节/hash 不变。

### P3：共用历史修订扩展

- 实现第 7.3/7.4 节，支持 base/introduced、完整集合增减、日期迁移和第一次冷修订的 recovery evidence。
- 覆盖 candidate、prepare、register、commit、replay、直接模块调用及 stale candidate；本阶段不加入 Hermes 冷范围门禁。
- 为旧无 sourceEventId 的来源保留原规则；新稳定 ID 路径不向旧证据追认未知身份。
- 退出：同毫秒、跨段、冷热、删空、后导入旧范围、故障回滚的状态表全部满足；每 ID 一份当前事实。

### P4：历史读取、投影、完整包与压实

- 更新所有冷热读取与 source identity 校验，接通 metadata、rollup、period、record、summary 和费用输入。
- 完成 full rebuild 与 incremental projection 对拍、重启恢复、导出导入新进程、冻结与压实重绑定／回滚。
- 在主库提交后、派生构建中断、projection 提交前后插入既有故障点；重试不得多算、漏算或破坏旧冻结。
- 退出：旧包 sealed 接口保持原值，当前有效视图采用修订；完整包离线读取、重开与压实回滚均通过。

### P5：来源接线与可靠更新

- 接入 discover/classify、scan/confirm、manifest、指纹、watch roots、stream/report/index/store、acquisition 与 retry。
- 提取必要 SQLite 共用观察；为 ZCode/OpenCode 保留现有 stat/empty WAL 行为回归，Hermes 使用第 5.2 节的完整快照回退。
- 导入任务完成点沿用看板目标版本可读的条件。来源移除／恢复、未确认来源、失联和失败重试使用现有状态。
- 退出：扫描不导入；确认→刷新→重启→重试→移除流程完整；三路同值；WAL-only 修订可见且不走追加路径。

### P6：共享聚合计价

- 实现第 6 节，修 input/output/time/TTL 所有入口和旧 Claude 提示；不只改 adapter。
- 更新 pricing version、原因详情、缓存失效；新逻辑在 report/index/store、timeline 和 freeze 上相同。
- 退出：手工费用 oracle 与多模型场景通过；现有逐请求来源、Codex 特定政策、免费模型和改价行为不回归。

### P7：Harness metadata、UI 与分享

- 补齐 `HARNESS_MODEL_NAMES`、`harnessModelName`、近期 observation、HARNESS_ORDER、buildModelActivity、sourceGroup 与非 Codex quota 判定。
- 对直接触及的来源白名单一并补齐已确认的 WorkBuddy 漏项，用所有已支持非 Codex Harness 参数化测试防止再次漏接；不展开独立 WorkBuddy 功能改造。
- 导入说明、空状态、中英文路径提示和主动展开的聚合／覆盖／跨来源重叠详情使用现有组件；主页不新增长驻解释框。
- 验证源排除、同模型多 Harness、空近期集合、各 skin、分享与显示币种；不添加 Hermes 专用分享模板。
- 退出：1920×1080、2560×1440 及并排窄视口的实际浏览器检查通过，适用功能无 Hermes-only 禁用分支。

### P8：全链路交付验收

- 真实 Hermes 仅只读导入到隔离索引，和同事务投影的独立计数核对；只留聚合结果，不保存消息或凭据。合成 fixtures 负责 profile、主辅、故障和大规模覆盖。
- 测试 Node 24/26、typecheck、lint、format，以及普通／waifu 两包的构建、导入、刷新、冻结、分享与重开。
- 更新支持文档、迁移与恢复说明、计划索引和验收记录；只有本卡通过才把 Hermes 标为支持。
- 退出：第 9、10 节全部有结果；skip 明示，不用其他来源的通过替代 Hermes。

依赖关系：`P0 → P1/P2 → P3 → P4`；`P5` 依赖 P1/P2，`P6` 可在 P0 的计价契约冻结后独立推进，`P7` 在 P5/P6 后验收；`P8` 汇合所有卡。中间卡可开发和审查，但完整生命周期通过前不发布“精简 Hermes 版”。原计划 5.75–9.5 日的留热估算已不适用；新工期应按完整冷修订和兼容任务重新估，不沿用旧数字。

## 9. 测试矩阵与执行入口

优先扩展已有测试，避免为 Hermes 复制整套测试框架。新 parser fixture 同时被各路径引用；expected 数值独立手算。

| 场景 | 测试落点（现有文件或拟新增组） | 核心断言 |
| --- | --- | --- |
| 原始语义 | 新 `hermes-usage.test.js` | 六维任一维变化不同 ID；更新计数和 last_seen 不改 ID；NULL/空/缺列不混淆 |
| 主辅／回退 | 同上 | voice_chat 与 aux 都计入但 sessions 不重复；无模型行 fallback；后续模型行替换 fallback；未知 task 不补残差 |
| 已知性 | 同上、`pricing.test.js`、`share-card-data.test.js` | 第 4.3 节三例；正值与完整覆盖分离；未知零不显示成精确零；reasoning 异常可见 |
| 来源管理 | `source-imports.test.js`、`source-imports-browser.test.js`、`usage-core.test.js` | 默认/env/profile、显式空确认集、junction/别名、多 home、坏库、确认→重启、移除 |
| 三路与派生 | `three-path-parity.test.js`、`usage-store.test.js`、metadata/period/record 集成组 | totals、mask、费用原因、session、模型、仓库、sourceKind、UTC/local/DST、source exclusion |
| SQLite 更新 | `sqlite-source-stability.test.js`、`sqlite-source-bounded.test.js`、`usage-source-acquisition.test.js` | 真实 WAL writer、UPSERT、不变 row count、checkpoint、同大小替换、读取中写入、无 helper、有限重试 |
| 热生命周期 | `usage-source-replacement.test.js`、`history-retention.test.js` | 100→150→80；跨日旧新 dirty day；库内 prune／删空与整库失联区别；replaced facts |
| 冷稳定身份 | 新 `history-mutable-source.test.js`，复用 cold revision fixtures | 同毫秒多模型/task；base/introduced；冷 A↔冷 B、冷↔热；无重复有效 ID |
| 后导入与混合封存 | 上一组、`history-archive-commit*.test.js` | 先 Codex 归档再 Hermes 导入正常；Hermes-only/混合范围能封存；stale candidate 拒绝且零删除 |
| 兼容与备份 | `history-backup.test.js`、`history-parity.test.js`、`no-tps-{store,history}.test.js` | 旧 schema 包和 revision v1 读取；25/v2 往返；旧 manifest/hash 不改；无新 TPS 依赖 |
| 读取与故障恢复 | `history-query-persistent.test.js`、`history-projection-*.test.js`、`history-published-events.test.js` | full/incremental、已发布版本、故障后重试、并发冻结、重启与旧 projection 失效 |
| 完整导入／冻结 | `history-archive-import-instance.test.js`、`history-archive-import-new-process.test.js`、`history-cold-freeze-api.test.js` | source DB 缺失仍可离线查包；改价/增长/排除不改变冻结；原 500 基线解释或修复 |
| 压实 | `history-archive-compaction*.test.js` | v2 introduced binding 和 sourceEventId 随映射重绑定；中断恢复、反向切换；旧包保留 |
| 计价 | `pricing.test.js`、`pricing-request-context.test.js`、`claude-pricing.test.js`、history pricing 组 | 已知模型真正命中目录；输入／输出／时段／TTL 分别未知；服务档、免费、路由、手动价、版本失效 |
| Harness/UI | `timeline-utils.test.js`、`pricing-models.test.js`、`app-render.test.js`、`i18n.test.js`、share 组 | Hermes 与 Subagent 归组；近期与全量一致；所有非 Codex kind 不误亮 quota；中英详情不挤主页 |
| 资源与隐私 | parser/bounded 组＋实际浏览器 | 1k/10k 行、小预算 spill、重复 cwd、连接关闭；无正文/凭据/endpoint 泄漏；无无界临时集合 |

执行命令以实际测试文件为准；带星号的测试组先用 `rg --files test` 展开，Windows shell 不依赖隐式 glob 展开。全量使用 CI 已有入口：

```powershell
# PowerShell 7；项目已有依赖环境正常时不无意义重装。
node --test test/hermes-usage.test.js test/pricing-request-context.test.js test/three-path-parity.test.js
node --test --test-reporter=spec --test-concurrency=4 --test-timeout=720000 "test/**/*.test.js"
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run native:build
npm.cmd run native:check
npm.cmd run package:release
npm.cmd run package:check -- output/releases --browser
```

Node 24/26 分别执行与 CI 对应的检查；打包按 workflow 在 Node 24 验收两包。需要原生 helper 的压实／租约用例必须在匹配 helper 环境跑一次，缺 helper 的 full-read 回退也单独测。浏览器环境沿用 CI 的 `AGENT_USAGE_PLAYWRIGHT_MODULE` 约定，不因写计划安装新依赖。

性能只记录同版本／同 fixture／同环境的冷启动、稳定重开、WAL 修订、跨段迁移、峰值内存与 spill 数据。聚合来源可变，不能以 JSONL append 的延迟作为未经测量的承诺；也不能用性能优化为理由跳过必要校验或关闭功能。

## 10. 完成定义与交接

- [ ] 第 2 节所有适用能力均可用，特别是 mixed archive、旧冷段后导入、冻结、完整恢复与压实。
- [ ] Hermes 只增加来源适配；summary、pricing、history、snapshot、share 使用现有共用链路。
- [ ] 无 `if hermes then disable archive/freeze/share` 等产品降级；无按模型前缀误归 Codex。
- [ ] 稳定身份与 schema/revision 迁移覆盖 hot/cold、旧包、投影、备份、导入新进程和回滚。
- [ ] 所有 mutable snapshot 的增减与日期迁移最多一份当前有效事实；旧值有现有恢复证据，故障不发布半成品。
- [ ] 统计、费用、来源明细、价格管理与分享对 unknown 的解释一致；机制说明只在已有可展开详情和文档中出现。
- [ ] 真实只读来源核对、合成边界、Node 24/26、浏览器和两包验收有独立记录；冻结 500 不被掩盖。
- [ ] 交接列明受测 SHA、命令、pass/fail/skip、相关 fixture、性能条件、迁移与恢复办法。
- [ ] 全部卡通过后更新“已支持 Hermes”；发布动作按实际后续任务执行，不把本计划当成已经实现或发布。

本计划明确不新增 TPS、逐请求伪造事件、provider 账单承诺、跨 Harness 自动去重、独立 Hermes 后端或额外常驻 UI 提示。保留这些数据边界不减少现有适用产品功能。
