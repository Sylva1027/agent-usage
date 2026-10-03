# 模型角色皮肤 P0 基线 + P1 骨架验证

日期：2026-10-02。范围：P0.1—P0.3（已完成，第 1—6 节）、P1.1—P1.3（第 7 节）、P2.1—P2.4（第 9 节）、P3.1—P3.3（第 10 节，含 2026-10-02 复检与修复）。

施工契约见 [Implementation Plan](../../plans/2026-10-02-model-character-skin-implementation-plan.md) 第 0／3／6／7 节；用户要求背景见[原方案](../../plans/2026-10-01-model-character-skin-plan.md)；逐项状态唯一维护在 [TODOs](../../plans/2026-10-01-model-character-skin-todos.md)。

## 0. 本目录的来源说明

用户于 2026-10-02 指出更早一轮实施尝试存在不稳定因素（该轮 `pwsh` 被沙箱拒绝，只留下了带 `<unavailable>` 占位的 README、一个从未运行过的脚本和一个探针文件），要求删除其全部工作痕迹并从零重做。

因此本目录是**从零重新采集**的产物：脚本、清单、截图、本 README 均为本轮实际运行结果，不继承、未复制上一轮任何文件。用户的素材整理（`lineart assets/light/`、`dark/`）按契约保留，未移动、未重命名、未修改。

## 1. P0.1 工作区基线

- HEAD：`0042e182bd0e62bc976393c6b664f6c4ad8c87c3`，分支 `main`（与 Implementation Plan 第 0 节要求的保存点一致）。
- 记录时间：2026-10-02T04:39:14+08:00（Asia/Shanghai）。
- 环境：Windows NT 10.0.26200.0；Node `v24.19.0`（契约要求 `>=23.8`）；npm `11.17.0`；PowerShell 7.6.6 Core。
- 已阅读的适用约定：[开发与接手](../../03-development.md)、[静态导出约定](../../13-static-export.md)；工作区根 `AGENTS.md` 经 glob 检索**无命中**。
- 已执行 `npm.cmd test`：**323 / 323 通过，exit code 0**（约 3.6s），证明当前工作区代码健康、工具链可用。

### `git status --short` 原文

```text
 M docs/00-index.md
 M docs/02-tasks.md
 M docs/plans/2026-10-01-model-character-skin-plan.md
 M docs/plans/2026-10-01-model-character-skin-todos.md
 D "lineart assets/ChatGPT-lineart.png"
 D "lineart assets/ChatGPT-side-lineart.png"
 D "lineart assets/Claude-lineart.png"
 D "lineart assets/Claude-side-lineart.png"
 D "lineart assets/DeepSeek-lineart.png"
 D "lineart assets/DeepSeek-side-lineart.png"
 D "lineart assets/GLM-lineart.png"
 D "lineart assets/GLM-side-lineart.png"
 D "lineart assets/Gemini-lineart.png"
 D "lineart assets/Gemini-side-lineart.png"
 D "lineart assets/Grok-lineart.png"
 D "lineart assets/Grok-side-lineart.png"
 D "lineart assets/Kimi-lineart.png"
 D "lineart assets/Kimi-side-lineart.png"
 D "lineart assets/Mimo-lineart.png"
 D "lineart assets/Mimo-side-lineart.png"
 D "lineart assets/Muse-lineart.png"
 D "lineart assets/Muse-side-lineart.png"
 D "lineart assets/Qwen-lineart.png"
 D "lineart assets/Qwen-side-lineart.png"
?? .archify/
?? .codex-ui-preview-1440-updated.png
?? .codex-ui-preview-1440.png
?? .codex-ui-preview-browser-profile-2/
?? .dsh-probe.mjs
?? .zcode/
?? docs/plans/2026-10-02-model-character-skin-implementation-plan.md
?? "lineart assets/dark/"
?? "lineart assets/light/"
```

`git diff --stat`（仅已跟踪文件，24 files changed, 136 insertions(+), 113 deletions(-)）：四份文档修改 + 根目录 20 张 PNG 显示为删除（内容已在 `light`／`dark` 中重新组织）。暂存区为空（`git diff --cached --stat` 无输出）。

### 必须保留的未提交工作

- 文档修改：`docs/00-index.md`、`docs/02-tasks.md`、两份 `2026-10-01` 计划文档，以及未跟踪的 `2026-10-02` Implementation Plan。
- `lineart assets/light/`、`lineart assets/dark/` 各 20 张（用户素材整理）。
- 其他未跟踪杂物**与本任务无关且早于保存点**，按用户 2026-10-02 决定不清理、不复制进 `docs/validation`：`.archify/`（09-28）、`.zcode/`（09-27）、`.dsh-probe.mjs`（09-28）、`.codex-ui-preview-1440.png` 与 `-updated.png`（09-30）、`.codex-ui-preview-browser-profile-2/`（09-30）。

### 改动边界

本轮**未修改** `src/`、`public/`、`test/`、`package.json` 或任何项目依赖；`git status` 中 `src|public|test|package.json` 均无变化。仅新增 `docs/validation/2026-10-02-model-character-skins/` 下的证据文件。

## 2. P0.2 经典外观基线

脚本：`baseline-audit.mjs`（本轮从零编写；隔离 fixture 手法参考仓库已提交的 [看板修正验收](../2026-10-01-dashboard-corrections/browser-audit.mjs)，但选择器、测量字段、容差与比较逻辑为本轮重新定义）。

**隔离 fixture**：`mkdtemp` 临时目录作为隔离 home；合成 6 个项目的 `.codex-usage/usage.jsonl`；合成 Codex `quota.jsonl` 与 `cli`／`exec` 用量；合成 `pricing-auto.json`／`pricing.json`；`automaticDiscoveryEnabled: false` 且 `pricingFetcher` 直接抛错以阻断上游。全程不读取真实用量库、日志或价目文件。

