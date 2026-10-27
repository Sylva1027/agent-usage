# worker-B 执行记录

## B1 — 显示 provider 身份

卡号 / 状态：B1 / done

开始、结束时间与用时：2026-10-23 02:45:22 +08:00 至 02:47:55 +08:00，约 2 分 33 秒。

本卡实际修改的文件、入口及基线指纹：

- `public/perf-ui.js`：`modelProviderText`、`renderGroupButton`、`renderPerfDetailHtml`、`renderPerfModelRow`、`renderPerfModelDetailHtml`；起始 SHA-256 `d03bc820127eda79e36703b9b3c8cc4c9497960acad9ae46b24fdc8bfea97903`。
- `public/styles.css`：`.perf-model-source*`、`.perf-model-provider-name`；起始 SHA-256 `42a4a41c134c210bcd06d2accbadaf75d8309a8be95bf29182fe7caa18a9fe25`。
- `public/i18n.js`：provider 未知与信息不可用英文文案；起始 SHA-256 `a37b6df5a2388c215980bbc4b4b8b3a8bc226e2a770ff723b9c979eab057ada6`。
- `test/perf-ui.test.js`：provider 区分、空值、缺字段、长名、转义、可访问名称和 CSS 断言；起始 SHA-256 `31439024689b549d1ef457eaf319bdc16222d467f111470486d4bb5a55f1310a`。
- `test/i18n.test.js`：中英文 provider 缺省文案断言；起始 SHA-256 `48daa21e4f5b2a2a823c2edba8b7faf1d73f6f943296819081f0499b7225c2b8`。
- 开工时五个文件均与 `output/tps-audit/remediation/baseline.json` 一致；未修改 app、共享夹具、数据层或其他归属文件。

解决的问题与可检查的差异：

- 来源单元格同时显示 source 与 provider，详情标题显示 provider；行按钮与详情标题的可访问名称包含 provider。
- `modelProvider` 为空字符串显示“provider 未知”；DTO 缺该字段显示“provider 信息不可用”；不根据模型名猜测 provider 或官方直连。
- 同名不同 provider 的行可区分；长 provider 通过单元格/标题属性与省略样式处理；HTML 特殊字符统一转义。
- 保留四列表格、五行滚动、左右面板和区间带几何。

执行命令、通过/失败数量、证据路径：

- `node --test --test-reporter=spec test/perf-ui.test.js test/i18n.test.js`：37 passed，0 failed。
- `npx biome check --formatter-enabled=false public/perf-ui.js public/i18n.js test/i18n.test.js`：0 diagnostics。
- `npx biome format public/styles.css public/i18n.js test/perf-ui.test.js test/i18n.test.js`：通过。
- 可检查差异：`output/tps-audit/remediation/baseline/` 对应 `.baseline` 文件与当前五个文件。

没有验证的内容及阻塞输入：

- 未做浏览器视觉/窄窗口检查，未跑全量测试；本卡只要求 perf-ui/i18n 局部回归。
- 未接真实 API 或 app 状态；使用手写字面量 DTO，等待主审 M2 接线。
- 全文件 `biome format public/perf-ui.js` 仍会命中基线已有的 `public/perf-ui.js:344` 换行差异；本卡未改动该行。

后续建议：等待主审验收 B1；通过后再领取 B2。

### B1 主审复核收窄

状态：done，等待主审复验；全局计数由主审更新。

复核时点：2026-10-23 02:49:13 +08:00。

- 撤回本轮对旧 groups 入口 `renderGroupButton()`、`renderPerfDetailHtml()` 的 provider 文案与 aria 期望改动；这两个入口相对开工 baseline 已恢复无差异。
- `modelProviderText()` 及新 models 四列表格/详情的 provider 展示保留。
- `.perf-model-source` 保持原生 `table-cell`，未设置 `display:flex`；source/provider 两个内部 span 使用 `display:block` 实现两行及省略。
- CSS 断言已改为检查内部 span 的 `display:block`，不再要求来源单元格 flex。
- `node --test --test-reporter=spec test/perf-ui.test.js test/i18n.test.js`：37 passed，0 failed。
- `npx biome check --formatter-enabled=false public/perf-ui.js public/i18n.js test/i18n.test.js`：通过。
- `npx biome format public/styles.css public/i18n.js test/perf-ui.test.js test/i18n.test.js`：通过。

## B2 — 排名与参考行说明

卡号 / 状态：B2 / done

开始、结束时间与用时：2026-10-23 02:49:24 +08:00（按 B1 收官记录时点）至 02:56:24 +08:00，约 7 分钟。

本卡实际修改的文件、入口及 B1 checkpoint 指纹：

