# 模型速度视图：全局排名与区间详情

日期：2026-10-20。状态：**已暂停，计划与设计原型留档；未授权改产品代码**。

> 2026-10-20 暂停：用户决定先完成 SKIN 收尾，TPS 暂不实现；本计划与第五版原型作为后续恢复入口保留。当前优先级：SKIN → TPS → 计价 → SHARE。

本文只定义下一轮实现的产品口径、数据投影、界面结构和验收；不修改 `public/`、`src/` 或任何正式页面。第五版原型位于 [2026-10-20-tps-detail-panel-samples](../validation/2026-10-20-tps-detail-panel-samples/round5.html)。

> 2026-10-20 第五轮修订：
> - 左表重新按 agents 区分：新增来源列，一行 = **来源 + 模型 + 推理强度**。同一模型出现在不同 agents 中是允许的，分别占一行。
> - 右栏标题只显示一个 agents 名，不再出现一行对应多个来源的情况。
> - 左栏固定显示前 5 名，第 6 名起在栏内滚动；滚动条可用，表头保持可见。
> - 左右框体高度统一，以左栏 5 行高度为准。
> - 右栏样本数改为中文“样本数”，不再使用 `n=` 这种英文界面写法。
> - 速度条与区间带不再自造仿进度条：直接复用现有 `.bar-track` / `.bar-fill` 的轨道、材质、实心填充、圆角和高度；实际页面的条形由行内实色覆盖，基础渐变只是 fallback，不采用。区间带只增加定位和三点刻度。
> - 右栏仍然没有 tag、没有时间范围、没有排名、没有样本不足提示。

## 0. 用户已确定的方向

- 采用“分布带”方向，而不是三根并列横条。
- **模型和推理强度必须放在一起**：左表同一单元格、右栏同一标题行。
- **左表按 agents 分行**：中间增加来源列，显示 Codex / DSH / OpenCode / ZCode。
- 一个模型可以被不同 agents 使用；模型名重复是正常的，每个来源单独占一行、单独排名。
- **不按 agents 分成多个表格或分节**：所有行仍在同一张表里按平均速度全局排名。
- **右栏标题顺序固定为 agents 名、模型名、推理强度**；用弱化的中点分隔，不使用逗号。因为一行只属于一个来源，标题中只会出现一个 agents 名。
- **右栏没有任何 tag**：不用胶囊、边框标签或独立徽标表达来源、口径、样本状态。来源只用普通文字放在标题最左侧。
- **右栏不重复左表已有信息**：不写时间范围，不写“本周”，不写全局排名。
- **样本不足只在左表提示**：左表用黄字和 `—` 排名标记；右栏不再写“样本不足”或“暂不展示区间”。
- **左栏固定 5 行高**：显示前 5 名；第 6 名及以后在左栏内部滚动，滚动条必须可用，表头在滚动时保持可见。
- **左右框体等高**：以左栏的 5 行高度为基准，右栏拉伸到同一高度。
- 区间带必须直接给出精确数字和含义，不能只给一个色块。
- **真正复用现有 UI**：速度条和区间带使用正式页面的 `.bar-track` / `.bar-fill`，不再另造一套颜色、圆角、阴影或进度条材质。
- 左表速度条必须**左对齐**：所有行的条从速度列同一左边界开始，不因数值位数变化而漂移。
- **主视图不解释统计口径**：不显示“估算口径”“混合口径”“来源构成”等逐项说明；来源/估算/原生信息的区分留在内部数据与诊断中。
- **来源过滤必须真实生效**：过滤到某个来源时，左表只保留该来源的行；不能出现该来源完全没有的模型/行。

## 1. 目标与非目标

### 目标

1. 回答“在当前时间范围和来源选择下，各 agents 来源里的各模型（含推理强度）整体速度如何、是否稳定”。
2. 用一张全局排名表替代旧的“按来源/渠道/代理/计时口径切成 43 组”的呈现，但保留来源这一列，让用户一眼看出每行来自哪个 agents。
3. 左栏只露出前 5 名，靠滚动查看其余行；右栏与左栏等高，只补充该行的分布区间。
4. 同一模型在不同 agents 中分别排名，避免把不同来源的速度混成一个不可解释的数字。
5. 视觉上与现有 `detail-panel`、`bar-track`、`bar-fill`、比较表滚动区和 ceramic 材质保持一致。

### 非目标