**矩阵**：宽度 1920／1680／1440／1280／1024／768／390 × 主题 light／dark × 语言 zh-CN／en-US = **28 档**，每档独立 browser context（`deviceScaleFactor: 1`、`timezoneId: Asia/Shanghai`、`reducedMotion: "reduce"`），等待 dashboard ready（`#totalTokens` 非 `-` 且 `#modelComparisonTable table` 存在）＋ `document.fonts.ready` ＋ 两帧 rAF 后测量；统一切换到「全部」范围。

**测量字段**：23 个选择器的 `getBoundingClientRect`（shell、标题、topbar-actions、两个按钮、toolbar、range-controls、presetButtons、date-range-controls、dateRangeButton、autoRefreshStatus、auto-refresh-well、两组 metrics、comparisonSummary、main-grid、chart-panel、timelineChart、period-comparison-grid、两张表容器、bottom-grid、homes-panel、pricing-note-panel）；横向溢出；卡片网格列数与换行行数；工具栏控制组行列与 preset 换行；两张表 `thead th`／`tbody tr`／首行列数；`#languageToggle` 与 `#themeToggle` 的完整 computed style（含宽高、圆角、内外边距、背景、边框、阴影、字体、gap）；body 背景与字体；`data-theme`／`data-locale`／`lang`。

**运行结果**：28 档全部采集成功；`pageErrors = 0`、`consoleErrors = 0`、`externalRequests = 0`。截图 34 张（28 张视口 `-top.png` ＋ 1920／1440／390 的 zh-CN 浅深各一张整页 `-full.png`，共 6 张）。

### 经典外观关键不变量（受测基线，后续皮肤不得改变）

| 视窗宽 | `.shell` 宽 | 工具栏行数 | metrics 列数 | 花销 metrics 列 | main-grid 列 | 周期对比列 | 横向溢出 | 文/A・主题按钮 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1920 | 1440 | 1 | 6 | 6 | 3 | 2 | 0 | 64×38 |
| 1680 | 1440 | 1 | 6 | 6 | 3 | 2 | 0 | 64×38 |
| 1440 | 1408 | 1 | 6 | 6 | 3 | 2 | 0 | 64×38 |
| 1280 | 1248 | 1 | 6 | 6 | 3 | 2 | 0 | 64×38 |
| 1024 | 992 | 3 | 6 | 6 | 3 | 2 | 0 | 64×38 |
| 768 | 736 | 3 | 2 | 2 | 2 | 2 | 0 | 64×38 |
| 390 | 370 | 3 | 1 | 1 | 1 | 1 | 0 | 60×38 |

以上数值在 28 档内与主题、语言无关。`64×38`／`60×38` 与 Implementation Plan 第 2 节记载的按钮尺寸一致，可作为新衣服按钮的比对基准。

### 复现验证（P0 门槛）

`node baseline-audit.mjs --compare` 用同一 fixture 重新采集 28 档并逐项比对：

```json
{ "combinations": 28, "baselineCombinations": 28, "passed": true, "mismatches": [] }
```

**零差异**通过（容差为框体 ≤1 CSS px、溢出 ≤1 px、行列与按钮样式要求完全一致；实际未用到容差），exit code 0。基线可重跑，满足「能重跑的既有布局基线」门槛。

## 3. P0.3 源图清单与内容验收

脚本：`source-image-manifest.py`（Pillow + numpy）。仅读取源目录，逐张产出字节数、SHA-256、PNG IHDR、真实 alpha 分布、油墨亮度与非透明包围盒，写入 `baseline/source-images.json`。

- **数量**：期望 40，实际找到 **40**，缺失 0。两个目录各 20 张，无扩展名或命名不符契约的文件。
- **格式**：40 张全部为 PNG、RGBA、`colorType 6`（truecolor+alpha）、无隔行；Pillow 模式均为 `RGBA`。
- **真实透明度**：40 张均**确有透明区域**（完全透明像素占 42.35%–76.19%），不存在「有 alpha 通道但实际不透明」的情况；完全 opaque 像素占比仅 0.00%–0.03%，说明整幅线条几乎都是抗锯齿的半透明笔触，**没有任何实心填充区块**。
- **尺寸**：三种，同一角色的正视与侧视可能不同，逐图显示参数因此必要：
  - `941×1672`：ChatGPT（正/侧）、DeepSeek 正、Gemini 侧、Qwen（正/侧）、Grok（正/侧）
  - `941×1671`：Claude（正/侧）、DeepSeek 侧、Kimi 侧
  - `1024×1536`：GLM（正/侧）、Gemini 正、Kimi 正、Muse（正/侧）、Mimo（正/侧）
- **油墨颜色**：浅色文件油墨为**纯黑**（非透明像素亮度 max = 0.0）；深色文件为**纯白**（min = 255.0）。即两者都是单色线稿。
- **留白**：油墨包围盒左右内缩差异很大（多数 0.7%–7.3%，但 Mimo 正视左右各内缩约 22%、Muse 侧视左侧 19.5%），包围盒与内缩比例已逐图记录在 JSON 中，供 P1／P3 的缩放与锚点参数使用。

### 关键发现：深色素材是浅色素材的油墨反相，不是独立绘制的另一套图

对全部 20 组「同一角色 + 同一视角」的浅／深配对做逐像素交叉校验：

| 判据 | 结果 |
| --- | --- |
| 尺寸一致 | 20 / 20 |
| **alpha 掩码逐字节完全相同** | **20 / 20** |
| 文件内容哈希相同（即同图复制） | 0 / 20（确为两份不同文件） |
| 在所有油墨像素上互为 255 补数 | **20 / 20** |
| 油墨包围盒一致 | 20 / 20 |

即：每个深色文件与对应浅色文件**画的是同一张线稿**，几何（alpha 掩码、包围盒、尺寸）完全一致，只有油墨极性由纯黑翻为纯白。这也解释了为何 `-dark-lineart.png` 与 `-lineart.png` 的透明比例、笔触分布逐位相同。

