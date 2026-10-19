# M1：共享生产派生、首屏与颜色数学

前置：M0 完成。遵守[总计划](../2026-10-03-skin-palette-implementation-plan.md)。共 5 张卡；保留现有正式 12-token 色源和 runtime 派生行为，必要状态色仅按 M1.4 修正。

## M1.1 开放 token 派生纯接口

允许修改：`public/skins.js`、`test/skins.test.js`。不改 `skin-ui.js` 或 CSS。

实现步骤：

1. 在当前内部 `derivePaletteDeclarations` 外增加导出 `derivePaletteDeclarationsFromTokens(rawTokens, mode)`。输入为**直接 token 对象**；内部通过现有 `normalizePalette(rawTokens)` 的白名单和清洗规则取得规范化对象中的 `.tokens`。现有色源按模式存放扁平 token，不能包成 `{ tokens: rawTokens }` 再交给这个 normalizer。
2. 非 light/dark、非对象、空有效 token 返回 `null`；存在部分有效 token 时保留现有部分声明行为；未知布局键被忽略。不把开发候选的恰好 12 键规则反向施加到生产 API。
3. 调用原有派生函数，返回冻结的 `[name, value][]` 及冻结 pair；顺序与原结果相同。不调整颜色解析、RGB mix、`--active-ink` 选择或 alpha 配比。
4. 现有 `paletteDeclarations(skinId, mode)` 保留 unknown/classic/null 分支，正常情况委托新接口，不再拥有第二条计算路径。
5. 保留 20 项 `PALETTE_CSS_VAR_NAMES`。`controlText/controlBorder` 仍只作为被接受但不独立应用的字段，不顺便接新变量。

验收：对十套 × 两模式逐项比较新 API、旧基线声明与 `paletteDeclarations`，完全一致；classic、无效输入、部分输入、未知字段、freeze 行为有针对性测试；`test/skins.test.js` 通过。基线正式色值和 CSS 无变化。

## M1.2 提取可覆盖候选的 bootstrap 发射器

允许修改：`scripts/prepare-skin-assets.mjs`、新增 `scripts/skin-palette/bootstrap-source.mjs`、`test/skin-palette-bootstrap.test.js`。正式 bootstrap 仅通过生成命令产生，禁止手改。

固定接口：`buildSkinBootstrapSource(paletteOverrides = {}) -> string`，override 为 `{ [skinId]: { light: tokens, dark: tokens } }`。

实现步骤：

1. 将当前 `bootstrapSource()` 的 registry/payload 构建和 IIFE 模板移到纯发射器。默认情况下仍从 `SKINS / paletteDeclarations` 取值，保持内容、顺序、注释和 storage 行为。
2. override 只接受十套已知角色，必须同时含完整浅深 token 且经 M0 严格校验；未知 ID、classic、半套或坏色值抛明确输入错误，不悄悄忽略。
3. 有 override 的角色使用 M1.1 新 API 取得声明；资产、偏好版本、默认 classic 和变量清除清单不变。未覆盖角色仍用正式值。
4. `prepare-skin-assets.mjs` 保留原 CLI、manifest、格式化和原子写入逻辑，只改为调用纯发射器。导入纯发射器不得执行 prepare/check，也不得写临时 probe。
5. 开发预览直接在内存使用发射器输出，不能每次候选启动都调用 `skins:prepare` 改生产文件。

验收：无 override 时生成的 canonical bootstrap 与 M0 基线逐字相同，manifest 内容等价且 40 个资产不变；覆盖某角色后 payload 只有对应两模式的 palette 变化；在模拟 DOM/storage 中执行 IIFE，声明与 M1.1 一致，classic 清除不残留；`skins:check` 通过或准确报告基线已有问题。

若格式差异来自发射器提取，修复至等价，不用“重新生成就是新基线”绕过该检查。

## M1.3 纯颜色数学

允许新增：`scripts/skin-palette/color-math.mjs`、`test/skin-palette-math.test.js`。不向 public 引入开发数学库，不改生产混色规则。

统一单位与最低接口：

```js
hexToSrgb(hex)                    // -> [r,g,b]，通道 0..1
srgbToHex(rgb)                    // -> #RRGGBB；只接受已处理色域的值
srgbToOklab(rgb)                  // -> { L, a, b }
oklabToSrgb(lab)                  // -> [r,g,b]；可返回超色域值用于判断
oklabToOklch(lab) / oklchToOklab(lch)
fitSrgbGamut({ L, C, H })          // -> { rgb, lch, chromaReduced }
compositeSrgb(foreground, alpha, background)
relativeLuminance(rgb) / contrastRatio(a, b)
okDistance(a, b)                  // 输入 OKLab，固定 100 倍欧氏距离
```

实现要求：

