# worker-A

## A1 — provider 拆行

卡号 / 状态：A1 / done

开始、结束时间与用时：2026-10-23 02:44:03 +08:00 — 2026-10-23 02:45:16 +08:00，1 分 13 秒。

本卡实际修改的文件、入口及基线指纹：

- `src/perf-stats.js`：`projectPerfModels()` 的 bucket key 改为 `JSON.stringify([sourceKind, model, reasoningEffort, modelProvider])`，行结果增加 `modelProvider`。
- `src/usage-types.js`：`PerfModelRow` 增加 `modelProvider`，并更新四元 key 与合并维度说明。
- `test/perf-models.test.js`：调整原 provider 合并断言，覆盖 provider 拆行、同 provider 跨 home/agent 合并、空 provider 独立、输入倒序稳定及新增字段。
- 起始 SHA-256 与 [baseline.json](../../../output/tps-audit/remediation/baseline.json) 一致：
  - `src/perf-stats.js`：`ae53eeeabaacda37f852495baf94815ee403acd3f5d371734ebf55aae83a5267`
  - `src/usage-types.js`：`554ec11c0554f48cbc9d241b8bd829d75f34d741fce61a77bed5b527c8f6f4d`
  - `test/perf-models.test.js`：`bfe45c1658b1803d5609712443d6390f7545fcf59e616e5f719579096b8eef26`
- 交付 SHA-256：
  - `src/perf-stats.js`：`211d51ca891305dbc5e4ba2ea851ba0773c72ca98175e6b355124e31c7d7313e`
  - `src/usage-types.js`：`1d3ff1b817881a87f49b9db8079dbc601d22aec6b2adcd5d34dadf3a8d537c4f`
  - `test/perf-models.test.js`：`4819fbaab27c2ecec548c2b68b27e57a8e4ad361dab790ba336e11ae7ab68540`

解决的问题与可检查的差异：

- 相同 `sourceKind/model/reasoningEffort`、不同 `modelProvider` 现在生成独立模型行；provider 为空字符串时保持独立，不从模型名推断。
- home、channel、agent 仍在四元 key 外，同 provider 的跨 home/agent 样本继续合并；原有 pooled、p10/p90 和 rank 逻辑未改。
- 相对 baseline：`src/perf-stats.js` 7 增 4 删，`src/usage-types.js` 5 增 4 删，`test/perf-models.test.js` 65 增 12 删。

执行命令、通过/失败数量、证据路径：

```powershell
node --test --test-reporter=spec test/perf-models.test.js
```

- 结果：12 passed，0 failed，0 skipped。
- 证据：测试运行输出；起始副本位于 `output/tps-audit/remediation/baseline/`。

真实 DTO 单行示例：

```json
{"key":"[\"codex\",\"gpt-5\",\"high\",\"acme\"]","sourceKind":"codex","model":"gpt-5","reasoningEffort":"high","modelProvider":"acme","averageTps":100,"p10":100,"p90":100,"n":1,"state":"ok","rank":1}
```

没有验证的内容及阻塞输入：

- 未运行 `typecheck`、lint、全仓测试或模型测试之外的消费者测试；本卡按要求只跑针对性模型测试。无阻塞输入。

后续建议：等待主审验收。验收通过后再派 A2；本 worker 不自动继续。

## A2 — 排名门槛与分段顺序

卡号 / 状态：A2 / done

开始、结束时间与用时：2026-10-23 02:47:08 +08:00 — 2026-10-23 02:49:27 +08:00，2 分 19 秒。

本卡实际修改的文件、入口及基线指纹：

- `src/perf-stats.js`：`projectPerfModels()` 增加 `rankState`、门槛参数和 eligible/reference/overflow 分段排序；`summarizePerf()` 将已解析的 `minSamples` 传给模型投影。`groups` 的既有聚合与排名逻辑未改。
- `src/usage-types.js`：`PerfModelRow.rankState` 类型及 `rank` 的空值语义。
- `test/perf-models.test.js`：补齐 n=1/17/19/20、显式门槛、未准入大样本、无 eligible、overflow、未舍入平均值及 key 同值顺序断言。
- 起始 SHA-256 与 A1 checkpoint 一致：
  - `src/perf-stats.js`：`211d51ca891305dbc5e4ba2ea851ba0773c72ca98175e6b355124e31c7d7313e`
  - `src/usage-types.js`：`1d3ff1b817881a87f49b9db8079dbc601d22aec6b2adcd5d34dadf3a8d537c4f`
  - `test/perf-models.test.js`：`4819fbaab27c2ecec548c2b68b27e57a8e4ad361dab790ba336e11ae7ab68540`
- 交付 SHA-256：
  - `src/perf-stats.js`：`847813599fcc0bacabbf0f39d13146821e44e39e491c037105b78d16086f3e75`
  - `src/usage-types.js`：`3dc0c60cba113354e3e98781533718f68cabd24407bdd2c0090d9e646274e3a0`
  - `test/perf-models.test.js`：`9b4a52c0ed5b7a3e6455c36a7566faf31849d6b603311256c9514ecf33d4de44`

解决的问题与可检查的差异：

- `rankState` 按 `overflow > unverified > insufficient_samples > eligible` 优先级判定；只有 `eligible` 行会获得连续编号。
- eligible 行排在最前，未准入/样本不足的参考行随后，overflow 最后；各段先按未舍入 `averageTps` 降序，再按 key 的 code-unit 顺序稳定排序。
- 默认门槛沿用 `PERF_MIN_SAMPLES = 20`；显式 `meta.minSamples` 会传入模型投影，未新增用户配置。
- n=1/17/19 保留统计和排序但不编号；n=20 才可能获得编号；n=20 的未准入来源仍为 `unverified` 且不编号。
- A1 的 n=1 DTO 示例记录的是 A1 时点；按 A2 默认门槛，同一行现在为 `rankState: "insufficient_samples"`、`rank: null`。
- 相对 A1 checkpoint：`src/perf-stats.js` 20 增 6 删，`src/usage-types.js` 4 增 1 删，`test/perf-models.test.js` 119 增 10 删。
- 未修改任何共享消费者或 summary 测试文件。

执行命令、通过/失败数量、证据路径：

```powershell
node --test --test-reporter=spec test/perf-models.test.js
node --test --test-reporter=spec test/perf-summary.test.js
node --test --test-reporter=spec test/perf-models.test.js test/perf-summary.test.js
```

- 结果：模型测试 15 passed；summary 子集 36 passed；合并复跑 51 passed，0 failed，0 skipped。
- 证据：上述测试运行输出；A1 起始副本位于 `output/tps-audit/remediation/checkpoints/A1/`。

没有验证的内容及阻塞输入：

- 未运行 `typecheck`、lint、全仓测试或模型/summary 之外的消费者测试；本卡无阻塞输入，也未发现需由主审接线的旧形状失败。

后续建议：等待主审验收。验收通过后再派 A3；本 worker 不自动继续。

## A3 — 实际样本日期与单位

卡号 / 状态：A3 / done

开始、结束时间与用时：2026-10-23 02:51:06 +08:00 — 2026-10-23 02:52:26 +08:00，1 分 20 秒。

本卡实际修改的文件、入口及基线指纹：