**用户已于 2026-10-02 确认这是有意设计，不是素材缺陷。** 用户说明：这些透明底线稿要贴在网页两侧，浅色底的网页必须用黑墨才看得清，深色底反之亦然。因此同一张画稿本来就需要黑、白两个极性版本，不需要另行补画深色专稿。

按契约第 8 条，页面必须直接使用用户 `dark/` 目录里的文件，**不得由代码自动反色生成**；本轮只是履行「逐张核对图像内容」的义务并如实记录。本记录不代表角色造型或配色已被修改。

补充推论（对后续阶段有利）：既然浅／深几何完全一致，显示参数（缩放／锚点／基线）按「角色 × 视角」只需一套即可同时套用两个模式——P3 的逐图调参量减半，且切换明暗时人物不会位移或跳变，天然满足「切换不得有几何跳变」的验收要求。

### 正／侧视目视核对

`baseline/contact-sheet-light.png` 与 `contact-sheet-dark.png` 为 20 格带标签拼版（棋盘底衬，浅深各一张），已逐格目视核对：

- 所有 `-lineart.png`（front 槽位）均为**正面朝向观者**。
- 所有 `-side-lineart.png`（side 槽位）均为**侧身／侧转**。
- 十套角色的正／侧视与文件名规则**全部对应正确**，未发现错位、缺图或以另一视角顶替的情况。
- 深色拼版确认是同一批画稿的白墨版本。

## 4. 环境与重跑

- 浏览器：Microsoft Edge **154.0.4258.37**（`chromium.launch({ executablePath: <Edge>, headless: true })`，绝不连接个人浏览器会话）。
- Playwright 模块来源：`<repo>/node_modules/playwright/index.mjs`（未命中）→ `~/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs`（命中）。可用 `AGENT_USAGE_PLAYWRIGHT_MODULE` 覆盖；浏览器可用 `AGENT_USAGE_EDGE_PATH` 覆盖。
- 重跑命令：

```powershell
node docs/validation/2026-10-02-model-character-skins/baseline-audit.mjs
node docs/validation/2026-10-02-model-character-skins/baseline-audit.mjs --compare
& "<bundled python>" docs/validation/2026-10-02-model-character-skins/source-image-manifest.py
```

- `audit` 模式写 `baseline/geometry.json` 与 `baseline/screenshots/`；`--compare` 写 `baseline/compare-latest.json`，**不覆盖**基线数据；任一所测元素取不到即判该档失败并非 0 退出，不静默写 null 当通过。

## 5. 产物

| 路径 | 内容 |
| --- | --- |
| `baseline-audit.mjs` | P0.2 采集／比对脚本 |
| `source-image-manifest.py` | P0.3 源图清单脚本 |
| `compression-comparison.py` | P1 体积／保真对照脚本（决策支持） |
| `baseline/geometry.json` | 28 档几何／样式基线（206 KB） |
| `baseline/compare-latest.json` | 复现比对结果（passed: true） |
| `baseline/screenshots/` | 34 张截图（28 视口 + 6 整页） |
| `baseline/source-images.json` | 40 张源图清单（67 KB） |
| `baseline/compression-comparison.json` | 40 张 × 6 压缩方案的实测结果 |
| `baseline/compression-comparison.png` | 原始 vs 压缩的可视对照（显示高度 + 1:1） |
| `baseline/compression-look.png` | 像素级证据图（4× 放大、×20 差异图、页面底色 50% 渲染） |
| `baseline/contact-sheet-light.png`、`contact-sheet-dark.png` | 正／侧视目视核对拼版 |

## 6. 素材体积与压缩对照（P1 决策支持）

用户要求先看「同一张图原始 vs 压缩」的对照再决定离线导出体积策略。脚本 `compression-comparison.py` 对**全部 40 张**源图实测，产物 `baseline/compression-comparison.json` 与可视对照 `baseline/compression-comparison.png`（左列原始、右列各方案；上排为接近页面实际显示高度，下排为 1:1 局部）。

先决条件已验证：40 张全部满足 **R == G == B（逐像素）**，即都是单色墨 + alpha，因此可无损转为灰度+alpha。

| 方案 | 40 张合计 | 占原始 | base64 后 | 预计导出单文件 | 保真结论 |
| --- | --- | --- | --- | --- | --- |
| 原样（现状） | 31.84 MB | 99.8% | 42.5 MB | **71.0 MB** | 逐字节相同 |
| LA 无损（灰度+alpha PNG） | 26.14 MB | 81.9% | 34.8 MB | **63.4 MB** | **逐字节相同**（已验证像素完全一致） |
| WebP 无损 | 18.46 MB | 57.9% | 24.6 MB | **53.2 MB** | 可见像素完全一致；仅全透明像素的 RGB 不保留（不可见） |
| LA 75% | 16.23 MB | 50.9% | 21.6 MB | 50.2 MB | 线条改变：alpha 最大差 133、RGB 最大差 255 |
| LA 50% | 7.93 MB | 24.8% | 10.6 MB | 39.1 MB | 线条改变：alpha 最大差 193 |
| WebP q90 @50% | 5.82 MB | 18.2% | 7.8 MB | 36.3 MB | 线条改变：alpha 最大差 193 |

参照：现有 `dist/codex-usage.html` 为 28.54 MB。

**保真判据**：同时比较 alpha 与 RGB，且 RGB 只在「任一图中该像素有油墨」处计入——只查 alpha 会把颜色偏移的笔画误判为相同。

**全量验证结论（40 张逐一实测）**：

- `LA 无损`：**逐字节相同**（`byteIdentical = True`）。
- `WebP 无损`：`byteIdentical = False`，但 `maxAlphaDelta = 0`、`maxVisibleRgbDelta = 0`，即**在全部可见像素上零差异**；差异仅存在于完全透明像素的 RGB，不参与渲染。

