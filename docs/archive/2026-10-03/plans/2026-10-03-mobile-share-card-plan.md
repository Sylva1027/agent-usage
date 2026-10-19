# 移动端分享图实施方案（2026-10-03）

> **历史归档 · 2026-10-03**。本稿被后续交付或融合计划替代；旧状态、待办与离线要求仅供追溯。现行规则与遗留事项见[文档入口](../../../00-index.md)和[任务清单](../../../02-tasks.md)，归档原因见[本批索引](../00-index.md)。

> 状态：**待评审**，尚未实施。本次只产出计划，不改动 `public/`、`src/`、`test/`。

## 1. 背景：现有的"分享"是什么

仓库里已有的"分享/保存"是 `npm run export`（`src/static-export.js`）：把整个看板
连同 40 张皮肤素材内联进一个自包含 HTML，写到 `dist/codex-usage.html`。

它对"本机归档"这个定位是对的，但作为**分享物**不成立：

- 它是桌面看板的原样拷贝：工具栏、计价弹窗、扫描目录、搜索框都在，接收者没有阅读路径。
- 信息密度由看板布局决定，而不是由"一眼读懂"决定。
- 社交平台的分享单位是图片，不是 HTML 文件；手机上打开一个 800KB 的 HTML 也没有转发价值。

**结论：静态快照保留不动**，本次新增一条独立通路——**分享图**。

## 2. 范围

**做**

- 顶栏一个分享按钮 → 打开分享弹窗 → 预览即时生成 → 保存 PNG / 复制 / 调起系统分享面板。
- 两种竖版构图（9:16 完整版、4:5 紧凑版），1080px 宽。
- 配色与材质**全部取自当前页面的 CSS 变量**，跟随主题与皮肤。
- 纯 Canvas 2D，不引入任何依赖。
- 静态快照同步支持（自包含要求见 §7.4）。

**不做**

- 不改静态快照的既有行为与产出路径。
- 不做 1:1 方图（理由见 §10.3）。
- 不做卡片主题覆盖（"深色看板 + 浅色卡片"这类），理由见 §10.2。
- 不做长图/滚动截图、不做 GIF/视频、不做二维码。
- 不持久化分享设置（格式、角色开关只在本次会话内有效）。

## 3. 目标与验收口径

| # | 目标 | 验收方式 |
| --- | --- | --- |
| 1 | 一键 | 顶栏按钮 → 弹窗打开时预览已渲染完成，无需二次点击 |
| 2 | 小块化 | 信息拆成独立凸起块，每块只讲一件事（§4.1） |
| 3 | 只讲关键信息 | 进图字段白名单（§5），其余一律不入图 |
| 4 | 移动端可读 | 字号阶梯比约 7:1（§4.4）；1080 宽下最小字 24px |
| 5 | 符合主题 | 皮肤/主题切换后出图配色跟随（截图对照，§9） |
| 6 | 无依赖 | `package.json` 不变 |
| 7 | 不破坏快照 | 离线快照不产生任何 HTTP 请求，仍是单一内联 module script |

## 4. 设计规格

### 4.1 构图

两种格式各自成篇，不是"同一排版拉伸"。

| 格式 | 尺寸 | 组成 |
| --- | --- | --- |
| `story` 竖版 9:16 | 1080 × 1920 | 页头 · hero · 4 指标块(2×2) · 时间分布 · TOP 模型 · 页脚 |
| `card` 卡片 4:5 | 1080 × 1350 | 页头 · hero（含迷你走势）· 4 指标块(2×2) · 页脚 |

所有块共用同一套绘制原语，只有组合与弹性高度不同。

