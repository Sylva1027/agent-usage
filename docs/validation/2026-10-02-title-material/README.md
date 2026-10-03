# 2026-10-02 · 标题框体表面反光修复

Agent Usage 所在 `.topbar` 已包含在陶瓷三段渐变的共享规则中，但后续 `.topbar` 规则的 `background: var(--neo-surface)` 将它覆盖为纯色。本次仅删除该覆盖，让标题框体使用和面板、指标卡、对比卡相同的渐变。标题文字、原有阴影和所有布局规则保持。

验证为独立全页面 HTML fixture：移除脚本，内联生产 styles.css／skins.css，阻断全部网络请求，在 headless Edge 比较修复前后样式。覆盖 2290／1440／390px × 浅／深共六种情形；修复前 backgroundImage 为 none，修复后与 `.panel` 的渐变一致。所测 shell、标题、按钮、工具栏、指标卡和面板 DOMRect 全部相同，标题文字阴影及框体阴影相同。

证据：[结果](results.json)、[浅色桌面](title-light-1440.png)、[深色桌面](title-dark-1440.png)、[浅色窄屏](title-light-390.png)、[深色窄屏](title-dark-390.png)。这次验证不包含运行中的业务 API、皮肤切换或完整 P4 验收。

`node --test test/app-toolbar.test.js`：2 项通过。`npx biome format public/styles.css` 与 `git diff --check` 通过。与修改前临时 CSS 副本逐字比对（忽略行尾格式）确认唯一变化为删除该条覆盖。