1. sRGB 解码采用 `c <= 0.04045` 分支，编码采用相应标准逆变换；亮度系数 0.2126/0.7152/0.0722。旧生产函数里的亮度实现不在此卡重写。
2. OKLab 矩阵采用作者公开定义，注明来源。L/C 不乘 100；H 归一化到 `[0,360)`，近零彩度时用明确约定的 H=0，不产生 NaN。
3. 超色域时保持 L/H，对 C 在 `[0, inputC]` 做至多 24 次二分，判断允许 `1e-7` 误差。只有数值误差范围内允许收敛到 0/1；不得把明显超界通道强行裁剪后声称颜色未改变。
4. `compositeSrgb` 按 CSS sRGB alpha 合成，先得到实际有效颜色，再做亮度解码。不要把 alpha 乘到亮度上代替合成。
5. 最终 HEX 舍入一次，求解和评审均使用舍入后颜色。`srgbToHex` 对明显超色域输入报错，避免调用方绕过 gamut 处理。
6. invalid/非有限数值显式报错；函数不得写文件、读 DOM、取随机数或读取正式 palette。

测试要有外部已知结果：黑白 21:1、相同色 1:1、红/绿/蓝 OKLab 参考值、往返误差、透明前景对不同背景、H 跨 0°、超色域降 C、gamut 不改变 L/H、4.499 不通过、HEX 舍入导致边界变化。不要只测试“正变换再用自己逆变换回来”。

依据：[OKLab 作者定义](https://bottosson.github.io/posts/oklab/)、[CSS Color 4](https://www.w3.org/TR/css-color-4/)、[WCAG 文字对比度](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)。本工具的 OKLab 距离是内部诊断，不是 WCAG 的另一个通过标准。

## M1.4 既有状态文字的受限颜色兼容

**目标：** 解决不受 palette token 控制的绿色/红色小字，使求解器不因它们永远无解。此卡是范围明确的颜色修正，不增加 token 或运行时变量。

允许修改：`public/styles.css` 中新增一个限定角色浅色模式的颜色覆盖块；`scripts/skin-palette/roles.mjs` 仅同步 BASE_COLORS 和该数据版本。其他角色、状态和阈值不变。

步骤：

1. 根据 M0 实际角色核查原 `--green: #2f855a / --red: #c05621` 对 light 的面板、凹槽、关闭刷新态混色/说明背景。记录实际消费位置和失败组合；没有必要角色失败则保持 CSS 不变，在 handoff 写 `not-needed`。
2. 确有失败时只采用以下预定规则，不由 agent 任意设计新的状态色组：

```css
:root[data-skin]:not([data-skin="classic"]):not([data-theme="dark"]) {
  --green: #1A5233;
  --red: #74270D;
}
```

3. 放在现有颜色覆盖区之后，保持原 root/light/dark 定义。规则只对角色浅色模式生效；classic、深色模式和选择器的范围保持。将旧注释“--red 在本主题中为橙色”改为准确的“关闭状态色”，只改说明。`--gold` 无实际消费时不改，不能为了完整性新增黄色状态。
4. 这些值是固定的首版兼容色；所有必要消费位置由 M3/M5 完成真实候选实测。不声称两个 HEX 对任意背景都可读；若在 M2 允许背景内仍存在失败，优先按既定表面修正处理，持续无解才报 CONTRACT_CONFLICT。
5. 只同步 `BASE_COLORS.character.light` 的两个值及数据版本，classic/dark 分支保留旧值。M3 不能把新值错误用于 classic 或 dark。
6. 用隔离 fixture 检查代表角色的 light/dark 和 classic，确认 computed 颜色只在预定分支变化，DOM/盒尺寸未变，20 项 palette 声明与 M1.1 保持一致。保存 CSS diff 和新的源摘要。

验收：必要状态色拥有真实消费依据，只有两个既有变量及限定选择器变化；classic 与 dark 的状态色保持基线，12 token/20 声明清单不扩展。若修改条件未触发，该卡以带证据的无需修改完成，不制造无关颜色变化。

## M1.5 退役工作台重复声明派生

允许修改：`public/skin-palette-studio.js`；如需说明，只改 `public/skin-palette-studio.html` 现有说明文字。不增加页面布局、控件或产品入口。

实现步骤：

1. 找出工作台将 12 token 映射成 root CSS 变量的函数。删除该处独立的陶瓷/active-ink/hover 派生，改用 M1.1 的 `derivePaletteDeclarationsFromTokens`。
2. 注入前清除同一份 `PALETTE_CSS_VAR_NAMES`；主题切换和皮肤 runtime 后续更新时，继续采用现有工具的重应用机制，但值始终来自共享接口，不再计算另一套。
3. 保留“四源色生成草稿”的现有功能，标注为旧快速草稿；它生成 token 的算法不作为 M2 求解器，也不作为新门禁依据。
4. UI 中说明 `controlText/controlBorder` 没有独立接线，避免用户以为可分别控制实际文字/边框。保留原有导出结构和偏好恢复逻辑。
5. 工作台仅在隔离预览 origin 中检查；不要使用真实服务的同源 storage 来验证恢复。

验收：同一 token 与 mode，工作台注入的 20 项声明与共享 API 完全一致；切主题、选皮肤、关工具后没有旧颜色残留；classic 仍清除；主应用 `index.html` 没有新增工作台引用。手工 HEX 编辑不强制增加测试，针对共享声明和重应用的回归必须有实际证据。

模块出口：纯接口和首屏发射器可供 M2—M4 使用；正式 palette 与声明保持基线，状态色只有 M1.4 的预定差异。工作台只是少一套重复规则，本模块不做“工作台 v2”或新的配色产品。
