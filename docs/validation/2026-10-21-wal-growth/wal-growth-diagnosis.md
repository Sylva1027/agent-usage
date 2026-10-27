# WAL 异常增长：现场记录

日期：2026-10-21 07:26–07:41（+08）。对象：`~/.codex-usage/usage-index.sqlite`（看板索引库）。仅只读观察，未改动运行中的服务。

## 现象

| 时间 | 主库 | `-wal` | 说明 |
| --- | --- | --- | --- |
| 07:26 | 240 MB | 5,090 MB | 首次发现 |
| 07:38 | 240 MB | 5,368 MB | |
| 07:41 | 240 MB | 5,430 MB | 约 **23 MB/分钟** |

- 主库 `page_count` 58,666–58,679（≈240 MB），`freelist_count` 17 页。
- WAL 头：`page_size=4096`，**`checkpoint_seq=12`**；按帧长 4120 字节计算共 **1,322,419 帧**。
- WAL 索引 `-shm` 10.5 MB（323 个哈希块），与 1.32M 帧一致。
- 1,322,419 帧 ÷ 58,679 页 ≈ **22.5 倍冗余**：同一批页被反复重写，从未完整回写并重置。

## 增长与什么同步

每约 7 秒轮询 `GET /api/status`，WAL 出现 +10–24 MB 的阶跃；不轮询时（07:37:26–07:37:42）几乎不动。`/api/status` 走 `buildUsageFingerprint()` → 触发一次 sync；每次 sync 追加一批页到 WAL。

## 归属确认（这是本项目自己产生的 WAL）

1. 路径由代码写死：`src/usage-store.js:1828` → `~/.codex-usage/usage-index.sqlite`；SQLite 的 WAL 文件名固定为 `<db>-wal`。
2. 进程句柄实测：PID 135340（`node.exe`，cwd = `E:\12 AI\ccusage\codex-usage`，命令行 `node src/cli.js run --port 3765`）同时持有 `usage-index.sqlite`、`-shm`、`-wal` 三个句柄（psutil `Process.open_files()`）。
3. 行为吻合：调用本项目的 `GET /api/status` 时 WAL 阶跃增长，不调用时几乎不动。
4. 库内容就是本项目 schema：`events` 里是 Codex / DSH / ZCode / Claude / OpenCode 渠道。

结论：5.4 GB 的 `-wal` 是本项目看板服务在写，不是其它程序。

## 根因（代码级）

`src/usage-executor.js:131-168` 的 `sync` 分支：

```js
const reader = new UsageStore({ databaseFile: store.databaseFile });
await reader.open();
reader.database.exec("BEGIN");
reader.database.prepare("SELECT id FROM events LIMIT 1").get();   // 钉住快照
publishedStore = reader;
...
storeStatus = await store.sync({ options });                       // 所有写发生在这里
...
finally { publishedStore.database.exec("ROLLBACK"); close(); }     // sync 结束才释放
```

读者快照从 sync 开始一直钉到 sync 结束。SQLite 在每次提交后尝试自动 checkpoint（默认 1000 页），但**不能越过最老读者的快照**，于是每次都 `SQLITE_BUSY`，WAL 只能追加。sync 结束读者关闭，但下一次 sync 又会在写之前先钉一个新快照 —— **checkpoint 永远轮不到**。`checkpoint_seq` 停在 12 正是这个循环的结果。

次要放大项：每轮 sync 都会重写 `perf_codex_projections`（86 MB，库里最大单表），单轮写入量本就偏大。

## 影响

- 磁盘：按 23 MB/分钟 ≈ **1.4 GB/小时、33 GB/天**（仅在看板页面打开、持续轮询时）。当前 C 盘剩 694 GB。
- 崩溃恢复：进程异常退出后需要校验/重放 5 GB WAL，启动明显变慢。
- 备份与复制：整库实际占用 5.6 GB，而不是 240 MB。
- checkpoint 本身越来越慢：每次要搬运的帧数随 WAL 线性增长。

## 建议修复（未实施，需重启服务）

### A. 止血：sync 结束后补一次 checkpoint

`src/usage-executor.js` 的 `sync` 分支 `finally` 里，`publishedStore` 关闭之后对写连接执行：

```js
try { store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* 有读者时退化为 PASSIVE */ }
```

四种 checkpoint 模式的区别（决定选哪个）：

