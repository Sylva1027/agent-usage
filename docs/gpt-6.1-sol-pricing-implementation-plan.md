# GPT-6.1 Sol Pricing — Implementation Plan

日期：2026-09-30。状态：实现与自动验证完成；浏览器人工验收待完成。范围：P0 → P1 → P2 → 验证与交付。

## 给执行模型的任务

在当前仓库完成本文所有阶段，解决新模型已有 usage、却没有计价条目且费用落入最低费率估算的问题。完成代码、测试、文档、验证与交付报告；不要停在 P0，也不要把已列明的 P1/P2 当作后续建议。本文是实施规格，[调查文档](gpt-6.1-sol-pricing-improvement-plan.md) 保留原因与调查快照，执行时不需要依赖聊天记录。

可将以下文字直接作为交接提示：

> 请执行 docs/gpt-6.1-sol-pricing-implementation-plan.md，从准备到 P0、P1、P2 和交付全部完成。先核对当前工作区与项目指导文件，保留已有改动；按文档实现并运行相应验证，记录最终差异、测试结果和遗留问题。调查文档仅供背景。本文明确指出的现有 -free 规则必须保留，不得按旧调查描述将其移除。

## 0. 执行前准备

- [x] 阅读适用的 `AGENTS.md`；检查 `git status --short`、目标文件和工作区差异。本文依据的工作区已有 DSH、自动价格更新、前端等大量未提交改动，不能通过 reset、checkout、全局格式化或覆盖整文件清掉这些内容。
- [x] 阅读 `src/pricing.js`、`src/pricing-auto.js`、`src/pricing-store.js`、`src/server.js`、`src/usage-store.js`、`public/app.js`、`src/static-export.js` 和现有相关测试；按函数名定位，不依赖旧调查行号。
- [x] 记录当前相关测试与检查结果。旧调查的 71 项通过是历史基线，不能冒充执行后的结果。
- [x] 确认尚未实施的部分；若其他任务已经完成某一步，以验证和补齐为主，不重复实现。

本次重新检查发现：`src/pricing.js` 已有 `-free` 零费率分支，`test/pricing.test.js` 已有对应测试。它晚于原调查文档，本文以该最新状态为准。共享解析器必须保留 **精确键 → 显式别名 → -free → 最长已知前缀 → 未匹配** 的优先级。

执行环境为 Node ESM，`package.json` 要求 Node >= 23.8。使用现有工具链，不为这项工作引入前端打包器或外部定时任务。

### 固定范围

必须实现：独立官方价格、历史费用按活动价目重算、共享模型解析、缺价可见性、实际使用模型覆盖率、可靠自动补录、扩展条目持续更新、缓存/覆盖兼容、发现调度、失败/冲突/容量状态、三路一致性与交付。

不扩展：OpenCode 数据源接入、人民币新模型自动发现、订阅实际扣费、Batch/Flex、地区附加费、媒体或工具调用计费、完整的手动新增模型编辑器。保留已有免费模型及其他渠道行为。

## P0. 补齐 6.1 sol 并修正费用

### P0-1. 增加独立内置条目

目标文件：`src/pricing.js`、`test/pricing.test.js`。

- [x] 在 `MODEL_PRICES` 增加 `gpt-6.1-sol`，保留 `gpt-6-sol` 原条目；不要添加二者之间的价格别名。
- [x] 明确币种 USD、官方来源、单次请求输入阈值 272,000，以及四档完整费率。
- [x] 更新价目版本/核对日期说明，使旧、新有效价目产生不同版本；全局日期不能被描述成全部厂商逐项核对日期。

2026-09-30 已核对的 USD / 百万 tokens，字段顺序固定为 `input / cachedInput / cacheWrite / output`：

- Standard short：`2 / 0.10 / 2.50 / 10`。
- Standard long：`4 / 0.20 / 5 / 15`。
- Fast short：`4 / 0.20 / 5 / 20`。
- Fast long：`8 / 0.40 / 10 / 30`。

