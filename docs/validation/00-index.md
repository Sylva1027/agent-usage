# 验证资料索引

更新：2026-10-21。现行合同见专题说明，任务状态见 [02](../02-tasks.md)。本页按日期组织证据，不用审查意见或计划勾选替代实际验收。

## 2026-10-21：v0.7.0 发布

[验收范围](2026-10-21-release/README.md)与[发布说明](2026-10-21-release/release-notes.md)：Claude Code 来源、整页配色、限额范围、Worker 恢复与固定框内错误详情；README 使用 DeepSeek 浅色 16:9 示例图及五款皮肤选择器截图。全仓工程检查独立登记，不覆盖此前保留的真机缩放和视觉验收边界。

## 2026-10-20：Claude Code 数据源

[验收](2026-10-20-claude-code-source/README.md)：本机 `~/.claude` 真实转录接入为第五个来源；后端 `GET /api/usage` 与 headless Chromium 截图核对渠道归组、模型归组、计价弹窗「缺少费率」、限额按钮排除与 TPS「不支持来源」。记录子代理占比、完整套件 2,605/2,633 与 8 项 HEAD 既有失败。规格见 [Claude Code 数据源](../data-sources/claude-code.md)。

## 2026-10-20：Claude Code 模型身份改为线路模型

[验收](2026-10-20-claude-model-identity/README.md)：用转录 `message.id` = 网关账本 `response_id` 与逐项 token 计数两条独立连接，证明 `mythos-magpie-*` 与 `claude-haiku-5-5` 的真实上游是 `deepseek-v4.1-flash` / `-sg`；记录 `claude-code-guide` 子代理的 tier 别名来源、账本比转录多出的 14 行及判定依据、schema 15→16 只标脏 Claude、真实数据 1,498 事件全部计价。

## 2026-10-20：皮肤配色当前代码重新验收

[验收](2026-10-03-skin-palette-redesign/20261003T185748/integration/m62-reaccept-20261020/README.md)：十套 20 模式 900/900、关键几何 120/120；每套浅深 dense-data 共 20 图视觉复查、classic、五款 picker 51/51 与在线冻结通过。最终记录绑定 31 项源冻结和原始证据，整体 `incomplete`；目标机真实 OS 显示缩放/browser zoom 经用户确认未测，大视口整页高度差 +16px 单列保留。最终全仓工程门禁待独立登记；旧 [production CLI 兼容调查](2026-10-03-skin-palette-redesign/20261003T185748/integration/m62-reaccept-20261020/engineering-gates/cli-compatibility.md)表明旧命令绑定旧迁移来源，不作为本轮通过门禁。

## 2026-10-12：GPT-6.1 Sol Codex / Work 计费

[实施验收](2026-10-12-codex-work-billing/README.md)：可靠来源类型、500K 能力说明、全长度短档和 Fast 计费；同一历史快照逐事件金额、费用纪录、Token 与性能对比，保留测试及环境限制。无需索引迁移或历史重解析。

[皮肤配色 M5.2.C-D8g 实测交接](2026-10-03-skin-palette-redesign/20261003T185748/handoffs/M5.2.C-D8g-badge-live.md)：源码与 fixture 预检通过；浏览器在日期动作前拒绝旧 ready 选择器，没有测量浅/深色。主管接受其阻断执行与清理记录，不代表颜色结论。

[皮肤配色 M5.2.C-D8h ready 修复](2026-10-03-skin-palette-redesign/20261003T185748/handoffs/M5.2.C-D8h-ready-fix.md)：修复嵌套 `:has()` 并将 roles/policy 升至 9；Edge 原生编译 30 个 ready selector，状态回归、47+5+1 项专项及 Biome 通过。保持 `NEEDS_REVIEW`；真实徽标浅/深色测量尚未运行。

[皮肤配色 M5.2.C-D8u28-R3 几何夹具复核](2026-10-03-skin-palette-redesign/20261003T185748/handoffs/M5.2.C-D8u28-R3-geometry-fixtures.md)：原生几何前提门禁在唯一 Edge 执行中发现 G5/G7/G8/G10/G11 夹具关系不成立，生产 probe、守卫与 R1 均未运行；清理和源码冻结通过，保持 `NEEDS_REVIEW`。

## 2026-10-09：刷新性能回归诊断

