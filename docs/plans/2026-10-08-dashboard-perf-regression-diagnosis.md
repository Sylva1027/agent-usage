# 看板刷新性能回归：诊断与解决方案

日期：2026-10-08。状态：只读诊断完成，**未改动任何产品代码**；方案待用户选定后再实施。

## 结论

慢的不是前端渲染，是后端 `sync()`。同一个「今日」请求，跳过 `sync()` 只要 1.3 秒，走完整路径要 16 秒。用户主观感受的 5–6 秒低估了实际成本——外壳先绘制，所以体感比服务端真实耗时轻。

三条根因按耗时排序：`events.source_path` 缺索引（7.8s）、永久 `degraded` 状态导致每请求全量重解析 1.2GB（7.8s）、`summarize()` 无缓存（2.0s）。三者**都不受日期范围裁剪**，所以选「今日」和选「全部」一样慢，并且随历史增长持续恶化。

## 测量方法

线上服务（127.0.0.1:3765，PID 28340）直接计时，各跑三次取全部样本。

相位级归因在**数据库快照**上做，避免干扰线上库：用 `VACUUM INTO` 从 `~/.codex-usage/usage-index.sqlite` 取一致性快照，再把 `src/`、`public/` 复制到临时目录插桩（相位 mark、调用计数、读取字节数），通过 `UsageStore({ databaseFile })` 指向快照运行。产品工作树全程未被修改。

CPU 侧用 `node --cpu-prof` 采集，按 self time 与 inclusive time 双向归因。

数据规模（本机实测）：

| 来源 | 文件数 | 体积 |
|---|---|---|
| `~/.codex/sessions` | 264 | 273MB |
| `~/.codex/archived_sessions` | 96 | 958MB |
| `~/.zcode` | 1（`db.sqlite`） | 244MB |
| `~/.dsh` | 78 | 46MB |
| opencode | 1 | 27MB |
| **合计（`source_files`）** | **440** | **1,528MB** |

索引库：`events` 37,420 行、`perf_samples` 23,031 行、`source_files` 440 行、`perf_rollout_threads` 356 行。库文件 65MB + WAL 15MB。

## 实测数据

线上服务，`preset=today&bucket=hour&calendarZone=local&view=dashboard`：

| 请求 | 三次样本 |
|---|---|
| 完整路径（页面刷新 / 手动刷新） | **16.76s / 16.25s / 15.70s** |
| 同 URL + `skipCheck=1`（切换筛选） | **1.26s / 1.37s / 1.24s** |

响应体两次完全相同（155,465B），说明差额全部来自 `sync()`。

快照上插桩复现，**期间零文件变化**，连续三轮：

```
sync #1: 19.12s    sync #2: 19.66s    sync #3: 19.22s    (files=440)
summarize(today) #1: 2.06s   #2（参数完全相同）: 1.96s
periodComparison(): 0.30s
```

连续两轮耗时一致且计数器完全相同 ⇒ **跨请求缓存彻底无效**，每轮都从零重做。

### sync 相位分解（每轮）

| 阶段 | 耗时 | 说明 |
|---|---|---|
| `discoverUsageSources` + `usageFiles` + `buildUsageFingerprint` | ~0.05s | 目录遍历本身**不是**瓶颈 |
| db 预载 + `pendingChange` 预扫 | ~0.02s | |
| **codex home 规划（`planStableCodexHome`）** | **7.8–8.1s** | 见根因 2 |
| **主逐文件循环（440 文件）** | **10.2–10.4s** | 其中 7.8s 见根因 1 |
| codex staging | 0.09–0.10s | |
| codex publish | 0.60–0.65s | |
| `loadServiceTierEvidence` + 收尾 | 0.16–0.17s | |
| **合计** | **19.2s** | |

## 根因 1：`events.source_path` 缺索引（7.8 秒）

[主循环](../../src/usage-store.js:2187)对**每个文件**执行一次 [session 反查](../../src/usage-store.js:2191)：

```sql
SELECT DISTINCT session_id FROM events WHERE source_path = ?
```

`EXPLAIN QUERY PLAN` 结果为 `SCAN events` + `USE TEMP B-TREE FOR DISTINCT`——全表扫描。37,420 行 × 440 次 = **每轮 1,650 万行访问**。

