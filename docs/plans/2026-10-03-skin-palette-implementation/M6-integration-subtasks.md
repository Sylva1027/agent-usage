# M6：正式接入与验收小卡

沿用原[M6](M6-final-integration-and-acceptance.md)的全部固定映射、回归矩阵、工程命令、文档范围和发布边界。M6.1—M6.4 为汇总节点，按以下小卡执行，遵守[调度规则](execution-and-subagents.md)。本次只是计划，未授权现在改正式 palette、提前选颜色或开放延期五款。

## M6.1.1 选择预检与接入前快照

前置：M5.7.5 完成，届时接入任务已经获得用户授权。只读生产源、十套 selections、总 CandidateSet/assessments 和出处。只写本轮 `integration-precheck.json`、`rollback-palettes.json` 与 handoff。

小块：验证选择/实际来源/ready/两个总摘要；核对工具和生产源码摘要；保存每皮肤每模式旧 12 token、旧派生声明摘要以及准确源码文件 hash。其他会话改动单独记，不能覆盖旧工作区。

前像补充（M4.4.7-D1 独立调查结论，2026-10-09）：任何正式写入前，将 `public/skin-palettes.js`、`public/skin-picker.js`、`public/skin-bootstrap.js` 的完整原始字节独占保存至本次接入证据的 `source-before/` 对应路径。`integration-precheck.json` 记录这些前像的路径/原字节 SHA-256，并保存捕获链固定 22 项完整 `sourceHashes` map；逐原批次核对其所消费旧摘要，不能只存旧颜色或 map hash。前像缺失或不相容时不启动 .2/.3/prepare，不事后从已改源码伪造旧快照。前像仅用于原候选历史重核；正式捕获后源码仍严格一致，不豁免漂移。

预检字段接线（M4.4.7-D2b 卡）：顶层 `sourceHashes` 保存固定22项；`sourcePreimages` 以三个源码路径为键，各值为 `{path:'source-before/<源码路径>',sha256:'<原字节摘要>'}`，sha256 必须等于 sourceHashes 对应项。预检原文件字节 SHA-256 由后续 manifest 绑定，不能在核验时改写。其余选择/回滚字段沿既有预检职责，不另造快照索引。

资产前快照补充（M4.4.7-D6a/D7d，2026-10-10）：任何接入写入或prepare前，通过固定安全读取保存顶层 `generatedAssets:{assetManifestSha256,sourceAssetHashes,publicAssetHashes}`；分别是旧public/skin-assets.json原字节hash、权威登记表40项sourcePath原字节hash、40项publicPath原字节hash。三字段和两张map键集固定，写入同一integration-precheck.json，由manifest的precheck原字节hash整体绑定，不另写平行资产索引。缺这些前值不能用接入后文件补造。随后核对前后资产与manifest字节是否保持不变；这不重新解码图片或证明既有无损声明。

验收：十套有效且可定位准确旧颜色。缺选择或授权时不开始写入；无需重新跑完整截图。

## M6.1.2 正式 20 组 token 写入

前置：.1；唯一色源 owner。允许 `public/skin-palettes.js`、`test/skins.test.js` 的该范围断言和 `final-palettes.json`。

小块：被选候选 light/dark 逐值写入既有扁平 12 token；保留皮肤/键顺序和无关注释/数据；fresh process 派生逐项等于候选；记录旧/新值、候选/hash/优选警告/选择来源/源文件结束 hash。

验收：20 组逐值一致、不手调 HEX；完全沿用旧组时按原 M6 回 M5 说明，不静默把旧值当重设。此卡不修 picker、不 capture、不 prepare；生成物尚未刷新明确记为阶段缺项，父 M6.1 未完成。

## M6.1.3 picker 字段适配

前置：.2；与 .2 串行，因为 test/skins.test.js 共用。允许 `public/skin-picker.js` 与对应皮肤测试。

按原 M6.1 九项 mini 变量映射，从规范化 `.tokens` 调共享派生；验证实际 text/muted/border 来源。mini DOM、framing、五款列表、classic、pending/fallback 不变；不新增 chartSeries。

验收：单卡测试与一组浅深 mini 的真实接线；不重拍十套正文矩阵。调用实际派生，不重写颜色数学。

## M6.3.1 工程脚本配置（在生产捕获前完成）

允许唯一配置 owner 修改 `package.json / biome.json`，只接原 M6.3 的三个脚本和有限检查范围，不新增依赖、不格式化无关文件。

验收：参数传递、缺证据退出失败、verify 不隐式 capture、检查范围准确。尽早完成所有配置/工具编辑，避免正式截图之后再改相关 sourceHash。这一小卡完成不代表最终全仓门禁完成。

## M6.1.4 生成物刷新与正式快照屏障

前置：.2/.3、M6.3.1 通过；prepare 唯一 owner 在新的 Node 进程执行原 `skins:prepare`，不手写 bootstrap。核对 40 个资产/manifest 的内容及无关改变，执行 skins:check。

输出 `production-source-manifest.json`，记录正式源码/工具相关摘要、选中候选和生成物 hash。核对初始 palette、picker、CSS、布局、角色 bounds 的授权差异，仅颜色/受限接线属于预期改变。此后生产/测量依赖冻结，才能开始 M6.2 的只读任务。

验收：bootstrap/runtime 逐值等于选择、资源无意外变化、M6.1 三项写入结果一致。发现失败回准确 owner；正式颜色失败回 M5 产生新候选，不在验收任务里加深 HEX。

