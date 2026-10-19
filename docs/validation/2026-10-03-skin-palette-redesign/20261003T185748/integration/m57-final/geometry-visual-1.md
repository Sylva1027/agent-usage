# 有限真实几何视觉核验 1

结论：**accept（仅当前三款候选、两种模式的 baseline 呈现 / no-geometry-workaround）**。2026-10-19 实际查看指定 6 张 PNG；没有打开浏览器，没有查看其他截图，没有改代码或生成 formal 选择。

R = `docs/validation/2026-10-03-skin-palette-redesign/20261003T185748`。下列路径均相对 R。逐一读取对应 layout.json，并从 PNG IHDR 原字节读取尺寸；6 张均为 **1920×2171**，对应 layout.viewport 为 **1920×1080、dpr=1**、scroll=(0,0)、documentHeight=2171，即完整页面截图，不能把 2171 误当 viewport 高度。PNG SHA-256 均与各自 capture.json 的 modes.<mode>.baseline.evidence.baseline.sha256 相符；layout 绑定来自同一 evidence.layoutJson，skinId/mode 均匹配。查看工具将完整图缩显为 1499×1696；未据缩显图声称单像素字体或对比度合格。

## Claude b light

PNG：`batches/m53-full-selected-20261018T145857Z-54115e27/captures/claude-b-cced5b3fef6b/light/baseline.png`。

对应 layout：`batches/m53-full-selected-20261018T145857Z-54115e27/captures/claude-b-cced5b3fef6b/light/layout.json`。该文件 mode=light、skinId=claude；尺寸/viewport 对应通过。实际观察：顶部标题与右侧三个按钮共处完整顶栏，范围/日期/刷新行整齐；两排六列指标的标签和数值无重叠；时间分布与详情面板顶底对齐，坐标轴、图例和柱体完整，未见内容裁切或字体挤压。

## Claude b dark

PNG：`batches/m53-full-selected-20261018T145857Z-54115e27/captures/claude-b-cced5b3fef6b/dark/baseline.png`。

对应 layout：`batches/m53-full-selected-20261018T145857Z-54115e27/captures/claude-b-cced5b3fef6b/dark/layout.json`。该文件 mode=dark、skinId=claude；尺寸/viewport 对应通过。实际观察：深色顶栏与右侧按钮排列完整；两排指标的边缘、数值基线整齐；左图右详情边界对齐，柱体、日期及图例没有越界，未见字体挤压。标题浮雕本身低显著性属色彩问题，本项不作对比度结论。

## GLM a light

PNG：`batches/m54-full-selected-20261018T160449Z-dab21865/captures/glm-a-90839e4535a2/light/baseline.png`。

对应 layout：`batches/m54-full-selected-20261018T160449Z-dab21865/captures/glm-a-90839e4535a2/light/layout.json`。该文件 mode=light、skinId=glm；尺寸/viewport 对应通过。实际观察：顶栏、筛选行与指标网格保持同一主内容边界；数值和标签有容纳空间；左右图表面板对齐，轴标签和图例可见。表格长模型名、底部超长路径可见省略号，未压到邻列；不是主面板几何裁切。

## GLM a dark

PNG：`batches/m54-full-selected-20261018T160449Z-dab21865/captures/glm-a-90839e4535a2/dark/baseline.png`。

对应 layout：`batches/m54-full-selected-20261018T160449Z-dab21865/captures/glm-a-90839e4535a2/dark/layout.json`。该文件 mode=dark、skinId=glm；尺寸/viewport 对应通过。实际观察：顶栏按钮、两排指标和左图右详情均规则对齐；图表日期与图例完整，字体没有挤到边框或相邻元素。长模型名/路径为省略显示，底部面板保持完整。

## DeepSeek a light

PNG：`batches/m55-full-selected-20261018T165932Z-2e635d34/captures/deepseek-a-462c5bb15734/light/baseline.png`。

对应 layout：`batches/m55-full-selected-20261018T165932Z-2e635d34/captures/deepseek-a-462c5bb15734/light/layout.json`。该文件 mode=light、skinId=deepseek；尺寸/viewport 对应通过。实际观察：顶栏和筛选行完整；指标网格列距一致，标签/数值无重叠；时间分布与详情面板对齐，柱状图、日期和图例均在容器内，未见字体挤压。

## DeepSeek a dark

PNG：`batches/m55-full-selected-20261018T165932Z-2e635d34/captures/deepseek-a-462c5bb15734/dark/baseline.png`。

对应 layout：`batches/m55-full-selected-20261018T165932Z-2e635d34/captures/deepseek-a-462c5bb15734/dark/layout.json`。该文件 mode=dark、skinId=deepseek；尺寸/viewport 对应通过。实际观察：顶栏右端按钮完整，筛选与指标对齐；图表与详情的顶底一致、数值条未越界，轴标签及图例无裁切或挤压；下部双列表格及底部面板完整。

## 同 fixture 固定元素 rect 数值核对

三份 capture.json 的 fixtureHash 均为 `53856bb4c64c7629f80728416ff8e41b073ce13915454c8bc00396836f24a005`。逐一读取六份 layout.json 的 elements，以下元组为 (x, y, width, height)，单位 CSS px；三款 light/dark 六份的每个数值完全相等，最大绝对差 **0 px**：

- topbar = (240, 28, 1440, 72)。
- firstMetric = (240, 243, 223.328125, 111.1875)。
- firstPanel = (240, 603.21875, 953.328125, 384)。
- chart = (264, 695.21875, 905.328125, 238)。

这里只比较相同 fixture 的固定布局元素；角色背景图案在画布两侧的自然出界/遮挡不等于主内容裁切，也未纳入固定元素相等断言。

## 冻结布局源原字节核对

对当前仓库下列文件直接 Get-FileHash SHA256（未换行规范化），逐份核对上述三个 capture.json.sourceHashes；**3 文件 × 3 捕获 = 9/9 相等**：

- public/styles.css = `08aad199720827515738e789c50d7ec969b927a8b22a39e9af6cc3ac944fa409`。
- public/skins.css = `df7e461d51eeeb69db02479ea6ae0d0dfbc18e8b49bcb2d15a5d6fcce55ebc76`。
- public/index.html = `69e38dd284e63911ea3c3e26f3b1d8ac5294ddb5d3a8663cf57997a29f4a389f`。

因此这三份捕获记录使用同一组冻结 HTML/CSS 布局源，且当前这三文件与记录相同。结合 6 图实际呈现、PNG 绑定及四个 rect 零差，当前所核验候选 baseline 的 no-geometry-workaround 项可 accept；不需要补用无关截图。

## 范围与未检查

本项不能证明所有历史版本从未发生几何变更，也未与生产旧版截图比较。未检查其他状态/视口、真实显示器缩放、浏览器 zoom、交互或单像素文字质量；accept 仅限本报告明确列出的 6 个 baseline 与固定元素，不能外推全局或历史无几何变化。

