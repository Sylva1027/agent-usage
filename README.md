# Agent Usage

简体中文 · [English](README.en.md)

Agent Usage 是在本机运行的 Codex、ZCode、DSH、OpenCode、Claude Code 与 WorkBuddy 用量看板。它读取已有的会话和用量记录，让你按时间、渠道、模型与仓库查看 Token 消耗、缓存命中、会话数和 API 等价费用估算。数据保留在本机，无需上传日志。

当前版本：[v0.8.0](https://github.com/Sylva1027/codex-usage/releases/tag/v0.8.0)。v0.8.0 保持轻量常驻服务，计算进程按需启动并在空闲后退出，复用本地汇总，并支持经本机明确授权后的额度只读恢复。

![DeepSeek 浅色皮肤看板，16:9，示例数据](docs/images/dashboard-deepseek-light.png)

## 快速开始

需要 **Node.js 23.8 或更新版本**，可用 `node -v` 检查。下载 [v0.8.0 ZIP](https://github.com/Sylva1027/codex-usage/releases/download/v0.8.0/agent-usage-v0.8.0.zip) 并解压，或运行：

```bash
git clone https://github.com/Sylva1027/codex-usage.git
cd codex-usage
npm ci --omit=dev
node src/cli.js run
```

打开 [http://127.0.0.1:3765/](http://127.0.0.1:3765/)。服务默认只监听 `127.0.0.1`；在终端按 `Ctrl+C` 停止。Release 的 ZIP/TAR.GZ 已附带本地分词依赖，解压后可直接运行 `node src/cli.js run`；Git clone 和 GitHub 自动生成的源码包须先执行 `npm ci --omit=dev`。在 Windows PowerShell 7 中可用 `npm.cmd` 避开 `npm.ps1` 执行策略限制。

模型速度使用统一分词的实际正文和工具参数输出，按接收批次计时。Codex 需采用完整采集并排包，DSH 安装本地 Cordis 插件，WorkBuddy CLI 通过采集启动器运行；安装步骤与已支持范围见[本地速度采集](docs/10-data-sources.md#本地采集安装)。

## 看板功能

- **时间与趋势：** 支持今日、本周、本月、全部、自定义日期及最近范围。“本周”按自然周计算。时间分布可按渠道、模型或估算花销查看；较长的“全部”、自定义和最近范围会自动从日柱合并为周柱或月柱，副标题和悬浮提示会标出合并粒度与覆盖日期。
- **最近范围：** “上一个5h”和“上一个7d”按本机记录的同类真实额度周期统计：起点为原定 reset 减去对应窗口时长，终点取原定 reset 与可信提前替换起点中的较早者；计划 reset 后到下一轮之间的空档不计入上一轮。“上个月”是上一个完整自然月；“今年”从本年 1 月 1 日统计至今。
- **Codex 限额：** `5h / week` 在当前 5 小时与每周限额窗口之间切换。这两个限额范围以及“上一个5h”“上一个7d”只统计 Codex 来源；普通的今日、本周、本月等范围仍统计所有已选来源。窗口边界默认取自本机 Codex 限额观察值。当前5小时图按半小时、当前每周图按连续24小时显示；上一个5h只画有用量的半小时，最后一段截止到该轮有效终点；上一个7d只画有用量的日历日期。后台保留完整起止时间和时长。没有可靠记录时不会推测边界。未选中 Codex 数据来源时，限额按钮及对应的最近范围选项会置灰。
- **用量与费用：** 查看 Total Input、Cache Hit、Cache Miss、Output、Reasoning Tokens、Cache Hit Rate 等指标；按渠道、模型和 Git 仓库比较用量，搜索并排序明细。用量表中的模型名统一小写显示，原始模型标识仍用于聚合和计价；模型速度区保留原名。缓存命中输入与未命中输入分开计价。普通范围将子代理和执行渠道合并到 Codex/ZCode/DSH/OpenCode/Claude/WorkBuddy；Codex 专属限额范围保留细分渠道。仓库列表优先展示本地 Git 仓库，再按所选周期排序。
- **模型速度：** 独立区域按平均输出速度从快到慢排列，模型原名与推理强度分开显示，并区分 Codex / DSH / OpenCode / ZCode / WorkBuddy / Claude。选择一行查看平均速度、样本数与 p10–p90 区间；沿用现有时间范围、来源编辑和冻结快照。tps-v6 使用本地统一分词与匹配的传输窗口；Codex、DSH 和 WorkBuddy CLI 安装采集后显示新请求的实际输出速度。缺少观测的旧请求仍保留用量。
- **纪录与对比：** 适用的时间范围会标出新高，并与可比较的上一周期对照。“全部”没有上一周期，也不会显示 New Record 标记。
- **来源与刷新：** 自动发现本机 Codex、ZCode、DSH、OpenCode、Claude Code 和 WorkBuddy 数据，也可导入其他 Codex / ZCode / DSH 目录、OpenCode 数据目录、Claude Code home、WorkBuddy home，或包含 `.codex-usage/usage.jsonl` 的项目目录。在“编辑”中选择参与统计的来源。通过“扫描目录”添加来源。页面默认每 60 秒检查新记录，检查中在开关旁显示加载圈；失败后下次检查会重试，错误详情在原刷新框内切换查看。暂停自动刷新后，切换范围仍使用冻结的数据快照。
- **语言与外观：** 主题按钮旁的“文/A”可切换简体中文与英文。首次打开采用浏览器首选语言，手动选择会被记住；另有深色和浅色主题。衣服图标打开“界面风格”（英文 Waifu），目前开放 ChatGPT、Claude、GLM、Gemini、DeepSeek、Kimi、Qwen、Grok、Muse、Mimo 十款皮肤及简洁模式，采用更新的整页配色。浅深缩略图同时预览，桌面五列两行，选中以泛光圆点表示；角色显示和透明度可调整，偏好会被记住。

![界面风格选择器，十款皮肤与浅深配色预览](docs/images/skin-picker.png)

## 数据来源与隐私

5h/7d 及上一额度周期结合本机认证、路由和模型名筛选，排除明确的 API、外部模型及可识别的 credits 补量阶段；普通日期范围保留全部已选来源。历史证据不足时使用模型规则兜底，详细口径见[看板说明](docs/12-dashboard.md)。

Codex 用量来自 `~/.codex` 等 home 下的会话日志；ZCode 默认来自 `~/.zcode/cli/db/db.sqlite`；DSH（DeepSeek Harness）来自 `~/.dsh/sessions`；OpenCode 来自数据目录（如 `~/.local/share/opencode`）下的 `opencode*.db`；Claude Code 来自 `~/.claude/projects` 下的会话转录（含 `subagents`，按 `message.id` 去重）；WorkBuddy 来自 `~/.workbuddy-ai/projects` 下的会话记录（按 `providerData.messageId` 去重，`model=default-model` 的 Auto 记录整体排除），历史调用时长保留自同目录 `traces/<pid>` 下的 `generation` span，当前速度使用本地采集观测。未记录、也未通过项目日志导入的请求不会出现在统计中。

Codex 限额默认只读取本机记录。只有本机 `~/.codex-usage/codex-quota.json` 明确设置 `recoveryEnabled: true`，且请求的当前窗口为 `missing` 或 `waiting` 时，才会通过官方 Codex app-server 只读补齐；有效边界不查询，已确认不提供 5h 窗口时不反复查询，失败后冷却 5 分钟。补齐边界保存在本机并进入 SQLite；用量统计不上传，不依赖 Magpie，不保存 token、邮箱或原始账户 ID，也没有常驻 UI。

适配器提取用量和必要元数据，不把正文作为统计事件字段。SQLite 优先只读打开，失败时现有实现会退回普通打开，可能触发恢复或辅助文件操作；应用不主动改写上游业务记录。格式、导入和读取边界见[数据来源说明](docs/10-data-sources.md)。

- `CODEX_USAGE_ZCODE_HOMES`：追加 ZCode 数据目录；多个路径用系统路径分隔符分隔（Windows 为 `;`，macOS/Linux 为 `:`）。
- `CODEX_USAGE_ZCODE=0`：关闭 ZCode 自动发现。
- `CODEX_USAGE_DSH_HOMES`：追加 DSH 数据目录，路径分隔符同上。
- `CODEX_USAGE_DSH=0`：关闭 DSH 自动发现。
- `CODEX_USAGE_OPENCODE_HOMES`：追加 OpenCode 数据目录，路径分隔符同上。
- `CODEX_USAGE_OPENCODE=0`：关闭 OpenCode 自动发现。
- `CODEX_USAGE_CLAUDE_HOMES`：追加 Claude Code home，路径分隔符同上（`CLAUDE_CONFIG_DIR` 会自动发现）。
- `CODEX_USAGE_CLAUDE=0`：关闭 Claude Code 自动发现。
- `CODEX_USAGE_WORKBUDDY_HOMES`：追加 WorkBuddy home，路径分隔符同上。
- `CODEX_USAGE_WORKBUDDY=0`：关闭 WorkBuddy 自动发现。

普通范围统计全部已选来源；**5 小时与每周限额窗口只衡量 Codex 用量**，其余来源不参与。

`codex-auto-review` 按[官方免费政策](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)计为零费用，不参与当前或上一限额窗口统计；普通范围仍显示它的实际 Token 与运行记录。旧的同名手动费率也不能覆盖该免费规则。

扫描结果保存在本机 SQLite 增量索引中，默认路径为 `~/.codex-usage/usage-index.sqlite`；重复扫描只处理变化的文件。

## 费用估算

看板按模型和 Token 类别估算 **API 等价费用，并非实际账单或订阅限额费用**。价目可在看板中查看和编辑；支持输入未命中（Cache Miss）、缓存命中（Cache Hit）、缓存写入、输出，以及适用模型的长上下文和 Fast/Priority 费率。记录缺少必要明细时，页面会标明按最低适用费率估算的部分和无法计价的部分。

现有来源中的 Claude 支持 17 个内置版本、官方日期快照和 Anthropic 来源价格更新。缓存写入采用明确的 5 分钟场景，TTL 缺失时会提示；已知其他 TTL 的写入不套用该价。更早未收录版本保持缺价提示，ZCode 缓存包含关系仍待上游证据核实。

本地看板自动检查公开模型价目和 USD/CNY 汇率，正常每 24 小时刷新、失败后一小时重试。已有来源支持 Models.dev、LiteLLM 及 StepFun、MiMo、Kimi、GLM 官方页面；新模型补录目前限于有完整证据的 OpenAI USD 文本模型。“在用模型”只列出最近一个滚动日历月出现的模型；一个月未出现即退出该列表，历史计价仍保留在“全部模型”。缺价模型保持可见，未收录的 `-free` 模型适用免费推算，其余缺价部分继续标明最低费率估算。

自动结果保存在 `~/.codex-usage/pricing-auto.json`，手动修改保存在 `~/.codex-usage/pricing.json` 并优先覆盖费率（官方免费豁免除外）；断网使用缓存或内置值。联网只读取公开价格与汇率，不上传本机用量或模型名。金额保留原币种，混币图表使用可调整汇率。完整规则、来源限制和手动覆盖见[计价说明](docs/11-pricing.md)；供应商费率可能变化，请按价目中的来源链接核验。

## 命令

```bash
node src/cli.js summary       # 终端汇总
node src/cli.js summary --json
node --test                   # 运行测试（首次先 npm ci 装 devDependencies）
```

从 GitHub 的源码压缩包解出的副本同样可以运行测试：日期验收截图与作者源图不随包分发，读取它们的 14 个用例会明确跳过，其余照常运行。细节见[怎么跑测试](docs/03-development.md#怎么跑测试)。

## 文档与开发

- [文档入口](docs/00-index.md)：路线图、任务、现行专题、验证和历史归档。
- [看板行为](docs/12-dashboard.md)：范围、排序、刷新、弹窗、语言和主题约定。
- [项目日志接入](docs/14-project-log.md)：让其他项目生成可导入的真实 Token 用量日志。
- [开发与接手](docs/03-development.md)：代码位置、环境和检查命令。

项目采用 [MIT License](LICENSE)。
