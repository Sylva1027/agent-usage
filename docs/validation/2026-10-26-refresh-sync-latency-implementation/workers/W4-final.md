# W4-final — H 前探针与最终 store 静态审证

## 范围与结论

cwd 已实测为 `E:\12 AI\ccusage\codex-usage`。仅只读检查指定五个探针、相关调用者、E 测试及本轮证据；本卡唯一写入本文件。未启动 Node/npm、测试、基准、浏览器、SQLite 查询或其它 worker，未操作来源输入、恢复器、产品或探针。Main 持有唯一测试槽。

**正式浏览器周期前应先补两项验收断言：quota busy 链；非 ledger 场景的目标帧与非空时序。** 探针自身还存在 Date 恢复精度问题，须由 Main 的精确恢复器及 fd1 校验兜底。E/C/B 在本次所查失效和外部提交边界内未见新增产品阻断项。

本报告是静态审证与已有结果读取，不是 H 验收通过。Main 提供的全仓 3301 例、3274 通过、25 跳过、2 个 `fetch bad port` 失败仍待其定向复核；不将其列为产品缺陷。

## 具体发现

### 1. [P1，验收断言] quota 探针会接受原本要拒绝的 busy 回归

位置：`output/refresh-sync-latency-implementation/quota-branch.mjs:32`、`:57`、`:63`、`:64`。

探针确实制造 quota → today 的第二请求，并断言 preset、精确 total 增量、可见 output 文本及 `skipCheck=1` 请求存在，但没有断言 busy 从首次检查持续到第二响应/render 完成，也没有对错误数组或完整目标帧作成功门禁。

已有具体反例：只读解析 `quota-before-results.json` 得到 `failure` 不存在、`finalPreset=today`、最终 output 文本变化，但 `firstPayloadAt=1793027999236` 至目标值帧 `1793028000027` 之间记录了 **1 个 busy=false 帧**。因此现有“成功”并不能证明 F 修复成立，旧缺陷仍能使本脚本正常结束。

最小处理：保留合成场景标记，针对 trigger/第一响应/第二请求/最终目标值界定同一纠正链；要求 busy 真正开启且在目标 render 前不提前结束、最终目标帧包含正确值并已退出 busy，同时要求相关请求成功及 errors 为空。以旧版出现提前结束、新版不再出现为反例判别，不只看最终总量。由 Main 修改探针或在最终审证中明确计算该不变量；W4 不改探针。

### 2. [P1，验收断言] 普通增量轮可带空可见延迟通过

位置：`http-browser.mjs:167`、`:171`、`:172`。

`matching` 目标帧只有在 ledger 分支才 `assert.ok`；Claude、Codex 新文件/追加只要求最终 DOM 值相等。若目标帧没被捕获，脚本仍保存 `fromCheckMs=null`、`fromWriteMs=null` 并继续。因此后处理若过滤 null，可能漏掉最慢或未观测到的样本，而脚本并未失败。

最小处理：每个有变化场景都要求正确目标可见值对应的 frame 存在、时间为有限非负值；不能丢掉 null 后计算正式分位数。unchanged 场景单独记录检查完成与 busy，不把旧总量本来已存在当作新增值呈现。普通增量与 ledger 分开统计，逐场保留所有慢样本。

另一个口径：`:151` 的 `requestAt` 是 status HTTP 请求事件被观察到的时间，`:172` 将其作为 `fromCheckMs` 起点；它不是自动检查 tick/忙状态开始。探针已有 `__refreshTicks`，正式 G1 应关联同一轮真实 tick/busy 起点，或将现字段明确命名为“status 请求到目标边界”，不能把它直接等同整个检查等待。

### 3. [P1，身份恢复] 三个写来源探针仍会丢失 mtime 小数部分

位置：`changed.mjs:25`、`:72`；`http-browser.mjs:30`、`:189`；`quota-branch.mjs:16`、`:68`。

三者保存 `stat.mtime`/`stat.atime` 的 Date，然后 `utimesSync(file, Date, Date)` 恢复。Date 只有整数毫秒，而来源指纹使用包含小数部分的 `mtimeMs`；即使字节和长度恢复，时间身份也可能漂移。这条路径独立于旧 PowerShell Double→Decimal 恢复问题：新恢复器修好后，这些 finally 再执行仍可能重新改变身份。

