# 数据来源与统计口径

更新：2026-10-01。本文维护共同规则；各来源的字段映射分别见下方专题。

## 来源与导入

- [Codex](data-sources/codex.md)：默认 `~/.codex`，读取会话 JSONL，并探测本机 JetBrains 集成目录；`CODEX_USAGE_HOMES` 可追加 Codex home。
- [ZCode](data-sources/zcode.md)：默认 `~/.zcode`，依次探测 `cli/db/db.sqlite`、`db/db.sqlite`。
- [DSH](data-sources/dsh.md)：默认 `~/.dsh`，读取 `sessions/<cwd-slug>/<sessionId>/session.v<N>.jsonl.zstd`。
- [OpenCode](data-sources/opencode.md)：探测 `~/.local/share/opencode`、Windows APPDATA/LOCALAPPDATA 和 macOS Application Support 下的目录，再展开目录中的 `opencode*.db`。
- [项目日志](14-project-log.md)：导入包含 `.codex-usage/usage.jsonl` 的项目目录。

看板导入的是 home、数据目录或项目目录，不直接导入单个数据库文件。显式导入目录先按 ZCode、DSH、OpenCode 的具体结构判定，再检查 Codex 和项目日志，避免同名 `sessions` 目录误判。

追加来源分别使用 `CODEX_USAGE_ZCODE_HOMES`、`CODEX_USAGE_DSH_HOMES`、`CODEX_USAGE_OPENCODE_HOMES`；多个路径使用系统分隔符（Windows `;`，macOS/Linux `:`）。设置 `CODEX_USAGE_ZCODE=0`、`CODEX_USAGE_DSH=0`、`CODEX_USAGE_OPENCODE=0` 可关闭对应的自动发现；显式导入是独立路径，不能把这些开关当成禁止导入策略。`CODEX_USAGE_IMPORT_DIRS` 可提供额外导入目录。

## 统一事件口径

标准事件携带时间、会话、来源、渠道、模型、仓库归属、Token 数量和已知明细标记。`total` 保留来源提供的可信总量或来源适配器明确构造的总量；缺失与真正的 0 分开处理。

看板按以下子集关系使用明细：缓存命中属于总输入，推理属于总输出，缓存写入作为独立计价明细记录。来源的原始计数若为并列关系，适配器须先重构；不能用缓存命中输入再次增加总量，也不能把独立推理输出漏出总输出。

`validateUsageDetails()` 校验明细与总量关系；不一致时撤销不可信明细并保留差额标记。费用端随后选择适用估算，见[计价](11-pricing.md)。这不是把缺失数据补零或从正文估算 Token 的许可。

DSH 当前非零缓存写入边界尚待核实，不能把“所有适配器都完整满足输入超集关系”作为已验收事实，见[任务清单](02-tasks.md)。

## 统计范围与限额

普通今日、本周、本月、全部、自定义日期和普通最近范围统计所有已选来源。`5h / week` 限额按钮以及“上一个 5h”“上周”只统计 Codex 来源；边界来自实际限额观察值，缺失时不猜测。

限额能力依据来源 kind 判断，不依据渠道显示名称。项目日志即使把 `channel` 写成 Codex，也不会因此获得 Codex 限额资格。ZCode、DSH 和 OpenCode 不参与 Codex 限额窗口。

## 渠道展示与归组

普通范围将 Codex Desktop、Editor Integration、CLI、Codex Exec、codex_work_desktop 归入 Codex，ZCode Subagent 归入 ZCode，DSH Subagent 归入 DSH，OpenCode 保持独立。来源 kind/homeId 的证据优先，明确旧标签作兼容回退；未知自定义渠道没有来源证据时保留原名。当前和上一完整 Codex 5h/7d 限额范围保留原渠道。

归组在汇总与时间线展示时完成，不改写事件 channel；计价继续使用原始标签。合并会话按唯一 ID 去重，不直接相加分渠道会话数。内存报告、SQLite 与静态重算共用 timeline-utils 中的归组规则。

## 增量索引与版本

默认索引位于 `~/.codex-usage/usage-index.sqlite`。JSONL/zstd 按文件大小和修改时间检测变化；ZCode/OpenCode 的指纹包含主库和 `-wal`。DSH 按日志文件展开，OpenCode 按数据目录下的多个数据库展开。

变化来源通过 `replaceFile` 替换对应事件，未变化来源保留索引。模型元数据按 Codex、ZCode、DSH、OpenCode 分组；项目日志的渠道名称按现有分组规则处理，不改变其限额资格。

当前 `STORE_SCHEMA_VERSION` 为 10。8→9 引入 DSH、9→10 引入 OpenCode 时表结构均未改变；7→8 仍保留历史重新索引逻辑。未来迁移应使用固定落点并验证相邻版本升级，详见[维护候选](02-tasks.md#sqlite-迁移落点维护候选)。升级代码不要求手动删除真实索引或改写原始日志。

## 读取与数据边界

标准事件提取用量和必要元数据，不把 prompt、响应正文、工具参数或密钥作为事件字段。原始文件和 JSON 解析过程中可能包含正文，不能将“输出不含正文”写成“原始正文从不进入内存”。

SQLite 适配器优先只读打开；当前 ZCode/OpenCode 在只读打开失败时会退回普通打开，可能触发 SQLite 恢复或辅助文件操作。应用不主动修改上游业务记录，但不能承诺文件系统层面的绝对零写入。严格对照应使用可靠的一致快照，而不是顺序复制正在写入的 db/WAL 后假定二者一致。

索引、静态 HTML 和验收日志可能包含模型名、会话元数据与本机路径；分享前检查实际产物。自动价格请求只读取公共来源，不上传本地用量，详见 [11](11-pricing.md)。

## 接线与回归

新增来源要同时核对 `usage-core` 的分类/发现/指纹/事件分派、`usage-store` 的文件展开与元数据、服务器导入标签、前端 harness 分组、非 Codex 限额排除、i18n 和 README。来源测试、索引测试与三路一致测试分别覆盖语义和接线；真实来源 UI 验收独立记录。
