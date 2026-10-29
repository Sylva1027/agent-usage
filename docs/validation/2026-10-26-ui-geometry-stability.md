# UI 几何稳定性施工验收

2026-10-26，15 张施工任务卡与 UI 专项验收完成，最后一项报告字段契约失败也已修复。报告相关 17 项与计价快照 1 项定向测试全部通过；完整工程首轮及后续复测分别保留，具体结果见下文。任务与交付范围见[实施计划](../plans/2026-10-26-ui-geometry-stability-implementation-plan.md)。

## 起点与执行

用户批准按既有计划施工。两名 worker 创建时均显式指定 `model: "group/deepseek"`、`reasoning_effort: "max"`，复用同一 worker 逐卡执行；未省略模型参数或请求其他模型。

- A：Banach，`01a1752c-3757-71f3-b952-75f9e309d5b8`，几何 CSS。
- B：Darwin，`01a1752c-37f8-7860-9333-41e22c15ab68`，结构、样板及回归。

B1–B4 交付后，B5 准备阶段未及时产出测试文件，主审收小卡后接回 B5a–B7，保留既有成果及文件单写；A 完成 A1–A7。两名 worker 均已关闭。复用流程已保存为全局 `pinned-workers` skill；其人数规划按可独立推进的任务、文件冲突及整合能力动态增减，不设固定两名默认值。

S0 已完成，施工前截图、矩形、实际字体及已有修改副本位于 `output/ui-geometry-implementation/baseline/`；局限见同目录 `S0-report.md`。所有验收使用真实应用脚本及隔离数据，不重启用户现有服务。

## 已保留的产品约束

保留陶瓷材质、光源、配色、角色行为与主栅格列结构。面板、卡片、标题行及间距以生产样板为准。机制、估算口径与边界解释默认收起；费用估算框内既有详情按用户明确要求直接展示。已删除的常驻说明不以新徽标、图标或占位框体恢复。

指定稳定区域跨语言和四状态检查；目录列表与主动展开允许按约定增长。不要求文档总高恒定，不为亚像素舍入误差改栅格，不自动缩字号。

## G1 已完成

A1 已将面板 21px、卡片 17px、内槽 9px 及共享间距接入生产最终层叠，B1 样板直接使用同一 CSS。主审发现交互样板切换状态时仍会收缩后，交回 B 修正；复测同一 `#statePanel` 的正常、空、加载、错误四态均为 563.28125×320px（1440×1100 / DPR 1），操作按钮仍可用。

主审另以隔离的配色 fixture 加现成 ZCode / DSH / OpenCode 性能 fixture，通过真实日期选择控件设定 2026-09-28 至 2026-10-04，实际渲染三张对比卡、速度表和详情。1920 中文深色整页与关键几何见 `output/ui-geometry-implementation/g1/`；无页面脚本错误。这是 G1 局部整合证据，不替代 G3 矩阵。

## G2 已完成

A4 主页面几何与 B4 四个弹窗的结构/文案已整合。主审真实 fixture 整页位于 `output/ui-geometry-implementation/g2/`：主图/详情各 384px，速度区 278px，周期比较区 586px，主图→速度→周期比较→底部→归档四道分区距离均为 24px，横向主缝为 20px。指定状态槽位已就绪，目录与归档展开保留自然增长；费用框现按用户反馈直接展示，跟进结果见下文。

主审修正了共享行盒 token 只命中生产祖先的问题；生产和样板的标题行盒均为 21px、bar 标签均为 24px。主页面共享规则在 G2 后冻结，随后完成弹窗 CSS 及正式几何回归。

相关行为检查：主页面清理 110 项、导入/皮肤相关主渲染与翻译 71 项及皮肤 42 项、计价相关 81 项定向测试通过。计价保存后旧冻结快照导致重开仍显示旧费率的问题已修复，并在 B7 的真实保存/复开回归中验证。

## G3 界面与行为验收

