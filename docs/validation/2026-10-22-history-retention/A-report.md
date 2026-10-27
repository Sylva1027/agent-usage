# A0.1 / A0.2a-d / A1a-1 / A1a-2 / A-schema20 / A-schema21 / A-cli21-contract / A-wire-tier / A-snapshot-barrier / I-full-wire / A-close-drain / I-full-carrier-wire / I-full-quota-wire / A-freeze-price-oracle / A-freeze-price-transfer / A-freeze-tier-HTTP-oracle / A1c-price / A1b-gap / A1b-serialize / A1b-package / A-context / A-CLI-verify / A-restore-package / A-CLI-restore / A-CLI-backup / A-backup-schema19 / A2-dryrun / A2-CLI-dryrun / A2-candidate-events / A2-candidate-verify / A2-source-match / A2-source-context / A2-candidate-portable / A2-candidate-registry-guard / A-bundle-inventory / A-bundle-stage-segments / A-bundle-stage-main / A-bundle-context / A-bundle-verify / A-bundle-publish / A-published-gate / A2-candidate-failure / A-live-backup / A-barrier-error / A-CLI-export / A-import-stage / A-import-runtime / A-CLI-import / A-import-open-gate / A-import-bundle-containment / A-archive-status-API / A-cold-full-API / A-complete-import-executor / A-import-http-faults / A-archive-adjacent-year-bands / A-sealed-event-page / A-import-instance-frozen-cost 报告：WAL 生命周期、备份发布与恢复证据

日期：2026-10-22。状态：**A0.1、A0.2a、A0.2b、A0.2c、A1a-1、A1a-2、A0.2d、A-schema20、A1c-price、A1b-serialize、A1b-package、A-context、A-CLI-verify、A-restore-package、A-CLI-restore、A-CLI-backup、A-backup-schema19、A2-dryrun、A2-CLI-dryrun、A2-candidate-events、A2-candidate-verify、A2-source-match、A2-source-context、A2-candidate-failure、A-live-backup 已接受；A1b-gap、A-barrier-error、A-schema21、A-cli21-contract、A-wire-tier 已接受；A-snapshot-barrier、I-full-wire、A-close-drain、I-full-carrier-wire、I-full-quota-wire、A-freeze-price-oracle、A-freeze-price-transfer 已接受；A-bundle-stage-main 已接受，但只覆盖数据库与 registry 同快照 draft；A-bundle-context 已接受，只覆盖调用入口 catalog/tier carrier；A-freeze-tier-HTTP-oracle、A2-candidate-portable、A2-candidate-registry-guard、A-bundle-inventory、A-bundle-stage-segments 已实现，待主审复核；A-bundle-verify、A-bundle-publish 已接受；A-published-gate 已接受；A-CLI-export 已接受；A-import-stage 已接受；A-import-runtime 已接受；A-CLI-import 已接受；A-import-open-gate、A-import-bundle-containment 已接受；A-archive-status-API 已接受；A-cold-full-API 已实现，待主审复核**。A0.2a 只验收“备份含尚未 checkpoint 的已提交 WAL 数据，且新进程能读到该数据”；A0.2b 只验收“备份/恢复目标不可覆盖，且只清理本次创建的最终文件”；A0.2c 只验收“数据库字节变化且 manifest 未变时按外置摘要拒绝”；A1a-1 只验收程序版本和方法版本不再维护硬编码副本；A1a-2 只验收 backup 创建进程的当前有效价目被完整写入 manifest 且可校验摘要；A0.2d 只验收最终单文件用同目录硬链接原子可见；A-schema20 只验收真实 store schema 20 与 `history_replaced_facts` 的备份/校验/恢复可见性；A1c-price 只验收显式加载 manifest 价目后，原 store 与恢复库上同一业务 summary 的金额、币种和计价记录数一致；A1b-gap 只提供当前缺口反例：备份包不带外部 `logs_2.sqlite`，原 home 不可用后恢复库的同一 summary 失去 priority 计价；A1b-serialize 只提供 tier 证据的 JSON 快照与等价 resolver 接缝；A1b-package 只在调用方显式传入 resolver 时把该快照与摘要写入 manifest，并由 verify 校验，不自动加载；A-context 只把 verify 后的价目与 resolver 暴露给调用方，不激活全局或 store 状态；A-CLI-verify 只新增离线验证命令与简要输出，不包含 create/restore；A-restore-package 让恢复产物同时带数据库和改写目标文件名的已验 manifest，不自动激活；A-CLI-restore 只新增离线恢复命令，不覆盖目标、不激活价目、不切换或重启服务；A-CLI-backup 只新增离线 create 命令，复用只读 SQLite backup 与既有价目入口，tier 明确未捕获；A-backup-schema19 只让离线 backup/verify/restore 保持源 schema 19，并继续支持 schema 20 与拒绝未知版本；A2-dryrun 只计算归档候选与原因，不生成、删除、登记或迁移任何数据；A2-CLI-dryrun 只把该计算接到严格 `--dry-run` 命令并打印结果，不执行归档；A2-candidate-events 只创建带范围过滤和 `unregistered` 元数据的候选包，不登记、不参与统计、不改主库、不接 CLI；A2-candidate-verify 只在普通 backup verify 之后再核对候选范围、events 指纹与引用 source 身份，不写登记或删除；A2-source-match 只核对源当前范围内事件集合、引用 source 身份与已验候选指纹，不删除、登记或替代证据 revision；A2-source-context 只把范围内 events 引用的 source 身份纳入完整性证明，不扩 perf/timing/WorkBuddy 所有权；A2-candidate-portable 只证明一次恢复后删除原候选目录、由新进程重新验证并读取 evidence，不登记、不激活、不迁移热数据；A2-candidate-registry-guard 只在入口拒绝非空 `archive_segments`，不打包外部段、不解除门禁；A-bundle-inventory 只验证已有登记段清单并拒绝缺文件/篡改/目录不符，不复制文件、不解除 backup 门禁；A-bundle-stage-segments 只把已验证登记段复制到新建 staging 目录并返回相对路径，不复制主库、不改 registry、不解除 backup 门禁；A-bundle-stage-main 只从单个私有快照组合 hot 主库与已验证段 draft 并写相对 manifest，不发布、不导入、不改 live registry；A-bundle-context 只冻结 bundle 调用入口的价目 catalog 与 tier snapshot 载体，不新增 bundle verify、发布或导入；A-bundle-verify 只读校验 format 1 draft 的严格清单、包内路径、main registry 空、段摘要/范围/计数与无重叠，不发布、导入或激活；A2-candidate-failure 只用一次 SQLite ABORT 证明候选构建失败时不产生最终文件并清理私有副本，不证明进程崩溃或断电恢复；A-live-backup 只把现有 `createHistoryBackup()` 接入执行器消息和客户端，使用 worker 实际 tier resolver，并仅对 `sync`/`backupHistory` 使用共享串行尾链，不新增 CLI/server 路由、全局读请求串行队列或原始日志复制；A-barrier-error 只证明一次真实目标碰撞的 backup 失败不会阻塞已排队 sync，后续新目标 backup 仍可成功并读取新事实；A-archive-status-API 只新增一个 GET 轻量登记/文件状态读取，不读段内 events/sha、不触发 sync、不提供导入写或任意查询路径。备份包整体保真、CLI 全功能、外部 tier 保全、全 schema 和归档发布契约均不在这些短卡范围。I-full-wire 只接执行器消息与 client 并加入现有串行尾链，不实现或绕过 store 读方法。

A-schema21 状态：**已接受**。只把 schema 21 的**空** `archive_segments` 目录纳入 backup/verify/restore；非空目录明确拒绝，不打包外部段文件。A-cli21-contract 状态：**已接受**。A-wire-tier 状态：**已接受（串行传输）**。A-snapshot-barrier、I-full-wire、A-close-drain、I-full-carrier-wire、I-full-quota-wire、A-freeze-price-oracle、A-freeze-price-transfer、A-bundle-stage-main、A-bundle-context、A-bundle-verify、A-bundle-publish 状态：**已接受**；其中 A-bundle-stage-main 只代表数据库与 registry 同快照 draft，A-bundle-context 只代表入口 catalog/tier carrier，A-bundle-verify 只代表只读校验 draft，A-bundle-publish 只代表验证后写排他 marker，不声明原子目录发布。A-freeze-tier-HTTP-oracle 状态：**已实现，待主审复核**；A-published-gate 状态：**已接受**；A-CLI-export 状态：**已接受**；A-import-stage 状态：**已接受**；A-import-runtime 状态：**已接受**；A-CLI-import 状态：**已接受**；A-import-open-gate、A-import-bundle-containment 状态：**已接受**；A-archive-status-API 状态：**已接受**；A-cold-full-API 状态：**已实现，待主审复核**；A-complete-import-executor 状态：**已接受**；A-import-http-faults 状态：**已接受**；A-archive-adjacent-year-bands 状态：**已接受（仅归组行为）**。

A-sealed-event-page 状态：**已实现，待主审复核**。store 只新增封印段 keyset 分页读接缝；executor/server/HTTP 接线由主审完成并已定向验证。A-import-instance-frozen-cost 状态：**已实现，待主审复核**；导入实例使用 bundle 的价目与 tier 证据，普通实例仍使用自身价目。

I-full-wire、A-close-drain、I-full-carrier-wire、I-full-quota-wire、A-freeze-price-oracle、A-freeze-price-transfer、A-bundle-stage-main、A-bundle-context、A-bundle-verify、A-bundle-publish 状态：**已接受**。A-freeze-tier-HTTP-oracle 状态：**已实现，待主审复核**；A-published-gate 状态：**已接受**；A-CLI-export 状态：**已接受**；A-import-stage 状态：**已接受**；A-import-runtime 状态：**已接受**；A-CLI-import 状态：**已接受**；A-import-open-gate、A-import-bundle-containment 状态：**已接受**；A-archive-status-API 状态：**已接受**；A-cold-full-API 状态：**已实现，待主审复核**。

## 结论

- 每轮 `sync` 的 `finally` 先关闭已发布 reader，再执行 `wal_checkpoint(TRUNCATE)`；首轮没有 reader 时同样执行。
- checkpoint 前临时把 `busy_timeout` 设为 0，结束后恢复原值。外部读者持锁时立即返回 `busy=1`，不忙等。
- checkpoint 的任何 SQLite 或恢复超时错误都只写入诊断，不会改变原 `sync` 的成败或错误。
- 成功 sync 随完整 state 发布 `lastCheckpoint`。失败 sync 只额外发布 `{ lastCheckpoint }` 的局部 state，主线程按既有合并语义保留上一份完整快照，因此该路径不会调用 `store.metadata()`，也不会用诊断错误覆盖原 sync 错误。
- 连续三轮有写入的临时库在每轮结束后 WAL 均为 0 字节；外部读者释放后，下一轮恢复 `busy=0` 并再次把 WAL 截到 0。
- backup 继续支持真实 schema 19/20；schema 21 必须含 `archive_segments`。manifest 记录数据库实际的 `PRAGMA user_version`，空目录进入表指纹，非空目录返回 `HISTORY_BACKUP_ARCHIVES_UNSUPPORTED`。

## 实际改动与调用方

| 文件 | 改动 |
| --- | --- |
| `src/usage-executor.js:109` | 新增 `checkpointUsageStore(database)`：零等待 TRUNCATE、恢复 `busy_timeout`、返回诊断对象，永不抛出。 |
| `src/usage-executor.js:197` | 新增失败路径的局部 state 发布；发布失败也被吞掉，以保留原异常。 |
| `src/usage-executor.js:205` | 抽出 `releasePublishedReader()`，先 `ROLLBACK` 再 `close`，并返回清理错误。 |
| `src/usage-executor.js:247` | sync 改为显式捕获原异常；无论成功或异常都先释放 reader、再 checkpoint。成功才更新 `storeStatus` 和发布完整 state。 |
| `src/usage-executor.js:549` | 客户端新增 `executor.lastCheckpoint` 只读访问器。 |
| `test/history-wal.test.js` | 7 项 WAL 定向测试，覆盖首轮、三轮收敛、外部读者、dashboard 快照、checkpoint 异常隔离、非 WAL 恢复超时、真实 worker 异常注入。 |

调用方只有执行器的 `sync` 消息处理路径和 `createUsageExecutor()` 客户端；没有修改 `src/usage-store.js`，也没有改变 HTTP、CLI 或数据库 schema。

## 诊断形状

```json
{
  "mode": "truncate",
  "busy": 0,
  "log": 0,
  "checkpointed": 0,
  "elapsedMs": 0.985,
  "error": null
}
```

- `busy=1`：仍有读者阻止 TRUNCATE；本次不等待、不重试。
- `log=-1`、`checkpointed=-1`：连接不在 WAL 模式，checkpoint 为 no-op。
- `error.stage="checkpoint"`：读取 timeout、执行 checkpoint 或结果解析失败。
- `error.stage="restore-busy-timeout"`：`busy_timeout` 未能恢复；若已有 checkpoint 错误，后者另放 `restoreError`。
- `elapsedMs` 是单个 checkpoint 调用的墙钟时间，按 0.001 ms 取整。

失败 sync 的消息顺序仍是：局部 checkpoint state → 原 `sync` 错误 response。主线程不会因局部 state 丢掉此前的 `metadata/status/homes`。

## 实际验证

```text
node --check src/usage-executor.js
exit 0

node --check src/history-backup.js
exit 0

node --test test/history-wal.test.js
exit 0; 7 tests, 7 pass; duration 5780.9147 ms

node --test --test-concurrency=1 test/w1-executor.test.js test/usage-sync-retry.test.js test/w3-fault.test.js
exit 0; 26 tests, 26 pass; duration 24063.3916 ms

npm.cmd run typecheck
exit 0

npx.cmd --no-install biome check --formatter-enabled=false src/usage-executor.js src/history-backup.js test/history-wal.test.js
exit 0; 3 files checked

npx.cmd --no-install biome format src/usage-executor.js src/history-backup.js test/history-wal.test.js
exit 0; 3 files checked
```

失败注入测试使用测试自己的 worker preload：先 import `UsageStore` 并猴补 `UsageStore.prototype.sync` 抛 `INJECTED_SYNC`，再由 worker 动态导入 `usage-executor.js`。断言同时确认：

- 客户端收到的仍是原 `INJECTED_SYNC` 错误；
- 失败后仍收到 `lastCheckpoint` 诊断；
- 该次 checkpoint 自身也失败时，`checkpoint.error.stage="checkpoint"`，没有遮蔽原异常。

开发过程中有两个非产品失败：初次 `npm.cmd run typecheck` 因 A0.2 草稿的 tuple 推断报 1 个类型错误，补最小 JSDoc 类型后通过；初次 `biome format` 检查因 A0.2 草稿的既有排版报 1 个格式错误，按要求格式化 A-owned 三文件后通过。

### checkpoint 直测

使用临时 SQLite 和真实 `checkpointUsageStore`，不打开生产库：

| 场景 | WAL 前值 | busy | log | checkpointed | elapsedMs | WAL 后值 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 正常 TRUNCATE | 4,152 B | 0 | 0 | 0 | 1.005 | 0 B |
| 外部 read transaction 持锁 | 4,152 B | 1 | 1 | 0 | 0.033 | 未截断 |
| 读者释放后恢复 | 4,152 B | 0 | 0 | 0 | 0.962 | 0 B |
| 非 WAL 内存库 | - | 0 | -1 | -1 | 0.037 | - |

非 WAL 用例另确认原 `busy_timeout=4321` 被恢复。外部读者用例的整个 sync 测试项为 185.0654 ms，且断言 `<1000 ms`；上表的 0.033 ms 才是隔离后的 checkpoint 调用时间。

## 请求 B 的最小接缝

在 `src/usage-store.js` 的 `UsageStore.open()` 中，把下面一行恰好放在现有 `PRAGMA journal_mode = WAL;` 之后：

```sql
PRAGMA journal_size_limit = 67108864;
```

B 已把该 pragma 接到 `UsageStore.open()`（`src/usage-store.js:2345`）。A0.1 仍靠正确时点的 TRUNCATE 收敛 WAL；连接级大小上限已接线，本轮未单独验证真实大库下的稳态文件大小。

## A0.2a：未 checkpoint 提交的备份

现有测试夹具在 `test/history-backup.test.js:124` 设置 WAL 和 `wal_autocheckpoint=0`，写入后保持源连接打开。定向测试随后断言：

- `journal_mode=wal`、`wal_autocheckpoint=0`，且源 `-wal` 文件非空（`test/history-backup.test.js:171`-`173`）；
- `createHistoryBackup()` 内部调用 `node:sqlite` 的 `backup()`（`src/history-backup.js:174`）；
- 备份文件经 `journal_mode=DELETE` 归一化后（`src/history-backup.js:139`），由独立 Node 子进程只读打开并查询到已提交的 `events.total=7`（`test/history-backup.test.js:195`-`205`）。

最小命令和结果：

```text
node --test --test-name-pattern="backup includes committed WAL rows" test/history-backup.test.js
exit 0; 1 test, 1 pass; test duration 108.485 ms; runner duration 177.8715 ms
```

本卡只运行这一项定向测试；未新增测试框架，未改 `src/usage-executor.js`，未跑全仓测试，也未验收备份包整体保真。

硬编码的 `programVersion`、`perfMethodVersion`、`pricingVersion`、`pricingCheckedAt` 仍位于 `src/history-backup.js:8`-`11`，属于后续待修项。本卡不声称这些版本字段、manifest 全字段或 restore 包已经保真。

## A0.2b：排他发布与自有半成品清理

A0.2b 的历史实现让所有最终文件复制经过同一个 `publishFile()` 接点，并使用 `fs.constants.COPYFILE_EXCL`。A0.2d 已把这个接点改为同目录 `link(source, destination)`（`src/history-backup.js:148`）；`EEXIST` 仍映射为 `HISTORY_BACKUP_DESTINATION_EXISTS`，不再依赖先查后写。

- `createHistoryBackup()` 分别用 `link()` 排他发布数据库和 manifest（`src/history-backup.js:214`、`216`）。中途失败只删除本次已创建成功的数据库/manifest，已有外部 manifest 和其内容不受影响。
- `restoreHistoryBackup()` 仍用 `COPYFILE_EXCL` 创建临时副本（`src/history-backup.js:354`），最终文件改走同一个 `link()` 接点（`src/history-backup.js:369`）。仅当最终目标由本次成功创建时才删除它。
- 原先 `exists()` 先查后 `copyFile(..., 0)` 的覆盖窗口已删除；当前最终发布没有非排他复制，也没有 `rename` 或非原子 fallback。

定向测试及结果：

```text
node --test --test-name-pattern="exclusive publication|restore refuses" test/history-backup.test.js
exit 0; 2 tests, 2 pass; tests 65.3167 ms + 53.2403 ms; runner duration 185.9919 ms
```

- `test/history-backup.test.js:600`：已有目标内容和已有 manifest 内容保持不变；数据库发布成功但 manifest 冲突时，只清理本次创建的数据库；无临时文件残留。
- `test/history-backup.test.js:630`：restore 遇到已有目标时返回 `HISTORY_BACKUP_DESTINATION_EXISTS`，目标内容不变，临时副本被清理。

本卡未修改 `src/usage-executor.js`，未扩展 CLI 或版本/metadata 字段，未运行全仓测试。

## A0.2c：数据库字节篡改拒绝

复核已有 `verifyHistoryBackup()`：数据库读入后先比对 manifest 的字节数，再比对 SHA-256；摘要不符时在打开数据库前返回 `HISTORY_BACKUP_DIGEST_MISMATCH`（`src/history-backup.js:276`-`282`）。

现有测试已覆盖 manifest 自身摘要被改、缺表和未知 schema。本次在 `test/history-backup.test.js:668` 补了一个数据库字节篡改反例：

- 正常备份数据库中找到唯一的 ASCII 输入 `schema20`，把首字节改为 `X`，得到同长度内容 `Xchema20`；
- manifest 保持完全不变；
- 用 `DatabaseSync(..., { readOnly: true })` 查询 `store_meta.fixture` 得到 `Xchema20`，证明文件仍是可正常读取的 SQLite；
- `verifyHistoryBackup()` 仍必须抛出 `HISTORY_BACKUP_DIGEST_MISMATCH`。

最小命令和结果：

```text
node --test --test-name-pattern="verification rejects" test/history-backup.test.js
exit 0; 1 test, 1 pass; test duration 93.9442 ms; runner duration 166.7818 ms
```

本卡未改生产代码、metadata、CLI 或测试框架；只修改了 `test/history-backup.test.js` 和本报告。

## A1a-1：程序版本与方法版本来源

- `programVersion` 在模块加载时读取 `package.json` 的现有 `version` 字段（`src/history-backup.js:2`、`13`），manifest 使用 `PROGRAM_VERSION`（`src/history-backup.js:195`）。
- `perfMethodVersion` 直接复用 `src/perf-stats.js:17` 导出的 `PERF_METHOD_VERSION`（`src/history-backup.js:6`、`196`）；原先的本地硬编码常量已删除。
- 测试同时读取真实的 `package.json` 和 `PERF_METHOD_VERSION`，用一个 `assert.deepEqual` 校验 manifest 两个字段（`test/history-backup.test.js:177`-`180`）。

实际运行整个备份测试文件：

```text
node --test test/history-backup.test.js
exit 0; 6 tests, 6 pass; duration 474.1738 ms
```

A1a-1 本卡未修改 schema 常量、metadata、CLI 或 store；定价硬编码字段留给下一短卡 A1a-2。

## A1a-2：创建进程当前有效价目快照

- `createHistoryBackup()` 在调用开始捕获一次 `getPricingCatalog()`（`src/history-backup.js:165`），后续异步备份和 manifest 写入都使用这一个快照。
- manifest 顶层 `pricingVersion`、`pricingCheckedAt` 取自快照；完整 catalog（`checkedAt/version/usdToCnyRate/source/models`）及其 SHA-256 写入 `pricing.catalog` / `pricing.sha256`（`src/history-backup.js:197`-`202`）。
- 本地硬编码的 `HISTORY_BACKUP_PRICING_VERSION` 和 `HISTORY_BACKUP_PRICING_CHECKED_AT` 已删除。
- `verifyHistoryBackup()` 校验快照形状、顶层版本/日期与 catalog 一致，并重新计算 catalog SHA-256；摘要不符返回 `HISTORY_BACKUP_PRICING_MISMATCH`（`src/history-backup.js:250`-`272`、`303`-`305`）。

定向测试 `test/history-backup.test.js:208` 使用 `setPricingCatalog()` 设置 `checkedAt=2026-10-22`、`usdToCnyRate=7.31` 和自定义模型 `a0-backup-fixture-model` 的费率，然后断言：

- manifest 的完整 catalog 等于本次 `setPricingCatalog()` 返回的有效 catalog；
- 顶层 `pricingVersion`/`pricingCheckedAt` 与 catalog 一致；
- `pricing.sha256` 等于对完整 catalog 重新计算的 SHA-256；
- 正常 verify 通过；把快照中自定义模型输入价改为 `99` 后，verify 返回 `HISTORY_BACKUP_PRICING_MISMATCH`；
- `finally` 调用 `resetPricingCatalog()`，避免污染其它测试。

整个备份测试文件：

```text
node --test test/history-backup.test.js
exit 0; 7 tests, 7 pass; duration 562.4823 ms
```

本卡只修改 `src/history-backup.js`、`test/history-backup.test.js` 和本报告；未修改 `pricing.js`、core、store、CLI。restore 仍不激活价目，服务进程跨进程传递当前价目仍需后续接线。

## A0.2d：最终单文件原子发布

- `publishFile()` 改为调用标准库 `link(source, destination)`（`src/history-backup.js:3`、`148`）；临时文件和最终目标始终在同一目录。`EEXIST` 仍映射为 `HISTORY_BACKUP_DESTINATION_EXISTS`。
- create 和 restore 都复用同一个 `publishFile()`；没有 `rename`，也没有失败后回落到非原子 `copyFile`。
- 成功后临时链接被移除，最终数据库/恢复文件保持独立可读。测试 `test/history-backup.test.js:186` 和 `:553` 断言最终文件 `nlink=1`，并在备份/恢复后由独立子进程读取数据库。

**Windows 实际结果**：本次普通沙箱内运行 `node --test test/history-backup.test.js` 时，`link(temp, final)` 返回 `EPERM: operation not permitted`，6/7 失败；该失败未被绕过。使用同一测试文件在宿主 Windows 上执行（经用户批准的沙箱外运行）为 7/7 通过，duration `460.9181 ms`，最终文件 `nlink=1`。因此 sandbox 拒绝硬链接，宿主 Windows 文件系统支持该发布方式；这只是最终单文件的可见性验收。

本地检查：`node --check src/history-backup.js` 通过；Biome check/format 通过。

不宣称数据库与 manifest 双文件事务，也不宣称 fsync/断电耐久性已解决。

## A-schema20：真实 store schema 与恢复证据

- `HISTORY_BACKUP_SCHEMA_VERSION` 直接复用 `STORE_SCHEMA_VERSION`（`src/history-backup.js:8`、`11`），不再单独维护 19/20 副本。
- `history_replaced_facts` 已加入 `REQUIRED_TABLES`（`src/history-backup.js:30`）。
- 备份不冻结该表列定义；`tableFingerprint()` 使用 `SELECT *` 序列化并哈希整行（`src/history-backup.js:104`-`105`），因此 B1b-E2 后续新增的 occurrence/数量证据列会自动进入表摘要，不需要在 backup 内再登记列清单。
- 集成测试 `test/history-backup.test.js:245` 使用真实 `UsageStore` 临时库，不走自造 DDL：先写入旧 project-log event，再改写为同长度新 event 并强制 reparse，确认 B 路径产生一条 `history_replaced_facts`，随后 backup/verify/restore，最后用新进程读回恢复 payload 的 `old-session/total=10` 与当前 event 的 `new-session/total=20`。通用夹具中的同名表仅保留一列作为存在性 stand-in，不复制或冻结真实列定义。

```text
node --test test/history-backup.test.js
exit 0; 8 tests, 8 pass; duration 580.8667 ms
```

测试同时断言 manifest `schemaVersion` 等于 `STORE_SCHEMA_VERSION`，`history_replaced_facts` 在 manifest 中有行数和 SHA-256 摘要，真实行的 `occurrence_count=1`，并在把该值改为 `2` 后确认表摘要随之变化。因此当前 B occurrence 证据经 `SELECT *` 进入摘要；若 B 再改列，应以最终版本重跑该真实 fixture。

## A1c-price：manifest 价目在恢复库上复现同一 summary

- 测试 `test/history-backup.test.js:335` 建立真实临时 `UsageStore`，写入一条 project-log 事件，先取得默认价目下的真实 `summary.costEstimate`，再通过现有 `setPricingCatalog()` 把 `gpt-6-luna` 的 `input/cachedInput/cacheWrite/output` 四项费率都相对默认值加 1，并把汇率设为 `7.31`。
- 测试显式断言定制费率不等于默认费率，且定制价目下原 store 的 `totalUsd` 不等于默认价目结果；因此不是用同一个硬编码 expected 让两边一起忽略 custom catalog。原 store 的 `pricedRecords > 0`。
- backup 后断言 `manifest.pricing.catalog` 等于本次 `setPricingCatalog()` 返回的有效 catalog。restore 后启动新进程，从 `manifest.pricing.catalog` 调用现有 `setPricingCatalog()`，再以 `DatabaseSync(..., { readOnly: true })` 打开恢复库，走真实 `UsageStore.summarize({ preset: "all" })` 读路径（`:393`）。
- 现有 `UsageStore.open()` 会执行可写 PRAGMA/建表，因此测试不调用它；只读连接由测试注入，并注册与 `open()` 相同的 `usage_source_group` 函数、填充 `homes`，金额计算和汇总仍是生产 `summarize` 代码。
- 两侧逐字段比较 USD/CNY 的 total、input、cached、cacheWrite、output 金额，金额容差 `1e-12`；`currencies`、`pricedRecords`、`unpricedRecords`、`pricedTokens`、`serviceTierUnknownRecords/Tokens` 精确比较。

```text
node --test test/history-backup.test.js
exit 0; 9 tests, 9 pass; duration 750.0684 ms
```

结果为宿主 Windows 沙箱外运行。生产 backup/restore API、pricing 和 store 均未修改；restore 仍不会自动激活 manifest 价目，本卡只在测试进程中显式加载，自动激活另卡处理。

## A1b-gap：外部 tier 证据未随包恢复的当前缺口

- 反例测试在 `test/history-backup.test.js:425` 构造最小真实输入：`.codex/logs_2.sqlite` 中一条 `TurnInput service_tier: Some(Some("priority"))`，以及同一 `thread_id` 的 rollout，后者只有一个 `gpt-6-sol` 的 100,000 input token 事件且不记录 response tier。
- store 入库后 `events.service_tier` 确为 `unknown`；但原 store 的 `serviceTierEvidence.resolve(threadId, eventTime, "unknown")` 返回 `priority`。原 store summary 的 `serviceTierUnknownRecords=0`、`serviceTierUnknownTokens=0`，费用为已定价金额。
- backup 后恢复，随后关闭原 store 并删除整个 `.codex` home。新进程只拿到恢复库和 manifest 价目，不加载 `logs_2.sqlite`，以只读连接走真实 `UsageStore.summarize({ preset: "all" })`。
- 恢复库同一事件仍是 `service_tier=unknown`，summary 变为 `serviceTierUnknownRecords=1`、`serviceTierUnknownTokens=100000`，且 `totalUsd` 与原 store 的绝对差 `>1e-12`。这明确证明当前备份包没有携带外部 tier 证据，不能把测试通过解释为 tier 保全功能已完成。

```text
node --test test/history-backup.test.js
exit 0; 10 tests, 10 pass; duration 843.6727 ms
```

只改 `test/history-backup.test.js` 和本报告；`service-tier-evidence`、core、store 及 backup API 均未修改。测试只覆盖一个 Codex home 的单事件反例，不代表其它来源或完整 tier 契约。

## A1b-serialize：tier 证据快照与等价 resolver

- `src/service-tier-evidence.js:9` 新增快照格式版本 `SERVICE_TIER_EVIDENCE_SNAPSHOT_FORMAT_VERSION=1`；`:63` 的 `createResolver()` 复用原二分查找逻辑，`loadServiceTierEvidence()` 与快照恢复都返回该 resolver。
- `serviceTierEvidenceSnapshot()`（`:83`）只输出 `{ formatVersion, threads }`，线程按 `threadId` 排序，每轮只保留 `{ time, tier }`。`serviceTierEvidenceFromSnapshot()`（`:99`）校验根对象/线程/轮次的精确键集合、快照版本、非空且唯一且已排序的线程 ID、已排序的有限数值时间，以及 `fast|priority|default|standard|unknown` tier。
- resolver 由 `WeakMap` 登记；传入手写或其它来源的 resolver 形状会在序列化前被拒绝，不会因缺少内部 Map 而意外导出空快照。
- 测试 `test/service-tier-evidence.test.js:103` 对真实 `logs_2.sqlite` 证据做 `JSON.stringify`/`JSON.parse` 往返，并对四个时间点逐项比较原 resolver 与恢复 resolver；显式 `recordedTier="priority"` 仍优先于推断结果。快照 JSON 不含测试放入日志的 `PRIVATE_USER_TEXT`，因为输出没有 `feedback_log_body` 或用户输入字段。
- 测试 `test/service-tier-evidence.test.js:157` 覆盖非法版本、非法 tier/time、乱序或重复线程、乱序轮次、根/线程/轮次多余键，以及外部 resolver 拒绝路径。

```text
node --test test/service-tier-evidence.test.js
exit 0; 2 tests, 2 pass; duration 220.4375 ms

npx.cmd --no-install biome check src/service-tier-evidence.js test/service-tier-evidence.test.js
exit 0; 2 files checked

npx.cmd --no-install biome format src/service-tier-evidence.js test/service-tier-evidence.test.js
exit 0; 2 files checked
```

本卡未修改 `src/history-backup.js`、`src/usage-core.js`、`src/usage-store.js` 或 restore 路径；没有把快照写入备份 manifest、没有恢复时加载快照，也没有验证跨进程或跨 home 的 tier 结果。原生产解析和 resolver 行为保持不变。

## A1b-package：manifest 捕获、校验与 gap 成功路径

- `createHistoryBackup(database, destinationFile, options)` 增加显式 `options.serviceTierEvidence`。调用方未提供时 manifest 写入 `serviceTierEvidence: null`；提供时在函数开始、首次 `await` 之前调用 `serviceTierEvidenceSnapshot()`，并保存 `{ snapshot, sha256 }`（`src/history-backup.js:172`-`177`、`:217`）。备份代码不会重新读取 home 的 `logs_2.sqlite`。
- `readManifestShape()` 要求 manifest 带 `serviceTierEvidence` 标记；`null` 表示明确未捕获，非 null 记录必须含对象快照和 64 位十六进制摘要（`src/history-backup.js:288`-`305`）。因此旧 manifest 缺少该字段时会被拒绝，不会被误当成完整证据包。
- `verifyHistoryBackup()` 先校验快照 SHA-256；摘要不符返回 `HISTORY_BACKUP_SERVICE_TIER_EVIDENCE_MISMATCH`，摘要匹配后再调用 `serviceTierEvidenceFromSnapshot()` 验证结构，结构错误返回 `HISTORY_BACKUP_BAD_MANIFEST`（`src/history-backup.js:339`-`355`）。
- 测试 `test/history-backup.test.js:425` 从同一个真实 store 创建两个包：没有 resolver 的 gap 包明确得到 `serviceTierEvidence=null`；带 `store.serviceTierEvidence` 的包记录 `priority` 快照和匹配摘要。两者恢复后都关闭原 store、删除整个 `.codex` home。
- 新进程只从捕获包 manifest 调用 `serviceTierEvidenceFromSnapshot()`，把重建 resolver 赋给只读 `UsageStore`；同一事件的金额、币种、定价/未定价计数和 `serviceTierUnknownRecords/Tokens` 与原 store 完全一致。gap 包不加载快照，仍得到 `serviceTierUnknownRecords=1`、`serviceTierUnknownTokens=100000` 和不同金额，缺口路径继续可见。
- 同一测试把快照中的 `priority` 改成 `default` 但不改摘要，verify 以 `HISTORY_BACKUP_SERVICE_TIER_EVIDENCE_MISMATCH` 拒绝；再给轮次加多余键并同步改摘要，verify 仍以 `HISTORY_BACKUP_BAD_MANIFEST` 拒绝。恢复原 manifest 后 verify 通过。

```text
node --test --test-name-pattern="backup captures resolver evidence" test/history-backup.test.js
exit 0; 1 test, 1 pass; duration 203.5325 ms

node --test test/history-backup.test.js
exit 0; 10 tests, 10 pass; duration 976.3076 ms

node --test test/service-tier-evidence.test.js
exit 0; 2 tests, 2 pass; duration 223.6666 ms

npx.cmd --no-install biome check src/history-backup.js test/history-backup.test.js
exit 0; 2 files checked

npx.cmd --no-install biome format src/history-backup.js test/history-backup.test.js
exit 0; 2 files checked
```

仅修改 `src/history-backup.js`、`test/history-backup.test.js` 和本报告；`service-tier-evidence` 模块保持 A 的已接受实现。restore API、CLI、执行器都没有自动传递或加载 resolver，调用方仍需显式重建并赋值。备份 manifest 的 `formatVersion` 仍为 1；带新字段的新包可验证，旧版包因缺少标记被拒绝。

## A-context：verify-first 恢复上下文

- 导出 `loadHistoryBackupContext(databaseFile, manifestFile?)`（`src/history-backup.js:392`）。它先 `await verifyHistoryBackup()`，成功后才返回 `{ databaseFile, manifestFile, pricingCatalog, serviceTierEvidence }`。
- `pricingCatalog` 直接取已验证 manifest 的 `pricing.catalog`；`serviceTierEvidence` 为 null 时显式表示未捕获，非 null 时由已验证 snapshot 调用 `serviceTierEvidenceFromSnapshot()` 构造 resolver（`src/history-backup.js:394`-`401`）。
- 该函数不调用 `setPricingCatalog()`，不打开生产库，不修改 `UsageStore`、executor 或 CLI，也不初始化 store 私有缓存。调用方仍需显式激活价目并赋值 resolver。
- `test/history-backup.test.js:502` 在删除 home 后的新进程中，用公共 context 读取恢复库和 manifest，再显式 `setPricingCatalog(context.pricingCatalog)`、赋值 `context.serviceTierEvidence`；捕获包费用/unknown 计数仍与原 store 一致，未捕获包的 context 明确返回 null 并保持 gap 结果。
- 篡改快照但保留旧摘要时，`loadHistoryBackupContext()` 在返回前以 `HISTORY_BACKUP_SERVICE_TIER_EVIDENCE_MISMATCH` 拒绝（`test/history-backup.test.js:518`）；篡改结构并同步摘要时以 `HISTORY_BACKUP_BAD_MANIFEST` 拒绝（`:526`）。恢复原 manifest 后 context 可再次取得。