像素级证据图 `baseline/compression-look.png`：列为 A 原始 PNG／B LA 无损／C WebP 无损；行 1 整图、行 2 **4× 最近邻放大**（眼与发丝，最近邻不插值，任何像素变化都会显形）、行 3 **×20 增强差异图**（取自真实 50% 透明度下的页面渲染）、行 4 浅色页面底 `rgb(207,216,225)` 上的 50% 渲染、行 5 深色页面底 `rgb(32,37,43)` 上的 50% 渲染。**行 2 三列逐像素一致，行 3 三列全黑**——即 LA 与 WebP 无损在像素层面没有可展示的差别，两者之争纯粹是体积与格式，不是画质。

**顺带记录的观感事实**：浅色底、50% 透明度下黑色线稿偏淡（行 4），深色底、50% 下白墨更清晰（行 5）。这是用户指定 50% 默认值的直接结果，弹窗已按契约提供百分比调节，故不构成问题，仅作为后续调透明度时的参照。

**用户决定（2026-10-02，最终）**：页面实际加载的公开副本**只用 WebP 无损，public 中不出现 PNG**。此前我一度把「LA 无损 + WebP 无损」当作叠加方案并报出 53.2 MB，这是错的——二者是互斥编码，灰度+alpha 只是 WebP 编码前的中间表示，不产生独立的 PNG 产物；WebP 无损的实际产物体积是 **18.46 MB**。用户就此提出质疑（"如果能直接用 webp，为什么还要带 png"），该质疑正确。

已据此更新实施契约：「3.4 显示副本的编码决策」记录无损变换语义、只补 `image/webp` MIME（不需要 `image/png`，因为页面不加载 PNG）、生成与校验分离、以及不采纳缩尺寸方案。`skins:check` 的校验语义为「声明的变换(源) == 副本哈希」。

**源图与发布格式的关系**：`lineart assets/**` 永远是原始 PNG，只作「源」；WebP 是唯一发布格式。二者不是并存关系，页面 `<img>` 不会加载任何 PNG。

## 7. P1 实现验证（2026-10-02）

### 7.1 交付物

| 路径 | 内容 |
| --- | --- |
| `public/skins.js` | 纯注册表：11 id、40 资源 URL、40 源资产描述、偏好归一化；深度冻结，无 DOM／storage 访问 |
| `scripts/prepare-skin-assets.mjs` | `prepare`／`check` 两个子命令 |
| `public/skin-assets.json` | 40 条源／副本双哈希清单（由 `prepare` 生成） |
| `public/skin-bootstrap.js` | 由注册表派生的同步首屏脚本（生成物，不入 format 检查） |
| `public/skins.css` | 装饰层样式（`#skinCharacters`） |
| `public/assets/skins/{light,dark}/` | 40 个 WebP 无损副本，18.46 MB |
| `test/skins.test.js` | 18 项回归 |

### 7.2 命令结果（全部实测）

| 命令 | 结果 |
| --- | --- |
| `npm.cmd test` | **341 / 341 通过**（323 原有 + 18 新增） |
| `npm.cmd run typecheck` | 通过 |
| `npm.cmd run lint` | 41 warnings，与 HEAD 基线**完全相同**（我的文件零新增警告） |
| `npm.cmd run format:check` | 52 files，通过 |
| `npm.cmd run skins:check` | `PASS (40 assets, 40 URLs, manifest and bootstrap fresh)` |
| `baseline-audit.mjs --compare` | 28 档**零差异**（bootstrap + skins.css 未改变任何布局） |

### 7.3 `skins:check` 是有效校验（负向实测）

在隔离临时副本上验证它**真的会失败**，不是"永远通过"：

| 破坏 | 结果 |
| --- | --- |
| 篡改任一 public 副本字节 | FAIL：`public copy does not match the recorded hash` |
| 修改任一源图字节 | FAIL：`source changed since the copies were generated ... re-run generate-skin-webp.py then skins:prepare` |
| 删除任一副本 | FAIL：`missing public copy` |
| 手工编辑 bootstrap | FAIL：`skin-bootstrap.js is stale; run skins:prepare` |
| 基线（无破坏） | PASS |

### 7.4 离线自包含验证（`file://` 禁网）

`offline-skin-audit.mjs`，5 项检查全部通过：

- 40 个资源以 `data:image/webp;base64,` 内联
- **40 个资源全部经浏览器真实解码**（合计 62,918,744 像素），非仅统计字符串
- 首屏 bootstrap 在绘制前应用经典默认（`data-skin=classic`、`data-skin-bootstrap=1`）
- 零外部请求、零 page error、零 console error
- 无残留可加载的兄弟资源引用（`src`／`href` 标签属性为 0）

实测导出：`dist/codex-usage.html` **56.90 MB**（原 28.54 MB + 40 图 base64 约 24.6 MB），40 个 `data:image/webp` 引用，0 个外部引用。

### 7.5 已接受的限制与已修正项

1. **生成与校验分离**（用户已确认接受）：Node 无内置图像编码器，`skins:prepare` 不重新编码图片；源图变更需重跑一次性生成器 `generate-skin-webp.py`，`skins:check` 会明确失败并提示该命令。
2. `public/skin-bootstrap.js` 是生成物，已在 `biome.json` 中排除 `format:check`（生成内容由 `prepare` 保证，`check` 比对精确文本）。
3. 注册表改为**深度冻结**：开发过程中发现嵌套 `variants.light.palette` 原本可被赋值（`Object.freeze` 只冻结顶层），已修复并加回归锁定。
4. `public/skin-ui.js` 尚未创建，属 P2 交付物。

## 9. P2 实现验证（进行中）

### 9.1 P2.1 装饰层与加载（已完成）

`p2-decoration-audit.mjs`，6 项检查全部通过：

