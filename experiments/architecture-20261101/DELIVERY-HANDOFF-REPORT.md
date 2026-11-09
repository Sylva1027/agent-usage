# 正式交付收尾记录

日期：2026-11-05。接续Q10 `ca0ae77`。**用户已接受当前已测性能，本轮完成构建、配套校验及保留历史升级流程，做本地提交后停止。** 未发布新release或切换在用服务，版本仍为0.8.5；旧报告的实验阈值和失败点保留为观察项。

## 使用入口

- [交付、构建、升级和回滚](../../docs/15-delivery-upgrade.md)：当前改造职责、环境、完整操作顺序和观察项。
- `npm.cmd run native:build`：明确使用锁定依赖和本机Rust target构建，输出exe及`windows-source-proof.build.json`。
- `npm.cmd run native:check`：检查源码、构建脚本与产物配套；只读，不需要Rust，也不进入日常刷新流程。
- 两条命令支持`-OutputDirectory`，构建另支持`-TargetDirectory`，可准备新程序目录而不覆盖在用助手。

回执绑定Cargo清单、锁文件、构建脚本及全部Rust源码。构建阶段检测源码是否在中途改变；编译失败保留原exe与回执；成功后从临时文件替换。旧产物没有配套回执或字节不符时，交付校验明确失败；程序运行仍保留助手缺失、不支持或证明不足时的原有回退。

## 本轮验证

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| 正式构建与校验命令 | 通过 | 隔离输出，`x86_64-pc-windows-msvc`，本机Node 26.13.0、PowerShell 7、Rust 1.98.1 |
| 新构建流程测试 | 1项通过 | 路径含空格、外部Cargo target干扰、回执缺失、源码变化、二进制损坏、编译失败保留旧产物 |
| 旧索引升级 | 2项通过 | v23→24，以及旧v24补齐累计会话索引；事实与额度保留，原来源已删除仍能查询 |
| 备份、冷段完整包与恢复 | 35项通过 | 已提交WAL、完整性拒绝、原schema/数据保留及恢复目标不覆盖 |
| 实际交付助手行为 | 10项通过 | 重复记录合并、跨父目录证据、原位改写不能冒充追加、危险变更/超时/协议错误回退；最终串行 |
| 独立运行副本 | 3种状态通过 | 新助手、缺失助手、旧安装助手均能启动原页面并正确刷新；无生产node_modules |
| 运行副本的备份CLI | 通过 | 实际执行backup→verify→restore，恢复后47 Token、5条事实均保留，不切换活动服务 |
| 无Rust环境的校验 | 通过 | 子进程PATH不含Cargo，运行副本的`-Check`仍成功 |
| 工程检查 | 通过 | typecheck；lint 0错误、51项既有warnings/3 infos；skins:check核对40个资源及bootstrap |

最终相关测试**48项通过、0失败、0跳过**，另有三种真实HTTP服务冒烟。没有重新运行大规模性能矩阵或全套浏览器回归；最近一次全套结果仍见[Q10报告](Q10-REFRESH-REOPEN-REPORT.md)，其既有失败没有改写为通过。

运行副本先建立17 Token、2条事实的小型索引，再删除一份上游会话，模拟旧schema23及缺失累计会话索引。新程序打开后schema24及索引恢复，原业务字段不变。随后依次在新/缺失/旧助手下真实追加，得到27/37/47 Token、3/4/5条事实，已删除来源的7 Token始终保留；每个私有服务正常退出。缺失助手明确使用SHA前缀核验；旧助手的配套校验会拒绝不符字节，运行兼容性仍保留。副本中的新助手已恢复并再次通过校验。

首轮原生与历史包测试被并行安排，历史夹具的同卷硬链接变更触发一项`ambiguous hardlink change`，原生层按既有规则回退。原日志保留，改为串行后10项全过，未降低硬链接检查。私有冒烟预检误用了非现有排序列，在启动服务前修正并保留日志；旧夹具已按范围清理。

## 交付范围和状态