- `src/perf-stats.js`：`projectPerfModels()` 从每个 bucket 的实际 members 汇总 `tsMs` 最小/最大值和 `window`；混合 window 输出 `mixed` 并令 `rankState` 为 `unverified`。
- `src/usage-types.js`：`PerfModelRow` 增加 `window`、`firstSampleAtMs`、`lastSampleAtMs`。
- `test/perf-models.test.js`：覆盖 range/home 过滤后的 n 与日期、v1 不拉宽 v2 日期、Codex `turn`、请求数不投影、混合单位及 overflow 行的日期。
- 起始 SHA-256 与 A2 checkpoint 一致：
  - `src/perf-stats.js`：`847813599fcc0bacabbf0f39d13146821e44e39e491c037105b78d16086f3e75`
  - `src/usage-types.js`：`3dc0c60cba113354e3e98781533718f68cabd24407bdd2c0090d9e646274e3a0`
  - `test/perf-models.test.js`：`9b4a52c0ed5b7a3e6455c36a7566faf31849d6b603311256c9514ecf33d4de44`
- 交付 SHA-256：
  - `src/perf-stats.js`：`7b42574b718939114e3363c0fefd3bab115d2d84038b1161773b63fd9fff2eca`
  - `src/usage-types.js`：`033e2b77e4ff922488fa5a54a0871609f2be967457342829fe318f97531c3f92`
  - `test/perf-models.test.js`：`dd8abeeb856582bb42cefd8819e863544092e4bfa31ef44017119027a953fc54`

解决的问题与可检查的差异：

- 每行的 `firstSampleAtMs` / `lastSampleAtMs` 来自进入该模型统计的实际 members，不受查询边界或文件时间影响；range/home 过滤会同时改变 n 和日期。
- provider 四元分组保持不变；`window` 复用样本单位，Codex 行保持 `turn`，不新增底层请求数投影。
- 单位混合时 `window: "mixed"`，且不会获得编号；overflow 行仍保留实际日期。
- 相对 A2 checkpoint：`src/perf-stats.js` 13 增 1 删，`src/usage-types.js` 4 增 0 删，`test/perf-models.test.js` 78 增 1 删。

执行命令、通过/失败数量、证据路径：

```powershell
node --test --test-reporter=spec test/perf-models.test.js
```

- 结果：17 passed，0 failed，0 skipped。
- 未重复运行 summary/UI 等未变化的宽测试。
- A2 起始副本位于 `output/tps-audit/remediation/checkpoints/A2/`。

真实 DTO 单行示例：

```json
{"key":"[\"codex\",\"gpt-5\",\"high\",\"acme\"]","sourceKind":"codex","model":"gpt-5","reasoningEffort":"high","modelProvider":"acme","window":"turn","firstSampleAtMs":1760000001000,"lastSampleAtMs":1760000002000,"averageTps":100,"p10":100,"p90":100,"n":2,"state":"ok","rankState":"insufficient_samples","rank":null}
```

没有验证的内容及阻塞输入：

- 未运行 `typecheck`、lint、全仓测试或 summary/UI 消费者；本卡无阻塞输入。覆盖率统计留待 A4/A5。

后续建议：等待主审验收。验收通过后再派 A4；本 worker 不自动继续。

## A4 — 当前方法 Codex 覆盖计数

卡号 / 状态：A4 / done

开始、结束时间与用时：2026-10-23 02:53:39 +08:00 — 2026-10-23 02:57:31 +08:00，3 分 52 秒。

本卡实际修改的文件、入口及基线指纹：

- `src/perf-stats.js`：新增 `computeCodexTimingCoverage()`，从同一次 `selection` 的 `eligible` / `unplaced` 中筛出当前方法 Codex 候选并复用 `computePerfCoverage()`；`summarizePerf()` 返回 `codexTimingCoverage`，同时补齐返回注释，并将完整 selection 展开后替换两个数组以满足现有 `PerfSelection` 类型。既有 `window` 投影补了类型收窄，未改运行语义。
- `src/usage-types.js`：`PerfSummary` 增加 `codexTimingCoverage`，并新增 `PerfCodexTimingCoverage` typedef。
- `test/perf-summary.test.js`：增加 5 项 A4 断言，覆盖无适用来源、空范围、v1/v2 混合、缺时长/输出、pending、unplaced 和排除 home。
- `test/perf-stats.test.js`：未修改。
- 起始 SHA-256 与 A3 checkpoint 一致；summary 测试在 A3 时与开工基线一致：
  - `src/perf-stats.js`：`7b42574b718939114e3363c0fefd3bab115d2d84038b1161773b63fd9fff2eca`
  - `src/usage-types.js`：`033e2b77e4ff922488fa5a54a0871609f2be967457342829fe318f97531c3f92`
  - `test/perf-summary.test.js`：`92e660feb2e3ad5a500f7825d62cc701051b8bc9f5b4b9dae6adb4ae79b227e7`
  - `test/perf-stats.test.js`：`3720ba0e4d0267674d1ad9e16df76e2c61ecef94c98f6494238e83e2cd1cff9b`
- 交付 SHA-256：
  - `src/perf-stats.js`：`f5b8d2ecfc472ab7b054bac0c9d8bc4cec29a1fdad52eeaa737cc54b0902dcfd`
  - `src/usage-types.js`：`db7f1e18ca46c06b92a430ea0eaa67aa9c19912f6e106c6380f364abd40f7f9c`
  - `test/perf-summary.test.js`：`280cd902d92e7d5daa820aba6d514014611e50935ec1b79c21dafea26698f583`
  - `test/perf-stats.test.js`：`3720ba0e4d0267674d1ad9e16df76e2c61ecef94c98f6494238e83e2cd1cff9b`

解决的问题与可检查的差异：

- 仅当存在一个未排除、`homeId` 非空的 canonical Codex 已知来源时返回对象；否则返回 `null`。判定复用 `canonicalPerfSourceKind()`，不把未知来源当 Codex。
- `eligible` / `unplaced` 都只保留 `sourceKind === "codex"` 且 `methodVersion === PERF_METHOD_VERSION` 的候选；未要求候选已 sampled，因此缺时长或输出的 turn 仍在分母内。范围外候选不进入 counts，全历史 unplaced 独立保留。
- counts 复用现有算法，保持 `eligible = sampled + dropped + pending`；`droppedByReason` 互斥且合计等于 dropped，`byFlag` 可重叠。旧 `coverage` 仍包含 v1，未改成 v2-only。
- 未增加 A5 的 token 三字段，未改 store、usage-core、parity/API、UI 或共享 fixture。
- 相对 A3：`src/perf-stats.js` 62 增 3 删，`src/usage-types.js` 9 增 0 删，`test/perf-summary.test.js` 127 增 0 删。

执行命令、通过/失败数量、证据路径：

```powershell
node --test --test-reporter=spec test/perf-stats.test.js
node --test --test-reporter=spec test/perf-summary.test.js
node --test --test-reporter=spec test/perf-summary.test.js test/perf-stats.test.js
npm.cmd run typecheck
npx.cmd biome check --formatter-enabled=false src/perf-stats.js src/usage-types.js test/perf-summary.test.js test/perf-stats.test.js
```

- 结果：stats 59 passed；summary 41 passed；联合复跑 100 passed，均 0 failed、0 skipped。
- 类型检查：0 errors；本卡新增部分无类型诊断。Biome 检查 4 个文件，无发现。
- 证据：上述测试运行输出；起始文件位于 `output/tps-audit/remediation/checkpoints/A3/`，summary 起始副本位于 `output/tps-audit/remediation/baseline/`，交付快照位于 `output/tps-audit/remediation/checkpoints/A4/`。

没有验证的内容及阻塞输入：

- 未运行全仓测试，也未验证主审尚未接入的 API、store 或 UI 实际消费；本卡按要求只覆盖统计、类型和 summary 测试。无阻塞输入。

后续建议：等待主审验收。验收通过后再派 A5；本 worker 不自动继续。

## A5 — 已记录输出的覆盖比例

卡号 / 状态：A5 / done