```
 story (1080×1920)                    card (1080×1350)
 ┌──────────────────────────┐         ┌──────────────────────────┐
 │ ▮▮▮ Agent Usage    本月  │  header │ ▮▮▮ Agent Usage    本月  │
 │                    10-01 │  104    │                    10-01 │
 ├──────────────────────────┤         ├──────────────────────────┤
 │ 总 TOKENS     较上月+12% │         │ 总 TOKENS     较上月+12% │
 │                          │         │                          │
 │  1.24 M        [新纪录]  │  hero   │  1.24 M        〔角色〕  │  hero
 │  ≈ $123.45               │  410    │  ≈ $123.45               │  454
 │                          │         │  ▁▂▃▅▇▅▃▂▁ (spark)       │
 ├──────────────────────────┤         ├──────────────────────────┤
 │ ┌────────┐ ┌────────┐    │         │ ┌────────┐ ┌────────┐    │
 │ │会话 128│ │缓存97% │    │ tiles   │ │会话 128│ │缓存97% │    │ tiles
 │ ├────────┤ ├────────┤    │ 466     │ ├────────┤ ├────────┤    │ 466
 │ │输出3.2M│ │模型 7  │    │         │ │输出3.2M│ │模型 7  │    │
 │ └────────┘ └────────┘    │         │ └────────┘ └────────┘    │
 ├──────────────────────────┤         ├──────────────────────────┤
 │ 时间分布            按日 │ chart   │ 统计截至 2026-10-03 12:30 │ footer
 │      ▁▂▅█▅▂▁  12.4M◆    │ 268     │        API 等价费用估算   │  92
 │ ──────────────────────── │         └──────────────────────────┘
 │ 10-01            10-31   │
 ├──────────────────────────┤
 │ TOP 模型                 │ models
 │ gpt-5.6-sol      12.4M   │ 286
 │ ▓▓▓▓▓▓▓▓░░░░░░░░░░░░     │
 ├──────────────────────────┤
 │ 统计截至 …   API 等价费用 │ footer 92
 └──────────────────────────┘
```

### 4.2 尺寸与节奏

以 1080 宽为基准，实际按 `scale = width / 1080` 等比缩放。

| 项 | 值 |
| --- | --- |
| 外边距 `M` | 72 |
| 块间距 `G` | 30 |
| 内容宽 | 936 |
| 圆角：页头 / 指标块 / hero / 井 | 32 / 36 / 48 / 40 |
| 块内边距：页头 / hero / 指标块 / 图表 / 模型 | 32 / 48 / 36 / 34 / 36 |
| 固定高：页头 / 指标块 / 图表 / 模型 / 页脚 | 104 / 218×2+30 / 268 / 286 / 92 |
| 指标块列间距 | 30 |

**弹性规则**（`shareCardLayout()` 的算法，纯函数）：

1. 取该格式的块序列与固定高，算出剩余的 `hero` 高度。
2. `hero = clamp(剩余, 300, 460)`；超出部分作为 hero 内部纵向留白，不改变其它块。
3. 若剩余 < 300：先摘掉 `models` 块重算（仅 story 有）。
4. 仍不足：把 `chart` 换成 96 高的 `spark` 条重算。
5. 仍不足：`hero = 300` 兜底，并让块序列从底部溢出（测试断言两种出厂格式都不会走到这一步）。

两种出厂格式的实际结果：story hero = 410，card hero = 454，均在区间内。

### 4.3 材质映射：CSS 变量 → Canvas 原语

看板的"陶瓷"材质集中在 `public/styles.css` §"Ceramic instrument surfaces"与
"material"两段。`--neo-raised` / `--neo-inset` 是 **box-shadow 值，Canvas 用不了**，
所以按它们的定义用色源重新拼：

| 看板 | Canvas 复刻 |
| --- | --- |
| `background: var(--bg)` | 铺满 `--bg`，叠两层强调色径向辉光（右上 7%、左下 3%） |
| 凸起块 `--neo-surface` + `--neo-edge` | 填充 `--neo-surface`；1px `--neo-edge` 描边；向下柔和投影用 `--ceramic-shade`（blur≈64、offsetY≈20）；顶部 1/3 叠 `--ceramic-light` 渐变高光；内侧左上 1px `--ceramic-rim` |
| 凹陷井 `--ceramic-well` + `--neo-inset` | 填充 `--ceramic-well`；顶部 ~30px 内阴影用 `--ceramic-shade` 渐变；底部内侧 1px `--ceramic-rim` 高光 |
| `--blue` / `--skin-active-accent` | 强调色，用于 hero 单位、图表柱、TOP 模型条、标记 |
| `--green` | 仅缓存命中良好时的 meter |
| `--record` | 仅"新纪录"小徽标 |
| `--ink` / `--muted` / `--line` | 主文字 / 次文字 / 分隔线 |

