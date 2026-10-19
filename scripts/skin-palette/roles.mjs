/**
 * M0.2 实际颜色角色清单（皮肤配色重设 · 总计划 2026-10-03）
 * ============================================================================
 *
 * 这里登记的是"页面上真正承载信息的颜色角色"，不是 12 个原始 token 的清单。
 * 后续 M2 求解、M3 检查、M4 测量都以本清单为共同输入；协调者核对后，
 * 修改本清单必须递增 ROLES_VERSION 并在交接中记录新摘要，使旧评审失效。
 *
 * 证据基线：docs/validation/2026-10-03-skin-palette-redesign/20261003T185748/
 * （工作区 SHA-256 与行为事实见同目录 baseline.json）。行号仅作辅助定位，
 * 不是稳定主键；稳定主键是 id 与 selector/函数名。
 *
 * 关键现状事实（详见 M0.1 交接）：
 * - `controlText / controlBorder` 不被派生消费；本清单不为其单设角色。
 * - 文件后半段（styles.css 2348+）的 ceramic `:root` 块覆盖文件头部的同名定义，
 *   classic 模式实际生效 --ink #23313c / --muted #455666 / --blue #007d91 /
 *   --record #007d91（dark：#edf3f7 / #b1becb / #6cdae2 / #6cdae2）。
 * - `.segmented button.active`、`.date-picker-day.selected`、
 *   `.recent-range-menu button[aria-selected="true"]` 的早期"白字蓝底"规则被
 *   后半段"蓝字 + 凹槽"规则覆盖（styles.css 2220-2228、2302-2310）；
 *   填充蓝 + `--active-ink` 只剩主提交按钮（2249-2255）。
 * - 按钮表面用 `--neo-surface`（styles.css 2204）；input/select 虽在
 *   styles.css 730 先取 `--control`，但后半段已覆盖为 `--ceramic-well`
 *   （styles.css 2971-2977）——`controlBackground` 不是实际输入表面。
 * - `--gold` 只有定义、无消费位置（styles.css 18/41），因此**没有**金色角色；
 * 不凭变量名虚构。
 * - 图表分类色为 JS 固定色（app.js CATEGORY_PALETTES + MODEL_COLOR_ORDER 11 个
 *   固定槽位，越界走 hash hsl），不经 12 token 控制。
 * - 状态色 `--green / --red` 的必要小字角色按总计划归 M1.4 受限分支处理；
 *   本清单如实登记当前固定值与阈值，不预设可达性结论。
 */

// v11（M5.2.C-D8u26）：主行名并入表格正文角色，旧候选摘要失效。
// v12（M5.2.C.t5-D4）：日历角色选择器与活动状态对齐，旧候选摘要失效。
// v13（M5.2.C.t5-D5）：自动刷新开启态独立成状态，旧候选摘要失效。
// v14（M5.2.C.t5-D7）：次按钮与日历清除只计入活动操作范围，旧候选摘要失效。
// v15（M5.2.C.t5-D9）：外月日期改为直接 --muted 前景并移除整按钮透明度，旧候选摘要失效。
// v16（M5.2.C.t5-D12-A1）：来源排除角色限定到 source picker，并对齐实测表面。
// v17（M5.2.C.t5-D14）：主页面已保存不可用来源原因从弹窗状态移到关闭弹窗的目录状态。
// v18（M5.2.C.t5-D17）：收窄 page.body-text 并新增主页面来源行类型/计数角色，旧候选摘要失效。
// v19（M5.2.C.t5-D21-C2）：焦点角色绑定两个真实控件与 focus-visible/自然 Tab 契约，旧角色摘要失效。
// v20（M5.2.C.t5-D21-C7-B1）：次按钮悬停限定目录按钮并保持触发视口，旧角色摘要失效。
// v21（M5.2.P-B2-1）：登记详情面板行名称与行数值两个必要文字角色，旧角色摘要失效。
// v22（M5.2.P-B2-2）：登记导入弹窗来源列表非排除普通行的 ink/muted 两个必要文字角色，旧角色摘要失效。
// v23（M5.2.P-B3-3）：登记自动刷新凹槽的间隔/上次检查与标签文字两个必要角色，旧角色摘要失效。
// v24（M5.2.P-B3-4）：新增图例名称叶节点角色并扩展面板标题辅助说明到对比截止时间，旧角色摘要失效。
// v25（M5.2.P-B4-3）：登记第一组范围标题普通必要文字，旧角色摘要失效。
// v26（M5.2.P-B5-2）：登记总 tokens 卡普通标签的聚光状态，旧角色摘要失效。
// v27（M5.2.P-B7-2）：登记来源排除行必要名称与路径叶节点；当时自身 opacity 尚待 M3 支持。
// v28（M5.2.P-B10）：登记主页来源排除行名称与路径叶节点及独立状态。
// v29（M5.2.P-B13）：登记主页已导入目录移除按钮文字。
// v30（M5.2.P-B15）：总 tokens 数值对齐实际凹槽表面并覆盖同宿主聚光态。
// v31（M5.2.P-A11）：登记时间分布标题与范围说明的同宿主聚光状态。
// v32（M5.2.P-B20）：登记估价说明自身文字与来源链接文字。
// v33（M5.2.P-A17）：详情栏四个文字角色进入独立聚光状态。
// v34（M5.2.P-A22）：详情 ready 改用非嵌套 :has 与同一 bar-label 内的相邻 name/value。
// v35（M5.2.P-A31）：登记必要详情条形填充及无 tooltip 的独立聚光状态。
// v36（M5.2.P-A48）：input surfaces use ceramic-well; excluded leaf opacity is foreground alpha.
// v37（M5.2.P-A51）：排除来源名称/路径叶 opacity 0.55 -> 0.75，并同步四个前景 alpha。
// v38（M5.2.C-C45）：语言按钮使用实际迷你凸起面，并登记 zh-CN 选中叶独立聚光文字角色/状态。
// v39（M5.2 recovery A）：聚光覆盖改为装饰；详情条形按已有可见名称/数值降为冗余图形。
export const ROLES_VERSION = 39;

/** {kind:"var"} 颜色表达式简写。 */
const v = (name) => ({ kind: "var", name });
/** {kind:"alpha"} — 前景以 alpha 叠到背景上，快速检查按实际合成计算。 */
const alpha = (color, a) => ({ kind: "alpha", color, alpha: a });
/** {kind:"mix-srgb"} — 生产混色为 sRGB 线性插值（skins.js mixPaletteColours）。 */
const mix = (left, right, ratio) => ({ kind: "mix-srgb", left, right, ratio });

// 背景表达式（§4.4：背景类型与颜色表达式分开）。
const solid = (color) => ({ kind: "solid", color });
const grad = (angle, stops) => ({ kind: "linear-gradient", angle, stops });
const layered = (description) => ({ kind: "layered", browserRequired: true, description });
const canvasBg = (canvasSelector, description) => ({
  kind: "canvas",
  browserRequired: true,
  canvasSelector,
  description,
});

const stop = (offset, color) => ({ offset, color });

/** 面板/指标卡/弹窗：三段陶瓷渐变（styles.css 2408-2414，55% 变体见 120/619）。 */
const BG_PANEL_CERAMIC = grad(135, [
  stop(0, v("--ceramic-top")),
  stop(0.45, v("--neo-surface")),
  stop(1, v("--ceramic-bottom")),
]);
/** 控件组/顶栏动作区：55% 中点的陶瓷渐变（styles.css 120、614-621）。 */
const BG_GROUP_CERAMIC = grad(135, [
  stop(0, v("--ceramic-top")),
  stop(0.55, v("--neo-surface")),
  stop(1, v("--ceramic-bottom")),
]);
/** 迷你凸起件（菜单项/日历清除/日期图标）：145° 两段渐变。 */
const BG_MINI_CERAMIC = grad(145, [stop(0, v("--ceramic-top")), stop(1, v("--ceramic-bottom"))]);
/** 普通控件表面（styles.css 2196-2207、2293-2300）。--panel 经样式表恒等 --neo-surface（2364）。 */
const BG_SURFACE = solid(v("--neo-surface"));
const BG_TABLE = solid(v("--panel"));
/** Actual input surface: styles.css 2971-2977 overrides the earlier --control. */
const BG_INPUT = solid(v("--ceramic-well"));
const BG_TRACK = solid(v("--track"));
/** 时间分布画布：canvas 不绘制背景，实际背景为凹陷井表面。 */
const BG_TIMELINE_CANVAS = canvasBg(
  "#timelineChart",
  "canvas 透明；实际背景为 .timeline-chart-well 的 --ceramic-well（styles.css 2335-2342）",
);

const CSS = (selector) => selector;
const REF = (file, symbol, line) => ({ file, symbol, line });