- `public/perf-ui.js`：`modelRankInfo`、`renderPerfModelRow`、`renderPerfModelTableHtml`、`renderPerfModelDetailHtml`；B1 checkpoint SHA-256 `B964DF402A602A79E11EB88D4EE8A93AD0CC7B0B95D54A992F2013EBEA378890`。
- `public/styles.css`：`.perf-model-table-note`、`.perf-model-row-label`、`.perf-model-row-heading`、`.perf-model-row-note`、`.is-reference-start`；B1 checkpoint SHA-256 `4F805FF101424C7CDC3DBE4A0AB8FAE55D0122358BB547592E552710808ABB30`。
- `public/i18n.js`：参考行、未验证、排名不可用和表格说明的中英文文案；B1 checkpoint SHA-256 `42210667C47E113AC2CFD8484C0211460DD14251B97DEE15E4ACDEAB4A48D0F1`。
- `test/perf-ui.test.js`：eligible/参考边界、overflow、旧 DTO、后端顺序、可选择性、DOM/CSS 断言；B1 checkpoint SHA-256 `4553ADC228A8C1E7506325E00C510A4B5BCBC0FD347953B0116C2B13B4FD5F30`。
- `test/i18n.test.js`：排名参考文案中英文断言；B1 checkpoint SHA-256 `CF684E7B33413A7E13D7139C36D4FBCD38F5C9270EF025234272488670F63759`。

解决的问题与可检查的差异：

- 仅 `rankState === "eligible"` 且 `rank` 为有限数字的行显示编号；参考行显示 `n=<n> · <原因>`，原因覆盖 `overflow`、`unverified`、`insufficient_samples`；缺 `rankState` 的旧 DTO 显示“排名信息不可用”，不再展示旧 rank。
- 前端直接使用后端顺序，不重排、不重算门槛或排名；首个参考行加分隔线，eligible 与参考混合段的边界可见。
- 表格说明和可访问名称改为“满足当前计量条件的历史样本排序”，去掉“全局排名”表述；四列、原生表头、五行滚动和区间带几何保持不变。
- 参考行仍可通过 `data-perf-model-key` 选择，并保留 TPS、区间及可选 RGB 条；稳定 DOM 约定包括 `data-perf-model-index`、`selected`、`is-reference`、`is-reference-start`。
- 相对 B1 checkpoint 共 5 个文件、232 行新增、17 行删除；可检查差异为 `output/tps-audit/remediation/checkpoints/B1/` 对应 `.baseline` 文件与当前工作文件。

执行命令、通过/失败数量、证据路径：

- `node --test --test-reporter=spec test/perf-ui.test.js test/i18n.test.js`：42 passed，0 failed。
- `npx biome check --formatter-enabled=false public/perf-ui.js public/i18n.js test/i18n.test.js`：Checked 3 files，0 diagnostics。
- `npx biome format public/styles.css public/i18n.js test/perf-ui.test.js test/i18n.test.js`：Checked 4 files，No fixes applied。
- `rg -n "模型速度排名|模型速度全局排名|全局排名|Global model speed ranking" public/perf-ui.js public/i18n.js`：无生产文案命中；测试中的命中仅为否定断言。

没有验证的内容及阻塞输入：

- 未做浏览器视觉/窄窗口检查，未跑全量测试；本卡只执行 perf-ui/i18n 局部回归。
- 未接真实 API、app 状态或 B3 的实际日期、样本单位与 p90 文案；等待主审验收后再领取下一卡。

后续建议：等待主审验收 B2；不启动 B3。

## B3 — 实际日期、样本单位与 p90

卡号 / 状态：B3 / done

开始、结束时间与用时：2026-10-23 06:28:17 +08:00 至 06:31:43 +08:00，约 3 分 26 秒。

本卡实际修改的文件、入口及 B2 checkpoint 指纹：

- `public/perf-ui.js`：`sampleCountText`、`sampleDateKey`、`sampleDateText`、`sampleMetaText`、`renderModelBand`、`renderPerfModelDetailHtml`、`renderPerfModelsHtml`；B2 checkpoint SHA-256 `82C7C9CE2030D309D60FE927108CFA8FF080BCE7B0E1A5A6AEA4A702F7792CE2`。
- `public/i18n.js`：样本日期、request/step/message/turn/mixed 单位和 p90 百分位中英文文案；B2 checkpoint SHA-256 `1B4B6DD31239DCF2E14A1988DC7CF5BF7822FC4F469C2584375B0EF97DA9BD03`。
- `test/perf-ui.test.js`：跨日本地/UTC、同日、缺/无效/倒序日期、5 种样本单位、6 turn、p10=p90、带外均值及 p90 说明测试；B2 checkpoint SHA-256 `2BACA977C12629E746B8E97F25EDA36C3871244C241EA3665E887435D300588A`。
- `test/i18n.test.js`：样本日期、单位和 p90 中英文断言；B2 checkpoint SHA-256 `A6E184B8DFF3D1D6070B19DC52B8B6857D77314660D6FD190D3C1B3DFA982175`。
- 未修改 `public/styles.css`、`public/app.js`、共享夹具或旧 groups 入口。

解决的问题与可检查的差异：