价格依据：[OpenAI 模型页](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[官方定价页](https://developers.openai.com/api/docs/pricing)。执行时若官方规则已改变，先核对并在交付中明确差异，不从其他模型名称推断价格。

### P0-2. 上下文、迁移与重算

- [x] 单次请求输入严格 `> 272_000` 使用 long；272,000 仍为 short。Priority 与 Fast 等价。
- [x] 核查 `contextTierFor()`：当前设置 `longContextThreshold` 后会在 `requestInputTokens` 不可用时退回 `usage.input`。不要将跨请求增量或聚合 input 当成单次请求输入。对 6.1 sol，优先采用明确的请求输入；没有该值时，仅使用解析器已经确认的 `contextLevel`，否则为 unknown。必要修改应有回归测试，并保持其他模型原有计价契约。
- [x] 缺少服务档位仍保留 `service-tier-unknown-standard-scenario`；缺少上下文仍保留上下文未知提示。
- [x] 检查 `loadPricingFile()` 对旧全量价目、v2 字段覆盖、已有自动缓存的合并行为。新增默认条目必须出现，手动编辑字段仍优先。
- [x] 验证历史索引中的相同事件使用活动价目重算；不要清空数据库、重写日志或修改原始 token 计数/记录价格版本。

### P0 测试与完成条件

- [x] 输入 10,000，命中 5,000，缓存写入 0，输出 1,000，已知 short/Standard：`totalUsd = 0.0205`；Fast/priority 为 `0.041`；6 sol 相同 fixture 仍为 `0.021`。金额断言使用合理浮点容差。
- [x] 缓存写入另测：输入 10,000，命中 4,000，写入 1,000，输出 1,000，short/Standard：`totalUsd = 0.0229`。
- [x] 请求输入 272,000 / 272,001 的边界与 unknown 场景；大累计 input 不能把已知短请求误判成长请求。
- [x] 完整事件不再含 `unknown-model-price-minimum-scenario`，6.1 sol 不再因缺价进入 `minimumRateModels`。
- [x] 无缓存离线启动、旧配置迁移、自定义价格覆盖均通过；免费模型、原 6 sol、CNY 及 DSH 回归通过。
- [x] 在 `test/three-path-parity.test.js` 加入 6.1 sol，同一数据/价目下内存、SQLite、静态导出费用一致。

P0 可形成独立可审阅差异，但继续执行 P1、P2。

## P1. 统一解析并展示缺价状态

### P1-1. 提取共享纯函数

新增 `public/pricing-models.js` 及 `test/pricing-models.test.js`；接入 `src/pricing.js`、`public/app.js` 和 `src/static-export.js`。

约定导出 `resolvePricingModel(rawModel, models)`，返回：

```text
{ rawModel: string, catalogKey: string | null,
  matchType: "exact" | "alias" | "free" | "suffix" | "missing" }
```

- [x] 规范化 trim 和大小写；空名称/`Unknown model` 保持既有未知模型语义，不创建假费率。
- [x] 搬入现有显式别名；只有目标 key 在给定 models 中存在才匹配。
- [x] 保留精确、别名、免费规则、前缀、未知的顺序。免费推算匹配返回 `matchType: "free"`，`catalogKey: null`；不能被 paid base model 吸收。
- [x] 前缀匹配保留现有 `${key}-` 边界，多个命中选最长 key，排序稳定。不要增加跨小数版本或提供商名猜测。
- [x] 后端适配结果至现有 `name/key/free` 形状，保持 `estimateEventCost()` 及现有费用字段兼容；前端复用同一规则。
- [x] 模块只用浏览器可用 JS，无 Node/DOM/网络依赖；仅命名导出，无循环依赖。
- [x] 同一次变更接入导出器显式内联与依赖绑定，遵守 [静态导出约定](static-export-contract.md)。

必要用例：大小写/空白、精确 key 覆盖别名、别名目标缺失、日期后缀、最长前缀、6.1 不匹配 6 sol、`mimo-v2.6-flash-free`、精确自定义 `xxx-free` 价格优先、unknown。

### P1-2. 建立展示行与用量覆盖率

目标文件：`public/app.js`、`public/i18n.js`、`public/styles.css`、`src/server.js`，必要时在共享模块增加纯覆盖/行构建函数。

- [x] “在用”以 `metadata.harnessModels` 中的原始模型名称为起点，不能先过滤成 catalog key。
- [x] 已匹配价格行沿用现有编辑入口；别名保留实际使用标识并说明对应计价名称。
- [x] 缺价行显示“缺少模型费率，当前按最低费率估算”，可查看说明并触发重新匹配；不调用只能编辑已有条目的 `openModelPricing()`，不注入零价格。
- [x] 免费规则行显示“按 -free 规则估算为免费”，不标为缺价，不进入新模型收费发现候选。
- [x] 对已有价格条目保留当前 harness 认领/去重；缺价或免费规则行按实际 harness 展示。“全部”为 catalog 与实际使用的缺价/免费规则行并集，按规范化模型名去重。
- [x] 搜索涵盖实际名称与对应价格 key，中英文齐全，状态有文字说明。

`GET /api/pricing` 增加 `usageCoverage`，与原 `automatic` 字段并列：

```text
{
  ready: boolean,
  usedModelCount: number,
  matchedUsedModelCount: number,
  freeRuleUsedModelCount: number,
  missingUsedModels: [{ model: string, harnesses: string[] }]
}
```

计数以规范化后实际模型标识为单位，跨 harness 只计一次；忽略空名/Unknown 占位符。`matchedUsedModelCount` 包含 exact/alias/suffix/free，free 数是其子集；missing 数 + matched 数 = used 数。免费规则不是 catalog 条目，但已有明确估价规则，应计为覆盖。

- [x] 覆盖范围与现有“在用模型”一致，为索引中所有已用模型；不跟随当前页面时间过滤而改变分母。
- [x] `/api/pricing` 不主动同步整份用量。索引已初始化时直接用 `UsageStore.metadata()`；尚未就绪返回 `ready: false`，界面显示“等待用量加载”，不能展示“覆盖完整”。
- [x] 首次 usage 加载后重新取得覆盖；旧服务缺少字段时，前端可从 metadata 和 catalog 计算。
- [x] 保留现有自动匹配数量语义，另外显示用量覆盖、缺价数量和免费规则数量。“未自动匹配”与“缺少费率”不能合并成同一状态。

测试：`test/app-render.test.js`、`test/server.test.js`、`test/i18n.test.js`，以及既有静态导出测试。验证别名可见、缺价可见、free 不误报、旧服务兼容、未知初始化状态、搜索和跨 harness 分组。

## P2. 可靠发现、补录与持续更新

### P2-1. 分离更新已有模型和创建新条目

目标文件：`src/pricing-auto.js`、`src/pricing-store.js`、`test/pricing-auto.test.js`。

- [x] 更新已有条目以“默认价目 + 自动缓存扩展条目”为基础；不能再仅传 `getDefaultPricingCatalog()`。手动扩展 key 可作为更新候选，但已有手动字段不能成为下载缺项的默认值。
- [x] 保持已有 CNY、xAI、Google 更新范围；新的自动补录仅接纳已验证的 OpenAI USD 文本模型，不能为了补录改变已有渠道的更新规则。
- [x] 新增纯解析入口，将远端候选转换为完整 `PriceModel`；已有 patch 更新和完整条目创建使用不同校验路径。
- [x] 候选只来自实际 usage 中 `matchType: "missing"` 的规范化模型名。精确匹配 OpenAI provider/model ID；不根据 channel 为 Codex 就断言提供商是 OpenAI。
- [x] 拒绝非法名称、媒体专用模型、未确认币种/提供商、缺输入或输出费率、缺缓存语义的首次条目。远端字段缺失不等于 0。
- [x] Models.dev 价格为每百万 tokens；LiteLLM 是每 token，转换后校验有限非负值与现有限额。布尔、字符串、NaN、Infinity 不接受。

上下文规则：

- 有明确 context tier 时，验证正整数阈值和完整四类 long 费率；不使用最大 context limit 代替收费阈值。
- LiteLLM 的 `above_272k_tokens` 字段可表明 272K 收费档；不得把该阈值套给无该字段的新模型。
- 已核实为统一费率的模型可 short/long 同价，但“payload 未列长档”本身不足以证明统一费率。使用已核实规则清单或明确元数据；否则返回 `context-policy-unknown`，继续保持缺价。
- 当前只能表示一个 long 阈值；出现多个收费阈值的新模型返回 `unsupported-context-policy`，不静默截断。
- 规则核实与新条目代码分离，方便后续补齐厂商证据；不能通过一条固定 272K 通用规则制造貌似完整的新模型。

### P2-2. 档位来源、冲突与手动覆盖

自动缓存增加独立 `modelMetadata` 字段，不把来源结构塞进现有费率对象。兼容旧缓存没有此字段的情况。

每个模型按 `short / long / fast.short / fast.long` 记录来源 URL、核对时间、`origin: remote | built-in | derived | mixed` 及沿用字段；混合字段来源须可追溯。状态接口暴露这些信息，编辑弹窗能说明 Standard 刷新但 Fast 沿用/推算的情况。

- [x] 可靠 Priority/Fast 完整档位可更新；缺可靠值保留已有内置/自动 Fast 档。首次模型只有 2 倍假设时保留现有估算语义并标为 derived，不声称官方 Fast 已更新。
- [x] 保留 Models.dev 为主、LiteLLM 为备的偏好；该偏好用于无冲突候选。两个有效来源对同一档位存在实质差异时，该档位保留已有值并报告 conflict；首次条目的必需档位冲突则不补录。
- [x] 价格比较使用小浮点容差以消除每-token 转换误差；不得用容差吞掉真实价格变化。
- [x] 已有条目缺某个远端字段可沿用基础值，明确字段来源；首次条目不可使用其他模型或手动字段补洞。
- [x] 应用顺序始终为 defaults → automatic → manual field overrides。保留手动新增条目和手动汇率，自动刷新不能修改其有效值。
- [x] 来源/状态变化单独更新 `statusVersion`；现有 `changed` 表示有效价目版本改变，新增 `statusChanged` 表示状态改变。前端分别刷新费用与状态，不能只在 `changed` 时更新全部信息。

### P2-3. 持久化、容量和逐模型结果

- [x] 新完整条目存入 `pricing-auto.json` 的 models，元数据存入 modelMetadata；重启后读取并继续自动更新。不要只在当前内存添加。
- [x] 保留现有临时文件 + rename 的原子写入及失败回滚；坏下载不能破坏有效缓存。
- [x] 保留最大 100 个模型、PUT 128 KiB 上限；以最终有效目录（包括手动扩展）计算容量，按稳定模型名顺序逐项接纳。
- [x] 第 101 个候选返回 `catalog-capacity`，不使整个批次失败；验证第 100 个成功与其他已有更新仍能落盘。手动删除/新增和缓存合并同样守住容量边界。
- [x] 对手动删除自动扩展的语义沿用现有行为，不在本次额外设计删除协议。
- [x] 刷新响应增加 `discovery: { addedModels, results }`；results 为逐模型 `{ model, status, reason }`，status 使用 added/matched/deferred/rejected/error，reason 至少区分 not-found、unsupported-provider、incomplete-rates、context-policy-unknown、unsupported-context-policy、conflict、catalog-capacity、timeout。
- [x] 某模型不足以补录不应将整份刷新标为全部失败；UI 同时展示已更新结果和仍缺价数量。

### P2-4. 接入服务与发现调度

在服务器内部传入 `usedModels`/模型清单，复用 `pricingRefreshPromise` 合并请求。不得用 HTTP 自调用 `/api/summary`，不得上传本机模型名、用量、路径或正文；对外只 GET 两份公开价目和汇率。

- [x] 价格初始化只加载本地文件，不等待用量同步；usage 加载只处理 usage，不等待网络价格发现，避免互相等待。
- [x] 初次 usage 完成、以后 usage 模型集合变化时，触发缺价发现检查。默认成功价格刷新 24 小时周期与汇率调度保留。
- [x] 新缺价模型可绕过已经成功的 24 小时周期；同一缺价模型失败后一小时才重试，其他新候选不受这一个失败限制。
- [x] 使用服务内短防抖和稳定候选签名合并，建议防抖 1 秒；持久化逐模型 attemptedAt，重启不能每分钟重新发现同一失败候选。注入 now/调度函数供测试，避免真实等一小时。
- [x] 常规发现不要追加外部定时器；随已有用量检查评估到期模型。显式 force 立即重试并可绕过防抖/失败周期，仍合并正在执行的请求。
- [x] 一批发现结束后检查运行期间出现的新候选，必要时安排下一批；并发请求不能覆盖较新的手动编辑或自动缓存。
- [x] 价格发现与汇率尝试时间分别管理；只发现模型时不强制刷新汇率。
- [x] `POST /api/pricing/refresh` 有初始化好的索引时携带 usedModels；索引未就绪先更新已有价目，标记 discovery deferred，等 usage 首次完成补发现。
- [x] P2 提供 `automaticDiscoveryEnabled` 服务选项，默认 true；设为 false 时仍更新已有条目、显示缺价、加载已有自动缓存，不新增模型。
- [x] 新有效价目改变服务 fingerprint，下一次正常页面刷新/状态检查更新费用；暂停用量刷新继续遵守既有冻结快照约定。手动价格 force 刷新沿用现有交互，不绕过编辑版本 409 校验。
- [x] 服务关闭时取消未执行的防抖任务，不残留计时器；后台失败成为状态/issue，不产生未处理 Promise rejection。

### P2 必须完成的测试

- [x] P0 已使 6.1 sol 成为 built-in，因此自动“首次发现”测试使用独立 synthetic OpenAI 模型，例如 `gpt-test-discovery`，避免测试实际只覆盖已有模型更新。
- [x] 双来源正常完整数据 → 新增、保存、重载、第二轮更新；只主源成功/只备用成功 → 按可靠字段接纳。
- [x] 必需费率缺失、伪 provider、非法 model、媒体、未知上下文、多长档、真实冲突 → 返回明确逐模型结果，旧目录仍可用。
- [x] 已有条目部分远端字段缺失 → 沿用及 mixed 元数据；新条目同样缺项 → 不补录。
- [x] 手动部分覆盖、手动新增、手动汇率 → 多轮自动更新及重启后保持优先级；并发编辑不丢失。
- [x] 容量上限与字节边界，非法缓存恢复、磁盘写入失败回滚、失联/超时 → 有效旧值不丢。
- [x] 同一天已成功刷新后出现新模型、相同候选重复轮询、失败一小时前后、force、运行中新增候选、关闭服务 → 调度与 fetch 次数正确。
- [x] 仅 statusChanged 时刷新来源/冲突/覆盖信息；changed 时重算费用；免费行不变为收费发现候选。
- [x] automaticDiscoveryEnabled=false 不新增，已有扩展仍加载/更新。

相关测试文件：`test/pricing-auto.test.js`、`test/server.test.js`、`test/app-render.test.js`、`test/i18n.test.js`，必要时为调度纯函数增加专用测试。

## 验证、文档和交付

### V1. 阶段检查

每完成一阶段，先运行该阶段相关测试；失败时修复本次引入的问题。阶段检查通过后继续下一阶段，不重复运行没有变化的全量测试。

P0 定向命令：

```powershell
node --test test/pricing.test.js test/pricing-auto.test.js test/three-path-parity.test.js
```

P1/P2 按实际新增文件选取定向测试，至少覆盖 pricing-models、pricing-auto、server、app-render、i18n 和 static-export。

### V2. 文档与完整检查

- [x] 更新 `README.md`、`README.en.md` 的自动价格覆盖范围、缺价含义、手动优先、发现/重试规则及离线行为。
- [x] 更新 `docs/static-export-contract.md` 的共享模块清单。
- [x] 在本文逐项标记完成状态，记录偏差、执行时间、测试命令与结果；调查文档保留历史快照，不改成当前 live 数据。

最终运行并保存结果：

```powershell
npm run typecheck
npm test
npm run lint
npm run format:check
```

工作区基线可能已有失败。报告必须区分原有与本次引入的问题；不能为使检查变绿而格式化或重写无关代码，也不能把未执行的命令写成通过。

### 执行记录（2026-09-30）

- P0/P1/P2 已落地：新增独立 GPT-6.1 Sol 价目与严格上下文分档；前后端共用模型解析；显示缺价、免费规则、别名和全量用量覆盖；新增严格的双来源 OpenAI USD 文本模型发现，持久化逐档来源和发现状态，保留手动字段优先、24 小时正常刷新、失败冷却、服务内 debounce、容量 100 和 PUT 128 KiB 上限。
- 自动回归：`npm test` 268/268 通过；`npm run typecheck` 通过；本任务 12 个源码/测试文件的 Biome lint 和 7 个新模块/相关测试文件的定向格式检查通过。
- 全量 lint：`npm run lint` 有 1 个错误，位于 `public/index.html:127`（date-range 控件的 SVG 缺少标题）；该 hunk 属于既有日期范围 UI 改动，与本次定价实现无关；另有 37 条既有警告。
- 全量格式检查：`npm run format:check` 在 7 个文件上失败，涉及共享文件的换行/全文件格式化差异以及工作区其他未提交改动。为保留这些改动，没有运行全仓格式化；新增模块和本任务测试的定向检查通过。
- 自动导出与三路费用由静态导出测试和 `test/three-path-parity.test.js` 覆盖。隔离手验页面已生成：`C:\Users\Silver\AppData\Local\Temp\codex-gpt61-preview-yQJLwC\dashboard.html`。
- 尚未完成 V3 人工浏览器检查：Node REPL 浏览器内核连续退出，返回 Windows sandbox `helper_unknown_error: setup refresh had errors`。在线界面交互与 `file://` 首屏/控制台检查保留为未完成项；未启动或改写用户真实服务、价目缓存、数据库和 `dist` 产物。

### V3. 浏览器与三路验收

使用测试 fixture/隔离 home 启动服务并生成独立静态 HTML，避免验证过程覆盖用户价目或默认 `dist` 产物。

- [ ] 在线界面短/Fast/long 字段正确、可编辑；在用与全部搜索到 6.1 sol。
- [ ] 同时展示 missing、alias、free 模型；缺价提示、动作、中英文、harness 分组正常。
- [ ] 自动新增成功后费用、覆盖率、来源说明更新；异常结果可读，手动费率不变。
- [x] 用相同事件/价目比较内存、SQLite、静态导出费用及关键不确定性标记（`test/three-path-parity.test.js`）。
- [x] 在没有 `node_modules` 的隔离测试场景完成静态导出；静态快照固定导出时价格，不调用在线发现（`test/static-export.test.js`）。
- [ ] 以 `file://` 打开产物，检查首屏和控制台。
- [x] 自动测试覆盖冻结用量、旧导出、新导出与历史索引行为；未清空或重建用户历史索引。

### D1. 最终交付内容

- [x] 可审阅的 P0、P1、P2 实现差异；修改只涉及本任务所需的文件/hunk，保留原工作区改动。
- [x] 更新后的测试、使用文档、静态导出契约及本文执行记录。
- [x] 简洁交付报告：最终行为、关键文件、测试通过/失败/未执行、手工验收、迁移/升级步骤、剩余限制与偏差。
- [x] 明确线上使用需要让当前运行进程加载新代码；提供适用的重启/刷新步骤，说明已存在的历史费用会按活动价目重算。没有执行用户真实服务升级时，不宣称已经上线。

如用户要求真实服务升级，先保留 `pricing.json`、`pricing-auto.json` 副本，使用现有 CLI 管理服务并检查 `/api/pricing` 和 usage。不要删除 `usage-index.sqlite` 或修改 token 日志。

### D2. 回退约定

- P0、P1、P2 分阶段保持可回退；不把 DSH/OpenCode 等其他任务差异混在回退范围。
- P2 出现问题可先禁用 automaticDiscoveryEnabled，已有价格更新和缺价提示仍可工作。
- 自动缓存新元数据必须向后兼容；回退读不到元数据时仍能使用有效费率。旧程序无法接纳新增条目时恢复价格缓存备份，保留手动价格。
- 回退代码或缓存不清空 usage 索引；历史原始计数和日志保持不变。

最终完成标准：全部阶段的目标行为得到验证；缺价模型可见、有可靠证据的新模型可自动补录并持续更新、费用正确使用独立价目、手动覆盖与现有免费/渠道行为保持兼容，静态导出仍自包含。未满足的条目必须列入交付中的实际遗留，不能只勾选完成。
