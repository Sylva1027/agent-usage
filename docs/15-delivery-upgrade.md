# 交付、构建与升级

更新：2026-11-05。用户已接受本轮已测性能，速度优化收口。现有实现继续使用浏览器、Node.js 和 SQLite；本页是交付操作入口，历史实验报告保留原始结果。

## 本轮已有改造

| 环节 | 现在的实现 |
| --- | --- |
| 来源采集 | Codex/DSH 保留解析检查点，追加主要处理新增内容；有完整身份依据时，新会话及新目录直接登记 |
| 历史与统计 | 原事实继续保留；额度、汇总、纪录、元数据和周期统计复用磁盘索引与持久计算结果 |
| 查询与通知 | 查询一个已提交版本；并发刷新合并，真实新值提交后通知页面，刷新完成不以旧值代替 |
| Windows 核验 | 可选原生助手使用已有NTFS变更日志，合并同一对象/父目录的重复记录，危险变更标志保留 |
| 无原生证明 | 自动使用既有内容核验与完整处理路径，可能较慢，统计口径不变 |
| 资源 | 后台网关默认512MiB堆，计算进程224MiB/semi4MiB；这是堆预算，不是整棵服务树硬上限 |

测量与边界见[Q10报告](../experiments/architecture-20261101/Q10-REFRESH-REOPEN-REPORT.md)。追加后重开缓存未命中、较大首次准备和长期容量继续作为观察项，当前交付不因此重新开性能卡。Linux/macOS的专项适配在后续核心工作完成后安排。

## 运行与开发环境

- 运行：Node.js `>=23.8`；本轮实测为Windows x64、Node 26.13.0。程序无生产npm依赖，完整运行目录可直接执行 `node src/cli.js run`。
- Windows原生构建：PowerShell 7、Rust/Cargo及其Windows主机工具链所需的链接器。Rust只用于构建，普通运行不调用Cargo。
- 源码检查：`npm.cmd ci` 安装开发依赖。Windows用`pwsh`，不是Windows PowerShell 5.1。

原生助手是普通子进程，不是桌面客户端或系统服务；它不启用/修改系统journal。没有现成journal、助手缺失或证明不足时自动回退。配套的`exe`应由这份源码构建，不能仅凭旧文件还在就认定已升级。

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
3. **完整保留状态。** 停稳后把原`~/.codex-usage/`复制到新的备份目录，包括SQLite、仍存在的WAL/SHM、汇总库、价目和导入配置。自定义数据库/配置路径也一起保留；有外置冷历史时保留完整目录及相邻manifest。不能只备份还能找到的原始会话日志：已被上游清理的历史可能只剩索引事实。
4. **从新目录按原参数启动。** 使用原`--home-dir`、`--state-file`和端口等参数，保持原数据位置。数据库打开过程执行迁移、补齐索引及派生结构，已有事实继续使用；不要删除索引、手改`user_version`或用空库重建代替升级。第一次派生准备可能较慢。
5. **确认后保留回滚点。** 查看全部范围、较早月份、各来源与费用，再确认一次真实新增能出现。确认后继续日常使用；旧程序及升级前备份保留到自己确认稳定为止。

默认前台启动：

```powershell
node src/cli.js run --host 127.0.0.1 --port 3765
```

新程序沿用默认用户数据位置；`--home-dir`是来源home参数，不能随意指向空目录来模拟原用户升级。

## 备份工具与回滚

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

回滚时，先停新实例，也完整保留升级后的状态，再用**旧程序＋升级前的完整数据副本**恢复；旧代码不直接接管升级后的数据库。保留升级后的副本，可避免丢掉升级后新增、后来又被上游清理的记录。恢复/导入命令只生成独立副本，不会自动切换活动服务。

## 开发验收入口

```powershell
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run skins:check
$env:AGENT_USAGE_TEST_NATIVE_BUILD = '1'
node --test test/windows-source-build.test.js
```

构建用例只在`output/`下的临时副本编译，验证路径含空格、回执缺失、源码变化、产物损坏及编译失败保留旧文件；默认测试环境未明确启用时标注跳过。原生行为测试可显式设置`Q6_TEST_HELPER`指向隔离exe。交付核对结果见[本轮收尾记录](../experiments/architecture-20261101/DELIVERY-HANDOFF-REPORT.md)。