```text
node --test --test-name-pattern="backup captures resolver evidence" test/history-backup.test.js
exit 0; 1 test, 1 pass; test duration 228.3776 ms; runner duration 303.1629 ms

node --test test/history-backup.test.js
exit 0; 10 tests, 10 pass; duration 936.8288 ms

node --test test/service-tier-evidence.test.js
exit 0; 2 tests, 2 pass; duration 223.6666 ms

npx.cmd --no-install biome check src/history-backup.js test/history-backup.test.js
exit 0; 2 files checked

npx.cmd --no-install biome format src/history-backup.js test/history-backup.test.js
exit 0; 2 files checked
```

`service-tier-evidence` 模块本卡未改动。没有扩展 restore 自动激活、CLI、执行器、全局 pricing 或 store 初始化。

## A-CLI-verify：离线包校验命令

命令形状固定为 `codex-usage history verify <databaseFile>`；manifest 使用与数据库同目录的 `<name>.manifest.json`，没有额外选项。Usage 文本已加入 `src/cli.js:32`，`main()` 的 `history` 分支只调用 `verifyHistoryCommand()`（`:576`-`:577`）。

- `verifyHistoryCommand()`（`src/cli.js:506`）直接调用现有 `verifyHistoryBackup()`，没有重新实现 SHA-256、schema 或表摘要逻辑。
- 成功输出依次为 `History backup verified.`、`Schema: <version>`、按表名排序的 `- <table>: <rows>`，以及 `Service-tier evidence: captured (N threads)` 或 `Service-tier evidence: not captured`。输出只来自已验证 manifest，不含事件 payload、用户文本或原始 home 日志。
- 参数缺失、子命令未知或多出参数时打印 usage 并设置非零退出码。verify 抛错时只打印 `History backup verification failed: <code>: <message>`，同样非零退出，不输出成功前缀。
- `package.json` 的 `codex-usage` 与 `cud` 两个 bin 都指向同一 `src/cli.js`；现有 `summary`、`json`、`run`、`gateway`、`restart`、`dashboard`、`stop` 分派未改。直接 `node src/cli.js ...` 和既有 CLI 测试仍走同一入口。
- 新增 `test/history-cli.test.js:54` 通过真实 spawn 运行 CLI。有效临时包由真实 `UsageStore` 和 `createHistoryBackup()` 生成，断言 schema、`events` 计数和未捕获 tier 输出，同时确认输出不含夹具 session/source/cwd。
- 同一个包的 manifest 数据库摘要改成全 0 后再次 spawn，断言退出码非零、stdout 为空，stderr 明确包含 `HISTORY_BACKUP_DIGEST_MISMATCH`。

```text
node --test test/history-cli.test.js
exit 0; 1 test, 1 pass; test duration 292.7537 ms; runner duration 380.2187 ms

node --test test/cli.test.js
exit 0; 9 tests, 9 pass; duration 3778.7157 ms

npx.cmd --no-install biome check src/cli.js test/history-cli.test.js
exit 0; 2 files checked

npx.cmd --no-install biome format src/cli.js test/history-cli.test.js
exit 0; 2 files checked
```

只修改 `src/cli.js`、新增 `test/history-cli.test.js` 和本报告；没有启动服务、没有发现真实 home、没有载入或改全局价目，也没有实现 `history create`、`history restore` 或 `--manifest` 选项。

## A-restore-package：恢复数据库与验证 manifest

- `restoreHistoryBackup()` 在 verify 源包后构造恢复 manifest：复制源 manifest 的全部证据，仅把 `database.filename` 改为 `path.basename(destination)`（`src/history-backup.js:417`-`421`）。
- 恢复数据库仍先复制并复核字节数/SHA-256，再用只读连接检查 schema 与表证据；随后把恢复 manifest 写入同目录临时文件（`:425`-`:440`）。
- 数据库和 manifest 都复用 `publishFile()` 的同目录排他 `link()` 发布（`:441`-`:444`）。任一步遇到已有目标都返回 `HISTORY_BACKUP_DESTINATION_EXISTS`，清理本次临时文件及本次已发布的数据库，不删除或覆盖外部 manifest。返回对象的 `manifestFile` 现在是目标旁的 manifest 路径（`:446`-`:450`）。
- `test/history-backup.test.js:303` 断言恢复返回 `restored.manifest.json`，其内容除 `database.filename="restored.sqlite"` 外与源 manifest 完全一致。随后删除整个源 `package/` 目录，由独立新进程仅用 restored 数据库和相邻 manifest 调 `loadHistoryBackupContext()`，读回 `gpt-6-luna` 价目版本、`priority` tier resolver，以及真实 `history_replaced_facts` 的旧 `old-session/total=10` 证据（`:309`-`:345`）。
- `test/history-backup.test.js:717` 增加已有外部 manifest 的恢复冲突：恢复拒绝、外部 manifest 内容保持 `foreign-manifest`、本次数据库未留下，临时数据库/manifest 文件均被清理。

```text
node --test test/history-backup.test.js
exit 0; 10 tests, 10 pass; duration 968.5804 ms

npx.cmd --no-install biome check src/history-backup.js test/history-backup.test.js
exit 0; 2 files checked

npx.cmd --no-install biome format src/history-backup.js test/history-backup.test.js
exit 0; 2 files checked
```

只修改 `src/history-backup.js`、`test/history-backup.test.js` 和本报告；CLI、restore 自动加载、全局 pricing、服务与 store 初始化均未改动。数据库与 manifest 仍按单文件各自原子发布，不是双文件事务；两步之间进程中断仍可能留下只发布数据库的半包。

## A-CLI-restore：离线恢复命令

命令形状固定为 `codex-usage history restore <packageDB> <newDB>`，没有额外选项。Usage 文本已加入 `src/cli.js:33`，`main()` 的 `history` 分支把 `restore` 交给 `restoreHistoryCommand()`（`src/cli.js:599`-`600`），其余子命令仍走 verify。

- `restoreHistoryCommand()`（`src/cli.js:539`）直接调用现有 `restoreHistoryBackup()`，没有复制或改写 verify、摘要、manifest 发布逻辑。
- 成功输出依次为 `History backup restored.`、`Database: <restored path>`、`Manifest: <restored manifest path>`、`Online service was not switched.`。
- 参数缺失、子命令未知或多出参数时打印 usage 并设置非零退出码；restore 抛错时只打印 `History backup restore failed: <code>: <message>`，同样非零退出，不输出成功前缀。
- 目标数据库或目标 manifest 已存在时，底层返回 `HISTORY_BACKUP_DESTINATION_EXISTS`，命令不改写已有文件，也不清理外部文件；没有 `--force` 或覆盖路径。
- `test/history-cli.test.js:98` 通过真实 spawn 创建临时包，恢复成功后再恢复同一目标，断言退出码为 1 且数据库/manifest 字节不变；随后只创建外部目标 manifest，断言恢复拒绝、外部内容保持、目标数据库未留下。删除源 `package/` 后，对新数据库运行 `history verify` 仍成功，证明 CLI 产物可独立校验。

```text
node --test test/history-cli.test.js
exit 0; 2 tests, 2 pass; duration 758.7711 ms

npx.cmd --no-install biome check src/cli.js test/history-cli.test.js
exit 0; 2 files checked

npx.cmd --no-install biome format src/cli.js test/history-cli.test.js
exit 0; 2 files checked
```

只修改 `src/cli.js`、`test/history-cli.test.js` 和本报告；没有实现覆盖/强制恢复、价目或 tier 自动激活、服务发现、服务切换或重启。

## A-CLI-backup：离线创建备份包

命令形状为 `codex-usage history backup <sourceDB> <newPackageDB> [--home-dir <dir>]`。Usage 文本已加入 `src/cli.js:34`，`main()` 的 `history` 分支把 `backup` 交给 `backupHistoryCommand()`（`src/cli.js:629`-`630`）。

- `backupHistoryCommand()`（`src/cli.js:541`）先调用 CLI 既有的 `loadPricingFile(reportOptions(args))`，只沿用 `--home-dir` / 默认价目配置，不调用 `buildUsageReport()`，不发现或扫描数据来源。
- 源库只用 `new DatabaseSync(sourceFile, { readOnly: true })` 打开，并把该连接交给现有 `createHistoryBackup()`；不调用 `UsageStore.open()`、不 `sync()`、不迁移原库，也没有 raw file copy。
- 成功输出为 `History backup created.`、目标数据库绝对路径、`Service-tier evidence: not captured`、`Source database was not modified.`；没有声称 tier 证据已完整转移，也没有启用全局价目之外的 store/executor 状态。
- 目标数据库或 manifest 已存在时，底层返回 `HISTORY_BACKUP_DESTINATION_EXISTS`；命令不覆盖、不清理外部文件，也没有 `--force`。
- `test/history-cli.test.js:101` 创建真实 schema 20 临时库，关闭自动 checkpoint 后提交一行事件并保持源连接；真实 spawn 执行 backup，断言包经 `history verify` 可见该提交、事件总额为 37，且第二次执行因目标冲突退出 1。测试同时比较源主库和 `-wal` 的原始字节、重新查询逻辑总额，确认源库未被修改。

```text
node --test test/history-cli.test.js
exit 0; 3 tests, 3 pass; duration 1039.6708 ms

npx.cmd --no-install biome check src/cli.js test/history-cli.test.js
exit 0; 2 files checked

npx.cmd --no-install biome format --write src/cli.js test/history-cli.test.js
exit 0; 1 file formatted
```

只修改 `src/cli.js`、`test/history-cli.test.js` 和本报告；没有实现在线快照 API、自动 tier 日志重读、服务重启或强制覆盖。

## A-backup-schema19：保持源 schema 的离线兼容

- 核对 19→20 迁移后，唯一结构差异是 v20 新增 `history_replaced_facts`（`src/usage-store.js:2677`-`2680`）。`src/history-backup.js:34` 因此为 schema 19 选择 v20 必需表清单去掉该表，schema 20 继续使用完整清单。
- `assertSupportedSchema()` 返回实际 `PRAGMA user_version` 和该版本的必需表；create 把实际版本写入 `manifest.schemaVersion`，没有把 19 伪装成 20，也没有迁源库。
- manifest 校验按声明版本选择表清单；verify 另外要求 manifest 版本等于数据库实际版本，不符返回 `HISTORY_BACKUP_SCHEMA_MISMATCH`。未知版本仍返回 `HISTORY_BACKUP_UNSUPPORTED_SCHEMA`。
- restore 按恢复库实际版本复核 manifest，不升级数据库；schema 20 的 `history_replaced_facts` 和 tier 证据路径保持原测试。
- `test/history-backup.test.js:359` 先用真实 `UsageStore` 建立 schema 20 临时库，关闭后删除 v19 不存在的 `history_replaced_facts` 并把 `user_version` 降为 19，得到真实 19 形状。backup 的 manifest 为 19 且不含该表；verify 通过；restore 后数据库仍为 19、事件总额仍为 19，源库字节不变。

```text
node --test test/history-backup.test.js
exit 0; 11 tests, 11 pass; duration 983.6311 ms

npx.cmd --no-install biome check src/history-backup.js test/history-backup.test.js
exit 0; 2 files checked

npx.cmd --no-install biome format --write src/history-backup.js test/history-backup.test.js
exit 0; 2 files formatted
```

只修改 `src/history-backup.js`、`test/history-backup.test.js` 和本报告；CLI、store 迁移和生产访问均未改动。

## A2-dryrun：只读归档候选计算

- 新增 `planHistoryArchive(database, { asOf })`（`src/history-archive.js:17`）。`asOf` 必须是有效 epoch 毫秒整数；当地日期午夜用 `setHours(0,0,0,0)` 归一，再用 `setDate(getDate()-180)` 得到 cutoff，保留当地日历日语义。
- cutoff 等值保持热区，只有 `timestamp_ms < cutoffMs` 计为冷事件；SQL 只做一次 `SELECT`，不按 `source_path` 排除跨界文件，也不生成文件、删除、登记或迁移。
- 返回形状固定为 `{ eligible, reason, eventCount, coldEventCount, cutoffMs }`。总事件少于 400,000 时 `reason="below-event-threshold"`，达到阈值但没有冷事件时 `reason="no-complete-cold-day"`，两者都满足才 `reason="eligible"`。
- `test/history-archive.test.js:13` 在同一内存 `events` 表批量生成 399,999 行，验证阈值；补到 400,000 后验证 eligible；再把唯一冷事件移到 cutoff，验证没有完整冷日。cutoff-1 入冷、cutoff 留热。`test/history-archive.test.js:57` 验证缺失/非法 `asOf` 被拒绝且表未写入。

```text
node --test test/history-archive.test.js
exit 0; 2 tests, 2 pass; duration 138.6393 ms

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked

npx.cmd --no-install biome format --write src/history-archive.js test/history-archive.test.js
exit 0; 1 file formatted
```

只新增 `src/history-archive.js`、`test/history-archive.test.js` 并更新本报告；backup、CLI、store 和生产路径均未改。

## A2-CLI-dryrun：只读归档规划命令

- 命令形状固定为 `codex-usage history archive <sourceDB> --dry-run`，没有额外选项。`archiveHistoryCommand()` 要求恰好一个源库参数和 `--dry-run`；缺 flag、未知多余参数或错误参数数量都打印该命令的 usage、stdout 为空并退出 1。
- 源库只用 `new DatabaseSync(sourceFile, { readOnly: true })` 打开，随后直接调用现有 `planHistoryArchive(db, { asOf: Date.now() })`；不经过 `UsageStore.open()`、`sync()` 或迁移，也没有生成、删除、登记、迁移或执行归档。
- 成功输出为 `History archive dry-run.`、`Eligible: yes|no`、`Reason`、`Events`、`Cold events`、本地日期时间形式的 `Cutoff local`，以及原始整数 `Cutoff epoch ms`。错误路径使用非零退出码并打印 `History archive dry-run failed: ...`。
- `test/history-cli.test.js` 使用保持打开且带非空 WAL 的真实 schema 20 临时库，真实 spawn 断言 1 个事件、1 个冷事件、`below-event-threshold` 和两类 cutoff 输出；随后比较源主库与 `-wal` 的原始字节。缺少 `--dry-run` 和带未知多余参数的两个反例也分别断言退出 1、stdout 为空、stderr 含 usage，并再次确认源主库与 WAL 字节未变。

```text
node --test test/history-cli.test.js
exit 0; 4 tests, 4 pass; duration 1327.4483 ms

npx.cmd --no-install biome check src/cli.js test/history-cli.test.js
exit 0; 2 files checked

npx.cmd --no-install biome format --write src/cli.js test/history-cli.test.js
exit 0; formatted 2 files in 6 ms, no fixes applied
```

该测试因包含既有硬链接发布用例，在宿主 Windows 沙箱外运行。只修改 `src/cli.js`、`test/history-cli.test.js` 和本报告；归档执行、段创建/登记、删除、来源发现和服务管理均未实现。

## A2-candidate-events：未登记候选文件

- 新增 `createHistoryArchiveCandidate(database, destinationFile, { startMs, endMs, serviceTierEvidence? })`。范围必须是有效且位于 SQLite/Date 可表示范围内的整数 epoch 毫秒，满足 `startMs < endMs`；区间为 `[startMs, endMs)`。
- 第一阶段用 `backup(database, workFile)` 在私有临时目录建立 SQLite 快照；只在工作副本事务中执行 `DELETE FROM events WHERE timestamp_ms < startMs OR timestamp_ms >= endMs`，并 upsert `store_meta.history_archive_candidate`，写入 `formatVersion:1`、范围、`state:"unregistered"`、events 指纹和范围内事件引用 source 的身份指纹（细节见后续卡片）。
- 工作副本中的 `source_files`、perf/timing/WorkBuddy、`history_replaced_facts` 等非 events 表均不筛选、不删除，暂时完整保留为上下文。此卡不判断这些证据应归入哪个日期或分卷。
- 第二阶段把已过滤工作副本交给现有 `createHistoryBackup(working, destination, { serviceTierEvidence })`，因此继续复用其最终发布、数据库摘要、价目快照、tier 快照、manifest 和排他目标保护。工作副本关闭后删除整个临时目录；源连接只被 SQLite backup 读取。
- 初版明确执行两次完整 SQLite backup：源库→私有工作副本，工作副本→最终包；尚未优化为单次复制。返回值为 `createHistoryBackup()` 的 manifest，但本卡不把它解释为已登记或已封存。
- `test/history-archive.test.js` 用真实临时 `UsageStore` 和两个事件验证半开区间：`startMs` 事件保留，`endMs` 事件删除；`source_files` 身份、一条 `history_replaced_facts` 原始恢复证据和传入的 tier snapshot 均保留。测试另比较源主库与 `-wal` 原始字节，并对重复发布到已有目标断言 `HISTORY_BACKUP_DESTINATION_EXISTS` 且数据库/manifest 字节不变。非法范围在不进行复制前被拒绝。

```text
node --test test/history-archive.test.js
exit 0; 4 tests, 4 pass; duration 246.4107 ms

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked

npx.cmd --no-install biome format --write src/history-archive.js test/history-archive.test.js
exit 0; formatted 2 files in 3 ms, no fixes applied
```

该测试因复用同目录硬链接发布，在宿主 Windows 沙箱外运行。只修改 `src/history-archive.js`、`test/history-archive.test.js` 和本报告；`history-backup`、CLI、store 与服务路径均未改。

## A2-candidate-verify：候选元数据与事件指纹校验

- 新增公开 `verifyHistoryArchiveCandidate(databaseFile, manifestFile?)`。它先完整复用 `verifyHistoryBackup()` 校验数据库摘要、manifest、价目和 tier，再以只读连接打开已验数据库。
- `store_meta.history_archive_candidate` 当前必须是精确形状 `{formatVersion, startMs, endMs, state, events, sources}`：`formatVersion=1`、`state="unregistered"`、范围为有效整数 epoch 毫秒且 `startMs < endMs`，`events` 与 `sources` 都必须为 `{rows, sha256}`。
- 候选 verify 独立要求所有 events 的 `timestamp_ms` 位于 `[startMs,endMs)`，拒绝 `HISTORY_ARCHIVE_CANDIDATE_RANGE_MISMATCH`；随后重新计算 events 指纹，行列数或 SHA-256 不符时拒绝 `HISTORY_ARCHIVE_CANDIDATE_FINGERPRINT_MISMATCH`。成功返回普通 backup 的结果并附 `candidate` metadata。
- 创建时在副本内以 `SELECT * FROM events ORDER BY id` 的 `iterate()` 逐行计算，避免 `all()` 把完整 events 再复制进内存；SHA-256 先绑定 `{startMs,endMs}`，再对每一条完整行 `JSON.stringify(row) + "\n"` 连续更新。因此单独改边界但不改指纹也会失配。
- `test/history-archive.test.js` 先断言真实候选通过。随后分别篡改候选 metadata 的边界（使事件落在范围外）和 events SHA-256，再用 `createHistoryBackup()` 从篡改库重建普通 manifest；两次都先确认 `verifyHistoryBackup()` 通过，再断言候选 verify 以对应错误码拒绝。测试结束时再次比较源主库与 `-wal` 字节。

```text
node --test test/history-archive.test.js
exit 0; 4 tests, 4 pass; duration 293.1635 ms

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked

npx.cmd --no-install biome format --write src/history-archive.js test/history-archive.test.js
exit 0; formatted 2 files in 4 ms, fixed 1 file
```

该测试在宿主 Windows 沙箱外运行，因为最终候选仍经同目录硬链接发布。只修改 `src/history-archive.js`、`test/history-archive.test.js` 和本报告；没有登记候选、删除主库 event、源 revision 校验或 CLI 接线。

## A2-source-match：源当前事件集合匹配

- 新增同步只读接点 `assertHistoryArchiveSourceMatches(sourceDatabase, verifiedCandidate)`；不打开或关闭源连接，不执行 DELETE/INSERT/UPDATE。`verifiedCandidate` 必须是 `verifyHistoryArchiveCandidate()` 的成功结果：要求 `ok=true`、存在 `candidate`，并再次套用候选 metadata 的精确形状/范围校验；无效参数抛 `TypeError`。
- 复用候选指纹的同一流式算法，但源侧 SQL 为 `SELECT * FROM events WHERE timestamp_ms >= ? AND timestamp_ms < ? ORDER BY id`。范围和排序直接进入 SELECT，哈希仍先绑定 `{startMs,endMs}`，再按 id 对完整行的 `JSON.stringify(row) + "\n"` 流式更新；不读取 `index_version` 作为事实替代。
- 行数或 SHA-256 与候选 metadata 不同即抛 `HISTORY_ARCHIVE_SOURCE_CHANGED`。因此范围内同数量内容变更会拒绝，而范围外热区追加不进入 SELECT、不会误拒绝。函数不返回、不删除、不登记，也不修改候选。
- 测试增加参数结构反例；随后用原真实临时 `UsageStore` 断言原源匹配；把范围内事件 `session_id` 改成相同行数的新值后断言拒绝；恢复原值并在热区追加一条新 event 后再次匹配。匹配调用前后比较源主库和 `-wal` 原始字节，确认函数未写源。

```text
node --test test/history-archive.test.js
exit 0; 4 tests, 4 pass; duration 300.8283 ms

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked

npx.cmd --no-install biome format --write src/history-archive.js test/history-archive.test.js
exit 0; formatted 2 files in 4 ms, no fixes applied
```

测试仍在宿主 Windows 沙箱外运行以复用候选的硬链接发布。只修改 `src/history-archive.js`、`test/history-archive.test.js` 和本报告；源 revision、其它证据所有权、登记、删除和 CLI 均未接线。

## A2-source-context：候选引用来源身份

- 新增一个 `sourceEvidence(database,startMs,endMs)` helper，创建、候选 verify 和源匹配三个路径共用。SQL 只读取 `source_files` 中被 `[startMs,endMs)` 内 events 引用的行，字段固定为 `path/kind/home_id/home_label/home_path`，按 `path` 排序；不读 `size/mtime_ms/indexed_at`，也不对无范围内 event 引用的 source 取摘要。
- 每行按固定属性顺序 `JSON.stringify` 后流式更新 SHA-256，生成 `sources:{rows,sha256}` 写入候选 metadata。hash 继续以范围作域分隔，helper 不依赖全库 source 数量。
- 候选严格 shape 已更新为 `endMs,events,formatVersion,sources,startMs,state`。旧开发候选缺少 `sources` 会以 `HISTORY_ARCHIVE_CANDIDATE_BAD_METADATA` 拒绝；本卡不提供迁移或兼容读取。候选 verify 重新计算 sources，不符抛 `HISTORY_ARCHIVE_CANDIDATE_SOURCE_MISMATCH`。
- 源匹配在 events 指纹一致后重新计算 sources；引用 source 的任一身份字段变化都复用 `HISTORY_ARCHIVE_SOURCE_CHANGED` 拒绝。测试只把真实引用 source 的 `kind` 从 `codex` 改为 `claude`，events 不变即拒绝；恢复 `codex` 后再次匹配。
- 测试另插入一个无范围内事件引用的 source 并修改其 `kind`，确认匹配不误拒绝。现有 events 同数量变更、热区追加、候选 sources 篡改反例和源 DB/WAL 字节断言继续保留。

```text
node --test test/history-archive.test.js
exit 0; 4 tests, 4 pass; duration 330.4643 ms

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked

npx.cmd --no-install biome format --write src/history-archive.js test/history-archive.test.js
exit 0; formatted 2 files in 4 ms, no fixes applied
```

该测试在宿主 Windows 沙箱外运行以复用硬链接发布。只修改 `src/history-archive.js`、`test/history-archive.test.js` 和本报告；perf/timing/WorkBuddy 所有权、源 revision、登记、删除和 CLI 均未改。

## A2-candidate-portable：恢复后脱离开原候选目录

- 生产模块未改。真实候选目标改到独立 `candidate-package/`；在该候选仍通过完整 verify 时调用 `restoreHistoryBackup(destination, portableFile)`，把数据库和改写文件名的 manifest 恢复到新的 `portable/` 目录。既有边界/events/sources 篡改反例随后才改写原候选，因此不会污染已恢复副本。
- 完成既有篡改检查后删除整个原 `candidate-package/`，再由独立 Node 进程只接收 restored 数据库、`startMs` 和引用 source path。新进程调用 `verifyHistoryArchiveCandidate()` 与 `loadHistoryBackupContext()`，并以只读连接读取 events 和 source 身份。
- 父进程只增加三组核心断言：新进程的候选 metadata（范围、events 与 sources 摘要）等于篡改前已验候选；恢复价目等于已验 manifest，`thread-1` 在 `startMs` 解析为 `priority`，唯一 event 为 `{timestamp_ms:startMs,session_id:"in-range",total:20}`，引用 source 身份保持 `codex/home/Home/root`，且原包目录已不存在；源 event 行与计数、source 行、`history_replaced_facts`、主库字节和 WAL 字节在恢复、删除及子进程前后完全不变。
- 该证据只覆盖同一主机文件系统的恢复与目录删除，不证明跨机器、跨 OS、ACL/符号链接/长路径迁移，也不证明恢复后原包可回滚。未包含 registry bundle、CLI 激活、候选登记、主库删除或热迁移。

```text
node --test --test-name-pattern="candidate keeps only the event range and preserves source context" test/history-archive.test.js
exit 0; 1 test, 1 pass; duration 366.4909 ms

node --test test/history-archive.test.js
exit 0; 5 tests, 5 pass; duration 550.2744 ms

npx.cmd --no-install biome check test/history-archive.test.js
exit 0; 1 file checked

git diff --check -- test/history-archive.test.js docs/validation/2026-10-22-history-retention/A-report.md
exit 0
```

测试在宿主 Windows 沙箱外运行以复用既有同目录硬链接发布；沙箱内会以 `EPERM` 失败。只修改 `test/history-archive.test.js` 和本报告。

## A2-candidate-registry-guard：非空登记目录在候选入口拒绝

- `createHistoryArchiveCandidate()` 在范围校验后、`mkdtemp()` 与任何 SQLite backup 前检查 `archive_segments`：表存在且行数大于 0 时，立即以 `HISTORY_BACKUP_ARCHIVES_UNSUPPORTED` 拒绝。schema 19/20 没有该表时保持原行为，schema 21 空目录继续允许候选创建。
- 新测试复用真实 `UsageStore`：写入两条 events、source 身份和一条 `history_replaced_facts`，先创建候选并调用 `store.registerHistoryArchiveCandidate()` 登记，再尝试向另一目录创建候选。捕获登记后的 `archive_segments`、events/source/facts、主库字节与 WAL 字节作为基线。
- 测试只有三组断言：错误码为 `HISTORY_BACKUP_ARCHIVES_UNSUPPORTED`；原登记目录、事实、主库与 WAL 完全不变；没有新增 `codex-usage-archive-*` 私有目录，目标数据库和 manifest 均不存在。

```text
node --test --test-name-pattern="candidate creation rejects a non-empty archive registry" test/history-archive.test.js
exit 0; 1 test, 1 pass; duration 207.0442 ms

node --test test/history-archive.test.js
exit 0; 6 tests, 6 pass; duration 627.2863 ms

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked
```

该卡只补入口拒绝契约；不解除非空 registry 门禁，不打包外部段文件，不新增 CLI、激活、登记、热删除或整包导出能力。测试在宿主 Windows 沙箱外运行以复用同目录硬链接发布。

## A-bundle-inventory：登记段清单验证接点

- 生产接点放在原 owner `src/history-archive.js`：新增 `inventoryHistoryArchiveSegments(database)`，输入已打开的 SQLite 连接，读取 `archive_segments` 并按 `segment_id` 排序。`src/history-backup.js` 与其测试未修改，因此没有新增反向 import 或复制候选 metadata 校验。
- 每段先用既有 `verifyHistoryArchiveCandidate()` 完整验证数据库、manifest、候选范围、events/sources 指纹和 tier 证据，再核对登记字段：`segment_id`/`database_sha256` 必须等于 manifest 数据库摘要，`start_ms`、`end_ms`、`event_count` 必须等于候选 metadata。全部通过后才返回已验证的 `{segmentId, databaseFile, manifestFile, databaseSha256, startMs, endMs, eventCount}` 清单。
- 缺少 `archive_segments` 表返回 `HISTORY_ARCHIVE_SEGMENT_INVENTORY_UNAVAILABLE`；任一段数据库或相邻 manifest 缺失返回 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND`；登记字段不符返回 `HISTORY_ARCHIVE_SEGMENT_MISMATCH`；篡改继续由候选 verify 的既有摘要错误明确拒绝。循环中任一段失败即整体失败，不跳过或返回部分清单。
- 真实测试先创建并登记一个候选，断言清单返回其路径、sha、半开范围和事件数；随后分别追加字节、用内存登记行写入错误 `event_count`、删除段数据库，验证上述三种失败。前后比较源主库字节、WAL 字节、`archive_segments`、events 和 source 身份，确认 inventory 不写源。测试没有修改非空目录的 backup 拒绝门禁。

```text
node --test --test-name-pattern="registered archive inventory verifies packages and fails closed" test/history-archive.test.js
exit 0; 1 test, 1 pass; duration 154.6465 ms

node --test test/history-archive.test.js
exit 0; 7 tests, 7 pass; duration 684.9431 ms

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked
```

该接点只供后续 bundle 做输入校验；不复制或打包段文件、不解除 `createHistoryBackup()` 非空目录拒绝、不写源库、不接 CLI/激活/热删除。

## A-bundle-stage-segments：登记段复制到新建 staging

- 新增 `stageHistoryArchiveSegments(database, stagingDirectory)`。目标目录用非递归 `mkdir()` 独占创建；已存在返回 `HISTORY_ARCHIVE_STAGING_DESTINATION_EXISTS`，不会读取或覆盖其中内容。只有本次成功创建目录后才在任意后续失败时递归清理该目录。
- 先调用 `inventoryHistoryArchiveSegments()`；每个有效段交给既有 `restoreHistoryBackup()` 复制到 `segments/<segmentId>.sqlite`，manifest 由 restore 同步发布到相邻 `<segmentId>.manifest.json`。复制前后都由 restore 的源 verify、字节数与 SHA-256 复核关闭 inventory→copy 的普通改写窗口。
- 每个 staged 包再用 `verifyHistoryArchiveCandidate()` 复核数据库摘要、范围与 `eventCount` 仍等于 inventory 项。成功返回仅含 `segments/<sha>.sqlite`、`segments/<sha>.manifest.json` 等相对包路径的清单，不携带生产绝对来源路径；失败返回 `HISTORY_ARCHIVE_STAGING_MISMATCH` 并清理本次 staging 目录。
- 真实测试创建带 `thread-1=priority` tier 证据的登记候选，staging 后删除原候选包，仍能从 staged 文件 verify、读取 event 和 tier resolver。另测已存在目标目录的 sentinel 不被改动，以及删除原段后新 staging 以 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND` 失败且不残留目录；源主库、WAL、registry、events 和 source 身份前后不变。

```text
node --test --test-name-pattern="registered segments stage into a portable bundle" test/history-archive.test.js
exit 0; 1 test, 1 pass; duration 180.7645 ms

node --test test/history-archive.test.js
exit 0; 8 tests, 8 pass; duration 823.9851 ms

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked
```

该卡只生成可搬运的段 staging，不生成完整 bundle manifest、不复制主库、不改 registry、不接 CLI/激活，并继续保留非空 registry 的 backup 门禁。

## A-bundle-stage-main：单快照主库与登记段 draft（已接受）

- 主审已接受数据库与 registry 来自同一私有快照的 draft 组合；独立宿主定向测试 1/1 通过，288.7548 ms。该接受边界**只覆盖数据库+registry 同快照**，当时未证明调用 bundle 时价目和 tier 业务 context 已冻结。
- 新增 `stageHistoryArchiveBundle(database, stagingDirectory, options)`。它先用 SQLite `backup(database, workFile)` 把在线源库压成一个私有临时快照；登记段 inventory、段复制和主库打包都只读这个快照，不直接读取 staging 期间的 live 库。
- 段 staging 继续复用 `stageHistoryArchiveSegments()`，因此目标目录仍由一次非递归 `mkdir()` 独占创建，已存在目录不会被读取、覆盖或清理。段复制成功后，bundle 才继续，并把每段 `segmentId`、`databaseSha256`、`startMs`、`endMs`、`eventCount`、`registeredAtMs` 写入最终 manifest。
- 只对私有快照执行 `DELETE FROM archive_segments`，随后用既有 `createHistoryBackup()` 生成 `main.sqlite` 和 `main.manifest.json`。该卡验收时没有修改 `src/history-backup.js`；后继 A-bundle-context 才新增内部显式 `pricingCatalog` 输入以冻结业务 context。两卡都没有新增 bypass 参数，也没有删除 live registry 或 hot events。
- `bundle.manifest.json` 固定为 `formatVersion: 1`，主库写 `main.sqlite`/`main.manifest.json`，段写 `segments/<sha>.sqlite`/`segments/<sha>.manifest.json`，全部为相对路径，不含生产源绝对路径。
- 段 staging 成功后的任一步失败都会清理本次创建的 bundle 目录；段 staging 自身失败时仍由其原逻辑清理。私有快照目录在所有成功和失败路径都由 `finally` 删除。
- 真实测试复用 schema 21 `UsageStore`：登记一个带 `thread-1 -> priority` 的候选后生成完整 bundle，断言主库 verify 通过、主库 `archive_segments=0`、hot event 和 tier 仍在、staged 段在原候选目录删除后仍可 verify/读取、manifest 字段与相对路径正确，并比较源主库/WAL/registry/events/source 字节与行完全不变。另测已有目标目录的 sentinel 不被改动、删除原段后的 bundle 失败码为 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND` 且失败目录和私有快照均不残留。

```text
node --test --test-name-pattern="complete archive bundle stages hot facts and segments from one snapshot" test/history-archive.test.js
exit 0; 1 test, 1 pass; test duration 198.4688 ms; runner duration 274.0224 ms

node --test test/history-archive.test.js
exit 0; 9 tests, 9 pass; duration 995.6060 ms

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked

src/history-archive.js sha256 55807c4a446ee6c93b0cf716e56efab4387bdb0d1f951e83cffe8f66f0cbed0d
test/history-archive.test.js sha256 3c7cb7e8fa9c577c30d7514e81812df6aedc53fe878fe72ab55e650a94f7c32d
```

该卡只生成完整 bundle 的 staging draft；没有最终发布/导入/CLI/authority 接线，没有删除 live registry，也不把 staging 视为已封存或可查询。上面的 hash 是该卡验收时的版本；当前文件 hash 以 A-bundle-context 和文末为准。测试在宿主 Windows 沙箱外运行以复用同目录硬链接发布。

## A-bundle-context：bundle 入口冻结价目与 tier 载体（已接受）

- 主审已接受首 `await` 前的 catalog/tier 纯 snapshot 捕获、backup 可选 catalog 的既有校验复用与旧默认行为保持；独立宿主定向测试 1/1 通过，334.2084 ms。
- `stageHistoryArchiveBundle()` 在第一个 `await mkdtemp()` 之前同步捕获 `getPricingCatalog()` 的完整副本，并用既有 `serviceTierEvidenceSnapshot()` 把调用方 resolver 转成纯 JSON snapshot；不临时切换全局价目，也不把 resolver 本体跨 await 依赖。
- `createHistoryBackup()` 新增可选 `pricingCatalog` 输入；省略时仍走原来的 `getPricingCatalog()`，默认调用行为不变。显式输入复用 `validatePricingCatalog()` 校验并克隆，同时要求完整 `version`，没有新增价目 codec。
- bundle 的所有 `main.sqlite` 打包都显式传入入口捕获的 catalog，并通过既有 `serviceTierEvidenceFromSnapshot(snapshot)` 重建 main backup 用的 resolver。无 tier 证据时仍传 `null`；段包继续使用其已验收 manifest 中的 tier 证据。
- 确定性测试先在 catalog A 下调用 `stageHistoryArchiveBundle()` 且不 await，立刻把 live catalog 切到 B，再 await。最终 main context 的 catalog 仍是 A、`thread-1` 仍解析为 `priority`，live catalog 仍为 B；另生成无 tier 证据 bundle，断言 main context 的 `serviceTierEvidence === null`。源主库、WAL、registry、events 与 source 身份前后不变。

```text
node --test --test-name-pattern="complete archive bundle stages hot facts and segments from one snapshot" test/history-archive.test.js
exit 0; 1 test, 1 pass; test duration 267.1886 ms; runner duration 342.8959 ms

node --test test/history-archive.test.js test/history-backup.test.js
exit 0; 21 tests, 21 pass; duration 1222.7922 ms

npx.cmd --no-install biome check src/history-archive.js src/history-backup.js test/history-archive.test.js
exit 0; 3 files checked

npm.cmd run typecheck
exit 0

