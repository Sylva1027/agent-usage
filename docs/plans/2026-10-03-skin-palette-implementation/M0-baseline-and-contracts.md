# M0：基线、颜色角色与交接契约

前置：阅读[总计划](../2026-10-03-skin-palette-implementation-plan.md)及[融合方案](../2026-10-03-skin-palette-consolidated-plan.md)。本模块共 4 张卡，不改任何产品行为。M0.1/M0.2 可按总计划 2.1 并行开始；M0.2 定稿前与 M0.1 基线对齐，全部 M0 交付核对完成后再进入 M1。

允许文件：`scripts/skin-palette/contracts.mjs / roles.mjs / policy.json`、`test-support/skin-palette-fixture.mjs`、`test/skin-palette-contracts.test.js`，以及本次运行的基线与 handoff。M0.3 允许协调者有限修改 `biome.json` 的检查范围；生产代码只读。

## M0.1 工作区与行为基线

**目标：** 后续能证明哪些行为保持，哪些颜色确实被重新设计；不把 HEAD 当作当前工作区完整内容。

步骤：

1. 记录 `git rev-parse HEAD`、相关文件的工作区/暂存区状态、Node/npm/浏览器版本。每个相关源文件记录工作区 SHA-256；有并行修改时把实际内容作为基线，不回退文件。
2. 核对十套注册顺序、12 个 token、20 个允许 CSS 变量、当前选择器五款、默认 classic、50% 角色透明度、现有角色定位和聚光强度。将确切值写入 `baseline.json`。
3. 保存现有十套完整浅深 token 与生产 `paletteDeclarations` 结果，作为前后对照。保存值不意味着锁定旧风格。
4. 只读核对 `skin-ui.js` 的应用/清除、bootstrap 的首屏顺序、`app.js` 的主题和图表路径、工作台注入、选择器迷你预览。标出实际使用与旧注释不一致的部分。
5. 记录检查命令的当前适用范围：现有 typecheck 只覆盖 `src/**/*.js`，Biome 默认文件集不覆盖所有 `scripts/`。后续不能声称新增工具因运行旧 typecheck 自动受检。

验收：`baseline.json` 明确包含旧色值、派生值、文件摘要、选择器范围和工具环境；记录当前检查的失败/告警，不清理历史问题。此卡不需要浏览器截图，截图待 M4 的隔离环境完成。

交接给 M0.2：哪些变量真正生效、哪些仅被接受、有哪些固定色和颜色混合。至少点出 `controlText/controlBorder`、图表分类色、工作台重复派生、迷你预览旧字段名。

## M0.2 实际颜色角色清单

**目标：** 后续 agent 不自行决定只测哪些好测的组合。

并行条件：可与 M0.1 同时只读调查并编写草稿，输入形状先遵循总计划 4.4；只写本卡的 roles、handoff 和调查证据。最终验收须读取 M0.1 的 baseline，核对相关源摘要和接线结论，完成后才能标 DONE。不得写 baseline、contracts、policy 或抢改公共运行记录。

实现 `roles.mjs`，导出冻结的 `ROLE_CATALOG / STATE_CATALOG / BASE_COLORS`。BASE_COLORS 形状固定为 `{ character: { light, dark }, classic: { light, dark } }`，各分支是 CSS 变量名到实际颜色的字典；记录不由 20 项声明控制、且被必要角色引用的颜色，不能凭空填色。M0 时 character/classic 的状态色相同，M1.4 可只更新 character.light。每条角色至少有总计划约定字段，源码位置采用文件路径和选择器/函数名；行号仅作为辅助，不成为稳定主键。

最少覆盖下列角色组，并检查 CSS 后半段最终覆盖规则：