- 装饰层在 `.shell` 之外、`position: fixed`、`pointer-events: none`、`aria-hidden="true"`
- 默认无皮肤，且**零图片请求**
- 选中一个角色时恰好只加载当前模式的 2 个文件，且都解码出真实尺寸
- 显示／隐藏角色不移动 `.shell`／`.topbar`，无横向溢出
- opacity 只作用于装饰层，`opacity: 0` 被保留（未被默认值覆盖）
- 零 page error

`baseline-audit.mjs --compare --skins` 在**角色可见**状态下复跑 28 档：`PASS no mismatches within tolerance`。

### 9.2 P2.2a 入口按钮（已完成）

`p2-entry-button-audit.mjs`，4 项检查通过：7 宽度 × 2 主题下，`#skinToggle` 与 `#languageToggle`／`#themeToggle` 的**尺寸逐项相同**（≥768px 为 64×38，390px 为 60×38），背景、圆角、阴影、边框色与左邻按钮**完全一致**；无可见文字；紧邻 `#languageToggle` 左侧；无二轴碰撞；无横向溢出。

**390px 换行 —— 用户裁定接受（2026-10-02）**。此前实测第三个按钮使 `.topbar-actions` 由 128px 增至 196px，与 188px 标题在 370px 容器内无法同排，flex 换行。我按实施计划 4.2 将其**列为未满足约束如实上报**，未缩标题、未缩原按钮、未改主框体、未挪入口。用户随后裁定**接受换行**，接受后的实测布局：

| 项目 | 值 |
| --- | --- |
| 标题 | y 45–68（第一行） |
| 按钮组 | y 74–112（第二行），同一行内 |
| 按钮顺序／尺寸 | 皮肤 → 文/A → 主题，各 60×38 |
| 横向溢出 | 0 |

该裁定已写入实施计划 4.2，并由审计固化：**≥768px 必须同排，390px 必须换行且三按钮保持同一行**。审计经负向验证（反转期望立即失败并报 `NEGATIVE TEST forcing same-row at 390`），确认断言真实生效而非空跑。

### 9.3 P2.2b／P2.2c 独立弹窗（已完成）

`p2-picker-audit.mjs`，11 项全部通过：`#skinDialog` 为 BODY 级同级元素（**不嵌套**在来源／计价弹窗内），`role="dialog"`／`aria-modal="true"`／`aria-labelledby` 与标题 id 一致；入口按钮打开并同步 `aria-expanded`，焦点落到已选卡片；11 个选项全部渲染；选择角色不移动 `.shell`／`.topbar`；透明度滑杆驱动装饰层且 `0%` 保留；「恢复 50%」与「恢复无皮肤」均生效；Escape 关闭并把焦点还给 `#skinToggle`；遮罩点击关闭、内容点击不关闭；Tab 焦点留在弹窗内；`#importDialog`／`#pricingDialog` 未受影响；零 page error。

### 9.4 P2.4 无皮肤选项（已完成）

同一份审计断言：无皮肤卡片存在于 11 个选项中、默认 `aria-checked="true"`、有显示名称、有条目说明文字（`无皮肤`）而非空白色块或破图、且**不加载任何图片**；「恢复无皮肤」可随时切回。

矩阵响应式：桌面 5 列、≤1024px 3 列、≤720px 2 列。无皮肤是首卡，任何断点都无需滚动或搜索即可选中，**小屏同样保留**。

### 9.5 布局影响复核

`baseline-audit.mjs --compare` 的差异经分类后：

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| 按钮行 `.topbar-actions` 等 | 100 | 预期内：新增第三个按钮使宽度 138→212 |
| 390px 整体下移 | 160 | 390px 换行，**已由用户裁定接受** |
| 390px 其他（标题位移） | 8 | 同一 390px 换行 |
| **390px 与按钮行之外的差异** | **0** | **弹窗与装饰层对 ≥768px 布局零影响** |

> **2026-10-02 复检更正**：上表的拆分与逐键统计不一致。按 `compare-latest.json` 逐键重算，268 处差异实际为 `.topbar-actions` **68** + 390px 各选择器位移 **200**，且**差异集合在带与不带 `--skins` 时完全相同**（`onlyWithSkins = 0`）——"人物层与弹窗对布局零影响"这一结论成立，但 390px 之外的按钮行拆分数字应为 68/200，不是 100/160/8。详见第 10.1 节。

### 9.6 离线资产解析缺陷（已修复，P2 期间发现）

**缺陷**：弹窗与装饰层最初把注册表的 `/assets/skins/...` URL 直接写入 `<img src>`。在线可用，但**离线单文件快照会在自身旁边请求不存在的兄弟文件**，导致离线皮肤贴图全部加载失败。

**发现方式**：把 `offline-skin-audit.mjs` 从「扫描原始 HTML 文本」改为「检查真实 DOM 中解析后的 `src`」。旧检查是假阳性来源——它会匹配到模块源码里的 `src="${url}"` 模板字符串字面量，既漏掉真缺陷、又误报无害文本。

**修复**：`skin-ui.js` 新增单一解析点 `resolveAssetUrl()`，存在 `window.__CODEX_USAGE_SKIN_ASSETS__`（导出快照内联的 40 个 data URL）时走内联映射，否则用真实路径；`urlsFor()` 两个视角都经过它，弹窗和装饰层共用同一来源。

**回归**：`test/skins.test.js` 新增断言，检查 `urlsFor` **确实调用**了解析函数，而不只是「函数存在」。负向验证：把 `resolveAssetUrl(...)` 改回裸字段 → 失败并报 `urlsFor must resolve the side view`；改回 → 通过。

**修复后离线实测**：7 项检查通过，含新增的两项——离线弹窗渲染全部 11 个选项且贴图解析为 `data:image/webp;base64,`；离线角色两视角均从内联资产解码成功，全程零外部请求。

