# 皮肤视觉修改：0—R8 验证

日期：2026-10-02。受测基底 HEAD：`0042e182bd0e62bc976393c6b664f6c4ad8c87c3` 加当前未提交的 P1／P2／P3 与计划工作区。用户按 [施工计划](../../plans/2026-10-02-skin-dialog-refinement-implementation-plan.md) 分阶段执行第 0 节—R8；各阶段完成后停下。本记录不表示 P4 已完成。唯一进度见 [TODOs](../../plans/2026-10-01-model-character-skin-todos.md)。

## 第 0 节：当前基线

已核对工作区状态／改动统计、开发与静态导出约定、原工程计划和 P0—P3 验证记录。仓库及相关父目录未找到适用 AGENTS.md。Node 实测 `v24.19.0`。

[0-baseline.json](0-baseline.json) 在生产文件修改前实际采集，包含 HEAD、Git 状态及改动统计、28 组主页面／按钮几何与材质、原图标描边和 112 个 `public/`、`src/`、`lineart assets/` 文件哈希。浅深与中英各取 1920／1680／1440／1280／1024／768／390px，高度统一 900px。

浏览器插件的执行工具因 Windows 沙箱启动错误不可用，未建立浏览器连接；已改用仓库既有 Playwright／无头 Edge 方式。独立浏览器上下文、随机端口静态服务器和固定空报告 fixture，不连接真实用量／计价 API，不写真实数据库或用户浏览器偏好。原 P2／P3 证据未覆盖。

## R1：实际改动与结果

生产文件仅改两处：`public/index.html` 的两条衣服 path 添加 `skin-icon-outline`／`skin-icon-accent` class；`public/skins.css` 将衣服 SVG 的 `stroke: currentColor` 改为 `stroke: var(--toggle-muted)`。按钮容器共同规则、尺寸、图标比例和 opacity 均保留。

原浅／深描边都为 `rgb(75, 85, 99)`。修改后浅色为 `rgb(69, 86, 102)`，深色为 `rgb(177, 190, 203)`，每组都与文/A 分隔符和未选中的日月图标相等。衣服 SVG opacity 仍为 1。

[r1-results.json](r1-results.json) 记录实际通过的 28 组检查：

- 衣服两条描边与邻钮中性色一致。
- 按钮尺寸、背景、边缘、圆角和阴影保持共同样式；与修改前测量完全一致。
- 主看板框体几何与修改前逐项完全一致，无横向溢出。
- 两条 path class 正确；浏览器异常为 0，修改前也为 0。
- 除 HTML 和皮肤 CSS 外的源码及全部原图／公开资源哈希不变。

已查看截图确认深色描边更清楚、浅色及 390px 排列正常：

- [深色修改前，1440px](before-dark-1440.png)／[修改后](after-dark-1440.png)。
- [浅色修改前，1440px](before-light-1440.png)／[修改后](after-light-1440.png)。
- [深色修改后，390px](after-dark-390.png)／[浅色修改后](after-light-390.png)。

执行命令：

```powershell
# 仅在本次修改之前采集，已有原基线请勿覆盖。
node docs/validation/2026-10-02-skin-dialog-refinement/r1-entry-audit.mjs baseline
# R1 时点验证；R2 之后应运行下节的 R2 审计，勿用旧源码哈希判定后续合法修改。
node docs/validation/2026-10-02-skin-dialog-refinement/r1-entry-audit.mjs verify
npx.cmd --no-install biome check public/index.html public/skins.css
git diff --check -- public/index.html public/skins.css
```

上述命令均 exit 0；Biome 检查 2 文件通过且无需自动修复。R1 时点只修改静态图标 class 与描边，未重跑全产品测试或正式离线导出。后续 R2 的新增验证见下节；原基线、截图和报告均保留。

## R2：横杠选择状态与主题微光

实际生产改动为 `public/skins.css`、`public/skin-ui.js`、生成来源 `scripts/prepare-skin-assets.mjs` 与重新生成的 `public/skin-bootstrap.js`。卡片及弹窗结构未修改。

横杠选择状态读取根 `data-skin`，不再读取 `aria-expanded`；外轮廓中性色不变，整个 SVG 不加滤镜。选中角色时横杠以当前模式已指定 accent 发光，未指定则沿用共同强调色。仅按钮局部使用项目相同的 45% 混合／3px drop-shadow 配方；返回 classic 清掉 accent 覆盖。隐藏角色、透明度 0% 和弹窗关闭均不取消已选皮肤的状态。

生成来源为各皮肤写入浅深 accent 槽，bootstrap 在 app 初始化前恢复变量；实际 palette 仍全部 null，未填任何真实颜色。40 个素材引用及清单内容未变化，见 [源码变化与哈希检查](r2-source-changes.json)。

[R2 浏览器审计](r2-indicator-audit.mjs) 实测 **101 个状态通过**，详见 [r2-results.json](r2-results.json)：

