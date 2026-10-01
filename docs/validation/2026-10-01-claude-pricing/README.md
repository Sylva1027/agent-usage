# Claude 价格与现有来源计费验收

日期：2026-10-01。受测版本：当时工作区，基于 v0.5.0 之后的本地改动；验收时尚未提交或发布。其后纳入 [2026-10-02 本地保存点提交](../2026-10-02-pre-skin-checkpoint.md)，以下历史检查记录原样保留。范围见[接入计划](../../plans/2026-10-01-claude-pricing-plan.md)，唯一逐项进度见[TODOs](../../plans/2026-10-01-claude-pricing-todos.md)。

受测 HEAD：`d3228fff4bfe7a0e5a88b136a5442e3548354e98`；环境为 Windows、Node v24.19.0、Edge 154.0.4258.37。HEAD 不是本批补丁提交，验证包含此前尚未提交的用户看板改动。

## 交付行为

新增 17 个 Claude 内置项，目录 103 项，上限由共享常量统一为 256。精确键优先，7 个官方日期快照与 `anthropic/` 可映射；未知版本不借相邻版本价格，也不被 OpenAI 新模型发现错误创建。保留旧手动配置与字段覆盖优先级。

Anthropic 自动价格限定提供商与精确模型身份，校验 5 分钟写入口径；缺失字段继承、失败保留有效缓存、手动字段优先。页面与时间图展示 TTL、未核实 Fast 和历史上下文场景，中英文和静态导出共用规则。未知模型的最低价场景不再误挂 OpenAI 来源。

DSH 的非零缓存写入加入总输入，total 缺失时不重复加写入；v11 索引迁移仅标记 DSH 文件待重建。Haiku 4.5 fixture 的 1,000 普通输入 + 8,000 读 + 1,000 写 + 500 输出 = 10,500 tokens，Standard 5 分钟为 $0.00555；手动将普通输入单价从 1 改为 2 后，同一历史记录为 $0.00655，原 Token 不变。内存、SQLite、静态嵌入一致。

## 实际验证

- `npm.cmd test`：323/323 通过，日志 [tests.log](tests.log)。其中 Claude 专项 11 项包含价格例外、固定快照、防串价、非零写入、TTL、Fast/上下文边界、提供商隔离、手动覆盖、失败回退、旧配置、容量及 v9/v10→v11 迁移；服务器回归另验证 256 项 API 保存和超限拒绝。
- `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run format:check`：均退出 0，见 [typecheck.log](typecheck.log)、[lint.log](lint.log)、[format.log](format.log)。Lint 保留当前工作区的 41 条既有警告，涉及未修改的 CSS 及 DSH 测试未用 import；本批新增代码没有诊断。
- 隔离 Edge 页面验收：45/45 通过，见 [browser-results.json](browser-results.json)和 [browser.log](browser.log)。1440/390 px × 中英 × 深浅主题，在线与网络禁用的静态页面均有检查和截图；覆盖 Anthropic 链接、TTL 主说明/时间图/编辑器、未知版本缺价、保存手动覆盖、历史重算、模拟上游失败及离线禁用操作。没有页面脚本错误或外部页面请求。
- 人工截图检查：已查看[手机深色编辑器](live-390-dark-zh-CN-editor.png)与[桌面英文](live-1440-light-en-US.png)，模型、币种、场景提示和费用来源可读。
- 公开来源实测：本批 17 项中 Models.dev 精确匹配 13 项，四类 Standard 费率与内置一致；未匹配的 Opus 4/4.1、Sonnet 4、Haiku 3.5 保留本地价。见 [source-results.json](source-results.json)和 [source.log](source.log)。这是当次下载结果，区别于自动来源可维护范围和 fixture 成功数。
- 文档检查：13 份本批文档中的 130 个本地链接目标均存在，见 [docs-links.log](docs-links.log)；最终 `git diff --check` 通过。

首轮完整回归有两处旧 100 项容量断言失败，修正为共享上限；浏览器发现未知版本估算误带 OpenAI 链接，已修复。验收脚本曾误把 API 包装响应当直接 summary，已纠正。保留 [tests-initial.log](tests-initial.log)、[browser-initial.log](browser-initial.log)及[初次结果](browser-results-initial.json)，最终通过记录对应修正后的代码。

## 证据与边界

人工核对 [Anthropic 官方价格](https://platform.claude.com/docs/en/about-claude/pricing)、[模型 ID](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)、[缓存字段](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)。缓存读例外逐模型记录；Fast 当前只为 Opus 5.5/5/4.8 建档，不给其他 Claude 套用通用双倍规则。Models.dev 的第一方 `cache_write` 另以[上游 Haiku 定义](https://github.com/anomalyco/models.dev/blob/dev/providers/anthropic/models/claude-haiku-4-5.toml)交叉核对为 5 分钟费率。

DSH 安装包只读调查：`E:/DeepSeek Harness/resources/app.asar` 中 `dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/index.js` 将原始 `inputTokens` 视为 uncached input，已知输入等于普通输入 + 缓存读 + 缓存写；`lib/types/turn-usage.js` 用相同关系校验 prompt 和总量减输出。使用版本 4 合成日志覆盖非零写入，未声称验证真实非零写入账单。

ZCode 未找到可核验的写库逻辑，因此不改变输入包含关系。现有来源也未提供已核实的缓存 TTL；缺失时明确 5 分钟估算，已知 1 小时的直接估算回归保留写入未计价。没有增加混合 TTL 的持久化或完整 1 小时计费。旧模型超过已核验 Standard 范围时展示基础价场景，不追溯历史长上下文收费。没有接入 Claude Code、地域/批量/工具费用或 Claude 新模型自动创建。

## 重跑

在仓库根运行 `npm.cmd test` 和三项静态检查。页面脚本入口为 `node docs/validation/2026-10-01-claude-pricing/browser-audit.mjs`，只创建临时 home 和随机端口服务；依赖当前 Codex 运行时的 Playwright 与本机 Edge，可用 `AGENT_USAGE_PLAYWRIGHT_MODULE`、`AGENT_USAGE_EDGE_PATH` 指定路径。先尝试内置浏览器连接，但 Node REPL 内核因当前 Windows 沙箱启动故障不可用，随后采用项目既有隔离 Playwright 方式。没有读取用户浏览器配置或操作真实服务。

公开价格核对入口为 `node docs/validation/2026-10-01-claude-pricing/source-audit.mjs`，仅 GET Models.dev 的公开价目。网络费率可能变化，后续重跑不保证与当前内置值相等；若断言失败，应核查官方依据，不直接改价消除差异。

`snapshot.html` 与截图使用合成数据，包含临时目录路径；没有导出用户真实日志或价格文件。完整验证目录保留重跑脚本、原始日志和 JSON。