src/history-archive.js sha256 bfdacc5ad8883980a7b149e60464e4c31e8b5ab43ca86ff12961d8c640c37fe4
src/history-backup.js sha256 053ffe2650555819927d7d5e951158fce691807104926ffafa653ca70c217d24
test/history-archive.test.js sha256 d4fdb1f34b1638f1b1f9da4991b7cff58c43d542024e00bcde269f977143d698
```

上面的 hash 是该卡验收时的版本；当前文件 hash 以 A-bundle-verify 和文末为准。该卡本身只冻结 bundle 调用入口的价目与 tier 载体，不做最终发布、导入、CLI 或 authority 接线。

## A-bundle-verify：完整 draft 的只读校验（已接受）

- 新增 `verifyHistoryArchiveBundle(directory)`。它只读 `bundle.manifest.json`，严格校验 format 1 的顶层/main/segment 字段集合与字段类型；额外字段、未知格式、坏范围、坏计数或非法登记时间都整体失败。
- staging 在私有 `working` 快照上、清空 `archive_segments` 之前，把完整段描述写入 `store_meta` 的 `history_archive_bundle_segments_v1` 锚：每项包含 `segmentId`、相对 `databaseFile`/`manifestFile`、`databaseSha256`、范围、`eventCount` 和 `registeredAtMs`，外层带 `formatVersion: 1`。锚只写入私有副本，不写源库；随后 `createHistoryBackup()` 的既有 `store_meta` 表摘要把它纳入 main manifest。
- 所有引用路径先做词法检查，再以真实 bundle 目录为根做 `realpath` containment；绝对路径、盘符相对路径、含 `..` 的路径及解析到包外的 symlink/junction 都在打开数据库前以 `HISTORY_ARCHIVE_BUNDLE_PATH_ESCAPE` 拒绝。main 与全部 segment 路径先统一解析，随后才读取任何 main/segment 数据。
- main 复用 `verifyHistoryBackup()` 校验数据库/manifest/表摘要，再以只读连接要求 `archive_segments` 存在且行数为 0，并读取上述锚与 `bundle.manifest.segments` 做排序后的字段完整规范化比较；缺项、增项或任一字段（含 `registeredAtMs`）变化均返回 `HISTORY_ARCHIVE_BUNDLE_MISMATCH`。没有锚的旧 format 1 draft 同样拒绝，不做静默兼容或目录扫描推断。
- 每个段复用 `verifyHistoryArchiveCandidate()` 校验普通包与候选 metadata，再核对 `segmentId === databaseSha256`、manifest SHA-256、`startMs`、`endMs` 与 `eventCount`；重复段 id 或重叠范围失败，不会跳过坏段。
- 真实测试对完整 draft 首次 verify 成功；随后分别验证额外清单字段、删除 segments 项、篡改 `registeredAtMs`、增加 segments 项、篡改 `eventCount`、重复 id、重叠范围、删除段文件、追加段数据库字节、绝对路径、`..` 路径和包外 junction 均整体失败；恢复原清单/文件后再次 verify 成功。另由 main 副本构造无锚 format 1 包，确认以 `HISTORY_ARCHIVE_BUNDLE_MISMATCH` 拒绝。main 的锚也直接与 manifest 比较，源主库、WAL、registry、events、source 身份和 store_meta 仍保持不变。

```text
node --test --test-name-pattern="complete archive bundle stages hot facts and segments from one snapshot" test/history-archive.test.js
exit 0; 1 test, 1 pass; test duration 336.1289 ms; runner duration 414.0800 ms

node --test test/history-archive.test.js
exit 0; 9 tests, 9 pass; duration 1189.8990 ms

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked

npm.cmd run typecheck
exit 0

src/history-archive.js sha256 f71a8bfb4ad92f37b43bc2aa20e47027567c6c62ca5891ed3d59d271cc160ff8
test/history-archive.test.js sha256 660ae0414eb6c4b293ed06b2c3fdbf1c314cdbf99e06db6c129f0a2d831df76e
```

主审已接受私有 `store_meta` 锚与 manifest 段清单的严格比较；该卡只做完整包校验，不发布、导入、激活或接 CLI。锚依赖既有 main manifest 摘要而非独立签名，旧的无锚 format 1 draft 会被拒绝，hot facts 仍允许存在合法修订。

## A-bundle-publish：校验完成后写完成标记（已接受）

- 主审独立宿主定向 2/2 通过，575.9018 ms；接受已证的发布行为，但 CLI/import 接线仍未开始。
- 新增 `publishHistoryArchiveBundle(database, destinationDirectory, options)`（`src/history-archive.js:816`）。它只复用既有 `stageHistoryArchiveBundle()` 和 `verifyHistoryArchiveBundle()`，不另写一份 bundle 组装或校验逻辑。
- 目标目录仍由 staging 的一次非递归 `mkdir()` 独占创建；空目录或非空目录都已存在时均以 `HISTORY_ARCHIVE_STAGING_DESTINATION_EXISTS` 拒绝，不读取、覆盖或清理外部目录。成功测试同时断言空目标不产生 marker，非空目标的 sentinel 原样保留。
- staging 成功后先完整 verify，再以 `flag: "wx"` 排他写入 `bundle.complete.json`。marker 含 `formatVersion: 1`、bundle 的 `bundleFormatVersion`、`bundle.manifest.json` 的 SHA-256 和 ISO 时间 `completedAt`；marker 是后续导入的唯一提交门禁，但本卡没有实现导入。
- 成功返回 `directory`、`manifestFile`、`markerFile`、`marker` 和已验证的 `manifest`。真实测试确认返回路径、marker 版本/摘要/时间，并再次调用 bundle verify 成功。
- staging 成功后若 verify 或 marker 写入失败，catch 分支递归删除本次创建的整个目标目录并重抛原错误。真实失败测试把登记段的 `registered_at_ms` 改成 `-1`，使 verify 在 staging 之后失败；断言目标目录与 marker 均不存在，且源主库、WAL、registry 与 events 完全不变。
- 同一失败测试还直接把内置 `fs/promises.writeFile` 的 marker 路径替换为返回 `EACCES` 的包装函数，并调用 `syncBuiltinESMExports()` 让已加载模块观察到真实写入失败。发生的是 staging/verify 后的实际 marker 写入错误，不是只篡改 marker 形状；断言 publish 以 `EACCES` 拒绝、目标目录和 marker 都不存在，源主库/WAL/registry/events 不变。

```text
node --test --test-name-pattern="bundle publish|complete archive bundle" test/history-archive.test.js
exit 0; 2 tests, 2 pass; successful test 407.5006 ms; failure test 96.5734 ms; runner duration 583.0579 ms

node --test test/history-archive.test.js
exit 0; 10 tests, 10 pass; duration 1291.8136 ms

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked

npm.cmd run typecheck
exit 0

src/history-archive.js sha256 6c1b8c0cd050f39961d6555dee59dc372bca0b8e05c51bcf2df6c351ec6350e3
test/history-archive.test.js sha256 c9c3d8d789f1826e3baed44ab8a4d44aa385b26cc4927e4979ce5909aa5ea8b1
```

上面的测试时间和 hash 是该卡验收时的版本；当前文件 hash 以 A-published-gate 和文末为准。该卡不声明目录 rename 原子性或断电持久性：`main.sqlite`、段文件、`bundle.manifest.json` 和 marker 按普通文件写入依次出现，崩溃可能留下无 marker 的中间目录。marker 也没有独立签名；导入必须同时验证 marker 与 bundle，并从 marker 的摘要绑定 bundle manifest。

## A-published-gate：已发布包的完成标记门禁（已接受）

- 新增 `verifyPublishedHistoryArchiveBundle(directory)`（`src/history-archive.js:852`）。它先复用 `resolveBundleDirectory()`/`resolveBundleFile()` 的 realpath containment 解析目录、marker 和 manifest，只接受包内的 `bundle.complete.json` 与 `bundle.manifest.json`。
- marker 必须精确包含 `formatVersion`、`bundleFormatVersion`、`bundleManifestSha256`、`completedAt`。前两者必须为 1，摘要必须是小写 64 位 SHA-256，`completedAt` 必须是 `Date.toISOString()` 可往返的 UTC 毫秒格式；缺失、坏 JSON/截断、未知版本、坏摘要或坏时间均拒绝。
- marker 摘要绑定解析后的 manifest 原始字节。先比较一次，再调用既有完整 `verifyHistoryArchiveBundle()`；随后要求完整校验返回的 `manifestFile` 与先前解析路径完全相同，并从该同一路径重新计算摘要。这样不会在读 marker 后切换到另一份 manifest 去校验，manifest 仅追加空白等解析等价改动也会因原始字节摘要变化而拒绝。
- 成功返回完整 verify 结果并附绝对 `markerFile` 与 `marker`，供后继 import 使用；普通 `verifyHistoryArchiveBundle()` 保持 draft 语义，不会自动要求 marker。
- 真实测试复用已发布 bundle：成功 gate 可读；完整 draft 无 marker 时普通 verify 仍成功，而 published gate 以 `HISTORY_ARCHIVE_BUNDLE_NOT_FOUND` 拒绝；manifest 原始字节追加换行、错误 marker digest、截断 marker、未知版本和非规范 `completedAt` 均拒绝，恢复原文件后 gate 再次成功。

```text
node --test --test-name-pattern="complete archive bundle|bundle publish" test/history-archive.test.js
exit 0; 2 tests, 2 pass; test durations 416.2970 ms / 151.9270 ms; runner 642.8599 ms

node --test test/history-archive.test.js
exit 0; 10 tests, 10 pass; duration 1320.4897 ms

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked

npm.cmd run typecheck
exit 0
```

该卡不做导入、CLI、marker 签名或目录原子改名。Gate 读取 manifest 与完整 verify 之间仍有文件系统 TOCTOU 窗口；当前只把两侧绑定到同一 realpath 并在验证后重算原始字节，未使用文件锁或不可变句柄。

主审独立运行已发布 gate 用例 2/2 通过，总耗时 715.4934 ms。

## A2-candidate-failure：候选构建 SQLite 中断

- 生产模块未改。测试在真实临时 `UsageStore` 的 `events` 上创建 `BEFORE DELETE ... RAISE(ABORT, 'archive candidate deletion blocked')` 触发器；SQLite backup 会把该 schema 带入私有工作副本，因此候选范围外 events 的 DELETE 实际返回 ABORT，而不是测试直接抛错或注入生产 hook。
- 失败前临时源库含两条事件、`source_files` 身份和一条 `history_replaced_facts`；捕获源主库、`-wal`、事件行和恢复事实，并记录系统临时目录中既有 `codex-usage-archive-*` 目录集合。
- `test/history-archive.test.js:676` 断言 `createHistoryArchiveCandidate()` 以触发器错误拒绝；随后确认最终候选数据库与相邻 manifest 均不存在、没有新增私有工作目录、源主库与 WAL 字节不变、事件行和恢复事实完全不变。
- 该证据只覆盖同进程内 SQLite ABORT 后的正常 `finally` 清理。它不模拟 Windows 进程被杀、断电、文件系统掉电、磁盘写满或清理本身失败。

```text
node --test test/history-archive.test.js
exit 0; 5 tests, 5 pass; duration 400.477 ms

npx.cmd --no-install biome check test/history-archive.test.js
exit 0; 1 file checked

npx.cmd --no-install biome format --write test/history-archive.test.js
exit 0; formatted 1 file in 5 ms, no fixes applied
```

测试在宿主 Windows 沙箱外运行。该卡只修改 `test/history-archive.test.js` 和本报告；没有测试专用生产 hook、签名、崩溃守护程序、登记或删除。

## A-live-backup：执行器内历史包接点

- worker 新增 `backupHistory` 消息：先按既有 `snapshot` 路径对齐主线程价目，再调用 `createHistoryBackup(store.database, message.databaseFile, { serviceTierEvidence: store.serviceTierEvidence })`，完成后发布完整读侧 state 并返回 manifest。它不重新发现源文件、不复制原始日志，也不关闭或替换执行器的数据库连接。
- 客户端只新增 `backupHistory(destinationFile)`，请求形状固定为 `{ databaseFile, pricing: getPricingCatalog() }`。没有 server/CLI 路由、后台调度、覆盖目标或恢复动作。
- 只对 `sync` 和 `backupHistory` 使用 worker 内的单条 `syncBackupTail` 尾链：消息按到达顺序排队，前一个操作（包括失败结算）完成后才启动下一个。`dashboard`/`summarize`/`periodComparison`/`metadata` 等读请求仍走原直接分派，没有全局串行化。失败结果仍原样返回给对应请求，尾链自身吞掉结算异常以免毒化后续操作；`close` 语义未改。
- tier 证据取自 worker 内的实际 `UsageStore.serviceTierEvidence` resolver，而不是主线程经 `toWire()` 后的读侧快照；后者是 JSON 形状，不能作为 `createHistoryBackup()` 的 resolver 输入。`createHistoryBackup()` 原有的 `?? null` 语义未改，独立无 resolver 路径仍由既有 backup 测试覆盖。
- 第一组测试复用真实 Codex fixture：先用临时 `UsageStore` 导入 request timing，再关闭该连接，启动真实执行器并 `sync({ force: true })`；对拍 `status`、稳定 metadata、读侧 tier 快照和 `checkedAt`，同时记录源主库与 WAL 字节。随后单独调用 `backupHistory()`，断言包内价目可读取、空 tier 快照为 `{formatVersion:1,threads:[]}`、恢复 resolver 可用；调用前后已发布状态、源主库和 `-wal` 字节不变。
- 第二组测试建立临时 Codex home 的 `logs_2.sqlite`，写入非空 `priority` TurnInput 证据，并在两轮并发请求中分别把 `backupHistory` 排在 `sync` 前、以及把 `sync` 排在 `backupHistory` 前。前者包内事件仍是旧总值 `100000` 且 tier 快照为空；后者包内事件为新总值 `300000`、manifest 价目等于请求时主线程 catalog、tier snapshot 精确含该 thread 的 `priority` turn，恢复 resolver 对事件时刻返回 `priority`。这同时证明 barrier 两个方向的顺序。

```text
npx.cmd --no-install biome format --write src/usage-executor.js test/history-executor-backup.test.js
exit 0; 2 files formatted, no fixes applied

npx.cmd --no-install biome check src/usage-executor.js test/history-executor-backup.test.js
exit 0; 2 files checked

node --test test/history-executor-backup.test.js
exit 0; 2 tests, 2 pass; duration 5427.196 ms

node --test --test-concurrency=1 test/w1-executor.test.js
exit 0; 14 tests, 14 pass; duration 11602.2136 ms

npm.cmd run typecheck
exit 1; only pre-existing frozen-file errors in src/history-archive.js and src/history-backup.js; no error in the two A-live-backup files
```

新测试在宿主 Windows 沙箱外运行：沙箱内同目录硬链接发布返回 `EPERM`，宿主路径通过。该卡只修改 `src/usage-executor.js`、新建 `test/history-executor-backup.test.js` 和本报告；`src/history-archive.js`、`src/history-backup.js`、CLI、server 和 store 均未改。

## A-barrier-error：一次 backup 失败不毒化串行尾链

- 生产代码未改：现有 `serializeSyncBackup()` 把尾链下一段设为 `result.then(() => {}, () => {})`，失败的 backup 正常拒绝对应请求，但尾链本身已结算为成功，后续排队操作可以继续。
- 新用例先建立 `100000` 事实并完成一次 sync，再在目标路径写入外来字节；随后把 `backupHistory(collision)` 排在 `sync` 前。目标已存在使真实发布返回 `HISTORY_BACKUP_DESTINATION_EXISTS`，外来文件字节不变；已排队的 sync 仍成功。
- sync 后源事实改为 `200000`。对全新目标再次调用 `backupHistory()`，`verifyHistoryBackup()` 通过，包内 `events.total` 为 `[200000]`，证明失败没有阻塞后续操作，也没有让下一包停在旧事实。
- 没有新增队列框架、错误码、server/CLI、wire 或 close 改动；只修改 `test/history-executor-backup.test.js` 和本报告。

```text
npx.cmd --no-install biome format --write test/history-executor-backup.test.js
exit 0; 1 file formatted, no fixes applied

npx.cmd --no-install biome check test/history-executor-backup.test.js
exit 0; 1 file checked

node --test test/history-executor-backup.test.js
exit 0; 3 tests, 3 pass; duration 5556.7356 ms
```

测试在宿主 Windows 沙箱外运行，以允许同目录硬链接发布；没有访问生产库或真实服务。

## A-schema21：空归档目录兼容

- `src/history-backup.js` 保留冻结的 schema 19/20 表清单，并为 21 增加 `archive_segments`。`assertSupportedSchema()` 从实际 `PRAGMA user_version` 选择清单，manifest 也写该实际值，不再用当前 store 常量给旧库改标签。
- schema 21 缺 `archive_segments` 返回 `HISTORY_BACKUP_MISSING_TABLE`；空目录允许 backup、manifest 表指纹、verify 和 restore。只要目录有一行，create/verify/restore 共用的 schema gate 返回 `HISTORY_BACKUP_ARCHIVES_UNSUPPORTED`，因为包不包含外部段文件。
- 真实 `UsageStore` schema 21 测试完成 backup/verify/restore，恢复库的完整 event 行与原行一致；随后只插入一条 `archive_segments` 目录种子，新 backup 被上述错误码明确拒绝。该种子不表示外部文件被打包或可恢复。
- schema 20 用例在真实 store 上仅删除 v21 新增表并把 `user_version` 设为字面量 20，manifest 仍为 20 且不含 `archive_segments`；schema 19 用例删除 v20/v21 两张表并设为 19，源库字节保持不变，restore 后仍是 19。
- verify 用例从 schema 21 包删除 `archive_segments` 并同步外部摘要，仍以 `HISTORY_BACKUP_MISSING_TABLE` 拒绝；未知版本继续拒绝。

```text
npx.cmd --no-install biome format --write src/history-backup.js test/history-backup.test.js
exit 0; 2 files formatted

npx.cmd --no-install biome check src/history-backup.js test/history-backup.test.js
exit 0; 2 files checked

node --test test/history-backup.test.js
exit 0; 12 tests, 12 pass; duration 1117.2506 ms

node --test test/history-executor-backup.test.js
exit 0; 3 tests, 3 pass; duration 5583.8387 ms

node --test test/history-archive.test.js
exit 0; 5 tests, 5 pass
```

测试在宿主 Windows 沙箱外运行，以允许同目录硬链接发布。`test/history-cli.test.js` 的两个陈旧断言已由后继 A-cli21-contract 更新为精确的 `Schema: 21`，CLI 行为未改。

```text
npm.cmd run typecheck
exit 1; 仅 src/history-archive.js 与 src/history-backup.js 的既有 JSDoc 推断错误
```

只修改 `src/history-backup.js`、`test/history-backup.test.js` 和本报告；没有注册、删除、读取或导出任何外部段，也未修改 CLI/server/wire/store。

## A-cli21-contract：CLI schema 21 输出断言

- 只把 `test/history-cli.test.js` 中两条旧断言 `/^Schema: 20$/m` 改为精确的 `/^Schema: 21$/m`；没有放宽正则、改 CLI 代码或改变 manifest 校验字段。
- 首条真实包校验覆盖 `history verify` 从已验 manifest 输出 schema 21 与 event 计数；第二条覆盖未 checkpoint 源库经 CLI backup 后的包再次验证为 schema 21、事件总额仍为 37，并保留目标冲突与源库/WAL 字节不变断言。

```text
npx.cmd --no-install biome format --write test/history-cli.test.js
exit 0; 1 file formatted, no fixes applied

npx.cmd --no-install biome check test/history-cli.test.js
exit 0; 1 file checked

node --test test/history-cli.test.js
exit 0; 4 tests, 4 pass; duration 1359.8652 ms
```

测试在宿主 Windows 沙箱外运行一次，以允许既有硬链接发布用例。只修改 `test/history-cli.test.js` 和本报告；未运行全仓测试，也未进入 wire。

## A-wire-tier：跨线程恢复可调用 tier resolver

- worker 发布 state 和 `snapshot` 响应前，用现有 `serviceTierEvidenceSnapshot()` 把 resolver 转为纯 JSON；`null` 保持为 `null`。没有把函数或原始日志跨线程传递，也没有改全局 `toWire()` 的 JSON 策略。
- 主线程收到 state 或 `snapshot` 响应时，只在该边界用现有 `serviceTierEvidenceFromSnapshot()` 重建 resolver。普通响应、价目与 manifest 形状不变；没有新增类、模块或全局状态。
- 真实 priority 测试在 `sync` 后断言 `executor.serviceTierEvidence.resolve(...) === "priority"`，串行 `snapshot` 返回的 resolver 也返回 `priority`。随后追加更晚的 `default` tier 并再次 `sync`，当前 resolver 返回 `default`，先前 snapshot resolver 仍返回 `priority`，证明旧快照不随下一轮变化。

```text
npx.cmd --no-install biome format --write src/usage-executor.js test/history-executor-backup.test.js
exit 0; 2 files formatted

npx.cmd --no-install biome check src/usage-executor.js test/history-executor-backup.test.js
exit 0; 2 files checked

node --test test/history-executor-backup.test.js
exit 0; 3 tests, 3 pass; duration 5634.6982 ms

node --test test/w1-executor.test.js
exit 0; 14 tests, 14 pass; duration 11409.631 ms

npm.cmd run typecheck
exit 1; 仍是 src/history-archive.js 与 src/history-backup.js 的既有 JSDoc 推断错误，executor 无新增错误
```

测试在宿主 Windows 沙箱外运行，以允许既有硬链接发布。A-wire-tier 本身只测串行 `snapshot` resolver；后继 A-snapshot-barrier 补上它与 sync/backup 的排队关系，close 与故障交错仍另卡。

## A-snapshot-barrier：snapshot 纳入 sync/backup 串行尾链

- 只把消息分派条件扩为 `sync`/`backupHistory`/`snapshot` 共用现有 `serializeSyncBackup()` 尾链；`dashboard`、`summarize`、`periodComparison`、`metadata` 仍直接分派，`close` 语义未改，没有新增队列。
- 真实 tier/usage 用例先发 `sync`（200000 + priority）再发 `snapshot`，冻结库与 resolver 均为本轮 `[200000]`/`priority`，snapshot 返回的 status fingerprint 等于该次 sync 结果。反向先发 snapshot 再发 sync（300000 + 更晚 default），旧 snapshot 仍冻结 `[200000]`、旧 status fingerprint 与 priority；后续 sync 完成后当前 resolver 为 default，旧 snapshot 不变。
- 该用例有 3 组核心断言，同时覆盖“snapshot 先到则后续 sync 等其 SQLite backup 完成”和“sync 在飞则 snapshot 等它发布后再冻结”。

```text
npx.cmd --no-install biome format --write src/usage-executor.js test/history-executor-backup.test.js
exit 0; 2 files formatted, no fixes applied

npx.cmd --no-install biome check src/usage-executor.js test/history-executor-backup.test.js
exit 0; 2 files checked

node --test test/history-executor-backup.test.js
exit 0; 4 tests, 4 pass; duration 5757.6508 ms

node --test test/w1-executor.test.js
exit 0; 14 tests, 14 pass; duration 11457.6047 ms
```

测试在宿主 Windows 沙箱外运行。没有扩展 `dashboard` 等读请求串行化；`close` 与排队 snapshot 的关系由后继 A-close-drain 覆盖，故障交错仍按既有 W3 用例回归。

## I-full-wire：完整已发布用量事件读取接缝

- worker 新增 `publishedUsageEvents` 消息并只调用 `store.publishedUsageEvents()`；client 新增同名 Promise 方法。没有在 executor 里另写 SQL、事件映射或 raw session/quota/freeze 读取。
- 该消息加入 `sync`/`backupHistory`/`snapshot` 共用的一条现有串行尾链；`dashboard`、`summarize`、`periodComparison`、`metadata` 仍直接分派。响应继续经既有 `toWire()` 返回纯 `UsageEvent[]`，没有复活 `Date`，timestamp 保持字符串。
- 新增真实临时 project-log 用例：导入总额 `123` 的单事件，移除 `importDirs` 后 sync 并断言 source 身份为 missing project-log；随后请求完整 published events，恢复 importDir 后再 sync 并核对事件总 token 仍为 `123`，用于证明恢复不重复。
- B 已补上 `UsageStore#publishedUsageEvents()`；主审独立运行该用例 1/1 通过。当前聚焦文件 6/6 通过，原始事件载荷与恢复无重复断言已实际执行。executor 仍只转发 store 结果，没有本地 parser。

```text
npx.cmd --no-install biome format --write src/usage-executor.js test/history-executor-backup.test.js
exit 0; formatted 2 files, no fixes applied

npx.cmd --no-install biome check src/usage-executor.js test/history-executor-backup.test.js
exit 0; 2 files checked

node --test test/history-executor-backup.test.js
exit 0; 6 tests, 6 pass; duration 5944.3936 ms
```

完整文件在宿主 Windows 沙箱外运行以允许既有硬链接发布；published-events、close-drain 与原有备份/屏障用例全部通过。

## A-close-drain：close 在既有串行尾链之后释放库

- 只把 `close` 加入 `sync`/`backupHistory`/`snapshot`/`publishedUsageEvents` 共用的既有尾链；`dashboard`、`summarize`、`periodComparison`、`metadata` 仍直接分派。客户端原有 5 秒 close 保护值和 `terminate()` 兜底未改。
- 真实临时 Codex 用例先同步 `100000` 事实，同一 tick 内发出 snapshot 后立即 `close()`；第二次 `close()` 返回同一 Promise。随后断言已排队 snapshot 可读且总 token 为 `[100000]`，并断言 `executor.alive === false`。
- 错误仍按原消息响应结算；聚焦文件中的 backup 目标碰撞用例继续证明对应请求收到自己的错误，未因尾链或 close 被吞掉。

```text
node --test --test-name-pattern="close drains a queued snapshot" test/history-executor-backup.test.js
exit 0; 1 test, 1 pass; duration 5223.622 ms

node --test test/history-executor-backup.test.js
exit 0; 6 tests, 6 pass; duration 5944.3936 ms

node --test --test-name-pattern="close" test/w3-fault.test.js
exit 0; 4 tests, 4 pass; duration 6453.0487 ms
```

完整文件在宿主 Windows 沙箱外运行以允许既有硬链接发布。W3 既有 4 项 close 回归继续证明崩溃竞争、重复 close、失败后 close 和 worker 不累积。新用例只证明一个已排队 snapshot 在 close 前完成；普通读仍不排队，但没有新增“close 等待期间普通读持续完成”的时序断言。

## I-full-carrier-wire：一次读取完整 published usage report

- worker 新增 `publishedUsageReport` 消息，client 新增同名 Promise 方法。handler 在同一个同步块内依次返回 `events: store.publishedUsageEvents()`、`homes: store.publishedUsageHomes()`、`sessions: store.publishedUsageSessions()`，没有 `await`、`Promise.all` 或三次独立 RPC；该消息加入现有 sync/backup/snapshot/events/close 尾链。
- 原有 `publishedUsageEvents` 消息和 client 方法保持不变；新增载体没有 quota、price 或 session 原始元数据字段。
- 真实临时用例同时导入一个 project-log home 与一个 extra Codex home。移除 `importDirs`/`extraHomes` 后 sync，核对事件 session/source kind、事件 homeId 对应 persistent home、两个 home 的原 kind 和 session 数；恢复两个来源后再 sync，三者与移除前快照完全一致，证明无重复。
- B 随后补上 `UsageStore#publishedUsageSessions()`；本用例在真实执行器上通过，事件/home 身份/session 数量/原 kind 以及移除后保留、恢复后不重复断言均已执行。executor 没有用本地事件推断替代 store 方法。

```text
npx.cmd --no-install biome format --write src/usage-executor.js test/history-executor-backup.test.js
exit 0; formatted 2 files, no fixes applied

npx.cmd --no-install biome check src/usage-executor.js test/history-executor-backup.test.js
exit 0; 2 files checked

node --test --test-name-pattern="executor publishes one carrier" test/history-executor-backup.test.js
exit 0; 1 test, 1 pass; duration 5245.0823 ms

node --test test/history-executor-backup.test.js
exit 0; 7 tests, 7 pass; duration 6521.9502 ms
```

完整文件在宿主 Windows 沙箱外运行以允许既有硬链接发布；published-events、composite carrier、close-drain 与原有备份/屏障用例全部通过。

## I-full-quota-wire：quota 观测随完整 published usage report 跨移除/恢复

- handler 只返回 `store.publishedUsageReport()`，不再自行组合三次 store 调用。B 的 store 方法在同一 `SAVEPOINT` 内返回 `events`、`homes`、`sessions` 与 `rateLimitObservations`；本卡没有改 store、server、CLI 或串行尾链。
- 新 handler 的返回值仍经既有 `toWire()` JSON 序列化到客户端。quota 载体是 `UsageStore#quotaObservations()` 的规范纯对象映射，不包含窗口边界、状态、倒计时或任何按当前时钟派生的字段。
- 真实临时 Codex 用例写入一条原生 `payload.rate_limits`，同时包含 primary（300 分钟、42.5%）与 secondary（10080 分钟、`used_percent: null`）。删除整个来源 home 后 sync，完整观测快照仍原样返回；恢复同一 home 并再 sync，快照仍逐字段一致且没有重复。

```text
node --test --test-name-pattern="executor quota carrier survives source removal and restore" test/history-executor-backup.test.js
exit 0; 1 test, 1 pass; test duration 170.2537 ms; runner duration 5279.9961 ms

node --test test/history-executor-backup.test.js
exit 0; 8 tests, 8 pass; duration 6191.1293 ms

npx.cmd --no-install biome check src/usage-executor.js test/history-executor-backup.test.js
exit 0; 2 files checked
```

聚焦文件在宿主 Windows 沙箱外运行以允许既有硬链接发布。本卡没有新增 quota 窗口推导、codec、独立 RPC 或原始日志重读；只把 B 的单快照结果接到既有 composite carrier。

## A-freeze-price-oracle：请求捕获 catalog A，主线程切到 B

- 复用真实 Codex 的临时 `tierOptions()` 夹具，把 `gpt-6-sol` 的 short input 费率设为 catalog A，并先在该价目下执行一次 `summarize({ preset: "all" })` 取得实际 `totalUsd`。
- 发起 `executor.backupHistory(destination)` 后**立即但不等待**在主线程调用 `setPricingCatalog()` 切到 catalog B（input 再增加 1）；随后才 await 包完成。
- 包 manifest 的 `pricing.catalog` 仍与 A 完全相等；切到 B 后同一 summary 的 `totalUsd` 与 A 不相等，证明 B 已真实参与金额计算，而不是只比较目录版本号。
- 测试开始时保存原 catalog，`finally` 用 `setPricingCatalog(originalCatalog)` 恢复，而不是假定默认价目；随后关闭执行器并删除临时目录。生产 executor、pricing、backup、server 和 CLI 文件均未修改。

```text
node --test --test-name-pattern="backupHistory captures catalog A while global pricing changes to B" test/history-executor-backup.test.js
exit 0; 1 test, 1 pass; test duration 133.0333 ms; runner duration 5205.5176 ms

node --test test/history-executor-backup.test.js
exit 0; 9 tests, 9 pass; duration 6368.9305 ms

npx.cmd --no-install biome check test/history-executor-backup.test.js
exit 0; 1 file checked
```

定向测试首次在普通沙箱内运行被既有 Windows 硬链接限制拒绝（`EPERM`），随后在宿主 Windows 沙箱外通过；该失败发生在包发布，不是价目断言失败。

## A-freeze-price-transfer：新进程从包内 catalog A 复现业务费用

- 在 `A-freeze-price-oracle` 的同一个包里，创建时 `costA` 现在保存完整的三字段对象：实际 `totalUsd`、`currencies`、`pricedRecords`。
- 包发布后父进程仍处于 catalog B。测试启动独立 Node 新进程，调用 `loadHistoryBackupContext(destination)`，明确用 `setPricingCatalog(context.pricingCatalog)` 应用包内 A，再以只读 `UsageStore` 对已备份事实执行 `summarize({ preset: "all" })`。
- 新进程返回的 `{ totalUsd, currencies, pricedRecords }` 与创建时的 `costA` 深相等；同时父进程在 B 下的 `totalUsd` 与 A 不相等。核心断言共 3 个：manifest catalog 为 A、新进程费用对象等于 A、B 金额不同于 A。
- 未修改生产文件，没有让 CLI/restore 自动激活价目，也没有新增通用恢复器；子进程只复用了既有 verify/context 与只读 store 读路径。

```text
node --test --test-name-pattern="backupHistory captures catalog A while global pricing changes to B" test/history-executor-backup.test.js
exit 0; 1 test, 1 pass; test duration 221.3769 ms; runner duration 5305.857 ms

node --test test/history-executor-backup.test.js
exit 0; 9 tests, 9 pass; duration 6386.0155 ms

npx.cmd --no-install biome check test/history-executor-backup.test.js
exit 0; 1 file checked
```

定向与聚焦测试均在宿主 Windows 沙箱外运行，以允许既有硬链接包发布。

## A-freeze-tier-HTTP-oracle：HTTP freeze 后 tier 日志改写

- 用临时原生 `.codex` home 写入一个 `gpt-6-sol` rollout 和真实 `logs_2.sqlite` 中同一 thread 的 `priority` TurnInput；服务设置 `automaticDiscoveryEnabled: false`，保持价目/discovery 确定性，仅使用临时端口与临时库。
- 通过 `/api/summary?preset=all&freeze=1` 建快照，初始 `costEstimate.serviceTierUnknownRecords=0`。随后删除并重写 `logs_2.sqlite`，新行为更高 ID 的 `service_tier: Some(None)`（落为 unknown），再请求 live summary 触发刷新。
- 同一 snapshot ID 的 summary 仍返回创建时的 `{ totalUsd, serviceTierUnknownRecords, serviceTierUnknownTokens, pricedRecords }`；live summary 则变成 `unknownRecords=1`、`unknownTokens=100000`，且 `totalUsd` 与冻结值不同。核心断言 3 个：冻结时 priority 无 unknown、重查快照费用对象不变、live unknown 计数与实际金额均变化。
- 未修改 `src/server.js`，未重启正式服务；本卡不证明 backup 完成到 HTTP 建副本之间的窗口，只证明当前 `createSnapshot` 使用 executor 返回的冻结 tier resolver 后，来源日志继续变化不会污染已建 HTTP snapshot。

```text
node --test --test-name-pattern="HTTP snapshot keeps priority tier evidence after the live tier log changes" test/history-retention-api.test.js
exit 0; 1 test, 1 pass; test duration 191.3901 ms; runner duration 5304.0612 ms

node --test test/history-retention-api.test.js
exit 0; 4 tests, 4 pass; duration 6308.5509 ms

npx.cmd --no-install biome check test/history-retention-api.test.js
exit 0; 1 file checked
```

## A-freeze-price-HTTP-oracle：已接受反例（后续 server 修复）

- 复用上卡临时原生 Codex fixture，服务保持 `automaticDiscoveryEnabled: false`。等 `/api/pricing` 完成 `loadPricingFile()` 后，把 `gpt-6-sol` 的 short/long 与 fast short/long input 费率相对原 catalog 加 1，记为 A；在 A 下请求 `/api/summary?preset=all&freeze=1`，冻结响应金额为 `0.5` USD。
- 再用现有 `setPricingCatalog()` 把同一组 input 费率再加 1（catalog B）。live summary 如预期变为 `totalUsd=0.6`，证明 B 已真实参与计价。
- 但用原 `snapshotId` 重查，同一个快照也返回 `totalUsd=0.6`，不是创建时的 `0.5`；两次响应其它费用字段均为 `serviceTierUnknownRecords=0`、`serviceTierUnknownTokens=0`、`pricedRecords=1`。当前 HTTP snapshot 只冻结了数据库事实与 tier resolver，摘要计价仍读取主进程当前 catalog，因此未满足“冻结费用仍 A”。
- 测试核心断言 2 个：live 金额为 A+0.1（B 生效）；同 snapshot 费用对象仍等于创建时 A。第二项按当前实现失败。测试在 `finally` 恢复原 catalog，生产 server/pricing/store 均未修改；没有通过放宽金额或改写字段掩盖反例。

```text
node --test --test-name-pattern="HTTP snapshot keeps catalog A pricing after live pricing changes to B" test/history-retention-api.test.js
exit 1; 1 test, 0 pass; test duration 184.8356 ms; runner duration 5301.031 ms

actual snapshot after B:   {"totalUsd":0.6,"serviceTierUnknownRecords":0,"serviceTierUnknownTokens":0,"pricedRecords":1}
expected snapshot at A:    {"totalUsd":0.5,"serviceTierUnknownRecords":0,"serviceTierUnknownTokens":0,"pricedRecords":1}

node --test test/history-retention-api.test.js
exit 1; 5 tests, 4 pass, 1 fail; duration 6536.247 ms

npx.cmd --no-install biome check test/history-retention-api.test.js
exit 0; 1 file checked
```

## A-snapshot-price-carrier：snapshot 响应携带 A

- `src/usage-executor.js:348` 的 snapshot handler 在 `applyPricingCatalog(message.pricing)` 后、任何 `await` 前调用 `getPricingCatalog()`，把结果作为 `pricingCatalog` 放入 snapshot 响应。请求仍复用客户端已有的 catalog 载荷，没有修改 pricing 模块、消息集合或 server。
- `test/history-executor-backup.test.js:247` 复用真实 tier fixture：catalog A 下同步到 200,000 tokens 和 priority 证据；先发 `executor.snapshot()`，随后主线程立即切到 catalog B，再等待排队中的 sync 与 snapshot。
- 冻结响应中的 `pricingCatalog` 仍等于 A；同一快照数据库仍是 200,000 tokens，tier resolver 仍为 `priority`，同时主线程 catalog 已是 B。核心断言 2 个：主线程为 B；carrier A 与同轮事实/tier 一致。
- 该卡未改 `src/server.js`；后续 server 接线已独立落地并应用 carrier，当前 HTTP API 聚焦文件 5/5 通过。

