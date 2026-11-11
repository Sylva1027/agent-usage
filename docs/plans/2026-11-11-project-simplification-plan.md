# 全项目无损精简审查与实施计划

日期：2026-11-11。状态：**计划已完成，精简尚未实施。**

目标：逐项找出没有实际用途、重复实现和维护成本超过收益的代码，优先删除，其次复用现有实现。每项替换都保持现有数据、功能、结果、交互和已接收的性能。以最终 diff 和验收结果判断是否值得做，不以删除行数作为任务指标。

本轮交付本计划及任务入口，然后按用户要求提交整个工作区的全部未提交改动；不在本轮开始精简。实施时沿用当前代码结构，不引入新框架、通用工具层或生产依赖。

## 1. 项目用途、运行负载和审查范围

项目是单机运行的六来源用量看板：读取日志/SQLite → 增量事实索引及冷热历史 → 计价、汇总、额度窗口 → 本地 HTTP 和浏览器。按单个用户、多个浏览器请求、持续追加的来源及可能存在的外部数据库连接审查；不是多人云服务模型。

已盘点 Git 跟踪文件及未忽略的未跟踪文件，扫描 JS 静态/动态 import、导出、函数重复及全仓文本引用。以下数量只统计 `.js/.mjs/.cjs/.rs/.ps1/.css/.html`，包含空行，排除依赖、生成目录和图片：

- `src/`：46 个文件，36,897 行。重点为 `cli.js`、`server.js`、`usage-core.js`、`usage-store.js`、执行器、来源读取、计价和历史处理。
- `public/`：21 个文件，16,375 行。覆盖入口、页面状态、日期/时间轴、趋势、翻译、皮肤和样式。
- `scripts/`：41 个文件，41,374 行。主要为皮肤生成、浏览器测量、评审和证据校验。
- `native/`：3 个代码文件，1,993 行；另读 Cargo 配置和说明。负责 Windows 来源证明和归档读锁。
- `test/`、`test-support/`：243 + 9 个文件，153,350 + 2,679 行。检查重复夹具和断言的实际作用。
- `experiments/`：316 个代码文件，74,059 行；其中架构实验 253 个文件、62,061 行。另查 CI、README、配置、开发/交付文档及历史引用。

完成的是**全仓结构与引用筛查，以及主流程和候选代码的定向阅读**，不是已经逐行审完约 32.7 万行代码。第 9 项负责闭合剩余模块审查；不能把本轮没有发现问题的模块直接标记为全部无冗余。

## 2. 无损替换的验收边界

每张任务卡按影响范围验证以下契约；与该卡无关的项目不重复跑重型验收：

1. **数据保留**：原始事实、源文件已消失的留存事实、冷段、修订覆盖层、归档哈希和已有配置保留。精简不升级 schema，不清空重导；确有必要改变存储契约时拆成另一个计划。
2. **业务结果**：Token 明细与缺失标记、去重、会话/来源/仓库归属、费用和币种、额度筛选、时间边界及比较结果一致。保持既有求和与舍入顺序。
3. **可用性**：CLI、HTTP 字段/错误码、刷新与冻结、导入、语言、主题、皮肤、键盘操作与已有布局保持原行为。
4. **恢复与资源**：事务回滚、崩溃恢复、持续写入可见性、有限内存、缓存失效和助手缺席回退继续成立。不能用同步全量读取代替现有流式/分页/增量通路。
5. **维护成本**：引用、测试、夹具、配置和文档一起收尾；仅移动代码、增加层次或让调用更难理解的改动不算精简。

实现前复查候选的调用方，变化后的代码可能与本计划行号不同。静态无引用只说明仓内现状；还要检查 HTML 入口、字符串/动态引用、命令行入口、文档契约和模块副作用。

## 3. 已有明确证据的任务卡

### 01｜删除无调用声明，收窄不必要导出（优先）

**证据**：以下名称在全仓搜索中仅命中定义，本轮没有发现调用或导入：

- `public/i18n.js:564`：`englishCopyEntries`。
- `public/skin-palettes.js:419`：`SKIN_PALETTE_DOCS`；代码注释说明它仅用于类型示意，当前却会创建运行时对象。
- `public/skin-ui.js:444`：`SKIN_RUNTIME_CONSTANTS`。
- `src/pricing.js:696`：`API_TOKEN_PRICES`，会在模块加载时派生一份未使用价目。
- `src/history-backup.js:12`：`HISTORY_BACKUP_SCHEMA_VERSION` 别名。
- `src/usage-history-projection-store.js:33`：`USAGE_HISTORY_PROJECTION_TABLE_NAMES`。
- `src/zcode-usage.js:38`：`zcodeHomeLooksUsable`。实际发现通路使用 `zcodeDatabaseFile`。
- `public/history-archives-ui.js:629`：`mountHistoryArchives`，只包装监听安装、刷新和重绘。

