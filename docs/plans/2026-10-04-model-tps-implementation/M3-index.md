# M3：首批性能候选索引与发布状态

前置：M1.1 固定字段/API；M3.2 再等 M2.1 ZCode reader。[实施总计划](../2026-10-04-model-tps-implementation-plan.md)规定共享文件所有权。本模块唯一写入者负责 `src/usage-store.js`、`src/perf-sources/index.js`、`test/perf-store.test.js`；**只在临时索引上测试迁移**，不得拿真实用户索引试错。M3 只把 ZCode reader 接到生产链路，DSH/OpenCode 由 M4.5/M4.6 后续注册。

## M3.1 v12 建表、读写编解码

核对当前 `STORE_SCHEMA_VERSION` 与 `PRAGMA user_version`；若别的工作已占 v12，顺延到下一个实际版本，不改写既有迁移。新数据库 `version=0` 的建表路径和旧数据库 `v11→新版本` 迁移都创建相同 `perf_samples STRICT` 表，`sample_key TEXT PRIMARY KEY`、`source_path TEXT NOT NULL REFERENCES source_files(path) ON DELETE CASCADE`。其余列严格照方案 §4；数值字段 `INTEGER` 且未知可为 `NULL`，`sample_flags INTEGER NOT NULL DEFAULT 0`，不建浮点 `tps` 列。约束 `status`、`timing_kind`、`agent_kind` 已知枚举，允许空模型/代理名称而不允许空 sourceKind/homeId。

创建 `perf_samples(source_path)`、`(home_id,ts_ms)`、`(source_kind,home_id,ts_ms)` 索引；读写由单一字段映射表驱动，SQL 参数绑定，不手拼身份。迁移在同一事务里建表、索引并执行**无 WHERE** 的 `UPDATE source_files SET size=-1,mtime_ms=-1;`，使既有所有来源重新提取；`PRAGMA user_version` 用字面目标版本。仅可用测试 fixture 迁移：空库、当前版本、v11、重开库，验证约束和重复迁移无害。迁移失败回滚且不把旧索引视为已升级。

验收：`PRAGMA foreign_keys=ON`；故意写入非法枚举/类型失败；0 与 NULL 往返不同；旧 events/rate-limit 行在迁移前后不丢失。数据库文件在临时目录，测试清理仅删除本测试创建的路径。

## M3.2 `replaceFile` 单文件事务接 ZCode

`src/perf-sources/index.js` 首版仅注册 ZCode；未注册的 DSH/OpenCode/Codex 返回 `not_enabled`，project-log 为 `unsupported`。在现有 `replaceFile()` 的 `BEGIN IMMEDIATE` 内，`insertSource` 后显式 `DELETE FROM perf_samples WHERE source_path=?`，与 events/rate_limit 旧行一并替换；随后运行 ZCode reader 的 `onSample` 并绑定插入。一次 reader 或插入失败要回滚**源文件指纹、events、rate-limit、perf_samples 全部本文件变化**。不要靠 `ON DELETE CASCADE` 处理内容替换，因为 `source_files` 行是 upsert 并未删除。

读上游库时严格只读；沿用 `zcodeSourceStat()` 的主库+WAL 指纹。前后 stat 不同可提交已解析行但状态必须 `degraded` 并重排下一次同步，不能宣称原子源快照。读写索引的数据库与只读上游库是两个句柄；不得把前者的可写属性传给上游。测试分别覆盖替换一次、重复同步不增样本、插入中途失败回滚、只读失败回滚、WAL-only 改动触发重新提取。

## M3.3 范围查询与源删除

新增 `UsageStore.perfCandidatesForRange(range, excludedHomeIds)`，只 SELECT 样本原始列，按稳定 `sample_key` 排序；普通范围用现行 inclusive end，限额有 `windowEndExclusive` 时用 `<`。SQL 限制当前范围/来源，不在 SQL 中计算 TPS、百分位或覆盖率。另取 `ts_ms IS NULL` 的 unplaced 数量/候选供全历史来源诊断；不能把它们塞进当前范围 eligible。对候选表的全列解码与内存 `PerfSample` 完全同形。

同步删除真实已消失的 `source_files` 行时，单文件归属候选由 FK 级联清除；失败 home 的现有保留逻辑仍有效，不把“目录临时不可读”误当删除。测试对比替换与真正删除，验证 deleted home/文件样本不残留；限额范围排除所有非 Codex home，不因 `ZCode` 字样或渠道名混入 Codex 限额窗口。

## M3.4 重建/退化状态与索引测试

在本项目 `store_meta` 保存 `perf_method_version/perf_index_version/perf_indexed_at/perf_state/perf_degraded_home_ids/perf_source_warnings`；后两者为本地 JSON，仅 API 投影编码后的 `sourceKind/homeId/code/count`，不输出路径。`perf_index_version` 在整轮 sync 完成后取已发布来源指纹。开始有变更的 sync 前标 `rebuilding`，此时 `summarizePerf` 的调用者不得把部分候选展示为 ready 排名。所有**已启用**来源成功后标 `ready`；未启用来源单列 `unsupportedSources`，不令其他来源退化。主来源文件不可读、坏帧/坏行致候选不完整时标 `degraded`、保存其 homeId 与编码原因，默认排名只显示未受阻 home，并在 coverage/meta 指明被阻源。可选附加源失败只置软降级 warning：JSONL 自身完整的候选仍可展示，但不得宣称代理/时窗由附加源补齐。旧成功候选可保留在数据库以便失败回滚，但不得悄悄参与当前排名。下一次完整同步成功清除对应退化标记。

`UsageStore.summarize` 与 `createSnapshot` 会在 server 的 `loadUsageStore` 完成后调用；仍测试一次同步期间直接调用 `summarize` 得到 `rebuilding`，不能读到部分已完成排名。快照备份后 `store_meta` 状态、指纹和候选完全同源。测试覆盖新库迁移、失败/恢复、删除、过滤、同一 fixture 双次 sync、source_file 指纹 -1 的重索引。完成模块报告 `M3.md`，附 schema SQL、事务顺序及实际测试命令。