- 不改 TPS 的定义、公式、阈值、来源 reader、SQLite 布局或 `methodVersion`。
- 不新增 TTFT、图表性能、错误率等其他指标；本轮只重做模型速度视图。
- 不新增配色 token、渐变、图表库或生产依赖；使用实心强调色填充，与正式页面实际使用的行内实色一致。
- 不提交、不推送、不发布。
- 不删除现有 `summary.perf.groups`；新视图是加法投影，旧 API 消费者不受影响。
- 不加入右栏来源切换控件。来源选择沿用页面已有的扫描目录/来源过滤链路。
- 不把主代理/子代理再拆成额外的行；它们仍并入同一来源行。

## 2. 产品口径

### 2.1 一行代表什么

一行 = **一个来源 + 一个模型原名 + 一个推理强度**。

行身份：

```text
[sourceKind, model, reasoningEffort]
```

以下字段**不参与行身份**：

- home / 渠道
- 主代理 / 子代理（`agentKind`、`agent`）
- 计时方式 / token 范围

规则：

- 同一模型、同一强度出现在不同 `sourceKind` 中时，**分别占一行**；模型名相同是允许的，各自排名。
- 同一来源、同一模型、同一强度的记录合并为一行；主代理/子代理、home、渠道都并入该行。
- 同一模型的不同推理强度是不同行；未记录推理强度的记录归入 `reasoningEffort = ""`，显示为 `—`。
- 来源列显示该行的唯一 `sourceKind` 名称；右栏标题也使用同一个名称。

**agents 的定义**：本文中的 agents 是来源工具的显示名，对应 `sourceKind`：

| sourceKind | 显示名 |
| --- | --- |
| `codex` | Codex |
| `dsh` | DSH |
| `opencode` | OpenCode |
| `zcode` | ZCode |

主代理/子代理字段（`agentKind`、`agent`）不参与本视图的列、标题或排名。

### 2.2 全局排名

- 所有来源的所有行参与同一个排名池，不按 agents 分成多张表、不按工具分节。
- 排名在**当前来源/时间过滤后的行集合**上计算；排除某个来源后，该来源的行必须从表中消失，排名重新计算。
- 排名按未舍入的 `averageTps` 降序；同值按规范 key 的 code-unit 顺序稳定排序。
- `n < meta.minSamples`（当前 20）或聚合溢出的行**保留数值但不参与排名**，统一排在所有已排名行之后，`rank = null`，排名列显示 `—`，行内显示金色 `样本不足`。
- 未排名行之间继续按 `averageTps` 降序排列，保证顺序稳定。
- 左表默认按平均速度降序展示；只露出排序后的前 5 行，其余行在左栏内部滚动。
- 排名只在左表以序号呈现；右栏不再显示排名，也不显示排名分母。

### 2.3 统计公式

对同一行的 sampled 记录集合：

```text
averageTps = Σ outputTokens / Σ durationMs × 1000
p10        = nearest-rank(p10)，对逐条记录的 TPS 计算
p90        = nearest-rank(p90)，对逐条记录的 TPS 计算
n          = 记录数
```

约束：

- 均值和分位数必须来自**同一批 sampled 记录**；不得平均旧 groups 的 p50/pooled，也不得用旧分组的分位数拼接。
- `nearest-rank` 与现有实现一致：`index = ceil(p × n) - 1`。
- 整数求和超出安全整数范围时，`state = "overflow"`，数值为 `null`，显示状态，不输出伪精确 TPS。
- 舍入只发生在显示层；排序、比较、门禁使用未舍入值。
- 界面显示 `样本数 N`（中文），不使用 `n=N`。

### 2.4 来源可见性与口径隐藏

每一行只属于一个来源，因此来源是行的身份字段，不再是“多来源合并”的附属信息。

- 左表来源列显示 `sourceKind` 名称；右栏标题显示同一个名称。
- 同一模型在不同来源中分别出现、分别排名；这是预期行为，不是重复数据。
- `timingKind` / `tokenScope` / `mixedMethods` / `estimateOnly` 只用于内部诊断与审计，**不进入主表、右栏标题或页脚**。
- 不显示“估算口径”“混合口径”“来源构成”等徽标或 chip。
- 文案避免“最快模型”这类绝对结论。标题用“模型速度”，说明用“平均速度”。

已知口径差异（来自 [perf-stats.js:99](../../src/perf-stats.js)，仅内部记录）：

