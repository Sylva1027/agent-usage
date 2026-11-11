# 交付、构建与升级

**实际启用状态（2026-11-11）：已在本机切换到新安装并保留真实历史及升级前备份。** 地址为 <http://127.0.0.1:3765/>；[启用核对与恢复位置](validation/2026-11-11-activation/README.md)记录该次兼容修复、96 项定向检查、历史逐条核对及临时数据清理。

更新：2026-11-11。主程序继续使用浏览器、Node.js 和 SQLite，发布版本以 `package.json` 的 `releaseVersion` 为准（当前 `0.85a`；npm 版本为 `0.8.5-a`）。本页维护交付操作；[实际启用记录](validation/2026-11-11-activation/README.md)说明已安装版本与历史兼容结果，[精简和修复记录](validation/2026-11-11-simplification.md)说明之后的源码验证。源码提交不自动更新在用安装。

## 本轮已有改造

| 环节 | 现在的实现 |
| --- | --- |
| 来源采集 | Codex/DSH 保留解析检查点，追加主要处理新增内容；有完整身份依据时，新会话及新目录直接登记 |
| 历史与统计 | 原事实继续保留；额度、汇总、纪录、元数据和周期统计复用磁盘索引与持久计算结果 |
| 查询与通知 | 查询一个已提交版本；并发刷新合并，真实新值提交后通知页面，刷新完成不以旧值代替 |
| Windows 核验 | 可选原生助手使用已有NTFS变更日志，合并同一对象/父目录的重复记录，危险变更标志保留 |
| 无原生证明 | 自动使用既有内容核验与完整处理路径，可能较慢，统计口径不变 |
| 资源 | 后台网关默认512MiB堆，计算进程224MiB/semi4MiB；这是堆预算，不是整棵服务树硬上限 |

六种来源的“增量”发生在不同层，不能把变化源更新等同于原始输入全部续读：

| 来源 | 原始提取与现在可复用的工作 |
| --- | --- |
| Codex | 普通 `.jsonl` 保存解析状态与字节检查点，验证旧前缀后续读；压缩表示转换及身份／内容不符走校验或重解析 |
| DSH | 压缩日志保存解析检查点与验证状态，受支持的追加可续读；截断、改写或证明不足走既有回退 |
| Claude Code | 变化会话逐行提取，以有界行存储完成 message 去重，大会话可落盘；尚无持久字节续读检查点 |
| WorkBuddy | 变化会话单遍提取并以有界行存储分组，大会话可落盘；尚无持久字节续读检查点 |
| ZCode | 变化 SQLite 库使用有界缓存、迭代查询及磁盘临时区提取；尚无持久行游标续读 |
| OpenCode | 变化 SQLite 库迭代 assistant 消息并关联会话；尚无持久行游标续读 |

后四种在无归档、来源身份一致、旧事实是连续尾部且逐行精确相同等条件下，复用已存前缀并只插入新增事实；不满足时事务性替换变化源，原始提取仍可能完整进行。该快路径不适用于已登记冷段，不能据此承诺六种解析都完全增量化。文件消失保留已经索引的事实。

主库持有近期事实、冷段登记、授权及修订覆盖；冷包与相邻 manifest 保存封存事实及冻结价目／证据；`.history-cache/` 是可重建的冷热查询投影和持久业务视图。已有投影可在重开、普通追加时复用，身份和依赖变化时校验或恢复。不能用删除主库／冷包来修复派生缓存。具体职责与压实恢复见[历史保留与转移](history-retention.md)。

归档校验复用依赖有效租约，助手协议为 `windows-archive-read-lock-v2`，保护数据库、manifest 及完整父路径。该租约不要求启用 NTFS journal；来源追加证明使用现有 journal，是另一项能力。助手缺失、协议旧或租约不可用时，普通查询保留完整内容校验回退；显式压实须取得所需租约，否则拒绝切换，保留原历史。

较早测量见[Q10报告](archive/2026-11-11-experiments/architecture-20261101/Q10-REFRESH-REOPEN-REPORT.md)；后续状态见[多标签报告](archive/2026-11-11-experiments/architecture-20261101/WINDOWS-MULTITAB-ACCEPTANCE-REPORT.md)与[最后验收计划](archive/2026-11-11/plans/2026-11-10-windows-final-acceptance.md)。1秒刷新／200ms切换已转后续目标，当前custom既有偏差获用户接受；原八小时及本次两小时资源收敛均未完成。Linux/macOS专项适配仍另行安排。