- 十角色 × 浅深模式：选中／开关弹窗／隐藏／0%、刷新恢复、classic 回退与悬停。
- 外轮廓和 SVG 均无发光滤镜；未配置 accent 时横杠颜色及光效与邻钮选中部分相等。
- 测试服务器仅在隔离上下文提供两种不同 accent，验证浅深切换和其它角色／classic 的覆盖清理；真实 `skin-palettes.js` 未改。
- 阻断 app.js 的独立上下文验证首屏脚本与 CSS 已点亮保存的皮肤，即使角色隐藏且透明度为 0%。
- 从固定空报告生成真实单文件 HTML，在 `file://` 禁网检查点亮、明暗切换、刷新与回退，无外部请求。
- 在线各状态几何与 R1 同模式基线一致；离线控件本就与在线不同，独立比较快照自己的 classic／角色／切换几何，不混用两种基线。零浏览器脚本异常。

已查看 [深色角色选中截图](r2-active-dark.png)；另保留 [浅色选中](r2-active-light.png)、[深色 classic](r2-classic-dark.png)、[浅色 classic](r2-classic-light.png)，横杠微光可见而衣服轮廓保持中性。

```powershell
node docs/validation/2026-10-02-skin-dialog-refinement/r2-indicator-audit.mjs
npm.cmd test -- --test-concurrency=1
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run skins:check
npm.cmd run skins:palette
```

上述检查均通过。串行测试 **351／351**，见 [实际输出](r2-tests-serial.log)；Lint exit 0，保留原有 41 条 warnings，见 [Lint 输出](r2-lint.log)。生成、40 素材一致性、格式、类型与配色校验通过，仍为 0／20 真实模式槽填色。

先前并行全测出现过两次不同的失败：[首次](r2-tests-first.log) 为服务端测试的临时端口被 Node fetch 判为 bad port；[重试](r2-tests-retry.log) 为 CLI restart 停止服务的时序失败。未修改相关服务逻辑，改为串行实测全套通过；不能把前两次执行记为成功。浏览器审计开发时也修正了“app 尚未初始化即查询语言选中标记”和“离线对照在线几何”的验证假设，最终结果来自修正后的完整重跑。

以上为 R2 时点的记录；随后单独授权并完成的 R3 见下节。

## R3：十角色五列两行与弹窗布局

生产代码只修改 `public/skin-picker.js` 与 `public/skins.css`。选择器过滤 `isClassic`，删除 Classic 专用模板、排序及样式，注册表仍为 11 状态、默认仍为 classic。原恢复入口仍可进入无皮肤，不自动选中第一款角色。

弹窗用共同外壳、标题、圆角、背景和投影；内边距对齐数据来源弹窗，桌面 24px、≤720px 为 20px。标题／说明／控制行固定，只有比较网格在窄屏或过矮视窗中滚动。桌面 ≥1024px 五列，721—1023px 三列，≤720px 两列；十卡恰好组成桌面两行。删除原 52／60／72px 预览高度压缩规则，统一保留 104px 的双模式预览。

窄屏回到 classic 时网格回顶部；重新打开角色模式时，在网格内部滚动以显示当前选中并聚焦的卡片，不滚动后方看板。共享大凹槽、滑杆主题化、人物右移以及按钮／说明精简仍分别属于 R5、R4、R6、R7／R8，没有在本阶段实施。

[新 R3 审计](r3-picker-audit.mjs) 实测 [49 个矩阵状态](r3-results.json) 通过：24 个在线组合（浅深 × 中英 × 六档视窗，每档含 classic 与角色选中两状态）加一次实际离线矩阵。具体检查：

- 1440×900、1280×800、1024×768 均为 5＋5，十卡、二十预览、名称和双组配色信息同屏，网格纵向溢出为 0。
- 1023×768／768×1024 三列；390×844 两列，可纵向滚动比较区域，控制按钮始终可见；窗口、网格和页面无横向滚动。
- 各卡浅深背景独立、参考透明度均 50%、预览高度不缩小；十卡順序与注册表一致，内部 classic 保留。
- 选中 DeepSeek 后仅一张卡片选中，弹窗保持打开；恢复 classic 后十卡均不选中且滚动归零。
- 打开／选择不改变主页面几何；Escape 关闭并将焦点归还入口。窄屏选中 Mimo 后重新打开，最后一张卡片可见且获得焦点。
- 从固定空报告生成单文件 HTML，`file://` 禁网打开十卡五列两行，二十张正视缩略图均为 data URL 且实际解码；选择／恢复可用，无外部请求，零浏览器脚本异常。

已查看 [深色 1440px 总览](r3-dark-1440.png)、[浅色 1024px 总览](r3-light-1024.png)、[深色 390px](r3-dark-390.png)。另保留相反模式对应截图，原 P2／P3、0／R1／R2 的截图和 JSON 未覆盖。首次视觉检查发现返回 classic 后窄屏会保留列表中段滚动位置，已修复并完整重跑本阶段审计。

```powershell
node docs/validation/2026-10-02-skin-dialog-refinement/r3-picker-audit.mjs
node --test --test-concurrency=1 test/skins.test.js test/static-export.test.js test/i18n.test.js
npx.cmd --no-install biome check public/skin-picker.js public/skins.css
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run skins:check
```

