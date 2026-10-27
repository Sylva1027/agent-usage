# 模型速度视图主审记录

2026-10-21。结论：本轮数据、独立界面、隔离生产链路及收尾检查通过；现有服务激活与重启后真实页面验收不在本轮已测范围。本稿不借用旧 TPS G4。

## 范围与独立复核

基线 HEAD 为 `b717d9156d0b211de101ee5f28dd236c12889485`，受测文件摘要见 [engineering-start.json](V/engineering-start.json)。数据由 A 完成，界面由 B 完成；主审独立阅读数据投影、core/store 两条挂载、API/执行器回归、app 的提前返回与选择恢复、局部样式，并实际执行正式页面验收。

模型行按来源、原始模型名和推理强度唯一分行；同来源内合并 home、provider、主/子代理。平均值使用总输出/总时长；旧 groups 仍保留原分组、门槛和诊断。没有修改来源 reader、SQL/schema、皮肤色源、生成物或依赖。

## V1/V2 浏览器

[runner](V/browser-check.mjs)使用本机 Edge 和已有 bundled Playwright，临时四来源夹具经过正式 createUsageServer、执行器及 SQLite 到正式页面；没有 mock fetch，也没有写入用户配置。手算预期独立于产品统计实现。

- 逐行核对 API/DOM key 和降序；验证 n=1 最快、均值位于分位带两侧、三值相等、端点接近、中间距离和长名。选择后核对 hero、样本数、每根刻度的真实比例。
- 实际通过扫描目录编辑排除/恢复；时间切换到空范围清除旧详情；点击第六行等滚动记录保留 scrollTop；键盘上下/Enter/Space/Tab 可操作。
- 关闭自动刷新后追加临时来源：live API 更新，冻结页面仍用旧数据；恢复刷新后出现新行，仍存在的选择保留。
- 检查 classic 和当前五款 picker 皮肤的深浅主题，所有新填充为实色；双语切换，1920×1080、2560×1440、1440×1080、1024×900、720×900 CSS 视口。未把 CSS 视口当作实际系统缩放/浏览器缩放。
- 除初始五行/等高/条形对齐外，每次边界选择都检查两栏高度、内容边界、标签无碰撞；同行四个单元格的底线必须对齐。实际整页截图已阅读，新增区域位于周期比较之后、扫描目录之前。

证据：[浏览器聚合](V/browser-evidence.json)、[日志](V/browser.log)、[classic 浅色整页](V/page-classic-light-1920.png)、[DeepSeek 深色整页](V/page-deepseek-dark-1920.png)、[1024 窄窗口](V/page-1024.png)、[相近端点](V/near-endpoints-model.png)、[长模型名](V/long-model-name-with-separate-effor.png)。

### 发现并修正

1. 新右框继承原详情最小高度 320px，左框只有 274px；局部覆盖 min-height 后恢复等高。首次证据保留为 [initial-height-failure](V/browser-initial-height-failure.json)。
2. 长名换行将右框撑高到约 316px；改为局部单行省略并保留完整 title，不增高左框。
3. 速度 td 直接设 grid，分隔线与同行不齐；grid 移到单元格内部，恢复原生 table-cell。
4. 选择/刷新替换 DOM 时旧 ResizeObserver 未解除；在布局入口断开旧观察。拥挤标签变宽后先恢复自然标签再测，避免始终停留在 fallback。

一个视口切换检查曾返回非 none，但当次没有保存具体 computed 值；加入精确值记录后的运行通过，不能将前次归因为产品渐变或浏览器绘制。runner 后续改为在单次 page.evaluate 内查询并读取样式，避免 locator 先解析节点、随后 resize 重建 DOM 的跨步检查；历史记录见 [viewport diagnostic](V/browser-viewport-paint-diagnostic.json)。此条不作为产品修复证据。

## 有界现有服务检查

