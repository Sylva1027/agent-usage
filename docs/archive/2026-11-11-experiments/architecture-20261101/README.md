# 四个架构原型

> 历史材料，2026-11-11 归档。本文命令与状态属于原记录日期；源码及恢复方法见[归档入口](../README.md)。

最新正式重构结果见 [Q3：额度增量与完整重建报告](Q3-QUOTA-REBUILD-REPORT.md)。14 次有效完整重建及 160 次原页面追加已完成；10× Codex 刷新 11.96→5.21 秒，服务树约 333 MiB。完整重建 469.96→456.87 秒，但相对 Q2 前对照的 5% 门仍未通过。本阶段已收口，停止等待反馈；以下保留原型与前序实验记录。

本目录实现四个可独立运行的本地服务：

| 原型 | 服务与存储 | 查询路径 |
| --- | --- | --- |
| P1 | Node + SQLite | 事务维护类型化查询投影，SQLite 内筛选与聚合 |
| P2 | Rust + SQLite | 常驻 Rust 发布态，Rust 聚合 |
| P3 | Rust + redb | 按来源持久化，常驻 Rust 发布态，Rust 聚合 |
| P4 | Rust + DuckDB | 类型化事件表，DuckDB 内筛选与聚合 |

全部使用同一份原型页面，也能通过共同兼容层使用现有产品网页。没有桌面客户端。服务只监听 `127.0.0.1`，默认使用随机端口和独立数据库。

实施范围、Windows 性能验收及后续平台适配见 [原计划](../../../plans/2026-11-01-architecture-prototypes.md)。2026-11-02 起先推进 Windows，Linux/macOS 适配在重构基本完成后进行。这里是可运行实验，尚不是正式替换包。

## 快速运行

在仓库根目录执行。Node 需要支持 `node:sqlite` 和 zstd 的版本；本机使用 Node 24.19.0。Rust 构建需要本机 C/C++ 编译工具，DuckDB 使用 bundled 源码构建；Windows 使用 PowerShell 7。

```sh
cargo build --locked --release --manifest-path experiments/architecture-20261101/native/Cargo.toml --jobs 2
```

分别启动任意一个原型：

```sh
node experiments/architecture-20261101/demo.mjs --variant node-sqlite
node experiments/architecture-20261101/demo.mjs --variant rust-sqlite
node experiments/architecture-20261101/demo.mjs --variant rust-redb
node experiments/architecture-20261101/demo.mjs --variant rust-duckdb
```

启动输出中的 `url` 打开现有产品网页，`engine` 是对应后端。默认加载 180 条覆盖六来源的合成事件，包含价格、额度与日期范围所需字段。

附加 `--core` 可以直接打开原型的基础聚合页面；它用于观察实际发布版本和冻结行为。

```sh
node experiments/architecture-20261101/demo.mjs --variant rust-duckdb --core
```

使用已经冻结的真实数据：

```sh
node experiments/architecture-20261101/demo.mjs --variant rust-sqlite --fixture output/architecture-20261101/real/fixture.json
```

所有演示数据默认保存在 `output/architecture-20261101/demo/<variant>-<timestamp>/`。按 Ctrl+C 结束启动器及其子进程。`--directory` 可指定需要重用的实验目录，`--port` 指定产品兼容层端口。

## 真实日志采集

四后端共享当前产品的 Codex/DSH 解释器，先完整检查输入和读前后 SHA-256，再原子替换对应来源。输入损坏、半行、坏压缩帧或读取期间变化，不覆盖已经接受的事实及游标。

生成可随意追加/改写的测试文件与配置：

```sh
node experiments/architecture-20261101/fixture.mjs
```

向已启动服务的 `engine` 地址采集一次：

```sh
node experiments/architecture-20261101/collect.mjs --backend http://127.0.0.1:PORT --sources output/architecture-20261101/raw/sources.json --once
```

不加 `--once` 则持续检查；`--interval 1000` 指定间隔。来源配置格式：

