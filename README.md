# Agent Usage

简体中文 · [English](README.en.md)

Agent Usage 是在本机运行的 Codex、ZCode、DSH 与 OpenCode 用量看板。它读取已有的会话和用量记录，让你按时间、渠道、模型与仓库查看 Token 消耗、缓存命中、会话数和 API 等价费用估算。数据保留在本机，无需上传日志。

本项目基于 [DhWU-coder/codex-usage](https://github.com/DhWU-coder/codex-usage) 继续开发。

当前版本：[v0.5.0](https://github.com/Sylva1027/codex-usage/releases/tag/v0.5.0)。

## 快速开始

需要 **Node.js 23.8 或更新版本**，可用 `node -v` 检查。下载仓库 ZIP 并解压，或运行：

```bash
git clone https://github.com/Sylva1027/codex-usage.git
cd codex-usage
node src/cli.js run
```

打开 [http://127.0.0.1:3765/](http://127.0.0.1:3765/)。服务默认只监听 `127.0.0.1`；在终端按 `Ctrl+C` 停止。无需安装 npm 依赖。在 Windows PowerShell 中，直接使用上述 `node` 命令即可避开 `npm.ps1` 执行策略限制。

## 看板功能

- **时间与趋势：** 支持今日、本周、本月、全部、自定义日期及最近范围。“本周”按自然周计算。时间分布可按渠道、模型或估算花销查看；较长的“全部”、自定义和最近范围会自动从日柱合并为周柱或月柱，副标题和悬浮提示会标出合并粒度与覆盖日期。
- **最近范围：** “上一个 5h”和“上周”分别指上一个已结束的 Codex 5 小时限额窗口和每周限额窗口；“上个月”是上一个完整自然月；“今年”从本年 1 月 1 日统计至今。这里的“上周”是限额周，不是自然周。
- **Codex 限额：** `5h / week` 在当前 5 小时与每周限额窗口之间切换。这两个限额范围以及“上一个 5h”“上周”只统计 Codex 来源；普通的今日、本周、本月等范围仍统计所有已选来源。窗口边界取自本机 Codex 限额观察值，5 小时图按半小时、每周图按连续 24 小时显示；没有可靠记录时不会推测边界。未选中 Codex 数据来源时，限额按钮及对应的最近范围选项会置灰。
- **用量与费用：** 查看 Total Input、Cache Hit、Cache Miss、Output、Reasoning Tokens、Cache Hit Rate 等指标；按渠道、模型和 Git 仓库比较用量，搜索并排序明细。模型名在界面上统一小写显示，原始模型标识仍用于聚合和计价。缓存命中输入与未命中输入分开计价。普通范围将子代理和执行渠道合并到 Codex/ZCode/DSH/OpenCode；Codex 专属限额范围保留细分渠道。仓库列表优先展示本地 Git 仓库，再按所选周期排序。
- **纪录与对比：** 适用的时间范围会标出新高，并与可比较的上一周期对照。“全部”没有上一周期，也不会显示 New Record 标记。
- **来源与刷新：** 自动发现本机 Codex、ZCode、DSH 和 OpenCode 数据，也可导入其他 Codex / ZCode / DSH 目录、OpenCode 数据目录，或包含 `.codex-usage/usage.jsonl` 的项目目录。在“编辑”中选择参与统计的来源。通过“扫描目录”添加来源。页面默认每 60 秒检查新记录，检查中在开关旁显示加载圈；暂停自动刷新后，切换范围仍使用冻结的数据快照。
- **语言与外观：** 主题按钮旁的“文/A”可切换简体中文与英文。首次打开采用浏览器首选语言，手动选择会被记住；另有深色和浅色主题。

## 数据来源与隐私

Codex 用量来自 `~/.codex` 等 home 下的会话日志；ZCode 默认来自 `~/.zcode/cli/db/db.sqlite`；DSH（DeepSeek Harness）来自 `~/.dsh/sessions`；OpenCode 来自数据目录（如 `~/.local/share/opencode`）下的 `opencode*.db`。未记录、也未通过项目日志导入的请求不会出现在统计中。

适配器提取用量和必要元数据，不把正文作为统计事件字段。SQLite 优先只读打开，失败时现有实现会退回普通打开，可能触发恢复或辅助文件操作；应用不主动改写上游业务记录。格式、导入和读取边界见[数据来源说明](docs/10-data-sources.md)。

- `CODEX_USAGE_ZCODE_HOMES`：追加 ZCode 数据目录；多个路径用系统路径分隔符分隔（Windows 为 `;`，macOS/Linux 为 `:`）。
- `CODEX_USAGE_ZCODE=0`：关闭 ZCode 自动发现。
- `CODEX_USAGE_DSH_HOMES`：追加 DSH 数据目录，路径分隔符同上。
- `CODEX_USAGE_DSH=0`：关闭 DSH 自动发现。
- `CODEX_USAGE_OPENCODE_HOMES`：追加 OpenCode 数据目录，路径分隔符同上。
- `CODEX_USAGE_OPENCODE=0`：关闭 OpenCode 自动发现。

普通范围统计全部已选来源；**5 小时与每周限额窗口只衡量 Codex 用量**，其余来源不参与。

扫描结果保存在本机 SQLite 增量索引中，默认路径为 `~/.codex-usage/usage-index.sqlite`；重复扫描只处理变化的文件。

## 费用估算

看板按模型和 Token 类别估算 **API 等价费用，并非实际账单或订阅限额费用**。价目可在看板中查看和编辑；支持输入未命中（Cache Miss）、缓存命中（Cache Hit）、缓存写入、输出，以及适用模型的长上下文和 Fast/Priority 费率。记录缺少必要明细时，页面会标明按最低适用费率估算的部分和无法计价的部分。

现有来源中的 Claude 支持 17 个内置版本、官方日期快照和 Anthropic 来源价格更新。缓存写入采用明确的 5 分钟场景，TTL 缺失时会提示；已知其他 TTL 的写入不套用该价。更早未收录版本保持缺价提示，ZCode 缓存包含关系仍待上游证据核实。

本地看板自动检查公开模型价目和 USD/CNY 汇率，正常每 24 小时刷新、失败后一小时重试。已有来源支持 Models.dev、LiteLLM 及 StepFun、MiMo、Kimi、GLM 官方页面；新模型补录目前限于有完整证据的 OpenAI USD 文本模型。“在用模型”只列出最近一个滚动日历月出现的模型；一个月未出现即退出该列表，历史计价仍保留在“全部模型”。缺价模型保持可见，未收录的 `-free` 模型适用免费推算，其余缺价部分继续标明最低费率估算。

自动结果保存在 `~/.codex-usage/pricing-auto.json`，手动修改保存在 `~/.codex-usage/pricing.json` 并始终优先；断网使用缓存或内置值。联网只读取公开价格与汇率，不上传本机用量或模型名。金额保留原币种，混币图表使用可调整汇率。完整规则、来源限制和手动覆盖见[计价说明](docs/11-pricing.md)；供应商费率可能变化，请按价目中的来源链接核验。

## 命令与静态快照

```bash
node src/cli.js summary       # 终端汇总
node src/cli.js summary --json
node src/static-export.js     # 导出独立 HTML
node --test                   # 运行测试
```

静态快照写入 `dist/codex-usage.html`，可直接打开并切换语言。它固定在导出时的数据与限额观察值，不会自动刷新；更新数据需要重新导出。HTML 内嵌用量数据，可能包含本机路径，分享前请检查。

## 文档与开发

- [文档入口](docs/00-index.md)：路线图、任务、现行专题、验证和历史归档。
- [看板行为](docs/12-dashboard.md)：范围、排序、刷新、弹窗、语言和主题约定。
- [项目日志接入](docs/14-project-log.md)：让其他项目生成可导入的真实 Token 用量日志。
- [开发与接手](docs/03-development.md)：代码位置、环境和检查命令。

项目采用 [MIT License](LICENSE)。