绘制原语（都在 `share-card.js` 内，无 import）：

- `shareRoundRectPath(ctx,x,y,w,h,r)`（自建路径，不用 `ctx.roundRect`，便于测试打桩）
- `sharePaintPanel(ctx, rect, tokens)` — 凸起块
- `sharePaintWell(ctx, rect, tokens)` — 凹陷井
- `sharePaintMeter(ctx, rect, ratio, color)` — 圆角进度条
- `sharePaintBars(ctx, area, bars, tokens)` — 柱状 + 峰值标记
- `shareText(ctx, text, x, y, opts)` / `shareFitFontSize(...)` / `shareTruncateToWidth(...)`
- `shareWithAlpha(color, a)` / `shareMixColor(a, b, t)` — 解析 `rgb()/rgba()/#hex` 并做混色

### 4.4 字号阶梯（1080 宽）

| 角色 | 字号 | 字重 | 颜色 |
| --- | --- | --- | --- |
| hero 数值 | 120–200 自适应 | 800 | `--ink` → 强调色 65% 的纵向渐变 |
| hero 单位 | 72 | 700 | 强调色 |
| hero 标签 / 块标签 | 26 | 600 | `--muted`，字距 2–3px |
| 指标数值 | 72 | 700 | `--ink` |
| 指标单位 | 34 | 600 | `--muted` |
| 块标题 | 28 | 700 | `--ink` |
| 正文 / 模型名 | 28–30 | 500–600 | `--ink` / `--muted` |
| 轴线 / 页脚 | 22–24 | 500 | `--muted` |

数值一律 `tabular-nums` 等价处理（Canvas 无法指定 `font-variant-numeric`，用等宽字距
与固定小数位保证不跳动）。字体族读 `--ui-font-sans`，与页面完全一致。

### 4.5 各块内容

**页头**：左侧 4 根渐高圆角竖条的抽象标记（56×56，强调色）+ `Agent Usage` 字标；
右侧两行：范围名（如"本月"，28px/700，右对齐）+ 短日期（如 `10-01 → 10-31`，24px 次色）。

**hero**：左上标签"总 TOKENS"；右上环比徽标（`summary.comparison` 有 `percentChange`
时显示，上行为强调色、下行为 `--red`）；中部超大数值 + 单位；数值右侧可选金色
"新纪录"徽标（`summary.records.totalTokens` 存在时）；下部"≈ $123.45"与
"API 等价费用估算"次色注；`card` 格式底部追加一条无坐标轴的迷你走势。

**指标块（2×2）**：会话 / 缓存命中 / 输出 / 模型数。
- 缓存命中块底部画 meter（绿→强调色，按命中率）。
- 模型数块底部一行次色注：使用量最高的模型名（截断），因为 `card` 格式没有 TOP 模型块。

**时间分布**（仅 story）：凹陷井；标题"时间分布" + 右侧粒度提示（按日/按周/按月）；
柱状区按 `summary.timeline` 绘制，柱数 > 44 时相邻合并到 ≤44；峰值柱满色并带数值徽标；
底部一条 `--line` 基线 + 首尾日期。

**TOP 模型**（仅 story）：凸起块 + 标题"TOP 模型"；3 行，每行：模型名（小写，截断）+
右对齐数值，下方一条按占比的圆角条，颜色取自 `getModelColors()` 同一色源。

**页脚**：`--line` 细分隔线 + 左"统计截至 <时间>"、右"API 等价费用估算"。
免责文案必须保留：这与仓库对"API 等价费用不等于实际账单"的一贯口径一致。

