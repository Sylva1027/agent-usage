# 历史保留：操作入口与恢复

2026-10-26：按用户最新适度优化范围已完成20项交付，性能差距及最终源码门禁结果如下。以下路径均替换为自己的隔离副本/新目录；本轮只在临时副本实际演练，未提交生产库或切换正式服务。自动归档保持关闭。

## 检查、完整转移与恢复

在项目根目录使用 PowerShell 7、Node 24。单库备份与完整 bundle 是不同入口：已登记冷段的完整转移使用 export/import，不能只复制主 SQLite 文件。

```powershell
node src/cli.js history archive "D:/staging/source.sqlite" --dry-run
node src/cli.js history export "D:/staging/source.sqlite" "D:/staging/new-bundle" --home-dir "D:/staging/source-home"
node src/cli.js history import "D:/staging/new-bundle" "D:/staging/new-import"
```

export 发布主库、已登记段、价目和提供的 tier 上下文；import 独立验证后在新目录生成 runtime，不替换活动数据库。`--home-dir` 应指向本次需要冻结 tier 的来源目录；未提供时不能声称捕获了该目录的 tier。

单库包的检查/恢复命令如下。restore 只写新的目标，不切换在线服务；完整历史恢复优先使用上面的完整 bundle import。

```powershell
node src/cli.js history backup "D:/staging/source.sqlite" "D:/staging/new-package.sqlite"
node src/cli.js history verify "D:/staging/new-package.sqlite"
node src/cli.js history restore "D:/staging/new-package.sqlite" "D:/staging/new-restored.sqlite"
```

## 显式封存

候选由 `createHistoryArchiveCandidate()` 生成，范围为毫秒半开区间 `[startMs,endMs)`；`verifyHistoryArchiveCandidate()` 验证候选。当前 CLI 不自动生成或选择候选。默认 dry-run 阈值仍为 400,000 events / 180 天；低于阈值的显式范围只用于隔离 staging 演练。

```powershell
node src/cli.js history archive "D:/staging/source.sqlite" --commit "D:/staging/verified-candidate.sqlite" --backup "D:/staging/new-precommit-bundle" --home-dir "D:/staging/source-home"
```

该入口先 prepare，再发布并验证新的完整备份，最后在事务中重新核对候选/源事实并提交。失败先检查具体错误；重放同一候选也必须指定另一个新的 backup 目录。已有备份目录不覆盖。events 提交已验收；纯 ZCode tps-v2 无级联依赖范围的 perf 正式提交与 CLI 重放已验收，纯 Codex tps-v2 completed/request_e2e/explicit 范围正式提交、依赖级联回滚及 CLI 重放已验收，不能将留热事实描述成已淘汰。

## 独立查看导入实例

需要冻结导出价目/tier 时，使用显式导入实例工厂，而不是仅将普通服务的 databaseFile 指向 runtime。以下在项目根目录启动独立随机端口：

```powershell
@'
import { createHistoryArchiveImportServer } from './src/server.js';
const server = await createHistoryArchiveImportServer('D:/staging/new-import');
server.listen(0, '127.0.0.1', () => console.log(server.address()));
process.once('SIGINT', async () => { await server.close(); });
'@ | node --input-type=module -
```

按用户最新UI决定，主页常驻历史归档框已移除。归档目录、UTC日统计及sealed原始事件分页继续由HTTP接口提供；snapshot请求读取冻结副本，缺失段返回明确失败。导入实例不提供 full 文件系统详情（400），不允许写计价配置（405）。`POST /api/history/imports` 只生成新的独立导入目录，不接管活动服务。

## HTTP用法

以下端口替换为上一步启动的隔离实例端口；不指向生产服务。目录中的segmentId及startMs/endMs可作为后续请求参数，时间范围为毫秒半开区间，events按原始id分页。

