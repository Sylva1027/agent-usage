# 当前状态（2026-10-20）

M5.7及M6前两步完成；[第3步](M6-step3.md)自动验收 **10/10，900/900**，关键几何 **120/120**，十套浅深共20图视觉复查完成，无该范围must-fix；classic、picker 51/51、在线冻结浅深各16/16均通过。[本轮最终记录](../integration/m62-reaccept-20261020/final-assessments.json)自动技术pass、整体incomplete，当前 **AWAITING_MANUAL_SCALE**。目标机真实OS缩放/browser zoom仍缺证据；最终全仓工程门禁未跑，不宣称M6整体完成或可发布。

## 历史状态（截至 2026-10-14）

D8u14 已由主管限定范围接受。D8u15 指定截图边界组仍为 `NEEDS_REVIEW`：首次运行 23 项（15 个顶层用例、8 个子用例）11 通过/12 失败；按授权只适配 `quality.test.js` 的一个共享模拟器构造器后复跑，8 通过/15 失败/0 跳过。复跑指出模拟输入节点缺少 `getBoundingClientRect`，导致截图异常断言被提前的几何错误遮蔽。生产源码未改；已按卡停止，不进行第三次运行。详见 [D8u15 handoff](M5.2.C-D8u15-screenshot-regression.md) 和 [evidence index](../integration/m52-c-d8u15-screenshot-regression/evidence-index.json)。

主管限定接受 D8u5-F1（57 项证据一致，独立关键断言 2/2）。D8u6-F2 已完成并交 SKIN (5) 复核，状态 `NEEDS_REVIEW`：[交接](M5.2.C-D8u6-F2-measurement-shims.md)、[摘要](../integration/m52-c-d8u6-f2-measurement-shims/summary.json)、[证据索引](../integration/m52-c-d8u6-f2-measurement-shims/evidence-index.json)。六个测试包装器已补齐 evaluate 第二参数；离线回归和 E1c/E1d 通过。修正后定向运行 14 tests，7 pass / 7 fail / 0 skipped，失败集中在 D2b3 和 M3.2 的内联声明/style 属性恢复断言。D2b3 历史 22 项证据摘要一致；生产测量实现未改，等待复核，不启动下一卡。

主管已限定接受 [D8u5-F1](M5.2.C-D8u5-F1-supervisor-review.md)：57 项索引一致、四文件 diff 合规、关键断言 2/2。16 个目标断言均到达，分次按文件合并为 297 tests、278 pass、0 fail、19 skipped；一项 S0 junction 断言通过后因 Windows `EPERM` 跳过文件 symlink 分支，不宣称单次四文件或全仓通过。

SKIN-worker (5) 已完成 D8u4 初始整批验证，状态 `NEEDS_REVIEW`：[交接](M5.2.C-D8u4-regression-gates.md)、[summary](../integration/m52-c-d8u4-regression-gates/summary.json)、[failure-summary](../integration/m52-c-d8u4-regression-gates/failure-summary.json)。1902 tests：1851 pass / 33 fail / 18 既有 EPERM skip；typecheck、skins:check 通过，lint/format 配置发现失败。六类问题包含范围外业务/配置与未闭合根因，按卡交回；本批 11 文件摘要未变，无修复或第二轮全量。等待 SKIN (5) 复核，不启动后续任务。

主管最新：D8u3B4分类磁盘/state绑定ACCEPTED，独立16/16、四SHA一致。授权 [D8u4-regression-gates](dispatch/M5.2.C-D8u4-regression-gates.md)：一次文件串行全量测试+四门禁、限5类同源回归修复；允许既有测试资源，不额外业务capture/生成/M6。所有日志原始留存，不清零历史缺口。下方为历史记录。

最新主管结论仍为 D8u3B3 新产物身份适配 ACCEPTED（独立 5/5、五 SHA 一致）。随后 D8u3B4 分类读取器磁盘头与 S8 proof 绑定已完成，当前 `NEEDS_REVIEW`、等待 SKIN (5) 复核：[交接](M5.2.C-D8u3B4-classification-evidence.md)、[verification](../integration/m52-c-d8u3b4-classification-evidence/verification.json)、[evidence-index](../integration/m52-c-d8u3b4-classification-evidence/evidence-index.json)。定向离线回归 16/16、无跳过；未做 browser/service、真实 capture、生成或 M6。下方为历史记录。

主管最新：D8u3B2正式verifier消费ACCEPTED，独立12/12、八SHA一致。随后授权 [D8u3B3-production-identity](dispatch/M5.2.C-D8u3B3-production-identity.md)，实现及离线 writer→reader 回归已完成，当前 `NEEDS_REVIEW`：[交接](M5.2.C-D8u3B3-review.md)、[verification](../integration/m52-c-d8u3b3-production-identity/verification.json)、[evidence-index](../integration/m52-c-d8u3b3-production-identity/evidence-index.json)。5/5、无跳过；正式低层身份与读取器契约保持不变。分类 reader 磁盘/state 绑定随后由 D8u3B4 接线并待复核；未做实机捕获、生成或 M6。下方为历史记录。

已完成 [D8u3B3-production-identity](M5.2.C-D8u3B3-review.md)，状态 `NEEDS_REVIEW`：S0、普通状态与 timeline checks writer 现在按当前捕获身份校验并规范新正式证据；实际 writer 产物通过严格 production reader，候选 writer 保留候选 ID。定向离线回归 5/5、0 跳过，含低层 official marker 与 S8 fixture proof。详见 [verification](../integration/m52-c-d8u3b3-production-identity/verification.json) 和 [evidence-index](../integration/m52-c-d8u3b3-production-identity/evidence-index.json)。等待 SKIN (5) 复核；其后的 D8u3B4 已补齐分类 reader 的磁盘/state 绑定并待复核；没有启动浏览器/服务、完整捕获、生成或 M6。

此前 [D8u3B2-verifier-bindings](M5.2.C-D8u3B2-verifier-bindings.md) 已由主管限定接受：正式 verifier 复用磁盘头部检查并把注册的 S8 要求传给共享状态 reader；缺绑定为候选级阻断缺口，错误头明确返回 invalid。生产 context 只传播头部缺绑定。按名回归 12/12、0 跳过；6 个纳入 Biome 的文件零诊断，7 文件 `node --check` 通过。详见 [verification](../integration/m52-c-d8u3b2-verifier-bindings/verification.json) 与 [evidence-index](../integration/m52-c-d8u3b2-verifier-bindings/evidence-index.json)。

主管已将 [D8u3B1-state-proof](M5.2.C-D8u3B1-state-proof.md) 限定接受：实际 `readCapturedUnitEvidence` 加重算树摘要反例，独立 6/6、3 SHA 一致。随后授权 [D8u3B2-verifier-bindings](dispatch/M5.2.C-D8u3B2-verifier-bindings.md)：正式 verifier 复用共享头部检查与实际离线链，production context 缺 map 阻断；分类 reader 文件接线另卡，不实机/生成/M6。

此前主管结论：D8u3A兼容更正后ACCEPTED，独立12/12、四SHA及真实旧S8回放incomplete核验。随后授权 [D8u3B1-state-proof](dispatch/M5.2.C-D8u3B1-state-proof.md)：共享状态读回fixtureRequirement语义与实际IO反例；正式verifier头部/分类reader下一卡，不实机/生成/M6。下方为历史记录。

