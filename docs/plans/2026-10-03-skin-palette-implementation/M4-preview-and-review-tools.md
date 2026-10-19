# M4：隔离真实页面、首屏、状态截图与比较报告

前置：M0.4、M1.1、M1.2；完整捕获等待 M2 输出和 M3 测量器。遵守[总计划](../2026-10-03-skin-palette-implementation-plan.md)。保留 4 个原任务编号；M4.3 不变，M4.4 按[七张小卡](M4.4-report-and-command-subtasks.md)执行。

允许文件：`scripts/skin-palette/preview-server.mjs / capture.mjs / report.mjs / review-cli.mjs`、`test/skin-palette-preview.test.js`。不改生产 server/app/CSS，不仿制产品布局，不复制派生数学。

## M4.1 不可变候选预览服务

固定接口 `startCandidatePreview({ candidate, fixture, port = 0 }) -> Promise<{ url, close }>`。`candidate = null` 是正式色源验收模式，没有模块覆盖；其他输入必须是有效完整 Candidate。

实现路径：Node 开发代理 + 原有 `createUsageServer`，一实例固定一候选，不使用可变全局“当前候选”。

1. 用 fixture 参数启动实际 usage server，仅监听 `127.0.0.1:0`，保持实际 API、统计和 app 协议。
2. 开发前置代理同样仅监听 loopback，`/api/*` 转发到自己的后端；请求路径/查询、方法、body、状态和必要响应头保持一致。不得转发到用户正在运行的端口。
3. `/skin-palettes.js` 用内存中的**完整正式 SKIN_PALETTES 对象**替换对应皮肤的 `light/dark`。现有文件按模式存放扁平 token：`light: candidate.modes.light`，不要包成 `{ tokens: ... }`；其他皮肤不变。输出 ESM `export const SKIN_PALETTES = ...`，来自校验后的序列化数据。
4. `/skin-bootstrap.js` 用 M1.2 的发射器生成同一候选 override。候选模块和首屏配对且不可变，不能只在 load 后注入 root 样式。
5. 其他入口、ESM、CSS、字体和角色图片由当前 `public/` 原文件提供，按明确的允许根目录/文件类型读取；URL 解码后校验路径包含关系，拒绝目录穿越和访问仓库其他目录。开发服务不读取 `.git`、用户配置或日志。
6. HTML 不重写应用 DOM，不注入生产分支。M3 观察器通过 Playwright init script 安装，页面源代码不加调试接口。
7. 候选响应设置 no-store；每个新 candidate 启动新实例和新浏览器上下文。默认并发 1、上限 2，不通过共享 cookie/storage 实现 A/B。
8. `close()` 在 finally 关闭前后服务并可重复调用；fixture 生命周期归调用方，服务关闭不删除证据或共享 fixture。

验收：两候选服务颜色不同且互不串值，实际 API 有 fixture 数据；请求正式模式与当前产品一致；启动/关闭不写 `public/skin-palettes.js / skin-bootstrap.js`，全程源文件摘要不变；遍历路径拒绝；坏 candidate 启动前报错。

## M4.2 首屏和基准截图

`capture.mjs` 先实现一候选两模式的基准捕获，再接更多状态；该卡不一次跑十套。

步骤：