### 4.6 配色取用

`getComputedStyle` 读到的 `--neo-edge` 这类 token 可能是 `color-mix(...)` 表达式，
Canvas 不能直接吃。做法：用一个离屏探针元素，把变量赋给真实绘制属性再读回，
拿到浏览器解析后的 `rgb()`：

```js
probe.style.color = `var(${name})`;
return getComputedStyle(probe).color;   // 已解析
```

好处是**不需要在 JS 里复制一份色板**——复制必然与皮肤注册表漂移。皮肤通过
`PALETTE_CSS_VAR_NAMES` 写在 `:root` 上的行内自定义属性会被探针继承，因此
"换皮肤 → 换分享图配色"自动成立。

### 4.7 角色水印

当前皮肤是角色皮肤且 `showCharacters` 为真时，把角色线稿作为水印**画在 hero 块内部**：
右对齐、底部出血、高度约 1.05×hero 高、裁切在 hero 圆角矩形内、整体不透明度 0.12、
从左 40% 到右边缘做横向渐显。hero 左侧被数值占据，所以水印只会出现在右侧留白里，
不会与文字争夺注意力。

安全规则：若 hero 数值的实测宽度超过面板宽的 62%，直接跳过水印（不缩放、不叠字）。
`classic`（简洁模式）没有素材，直接不画，不留空位。

## 5. 信息取舍

**进图**：总 tokens、估算花销、会话数、缓存命中率、输出 tokens、模型数、可选环比、
时间分布与峰值、TOP 3 模型、统计截止时间、"API 等价费用估算"免责。

**不进图**：模型单价、缓存写入/未命中明细、推理 tokens、目录来源清单、搜索框、
自动刷新状态、限额窗口内部边界、错误与告警、计价来源链接。

理由：分享图的任务是"让人一眼知道这人在用 AI 写了多少东西"，不是复现看板。任何
第二眼才看得懂的字段都不进。

## 6. 技术方案

### 6.1 模块边界

`public/share-card.js`：**无 import、无 DOM**。与 `timeline-utils.js` /
`period-comparison.js` 同一风格。理由有二：

1. 静态快照把 `public/*.js` 内联进同一个作用域，无依赖的模块只要去掉 `export`
   前缀即可，不需要扩展内联器的依赖处理逻辑。
2. 单测可以直接在 Node 里 `import` 它，不需要 DOM 桩。

代价是它与 `app.js` 各自持有一份数值格式化。用**奇偶校验测试**兜住：
`shareTokenMillions(v) === formatTokenMillions(v)` 在整张取值表上成立（§8）。

文案通过 `text(key)` 注入，模块本身不 import i18n；`app.js` 传
`(key) => localizeText(key, getLocale())`，测试传 `localizeText` 本体。

### 6.2 函数签名

```js
export const SHARE_CARD_FORMATS            // [{id,width,height}]
export function shareCardFormat(id)        // 未知 id 回退第一个
export function shareTokenParts(value)     // {number:"1.24", unit:"M"}，阈值同看板
export function shareTokenMillions(value)  // "1.24M"
export function shareCardFileName({formatId, preset, date})  // ASCII 安全文件名
export function buildShareCardModel(input) // 纯数据，见 §6.3
export function shareCardLayout(width, height, formatId)     // 纯矩形，见 §4.2
export function drawShareCard(ctx, model, options)           // options:{tokens,image}
```

### 6.3 卡片数据模型

`buildShareCardModel({ summary, format, text, locale, zone, colorFor, costText, asOfText, character })`

```js
{
  format, width, height,
  brand:  "Agent Usage",
  range:  { label: "本月", dates: "10-01 → 10-31" },
  hero:   { label, number, unit, delta: {label,value,tone}|null,
            costText, record: bool },
  tiles:  [ { key, label, value, unit, note, meter: 0..1|null, tone } ],
  chart:  { label, hint, bars:[{ratio,value}], peak:{index,text},
            axis:[startText,endText] } | null,
  spark:  { bars:[{ratio}] } | null,
  models: { label, rows:[{name,valueText,ratio,color}] } | null,
  footer: { asOf, note },
  character: { opacity } | null,
}
```