## M6.2.C.<skinId> 正式捕获（十个独立实例）

前置：正式快照屏障、M4.4 production 路径。每个实例只处理一套浅深，不承担另外九套。调用既有 `capture --production --run <总run> --candidate <已选ID> --out <新目录>`，服务实际 candidate=null。

写自己的 production evidence 和 index 登记分片，独立 fixture/context。复用 M4 已实现的首屏、S0—S7/D 状态和 geometry，不重新开发 executor；确认正式 12 token 与选择、20 root 声明、主题恢复、必要阅读和角色/聚光组合。

验收：该皮肤完整矩阵及当前 sourceHashes，失败/缺测原样记录；未测不能叫通过。资源预算全局默认一条、最多两条；不让十个 worker 各自开浏览器。初次 capture 已产生的恢复/视口/几何证据供以下小卡复用，不再重复同矩阵。

## M6.2.1 首屏、主题与 classic 专项核验

前置：相关 C 实例。两个小出口：按 skinId 只读核对已有首屏/主题/重载证据；单独 classic 两模式真实回归。前者实例化十个短检查，不集中成一个长浏览器任务。

character→classic→character 的 20 项清除/恢复优先读取 S7 证据；classic 本身与有效 M0/M4 基准颜色/几何对照需要独立捕获。只有明确缺失项才发单次补证任务，不机械重拍十套。

验收：首帧/runtime/选择一致，无旧色残留；classic 未注入角色值且有真实两模式对照。

## M6.2.2 五款 picker 交互核验

只读正式快照；一项任务最多一款开放皮肤的浅深 mini/选中/键盘/关闭/透明度恢复/decode，实例为当前五款；另由 owner 校验产品选项列表仍五款。

写专用交互证据，不修改 picker 或生产色源。隐藏五款可供内部捕获，不能出现在产品列表。优先复用已存在且同摘要的相同场景证据；不同场景不冒用正文截图。

## M6.2.3 几何差异核验（按 skinId 实例）

读取该皮肤 C 的 geometry/原图与准确同状态基准，比较 topbar、metric、panel、chart、artwork bounds、字体/布局。先说明测量误差，再判断越界；误差口径沿用已验收 M4，缺口径交 owner，不任意设大容差。

验收：逐状态出处/差异/原因清楚。缺基准时登记缺口、发限定补证；不通过修改页面宽度或角色位置让比对绿，不完整重拍。

## M6.2.4 在线冻结专用回归

独立 fixture，分 `light` 和 `dark` 两个实例串行或按全局资源预算执行；fixture 不与正文 worker 共写。

调用 M4 已提供的 online freeze 回归能力，证明新增记录→live 更新→暂停并切周期仍同 snapshot→恢复刷新拿到新量。无须在每套每组初筛重复。验收原 API/记录链和实际数值变化，不恢复 HTML 导出、不改服务器业务。

## M6.2.5 视口与实际显示缩放

分自动核验与人工环境证据两小出口。自动部分按 skinId 读取 C 中 1920/2560/1280 的 CSS viewport/DPR/geometry，已有 D 证据不重拍。

实际显示缩放部分记录目标机器真实缩放、浏览器 zoom、实际视口、侧栏/并排条件及查看证据。环境不可用或尚未做时明确 untested，不用模拟视口冒充。该缺项不阻止其他短核验完成，但最终必要验收仍不能宣称齐全。

## M6.2.6 正式证据汇总

前置：十个 C 与上述短检查已有结果或明确缺项。唯一 owner 写总 production index 和 `final-assessments.json`。

验收：逐项核对 20 模式、classic、五款交互、角色/聚光、几何、freeze 和实际缩放；sourceHashes 与正式快照一致；不能把单卡 DONE 当成整体证据，也不能复制候选 assessmentHash 假装正式实测。任何必要缺测/硬失败保持 incomplete/rejected，不提前放行 M6。

## M6.3.2 最终工程门禁

前置：所有代码/config/生成物已经稳定、正式证据汇总。协调者一次运行原 M6.3 全部命令，包括 skins:palette/check、npm test、typecheck/lint/format、verify --production --require-selections、git diff --check。

只记录实际结果和覆盖范围；历史 checker 退出 0 不代替新阅读门禁，工具不在 TS 范围的不宣称额外类型覆盖。失败回对应 owner 修复；改动影响证据时先判断精确失效范围，不隐藏红项或连续整仓重跑。

## M6.4.1 文档事实更新

前置：各专项及工程门禁有准确结果。唯一文档 owner 只改原 M6.4 允许索引和开发/看板说明；十套内部正式色源已重设与选择器仍五款分开写，其他会话事项不顺带完成。

输出准确生成→capture→report→selection→production 命令与摘要规则。未选择/未测/待视觉意见保留 pending。验收所有完成措辞有证据，Markdown 链接有效。

## M6.4.2 证据索引与回退核验

只读最终产物和 .1 回退快照；补本轮验证 README/证据索引及回退说明，由同一文档 owner 写，与 .4.1 串行；可让只读 subagent 检查链接或回退对象完整性。

验收准确定位旧 palette 对象、恢复具体皮肤/模式、fresh prepare/check 步骤；只核验回退材料和步骤，不实际回退工作区。候选、原图、失败证据保留。只有全部必要出口完成父 M6 才 DONE，提交/推送/开放延期五款/发布仍不在授权范围内。