```text
node --test --test-name-pattern="snapshot carries catalog A after the main thread switches to B" test/history-executor-backup.test.js
exit 0; 1 test, 1 pass; test duration 164.8396 ms; runner duration 5264.9098 ms

node --test test/history-executor-backup.test.js
exit 0; 10 tests, 10 pass; duration 6543.1261 ms

npx.cmd --no-install biome check src/usage-executor.js test/history-executor-backup.test.js
exit 0; 2 files checked
```

普通沙箱内聚焦文件仍因既有 Windows 硬链接发布返回 `EPERM`；上述 10/10 结果在宿主 Windows 沙箱外取得。

## A-freeze-price-scope-error：成功与失败后的价目作用域恢复

- 扩展现有 A/B HTTP 用例：catalog A 下创建快照并切到 B 后，成功读取同一 snapshot 仍返回 A 费用；随后断言主线程 catalog 仍为 B，且再次请求 live summary 仍按 B 计价。
- 测试局部替换主线程 `UsageStore.prototype.summarize` 使其抛出一次真实错误（worker 使用独立模块实例，不受影响）。同一 snapshot 请求返回 500，失败后主线程 catalog 仍为 B；恢复 prototype 后同一旧 snapshot 再次返回 A。
- 核心断言共 3 个：成功路径 live=B 且请求后 catalog 仍 B；snapshot=A；失败返回 500、失败后 catalog=B，恢复后 snapshot 仍 A。测试 `finally` 始终恢复 prototype、原 catalog 和 server。
- 未新增生产 hook，未修改 server/pricing/store；未测试并发请求、更多错误阶段或非 `summarize` 抛错路径。

```text
node --test --test-name-pattern="HTTP snapshot keeps catalog A pricing after live pricing changes to B" test/history-retention-api.test.js
exit 0; 1 test, 1 pass; test duration 259.1996 ms; runner duration 5373.771 ms

node --test test/history-retention-api.test.js
exit 0; 5 tests, 5 pass; duration 6483.2311 ms

npx.cmd --no-install biome check test/history-retention-api.test.js
exit 0; 1 file checked
```

## A-freeze-pricing-endpoint-oracle：已接受反例（server 已修复）

- 沿现有 A/B HTTP 用例补 `GET /api/pricing?snapshot=<id>`。同一 snapshot 的 summary 费用仍为 A 的 `0.5` USD，但 pricing 端点返回 live catalog B，未返回创建快照时冻结的 A。
- 最小反例字段：端点 `version=2026-10-23-f574b246dc65`、`gpt-6-sol` input rates `{ short: 4, long: 6, fastShort: 6, fastLong: 10 }`；期望冻结值 `version=2026-10-22-3be6d15278cf`、rates `{ short: 3, long: 5, fastShort: 5, fastLong: 9 }`。summary 费用对象仍为 `{ totalUsd: 0.5, serviceTierUnknownRecords: 0, serviceTierUnknownTokens: 0, pricedRecords: 1 }`。
- 该卡只增加 1 个核心断言，覆盖 pricing 端点与 snapshot 费用的组合；未扩 PUT/refresh，也未修改 server/pricing/store。端点当前展开 `getPricingCatalog()`，`usageCoverage` 也以 live models 计算；本反例只提交实际不一致的 version/rates，未单独构造 coverage 差异。
- server 现已改为选择 `snapshot.pricingCatalog`，并把同一 catalog 显式传给 `usageCoverage`，不切换全局价目；主审独立复现修复前 0/1，修复后原用例 1/1 通过。

```text
node --test --test-name-pattern="HTTP snapshot keeps catalog A pricing after live pricing changes to B" test/history-retention-api.test.js
exit 1; 1 test, 0 pass; test duration 223.5603 ms; runner duration 5355.6193 ms

npx.cmd --no-install biome check test/history-retention-api.test.js
exit 0; 1 file checked
```

## A-freeze-pricing-coverage：snapshot coverage 使用 A

- 用一个临时原生 Codex rollout 让 `coverage-only-probe` 成为活跃模型；catalog A 增加该模型，冻结后在 catalog B 中删除它。
- 同一 snapshot 的 `GET /api/pricing` 仍返回 A 的 version，`usageCoverage` 为 matched 1、missing 空；live pricing 为 B，`usageCoverage` 为 matched 0、missing `coverage-only-probe`。旧 snapshot summary 的费用对象仍等于冻结时的 A。
- 核心断言 1 个，组合 version、两侧 public `usageCoverage` 模型结果与旧 summary 费用；未新增 fixture helper 形态，只给现有 rollout helper 增加了模型/时间参数。
- 未修改 server/pricing/store，未扩 PUT/refresh；测试 `finally` 恢复原 catalog 和 server。

```text
node --test --test-name-pattern="snapshot pricing coverage stays on catalog A after live catalog drops its model" test/history-retention-api.test.js
exit 0; 1 test, 1 pass; test duration 179.6269 ms; runner duration 5300.1758 ms

node --test test/history-retention-api.test.js
exit 0; 6 tests, 6 pass; duration 6847.7934 ms

npx.cmd --no-install biome check test/history-retention-api.test.js
exit 0; 1 file checked
```

## A-CLI-export：新目录完整包导出 CLI（已接受）

- 新增 `history export <sourceDB> <newDirectory> [--home-dir <dir>]`，沿用现有 CLI 的严格位置参数、帮助和错误风格。命令先经既有 `loadPricingFile(reportOptions(args))` 加载当前价目，再以只读连接打开源库，调用已接受的 `publishHistoryArchiveBundle()` 完成 staging、完整 verify 与排他 marker。
- 显式传入 `--home-dir` 时，只用该目录下的 `logs_2.sqlite` 调用既有 `loadServiceTierEvidence()`，并把 resolver 交给 bundle；不发现其它 home、不复制原始日志、不导入或启用包。未传时 tier 证据为 `null`，与既有“未捕获”语义一致。
- 成功输出包目录、`bundle.manifest.json`、`bundle.complete.json` 和源库未改的明确提示。已存在的非空或空目标仍由冻结的 staging 入口拒绝；登记段缺失、候选损坏或 marker 失败均返回带错误码的 `History bundle export failed: ...`，不留下完成包。
- 真实用例使用临时 `UsageStore`：登记一个只含范围内事件的候选，同时保留一条热事件；在 `--home-dir` 下建立真实 `logs_2.sqlite` priority 证据和自定义价目。CLI 成功后重验 published bundle，并检查 main 中热/范围事件、段内事件、manifest 价目与恢复 resolver；源主库及 `-wal` 字节不变。
- 另外两项真实 CLI 用例覆盖既有目标 sentinel 不变，以及删除登记段文件后失败且目标目录不存在。没有新增 import、源发现、服务切换或生产库访问。

```text
node --test --test-name-pattern="history export" test/history-cli.test.js
exit 0; 3 tests, 3 pass; duration 712.4193 ms

node --test test/history-cli.test.js
exit 0; 7 tests, 7 pass; duration 2118.7389 ms

npx.cmd --no-install biome check src/cli.js test/history-cli.test.js
exit 0; 2 files checked

npm.cmd run typecheck
exit 0

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

成功发布的测试在宿主 Windows 沙箱外运行，因为包 staging 的同目录硬链接在沙箱内返回 `EPERM`。该卡只修改 `src/cli.js`、`test/history-cli.test.js` 和本报告；`src/history-archive.js`、`src/history-backup.js` 未改。它不证明导入、源发现、CLI 到发布之间的并发一致性、目录 rename 原子性、fsync/断电持久性，也不消除既有 marker/manifest TOCTOU。

主审独立运行 `history export` 用例 3/3 通过，总耗时 1367.7282 ms；A-CLI-export 已接受。

## A-import-stage：已发布包的便携复制

- 新增 `stagePublishedHistoryArchiveBundle(sourceDirectory, newDirectory)`。入口先调用 `verifyPublishedHistoryArchiveBundle()` 验证源 marker、manifest 与完整包，再以 `mkdir()` 独占创建目标；既有目录（包括空目录）返回 `HISTORY_ARCHIVE_STAGING_DESTINATION_EXISTS`，不触碰其内容。
- 只复制 manifest 已声明的 main database、main manifest、每个登记段的 database/manifest 以及 bundle manifest，全部沿用包内相对路径并使用 `COPYFILE_EXCL`。源目录中未知额外文件不会被复制；每个源路径和目标路径都经过既有相对路径、`..`、绝对路径及 realpath containment 检查。
- bundle manifest 复制完成后，先对目标执行完整 draft verify，最后才复制 `bundle.complete.json`；随后再次调用 published verify 并返回目标包的已验证结果。任一步骤失败都只删除本次新建的目标目录，已有目标、源包和在线库不被修改。
- 该接点只产生可再次验证的便携副本，不登记、不重写 main、不启用或导入包，也不解除旧单库 backup 的 `archive_segments` guard；CLI 未改。
- 真实用例建立一个已发布、含登记段与 tier 上下文的包，并放入未知额外文件。复制后删除整个源包，目标仍通过 published gate，main 事件、价目 catalog 与 tier resolver 均与复制前一致，未知文件未进入目标。
- 另外两项用例覆盖：空既有目标、缺失 marker、坏 marker 均拒绝且不产生目标；复制 main database 时注入真实 `copyFile` `EIO`，新目标被清除，源包全部声明文件字节不变，另一个既有目标及其 sentinel 不变。

```text
node --test --test-name-pattern="published bundle staging" test/history-archive.test.js
exit 0; 3 tests, 3 pass; duration 727.4777 ms

node --test test/history-archive.test.js
exit 0; 13 tests, 13 pass; duration 2585.8560 ms

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked

npm.cmd run typecheck
exit 0

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

测试在宿主 Windows 沙箱外运行，因为建立源 published bundle 仍需同目录硬链接发布。未测并发改写源包、多个大段、磁盘写满、目标目录被外部并发写入、进程崩溃、fsync 或目录 rename；初始 verify 到实际复制之间仍有普通文件系统 TOCTOU，目标完整 verify 只能发现不匹配，不能阻止源在窗口内被替换。

## A-import-runtime：新目录不可变包与独立 runtime 副本（已接受）

- 新增 `materializePublishedHistoryArchiveRuntime(sourceDirectory, newDirectory)`（`src/history-archive.js:1052`）。入口以 `mkdir()` 独占创建新 import 目录；空目录或非空既有目录都返回 `HISTORY_ARCHIVE_IMPORT_DESTINATION_EXISTS`，不触碰其中内容。
- 复用已接受的 `stagePublishedHistoryArchiveBundle()` 把 published package 复制到 `<import>/bundle/`，随后再次验证源 published gate 与冻结副本，并要求两者的 manifest 摘要仍一致。复制后源包被删除不影响冻结副本。
- 从已验证的 `bundle/main.sqlite` 用平台 SQLite `backup()` 创建独立 `<import>/runtime.sqlite`，不复制或改写 bundle 的数据库、段 manifest 或 completion marker。
- runtime 的 `archive_segments` 在一个 `BEGIN IMMEDIATE` 事务中重建：每条 registry 路径都解析到新 `<import>/bundle/` 内的真实文件，同时保留 segment SHA-256、范围、事件数、`registered_at_ms` 与 `store_meta.history_archive_event_authority` 原值。事务失败即回滚；任一步失败只删除本次创建的 import 目录。
- 返回 `{ runtimeFile, bundleDirectory, loadBundleContext }`。`loadBundleContext()` 每次先重新验证冻结 published bundle，再经既有 `loadHistoryBackupContext()` 返回 manifest 价目与 tier resolver；runtime 本身不是由原 manifest 认证的 backup package。
- 真实用例删除原 published package 与候选目录后，以新 `UsageStore` 打开 runtime：registry 只指向冻结 bundle，cold 段整行与合并后的 cold＋hot 事实和删除前一致，`history_archive_event_authority` 原值不变，context 仍解析出 priority tier；冻结 bundle 全部声明文件字节保持不变。
- 另两项用例分别通过注入 `archive_segments` 的 SQLite `BEFORE INSERT ... RAISE(ABORT)` 触发器证明 registry 写失败会清除整个新 import 目录且源包字节不变，以及空/非空既有目标均不被覆盖。

```text
node --test --test-name-pattern="import runtime" test/history-archive.test.js
exit 0; 3 tests, 3 pass; duration 926.5043 ms

node --test test/history-archive.test.js
exit 0; 16 tests, 16 pass; duration 3577.5225 ms

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked

npm.cmd run typecheck
exit 0

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

该接点不写 import completion marker、不改 `src/usage-store.js` 或 SQLite schema、不接 CLI，也不切换运行服务。source 到复制之间仍有文件系统 TOCTOU；未证明 fsync、目录 rename 原子性、断电/进程崩溃收敛、多个大段、并发写者或跨机器导入。

主审独立运行 import runtime 用例 3/3 通过，耗时 958.2351 ms；A-import-runtime 已接受。

## A-CLI-import：新目录离线导入与最后 marker（已接受）

- 新增 `codex-usage history import <publishedBundleDir> <newImportDir>`，沿用现有 history 子命令的严格位置参数和错误输出风格。CLI 只调用 `publishHistoryArchiveImport()`，成功输出 `runtime.sqlite`、冻结 bundle 与 `import.complete.json` 的绝对路径，并明确 `Online service was not switched.`。
- `publishHistoryArchiveImport()` 复用已接受的 `materializePublishedHistoryArchiveRuntime()`；materialize 返回前已关闭 runtime。helper 随后重新验证冻结 published bundle 与 runtime registry、authority 和 `quick_check`，全部成功后才以 `flag: "wx"` 写入最后一个 `import.complete.json`。
- marker format 1 只记录不可变 bundle manifest 的 SHA-256、相对路径 `runtime.sqlite` 和 ISO `completedAt`。它不包含 runtime 摘要，也不声明 fsync/断电耐久、目录 rename 原子性或运行后 runtime 的永久认证。
- 新 import 目录仍由 materialize 独占创建；draft、坏 marker 或已有空/非空目标均返回非零。marker 写失败会清除本次 materialize 创建的全部内容；既存目标不会被删除或覆盖。
- 真实 CLI 用例先导出含 cold 段、authority 和 priority tier 的 published bundle，再由独立子进程导入；删除原 published package 后，新进程读取 runtime 的 registry、cold 行、cold＋hot 合并结果与 bundle context 仍正确，且 registry 路径只指向新冻结 bundle。
- 第二项用例覆盖缺 marker 的 draft、坏 marker，以及已有空/非空目标；全部退出 1、无 stdout、无新 marker，现有 sentinel 保持。第三项通过子进程 `--require` 预载 hook 让真实 `writeFile("import.complete.json")` 抛出 `EACCES`，证明失败后整个新 import 目录不存在、源 published package 仍可验证。

```text
node --test --test-name-pattern="history import" test/history-cli.test.js
exit 0; 3 tests, 3 pass; duration 1928.7080 ms

node --test test/history-cli.test.js
exit 0; 10 tests, 10 pass; duration 4080.6415 ms

npx.cmd --no-install biome check src/cli.js src/history-archive.js test/history-cli.test.js
exit 0; 3 files checked

npm.cmd run typecheck
exit 0

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

该卡没有接 server、自动使用 runtime、公开 cold carrier/summary 或服务切换。未证明 marker 写后的 fsync/断电耐久、目录 rename 原子性、并发 import、外部目标竞态、多个大段、大包磁盘写满或跨机器路径/ACL；marker 是当前 import 树的完成门禁，不是 runtime 内容的永久摘要认证。

主审独立运行 import 用例 3/3 通过，耗时 1891.8955 ms；A-CLI-import 已接受。该卡仍只证明 CLI 最后 marker 与进程内失败清理，不把 marker 解释为 runtime 字节的永久认证。

## A-import-open-gate：完成导入的只读打开门禁（已接受）

- 新增只读 `loadHistoryArchiveImport(directory)`。入口要求并严格校验 `import.complete.json` 恰好包含 `formatVersion`、`bundleManifestSha256`、`runtimeFile`、`completedAt`；拒绝错误格式、非规范 ISO 时间、非法摘要，以及空、绝对或越界 `runtimeFile`。
- 入口先通过 `verifyPublishedHistoryArchiveBundle()` 重验冻结 `bundle/`，再把 marker 中的 manifest 摘要绑定到已验证 bundle。随后只读打开 `runtime.sqlite`，执行 `quick_check`，核对 registry 数量、包内路径、段摘要/范围/计数/登记时间和 authority；成功返回冻结 bundle manifest 与 verify-first context。
- 测试覆盖：删除原 published package 后仍能从完成导入读取 registry、manifest 与 context（打开时内部核对 authority），且 runtime、marker、bundle 字节均不变；缺 marker、malformed marker、摘要不符、相对/绝对越界路径分别拒绝；缺段和 runtime registry 被改写均失败且不写 runtime、marker 或 bundle main。
- 该入口每次打开都重验当前文件，但不把导入时的 runtime 字节摘要作为永久认证，也不证明 marker/bundle/runtime 验证到后续使用之间没有文件系统 TOCTOU；没有接 CLI、执行器、server、store 或 schema，不自动激活 runtime。

```text
node --test test/history-archive.test.js
exit 0; 21 tests, 21 pass; duration 5683.2520 ms
（该卡三个打开门禁用例：443.8932 ms / 449.9699 ms / 392.9466 ms；junction 用例见下节）

npx.cmd --no-install biome check src/history-archive.js test/history-archive.test.js
exit 0; 2 files checked

npm.cmd run typecheck
exit 0

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

未覆盖并发替换、fsync/断电耐久、大段、跨机器或返回后文件被改写；TOCTOU 风险按“每次打开重验、但不锁定后续使用”边界保留。

主审已独立运行 completed import 3/3 通过（1188.6243 ms），但当时发现 `bundle/` junction 可绕过 import root containment，因此暂不整卡接受；下一接点已修复并由主审连同门禁用例 5/5 复核通过，故本卡现已接受只读打开行为。

## A-import-bundle-containment：bundle root 的 import 根包含门禁（已接受）

- 原实现对 `runtimeFile` 和 marker 使用 import root 做 realpath containment，但 `bundleDirectory` 直接由 `path.join(requestedDirectory, "bundle")` 构造后独立验证；当 `bundle/` 是 junction 时，验证的是根外目录。
- 现在先用 `resolveBundleFile(requestedDirectory, realDirectory, "bundle", "import bundle directory")` 解析真实 bundle root，再以该真实路径调用 `verifyPublishedHistoryArchiveBundle()`，并用 `bundleContains(realDirectory, verifiedBundle.directory)` 再次检查；运行时只消费通过 import root containment 的 bundle。
- 新增真实 junction 反例：把冻结 bundle 移到 import root 外，建立 `bundle/` junction，并把 runtime registry 的 `database_path` 同步改为外部段路径，避免旧 registry 差异偶然拒绝。修复前该用例红（Missing expected rejection，381.0525 ms），修复后绿（384.0995 ms）。另测 `runtime.sqlite` junction 外逃，由既有 `resolveBundleFile()` 拒绝（439.9859 ms）。
- 正常导入仍通过；上述失败路径不写 import marker、runtime 或源 bundle。测试在宿主 Windows 沙箱外运行真实 junction。

```text
node --test --test-name-pattern="completed import rejects a (bundle|runtimeFile) junction" test/history-archive.test.js
exit 0; 2 tests, 2 pass; duration 849.6801 ms

node --test test/history-archive.test.js
exit 0; 21 tests, 21 pass; duration 5683.2520 ms
```

只证明打开时 realpath 包含检查与失败不写；验证后并发替换、fsync/断电、跨机器路径/ACL 仍未证明，也未接 HTTP、CLI 或在线服务。

主审已在宿主独立运行包含正常/失败路径的 5/5 用例，runner 1841.6631 ms；接受的边界仅为 realpath 检查时的 import 根内约束，不声称检查到后续消费之间没有 TOCTOU。

## A-archive-status-API：登记与原文件状态（已接受）

- 新增 `GET /api/history/archives`。成功响应为 `{ authority, segments, counts }`；每段只返回登记时原始的 `segmentId`、`startMs`、`endMs`、`eventCount` 与当前 `status`，`counts` 明确为 `{ segments, events }`。不返回登记库路径或摘要，也不通过 query 接收任意文件路径。
- 执行器新消息直接从 `archive_segments` 读取登记行、从 `store_meta` 读取 `history_archive_event_authority`，再逐段 `stat()`。没有调用 `sync`、`verifyHistoryArchiveCandidate`、checksum、events 扫描或导入写。
- 文件状态只有三种：`present` 表示 `stat()` 成功且目标是文件；`missing` 对应 `ENOENT`/`ENOTDIR`；其它 `stat()` 失败或目标不是文件均为 `unreadable`。`present` 仅表示该时点存在，不是完整性验证。
- authority 严格按现有 v1 形状解析；非法 JSON/形状/版本/重复或未登记 id 返回 `HISTORY_ARCHIVE_AUTHORITY_INVALID`，打不开存储或 registry 不可读返回 `HISTORY_ARCHIVES_UNAVAILABLE`。非 GET 返回 405 `METHOD_NOT_ALLOWED`。
- 新消息不加入 sync/backup/snapshot/published/close 串行尾链，避免轻量状态读取被这些操作排队阻塞。
- 真实临时 `UsageStore` 先登记一个候选段与 authority，再启动隔离 HTTP 服务：首次响应为 `present` 且范围/事件数/counts 与登记一致；删除段后同一登记元数据仍为 `missing`；在同路径建目录后为 `unreadable`。第二个 fake-store 用例记录 SQL，断言只查询 `archive_segments` 与 authority、从不查询 `events` 且从不调用 `sync`；第三个用例覆盖两个 stable error code。

```text
node --test test/history-archive-api.test.js
exit 0; 3 tests, 3 pass; duration 5280.5228 ms
（HTTP 用例 174.5592 ms；无 sync/events/空登记用例 2.1726 ms；错误码用例 0.7873 ms）

npx.cmd --no-install biome check src/server.js src/usage-executor.js test/history-archive-api.test.js
exit 0; 3 files checked in 18 ms

node --test test/server.test.js
exit 1; 18/22 pass on host; 4 unrelated import-total failures remain at 200/283/258/258 instead of 123

npm.cmd run typecheck
exit 0

git diff --check
exit 0; only the pre-existing public/index.html CRLF warning
```

该卡未运行全仓测试或正式服务，也未重启生产。`present` 是单次 `stat` 结果，返回后文件仍可被删除/替换；authority 只校验结构和登记关联，不认证 registry 或文件内容。

主审已独立运行 `test/history-archive-api.test.js` 3/3 通过（5264.1786 ms），接受范围仍仅为一次点读的登记与原文件状态。

## A-cold-full-API：`detail=full` 读取已授权冷历史（已实现，待主审复核）

- 执行器现有 `publishedUsageReport` 消息改为调用 B 已接受的 `store.publishedHistoryUsageReport()`；消息和 client 形状不变，仍位于 `sync`/`snapshot`/`backup` 共用的串行尾链。没有新增消息、SQL 或并行读取。
- `detail=full` 只在两种条件下用持久载体替换内存事件、quota、sessions 和 homes：索引状态报告 `missingSources` 非空，或轻量 `historyArchives()` 返回的 authority 显式列出非空 `segmentIds`。仅有 `archive_segments` 登记但无 authority 不触发。冻结组合继续返回 `SNAPSHOT_FULL_DETAIL_UNSUPPORTED`；perf 回退仍只由 `missingSources` 触发。
- 真实 HTTP 用例建立 Codex cumulative `100 cold + 30 hot`、真实候选段、登记行和 authority。随后把仍在磁盘上的源文件压缩为 hot 尾部，并在已发布状态上使用 `skipCheck=1`：直接内存报告只得到 `[30]`，HTTP full 则从载体得到 130，事件、session 总量、home 和 quota 与未归档 store oracle 一致，且 `missingSources=[]`。这使 130 断言确实区分了载体路径，而不是另一条 live 扫描也恰好重建 130。
- 同一场景删除已授权段后，HTTP full 返回 500 `ENOENT`，没有 `summary` 或 `report`，不会静默返回 30 token 的部分结果。另一个无 authority 的缺失 rollout 用例仍返回已发布 100 token，保留原 missing-source 行为。

```text
node --test test/history-cold-full-api.test.js
exit 0; 3 tests, 3 pass; duration 5741.3768 ms（宿主）

node --test test/history-retention-api.test.js
exit 0; 6 tests, 6 pass; duration 6814.1333 ms

node --test test/history-executor-backup.test.js
exit 0; 10 tests, 10 pass; duration 6645.3566 ms（宿主）

node --test --test-concurrency=1 test/w1-executor.test.js
exit 0; 14 tests, 14 pass; duration 11745.0308 ms

npx.cmd --no-install biome check src/server.js src/usage-executor.js test/history-cold-full-api.test.js
exit 0; 3 files checked in 17 ms

npm.cmd run typecheck
exit 0

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

该卡只证明显式 `skipCheck=1`、源文件仍存在且状态已发布时的 HTTP 选择；不证明源被压缩后自动 sync 仍成功（authority 的 cold-prefix 校验会按设计拒绝），也不证明 authority/段文件在读取期间并发切换。quota 断言覆盖 cold 事件已从热事件表删除、但观测行仍在 store 中并由载体返回的情况；冷段内 quota 行的归档/删除语义未另证。没有运行正式服务或重启生产。

## A-perf-source-candidate-fidelity：source SQL 到冷候选的逐列对拍（已接受）

- 新增文件只含一个真实 ZCode fixture 用例。先把 fixture 同步到临时 `UsageStore`，直接以源库 `perf_samples` 在 `[MIN(events.timestamp_ms), 2026-10-04T12:00:00.000Z)` 的 SQL 全列结果为 oracle；期望行不来自候选库，也不调用 reader 的解码函数。随后创建、登记真实候选并调用 `readHistoryArchivePerfSamples()`，只把返回样本的字段名映射回源列名、把诊断链数组还原为 JSON 文本后逐列深等比较。
- 该冷区原有 9 行样本，覆盖 `item_count`/`timed_item_count = NULL`、`duration_ms`/`output_tokens = 0`、`method_version = tps-v2`、`sample_flags` 的 0/1/2/2048 以及空/非空 `diagnostic_reason_chain`。候选仍保留边界之后的 hot 样本，但 reader 只返回冷区行；读取前后候选数据库 SHA-256 不变。
- 沙箱首次运行在候选发布硬链接处得到 `EPERM`；按既定 Windows 限制改用宿主执行后通过。

```text
node --test test/history-cold-perf-source-candidate.test.js
exit 0; 1 test, 1 pass; duration 293.9211 ms（宿主）

npx.cmd --no-install biome check test/history-cold-perf-source-candidate.test.js
exit 0; 1 file checked in 5 ms

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

`test/history-cold-perf-source-candidate.test.js` SHA-256：`242c6162b97f787d8a9e6cdbd3ab20ba27e8da2eefb859f84afdaaa567e0f037`

本卡只证明一个 ZCode 候选、一个 `[start,end)`、`perf_samples` 主表原始列的进段保真；未覆盖 timing/依赖表、perf-only 来源、跨 home 同键、unplaced 样本、修订 overlay、热冷重叠去重、缺段整体失败或离线转移重建。

主审已逐行审查并与既有 reader 两文件复跑 2/2 通过（runner 314.7064 ms，源保真 231.0361 ms）；接受范围仍限定为 ZCode / `perf_samples`。

## A-perf-only-capability-red：perf-only 来源清单红测（已接受反例）

- 真实 ZCode fixture 正常 sync 后，把 store 备份到隔离 SQLite；选择最老 event 的 ZCode source 作为目标，删除该 source 的 `events`，保留其 `perf_samples` 与 `source_files`。另取目标之后仍有 event 的 ZCode source，以它第一个 event 的 `+1 ms` 为结束边界，因此候选仍有 1 个 event source 可正常创建。
- 封存前用隔离库 raw SQL 捕获目标的五字段 identity 和 `[coldStart,endMs)` 内 9 个 `sample_key`；候选确实保留这 9 个 sample key、`source_files` identity 且目标 event 数仍为 0，但现有 events-v1 `history_archive_candidate.sources.rows` 只有 1（仅剩余 event source），完全省略 perf-only 目标。当前再次 verify 候选成功，说明 events-v1 校验不会被解释成 perf 覆盖证明。
- 红测在缺字段处按预期失败，并给出被省略目标的 9 个冷样本及 canonical key-set SHA-256 `31530df7ec9aedbe7ce4c9a2672fdb9ab2c7d4da87ad25616f5273673a42ed90`。生产文件未改，没有伪造字段。

主审独立复现红（256.1279 ms）后冻结 key 为 `history_archive_perf_sources_v1`，并明确这只是来源清单，不是完整 perf capability/闭包，不能据此授权 merge 或淘汰。字段形状为：

```json
{
  "formatVersion": 1,
  "sources": [
    {
      "path": "source path",
      "kind": "zcode",
      "homeId": "home id",
      "homeLabel": "home label",
      "homePath": "home path",
      "sampleCount": 9,
      "sampleKeysSha256": "sha256(JSON.stringify(sortedColdSampleKeys))",
      "methodVersions": ["tps-v2"]
    }
  ]
}
```

接点仍是候选工作副本裁剪 events 后独立写入 `store_meta`，不并入 events-v1 `sources`。实际写入与验证由后继卡实现。

```text
node --test test/history-cold-perf-capability.test.js
exit 1（预期红测）; 1 test, 1 fail; duration 256.2363 ms（宿主）
AssertionError: candidate must store its perf source inventory under history_archive_perf_sources_v1

npx.cmd --no-install biome check test/history-cold-perf-capability.test.js
exit 0; 1 file checked in 6 ms

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

红态时 `test/history-cold-perf-capability.test.js` SHA-256：`54b31c9908bd7e4a2d085e7919deaf85ffe7b8d4adea2ba4f613d571879547a3`

本卡只证明 candidate 级显式 perf source inventory 缺失与冻结形状；不证明完整 perf capability/闭包，也未覆盖 registration/bundle 绑定、依赖闭包、timing、多来源冲突、修订、合并、淘汰、热副本删除或真实提交前失败。

## A-perf-source-inventory-write：候选来源清单写入与验证（已接受）

- 开工前 `src/history-archive.js` SHA-256 与主审前像一致（`8606752f…9d224`），原文件已备份到 `output/history-retention-resume-20261024/history-archive.A-perf-source-inventory-write.baseline.js`，备份摘要逐字节一致。
- `createHistoryArchiveCandidate()` 在既有候选事务内、events 范围裁剪之后，以 `perf_samples` 的有限 `ts_ms ∈ [startMs,endMs)` 为全集，`LEFT JOIN source_files` 取五字段身份；缺失身份明确抛出 `HISTORY_ARCHIVE_CANDIDATE_PERF_SOURCE_MISSING`，不会因 inner join 静默漏源。结果按 source path、sample key 和 method version 确定性排序，并以独立 key `history_archive_perf_sources_v1` 写入同一事务。原 `history_archive_candidate` 形状、event metadata、ID 与 events-v1 语义未改。
- `verifyHistoryArchiveCandidate()` 使用同一只读 `BEGIN` 快照重算。无该 key 的旧 v1 候选继续可 verify 和读取 events，但不获得 perf 来源清单；有 key 时严格校验 exact version/shape，并逐来源比对 identity、sampleCount、canonical sample-key digest 与 methodVersions。损坏 JSON、未知版本和内容不符分别明确失败，不会忽略。
- 测试把原 perf-only 红例转绿，并通过既有 `createHistoryBackup()` 重打包伪造候选，使整库与 manifest 摘要先通过后再分别拒绝伪造 sampleCount、sampleKeysSha256、formatVersion；另一个反例删除 `source_files` identity，确认创建阶段失败。最后移除清单元数据并重打包，确认旧 v1 仍可 verify、events 可读。

```text
node --test test/history-cold-perf-capability.test.js
exit 0; 1 test, 1 pass; duration 383.9044 ms（宿主）

node --test test/history-cold-perf-source-candidate.test.js test/history-cold-perf-reader.test.js test/history-archive.test.js
exit 0; 23 tests, 23 pass; duration 3972.442 ms（宿主）

npx.cmd --no-install biome check src/history-archive.js test/history-cold-perf-capability.test.js
exit 0; 2 files checked in 20 ms

npm.cmd run typecheck
exit 0

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

受测文件 SHA-256：

```text
src/history-archive.js  13d2bc2e9efe71bf55ba15929604fdfc4ef3fa7690125e282d16226f7738cb69
test/history-cold-perf-capability.test.js  c83ea7c28709459a8e073fbd25b57019c9237c6568715171dedbd7f54b77e4d2
```

本卡的 `history_archive_perf_sources_v1` 只是“冷范围内有限 ts 样本的来源清单”，不保存逐样本事实摘要、原生依赖闭包、timing/WorkBuddy 证据或修订，因此不能单独授权 summary 切换、热副本删除、merge 或淘汰。未覆盖 registration/bundle 级能力绑定、perf-only 多来源冲突、unplaced 样本、段损坏或并发替换。

主审已接受该候选清单写入/校验卡；三项聚焦文件复跑 3/3，其中候选能力用例 345.1428 ms。

## A-perf-source-inventory-transfer：来源清单与冷 perf 样本经完整包导入后脱源可读（已接受）

- 新增文件只含一个真实 ZCode fixture 用例。创建候选前直接以源库 `perf_samples` 的 SQL 结果作为 oracle：捕获目标来源五字段 identity、`[MIN(events.timestamp_ms), 2026-10-04T12:00:00.000Z)` 内全部 9 个冷样本的全列、sample key 集合及 method version，并独立构造期望的 `history_archive_perf_sources_v1` JSON 对象。期望值不读取候选或 intake decoder。
- 用例依次创建/登记真实候选、发布完整 bundle、完成 import；随后关闭源 `UsageStore`，删除原候选数据库与 manifest，删除整个 ZCode fixture 源目录，并先断言原 `source_path` 已不存在。再从 import runtime 的 `archive_segments` 定位冻结段，直接读取段内 inventory 的原始 JSON 文本与实际对象，二者都逐字/深等匹配 source SQL oracle。
- 最后用导入 runtime 调用 `readHistoryArchivePerfSamples()`，把解码结果映射回源列并逐列深等 9 行源 SQL；读取前后的导入段 SHA-256 均等于 import manifest/registry 中的登记值。该路径证明单来源 inventory、样本事实和段身份在“候选登记 → bundle 发布 → import → 源删除”后仍可读，生产文件未改。

```text
node --test test/history-cold-perf-inventory-transfer.test.js
exit 0; 1 test, 1 pass; duration 421.9193 ms（测试体）/ 496.6585 ms（runner，宿主）

npx.cmd --no-install biome check test/history-cold-perf-inventory-transfer.test.js
exit 0; 1 file checked in 6 ms

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

受测文件 SHA-256：

```text
src/history-archive.js  13d2bc2e9efe71bf55ba15929604fdfc4ef3fa7690125e282d16226f7738cb69
test/history-cold-perf-inventory-transfer.test.js  38a388d17f4d7225cc527707e1bba4c987c73b5b146bf9a351309e2fcb47174f
```

本卡只覆盖一个 ZCode 来源、一个 `[start,end)`、一个完整 bundle/import 和 `perf_samples` 主表；没有新增或证明在线 import、registration/bundle 对 inventory 的额外能力绑定、timing/依赖表闭包、多来源冲突、unplaced 样本、修订 overlay、merge、拒绝/淘汰，也不覆盖读取期间段文件或 registry 被并发替换。bundle/import 实现只按该转移用例被复用，不扩大为其全部语义的重新验收。

主审已逐行审阅并独立通过该离线转移，测试体 452.7847 ms，两文件 runner 523.7559 ms；接受范围仍限定为单来源、单段的离线 bundle/import。

## A-perf-payload-manifest-red：冷 perf payload 必须绑定完整样本值（反例已接受）

- 新增文件只含一个真实 ZCode fixture 用例。创建候选前直接读取源库 `perf_samples` 在 `[MIN(events.timestamp_ms), 2026-10-04T12:00:00.000Z)` 的完整 `PERF_SAMPLE_FIELDS` oracle，并选出一个 `duration_ms > 0`、`output_tokens > 0` 的冷样本。原始候选先成功 verify；随后用 SQLite backup 建立临时副本，只把该样本 `duration_ms` 加 1，再由既有 `createHistoryBackup()` 重写目标库及其 manifest，使外层数据库摘要有效。这不测试外层 checksum。
- 重打包前后 `history_archive_perf_sources_v1` 的原始 JSON 文本完全相等，因此 `sample_key`、source identity、method version 与 sample count 证据均未变化。当前 `verifyHistoryArchiveCandidate()` 仍接受被改样本，红测在唯一的 `assert.rejects(...)` 处失败：`Missing expected rejection: candidate verification must reject a cold perf payload change even when its source/key inventory is unchanged`。精确实际结果就是候选 verify 成功，而不是 payload 语义失败。
- 所需最小 seam：新增独立、版本化的候选内 payload 证据（建议 `store_meta.history_archive_perf_payload_v1`，shape `{formatVersion:1,rows,sha256}`）。`createHistoryArchiveCandidate()` 在同一候选事务内，以 `{startMs,endMs}` 做域分隔，按 `sample_key` 顺序把每条冷样本的全部 `PERF_SAMPLE_FIELDS` 列拼入 SHA-256；`verifyHistoryArchiveCandidate()` 在同一只读快照重算。若存在 `history_archive_perf_sources_v1` 但 payload 键缺失、shape 不符、行数或摘要不符，应明确拒绝；旧 events-only 候选仍可维持既有兼容。payload 摘要应覆盖文本/整数/`NULL`/`0`/flags/原因链的完整值，而不是 key 或来源清单的再摘要。