**最小改法**：删除无用途声明；类型示意保留为 JSDoc 即可。删除 `mountHistoryArchives` 时一并核查只由它使用的两个监听安装函数及 WeakSet。其他归档渲染、加载、分页和测试不随之删除。

`claudeServiceTier`、`readSessionThreadNames`、`discoverZcodeHomes` 等仍被模块内部调用的函数，只在没有外部契约时去掉 `export`；不能删除函数本身。

**验收**：相关 i18n、skins、pricing、zcode、history-archives-ui、history-backup、history-projection 测试及 typecheck/lint。纯声明删除不新增镜像式测试；保留现有行为测试。无调用包装继续保留只会增加维护面，没有兼容收益。

### 02｜移除已退出调用链的焦点测量实现（优先）

**证据**：`scripts/skin-palette/focus-outline-browser.mjs:281` 的 `measureFocusOutlinePixels` 共 112 行，仅有定义。正式测量入口 `browser-measure.mjs` 和该模块测试均使用 `measureFocusOutlineAdjacentPixels`。

**最小改法**：删除旧函数及随之无用的 import。`focus-outline-pixels.mjs` 中仍被独立测试使用的分析函数继续保留；不因浏览器包装无调用就连带删除。

**验收**：`skin-palette-focus-outline-browser`、`skin-palette-focus-outline-pixels`、`skin-palette-quality` 中相关场景。自然焦点、截图、句柄释放、失败传播和现行相邻像素测量不变。跳过会继续维护一套没有消费者的旧测量协议。

### 03｜将计价对照算法移出产品模块（优先）

**证据**：`src/pricing.js:1094` 的 `isPeakPricingTimeExact` 注释称“只被测试引用”，但全仓搜索仅有定义；`peakWindowsHitNaive` 只服务于该入口。

**最小改法**：核对峰谷计价测试是否已有独立预期值。已有充分覆盖则删除旧入口及专属 naive 函数；确实需要独立对照时，将旧算法放入测试支持文件并让测试实际调用。不要为保留它而增加生产分支。

`peakLocalTupleExact` 仍参与时区偏移校准和回退，必须保留。不能按名字包含 `Exact` 就一并清除。

**验收**：pricing、claude-pricing、w4-event-cost-memo 适用场景；峰谷交界、周日、无效窗口、无效时间、时区/夏令时和费用结果一致。跳过会留下失真的注释和无作用的产品代码。

### 04｜复用已有日期运算（第二批）

**证据**：`public/app.js:661/767/775` 与 `public/timeline-utils.js:341/347/355` 的 `startOfDay`、`startOfWeek`、`addCalendarDays` 完全重复。`public/period-comparison.js:10/16/22` 已有共享的日初、日末、周初实现，`usage-core.js` 已在使用。

**最小改法**：app 和 timeline 直接导入现有日初/日末/周初函数，可用 import 别名保留本地名称；`addCalendarDays` 在现有共享日期模块保留一份。先核对依赖方向，避免 timeline 与 period-comparison 形成循环。不新建日期工具框架，不把自然日运算改成固定毫秒加减。

**涉及调用方**：最近范围、自然周、时间轴分桶、上一周期及浏览器静态数据统计。

**验收**：timeline-utils、recent-selections、usage-core、app-summary、three-path-parity，以及季度/月末、闰年、跨年、本地与 UTC、夏令时场景。

### 05｜统一趋势的纯数学部分（第二批）

**证据**：`public/app.js:1067/1095` 与 `src/usage-core.js:3089/3102` 的 `averageTrend`、`percentChange` 完全重复。

**最小改法**：放到现有浏览器/Node 共享的 `public/period-comparison.js`，两端直接调用。先只统一纯数学；两端 `rangeDurationMs` 的日期输入形态、额度可用性及筛选不同，不强行把整条汇总流程合并。

**验收**：app-summary、usage-core、three-path-parity、previous-weekly-quota；上一周期为零、当前周期未结束、无效范围、quota 缺窗、排除来源和舍入结果保持一致。相同代码不统一会让后续趋势修复需要修改两处。