开始、结束时间与用时：2026-10-23 06:27:18 +08:00 — 2026-10-23 06:28:26 +08:00，1 分 8 秒。

本卡实际修改的文件、入口及基线指纹：

- `src/perf-stats.js`：`computeCodexTimingCoverage()` 在一次循环中累计 `recordedOutputTokens`、`sampledOutputTokens` 和 `unknownOutputCandidates`；两个合计使用现有安全整数检查，溢出后保持 `null`。函数与 `summarizePerf()` 的返回 JSDoc 改用 `PerfCodexTimingCoverage`。
- `src/usage-types.js`：`PerfCodexTimingCoverage` 增加三个 token 字段和“未知不能当 0、unplaced 不进入 token 分母”的说明。
- `test/perf-summary.test.js`：增加 4 项独立手算测试，覆盖已知 0、未知输出、缺时长正输出、sampled 严格子集、零分母、整数溢出和 unplaced 排除。
- `test/perf-stats.test.js`：未修改。
- 起始 SHA-256 与 A4 checkpoint 一致：
  - `src/perf-stats.js`：`f5b8d2ecfc472ab7b054bac0c9d8bc4cec29a1fdad52eeaa737cc54b0902dcfd`
  - `src/usage-types.js`：`db7f1e18ca46c06b92a430ea0eaa67aa9c19912f6e106c6380f364abd40f7f9c`
  - `test/perf-summary.test.js`：`280cd902d92e7d5daa820aba6d514014611e50935ec1b79c21dafea26698f583`
  - `test/perf-stats.test.js`：`3720ba0e4d0267674d1ad9e16df76e2c61ecef94c98f6494238e83e2cd1cff9b`
- 交付 SHA-256：
  - `src/perf-stats.js`：`b562bf1f0914a73dec9275f9d5090062c0436332eca681fc870cd1f54719c71a`
  - `src/usage-types.js`：`affcd03c2a7becb387e91b9f57583070339af3bd89b2d1f32fb9b9a52cb973d5`
  - `test/perf-summary.test.js`：`98fba865546fa2ac46c2810fd79e96065aa428b6c3940ba2fbdd8fd00c179e42`
  - `test/perf-stats.test.js`：`3720ba0e4d0267674d1ad9e16df76e2c61ecef94c98f6494238e83e2cd1cff9b`

解决的问题与可检查的差异：

- `recordedOutputTokens` 累计当前方法、当前范围 Codex eligible 中所有已知安全非负输出；pending、缺时长和不能 sampled 的候选也计入。未知或非法输出只增加 `unknownOutputCandidates`，不按真实 0 累计。
- `sampledOutputTokens` 只累计非 pending 且通过现有 `isPerfSampled()` 的子集，条件与 groups/models 使用的 sampled 语义一致。
- `unplaced` 未进入两个 token 合计或未知候选数；counts 仍复用同一 selection。
- 每个 sum 独立判断安全整数溢出并返回 `null`，不发布伪精确合计；没有硬编码比例，也没有写入历史 0.80%。
- 相对 A4：`src/perf-stats.js` 30 增 4 删，`src/usage-types.js` 7 增 0 删，`test/perf-summary.test.js` 99 增 0 删。

B4 对照 fixture 的关键字段：

```json
{"methodVersion":"tps-v2","recordedOutputTokens":4500,"sampledOutputTokens":1000,"unknownOutputCandidates":0}
```

该组来自 sampled 1000、pending 3000、failed 500 的三个 positive-output 手算夹具；`sampledOutputTokens / recordedOutputTokens`（例如 `1000 / 4500`）的比例由 UI 根据这两个字段显示，不在统计层硬编码。

执行命令、通过/失败数量、证据路径：

```powershell
node --test --test-reporter=spec test/perf-summary.test.js
node --test --test-reporter=spec test/perf-stats.test.js test/perf-summary.test.js
npm.cmd run typecheck
npx.cmd biome check --formatter-enabled=false src/perf-stats.js src/usage-types.js test/perf-summary.test.js test/perf-stats.test.js
```

- 结果：summary 45 passed；stats + summary 联合 104 passed，0 failed、0 skipped。
- 类型检查：0 errors。Biome 检查 4 个相关文件，无发现。
- 证据：上述测试运行输出；起始文件位于 `output/tps-audit/remediation/checkpoints/A4/`，交付快照位于 `output/tps-audit/remediation/checkpoints/A5/`。

没有验证的内容及阻塞输入：

- 未运行全仓测试，也未验证主审并行接入的 usage-core/store、API 和 UI 比例显示；本卡未改这些文件。无阻塞输入。

后续建议：等待主审验收。验收通过后再派 A6；本 worker 不自动继续。

## A6 — 既有网关补齐流程的有限预检

卡号 / 状态：A6 / done（只读预检；未执行真实导出、导入或模型调用）

开始、结束时间与用时：2026-10-23 06:30:42 +08:00 — 2026-10-23 06:34:03 +08:00，3 分 21 秒。

本卡实际修改的文件、入口及基线指纹：

- 仅修改本报告：更正 A5 的比例方向，并追加 A6 记录。未改导出/导入脚本、`src/perf-request-timing*.js`、store/core、API、共享测试、真实索引或输出目录。
- 起始 SHA-256：
  - `scripts/export-perf-request-timings.mjs`：`E9D91A3CC1324B9CEB7EB3B70F4D0834CE27EBB2DF0904E3824EA6FC76DF8929`
  - `scripts/import-perf-request-timings.mjs`：`B8ADB2BF7C60067FD0C31874642FC56744C37535B1238297BC79222D42564C01`
  - `test/perf-request-timing-export.test.js`：`B7968E227C5082A627ED04604F599CABD2F7D1B3B2C0E30F091616C330EFE27D`
  - `docs/validation/2026-10-23-tps-remediation/worker-A.md`：`3E87C11B777078EA4979BA1AFC6984C86AE84EC678680944D53231873056B94C`
- 交付 SHA-256：三个代码/测试文件的哈希与起始值相同；本报告最终哈希见本节末尾。

已确认的代码边界：

- `scripts/export-perf-request-timings.mjs` 要求在发请求前提供 `--producer <name@version>`、`--route`、`--agent`、`--provider`、`--requested-model`、`--reported-model`、显式 `--endpoint`、Codex home、日期范围和输出路径；`@latest` 在请求前被拒绝。
- 导出器只接受绝对 `http(s)` URL，不接受 URL 凭据、query 或 fragment；不发送 `Authorization`/Cookie，不读取鉴权配置，不跟随重定向。每页固定 `limit=500`，最多 100 页；HTTP、分页、total 变化或 JSON 异常均整次失败且不写部分输出。
- 返回行必须与 agent/provider/requested/reported 四元组逐字匹配；输出只含规范化计时白名单，不含 endpoint、host、session、thread、正文或工具参数。冲突保留为 `conflicts`，不静默丢弃变体。
- 输出固定写 `admission: unauthenticated_candidate`；该自声明不是审核凭据，也不能自动授予排名资格。
- `scripts/import-perf-request-timings.mjs` 要求显式 `--database`、`--home`、`--input`；非空批次必须提供一个或多个 `--reviewed-origin`，输入自报的 `homeId` 必须与 `--home` 一致。未审核 origin 在打开/创建数据库前以 `REQUEST_TIMING_ORIGIN_UNREVIEWED` 拒绝；导入成功后仍需走项目正常的 `sync()` 才能投影计时。

已有测试与结果：

```powershell
node --test --test-reporter=spec test/perf-request-timing-export.test.js
```