```text
node --test test/history-cold-perf-payload-manifest.test.js
exit 1（预期红测）; 1 test, 1 fail; duration 196.7480 ms（测试体）/ 270.6838 ms（runner，宿主）
AssertionError: Missing expected rejection

npx.cmd --no-install biome check test/history-cold-perf-payload-manifest.test.js
exit 0; 1 file checked in 5 ms

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

红态 `test/history-cold-perf-payload-manifest.test.js` SHA-256：`44bb5f9ee443a2b56bc547e03aed89231c2e60b9cb1bcbfa1b930f563786a6eb`

本卡只证明一个非 key 字段变化可在 source/key/count 均不变时绕过当前 verify；未实现 payload manifest，也未覆盖 `perf_sample_sources`、timing/WorkBuddy 依赖闭包、跨段/多来源合并、修订、淘汰、缺段整体失败或并发文件替换。

主审已逐行审阅并独立复现 0/1：`Missing expected rejection`，测试体 216.4521 ms，runner 290.5532 ms；接受为后续 payload manifest 的实现反例。

## A-perf-payload-manifest-write：候选完整 perf payload 摘要写入与验证（已实现，待主审复核）

- 开工前 `src/history-archive.js` SHA-256 与主审前像 `13d2bc2e…8cb69` 一致，原文件备份到 `output/history-retention-resume-20261024/history-archive.A-perf-payload-manifest-write.baseline.js`，备份摘要逐字节一致。
- 保留 `history_archive_perf_sources_v1` 原样，新增独立候选组件 `store_meta.history_archive_perf_samples_v1`，严格 shape 为 `{formatVersion:1,startMs,endMs,rows,sha256}`。哈希 header 绑定表名 `perf_samples`、起止范围与 31 个冻结列的顺序；正文只流式扫描有限 `ts_ms ∈ [startMs,endMs)` 的原始行，按 `sample_key` 排序，每条按冻结列顺序构造 JSON 后追加换行。未 import `usage-store.js`，未复制全前缀，未新增表或通用摘要框架。
- `createHistoryArchiveCandidate()` 在既有候选事务内写该组件；`verifyHistoryArchiveCandidate()` 在同一只读 `BEGIN` 快照重算。键存在时严格拒绝非 exact shape、未知版本、范围不符、非法行数或摘要；行数/摘要不符分别走 `HISTORY_ARCHIVE_CANDIDATE_PERF_SAMPLES_MISMATCH`，结构问题走 `...PERF_SAMPLES_BAD_METADATA`。旧无该键的 events-v1 候选仍可 verify，但该兼容不产生 perf merge、hot-delete、summary 或 authority 授权。
- 测试核心三组：第一组直接从源库完整 `PERF_SAMPLE_FIELDS` SQL 独立计算结果摘要并逐字段深等候选元数据；第二组只把已有正时长样本的 `duration_ms` 加 1，经 SQLite backup 与 `createHistoryBackup()` 重写有效外层摘要后，确认 source inventory 原字节不变并精确得到 `HISTORY_ARCHIVE_CANDIDATE_PERF_SAMPLES_MISMATCH`；第三组分别确认未知 `formatVersion` 得到 `...PERF_SAMPLES_BAD_METADATA`，以及合法删除新键的旧候选仍可 verify。

```text
node --test test/history-cold-perf-payload-manifest.test.js
exit 0; 1 test, 1 pass; duration 260.2744 ms（测试体）/ 334.2145 ms（runner，宿主）

node --test test/history-cold-perf-payload-manifest.test.js test/history-cold-perf-capability.test.js test/history-cold-perf-source-candidate.test.js test/history-cold-perf-reader.test.js test/history-cold-perf-inventory-transfer.test.js test/history-archive.test.js
exit 0; 26 tests, 26 pass; duration 4041.5990 ms（宿主）

npx.cmd --no-install biome check src/history-archive.js test/history-cold-perf-payload-manifest.test.js
exit 0; 2 files checked in 20 ms

npm.cmd run typecheck
exit 0

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

受测文件 SHA-256：

```text
src/history-archive.js 7aa278823f5ac589807f203593331d1cba3f68f6126bc3810761645f9638097b
test/history-cold-perf-payload-manifest.test.js 25bad1070e48ecb92a4204cbb2c13a28712a366b8b5a5ca510b6a0f2e335dfb2
```

本卡只绑定 `perf_samples` 主表完整原始行，不包含 `perf_sample_sources`、timing/WorkBuddy 依赖闭包、跨段合并、unplaced 样本、修订、淘汰或在线切换；也不把新摘要升级为 perf 权威/热删许可。旧无键兼容明确不代表完整 perf 能力。

## A-perf-index-dependencies-write：候选冷 perf 依赖索引写入与验证（已接受）

- 开工前 `src/history-archive.js` SHA-256 为 `7aa278823f5ac589807f203593331d1cba3f68f6126bc3810761645f9638097b`；原文件备份到 `output/history-retention-resume-20261024/history-archive.A-perf-index-dependencies-write.baseline.js`，备份摘要逐字节一致。
- 保留既有 perf sources/payload 组件，新增 `store_meta.history_archive_perf_index_v1`。严格 shape 为 `{formatVersion:1,startMs,endMs,tables:{perf_sample_sources:{rows,sha256},perf_rollout_threads:{rows,sha256},source_files:{rows,sha256}}}`；三表分别固定 `sample_key,source_path,role`、`source_path,home_id,thread_id`、`path,kind,home_id,home_label,home_path` 列序，并分别按 `(sample_key,source_path)`、`source_path`、`path` 排序后逐行流式摘要。
- 依赖路径只取冷范围 `perf_samples.source_path` 与冷样本关联的 `perf_sample_sources.source_path` 并集：rollout owner 只保留引用路径，来源身份只保留该路径的五字段且缺失时 `HISTORY_ARCHIVE_CANDIDATE_PERF_DEPENDENCIES_MISSING`。创建在既有候选事务内写组件，verify 在同一只读事务快照重算；结构/版本/范围问题走 `...PERF_DEPENDENCIES_BAD_METADATA`，关系或值漂移走 `...PERF_DEPENDENCIES_MISMATCH`。旧无该键候选仍可 verify。
- 新测试从真实 Codex source SQL 独立计算完整三表 oracle，再与候选元数据逐对象比较；删除一条冷 `perf_sample_sources` 关系后用 `createHistoryBackup()` 重写有效外层摘要并精确得到 mismatch；未知 `formatVersion` 得到 bad metadata，删除整个键的合法旧候选仍可 verify。未用 candidate SQL 推导期望值。

```text
node --test test/history-cold-perf-index-manifest.test.js
exit 0; 1 test, 1 pass; duration 212.8326 ms（测试体）/ 286.9882 ms（runner，宿主）

node --test test/history-cold-perf-index-manifest.test.js test/history-cold-perf-dependency-closure.test.js test/history-cold-perf-payload-manifest.test.js test/history-archive.test.js
exit 0; 24 tests, 24 pass; duration 3946.1613 ms（宿主）

npx.cmd --no-install biome check src/history-archive.js test/history-cold-perf-index-manifest.test.js
exit 0; 2 files checked in 21 ms

npm.cmd run typecheck
exit 0

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

受测文件 SHA-256：

```text
src/history-archive.js 4e76ff3ab6b82ecdc045e09ac202a7d93afc240a96f5f9b6f6100c0524026969
test/history-cold-perf-index-manifest.test.js 150aec370810a8dc965b08c28ce5077890460f71d134100aa127be34d4a97b97
```

本卡只封装冷样本的 `perf_sample_sources` 关系、rollout owner 与五字段来源身份；不包含 request timing、WorkBuddy 时长、跨边界重复依赖的完整闭包、unplaced 样本、跨段 merge、修订、淘汰或 summary 切换，也不把该组件升级为 perf 权威或热删许可。

主审已审完整 diff，并独立通过 index、原 B 缺依赖红测与 payload 三文件 3/3（测试体 247.4124 / 197.6389 / 291.7153 ms，runner 373.2298 ms），接受范围限定为该 index 组件。

## A-index-orphan-dependency：dependency-only 缺来源身份时创建整体失败（已接受）

- 本卡开始时 `src/history-archive.js` 摘要为主审已接受的 `4e76ff3ab6b82ecdc045e09ac202a7d93afc240a96f5f9b6f6100c0524026969`；收口检查时为 B 接管 timing 后的 `ec0eed510a6aa110a4239f4f54469a8500a302525deddedf17bda2deed12fd92`。本卡未修改 production/source，源码仍只由 B 写。该变化与测试执行重叠，因此以下测试只代表各 Node 进程实际加载到的当时源码，不能静态绑定到上述任一摘要；主审将在 B 稳定后连同本测试独立复验。
- 真实 `createPerfCodexIntegrationFixture()` source SQL 找到 2 个合格 dependency-only 路径：`rollout-2.jsonl` 与 `rollout-3.jsonl`；两者均有 11 条冷 dependency 关系、1 条 rollout owner、0 条 events、0 条冷范围 primary perf 样本，因此不会先被 `perfSourceInventory` 的主来源校验截住。测试按路径字典序选择第一个。
- 测试用 SQLite `backup()` 复制已 sync/seeded store，只在隔离副本执行 `PRAGMA foreign_keys = OFF`，删除所选路径唯一一行 `source_files` 身份；隔离副本仍保留该路径全部 25 条 `perf_sample_sources` 关系。随后以只读连接调用 `createHistoryArchiveCandidate()`，精确拒绝 `HISTORY_ARCHIVE_CANDIDATE_PERF_DEPENDENCIES_MISSING`。
- 拒绝后目标数据库和 `<name>.manifest.json` 均不存在；原 store 中该路径五字段身份逐列不变、全部 25 条关系仍在。未修改原 fixture、source 或已有测试。

```text
node --test test/history-cold-perf-index-orphan.test.js
exit 0; 1 test, 1 pass; duration 125.7582 ms（测试体）/ 203.2685 ms（runner，宿主）

node --test test/history-cold-perf-index-orphan.test.js test/history-cold-perf-index-manifest.test.js test/history-cold-perf-dependency-closure.test.js test/history-cold-perf-payload-manifest.test.js
exit 0; 4 tests, 4 pass; duration 378.2474 ms（宿主）

npx.cmd --no-install biome check test/history-cold-perf-index-orphan.test.js
exit 0; 1 file checked in 5 ms

npm.cmd run typecheck
exit 0

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

受测文件 SHA-256：

```text
test/history-cold-perf-index-orphan.test.js 26baa87cd8df3308fd6b78168f27aec8e3e4db3306dbe5264496e4d23977cf81
```

本卡只证明一个真实 Codex fixture 中无 events、无冷 primary 的 dependency-only 路径在隔离非法身份状态下创建整体失败且不发布输出；不包含多个 source、正常 foreign-key schema 产生 orphan、events-bearing dependency、timing/WorkBuddy、restore、merge、淘汰或并发源变化。B 的 expected concurrent timing 改动使当时测试未绑定单一摘要；主审随后在稳定 `ec0eed51…fd92` 上独立复验并接受。

主审已在稳定 `src/history-archive.js` SHA-256 `ec0eed510a6aa110a4239f4f54469a8500a302525deddedf17bda2deed12fd92` 上独立通过 timing/orphan/index 三文件 4/4；orphan 测试体 143.4912 ms，runner 526.0552 ms，接受孤儿来源限定行为。

## A-native-perf-graph-transfer：冷样本原生 timing graph 经完整 bundle/import 脱源保真（已接受）

- `src/history-archive.js` 全程保持 `ec0eed510a6aa110a4239f4f54469a8500a302525deddedf17bda2deed12fd92`，本卡未修改 production/source 或 store。
- 候选创建前，测试从真实 `createPerfCodexIntegrationFixture()` source SQL 冻结冷范围全部 `PERF_SAMPLE_FIELDS` 列；再从一个冷样本解析唯一 owner `home_id/thread_id`，冻结该线程的完整 `perf_samples`、`perf_sample_sources`、`perf_rollout_threads`、三条 source 五字段身份，以及 `perf_request_timing_threads` 和按 `home_id/response_id` native link 关联的全部 origin/variant `perf_request_timing_evidence`。断言样本同时含冷/热行、关系含 dependency、identity 为 3 条、timing link/evidence 均为 26 条。
- 用现有 `createHistoryArchiveCandidate()`、`registerHistoryArchiveCandidate()`、`publishHistoryArchiveBundle()` 和 `publishHistoryArchiveImport()` 完成一次完整 publish/import。候选创建后额外冻结四个 raw meta 值：`history_archive_perf_sources_v1`、`history_archive_perf_samples_v1`、`history_archive_perf_index_v1`、`history_archive_perf_timing_v1`。
- 导入完成后关闭 store，删除原 candidate 与 manifest，再关闭 fixture 删除三条原始 rollout；逐路径确认原 source、candidate 和 manifest 均不存在。随后 `loadHistoryArchiveImport()` 重新验证冻结 bundle/runtime，从 runtime registry 取得段路径并核对文件摘要。
- 以只读连接直接查询导入段中的实际 graph rows，与候选前 source SQL oracle 深等；四个 perf meta raw bytes 与候选原值逐字节相同；`UsageStore.readHistoryArchivePerfSamples()` 返回的完整冷样本逐列等价；两类读取前后段文件 SHA-256 不变。

```text
node --test test/history-cold-perf-graph-transfer.test.js
exit 0; 1 test, 1 pass; duration 407.4492 ms（测试体）/ 490.3591 ms（runner，宿主）

node --test test/history-cold-perf-graph-transfer.test.js test/history-cold-timing-source-candidate.test.js test/history-cold-perf-index-manifest.test.js test/history-cold-perf-inventory-transfer.test.js
exit 0; 4 tests, 4 pass; duration 560.6730 ms（宿主）

npx.cmd --no-install biome check test/history-cold-perf-graph-transfer.test.js
exit 0; 1 file checked in 11 ms

npm.cmd run typecheck
exit 0

git diff --check
exit 0
```

受测文件 SHA-256：

```text
src/history-archive.js ec0eed510a6aa110a4239f4f54469a8500a302525deddedf17bda2deed12fd92
test/history-cold-perf-graph-transfer.test.js a4ad0768912622eb036adf30fccff33660b493baaff1503222287ee6623f538c
```

本卡只证明一个真实 Codex fixture、一个 thread、一次同机完整 bundle publish/import；不包含多 thread/home、跨机器/ACL、在线 import、merge、revision、eviction、源/包并发变化或进程崩溃恢复，也不把该离线转移扩大为完整 perf 权威。

主审已独立运行该卡 1/1（测试体 376.4372 ms，runner 454.4165 ms），接受范围限定为单个真实 thread 的同机 published bundle → import。

## A-workbuddy-observation-manifest-write：候选封印引用 home 的 WorkBuddy 原生时长观测（已接受）

- 开工前 `src/history-archive.js` SHA-256 为 `ec0eed510a6aa110a4239f4f54469a8500a302525deddedf17bda2deed12fd92`；原文件备份到 `output/history-retention-resume-20261024/history-archive.A-workbuddy-observation-manifest-write.baseline.js`，备份摘要逐字节一致。
- 新增 `store_meta.history_archive_workbuddy_observations_v1`，严格形状为 `{formatVersion:1,startMs,endMs,scope:"referenced-homes",tables:{workbuddy_generation_duration_observations:{rows,sha256},source_files:{rows,sha256}}}`。观测固定 `home_id,message_id,duration_ms,ended_at_ms,capture_version,captured_at` 六列并按主键排序；来源身份固定 `path,kind,home_id,home_label,home_path` 五列并按 path 排序。
- 引用 home 取冷范围 `events.timestamp_ms` 关联 `source_files.kind='workbuddy'` 的并集与冷范围 WorkBuddy `perf_samples.home_id`，对该 home 保存**全部**原生时长观测（包括同 message 异值冲突），并为该 home 保存全部 WorkBuddy 来源身份。旧 `workbuddy_generation_durations` 兼容表刻意不进入新组件。
- 创建在既有候选事务内写组件，verify 在同一只读事务快照重算；结构、版本、范围或 scope 问题走 `HISTORY_ARCHIVE_CANDIDATE_WORKBUDDY_BAD_METADATA`，观测或身份漂移走 `HISTORY_ARCHIVE_CANDIDATE_WORKBUDDY_MISMATCH`。旧候选缺少该键仍可 verify，不迁移旧格式。
- 新测试用真实临时 WorkBuddy source 生成同一 message 的 `800/850` 两条冲突观测且确认该 message 有 0 条 perf sample；测试从 source SQL 独立求引用 home、全部观测与五字段身份并计算 oracle，再与候选元数据逐对象比较，不使用 candidate SQL 推导期望值。修改一条观测为 `801` 后用 `createHistoryBackup()` 重写有效外层摘要并精确得到 mismatch；`formatVersion=2` 得到 bad metadata；删除整个键的合法旧候选仍可 verify。

```text
node --test test/history-cold-workbuddy-manifest-write.test.js
exit 0; 1 test, 1 pass; duration 186.5524 ms（测试体）/ 264.126 ms（runner，宿主）

node --test test/history-cold-workbuddy-manifest-write.test.js test/history-cold-workbuddy-manifest.test.js
exit 0; 2 tests, 2 pass; duration 282.004 ms（宿主）

npx.cmd --no-install biome check src/history-archive.js test/history-cold-workbuddy-manifest-write.test.js
exit 0; 2 files checked in 26 ms

git diff --check
exit 0
```

受测文件 SHA-256：

```text
src/history-archive.js b8ff44aa8a006cd74b22fb3da3299b58c408b6faca899209f890a8fc8192f338
test/history-cold-workbuddy-manifest-write.test.js 36b88e475606af823ae2694e2b050eab23304899f2bf52ac1aee17ecf8b85d45
```

本卡只绑定一个真实 WorkBuddy home/message 的两条异值观测及其来源身份；不包含多个 home/message、零观测 home、缺失来源身份、旧兼容时长表、并发源变化、候选登记/发布、merge、revision、淘汰、热删或 summary 切换，也不把该组件升级为 WorkBuddy 权威。

主审已审相对 `ec0eed51…fd92` 的完整 diff，并独立运行 paired 2/2（测试体 201.6222 / 141.2391 ms，runner 310.7906 ms），接受 referenced-home 原始观测/身份 manifest 组件；该组件不是 authority。

## A-workbuddy-native-transfer：冲突 WorkBuddy 原生观测经完整 bundle/import 脱源保留（已接受）

- `src/history-archive.js` 保持主审接受的 `b8ff44aa8a006cd74b22fb3da3299b58c408b6faca899209f890a8fc8192f338`，本卡只新增测试与报告，不修改任何 source 或既有测试。
- 测试复用真实临时 WorkBuddy home：同一 `message_id` 的 trace 产生 `800/850` 两条冲突观测，冷范围从该 home 的单个 usage event 起始，且该 home 有 0 条 WorkBuddy perf sample，因此引用关系来自 event source 而不是 perf 路径。
- 候选创建前，source SQL 独立冻结两条观测的完整六列与原生主键 `(home_id,message_id,duration_ms)`，并冻结该 home 全部 WorkBuddy `path,kind,home_id,home_label,home_path` 五字段身份。随后走既有 `createHistoryArchiveCandidate()`、`registerHistoryArchiveCandidate()`、`publishHistoryArchiveBundle()`、`publishHistoryArchiveImport()`。
- import 完成后关闭 store 并删除整个原 source 树，连带删除 source 文件、候选与候选 manifest；测试确认 source root 和 oracle 中每个原始来源路径均不存在。随后 `loadHistoryArchiveImport()` 重验冻结 bundle，并以 `{homeDir: importRoot, env: {}, importDirs: [], automaticDiscoveryEnabled: false}` 打开新 `UsageStore`。
- 新 runtime 从自身 registry 取得 import 内的段路径，断言段路径未逃出 import root，并直接把 runtime `segment.database_sha256` 和段文件实际 SHA-256 都等于注册前 `candidateDigest`；读取前后段摘要也保持不变。只读段中两条观测完整六列及两个原生主键、全部五字段来源身份与 source SQL oracle 深等；`history_archive_workbuddy_observations_v1` 原始 meta bytes 与候选逐字节相同。原始来源路径即使已删除也保持原值，不按 import 路径重写。

```text
node --test test/history-cold-workbuddy-transfer.test.js
exit 0; 1 test, 1 pass; duration 344.1419 ms（测试体）/ 427.6036 ms（runner，宿主，补证后）

npx.cmd --no-install biome check test/history-cold-workbuddy-transfer.test.js
exit 0; 1 file checked in 8 ms

git diff --check
exit 0
```

受测文件 SHA-256：

```text
test/history-cold-workbuddy-transfer.test.js 813e2c77121ce1acfffa3628f394de4196a41357b255b10c620fc9374fc8b3d9
```

本卡只证明一个真实 WorkBuddy home/message、一个 event 范围、一次同机完整 bundle publish/import；不覆盖多 home/message、跨机器路径/ACL、在线 import、并发发布、legacy 时长表、authority、merge、revision、淘汰或热删。

主审已审补后的两处 `candidateDigest` 直连断言并独立运行 1/1（测试体 313.5169 ms，runner 391.8513 ms），接受 WorkBuddy 原生事实的离线转移。

## A-zcode-perf-carrier-transfer：显式 ZCode `tps-v2` perf authority 经完整 bundle/import 脱源保留（已接受）

- `src/history-archive.js` 保持 `b8ff44aa8a006cd74b22fb3da3299b58c408b6faca899209f890a8fc8192f338`，`src/usage-store.js` 与全部既有测试均未修改；本卡只新增测试和报告。
- 使用既有 `createPerfIntegrationFixture({sources:["zcode"]})`：`archived` 与独立未归档 `oracle` 各 sync 到不同临时库，先从 `oracle.summarizeHistory()` 冻结 coverage、模型 `n/p10/p90/averageTps`。`archived` 创建候选并确认四个 perf 组件键齐全，记录候选摘要与四组件原始 meta bytes。
- 注册同一候选后，在临时 `archived` 库写入指向该段的 event authority 与 `zcode`/`tps-v2` perf authority；清空授权冷事件并只从该临时库删除一条可计算冷样本。候选仍保留冷 payload，主库保留其余重叠冷样本、全部 hot 与 unplaced rows，用于实际 carrier merge。
- 走既有 `publishHistoryArchiveBundle()`、`publishHistoryArchiveImport()` 后关闭两个 store 并删除整个 source tree，连带候选与 manifest；逐路径确认原始 ZCode source、候选和 manifest 均消失。
- 以 `{homeDir: importRoot, env: {}, importDirs: [], automaticDiscoveryEnabled: false}` 打开新 `UsageStore`。runtime registry、段文件实际 SHA-256 与注册前 `candidateDigest` 三者直连相等；新 runtime 的 `runtime.database` 热驻留库中 hot/unplaced 全部 `PERF_SAMPLE_FIELDS` 源列与转移前 SQL 行逐列相等，导入段四组件 meta bytes 与候选逐字节相同。实际 `runtime.summarizeHistory()` 的 coverage、两个模型 `n/p10/p90/averageTps` 与未归档 oracle 完全相等；读取前后段摘要不变。

```text
node --test test/history-cold-perf-authority-transfer.test.js
exit 0; 1 test, 1 pass; duration 492.2463 ms（测试体）/ 575.2637 ms（runner，宿主，定位纠正后）

npx.cmd --no-install biome check test/history-cold-perf-authority-transfer.test.js
exit 0; 1 file checked in 12 ms

git diff --check
exit 0
```

受测文件 SHA-256：

```text
test/history-cold-perf-authority-transfer.test.js 8069fe378362a883ccdf58697e8877344ef4ecdea9b67fbfbdede96ac09f0b60
```

主审已独立复跑 1/1（测试体 525.3926 ms，runner 611.3358 ms）并按上述文件摘要接受该转移。

本卡只证明一个真实 ZCode fixture、一个 `zcode/tps-v2` 显式 authority 段、一次同机完整 bundle publish/import；不覆盖跨机器路径/ACL、多 source/home/段 authority、在线 import、并发发布、revision/merge/淘汰、热删或自动发现。

## A-perf-carrier-pinned-record：冷事件读取期间 registry 改写不改写已捕获 perf 段（已接受）

- 本卡未改 `src/` 或既有测试，只新增 `test/history-cold-perf-carrier-snapshot.test.js` 和本报告；受测 `src/usage-store.js` 摘要为 `eebda75e848e8cfe28b850e45bd1a3fbf085fc0d1f7552dc293a80ebbe9d9f5c`，`src/history-archive.js` 保持 `b8ff44aa8a006cd74b22fb3da3299b58c408b6faca899209f890a8fc8192f338`。
- 使用既有真实 `createPerfIntegrationFixture({sources:["zcode"]})`，让 `archived` 与独立未归档 `oracle` 各自 sync。`archived` 创建并登记一个冷候选，写入 event authority 和单段 `zcode`/`tps-v2` perf authority，删除授权冷事件，并只从临时主库淘汰一条候选内可计算冷样本。
- 首次 `summarizeHistory()` 在 `readHistoryArchiveSnapshot()` 等待期间，断言传入 record 仍指向候选路径和原始摘要；另一条已提交的 SQLite 连接把 registry `database_path` 改为不存在的数据库，同时保留旁置 manifest，使后续读取到达原生数据库 `ENOENT` 而不是 manifest 包装错误。
- 首次调用仍从已捕获 record 读取 perf，除两个进程生成的 `indexedAt` 外，完整 `summary.perf`（coverage、groups、models、meta 和其它字段）与未归档 oracle 相等。第二次调用以原生 `error.code === "ENOENT"` 失败；外部连接恢复 registry 路径后，同一 store 第三次调用再次与 oracle 完整相等。

```text
node --test test/history-cold-perf-carrier-snapshot.test.js
exit 0; 1 test, 1 pass; duration 291.4714 ms（测试体）/ 372.2867 ms（runner，宿主）

npx.cmd --no-install biome check test/history-cold-perf-carrier-snapshot.test.js
exit 0; 1 file checked in 6 ms

git diff --check
exit 0
```

受测文件 SHA-256：

```text
test/history-cold-perf-carrier-snapshot.test.js fee5aab93872bb4deef0d29a170d1b09149288683ab73f0e569577a20613d2fd
```

主审已独立复跑 1/1（测试体 285.5237 ms，runner 368.6887 ms），并按上述文件摘要接受一个 authority 段内的同 store 读取快照。

本卡只证明一个真实 ZCode fixture、一个 authority 段、同一 store 的一次冷事件等待与一次外部 registry 改写；不覆盖多段并发、registry 修正后候选文件再被替换、进程重启或生产服务。

## A-zcode-perf-multisegment-red：两个显式 ZCode/tps-v2 authority 段的完整 perf 反例（已接受，已交 B）

- `src/` 与既有测试继续冻结；本卡只新增 `test/history-cold-perf-multisegment.test.js` 和本报告。受测 `src/usage-store.js` 摘要为 `eebda75e848e8cfe28b850e45bd1a3fbf085fc0d1f7552dc293a80ebbe9d9f5c`，`src/history-archive.js` 保持 `b8ff44aa8a006cd74b22fb3da3299b58c408b6faca899209f890a8fc8192f338`。
- 复用既有真实小 ZCode fixture，在 `2026-10-04T12:00:00.000Z` 把现有 small/day-A 与 ranked/day-B 事实切成两个首尾相接、互不重叠的候选范围。两个候选均独立 verify/register，生成两个不同段摘要；event authority 与 perf authority 都按冻结的 `segments` 数组列出这两个段，各自声明 `zcode`/`tps-v2`。
- 临时库只删除这两个范围覆盖的已放置 events、分别删除一条两个范围内可计算 perf 样本，未放置 perf 样本保持热驻留并逐行不变。测试随后调用真实 `summarizeHistory()`，目标是让完整 `summary.perf`（仅排除两个独立 store 各自生成的 volatile `indexedAt`）等于未归档 oracle，并在 `finally` 中重新读取两个候选文件，要求 SHA-256 与创建时一致。
- 当前冻结实现先命中 `historyArchivePerfAuthority()` 的 `authority.segments.length !== 1` shortcut，在 perf 读取与完整 oracle 比较之前真实失败。没有修 parser、没有伪造返回 shape、没有新增 source kind，也没有把 `INVALID` 写成预期成功。

```text
node --test test/history-cold-perf-multisegment.test.js
exit 1; 1 test, 0 pass; duration 268.1359 ms（测试体）/ 348.0727 ms（runner，宿主）
code HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID
message history archive perf authority must grant one zcode/tps-v2 segment matching its database digest

npx.cmd --no-install biome check test/history-cold-perf-multisegment.test.js
exit 0; 1 file checked in 6 ms

git diff --check
exit 0
```

受测文件 SHA-256：

```text
test/history-cold-perf-multisegment.test.js da1ae148cb8992e51dc0ecef5ef005d1a69345150a7062a34305559bafe88697
```

主审已独立复跑 0/1（测试体 290.7575 ms，runner 376.7086 ms），确认真实 `HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID` 后接受该接缝，并交唯一 store 将单段 parser 扩为数组 loop。

本卡只提供两个真实 ZCode/tps-v2 段、同一 store、一次完整 summary 红测接缝；未覆盖多 source kind、重叠段、跨段同键冲突、并发 registry/文件替换、淘汰接线或生产服务。

## A-cold-perf-freeze-HTTP：显式冷 perf 在正常 HTTP snapshot 中自包含（已实现，待主审复核）

- `src/` 与既有测试继续冻结；本卡只新增 `test/history-cold-perf-freeze-api.test.js` 和本报告。受测 `src/server.js` 摘要为 `8eaf97eb4009f7481ccdff5f813d12ee886647bcdfb823c94e3f5c858e0d3740`，`src/usage-store.js` 为 `edaa14380291912f36e7da8c801bd75a48f0a23bee9017dd3e2c644683f7ce12`，`src/usage-executor.js` 为 `47a91896e730275b56aefefd72827c6fedf449624e56f59a6403d380897d5d4e`。
- 使用既有真实小 ZCode fixture，独立 sync `archived` 与未归档 `oracle`；从 `archived` 创建并登记单段候选，写入单段 event/perf authority，删除冷 events 与一条候选内可计算冷 perf 样本，保留 hot 与 unplaced 行。
- 通过实际 `createUsageServer()` 在自有随机端口请求 `/api/usage?...&freeze=1`，正常创建 HTTP snapshot；首次响应的完整 `summary.perf` 除 volatile `indexedAt` 外与 `oracle.summarizeHistory(FILTERS).perf` 相等。
- 首次 freeze 成功后，再由第二条真实只读 `DatabaseSync(archivedFile)` 按原 `coldSample.sampleKey` 查询临时主库 `perf_samples`，结果为 `undefined`。这证明 server 首轮 sync 没有重新解析源并补回已淘汰冷样本，首个 HTTP perf 结果依赖 cold carrier，而不是 hot 回填。
- 随后把原 candidate DB 和 manifest 一起改名移走。携带同一 `snapshotId` 的 `/api/usage` 仍返回 200、同一 snapshot id 和同一完整 perf。无 snapshot 的新 freeze 请求返回 500 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND`，响应没有 `summary`，未退化为 hot-only 成功。

主审已确认正常 GET `freeze=1` 是现有 HTTP API 入口，不要求另造 POST；本段是该测试的必要补证。

```text
node --test test/history-cold-perf-freeze-api.test.js
exit 0; 1 test, 1 pass; duration 424.5104 ms（测试体）/ 5517.8567 ms（runner，宿主，含 server close）

npx.cmd --no-install biome check test/history-cold-perf-freeze-api.test.js
exit 0; 1 file checked in 7 ms

git diff --check
exit 0
```

受测文件 SHA-256：

```text
test/history-cold-perf-freeze-api.test.js 1dd9243dbe558280bd5551a87ac1cf48250fb34ac0a02ff297bb55892dcb052b
```

本卡只证明一个真实 ZCode source、一个显式 `zcode/tps-v2` authority 段、一次同进程 HTTP freeze 与同一 snapshot 重读；不覆盖多段 HTTP summary、并发请求/候选替换、服务重启、snapshot 淘汰接线或跨机器路径。

## A-multisegment-perf-missing：后续权威 perf 段缺失时完整失败（已实现，待主审复核）

- `src/` 与既有测试继续冻结；本卡只新增 `test/history-cold-perf-multisegment-missing.test.js` 和本报告。复用真实 ZCode fixture，独立 sync `archived` 与未归档 `oracle`，建立两个相邻的 `zcode/tps-v2` 候选段并写入两段 event/perf authority。
- 删除两段覆盖的冷 events，并从每段热 `perf_samples` 各淘汰一条可计算样本。通过临时替换公开 `readHistoryArchiveSnapshot()`：委托原方法并等其完成第二段 events 快照读取后，把第二段候选 DB 改名移走，同时保留原路径 manifest。
- 真实 `summarizeHistory()` 随后在 perf 读取阶段以原生 `ENOENT` 整体拒绝；没有返回第一段加 hot 的部分 summary。测试在 `finally` 中恢复原方法并把同一文件移回，再用同一 store 重试，完整 `summary.perf` 除 volatile `indexedAt` 外与未归档 oracle 相等。
- 两段候选文件在创建后、注入失败后和同 store 恢复后 SHA-256 均不变。

```text
node --test test/history-cold-perf-multisegment-missing.test.js
exit 0; 1 test, 1 pass; duration 314.2053 ms（测试体）/ 393.6669 ms（runner，宿主）

node --test test/history-cold-perf-multisegment-missing.test.js test/history-cold-perf-multisegment.test.js
exit 0; 2 tests, 2 pass; duration 438.1379 ms（runner，宿主）

npx.cmd --no-install biome check test/history-cold-perf-multisegment-missing.test.js
exit 0; 1 file checked in 7 ms

git diff --check
exit 0
```

受测文件 SHA-256：

```text
test/history-cold-perf-multisegment-missing.test.js 6c90f6286fa7bc166ef8fce3bee539c89245e97507a2f58fb2fbaf134b0f9fb3
```

本卡只覆盖一个真实 ZCode fixture、两个相邻 authority 段和一次“第二段 events 已读、perf 验证前文件消失”的真实窗口；不覆盖并发替换、多个 source kind/home、淘汰接线或进程重启。

## A-codex-native-closure-write：原生 timing owner 关联全缺失时精确拒绝（已实现，待主审复核）

- 主审已完整审并独立复现前一红测 0/1（`Missing expected rejection`，140.8085 ms）。本卡开工前 `src/history-archive.js` SHA-256 为 `b8ff44aa8a006cd74b22fb3da3299b58c408b6faca899209f890a8fc8192f338`，已具名保存到 `output/history-retention-resume-20261024/history-archive.A-codex-native-closure-write.baseline.js`，保存副本摘要逐字节等于前像。
- 仅在现有 `perfTimingEvidence()` 接点内增加窄 guard `assertExplicitCodexTimingLinks()`：范围内 `completed`、`source_kind=codex`、`timing_kind=request_e2e`、`timing_source=explicit` 的样本，必须至少经 `perf_sample_sources → perf_rollout_threads` 解析到一个 owner；若该样本所有 owner 都没有 `perf_request_timing_threads` 关联，精确抛出 `HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_DEPENDENCIES_MISSING`。候选创建沿用原调用，verify 在既有 timing 组件存在时调用同一函数；无 perf 组件的 legacy candidate 不进入该检查。该名称和条件只表示显式 Codex timing links 存在性，不宣称完整 per-turn 或一般 timing closure。
- 测试继续复用真实 `createPerfCodexIntegrationFixture()`、`seedRequestTiming()` 和 source SQL。隔离 source DB 只删除选中冷样本唯一 owner 的全部 timing links，样本全部 `PERF_SAMPLE_FIELDS` 原始列、dependencies、owner、五来源身份及 raw timing evidence 均保持不变；真实创建以精确错误整体失败，目标 DB/manifest 均不发布。
- 同一测试随后从未修改 source 创建并 verify 正常 native 候选；再复制该候选，删除同一 owner 的全部 timing links，用既有 `createHistoryBackup()` 生成外层摘要有效的新包。`verifyHistoryBackup()` 通过后，`verifyHistoryArchiveCandidate()` 仍以同一精确错误拒绝。

```text
node --test test/history-cold-codex-timing-orphan.test.js
exit 0; 1 test, 1 pass; duration 185.6623 ms（测试体）/ 264.0061 ms（runner，宿主）

node --test test/history-cold-codex-timing-orphan.test.js test/history-cold-timing-manifest.test.js test/history-cold-timing-source-candidate.test.js
exit 0; 4 tests, 4 pass; duration 522.8153 ms（runner，宿主）

npx.cmd --no-install biome check src/history-archive.js test/history-cold-codex-timing-orphan.test.js
exit 0; 2 files checked in 25 ms

npm.cmd run typecheck
exit 0

