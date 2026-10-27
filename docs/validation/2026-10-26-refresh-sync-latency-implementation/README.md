# 刷新延迟优化实施与验收

2026-10-26 开工，2026-10-27 收口。**入选范围已实施并完成评估；延迟目标部分未达。** 未重启或切换生产，未提交/推送。主审与四个原生 subagent 按整文件单写协作，所有本地验证共用唯一执行槽。

## 已实施

- D/P：只读校验复用轮内已提交映射，保留写方副本和回滚隔离；稳定缺源不再持续触发整 home 规划，回归/重命名/失败仍重新校验。
- C/B/L：reader 提供待发布变化摘要，按 response/native 变化增量关联，缓存只保留最小 request 映射；满足条件时定向发布计时，普通富化不再重跑完整同步轮。外部提交或构建期间来源变化会拒绝旧 context 并回退。ledger-only 可触发自动刷新，成功发布后才确认，失败可重试。
- F：quota → today 的第二请求 render 正确值后才结束 busy，仅移动原有状态更新位置。
- 最小 E-1：把完整 all perf 接入既有静态投影，沿用原 key、失效和 structuredClone，没有扩 month 或整响应缓存。

改动在 public/app.js、src/usage-store.js、src/perf-magpie-timing.js、src/usage-core.js、src/server.js、src/usage-executor.js。开工身份见 [start.json](evidence/start.json)，最终身份见 [accepted-source.json](evidence/accepted-source.json)，tracked 产品/测试 diff 见 [implementation.patch](evidence/implementation.patch)，新增 P 回归另存 [测试副本](evidence/refresh-sync-regressions.test.js)。前像在 output/refresh-sync-latency-implementation/preimage，原有用户修改保持。

## 同源 A/B

同一冻结 seed、来源、价目、汇率、时区和 now；独立副本追赶、稳定后计数。每项 20 暖样本，nearest-rank，单位 ms。before 使用本轮开工前像，不直接拿旧 v3 数字计算收益。

| 场景 | before p50 / p95 / max | after p50 / p95 / max |
|---|---|---|
| 静止 sync | 7,828.63 / 8,133.45 / 8,206.46 | 2,629.77 / 2,809.87 / 3,105.68 |
| today 查询 | 456.56 / 480.74 / 483.70 | 467.84 / 504.46 / 513.37 |
| month 查询 | 1,516.88 / 1,544.96 / 1,570.66 | 1,577.05 / 1,679.40 / 1,726.79 |
| all，同 now/修订/精确范围 | 663.15 / 684.79 / 698.23 | 52.35 / 70.46 / 71.07 |

静止 p95 降 **65.45%**，同上下文 all 暖查询降 **89.71%**。today/month 本次分别慢约 4.94%/8.70%，没有改善；未做随机交错 A/B，不能仅据顺序试验确定因果回归。默认刷新后的新修订或变化 now 未必命中 all 投影，不将 70 ms 外推为整轮刷新。

三档各 first+20 warm，**63 份完整业务摘要原始哈希逐条一致**。只移除预声明的 generatedAt、perf.indexedAt、perf.meta.indexedAt；费用、范围、quota、性能、告警与 indexVersion 全部对拍。来源指纹和逻辑表计数一致。API clientFingerprint 有意新增 ledger 分量，版本间字符串不要求相同；status/usage/frozen 收敛和发布边界另有回归与真实周期验证。

见 [summary.json](evidence/summary.json)、[comparison.json](evidence/comparison.json)及 before/after 原始结果。含路径的完整摘要仅存私有目录。时间戳恢复漂移批次排除、存档 ISO 格式恢复和原哈希核对见 [measurement-notes.md](measurement-notes.md)，未扩大白名单。

## 增量和真实等待

后台每类 20 次，单位 ms：

| 场景 | p50 | p95 | max |
|---|---:|---:|---:|
| Claude 追加 | 2,776.69 | 2,909.72 | 2,913.02 |
| ledger-only | 3,243.88 | 3,352.22 | 3,364.56 |
| Codex 追加 | 6,299.65 | 6,887.17 | 7,546.82 |

20 次 native 与 20 次 Claude 每次精确 +1,000,107 total/+1,000,007 output；20 次 ledger 的 tokens 不变，匹配计时当轮发布、dirty 清空。普通成功样本全部只有一次 syncRound，见 [changed-results.json](evidence/changed-results.json)。

Chromium 156、1440×1000、Asia/Shanghai，**一棵服务树连续 21 个真实 60 秒周期**：1 静止、7 Claude、1 Codex 新文件、7 Codex 追加、5 ledger-only。20 次变化均捕获目标 DOM/双 rAF 内重新读取的 frame，15 次 token 增量和 5 次 TPS 变化全部正确，浏览器错误为 0。使用 all 范围避免跨午夜换日。