相关 [41 项测试](r3-tests.log) 全部通过，局部 Biome 无警告；全项目 [Lint](r3-lint.log) exit 0，仍为既有 41 条 warnings。类型、全局格式与 40 素材／生成物校验通过；对照 R1 哈希的 108 个不属于 R2／R3 允许改动范围的文件全部不变，包含真实配色、全部原图与公开资源。未重跑全产品测试，此阶段以相关模块测试、实际在线／离线 UI 和布局测量为依据。

旧 `p2-matrix-audit.mjs`／`p2-picker-audit.mjs` 中的十一卡、Classic 首卡和 5＋5＋1 要求已被新规格替代；其历史通过报告保留，本阶段入口使用上面的新审计。不能要求把纯注册表 11 状态的测试改成 10 状态。

R3 已完成并停下，R4—R8 待后续授权。

## R4：透明度滑杆材质与主题色

生产代码只修改 `public/skins.css`（滑杆专属块）、`public/skin-picker.js`（统一更新函数）与 `public/app.js`（一处 onChange 接线）。`#skinOpacity[type="range"]` 专属重置通用 input 的陶瓷凹槽外观（appearance、背景、边框、圆角、内边距、阴影逐项清空，沿用 checkbox「复选框不是文本输入框」的既有先例），改在伪元素上绘制：8px 胶囊轨道用 `--ceramic-well`＋`--neo-inset-small`（与 `.bar-track` 同配方），16px 滑块用共同陶瓷渐变＋rim/shade 边＋`--neo-raised-small`（与按钮同配方）；`::-webkit-slider-runnable-track`／`-thumb` 与 `::-moz-range-track`／`-progress`／`-thumb` 齐备。标签与百分比保持普通排版，凹陷明确只属于轨道本身。

填充段与 R2 同源：`--skin-slider-accent: var(--skin-active-accent, var(--blue))`。当前十套 palette 全部为 null，实测回落浅 `rgb(0,125,145)`／深 `rgb(108,218,226)`（即页面有效 `--blue`）；在根上注入测试 accent 后填充随即跟随、清除后恢复回落，证明链路已接通而未填任何真实配色。聚焦圈沿用全局 `input:focus-visible` 规则（2px 主题色 outline）。

进度同步收敛到 picker 的单一 `syncOpacityControl()`：同时写 range 值、百分比读出与 `--skin-opacity-fill`（轨道渐变的进度变量，CSS 缺省 50% 与 HTML 默认值一致）。首开渲染、拖动 input、程序化 runtime 变更（app.js 给 `createSkinRuntime` 传入 onChange → picker 同步）都经它——「只在 input 事件更新导致初始填充长度错误」的陷阱因此不存在。0—100、步长 1、立即应用与持久化保留；35%、0% 等已有偏好原样恢复（0 的输入值不被吞掉）。

[R4 浏览器审计](r4-slider-audit.mjs) 实测 **21 个状态通过**，见 [r4-results.json](r4-results.json)：

- 浅深两模式：外观重置逐项断言；轨道／滑块声明规则从 CSSOM 读取（Chromium 的 `getComputedStyle` 不解析 `::-webkit-slider-*` 伪元素）；填充/未填充颜色与边界位置的**像素级采样**——15%／65% 采样点刻意避开 thumb 行程（0—144px），0/50/80/100 边界方向全部正确。
- 键盘 Home/↑/End（0/1/100）值、读出、填充变量、存储偏好四处一致；程序化 `setOpacity(0.8)` 经 onChange 到达滑杆；重载后 80% 恢复；预置 35%、0%、chatgpt+50% 偏好打开即正确。
- 聚焦圈用**真实 Tab 导航**验证（脚本 `focus()` 不触发 `:focus-visible`，首版审计因此误报，已改用 Tab 到达后再断言）。
- 开弹窗、选择、拖动前后主页面几何逐项不变，无横向溢出；离线 `file://` 重置、默认 50% 与键盘步进一致，零外部请求、全程零页面异常。

已查看 [浅色截图](r4-slider-light.png)／[深色截图](r4-slider-dark.png)：填充为主题青、滑块为陶瓷凸起、未填充段为槽底色，标签与百分比无输入框外壳，两模式材质与弹窗一致。

```powershell
node docs/validation/2026-10-02-skin-dialog-refinement/r4-slider-audit.mjs
node --test --test-concurrency=1 test/skins.test.js
npm.cmd test -- --test-concurrency=1
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run skins:check
npm.cmd run skins:palette
git diff --check
```

均 exit 0：串行全套 **351／351**；lint 0 error、41 warnings 与基线一致；scoped `biome check public/skins.css public/skin-picker.js public/app.js` 通过；[R3 审计](r3-picker-audit.mjs) 复跑 49 状态通过，确认滑杆改动未回归弹窗结构契约。

R4 已完成并停下，R5—R8 待后续授权。