## 运行与开发环境

- 运行：Node.js `>=23.8`；本轮实测为Windows x64、Node 26.13.0。程序无生产npm依赖，完整运行目录可直接执行 `node src/cli.js run`。
- Windows原生构建：PowerShell 7、Rust/Cargo及其Windows主机工具链所需的链接器。Rust只用于构建，普通运行不调用Cargo。
- 源码检查：`npm.cmd ci` 安装开发依赖。Windows用`pwsh`，不是Windows PowerShell 5.1。

原生助手是普通子进程，不是桌面客户端或系统服务；它不启用/修改系统journal。没有现成journal时来源证明回退，归档文件租约仍可独立使用。配套的`exe`应由这份源码构建，不能仅凭旧文件还在就认定已升级；旧助手即使能启动，也不代表支持归档 v2 协议。

## 构建与校验助手

在新的程序目录、仓库根目录运行：

```powershell
npm.cmd run native:build
npm.cmd run native:check
```

构建使用锁定依赖和明确的Rust主机target，生成：

```text
native/windows-source-proof/bin/windows-source-proof.exe
native/windows-source-proof/bin/windows-source-proof.build.json
```

回执记录target、二进制摘要及Cargo清单、锁文件、构建脚本和Rust源码摘要。`native:check`只读校验，不需要Rust；发现旧源码对应的产物、丢失回执或字节不匹配时返回非零，重新构建后再交付。运行时不会为补回执临时编译。

在当前工作区只做隔离构建，可指定两个输出位置，保留原安装文件：

```powershell
npm.cmd run native:build -- -OutputDirectory output/native-candidate/bin -TargetDirectory output/native-candidate/target
npm.cmd run native:check -- -OutputDirectory output/native-candidate/bin
```

编译失败保留原产物和回执；成功后以临时文件替换，避免暴露复制到一半的exe。两份文件应一起分发，交付前再次执行check。程序使用中的exe可能被Windows锁定，升级采用新程序目录。

## 双版本运行包

在同一份集成源码上执行，发布名取 `package.json` 的 `releaseVersion`（当前 `0.85a`）：

```powershell
npm.cmd run native:check
node --test test/package-release.test.js
npm.cmd run package:release -- output/releases
npm.cmd run package:check -- output/releases --browser
```

`scripts/package-release.mjs` 使用 Node 标准库和 PowerShell 7 `Compress-Archive` 生成 ZIP，系统 `tar` 检查目录并解压逐文件核验。无需生产 npm 依赖。助手及回执必须先准备好；脚本只读运行 `native:check` 的同一检查，不调用 Cargo。缺少或不匹配时停止，先显式 `native:build` 后再打包。

- `0.85a.zip`：普通版，将五个 `waifu:start/end` 区块裁掉，根节点改为 `data-edition="standard"`，排除全部皮肤专属文件和工作室，保留原 `styles.css` 与共享主界面模块。
- `0.85a-waifu.zip`：waifu 版，保留源码页面、皮肤模块、工作室和 40 张运行 WebP。
- `release-manifest.json`：两个 ZIP 的 SHA-256、各自逐文件 SHA-256 和共同核心摘要。共同核心包含全部相同运行文件，仅排除两版 HTML 差异及皮肤专属文件。
- `acceptance-http.json` / `acceptance-browser.json`：实际解包后的核验结果；仅 HTTP 运行不会标记浏览器通过。浏览器启动受环境限制或断言失败时记录原因并以非零退出。

允许交付的输入仅为 `src/**/*.js`、列明的 `public` 核心与皮肤文件、`public/assets/skins/**/*.webp`、`package.json`、`LICENSE`，以及 `native/windows-source-proof` 的 Cargo 清单／锁文件、`build.ps1`、Rust 源码、`bin` 中的 exe／回执。不会把 `.gitignore`、Cargo target、作者 PNG、开发依赖、实验、测试资料、用户数据或历史文档装入运行包。waifu 先取得一份文件快照，普通版从同批字节派生；两包共同核心逐文件相等才生成摘要。打包时仍需在最终集成后重新生成候选，不能把并行修改期间的包当成最终版。

