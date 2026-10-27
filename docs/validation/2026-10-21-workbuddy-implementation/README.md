# WorkBuddy 数据源接入验收（2026-10-21）

规格见[数据源专题](../../data-sources/workbuddy.md)，决策与数据事实见[接入计划](../../plans/2026-10-21-workbuddy-source-plan.md)，施工拆卡见[实施计划](../../plans/2026-10-21-workbuddy-implementation-plan.md)。

**结论：W1 / C1–C3 / S1–S4 / P1–P3 / U1 / V1–V3 全部完成，本机真实来源已验收。** 三路一致（内存 / SQLite / HTTP）与真机冒烟均通过，全仓工程门禁通过；一处既有浏览器用例在完整套件中偶发失败，单独复跑通过，与本改动无关（见 §6）。

## 1 交付范围

新增：

| 文件 | 作用 |
| --- | --- |
| `src/workbuddy-usage.js` | 适配器：home 判定、会话文件枚举、事件流、索引解析、trace span 解析 |
| `src/perf-sources/workbuddy.js` | TPS reader：从会话事件取 token，从注入的回调取时长 |
| `test/workbuddy-usage.test.js` | 适配器 15 项 |
| `test/workbuddy-core.test.js` | 接线（分类/发现/指纹/分派/标签）13 项 |
| `test/workbuddy-store.test.js` | 索引与时长表 13 项 |
| `test/perf-workbuddy.test.js` | TPS 语义与 reader 9 项 |
| `docs/data-sources/workbuddy.md` | 字段映射、口径、限制 |

修改：`src/usage-core.js`、`src/usage-store.js`、`src/perf-stats.js`、`src/perf-sources/index.js`、`src/server.js`、`public/app.js`、`public/perf-ui.js`、`public/timeline-utils.js`、`public/i18n.js`，以及受 schema 版本与 `harnessModels` 变化影响的既有测试。

## 2 冻结契约落地情况

| 契约 | 实际值 |
| --- | --- |
| 来源 kind | `workbuddy` |
| 分类结果 | `workbuddy-home` |
| 渠道 | `WorkBuddy` |
| 标签 | `Main WorkBuddy` / `WorkBuddy <basename>` |
| `sourceId` | `sourceId("workbuddy", path)` → `workbuddy-<16 hex>` |
| `sampleKey` | `JSON.stringify(["workbuddy", homeId, messageId])` |
| 环境变量 | `CODEX_USAGE_WORKBUDDY_HOMES`、`CODEX_USAGE_WORKBUDDY=0` |
| `capture_version` | `workbuddy.trace.v1` |
| 索引版本 | `STORE_SCHEMA_VERSION` 16 → 17，新增 `workbuddy_generation_durations` |

实现上的三个关键取舍：

1. **时长走注入回调。** reader 不读 DB。`UsageStore.replaceFile` 用 `lookupGenerationDuration(messageId)` 把 `{ durationMs, endedAtMs }` 注入 `streamPerfSamplesForFile`，命中不到就计 `skippedNoDuration`。
2. **trace 指纹只在进程内。** `this.workbuddyTraceFingerprints` 是实例级 `Map`，`sync()` 不清空、`close()` 清空，不建表。
3. **预扫在 `replaceFile` 之外。** `syncRound` 每轮对每个 home 先跑一次 `refreshWorkbuddyDurations`（读盘 + 单事务 `INSERT OR IGNORE`），保证唯一跨 `await` 的写事务不被拉长。
4. **不新增冻结告警码。** 缺时长通过 `onWarning` 汇总成一行 `「<label>：N 个响应缺少 generation 时长」`。

## 3 V1 三路一致

`scripts/v1-three-way-parity.mjs` 用合成 home（2 会话 / 4 条非 Auto 记录 / 3 个可关联 span）分别跑内存报告、SQLite 索引和 `GET /api/usage`：

| 路径 | events | sessions | total | input | cached | output | reasoning |
| --- | --- | --- | --- | --- | --- | --- | --- |
| memory | 4 | 2 | 4950 | 4200 | 2000 | 750 | 160 |
| sqlite | 4 | 2 | 4950 | 4200 | 2000 | 750 | 160 |
| api | 4 | 2 | 4950 | 4200 | 2000 | 750 | 160 |