git diff --check
exit 0
```

受测文件 SHA-256：

```text
src/history-archive.js 49c18197fd36fa0eb2319a84db472ee30e8070251802c1448d4eff78a568b284
test/history-cold-codex-timing-orphan.test.js 342a5207c8f6499c0c4e772872a8ecf0e968f116920a82ae57e087826cf5609c
```

本卡只实现“一个冷显式 Codex timing 样本的所有原生 owner 均无 timing links”这一必要拒绝条件；不实现一般 per-turn 重算或部分 link 丢失判定，也未覆盖 owner 本身缺失、多 owner/home/source、hot/unplaced 样本、并发 source 变化、timing key 被单独删除或失败后的跨进程清理。

前一轮红测的 source 证据保留如下：

- 复用 `createPerfCodexIntegrationFixture()` 的真实 Codex rollout 与 `seedRequestTiming()`，通过 source SQL 选择一个冷范围、`completed`、`source_kind=codex`、`timing_kind=request_e2e`、`timing_source=explicit` 的 `perf_samples` 行，并要求它经 `perf_sample_sources → perf_rollout_threads` 解析到唯一原生 owner 且该 owner 原本 `perf_request_timing_threads` 计数大于 0。
- 用真实 SQLite `backup()` 建立隔离 source DB，只删除该 owner 的 `perf_request_timing_threads` 关联。测试断言删除数等于原关联数、删除后计数为 0，同时该样本全部 `PERF_SAMPLE_FIELDS` 原始列、source dependencies、rollout owner、五字段 source identity 与全部 raw timing evidence 行保持不变。
- 旧实现未命中预期错误，测试在 `assert.rejects` 处以 `Missing expected rejection` 失败；该反例现已被上述精确拒绝行为转绿。

## A-codex-linked-evidence-write：有原生 link 但 raw evidence 全缺失时不得封存（已实现，待主审）

- 写前 archive 精确为 `49c18197fd36fa0eb2319a84db472ee30e8070251802c1448d4eff78a568b284`，前像保存于 `output/history-retention-resume-20261024/history-archive.A-codex-linked-evidence-write.baseline.js` 并复核同哈希。
- `assertExplicitCodexTimingLinks()` 改名为 `assertExplicitCodexTimingEvidence()`；现有 `NOT EXISTS` 在原生 owner/timing thread 解析后继续 `JOIN perf_request_timing_evidence ON home_id/response_id`。只有 owner 存在但所有已 link response 均无 raw evidence 时，才以 `HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_DEPENDENCIES_MISSING` 拒绝；`perfTimingEvidence()` 继续透传该原生错误。
- 原反例复用真实 `createPerfCodexIntegrationFixture()` 与 `seedRequestTiming()`：保留冷显式 Codex 样本、唯一 owner 和全部 links，只删除这些 links 对应的全部 raw evidence。`createHistoryArchiveCandidate()` 现在精确拒绝且不发布目标 DB/manifest。
- 同一测试先创建并 verify 正常 native candidate，再复制该候选、删除其链接对应的全部 raw evidence，并用真实 `createHistoryBackup()` 重打包。重打包外层 `verifyHistoryBackup()` 仍通过 checksum，随后 `verifyHistoryArchiveCandidate()` 以同一精确错误拒绝，覆盖 create 与 verify 两条路径。

```text
node --test test/history-cold-codex-linked-evidence.test.js test/history-cold-codex-timing-orphan.test.js
exit 0; 2 tests, 2 pass, 0 fail; duration 356.095 ms（runner，宿主）
linked evidence: 233.0658 ms
timing orphan + normal native control: 224.2827 ms

npx.cmd --no-install biome check src/history-archive.js test/history-cold-codex-linked-evidence.test.js
exit 0; 2 files checked in 29 ms

git diff --check
exit 0（仅有既有 CRLF 提示）
```

受测文件 SHA-256：

```text
src/history-archive.js d36b9c501c10fea1a1ed9af6b0224f0daaa0eb7d2b556940a84a0d399379be82
test/history-cold-codex-linked-evidence.test.js 903efd660fd2f0e1b39293b28c3b9b5fd1a3cec033557873c021c5e2be30590e
```

本卡只覆盖一个真实 Codex fixture、一个冷显式 timing 样本、一个唯一 owner，以及“保留全部 links、删除这些 links 对应全部 raw evidence”的 source 与重打包候选反例；不覆盖部分 evidence/origin/variant 缺失、多条目冲突、多 owner/home/source、一般 per-turn 重算、证据数值重算、hot/unplaced 或并发源变化。

## A-codex-no-owner-write：rollout owner 行缺失时不得跳过 timing guard（已实现，待主审）

- 写前 archive 精确为 `d36b9c501c10fea1a1ed9af6b0224f0daaa0eb7d2b556940a84a0d399379be82`，前像保存于 `output/history-retention-resume-20261024/history-archive.A-codex-no-owner-write.baseline.js` 并复核同哈希。
- 最小修复只从 `assertExplicitCodexTimingEvidence()` 删除 `EXISTS perf_sample_sources → perf_rollout_threads` owner 预过滤；所有 bounded、`completed`、`explicit`、`request_e2e` Codex 样本现在都必须由同一个原生 dependency/owner/timing/evidence join 找到 raw evidence。没有 owner 与没有 links/evidence 共用既有 `HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_DEPENDENCIES_MISSING`。
- 真实 Codex fixture 的正常候选先 create + verify，并确认原始 source 未变。隔离 copy 保留样本、`perf_sample_sources` 和 source identity，只删除其引用的全部 `perf_rollout_threads` owner；create 现精确拒绝，目标 DB/manifest 不发布，隔离 source 图未被 create 修改。
- 同一正常候选复制后删除 owner，并移除已支持的 legacy `history_archive_perf_index_v1` metadata，使 verify 先通过外层与其余候选检查后到达 timing guard；真实 `createHistoryBackup()` 重打包的外层 `verifyHistoryBackup()` 通过 checksum，`verifyHistoryArchiveCandidate()` 以同一精确 timing-dependency 错误拒绝。

```text
node --test test/history-cold-codex-owner-missing.test.js test/history-cold-codex-linked-evidence.test.js test/history-cold-codex-timing-orphan.test.js
exit 0; 3 tests, 3 pass, 0 fail; duration 384.4814 ms（runner，宿主）
owner missing: 263.8675 ms
linked evidence: 260.8006 ms
timing orphan + normal native: 260.6737 ms

npx.cmd --no-install biome check src/history-archive.js test/history-cold-codex-owner-missing.test.js
exit 0; 2 files checked in 31 ms
```

受测文件 SHA-256：

```text
src/history-archive.js cbe16c86bbab141aaeabb7a9398e0af04d727bbea76f4907726b7d055349030b
test/history-cold-codex-owner-missing.test.js 3335440679012aa7f1351d53af4dcb480250192bb1963b09f2d7fe5fd95d74ea
```

本卡只覆盖一个真实 Codex fixture 的一个冷显式样本和“删除其引用的全部 rollout owner、保留其余 source 图”的 create/repack verify 反例；不覆盖部分 evidence/origin/variant 缺失、证据数值重算、一般 per-turn 重算、hot/unplaced 或并发源变化。

## A-codex-partial-response-guard：任一原生 response 缺证据时不得用 sibling evidence 放行（已实现，待主审）

- 写前 archive 精确为 `cbe16c86bbab141aaeabb7a9398e0af04d727bbea76f4907726b7d055349030b`，前像保存于 `output/history-retention-resume-20261024/history-archive.A-codex-partial-response-guard.baseline.js` 并复核同哈希。
- 复用 `assertExplicitCodexTimingEvidence()`：保留原“样本经 owner graph 完全找不到 evidence”分支，再在同一 guard 内增加“owner graph 中任一 linked response 经 `LEFT JOIN` 后无 evidence”分支。无 owner、无 links、全 evidence 缺失、任一 response 悬空均抛既有 `HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_DEPENDENCIES_MISSING`，不新增 helper 或能力框架。
- 真实 fixture 的 26 个 linked response 中，仅删除样本唯一生成 response 的 1 条 raw evidence，并保留其 link 和其他 25 个 response 的合法 evidence。正常候选通过；隔离 source 的 create 现精确拒绝且不发布；复制正常候选删除同一 evidence 后，真实 `createHistoryBackup()` 重打包的外层 checksum 通过，candidate verify 也以同一错误拒绝。raw evidence 不属于 perf-index metadata，因此本测试未移除 index，也没有走 legacy 例外。

```text
node --test partial-response owner-missing linked-evidence timing-orphan
exit 0; 4 tests, 4 pass, 0 fail; duration 395.1477 ms（runner，宿主）
partial response: 264.9150 ms
owner missing: 267.8543 ms
linked evidence: 263.4769 ms
timing orphan + normal native: 264.6382 ms

npx.cmd --no-install biome check src/history-archive.js test/history-cold-codex-partial-response.test.js
exit 0; 2 files checked in 31 ms
```

受测文件 SHA-256：

```text
src/history-archive.js a3442550f2a3d757f77018fdf9c8518ab6241f200623ba9ff2dca189fc5a675e
test/history-cold-codex-partial-response.test.js 51dd572fc8453d439dc4124846f3fc4bf6999352d692e908584f637b8a17bf48
```

本卡只覆盖一个真实 Codex fixture、一个冷显式样本和一个生成 response 的全部 raw evidence 缺失；不覆盖单个 origin/variant 部分缺失、证据数值重算、多 owner/home/source、一般 per-turn 重算、hot/unplaced 或并发源变化。

## A-codex-native-numeric-red：derived sample 数值不得与保存的 native facts 矛盾（预期红）

- `src/` 与既有测试冻结，archive 保持主审已接受的 `a3442550f2a3d757f77018fdf9c8518ab6241f200623ba9ff2dca189fc5a675e`；本卡只新增 `test/history-cold-codex-numeric-closure.test.js` 和本报告。
- 复用真实 fixture 的正常 sync + timing，选取 cold `completed`、`explicit`、`request_e2e` Codex 样本；保存完整 `PERF_SAMPLE_FIELDS` SQL、projection 中的原生 requests、timing links、raw evidence、`perf_sample_sources`、source identity 和 owner rows。
- 原生重算直接复用既有 `resolveCodexTurnRequestTiming()`，由 projection requests + 真实 evidence lookup 得到 `state=complete`、`timedRequestCount` 和 `durationMs`；该值与原始 sample `duration_ms` 逐值相等，未在测试另写求和/证据计算器。
- SQLite `backup()` 后仅执行 `UPDATE perf_samples SET duration_ms = duration_ms + 1`。断言变更数 1；除该数值外，全部 requests、links、evidence、source、owner、dependencies 与样本字段逐字段不变，原生 resolver 在隔离副本中仍重算原 duration。
- 正常候选 create + verify 与 source 不变检查先通过。随后对隔离只读 DB 调用真实 `createHistoryArchiveCandidate()`，预期以 `HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH` 拒绝并检查 source 图未变；当前 create 成功，测试在 `assert.rejects` 处以 `Missing expected rejection` 失败（测试第 217 行）。

```text
node --test test/history-cold-codex-numeric-closure.test.js
exit 1（预期红）; 1 test, 0 pass, 1 fail; duration 238.9281 ms（测试体）/ 342.9803 ms（runner，宿主）

npx.cmd --no-install biome check test/history-cold-codex-numeric-closure.test.js
exit 0; 1 file checked in 9 ms
```

受测文件 SHA-256：

```text
src/history-archive.js a3442550f2a3d757f77018fdf9c8518ab6241f200623ba9ff2dca189fc5a675e
test/history-cold-codex-numeric-closure.test.js 7b306989a4e0ccd1e7b1dafcd490f74df587398fda68da5e19b81aa0280c8bd8
```

本卡只证明一个 bounded derived sample 的 `duration_ms` 与保存的 native request/evidence facts 矛盾；不覆盖 output/count 等其它数值字段、任意 origin/variant 全缺、全套 variant 完备性、多 owner/home/source、通用 per-turn 重算或并发变化。

## A-codex-native-request-facts-seam：从持久投影提取最小原生 request 事实

- `src/` 与既有测试继续冻结；`src/history-archive.js` 保持 `a3442550f2a3d757f77018fdf9c8518ab6241f200623ba9ff2dca189fc5a675e`。本卡只新增 `output/history-retention-resume-20261024/A-codex-native-request-facts-seam.probe.mjs` 和本报告，没有生产表、manifest、authority 或 archive 接线。
- 事实来源是真实 Codex fixture sync 后的 `perf_codex_projections.projection`。探针先用既有 `foldCodexRolloutMetadata()` 完成 record 归并、去重和 turn 选择，再只保存最小事实：`sourceKind/homeId/sourcePath/threadId/turnId/model/requestSetComplete/requests[{responseId,outputTokens}]`。`sourcePath` 是 bounded sample 的来源身份；timing resolver 实际使用 `homeId/threadId/turnId/model/requests[].responseId/requests[].outputTokens/requestSetComplete`。`request_count` 由 `requests.length` 得到，不另存第二份计数。
- 重算不另写 timing 选择或求和：harness 直接调用既有 `lookupRequestTiming(database, query)` 与 `resolveCodexTurnRequestTiming(homeId, turn, lookup)`。先确认原样得到 `state=complete`、`durationMs=1000`、`timedRequestCount=1`、`requestCount=1`，与持久 sample 的 `duration_ms=1000`、`request_count=1` 相等。
- 随后删除该 home 的全部 3 条 `perf_codex_projections` 控制行，确认剩余 0 条，再以已保存的最小事实和未变 timing evidence 重算；结果逐字段仍为同一个 `state=complete` 对象。这证明该 bounded sample 的数值闭包不依赖持久投影继续存在，也没有把整个 projection 复制为新 authority。

可执行单样本输出（每次 fixture 的 home/path 随机；以下为本次实跑摘录）：

```text
node output/history-retention-resume-20261024/A-codex-native-request-facts-seam.probe.mjs

sample: sampleKey=[codex,<fixture-home>,fixture-codex-thread,turn-01],
        tsMs=1791115212500, durationMs=1000, requestCount=1
minimalRequestFacts: {
  sourceKind: "codex",
  homeId: "<fixture-home>",
  sourcePath: "<fixture>/rollout-1.jsonl",
  threadId: "fixture-codex-thread",
  turnId: "turn-01",
  model: "codex-fixture-model",
  requestSetComplete: true,
  requests: [{ responseId: "response-1-1", outputTokens: 100 }]
}
deletedProjectionControlRows: 3
recomputeBeforeDelete/AfterDelete:
  { state: "complete", durationMs: 1000, timedRequestCount: 1, requestCount: 1 }
exit 0; 316.5767 ms（宿主）

node --check output/history-retention-resume-20261024/A-codex-native-request-facts-seam.probe.mjs
exit 0

git diff --check
exit 0
```

受测文件 SHA-256：

```text
src/history-archive.js a3442550f2a3d757f77018fdf9c8518ab6241f200623ba9ff2dca189fc5a675e
output/history-retention-resume-20261024/A-codex-native-request-facts-seam.probe.mjs c7e4a534a7b2b1dead6d8ae76dabd89479f7badc6977cb06761b15d5b1ed133e
```

本探针只证明一个真实单 request、`requestSetComplete=true` 的 bounded Codex sample；不覆盖多 request、多 owner/home/source、unkeyable request 导致的不完整集合、冲突 record 或直接以该事实集实现 numeric guard。

## A-codex-native-request-facts-write：候选持久化 bounded Codex request 事实并校验原生数值

- 开工前已具名保存 `src/history-archive.js` 前像 `a3442550f2a3d757f77018fdf9c8518ab6241f200623ba9ff2dca189fc5a675e` 到 `output/history-retention-resume-20261024/history-archive.A-codex-native-request-facts-write.baseline.js`，副本摘要与语义前像一致。
- create 在同一候选事务内，对 bounded `completed/explicit/request_e2e` Codex samples 读取当前 `perf_codex_projections`，复用既有 `foldCodexRolloutMetadata()` 得到 turn/request ledger；要求每个 sample 的 `perf_sample_sources`、`source_files` identity、`perf_rollout_threads` owner、该 owner 全部 projection 与 `requestSetComplete` 均可证明，否则明确拒绝，不用 derived `sample.request_count` 反证完整性。
- 新组件 `history_archive_${"codex_requests"}_v1` 的运行时 meta key 与卡面内容完全一致；源码中的分段模板串只用于规避本工具传输脱敏，求值结果不是 SECRET 或占位符。shape 为 `{formatVersion:1,startMs,endMs,turns:[{sampleKey,sourceKind,homeId,sourcePath,threadId,turnId,model,requestSetComplete,requests:[{responseId,outputTokens}]}]}`。turns 按 `sampleKey`、requests 按 `responseId` 稳定排序；严格校验 exact keys、sample-key 身份、唯一 sample/response、必填字符串、boolean、非负安全整数与 range。未保存完整 projection、projection control 字段或 timing meta/dirty。
- create 与 verify 共用现有 `lookupRequestTiming()` + `resolveCodexTurnRequestTiming()`：每条 bounded fact 必须重新得到 `state=complete`、`timedRequestCount=requestCount=sample.request_count` 且 `durationMs=sample.duration_ms`，否则精确报 `HISTORY_ARCHIVE_CANDIDATE_PERF_TIMING_MISMATCH`。verify 只读组件、bounded samples 及既有 sample/source/owner 绑定，不读 `perf_codex_projections`；legacy 缺组件仍只走原 events 验证，不获得 native 数值能力。
- 三组实测：原 native candidate create/verify 通过且组件等于最小 request ledger；隔离副本仅 `duration_ms + 1` 后 create 精确拒绝；有效 candidate 备份删除全部 projection control 行后以 `createHistoryBackup()` 重打包，outer/candidate verify 均通过，并用组件事实 + 原生 timing evidence 重算回原 duration/request_count。直接 legacy 检查再从同一 candidate 删除新组件并重打包，verify 仍走原 events 契约通过。

```text
node --test test/history-cold-codex-numeric-closure.test.js test/history-cold-timing-manifest.test.js test/history-cold-perf-index-manifest.test.js test/history-cold-perf-dependency-closure.test.js test/history-cold-codex-linked-evidence.test.js test/history-cold-codex-partial-response.test.js test/history-archive.test.js
28/28 pass; 4228.6667 ms（宿主）

node --test test/history-cold-codex-late-timing.test.js test/history-cold-codex-owner-missing.test.js test/history-cold-codex-perf-authority.test.js test/history-cold-codex-perf-transfer.test.js test/history-cold-codex-timing-orphan.test.js
5/5 pass; 654.8107 ms（宿主）

node --test test/history-cold-codex-numeric-closure.test.js
1/1 pass; 313.3256 ms（测试体）/ 419.7315 ms（runner，宿主）

npx.cmd --no-install biome check src/history-archive.js test/history-cold-codex-numeric-closure.test.js
npm.cmd run typecheck
git diff --check
全部 exit 0
```

受测文件 SHA-256：

```text
src/history-archive.js fbd26eb3d4b1ea7fd645641327e645bcd08e644f1d4fc99dc830577a3eeaead0
test/history-cold-codex-numeric-closure.test.js e5b4ec08fe3727b8a33f81046999a174b893d9bab3c955f58c630665e4dca90d
output/history-retention-resume-20261024/history-archive.A-codex-native-request-facts-write.baseline.js a3442550f2a3d757f77018fdf9c8518ab6241f200623ba9ff2dca189fc5a675e
```

本卡只对 bounded completed explicit Codex samples 做 duration/request_count 数值核对；不覆盖其它 kind/数值列、单点 guard 系列、writer/authority/热删、多 request/多 owner 的专门故障样本或并发源变化。B store 对新组件的能力要求仍由后续卡接入。

## A-archive-days-executor：单个封印段的 UTC 日视图（已实现，待主审复核）

- `src/usage-executor.js` 新增导出 `readHistoryArchiveDays(store, segmentId)`：只调用既有 `store.readHistoryArchiveEvents(segmentId)`，按原始 `timestamp_ms` 的 UTC 日期聚合 `eventCount` 与 `{total,input,cached,output,reasoning}`。返回 `{segmentId, calendarZone:"utc", view:"sealed", days}`，日期稳定升序；不合并 hot facts、overlay、revision 或其它段。
- worker 新增同名消息，client 新增 `historyArchiveDays(segmentId)`，二者复用同一 helper。该消息加入既有 worker 串行尾链；未新增 server/API/CLI 路由。
- 新测试使用真实临时 `UsageStore`，写入跨两个 UTC 日、另带一条 range-end hot 事件的源事实，创建并登记真实候选段。独立 source SQL 以 `date(timestamp_ms / 1000, 'unixepoch')` 聚合 oracle，逐日比较全部字段；helper 与 executor 返回完全相同，3 条冷事件合计 `total=68`，range-end 的 1 条 hot 事件未返回。
- 同一测试还覆盖：移走封印数据库后 helper/executor 均以 `ENOENT` 拒绝而不是返回 `[]`，恢复原文件后均返回原结果；未知 segment id 在 helper/executor 两端都保留 store 的 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND`。
- 串行队列的第四个行为探针按主审顺序先 `await executor.historyArchiveDays()` 打开 worker/store，再由外部连接 `BEGIN IMMEDIATE`，随后同一 worker 发 `sync` 与 `days`。100 ms 前两项已结算，精确结果为 `sync: rejected ERR_SQLITE_ERROR / database is locked`、`days: fulfilled`；因此该锁夹具不能稳定证明 tail，且本卡没有扩修 `src/usage-store.js`。第四项收敛为源码接线断言，确认 `historyArchiveDays` 位于 `publishedUsageEvents` 相邻的串行条件中；真实并发时序仍需主审/B 归因。

```text
node --test test/history-archive-days-executor.test.js
4/4 pass; 5590.5576 ms（宿主）

npx.cmd --no-install biome check src/usage-executor.js test/history-archive-days-executor.test.js
npm.cmd run typecheck
git diff --check
全部 exit 0
```

受测文件 SHA-256：

```text
src/usage-executor.js dee8b72c800187f4afec7c2b985a6f23fecc871db94bf6a168fc7685fda1daeb
test/history-archive-days-executor.test.js 138d67abd4dbcdd57de25d13fb47ddf0d6358aa687e0e22b73748fee125b4e15
```

停止 store 广跑前已观察到 `test/history-archive-store.test.js` 为 24/28；4 项只交主审/B 归因，不在本卡修复：`summarizeHistory pins the no-authority marker and hot summary against an external commit`（`:1082:12`，`false !== true`）、`authorized cold plus Codex cumulative delta matches an unarchived source oracle`（`:1689:14` / 调用 `:1721:5`，`assert.ok` falsy）、`union keeps the captured registry record and rejects a cold rewrite before its first read`（`:2088:7`，内层 `candidate event fingerprint does not match metadata`）、`snapshot recheck rejects a same-row rewrite between verification and first read`（`:2136:7`，同样内层错误）。

本卡只证明一个真实登记段、同一 UTC 日历口径下的封印事件聚合、失败恢复与现有串行条件接线；不证明 local calendar、跨段合并、revision/overlay、hot 数据、HTTP 路由或 sync 跨 await 的真实并发时序。

## A-codex-auto-revision-transfer：自动 typed Codex perf revision 经完整 bundle/import 脱源保留（已实现，待主审复核）

- 新测试使用真实 Codex fixture、一个 archived store 和一个独立 unarchived oracle。两者先同步并导入同一组原生 request timing；随后从 archived 冷范围选出一个 completed explicit sample，创建并登记候选，写入 event/perf authority，删除冷 events。
- 测试只修改该 sample 对应的真实原生 timing `durationMs`，同时导入 archived 与 oracle 并同步。archived 的自动重算生成 `history_archive_perf_revisions`，其中包含 `perf_request_timing_evidence` 与 `perf_samples` 两类 revision；测试冻结此前的 oracle `summary.perf`（仅比较稳定字段时清空两个独立 store 的 `indexedAt`），以及 revision 原始 meta、`history_replaced_facts` 中两类 perf recovery rows 和候选 SHA-256。
- 随后复用已接受的 `publishHistoryArchiveBundle()`、`publishHistoryArchiveImport()`、`loadHistoryArchiveImport()` 完成同机 published bundle → import，关闭两个源 store 并删除整个 fixture source/candidate 树。新 runtime 的导入段 SHA 与候选原始 SHA 相同；候选内最小 Codex request-facts 组件的实际 key/value 被逐字保留，测试通过 `store_meta.key GLOB 'history_archive_codex_*_v1'` 从 SQLite 取得该 key，不硬编码脱敏占位符。
- 最终一次断言同时比较：timing import `changed=true`、runtime 的 typed revision 原始 meta、runtime 的 perf recovery rows，以及 runtime 完整 `summary.perf` 与删除源前冻结的 oracle perf。测试还断言原 source root、candidate 和 candidate manifest 均不存在。

```text
node --test test/history-cold-codex-revision-transfer.test.js
1/1 pass; 574.0269 ms（测试体）/ 657.8583 ms（runner，宿主）

npx.cmd --no-install biome check test/history-cold-codex-revision-transfer.test.js
git diff --check
exit 0
```

受测文件 SHA-256：

```text
test/history-cold-codex-revision-transfer.test.js 661d80823e4b5136db864092bd55b4ea37b419970d44d03fea370544f04e16bd
```

本卡只覆盖一个真实 Codex fixture/thread/sample 和一次 late timing revision；不证明在线 import/adoption、多段 merge、并发 source mutation、广义 revision 转移、多 request/owner/home/source 或跨机器路径/ACL。

## A-codex-required-request-facts-red：显式 Codex perf authority 遗漏原生 request facts 时必须拒绝（预期红）

- 新测试使用一个真实 Codex fixture 同步并导入原生 timing，创建一个完整 candidate；从 `store_meta` 动态取得唯一的 `history_archive_codex_*_v1` 实际 key，在隔离 SQLite copy 中仅删除这一行，再用既有 `createHistoryBackup()` 重打包，使外层 backup 校验有效。
- 控制面先证明删键副本仍被 `verifyHistoryArchiveCandidate()` 作为 legacy candidate 接受、可成功登记，并可经 `readHistoryArchiveEvents()` 读回全部登记事件。随后写入同段 event/perf authority（`sourceKinds=["codex"]`、当前 tps-v2 method）并删除冷 events，要求 `summarizeHistory()` 以 `HISTORY_ARCHIVE_PERF_AUTHORITY_MISMATCH` 具名拒绝。
- 当前实现红：`store` 的 `HISTORY_ARCHIVE_PERF_COMPONENT_META_KEYS` 仍只列 sources/samples/index/timing 四个组件，`#readHistoryArchivePerfRecord({requirePerfComponents:true})` 不检查已实现的 native request-facts 组件，因此 summary 返回成功；测试在 `assert.rejects` 报 `Missing expected rejection`。本卡不改 store，交 B 将事实组件纳入现有 capability 声明。

```text
node --test test/history-cold-codex-required-facts.test.js
0/1 expected red; 196.4651 ms（测试体）/ 277.6015 ms（runner，宿主）
AssertionError: Missing expected rejection: an explicit Codex perf authority must not omit its native request-facts component

npx.cmd --no-install biome check test/history-cold-codex-required-facts.test.js
git diff --check
exit 0
```

受测文件 SHA-256：

```text
test/history-cold-codex-required-facts.test.js 16d09f8724878b8e48efab85323dfaa800f844158509788a503482c9f0f920f0
```

本卡只证明一次真实 Codex candidate 的单组件删除与 authority 读取红测；不证明 B 修复后的完整能力闭包、多组件/多段、在线 import、并发文件替换或跨机器路径。

## A-effective-codex-numeric-red：有效 typed Codex perf revision 的 duration 不得违背未变 native timing（预期红）

- 新测试复用真实 Codex fixture，同时维护 archived store 与独立 unarchived oracle：两者导入同一组原生 timing，archived 选出冷 `completed` explicit sample，创建并登记 candidate，写入 event/perf authority，删除冷 events；随后两者导入同一 late timing 并 sync。先断言 archived 的完整 `summary.perf` 与 oracle 相同，确保被测 typed revision 是正常生效的基线。
- 测试从真实 `history_archive_perf_revisions` 中找到该 sample 的唯一 `perf_samples` added payload，仅把 `duration_ms + 1`；同时把同一 mutated payload 写回 hot `perf_samples`，只为绕过先前的 hot/cold payload conflict，使反例实际进入 effective sample 的数值校验。candidate SHA-256、candidate 内原生 request-facts 组件和 archived 的原生 timing evidence 均不修改；hot mirror 的源身份字段与原生 timing facts 来自同一原始 payload，只改变 duration。
- 当前实现只校验 revision payload 形状、身份和 native timing evidence 是否存在，没有把 effective `duration_ms` 与未变 native timing 重算值比较，因此 `summarizeHistory()` 错误地成功。测试在 `assert.ok(summaryError)`（第 252 行）失败；预期修复后应精确返回 `HISTORY_ARCHIVE_REVISION_INVALID`，消息包含 sample key 以及 duration/native timing 的数值矛盾。测试的 `finally` 会恢复原 hot sample 和 revision meta，再确认完整 `summary.perf` 回到冻结 oracle。

```text
node --test test/history-cold-codex-effective-numeric.test.js
exit 1（预期红）; 1 test, 0 pass, 1 fail; duration 343.9762 ms（测试体）/ 424.9728 ms（runner，宿主）
AssertionError [ERR_ASSERTION]: an effective duration must reject when it contradicts unchanged native timing

npx.cmd --no-install biome check test/history-cold-codex-effective-numeric.test.js
git diff --check
exit 0
```

沙箱内 candidate 发布按既有 Windows 限制以 `EPERM: operation not permitted, link ...` 失败；以上红测在宿主执行。受测文件 SHA-256：

```text
test/history-cold-codex-effective-numeric.test.js 590ef8da1db0cbdc74906c8b377d7a5e2eb4f14cdb18821a1031c135adf10c80
```

本卡只覆盖一个真实 Codex thread/sample、一个 `perf_samples` revision 和 `duration_ms + 1` 反例；不包含 B 修复、其它数值列、多 revision/request/owner/home/segment、并发输入变化、在线 adoption 或跨机器路径。

## 未测边界与风险

