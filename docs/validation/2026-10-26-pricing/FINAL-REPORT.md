# 模型归并、覆盖与汇率：实施验收

日期：2026-10-26。按[双 worker 计划](../../plans/2026-10-26-pricing-two-worker-implementation-plan.md)，现有 Price-worker-A / Price-worker-B 完成并经主审接受 **21/23 卡（R01–R10、V01–V11）**；没有切换 worker 或启用新的 subagents。

**后端已按 RETENSION 文件窗口分批合入根目录。界面完成隔离联合验收，但尚未合根：UI 主线仍在施工，app/index/i18n 文件窗口未释放。** G1/G2 的完整交互因此目前只在隔离副本通过；G3 后台调度已合根。没有重启正式服务。

## 已交付行为

- 已确认的模型改名、本机 DeepSeek 组和可解析的提供商前缀共用规范身份；模型表、期间比较、时间图、近期价目列表保持一致。按当前官方目录含已有峰谷规则计价，移除两条代理转售价。原始日志、事件模型名及 rollup 写入保持原样，TPS 维度不变。
- 未知模型继续最低适用费率估算。查询费用详情区分最低费率与真正未计价 token 份额；模型覆盖使用近期规范名分母。解释留在主动展开的详情，没有恢复常驻徽标墙或说明框。
- 价格与 FX 独立刷新，保留逐来源尝试、部分失败和报价日期。单行匹配先本地重评，仅处理目标必要来源；网络失败冷却与终态能力重评分开，不顺手全局刷新或取 FX。
- 手动 FX 优先且同值仍锁定，明确恢复自动后保存才解除。状态更新、显式刷新与 409 均保留脏草稿和编辑起点版本；取消不保存。暂停时显式改价或刷新会重建所需快照，普通冻结读取仍固定旧目录。
- 服务就绪后检查到期，此后约每小时检查；成功门槛 24h、失败 1h，可能再等一个检查周期。关闭清理和只读导入禁调度已验。单请求跨异步读取保持同一价目，实时回算和冻结目录各自自洽。

本批没有恢复旧 routes 方案、priced-only 默认或新增模型入口；旧 2026-10-24 A/B 整包仍作废。

## 主审证据

根目录后端集中检查：pricing 39、resolver 10、auto 21、refresh 14、scheduler 7、usage-core 41、timeline 19、三路对拍 10、Claude 11，合计 **172 项通过**；另有根 rollups **27/27**。原子 rename 受沙箱限制的文件，同一测试命令在允许临时文件操作的环境复跑通过。

界面验收采用**真实当前根副本仅应用待合 UI 补丁**，不是把 worker 的整个旧目录当作合入结果：render 65、i18n 14、autorefresh 11、app-summary 21、model-merge 8、三路对拍 10、混币顺序 5，**134/134**。类型检查、lint、受影响范围内 Biome 格式检查通过；闭包 lint 仍有 60 条 warning、4 条 info。上述集合存在重叠，不相加宣称全仓测试数。

最新 RET 增量上的 V10 已复跑：热读、冷读、HTTP 对拍；无新事件的目录 A→B 更新；原 snapshot 与只读导入仍固定 A；原始事件 SHA 不变。实际 HTTP 八组合还覆盖范围、时区与排除来源。RET 独立六文件后端闭包 115 项、冻结/导入复核也另有记录，不以 PRICE 检查代替 RET 最终门禁。

真实浏览器使用独立回环实例 `127.0.0.1:13380`、10 条合成事件和离线价格 fetcher，验证中英文、模型与图例归并、官方条目 Escape/取消、单行终态、手动 FX 与恢复取消、暂停保存、新状态与 409 草稿保留；控制台无错误。修正了复核发现的草稿覆盖、旧 snapshot 状态回读及旧 UI 文案回流。临时服务、home 与浏览器标签已清理。

![离线合成数据验收](../../../output/pricing-official-20261026/reports/V11-browser-models.png)

截图中的 `$2.22` 来自故意设置的合成测试费率，用于证明暂停后确实重算，不代表真实用量或官方单价。

## 可审交付与合入边界

- [最终 UI 窄补丁](../../../output/pricing-official-20261026/reports/UI-reviewed-root-final.patch)：11 文件，102,518 bytes，SHA-256 `62db3edf25d53633b554c1712de4c59a1b547c4dd3cd66379f10a23f8e7b8bbd`；[逐文件前后像](../../../output/pricing-official-20261026/reports/UI-reviewed-root-final.json)。生成时当前根 `git apply --check` 通过，**未应用**。窗口释放后须重核前像并保留 UI 新增变更，不直接覆盖文件。
- [根分批合入记录](../../../output/pricing-official-20261026/reports/root-merged.json)保存已应用后端授权链与哈希；阶段补丁只作证据，不能再重复应用。
- [界面闭包测试](../../../output/pricing-official-20261026/reports/final-ui-closure-checks.json)、[浏览器验收](../../../output/pricing-official-20261026/reports/V11-main-browser.json)、[V11 worker 报告](../../../output/pricing-official-20261026/reports/V11.md)。完整命令日志在同任务目录 `logs/`，已接受卡在 `reports/main-accepted.json`。

根共享 store/rollups 的后续纯格式收口由 RET 负责；UI 补丁不包含 styles、skins、perf-ui 或共享后端源码。合入 UI 后仍需 RET 的冻结/分页和 UI 主线几何门禁，当前截图不代替完整皮肤/分辨率矩阵。

## 剩余工作

R11/R12（G4）保持未开始：没有满足完整官方身份、缓存费率与上下文政策的新候选。具体缺口见[来源证据](../../../output/pricing-official-20261026/reports/official-source-evidence.md)。这不阻塞已验收的前三批，不把第三方零价或读取超时解释成官方免费/无价。

本次未跑全仓测试、完整几何矩阵或真实账单核对，未修改真实配置/日志/数据库，未重启正式服务；公网来源调查与离线合成测试是不同证据。
