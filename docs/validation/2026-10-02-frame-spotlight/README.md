# 主界面框体 SpotlightCard：实施与专项验证

日期：2026-10-02。用户要求开始施工后，按[专项方案](../../plans/2026-10-02-spotlight-metric-cards-plan.md)实现主界面所有实际凸起框体的光标聚光。生产代码仅改 `public/app.js` 与 `public/styles.css`，原生实现，无新依赖或模块，无素材、配色、立绘定位、皮肤预览或导出器改动。

当前采用 **22% 试用强度**（`.shell` 的 `--spotlight-strength`），跟随当前模式 `--skin-active-accent`，简洁模式回落 `--blue`。减少动态效果采用 **A：保留指针跟随、取消渐显**；普通模式轻微渐显 120ms，退出或进入凹槽立即清除。最终视觉强度留待用户实际检查，不把本次起点写成用户配色定稿。

## 实际参与／排除清单

- 外层框体：`.topbar`、三个 `.toolbar > .control-group`、12 张 `.metric`、动态 `.comparison-item`、六个 `.panel`。All 范围仅有一张“不可比较”卡，可比较范围有三张，均已实测。
- 按钮及主页面浮层：主界面内具有实际外凸材质的 `button`、`.recent-segment`、`.recent-range-menu`、`.date-picker-popover`。包括三颗标题按钮、可用的面板操作／移除按钮、凸起选中的范围／时间分布按钮、日历导航／清除／悬停日期及未选中的菜单项。透明按钮不因候选选择器而获得新框体。
- 实际状态决定是否参与：计算样式中必须存在外部材质阴影。只有内阴影的菜单选中项等停止自身和祖先聚光；日历已选／区间状态明确排除。当前分段轨道的选中按钮是凸起，仍然参与，不能误套旧版“全部选中态均凹陷”的规则。
- 凹陷区域：数字读数、详情 `.bar-track` 和填充、`.timeline-chart-well`、`.comparison-table-frame` 及详情展开内容、`.home-list`、`.cost-estimate-note`、`.auto-refresh-well`、`#presetButtons`／`.segmented-well` 轨道、`.recent-combobox`、`.date-range-button`、所有输入／搜索／选择控件、禁用按钮和实际内凹控件。
- 凹槽中真正凸起的子按钮可单独响应，例如来源列表的“移除”。命中内凹表面直接熄灭；命中凸起子按钮只照其自身，父面板不会叠加。
- `.toolbar`、`.topbar-actions`、标题文字和网格等透明布局容器保持原状；独立弹窗和皮肤缩略图不加入。body 中不可命中的图表 tooltip 继续沿用原有材质与逻辑。

## 分层、裁切与事件实现

`setupFrameSpotlight()` 在 `.shell` 委托指针事件，只激活最近的一个实际凸起表面。使用未被这些宿主占用的 `::after`；现有分段分隔线与下拉箭头的 `::before` 保留，表格槽底的 `::after` 属于排除区域。仅当前激活宿主建立局部堆叠上下文，光层位于背景上方、内容下方，不接收事件。只为原本 static 的激活宿主临时设 relative，退出时撤回；含打开菜单的激活祖先保持浮层在后续框体之上。

装饰层自身继承圆角，不给功能框体新增 overflow 裁切。按凹槽和凸起子框体的实际矩形生成 SVG alpha 遮罩，重叠排除区域取并集，透明凹槽也不透光。圆角形状保留，同时按中间滚动祖先的可见区域裁切，滚出详情区域的长条槽不会在标题上产生遮罩残影。遮罩是运行时 data URL，无外部文件或请求。

坐标每帧相对实际宿主测量；快速 pointermove 合并为一个 rAF。滚动（包含内部滚动）、窗口变化、ResizeObserver 和动态 DOM 状态变化使遮罩失效并重新命中。观察节点集合增量维护，自身 CSS 变量写入不反复触发观察器。移除／隐藏目标、pointerleave／cancel、失焦、页面可见性事件、输入能力改变及独立弹窗打开会清理状态。

## 已完成验证

