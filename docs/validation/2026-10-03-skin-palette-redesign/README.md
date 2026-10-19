# 皮肤配色重设计 — 运行记录（runId 20261003T185748）

**D8u7 恢复诊断已交复核，状态 `NEEDS_REVIEW`（2026-10-13）**：Edge 在逐属性值/priority 已回原值时，仍可能把原本缺失的 `style` 属性留下为 `style=""`。隔离 probe 证明，CSSOM 删除最后一个声明后先读 `hasAttribute/getAttribute` 再删除，可清掉这条空属性；但有限修正尝试仍未通过 D2b3 真实输入框，因此未保留未经验证的生产修复。D2b3 测试快照现明确对比 style 属性存在性；当前源码与 D8u7 起始 SHA 一致。M3.2 九个子例在最后一轮试验中通过，D2b3 仍失败；E1c/E1d 与 D8m/D8p/D8q1/D8u6 边界 20/20。详见 [D8u7 handoff](20261003T185748/handoffs/M5.2.C-D8u7-restoration.md)、[summary](20261003T185748/integration/m52-c-d8u7-restoration/summary.json) 和 [evidence index](20261003T185748/integration/m52-c-d8u7-restoration/evidence-index.json)。

**D8t 已由主管接受（2026-10-13）**：142 条 gap 与 D4 分类计数一致，日期更正采用 descriptor 的 `1860-01-01T00:00:00.000Z`；正式评审缺少 base 普通状态与 S8 variant 的固定绑定契约。原始账本及修正证据见 [D8t handoff](20261003T185748/handoffs/M5.2.C-D8t-gap-settlement.md) 和对应 integration 目录。

**D8u1 实现完成，待复核（2026-10-13）**：`capture.mjs` 现提供纯固定映射构造/断言，S8 绑定 warning fixture，其余矩阵组（含 S0/D）绑定 base；定向测试 6/6、语法与两文件 Biome 检查通过。当前 `NEEDS_REVIEW`，未启动双 preview 接线、浏览器、真实捕获、D8u2/D8u3、候选生成或 M6。详见 [D8u1 handoff](20261003T185748/handoffs/M5.2.C-D8u1-fixture-contract.md) 与 [验证记录](20261003T185748/integration/m52-c-d8u1-fixture-contract/verification.json)。

**D8s4 最新结果（2026-10-13）**：`public/timeline-utils.js` 已纳入 18 项评审依赖与 23 项捕获来源，18 个定向回归通过，当前 `NEEDS_REVIEW`。旧 22 项历史证据保持原样，按新契约报告缺源，不做自动补写。未运行浏览器/矩阵/M6；capture 元数据运行时断言待真实捕获验证。详见 [D8s4 handoff](20261003T185748/handoffs/M5.2.C-D8s4-source-binding.md)。

日期：2026-10-03。本文件是本轮配色重设计的人类可读阶段报告，随卡更新；
逐卡交接见 runId 目录 `20261003T185748/handoffs/`，当前与归档记录见[交接索引](20261003T185748/handoffs/README.md)，契约与产物清单见实现计划（链接见下）。
说明：出处为 2026-10-03 会话内的"报告形式"选项答复；因 M0 卡允许文件不含运行目录
README，复核后已移出 runId 目录、置于轮次目录，不影响 §98 契约校验。

**目标**：为十套角色皮肤重建配色管线（OKLCH 配方生成 + 代表色锚定 + 机器评分 + 渲染评审），
让 10×2（浅/深）套配色既不雷同又全部通过可读性门槛，最终回到 `public/skin-palettes.js`。

**M5.2 当前进度（2026-10-13）**：D8a/R1 只读归因 ACCEPTED；D8b-sort 接线已接受；D8c-sort 执行证据已接受，但两种箭头颜色仍 fail（light 2.0172:1、dark 2.1106:1，阈值 4.5:1）。D8d 已验证固定 custom 日期范围返回 totalTokens 日纪录 2026-10-01 / 54,800；D8h 的合法 ready selector 修正已由主管接受，D8e 接线重新验收。D8j adapter 接线与限定纯 Node 回归已 ACCEPTED。D8k 官方 ChatGPT/light 徽标 12/12 测得 3.1361:1，但严格外层恢复断言仍失败；full-page 截图调用前后观察到 +7.5px 位移，原因未推断。D8l 静态诊断已由主管限定范围 ACCEPTED；D8m 正式 token 属性恢复实现已由主管限定范围 ACCEPTED（独立 23/23）。D8n 显示原视口重应用未消除整页截图后的宽度变化。D8o 中间 `clientWidth`/visualViewport 变化保留为记录，但主管确认 main/徽标位置稳定、finally 恢复完整，不应称作内容横移。D8p/R2 独立 helper 限定范围已由主管 ACCEPTED（两条静态 Edge 路径及像素验收通过）；D8q1 measure 前后整页接线、独立 82/82 与摘要及 capture 冻结核对已由主管限定范围 `ACCEPTED`。D8q2 S0 单调用接线经主管限定范围 ACCEPTED（23/23、四摘要一致）；D8r1-R1 唯一一次 ChatGPT/light S0 捕获已由主管限定范围 ACCEPTED，证明的是非测量基准入口，不含角色可读性或审美结论。D8r2 固定日期 `badge.record` 实测的执行、覆盖与严格恢复已由主管限定范围接受；light 3.1361:1 PASS，dark 2.0880:1 FAIL（阈值均为 3:1），颜色 FAIL 保留。角色矩阵与 M6 未运行，整体配色审美仍未验收。详见 [D8r2 handoff](20261003T185748/handoffs/M5.2.C-D8r2-badge-live.md)、[D8p handoff](20261003T185748/handoffs/M5.2.C-D8p-atomic-fullpage.md)、[D8o handoff](20261003T185748/handoffs/M5.2.C-D8o-gutter-guard.md)、[D8n handoff](20261003T185748/handoffs/M5.2.C-D8n-viewport-restore.md)、[D8m handoff](20261003T185748/handoffs/M5.2.C-D8m-style-restore.md)、[D8l handoff](20261003T185748/handoffs/M5.2.C-D8l-screenshot-control.md)、[D8k handoff](20261003T185748/handoffs/M5.2.C-D8k-offset-probe.md)、[D8j handoff](20261003T185748/handoffs/M5.2.C-D8j-adapter.md) 与 [D8i handoff](20261003T185748/handoffs/M5.2.C-D8i-badge-live.md)。

D8p/R2 共享 helper 已由主管限定范围 `ACCEPTED`；D8q1 measure 前后整页接线与 D8q2 S0 单调用接线也已由主管限定范围接受。D8r1-R1 非测量 S0/light 基准已由主管限定范围 ACCEPTED（[D8r1-R1 handoff](20261003T185748/handoffs/M5.2.C-D8r1-R1-fixture-bytes.md)）。D8r2 已完成固定 custom 日期下 ChatGPT `badge.record` 浅深各一次真实采样，light PASS 3.1361:1、dark FAIL 2.0880:1，状态 `NEEDS_REVIEW`（[D8r2 handoff](20261003T185748/handoffs/M5.2.C-D8r2-badge-live.md)）。详见 [D8q2 handoff](20261003T185748/handoffs/M5.2.C-D8q2-s0-fullpage.md)、[D8q1 handoff](20261003T185748/handoffs/M5.2.C-D8q1-measure-fullpage.md)、[D8p handoff](20261003T185748/handoffs/M5.2.C-D8p-atomic-fullpage.md) 与 [R2 run.json](20261003T185748/integration/m52-c-d8p-r2-native-marker/result-r2/run.json)。

此前补充（2026-10-13）：主管已限定接受 D8r2 的执行、覆盖与严格恢复，dark `badge.record` 2.0880:1 FAIL 仍保留，不代表颜色通过。D8s1 三个离线场景已由主管限定 ACCEPTED；D8s2 的 2,001 行上限修复及三个留存输入重算已获主管限定 ACCEPTED。详见 [D8s2 handoff](20261003T185748/handoffs/M5.2.C-D8s2-cap.md) 和 [核对结果](20261003T185748/integration/m52-c-d8s2-cap/evidence/result.json)。本次 D8s3 仍不代表 DOM 可见性验收。

依据文档：

- 设计：`docs/plans/2026-10-03-skin-palette-consolidated-plan.md`
- 工程：`docs/plans/2026-10-03-skin-palette-implementation-plan.md`（7 模块 32 卡，M0–M6）
- 本模块卡片：`docs/plans/2026-10-03-skin-palette-implementation/M0-baseline-and-contracts.md`

## 进度

| 卡 | 内容 | 状态 |
| --- | --- | --- |
| M0.1 | 工作区与行为基线（baseline.json） | DONE |
| M0.2 | 实际颜色角色清单（roles.mjs） | NEEDS_REVIEW（两轮复核更正已落，待复核） |
| M0.3 | 数据契约、政策与失败记录（contracts.mjs / policy.json） | NEEDS_REVIEW（两轮复核更正已落，待复核） |
| M0.4 | 隔离合成 fixture（test-support/skin-palette-fixture.mjs） | NEEDS_REVIEW（close() 时序已修，待复核） |
| M1.1 | 开放 token 派生纯接口（skins.js） | DONE（M0 出口经用户 2026-10-03 复核放行） |
| M1.2 | bootstrap 纯发射器（bootstrap-source.mjs） | DONE |
| M1.3 | 纯颜色数学（color-math.mjs） | DONE |
| M1.4 | 既有状态文字受限颜色兼容（styles.css） | DONE |
| M1.5 | 退役工作台重复声明派生（skin-palette-studio.js） | DONE |
| M2.1 | 固定表面模板与三种变体（templates.mjs） | DONE |
| M2.2 | 有界前景求解（solver.mjs） | DONE（两轮复核更正后放行） |
| M2.3 | 浅深配对、去重与可复现候选（generate.mjs） | DONE（两轮复核更正 + 非阻塞清理后放行） |
| M2.4 | 生成 CLI 与产物写入（generate-cli.mjs） | DONE（复核更正一轮后放行） |
| M3.1 | 求解器可调用的快速角色检查（evaluate.mjs） | DONE（复核更正一轮三处后放行） |
| M3.2 | 浏览器实际色源与背景测量（browser-measure.mjs） | DONE（两轮复核更正后第三轮通过） |
| M3.3 | 材质、成对身份与最近邻诊断（diagnostics.mjs） | DONE（复核通过） |
| M3.4 | 门禁、视觉初筛与证据过期（assess.mjs） | DONE（2026-10-05 第四轮复核通过后放行） |
| M4.1 | 不可变候选预览服务（preview-server.mjs） | NEEDS_REVIEW（2026-10-05 复核 4 项 + 快照洗白更正已落，待复核） |

## 各卡要点

### M0.1 — 工作区与行为基线

- 产物：`baseline.json`（1352 行，SHA-256 `e2d37d95…8b584`）：git HEAD `d56cd30`（main）、
  全量工作区状态（并行改动不回退）、19 个相关源文件摘要、环境版本
  （Node v24.19.0 / npm 11.17.0 / Edge 154.0.4258.53）、注册表顺序、选择器五套名单、
  12 token → 20 CSS 变量的派生消费关系、角色定位三表、检查工具适用范围、旧 token 与生产派生结果。
- 关键结论：`controlText / controlBorder` 被 `derivePaletteDeclarations` 接受但从不消费；
  `--gold` 只有定义无消费；迷你预览 skin-picker.js 用旧 token 字段名（M6 前不修）；
  当时 `scripts/**` 完全不受检查工具覆盖（M0.3 已补 Biome）。

### M0.2 — 实际颜色角色清单

- 产物：`scripts/skin-palette/roles.mjs`（`ROLES_VERSION = 2`；两轮复核更正后摘要 `f0744057…93c19`）。
- 内容：59 个角色（48 必需文本 @4.5、4 必需图形 @3、7 装饰/字标不设阈值）、25 个交互状态
  （步骤/ready/恢复/期望角色，动作只限 click/hover/focus/fill/selectSkin/setTheme 等白名单）、
  BASE_COLORS（`--green/--red` 两个固定 CSS 变量的浅深值——`--gold/--toggle-muted` 零引用、
  `--toggle-selected` 被 styles.css 后半段覆盖为 var(--blue)，v2 一并剔除）。
  角色↔状态双向引用闭合（互为镜像、无空状态角色）由契约测试锁定。
- 背景类型分四类（solid / linear-gradient / layered / canvas），layered 与 canvas 标记
  `browserRequired`，快查按实际合成计算。

### M0.3 — 数据契约、政策与失败记录