- 真实 Windows / Edge 155 / DPR 1，1920×1080、2560×1440 × 中文、英文 × 浅、深共 8 组；主页面及四个弹窗均从真实入口运行。几何回归 16 项通过、0 失败、0 跳过，容差 0.5px。
- 1920 中文浅色、英文深色的真实空态、比较不可用、初始加载与 503 态通过。无图例时曾出现 379px 主图区，已修正为各态 384px；速度区 278px、周期区 586px，四道主要纵缝均 24px。
- CDP 实测混合标签由 Noto Sans SC 与 Segoe UI 分别承载中文和拉丁 glyph；混合输入值、占位及语言切换保持框体。长数值维持 24px 并在槽中省略；长模型名、classic / DeepSeek 角色切换、主动展开与目录增长均通过。
- 隔离页面注入 8px 工具栏偏移，断言实际失败；移除后恢复通过，未放宽阈值。
- 数据来源和皮肤弹窗 12px 组距 / 8px 内距 / 36px 控件、空反馈零占位及真实反馈增长通过；真实排除请求、选择目录、角色开关、键盘滑块、皮肤切换和焦点归位通过。
- 计价列表 240px / 行 52px，匹配、缺价、免费、长名、搜索及范围切换通过。截图复核发现必要费率被 `max-width: 46%` 二次收窄，已改为按内容分配费率列，加入单行及完整可读断言；重匹配按钮补回既有陶瓷材质。
- 原生模型弹窗实际进入 `:modal`，关闭后高度为 0。中英文编辑、非法值禁用应用、503 保存反馈、真实 PUT 保存重算、后端读取和复开输入值一致均通过。固定历史样本通过“全部模型”入口检查，不依赖样本仍处于近期窗口。

最终截图在 A7 修正后重新生成：八组 × 主页面及四个弹窗，共 40 张；代表中文深色、英文浅色实际图像已复核。入口为[中文深色整页](../../output/ui-geometry-implementation/final/1920-zh-CN-dark-page.png)、[中文计价弹窗](../../output/ui-geometry-implementation/final/1920-zh-CN-dark-pricing.png)、[英文计价弹窗](../../output/ui-geometry-implementation/final/2560-en-US-light-pricing.png)及[矩形读数](../../output/ui-geometry-implementation/final/readings.json)。正常截图使用原组合 fixture；额外免费/长名样本仅在正式测试临时目录通过真实日志及计价 API 接入。

## 工程检查与失败归因

- `npm run typecheck`：通过。
- `npm run lint`：通过，61 条 warning、4 条 info；未借本轮重排全仓 CSS。
- `npm run format:check`：通过。首轮四个相关文件需格式修正，已定点格式化，无整仓重写。
- `npm run skins:palette`：通过，20/20 模式槽齐备。
- `npm test` 首轮：3243 项，3207 通过、11 失败、25 跳过、0 取消，约 293 秒。该结果保留原日志，不写成全仓通过。

首轮失败中，两项 CLI 在并发清理时报告服务仍运行；独立复测均通过。六项配色证据验证被主审在全仓测试运行期间的格式修正干扰，`public/app.js` / `roles.mjs` 摘要变化触发了正确拒绝；冻结源码后六项均通过。另两处状态目录断言仍为 45 / 90，已随既有 `cost-details-open` 单元同步为 46 / 92；连同前六项共 8 项定向复测全部通过，0 跳过。

报告字段契约失败已在本次跟进中修复：HTTP 完整报告按现有接口包含六个基础公开字段及 `pricingCatalog`，旧测试仍要求恰好六个字段。仅更新 `test/perf-server.test.js` 的 HTTP 字段断言，并补验报告内计价快照与响应顶层一致；CLI 六字段及内部候选、路径排除断言保留，服务实现不变。`node --test test/perf-server.test.js` 实际 17 项通过、0 失败、0 跳过；既有计价目录与冻结快照测试 1 项通过、0 失败、0 跳过，测试文件 Biome 检查通过。本次未重跑全仓测试。