| 角色组 | 前景与有效背景 | 必需状态 |
| --- | --- | --- |
| 页面/面板正文、指标、说明、长名称 | `--ink / --muted` 对实际平面或三段陶瓷渐变 | dashboard 默认、稠密数据 |
| 输入值与占位文字 | 实际 `color`；placeholder 为 `--muted` 76% 的透明混色 | 空输入、填值、focus |
| 普通按钮与菜单文字 | 实际 `--ink / --muted / --blue` 对按钮渐变或凹槽 | 默认、hover、focus、selected |
| 强调色小字/图标/填充按钮 | `--blue` 的文字 4.5；必要图形 3；`--active-ink` 对强调填充 4.5 | 选中预设、切换控件、主要按钮 |
| 表格、日历、设置、导入与计价弹窗 | 真实前景与各自凹槽/面板/选中混色 | 打开、选中、错误或提示 |
| 图表文字和数据图形 | `fillText` 实际颜色；必要数据颜色对实际画布背景 | 有非零多系列的 model/channel 图 |
| 状态说明 | 固定 `--green / --gold / --red` 及相关 alpha 混色 | 成功、待定/缺价、错误 |
| 焦点/控件识别 | 实际 outline、描边、选中标记；只对承载必要识别信息者要求 3 | 键盘 focus、selected |
| 装饰与品牌字标 | 光影、非必要网格、角色、压印 `Agent Usage` 标题 | 单独视觉记录，不加入正文 PASS 数 |
| 聚光影响区 | 既有径向强调色叠加后的背景 | 聚光开/关，角色关/50%/100% |

具体要求：

1. 每个实际角色有稳定 ID，如 `input.placeholder / preset.selected-label / chart.model-label`；一个角色可匹配多个节点，报告最差节点。
2. `states` 指向状态清单。状态清单写明触发控件、就绪条件、预期元素和恢复动作；不能只有“测试弹窗”四个字。
3. 区分 `background` 的 `solid / linear-gradient / layered / canvas`；快速检查不支持的叠加标记 `browser-required`。
4. 小字默认 4.5。只有已核实字号/字重的大字才用 3；不要给指标统一降档，也不要把阴影或泛光加到前景亮度里。
5. placeholder 必须按实际 alpha 合成。装饰/禁用/字标例外必须写出具体对象与理由；例外不根据候选失败动态增加。
6. 图表分类色先核对是否有等价的文字/数值表达，再确定哪些数据图形承担必要信息。缺少依据时保留待核验，不直接声称“有图例就都豁免”。
7. 核查固定状态色在允许背景范围内的可达最高对比。绿色/红色必要小字的问题先交 M1.4 的已限定分支；其他不可达项写 `CONTRACT_CONFLICT`，不让生成器反复改无关 token。当前 `--gold` 在 CSS 中只有定义、没有消费位置，不凭变量名虚构黄色文字角色；未来发现真实用途再登记。
8. 记录 CSS 颜色读取、Canvas 颜色分配和所有不受 12 个 token 控制的必要角色。对无法自动可靠测量的元素保留手工测量要求。

验收：每个上述组都有实际源码证据和状态对应；没有“原始 token 达标但实际角色没列”的空洞 PASS。角色清单由协调者核对后作为 M2—M4 的共同输入；修改清单时增加版本和摘要，使旧评审失效。

## M0.3 数据契约、政策与失败记录

**目标：** 固定各模块交换的对象、摘要和出口，避免每个 agent 自造 JSON。

在 `contracts.mjs` 实现：

- `SCHEMA_VERSION = 1`，固定十套 ID、两种 mode、a/b/c 变体；生产 token 键从 `public/skins.js` 读取，不维护另一个可漂移列表。
- `validateTokens / validateProfiles / validateCandidate / validateCandidateSet / validateAssessment / validateSelections`。校验返回 `{ valid, errors }`，错误有字段路径；CLI 遇到 invalid 退出非零。profiles 的字段与单位以 M5.1 为准，候选保存该皮肤 profileSnapshot 并核对 profileHash。
- `canonicalJson(value)`：递归对象键排序，数组原序，拒绝 NaN/Infinity/undefined/循环对象；使用 UTF-8，无缩进，加一个末尾换行作为落盘规范。
- `sha256Canonical(value)`、`hashCandidate / hashCandidateSet`、`collectSourceHashes(paths)`。候选摘要排除总计划指定的自引用字段，不把时间或机器绝对路径带入可复现数据。
- `FailureRecord`：`code / skinId / mode或pair / variant / roleIds / attemptedRanges / worstRatio / threshold / message`；没有数值时 `worstRatio = null` 并解释。去重 code 为 `DUPLICATE_CANDIDATE`，额外包含 `relatedCandidateId / distances`，不用对比度字段假装表示色差。

