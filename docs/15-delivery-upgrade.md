# 交付、构建与升级

更新：2026-11-10。现有实现继续使用浏览器、Node.js 和 SQLite；本页是交付操作入口。11月5日已接受的性能只适用于当时已测范围；后续冷热历史、压实和多标签验收分别保留自己的结果。本次最终产物与四个小场景已核验，有限批次性能候选未过保护门、未合入生产；最终运行代码保持6fcc95d。结果见[集中收尾表](../experiments/architecture-20261101/WINDOWS-PARALLEL-CLOSEOUT-REPORT.md)，历史失败不改写。

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

较早测量见[Q10报告](../experiments/architecture-20261101/Q10-REFRESH-REOPEN-REPORT.md)；后续状态见[多标签报告](../experiments/architecture-20261101/WINDOWS-MULTITAB-ACCEPTANCE-REPORT.md)与[本次计划](plans/2026-11-09-windows-parallel-closeout.md)。原八小时门未完成，两小时收尾不能替代它；Linux/macOS专项适配仍另行安排。

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

## 保留历史的升级顺序

1. **准备新程序目录。** 保留旧程序目录，在新目录构建并校验助手。预构建运行包应包含`src/`、`public/`、`package.json`、`LICENSE`和完整`native/windows-source-proof/`，后者包含源码、脚本、exe及回执；不带用户日志、索引、配置、`node_modules`、Cargo target或实验输出。
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

本次用最终恢复的基线副本串行完成一套运行包核验和四个小夹具场景：有效／缺失／旧协议助手分别启动页面并真实刷新；双冷包完成已有索引打开→导出／导入→压实→追加与旧值修订→压实回滚→重开。旧schema升级及已删来源保留在三态HTTP夹具验证；四个压实中断点和两种旧版投影兼容检查也通过。此处不代表性能或长时验收全部通过。

包内核对 `src/`、`public/`、`package.json`、`LICENSE`、原生源码／构建脚本及 exe／回执；排除用户数据、开发依赖、Cargo target 和实验输出。现有冻结工具还包含 `package-lock.json`。核对源码与运行副本摘要、执行 `native:check` 并记录最终 exe 摘要；本轮没有新增安装器。精确命令、已有覆盖与小夹具缺口见[收尾记录的新阶段](../experiments/architecture-20261101/DELIVERY-HANDOFF-REPORT.md#2026-11-09-windows并行收尾待集中验收)。

## 收尾清理

本次及旧计划已无用的大型成功／失败生成物已按显式清单清理：4962目标，E／C删除窗口净增合计663.681GB，含旧验证截图。用户／权威历史、源码、未提交工作、根开发依赖、仍需使用的输入／种子与最终产物保留；35份保留SQLite及包引用核对通过。派生工作库和投影再复测时需要重建；私有旧压实测试包的回滚窗口已结束。在用服务与数据未改动。清理口径与回执入口见[历史保留文档](history-retention.md#收尾存储盘点与清理)。

## 开发验收入口

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run skins:check
$env:AGENT_USAGE_TEST_NATIVE_BUILD = '1'
node --test test/windows-source-build.test.js
```

构建用例只在`output/`下的临时副本编译，验证路径含空格、回执缺失、源码变化、产物损坏及编译失败保留旧文件；默认测试环境未明确启用时标注跳过。原生行为测试可显式设置`Q6_TEST_HELPER`指向隔离exe。交付核对结果见[本轮收尾记录](../experiments/architecture-20261101/DELIVERY-HANDOFF-REPORT.md)。