[现有索引](../../src/usage-store.js:1116)只有 `timestamp_ms`、`home_id`、`channel`、`project`、`model`，加上 [:1299](../../src/usage-store.js:1299) 的 `repository_key`——**唯独没有 `source_path`**，而该列在 `usage-store.js` 中被引用 41 次。对照 [perf_samples 反而建了 source_path_idx](../../src/usage-store.js:156)，可判定这是遗漏而非设计取舍。

直接在快照库上验证修复效果：

```
BEFORE (no index)  440 次:  7,806ms
CREATE INDEX 一次性开销:        92ms
AFTER  (indexed)   440 次:      30ms      ← 260 倍
plan: SEARCH events USING INDEX events_source_path_idx (source_path=?)
```

## 根因 2：永久 `degraded` 状态 → 每请求重解析 1.2GB（7.8 秒）

`store_meta` 实际内容：

```
perf_state             = "degraded"
perf_degraded_home_ids = ["main-b07e6ade4ffb1033"]        ← 主 Codex home
perf_source_warnings   = [{"sourceKind":"codex","homeId":"main-b07e6ade4ffb1033",
                           "code":"MALFORMED_JSON","count":3}]
perf_codex_publication_policy = {"revision":2,"partialHomes":[
    {"homeId":"main-b07e6ade4ffb1033","blockedThreadIds":[3 个 thread]}]}
```

**3 行坏 JSON** 使那几个 thread 永久 blocked → home 永久停留在 partial/degraded → [priorDegradedHomeIds](../../src/usage-store.js:1948) 与 `priorPartialHomeIds` 恒真 → [shouldPlan](../../src/usage-store.js:2030) 恒真 → [planStableCodexHome](../../src/usage-store.js:2059) 每轮重解析该 home 的全部文件。

插桩确认触发条件与放大倍数：

```
shouldPlan.reason.priorDegraded                       1    ← 永久触发器
shouldPlan.reason.priorPartial                        1
shouldPlan.reason.metadataChanged                     1
  └ metadataChanged.subreason.perfFileNeedsRefresh    4    ← 实际只有 4 个文件需要刷新
  └ metadataChanged.subreason.noCurrentOwnership      4
shouldPlan.homeFilesScanned                         360
codex.readCodexRolloutMetadata.calls                360    ← 却重解析了 360 个文件
codex.readCodexRolloutMetadata.lines            194,536
planStableCodexHome                             7.81s  (n=1)
```

**4 个文件的问题，代价是 360 个文件 / 1,211MB / 194,536 行的全量重解析——放大约 90 倍。** 且该循环**永不收敛**：坏行是永久的，每轮都会重新得出同样的 degraded 结论。

解析全程串行（`codex-thread.js` 内 `for (const filePath of [...].sort()) { await readCodexRolloutMetadata(...) }`），无任何并发。

## 根因 3：`summarize()` 无缓存（2.0 秒）

连续两次**参数完全相同**的调用各需 2.06s / 1.96s。[metadataCache 与 periodComparisonCache 在每次 sync 结束时被清空](../../src/usage-store.js:2601)，因此每次刷新都重算。

其中 [rankedHomeIds](../../src/usage-store.js:3295) 通过 `perfCandidatesForRange(null)` 解码**整张** `perf_samples`（23,031 行 / 184ms），而这个结果与所选日期范围无关，属于纯浪费。

## 次要放大器

**指纹探针阻塞事件循环。** 每轮 sync 共 **1,542 次**同步内容探针：822 次 [enabledPerfSourceStat](../../src/usage-store.js:671) 读 86.1MB，720 次 [perfContentFingerprint](../../src/usage-core.js:2055) 读 77.3MB，合计 **163MB**，全部走 `openSync`/`readSync` + sha256（每文件首尾各 64KiB），在请求线程上同步执行。

**循环内重复 JSON.parse。** [readPublishedFileFingerprints() 与 readPublishedFileWarnings()](../../src/usage-store.js:2219) 在逐文件循环**内部**按文件调用，两个 map 分别为 81,707B（436 条）与 55,748B（431 条）⇒ 每轮约 60MB 的 JSON 文本解析，实测 self time 约 0.25s。

