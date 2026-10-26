# UI 几何稳定性计划

更新：2026-10-26。状态：**本轮 UI 施工与专项验收完成，报告字段契约失败已修复并通过定向回归**。本文是 UI 几何与文本稳定性工作的唯一规格入口。

本稿回答一个问题：怎样让"框体之间的缝隙"和"框体自身形状"在**所有状态、所有语言、所有数据**下都保持你设计时的样子，而不是每加一个功能就漂一点。

> 本稿在 2026-10-25 用 Windows 本机 + Chromium 1248 做过一轮独立复核，修正了若干数字与写法。复核脚本在 `output/geom-probe/`（未入库），对照表见 §8.1。凡标注「本机复核」的段落都是那轮实测的结论。

2026-10-26 的复审意见已合并到正文，集中说明见 §1.1，技术纠错依据见 §8.2。`output/geom-probe/new-section-5.md` 是较早的测试草稿，仅作历史参考，不再作为并行规格。

施工交付见[双 worker Implementation Plan](2026-10-26-ui-geometry-stability-implementation-plan.md)及[验收记录](../validation/2026-10-26-ui-geometry-stability.md)：15 张中等大小任务卡已完成，worker 创建均显式使用 `group/deepseek`；主审接回后期回归并完成整合。16 项 UI 回归与八组合 40 图完成，最后一项报告字段契约失败已修复，报告相关 17 项及计价快照 1 项定向复测通过。本文继续作为设计规格入口，不并行维护另一份施工状态表。

## 0 决策摘要

| 事项 | 结论 |
| --- | --- |
| 病灶一 | **部分文字行高未明确**。旧盘点中 79 条规则设了 `font-size`，26 条同时声明 `line-height`，仍需检查继承后的计算值。旧静态样本中 **35 个可见文字节点**计算为 `normal`（弹窗全开时 **51 个**），不代表完整界面的覆盖数量 |
| 病灶二 | **几何没有单一真源**。颜色有 `skin-palettes.js` + `skins:palette` 校验；几何有 83 处 `gap`、21 种 `border-radius`。4 个容器的间距来源需按组件样板收敛；`fieldset.source-picker-field` 还涉及 legend 的特殊布局，不能按普通网格判断 |
| 病灶三 | **没有测试**。测试文件里零条断言元素溢出或框体被撑变形（磁盘 178 个 `*.test.js`，跟踪 95 个） |
| 主要现象 | 现有样本中横向框体多数稳定，纵向存在字体行盒差异与换行增高；明确行高只是基础修正之一 |
| 优先级 | 文案约束立即生效 → P2 几何 token → P3 生产样板 → 按区域落实 P1 排版、P4 间距规则与 P5 文案清理 → P6 正式回归测试 |
| 修复代价 | 保留方案 A 尽量维持现有观感的思路，但需修正行高测量方法；静态探针 Δ 0 不能推出完整应用零变化。基准采用用户认可的画面，不自动指定英文 |
| 文案约束 | 常驻说明须证明对当前操作的具体价值；机制、估算口径与边界解释默认主动展开，不通过新增徽标或问号继续堆积 |
| 不做 | 不给常驻文字设字数上限；不做手机适配；不改视觉语言 |

## 1 问题陈述

用户对 agent 改 UI 的四类反复失败：

1. 框体间的十字缝逐渐宽度不统一
2. 该对齐的框体逐渐不对齐，或在非常规状态下变形
3. 新功能框体不按已有框体的风格设计
4. agent 为撇清责任做防御性过度编程，把解释与警告文本塞进框体，撑变形

用户的美学原则（2026-10-24 原话）：

> 我并不是强迫症地要求所有缝隙必须相等……绝大多数互相关联的缝隙它们理应等宽。我不否认存在例外，但如果这种例外不是来源于我单独要求的设计，那么大概率这种例外就是一个 bug。

关键判据：**例外必须能追溯到一条明确的设计决定，否则按 bug 处理。**

### 1.1 2026-10-26 复审意见

本次复审支持主计划的核心方向：把用户认可的视觉结构固化为后续 agent 必须遵守的规则。以下意见用于调整实施安排，尚未实施 UI 改动。

1. **文案约束从第一步生效。** 常驻说明的保留理由不能只有“内容属实”或“可能有用”。系统机制、估算口径、覆盖范围与边界情况等解释默认收进用户主动展开的详情；也不应把每段说明机械替换成徽标、问号或提示图标。保留常驻说明的举证责任在 agent。用户已明确费用估算框内的既有详情直接展示，不加折叠入口；说明清理不得自行改变这一展现方式。
2. **几何 token 与生产样板是主线。** 先让代表性面板、指标卡和标题行实际共用几何变量；样板直接复用生产 CSS，并从用户认可的现有组件提取，供后续 agent 复用。
3. **按设计验收稳定性。** 用户指定稳定的框体，在正常、空、加载、错误状态之间保持约定尺寸与对齐。列表数量增长、主动展开等变化分别规定行为；技术上允许的 margin、分组间距或动态内容，不构成 agent 自行增加设计例外的理由。
4. **行高是基础修正，测量方法需纠正。** `Range` 文本矩形不等于 CSS 行盒，固定行高也不能消除换行增高。保留方案 A 维持观感的目标；若本轮统一排版，可直接确定少量规格，无需先逐个固定所有历史值再重做。
5. **正式测试按既定安排后置。** token 与样板完成后，再验证框体、对齐、缝隙和内容显示；`normal` 清零只能作为排版检查之一。先点名关键容器，不开发解释全站 CSS 的通用布局扫描器。
6. **小数误差降级处理。** 修正亚像素探针的比较对象，不为 `0.015625px` 改变列结构；优先修复肉眼可见的间距不一致与框体变形。

这些技术勘误随对应步骤处理，不扩成 UI 整理之前的额外基础设施工程。

## 2 实测方法与结果

### 2.1 方法

Playwright + 本地 fixture 服务，真实数据（zcode + dsh + opencode 三来源），1920×1080 / DPR 1。浏览器与仓库里的 `playwright-core` 版本不匹配，使用 npx 缓存中的入口；沙箱缺 `libXdamage.so.1`，用 gcc 编译 stub 通过 `LD_LIBRARY_PATH` 注入。

覆盖 8 个状态：主页面、历史展开、pricing 弹窗、import 弹窗、skin 弹窗、深色、窄视口 1280、中英文双语。共 4 个视口宽度（1920 / 2560 / 1440 / 1366）× 2 语言。

### 2.2 横向：稳定

对页面内 **136 个**承载文字的叶子节点逐个注入 45 字符不可断字符串，测量所有容器宽度变化：

- **135 个**节点宽度完全不变
- 唯一变化：`h1`（`Agent Usage`），261.9px → 1166px。标题不参与栅格

数据值本身有保护。实测 `#totalTokens = "1,234,567,890,123"`、`#totalCost = "$1,234,567.89"`、48 字符模型名：

```
自身宽 195.3 → 195.3    父级宽 223.3 → 223.3    grid 宽 1440 → 1440
横向溢出: true          overflow: hidden        white-space: nowrap
```

只发生内部省略，卡片与栅格分毫不动。

**结论：横向没有「文字撑宽框体」的问题。** 用户最初的怀疑（"横向与纵向都有"）在横向不成立——这是我需要明确纠正的一点。

### 2.3 纵向：普遍且真实发生

同一批注入里 **57 个**节点改变了高度，其中 **56 个只改变高度**。

不需要极端数据，**切换语言就能触发**：

| 元素 | en-US | zh-CN | Δ |
| --- | --- | --- | --- |
| `.range-heading` | 18 | 19 | +1 |
| `.auto-refresh-label` | 15 | 19 | +4 |
| `.date-range-values` | 14 | 17 | +3 |
| `.auto-refresh-well` | 78 | 79 | +1 |
| `.toolbar` | 106 | 107 | +1 |

`.range-heading` 明确声明 `min-height: 18px`，中文行盒 19px 直接顶穿这个下限——**声明了尺寸下限，但下限保护不了自己**。

这 1px 沿页面累积（1920×1080，真实数据）：

```
区块            en       zh       Δ
toolbar        114      114      0.00
metrics1       240      241      1.00
metrics2       366.19   367.19   1.00
strip          492.38   493.38   1.00
mainGrid       586.77   587.77   1.00
periodGrid    1287.77  1288.77   1.00
bottomGrid    1899.36  1904.36   5.00
history       2391.36  2408.36  17.00
文档总高       2581     2603     22.00
```

**已复现的一项成因**：部分文字继承后的 `line-height` 为 `normal`，拉丁与 CJK 回退到不同字体时可能产生行盒高度差。旧盘点中 79 条规则设了 `font-size`，26 条同时声明 `line-height`；是否受影响仍须看继承后的计算值，不能把余下 53 条全部视为实际依赖 `normal`。换行造成的增高需另按组件排版处理。

