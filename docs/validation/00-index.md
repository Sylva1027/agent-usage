# 验证记录索引

更新：2026-11-13。结果绑定其日期、源码版本、输入与环境；历史失败和跳过不由后来的局部通过覆盖。仍保留的截图、JSON、日志、源码哈希与测试夹具保持原路径；分享功能的临时验证产物已清理。当前任务见[02](../02-tasks.md)，实验结论见[归档](../archive/2026-11-11-experiments/README.md)。

## 最近完成

- [分享图片：现行规则与正式回归入口](../plans/2026-10-03-mobile-share-card-consolidated-plan.md)
- [工作区清理与文档整理](2026-11-11-workspace-cleanup.md)
- [精简、测试修复、格式与 lint 清理](2026-11-11-simplification.md)
- [Windows 实际启用](2026-11-11-activation/README.md)

## 独立记录

- [工作区清理与文档整理](2026-11-11-workspace-cleanup.md)
- [项目精简实施记录](2026-11-11-simplification.md)
- [UI 几何稳定性施工验收](2026-10-26-ui-geometry-stability.md)
- [2026-10-02 皮肤系统实施前保存点](2026-10-02-pre-skin-checkpoint.md)
- [2026-10-01 合并检查与文档整理](2026-10-01.md)

## 日期证据目录