| 模式 | 是否等读者 | 是否搬完 | WAL 文件是否变小 |
| --- | --- | --- | --- |
| `PASSIVE`（默认自动触发） | 否 | 能搬多少搬多少 | 否 |
| `FULL` | 是 | 尽量全搬 | 否 |
| `RESTART` | 是 | 全搬并让下个写者从头写 | 否 |
| `TRUNCATE` | 是 | 全搬 | **是，截断到 0** |

选 `TRUNCATE`：读者刚关闭，写连接是唯一持有者，应当立即成功。加 `busy_timeout`（如 5000 ms）兜底，避免与在途 dashboard 读请求撞车时报错；失败则退化为 `PASSIVE`，下一轮再试。

### B. 兜底：限制 WAL 高水位

连接打开时 `PRAGMA journal_size_limit = 67108864`（64 MB）。注意它不是"立即截断"，而是**在下一次 checkpoint/重置时**把文件裁到这个大小；当前值为 `-1`（不限制），这是 5 GB 高水位能一直留着的直接原因。

### C. 根因：别在整个 sync 期间钉快照

快照读者的用途是"sync 期间仍能读到上一版一致视图"。当前实现把它从 sync 开始钉到 sync 结束，导致 sync 内**每一次提交**的自动 checkpoint 都越不过它。可选方向：

- 读请求各自开短事务（每次 dashboard 请求一个快照），sync 只做写；
- 或 sync 期间读请求返回上一轮缓存，不依赖长事务。

这是设计取舍（一致读 vs checkpoint 可用性），不是一行改动，建议单独立项。

### D. 降低写入量（可选）

- 无实际变更的轮次跳过 `perf_codex_projections`（86 MB）重写；
- `PRAGMA synchronous` 当前是 `FULL`（每次提交 fsync）；WAL 下常用 `NORMAL`，可显著降低提交成本，代价是极端掉电时可能丢最后若干事务（不会损坏库）。

### E. 一次性处理顺序

1. 停掉看板服务（或等它空闲）。
2. `PRAGMA wal_checkpoint(TRUNCATE)`：把 5.4 GB 回写并截断。预计数十秒（需回写约 240 MB 有效页，并扫描 1.32 M 帧的 WAL 索引）。
3. 确认 `-wal` 归零、`-shm` 释放。
4. 视需要 `VACUUM`（见下节；当前只能回收 16 KB，通常不值得）。
5. 重启服务，观察 10 分钟：WAL 应稳定在 100 MB 以内。

### F. 监控与回归

- `/api/status` 增加 `walBytes`；超过阈值（如 512 MB）返回 warning，复用现有 warnings 通道。
- 后台每小时检查一次，超阈值自动 `PASSIVE` checkpoint。
- 测试：executor 层断言 sync 结束后调用了 checkpoint；集成测试在真实文件上跑两轮 sync，断言 WAL 不随轮次单调增长。

## VACUUM 与空间回收

`VACUUM` 相当于**换一本新册子**：把还有用的页抄到新文件，丢掉旧文件。结果是文件变小、页变连续、索引重建。

代价与限制：

- **需要独占**：期间不能有其它连接在写，看板会短暂卡住。
- **需要临时空间** ≈ 库大小（240 MB），SQLite 用临时文件。
- **耗时**与库大小成正比（240 MB 预计几秒到几十秒）。
- **WAL 模式下会重写整库**：又往 WAL 写约 240 MB。若 WAL 仍卡在 5 GB，先 VACUUM 只会雪上加霜——**顺序必须是先 checkpoint、再 VACUUM**。
- 替代方案：`VACUUM INTO 'new.db'` 生成紧凑副本（只读原库），再原子替换，适合这种一次性清理。

当前值：`auto_vacuum=0`（不自动回收）、`freelist_count=4` 页（16 KB）。也就是说**现在 VACUUM 只能省 16 KB**，因为库里几乎没删过东西。它真正有用的场景是"镜像模式下删掉大量历史之后"；归档模式 freelist 几乎不增长，VACUUM 意义很小。

若要"删了就能小步还盘"，需要 `PRAGMA auto_vacuum=INCREMENTAL` + 一次 VACUUM 生效，之后用 `PRAGMA incremental_vacuum(N)` 分批回收。是否启用取决于最终选镜像还是归档。

## 未验证

- 修复后 WAL 是否能稳定回到几 MB（需要改代码并重启，未做）。
- 页面轮询间隔是否可调（前端 `app.js` 的 60 秒检查与实际 7 秒观测不一致，需单独确认）。
- 5 GB WAL 首次 TRUNCATE 的耗时（预计数十秒，未实测）。