Main 已提供精确恢复器修正和 source fd1 原样复测结果，本卡不操作输入。最小闭环：changed、quota、browser 每场结束后，均由外层调用以原始 JSON 数值恢复的恢复器，删除合成来源，再核对基准 source fingerprint/必要逐文件签名。只有匹配后才能开始下一场或固定输入 A/B。不能仅以“探针 finally 成功”作为身份恢复证明。

### 4. [P2，测量方法] rAF 记录的是此前 DOM 快照，未在记录帧重读

位置：`http-browser.mjs:113`、`:115`；`quota-branch.mjs:33`、`:35`。

两处先在 MutationObserver 里读取 value，再由双 rAF 回调为旧 value 标 `frameAt`。若两次 rAF 之间 DOM 又变化，保存的值可能不是 `frameAt` 时的实际状态。它可作为“某次 DOM 变更之后的双 rAF 边界”，不能单独证明该旧中间态在该帧可见，尤其不能据此精确判断 spinner/目标值同帧。

最小处理：保留 domAt 的变更记录，并在最终 rAF 中重新读取可见文本、title 和 busy；匹配目标值应以该次读取为准。正式报告继续称 DOM/双 rAF 边界，不升级为已证明实际物理绘制。quota 判别也应使用该稳定帧状态。

### 5. [P2，恢复与失败证据] 关闭失败可跳过恢复；硬终止不会执行 finally

位置：`http-browser.mjs:187`；`quota-branch.mjs:68`；`changed.mjs:70`；`ab.mjs:64`。

HTTP/quota 在同一个 finally 中先 `await browser.close()`/`await server.close()`，再恢复共享冻结来源和写结果；关闭若拒绝，后续恢复/证据保存全部跳过。changed/ab 也先 close 再保存。更重要的是，Job 超时/内存终止不会运行 JS finally；三个写来源场景只在进程内保存恢复所需状态，冻结输入可能保留尾部追加或合成文件。

最小处理：Main 的串行外层，无论退出码、超时或触限都执行独立恢复及 fd1 核对后再允许后继场景；正常脚本清理用独立 finally/错误汇总，避免一个关闭失败跳过其它清理。不要把仅有 finishedAt 的部分 JSON 当作完成；必须同时核对退出码、failure、完整样本数/计数和非空时序。

已查 `createUsageServer()` 的无参 close 是仓库自定义 Promise，确实等待执行器释放；`await server.close()` 本身合理，不误报为原生 HTTP server 的立即返回行为。

## 方法与资源边界：可用部分和最终证据要求

- `changed.mjs` 三组各 20：原生/Claude 对 raw event total 作精确增量断言；ledger-only 要求 tokens 不变、dirty=0，目标新线程的定时 output 每轮精确增加。唯一 thread/response、真实 builder、同轮可见判别合理；它是同步成本探针，不是浏览器用户等待分布。
- `http-browser.mjs` 默认包含 **21 个真实 60 s 场景**；`--probe-smoke` 明确改为四个人工触发场景，标签也区分，不能将 smoke 混入正式周期。最后最多两个浏览器 tab，共用同一 server；不引入第二服务树。重叠请求样本可检查合并，不应当成每请求独立 sync。
- 两个浏览器探针只将 pricing refresh 回应设为 no-change，属于受控隔离条件。quota 首个 payload 还做了 metadata 变换，已有 scenario 字段标合成场景；应保留这一说明，不能将其频率或时延当作自然生产发生率。
- `ab.mjs` 固定 now、price catalog、三档范围，预热/正式分开，完整业务 hash 仅去除预定三个时间字段。脚本的 mode 只是输出标签，before 源码切换实际依赖 `REFRESH_PRODUCT_BEFORE` 和 hook；最终证据需保存真实 invocation、源码摘要和 source fingerprint，不能只看文件名 before/after。
- 只读审查 hook：来源读取、realpath 反映射、SQLite 构造器映射保持；预像替换同时覆盖 src 和 public，异步包装继续返回/抛出原结果，同步方法仍同步。部分源码注入锚点采用普通 replace，不自动证明命中；当前关键读/写副本接口与源码相符。正式性能应区分 `REFRESH_TRACE=0` 的端到端样本和启用 tracing 的阶段计数，不将不同开关的时间直接混比。
- freeze manifest 当前只有 home 原路径到隔离 copy 的一组映射，五个探针均依赖预加载 hook 才使原 home 的产品读取转入冻结输入；运行前须核对该预加载真实生效。`physical()` 使用目录分隔边界的路径映射合理，quota 的裸 startsWith 在当前仅一条 home 映射下未形成实际冲突。
- 资源约束必须来自 Main 的外层 Job：真实数据/浏览器树 7168 MiB、heap≤1536 MiB，测试槽唯一，退出码及子进程清理有持久记录。脚本中的 `os.freemem() >= 4 GiB` 不是本任务 8 GiB 总预算的替代约束；HTTP 的 RSS/maxRSS 是当前 Node 进程口径，不包括独立 Chromium 子进程，不能当整树/浏览器峰值。已查限制器确有 JobMemoryLimit、超时和整 Job 终止，但它没有输出 Job/Chrome 峰值；如最终要声明 G7 峰值，仍需 Main 的外层测量证据。
- 两浏览器探针记录 errors，但自身未对 errors 数组做非空失败门禁；Main smoke 已报告 errors 为空。正式周期仍须检查请求状态、errors 与完整周期，不能只依赖脚本退出 0。全场 timeout 必须覆盖 21 个真实周期及初始化/恢复，不能沿用小卡 180/900 s 的短上限；也不应超过已有受限运行器允许范围。