`buildShareCardModel` 只做组装与纯数值格式化；**货币文案由 `app.js` 传入**
（`setCurrencyMetric` 的 USD+CNY 折算逻辑已存在，不复制），日期时间戳同理。

### 6.4 弹窗与导出动作

复用既有材质与交互约定，不新造控件语言：

- `.dialog-backdrop` + `.dialog`（`.skin-dialog` 的兄弟节点写法），桌面左右分栏、
  ≤720px 纵向堆叠。
- 格式切换用 `.segmented segmented-well`（与"按渠道/按模型"同款）。
- 左栏：`<canvas>` 预览放在凹陷井里，`max-height: 52vh`，按容器缩放。
- 右栏：标题、说明、格式切换、角色开关（无角色皮肤时隐藏）、
  动作按钮（保存图片 / 复制图片 / 系统分享）与 `aria-live` 状态行。
- 动作实现：`canvas.toBlob` → `URL.createObjectURL` + `<a download>`；
  `navigator.clipboard.write(new ClipboardItem)`；`navigator.canShare({files})`
  为真时显示系统分享按钮。三者失败都在状态行给出可读原因，不静默。
- 焦点陷阱复用 `trapDialogFocus`，Esc 关闭，`aria-modal` + `aria-labelledby`。

### 6.5 i18n 词条

新增（走 `i18n.js` 的 `ENGLISH` 映射，Canvas 与 DOM 共用同一 `localizeText`）：

`分享用量`、`生成一张只包含关键指标的图片，适合在手机上查看和转发。`、`格式`、
`竖版 9:16`、`卡片 4:5`、`显示角色`、`保存图片`、`复制图片`、`系统分享`、
`分享图预览`、`总 tokens`(已有)、`缓存命中`(已有)、`输出`(已有)、`模型`(已有)、
`时间分布`(已有)、`TOP 模型`、`峰值`、`按日`、`按周`、`按月`、`新纪录`、
`环比`、`API 等价费用估算`。

### 6.6 触点清单

| 文件 | 变更 | 规模估计 |
| --- | --- | --- |
| `docs/plans/2026-10-03-mobile-share-card-plan.md` | 本文件 | 新增 |
| `docs/plans/2026-10-03-mobile-share-card-todos.md` | 执行清单 | 新增 |
| `public/share-card.js` | 模型 + 布局 + 绘制 | 新增 ~600 行 |
| `public/share.css` | 按钮与弹窗样式 | 新增 ~200 行 |
| `public/index.html` | 顶栏按钮 + `#shareDialog` + `share.css` link | +~60 行 |
| `public/app.js` | 取值、构建模型、绘制、导出动作 | +~250 行 |
| `public/i18n.js` | 分享词条 | +~25 行 |
| `src/static-export.js` | 内联 `share.css` 与 `share-card.js` | +~12 行 |
| `test/share-card.test.js` | 见 §8 | 新增 ~300 行 |
| `docs/validation/2026-10-03-mobile-share-card/` | 证据留档 | 新增 |

## 7. 与既有约束的冲突点（已逐条核对）

1. **i18n 词条测试**（`test/i18n.test.js`）会扫描 `public/index.html` 里所有
   `>中文<` 与 `aria-label/title/placeholder`，任何没有英文形式的字面量都会失败
   → 弹窗里每个中文串都必须进 §6.5 的映射。
2. **快照自包含断言**（`assertSelfContainedStaticHtml`）要求"恰好一个内联 module
   script"且"没有任何外部 `script src` / `link href`" → 新增的 `share.css`
   必须像 `skins.css` 一样被 `replaceExactlyOnce` 换成内联 `<style>`，
   `share-card.js` 必须并入现有 bundle（去 `export` 前缀）。
3. **内联作用域重名**：`share-card.js` 与 `app.js` 会被拼进同一作用域，顶层
   声明不得重名（快照断言会以 SyntaxError 暴露，`static-export.test.js` 覆盖）。
   → 内部辅助函数统一 `share*` 前缀。