只探测 3765/3766 静态页面；3765 可用，3766 未监听。确认 3765 的 pricing 读侧已 ready 后，仅取一次 `preset=all&view=dashboard&skipCheck=1` 缓存聚合，不请求重扫。结果见[安全聚合](V/existing-service-smoke.json)：静态 HTML 已有新区域，但现有后端进程没有 models，旧 groups 有 45 组、状态 degraded。

因此本轮已验证隔离生产链路，未把旧进程结果冒充新代码真实 API→DOM 验收。需要重启现有服务后才会加载新后端；本轮没有重启、删除索引、扫描真实 Codex 或改配置。

## V3 工程门禁

完整运行结果：**2,607 通过、3 失败、30 跳过**，原始记录保留在 [test.log](V/test.log)；不能写成一次全仓零失败。3 项均是临时 HOME 下无法自动定位 Playwright：E1c、E1d 和 D8u11。显式指定已有 bundled runtime 后，E1c/E1d 通过；14 项补测中的唯一失败发生于 M3.2 Edge 启动阶段（尚未进入测量）。保留 Edge 原始启动环境的两条 fixture 浏览器用例最终 **8/8 通过**，包含 M3.2 与 D8u11。对应日志为 [环境补测](V/browser-environment-followup.log)、[启动环境复核](V/browser-gate-original-env.log)，不重写全仓原记录。30 项跳过仍保留，不宣称这些路径已测。

首次全仓还发现本轮三个 D 文件格式不符，以及 UI 测试 fake classList 的两项 forEach 返回值 lint 错误，已分别交原 owner 修正。修后数据 **6/6**、执行器定向 **2/2**、UI **22/22** 通过；主审重新执行全仓 typecheck/lint/format 均 exit 0。lint 仍有 54 warnings、4 infos，无 error。原 run 的 skins:check、skins:palette、diff-check 也均 exit 0。最终结论见 [final-checks.json](V/final-checks.json)，新日志为 [typecheck](V/typecheck-final.log)、[lint](V/lint-final.log)、[format](V/format-final.log)。

完整工程运行前后 **231 个文件摘要一致**，见 [start](V/engineering-start.json)、[end](V/engineering-end.json)。之后仅三项格式化及一项测试 callback 修正；最终摘要见 [final-code-hashes.json](V/final-code-hashes.json)。浏览器证据绑定格式化前统计源与最终 public 字节；格式化后统计逻辑未变且已做定向复核，没有重复全仓或重复浏览器来制造新计数。

测试隔离的首轮不完整记录保留为 [test-first-incomplete.log](V/test-first-incomplete.log)：确认部分旧执行器测试 sync 参数会覆盖完整 discovery options 后主动停止。后续整个测试子进程 HOME/USERPROFILE/AppData 指向临时目录，移除额外 homes 与 CLAUDE_CONFIG_DIR，不修改父进程环境。A 首次漏隔离测试曾实际混入真实来源，已在 D 报告如实记录；没有把它称作受控真实数据验收。

当前验收结论：D1–D3、U1–U4、V1 通过；V2 隔离整页视觉及有界旧服务检查完成，重启后的真实数据页面仍未测；V3 的本轮错误已修正、环境失败已定向闭合。现有服务仍为旧后端，不在未重启时宣称新功能已上线。

未提交、暂存、推送或发布。系统缩放/浏览器缩放和重启后真实页面未测；本轮没有扩展旧 reader 的来源覆盖承诺。

## 收尾时的并行变更边界

在上述最终摘要与检查完成后，共享工作区出现其它任务改动，含 WorkBuddy 来源、服务端、统计/app 接线及皮肤测试；[摘要差异记录](V/concurrent-drift.json)登记了与受测 231 文件集合不同的文件。原始门禁、浏览器与定向通过均只绑定本轮受测摘要，不覆盖这些后续并行变更，也不因此恢复、覆盖或重测其它任务。当前工作区整体不能引用本报告宣布全绿，部署前需要在其它任务收口后做统一集成验收。
