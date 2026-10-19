# M3：实际阅读门禁、浏览器测量与差异诊断

前置：M0、M1.1、M1.3、M1.4；M3.2 的真实集成等待 M4.1。遵守[总计划](../2026-10-03-skin-palette-implementation-plan.md)。共 4 张卡。

允许文件：`scripts/skin-palette/evaluate.mjs / browser-measure.mjs / diagnostics.mjs / assess.mjs`、`test/skin-palette-quality.test.js`。角色与 policy 由 M0 所有；不改生产 CSS 来消除测量失败。

## M3.1 求解器可调用的快速角色检查

固定接口 `evaluatePalette({ skinId, mode, tokens, roleCatalog, policy })`，返回该模式的逐角色结果和汇总；无 I/O、无 DOM、副作用为零。

实现步骤：

1. 用 M0 校验 token，再调用 M1.1 取得真实 CSS 声明；解析不透明 HEX 与派生 rgba。未由声明覆盖的必要色从 `BASE_COLORS.character[mode]` 取得，已与 M1.4 的实际 CSS 同步；classic 对照另读 classic 分支，不能串用。不要自己复制陶瓷、hover 或 active-ink 公式。
2. 角色表达式采用总计划 4.4 的 `var / literal / alpha / mix-srgb`，背景另区分 `solid / linear-gradient / layered / canvas`；computed 前景交浏览器。节点未接线、未知变量或未知表达式返回 `unmeasured`，不猜默认色。
3. solid 背景精确检查；alpha 前景先与实际背景合成；sRGB mix 使用登记比例和浏览器同等单位。placeholder 不允许用原始 muted 替代其 76% 混色。
4. linear-gradient 的快速诊断取各段 33 个等距样本并报告最差值，同时声明为 `approximate`、最终需要浏览器确认。不能只取最亮/最暗端点；不同前景与混色可能在中间更差。
5. layered、径向聚光、带角色叠加和 Canvas 实际绘制返回 `browser-required`；它们不计入 fast pass。
6. 每条结果含角色、阈值、有效前景/背景、最差采样点、方法及 sourceRef。输出保留完整比值；4.499 显示 4.50 也仍失败。
7. 固定色冲突与 token 相关失败区分，供 M2 快速停止错误方向的搜索。

验收：对合成纯色、alpha、渐变中间最差、unknown role、未生效 token、装饰例外分别验证；不得把只有输入格式有效当作阅读 PASS。M2 可直接导入该函数，没有第二份阈值实现。

## M3.2 浏览器实际色源与背景测量

固定导出：`installBrowserColorObserver(page)` 在导航前安装开发观察器；`measureBrowserRoles({ page, candidate, mode, stateId, roleCatalog, policy })` 在 M4 已打开状态后测量。M3 不点击菜单、不自己建 fixture 或服务器。

实现路径固定为**读取计算样式 + 无前景背景截图 + 像素检查**，不实现完整 CSS 解析器：

1. 对普通文字读取真实 computed color/font/opacity 和文本 `Range.getClientRects()`；input/placeholder 单独用伪元素样式和内容区域。多个节点逐一测，汇总最差。
2. 使用浏览器自身的 1×1 canvas 把 computed CSS color 转成 sRGB/alpha，避免 Node 重写 `color()` 等现代语法。先核实 CSS 值有效，禁止 canvas 对无效值静默沿用上一 fillStyle。
3. 对当前角色暂时隐藏文字填充和 text-shadow，保留 `color`、背景、边框和几何。优先用 `-webkit-text-fill-color: transparent`；不能改 `color` 为 transparent 而改变依赖 currentColor 的背景。必要 SVG 图标只隐藏前景绘制，保持盒子。
4. 对包含文字区域截取背景 PNG。PNG 在同一隔离浏览器用 Image/canvas 解码，不新增运行时 PNG 依赖；检查文本矩形内全部背景像素的最低对比。screenshot scale、deviceScaleFactor、scroll 和 CSS 坐标换算必须显式记录。
5. 文字本色与每个背景样本按实际 alpha 合成后算比值；不取抗锯齿字缘作为前景，也不把泛光作为满足对比的依据。保守矩形取样可能包含无字间隙，需在证据注明。
6. 任何临时样式、隐藏图标、focus/selection 和截图遮罩在 `finally` 恢复；恢复后核对原 CSS 声明、元素尺寸和截图状态。不允许测量过程改变应用业务状态。
7. 对无法隔离的滤镜、混合模式、重叠控件或祖先整体 opacity 合成返回 `unmeasured`，输出原图、目标框与手工测量方法；不能把祖先 opacity 简单乘到前景 alpha 就声称背景合成正确，也不能用肉眼觉得清楚直接补数值 PASS。