当前改造保持浏览器＋Node＋SQLite，未更换语言、数据库、来源格式或用户界面。文档已整理来源增量、持久业务视图、发布/通知和可选助手的职责；README、开发入口及文档目录已连到新的交付页。开发文档中已过时的tiktoken安装要求和数据库“仅计算进程持有”描述已纠正。

升级采用新程序目录，先停止对应旧实例、完整保存状态和外部冷历史，再按原数据参数启动。回滚使用旧程序与升级前完整副本，升级后的副本也保留；不会建议删库、改`user_version`或丢弃已被上游清理的历史。单库备份与冷段完整包沿用现有CLI，不新增迁移框架或自动封存步骤。

私有验证位于`output/delivery-20261105/`：正式构建/校验日志、回执、升级/历史/原生/工程检查日志、`smoke-result.json`及精简运行副本。副本仅作本地交付验证，不是已发布安装包；不含开发测试、实验、用户配置、来源日志或索引。没有替换安装目录中的11月3日旧助手，也没有重启在用服务或配置系统journal。

追加后重开、较大首次准备及长期容量继续保留已知记录，不阻塞用户已接收的当前交付。本轮没有验证全新Windows机器、代码签名、Linux/macOS专项适配或一年/两年历史容量；正式发布版本号、打包分发及实际服务切换另行安排。完成本地提交后停止等待反馈。

## 2026-11-09 Windows并行收尾：待集中验收

本节保留当时的准备快照与命令映射；**实际完成结果见文末2026-11-10核验记录**，不能把下面的待运行清单整体当作通过记录。

本节追加到11月5日历史记录之后；上面的48项、三种HTTP冒烟与17→47 Token均只代表原次运行。本次基线为 `6fcc95d`，Card D只更新交付与历史文档、准备清理工具；最终运行包、助手三态及双冷包闭环仍待Main冻结候选后串行执行。没有新安装器，没有启动或切换在用服务。

已核对的文档覆盖：六来源实际提取能力（仅Codex普通JSONL／DSH有持久续读检查点）；主库、冷包与manifest、持久冷热投影和业务视图；压实切换／投影重绑定；`windows-archive-read-lock-v2`租约及普通读取完整校验回退；压实回滚与程序回滚分别保留历史。11月5日的接受不覆盖后来两年性能、内存或原八小时欠项。

### 一套最终运行包核验

Main准备冻结候选的独立运行目录 `output/windows-parallel-20261109/delivery/runtime`，只带生产文件与助手源码／脚本／exe／回执。现有 `archive-compaction-prepare.mjs` 的 `runtimeFiles(root)` 能枚举生产目录并排除Cargo target；它不会自动构建或生成安装器。下面只核对小型程序文件，不读取来源日志或历史库：

```powershell
$env:CLOSEOUT_DELIVERY = (Resolve-Path -LiteralPath 'output/windows-parallel-20261109/delivery/runtime').ProviderPath
@'
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { runtimeFiles } from './experiments/architecture-20261101/archive-compaction-prepare.mjs';
const runtime = process.env.CLOSEOUT_DELIVERY;
const files = [...await runtimeFiles(runtime), 'LICENSE'];
for (const required of ['src/cli.js','public/app.js','package.json','native/windows-source-proof/bin/windows-source-proof.exe','native/windows-source-proof/bin/windows-source-proof.build.json'])
  assert.ok(files.some(file => file.replaceAll('\\','/') === required), required);
for (const file of files) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(await readFile(path.join(runtime,file))), hash(await readFile(file)), file);
}
await assert.rejects(access(path.join(runtime,'node_modules')), {code:'ENOENT'});
await assert.rejects(access(path.join(runtime,'native/windows-source-proof/target')), {code:'ENOENT'});
console.log(JSON.stringify({files:files.length,matched:true}));
'@ | node --input-type=module -
npm.cmd run native:check -- -OutputDirectory "$env:CLOSEOUT_DELIVERY/native/windows-source-proof/bin"
```