主管最新：D8u2B双fixture所有权/生产透传ACCEPTED，独立10/10、5SHA一致。授权 [D8u3A-review-headers](dispatch/M5.2.C-D8u3A-review-headers.md)：共享候选/production摘要的固定头部前置；缺历史绑定保持incomplete，错绑定拒绝，逐状态/正式verifier另卡。不真实捕获/生成/M6。下方为历史记录。

主管最新：D8u2A头部更正后限定ACCEPTED，独立14/14、4SHA一致。授权 [D8u2B-fixture-owner](dispatch/M5.2.C-D8u2B-fixture-owner.md)：runReviewCapture双fixture创建/关闭及生产wrapper透传，同卡纯回归；reader/verifier另卡，不启动实机/生成/M6。下方为历史记录。

主管最新：D8u1固定契约ACCEPTED，独立6/6纯测试、3SHA一致。授权 [D8u2A-matrix-routing](dispatch/M5.2.C-D8u2A-matrix-routing.md)：底层两preview/上下文实际路由、map/resume与清理同卡纯回归；owner两fixture及consumer另卡，不启动实机/生成/M6。下方为历史记录。

主管最新：D8t（含 descriptor 日期更正）已 ACCEPTED；D8u1 固定 fixture 映射纯函数与定向测试已完成，当前 `NEEDS_REVIEW`：[交接](M5.2.C-D8u1-fixture-contract.md)、[验证](../integration/m52-c-d8u1-fixture-contract/verification.json)、[证据索引](../integration/m52-c-d8u1-fixture-contract/evidence-index.json)。6/6 定向测试、两文件语法与 Biome 检查通过；SOURCE_FILES 仍 23 项。没有启动双 preview/runner/reader/CLI、浏览器、真实捕获、候选生成、D8u2/D8u3 或 M6。下方 D8t 记录保留历史过程状态。

D8t 历史结算记录（后经日期更正并 ACCEPTED）：冻结 T4 的 142 条原始 gap 与 D4 数量一致；正式评审目前不能拼接 base 与 S8 variant fixture，因而先授权 D8u 固定双 fixture 接线。账本与更正记录见 [D8t handoff](M5.2.C-D8t-gap-settlement.md)、[逐项账本](../integration/m52-c-d8t-gap-settlement/gap-ledger.json) 与 [S8 接线结论](../integration/m52-c-d8t-gap-settlement/integration-findings.json)。

主管最新：D8s13新取证器一次真实Edge归属/关闭验收ACCEPTED，3附件已独立核验，不再重复取证排障。授权 [D8t-gap-settlement](dispatch/M5.2.C-D8t-gap-settlement.md)：只读结算原142缺口及S8双fixture正式评审接线，选择下一组；不捕获/调色/生成/M6。历史失败证据不回填。下方为历史记录。

主管最新：D8s13 一次获批的 Edge 生命周期验证已完成，状态 `NEEDS_REVIEW`：[交接](M5.2.C-D8s13-resource-approved.md)、[原始结果](../integration/m52-c-d8s13-resource-approved/result.json)、[证据索引](../integration/m52-c-d8s13-resource-approved/evidence-index.json)。直接通过 `require_escalated` 查询并核实 22 条 baseline 后仅 launch 一次；取得 PID 3708 的 live root proof（runner parent、runtime executable、profile flag、CreationDate 均吻合）。page/context/browser 关闭成功，关闭后 8 个本次跟踪 PID 均确认不存在；没有浏览产品页面，M6 未启动。D8s11 历史失败仍保留。下方为历史记录。

D8s12 查询错误传播与离线回归已由主管限定范围接受 `ACCEPTED`：[交接](M5.2.C-D8s12-query-errors.md)、[自检结果](../integration/m52-c-d8s12-query-errors/self-check.json)、[证据索引](../integration/m52-c-d8s12-query-errors/evidence-index.json)。旧版 stderr/空 stdout 被误判为零进程的行为已复现；新版严格拒绝查询与记录错误，baseline 失败不安装 timer，运行时失败保持 unknown 且可恢复。node --check、scoped Biome 与独立自检通过。下方为历史记录。

主管最新：D8s11 一次 Edge 生命周期实证已完成，状态 `NEEDS_REVIEW`：[交接](M5.2.C-D8s11-resource-live.md)、[执行 JSON](../integration/m52-c-d8s11-resource-live/result.json)、[证据索引](../integration/m52-c-d8s11-resource-live/evidence-index.json)。唯一 launch 创建过 Edge PID 45312，但 Playwright 在返回 Browser 前失败；两个 sampler stop 均未见进程或 root proof。普通权限 CIM 查询被拒，sampler 的 0 baseline 不能独立证明查询完整；关闭后的获批精确 PID 查询确认 45312 已不存在。没有重试 launch。D8s10 限定采样器修复已接受；D8s9 历史 root 缺口、dark FAIL 与 D8s6 恢复原因仍保留，M6 未启动。

D8s10 限定采样器修复与离线回归已由主管复核 `ACCEPTED`：[复核](M5.2.C-D8s10-review.md)、[交接](M5.2.C-D8s10-resource-proof.md)、[自检结果](../integration/m52-c-d8s10-resource-proof/self-check.json)。旧 D8s9 实现丢失归属的失败已重现，新采样器行为通过；此接受不补写 D8s9 历史 root proof。

D8s10 开工前的 D8s9 前置复核：[复核结论](M5.2.C-D8s9-review.md)确认 25 附件/23 来源一致，观察器纯自检独立通过；light 7.7027 PASS、dark 2.5553 FAIL，严格恢复通过。Edge 根进程归属证据不完整，整卡仍 NEEDS_REVIEW；该历史证据未由 D8s10 改写。

主管最新：D8s8 限定诊断 ACCEPTED（18 附件/23 来源一致，本次 light 恢复通过；旧 D8s6 根因未解决）。授权 [D8s9-warning-paired](dispatch/M5.2.C-D8s9-warning-paired.md)：新 runner 按生成源码修正转义引号匹配并纯自检，然后一次 ChatGPT 浅深 S8 联合复验；不改生产代码，不人工循环或启动 M6。见主管 D8s8-review。下方为历史记录。

主管已接受 D8s7、D8s8 的限定范围（各自交接保留当时状态）。D8s9 的唯一一次 ChatGPT/light+dark/S8 捕获完成，today-hidden 阶段快照已补齐；light warning 为 7.7027:1 PASS，dark 为 2.5553:1 FAIL，且存在 Edge 根进程归属未核实 finding。当前 `NEEDS_REVIEW`，详见 [D8s9 交接](M5.2.C-D8s9-warning-paired.md)、[诊断摘要](../integration/m52-c-d8s9-warning-paired/diagnosis.json) 和 [证据索引](../integration/m52-c-d8s9-warning-paired/evidence-index.json)。D8s6 旧恢复失败仍未解释，配色审美与完整矩阵仍未验收。下方为历史记录。

主管最新：D8s7 已完成 S8 today 异步就绪等待与延迟渲染回归，状态 `NEEDS_REVIEW`：[交接](M5.2.C-D8s7-warning-ready.md)、[离线核验](../integration/m52-c-d8s7-warning-ready/verification.json)。四项筛选纯测试、contracts 48/48、scoped Biome 与语法检查通过。交接如实记录一次误跑整份 preview 测试并启动 D8h Chromium 测试的范围偏差；后续未重跑浏览器。D8s6 失败证据及 light 恢复问题保持原样，配色仍未验收。下方为历史记录。

