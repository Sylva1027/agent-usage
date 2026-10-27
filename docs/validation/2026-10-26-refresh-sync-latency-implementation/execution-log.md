> 历史执行记录快照，保存 S0 契约与分卡过程；最终状态以 README.md 为准。

# 刷新延迟优化实施记录

2026-10-26，用户“开工”后启动 v4 §9。HEAD、产品摘要及未提交状态见 evidence/start.json 和 start-status.txt；目标文件前像位于 output/refresh-sync-latency-implementation/preimage。旧 reevaluation 证据保持只读。

## S0 协作契约

- Main 独写 usage-store；W1 独写 ledger 读取器；W2 独写 core/server/executor 接线；W3 独写 app；W4 只做独立反例与审查。具体文件范围沿用计划 §9.1。
- W1 保留 read(): Promise<boolean>。新增 pendingChanges() 返回 {revision, responseIds: Set<string>, reset: boolean} 的独立快照，acknowledge(revision) 只确认对应未变修订。新增有效变体累积 responseIds；截断/替换/消失/回归置 reset，直到确认。无效行、重复行和未完成尾行不伪造有效 ID；失败后无新增字节仍保留 pending。reset 保守重关联，不擅自删除已导入历史证据。
- W2 新增 core 的 buildMagpieTimingFingerprint(options)：读取 homeDir/.config/magpie/usage.jsonl 的路径、身份、size/mtime 签名，缺失返回空串。保持原 buildUsageFingerprint 的来源语义与计数。
- Main 成功完成关联及性能发布后才写 store_meta.perf_magpie_ledger_fingerprint；perfPublicationState() 与 sync 返回 status 增加 magpieTimingFingerprint。签名在 read 前取得，避免把晚到追加误确认为已发布。失败保留旧确认；无效或不匹配行成功读完也确认。W2 的 clientFingerprint 组合 observed（status）或 acknowledged（usage/frozen）签名；worker 传递该字段，skipCheck 与冻结不偷读新的确认值。
- 读取器 pending 在发布后确认；证据已导入但派生发布失败时仍重试。native projection/ownership 变化也会触发重关联，保留 foreign evidence 优先级。
- 不新增 schema、通用事件/缓存框架或临时产品开关。W2 先准备与测试接线设计，C/B 通过后再启用。
- 本任务合计 8 GiB：唯一测试槽由 Main 持有；小夹具 Job1024 MiB，真实数据/全门禁 Job7168 MiB、Node heap≤1536 MiB。worker 当前均不得启动测试、npm、基准或浏览器。

## 进度

- S0：完成接口与所有权冻结，记录前像。
- D/P、L-0、L-准备、F-1、R-1、C/B/L-1：已独立验收。C/B 118 项相关用例通过；L/F 合并 58 项通过（本地临时原子 rename 场景须提权，仍受 Job1024 MiB 限制）。独立审查两处发布交错问题已修复并有运行反例通过；C 缓存只保留最小 request 映射，不常驻完整 rollout 投影。
- V2：同源 before 20 个静止同步和三档各 20 暖查询已完成；C/B 后短测业务摘要相同，all 查询的 perf 仍约 0.61 s，进入最小 E-1。
- E-1：已接受。仅把完整 all perf 接入既有静态投影；文件所有权已归还 Main。固定 now、同修订和同查询上下文的 all 暖查询 p95 从 684.79 降到 70.46 ms；不得外推为所有默认刷新都命中。
- H-1：源码已冻结，正式 A/B 与三组各 20 次增量完成；21 个真实浏览器周期进行中。静止同步 p95 8,133.45 → 2,809.87 ms，三档完整业务摘要原始哈希逐条相同。今天/月查询无收益。见 [measurement-notes.md](measurement-notes.md) 的身份修复、异常排除和门禁口径。

各 20 次后台同步：Claude 追加 p95/max 2,909.72/2,913.02 ms；ledger-only 3,352.22/3,364.56 ms；Codex 追加 6,887.17/7,546.82 ms。后两者未达到 G3 的 p95≤3 s 候选目标，继续记录残余，不扩大实施范围。