> **复现条件（2026-10-25 本机复核补充）**：上表只有在"拉丁与 CJK 落到**不同**物理字体"时才出现。本机默认字体栈下中英文都落到 `Noto Sans SC`，`locale-switch-probe` 扫 79 个叶子节点零变化、`.shell` 两侧全等——即上表在本机默认环境下复现不出来。强制 `--ui-font-sans: "Segoe UI", "Noto Sans SC", sans-serif` 后，本机复现出 9/79 个叶子变化、整页 −4px，量级与上表一致。
>
> 这不削弱结论，但改变了测试的写法：**断言不能只比顶层容器**（本机 `.toolbar` 中英都是 107，会漏掉 `.empty` 这类变化），必须逐个叶子比，并且必须先强制字体分裂。详见 §5.0 / §5.2 / §8.1。
>
> 另：上表把口径写成"79 条设了 `font-size` 的规则"，实测有漏——`.empty`（`public/styles.css:1574-1577`）自己不设 `font-size`，继承 `body` 的 16px，中英差 2px。判定应按**计算值是否为 `normal`**，不按**是否声明了 `font-size`**。详见 §5.1。

### 2.4 横向对齐的亚像素误差

对 `.shell` 右边缘测每个顶层容器的 `Δright`：

```
topbar / toolbar / metrics×2 / comparison-strip / main-grid
period-grid / bottom-grid / history-panel        → 0.0000  ✓
.main-grid 末列                                   → -0.0156  ✗
.comparison-strip 末项                            → -0.0156  ✗
```

`.main-grid` 是 `repeat(3, minmax(0,1fr))` 且 `.chart-panel` 跨 2 列。`(1440 − 2×20) / 3 = 466.666…` 除不尽，末列比其它容器短 0.0156px。

`.period-comparison-grid` 和 `.bottom-grid` 是 2 列，`(1440−20)/2 = 710` 整除，所以完美对齐。

六列 `.metrics` 的亚像素相位：1440 视口时全为 0；1920 时 `[0, 0.328, 0.656, 0.984, 0.328, 0.656]`；1366 时 `[0, 0.656, 0.328, 0, 0.656, 0.328]`。像素级确认（DPR=1）缝隙跨度是 `[13, 15, 21]` 循环，DPR=2 是 `[24, 28, 44]`——8px / 20px 的跨度，不是抗锯齿噪声。

> **本机复核及 2026-10-26 纠错**：相位 `[0, 0.328, 0.656, 0.984, 0.328, 0.656]` 在 1920@DPR1 **精确复现**（`.metrics` 实际 12 个 `.metric` 子项，两轮相位重复）。原探针的 `lastColDelta` 比较 `.main-grid` 与 `.comparison-strip` 的末项，结果为 `0` 只表示两者右边缘相同。原始数据中两者均为 `1679.9844`，而 `.shell` 为 `1680`；相对 `.shell` 的 `−0.015625px` 已在独立复核中复现（§8.2），撤回“本机复现不出来”的判断。
>
> 仍不把这个小数差作为本轮失败断言（§5.6），也不据此改列结构。DOM 间距与阴影、高光、圆角形成的视觉缝隙需分别检查，不能仅凭亚像素相位解释肉眼看到的全部差异。

### 2.5 同类元素两套标准

| 元素 | 抗压策略 |
| --- | --- |
| `.metric strong` | `nowrap` + `overflow:hidden` + `ellipsis` |
| `.comparison-item strong` | 只有 `font-size: 18px; line-height: 1.1` |

两者视觉上都是"卡片里的主数值"，抗压能力不同。

### 2.6 死代码在示范错误做法

`public/app.js:220` 的 `fitTextToWidth()` 被导出、在 `test/app-render.test.js:1008` 有单测，但**没有任何生产调用点**。

它的全部作用是在文本超出时缩小字号——正是"为了塞下内容而让框体变形"的思路。现在是死代码，但它留在代码里，等于向读代码的 agent 传递"这样做是可以的"的信号。

### 2.7 弹窗的缝隙声明与实际不符

8 状态扫描结果，主页面只有 1 处良性 flex 问题（`.panel.chart-panel`，vGaps `[18, 0]`）。弹窗问题明确：

| 容器 | 声明 | 实际渲染 |
| --- | --- | --- |
| `#pricingForm` | `gap: 14px` | 24 / 14 / 38 |
| `.pricing-harness-group` | `gap: 6px` | 8 / 6 |
| `#importForm` | `gap: 0` | 14 / 20 / 24 |

`#importForm` 的声明被子元素 margin 完全架空。4 个 `.pricing-model-row.pricing-model-unpriced` 的横向缝隙分别是 `[12, 383.31]`、`[12, 397.94]`、`[12, 413.53]`、`[12, 358.44]`——每行右边缘都不同。

> **本机复核（2026-10-25）**：三行里两行成立、一行数字不准、一处是误判，另外**多找到一处**。
>
> - `#importForm`：**成立**。实测 6 个子项 5 个缝隙 `14 / 20 / 20 / 0 / 24`，全部来自子元素 `margin-top`（`.dialog-copy` 14px、`.source-picker-field` 20px、`#importForm > label` 20px、`.dialog-message` 0、`.dialog-actions` 24px）。上表写 `14/20/24` 是抽样，完整值是 `14/20/20/0/24`。
> - `#pricingForm`：**现象真、数字不准**。实测 8 个子项 7 个缝隙 `24 / 24 / 24 / 14 / 14 / 24 / 14`，不是 `24/14/38`。原因：`.pricing-auto-row`（`public/styles.css:1731-1737`）`margin: 10px 0`、`.dialog-copy`（`public/styles.css:1611-1617`）`margin-top: 10px`，叠加 grid `gap:14px`。
> - `.pricing-model-row.pricing-model-unpriced` 的 `[12, 383.31]` 等：**误判**。`.pricing-model-row`（`public/styles.css:1821-1830`）是 `justify-content: space-between`，`.pricing-rematch-button`（`public/styles.css:1870-1874`）带 `margin-left: auto`，那个 383.31px 是 `auto` 吃掉剩余空间的结果，**不是 gap**。真实渲染：三个子项 `top` 为 627.23 / 633.23 / 627.23（baseline 对齐本就不在同一线），按钮 `margin-left: 354.562px`，行宽 854。
> - `.pricing-harness-group`：**已确认成立**（原稿写"待确认"）。实测缝隙 `8 / 6`，多出的 2px 是 `h3` 的 `margin: 4px 0 2px`（`public/styles.css:1814-1819`）在 grid 里不塌陷、直接叠在 `gap: 6px` 上。
> - **本表漏了一处**：`fieldset.source-picker-field` 声明 `gap: 8px`，实测唯一一条缝是 `10px`，且把 `gap` 设 0 后**仍是 10px**——声明的 8px 完全没生效，那 10px 全部来自子元素 margin。
> - **`.pricing-toolbar` 也是同类但应排除**：声明 `gap: 10px`，`#pricingSearch` 与 `.pricing-rate-label` 之间 416.73px。原因是 `.pricing-rate-label`（`public/styles.css:1780-1787`）带 `margin-left: auto`，与 gap 无关。
>
> 这直接影响 gap 断言的写法：必须排除 `space-between` / `margin: auto` / 不同行三类容器，否则会把正确布局判成 bug。详见 §5.3。

### 2.8 测试覆盖：零

测试文件中**没有任何一条**断言元素溢出或框体被文本撑变形（磁盘 `test/*.test.js` 共 178 个，git 跟踪 95 个；本稿初稿写的"90 个"是当时快照，已过时）。所有 `scrollWidth` / `scrollHeight` 出现处都是 DOM mock（`test/app-autorefresh.test.js:218`、`test/app-render.test.js:1012`、`test/skin-palette-detail-bar-browser.test.js:75`、`test/skin-palette-input-placeholder-geometry.test.js:170`）。

`test/skin-palette-quality.test.js` 有 23 次 `getBoundingClientRect` 和 63 次 `getComputedStyle`，但全部服务对比度、色彩数学与聚光灯几何，没有一次用于布局稳定性。

`grep -rn "scrollWidth\s*[<>]\|scrollHeight\s*[<>]\|overflowing\|isOverflow" test/ src/ public/` 只返回数据层匹配（`test/perf-probe-codex.test.js:1492` 的 `overflowingSpanCount`、`src/usage-types.js` 的排名溢出注释）和 `fitTextToWidth` 自身。

**结论：完全无覆盖。** 现有 2658 项测试通过，不能说明框体不会变形。

## 3 建议

### 3.1 P1 · 明确行高与文本槽位（按区域落实）

**规则**：代表性组件的字号与行高按样板确定，检查计算值及继承关系；仅盘点显式声明 `font-size` 的规则会漏掉 `.empty` 等继承型文本。

明确行高可以减少字体回退带来的单行高度差，但不能消除换行增高。撤回“直接消掉全部 56 个只改高度节点”的概括，文案安排、列宽和组件排版需一起满足框体约定。

**方案 A · 维持现有观感**：保留尽量维持现有画面的目标，基准采用用户认可的画面，不自动指定英文。按区域确定行高，并验证两种语言及该区域的正常、空、加载、错误状态。

