# 皮肤与配色维护

更新：2026-11-11。本页整合已落地的皮肤规则与开发入口；旧求解、选型和施工卡见[历史计划索引](archive/2026-11-11/README.md)。

## 当前功能

选择器开放 ChatGPT、Claude、GLM、Gemini、DeepSeek、Kimi、Qwen、Grok、Muse、Mimo 十款及简洁模式。每款支持浅／深主题、角色显示与透明度，偏好保存在本机；桌面选择器为五列两行，缩小窗口时保持操作可达。

独立工作室入口为 `/skin-palette-studio.html`，使用现行页面与工具进行配色预览。它不是主页面内的任意颜色编辑器，也不恢复旧 HTML 导出。产品行为详见[看板说明](12-dashboard.md#界面风格与角色)。

## 源码与资源

| 位置 | 维护方式 |
| --- | --- |
| `public/skin-palettes.js` | 唯一手写色源；十套浅深配色，每组沿用现有 12 个标量 token |
| `public/skins.js` | 注册表、资源定位、显示几何与配色派生接口 |
| `public/skin-ui.js`、`skin-picker.js`、`skins.css` | 角色运行时、选择器、主题及交互 |
| `public/skin-palette-studio.*` | 独立工作室 |
| `lineart assets/` | 作者源 PNG，保留用于重生成和来源校验 |
| `public/assets/skins/` | 运行时 WebP 资源 |
| `public/skin-bootstrap.js`、`skin-assets.json` | 生成物，不能手工维护第二份色源或摘要 |
| `scripts/skin-palette/` | 候选生成、实际页面测量、截图、评审与证据核验 |

## 修改与验证

日常只读检查：

```powershell
npm.cmd run skins:palette
npm.cmd run skins:check
npm.cmd run skins:check:sources
```

有意修改正式配色或资源后，运行 `skins:palette`，再运行 `skins:prepare`，最后运行 `skins:check:sources`。后两项分别生成内容和验证源 PNG 的绑定；不为普通检查执行 prepare。

候选工作流使用 `skins:candidates`、`skins:review`、`skins:quality` 及工作室。保留固定种子、输入摘要、浅深成对结果和真实页面证据；旧 CLI 的绑定限制见[兼容调查](validation/2026-10-03-skin-palette-redesign/20261003T185748/integration/m62-reaccept-20261020/engineering-gates/cli-compatibility.md)。不能仅因命令存在就声称历史 production 流程适配当前源码。

调整配色时保留布局、字体、角色几何、光源方向与既有可访问性。可读性先通过，再比较材质与身份；不靠取消文字或增加说明框解决问题。用户选择与技术验证分别记录。

源码字节变化会使绑定的截图／manifest 失效；为新改动生成新的证据，不回写旧报告哈希。检查主题切换、首屏、重载恢复、在线冻结、键盘焦点和 reduced-motion。缩放覆盖按[桌面基准](03-development.md#界面设计与验收基准)记录，历史未测的真实 OS 缩放不改记为通过。

旧配色计划中的“五款开放”和逐卡状态属于旧版本，现行十款范围以注册表和选择器为准。普通版仅保留简洁主题，皮肤模块、入口、角色资源及工作室由 waifu 包提供；普通版保留但不读取已有皮肤偏好。源码运行默认使用 waifu 版。

深浅主题切换采用 1 秒整页交叉渐变，期间主题按钮锁定，结束后恢复；Canvas 和角色随同过渡。减少动态效果的系统偏好继续生效。工作室和截图工具等待实际过渡结束后再注入或测量；本地包及检查结果见[追加需求验收](validation/2026-11-11-post-refactor-additions/README.md)。