- 详情按 `options.calendarZone` 的 `local`/`utc` 格式化 `firstSampleAtMs`、`lastSampleAtMs`：同日只显示一个日期，跨日显示日期范围；缺字段、无效值或首尾倒序显示“样本日期不可用”，不拿查询范围代替。
- `renderPerfModelsHtml` 已将 `calendarZone` 继续传给 `renderPerfModelDetailHtml`；整区渲染和选中详情更新均由主审现有的 app 两处调用传入。
- 详情样本数按 `window` 显示为请求、步骤、消息、回合或混合样本，并处理中英文单复数/量词；Codex 6 条样本显示“6 个回合”/“6 turns”，不写成请求数。
- 现有区间说明追加“p90 是第 90 百分位，不是最快 10% 的平均值”；未改区间带几何、`p10=p90` 标签合并或均值可在带外的逻辑。
- 相对 B2 checkpoint 共 4 个文件、168 行新增、15 行删除；可检查差异为 `output/tps-audit/remediation/checkpoints/B2/` 对应 `.baseline` 文件与当前工作文件。

执行命令、通过/失败数量、证据路径：

- `node --test --test-reporter=spec test/perf-ui.test.js test/i18n.test.js`：46 passed，0 failed。
- `npx biome check --formatter-enabled=false public/perf-ui.js public/i18n.js test/perf-ui.test.js test/i18n.test.js`：Checked 4 files，0 diagnostics。
- `npx biome format public/i18n.js test/perf-ui.test.js test/i18n.test.js`：Checked 3 files，No fixes applied。
- `git diff --check`：通过。
- 全文件 `npx biome format public/perf-ui.js` 仍只报告 B2/基线已有的 `missingSources` 与模型行换行差异，B3 未改动这两处。

没有验证的内容及阻塞输入：

- 未做浏览器视觉/窄窗口检查，未跑全量测试；日期第二行在窄面板的排版仍有视觉风险。
- 未接真实 API、真实索引库或在线测速；使用字面量 DTO 覆盖 required fields 与缺字段行为。

后续建议：等待主审验收 B3；完成停等 B4 派工。

## B4 — Codex 覆盖与无样本解释

卡号 / 状态：B4 / done

开始、结束时间与用时：2026-10-23 06:33:46 +08:00 至 06:39:26 +08:00，约 5 分 40 秒。

本卡实际修改的文件、入口及 B3 checkpoint 指纹：

- `public/perf-ui.js`：`renderPerfModelsHtml()`、`modelEmptyMessage()`，新增 `renderCodexTimingCoverageHtml()` / `coverageRatioText()`，并补全 p90 文案；B3 checkpoint SHA-256 `489411F7126419843C71B3402AC4987468DA3404A73AEE60C131423395697102`。
- `public/i18n.js`：Codex 覆盖、缺失/溢出、degraded、主原因与 pending 中英文文案；B3 checkpoint SHA-256 `3CECE6BEB4787093983473C697117409E9447F8F1DF97DEE960E84D54EDFFDEC`。
- `public/styles.css`：`.perf-models-region`、`.perf-codex-coverage` 及短摘要内部排版；B3 checkpoint SHA-256 `E4E12481AF61FCA70A63899AEAD08B0A632198427A2FCC2B6407CE8A316BE571`。
- `test/perf-ui.test.js`：单处摘要、双比例手算、空模型、状态分支、旧 coverage 隔离、主原因/pending 及 p90 断言；B3 checkpoint SHA-256 `A752EAA9BA50662FBF34F75BF4F453AB1626EA9711DF4E984B532A7A7DA6BEB2`。
- `test/i18n.test.js`：覆盖标签、不可用状态及 p90 中英文断言；B3 checkpoint SHA-256 `447A1D7CCA3D06FF3819FACB98A1E2A108C7B88468C9525ABD185B321C7687EE`。
- 未修改 `public/app.js`、共享 fixture、旧 groups 入口或后端文件。

解决的问题与可检查的差异：

- 仅在 `renderPerfModelsHtml()` 外层渲染一处 `perf.codexTimingCoverage` 摘要；表格、详情面板及五行滚动结构保留，选择模型的详情增量更新路径未改。
- 分别显示“候选采样覆盖率”（`counts.sampleRate`）和“已记录输出覆盖率”（`sampledOutputTokens / recordedOutputTokens`）。手算 `1/3 = 33.3%`、`1000/4500 = 22.2%`，方向未反置。
- `codexTimingCoverage === null`、零候选、零采样、部分可用、未知输出、token 溢出/缺字段、旧响应缺字段、`rebuilding`、`uninitialized`、degraded 均有独立说明；零分母、null 或缺失 token 显示“不可用”，不显示 0%。
- `unknownOutputCandidates > 0` 时说明比例只统计已知输出；`counts.unplaced` 注明为全历史、无法定位日期且不进入当前范围分母。旧 `coverage.bySource.codex` 不参与摘要。
- 有无模型行都保留覆盖说明；空表不生成 `n=0` TPS 行。审查补充：`droppedByReason.duration_missing_nonpositive_invalid` 显示“缺失或无效时长 N”，pending 显示“进行中 N”，不读取或求和 `byFlag`。
- p90 文案补为“第 90 百分位，不是最快 10% 的平均值，也不是速度上限”。
- 相对 B3 checkpoint 共 5 个文件、339 行新增、8 行删除；可检查差异为 `output/tps-audit/remediation/checkpoints/B3/` 对应 `.baseline` 文件与当前文件。