主管最新：D8s6 已完成唯一获准的真实浅深 S8 捕获，状态 `NEEDS_REVIEW`：[交接](M5.2.C-D8s6-warning-live.md)、[证据索引](../integration/m52-c-d8s6-warning-live/evidence-index.json)。Light 原始记录为 7.7027:1，但严格内联恢复门禁失败；dark 两次自动尝试均超时且没有测量。资源清理与 23 项来源摘要核验通过。配色尚未验收通过，不把 variant 当作 base 正式证据。D8s5 的限定接线验收不变。下方为历史记录。

已接受：[D8s5-warning-state](M5.2.C-D8s5-warning-state.md) 的限定状态接线、fixture 身份前置与离线回归；真实 DOM/浅深可读性和审美仍不在其验收范围内。

已接受：[D8s4-source-binding](M5.2.C-D8s4-source-binding.md) 将 `timeline-utils.js` 纳入评审与捕获正式来源：18/23 项，18 个限定回归通过。旧 22 项证据保持未改写并按缺源处理；捕获元数据运行时断言尚未做浏览器执行。角色/DOM 视觉、局部捕获、矩阵与 M6 均未验收。下方为历史记录。

已接受：[D8s3-warning-fixture](M5.2.C-D8s3-warning-fixture.md) 的固定变体身份、真实 API 导入与 summary 告警链（57/57）。D8s4 随后闭合了 `timeline-utils.js` 正式来源绑定；D8s3 本身不证明浏览器/DOM 可见性或 M6。

已接受：D8s1 来源摘要/三种 summary 及 D8s2 上限修复、边界回归和三条输入重算。D8s4 将正式捕获来源从 22 项扩为 23 项；旧 22 项历史证据不迁移，缺少 timeline 摘要时保持 incomplete。warning DOM 可见性及 M6 未验。见 [D8s2 handoff](M5.2.C-D8s2-cap.md) 与 [D8s4 handoff](M5.2.C-D8s4-source-binding.md)。

主管最新：D8r2执行、覆盖与严格恢复已限定范围 ACCEPTED；light 3.1361:1 PASS，dark 2.0880:1 FAIL 仍保留。D8s1 离线实测完成、待复核：[交接](M5.2.C-D8s1-warning-data.md)、[结果](../integration/m52-c-d8s1-warning-data/evidence/result.json)。实测确认 1860-01 可触发真实 warning，1860-03 是 2,000 行边界，1860-02 会返回 2,001 行但无 warning。没有改源码/共享 fixture，也没有运行浏览器、DOM renderer 或 M6。

历史记录：D8r1-R1 非测量 S0/light 基准已限定范围 ACCEPTED。D8r2 固定 custom 日期下 ChatGPT `badge.record` 浅深各一次实测：light 3.1361:1、dark 2.0880:1（阈值 3:1）；两模式均 12/12 覆盖且恢复通过。主管接受的是执行、覆盖与恢复，dark 颜色仍为 FAIL。见 [D8r2 handoff](M5.2.C-D8r2-badge-live.md) 与 [执行记录](../integration/m52-c-d8r2-badge-live/result-r1/run.json)。矩阵/M6 与整体审美验收未运行。

D8r1 首次执行因 JSON 转义路径校验未命中而在入口前停止（captureBaseline 0 次）；该原始尝试仍保留。R1 修正本地字节归一化后完成唯一一次 ChatGPT/light S0 捕获，已由主管限定范围 ACCEPTED（[D8r1-R1 handoff](M5.2.C-D8r1-R1-fixture-bytes.md)）。

D8q2 S0 接线已由主管限定范围 `ACCEPTED`（独立 23/23 与四摘要一致）；D8q1 measure 接线也已接受（82/82、两摘要及 capture 冻结核对通过）。

D8r1 首次捕获前阻断记录仍在 [原始 D8r1 handoff](M5.2.C-D8r1-s0-live.md) 和 [首次 run.json](../integration/m52-c-d8r1-s0-live/result-r1/run.json)。R1 捕获的默认“今日”空数据首屏仅作为非测量基准，经主管限定范围 ACCEPTED；它没有评估角色可读性。D8r2 后续已完成固定日期的徽标浅深采样，结果见 [D8r2 handoff](M5.2.C-D8r2-badge-live.md)。

D8p/R2 独立 helper 的限定范围已由主管接受。D8r1-R1 验证的是默认 S0/light 截图入口与资源恢复，不包含角色测量、颜色可读性或审美评审；D8r2 后续补做徽标 dark 测量，但矩阵/M6 与整体审美评审仍未运行。

D8p-R1主管独立四摘要/PNG解码：纯色828像素及两侧混合色确认transform抗锯齿，R1失败保留，helper未验收。已派[D8p-R2](dispatch/M5.2.C-D8p-R2-native-marker.md)原生整数marker两独立场景，限定冻结源码，不接线/M6。

历史验收：D8p-R2 原生整数 marker 的正常返回与截图后注入异常两个 Edge 场景均完成；两张 PNG 解码得到 1905×2600、marker `(258,1710,37×23)`/851 像素。Buffer 与原异常身份、立即/三帧恢复、context 与 Edge 清理均通过；主管已接受限定范围。详见 [D8p-R2 handoff](M5.2.C-D8p-R2-native-marker.md) 和 [run.json](../integration/m52-c-d8p-r2-native-marker/result-r2/run.json)。

历史复核与派发：主管第一轮D8p复核确认六摘要和独立33/33通过，原始Buffer/恢复及清理留档一致；R1 的 fractional transform 对齐触发抗锯齿，像素 oracle 未通过且按停点未执行异常场景。随后派发[D8p-R2](dispatch/M5.2.C-D8p-R2-native-marker.md)使用原生整数 marker 完成两场景验证，冻结源码，不接线/M6。首次复核背景见 [D8p handoff](M5.2.C-D8p-atomic-fullpage.md)。

主管已核对D8o五摘要与六时点：临时保护下main/徽标未移动，finally原几何/style恢复；旧中间clientWidth门禁失败保留。已派[D8p](dispatch/M5.2.C-D8p-atomic-fullpage.md)原子整页截图helper限定实现/静态像素验证，暂不接线，真实恢复仍未验收。不采用分段截图方案。

主管复核停点：D8o 中间根宽度变化留档，但 main/徽标稳定且 finally 完整恢复；主管指出中间 clientWidth 门禁过严，外层返回/抛错前恢复门禁不放宽。D8p 新增原子 helper 与纯 Node 回归，唯一一次 Edge 正常上下文的恢复与尺寸检查通过；PNG 标记断言把 fractional x=257.59375 错按 floor 计算，导致 1px/1px 的边界误报，异常上下文按停点未运行。D8p 保持 `NEEDS_REVIEW`，未接调用点。详见 [D8p handoff](M5.2.C-D8p-atomic-fullpage.md) 与 [run.json](../integration/m52-c-d8p-atomic-fullpage/result-r1/run.json)。