同时人工核对包根文件清单，没有用户日志／索引／配置、开发测试或实验输出；记录候选源码清单、exe SHA、build回执、环境及本次命令退出码。已存在的 `native:check` 只绑定当前原生源码与exe，不能替代整个运行包核对。原生源码未变时不必重新编译；缺少匹配产物才在隔离输出运行 `native:build`。

### 四个小场景的现成覆盖与缺口

1. **有效助手启动／刷新。** 用最终运行副本取得页面和 `app.js`，查询all，再实际追加一次并确认新值及已删上游的旧事实仍在。原生行为入口为 `test/usage-source-native.test.js`；归档租约入口为 `test/history-archive-native-lock.test.js`。原测试不代替真实HTTP刷新。
2. **缺失助手启动／刷新。** 在独立副本中使 `bin` 与 `target/release` 两条发现路径都不可用，重复同一业务核对；普通读取应回退完整验证，显式压实不得切换。现有租约测试 `archive leases fall back for missing helpers...` 和压实测试 `compaction requires leases even inside an existing weak verification scope`覆盖底层契约。
3. **旧协议助手启动／刷新。** 使用明确记录SHA的旧exe或现成旧协议mock，拒绝把当前exe复制到“old”名字当成旧协议。普通刷新保留业务结果，归档v1不能成为v2租约；原生bridge测试 `archive bridge rejects invalid responses...`明确覆盖v1响应。最终包配套校验仍须拒绝错配旧exe。
4. **双冷包完整闭环。** 复用 `test-support/history-compaction-fixture.mjs::makeCompactionFixture`：已有两个授权旧包、已删来源、热事实、修订、额度及既有投影；使用 `read/oracle/reopen/append/reviseCold` 与 `clean` 精确对拍。串接旧索引打开升级→CLI导出／导入并验证冻结上下文→在可写的原主库压实→追加与旧值修订→同主库压实回滚→重开。导入副本用于独立冻结核对，不宣称普通导入HTTP实例继续采集。每一步记录事件／会话／额度／费用／时间线及版本；压实／回滚检查 `coldCopied=0`、`rebuilt=false`，不把后来新增恢复为旧值。

**还缺的小夹具串接：** 仓库没有单条命令覆盖上述四场景。私有 `output/delivery-20261105/smoke.mjs`可参考三态HTTP驱动，但目录／日期写死，且它的“old”取旧工作区exe；现今直接执行会复用旧路径并可能拿到当前exe，不能直接作为本次冒烟。Main需在本轮私有证据目录复制并最小调整驱动到最终runtime和独立夹具，明确固定旧协议产物。双冷包的升级＋导出／导入目前也分散在多个测试中，需用现成fixture和CLI串接为一次独立闭环；不能将分散通过替代整链结果。

### Main的现有命令／测试映射

以下是**待运行命令**。所有原生、归档和工程大组由Main在计时之外串行运行；不同时跑多个原生测试文件、构建或其他重型实验。下面用 `--test-concurrency=1`串行文件，不另建大历史矩阵。

```powershell
# 原生构建流程；仅确实需要验收构建时启用，隔离输出，不改安装助手
$env:AGENT_USAGE_TEST_NATIVE_BUILD = '1'
node --test --test-concurrency=1 test/windows-source-build.test.js
Remove-Item Env:AGENT_USAGE_TEST_NATIVE_BUILD

# 三态的底层证明、v1拒绝与实际v2文件/父路径租约
node --test --test-concurrency=1 test/usage-source-native.test.js test/usage-source-native-failure.test.js test/history-archive-native-lock.test.js

# 旧索引升级：v23→24 与旧v24补累计会话索引，保留事实和额度
node --test --test-concurrency=1 --test-name-pattern='UsageStore upgrades v23|UsageStore adds the cumulative-session index' test/usage-store.test.js

# 完整包转移、CLI及冻结上下文；为双包闭环提供契约覆盖
node --test --test-concurrency=1 test/history-cli.test.js test/history-archive.test.js test/history-archive-import-instance.test.js test/history-archive-import-executor.test.js

# 双包压实、追加/修订后回滚、CLI发布及投影身份不变
node --test --test-concurrency=1 test/history-archive-compaction.test.js test/history-archive-compaction-publication.test.js

# 四个现成SIGKILL阶段：before-main / after-main / projection-write / projection-commit
node --test --test-concurrency=1 test/history-archive-compaction-crash.test.js

# 两种旧程序兼容：投影重绑定完成 / 主库已切换但投影重绑定待完成
node experiments/architecture-20261101/archive-compaction-compatibility.mjs output/archive-compaction-20261108/baseline-runtime.json output/windows-parallel-20261109/delivery-compatibility.json
```

