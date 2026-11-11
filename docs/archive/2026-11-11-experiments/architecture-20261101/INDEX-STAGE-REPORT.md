# 会话累计复合索引：首个实施子阶段

> 历史材料，2026-11-11 归档。本文命令与状态属于原记录日期；源码及恢复方法见[归档入口](../README.md)。

日期：2026-11-02。正式基线 v0.8.5 / `6d458caac0f3c7634321462f6b5345260faf3bab`，Windows / Node 24.19.0。

本次完成[重构计划](../../../plans/2026-11-02-multi-harness-history-refactor.md)阶段 A 中可独立审查的索引子阶段。阶段 A 的增长数据集与容量基线尚未完成，阶段 B/C 尚未开始；按用户要求在此暂停，等待反馈。

本文的“原实现”和82.574秒均指当前项目 v0.8.5 加索引前的基线，不是用户最初接手的上游仓库；上游源码与归属对照见[比较报告](UPSTREAM-COMPARISON.md)。

## 改动与兼容

`UsageStore.open()` 沿用现有 `events_repository_idx`、`events_source_path_idx` 的附加索引升级方式，加入：

```sql
CREATE INDEX IF NOT EXISTS events_session_home_time_idx
ON events(session_id, home_id, timestamp_ms);
```

schema 仍为 24。该索引不改变事实布局、计价、耐久设置和解析规则；首次真正打开旧库时补齐，再次打开只检查存在性，不强制重扫来源。SQLite 单条建索引语句具有事务原子性。旧代码仍可读取带此索引的 schema 24 库；代码回退不会自动删除它，若要回收索引空间，需另行删除索引。私有无索引控制库已验证查询结果相同。

正式实现增加 3 行；迁移回归覆盖新库、旧库补索引、来源日志已消失时保留历史、全部持久表内容不变、查询计划及重复打开不改 schema。

## 完整重建复测

使用上轮相同捕获原始输入、空索引种子、原页面及 JSON/SQL/阶段探针，实际执行六类来源检查、同步和解析。目录/stat 仍使用既有冻结回放，内容和指纹读取捕获文件；这不是实际目录 I/O 或 OS 冷缓存测试。Chromium 预先启动，每轮新 context，从服务启动前计时到精确 token 值显示后两帧。网关/执行器堆设置沿用正式默认值。

| 项目 | 原实现既有测量 | 实验索引既有测量 | 本次正式索引复测 |
| --- | ---: | ---: | ---: |
| 完整重建到首屏 | 82.574 s | 52.030 s | **53.629 s** |
| 累计查询次数 | 1,493 | 1,493 | **1,493** |
| 累计查询耗时 | 29.641 s | 0.0169 s | **0.0181 s** |

本次为一次诊断复测，历史对照来自[完整启动报告](FULL-STARTUP-REPORT.md)，不是重新交错执行的多样本排名，也不报告 p95。相对既有原实现样本，完整重建约减少 35%；它不代表无变化启动或日常切换也能减少约 29 秒。

直接对比本次与原实现的数据库：**146,412 条事件、71,153 条额度观测**，除自增事件 id 外全部字段排序后的 SHA256 分别相同。没有通过减少解析或遗漏事实取得收益。

## 旧库升级与资源代价

隔离种子有 160,862 条事件、1,975 条来源记录，包含原始文件已经缺失的历史。只读 SQLite backup 后，正式 `open()` 在私有副本补索引，没有执行来源扫描。前后 23 张持久表（含旧历史、额度、rollup、元数据及遗留表）流式哈希全部一致。

| 项目 | 本次测量 |
| --- | ---: |
| 首次正式 open（包含补索引及其他 open 工作） | 164.197 ms |
| 显式 checkpoint / close | 0.871 / 0.592 ms |
| 已有索引的再次 open | 12.780 ms |
| `dbstat` 索引体积 | **12,369,920 bytes，约 11.8 MiB** |
| 数据库主文件大小增长 | 0 bytes；复用 3,020 个空闲页，索引仍有实际空间成本 |

单个有 6,085 条跨文件前序事实的真实会话，用同一 SQL、同一参数、同样私有控制库作三次交错查询：无索引 33.231–33.435 ms，有索引 5.488–5.831 ms；所有累计字段精确一致。计划从 `events_home_idx(home_id=?)` 改为三个条件共同约束的新索引。此长会话样本与空库重建的 1,493 次查询是不同负载，不能混算平均耗时。