[诊断与方案目录](2026-10-09-refresh-performance/refresh-performance-diagnosis.md)：在活动服务（`127.0.0.1:3765`）与源码副本 A/B 上复测，独立复现[既有诊断](../plans/2026-10-08-dashboard-perf-regression-diagnosis.md)的三条根因并纠正其索引迁移要求（无需抬 schema 版本）；新增 `isPeakPricingTime` 每事件构造 `Intl.DateTimeFormat`（占读路径 36.8%）、`modelIndex` 每事件重建价目 Map、`recordsForRange` 全历史计价（占“今日”查询 78%，而“今日”本身仅 62 ms）与 `loadUsageStore` 无节流四项，并直接测得同步期间静态文件被阻塞 6,035 ms。四个机械修复的 A/B：`preset=today` 22.0→11.3 s、`skipCheck=1` 2.0→1.0 s。[客户端实测](2026-10-09-refresh-performance/client-audit.md)用 headless Edge + CDP 确认主线程仅 25–31 ms/刷新（约 99% 在服务端），并实测出周期对比表占 809 元素中的 798 个且与范围无关、`translatePage` 占 JS 46%、性能视图 337 次 `Intl` 构造加 ResizeObserver 二次整渲染。

[对实施计划的复核](2026-10-09-refresh-performance/plan-review-2026-10-09.md)：逐点核对源码后确认[实施计划](../plans/2026-10-09-dashboard-refresh-performance-plan.md)在 9 处正确而本目录原诊断有误（含 `i18n.js:488-489` 实为 `WeakMap`、`server.js:504` 使 `skipCheck` 在同步期间等待 `syncPromise`、按范围裁剪全历史纪录会算错），并指出计划 10 处缺口。新增两个一致快照探针（`VACUUM INTO`，135–170 ms）：内容探针 827–828 次/轮（397–455 ms，占基线 sync 3%）；**P1 + 解码边车复用 + rollout 投影复用后暖 sync 仍 2.49–2.51 s**（`replaceFile` 9 次/轮），据此指出 ≤1 s 目标缺少中间刻度且内容探针是规模限制项。诊断文首已加更正记录，`ab/` 的取样方式已改为 `VACUUM INTO`。

只读诊断与复核，未改动产品代码。

## 2026-10-08：模型输出吞吐（TPS）最终审核包

[最终审核包](2026-10-04-perf-metrics/20261004T035100/final-audit.md)与[M8 模块报告](2026-10-04-perf-metrics/20261004T035100/handoffs/M8.md)：M0–M8与TPS G4已通过[主审最终独立复核](2026-10-04-perf-metrics/20261004T035100/handoffs/M8.3-G4-主审最终复核-20261008.md)。分别绑定全仓1320/0/2、capture专项、345文件真实Codex API→DOM，以及当前CLI增量和TPS模块604/604定向、固定四源整链路；不拼成新全仓。来源坏线程隔离、degraded、可选SQLite未启用及历史跳过边界保留。

## 2026-10-03：文档融合与归档

[整理记录](2026-10-03-documentation-cleanup/README.md)：四份分享稿融合为唯一现行计划，15 份原稿归档，旧导出说明并入开发文档；保留原始验收资料并检查引用和归档正文。

## 2026-10-03：旧 HTML 导出移除

[清理验收](2026-10-03-export-removal/README.md)：347 项完整测试和 28 项隔离桌面 UI 检查通过。暂停自动刷新的服务端冻结快照、导入、计价与皮肤保留，旧 HTML 导出和离线分支删除；新分享图片尚未实现。

## 2026-10-03：v0.6.0 发布验收

[发布验收](2026-10-03-release/README.md)：355 项完整测试通过；五款皮肤在线／禁网离线 155 项检查，覆盖桌面单行、凹陷框收缩、窄短屏、泛光选中圆点和偏好恢复。较早十卡验证保留历史语境，当前交付范围以本记录为准。

## 2026-10-02：皮肤实施前本地保存点

[保存点检查](2026-10-02-pre-skin-checkpoint.md)：保存现有计价与看板修正、皮肤计划／独立预览及十套角色二十张原始线稿；323 项测试、类型、Lint 与格式检查通过，Lint 保留 41 条既有警告。正式皮肤系统尚未开始实施，历史浏览器证据不代表新布局约束已验收。

## 2026-10-02：ChatGPT 双侧角色独立预览

[角色预览](2026-10-02-gpt-skin-preview/README.md)：使用用户新透明线稿，沿用现有配色与合成数据，提供完整展示／放大贴边、透明度和角色显示控制，支持窄侧栏桌面缩放入口；22 项隔离浏览器检查通过，保留桌面深浅主题、手机截图及原图版本对照。仅完成独立预览，正式十角色系统未集成。