### 06｜合并四个来源的同义 Token 解析（第二批）

**证据**：`claude-code-usage.js:37`、`opencode-usage.js:24`、`workbuddy-usage.js:54`、`zcode-usage.js:69` 的 `knownToken` 完全相同，四者均已导入 `public/usage-fields.js`。

**最小改法**：把该函数移入现有 `usage-fields.js`，四个来源复用。保留 `null/undefined/空字符串/非有限数/负数/零` 的现有 known 判定，不顺手改成 `Number(value) || 0`。

`truncateName` 也有三份相同实现，但单份只有几行。只有能放进职责相符的现有模块且净减少复杂度时才处理；不为它新增 `utils.js`。各来源的目录发现、数据库打开和缓存包含语义继续独立。

**验收**：四个来源适配器、workbuddy-core/store 和 three-path-parity；明确零值与缺失值、缓存写入、同消息去重和累计/增量语义保持一致。新增共享解析逻辑只补一个表驱动边界测试。

### 07｜收拢测试中的字面量夹具（优先，可独立实施）

**证据**：同一段 25 行 Codex Token 日志构造器，以 `codexTokenLine` 复制 8 次、以 `tokenLine` 复制 6 次；两组仅函数名不同。涉及：

- `history-archive-store`、`history-cold-hot-tail-revision`、`history-cold-prefix-late-add`、`history-cold-prefix-revision`。
- `history-cold-revision-bundle`、`history-cold-revision-overlay`、`history-cold-rollup-rebuild`、`history-period-executor`。
- `history-cold-dashboard-api`、`history-cold-freeze-api`、`history-cold-rollup-sync`、`history-cold-snapshot-cleanup`、`history-cold-snapshot-executor`、`history-rollup-rebuild-executor`。

`pricing-auto.test.js` 与 `server.test.js` 还重复了 `glmPricingPage`、`stepfunPricingPage`、`kimiPricingPage` 三份页面夹具。

**最小改法**：14 份日志构造器保留一份，复用 `test-support/` 的夹具组织方式；优先放在合适的现有模块，若会引入数据库/压缩等无关重量级依赖，改用一个只生成日志文本的小文件。供应商页面同样保留一份字面量，不新增模拟服务器框架。

**验收**：14 个受影响测试文件和 pricing-auto/server；构造出的文本逐字一致，各用例的独立临时目录、故障注入、清理及断言保持原样。夹具不能改为调用被测生产解析器，避免双方一起算错。

### 08｜缩减皮肤工具的重复基础函数（第三批）

**证据**：`assess.mjs:144`、`diagnostics.mjs:75`、`generate.mjs:68`、`solver.mjs:99`、`templates.mjs:222` 的 7 行 `deepFreeze` 完全重复。工具中还有重复的数值断言和路径子目录判断。

**最小改法**：先检查现有 `contracts.mjs` 的依赖方向；无环且职责合适时保留一份 `deepFreeze` 并导入。数值断言只在报错语义一致时合并。路径校验涉及信任边界，保留原检查和平台路径规则，优先单独处理。

**验收**：skin-palette-contracts、math、solver、report、review-evidence、review-selection、review-production 的受影响覆盖；不可变性、输入未被意外冻结、哈希和评审结果一致。无需重新生成整套候选或重跑所有截图来验证一个纯函数搬移。

## 4. 剩余全项目审查任务

### 09｜闭合高复杂度模块、实验及交付边界（在前两批后执行）

本项是继续调查的工作清单，**未发现证据前不预定删除**。

