# 历史保留：性能接手点

2026-10-26后续状态：本页保留当时交接/方案。事实与报价分离、消费者融合、共享模型解释及有界原序报价重放已经实施并验证；最新百万首次14.887秒、真实调价3.467秒、稳定约0.9秒、服务峰值约303MiB。用户随后要求适度优化、不严格追估计数字，剩余性能交其他计划；固定20/20，最终源码门禁已通过（3247pass/25条件skip/0fail），不宣称原p95已达。逐项差距见[操作与交付说明](../validation/2026-10-22-history-retention/usage-and-restore.md)，当前契约以Implementation Plan顶部为准；不再恢复下文旧暂停/施工队列。

2026-10-26用户提议暂停实施，换模型寻找更好的方案；本轮已停止修改源码和测试。主审最后的容量进程已exit0，服务关闭完成，A/B空闲、C待命，无worker源码或执行窗口。

2026-10-26后续只读分析已留下[性能解决方案](2026-10-26-history-retention-performance-proposal.md)：建议分离事实统计与报价、融合重复扫描，并有界复用按原序的计价输入。尚未实施或验证收益，暂停状态不变。

## 剩余工作

固定进度为18/20，进行中2项。1–18按执行账本声明的支持范围已接受，不能扩大成所有kind/故障窗口均支持。

- **19：容量性能。** 当前主要阻塞。目标为每布局20个新服务进程，各首HTTP和20次skipCheck：首请求p95≤10s、max≤15s；skipCheck p95≤2s、max≤5s；health p95≤2.5s；PID去重服务RSS≤1GiB；另有三轮写入与外部reader释放后的WAL收敛。全热和正式commit后的冷热布局都要过。
- **20：最终集成。** 已有真实staging、恢复、新进程转移及旧版本工程结果，但最新源码完整工程门禁尚未通过，且依赖19。不能说只剩一次性能测试，也不能沿用旧3188项绿测覆盖新源码。

完整契约见[Implementation Plan](2026-10-22-history-retention-implementation-plan.md) §6–7；所有失败与范围见[执行账本](../validation/2026-10-22-history-retention/README.md)。

## 当前实测与证据

最新诊断：`output/history-retention-cold-first-pass-20261026/`。

- 1,000,000条，499,719冷/500,281热，schema21，一个真实候选经prepare→新backup/verify→正式commit取得权威；seed进程退出后启动独立服务。
- 首次完整HTTP **18,975.763ms**。
- 三次skipCheck为 **12,514.542 / 784.520 / 781.786ms**。第一次skip期间默认scheduler已切换完整价目，确实重算，不能删掉或称作稳定warm。
- 服务OS峰值 **205,967,360B，约196MiB**；不是seed峰值，worker线程与服务为同PID，只计一次。
- 四请求HTTP200、完整SQL oracle/费用/coverage/6个missing来源通过。同完整catalog的相邻载荷严格对拍通过，未规范化业务差异。
- raw SHA：`ad21a815d7e5dc52c10c125319fa13c986b194dd533867675d797059f271c700`。
- `review.json`、`review-cpu.json`、`first.cpuprofile`、`phases.json`、`inputs.json`可直接读。独立复核时98产品hash无漂移；交接前另一次检查发现`public/styles.css`被其他UI工作修改，已保留，不影响这三个后端受测hash，但不能把旧98输入叫作当前全仓状态。
- 这是一组带inspector的诊断，不是受控收益pair，也不是20组p95验收。首次和价目切换重算均仍超限。

## 首次CPU的剩余成本

最新dashboard阶段约17.475s，阶段嵌套不可相加：summary10.078s，其中timeline8.020s、repositories1.976s；metadata1.771s；period1.406s。

CPU self较高的部分是backup表指纹、原生SQL取数、costEventsForRange；timeline内还包含逐事件计价、费用累加和四维分组。此前额外archive事件指纹及无WorkBuddy来源时的全事件外循环已消除。下一方案应针对整段重复工作，而不是重新猜某个Map或最低费率函数。

另已捕获真实SQLite字节码：`output/history-retention-sql-projection-20261026/query-plan-before.json`。metadata投影已被SQLite裁剪为所需列；“UNION视图每次都取全37列”的猜测不成立，未据此改产品。