| 日期与目录 | 入口 |
| --- | --- |
| 2026-11-11-project-cleanup | [全项目测试产物清理](2026-11-11-project-cleanup/README.md) |
| 2026-11-11-activation | [Windows 实际启用记录](2026-11-11-activation/README.md) |
| 2026-11-01-tps-extraction | [TPS 研究封存与无 TPS 版本验收](2026-11-01-tps-extraction/README.md) |
| 2026-11-01-no-tps-cutover | [0.8.5 本机切换与发行验收](2026-11-01-no-tps-cutover/README.md) |
| 2026-10-31-receive-clock-tps | [接收时钟修复与验收](2026-10-31-receive-clock-tps/README.md) |
| 2026-10-30-visible-output-tps | [本地实际输出速度采集验收](2026-10-30-visible-output-tps/README.md) |
| 2026-10-30-tps-repair | [TPS 展示修复验收](2026-10-30-tps-repair/README.md) |
| 2026-10-30-release | [v0.8.0 发布验收](2026-10-30-release/README.md) |
| 2026-10-30-receive-tps | [原生 TPS token 窗口修正](2026-10-30-receive-tps/README.md) |
| 2026-10-30-quota-recovery | [当前 7d 边界恢复验收](2026-10-30-quota-recovery/README.md) |
| 2026-10-30-node-performance | [Node 性能优化正式接入验收](2026-10-30-node-performance/README.md) |
| 2026-10-29-local-summary-adoption | [本地汇总原型整合验收](2026-10-29-local-summary-adoption/README.md) |
| 2026-10-27-q2-q3-projection | [Q2 / Q3 用量投影复用验收](2026-10-27-q2-q3-projection/README.md) |
| 2026-10-27-codex-refresh-followup | [预扫移除、状态切换与真实读侧投影复测](2026-10-27-codex-refresh-followup/README.md) |
| 2026-10-27-codex-incremental-visibility | [Codex 增量可见等待与 TPS：实施与验收](2026-10-27-codex-incremental-visibility/README.md) |
| 2026-10-26-refresh-sync-latency-reeval | [历史保留完成后的刷新性能复测](2026-10-26-refresh-sync-latency-reeval/README.md) |
| 2026-10-26-refresh-sync-latency-implementation | [刷新延迟优化实施与验收](2026-10-26-refresh-sync-latency-implementation/README.md) |
| 2026-10-26-pricing | [官方模型价、覆盖与 FX 执行记录](2026-10-26-pricing/README.md) |
| 2026-10-24-pricing-implementation | [价目实施：派工与独立验收](2026-10-24-pricing-implementation/README.md) |
| 2026-10-23-tps-remediation | [TPS 审计修复执行账本](2026-10-23-tps-remediation/README.md) |
| 2026-10-22-history-retention | [历史保留实施账本](2026-10-22-history-retention/README.md) |
| 2026-10-21-workbuddy-implementation | [WorkBuddy 数据源接入验收（2026-10-21）](2026-10-21-workbuddy-implementation/README.md) |
| 2026-10-21-wal-growth | [WAL 异常增长：现场记录](2026-10-21-wal-growth/wal-growth-diagnosis.md) |
| 2026-10-21-tps-scope-audit | [TPS 计量范围调查](2026-10-21-tps-scope-audit/README.md) |
| 2026-10-21-tps-measurement-correction | [TPS 计量修订执行账本](2026-10-21-tps-measurement-correction/README.md) |
| 2026-10-21-release | [2026-10-21 v0.7.0 发布验收](2026-10-21-release/README.md) |
| 2026-10-21-model-speed-implementation | [模型速度视图实施账本](2026-10-21-model-speed-implementation/README.md) |
| 2026-10-21-codex-tps-followup | [Codex TPS 后续改进执行记录](2026-10-21-codex-tps-followup/README.md) |
| 2026-10-03-skin-palette-redesign | [皮肤配色重设计 — 运行记录（runId 20261003T185748）](2026-10-03-skin-palette-redesign/README.md) |
| 2026-10-03-release | [2026-10-03 v0.6.0 发布验收](2026-10-03-release/README.md) |
| 2026-10-02-title-material | [2026-10-02 · 标题框体表面反光修复](2026-10-02-title-material/README.md) |
| 2026-10-02-skin-face-centering | [2026-10-02 · 页面两侧立绘随留白居中](2026-10-02-skin-face-centering/README.md) |
| 2026-10-02-skin-dialog-refinement | [皮肤视觉修改：0—R8 验证](2026-10-02-skin-dialog-refinement/README.md) |
| 2026-10-02-model-character-skins | [模型角色皮肤 P0 基线 + P1 骨架验证](2026-10-02-model-character-skins/README.md) |
| 2026-10-02-frame-spotlight | [主界面框体 SpotlightCard：实施与专项验证](2026-10-02-frame-spotlight/README.md) |
| 2026-10-01-title-centering | [2026-10-01 标题最终居中验收](2026-10-01-title-centering/README.md) |
| 2026-10-01-release | [2026-10-01 v0.5.0 发布](2026-10-01-release/README.md) |
| 2026-10-01-refresh-off | [2026-10-01 关闭刷新后保持高度](2026-10-01-refresh-off/README.md) |
| 2026-10-01-refresh-dropdowns | [2026-10-01 加载圈与下拉框验收](2026-10-01-refresh-dropdowns/README.md) |
| 2026-10-01-dashboard-feedback | [2026-10-01 模型列表与连续顶部框体反馈修正](2026-10-01-dashboard-feedback/README.md) |
| 2026-10-01-dashboard-corrections | [2026-10-01 看板九项修正验收](2026-10-01-dashboard-corrections/README.md) |
| 2026-10-01-claude-pricing | [Claude 价格与现有来源计费验收](2026-10-01-claude-pricing/README.md) |
| 2026-09-30-ui-pricing | [Agent Usage：11 / 17 / 18 重试验收](2026-09-30-ui-pricing/README.md) |

以上为工作区现存的已跟踪记录；以下补充仅在本机保留的验证目录。旧历史文档指向已清理或缺失的附件时，保留原路径文字，不把它们表示为仍可打开的证据。

## 本机保留的验证材料

下列 35 个目录被 Git 忽略，保留于本机，克隆仓库或下载源码包不会包含它们。原报告、截图、原始记录和生成报告不改写；其状态仅代表记录日期。