D8p 正常上下文原生 PNG 解码结果为 1905×2600，匹配拍摄前文档尺寸；helper 返回同一 Buffer，style 属性、滚动和全部几何在返回及三帧后均还原。marker rect x=257.59375、宽37，实际纯色像素 x=258、宽37；runner 用 floor 生成 x=257、宽38，故本次无法完成 marker 像素门禁。它不是已证实的截图内容偏移，但第二条截图异常 finally 路径尚无真实 Edge 证据。定向 32/32、Biome、语法检查通过；来源与清理稳定。

D8l 静态诊断证据已由主管限定范围 ACCEPTED：两 context、两截图、零 measure；fullPage 持续横移，viewport 稳定。D8m 正式 token 会话 style 属性恢复实现已 ACCEPTED（独立23/23）。D8n 在静态页证实一次 fullPage 截图后重应用同尺寸 viewport 未恢复几何；未改生产代码。详见 [D8m handoff](M5.2.C-D8m-style-restore.md) 与 [D8n handoff](M5.2.C-D8n-viewport-restore.md)。

主管已实查 D8k 证据；其浅色徽标 12/12 测得 3.136:1，但外层恢复仍失败，状态 `NEEDS_REVIEW`。D8l 的限定静态诊断已接受为执行/诊断证据，不证明 Chromium 根因或生产页面改变；详见 [D8l handoff](M5.2.C-D8l-screenshot-control.md) 和 [原始结果](../integration/m52-c-d8l-screenshot-control/result-r1/run.json)。

D8m 更新后的捕获来源摘要：`browser-measure.mjs` `12a5857468e9bb2096acc2d5a22956cb18c4d8c5ed5805d12c209fe47001b2b7`；此改动使绑定旧摘要的捕获证据过期。当前 app.js/i18n.js 摘要变化单独记录，不追认页面来源。D8m 交回时尚无下一卡授权；后续 D8n 已按单独授权执行，当前仍无下一卡授权。

D8n 只读调用路径显示三个整页截图共用 capture.mjs 的 page；最小建议落点是在 browser-measure.mjs 共享整页截图/几何核验 helper，统一承接其两次截图和 S0 基准截图。基于这次精确 15px gutter 变化，只建议后续独立验证 `scrollbar-gutter: stable`，本卡未试、未实现。D8n 来源前后稳定；相对 D8l 的额外来源还变化 `src/usage-core.js`，也只记录。详见 [D8n handoff](M5.2.C-D8n-viewport-restore.md)。

D8k 官方 ChatGPT/light `badge.record` 的 3.1361:1 与 12/12 覆盖仍保留，但严格外层恢复断言失败；D8l 是对截图触发几何变化的独立静态诊断，不会追认 D8k 恢复通过或颜色审美通过。详见 [D8k handoff](M5.2.C-D8k-offset-probe.md)。

主管已接受 D8j 限定接线与纯 Node 回归（独立 21/21、六摘要一致）；真实恢复与颜色不在其接受范围。D8k 已按授权完成，暂无下一张卡授权；不重跑、不启动 dark/矩阵/M6。D8i 继续作为旧接线下的历史阻断记录。

当前结论：D8k 的测量器内部恢复诊断未发现 style/rect/canvas/scroll 差异，整页像素一致；外层严格快照比较仍捕获布局位移与 `inlineStyle`（`null`→空字符串）差异。full-page 截图前后 viewport 内可用宽度从 1905 变为 1920，12 个徽标 x 同步移动 7.5px。该证据仅定位到调用边界，不确定根因。D8k 结果与全部时点见 [单元 JSON](../integration/m52-c-d8k-offset-probe/result-r1/light/metric-record-visible/unit.json)。

D8i 保持 `NEEDS_REVIEW`：light 通过日期/ready/API 核验，但测量器返回 `unmeasured`，12 个徽标测量后 x 坐标统一偏移 7.5px，恢复断言失败，按卡片停止且未启动 dark。无对比度或审美结论。详见 [D8i handoff](M5.2.C-D8i-badge-live.md) 与 [verification](../integration/m52-c-d8i-badge-live/verification.json)。

最新复核：D8g因主管示例嵌套:has非法，日期零动作/测量零调用；阻断留档/7摘要及清理ACCEPTED。D8e接线验收重新打开，已派D8h-ready-fix最小修正与静态Chromium原生语法/布尔回归。无配色结论、不M6。下方历史快照。

最新主管结论：D8f2含R1限定实现ACCEPTED，独立21/21及两摘要通过，隐藏点分类修正成立。已派D8g-badge-live只做浅深圆点真实核心/恢复验证，真实比值待证据、不M6。下方历史快照。

当前进度：D8f1-shadow 限定实现已由主管 ACCEPTED。D8f2-core R1 已修复隐藏零尺寸徽标被误记缺测的问题；定向纯 Node 21/21，当前状态仍为 `NEEDS_REVIEW`，等待主管复核。纯 Node 结果不代表真实圆点对比度或审美通过。

D8e 必要圆点角色/状态接线已 ACCEPTED；D8f1-shadow 光晕隔离/精确恢复也已 ACCEPTED。D8f2-core 只为 `badge.record` 增加中央 3×3 核心取样，普通 surface 仍取完整内容框；结果待主管复核。详见 [M5.2.C-D8f2-core](M5.2.C-D8f2-core.md)。

D8f2-core R1 定向纯 Node **21/21**，Biome 与语法检查通过；隐藏零尺寸徽标分类为 not-rendered，可见 8×8 仍记 unmeasured；D8e 冻结文件 3/3 不变。没有运行浏览器、捕获或全量质量套件；真实圆点对比度仍待单独验证。详见 [M5.2.C-D8f2-core](M5.2.C-D8f2-core.md)。

D8d-badge-data 已用隔离 fixture 和 UsageStore 真实验证 custom 日期范围；返回 `totalTokens` 日纪录 `2026-10-01 / 54,800`，同范围的周冠军 `2026-09-28 / 183,000` 因日→周优先级未被返回。`all` 摘要不含 records，前端也强制隐藏 all 徽标。22 项源码、4 项额外源码及 fixture 摘要稳定，SQLite/fixture 清理通过；主管接受的是数据前置，不代表徽标显示或可读性已验收。详见 [M5.2.C-D8d-badge-data](M5.2.C-D8d-badge-data.md)。

D8c-sort 的执行/覆盖/恢复/来源与清理证据已由主管接受；两种箭头颜色仍低于 4.5:1。D8b-sort 状态接线也已接受。D8e 形态映射、D8f1 光晕隔离已接受；D8f2 圆点核心采样含 R1 修订待复核。D8s5 的告警角色与 S8 身份接线待复核，variant 的真实局部捕获仍未开始。

D8c-sort 官方 ChatGPT light/dark 的真实比值分别为 2.0172:1、2.1106:1，均低于 4.5:1；每模式 1 measured、0 unmeasured、7 个隐藏箭头逐个记为 `notRendered`。排序恢复、清理及 22 项来源核验通过，执行证据已接受；颜色 fail 保留。详见 [M5.2.C-D8c-sort](M5.2.C-D8c-sort.md)。

D8a-R1 历史只读补查（D8e 实现前）：确认 badge 实际是 7×7 无文字圆点，而当时角色仍登记为文字/4.5；现有 surface 测量隔离未移除 glow，无法据此宣称可信比值。自然周 183,000 只是静态事件总和，recordsForRange 实际 unit/value 当时未验证。D8d 后续补齐了数据前置；D8e 接线现待复核。见 badge-shape-r1.md。

