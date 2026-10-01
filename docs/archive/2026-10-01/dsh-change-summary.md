# DSH 适配改动清单（交给 codex 执行 commit）

> **历史归档 · 2026-10-01**。原路径：`docs/dsh-change-summary.md`。相关实现已纳入提交 `28568ef`。原提交顺序与 hunk 清单已失效；这些业务改动已整体提交。现行说明见[DSH 数据源](../../data-sources/dsh.md)，遗留验证见[任务清单](../../02-tasks.md)，资料关系见[本批归档索引](00-index.md)。

本文是 **DS Harness（DSH）用量数据源适配** 改动的交付说明，供另一个 agent 审阅并提交到 `main`。

## 交付目标

给看板新增第三个数据源 **DSH**（原有两个是 Codex、ZCode），做到与 ZCode 同等完整：
自动发现 + 增量索引 + 三路一致（内存 / SQLite / 静态导出）+ 测试。

## 验收状态（提交前请复跑）

```bash
node --test                      # 期望 241 pass / 0 fail / 0 todo
npx tsc -p tsconfig.checkjs.json # 期望 exit 0
npx biome check --formatter-enabled=false .   # 期望 exit 0（40 warnings 为存量）
npx biome format .               # 期望 exit 0
node src/static-export.js        # 期望 exit 0
```

> Windows 注意：`npm.ps1` 被执行策略禁止，请用 `npm.cmd` / `npx.cmd`。

## ⚠️ 提交前必读：工作区里混有**非本次改动**

`git status` 中的改动**并非全部来自本次 DSH 适配**。仓库里还有一批此前未提交的工作
（定价自动更新、界面样式等）。请按下表区分，**不要把两者混进同一个 commit 的描述里**。

### A. 纯 DSH 改动（可整体提交）

| 文件 | 说明 |
|---|---|
| `src/dsh-usage.js` | **新增**。DSH 会话日志解析与归一化 |
| `test/dsh-usage.test.js` | **新增**。单元与语义测试（31 例） |
| `docs/dsh-data-source.md` | **新增**。DSH 数据源说明 |
| `docs/dsh-adaptation-plan.md` | **新增**。实施计划与实施记录 |
| `docs/dsh-change-summary.md` | **新增**。本文件（交付说明，可随提交入库，也可只作为交接文档） |
| `src/usage-core.js` | DSH 接线 7 处（发现 / 分类 / 指纹 / 分派 / 索引 / report） |
| `src/usage-store.js` | DSH 接线 4 处 + `STORE_SCHEMA_VERSION` 8→9 迁移 |
| `public/timeline-utils.js` | `hasSelectedCodexSource` 排除列表加 `dsh` |
| `test/three-path-parity.test.js` | 新增 DSH 三路一致断言 |
| `test/recent-selections.test.js` | 限额按钮来源判定断言扩展 |
| `test/zcode-usage.test.js` | `harnessModels` 期望值补 `DSH` 键 |
| `test/server.test.js` | 新增 DSH home 导入测试 |
| `package.json` | 只有一处改动：`engines.node` `>=22.13` → `>=23.8` |

`package.json` 已核对 `git diff`，**仅** engines 一行，可整体提交。
`src/usage-core.js` 中那处 `classifyImportDirectory` 的顺序调整（把 ZCode/DSH 判据提到 Codex 之前）
**是 DSH 适配的必要修复**（见下文 bug 2），属于本次改动。

### B. 混合改动（同一文件里既有本次改动，也有此前未提交的工作）

这些文件**不能只按「DSH 改动」审阅**，请通读全文后决定：

| 文件 | 本次改动 | 此前的未提交工作 |
|---|---|---|
| `public/app.js` | 抽 `HARNESS_ORDER` / `bucketForChannel` / `newHarnessModelBuckets` / `harnessModelLists` / `claimHarnessKeys`；`pricingHarnessGroups`、`metadataFromReport`、计价分组渲染改三元；空状态文案 | 另有约 200 行改动（非本次） |
| `public/i18n.js` | 三条文案中英（空状态 / 目录提示 / `INVALID_IMPORT_DIRECTORY`） | 另有其它文案改动 |
| `src/pricing.js` | `currencyForEvent` 判据扩为 `zcode`/`dsh` → CNY | `getDefaultPricingCatalog` 新增、汇率注释修订 |
| `src/server.js` | `describeImportEntry` 加 `dsh-home` 标签分支；该函数改为 `export` 以便测试 | **大量定价自动更新工作**：`getAutomaticPricingStatus` / `refreshAutomaticPricing` 导入、`/api/pricing` 响应加 `automatic` 字段、`pricingRefreshPromise`、价格版本冲突校验等 |
| `README.md` / `README.en.md` | Node 版本、来源说明、两个 DSH 环境变量、限额口径 | 定价自动更新段落 |
| `test/i18n.test.js` | `INVALID_IMPORT_DIRECTORY` 英文期望值 | — |
| `test/app-render.test.js` | 新增 5 个 harness 归组测试 | — |
| `test/usage-store.test.js` | 新增 3 个 DSH store 测试；`user_version` 断言改用导出的 `STORE_SCHEMA_VERSION` | — |
| `docs/README.md` | 新增两条 DSH 文档链接 | — |

> `src/server.js` 是**最容易看错**的一个：它绝大部分 diff 来自定价自动更新，本次只动了
> `describeImportEntry`。用 `git add -p src/server.js` 时需要留意。

### C. 与本次无关，**请勿**混入本次提交