- 结果：8 tests / 8 passed / 0 failed / 0 skipped。
- 覆盖：分页与跨页精确去重、冲突保留、白名单、HTTP 失败原子性、100 页上限、`@latest` 拒绝、精确模型范围失配、导入未审核 origin 在建库前拒绝、主/extra home ID 匹配，以及真实 export → import → 正常 `sync()` 接缝。
- 证据：上述测试输出；测试文件起始/交付哈希均为 `B7968E227C5082A627ED04604F599CABD2F7D1B3B2C0E30F091616C330EFE27D`。

历史参数完整模板（仅描述已审核过的旧批次，不授权新批次）：

| 参数 | 历史值 |
|---|---|
| endpoint | `http://127.0.0.1:3425/v1/magpie/usage/requests` |
| producer | `magpie@0.1.1294`（binary SHA-256 `49C155BD7F9F6BAE35E7D063371E55F31EDCD05AB41A1AD092938813B7815890`） |
| source | tag `v0.1.1294` / peeled source `2c3c903974b65c145f9f009d83a2cf7e0fb3ee01` |
| route | `codex-responses-to-chat` |
| agent | `codex` |
| home | `main`（原始路径和 homeId 保持私有，不写入报告） |
| provider | `opendesign`（当次实际安装的 `@latest` 插件，浮动配置本身不是版本 pin） |
| requested model | `opendesign/deepseek-v4.1-flash` |
| reported model | `deepseek-v4.1-flash` |
| audited range | `2026-10-21..2026-10-21`，旧审计截止 `11:06:54 +08:00` |
| reviewed batch | 326 条 Codex 请求；旧模板的 514 条范围内筛选结果 |

历史 producer、route 与计时语义证据见 [a0-producer-evidence.md](../2026-10-21-tps-measurement-correction/A/review/a0-producer-evidence.md) 和 [A-report.md](../2026-10-21-tps-measurement-correction/A/A-report.md)。

旧批次不能直接复用为新的完整日期导出：导出器只提供日期级 `--since/--until`，不能表达 `11:06:54` 的时间截止点。旧 326 条只认证当时实际安装和加载的 producer/route/provider 行为，不认证 `@latest` 之后解析出的插件、其他 provider/route，或同一区间的新增行。

当前环境预检与缺口：

- 当前 Magpie 二进制元数据显示版本 `0.1.1319`，SHA-256 `B4CC88534D32586BE7F13518C6D2512D0583EB4F3727F60B4CA5EF1E47F00306`；远端标签 `v0.1.1319` 指向 `86254d4049cb6be4a2ccdab02edf0bd59860c603`。这是与旧认证不同的 producer 版本，旧版源码/哈希结论不能自动延伸。
- 历史 endpoint 的 TCP 连接可达，空参数 `HEAD` 返回 HTTP 200；这只证明 HTTP 路径当前有响应，不证明该日期范围、route、provider 或返回内容仍符合审核范围，也未读取账本行。
- `CODEX_HOME` 未设置；默认 main home 目录存在且含 sessions，路径保持私有。当前实际目标 home、home-kind、route、provider、requested/reported model、日期范围和可接受的时间截止点仍需用户/主审明确。
- 新批次尚缺独立审核证据：必须针对实际导出的 `evidenceOrigin`、文件哈希、范围、行数、producer/route 和 identity/output 语义由独立审核者确认。文件里的 `admission` 或旧 326 条认证不能替代该审核。
- 还缺临时导出文件和临时 SQLite 路径；本卡只读边界未执行真实导入，没有创建这些路径，也没有写入任何真实索引。

参数完整但不可执行的占位流程（所有尖括号值及独立审核通过后才可运行）：

```powershell
# TEMPLATE ONLY. Do not execute until every placeholder and the exact batch review are supplied.
node scripts/export-perf-request-timings.mjs `
  --endpoint '<explicit-http-or-https-url>' `
  --home '<codex-home-path>' `
  --home-kind '<main|jetbrains|extra>' `
  --since '<YYYY-MM-DD>' `
  --until '<YYYY-MM-DD>' `
  --output '<temporary-export.json>' `
  --producer '<name@exact-version>' `
  --route '<observed-route>' `
  --agent '<observed-agent>' `
  --provider '<observed-provider>' `
  --requested-model '<exact-requested-model>' `
  --reported-model '<exact-reported-model>'

# Independent review must approve the exact evidenceOrigin, file hash, range and row scope.
node scripts/import-perf-request-timings.mjs `
  --database '<temporary.sqlite>' `
  --home '<home-id-from-export>' `
  --input '<temporary-export.json>' `
  --reviewed-origin '<exact-reviewed-evidence-origin>'

# Then use the project's normal sync entry point against '<temporary.sqlite>'.
# Do not replace this with a direct DB write or a new wrapper.
```

未验证及后续：

- 未执行真实导出、真实导入、模型调用或在线测速；未读取凭据、真实账本行或真实索引。
- 未发现需要修改导出/导入代码的新缺陷，因此没有增加 wrapper、daemon 或采集器。
- 等待主审判定 A6；本 worker 不自动开始 A7。

## A7 — 晚到证据的正常发布回归

卡号 / 状态：A7 / done

开始、结束时间与用时：2026-10-23 06:37:04 +08:00 — 2026-10-23 06:39:39 +08:00，2 分 35 秒。

本卡实际修改的文件、入口及基线指纹：

- `test/perf-request-timing-store.test.js`：在既有 C1 “import folds native projections” 用例中补最小断言：导入前两个 rollout candidate 的 `duration_ms` 均为 `null` 且 summary sampled 为 0；正常 sync 后目标 thread 为 1000、未获证据的 thread 仍为 `null`，summary 新增 1 个 sampled group/model，模型 n=1、TPS=100。
- `test/perf-request-timing-export.test.js`：同一条真实 CLI export→import→正常 `sync()` 接缝中，前后逐字比较两份 mock rollout 文件内容，证明未改写 rollout。
- 本报告：修正 A6 的两个相对链接为 `../2026-10-21-tps-measurement-correction/...`，并把运行授权表述限定为“本卡只读边界未执行真实导入”。
- 未修改 `src/`、导出/导入脚本、真实索引、真实 rollout 或服务；未发送模型请求或在线测速。
- 起始 SHA-256：
  - `test/perf-request-timing-store.test.js`：`ED0EBDC1536093F490CC99F44D171027BDE63CE25DF5CEB8FFC049CBC3EB1611`
  - `test/perf-request-timing-export.test.js`：`B7968E227C5082A627ED04604F599CABD2F7D1B3B2C0E30F091616C330EFE27D`
  - `docs/validation/2026-10-23-tps-remediation/worker-A.md`：`C7F5FC2C2FB72694E34A293C896F0F9932DF5F1B409DA035C5694C7ED9FF55CD`
- 交付 SHA-256：
  - `test/perf-request-timing-store.test.js`：`E250705A0A05D05F67E4A89F5A67A8440F674D3CBFA671EC4549920A3C1050B0`
  - `test/perf-request-timing-export.test.js`：`BB4A690BCAE6ACDCEB2BCDCFB00B20639788B1FAF908A49D2F904DF2BC786354`
  - 本报告正文哈希见文末。

复用测试链与断言：

1. `node --test --test-reporter=spec test/perf-request-timing-export.test.js`：8 passed / 0 failed。
   `real export-to-import CLI seam carries one timing through native projection and sync` 先断言两个候选的 `durationMs` 均为 `null`，经真实脚本导出、导入后只把 `thread-a` 标 dirty；重开临时库并执行无 force 的 `reopened.sync()` 后，`thread-a` 样本为 1000 ms，`thread-b` 样本逐字段等于导入前，dirty 清空，且两份 rollout 内容逐字不变。