| 来源 | timingKind | tokenScope | 说明 |
| --- | --- | --- | --- |
| ZCode | `request_e2e` | `reported_output_unspecified` | 请求端到端；输出范围源未注明 |
| DSH | `request_e2e` | `reported_output_unspecified` | step 时窗 |
| OpenCode | `request_e2e` | `visible_plus_reasoning` | message 时窗；输出+推理 |
| Codex | `item_span_estimate` | `reported_output_includes_reasoning` | 轮级 item 时窗估算；不含请求等待和工具时间 |

## 3. 数据投影

### 3.1 新字段

在 `summary.perf` 增加只读投影：

```js
models: PerfModelRow[]
```

```js
PerfModelRow = {
  key,                 // 规范 JSON key：sourceKind + model + reasoningEffort
  sourceKind,          // 行所属的唯一来源
  model,
  reasoningEffort,
  averageTps,          // Σ output / Σ duration × 1000；overflow 时为 null
  p10, p90,            // 同一 sampled 集合的逐条 TPS 分位；overflow 时为 null
  n,
  state,               // "ok" | "overflow"
  insufficientSamples, // n < meta.minSamples
  rank,                // 全局已排名行的序号；未排名为 null
  methods: [{
    timingKind, tokenScope, n
  }],                  // 仅内部诊断，主视图不渲染
  mixedMethods,         // 同一来源内计时/Token 口径不止一种时为 true；仅内部
  estimateOnly,         // 仅内部诊断，不显示徽标
  warnings: []          // 只保留 overflow 等真实异常，不在主视图展开
}
```

UI 只使用 `sourceKind` 生成左表来源列和右栏标题中的 agents 名；`methods`、`mixedMethods`、`estimateOnly` 不在主视图显示。来源显示名复用 [perf-ui.js:78](../../public/perf-ui.js) 的现有映射，不新增一套文案。

### 3.2 计算位置

- 在 `src/perf-stats.js` 增加纯函数 `projectPerfModels(selection, meta)`：
  - 消费 `summarizePerf` 已使用的同一 `selection.eligible` / sampled 判定；
  - 不重新读日志、不重新解释字段、不重算 eligibility；
  - 不改变现有 `groups` 的任何值。
- `src/usage-core.js` 的 `buildPerfStatsBlock` 是 memory/store 共用入口，在两条汇总路径同时挂上 `models`。
- `src/usage-types.js` 增加 `PerfModelRow` 类型说明。
- 不改 SQLite schema，不新增查询；投影只对已取出的样本数组做纯计算。
- `methodVersion` 保持 `tps-v1`；本次只增加投影，不改变测量方法。

### 3.3 边界规则

| 情况 | 规则 |
| --- | --- |
| `model` 为空/未知 | 不进入 `models` 排名；计数进入未识别模型诊断，主表不显示“模型未知”行 |
| `reasoningEffort` 为空 | 作为独立行，显示 `—`；不并入已知强度 |
| 同一模型+强度出现在多个来源 | **分别占一行**，各自有独立 `rank` 和统计；不合并 |
| 同一来源、同一模型+强度 | 合并为一行；home/渠道/主代理/子代理都并入 |
| 同一模型不同强度 | 分开两行 |
| n < 20 | 保留数值，不排名，排末尾；左表黄字提示；右栏仍显示区间带和精确值，不再重复说明 |
| 整数溢出 | `state = "overflow"`，无 TPS/分位/带；显示“聚合溢出”状态 |
| 空/重建/降级 | 不展示旧排名；表格只显示状态行；右栏清空或显示同一状态 |

### 3.4 测试

- 行身份：同一 `sourceKind + model + effort` 合并；`sourceKind` 不同则分开。
- 同一模型+强度在 Codex 和 DSH：产生两行，两行分别有 rank，互不合并。
- 同一来源下主/子代理、home、渠道：并入同一行。
- 同一模型不同强度：两行，互不合并。
- `mixedMethods`：请求端到端 + Codex 估算为 true；纯 DSH 为 false；纯 Codex `estimateOnly = true`。
- 小样本：n=19 不排名、排末尾、`insufficientSamples = true`；n=20 可排名。
- 未知模型：不进入 `models`；诊断计数增加。
- 溢出：不产生数值或伪排名。
- 来源过滤：只保留目标来源的行，其他来源的行和旧排名都不残留。
- memory/store 两路径 `models` 逐项相等（允许运行时间字段不同）。
- 旧 `groups` 与改动前逐项相等；旧测试不因新增字段失败。

