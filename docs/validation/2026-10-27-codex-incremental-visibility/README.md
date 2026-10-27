# Codex 增量可见等待与 TPS：实施与验收

2026-10-27。**入选范围实施与复测完成，3 s 可见等待目标仍未达到。** Codex 后台追加 p95 4.92→3.96 s，today/month 暖查询改善；40 个真实周期的 tokens/TPS 数值与目标帧全部正确，新鲜度全部达标，浏览器 p95 仍为 Codex 6.01 s、ledger-only TPS 3.87 s。规格、入选裁定与后续卡片见[本阶段计划](../../plans/2026-10-27-codex-incremental-visibility-and-tps-plan.md)，完整聚合见 [summary.json](evidence/summary.json)。

本阶段产品新增改动仅在 src/usage-core.js 与 src/usage-store.js：大 home 的完整前缀采集由串行 sync 有界并行，非 all 查询沿已有 timeline 融合分组；没有新依赖、schema、持久证据格式、轮询变更或 TPS 算法变更。旧未提交修改保留，本阶段没有切换生产或提交/推送。

- Main：整理计划、研究 planner/prefix 语义、维护 store/core 文件单写与本地唯一测试槽。
- W1：TPS 发布与可见性研究；交付后派 T1 独立测试。
- W2：剩余读取、month/刷新后 miss 研究；交付后派 I1 归因探针。
- 资源：任务合计≤8 GiB；小夹具 Job1024 MiB，真实副本/全仓/browser Job7168 MiB、heap≤1536 MiB。worker 当前均无运行权。

旧 v6 实施与证据保持只读，所有新证据单独存放。本阶段不操作 tools/out SQLite、不重冻结生产、不重启或迁移正式服务、不提交/推送。

## 执行账本（进行中）

- S0 ACCEPTED：HEAD、工作树和本阶段前像见 evidence/start.json 与 start-status.txt；before 指 v6 最终产品。
- N1 ACCEPTED：保留 raw SHA，仅串行 sync 对大 home 有界启用两个 worker；20 样本后台净收益、完整字节计数及嵌套执行器已验。buffer 增大没有净收益，跳过 eager SHA 无法保留前像证明，均不入选。
- T1 ACCEPTED：native-only 已有/缺计时、ledger-only、同轮 native+ledger、无新字节失败重试，与完整参考逐项对拍；app 慢响应/过期/冻结下仅 TPS 变化也已通过。定向套 115/115，最终嵌套 worker、Q1/T1 和全仓检查见后文。
- I1 ACCEPTED（同步归因）：原首轮仪器失败保留在 output 的 i1-*-baseline；hook-fixed 新轮有模块身份、SQLite 隔离与阶段命中断言，不能把旧轮算作成功。worker 计数另接入，不把线程外读取记成零。
- V1 ACCEPTED：定向反例、同源 A/B 与完整摘要确认 N1/Q1 入选，I2 的跨阶段负向复用被确定性交错否决；未扩大到通用缓存或新持久证据格式。
- I2 按证据不入选：跨阶段复用负向指纹会漏掉外部同 size/mtime 改写；665 MB 读取保留为残余。
- Q1 ACCEPTED：沿已有 timeline 融合 channels/models，保留排序 ties SQL fallback 和冷段边界；不调整投影 key。完整摘要与真实冷归档对拍通过，today/month 净收益已测。
- R1 ACCEPTED：完整报告并发可叠加 worker 已限制为仅串行 sync 开启；Q1 独立复核无新增发现。后续预扫研究只读，不改变本轮冻结源码。
- H1 ACCEPTED（证据完成，延迟部分未达）：产品冻结、A/B、完整门禁、后台增量、各 20 个真实周期、控制样本、保留与恢复核对均完成；G1/G2 分项结论见后文。

## 已确认的研究结论

静止同步修正样本 1,682 ms，10,870 次 readSync / 665,157,164 bytes。metadata 148,037,815 bytes；rename/prescan/file 各 170,361,023 bytes；剩余 6,036,280 bytes 保留原归因。helper 含子调用，不能加总当净收益；这里不是物理磁盘读或最终 p95。

all 修正短测同上下文 63 ms、now+1秒 61 ms；no-op sync 后 1,408 ms，仅 total_changes key 分量变动。当前 key 还负责同连接原始 SQL 写入失效，不能删除它来制造命中。month 查询使用 Q1 独立判断，不外推固定 all 命中为默认刷新速度。