## 最终 usage-store.js：E 失效与 C/B 外部提交

**所查范围无新增阻断产品缺陷。**

- E 只将完整 `summary.perf` 接到既有 all projection；命中要求完整 key，包含 store/derived revision、SQLite total_changes/data_version、精确 resolved range、bucket、排除 homes、includeDetails、service-tier 输入、价目键/版本及 FX。原始本连接 SQL 写和外连接提交均不会仅因 storeRevision 未变就误命中。
- 只有 all、非 quota、无跨 await 写事务及允许的 hot/已验证 SQL 冷读分支复用。读写两侧 structuredClone 保持调用者隔离；非 all、quota、未验证 cold authority、写事务继续原路径。indexedAt/warnings/missing/state 是完整 perf 内容，相关本连接写也经 total_changes 失效。
- 读入口先对齐外部提交，修订变化会清 summaryProjectionCache；close 清空。当前 E 两条新增测试确有完整嵌套块、1 ms 精确范围、排除、原始 SQL/显式修订/外提交、回滚及未提交旁路断言；本卡未重跑。
- C 当前长期缓存只保留 signature/trusted/paths 与最小 response/output/model 映射；仅 B 指定 dirty 线程临时取完整 rollouts，未重新常驻整个历史 projection。签名仍包括 owner 路径、published fingerprint、method 和完整 projection 字节；脏线程构建拿到真实 rollouts，旧紧凑缓存不绕过校验。
- B 入口及 BEGIN IMMEDIATE 锁内双检 context.dataVersion；builder 后在首次候选/dirty/sidecar 写之前复核所有受影响 rollout，失败回滚 false，沿用完整第二轮。外提交检测同时清轮内两份 maps 与相关缓存，fallback 不沿用旧视图。成功侧原子候选、依赖、历史 replaced facts、warnings、seq/revision/indexVersion，提交后才更新视图，原两项发现未重新出现。

## 身份与近期结果的证据等级

