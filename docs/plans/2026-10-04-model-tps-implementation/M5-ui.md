# M5：性能模式与可解释页面

**2026-10-08 后续前端任务：** 本卡记录原版本实现。用户已否决其入口与信息布局，后续执行改按[独立模型吞吐区域重构方案](../2026-10-08-tps-ui-restructure.md)，不要照本卡重加“按性能”标签页或恢复默认诊断墙。原统计与分组契约继续有效。

前置：M1.3 的 `summary.perf` 固定形状；M5.3 需 M4.4 的 ZCode API。模块唯一写入者负责 `public/perf-ui.js / app-state.js / app.js / index.html / styles.css / i18n.js` 和 `test/perf-ui.test.js / test/app-perf-mode.test.js`。M5.1 的纯 renderer 可与索引/API 并行；M5.3 改 `app.js` 时不能另派 agent 同时改这个文件。固定规则见[方案 §7 与 §17.6](../2026-10-03-model-latency-throughput-plan.md#7-界面与解释)。

## M5.1 纯展示模块与文案矩阵

在 `public/perf-ui.js` 导出 `renderPerfListHtml(perf,{locale})`、`renderPerfCoverageHtml(perf,{locale})`、`renderPerfDetailHtml(group,coverage,{locale})` 与数值格式函数。所有自由文本、模型名、provider、agent、home label 都 HTML escape；API 数值不舍入，展示 TPS 一位小数 `tok/s`，`durationMs<1000` 用 ms，否则秒。排序使用服务端原始 p50/key；renderer 不重新计算分位、pooled、coverage，也不从 `report.events` 推导 TPS。

主层级固定为来源/渠道 → agentKind+agent → 模型，来源实例 home 标签可见，不能把同名不同 home 的组拼成一条。provider、effort、timingKind、tokenScope 不同展开独立子组；编号排名只在同 `(sourceKind,homeId,channel,agentKind,agent,timingKind,tokenScope)` 池内进行。`n>=20` 才编号排名，1–19 显示“样本不足”并放在排名后；`n=0` 不画 0 TPS 行，而在诊断区显示 eligible、缺时长/缺输出/源过滤等原因。未知 agent 显示“代理未知”；不能从 `agent=''` 推断 main。请求源标签“请求端到端 TPS（含请求等待）”，Codex 标签“轮级 item 时窗 TPS 估算”，p10/p90 方向分别为慢/快；“合并样本 TPS”不称日历时间整体效率。

覆盖区按当前范围显示 `有跨度率/完整跨度率/有效样本率`，分母为 0 用“—”；`byFlag` 可重叠，不加总为 dropped。Codex recent/legacy 使用 API 已给 byEra，不在浏览器另定切点。`unsupportedSources`、`rebuilding`、`degraded`、`eligible>0 && sampled=0` 各有不同空/告警文案。中英文文案矩阵作为本卡测试 fixture，新增 `public/i18n.js` 映射由 M5.2 写入。

验收：恶意模型名不会注入 HTML；n=1、n=19、n=20、n=0、null rate、Codex 估算、源退化、超长模型名的纯函数测试；无 TTFT/“纯生成速度”文案。

## M5.2 DOM 骨架、样式与语言

在 `#timelineModes` 加“按性能”按钮；其整体 `aria-label` 改为“查看方式”或等价中英文，仍保留既有按渠道/模型/花销。`chart-panel` 中新增独立 `#perfPanel` 区域，默认 hidden；右侧 `detail-panel` 增加专用性能详情容器或新的原生 `<dialog id="perfDetailDialog">`，不挪用计价弹窗。已有 `.timeline-chart-well`、`#timelineLegend`、`#timelineRangeWarning` 等保留原节点，切换时可恢复。性能模式用现有 bar-list 视觉语汇；在浅/深主题和窄 PC 宽度下保持可读，长标签换行/截断后提供完整 title。

所有新可见字串和 aria 文案同步到 `public/i18n.js`；纯数值单位与国际化小数格式统一，不能把中文拼接后交现有英文正则“碰运气”翻译。专用详情 dialog 的触发、Esc、关闭按钮、关闭后焦点恢复和 `aria-labelledby` 明确；性能表不使用 canvas 画出无语义的柱。CSS 只改本功能选择器，不改变皮肤调色/时间图几何。

验收：静态 DOM 检查确认 ID 唯一、按钮完整、hidden 默认值、两种语言 key 齐全；没有新增外部 UI 包、主入口或旧 HTML 导出分支。

## M5.3 `app.js` 切换与 ZCode 页面闭环

在 `app-state.js` 新增 `activeView='timeline'|'performance'`，既有 `timelineMode` **只保存** `channel|model|cost`；点击性能按钮令 `activeView='performance'` 而不把字符串 `performance` 传入 `drawTimeline/renderTimelineLegend/timelineAccessibleLabel`。再点时间模式令 `activeView='timeline'` 并更新 `timelineMode`。按钮 `aria-pressed/active` 由这两个字段联合决定；日期、时区、来源排除、刷新仍走已有 `loadUsage`，页面只使用 `state.summary.perf`。

性能模式下在 `render()` 与 `renderUnavailableQuota()` 早期分支把 panel 标题/aria 改为“模型输出吞吐”，隐藏 chart well、legend、图专属 warning 和旧 detail list，展示 `#perfPanel` 与性能详情。隐藏 canvas 不能接焦点或保留旧 tooltip/aria；切入时若焦点在 canvas，把焦点移到性能标题/首个可操作行；`hideUsageTooltip()` 清除残留。切回恢复 panel 标题/aria、canvas 原 `tabindex`/aria、图例、warning、旧详情与时间图绘制；原三种模式行为和键盘箭头导航保持。性能详情行展开和弹窗只消费 API 的 `groups/coverage`。

验收：用 M4.4 ZCode fixture 在实际 `/api/usage?view=dashboard` 页面看到分组、p50、n 和诊断；切换前后日期/来源筛选不丢失、时间图恢复；直接调用 `drawTimeline(...,'performance')` 的测试哨兵应失败，从页面路径永远不触发。`state.summary` 为空、quota unavailable、snapshot 过期后重载均有正确空状态。

## M5.4 浏览器交互与视觉检查

前置：M4.6 的三源 API 接线，以及 M5.1–M5.3 的页面骨架；Codex 真实行在 M7.4 后另验。

用隔离 `createUsageServer`、临时 HOME/索引和合成三源 fixture 测真实页面；不连用户真实库，不复用旧服务端口。至少验证：浅/深主题、中英文、两档桌面宽度、筛选/时区、ZCode→DSH→OpenCode 混合、n=0/小样本、源 unsupported/degraded、Codex estimated 合成行、键盘 Tab/Enter/Escape、切回时间图、冻结状态刷新。截图与 DOM 断言都记录，不能只用纯 HTML 快照代替浏览器行为。

确认新文案无 TTFT、把 p10 当慢端、把 Codex 当估算，并检查 `prefers-reduced-motion` 下无失焦动画。`M5.md` 列每种检查的输入 fixture、实际截图/日志与未测场景；M7 接入真实 Codex 后再重跑相关行，不把合成 estimated 行称为真实来源通过。
