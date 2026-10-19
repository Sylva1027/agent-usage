# M2：候选模板、有界求解与生成命令

前置：M0、M1.1、M1.3、M3.1；实际生成还需要 M5.1 的十套配方。遵守[总计划](../2026-10-03-skin-palette-implementation-plan.md)。共 4 张卡。

允许文件：`scripts/skin-palette/templates.mjs / solver.mjs / generate.mjs / generate-cli.mjs`、`test/skin-palette-solver.test.js`。配方由 M5 所有，检查器由 M3 所有；本模块不能为自己调整通过条件。

## M2.1 固定表面模板与三种变体

**目标：** 生成空间明确而有限，agent 不为每款自行发明一套任意公式。

`templates.mjs` 读取配方中的 `identityHex / surfaceH / surfaceC / pageL.light / pageL.dark / accentC`。所有 token 先构造 OKLCH，再经 M1.3 色域处理和 HEX 序列化。

第一版表面模板固定如下。L 计算结束限制到 `[0.04, 0.998]`；表面 C 限制到 `[0, 0.045]`，H 取配方 `surfaceH`：

| token | light：L / C | dark：L / C |
| --- | --- | --- |
| pageBackground | pageL / surfaceC | pageL / surfaceC |
| panelBackground | pageL + 0.030 / 0.60 × surfaceC | pageL + 0.045 / 0.60 × surfaceC |
| panelHighlight | panelL + 0.025 / 0.25 × surfaceC | panelL + 0.080 / 0.25 × surfaceC |
| panelShadow | pageL − 0.160 / 0.75 × surfaceC | pageL − 0.120 / 0.75 × surfaceC |
| panelBorder | panelL − 0.045 / 0.40 × surfaceC | panelL + 0.040 / 0.40 × surfaceC |
| controlBackground | 与 panelBackground 相同 | 与 panelBackground 相同 |

这是本轮候选的工程起点，不是材质普适定理。真正的 top/bottom/well 仍由生产接口派生；模板合格也不等于视觉合格。

变体固定：

- a「基准」：配方原值，accentC 原值。
- b「轻染」：surfaceC × 0.75；light pageL + 0.015，dark pageL − 0.025；accentC × 0.90。
- c「浓染」：surfaceC × 1.20；light pageL − 0.015，dark pageL + 0.015；accentC × 1.05。

每个变体的背景修正只按 `0 / +0.020 / -0.020` 的 light 顺序，以及 `0 / -0.020 / +0.020` 的 dark 顺序尝试，最多 3 组。pageL 的最终偏移不超过配方基值 ±0.04；触及范围时去掉重复修正。不改 H，不随机添加第四种变体。

前景起点和允许范围：

| token | light 起点 / L 范围 | dark 起点 / L 范围 | H/C |
| --- | --- | --- | --- |
| textPrimary | 0.24 / [0.10, 0.48] | 0.95 / [0.78, 0.99] | surfaceH，C ≤ min(surfaceC, 0.018) |
| textSecondary | 0.43 / [0.12, 0.60] | 0.78 / [0.62, 0.99] | 同上；2026-10-11 依据 M5.2-G-D2/R2 实验扩大浅色下界，允许透明日历字达到原4.7目标，非降低验收阈值 |
| chartText | 0.43 / [0.18, 0.60] | 0.78 / [0.62, 0.99] | 同上，独立求解 |
| accent | 0.55 / [0.28, 0.68] | 0.78 / [0.62, 0.94] | identityHex 的 OKLCH H；C 从变体目标向下搜索，最低 0.035 |

`controlText = textPrimary`、`controlBorder = panelBorder` 在求解后同步填写。不得用这两个未接线 token 来修实际按钮文字失败。

验收：同一配方的 a/b/c 有完整模式模板，全部输出正确 HEX；gamut 修正记录保留；候选尚未求解时标记为草案，不对外宣称通过。测试覆盖变体边界与重复背景修正去除。

## M2.2 有界前景求解

**目标：** 调颜色有可复现顺序，无解时有明确原因，不把任意增亮当修复。

`solver.mjs` 对一个完整模式工作，通过 M3.1 的 `evaluatePalette` 判断真实角色。搜索顺序固定 `textPrimary → textSecondary → chartText → accent`，每轮结束重新派生并检查所有角色；最多 4 轮。

单 token 搜索：

1. 固定 H；以该 token 起点 L 和目标 C 为偏好。C 依次取目标的 `1 / 0.85 / 0.70 / 0.50 / 0.25 / 0`，去重并过滤掉 accent 最低 C 以下的项；gamut 降 C 后同样核查最低 C。
2. 每个 C 在允许 L 区间均匀取 129 点，端点包含在内。每次将颜色转为最终 HEX，代回完整 token，再调用共享派生与相关角色检查。不得只比较 accent 对 panelBackground。
3. 网格点只计算一次并缓存必要角色比值；主文字先从同一网格结果挑 7.2 可行点，无解再挑 4.7 并记录 `preferredContrastUnmet`，不能回退时重复整遍网格。其他普通文字以 4.7 搜索。
4. 在所选目标下，对每个存在可行采样点的 C 层，选离起点 L 最近的可行区段；只对该区段两侧边界各做最多 16 次细化。多段并存时以距离起点最小、随后较小 L 的固定规则取段，不假定所有背景的对比函数单调。最后选择优先级为：满足目标阈值 → L 改动最小 → C 改动最小 → 固定 L/C 顺序。
5. 每 token 每轮至多 1,024 次试值，包含起点和边界细化；每背景/模式四个前景 token、最多四轮，共最多 16,384 次。背景/关联前景变化后缓存失效，重新计下一轮预算。剩余预算不足时停止并记录，不通过增加轮数或降低门槛继续。
6. 一个 token 改动影响其他背景或 `--active-ink` 时，整轮末重查；最多 4 轮。使用生产 RGB 派生的实际结果，不用 OKLCH 中的目标 L 代替背景亮度。