- 五个探针审查时 SHA-256：changed `763db7124b924e46dea35066a59ed7f73e068f02602b431c0aee6bc54722973e`；http-browser `56c1c6b4f0354bd4e52ebc3eda85173b14d696297aaffcc852acc4783311e112`；quota-branch `854b3a0c4c444f1482c7f72c815b960b63a589e8c6f3fda2e55353721535c98f`；ab `929ee7f0507b91cba274f07ccb1ad9f3962764e9730203d0dadc5cfb9645b2c5`；hook `5b7efad46705a937cc5faad553c5249e377ae9643200c7942b879129e96755db`。后续 Main 修探针须更新对应摘要；本报告不将旧源码审查自动算作新版通过。
- store 开始读取得到 `e2e7203d6cd223e8e52f62f8473824569149081dbf01e6160e6beeb711f40cf7`，后续实测为 `2d9df686762addef540a78b505baa325aab216ee8e4bf9d841768006c56e0a27`。逐行对前 E 副本检查，额外变化只有已预期的 E 接线/说明和 `turn.requests` 的类型注释；所查 runtime 边界相同，但正式冻结身份应绑定最后实际文件摘要。
- Main 后续报告：原始数值精确恢复后 source fd1 原样；comparison 三档各 21 份完整业务 hash 一致；before PowerShell 搬移损失的整秒 ISO `.000` 仅作窄格式恢复，已重新对回 before 进程原 hash，仍只去除预定三字段。本卡未执行该恢复或重算，不将此前漂移的 after 样本作为正式结果。
- Main 报告静止 p95 8133→2810 ms、all 685→70 ms；month 1545→1679、today 481→504，无收益。此处仅记录其报告，不独立宣布整体验收达标；不掩盖 month/today 未改善。
- Main 报告四场景 browser smoke 均成功：Claude 5388、Codex-new 8663、append 8258、ledger 5378 ms，精确 delta/ledger sample 正确、errors 空。它们不是 21 个真实周期的分位数，正式周期仍须处理本报告 1/2 和资源、恢复证据闭环。

Verdict: 产品 E/C/B 静态边界本次无新增阻断；正式 H 的可见时序与 quota busy 证据在补齐上述断言之前不应标记完成。精确恢复可由 Main 外层闭环，不要求为此改产品。

Not checked: 所有运行与输入恢复均由 Main 执行；W4 未启动任何运行时、测试或浏览器，未给两个 bad-port 待复核失败作产品归因。仅写本文件，保留全部原输入、探针、产品、旧记录与未提交改动。

## 2026-10-27 收口附录：测试侧修订只读复核

按 Main 本轮指示，只读核对两探针新版和恢复/校验辅助脚本，不运行任何探针、测试或输入操作。cwd 再次核实正确；本次唯一写入仍是本文件，不修改以上历史观察。

复核身份：

- `http-browser.mjs`：`66684c95b4ce5ea6c2bb947e9eb007aa0da3d9fe84f337afe77641bb709282a8`。
- `quota-branch.mjs`：`523008698524f29755e2e3615ecde7d8c9614b0666ee8aac3f8c1f06d91565ae`。
- `restore-inputs.ps1`：`21fde265f55590b4974248940d342b35734be5b023d01b760e1b6d1020cd1475`。
- `check-inputs.mjs`：`fe764ac3bb6aea3682fb79e7a4fe2ce6db9add484ab069d6f6fb568cfdf68ded`。
- 产品 `usage-store.js` 仍为 `2d9df686762addef540a78b505baa325aab216ee8e4bf9d841768006c56e0a27`；本轮没有额外产品改动待审。

**发现 1（quota 断言）静态关闭。** 新版 65–75 行要求 errors 为空、已记录的相关 HTTP 响应全部 200、trigger 后 busy 确有开启；目标 measured frame 要求重新读取的 outputText 为最终值且 busy=false。第一 payload 后到目标变更之间的 busy=false/旧 output 被单独计数；before 模式必须计数大于零，after 模式必须为零。原有精确 total delta、可见 output 变化、today preset 与第二次 skipCheck=1 请求断言保留。该探针已能区分原报告的旧 busy 回归与修复，新的同日 before/after 实测结果仍等 Main 提供，不沿用首次采样口径冒充新版对照。

**发现 2（空时序与 G1 起点）静态关闭。** HTTP 新版 176–178 行对所有非 unchanged 场景强制要求 matching，并要求 fromCheckMs/fromWriteMs 都是有限非负值；无法记录目标帧时会失败，不再以 null 正常通过。正式模式在 155–156 行读取 `__refreshTicks` 的本轮实际 tick，并要求位于来源写入之后、status 请求时刻之前；fromCheckMs 以该 tick 为起点，原 HTTP 请求起点另存 fromStatusRequestMs。smoke 保留人工触发口径，未伪造正式 tick；unchanged 仍独立记录，不冒充新增值呈现。

**发现 4（rAF 旧快照）静态关闭。** 两探针都保留原 DOM 变更时间/快照，并在双 rAF 内调用 read() 保存新的 frame 对象；HTTP matching 已使用 `row.frame`，quota 目标也使用 `row.frame.outputText/busy`。因此最终边界不再只给旧 value 贴一个较晚时间。结论仍限 DOM/双 rAF 观测边界，不改称实际物理绘制测量。