```powershell
$base = 'http://127.0.0.1:49152'
Invoke-RestMethod "$base/api/history/archives"
Invoke-RestMethod "$base/api/history/archives/<segmentId>/days?startMs=<startMs>&endMs=<endMs>"
Invoke-RestMethod "$base/api/history/archives/<segmentId>/events?startMs=<startMs>&endMs=<endMs>&limit=100"
# 有nextAfterId时，下一页添加 &afterId=<nextAfterId>；冻结读取添加 &snapshot=<snapshotId>。
```

sealed事件页展示不可变封存原件；当前汇总仍应用有效修订，不把旧原件重复加到当前总数。普通活动实例可用POST /api/history/imports，JSON体为sourceDirectory和importDirectory两个新目录路径；导入实例自身不接受会改变冻结context的操作。完整包损坏/冷段缺失不会返回部分成功结果。

## 本轮已证与待完成

真实数据副本的 events-only 及 schema22 Codex perf 正式提交均已完成具名依赖故障全回滚、正式CLI新完整备份重试和实际恢复，完整业务对拍通过。后一次演练从108465事件/50001热性能样本中移走5312事件/732性能样本；恢复前置完整包后全部原热事实及冻结context恢复一致。新进程移走原路径后仍采用冻结价目/tier、保留非空 perf 已通过。旧 93,977→84,029 差额仍是 [evidence_gap](history-gap-evidence.md)，今天的恢复不证明旧差额已追回。

性能数字按用户最新要求作为参考目标保留，后续性能优化由其他计划承接。本轮不为追数继续添加复杂度。最终源码工程门禁已通过并记录下节；本轮未部署、迁移或重启生产。

## 性能参考目标与逐项差距

同一组100万事件正式冷热布局（499719冷/500281热），完整SQL、token、费用、coverage与来源缺失对拍通过。默认scheduler保留，实际通过HTTP PUT改变费率和FX。当前记录为单组实测，不能与p95等同；原20新进程×20请求统计未执行。最后一次backup小优化仅测100k，不外推为下面的百万结果。

- **启动到health**：参考2.5秒；实测0.128157秒，低2.371843秒（约94.9%）。health不代替完整首次请求。
- **首次完整dashboard**：参考10秒、原单次上限15秒；实测14.887058秒，较10秒多4.887058秒（48.9%），低于15秒0.112942秒。
- **真实费率/FX变更后的重算**：参考skipCheck 2秒、原单次上限5秒；实测3.466706秒，较2秒多1.466706秒（73.3%），低于5秒1.533294秒。这次包含真正重报价。
- **同完整价目稳定请求**：参考2秒；两次0.880120/0.910222秒，低1.119880/1.089778秒（56.0%/54.5%）。
- **服务OS峰值内存**：参考1GiB；实测317288448B（302.59MiB），低756453376B（721.41MiB，约70.4%）。服务PID去重，seed峰值481484800B另报，不混入服务RSS。测试整树Job硬限制与服务RSS是不同口径。
- **WAL与统计覆盖**：已有连续写入、受阻读者释放后checkpoint收敛的独立行为证据；本组百万诊断未测三轮有写sync下的WAL稳态，不能宣称百万WAL<100MB或20组p95已验。更大规模、旧Node二进制及所有kind/并发故障组合也未覆盖。

原始百万证据：output/history-retention-quote-replay-million-20261026/diagnostic.stdout.json、review.json、phases.json及first.cpuprofile；99产品输入绑定见该目录inputs.json。首请求带profiler，非无扰动SLA。同期100k前像对照与最后指纹小改各有完整strict payload/金额对拍，分别见output/history-retention-quote-replay-20261026和output/history-retention-fingerprint-row-reuse-20261026。

## 最终工程门禁

最终330个输入文件（11285657B）只取hash不复制，前后零漂移。typecheck、lint及format均exit0；lint保留63 warnings/4 infos。完整测试在test-concurrency=1、heap512MiB、用户授权7GiB整树Job下串行完成：3272项中3247通过、0失败、25条件跳过，820882.954ms。此前资源受限的17个真实浏览器用例全部实际通过；没有沿用排除名单来冒称全套成功。全部日志、跳过名单、退出码和前后输入摘要在output/history-retention-closeout-20261026/review.json。
