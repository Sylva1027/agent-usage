# 三 worker 共用接口契约

revision：`timing-contract-1`。日期：2026-10-21。维护者：主审。第一波接口已固定；来源 producer 是否已认证是另一项 G1 结论，不由接口名称冒充。

规格：[修订方案](../../plans/2026-10-21-tps-measurement-correction-plan.md)；执行：[三 worker 执行单](../../plans/2026-10-21-tps-measurement-parallel-execution.md)。

## 1. 规范计时证据（A 校验、C 持久化）

```js
{
  schemaVersion: 1,
  evidenceOrigin: "producer-and-version", // 无凭据；需有主审认可的边界证据
  responseId: "response-identity",
  requestedModel: "exact-recorded-request-model",
  reportedOutputTokens: 1000,
  durationMs: 10000,
  status: "completed",
  completedAtMs: null, // 或生产端能够证明的 epoch 毫秒；缺失不猜
}
```

导入时另传明确的 homeId，不把 home 路径/账号/鉴权写入证据正文。字符串必须非空，output 是非负安全整数，duration 是正安全整数；completedAtMs 为空或有效 epoch 毫秒。source adapter 将 HTTP 200 等原生终态转换为 `completed`，不能直接把失败/进行中请求规范成成功。

A1 导出 `normalizeRequestTimingEvidence(raw)` 与 `mergeRequestTimingEvidence(records)`。前者成功返回上述规范对象，非法输入抛出有稳定 code 的错误；后者是纯函数，空集合返回 missing、完全一致返回 available、同响应不同计数/模型/时长/边界来源等返回 conflict。相同来源完全相同的重复幂等；不同 origin 的记录不能未经主审证明就互相覆盖或任选其一。

本轮不新建通用插件框架，不存正文，不根据同名模型或相近时间猜 responseId，不依赖硬编码 endpoint。`schemaVersion=1` 只表示形状，不表示任意 producer 已认证。

## 2. lookup（C 提供，B 消费）

同步、只读回调：

```js
lookupRequestTiming({ homeId, threadId, turnId, responseId, model, outputTokens })
// =>
{
  state: "missing" | "available" | "conflict",
  durationMs: null | 10000,
  reportedOutputTokens: null | 1000,
  requestedModel: "" | "exact-recorded-request-model",
}
```

missing/conflict 没有可用数值，durationMs/reportedOutputTokens 为 null，requestedModel 可空。available 只表示取得完整候选证据，B 仍须检查 outputTokens/model 相等及合法时长；不能假定注入回调永不出错。lookup 的 IO/数据库异常向上抛出，不能伪装成 missing 后发布 ready。

origin 与 home 的映射以及多条 evidence 的冲突在 C 的 lookup 层落实。threadId/turnId 由既有 Codex ledger 证明，不从网关会话名猜；导入只能影响 native 请求身份真实存在的线程。语义相同的测试 lookup 与正式 lookup 返回同一形状。

## 3. B0 纯内核

导出：`resolveCodexTurnRequestTiming(homeId, turn, lookupRequestTiming)`，turn 复用 `codex-fold.js` 的已去重 request ledger。

返回形状：

```js
{
  state: "complete" | "missing" | "conflict" | "invalid",
  durationMs: null | 10000,
  timedRequestCount: 0,
  requestCount: 0,
}
```

- 缺 lookup 或缺任一 request 时长：missing，durationMs=null。
- 明确冲突、计数/模型不一致、重复 request 身份：conflict，durationMs=null。
- 非正/非整数/不安全时长或求和溢出：invalid，durationMs=null；调用方转成既有 TIME_INVALID，不把它伪装成可采样分母。
- 全部匹配才 complete，durationMs 为安全整数求和；工具-only 与普通请求同等处理。
- 状态优先级固定：conflict > invalid > missing > complete，与输入顺序无关；需要遍历完整集合才裁定，不在第一条 missing 处早退而吞后续 conflict。
- 无请求集合不构成 complete；不得读取 item span、task_complete.duration_ms 或推算邻接 usage 差值补缺。
- `timedRequestCount` 是内核诊断，不借用 itemCount/timedItemCount 持久化，不改 UI n。

B1 的正式 builder 通过可选末尾 `options={ lookupRequestTiming }` 传入回调：`buildCodexThreadPerfSamples(homeId, threadId, rollouts, options)` → `buildCodexTurnCandidates(homeId, folded, rolloutFiles, options)` → 内核。C 只在调用方传 lookup，B 负责向下传，不允许 C 修改 B 的函数实现。

