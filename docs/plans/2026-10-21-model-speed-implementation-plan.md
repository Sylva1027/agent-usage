# 模型速度视图：后续实施工作计划

日期：2026-10-21。状态：**本轮实现与独立验收已完成；现有服务未重启**。用户本轮明确指定 TPS-worker-A、TPS-worker-B；采用本稿第 2 节规则开工，逐卡状态只维护在[实施账本](../validation/2026-10-21-model-speed-implementation/README.md)。上轮仅规划的记录保留语境，本次开工取代 TPS 的暂停状态；不扩展其它项目的任务范围。

产品规则见[模型速度视图方案](2026-10-20-model-speed-view-plan.md)，视觉基线为 [round5](../validation/2026-10-20-tps-detail-panel-samples/round5.html)。旧 [2026-10-08 重构稿](2026-10-08-tps-ui-restructure.md)保留历史语境；其四列、强度独立列、旧原型和升降序切换不再作为本轮施工要求。旧 M0–M8/G4 的通过记录只归属旧版本。

## 1. 本次已经完成的准备

- 阅读 round5 源码、深浅主题/窄窗口/小样本截图，并核对当前数据入口、store 显式投影、执行器和页面渲染分支。
- 将评审建议合入产品方案，消除“降级即全空”、store 漏接、跨来源 mixedMethods 用例与新行身份冲突等问题。
- 固定下列实施草案，并拆为数据 D、界面 U、集成验收 V 三模块，共 10 张小卡。每张卡都有文件边界、具体动作和可检查结果。

取消小样本排名门槛、取消小样本黄字、固定降序及区间文案调整属于**本次主审提出的规划建议**，不是用户已逐项确认的历史事实。round5 截图中的黄字和小样本末尾位置保留原样，不把修改后的文字计划冒充新的视觉验收结果。

## 2. 本稿拟采用的固定规则

### 2.1 数据与状态

- 一行身份为 `JSON.stringify([sourceKind, model, reasoningEffort])`。模型保持规范记录中的原名；推理强度缺失用空字符串，不猜测强度或改写模型名。
- 同一来源内合并 home、渠道、主/子代理和 provider；来源不同或强度不同则分行。这里比较的是工具下观测到的模型速度，不建立新的模型别名或物理模型识别规则。
- 只使用现有发布策略允许、现有去重/时间/目录过滤后、通过原有 sampled 判定的记录。失败、冲突、未完成等记录的排除规则不变。
- `averageTps = sum(outputTokens) * 1000 / sum(durationMs)`；p10/p90 取相同记录集合的逐条 TPS nearest-rank 分位数。排序使用未舍入数值，界面显示一位小数。
- 所有有效行按平均速度降序排名；同值按规范 key 的 code-unit 顺序。n=1/17/19/20 都参与排名。旧 `groups` 的 `minSamples`、p50 排序和排名规则不变。
- 聚合整数和溢出时，新行 `state="overflow"`、三个统计值及 rank 都为 null，排到有效行后；同类按 key 稳定排序。新 models 的溢出不反向修改旧 groups/coverage/meta。
- 空 model 不进入 models；不造“模型未知”行，不新增专用诊断计数。旧 groups/coverage 继续保留原规则。
- rebuilding/uninitialized 不展示 models；degraded 时保留后端已发布的健康结果。不因 `ready=false` 清空健康行，也不从旧缓存或旧 groups 拼补数据。
- Claude Code 等当前不支持 TPS 的来源沿用既有 unsupported 行为；本轮不加 reader、不反推时长。

### 2.2 新字段与调用链

新增 `summary.perf.models`，单行字段仅为：

```js
{
  key, sourceKind, model, reasoningEffort,
  averageTps, p10, p90, n,
  state, // "ok" | "overflow"
  rank   // 有效行从 1 开始；overflow 为 null
}
```

数据沿现有路径传递：

```text
已允许发布的样本
  → summarizePerf：只做一次 selection，再得到一次 sampled 集合
    → 原 groups（行为不变）
    → projectPerfModels(sampled)
  → buildPerfStatsBlock
  → usage-core / usage-store 各自显式挂载 summary.perf.models
  → 既有执行器、API、冻结快照
  → 独立模型速度区域
```

不新增 methods/mixedMethods/estimateOnly/warnings 的复制投影；诊断仍由旧 groups、coverage、meta 承担。模型原名、来源与强度按现有 HTML 转义和本地化规则渲染。