export const ROLE_CATALOG = Object.freeze([
  // --- 页面 / 面板正文、指标、说明、长名称 -----------------------------------
  {
    id: "page.body-text",
    kind: "text",
    selector: CSS(
      "#homeList .home-row:not(.excluded) > .home-label > strong, #homeList .home-row:not(.excluded) > .home-meta > .home-status, #homeList .home-row:not(.excluded) > .home-path",
    ),
    states: ["dashboard-default"],
    foreground: v("--ink"),
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability: "仅主页面非排除来源行的 --ink 普通文字；不作为全站兜底",
    sourceRefs: [
      REF("public/app.js", "renderHomesHtml", 2878),
      REF("public/styles.css", "body --ink", 54),
      REF("public/styles.css", ".home-path inherits text color", 1826),
      REF("public/styles.css", ".home-status --ink", 1850),
      REF("public/styles.css", ".home-list --ceramic-well", 3108),
      REF("public/styles.css", ".home-list .home-row transparent", 3125),
    ],
  },
  {
    id: "page.body-muted",
    kind: "text",
    selector: CSS(
      "#homeList .home-row:not(.excluded) > .home-label > .home-kind, #homeList .home-row:not(.excluded) > .home-meta > span:not(.home-status):not(.home-excluded)",
    ),
    states: ["dashboard-default"],
    foreground: v("--muted"),
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability: "仅主页面非排除来源行的 --muted 类型与计数文字；不包括排除标记",
    sourceRefs: [
      REF("public/app.js", "renderHomesHtml", 2878),
      REF("public/styles.css", ".home-kind --muted", 1834),
      REF("public/styles.css", ".home-meta --muted", 1840),
      REF("public/styles.css", ".home-list --ceramic-well", 3108),
      REF("public/styles.css", ".home-list .home-row transparent", 3125),
    ],
  },
  {
    id: "panel.metric-value",
    kind: "text",
    selector: CSS(".metric strong"),
    states: ["dashboard-default", "spotlight-metric-label"],
    selectorsByState: {
      "dashboard-default": ".metric strong",
      "spotlight-metric-label": ".metric:has(> #totalTokens) > #totalTokens",
    },
    foreground: v("--ink"),
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability: "22px/700 达 WCAG 大字下限（3:1 允许），但按主文字 4.5 硬门执行；7.2 求解目标由 policy 承担",
    sourceRefs: [REF("public/styles.css", ".metric strong --ceramic-well", 2892)],
  },
  {
    id: "panel.metric-label",
    kind: "text",
    selector: CSS(".metric span"),
    states: ["dashboard-default", "spotlight-metric-label"],
    selectorsByState: {
      "dashboard-default": ".metric span",
      "spotlight-metric-label": ".metric:has(> #totalTokens) > span:not(.metric-new)",
    },
    foreground: v("--muted"),
    background: BG_PANEL_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "13px 小字",
    sourceRefs: [REF("public/styles.css", ".metric span", 143), REF("public/styles.css", ".metric", 1054)],
  },
  {
    id: "panel.heading-label",
    kind: "text",
    selector: CSS(".panel-heading span, .panel-heading .comparison-as-of"),
    states: ["dashboard-default", "spotlight-timeline-heading", "spotlight-detail-bars"],
    selectorsByState: {
      "dashboard-default": ".panel-heading span, .panel-heading .comparison-as-of",
      "spotlight-timeline-heading":
        ".chart-panel[data-spotlight-active] > .timeline-heading > .timeline-title > #rangeLabel",
      "spotlight-detail-bars": "#detailPanel[data-spotlight-active] > .panel-heading > #detailModeLabel:not(:empty)",
    },
    foreground: v("--muted"),
    background: BG_PANEL_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability:
      "13px 面板标题辅助说明小字；含跨周期对比面板 .comparison-as-of 的『统计截至』截止时间（renderPeriodComparisons 以 textContent 更新，无子元素）；实际非空与像素比值仍待实机核验",
    sourceRefs: [
      REF("public/styles.css", ".panel-heading span", 143),
      REF("public/styles.css", ".comparison-as-of --muted", 1120),
      REF("public/app.js", "renderPeriodComparisons 更新 data-comparison-as-of textContent", 1919),
    ],
  },
  {
    id: "panel.section-title",
    kind: "text",
    selector: CSS(".panel-heading h2"),
    states: ["dashboard-default", "spotlight-timeline-heading", "spotlight-detail-bars"],
    selectorsByState: {
      "dashboard-default": ".panel-heading h2",
      "spotlight-timeline-heading":
        ".chart-panel[data-spotlight-active] > .timeline-heading > .timeline-title > #timelinePanelTitle",
      "spotlight-detail-bars": "#detailPanel[data-spotlight-active] > .panel-heading > #detailPanelTitle:not(:empty)",
    },
    foreground: v("--ink"),
    background: BG_PANEL_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "",
    sourceRefs: [REF("public/styles.css", ".timeline-title h2", 271)],
  },
  {
    id: "panel.detail-bar-name",
    kind: "text",
    selector: CSS("#detailList .bar-row > .bar-label > .bar-name"),
    states: ["dashboard-default", "dense-data", "spotlight-detail-bars"],
    selectorsByState: {
      "dashboard-default": "#detailList .bar-row > .bar-label > .bar-name",
      "dense-data": "#detailList .bar-row > .bar-label > .bar-name",
      "spotlight-detail-bars":
        "#detailPanel[data-spotlight-active] > #detailList:not([hidden]) > .bar-row > .bar-label > .bar-name:not(:empty)",
    },
    foreground: v("--ink"),
    background: BG_PANEL_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability:
      "详情面板（按渠道/按模型/按花销）行名称文字；token 与 cost 两种 renderer 共用同一叶节点结构，表面为 .detail-panel 的三段陶瓷渐变；cost 视图 fixture 非空与叶节点可见性仍待实机核验",
    sourceRefs: [
      REF("public/app.js", "renderBarListHtml", 1566),
      REF("public/app.js", "renderCostDetailHtml", 1644),
      REF("public/styles.css", "body --ink", 54),
      REF("public/styles.css", ".bar-name", 1825),
      REF("public/styles.css", ".panel BG_PANEL_CERAMIC", 2820),
    ],
  },
  {
    id: "panel.detail-bar-value",
    kind: "text",
    selector: CSS("#detailList .bar-row > .bar-label > .bar-value"),
    states: ["dashboard-default", "dense-data", "spotlight-detail-bars"],
    selectorsByState: {
      "dashboard-default": "#detailList .bar-row > .bar-label > .bar-value",
      "dense-data": "#detailList .bar-row > .bar-label > .bar-value",
      "spotlight-detail-bars":
        "#detailPanel[data-spotlight-active] > #detailList:not([hidden]) > .bar-row > .bar-label > .bar-value:not(:empty)",
    },
    foreground: v("--muted"),
    background: BG_PANEL_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability:
      "详情面板（按渠道/按模型/按花销）行数值文字；tabular-nums，前景 --muted，token 与 cost 两种 renderer 共用同一叶节点结构，表面为 .detail-panel 的三段陶瓷渐变；cost 视图 fixture 非空仍待实机核验",
    sourceRefs: [
      REF("public/app.js", "renderBarListHtml", 1566),
      REF("public/app.js", "renderCostDetailHtml", 1644),
      REF("public/styles.css", ".bar-value --muted", 1833),
      REF("public/styles.css", ".panel BG_PANEL_CERAMIC", 2820),
    ],
  },
  {
    id: "summary.trend-up",
    kind: "text",
    selector: CSS(".comparison-item.up strong"),
    states: ["comparison-trend-up"],
    foreground: v("--green"),
    background: BG_PANEL_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "固定色 --green（BASE_COLORS）；18px/700 略低于大字下限；必要小字交 M1.4 受限分支",
    sourceRefs: [
      REF("public/styles.css", ".comparison-item.up strong", 1038),
      REF("public/styles.css", "--green 定义", 17),
    ],
  },
  {
    id: "summary.trend-down",
    kind: "text",
    selector: CSS(".comparison-item.down strong"),
    states: ["comparison-trend-down"],
    foreground: v("--red"),
    background: BG_PANEL_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "固定色 --red（BASE_COLORS）；M1.4 受限分支",
    sourceRefs: [REF("public/styles.css", ".comparison-item.down strong", 1042)],
  },
  {
    id: "empty.state-text",
    kind: "text",
    selector: CSS(".empty"),
    states: ["empty-range"],
    foreground: v("--muted"),
    background: BG_PANEL_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "仅无数据/范围无结果时出现；由 empty-range 状态覆盖（M4 导航至无数据的固定月份 2026-01）",
    sourceRefs: [REF("public/styles.css", ".empty", 1490)],
  },

  // --- 表格 ------------------------------------------------------------------
  {
    id: "table.comparison-header",
    kind: "text",
    selector: CSS(".comparison-table thead th"),
    states: ["dashboard-default", "dense-data"],
    foreground: v("--muted"),
    background: BG_TABLE,
    threshold: 4.5,
    required: true,
    applicability: "13px；sticky 表头",
    sourceRefs: [REF("public/styles.css", ".comparison-table thead th", 1162)],
  },
  {
    id: "table.comparison-cell",
    kind: "text",
    selector: CSS(".comparison-table td, .comparison-table tbody th .comparison-row-label"),
    states: ["dashboard-default", "dense-data"],
    foreground: v("--ink"),
    background: BG_TABLE,
    threshold: 4.5,
    required: true,
    applicability: "tbody th 中的 .comparison-row-label 主行名称与 td 数值正文；统一按 --ink 正文色测量",
    sourceRefs: [
      REF("public/styles.css", ".comparison-table th, .comparison-table td", 1161),
      REF("public/styles.css", ".comparison-table th:first-child", 1213),
      REF("public/styles.css", ".comparison-row-label", 1242),
    ],
  },
  {
    id: "table.comparison-total",
    kind: "text",
    selector: CSS(".comparison-table tfoot td"),
    states: ["dashboard-default"],
    foreground: v("--ink"),
    background: BG_TABLE,
    threshold: 4.5,
    required: true,
    applicability: "全局合计钉底行",
    sourceRefs: [REF("public/styles.css", ".comparison-table tfoot", 1250)],
  },

  // --- 输入值与占位文字 -------------------------------------------------------
  {
    id: "input.value",
    kind: "text",
    selector: CSS("#importPath, #pricingSearch, #usdToCnyRate"),
    states: ["pricing-input-filled", "dialog-import-open"],
    selectorsByState: {
      "dialog-import-open": CSS("#importPath"),
      "pricing-input-filled": CSS("#pricingSearch, #usdToCnyRate"),
    },
    foreground: v("--ink"),
    background: BG_INPUT,
    threshold: 4.5,
    required: true,
    applicability:
      "文字值仅覆盖 #importPath、#pricingSearch、#usdToCnyRate，排除 checkbox；实际背景为后半段 --ceramic-well；空值判定留给 E1b 按实际节点检查",
    sourceRefs: [
      REF("public/index.html", "#importPath", 322),
      REF("public/index.html", "#pricingSearch", 349),
      REF("public/index.html", "#usdToCnyRate", 351),
      REF("public/styles.css", "input, select --ceramic-well", 2971),
    ],
  },
  {
    id: "input.placeholder",
    kind: "text",
    selector: CSS(":is(#modelComparisonSearch, #repositoryComparisonSearch, #pricingSearch)::placeholder"),
    states: ["dashboard-default", "dialog-pricing-open", "input-focus"],
    selectorsByState: {
      "dashboard-default": CSS(":is(#modelComparisonSearch, #repositoryComparisonSearch)::placeholder"),
      "dialog-pricing-open": CSS("#pricingSearch::placeholder"),
      "input-focus": CSS("#pricingSearch::placeholder"),
    },
    foreground: alpha(v("--muted"), 0.76),
    background: BG_INPUT,
    threshold: 4.5,
    required: true,
    applicability:
      "默认看板覆盖模型/仓库搜索框，计价弹窗覆盖 #pricingSearch；按76%实际alpha合成，背景为后半段 --ceramic-well。#importPath 空占位仍未覆盖，留作独立缺测；空值由E1b检查实际节点",
    sourceRefs: [
      REF("public/index.html", "#modelComparisonSearch", 270),
      REF("public/index.html", "#repositoryComparisonSearch", 281),
      REF("public/index.html", "#pricingSearch", 349),
      REF("public/styles.css", "input::placeholder", 68),
      REF("public/styles.css", "input, select --ceramic-well", 2971),
    ],
  },
  {
    id: "select.zone-label",
    kind: "text",
    selector: CSS("#calendarZoneSelect"),
    states: ["dashboard-default"],
    foreground: v("--muted"),
    background: BG_GROUP_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "hover/focus 时转 --blue（styles.css 502-505），归入强调文字角色复测",
    sourceRefs: [REF("public/styles.css", "#calendarZoneSelect", 491)],
  },

  // --- 普通按钮与菜单文字 ------------------------------------------------------
  {
    id: "button.secondary",
    kind: "text",
    selector: CSS(
      ".dialog-actions button:not([type=submit]):enabled, .path-picker button:enabled, .panel-action:enabled, .segmented > button:enabled, .recent-range-menu button:enabled",
    ),
    states: ["dashboard-default", "button-hover", "dialog-import-open", "dialog-pricing-open", "menu-recent-open"],
    selectorsByState: {
      "dashboard-default": ".panel-action:enabled, .segmented > button:enabled",
      "button-hover": "#addImportButton:hover",
      "menu-recent-open": "#recentRangeMenu:not([hidden]) button:enabled",
      "dialog-import-open":
        "#importDialog:not([hidden]) #cancelImportButton:enabled, #importDialog:not([hidden]) #pickImportDirectoryButton:enabled",
      "dialog-pricing-open":
        "#pricingDialog:not([hidden]) #cancelPricingButton:enabled, #pricingDialog:not([hidden]) .panel-action:enabled, #pricingDialog:not([hidden]) .segmented > button:enabled",
    },
    foreground: v("--ink"),
    background: BG_SURFACE,
    threshold: 4.5,
    required: true,
    applicability:
      "只测本状态可见且启用的次要操作；各弹窗与展开菜单按状态限定范围，submit 由 button.primary 测，禁用动作不算可操作目标",
    sourceRefs: [
      REF("public/styles.css", ".dialog-actions button 等", 2196),
      REF("public/styles.css", ".recent-range-menu button", 866),
      REF("public/index.html", "dashboard / import / pricing 操作按钮", 74),
      REF("public/app.js", "openImportDialog / renderPricingModelList", 4021),
    ],
  },
  {
    id: "button.primary",
    kind: "text",
    selector: CSS("#submitImportButton, #savePricingButton"),
    states: ["dialog-import-open", "dialog-pricing-open"],
    foreground: v("--active-ink"),
    background: solid(v("--blue")),
    threshold: 4.5,
    required: true,
    applicability: "唯一保留的填充蓝 + active-ink 组合（styles.css 2249-2255）",
    sourceRefs: [REF("public/styles.css", "#submitImportButton/#savePricingButton", 2249)],
  },
  {
    id: "button.hover-border",
    kind: "graphic",
    selector: CSS(".dialog-actions button:hover 等 :hover 边框"),
    states: ["button-hover"],
    foreground: v("--control-hover"),
    background: BG_SURFACE,
    threshold: null,
    required: false,
    applicability: "例外：悬停反馈与指针光标重复，非唯一识别通道（styles.css 2209-2218）",
    sourceRefs: [REF("public/styles.css", ":hover 边框", 2209)],
  },
  {
    id: "menu.item-selected",
    kind: "text",
    selector: CSS('.recent-range-menu button[aria-selected="true"]'),
    states: ["menu-recent-open"],
    foreground: v("--blue"),
    background: BG_SURFACE,
    threshold: 4.5,
    required: true,
    applicability: "后半段 2302-2310 覆盖早期 890-894（--track + --ink）——“蓝字凹槽”为最终生效",
    sourceRefs: [REF("public/styles.css", "aria-selected", 2302)],
  },
  {
    id: "preset.selected-label",
    kind: "text",
    selector: CSS('.segmented button.active, .segmented-well button[aria-pressed="true"]'),
    states: ["preset-selected"],
    foreground: v("--blue"),
    background: BG_SURFACE,
    threshold: 4.5,
    required: true,
    applicability: "后半段 2220-2228 覆盖早期 524-529（--active-ink on --blue）——最终生效为蓝字凹槽",
    sourceRefs: [REF("public/styles.css", ".segmented button.active", 2220)],
  },
  {
    id: "preset.quota-mode-selected",
    kind: "text",
    selector: CSS("#presetButtons .quota-preset-mode.is-selected"),
    states: ["quota-toast"],
    foreground: v("--blue"),
    background: BG_GROUP_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "5h/周额度双段切换的选中段",
    sourceRefs: [REF("public/styles.css", ".quota-preset-mode.is-selected", 570)],
  },
  {
    id: "preset.quota-mode-idle",
    kind: "text",
    selector: CSS("#presetButtons .quota-preset-toggle.active .quota-preset-mode:not(.is-selected)"),
    states: ["quota-toast"],
    foreground: v("--muted"),
    background: BG_GROUP_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "",
    sourceRefs: [REF("public/styles.css", ".quota-preset-mode:not(.is-selected)", 566)],
  },
  {
    id: "toast.quota-status",
    kind: "text",
    selector: CSS(".quota-preset-status"),
    states: ["quota-toast"],
    foreground: v("--ink"),
    background: BG_SURFACE,
    threshold: 4.5,
    required: true,
    applicability: "固定角标 toast",
    sourceRefs: [REF("public/styles.css", ".quota-preset-status", 583)],
  },

  // --- 强调色小字 / 图标 / 填充按钮 -------------------------------------------
  {
    id: "toggle.autorefresh-on",
    kind: "text",
    selector: CSS('#autoRefreshToggle[aria-pressed="true"]'),
    states: ["autorefresh-on"],
    foreground: v("--record"),
    background: BG_GROUP_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability:
      "有效色 = var(--blue)（styles.css 后半段覆盖 --toggle-selected），与 --record/--accent 同源（候选可控）",
    sourceRefs: [REF("public/styles.css", "#autoRefreshToggle", 205)],
  },
  {
    id: "toggle.autorefresh-off",
    kind: "text",
    selector: CSS('#autoRefreshToggle[aria-pressed="false"]'),
    states: ["autorefresh-off"],
    foreground: v("--red"),
    background: BG_GROUP_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "固定色 --red（BASE_COLORS）；必要状态小字，M1.4 受限分支",
    sourceRefs: [REF("public/styles.css", "aria-pressed=false", 234)],
  },
  {
    id: "status.autorefresh-error",
    kind: "text",
    selector: CSS(".auto-refresh-error.is-error"),
    states: ["autorefresh-error"],
    foreground: v("--red"),
    background: BG_GROUP_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability:
      "仅自动刷新请求失败时出现；由 autorefresh-error 状态覆盖（M4 令 /api/usage 轮询失败）；固定色 --red，M1.4 受限分支",
    sourceRefs: [REF("public/styles.css", ".auto-refresh-error.is-error", 254)],
  },
  {
    id: "toolbar.autorefresh-text",
    kind: "text",
    selector: CSS("#autoRefreshInterval, #lastSuccessfulCheck"),
    states: ["dashboard-default"],
    foreground: v("--ink"),
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability:
      "自动刷新凹槽内的刷新间隔数值与上次成功检查时间文字；继承 body --ink 前景，直接承载于 .auto-refresh-well 的 --ceramic-well 凹槽表面；实际像素比值与实机可测性仍待实机核验",
    sourceRefs: [
      REF("public/index.html", "#autoRefreshInterval", 143),
      REF("public/index.html", "#lastSuccessfulCheck", 151),
      REF("public/app.js", "renderAutoRefreshControls", 3225),
      REF("public/styles.css", "body --ink", 54),
      REF("public/styles.css", ".auto-refresh-well --ceramic-well", 159),
    ],
  },
  {
    id: "toolbar.autorefresh-muted",
    kind: "text",
    selector: CSS("#autoRefreshStatus .auto-refresh-label"),
    states: ["dashboard-default"],
    foreground: v("--muted"),
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability:
      "自动刷新凹槽内的『自动刷新』标签文字；显式 --muted 前景，承载于 .auto-refresh-well 的 --ceramic-well 表面；实际像素比值与实机可测性仍待实机核验",
    sourceRefs: [
      REF("public/index.html", ".auto-refresh-label", 143),
      REF("public/styles.css", ".auto-refresh-label --muted", 201),
      REF("public/styles.css", ".auto-refresh-well --ceramic-well", 159),
    ],
  },
  {
    id: "toolbar.range-label",
    kind: "text",
    selector: CSS(".toolbar > .range-controls > .range-heading > span"),
    states: ["dashboard-default"],
    foreground: v("--muted"),
    background: BG_GROUP_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability:
      "普通范围组标题『范围』必要文字；index 中位于 #presetButtons 凹槽之前，显式 --muted、13px，并承载于 .toolbar > .control-group 的 BG_GROUP_CERAMIC（135°、55% 中点）；最终像素比值与实际可读性仍待实机核验",
    sourceRefs: [
      REF("public/index.html", ".range-controls > .range-heading > span", 72),
      REF("public/styles.css", ".control-group span --muted / 13px", 145),
      REF("public/styles.css", ".toolbar > .control-group BG_GROUP_CERAMIC", 614),
    ],
  },
  {
    id: "warning.timeline-range",
    kind: "text",
    selector: CSS(".timeline-range-warning"),
    states: ["timeline-range-warning"],
    foreground: v("--red"),
    background: BG_PANEL_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "时间线范围超过 2000 个槽位时显示告警；仅提示、不截断数据；M1.4 受限分支",
    sourceRefs: [REF("public/styles.css", ".timeline-range-warning", 262)],
  },
  {
    id: "preset.date-range-start",
    kind: "text",
    selector: CSS(".date-range-button.has-range #dateRangeStart"),
    states: ["calendar-range"],
    foreground: v("--blue"),
    background: BG_GROUP_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "12px 小字",
    sourceRefs: [REF("public/styles.css", "#dateRangeStart", 2811)],
  },
  {
    id: "preset.date-range-end",
    kind: "text",
    selector: CSS(".date-range-button.has-range #dateRangeEnd"),
    states: ["calendar-range"],
    foreground: v("--red"),
    background: BG_GROUP_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "固定色 --red；M1.4 受限分支",
    sourceRefs: [REF("public/styles.css", "#dateRangeEnd", 2815)],
  },
  {
    id: "hint.calendar-hint",
    kind: "text",
    selector: CSS(".date-picker-hint"),
    states: ["calendar-open", "calendar-range"],
    foreground: v("--blue"),
    background: BG_SURFACE,
    threshold: 4.5,
    required: true,
    applicability: "12px；picking-end 时转 --red（2897-2899）并入 --red 小字复测",
    sourceRefs: [REF("public/styles.css", ".date-picker-hint", 2891)],
  },
  {
    id: "button.calendar-clear",
    kind: "text",
    selector: CSS(".date-picker-clear:enabled"),
    states: ["calendar-range"],
    foreground: v("--muted"),
    background: BG_MINI_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability:
      "仅 calendar-range 有可清除选区；calendar-open 无选区时按钮 disabled，不计为此操作角色。12px；hover 转 --red + 45% 辉光（2934-2937），辉光不计入前景亮度",
    sourceRefs: [REF("public/styles.css", ".date-picker-clear", 2914)],
  },
  {
    id: "badge.record",
    kind: "graphic",
    selector: CSS(".metric-new"),
    states: ["metric-record-visible"],
    foreground: null,
    background: BG_PANEL_CERAMIC,
    threshold: 3,
    required: true,
    applicability:
      "必要图形：renderRecordBadges 清空文字并设 role=img/aria-label；ceramic 样式将其渲染为 7×7px --record 圆点。computed background-color 是圆点自身的前景色；此处 BG_PANEL_CERAMIC 描述其后方指标卡表面。box-shadow 光晕不计入可读性对比。",
    sourceRefs: [
      REF("public/app.js", "renderRecordBadges：空文字与 role=img", 1475),
      REF("public/styles.css", ".metric .metric-new：7×7 圆点与 --record 填充", 3172),
    ],
  },
  {
    id: "indicator.sort",
    kind: "text",
    selector: CSS(".comparison-sort-indicator"),
    states: ["comparison-sort-active"],
    foreground: v("--blue"),
    background: BG_TABLE,
    threshold: 4.5,
    required: true,
    applicability: "10px 排序方向字符；方向亦有 aria 表达，但视觉不可省",
    sourceRefs: [REF("public/styles.css", ".comparison-sort-indicator", 1200)],
  },
  {
    id: "graphic.repo-icon",
    kind: "graphic",
    selector: CSS(".repository-git-icon"),
    states: ["dense-data"],
    foreground: v("--green"),
    background: BG_TABLE,
    threshold: null,
    required: false,
    applicability: "例外：14px 类型图标与行内名称/路径文字重复，非唯一识别通道（styles.css 1228-1233）",
    sourceRefs: [REF("public/styles.css", ".repository-git-icon", 1228)],
  },
  {
    id: "toggle.language-selected",
    kind: "text",
    selector: CSS(".language-toggle > .is-selected"),
    states: ["dashboard-default"],
    foreground: v("--toggle-selected"),
    background: BG_MINI_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability:
      "有效色 = var(--blue)（styles.css 后半段把 --toggle-selected 覆盖为 --blue，随强调色联动，非固定色）；承载当前语言信息；背景为实际 .theme-toggle 145 度迷你凸起面",
    sourceRefs: [
      REF("public/styles.css", ".language-toggle > .is-selected", 456),
      REF("public/styles.css", "--toggle-selected 定义", 377),
      REF("public/styles.css", ".theme-toggle 145 度迷你凸起面", 2908),
    ],
  },

  // --- 表格 / 日历 / 设置 / 导入与计价弹窗 -------------------------------------
  {
    id: "dialog.copy",
    kind: "text",
    selector: CSS(".dialog-copy, .dialog-message"),
    states: ["dialog-import-open", "dialog-pricing-open"],
    foreground: v("--muted"),
    background: BG_PANEL_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "13px",
    sourceRefs: [
      REF("public/styles.css", ".dialog-copy/.dialog-message", 1527),
      REF("public/styles.css", ".dialog 背景", 2408),
    ],
  },
  {
    id: "dialog.error-message",
    kind: "text",
    selector: CSS(".dialog-message.error, #importForm .dialog-message:not(:empty)"),
    states: ["dialog-import-error"],
    foreground: v("--red"),
    background: BG_PANEL_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "错误/提示说明；固定色 --red，M1.4 受限分支",
    sourceRefs: [
      REF("public/styles.css", ".dialog-message.error", 1959),
      REF("public/styles.css", "#importForm .dialog-message", 3194),
    ],
  },
  {
    id: "pricing.badge-missing",
    kind: "text",
    selector: CSS(".pricing-state-badge.missing"),
    states: ["dialog-pricing-open"],
    foreground: v("--red"),
    background: BG_PANEL_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "10px 缺价徽标；仅存在缺价模型时出现；M1.4 受限分支",
    sourceRefs: [REF("public/styles.css", ".pricing-state-badge.missing", 1777)],
  },
  {
    id: "pricing.badge-default",
    kind: "text",
    selector: CSS(".pricing-state-badge"),
    states: ["dialog-pricing-open"],
    foreground: v("--muted"),
    background: BG_PANEL_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "10px 状态徽标（免费/默认）",
    sourceRefs: [REF("public/styles.css", ".pricing-state-badge", 1766)],
  },
  {
    id: "status.home-reason",
    kind: "text",
    selector: CSS("#homeList .home-reason"),
    states: ["home-list-reason"],
    foreground: v("--red"),
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability: "12px 主页面必要文字：已保存导入的不可用原因；来源列表显示时导入弹窗关闭",
    sourceRefs: [
      REF("public/app.js", "renderHomesHtml", 2878),
      REF("public/styles.css", ".home-reason", 1855),
      REF("public/styles.css", ".home-list", 3108),
    ],
  },
  {
    id: "home.remove",
    kind: "text",
    selector: CSS("#homeList .home-remove:enabled"),
    states: ["home-list-reason"],
    foreground: v("--ink"),
    background: BG_MINI_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability: "主页面已导入目录移除按钮文字；仅 canModify && imported 时渲染，角色登记不代表实测",
    sourceRefs: [
      REF("public/app.js", "renderHomesHtml", 2893),
      REF("public/styles.css", ".home-remove", 1861),
      REF("public/styles.css", "ceramic button surface", 2915),
    ],
  },
  {
    id: "home.excluded-name",
    kind: "text",
    selector: CSS("#homeList .home-row.excluded > .home-label > strong"),
    states: ["home-source-excluded"],
    foreground: alpha(v("--ink"), 0.75),
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability:
      "主页排除行名称 strong；叶自身 opacity 0.75 已按 foreground alpha 编码；登记不代表实测，B8 弹窗结果不外推",
    sourceRefs: [
      REF("public/app.js", "renderHomesHtml", 2878),
      REF("public/styles.css", "body --ink", 54),
      REF("public/styles.css", ".home-row.excluded opacity", 2040),
      REF("public/styles.css", ".home-list --ceramic-well", 3108),
    ],
  },
  {
    id: "home.excluded-path",
    kind: "text",
    selector: CSS("#homeList .home-row.excluded > .home-path"),
    states: ["home-source-excluded"],
    foreground: alpha(v("--ink"), 0.75),
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability:
      "主页排除行完整路径；.home-path 继承 --ink、未声明 --muted；叶自身 opacity 0.75 已按 foreground alpha 编码；登记不代表实测",
    sourceRefs: [
      REF("public/app.js", "renderHomesHtml", 2878),
      REF("public/styles.css", ".home-path inherits --ink", 1826),
      REF("public/styles.css", ".home-row.excluded opacity", 2041),
      REF("public/styles.css", ".home-list --ceramic-well", 3108),
    ],
  },
  {
    id: "status.home-excluded",
    kind: "text",
    selector: CSS("#sourcePicker .home-excluded"),
    states: ["dialog-import-source-excluded"],
    foreground: v("--red"),
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability: "11px/700 #sourcePicker 来源排除标记，文字保持全强度；按 --ceramic-well 表面与内阴影实测",
    sourceRefs: [REF("public/styles.css", ".home-excluded", 2033), REF("public/styles.css", ".source-picker", 3115)],
  },
  {
    id: "dialog.source-excluded-name",
    kind: "text",
    selector: CSS("#sourcePicker .source-option.excluded > .source-option-text > .source-option-label > strong"),
    states: ["dialog-import-source-excluded"],
    foreground: alpha(v("--ink"), 0.75),
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability:
      "来源排除行名称 strong 必要文字；叶节点自身 opacity 0.75 已按 foreground alpha 编码；角色登记不构成实测",
    sourceRefs: [
      REF("public/app.js", "renderSourceOptionsHtml", 2846),
      REF("public/styles.css", ".source-option-label --ink", 1991),
      REF("public/styles.css", ".source-option.excluded opacity", 2028),
      REF("public/styles.css", ".source-picker --ceramic-well", 3115),
    ],
  },
  {
    id: "dialog.source-excluded-path",
    kind: "text",
    selector: CSS("#sourcePicker .source-option.excluded > .source-option-text > .source-option-path"),
    states: ["dialog-import-source-excluded"],
    foreground: alpha(v("--muted"), 0.75),
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability:
      "来源排除行路径 span 必要文字；叶节点自身 opacity 0.75 已按 foreground alpha 编码；角色登记不构成实测",
    sourceRefs: [
      REF("public/app.js", "renderSourceOptionsHtml", 2846),
      REF("public/styles.css", ".source-option-path --muted", 2020),
      REF("public/styles.css", ".source-option.excluded opacity", 2028),
      REF("public/styles.css", ".source-picker --ceramic-well", 3115),
    ],
  },
  {
    id: "dialog.source-option-text",
    kind: "text",
    selector: CSS(
      "#sourcePicker .source-option:not(.excluded) > .source-option-text > .source-option-label > strong, #sourcePicker .source-option:not(.excluded) > .source-option-text > .source-option-meta > .home-status",
    ),
    states: ["dialog-import-open"],
    foreground: v("--ink"),
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability:
      "导入弹窗来源列表非排除行的 --ink 普通文字（来源名称 strong 与状态 .home-status）；路径为 --muted 不在此列，排除行 0.75 opacity 已由专门角色编码；实机样本待后续核验",
    sourceRefs: [
      REF("public/app.js", "renderSourceOptionsHtml", 2846),
      REF("public/styles.css", ".source-option-label --ink", 1991),
      REF("public/styles.css", ".home-status --ink", 1850),
      REF("public/styles.css", ".source-picker --ceramic-well", 3115),
    ],
  },
  {
    id: "dialog.source-option-muted",
    kind: "text",
    selector: CSS(
      "#sourcePicker .source-option:not(.excluded) > .source-option-text > .source-option-label > .home-kind, #sourcePicker .source-option:not(.excluded) > .source-option-text > .source-option-meta > span:not(.home-status):not(.home-excluded), #sourcePicker .source-option:not(.excluded) > .source-option-text > .source-option-path",
    ),
    states: ["dialog-import-open"],
    foreground: v("--muted"),
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability:
      "导入弹窗来源列表非排除行的 --muted 次要文字（类型 .home-kind、事件/会话计数与路径 .source-option-path）；不包括排除标记 .home-excluded，排除行路径 0.75 opacity 已由专门角色编码",
    sourceRefs: [
      REF("public/app.js", "renderSourceOptionsHtml", 2846),
      REF("public/styles.css", ".home-kind --muted", 1834),
      REF("public/styles.css", ".source-option-meta --muted", 2006),
      REF("public/styles.css", ".source-option-path --muted", 2020),
      REF("public/styles.css", ".source-picker --ceramic-well", 3115),
    ],
  },
  {
    id: "calendar.day",
    kind: "text",
    selector: CSS(".date-picker-day"),
    states: ["calendar-open"],
    foreground: v("--ink"),
    background: BG_SURFACE,
    threshold: 4.5,
    required: true,
    applicability: "弹层背景为 --neo-surface（styles.css 2293-2300）",
    sourceRefs: [REF("public/styles.css", ".date-picker-day", 674)],
  },
  {
    id: "calendar.weekday",
    kind: "text",
    selector: CSS(".date-picker-weekday"),
    states: ["calendar-open"],
    foreground: v("--muted"),
    background: BG_SURFACE,
    threshold: 4.5,
    required: true,
    applicability: "12px",
    sourceRefs: [REF("public/styles.css", ".date-picker-weekday", 697)],
  },
  {
    id: "calendar.day-outside",
    kind: "text",
    selector: CSS(".date-picker-day.outside-month"),
    states: ["calendar-open"],
    foreground: v("--muted"),
    background: BG_SURFACE,
    threshold: 4.5,
    required: true,
    applicability: "相邻月仍可点击，信息必要；直接使用 --muted 前景，不使用整按钮透明度，仍按 4.5 实测",
    sourceRefs: [REF("public/styles.css", ".outside-month", 708)],
  },
  {
    id: "calendar.day-selected",
    kind: "text",
    selector: CSS(".date-picker-day.selected"),
    states: ["calendar-range"],
    foreground: v("--blue"),
    background: BG_SURFACE,
    threshold: 4.5,
    required: true,
    applicability: "后半段 2302-2310 覆盖早期 713-718（--active-ink on --blue）——蓝字凹槽为最终生效",
    sourceRefs: [REF("public/styles.css", ".date-picker-day.selected（后半段）", 2302)],
  },
  {
    id: "calendar.day-in-range",
    kind: "text",
    selector: CSS(".date-picker-day.in-range"),
    states: ["calendar-range"],
    foreground: v("--ink"),
    background: solid(mix(v("--blue"), v("--ceramic-well"), 0.91)),
    threshold: 4.5,
    required: true,
    applicability: "背景 = --blue 9% 混入 --ceramic-well（styles.css 2855-2858）",
    sourceRefs: [REF("public/styles.css", ".in-range", 2855)],
  },
  {
    id: "calendar.day-range-start",
    kind: "text",
    selector: CSS(".date-picker-day.range-start"),
    states: ["calendar-range"],
    foreground: v("--blue"),
    background: solid(mix(v("--blue"), v("--ceramic-well"), 0.87)),
    threshold: 4.5,
    required: true,
    applicability: "背景 = --blue 13% 混入 --ceramic-well（styles.css 2860-2867）",
    sourceRefs: [REF("public/styles.css", ".range-start", 2860)],
  },
  {
    id: "calendar.day-range-end",
    kind: "text",
    selector: CSS(".date-picker-day.range-end"),
    states: ["calendar-range"],
    foreground: v("--red"),
    background: solid(mix(v("--red"), v("--ceramic-well"), 0.87)),
    threshold: 4.5,
    required: true,
    applicability: "固定色 --red 混 ceramic-well；M1.4 受限分支（styles.css 2869-2876）",
    sourceRefs: [REF("public/styles.css", ".range-end", 2869)],
  },
  {
    id: "calendar.day-range-both",
    kind: "text",
    selector: CSS(".date-picker-day.range-start.range-end"),
    states: ["calendar-same-day"],
    foreground: v("--ink"),
    background: grad(90, [
      stop(0, mix(v("--blue"), v("--ceramic-well"), 0.8)),
      stop(1, mix(v("--red"), v("--ceramic-well"), 0.8)),
    ]),
    threshold: 4.5,
    required: true,
    applicability: "单日即起止：蓝 20% → 红 20% 渐变（styles.css 2878-2889）",
    sourceRefs: [REF("public/styles.css", ".range-start.range-end", 2878)],
  },

  // --- 图表文字和数据图形 ------------------------------------------------------
  {
    id: "chart.axis-text",
    kind: "text",
    selector: null,
    canvasOp: "ctx.fillStyle = chartText; ctx.fillText(轴标/峰值/空态文案)（app.js 2309/2324/2381/2388-2392/2420）",
    states: ["dashboard-default", "dense-data"],
    foreground: v("--chart-text"),
    background: BG_TIMELINE_CANVAS,
    threshold: 4.5,
    required: true,
    applicability: "chartText 为候选可控 token；画布文字含空态提示（空态归 empty.state-text 复核）",
    sourceRefs: [REF("public/app.js", "renderTimeline 绘制", 2309), REF("public/app.js", "chartText 读取", 2287)],
  },
  {
    id: "chart.axis-line",
    kind: "graphic",
    selector: null,
    canvasOp: "ctx.strokeStyle = chartLine; ctx.stroke()（仅 D6b2 身份标记的 axisPath 三点，app.js 2529-2545）",
    states: ["dashboard-default", "dense-data"],
    foreground: v("--chart-line"),
    background: BG_TIMELINE_CANVAS,
    threshold: 3,
    required: true,
    applicability:
      "坐标轴是读取数据系列的必要位置参照；只归属 D6b2 明确标记的三点轴线，不把数据系列路径并入此角色；本卡仅登记归属，不做路径像素采样",
    sourceRefs: [REF("public/app.js", "drawTimeline axisPath", 2529), REF("public/app.js", "axis-line stroke", 2545)],
  },
  {
    id: "chart.timeline-segment",
    kind: "graphic",
    selector: null,
    canvasOp:
      "ctx.fillStyle = segment.color（分类色堆叠段，app.js 2367/2374）；HTML 条图 .bar-fill 同源（app.js 1471-1482）",
    states: ["dense-data"],
    foreground: null,
    background: BG_TIMELINE_CANVAS,
    threshold: 3,
    required: true,
    applicability:
      "多系列堆叠的时间归属由颜色承载（形状相同）；分类色为 JS 固定色（app.js 443-463 CATEGORY_PALETTES/MODEL_COLOR_ORDER，越界 hash hsl），不经 12 token；系列间两两可辨与色觉模拟由 M3 差异诊断承担",
    sourceRefs: [REF("public/app.js", "timeline 段填充", 2374), REF("public/app.js", "MODEL_COLOR_ORDER", 443)],
  },
  {
    id: "chart.legend-swatch",
    kind: "graphic",
    selector: CSS(".timeline-legend-swatch"),
    states: ["dense-data"],
    foreground: null,
    background: BG_PANEL_CERAMIC,
    threshold: 3,
    required: true,
    applicability: "色块是『颜色 → 系列』映射的载体，与相邻文字名共用一角色行；分类色同 chart.timeline-segment",
    sourceRefs: [REF("public/app.js", "timeline-legend-swatch 内联 background", 2220)],
  },
  {
    id: "chart.legend-label",
    kind: "text",
    selector: CSS("#timelineLegend:not([hidden]) > .timeline-legend-item > span:not(.timeline-legend-swatch)"),
    states: ["dashboard-default", "dense-data"],
    foreground: v("--muted"),
    background: BG_PANEL_CERAMIC,
    threshold: 4.5,
    required: true,
    applicability:
      "时间分布图例系列名称文字；按渠道/按模型/按花销共用同一叶节点结构，颜色块由 chart.legend-swatch 单独按图形测量；cost 视图非空与像素比值仍待实机核验",
    sourceRefs: [
      REF("public/app.js", "renderTimelineLegendHtml", 2447),
      REF("public/index.html", "#timelineLegend", 249),
      REF("public/styles.css", ".timeline-legend --muted", 296),
      REF("public/styles.css", ".timeline-legend-item > span:last-child", 316),
      REF("public/styles.css", ".panel BG_PANEL_CERAMIC", 2820),
    ],
  },
  {
    id: "chart.model-bar",
    kind: "graphic",
    selector: CSS(".bar-fill"),
    states: ["dense-data"],
    foreground: null,
    background: BG_TRACK,
    threshold: null,
    required: false,
    applicability:
      "待核验：行内已有等价的文字名称与数值表达，条形暂按冗余装饰登记；若 M3/M4 证明无等价表达再升为必要（总计划 §5.6）",
    sourceRefs: [REF("public/app.js", "bar-fill 内联 background", 1471), REF("public/styles.css", ".bar-track", 1467)],
  },
  {
    id: "chart.detail-fill",
    kind: "graphic",
    selector: CSS("#detailPanel #detailList > .bar-row > .bar-track > .bar-fill"),
    states: ["dashboard-default", "spotlight-detail-fill"],
    foreground: null,
    background: BG_TRACK,
    threshold: null,
    required: false,
    applicability:
      "冗余图形：详情面板每条同时有可见名称和数值，条形只表达相对用量，按 chart.model-bar 同一原则不单独套图形比值；普通与聚光状态仍保留视觉检查，不并入旧 chart.model-bar，也不得推广到时间线、图例、坐标或无等价可见文字的图形。",
    sourceRefs: [
      REF("public/app.js", "renderBarListHtml：.bar-track > .bar-fill 内联填充", 1588),
      REF("public/styles.css", ".bar-track background: var(--track)", 1874),
      REF("public/styles.css", ".bar-fill 默认 linear-gradient", 1878),
      REF("public/styles.css", "亮色 ceramic 的 --track 映射到 --ceramic-well", 2770),
      REF("public/styles.css", "深色 ceramic 的 --track 映射到 --ceramic-well", 2794),
      REF("public/styles.css", ".detail-panel .bar-track 高度 4/3", 3086),
    ],
  },

  // --- 焦点 / 控件识别 ---------------------------------------------------------
  {
    id: "focus.outline",
    kind: "graphic",
    selector: CSS("#addImportButton, #pricingSearch"),
    selectorsByState: {
      "keyboard-focus": "#addImportButton",
      "input-focus": "#pricingSearch",
    },
    states: ["keyboard-focus", "input-focus"],
    foreground: v("--blue"),
    background: BG_GROUP_CERAMIC,
    threshold: 3,
    required: true,
    applicability:
      "两个控件的自然 Tab 焦点轮廓，实际采样以 computed outline 与原地背景像素为准；近期菜单 .recent-range-menu button:focus-visible outline:0 的例外仍待核验，不由两个目标代替",
    sourceRefs: [
      REF("public/styles.css", "button/input/select:focus-visible 全局 2px 实线与 offset3", 2999),
      REF("public/index.html", "#addImportButton", 291),
      REF("public/index.html", "#pricingSearch", 349),
      REF("public/styles.css", "menu outline:0 例外", 884),
    ],
  },

  // --- 装饰与品牌字标（单独视觉记录，不入正文 PASS 数） -------------------------
  {
    id: "logotype.agent-usage",
    kind: "logotype",
    selector: CSS(".topbar > h1"),
    states: ["dashboard-default"],
    foreground: v("--ink"),
    background: BG_PANEL_CERAMIC,
    threshold: null,
    required: false,
    applicability:
      "压印品牌字标（rim/shade 双向 text-shadow，styles.css 631-642）；按总计划 §5.7 不套正文比值，但必须在视觉评审中检查肉眼辨认、浅深与聚光干扰；例外不扩展到任何其他文字",
    sourceRefs: [REF("public/index.html", "h1 Agent Usage", 39), REF("public/styles.css", ".topbar > h1", 631)],
  },
  {
    id: "deco.character-art",
    kind: "decorative",
    selector: CSS("#skinCharacters .skin-character img"),
    states: ["characters-off", "characters-50", "characters-100"],
    foreground: null,
    background: null,
    threshold: null,
    required: false,
    applicability: "角色立绘为装饰；透明度由偏好控制（0/50%/100%），不参与正文 PASS 数",
    sourceRefs: [REF("public/skin-ui.js", "apply() 宿主 opacity", 271)],
  },
  {
    id: "deco.skin-preview-samples",
    kind: "decorative",
    selector: CSS(".skin-preview-bar / .skin-preview-line（选择器弹窗迷你预览）"),
    states: ["skin-previews-visual"],
    foreground: v("--skin-preview-series-1"),
    background: solid(v("--skin-preview-page")),
    threshold: null,
    required: false,
    applicability:
      "例外：选择器内对比样本。注意 M0.1 发现的缺陷——COLOUR_TOKENS 旧字段名导致预览只接 5 个同名键，series/文字/描边走 CSS 默认；M1 接线修正后此处仅为参考样本，不代表产品阅读",
    sourceRefs: [
      REF("public/skin-picker.js", "COLOUR_TOKENS/TOKEN_TO_CSS", 40),
      REF("public/skins.css", ".skin-preview 样式", 174),
    ],
  },
  {
    id: "deco.bar-fill-fallback",
    kind: "decorative",
    selector: CSS(".bar-fill（未指定分类色时的默认渐变）"),
    states: ["bar-fill-visual"],
    foreground: null,
    background: grad(90, [stop(0, v("--green")), stop(1, v("--blue"))]),
    threshold: null,
    required: false,
    applicability:
      "例外：JS 指定分类色时被内联背景覆盖（app.js 1471），渐变仅为无色回退；由 bar-fill-visual 状态覆盖（选『全部』预设后的回退形态）",
    sourceRefs: [REF("public/styles.css", ".bar-fill", 1474)],
  },

  // --- 聚光影响区 --------------------------------------------------------------
  {
    id: "spotlight.tinted-surface",
    kind: "decorative",
    selector: CSS(".shell [data-spotlight-active]::after 的径向叠加范围"),
    states: ["spotlight-on"],
    foreground: null,
    background: layered(
      "在既有表面上叠加 radial color-mix(in srgb, var(--skin-active-accent, var(--blue)) var(--spotlight-strength), transparent)（--spotlight-strength: 22%，styles.css 2406/3253-3257；radius 80-320px 由 app.js 4366-4370 注入）",
    ),
    threshold: null,
    required: false,
    applicability:
      "装饰：聚光叠加没有独立信息、前景或稳定边界，仍保留状态截图供视觉检查干扰；其覆盖范围内的必要文字角色（metric-value/metric-label/section-title 等）没有获得豁免，必须继续按叠加后的实际背景复核。",
    sourceRefs: [REF("public/styles.css", "spotlight ::after", 3245)],
  },
  {
    id: "spotlight.language-selected",
    kind: "text",
    selector: CSS(
      ".shell #languageToggle[data-spotlight-active][aria-pressed='false'] > [data-language='zh-CN'].is-selected:not(:empty)",
    ),
    states: ["spotlight-language-selected"],
    foreground: v("--toggle-selected"),
    background: layered(
      "145 度两段陶瓷凸起按钮上叠加 radial color-mix(in srgb, var(--skin-active-accent, var(--blue)) var(--spotlight-strength), transparent)（--spotlight-strength: 22%；styles.css 2908-2943、3666-3689）",
    ),
    threshold: 4.5,
    required: true,
    applicability:
      "必要视觉文字是当前选中语言的 glyph；当前 fixture 固定为「文」，切到 en-US 后「A」承担同一必要作用。aria-label 不替代视觉语言指示。仅测唯一 active #languageToggle 下选中的 zh-CN 叶，实际背景为凸起面与径向聚光的浏览器复合。",
    sourceRefs: [
      REF("public/index.html", "#languageToggle 选中语言叶", 56),
      REF("public/styles.css", ".theme-toggle 145 度迷你凸起面", 2908),
      REF("public/styles.css", "spotlight ::after", 3666),
    ],
  },
  {
    id: "cost.note-text",
    kind: "text",
    selector: "#costEstimateNote > p, #costEstimateNote li",
    states: ["dashboard-default"],
    foreground: v("--muted"),
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability:
      "估价已生成时，限定为 #costEstimateNote 的直接子 p 与 li 自身文字范围（包括首段前缀与分隔符）；链接文字由 cost.note-link 独立登记。M3 只能使用 B18 已接受的精确 own-text range；空范围或不支持的范围不得记为 PASS。估价不可用分支把说明写入容器 div 的直接文本，该形态未被本角色覆盖，不可声称完整覆盖所有说明形态。",
    sourceRefs: [
      REF("public/app.js", "renderCostMetrics", 1353),
      REF("public/app.js", "renderPricingSourceLinksHtml", 1435),
      REF("public/styles.css", ".cost-estimate-note color", 952),
      REF("public/styles.css", ".cost-estimate-note well", 3105),
    ],
  },
  {
    id: "cost.note-link",
    kind: "text",
    selector: "#costEstimateNote a",
    states: ["dashboard-default"],
    foreground: { kind: "computed", property: "color" },
    background: solid(v("--ceramic-well")),
    threshold: 4.5,
    required: true,
    applicability:
      "仅覆盖 #costEstimateNote 中独立来源锚点的文字，按浏览器实际文字前景检查并遵循 M3 的 text-fill 优先级；fast 结果必须为 browser-required、ratio=null，不能当作 PASS。不得用父级 --muted 替代或改动产品 CSS/DOM。链接下划线与 :visited 后的实际绘色尚未验收。",
    sourceRefs: [
      REF("public/app.js", "renderCostMetrics", 1353),
      REF("public/app.js", "renderPricingSourceLinksHtml", 1435),
      REF("public/styles.css", ".cost-estimate-note color", 952),
      REF("public/styles.css", ".cost-estimate-note well", 3105),
    ],
  },
]);