执行命令、通过/失败数量、证据路径：

- `node --test --test-reporter=spec test/perf-ui.test.js test/i18n.test.js`：50 passed，0 failed。
- `npx biome check --formatter-enabled=false public/perf-ui.js public/i18n.js test/perf-ui.test.js test/i18n.test.js`：Checked 4 files，0 diagnostics。
- `npx biome format public/i18n.js test/perf-ui.test.js test/i18n.test.js`：通过，No fixes applied。
- `git diff --check`：通过。
- 全文件 `npx biome format public/perf-ui.js` 仍只报告 B3/基线已有的 `missingSources` 与模型行换行两处排版差异，B4 未顺手改动。

没有验证的内容及阻塞输入：

- 未做浏览器视觉/窄窗口检查，未跑全量测试；本卡只执行 perf-ui/i18n 局部回归。
- 使用字面量 DTO 覆盖状态与缺失字段，未接真实 API、真实索引库或 M1 的生产字段。

后续建议：等待主审验收 B4；不启动 B5。

## B5 — 严格 cohort 的修复前后复核

卡号 / 状态：B5 / done（实测通过），等待主审验收。

开始、结束时间与用时：2026-10-23 约 06:45:00 +08:00 至 06:50:00 +08:00，约 5 分钟；按 B5 接手后的只读调查、脚本运行和报告整理记录。

本卡实际修改 / 新增的文件及指纹：

- `output/tps-audit/2026-10-23-remediation-recheck.mjs`：新增独立复核入口；SHA-256 `1db2bcaf12e9e7d185fb19fc1c4f3a2c23664d52fff1d77ec664baecc1fe7820`。
- `output/tps-audit/remediation/run-2026-10-22T22-49-17-944Z.json`：唯一保留的新快照结果，文件名使用 UTC，对应北京时间 `2026-10-23 06:49:17`；SHA-256 `754e2664c05c7f2b52f0eb90e29730c1c82637f002fcd658442e56cb45ef695a`。
- `docs/validation/2026-10-23-tps-remediation/worker-B.md`：仅追加本节。
- 未修改 `public/`、`test/`、共享 fixture、真实数据库或服务。原 `output/tps-audit/recheck.mjs` 未运行、未修改，当前 SHA-256 `d93425dd7c189b4407e8f5055cb53e56f09a0625388a0d2f79f73a49075ad0a3`；原 `output/tps-audit/2026-10-23-recheck.json` 未覆盖，SHA-256 仍为 `9ead3f3185778016cd02e69e4fd99ab210d50d4a4a03652d4d411d179feea47f`。

历史证据能支持什么、不能支持什么：

- 历史 JSON 的 `deepseekGroups` 可按 source/provider/model/effort 与当前严格 cohort 对照；其中的 provider 总数和 provider 长度桶也可复用。
- 历史临时 SQLite 已被清理，旧 JSON 没有样本级 cohort、`window`、`tokenScope`、`modelProvider`、`knownSources` 或 `codexTimingCoverage`。因此不能从旧 JSON 恢复逐样本身份，也不能把旧 `modelDates` 当成 provider 拆分模型行。
- 旧 JSON 的 window/tokenScope 由冻结的 `PERF_SOURCE_SEMANTICS` 补齐，不是旧快照新发现的字段；当前每个 cohort 已断言只有一个实际 window/tokenScope。

新快照方法与守恒：

- 只复制 `~/.codex-usage/usage-index.sqlite` 主库及存在的 WAL 到临时目录；复制前后文件大小/mtime 一致，副本 `PRAGMA quick_check = ok`，WAL 为 0 字节。主库 SHA-256 `d14ce6044be17fa549d26147559fee99b4ef074b1805842024fe0a74aab0347d`。
- 调用生产 `decodePerfSample`、`selectPerfSamples`、`summarizePerf`、`projectPerfModels`；`knownSources` 由 `source_files` 的六个 home 显式构造并原样传给汇总：`claude`、`codex`、`dsh`、`opencode`、`workbuddy`、`zcode`。当前 `perf_degraded_home_ids` 为空。
- 当前全库：persisted `46946`、eligible `46454`、unplaced `492`、sampled `41296`；历史对应值为 persisted `46691`、selected `46201`、sampled `41219`。这不是同一时点，增减不用于声称性能变化；目标 DeepSeek cohort 的实际值与旧快照一致。
- 6 个 DSH/ZCode DeepSeek strict cohort 的 n、output、duration、pooled、p10/p50/p90、首末日期均与历史明细一致（6/6）。每个 cohort 的五档长度桶行数合计、输出 token 合计和 duration 合计均等于 cohort 总量；`projectPerfModels` 重投影后的 pooled/p90 也与汇总行逐值相等。

严格 cohort 结果（实际日期为北京时间）：

