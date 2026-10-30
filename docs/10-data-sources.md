# 数据来源与统计口径

更新：2026-10-31（接收时钟修正，TPS v7）。本文维护共同规则；各来源的字段映射分别见下方专题。

## 来源与导入

- [Codex](data-sources/codex.md)：默认 `~/.codex`，读取会话 `.jsonl` 和 `.jsonl.zst`，并探测本机 JetBrains 集成目录；`CODEX_USAGE_HOMES` 可追加 Codex home。
- [ZCode](data-sources/zcode.md)：默认 `~/.zcode`，依次探测 `cli/db/db.sqlite`、`db/db.sqlite`。
- [DSH](data-sources/dsh.md)：默认 `~/.dsh`，读取 `sessions/<cwd-slug>/<sessionId>/session.v<N>.jsonl.zstd`。
- [OpenCode](data-sources/opencode.md)：探测 `~/.local/share/opencode`、Windows APPDATA/LOCALAPPDATA 和 macOS Application Support 下的目录，再展开目录中的 `opencode*.db`。
- [Claude Code](data-sources/claude-code.md)：默认 `~/.claude`（并发现 `CLAUDE_CONFIG_DIR`），读取 `projects/<cwd>/<sessionId>.jsonl` 与 `projects/<cwd>/<sessionId>/subagents/agent-*.jsonl`，按 `message.id` 去重。
- [WorkBuddy](data-sources/workbuddy.md)：默认 `~/.workbuddy-ai`，读取 `projects/<cwd-slug>/<sessionId>.jsonl`，按 `providerData.messageId` 去重；响应时长另取 `traces/<pid>/trace_*.jsonl` 的 `generation` span。Auto（`model=default-model`）记录整体排除。
- [项目日志](14-project-log.md)：导入包含 `.codex-usage/usage.jsonl` 的项目目录。

看板导入的是 home、数据目录或项目目录，不直接导入单个数据库文件。显式导入目录先按 ZCode、DSH、OpenCode、Claude Code 的具体结构判定，再检查 Codex 和项目日志，避免同名 `sessions` 目录误判（`~/.claude/sessions/` 与 Codex 的 `sessions/` 同名，Claude 必须先判）。

WorkBuddy 的判定必须排在 Claude Code 之前：两者都是 `projects/<cwd-slug>/<sessionId>.jsonl` 结构，只能按内容区分。探测只看最多 3 个会话文件的前 64 KiB，出现 `"type":"session-meta"`、`"type":"function_call"` 或实际 CLI 的 `__codebuddyLocal` 标记即判为 `workbuddy-home`；目录形状相同但内容不符时仍按 Claude Code 判定。

追加来源分别使用 `CODEX_USAGE_ZCODE_HOMES`、`CODEX_USAGE_DSH_HOMES`、`CODEX_USAGE_OPENCODE_HOMES`、`CODEX_USAGE_CLAUDE_HOMES`、`CODEX_USAGE_WORKBUDDY_HOMES`；多个路径使用系统分隔符（Windows `;`，macOS/Linux `:`）。设置 `CODEX_USAGE_ZCODE=0`、`CODEX_USAGE_DSH=0`、`CODEX_USAGE_OPENCODE=0`、`CODEX_USAGE_CLAUDE=0`、`CODEX_USAGE_WORKBUDDY=0` 可关闭对应的自动发现；显式导入是独立路径，不能把这些开关当成禁止导入策略。`CODEX_USAGE_IMPORT_DIRS` 可提供额外导入目录。

## 统一事件口径

标准事件携带时间、会话、来源、渠道、模型、仓库归属、Token 数量和已知明细标记。`total` 保留来源提供的可信总量或来源适配器明确构造的总量；缺失与真正的 0 分开处理。

看板按以下子集关系使用明细：缓存命中属于总输入，推理属于总输出，缓存写入作为独立计价明细记录。来源的原始计数若为并列关系，适配器须先重构；不能用缓存命中输入再次增加总量，也不能把独立推理输出漏出总输出。

`validateUsageDetails()` 校验明细与总量关系；不一致时撤销不可信明细并保留差额标记。费用端随后选择适用估算，见[计价](11-pricing.md)。这不是把缺失数据补零或从正文估算 Token 的许可。

DSH 当前非零缓存写入边界尚待核实，不能把“所有适配器都完整满足输入超集关系”作为已验收事实，见[任务清单](02-tasks.md)。

## 模型生成速度（TPS）

当前方法为 `tps-v7`，`window=request`、`timingKind=generation`。各渠道统一使用本机 `o200k_base` 分词器统计实际正文、拒绝文本、函数参数和自定义工具输入；不包含 reasoning、协议字段、工具名称和工具执行。服务商的原生 token 用量仍供用量、费用与限额统计，不能替代这里的参考 token。

