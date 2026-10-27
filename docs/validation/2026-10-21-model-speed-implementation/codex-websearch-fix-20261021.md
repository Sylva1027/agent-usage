# Codex TPS 缺失修复

2026-10-21。WebSearch 兼容及旧缓存恢复已修复，实际 3765 服务已加载；页面显示 Codex 模型及详情。

## 原因与修改

对已定位的三份 rollout 只读检查：未知 item 均为 `WebSearch`，出现次数分别为 1、6、1。它们携带搜索 query/action 等工具字段，原解析器的已知非目标 item 集合漏了这一类型，触发 `UNSUPPORTED_SCHEMA` 并阻断整个 Codex home。

- `codex-jsonl.js` 登记 WebSearch，沿用工具 item 的 envelope 归属检查，不投影搜索正文或工具时长；目标 item 仍仅为 AgentMessage、Reasoning。
- `codex-thread.js` 投影解析版本从 v2 升至 v3，旧失败投影必须重新读取。统计方法仍是 tps-v1，数据库表结构及发布过滤版本不变。
- `usage-executor.js` 对仅含 Codex LIVE_SOURCE_CHANGED 的同步结果重新执行一次完整同步，再发布状态。最多两次，不重试确定性结构错误、其他来源错误或混合错误；持续变化仍保留真实失败，异常继续上抛。此前页面曾在成功显示后遇到下一次追加而再次隐藏，故补上此项，未把一次回填成功写成永久稳定保证。

## 验证

1. 修改测试后、产品修复前，注册类型回归与旧缓存恢复回归均失败。修后通过：WebSearch 不改变 TPS 输入，正文不落入投影；含大跨度搜索工具的旧版失败投影在文件未变、实例重开后恢复，平均 TPS 仍为手算的 400，重复同步不改变版本。
2. [Codex 定向回归](V/codex-websearch-fix/targeted-permissions.log)：129/129。普通沙箱首跑为 126/129，三项均为临时夹具 rename EPERM，原日志保留在 targeted.log；权限可用环境完整复跑通过。
3. [执行器/API/状态/冻结回归](V/codex-websearch-fix/executor-retry.log)：70/70；其中三项确定性测试覆盖重试成功、无需重试、持续变化最多两次和异常上抛。两个测试集合有重叠，不相加冒充独立总数。
4. typecheck 与六个受影响代码文件的 Biome 检查通过；未重跑全仓。

## 实际索引与页面

首次常规服务回填遇到 LIVE_SOURCE_CHANGED，记录分别保留在 live-api.json、live-api-recheck.json、live-api-stable-window.json，不能当作通过。一次独立只读规划的 [894 文件 / 888 线程窗口](V/codex-websearch-fix/live-window-diagnostic.json)稳定且结构全部可解析，但它不等同于索引发布。

正常关闭服务后，以正式 UsageStore.sync 完成首次回填（临时 2GB 堆上限）：[回填记录](V/codex-websearch-fix/normal-index-warmup.json)为 ready、零告警、本周 808 个有效样本、5 个 Codex 模型/强度分组，落盘 894 份投影。原始日志未修改，未删除索引。

恢复服务后仍观察到一次追加引起的隐藏，补齐有界重试再重启。当前 gateway 的堆上限为 2048MB（此前 512MB）；这是本次运行参数，没有修改 CLI 默认值。较大堆回填成功并不单独证明 LIVE_SOURCE_CHANGED 的原因是内存。

最终 [两次正常服务查询](V/codex-websearch-fix/live-api-final.json)均为 HTTP 200、ready、零告警；今日 223 个有效 Codex 样本、5 个分组，请求耗时约 5.1s / 2.7s。页面真实刷新完成后出现 5 条 Codex 行，选中 `gpt-6.1-sol medium` 展示约 123.5 tok/s，[实际截图](V/codex-websearch-fix/live-page.png)。截图来自当前真实服务，无夹具注入；五行滚动区已滚到包含 medium/high/max 的位置。

浏览器初次点击等待曾超过连接器的单次等待期限；随后读取已完成页面确认行存在再点击取证，未把等待超时解释为数据解析失败。早期误裁到时间图或截到瞬时失败状态的截图已由最终实际 TPS 截图替换。

持续写入超过两次验证窗口时，原有保护仍可能暂缓 Codex 更新；本次没有放宽身份、计时或未知结构校验。Claude Code TPS 不属于本轮修改。