| source | provider | model | effort | window | tokenScope | n | pooled TPS | p90 | 日期 |
|---|---|---|---|---|---|---:|---:|---:|---|
| dsh | deepseek-account | deepseek-flash | 空 | step | reported_output_unspecified | 416 | 190.0034 | 221.0320 | 09/28–09/29 |
| dsh | deepseek-official | deepseek-flash | 空 | step | reported_output_unspecified | 2 | 2.6543 | 3.0211 | 09/28 |
| dsh | opencode-go-v41f | deepseek-flash | 空 | step | reported_output_unspecified | 1 | 49.0518 | 49.0518 | 09/29 |
| zcode | deepseek | deepseek-flash | max | request | reported_output_unspecified | 421 | 209.7423 | 244.9575 | 09/20–09/27 |
| zcode | new-provider-3 | deepseek-flash | max | request | reported_output_unspecified | 1 | 141.4858 | 141.4858 | 09/27 |
| zcode | deepseek | deepseek-flash | disabled | request | reported_output_unspecified | 3 | 15.2505 | 16.7189 | 09/20–09/26 |

长度桶（n；池化 TPS）：

| provider | `<300` | `300-1k` | `1k-2k` | `2k-4k` | `4k+` |
|---|---|---|---|---|---|
| DSH deepseek-account | 191；126.7 | 139；179.6 | 62；211.6 | 19；217.5 | 5；211.6 |
| ZCode deepseek | 68；108.7 | 160；171.4 | 84；215.0 | 80；215.3 | 32；228.3 |

provider 与模型行不可互换：

- DSH account provider cohort 为 `416`；旧 DSH `deepseek-flash` 模型行 `419` 是 `416 account + 2 official + 1 opencode-go-v41f`，不是 account 单 provider 总体。
- ZCode `deepseek` provider cohort 为 `424 = 421 max + 3 disabled`；ZCode `max` 模型总体为 `422 = 421 deepseek + 1 new-provider-3`。因此 `424` 与 `422` 是不同集合，不能跨 provider 相加或互相替代。
- 旧 JSON 的四个已有 provider 汇总（DSH 三个、ZCode deepseek）均与当前快照总体一致，且每个 provider 的五个长度桶全部一致。`zcode/new-provider-3` 在旧 JSON 中没有 provider 汇总行，但其 max effort 明细为 n=1，当前同 cohort 一致；新快照已将其单列为独立行，不并入 deepseek provider。

Codex `knownSources` 与当前方法覆盖：

- 输出的 `codex.knownSources` 明确为 `[{ kind: "codex", homeId: "main-b07e6ade4ffb1033" }]`，并与同一次 `summarizePerf` 使用的数组一致；`codex.codexTimingCoverage` 非空。
- 当前 `tps-v2`：eligible `3216`、sampled `6`、候选采样率约 `0.1866%`；recorded output `29673621`、sampled output `233379`、unknown output candidates `0`；`MISSING_DURATION=3210`。缺失计时仍留在分母，未伪造成 0% 覆盖或零时长样本。
- `6` 条有完整请求计时的 Codex 样本产生非空 TPS 行；“3210 条缺时长”和“6 条可计时”来自同一当前方法 cohort，但本卡不据此推断线上刷新延迟。

执行命令、通过/失败数量、证据路径：

- `node --check 'output/tps-audit/2026-10-23-remediation-recheck.mjs'`：通过，0 failure。
- `node 'output/tps-audit/2026-10-23-remediation-recheck.mjs'`：退出码 0；6 类运行期断言均通过（生产 sampled 计数、严格 cohort 与模型行、重投影 pooled/p90、长度桶三量守恒、provider/effort 守恒、Codex knownSources/coverage 接线）。
- 新结果：`output/tps-audit/remediation/run-2026-10-22T22-49-17-944Z.json`。
- `npx biome check --formatter-enabled=false 'output/tps-audit/2026-10-23-remediation-recheck.mjs'` 没有处理该文件，因为仓库配置忽略 `output/`；因此不把 Biome 计为通过，脚本检查以 `node --check` 和运行期断言为准。

没有验证的内容及阻塞输入：

- 未做浏览器视觉/窄窗口检查，未跑全量测试；主审已另跑全仓检查，其并行 `src/history-archive.js` typecheck 缺口不在本卡修复。
- 未恢复旧临时 DB，也没有旧样本级 cohort 身份；修复前后只能证明聚合 cohort 一致，不能证明逐样本集合逐字相同。
- DSH 与 ZCode 的日期、工作负载、provider 路线和 token scope 未对齐；本卡只证明统计总体与展示拆分没有丢有效样本，不升级为公平测速或服务能力排名。
- 未发送真实付费请求、未读取或修改凭据、未重启服务、未改写真实数据库。

后续建议：等待主审验收 B5；完成停等，不启动 B6。

## B6 — DSH account / official 的证据边界

卡号 / 状态：B6 / done（只读证据边界，不改产品），等待主审验收。

开始、结束时间与用时：2026-10-23 约 06:52:00 +08:00 至 06:58:00 +08:00，约 6 分钟；只读已知会话、临时只读索引副本和本机 Magpie 账本快照。

本卡实际修改 / 新增的文件及指纹：