每条完整输出 lane 只编码一次，按最终 UTF-8 token 结束位置分配到生成窗口。传输接收层记录批次时间，起点那一批的全部字节排除；同一接收批次的多个解析事件不产生新间隔。单请求 TPS 为测得 token 总数乘 1000，除以生成窗口毫秒区间的并集。并行 lane 不重复计算时间，思考和工具执行把可见输出划分为不同阶段。只有一个批次时保留用量，没有可测速度；不使用固定减 1、倍率、速度上限或 E2E 回退。

Codex 原生 schema 4、DSH Cordis 插件、WorkBuddy CLI HTTP 接收钩子提供这一观测。采集与保存均在本机，不读取 Magpie 遥测，不改模型路由或认证。DSH usage 没有 reasoning 明细也能直接测量实际可见输出。WorkBuddy Desktop，以及 Claude、OpenCode、ZCode 尚未接入统一分词采集；旧日志不能补出的接收边界不回算。

`summary.perf.models` 按 `[sourceKind, model, reasoningEffort, modelProvider]` 聚合，同 provider 合并 home、渠道与主/子代理，空 provider 保持未知。平均速度为有效请求的 token 总和除以时间总和；p10/p90 是同批逐请求 TPS 的最近秩，n 为请求数。一个有效请求即可显示数值，表格直接按平均 TPS 降序排列，缺测模型置后。数值、样本数和区间条沿用既有 UI。

v1 至 v6 保持历史方法归属，不混入 v7 数值。旧 generation 行保留模型身份；缺少新测量时保留用量和费用。计时晚到、导入导出、冻结、缓存和冷归档均绑定方法版本。Codex 冷修订同时保存按 sample/source/home 绑定的标量测量，恢复时核对原始请求身份和窗口，不把可变热库当作冷归档证据。

Q2 静态用量缓存继续复用，Q3 同步 reader 读取自身快照。请求局部缺测不淘汰其它有效请求；来源改写、身份冲突和归属发布规则继续生效。内部 coverage 与来源诊断不新增到 UI。验收与部署状态见[本地实际输出速度采集](validation/2026-10-31-receive-clock-tps/README.md)。

### 本地采集安装

先将 Agent Usage release 解压到固定目录。发布的 ZIP/TAR.GZ 包含 tiktoken；从 Git clone 或 GitHub 自动源码包安装时，先执行 `npm ci --omit=dev`（Windows PowerShell 7 使用 `npm.cmd`）。采集器运行后新增的标量观测随正常同步进入看板。

**Codex（Windows）**：下载同一 release 中的完整 Codex 采集包并解压；保留整个目录，不只复制 codex.exe。先正常退出 Desktop，再从 Agent Usage 目录运行：

```powershell
pwsh -NoProfile -File scripts/start-codex-generation.ps1 desktop -PackageRoot 'C:\Tools\codex-generation'
```

将示例路径换成包含 `codex-generation-manifest.json`、`bin`、`codex-resources` 和 `codex-path` 的实际目录。启动器校验完整包及实际子进程引擎；不会覆盖官方安装或全局 CLI。命令行使用 `cli -PackageRoot <目录> -- <正常 Codex 参数>`。启动器仅对本次启动设置引擎路径，之后仍通过该启动器进入；不会自动关闭正在运行的 Desktop。

**DSH**：在 Agent Usage 固定目录运行以下命令，然后正常启动 DSH。已有 Cordis patch 会备份并保留，重复执行只更新本插件条目。

```bash
node scripts/install-dsh-output-capture.mjs
```

非默认 home 可传 `--home <DSH home>`。插件在会话文件旁保存 `.generation-timing.jsonl`，以提交的本地 message ID、session、model/provider 精确关联，不额外保存正文。

**WorkBuddy CLI（Windows）**：将 `-CliEntry` 替换为实际安装目录中的 `resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs`，通过以下入口运行正常 CLI 参数：

```powershell
pwsh -NoProfile -File scripts/start-workbuddy-output-capture.ps1 -CliEntry 'C:\Tools\WorkBuddyAI\resources\app.asar.unpacked\cli\dist\codebuddy-lite-wb.mjs' -- <正常 CLI 参数>
```

可用 `-CaptureHome` 指定实际 WorkBuddy home；默认 `~/.workbuddy-ai`。观测按会话保存于 `generation-timing/<session哈希>.jsonl`。该入口覆盖 CLI 的 Node HTTP 流，当前要求未压缩传输；WorkBuddy Desktop 仍待接入。

## 统计范围与限额

普通今日、本周、本月、全部、自定义日期和普通最近范围统计所有已选来源。`5h / week` 限额按钮以及“上一个 5h”“上周”只统计 Codex 来源；边界来自实际限额观察值，缺失时不猜测。

