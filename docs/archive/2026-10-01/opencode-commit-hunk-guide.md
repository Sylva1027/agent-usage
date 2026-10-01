# OpenCode 提交 Hunk 清单（与 DSH / 并行工作的切分指南）

> **历史归档 · 2026-10-01**。原路径：`docs/opencode-commit-hunk-guide.md`。相关实现已纳入提交 `28568ef`。原提交顺序与 hunk 清单已失效；这些业务改动已整体提交。现行说明见[OpenCode 数据源](../../data-sources/opencode.md)，遗留验证见[任务清单](../../02-tasks.md)，资料关系见[本批归档索引](00-index.md)。

现状：工作区混有三方未提交改动 —— **DSH 适配**（已完成待提交）、**并行会话**
（GPT-6.1 价目 / pricing-auto / UI 界面工作，提交时仍在改动同一批文件）、
**OpenCode 适配**（本文作者）。`git status` 显示 29 个 tracked 文件被改 + 20 个未跟踪文件。

核心结论（已用 `git show HEAD` 与 `git diff -U0` 逐项核实）：

1. **提交必须排队：DSH → 并行工作 → OpenCode。** 这不只是 hunk 混杂，而是依赖关系：
   OpenCode 的代码直接建立在 DSH 未提交的重构之上（`HARNESS_ORDER`、
   `NON_CODEX_SOURCE_KINDS`、`harnessModels` 三元、`classify` 优先级注释在 HEAD 里都不存在）。
   DSH 不入库，OpenCode 合上去就是断的。
2. **并行会话提交前需确认一件事**：它重写了 `normalizeModel`，其中
   `resolved.matchType === "free"` 那行必须保留（现在有；`test/pricing.test.js` 里 5 个
   `-free` 测试就是证明，全绿）。丢了这行，免费模型会回退到付费计价。

## A 组：全新文件，直接 `git add`（6 个，全是 OpenCode 的）

```
src/opencode-usage.js
test/opencode-usage.test.js
docs/opencode-data-source.md
docs/opencode-adaptation-plan.md
docs/opencode-adaptation-plan.reviews.md
docs/opencode-adaptation-todos.md
```

以下未跟踪文件**不是** OpenCode 的，不要一起加：
`src/dsh-usage.js`、`test/dsh-usage.test.js`、`docs/dsh-*`（DSH 的）；
`src/pricing-auto.js`、`test/pricing-auto.test.js`、`test/pricing-models.test.js`、
`public/pricing-models.js`、`docs/gpt-6.1-*`、`docs/agent-usage-ui-*`、`docs/qa/`（并行会话的）；
`.archify/`、`.zcode/`、`.dsh-probe.mjs`（历史残留，建议不提交）。

## B 组：`git add -p` 可挑出的 OpenCode hunks

| 文件 | 拿这些 hunks | 跳过这些（别人的） |
|---|---|---|
| test/usage-core.test.js | 全部 3 个（2 个 import + 121 行测试块；整个文件都是 OpenCode 的） | — |
| test/pricing.test.js | import 行 + 5 个 `-free` 测试 | 2 个 GPT-6.1 Sol 测试 |
| test/usage-store.test.js | 末尾 fixture（`makeOpencodeStoreFixture` / `appendOpencodeMessage`）+ 3 个 OpenCode 测试。注：`DatabaseSync` import 已存在，不用加；import 行的 hunk 是 DSH 的 | `zstd` / `STORE_SCHEMA_VERSION` import 行 |
| test/server.test.js | `DatabaseSync` import 行 + `server imports an OpenCode data dir…` 测试块 | 其余 500+ 行（pricing-auto 等） |
| test/three-path-parity.test.js | `writeOpencodeUsage` + OpenCode parity 测试块 | GPT-6.1 的测试 |
| test/zcode-usage.test.js | 唯一的 hunk（`OpenCode: []` 那几行） | — |
| src/pricing.js | `ZERO_RATES` 常量、`if (model.free) rates = ZERO_RATES;`、`minimumModelRate = !model.key && !model.free;` 三个 hunk | `normalizeModel` 重写、`gpt-6.1-sol`、日期、`contextTierFor` 特例、currency 的 dsh 改动 |

## C 组：与未提交工作融死、现在切不开的

这些 hunks 与 DSH / 并行工作的改动在同一行或同一 hunk 里，`git add -p` 无法分离
（硬拆只能手工 `e`dit，极易出错，不建议）。**等 DSH 与并行工作入库后，
这些 hunk 自然只剩下 OpenCode 的部分，届时一路 `y` 即可。**

- `src/usage-core.js`：import 块（与 dsh import 相邻）、分类注释行、unsupported reason 行。
  其余 `if (opencode…)` 块虽是独立 hunk，但语义离不开 DSH 分支，同进退。
- `src/usage-store.js`：`STORE_SCHEMA_VERSION` 8→10（语义含 DSH 的 8→9，不一起提交会
  corrupt 版本链）；`harnessModels` 四元（含 DSH 的三元底子）；import 块；注释行。
- `public/app.js`：`HARNESS_ORDER` 整行（含 DSH 建的三分量）；`bucketForChannel`
 （含 DSH 的两条分支）；空状态文案行。
- `public/timeline-utils.js`：`NON_CODEX_SOURCE_KINDS` 单行（含 DSH 建的常量）。
- `public/i18n.js`：3 条中英文案（每条都含 DSH 文本）。
- `test/recent-selections.test.js`、`test/app-render.test.js`（空状态行）、`test/i18n.test.js`：同上，同行融合。
- `src/server.js` 的 label 链、`README.md` / `README.en.md` 的来源段落与配额段落、
  `docs/README.md`（10 行全加项里 7 行是对方的：UI/pricing 计划、QA、GPT-6.1×2、DSH×2）。

## 建议的提交顺序

1. **DSH**（`docs/dsh-change-summary.md` 已就绪）：`src/dsh-usage.js`、`test/dsh-usage.test.js`、
   docs 三件 + 上面 C 组里属于它的 hunks。
2. **并行会话**（GPT-6.1 / pricing-auto / UI）：合并前确认 `matchType === "free"` 行保留。
3. **OpenCode**：A 组全加 + B 组挑 hunk；C 组届时已变干净。

## 附：门禁基线（供提交前复跑）

- `node --test`：304 pass / 0 fail（基线 245 + P0 5 + P1 16 + P2 7 + P3 4 + P4 1 + P5 1 + 并行会话 25；
  数字随并行工作浮动，以全绿为准）
- `npx tsc -p tsconfig.checkjs.json`（用 `npx.cmd`，`npm.ps1` 被执行策略禁止）
- `npx biome check --formatter-enabled=false <本次文件>`（全仓 check 在 `public/styles.css` 有他人存量报错，只查本次文件）
- `node src/static-export.js`（快照应含 OpenCode）
- 真库对照：直读活库的独立 SQL 与 `node src/cli.js summary` 的 OpenCode 行逐位一致
  （此前实测 44,044,846 与 62,164,162 两次一致；注意活库持续写入、拷贝 db+wal 时勿漏 `-shm`）