## 4. 左表

### 4.1 列

| 列 | 内容 |
| --- | --- |
| `#` | 全局排名序号；未排名显示 `—` |
| 模型 / 推理强度 | 模型原名 + 普通灰色强度文本（同一行）；未记录强度显示 `—` |
| 来源 | 该行唯一来源名（Codex / DSH / OpenCode / ZCode），普通文字 |
| 平均速度 (tok/s) | 现有 `.bar-track` + `.bar-fill` 迷你条 + 数值；未排名行弱化 |

没有按来源分节，没有额外的 Agent 身份列。同一模型名可以出现在多行，只要来源不同。

“平均速度”表头**右对齐到数值列的最右端**，与数值右边界对齐；速度条本身仍从速度列同一左边界开始。不要让表头对着进度条右端，那会让人误以为表头描述的是条形末端。

### 4.2 固定高度与滚动

- 左栏固定高度 = 表头 32px + 5 行 × 42px + 上下内边距/边框；默认只显示前 5 行。
- **表头放在滚动区外**，固定在 5 行数据区上方；表头不设实色背景，直接透出面板渐变，避免在渐变面板上出现淡色亮块或深色阴影带。
- 第 6 行起在 `.r5-scroll` 内滚动；滚动容器高度 = 5 行，使用 `overflow-y: auto` + `scrollbar-gutter: stable`，保留原生滚动行为。
- 表头表与数据表使用同一 `colgroup` 和固定列宽；表头额外留出 8px 滚动条槽宽度，保证表头与数据列对齐。
- 数据区复用比较表的固定高度/`overflow`/`gutter` 模式：[styles.css:1133](../../public/styles.css)；不再给表头使用实色 sticky 背景。
- 滚动条为 8px 细条，颜色使用现有 `--muted` / `--track` 混合；保留原生滚轮、触控板、拖动和键盘滚动。
- 滚动区 `tabindex="0"` 并提供 `aria-label`，键盘可聚焦后滚动。
- 只有 5 行或更少时，不出现可滚动内容；左栏仍保持 5 行高度，使左右框体在桌面端稳定等高。
- 窄屏堆叠时左右不再强制等高；左栏仍保持 5 行滚动。

### 4.3 行样式

- 行高 42px，13px 字号，tabular numerals。
- 模型名过长时省略，`title` 和右栏保留全名；推理强度与来源不省略。
- 推理强度是**普通文字**（`11px`、`var(--muted)`），不使用 chip/badge。
- 来源列是普通文字（`12px`、`var(--muted)`），不使用 chip/badge。
- 迷你条**直接使用正式页面的 `.bar-track` / `.bar-fill`**：
  - 轨道高度 10px、背景 `var(--ceramic-well)`、`var(--neo-inset-small)`、圆角 999px；
  - 填充为实心 `var(--blue)`，`background-image: none`。正式页面的 `.bar-fill` 实际都由行内 solid chart color 覆盖；基础 CSS 里的渐变只是 fallback，不能当作实际视觉；
  - 宽度按 `averageTps / max` 计算，所有条从速度列同一左边界开始。
- 速度列使用固定 grid：`minmax(90px, 1fr) 52px`；数值在固定宽度列右对齐，不因数值位数变化而让条起点漂移。
- 未排名行：迷你条降低不透明度，排名 `—` 和 `样本不足` 都用金色普通文字；不参与排名但仍可选中查看。
- 选中行**不铺满整行底色**：用 2px 蓝色左标记和蓝色排名表示选中。这样可以避免表头与首行两块深色背景连在一起，看起来像一条奇怪的阴影。
- 表格下方不加大段说明，也不加页脚解释。

### 4.4 交互

- 点击行只更新右栏和选中态，不重建左表、不重置滚动位置。
- 点击行、Enter/Space、上下键更新右栏；悬停不重建左表。
- **来源过滤**：沿用现有扫描目录/来源排除链路。排除某些来源后，左表只保留仍有有效记录的行；不得残留该来源完全没有数据的模型或旧排名。本视图不新增来源切换控件；原型用 `?source=codex` 演示过滤后的状态。
- 刷新后按 `[sourceKind, model, reasoningEffort]` 保留选中；key 不存在时选中第一条已排名行；没有行时清空。
- 排序切换保持选中 key，不重置滚动或焦点；前 5 行跟随当前排序。
- 空/重建/降级：表格只显示一条状态说明，不展示部分排名。