输出路径必须位于当前工作区 `output/` 内的全新子目录，拒绝越界、符号链接／junction 和已有目标；不会覆盖旧包，也不会递归删除用户指定目录。脚本只回收自己新建的 `.package-*` / `.check-*` 暂存目录和 palette 合成夹具。重复生成可使用 `output/releases-final` 等新目录，候选 ZIP、清单和验收回执保留在输出目录。

`scripts/check-release.mjs` 从实际 ZIP 解压，校验清单、摘要、版本和原生回执，执行 CLI help，再从两份包各自导入服务器，以现有 `test-support/skin-palette-fixture.mjs` 隔离数据和 `listen(0, "127.0.0.1")` 分配端口。检查主样式／工作室交付边界、固定 242800 Token 及两包统计总计、模型／渠道分组与费用摘要一致。`--browser` 还复用 `resolveBrowserRuntime`：普通版预置旧 waifu 偏好，检查首屏、刷新、主题、无皮肤入口／配色／资源请求与 Tab/Escape；waifu 版检查偏好、入口、选择器和深浅角色图片。覆盖中文桌面及英文窄窗口。

浏览器沿用维护环境，可在 PowerShell 设置 `AGENT_USAGE_PLAYWRIGHT_MODULE`（现有 Playwright 的 `index.mjs` 完整路径）和可选 `AGENT_USAGE_EDGE_PATH`。省略 `--browser` 可单独运行 ZIP／原生／HTTP 检查。若本地 sandbox 拒绝 Edge 启动，保留失败记录，由允许启动浏览器的主线程或 CI 重跑同一命令，不把该次标为通过。CI 在 Windows / Node 24 上构建配套助手、生成并验收双包，作为构建 artifact 保存；Node 22 继续现有测试矩阵。

2026-11-11 的 C 阶段候选位于 `output/r2-c-candidate-20261111/`（并行修改期间快照，最终须重建）：普通包 67 文件、waifu 包 116 文件，共同核心 SHA-256 为 `55aff2ad86ef39fa1b96f667e3c386279590254a59a08da770f7e7bbb4187119`。四项打包测试通过；实际 ZIP 目录／解压后逐文件摘要、CLI help、两包助手回执和隔离 HTTP 检查通过，两包各 242800 Token。浏览器已尝试，sandbox Edge 报 `0x80070005`／crashpad 管道错误，在进入页面前退出；`acceptance-browser.json` 保留失败日志，普通版旧偏好隔离与 waifu 恢复的真实浏览器断言待主线程重跑。暂存、解包和合成数据目录已释放，不涉及在用安装或真实用户数据。

## 保留历史的升级顺序

1. **准备新程序目录。** 保留旧程序目录，解压所选普通／waifu 运行包并校验助手。运行包包含`src/`、相应版本的`public/`、`package.json`、`LICENSE`和`native/windows-source-proof/`所需源码、构建脚本、exe及回执；不带用户日志、索引、配置、`node_modules`、Cargo target或实验输出。
2. **停止对应的旧实例。** 前台用原终端Ctrl+C；后台使用旧程序的`node src/cli.js stop`，若原来传了`--state-file`，停止时继续传同一个路径。`stop`会停止该注册文件内的全部实例，仅在这些实例均计划停止时使用。确认旧实例实际退出后再操作数据；若报告`still running`，先确认该实例的退出状态，暂不进行覆盖或切换。
3. **完整保留状态。** 停稳后把原`~/.codex-usage/`复制到新的备份目录，包括SQLite、仍存在的WAL/SHM、汇总库、价目和导入配置。自定义数据库/配置路径也一起保留；有外置冷历史时保留完整目录及相邻manifest，以及已有压实的 `compaction.json` 和新旧包。冷热投影可重建，但保留副本有助于按原状态重开。不能只备份还能找到的原始会话日志：已被上游清理的历史可能只剩索引事实。
4. **从新目录按原参数启动。** 使用原`--home-dir`、`--state-file`和端口等参数，保持原数据位置。数据库打开过程执行迁移、补齐索引及派生结构，已有事实继续使用；不要删除索引、手改`user_version`或用空库重建代替升级。第一次派生准备可能较慢。
5. **确认后保留回滚点。** 查看全部范围、较早月份、各来源与费用，再确认一次真实新增能出现。确认后继续日常使用；旧程序及升级前备份保留到自己确认稳定为止。