### 2.3 页面落点与视觉

- 2026-10-21 用户比较两种落点后，确认位置为**紧接时间分布/详情下方、模型/仓库周期比较区域之前**，两行左右面板对齐。不能插入时间图，也不能占用它的右侧详情。
- 新区域复用 `.main-grid` 的左右比例、面板间距和 `.detail-panel`。专用样式只作用于新区域，不改全局面板、bar 材质或其它表格。
- 左表严格保留 round5 的四列：`#`、模型/推理强度、来源、平均速度；五行数据区、外置表头、内部滚动、桌面左右等高。
- 不复制原型顶部“第五版”、说明或主题按钮；外层区域的可访问名称为“模型速度”。不另加一行工具栏、来源菜单或重复时间标签，不为标题额外拉高框体。
- 右栏保留来源·模型·强度、平均速度、样本数和区间带。解释句用“常见速度区间 X–Y tok/s”；英文同时给出。
- 所有填充使用现有 token 的实色，computed `background-image` 必须为 `none`。不新增光谱渐变、颜色 token、tag、诊断墙或主/子代理列。
- 只做平均速度降序；向下指示是排序状态，不增加升序操作。点击/键盘选择只更新选中态与右栏，不重建左表。
- 原有扫描目录编辑、时间窗口、时区、自动刷新、在线冻结、皮肤与语言是唯一公共状态来源。

## 3. 文件和协作边界

**数据执行者**负责 `src/perf-stats.js`、`src/usage-core.js`、`src/usage-store.js`、`src/usage-types.js` 及对应数据/API 测试。

**界面执行者**负责 `public/perf-ui.js`、`public/index.html`、`public/styles.css`、`public/app.js`、`public/app-state.js`、`public/i18n.js` 及对应 UI 测试。U1–U4 共享这些文件，由一个执行者按卡串行完成。

可添加一个新视图单测文件 `test/perf-models.test.js`；只有数据与浏览器确实共用夹具时才增加 `test-support/perf-model-fixture.mjs`，其中期望值必须独立手算，不调用被测统计函数生成答案。其余优先扩充已有测试，不搭新框架。

`src/perf-sources/**`、`src/server.js`、`src/usage-executor.js`、SQL/schema、价格/配额规则、皮肤色源/生成物、依赖与服务管理不属于产品改动范围。执行器和服务通过测试验证透传；若发现确实必须修改，先由主审定位具体丢字段点，再调整原卡边界，不让 worker 顺手重构。