- `docs/validation/2026-10-23-tps-remediation/worker-B.md`：仅追加本节；追加前 SHA-256 `7CB1A5D0BF5D9B1EEE27298F6A42454DC3330737BA68D6F0E543CAC63EE3399B`。
- 未修改 `public/`、`src/`、`test/`、共享 fixture、真实索引库、账本或服务；未读取或修改 `.credentials.yaml`、`.env` 等可能含密钥的文件。
- 已知会话文件均通过生产 `readDshSessionRows()` 只读解析；未输出 prompt、正文、工具参数或凭据。

### 证据分层

| 层级 | 本节可支持的结论 | 不可升级为 |
|---|---|---|
| provider 标签 | DSH 会话的 request header/context 将两条 official 样本记为 `deepseek-official`，account 示例记为 `deepseek-account` | 官 key 所有权、账号归属或真实端点 |
| route | `session/title-llm-request.data.route` 存在，但只带 `{provider, model}` 两个标签值；`titleProvider` 为 `session-title-first-prompt-llm` | 主请求的 endpoint、base URL 或上游线路 |
| 记录模型 | header/context、`message.source.model` 和 `replayState.response.model` 均记录为 `deepseek-flash` | 上游实际执行模型或服务端 `served` 模型 |
| 外部账本 | 本节样本没有可连接的外部 request/response ID | 外部计量、计费或精确计时已验证 |
| 内部计时 | DSH 帧时间可复算 step 时长 | 独立时钟或网关计时已验证 |

产品 reader 只从 `request/header|request/context` 的 `data.header.config.{model,provider}` 取值（`src/perf-sources/dsh.js:8-18,360-368`）；`assistant/message` 只取 `(turn,step)`、`row.time` 和 `usage.outputTokens`（同文件 `387-405`），不读取 message source、replay response、endpoint 或账号字段。`src/dsh-usage.js:282-286` 同样只记录请求作用域中的 provider/model。因此当前生产链路中的 `modelProvider` 是会话内请求标签，不是独立验证过的账号或线路身份。

### 两条 official 样本

| 会话前缀 | 北京时间（首/末 step） | step | output | duration | status / flags | 文件 SHA-256 |
|---|---|---:|---:|---:|---|---|
| `od-3e232fbc…` | 2026-09-28 09:05:46 | 1 | 2 | 845 ms | completed / 0 | `895bedf50ebabcc829d70b5045a43853b1c2f4350d9feaa151017d5c0b941e79` |
| `od-ac263908…` | 2026-09-28 09:12:57 | 1 | 2 | 662 ms | completed / 0 | `8df7f0e4df0d4467a25bb17d0643f0afaa0a7b9f1e71df686b1fc6e7e326200c` |

- 两条均为 completed、`sample_flags=0`、`method_version=tps-v1` 的有效短样本；合计 `4 / 1507 ms ≈ 2.6543 TPS`。
- 它们不是失败样本；2 个 output token 太短，且每会话只有 1 step，不能据此推出速度能力、官方线路性能或服务等级。
- request header 仅含 `provider`、`model`、`maxTokens`、`reasoningEffort`；request context 仅含 `provider`、`model`、`contextWindow`、`systemPromptUpdate`。assistant source 含 `kind`、`provider`、`model`、`replayState`；replay response 仅含 `kind`、`version`、`model`。
- 两条的 header/context 和 `message.source` 都记录 `deepseek-official` / `deepseek-flash`，replay response 也记录 `deepseek-flash`；这只是三处一致的客户端/会话记录，不是上游执行证明。
- `session/title-llm-request.data.route` 也确实存在，值为 `{provider: "deepseek-official", model: "deepseek-flash"}`，但它属于标题生成请求，只重复同一组标签，不提供 endpoint、base URL 或账号。

### account 有限示例

- 会话 `session-f254b870…`：2026-09-28 05:56:37–05:57:07（北京时间），10 个 assistant step；第一个样本为 `175 output / 1270 ms`，completed、flags 0、`tps-v1`。
- 10 条 message 的 source 均记录 `deepseek-account` / `deepseek-flash`，replay response 均记录 `deepseek-flash`；会话文件 47,838 bytes，SHA-256 `87a46e5a4e42c5a55f4f37c6617f7b9772d206d8efa430b0dfc0fbb81ec382a6`。
- 本卡只把这个会话作为有限形态样本，不把 10 step 或其中一个 `175/1270` 样本重算为 B5 已验收的 account 严格 cohort（416 条），也不据此给出 account 速度结论。
- account 示例同样没有 endpoint/base URL/账号所有权字段；title route 只重复 `deepseek-account` / `deepseek-flash`。

### 外部账本与精确对账缺口

