# 数据来源与统计口径

更新：2026-11-12。本文维护普通用量、费用、限额与来源读取的共同规则；各来源的字段映射分别见下方专题。

## 来源与导入

打开“数据来源”即扫描当前用户的常见目录，勾选结果后点击“导入所选”开始读取历史。找不到时显示手动入口及寻找方法，也可用“添加其他位置”补充目录。Windows 使用系统文件夹选择器，macOS 沿用原生选择器。

导入使用“读取记录／建立统计／校验记录／更新看板”阶段及已用秒数，关闭弹窗不会取消后台导入。刷新页面会重新接入当前任务；服务重启后按已确认目录恢复增量读取。目标版本成功显示到看板后才报告完成。失败保留已读取事实，重试不会重复累计事件。

Web 的刷新、快照与后台监听只读取已确认来源。新安装初始为空；升级时保留旧手动目录和索引中的来源身份，热、冷历史及统计排除偏好不变。`imports.json` 自动迁为 v2，旧清单保留 `.v1-backup`。CLI 汇总仍自动发现默认来源。显式的 `CODEX_USAGE_*_HOMES` / `CODEX_USAGE_IMPORT_DIRS` 配置视为已确认；`CODEX_HOME`、`CLAUDE_CONFIG_DIR` 和 `XDG_DATA_HOME` 只补充扫描候选。

- [Codex](data-sources/codex.md)：默认 `~/.codex`，读取会话 `.jsonl` 和 `.jsonl.zst`，并探测本机 JetBrains 集成目录；`CODEX_USAGE_HOMES` 可追加 Codex home。
- [ZCode](data-sources/zcode.md)：默认 `~/.zcode`，依次探测 `cli/db/db.sqlite`、`db/db.sqlite`。
- [DSH](data-sources/dsh.md)：默认 `~/.dsh`，读取 `sessions/<cwd-slug>/<sessionId>/session.v<N>.jsonl.zstd`。
- [OpenCode](data-sources/opencode.md)：探测 `~/.local/share/opencode`、Windows APPDATA/LOCALAPPDATA 和 macOS Application Support 下的目录，再展开目录中的 `opencode*.db`。
- [Claude Code](data-sources/claude-code.md)：默认 `~/.claude`（并发现 `CLAUDE_CONFIG_DIR`），读取 `projects/<cwd>/<sessionId>.jsonl` 与 `projects/<cwd>/<sessionId>/subagents/agent-*.jsonl`，按 `message.id` 去重。
- [WorkBuddy](data-sources/workbuddy.md)：默认 `~/.workbuddy-ai`，读取 `projects/<cwd-slug>/<sessionId>.jsonl`，按 `providerData.messageId` 去重；Auto（`model=default-model`）记录整体排除。
- [项目日志](14-project-log.md)：导入包含 `.codex-usage/usage.jsonl` 的项目目录。

看板导入的是 home、数据目录或项目目录，不直接导入单个数据库文件。显式导入目录先按 ZCode、DSH、OpenCode、Claude Code 的具体结构判定，再检查 Codex 和项目日志，避免同名 `sessions` 目录误判（`~/.claude/sessions/` 与 Codex 的 `sessions/` 同名，Claude 必须先判）。

WorkBuddy 的判定必须排在 Claude Code 之前：两者都是 `projects/<cwd-slug>/<sessionId>.jsonl` 结构，只能按内容区分。探测只看最多 3 个会话文件的前 64 KiB，出现 `"type":"session-meta"`、`"type":"function_call"` 或实际 CLI 的 `__codebuddyLocal` 标记即判为 `workbuddy-home`；目录形状相同但内容不符时仍按 Claude Code 判定。

追加来源分别使用 `CODEX_USAGE_ZCODE_HOMES`、`CODEX_USAGE_DSH_HOMES`、`CODEX_USAGE_OPENCODE_HOMES`、`CODEX_USAGE_CLAUDE_HOMES`、`CODEX_USAGE_WORKBUDDY_HOMES`；多个路径使用系统分隔符（Windows `;`，macOS/Linux `:`）。设置 `CODEX_USAGE_ZCODE=0`、`CODEX_USAGE_DSH=0`、`CODEX_USAGE_OPENCODE=0`、`CODEX_USAGE_CLAUDE=0`、`CODEX_USAGE_WORKBUDDY=0` 可关闭对应的自动发现；显式导入是独立路径，不能把这些开关当成禁止导入策略。`CODEX_USAGE_IMPORT_DIRS` 可提供额外导入目录。

## 统一事件口径

标准事件携带时间、会话、来源、渠道、模型、仓库归属、Token 数量和已知明细标记。`total` 保留来源提供的可信总量或来源适配器明确构造的总量；缺失与真正的 0 分开处理。

看板按以下子集关系使用明细：缓存命中属于总输入，推理属于总输出，缓存写入作为独立计价明细记录。来源的原始计数若为并列关系，适配器须先重构；不能用缓存命中输入再次增加总量，也不能把独立推理输出漏出总输出。