用户本轮指定的 [TPS-worker-A](codex://threads/01a15a06-0712-7fb2-bddd-6d2c7cf6be0d)负责数据，[TPS-worker-B](codex://threads/01a15a06-21e8-79f3-929d-6c934d62d926)负责界面；主审负责集成验收。此安排取代旧 worker 3 的派工入口，不向旧 worker 2 派发。

## 4. D 模块：数据投影，共 3 卡

### D1 — 同一 sampled 集合上的模型聚合

依赖：实施恢复；先读产品方案第 2–3 节和本稿第 2 节。写入：`src/perf-stats.js`、`test/perf-models.test.js`、必要的共享夹具。

动作：

1. 在 `summarizePerf` 内沿用原有过滤顺序和 sampled 判定，得到一次 sampled 集合；原 groups 和新投影共用，不重复 selectPerfSamples，不重新读日志。
2. 增加 `projectPerfModels(sampled)`，按固定三元 key 聚合。复用现有分位数、整数安全和 code-unit 比较工具；不从旧分位数或旧 pooled 求平均。
3. 返回最小字段集；有限值降序、平手稳定、小样本正常编号、溢出无值且无排名。
4. 保持旧 groups/coverage/meta 的可观察结果不变；旧测试对对象键的期望只增 models，不删除或放松旧字段断言。

必测：同来源跨 home/渠道/provider/主子代理合并；跨来源和跨强度拆行；空强度；空模型；n=0/1/17/19/20；舍入后相同而原值不同；输入乱序/重复身份；聚合溢出。

手算边界必须包含：1 条输出 100、时长 100000ms，加 19 条输出各 100、时长各 1000ms；平均为 `2000 * 1000 / 119000`，p10=p90=100。它证明平均值可以在分位带外。

通过条件：新投影期望值逐项一致；`test/perf-stats.test.js` 与 `test/perf-summary.test.js` 原语义通过；无采样、去重或旧门槛变更。

### D2 — 内存、SQLite 与类型全部接通

依赖：D1。写入：`src/usage-core.js`、`src/usage-store.js`、`src/usage-types.js`、`test/perf-summary-parity.test.js`，必要时扩充 `test/perf-state.test.js`。

动作：

1. `buildPerfStatsBlock` 透传 models；rebuilding/uninitialized 归一化后为空，不改原 groups 状态处理。
2. 内存路径和 store 路径显式组装 summary.perf 时同时添加 models；不能只改公共计算入口。
3. 更新 PerfSummary、PerfModelRow 及实际函数返回类型；不留旧“三件套即全部字段”的误导性注释。
4. 在同一稳定夹具、同一时间和过滤条件下比较两路径；同时证明来源排除确实影响记录集合、均值、分位数和新排名。

必测：普通/自定义/UTC 范围、includeDetails=false、排除一个 home、配额范围现有来源限制、空范围、重建、健康来源与失败来源并存。degraded 仍有健康 models；失败线程及旧保留记录仍由既有发布策略排除。

通过条件：models 逐项相等，旧 groups/coverage/meta 不变；不加查询、不改 schema、不重建用户索引。

### D3 — API、执行器和冻结透传

依赖：D2。主要写入：`test/perf-server.test.js`、`test/perf-codex-api.test.js`；执行器有针对性缺口时扩充 `test/w1-executor.test.js`。

动作：

1. 覆盖 `/api/usage`、`view=dashboard`、`/api/summary` 和合法的 `detail=full`，新 models 不被精简响应或执行器消息丢掉。
2. 使用既有冻结流程：冻结后向夹具 live 来源追加记录，新 live models 更新，旧 snapshot 的 models/旧字段保持不变；未知或过期 snapshot 继续按现有 410 规则处理。
3. 验证排除目录、Codex 估算样本和 unsupported 来源；不暴露 sampleKey、sourcePath、sessionId 或原始样本载体。

通过条件：生产 API 路径拿到字段完整、与统计层一致的 models；无新增服务端分支或并行数据库连接。

## 5. U 模块：界面，共 4 卡

### U1 — 左表与局部样式

依赖：第 2 节字段已固定；可与 D1/D2 并行，使用字面量模型行，不等待真实来源。

写入：`public/perf-ui.js`、`public/styles.css`、`test/perf-ui.test.js`。

动作：新增模型表渲染函数，保留旧 perf-ui 导出行为。复用来源名、数字格式与 escapeHtml；四列、原始模型名与普通文字强度、对齐的数值/条形、选中左标记。添加只作用于新区域的五行滚动样式，表头和数据列共享宽度规则与滚动槽。

使用 0/1/5/6/11 行及长模型名检查高度和滚动。两张视觉表分离时，数据表仍保留可访问的列头关联；不能用 aria-label 一句话替代真正的单元格列头。优先在数据表保留视觉隐藏的语义表头，视觉表头 aria-hidden；不制造跨表的无效 headers 引用。

通过条件：小样本无黄字、全部有效行按传入顺序显示、溢出行无填充；模型/来源/强度均转义；不修改旧时间图和比较表的公共样式。

### U2 — 右栏与区间边界

依赖：U1（同一文件单写者）。写入：`public/perf-ui.js`、局部 CSS、对应 UI 测试。

动作：保持 round5 标题顺序、hero 和 bar 材质；只为区间增加定位和刻度。轨道上限沿用原型 `max(p90 * 1.15, averageTps * 1.05, 1)`，同时容纳平均值与两端。不得裁剪平均值使其进入分位带。

边界规则：

- 普通情况保持平均标签在上、两个端点在下；刻度始终位于真实比例。
- p10=p90 时合并下方端点说明为“慢端/快端 X”，保留平均刻度；n=1 也能读清三个统计量相等。
- 端点不同但标签实际边界相交时，端点说明改为轨道下方左右对齐的文字行；只调整标签，不挪动刻度，不扩高整个面板。
- 端点靠边时标签向面板内收口；支持平均值在带左侧或右侧、极低/极高数值、显示舍入后相等而原值不同。
- 溢出、空或重建时移除旧带与旧统计值，使用已有空状态语言。

通过条件：固定数据的值与几何一致，标签无重叠或越框；深浅主题的所有新 bar 填充 computed background-image 均为 none；解释句不使用“80% 的请求”。

### U3 — 正式页面与公共状态接线

依赖：D2、U2。写入：`public/index.html`、`public/app.js`、`public/app-state.js`、相关渲染测试。

动作：

1. 在指定落点加入独立区域，导入新渲染函数，在正式 render 路径消费 summary.perf.models；不恢复旧按性能 tab。
2. 新状态只保存选中 key。初次选第一条有效行；没有有效行而仅有溢出行时选首条；新集合为空则清空。刷新后仍存在的 key 保留。
3. 点击只修改选中态与右栏；不重新 innerHTML 左表。刷新确需重建行时保存 scrollTop 和区域内焦点，在新集合范围内恢复。
4. 来源与时间修改继续走现有 loadUsage、excludedHomes 和 usageLoadId；过期请求不能覆盖新选择。冻结时直接使用 snapshot 对应 models，不另发一条 live 请求。
5. 将模型区清理接入 renderEmptySummaryState、不可用配额等提前返回分支，避免其它区域清空而 TPS 留着上次数据。缺少 models 的响应显示已有空状态，不用旧 groups 临时拼接。
6. degraded 有健康 models 时继续显示；不能用 perf.ready=false 作为整表隐藏条件。

通过条件：真实生产渲染链路能显示夹具 models；目录排除/恢复、切换范围、刷新、冻结、空/错误状态都不残留旧行或旧详情。

### U4 — 键盘、读屏与双语

依赖：U3。写入：`public/perf-ui.js`、`public/app.js`、`public/i18n.js`、局部 CSS 与对应测试。

动作：复用项目按钮与 focus-visible 规则，为行选择提供真实可聚焦操作元素；Enter/Space 与点击等价，上下键在行间移动、保持选中行可见，Tab 可进入和离开区域。滚动区可聚焦，保持原生滚轮/拖拽行为。

所有新可见与读屏文本同时具备中英文，包括表头、来源、样本数、常见速度区间、合并端点、溢出及空状态；语言切换不改变 selected key。标题读序为工具→模型→强度，统计值均有文本出口，不只依赖颜色或条长。

通过条件：鼠标/键盘/读屏输出语义一致，无焦点陷阱；双语、主题和皮肤切换不丢选择、滚动或数据。

## 6. V 模块：集成验收，共 3 卡

### V1 — 稳定夹具的生产 API → DOM

依赖：D3、U4。由集成执行者在独立临时数据目录启动真实 createUsageServer、执行器、SQLite 与正式页面；扩充现有 perf-fixture 能力，禁止用只替换 fetch 响应的 mock 代替这一条链路。

至少覆盖：跨来源同模型、同来源跨 home 与主子代理合并、不同强度、小样本最快、均值在带外、刻度相同/接近、健康与失败来源并存、重建与空范围。一个聚合字段不能只验证存在；逐行核对 key、来源/模型/强度、平均值、分位数、n、排名和选中详情。

交互要实际执行：通过扫描目录编辑排除与恢复、切换时间、选择滚动区第 6 行、刷新保留选择、键盘上下/Enter/Space/Tab、语言/主题、在线冻结后修改夹具 live 来源。

通过条件：DOM 行与 API models 一一对应；没有来自被排除来源的残留；浏览器 pageerror=0，应用资源/API 无未定位失败。favicon 等已明确定位的无关响应单列，不笼统吞掉所有 console error。

### V2 — 整页视觉与有界真实冒烟

依赖：V1。视觉先对稳定夹具做，不通过重复扫描真实目录凑数据。

- 桌面整页：1920×1080、2560×1440；补充 1440/1024/720 CSS 宽度作为并排窗口/侧栏适配，不扩成新手机需求。记录真实 CSS viewport；不能把自动 viewport 改变写成实际 OS 显示缩放或 browser zoom 已测。
- 对当前 picker 开放的五款皮肤分别检查深浅主题的新区域，并保留 classic 检查；整页截图选择三款有代表性的皮肤。内部延期的其它五款不因此开放。
- 同屏检查原时间分布/详情、周期比较与新模型区：密度、左右比例、材质、标题层级、条形、焦点和五行滚动。不能只交局部裁图来证明整页协调。
- 真实数据只做一次有界冒烟，优先使用现有服务的冻结快照或已发布索引的隔离副本，不修改用户配置、不重启真实服务。验证实际 models 与页面对应；健康记录不足或来源持续变化时记录真实状态，不伪造覆盖。
- 真实检查若失败，先保留该次安全聚合、端点和可复现条件。修复后只复核受影响路径；不得因为同一活目录变化反复整仓重扫。稳定夹具证明本轮投影/UI，真实来源缺口由主审明确裁定范围，不把旧 reader 全部重新开卡。

通过条件：新增区域遵守 round5 的布局和原生材质；所有支持状态无溢出/标签碰撞/旧行残留；真实冒烟的覆盖与限制如实记录，未完成项不得写成通过。

### V3 — 当前代码门禁、文档与最终主审

依赖：V1/V2 的缺陷已修复并完成定向复核。

1. 记录当前受测 revision、改动文件和测试前后摘要；测试只使用隔离 fixture/临时输出。遵循开发文档对 tools/out 只读锚点的要求，不打开其中 SQLite。
2. 执行下节的工程检查一次。失败先在当次未修改基线上定向复现再归属；不能引用旧测试数量宣布“既有”，也不顺手修无关 SKIN/配额问题。
3. 更新 `docs/12-dashboard.md`、任务与文档入口，以及必要的 README 现有功能说明；长期规则只写一处，计划保留执行/证据链接。旧 G4 不挪给本轮。
4. 主审核对 API→DOM、统计手算、degraded、冻结、整页截图和当前门禁，给出明确结果：通过，或逐项列出未完成边界。部署、提交、推送、发布不在卡内。

通过条件：受影响测试通过；全仓结果有当前日志并如实列明失败/跳过及归属；视觉、统计、操作都有对应证据。没有只报“完成”而缺少实际产物或受测版本的交接。

## 7. 执行顺序与检查命令

数据链：D1 → D2 → D3。界面链：U1 → U2 → U3 → U4，其中 U3 等 D2。D1/D2 与 U1/U2 可并行；同一文件不能由两名执行者同时修改。随后 V1 → V2 → V3。

单 worker 时建议顺序：D1、D2、U1、U2、U3、U4、D3、V1、V2、V3。完成一张卡后继续已满足依赖的下一卡，不能只回复收到或复述现状。主审按模块复核，发现缺陷回到对应卡；不要求每个小改动都单独等用户批准。

已有命令与本轮新文件的预定命令：

```powershell
# D1：新文件在该卡创建后再运行
node --test test/perf-models.test.js test/perf-stats.test.js test/perf-summary.test.js

# D2：两路径、状态与既有来源隔离
node --test test/perf-summary-parity.test.js test/perf-state.test.js test/perf-codex-index.test.js

# D3：HTTP、执行器和冻结
node --test test/perf-server.test.js test/perf-codex-api.test.js test/w1-executor.test.js

# U 模块：新增用例并保留原有渲染、工具栏和刷新回归
node --test test/perf-ui.test.js test/app-render.test.js test/app-summary.test.js test/app-toolbar.test.js test/app-timeline-modes.test.js test/app-autorefresh.test.js

# V3：完成所有修改后执行；不把每卡都升级成一次全仓长跑
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run skins:check
npm.cmd run skins:palette
git diff --check
```

浏览器使用本机已有 Edge/Playwright 或项目现有工具，不新增生产依赖。正式受影响页面必须跑浏览器，HTML 字符串断言不替代 V1/V2。没有新改动、失败或未解决疑点时，不重复已通过的全套检查。

## 8. 交付和防止空转

实施恢复时才创建 `docs/validation/2026-10-21-model-speed-implementation/`，包括一个 README 执行账本和 D/U/V 各一份滚动报告；原始日志、截图和必要复现放相应子目录。任务卡状态只在 README 维护，避免在多份文档重复标进度。

每次交付必须写清：

- 本次完成的卡和实际文件/行为；当前受测摘要。
- 具体命令、exit code、结果及必要证据链接；有失败就列具体用例与归属。
- 下一张可执行卡及直接动作；有阻塞则写阻塞事实、已完成的独立工作和解除条件。

返工在同一模块报告追加原因、修复和复核，不再生成 v1–v4 的重复 handoff。历史失败保留，但入口只指向当前结论。相同失败第二次仍未缩小原因时，转交主审做最小复现与边界定位，不再原样重复全套或重复重扫；routine 实现和定向验证继续在卡内完成。

**执行者第一步：**读取本稿与产品方案，确认开始时实际 diff，记录基线；从 D1 建立手算用例并实现投影。如果接的是界面支线，从 U1 的固定字段夹具与左表开始。不要重新设计 round5，不恢复旧按性能入口，不先扫描真实 Codex 目录。