- 产物：`scripts/skin-palette/contracts.mjs`（两轮复核更正后摘要 `896b1855…4defc3d`）、
  `scripts/skin-palette/policy.json`（`feeb8a3a…ea25a`）、`test/skin-palette-contracts.test.js`
  （34 条，`8edbbac3…5e5e6`）、`biome.json` 扩围（`66a3c50c…` → `c0ca1a89…`）。
- 契约要点：canonicalJson（键排序 + 拒绝 NaN/循环/undefined/Date/Map/稀疏数组；按当前递归路径判环，
  跨角色共享的冻结背景对象合法）；candidate id = `<skinId>-<variant>-<hash前12位>` 且强制自洽；
  `inputHashes.roles` 与 `hashRoleInputs()` 捆绑——角色清单变更自动使全部旧评审失效；
  七种失败码（DUPLICATE_CANDIDATE 必带 relatedCandidateId + D_OK 距离）；
  候选数据拒绝时间字段与机器绝对路径；assessment 三态一致性（fail→rejected、
  未测→incomplete、ready 必须已过视觉初筛）。
- policy 首版参数：阅读 4.5/7/3、求解 4.7/7.2、预算 1024/4/3、epsilon 1e-7、
  `oklab-distance-v1`、versions{roles:2, colourMath:1, fixture:1}（roles 与 ROLES_VERSION
  的一致性已入 validatePolicy）。

### M0.4 — 隔离合成 fixture

- 产物：`test-support/skin-palette-fixture.mjs`（close() 时序修复后 `1d4a164e…d2130e`）、
  `test/skin-palette-fixture.test.js`（3 条，`1ceb7839…331e0`）。
- `createPaletteFixture()` 只在 `os.tmpdir()` 建 `skin-palette-fixture-` 前缀目录，
  返回 `{homeDir, importStoreFile, databaseFile, pickedPath, fixtureHash, close}`；
  数据以 `codex-usage.project-log.v1` 写入合成项目的 `.codex-usage/usage.jsonl`，
  通过 imports.json（当前导入配置）走真实导入链路，不伪造 /api/usage 协议。
- 固定数据集：2026-09-26—2026-10-03、12 条非零事件、4 模型（3 个本地默认表内 +
  1 个刻意缺价）、2 渠道、8 条长名称、input/cached/output/reasoning 齐全；
  `fixtureHash` 只覆盖逻辑内容（两实例摘要相同），`close()` 幂等且清理前校验
  tmpdir 归属与前缀。
- 附带 `createPaletteServerOptions(fixture)`：固定 `env:{}`、关闭自动计价发现
  （零外网）、目录选择指向 pickedPath——M4 预览服务的标准接线。
- 关键结论（写给 M2/M4）：默认价目表填满时未知模型走最低价率兜底
  （`priceMode = "minimum-fallback-scenario"`、`minimumRateModels` 收录），
  `unpricedTokens` 不可达；缺价断言按此真实契约书写。

### M1.1 — 开放 token 派生纯接口（2026-10-03，M0 出口经用户复核放行后开工）

- 产物：`public/skins.js` 新增导出 `derivePaletteDeclarationsFromTokens(rawTokens, mode)`
  （结束 `1f03b997…29637`）；`test/skins.test.js` +4 用例（结束 `e516b1e1…a10e0`）。
- 行为：扁平 token 对象经现有 normalizePalette 白名单清洗；非 light/dark、非对象、
  无有效 token（含仅 chartSeries）→ null；部分 token 保留部分声明；输出冻结且顺序
  与原派生一致；`paletteDeclarations` 保留 unknown/classic/null 分支并委托新接口
  ——消除第二条计算路径。12 键规则未反向施加到生产 API；controlText/controlBorder
  仍"被接受但不独立应用"；20 项变量清单未变；正式色值与 CSS 零改动。
- 验收证据：十套 × 两模式（含 classic）22 项对账 skin-bootstrap.js 烤制旧基线
  （bootstrap 字节未动、由 M1.1 之前代码路径生成，即独立参照）+ 新旧 API 互相一致；
  无效输入/部分输入/未知字段/冻结行为各有针对性用例。skins 测试 36/36、全套 **388/0**、
  typecheck/lint/format 三检 0。详见 `20261003T185748/handoffs/M1.1.md`。

### M1.2 — bootstrap 纯发射器（2026-10-03）

- 产物：新增 `scripts/skin-palette/bootstrap-source.mjs`（`53dda90d…3c3b`）、
  `test/skin-palette-bootstrap.test.js`（`d91a573b…393e`）；修改
  `scripts/prepare-skin-assets.mjs`（`98570e15…` → `3d7ba19c…26ca`，只改接线）。
- 行为：`buildSkinBootstrapSource(paletteOverrides = {})` 纯字符串拼装——registry/payload
  与 IIFE 模板自 prepare 脚本整体移入；override 仅收 M0 `SKIN_IDS` 十套、浅深两套齐全且过
  `validateTokens` 严格校验（classic/半套/未知模式键/坏色值一律显式抛错）；覆盖角色走
  M1.1 纯接口派生，其余保持正式值；资产/偏好版本/默认 classic/清除清单不变；
  prepare 的 CLI、manifest、格式化 probe、原子写原样。
- 验收证据：`skins:check` PASS（40 assets/40 URLs/manifest 与 bootstrap 新鲜）＝无 override
  输出与已提交基线逐字相同（raw 即 canonical，biome 零改动）；发射器测试 8/8——载荷等价、
  覆盖单角色只改其两模式 palette、十类非法输入抛错、模拟 DOM/storage 中 IIFE 先清 20 变量
  再设 M1.1 声明、classic 无残留、dark 取深色、override 首帧即派生值。
  `public/skin-bootstrap.js`/`skin-assets.json` 字节未动。全套 **396/0**、三检 0。
  详见 `20261003T185748/handoffs/M1.2.md`。
- 复核更正（同日，用户指出原型链漏洞）：`in` 与普通属性读取走原型链——校验与发射统一改
  自有属性语义（light/dark 与 12 token 键须为自有属性、发射只读已验证自有条目 Map，
  原型链上的继承值/皮肤条目一律不算已提供）；回归 9/9（含继承 dark/accent 拦截、
  原型链 kimi 覆盖不影响基线与首帧）。全套 **397/0**、`skins:check` PASS 逐字基线不变；
  最新哈希 emitter `8d707e42…257c`、测试 `9db38aa3…67ee9`。

### M1.3 — 纯颜色数学（2026-10-03）

- 产物：新增 `scripts/skin-palette/color-math.mjs`（复核更正后 `71fa8337…f854dd79`，
  零导入纯函数）、`test/skin-palette-math.test.js`（复核更正后 `2a74aeff…3599f107`）。
  public/、src/、生产混色规则零改动。
- 接口：hexToSrgb/srgbToHex（单次舍入、明显超域报错）、srgbToOklab/oklabToSrgb
  （Ottosson 公开矩阵，来源注明）、oklabToOklch/oklchToOklab（H∈[0,360)，近零彩度
  约定 H=0，阈值 1e-7——中灰浮点噪声底 ~2.2e-8 实测）、isInSrgbGamut/fitSrgbGamut
  （保持 L/H、C 二分至多 24 次、判定容忍 1e-7 = policy srgbGamutEpsilon）、
  compositeSrgb（CSS 编码通道合成，亮度取自有效色）、relativeLuminance/contrastRatio
  （0.2126/0.7152/0.0722 + 0.04045 分支）、okDistance（100×OKLab，内部诊断量）。
- 验收证据：9/9 全锚外部已知结果——红绿蓝 OKLab 参考值（±2e-4）、黑白 21:1、
  #808080 亮度 0.21586/对黑 5.32、#767676（4.54 过）/ #777777（4.47 不过）阈值对、
  浏览器 rgba 合成（#808080/#800080）、超域降 C 且 L/H 不动、H 跨 0° 无 NaN、
  17 色 sRGB↔OKLab 往返精确、纯度断言（零 import、无 DOM/随机/文件/palette）、
  健壮性（超大有限 H 不溢出、稀疏数组空位显式报错——见复核更正）。
  全套 **406/0**、三检 0。详见 `20261003T185748/handoffs/archive/2026-10-05/M1.3.md`。

### M1.3 复核更正（2026-10-03）

评审指出两处缺陷，均已修复并补第 9 个回归测试块：①`oklchToOklab` 对极大有限 H
（如 Number.MAX_VALUE）先乘 π 溢出为 Infinity→NaN，改为先归一化 [0,360) 再转弧度；
②`isInSrgbGamut` 的 `Array.every` 跳过稀疏空位（`[0, , 0]` 可能误判在域内），改为
索引 0..2 逐通道检查、空位显式报错（srgbToHex 同类路径一并锁定）。math 9/9、
全套 **406/0**、三检 0；哈希更新见上。

### M1.4 — 既有状态文字的受限颜色兼容（2026-10-04）

- 判定：**确有失败**（非 not-needed）。--green #2f855a / --red #c05621 对角色浅色
  陶瓷渐变背景（classic + 9/10 皮肤）必要小字 <4.5——绿地板 1.77（grok）–4.54（glm），
  红地板 1.78–4.57，day-range-end 混色 1.99–2.89 全败；梯度最劣点必在 stop 端点。
- 落地：styles.css 新增卡面预定规则 `:root[data-skin]:not([data-skin="classic"]):not(
  [data-theme="dark"]) { --green: #1a5233; --red: #74270d; }`（211 行注释同步改为
  "关闭状态色"）；roles.mjs 仅同步 `BASE_COLORS.character.light`（与 CSS 同值，
  roles 保持大写、CSS 按 biome 小写），classic/dark 分支保留旧值；ROLES_VERSION 保持 2
  （validatePolicy 强制与 policy.json versions.roles 相等，且 v2 有"未发布批次不递增"
  先例；hashRoleInputs 覆盖 BASE_COLORS 自动使旧候选评审失效）。12 token/20 声明/
  --gold 全部不动。
  哈希：styles.css `95677086…192a2a2`（整文件含并行 WIP）、roles.mjs `07e046a3…cd37c3c5`。
- 验收证据：隔离 fixture（临时静态服务随机端口，非 3765 同源）五分支 computed——
  classic light 保持 #2f855a/#c05621、chatgpt light 变 #1A5233/#74270D、classic/dark
  均保持 #34d399/#fb923c；20 项 M1.1 声明与覆盖块共存 computedMatch=true；CSSOM 精确
  删规则前后盒尺寸 JSON 全等（纯颜色变更）。新值下开放五套绿/红全过 4.5，残余失败
  （grok 3.56/4.01、chatgpt day-range-end 4.15）按卡面交 M2 表面修正、持续无解才
  CONTRACT_CONFLICT。全套 **406/0**、三检 0、`skins:check` PASS（40 assets）。
  详见 `20261003T185748/handoffs/archive/2026-10-05/M1.4.md`。
- 复核更正（2026-10-04）：首版两值按卡面字面写为大写 `#1A5233/#74270D`（历史记录），
  biome format 对 CSS 强制小写致 format:check 红；经用户裁定格式更正归回本卡，改小写
  （颜色不变、无需重跑 fixture），哈希更新为 `95677086…192a2a2`，roles.mjs 不动。
  改后 format:check 0、全套 406/0、`skins:check` PASS。

### M1.5 — 退役工作台重复声明派生（2026-10-04）

- 改动：`public/skin-palette-studio.js`（`aa6d2e4c…c3229d55`）——`previewDeclarationPairs`
  退役自算的陶瓷/active-ink/hover/阴影草案式，改薄封装 M1.1
  `derivePaletteDeclarationsFromTokens`；`activeInkFor` 删除；`assertInline` 注入前
  清除 `PALETTE_CSS_VAR_NAMES` 中候选未覆盖的名字（差异才写，观察器等值护栏保留）；
  `public/skin-palette-studio.html`（`21ce8e44…81e8679f`）仅改现有说明——四源草稿
  标注「旧快速草稿（不作求解器/门禁）」、controlText/controlBorder 无独立接线说明。
  导出结构（12 token）与偏好恢复保留；index.html 零工作台引用（grep 0）。
- 验收证据（隔离 origin 随机端口，Node 侧同一份 skins.js 现算期望值回传比对）：
  浅色/深色 × deepseek/chatgpt 四组合 inline+注入样式表+computed 三层与共享 API
  20 项全等（无清单外残留）；切皮肤时 app 官方值（--blue #5c86f0）被观察器重 assert
  为候选值（#abbbcb）——重应用机制实证；导航离开后偏好恢复、新首页 data-skin=classic
  且 inline 变量零残留。全套 **406/0**、三检 0。详见
  `20261003T185748/handoffs/archive/2026-10-05/M1.5.md`。M1 模块（M1.1–M1.5）全部完成。