### 9.7 P2.3 浅深双组卡片矩阵（已完成）

`p2-matrix-audit.mjs`，**28 项通过**，浅色页与深色页各跑一遍。

**核心要求——局部模式独立**：在深色页上，浅色 preview 仍取到真正的浅色基底 `rgb(207,216,225)` 与深色墨 `#23313c`；深色 preview 取 `rgb(32,37,43)` 与浅色墨 `#edf3f7`。两模式基底与墨色互不继承。截图 `p2-shots/matrix-dark-page.png` 直观可见：整页深色时，左侧仍为浅色单元。

**实现方式（零复制）**：将 `styles.css` 中 6 个**仅含变量声明**的基底块 selector 扩展为
`:root, .skin-preview-scope[data-preview-theme="light"]` 与
`[data-theme="dark"], .skin-preview-scope[data-preview-theme="dark"]`。
全局与局部**共用同一批声明，未复制任何色值**；组件规则一律未动。实测 31 个 token 中 29 个随模式变化，scoping 全覆盖。

**其余断言**：十套角色左右预览各用对应模式素材、固定 50% 参考透明度；全部卡片共用同一微型模板；配色未指定时逐模式标注「浅色／深色 配色待定」；注入 fixture 验证颜色隔离（不影响同卡另一模式、不影响其他皮肤、不重绘页面），**fixture 不写入真实注册表**。

**矩阵与可见性**：桌面 5 列 **5+5+1**，无皮肤紧凑卡占余格。无皮肤**排首位**，1920／1440／1280／1024／900／768／600／390 全部宽度**无需滚动即可见**。

**弹窗高度**：1920／1440／1280／768 均**无内部滚动**（`scrollHeight == clientHeight`）。为达成此点依契约允许的"缩减缩略图与微型示例细节"添加末尾媒体查询，**只改弹窗自身内容，不动页面后方看板**。

**过程中发现并修正的两个真实缺陷**：
1. 响应式覆盖最初写在基础规则**之前**，同特异性被覆盖而**完全失效**（实测卡片仍 192px）。已移至文件末尾并注明原因。
2. 我曾把无皮肤改排到末尾，审计立即报出 1024／900／600／390 需滚动 222px 才可见，**违反"不藏在末尾需滚动处"**；已改回首卡。

**仍未达成**：1024×768 溢出约 55px；600／390 的 2 列布局最后一排需内部滚动。这些档位所有选项仍可达且无皮肤始终可见，但"11 项全部首屏同屏"未满足，不宣称通过。

## 8. 未完成与未测范围

1. **P2 已完成**：P2.1／P2.2／P2.3／P2.4 全部勾选，证据见第 9 节。**未达成项**：1024×768 与窄屏弹窗需内部滚动（见 9.7）。
2. **P3 已完成（2026-10-02 复检并修复后重跑）**：十套角色两种模式的四资源与逐图显示参数已接入，见第 10 节。复检发现并修复了逐图参数转录错误（5/20 项）与两处切换／恢复缺陷；本行此前写"P3 未开始"，是第 3 节完成时的状态，已过期。
3. **390px 已由用户裁定接受换行**：见 9.2。该行为现由审计断言固化（≥768px 同排、390px 换行）。
4. **配色全部待定**：十套 palette 仍为 `null`，等待用户逐主题、逐模式提供；本轮**未**自行推导任何颜色。
5. **未测**：真实用户数据下的皮肤弹窗、真实配色填入后的可读性、`setTheme`／`setLanguage` 联动后的弹窗重绘。
6. 本目录的截图与 JSON 为受测 revision 的产物；工作区随后若发生代码改动，需重新采集，不能沿用本轮结论。

## 10. P3 实现验证与复检修复（2026-10-02）

### 10.1 交付与实测结果

| 项 | 结果 |
| --- | --- |
| 十套角色接入 | `public/skins.js` 登记十套 × 浅深 × 正／侧共 40 个 URL；`public/assets/skins/{light,dark}/` 各 20 个 WebP |
| `p3-characters-audit.mjs` | **12 / 12**：在线恰好 40 个去重资源、模式目录正确、无皮肤无参数、绘制**墨迹高度**跨度 0.9px / 699px = 0.13% |
| `offline-skin-audit.mjs` | **8 / 8**：`file://` 断网 20 个组合、40 个内联资源真实解码、零外部请求 |
| `p3-recovery-audit.mjs`（本轮新增） | **7 / 7**：正常加载、隐藏→显示、经典→同套、浅深往返、单视角失败隔离、失败解除后重试恢复 |
| `p2-matrix-audit.mjs` | **28 / 28** |
| `p2-decoration-audit.mjs` / `p2-picker-audit.mjs` / `p2-persistence-audit.mjs` / `p2-entry-button-audit.mjs` / `p2-palette-channel-audit.mjs` | 6 / 11 / 6 / 4 / 7，全部通过 |
| `baseline-audit.mjs --compare --skins` | 268 处差异，与不带 `--skins` 的 `--compare` **键集合完全相同**（`onlyWithSkins = 0`）→ 人物层贡献 0 处布局差异；268 处全部是已由用户接受的 P2.2 第三按钮（68）与 390px 换行（200） |
| 项目检查 | `npm test` **351 / 351**；`typecheck`、`format:check`、`skins:check`（40 assets／40 URLs，生成物新鲜）、`skins:palette`（0/20 已填）、`git diff --check` 全部 exit 0；`lint` exit 0（**0 error**，41 warnings，与 HEAD 基线一致） |
| 快照 | `dist/skin-p1-check.html` 以隔离空 home 重新导出，26,243,368 bytes，40 个内联资源 |

### 10.2 复检发现并修复的缺陷