快速检查暂不支持的复杂背景可带 `browser-required` 继续生成，但不能计入快速 PASS；最终 ready 需要 M3/M4 的浏览器证明。已知必要角色失败必须先修，不把失败全部推给浏览器。

失败处理：

- 当前背景失败：尝试 M2.1 固定背景修正，最多 3 组。
- 固定状态色的最高可达对比仍不合格：立即返回 `CONTRACT_CONFLICT`，不搜索与其无关的前景。
- 无可行采样点：返回 `UNSATISFIABLE`，准确说明“在本版允许的有限搜索集中未找到可行值”，不伪称已经证明整个连续色域数学无解。
- 预算耗尽：返回 `SEARCH_BUDGET_EXCEEDED`。
- 出口失败不输出半套颜色、不修改 policy、不增加例外。

验收测试：多背景同时约束、placeholder alpha、强调小字与填充文字共同约束、非单调/多可行段、7.2 优选回退、无解范围、固定色冲突、预算停止、HEX 舍入后失败、共享派生后关联角色退化。使用小型人造角色清单制造成功/失败案例，不照抄实现公式做镜像测试。

## M2.3 浅深配对、去重与可复现候选

实现 `generateCandidates({ profiles, skinIds, seed, policy, roleCatalog })`，不得读取 DOM、当前时间或真实数据，不得写文件。

步骤：

1. 验证请求 ID 与配方；按固定注册顺序、a/b/c 顺序生成。每组分别求解 light/dark，只有两模式完整才创建 Candidate。
2. 保存该皮肤完整 `profileSnapshot` 并计算 profileHash；将模板参数、最终参数、搜索次数、背景修正、gamut 降 C、优选目标未满足等写入 `parameters`。最终 `style` 使用 M5 配方和实际变体说明，不写“算法证明美观”。
3. 再按最终 HEX 重新运行快速检查，已知必要角色失败者进入 `rejected`。
4. 同皮肤完全相同的 24 个 token 只保留排序最前的一组。近似重复用实际派生的 page/panel/accent 六个浅深样本检查：每一项 `D_OK < 2.0` 时标记 `nearDuplicate`，不向用户凑三组；阈值只作本工具的首版去重规则。
5. 近似重复保留阅读余量更高的一组，随后 a/b/c 顺序打破并列；把被去掉候选和原因按 `DUPLICATE_CANDIDATE` 存入 rejected，包含关联 ID 和六项距离。跨皮肤近似只由 M3 诊断，不因同色系自动删除某款。
6. 使用 M0 的摘要函数生成 ID/hash。所有对象结构和数组顺序固定，不加入机器时间。

验收：同输入两次结果逐字相同；仅选一个 skin 不改变该 skin 的候选；浅深失败不出现孤立模式；去重理由可追溯；两款试点至少能产出可测候选，或明确输出冲突，不用默认 palette 兜底假装重设完成。

## M2.4 生成 CLI 与产物写入

固定命令：

```powershell
node scripts/skin-palette/generate-cli.mjs --skins chatgpt,grok --seed palette-redesign-v1 --out docs/validation/2026-10-03-skin-palette-redesign/pilot-r1
```

参数固定为 `--skins / --seed / --out`；profiles、policy、roles 默认读取固定模块目录，若需要覆盖仅接受显式 `--profiles <path> / --policy <path>` 并保存其内容摘要。未知参数报错。`--skins all` 是全部十套。

行为：

- 导入实现不能自动执行 CLI；用直接运行判断进入 main。
- 收集输入与源文件摘要，写 `run.json / candidates.json`；使用先写临时文件再 rename，输出目录已存在且有结果时拒绝覆盖。
- 所有请求皮肤各至少 2 组成对、没有已知硬失败：退出 0，表示**生成完成**，不表示浏览器或美观通过。
- 输入或写入错误退出 1；某请求皮肤不足两组/无解/预算冲突退出 2，同时保存其他已完成结果与失败记录。
- 不执行 prepare，不改正式 palette/bootstrap，不启动真实服务，不访问网络。

验收：小范围与 all 参数正确，非法参数和越界输出拒绝；重复运行在不同新目录得到同一候选内容摘要；失败不损坏已有文件；生成日志明确尚待浏览器和视觉评审。

模块出口：稳定成对 CandidateSet 与失败记录，供 M4 实测。M2 不出用户选择、不决定延期款上线，也不写正式 token。