原始记录：[UI 回归](../../output/ui-geometry-implementation/geometry-tests.log)、[全仓首轮](../../output/ui-geometry-implementation/npm-test.log)、[CLI / 报告复测](../../output/ui-geometry-implementation/g3-failures-recheck.log)、[8 项配色复测](../../output/ui-geometry-implementation/g3-palette-recheck.log)、[报告契约修后 17 项](../../output/ui-geometry-implementation/report-contract-tests.log)、[计价快照修后 1 项](../../output/ui-geometry-implementation/pricing-catalog-contract-test.log)、[类型](../../output/ui-geometry-implementation/typecheck.log)、[lint](../../output/ui-geometry-implementation/lint.log)、[最终格式](../../output/ui-geometry-implementation/format-check-final.log)、[配色检查](../../output/ui-geometry-implementation/skins-palette.log)。这些分次结果不拼成一次全仓通过。

## 真实服务页面复核

本次跟进通过 `http://127.0.0.1:3765/` 的实际日期控件选择 2026-10-19 至 2026-10-25，展示用户真实数据及当前深色角色皮肤。对比卡已无日期/会话补充行，速度区前已无计时覆盖说明；图表与详情、速度表与详情及两张周期表对齐。保留可操作的实际页面，截图见[主页面](../../output/playwright/ui-final-live/dashboard.png)与[速度及周期区](../../output/playwright/ui-final-live/dashboard-lower.png)。这些截图是实际服务展示，前述隔离矩阵仍作为几何回归证据。

## 费用估算常显修正

用户指出“估算详情”悬停时光影异常，并明确框内详情不应折叠。已移除费用区 `details` / `summary`、专属折叠样式及无用翻译，原有费用内容和计价入口直接展示。配色取证沿用状态 ID，但改为检查常显内容，不再点击已移除的入口；角色版本同步为 40。主方案和施工计划已注明这一展现要求。

修后真实 UI 几何回归 16 项通过、0 失败、0 跳过，覆盖既有八组合；费用内容在正常加载后无需点击即可见，框内无折叠控件。实际 3765 页面也已复核：标题指针反馈开启面板聚光，移入正文凹槽后退出聚光，两次框体均为 710×195px，正文槽均为 111px。记录见[标题光影](../../output/playwright/ui-final-live/cost-note-title-light.png)、[正文效果](../../output/playwright/ui-final-live/cost-note.png)、[实际读数](../../output/playwright/ui-final-live/cost-note-readings.json)及[16 项 UI 回归](../../output/ui-geometry-implementation/cost-note-geometry-tests.log)。相关文件 Biome 检查通过，CSS 保留既有 54 条 warning。

翻译与配色契约/预览相关检查首轮 163 项中 152 项通过；11 项因 Windows 沙盒无法启动 Edge 或创建临时目录联接失败，换到可执行对应操作的环境后仅复测这 11 项，全部通过、0 跳过。两次日志分别保留：[首轮](../../output/ui-geometry-implementation/cost-note-unit-tests.log)、[11 项复测](../../output/ui-geometry-implementation/cost-note-browser-recheck.log)。本次未重跑全仓测试。

## 整页悬停光影复核

用户要求通查同类光影问题，保持各区域展现方式。生产改动仅位于 `setupFrameSpotlight()` 和光影相关 CSS：不可见内容不再进入遮罩，并监听原生 `open` 变化；表格仅把实际滚动凹槽从面板光影中扣除，透明合计行继续共用面板表面；模型速度详情的标题、主数值、状态文字和刻度置于聚光层上方。框体结构、内容、尺寸及展开方式均未调整。

修前浏览器检查已复现收起归档的隐藏列表挖出缺口、两张周期表合计行缺少面板光影、速度文字低于聚光层；日志保留在[修前记录](../../output/hover-lighting/before-tests.log)，该轮在用户中断时未完成。菜单项悬停后的凹槽为既有设计，测试已按实际材质校正，不新增聚光。

