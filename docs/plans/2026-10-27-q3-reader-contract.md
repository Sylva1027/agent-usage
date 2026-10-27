# Q3 已发布 reader 的投影归属合同与施工设计

本文是施工前独立合同，保留作者当时的静态研究状态。实际实现、反例修复和 Main 执行证据由[主计划施工账本](2026-10-27-q2-q3-projection-implementation-plan.md#9-施工账本持续更新)维护；本文列出的候选与待验项不冒充已经运行。

日期：2026-10-27。状态：**合同评估完成，供 Main 审查后按既有授权直接施工；本文没有执行运行时验收。**

用户给定基线：`0cee6ce51814863dee8afd14fe222e0df10aaf5e` 已推送；本卡不运行 Git 验证或写入。上位范围、资源与准入以[Q2/Q3 主计划](2026-10-27-q2-q3-projection-implementation-plan.md)为准。本卡独占写集只有本文；`src/usage-store.js`、executor、主计划、probes 和 tests 均由其指定 owner 施工。用户已授权计划后自动实施，无需再次确认；本卡交付合同，不越权写产品或测试，不切生产。

## 1. 评估结论与最小候选

采用主计划约定的两个内部 API：`source.captureUsageProjection()` / `pinnedReader.adoptUsageProjection(snapshot)`。只把 Q2 已证明有效的普通 hot `all` 用量静态部分深拷贝到本轮已 pin 的临时 reader；目标 `perfKey` 强制无效，`quoteInputs = null`。TPS/coverage/perf 状态从目标快照重读，重报价走既有 SQL，不修改 `HistoryQuoteInputs`，不复制其最多 128 MiB 的输入。

**有条件可施工**：Q2 的有效用量键必须已覆盖实际用量写入、未知写入、schema/tracker 故障、来源身份、外提交和回滚。当前混合槽不能直接当成新 API 的输入。Main 完成 A0/Q2 之后，按本文反例确认该键足以证明缓存与 pin 之间的用量事实没有变化，再接 Q3。若 A0/Q2 未成立，Q3 保留原 miss，不以最后 commit reason、未变的 marker 或两个连接碰巧相同的计数替代证明。

该候选不保证减少每个 `/api/usage` 的耗时：默认请求如果等 sync 完成才查询，可能仍走 writer。Q3 的收益对象是**实际选中 published reader 的同步中请求**。必须记录选择，不把直接 UsageStore 的暖读或 Q2 的 writer 收益记给 Q3。

## 2. 静态核对范围、代码身份与历史证据

本卡仅用 PowerShell 7 读取源码、现有测试、计划和 JSON 证据，写本文；没有启动 Node/npm/SQLite/browser，也没有运行语法检查、测试、探针或 Git。以下行号对应本次读取版本，Main 施工后按符号重新定位。

读取时 SHA-256：

- `src/usage-store.js`：`ef1d21a1a55239662cc46a82aeadbc81bcb5d172b56c8dcf421dbba9b0128303`。
- `src/usage-executor.js`：`415ffc1539b012df740652539b9542a83baff1e68f0305c0e4d92e068e17291e`。
- `src/history-quote-inputs.js`：`df962a6c3ec2e3ab7322444b595b13e3d1a6bfa7a49ee2aff75f1e3eed14aa9a`。
- `src/service-tier-evidence.js`：`eab76722ecf42b3803ee70488a3bbf7e11003811d26630ac12dfc217134f230c`。

主要代码入口：

- [executor](../../src/usage-executor.js)：`:334–336` 的 `publishedStore/publishedStatus/publishedReady`；`:371` 的 `releasePublishedReader`；`:422` 的 sync 建立/释放；`:472` 的 dashboard 选择；`:627` 的消息调度。
- [UsageStore](../../src/usage-store.js)：`:4375–4418` 的连接级状态与投影槽；`:4819–4906` 的外提交/失效；`:4959` 的替换回滚；`:10749` 的冷 SQL 分支；`:10859` 的 dashboard；`:10914` 的 authority/summary savepoint；`:11109` 的键；`:11148` 的构建；`:11400` 的 close。
- [HistoryQuoteInputs](../../src/history-quote-inputs.js)：有预算的捕获、`finish()`、`events()` 和可破坏的 `discard()`。
- [service-tier evidence](../../src/service-tier-evidence.js)：resolver 的闭包数据及现有 snapshot/fromSnapshot；不能把含函数 resolver 当普通结构化数据复制。

历史真实 reader 证据是[上一阶段验收](../validation/2026-10-27-codex-refresh-followup/README.md)、[reader-attribution.json](../validation/2026-10-27-codex-refresh-followup/evidence/reader-attribution.json)和[reader-ledger-attribution.json](../validation/2026-10-27-codex-refresh-followup/evidence/reader-ledger-attribution.json)：

- 上阶段 3/3 个同步中请求实际用了不同的 published reader，空槽 miss；同一 writer 的 6 次 post-sync/post-no-op miss 只改变 `total_changes` 分量。
- ledger overlay 样本覆盖真实 executor、同 writer 和同步中 published reader；writer 修订 7→9，精确增加 113 sampledOutputTokens，用量摘要保持一致。
- 一个历史 during-sync 调用的 timeline/perf 包含时间约 716/646 ms；ledger 发布后另一调用约 871/611 ms。这些是不同调用的归因，父子方法时间不能相加，也不能宣称为 Q3 当前收益。
- 上述探针明确没有实际冷段覆盖；热探针拒绝 ATTACH。它们的 `stateSerial/publishedSerial/readerId` 是诊断身份，不是持久发布版本。
- [原 reader handoff](../validation/2026-10-27-codex-refresh-followup/probes/reader-handoff.md)末尾“未运行”的文字是仪器交还时状态，后续实际结果以验收/JSON 为准。首个缺 `package.json` 的探针失败、旧浏览器 >8 s 样本与旧门禁超时均保留其版本归属；本文没有重新执行，不把它们写作 Q2/Q3 当前失败或通过。

## 3. 当前 reader 生命周期及必须保持的行为

### 3.1 建立和读取

1. `sync` 在已有 `storeStatus` 时创建新 `UsageStore({ databaseFile })`，等待 `reader.open()`；首轮没有已发布状态，直接使用原行为。
2. 当前路径复制 homes/warnings，引用 service-tier resolver，然后 `BEGIN`，首次 `SELECT id FROM events LIMIT 1` 固定 WAL 读快照。**仅执行 BEGIN 尚未证明快照已固定。** 空 events 夹具也必须覆盖首次实际读建立快照的行为。
3. reader 建好后才启动 `syncUsageStore(store, ...)`。`dashboard` 先等待 `publishedReady`，再使用 `publishedStore || store`，并使用该 reader 的 `perfPublicationState()`。
4. metadata/quota/period 是原 dashboard 的各自读取；它们不因种入 summary 槽而成为可共享的响应对象。hot summary 的 authority marker 与计算在 savepoint 中读取，不能把检查移到异步窗口之外。

### 3.2 释放和错误

sync 正常和异常都会进入 finally：先 `releasePublishedReader()`，再 checkpoint，再重置 `publishedReady`。释放先清 executor 的 published 引用，再尝试 reader `ROLLBACK`，即使 rollback 失败也尝试 close；有原 sync 错误时不能用 cleanup 错误替换它。无原错误时沿现有 reader cleanup 错误语义返回；checkpoint 错误仍仅作诊断。

Q3 不延长 reader 跨轮存活，不建立 reader 池，不保留数据库连接给下轮缓存，不更改 `serializeSyncBackup`、sync 合并或主线程无 SQLite 连接的约束。`close` 已在串行队列里，应覆盖同步中 close 的等待与 reader 释放；不能为命中率跳过 checkpoint。

### 3.3 这里“同一发布”的准确含义

`storeRevision/derivedRevision` 是实例记账，`fingerprint/generatedAt` 和 `storeStatus` 是已发布的业务/状态字段；任意一个都不能单独证明两个连接读取了同一数据库事实。原始 SQL 可以改 events 而不改 marker；ledger-only 又可以改变 perf 而不改 tokens。

本合同的证明对象是：**源槽所计算的用量事实与上下文，等于目标 reader pin 时可见的用量事实与上下文。** 源的有效用量键及前后同连接 guard 证明时间区间内没有相关写入；目标首次读证明它处于该区间内的确定快照；上下文副本证明非数据库输入相同。只读用量 payload 可移交。完整 perf 发布不由这一证明推出，必须在目标快照重建。

现有 `publishedStatus` 的意义与来源保持不变。不能把一次成功 adopt 当作全数据库发布认证，不能因此绕过 native/timing 发布验证、冷段验证或给 status 人造一个持久版本。

## 4. 数据归属与可移交范围

### 4.1 本候选允许深拷贝的静态 payload

由 Q2 明确拆出的：timeline 的 token/分组事实、已计算费用及其原价目身份、channels/models、启用 details 时的 homes/projects/repositories，以及被证明确为用量事实的 timelineError。每项仍受原范围、模型规范化、来源、证据和价格依赖约束。

默认只接受成功、字段完整的普通 hot all 槽。timeline 构建出错或部分构建的槽先回退，避免把错误恢复也纳入第一版证明。不要为了转交先主动查询一次 dashboard。`repositoryPeriods` 虽在当前混合投影里，也含日/周/月窗口键；第一版不转交它或 periodComparison 缓存，除非 Q2 单独证明精确 asOf/周期边界。最小补丁宁可让原 period SQL 继续执行。

费用可以随 payload 复制，但必须携带它**原来计算时**的 catalog version/rate。模型键集变化可能改变事实分组，应 fact miss；rate-only/FX-only 则可按现有路径重报价。目标不能把旧费用包装成新价目已命中。

### 4.2 仅按现有发布语义复制或固定的上下文

- homes：`structuredClone`；warnings：独立数组；generatedAt/status：使用本次受保护的发布值。它们不是用量键的替代证据，也不种入 metadata/period/quota 缓存。
- service-tier resolver：现有模块生成的 resolver 只提供 resolve，闭包 turns 不对外暴露；可沿现有 executor 的只读引用方式固定该对象，本轮 writer 另换 resolver 不改变旧 reader。必须同时设置 `reader.serviceTierEvidenceInput = source` 的**同一捕获签名**，并在接收时核对 resolver/签名没有被换掉。
- 不重新读 live logs 给旧 reader“补新证据”，不把 null/未同步签名强行当成已同步。未知或可变自定义 resolver 无法证明时拒绝移交；如将来真需独立 resolver，复用已有 snapshot/fromSnapshot，另计复制成本，本卡不改该模块。
- pricing 仍绑定每个 dashboard 消息自己的目录作用域；使用现有 `runWithPricingCatalog`，不能将 sync 的全局目录无条件覆盖其它并发请求目录。

### 4.3 不转交、不共享的数据

- `HistoryQuoteInputs` 实例、chunks、typed arrays、字典/ids、events generator：全部不转交。新槽 `quoteInputs` 必须显式为 null。
- perf、perf carrier、timing candidates/evidence、dirty/ready/missingSources/warnings/indexedAt、`perfKey`：不继承有效身份。目标 `perfKey` 置不可能命中的值，正常查询重读目标快照。
- quota observations 缓存、quota 窗口/倒计时、bounds/totals/comparison、metadataObservationCache/metadataCache、periodComparisonCache、recordChampionCache、eventCostMemo：不移交，保持原入口计算/失效。
- 冷 SQL reader、verified flag、ATTACH 连接/TEMP views、authority 认证结果、archive carrier 及冻结 snapshot：不移交。
- 数据库 handle、源 store 和原槽引用：只可作为 snapshot 的**短期校验凭据**；不能成为目标槽的长期依赖、不能跨线程 postMessage、不能深拷贝或把 handle 暴露给主线程。

### 4.4 quoteInputs 独立所有权与关闭/discard 合同

当前 `discard()` 会清 chunks/values/ids、置 active=false 并清长度；`finish()` 后的 complete 标志不能替代 active 检查。两个 reader 共用一个实例时，一侧 miss/discard 就可能破坏另一侧重报价；`structuredClone(instance)` 也不会自动保留其类方法。当前 close 只是清槽引用，没有显式调用 quoteInputs.discard；不能写成“当前 close 已经 discard”。

本候选通过**不转交输入**解决归属：source 独占原 quoteInputs，target 只有深拷贝的纯 payload，target 无法借此触碰 source buffer。source 的 miss、显式 discard、close/open，以及 target 的 close/失效，均不能影响对方已独立拥有的数据。target 后续若自行完整捕获了新 buffer，该 buffer 只属于 target，按既有上限和失败回退管理。

必须测试“目标完成 adopt → source buffer discard/源 close → 目标换价格仍通过目标 SQL 计算完整费用”，以及“目标失效/close → source 换价格仍能正确使用其原输入”。只断言两个 buffer 不相等不够，target 应为 null。目标关闭后不保留 snapshot/源槽强引用；不为本卡新增 clone/refcount/transferBuffer API。

## 5. 明确 API、字段与责任

下面字段名称是施工建议；实际 usageKey/priceKey 接口以 Q2 最终实现统一命名，不能另外维护一套重复失效规则。API 不出模块公共协议，不加 worker 消息，不要求新持久 schema。

### 5.1 `source.captureUsageProjection()`

同步、只读地尝试捕获；返回 `null` 或一个短期 snapshot。没有暖槽、普通 hot all 不成立、未完成写事务、key/context 无法验证时直接 null。**不能读取最新 data_version 后改写原槽的版本来让它看起来有效。**

snapshot 的最小信息：

```js
{
  source,                  // 源 UsageStore，仅供同 worker 校验
  database,                // 捕获时源 DatabaseSync handle 的严格身份
  cache,                   // 捕获时原 summaryProjectionCache 对象身份
  context,                 // 原槽已存的规范上下文，独立固定值
  usageKey,                // 原槽计算时保存的有效用量键
  // schema/tracker/connection 身份必须在 usageKey 或同一 guard 中完整绑定
}
```

`context` 至少覆盖 resolved range 的精确毫秒/时区/rolling 语义、bucket、规范 excludeHomes、details、模型规范化键集、service-tier 输入；费用原 catalog/rate 身份单独保留。不得只保存 preset=all 或把 now 粗化到分钟；上下文取自**原槽构建时**，不能事后从当前 filters 补造。

capture 必须用源当前连接重新求 guard，并与**原槽保存的有效用量键**相等。guard 必含来源 DB/连接身份、schema/tracker 有效性、有效用量计数与 data_version；原槽若没存其中一项，不能仅给 snapshot 补上“当前值”当作历史证明。Main 需把必要来源身份在构建槽时一同保存。

读取 guard 失败、数据库已 close、data_version 读取失败或安全整数检查不成立均返回 null。现有 `readDataVersion()` 出错返回上次观测值是普通查询的容错，不能把该 fallback 当作已成功取得移交凭据。

capture 不调用全量 summary、不重建 quoteInputs、不触发写入或新连接。snapshot 可以持有原槽引用，因为引用本身正是校验对象；接收结束即释放它。

### 5.2 `pinnedReader.adoptUsageProjection(snapshot)`

同步返回 boolean：成功 true，优化不适用/证明失败 false；false 不得改变目标已有有效槽，不得损坏 source。方法只接收本 worker 内 capture 的 snapshot。

接收前置条件与顺序：

1. caller 已 await reader.open，设置捕获上下文，`BEGIN` 后完成实际 SELECT pin；目标是本轮临时 published reader，连接仍存活，writeTransactionDepth=0。仅 `isTransaction=true` 不证明它是已 pin 的读事务：该 precondition 由唯一 executor 调用点及确定性测试建立；其它调用点不获准使用 API。
2. source store/DB 严格等于 snapshot 的引用且仍打开；source 不处在写事务/未结束手工事务；source 槽严格等于 snapshot.cache，原槽 context 和 usageKey 仍等于捕获值。相同路径、相同修订小整数或深相等的新槽都不能替代原槽身份。
3. pin 后再次从**源同一连接**求 guard，与 snapshot.usageKey 及原槽保存的键相等。检查 schema、tracker、计数、data_version、resolver/签名、source/home 等上下文。源自身 perf-only 写可按 Q2 已证明的忽略规则保持有效；任何外提交即使只改 perf/meta 也按 data_version 保守拒绝。
4. 校验目标与源属于同一实际 DB；executor 只按源 databaseFile 创建 reader，API 仍拒绝不同 DB、另一路径文件、关闭重开或 freeze/import 目标。规范路径只是辅助，不能单凭相同文件名证明同库；本轮 DB 替换/路径重定向无法确认时 miss。目标迁移/schema 与源受保护版本不一致时 miss。
5. 在目标已 pin 的快照读 event/perf authority marker；存在任一 authority 则 false。源侧同样必须是普通 hot 槽；不能用 verifiedHistorySqlRead=true 绕过。Q2 的临时 tracker 必须在此目标普通 hot 连接有效，不能装到借用的冷 carrier。
6. 用 `structuredClone` 深拷贝明确的用量 payload。显式剔除 perf、quoteInputs、repositoryPeriods 及所有连接/源引用；不克隆混合槽整体。clone 失败返回 false，不把捕获失败伪装成真正查询的成功。
7. 由目标连接自己的 revision/schema/tracker/有效计数/data_version 与捕获的规范 context 重建 usage key；保留费用实际对应的 price identity，`perfKey` 置无效，`quoteInputs=null`，最后一次性安装目标槽。目标不继承 source 的 storeRevision/derivedRevision/observedDataVersion。
8. 成功或 false 后 executor 立即丢弃 snapshot 引用，再开始 writer sync。adopt 成功也不回写 source、不向 writer 反向导入、不供下一轮 reader 循环传递。

**费用 rekey 陷阱**：target 的连接键需要重算，payload 的价目身份需要保持。若 adopt 时当前目录已变，第一版可以直接 false；或者在 Q2 已分开的 priceKey 中保留旧身份，让下一次真实请求走重报价。不能用当前目录生成完整命中键，同时原封复制旧 costEstimate。API 无 filters 参数时，只为原槽 context 种槽；下一次 dashboard 仍按自己的 filters/pricing 算键，不匹配便正常 miss。

### 5.3 guard 的比较边界

- `total_changes()` 是连接累计已执行更改量；开库/迁移/TEMP 计数器使不同连接起点不同，rollback 后也不能依赖它恢复原数值。不能与 reader 的值比较、相减或平移成共同版本。
- `PRAGMA data_version` 用于**同一连接前后**检出其它连接提交；不同连接的数字无共同序。源 key 构建时值、capture 值、pin 后源值必须相等。只比较 capture 与 pin 后当前值，遗漏“构建→capture”窗口，会认证已经陈旧的槽。
- Q2 的 `total_changes - 2 * ignored_rows` 若获验收，也仍是该连接内的有效计数，不是跨连接数据库代际。schema/TEMP tracker 被改、连接被换或算术不安全时走完整键/拒绝 seed，不能重新初始化计数后续用旧槽。
- guard 失败可能仅造成保守 miss。它不能吞掉后续 SQL/authority/实际同步错误，也不能清空 source 全局数据；正常读继续走现有路径。

## 6. 保护窗口及证明链

建议 executor 精确顺序（保留原错误处理）：

```text
snapshot = store.captureUsageProjection()
reader = new UsageStore({ databaseFile: store.databaseFile })
await reader.open()
复制捕获的 homes/warnings/固定 resolver 及 serviceTierEvidenceInput
BEGIN
首次 SELECT 固定 reader 快照
reader.adoptUsageProjection(snapshot)   // 内部再核对来源原 key/槽/上下文
丢弃 snapshot
publishedStore = reader; publishedStatus = 原已发布 status
await syncUsageStore(store, ...)
finally: 清 published 引用 → reader ROLLBACK/close → checkpoint
```

capture 为 null 时不改变现有 reader 建立与发布。`reader.open()` 的真实失败仍沿原 catch/finally 结算；只有**缓存捕获/认证/复制**失败可退化为未 seed 的 reader，不能把整个 reader.open 的失败吞掉。

保护窗口与必须产生的结果：

1. **槽构建→capture**：同连接 raw events/source/quota、外提交、schema 改变、service-tier 输入或槽更换，捕获必须拒绝旧槽。若是 Q2 认证的 perf-only 自身提交，只能保留其用量部分，perf 另读。
2. **capture→await open→pin**：异步打开是实际交错窗口。任何源 relevant 写入、原槽替换、close/reopen、外提交，接收 false。即使 capture/pin 后 marker 一样，也不豁免外提交。
3. **pin→源 guard 复核**：外提交仍可保守拒绝；不重试到某次“碰巧一致”，不在 BEGIN 内 await 补证据。同步 clone/建槽也不引入 await。
4. **adopt→writer sync/外提交**：reader 继续服务已 pin 旧快照；source 后续写入不会修改已独立复制 payload。perf/quota/metadata/period 从 reader 快照读取，禁止把 writer 新 perf 填到旧用量上。reader 自己的键若保守失效，按原路径重算即可。
5. **sync 失败/rollback→release**：不把目标槽合回 writer；不把失败 sync 当新发布。writer 可能已经有其它成功的子提交，下一轮 capture 仍需从原槽和当前 guard 重新证明，不能凭“整轮失败”恢复旧 key。reader 无论是否 seed 都释放。

上述比较无需 writer/reader 的计数相等，也不新增持久全局版本。若 source 的缓存构建本身可能在未知事务/不一致快照中完成，capture 无法补救：先在 Q2 保持写事务不发布共享槽并验证 read-snapshot/key 绑定，无法证明时不允许 capture。手工 `BEGIN` 且没有 writeTransactionDepth 标记的反例必须使用明确入口检验，不能只测试受控 replaceFile。

## 7. 外提交、回滚与冷 archive 的具体边界

### 7.1 外提交与 schema

外连接至少两次提交覆盖：改 events、改 source identity、只改 perf/meta、改 event/perf authority，均不更新 fingerprint/generatedAt。旧源缓存必须被拒绝；fresh uncached reader 应看到实际提交内容。不能只制造一次 data_version 变化然后更新观测基准。

另测同连接 DDL、TEMP tracker/触发器删除或重建、schema 变后变回、close/open 和两个 DB 各自从相同小整数起步。tracker fallback 是 Q2 责任，Q3 必须拒绝失去构建时身份的旧槽。对读不出的 PRAGMA 不能声称“无变化”。

### 7.2 rollback 和失败 SQL

同连接写后 rollback 可以造成旧键不再匹配；接受保守重算。受控事务中计算的临时摘要不能种进可捕获槽；SAVEPOINT rollback、SQL ABORT/FAIL 和 sync 部分成功后失败也不能留下可认证的幻影 payload。

纯读 BEGIN 的事务身份也要明确：对 source 的手工事务，第一版一律不 capture；对 target，唯一允许的是 executor 明确 pin 的读事务。禁止给任意 isTransaction=true 的写事务开 adopt 后门。事务内新逻辑无 await；`releasePublishedReader` 不依赖新 API 才能关闭数据库。

### 7.3 冷 archive 回退

当前 `trySqlHistoryDashboard` 只服务 all、非 pinned/非写事务、单 event authority 段、无 event/perf overlay 和 perf authority 的受支持场景；每次走 `withVerifiedHistoryArchiveCandidate`，验证 registry/source identities/热冷冲突，并在异步文件验证后复核热输入。它的内部 reader 复用不是普通 published reader 的移交证明。

published reader 已有外层 BEGIN，当前冷 SQL 快路会返回 null，随后走完整 `historyArchiveEventUnionForRange` carrier；summary/metadata/period 共用已验证 carrier 的现有实现保持。Q3 不能让 pinned reader 伪造 `verifiedHistorySqlRead`、复用另一连接的 TEMP views 或跳过文件哈希。

所有这些情形必须拒绝普通 hot seed，并继续原历史路径：event authority、perf-only authority、多段、revision overlay、未知/损坏 authority、热冷冲突、缺段/文件篡改、段路径变化、源身份不符。缺段或损坏应该保留原错误，不能用旧热缓存返回不完整成功。

额外覆盖“capture 时无 authority → 外连接在 open/pin 之间授权并迁走热 events”，即使 marker 其它字段不变也拒绝；反向取消 authority 同样重读。pin 后才授权的 reader 则继续按它已 pin 的旧 marker/事实处理，不从 live registry 混入新段。实际冷文件在 pin 后丢失或损坏时仍由原验证失败，不能从热探针命中推导冷路径正确。

本轮主计划真实 seed 为全热，冷性能与实际冷档仍未测。小型冷夹具证明回退正确性，不代表实际冷档性能通过；不为 Q3 扩大到冷投影复制。

## 8. 独立测试矩阵与反例验收

本节是**待 Main 审查并运行的设计**，没有一条新增用例被本卡执行。A3 未来独占新 `test/q3-published-projection.test.js`，其 owner 获 Main 审查结论后才写；不得改 store 或放松现有测试。

### 8.1 可复用现有测试和夹具

- [history-summary-projection.test.js](../../test/history-summary-projection.test.js)：返回值隔离、事实变化、目录/FX/模型映射、service-tier、非 all、输入耗尽后的 SQL 重报价。
- [history-quote-inputs.test.js](../../test/history-quote-inputs.test.js)：跨 16,384 行 chunk 的逐字段/费用重放、预算耗尽和 unsupported input 的完整前缀 discard；本卡不改它。
- [perf-store.test.js](../../test/perf-store.test.js) `E-1`：raw local perf、状态/meta、外提交、未提交事务/rollback。Q2 拆键后由 Main 保留“perf 仍更新”的原断言。
- [history-wal.test.js](../../test/history-wal.test.js)：首轮、三轮 TRUNCATE、外 reader busy、同步中旧发布读、checkpoint 诊断。
- [w1-executor.test.js](../../test/w1-executor.test.js)：主线程无数据库、并发价目作用域、冻结、half-publish、close/timeout、sync 合并。
- [history-dashboard-sql.test.js](../../test/history-dashboard-sql.test.js)：verified SQL 复用、重报价且仍拒绝坏段、verification 时热写、pinned 旧视图、WAL 释放；有 `database.isTransaction` 能力门，skip 不能记成已覆盖。
- [history-dashboard-shared-carrier.test.js](../../test/history-dashboard-shared-carrier.test.js)、[history-cold-summary-prepared.test.js](../../test/history-cold-summary-prepared.test.js)、[history-summary-executor.test.js](../../test/history-summary-executor.test.js)：冷 carrier、prepared summary 同步性及 executor 冷读。
- [history-cold-perf-authority.test.js](../../test/history-cold-perf-authority.test.js)、[history-cold-revision-overlay.test.js](../../test/history-cold-revision-overlay.test.js)：perf authority、overlay 和绑定错误。
- [usage-store.test.js](../../test/usage-store.test.js)：D1 两次外提交/rollback/close-open，D3 reset/frozen quota，D4 future events/asOf/跨日周月与独立缓存。

复用 `test-support/perf-fixture.mjs` 的小夹具；纯用量/双连接反例优先字面量 INSERT，不用大冻结库制造测试。参考端使用固定预期数值和未带 seed 的普通完整查询；不能让 reference 调用同一 capture/adopt 或同一新失效判断来自证。

### 8.2 A3 小反例的最小完整集合

1. **正向移交**：source 暖 all → capture → 新 reader open/pin/adopt；assert 返回 true、不同实例、目标槽纯 payload 深独立、quoteInputs===null、perfKey 无效。同上下文摘要和未 seed 的 pinned oracle 全字段对拍；timeline 事实扫描减少，目标 perf 确实读取快照。
2. **计数跨连接不可比**：让源/目标有效计数显著不同，来源 guard 未变仍允许移交；另造两个 DB 的相同计数/marker，必须拒绝。不要把成功用例写成 `source.totalChanges === target.totalChanges`。
3. **构建→capture**：同连接 raw events UPDATE、source_files 身份 UPDATE、quota INSERT；以及外连接提交且 marker 不动，各用独立子例断言 null/false。模型/source/tier 改变同样验证。必须至少有一个变化不经 commitStoreRevision。
4. **capture→pin**：capture 后在 await open 窗口同连接写 events 或外连接提交，pin 后 adopt false；后者含外提交只改 perf/meta，仍保守拒绝。把源 guard 新值相互比较的错误变体必须被此例/前例抓住。
5. **pin→adopt**：先 pin，再外连接提交，再 adopt，允许按本方案 false；已有 reader 的完整读仍读旧事实。不能错误期待 pinned reader 看到新提交。
6. **adopt→新发布**：先成功 adopt，随后 source 提交新 events/ledger/perf/quota；reader 仍给旧快照的精确 payload/TPS，writer 在新读给新值。ledger 使用至少两个不同 output/duration 的 turn，逐 sample/response 断言，防止累计值掩盖错配。
7. **槽与上下文身份**：capture 后替换成深相等新槽、变 context、source close/reopen、换 DB handle，均 false。捕获 payload/context 后的非授权修改不能改变 target；不支持手工伪造 snapshot。
8. **原始与受控事务**：source 未结束 BEGIN/受控 writeDepth 时 capture 不可用；事务内 summary 不污染共享槽；commit 后新事实、rollback 后无幻影。SAVEPOINT/失败 SQL 测 guard 可保守 miss但摘要精确；target 未 pin/写事务调用拒绝或由明确内部 precondition 断言阻断。
9. **schema/tracker**：main/temp schema 变化、计数器/任一 tracker 触发器失效、重建后计数碰巧回到旧值，都不能接受旧 snapshot；PRAGMA guard 读取抛错只拒绝移交，正常 query 的真实错误仍传播。
10. **价格和输入归属**：adopt 后改变 rate/FX，目标确实读取完整 SQL，不使用 source buffer；费用、币种、分组成本和 timeline 与 fresh 精确相等。source 显式 discard/close 后仍成立；target 失效/close 后 source 再次重报价也正确。源返回值和目标返回值各自 mutation 均不污染另一侧。
11. **上下文/时间**：excludeHomes 的顺序/重复等价仍可命中；真正排除变化、details 切换、模型键集、service-tier resolver/签名、bucket/时区、精确 start/end 毫秒改变则 miss。now 推进但 resolved all 范围相同可复用；跨日/周/月及 quota reset 的动态 metadata/period/quota 每次正确。today/month/custom/quota 维持原路径。
12. **冷 authority**：event、perf-only、overlay/多段和 capture 后外授权迁热分别拒绝 seed，完整冷读不丢事实；缺段/篡改保留原错误。小夹具与热真实 probe 结果分开。
13. **失败和释放**：capture/adopt 不适用与 clone 失败回退 reader 正常计算；reader.open/pin/实际 SQL 失败、sync 失败、ROLLBACK/close 失败各保持原错误优先级，finally 不漏 close/checkpoint。首轮/无暖槽无新工作；三轮释放后 WAL 收敛，close 立即可删私有库目录。
14. **真实 executor**：后续由 Main probe 验证实际不同 reader 的 adopt；direct Store 测试本身不能满足此项。覆盖并发两请求不同目录/filters、双 tab、sync 成功/失败及无并发读的轮次，检查所有槽/连接最终释放。

具体独立突变至少包括：删“构建→capture”比较、删 pin 后比较、仅比 marker、比较跨连接数值、浅拷贝 payload、复用 source quoteInputs、用新价目给旧费用 rekey、继承有效 perfKey、绕过 authority、漏 reader.close。每个突变须由对应断言实际失败证明；本文只列设计，不宣称已执行突变。

## 9. 真实 probe、成本分解与收益判据

现有 [reader-hook.mjs](../validation/2026-10-27-codex-refresh-followup/probes/reader-hook.mjs) / [reader-executor.mjs](../validation/2026-10-27-codex-refresh-followup/probes/reader-executor.mjs) 及 ledger 版本可作为仪器参考。它们硬编码旧 codeRoot/identity/注入锚点；Main 应在本阶段独占 probe 文件中绑定本轮前后像和 SHA，逐锚点验证。不能不改身份直接把旧探针输出标为新补丁结果。

每个请求至少留以下可核查记录：

- 本轮源码 SHA、冻结输入/私有 DB 物理路径、worker/main 身份，确保主线程无 SQLite；首轮/catchup/settle 与测量分开。
- source/target 实例 ID、源 DB handle 生命周期、原槽 ID、capture/reader-pin/adopt/release 时序，实际 dashboard 选择 writer/published，捕获与接受原因；这些是诊断，不写产品 UI。
- 来源原缓存用量键、capture 和 pin 后**源同连接** guard 分量；目标独立键只作本地命中记录。schema/tracker/context/价格的拒绝原因明确。
- capture、reader.open、pin、guard、structuredClone/建槽各成本；整个 sync、sync 中 dashboard worker/往返、无并发读 sync 的成本。常规过滤请求若 miss，也计已付复制成本。
- timeline 事实扫描、SQL 行流、目标 perf 重建的实际次数/成本；quoteInputs 在 target 为 null。捕获耗时与父子方法包含时间分开，不能重复加总。
- 精确摘要对拍、独立 metadata/period/quota 对拍；TPS 逐 turn/output/duration 对拍；source/snapshot 引用释放与 WAL/checkpoint。

先 3–5 对短 AB/BA，验证 guard 能命中且减少目标事实扫描；不接受仅统计 hit。通过后按主计划至少 20 对正式配对，前后使用相同 now、价目/FX、时区、filters、输入与请求序列。

Q3 准入沿主计划：正确性反例通过；目标场景至少 15/20 对**整请求**更快，配对节省中位数至少 100 ms，并有 timeline 实际减少的证据；报告 p50/p95/max、全部反向样本及 clone/guard 成本。将同步中 published 请求、sync 后 writer 请求、ledger-only 与普通追加分组，不能混成一个收益率。只按主计划预先约定移除 generatedAt/perf indexedAt 的摘要对拍不替代这些字段自身的时刻语义检查。

额外需要一个避免转嫁成本的净收益账：没有 during-sync dashboard 的轮次、context 不匹配的轮次也会付 capture/clone 成本。记录每轮是否真正消费 seed、失败原因、未消费复制成本、sync 延迟与合计内存；对相同请求序列比较整轮完成时间。目标请求通过 100 ms 判据但其它正常场景持续退化时保留两组结果，交错复核后由 Main 判定，不凭单点暖读通过。

Q3 不应省下 perf 重读；perf 成本保留是设计行为。不得把减少 perf 调用也算“更大收益”，除非另有 Q2 独立证明和新验收。本补丁不负责完整 raw SHA 前缀/N2，不把旧 >8 s 失败或旧 70 ms 暖读当成当前速度。

内存遵守任务合计 8 GiB：只有 Main 的唯一 Node/npm/SQLite/browser 执行槽。小测试整树 Job 1,024 MiB/heap≤768 MiB，真实库/浏览器整树 Job 7,168 MiB/heap≤1,536 MiB，控制侧约 1 GiB；测试串行、浏览器最多两 tab。使用现有 run-with-memory-limit.ps1，不给每 agent 单独领 8 GiB。本方案不新增 128 MiB 输入副本，但纯 payload 深拷贝、旧槽暂存、序列化和原 source buffer 仍计峰值；Node RSS 与整 Job 峰值分别记录。

最终生产可见等待按主计划普通追加≥20、ledger-only≥20 个真实 60 s 周期执行；热 executor 配对不代替浏览器分布。冷盘、实际冷归档、2×/4×、长期运行只有实际测过才写通过。

## 10. 施工卡、文件单写与交付判定

1. **合同审查 / Main**：核对本文与 Q2 合同、A0 实测及主计划，确定有效用量键/context/priceKey 的最终字段。无需用户重复确认。本文记录的反例有新增事实时只由本卡 owner 更新，主计划由 Main 更新。
2. **Q2 / Main**：独占整个 `src/usage-store.js`，先完成 tracker/键拆分及原事务/独立缓存正确性。未明确 API 前不派一份臆造字段的 A3 测试。
3. **A3 / W2，审查后另接卡**：只写新 `test/q3-published-projection.test.js`，使用 capture/adopt 的已定签名，交独立夹具、字面量 oracle、逐项反例和待 Main 执行命令。本合同阶段尚未领取该文件写权，也未写测试。
4. **A4 / Main**：独占 store 和 `src/usage-executor.js`。store 实现两个同步内部方法，源槽保存必要上下文/身份，按目标 keys 建槽并强制 perf miss；executor 在现有 pin 点捕获/接收并对齐 `serviceTierEvidenceInput`，保留错误和释放。`history-quote-inputs.js`、service-tier 模块、schema 和 worker 消息不改。
5. **R1/V1 / reviewer + Main**：reviewer 只读，Main 独占运行；先小反例/旧回归再短配对。必要回归至少覆盖 summary projection、E-1 perf、WAL、并发定价/close、authority/冷 SQL/pinned carrier。只写未来命令清单不记通过；Main 保存实际命令/退出码/资源及源码 SHA。
6. **H1 / Main**：性能与正确性均入选才进入最终正式测量和门禁。Q3 无净收益则只撤回 Q3 新增产品 diff，保留 Q2 及证据；不能留下单边 capture/adopt 或永远无效的引用链。计划、验收、三个入口由 Main 更新。本轮不自行提交推送或切生产。

可明确裁定“不实施”的实证门槛：A0 不能证明有效计数；来源缓存的构建时 guard/context 不完整；真实 executor 无 published reader 覆盖；正确性反例失败；clone/guard/无人消费成本抵消净收益；内存超限；当前 cold 路径被绕过。每项应附本轮源码/输入/原始样本；没有运行就记“待证/未覆盖”，不能把旧阶段结果填进本轮格子。

完成本卡的交付是本文及其静态依据；产品正确性、性能与最终接入均由 Main 后续实际验收。没有执行 Node/npm/SQLite/browser、没有产品或 tests 修改，也没有 Git 写入。
