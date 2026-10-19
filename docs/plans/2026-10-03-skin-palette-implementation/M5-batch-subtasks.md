# M5：输入、候选批次与选择小卡

原[M5](M5-ten-skin-candidate-batches.md)的十套搜索配方、参数范围、调整权限、批次重点、试点屏障和选择标准全部保留。M5.1—M5.7 为汇总节点，执行者按本文件的小卡实例领取工作；遵守[调度规则](execution-and-subagents.md)，不整包派一个双皮肤批次。

只有 profiles owner 能写 `scripts/skin-palette/profiles.json`。所有其他执行者写运行目录内自己专用的片段、候选、截图或意见。生成/捕获工具、policy、生产 palette 只读；工具 bug 回原模块单独修复，不在配方任务里私改规则。

## M5.1.1 身份来源核对（模板，五个实例）

实例固定为 `chatgpt-grok / claude-mimo / glm-muse / deepseek-kimi / gemini-qwen`；并发人数受调度规则限制，不因为有五个实例就同时开五个 worker。此卡可在 M0 来源/契约明确后做，不等待完整 capture。

只读原 M5.1 首版表、角色源色注释和该两款装饰图；只写 `<run>/profile-proposals/<skinId>.json` 与该实例 handoff。不改 profiles.json。

小块：核对 identityHex 的实际文件/注释/源色组；按原表写完整字段及 rationale；指出浅深共享身份、最近邻区别和输入发生变化之处。首版不自行替换身份锚、不锁旧颜色。

验收：两份完整字段、明确来源和范围；图像确实查看过时注明原图路径，没有视觉能力则该项交给有能力的执行者，不假称已看。完成即交接，不进入求解。

## M5.1.2 十套装配与范围验收

前置：五份 .1 实例完成。唯一 profiles owner 写 profiles.json，读取十份 proposal。

小块：按注册顺序装配；检查十套字段、有限数值、pageL 两模式、原表允许范围、version 起始 1、lockedFields=[]；调用 validateProfiles，并额外核对原 M5.1 的字段/范围，因为当前 validator 通过不证明全部业务范围正确。不得为了补强检查擅改 M0 契约。

验收：十套齐全、不重复、无旧发布款特殊分支；来源核对与差异清单齐备。只检查数据，不启动浏览器，不新增颜色搜索测试。

## M5.1.3 冻结生成输入

前置：.2 通过。owner 保存 `<run>/inputs/profiles-v1.json` 及 `input-manifest.json`，包含完整 profiles 快照/hash、policy/roles/derivation/tool sourceHashes 和原文件出处。实际输出与契约以 M2/M3 的当前接口为准，manifest 是运行元数据，不塞入 Candidate。

验收：实际 SHA-256 一致；使用既有 generate-cli 的 `--profiles <冻结文件>` 能读入同一输入；不把 profiles 草案散落到每个 worker 的私有默认配置。此卡结束后输入冻结，后续 owner 修改必须产生新版本和新快照。

## M5.2—M5.6：每批的调度模板

批次仍为原定两款，不改试点顺序。任务 ID 示例 `M5.2.G.r1`、`M5.2.C.<candidateId>.r1`、`M5.2.V.chatgpt.r1`、`M5.2.B.r1`。r 表示有界轮次，不修改候选 id/hash。任务包明确 batchRun 和输入快照；不同任务的输出不得重叠。

### G：生成一个双皮肤批次

前置：输入冻结，M2/M3 正式检查器通过；试点之后的 G 等待 M5.2.B 和公共工具口径固定。

只调用原命令：`node scripts/skin-palette/generate-cli.mjs --skins <两ID> --seed palette-redesign-v1 --profiles <冻结profiles文件> --out <新的batchRun>`。写入原定 run.json/candidates.json；原文件不覆盖。保留去重/无解/预算失败原因。

这是首轮 G。R 只改一款时，修正轮用同一 CLI 的 `--skins <仅变化ID>` 写新的 repairRun；不重生成、重拍未变的同批皮肤。未变皮肤通过原出处参与 B，当前总集同一 skinId/variant 只保留与当前单皮肤 profileSnapshot 对应的版本，不并列旧新候选冒充增加选项。

验收：可复现摘要、候选完整浅深、a/b/c 起点及去重记录有据；结构校验遵守 M2 存活候选口径。生成结束不宣称 ready；不足目标时交付缺口与失败原因，结束本卡，不随即调色或捕获。

### C.<candidateId>：一个候选的浅深捕获

前置：G 产物、M4 完整工具通过；协调者分配全局浏览器名额。只运行一次既有 review-cli capture，传固定 run、ID、全新 outDir；最多这一候选的两模式。

小块：核对输入/hash；捕获、即时保存证据；关闭 context/server/自有 fixture；产自己的 index 登记分片。owner 合并总 index，子 agent 不共同写总文件。

验收：M4 矩阵的状态/图片/几何/错误记录及出处齐备；缺测或硬失败明确保留。`captured` 表示捕获流程完成，不等于阅读通过。一个失败状态只允许 M4 已规定的新上下文一次复跑；同一候选不能派多个 agent 重试到绿。不修配方、不修测量器、不处理另外五个候选。

### V.<skinId>：一款皮肤的视觉初筛

前置：该皮肤一轮 C 证据完成；一次最多三组成对候选。只读固定原尺寸截图与记录，写 `<batchRun>/visual-parts/<skinId>.json`，不碰另一视觉 worker 的文件。