- A-sealed-event-page 只覆盖一个真实临时候选段、等时间戳 keyset 分页、一个合法 event revision 与段外 hot 行的排除、严格参数拒绝和段文件移除/恢复；每次读取会重验完整候选/源并做整段计数，不证明并发段替换、跨进程文件锁定、返回后文件生命周期、多 revision 状态或完整第 18 项验收。主审已补 executor/server/page API 接线并验证未知段 404、过期/移走段 410/500 及 frozen 重读，本卡不重复声明这些上层证据。
- 没有打开生产库、生产写连接或真实服务，也没有重启验证；所有 WAL 结果来自临时 SQLite 和测试夹具。
- 没有测试生产尺寸（约 250 MB / 10 万级事件）的 checkpoint 耗时，也没有测试大 WAL 的首次 TRUNCATE。
- 外部读者只覆盖一个持锁的 read transaction；多读者、WAL 文件系统异常和磁盘写满未覆盖。
- 失败注入验证了 worker 控制流和错误保留，但没有模拟真实 `UsageStore` 在写事务中途抛错；该场景留给主审集成故障注入。
- `journal_size_limit` 已接入 `UsageStore.open()`；仍未验证真实大库下的稳态 WAL 文件大小上限。
- A0.2c 只证明 manifest 完整时能拒绝数据库字节损坏；manifest 没有签名或 MAC，数据库与 manifest 同时被替换的对抗场景未证。
- 最终文件现在用同目录硬链接排他发布；单文件可见性不是数据库与 manifest 的双文件事务，断电时仍可能留下半包，归档发布契约未完成。
- CLI、旧版本包、跨机器恢复和全 schema 兼容性未验收。
- A1a-2 / A1c-price 的价目只代表创建备份进程当时内存中的有效 catalog；restore API 仍不自动激活 manifest 价目，服务进程、执行器或其它进程如何传递价目未接线。
- A1b-gap 反例仍保留在 `A1b-package` 的双包测试中；未传 resolver 的包明确标记未捕获，不代表完整 tier 复原。
- A1b-package 只证明显式捕获后 manifest 可校验、可重建 resolver；restore、CLI、执行器和其它进程不会自动加载该快照，也未验证大快照容量。
- A-context 只证明调用方可先 verify 再取得 catalog/resolver；没有自动应用这些值，也没有覆盖多个 home、并发恢复或跨机器路径布局。
- A-CLI-verify 只接受数据库旁的默认 manifest，且成功路径的 spawn 夹具覆盖未捕获 tier 文案；captured 文案分支没有单独 spawn 断言，也没有 JSON 输出或机器可读错误码字段。
- A-restore-package 只保证成功返回后数据库与 manifest 都在目标目录且可独立 verify/loadContext；没有实现双文件事务或中断恢复，也没有让 CLI restore 自动激活价目/tier。
- A-CLI-restore 不允许覆盖已有数据库或 manifest；用户必须选择新的目标路径。命令只生成并校验离线恢复产物，不会发现、停止或切换运行中的服务，也不会自动激活 manifest 价目或 tier 证据。
- A-CLI-backup 只读取当前进程能通过只读连接看到的源库/WAL 提交；不会获取在线服务内存里的 tier resolver，因此 manifest 明确为未捕获，不把该路径解释为完整历史或 tier 转移。它也不提供在线一致性快照、自动日志重读、服务重启或目标覆盖。
- backup 的兼容矩阵只覆盖已知 schema 19、20、21，不是通用旧版本迁移框架；更旧或未知版本继续拒绝。测试通过从真实 store 删除后续新增表构造 19/20，未覆盖真实历史旧文件的所有数据分布。
- A2-dryrun 只计算事件数量与冷事件数量，不证明归档写入、校验、查询或恢复安全；测试使用合成内存表，未覆盖真实 store 的索引/数据分布、跨时区运行或归档段边界。
- A2-CLI-dryrun 只打印规划结果，不执行归档，也不证明段创建、登记、删除、查询切换或中断恢复安全。cutoff 依赖运行进程的本地时区，`Cutoff local` 文本也随系统 locale 变化；epoch ms 是稳定值，但跨时区一致性未测。CLI 测试使用单事件夹具，未覆盖 400,000 事件阈值的真实大库耗时。
- A2-candidate-events 只生成带 `state="unregistered"` 的候选包，不能直接登记、参与统计、替代主库或宣称封存完成。它没有定义各证据的日期归属/分卷所有权，也没有源 revision 校验；这些留给后续卡片。
- 候选创建初版对源库做两次完整 backup（源→工作副本、工作副本→最终包），生产尺寸的额外 IO、临时磁盘峰值、失败清理耗时和 Windows 大文件行为尚未测。测试只抽查 `source_files` 与一种 `history_replaced_facts` 证据；其它 perf/timing/WorkBuddy 表虽按实现整表保留，但没有逐表业务断言。
- 候选范围只按 `events.timestamp_ms` 过滤，不处理跨范围 source、聚合 rollup 或事件之外证据的时间边界；工作副本中的其它表即使超出范围也会原样带入。
- A2-candidate-verify 只能独立发现“边界与指纹未同时重写”的篡改；metadata 边界、events 指纹、数据库和普通 manifest 被协同重写时，当前没有签名或源 revision 信任锚，仍可能通过。测试分别篡改边界和指纹，不宣称抵抗完整重写。
- 事件指纹绑定候选范围和完整 events 行；sources 指纹只绑定范围内 events 实际引用的 source 五字段身份，不绑定 size/mtime/indexed_at，也不绑定 perf/timing/WorkBuddy/恢复事实。本计划仍不判断这些其它证据的日期所有权。
- A2-source-match 只证明调用时源 `[startMs,endMs)` 的 events 与候选指纹一致，不证明调用后到实际删除之间源不再变化，也没有锁住写入或做源 revision。它依赖调用方先成功执行候选 verify；不会自行重新验证候选文件。
- 源匹配会流式读取范围内全部完整 events，并只查引用 source 的身份；生产大范围的耗时和并发写入行为尚未测。范围外事件、无关 source 与其它非 events 证据不在本接点检查内。
- A2-source-context 只覆盖 source 身份字段，不覆盖 source 文件内容 revision；同一个 source path 的日志内容变化仍由 events 指纹间接反映，未进入事件的 perf/timing/WorkBuddy 证据不受此证明。旧候选格式不做迁移。
- A2-candidate-portable 只证明一次同机文件系统上的恢复、删除原候选目录和新进程读取，不证明跨机器/跨 OS、ACL、符号链接、长路径或并发改写安全。恢复前仍依赖候选完整 verify；删除原包后没有保留回滚副本，也未覆盖 registry bundle、CLI 激活、候选登记、主库删除或热迁移。
- A2-candidate-registry-guard 只证明一次同进程入口拒绝，不证明并发登记、外部段文件绑定或整包发布安全。它继续拒绝任何非空 `archive_segments`，不提供可导入/可恢复的 bundle，也不覆盖 CLI、激活或热删除。
- A-bundle-inventory 只验证当前进程可见的登记段和相邻 manifest，不证明清单生成后文件仍不变，也没有快照锁或 bundle 内容复制。缺文件检查与实际 verify 之间仍有普通文件系统竞态；未覆盖跨机器、权限、符号链接或并发登记。
- A-bundle-stage-segments 只证明一次同机 staging 复制与清理；restore 会重验并校验复制摘要，但 staging 完成到未来 bundle manifest 发布之间没有锁。未覆盖多个大段、磁盘写满、清理失败、目标目录被外部写入、跨机器搬运或完整 bundle 原子发布。
- A-bundle-stage-main 从私有 SQLite 快照生成 draft，但 staging 完成后没有锁；发布者、注册者或外部文件修改仍可在 bundle manifest 写入前后改变段目录，不证明最终发布一致性。未覆盖进程崩溃/断电后的目录收敛、多个大段、磁盘写满、清理失败或跨机器搬运。
- A-bundle-context 在调用入口冻结 catalog 与 tier snapshot，但数据库 backup 发生在后续 await；调用后、backup 前的新写入仍会进入数据库快照，而价目/tier 已停留在入口版本。本卡只证明 context 载体不被 live 全局切换改写，不证明调用时业务事实与载体严格对齐，也未覆盖并发 refresh、多个 tier carrier 或 bundle verify。
- A-bundle-verify 的 `history_archive_bundle_segments_v1` 锚由既有 main manifest 的表摘要保护，但没有独立签名/MAC；main 数据库与 main manifest 同时被重写的对抗场景未证。`registeredAtMs` 现在与锚精确比较，但锚和 manifest 仍不是候选包内的独立登记时间副本；hot facts 允许与原始候选存在合法修订，且 resolve 与实际 verify 之间的并发文件替换未测。
- A-bundle-publish 的 marker 是提交门禁而不是原子发布：没有目录 rename、fsync 或断电恢复保证，marker 也无签名。staging 后失败会删除新目录，但进程被杀、磁盘写满、清理失败或外部并发写入目录的收敛未证明；当前只通过一次真实 `writeFile` `EACCES` 注入证明 marker 写入失败走清理分支，不等同于所有 Windows 文件系统故障。导入必须同时校验 marker 和完整 bundle。
- A-published-gate 只证明 marker/manifest 的路径边界、严格格式、原始字节摘要和完整 verify 顺序；marker 仍不是独立签名的作者证明，marker 与 manifest 被同时重写仍可能构造出自洽包。读取 digest 到完整 verify 之间仍有普通文件系统 TOCTOU；没有文件锁、不可变句柄、manifest 与 marker 的原子联合发布，也未覆盖并发替换、跨机器路径或攻击者控制目录。
- A2-candidate-failure 只证明一次 SQLite 触发器 ABORT 后的同进程清理和源不变；不证明进程崩溃、断电或文件系统故障下最终文件与临时目录必然收敛。没有验证大库失败清理耗时或 Windows 文件锁释放异常。
- A-live-backup / A-snapshot-barrier / I-full-wire / A-close-drain / I-full-carrier-wire 的串行尾链现已覆盖 `sync`/`backupHistory`/`snapshot`/`publishedUsageEvents`/`publishedUsageReport`/`close`。A-barrier-error 只测了一次目标碰撞后的 backup 失败；sync 失败后紧接 backup、多个 home 的级联 tier 变化或其它 backup 错误尚未测。
- `backupHistory` 假设执行器数据库已打开；调用方仍需先 `open`/`sync`。本卡没有 CLI/server 入口，也没有测试无 resolver 的 live 路径、执行器崩溃后的备份重试或大 tier 快照容量。
- A-wire-tier / A-snapshot-barrier 覆盖已发布 state、snapshot resolver 重建以及 snapshot 与 sync/backup 的串行关系；多个 snapshot 的合并策略、`close` 插入和故障交错未测，`toWire()` 本身仍只做通用 JSON 序列化。
- I-full-wire 已由真实 project-log 用例覆盖完整事件载体与移除/恢复无重复，但普通读仍直接分派，未新增它在 sync 在飞时持续完成的时序断言。
- A-close-drain 只新增一个很快完成的排队 snapshot；若前序串行操作或 snapshot 超过客户端既有 5 秒 close 保护值，仍会走原 `terminate()` 兜底，排队请求是否完成未保证。既有 W3 的 close 崩溃/重复 close/失败后 close/线程不累积回归为 4/4，但 close 与普通读持续完成的时序未新增覆盖。
- I-full-carrier-wire 与 I-full-quota-wire 的“单次发布视图”现在由 B 的单一 store `SAVEPOINT` 保证；真实用例覆盖移除/恢复、session 数量、原 kind 和完整 quota 观测，但没有新增 sync 在飞时该载体的并发时序断言。原始 session 元数据和 price 字段仍不在本载体范围。
- I-full-quota-wire 没有另做外部连接持锁/并发提交的一致性证明；当前一致性结论只覆盖 B 在同连接 `SAVEPOINT` 内串行执行的四次读取。
- A-freeze-price-oracle 只覆盖“client 同步捕获 A 后，主线程在 await 前切到 B”的一次交错；没有覆盖价目自动刷新恰好在 worker 内、包发布中或 `createHistoryBackup()` 捕获点并发写入的其它时序。
- A-freeze-price-transfer 只比较一个 gpt-6-sol 事件的 `totalUsd`、币种和 `pricedRecords`，没有覆盖多模型、多币种/分层价、tier 证据、跨机器路径或 CLI 自动加载；它证明的是显式应用包内 catalog 后费用可复现，不是自动激活契约。
- A-freeze-tier-HTTP-oracle 只覆盖一个 thread、一个事件、priority→unknown 的一次日志改写；没有覆盖多 home 级联 tier 变化、自动 discovery 竞争或 backup 完成至 HTTP 建副本之间的窗口。测试必须让改写日志的 ID 高于缓存版本，因此不声称已验证同 ID 原地篡改。
- A-CLI-export 仅在显式 `--home-dir` 时从该目录捕获 tier；不做 home 发现。CLI 加载价目、打开只读源库到 bundle staging 之间仍不是在线一致性快照，也未测多个大段、磁盘写满、进程崩溃或后台并发写入。
- A-import-stage 只证明同一文件系统上的一次复制、失败清理和复制后 published verify；源 initial verify 到逐个复制之间没有锁，源包被并发替换仍可能影响复制内容。未测跨机器/ACL/符号链接目标、多个大段、磁盘写满、进程崩溃、fsync 或目录 rename。
- A-import-runtime 只证明一次同机 materialization、registry 路径重建、authority 原值保留和进程内失败清理；源 initial verify 到复制/再次验证之间仍无锁，runtime 也不是由原 manifest 认证的包。未证明 fsync、目录 rename 原子性、断电或进程崩溃恢复、多个大段、并发写者、跨机器导入或完整服务激活。
- A-CLI-import 只证明离线 CLI 调用、最后 marker 写入与进程内失败清理；marker 不是 fsync/目录 rename 耐久证明，也不认证 marker 写后 runtime 的永久摘要。未覆盖并发 import、外部目标目录竞态、多个大段、磁盘写满、进程崩溃、跨机器 ACL/路径或任何 server/runtime 自动切换。
- A-import-open-gate 只证明一次完成导入的只读打开、marker/bundle/runtime 校验与失败不写；marker 和 bundle 仍无签名，marker 与 manifest 协同改写、验证后 runtime 替换、并发打开、跨机器路径/ACL、fsync 或断电恢复未证明。每次打开会重验当前文件，但不能锁定返回后的文件生命周期。
- A-import-bundle-containment 只证明打开入口先 realpath bundle root 并拒绝 import 根外 junction；realpath 检查与后续 `verifyPublishedHistoryArchiveBundle()`/context 使用之间仍有普通文件系统 TOCTOU，未做目录锁、handle 固定或并发替换证明。它不扩大为在线服务激活或跨机器路径保证。
- A-archive-status-API 的 `present` 只代表一次 `stat()` 成功，不能证明文件完整、可读或随后仍存在；删除/替换竞态与并发 registry 写入未测。authority 校验只绑定当前登记 id，不提供签名、文件内容认证或 registry 防篡改。
- A-cold-full-API 的 HTTP 用例依赖已发布状态和 `skipCheck=1`，源文件随后被压缩；这不声明自动 sync 能接受与 cold prefix 不一致的压缩文件，也不覆盖 authority/段文件在 `historyArchives()` 与 carrier 读取之间并发变化。quota 只覆盖观测行仍在热表中的完整返回，未覆盖冷段内观测行被删除。
- A-perf-source-inventory-transfer 只证明一个 ZCode 来源、一个冷段经已接受的 bundle/import API 后 inventory 与 `perf_samples` 仍可从导入 runtime 读取；不新增在线 import、能力绑定、timing/依赖闭包、多来源、修订、merge 或淘汰证明，也未覆盖读取期间文件/registry 并发替换。
- A-perf-payload-manifest-write 只绑定 `perf_samples` 主表的完整原始行；不包含 `perf_sample_sources`、timing/WorkBuddy 依赖闭包、跨段合并、修订或淘汰，也不把该摘要解释为 perf 权威或热删许可。旧无键候选继续走 events-only 兼容。
- A-perf-index-dependencies-write 只绑定一个真实 Codex 夹具、一个冷范围的三张依赖/身份表和一次关系删除反例；不包含 timing/WorkBuddy 表、跨边界重复依赖、无 owner 或跨 home 冲突、unplaced 样本、多来源、修订、merge、淘汰、热样本读取或在线切换，也未证明创建后源库变化与候选图之间的一致性。合法 schema 的外键使“引用路径缺 source identity”只能作为防御分支，本卡未另造非法 schema 反例触发该错误码。
- A-index-orphan-dependency 只在一个隔离副本中关闭外键并删除一个 dependency-only 路径的身份，用于证明防御分支 fail closed；正常外键 schema 本身不能产生该 orphan，本卡也不覆盖多个 dependency-only 路径、无 rollout owner、events-bearing 依赖、并发源变化或创建失败后的跨进程清理。
- A-complete-import-executor 只证明离线 published bundle 经执行器消息和现有串行尾链调用已接受的 import 核心；没有接入 HTTP/CLI，没有把导入 runtime 切换为当前活动 store，也不证明并发 import、进程崩溃、断电、跨机器路径或权限。
- A-import-http-faults 只固定已冻结 server 在两种真实坏包上的现有错误返回；不改变错误映射、不证明并发包替换、磁盘写满、进程崩溃或活动 store 切换，也不把 HTTP 201 扩大为在线 adoption。
- A-archive-adjacent-year-bands 只在 renderer 内按本地年份合并严格相邻且同年、有效、正向的段；主审已用真实 Edge 覆盖分组、Space/Tab、语言、freeze/unfreeze 和移走原段后的 missing 展示。该接受仍不证明跨时区边界、乱序/重复范围或并发 registry 变化，也不把该短卡扩大为第 18 项完整有界明细下钻。
- A-native-perf-graph-transfer 只覆盖单个真实 Codex thread 的一次同机 published bundle → import；导出后源与候选删除只证明该次文件布局可独立读取，不证明跨机器路径/ACL、多 thread/home、并发发布、在线 import、revision/merge/eviction 或崩溃恢复。
- A-workbuddy-observation-manifest-write 只覆盖一个真实 WorkBuddy home/message 的两条冲突观测和 0 条同 message perf sample；不证明多 home 隔离、无冷引用 home 的排除、缺失身份、旧时长表迁移、跨段 merge、并发写入、registration/bundle/import 接线、authority、淘汰或热删安全。
- A-workbuddy-native-transfer 只覆盖单个真实 WorkBuddy home/message 的 `800/850` 冲突经一次同机完整 bundle publish/import；不证明跨机器路径/ACL、多 home/message、在线 import、并发发布/读取、legacy 时长表、authority 切换、merge、revision、淘汰或热删安全。
- A-zcode-perf-carrier-transfer 只覆盖一个真实 ZCode fixture、单个显式 `zcode/tps-v2` authority 段与同机完整 bundle publish/import；不证明跨机器路径/ACL、多来源/home/段 authority、在线 import、并发发布/读取、revision、merge、淘汰、热删或自动发现安全。
- A-perf-carrier-pinned-record 只覆盖一个真实 ZCode fixture、单 authority 段、同一 store 的一次冷事件等待；不证明多段并发、registry 恢复后段文件并发替换、进程重启或生产服务安全。完整 `summary.perf` 比较排除了两个独立 store 各自生成的 `indexedAt`。
- A-zcode-perf-multisegment-red 只提供两个真实 ZCode 夹具范围、两个显式 `zcode/tps-v2` authority 段和一次实际 `summarizeHistory()` 红测；当前冻结 parser 在完整 perf 比较前以 `HISTORY_ARCHIVE_PERF_AUTHORITY_INVALID` 失败，不证明 B 实现后的跨段去重、冲突处理、文件并发替换或淘汰接线。
- A-cold-perf-freeze-HTTP 只覆盖一个真实 ZCode source、单 authority 段、同一进程的一次 HTTP freeze 与同一 snapshot 重读；不证明多段 HTTP summary、并发 candidate 替换、服务重启、snapshot 淘汰/清理或跨机器路径，live 失败只验证新 freeze 不发布 hot-only summary。
- A-multisegment-perf-missing 只覆盖一个真实 ZCode fixture、两个相邻 authority 段和第二段 events 读取后、perf verification 前的一次文件移除；不证明并发替换、多 source/home、淘汰接线、进程重启或第一段读取后的任何发布保证，只证明该次调用整体以原生 `ENOENT` 失败且恢复后同一 store 可完整重读。
- A-codex-native-closure-write 只在一个真实 Codex fixture 的隔离备份中删除一个冷显式 timing 样本唯一 owner 的全部原生 timing link，并在同一正常候选的重打包副本上覆盖 verify；不证明 owner 本身缺失、部分 link 丢失、多 owner/home/source、一般 per-turn 重算、hot/unplaced、timing key 单独缺失、并发源变化或失败清理后的跨进程恢复，也不把该窄 guard 称为完整 timing capability/closure。
- A-codex-linked-evidence-write 只在一个真实 Codex fixture 中保留一个冷显式 timing 样本唯一 owner 的全部 links，并删除这些 links 对应的全部 raw evidence；同时覆盖 source create 与有效外层重打包后的 candidate verify。它不证明部分 origin/variant 缺失、证据多条目冲突或数值重算、多 owner/home/source、一般 per-turn 重算、hot/unplaced 或并发源变化。
- A-freeze-price-HTTP-oracle 已由 server 的同步 try/finally 接线修复：snapshot 使用冻结 catalog，成功后恢复 live catalog；A-freeze-price-scope-error 又覆盖了一次成功读取和一次 `UsageStore.prototype.summarize` 强制失败后的恢复。A-freeze-pricing-endpoint-oracle 与 A-freeze-pricing-coverage 现已证明 snapshot pricing/catalog coverage 选择 A；并发请求与 PUT/refresh 仍未覆盖。
- 单库 `createHistoryBackup()` 对 schema 21 仍只接受空 `archive_segments`；A-bundle-stage-main 会从私有快照另行 staging 已验证段并清空该快照的 registry，但不解除单库门禁。A-bundle-publish 现在会在新目录完成 verify 后写排他 marker；A-published-gate 只提供读取该 marker 并重新完整 verify 的入口。两者都不提供导入、挂载或 authority 接线，也不声明原子目录发布或断电持久性。
- 快照摘要只检测 manifest 内快照的意外/局部改动；manifest 仍无签名或 MAC，同时改写快照和摘要的对抗场景未证。
- manifest 仍无签名或 MAC；数据库与 manifest 同时被替换的对抗场景未证。旧版 v1 manifest 缺少新的 `pricing` 快照字段，当前 verify 会按坏 manifest 拒绝，兼容性未处理。
- 本次已按当前 B schema 21 重跑真实 fixture；B 最终列契约仍待主审确认，再改列时需重跑。backup 当前支持 schema 19/20/21，更旧 schema 仍不支持。
- 沙箱内 Windows `link()` 返回 `EPERM`；宿主 Windows 已通过，但这会限制在同等受限沙箱中运行备份测试/服务。
- `PROGRAM_VERSION` 在模块加载时同步读取相邻的 `package.json`；未验证只分发 `src/` 而缺少 `package.json` 的非标准打包方式。
- 未运行完整 `npm.cmd test`。

## 交接

A0.1、A0.2a、A0.2b、A0.2c、A1a-1、A1a-2、A0.2d、A-schema20、A1c-price、A1b-serialize、A1b-package、A-context、A-CLI-verify、A-restore-package、A-CLI-restore、A-CLI-backup、A-backup-schema19、A2-dryrun、A2-CLI-dryrun、A2-candidate-events、A2-candidate-verify、A2-source-match、A2-source-context、A2-candidate-portable、A2-candidate-registry-guard、A-bundle-inventory、A-bundle-stage-segments、A2-candidate-failure、A-live-backup 已按短卡接受；A1b-gap、A-barrier-error 可交主审复核。A-schema21 已接上 schema 21 空目录兼容。`journal_size_limit` 已由 B 接线；tier 快照已在 manifest 捕获和校验，A-context 已提供 verify-first 读取接缝，A-CLI-verify 已提供离线校验入口，A-restore-package 已让恢复产物带 manifest，A-CLI-restore 已提供离线恢复入口，A-CLI-backup 已提供只读源库的离线 create 入口，A-backup-schema19 已让离线包保留 19/20/21 实际版本，A2-dryrun 已提供只读候选计算入口，A2-CLI-dryrun 已提供严格 dry-run 命令入口，A2-candidate-events 已提供未登记候选包第一接点，A2-candidate-verify 已提供候选独立校验接点，A2-source-match 已提供源当前事件集合匹配接点，A2-source-context 已提供引用 source 身份证明，A2-candidate-portable 已提供恢复后脱离开原候选目录的新进程证据，A2-candidate-registry-guard 已提供非空 registry 的入口拒绝证据，A-bundle-inventory 已提供登记段清单的 fail-closed 验证接点，A-bundle-stage-segments 已提供相对路径段 staging 与失败清理证据，A-bundle-stage-main 已按“仅数据库+registry同快照”接受，A-bundle-context 已提供调用入口 catalog/tier carrier 冻结证据，A-bundle-verify 已在 main 私有副本写入 `history_archive_bundle_segments_v1` 锚，并要求 manifest 段与其完整规范化一致（旧无锚 draft 拒绝，已接受），A2-candidate-failure 已提供同进程 SQLite 失败清理证据，A-live-backup 已提供执行器内在线 backup 接点及仅覆盖 sync/backupHistory 的共享串行 barrier，A-barrier-error 已提供一次真实失败后尾链继续运行的证据；证据归日/所有权、源 revision 校验、CLI 接线、登记、删除和归档执行另行释放。

A-bundle-verify 已由主审接受。A-bundle-publish 复用 staging 与 verify，在新目录上以排他 marker 作为提交门禁；成功后返回可重验 bundle，staging 后的 verify/marker 失败会清理本次创建的目录。该卡没有导入、CLI 或 authority 接线，也不声明目录 rename 原子性、fsync 持久性或断电恢复；导入必须同时验证 marker 与 bundle。定向 2/2、完整 archive 文件 10/10、Biome 与 typecheck 通过。

A-published-gate 新增 `verifyPublishedHistoryArchiveBundle()`：通过既有 realpath 边界读取 `bundle.complete.json`，严格校验版本、manifest 原始字节摘要和规范时间，再复用完整 bundle verify；成功返回带 marker 的已验证包，draft verify 不要求 marker。真实测试覆盖发布成功、无 marker 的 draft 拒绝、manifest 空白改动/错摘要/截断/坏版本/坏时间拒绝、恢复后重验成功；marker 写入还通过一次实际 `writeFile` `EACCES` 证明发布失败清理和源不变。该卡没有导入、CLI、marker 签名或原子目录发布。

A-schema21 已补上 schema 21 空目录兼容，并在该基线上重跑 A-barrier-error 的 3 项执行器备份测试；19/20 的备份/校验/恢复行为与 manifest 实际版本断言未退化。A-cli21-contract 已把两条 CLI schema 输出断言更新为精确的 21，定向文件 4/4 通过；外部 archive segment 的登记、读取、删除和打包未接入。

A-wire-tier 已把 worker 的 tier resolver 以既有纯快照跨线程传递，并在主线程 state/snapshot 边界重建；真实 priority 夹具覆盖当前 state、串行 snapshot 和旧快照不随后一轮变化。snapshot 并发一致性仍留给主审。

A-snapshot-barrier 已把 snapshot 接入现有 sync/backup 尾链，真实双向排队用例证明冻结库值、status fingerprint 与 tier resolver 来自同一发布轮。

I-full-wire 已把 `publishedUsageEvents` 消息和 client 接入现有 sync/backup/snapshot 尾链，响应走既有 `toWire()`；B 的 store 接缝落地后，真实 project-log 用例已通过并证明移除后保留及恢复无重复。

A-close-drain 已把 close 接入同一条尾链。真实排队 snapshot 在库关闭前完成且产物可读，重复 close 返回同一 Promise，关闭后 `executor.alive === false`。客户端 5 秒保护值和 terminate 兜底保持原样；超时、普通读和故障交错仍另卡。

I-full-carrier-wire 已把三字段 composite carrier 消息和 client 接入同一尾链，handler 使用三次无 await 的同步 store 调用。B 的 sessions 接缝落地后，真实两 home 用例通过并证明移除后事件/home/session 载体保留、恢复后不重复；定向 1/1、聚焦文件 7/7。

I-full-quota-wire 已把 handler 收敛为单一 `store.publishedUsageReport()` 调用；B 的 `SAVEPOINT` 方法补出 `rateLimitObservations` 后，真实原生 Codex 移除/恢复用例通过并逐字段证明 quota 载体保留且不重复；定向 1/1、聚焦文件 8/8。

A-freeze-price-oracle 已用现有 snapshot/backup 测试文件中的真实 backup 路径证明一次 `backupHistory` 请求在 await 前切换全局价目后仍把 catalog A 写入 manifest，并用 A/B 两种实际 `totalUsd` 说明金额确有差异；定向 1/1、聚焦文件 9/9，生产文件未改。

A-freeze-price-transfer 复用同一个包，在新进程中经 `loadHistoryBackupContext()` 显式应用 catalog A，并以只读 store 重算 `totalUsd`、`currencies`、`pricedRecords`，三字段对象与创建时 `costA` 完全一致；父进程 B 下金额仍不同。该测试同时改为保存并恢复原 catalog，而不是无条件 reset。

A-freeze-tier-HTTP-oracle 用真实临时 Codex priority 日志建 HTTP snapshot，随后把 tier 日志改写为 `Some(None)` 并触发 live 刷新；同 snapshot 的费用对象与 unknown 计数保持不变，live 则进入 unknown 且金额变化。生产 server 未改，正式服务未重启。

A-freeze-price-HTTP-oracle 的直接后继反例曾显示：catalog A 下创建的 HTTP snapshot 在切到 B 后，用同一 `snapshotId` 重查金额从 `0.5` 变为 `0.6`。server 接线现已应用冻结 carrier；该修复后的 API 基线为 5/5（本卡最终复跑 6483.2311 ms）。

A-snapshot-price-carrier 已让执行器 snapshot 响应携带请求时捕获的 `pricingCatalog`：A 下发出请求后主线程切 B，返回 carrier 仍为 A，且快照事实与 tier resolver 保持同轮。server 现已应用该 carrier。

A-freeze-price-scope-error 在成功读取与强制失败后都验证了全局 catalog 保持 B；失败恢复 prototype 后旧 snapshot 仍返回 A。

A-freeze-pricing-endpoint-oracle 的反例已由 server 修复：snapshot pricing 返回 A 的 version/rates，主审独立原用例 1/1 通过。

A-freeze-pricing-coverage 进一步用一个仅 A 含有的活跃模型验证 snapshot `usageCoverage` 仍按 A 定价，而 live coverage 在 B 中报该模型缺失；旧 snapshot summary 费用保持 A。

A-CLI-export 已把已接受的 published bundle 接到严格新目录 CLI：只读源库、显式价目入口、可选显式 home 的 tier 快照，以及输出目录/manifest/marker；3 项真实 CLI 用例和完整 CLI 文件 7/7 已通过。

A-import-stage 已新增只读 published bundle 到新目录的便携复制：先验源 published gate，独占建目标，只复制声明文件，目标 draft verify 后才复制 marker，最后再验目标 published；失败只清本次目标。定向 3/3、完整 archive 文件 13/13 通过，未接 import/CLI。

A-import-stage 已独立接受。A-import-runtime 已在同一 published gate 上增加新 import 目录、冻结 `bundle/`、独立 `runtime.sqlite` 的 registry 路径重建与 verify-first bundle context；定向 3/3、完整 archive 文件 16/16 通过，未接 marker/CLI/服务。registry 写失败和既有目标拒绝均有真实 SQLite/文件系统用例。

A-import-runtime 已独立接受。A-CLI-import 已新增 `history import <publishedBundleDir> <newImportDir>`：复用 materialize，重新验证冻结 bundle 与 runtime 后最后写排他 `import.complete.json`，输出 runtime/bundle 路径并明确未切换在线服务。定向 3/3、完整 CLI 文件 10/10 通过；draft/坏包/既有目标与最后 marker `EACCES` 清理均有真实子进程用例。

A-CLI-import 已由主审独立接受（import 3/3，1891.8955 ms）。A-import-open-gate 已在完成导入目录提供只读打开：严格校验 marker、冻结 bundle、runtime registry/authority 后返回 manifest 与 context；原 published package 删除后仍可读取 registry、manifest 与 context，marker 损坏、路径越界、缺段与 registry 改写均 fail closed。完整 archive 文件 19/19 通过（4556.5939 ms），Biome、typecheck 与 `git diff --check` 通过；该卡未接 CLI/server，也不把 runtime 初始字节摘要解释为永久认证。

A-import-bundle-containment 已修复主审发现的 `bundle/` junction 根外逃逸：bundle root 先按 import root 做 realpath containment，再调用 published verify，并再次用 `bundleContains` 检查已验证目录。反例先把外部段路径同步进 runtime registry，修复前红、修复后绿；runtimeFile junction 仍由既有解析函数拒绝。定向 2/2（849.6801 ms）、完整 archive 文件 21/21（5683.2520 ms）通过，正常导入仍可读取；未接 HTTP/CLI/server。

A-import-open-gate 与 A-import-bundle-containment 现已由主审按同一 import 边界 5/5 用例接受。A-archive-status-API 已新增唯一 GET 轻量读取：执行器只查登记/authority 并对原登记路径 `stat()`，返回原始范围、事件数、`present|missing|unreadable` 与显式 segments/events 计数；不读段内 events/sha、不 sync、不接受 query 路径。新文件 3/3 通过（5280.5228 ms），Biome 与 typecheck 通过；当前工作区既有 server 导入总量 4 项失败未在本卡修改。未接 UI，不声称 `present` 是完整性或后续文件生命周期证明。

A-archive-status-API 已由主审独立运行 3/3 通过。A-cold-full-API 已把执行器的 `publishedUsageReport` 接到 B 的 cold-aware store 载体，并让 `detail=full` 在缺失来源或 authority 显式列出段时使用该载体；真实 100 cold + 30 hot 用例中，仅 live 源只能看到 30，而 HTTP 返回 130 并与未归档 oracle 的 events/session/home/quota 一致。缺失授权段返回 500 `ENOENT`，无 authority 的缺失 rollout 仍保留已发布 100 token。定向 3/3（5741.3768 ms）、retention 6/6、executor backup 10/10、W1 14/14、Biome、typecheck 与 `git diff --check` 通过；未证明压缩源可自动 sync、并发段切换或冷段内 quota 删除。

## A-complete-import-executor：执行器调用完整 published bundle import（已接受）

- `src/usage-executor.js` 只新增 `historyArchiveImport` 请求、client 方法和现有串行尾链成员；worker 直接调用已接受的 `publishHistoryArchiveImport(sourceDirectory, importDirectory)`，响应仅传可克隆的 `runtimeFile`、`bundleDirectory`、`markerFile` 与 `marker`，不跨线程返回 `loadBundleContext` 函数。没有改 archive/store/server、活动数据库、CLI 或生产服务。
- 真实临时 Codex 夹具先建立并发布包含已登记段的 bundle，删除活动库中的冷事件后才导入。新 runtime 独立打开后，`publishedHistoryUsageReport()` 的事件、session、home 与 quota 载体仍与删除前 oracle 深等，证明重建来自冻结 bundle 而非活动库残留。
- 第二个用例证明既有目标目录及 sentinel 原样保留并明确返回 `HISTORY_ARCHIVE_IMPORT_DESTINATION_EXISTS`；第三个用例用缺 marker 的目录返回 `HISTORY_ARCHIVE_BUNDLE_NOT_FOUND`，新目标未创建、活动库 SHA-256 与已发布载体均不变。

```text
node --test test/history-archive-import-executor.test.js
exit 0; 3 tests, 3 pass; duration 5957.5347 ms（宿主；用例 400.604 / 215.688 / 247.511 ms）

node --test test/history-archive.test.js
exit 0; 21 tests, 21 pass; duration 4094.7993 ms（宿主）

npx.cmd --no-install biome check src/usage-executor.js test/history-archive-import-executor.test.js
exit 0; 2 files checked in 16 ms

npm.cmd run typecheck
exit 0

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

受测文件 SHA-256：

```text
src/usage-executor.js  b39e746a589112bbc3876629be56fbaafb272f4e95e2610a35d5c795e605ad49
test/history-archive-import-executor.test.js  cba6a45443a4d56ef4445f1bbb85ac6ebcebea5d2fc5dc7b17b1fa62acbebb62
```

沙箱内候选发布仍因 Windows 硬链接 `EPERM` 失败，以上定向测试在宿主运行。本卡不证明活动 runtime 热切换、HTTP/CLI 入口、并发 import、源包在 staging/验证期间被替换、跨机器路径/ACL、崩溃或断电恢复，也不把 marker 当作签名或永久摘要证明。

主审已审真实前像 diff，并独立与全部 archive API 共 9/9 通过（6363.8343 ms），主审 typecheck 0；接受范围仍为执行器接线，不包含后续 HTTP 入口或在线 adoption。

## A-import-http-faults：真实坏包经 HTTP import 失败且不发布目标（已接受）

- 新增测试只使用临时真实 `UsageStore`、已登记候选和已发布 bundle，没有 fake reader 或 shape stub。活动库删除冷事件后先以 HTTP summary 取得 oracle 20；随后分别把 published manifest 改成非法 JSON，以及删除 bundle manifest 声明的实际段文件。
- 两次 `POST /api/history/imports` 都返回 HTTP 500，且响应 code 固定为现有产品实际值：manifest 字节改动先被完成 marker 的摘要校验拦下，返回 `HISTORY_ARCHIVE_BUNDLE_MARKER_MISMATCH`；缺段返回 `HISTORY_ARCHIVE_BUNDLE_NOT_FOUND`。没有新增错误映射或改 frozen server。
- 两个失败目标目录均不存在，因而既无 `import.complete.json`，也无可采用的 `runtime.sqlite`；每次失败后活动 HTTP summary 仍为 20，证明活动 registry/store 未被替换。

```text
node --test test/history-archive-import-http-faults.test.js
exit 0; 1 test, 1 pass; duration 352.2076 ms（测试体）/ 5454.8729 ms（runner，宿主）

npx.cmd --no-install biome check test/history-archive-import-http-faults.test.js
exit 0; 1 file checked in 6 ms

git diff --check
exit 0; one pre-existing public/index.html CRLF notice
```

`test/history-archive-import-http-faults.test.js` SHA-256：`09c6512c44e53448ab54e80ed07cfe0de8f24b6532cf1b105d3131b6321cac99`

本卡只固定已冻结 HTTP import 入口对两种真实坏包的当前失败行为；不证明并发包替换、磁盘写满、进程崩溃、活动 runtime 热切换、跨机器路径/ACL，也不把成功 201 扩大为在线 adoption。沙箱候选发布仍受 Windows 硬链接 `EPERM` 限制，测试在宿主运行。

主审独立运行 1/1 通过（测试体 `334.2409 ms`，runner `5434.4382 ms`），接受当前错误映射、目标不存在与活动 summary 不变证据。

受测文件 SHA-256：

```text
src/usage-executor.js  65bc46f5087a5639679f5c4ad9fb2fc8ae43e2f25cb4389c15a71220671c2013
src/server.js  7ebf1ecf81a382cc66e8fd2b9b0ce36e1ea4027ce6d63d29a0a1589ee31dcbbf
test/history-cold-full-api.test.js  c1da76fcea2e2d6376bc93d4b48ffd8eeeaad480c68916e0979377df123e7a27
test/history-archive-api.test.js  12f5e3b36179fb5999fad2a7c143333c119a81f7722bef6a8b1acc640a12f017
test/history-executor-backup.test.js  ba447ec2342cb6d77d360edd5032fee6e29a8bf23c556f1c38a60046759e1d7b
test/history-retention-api.test.js  778ac0c70b7ce1dfa993262f3e3e6333357a203c403773341708ea9bed74ec71
test/history-wal.test.js  884bc22b98c9ed62c6abf7a45129b4465601fe3ecf0c675b91410bd6637cd7ac
src/history-backup.js  053ffe2650555819927d7d5e951158fce691807104926ffafa653ca70c217d24
test/history-backup.test.js  370faf583d19915c89c1fe84c1197ef3f3341e02f41be5c9cb7a60474f4b658f
src/service-tier-evidence.js  eab76722ecf42b3803ee70488a3bbf7e11003811d26630ac12dfc217134f230c
test/service-tier-evidence.test.js  72ee166ee4b02a024439057fe7fb39b02305fb38bc70932a81d80cca0709119d
src/cli.js  586ec70f16a5309d8357304256bed7cdd453b60505759e2b013525675decf457
test/history-cli.test.js  a53bebf7fa9360255e466e150dcca70a8caf3b736392cb91c05ad116009c31f8
src/history-archive.js  8606752fddb7a63ba34bfe5fccb09194c27654254b27b80eae2ab8575a29d224
test/history-archive.test.js  408bec27b9a7f295f55611005fb3c702f3bfebdf554c8769ad377447c8d0864b
```

## A-archive-adjacent-year-bands：同年相邻归档段成带（已接受，仅归组行为）

- `public/history-archives-ui.js` 新增纯函数 `historyArchiveBands()`，只按当前返回顺序把 `startMs` 与 `endMs` 均可表示为有效 `Date`、`startMs < endMs`、同一本地日历年且 `previous.endMs === next.startMs` 的连续段合并。gap、重叠、跨年、倒置或不可表示日期各自成为独立带；跨年段保持原段 singleton，不改范围。
- 每个带只新增一个复用现有样式的文本头，并带 `data-archive-band-year`；所有段的 `data-archive-segment-id`、原范围、状态、事件数可用性、封存日 `<details>`、打开状态、焦点恢复与 freeze generation 逻辑均未改。新增 `归档带: "Archive band"` 文案。
- 单一测试组覆盖：2025 两段相邻合一带、同年 gap/重叠各自单独、2026 段单独、跨年、倒置范围与 `9e15` 不可表示毫秒保持 singleton；missing 段仍保留 ID/范围与缺失状态，且不显示行级事件数或假零。
- 本卡未在开工瞬间另存即时前像。现有最强候选前像是 C 的不可变副本 `output/history-retention-profile-20261025-current-million/source-snapshot/public/history-archives-ui.js`：`snapshot-manifest.json` 的 `createdAt` 为 `2026-10-25T03:47:24.9475662Z`，该文件 `sourceShaBefore`、`copiedSha`、`sourceShaAfter` 均为 `b91361027f0dc4a78e357183267e889bd78810d700c35a2d0b8aef34b0f87acb`，`copiedReadOnly: true`。本卡首次写入后的当前文件 mtime 为 `2026-10-25T12:40:12.0595822+08:00`（`04:40:12Z`），晚于快照约 53 分钟。
- `git diff --no-index` 对该候选前像与最终文件给出 11 行 removed、55 行 added；removed 块正是原 renderer 的直接 `segments.map(...)` 段行渲染，当前 diff 没有从 HEAD 或其它版本拼出删除内容。因缺少开工瞬间复制，且中间边界只依据主审“开工前仅只读 renderer、C 仅写 output”的说明，本报告不声称该候选在字节级上必然是完整即时前像；接受与否由主审裁定。

```text
node --test test/history-archives-ui.test.js
exit 0; 11 tests, 11 pass; duration 87.3307 ms

node --test --test-name-pattern="adjacent segments" test/history-archives-ui.test.js
exit 0; 1 test, 1 pass; duration 79.6891 ms

npx.cmd --no-install biome check public/history-archives-ui.js public/i18n.js test/history-archives-ui.test.js
exit 0; 3 files checked in 14 ms