| 场景 | n | 检查 tick → 目标边界 | 写入 → 目标边界 |
|---|---:|---|---|
| Claude | 7 | 4,954–5,155 ms | 56,609–65,033 ms |
| Codex 新文件 | 1 | 8,506 ms | 63,324 ms |
| Codex 追加 | 7 | 8,096–8,528 ms | 59,550–63,482 ms |
| ledger-only | 5 | 5,112–5,389 ms | 56,683–57,086 ms |

各子组不足 20，不据混合 p95 宣称逐场景通过。20 个实际 tick 间隔 p50 60,000、p95/max 60,013 ms。G1 已有超过 max 8 s 的反例。G2 一条 Claude 65,033 ms，对应实际周期 59,992 +5,000 ms，**超 41 ms**；其它本次变化在预算内，不舍去边界样本。这里是 DOM/双 rAF 观测边界，未测物理显示器绘制；静止旧值不计作新值。

HTTP 初始化后的新页面 3,126 ms（n=1，服务已预热）；最后双标签页新页面与 month 筛选汇合 5,583 ms（n=1，非各请求独立分位数）。原始数据见 [browser-final-results.json](evidence/browser-final-results.json)。

**受控 quota 纠正，before/after 各 n=1，同日范围。** 两端均从 0.00M → 1.00M，精确增量正确。旧版提前结束 busy 到目标帧空窗 **386 ms**；新版 **0 ms**，busy 持续到第二次 today/skipCheck 请求 render 完成。相关请求成功、errors 空；两场及恢复检查最终退出码均 0，见 [quota-final-exits.json](evidence/quota-final-exits.json)。metadata 变换是合成分支，不推断自然发生频率；早期 780/369 ms 样本分别保留，不冒充最终配对结果。

## 正确性、资源和门禁

六条真实缺失来源的 **14,416 events、359 samples、6 owners、359 dependencies**，追赶与稳定轮前后逐行哈希一致，见 [retained-results.json](evidence/retained-results.json)。旧前像 P 反例已持久重收：stable missing paths must not re-enter Codex planning，2≠0，预期 exit 1；新实现相应反例通过。C/B 两项发布交错发现经修复、运行反例和独立审查关闭。reader 重置/半行、迟到映射、失败无新字节重试、跨 worker、冻结和 imported runtime 均有回归。

全仓首轮 **3,301 项：3,274 通过、25 跳过、2 项 fetch bad port 失败**。两项在进入 API 逻辑前被 Node 拒绝，随后同源码整个 perf-codex-api 文件 **5/5 通过**；保留首轮失败，不改称一次全绿。相关 C/B/P 118/118、L/F 58/58。最终 typecheck、lint、format:check 退出码 0；lint 63 条告警未自动修复。全仓后的唯一产品差异是一条 JSDoc，去除它后的 SHA-256 精确等于全仓受测源码，见 accepted-source.json。

任务合计 **8 GiB**：真实数据/全仓/浏览器树 Job 7,168 MiB、heap≤1,536 MiB，控制侧约 1 GiB；小夹具 Job 1,024 MiB，运行串行、最多两 tab。正式浏览器 Node maxRSS **1,247.78 MiB**，系统可用最低 **13.67 GiB**，不冒称 Job/Chrome 实测峰值。30 秒 WAL 采样曾有 32,992 bytes，关闭前后均为 0，不宣称所有时刻恒为零。

## 验收裁定和后续

- **G1 未达**：Codex 约 8.1–8.5 s，max 反例明确，各浏览器子组也不足 20。
- **G2 边界未通过**：一次超对应预算 41 ms，不四舍五入为全部通过。
- **G3 部分达到**：静止/Claude 的 20 次 p95≤3 s；ledger/Codex 未达，max 均在 8 s 内。
- **G4/G5/G6 本轮通过**：逐文件只读整映射复制为零，无提交轮每张映射至多解码一次；静止无重规划、前缀读取零；普通富化不重复完整 round。写方副本、必要稳定窗口和异常回退保留。
- **G7 本轮预算遵守，长期未证**：有 21 周期资源和 WAL 收敛证据，没有任意时长稳定性或 Job 实测峰值保证。
- **G8 本轮对拍和发布回归通过**：业务、保留事实、发布/失败恢复与冻结边界有证据，真实冷段性能和规模增长未测。

下一优先级：**缩小 Codex 变化的规划范围 → 归因并复用同轮重复首尾探测 → month 与刷新后 miss**，见 [remaining-scope.md](remaining-scope.md)。native 追加仍约 1,389 次前缀取证/2.803 GB；静止其它同步读取约 665 MB，未经归因不全部叫作全文前缀存证。分块/Merkle、通用缓存、独立读进程、轮询及计价/归档/UI 扩展继续暂缓。

脚本见 [probes/README.md](probes/README.md)，独立审查见 [workers/W4-final.md](workers/W4-final.md)，S0 契约与分卡过程见 [execution-log.md](execution-log.md)。旧 v3 证据只读。未测实际封存后冷热、2×/4×、长期生产和任意故障压力；当前副本 0 archives。未自动部署。