**发现 3/5 由 Main 已明确安排的外层恢复与校验闭环承接。** 三个写来源探针内部 Date 恢复和关闭顺序未在此轮全部改写，但 Main 已指定每场不论退出码都调用 raw-decimal 恢复，再执行 check-inputs，覆盖正常退出、失败及 Job 终止后不能依赖 JS finally 的情形。只读确认恢复器直接 `JsonElement.GetDecimal()` 后转 100 ns ticks，先校验目标位于私有目录，截回原长度，并删除已知合成 rollout；没有将 Double 再转 Decimal。`check-inputs.mjs` 对 manifest 全体检查 size，对本次恢复的 Claude/ledger 检查 Node mtimeMs，并在差异非零时断言失败。

该校验器针对本轮已知的 append/truncate/mtime 恢复，不是全来源内容摘要或意外新增文件的通用校验器。原先 source fd1 的核对与最终输入身份记录继续按 Main 方案保留；本卡未执行辅助脚本，也未读取到能独立证明“每场无条件调用”的外层运行记录，后续仅在最终数字审证时核对各场退出码、恢复与校验日志。不因内部 Date 恢复尚存而重复要求修改产品。

本轮结论：两项 P1 验收断言和 rAF 读值修订符合前述具体反例的静态修正要求，未发现此次差异新增阻断项。资源口径与整树运行约束沿用上文；H 长测是否完成、各场数值与新版 quota 同日对照尚不作结论。等待 Main 长测结束后联系再审最终数字。

Not checked: 本轮仅轻量读取和本文件编辑，未启动 Node/npm、测试、浏览器或恢复器；静态收口不等同已执行新版 before/after 或正式 21 周期。

## 2026-10-27 数值与工程证据独立复核附录

**结论：本次所查证据内部一致，未发现新增产品或探针阻断项；可以确认静止同步/all 查询收益、三组变化场景的断言完成，以及新版 quota 受控反例的 busy 修复。不能据此宣布 G1–G8 全面达标。** 普通追加和 ledger-only 的 sync p95 仍高于 G3 候选 3 s；today/month 查询没有收益。quota 外层退出码与正式浏览器最终周期留待 Main 收口。

本次重新核实 cwd，通过 pwsh 轻量读取、JSON 数值计算和 SHA-256 复算审证；未执行已有探针、测试或恢复器，未操作输入。以下统计均用 nearest-rank：排序后第 ceil(p×n) 个值；20 轮 p95 为第 19 个值，没有混入首轮/追赶/预热。

### A/B：原始样本、完整业务内容与统计

- `before-results.json`、`after-results.json` 各 87 条：open、catchup、2 settle、20 unchanged，以及三档各 1 first + 20 warm。after 的 87 条逐标签时间/hash 与非空 `evidence/after-final-run.txt` 一致，未取此前输入身份漂移的 `after-run.txt`。两侧 20 个 unchanged 都 updatedFileCount=0，已记录 warnings 均为空。
- 三档各 21 个 before/after 样本逐标签 hash 全相同，每档内部也只有一个 hash。另以 System.Text.Json 保留原始 JSON 数值、去空白序列化，在内存中仅将 before 的整秒 ISO 字符串补回 `.000Z`：today/month/all 分别恢复 11/11/10 处，三份完整摘要均精确重现原进程 hash；after 原摘要无需修复也得到同一 hash。没有再删除字段或修改证据文件。复算结果为 today `5505a1f4276bb8c5c9794079eb0bd938f1a6fd08a0f6561e29125a00a8926dfc`、month `824bd107469f9b390b404308368760f6a5f884d7c9897d54edecf841ad46bb9d`、all `6ef59cc9701f8e56961bc857284a7bf5899245ba724f986df9236a3faa62efae`。
- 已读 `compare.mjs` 和 `ab.mjs`：业务 hash 仍只预先去除 generatedAt、perf.indexedAt、perf.meta.indexedAt 三个易变字段。before 日期修复受原进程 hash 约束，不是任意归一化后才相等。
- 两侧及 comparison 的 source fingerprint 均为 `fd1f6fd2b1a66ce457926495e3f81ae4f9ffa2d3dee630708c406ed0134bec31`，六张逻辑表计数完全一致：events 135873、source_files 1597、perf_samples 53161、perf_codex_projections 1388、perf_rollout_threads 1394、archive_segments 0。该结论是所列业务摘要/表计数/指纹一致，不扩大成全部数据库字节相等。
- 四类 before/after 的 n、p50、p95、max 均从原始 samples 独立重算，并与 `comparison.json` 精确一致。静止同步 p95 **8133.446 → 2809.868 ms（下降 65.453%）**，max **8206.464 → 3105.676 ms**；all 暖查询 p95 **684.787 → 70.460 ms（下降 89.711%）**，max **698.233 → 71.071 ms**。
- today 暖查询 p95 **480.736 → 504.463 ms（增加 4.936%）**，month **1544.963 → 1679.404 ms（增加 8.702%）**。这两档不能写成改善；以上收益也不能直接换算浏览器整轮提速。