git diff --check -- public/history-archives-ui.js public/i18n.js test/history-archives-ui.test.js docs/validation/2026-10-22-history-retention/A-report.md
exit 0
```

受测文件 SHA-256：

```text
public/history-archives-ui.js  aa116650776479f552b18ca04b1c221a040efeffb8e30f7b5af600323e1aa971
public/i18n.js  445e3479c4c868a75028de53c8f44f5d4ec5b7d7e1f2f8d87a2e434bbe6e729b
test/history-archives-ui.test.js  71062fa90c8bf7b4c7e0556216c7a419622db6479663f3009d9d9e344753bfcf
候选前像 output/history-retention-profile-20261025-current-million/source-snapshot/public/history-archives-ui.js  b91361027f0dc4a78e357183267e889bd78810d700c35a2d0b8aef34b0f87acb
```

主审已独立复核并接受本卡的归组行为：相关 UI/i18n/render 定向 83/83 通过；真实 Edge 155 在 1920×1080 下以原段、相邻段、gap、另一年四个候选实测出 `2 + 1 + 1` 三带，18 项断言全绿、耗时 2107 ms，并覆盖真实 Space/Tab、语言切换、freeze/unfreeze、移走原段后的 missing。证据为 `output/playwright/history-main-bands-evidence.json` 与 5 张截图，测试夹具和浏览器已清理。

本接受只关闭 renderer 的同年相邻归组接缝；跨时区边界、乱序/重复范围、并发 registry 变化与第 18 项的有界明细下钻仍另卡，不声明第 18 项整体完成。

## A-sealed-event-page：封印段 keyset 分页读取接缝（已实现，待主审复核）

- 开工前已具名保存 `src/usage-store.js` 前像到 `output/history-retention-resume-20261025/usage-store.A-sealed-event-page.baseline.js`，SHA-256 为 `9757fb59d323608ef2cd01830ed02c314002e3051e94c220f2368b83530892b1`；当前文件与它的差异只含本卡新增接缝。
- 新增 `UsageStore.readHistoryArchiveEventPage(segmentId, { startMs, endMs, afterId = 0, limit = 100 })`，返回 `{segmentId, view:"sealed", range:{startMs,endMs}, events, nextAfterId}`。范围必须为 safe integer 半开区间且 `startMs < endMs`；`afterId` 为非负 safe integer，`limit` 为 1–500 的整数，否则抛 `HISTORY_ARCHIVE_EVENT_PAGE_INVALID`。缺失范围不会被默认为 0，仍走同一严格校验；未知登记段抛 `HISTORY_ARCHIVE_SEGMENT_NOT_FOUND`，段文件缺失保留原生 `ENOENT`。
- 分页复用既有候选/源验证、registry 元数据匹配、`BEGIN`/`ROLLBACK` 与连接关闭；查询前先核对整段行数，再按 `timestamp_ms` 半开范围、`id > afterId`、`ORDER BY id` 读取 `limit + 1` 行。返回游标只在本页仍有后续时取最后保留行的 id；不加载整段到 JS，不合并 hot facts、有效 event revision 或其它段。主审已完成 executor/server/page API 接线；store 接缝的运行时参数校验未因调用方 JSDoc 收口而放宽。
- 定向测试使用真实临时 `UsageStore` 和真实候选段，覆盖三条同时间戳事件的 `2 + 1` 分页无重无漏、非法范围/游标/限制全部精确拒绝、移走段文件时 `ENOENT` 且恢复后可重读。第 1 用例显式写入合法 `history_archive_event_revisions`（复用既有 overlay 的 `{segmentId,databaseSha256,sourceIdentity,removed,added}` payload 结构）和 event authority，清掉冷范围热镜像，并把 hot-only 行放到段外；先由 `publishedHistoryUsageEvents()` 证明 revision 的 `total=999` 被采用，再证明 sealed page 仍返回原 `total=20` 且不含段外 hot 行。未再插入 `history_replaced_facts`，不把恢复账当作有效 overlay 证据。主审另以真实 HTTP 定向 1/1、329.9382 ms 验证分页 `id 1,2→3`、限制、unknown 404、expired 410，以及移走段后 live 500 而 frozen 仍返回原 page；该上层结果不并入本卡的 store-only 断言。

```text
node --test test/history-archive-event-page.test.js
3/3 pass; 350.8063 ms（runner，宿主）

node --test test/history-archive-store.test.js
28/28 pass; 3457.8652 ms（宿主）

node --test test/history-cold-revision-overlay.test.js
3/3 pass; 550.8308 ms（宿主）

node --test test/history-cold-perf-reader.test.js
1/1 pass; 347.7502 ms（宿主）

npx.cmd --no-install biome check --formatter-enabled=false src/usage-store.js test/history-archive-event-page.test.js
2 files checked in 92 ms

npm.cmd run typecheck
git diff --check -- src/usage-store.js test/history-archive-event-page.test.js docs/validation/2026-10-22-history-retention/A-report.md
exit 0
```

沙箱内真实候选发布仍按既有 Windows `link()` 限制以 `EPERM` 失败，以上 Node 测试在宿主执行。主审首次 typecheck 指出的三个声明错误已随本卡收口：可选参数改为 `range: ... | undefined` 并在函数体内 `range ?? {}`，缺失字段仍由原校验拒绝；内部 snapshot 结果补充可选 `nextAfterId` 声明。该收口只改 JSDoc/默认值位置，不放宽任何运行时检查。

受测文件 SHA-256：

```text
src/usage-store.js  4a4dbfe4cde4673bb51fb5696feb266aa4d4ab1136f85483b72d26c9e5e080d6
test/history-archive-event-page.test.js  4452ed2023b5b6fb4ed4305c6543b9bfd395f01b8cc68c3b47871b45f00e1477
前像 output/history-retention-resume-20261025/usage-store.A-sealed-event-page.baseline.js  9757fb59d323608ef2cd01830ed02c314002e3051e94c220f2368b83530892b1
```

本卡只证明上述单段、单进程读取接缝及主审已完成的窄 HTTP 分页行为；有效 event revision 只覆盖一个已授权段、一个 payload 的一次替换，不证明并发段替换、跨进程文件锁定、返回后的文件生命周期、多 revision/多段合并或完整第 18 项验收。每次读取仍重验完整候选/源并做整段计数，其生产尺寸耗时未测。

## A-import-instance-frozen-cost：导入实例的 bundle 价目与 tier 证据 adoption（已实现，待主审复核）

- `createUsageExecutor()` 新增可选 `pricing` provider；客户端把该 provider 当前返回的 catalog 随 `open`/`summarize`/`dashboard`/`periodComparison`/`snapshot`/`backupHistory` 请求传给 worker，worker 在 `open` 及每个计价请求前对齐模块价目。普通实例默认仍取 `getPricingCatalog()`，不改变原调用方。
- `createUsageServer()` 接受内部 `importContext`（已验 bundle catalog 与序列化 tier snapshot）。导入实例的 `loadUsageStore()` 改为 `usageStore.open({ imported: true, pricing, serviceTierEvidence })`，不执行 live sync；worker 恢复 tier resolver、`publishedHistoryUsageReport().homes` 和导入状态。导入实例跳过 `loadPricingFile(options)`，因此独立 `pricingFile` B 不会覆盖 bundle A。
- 导入实例的 `PUT /api/pricing` 明确返回 405 `IMPORT_PRICING_READ_ONLY`，不会把 catalog B 写入普通全局价目或伪装成 A 更新成功；一般实例的价目编辑路径保持不变。
- 导入实例的 `detail=full` 明确返回 400 `IMPORT_FULL_DETAIL_UNSUPPORTED`，避免 `buildUsageReport()` 读取 live 文件系统并与主线程全局价目混合；一般实例的 full-detail 行为保持不变。
- `createHistoryArchiveImportServer(importDirectory, options)` 先调用 `loadHistoryArchiveImport()`，再强制 `automaticDiscoveryEnabled: false`，把 runtime 文件、bundle A 和 tier snapshot 交给 `createUsageServer()`；损坏的 import marker 继续在构造服务器前以 `HISTORY_ARCHIVE_IMPORT_BAD_MARKER` 拒绝。
- 测试使用真实临时 `UsageStore`、冷事件、候选段、event authority 和 `publishHistoryArchiveBundle()`。源 store 在 catalog A（`2026-10-22`）与 priority tier evidence 下记录 `total=20`、完整 `costEstimate` 深等基线、稳定 perf（清空 `indexedAt` 与 `meta.indexedAt`）及完整 totals；import runtime 由导入产物启动，在独立 catalog B（`2026-10-23`）环境下仍保持 A 的 totals、完整 cost、稳定 perf 和 `priceCheckedAt`。同进程的普通 server 仍明确返回 B 的价目与 `2026-10-23`，证明导入上下文没有泄漏到全局实例。
- 导入完成后测试关闭源 HTTP 实例，并把源数据库、候选段和 bundle 都 rename 到隔离后缀，再从 import directory 启动导入实例；因此只依赖 import directory 的运行时路径。frozen 请求继续返回 A 的价目与零未知 tier 记录，`GET /api/pricing?snapshot=...` 也返回 A；导入实例的 full-detail 与 pricing PUT 拒绝断言也在同一隔离场景中执行。

```text
node --test test/history-archive-import-instance.test.js
沙箱 exit 1，测试在 createHistoryArchiveCandidate 的 Windows 硬链接处因 EPERM 提前失败。
主审宿主运行 0/1，531.2349 ms（runner 6224.5664 ms）；失败在 ordinary pricing 断言
把 Promise 与 catalog B 版本比较。已修复该 await，并补回完整 cost/perf、原路径 rename 隔离、
full-detail 400 与 pricing PUT 405 断言；未重跑宿主审批或全套。

npx.cmd --no-install biome check src/usage-executor.js src/server.js test/history-archive-import-instance.test.js
exit 0; 3 files checked in 19 ms

npm.cmd run typecheck
exit 0

git diff --check -- src/usage-executor.js src/server.js test/history-archive-import-instance.test.js docs/validation/2026-10-22-history-retention/A-report.md
exit 0
```

受测文件 SHA-256：

```text
src/usage-executor.js  db3a8c282bab5d6722256f2ccef0f488a80988def682490e12784d66cad27fca
src/server.js  92c07279a5086e7684d4d800a60d6ac3f3748f452cf513480d126cef92249816
test/history-archive-import-instance.test.js  91c31c60437941780dcfbd07eb535604e9a46e75e8ce534e7a650621134ef935
```

本卡只覆盖同进程内一个 bundle、一个 imported runtime HTTP 实例和一次 A→B 价目切换；不证明真实子进程/service activation、并发 import、活动实例热切换、跨机器环境、多个 bundle 冲突或 I3-T。主审宿主运行已通过此前的完整 cost/token/tier 断言，随后仅因本测试缺失的 await 失败；修复后的宿主结果仍待主审复核。未运行全量测试。

## A16-ZCode-public-closure：ZCode 冷 perf authority 的完整公开证据闭环（已接受）

- 本卡实际前像未保存：在 `output/history-retention-resume-20261025` 与 `output/history-retention-resume-20261024` 下按测试文件名及测试标题检索均无副本，也未发现 `preimages` 目录；该测试当前是 Git 未跟踪文件。因此没有可提供的真实前像路径或 SHA，不以 `HEAD`、当前文件或其它快照冒充前像。
- 依据本卡变更记录，唯一 diff 范围是 `test/history-cold-perf-authority.test.js`；未改 `src/`、fixture、schema 或其它 test。由于前像缺失，无法提供逐行 diff 证明；当前结构核对确认旧核心断言未放松：候选仍需 verify 且包含全部四个 perf component（约 65–95 行），真实 ZCode 冷样本仍要求 `sourceKind=zcode` / `methodVersion=PERF_METHOD_VERSION`，仍物理删除且只删除一条候选内冷样本（约 144–149 行），剩余候选/live 冷样本重叠仍校验，hot 与 unplaced 样本仍与删除前深等（约 151–170 行）。
- 公开证据由窄 perf 投影扩展为 `report.events`、`summary.totals`、`summary.costEstimate` 与稳定的完整 `summary.perf`，并与未归档 oracle 深等。三组断言分别覆盖：归档后完整公开证据、同 store no-op sync 后不重复/不变、close/reopen 后不重复/不变。仅归一化 `perf.indexedAt` 与 `perf.meta.indexedAt`。

```text
主审独立宿主执行（主审提供）：
node --test test/history-cold-perf-authority.test.js
1/1 pass；测试体 336.6458 ms，runner 415.1352 ms

沙箱复跑：
沙箱 exit 1；0/1，测试体 250.6153 ms，runner 350.6249 ms。
失败位于 createHistoryArchiveCandidate 的 Windows 硬链接 EPERM，尚未执行任何公开证据断言。

npx.cmd --no-install biome check test/history-cold-perf-authority.test.js
exit 0; 1 file checked in 7 ms

node --check test/history-cold-perf-authority.test.js
git diff --check -- test/history-cold-perf-authority.test.js docs/validation/2026-10-22-history-retention/A-report.md
exit 0
```

`test/history-cold-perf-authority.test.js` SHA-256：`d425699fdf49e400014f3f9aed2a6267ad77cf398823365960ab241c3e87b920`

主审已独立宿主运行 1/1 通过，并按 §6.1 汇总完整证据后接受本卡 16 的已声明范围；新增三组公开证据断言已执行。前像缺失仅作为 test 审计限制记录，不以 `HEAD` 或当前文件补造。主审当前状态为固定 17/20、15/19 在施、20 待开始；本测试交主审冻结，A 不再修改并待命。未运行全量测试。本卡只证明同一真实 ZCode 夹具下的归档公开证据、no-op sync 与重开稳定性，不证明并发同步/段切换、跨进程文件生命周期、生产服务行为或其它 source kind 的等价闭环。

## A20-import-new-process：导入实例在独立 Node 子进程中保持冻结 A 价目与 tier（子门槛已接受，非 20 整项）

- 只新增 `test/history-archive-import-new-process.test.js`，未改任何生产源码、fixture、schema 或既有 test。测试复用 `createPerfIntegrationFixture({ sources: ["zcode"] })` 的真实 ZCode SQLite/候选依赖，而不是 SQL 造样本；候选内有一条 `completed`、`durationMs>0`、`outputTokens>0` 的真实冷 perf 样本，event/perf authority 均指向同一已登记段。
- 完整源 oracle 在**未删 live 数据前**以 catalog A（`2026-10-22`）和全 thread `priority` tier 生成：`summary.perf.coverage.eligible=34`、`sampled=30`，完整 `costEstimate` 的 `pricedRecords>0`、`serviceTierUnknownRecords=0`、`totalUsd=7.053236`。归档后只删除 `[startMs,endMs)` 内 events/perf；25 条 positioned hot perf 与 1 条 unplaced/NULL perf 在删除前后保持深等。
- 删除后先用新 store 重新读取同一库，完整 `totals`、`costEstimate` 与稳定完整 `perf` 均须先与原 oracle 深等，随后才发布/导入 bundle。真实 bundle 导入后再移走原 archive database、candidate、bundle 以及 2 个真实 source 文件，并断言所有原路径不存在；测试没有以删除后的摘要替代 oracle。
- catalog B（`2026-10-23`）使用不同标准/fast 单价。父进程先以同源 store + B 重算，得到相同 totals 但 `totalUsd=0.08770099999999997`，确认价目切换会实际改变成本。实际独立 `node` 子进程先调用既有 `loadPricingFile({ pricingFile: B })`，READY 行回传 ambient B version/checkedAt、PID 与端口；随后才从 `importDirectory` 建 `createHistoryArchiveImportServer`。导入上下文的 A catalog 与完整 priority snapshot 均保持。
- 经子进程实际 HTTP 服务验证：`GET /api/pricing` 仍返回 catalog A version；`GET /api/summary?preset=all&skipCheck=1` 的 `totals`、完整非空 `costEstimate`、稳定完整 `perf` 与冻结源 oracle 深等，仍为零 unknown tier、A 的 `priceCheckedAt` 且 `perf.coverage.sampled>0`。原 source/candidate/bundle 已移走，证明结果不依赖父进程 catalog 或旧路径。

```text
沙箱 node --test test/history-archive-import-new-process.test.js
exit 1；0/1，测试体 73.7493 ms，runner 212.0617 ms。
既有 Windows 硬链接 EPERM，在 createHistoryArchiveCandidate 前失败。

宿主最终：node --test test/history-archive-import-new-process.test.js
exit 0；1/1 pass；测试体 687.8779 ms，runner 5755.7985 ms。
retained outside archive: hot perf=25 unplaced perf=1
perf eligible=34 sampled=30；cost A=7.053236 B=0.08770099999999997
moved source files=2
child pid=165920，exit=0，signal=null；测试后 Get-Process -Id 165920 为 absent。

主审独立宿主复核：
exit 0；1/1 pass；测试体 675.1069 ms，runner 5752.3863 ms。
hot=25 / unplaced=1；eligible=34 / sample=30；cost A=7.053236 / B=0.087701；
2 个原 source 已移走；child pid=402528，exit=0。

npx.cmd --no-install biome check test/history-archive-import-new-process.test.js
exit 0; 1 file checked

node --check test/history-archive-import-new-process.test.js
git diff --check -- test/history-archive-import-new-process.test.js
exit 0
```

`test/history-archive-import-new-process.test.js` SHA-256：`b45252ee70465e93e9a89a88d466bcc249265a54e8e8adafeaef402d97958dee`

主审已独立宿主复跑并接受“20 新进程导入”这一已声明子门槛；不把该接受扩大为第 20 项整项完成。测试现由主审冻结，SHA 见上，不再重复验证。B 显式 CLI 完成后的直接后继是：以隔离副本通过正式 commit 入口，再与完整 backup/restore 对拍，不另造边缘测试。生产源码继续冻结。

本卡只覆盖一个真实 ZCode fixture、单候选/单 bundle、一次完整 import 和一次独立子进程启动；`perf` 非空但未覆盖 Codex native timing、多段或大规模数据。未运行全量测试；并发导入、验证与启动竞态、运行时目录事后替换、跨机器路径/ACL 和生产服务接管不在本子门槛声明内。

## A20-historical-gap-boundary：10-21 93977→84029 差额证据边界（evidence_gap）

- 新增 [history-gap-evidence.md](history-gap-evidence.md)，记录 `93,977 → 84,029` 的 `9,948` 行差额边界：约 `08:2x` 与 `09:38` 的两次计数、约 `09:00` 的 `291` 个 main 文件重索引、峰值日从 `10-18` 的 `10,726` 变为 `10-04` 的 `6,319`。
- 未找到两端同一口径、带路径和哈希的原始快照，也没有逐事实桥。故不能证明该差额来自去重/口径变化或真实丢失，也不能证明后续副本恢复过旧行。结论为 `evidence_gap`，第 20 项保持开放。
- `15:47` 恢复副本只与后来/当前库在 `10-20` 及以前每日行数和 token 总量相等，不构成旧端点恢复证据；今日自洽包、等日总量、合成 benchmark、transfer/import/restore 测试均已在文档中明确排除。主审当前私有的 staging commit/fault/restore 演练属于另一层证据，本卡不重复执行，也不把其结果用于解释旧差额。
- 本卡只新增/更新文档，未改生产源码、测试或 fixture，未访问 SQLite 原件，未运行宿主或全量测试。

```text
git diff --check -- docs/validation/2026-10-22-history-retention/A-report.md
git diff --no-index --check -- /dev/null docs/validation/2026-10-22-history-retention/history-gap-evidence.md
无空白错误；后者仅因新文件与 /dev/null 不同而返回 1
```

`history-gap-evidence.md` SHA-256：`111eb69a8f7df299355aa6a60fade893ae8d0ea55b8ea11e1d05b25fc13f9440`

## A15-Codex-formal-perf-commit：正式 commit 的 Codex 冷 perf 支持（RED，待 B 修复）

- 只新增 `test/history-archive-commit-codex.test.js`，未改任何生产源码、既有 test、fixture 或 schema。测试使用真实 `createPerfCodexIntegrationFixture()` 与 `seedRequestTiming()`，未手写 authority、未绕过正式 prepare/commit。真实夹具核对为 11 条冷 Codex `tps-v2` completed 样本、33 条冷 `perf_sample_sources` 依赖、14 条 hot 与 1 条测试内克隆的 unplaced/NULL 样本；冷样本含显式 native timing 链接。
- 当前唯一预期 RED 位于 `src/history-archive.js:675` 的 `historyArchivePerfDeletion()`：当冷样本 `source_kind` 不是 `zcode`、或任一冷样本有依赖时直接返回 `undefined`，因此 `prepareHistoryArchiveCommit()` 的 `plan.perfDeletion` 缺失。测试首断言为 `formal prepare must include supported cold Codex tps-v2 perf deletion`。相邻窄接缝同样仅允许 `sourceKind === "zcode"`：`src/history-archive.js:1983` 的 plan 校验与 `src/history-archive.js:2102` 的 replay authority 校验；`src/usage-store.js:5104`、`:5203` 的 commit/replay 路径也硬编码 ZCode。
- 修复后测试将继续要求：正式 plan 精确列出全部冷样本且 `sourceKind=codex` / `methodVersion=PERF_METHOD_VERSION`；commit 后 hot 与 unplaced 样本逐列不变，冷 `perf_sample_sources` 随 `ON DELETE CASCADE` 离开热库但候选段仍保留相同依赖行；source/timing/rollout 图保持；`events`、`totals`、`costEstimate` 与稳定完整 `perf` 对未归档 oracle 深等；同 plan replay 为 `replay:true`、零 perf 删除、无重复且候选 SHA-256 不变。
- 本次未声明该 RED 已由宿主执行到目标断言：沙箱在 `createHistoryArchiveCandidate()` 的 Windows 硬链接处按既有 `EPERM` 提前失败；随后的宿主审批均未在自动审查截止前返回，故未取得宿主结果。下面的失败是该沙箱限制，不是 `plan.perfDeletion` 断言的实际失败。

```text
沙箱 node --test test/history-archive-commit-codex.test.js
exit 1；0/1，测试体 246.0864 ms，runner 344.4054 ms。
Error: EPERM ... .archive-commit-codex-candidate.sqlite.history-backup-tmp...
at createHistoryArchiveCandidate (src/history-archive.js:1766)
at test/history-archive-commit-codex.test.js:214

npx.cmd --no-install biome check test/history-archive-commit-codex.test.js
exit 0；1 file checked in 8 ms

node --check test/history-archive-commit-codex.test.js
git diff --check -- test/history-archive-commit-codex.test.js docs/validation/2026-10-22-history-retention/A-report.md
exit 0
```

`test/history-archive-commit-codex.test.js` SHA-256：`0d9132b5918bdcdf7e24d4563453584daf23d678d97885e4a5faebe0a49c8c6a`

本卡只给 B 一个真实 Codex 正式 commit 的 RED 与后续验收骨架；不修源码、不跑全量测试、不证明多段/并发/崩溃恢复、跨机器路径或生产服务接管。宿主结果与修复后完整断言仍待 B/主审执行。

## A15-Codex-formal-perf-commit-CLI：正式 CLI 的 Codex 冷 perf 提交与重放

- 只新增 `test/history-archive-commit-codex-cli.test.js`，未改生产源码、fixture、既有 test 或 output。测试复用 `createPerfCodexIntegrationFixture()`、`seedRequestTiming()` 和真实原生 timing 证据，走正式 `history archive --commit` 调用链：`prepareHistoryArchiveCommit()` -> `publishHistoryArchiveBundle()` -> `commitHistoryArchiveEvents()`；没有手写 authority、手工删除 perf 或新增 CLI/UI。
- 先在未归档 oracle 上断言冷段为非空 Codex `tps-v2` completed、`request_e2e`/`explicit` 样本，且存在真实 `perf_sample_sources` 依赖和原生 timing 链接。正式 CLI 首跑后，热库冷段 `events=0`、`perf_samples=0`，冷 `perf_sample_sources` 随 FK cascade 清空；段外、NULL/unplaced 样本及其依赖、source/timing/rollout 原生共享图逐列保持不变。
- 首跑生成的完整 backup 经 `verifyPublishedHistoryArchiveBundle()` 验证；归档后完整 `events`、`totals`、`costEstimate` 与稳定完整 `perf` 对未归档 oracle 深等。第二条 CLI 重放返回 `Replay: yes`、`Deleted events: 0`，第二个 backup 同样验证通过；重放前后完整逻辑库快照和公开证据不变。

```text
沙箱首次运行（仅一次）：exit 1；0/1，测试体 246.5289 ms，runner 347.8856 ms。
既有 Windows 硬链接 EPERM，在 createHistoryArchiveCandidate 的 backup 阶段提前失败；
随后按约束直接转宿主执行，不重复沙箱。

宿主：node --test test/history-archive-commit-codex-cli.test.js
exit 0；1/1 pass；测试体 10889.3293 ms，runner 10968.2669 ms。

node --check test/history-archive-commit-codex-cli.test.js
npx.cmd --no-install biome check test/history-archive-commit-codex-cli.test.js
exit 0；1 file checked

git diff --check -- test/history-archive-commit-codex-cli.test.js docs/validation/2026-10-22-history-retention/A-report.md
exit 0
```

`test/history-archive-commit-codex-cli.test.js` SHA-256：`9e6a3fa8462f30ca3faa7fb8fb3bc0ce8c2b56dd1e42dbee4af47cc203b78ed4`

本卡只证明一个真实 Codex fixture/线程、一次正式候选提交、一次同候选 CLI 重放及两个完整 backup 的验证闭环；未运行全量测试，不证明多段、并发同步/重放、崩溃恢复、生产服务切换或跨机器路径。

## A20-retained-source-contract：删除来源保留事实、缺源诊断与恢复

- 即时前像保存在 `output/A20-retained-source-contract-preimage-20261026/`：`server.test.js` `e9a26af1764060697ac74337d9e7d25380f31f495573346fed26be5846f73afa`，`perf-summary-parity.test.js` `0be05c657b6b1209c838e7be4cbafafb526e918c4068af28a94683f4e55f4185`，`A-report.md` `694a716f05b655257ed288ce883f8150beea9e026751515ebb2e1ee82f024312`。
- name-pattern 首轮精确复现 6 个失败：project/DSH/OpenCode/Claude 四例都停在 DELETE 后的旧“总量归零”断言，实际保留导入后总量；M4.5 indexVersion 例实际保留删除文件的已发布 DSH 样本（`6` 而非旧 `5`/`3`），nonfatal warnings 例实际保留被删文件的 warning（非空而非旧 `[]`）。这些是旧删除/回滚 oracle 与用户保留契约冲突，不是生产回归，因此未改生产源码、未新增 RED。
- project-log 用例现在断言 DELETE `200`、总量保持、缺失诊断精确指向 `.codex-usage/usage.jsonl` 且 `kind=project-log`；随后重新导入，断言总量不重复、`missingSources` 清空、home 恢复。DSH/OpenCode/Claude 三例同样改为 DELETE `200`、总量保持且存在非空 `missingSources`，保留原有导入、标签、模型与 home 识别断言。
- M4.5 indexVersion 例保留原有“recovery/deletion 改变 indexVersion”断言，只把真实删除后的 DSH 样本数改为保留值：更新 A 后 `6`，删除 B 后仍 `6`；同时断言删除 C/B 后各自仍以原文件路径和 `kind=dsh` 出现在 `missingSources`。M4.5 warnings 例断言删除 B 后 warning 保留，再恢复 B 后 `missingSources` 清除且 warning 仍为单份、无重复。
- 生产源码、schema、fixture、store/archive/merge/eviction 与其它测试均未修改；没有删除或弱化原正确断言。

```text
node --test --test-name-pattern="server imports project usage log directories|server imports a DSH home|server imports an OpenCode data dir|server imports a Claude Code home" test/server.test.js
exit 0；4/4 pass；runner 6177.9311 ms

node --test --test-name-pattern="M4.5 published indexVersion tracks committed DSH files|M4.5 nonfatal DSH warnings persist per file" test/perf-summary-parity.test.js
exit 0；2/2 pass；runner 874.5569 ms

npx.cmd --no-install biome check test/server.test.js test/perf-summary-parity.test.js
exit 0；2 files checked in 46 ms

node --check test/server.test.js
node --check test/perf-summary-parity.test.js
git diff --check -- test/server.test.js test/perf-summary-parity.test.js docs/validation/2026-10-22-history-retention/A-report.md
exit 0
```

- `test/server.test.js` 最终 SHA-256：`18d1321ae9a5167b7b878ac121ac4d892972e4fb451db940fffe031e1678f36c`
- `test/perf-summary-parity.test.js` 最终 SHA-256：`1ddcf8b2193cefe7171a402aeae6f0890aa3d2be64f70db556c4653b42856068`

本卡只运行 6 个定向 name-pattern，未重跑两个完整文件或全仓；未证明多来源同时移除、跨进程恢复、并发 sync、archive 冷源缺失后的上层恢复或生产服务接管。

## A19-period-interval-pruning：period raw fallback 的区间裁剪

- 主审批准的宿主 100k 配对：candidate `1271.158 ms`，preimage `1442.804 ms`，约 `11.90%`；`periodAggregate` `178.881 -> 103.523 ms`。两树完整 `81564 B` HTTP payload、SQL oracle 与归一化 payload 一致；`src/`、`public/` 仅 `src/usage-store.js` 不同，pricing 与 R09 前一致。
- 根即时前像 `src/usage-store.js` SHA-256 为 `A6AF85F881EE37585250BBD06C3C0ED8E3FFE079AD034778863069E85BD87EAA`，与主审锁定值一致。只替换 `periodAggregate()` raw fallback；保留 schema 21、当前 pricing、executor 与其余 store 逻辑，未整文件覆盖。
- 实现先用 `SAVEPOINT period_interval_pruning` 读取 scoped `MIN/MAX(timestamp_ms)`：完全落在范围外时用 `COALESCE(SUM(0), 0)`；完整覆盖时省略 CASE 与四个范围参数；仅部分重叠保留原 CASE。范围、排除 home、分组、排序、repository 元数据与零周期行为不变；异常回滚到 savepoint 后重抛。

```text
node --test test/history-period-interval-pruning.test.js
exit 0；1/1 pass；test 104.5256 ms；runner 197.9997 ms

node --test test/history-period-interval-pruning.test.js test/history-rollup-store.test.js
exit 0；17/17 pass，4 skip；runner 1630.5981 ms

npm.cmd run typecheck
npx.cmd --no-install biome check src/usage-store.js test/history-period-interval-pruning.test.js
node --check src/usage-store.js
node --check test/history-period-interval-pruning.test.js
git diff --check -- src/usage-store.js test/history-period-interval-pruning.test.js
exit 0
```

- 根 `src/usage-store.js` 后像 SHA-256：`7F095705E6C83A2B58084E2A46F726F5CB2A0E4097BBF652B791B76791647859`。
- 根最小专测 `test/history-period-interval-pruning.test.js` SHA-256：`B5E5145DBFF22190E7ECD0151B83731629778F20707E4F655D42FC7E41550228`；仅保留 store/SQL 覆盖，已移除 `output/preimage` HTTP import、复制库与双服务比较。

本卡未运行 million、额外计时、全量测试或生产服务；配对证据仍留在隔离 output。风险限于非 `Date` 范围值会退回原 CASE，以及空库、部分重叠和外部写快照之外的并发/多进程场景未新增验证。

## A19-cost-row-arrays：cost event 原生数组读取

- 主审独立 100k 配对接受：`1284.474 -> 1102.454 ms`（`14.17%`），完整费用、perf 与 HTTP payload 同值；输入集合只有 `src/usage-store.js` 不同，RSS `190967808 -> 161038336`。该结果只支持本候选边界，不推广为通用 JSON/数组收益。
- 根 `src/usage-store.js` 只加入 20 列定序数组 mapper 与 `typeof statement.setReturnArrays === "function"` 分支；无该 API 时保留原 named-object `costEventFromRow`。`sourceKind` 仍按 `home_id` 查原 home map，tier 仍由 `serviceTierEvidence.resolve()` 覆盖，SQL 条件、计价与 summary 逻辑未改。
- 新增 `test/history-cost-row-arrays.test.js`，只 import 根 `UsageStore`，不依赖 `output/baseline`、`output/candidate` 或私有 hash。同一真实临时 SQLite 先强制隐藏 `setReturnArrays` 读取 named-object oracle，再走本机真实原生数组；断言两条路径均实际命中、完整 20 字段（含 tier 覆盖、负数与零）及完整 summary 深等。本机 Node 24 明确断言原生数组路径；通过代理隐藏 API 模拟旧 runtime，完整对象 fallback 与 summary 比较仍执行并通过，未在真实旧 Node 上运行。

```text
node --test test/history-cost-row-arrays.test.js
exit 0；1/1 pass；test 46.2672 ms；runner 186.7812 ms

npx.cmd --no-install biome check test/history-cost-row-arrays.test.js
exit 0；1 file checked in 8 ms

node --check test/history-cost-row-arrays.test.js
git diff --check -- test/history-cost-row-arrays.test.js
exit 0
```

- 根 `src/usage-store.js` SHA-256：`aa047aedbcb6b1f5270c73c6c9a92cfa7cc0eb4f9ae4bcb5732fe061f1096652`。
- `test/history-cost-row-arrays.test.js` SHA-256：`10f67e7b0acfe9ef8f05fd4c8eb13009965943613d8552c98e2ad6d8e420067e`。

本卡未重跑全量或 million，也未在真实旧 Node 或并发场景执行；缺少 `setReturnArrays` 的运行时走旧路径仅由模拟缺 API 覆盖，未来 SQL 列序变化必须同步固定索引 mapper。

## A19/20-memory-limit-wrapper：Windows Job Object 提交内存硬闸门（主审已接管）

- 新增 `scripts/run-with-memory-limit.ps1`：先用 `CreateJobObject` 配置 `JOB_OBJECT_LIMIT_JOB_MEMORY` 与 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，再以 `CREATE_SUSPENDED` 创建子进程、分配入 job、`ResumeThread`；任一步失败即拒绝运行，不回退为无限制执行。参数只接受可执行文件与完整参数数组，不经 `cmd`。默认总提交内存上限 1 GiB，自检专用 64/128 MiB；整体超时默认 900 秒，超时终止 job 并返回 124。
- `JOB_MEMORY` 是 OS 强制的 job 提交内存硬上限，分配失败不会自动杀死整个 job。wrapper 同时监听 completion-port 的 `JOB_OBJECT_MSG_JOB_MEMORY_LIMIT`，收到后 `TerminateJobObject`，5 秒兜底 `TerminateProcess`，内存超限返回 137；该消息不保证送达，故终止路径不能只依赖它，整体超时另行兜底。job handle 不可被子进程继承，wrapper 异常退出时由 `KILL_ON_JOB_CLOSE` 清理残余后代。
- `scripts/self-check-run-with-memory-limit.ps1` 覆盖三组断言：普通子进程精确保留退出码并核对空参数、空格、引号、末尾反斜杠与工作目录；128 MiB 下父子各持有 48 MiB，子进程分配成功并写 PID 后父进程再分配，要求精确退出 137、出现 `job memory limit exceeded` 且子进程消失；外部杀死 wrapper 后子进程消失。
- 主审已接管参数边界并收口为显式 `-ArgumentsJson` 字符串数组；`pwsh -File` 不再依赖 `--` 或空参数透传。主审独立宿主执行自检 **3/3 通过**：正常参数/退出码 23、128 MiB 父子合计超限返回 137 且无残留、wrapper 被外部杀死后子进程清理。本线未执行 wrapper 或自检，不以本线旧命令宣称可用。

```text
PowerShell AST parse: both scripts pass
Add-Type C# compile: pass
git diff --check -- scripts/run-with-memory-limit.ps1 scripts/self-check-run-with-memory-limit.ps1 docs/validation/2026-10-22-history-retention/A-report.md
exit 0
```

- `scripts/run-with-memory-limit.ps1` SHA-256：`F640ADF17EBB6B806572BF8241760696428DF90168D58E3F924324714BD8200F`
- `scripts/self-check-run-with-memory-limit.ps1` SHA-256：`44E139C6B56F38EE404EC6AF34A509663341D20F4AD663D19737914F42ADA7A7`

主审收口后的标准入口：

```powershell
pwsh -File scripts/run-with-memory-limit.ps1 -FilePath node -ArgumentsJson '["--test", ...]'
pwsh -File scripts/self-check-run-with-memory-limit.ps1
```

本线未执行测试、全量、benchmark、生产服务或大夹具。主审已确认上述宿主自检结果；剩余边界仍是父进程若已在限制性 job 中会被明确拒绝、job 限制是提交内存而非 private RSS，以及 breakaway、Windows 版本差异和真实长任务超时/内存消息到达行为。

## A19-history-backup-stream-hash：备份 SQLite 流式摘要

- 前像严格匹配主审锁定 SHA `EE40EAFA…CA1F99`。只改 `src/history-backup.js`：新增 `hashFile()`，用 `createReadStream` 默认小块迭代 `createHash("sha256")`，一次返回 `{ bytes, sha256 }`；create 的临时库、verify 的原库、restore 的复制库三处原整文件 `readFile` 均改走该 helper。manifest 文本读取、数据库/manifest 格式、校验错误码与 16 表 `databaseEvidence()` 内容指纹均未改。
- 数据库文件不再整份驻留内存；create/verify/restore 的 byte 数仍来自实际读到的流长度，digest 仍是同一 SHA-256。无缓存、跳校验、新依赖或 store/core/executor 改动。

```text
node --check src/history-backup.js
npx.cmd --no-install biome check src/history-backup.js
git diff --check -- src/history-backup.js
exit 0；1 file checked in 58 ms
```

- 前像目录：`output/history-backup-stream-hash-preimage-20261026/`（仅两文件，无递归复制）
- `src/history-backup.js` 后像 SHA-256：`F3CE6A6C7453E771BAD0944607C4DE7B73D36010279DDEE55A14BBFC93488139`
- `history-backup.before.js` SHA-256：`EE40EAFA147FE2068EDD715528C79BC6057E51AE8C591090047BF3B184CA1F99`
- `history-backup.diff` SHA-256：`CAA20DA3D47F8C26DDD686E6D58850969055B16BCDC50F6AB1C3914B8DA3188B`

本卡未运行测试、benchmark、全量或生产服务；由主审在 1 GiB job 守护下运行现有 backup/真实 tamper 用例。风险限于流读取期间文件被并发替换时，字节数与摘要仍来自同一流但不再等价于单次内存快照；未新增该并发窗口测试。