- 只读读取 `~/.config/magpie/usage.jsonl` 的一个快照：36,777 条，全部可解析；快照 SHA-256 `73e0ce8fbf2d8388d62014d0b33db9fe31feeb8b42ac6a14c1bfbc7ecd3c68a8`。账本在调查期间持续追加，因此数量和哈希只代表该读取时点。
- 本节 12 条 assistant message（official 各 1 条、account 示例 10 条）都有本地 `message.id`，但没有 `replayState.response.responseId`；本地 `message.id` 也没有命中账本的 `response_id` 或 `rid`。
- 三个会话头 ID 均未命中账本的 `session` 或 `native_session`。因此不能用时间、output 或 duration 近似配对来冒充精确关联。
- 账本中确实有 `response_id`、`route_id`、`providerAccount`、`providerKeyId`、`served`、`tier_served` 等字段（快照中分别有 36,482、36,731、34,394、2,337 条相关字段），但这些字段无法回连到本节 DSH 会话。缺失的是共享关联键，不是账本完全没有线路/账号证据。
- 账本快照的 provider 标签为 `opendesign`、`workbuddy-ai`、`codex`、`opencode-go`、`stepfun-cn` 和空值；没有直接用 `deepseek-official` / `deepseek-account` 作为账本 provider 标签。该事实只能说明标签空间不同，不能单独证明这些 DSH 请求未经过账本。

### 后续接入或受控测速的最少缺失条件

1. 在 DSH assistant source 或 replay response 写入与网关账本相同的精确 request/response ID，并保证一条请求一个稳定键；本地 `message.id` 只有在证明与 `response_id/rid` 同源后才能使用。
2. 每条请求提供可核对的 endpoint/base URL、route ID 和账号/密钥身份（敏感值只保存脱敏哈希或安全 ID），不能只保留 provider 名称。
3. 提供上游返回的 `served` model/version 和实际 route/tier；`replayState.response.model` 只能算记录模型。
4. 提供独立的 request start/end 或 TTFT/flow 计时，以及 output/input/cache/reasoning 的 usage 来源与单位；当前内部时长是 DSH 帧时间差。
5. 明确 reasoning token 语义和 `maxTokens`/token scope，尤其是 output 是否包含隐藏 reasoning；当前 scope 仍为 `reported_output_unspecified`。
6. 受控测速若要做能力判断，还需固定模型/effort、prompt 长度、并发和预热，取得多个非 2-token 的重复样本；本节不发起这类请求。

执行与检查：

- 使用 `node --input-type=module -` 调用生产 `readDshSessionRows()` / `dshSessionHeader()`，只输出白名单标量、行类型计数和哈希；未打印正文或凭据。
- 对真实 `usage-index.sqlite` 的逐进程临时只读副本查询 DSH 样本；B6 副本 SHA-256 为 `d14ce6044be17fa549d26147559fee99b4ef074b1805842024fe0a74aab0347d`，副本不留在工作区。调查结束时主库被正在使用，未再直接哈希，因此不声称此后主库未变。
- 账本仅做本地只读匹配；未发送网络/付费请求，未重启服务，未修改产品代码或测试。

没有验证的内容及阻塞输入：

- 未证明 `deepseek-official` 是官 key，也未证明 `deepseek-account` 的实际账号归属；provider 名称不能替代密钥/账号证据。
- 未证明实际 endpoint、base URL、上游 route、上游执行模型或代理链。
- 未取得与本节样本精确对应的外部账本条目，因此不能声称“官 key 已完成外部计量验证”，也不能把内部时长当作外部计时。
- 未做时间窗近似匹配、全盘扫描、浏览器或全量测试；这些都不是本证据边界卡的替代证据。

后续建议：等待主审验收 B6；不启动 B7。

## B8 — 浏览器真实 API → DOM、范围、刷新与冻结

卡号 / 状态：B8 / accepted（主审补全浏览器验收；自动刷新缺陷由 L1 跟踪），本 worker 只追加本节，不启动 B9。

本卡实际新增 / 使用的文件及指纹：

- `output/tps-audit/remediation/B8-browser-service.mjs`：本 worker 建立的独立 loopback 服务；运行实例使用基线 SHA-256 `691C6EDEF86D1526E78D306489ECE8D6B106738E1FE69F96AC89911C213AAE1A`。主审只修正控制断言后当前文件为 `44F36AEA6F218F7CF34C17D9149DDE4F8F233AF15E26031FB6007BDA18BE40DC`；旧实例未重启。
- `B8-browser-runtime.json`：`182DD0C429181E21EFA534610D9F11BF68B19EFD72BD1B52430554FED011DBB9`。
- `B8-browser-service.log`：`98C7AC51AE889CD3A25D2AF191A9C0B5D82D30A91B12F5CE2FB0DD75298F8DBD`。
- `B8-initial-no-evidence.png`：`FC1DAF303FF3D282A8FD07A8E9795BA86A52F187276F5582D526CE8E7AE4AE9A`。
- 主审补充证据：`B8-main-dom.json` `11DB1436B5B5493D22598E1EF23AE0F275967BD0DB7444A11AC9BD9740882BCC`；`B8-main-fingerprint-before-after.json` `9AD9AAD1CEEBFF45A200B6E358C1BBED115C7CAAAFC85DD3915EA841AADDB26F`；`B8-main-stale-live.png` `22EB3C4F4F998BB768BDCCE8F333AB6347B1197D055F3573497FC90E8879658E`；`B8-main-resume-live.png` `D63DD620B604638BB62D0B83653D8AFE5E17C88E9C946CCF36FF6C3AB45499FC`。
- 未修改产品或测试文件；隔离服务使用真实 `createUsageServer()` / `UsageStore`，只绑定 `127.0.0.1:13315`，控制端点为 `127.0.0.1:13317`。未访问真实索引、用户常驻服务、凭据或付费 API。