`option-a2.mjs` 去掉了应用脚本，得到的是特定字体和静态页面上若干容器高度 Δ 0 的结果。它不能证明完整应用或所有文字零变化，也不能直接作为生产行高的生成方法：`Range.getClientRects()[0].height` 测量文本矩形，不等于 CSS 行盒；元素总高也不能直接充当多行内容的行高。量取无内边距、边框的单行块或相邻行的基线间距，并用实际组件尺寸与画面核对（§8.2）。

**方案 B · 统一少量排版规格**：若本轮调整包含排版统一，直接确定正文、小字、数值、标题的少量规格，由同类组件共用。无需先把全部历史值固定下来再做第二轮调整。

`body { line-height: 1.4 }` 在旧静态样本中使 `.shell` 缩短 5.64px，只保留为探针验证手段，不据此确定全站行高。`font: inherit` 会让行高随父级继承；检查覆盖顺序，不能把继承本身当作错误。

`.range-heading` 等框体的尺寸约定需与文本槽位一同确定。`min-height` 只规定下限；需要固定尺寸的区域，须明确其实际尺寸与内容安置方式，不能把超过下限本身解释为 CSS 失效。

### 3.2 P2 · 几何 token 层

颜色已经有单一真源和校验（`skin-palettes.js` + `npm run skins:palette`）。几何没有。现状：

```
gap 声明 83 处，取值 20 种：6px×14, 12px×14, 8px×13, 10px×7, 4px×4, 7px×3,
                            3px×3, 2px×3, 14px×3, 5px×2, 20px×2, 1px×2, 16px×2,
                            以及 8px 12px / 8px 10px / 6px 12px / 5px 16px / 4px 7px / 3px 7px / 2.5px
border-radius 声明 78 处，21 种取值：6px×11, 999px×9, 0×9, 8px×6, 16px×5,
                                    9px×4, 18px×4, 13px×4, 10px×4, 21px×3, 11px×3,
                                    3px×3, 50%×2, 4px×2, 17px×2, 15px×2, 5px, 2px, 24px, 14px, 12px
```

**新增 token**（写在 `styles.css` 基础调色板块，与现有 `--neo-*` 并列）：

```css
/* 间距候选：先在代表性组件中核对用途与取值 */
--space-1: 4px;    /* 图标与文字、紧凑行内 */
--space-2: 8px;    /* 控件内部、小间隙 */
--space-3: 12px;   /* 面板内元素间距 */
--space-4: 20px;   /* 顶层栅格缝、面板内边距 */

/* 圆角：四级 */
--radius-panel: 21px;    /* 顶层面板、对话框 */
--radius-card: 17px;     /* 指标卡、对比项 */
--radius-control: 18px;  /* 按钮、输入框 */
--radius-inner: 9px;     /* 面板内的小块、凹槽 */
```

**不追求一次替换完**。先建立 token 并在新代码里使用，旧声明按"改动时顺手替换"推进。一次性替换 161 处，风险大于收益。

**首批验收**：选取用户认可的代表性面板、指标卡和标题行，让关联的顶层缝隙、面板内边距及同类圆角实际共用 token；不能只新增变量、旧样板继续各自硬编码。上述取值是候选，按组件用途核对，不以凑齐四级为目标。

**关键约束**：token 只影响几何，皮肤配色绝不改变布局几何（已有规则，此处重申）。

### 3.3 P3 · panel-anatomy 样板页

放在 `docs/panel-anatomy.html`（或 `docs/plans/assets/`），从用户认可的现有组件提取，**直接复用生产 CSS**，供 agent 使用；不另行维护一套演示样式。

现状面板标题行的三种写法（`public/index.html`）：

```html
<!-- 253 行：标题 + 状态文字 -->
<div class="panel-heading"><h2 id="detailPanelTitle">详情</h2><span id="detailModeLabel">按渠道</span></div>

<!-- 293 行：标题 + 操作按钮 -->
<div class="panel-heading"><h2>扫描目录</h2><button id="addImportButton" class="panel-action" type="button">编辑</button></div>

<!-- 312 行：summary 里做标题行 -->
<summary class="panel-heading"><h2>历史归档</h2><span>展开 / 收起</span></summary>
```

三种都是合法的（`.panel-heading` 是 `flex` + `space-between` + `gap: 12px` + `margin-bottom: 12px`），但没有一处写明"什么时候用哪种"。

样板页需要覆盖：

1. **标准面板**：标题行（左标题 + 右动作）+ 内容区，含正确的 padding / radius / gap
2. **标题行的三种合法变体**：右槽放状态文字 / 右槽放按钮 / 右槽放展开控件
3. **四个状态**：正常、空、加载、错误——指定稳定的框体保持约定尺寸与对齐，内容在既定槽位安排；列表增长、主动展开等变化分别写明布局行为
4. **指标卡**：主数值的 `nowrap + ellipsis` 写法
5. **反面清单**：明确写出禁止的做法（见 3.5）

样板页的价值不在"好看"，在于**agent 有具体的东西可以抄**，而不是自己发明第 22 种圆角。

### 3.4 P4 · gap 断言

**规则**：先点名关键容器及其在样板中应满足的缝隙、边缘对齐关系，再按实际布局轴验证。普通 grid / flex 内部间距优先由父级统一控制，避免子项 margin 无意叠加。

“实际缝隙等于 `gap`”只适用于约定由纯 gap 控制的相邻项目，不扩成全站通用判据。`space-between`、auto margin、baseline 对齐与 fieldset / legend 需按组件结构测量；CSS 写法合法不构成设计例外，已有差异仍须对照用户认可的样板收敛。

**例外白名单**：只记录能追溯到用户明确设计决定的差异，附原因；不得为了让测试通过追加例外。

§5.3 的 gap=0 对照测量保留为诊断工具，用来解释 gap 对距离的贡献，不能单凭它判定设计正确与否或自动跳过检查。本轮不建立解析全站 CSS 层叠与布局类型的通用扫描器。

### 3.5 P5 · 文本规则（替代"40 字上限"）

最初提的"任何面板内常驻说明文字不超过 40 字"被用户判定为太过强行，撤回。

修订后的规则：

> **常驻文字只能回答「我现在该做什么」。任何回答「系统现在是什么状态」的文字，必须收进可展开的详情或 tooltip，不得常驻。**

这条对应第 4 类失败：agent 把"缓存未命中时费用可能低估""价格来自 X 日期""本数据不包含 Y"这类免责说明铺在面板里。它们不是用户此刻要执行的动作，是 agent 在撇清责任。