2. `node --test --test-reporter=spec --test-name-pattern='C1 · import folds native projections' test/perf-request-timing-store.test.js`：1 passed / 0 failed。
   新增断言确认导入前没有 turn 分母；sync 后 `coverage.sampled=1`、一个 group、一个 model、`models[0].n=1`、`averageTps=100`，未获证据的 `thread-b` 仍无 duration，因此不会生成第二个 turn 分母。
   同一既有用例还断言重复导入返回 `{ revision: 1, changed: false, affectedThreadIds: [] }` 且 sync 不改 published index version；冲突值及注入的 dirty-clear 失败均保留原 published version/revision，dirty 不丢；恢复后 revision 2 再发布。
3. `node --test --test-reporter=spec --test-name-pattern='C0 · exact duplicates|C0 · a mixed batch|C0 · a SQL failure' test/perf-request-timing-store.test.js`：3 passed / 0 failed。
   直接覆盖完全重复证据幂等、混合批次任一 link 冲突整批回滚、SQL 中途失败回滚新行并保留既有可用证据。
4. `node --test --test-reporter=spec test/perf-request-timing-kernel.test.js test/perf-request-timing.test.js`：27 passed / 0 failed。
   `a missing request timing leaves the whole turn without a denominator` 断言两请求 turn 只有一条证据时 `state=missing`、`durationMs=null`；输出/模型冲突、非法/非正时长及冻结 fixture 的部分失败也均不产生部分分母。
5. `npx.cmd biome check --formatter-enabled=false test/perf-request-timing-store.test.js test/perf-request-timing-export.test.js`：2 files checked，无发现。

已知既有失败：

- 整文件运行 `test/perf-request-timing-store.test.js` 为 17 passed / 1 failed。唯一失败是既有用例仍断言 schema 版本 19，而当前 `src/usage-store.js` 的 `STORE_SCHEMA_VERSION` 已是 21（`expected 19, actual 21`，测试第 586 行）；本卡未改该源码，且本卡相关 C0/C1 用例均通过。该失败属于当前未提交留存工作的版本漂移，不在 A7 扩散修复。

结论：临时 mock/临时 SQLite 的晚到证据链已通过正常 `sync()` 发布到 summary；重复证据幂等，缺请求/冲突/非法证据不发布部分值，失败保留健康发布结果，rollout 未被改写。未发现 request-timing 内核或 store 缺陷，也未执行真实批次导入。

后续建议：等待主审验收 A7；本 worker 不自动开始 A8。

## A8 — 原生 Codex 请求时长的有限调查

卡号 / 状态：A8 / done（`evidence_gap`；未启动 N1，原生 TPS 仍未恢复）

开始、结束时间与用时：2026-10-23 06:41:25.938 +08:00 — 2026-10-23 06:47:32.147 +08:00，6 分 6 秒。

本卡实际修改的文件、入口及基线指纹：

- 仅追加本报告。未修改 reader、fold、candidate、request-timing、测试、真实索引或 rollout；未发送网络/模型请求。
- 起始 SHA-256：
  - `src/perf-sources/codex-jsonl.js`：`D3A655151FF4576F9C617AA3D34DCD6E52B01894C1EEC215DADAFE9D9D6A8C7C`
  - `src/perf-sources/codex-fold.js`：`19A44070CE2242E56AFF169EEBD4BC690A7EDE03BF46B8D6BA5A5A74D0EC02BC`
  - `src/perf-sources/codex-candidates.js`：`EB2AAD793983654E2F851AE5A1A7DA725CCE41F6A9B3DFF41452459BE4CFAA07`
  - `src/perf-sources/codex-request-timing.js`：`5221136782061B4A30587280241811320B40A74038F224EE5C81AAD092BC0135`
  - `docs/validation/2026-10-23-tps-remediation/worker-A.md`：全文 `F409C3A62E049877DC17AA6FA47BA4C4E8C0E5D6D7B3E61D1FA1D8E905B4B90B`，正文 `18A8438670C633200D131CCE5671C17208F4DBD4BAD635486D50C4A747DE7994`
- 交付 SHA-256：四个代码文件与起始值相同；本报告最终正文哈希见文末。

有限样本方法及局限：

- 仅针对当前原生 Codex CLI `0.163.0`、默认 `.codex/sessions` 中按修改时间选出的两个最新 `.jsonl` 文件；只选这两个原始文件，不扫描整个 home。
- 两个活文件在打开时分别为 76,429,098 和 40,994,958 字节。以共享读方式流式读取，完成时共解析 44,139 行，0 malformed、0 read error。
- 样本采集窗口为 06:46:49.594 — 06:47:22.879 +08:00。文件仍在追加，因此行数、ID 数和字节数会漂移；这些计数是可复核的时间点证据，不声称穷举全部会话、版本或路径。
- 未输出或写入原始路径、response/thread/turn/item ID、prompt、消息正文、工具参数或凭据。`response_id` 只作为内存中的关联键使用。

可绑定性结果：

- `response_id` 只出现在两个位置：`token_usage_record.payload.response_id`（4,547 个唯一 ID 的普通记录）和 `compacted.payload.latest_token_usage_record.response_id`（69 个重复引用）。这 69 个 compacted ID 全部也出现在普通 `token_usage_record` 中，是重复快照，不是额外计时证据。
- 4,547 个唯一 response ID 对应 4,616 个含 ID 行；其中 4,478 个 ID 只有普通 usage 行，69 个 ID 同时有 compacted 与普通 usage 行。
- 严格检查 `started_at`、`*_start_time`、`completed_at`、`end_at`、`duration_ms`、`elapsed_ms`、`latency_ms`、`time_to_first_token_ms` 等请求级时间字段：含 response ID 的行中为 **0**。没有任何同一 response ID 同时具有请求开始与结束，或显式请求时长。
- 含 response ID 的行中，显式完成/失败状态、错误、attempt/retry 字段均为 **0**；模型字段只出现在 69 个 `compacted.payload.resume_metadata.previous_turn_settings.model`，属于 turn 设置快照，不是该 response 的请求级模型证据。
- `token_usage_record` 提供请求 ID、thread/turn/root/session ID、累计与本次 output token，以及行级 `timestamp`；但该 timestamp 只是单端记录时间，不能与同 ID 的请求开始配对。
- `response_item` 的 `payload.id`（21,497 个值）和 `call_id`（8,542 个值）与 4,547 个 response ID 的交集均为 **0**；其 metadata 只有 `turn_id`，不能把 item/完成状态绑到同一请求。
- `task_started`（101 行）、`task_complete`（99 行）、`token_count`（4,548 行）和 `item_completed`（12,854 行）在本样本中均无 response ID。`task_started`/`task_complete` 的 start/end/duration 以 turn/root-turn 归属；`task_complete.time_to_first_token_ms` 和 `item_completed` 的 item 时间窗都不能替代请求 E2E；`token_count` 仅是 turn/thread 累计快照，邻近关系不构成身份绑定。

代码边界与根因：

- `src/perf-sources/codex-jsonl.js:304` 只投影 `token_usage_record` 的 response/thread/turn ID、output token 和 timestamp；`:337` 的 item 时间窗与 `:387` 的 task 时间窗均按 item/turn 归属。`response_item`、`task_started`、`token_count` 等被忽略或不作请求投影。
- `src/perf-sources/codex-fold.js:199` 才按 `homeId + threadId + responseId` 合并请求，但合并的字段中没有请求开始、结束、时长、完成状态、模型或 attempt。
- `src/perf-sources/codex-candidates.js:56` 只调用外部 `lookupRequestTiming`；`src/perf-sources/codex-request-timing.js` 要求每个请求都有显式正时长。当前原生记录没有该输入，因此 duration 保持缺失，不能回退为 turn/task/item/TTFT 差值。