4. **`--neo-raised` / `--neo-inset` 是 box-shadow 值**，Canvas 不可用 → 按 §4.3 用
   色源重拼，不新增 token。
5. **`formatTokenMillions` 已有口径**（M/B/T，2 位小数）→ 分享图必须逐位一致，
   由奇偶校验测试锁住。
6. **`getModelColors()` 依赖 `document.documentElement.dataset.theme`** → 由
   `app.js` 取色后以 `colorFor(name)` 注入，`share-card.js` 不碰 DOM。
7. **主题/皮肤在弹窗打开期间不可切换**（弹窗是模态、顶栏被遮罩覆盖）→ 预览只需
   在打开时渲染一次，不必监听皮肤变更。

## 8. 测试计划（`test/share-card.test.js`，`node --test`）

1. **格式表**：两种格式均为竖版、宽 1080、id 唯一。
2. **格式化奇偶校验**：`shareTokenMillions` vs `formatTokenMillions`，覆盖
   0 / 999 / 1e3 / 999_999 / 1e6 / 1.005e6 / 1e9 / 1e12 / 负数 / NaN / 字符串，
   断言逐字符相等。
3. **模型组装**：给定最小 summary 与完整 summary，断言 hero 数值与单位、4 个指标块
   的顺序与字段、缓存命中 meter、模型数块 note 取 TOP1、`comparison` 缺失时无环比、
   `records.totalTokens` 存在时 record 为真。
4. **图表降采样**：`timeline` 0 行 → `chart === null`；1 行/31 行/200 行分别断言
   柱数 ≤44、ratio ∈ [0,1]、峰值 index 指向最大值、全 0 数据不产生 NaN。
5. **布局**：两种出厂格式断言块矩形全部落在画布内、互不重叠（同序且 `y` 递增）、
   hero 高 ∈ [300,460]；退化路径（人为给 1080×900）断言按 §4.2 依次摘掉
   models / 换成 spark 且不越界。
6. **渲染器**：用**记录型假 ctx**（记录每次 `fillRect/arc/lineTo/fillText/...` 调用）
   跑 `drawShareCard`，断言：
   - 三种数据状态（空数据 / 典型 / 极值）× 两种格式都不抛异常；
   - 所有数值参数 `Number.isFinite`（**NaN 检查**）；
   - 所有坐标落在 `[0,width] × [0,height]` 内（允许水印的出血矩形）；
   - 调用序列非空且包含 6 个以上的面板填充。
7. **文件名**：非法字符、中文 preset、超长 preset 都被规整为 ASCII 安全名，
   长度有上限。
8. **i18n**：英文环境下卡片模型的所有标签都非中文（复用 `untranslatedUiFragments`
   的思路），中文环境下原样。

## 9. 浏览器验证计划

沿用仓库既有做法的工具链（`docs/validation/2026-10-03-release/ui-audit.mjs` 的
Playwright + Edge 路径），新增 `docs/validation/2026-10-03-mobile-share-card/share-audit.mjs`：

1. 在线（本地静态服务器 + `/api/**` 桩数据）与离线（`renderStaticDashboardHtml` 落盘）
   两种承载各跑一遍。
2. 每种承载 × 浅色/深色 × 简洁模式/一个角色皮肤，生成并落盘真实 PNG：
   `story` 与 `card` 各一张 → 共 2×2×2×2 = 16 张成品图。
3. 断言：
   - 导出的 PNG 尺寸精确等于格式尺寸（读 PNG IHDR）；
   - 离线快照期间零 HTTP 请求；
   - 弹窗在 1440 / 1024 / 390 三个视口下不横向溢出、预览不被裁切；
   - 切换主题后同一数据的两张 PNG 像素均值有显著差异（证明确实跟随主题）；
   - 切换皮肤后 PNG 像素均值有显著差异，且与 `--bg` 的 RGB 走向一致。