## R5：十张卡片置于一个连续大凹槽

生产代码只修改 `public/index.html`（`.skin-gallery-well` 包裹 `#skinGrid`）与 `public/skins.css`（井容器、滚动模型、卡片阴影/对齐）；`skin-picker.js` 无需改动——渲染仍写 `#skinGrid.innerHTML`，滚动容器仍是网格本身，R3 的窄屏滚动/聚焦滚动逻辑原样成立。

材质复刻看板既有先例 `comparison-table-frame`（styles.css 末段「Recessed selector rails」）：`border: 0`、16px 圆角、`--ceramic-well` 槽底、`--neo-inset` 凹陷，槽内 padding 14px（≤720px 收至 12px）。与该先例相同，井用 `::after` 覆盖层（`border-radius: inherit`、`pointer-events: none`）把凹槽阴影保持在滚动内容之上——窄屏网格在井内滚动时，卡片从连续的槽底阴影下滑过，两行之间永远是一个完整槽面，没有逐行分割或第二个槽框。

卡片层级与对齐：卡片底面改用轻凸起 `--neo-raised-small`（此前无边影），选中态保持既有按下式（`--neo-inset-small`＋主题色边），形成「浮起 → 按下」的统一语义；`.skin-card-colours` 以 `margin-top: auto` 钉底，某套皮肤将来填入色块而其它仍标「配色待定」时，十卡预览与色组仍逐项对齐。滚动模型：井成为弹窗的 flex 子项（`min-height: 0`、`overflow: hidden`），网格 `flex: 1 1 auto` 在井内滚动——桌面三档（1440×900／1280×800／1024×768）实测仍为 5＋5 且零溢出，+28px 井内边距落在原有余量内。

[R5 浏览器审计](r5-gallery-audit.mjs) 实测 **9 个状态通过**（浅深 × 1440／1280／1024／390 ＋ 离线），见 [r5-results.json](r5-results.json)：

- 结构：恰一个井、井唯一子元素是 `#skinGrid`、十卡全在井内；槽底颜色即 `--ceramic-well` 解析值，阴影含 inset、圆角 16px、padding 在 12—16px 参考带内；`::after` 覆盖层声明含 `pointer-events: none`。
- **槽底连续性的像素级证明**：临时隐藏全部卡片（其凸起阴影会渗入采样），对井截图后沿卡间间隙与底缘 padding 带多点采样——露出的槽底为同一井底色（与弹窗外壳表面色可区分），即两行共享同一连续槽面。
- 层级与状态：十卡均为陶瓷渐变面＋凸起影（非井底色）；选中卡边框为主题色、阴影转为按下式，其余九卡保持中性边。
- 对齐：十卡同一高度（≤2px），预览顶部与色组底部在卡内相对位置逐卡一致（≤1px）。
- 几何与回归：开弹窗/选择/恢复 classic 前后主页面几何逐项不变；390px 双列在井内滚动、弹窗本体不滚、控制行常驻可见、无横向溢出；离线 `file://` 井结构与连续性一致，零外部请求；全程零页面异常。

已查看 [浅色 1440](r5-light-1440.png)／[深色 1440](r5-dark-1440.png)／[浅色 390](r5-light-390.png)：「弹窗外壳 → 大凹槽 → 十张小卡」三层级在浅深两模式下均清楚可读，槽底在两行间连续，阴影方向与主页面一致。

```powershell
node docs/validation/2026-10-02-skin-dialog-refinement/r5-gallery-audit.mjs
node docs/validation/2026-10-02-skin-dialog-refinement/r4-slider-audit.mjs
node docs/validation/2026-10-02-skin-dialog-refinement/r3-picker-audit.mjs
npm.cmd test -- --test-concurrency=1
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run skins:check
npm.cmd run skins:palette
git diff --check
```

均 exit 0：R3（49 状态，含 1024×768 高度预算复验）与 R4（21 状态）审计复跑无回归；串行全套 **351／351**；lint 0 error、41 warnings 与基线一致；scoped `biome check` 通过。

R5 已完成并停下，R6—R8 待后续授权。

### R5 交付后修正：卡片阴影被滚动裁切边界硬裁（用户目检发现）

用户对 R5 首版逐卡目检指出四组伪影，浅深两模式均存在：顶行各卡左上角出现奇怪的尖锐形状；底行各卡下方的光影生硬截断；Kimi 左上角、Mimo 右下角、DeepSeek 与 Mimo 间隙的右缘有不自然光影。

**根因（单一）**：卡片的 `--neo-raised-small` 凸起阴影最深伸出卡外约 13–14px（浅色泛光 `-3px -3px 8px` 向左上、深色投影 `4px 5px 9px` 向右下），而 `#skinGrid` 是 `overflow: auto` 裁切容器，首版 14px 间距放在**井的 padding** 上、位于裁切边界之外，网格内容盒紧贴卡片——所有伸出内容盒的阴影 ink 被四边硬裁：顶行左上＝白色泛光被顶/左边裁断，底行下方＝深色投影被底边截断，Kimi 左上＝左裁边，Mimo 右下＝底+右双裁边，DeepSeek–Mimo 间隙右缘＝右裁边。R5 之前卡片无边影，裁切虽存在但不可见。

