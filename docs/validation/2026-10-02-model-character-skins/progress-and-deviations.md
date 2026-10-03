# 模型角色皮肤：进度与偏差报告

日期：2026-10-02（Asia/Shanghai）。用途：用户要求暂停施工，先审阅已完成范围、已偏离契约之处与遗留缺口。

基线：HEAD `0042e18`，分支 `main`。施工契约见 [Implementation Plan](../../plans/2026-10-02-model-character-skin-implementation-plan.md)，逐项状态唯一维护在 [TODOs](../../plans/2026-10-01-model-character-skin-todos.md)，P0 证据见 [P0 基线](2026-10-02-model-character-skins/README.md)。

---

## 1. 一句话结论

**P0 已完整完成并有证据；P1 只完成了一部分（纯注册表 + 40 个 WebP 副本），P1 的脚本、bootstrap、MIME、测试与导出接入均未做。** 期间按用户决定改动了契约本身的三处措辞，并发现一个契约承诺**技术上无法实现**的能力缺口（见第 5 节）。

---

## 2. 本轮会话实际做了什么

用户本次的三项前置指令均已完成：

1. **确认计划理解**：通读三份文档并复述契约，未碰代码。
2. **环境恢复**：沙箱从 `workspace-write` 放宽到 `danger-full-access` 后，`pwsh` 恢复正常（PowerShell 7.6.6、Node v24.19.0、npm 11.17.0）。
3. **删除更早一轮痕迹**：删除 `docs/validation/2026-10-02-model-character-skins/`（该轮 pwsh 被沙箱拒绝，只留下带 `<unavailable>` 占位的 README、从未运行过的脚本与探针文件）。规格文档按用户选择保留；早于保存点的杂物（`.archify/`、`.zcode/`、`.dsh-probe.mjs`、根临时截图、浏览器 profile）按用户选择不清理、仅记录。

---

## 3. 已完成的工作与证据

### 3.1 P0（全部完成，TODOs 已勾选）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| P0.1 工作区基线 | HEAD、`git status --short` 原文、约定文档、无 `AGENTS.md`、环境版本 | 证据 README 第 1 节 |
| P0.2 经典外观基线 | 28 档（7 宽度 × 浅深 × 中英）全部采集，pageErrors／consoleErrors／externalRequests 均为 0；34 张截图 | `baseline/geometry.json`、`baseline/screenshots/` |
| P0.2 复现门槛 | `--compare` 重跑 **零差异**（`mismatches: []`，容差未被使用），exit 0 | `baseline/compare-latest.json` |
| P0.3 源图清单 | 40/40 齐全；全 RGBA、确有透明（42%–76%）、三种尺寸；逐张 SHA-256 与氢基包围盒 | `baseline/source-images.json` |
| P0.3 视角核对 | 20 格拼版逐格目视：`-lineart.png` 全为正面、`-side-lineart.png` 全为侧身 | `baseline/contact-sheet-{light,dark}.png` |

经典外观关键不变量（后续皮肤不得改变）：`.shell` 宽 1440（≥1680）／1408（1440）／1248（1280）／992（1024）／736（768）／370（390）；工具栏在 ≤1024 折为 3 行；metrics 列数 6/6/6/6/6/2/1；按钮 64×38，390px 为 60×38；所有档位横向溢出 0。

### 3.2 素材编码决策（用户三次决策，已全部落进契约）

用户先后确认：深色素材的"反相"是**有意设计**（透明底线稿贴两侧，浅底需黑墨、深底需白墨）；发布格式**只用 WebP 无损，public 中不出现 PNG**。

全量实测（40 张，见证据 README 第 6 节）：

| 方案 | 40 张合计 | 保真 |
| --- | --- | --- |
| 原始 PNG | 31.84 MB | 基准 |
| LA-PNG（灰度+alpha） | 26.14 MB | 逐字节相同 |
| **WebP 无损（已采用）** | **18.46 MB** | 可见像素零差异（`maxAlphaDelta = 0`、`maxVisibleRgbDelta = 0`） |
| LA 75% / 50% | 16.23 / 7.93 MB | 线条真实改变，未采纳 |

像素级证据图 `baseline/compression-look.png`：4× 最近邻放大与 ×20 增强差异图均无可展示差异。

### 3.3 P1 已完成部分

| 产物 | 状态 |
| --- | --- |
| `public/skins.js` | ✅ 纯注册表：11 id、40 资源 URL（全唯一）、40 源资产描述、偏好归一化 |
| `public/assets/skins/{light,dark}/` | ✅ 各 20 个 `.webp`，共 18.46 MB，文件头 `RIFF....WEBP` |
| `public/skin-assets.json` | ✅ 40 条源／副本双哈希清单 + 逐张保真结论 |
| `npm.cmd test` | ✅ 323/323 通过，未破坏既有行为 |

`normalizeSkinPreference` 已验证：坏 JSON、未知 version、未知 id 均回退 classic；**`opacity: 0` 正确保留**（未使用 `value || 0.5`）；越界钳制到 0—1。

---

## 4. P1 未完成部分

契约第 2 节与第 6 节列出的 P1 交付物中，以下**均未开始**：