## 5. 右栏

### 5.1 结构

```text
Codex · gpt-6.1-sol · max
81.6 tok/s                              样本数 207

[复用 .bar-track / .bar-fill 的区间带]
慢端 10% 58.2    平均 81.6    快端 90% 96.4

中间 80% 的请求落在 58.2–96.4 tok/s
```

- 标题只有一行，顺序固定为 agents 名、模型名、推理强度。
- 因为一行只属于一个来源，标题中只出现一个 agents 名。
- 不显示“估算口径”“混合口径”“来源构成”等标签或 chip。
- 不显示旧的覆盖诊断墙；覆盖诊断保留在既有覆盖详情/API。
- 不显示“本周”、时间范围、全局排名或排名分母。
- n<20 时也不加“样本不足”说明；左表黄字是唯一提示，右栏照常显示数值和区间带。
- 右栏高度拉伸到与左栏一致（桌面端）；内容顶部对齐，不因页脚或标签额外增高。

### 5.2 标题规格

| 片段 | 示例 | 样式 |
| --- | --- | --- |
| agents 名 | `Codex` | 12px、600、`var(--ink)` 68% 不透明度 |
| 分隔 | `·` | 11px、`var(--muted)` 60% 不透明度；前后 6px 间距 |
| 模型名 | `gpt-6.1-sol` | 14px、650、`var(--ink)` |
| 分隔 | `·` | 同上 |
| 推理强度 | `max` / `—` | 12px、600、`var(--muted)` |

规则：

- 单行标题固定为 `Codex · gpt-6.1-sol · max`。
- **分隔用视觉化的中点，不用逗号**；用户要的是三段顺序和层级，不是标点符号。
- 来源取当前行的 `sourceKind`；过滤后自然只剩目标来源。
- 不截断 agents 名；空间不足时整体换行。模型名允许在极长时断行，仍不使用省略号。
- 标题不使用胶囊、边框、底色或独立标签块。
- 不把 agents 名放进副标题、页脚、hover 提示或 tooltip 作为唯一出口；必须在左上角常驻可见。

### 5.3 区间带：复用现有 bar-track / bar-fill

区间带不再自造进度条材质，直接复用正式页面的两段样式：

- **轨道**：`<div class="bar-track">`。在 `.detail-panel` 内继承现有 `height: calc(10px * 4 / 3)`、`background: var(--ceramic-well)`、`box-shadow: var(--neo-inset-small)`、`border-radius: 999px`。
- **区间填充**：`<div class="bar-fill">`。继承现有 `.bar-fill` 的高度和圆角；填充为实心 `color-mix(in srgb, var(--blue) 40%, var(--ceramic-well))`，`background-image: none`。通过绝对定位的 `left` / `width` 表示 p10–p90 区间。这里关闭的只是基础 CSS 的渐变 fallback，和正式页面用行内实色覆盖 fallback 的做法一致。
- **三点刻度**：p10 / p90 用 1px `var(--muted)` 竖线，平均用 2px `var(--blue)` 竖线；数值 12px `var(--ink)`，名称 10px `var(--muted)`，tabular。
- 平均标记不再使用自造圆点/滑块；平均只由 2px 蓝色刻度线表达，避免看起来像进度条滑块。
- 标签按真实百分比放置，p10/p90 在轨道下方，平均在上方；边缘按左/右对齐收口。
- 解释句只保留一句：“中间 80% 的请求落在 X–Y tok/s。”
- 无障碍：整个区间提供文本摘要（含 p10/平均/p90 和样本数），不依赖颜色传达。

新增的只有“区间定位 + 三点刻度”；轨道材质、填充元素、圆角和高度来自现有 UI。填充统一为实心色，不使用基础渐变 fallback。

### 5.4 状态

| 状态 | 右栏 |
| --- | --- |
| 正常 | 标题（agents、模型、强度）+ hero + 区间带 + 一句解释；无标签、无页脚 |
| 来源过滤后 | 只显示过滤后仍有数据的行；标题只显示该行来源；不残留过滤前的行或 agents 名 |
| n<20 | 与正常状态相同，照常显示区间和数值；左表黄字是唯一提示，右栏不重复 |
| 溢出 | 不显示带；显示“聚合溢出”；不显示伪数值 |
| 空/重建/降级 | 右栏隐藏或显示同一状态文案；不保留上一条记录 |