**修复**：把 14px（≤720px 为 12px）间距从 `.skin-gallery-well` 移入 `.skin-grid` 自身 `padding`——滚动视口内的 padding 带就是阴影的着墨空间，卡到井边的视觉距离不变，总高度预算不变（移动而非叠加），R3 的 1024×768 零溢出结论不受影响。滚动中途阴影在滚动口边缘自然淡出，与看板滚动区行为一致。

**复核**：R5 审计更新（padding 断言移到网格、几何检查按新 padding）后 9 状态复跑通过；R3（49 状态）／R4（21 状态）复跑通过；串行 351／351 与 typecheck／lint（41 warnings 基线）／format／skins:check／skins:palette／git diff --check 全部 exit 0。另对用户指出的三处位置做放大裁切目检（浅深 × [ChatGPT 左上角](r5-fix-light-chatgpt-corner.png)／[Mimo 右下角](r5-fix-light-mimo-corner.png)／[DeepSeek–Mimo 列](r5-fix-light-last-column.png) 及深色对应三张）：尖形、截断与缝隙右缘伪影全部消失，阴影自然落入槽底。

## R6：缩略图右侧构图与人物辨识度

本阶段接手上述 R5 修复后的当前工作区，只修改两个生产文件：`public/skin-picker.js`、`public/skins.css`。独立的 `previewComposition` 以源画布内脸部的实际位置设置水平锚点、舞台位置、顶部偏移与缩放：人物放在舞台右侧 72—76% 附近，桌面以 2.15 倍舞台高度取上半身；Grok 的脸部在源画布中更低，Muse／Mimo 的姿态偏移也分别校正。相同角色的浅深素材共享参数。缩略图参数不读取或改写 `skins.js` 的页面立绘测量值。

示意界面占左侧 40%，仍保留标题、两条文字、三根图表柱和按钮样本；去除 `backdrop-filter`，不再模糊人物。图片仍先于示意界面绘制，未通过提高图层覆盖配色样本。每个模式的 `.skin-preview` 自己裁切并隔离绘制，裙摆／尾巴等装饰允许裁掉，不能越过模式标签、相邻模式或卡片。舞台宽度的 `390cqw` 高度上限在窄屏自动降低放大比例，避免脸部和主干被右边缘裁切；104px 舞台高度、比较透明度 50% 均保持。

先查看 [十张原始正视图的布局参考](r6-source-fronts.png)，再逐张目检实际缩略图。以下每张局部截图同时包含浅深两模式，桌面与 390px 窄屏共四十张实际预览均已查看：

- ChatGPT：[桌面](r6-preview-chatgpt.png)／[390px](r6-preview-chatgpt-390.png)
- Claude：[桌面](r6-preview-claude.png)／[390px](r6-preview-claude-390.png)
- GLM：[桌面](r6-preview-glm.png)／[390px](r6-preview-glm-390.png)
- Gemini：[桌面](r6-preview-gemini.png)／[390px](r6-preview-gemini-390.png)
- DeepSeek：[桌面](r6-preview-deepseek.png)／[390px](r6-preview-deepseek-390.png)
- Kimi：[桌面](r6-preview-kimi.png)／[390px](r6-preview-kimi-390.png)
- Qwen：[桌面](r6-preview-qwen.png)／[390px](r6-preview-qwen-390.png)
- Grok：[桌面](r6-preview-grok.png)／[390px](r6-preview-grok-390.png)
- Muse：[桌面](r6-preview-muse.png)／[390px](r6-preview-muse-390.png)
- Mimo：[桌面](r6-preview-mimo.png)／[390px](r6-preview-mimo-390.png)

总览：[浅色 1440](r6-light-1440.png)／[深色 1440](r6-dark-1440.png)、[浅色 1024](r6-light-1024.png)／[深色 1024](r6-dark-1024.png)、[浅色 390](r6-light-390.png)／[深色 390](r6-dark-390.png)。脸部及身体主干清楚露出，左右构图与原先完整全身居中相比更易辨识；部分头发、道具和裙摆在模式舞台边缘裁切，符合本轮取景优先级。

[R6 浏览器审计](r6-preview-audit.mjs) 与 [结果](r6-results.json) 使用隔离空报告、无头 Edge 和真实单文件导出。浏览器插件仍因 Windows 沙箱启动失败而无法连接，采用与前述阶段相同的独立 Playwright 回退，不修改用户真实浏览器或业务数据。覆盖浅深 × 中英 × 1440×900／1280×800／1024×768／1023×768／768×1024／390×844／360×800，加浅深两种禁网 `file://`，共 **30 个场景、58 个构图状态、1,160 个预览检查**：