### M2.1 — 固定表面模板与三种变体（2026-10-04）

- 产物：新增 `scripts/skin-palette/templates.mjs`（`136cd04d…b07c7f`，只依赖
  color-math）、`test/skin-palette-solver.test.js`（`70bca250…004435`，11 条）。
- 行为：`buildSurfaceTemplates(profile)` 纯函数——读卡面六字段（未知忽略，snapshot 归
  M2.3）→ 卡面固定表面表六 token（L 计算结束钳 [0.04, 0.998] 且链式：panelL 先钳再
  派生 highlight/border；controlBackground 同 panelBackground）→ a/b/c 变体（surfaceK
  1/0.75/1.2、pageL 偏移 light +0.015/−0.015、dark −0.025/+0.015、accentK 1/0.9/1.05；
  表面 C 缩放后钳 [0, 0.045] 并记 surfaceCClamped）→ 背景修正组固定顺序 light
  [0,+0.020,−0.020] / dark [0,−0.020,+0.020] 最多 3 组、偏移钳基值 ±0.04（b dark
  −0.045 必触界）、钳后 pageL 重复组按 1e-9 键去除保首组 → 前景四 token 只声明
  搜索契约（text H=surfaceH、maxC=min(surfaceC,0.018)；accent H=identityHex OKLCH H、
  minC 0.035），controlText/controlBorder 留待 M2.2 求解后填写 → gamut 记录逐 token
  保留（chromaReduced/requested/final）→ stage "draft"（未求解不称通过）；输出深冻结。
- 验收证据：专项 11/11（完整性/确定性/修正组枚举与钳制/小幅越界标记/M1.3 原语独立
  重算锚定/OKLCH 关系/前景规格/表面 C 上限与退化去重/gamut 记录一致性/非法输入报错/
  纯度扫描）；全套 **417/0**、三检 0、`skins:check` PASS。数值事实：近黑区 8-bit 量化
  对 OKLab L/H 放大实测（L 漂 ~0.012、C≈0.01 时 H 漂 ~7°）——测试容差按此校准并以
  最终 HEX 为下游复核基准；light panelHighlight 贴白点必然降 C（记录如实保留）。详见
  `20261003T185748/handoffs/archive/2026-10-05/M2.1.md`。
- 复核更正（2026-10-04，用户指出两处）：①钳制标记（offsetClamped/lClamped/
  surfaceCClamped）原按 1e-9 量化键比较、幅度小于键粒度的越界漏报——改为按钳制前后
  值严格不等判定（pageL 去重仍用量化键），补第 11 条小幅越界用例（L 下限 −1e-12、
  C 上限 +1e-12，旧实现误报 false）；②执行期间为解 format:check 红改过 styles.css
  （M1.4 块小写）——经裁定该格式更正**归回 M1.4**（其 handoff 与哈希已更新），
  M2.1 改动清单回到卡面允许文件。哈希更新如上；专项 11/11、全套 417/0
  （首版 10/10、416/0，历史记录）。

### M2.2 — 有界前景求解（2026-10-04）

- 产物：新增 `scripts/skin-palette/solver.mjs`（`12443f3a…ecb26`，只依赖
  color-math；首版 `c8247899…a3b54`、第一轮更正 `ab04e5af…a5038`，均历史记录）；
  `test/skin-palette-solver.test.js` 自 M2.1 结束态追加 16 条 M2.2 用例
  （`754d6309…0c69f`，共 27 条 = M2.1 11 + M2.2 16；该文件为 M2 共用测试文件，
  M2.1 的 11 条未改动）。templates.mjs 未动。
- 行为：`solveModeForegrounds({ skinId, mode, roleCatalog, policy, evaluatePalette,
  corrections, foregrounds })`——单模式内按固定顺序（textPrimary→textSecondary→
  chartText→accent）在 M2.1 修正组背景上搜索四个前景 token；真实角色判定一律经注入
  的 evaluatePalette（M3.1 固定接口形状，本模块无第二份阈值实现），消费契约
  （roleId/required/status/ratio/threshold/foregroundTokens/backgroundTokens 依赖
  申报、镜像归源 controlText→textPrimary、controlBorder→panelBorder）不符显式
  TypeError。C 阶梯 ×129 点 L 网格含端点，试值 fitSrgbGamut→srgbToHex→代回完整
  token 整体评估，HEX 缓存、预算只计实际调用；主文字 τ 梯 [7.2, 4.7]（回退记
  preferredContrastUnmet），**τ 只绑定正文类角色（阈值 ≥ bodyTextMin）**；每 C 层
  可行点分组取离起点最近段、两侧各 ≤16 次二分细化，全局优先级达目标→|ΔL|→|ΔC|→
  固定序；就绪集合语义（耦合角色等其余依赖定值后才入搜索）、每轮末整体重查、失败
  涉及 token 下轮重搜、最多 4 轮；失败归并 CONTRACT_CONFLICT（全组固定色阻断，只做
  预检）> SEARCH_BUDGET_EXCEEDED > UNSATISFIABLE，失败出口无 tokens 字段，成功出口
  12 token（镜像填写）深冻结。
- 验收证据：专项 27/27（16 条按卡面验收清单映射，含复核更正回归 3 条：低预算早期
  可行点、契约从严 12 违约形态、镜像归源绑定判据）；全套 **433/0**、三检 0、
  `skins:check` PASS。M3.1 未落地——评估器为测试人造实现，生产接线在 M2.3（若
  M3.1 输出缺依赖申报需在 M2.3 侧薄适配，不进 solver）。执行顺序（先 M2.2 后
  M3.1）为用户 2026-10-04 拍板。详见 `20261003T185748/handoffs/archive/2026-10-05/M2.2.md`。
- 复核更正（2026-10-04，用户指出两处，状态改 NEEDS_REVIEW）：①评估器契约校验
  不完整——首版把缺失依赖数组缺省为空、required 缺省 true、ratio/threshold 不
  校验，"角色达标但低于搜索目标（4.6 ∈ [4.5, 7.2)）"时 τ 约束会从搜索与轮末重查
  中静默消失；改为从严校验不设缺省（roleId 非空/required 布尔/判定角色 ratio 与
  threshold 有限非负/未测角色不得带比值/依赖数组必填逐键校验 12 token 键集），
  镜像键 controlText/controlBorder 由 solver 消费前归源（不推给评估器）。②预算
  耗尽仍可报成功——首版只要耗尽前已遇可行点就返回 chosen（用未完成搜索的数据选
  结果）；改为耗尽即 SEARCH_BUDGET_EXCEEDED（best 仅留诊断）。另自查更正：首版
  solver.mjs 残留 oklabToOklch 死导入，交接所记"biome 0"不实——已移除，现真 0。
  哈希更新如上；专项 27/27、全套 433/0（首版 24/24、430/0，历史记录）。
- 复核更正第二轮（2026-10-04，用户指出一处，状态暂留 NEEDS_REVIEW）：未测角色
  threshold 缺失仍过校验——第一轮更正用 `!= null` 判断，undefined 被当作可接受值，
  与契约"数值或 null"不符；改为 `!== null` 后字段缺失同样 TypeError（ratio 的
  `!= null` 保留：缺省是未测角色的正常形态，语义不同）。契约测试补第 13 个违约
  形态；哈希更新如上，专项 27/27、全套 433/0 复跑全绿。

### M2.3 — 浅深配对、去重与可复现候选（2026-10-04；两轮复核更正 + 非阻塞清理后放行）

- 产物：新增 `scripts/skin-palette/generate.mjs`（首轮 `da4a5712…9a10`；
  **2026-10-04 M2.4 会话补记：该文件曾被并行编辑器整文件回退至第一轮状态
  `058c3f70…17c0`，已依据 M2.3 交接重新应用三处文案（docstring 失败出口段 /
  solveFailureRecord JSDoc / 预算消息），语义代码零改动，权威哈希
  `d276ba07…3543`**）；solver.mjs
  改动均由本卡复核更正驱动（`249a30d7…f560e`）——runEvaluator 加导出（最终重查与
  求解期共用同一份评估器契约校验与镜像归源）、无解/预算出口新增角色证据
  roleEvidence、预算耗尽即整组循环停止；测试文件结束态 35 条（`d1b764a0…8670` =
  M2.1 11 + M2.2 16 + M2.3 8；M2.4 会话追加 CLI 9 条后 44 条 `b8ca181d…731`）。
  templates/contracts/roles/policy 未动。
- 行为：`generateCandidates({ profiles, skinIds, seed, policy, roleCatalog,
  evaluatePalette, derivationHash })`——**纯函数，零文件读取**；验证请求 ID 与配方后
  按注册序 × a/b/c 生成，每变体浅深各求解、两模式完整才建 Candidate（无孤立模式）；
  profileSnapshot = 配方经 canonicalJson 往返的**深拷贝**（deepFreeze 只冻结拷贝，
  调用方配方含嵌套字段不被冻结）+ profileHash；parameters 逐模式记变体缩放/修正组
  （pageL、钳制标记、gamut 降 C）/前景规格/solvedTokens/优选未满足/轮数/逐 token
  试值，search 记预算、试值合计、预检/轮末/最终重查次数与阅读余量；最终 HEX 经
  runEvaluator 同一契约入口重查（必要角色失败 → STALE_EVIDENCE，确定性评估器下
  不可达的兜底）；同皮肤去重 = 六样本（page/panel/accent × 浅深）D_OK 全 < 2.0
  （首版工具阈值）保留阅读余量更高者、并列按 a/b/c 先序——**卡面"完全相同 24
  token 保留最前"是距离全 0 特例（余量必相等 → 并列 → 先序），语义一致**；失败
  逐模式记 UNSATISFIABLE/CONTRACT_CONFLICT/SEARCH_BUDGET_EXCEEDED，角色证据三来源
  归并（fixedRoles/failingRoles/roleEvidence）按角色取已观测最高比值——**首轮换组
  从未走到轮末重查、预算耗尽中断同样留档失败角色与比值**（总计划 §5）；预算记录
  的比值为耗尽前已观测（消息明示不作最高可达论断）；**预算耗尽即整组循环停止**
  （不以新预算尝试后续组）；去重记 DUPLICATE_CANDIDATE（含关联 ID + 六项距离）；
  全冲突输出允许空候选（不虚构兜底）。id/摘要走 M0 函数（id=<skinId>-<variant>-
  <hash12>、derivationHash 为**显式入参**：64 位小写 hex、由调用方（M2.4 CLI）经
  collectSourceHashes 计算后传入，§4.1 的 skins.js 内容摘要语义由调用方保持）；
  输出深冻结，逐候选/逐记录 M0 校验自检。
- 边界三处：①evaluatePalette 为注入参数（卡面签名成文早于 M2.2 注入裁定；M3.1
  落地前由调用方注入，M2.4/M5 传真件）；②derivationHash 显式入参（总计划 §4.1
  依据，纯函数不读文件）；③M0.3 validateCandidateSet 的"expectedSkinIds × a/b/c
  全配对"完整性与去重/失败语义冲突（contracts 属 M0 文件、非本卡允许清单）——
  自检以 `expectedSkinIds: []` 跳过该检查、保留其余（顺序/唯一/哈希/角色清单一致
  性），修订建议（missing 只查既无候选也无 rejected 的配对）留待契约所有方在
  M5/M6 前裁决。style 为首版回退文案（实际参数说明，无"算法证明美观"措辞；
  M5.1 携带 style 时优先采用）；阅读余量口径（ratio/threshold 最小、跨模式取最小）
  为首版定义。
- **复核更正两轮（2026-10-04）**：
  - 第二轮（两处预算边界）：①SEARCH_BUDGET_EXCEEDED 记录证据边界代码层闭合——
    原预算出口完全不附证据（空 roleIds/null 比值）且不强制（混合 unsat+预算组会把
    已完成组证据带进预算记录）；现 solver 预算出口附耗尽前已观测的 roleEvidence、
    同一归并规则、消息明示"不作最高可达论断"，回归断言（预算 3 + 始终失败角色 →
    roleIds/worstRatio=2/threshold=4.5，原为空/null）。②"耗尽即停"闭合到组级——
    原某组耗尽后仍以新预算尝试后续组（"不增加无限重试"被绕过）；现预算耗尽即整组
    循环停止，回归断言 attempts = [unsat, budget]、组 2 未尝试、已完成组证据并入。
  - 第一轮（三处）：①profileSnapshot 由直引调用方配方改为深拷贝（原实现
    deepFreeze 会递归冻结输入、含嵌套 pageL——修改输入违背纯函数约定）；回归断言
    调用方配方未被冻结、仍可修改、快照保真。②无解记录补失败角色与比值：原 solver
    汇总只有诊断、生成器只收 fixedRoles/failingRoles → 常见首轮 UNSATISFIABLE 记
    成空 roleIds + worstRatio null；现 solver 在搜索期按角色累计最高可达比值、unsat
    出口过滤"仍不满足自身要求（或绑定最宽松 τ）"者随换组摘要带出，generate 三来源
    归并；回归逐条断言（始终失败角色 = ["status.home-reason"]/2/4.5，原为空/null）。
    ③derivationHash 由模块导入期读 public/skins.js 改为显式入参（与纯函数约定
    一致，§4.1 语义移至调用方）；纯度测试 imports 白名单收窄至四个相对模块、补
    缺失/格式非法报错断言。