最新主管结论：D7e 16 文件摘要、22 当前源码、两套比值与四节点五点命中、一次测量/清理证据通过，执行及覆盖 ACCEPTED；浅深配色仍 fail。D8a 24 条原始缺测的计数/checks 对账完成；R1 补查进一步确认 badge 同时存在默认隐藏和图形契约/测量缺口，sort 仍是状态动作问题，warning 仍缺超长范围 fixture。D8a 保持 NEEDS_REVIEW，没有回写 T4 历史数据或启动实现。下方历史快照。

最新主管结论：D7d 限定接线 `ACCEPTED`，contracts 42/42、preview 定向 5/5 与五文件摘要通过。D7e 已完成官方 ChatGPT 闭层上行浅深两单元实测：两模式各 2/2 节点测得、0 缺测，但均低于阈值而 fail；清理与来源核验通过，当前 `NEEDS_REVIEW` 交主管复核。下方较早进度为历史快照。

最新主管结论：D7c 六单元执行/证据 `ACCEPTED`，五项旧官方配色 fail 保留。D7d 闭弹层状态接线已 `ACCEPTED`。D7e 的官方 ChatGPT 上行浅深两单元已完成真实测量：各 2/2 节点测得、无缺测，但比值 4.1446:1 和 3.7651:1 均为 fail；清理与 22 项来源核验通过。D7e 保持 `NEEDS_REVIEW`，配色仍未通过。

最新主管复核：D7b、D7d 的限定接线范围已接受。D7c 六单元执行/证据已 `ACCEPTED`，五项 fail、一项 pass 的配色结果不变。D7e 真实闭层复测现有两个结果均为 fail，节点覆盖 2/2、0 缺测，恢复与清理通过，状态 `NEEDS_REVIEW` 等待本轮复核。审美评选、历史 gap 关闭及 M6 仍未完成。

此节记录 M5.2 当前进度；下方较早阶段描述及 2026-10-05 索引是历史快照，不能据其旧状态推断当前进度。细节以各卡最新交接为准。后续摘要中 D7c 的 `NEEDS_REVIEW` 字样指向主管复核前版本；执行与证据留存已接受，五项 fail 仍保留。

历史进度快照（截至 D7c，2026-10-12）：M5.2-T2/T3/T4 工具快照与 E1a–E1d 已按限定范围验收。G.t4-r1 已用原 v1 配方和固定 seed 对 ChatGPT/Grok 真实生成一次：CLI exit 0，5 个候选、1 个近重复拒绝；五个保留候选的颜色值与 T2 对应组合相同，但新 ID/hash 不同，旧评审不迁移。ChatGPT a 的 T4 浅深矩阵仍为 failed（60/62 captured、2 unreachable、2 errors、142 gaps）；D4 归因已由主管接受。D5a 的浅色溢出色有限数值验证、29% 修复与回归已按限定范围接受。D5b 的 model/cost 两视图局部新色证据已按限定范围接受：均观察到 `#167E52` 和同色图例，最差可测绘制均为 3.8446:1；cost 恢复截图尺寸差异另留。D6a–D6b3 已接受；D6b4 的有限 L 形双窄带采样实现已接受。D6b5 真实 cost 视图诊断仍为 `NEEDS_REVIEW`：`#A5ABB4` 对 `#D7E1F0` 两臂均为 1.7523:1（阈值 3，fail）；`chart.timeline-segment` 局部记录为 3.8446:1（pass），新色与图例均出现。D6c 的 30 组离线数值、85% 最小共享比例及 bootstrap 一致性已由主管限定范围 `ACCEPTED`；旧捕获评审不迁移。D6d 当前官方 ChatGPT light/cost 单视图真实诊断已完成并保持 `NEEDS_REVIEW`：轴线 `#67598F` 对 `#A9B4DD` 最差 3.01549:1（2/2，pass）；timeline segment 最差 2.47799:1（12/12，fail）。r1 测量前脚本转换错误留档，r2 为唯一实际测量；22 项源码与额外 pricing 摘要前后稳定，无浏览器错误或外部请求，资源清理完成。真实候选、完整矩阵和审美验收仍未做，M6 尚未启动。D7a 只读归因和 D7b 状态接线均已由主管按限定范围接受。D7c 当前官方 ChatGPT 三状态浅深六项实测为五 fail、一 pass：上行 light 4.1446:1、dark 3.7651:1（各有一节点被日历遮挡并记为 unmeasured）；下行 light 4.6732:1、dark 3.1981:1；同日 light 3.3151:1、dark 3.5243:1。六项恢复成功，22 项源及计价摘要稳定，Edge/预览/fixture 均清理；主管已接受执行与证据留存，五项失败保留。D7d 接线已交复核，D7e 真实闭层复测待执行。历史 18 条 gap 和审美仍未验收，M6 尚未启动。

D7a（2026-10-12）只读对账 18 条 T4 gap，已由主管限定范围接受；结论见 [M5.2.C-D7a](M5.2.C-D7a.md)。D7b、D7d 固定状态接线均已由主管限定范围接受。D7c 执行与证据留存已接受，五项失败仍在。D7e 真实闭层两单元已完成，等待复核；两项均 fail、无节点缺测。

