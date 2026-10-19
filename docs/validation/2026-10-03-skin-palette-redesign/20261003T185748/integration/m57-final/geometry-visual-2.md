# 有限真实几何视觉核验 2

结论：**accept（仅当前候选、以下四张 baseline 的 no-geometry-workaround 呈现）**。实际打开并观察恰好四张现存 PNG，未打开浏览器、未新增截图、未修改代码或 formal 选择。使用 Ponytail full，只写本报告。

本报告的 R = `docs/validation/2026-10-03-skin-palette-redesign/20261003T185748`。K = `batches/m57-selected-full-20261018T203916Z-23d60159/captures/kimi-b-32c91fbbc0c5`；G = `batches/selected-a-full-20261018T110532Z-47bd5687/captures/grok-a-caaed7d73f6d`。以下路径均相对 R。

## 逐图实际观察与文件绑定

- `batches/m57-selected-full-20261018T203916Z-23d60159/captures/kimi-b-32c91fbbc0c5/light/baseline.png`；对应同目录 `light/layout.json`。浅绿色全页中 topbar 与内容区左右边界对齐；两排指标卡等距，标签和数值未挤压；时间分布与详情面板顶底对齐，图表坐标、日期与图例可见；下方模型/仓库表及目录/费用面板无容器裁切。长模型名/目录路径可见省略号，属于单元格内截断，未见文字溢出覆盖相邻列。标题的浅浮雕对比度不作为本几何结论。
- `batches/m57-selected-full-20261018T203916Z-23d60159/captures/kimi-b-32c91fbbc0c5/dark/baseline.png`；对应同目录 `dark/layout.json`。深绿黑全页保持上述排列；topbar 按钮、指标数值、面板标题、图表日期/图例均在边界内，表格列与合计对齐，未见字体挤压或非预期裁切。
- `batches/selected-a-full-20261018T110532Z-47bd5687/captures/grok-a-caaed7d73f6d/light/baseline.png`；对应同目录 `light/layout.json`。暖米色全页 topbar、两排指标与两列主面板位置一致；图表及右侧两条详情条完整，表格标题/搜索框/合计对齐；底部两面板完整，未见字体挤压。人物装饰在页面侧缘有画面裁边，但未裁切功能面板，不把不同人物 artwork rect 当作固定布局差异。
- `batches/selected-a-full-20261018T110532Z-47bd5687/captures/grok-a-caaed7d73f6d/dark/baseline.png`；对应同目录 `dark/layout.json`。暖棕黑全页保持浅色的固定几何排列；topbar 和指标无重叠，图表轴与图例完整，左右面板/表格/底部面板未见挤压或非预期裁切。深色标题对比度不在本几何判定范围。

四张均由 PNG IHDR 独立读取为 **1920×2171**；各 layout 为 viewport **1920×1080、dpr=1、scroll=(0,0)、documentHeight=2171**。因此是全页截图，不能把 2171 高度误当视口高度。查看工具显示时缩放至 1499×1696，本报告尺寸来自原文件字节。

两份 `K/capture.json`、`G/capture.json` 的 `modes.<light|dark>.baseline.evidence` 均明确绑定 `layoutJson=layout.json` 与 `baseline.file=baseline.png`；四图实际 SHA-256 均与该记录一致（且文件非空）：

- K/light：`bbffebaf3d9f192beebf4981a2445f9e1834449eab5e2f58a2997fa97bf101b7`，1,065,990 bytes。
- K/dark：`425bc3e65a5bb465cd8b8ecb8a2ee07e2c88ef6ff9d845465abd26e490252513`，1,162,871 bytes。
- G/light：`361892ae30cf69efa02d154dec4cc03daac4cdfb95a0abfa5f05cf82e09c191e`，1,230,121 bytes。
- G/dark：`028dda4bcd619a892df93c3fd724465cef6b0712ffbe5b75d06ba592413bfad6`，1,254,737 bytes。

## 固定元素数值核对

四份 layout 的 `elements` 中以下 rect（x,y,width,height，CSS px）逐分量完全相同。分别比较 K/light↔G/light、K/dark↔G/dark，以及同候选浅↔深，最大绝对差均 **0 px**：

- topbar：`(240, 28, 1440, 72)`。
- firstMetric：`(240, 243, 223.328125, 111.1875)`。
- firstPanel：`(240, 603.21875, 953.328125, 384)`。
- chart：`(264, 695.21875, 905.328125, 238)`。

两 capture 的 base fixtureHash 均为 `53856bb4c64c7629f80728416ff8e41b073ce13915454c8bc00396836f24a005`，baselineStateId 均为 `dashboard-default`。这是**同 fixture 下两款候选及其浅深模式之间**的固定布局比较，绝不是生产旧版前后对比。

## 当前布局源同源核对与范围

对当前工作区三个文件直接计算字节 SHA-256，逐项与 **K 和 G 两份 capture.json 的 sourceHashes** 比较，六项相等：

- `public/styles.css`：`08aad199720827515738e789c50d7ec969b927a8b22a39e9af6cc3ac944fa409`。
- `public/skins.css`：`df7e461d51eeeb69db02479ea6ae0d0dfbc18e8b49bcb2d15a5d6fcce55ebc76`。
- `public/index.html`：`69e38dd284e63911ea3c3e26f3b1d8ac5294ddb5d3a8663cf57997a29f4a389f`。

此处证据链是现存 capture 的明确文件绑定、实际 PNG hash/尺寸、配套 layout 的 viewport/rect、实际四图观察，以及与当前三个布局源文件相等的 sourceHashes；支持当前候选使用同一冻结布局源，并非为缺失记录随意补截图。hash 核对证明这三个文件的当前字节与捕获声明一致，不单独证明全部运行时来源或历史状态。

未核验其他候选/状态/视口、真实设备缩放或浏览器 zoom；未做生产旧版对比、全历史几何审计、颜色可读性或交互验收。此有限核验不能证明一切历史均无几何变更，也不代替 formal 选择。
