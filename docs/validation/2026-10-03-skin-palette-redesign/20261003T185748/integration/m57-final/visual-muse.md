# Muse 有限图片复核

- Run：m57-selected-full-20261018T203916Z-23d60159。
- 范围：仅实际查看指定 6 张现有截图；不运行浏览器、不修改产品、不扩大图片或历史范围。
- 图片共同根目录：`captures/muse-a-1ae8bfc080aa/`（相对于本 run）。baseline 按本次任务定义作为 50% 角色状态。

## 六图观察

1. `captures/muse-a-1ae8bfc080aa/light/baseline.png`：50% 双侧角色处于内容背后及外侧留白，必要指标、筛选文字、图表图例、表格和底部说明没有被线稿遮挡。卡片凸起，数值槽、图表和表格底板凹入；左上受光、右下投影关系一致。
2. `captures/muse-a-1ae8bfc080aa/light/states/characters-off/state.png`：角色关闭，所见必要文字完整；卡片外阴影及凹槽内阴影方向与 baseline 一致。
3. `captures/muse-a-1ae8bfc080aa/light/states/characters-100/state.png`：100% 角色线条更显著，头发接近卡片外缘，但由实色内容卡片覆盖；所见指标、趋势说明、图表刻度/图例和详情文字均无角色线条穿过。凸卡片、凹槽及按钮层级一致。
4. `captures/muse-a-1ae8bfc080aa/dark/baseline.png`：50% 线稿在两侧留白内，未挡必要内容；全页表格及底部路径/费用说明保持完整。深色卡片左上亮缘和右下阴影、凹槽上缘暗部能区分凹凸，光向一致。
5. `captures/muse-a-1ae8bfc080aa/dark/states/characters-off/state.png`：角色关闭，所见文字无装饰遮挡；深色陶瓷面板与凹入的数值槽/图表区域保持同一光向。
6. `captures/muse-a-1ae8bfc080aa/dark/states/characters-100/state.png`：100% 角色对比增强，仍在卡片背后及边缘留白；所见必要指标、筛选、趋势、图例及详情文字无遮挡。卡片外凸、内容槽内凹，没有局部翻转或相反光源。

## 两项结论

- **角色关闭 / 50% / 100% 不遮挡必要文字：accept。** 六图所见范围内没有发现角色覆盖必要文字；100% 的外侧线稿更抢眼，但不构成文字遮挡。
- **陶瓷凹凸与光源一致性：accept。** light / dark 均保持凸起容器、凹入内容槽和一致的左上光源关系，没有发现需要拒绝的凹凸或光向冲突。

未检查截图以外的视口、交互、其他角色或状态；off / 100% 截图仅支持其可见首屏区域，不能据此断言其屏外内容。未执行自动对比或产品测试。