- 目检原图后在审计中独立标记脸部／躯干中心矩形，按实际图片变换检查其在舞台内、位于示意 UI 右侧；该几何检查辅助逐图目检，不替代人物辨识度检查。
- 二十个预览使用对应模式正视图，原始比例不失真、实际图像解码成功；浅深模式构图相同，背景各自独立。
- 图片不拦截选卡；实际点击人物、调主页面透明度至 0%、隐藏角色并重新渲染后，比较透明度仍为 50%，构图及选中状态正确。
- 大凹槽及滚动模型保持；桌面三档仍是五列两行、零纵向溢出；窄屏仅网格滚动，控制区常驻，无横向溢出。开启／选择／关闭前后主看板几何完全一致。
- 两种离线模式的二十张图片实际解码、选择与恢复 classic 可用，零外部请求；在线／离线全程零页面异常。
- [R6 接手时哈希](r6-before-hashes.json) 与结束时对比：112 个生产／素材文件中仅上述两个文件改变，其余 **110 个文件不变**，包括页面立绘参数、所有原图／公开 WebP、实际配色输入、bootstrap／manifest 与导出器。未填写任何新主题颜色。

```powershell
node docs/validation/2026-10-02-skin-dialog-refinement/r6-preview-audit.mjs
node --test --test-concurrency=1 test/skins.test.js test/static-export.test.js test/i18n.test.js
npx.cmd --no-install biome check public/skin-picker.js public/skins.css
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run skins:check
npm.cmd run skins:palette
git diff --check
```

均 exit 0：**41／41 相关测试**；局部 Biome 零诊断，项目 lint 为原有 41 warnings、零 error；类型、格式、40 个资产与待定配色校验通过。本阶段未重跑全项目业务测试或覆盖 R3／R4／R5 的历史证据。审计迭代中发现 390px 主干贴边并加入宽度上限；随后修复审计临时空目录的清理调用，最终完整重跑通过。

R6 已完成并停下，R7—R8 待后续授权。

## R7：底部简洁模式／关闭与键盘焦点

本阶段生产改动为 `public/index.html`、`public/skin-picker.js`、`public/skins.css`、`public/i18n.js`：移除恢复 50% 的可见节点、点击绑定、专属翻译与 `.skin-control-actions`；内部 `runtime.resetOpacity()` 及测试接口保留，默认透明度仍为 50%。复用 `#resetSkinClassicButton` 与 `#closeSkinDialogButton`，在弹窗末尾 `.dialog-actions` 中排列“简洁模式”（Simple mode）、“关闭”（Close）。标题栏不再有按钮，说明段落与对应翻译仍保留，留待 R8 删除。

两按钮直接继承共同操作按钮的陶瓷渐变、上下缘、阴影、字号、悬停／按下／聚焦规则，36px 最小高度、11px 圆角、12px 水平 padding；右对齐操作区禁止 flex 收缩。简洁模式以 `aria-pressed` 表达状态，当前模式复用项目的陶瓷按下阴影和强调色文字，其余外观仍来自共同按钮。调用已有 `runtime.resetToClassic()`，只改变 skinId，不重置透明度、角色显示开关、明暗、语言或搜索条件；关闭角色资源引用并熄灭横杠光效。

焦点与键盘：开窗聚焦当前角色，classic 时聚焦简洁模式；点击简洁模式保持弹窗打开并将焦点留在该按钮。十个 `radio` 只有一个 Tab 停靠点；方向键循环选择、Home／End 选择首尾、原生按钮 Enter／Space 选择。统一 `focusCard()` 使键盘选择／重新开窗的角色在窄屏网格中可见，使用 `preventScroll` 保持背景页面位置。继续使用 `app.js` 既有 Tab 限制、Escape 关闭及统一 `close()`，关闭按钮／遮罩／Escape 均恢复衣服按钮的焦点和 `aria-expanded`。

[R7 浏览器审计](r7-actions-audit.mjs)／[结果](r7-results.json)：**30 个场景、120 次关闭与焦点恢复通过**。覆盖浅深 × 中英 × 1440×900／1280×800／1024×768／1023×768／768×1024／390×844／360×800，以及浅深两种禁网 `file://` 导出。继续使用独立空报告、无头 Edge，不连接真实 API 或用户浏览器。

- 比较 computed style 与实际“数据来源”取消按钮：关闭按钮、未选中的简洁模式按钮材质／边缘／字号／比例完全一致；当前简洁模式呈共同按下态。
- 恰十卡、首尾顺序正确、单一 radio Tab 停靠点；方向键四向、首尾循环、Home／End、Enter／Space、Tab／Shift+Tab 及窄屏焦点可见性通过。
- 默认 classic 初始焦点、角色模式重开焦点正确；三种关闭方式均复位入口焦点；简洁模式按钮聚焦后弹窗保持打开。
- 35%／0% 透明度及隐藏角色偏好在简洁模式与刷新后保留；明暗、语言、实际填写的模型／仓库搜索条件与范围标签不被重置。角色资源引用清空、主题 accent 覆盖清掉、横杠光效熄灭，二十张比较预览仍为固定 50%。
- 三档桌面依旧五列两行且零纵向滚动，窄屏网格单独滚动、控制区及底部按钮常驻；无横向溢出。开窗／选择／简洁模式前后主看板几何相同。
- 在线／两模式离线零页面异常，离线零网络请求。R5 接手哈希与本轮相比只有 R6／R7 的上述四个生产文件改变，其余 108 个生产／素材文件不变，包含主页面立绘参数、配色槽、全部原图与 WebP、bootstrap／manifest 和导出器。

