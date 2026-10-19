# M6：正式色源、首屏与最终验收

前置：M5.7 完成，十套选择有效且技术/视觉证据未过期；届时交接任务已授权正式配色接入。遵守[总计划](../2026-10-03-skin-palette-implementation-plan.md)。保留 4 个原任务编号；按[正式写入和单皮肤验收小卡](M6-integration-subtasks.md)执行。

本模块的写入和总汇总由协调者串行执行，不与配方生成争抢正式文件；冻结摘要之后的独立只读检查可按资源预算并行。缺选择或 hard fail 时回 M5，不先接“差不多的默认款”。

## M6.1 准确接入 20 个模式与选择器颜色适配

本节行为规格不缩减；实际派发按[M6 小卡](M6-integration-subtasks.md)与[执行规则](execution-and-subagents.md)。先串行完成生产/配置/生成物写入并固定摘要，再有限并行只读验收；不把 M6.2 整包交给一个 agent。

允许修改：`public/skin-palettes.js`、`public/skin-picker.js`、`test/skins.test.js`；bootstrap/manifest 只能由 prepare 命令生成。不改 picker ID 列表、CSS 或 artwork 几何。

步骤：

1. 验证选择恰好覆盖十套、candidateHash/setHash/assessmentHash 正确，全部 ready；核对源文件摘要与交接前状态。发现并行修改先重核，不能覆盖整个文件来恢复旧快照。
2. 把十个被选 Candidate 的 light/dark 直接写入原色源的对应扁平对象，12 键顺序保持 token 注册顺序。保持皮肤顺序、其他注释与合法附加数据，不手动二次调 HEX。
3. 保存 `final-palettes.json`：旧值、被选值、candidate ID/hash、是否有优选目标告警、选择来源、接入后文件摘要。任一模式最终 12 值完全沿用旧对象时回 M5 说明并处理，不把重新跑检查当作已经重设。
4. 修正选择器迷你预览仍读取 `text / mutedText / border` 旧字段名的问题。`previewTokens` 读取 runtime 的规范化 `.tokens`，调用共享派生，再按下表适配；mini DOM、framing 和五款范围不变。

| 迷你预览变量 | 真实派生变量 |
| --- | --- |
| --skin-preview-page | --bg |
| --skin-preview-panel | --neo-surface |
| --skin-preview-control | --control |
| --skin-preview-text | --ink |
| --skin-preview-muted | --muted |
| --skin-preview-border | --line |
| --skin-preview-accent | --blue |
| --skin-preview-chart-text | --chart-text |
| --skin-preview-chart-line | --chart-line |

5. 不新增 chartSeries 接线，不把迷你装饰柱状条认定为真实图表验收。未配色情况保留原 pending/fallback 行为，不为 classic 注入角色值。
6. 新 Node 进程执行 `npm.cmd run skins:prepare`，刷新 bootstrap；避免同一进程已缓存旧 palette 模块后生成错误结果。prepare 不重新编码 WebP。核对 manifest 和 40 个资产内容未被无关改变。

验收：正式 20 组 token 与选择逐项一致；fresh process 派生与候选一致；mini 的文字/边框实际来自正确字段；选择器仍恰好五款、classic 可达，资源和几何参数无变化。

若接入后才发现某颜色失败，不能在此卡悄悄加深几项；回 M5 产生新 candidate、实测并更新对应选择/授权记录，然后重新接入。

## M6.2 正式页面与相关行为回归

使用 M4 的 `--production` 路径，每次一套浅深候选，不用候选模块覆盖掩盖正式文件错误。20 个模式都要检查，隐藏五套通过隔离偏好或测试 hook 使用，picker 范围不变。

固定回归：

1. 全部十套的同步 bootstrap、runtime 20 项 root 声明、主题切换、重载恢复，与被选候选一致。
2. 每套两模式的关键普通/次要/强调文字、placeholder、图表标签、必要状态通过；采用相同角色清单和 fixture，不拿旧日志 PASS 代替。
3. character→classic→character，20 项变量清除/恢复；classic 两模式与 M0/M4 正式基准颜色、几何一致。
4. 当前五款 picker：选中状态、两模式 mini、键盘/关闭/透明度恢复、角色 decode；隐藏五款不出现在产品选项中。
5. 每套角色 off/50%/100% 与聚光既有强度组合，按 M4 矩阵重测受影响区域；字体、布局、角色 bounds 与同状态基准无超出测量误差的差异。
6. 在线冻结：隔离 fixture 加记录 → live 总量变化 → 暂停刷新并切周期仍使用同一 snapshot → 恢复刷新拿到新量；至少在两模式完成，不恢复独立 HTML 导出。
7. 1920/2560 高分辨率、窄桌面以及实际显示缩放复核，记录实际 CSS viewport、DPR、zoom、侧栏/并排条件。没有真机缩放证据不能用模拟视口冒充。