结论：在限定的原生 Codex `0.163.0` 默认会话路径上，当前记录能稳定给出 request identity 与 output token，但缺少同一 response ID 的请求起止或时长、显式终态、请求级模型及 retry/attempt 归属。结果为 `evidence_gap`。该结论不外推到其他 CLI 版本、provider 或 Magpie 网关路径；外部网关账本仍需其自己的 producer/route 审核。

producer 至少需要在同一请求身份下增补：

- 请求开始与结束（或显式时长），明确 epoch/monotonic 时钟及毫秒单位。
- 显式终态（成功、失败、取消）和最终 output token。
- requested/reported model，以及 attempt/retry identity。
- 工具调用、子请求与一个 turn 内多请求的聚合规则，并保证同一 `(home, thread, turn, response, attempt)` 只有唯一最终记录或明确冲突规则。

最小脱敏合成形状（仅表示建议契约，不是当前文件已存在的记录）：

```json
{
  "type": "token_usage_record",
  "timestamp": "<response-end-rfc3339>",
  "payload": {
    "thread_id": "<thread>",
    "turn_id": "<turn>",
    "response_id": "<response>",
    "request_started_at_ms": "<epoch-ms>",
    "request_completed_at_ms": "<epoch-ms>",
    "completion_status": "<completed|failed|aborted>",
    "attempt": "<positive-integer>",
    "requested_model": "<requested-model-id>",
    "reported_model": "<reported-model-id>",
    "usage": { "output_tokens": "<non-negative-integer>" }
  }
}
```

未验证及后续：

- 本卡没有代码或测试变更，因此未运行测试；未执行真实导入、真实索引写入、模型请求或在线测速。
- 由于没有可靠的同请求边界，不启动 N1，也不把任何 turn/task/item/TTFT 时间接入原生 TPS。A8 的 `evidence_gap` 不表示原生 TPS 已恢复。
- 等待主审验收 A8；本 worker 不自动开始 A9。

## A9 — 数据回归结果汇总

卡号 / 状态：A9 / done（本轮相关数据路径已有通过证据；全仓回归未判定为绿；未恢复原生 Codex TPS）

开始、结束时间与用时：2026-10-23 06:48:50.495 +08:00 — 2026-10-23 06:50:57.635 +08:00，2 分 7 秒。

本卡实际修改、入口及基线指纹：

- 仅追加本报告；未修改产品或测试文件，未运行重复测试、真实导入、真实索引写入或在线请求。
- A9 开始前本报告全文 `FD96EB5F6BDF4AD66E489BB120D720A7871D5DD383831156358072F646C76B00`，正文 `598DEAFDDA6CE471E4C1FDC366D9DCA405F25A1D42388336B6C883BA5CBE1F0B`。
- 现有日志的测试文件与相关源码修改时间均早于对应日志；当前指纹又与已验收交付一致，因此本卡引用日志而不重跑。`M4-full-test.log` 不是最终汇总，只用于核对当前源码下已出现的单项通过。

本轮相关回归证据：

- **models**：`node --test --test-reporter=spec test/perf-models.test.js` 在 A3 为 17 passed / 0 failed / 0 skipped。`src/perf-stats.js` 后续在 A5 定稿为当前哈希；晚于该定稿的 `M4-full-test.log` 中，当前 17 个直接 model 测试名均以 `✔` 出现、0 个 `✖`、0 个缺失。该核对只证明这 17 项，不把仍在运行的全仓日志当作整体通过。
- **stats + summary**：`node --test --test-reporter=spec test/perf-stats.test.js test/perf-summary.test.js` 的 `A5-review-tests.log` 为 104 passed / 0 failed / 0 cancelled / 0 skipped；A4 的同类结果 100 passed 已被 A5 定稿结果取代，未重复。
- **request kernel/request**：`node --test --test-reporter=spec test/perf-request-timing-kernel.test.js test/perf-request-timing.test.js` 为 27 passed / 0 failed；覆盖请求级完整/缺时长、冲突、非法时长、部分分母与工具/TTFT 不得替代等既有保护。`M4-full-test.log` 中当前 27 个直接测试名也均以 `✔` 出现。
- **request export**：`node --test --test-reporter=spec test/perf-request-timing-export.test.js` 为 8 passed / 0 failed；覆盖分页、去重/冲突、HTTP 原子失败、100 页上限、严格身份匹配、未审核 origin 拒绝，以及真实 export→import→正常 `sync()` 的临时链路。
- **request store**：`node --test --test-reporter=spec test/perf-request-timing-store.test.js` 的 `A7-store-migration-review.log` 为 18 passed / 0 failed。该日志使用主审接管、包含 schema 21 迁移修正的当前测试；本 worker 未修改该测试或产品存储。
- 以上计 17 + 104 + 27 + 8 + 18 = 174 个相关用例通过，跨不同命令/日志，不是单次 174 项套件，也没有相关失败。

当前相关源文件 SHA-256：

- `src/perf-stats.js`：`B562BF1F0914A73DEC9275F9D5090062C0436332ECA681FC870CD1F54719C71A`
- `src/usage-types.js`：`AFFCD03C2A7BECB387E91B9F57583070339AF3BD89B2D1F32FB9B9A52CB973D5`
- `src/perf-request-timing.js`：`8B96CE7F6E86D7476B949635F3848464A2AF8149ACDFB7B08276D51FBE2D2414`
- `src/perf-sources/codex-request-timing.js`：`5221136782061B4A30587280241811320B40A74038F224EE5C81AAD092BC0135`
- `scripts/export-perf-request-timings.mjs`：`E9D91A3CC1324B9CEB7EB3B70F4D0834CE27EBB2DF0904E3824EA6FC76DF8929`
- `scripts/import-perf-request-timings.mjs`：`B8ADB2BF7C60067FD0C31874642FC56744C37535B1238297BC79222D42564C01`
- `src/perf-request-timing-store.js`：`63428939F5A1394BE0F21F5A27342E6A699AEC27FA8E4626810583386C1FACC0`

对应测试 SHA-256：

- `test/perf-models.test.js`：`DD8ABEEB856582BB42CEFD8819E863544092E4BFA31EF44017119027A953FC54`
- `test/perf-stats.test.js`：`3720BA0E4D0267674D1AD9E16DF76E2C61ECEF94C98F6494238E83E2CD1CFF9B`
- `test/perf-summary.test.js`：`98FBA865546FA2AC46C2810FD79E96065AA428B6C3940BA2FBDD8FD00C179E42`
- `test/perf-request-timing-kernel.test.js`：`E1A9974F414AF1CEDC66D9DE2BA04E3C701C2E4C0FDD431AD3E33202F3674180`
- `test/perf-request-timing.test.js`：`28F00FA99A93A117E883E1FD6C7E9767869857FC85A3E208F8A22F48DEE3BF37`
- `test/perf-request-timing-export.test.js`：`BB4A690BCAE6ACDCEB2BCDCFB00B20639788B1FAF908A49D2F904DF2BC786354`
- `test/perf-request-timing-store.test.js`：`6B7719A6CE073D5BEF80020BB19ADF57E100A3F74DF68A79AA98D214760022C3`

全仓边界：

- 不宣称全仓测试为绿。`M4-full-test.log` 在 A9 时仍是运行中快照，没有最终 `ℹ tests/pass/fail` 汇总；其中已见与本轮数据路径无关的 Anthropic 自动刷新、candidate symlink/真实路径越界、currentProfiles 出处等失败，不能归因或计作 TPS 修复失败。
- `M4-typecheck.log` 失败于并行 history 留存工作：`src/history-archive.js(1137,14): error TS2304: Cannot find name 'loadHistoryBackupContext'`；不是本卡相关源文件的 TypeScript 错误。
- `M4-lint.log` 为主审运行的 217 files，0 fixes，55 warnings、4 infos；主审报告命令退出 0。该警告栈也不由 A9 重跑或改写。