小块：逐候选按 M3.4 当前八项视觉要求记录原图依据；核对浅深共同身份、材质与该批重点；给代理推荐/限制，原图没有查看的候选为 pending。明显 hard fail 可停止其扩展视觉工作但保留原因，不能给它选项地位。

验收：每份意见准确绑定候选/hash/原图、八项都有意见或明确缺项；不填正式用户 choices，不因代理喜欢而豁免阅读失败。

### B：一次批次结算

前置：本轮 G/C/V 完成或各自明确缺项。由协调者或指定 batch owner 合并登记和视觉分片、在原 batch 上下文调用 assess、生成报告。

只写该 batch 的 captures-index/visual-review/assessments/report 与 handoff。验收每皮肤 2—3 ready、原 M5 批次区别重点、重复/缺测/失败原因。数量不足时交付 NEEDS_REVIEW/明确阻塞，不把该卡变为“持续调色直到两组成功”。试点结算额外记录生成/捕获耗时和工具可靠性，作为其余批次启动屏障。

### R.<skinId>：按需发出的局部配方修正

这是新的任务包，不是 G/C/V/B 内部循环。一次一款：执行者提交旧值、新值、失败角色/视觉依据、原 M5.1 权限内的幅度和预计解决什么问题；只写 proposal。profiles owner 核对后 version++ 并产生新冻结输入，随后另发 G/C/V/B。

试点最多初轮加修正轮共两轮；其他批次每皮肤最多一轮局部修正，按原 M5 约束。超范围、身份源变化、工具公共规则冲突交协调者处理；无新增依据时不自动第三轮。旧 evidence 和旧 choices 保留，不能转绑新 candidate。

## 批次并行的明确屏障

1. M5.1.1 的来源核对可有限并行，.2/.3 串行。
2. M5.2 试点先完成一轮结算，工具口径固定后，M5.3—M5.6 的 G 可在独立 run 里并行；每批不共写 profiles。
3. C 默认全局串行，达到资源条件才最多两个；可与另一批的 V 或来源整理并行，不能只靠各进程的预览计数自称全局受限。
4. V 按 skinId 独立写；B 与 profiles owner/总索引 owner 的变更必须串行。
5. 配方仅某皮肤变化时核对其 profileSnapshot，不机械废弃其他未变皮肤；公共 source/policy/roles/derivation 变化仍按真实依赖重测。

## M5.7.1 兼容性审计与总候选集

前置：五批已结算。唯一总集 owner 读取明确列出的 batchRun，不按时间找目录。

小块：核对 profileSnapshot 与当前单皮肤配方、policy/roles/derivation 和相关工具版本；保留 candidate 的原 token/id/hash；固定注册顺序、变体顺序和唯一 ID；计算新的总 candidateSetHash，保存原 batch 哈希/路径。

验收：结构有效，十套均有目标数量的真实存活候选或明确缺口；不因去重只剩两份而伪造第三份。此卡不重新捕获、不决定用户选择。

## M5.7.2 总证据索引与评审容器

前置：.1；唯一 owner 写总 captures-index、assessment-origins、assessments。

按 M4.4.1/.2 已冻结接口验证原批次评审及当前相容性，再计算新总 assessmentHash。批次 profiles 子集摘要与十套总摘要不同，保留原 batch 上下文；不能修改原 recordedInputHashes/sourceHashes 冒充总集捕获。若接口不能证明合法复用，明确 CONTRACT_CONFLICT 交原工具 owner，不伪填摘要或全量重拍掩盖冲突。

验收：每个总候选都能追到原文件/hash/原图及 current compatibility；总离线 verify 可复现；失败/缺测仍在报告中。

## M5.7.3 整体视觉对照

前置：.2；两个只读子任务分别看十套 light 网格和 dark 网格，不各自重复全部浅深评审。已有逐皮肤八项意见复用，整体检查只找最近邻过近、材质不一致及网格差异。

整体检查之前，owner 调用既有 M3 `diagnoseIdentity({candidates: 总集候选})` 重算十套最近邻，保存绑定当前总 candidateSetHash 的 `overall-diagnostics.json`，供两位 reviewer 与总报告使用。不能沿用只比较两款的原批次最近邻。整体诊断不改写原 assessments/sourceHashes，不影响阅读 readiness；报告可并列显示原批次与整体诊断并注明比较范围。

各写自己的整体意见分片，parent 合成同尺度报告、每皮肤区别点/推荐/第二选项。必要修正一次最多两款，重新发独立 R/G/C/V/B；本卡不内置无限反复。验收原图证据与现行总集匹配，不把“推荐”写成“已选择”。

## M5.7.4 用户反馈与待选清单

前置：报告可用。只处理用户实际反馈或明确代选授权，保存日期/原话、候选对应和 pending 清单。没有回复时交付 pending 并结束当前工作，不让 subagent 假设最推荐就是用户同意。

局部微调返回 R 实例，十套选择未齐不能进入 M6。原图、数学检查不要求用户自己补 HEX。

## M5.7.5 完整选择封存

前置：用户实际决定齐全、现行证据 ready 且未过期。唯一 selections owner 写完整 selections.json，十套 ID、候选浅深配对、candidateHash、总集/总评审 hash 和 decisionSource 均准确。

验收：M0 校验与 `review-cli verify --require-selections` 通过；choice 不引用 draft、旧候选或 incomplete。M5.7 父节点只有此卡完成且前四项无缺口才为 DONE。无真实选择时保持 pending，正式色源仍只读。
