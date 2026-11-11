# 来源增量发布与业务视图预计算（2026-11-02）

> 历史材料，2026-11-11 归档。本文命令与状态属于原记录日期；源码及恢复方法见[归档入口](../README.md)。

本轮仍为原来四候选的隔离实验；Windows 优先，正式 src/public 和活动库不改，不部署。原始数据、页面资源、日期及百样本口径沿用 WINDOWS-REPORT.md。旧代码/二进制存于 output/architecture-20261102/incremental/before，旧结果保留 windows-matrix。

## 实施目标

1. Rust 持久提交只写变化来源并返回修订，不再读取全库 State。发布态按来源共享不可变准备结果，只转换/校验变化来源。快照/启动/显式 report 允许全量物化。
2. changes 增加可选 contextSince=N。该参数仅压缩响应：context 自 N 后未变化则省略；全量/reset/snapshot 总返回 context。不带参数保持旧协议。版本/来源/context 必须同一读视图；未知历史保守返回完整 context。
3. 新默认 incremental 网关由来源级业务贡献合成完整业务视图，数据变化后只重算变化来源。普通范围不再重复调用完整 core query；事实来源、整数统计与业务口径仍对拍。原 published 模式和 legacy 模式保留用于前后诊断，不新增技术候选。

## 验收

删除/空替换/重复会话/跨来源同会话、渠道别名/模型别名、费用及其覆盖率、排除 home、前周期、滚动范围/日期边界、价目变化、冻结、失败/CAS、重启必须保持正确。整数/结构精确比较；费用相加只允许明确记录的浮点舍入误差（小于显示精度），不可丢字段或改变资格规则。

四候选继续使用同一份 159610 条真实历史和原页面，各测3次冷服务、100次切换、100次重载、100次小来源版本到精确指标可见。自然60秒自动检查单列；本轮不改正式页面的检查周期，也不声称消除了这段等待。

## 单写任务卡

- A：整个 native/src 和 native/tests，负责持久化增量返回、不可变来源发布及 native contextSince；不改 Cargo 依赖和其他目录。
- B：node/，负责 contextSince 与必要轻量读路径及测试；不改其他目录。
- C：新 business-merge.mjs 与对应测试，负责来源业务贡献的合成；接口由主代理给出，不改 publisher/server/compat。
- Main：来源业务贡献预计算、publisher/server 接入、共享集成、测量、构建与报告；各owner按卡完成后审查再续卡，性能串行执行。

## 已完成

A1/A2、B1/B2、C1/C2 均在审查和局部修正后验收，三名 worker 已关闭。Node/共享层49项、Rust release/all-features33项，共82项检查通过。四后端真实历史及新增/替换/清空来源对拍、原核心恢复和Codex/DSH采集回归均通过。

四候选完成各3次冷服务、100次切换、100次重载、100次小来源版本到原页面精确数值显示，另有默认时钟冻结/恢复/自然自动检查。原始结果位于 output/architecture-20261102/incremental，结论和剩余边界见 [INCREMENTAL-REPORT.md](INCREMENTAL-REPORT.md)。

旧 published / legacy 模式保留。新 incremental 模式的业务视图拥有基础汇总，读请求不再调用完整core query；独立对拍验证这些字段。普通常用范围和自定义日期已接入，额度/滚动及未支持named recent保留原算法。首次未访问视图仍按需建立，尚未持久化为重启后的即读视图。