已目检 [浅色 1024](r7-light-1024.png)／[深色 1440](r7-dark-1440.png)／[深色 390](r7-dark-390.png)；同时保存浅深 × 1440／1024／390 六张总览。底部按钮共同形状与陶瓷材质、窄屏固定操作区清楚可见，R5 凹槽及 R6 人物构图保持。

```powershell
node docs/validation/2026-10-02-skin-dialog-refinement/r7-actions-audit.mjs
node --test --test-concurrency=1 test/skins.test.js test/static-export.test.js test/i18n.test.js
npx.cmd --no-install biome check public/index.html public/i18n.js public/skin-picker.js public/skins.css
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run skins:check
npm.cmd run skins:palette
git diff --check
```

全部 exit 0，相关测试 **41／41**，局部 Biome 零诊断，项目 lint 为基线 41 warnings、零 error；类型／格式／40 个资产／待定配色校验通过。未重复全项目业务测试，也未覆盖旧阶段审计结果。旧 P2／R4 中涉及恢复 50%、Classic 卡片和标题关闭按钮的断言代表旧版本，本阶段行为验证以 R7 审计为入口。审计迭代修正了两项测试前提：清除资源以无 src 引用为准（不是要求删除可复用 img 节点）；填写页面下方搜索框后先统一滚动位置再比较几何。

R7 已完成并停下；R8 与 P4 待后续授权。新增“页面两侧脸部随留白居中”的需求仍仅记录、未定施工方案、未实施。用户要求的精简交接记录已保存为 [R7 交接摘要](r7-handoff.md)。

## R8：删除冗余提示文字

开始施工前已读取 [R7 交接摘要](r7-handoff.md)、最新施工计划及开发约定，保留当前未提交工作区。生产改动仅涉及 `public/index.html`、`public/i18n.js`、`public/skins.css`：删除皮肤弹窗解释段落及其专属英文翻译，从禁止区段收缩的选择器组移除 `.dialog-copy`，删除仅用于该段落的 margin 规则。标题直接衔接角色开关／透明度控制行；四个区段为标题、控制行、共享大凹槽、底部操作区，继续使用原有 flex gap，没有空节点或替代提示。

皮肤名称、浅深模式标签、配色待定、百分比、无障碍标题保持；数据来源与计价弹窗的两段说明逐字不变。未改主页面布局、缩略图构图、角色资源、配色输入或交互逻辑。

[R8 浏览器审计](r8-copy-audit.mjs)／[结果](r8-results.json) 共 **30 个场景、120 次关闭与焦点恢复通过**：浅深 × 中英 × 1440×900／1280×800／1024×768／1023×768／768×1024／390×844／360×800，另加浅深两种禁网 `file://`。沿用 R7 的按钮／键盘／偏好回归步骤，使用另存的脚本、截图与结果，保留 R7 历史证据。

- 段落与专属翻译均消失，皮肤样式内无失效 `.dialog-copy`；其它弹窗原说明与数量保持。
- 四区段的实际边缘间距均等于弹窗有效 gap，没有删除文本后的留白占位；标题的无障碍关联与二十个模式标识仍有效。
- 三档桌面仍为五列两行且无需纵向滚动，窄屏仅网格内部滚动，控制行／底部操作按钮保持可见，无横向溢出；开窗、选择、简洁模式前后主看板几何相同。
- 共同按钮材质、单一 radio Tab 停靠点、方向键／Home／End／Enter／Space、Tab 限制、关闭／遮罩／Escape、焦点恢复及 35%／0% 偏好恢复通过；搜索条件保留，比较透明度仍为 50%。
- 在线／离线零页面异常，两模式真实离线导出零外部请求。与 [接手 R7 时的哈希](r8-before-hashes.json) 比较，112 个生产／素材文件仅上述三文件改变，其余 **109 个不变**。其余弹窗说明的修改前基线保存在 [r8-before-copy.json](r8-before-copy.json)。

已目检 [浅色 1024](r8-light-1024.png)／[深色 1440](r8-dark-1440.png)／[深色 390](r8-dark-390.png)，同时保存浅深 × 1440／1024／390 六张总览。标题下直接显示控制行，整体阅读顺序紧凑，共享槽底、卡片构图与底部按钮材质保持。

```powershell
node docs/validation/2026-10-02-skin-dialog-refinement/r8-copy-audit.mjs
node --test --test-concurrency=1 test/skins.test.js test/static-export.test.js test/i18n.test.js
npx.cmd --no-install biome check public/index.html public/i18n.js public/skins.css
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
npm.cmd run skins:check
npm.cmd run skins:palette
git diff --check
```