- 验收证据：专项 35/35（8 条映射卡面验收：逐字复现/子集独立/无孤立模式/失败码
  映射含两轮预算回归/去重距离可用公开模块重建被去重变体逐项复算对上/纯度 +
  derivationHash 显式入参）；**当前全套 480/0**（含并行会话持续新增用例；
  第二轮更正完成时为 473/0）、typecheck 0、lint 0、format:check 0、`skins:check`
  PASS。探针核实：基线下 c↔a 六距离 ≈[1.65,1.55,0.60,1.58,1.78,0.57] 全 <2.0、
  a↔b 深色 page 距 2.5 不判重；HEX 缓存跨层去重使单 token 实际评估数低于网格
  名义值（预算回归用例按实测标定）。详见 `20261003T185748/handoffs/archive/2026-10-05/M2.3.md`。

### M2.4 — 生成 CLI 与产物写入（2026-10-04；首轮 + 复核更正一轮后放行）

- 产物：新增 `scripts/skin-palette/generate-cli.mjs`（首轮 `4d982c97…76c`，复核
  更正后 **`013dcb13…0941`**）；测试 48 条（`b2f943b5…1c1c` = M2.1 11 + M2.2 16 +
  M2.3 8 + M2.4 13）。generate/solver/templates 零逻辑改动。
- 行为：固定参数 `--skins / --seed / --out` + 仅有的两个覆盖开关
  `--profiles / --policy`（缺省读固定模块目录 profiles.json/policy.json，roles
  无覆盖只消费 roles.mjs）；`--skins all` = 注册表十套；未知/重复/缺值/空段/
  未知皮肤/重复皮肤/classic 一律退出 1。**policy 经 contracts.validatePolicy M0
  契约校验后才参与生成**（不过报 POLICY_INVALID，写盘前拦截）。输出目录必须在
  `docs/validation/<日期>-skin-palette-redesign/<runId>/`，**词法 + 真实路径
  （junction/符号链接还原）双检，mkdir 后再复检一次**；已有结果报 RESULTS_EXIST
  拒绝覆盖（先于任何读盘写盘）。`collectSourceHashes` 收集工具链 7 模块 +
  **实际评估器模块** + public/skins.js + profiles/policy 原始字节摘要进
  run.json，其中 skins.js 摘要即 derivationHash 传给 generateCandidates（§4.1
  调用方语义）；run.json.evaluator 记评估器来源（module → path+sha256；注入 →
  injected，留档由注入方负责）。evaluatePalette：显式注入优先，否则动态解析
  `./evaluate.mjs` M3.1 真件（目标可经 evaluateModulePath 覆盖），缺失或无函数
  导出报 EVALUATE_UNAVAILABLE 退出 1——**M3.1 与 M5.1 落地前直接运行必退出 1
  （输入错误），不造第二份评估实现**。写 candidates.json（canonicalJson + 末尾
  换行、临时文件再 rename）与 run.json（运行时间/绝对路径/状态/计数/硬失败摘要/
  notes——§4.1 明文允许放运行证据，候选 JSON 同输入逐字相同）；**任一文件写入
  失败即回滚本次已写文件，半套结果不留盘、同目录重试可行**。退出码：0 = 每请求
  皮肤 ≥2 组成对且无硬失败（**生成完成 ≠ 浏览器或美观通过**，日志与 notes 明示
  尚待 M3/M4）；2 = 不足两组或 UNSATISFIABLE/CONTRACT_CONFLICT/
  SEARCH_BUDGET_EXCEEDED/STALE_EVIDENCE（已完成结果与失败记录仍保存）；
  1 = 输入或写入错误。导入不执行 CLI（直接运行判据与 perf-probe 同款）。
- 边界：失败记录六要素已由 M2.3 闭合，run.json 只存硬失败摘要；validateProfiles
  十套信封校验属 M5.1 所有方，CLI 不强制；生成成功/冲突路径经 runGenerate 注入
  evaluate + 临时目录覆盖，直接运行端到端在 M2 阶段按设计不可达。
- **复核更正一轮（2026-10-04，四处：P1×1 + P2×3）**：①输出目录边界只做词法
  比较，junction/符号链接可重定向到界外——现真实路径双检 + mkdir 后复检
  （界外拒绝、界外零写入）；②policy 只查 JSON 可解析——现过
  validatePolicy（POLICY_INVALID）；③candidates.json 写成功而 run.json 失败时
  残留半套、重试被 RESULTS_EXIST 卡死——现写入失败回滚本次文件；④实际评估器
  模块不在 sourceHashes——现 module 来源记 path+sha256 进摘要表、注入来源记
  injected。四条回归各一（junction 界外零写入 / 空壳 policy 拒绝 / run.json
  写败回滚后同目录重试成功 / fixture 评估器 path+sha256 与摘要表一致）。
- 验收证据：专项 **48/48**（M2.4 段 13 条：参数解析/输出目录/成功路径/重复运行
  同摘要/冲突退出 2/拒绝覆盖/输入错误不落盘/直接运行判据/evaluate 解析/junction
  界外/policy 契约/写败回滚/评估器进摘要）；**当前全套 547/0**（543/0 为首轮
  实现时结果）、typecheck 0、lint 0、format:check 0。探针实测：基线配方每皮肤
  a/b 存活、c 去重恰 2 条。详见 `20261003T185748/handoffs/M2.4.md`。

### M3.3 — 材质、成对身份与最近邻诊断（2026-10-04，DONE——复核通过）

- 产物：新增 `scripts/skin-palette/diagnostics.mjs`（**`cd9339b4…2958c`**，399 行）、
  10 条 M3.3 测试进 `test/skin-palette-quality.test.js`（**`098af2bf…fdbf0`**，
  3453 行，66 条 = M3.1 16 + M3.2 34 + M3.3 10）。`evaluate.mjs`
  （`08fa2ab9…7d1ed`）只多导出 `parseDeclaredValue` 供复用（函数体未动）——
  **颜色解析器仍只有一份**。roles/contracts/policy、skins.js、color-math 与生产
  CSS 零改动。
- 纯函数、零 I/O、零 DOM、零随机零时间（纯度测试锁定 import 白名单只有
  contracts/color-math/evaluate/public-skins 四个）；输出深冻结，输入候选
  `canonicalJson` 前后一致。
- 三项固定输出：① 材质剖面——实际 top/panel/bottom/page/well 的 OKLab L、四条
  相邻 D_OK（top→panel→bottom→page→well）、高光/阴影 alpha；② 成对身份——浅/深
  各一张两两矩阵（page/panel/accent），六项距离 + `pairMeanDistance`（算术平均，
  全精度），每候选一条最近邻**皮肤**（自带六项距离，同一引用）；③ 提醒标记——
  top↔bottom D_OK < 2.0 记 `flatSurfaceWarning`，跨皮肤六项都 < 3.0 记
  `nearNeighborWarning`。同皮肤变体不参与近邻判定（a/b/c 本就应该像）。
- **距离单位只有一种**：全部走 M1.3 `okDistance`（100× OKLab），与 M2.3 去重同
  口径；测试用同一函数逐位复算，单位漂移（差 100 倍）立刻红。
- **缺项 incomplete 不补 0**：缺声明 → `complete:false` + `missing`（具体 CSS 变量
  与哪条相邻距离），数值字段一律 null；六项不全时 `pairMeanDistance` 是 null——
  0 会被读成"两款完全相同"。
- **不产生任何阅读判定**：`assertDiagnosticsCarryNoVerdict()` 自检 + 专项测试双锁，
  输出树任何一层出现 pass/fail/ready/readiness/rejected/verdict/score/accepted
  键即报。M3.4 必须把这两个分支当数据用，不得用材质或差异高分覆盖文字失败。
- 实测（两条合成夹具皮肤）：浅色 top↔bottom **1.846250 → 触发平坡提醒**（结构
  夹具偏平）、深色 **10.198384 → 不提醒**；高光/阴影 alpha 浅 0.6/0.54、深
  0.4/0.72，与 M1.1 派生逐位一致；chatgpt vs claude 六项 3.1941 / 2.1446 /
  22.1377 / 3.3466 / 3.0755 / 24.1792，`pairMeanDistance` **9.679630463849708**，
  近邻提醒 false（accent 距离远高于 3.0）。
- 两处执行偏差（已随复核确认）：① 卡面"已经生成的真实声明"取**候选 token 经 M1.1
  派生**（与运行时 bootstrap、`skins:prepare` 同源），不从渲染页读 computed
  style——本卡无浏览器；评审记录由 M3.4 持有，本卡不读也不要。② 阈值归属
  policy.json（M0 文件），本卡零 I/O 只留默认值 + `thresholds` 出入口，注释写明
  M3.4 接线后应由 policy 提供、在那之前调整也必须按卡面规则（增 policy 版本、
  重跑报告、记录理由）。
- 10 条测试逐一对应卡面固定输出与五条验收行（单位一致 / 交换对称 / 浅深齐全 /
  缺项 incomplete 不补 0 / 材质或差异高分翻不动文字失败），另有纯度、深冻、输入
  校验三条。`pairMeanDistance` 与六项距离钉了固定数值，换中位数/几何平均会立刻红。
- 门禁：专项 **66/66**、`npm test` **700/0**（exit 0，本卡 +10；总数相对 M3.2
  收尾的 689 多出的部分含并行会话同期改动，本卡未触碰其文件）、typecheck 0、
  `biome check` 本卡两文件零诊断、`format:check` 0（本卡两文件经
  `npm run format` 归一化——长 import 行曾让格式门禁红过一次）、`lint` 0 error
  （43 条 warning 全在既有 `public/styles.css`）、`skins:check` PASS（40 assets）。
  回退验证 9 项见 `20261003T185748/handoffs/M3.3.md`（每次把缺陷临时改回去只有
  预期用例变红，还原后全量复跑回到全绿、模块哈希复原）。

### M3.4 — 门禁、视觉初筛与证据过期（2026-10-05，DONE——四轮复核后放行）

- 产物：`scripts/skin-palette/assess.mjs`（**`705b5cdb…a2c2`**，1084 行）、
  `test/skin-palette-quality.test.js`（**`a1547333…04d6`**，4719 行，
  90 条 = 83 顶层用例（M3.1 16 + M3.2 34 + M3.3 10 + M3.4 24）+ M3.2 真机用例内
  6 个子测试）。M0 文件、skins.js、color-math、evaluate / browser-measure /
  diagnostics 与生产 CSS 零改动。
- 固定入口 `assessCandidate({ candidate, fastChecks, browserChecks, visualReview,
  run })` → M0 九个键的 Assessment，末尾强制过 `validateAssessment` 自检。
- **八条执行口径**（详见交接）：① 近似读数不进判读集，但 M0 规定“桶里任何 fail
  都必须 rejected”，所以近似失败同样挡下评审，来源靠尾缀 + blockers 文字分辨；
  ② **只有 fast 桶能用 `stateId: null` 覆盖该模式全部状态**，浏览器记录必须带状态
  锚点（无锚点的记录记进 `coverage.unanchoredBrowser` 并单独出 blocker，**但仍进
  失败汇总**，见口径 ⑧）；
  ③ 手工补测只进 `diagnostics.manualSupplement`，不进机器桶、不影响 readiness；
  ④ 阈值必须等于角色目录阈值、result 必须与全精度 ratio/阈值一致；
  ⑤ 出处六件（candidateSet / recordedInputHashes / sourceHashes /
  recordedSourceHashes / fixture / recordedFixture）缺任何一件即 incomplete；
  ⑥ 阈值-less 角色的 unmeasured 转成带理由的 not-applicable，真正缺测保留；
  ⑦ 两份源文件摘要都要逐项覆盖 `REQUIRED_SOURCE_FILES`（**17 个文件**：总计划 4.1
  点名的七个页面/颜色文件 index.html / skin-palettes.js / styles.css / app.js /
  app-state.js / skin-ui.js / skin-picker.js，加同一句“至少包含”口径内、由 index.html
  第 34 行加载的 public/skins.css，再加 public/skins.js 与 M0/M3 八个模块
  文件），“给个对象”不等于“核验过”；⑧ 失败汇总取全部有效记录（含无锚点）里的 fail，
  状态锚点只决定能不能证明覆盖。