export const STATE_CATALOG = Object.freeze([
  {
    id: "dashboard-default",
    label: "看板基线（进入后选『全部』；fixture 固定日期保证非零，不依赖今天有数据）",
    steps: [{ action: "click", selector: '#presetButtons button[data-preset="all"]' }],
    ready: {
      kind: "nonZeroText",
      selector: ".metric strong",
      description: "至少一个指标值文本非零（M4 解析文本数值；仅数元素不能证明非零）",
    },
    restore: [{ action: "click", selector: '#presetButtons button[data-preset="today"]' }],
    expectedRoleIds: [
      "page.body-text",
      "page.body-muted",
      "panel.metric-value",
      "panel.metric-label",
      "panel.heading-label",
      "panel.section-title",
      "table.comparison-header",
      "table.comparison-cell",
      "table.comparison-total",
      "select.zone-label",
      "toggle.language-selected",
      "logotype.agent-usage",
      "chart.axis-text",
      "chart.axis-line",
      "button.secondary",
      "input.placeholder",
      "panel.detail-bar-name",
      "panel.detail-bar-value",
      "chart.detail-fill",
      "toolbar.autorefresh-text",
      "toolbar.autorefresh-muted",
      "toolbar.range-label",
      "chart.legend-label",
      "cost.note-text",
      "cost.note-link",
    ],
  },
  {
    id: "autorefresh-on",
    label: "自动刷新开启态（先选『全部』，再确保自动刷新开启）",
    steps: [
      { action: "click", selector: '#presetButtons button[data-preset="all"]' },
      { action: "ensureClick", selector: "#autoRefreshToggle", until: '#autoRefreshToggle[aria-pressed="true"]' },
    ],
    ready: {
      kind: "matches",
      selector: '#autoRefreshToggle[aria-pressed="true"]',
      description: "自动刷新开关 aria-pressed=true",
    },
    restore: [],
    expectedRoleIds: ["toggle.autorefresh-on"],
  },
  {
    id: "timeline-range-warning",
    label: "超长时间线范围告警（独立 fixture）",
    steps: [{ action: "click", selector: '#presetButtons button[data-preset="all"]' }],
    ready: {
      kind: "matches",
      selector: "#timelineRangeWarning:not([hidden])",
      description: "超过 2000 个时间线槽位的提示可见；数据未被截断",
    },
    restore: [{ action: "click", selector: '#presetButtons button[data-preset="today"]' }],
    expectedRoleIds: ["warning.timeline-range"],
  },
  {
    id: "comparison-sort-active",
    label: "全部范围的模型今日列排序指示",
    steps: [
      { action: "click", selector: '#presetButtons button[data-preset="all"]' },
      { action: "click", selector: '#modelComparisonTable [data-comparison-sort][data-period="today"]' },
    ],
    ready: {
      kind: "matches",
      selector: "#modelComparisonTable .comparison-sort-indicator:not([hidden])",
      description: "模型表格今日列排序箭头可见",
    },
    restore: [
      { action: "click", selector: '#modelComparisonTable [data-comparison-sort][data-period="today"]' },
      { action: "click", selector: '#modelComparisonTable [data-comparison-sort][data-period="today"]' },
    ],
    expectedRoleIds: ["indicator.sort"],
  },
  {
    id: "dense-data",
    label: "稠密数据（全部范围，多模型/渠道与长名称）",
    steps: [{ action: "click", selector: '#presetButtons button[data-preset="all"]' }],
    ready: {
      kind: "dataCount",
      selector: ".comparison-table tbody tr",
      min: 8,
      description: "对比表 ≥8 行且存在长名称（fixture 保证 8 条可显示长名称）",
    },
    restore: [{ action: "click", selector: '#presetButtons button[data-preset="today"]' }],
    expectedRoleIds: [
      "table.comparison-header",
      "table.comparison-cell",
      "chart.timeline-segment",
      "chart.legend-swatch",
      "chart.model-bar",
      "chart.axis-text",
      "chart.axis-line",
      "graphic.repo-icon",
      "panel.detail-bar-name",
      "panel.detail-bar-value",
      "chart.legend-label",
    ],
  },
  {
    id: "preset-selected",
    label: "范围预设切换（选中态）",
    steps: [{ action: "click", selector: '#presetButtons button[data-preset="month"]' }],
    ready: {
      kind: "matches",
      selector: '#presetButtons button[data-preset="month"].active',
      description: "目标预设获得 .active",
    },
    restore: [{ action: "click", selector: '#presetButtons button[data-preset="today"]' }],
    expectedRoleIds: ["preset.selected-label"],
  },
  {
    id: "quota-toast",
    label: "额度窗口切换（5h/周）与角标 toast",
    steps: [{ action: "click", selector: "#presetButtons .quota-preset-toggle" }],
    ready: { kind: "visible", selector: ".quota-preset-status", description: "额度状态 toast 可见" },
    restore: [{ action: "click", selector: '#presetButtons button[data-preset="today"]' }],
    expectedRoleIds: ["preset.quota-mode-selected", "preset.quota-mode-idle", "toast.quota-status"],
  },
  {
    id: "autorefresh-off",
    label: "自动刷新关闭态",
    steps: [{ action: "click", selector: "#autoRefreshToggle" }],
    ready: { kind: "matches", selector: '#autoRefreshToggle[aria-pressed="false"]', description: "开关翻到关" },
    restore: [{ action: "click", selector: "#autoRefreshToggle" }],
    expectedRoleIds: ["toggle.autorefresh-off"],
  },
  {
    id: "button-hover",
    label: "次要按钮悬停（仅测真实悬停的目录按钮，并保持触发视口）",
    steps: [{ action: "hover", selector: "#addImportButton" }],
    ready: { kind: "matches", selector: "#addImportButton:hover", description: "悬停生效" },
    restore: [{ action: "hover", selector: "body" }],
    expectedRoleIds: ["button.secondary", "button.hover-border"],
  },
  {
    id: "keyboard-focus",
    label: "目录按钮自然 Tab 焦点",
    steps: [
      {
        action: "focus",
        selector: "#addImportButton",
        note: "必须以自然 Tab 循环命中并取得 :focus-visible 证据；初始已聚焦或脚本 focus() 不等于键盘可达，capture 严格 Tab 实现待后续卡对齐",
      },
    ],
    ready: {
      kind: "matches",
      selector: "#addImportButton:focus-visible",
      description: "自然 Tab 命中目录按钮，焦点环可见",
    },
    restore: [{ action: "focus", selector: "body" }],
    expectedRoleIds: ["focus.outline"],
  },
  {
    id: "input-focus",
    label: "输入框自然 Tab 焦点（计价搜索框，空输入占位）",
    steps: [
      { action: "click", selector: "#updatePricingButton" },
      {
        action: "focus",
        selector: "#pricingSearch",
        note: "计价搜索框初始已脚本 focus 时仍须自然 Tab 循环命中并取得 :focus-visible 证据；已聚焦不等于键盘可达，capture 严格 Tab 实现待后续卡对齐",
      },
    ],
    ready: {
      kind: "matches",
      selector: "#pricingSearch:focus-visible",
      description: "自然 Tab 命中计价搜索框，焦点环可见",
    },
    restore: [{ action: "click", selector: "#cancelPricingButton" }],
    expectedRoleIds: ["input.placeholder", "focus.outline"],
  },
  {
    id: "menu-recent-open",
    label: "近期范围菜单展开",
    steps: [{ action: "click", selector: "#presetButtons .recent-segment" }],
    ready: { kind: "visible", selector: "#recentRangeMenu:not([hidden])", description: "菜单展开" },
    restore: [{ action: "click", selector: "#presetButtons .recent-segment" }],
    expectedRoleIds: ["menu.item-selected", "button.secondary"],
  },
  {
    id: "calendar-open",
    label: "日历弹层展开（单月）",
    steps: [{ action: "click", selector: "#dateRangeButton" }],
    ready: { kind: "visible", selector: "#dateRangePicker:not([hidden])", description: "日历弹层展开" },
    restore: [{ action: "click", selector: "#dateRangeButton" }],
    expectedRoleIds: ["calendar.day", "calendar.weekday", "calendar.day-outside", "hint.calendar-hint"],
  },
  {
    id: "calendar-range",
    label: "自定义起止范围选中（固定 2026-09-26 → 2026-09-28，fixture 月内有数据）",
    steps: [
      { action: "click", selector: "#dateRangeButton" },
      { action: "click", selector: "[data-date-picker-clear]" },
      {
        action: "click",
        selector: '.date-picker-day[data-date="2026-09-26"]',
        note: "若当前不在 2026-09，先用 [data-date-picker-action=prev] 导航（M4 按当前月份计算次数）",
      },
      { action: "click", selector: '.date-picker-day[data-date="2026-09-28"]' },
    ],
    ready: {
      kind: "matches",
      selector: 'body:has(.date-picker-day[data-date="2026-09-28"].range-end)',
      description: "日历重开后确认 2026-09-28 是所选终点",
    },
    restore: [
      { action: "click", selector: "[data-date-picker-clear]" },
      { action: "click", selector: "#dateRangeButton" },
    ],
    expectedRoleIds: [
      "calendar.day-in-range",
      "calendar.day-selected",
      "calendar.day-range-start",
      "calendar.day-range-end",
      "preset.date-range-start",
      "preset.date-range-end",
      "hint.calendar-hint",
      "button.calendar-clear",
    ],
  },
  {
    id: "metric-record-visible",
    label: "记录徽标可见（固定 custom 2026-09-28 → 2026-10-04）",
    steps: [
      { action: "click", selector: "#dateRangeButton" },
      { action: "click", selector: "[data-date-picker-clear]" },
      {
        action: "click",
        selector: '.date-picker-day[data-date="2026-09-28"]',
        note: "若当前不在 2026-09，M4 按当前月份自动翻月",
      },
      {
        action: "click",
        selector: '.date-picker-day[data-date="2026-10-04"]',
        note: "若当前不在 2026-10，M4 按当前月份自动翻月；选中终点后弹层关闭",
      },
    ],
    ready: {
      kind: "matches",
      selector: 'body:has(#dateRangeButton[aria-expanded="false"]) .metric:has(#totalTokens) .metric-new:not([hidden])',
      description: "日期弹层已关闭，totalTokens 指标卡记录徽标已显示",
    },
    restore: [
      { action: "click", selector: "[data-date-picker-clear]" },
      { action: "click", selector: "#dateRangeButton" },
      { action: "click", selector: '#presetButtons button[data-preset="all"]' },
    ],
    expectedRoleIds: ["badge.record"],
  },
  {
    id: "comparison-trend-up",
    label: "固定上行比较（2026-09-26 → 2026-09-28）",
    steps: [
      { action: "click", selector: "#dateRangeButton" },
      { action: "click", selector: "[data-date-picker-clear]" },
      {
        action: "click",
        selector: '.date-picker-day[data-date="2026-09-26"]',
        note: "fixture 固定日期；M4 按当前月份计算导航次数",
      },
      { action: "click", selector: '.date-picker-day[data-date="2026-09-28"]' },
    ],
    ready: {
      kind: "matches",
      selector: 'body:has(#dateRangeButton[aria-expanded="false"]):has(#comparisonSummary .comparison-item.up strong)',
      description: "日期选择完成、日历已关闭且上行比较值已渲染",
    },
    restore: [
      { action: "click", selector: "[data-date-picker-clear]" },
      { action: "click", selector: "#dateRangeButton" },
    ],
    expectedRoleIds: ["summary.trend-up"],
  },
  {
    id: "comparison-trend-down",
    label: "固定下行比较（2026-09-29 → 2026-09-30）",
    steps: [
      { action: "click", selector: "#dateRangeButton" },
      { action: "click", selector: "[data-date-picker-clear]" },
      {
        action: "click",
        selector: '.date-picker-day[data-date="2026-09-29"]',
        note: "fixture 固定日期；M4 按当前月份计算导航次数",
      },
      { action: "click", selector: '.date-picker-day[data-date="2026-09-30"]' },
    ],
    ready: {
      kind: "matches",
      selector: "#comparisonSummary .comparison-item.down strong",
      description: "日期选择完成并关闭弹层后，下行比较值已渲染",
    },
    restore: [
      { action: "click", selector: "[data-date-picker-clear]" },
      { action: "click", selector: "#dateRangeButton" },
    ],
    expectedRoleIds: ["summary.trend-down"],
  },
  {
    id: "calendar-same-day",
    label: "同日范围起止（2026-09-28 连选两次）",
    steps: [
      { action: "click", selector: "#dateRangeButton" },
      { action: "click", selector: "[data-date-picker-clear]" },
      { action: "click", selector: '.date-picker-day[data-date="2026-09-28"]' },
      { action: "click", selector: '.date-picker-day[data-date="2026-09-28"]' },
    ],
    ready: {
      kind: "matches",
      selector: '.date-picker-day[data-date="2026-09-28"].range-start.range-end',
      description: "同一日期格同时带 range-start 和 range-end 才算就绪",
    },
    restore: [
      { action: "click", selector: "[data-date-picker-clear]" },
      { action: "click", selector: "#dateRangeButton" },
    ],
    expectedRoleIds: ["calendar.day-range-both"],
  },

  // --- 复核更正批次新增状态（v2）：空态/错误态/装饰态的确定性触发 ---------------
  {
    id: "empty-range",
    label: "空态（所选范围无数据）",
    steps: [
      { action: "click", selector: "#dateRangeButton" },
      { action: "click", selector: "[data-date-picker-clear]" },
      {
        action: "click",
        selector: '[data-date-picker-action="prev"]',
        note: "2026-01 无数据；M4 按当前月份与 2026-01 的差计算逐月后退次数",
      },
      { action: "click", selector: '.date-picker-day[data-date="2026-01-15"]' },
      { action: "click", selector: '.date-picker-day[data-date="2026-01-16"]' },
    ],
    ready: {
      kind: "visible",
      selector: ".empty",
      description: "空态卡片可见才就绪",
    },
    restore: [
      { action: "click", selector: "[data-date-picker-clear]" },
      { action: "click", selector: "#dateRangeButton" },
    ],
    expectedRoleIds: ["empty.state-text"],
    note: "恢复后若日历仍停在 2026-01，M4 用 data-date-picker-action=next 导航回当前月",
  },
  {
    id: "autorefresh-error",
    label: "自动刷新失败提示",
    steps: [],
    ready: {
      kind: "visible",
      selector: ".auto-refresh-error.is-error",
      description: "错误提示可见才就绪",
    },
    restore: [],
    expectedRoleIds: ["status.autorefresh-error"],
    note: "触发：#autoRefreshToggle 默认开启（aria-pressed=true），M4 令开启态下的 /api/usage 轮询请求失败（路由中止）；恢复：还原路由后下一次成功轮询自动清除错误，M4 不得把开关留在关闭态",
  },
  {
    id: "skin-previews-visual",
    label: "皮肤选择器预览样本可见",
    steps: [{ action: "click", selector: 'button[aria-controls="skinDialog"]' }],
    ready: {
      kind: "visible",
      selector: "#skinDialog:not([hidden])",
      description: "皮肤对话框展开后才测量预览样本",
    },
    restore: [{ action: "click", selector: "#closeSkinDialogButton" }],
    expectedRoleIds: ["deco.skin-preview-samples"],
    note: "装饰态，不计入正文 PASS 数；样本仅作参考（见角色 applicability 的 M0.1 缺陷说明）",
  },
  {
    id: "bar-fill-visual",
    label: "时间线条目默认渐变可见",
    steps: [{ action: "click", selector: '#presetButtons button[data-preset="all"]' }],
    ready: {
      kind: "exists",
      selector: ".bar-fill",
      description: "时间线条目渲染后存在；无内联分类色时呈默认渐变",
    },
    restore: [{ action: "click", selector: '#presetButtons button[data-preset="today"]' }],
    expectedRoleIds: ["deco.bar-fill-fallback"],
    note: "装饰态，不计入正文 PASS 数",
  },
  {
    id: "dialog-import-open",
    label: "导入/来源弹窗打开",
    steps: [{ action: "click", selector: "#addImportButton" }],
    ready: { kind: "visible", selector: "#importDialog:not([hidden])", description: "弹窗打开" },
    restore: [{ action: "click", selector: "#cancelImportButton" }],
    expectedRoleIds: [
      "dialog.copy",
      "input.value",
      "button.primary",
      "button.secondary",
      "dialog.source-option-text",
      "dialog.source-option-muted",
    ],
  },
  {
    id: "dialog-import-source-excluded",
    label: "导入弹窗来源排除标记",
    steps: [{ action: "click", selector: "#addImportButton" }],
    ready: {
      kind: "visible",
      selector: "#sourcePicker .home-excluded",
      description: "来源筛选排除标记可见",
    },
    restore: [{ action: "click", selector: "#cancelImportButton" }],
    expectedRoleIds: ["status.home-excluded", "dialog.source-excluded-name", "dialog.source-excluded-path"],
    note: "S3 专用生命周期在来源排除期间取证和测量，再恢复来源及关闭弹窗；本卡仅离线验证时序，实际捕获与测量仍待后续验收。",
  },
  {
    id: "dialog-import-error",
    label: "导入弹窗错误提示",
    steps: [
      { action: "click", selector: "#addImportButton" },
      { action: "click", selector: "#submitImportButton" },
    ],
    ready: { kind: "exists", selector: "#importForm .dialog-message:not(:empty)", description: "出现错误/提示文案" },
    restore: [{ action: "click", selector: "#cancelImportButton" }],
    expectedRoleIds: ["dialog.error-message"],
  },
  {
    id: "home-list-reason",
    label: "主页面已保存不可用来源原因",
    steps: [{ action: "click", selector: '#presetButtons button[data-preset="all"]' }],
    ready: {
      kind: "visible",
      selector: "body:not(:has(#importDialog:not([hidden]))) #homeList .home-reason",
      description: "主页面来源原因可见且导入弹窗关闭",
    },
    restore: [{ action: "click", selector: '#presetButtons button[data-preset="all"]' }],
    expectedRoleIds: ["status.home-reason", "home.remove"],
    note: "fixture v3 预置的已保存空目录由真实分类器产生原因；在主页面取证，保持导入弹窗关闭，不打开弹窗或注入 reason",
  },
  {
    id: "home-source-excluded",
    label: "主页面来源排除态名称与路径",
    steps: [{ action: "click", selector: "#addImportButton" }],
    ready: {
      kind: "visible",
      selector: "body:has(#importDialog[hidden]) #homeList .home-row.excluded",
      description: "导入弹窗已关闭且主页来源排除行可见",
    },
    restore: [{ action: "click", selector: "#cancelImportButton" }],
    expectedRoleIds: ["home.excluded-name", "home.excluded-path"],
    note: "由专用 S3 handler 按运行时 sourceId 与唯一完整路径绑定同一来源；主页测量时弹窗关闭，restore 仅在来源恢复时弹窗已重开后执行",
  },
  {
    id: "dialog-pricing-open",
    label: "计价标准弹窗打开（空输入）",
    steps: [{ action: "click", selector: "#updatePricingButton" }],
    ready: { kind: "visible", selector: "#pricingDialog:not([hidden])", description: "弹窗打开且搜索框为空" },
    restore: [{ action: "click", selector: "#cancelPricingButton" }],
    expectedRoleIds: [
      "input.placeholder",
      "pricing.badge-default",
      "pricing.badge-missing",
      "dialog.copy",
      "button.primary",
      "button.secondary",
    ],
  },
  {
    id: "pricing-input-filled",
    label: "计价弹窗输入填值",
    steps: [
      { action: "click", selector: "#updatePricingButton" },
      { action: "fill", selector: "#pricingSearch", value: "gpt" },
    ],
    ready: { kind: "matches", selector: "#pricingSearch:not(:placeholder-shown)", description: "输入框已有值" },
    restore: [{ action: "click", selector: "#cancelPricingButton" }],
    expectedRoleIds: ["input.value"],
  },
  {
    id: "theme-dark",
    label: "切换到深色主题",
    steps: [{ action: "setTheme", value: "dark" }],
    ready: { kind: "matches", selector: 'html[data-theme="dark"]', description: "根主题标记切换" },
    restore: [{ action: "setTheme", value: "light" }],
    expectedRoleIds: [],
    note: "模式修饰状态：M4 以状态组合把其他状态置于深色下测量，本身不单独测量角色（expectedRoleIds 故意为空）",
  },
  {
    id: "spotlight-on",
    label: "聚光开启",
    steps: [{ action: "setSpotlight", value: "on" }],
    ready: { kind: "exists", selector: ".shell [data-spotlight-active]", description: "聚光层激活" },
    restore: [{ action: "setSpotlight", value: "off" }],
    expectedRoleIds: ["spotlight.tinted-surface"],
  },
  {
    id: "spotlight-language-selected",
    label: "语言按钮选中项聚光态（zh-CN）",
    steps: [
      { action: "hover", selector: "#languageToggle[aria-pressed='false'] > [data-language='zh-CN'].is-selected" },
    ],
    ready: {
      kind: "spotlightHost",
      selector:
        ".shell #languageToggle[data-spotlight-active][aria-pressed='false']:has(> [data-language='zh-CN'].is-selected:not(:empty)):has(> [data-language='en-US']:not(.is-selected):not(:empty))",
      description: "唯一 languageToggle 凸起宿主激活，zh-CN 选中叶与非选中 en-US 叶身份同时成立",
    },
    restore: [{ action: "setSpotlight", value: "off" }],
    expectedRoleIds: ["spotlight.language-selected"],
    note: "只 hover 严格选中的 zh-CN 叶；不点击按钮，不切换 locale",
  },
  {
    id: "spotlight-metric-label",
    label: "总 tokens 卡同宿主普通标签与数值聚光态",
    steps: [{ action: "hover", selector: ".metric:has(> #totalTokens) > span:not(.metric-new):not([hidden])" }],
    ready: {
      kind: "spotlightHost",
      selector:
        ".shell .metric[data-spotlight-active]:has(> #totalTokens):has(> span:not(.metric-new):not([hidden]):not(:empty))",
      description: "总 tokens 卡普通标签成为唯一聚光宿主且聚光层就绪",
    },
    restore: [{ action: "setSpotlight", value: "off" }],
    expectedRoleIds: ["panel.metric-label", "panel.metric-value"],
  },
  {
    id: "spotlight-timeline-heading",
    label: "时间分布卡标题与范围说明聚光态",
    steps: [{ action: "hover", selector: "#timelinePanelTitle" }],
    ready: {
      kind: "spotlightHost",
      selector:
        ".shell .chart-panel[data-spotlight-active]:has(> .timeline-heading > .timeline-title > #timelinePanelTitle:not(:empty)):has(> .timeline-heading > .timeline-title > #rangeLabel:not(:empty))",
      description: "唯一图表面板活动且两叶非空",
    },
    restore: [{ action: "setSpotlight", value: "off" }],
    expectedRoleIds: ["panel.section-title", "panel.heading-label"],
    note: "标题与范围说明共用图表面板宿主；实际叠加底色须 M3 验证，详情宿主不在本状态",
  },
  {
    id: "spotlight-detail-bars",
    label: "详情面板名称与数值聚光态（全部范围、按渠道）",
    steps: [{ action: "hover", selector: "#detailList > .bar-row:first-child > .bar-label > .bar-name" }],
    ready: {
      kind: "spotlightHost",
      selector:
        ".shell #detailPanel[data-spotlight-active]:has(> .panel-heading > #detailPanelTitle:not(:empty)):has(> .panel-heading > #detailModeLabel:not(:empty)):has(> #detailList:not([hidden]) > .bar-row > .bar-label > .bar-name:not(:empty) + .bar-value:not(:empty))",
      description:
        "捕获前置固定全部范围与按渠道；详情面板为唯一活动宿主，标题、模式及同一 bar-label 的相邻名称和值非空",
    },
    restore: [{ action: "setSpotlight", value: "off" }],
    expectedRoleIds: ["panel.section-title", "panel.heading-label", "panel.detail-bar-name", "panel.detail-bar-value"],
  },
  {
    id: "spotlight-detail-fill",
    label: "详情面板条形填充聚光态（无 tooltip）",
    steps: [{ action: "hover", selector: "#detailPanel > .panel-heading" }],
    ready: {
      kind: "spotlightHost",
      selector:
        "body:has(#usageTooltip[hidden]) .shell #detailPanel[data-spotlight-active]:has(> .panel-heading > #detailPanelTitle:not(:empty)):has(> .panel-heading > #detailModeLabel:not(:empty)):has(> #detailList:not([hidden]) > .bar-row:nth-child(1) > .bar-track > .bar-fill):has(> #detailList:not([hidden]) > .bar-row:nth-child(2) > .bar-track > .bar-fill)",
      description: "自然悬停详情标题；tooltip 关闭、唯一 detailPanel 活动、标题和模式非空，并存在两行条形填充",
    },
    restore: [{ action: "setSpotlight", value: "off" }],
    expectedRoleIds: ["chart.detail-fill"],
  },
  {
    id: "characters-off",
    label: "角色关闭",
    steps: [{ action: "setCharacters", value: "off" }],
    ready: { kind: "matches", selector: 'html[data-skin-characters="off"]', description: "角色层隐藏" },
    restore: [{ action: "setCharacters", value: "on" }],
    expectedRoleIds: ["deco.character-art"],
  },
  {
    id: "characters-50",
    label: "角色 50% 透明（默认）",
    steps: [
      { action: "setCharacters", value: "on" },
      { action: "setOpacity", value: "0.5" },
    ],
    ready: { kind: "matches", selector: 'html[data-skin-opacity="0.5"]', description: "透明度 50%" },
    restore: [{ action: "setOpacity", value: "0.5" }],
    expectedRoleIds: ["deco.character-art"],
  },
  {
    id: "characters-100",
    label: "角色 100% 不透明",
    steps: [{ action: "setOpacity", value: "1" }],
    ready: { kind: "matches", selector: 'html[data-skin-opacity="1"]', description: "透明度 100%" },
    restore: [{ action: "setOpacity", value: "0.5" }],
    expectedRoleIds: ["deco.character-art"],
  },
  {
    id: "skin-character-selected",
    label: "选中一款角色皮肤",
    steps: [{ action: "selectSkin", value: "chatgpt" }],
    ready: {
      kind: "matches",
      selector: 'html[data-skin="chatgpt"]',
      description: "皮肤偏好切换（M4 须记录进入前偏好并在 restore 还原到该偏好，而非硬编码 classic）",
    },
    restore: [{ action: "selectSkin", value: "classic" }],
    expectedRoleIds: [],
  },
]);