修后[18 项真实浏览器回归](../../output/hover-lighting/after-tests.log)全部通过、0 失败、0 跳过，包括新增浅深主题整页指针扫查：顶部和工具栏、12 张指标卡、3 张对比卡、图表/详情、速度表/详情、两张周期表及合计行、目录/费用、归档开合、最近范围/时区菜单、日历及三个外层弹窗。检查每次只有正确宿主发光，凹槽和弹窗不误触主页光影；速度文字层级、归档开合后的遮罩、现有展开状态和主框体几何同时验证。[61 项相关测试](../../output/hover-lighting/related-tests.log)、[类型检查](../../output/hover-lighting/typecheck.log)及相关文件 Biome 检查通过，CSS 仍为既有 54 条 warning。

本次复核中 3765 已拒绝连接，未启动或重启它。视觉复核使用正式前端与现成隔离 fixture，预览地址和进程见[预览记录](../../output/hover-lighting/preview-address.json)。人工复核截图：[浅色顶部](../../output/hover-lighting/light-top.png)、[深色顶部](../../output/hover-lighting/dark-top.png)、[合计行](../../output/hover-lighting/footer-after.png)、[速度详情](../../output/hover-lighting/speed-after.png)、[收起归档](../../output/hover-lighting/archive-after.png)；[读数](../../output/hover-lighting/readings.json)确认收起归档无遮罩缺口，速度文字层级为 1、光影层为 0。

本轮未发布、未重启用户的 3765 服务，未执行用户真实数据导入或重新计价，未重跑全仓测试。专项范围是桌面 CSS 视口与既有皮肤；没有追加手机适配、全皮肤全状态组合或真实 OS 缩放验收。

## 顶部缝隙与内容框留边修正

用户指出范围、自定义日期、自动刷新之间的缝隙偏窄，以及模型速度表周边材质偏薄。浏览器实测：工具栏横缝为 12px，其他主栅格横缝为 20px；各面板细边线均为 1px，图表内边距为 20/22px、速度面板为 16px、周期面板为 20px，视觉厚薄差来自内边距。修前完整读数见[修前测量](../../output/frame-spacing/before-readings.json)。

仅修改对应 CSS：工具栏共用 20px 间距，并移除桌面断点的旧 12px 覆盖；图表和速度面板改用既有 `--space-4`，与周期面板同为 20px。速度表保留 32px 表头、42px 行高及 242px 五行滚动槽，外框按两侧内边距和 1px 边线计算为 284px，比此前高 6px；主图区仍为 384px、周期区仍为 586px，主要纵缝仍为 24px。内容、字号、材质、交互和展开方式没有调整。

既有真实浏览器测试增加顶部三框间距、图表/速度/周期内槽左右留边、速度框上下留边及五行槽位断言。首轮新增断言发现桌面断点仍覆盖间距，同时测量函数未兼容空态无内槽，均已修正；[首轮日志](../../output/frame-spacing/first-pass.log)保留。[修后 18 项界面回归](../../output/frame-spacing/geometry-tests.log)和[39 项速度视图测试](../../output/frame-spacing/perf-ui-tests.log)全部通过，0 失败、0 跳过；包括浅深主题整页悬停及既有八组桌面/语言/主题矩阵。相关文件 Biome 检查通过，CSS 保留既有 54 条 warning。

现有 4415 隔离样本预览已刷新，实际测得两道顶部缝隙均为 20px；图表、速度表、两张周期表左右留边均为 21px（20px 内边距加 1px 边线），速度框四边均为 21px。见[顶部截图](../../output/frame-spacing/top-after.png)、[速度与周期表截图](../../output/frame-spacing/speed-period-after.png)及[修后读数](../../output/frame-spacing/after-readings.json)。这些图片使用现成样本数据，未重启用户 3765 服务，未重跑全仓测试。

历史归档区本次仅核实用途，展现保持原样：列出已登记封存段的范围、状态和事件数，支持展开读取 UTC 日统计及分页原始事件，内容为封存版本。当前样本没有已登记归档段；该区定位为历史数据核查入口，当前 UI 未提供创建归档、导出或恢复操作。