- [M5.2.C-D8s5-warning-state](M5.2.C-D8s5-warning-state.md)：`warning.timeline-range` 独立状态、S8 和 fixture 身份前置；限定离线回归通过，状态 `NEEDS_REVIEW`，未做真实捕获。
- [M5.2.C-D8s12-query-errors](M5.2.C-D8s12-query-errors.md)：CIM 适配器错误传播、显式空数组与损坏输出拒绝、baseline/runtime 失败状态，以及 D8s10 proof 回归；离线自检、`node --check`、scoped Biome 通过，状态 `NEEDS_REVIEW`。
- [M5.2.C-D8s13-resource-approved](M5.2.C-D8s13-resource-approved.md)：D8s12 实际查询适配器经一次 `require_escalated` 获批的 headless 空白页生命周期验证；取得 live root 与 CreationDate，关闭后 8 个跟踪 PID 均确认 absent，限定证据状态 `NEEDS_REVIEW`。
- [M5.2.C-D8s11-resource-live](M5.2.C-D8s11-resource-live.md)：唯一 headless Edge launch 在 Playwright 返回 Browser 前失败；未取得 live root proof。失败日志中的 PID 45312 经获批 Win32_Process 查询确认已不存在；不重试，状态 `NEEDS_REVIEW`。
- [M5.2.C-D8s10-resource-proof](M5.2.C-D8s10-resource-proof.md)：新运行目录采样器保留历史 root proof 与最后观察，并区分缺字段和 PID/executable/创建时间矛盾；旧失败先复现、新实现离线回归通过，限定范围 `ACCEPTED`，未运行浏览器。
- [M5.2.C-D8b-sort](M5.2.C-D8b-sort.md)：`indicator.sort` 独立状态及 S5 接线，纯 Node 回归通过；接线范围已由主管接受，实际浅深测量与箭头恢复见 D8c-sort。
- [M5.2.C-D8c-sort](M5.2.C-D8c-sort.md)：官方 ChatGPT 浅深排序箭头真实测量与状态恢复；两模式均低于 4.5:1 阈值，恢复/清理和来源核验通过，`NEEDS_REVIEW`。
- [M5.2.C-D8d-badge-data](M5.2.C-D8d-badge-data.md)：UsageStore 对固定 custom 日期范围真实返回 `day / 2026-10-01 / 54,800`；`week / 2026-09-28 / 183,000` 是完整周期冠军但因日优先级没有被返回。确认 `all` 隐藏规则与数据存在不同；无浏览器徽标验收，`NEEDS_REVIEW`。
- [M5.2-T2](M5.2-T2.md)：66 项工具原字节快照和 input-manifest-v2，状态 `ACCEPTED`。
- [M5.2-T3](M5.2-T3.md)：接入已接受的测量隔离工具和质量专项变更，重冻同 66 项源并建立 input-manifest-v3；仅两项测量文件变化，11 个生成源与既有五候选绑定不变，状态 `ACCEPTED`。
- [M5.2.G.t2-r1](M5.2.G.t2-r1.md)：新工具 epoch 的 ChatGPT/Grok 试点生成，候选集五项，状态 `ACCEPTED`。
- [M5.2.C.chatgpt-a-t2-r1](M5.2.C.chatgpt-a-t2-r1.md)：单候选浅深矩阵；捕获执行记录已复核 ACCEPTED，候选仍 failed。完整捕获和原始命令记录见该卡 integration 目录。
- [M5.2.C.chatgpt-a-t3-r1](M5.2.C.chatgpt-a-t3-r1.md)：修复后同候选唯一一次真实复验；CLI failed，旧 20 项 DOM 失败逐项对照与资源/恢复证据已留档，状态 `NEEDS_REVIEW`，等待主管复核。
- [M5.2.C.chatgpt-a-t4-r1](M5.2.C.chatgpt-a-t4-r1.md)：roles v3/T4 新候选唯一一次默认浅深矩阵捕获；60/62 captured、2 quota-toast unreachable，CLI exit 2（2 个 chart.timeline-segment 错误、142 gaps）。输入值与 placeholder selector/目标实测通过；整体仍 failed，6 个像素差异未归因，状态 `NEEDS_REVIEW`，等待主管复核。
- [M5.2.C-D4](M5.2.C-D4.md)：只读归因 T4 的两个 timeline 低对比失败和 142 gaps；gap 分类对账、checkbox/空 placeholder 覆盖债务及恢复像素差异单列。主管已接受该归因及披露的样本输出偏差；候选仍 failed。
- [M5.2.C-D5a](M5.2.C-D5a.md)：五个实际候选的 `--ceramic-well` 派生背景、整数/小数 hue 有限扫描、浅色 overflow 29% 共享修复与 app-render 回归；主管按限定范围 `ACCEPTED`，不迁移 T4 旧捕获。
- [M5.2.C-D5b](M5.2.C-D5b.md)：ChatGPT a/light/dense-data 的 model 与 cost 单视图真实局部测量；主管只接受两视图的新色接线与执行留档。每个视图均观察到 `#167E52` 绘制和同色图例，最差可测比值 3.8446:1；一条无坐标路径型 `stroke()` 仍使角色 `unmeasured`，cost 恢复截图尺寸差异也留档，整角色/候选没有通过。
- [M5.2.C-D6a](M5.2.C-D6a.md)：只读调查 `chart.timeline-segment` 的唯一 Canvas `stroke()` 是否为轴线，列出保存证据缺口与可检验的最小修复边界；只读结论已由主管接受，无源码修改或浏览器重测。
- [M5.2.C-D6b1](M5.2.C-D6b1.md)：为 observer 绘制记录添加实例内事件序号与 `lineWidth`，并将白名单身份字段保留到 `evidence.skipped`；定向 2/2、scoped Biome、语法检查通过，主管已复核 `ACCEPTED`。仍不证明路径/角色归属，缺测规则不变。
- [M5.2.C-D6b2](M5.2.C-D6b2.md)：轴线真实 `moveTo`/`lineTo` 复用三点几何并仅在轴线 stroke 临时标记身份；observer 严格校验并复制身份快照，缺测判断不变。定向 3/3、四文件 Biome 与两文件语法检查通过，主管已复核 `ACCEPTED`。
- [M5.2.C-D6b3](M5.2.C-D6b3.md)：登记 `chart.axis-line` 必要 graphic 角色并双向绑定 `dashboard-default`/`dense-data`，roles/policy 版本升为 4；只按已校验三点身份将轴线从数据段覆盖中分离，轴线采样另由 D6b4 处理。contracts 39/39、质量定向 4/4、五文件 Biome 与两文件语法检查通过，主管已复核本卡限定范围 `ACCEPTED`；T4 roles v3 摘要过期，不迁移历史结论。
- [M5.2.C-D6b4](M5.2.C-D6b4.md)：仅对已标记正向 L 形、平移+正均匀缩放、有限正线宽的轴线分开扫描垂直/水平窄带，取两臂最差；其余几何、观察失败、混合合成、缺臂样本仍缺测，单臂低对比优先 fail。定向质量 6/6、scoped Biome 和语法检查通过，主管已接受本卡有限实现范围；真实候选实际轴线对比度由 D6b5 单视图诊断记录。
- [M5.2.C-D6b5](M5.2.C-D6b5.md)：一次真实 ChatGPT a/light/dense-data/cost 视图双角色测量，旧候选只作历史 token 样本。`chart.axis-line` 两窄带均测得，`#A5ABB4` 对 `#D7E1F0` 为 1.7523:1、阈值 3，`fail`；`chart.timeline-segment` 12/12、3.8446:1，局部 `pass`，`#167E52` 与图例均实见。Edge/fixture/预览清理闭合；恢复截图尺寸差异留档。状态 `NEEDS_REVIEW`，不代表当前候选或完整皮肤通过。
- [M5.2.C-D6c](M5.2.C-D6c.md)：共享 `--chart-line` 从 35% 调为最低通过值 85%；5 个 T4 候选浅深与 10 套当前官方皮肤浅深共 30 组，84% 最差 2.9652:1、85% 最差 3.0155:1。逐组验证其它 19 个声明不变，默认 emitter 同步 bootstrap 的 20 个值；37/37、9/9、质量定向 2/2、`skins:check` 通过。复核后将 ChatGPT a 历史浅深 token 内联到单测，移除对候选批次文件的依赖；主管已接受限定派生/数值/生成物一致性范围。旧评审未迁移。
- [M5.2.C-D6d](M5.2.C-D6d.md)：当前官方 ChatGPT light/cost 单视图局部诊断已完成，状态 `NEEDS_REVIEW`。轴线 3.01549:1（2/2，pass）；timeline segment 2.47799:1（12/12，fail）；r1 脚本失败和 r2 唯一测量均留档，详见交接。
- [M5.2.C-D7a](M5.2.C-D7a.md)：只读对账 T4 原 CLI 的 18 条 required-role-missing（趋势 up/down 16、calendar same-day 2）。根因是状态范围不会生成目标 DOM，selector 与固定 fixture 均可用；主管接受该限定归因，真实颜色比值仍待后续测量。
- [M5.2.C-D7b](M5.2.C-D7b.md)：up 绑定固定 `calendar-range`，down 和同日范围各有独立 catalog 状态并进入 S2；状态数 27、矩阵 33 单元/模式、roles/policy 版本 5。契约 41/41、预览纯 Node 定向 5/5、scoped Biome 与语法检查通过。主管已接受限定接线范围；D7b 本身未运行浏览器，后续真实六单元测量见 D7c，历史 18 条 gap 不回写。
- [M5.2.C-D7c](M5.2.C-D7c.md)：当前官方 ChatGPT `candidate:null` 的三个日期状态浅深六项 Edge 定向实测，五项 fail、一项 pass；开日历时第二个上行趋势值被遮挡并在节点级证据中记为 unmeasured。主管接受执行与证据留存，五项 fail 保留；未改生产代码/颜色，不追认历史 gap。
- [M5.2.C-D7d](M5.2.C-D7d.md)：新增闭弹层 `comparison-trend-up` 并从 `calendar-range` 移出 `summary.trend-up`；roles/policy 版本 6，目录 28 状态、矩阵每模式 34 单元。contracts 42/42、preview 定向 5/5、五文件 scoped Biome 与四文件语法检查通过；主管已接受限定接线范围。真实闭层测量见 D7e。
- [M5.2.C-D7e](M5.2.C-D7e.md)：官方 ChatGPT `candidate:null` 的 `comparison-trend-up` × light/dark 各实测一次；两模式均 2 measured/0 unmeasured、两节点五点命中全通过；比值 4.1446:1 与 3.7651:1 均低于 4.5 阈值而 fail。恢复、清理、无外部请求及 22 项源码摘要前后核验通过；D7e `NEEDS_REVIEW`，详细摘要见 [verification.json](../integration/m52-c-d7e/verification.json)，原图与尝试记录在同目录。
- [M5.2.C-D8a](M5.2.C-D8a.md)：T4 三角色 24 条缺测只读对账，各 8 条，逐条指针见 [result.json](../integration/m52-c-d8a/result.json)。R1 补查实际 badge 为 7×7 圆点而目录仍声明文字/4.5；按 policy 推导应分类为必要 graphic/3，但现有 surface 隔离留下 glow，需另卡补测量能力。183,000 自然周数值只是静态求和，recordsForRange 返回值未实测；上一轮两个只读 subagent 并行分工已记入交接。D8a 保持 NEEDS_REVIEW，补证据见 [badge-shape-r1.md](../integration/m52-c-d8a/badge-shape-r1.md)，不追写历史 T4。
- [M5.2.C-D3](M5.2.C-D3.md)：T3 输入文字/placeholder 目标与五状态契约只读核对；checkbox 误测和背景节点污染已由证据复现，下一实现卡建议为 E1；状态 `NEEDS_REVIEW`，未启动实现。
- [M5.2.C-E1a](M5.2.C-E1a.md)：输入角色按状态登记精确 selector、role/state 镜像、ROLES_VERSION 3 与窄目录校验；主管复核 `ACCEPTED`。历史候选摘要与捕获保留不动。
- [M5.2.C-E1b](M5.2.C-E1b.md)：测量器消费状态 selector；输入值/placeholder 按节点判定适用性，缺测附脱敏身份，维持 fail 优先和恢复/身份重试。定向单测 13/13，scoped Biome 与 `node --check` 通过；限定实现范围已由主管接受。
- [M5.2.C-E1c](M5.2.C-E1c.md)：真实 Edge 五状态 × 浅深输入回归与 D2b3 R2 独立空值参考；主管接受范围限于输入状态接线与真实专项，整页恢复和 R2 浅色 import 差异单独跟踪，状态 `ACCEPTED`。
- [M5.2.C-E1d](M5.2.C-E1d.md)：聚光伪元素有限 opacity transition 的有界等待与整页基准稳定性；真实 Edge 证据、最终 quality 129/129、contracts 37/37、Biome 和语法检查通过，主管已复核 `ACCEPTED`。
- [M5.2-T4](M5.2-T4.md)：冻结 roles v3 与测量修复后的同 66 项新基线，更新 input-manifest-v4；66/66 原字节及绑定复核通过，主管已接受。
- [M5.2.G.t4-r1](M5.2.G.t4-r1.md)：使用固定 profiles-v1 与 seed 对 ChatGPT/Grok 做一次真实生成；5 个候选、1 个重复拒绝，当前契约/哈希核验通过，状态 `NEEDS_REVIEW`。ChatGPT a 的新 epoch 捕获结果见 [M5.2.C.chatgpt-a-t4-r1](M5.2.C.chatgpt-a-t4-r1.md)。
- [M5.2.C-D1](M5.2.C-D1.md)：四类 DOM 文字失败的 8 样本只读诊断；现有证据支持测量失真，不支持盲目调色；主管复核状态 `ACCEPTED`。
- [M5.2.C-D2a](M5.2.C-D2a.md)：文字测量的脱敏节点身份/样式、逐滚动 band 五点遮挡证据；主管复核 `ACCEPTED`。
- [M5.2.C-D2b1](M5.2.C-D2b1.md)：扫描前拒绝明确外部遮挡和无效探针、整节点撤账；11px 圆角误拒已按实际几何修复，真实 Edge 7/7、完整质量套件 121/121，主管复核 `ACCEPTED`。
- [M5.2.C-D2b2](M5.2.C-D2b2.md)：实际自定义时区按钮箭头与 search 清除叉的浅深四样本 Edge 隔离预检；截图/恢复结果已主管目视复核，search 原生伪元素 CSSOM 可见性限制和首轮 `search-light` 判据更正均保留，状态 `ACCEPTED`。
- [M5.2.C-D2b3](M5.2.C-D2b3.md)：将已验证的箭头和 search 清除叉隔离接入正式文字测量会话；真实 Edge、异常/遮挡/身份重试清理及完整质量专项通过，主管复核 `ACCEPTED`。
- M4.4.3 报告渲染与 M4.4.4 选择交互已 `ACCEPTED`，在 Codex 内置 Chromium/IAB 完成浏览器验收；合成报告不代表真实配色审美。
- 候选配色审美评选与用户选择收敛由 M5 负责；所选十套配色落地后的正式颜色矩阵与最终视觉回归由 M6 负责。M5.2.C 的技术测量结果不能替代审美评审或发布批准。

