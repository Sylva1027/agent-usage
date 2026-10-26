# 历史保留与转移操作

当前实现保留已成功索引的历史，来源消失后仍可查询。正式服务尚未切换，自动封存默认关闭。下面以独立 staging 副本为例；所有目标文件或目录必须使用新路径。

## 检查与单库备份

在仓库根目录使用 Node.js 24 和 PowerShell 7：

```powershell
node src/cli.js history archive "E:/retention-staging/source.sqlite" --dry-run
node src/cli.js history backup "E:/retention-staging/source.sqlite" "E:/retention-staging/backup.sqlite"
node src/cli.js history verify "E:/retention-staging/backup.sqlite"
node src/cli.js history restore "E:/retention-staging/backup.sqlite" "E:/retention-staging/restored.sqlite"
```

dry-run 只读并报告是否达到默认 400,000 条事件、180 天边界。单库备份包含已提交 WAL、价目和显式捕获的 tier 证据。需要捕获 home 下的定价/tier 上下文时，backup、export、commit 命令均可添加 `--home-dir <dir>`。

已有已登记冷段时，单库备份会拒绝遗漏外部段；使用下一节的完整包。restore 不覆盖已有文件，也不切换活动服务。

## 完整包导出与导入

```powershell
node src/cli.js history export "E:/retention-staging/source.sqlite" "E:/retention-staging/exported" --home-dir "E:/retention-staging/home"
node src/cli.js history import "E:/retention-staging/exported" "E:/retention-staging/imported"
```

完整包带齐主库、已登记冷段、价目和 tier 上下文，并以完成标记发布。导入会验证包并生成新 runtime；不能覆盖目标或接管活动数据库。移动历史时保留整个包目录，不能只复制主 SQLite 文件。

以导入包的冻结上下文启动独立实例，使用显式工厂，不能只把普通服务的 `databaseFile` 指向 runtime：

```powershell
@'
import { createHistoryArchiveImportServer } from "./src/server.js";
const server = await createHistoryArchiveImportServer("E:/retention-staging/imported");
server.listen(0, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${server.address().port}`);
});
'@ | node --input-type=module -
```

该实例采用包内价目/tier，关闭自动发现和自动价格刷新。用量、性能、汇总和冻结读取保持导入语义；导入实例不提供 full detail，返回 400，修改价目返回 405。

## 生成候选与正式封存

候选生成是独立模块入口；dry-run 不创建候选。选择明确的半开时间范围 `[startMs, endMs)`，先在 staging 副本操作：

```powershell
@'
import { DatabaseSync } from "node:sqlite";
import { createHistoryArchiveCandidate, verifyHistoryArchiveCandidate } from "./src/history-archive.js";
const source = new DatabaseSync("E:/retention-staging/source.sqlite", { readOnly: true });
const candidate = "E:/retention-staging/cold.sqlite";
try {
  await createHistoryArchiveCandidate(source, candidate, {
    startMs: Date.parse("2026-01-01T00:00:00Z"),
    endMs: Date.parse("2026-02-01T00:00:00Z"),
  });
  await verifyHistoryArchiveCandidate(candidate);
} finally {
  source.close();
}
'@ | node --input-type=module -

node src/cli.js history archive "E:/retention-staging/source.sqlite" --commit "E:/retention-staging/cold.sqlite" --backup "E:/retention-staging/precommit-bundle" --home-dir "E:/retention-staging/home"
```

正式入口重新准备和校验候选，创建并验证一个新的完整前置备份，然后在同一写事务登记段、授权并删除对应热事实。支持的 ZCode、Codex tps-v2 样本及依赖按已验证集合提交；NULL 时间、段外和不支持的事实留热。旧候选缺少原生能力证据时只提交 events，不授予 perf 权威。重放仍须使用新的备份目标。

冷段文件及相邻 manifest 是历史的一部分。移走或损坏实际段时，完整查询明确失败；不会返回不完整热统计或把缺段显示成零。恢复原文件后可重试。

## HTTP 与页面

现有实例提供：

- `GET /api/history/archives`：段目录及可用状态。文件存在仅代表状态检查，不等于内容已验证。
- `GET /api/history/archives/<segmentId>/days`：原始封存日线。
- `GET /api/history/archives/<segmentId>/events?startMs=<ms>&endMs=<ms>&limit=100&afterId=0`：按原始 ID 分页的 sealed 明细；`limit` 为 1–500，以返回的 `nextAfterId` 继续。
- 上述 GET 可追加 `snapshot=<id>`，采用既有产品冻结快照；快照过期返回 410。
- `POST /api/history/imports`，JSON 为 `{"sourceDirectory":"E:/retention-staging/exported","importDirectory":"E:/retention-staging/imported"}`：生成新导入目录，成功 201，目标存在 409。不会切换当前实例。

2026-10-26 按用户要求移除主页的历史归档维护框，主页不再加载或刷新归档目录。上述接口及 CLI 保留；日线与明细返回 sealed 原值，主汇总采用当前有效修订。

## 修订、恢复与已证范围

同源冷事件值修订、迟到新增，以及 project-log 非空纯删除已有恢复与故障重试证据。纯删除保留缩水诊断。ZCode/Codex tps-v2 的已声明修订范围已验证；其他来源的破坏性删除、身份迁移和未支持的依赖集合继续拒绝或留热。普通 sync 的事实事务与后续汇总事务分别提交，不宣称整轮 sync 原子。

恢复完整状态时，把前置完整包导入另一个新目录，采用其冻结上下文核对，再另行决定服务切换。不要覆盖正在使用的主库或手工修改 `user_version`。当前保留 schema21 回退。

真实 staging 的故障、重试、转移和恢复结果见[执行账本](validation/2026-10-22-history-retention/README.md)。10 月 21 日 93,977→84,029 的差额仍为 `evidence_gap`；现有自洽备份不证明该旧差额已恢复。

## 工程与性能状态

固定交付状态仍为 18/20。百万冷热容量、20 组新进程 p95/RSS/WAL 门槛及最终整项验收尚未完成；小规模诊断不能替代它们。类型、lint、格式和全套测试按当前源码摘要记录于执行账本。

本机测试统一由主审串行执行，使用 `scripts/run-with-memory-limit.ps1` 的整棵子进程树 1GiB 提交内存硬限制；Node heap 上限不能替代这个 OS 限额。生产部署、写库和重启不属于本轮已执行操作。