## 同源 A/B 与短测

before 是本阶段前像，after 产品冻结摘要见 evidence/final-product.json；输出 comparison.json 的 63 个公开摘要哈希、逻辑表计数和来源指纹全相等，仅预先剔除 generatedAt/perf.indexedAt/perf.meta.indexedAt。各 20 暖样本：

- 静止同步：p50 1,632→1,656 ms；p95 1,718→1,700 ms，未见实质收益，符合 I2 未实施的范围。
- today：p50 484→359 ms；p95 614→399 ms。
- month：p50 1,527→1,252 ms；p95 1,866→1,275 ms。
- all：p50 53→54 ms；p95 69→71 ms。保留实际数值，不把几毫秒差值当成已证的因果退化或收益。
- Node 峰值 RSS before 975 MiB、after 981 MiB；均运行于 7,168 MiB 整树 Job，不能把 Node RSS 作为整树峰值。

浏览器 smoke 的两个 native-only 追加使用**先已到达、尚无原生映射**的计时，每次另带一个缺计时 turn；tokens 精确 +2,000,214、sampledOutputTokens +1,000,007、模型 n +1。随后 ledger-only 补齐缺计时 turn，tokens 不变、sampledOutputTokens +1,000,007、n +1。双 rAF 重读同时断言 TPS 文本跨阈值与精确统计，native tokens/TPS 同帧约 6.00–6.11 s，ledger TPS 约 3.93–3.97 s。四场均通过、errors 空、关闭 WAL=0、双 tab 完成，原始 1,630 文件恢复核对无差异；人工触发不计正式 60 s 分布，ledger 的 tokens 未变化也不宣称是“新 token 延迟”。

Q1/T1/prefix 集成 23/24 首轮通过，唯一冷归档夹具在 sandbox 硬链接处 EPERM；同源码、同 1,024 MiB Job 解除文件权限限制后 Q1 整文件 3/3 通过。嵌套 executor→prefix worker、live isolation、quiet 恢复与旧 prefix 中段改写后增长拒绝均已通过。完整门禁与正式长测结果见后文；人工 smoke 不计正式分布。

探针输出隔离修正：复用旧 A/B 脚本时私有辅助 before-summary 文件名沿用了旧名；其当前完整内容与旧 after-summary 参考逐字同 SHA-256（2e286638…），三份 summary 的公开哈希也与旧已验收 before/after 一致。后续脚本已把辅助摘要迁入本阶段 output 目录；旧 validation 的记录与原始证据未改写。

## 最终工程门禁与线程归因

- 全仓 Node --test --test-concurrency=1：3,311 项，3,285 pass、25 skip、1 fail，15 分钟；唯一失败是 perf-codex-api.test.js 首个请求的 fetch bad port。随后同源码、同文件 5/5 pass，不改端口测试或产品来掩盖首轮失败。日志见 evidence/full-suite.txt、api-recheck.txt。
- typecheck、lint、format:check exit 0；lint 仍 63 warnings、5 infos。日志见 evidence/type-final.txt、lint-final.txt、format-check-final.txt。
- R1 的并发 worker 上限问题已限制至串行 sync，Q1 独立静态复核无新增发现。完整报告与内存入口不传 parallelPrefix；额外标记仅在临时 home 浅副本中存在。
- hook-workers 实际捕获 2 个线程，每个 694 文件，完整 prefix 合计 1,388 次 / 2,803,376,137 bytes；首尾读取另计，根分桶和 local+workers 总和均校验成功。两个线程的包含时长约 1.07 s，不能相加当墙钟；各 isolate heapUsed 约 12–16 MiB，不把线程 RSS 相加当整树峰值。详见 evidence/worker-accounting-summary.json。
- 冻结 after-code 的 57 个模块在全仓测试后仍逐个摘要一致，见 evidence/frozen-code-check.json。

## 后台增量与保留事实

独立 seed、相同原始冻结来源，各场景 before/after 各 20 次，精确 token 增量与每次新增匹配 TPS 均通过。见 evidence/changed-comparison.json：