`validateUsageDetails()` 校验明细与总量关系；不一致时撤销不可信明细并保留差额标记。费用端随后选择适用估算，见[计价](11-pricing.md)。这不是把缺失数据补零或从正文估算 Token 的许可。

DSH 的非零缓存写入已核实，见[DSH 专题](data-sources/dsh.md#非零缓存写入已核实)；ZCode 的缓存包含关系和来源未持久化的 TTL 继续按各自已知边界处理。

## 已封存的模型速度研究

2026-11-01 起，当前运行项目不再提供模型速度，也不读取速度样本、运行采集器、安装客户端插件或配置调试日志。普通用量、费用、RANGE、限额、来源发现/导入、刷新、冻结与历史读取不依赖这些模块。迁移边界见[TPS 退役计划](archive/2026-11-11/plans/2026-11-01-tps-removal-release-plan.md)，独立实现、测试与证据见[研究盒子封存说明](archive/2026-11-01-tps-research.md)。

## 统计范围与限额

普通今日、本周、本月、全部、自定义日期和普通最近范围统计所有已选来源。`5h / week` 限额按钮以及“上一个 5h”“上周”只统计 Codex 来源；边界来自实际限额观察值，缺失时不猜测。

限额能力依据来源 kind 判断，不依据渠道显示名称。项目日志即使把 `channel` 写成 Codex，也不会因此获得 Codex 限额资格。ZCode、DSH、OpenCode、Claude Code 和 WorkBuddy 不参与 Codex 限额窗口。

## 渠道展示与归组

普通范围将 Codex Desktop、Editor Integration、CLI、Codex Exec、codex_work_desktop 归入 Codex，ZCode Subagent 归入 ZCode，DSH Subagent 归入 DSH，OpenCode 保持独立，Claude Code 与 Claude Code Subagent 归入 Claude，WorkBuddy 归入 WorkBuddy。来源 kind/homeId 的证据优先，明确旧标签作兼容回退；未知自定义渠道没有来源证据时保留原名。当前和上一完整 Codex 5h/7d 限额范围保留原渠道。

归组在汇总与时间线展示时完成，不改写事件 channel；计价继续使用原始标签。合并会话按唯一 ID 去重，不直接相加分渠道会话数。内存报告、SQLite 与浏览器纯统计共用 timeline-utils 中的归组规则。

## 增量索引与版本

默认索引位于 `~/.codex-usage/usage-index.sqlite`。JSONL/zstd 的文件元数据参与变化检测，复用还依赖来源凭据与稳定性校验；ZCode/OpenCode 的指纹包含主库和 `-wal`。DSH 按日志文件展开，OpenCode 按数据目录下的多个数据库展开，Claude Code 按 `projects/**/*.jsonl`（含 subagents）展开，WorkBuddy 按 `projects/**/*.jsonl`（跳过 `tool-results/`）展开。

变化来源按已验证的增量条件追加或替换对应事实，未变化来源保留索引；六来源的实际复用范围见[交付说明](15-delivery-upgrade.md#本轮已有改造)。模型元数据按 Codex、ZCode、DSH、OpenCode、Claude、WorkBuddy 分组；项目日志的渠道名称按现有分组规则处理，不改变其限额资格。

应用版本以 `package.json` 为准，索引版本与迁移以 `src/usage-store.js` 的 `STORE_SCHEMA_VERSION` 为准。普通索引升级保留事件、价目、限额、来源状态和历史事实；TPS 表不再被产品维护或查询。来源判定结合现行指纹、WAL、增量凭据和前后稳定性校验，不能仅凭大小／修改时间断言内容未变。升级与恢复操作见[交付说明](15-delivery-upgrade.md)。

## 读取与数据边界

标准事件提取用量和必要元数据，不把 prompt、响应正文、工具参数或密钥作为事件字段。原始文件和 JSON 解析过程中可能包含正文，不能将“输出不含正文”写成“原始正文从不进入内存”。

SQLite 适配器优先只读打开；当前 ZCode/OpenCode 在只读打开失败时会退回普通打开，可能触发 SQLite 恢复或辅助文件操作。应用不主动修改上游业务记录，但不能承诺文件系统层面的绝对零写入。严格对照应使用可靠的一致快照，而不是顺序复制正在写入的 db/WAL 后假定二者一致。

索引和验收日志可能包含模型名、会话元数据与本机路径；分享前检查实际产物。自动价格请求只读取公共来源，不上传本地用量，详见 [11](11-pricing.md)。

## 接线与回归

新增来源要同时核对 `usage-core` 的分类/发现/指纹/事件分派、`usage-store` 的文件展开与元数据、服务器导入标签、前端 harness 分组、非 Codex 限额排除、i18n 和 README。来源测试、索引测试与三路一致测试分别覆盖语义和接线；真实来源 UI 验收独立记录。

### 本地额度来源筛选

5h/7d 的来源判定只读本机 Codex 会话与 `logs_2.sqlite` 中可关联线程的原生诊断，不查询线上账户、不依赖 Magpie、不读取凭据。SQLite 保存脱敏来源状态，静态快照携带相同分类；既有原始用量保持不变。额度周期与趋势口径见[看板说明](12-dashboard.md)。