结论：models、stats/summary、request kernel/request、export 与 store 的当前相关代码均有明确通过证据，且不存在本轮新增的相关失败。全仓仍有并行留存导致的 typecheck/测试未绿项，必须与“本轮相关通过”分开表述。A8 的 `evidence_gap` 仍然有效，A9 不代表原生 Codex TPS 已恢复。

后续：等待主审验收 A9；本 worker 不自动推进，等待后续 B7 隔离时序卡指派。

## B7 — 隔离服务中的候选、证据导入与发布时序

卡号 / 状态：B7 / done（隔离夹具与临时库链路完成；真实索引、用户服务和浏览器未触碰）

开始、结束时间与用时：2026-10-23 06:55:14.000 +08:00 — 2026-10-23 06:55:18.701 +08:00，4.7 秒（隔离脚本创建至本轮测量结束；不含报告写入）。

本卡实际修改、入口及基线指纹：

- 新增 `output/tps-audit/remediation/B7-isolated-publication.mjs`，运行后保存 `output/tps-audit/remediation/B7-isolated-publication.log`；另仅追加本报告。未修改产品或测试代码，未启动或重启用户服务，未写真实索引。
- B7 开始前本报告全文 `9BAAF8B30ABF6EEDA20C0FFCBA7826E5726763688A5329EEE31E3564994DB317`，正文 `0C87135D6E947953D53F37EC8FB3DAFE6D1792CE4C2DEC870AC6526AB7B09B0C`。
- 本次运行输入：`src/server.js` `DE8498412812005634BA067CC2C34293F1E772AA507B51BC8455EA1E797EE2F3`；`src/usage-store.js` `44CD7404BCF058A2A6AAC844209634F9E65197665F3C123E2066CD1EA5BD3F4F`；`test-support/perf-fixture.mjs` `C71296D74FB391FCEA318BF3E17EA7F6D3E4D6F843F23D95EF0D1DE24F06BF9F`。
- 交付指纹：脚本 `5AB8FB544B866BEA7BB6B9B3AA8B986C1CEB7121E615E6CC98244BF600852051`；日志 `808AE953E0E4ADE3CB512BD246CB905103728310906280049610395F25EE1523`。

执行命令：

```powershell
node output/tps-audit/remediation/B7-isolated-publication.mjs | Tee-Object -FilePath output/tps-audit/remediation/B7-isolated-publication.log
```

夹具与时钟：

- `createPerfCodexIntegrationFixture()` 的固定夹具哈希为 `2cdfc5a8f7b6833a1f080c99e4f1955b810c6433b9270f2edcb372b344f7f436`；3 个 rollout 共 104 行、26 条 `token_usage_record` 均可读，模型为 `codex-fixture-model`，源数据时间固定在 2026-10-04。
- 单调时钟为 `node:perf_hooks.performance.now()`；墙钟为 `2026-10-22T22:55:18.378Z` — `2026-10-22T22:55:18.701Z`，时区 `Asia/Shanghai`。
- 刷新配置：隔离 `createUsageServer()`，`preset=all`、`automaticDiscoveryEnabled:false`。首个 API 请求包含服务执行器首次 sync；之后统一 `skipCheck=1`，因此后续读到的发布变化只可能来自显式普通 `store.sync()`。未使用浏览器自动刷新。

可检查的完整链路：

1. 先普通 `sync()` 发布 25 个候选、26 次请求但没有计时分母。API 返回 `models=[]`、`groups=[]`，Codex 覆盖为 `eligible=25 / sampled=0`，已记录输出 2,800 tokens、已采样输出 0 tokens；25 个丢因均为缺失/非正时长。
2. 仅调用 `importRequestTimingEvidence()` 导入 26 条完整证据，返回 `changed=true`、影响 1 个 thread；此时 API 的 `indexVersion` 仍为 `ee22cedb5a10cc6df9c1f41fb8c63f67c057f3e94c4ba65ed67d7bf2a320e2f5`，`sampled=0`。这明确区分了“证据已导入但未发布”，不是自动刷新延迟缺陷。
3. 再调用一次普通 `sync()` 后，API 的 `indexVersion` 变为 `95f2e07dcc197f743d89ca9bb9e2c4a9255f4af0b453de732eef4d0fb47f8932`，状态 `ready`，1 个模型行、1 个分组，采样计数 `25/25`，已采样输出 2,800/2,800 tokens；`/api/usage` 与 `/api/summary` 的 perf 读数一致。
4. `freeze=1` 返回快照 ID，按该 ID 再读的 `summary.perf` 与冻结响应逐字一致。未在 B7 修改 live rollout 来扩展 B8 的冻结隔离检查。

实际区间（单次结果，不构成 p95 或 SLA）：

- 候选已发布到最终 API 可用：`178.086 ms`。其中证据导入 `2.851 ms`，普通发布 `sync()` `26.798 ms`，发布后 API 读 `10.057 ms`。
- 证据导入完成到最终 API 可用：`62.586 ms`；普通发布 `sync()` 完成到最终 API 可用：`10.059 ms`。
- 单次 fixture 汇总 TPS 为 `6.60377358490566`，仅用于证明该样本链可计算；不把固定夹具的 25 个回合外推为线上分布。采样次数为 1。

真实 DTO 摘要（非原始来源）：

```json
{"fixtureHash":"2cdfc5a8f7b6833a1f080c99e4f1955b810c6433b9270f2edcb372b344f7f436","state":"ready","modelCount":1,"groupCount":1,"n":25,"eligible":25,"sampled":25,"recordedOutputTokens":2800,"sampledOutputTokens":2800,"averageTps":6.60377358490566}
```

清理与 B8 交接：

- 脚本在 `finally` 中依次关闭临时服务和独立 store，并删除 `perf-codex-integration-*` 临时根；运行后未保留临时目录、服务进程或端口占用。实际端口 `3099` 只属于本次短生命周期实例，B8 应重新随机监听，不复用该端口。
- B8 可直接复用该脚本的“无证据 → 导入未发布 → 普通 sync 发布 → freeze 快照”结构。若 B8 要验今日/本周/本月，必须另建按目标日期生成的确定性临时夹具；不能把固定在 2026-10-04 的 B7 夹具误称为今日数据。

未验证及后续：

- 未访问真实 Codex 索引或用户运行中的服务，未做浏览器/DOM、自动刷新、截图或网络请求；这些属于 B8。
- 未恢复原生 Codex 请求计时；本卡证明的是既有完整外部证据可经普通同步发布。单次 178.086 ms 不是 p95，也不是线上 SLA。
- 未发现需要另立刷新修复卡的具体缺陷。等待主审验收 B7；本 worker 不自动开始 B8 或 B9。

澄清：B7“未做网络请求”指未访问外部网络；本卡实际使用 loopback HTTP API。

## L1 — 发布 perf 版本纳入共享变更指纹

卡号 / 状态：L1 / done（两轮中审后的最小实现；浏览器 replay 仍由 reviewer/B 验收）

开始、结束时间与用时：2026-10-23 07:10:55 +08:00 — 2026-10-23 07:21:22 +08:00，10 分 27 秒（以首份 L1 红色日志与本轮最终验证结束为边界；不含报告写入）。

根因与两次中审修正：