pricing 弹窗是重灾区。实测 30 个可见文字节点、418 字符，其中两行超过 90 字，全是"系统现在是什么状态"；`.pricing-model-hint` 在 4 个未定价模型上重复同一句 17 字提示。具体清单见[几何审计 §6](../validation/2026-10-25-ui-geometry-audit.md#六pricing-弹窗的文字构成)。

**本约束从第一步生效，不等待 P5。** 正式清理随对应区域推进。保留常驻说明须证明它对当前操作的具体价值，不能仅凭“内容属实”“可能有用”或 agent 自行想到的风险；也不把每段说明机械替换成徽标、问号或提示图标继续占据界面。技术查证与验证由实现承担，不让用户通过阅读额外文案或反复纠偏来承担。

## 4 分阶段实施计划

| 阶段 | 内容 | 依赖 | 验收 |
| --- | --- | --- | --- |
| 文案约束 | 按 §3.5 限制新增常驻说明 | 立即生效 | 不因解释机制或边界情况增加提示、徽标和框体 |
| P2 | 建立几何 token，并接入代表性现有组件 | 无 | 关联间距与同类圆角实际共用变量 |
| P3 | 复用生产 CSS 的 panel-anatomy 样板页 | P2 | 指定稳定框体四状态尺寸与对齐一致；其他变化有明确约定 |
| P1a | 按区域确定字号、行高和文本槽位 | 对应样板 | 维持认可的基准画面，中英文切换符合组件约定 |
| P1b | 落实框体尺寸与内容安置 | P1a | 指定稳定框体不被文本挤开 |
| P4 | 落实点名容器的间距规则与设计例外记录 | P2、P3 | 实际缝隙与关联对齐满足样板；正式断言放到 P6 |
| P5 | 按文案约束清理 pricing 等对应区域 | 对应样板 | 常驻说明用途明确，无重复解释或图标替代堆积 |
| P6 | 新增针对性 UI 回归测试 | token、样板及对应区域整理完成 | 见 §5，验证已确定的设计要求 |

推进顺序：**文案约束立即生效 → P2 token → P3 生产样板 → 按区域落实 P1 / P4 / P5 → P6 正式回归测试**。行高测量与间距诊断随对应步骤处理，不另设一轮基础设施工程。

## 5 新增 UI 测试计划

用户明确：测试在 token 层和样板页完成后再做（"这件事就是后面再说了"）。此处只记录计划，不实施。

现有测试完全没有布局稳定性覆盖（§2.8），所以这是从零开始。

本节的方法在 2026-10-25 用本机 Windows + Chromium 1248 重跑复核过（脚本见 §8）。复核结果改写了原稿的若干写法，改动理由写在各小节末尾的「本机复核」里。

**两个"顺序"要分清**：

- **做这件事的时机**（用户已定）：P2 token 层、P3 样板页之后，即 P6。这一点不变。
- **P6 内部的顺序**（§5.8）：先写 5.1 让它红，再改 CSS。这是为了让测试可验证，与上面不冲突。

### 5.0 总原则：验证已确定的设计要求，排版检查辅助定位

这条原则决定下面所有断言怎么写，先说清楚。

症状是"中英切换差几像素"。**这个数字在这台开发机上恒为 0**——因为 `--ui-font-sans` 第一位是 `Inter`，而本机没装 Inter（CDP `CSS.getPlatformFontsForNode` 实测落到回退字体），中英文双双回退到 `Noto Sans SC`，同一个物理字体，行盒当然一样高。

**但这不代表"装了 Inter 它就会红"。**实测（`output/geom-probe/inter-installed-sim2.mjs`，用 Latin-only 的 `Segoe UI` 顶替 `Inter` 模拟"装了"）：

| 字体栈 | 叶子高度变化的个数 | `.shell` 高度 |
| --- | --- | --- |
| 默认（本机未装 `Inter`） | **0 / 58** | 1372.17 |
| 首位是 Latin-only 字体（模拟装了 `Inter`） | **9 / 58** | 1372.17（顶层容器**不变**） |

这说明测试必须控制字体条件，不能把本机默认字体下的零差异当作跨字体通过。测试环境需实际具备指定字体，等待字体就绪，并确认字体分裂确实发生；仅写一条 `font-family` 字符串不足以保证覆盖到目标条件。

（注意 `.shell` 高度在两种情况下都是 1372.17——**症状全被上层吸收了，只比顶层容器根本看不见**。这是 §5.2 必须逐个叶子比的直接证据。）

行高是否明确，是可以辅助定位的一项排版约定。它不能替代框体、对齐、缝隙和内容显示的结果验证；换行、混合文本与原生控件也需要按样板检查。

**因此：5.1 检查排版约定，5.2 验证受控字体条件下的稳定框体，5.3 验证点名容器的实际缝隙，其余防回归。最终验收以生产样板及用户明确的设计要求为准。**

### 5.1 第 1 层 · 排版约定：检查 `line-height: normal`

**排版检查**：检查样板规定需明确行高的文字是否仍计算为 `normal`。下面保留既有叶子扫描示例，正式实现还需覆盖带子元素的直接文本（例如“1 美元 = `<input>` 人民币”）、输入框的值和占位文字；不能把叶子清单为空等同于完整 UI 通过。

```js
const offenders = await page.evaluate(() => {
  const out = [];
  // 根节点用 body，不用 .shell：弹窗在 </main> 之外（public/index.html:320 vs :322/:348），
  // 而 #importForm / #pricingForm 正是要抓的对象，.shell 会漏掉它们。
  for (const el of document.querySelectorAll("body *")) {
    if (el.children.length > 0) continue;      // 只看叶子
    if (!el.textContent.trim()) continue;      // 不看空节点
    // 必须用 checkVisibility()：弹窗的 display:none 挂在父节点 .dialog-backdrop[hidden]
    // （public/styles.css:1589-1591）上，子元素自身 display 计算值仍是 inline-block，
    // 只看自身 display/visibility 会把隐藏弹窗里的按钮全算成违规。
    if (!el.checkVisibility({ checkVisibilityCSS: true, checkOpacity: false })) continue;
    const st = getComputedStyle(el);
    if (st.lineHeight !== "normal") continue;
    out.push({ tag: el.tagName, id: el.id, cls: el.className, fs: st.fontSize });
  }
  return out;
});
assert.deepEqual(offenders, []);   // 断言清单为空
```

三个要点：

1. **断言清单为空，不是"少于 N"。** 一旦允许 N，新加的元素会被顺手塞进这个额度里，额度慢慢烂掉。要放行的元素必须显式写 `line-height: normal` 进 `styles.css`，测试里用白名单点名——让例外留在源码里，而不是留在测试的宽容度里。
2. **白名单从空开始。** `public/styles.css` 目前 `line-height: normal` 显式声明 **0 处**，没有历史包袱。
3. **按"渲染了文字"判定，不按"这条规则设了 font-size"判定。** §3.1 的盘点口径是"79 条设了 font-size 的规则、26 条同时设了 line-height"，但这个口径会漏人：`.empty`（`public/styles.css:1574-1577`）自己只有 `color` 和 `padding`，`font-size` 从 `body` 继承 16px，实测中英高度差 **2px**，比大多数显式设了 font-size 的元素还大。扫描必须看**计算值**，不能看**声明**。
4. **高度不由文字撑开的元素要排除。** 35 个违规按"`line-height` 取 `1` 与取 `normal` 时高度是否相同"判据实测分成两组：**13 个敏感**（高度随行高变，真文本槽位）、**22 个不敏感**（高度由 `min-height: 36px` 和 flex stretch 决定，或是 `display: inline` 的 `.metric span`，其 `getBoundingClientRect()` 高度来自字体度量而非行盒）。

   **判据的安全性已验证**（`output/geom-probe/exclusion-criterion-safety.mjs`，强制字体分裂 + 真实 i18n 切换）：中英之间真正会抖的是 **9 个**，全部落在"敏感"组里；"不敏感但会抖"的元素 **0 个**。也就是说这条判据不会把任何真会抖的元素排除掉。

   | 分组 | 数量 | 中英是否抖 |
   | --- | --- | --- |
   | 敏感且会抖 | 9 | 会（`范围`→`Range` 19→17 等） |
   | 敏感但不抖 | 4 | 不会（`5h` / `/` / `7d` / `60s`，中英文本相同） |
   | 不敏感且不抖 | 22 | 不会 |

   不排除的代价是报出 22 条噪音（其中 13 条是 `.metric span` 这类内联元素），排除后的 13 个才是需要给定排版规格的文本槽位。

**范围要覆盖弹窗。** 弹窗（`#importDialog` / `#pricingDialog` / `#modelPricingDialog` / `#skinDialog`）在 `public/index.html:322`、`:348`、`:384`、`:397`，全部位于 `</main>`（`:320`）之后，不在 `.shell` 内。扫描根节点必须是 `body`，否则 §5.3 最想抓的 `#importForm` / `#pricingForm` 根本进不了样本。注意弹窗默认不可见，隐藏的内容会被 `checkVisibility()` 跳过——**要抓弹窗内部，得先把它打开**。

打开方式有两套，别搞混：

| 弹窗 | 元素形态 | 打开方式 |
| --- | --- | --- |
| `#importDialog` / `#pricingDialog` / `#skinDialog` | `div.dialog-backdrop[hidden]` | 去掉 `hidden` 属性 |
| `#modelPricingDialog` | 原生 `<dialog>` | `showModal()`（`public/app.js:3806`） |

`#modelPricingDialog` 有两个陷阱，都实测过（`output/geom-probe/dialog-hidden-vs-modal.mjs`）：

- **它在 HTML 里既没有 `hidden` 也没有 `open`**（`public/index.html:384`），默认 `display: none`。所以 **`hidden = false` 对它毫无作用**——它本来就不是被 `hidden` 藏起来的，是"没 `open`"藏起来的。
- **`hidden` 的优先级高于 `showModal()`**：若 `hidden` 为 `true` 时调 `showModal()`，`open` 会变成 `true`（看起来打开了），但 `display` 仍是 `none`、尺寸 `0 × 0`、可见叶子 `0` 个。**必须先清 `hidden` 再 `showModal()`，两者缺一不可。**

这个坑会骗人：`open === true` 让人以为弹窗已就位，实际量出来全是 0。我第一版探针就是这么被骗的。

另外，原稿写的"四个 `showModal()` 会互斥"也是错的——实测连续 `showModal()` 两个 `<dialog>`，两个都 `open === true`，top layer 支持叠放（`output/geom-probe/modal-stack-probe.mjs`）。

**本机复核**：未修时扫出 **35 个**可见违规；加一条 `body { line-height: 1.4 }` 之后降到 **0 个**。这条测试在当前代码上是**红的**，这正是它存在的意义。

**一个必须记下来的坑（我自己踩过）**：最初版本用 `st.display === "none" || st.visibility === "hidden"` 过滤，量出 **56 个**违规——那是高估。原因见上面代码注释：`display: none` 设在父节点上，子元素自身计算值不变。正确过滤后 `.shell` 内与 `body` 内**都是 35 个**（弹窗关闭时隐藏元素被正确排除），加 `body{line-height:1.4}` 后**都是 0 个**。这也说明：弹窗关闭时 `.shell` 与 `body` 计数相同，但**只有 `body` 在弹窗打开后才覆盖得到弹窗内容**，所以根节点仍必须是 `body`。

**四个弹窗各自新增的违规（逐个单独打开实测）**：

| 弹窗 | 打开方式 | 新增 | 是哪些 |
| --- | --- | --- | --- |
| `#importDialog` | 去掉 `hidden` | +4 | `LEGEND`、`#pickImportDirectoryButton`、`#cancelImportButton`、`#submitImportButton` |
| `#pricingDialog` | 去掉 `hidden` | +5 | `#refreshPricingButton`、`#cancelPricingButton`、`#savePricingButton`，加两个无 id 的切换按钮「在用模型」「全部模型」 |
| `#skinDialog` | 去掉 `hidden` | +5 | `#resetSkinClassicButton`、`#skinOpacityValue`、`#closeSkinDialogButton`，加两个无 id 的 `SPAN`「显示角色」「角色透明度」 |
| `#modelPricingDialog` | `showModal()` | +2 | `#cancelModelPricingButton`、`#applyModelPricingButton` |

合计 **16** 个，全在弹窗内；四个全开时总数为 35 + 16 = **51**。测试若只量主页面，这 16 个永远抓不到——**而它们全是按钮和标签，正是最容易被忽略的文本节点**。

这个 51 用 `output/geom-probe/final-verify2.mjs` 在**弹窗真正可见**的状态下复算过一遍：关闭时 35、全开后 51，`delta` 正好 16，且 `#modelPricingDialog` 量到 `display: block`、高 102.8px（不是 0），说明它确实参与了布局而不是空转。

（这里有个教训：第一次统计时我用 `tagName + id + className` 当去重键，结果两个无 id 的按钮都塌成同一个字符串 `BUTTON#.`，把 pricing 和 skin 各少算了 2 个。**去重键必须唯一，最省事的做法是带上 `textContent`。**）

### 5.2 第 2 层 · 结果：强制字体分裂后中英零变化

**断言**：在确认拉丁与 CJK 实际落到不同物理字体后，`zh-CN` 与 `en-US` 下，样板指定稳定的文本槽位与框体保持约定的尺寸、对齐及内容显示。允许增长的区域按其明确约定验证，不泛化为所有文字元素高度必须相等。

**关键一步：必须强制字体分裂。** 不强制，测出来恒为 0，等于没测。

```js
await page.addStyleTag({
  content: ':root { --ui-font-sans: "Segoe UI", "Noto Sans SC", sans-serif; }',
});
```

`Segoe UI` 有拉丁字形、没有汉字；`Noto Sans SC` 有汉字。于是英文走前者、中文走后者，两者的行盒差异才暴露出来。**删掉这一行，整个测试退化成装饰品。**

这个分裂**已用 CDP 验证过**（`output/geom-probe/segoe-split-probe.mjs`）：探针文本 `"范围 Range"` 在这条栈下被拆成两个物理字体——`Noto Sans SC` 承担 2 个字形（「范围」）、`Segoe UI` 承担 6 个字形（「Range」）。不是靠猜。

然后走真实 i18n 通路，不要手工改 `textContent`：

```js
await page.evaluate(async () => {
  // i18n.js 是 ESM，页面里没有挂在 window 上；按模块地址动态引入
  const mod = await import("/i18n.js");
  mod.setLocale("en-US", { persist: false });
  mod.translatePage(document.body);
});
```

（`public/i18n.js:909` `export function setLocale`、`:826` `export function translatePage`。没有 `window.__i18n` 这种全局对象——本机复核就是这么调的，见 `output/geom-probe/locale-switch-probe.mjs:62-64`。）

逐个量样板指定的稳定文本槽位和框体，与另一语言基线比对，断言其尺寸差符合约定。保留局部检查以免被上层吸收，但不把叶子文本矩形高度当成框体稳定性的唯一指标。

**扫描根节点同样是 `body`，不是 `.shell`**（理由见 §5.1：弹窗在 `.shell` 之外）。弹窗需要单独打开再量，否则默认 `hidden` 的内容永远不在样本里。

**本机复核**：

| 条件 | 高度变化的叶子 | 整页 Δ |
| --- | --- | --- |
| 默认字体栈，不强制 | 0 / 79 | 0px（**假绿**） |
| 强制字体分裂，未修 | 9 / 79 | −4px（**真红**） |
| 强制字体分裂，加 `body{line-height:1.4}` | 0 / 79 | 0px |

未修时那 9 个是：`范围→Range`、`自定义→Custom`、`#dateRangeStart 年/月/日→YYYY-MM-DD`、`.auto-refresh-label`、`#calendarZoneValue`、`#lastSuccessfulCheck`、`#detailModeLabel`、`展开 / 收起`、`.empty`。它们的 `line-height` 全部是 `normal`。

**注意：原 5.1 写的「当前会红（toolbar 106 vs 107）」在本机不成立**——默认字体栈下 `.toolbar` 中英都是 107。只按顶层容器高度做断言会漏掉 `.empty` 这类被上层尺寸吸收的变化；应结合局部文本槽位与外框检查，叶子扫描只作为辅助。

### 5.3 第 3 层 · 点名容器的缝隙验收与诊断记录

**正式断言**：按 §3.4 点名容器，验证其实际相邻项目间距及关联边缘是否满足样板；纯 gap 布局可以对照计算后的 row-gap / column-gap，既有探针采用 0.5px 容差。

以下保留原扫描器的三条采样条件，用于解释旧探针为何纳入或跳过某个样本。它们不构成正式测试自动跳过已指定组件的理由；baseline 对齐也不能只靠 `top` 相同识别：

1. 容器 `justify-content` / `align-content` 不是 `space-between` / `space-around` / `space-evenly`；
2. 子元素没有 `margin: auto`（含 `margin-left: auto`）；
3. 参与比较的子元素在同一行（`top` 相同）。

**为什么要有前提**：原 5.3 的写法"每个容器都算"会让 `.pricing-model-row` 永远红，而它是对的。那一行是 `justify-content: space-between` + 最后一个按钮 `margin-left: auto`（`public/styles.css:1870-1874`），审计量到的 383.31 / 397.94 / 413.53 / 358.44 那些"缝隙"，是 `auto` 把剩余空间全部吃掉的结果——**那不是 gap，把它当 gap 比就是错的**。跳过这三类容器不是放水，是这三类容器上"gap"本来就没有定义好的视觉含义。

**第二条前提比想象的更常触发**：`public/styles.css` 里有 `margin-left: auto` 的不止 `.pricing-rematch-button`，还有 `.pricing-rate-label`（`public/styles.css:1780-1787`）。`.pricing-toolbar`（`:1767-1772`，`display: flex; flex-wrap: wrap; gap: 10px`）里 `#pricingSearch` 与这个 label 之间的 416.73px 就是 `auto` 撑出来的——不跳过它，测试会误报。

真正要抓的是**被子元素 margin 架空**的容器。

#### 前提 2 不能写成 `computedStyle.margin === "auto"`（实测陷阱）

这条会让人写出一行永远不触发的代码。实测（`output/geom-probe/margin-auto-probe.mjs`）：

```
.pricing-rate-label 的 CSS 声明：  margin-left: auto
getComputedStyle().marginLeft：  "406.734px"      ← 解析成像素了
getComputedStyle().margin：      "0px 0px 0px 406.734px"
```

**`getComputedStyle` 对 `margin: auto` 返回的是解析后的像素值，不是 `"auto"`。** 所以 `if (st.marginLeft === "auto") skip()` 一次都不会成立，`.pricing-model-row` 和 `.pricing-toolbar` 会被当成 bug 报出来。

以下是调查手段；本轮只测点名组件，不实现通用 CSSOM 解析器：

- **查 CSSOM 声明**：遍历 `document.styleSheets` → `cssRules` → `rule.style.marginLeft`，这里能拿到字面量 `"auto"`。缺点：要自己处理选择器匹配、层叠优先级和 `@media`。
- **gap=0 对照测量**：临时设容器 `gap: 0` 后复测，用来观察 gap 对距离的贡献。它不能单独区分 auto margin、固定 margin、分布对齐或 fieldset 的特殊布局，也不能据此自动认定视觉错误或跳过验收。

**这个判据已实测验证**（`output/geom-probe/gap-zero-probe.mjs`、`gap-zero-probe2.mjs`）：

| 容器 | 声明 gap | 缝隙 | 把 gap 设 0 后 | 读出的真相 |
| --- | --- | --- | --- | --- |
| `.metrics` | `20px` | 20×5 | **0×5** | 纯 gap |
| `.toolbar` | `12px` | 12 / 12 | **0 / 0** | 纯 gap |
| `#importForm` | `0` | 14/20/20/0/24 | **14/20/20/0/24**（不变） | 全部是 margin，gap 完全没参与 |
| `.source-picker-field` | `8px` | 10 | **10**（不变） | 那 10px 全是 margin，**声明的 8px 一点作用都没有** |
| `#pricingForm` | `14px` | 24/24/24/14/14/24/14 | **10/10/10/0/0/10/0** | gap 贡献 14，剩余 10 来自 margin |
| `.pricing-harness-group` | `6px` | 8 / 6 | **2 / 0** | gap 贡献 6，第一条缝多出 2px 是 `h3` 的 `margin-bottom` |
| `.pricing-toolbar` | `10px` | 416.73 | **416.73**（不变） | `margin-left: auto`，与 gap 无关 |

这个表本身就是这条断言的价值说明：**同一个"声明 8px 实际 10px"，在 `.source-picker-field` 上是"gap 完全失效"，在 `#pricingForm` 上是"gap 生效但被叠加"**——只比"声明 vs 实际"两者分不出来，加一次 gap=0 的对照测量才能分清。

**注意 `.pricing-model-row` 在这张表里测不到**（`gap-zero-probe2.mjs` 报 `no comparable gaps`）：它是 `justify-content: space-between` + `align-items: baseline`，两个子项的 `top` 本来就不相等，被前提 3 挡掉了。**这恰好说明三条前提是必要的**——不挡，量出来的就是无意义的负数或巨值。

**本机复核**（`output/geom-probe/gap-full-check2.mjs`，四个弹窗全开，实际检查 26 个容器）：

| 容器 | 声明 gap | 实测缝隙 | 判定 |
| --- | --- | --- | --- |
| `#importForm` | `0` | 14 / 20 / 20 / 0 / 24 | **真 bug**，全部来自子元素 `margin-top` |
| `#pricingForm` | `14px` | 24 / 24 / 24 / 14 / 14 / 24 / 14 | **真 bug**，`.pricing-auto-row` 的 `margin: 10px 0` 叠加 |
| `.pricing-harness-group` | `6px` | 8 / 6 | **真 bug**（轻），`h3` 的 `margin: 4px 0 2px`（`public/styles.css:1814-1819`）把第一条缝撑成 8px |
| `.source-picker-field` | `8px` | 10 | **真 bug**（新发现，见下） |
| `.metrics` | `20px` | 20 / 20 / 20 / 20 / 20 | 通过 |
| `.toolbar` | `12px` | 12 / 12 | 通过 |
| `.pricing-model-row` | `12px` | 有 `margin-left: auto` | **跳过**（前提 2） |
| `.pricing-toolbar` | `10px` | 416.73 | **跳过**（前提 2，同上） |

所以原 5.3 说的「当前会红（`#pricingForm`、`#importForm`、`.pricing-harness-group`）」三处**全部成立**，另加一处**原文档没写到的 `fieldset.source-picker-field`**（声明 `8px`，实测唯一一条缝是 `10px`，且把 gap 设 0 后仍是 10px——**声明的 8px 完全没生效**）。但 `#pricingForm` 的实际数字是上表的 24/24/24/14/14/24/14，不是审计写的 24/14/38——现象对，具体值不准。

`.pricing-harness-group` 这条也说明：**gap 断言要能抓到 margin 造成的偏差，不只是子元素之间的 `margin-top`**。`h3` 的 `margin-bottom: 2px` 在 grid 里不会塌陷，直接叠加在 6px 上变成 8px。

**为什么这层值得单独做**：被子元素 margin 架空的 gap 声明，是"改 CSS 时以为改了这个间距、其实没改"的典型来源。它不是视觉 bug，是**可维护性 bug**——`#importForm` 声明 `gap: 0`，读代码的人会以为间距由子元素控制，实际是 5 个不同的 `margin-top` 在各自为政。`fieldset.source-picker-field` 更直接：它声明了 `gap: 8px`，但那条缝是 10px，**这 8px 一行代码都没影响过**。

**2026-10-26 补充**：上述表格保留间距来源的历史诊断，不凭 margin 的存在本身决定设计是否正确。fieldset 的 gap 作用于不包含 rendered legend 的匿名内容盒；当前内容盒只有一个直接项目，不能期待 gap 改变 legend 与内容之间的距离（§8.2）。这些组件均需对照认可的样板落实间距；agent 不得用“CSS 合法”替设计差异开白名单。

### 5.4 第 4 层 · 长文本不挤开指定稳定框体（防回归）

旧文本注入中的 **135/136** 是宽度不变的计数，不能代表高度也不变（纵向变化见 §2.3）。正式测试按样板指定的稳定框体分别验证宽度、高度、对齐与内容显示。`h1` 等已有差异也须按认可的设计决定是否放行，不能只因当前实现会变化就加入白名单。

这一层的价值在于**钉住已经做对的事**：防止将来有人给数据值去掉 `nowrap` / `overflow: hidden` / `text-overflow: ellipsis`。

### 5.5 第 5 层 · 同类元素同一策略（结构性）

原 5.5 的内容保留：`.metric strong` 与 `.comparison-item strong` 必须用同一套溢出策略（`white-space` / `overflow` / `text-overflow` 三者一致）。这是一条读 `getComputedStyle` 的静态断言，不需要真实布局，跑得很快。

### 5.6 亚像素对齐：降级为观察项，不作为断言

原“本机不可复现”的判断撤回。`subpixel-probe.mjs` 的 `lastColDelta` 比较了两个末项，它们同样比 `.shell` 短 `0.015625px`，相减自然为 0。独立复核已分别测量各自相对 `.shell` 的差值，确认该量存在（§8.2）。

**仍降级为观察项，不设置 0.01px 的失败阈值，也不为此改列结构。** 本轮优先检查肉眼可见的缝隙不一致、关联边缘和框体变形；拟物阴影、高光及圆角形成的视觉间隔，需结合实际画面判断。

### 5.7 运行成本、CI 与文件划分

- **先放一个文件**：`test/ui-geometry.test.js`，共用现有 fixture 服务与浏览器运行时；P6 实施时记录实际耗时，不为本轮工作预先拆分测试工程。
- **无浏览器时**：按现有约定标 `ENVIRONMENT_BLOCKED` 跳过（`test/skin-palette-preview.test.js:989` 是范例）。
- **但 CI 下不许跳过**：

```js
// 与 test/skin-palette-preview.test.js:989 的既有惯例一致
const runtime = await resolveBrowserRuntime();   // scripts/skin-palette/capture.mjs:341
if (!runtime) {
  if (process.env.CI) assert.fail("CI 上必须真跑：Playwright 未就绪（AGENT_USAGE_PLAYWRIGHT_MODULE / Edge 未找到）");
  t.skip("浏览器运行时不可用（ENVIRONMENT_BLOCKED）");
  return;
}
```

理由：`scripts/skin-palette/capture.mjs:341` 的 `resolveBrowserRuntime()` 在找不到浏览器时返回 `null`，测试就 `skip()`。若哪天 CI 里装 Playwright 那步被改成 `continue-on-error`，测试会静默跳过而 CI 依然绿——"测试没跑"和"测试通过"必须分得开。

注意 `resolveBrowserRuntime()` 返回的是 `{ chromium, executablePath }`，需要 `chromium.launch({ executablePath })`，不是 `chromium.launch()` 直接开。这是既有封装的行为，直接复用即可。

### 5.8 P6 内部的实施顺序（重要）

**正式测试在 token、生产样板及对应区域整理完成后实施。** 整理期间使用局部测量核对设计，不提前建立完整测试工程。

推荐节奏（P6 阶段）：

1. 用现有 fixture 和真实应用渲染指定区域，补齐正常、空、加载、错误状态及目标语言；先核对字体实际可用并就绪。
2. 写样板要求的框体、对齐、缝隙与内容显示断言；5.1 的行高扫描作为辅助，并补足混合文本与输入框覆盖。
3. 在隔离测试页面中临时破坏一条对应几何或排版规则，确认测试能失败，移除注入后通过。以此验证测试有效，无需回滚当前工作区或要求已经修好的实现再次先红。
4. 补 5.4 / 5.5 的长文本及同类数值显示回归。对已指定的稳定区域检查实际结果，不以旧样本的违规数量作为完成指标。

`body { line-height: 1.4 }` 只保留为旧探针的验证手段，不作为最终全站方案。最终验收由实际样板及设计关系决定，不能仅凭 `normal` 计数清零通过。

**旧探针对照数字**（`output/geom-probe/final-verify.mjs` 与 `final-verify2.mjs` 的历史样本，不作为完整界面的验收数量）：

| 状态 | 弹窗关闭 | 四个弹窗全开 |
| --- | --- | --- |
| 当前代码 | **35** | **51**（弹窗内 +16） |
| 加 `body{line-height:1.4}` | **0** | **0** |

打开方式与陷阱见 §5.1 的表格，这里不再重复。只需记住两点：`#importDialog` / `#pricingDialog` / `#skinDialog` 去掉 `hidden`；`#modelPricingDialog` 要**先清 `hidden` 再 `showModal()`**，只做一半会得到 `open === true` 但尺寸 `0 × 0` 的假象。

`final-verify2.mjs` 在弹窗真正可见的状态下复算过：关闭 35、全开 51，`delta` 正好 16，`#modelPricingDialog` 量到 `display: block`、高 102.8px，确认它参与了布局而不是空转。

## 6 待决策

### 6.1 `.main-grid` 列结构暂不调整

本轮不为 `0.015625px` 的小数误差改列结构。原先推荐 `2fr 1fr` 的理由撤回；它仍可能产生小数尺寸，并会改变实际列宽及与其他区域的对应关系。

以 1440px 容器、20px 缝隙计算：现有三列加跨两列的左块约为 `953.33 / 466.67px`；两列 `2fr 1fr` 约为 `946.67 / 473.33px`，并非原稿写的 `473.33 / 236.67px`。未来若明确调整图表与详情的视觉比例，再以样板决定列结构。

### 6.2 `line-height` 方案 A 还是 B

见 §3.1。以用户认可的画面为基准按区域决定：局部修复保留 A 维持观感的目标，本轮涉及统一排版的区域可直接采用 B 的少量共享规格。两者均需落实实际组件尺寸与两种语言的显示，不能依据旧静态样本宣称确定零观感代价。

### 6.3 是否删除 `fitTextToWidth`

它没有任何生产调用点（`public/app.js:220` 有定义与导出，`test/app-render.test.js:1008` 有单测，但生产代码里零调用）。留着等于给 agent 示范错误做法。

建议删除，连同 `test/app-render.test.js:1008` 的单测。如果你希望保留作为将来备用，至少要加注释说明"不推荐使用"。

## 7 不做的事

- **不给常驻文字设字数上限**。已撤回，判定为太过强行。
- **不做手机适配**。界面基准是 PC 16:9（1920×1080 / 2560×1440）。分享图片是唯一例外。
- **不改视觉语言**。陶瓷拟物、单一左上光源、21px 面板圆角、17px 指标卡圆角全部保留。
- **不一次替换 161 处几何声明**。风险大于收益，按改动顺手推进。
- **不引入构建步骤或运行时依赖**。token 就是 CSS 自定义属性。

## 8 证据

- 本轮审计：[UI 几何与文本稳定性审计](../validation/2026-10-25-ui-geometry-audit.md)
- 测量脚本（临时，未入库）：`/tmp/stress.mjs`（文本注入）、`/tmp/map.mjs`（文字槽位盘点）、`/tmp/sweep.mjs`（视口扫描）、`/tmp/localesweep.mjs`（中英文对照）、`/tmp/offset.mjs`（累积偏移）
- 复现环境：Playwright（npx 缓存入口）、`libXdamage.so.1` stub、`test-support/perf-fixture.mjs` 三来源 fixture

测量脚本是临时的，P6 实施时应重写为正式测试文件并入 `test/`。

### 8.1 §5 的本机复核（2026-10-25，Windows + Chromium 1248）

以下保留该轮探针的历史记录。`option-a2.mjs` 的测量口径及 `subpixel-probe.mjs` 的“不可复现”结论已由 §8.2 修正；实施以 §3–§6 的修订正文为准。

§5 的写法在 Windows 本机用 `playwright-core` 1.64.1 + Chromium 1248 重跑过一遍，脚本在 `output/geom-probe/`（未入库）。这次复核推翻了原稿三处判断、补了三条实施要点，理由已写进各小节：

| 脚本 | 核的是什么 | 结论 |
| --- | --- | --- |
| `proto-test.mjs` | §5.1 根因断言 + §5.2 字体分裂 | 未强制字体分裂时中英 Δ0（假绿），强制后 9/79 变化。**它报的「56 违规」因可见性过滤有误已作废**，正确值见 `scope3.mjs` 与 `final-verify.mjs` 两行 |
| `scope3.mjs` | §5.1 的可见性过滤与根节点选择 | 改用 `checkVisibility()` 后：未修 **35** 个可见违规（`.shell` 与 `body` 相同）、修后 **0** |
| `dialog-probe.mjs` | 四个弹窗各自的新增违规 | import +4、pricing +5、skin +5、modelPricing +2（`showModal()`），合计 **16** 个，全在弹窗内 |
| `final-verify.mjs` | 弹窗关闭 / 全开两种状态的总数 | 未修 **35 / 51**；加 `body{line-height:1.4}` 后 **0 / 0** |
| `platform-font-probe.mjs` | CDP `CSS.getPlatformFontsForNode` 查实际物理字体 | 默认栈下中英文**都**落 `Noto Sans SC`；`Inter` 与 `PingFang SC` 本机未安装 |
| `font-probe.mjs` | 单字体下的中英行盒差 | Arial 是唯一分裂的（13px 时 Δ2）；Inter / Noto Sans SC / YaHei / system-ui 全 Δ0 |
| `lineheight-probe.mjs` | §3.1 方案 A 是否真能消除差异 | 显式 `line-height` 取 1 / 1.1 / 1.15 / 1.2 / 1.3 / 1.4 / 1.5 任意值时 Δ **全部为 0** → 方案 A 有效 |
| `option-a2.mjs` | 旧方案 A 的静态样本测量 | 当时按 Range 文本矩形回写行高，所测容器 Δ 0、叶子计数 35 → 0；测量口径与适用范围已由 §8.2 修正 |
| `visual-impact.mjs` | `body{line-height:1.4}` 的观感代价 | `.shell` 1372.17 → 1366.53（**−5.64px**）、`.toolbar` 107 → 106.19、`.metrics` 111.19 → 109.58 → 只能当验证工具，不能当修复 |
| `segoe-split-probe.mjs` | §5.2 的强制字体分裂是否真生效 | 探针 `"范围 Range"` 被拆成 `Noto Sans SC` 2 字形 + `Segoe UI` 6 字形，确认分裂成立 |
| `harness-group-probe.mjs` | §5.3 的 `.pricing-harness-group` | 声明 `gap: 6px`，实测缝隙 `8 / 6`——`h3` 的 `margin: 4px 0 2px` 在 grid 里不塌陷，直接叠加 |
| `locale-switch-probe.mjs` | 走真实 `i18n.js` 的 `setLocale` + `translatePage` | 79 个叶子零变化（默认字体栈，即假绿场景） |
| `leaf-diff-probe.mjs` | 全页叶子逐个比高度 | 强制分裂后 9 个变化，全部 `line-height: normal` |
| `subpixel-probe.mjs` | §2.4 的 −0.0156px | 三种组合下两末项互比为 0；原“不可复现”解释撤回，需分别与 `.shell` 比较，见 §8.2 |
| `real-page-probe.mjs` | 真实页面上的 `.pricing-model-row` / `#pricingForm` / `#importForm` 缝隙 | 见 §5.3 表格；`.pricing-model-row` 的"缝隙"是 `margin-left: auto`，判定为误判 |
| `gap-full-check2.mjs` | 全页 gap 扫描（四个弹窗全开） | 检查 26 个容器，4 个不符：`#importForm` / `#pricingForm` / `.pricing-harness-group` / `.source-picker-field`（**新发现**）；13 个按前提跳过 |
| `margin-auto-probe.mjs` | 前提 2 该怎么实现 | `getComputedStyle().marginLeft` 对 `margin-left: auto` 返回 **`"406.734px"`** 而非 `"auto"` → 按 computed 值判断永不触发 |
| `gap-zero-probe.mjs` / `gap-zero-probe2.mjs` | 「把 gap 临时设 0 再量」这个判据是否成立 | 成立：`.metrics` / `.toolbar` 归零；`#importForm` / `.source-picker-field` / `.pricing-toolbar` 完全不变；`#pricingForm` 从 24→10、`.pricing-harness-group` 从 8→2 |
| `final-verify2.mjs` | §5.8 的 35 / 51 是否在弹窗真正可见时统计 | 关闭 35、全开 51、`delta` 16；`#modelPricingDialog` 量到 `display: block`、高 102.8px，确认真参与布局 |
| `modal-stack-probe.mjs` | 多个 `showModal()` 是否互斥 | **不互斥**：两个 `<dialog>` 同时 `open === true`，top layer 支持叠放 |
| `dialog-hidden-vs-modal.mjs` | `<dialog>` 的 `hidden` 与 `showModal()` 关系 | `hidden=false` 对 `#modelPricingDialog` **无效**（它本来就没 `hidden`）；`hidden=true` 时 `showModal()` 会 `open=true` 但 `display: none`、尺寸 0 |

**复核得出的三条修正**（已落进 §5）：

1. 原 5.1「当前会红（toolbar 106 vs 107）」在本机不成立——默认字体栈下 `.toolbar` 中英都是 107。**只比顶层容器会漏掉 `.empty` 这类变化**，必须逐个叶子比（§5.2）。
2. §3.1 的盘点口径（按"设了 font-size 的规则"计数）会漏掉继承型文本节点（`.empty` 自己不设 `font-size`，实测中英差 2px）。判定口径应是**计算值是否为 `normal`**（§5.1）。
3. 原 5.3 的 gap 断言不加前提会让 `.pricing-model-row` 永远红，而它是对的（§5.3 三条前提）。另外 `.pricing-harness-group` 已实测确认是**真 bug**（声明 6px，实际 8 / 6），原稿说"需单独确认"可以改成"成立"。

**复核另外新增的三条实施要点**（已落进 §3.1 / §5.1 / §5.8）：

4. **旧方案 A 的静态样本曾测得 Δ 0**；Range 文本矩形不能直接当作行盒，完整应用零观感代价的结论撤回（§8.2）。`body{line-height:1.4}` 在该旧样本中使 `.shell` 缩短 5.64px，只作探针验证手段。
5. **弹窗必须逐个单独打开才能计数**，且打开方式分两类（`hidden` vs `showModal()`）。四个弹窗合计 16 个违规，占全开时总数（51）的 31%——只量主页面会漏掉近三分之一。
6. **可见性过滤必须用 `checkVisibility()`**。按元素自身 `display` / `visibility` 判断会漏掉"父节点 `display: none`"的情况（隐藏弹窗里的按钮全被算成违规），把 35 误报成 56。

**以及四条实现层面的陷阱**（写进 §5.0 / §5.1 / §5.3）：

7. **前提 2 不能查 computed style**：`margin-left: auto` 的 computed 值是解析后的像素。改用「把容器 `gap` 临时设 0 再量」的几何判据，一次测量同时分清"gap 生效"与"gap 被 margin 架空"。
8. **多行 / 单列容器的比较方向要按实际布局判**，不能按 `display` 猜。第一版扫描器把 grid 一律当单行，单列 grid（`#importForm`）因此被整体跳过，得出"0 处不符"的假绿。
9. **`#modelPricingDialog` 要清 `hidden` 再 `showModal()`**，两者缺一不可。只做一半时 `open === true` 但 `display: none`、尺寸 0——`open` 这个"看起来打开了"的信号会骗人。
10. **字体条件需要受控。** 用 Latin-only 字体顶替 `Inter` 后，同一条检查从 0/58 变成 9/58；正式测试需确认指定字体实际可用并就绪，再验证对应结果，不能只依赖本机默认字体或行高声明。

### 8.2 2026-10-26 复审的技术依据与适用范围

依据本次对话前次已完成的 Chromium `156.0.8078.4` 只读复核，以及对既有探针的源码检查。本次文档更新没有重新执行完整应用状态矩阵，也未新增正式测试。

- **文本矩形与行盒不同**：内存样例 `font: 16px Arial; line-height: 40px` 的单行块高为 `40px`，`Range` 文本矩形为 `17px`。`option-a2.mjs` 将后者直接写回 `line-height`，不能作为普遍有效的行高测量方法；它还移除了应用脚本，Δ 0 只代表该静态样本中已测容器的结果。[CSSOM View 规范](https://drafts.csswg.org/cssom-view/#dom-range-getclientrects)规定文本矩形按字体度量计算，不是整个行盒。
- **固定行高仍可换行增高**：同一内存样例保持 `line-height: 20px`，长文本使块高从 `20px` 增至 `80px`。明确行高不能单独解决全部纵向稳定性问题。
- **fieldset 不等于普通网格**：载入仓库静态 HTML 和 `styles.css` 后，把 `.source-picker-field` 的 gap 从 `8px` 改为 `80px`，legend 与内容的可见距离仍为 `10px`。`gap` 作用于不含 rendered legend 的匿名内容盒，解释见 [HTML 布局规范](https://html.spec.whatwg.org/multipage/rendering.html#the-fieldset-and-legend-elements)。按组件样板落实这条距离，不构建通用布局解析器。
- **亚像素误差已复现**：1920×1080 静态页面中，`.shell.right = 1680`，`.main-grid` 与 `.comparison-strip` 的末项右边缘均为 `1679.984375`，相对 `.shell` 均差 `−0.015625px`；两末项互减为 `0`。原探针比较对象不足以支持“不可复现”的结论。
- **叶子扫描覆盖不完整**：带子元素的直接文本会被 `children.length > 0` 排除，输入值和占位文字也不在 `textContent` 中。正式测试需补足这些对象，并以样板规定的槽位与框体结果验收。

**2026-10-26 独立复算（Windows + Chromium 1248，真实 `public/index.html` + `styles.css`）**

上列各条已逐条重跑，结论如下。脚本在 `output/geom-probe/`，下文标出。

| 复审结论 | 复算结果 | 证据脚本 |
| --- | --- | --- |
| `Range` 文本矩形 ≠ CSS 行盒 | **成立，且更彻底**：`Range` 高度只随字号变化（12px→17、13px→19、16px→24），**完全不随 `line-height` 变化**。`line-height:1.4` 时元素高 16.797，`Range` 仍报 17 | `range-vs-linebox.mjs` |
| 固定行高仍可换行增高 | **成立**（本仓未单独重跑，与上一条同源） | — |
| `.source-picker-field` 的 gap 不作用于 legend | **成立**：声明 `8px`，实际可见距离 `10px`，把 `gap` 临时设 0 后距离**不变** | `gap-zero-probe2.mjs` |
| 亚像素 `−0.015625px` 存在 | **成立，且原「不可复现」是错的**：原因见下 | `subpixel-compare-objects.mjs` |
| 叶子扫描漏掉混合文本与输入框 | **成立**：3 个输入框 `line-height` 为 `normal` 但 `textContent` 为空，被整体漏掉 | `scan-coverage-gap.mjs` |

**亚像素为什么我先前判成"不可复现"——比较对象选错了**

| 比较对象 | 1920@1 | 2560@1 | 1920@2 | 1440@1 |
| --- | --- | --- | --- | --- |
| `.main-grid` 末子项 right − `#comparisonSummary` 末子项 right（**我原来的口径**） | 0 | 0 | 0 | 0 |
| 末子项 right − `.shell.right`（**复审口径**） | **−0.015625** | **−0.015625** | **−0.015625** | 0 |
| 容器 `.main-grid.right` − `.shell.right` | 0 | 0 | 0 | 0 |

两个末项互相比较恒为 0（它们共享同一套栅格相位），所以我的探针永远测不出偏差。**容器本身是贴齐的，偏的是容器里的末子项**——`1679.984375` vs `1680`。这属于探针缺陷，不涉及环境差异。§2.4 与 §5.6 的"本机不可复现"表述据此作废。

**新增发现：方案 A 的基准值本身随语言漂移（决定性）**

这是本次复算最重要的一条，它改变了对方案 A 的评价。

1. **什么才算"行盒高度"，先自证再使用。**构造 6 类元素 × 3 个已知 `line-height`（18 个用例），看哪种测量能把设定值原样还原：

| 测量方法 | 还原正确数 | 说明 |
| --- | --- | --- |
| `el.getBoundingClientRect().height` | 3 / 18 | 含 padding/border；多行翻倍 |
| `Range.getClientRects()[0].height` | 5 / 18 | 内联盒，只随字体字号变 |
| 临时 `white-space:nowrap` 后的元素高度 | 6 / 18 | 同样含 padding/border |
| **（高度 − padding − border）÷ 行数** | **18 / 18** | 唯一能自证的方法 |

证据：`linebox-selfproof.mjs`。所以方案 A 取基准只能用最后一种。

2. **用正确基准后，方案 A 在观感上确实 Δ 0**（静态页与填充数据页、两种字体栈、两种语言，8 种组合下 6 个容器高度变化全为 0）。证据：`option-a-m4.mjs`。

3. **但它消除不了中英差。**同一元素在中文页取到的基准与英文页取到的基准并不相同：

| 元素 | 字号 | 中文基准 | 英文基准 | 差 |
| --- | --- | --- | --- | --- |
| `SPAN 范围` | 13px | 19 | 17 | −2 |
| `SPAN#dateRangeStart 年/月/日` | 12px | 17 | 16 | −1 |
| `SPAN.auto-refresh-label 自动刷新` | 13px | 19 | 17 | −2 |
| `DIV.empty 正在读取归档状态…` | 16px | 24 | 21 | −3 |

35 个叶子里有 **9 个**基准值不同（`option-a-baseline-drift.mjs`）。按"当前渲染值"逐条固定，等于**把抖动固化成两个确定的不同值**：修复后中英切换仍有 9 个叶子高度不同（`option-a-m4.mjs` 的 Q3）。**所以方案 A 只能保证"不改动当前观感"，不能单独达成几何稳定。**这与复审第 4 条一致。

4. **另有 9 个叶子的基准值无法用任何公式求得**：`今日/本周/本月/全部/按渠道/按模型/按花销/编辑/计价标准` 这 9 个按钮的 `lineBox` 算出 28~34px，而真实内联盒只有 21px——高度由 `min-height: 36px` 和 flex stretch 决定，不由文字撑开。实测给它们设 `line-height` 取 1 / 1.4 / 24px / 19px，**高度一律不变**（`lineheight-sensitivity.mjs`）。→ 这类元素不构成抖动风险，也不该被 `line-height: normal` 断言计入违规。

**由此得出的实施口径修正**：

- §5.1 的根因断言（`line-height` 不得为 `normal`）需要排除"高度不由文字撑开"的元素，否则会报出无风险项。判据与实测分组见 §5.1 第 4 条（13 敏感 / 22 不敏感，中英真会抖的 9 个全在敏感组，误排除 0 个）。证据：`exclusion-criterion-check.mjs`、`exclusion-criterion-safety.mjs`。
- 行高必须按**排版规格**给定（方案 B 的做法），不能从当前渲染值反推（方案 A 的做法）。方案 A 可以保留为"验证改动不改变现有画面"的手段，但不能作为取值来源。