/**
 * 不由 20 项声明控制、且被必要角色引用的固定颜色（CSS 变量名 → 实际值）。
 * 全部取自 styles.css :root / [data-theme="dark"]，无一处凭空填色。
 * M0 时 character 与 classic 的状态色相同；M1.4 可只更新 character.light。
 * v2 更正：`--gold` 与 `--toggle-muted` 零角色引用；`--toggle-selected` 被样式表后半段
 * 覆盖为 var(--blue)（styles.css），随强调色联动、不再是固定色——三者按卡片"只登记
 * 被必要角色引用的固定色"从本表移除。--gold 属表数据与注释不符的复核发现。
 */
export const BASE_COLORS = Object.freeze({
  character: Object.freeze({
    light: Object.freeze({
      // M1.4：与 styles.css 限定覆盖块（:root[data-skin]:not(classic):not(dark)）同步；
      // classic.light 与两个 dark 分支保留原值，M3 不得把新值用于 classic 或 dark。
      "--green": "#1A5233",
      "--red": "#74270D",
    }),
    dark: Object.freeze({
      "--green": "#34d399",
      "--red": "#fb923c",
    }),
  }),
  classic: Object.freeze({
    light: Object.freeze({
      "--green": "#2f855a",
      "--red": "#c05621",
    }),
    dark: Object.freeze({
      "--green": "#34d399",
      "--red": "#fb923c",
    }),
  }),
});