### changed：20×3 正确性与残余同步延迟

`changed-results.json` 共 64 条，4 条准备、3 组各 20 条正式样本；三组标签均完整且无重复，64 条时间/updatedFileCount 与 `evidence/changed-run.txt` 逐条一致。正式样本 sourceWarnings 全空，native/Claude updatedFileCount 全为 1，ledger-only 全为 0；三个 checked 计数均为 20，finishedAt 存在，`execution-admission.json` 记录 changed exitCode=0。

- native-append：p50 **6299.655**、p95 **6887.170**、max **7546.820 ms**。
- ledger-only：p50 **3243.882**、p95 **3352.218**、max **3364.562 ms**。
- Claude-append：p50 **2776.688**、p95 **2909.725**、max **2913.017 ms**。

已核对脚本计数只在全部断言完成后设置：native/Claude 每轮事件 total 精确增加 1,000,107（input 100、output 1,000,007）；ledger 事件 tokens 不变、dirty=0，目标线程有时长的 sampled output 每轮精确增加 1,000,007，并在本轮 sync 后读取。结果 JSON 不保存每次 SQL 读值，正确性证据是已完成计数、日志及已读断言路径，不声称本卡重新查询数据库。

G3 可分组表述为：静止同步和 Claude 追加达到本批候选 p95≤3 s/max≤8 s；native 追加、ledger-only 的 p95 未达到 3 s。这里没有变化场景的同源 before 分布，不能独立计算它们的提速比例。正确性完成和延迟达标应分别报告。

### 新版 quota 同日对照

独立按重读的 `frame` 对象重算，before/after 均无 failure 字段、errors=[]；各有 4 个已记录 HTTP 响应且全部 200，trigger 后确有 busy=true，随后都有一次真实 today/skipCheck=1 请求。结合前附录已查的真实 server 路径，该对照保留了第二请求，而非以替代响应绕过。

两侧 initial total/output 为 0，目标帧 total=1,000,107、output=1,000,007、可见文本 `0.00M → 1.00M`，最终 preset=today、busy=false。before 在首 payload 后有 1 个 busy=false/旧值帧，frameAt=1793030511321，目标 frameAt=1793030511690，差 **369 ms**；after 此类帧 **0**、gap **0 ms**，与两个 JSON 的派生字段完全一致。该受控同日反例支持 quota busy 修复，不据一次对照推算自然生产频率或 G1/G2 分位数；DOM/双 rAF 边界的口径沿用前附录。

`execution-admission.json` 明确保留 quota shellExitCode=1，原因由 Main 说明为外层清理不存在的 Env 变量，两份内部 JSON 已完成且无 failure。当前只接受内部场景断言完成，不将该整场外层写成 exit 0。**待 Main 执行/提供：浏览器结束后的修正外层退出码、无条件 raw-decimal 恢复和 check-inputs 收据。** 本卡不复跑，也不碰输入；changed 的恢复 differences=0 目前是该 admission 对此前工具输出的记录，未升级为本卡独立执行证明。

### 工程门禁与受测身份

