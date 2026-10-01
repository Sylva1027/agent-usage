# Agent Usage 文档入口

更新：2026-10-02。按阅读目的选择入口；功能状态与专项进度从[任务清单](02-tasks.md)进入，本页只负责导航。

## 日常入口

- [使用与启动](../README.md)：快速开始、看板操作、数据来源和隐私摘要；另有 [English](../README.en.md)。
- [路线图与项目边界](01-roadmap.md)：已交付的能力、现有限制和后续工作的判断依据。
- [任务清单](02-tasks.md)：当前工作、已交付批次以及仍需核实的边界。
- [开发与接手](03-development.md)：代码位置、开发命令、验证方法和文档维护规则。

## 当前专项计划

- [模型娘化角色皮肤系统计划](plans/2026-10-01-model-character-skin-plan.md)：十套角色素材接入，默认透明度 50%、功能布局固定、衣服图标入口、同级独立弹窗及浅深配色同屏比较；具体颜色暂缓。
- [角色皮肤 TODOs](plans/2026-10-01-model-character-skin-todos.md)：现有素材清点、页面接入、实施与验收的逐项清单。
- [Claude 价格与现有来源计费接入计划](plans/2026-10-01-claude-pricing-plan.md)：已确认范围、Anthropic 价目、来源字段与验收规格。
- [Claude 接入 TODOs](plans/2026-10-01-claude-pricing-todos.md)：本批实时实施进度与实际验证结果。
- [2026-10-01 看板修正 Implementation Plan](plans/2026-10-01-dashboard-corrections-implementation-plan.md)：本轮九项要求的实施规格、依赖与验收条件。
- [看板修正 TODOs](plans/2026-10-01-dashboard-corrections-todos.md)：本批详细进度，按每项实际完成和验证实时更新。

## 现行专题说明

- [10 数据来源与统计口径](10-data-sources.md)：目录发现、导入、增量索引、限额范围和数据边界。
  - [Codex](data-sources/codex.md)：会话 JSONL、累计计数与请求增量、限额观察值。
  - [ZCode](data-sources/zcode.md)：SQLite 用量记录、子代理渠道与 WAL 指纹。
  - [DSH](data-sources/dsh.md)：多帧 zstd、已核实的输入/缓存重构、版本守护与索引升级。
  - [OpenCode](data-sources/opencode.md)：消息级用量、并列计数折叠、能力探测和版本守护。
- [11 计价与自动更新](11-pricing.md)：模型解析、免费规则、缺价估算、来源更新、手动覆盖和汇率。
- [12 看板行为](12-dashboard.md)：时间范围、排序、刷新、语言、主题和交互约定。
- [13 静态导出约定](13-static-export.md)：模块内联、自包含 HTML、冻结快照与离线检查。
- [14 项目日志接入](14-project-log.md)：其他项目生成可导入的 JSONL、字段规范与最小校验。

这些文档描述现有实现。价格、上游数据结构、真实日志数量和测试总数会变化，具体代码、受测版本和日期记录仍需分别核对。

## 验证资料与历史

- [验证索引](validation/00-index.md)：区分本地自动检查、合成数据浏览器验收、历史真库对照与尚未验证的路径。
- [2026-10-01 Claude 验收](validation/2026-10-01-claude-pricing/README.md)：价格、缓存场景、DSH 修正、三路重算与页面验证。
- [2026-10-01 看板九项修正验收](validation/2026-10-01-dashboard-corrections/README.md)：本批检查、结果、截图与重跑入口。
- [2026-10-01 关闭状态验收](validation/2026-10-01-refresh-off/README.md)：关闭及冻结范围切换保持高度。
- [2026-10-01 v0.5.0 发布](validation/2026-10-01-release/README.md)：提交/标签/正式Release与远端CI证据。
- [2026-10-01 加载圈与下拉框验收](validation/2026-10-01-refresh-dropdowns/README.md)：状态高度稳定、双菜单对齐及材质统一。
- [2026-10-01 标题最终居中验收](validation/2026-10-01-title-centering/README.md)：真实截图字面居中、手机和字体回退验证。
- [2026-10-01 模型列表与顶部框体反馈验收](validation/2026-10-01-dashboard-feedback/README.md)：旧契约兼容、真实模型恢复与连续框体截图。
- [2026-09-30 UI 与计价验收](validation/2026-09-30-ui-pricing/README.md)：原始脚本、结果、日志和截图。
- [2026-10-01 合并检查与文档整理](validation/2026-10-01.md)：提交基线、整理范围和本轮检查。
- [历史归档索引](archive/00-index.md)：已完成或被取代的计划、调查、评审和交接记录。

## 文档放置规则

- 根目录 README 面向使用者，保留快速开始和功能摘要。
- `00`—`03` 是导航、方向、状态和接手入口；`10`—`14` 是长期维护的现行说明。
- `data-sources/` 保存各来源的格式与映射，公共规则只在 10 中维护。
- `validation/` 保存按日期组织的实际检查证据，不用旧结果替代新版本验收。
- `plans/` 保存当前专项实施计划和对应 TODO；02 提供任务入口，专项详细进度仅在对应 TODO 中维护，完成后提炼有效规则再归档。
- `archive/` 保留旧计划和决策过程；有效规则先提炼到现行说明，未解决项进入 02，再归档原文。
- `docs/README.md` 与根目录 `log-README.md` 保留为导航兼容页，不复制专题正文。