**冗余目录遍历。** [discoverSessionFiles](../../src/usage-core.js:705) 每轮被调用 **4 次**，累计返回 1,440 条（实际仅 360 个文件）。遍历绝对耗时很小（~0.05s），但放大了 stat 次数。

**前端启动链严格串行。** [bootDashboard](../../public/app.js:4950) 先 `await loadUsage()`，完成后才 `startAutoRefresh()` 与 `refreshPricingAutomatically()`；后者 [POST /api/pricing/refresh](../../public/app.js:3322)，若返回 `changed` 再 `GET /api/pricing`，并触发[第二次完整 loadUsage](../../public/app.js:3340)。命中时等于再付一次 16 秒。

**轮询。** [AUTO_REFRESH_INTERVAL_MS = 60_000](../../public/app.js:52)，[checkForUpdates](../../public/app.js:4290) 打 `/api/status` 触发全源遍历；quota 预设（5h/7d）[无条件每 60s 重新 loadUsage](../../public/app.js:4297)。另有[每小时定价刷新](../../public/app.js:4954)。

**渲染侧。** `render()` 末尾调 `translatePage()` 走全页文本节点，同时 [document.body 上挂了 MutationObserver](../../public/i18n.js:708)，每次 innerHTML 重建后再触发一次全页翻译。图表 canvas 的 ResizeObserver 会在 60ms 后调 `render()`，而 render 自身改变布局，存在 render 循环风险。这两项相对后端 16 秒是次要项，但会放大交互卡顿感。

**前端无任何计时埋点。** `public/` 下没有 `performance.mark`、`console.time` 或耗时展示，唯一可观测的是 `#lastSuccessfulCheck` 显示的服务端 `checkedAt` 时间戳，不含 duration。这正是本次回归无法被及早发现的原因。

## 为什么是「逐渐」变慢

两条增长律，都**完全无视**「今日」这个范围——日期过滤只发生在最后的 SQL 聚合里，扫描与解析阶段从不裁剪：

- **根因 1 = O(文件数 × events 行数)**。两个因子都随历史增长，属**二次方恶化**。当前 440 × 37,420。
- **根因 2 = O(codex 总字节数)**。当前 1,211MB / 360 文件，其中 `archived_sessions` 占 958MB / 96 文件；归档越多越慢，且因 degraded 恒真而每轮必付。

补充：整个 perf 子系统（`src/perf-sources/`、`src/perf-stats.js`、`public/perf-ui.js`）目前仍是 **untracked、从未提交**状态。本次回归在 git 历史中没有任何痕迹，也没有可对比的性能基线。

## 解决方案

### 方案 A — 补 `events(source_path)` 索引

在 [索引块](../../src/usage-store.js:1116)增加 `CREATE INDEX IF NOT EXISTS events_source_path_idx ON events(source_path)`，并接入现有 schema 迁移机制（`usage-store.js:1257` 附近），确保**已有库**也会补建。

- **收益**：约 7.8s（16s → ~8s）。实测 7,806ms → 30ms。
- **风险**：极低。`events` 只在文件变更时写入，写放大可忽略；索引约增 2–4MB 库体积。一次性建索引 92ms。
- **工作量**：约 15 分钟。
- **注意**：若只加进 `CREATE TABLE` 附近的初始化块而不走迁移，老库不会自动获得索引。

### 方案 B — 打破永久 degraded 循环

四个子选项，可组合：

- **B1（治本）**：让 `MALFORMED_JSON` 停留在**每文件**告警级别，不升级为 home 级永久降级。坏行应当只使该文件/该 thread 的候选缺失，不应把整个 home 钉死为 partial。
- **B2（消除放大）**：重规划粒度从 home 降到 file——只重解析变化文件所属的 thread，而非全部 360 个文件。实测触发源只有 4 个文件。
- **B3（兜底）**：给 degraded home 的 `shouldPlan` 加重试预算或退避，避免每轮无条件重试一个已知不会收敛的状态。
- **B4（最省事）**：把 `archived_sessions`（958MB / 96 文件）排除出 perf 扫描。TPS 指标不需要历史归档，用量侧仍可保留。

