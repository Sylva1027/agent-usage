# TPS 计量修订执行账本

2026-10-21。主审维护。A/B/C 实现及三路接线已完成专项复核；原六轮真实历史临时索引/API/页面验收通过。最终全仓 2,792/3/20，失败均在皮肤浏览器两个用例（包含父用例失败计数），正式切换未执行。当前完整结论见[整合记录](review/final-integration/README.md)。

规格：[计量修订](../../plans/2026-10-21-tps-measurement-correction-plan.md)；分工：[三 worker 执行单](../../plans/2026-10-21-tps-measurement-parallel-execution.md)；接口：[timing-contract-1](contract.md)；调查：[R0 证据](../2026-10-21-tps-scope-audit/README.md)。

## 当前任务

- A0：PASS_SCOPED。owner [TPS-worker-A](codex://threads/01a15a06-0712-7fb2-bddd-6d2c7cf6be0d)。补充源码解释 plugin account 无 retry 回调、Chat 路由排除 Anthropic 重试、非 Mantle。接受针对本批 326 行的窄范围证据；不以浮动插件 `@latest` 冒充版本 pin，不推广到未来插件/provider。六轮复算 133.9112 tok/s 不等于当前生产已修复。[A 报告](A/A-report.md)。
- A2：来源说明返工 PASS_WITH_LIMITS。OpenCode 补充安装版本事件赋值与产品统计区间，并恢复原日历归属；ZCode 改为包含关系未知；WorkBuddy 补充当前 Chat adapter 输出映射。DSH/ZCode 仍不能认证统一排名；WorkBuddy 持久化冲突已由 C2 修复。
- A1：PASS_SCOPED。纯规范化与有界导出、export→离线 import→sync 合成接缝已主审；缺独立已审 origin 参数时拒绝、显式已审批次导入成功、homeId 与产品发现一致。最终全仓这些回归通过；主审另只对原已审六轮再次关联真实计时，不推广范围。
- B0/B1/B2：PASS_SCOPED。owner [TPS-worker-B](codex://threads/01a15a06-21e8-79f3-929d-6c934d62d926)。六轮 key/日期/n/总时长/pooled 与单条缺计时不回退经实际 builder 验证；方法升级、旧版本与未知范围不排名、诊断统计保留已通过。保留并行 Claude 接入，具体范围见整合记录。[B 报告](B/B-report.md)。
- C0/C1：PASS。多 home 部分发布的版本问题已修，实际成功消费 dirty 的事务递增 publication sequence，索引使用已提交序号；双向失败、重复失败、重开、恢复与无关来源更新均有回归。主审独立五文件 **229/229 通过**、typecheck 通过。已释放 C2，先做 WorkBuddy 持久化异值冲突，再与 B2 联调版本兼容和三路一致性。[C 报告](C/C-report.md)。
- C2 WorkBuddy：PASS_SCOPED。正常 trace 增量、冲突持久化、版本与稳定性依赖、初始多 home 防串用、legacy 单→多撤出/多→单恢复均已通过。主审独立四文件 126/126、三项 C2 memory/API parity 3/3 与 typecheck 通过。
- C3 tps-v2 测试接线：PASS_SCOPED。正式 timing import→普通 sync→关库重开→API、缺单请求整轮无分母、ZCode 保留统计但不排名，以及现有 index/projection/parity 回归经主审五文件 **153/153 通过**，typecheck 通过。C 的本轮实现卡完成；不代表 A/B 总审、全仓与生产验收完成。
- typecheck、lint、format 和空白检查通过；lint 仍有 56 warnings、4 infos。最终全仓未通过，真实服务/索引未切换；不得将专项通过写成已上线。
- 原六轮真实历史已在临时索引/HTTP/页面显示 133.9 tok/s、p10 62.3、p90 148.2、n=6；326 请求输出和完整时长对应。不是旧 v1、UI/G4 或 R0 调查替代本轮验收。

最终整合进度（2026-10-21）：七文件纯格式、A 的 DSH/OpenCode 旧版本断言、B 的 summary 旧语义、C 的 W1/W3 隔离参数及 timing 准备均已修复。原 missing-request API 全仓失败没有原始断言详情，后两轮全仓通过，根因不冒称已确认。完整日志、两项皮肤失败、临时历史恢复和下一步正式切换边界见[最终整合记录](review/final-integration/README.md)。不再重复全仓碰运气。

派发校验：三个 `send_message_to_thread` 均成功；同次 `wait_threads(timeoutMs=0)` 返回三者 active/inProgress 且均已有执行命令。任务已开始，不等于第 0 卡已完成或通过。

## 共享文件与基线

[开工前基线](review/baseline/manifest.json)保存分工范围内已有源码/测试内容的 SHA-256 与副本；它包含用户已有未提交实现，不是需要清理的脏文件。A/B/C 只能写本人文件范围和本人报告目录，公共计划/contract/账本由主审维护。

主审接到交付后记录：受测文件版本、证据结论、复核命令/结果、释放哪一张下一卡。相同失败第二次必须转为具体边界诊断，禁止无限重跑同一数据和重复 handoff。

## 主审首轮复核

`node --test test/perf-request-timing-kernel.test.js test/perf-request-timing-store.test.js`：22/22 通过。独立执行 A 的 `verify-fixture.mjs`：exit 0，六轮、326 请求、233379 tokens、1742789 ms，算术通过不等于 producer 认证通过。

C 的反例：内存 SQLite 连续导入同一 home/response，先关联 A 再关联 B；两次均返回 changed，revision 从 1 升至 2，第二次仅返回 B；随后查 A 抛 `REQUEST_TIMING_STORE_CORRUPT`。无需真实来源扫描即可复现。

后续取消例行哈希要求，历史基线保留备查，不要求 worker 重算或重写历史。主审主动收取阶段交付并给出下一步，不再让用户传递状态。本轮未运行全仓测试或操作真实服务/索引。

## 主审第二轮复核

主动收取三名 worker 的完成状态、滚动报告、A0/A2 来源摘录，并检查实际 reader 改动、B 六轮集成和 C 事务内关联检查/新增回归。

- 独立运行七个受影响测试文件：`perf-request-timing-kernel`、`perf-request-timing-store`、`perf-dsh`、`perf-opencode`、`perf-zcode`、`perf-workbuddy`、`workbuddy-usage`：**182/182 通过**。
- `npm run typecheck`：exit 1。B 内核第 89 行 number+unknown；C lookup 第 325/339/347/350 行 helper 的 state 推断为 string。已分别派回文件所有者修正，不用 any 掩盖，不增加运行时兼容分支。
- A0 已补足两条已知隐藏重试和 Mantle 路径的窄范围解释；上游 raw 链接本轮抓取不可用，主审依据留存源码摘录审查，未独立重取完整 producer 源树。接受范围仅本批历史记录，不构成所有插件的认证。
- A2 的 ZCode 推断不成立：reasoning 独立列出仍可能是 output 子集，等式不足以决定是否叠加；须追写入映射，否则改为未知。OpenCode 须证明 streamed 结束事件并避免顺带改变日历筛选。已给 A 一次有界核查要求，不重扫同一来源。

下一步三人实际任务已发出：A 修上述证明并实现 A1；B 修类型并做 B1；C 修类型并做 C1 隔离接线。共享全局版本待主审整合后统一切换。本轮未跑全仓、未改 UI、未重启服务、未操作真实索引。

## 主审第三轮复核

- 收取三人最新完成状态并查实际代码：A1/A2、B1 已交；C1 没有交，C 的最终回复只剩 echo test，主审不将 idle/completed 状态当作任务完成。
- 独立运行十个受影响测试文件：上一轮七个加 `perf-request-timing`、`perf-codex`、`perf-projection-planner`，**237/237 通过**。B 的 native 候选调用链、C0 事务关联检查均已审查。
- 初跑 `npm run typecheck`：A 新模块有 13 处 unknown 属性访问错误，B/C 旧错误已消失。主审直接给 A 模块加精确类型收窄与已验证完成时间标注；随后 A1 测试 **9/9 通过**，typecheck exit 0，五个本轮核心模块 Biome 检查 exit 0。
- A 的 ZCode 错误推断已撤回；OpenCode 日历时间恢复 completed/created，只改变请求时长；WorkBuddy 包内 Chat completion 映射补上当前安装范围说明。来源认证限制保留，不重新扫描同一数据。
- C1 已明确恢复：正式 import 入口从 native ledger 推导唯一身份，导入+dirty 标记原子提交，sync 成功发布才清 dirty，revision 参与性能索引，隔离库证明迁移/重复/回滚/重建与用量费用不变。A1/B1 已在工作区，不再以等待接口为由停工。
- A 继续显式导出工具的合成验证，B 补真实 thread builder 六轮集成；不提前改全局版本或真实库。

开发工作区仍处于整合中：没有 lookup 的生产调用会产生缺时长候选，C1 和 B2 未齐，不应重启现有服务试图获得修复结果。本轮未跑全仓、未做真实 API→DOM 或正式切换。

## 主审第四轮复核

三名 worker 的本轮产物均已收齐。已查 exporter、import CLI、native 关联、dirty 提交/清理、索引版本和 memory lookup 转发的实际代码。

- `npm run typecheck`：exit 0。
- 普通沙箱定向检查有三个 perf-state 临时 SQLite 改名 EPERM；权限可用环境下补跑包含 Codex index/usage store 的十二文件集合，**352/352 通过，0 跳过**。C 留存的改名限制也在此集合覆盖，不能再当作待用户解决的阻塞。
- 主审确定性反例：复用 C1 import folds 测试，在已有 revision1 成功发布后，导入 revision2，注入 dirty 清除失败；失败 sync 后断言 `perf_index_version === publishedVersion`，实际失败。原因是 dirty 时传 0 参与新索引计算，不是保留最后发布版本。诊断仅运行一项，临时副本已删除，未改正式测试。
- 原 exporter 明确产出未认证候选，但 import CLI 原样读取 records，UsageStore 只校验形状/native 身份，尚无 producer 已审边界。contract 已固定本批独立 reviewedOrigins 参数，不能从输入自报认证；C 负责实现，A 负责跨工具验证。
- B2 已释放：升级统计方法、旧候选隔离、未知口径不进统一排名，沿用 pooled/轮级分位，保持 UI。C 先交两处 C1 精确修复再进入 C2 WorkBuddy 冲突；A 做合成导出→导入整链，不重扫真实数据。

本轮没有跑全仓、真实来源导入或页面验收，没有重启/迁移真实服务与索引。全局方法与来源准入联调完成前不宣称上线。

## C1 专项再次复核

- 已检查正式代码和回归：连续两次失败保持旧索引版本、恢复后推进；缺 reviewedOrigins、origin 不匹配及 JSON 自报 certified 拒绝；CLI 拒绝发生在库创建前。这两处返工通过。
- 主审权限可用环境独立运行 timing store、Codex index、perf store、projection store、usage store 五文件，**226/226 通过，0 跳过**；`npm run typecheck` exit 0。此前沙箱 rename EPERM 不再作为未解决的验收阻塞。
- 新确定性反例：同一 store 两个 Codex home，先都导入/发布 1000ms，再都导入异值 2000ms；只让 B thread 的 dirty 清理触发失败。sync 后 A 候选已改为冲突（duration=null）且 dirty 清空，B 仍 dirty，`perf_index_version` 却未改变。主审独立诊断一项失败，临时副本已清理。原实现的全库 dirty 门与单个最后覆盖 revision 无法表达部分成功发布。
- C 仅返工此边界：性能版本纳入与实际成功消费 dirty 同事务提交的发布序号；无变化/全部失败不推进，部分成功推进，重复失败稳定，恢复再推进。覆盖两个 home 方向、重开、恢复及无关来源更新；不引入逐响应多层版本状态机。C2 暂缓至该条通过。

本次只审核 C，未重新评判 A/B；未跑全仓、未动真实索引或服务。

## C1 最终专项复核：PASS

主审已查 `usage-store.js` 成功发布事务：只有实际清除 timing dirty 行才递增 `perf_request_timing_publication_seq`，与候选、指纹、dirty 清理同一次提交；失败回滚不推进。索引使用该已提交序号，不再被其他 home 的未发布证据冻结。

正式回归已覆盖 A 成功/B 失败及反向、重复失败/no-op 版本稳定、关库重开、失败方恢复后再推进、timing 受阻时其他来源 fingerprint 仍可更新。来源批次准入和旧的同 home 失败保版本回归继续保留。

主审权限可用环境独立运行五个受影响文件（timing store、Codex index、perf store、projection store、usage store）：**229/229 通过，0 跳过**；`npm run typecheck` exit 0。C1 通过，C2 已派发并要求先完成 WorkBuddy 持久冲突闭环；这不代表整个 TPS 方案或生产上线通过。本轮未跑全仓、未操作真实来源/索引/服务。

## C2 WorkBuddy 首轮主审：NEEDS_REWORK

已收取 C 的 schema19 与 observation 实现，查 store trace 预扫/lookup、memory 读取和正式测试。独立运行 WorkBuddy store + timing store **38/38 通过**，两项定向 memory/API parity **2/2 通过**，`npm run typecheck` exit 0；这些绿灯没有覆盖正常增量更新。

1. 主审移除 C2 异值冲突测试里的 `forceWorkbuddyReparse(store)` 后运行相同用例，失败：正常 sync 后只有 800ms observation，新增 850ms 未被读取。`refreshWorkbuddyDurations` 位于 `if (!needsRefresh) continue` 后，session 未变时 trace 预扫根本不执行。旧样本继续有效，初次缺时长后 trace 晚到同样受影响。
2. 主审构造 main/extra 两个 WorkBuddy home 的相同 messageId，均无新 observation，只在旧无 home 表存一条 700ms；正常 sync 发布两条不同 home 的 700ms 样本。断言歧义归属不得采样失败（实际 2）。新表的 home 主键没有阻止 legacy fallback 串用。
3. memory 新增 trace 读取，但性能文件集合/指纹依旧只覆盖 session；候选输入变化可能不改变 indexVersion，读取中 trace 变化也可能被宣称稳定。需将实际计时输入纳入性能版本和稳定性依赖，同时复用采集结果，不能增加不必要的全目录重复扫描。

两个诊断副本均已删除，正式测试未被主审修改。已给 C 正常 sync 无 force、trace-only 新值/冲突、重复/删除/重开、home 归属和版本同步变化的具体回归要求。旧数据保留，未证明归属不得任选 home。

权限可用的较宽组合还暴露并行新增 Claude 后 sourceKinds 固定数组断言过期及排名联调断言，不能把这些或上述 C2 逻辑问题统称 sandbox 噪声。本轮不处理别的 worker 文件，不改真实来源/库/服务，不运行全仓。

## C2 trace 依赖返工复核

收到 C 主动交付后，已检查 trace 预扫位置、目标 session 定位、locator 失败后恢复、memory/store 计时输入依赖，以及旧值兜底规则。此前的三处缺口已修：不需要人工 force 重解析；trace 变化参与版本与读取稳定性；初始多 home 不借用无归属旧值。读 trace 成功但 session 定位失败时保留本 home 重试标记；trace 删除保留 observation 与冲突，版本仍反映输入集合变化。

主审独立运行六文件（WorkBuddy store/usage/perf、timing store、perf store、projection store）：**149/149 通过**；三项 C2 memory/API parity **3/3 通过**；`npm run typecheck` exit 0。

新增正常配置变化反例：单 home 无 trace/observation，旧表一行 messageId/700，首次 sync 发布一个样本；新增第二 home 的相同 messageId 后普通 sync，多 home 门已禁止新 legacy 采样，但旧 main 样本未被重建撤出，实际仍 1 条，预期 0。临时诊断副本已清理。额外 memory 的不可读 trace 降级检查通过，不作为问题退回。

C 仅修剩余 legacy 作用域变化依赖：单→多撤出、多→单按现有规则恢复、重复同步稳定、重开一致；只影响依赖旧值兜底的会话，不触碰已归属 observation、其他来源或旧记录。本轮不重评 A/B、不跑全仓、不操作真实来源/库/服务。

## C2 WorkBuddy 最终专项复核：PASS_SCOPED

已检查正式 mode meta、作用域切换目标定位和两项新增回归。单→多只重建缺 home-owned observation 的 legacy 候选；多→单定位旧值对应会话恢复；模式参与性能指纹，重复 sync 与关库重开稳定，已归属 observation 不受影响。旧表保留，定位失败沿用本 home 置脏重试。

主审权限可用环境独立运行 `workbuddy-store`、`perf-store`、`perf-projection-store`、`perf-request-timing-store`：**126/126 通过**；`perf-summary-parity` 与 `perf-server` 中 C2 WorkBuddy 定向：**3/3 通过**；`npm run typecheck` exit 0。此前 scope 切换失败闭合，不再要求重复该专项。

释放 C2 剩余集成：消费 B2 实际 tps-v2 实现，修复 API fixture 缺已审 timing 与旧 item-span 断言，验证旧候选重建及 memory/store/API 一致性。`rankedHomeIds` 既有契约是未受阻 home 集合，不可仅凭名称当作逐行排名认证或擅自改义；逐行以公共 rank 准入为准。最终全仓与生产验收仍由主审执行，本次未操作真实来源、库或服务。

## C3 tps-v2 测试接线主审：PASS_SCOPED

已核对 `perf-codex-api` 正式 UsageStore 导入路径及 fixture 的独立 `reviewedOrigins` 参数：先普通 sync 取得 native 身份，导入后普通 sync 消费 dirty，再关库由 server 重开；没有直接伪造 API 结果。缺 `response-25-2` 时 turn 候选分母为 NULL，API n=24、pooled=111.5，与其余轮级分位吻合，没有 item span 兜底。完整输入五入口及冻结样本断言保留；ZCode 的 group/model 统计仍在，rank 为 null。

主审独立在权限可用环境运行 `perf-codex-api`、`perf-server`、`perf-codex-index`、`perf-projection-store`、`perf-summary-parity`，**153/153 通过，exit 0**；`npm run typecheck` exit 0。已查旧投影方法版本重开重建及重复 sync 的现有正式回归。C3 通过，不再要求 C 重复该集合或重写报告；剩余 A/B 总审、最终工程与真实页面验收由主审整合，未操作真实用户源/库/服务。


## 正式部署收尾

2026-10-21 正式 3765 服务已切换至 schema19/tps-v2，原六轮 326 条审核计时已导入；API→DOM 平均 133.9、P10 62.3、P90 148.2、n=6 一致。在线库备份与独立旧程序回滚烟测通过。皮肤门禁定向 19/19；最终全仓收尾见 [主审记录](review/final-integration/README.md#2026-10-21-正式切换与皮肤门禁收尾主审)。不动并行任务内容，不扩大历史认证范围。

最终全仓 2,796 通过、0 失败、20 跳过；独立旧版 HTTP API 回滚烟测 200/tps-v1。正式服务已上线，原六轮真实验收通过。