## 已完成的相关改动

1. `dashboardHistory`将原来的三次完整冷载体读取合并。
2. 单段、all、无event/perf overlay及无perf authority时，复用同一已验证冷连接，只读ATTACH热库，以TEMP view做SQL查询；其他范围沿原完整carrier。缓存与普通热读隔离，同步热快照不跨文件hash await。
3. 物理封存不改变逻辑事实，commit同事务保留原rollup markers和既有dirty队列，避免下一次sync无故全量重建；实际失败/回滚/重试已验。
4. 每次冷读仍两遍新鲜全文件SHA。最多8份完整manifest/字节绑定的语义proof可复用，WAL不复用。首次backup和archive事件hash共享一次实际JSON流，保持两种legacy SHA不变；扫描非严格id顺序或只有普通backup proof时退回原独立事件扫描。
5. WorkBuddy查询先筛来源，再沿既有source_path索引查事件；冲突而无perf样本的原始观测继续保留/验证。
6. verified SQL的无排除home边界查询改用冷热物理timestamp索引，避免五次完整MIN/MAX扫描；metadata可使用完整逻辑日汇总，缺标记仍回退。未新增schema/索引/持久缓存。

当前后端SHA：

- `src/usage-store.js`：`582db005333d1bb34471c6b466db3c919888cd2ec59e2572fc00e59dcfb22af8`
- `src/history-archive.js`：`70380d533e4464f99bc810d38e30f4857922455d552f2f228cc88badcd01aa29`
- `src/history-backup.js`：`4cfaf173bba6f4295cd950308ee0abb636b085eeabd8471812d9c72c8ab90c7b`

源码均未提交；真实前像保存在各`output/history-retention-*`证据目录，不得拿HEAD替代或整文件覆盖。

## 最近验证及易踩点

- 指纹新用例与proof 2/2；backup/archive/store闭包64pass/3skip。SQL特性检测原来误看prototype，已改为真实实例；三项补跑3/3、0skip。
- WorkBuddy完整原始SHA、篡改拒绝与来源隔离后转移3/3。
- 边界/metadata/period小闭包原6pass/1fail；新夹具漏了sealed主库中的rollup表，产品正确回退。夹具在真实封存前建汇总后，新用例1/1，含删marker后的完整回退。
- metadata/period executor为3pass/1skip；同次真正的NODE_OPTIONS子进程publication门禁通过。最新typecheck及六文件Biome均exit0。
- Node24.19.0的`DatabaseSync.isTransaction`是**实例属性**。不要再次从prototype检测而跳过SQL专项。
- 全仓最终测试曾被旧1GiB Job终止；不能算通过。9个并行UI摘要漂移失败后来已独立9/9，但不代表最新全套通过。

## 不要重做或绕过的事项

- **保留用户明确选择的schema22→21及覆盖索引回退。** 不恢复22/索引。
- 不重复已否决的通用行iterator/字段模板、metadata小复用、modelCount、suffix、最低费率分配微调；各有无收益/回退证据，不做择优重跑。
- 不跳完整内容验证、不把同一段验证后的第二连接当一致快照、不返回仅hot的部分结果、不放宽货币/计数/顺序比较。
- 不关闭默认价目scheduler来换好看计时；价目和费用必须同一版本。
- 不扩大任意kind、overlay、多段、迁移等范围来顺便重写架构。
- 主页面常驻归档框已被用户在UI线撤回，不恢复。

## 资源与权限

始终`pwsh`。测试由Main串行执行，使用`scripts/run-with-memory-limit.ps1`整棵子树Windows Job；小夹具默认1024MiB，用户明确授权最多7168MiB，正常Node heap512MiB，预检Available≥8GiB。7GiB是上限，不是目标用量。不要复制产品树或并发跑全仓/百万；新方案先小行为和一次完整HTTP，明显超限时不跑20组凑样本。

保留全部并行工作、单文件单owner。没有生产库写入、正式服务3765/系统服务操作授权；本轮未做这些操作。原automation入口不存在，不要声称后台每5分钟仍在监督。当前暂停等待用户换模型提出方案。