4. 落盘弹窗截图（浅/深、桌面/手机）作为人眼复核材料。
5. 用 `read_image` 逐张人眼复核 16 张成品图，把不达标项改到达标为止——
   §3 的"美观、有设计感"只能靠这一步收敛。

## 10. 关键决策与理由

### 10.1 读 CSS 变量而不是另设色板（采纳）
见 §4.6。被否决的备选是"在 `share-card.js` 里维护一份皮肤色板副本"：皮肤注册表
已经在 `skins.js`/`skin-palettes.js` 里定稿（20/20 槽位），再复制一份必然漂移。

### 10.2 卡片配色跟随当前主题，不做独立覆盖（采纳）
"深色看板 + 浅色卡片"需要在当前主题之外重建另一模式的完整调色（皮肤调色板是按
模式分槽的，`classic` 更是只有 CSS 里那套）。收益是"分享到浅色背景时更协调"，
成本是一整套跨模式取色逻辑与验证矩阵。先跟随主题；若之后确实需要，再按
`skin-palette-studio.js` 的预览机制扩展。

### 10.3 只做 9:16 与 4:5，不做 1:1（采纳）
1080×1080 下，"页头 + hero + 4 指标块 + 图表 + TOP 模型 + 页脚"必须丢掉一半信息，
做出来是一张妥协图。9:16 给完整版，4:5 给信息流/朋友圈的紧凑版，两者都是完整设计。

### 10.4 货币与时间文案由 `app.js` 注入（采纳）
`setCurrencyMetric` 的"USD + CNY/汇率"折算与 `rangeLabel` 的限额窗口措辞都已存在
且被测试覆盖，复制到 `share-card.js` 会立刻产生两套口径。

## 11. 风险

| 风险 | 处置 |
| --- | --- |
| Canvas 阴影/渐变在两种主题下观感差异大（暗色下"凸起"很难做） | §9 的双主题逐张人眼复核；暗色下允许用降低投影强度 + 增强内高光替代 |
| 角色水印与数值抢注意力 | §4.7 的 62% 宽度安全规则 + 可关闭开关 + 截图复核 |
| 内联后顶层重名导致快照 SyntaxError | 统一 `share*` 前缀 + 依赖现有 `static-export.test.js` 断言 |
| 中文字体在 Canvas 里 fallback 到衬线 | 字体族读 `--ui-font-sans`，并把最小字号下限设到 22px；截图复核中文与英文两套 |
| `letterSpacing` 等较新 Canvas 特性 | 全部走 `try/catch` 特性探测，缺失时降级为普通绘制 |

## 12. 实施顺序（建议 5 个里程碑）

- **M1 纯模块**：`share-card.js` 的格式表、格式化、模型组装、布局；配套 §8 的
  1/2/3/4/5/7 号测试。此阶段不碰任何既有文件。
- **M2 渲染器**：绘制原语与 `drawShareCard`；配套 §8 的 6 号测试（假 ctx）。
- **M3 界面接入**：`share.css`、`index.html`、`i18n.js`、`app.js` 接线；
  跑 `npm test` / `typecheck` / `lint` / `format:check`。
- **M4 快照内联**：`static-export.js`；确认离线快照零请求、单一 module script。
- **M5 视觉收敛**：§9 的验证脚本 + 16 张成品图人眼复核，迭代到满意；
  写 `docs/validation/` 证据、更新 README 与 `docs/` 索引。

## 13. 其余已定项

1. **入口位置**：分享按钮放在顶栏动作组**最左侧**，带强调色。它是这一组里的主操作，
   值得与三个"设置类"按钮（皮肤/语言/主题）在视觉上区分开。
2. **不做 1:1 方图**：理由见 §10.3。§4.2 的弹性规则已为将来的第三个格式留好接口。
3. **角色水印默认值**：跟随当前皮肤的"显示角色"偏好（`showCharacters`），
   弹窗内提供一个不持久化的临时开关。
4. **免责措辞**：页脚写"API 等价费用估算"，与看板既有口径逐字一致。