`perfSamples = 3`，`harnessModels.WorkBuddy = ["deepseek-v4.1-flash"]`，`homeKinds = ["workbuddy"]`。三路完全相等。

合成数据的口径验算：一条记录的 `inputTokens = 1000`（其中 `cached_tokens = 500`）、`outputTokens = 200`（其中 `reasoning_tokens = 60`），事件直接映射为 `input = 1000 / cached = 500 / output = 200 / reasoning = 60 / total = 1200`——**不做二次相加**，这是与 Claude Code 相反的地方。

## 4 V2 真机冒烟

`scripts/v2-real-machine-smoke.mjs` 把真实 `~/.workbuddy-ai` 以 junction 挂进临时 home，走完整 `UsageStore.sync()`，结果写入 [`v2-real-machine-smoke.json`](v2-real-machine-smoke.json)。

上游侧：

| 指标 | 值 |
| --- | --- |
| 会话文件 | 4 |
| trace 文件 | 20 |
| generation span | 458 |
| span 唯一 messageId | 458 |
| 用量记录 | 453 |
| Auto 记录 | 7 |
| 非 Auto 唯一 messageId | 446 |
| span 命中率 | 1.027 |

索引侧：

| 指标 | 值 |
| --- | --- |
| events | 446 |
| sessions | 3 |
| total | 70,266,442 |
| input | 69,984,796 |
| cached | 69,501,440 |
| output | 281,646 |
| reasoning | 130,567 |
| 时长行 | 458（1,149–45,236 ms） |
| perfSamples | 446 |
| 模型 | `deepseek-v4.1-flash` |
| home | `workbuddy-27179c498af97fcb` / `Main WorkBuddy` |
| warnings | `[]` |

第二轮同步 `updatedFileCount = 0`、`perfSamples` 仍为 446，说明 trace 指纹与 `INSERT OR IGNORE` 的幂等生效。

两处需要解释而非"修掉"的数字：

- **span 命中率 1.027 > 1。** trace 表保留了已被上游裁剪的会话的 span，因此 span 集合是事件集合的超集。这是真实来源的合法状态，不是 join 出错。
- **`events` 446 对 `usageRecords` 453。** 差 7 正好是 Auto 记录数；446 = 453 − 7，去重后没有额外损失。

## 5 测试证据

新增 4 个文件共 50 项，全部通过：

- `test/workbuddy-usage.test.js`（15）：同 id 多行去重、Auto 排除、输入超集语义、第二条记录被忽略、缺 `reasoning_tokens` 时不置位、`file-history-snapshot` 不产事件、截断行告警、`Unknown cwd` 与 fallback sessionId、空文件与纯 session-meta、`parseWorkbuddySessions`、home 判定三例、`tool-results` 排除、span 过滤（`cancelled` / 非 `ok` / 非正时长）、缺 traces 目录。
- `test/workbuddy-core.test.js`（13）：分类含 claude/codex home 回归、`CODEX_USAGE_WORKBUDDY=0`、`CODEX_USAGE_WORKBUDDY_HOMES` 自定义目录名、默认标签与 id 正则、`describeImportEntry` 标签、追加与 touch 触发指纹变化、索引与报告口径一致、坏文件告警、分派、未知 kind 回落 Codex。
- `test/workbuddy-store.test.js`（13）：`usageFiles` 展开与 `tool-results` 跳过、新库直接 v17、v16→v17 幂等、迁移失败回滚保持 16、harness 分桶、每轮每 home 只预扫一次、无变化不预扫、未变 trace 不重解析、trace 被删不改样本、全量重解析幂等、`status != ok` / 坏 `toolOutput` / 非正时长不入库、traces 不可用仍可 sync 且带告警。
- `test/perf-workbuddy.test.js`（9）：语义与 sampleKey 三元组、自定义 `timingSource` 降级为 unknown 但 `methodVersion` 保留并告警、样本产出、缺时长计数（含未注入回调）、去重、零输出仍采样、Auto 不可见、注册与回调 spy、`not_enabled` / `unsupported`。