- `evidence/full-test.txt` 非空，统计为 **3301 例 / 3274 pass / 25 skipped / 2 fail / 0 cancelled**。两个失败均在 `test/perf-codex-api.test.js`：C2（257 行）和 L1（349 行）；堆栈为 `TypeError: fetch failed` / `cause: bad port`，并非已记录的产品正确性断言失败。
- 非空 `evidence/api-recheck.txt` 包含上述两个完全同名用例，及其余 3 项 API 用例，结果 **5/5 pass、0 fail/skip/cancelled**。因此可报告“两项网络 bad-port 失败已由同名定向复核通过”，不能改写成“全仓原次全绿”或声称又执行了完整全仓。
- `engineering-gates.json` 记录 lint/format exit 0；lint 实际有 **63 warnings / 5 infos**，不称零告警。初次 typecheck exit 2 的 TS2339 已保留；`typecheck-final.json` 给出修正后 exit 0。`typecheck-final.txt` 的 0 bytes 是配套明确退出码的静默成功，不把空文件单独当通过证据。
- `accepted-source.json` 的 57 个源文件摘要与当前文件逐一吻合，usage-store.js 仍为 `2d9df686762addef540a78b505baa325aab216ee8e4bf9d841768006c56e0a27`。在内存中仅撤回该文件新增的 `turn.requests` JSDoc cast（不写文件），SHA-256 精确回到全仓受测身份 `e2e7203d6cd223e8e52f62f8473824569149081dbf01e6160e6beeb711f40cf7`，与 manifest 的 withoutOnlyNewJSDocSHA256 一致；全仓之后不是未注明的 runtime 产品变更。日志中也确有 E-1 外部修订/未提交旁路用例通过记录。
- HTTP/quota 探针摘要仍与前附录和 `probe-source.json` 一致；compare.mjs 为 `7db474444983c2e926a57647679df59ac108a3172495ce45509586306ce554f1`。本轮未发现证据与已审源码新增身份偏离。

### 资源口径与本卡收口

A/B Node maxRSS 分别 **999.480 / 975.559 MiB**，最少系统可用内存 **13.597 / 13.303 GiB**；changed Node maxRSS **868.141 MiB**、最少系统可用 **13.305 GiB**。这些值已从原始结果重算，支持其进程/系统口径，仍不是 Chrome/整个 Job 峰值或 8 GiB 合计预算的独立测量。admission 中 jobMiB=7168、heapMiB=1536、单槽/最多两 tab 是运行约束记录；不能据此填造整树实测峰值、CPU 或长期 WAL 收敛。

正式 21 周期浏览器仍在 Main 测试槽，本次未读取其未完成结果或中断运行。Main 已报告的普通 Codex 8.10 s 超 8 s max，须在最终原始周期中核对并如实纳入；当前不宣布 G1/G2 全达。G2 是否超过实际周期+5 s，应由正式 write→frame 与实际检查周期计算，不从单条 G1 超时直接推定。

审查证据 SHA-256：comparison `f13c1627e9af7c536e9427ae63df1bc2feb52892ada2938ed83fac17fe7e4101`；changed-results `79cb0a5885c413fc7c23bdb2fc738fa61647ebe6c1d568d29350171882793903`；quota-before `7b31539ba19c41bdb52789ff403bab24814e3a26a54f01a1544b654c6f81ecbc`；quota-after `2b54910b427542adb096c57b67644ca423630bd98c8d27a4d8c8fe7968113e1a`。

实际文件列表：仅本 `workers/W4-final.md`。diff 摘要：追加原始 hash/分位数复算、20×3 断言证据、quota 同日帧对照、工程门禁及身份与未完成边界；不更改既有历史记录。关键依赖：Main 的修正外层退出/恢复收据及最终 21 周期结果；当前证据没有要求另加产品变更或重复全仓测试。

Not checked: W4 未启动 Node/npm、测试、基准、浏览器、恢复器或输入校验；仅审已有结果并做只读 JSON/摘要计算。最终浏览器数字和 quota 外层退出闭环待 Main 下一轮收口后再审。

## 2026-10-27 最终浏览器短审收口

**正式浏览器正确性与观测链完成；G1 未达标，G2 有一轮小幅超限，不宣布全面验收通过。** 本次只读最终 JSON、对应日志和既有探针；唯一追加文件仍为本记录，不复跑、不碰输入、不等待新版 quota。

