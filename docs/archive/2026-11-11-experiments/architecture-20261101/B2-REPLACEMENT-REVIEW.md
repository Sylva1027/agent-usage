# B2 S1：UsageReplacementFacts 独立复核

> 历史材料，2026-11-11 归档。本文命令与状态属于原记录日期；源码及恢复方法见[归档入口](../README.md)。

日期：2026-11-03。结论：**当前 replacement stager 与旧
`saveMissingHistoryFacts` 的 ordinary event/quota retention 语义一致，未发现阻断。**

本卡只读生产代码，只新增 `test/usage-source-replacement.test.js` 和本报告。没有修改
`src/usage-store.js`、`test/usage-store.test.js` 或其他 production/owner 文件，没有触碰真实
usage 数据，没有 commit、push、部署或服务重启。实际 G1 OOM 回放仍由 Main 承担；本卡只跑
小样本回归。

## 审查基线

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `src/usage-store.js` | 277,245 | `b5fd6722ffd798a37a0c978774523cab02b2a7f986505af8b843bdb4458ec980` |
| `test/usage-store.test.js`（Main 相关测试） | 150,509 | `f949f9c4dfcdab35c957e508fa4ae0801b076db0d39448656a71cc3bb78420e8` |
| `test/usage-source-replacement.test.js`（本卡新增） | 13,517 | `d3b02cc465463f54855b5e2de1c84c7ecabe9dfc42bc93b7e40357fcb7b98e83` |
| `test/history-retention.test.js`（既有对照） | 53,039 | `96742a6284cc199a78e5d58240e94a1b49c45edcbe860c98cd65be68feb85be4` |

`STORE_SCHEMA_VERSION` 仍是 24，`history_replaced_facts` DDL 未变。本卡没有发现数据库
migration、公共 API 或 schema 变化。

## Diff 范围

此前 `replaceFile` 在 replacement 前把旧 events、旧 rate-limit rows 读成数组，解析完再把
新 rows 读成数组，并调用保留于 cold-revision 路径的 `saveMissingHistoryFacts`。当前 ordinary
replacement 改为：

- `src/usage-store.js:1058-1127`：新增文件私有的 `UsageReplacementFacts`；
- `src/usage-store.js:3530`：每个 `replaceFile` 创建一个 stager；
- `src/usage-store.js:3620-3632`：删除/重解析前逐行 capture 当前 source 及其 zstd sibling
  的 events/rate-limit facts；
- `src/usage-store.js:3760-3802`：新 facts 写完后逐行计算 current multiset，并把 missing
  occurrences 写入 `history_replaced_facts`；
- `src/usage-store.js:3903-3905`：所有成功、异常和 rollback 路径都在 `finally` 关闭 stager。

`saveMissingHistoryFacts` 仍保留在 `src/usage-store.js:1015-1053`，并继续服务 cold revision
effectiveRows 分支（例如 `src/usage-store.js:3737-3744`）。这不是遗漏，本卡没有把它删除。

## 与旧语义逐项对照

| 不变量 | 旧 `saveMissingHistoryFacts` | `UsageReplacementFacts` | 结论 |
| --- | --- | --- | --- |
| canonical payload | 去掉 events 的 `id`，列名排序后 `JSON.stringify` | `src/usage-store.js:1073` 与 `1096` 使用同一 `canonicalFactPayload`，events 排除 `id` | 一致 |
| digest | SHA-256 of canonical JSON | `1083-1097` | 一致 |
| occurrence | `previous count - current count`，保留正差额 | disk row 的 `previous_count-current_count` | 一致 |
| auto id | event `id` 不参与 payload/digest | 两阶段 capture/save 都排除 `id` | 一致 |
| source identity | 旧 `source_files` 行的 kind/home/path/label | 在覆盖 source row 前查询并把 `previousSource` 传给 `save` | 一致 |
| 表隔离 | `fact_table` 区分 events 与 rate-limit | temp PK 与查询均含 `fact_table,source_path,digest` | 一致 |
| 路径隔离 | 每个 source 独立比较 | temp PK 与查询含 `source_path` | 一致 |
| method version | `events.v1` / `rate_limit_observations.v1` | `src/usage-store.js:3761-3802` 保持原常量 | 一致 |
| reason/time | `reparse_replaced`，一次 save 一个 timestamp | `src/usage-store.js:1116-1117` 相同 | 一致 |
| 重复 archive | `ON CONFLICT` 保留最大 occurrence | 复用未变的 `HISTORY_REPLACED_FACT_INSERT_SQL` | 一致 |

旧实现先读旧数组，解析后读新数组，再在内存中做两份 Map 计数。新实现把同一 multiset
关系放在 private temporary SQLite 中，关系本身没有改变。旧 baseline 的 `currentCounts`
会收录新 payload；新实现的 `current_count` 只对旧 payload 加一，另外用标量
`currentCount += 1` 统计当前总行数。missing 关系仍是相同的
`max(previous-current,0)`。