- Codex 普通单 turn 追加：p50 4,810→3,900 ms，p95 4,924→3,956 ms，max 4,956→4,000 ms；p95 约改善 19.6%，仍未达到 3 s。
- ledger-only：p50 2,330→2,289 ms，p95 2,374→2,355 ms；主要路径未变，不宣称有实质收益。
- Claude 追加：p50 1,957→1,939 ms，p95 2,006→1,981 ms；主要路径未变，不宣称有实质收益。
- Node 峰值 RSS before 888 MiB、after 872 MiB；各场在 7,168 MiB Job 内独占运行，所有写源场景随后 raw decimal 恢复，1,630 文件 size/mtime 核对为 0 differences。

六条缺源保留记录仍有 14,416 events / 359 samples / 6 owners / 359 dependencies，全部原始行哈希在三轮同步前后不变，见 retained-results.json 与 evidence/retained-run.txt。seed 的 SHA-256 仍 cfc35c20…85bd5，见 evidence/seed-final.json。

## 40 个真实浏览器周期

Codex 普通追加与 ledger-only 各 20 个真实 60 s 周期。每次原生追加含两个 turn（一个计时早已到达、一个缺计时），随后 ledger 补齐；不能把它与后台单 turn 延迟直接相减。每轮都对拍独立受控 duration 数组产生的 n、average TPS、p10、p90，并要求双 rAF 重读中的精确 tokens/sampledOutputTokens/n 与变化的 TPS 文本。完整载荷、帧与时序留在私有 output，公开聚合见 evidence/summary.json。

- **Codex tokens 与 TPS 同帧可见**：p50 5,785 ms，p95 6,008 ms，max 6,034 ms。source write→frame p95 61,983 ms、max 62,564 ms。
- **ledger-only TPS**：p50 3,815 ms，p95 3,865 ms，max 3,922 ms；tokens 严格不变，不计算“新 token 延迟”。source write→frame p95 57,919 ms、max 57,967 ms。
- **G1 未达**：两类 p95 均超过 3 s，分别超 3,008 / 865 ms；max≤8 s 子项通过。后台 Codex p95 也仍超过 3 s；静止、ledger-only、Claude 后台分布满足该目标。
- **G2 通过（本次已测相位）**：40/40 均在当轮实际 interval+5 s 内；固定 65 s 的附加检查也全通过。实际 interval p50 60,001 ms、p95 60,004 ms、max 60,010 ms，未放慢轮询。写入相位逐轮保存，不宣称覆盖任意并发写入相位。
- errors 空；最后双 tab 合并完成约 3,804 ms。WAL 最大采样值 947,632 bytes，关闭后 0；Node 峰值 RSS 1,319 MiB，最低系统可用内存约 13.05 GiB。7,168 MiB Job 加控制侧预留 1 GiB 的资源约束全程保留，没有内存中止；未测 Job 峰值，不把 Node RSS 当作整树峰值。

独立四个真实浏览器人工控制样本（不混入上述分布）：Claude 追加 3,846 ms、Codex 新文件 5,617 ms、普通追加 5,564 ms、ledger-only TPS 3,846 ms，精确增量及目标帧均通过；errors 空、关闭 WAL=0、双 tab 通过。同轮 native+ledger、迟到关联、外提交、rollback、冻结/过期、quota busy 的当前源码回归由 T1 与完整套件覆盖；未把这些小夹具冒称 20 次真实浏览器分布。

## 恢复、清理与剩余范围

最终 1,633 个冻结输入、合计 4,229,909,674 bytes 的逐文件 SHA 全相等，57 个产品模块仍与冻结版本一致；验证进程峰值约 69 MiB。详见 evidence/inputs-final.json。全部写源场景另有 1,630 文件 size/mtime 核对，原 seed 不变。9 份本阶段临时 SQLite 副本已清理，约 6.69 GB；保留 seed、前像、源码快照、原始日志与摘要，见 evidence/cleanup.json。

下一优先级见计划 §12：先验证静止/ledger-only 的独立预扫移除及 rebuilding 时点合同，再对真实 executor 的 reader 更换/修订/key miss 做归因，研究 usage/perf 投影可分别复用的边界。665 MB 静止读取与持续 mutable 历史的完整前缀读量仍是残余；本轮不以删检查或删 total_changes 换命中。

实际冷 archive 夹具已验正确性；真实冷盘性能、2×/4×、长期生产行为以及正式服务切换均未覆盖。当前是本机 1× 暖态证据，不能外推为所有设备保证。