# 交接索引（2026-10-05 历史整理）

以下是 2026-10-05 的索引快照。当前状态见本文首节；本节旧进度只保留作历史记录，不覆盖后来单卡交接。较早阶段的实施记录当时移到 `archive/2026-10-05/`；归档不删除内容、不撤销验收，也不意味着归档模块不再是依赖。运行代码、契约与任务卡仍是当前实现的依据；交接中的旧门禁数字和旧摘要只说明当时的状态。

## 保留的交接

- [M0.2](M0.2.md)：角色与状态目录，供 M4 状态矩阵接线。
- [M0.3](M0.3.md)：数据契约、政策与失败记录。
- [M0.4](M0.4.md)：隔离 fixture 与清理责任。
- [M1.1](M1.1.md)：token 派生接口与首屏对照。
- [M1.2](M1.2.md)：bootstrap 发射器与候选覆盖。
- [M2.4](M2.4.md)：生成 CLI 与运行产物，供后续候选批次使用。
- [M3.1](M3.1.md)：快速可读性检查。
- [M3.2](M3.2.md)：浏览器测量与 Canvas 边界。
- [M3.3](M3.3.md)：材质、身份与最近邻诊断。
- [M3.4](M3.4.md)：最终门禁、视觉初筛与证据过期。
- [M4.1](M4.1.md)：本轮的预览服务，[复核意见](REVIEW-M4.1.md)四项更正 + 快照洗白更正（改走 M0 canonicalJson）已全部落地，专项 14/14。2026-10-05 本轮复核通过，标为 DONE。
- [M4.2](M4.2.md)：首屏和基准截图（capture.mjs），一候选两模式基准捕获 + 正式对照模式 + dashboard-default 测量接线。2026-10-05 复核六项更正完成：错误逐项阻断、入口严格快照、输出目录真实路径双检、角色等待接线修正、源摘要补齐 M3.4 必需 22 项、format 门禁如实复验；专项 25/25（含真机 C 层两条 + 篡改回归）、全套 1017/0、回退验证 R1—R7；真机基准证据**重新生成**在 `../captures/production-chatgpt-baseline/`（两张基准图已目检）。2026-10-05 本轮复核通过，标为 DONE；用户指示暂不开工 M4.3。
- [M4.3](M4.3.md)：状态矩阵与可恢复执行（S0—S7/D 全矩阵 + STATE_CATALOG 动作执行器 + `progress.json` 逐单元续跑）。2026-10-05 实施：专项 41/41（新增 A 层 13 + C 层 3）、真机矩阵证据在 `../captures/m43-state-matrix/`（两模式各 31 登记键 = 1 基准 + 30 状态单元，29 captured + quota-toast unreachable、零 blocker、每模式 6 gaps，聚光/焦点环/日历/计价/窄桌面等关键截图已目检）；自查更正三项——聚光单元靠入口就绪命中导致"开/关"路径一次未跑（补 `setSpotlight off` 预步骤）、`focus.outline` 机测不可用且焦点控件在首屏之外（补 `evidenceTargets` 元素截图）、catalog 触发把指针留在凸起预设按钮上导致 S0 实际"聚光开着"（矩阵侧 `restingPointer` 归位，`colors.json.spotlight` 留痕；M4.2 基准是否同步待裁定）。**状态 NEEDS_REVIEW，待复核。**此状态与数字仅为 2026-10-05 快照，不代表当前 M4.3 状态。
- [M4.4.1](M4.4.1.md)：证据读取与内部接口（review-evidence.mjs）。冻结 `loadReviewEvidence` / `buildReviewContainer` / `hashReviewContainer` / `ReviewEvidenceError` 与 `assessment-origins.json` 形状；安全边界（词法先于存在性的双检、文件一律禁 symlink、junction/URL/重复绑定/含糊 capture 拒绝）、必需出处摘要、跨批引用出处纪律与缺项 gaps 全部落定。首轮复核五项问题 + selections 皮肤归属 + 仓库相对路径基点已修复，**2026-10-07 复核通过标为 DONE**；2026-10-06 扩展轮（M4.4.2 协同）：origins 增可选 `currentProfiles` 通道（登记即核验，内容消费归 .2；**含扩展轮更正——run 内 junction 把真实路径重定向到另一 run 时 PATH_ESCAPE 拒绝，真实路径对出处 run 二次包含**），冻结接口既有消费面不变；扩展后专项 24 条（23 过 + 1 EPERM 跳过）、Biome 0/0，文件摘要见交接"扩展轮"一节。
- [M4.4.2](M4.4.2.md)：离线核验（review-verify.mjs）。冻结 `verifyReviewEvidence({evidence, requireSelections, production}) -> {status: pass/incomplete/rejected/invalid, errors, gaps, verifiedModel}`：block 1 身份/源摘要（缺摘要与不一致分开报告、捕获链路 SOURCE_FILES 22 项全覆盖、当前派生/配方口径独立核对）、block 2 原批次上下文调 M3.4 复核（不信落盘 ready、复核容器哈希与原容器逐字一致的忠实性硬证明）、block 3 完整必要矩阵（组与浅深缺一即局部捕获）、双侧 unreachable 仅 precondition 预案豁免、单元证据树 + S0 固定附件集合/JSON 结论/checks 完整口径（checks 按 capture.mjs:1274-1282 真实键集核，夹具键集锁死）+ **落盘判据（主 checks + S0 基线 + S5 双视图变体）与原评审测量记录逐条比对**、requireSelections 在重算容器哈希上核两个总摘要、production invalid → verifiedModel=null。首轮七项 + 第二轮两处代码问题（S0 真实形状误拒、S5 变体判据漏出）均已修；**当前配方出处通道已接线（2026-10-06 第三轮）**——消费 .1 扩展的 `currentProfiles` 登记（未登记 → unverifiable、字节漂移 → source-changed、缺条目 → source-invalid、配方不一致 → current-recipe-drift），"完整样本 pass 且可选、缺来源阻断、配方漂移阻断"三条验收全部落地并有动态测试。专项 33/33、.1 专项回归 23+1skip、四文件 Biome 0/0、typecheck 0；2026-10-07 协调者确认主卡验收，R1 图片补充 35/35（受审查沙箱外执行）和 scoped Biome 0。当前状态 DONE。