`mixedMethods` / `estimateOnly` 是内部诊断字段，不对应 UI 状态。

## 6. 视觉与可访问性

- 只使用现有变量：`--panel`、`--ink`、`--muted`、`--line`、`--blue`、`--track`、`--ceramic-well`、`--neo-inset-small`、`--neo-raised-small`、`--shadow`。
- 不新增色板 token；不使用渐变。左表和区间带都用实心填充，`background-image: none`。
- 左表迷你条和右栏区间带都使用现有 `.bar-track` / `.bar-fill`；轨道材质、圆角和阴影复用，填充为实心强调色。
- 桌面端左右框体等高，以左栏 5 行高度为准；窄屏堆叠时右栏自然下移。
- 左栏数据区复用比较表的固定高度、`overflow-y: auto`、`scrollbar-gutter: stable`；滚动条使用 8px 细条，颜色来自现有 token。
- 表头放在滚动区外，无实色背景，直接透出面板渐变；表头表与数据表同步列宽。选中行用蓝色左标记而不是整行深色底；速度表头右对齐、速度条左对齐。
- 视觉表头与数据表分离时，正式实现要保留可访问的列头关联（例如同步双表 + aria 关联，或等效结构）；原型用 `aria-label` 概述列名。
- 右栏标题用中点做视觉分隔，不使用逗号；标题的层级靠字号、字重和颜色，而不是标点。
- 深浅主题和至少三款 skin 下检查：原生 bar 的轨道/填充对比、滚动条可见性、标题层级、刻度线。
- 1440 / 1024 / 720 宽度：来源列不截断 OpenCode；右栏在窄屏堆叠到表格下方；标题和刻度不溢出。
- 键盘、焦点、双语、屏幕阅读器文本与现有表格一致；滚动区可聚焦；标题读屏顺序为 agents → 模型 → 强度。
- 样本数在视觉和读屏文案中都使用“样本数”，不使用 `n=`。

## 7. 实现步骤（后续授权后）

1. **数据投影**
   - `src/perf-stats.js`：`projectPerfModels`，行 key 改为 `sourceKind + model + reasoningEffort`；同一模型跨来源拆行。
   - `src/usage-core.js`：memory/store 两条路径挂载 `models`。
   - `src/usage-types.js`：类型。
2. **左表**
   - `public/perf-ui.js`：全局排名表、来源列、模型+强度单元格、未排名行、纯文字强度/来源。
   - `public/index.html`：替换旧性能面板标记。
   - `public/app.js` / `public/app-state.js`：选中 key、排序、刷新校验；点击只更新右栏，保持滚动位置。
3. **左表滚动**
   - `public/styles.css`：表头与 5 行数据区分离、表头无实色底、`overflow-y:auto`、`scrollbar-gutter:stable`、8px 细滚动条；表头/数据表同步列宽。
4. **右栏与区间带**
   - `public/perf-ui.js`：单来源标题、hero、`样本数`、复用 `.bar-track` / `.bar-fill` 的区间带、状态。
   - `public/styles.css`：只增加区间定位和三点刻度；不覆盖现有 bar 材质。
   - `public/i18n.js`：所有新文案；删除右栏时间/排名/样本不足文案。
5. **移除旧呈现**
   - 移除 M5 的覆盖诊断墙、按来源/代理/计时口径分组的性能 DOM；保留原有覆盖详情入口或按计划迁移。
   - 不删除 `summary.perf.groups` 数据；只停止用它渲染主视图。
6. **验证**
   - 单元、UI、浏览器、深浅/skins、窄屏；更新看板文档与验证 README。

### 文件归属

| 文件 | 所有者 |
| --- | --- |
| `src/perf-stats.js` | 数据 owner |
| `src/usage-core.js` / `src/usage-types.js` | 数据 owner（共享文件串行） |
| `public/perf-ui.js` | UI owner |
| `public/index.html` / `styles.css` / `i18n.js` | UI owner（共享文件串行） |
| `public/app.js` / `app-state.js` | UI owner（串行接线） |
| 测试 | 各 owner 按文件 |

本计划不涉及 `src/perf-sources/**`、`src/server.js`、SQLite schema、`package.json` 或新依赖。