`browser-audit.mjs` 使用独立无头 Edge、合成项目日志和临时 home／数据库。在线使用真实项目服务与 API；离线使用实际导出的自包含 HTML，从 file:// 打开并拦截全部 HTTP 请求。未操作用户现有 Edge 标签页、浏览器配置或业务数据。

- **61 项浏览器检查通过，98 个定位／颜色／性能状态**。32 组在线／离线 × 2290／1440／1024／390px × 浅深 × 中英与施工前基线相比，原有几何、背景、阴影、圆角与 overflow 完全相同；25 个外层框体逐一激活后，再验证可见界面几何及原有材质不变。
- 实际鼠标逐类命中外层框体、凸起按钮、嵌套子表面、菜单和日历；逐类进入凹槽熄灭。覆盖有数据、搜索无结果、不可比较卡、详情展开、模板替换、内部滚动和连续八档宽度变化。
- 八类现有凹槽的中央内部像素条在父框体发光时完全一致。另用透明且重叠的两个凹槽 fixture 验证并集遮罩：槽内像素完全不变，旁边实际凸起表面明显变亮。不是只检查 CSS 字符串或依赖不透明底色掩盖泄漏。
- `check-pixels.py` 检查真实截图：在线／离线各 **2,418 个不透明白色文字像素完全不变**，各 9,538 个背景及抗锯齿像素随下方光层改变，证明光确实出现且没有覆盖文字。数字区域另由凹槽像素验证保护。
- 十套真实角色 × 浅深及简洁模式（在线／离线共 44 组颜色状态）核对实际计算出的径向光色；临时 accent fixture 在鼠标不动时实时换色，随后完整还原，未写入真实色板。reduce／no-preference 分别实测无过渡／120ms 渐显。
- 实际 coarse／touch 浏览器上下文不出现聚光；fine 上的 touch 事件清理旧光并可恢复鼠标输入。能力 change 使用初始化前受控 MediaQueryList 模拟，页面可见性使用 visibilitychange 事件模拟；与真实 coarse 上下文验证分开记录，未声称测试了真实硬件切换或后台节流。
- 最近范围、时区与日历浮层保持可命中；选中凹陷项不亮；搜索、表格展开、图表 tooltip 和独立弹窗可操作。原 CSS 菜单层级、焦点样式和 New 徽标未改。弹窗打开无需新指针事件即可清除主界面灯光。
- 本机 isolated Edge 单次聚光计算 p95 **约 0.4ms**，原始样本记录于 `results.json`；快速移动后 180ms 静止窗口内无继续写样式。该计时是本机 JS 工作耗时，不是 GPU 或其他设备帧率保证。
- 无 ResizeObserver 的降级路径仍可按鼠标与窗口调整定位。浏览器页面异常 **0**、外部请求 **0**；导出体积约 26.32 MB，自包含检查通过。
- 100 个生产／素材文件哈希对照，仅 app.js／styles.css 两个变化，其余 **98 个保持一致**。素材、色板、角色显示与预览模块、index.html、bootstrap 没有修改。
- 项目 **355／355 测试通过**；typecheck、素材一致性、格式检查及 diff 检查通过；Lint 成功，41 条既有警告。typecheck 主要覆盖 src，新前端行为由本专项浏览器测试验证。

## 复查入口与界限

运行 `node docs/validation/2026-10-02-frame-spotlight/browser-audit.mjs` 可复跑当前实现；`--baseline` 会覆盖施工前记录，仅用于明确重新采基线，日常复查不要添加。使用已安装的独立 Playwright／Edge 路径，不新增项目依赖。文字像素检查使用工作区依赖内带 Pillow 的 Python 运行 `check-pixels.py`。

主要证据为 `before-layout.json`、`before-hashes.json`、`results.json`、`pixel-results.json`、`browser-audit.log`、`node-test.log` 与 `lint.log`。`online/offline-spotlight-title-*.png`、`online/offline-spotlight-panel-*.png` 为两模式实际页面；`*-calendar.png`、`*-transparent-mask.png` 和 `*-text-before/after.png` 为局部验证。

本次完成 S1 专项实施与验证。用户最终强度目检、其它浏览器／硬件观感和皮肤 P4 全流程联合回归仍分别保留；不会把本专项代替整个皮肤系统最终交付验收。历史 R1—R8、脸部居中和色板证据未覆盖。