全部 exit 0，相关测试 **41／41**，局部 Biome 零诊断；项目 lint 为基线 41 warnings、零 error，类型／格式／40 个资产／待定配色校验通过。本阶段未重复全项目业务测试，也未改写旧阶段的审计预期或结果。

R8 已完成并停下供用户检查；本轮第 0 节—R8 逐项完成，P4 和受影响旧审计的整体收口保持待办。新增页面两侧脸部随留白居中仍仅记录，施工方案留待后续商讨。

## R7 用户复核修正：简洁模式移至右上角与选中外观

R8 后用户要求立即调整按钮位置与选中外观。首版 R7 给按钮单独加凹陷阴影，但主页面最终规则已将选择按钮改成陶瓷凸起、上下边缘、加粗字重与微光；首版引用了较早的凹陷形态，因此选中外观不一致。

本次仅改 public/index.html、public/skins.css、public/styles.css：简洁模式移至标题右侧，底部只保留关闭；移除专属凹陷阴影，以共用 ceramic-toggle 类接入共同普通按钮材质、主页面最终选中规则与文字微光。选中时为 10px 圆角、36px 最小高、700 字重及共同凸起影；水平 padding 仍用独立操作按钮的 12px。标题允许自然换行，按钮不收缩；关闭仍复用底部共同样式。未改 picker JavaScript、偏好、人物构图、配色或主页面布局。

当前入口：[simple-button-audit.mjs](simple-button-audit.mjs)／[结果](simple-button-results.json)。30 场景、120 次关闭与焦点恢复通过，覆盖浅深、中英、七档视窗及双模式禁网离线。R7／R8 历史脚本与结果保留，其底部两按钮断言代表当时版本，当前布局以本节为准。

- 与真实主界面已选按钮比较渐变、上下边缘、阴影、圆角、高度、文字色、字号、字重与微光；水平间距与真实关闭按钮比较。图表选择器按断点压缩的紧凑 padding 不适用于独立操作按钮。
- 标题按钮右对齐且垂直居中，底部仅关闭；默认／角色／简洁模式状态及重开焦点正确。移动后的 Tab 正反循环、卡片组方向键、关闭／遮罩／Escape 与返回入口通过。
- 三档桌面保持 5＋5，窄屏操作区可访问，无横向溢出；主看板几何、35%／0% 偏好及搜索条件保留。在线与离线零页面异常，离线零外部请求。
- 与 [修改前哈希](simple-button-before-hashes.json) 比较，112 个生产／素材文件仅上述三文件改变，其余 109 个不变。

已目检 [浅色 1024](simple-button-light-1024.png)／[深色 1440](simple-button-dark-1440.png)／[深色 390](simple-button-dark-390.png)，另存浅深 × 1440／1024／390 六张总览。右上角按钮已使用共同凸起形态与主题文字微光。

验证命令：运行本节浏览器审计；串行运行 test/skins.test.js、test/static-export.test.js、test/i18n.test.js（41／41）；对三个生产文件运行 Biome；typecheck、lint、format:check、skins:check、skins:palette、git diff --check 均通过。项目 lint 保持原有 41 warnings、零 error，无新增诊断。本阶段未重复完整业务测试。

整改完成并停下供用户检查；P4 与新增立绘居中方案保持原待办范围。

## R7：按截图明确按下后的凹陷效果

用户随后提供“上个月”选择控件截图，明确要求简洁模式按下后凹陷。上一节的凸起选中形态源于理解偏差，由本节替代；右上角位置与底部关闭保持。

本次生产仅改 public/styles.css：将 ceramic-toggle 的选中与真实鼠标按住状态接入现有菜单已选项的同一声明，复用槽底、透明边缘与内凹阴影；从主页面凸起选择按钮声明中移除该类。未选中仍为共同凸起表面，激活后为 700 字重、主题文字与共同微光；菜单原控件本身不变。

当前入口：[simple-inset-audit.mjs](simple-inset-audit.mjs)／[结果](simple-inset-results.json)。30 个浅深／中英／视窗／双模式离线场景、120 次关闭与焦点恢复通过。选中背景、边缘、阴影、圆角、字重及微光直接与真实“上个月”已选菜单项比较；独立按钮高度、padding、字号继续与关闭比较。额外两模式真实 mouse-down 验证凹陷在激活前已生效，松开激活后保持，选回角色后恢复普通表面。零页面异常、离线零网络请求。

与 [修改前哈希](simple-inset-before-hashes.json) 比较，112 个保护文件仅 styles.css 改变，其余 111 个不变。默认透明度、偏好、主看板几何及十角色预览保持；已目检 [深色 1440](simple-inset-dark-1440.png)、[浅色 1024](simple-inset-light-1024.png)、[深色 390](simple-inset-dark-390.png)，按钮内凹与截图参考一致。

本节浏览器审计、串行 41 项皮肤／导出／语言测试、lint（原有 41 warnings、零 error）、format:check 与 git diff --check 通过。仅更新本轮当前规格／状态，保留上一版历史审计和结果。