## 主页归档移除与标题行调整

用户随后确认倾向移除非必要的历史归档框，要求统一标题下方的间距，并交换皮肤和语言按钮。主页已移除归档 DOM、模块接入及初始化/刷新/语言重绘调用；后端历史数据保留、归档查询接口及 CLI 不变。页面以目录/费用区域结束，移除原先通向归档的 24px 间距，保留页尾 40px 内边距；未新增维护入口或占位框。

浏览器修前测得标题→筛选为 14px、筛选→指标及两排指标间为 20px、趋势→图表为 16px。现将标题到主图区前的五道纵缝统一为既有 20px token，主内容分区之间继续为 24px；标题右侧 DOM 和视觉顺序均为语言、皮肤、主题。既有材质、字号、框体高度及费用详情常显保持不变。

既有[18 项真实 UI 回归](../../output/header-cleanup/geometry-tests.log)全部通过、0 失败、0 跳过，新增五道顶部纵缝、按钮顺序、归档框缺席、页尾留白及无归档后台请求的断言；整页悬停、语言/主题/皮肤及各弹窗交互继续通过。已删除归档框专属的开合/悬停检查，目录列表增长仍检查真实页尾留白。[85 项相关测试](../../output/header-cleanup/related-tests.log)及[类型检查](../../output/header-cleanup/typecheck.log)通过，相关文件 Biome 检查通过，CSS 保留既有 54 条 warning。

4415 隔离样本预览已刷新并保留：见[标题与按钮截图](../../output/header-cleanup/top-after.png)、[归档移除后的页尾](../../output/header-cleanup/bottom-after.png)及[实际读数](../../output/header-cleanup/readings.json)。实测顶部五道纵缝均为 20px、归档框为 0 个、页尾留白为 40px。看板行为和历史操作文档已同步；本次未重跑全仓测试、未启动或重启用户 3765 服务。

## 五处视觉反馈跟进

按用户五条批注调整正式前端：皮肤图标沿用 22.1px 大小，描边由 1.7 增至 2.04（加粗 20%）；语言按钮的 A 由 15px 调至 17px，保留此前整体上移 1px 的校正。月亮大小与间距等此前调整保留。

自动刷新框改为与范围、自定义相同的 19px 标题行加 8px 间隔、52px 凹槽。标题、60s、开关和加载圈置于标题行，上次检查时间与时区置于凹槽；错误详情在槽内使用正文和返回列，保留至少两行可滚动文本、焦点恢复和原有请求行为。三框外高仍为 107px。标题文字的实际承载面改为工具栏渐变，配色角色同步至版本 41，凹槽时间按实际继承的 muted 颜色登记；没有增加常驻说明。

速度表仅将自己的内槽圆角由 16px 收至既有 9px token，滚动槽、阴影和焦点沿用该圆角，外框 21px、四边留白及 242px 五行槽不变。详情身份改为两层：来源/provider 紧邻排列，下一行模型名与 effort 相隔 8px；移除可见圆点分隔和按百分比分配的空白。长名称继续省略并保留完整 tooltip/可访问名称，缺失字段省略，详情外高仍为 284px。

[18 项真实 UI 回归](../../output/ui-five-refinements/geometry-tests.log)、[186 项相关测试](../../output/ui-five-refinements/related-tests.log)及[类型检查](../../output/ui-five-refinements/typecheck.log)全部通过，0 失败、0 跳过。UI 回归覆盖既有八组桌面/语言/主题矩阵、整页悬停、新标题/凹槽对齐、新身份行距、局部圆角及中英文错误详情的可读高度、返回与焦点恢复。首轮仅新增英文错误正文断言误用了原始 fixture 文案，按现有 HTTP 503 本地化文案修正后通过，保留[首轮记录](../../output/ui-five-refinements/first-pass.log)。相关文件 Biome 与差异空白检查通过，CSS 保留既有 54 条 warning。

