# M1：公共样本契约与统计内核

前置：M0.6 的 `source-contract.md` 与[实施总计划](../2026-10-04-model-tps-implementation-plan.md)。模块拥有 `src/perf-stats.js`、`src/usage-types.js`、`test/perf-stats.test.js`。本模块不读源文件、不访问 SQLite/DOM；一个 agent 按 M1.1→M1.3 串行写 `perf-stats.js`，可将 fixture 断言交给独立 agent 只写测试文件草稿，最终由文件所有者合并。实际模块出口为稳定 API 与手算 fixture。

## M1.1 样本身份、flag 与归一化

实现并导出 `PERF_METHOD_VERSION='tps-v1'`、`PERF_FLAGS`（位号严格照方案 §17.4，2/3 保留不可复用）、`PERF_MIN_SAMPLES=20`、`PERF_LONG_WINDOW_MS=300000`、`canonicalPerfSourceKind(kind)`、`perfSampleKey(sourceKind, homeId, ...identity)`、`perfGroupKey(sample)`、`normalizePerfSample(raw)`。`canonicalPerfSourceKind` 将现有 `main/jetbrains/extra/codex` 统一为 `codex`，原始 kind 仍供来源发现与限额资格使用；project-log 返回 unsupported。`sampleKey` 与分组 key 均为 JSON 数组串；字符串来源 ID 按确认规则 trim，保留大小写，不通过 `:` 或 `#` 拼接。

归一化显式区分 `null`、0、负数、非整数、超过 `Number.MAX_SAFE_INTEGER`。无 stable identity 返回 `{ sample:null, warningCode:'UNKEYABLE_RECORD' }`，绝不使用时间戳作假 key；可稳定定位但 `tsMs` 缺失的候选仍输出。只接受 §17.1 枚举值；未知版本/字段产生结构化警告，不自动改成“已完成”。`src/usage-types.js` 增加 `PerfSample/PerfSummary` JSDoc，`UsageReport.perfSamples`、`UsageSummary.perf`；保留既有用量字段。

验收：`['a:b','c']` 与 `['a','b:c']` 不碰撞；跨 home 相同原始 ID 不碰撞；缺输出与真 0 产生不同标志；Codex/其他源 `timingKind/tokenScope` 不可能误合组。测试只用合成数据。

## M1.2 过滤、覆盖率与主原因

实现 `selectPerfSamples(samples,{range,excludedHomeIds})` 与覆盖率计算。范围用样本 `tsMs`；普通 `start<=ts<=end`，限额有 `windowEndExclusive` 时 `ts<endExclusive`。来源排除先于范围；`tsMs=null` 只加该来源全历史 `unplaced`，不进入当前 `eligible`。group/source/era 使用同一选择结果；Codex byEra 只依据相同 `tsMs` 与方法元数据切点。

合格判定严格照 §17.4：正输出、正完整时窗、`status=completed`、无 sourceFiltered/conflict/partial/overlap 等硬排除；`LONG_WINDOW` 与 `MULTI_REQUEST_TURN` 只提示。`in_progress` 归 pending；其他不合格归 dropped。按 §17.5 的固定原因优先级给每个 dropped **恰好一个** `droppedByReason`，`byFlag` 允许重叠。保证 `eligible=sampled+dropped+pending` 和五层覆盖单调不等式；分母 0 返回 rate `null`。Codex 的 `byEra` 按样本 tsMs 切 recent/legacy，非 Codex 为 null；`knownSources` 的 unsupported 条目单列，不能合成 eligible=0 的假源样本。

验收：两个 flag 的同一候选只增加一个 dropped 主原因；pending 不计 dropped；partial 有正时长但不计 completeTimedPositiveOutput；timeUnplaced 改时间筛选不改变全历史定位诊断。对重复 sampleKey，一致行折叠，不一致行留 RECORD_CONFLICT，不允许直接相加。

## M1.3 统计、排序与 parity fixture

实现总入口 `summarizePerf(samples,{range,excludedHomeIds,knownSources,meta})`。对同一 sampled 集合计算逐样本 `outputTokens*1000/durationMs`、nearest-rank p10/p50/p90、时长 p50/p90、合并样本 TPS 与整数和；`n=1` 三分位相同，`n=0` 仅诊断。任何单值或求和超安全整数时，该组不返回伪数值，报告编码 `AGGREGATE_OVERFLOW`。排序原值 p50 降序、同值规范 key；`n<20` 保留组并标样本不足，页面不编号排名。数值/API 不四舍五入。

准备含至少两来源、两 home、unknown/main/subagent、provider/effort/tokenScope 分离、时长不等、0/缺值、长轮、冲突、跨时间边界的固定 fixture；手算并写明期望 p10/p50/p90、pooled、coverage。不得把实现函数输出复制成 fixture 预期。运行 `node --test test/perf-stats.test.js`、`npm.cmd run typecheck`、受改文件 Biome；在 `M1.md` 列出实际结果与接口签名。
