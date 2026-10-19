# 移动端分享图定稿计划（Consolidated Plan）

> **历史归档 · 2026-10-03**。本稿被后续交付或融合计划替代；旧状态、待办与离线要求仅供追溯。现行规则与遗留事项见[文档入口](../../../00-index.md)和[任务清单](../../../02-tasks.md)，归档原因见[本批索引](../00-index.md)。

日期：2026-10-03。状态：**已拍板，未实施**。本文件是分享图规划的收敛定稿；
实施以本文件为准，前置文档与本文件冲突时以本文件为准。

## 0. 文档关系

- 产品设计简报：[2026-10-03-share-experience-design-brief.md](2026-10-03-share-experience-design-brief.md)
- 技术实施方案：[2026-10-03-mobile-share-card-plan.md](2026-10-03-mobile-share-card-plan.md)
- 执行清单：[2026-10-03-mobile-share-card-todos.md](2026-10-03-mobile-share-card-todos.md)

定稿前已将三份文档的代码级假设逐条核实：弹窗约定（`.dialog-backdrop`/`.dialog`
+ `trapDialogFocus`）、皮肤变量（`PALETTE_CSS_VAR_NAMES` 20 个根变量）、
打包器（`src/static-export.js` 显式白名单，未注册 import 会硬失败）、
i18n 测试（`test/i18n.test.js` 确实扫描 index.html 中文字面量）、
测试形态（`node --test`、无 jsdom、约 355 例）均成立。

**开工前置（M0 协调）**：2026-10-03 12:36–12:41 曾有并行会话在本工作区写出
235 行 `public/share-card.js` 初稿（现已删除）并留下上述三份文档。
实施开始前必须重新 `git status` 核查：若 `share-card.js` 或他人未提交改动重现，
先确认归属再动；不触碰并行会话的任何文件。

## 1. 已拍板决策

> 三个主观项（主视觉/主指标/入口）未获逐项拍板，按前置文档推荐默认执行；
> 均为低成本可逆项，实施后随时可改。

| 决策项 | 定稿 |
| --- | --- |
| 主视觉 | 带角色的主题小报：角色融入 hero 区（底部出血、横向渐显水印），数值宽度 >62% 面板时自动跳过水印；默认跟随皮肤"显示角色"状态，弹窗内可临时关闭；classic 皮肤自动无角色构图。透明度/构图比例在 M5 视觉轮定稿 |
| 主指标 | 总用量 Tokens 为大数字；费用以「≈ $xx · API 等价费用估算」次行呈现，免责文案与看板一致 |
| 入口 | 顶栏动作组最左（皮肤/语言/主题之前），图标带强调色 |
| 默认格式 | 4:5 紧凑版（1080×1350）；9:16 完整版（1080×1920）同步实现 |
| 配色 | 跟随当前主题与皮肤；不做"深色看板 + 浅色卡片"式跨模式覆盖 |
| 明确不做 | 1:1 方图、二维码、GIF/长图、上传链接；分享设置不持久化 |

## 2. 架构设计

- **`public/share-card.js` 新增纯模块**：无 import、无 DOM（与
  `timeline-utils.js` 同风格）。导出 `SHARE_CARD_FORMATS` / `shareCardFormat` /
  `shareTokenParts` / `shareTokenMillions` / `shareCardFileName` /
  `buildShareCardModel` / `shareCardLayout` /
  `drawShareCard(ctx, model, {tokens, image, text})`。
  内部原语统一 `share*` 前缀，防止静态快照内联后作用域重名。
- **布局引擎（纯函数）**：块序列（页头 / hero / 2×2 指标块 / 时间分布 /
  TOP 模型 / 页脚）+ 固定高，hero = clamp(剩余空间, 300, 460)；空间不足时
  依次摘掉 models 块 → 时间分布换成 spark 迷你条。
  出厂构图 story hero=410、card hero=454。
- **材质映射**：`--neo-raised`/`--neo-inset` 是 box-shadow 值，Canvas 不可用，
  按色源重拼（`--neo-surface` 填充 + `--neo-edge` 描边 + `--ceramic-shade`
  投影 + `--ceramic-light` 高光）。`color-mix()` 类值用离屏探针元素赋
  `style.color` 再读回解析后的 `rgb()`——不复制色板，换皮肤自动跟随。
  tokens 由 app.js 解析后注入，share-card.js 不碰 DOM。
- **角色图**：app.js 用 Image 加载当前皮肤角色素材（在线用 WebP、离线快照用
  内嵌 data URI）传入，绘制在 hero 圆角内裁切。
- **数据白名单**：只收选定汇总字段（总 tokens、费用、会话数、缓存命中率、
  输出 tokens、模型数、可选环比、时间线、TOP3 模型、统计截止时间）；
  原始事件、本机路径、会话 ID 一律不进图。弹窗打开即固定一份 summary 快照，
  自动刷新不影响预览与下载一致性——**开窗即有成图，无需二次点击（一键）**。