- `scripts/prepare-skin-assets.mjs`（`skins:prepare`）
- `skins:check` 只读校验（副本哈希、陈旧生成物、扩展名一致、40 URL 齐全）
- `public/skin-bootstrap.js`（同步首屏脚本，由注册表派生）
- `src/server.js` 的 `image/webp` MIME
- `test/skins.test.js` 及 server／export 的资源回归
- `src/static-export.js` 接入（内联 skins、bootstrap、40 资源映射与自包含断言）
- `package.json` 新增 `skins:prepare`／`skins:check` 命令

对应 TODOs 的 **P1.1／P1.2／P1.3 全部未勾选**。P2、P3、P4 完全未开始（无 `skin-ui.js`、`skins.css`、衣服按钮、皮肤弹窗、人物装饰层）。

---

## 5. 偏差与缺口（需要用户注意）

### 5.1 契约承诺无法实现：`skins:prepare` 不能重新生成 WebP ⚠️

**这是本轮发现的最重要问题。**

契约要求准备脚本「使用 Node 内置 fs/path，**不依赖第三方包**」，同时又要求「调整源图后运行准备命令」重新生成副本。但实测：

- **Node 没有内置图像编码器**：`globalThis` 无任何 Image／Canvas 类；`node_modules` 中 `canvas`／`sharp`／`playwright` 均不存在。
- 因此 Node 既不能编码 WebP（也不能实际编码 PNG）。手写 PNG 编码不现实。

**后果**：`skins:prepare` 的真实能力上限是「派生清单 + 生成 bootstrap + 校验哈希」，而**源图一旦变更必须回头跑开发侧 Python 生成器**（`generate-skin-webp.py`）。契约「改源图 → 跑准备命令 → 副本更新」这条链路**不成立**。

我已在契约 3.4 第 6 条如实写明此分工，但这属于**能力缺口**，不应被当作"已实现"。需要用户决定是否接受（或允许新增开发依赖以打通闭环）。

### 5.2 我改动了契约本身（三处措辞）

Implementation Plan 是**未跟踪文件**（更早一轮新建、从未提交），因此这些改动不会出现在 `git diff` 中。改动内容：

1. **新增 3.4 节「显示副本的编码决策」**——记录用户决策、无损变换语义、只用 `image/webp`、不采纳缩尺寸方案、生成／校验分工。
2. **P1.2 措辞**：「原样生成 public PNG 副本」→「交付 public WebP 无损副本（一次性生成并提交）」。
3. **哈希校验语义**：「源字节 == 副本字节」→「声明的变换(源) == 副本哈希」。
4. **资源 URL 扩展名**：注册表示例与映射规则由 `.png` 改为 `.webp`。
5. **MIME**：「补 `image/png`」→「补 `image/webp`（页面不加载 PNG，故不需要 `image/png`）」。

TODOs 的 P1.2 两行也同步改写。这些改动均**源自用户的明确决定**，但属于修改规格文件，应由用户确认。

### 5.3 我此前的表述错误（已更正）

- 我曾把「LA 无损 + WebP 无损」当作**叠加**方案，报出 53.2 MB。这是错的：二者是**互斥编码**，WebP 无损的实际产物是 **18.46 MB**。用户就此提出质疑（"如果能直接用 webp，为什么还要带 png"），该质疑正确。
- 真正的发布形态：**源图始终是 PNG（只读）；页面只加载 WebP；不存在 PNG 副本**。

### 5.4 其他记录

- 浅色底 50% 透明度下黑线稿偏淡、深色底白墨更清晰——这是用户指定 50% 默认值的必然结果，弹窗有百分比调节，不构成缺陷，仅作后续调参参照。
- 素材体积与编码只影响交付体积，不改变显示参数、图层与布局契约。

---

## 6. 工作区状态

**未提交、未 commit。** 本轮新增／修改：

| 路径 | 类型 | 说明 |
| --- | --- | --- |
| `public/skins.js` | 新增（未跟踪） | 纯注册表模块 |
| `public/skin-assets.json` | 新增（未跟踪） | 40 条哈希清单 |
| `public/assets/skins/{light,dark}/` | 新增（未跟踪） | 40 个 WebP，18.46 MB |
| `docs/validation/2026-10-02-model-character-skins/` | 新增（未跟踪） | P0 证据 + 三份脚本 |
| `docs/plans/2026-10-01-model-character-skin-todos.md` | 修改（已跟踪） | 勾选 P0 三项、补证据链接、改写 P1.2 |
| `docs/plans/2026-10-02-model-character-skin-implementation-plan.md` | 新增（未跟踪） | 含我的 3.4 节与措辞改动 |

`src/`、`test/`、`package.json` **零改动**；`lineart assets/` 源图**未改动**（仅只读分析）。

---

## 7. 建议的下一步（待用户选择）

1. **确认契约改动**：接受 5.2 的改写，或回退到原始"原样 PNG 副本"措辞。
2. **就 5.1 的缺口作出决定**：接受"生成与校验分离"（源图变更需手工跑生成器），或允许新增开发依赖打通闭环。
3. 之后继续 P1 剩余部分（脚本、bootstrap、MIME、测试、导出接入），再做 P2 人物／入口／弹窗。