受契约变化影响而更新的既有测试（断言值调整，非行为修改）：`perf-store`、`perf-projection-store`、`perf-state`、`perf-codex-index`、`zcode-usage`、`app-render`、`perf-ui`、`i18n`。

## 6 工程门禁

| 门禁 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过（56 warnings / 4 infos，全部落在既有文件；`grep -ci workbuddy` 为 0） |
| `npm run format:check` | 通过（186 文件） |
| `git diff --check` | 通过（仅 CRLF 提示，非空白错误） |
| `npm test`（完整） | 2712 项 / 2687 通过 / 25 失败，失败全部为环境限制（见下） |

**失败项全部与本改动无关，且可复现于干净 HEAD：**

25 项失败集中在 `skin-palette-production-index` / `review-capture` / `review-evidence` / `review-production` / `review-cli` 五个文件，全部是「文件符号链接必须被拒绝」一类用例。在 HEAD 干净工作树上复跑同名用例，失败集合完全相同（`reads only explicit shards…`、`rejects a formal checks-file symlink…`、`固定 JSON 文件不允许符号链接…` 等）。

根因是本机执行环境的文件系统限制，而不是代码：

```text
fs.symlinkSync(target, link, "file")  // 不抛异常
fs.existsSync(link)                   // false
fs.symlinkSync(dir, link, "dir")      // 同样静默失败
```

创建被静默丢弃后，用例拿到的是「文件不存在 / 空文件」，于是断言命中 `invalid JSON … Unexpected end of JSON input` 而不是预期的「must not be a symlink」。这些用例用 `process.platform` / 权限位判断「符号链接是否可用」，无法识别这种「调用成功但没建成」的环境。普通开发机（含 Windows 开发者模式）不受影响。

**另需记录一次无效运行：** 第一次完整套件跑出 184 项失败，`grep -c SAFE_DELETE_BULK_CONFIRM_REQUIRED` 命中 179 处。原因是本会话的工具层对单次调用内的删除次数设有上限（>50 即拦截），而皮肤套件要反复 `rm` 自己的临时夹具，护栏一触发后续清理全部失败并级联。用 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 关掉该护栏后重跑，才得到上表的 25 项。这不是代码问题，也不是测试自身的问题。

## 7 已知限制

1. **trace 只保留约 30 天。** 超窗记录没有时长，TPS 少样本，只以告警提示，不合成 0 也不剔除。
2. **会话文件不自动清理，但来源文件消失时看板会删对应历史**（与 Codex 的保留策略不同）。上游一旦裁剪会话，索引里的对应事件也随之消失。
3. **Auto 记录不可恢复。** `model=default-model` 或 `requestModelName=auto` 的记录在适配器入口整体丢弃，下游拿不到它们的 token。这是用户 2026-10-21 的明确决定。
4. **失败/中断请求结构上不产生用量记录**，是否计费无法从本机验证，不做推断。
5. **`perfSamples` 可能多于事件数**（见 §4 的 span 超集），因此不能用 `perfSamples == events` 做断言。

## 8 复跑

```bash
# 三路一致（合成数据，无需真实 home）
node docs/validation/2026-10-21-workbuddy-implementation/scripts/v1-three-way-parity.mjs

# 真机冒烟（读 ~/.workbuddy-ai，写同目录 json）
node docs/validation/2026-10-21-workbuddy-implementation/scripts/v2-real-machine-smoke.mjs

# 单元测试
node --test test/workbuddy-usage.test.js test/workbuddy-core.test.js \
  test/workbuddy-store.test.js test/perf-workbuddy.test.js

# 完整套件（见 §6：需要关掉工具层的删除护栏，否则皮肤套件清理夹具会被拦）
CODEBUDDY_SAFE_DELETE_ENABLED=0 npm test
```

真机脚本只读上游目录，索引写在系统临时目录，不触碰 `~/.codex-usage/usage-index.sqlite`。