- B8 已证明：rollout 文件未变，普通 `sync()` 把 API perf 从 `n=4/80%` 发布为 `n=5/100%`，`indexVersion` 变化；但 `/api/status?since=...` 与 `/api/usage` 的源指纹仍为 `23d22746935f6e354de025a44ad24efe6c72c0df3702f754b570fd5e3cf6d7bd`，因此 `changed=false`，浏览器不会重新取数。
- 第一版在 `/api/status` 调 `usageStore.dashboard(all)` 取版本，会让轻量端点重做聚合并排入执行器队列；该方案已删除，不作为交付。
- 第二版仅用 `postState` 缓存无法感知外部 CLI `store.sync()`；该假绿已删除。当前测试会先由独立 `UsageStore` 导入并 `sync()`，再只请求 `/api/status`，不会先经 usage/dashboard 刷新缓存。

最小实现：

- `src/usage-store.js:3307` 新增 `perfPublicationState()`：只读已发布 `perf_index_version`、当前请求计时 revision、已发布 timing revision 与 dirty 计数。它不聚合、不调 `perfState()`、不扫描来源。
- `src/usage-executor.js:306` 将上述已发布版本随现有 `state` 快照发布；`src/usage-executor.js:417` 新增专用 `perfPublicationState` 消息，主线程接口在 `:675`。该消息无 dashboard/summarize，且复用执行器唯一数据库连接。
- `src/server.js:531` 的 `/api/status` 读取：server sync 在飞时直接使用现有缓存；空闲时合并一次轻量 meta 查询，50 ms 内未完成才回退缓存。既不新建 DB 连接，也不轮询。
- `src/server.js:237` 的 `clientFingerprint(source, publishedIndexVersion, pendingTimingRevision)` 只给 status 传入 pending token；`/api/usage`、`/api/summary`、`detail=full` 与冻结响应仍传入捕获的 `summary.perf.meta.indexVersion`，不带输入 revision，分别见 `src/server.js:814`、`851`、`869`。
- import-only 语义：当前 timing revision 与已发布 revision 不同时，status 以 pending token 报 `changed=true`，但公开统计仍是旧值；浏览器随后正常 `loadUsage()`，默认 usage 走普通 `sync()` 发布。发布完成后 pending token 清空，status 与 usage 再次同源。未用 `unpublished changed=false` 保留死锁。

真实触发回归 `test/perf-codex-api.test.js:346`：

- 初始无 timing：`models=[]`，初始 status 与 usage 指纹一致。
- 独立导入前 24 个请求的 timing，不调用 usage：只 GET status，得到 `changed=true`；同一 pending 指纹再次 GET status 为 `changed=false`，避免抖动。
- 默认 GET usage 促使执行器普通 sync，发布 `n=24`；status/usage/summary 指纹一致。
- 独立 `UsageStore` 导入 turn 25 的剩余 timing 并执行外部 `store.sync()`；随后**只 GET status**，得到 `changed=true`，直接复现旧页仅轮询 status 的真实路径。
- 之后 GET usage/summary（`skipCheck=1`）返回 `n=25`，两者与前述 status 指纹一致。
- 重复导入为 `changed=false`，status 不变；冲突/未审核批次抛 `REQUEST_TIMING_ORIGIN_UNREVIEWED` 后仍为健康 `n=25`、指纹不变。
- 初始 `freeze=1` 快照在发布后仍返回原指纹与 `models=[]`，证明冻结使用捕获版本而不是 live。

基线、交付与验证：

- 起始 SHA-256：`src/server.js` `DE8498412812005634BA067CC2C34293F1E772AA507B51BC8455EA1E797EE2F3`；`src/usage-store.js` `7D74C43C4720B7B24ADA43527DA6C4AB5EDBCABBB82F639B1E726C9E71D9B48C`；`src/usage-executor.js` `57A9156A18F2DF7865E1C61F217FC7E17B2237F484B9738B9F55EA0541C3C4AE`；`test/perf-codex-api.test.js` `DC18A90171D7E5F3C1BEBEDAFCC198CDAB04DFFB510BEE398B110E81A10AA14B`；本报告正文 `CB64E1295AF2B7F6A45A4215E9052263CE7C47B91701CA6B1AE9C00618337BDA`。
- 最终 SHA-256：`src/server.js` `7EBF1ECF81A382CC66E8FD2B9B0CE36E1EA4027CE6D63D29A0A1589EE31DCBBF`；`src/usage-store.js` `186D1C000050CCC621B10158707C49092BA7D8BA00761D804D010A6750137C8A`；`src/usage-executor.js` `65BC46F5087A5639679F5C4AD9FB2FC8AE43E2F25CB4389C15A71220671C2013`；`test/perf-codex-api.test.js` `63E7CD50E019B48E00D7425DACA773A147D24C46548849CCDF93C63C76AA0F51`。
- `test/perf-codex-api.test.js`：5 passed / 0 failed；`test/perf-server.test.js`：17 passed / 0 failed；`test/w1-executor.test.js`：14 passed / 0 failed，其中两条 `/api/status` 在飞时回归分别为 186.2 ms、194.7 ms，均低于 250 ms；聚焦 status 用例：1 passed / 0 failed；`npm.cmd run typecheck` 退出 0；`git diff --check -- src/server.js src/usage-store.js src/usage-executor.js test/perf-codex-api.test.js` 退出 0。
- `test/server.test.js` 有 15 passed / 7 failed；失败均不在 L1 指纹路径：4 项 source-import total mismatch、pricing endpoint 500、缺少 discovery `results`、Windows 临时定价文件 `EPERM`。本卡不把这 7 项归因于 L1，也不宣称全仓测试为绿。
- 未修改 schema、history retention、timer、`public/app.js` 或真实数据；未启动、重启或访问用户运行中的服务。

日志 SHA-256：

- `L1-red-test.log`：`2A441424E482435165B1DD9B6DEC5FDBDD9951941251294AAB500F0DE84F4004`
- `L1-green-test.log`：`7FE77B752066656056C02D9E6E72E8391E9BB29BBA070B340DA58C73FADD5C2B`
- `L1-perf-codex-api.log`：`AA3C17CA5CA659EAAA983E0014082BBEF6537BD8F23C522BA8431C877BF81C31`
- `L1-perf-server.log`：`C43021C20B458D8764A73E7788D386D172A9AA9268A29DD916D0E915F8CE842B`
- `L1-w1-executor.log`：`3C160D85BF23A66A4D3E61B984EC8817BB7B0D793BAF76AFD9041CE7A393E81D`
- `L1-status-server.log`：`E8F3F02E6396CB14A74B48EE90C44E818CF4E49CE2D1725F1446A5E23A4DCC8E`
- `L1-typecheck.log`：`F7DE83E91FC0E5F46A156FB8C5AEB5DB5B22C62CEA366FBC388DE9BE84F6271B`
- `L1-server.log`：`8825CC8BCD3E79CD83D8A80BA416286D1D6666998FBC9A670BAAD7AD82184F7E`

未验证、明确限制及后续：

- 本卡修复 API 变更触发，不新增或改写浏览器自动刷新设计；真实浏览器 replay、DOM 与网络请求仍由 reviewer/B 验收。
- 若外部 `store.sync()` 恰好发生在 server sync 或重读持续占用执行器时，status 会按 W1 回退缓存；最迟在下一次 60 秒轮询补见。这是保留轻量的有意上限，不宣称即时。
- import-only 是 pending 唤醒，不直接发布公开统计；`skipCheck=1` 在 pending 期间仍可读到旧统计，默认浏览器路径会执行普通 sync。
- 未证明任何固定 fixture 的读数代表线上分布，也未恢复原生 Codex 请求计时。

本报告正文（不含本行）SHA-256：`3EA97B5B2A4BD0AD3C84E9C2C5214A6E5C41D6BFEA87572BE8BB7DC0A3D18A49`。