| 日期与目录 | 本机入口 |
| --- | --- |
| 2026-11-01-dsh-standard-plugin | [DSH 标准 TPS 插件安装验收](2026-11-01-dsh-standard-plugin/README.md) |
| 2026-10-31-official-codex-passive-tps | [官方 Codex 被动采集能力核验](2026-10-31-official-codex-passive-tps/README.md) |
| 2026-10-31-codex-dlc-gaps | [官方 Codex 被动日志 DLC 接入验收](2026-10-31-codex-dlc-gaps/README.md) |
| 2026-10-31-chatgpt-subscription-tbt | [ChatGPT 订阅 TBT 实测与 DLC 结论](2026-10-31-chatgpt-subscription-tbt/README.md) |
| 2026-10-30-node-production | [Node 优化正式接入与现场核验](2026-10-30-node-production/README.md) |
| 2026-10-29-tps-cutover | [TPS v4 与 Codex release 本地切换](2026-10-29-tps-cutover/README.md) |
| 2026-10-29-native-generation-implementation | [原生生成计时实施记录](2026-10-29-native-generation-implementation/README.md) |
| 2026-10-29-local-summary-prototype | [本地轻量服务隔离原型实测](2026-10-29-local-summary-prototype/README.md) |
| 2026-10-29-local-summary-optimization | [隔离原型：降低计算峰值与无变化跳算](2026-10-29-local-summary-optimization/README.md) |
| 2026-10-29-local-summary-endurance | [隔离原型：冷建库、方法迁移与真实分钟长测](2026-10-29-local-summary-endurance/README.md) |
| 2026-10-29-local-generation-implementation | [Codex 并排包、DSH 全生成与 TPS v4 本地实施验收](2026-10-29-local-generation-implementation/README.md) |
| 2026-10-29-local-generation-adoption | [Codex 安装接入与 DSH 本地日志核验](2026-10-29-local-generation-adoption/README.md) |
| 2026-10-29-installed-generation-validation | [Codex 普通安装与 DSH 官方 usage 核验](2026-10-29-installed-generation-validation/README.md) |
| 2026-10-29-codex-release | [Codex release 并排包与 helper 验收](2026-10-29-codex-release/README.md) |
| 2026-10-28-native-generation-timing | [原生生成计时证据记录](2026-10-28-native-generation-timing/README.md) |
| 2026-10-28-generation-tps | [生成 TPS 实施验收](2026-10-28-generation-tps/README.md) |
| 2026-10-27-performance-production-cutover | [本轮性能优化生产切换记录](2026-10-27-performance-production-cutover/README.md) |
| 2026-10-27-codex-subscription-tps | [浏览目录](2026-10-27-codex-subscription-tps/) |
| 2026-10-21-tps-layout-comparison | [浏览目录](2026-10-21-tps-layout-comparison/) |
| 2026-10-20-tps-detail-panel-samples | [浏览目录](2026-10-20-tps-detail-panel-samples/) |
| 2026-10-20-claude-model-identity | [Claude Code 模型身份验收（线路模型）](2026-10-20-claude-model-identity/README.md) |
| 2026-10-20-claude-code-source | [Claude Code 数据源验收](2026-10-20-claude-code-source/README.md) |
| 2026-10-14-codex-zstd | [Codex 压缩日志兼容验收](2026-10-14-codex-zstd/README.md) |
| 2026-10-12-previous-7d | [上一个7d验收](2026-10-12-previous-7d/README.md) |
| 2026-10-12-previous-5h | [上一个5h验收](2026-10-12-previous-5h/README.md) |
| 2026-10-12-codex-work-billing | [GPT-6.1 Sol：Codex / ChatGPT Work 计费验收](2026-10-12-codex-work-billing/README.md) |
| 2026-10-09-refresh-performance-fix | [浏览目录](2026-10-09-refresh-performance-fix/) |
| 2026-10-09-refresh-performance | [浏览目录](2026-10-09-refresh-performance/) |
| 2026-10-08-tps-ui-restructure | [浏览目录](2026-10-08-tps-ui-restructure/) |
| 2026-10-04-perf-metrics | [浏览目录](2026-10-04-perf-metrics/) |
| 2026-10-03-skin-palette-candidates | [皮肤配色诊断与候选报告（2026-10-03）](2026-10-03-skin-palette-candidates/README.md) |
| 2026-10-03-documentation-cleanup | [2026-10-03 文档融合与归档](2026-10-03-documentation-cleanup/README.md) |
| 2026-10-03-detail-spotlight | [详情进度条与面板共享光晕](2026-10-03-detail-spotlight/README.md) |
| 2026-10-02-palette-studio | [皮肤配色工作台（临时工具）验证记录](2026-10-02-palette-studio/README.md) |