兼容工具会先验证 `baseline-runtime.json` 的文件闭包，再分别用当前fixture切换并由冻结旧版读取；输出目标必须尚不存在。若该旧runtime已经释放或校验不符，先保留错误并准备明确版本的冻结副本，不能跳过验证或重写旧证据。四个崩溃阶段本身检查重试、重开、逻辑结果／ID一致和无冷事实重拷贝；两种兼容不是两次大数据升级。

若Main的最终补丁改变schema或原生协议，原升级证据不能直接复用，需在计时前明确补测真实升级；当前D没有改schema或协议。最终结果以Main实际运行日志补记，原来的失败与未完成项保持原状态。

### 本阶段已经执行的轻量准备

- 当前工作区 `npm.cmd run native:check` 通过，日志 `output/windows-parallel-20261109/delivery-native-check-prepare.log`；exe SHA为 `b3b3314359de6de6bcb76b9f06734fcb95546a0be80135e7a8ceadb28912dce3`。这是准备时的源码／产物配套检查，最终候选冻结后还需核对最终运行副本。
- 清理工具自检已执行，覆盖路径边界、受保护消费者、tracked文件、硬链接、junction和元数据变化；小夹具及回执保留在私有cleanup目录。最初空字符串前缀错误生成的两个根CSV已确认归属并移入该目录，已修复并重新自检；没有移动其他未跟踪工作。
- 未运行归档／原生行为大组、没有启动HTTP三态冒烟或双冷包整链，没有声称未来命令通过。

### 清理交接与依赖

最新用户授权允许清理本次及旧计划已经无用的成功／失败生成物，覆盖计划中的“仅列清单”；Main在计时和最终核对结束后删除。准备阶段只读盘点。工具为 `windows-closeout-cleanup.ps1`，`Inventory`生成目录／文件元数据与manifest模板，`Preview`验证显式绝对目标，`Delete`仅接受已经结束计时、消费者明确释放的清单。没有实际删除候选。

当前必须保留的消费者：A/B/C/E使用的 `windows-parallel-20261109` 基线runtime和资源诊断；E的 `windows-multitab-20261109` 135条来源／134条提交起点及stability/recovery失败现场；C1当前／一年／两年来源和seed；compaction／verification／persistent-mixed的包、旧runtime与传递清单；B3 seed及growth-baseline的原capture。最后一批依赖由Main实际执行后释放。唯一用户历史、真实来源和raw/capture指针闭包继续保留，不能按“失败”或“未跟踪”整根删。

初次元数据盘点约861.854GB逻辑量，292个独立scope、348,938个文件；这不是可删除量，也不是物理回收。大户为旧architecture-20261103（212.507GB）、C1（167.017GB）、architecture-20261102（159.697GB）、architecture-20261104（87.284GB）、persistent-mixed（73.564GB）。旧architecture内部优先审查过期工作库／合成home，保留原capture和小证据；C1、冷热包及当前失败状态先等本轮消费者释放。原扫描对137个超长路径元数据失败、38个重解析点跳过，已补长路径处理和类型／链接字段；最终清理以更新盘点和逐目标Preview为准，跳过链接不读取外部目标。