1. 通过已有开发运行时加载 Playwright/Edge，使用新的浏览器上下文。locale `zh-CN`，timezone `Asia/Shanghai`，reducedMotion `reduce`；阻断除自身 loopback 服务外的外网。计价 refresh 使用现有 UI audit 的开发 route 返回“无变化”，不修改 server 业务逻辑。
2. 导航前在隔离 storage 写当前主题、完整皮肤偏好（version 1、目标 ID、showCharacters true、opacity 0.5）及关闭自动刷新。init script 只在对应键为空时播种，不能每次 reload 重写，从而掩盖偏好恢复失败；后续状态通过实际 UI/runtime 改值。写入使用现有键，不能触碰用户原上下文。
3. 首屏检查暂停 `app.js` 模块响应，允许同步 bootstrap 和 CSS 先加载。导航使用 `waitUntil: "commit"`，随后等待 bootstrap dataset 标记和 stylesheet 就绪，不能在暂停模块时等待 load/DOMContentLoaded 而死锁。此时读取 root 20 项声明、dataset 和可见背景，核对 M1.1 输出，保存首屏证据。随后放行 app，等 runtime 和数据就绪，再检查声明完全一致；finally 确保放行或结束被暂停的请求。
4. 进入“全部”，等待非零 fixture 总量、Canvas 绘制、fonts.ready、角色 decode 和布局稳定；不使用固定 sleep 代替就绪条件。
5. 基准 CSS viewport 为 `1920×1080`，deviceScaleFactor=1，浏览器 zoom=100%；两模式同数据、同滚动位置、同透明度。首次测一皮肤时先用 candidate=null 的正式模式保存其旧颜色/几何对照，再开候选实例；对照只做一次并绑定源摘要。输出原尺寸 PNG 和布局/颜色 JSON，缩略图只由报告缩放展示。
6. 使用 `installBrowserColorObserver(page)` 在导航前观察 Canvas；状态打开后把 page 交给 M3 测量，再恢复到基准状态截图。
7. 记录浏览器错误、资源失败、实际 viewport/DPR、主题、皮肤、数据摘要与源文件摘要；任何必要资源未加载不是截图成功。

验收：一个候选 light/dark 的首屏和 runtime 颜色一致，有真实非零图表与长名称；原尺寸截图存在且实际查看过；正式文件不变。隐藏五款通过隔离偏好或现有 `__skinTestHook.selectSkin` 使用，不修改选择器列表。

## M4.3 状态矩阵与可恢复执行

每次命令只捕获**一个候选**，先完成一个模式，再另一个模式。状态采用 M0 `STATE_CATALOG` 的触发与恢复流程；每状态有独立 timeout（默认 15 秒）和结果。失败后关闭当前上下文，写明确错误，不在损坏的页面继续其他状态。

必须覆盖的矩阵：

| 组 | 条件 | 证据要求 |
| --- | --- | --- |
| S0 基准 | 两模式、1920×1080、角色 50%、聚光关闭 | 全页/首屏、所有可见必需角色 |
| S1 工具栏 | preset default/hover/selected、主题/刷新控件、keyboard focus | 局部截图与对应角色测量 |
| S2 日期 | 打开日历、fixture 月份、选中范围、输入为空/填值/focus | 日历/输入的真实背景和占位色 |
| S3 来源 | 打开导入弹窗、长路径、筛选/开关、目录选择完成 | 普通/次要文字、焦点和状态 |
| S4 计价 | 打开计价弹窗，非零费用、缺价/说明/错误状态 | 固定状态色、输入和按钮 |
| S5 图表/表格 | model/channel 视图，多系列和密集行 | 实际 Canvas 颜色与标签、必要数据标记 |
| S6 角色干扰 | 角色关闭与 100%，聚光开启与关闭 | 只重测受装饰/聚光影响的阅读区域；50% 已在 S0 |
| S7 恢复 | light→dark→light、重载偏好、character→classic→character | 20 项清除/恢复，无旧色残留 |
| D 桌面缩放 | 2560×1440，另测 1280×720 的窄桌面 CSS 视口；各两模式 | 布局和受背景变化影响的角色；不重复全部弹窗状态 |

S6 不取全部透明度与聚光状态的笛卡尔积。固定顺序为 `(off, spotlight off) → (50%, off) → (100%, off) → (50%, on) → (100%, on)`；有失败时补对应关闭对照即可。

桌面记录：2560 是第二种高分辨率 CSS 视口；1280×720 代表侧栏/并排窗口形成的较窄桌面内容区，不能称为真实 Windows 显示缩放测试。另记录一次目标机器的实际显示缩放/浏览器 zoom 人工复核；若未做，明确列为未测。不给项目增加 390px 手机页面矩阵。