- 卡面“旧 palette check 代替阅读验收”的防线：`gate.machineOnly: true` + `blockers[]` +
  `failureCounts`，`by: proxy | user` 分离且用户选择只属 selections.json，输出里没有
  任何 score / accepted / grade，`coverage.verdictCounts` 只是逐单元直方图。
- 门禁：专项 **90/90**；`npm test` **947 pass / 0 fail**（exit 0）；typecheck 0；
  本卡两文件 biome 零诊断、`biome format` 对本卡两文件 0、全仓 `format:check` 0；
  `npm run lint` 0 error / 43 warnings（均不属本卡两文件）；`skins:check` PASS（40 assets）。
  回退验证 19 项见
  `20261003T185748/handoffs/M3.4.md`，逐项把缺陷改回去只有对应用例变红。
- **首轮复核未通过（五项，其中前三项会错误放行 ready）已全部更正**；**第二、三轮复核
  各项已更正**——第三轮指出必需源文件清单漏掉实际页面/样式文件（只给 9 个派生/工具模块
  摘要、省略总计划 4.1 点名的七个页面文件仍 ready），`REQUIRED_SOURCE_FILES` 随之扩到
  16 个文件并加回归（逐个缺/逐个变都逃不过，清单被改回去立刻红）；**第四轮用户裁定
  `public/skins.css` 必须补入**（总计划 4.1 的“至少包含”+“影响颜色/背景的依赖变化后
  须重跑评审”，且它已被 index.html 第 34 行加载、含颜色/渐变/透明度规则），清单
  16 → 17 个文件，回归的页面/样式文件清单显式包含它（缺摘要 → incomplete、摘要变化 →
  `STALE_EVIDENCE`、从清单删掉立刻红）。回退验证 19 → 20 项。**2026-10-05 用户第四轮复核
  通过，M3.4 标为 DONE**；四轮复核共九项问题全部更正。

### M4.1 — 不可变候选预览服务（2026-10-05，NEEDS_REVIEW——复核四项 + 快照洗白更正已落，待复核）

- 产物：`scripts/skin-palette/preview-server.mjs`（**`aaed0dd3…52bf1cc`**，430 行）、
  `test/skin-palette-preview.test.js`（**`c4338d3b…9c66`**，607 行，14 条）。
  M0/M3 模块、生产 server/app/CSS 零改动。
- 固定入口 `startCandidatePreview({ candidate, fixture, port = 0, maxConcurrent })`
  → `{ url, close }`。`candidate = null` 为正式色源验收模式（无模块覆盖）；其他输入
  必须是有效完整 Candidate，**在启动边界同步经 M0 canonicalJson 深拷贝为快照并校验
  快照**（不走 JSON.stringify——那会洗掉非法数据：undefined 字段被删、稀疏数组空位变
  null、Date 变 ISO 字符串），坏候选在监听任何端口之前报错，两个色源模块都由快照
  生成、先于任何服务的创建/监听。双服务架构：
  真实 `createUsageServer` 后端起自 fixture（127.0.0.1:0）+ 前置代理（仅 loopback），
  一实例固定一候选，无可变全局“当前候选”，绝不指向用户端口 3765。
- 八个卡点：① 真实 usage server 起自 fixture，API/统计/app 协议不变；② `/api/*`
  与 `/internal/shutdown` 原样转发自己的后端（路径/查询/方法/body/状态保持一致，
  响应头白名单 content-type + cache-control，请求 body 上限 10MB）；③
  `/skin-palettes.js` 由内存中深拷贝的完整正式 SKIN_PALETTES 替换候选皮肤
  light/dark（扁平 token，非 `{tokens:…}`，其他皮肤不变），输出 ESM；④
  `/skin-bootstrap.js` 用 M1.2 发射器生成同一候选 override，首屏与 runtime 经同一
  M1.1 派生路径配对；⑤ 其他静态文件按扩展名白名单 + URL 解码后路径包含校验从
  `public/` 提供，拒绝穿越与 NUL 字节，不读 `.git`/用户配置/日志；⑥ 不重写 DOM、
  不注入生产分支（M3 观察器留 M4.2 经 init script 安装）；⑦ 候选响应 no-store、
  上限 2 且选项只能收紧、每候选新实例新上下文；⑧ `close()` 的重复/并发调用共享
  同一次真实关闭，fixture 生命周期归调用方。
- **复核更正（2026-10-05，四项全部落地，见 handoffs/REVIEW-M4.1.md）**：①并行启动
  绕过上限 → 名额在第一次 await 前同步占用、失败释放、硬上限 2 不可放宽；②候选未在
  启动边界固定且生成异常泄漏后端 → 快照 + 生成前置 + 异常统一清理释放；③重复 close
  提前返回 → 共享同一关闭 Promise、名额在关闭完成后释放；④超限请求连接重置 →
  立即送 413 状态码 + 丢弃模式（响应保持打开直到 drain，提前 end 会 RST 反而收不到）。
- **快照洗白更正（2026-10-05 更正二）**：更正轮的 JSON.stringify 快照会把非法候选
  洗白（undefined 字段被删、稀疏数组空位变 null、Date 变字符串——原始候选被 M0 拒绝、
  预览服务却放行）→ 改走 M0 `JSON.parse(canonicalJson(candidate))`；新增回归"快照不得
  洗白非法候选"（三种输入拒绝 + 失败后名额可复用；摘要记在洗白后内容上保证回归有牙、
  泄漏守卫保证回退态可退出），既有候选不可变测试原样保留。
- 门禁：preview 专项 **14/14**（连续 3 次复跑全绿 + 门禁终跑）；`npm test` **994 pass /
  0 fail**（exit 0）；typecheck 0；本卡两文件 Biome 零诊断、`biome format` 0、全仓
  `format:check` 0；`npm run lint` 0（43 warnings 均不属本卡）；`skins:check` PASS
  （40 assets）。回退验证：更正二 R5（退回 stringify → 仅洗白回归红）+ 更正轮 4 项
  （名额同步占用、启动边界快照、共享关闭、超限 413）全部咬住对应用例、恢复后逐字一致
  （fixture 五字段校验刻意不做盲回退——会触及用户 HOME，由正向断言钉住），见
  `20261003T185748/handoffs/M4.1.md`。
- 交接给 M4.2 的边界：浏览器/Playwright 不在本卡范围；`maxConcurrent` 只能收紧
  （名额计数进程级全局，选项是每次调用声明的可接受上限）；静态白名单刻意严于生产
  serveStatic；代理只透传 content-type / cache-control；超限响应对永不结束的客户端
  依赖 Node requestTimeout 兜底；坏候选不落任何临时模块文件。
### M3.2 — 浏览器实际色源与背景测量（2026-10-04，DONE——两轮复核更正后放行）

- 首轮定稿为 DONE（2026-10-04），用户两轮复核均**未通过**（首轮六项、第二轮三项
  Canvas 未闭合），第三轮复核**通过**、状态 DONE。两轮更正与针对性回归均已落。
  首轮结论仍成立：五个集成样例与制造案例实测值未变（头 4.6477、metric-label
  5.8496、placeholder 1.7614 fail、聚光 5.8496→4.771→5.8496、Canvas 5.2355、
  制造案例 5.7837→1.7526→4.6477）。历史数字见本节末两段历史记录与交接文档。
- 产物（第三轮前）：`scripts/skin-palette/browser-measure.mjs`
  （**`ae21e8aa…3686`**，1925 行；第二轮前 `688b6559…aa38d`、1878 行；首轮
  `c0598976…27f891`、1564 行）、`test/skin-palette-quality.test.js`
  （**`83394e85…ff0f`**，2907 行，56 条 = M3.1 16 + M3.2 34 = A 层 14 + B 层 19
  + C 层 1 条 6 子测试；第二轮前 `e13ef35a…497a8`、2579 行、49 条；首轮
  `b5914c99…b7f56b`、1929 行、36 条）。M0 文件、skins.js、color-math 与生产
  CSS 依旧零改动。
- 固定导出与首轮相同：`installBrowserColorObserver(page)`（导航前装、addInitScript
  幂等）与 `measureBrowserRoles({ page, candidate, mode, stateId, roleCatalog,
  policy })` → `{ records, captures, diagnostics }`；模块不点击菜单、不建 fixture、
  不导航。
- **首轮机制仍成立**：Canvas 观察器（五法含 fillRect）；颜色交浏览器 1×1 canvas
  双哨兵解析（placeholder 的 `color(srgb … / 0.76)` 只有浏览器能解）；文字路径
  只改 `-webkit-text-fill-color` 隐藏（不动 `color`）、分带扫描、逐样本 alpha
  合成取最差；不可隔离项一律 unmeasured + 原图 + 手工方法；产出逐条过 M0
  validateAssessment 自检；角色截图一律**视口坐标 + 视口内 clip**（fullPage 分带
  会把 sticky 表头钉在每带顶部，背景混进前景）。
- **本轮六项更正**：
  1. 汇总保留全部缺测项——全部不可测 unmeasured；有失败记 fail（失败优先）；
     **没有失败而覆盖不完整记 unmeasured**（已达标的节点不能代表整个角色），
     已测部分最差值仍写进证据。未渲染节点（display:none / visibility:hidden /
     尺寸 0，如 `.metric` 里的 hidden "New" 徽标）没有可测像素，单独记
     `notRenderedCount/Reasons`，不参与覆盖判定也绝不静默删除。
  2. canvas 绘制按角色 kind 分类：文字角色只测 fillText/strokeText、图形角色只测
     fillRect；`evidence.skipped` 逐条记账（角色类型不符 / 非 source-over /
     应用自绘底色层 / 路径型无矩形参数），没有本角色可测绘制 → unmeasured。
  3. 观察坐标是 drawing buffer 像素，取样区域是 CSS 像素：按
     `cssRect / bitmap` 尺寸比换算后再取样，比值记进 `evidence.canvasScale`。
     DPR=2 时 buffer 是 CSS 盒两倍宽——不换算会把 CSS 30px 处的轴标记成 60px，
     取样落到错误区域。既有单测原先把错误换算锁死了，已一并更正。
  4. canvas 清理与恢复都 `save()`/`restore()`：transform/alpha/fillStyle 不再被
     测量改动（此前 transform a=2 会被改成 1）；清理阶段 try/finally，重建底色层
     抛异常也还原；Node 侧 clear 抛错时记 unmeasured 且照常走恢复。
  5. 观察器记帧：`clearRect` / `ctx.reset` / canvas 尺寸赋值记帧边界，读取只取
     当前帧；测量器自己重建底色层的记录标 `injected` 并排除，且不推高应用侧帧号。
  6. 滚动会话按**可滚动余量**登记全部滚动容器（与当前偏移无关——测量前停在 0、
     被 scrollIntoView 带走的容器此前不登记，恢复后仍停在 571），恢复后逐个
     核验，不一致逐条进 `diagnostics.restoration.scrollDifferences`。
- 六项各自的针对性回归见交接文档测试清单；问题 3 做过**回退实验**（尺寸比写死成 1
  确认 B 层两处精算与 C 层 DPR=2 真机子测试都会失败——回归有牙）。