## 4. C0 的隔离存储

`src/perf-request-timing-store.js` 使用调用方传入的 SQLite 连接；内部具体类/函数名由 C 在 C0 报告一次性给出，调用方只需要导入、lookup、revision 三类能力，不让其他 worker 依赖未冻结的 SQL 表细节。

不可少的语义：home/origin/response 作用域；规范观察值幂等；冲突持久化；坏批次回滚；重复导入不改变 revision；证据过期不删除已验证值。C0 在临时库实现，C1 才接 UsageStore 迁移。新 schema 号必须核对当前实际值及并行任务占用。

主审补充（2026-10-21）：同一 home/response 已关联线程 A 后，后续批次不得追加线程 B。以 `REQUEST_TIMING_THREAD_CONFLICT` 拒绝整个新批次，原证据、关联和 revision 保持不变；同批次多线程同样拒绝。`affectedThreadIds` 去重。这是导入身份错误，不能先成功写入，再让查询以库损坏报错。

C1 主审补充（第三轮）：正式入口固定为 `UsageStore.importRequestTimingEvidence({homeId, records})`，不接收外部自证的 requestLinks；从本地已验证归属及兼容投影的 native ledger 推导唯一线程，无法唯一匹配则拒绝。证据导入与相关线程的持久化 dirty 标记同事务提交；重复导入不变更。sync 成功发布对应线程才清 dirty，失败保留以便恢复；无需多套逐响应/逐线程 published revision 状态机。全局 timing revision 参与性能索引版本，未重建的旧发布不能因导入被冒充成新结果。C0 的底层显式 links API 保持不变，只供已证明的调用方使用。

第四轮收紧高层导入边界：入口增加独立的 `reviewedOrigins` 参数，即 `UsageStore.importRequestTimingEvidence({homeId, records, reviewedOrigins})`。非空批次须由调用方明确给出本批已审 origin 列表，每条规范记录均须匹配，否则抛 `REQUEST_TIMING_ORIGIN_UNREVIEWED`，不改变证据/revision/dirty。该参数不能从证据 JSON 的 `admission` 或 `evidenceOrigin` 自动派生，也不永久认可未来同 origin 数据。离线 CLI 对应显式可重复 `--reviewed-origin`，先验证参数/输入再打开数据库；不增加签名、哈希或用户界面审批流程。C0 仍是底层隔离存储，不承担认证。

发布版本补充：新证据尚有 dirty 线程时，性能索引使用最后已消费的 timing revision，不能退成 0。旧已发布 timing revision 可用单个 meta 值保存；其他已成功发布的来源变更仍能影响索引，不通过冻结整个索引掩盖未消费证据。定向故障回归须覆盖已有 revision1 发布后 revision2 连续发布失败与恢复。

C1 最终裁定：多 home 允许部分成功，因此最后完整覆盖的证据 revision 不能单独表示已发布内容。索引采用实际成功消费 dirty 的事务内 publication sequence；只有成功提交推进，失败/no-op 不推进。最后完整覆盖 revision 保留为内部记录，不能冻结其他 home 已提交内容的索引更新。该行为已通过主审双向部分发布、重开和恢复回归。

C2 WorkBuddy 主审补充：trace 是独立的计时输入，其变化不能依赖 session 文件改变或人工强制重解析才能生效。正常 sync 必须发现 trace-only 时长晚到/新增冲突并更新相关性能候选及版本；重复输入幂等，重开/删 trace 不丢已知冲突。memory 性能版本与读取稳定性也须覆盖实际 trace 输入。无 home 的旧表值保留为历史，仅有可证明唯一归属时可兜底，同 messageId 多 home 的歧义不得各自借用旧单值。用量/费用不因计时变化被改写。

## 5. 发布与粒度

当前生产仍为 tps-v1；第一波不切换全局常量。G1 后 B/C 通过主审协调在共享工作区接线，最终隔离验收前不触碰真实库/服务。

v2 下 Codex key、日期归属、轮级 n/p10/p90 不改；只对完整请求集合给出轮分母。内核 state 映射为既有 MISSING_DURATION/RECORD_CONFLICT/TIME_INVALID，不新增公共 flag。完整 request timing 不再因为目标 item span 缺失而被 PARTIAL_ITEM_SPAN 否决。

producer 认证清单、其他来源排名准入和版本兼容规则，由主审根据 A 报告裁定后通知 B/C；未经认证不得自行登记为已通过。修改契约只能由主审记录差异并通知三人，不得各自加兼容 wrapper。
