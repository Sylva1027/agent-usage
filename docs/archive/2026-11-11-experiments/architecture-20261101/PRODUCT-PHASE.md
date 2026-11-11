# 2026-11-02 Windows 看板链路与性能初筛

> 历史材料，2026-11-11 归档。本文命令与状态属于原记录日期；源码及恢复方法见[归档入口](../README.md)。

当前授权：开始计划下一步。只修改本实验目录、原计划实施记录和原型说明；不改正式 src/public，不写活动库，不部署。Windows 优先；可靠性与业务结果不能退化。

## 已就绪接口

在四后端增加 GET `/api/changes`：

- 无 since：返回完整已发布来源视图。
- since=N：返回当前发布版本中、N 之后被替换的来源；相同版本返回空 sources。若无法证明版本连续（如原生后端重启），允许 reset=true 返回完整当前视图，不漏数据。
- 响应 `{revision,reset,sources:[{sourceId,events,cursor}],context}`。empty events 表示来源被替换为空；context 总为该同一版本的完整元数据。
- 返回的 revision、sources、context 来自同一读事务或同一个不可变内存发布态。since 非负安全整数，未来版本拒绝400。不泄露半提交。
- 可选 snapshot=N 返回冻结版本完整视图（reset=true），未知快照404；与 live since 不能混用。
- 不按 size/mtime 跳过必要内容校验。changes 仅描述已经可靠提交的事实，与来源校验策略无关。

Node 已有 sources.updated_revision 可直接使用。Rust PublishedState 保留源版本表（启动时可设 reset floor），提交成功后从原版本派生、更新受影响source；不得预先推进变更版本。无需改持久化 schema 或 Source 的原始数据形状。

## 看板查询

共享 product-server 将以发布版本维护来源事实，首次载入完整视图，此后只收 sources delta。不得每次 /api/usage 都取 /api/report 全量历史。

复用现有 productProjection 作为业务正确性基准。允许按版本、完整筛选条件、价目及日期/时钟边界维护已计算业务视图；变化后必须失效/重算。不能把旧视图当新数据；不得只用固定 now 或重复缓存命中报告新鲜度。固定时间仅用于独立对拍。

普通日期范围 /api/usage 的 totals、eventCount、sessionCount、homeCount 取对应后端 /api/query，并和完整业务投影校验同一revision后返回；不能调用了快接口却丢掉结果。费用/分组口径继续用已有产品公式，后端group与产品别名/渠道合并差异不可直接替代。quota范围保留原资格规则。

默认使用当前时间；--now ISO 仅供固定输入基准。freeze 绑定 facts revision、价目和asOf，切范围仍一致；不能用新的时钟改旧快照。缓存时钟需复用现有refreshSummaryClock或保守重算，边界/未来事件/额度窗口不可陈旧。

保留 --mode legacy：原每次全量report+Node投影路径，作为同一份事实的适配层基准。默认mode=published。模块可导出server工厂供测量启动。HTTP返回 Server-Timing，并在专用只读诊断端点记录 feed次数/bytes、projection耗时、query耗时、response bytes，产品UI不增加说明或警告框。

## 单写分工

- A：node/ 服务、store、测试，仅实现 changes/snapshot feed。不得改其他目录。
- B：native/src/main.rs、model.rs、tests/core_api.rs及原生局部测试，实现changes及必要内存发布元信息。不得改存储owner文件/Cargo。
- C：product-server.mjs、compat.mjs（现有productProjection签名/基准行为保留，可加新辅助）、新product-publisher.mjs及对应tests。既有demo/browser-check接口保持兼容。
- Main：测量脚本、B0适配器、共用接口对拍、README/计划、证据、构建与串行性能验收。

各worker仅本卡文件直接编辑，不能生成后代。只跑局部正确性检查，不并发跑资源/性能基准。完成后交接真实改动、验证和限制，停在续卡前。

## 实现收口

- live 已载入 revision 时先请求现有薄 `/api/status`；版本相同复用事实、context 和投影视图，版本变化再取 changes。版本回退改为 full feed，避免未来 since。诊断分别记录 probe 和 feed 的次数与字节。
- 每次 usage attempt 捕获独立的 revision 与 carrier。并发请求推进 live state 不会改变该 attempt 的版本；core revision 不一致最多重试三次。
- 产品 snapshotId 使用独立 view UUID，绑定后端 snapshot revision、asOf 和价目。相同 facts revision 的两次冻结不会覆盖彼此。后端 snapshot API 仍使用 revision。
- Node 旧格式快照只有单来源、非空事件且可证明分组时才能还原 changes；其余明确返回 409/reset-required。旧 report 兼容，不静默返回空事实。
- 三名 worker 的当前任务卡及参数记录在 `product-phase-worker-audit.json`。A、B 在局部验收后关闭，C 在四张顺序修正卡验收后关闭；正式性能由主代理串行执行。