固定 512 条插入的写成本控制，每次使用新副本，两种条件按轮交错；保留现有其他索引及触发器，建控制库和 VACUUM 均在计时外：

| 项目（三次样本） | 无新增索引 | 有新增索引 |
| --- | ---: | ---: |
| 事务中位耗时（BEGIN 到 COMMIT 返回） | 19.518 ms | 22.390 ms |
| COMMIT 中位耗时 | 1.803 ms | 1.777 ms |
| 每次新增 WAL 字节 | 552,112 | 630,392 |

该控制负载下，总事务约增加 2.9 ms / 14.7%，WAL 约增加 14.2%。WAL 字节不是物理磁盘写入量；不能外推所有追加、修订或迁移的写放大。索引收益足以支持保留这项改动，后续容量基线仍需观察真实日常同步与更长会话，不能用本轮替代联合验收。

## 验证与现有失败

- `test/usage-store.test.js`：52/52 通过；新增测量脚本的最小 fixture 自检：1/1 通过。
- 全套 Windows 回归：2,510 项，2,486 通过、1 失败、23 跳过。已执行的六来源采集、迁移、备份/归档及历史业务相关回归通过；类型检查、格式检查通过，lint 无错误（51 个警告、3 个提示）。
- 唯一失败为 `skin-palette-quality.test.js` 的 `M5.2.C-D2b3` Edge 用例，断言搜索 `x` 应有过滤结果。用仅在实验进程内将新增索引 DDL 替换为 `SELECT 1` 的加载钩子重跑，仍在相同断言失败；未更改这项既有皮肤测试或产品逻辑。全套结果不能写成全部通过。
- 23 项跳过包括时区/子进程入口，以及 Windows 无文件符号链接权限的分支；跳过不计为验证通过。只在本机 Node 24 执行，未验证 Node 22、Linux/macOS。
- 最初沙箱执行因备份硬链接 `EPERM` 中断；随后工作区带空格临时路径导致冷快照打开失败。定向对照确认禁用新增索引时该路径也失败，原生 Windows 临时目录下通过；最终全套按原生临时目录和 `TZ=Asia/Shanghai` 执行，前两次中断记录保留。

性能实验均在上述回归结束后运行。未重启用户服务；只读核查活动库仍为 schema 24，且不存在本次新增索引。没有将私有实验库替换为活动库，也没有执行 commit/push/发布。

## 证据与复现

私有证据位于 ignored `output/architecture-20261102/index-stage/`：

- `measurement-1/index-migration-report.json`：旧库哈希、建索引与重开耗时、体积、SQL 计划、三次查询和写控制。
- `rebuild-parity.json`、`full-rebuild-sql/`：完整重建字段对拍及累计查询统计。
- `full-tests-canonical.log`、`edge-baseline.log`、`space-path-baseline.log`：最终回归与既有失败定向对照。
- `typecheck.log`、`lint.log`、`format.log`、`active-index-check.json`、`worker-audit.json`。

本次完整重建的页面/API、进程和探针数据另在 `output/architecture-20261102/full-startup/formal-index-stage-empty-detail/`。所有来源路径、会话明细及原始响应保留在私有输出中。

可用 `pwsh` 复现旧库控制，输出目录必须全新：

```powershell
node experiments/architecture-20261101/index-migration-benchmark.mjs output/architecture-20261102/full-startup/seed-indexed/usage-index.sqlite output/architecture-20261102/index-stage/measurement-new
node --test experiments/architecture-20261101/index-migration-benchmark.test.mjs
```

复用已有捕获和种子，完整重建复测的关键设置为 `ARCH_STATE_SEED=.../seed-empty`、`ARCH_STARTUP_REPLAY_FILE` 指向捕获 manifest、`ARCH_STARTUP_SQL_DIR` 指向全新输出、`ARCH_STARTUP_CUMULATIVE_INDEX=0`、`ARCH_FIRST_ONLY=1`、`ARCH_NO_TRACE=0`，运行 `full-startup-run.mjs` 并使用全新名称。新增索引由正式代码创建。