1. **索引和执行器**：逐方法核对 `usage-store.js`、`usage-executor.js`、所有 projection/rollup/cache 模块及 server 的操作分发。为状态、缓存和方法标出生产消费者，找出失效分支、只转发一层的包装、重复加载和重复转换。每个候选附触发场景、调用链和最小替换。只拆分文件不算收益。
2. **来源发现和证明**：查 `usage-source-*`、JSONL/DSH 游标及 SQLite reader，核对每次读/校验保护的截点。可复用同一次操作的已验证结果；不能用 mtime/长度代替完整前缀证明。当前不重启大规模性能优化。
3. **归档/备份/压实**：核对 hot/cold/query/verification 的职责和重复路径。保留冷历史事实、修订、导入实例隔离、持久化 receipt 及回滚。发现能合并的部分先用已有小夹具证明等价，不能以删保护换短代码。
4. **前端、CSS 和工具**：核对 DOM/选择器、动态模板、主题/皮肤变量、可访问性与工作室入口。`history-archives-ui.js` 当前只被测试导入，主页面没有接入；先核对现行产品/保留需求，再决定其剩余代码是否属于待接入功能。不能只凭静态页面没有文字就判定 CSS 无用。
5. **测试和测试支持**：核对超大皮肤测试里的重复搭建、复制的协议样本和已退场断言。删重复搭建，不删边界反例；源码字符串测试仅在同一契约已有行为测试覆盖时替换，保留 no-tps 和隔离边界等明确约束。
6. **实验**：对五个实验目录逐个建立“现行 CI/测试/文档/复现命令消费者”记录。架构实验仍有专用 CI；约 130 个实验 JS 文件含产品路径引用，需区分 import、构建变换和快照源码。只删除无消费者、无复现用途的叶子脚本，不整目录搬迁导致相对路径和证据失效。
7. **原生/脚本/配置/文档**：查 Rust 分发及协议操作、Windows 构建与内存限制脚本、npm/CI 命令、依赖真实用途、文档兼容入口。`typescript` 被配色源码转换和架构脚本直接使用，不能当成纯类型检查依赖移除。当前没有可直接删除的生产 npm 依赖。

**闭合交付**：按上述七组列出“已读入口和具体模块、可删候选、保留理由、尚未验证项”。每个新增候选必须有完整引用核对和验收入口；没收益的组明确记为保留。需要全新架构或改变现行契约的提案另列，不混入精简提交。

## 5. 执行顺序、检查和回滚

1. **基线提交**：本计划完成后，先提交用户要求的全部工作区改动，包括现有计划、实验、提案和进度产物。该提交是精简前的恢复点。
2. **第一批**：01、02、03、07。死声明、退出调用链的实现、测试专用对照和重复夹具，分为可独立回退的小提交。
3. **第二批**：04 → 05，以及 06。日期、趋势和字段解析分别提交，不顺带改统计规则。
4. **第三批**：08，再完成 09 的七组闭合，新增证据充分的候选后逐项执行。是否有可删代码由审查决定，不设删除配额。
5. **集成验收**：先跑每卡受影响的局部测试；完成一批集成后，按现有 CI 跑适用的完整测试、`npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run format:check`。同一代码版本通过后不为凑数量重复跑。

每张卡提交前检查 diff、遗漏引用和相关测试；涉及数据/恢复必须运行已有相应反例。日期和计价使用固定输入对拍；UI/CSS 若确实变更，检查现有布局、主题、语言与键盘操作。只有改动进入性能敏感路径且小夹具无法排除回退时，才使用既有有限对照；不恢复已暂停的大矩阵。

如果业务结果、错误码、恢复能力、资源上限或用户功能有变化，就修复或撤回该卡，不能通过修改期望值把精简变绿。每卡独立提交，回退仅撤销该卡；本计划不触碰活动数据库或切换服务。

预计第一轮可净减少数百行，主要来自旧测量和重复测试夹具；实际以验收后 diff 为准，不承诺没有证据支持的体积/速度收益。当前依赖删除目标为 **0**。

## 6. 与其他现有计划的关系

[重构后追加需求计划](2026-11-11-post-refactor-additions-plan.md)仍然有效，本计划不改变其模型规则、双版本发行、布局、主题交互或 TPS 离线维护要求。两个计划都会涉及 `pricing.js`、`app.js`、皮肤模块和测试；同文件修改顺序执行，后一项开始前更新引用核对。

历史实验和 TPS 研究资料不因产品当前无 TPS 就自动成为垃圾。文档导航页、类型定义、HTML 直接入口和旧版本对照夹具均可能没有普通 JS import，必须按实际用途判断。

## 7. 本轮已执行验证与未检查项

- `npm.cmd run typecheck`：通过。
- `npm.cmd run lint`：退出 0；现有基线为 51 条 warning、3 条 info，无自动修复。主要是 CSS 级联/important 提示，不将可访问性覆盖规则机械删除。
- 定向 Node 测试：timeline-utils、skin-palette-focus-outline-browser、i18n，共 **44 项通过，0 失败、0 跳过**。
- 完成全仓结构/引用/完全重复函数扫描，并核实候选定义、消费者及现有测试入口。

未执行完整测试、全仓格式检查、真实浏览器重测、Rust 编译/测试和大数据性能对照；本轮没有修改生产或测试代码。约 32.7 万行代码尚未逐行审完，未验证候选不能按“无损已证明”直接实施。
