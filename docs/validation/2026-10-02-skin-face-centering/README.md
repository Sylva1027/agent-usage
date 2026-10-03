# 2026-10-02 · 页面两侧立绘随留白居中

已按[用户确认的方案](../../plans/2026-10-02-skin-face-centering-proposal.md)实施并完成专项验证。

## 实现

`public/skins.js` 新增二十套正／侧面部边界与中心，独立于原有油墨量测与 R6 缩略图参数；浅深配对重新检查，二十组 alpha 掩码均一致。[源图参考一](source-faces-1.png)、[参考二](source-faces-2.png)、[标注引导一](face-guides-1.png)、[引导二](face-guides-2.png)供复核；蓝线是面部边界，红线是中心。标注为人工目检面部轮廓的近似值，不是自动人脸识别结果。[标注数据](face-annotations.json)与[浅深检查](alpha-pairs.json)保存于此。

`skin-ui.js` 读取固定装饰层与主看板 `.shell` 的实际边界，在每侧留白中点定位面部。窄留白将面部限制在可用视口，身体仍允许被框体遮挡。首次显示前等待实际图片解码并完成定位；ResizeObserver 及窗口 resize 合并到动画帧重算，仅向两张装饰图写定位参数。偏好版本、50% 默认透明度、78vh 高度、油墨归一缩放、底部基线及源图保持。

`skins.css` 保留静态锚定作为缺少标注时的降级，已标注图统一使用面部锚点平移。另修正 <=720px 隐藏规则的优先级：旧规则被 `#skinCharacters[data-skin-characters="on"]` 的 display:block 覆盖，现与它使用相同选择器，实际恢复既定手机隐藏行为。

## 验证

[浏览器脚本](browser-audit.mjs)在独立 headless Edge 中运行生产 HTML／JS／CSS，以空数据 fixture 拦截本机 API；离线则生成真实自包含 HTML 从 file:// 打开并阻断全部网络请求。未连接或修改用户的实际浏览器，也未扫描用户用量数据。

- 十角色 × 浅深 × 11 组视口 × 在线／离线，共 **440 个状态**。视口含 2560、约2290、1920、1600、1440、1024、721、720、390px，以及不同高度。720 个可见图片测量中，面部锚点与预期目标最大误差约 **0.016 CSS px**，240 个测量触发边缘保护；凹槽／面板及主看板 DOMRect 与对应无皮肤基线一致。
- 连续调宽和手机隐藏后恢复、纵向滚动、不对称看板边界、窗口高度、显式滚动条 gutter 出现／移除、英文切换、reduce／no-preference、无 ResizeObserver 降级均通过。
- 0%／50%、隐藏再显示、简洁模式再返回、快速角色切换、刷新恢复、单视图加载失败／恢复通过；调整视口不重新请求素材。刷新时四个可见性变化样本均已有定位标记。无页面错误，无外部资源请求。
- 十角色实际浅色留白裁片已目检：[渲染一](rendered-faces-1.png)、[渲染二](rendered-faces-2.png)。完整截图含 [ChatGPT 浅色2290](chatgpt-light-2290.png)、[深色2290](chatgpt-dark-2290.png)、[浅色1600](chatgpt-light-1600.png)、[深色1600](chatgpt-dark-1600.png)、Muse 与 Mimo 浅深2290。
- `node --test --test-concurrency=1`：**355／355 通过**，见[node-test.log](node-test.log)。typecheck、lint、format:check 通过；lint 保留 41 条既有警告。注册表生成／素材一致性校验也由现有测试实际执行通过，无需改变 bootstrap。
- [变更前哈希](before-hashes.json)中仅三个生产文件及 `test/skins.test.js` 改变，**120 个受保护文件保持原样**，包括源图、公开 WebP、色板、主样式及弹窗实现。

完整测量及专项结果见[results.json](results.json)。本次完成脸部居中专项；空数据 fixture 不等同于真实业务数据与完整 P4 联合验收。约2290px 是模拟 CSS 视口，尚未直接测量用户 Edge 侧边标签页的实际窗口。