- `browser-final-results.json` finishedAt=`2026-10-26T16:24:44.804Z`，无 failure，errors=[]，probeMode 为真实 60 s 周期。21 个连续且唯一 index 与非空 `browser-final-run.txt` 的 21 条周期记录逐一吻合：1 unchanged、15 token 变化（Claude 7、Codex-new 1、Codex-append 7）、5 ledger。unchanged statusChanged=false/delta=0；20 轮变化 statusChanged 全为 true。
- 15 轮 token 的 delta/expectedDelta 均为 1,000,107，且跨周期目标帧 total 重新相减也逐轮相符，可见 outputText 每轮变化；5 轮 ledger 的 token delta 均为 0，目标帧 timingText 均确有变化，相邻 usage 响应 sampledOutput 每轮精确增加 1,000,007，支持当轮发布计时证据。
- 21 个 checkStartedAt 均出现在唯一的 21 个真实 ticks 中，且位于本轮 writtenAt 与 status requestAt 之间；相邻实际周期 **59987–60013 ms**。20 轮变化均有唯一目标 frame，重新读取的 total/output/timing 非空、busy=false，fromCheck/fromWrite/fromStatusRequest 三个时间均能精确还原同一 frameAt。unchanged 的 7 ms 命中既有值且当时 busy=true，未混入变化轮 G1。
- 观测的 47 个浏览器 API response 全部 HTTP 200，errors 空；预先 HTTP 的 36 个样本、浏览器过滤及周期属于不同口径，不合并计算 G1。
- **G1**：20 轮变化混合统计 p50 **5226**、p95 **8506**、max **8528 ms**；其中 15 轮 token 变化 p50 **8096**、p95/max **8528 ms**。5 轮 ledger p95/max **5389 ms**；Claude 7 轮 p95 **5155 ms**，Codex-append 7 轮 p95 **8528 ms**，Codex-new 单轮 **8506 ms**（单轮不当代表性分位数）。20 轮均超过 3 s，8 轮 Codex 超过 max 8 s；不能写成达标。
- **G2**：20 轮变化 write→目标帧 p95 **63482**、max **65033 ms**。逐轮用本轮 tick 减前一 tick 再加 5000 ms 作阈值，19/20 轮满足；index=1 Claude 为 **65033 > 59992+5000=64992 ms，超 41 ms**。保留该实测超限，不以四舍五入或配置 60 s 替换实际周期。该差距与 G1 的秒级未达标分别报告。
- **资源/WAL**：42 个 30 s 样本跨 **1230.108 s**，Node 采样 RSS **415.684–1240.203 MiB**，进程 maxRSS **1247.781 MiB**，finalRSS **855.020 MiB**，系统最少可用 **13.666 GiB**。CPU 采样窗口累计 user/system 增量 **91.360/25.781 s**。WAL 41 次为 0、1 次 **32992 bytes**，close 前/后均为 0，支持本场有界观察及关闭收敛；不外推任意长期稳定。以上仍是 **Node/采样口径，不是 Chromium 或整个 Job 峰值**，不把 Node maxRSS 当成 8 GiB 合计预算证明。
- **twoTabs**：记录同一 server 的第二 tab 加载与第一 tab 筛选并发完成，两个 join 时间均 **5583 ms**，errors 仍空；两值共用等待结束边界，不能各自当独立页面耗时，也不扩大成并发写入一致性的全面测试。
- **恢复/退出**：已读 `input-identity.json`，checkedAt=`2026-10-26T16:26:22.372Z` 晚于本场 finishedAt，files=**1630**、differences=[]；本卡未运行校验器。browser outer exit 0 依据 Main 本轮明确回报；旧 admission 的 running 状态是较早记录，不据其否定已完成 JSON。新版 quota 干净 wrapper 收据由 Main 另存，本次未等待或重复审其新数值。

最终 JSON SHA-256：`bb091bc177dbbcb2d9639d1a3463143dcee5cf7cb8b06ac79722f80ad965eb79`；HTTP 探针仍为已审 `66684c95b4ce5ea6c2bb947e9eb007aa0da3d9fe84f337afe77641bb709282a8`，未发现本次身份偏离。所查最终证据无新增正确性阻断发现；既有延迟目标差距与资源测量边界如上保留。

本卡关闭：实际只追加 `workers/W4-final.md`；未启动任何测试/浏览器/恢复操作，无新增测试建议或待本卡执行事项。
