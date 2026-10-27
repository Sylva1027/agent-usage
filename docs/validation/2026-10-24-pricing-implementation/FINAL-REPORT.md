# A/B 价目联合验收

更新：2026-10-25。**G1/G2/G3在隔离副本通过，产品尚未合回共享源码；G4未完成。** A原交付的实际缺陷已修正，A01–A11接受，A12行级刷新保持关闭。用户指定的两位worker均已停在卡间。

交付为 [A+B补丁](../../../output/pricing-implementation-20261024/pricing-AB-reviewed.patch)和[37文件前后像清单](../../../output/pricing-implementation-20261024/pricing-AB-reviewed-files.json)。最终源码固定在 `output/pricing-implementation-20261024/reviews/G2-final`，基于包含当时未提交工作的308文件baseline，不是旧HEAD。根目录 `git apply --check --whitespace=nowarn`通过，未应用。早期B-only补丁是历史里程碑，不能再与新补丁叠加。

## 已接受行为

- 普通缺价模型可手动补价；新增/移除后清单即时更新。子弹窗应用只合并草稿，取消/Escape不执行撤销；保存携带独立editVersion，409保留草稿。
- 明确完整线路键精确选价，两条同canonical线路互不覆盖；canonical不借费率或政策，既有免费规则保持优先。新条目无适用Fast证据时保持未定价。
- 缺适用费率不再借全局最低价；全未知null、免费0、混合只合计已定价部分。已有价目但token明细缺失的模型内minimum假设保留，minimum仍是priced子集。
- schema3稀疏modelOverrides/routeOverrides保存、原子失败保护与字段撤销通过；省略routes保留，显式空对象只可移除无底值的手动条目。自动底层继续更新，撤销取最新有效底值。
- 费用版本稳定包含FX、模型/线路绑定、费率、政策及输出来源，纯核验日期不改变费用版本。修复目录规范化字段顺序导致的版本漂移，并同步执行器展示日期。
- 原始完整model经过解析、索引和查询不丢线路；实际HTTP改价后live/full/dashboard一致更新，旧冻结保持旧目录。冷段、原日志消失、已发布bundle恢复及按C重算通过，不增加数据库字段或重构rollup。
- 价格与FX到期独立，成功24h、失败1h；服务启动和每小时后台检查不依赖页面，复用并发刷新与关闭清理。

## 验证

最终冻结源码逐文件独立运行17个定向测试文件，共**318/318通过**，覆盖pricing、resolver、auto/store/API/scheduler、memo、四路径对拍、冷热/冻结/恢复、Claude、编辑器、渲染、i18n和相关夹具。日志为任务目录 `logs/G2-final-*.log`。`npm.cmd run typecheck`和`npm.cmd run lint`通过；lint仍有既有warning/info，不宣称零告警。

`npm.cmd test`受测试runner派生进程 `spawn EPERM`阻止；使用一文件一进程的 `--test-isolation=none`定向复跑，没有把多文件模块全局状态混跑。全server文件另做baseline对照：两边均22项、17过5失败，四个导入后即时统计断言及一个spawn失败同名复现，不归为当前价目新增问题。

`format:check`剩余14项，文件清单与baseline完全一致；只修正本次新增的八个文件格式问题，没有批量格式化其他施工线。

真实浏览器使用临时synthetic home和离线fetcher。验证普通模型新增/保存/撤销取消、两条线路分别保存、移除互不影响、409草稿保留、英文与Escape；无控制台错误。金额卡和说明明确“已定价部分合计”。[截图](../../../output/pricing-implementation-20261024/reports/G2-browser.png)；A原始缺陷与修正详情见[独立报告](../../../output/pricing-implementation-20261024/reports/A-acceptance.md)。原共享fixture误用的记录已排除，独立新home重跑作为证据。

## 容量与剩余边界

代表性256模型+512线路按编辑器真实保存格式，主审测得规范化175,518字节，API专测另一组合167,562字节，均超过原128 KiB。因此仅价目PUT调整为256 KiB，其余body默认16 KiB保持；合法字段组成的491,146字节请求明确413，旧文件字节和有效目录不变。模型256/线路512独立数量上限也已验证。

G4候选 `opencode-go/deepseek-v4.1-flash`缺缓存写入与适用上下文政策证据，K08调查收口但K09–K11/D10–D11未实现；未把缺字段补0或猜Fast倍数。行级刷新由capability关闭，带model请求明确拒绝，不能冒充目标刷新。原始调查快照未重新抓取，不代表当前价格。

普通history-backup不打包非空archive目录；本次冷恢复使用既有完整bundle路径，恢复有效价目。独立手动覆盖文件的锁定来源不在该备份契约内，线路文件保存/重开由store专测单独验证。

共享根源码仍有历史保留/TPS归属锁，因此本轮只交付隔离产物并更新状态文档。真实配置、正式服务、用户数据库和账本均未触及；合回须逐文件核对当前源与baseline，不能整目录覆盖。未验证公网价格、真实账单或长期后台运行，也不宣称全仓全绿。