| 文件 | 说明 |
|---|---|
| `public/index.html`（12 行） | 本次未改动 |
| `public/styles.css`（165 行） | 本次未改动 |
| `src/pricing-auto.js`（未跟踪） | 本次未创建 |
| `test/pricing-auto.test.js`（未跟踪） | 本次未创建 |
| `.zcode/`（未跟踪） | 此前会话留下的计划文件，建议不要提交 |

### D. 建议删除，不要提交

| 文件 | 说明 |
|---|---|
| `.dsh-probe.mjs` | 本次侦察用的**临时只读探针**（分析 app.asar 与 zstd 日志结构）。不属于产品代码，建议删除。它只读、不写盘 |

## 建议的提交方式

若希望本次提交**只含 DSH 适配**，可只暂存 A 组 + B 组里属于本次的 hunk：

```bash
git add src/dsh-usage.js test/dsh-usage.test.js \
        docs/dsh-data-source.md docs/dsh-adaptation-plan.md \
        src/usage-core.js src/usage-store.js \
        public/timeline-utils.js package.json \
        test/three-path-parity.test.js test/recent-selections.test.js \
        test/zcode-usage.test.js test/server.test.js
```

**B 组（含 `src/server.js`）混有他人未提交工作，建议全部用 `git add -p` 只挑本次 hunk。**
若你（人类）确认那些未提交工作也一并入库，则整组 `git add` 亦可。

**建议提交信息：**

```
feat(dsh): 新增 DS Harness 用量数据源

读取 ~/.dsh/sessions 下的会话日志（多帧 zstd），按与 ZCode 同等规格接入：
自动发现、SQLite 增量索引、内存/SQLite/静态快照三路一致。

- src/dsh-usage.js：逐帧解压 + assistant/message 的 data.usage 抽取
- 字段口径：DSH 的 inputTokens 与 cacheReadTokens 为并列计数，
  需重构为看板要求的 cached <= input 超集，否则计价会退化为最低费率估算
- DSH 无配额数据，不参与 Codex 5h/week 限额窗口
- pricing：未收录模型按 dsh 渠道前缀判为 CNY
- 新增 CODEX_USAGE_DSH_HOMES / CODEX_USAGE_DSH 两个环境变量
- engines 提升到 >=23.8（zstd 解压需 22.15+，测试 fixture 用 zstdCompressSync 需 23.8+）

测试：241 pass / 0 fail；三路一致断言见 test/three-path-parity.test.js
```

## 本次改动修复的 4 个 bug（建议在 commit 描述或 PR 里提及）

1. **`zstdDecompressSync` 对畸形帧不抛错**，而是静默返回空 buffer。原实现靠 `try/catch` 判坏帧是死代码 —— 损坏帧会被当成空记录放过。已改为按空内容判坏帧并加测试锁定。
2. **`classifyImportDirectory` 优先级错误**：`codexHomeLooksUsable` 只看「有没有 `sessions` 目录」，而 `~/.dsh/sessions` 同名，导致 `~/.dsh` 被判成 `codex-home`。
3. **`dshHomeLooksUsable` 判据过松**（修完上一条后暴露）：`~/.codex/sessions/.tmp` 里也有 jsonl，导致 `~/.codex` 被判成 `dsh-home`。已改为必须存在 `sessions/<slug>/<sessionId>/session.v<N>.jsonl.zstd`。
4. **`STORE_SCHEMA_VERSION` 被 v7 迁移当参数用**：把常量从 8 改成 9 后，那条迁移的落点被静默改成 9，使新的 v8→9 迁移永不执行。已改为字面量 8。

## 已知边界（非缺陷，已确认接受）

- **DSH 不参与限额窗口**：DSH 没有配额存储。`nonCodexHomeIds()` 的 SQL 用的是白名单
  （`NOT IN ('main','jetbrains','extra','codex')`），`dsh` 自动被排除 —— 行为正确。
- **计价弹窗的 DSH 分区为空**：真实数据里 DSH 全部用量都是 `deepseek-flash`，
  而该模型已被 `ZCode` 分区按「先到先得」认领（同一模型可能被多个 harness 使用，
  不去重会在弹窗里重复出现）。这是有意的取舍。
- **「Codex home kinds」概念散落在 4 处**（`usage-store.js` 的 SQL、`app.js` 的
  `CODEX_HOME_KINDS`、`timeline-utils.js` 的反向列表、`service-tier-evidence.js` 的另一处）。
  对 DSH 都是 fail-open，行为正确，但将来新增数据源需同步改多处。**本次未动。**

## 验证依据（简要）

以真实 DSH 数据（`~/.dsh`，443 事件 / 4 会话）验证：

| 路径 | events | total |
|---|---|---|
| 独立手写实现（不复用 `src/dsh-usage.js`） | 349 | 54,251,370 |
| `buildUsageReport`（内存） | 349 | 54,251,370 |
| `UsageStore`（SQLite 索引） | 349 | 54,251,370 |

三条路径逐位一致；CLI 摘要 `DSH + DSH Subagent` 之和亦等于该值。
`/api/usage` HTTP 实测 200 且含 DSH 渠道；DSH 缓存命中率 99.7%（非天真映射会出现的 420%）。

> 注：上表数字是某一时刻的快照。DSH 会持续往同一会话文件追加，事件数与总量会随时间增长。

## 仍需人工确认

- 3765 端口上运行的服务是**改动前启动的**，需重启才能看到 DSH（`node src/cli.js run`）。
- 浏览器目检：时间分布图三种模式中 DSH 渠道的显示、悬浮提示与图例、中英切换后的新文案。
