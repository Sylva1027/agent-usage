# 本地汇总原型整合验收

将已验证的隔离原型移入现有 Node 项目，保持全部来源、计价、周期与接口语义。没有把 Rust 加入产品依赖，没有访问 Magpie、套餐上游或 `tools/out` 的 SQLite，也没有切换端口 3765 的运行服务。用户选择先保存工作树检查点 `bd0d571`，再单独提交本轮优化；并行 UI 任务的改动保留未提交；UI 测试只单独提交一处消除重绘竞争的测量修正。

## 实现范围

- HTTP 服务保存轻量状态；重型索引和统计使用可退出的独立计算进程。计算进程空闲 200 ms 后退出，224 MiB old-space、4 MiB semi-space，计价 memo 8/16 MiB；保留既有故障、超时、历史归档和冻结接口。
- 索引旁的 `.summaries.sqlite` 保存最多 32 个汇总。完整来源指纹、配置、价目、索引发布状态及统计时间边界共同控制复用，重启后也能恢复。正常无新增刷新只检查本机输入和已发布状态，不运行 sync 或启动计算进程。外部写库会使汇总失效。
- 性能投影按需读取，样本逐行查询，批量写样本复用 statement；DSH 逐帧逐行消费，并用两遍薄 header 扫描保留晚到 header、损坏帧与告警的原语义。
- 缓存命中使用共享公式推进比较流速、模型活动期与额度时钟。滚动最近一天绕过结果缓存；完整周期边界、未来事实和跨日使结果失效。缓存带版本，损坏 JSON 可重建；计算期间输入或 publication 变化时不缓存该结果；缓存写失败不丢弃已算出的响应。
- 冻结仍使用私有一致性备份，冻结读取也由可退出进程计算。关闭、淘汰、备份后故障的数据库与归档片段清理都有回归验证。

## 真实数据测量

使用同一份冻结本机输入：6 类来源、1,753 个文件、3,520,947,065 字节。所有服务只监听随机回环端口，关闭外部 fetch。独立 Windows 采样器每约 100 ms 合计同一时刻服务及所有活跃计算进程的工作集和私有提交；不包含浏览器、采样器、控制器或独立参考引擎。

完整服务的实测结果为：

- 首次空库建索引并返回今日：**168.20 秒**，总工作集峰 **368.82 MiB**，总私有提交峰 **349.72 MiB**；紧接着相同范围命中 **108.57 ms**，没有启动计算进程。
- 真实 `schema 23 + tps-v3` 库升级：**57.52 秒**，峰 **303.43 / 281.30 MiB**；后续命中 **107.11 ms**。使用此前由完整 v3 引擎实际生成的前像，没有篡改版本字段模拟迁移。
- 最终完整服务 warm 场景：峰 **411.10 / 398.60 MiB**，包括今日、本月、全部、7d、无当前 5h 的 409、冻结、冻结再读、重启及五次无新增读取。今日首轮同步及查询 **10.79 秒**；未缓存本月 **4.13 秒**、全部 **2.94 秒**、7d **2.23 秒**。同范围命中 **99.45 ms**，重启后命中 **122.76 ms**，五次无新增 **91.31–103.48 ms**，均不启动计算进程。
- 最终 warm 轮的十秒待机有 86 个采样，工作集中位 **92.21 MiB**、私有提交中位 **80.04 MiB**。前一完整 warm 轮待机中位 **122.26 / 145.87 MiB**、峰 **415.41 / 402.37 MiB**。短时待机有 GC 与 OS 驻留差异，因此使用约 **92–122 MiB 工作集**描述本次完整服务状态，不沿用精简原型的 87.8 MiB 数字。

原型的真实 60 轮分钟长测已经完成，见[前轮记录](../2026-10-29-local-summary-endurance/README.md)。本轮没有重新跑一小时；补测完整生产接口、重启、冻结与迁移，另外使用可控时钟和真实文件追加的回归检查无新增复用及新增发布。不能把前轮的长测峰值当成本轮完整服务的峰值。

上述时间是本机单轮墙钟，不是跨机器 SLA。各试验配置保存对应源码哈希；cold/migration 使用流式计算内核的同一份源码，最终缓存审查修正另外通过 final warm 和定向测试。所有目标测量均低于 512 MiB，没有抬高预算。

## 统计一致性

参考引擎来自本轮优化前保存的完整工作树，独立以 1024 MiB old-space 构建，仅用于 oracle，不是目标运行配置。完整比较 `summary`、`metadata`、`periodComparison`、`pricingCatalog`、`quota`，仅规范化对象键，不删统计字段、改数组顺序或用零替代缺失。