- **第二轮三项更正**（Canvas，均已在真实 Edge 独立复现）：
  1. 当前帧改用观察器的 `frameOf(canvas)`：此前取"记录里的最大帧号"，画布被清空
     或尺寸重置后若没有新绘制，会再次选中旧记录——空白画布也能按旧轴文字返回
     PASS。当前帧零条记录 → unmeasured 并说明"未重绘，不沿用旧帧"，且不清画布
     不截图。
  2. **本角色测不动的绘制计入缺测**：此前 `evidence.skipped` 不参与覆盖判定，
     一个可测 fillRect 加一个路径型 stroke 就让整个图形角色 PASS、ratio=21。
     现在混合合成、缺坐标、宽度 0、路径型 stroke/fill、观察失败都进缺测账，
     走与节点路径同一套 `assembleRoleRecord`（有明确失败仍 fail，否则覆盖不完整
     → unmeasured）；另一角色的绘制与已确认的自绘底色层不计缺口。
  3. `strokeText` 读 `strokeStyle`：此前统一读 fillStyle，黑填白描会按黑色返回
     PASS、ratio=21。前景色按绘制方法取，`colorValue` 与解析结果都写进证据。
  - 同族漏洞一处（本轮自查并闭合）：观察器记录某条绘制时抛错的失败记录原先没有
    画布归属与帧号，被整体丢掉。现在失败记录带 `canvasRef`/`frame`/`injected`，
    按方法名归角色后计入缺测（reason 带 `观察器记录该绘制时出错`）。
  - **实测后果（提请复核拍板）**：应用画坐标轴框用的是 `beginPath()` + `stroke()`
    （app.js 2303-2307，路径型）。按第 2 项口径，`chart.timeline-segment` 现在记
    unmeasured（dense-data 真机实测 11 条已测 + 1 条不可测）；`chart.axis-text`
    同状态仍 pass 5.2355 且 `unmeasuredCount` 0。若认为坐标轴框属"图表框线"，应由
    M0 目录拆角色（如 `chart.axis-frame`），本卡按用户口径不外开例外。
  - 三项 + 同族漏洞共 7 条针对性回归；逐项回退验证见交接文档门禁节（每次把缺陷
    临时改回去，只有对应回归变红，还原后全量复跑回到全绿）。
- 两处执行偏差（卡面/计划预留）：M4.1 服务句柄未就绪，C 层在测试内自备 fixture
  服务、结束即关；交互状态由测试侧摆好。
- 验收证据与门禁见 `20261003T185748/handoffs/M3.2.md`；专项 **56/56**、
  `npm test` **689/0**（exit 0）、typecheck 0、`format:check` 0（全仓，并行会话
  先前的 `src/perf-stats.js` 格式问题已消失）、`lint` 0 error（43 条 warning 全在
  既有 `public/styles.css`）、`skins:check` PASS；本卡两文件 Biome 零诊断。

#### 历史记录（M3.2 首轮 DONE，2026-10-04）

- 首轮产物：browser-measure.mjs `c0598976…27f891`（1564 行）、quality 测试
  `b5914c99…b7f56b`（1929 行，36 条 = M3.1 16 + M3.2 15，后者含真实浏览器集成
  1 条 5 子测试）。
- 首轮五个样例与制造案例实测值见上文；首轮门禁：专项 36/36、`npm test` 611/0、
  typecheck/lint/format 清。
- 首轮遗留的一次偶发失败与截图约定改写过程，已并入交接文档历史记录。

#### 历史记录（M3.2 第二轮复核未通过，2026-10-04）

- 用户第二轮复核：首轮六项大多确认修好（普通节点缺测不再 PASS、文字/图形分流、
  DPR 换算、绘图状态恢复、零偏移容器恢复、未渲染节点单独记账），但 Canvas 仍有
  三处未闭合——清空/尺寸重置后没有重绘仍用旧帧、无法测量的绘制只记账不阻止 PASS、
  `strokeText` 读错前景色，三项均在真实 Edge 独立复现。
- 本轮产物：browser-measure.mjs `ae21e8aa…3686`（1925 行）、quality 测试
  `83394e85…ff0f`（2907 行，56 条）；门禁 专项 56/56、`npm test` 689/0、
  typecheck/format/lint/skins 全清。上一轮（第二轮更正前）为 `688b6559…aa38d`
  / `e13ef35a…497a8`、49 条、专项 49/49、`npm test` 660/0。

### M3.1 — 求解器可调用的快速角色检查（2026-10-04，DONE——复核更正一轮三处后放行）

### M3.1 — 求解器可调用的快速角色检查（2026-10-04，DONE——复核更正一轮三处后放行）

- 产物：新增 `scripts/skin-palette/evaluate.mjs`（复核更正后
  `3111b654…59b8`；首轮 `6f93e509…f1bb`）、`test/skin-palette-quality.test.js`
  （`314557d9…c012`，16 条 = 13 + 复核回归 3）。M0 文件（roles/contracts/
  policy）、skins.js、color-math、solver 与生产 CSS 零改动。
- 行为：固定接口 `evaluatePalette({ skinId, mode, tokens, roleCatalog, policy })`
  → `{ entries, summary }`，纯函数（无 I/O/DOM/随机/时间，纯度测试锁定）。
  色值唯一来源 = M1.1 声明（HEX + 派生 rgba 都解析，陶瓷/hover/active-ink 公式
  零复制）；样式表恒等别名透传（--panel/--track/--toggle-selected）；`--green/
  --red` 从 BASE_COLORS 取值且 classic/character 分支不串用。前景 var/literal/
  alpha/mix-srgb（alpha 替换式、mix premultiplied，与 M1.1 及浏览器 color-mix
  同口径）；solid 精确判定、alpha 前景先与实际背景合成（placeholder 76% 混色
  不用原始 muted）；渐变每段 33 等距样本报最差并 `approximate`（不是只看端点）；
  layered/canvas/computed 前景（§4.4 `{kind:"computed",property,pseudo}` 节点与
  目录现行 null）→ browser-required 不计 fast pass（methodDetail 带浏览器测量
  指引：读哪个属性、哪个伪元素）；未知来源一律 unmeasured 不猜默认色；装饰/
  字标/无阈值例外不入正文 PASS 数；比值完整精度（4.499 仍 fail）；**输出深冻结、
  输入绝不冻结**（sourceRefs 深拷贝后进输出）。导出 `varSourceTokenDeps(name,
  mode)` 依赖表区分固定色（--green/--red 依赖为空 → M2 CONTRACT_CONFLICT 判据）
  与 token 相关失败，每次导出发拷贝（内部表建表即冻结、Object.hasOwn 查找），
  与 M1.1 作 oracle 的敏感集合全等测试锁定两表不漂移。
- 验收证据：专项 16/16（固定接口经真实 ROLE_CATALOG 59 角色过 solver
  runEvaluator 契约——M2 直接导入无第二份阈值实现；solid 近阈值扫描 4.495–4.499
  必败；渐变红→绿亮度凸性凹陷端点双过中段失败 + 灰阶单调对照通过；官方五套
  ×浅深冒烟结构完整/必要角色无 unmeasured/比值可复算；全黑全白扰动证明
  controlText/controlBorder 未生效 token 零敏感）。全套见门禁节（2 失败均为
  并行会话文件、非本卡）；typecheck 0；lint 0 error（43 条既有 warning，本卡
  文件零诊断）；format:check 0。详见 `20261003T185748/handoffs/M3.1.md`。
- **复核更正一轮（2026-10-04，用户复核三处 P2）**：①冻结输出连带冻结输入——
  sourceRefs 直引调用方角色目录、输出 deepFreeze 把输入一起冻住（M2.3
  profileSnapshot 同款教训），改深拷贝；②§4.4 的 computed 前景节点
  （`{kind:"computed", property, pseudo}`，计划 217 行"只从浏览器实际样式取得"）
  首版未接、落进未知表达式判 unmeasured——未交浏览器，改顶层 computed →
  browser-required + property/伪元素路由信息（嵌套 computed 超定义 → unmeasured）；
  ③varSourceTokenDeps 直返模块内部表数组（`Object.freeze` 浅冻结，调用方一次
  原地 sort/push 即污染后续所有求解）——改每次发拷贝 + 表内数组冻结 +
  Object.hasOwn（原型链键一律 null）。三条回归各一（13 → 16 条）。

## 第一轮复核更正（2026-10-03）

用户复核指出三项未闭合发现——原 README 与 M0.4 交接把 M0.2、M0.3 标为 DONE 不成立，
M1 不据此启动。三项已修复并补回归测试，M0 出口待协调者对表复核清单：

1. **M0.2 角色状态缺失**：卡片角色组表第 2 组要求输入类角色覆盖"空输入、填值、focus"，
   但 focus 此前只由 keyboard-focus（按钮 #addImportButton）覆盖 → STATE_CATALOG
   新增 `input-focus`（#pricingSearch；input 的 :focus 可脚本稳定触发）。
2. **M0.2 --gold 与 BASE_COLORS 不一致**：卡片规定 BASE_COLORS 只登记"被必要角色
   引用"的固定色；--gold 零消费且 roles.mjs 注释自称"不在此登记"，数据却登记了它；
   同类零引用的 --toggle-muted 一并处理 → 两色从四分支移除，ROLES_VERSION 1→2，
   hashRoleInputs 纳入 BASE_COLORS（固定色变更同样使旧评审失效）。
3. **M0.3 契约校验漏洞**：candidate 的 `id` 缺失时校验被整体跳过、candidateSet 的
   `candidateSetHash` 缺失时不报错、FailureRecord 的 worstRatio/threshold 接受 NaN
   → 三处改为必填/仅接受有限值或 null，各加回归测试。
4. 另修 M0.4：fixture `close()` 原先在删除前置位 closed，删除失败后无法重试
   → 改为删除成功后才置位。

第一轮修复后摘要：roles.mjs `7e91711a…64e6c55`、contracts.mjs `15a149a9…2f54b8`、
契约测试 `68d41aa6…58bde14`、fixture `1d4a164e…d2130e`（已被第二轮更正取代，见下）。

## 第二轮复核更正（2026-10-03）

用户第二轮复核列出 M0.2 状态目录缺口、九处交叉引用失配与 M0.3 契约漏洞，逐项修复；
状态值改用总计划限定的 DONE | BLOCKED | NEEDS_REVIEW：

- **M0.2 四个空状态角色落地**：empty.state-text→`empty-range`（导航至无数据的 2026-01，
  `.empty` 可见就绪）、status.autorefresh-error→`autorefresh-error`（#autoRefreshToggle
  默认开启，M4 令 /api/usage 轮询失败、还原路由后自清）、deco.skin-preview-samples→
  `skin-previews-visual`（#skinDialog 展开才测，装饰态不计正文 PASS 数）、
  deco.bar-fill-fallback→`bar-fill-visual`（选『全部』后 `.bar-fill` 存在，装饰态）；
  四角色 applicability 同步改写。
- **九处 role.states ↔ state.expectedRoleIds 失配闭合**（按"补进或移除"）：dense-data 补
  table.comparison-header / table.comparison-cell / chart.axis-text；dashboard-default 补
  button.secondary；dialog-pricing-open 补 button.primary + button.secondary；
  calendar-range 补 hint.calendar-hint；input.value 移除 dialog-pricing-open；
  preset.quota-mode-selected 移除 preset-selected。反向缺口（input-focus 的
  input.placeholder / focus.outline 未被回指）同样闭合——双向互为镜像 + 无空状态角色
  由契约测试锁定。
- **dashboard-default 非零就绪**：steps 选『全部』预设，ready 新 kind `nonZeroText`
  解析 `.metric strong` 文本数值（仅数元素不能证明非零），不依赖"今天有数据"。
- **calendar-range 固定日期**：2026-09-26 → 2026-09-28（`.date-picker-day[data-date=…]`），
  ready 要求终点日带 `.range-end`（原 exists 判定在起点选中即成立，过早）；restore 用
  `[data-date-picker-clear]`。
- **--toggle-selected 剔除出 BASE_COLORS**：styles.css 2539-2544 覆盖为 var(--blue)，
  随强调色联动、非固定色；toggle.language-selected / toggle.autorefresh-on applicability
  同步为"有效色 = var(--blue)"。theme-dark 补 note（模式修饰状态，expectedRoleIds
  故意为空）；.theme-toggle.active 触发点定位 app.js 108/117，图标 aria-hidden 纯装饰，
  不新增角色。
- **M0.3 七处契约缺口**：canonicalJson 拒绝 Date/Map/类实例与稀疏数组；绝对路径校验
  覆盖盘符/UNC/POSIX；pass/fail threshold 须为有限数值；unmeasured[] 非空计入缺测
  （readiness="ready" 矛盾被拒）；FailureRecord 的 skinId/variant 字段必须存在
  （成对失败可显式 null）；空对象 profile 拒绝；`versions.roles` 与 ROLES_VERSION
  一致性入 validatePolicy（policy.json roles 1→2）。

STATE_CATALOG 21 → 25；契约测试 29 → 34；ROLES_VERSION 保持 2（同一未发布更正批次）。
两轮更正后摘要：roles.mjs `f0744057…93c19`、contracts.mjs `896b1855…4defc3d`、
policy.json `feeb8a3a…ea25a`、契约测试 `8edbbac3…5e5e6`、fixture `1d4a164e…d2130e`
（未再改）、fixture 测试 `1ceb7839…331e0`（未再改）。

## 门禁（M4.1 快照洗白更正轮后，当前状态）