验收：`final-assessments.json` 与实际正式源摘要绑定，20 个模式、classic 和当前五款交互都有证据；无必要缺测/硬失败、首帧闪旧色或几何越界。正式改动导致源摘要变化属于预期变更，但仍需新实测，不能直接复制候选评审 hash。

## M6.3 工程检查与脚本接入

允许协调者修改 `package.json / biome.json` 的有限检查配置，不新增依赖。前面模块没有权限各自改它们。

只新增以下脚本：

```json
{
  "skins:candidates": "node scripts/skin-palette/generate-cli.mjs",
  "skins:review": "node scripts/skin-palette/review-cli.mjs",
  "skins:quality": "node scripts/skin-palette/review-cli.mjs verify"
}
```

核对 M0.3 已将 Biome 的 `files.includes` 与 `formatter.includes` 纳入 `scripts/skin-palette/**` 和 `test-support/skin-palette-fixture.mjs`，只扩大到本轮新增工具，不把全部历史 scripts 纳入或对无关文件格式化。保持 bootstrap 排除规则；各模块交接前完成自身格式化，M6 不再制造整批仅格式差异。新增工具完成 `node --check`、针对性测试和实际 lint/format 检查。

最终运行：

```powershell
npm.cmd run skins:palette
npm.cmd run skins:check
npm.cmd test
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run format:check
node scripts/skin-palette/review-cli.mjs verify --production --run <总run> --require-selections
git diff --check
```

要求：

- `skins:palette` 继续承担输入格式与旧诊断；不因退出 0 宣称新阅读门禁通过，也不在此卡任意重写历史 checker。
- `skins:quality` 检查已有完整、未过期证据；需要实测时明确调用 capture。没有报告/环境时失败，不打印默认 PASS。
- test 数量以实际输出为准；新增测试重点覆盖数学外部参考、无解/预算/多背景、摘要和首屏一致，不能用测试数量包装视觉验收。
- typecheck 的现有范围仍不覆盖全部开发工具，报告中明确其范围；新增纯工具通过 Node 语法检查、针对性测试和实际 lint，不宣称获得额外 TS 覆盖。
- 只格式化本轮允许文件。已有无关失败独立记录复现和归因，不偷偷扩大修复范围，也不把失败测试列成通过。

验收：相关测试和新门禁通过，检查覆盖范围明确，生成物新鲜，无生产依赖与无关格式化；此前模块交付若因格式变化改了 sourceHash，重做摘要绑定与受影响检查，不继续沿用旧证据。

## M6.4 文档状态、证据索引与回退说明

允许协调者修改：`docs/00-index.md / 02-tasks.md / 03-development.md / 12-dashboard.md / validation/00-index.md` 及本轮验证 README。只更新与本轮实际交付对应内容，不把其他会话的规划改成已实现。

交付内容：

1. 本轮验证 README：源 revision/dirty 状态、输入摘要、十套选择、最终 20 组结果、实际 picker 五款范围、检查命令/退出码、截图和缺测。
2. 开发说明：生成→capture→report→selection→production 的准确命令、隔离参数、输出位置、摘要过期规则；旧工作台只作草稿且使用共享派生。
3. 看板说明：正式色源已重设十套，但产品选择器开放范围按实际写；不声称延期五套已经发布。
4. 任务清单只在对应证据完整后更新状态。若仍有用户视觉意见/实际缩放缺测/固定色冲突，保留明确条目，不整项宣称完成。
5. 颜色回退包保留接入前 `public/skin-palettes.js` 的逐皮肤旧对象及旧声明摘要。回退按准确皮肤/模式恢复色值并重新 prepare/check；不回退工作区其他功能，不执行整仓库 reset。
6. 工程细节完成后提炼长期规则；是否归档本计划由协调者按现行文档规则处理。保留候选和原始检查证据，不再制造第二份“唯一现行方案”。

验收：本轮 Markdown 相对链接有效，所有“通过/完成/上线”都有对应证据，回退步骤能定位到具体颜色对象；未请求提交、推送或发布时到此交付。

模块出口：十套完整配色已准确接入，20 模式证据有效，classic 与当前五款选择器回归完成，文档描述实际状态。单独的延期皮肤开放和发布任务不混入本模块。
