# 历史保留与转移操作

更新：2026-11-09。当前实现保留已成功索引的历史，来源消失后仍可查询。本文操作没有切换正式服务，自动封存默认关闭。下面以独立 staging 副本为例；新备份、导入与压实目标文件或目录必须使用新路径。

## 历史由哪些文件保存

- 主库：近期事实、来源身份、额度、冷段登记和授权、旧值修订覆盖。上游来源已删时，这些已索引事实仍是历史依据。
- 冷包和相邻 manifest：封存事实及其摘要、价目与证据快照。多包与近期事实共同参与查询；sealed 明细保留原值，主汇总应用有效修订。
- `.history-cache/`：冷热查询投影及持久业务视图，按主库版本、归档身份和依赖复用；它是派生结构，不能替代主库与冷包。已有投影在普通追加时更新变化部分，压实切换可重绑定身份而不复制未变冷事实；依赖失效或恢复需要时仍可能重建。
- `compaction.json` 及新旧包：压实恢复和逆向切引用的依据。完整映射的保留期必须覆盖回滚窗口。

读取复用仍验证 manifest、授权、修订覆盖、文件身份和有效租约；跨独立校验操作重新进行完整 SHA，无有效租约时普通读取走原完整验证路径。租约只在受控操作内存活，释放后不能继续沿用证明。六来源原始解析的实际能力见[交付页](15-delivery-upgrade.md#本轮已有改造)。

## 检查与单库备份

在仓库根目录使用 Node.js `>=23.8` 和 PowerShell 7（`pwsh`；最近记录的运行环境为 Node 26.13.0）：

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

## 显式压实已有归档

压实清除归档里的空闲页，保留全部逻辑表、行 ID、额度分类、价格和证据快照。以后生成的归档候选也采用相同紧凑构建。普通刷新和服务启动不会自动执行压实。

在维护窗口对已经备份的独立实例执行：

```powershell
node src/cli.js history compact "E:/retention-staging/source.sqlite" "E:/retention-staging/compacted"

# 使用同一主库和映射回滚引用；保留切换后新增的事实和修订
node src/cli.js history compact "E:/retention-staging/source.sqlite" "E:/retention-staging/compacted" --rollback
```

目标目录首次必须不存在。命令逐包构建、完整对拍和落盘，写入 `compaction.json`，然后用主库事务一次切换全部引用，并完成已有查询投影的身份更新。主库提交与投影提交是分开的恢复阶段，不能称整轮原子。旧包继续保留。提交期间主库有其他写入时拒绝过期切换；有完整映射时再次执行同一命令可以恢复或确认已完成的操作。没有完整映射的残留目录不会被覆盖，应保留排查，并为重新执行选择新目录。

显式切换需要 Windows 原生助手提供 `windows-archive-read-lock-v2` 文件及完整父路径租约，且两侧归档均为独立的 DELETE 模式包。助手的构建、校验见[交付与升级](15-delivery-upgrade.md#构建与校验助手)；文件租约不要求 NTFS journal 已开启。缺失助手、旧协议、保护不可用或验证失败时不切换登记；普通查询的完整验证回退继续有效，不能据普通读取成功判定压实租约可用。

恢复覆盖的四个中断位置为主库提交前、提交后、投影事务写入中、投影提交后；重试重新核验并完成投影恢复。压实回滚使用**当前主库＋原映射**，逆向切引用后保留后来追加和修订，再查询与重开核对；不能用升级前主库覆盖当前主库代替压实回滚。旧程序遇到已完成或尚待完成的投影重绑定，是现有两种兼容检查；不代表任意旧程序可以接管新版数据。

压实需要额外保存新包和临时工作文件；不会删除旧包腾空间。`compaction.json` 记录新旧路径，返回结果的 `retainedFiles` 列出保留的旧包。只有确认新包正常、回滚窗口已结束，且其他数据库登记、导出包或冻结快照不再引用旧路径后，才考虑人工回收。本命令不自动清理。

压实阶段原有安全、恢复、延迟结果见[归档压实报告](../experiments/architecture-20261101/ARCHIVE-COMPACTION-REPORT.md)，保留其中失败和后续补证。更新的 Windows 多标签门及未完成项见[多标签报告](../experiments/architecture-20261101/WINDOWS-MULTITAB-ACCEPTANCE-REPORT.md)；11月9日的新候选验收尚未执行，不能沿用旧结果冒充通过。

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

恢复完整状态时，把前置完整包导入另一个新目录，采用其冻结上下文核对，再另行决定服务切换。不要覆盖正在使用的主库或手工修改 `user_version`；旧 schema 兼容沿用现有验证与迁移入口。

**程序回滚**与上面的压实回滚不同：停止新程序后，先完整保存升级后的主库、外置包、manifest、映射及配置，再使用旧程序和升级前完整副本。旧程序不直接打开升级后的活动库；旧副本不保证包含升级后追加、修订及上游后来删除的记录，所以升级后的完整状态必须另存。完整包的冻结读取也不等于自动合并新旧两套状态。

真实 staging 的故障、重试、转移和恢复结果见[执行账本](validation/2026-10-22-history-retention/README.md)。10 月 21 日 93,977→84,029 的差额仍为 `evidence_gap`；现有自洽备份不证明该旧差额已恢复。

## 工程与性能状态

10月历史保留阶段的固定交付记录为 18/20，不将后续小规模检查改记为该阶段整项通过。当前、一年、两年冷热数据已有后续报告；原100次／20次统计矩阵和原八小时验收仍未完成。本次六组短对照正确性及资源门通过，9项相对速度退化导致候选未采纳、两小时未启动；最终交付核验完成。范围与欠项见[本次计划](plans/2026-11-09-windows-parallel-closeout.md)及[结果表](../experiments/architecture-20261101/WINDOWS-PARALLEL-CLOSEOUT-REPORT.md)。

本轮重型测量串行执行，网关512MiB、执行器224+4MiB堆保持不变；服务树RSS及补充估计按512MiB门记录，浏览器分开。Node堆限制和采样不能替代原资源受限整机诊断，该覆盖仍未补齐。在用数据写入、生产部署和服务重启不属于本轮已执行操作。

## 收尾存储盘点与清理

用户最新授权允许清理本次及此前计划已经无用的大型生成物，包括成功和失败副本，覆盖旧计划“仅列清单”的限制。Main 结束计时和核对、释放消费者后才执行删除。准备阶段只读扫描生成物的文件元数据，不打开数据库、不读取大来源正文做摘要。

现成入口如下，默认模式只做盘点：

```powershell
pwsh -NoProfile -File experiments/architecture-20261101/windows-closeout-cleanup.ps1 -Mode Inventory
pwsh -NoProfile -File experiments/architecture-20261101/windows-closeout-cleanup.ps1 -Mode SelfTest
# Main 编辑盘点生成的 manifest-template 副本，列出绝对 targets/path、reason 和释放证据
pwsh -NoProfile -File experiments/architecture-20261101/windows-closeout-cleanup.ps1 -Mode Preview -Manifest output/windows-parallel-20261109/cleanup-approved.json
# 仅在最终计时结束、依赖已释放时由 Main 执行
pwsh -NoProfile -File experiments/architecture-20261101/windows-closeout-cleanup.ps1 -Mode Delete -Manifest output/windows-parallel-20261109/cleanup-approved.json
```

盘点覆盖项目 output、截图／preview、dist、依赖与已知构建缓存；用户历史、根源码／public／.git 和无关工作不在清理范围。脚本保护 tracked 与非忽略的未跟踪工作，拒绝越界、父子目标重叠、链接路径及目录内重解析点；删除前重新核对绝对后代路径、元数据身份和仍保留的依赖。`dependencies` 中活动输入与基线必须明确释放并填写 `releaseEvidence`，`retainedPaths` 保留仍需的证据、唯一 raw／capture 和权威历史，不能因旧计划结束就整根推断为可删。只有生成副本可作为目标。

分类按消费者决定：最终基线、当前两年起点和原始来源先保留；已完成的工作库、查询投影、临时转移副本、冗余截图及构建 target 可在消费者释放后回收；清理回执、必要的小型结果与日志继续保留。压实旧包需等所有数据库登记、完整包、快照及回滚窗口释放，不能仅凭文件名认定过期。

逻辑大小按每个路径的长度统计，硬链接会重复计入；`UniqueAllocatedBytes` 用卷／文件 ID 去重，并以 `GetCompressedFileSize` 记录分配量估计；`ReclaimableAllocatedEstimateBytes` 只计该目标包含全部硬链接的文件。不同目标合并删除可能释放更多共享分配，估计不等于实际回收；打开句柄、共享 extent、目录元数据和同时写入也会影响结果。只有删除回执的卷空闲首尾差是该窗口实测净增，不能累加旧回执或把逻辑 TB 当成物理回收。原回执中已经删除的路径须查当前存在性，若重建则视为新候选。

本轮盘点、既有回执核对和最终删除回执统一保存在私有 `output/windows-parallel-20261109/cleanup/`。已删除4962目标，逻辑786.505GB，E／C删除窗口净增617.574／46.106GB，合计663.681GB；按核准盘点含6827份旧截图／图像副本。35份保留SQLite均存在、两处关键库quick_check正常，13个当前／一年／两年压实包及原始输入／历史保留。948MB旧轨迹已验证压缩至约55MB，原失败判定与小证据保留；旧派生工作库需重建后才能再次计时。原八小时与长期资源欠项没有因清理而变为通过。