## 内存、临时存储与事务

`src/usage-store.js:1067-1071` 使用 `DatabaseSync("")` 创建 private temporary database：

- `PRAGMA cache_size=-1024`：SQLite 建议页缓存预算为 1 MiB，不是进程内存硬上限；
- `PRAGMA temp_store=FILE`；
- facts table 使用 `WITHOUT ROWID`，每个 distinct multiset entry 一行；
- capture 和 save 都通过 prepared statement + `iterate()` 逐行处理；
- class 内没有事件数组、payload 数组或 JS counts Map；
- 类只保留两个 DatabaseSync 引用和一个标量 current count。

因此 JS 内存不随 event 数线性扩张；临时磁盘空间仍按 distinct canonical payload 数增长，
这是 exact occurrence recovery 所需的持久数据量。这里没有声称整个 SQLite page cache 或
Main 进程内存为常数。

temporary database 没有设置独立 `journal_mode=WAL`。主库原有 `src/usage-store.js:2105`
的 WAL 与 aux facts database 无关。archive insert 使用主库连接，位于
`src/usage-store.js:3612` 开始的同一 `BEGIN IMMEDIATE` 中；aux database 只持有临时
staging transaction，并在 close 时丢弃。

异常路径由 `src/usage-store.js:3896-3905` 先回滚主事务，再在 `finally` close stager。
回归中在第二条 archive insert 触发 `RAISE(ABORT)`，验证第一条 archive row 也消失、
旧 live events 保持、source replacement 未提交；随后 close store、重开数据库删除 trigger、
新 `UsageStore` 实例成功完成同一 replacement。该路径没有观察到 close 异常、锁残留或
half-archive。native `DatabaseSync.close()` 在操作系统级 catastrophic failure 下仍可能抛错；
代码没有额外 catch 并用它替换既有 failure contract，本次不能通过私有类注入该条件。

## 新增回归

`test/usage-source-replacement.test.js` 包含五项：

1. **duplicate auto-id multiset**：两个 canonical payload 完全相同、仅自动 `id` 不同的旧
   events 替换为一条，archive 只有一个 digest、`occurrence_count=1`、payload 无 `id`，
   digest/source identity/method/reason 均精确匹配；
2. **true revision**：旧 payload 被新 payload 替换时，archive 保存旧 canonical payload；
3. **equivalent full replacement**：直接调用计数证明走了 `replaceFile`，相同两行完整
   delete/reinsert 后 archive 仍为空；
4. **event + quota**：Codex event 与 primary/secondary rate-limit observations 同时替换，
   archive 保留 1 条 `events.v1` 和 2 条 `rate_limit_observations.v1`，旧 usage/quota payload
   精确可查；
5. **atomic failure/restart**：第二条 archive insert abort 后 archive 为零、旧 live facts
   不变；close/restart 后重新 sync 成功，两个旧 payload 的 occurrence 各为 1。

## 验证结果

```text
node --test test/usage-source-replacement.test.js
  5 passed, 0 failed, 0 skipped

node --test --test-name-pattern="One hundred ordinary|A failure after history|Reparse retains replaced Codex quota" test/history-retention.test.js
  3 passed, 0 failed

npx.cmd biome check test/usage-source-replacement.test.js
  1 file checked, 0 fixes

npx.cmd tsc --noEmit --allowJs --checkJs --module NodeNext
  --moduleResolution NodeNext --target ES2022 --lib ES2023,DOM
  --types node test/usage-source-replacement.test.js src/usage-store.js
  --pretty false
  passed
```

Main 报告的 70 个相关测试未由本卡独立整批重跑。未执行 G1 的 224/三 append/full-replace
大样本，也未执行历史库备份/capacity 大样本。

## 明确未解决项

- cold revision 的 `effectiveRows` 比较仍走旧
  `saveMissingHistoryFacts`/in-memory maps（`src/usage-store.js:3737-3744`），留作 B3；
- 本卡只证明 ordinary source replacement 的 stager 不保留旧/新 facts 全数组，不宣称
  cold archive union、canonical revision 或 server summary 的全部路径都已经常数内存；
- temporary database 的磁盘规模与 distinct missing payload 数量成正比；
- `close()` 没有吞错或补偿 OS/SQLite native close failure；已验证产品触发失败与重启恢复，
  但没有管理员/故障注入级 disk/native failure 证据。

## 结论

在 reviewed snapshot 上，`UsageReplacementFacts` 保持旧 ordinary replacement retention 的
canonical payload、digest、occurrence count、source identity、method/reason 和 rollback
语义。新增 5 项回归及既有 3 项针对性 archive 回归均通过。没有发现 S1 阻断，也没有发现
公共 API、migration、独立 aux WAL 或普通失败路径连接泄漏。B3 cold-revision 范围保持原状。