- **弹窗 `#shareDialog`**：复用 `.dialog-backdrop`/`.dialog` 材质（与
  skinDialog 同级兄弟节点），桌面左右分栏、≤720px 纵向堆叠；格式切换用现有
  segmented 井；canvas 预览置于凹陷井 max-height 52vh；保存/复制/系统分享
  三动作 + `aria-live` 状态行；焦点陷阱复用 `trapDialogFocus`、Esc 关闭、
  焦点还原到入口按钮。复制用 `navigator.clipboard.write`、系统分享用
  `navigator.canShare({files})` 检测，不可用时按钮隐藏，保存 PNG 永远可用。
- **文案**：全部走 `localizeText`，i18n.js 补词条（`test/i18n.test.js`
  会扫描 index.html 中文字面量，漏一个即红）。

## 3. 里程碑（每步出口：npm test / typecheck / lint / format:check 全绿）

1. **M0 冻结与协调**：重新 `git status` 核查并行 WIP（若 `share-card.js`
   或他人改动重现，停下确认）；把本文件拍板项回填 todos 文档。
2. **M1 纯模块**：share-card.js 格式表 / 数值格式化（阈值与看板对齐）/
   模型组装 / 图表降采样（>44 柱相邻合并）/ 布局引擎 / 文件名；
   不碰任何既有文件。
3. **M2 渲染器**：绘制原语（圆角路径、凸起块、凹陷井、meter、柱状、
   字号自适应、截断）+ `drawShareCard` 三种数据态（空/典型/极值）× 两格式。
4. **M3 界面接入**：share.css、index.html（顶栏按钮 + #shareDialog）、
   i18n.js 词条、app.js 接线（探针取色、colorFor、货币/时间文案注入、
   打开即渲染、格式与角色切换重绘、三个导出动作）。
5. **M4 静态快照**：static-export.js 把 share.css 内联为 `<style>`
   （replaceExactlyOnce）、share-card.js 去 export 并入 bundle；
   断言离线快照零请求、单一 module script；手工验证离线"保存图片"可用。
6. **M5 视觉收敛**：临时端口自起服务（绝不动 3765 和用户在跑的服务），
   浏览器自动化 × 浅/深 × 简洁/角色皮肤产真实 PNG 与弹窗截图，逐张目检
   迭代到满意；`docs/validation/2026-10-03-mobile-share-card/` 留档；
   更新 README 与 docs 索引。

## 4. 触点与规模

| 文件 | 变更 | 规模 |
| --- | --- | --- |
| `public/share-card.js` | 模型 + 布局 + 绘制 | 新增 ~600 行 |
| `public/share.css` | 按钮与弹窗样式 | 新增 ~200 行 |
| `public/index.html` | 顶栏按钮 + `#shareDialog` + share.css link | +~60 行 |
| `public/i18n.js` | 分享词条 | +~25 行 |
| `public/app.js` | 取值、构建模型、绘制、导出动作 | +~250 行 |
| `src/static-export.js` | 内联 share.css 与 share-card.js | +~12 行 |
| `test/share-card.test.js` | 见 §5 | 新增 ~300 行 |
| `docs/validation/2026-10-03-mobile-share-card/` | 证据留档 | 新增 |

**package.json 零新增依赖。**

## 5. 测试计划（`test/share-card.test.js`，node --test，无需 DOM 桩）

1. 格式表：两种格式均竖版、宽 1080、id 唯一。
2. 格式化奇偶校验：`shareTokenMillions` 与 `formatTokenMillions` 逐字符相等，
   覆盖 0/999/1e3/999_999/1e6/1.005e6/1e9/1e12/负数/NaN/字符串。
3. 模型组装：hero 数值与单位、4 指标块顺序与字段、缓存命中 meter、
   模型数块注 TOP1、`comparison` 缺失无环比、新纪录徽标。
4. 图表降采样：0/1/31/200 行，柱数 ≤44、ratio ∈ [0,1]、峰值指向最大值、
   全 0 数据无 NaN；0 行 → chart 为 null。
5. 布局：块矩形全部在画布内、互不重叠、hero ∈ [300,460]；
   退化路径（人为 1080×900）依次摘 models → 换 spark 且不越界。
6. 假 ctx 渲染：三态 × 两格式不抛异常、参数全有限（NaN 检查）、
   坐标在界内（允许角色水印出血矩形）、面板填充 ≥6。
7. 文件名：非法字符、中文 preset、超长 preset 规整为 ASCII 安全名，长度有上限。
8. i18n：英文环境下卡片标签无中文残留，中文环境原样。

## 6. 验收口径

- 一键：开窗即有图，无需二次点击。
- 小块化且只进白名单字段；接收者不了解看板也能一眼读懂。
- 1080 宽最小字 24px；约 360px 手机显示宽度下周期、总量、关键辅助信息可读。
- 浅/深 × 五款皮肤 + 简洁模式都可读，出图配色随皮肤换色（截图对照）。
- 预览与下载同数据同渲染；PNG 尺寸精确等于格式尺寸。
- 空数据、缺价、未知缓存率、超长模型名各有体面表现，缺失不写成 0。
- 离线快照可用且零外部请求、单一内联 module script；静态快照既有行为不变。
- 现有全部测试保持绿；`package.json` 不变。

## 7. 边界（不做）

不动静态快照既有行为与产出路径；不做 1:1、二维码、GIF、长图、上传链接；
不做卡片主题覆盖；不持久化分享设置；不重写打包器；未经要求不提交 git；
不触碰并行会话的未提交文件。