```json
[
  {
    "sourceId": "local-codex",
    "kind": "codex",
    "path": "/absolute/path/to/session.jsonl",
    "home": { "id": "codex-home", "label": "Codex", "path": "/absolute/path/to/home", "kind": "main" }
  }
]
```

P1 还可以直接使用 `node/server.mjs --database FILE --port 0 --sources CONFIG --web experiments/architecture-20261101/web.html`，在服务内启动轮询和目录监听。

输入文件只读。`collect.mjs` 将结果写入指定的实验后端；原型不会替换用户的正式用量库。

## 验证命令

```sh
node --test "experiments/architecture-20261101/node/*.test.mjs"
cargo test --locked --release --manifest-path experiments/architecture-20261101/native/Cargo.toml --jobs 2
node experiments/architecture-20261101/verify.mjs
node experiments/architecture-20261101/collector-parity.mjs
```

共享验证覆盖：

- 六来源事件、所有原始字段、context 和 cursor 完整往返。
- 日期边界、来源排除、空结果、跨来源会话去重。
- 现有产品公式的八组固定时间投影，包括费用、额度和周期对比。
- 原子来源替换、输入错误不推进发布版本。
- 冻结后继续提交、进程中断重启与持久快照。
- Codex 累计用量差分及 DSH 多帧压缩解析。
- 同大小、同 mtime 改写检测；半行和损坏帧保留旧事实。

`verify.mjs` 的产品公式由共同 `compat.mjs` 调用当前 `src/usage-core.js`、`src/pricing.js` 和 `public/period-comparison.js`。这个验证检查各后端保留的数据能否得到一致业务结果，不是证明这些公式已经原生化。

### 真实历史

`export-real.mjs` 只读打开现有库，用 SQLite 在线备份取得一致快照，然后仅在实验副本内打开当前 UsageStore，并读取冷热合并的已发布历史。

```sh
node experiments/architecture-20261101/export-real.mjs
node --max-old-space-size=2048 experiments/architecture-20261101/real-parity.mjs
```

本次输入包含 159,610 条事件、六种来源。私有数据和绝对路径只保留在被忽略的 `output/architecture-20261101/`。

数据按 10,000 条分批提交，避免超出 64 MiB 单次写入上限。完整事件及 context 无损比较，并在同一固定时间对拍全部、今日、本周、本月的完整产品公式结果。

这项验证中的单轮耗时只是诊断记录，不能作为 p95、性能目标或不同技术优劣的最终结论。运行时可能与构建或其他正确性检查重叠。

### 浏览器

使用已有 Playwright 安装，通过 `ARCH_PLAYWRIGHT_MODULE` 指定其 `index.mjs` 路径。可用 `ARCH_CHROMIUM` 指定 Chromium 可执行文件。

```sh
node experiments/architecture-20261101/browser-check.mjs
```

脚本依次启动四后端，验证原型页面的范围切换、冻结时新增不改变画面、恢复后出现新版本；随后实际打开当前产品网页，检查全部、本周和暂停刷新操作。

结果保存在 `output/architecture-20261101/browser/results.json`，截图在 `output/playwright/architecture-<variant>.png`。

## 证据与边界