- [M4.4.2-R1](M4.4.2-R1.md)：已核图片数据输入补充；35/35 专项通过、scoped Biome 0，2026-10-07 协调者复核 ACCEPTED。受审查沙箱外运行用于绕过沙箱 realpath EPERM，读取范围偏差已留档。
- [M4.4.4](M4.4.4.md)：选择交互与导出；摘要重算、同皮肤选择、双模式证据、阻断 gap 和下载安全均通过，7/7 + scoped Biome 0，2026-10-07 协调者复核 ACCEPTED。

M4.4.3 报告渲染已交付并经协调者代码复核；7/7 专项与 scoped Biome 通过，诊断按候选绑定、失败/缺测与状态图可查看、三种报告规模模板已落地。真实浏览器验收被浏览器 URL 安全策略阻止（本地 `file://` 不允许），状态 **NEEDS_REVIEW**；未派发 .5。此段是旧快照，已由当前 [M4.4.3 交接](M4.4.3.md)记录的 Codex 内置 Chromium/IAB 验收与 [M4.4.5-C2](M4.4.5-C2.md) 子卡进度取代。
## 已归档的历史交接

以下 7 份均原样移动，移动前后 SHA-256 一致；轮次 README 的旧路径已同步更新。

- [M0.1](archive/2026-10-05/M0.1.md)：初始工作区调查；基线产物 `../baseline.json` 仍在原位置。
- [M1.3](archive/2026-10-05/M1.3.md)：颜色数学实施记录，当前调用依据为导出接口与测试。
- [M1.4](archive/2026-10-05/M1.4.md)：既有状态文字兼容及格式更正归属记录。
- [M1.5](archive/2026-10-05/M1.5.md)：旧工作台重复派生退役记录。
- [M2.1](archive/2026-10-05/M2.1.md)：模板实施及钳制标记修复记录。
- [M2.2](archive/2026-10-05/M2.2.md)：前景求解器实施及契约边界修复记录。
- [M2.3](archive/2026-10-05/M2.3.md)：候选配对、去重与可复现性实施记录。

后续新增交接继续放在本目录。需要归档记录时通过本索引查找，不根据文件时间猜测当前版本。