默认前台启动：

```powershell
node src/cli.js run --host 127.0.0.1 --port 3765
```

新程序沿用默认用户数据位置；`--home-dir`是来源home参数，不能随意指向空目录来模拟原用户升级。

## 备份工具

以下是独立staging路径示例，不是替换活动库的命令：

```powershell
# 无已登记冷段时，创建含已提交WAL的单库备份及manifest
node src/cli.js history backup "E:/usage-staging/source.sqlite" "E:/usage-staging/before-upgrade.sqlite"
node src/cli.js history verify "E:/usage-staging/before-upgrade.sqlite"
node src/cli.js history restore "E:/usage-staging/before-upgrade.sqlite" "E:/usage-staging/restored.sqlite"

# 有外置冷段时，导出完整包，保留整个目录
node src/cli.js history export "E:/usage-staging/source.sqlite" "E:/usage-staging/history-bundle" --home-dir "E:/usage-staging/home"
```

单库备份明确拒绝遗漏已登记冷段；完整包包含主库、冷段及冻结上下文。上述目标均使用新路径。完整转移、导入实例及证据边界见[历史保留与转移](history-retention.md)。配置文件仍按上面的状态目录方式备份。

## 两种回滚

**压实回滚**由当前程序操作同一主库：先结束该实例的写入与活动查询，保留当前主库、新旧冷包、manifest 和原 `compaction.json`，再运行：

```powershell
node src/cli.js history compact "E:/usage-staging/source.sqlite" "E:/usage-staging/compacted" --rollback
```

这逆向切换冷包引用并重绑定已有投影，保留压实之后的追加与旧值修订；不是恢复旧主库。回滚后查询 all、旧月份并重开核对。不得在回滚窗口结束前清掉旧包或映射；完整映射可用于中断后重试，详情见[压实步骤](history-retention.md#显式压实已有归档)。

**程序回滚**先停新实例，完整保存升级后的状态（包括外置冷包、manifest、压实映射及配置），再用**旧程序＋升级前的完整数据副本**恢复到独立位置。旧代码不直接接管升级后的数据库；旧版视图不保证包含升级后的新增或修订。升级后副本继续保留，避免丢掉后来又被上游清理的记录。恢复/导入只生成独立副本，不自动切换活动服务。

## 最终交付核对

以本次受测提交生成运行包，核对 `src/`、`public/`、`package.json`、`LICENSE` 及原生助手源码／脚本／exe／回执。排除用户数据、开发依赖、构建 target、实验与历史文档。运行 `native:check`，记录源码与产物摘要；使用隔离数据检查页面、来源刷新、缺失助手回退以及受影响的数据升级／恢复路径。

历史三态助手、双冷包、压实中断与保留历史的验收见[交付报告](archive/2026-11-11-experiments/architecture-20261101/DELIVERY-HANDOFF-REPORT.md)和[最新启用记录](validation/2026-11-11-activation/README.md)。引用旧证据时保留其版本和覆盖范围，不把此前的文件数量、速度或已测结果直接套到新包。

## 收尾清理

按明确清单区分可重建产物、原始输入、历史事实与恢复备份。释放消费者后才删除生成副本，保留回执；逻辑文件大小和磁盘实测净增分别记录，不累计不同清理窗口的数值冒充本轮释放。现成工具及约束见[清理操作](history-retention.md#收尾存储盘点与清理)，本轮结果见[工作区清理记录](validation/2026-11-11-workspace-cleanup.md)。

## 开发验收入口

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run skins:check
$env:AGENT_USAGE_TEST_NATIVE_BUILD = '1'
node --test test/windows-source-build.test.js
```

构建用例只在`output/`下的临时副本编译，验证路径含空格、回执缺失、源码变化、产物损坏及编译失败保留旧文件；默认测试环境未明确启用时标注跳过。原生行为测试可显式设置`Q6_TEST_HELPER`指向隔离exe。交付核对结果见[本轮收尾记录](archive/2026-11-11-experiments/architecture-20261101/DELIVERY-HANDOFF-REPORT.md)。