- **收益**：约 7.8s（8s → ~1–2s）。B4 单独即可去掉大部分解析量。
- **风险**：中。触及 perf 正确性语义（归属、发布、去重），必须跑现有 perf 与 API 测试套件。
- **工作量**：B4 最小；B3 小；B1/B2 较大。

### 方案 C — `summarize()` 加缓存

按 `(filters, 索引版本, excludedHomes)` 做 memo，sync 后失效一次而非每请求重算；`rankedHomeIds` 改用 SQL 聚合，不再 `perfCandidatesForRange(null)` 解码整表。

- **收益**：约 2.0s；重复刷新可压到几百毫秒。
- **风险**：低。需保证失效点覆盖所有写入路径（含 [:2955](../../src/usage-store.js:2955) 的 `periodComparisonCache.clear()`）。
- **工作量**：1–2 小时。

### 方案 D — 指纹探针降本

先走 `size + mtime` 快速路径，仅在变化时才做 128KiB 内容摘要；把两个 published map 的解析提到循环外只做一次；`discoverSessionFiles` 每轮复用一次结果。

- **收益**：约 0.5–1s，更重要的是消除每轮 163MB 同步读对事件循环的阻塞。
- **风险**：低-中。会削弱 [B7 那条「同尺寸 + 同整毫秒 mtime 的原地改写」防御](../../src/usage-store.js:2208)，需明确权衡后再动。
- **工作量**：2–4 小时。

### 方案 E — 前端

启动链并行化（`loadUsage` 与定价刷新不必串行）；补 `performance.mark` 埋点并在「上次：…」旁展示耗时；`translatePage` 的 MutationObserver 改 debounce 或缩小观察子树；ResizeObserver → `render()` 加尺寸变化阈值。

- **收益**：防止二次完整加载（最坏情况再省 16s）；建立可观测性，使下次退化能被发现。
- **风险**：低。
- **工作量**：埋点 30 分钟；其余 2–4 小时。

### 方案 F — 架构级（长期）

按 codex `YYYY/MM/DD` 分区裁剪 perf 扫描，让「今日」真正只读今天；`sync()` 与 HTTP 请求解耦（后台定时或文件 watcher），请求只读已发布缓存。

- **收益**：请求耗时与历史数据量脱钩。
- **风险**：中高，涉及数据新鲜度语义与冻结/快照交互。
- **工作量**：数天。

## 建议执行顺序

**A → B4 → B2 → C → E**

| 阶段 | 预期 |
|---|---|
| A | 16s → ~8s |
| A + B4 | → ~2–3s |
| A + B4 + B2 | → ~1s 以内 |
| 再加 C | 重复刷新降至数百毫秒 |

A 是一行索引加一次迁移，风险最低、收益最大，建议先单独落地并复测，再决定是否动 B。

## 复现与验收

复测命令（对运行中的服务）：

```bash
BASE="http://127.0.0.1:3765/api/usage?preset=today&bucket=hour&calendarZone=local&view=dashboard"
curl -s -o /dev/null -w "full:      %{time_total}s\n" "$BASE"
curl -s -o /dev/null -w "skipCheck: %{time_total}s\n" "$BASE&skipCheck=1"
```

验收判据：

1. `EXPLAIN QUERY PLAN SELECT DISTINCT session_id FROM events WHERE source_path='x'` 必须显示 `SEARCH ... USING INDEX`，不得为 `SCAN events`。
2. 零文件变化时连续两轮 `sync()`，第二轮应显著快于第一轮；当前二者相同即为缓存失效。
3. `store_meta.perf_state` 不应因少量 `MALFORMED_JSON` 长期停留在 `degraded`。
4. `codex.readCodexRolloutMetadata.calls` 应与实际变化文件数同量级，而非恒等于全部 codex 文件数。
5. 相同参数的 `summarize()` 第二次调用应命中缓存。

本次诊断的插桩副本与数据库快照位于 `C:\Users\Silver\AppData\Local\Temp\cud-prof\`（`instr/` 为插桩副本，`snapshot*.sqlite` 为 `VACUUM INTO` 快照，`profile.mjs` / `run-instr.mjs` / `db.mjs` / `idx.mjs` / `meta.mjs` 为测量脚本），可随时删除，与产品工作树无关。
