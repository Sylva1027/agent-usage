# 官方模型价、覆盖与 FX 执行记录

开工：2026-10-26。用户已授权按[双 worker 计划](../../plans/2026-10-26-pricing-two-worker-implementation-plan.md)开始工作，并明确授权 PRICE 向现有 RETENSION chat 协调文件窗口。

## 工作基线

- 当前任务目录：`output/pricing-official-20261026/`；`baseline` 保存实际未提交前像，`workspace` 为两位 worker 共用施工副本，353 个文件、每份约 30 MB。逐文件哈希见该目录 `baseline-manifest.json`。
- RETENSION 已确认根源码仍处百万测量及最终门禁冻结窗口，要求继续隔离开发、暂不合入；其 store 摘要与新 baseline 一致。未获释放的文件只在副本开发；不写真实配置、生产库或正式服务，不覆盖其他线产物。
- 旧 `output/pricing-implementation-20261024/` A/B 整包作废，不引用其中实现。新基线保留现有混币分桶、memo FIFO、峰谷快路、只读导入与 schema21 施工成果。

## 当前派工

- W1 Price-worker-A：R10已接受，停止实现；R11/R12待完整官方材料。
- W2 Price-worker-B：V11 已接受并封板；UI 窄补丁等待共享文件窗口，未合根。
- 已接受：21/23（R01–R10、V01–V11）；两位现有 worker 均停在卡边界，没有切换。完整结果与合入边界见[本批验收](FINAL-REPORT.md)。
- RETENSION 已分批释放并核对后端窗口，解析、计价、存储、服务、执行器和聚合接点已合根；UI 仍在隔离副本，11 文件最终窄补丁已交只读重叠审，等待 UI 主线文件稳定。

## 验收记录

- V01：主审读小夹具并纠正无意的 token 余量；独立复现 0/1 红测，八个 DS 原名仍分八行，接受为后继的行为反例，不冒充产品完成。日志 `logs/V01-main.log`。
- 基线独立验证：pricing-models 6/6、timeline-utils 19/19；使用根项目本地 TypeScript 的 baseline 与 R01 workspace 类型检查均通过。worker 使用其他编译器报告的“24 既有错误”未复现，已要求纠正报告归因。
- R01 初稿：主审独立 pricing-models 8/8，但只凭测试不足；额外核对发现 D3 的 unknown-free 边界，已回同卡窄修。未接入聚合或修改未知费用算法。

- R01 终稿：unknown-free 无目录键时不剥前缀，旧免费结果保留；resolver 8/8 与负例断言通过。
- R02：pricing 37/37、auto 21/21；FIFO 与峰谷快路保持。auto 沙箱临时重命名 EPERM 后同命令授权复跑通过。
- R03：规范名覆盖及 harness 合并，workspace/root resolver 10/10；两文件逐一核前像合入，见 reports/root-merged.json。
- V02：内存/紧凑索引模型合并 2/2、core 41/41，DS 八事件七会话，原始证据不变。
- V03：普通 SQLite 分组、查询目录上下文及 all-hot 摘要缓存；主审模型合并 3/3。
- V04：读侧日/区间/部分日与期间比较归并；主审模型合并 4/4、rollup 26/26。schema、原始 rollup 写入与回填未改。

- R04：部分失败、逐来源状态和 FX mode，主审刷新3/3。
- V05：期间缓存纳入目录版本与键集，主审模型合并5/5，A→B→A hit/miss一致、无新事件。

- R05：独立刷新7/7与tsc，only-FX/两源发现/六源维护按URL实测；发现更新尝试源、保留其他状态，抓取失败parsed为null。
- V06：独立模型5/5、timeline19/19、client21/21、currency5/5；客户端使用报告目录，费用诊断保留原名。

- V08：主审render63/63、i18n14/14、draft6/6；默认折叠详情、查询token份额、来源时间/FX模式与日龄，草稿和取消保留。
- root R02：逐文件保存真实前像，只合1738字节删除补丁及对应专测，root-merged.json记录五文件。仍未触其他冻结产品源。

- R06：主审最终refresh14/14；目标匹配不联网、网络1h重试、终态能力重评、notfound等目录维护变化；仅FX不触发发现，下载复用。实际HTTP及等待文案由R07接。

- R07：主审实际HTTP4/4；目标并发独立、手动FX等自动再变仍锁定、撤销最新auto、失败回滚与只读拒绝。pricing-store及专测获准窄合root，root refresh14/auto21/tsc通过。
- V07：主审render65/draft8/models6，最终缓存预热后新增目标立即匹配；草稿保留编辑起点版本，未静默覆盖远端。period helper获准窄合root，A/B/A与原事实断言通过。

- R09：主审请求域2/2、执行器并发1/1、HTTP目录/冻结/导入及异步边界3/3；快照在await前同步捕获catalog与automatic，后台discovery退出请求ALS。pricing/executor四文件窄patch已送RET待审，未写根。
- V09：主审models8/8、projection1/1、parity10/10及真实HTTP八组对拍通过；融合单扫描/cache hit保持，原始日志/SQLite/rollup名称未改。

- V04 重开：RET独立审读发现导出的rollup查询不应默认依赖未注册的usage_model_group；W2保留普通DatabaseSync旧调用，Store显式选择规范名路径，补实际无UDF负例。已审聚合patch暂不合根。
- R09根四文件已按许可前像逐项核对合入，pricing39/39、executor并发1/1、tsc与四文件format通过；RET另独立history导入/冻结等43/43通过。

- R08：独立scheduler 7/7通过；沙箱首次6/7因临时缓存rename受限，授权同命令复跑通过。启动等listening、关闭立即停timer、终态不秒级重排，小时检查就绪metadata且不强制建库。进入R10联合门禁。

- V04返修接受：独立rollup默认raw，无UDF照常调用；Store显式canonicalModels，主审rollups27/models8通过。
- V10：主审在R08最终服务与V04返修上复跑同一小夹具通过；非零官方场景A→B金额更新，热冷/三HTTP一致，snapshot/importA固定、405只读、raw字节不变。沙箱禁止合成备份hardlink，授权同命令外跑通过。

- R10：worker八文件145/145，主审完整server28/28、CLI生命周期9/9通过；W1封板停止。其误反向撤掉RET四组既有测试断言，已由主审按开工后保存的实际delta精确恢复SHA18d132...，事故与恢复证据独立保留，未触产品源。

- 后端最终合流：RET 对真实当前根仅六文件包独立 115/115 后释放窗口，主审逐 before/after 核对并合根；保留 schema21、A period pruning、B metadata 和单扫描优化。根 rollups27/timeline19/tsc通过；根 pricing39/models10/auto21/refresh14/scheduler7/core41/timeline19/parity10/Claude11 共172项通过（原子 rename 受沙箱限制的三个文件同命令外跑复验）。最新 RET 增量上的 V10 再跑通过，snapshot/import 固定旧目录，原始事件字节不变。六文件与server窗口均已交回 RET，后续共享 src 冻结；UI仍隔离收口。

- V11接受：修复旧文案/徽标回流、显式刷新覆盖草稿及暂停后读回旧 snapshot 状态。真实当前根副本仅应用 UI 补丁，134/134、tsc/lint/scoped format通过；中英浏览器、手动 FX、暂停重算与409草稿保留通过，无console错误，合成实例已清理。根后端已合入、UI未合入、来源扩展未开始，分层状态见 FINAL-REPORT。