| # | 缺陷 | 修复前证据 | 修复 |
| --- | --- | --- | --- |
| 1 | 清空装饰层后再次应用**同一 URL** 不再挂 `src`，而 decode 命中缓存又把它标成 `loaded=1` → 立绘静默消失（用户点"显示角色"关再开，或"恢复无皮肤"后再选同一套即可触发） | 隐藏后显示：两图 `loaded=1, hasSrc=false, natural 0x0`；经典→同套同样 | `clearImages()` 一并 `delete dataset.url`；`apply()` 改为以"`src` 是否已挂"为准重新挂载 |
| 2 | `decode()` 把失败结果也永久缓存，一次瞬时错误在本会话内无法恢复 | 拦截正视后解除再选同一套：正视永久 `loaded=0` | 失败结果出缓存；失败时清 `dataset.url` 以便重试；`loaded=1` 只在确实持有可解码源时写入 |
| 3 | `MEASURED_INK` 5/20 项与 `ink-bounds.json` 不符（Kimi 侧视 0.995726 vs 实测 0.974267；Mimo 正视抄了侧视的 w/h；`cx` 全为 0.5 使 `anchorX` 失效） | 独立 Pillow 重测确认 `ink-bounds.json` 正确；真实绘制墨迹高度跨度 2.26% | 按实测重算 `MEASURED_INK`，`anchorX` 真正取墨迹中心 |
| 4 | 审计第 6 项量 CSS 盒高（= 由 `scale` 反推的量），结构上抓不到 #3 | 把 Kimi 侧视改回 0.995726，旧断言仍通过 | 改为 `renderedH × inkHeightFraction`，门槛 0.5% |
| 5 | `npm run lint` 退出 1（本轮皮肤代码引入） | `skins.css:43` 重复 `height`；`i18n.js:15` 重复键 `关闭` | 删除死声明与重复键 |

**负向验证**：分别还原 #1、#2 后 `p3-recovery-audit.mjs` 立即失败（报 `re-shown: side claims loaded=1 without decodable artwork`、`recovered: front must decode`）；还原 #3 后 `p3-characters-audit.mjs` 报 2.21% 失败且新增单测失败 1 项。恢复后全部重跑为绿，且 `public/skin-ui.js`、`public/skins.js` 的 SHA-256 与改动前一致。

**新增回归**：`test/skins.test.js` 增加 2 项——① 从 `ink-bounds.json` 重新推导并逐项比对每图 `scale`／`anchorX`／`inkWidth`／`inkHeight`；② 结构断言清空时删除 `dataset.url`、失败出缓存。

### 10.3 仍未达成／未测

- ~~十套 palette 仍全部为 `null`（等待用户指定）~~ 2026-10-02 起 chatgpt 已填入真实配色（见第 11 节），其余九套仍待定；整页联动未实施、未验收。
- `anchorX` 生效后窄剪影角色（Muse／Mimo／ChatGPT 侧视，最多约 46px 水平微调）的构图已按当前实现重拍 `p2-shots/char-chatgpt-light.png`、`char-mimo-light.png`、`char-muse-dark.png`（1600×900，人物仍贴边且无裁切）。
- 契约 4.4 的"1024 及以下全部 11 项首屏同屏"仍未满足（见 9.7），属 P2 遗留，本轮未改动。

## 11. 第一套真实配色接入：chatgpt（2026-10-02）

用户经配色工作台定稿并交付 ChatGPT 十二 token × 浅深两组（源四色 #52407d #607ec7 #9685c1 #B9C9EE），已原样填入 `public/skin-palettes.js`（含源四色注释，示例注释按文件要求删除）。`npm run skins:prepare` 重生成引导脚本，`"accents":{"light":"#607ec7","dark":"#738dce"}` 已烤入，首帧即正确强调色。

**校验**：`npm run skins:palette` PASS（2/20 槽位），两条可读性告警——`chatgpt.light` textSecondary 对面板底 2.98:1（临界）、`chatgpt.dark` textSecondary 对面板底 1.89:1（偏低）。颜色按用户交付原样填入，未擅自调整；如需改善可将深色面板压暗或次要文字提亮。

**实机取证**：`chatgpt-palette-live-check.mjs` 10 项全过、零 page error——①全新载入无强调色变量（classic）；②选中 chatgpt 后 `--skin-active-accent` 浅色 #607ec7／深色 #738dce、R2 滑杆链跟随；③卡片浅深色块组各 5 枚、色值逐一断言、未选九套仍诚实"配色待定"；④浅深截图。产物：`chatgpt-palette-light.png`、`chatgpt-palette-dark.png`、`chatgpt-palette-live-results.json`。

**范围说明（已知局限，归 R6）**：卡片读取的是 `skin-picker.js` 本地旧名表 `COLOUR_TOKENS`，与注册表 `PALETTE_TOKEN_KEYS` 仅 5 个 token 重合（pageBackground／panelBackground／controlBackground／accent／chartText），故卡片色块与小样当前只体现 5 个 token；其余 7 个（textPrimary／textSecondary／panelBorder／panelHighlight／panelShadow／controlBorder／controlText）待 R6 统一 token 字段后上卡。本轮按阶段授权约定未动 R6 范围。

**测试口径更新**：`test/skins.test.js` 两条"全待定"守卫（原 180/393 行）改为与填色状态无关的结构不变量——未填槽位必须诚实待定（null／pending／无 token／无系列色），已填槽位只准含白名单内非空颜色 token 且 swatch 与 token 镜像；classic 永远无色。serial 351/351 全绿。

**整页接线（palette token → 全界面 CSS 变量）尚未实施**，属填色后的既定后续工作；当前整页观感见配色工作台预览，其映射与陶瓷/阴影推导式即接线规则草案（`docs/validation/2026-10-02-palette-studio/`）。

## 12. 十套真实配色全部接入与统一验收（2026-10-02）

用户经配色工作台逐套定稿，十个角色 × 浅深共 20 个模式槽位全部填入（每套 12 token，含源四色注释），classic 按定义无槽。`npm run skins:palette` **PASS（20/20）**。