- 基线：`output/architecture-20261101/baseline-head.txt`、`baseline-status.txt`、`baseline-hashes.json`。
- 后端契约：`output/architecture-20261101/verification/results.json`。
- 采集链路：`output/architecture-20261101/collector-verification/results.json`。
- 真实历史：`output/architecture-20261101/real/manifest.json`、`real-results/results.json`。
- 最终查询路径：`output/architecture-20261101/real-results/final-query-results.json`，用最新查询实现重读完整的 159,610 条真实事件，并对拍全部基础分组和四组产品业务投影。
- 浏览器：`output/architecture-20261101/browser/results.json`。
- Worker 创建参数与返回 ID：[worker-model-audit.json](../README.md#恢复归档)。三名 worker 均显式请求 `group/deepseek`、`reasoning_effort=max`，记录不作为物理后台模型证明。

当前业务基线已更新为 0.8.5，HEAD `6d458ca`，产品删除了 TPS 运行模块。本轮没有将旧 TPS 实验算作新基线通过，也未重新引入 TPS。

完整定价、额度和周期对比仍由共同 Node 层处理，Codex/DSH 采集也仍复用 Node 解释器。因此 Rust 演示整条进程树仍含 Node；不能宣称已经完全移除 Node，或用原生基础聚合耗时代替整页刷新耗时。

全文校验回退仍保留。来源替换后的发布态重建、快照物化和其余四来源实时接入，都还有后续优化或补全空间。本轮没有用降低可靠性换速度。

当前以 Windows x64 为实现、选型和验收目标，[原型手动验证流程](../README.md#恢复归档)也只运行 Windows。现有可移植依赖和统一启动器继续保留；Linux/macOS 在核心重构基本完成后再集中适配和实测，不阻塞当前推进。工作流尚未上传或触发。

2026-11-01 阶段尚未完成一小时混合负载、八小时长测、100 样本延迟矩阵和最终迁移选择。2026-11-02 已补真实页面百样本初筛，结果见下节；长测、扩展规模及生产接入条件仍未全部达成。

## 本轮实际验收

Windows x64 上，三后端 bundled release 构建成功。Node 局部测试 20 项、Rust 两套测试共 26 项全部通过。四后端共享接口验证、Codex/DSH 采集验证、强制中断后的恢复、真实历史无损对拍及浏览器检查全部通过。

基础查询新增了类型化 SQL 路径，但还没有完成日常小增量的全部预聚合、原生来源解释器或完整业务公式原生移植。本轮不据单轮接口耗时选择迁移胜者。

## 2026-11-02 看板链路初筛

本阶段保持正式 `src/`、`public/` 和活动库不变，网页仍使用原产品资源。新增按版本读取来源变化的 `/api/changes`，共享 gateway 首次读全量，之后先探测薄版本，发生变化才读取来源 delta；普通日期范围的四个基础汇总字段实际使用对应后端 `/api/query`。

业务视图按修订、完整筛选、价目及安全时钟边界缓存。滚动一天范围逐次计算；并发请求捕获各自的 facts revision；冻结视图有独立 ID，绑定事实、时钟和价目。`--mode legacy` 保留每次下载全量 report 的路径。

本阶段约定见 [PRODUCT-PHASE.md](PRODUCT-PHASE.md)，worker 创建参数与顺序卡见 [审计记录](../README.md#恢复归档)。三名 worker 显式使用 `group/deepseek` / `max`，收口后全部关闭。

```sh
node --test "experiments/architecture-20261101/node/*.test.mjs" experiments/architecture-20261101/product-server.test.mjs
cargo test --locked --release --manifest-path experiments/architecture-20261101/native/Cargo.toml --jobs 2
node --max-old-space-size=3072 experiments/architecture-20261101/product-integration-check.mjs
```

使用前述 Playwright 环境变量及原来的私有冻结输入，选择一个**新的输出目录**运行页面测量：

```sh
node --max-old-space-size=3072 experiments/architecture-20261101/product-benchmark.mjs output/architecture-20261102/recheck-1
node experiments/architecture-20261101/analyze-product-benchmark.mjs output/architecture-20261102/recheck-1
node experiments/architecture-20261101/product-live-check.mjs
node experiments/architecture-20261101/record-product-evidence.mjs
```

默认每组有 3 次冷服务启动，以及各 100 次切换、页面重载和小来源版本更新。每次更新检查精确 token 数及修订，再等两帧；服务进程树和 Chromium 资源单独采样。失败不会被记作成功延迟。`ARCH_SAMPLES`、`ARCH_COLD_SAMPLES` 仅用于缩短预检，不得把预检结果当百样本结果。

B0 使用现有正式服务的 importContext 读取私有冻结索引，保留默认 224 MiB 执行器限制；未模拟实时来源发现与正式持久汇总缓存。因此其性能和失败只代表该隔离路径。原型的新版本测量同样从已验证事实写入索引开始，不包含来源检测/解码，也不省略正式页面的自动检查等待来冒充自然刷新速度。

`product-live-check.mjs` 另用默认真实时钟检查暂停、恢复和自然的 60 秒自动刷新。它的四组小夹具并行运行只验证正确性，不作为架构性能排名。详细结果见 [Windows 看板初筛报告](WINDOWS-REPORT.md)和忽略的 `output/architecture-20261102/`。

本阶段 Node 后端 23 项、Rust release/all-features 28 项、gateway 14 项测试通过。四原型各完成 100 次切换、100 次重载、100 次小来源版本更新，真实业务对拍和默认时钟浏览器检查全部通过。B0 在完成 100 次切换后，导入模式页面重载触发默认 224 MiB 执行器 OOM，其余场景没有记作成功。

切换 p95：P1/P2/P3/P4 分别为 672/134/128/171 ms；更新到指标显示 p95 分别为 2,638/3,212/3,097/5,134 ms，均未达到 1 秒目标。当前没有满足两项目标的迁移胜者；下一轮优先改增量发布、业务视图和版本通知。

## 来源增量发布与业务视图复测

来源级发布与视图贡献预计算已经实现。最新结果见 [增量复测报告](INCREMENTAL-REPORT.md)，接口和 owner 记录见 [INCREMENTAL-PHASE.md](INCREMENTAL-PHASE.md)及[worker 审计](../README.md#恢复归档)。

默认 gateway 模式现在是 `incremental`；`--mode published` 保留上轮全量业务投影与 core query 路径，`--mode legacy` 保留每次 full report 路径。四个存储/语言候选没有增加。

常用范围首次按来源建立业务贡献，后续版本只重算变化来源；Rust 的小提交不再全库读取或重建全局事件索引。`contextSince` 使未变化元数据不再读取/重传。整数和结构精确对拍，金额聚合仅容许 `1e-8` 以内浮点舍入误差，实测最大约 `2.05e-11`。

```sh
node --test "experiments/architecture-20261101/node/*.test.mjs" experiments/architecture-20261101/product-server.test.mjs experiments/architecture-20261101/product-incremental.test.mjs experiments/architecture-20261101/source-business-views.test.mjs experiments/architecture-20261101/business-merge.test.mjs
cargo test --locked --release --manifest-path experiments/architecture-20261101/native/Cargo.toml --jobs 2
node --max-old-space-size=3072 experiments/architecture-20261101/product-integration-check.mjs output/architecture-20261102/new-incremental-check
```

按前述 Playwright 环境准备，在**新的输出目录**运行四候选；不要覆盖本次或上次结果：

```sh
node --max-old-space-size=3072 experiments/architecture-20261101/product-benchmark.mjs output/architecture-20261102/new-incremental-run node-sqlite rust-sqlite rust-redb rust-duckdb
node experiments/architecture-20261101/analyze-product-benchmark.mjs output/architecture-20261102/new-incremental-run
```

本轮各 100 次的切换 p95 为 **67/57/54/65 ms**，索引更新到指标显示 p95 为 **175/165/106/138 ms**。四组均逐次验证新数值和修订；82 项检查及原核心恢复/采集回归通过。首次未访问“全部”范围仍约 2.4–2.6 秒，冷服务首屏约 2.9–4 秒，自然自动刷新仍约 60 秒。额度/滚动范围保留原业务算法；长测、容量、生产迁移和 Linux/macOS 适配仍未完成。
# 正式完整冷启动实测

最新结论见 [完整冷启动分段与原型对照](FULL-STARTUP-REPORT.md)。这一轮包含真实来源检查、同步与解析；此前的预建静态索引“三秒”不代表正式完整冷启动。正式版可复用缓存时约 1.29 秒，固定输入需追赶时约 5.56 秒；空库重建约 80 秒。实验复合索引在事实完全一致的情况下，将同探针重建从 82.57 秒降到 52.03 秒。当前没有语言或存储迁移胜者。