更新盘点 `output/windows-parallel-20261109/cleanup/20261109T1411170105126Z-Inventory.json` 已完成：292个scope、349,085个文件、862,166,730,412字节逻辑长度，元数据错误0；38个目录重解析点均保存类型及文本目标，没有跟随。按scope去重的分配量估计合计782,850,127,320字节，目标内含全部硬链接的估计合计695,502,960,826字节；前者仍可能跨scope重复，后者也不是获批可删量。图片7,789份／3,638,927,724字节包含fixture／素材副本，不能全部当截图删。脚本还固定保护growth profile指向的原capture目录及capture-pointer，不能通过释放合成数据依赖顺带删除真实原始捕获。

最终脚本的小夹具自检（含长路径）与显式manifest的Preview已通过，日志／回执均在同一私有cleanup目录；Preview只选自有8KiB测试文件，`timingFinished=false`，删除数0。Delete入口未执行；Main必须使用自己的最终目标清单，不能把自检manifest当清理授权。

既有回执已交叉核对：11月8日五批output＋截图／target窗口净增589,590,933,504字节；11月9日38目录净增78,144,081,920字节；stability四处收尾净增9,813,102,592字节。后两份回执的42个旧目标当前均不存在，不重记回收；上述旧净增不计入本轮。逻辑长度、按卷／文件ID去重的 `GetCompressedFileSize`估计、全硬链接均在目标内时的可回收估计、删除后卷净增分别记账。最终目录类型、重解析点及其文本链接目标、外部硬链接计数必须保留，不递归跟随或删除外部目标。

## 2026-11-10 最终交付核验

有限批次候选在六组原页面对照中有9项相对退化，未采纳；最终副本采用6fcc95d的生产运行代码，性能结果与标准见[集中报告](WINDOWS-PARALLEL-CLOSEOUT-REPORT.md)。src/public/native无差异，版本仍0.8.5，没有安装、部署或切换在用服务。

| 项目 | 本次实测结果 | 证据 |
|---|---|---|
| 产物配套 | 120项生产／许可证文件与工作区一致；工作区及副本native:check通过 | delivery/artifact.json、native-delivery-final.log |
| 有效／缺失／旧协议助手 | 三态HTTP启动及真实追加通过，17→27→37→47 Token，schema23→24；已删除来源7 Token保留 | delivery/smoke-result.json |
| 双冷包整链 | 已有索引／投影打开、CLI导出导入、压实、追加与旧值修订、压实回滚及重开均精确一致 | delivery/cold-roundtrip-result.json |
| 中断及兼容 | 四压实中断点通过；完成／待完成投影重绑定两种旧程序读取均精确 | final-core-tests.log、delivery-compatibility.json |
| 最终相关检查 | 核心25项、工具88项通过，typecheck通过；lint退出0，51 warnings／3 infos | final-*-tests.log、typecheck-final.log、lint-final.log |
| 存储收尾 | 4962目标，逻辑786.505GB；E／C删除窗口净增617.574／46.106GB，合计663.681GB | cleanup/post-cleanup-verification.json及删除回执 |

证据根目录为私有output/windows-parallel-20261109。助手exe SHA256仍为b3b3314359de6de6bcb76b9f06734fcb95546a0be80135e7a8ceadb28912dce3；Rust源码及协议未改，本次核对已有配套产物，没有重新编译。旧协议使用明确记录SHA的v1 mock，不拿当前exe改名替代。其首轮驱动因Windows --import未使用file URL而在启动前失败，保留原日志，修正后仅补旧协议场景，原先两态成功未覆盖。

保留35份必要SQLite、原始捕获与历史、当前／一年／两年输入和种子、13个压实包及最终程序；两个关键库完整性正常。旧大型资源轨迹保留SHA往返验证的gzip，小证据与旧失败不改写；6827份旧截图／图像副本及旧工作库、镜像、构建缓存已清理。派生工作库／投影需要准备后才能再次计时；这些私有旧测试包的回滚窗口已结束，不影响产品升级文档要求保留真实回滚副本。

原完整回归并非全绿，原两年普通刷新及长期资源欠项仍保留；本轮保护门失败，因此两小时未启动，原八小时仍未完成。最终交付核验通过不等于Windows系统性能验收或全部原始重构目标通过。