**校验告警（全部集中在 textSecondary，主文字全部 ≥3:1）**：

| 槽位 | 对比度 | 槽位 | 对比度 |
| --- | --- | --- | --- |
| chatgpt.light | 2.98:1 | chatgpt.dark | 1.89:1 |
| claude.dark | 2.55:1 | gemini.dark | 2.75:1 |
| deepseek.light | 2.77:1 | deepseek.dark | 2.60:1 |
| qwen.dark | 2.73:1 | mimo.dark | 2.62:1 |

均为告警非错误，颜色按用户交付原样填入；如需改善，优先压暗深色模式面板底（六个 dark 告警同源）。

**引导脚本**：`npm run skins:prepare` 重烤，十套 accent 逐一核对烤入（如 claude `#d26e46`/`#d77f5c`、grok `#f7e25f`/`#f8e572`），classic 保持 null；`skins:check` PASS。

**实机审计**：`palette-all-skins-live-check.mjs` **54 项全过、零 page error、离线零外部请求**——①浅色通道十套逐一选中，`--skin-active-accent` 与各自 palette accent 全等，主界面几何二十次深比较零位移；②切深色后同样十套全过；③选择器十卡全部双组色块（各 5 枚 picker 映射 token）、零"配色待定"；④离线快照（file:// 禁外网）claude/light 与 grok/dark accent 正确——导出链路完整内联配色。产物：`all-skins-picker-{light,dark}.png`、`all-skins-page-deepseek-{light,dark}.png`、`palette-all-skins-results.json`。

**测试口径**：`test/skins.test.js` "输入通道"测试中过期的"20 槽全待定"计数断言删除（结构守卫由两条不变量测试承担），serial **351/351 全绿**；lint 41 警告=基线、format/typecheck/skins:check 全清。

**边界与下一步**：当前生效范围 = 强调色链（R2，含首帧预绘制）+ 比较卡片色块/小样（5 个 picker 映射 token，统一属 R6）+ 离线快照。**整页接线（palette token → 全界面 CSS 变量，几何不变）尚未实施**；接线映射与陶瓷/阴影推导式草案见配色工作台（`docs/validation/2026-10-02-palette-studio/`）。

## 13. 整页配色接线：实施与验收（2026-10-02）

**实施**（用户指令"开始，做得小心点，认真点"）：

- **单一来源推导**：`public/skins.js` 新增纯函数 `paletteDeclarations(skinId, mode)`（Node/浏览器同构）——从用户 12 token 推导 19 个**根源** CSS 变量（`--bg`、`--neo-surface`、`--neo-edge`、`--line`、`--chart-line`、`--ink`、`--muted`、`--chart-text`、`--control-hover`、`--blue`、`--record`、`--skin-active-accent`、`--active-ink` + 6 个陶瓷变量），导出固定名单 `PALETTE_CSS_VAR_NAMES`。`--panel/--control/--track/--shadow` 沿样式表既有间接引用自动跟随，**阴影配方零改动**（配方引用陶瓷变量自动变色）——几何安全是结构性的：全部衍生值皆为颜色，无任何尺寸/几何字符串。
- **运行时**：`skin-ui.js apply()` 先按 `PALETTE_CSS_VAR_NAMES` 全量移除、再设置当前皮肤/模式的声明——部分配色、模式切换、回 classic 都不会残留上一套颜色（accent 语义与 R2 完全一致）。`app.js` 的 runtime `onChange` 在 `previousSkinId !== skinId` 时触发一次 `render()`（canvas 图表绘制时取 `getComputedStyle`，选肤后立即重绘；拖透明度不重绘）。
- **首帧防闪**：`scripts/prepare-skin-assets.mjs` 生成 bootstrap 时烘焙各套声明（CONFIG.palette + paletteVarNames），预绘制阶段即设全量变量——首页第一帧就是皮肤配色。
- **工作台兼容**：`skin-palette-studio.js` 的候选值重申从单一 accent 扩展到全量内联（observer 守护），接线后仍可试色（31 项审计复过）。

**验收**（`palette-all-skins-live-check.mjs`，**496 项全过、零 page error、离线零外部请求**）：

1. 十套 × 浅深：`<html>` 上 19 个变量逐一等于推导值；`document.body` 计算背景色 = 各自 pageBackground（消费验证，非仅存在）。
2. 二十次选肤主界面几何深比较零位移；R3（49 状态）与 R5（9 状态）复跑全过。
3. classic 清理：切回无皮肤后 19 个内联变量全部移除，body 底色回到主题基底 `rgb(207, 216, 225)`。
4. 弹窗小样隔离：`.skin-preview-scope` 内 `--bg` 保持样式表基底（#cfd8e1），页面配色不泄入。
5. 离线快照（file:// 禁外网）：claude/light 与 grok/dark 全量接线成立。
6. R4 审计（21 状态）复过——chatgpt 恢复用例的期望值改从 `paletteDeclarations` 取（accent 与陶瓷井），与新契约一致；R5 选中卡边缘期望同步更新为肤色 accent。

**设计裁定（记录在案）**：`--record` 随 accent（最终级联本就令 record≡blue，保持单一强调色设计）；`--chart-line` 取 `mix(panel, textPrimary, 0.35)`（textPrimary 随模式翻转，两种模式下都落在底与字之间）；`--control-hover` 浅色向 shadow 混、深色向 highlight 混（贴合默认主题的明暗方向）；`--green/--gold/--red/--dialog-shadow` 保持主题默认；图表系列色待用户按需提供 `chartSeries`。

**回归**：serial **352/352**（新增接线结构测试 1 条）；lint 41 警告=基线；format/typecheck/skins:check/skins:palette 全清。产物：`all-skins-page-deepseek-{light,dark}.png`（整页染色实拍）、`palette-all-skins-results.json`。