`npm test` **994 pass / 0 fail**（exit 0；preview 专项 **14/14** ×3 次复跑全绿 +
门禁终跑，quality 专项 **90/90**）。typecheck 0；本卡两文件 Biome 零诊断、
`biome format` 本卡两文件 0、全仓 `format:check` 0；`npm run lint` exit 0（43
warnings 均不属本卡两文件）；`skins:check` PASS（40 assets）。M4.1 产物：
preview-server.mjs `aaed0dd3…52bf1cc`、测试 `c4338d3b…9c66`。回退验证 R5（快照
退回 JSON.stringify → 仅"快照不得洗白非法候选"红）咬住、恢复逐字一致。

## 门禁（M4.1 复核更正轮后，历史记录）

`npm test` **993 pass / 0 fail**（exit 0；preview 专项 **13/13** ×5 次复跑全绿，
quality 专项 **90/90**）。typecheck 0；本卡两文件 Biome 零诊断、`biome format`
本卡两文件 0、全仓 `format:check` 0；`npm run lint` exit 0（43 warnings 均不属
本卡两文件）；`skins:check` PASS（40 assets）。M4.1 产物：preview-server.mjs
`08a6554d…991b5`、测试 `28d128e8…7b98`。复核更正轮回退验证 4 项（名额同步占用、
启动边界快照、共享关闭 Promise、超限 413）全部咬住、恢复逐字一致。
该轮产物经用户复核发现快照洗白契约漏洞，已被快照洗白更正轮取代。

## 门禁（M4.1 首轮实施后，历史记录）

`npm test` **983 pass / 0 fail**（exit 0；preview 专项 **10/10**，quality 专项
**90/90**）。typecheck 0；本卡两文件 Biome 零诊断、`biome format` 本卡两文件 0、
全仓 `format:check` 0；`npm run lint` exit 0；`skins:check` PASS（40 assets）。
M4.1 产物：preview-server.mjs `eeb8177a…14ce`、测试 `43c03cb4…188d`。
此前一轮套件的 perf-state / typecheck 失败属并行会话 WIP，对方修好后复跑全绿。
该轮产物经用户实测复核发现 4 项问题（见 handoffs/REVIEW-M4.1.md），已被更正轮取代。

## 门禁（M3.4 放行前终态，历史记录）

`npm test` **947 pass / 0 fail**（exit 0；quality 专项 **90/90** = 83 顶层用例
（M3.1 16 + M3.2 34 + M3.3 10 + M3.4 24）+ M3.2 真机用例内 6 个子测试）。typecheck 0；
本卡两文件 Biome 零诊断（`biome check` 无输出）、`biome format` 本卡两文件 0、
全仓 `format:check` 0；`npm run lint` exit 0，43 warnings（均不属本卡两文件）；
`skins:check` PASS（40 assets）。M3.4 产物：assess.mjs `705b5cdb…a2c2`、
测试 `a1547333…04d6`。

## 门禁（M3.4 第三轮复核更正后，历史记录）

`npm test` **936 pass / 1 fail**（唯一失败在并行会话未跟踪的 `test/perf-dsh.test.js`；
quality 专项 **89/89** = 83 顶层（M3.1 16 + M3.2 34 + M3.3 10 + M3.4 23）+
6 个子测试）。typecheck 0；本卡两文件 Biome 零诊断、`biome format` 本卡两文件 0
（全仓 `format:check` 当时仍红于并行会话未跟踪的性能文件）；lint exit 0，43 warnings；
`skins:check` PASS。M3.4 产物：assess.mjs `ff9eb3a0…84e4`、测试 `a87077ae…d484`（该轮 `REQUIRED_SOURCE_FILES` 扩到 16 个文件、专项 90/90、npm test 947/0）。

## 门禁（M3.4 复核五问更正后，历史记录）

`npm test` **869 pass / 0 fail**（exit 0；quality 专项 **87/87** = M3.1 16 +
M3.2 34 + M3.3 10 + M3.4 21，M3.2 含真实浏览器 1 条 6 子测试）。typecheck 0；
本卡两文件 Biome 零诊断（`biome check` 无输出）、全仓 `biome format` 0；
`npm run lint` 0 error / 43 warnings（均不属本卡两文件）；`skins:check` PASS
（40 assets）。M3.4 产物：assess.mjs `8767d0cb…7863`、测试 `412d2c9f…f474a1`。

## 门禁（M3.4 首轮实施后，历史记录）

`npm test` **751 pass / 0 fail**（quality 专项 **82/82** = M3.1 16 + M3.2 34 +
M3.3 10 + M3.4 16）。typecheck 0；本卡两文件 Biome 零诊断；全仓 `format:check`
当时失败于 `src/dsh-usage.js`、`src/perf-sources/dsh.js`（并行会话 WIP，其后由
对方修好，本轮已 0）；`npm run lint` 0 error / 43 warnings。assess.mjs
`d6d23bd7…39b4d`、测试 `08cb1090…e07d8`。

## 门禁（M3.2 首轮复核更正一轮后，历史记录）

`npm test` **660 pass / 0 fail**（exit 0；quality 专项 **49/49** = M3.1 16 +
M3.2 33，后者 = A 层 12 + B 层 14 + C 层 1 条 6 子测试）。套件总数比首轮（611）
多 49 条：本卡 +13，其余为并行会话同期新增。typecheck 0；本卡两文件 Biome
零诊断（`biome check` 与 `biome format` 均无输出）；全仓 `format:check` 当前
**失败**，唯一失败点是 `src/perf-stats.js`（并行会话 WIP，不属本卡允许清单）。
专项连续四次复跑全绿（含一次三连跑）。M3.2 产物：browser-measure.mjs
`688b6559…aa38d`、测试 `e13ef35a…497a8`。

## 门禁（M3.2 首轮实现后，历史记录）

`npm test` **611 pass / 0 fail**（quality 专项 **36/36** = M3.1 16 + M3.2 15；
套件含并行会话持续新增用例——本卡首跑为 609 pass / 2 fail，两失败均在并行会话的
perf-probe 文件、不引用 skin-palette，其后并行会话收尾转绿，复跑 611/0）。
typecheck 0；lint 0 error（43 条 warning 全为 public/styles.css 既有特异性提示，
本卡两文件零诊断）；format:check 0（本卡两文件经 `biome check --write` 后零残留）。
专项连续三次复跑全绿；历史记录里 C 层曾偶发失败一次——根因是 Playwright 对
sticky 元素的分带捕获伪影（纯滚动 + 截图即可复现 214 px 差异且 DOM 零变更），
已把该断言换成"逐节点样式/几何 + 画布 bitmap + DOM/偏好/root 颜色快照"的精确组合。
M3.2 首轮产物：browser-measure.mjs `c0598976…27f891`、测试 `b5914c99…b7f56b`。

## 门禁（M3.1 复核更正一轮后，历史记录）

`npm test` **578 pass / 2 fail**（quality 专项 16/16 = 首轮 13 + 复核回归 3）；
**两失败均非本卡文件且不引用 skin-palette（grep 0）**：test/perf-probe-zcode.test.js
（"TTFT 列名不在册"——并行会话已把 first_token_at 加进外壳白名单、测试受阻项
说明未同步，隔离复跑稳定复现）与 test/perf-probe-codex.test.js（"M0.6-A 计数
键"——并行会话在改文件，各轮换着报，server/dsh 同轮抖动、隔离复跑全绿）。
typecheck 0；lint 0 error（43 条 warning = 39 条 styles.css 既有 + 2 条
solver 测试 M2.3 遗留 + 2 条并行 WIP；本卡两文件零诊断）；format:check 0。
本卡产物（复核更正后）：evaluate.mjs `3111b654…59b8`、测试 `314557d9…c012`；
更正内容：sourceRefs 深拷贝（输出冻结不冻输入）、§4.4 computed 前景节点交
浏览器（browser-required + 伪元素路由）、varSourceTokenDeps 导出发拷贝（内部
表冻结 + hasOwn）。

## 门禁（M3.1 首轮实现后，历史记录）

`npm test` **576 pass / 0 fail**（quality 专项 13/13；套件含并行会话持续新增
用例，570/0 为本卡首跑、547/0 为 M2.4 复核更正后结果）；typecheck 0；
lint 0 error（43 条既有 warning = 41 条基线 + 2 条并行 WIP：test/dsh-usage.test.js
未用导入、styles.css 新增行；quality 两文件零诊断）；format:check 0。本卡产物：
evaluate.mjs `6f93e509…f1bb`、测试 `0606dd9c…de3f`。

## 门禁（M2.4 复核更正一轮后，历史记录）

`npm test` **547 pass / 0 fail**（M2 专项 48/48 = M2.1 11 + M2.2 16 + M2.3 8 +
M2.4 13；套件含并行会话持续新增用例，543/0 为 M2.4 首轮实现时结果）；typecheck 0；
lint 0（41 条既有 warning = 基线）；format:check 0；`skins:check` PASS（40
assets）。本卡产物：generate-cli.mjs `013dcb13…0941`、测试 `b2f943b5…1c1c`；
更正内容：输出目录 junction 真实路径双检 + mkdir 后复检、policy 过
validatePolicy、写入失败回滚本次文件、实际评估器模块进 sourceHashes（run.json
新增 evaluator 来源字段）。

## 门禁（M2.4 首轮实现后，历史记录）

`npm test` **543 pass / 0 fail**（M2 专项 44/44 = M2.1 11 + M2.2 16 + M2.3 8 +
M2.4 9；套件含并行会话持续新增用例，480/0 为 M2.3 清理轮时结果）；typecheck 0；
lint 0（41 条既有 warning = 基线）；format:check 0；`skins:check` PASS（40
assets）。本卡产物：generate-cli.mjs `4d982c97…76c`、测试 `b8ca181d…731`；
generate.mjs 三处文案按 M2.3 交接重新应用（并行编辑器回退事故，
`da4a5712…9a10` → `d276ba07…3543`，语义零改动）。

## 门禁（M2.3 第二轮复核更正 + 非阻塞清理后，历史记录）

`npm test` **480 pass / 0 fail**（M2 专项 35/35 = M2.1 11 + M2.2 16 + M2.3 8；
套件含并行会话持续新增用例，473/0 为第二轮更正完成时结果）；typecheck 0；
lint 0（41 条既有 warning = 基线）；format:check 0；`skins:check` PASS（40
assets）；三改动文件 biome check 0。清理内容：generate.mjs 模块 docstring 与
solveFailureRecord JSDoc 同步为预算证据新语义（哈希 `0c804bcd…cf883` →
`da4a5712…9a10`，逻辑零改动）。

## 门禁（M2.3 第二轮复核更正后，历史记录）

`npm test` **473 pass / 0 fail**（M2 专项 35/35 = M2.1 11 + M2.2 16 + M2.3 8）；
typecheck 0；lint 0（41 条既有 warning = 基线）；format:check 0；`skins:check`
PASS（40 assets）；三改动文件 biome format/check 0。

## 门禁（M2.3 第一轮复核更正后，历史记录）

`npm test` **439 pass / 0 fail**（专项 33/33）；typecheck 0；lint 0；`skins:check`
PASS；三改动文件 biome format/check 0；format:check 全套退出码 1——唯一报错在
`test/perf-probe-cli.test.js`（当时用户并行 WIP 未跟踪文件，其后已由用户侧修复）。

## 门禁（M2.3 完成后，首轮——历史记录）

`npm test` **439 pass / 0 fail**（M2 专项 33/33 = M2.1 11 + M2.2 16 + M2.3 6）；
typecheck 0；lint 0（41 条既有 warning = 基线）；format:check 0；`skins:check`
PASS（40 assets）；三改动文件 biome check 0。

## 门禁（M2.2 复核更正后）

`npm test` **433 pass / 0 fail**（专项 27/27 = M2.1 11 + M2.2 16）；typecheck 0；
lint 0（41 条既有 warning = 基线）；format:check 0；`skins:check` PASS（40 assets）；
两改动文件 biome check 0。

## 门禁（M2.2 完成后）

`npm test` **430 pass / 0 fail**（新增求解器 13 条，专项 24/24）；typecheck 0；
lint 0（41 条既有 warning = 基线）；format:check 0；`skins:check` PASS（40 assets）。
首轮 425/430 为 5 项 server/cli/pricing 停止握手超时（并行负载瞬时抖动，隔离复跑
19/19、9/9、24/24 + 全套复跑 430/0），历史记录；该版交接所记"biome 0"不实（见
M2.2 复核更正）。

## 门禁（M2.1 完成后，含复核更正）

`npm test` **417 pass / 0 fail**（新增求解器模板 11 条）；typecheck 0；lint 0
（41 条既有 warning = 基线）；format:check 0（M1.4 块 HEX 小写更正后）；
`skins:check` PASS（40 assets）。首版门禁 416/0，历史记录。