## 8. 验收

### 数据

- `models` 的 average/p10/p90/n 与手算 fixture 一致；同一行使用同一 sampled 集合。
- 行 key 包含 `sourceKind`；同一模型+强度跨来源产生两行，分别排名。
- 同一来源、同一模型+强度下的主/子代理、home、渠道并入一行。
- 未知模型排除、n<20、溢出、稳定排序、来源过滤全部有测试。
- memory/store 两路径的 `models` 逐项相等；旧 `groups` 逐项不变。
- 不向 API 暴露 sampleKey、sourcePath、sessionId 等内部字段。

### UI

- 左表有来源列，显示 Codex / DSH / OpenCode / ZCode；同一模型名可出现在不同来源的多个行。
- 左表默认只露出 5 行；第 6 行起在栏内滚动；滚动条可见、可用。
- 表头固定在滚动区外，不随数据行滚动；表头无实色亮块，且与数据列严格对齐。
- 桌面端左右框体高度一致，以左栏 5 行高度为准。
- 左表速度条左对齐；使用现有 `.bar-track` / `.bar-fill`，填充为实心色、`background-image: none`，不使用基础渐变 fallback。
- “平均速度”表头右对齐到数值列最右端，与数值右边界对齐；不能对着进度条右端。
- 表头与首行之间没有连成一条深色阴影带；选中行用 2px 蓝色左标记和蓝色排名。
- 未排名行在末尾且只有金色 `样本不足` 标记；右栏没有样本不足提示。
- 右栏标题严格为 `agents 名 · 模型名 · 推理强度`；中点分隔，不是逗号；一行只出现一个 agents 名。
- 右栏 hero 显示“样本数 N”，不出现 `n=`。
- 右栏不出现任何 tag/chip/badge；不出现“仅 Codex”“小样本”“估算口径”“混合口径”“来源构成”等文案或视觉组件。
- 右栏不出现“本周”、时间范围、排名或排名分母；底部没有页脚。
- 右栏区间带使用现有 `.bar-track` / `.bar-fill`；p10/平均/p90 精确值一致；平均只用 2px 蓝色刻度线，不用自造圆点。
- 来源过滤后不残留其他来源的行；右栏标题只显示该行来源。
- 点击行不重建左表、不重置滚动；选中态和右栏同步。
- 键盘、焦点、刷新、i18n、深浅主题和 skin 通过。
- 无新 token、无渐变、无覆盖现有 bar 材质、无覆盖诊断墙、无右栏 tag；所有 bar 填充 `background-image: none`。

### 文档

- 实现完成后更新看板说明、README 入口和验证证据；计划本身不冒充已完成。

## 9. 待用户确认

1. 区间带三点刻度方案是否定稿；第五版原型继续按此实现。
2. n<20 行是否按当前方案“保留数值、不排名、排末尾、右栏照常显示区间”；如果更希望隐藏区间，需要改状态。
3. 左表来源列的列头当前用中文“来源”；如果希望字面显示 `agents`，需要改 i18n 文案。
4. 未识别模型是否按计划排除出主表，只在覆盖率诊断中保留（推荐是）。

已确认、不再询问：左表按 source+model+effort 分行；同一模型可跨来源重复；右栏标题只有一个 agents 名且用中点分隔、不用逗号；“平均速度”表头右对齐到数值右边界；左栏 5 行滚动、左右等高；速度条/区间带复用现有 `.bar-track` / `.bar-fill`；样本数用中文。

## 10. 本轮交付

- 第五版原型：`http://127.0.0.1:3767/round5.html`；源码在 [round5.html](../validation/2026-10-20-tps-detail-panel-samples/round5.html)、[round5.css](../validation/2026-10-20-tps-detail-panel-samples/round5.css)、[round5.mjs](../validation/2026-10-20-tps-detail-panel-samples/round5.mjs)。
- 评审用 URL：`?source=codex` 模拟来源过滤；`?select=codex-luna-max` 查看滚动到未排名小样本行。
- 截图：`round5-all-dark.png`、`round5-codex-dark.png`、`round5-small-dark.png`、`round5-all-light.png`、`round5-all-1024.png`、`round5-all-720.png`，位于同一目录。截图使用 headed Edge，以便显示原生滚动条。
- 没有修改任何产品源文件；原型使用模拟数据，只用于确认信息结构和视觉方向。