## 2026-10-01：Claude 价格与现有来源计费

[Claude 验收](2026-10-01-claude-pricing/README.md)：17 个内置版本、Anthropic 自动更新、5 分钟缓存场景与 DSH 非零写入修正；323/323 完整测试、45/45 隔离浏览器检查通过，公开来源当次 13/17 精确匹配。ZCode 语义、混合 TTL 与历史政策边界明确保留。

## 2026-10-01：关闭状态不增高

[关闭状态验收](2026-10-01-refresh-off/README.md)：删除重复文字，八组关闭/冻结范围高度对照；171/171浏览器、60/60相关测试通过。当前工作区修正，晚于v0.5.0标签。

## 2026-10-01：v0.5.0 发布

[发布验收](2026-10-01-release/README.md)：正式Release与标签回读，Node22/24 CI全部通过，中英README和About更新。

## 2026-10-01：加载圈与下拉框

[最新验收](2026-10-01-refresh-dropdowns/README.md)：字高3fps加载圈、刷新等待期间高度稳定、两套菜单边缘对齐与共同圆角/字重。170/170浏览器检查、312/312测试通过。

## 2026-10-01：标题最终居中

[最终标题验收](2026-10-01-title-centering/README.md)：取消固定上移，按字体主体居中；真实页面与源码共 48 组截图像素检查通过，重跑在线/离线布局验收。此前基线代理断言已纠错。

## 2026-10-01：模型列表与连续顶部框体反馈

[反馈验收](2026-10-01-dashboard-feedback/README.md)：312/312 完整测试、137/137 隔离浏览器检查，真实旧服务恢复 21 个模型行；修复缺字段兼容并按追加要求恢复连续顶部框体，原九项证据保留。

## 2026-10-01：看板九项修正

[本批验收](2026-10-01-dashboard-corrections/README.md)：311/311 完整测试，类型/Lint/格式通过，104/104 隔离浏览器检查。包含渠道归组与限额例外、模型退出、Git 最高优先、界面与来源入口，以及在线/离线主题、语言、四种宽度截图；受测版本与未覆盖部分分别记录。

## 2026-10-01：整体提交与文档整理

[当日记录](2026-10-01.md)关联 `28568ef` 的提交前自动检查，以及随后文档分层、归档、引用和证据迁移检查。两次工作分别记录；文档检查不冒充再次执行所有产品测试。

## 2026-09-30：UI 与计价

[原始验收记录](2026-09-30-ui-pricing/README.md)包含脚本、结构化结果、日志、背景对比和截图：

- 自动检查记录：304/304 测试，类型/格式检查通过，Lint 退出 0 并有 39 条 CSS 警告。
- 合成 fixture 浏览器检查：96/96，覆盖在线/离线、中英文、深浅主题、多种窗口尺寸及布局等效缩放。
- 普通/Fast 字段、覆盖状态、汇率保存/取消、焦点、轮询和模拟下载失败等交互。

这是当时工作区的证据，不自动证明未来版本、真实 DSH/OpenCode 数据或自动新增模型的全部界面路径。200% 为布局/像素密度模拟，并非操作原生缩放菜单；上游失败由 fixture 模拟，不计为真实官方网站核验。

## 历史真库与来源对照

- DSH 的独立计算、内存与 SQLite 真库对照，保留在[原实施记录](../archive/2026-10-01/dsh-adaptation-plan.md#14-实施记录)。样本事件数和总量随来源写入变化，不能作为固定预期。
- OpenCode 的语义调查与真库结果，见[原决议](../archive/2026-10-01/opencode-adaptation-plan.md#10-决议记录)和[进度快照](../archive/2026-10-01/opencode-adaptation-todos.md)。当前有 fixture 三路一致回归；历史口头“全绿”与可重跑日志分别看待。
- CNY 四家页面的在线只读解析与覆盖快照，见[UI/计价旧执行记录](../archive/2026-10-01/agent-usage-ui-pricing-todos.md#当前备注--阻塞)。带日期的在线结果、适配器 fixture 和下一次实际更新是三种证据。

## 记录规则

新结果使用 `YYYY-MM-DD.md`，有较多文件时使用日期专题目录并在本页链接。记录受测提交/工作区、数据与环境、命令、PASS/FAIL/未测部分和产物位置。

原始日志、JSON 与截图保留；可以补说明和纠错，但不能覆写旧结果伪装成新版本检查。测试数量、覆盖率、真库总量以及价格始终附带日期与口径。缺少证据的候选回到任务清单核实。