## 门禁（M1.5 完成后）

`npm test` 406 pass / 0 fail（工作台不被任何测试加载，证据为隔离 origin 实测）；
typecheck 0；lint 0（41 条既有 warning = 基线）；format:check 0；工作台两文件
biome check 0。

## 门禁（M1.4 完成后）

`npm test` 406 pass / 0 fail（本卡无新增测试——CSS 覆盖块 + BASE_COLORS 数据同步，
实测证据为隔离 fixture）；typecheck 0；lint 0（41 条既有 warning = 基线）；
format:check 0；`skins:check` PASS（40 assets, 40 URLs, manifest and bootstrap fresh）。

## 门禁（M1.3 复核更正后）

`npm test` 406 pass / 0 fail（颜色数学 9 条——含健壮性回归；bootstrap 发射器 9；
skins 36；皮肤面板 37）；typecheck 0；lint 0（41 条既有 warning = 基线）；
format:check 0。

## 门禁（M1.3 完成后）

`npm test` 405 pass / 0 fail（新增颜色数学 8 条；bootstrap 发射器 9；skins 36；皮肤面板 37）；
typecheck 0；lint 0（41 条既有 warning = 基线）；format:check 0。

## 门禁（M1.2 完成后）

`npm test` 397 pass / 0 fail（bootstrap 发射器 9 条——含原型链自有属性回归；skins 36；
皮肤面板 37）；typecheck 0；lint 0（41 条既有 warning = 基线）；format:check 0；
`skins:check` PASS。

## 门禁（M1.1 完成后）

`npm test` 388 pass / 0 fail（皮肤面板 37 = 契约 34 + fixture 3；skins 36）；typecheck 0；
lint 0（41 条既有 warning = 基线，本次改动文件零诊断）；format:check 0（60 files）。

## 门禁（第二轮复核更正后）

`npm test` 384 pass / 0 fail（皮肤面板 37 = 契约 34 + fixture 3）；typecheck 0；
lint 0（41 条既有 warning = 基线，本次改动文件零诊断）；format:check 0（60 files）。

## 遗留与风险

- M3.2 的浏览器实测在本机无需配置：Playwright 走 `AGENT_USAGE_PLAYWRIGHT_MODULE`
  或 codex 运行时缓存路径，Edge 走已知安装位置；换了机器两者皆无时按契约降级
  `ENVIRONMENT_BLOCKED`（C 层测试内置该断言）。M4 接入同一套解析即可。
- `validateProfiles` 目前为信封级校验，字段与单位等 M5.1 定稿后扩展。
- 代表色锚定表（管线计划 §3）为草案，待用户校正后冻结为 M1 输入。
- 并行会话持续改动工作区（static-export 移除、docs 归档等）：本运行以实际工作区为基线，
  不回退、不触碰他人 hunk。

## 更新纪律

每张卡完成：handoff 落盘 `handoffs/`，并同步更新本 README 的进度表、该卡要点与门禁数字；
M4 起补充截图路径与 `report.html` 链接。

## 2026-10-05 交接整理与 M4.1 复核

7 份较早阶段交接原样移入 `20261003T185748/handoffs/archive/2026-10-05/`，移动前后摘要一致，本文引用已同步。当前接线所需记录继续保留，见[交接索引](20261003T185748/handoffs/README.md)。

M4.1 维持 NEEDS_REVIEW；并发启动上限、候选启动快照与失败清理、并发 close 完成语义、超限请求 413 共 4 项须修复，详见[本轮复核](20261003T185748/handoffs/REVIEW-M4.1.md)。本轮专项 10/10、全仓 983/983，typecheck/lint/format:check 退出 0，skins:check PASS；测试通过尚未覆盖上述实测问题。未改实现、未启动 M4.2。

## 2026-10-12 M5.2.C-D7a / D7b / D7c / D7d / D7e / D8b-sort / D8c-sort / D8d-badge-data / D8e / D8f2 / D8g / D8h

D8b-sort 已单独接入排序指示状态：`indicator.sort` 只属于 `comparison-sort-active`，并列入 S5；roles/policy 版本 7，状态 29 项、矩阵每模式 35 项。contracts 44/44、preview 定向 2/2、五文件 Biome 与 JS 语法检查通过；接线已由主管接受。

D8c-sort 对官方 ChatGPT `candidate:null` 的 `comparison-sort-active` × light/dark 各执行一次真实 Edge 测量；两个模式均 `fail`：light 2.0172:1、dark 2.1106:1（阈值均为 4.5:1），覆盖各为 1 measured、0 unmeasured、7 个 display:none 节点逐一记为 `notRendered`。两模式均留有箭头初始隐藏→降序可见→restore 升序可见→默认隐藏的 DOM/`aria-sort` 与截图证据。22 项源码和 pricing 摘要不变，无页面/console/请求错误；Edge、预览服务、fixture 清理通过。D8c-sort 保持 `NEEDS_REVIEW`，未改颜色；证据见 [M5.2.C-D8c-sort](20261003T185748/handoffs/M5.2.C-D8c-sort.md) 与 [verification.json](20261003T185748/integration/m52-c-d8c-sort/verification.json)。

D8d-badge-data 复用隔离 fixture，经直接 `UsageStore.sync()` 和 `recordsForRange()` 检查 `2026-09-28 00:00` 至 `2026-10-04 23:59:59.999` Asia/Shanghai（custom、`excludeHomes: []`）。真实返回 `totalTokens` 纪录是 `day / 2026-10-01 / 54,800`；同范围实际周冠军为 `2026-09-28 / 183,000`，但 day→week→month 优先级使日纪录先返回。无范围限制的 store 结果也有日纪录；`summarize(preset=all)` 的 `records` 为空，且 `renderRecordBadges` 在 all 状态会强制隐藏徽标。来源的 22 项 D8c 摘要和 4 项额外摘要稳定，SQLite 关闭、fixture 临时目录删除；无浏览器/HTTP。D8d `NEEDS_REVIEW` 只代表数据前置已验证，徽标显示/光晕隔离/颜色仍待后续卡。详见 [M5.2.C-D8d-badge-data](20261003T185748/handoffs/M5.2.C-D8d-badge-data.md) 与 [result.json](20261003T185748/integration/m52-c-d8d-badge-data/result.json)。

D8e 固定 `badge.record` 的分类、触发状态与 S5 矩阵契约，但 ready selector 的嵌套 `:has()` 后由真实 Chromium 证实为非法，因此 D8e 接线重新 `NEEDS_REVIEW`。D8f2-R1 的 7×7 圆点中央 3×3 采样、遮挡与隐藏节点分类逻辑已接受；不代表真实圆点达到 3:1。D8g 的 source/fixture/pricing 预检通过；Chromium 在任何日期动作前拒绝旧 ready selector，`measureBrowserRoles` 调用数为 0，浅色未测、深色未启动。Edge PID、端口和 fixture 已清理；22 项、4 项额外来源与 pricing 摘要稳定。主管接受 D8g 阻断记录仅作为执行与清理证据，不含颜色结论。D8h 将 selector 修正为合法分段写法、roles/policy 升至 9，并用单一静态 Edge 155 上下文原生编译目录内全部 30 项 ready selector；闭层目标徽标、打开弹层、隐藏目标徽标和仅其他卡徽标可见四项断言通过，旧嵌套写法抛出 `SyntaxError`，零页面请求且 PID 退出。contracts 47/47、preview 定向 5/5、Chromium 1/1 无跳过，四文件 Biome 与三文件语法检查通过；D8g live 测量尚未重跑，D8h 保持 `NEEDS_REVIEW`。详见 [M5.2.C-D8g-badge-live](20261003T185748/handoffs/M5.2.C-D8g-badge-live.md)、[D8g verification](20261003T185748/integration/m52-c-d8g-badge-live/verification.json)、[M5.2.C-D8h-ready-fix](20261003T185748/handoffs/M5.2.C-D8h-ready-fix.md) 与 [D8h verification](20261003T185748/integration/m52-c-d8h-ready-fix/verification.json)。

D8l 以一次 Edge 浏览器、两个静态 context 和两张 PNG 对照 fullPage/viewport 截图，未调用测量器、未访问网络、未启动官方页面。fullPage 截图前后 `visualViewport.width` 与 html/body clientWidth 从 1905 变为 1920，main 与 7px 徽标右移 7.5px，并持续到三帧后；viewport 截图无几何变化。纯 Node 使用实际 hide/restore/release-attempt 源验证四种 style 场景的两条恢复路径（8/8），确认原属性缺失时 `null` 可变成 `""`，现有逐声明恢复检查仍通过；同时验证重要优先级与隔离期间新添的无关声明均保留。主管已接受这份诊断证据；它不判定 Chromium 根因或生产页面变化。结果与原始证据见 [D8l handoff](20261003T185748/handoffs/M5.2.C-D8l-screenshot-control.md)、[run.json](20261003T185748/integration/m52-c-d8l-screenshot-control/result-r1/run.json) 与两张[静态截图](20261003T185748/integration/m52-c-d8l-screenshot-control/result-r1/static-fullPage.png)。

D8m 仅在正式 token 会话中记录 style 属性原始存在性，并在 normal restore 与 `release-attempt` 逐声明恢复后有条件清理空属性；verify 会报告残留的空属性，而原显式空属性与新增无关声明均保留。旧 selector/index 行为和接口不变。真实 `measureBrowserRoles` 截图异常 finally、四场景 × 两路径及 D8j/D8f1/D8f2 相关回归共 22/22，双文件 Biome 和 node --check 通过。`browser-measure.mjs` 是 22 项捕获 `SOURCE_FILES` 之一，其新摘要会使绑定旧摘要的捕获过期；本轮未重捕。`public/app.js` 与 `public/i18n.js` 当前还出现并行来源差异，本卡未改动。D8m `NEEDS_REVIEW`，没有浏览器实测或几何修复。详见 [D8m handoff](20261003T185748/handoffs/M5.2.C-D8m-style-restore.md)。

D7a 对 T4/ChatGPT a 原 CLI 中 18 条角色缺测完成只读归因，已由主管限定范围接受。D7b 按归因接线：`summary.trend-up` 绑定固定 `calendar-range`，`summary.trend-down` 绑定 2026-09-29→30 的新状态 `comparison-trend-down`，`calendar.day-range-both` 绑定 9 月 28 日连续选择两次的新状态 `calendar-same-day`；三者均在角色目录与实际 S2 矩阵中双向登记。状态目录现有 27 项，捕获矩阵每模式 33 个单元，`ROLES_VERSION` 和 policy roles 版本为 5。D7b 限定接线范围已由主管接受。

D7c 对当前官方 ChatGPT `candidate:null` 顺序完成三状态 × 浅深六项真实 Edge 测量：五项 `fail`、一项 `pass`。light 上行 4.1446:1、light 下行 4.6732:1、light 同日 3.3151:1；dark 上行 3.7651:1、dark 下行 3.1981:1、dark 同日 3.5243:1（统一阈值 4.5）。开日历时摘要区第二个上行趋势值被浮层遮挡；两种模式均留有一节点 `unmeasured` 的原始遮挡证据，角色结论仍因另一个实测节点低于阈值而为 `fail`。六项恢复与资源清理通过，22 项源码及额外 pricing 摘要前后稳定。主管已接受 D7c 执行与证据留存，五项失败及两个遮挡缺测保留；这不代表审美通过或历史 18 条 gap 关闭。详见 [M5.2.C-D7c](20261003T185748/handoffs/M5.2.C-D7c.md)。

D7d 新增闭弹层 `comparison-trend-up`，把 `summary.trend-up` 从 `calendar-range` 移入独立状态，并接入 S2 摘要测量单元；roles/policy 版本升至 6，状态目录 28 项、矩阵每模式 34 项。contracts 42/42、preview 定向 5/5、五文件 Biome 与四文件语法检查通过，主管已接受限定接线范围。详见 [M5.2.C-D7d](20261003T185748/handoffs/M5.2.C-D7d.md)。

D7e 按新状态对官方 ChatGPT `candidate:null` 的上行摘要执行 light/dark 两单元真实 Edge 测量。两模式均为 2 measured、0 unmeasured，两节点各 5/5 命中检查通过；light 4.1446:1、dark 3.7651:1，均低于 4.5 阈值而保留 `fail`。恢复、浏览器错误/外部请求、Edge/端口/fixture 清理及 22 项来源前后摘要均通过。D7e `NEEDS_REVIEW` 交主管复核；不代表配色通过或开始 M6。详见 [M5.2.C-D7e](20261003T185748/handoffs/M5.2.C-D7e.md)。