4415 样本预览实测三标题同高同位，三凹槽同高同位；见[实际读数](../../output/ui-five-refinements/readings.json)、[深色顶部](../../output/ui-five-refinements/dark-top.png)、[浅色顶部](../../output/ui-five-refinements/light-top.png)及[浅色速度区](../../output/ui-five-refinements/light-speed.png)。本次未重跑全仓测试、完整配色截图矩阵或真实 OS 缩放验收，未启动或重启用户 3765 服务。

## 加载时保留趋势对比框体

用户指出初始加载时趋势对比区只留空位，三张卡片缺席。首屏 HTML 现直接包含原有三张卡，尚无摘要时的渲染也使用相同框体，数值及百分比先显示 `—`，数据返回后填入原有内容。沿用现有材质、样式和尺寸，没有新增加载文案或动画；限额视图与已加载但没有上一周期的既有处理保留。

[19 项真实 UI 回归](../../output/comparison-loading/geometry-tests.log)、[72 项渲染与翻译测试](../../output/comparison-loading/related-tests.log)及[类型检查](../../output/comparison-loading/typecheck.log)通过，0 失败、0 跳过。新增回归实际阻塞 app 模块，验证脚本执行前已有三张可见卡；另阻塞用量请求，检查等待、错误及数据返回后的卡片位置和尺寸，容差仍为 0.5px。加载取证见[脚本加载前](../../output/comparison-loading/first-paint-zh-CN-dark.png)、[中文浅色接口等待](../../output/comparison-loading/loading-zh-CN-light.png)及[英文深色接口等待](../../output/comparison-loading/loading-en-US-dark.png)。

4415 样本预览已刷新并保留，三张卡高均为 77px，上下间距均为 20px，见[样板页](../../output/comparison-loading/preview-after.png)及[实际读数](../../output/comparison-loading/preview-readings.json)。相关 JavaScript 的 Biome 与差异空白检查通过。本次未重跑全仓测试，未启动或重启用户 3765 服务。

## 底部标题与按钮对齐

根据用户反馈，统一扫描目录、费用估算两处标题行的排版。此前编辑按钮仅设最小高度，计价标准按钮单独设固定高度；现两处按钮共用 30px 高度、标题行的 21px 行高及 inline-flex 文字居中，桌面标题行按文字基线对齐。规则仅作用于底部标题行，费用正文继续常显。

[19 项真实 UI 回归](../../output/bottom-heading-alignment/geometry-tests.log)全部通过，0 失败、0 跳过；既有八组桌面视口、语言和主题组合及混合字体检查新增标题、按钮外框与四段实际文字矩形的对齐断言。相关文件 Biome 和差异空白检查通过。4415 样本预览已刷新，[实际读数](../../output/bottom-heading-alignment/after-readings.json)确认两按钮同为 30px 高，标题和按钮文字均位于相同纵坐标，见[修后截图](../../output/bottom-heading-alignment/after.png)。本次未重跑全仓测试。

## 2026-10-28 速度详情数量与日期清理

按用户批注永久移除速度详情中的样本日期及日期范围，包括正常、缺少耗时和溢出状态；删除相应日期格式化函数与无用翻译。Codex 的 turn 中文单位改为“轮次”，数量移到来源所在首行的右端，同高、右对齐；缺少耗时状态沿用既有用量记录数量。模型身份、速度数值、分位带、统计字段和后台数据不变。

[110 项相关测试](../../output/perf-count-header/related-tests.log)和[19 项真实 UI 回归](../../output/perf-count-header/geometry-tests.log)通过，0 失败、0 跳过；新增各状态日期缺席断言，以及八组桌面/语言/主题组合中数量与来源同高、右边缘对齐及不碰撞 provider 的检查。相关文件 Biome 与差异空白检查通过。3765 实际服务已刷新，来源和“35 个轮次”的纵坐标均为 924px，数量右边缘与首行右边缘一致，详情无日期文字；见[实际页面](../../output/perf-count-header/live-page.png)和[读数](../../output/perf-count-header/live-readings.json)。本次未重启服务、未重跑全仓测试。