`policy.json` 固定首版参数：正文 4.5、主文字优选 7、必要图形 3；求解文字目标 4.7、主文字优先 7.2；`maxTrialsPerTokenPerRound=1024 / maxCouplingRounds=4 / maxBackgroundAttemptsPerVariant=3`；sRGB gamut epsilon `1e-7`；色差诊断版本 `oklab-distance-v1`。定义角色、颜色数学和 fixture 的版本字段。

协调者同时将 Biome 的 `files.includes / formatter.includes` 增加 `scripts/skin-palette/**` 和 `test-support/skin-palette-fixture.mjs`，保持 bootstrap 排除和其他配置。只扩大检查到新工具，不格式化无关文件。后续每卡在交接前格式化自身文件并检查，避免 M6 才统一格式化导致全部候选摘要过期。

验收测试必须覆盖：多/少 token、alpha HEX、非法模式、未知皮肤、半套候选、选择缺一套、重复候选 ID、摘要错配、数组排序不被改变、对象键顺序不影响摘要、候选里的时间字段被拒绝。只验证 JSON 能 parse 不算完成。

接口发生冲突时先修契约，再改实现。后续 agent 不能为了使测试通过跳过未知字段或自动补用户选择。

## M0.4 隔离合成 fixture

**目标：** 候选比较有真实统计、图表和密集内容，同时不触碰真实数据。

在 `test-support/skin-palette-fixture.mjs` 导出 `createPaletteFixture()`，返回 `{ homeDir, importStoreFile, databaseFile, pickedPath, fixtureHash, close }`。只在 `os.tmpdir()` 下创建带 `skin-palette-fixture-` 前缀的唯一目录；所有写入都在这个目录内。

实现思路锁定：

1. 复用当前 `createUsageServer` 支持的隔离参数，参考现有旧导出清理 UI audit 的**在线**合成数据方式，禁止调用已移除的导出器。
2. 生成固定 2026-09-26—2026-10-03 的 JSONL，至少 3 个可识别模型、2 个项目渠道、12 条非零记录、8 条可显示长名称。利用[项目日志规范](../../14-project-log.md)创建合成 `.codex-usage/usage.jsonl`，通过当前导入配置/API 接入；不伪造一套 `/api/usage` 协议。
3. 包含 input/cached/output、费用非零与缺价说明场景；固定量值，不能用全零页面。计价使用项目现有本地默认表或临时目录中的合成缓存，不访问外网。
4. fixture 中的相对名称、日期、用量和模型是版本化静态数据。摘要覆盖逻辑内容，不包含随机临时路径。浏览器进入后选“全部”，日历定位 fixture 月份；不依赖今天恰好有数据。
5. 服务配置固定 `env: {}`、`automaticDiscoveryEnabled: false`、临时 importStore/database、临时 `pickDirectory`；不得读取用户 HOME 的日志与配置。
6. `close()` 可重复调用，关闭资源并清理自身临时目录。递归清理前验证绝对路径在 `os.tmpdir()` 下且前缀正确；不要清理仓库输出证据。

验收：用实际 server API 读取 fixture，有非零总量、多模型/渠道和足够表格内容；建立两个 fixture 实例互不串数据；关闭后对应临时目录删除，真实工作区与用户配置无写入。测试不要把实时价格或当前日期写成永久断言。

模块出口：M0.1—M0.4 的 handoff、有效角色清单与契约、可复现 fixture。若有固定色冲突，列为独立待决事项，不把已知无解隐藏到 M5 才报。