夹具与时钟：

- 使用共享 `createPerfCodexIntegrationFixture()`，原始 fixture hash 仍为 `2cdfc5a8f7b6833a1f080c99e4f1955b810c6433b9270f2edcb372b344f7f436`；只在独立临时副本初始化时把 25 turn 分到本月/本周/今日，之后未改 rollout。
- 日期分组：turn 1–8 为 `2026-10-02 01:00 +08:00`，turn 9–20 为 `2026-10-20 01:00 +08:00`，turn 21–25 为 `2026-10-23 01:00 +08:00`；三份 rollout 初始化后组合 SHA-256 为 `d9c1674acdb8f19420a8e7a60586cd049b96c376393a29f84feafafe20f5daac`，之后 `rolloutUnchanged=true`。
- 时间范围以 `Asia/Shanghai` 解释；浏览器初始为“今日”，自动刷新间隔 60 秒。单次测量不构成 SLA。

本 worker 的初始浏览器证据与工具限制：

- IAB 已打开 `http://127.0.0.1:13315/`，初始 API 为候选 `5`、sampled `0`、已记录输出 `610`；DOM 显示“候选采样覆盖率 0% (0/5)”“已记录输出覆盖率 0% (0/610 tokens)”“缺失或无效时长 5”，模型行为 0。截图 `B8-initial-no-evidence.png`。
- CUA 的页面 evaluate 隔离作用域没有 `fetch` / `XMLHttpRequest`，因此没有在页面里伪造 API 或直接调用控制端点；控制步骤通过 shell 的 loopback 请求执行。不把该工具限制写成产品失败。
- 原 tab 在初次导入后轮询 77 秒仍停留 `0` 行，主审另开新 IAB 后立即显示今日 `4/5`、`79.7% (486/610 tokens)`、`n=4` 和实际日期 `2026-10-23`；说明 API → 新加载 DOM 已通，旧 tab 的问题属于刷新触发链，不是渲染 DTO。

主审补充的真实浏览器结果：

- `B8-main-dom.json`：本周 `16/17`、本月 `24/25`、今日 `4/5`，样本日期分别覆盖 `2026-10-20–2026-10-23`、`2026-10-02–2026-10-23`、`2026-10-23`；真实 DOM 行数、n、速度和区间均来自服务响应。
- 冻结今日 `n=4 / 80%` 后导入最后一条双请求 turn 的两条完整证据并普通 `sync()`：live API 变为 `n=5 / 100%`，冻结 DOM 仍为 `n=4 / 80% / 486 tokens`；恢复自动刷新后 DOM 变为 `n=5 / 100% / 610 tokens`。对应 `B8-main-stale-live.png` 与 `B8-main-resume-live.png`。
- `B8-main-fingerprint-before-after.json`：rollout 不变、`perf.indexVersion` 从 `2c2526…` 变为 `ea958f…`，但 `/api/status` 与 `/api/usage` 的 fingerprint 都仍是 `23d227…`，`/api/status?since=...` 返回 `changed=false`；独立 live 页在 `auto=true` 下跨一个 60 秒周期仍停留 `n=4`，而 API 为 `n=5`。这是 L1 的最小失败证据，不是缺分母或 DOM 渲染问题。

控制脚本误配说明：

- `B8-browser-service.log` 的两个 control `500` 都是 harness predicate 误配：`timingImport()` 固定等待 `month`，调用方却传了 `today` 的期望值 `4/5`；实际控制响应已经分别返回 `month n=24, sampled=24` 和 `month n=25, sampled=25`，数据提交成功。
- 主审已将当前脚本修正为匹配 `today`，但没有重启旧运行实例；因此本次 UI 证据仍对应该基线脚本和 pre-L1 服务，不把 500 写成产品回归。

结论与交接：

- B8 验收的是真实 API → DOM、今日/本周/本月、冻结隔离和最小刷新缺陷重现；不表示自动刷新已修复。
- 刷新缺陷已转 L1，见 `docs/validation/2026-10-23-tps-remediation/worker-A.md:578`、`docs/validation/2026-10-23-tps-remediation/README.md:118-126` 与 `docs/validation/2026-10-23-tps-remediation/tasks.json` 的 `L1` 状态。待 L1 验收后必须重启隔离服务并重演 `n=4 → live n=5` 的浏览器自动更新；当前不把 B8 的 stale DOM 当成修复后结果。
- B9 已由主审接管；本 worker 不自动开始 B9，也不使用未获批的新能力。服务保留给主审复演，本 worker 不再 import / shutdown / 重启 13315。

未验证：L1 修复后的自动刷新浏览器复演、冻结后跨更多周期的稳定性、全量测试。风险：任何“自动刷新已修复”结论都要等 L1 重启服务后的独立浏览器结果。