输出每状态的 `checks.json / geometry.json / PNG`。基准图固定元素包括 topbar、首个 metric、主要 panel、chart、skin artwork bounds；与 M0 或正式基准的几何差异先说明测量误差，再判断是否违反颜色范围。颜色工具不得为了让几何比较通过修改页面宽度。

恢复策略：完成一个状态即保存证据；中断后只在同 candidateHash/policy/sourceHashes/fixtureHash 下允许补缺状态，否则创建新捕获目录。一个失败状态允许新上下文复跑一次；不得无限重试直到偶然通过。已有成功证据不覆盖，复跑记录单独存放。

验收：真实操作与状态命中可追溯，异常关闭服务/context/fixture；缺测保持 incomplete；单个失败不破坏其他候选数据。脚本提供 online freeze 回归能力，正式接入阶段使用，候选初筛不每组都重复写入冻结流程。

## M4.4 报告、命令与用户选择入口

本节保留行为规格；实际派发必须采用[M4.4 小卡](M4.4-report-and-command-subtasks.md)和[执行规则](execution-and-subagents.md)，辅助实现/独立测试允许文件以小卡为准，不把本节整包交给一个 agent。

固定 CLI：

```powershell
# 查看一组候选的真实应用；命令只启动隔离服务，不改正式色源。
node scripts/skin-palette/review-cli.mjs serve --run <run目录> --candidate <candidateId>

# 一次只捕获一组浅深候选，out 指向新的子目录。
node scripts/skin-palette/review-cli.mjs capture --run <run目录> --candidate <candidateId> --out <新捕获目录>

# 明确传入本轮使用的捕获索引，拒绝自动猜测“最新截图”。
node scripts/skin-palette/review-cli.mjs report --run <run目录> --captures-index <索引JSON>

# 验证 JSON、摘要、完整状态和选择，不自动启动实测。
node scripts/skin-palette/review-cli.mjs verify --run <run目录> --require-selections
```

`captures-index.json` 由协调者或 capture 命令显式维护，形状为 `{ schemaVersion: 1, captures: { [candidateId]: "相对本run的捕获结果路径" } }`；跨批次合并时允许经校验的相对证据引用。报告只能读该索引，不扫描一堆目录按时间拿图。capture 退出 0 表示所请求状态完整且无必要失败；失败/缺测退出 2，环境/参数错误退出 1。

`report.mjs` 产出自包含 HTML：

- 一皮肤一组候选卡，每卡并排 light/dark、同样大小，可点击看原尺寸；完整十套页提供按模式的整体网格，不能把十张缩成细长图代替阅读。
- 展示身份/气质、主要背景/强调色、最差必要对比、主文字优选余量、最近邻、材质意见和限制。fail/incomplete 与 ready 视觉上明确区分，不能隐藏警告。
- 每皮肤单选**成对候选**，只允许选 ready。局部报告导出 `selection-draft.json`；只有十套齐全的总报告才可导出 `selections.json`，导出时带当前 candidateSetHash/assessmentHash。
- 报告内的勾选代表用户操作结果；代理不得为了测试或截图填成正式用户选择。报告导出的记录仍需 M5.7 核对用户反馈或明确代选授权。
- 用固定模板和安全文本转义；嵌入 JSON 转义 `<`，不把长名称/理由直接塞到 innerHTML。不加载远程脚本/字体，也不制作另一套运行时配色预览。

正式验收扩展固定为 `capture --production --run <总run> --candidate <已选ID> --out <新目录>`：使用 candidate=null 的服务和实际正式色源；先确认正式 token 与被选候选一致，再按相同矩阵捕获。每次只验一套，`verify --production` 汇总十套正式证据和预期变更。

验收：一候选、一双皮肤、十套合并三个大小的报告可用，实际截图可加载/放大；错误摘要与未知路径拒绝；选择草稿与完整选择不会混用。报告可以用 `open_in_codex` 展示，但打开不代表用户已选定。

模块出口：真实页面证据、可查看的比较报告和明确的缺测记录。用户只比较少量成对候选；不要求用户逐项输入 HEX 或自己运行数学检查。