限额能力依据来源 kind 判断，不依据渠道显示名称。项目日志即使把 `channel` 写成 Codex，也不会因此获得 Codex 限额资格。ZCode、DSH、OpenCode、Claude Code 和 WorkBuddy 不参与 Codex 限额窗口。

## 渠道展示与归组

普通范围将 Codex Desktop、Editor Integration、CLI、Codex Exec、codex_work_desktop 归入 Codex，ZCode Subagent 归入 ZCode，DSH Subagent 归入 DSH，OpenCode 保持独立，Claude Code 与 Claude Code Subagent 归入 Claude，WorkBuddy 归入 WorkBuddy。来源 kind/homeId 的证据优先，明确旧标签作兼容回退；未知自定义渠道没有来源证据时保留原名。当前和上一完整 Codex 5h/7d 限额范围保留原渠道。

归组在汇总与时间线展示时完成，不改写事件 channel；计价继续使用原始标签。合并会话按唯一 ID 去重，不直接相加分渠道会话数。内存报告、SQLite 与浏览器纯统计共用 timeline-utils 中的归组规则。

## 增量索引与版本

默认索引位于 `~/.codex-usage/usage-index.sqlite`。JSONL/zstd 按文件大小和修改时间检测变化；ZCode/OpenCode 的指纹包含主库和 `-wal`。DSH 按日志文件展开，OpenCode 按数据目录下的多个数据库展开，Claude Code 按 `projects/**/*.jsonl`（含 subagents）展开，WorkBuddy 按 `projects/**/*.jsonl`（跳过 `tool-results/`）展开。

变化来源通过 `replaceFile` 替换对应事件，未变化来源保留索引。模型元数据按 Codex、ZCode、DSH、OpenCode、Claude、WorkBuddy 分组；项目日志的渠道名称按现有分组规则处理，不改变其限额资格。

WorkBuddy 的计时是独立输入：普通 `sync` 每轮对每个启用 home 预扫 trace，复用未变化文件的进程内指纹，把新 distinct duration 写入 home-scoped observation 表，并定位受影响会话重建。预扫发生在 `replaceFile` 事务之外，不把 `await` 拉进写事务。trace 集合与已解析计时参与 memory/store 性能版本及读取稳定性检查；删除 trace 不遗忘已知时长或冲突。

当前 `STORE_SCHEMA_VERSION` 为 23，Codex 投影版本为 v8，摘要缓存版本为 5。升级保留旧行和依赖，通过正常重解析接入新测量；无需手动删除索引。新运行包已在真实索引副本核对用量和费用一致，正式采用状态见[本轮部署验收](validation/2026-10-31-receive-clock-tps/README.md)。

## 读取与数据边界

标准事件提取用量和必要元数据，不把 prompt、响应正文、工具参数或密钥作为事件字段。原始文件和 JSON 解析过程中可能包含正文，不能将“输出不含正文”写成“原始正文从不进入内存”。

SQLite 适配器优先只读打开；当前 ZCode/OpenCode 在只读打开失败时会退回普通打开，可能触发 SQLite 恢复或辅助文件操作。应用不主动修改上游业务记录，但不能承诺文件系统层面的绝对零写入。严格对照应使用可靠的一致快照，而不是顺序复制正在写入的 db/WAL 后假定二者一致。

上述回退属于普通用量 reader。新增 TPS 的 ZCode/OpenCode reader 严格只读，打开失败即报告错误，不回退可写连接，并在 SQL 中只投影性能所需标量；不能把普通用量 reader 的限制或保证套到性能路径。真实来源验收绑定完整冻结副本与 source-start 清单，逐文件采集不等于 live 目录的原子时刻；未来来源变化仍触发 `LIVE_SOURCE_CHANGED` 并拒绝发布。

索引和验收日志可能包含模型名、会话元数据与本机路径；分享前检查实际产物。自动价格请求只读取公共来源，不上传本地用量，详见 [11](11-pricing.md)。

## 接线与回归

新增来源要同时核对 `usage-core` 的分类/发现/指纹/事件分派、`usage-store` 的文件展开与元数据、服务器导入标签、前端 harness 分组、非 Codex 限额排除、i18n 和 README。来源测试、索引测试与三路一致测试分别覆盖语义和接线；真实来源 UI 验收独立记录。

### 本地额度来源筛选

5h/7d 的来源判定只读本机 Codex 会话与 `logs_2.sqlite` 中可关联线程的原生诊断，不查询线上账户、不依赖 Magpie、不读取凭据。SQLite 保存脱敏来源状态，静态快照携带相同分类；既有原始用量保持不变。额度周期与趋势口径见[看板说明](12-dashboard.md)。