cold 和 migration 均与该参考引擎独立从空库建立的结果逐字段相等，SHA-256 为 `b623adf2449000152c92a331bff9f37b21fe3688fbded93e43400498c33cf357`。同一个 settled seed 的今日、本月、全部、7d 也分别与优化前引擎对拍；live、freeze、frozen、restart-hit、无新增命中的今日哈希均为 `f62f12ce010bcdbdba166b4eb746ac440cbadbba98b8c0ef8d637ee5c18e9198`。

fresh 重建与旧 settled seed 本来就有性能事实差异，二者没有互相冒充参考。实际当前没有 5h 窗口，409 是预期结果；5h/7d 的来源与边界以及三个比较框体继续由已有三路径和 API 测试验证。

## 检查与复跑

定向检查覆盖流式 DSH、投影所有权/懒加载/损坏版本、statement 复用、执行器退出与恢复、价格隔离、周期对比、冻结清理、HTTP 指纹、缓存时间推进与失效。最终检查结果追加在本文件末尾。

原始证据在忽略目录 `output/local-summary-adoption-20261029/`，包括每轮的 result、events、memory JSONL、完整统计响应及独立 oracle 结果；未提交用户原始日志或实验数据库。保留私有冻结目录时可在仓库根复跑：

```powershell
node docs/validation/2026-10-29-local-summary-adoption/probes/benchmark.mjs cold adoption-cold
node docs/validation/2026-10-29-local-summary-adoption/probes/benchmark.mjs migration adoption-migration
node docs/validation/2026-10-29-local-summary-adoption/probes/benchmark.mjs warm adoption-warm-final
node docs/validation/2026-10-29-local-summary-adoption/probes/reference.mjs
foreach ($preset in @('today', 'month', 'all', 'quota_week')) {
  node docs/validation/2026-10-29-local-summary-adoption/probes/reference.mjs $preset
}
```

重复同名试验前应归档旧 memory JSONL，采样器采用 append；私有输入或 before 源码被清理后不能仅靠仓库恢复本机语料。

本轮按 pinned-workers 复用三名 worker，创建参数均显式为 `model=group/deepseek`、`reasoning_effort=max`：分别处理数据读取/审查、计算进程/故障测试、Rust 实验；主代理负责汇总缓存、HTTP 整合、真实服务测量和最终验收。这是可核查的派发参数，不认证物理后台模型。

## Rust 的实际收益与判断

独立 Rust release 实验见[实验源码与结果](../../../experiments/rust-parsing-20261029/README.md)。160 个真实 DSH 文件，约 626 MB 解压内容；三轮交替暖运行中位，正式 V8 参数下纯解压与完整 JSON 解析由 Node **4.31 秒 / 173.02 MiB 工作集**降至 Rust **2.90 秒 / 48.20 MiB**，约 **1.49x**。Node 调 Rust helper 为 **2.94 秒**，进程树峰约 **111.43 MiB**。

包含递归语义摘要与 SHA 的另一基准为 3.70x；它主要放大摘要遍历差异，不能拿来声称解析或整个项目提速 3.70x。Node 使用真实 async generator，Rust 使用同步循环，尚未分离语言与 reader 调度成本。两种模式的逐文件计数、聚合、告警一致，摘要模式的全部 digest 也一致；主代理另复验坏帧、坏 JSON 和 UTF-8 合成夹具。

当前证据支持继续考虑局部原生计算模块的内存收益，尚不支持整体换栈。实验依赖本机 zstd 1.5.7 DLL，没有增加安装、编译或跨平台打包要求到正式服务。

## 限制

512 MiB 是本机约 3.52 GB 数据的采样验收，不能保证任意历史规模、多客户端并发和任意单个文件大小都不超限；DSH 仍会逐遍持有完整压缩 Buffer，精确分布仍随样本量占用内存。未重跑多日/跨日长测，未验证 Rust 生产接入或跨平台打包；正式运行服务需要另行切换到已提交代码。

## 最终工程门禁

- 最终生产代码的全仓运行：3,510 项，3,483 通过、25 跳过；剩余失败来自同一个 UI 长数值用例及其父测试。MutationObserver 实证注入的超长数字被待处理的图表重绘恢复为 `0.22M`，并非 CSS 溢出失效。仅将注入与截断测量放在同一次浏览器求值，不修改页面；修复后 UI 套件 19/19 通过，复验结果见 `output/local-summary-adoption-ui-final.txt`。
- 缓存、HTTP 和外部 publication 回归 41/41 通过。执行器、WAL、冻结计价及失败清理均通过对应测试；先前 Edge 截图收敛用例单独复验 2/2 通过。
- 类型检查、格式检查与 `git diff --check` 通过；lint 退出 0，仍有原有 65 warnings / 9 infos。
- Rust 两种模式的坏帧/坏 JSON/UTF-8 夹具经主代理复验一致，均为 6 条记录、2 条告警；摘要 hash 与实验记录一致。