Canvas 路径：

- 导航前观察 `fillText / strokeText / stroke / fill` 的颜色、alpha、font、transform 和绘制坐标，观察器调用原函数，不改变绘图参数。
- 文本按实际绘制颜色检查 4.5 或核实的大字阈值；必要数据图形按 M0 分类检查；非必要网格保持例外记录。
- 为读取背景，保存画布 bitmap，临时清除前景 bitmap，保留 CSS 背景/底层，再测背景，最后恢复 bitmap。若应用自身先绘背景底色，按观察到的背景绘制保留/重建这一层，不能盲目清空后读错底。
- 不能从 `paletteChartSeries` 推断图中颜色；实际应用目前另有分类颜色分配。

验收：至少有纯色、渐变、alpha placeholder、聚光开关、Canvas 标签的集成样例；其中制造一个 raw token 达标但真实叠加失败的案例，检查器必须失败。验证截图前后 DOM 几何、应用偏好和真实 root 颜色不变。复杂项不能测时保留 incomplete，不通过少采样或删除角色掩盖。

## M3.3 材质、成对身份与最近邻诊断

`diagnostics.mjs` 仅处理已经生成的真实声明、颜色与评审，不修改 token。

固定输出：

1. 记录实际 top/panel/bottom/page/well 的 OKLab L、相邻 `D_OK`、高光/阴影 alpha；提供层次剖面数据，不强制所有皮肤满足同一条 L 单调链。
2. top 与 bottom 的 `D_OK < 2.0` 标为 `flatSurfaceWarning`；此首版阈值仅提醒视觉复核，不作为“陶瓷合格”证明。方向性和凹凸仍看原尺寸截图。
3. light/dark 各自输出 page、panel、accent 的两两距离矩阵，列每个候选的最近邻皮肤及每项距离。
4. 成对整体近似值固定为六项距离的算术平均，命名 `pairMeanDistance`；不得包装成审美总分。六项分别是浅深的 page/panel/accent。
5. 不同皮肤六项都小于 3.0 时标 `nearNeighborWarning`，不能自动判身份错误或删候选。首轮试点后若调整提醒阈值，必须增 policy 版本、重跑报告并记录理由。
6. 同色相允许共存；不强制 25° 分隔，不自动更换为所谓官方色，不按最大 gamut 彩度排序。

验收：距离公式单位一致；交换两款结果对称；浅深角色齐全；缺少某一项时结果 incomplete 而非用 0 补齐；材质或差异高分无法把文字失败翻成通过。

## M3.4 门禁、视觉初筛与证据过期

实现 `assessCandidate({ candidate, fastChecks, browserChecks, visualReview, run })`；输出 M0 约定的 Assessment，并校验来源摘要、fixture 与政策版本。

固定判定：

- 任一必要角色 fail：`rejected`。
- 必需角色/状态缺测、未完成视觉初筛、源文件或输入摘要不同：`incomplete`，注明 `STALE_EVIDENCE` 或缺失对象。
- 只有所有必要项目有有效 pass、合法 not-applicable、代理视觉初筛接受，才 `ready`。
- fast 的 approximate 不能覆盖浏览器实测失败；相同角色有多条有效证据取最差比值；记录不同方法差异。
- 7:1 是主文字优选，未达 7 但达到 4.5 可以 ready，必须在读数中显示余量；不能全盘降成 3。

`visual-review.json` 必填项目：字标可辨、普通文字不刺眼、陶瓷凹凸可见且光源一致、浅深身份一致、角色关闭/50%/100% 未遮挡必要阅读、聚光未使文字淹没、最近邻区别可解释、没有通过几何变更掩盖颜色问题。评审者必须实际查看原尺寸图片；记录截图路径、意见和 `accept / reject / pending`，不由色差函数自动填写 accept。

手工补测必须注明角色、状态、取样位置、前景/背景数值、计算方法和证据；定性“好像看得清”只属于视觉意见。字标例外保留视觉结论，不把它算成普通正文 PASS。

验收：测试全部 readiness 分支、缺状态、摘要过期、旧证据重复、例外缺理由、用户选择与代理 ready 分离；使用技术失败但材质距离高的样例确保仍 rejected。

模块出口：机器门禁和人工初筛可分辨、每条结论可追到实际位置；不以一个总分或旧 palette check 代替阅读验收。阈值依据为 [WCAG 文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) 与[非文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)。
