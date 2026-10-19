# 移动端分享图 TODOs

> **历史归档 · 2026-10-03**。本稿被后续交付或融合计划替代；旧状态、待办与离线要求仅供追溯。现行规则与遗留事项见[文档入口](../../../00-index.md)和[任务清单](../../../02-tasks.md)，归档原因见[本批索引](../00-index.md)。

配套方案：[2026-10-03-mobile-share-card-plan.md](2026-10-03-mobile-share-card-plan.md)

## 当前进度

**计划阶段，未开工。** `public/`、`src/`、`test/` 均未改动。方案待评审；
§13 有 4 个待你拍板的问题。

约定：每个里程碑结束前必须 `npm test`、`npm run typecheck`、`npm run lint`、
`npm run format:check` 全绿，才进入下一个。

## M0：评审与冻结

- [ ] 确认入口位置（顶栏最左带强调色 / 最右同款）
- [ ] 确认是否补 1:1 方图（默认不做）
- [ ] 确认角色水印默认值（默认跟随皮肤"显示角色"）
- [ ] 确认页脚免责措辞（默认"API 等价费用估算"）
- [ ] 方案定稿后把本文件与方案文件一起提交（`docs:` 提交）

## M1：纯模块（不碰既有文件）

- [ ] `public/share-card.js`：`SHARE_CARD_FORMATS` / `shareCardFormat`
- [ ] `shareTokenParts` / `shareTokenMillions`：阈值与小数位对齐看板
- [ ] `shareCardFileName`：ASCII 安全、长度上限
- [ ] `buildShareCardModel`：范围、hero、4 指标块、图表降采样、TOP 模型、页脚
- [ ] `shareCardLayout`：§4.2 的弹性规则与退化路径
- [ ] `test/share-card.test.js`：格式表、格式化奇偶校验、模型组装、
      图表降采样、布局不越界/不重叠
- [ ] 全绿检查

## M2：渲染器

- [ ] 绘制原语：圆角路径、凸起块、凹陷井、meter、柱状、文字/适配字号/截断
- [ ] 色值工具：`shareWithAlpha` / `shareMixColor`（解析 `rgb()/rgba()/#hex`）
- [ ] `drawShareCard`：两块数据 + 三种状态（空/典型/极值）
- [ ] 角色水印与 62% 宽度安全规则
- [ ] 假 ctx 测试：无异常、无 NaN、坐标在界内、调用序列非空
- [ ] 全绿检查

## M3：界面接入

- [ ] `public/share.css`：分享按钮（复用 `.theme-toggle` 材质 + 强调色）
- [ ] `public/share.css`：弹窗分栏、预览井、动作区、≤720px 堆叠
- [ ] `public/index.html`：顶栏按钮 + `#shareDialog` + `share.css` link
- [ ] `public/i18n.js`：§6.5 全部词条（**必须**，否则 i18n 测试失败）
- [ ] `public/app.js`：令牌探针取值、货币/时间文案注入、`colorFor` 注入、
      打开弹窗即渲染预览、格式切换重绘
- [ ] `public/app.js`：保存 / 复制 / 系统分享三个动作 + `aria-live` 状态
- [ ] 焦点陷阱、Esc 关闭、`role="img"` 画布可访问名
- [ ] 全绿检查（含 i18n 词条扫描）

## M4：静态快照内联

- [ ] `src/static-export.js`：`share.css` → 内联 `<style>`（`replaceExactlyOnce` 锚点）
- [ ] `src/static-export.js`：`share-card.js` 去 `export` 前缀并入 bundle
- [ ] 校验离线快照仍是单一 module script、零外部引用
- [ ] 手工确认离线快照里"保存图片"可用（`navigator.share` 缺失时按钮隐藏）
- [ ] 全绿检查

## M5：视觉收敛与留档

- [ ] `docs/validation/2026-10-03-mobile-share-card/share-audit.mjs`
      （Playwright + Edge，在线/离线 × 浅/深 × 简洁/角色皮肤）
- [ ] 产出 16 张成品 PNG，断言尺寸、零请求、弹窗三视口不溢出
- [ ] 主题/皮肤切换的像素差值断言
- [ ] 弹窗截图（浅/深 × 桌面/手机）
- [ ] `read_image` 逐张人眼复核，迭代到满意
- [ ] `docs/validation/2026-10-03-mobile-share-card/README.md` 证据与结论
- [ ] 更新 `README.md`、`README.en.md`、`docs/12-dashboard.md`、`docs/14-project-log.md`
- [ ] 需要时更新 `docs/00-index.md` / `docs/validation/00-index.md`
- [ ] 全绿检查 + 最终 diff 自审

## 验收与交付

- [ ] 方案 §3 的 7 条验收口径逐条有证据
- [ ] `package.json` 依赖零新增
- [ ] 静态快照行为无回归（`test/static-export.test.js` 全绿）
- [ ] 三种视口（1440 / 1024 / 390）弹窗无横向溢出、预览不裁切

## 待核实边界

- [ ] 暗色主题下 Canvas 的"凸起"材质是否成立（可能需要单独一套投影强度）
- [ ] 中文字体在 Canvas 的实测 fallback 结果（截图确认非衬线）
- [ ] `ctx.letterSpacing` 在目标浏览器（Edge/Chromium）的可用性与降级表现
- [ ] 超长模型名在 TOP 模型行与指标块注文里的截断位置是否美观
- [ ] 数据为空（新装、无事件）时卡片是否仍然体面——不能出现 `NaN` / `0.00M` + 空图
