# Agent Usage

简体中文 · [English](README.en.md)

Agent Usage 是在本机运行的 Codex 与 ZCode 用量看板。它读取已有的会话和用量记录，让你按时间、渠道、模型与仓库查看 Token 消耗、缓存命中、会话数和 API 等价费用估算。数据保留在本机，无需上传日志。

本项目基于 [DhWU-coder/codex-usage](https://github.com/DhWU-coder/codex-usage) 继续开发。

## 快速开始

需要 **Node.js 22.13 或更新版本**，可用 `node -v` 检查。下载仓库 ZIP 并解压，或运行：

```bash
git clone https://github.com/Sylva1027/codex-usage.git
cd codex-usage
node src/cli.js run
```

打开 [http://127.0.0.1:3765/](http://127.0.0.1:3765/)。服务默认只监听 `127.0.0.1`；在终端按 `Ctrl+C` 停止。无需安装 npm 依赖。在 Windows PowerShell 中，直接使用上述 `node` 命令即可避开 `npm.ps1` 执行策略限制。

## 看板功能

- **时间与趋势：** 支持今日、本周、本月、全部、自定义日期，以及按小时、天、周、月查看时间分布。“本周”按自然周计算。
- **最近范围：** “上一个 5h”和“上周”分别指上一个已结束的 Codex 5 小时限额窗口和每周限额窗口；“上个月”是上一个完整自然月；“今年”从本年 1 月 1 日统计至今。这里的“上周”是限额周，不是自然周。
- **Codex 限额：** `5h / Week` 在当前 5 小时与每周限额窗口之间切换。窗口边界取自本机 Codex 限额观察值，5 小时图按半小时、每周图按连续 24 小时显示；没有可靠记录时不会推测边界。未选中 Codex 数据来源时，限额按钮及“上一个 5h”“上周”选项会置灰。
- **用量与费用：** 查看 Total Input、Cache Hit、Cache Miss、Output、Reasoning Tokens、Cache Hit Rate 等指标；按渠道、模型和 Git 仓库比较用量，搜索并排序明细。缓存命中输入与未命中输入分开计价。
- **纪录与对比：** 适用的时间范围会标出新高，并与可比较的上一周期对照。“全部”没有上一周期，也不会显示 New Record 标记。
- **来源与刷新：** 自动发现本机 Codex 和 ZCode 数据，也可导入其他 Codex / ZCode 目录，或包含 `.codex-usage/usage.jsonl` 的项目目录。在“编辑”中选择参与统计的来源。页面默认每 60 秒检查新记录；暂停自动刷新后，切换范围仍使用冻结的数据快照。
- **语言与外观：** 主题按钮旁的“文/A”可切换简体中文与英文。首次打开采用浏览器首选语言，手动选择会被记住；另有深色和浅色主题。

## 数据来源与隐私

Codex 用量来自 `~/.codex` 等 Codex home 下的会话日志。ZCode 用量默认来自 `~/.zcode/cli/db/db.sqlite`，以只读方式打开，不修改 ZCode 数据库。未写入这些记录、也未通过项目日志导入的请求不会出现在统计中。

- `CODEX_USAGE_ZCODE_HOMES`：追加 ZCode 数据目录；多个路径用系统路径分隔符分隔（Windows 为 `;`，macOS/Linux 为 `:`）。
- `CODEX_USAGE_ZCODE=0`：关闭 ZCode 数据源。

扫描结果保存在本机 SQLite 增量索引中，默认路径为 `~/.codex-usage/usage-index.sqlite`；重复扫描只处理变化的文件。

## 费用估算

看板按模型和 Token 类别估算 **API 等价费用，并非实际账单或订阅限额费用**。价目可在看板中查看和编辑；支持输入未命中（Cache Miss）、缓存命中（Cache Hit）、缓存写入、输出，以及适用模型的长上下文和 Fast/Priority 费率。记录缺少必要明细时，页面会标明按最低适用费率估算的部分和无法计价的部分。

内置价目参考各厂商公开资料：[OpenAI](https://developers.openai.com/api/docs/pricing)、[StepFun](https://platform.stepfun.com/docs/zh/guides/pricing/details)、[MiMo](https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go)、[DeepSeek](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[Kimi](https://platform.kimi.com/docs/pricing/chat)、[GLM](https://bigmodel.cn/pricing)、[xAI](https://docs.x.ai/developers/pricing)、[Qwen](https://www.qwencloud.com/pricing/api)、[Gemini](https://ai.google.dev/gemini-api/docs/pricing)、[MiniMax](https://platform.minimax.io/docs/guides/pricing-paygo)、[Meta](https://dev.meta.ai/docs/pricing-rate-limits)。各模型保留原价目币种（USD 或 CNY）；同时出现两种币种时并列显示，跨币种图表比较使用可调整汇率。价目和优惠规则可能变化，请在据此决策前核对厂商公告。

## 命令与静态快照

```bash
node src/cli.js summary       # 终端汇总
node src/cli.js summary --json
node src/static-export.js     # 导出独立 HTML
node --test                   # 运行测试
```

静态快照写入 `dist/codex-usage.html`，可直接打开并切换语言。它固定在导出时的数据与限额观察值，不会自动刷新；更新数据需要重新导出。HTML 内嵌用量数据，可能包含本机路径，分享前请检查。

项目采用 [MIT License](LICENSE)。
