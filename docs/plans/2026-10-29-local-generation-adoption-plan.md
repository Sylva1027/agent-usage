# Codex 普通安装接入与 DSH 生成速度后续方案

日期：2026-10-29。状态：**本轮本地实现与隔离验收完成；Desktop 实际采用未执行，未部署。** 本文承接[原生采集主计划](2026-10-28-native-generation-timing-plan.md)，修正其普通安装交付路径及 DSH 必须等待 reasoning 明细的处理顺序。此前已完成的 producer、reader、WorkBuddy 恢复及 RANGE 修改继续保留。

建议先完成两项可以独立推进的交付：Codex 提供完整并排引擎包及启动器；DSH 直接复用成功响应中已有的推理、正文、工具参数时间，研究总生成速度的独立口径。DSH 的日志足以恢复生成窗口，缺少 reasoning 拆分不等于缺少全部生成信息。具体核验见[本轮证据](../validation/2026-10-29-local-generation-adoption/README.md)。

## 1. 本轮确定的事实

### Codex 的缺口在安装采用链

普通 npm CLI 与 Desktop 引擎尚不保存 `generation_timing`。补丁版完整 CLI 已在上轮通过构建和 22 个本地路径；本次前期研究未重复构建，后继 release 结果见 §8。仅把该 exe 留在仓库，普通安装不会自动采用它。

当前 Desktop 安装包的引擎选择函数确实读取 `CODEX_CLI_PATH`。本轮从固定 ASAR 提取实际函数，离线执行其选择逻辑；这是内部入口，尚未经过 Desktop 冷启动采用验证。选择顺序为宿主 `hostConfig.codex_cli_command`、环境 override、管理式 runtime/fallback。

实函数验证还纠正了初步静态判断：裸命令可以交给 PATH 解析；不存在的路径会回退。因此专用启动器必须要求**已存在的绝对路径**，并在启动后核对实际引擎路径和 hash，不能只检查环境变量已经设置。`CODEX_APP_RUNTIME_CLI_PATH` 是内部传播值，不作为启动器入口。

### DSH 已保存细粒度原生流

固定安装版本 `0.2.1.0`、SDK `0.129.0` 的 `session.v4.jsonl.zstd` 保存成功消息的 `usage` 以及 reasoning/text/tool-argument 流。packed run 通过 `time0 + 累计 dt` 恢复各成员时间；`dt` 不是相对首块的偏移。

本机 160 份规范会话包含 153,348 条事件、23,563 条成功 assistant message。其中官方账户/官方 API-key 路径共 881 条，均保存最终 output，均缺 reasoning 拆分；不能据此把 reasoning 设成 0。投影缓存是这些规范事件的派生结果，不是另外一份原始服务端 usage。

本轮独立复跑确认：其中 873 条成功响应有可与总 output 配对的正生成间隔，另 8 条只有至多一个生成增量，不能测速；873 条均有 reasoning，835 条含工具，399 条含正文，分类可重叠。881 条最终 usage 与同响应流内 usage 的 output 全部相等。873 是全部生成范围的候选，不是已有 v3 非推理有效样本。

`dsh-token-meter` 主要处理上下文压力、回放计量和启发式估计；其确切 usage 仍来自 provider。不能用它估计 reasoning 字数，再冒充服务端 token 拆分。`session-log-deepseek` 当前有效配置关闭，不能为了 TPS 打开可能上传会话的日志功能。

上轮唯一一次获准的官方请求已经用完，返回的两个 usage 均没有可选 reasoning 明细。本轮不追加模型请求；后续本地观察器也不为采样自动制造请求。

## 2. Codex 的具体交付

### 2.1 完整并排包

建议安装到用户目录的独立版本文件夹，例如 `%LOCALAPPDATA%/Programs/CodexTps/versions/<version>-<hash>/`。交付物保持源码已支持的 package layout：

```text
codex-package.json
bin/codex.exe
bin/codex-code-mode-host.exe
codex-resources/codex-command-runner.exe
codex-resources/codex-windows-sandbox-setup.exe
codex-path/rg.exe
```

`codex-package.json` 使用现有 `layoutVersion=1`、`entrypoint=bin/codex.exe`、`resourcesDir=codex-resources`、`pathDir=codex-path`。构建时记录 upstream commit、producer patch hash、引擎及 helper hash，不另造包管理器、更新服务或机器级配置。

其中引擎是已有补丁版；其余 helper 按已核验的同一安装包来源绑定，运行兼容性由后续烟测验收，不能仅靠文件名认定。`codex-windows-sandbox-service.exe` 不属于默认 standalone validator 的必需文件；只有目标模式实际启用 service/provisioning 时，才把该模式对应的服务链列为验收项。不能仅为“保险”把它加成所有用户的依赖。

`scripts/package-codex-generation.ps1` 只组包、校验并输出 manifest；消费构建结果，不默认重编上游。首轮 debug 构建用于接入验收；同补丁 release 构建现已通过同组探针及 helper 实测，见 §8。首版不修改 npm 全局 CLI、不替换 Appx 文件、不写 Desktop 管理的 hash runtime 目录。

目标目录由显式安装路径或核验过的用户目录解析。当前 Desktop shell 的 `LOCALAPPDATA` 存在 Appx 重定向，不能直接据它拼接并声称已经安装到普通用户目录；manifest 和启动器最终使用解析出的绝对路径。

### 2.2 CLI 与 Desktop 启动

新增 `scripts/start-codex-generation.ps1`，只提供当前确需的 CLI/Desktop 两条路径：

1. CLI 直接运行并排包的 `bin/codex.exe`，原样转交参数，保留正常用户 `CODEX_HOME` 及登录方式；测试时用隔离 home。
2. Desktop 仅在启动器进程中设置 `CODEX_CLI_PATH` 为并排 exe 的绝对路径，再启动已安装 Desktop。退出启动器后不留下用户级/机器级环境修改。
3. Desktop 已运行时，启动器在终端给出退出再启动的操作结果，不自动终止它。当前聊天和 RANGE 都不能被重启打断。
4. 后续冷启动验收只涉及 Desktop 及其自身后代进程，不退出独立 CLI、其他工程或 RANGE 进程。
5. 核对 Desktop 新子进程的实际路径/hash、package helper 解析结果及本地 app-server 握手。若选到官方旧引擎，验收失败；不能以 Desktop 窗口打开作为成功。

启动器不改模型路由、认证方式和请求正文。生产采集仍是原生 SSE/WS 解码点更新内存首末标量，成功响应将摘要写入 rollout；本仓沿用当前 Codex reader、增量发现和 request-ID 关联，无需代理服务。

### 2.3 普通安装覆盖的验收顺序

先完成 package validator、路径带空格、缺 helper、无效路径和宿主高优先级 override 的离线检查。然后在独立进程验证真实 command runner、Windows sandbox、code-mode host、rg 和一个无害 exec，确认 helper 没有错误回退。没有实际执行过的 sandbox 模式不写成已支持。

最后才安排 Desktop 完整退出后的冷启动采用检查，并在用户正常发起的请求中确认：原生 rollout 有摘要、本仓能读入、逐响应只入样一次、父子代理身份正确。离线 SSE/WS 覆盖可复用上轮成果，不为这一验收再发额外模型请求。

回退方式是退出专用 Desktop，再正常启动官方应用；CLI 继续用原 npm 命令。用户 rollout 和 usage 数据保留。Desktop 更新后重新核验 selector 和实际引擎身份；内部入口消失时保留 CLI 路线，不覆盖官方文件强行维持。

## 3. DSH 缺 reasoning 明细的解决路线

### 3.1 推荐增加全部生成范围

当前 `tps-v3` 明确定义为非推理生成。它需要从总 output 扣除 reasoning；在已检查的 881 条官方消息中，当前严格口径无法恢复有效样本。继续把所有后续工作排在“等服务端补字段”之后，会浪费已有完整生成流。

建议后续使用新方法版本 `tps-v4`，允许两个**范围明确且分子分母匹配**的生成样本：

- `non_reasoning_output`：保留 Codex 补丁与已核验其他来源的现有语义，N 是非推理 output，D 是对应首末输出间隔。
- `all_generated_output`：先限于核验过的 DSH 官方 Messages 路径，N 是同一成功 message 的最终 `usage.outputTokens`，D 覆盖 reasoning、正文、实际工具参数的首末非空生成增量。

两者均采用 `TPS=(N-B)*1000/D`。只有首末事件而无真实首批 token 数时沿用 `B=1` 约定；不把一次 delta 当作一个 token。使用全部范围不需要知道 reasoning 子项有多少，缺明细仍保持未知。

这里的总量语义依据是：DSH adapter 将服务端 `output_tokens` 直接映射为 output；DSH 自身计量把 reasoning 约束为 output 子集；DeepSeek 声明兼容 Messages，而该协议将 thinking 计入 output。这是来源限定的**协议契约推断**，不是已独立测出每条 DeepSeek reasoning 数量，也不能扩大到任意第三方兼容服务。落地时把该依据和固定 adapter 身份写入内部来源契约；优先利用未来正常请求中自然出现的 detail 做一致性复核，不额外发测试请求或改走另一个 API。

[DeepSeek Messages 兼容说明](https://api-docs.deepseek.com/guides/anthropic_api/)与[Messages thinking 的 output 语义](https://platform.claude.com/docs/en/build-with-claude/thinking)分别支持兼容关系和协议含义；它们不证明 DeepSeek 每个响应会返回可选拆分字段。

### 3.2 可比性与显示规则

两个范围都度量生成速度，单位相同，但“含推理的平均速度”和“回答阶段速度”不是严格相同的实验阶段；相同 tokenizer、effort、上下文长度和流合批也会影响比较。不能把范围一致性包装成所有模型的严格统一跑分。

具体规则是：每个来源/provider/model/effort 在一个方法版本只选择一个已审核范围。DSH 官方路径固定使用全部范围，Codex 继续非推理范围；即使 DSH 将来补出 reasoning 明细，也不在同一模型行中混入第二种范围或把同一响应采样两次。范围变更需重新生成该来源的投影。

DSH 的均值、区间和样本数可以进入现有模型行；严格的全局非推理排名只接收相同范围的样本。后端需拆开当前 `projectPerfModels()` 中“可显示数值”和“可参加统一排名”的同一个准入门，不能因为无全局名次而隐藏已测出的 DSH 速度。显示值与名次仍使用同一行，不增加新列、说明、徽标或范围开关；范围及排名不准入原因只留内部证据。

如果维持全局唯一的非推理范围，DSH 当前结果仍为 0 条有效样本；本方案不通过猜 reasoning、重分词或拿总 output 除正文窗口来制造可比性。推荐前述有数值、限定排名的路线，不以严格同阶段跑分阻断用户需要的本地生成速度。

### 3.3 复用现有 reader

在 `src/perf-sources/dsh.js` 的 `inspectDshAssistantGeneration()` 扩展边界分类和返回范围，继续复用 `readDshSessionRows()` 的发现、解压、坏帧及版本检查。计数与 stream 必须来自同一成功 `assistant/message`；核对 stream 最终 usage 与 message usage 的标量一致。

packed reasoning/text/tool-argument 及原始 delta 均按原顺序处理。工具名称、ID、block-start、signature、usage、finish 只作元数据；只有真正非空参数增量更新工具边界。真实空格有效。所有成员时间必须是安全整数且不回退；负 dt、跨 run 逆序不能靠排序或 min/max 掩盖。

成功终态按 adapter 已定义的 stop/tool-calls/max-tokens 处理；失败 `assistant/attempt`、retry 等待和后续工具执行不加入成功 message。只有一个生成增量、D≤0、无最终 usage、冲突身份或服务端工具等待无法分离时，不产生 TPS，原 usage 仍保留。

已有 DSH stream 正在原生日志中，无需再记录每块、开启 inspector 或上传日志。若后续补 adapter 的可选 reasoning 映射，只在字段实际存在时保存；该补丁改善未来非推理分析，不是全部生成路线的前置依赖。

## 4. 方法升级与现有数据

新范围不能直接冒用 v3。`src/perf-stats.js` 的来源语义、normalize、sampled/rank gate、dropped reason、models 投影必须共同支持新方法；低样本排名门槛维持当前值，均值、P10/P90、样本数始终使用同一有效请求集合。

`perf_samples.token_scope` 已是普通 TEXT，不为新字符串做无意义的表重建。需要调整的是 store 方法版本识别、来源投影/指纹和缓存；现有 v3 Codex、WorkBuddy 样本经同语义核验后可成为 v4 输入，旧记录保持原版本。尤其不能只重扫 Codex/DSH，导致仅在 archive 中存在的 WorkBuddy 有效样本消失。

变更范围包括 `src/usage-store.js`、`usage-core.js`、`usage-executor.js`、`perf-request-timing*.js`、`history-archive.js`、`history-backup.js`、timing 导出/导入脚本及其测试。Codex 专属 generation evidence v2 继续表示非推理；DSH 先走自己的 reader，不把 Codex ID importer 硬改成多来源平台。

先建立 v1/v2/v3/v4 的读取、归档和恢复矩阵，再调整当前方法常量。旧 E2E 记录仍可恢复和读取，但不重标为生成样本；冻结快照保持原口径。新结果带新发布指纹，重复扫描、晚到摘要、冷 archive 和独立进程导入都要一致。RANGE 的日期/来源/配额改动从实际工作树整合，不套旧整包覆盖。

## 5. 后继任务卡与验收

继续使用 pinned-workers，worker 显式 `group/deepseek`、`max`；按卡交付，主审单写共享统计、store/history 和文档。

1. **Codex 组包与启动器卡。** 独立 owner 仅写两个新 PowerShell 脚本及离线测试；读取既有 producer 构建与 package 证据。完成完整 manifest、参数转交、进程级 env、缺件失败、回退和更新核验，不启动当前 Desktop。
2. **DSH reader 卡。** 依赖本方案范围契约确定；独立 owner 写 `dsh.js`、probe 及 DSH 定向测试。涵盖 reasoning-only/正文/工具/混合、空参数但有工具名、一次性交付、累计 dt/回退、失败 retry、usage 不一致。输出本地真实扫描的逐项数量闭合，不保存正文。
3. **主审方法与历史卡。** 与 reader 契约衔接，单写统计准入、显示与排名分离、方法版本兼容、store/core/executor、history、导出导入。验证不同范围不合并，单响应不重复，memory/SQLite/API 一致，v3 WorkBuddy archive 不丢失，旧快照不改值。
4. **本地包运行卡。** 前述 Codex 卡完成后，使用隔离 home 跑真实 helper/sandbox/exec，本地假响应走完整落盘和本仓读取。只声明实际验收的模式。
5. **Desktop 采用卡。** 需要独立的完整退出/冷启动窗口；核对 Desktop 子进程真正使用补丁引擎，然后观察正常用户请求的采集闭环。这是最后的安装覆盖检查，本轮不执行、不部署。

DSH 与 Codex 包可先并行，共享统计与历史只有主审写。每张卡稳定后跑对应专项；组合工作树完成后再跑仓库要求的工程门禁与既有 UI 几何回归。UI 验收只确认现有数值、五行高度和交互保持，不增加解释内容。

## 6. 前期研究完成边界

授权实施前的研究产出为安装选择器实函数探针、DSH 本地持久化/流窗口核验和本方案。该研究阶段没有修改产品代码、安装、用户配置或生产数据库，没有重启 Desktop、干预 RANGE 或部署；随后授权的实现状态见 §7。

研究收口时，Desktop 的实际冷启动采用、真实 Windows helper 模式、v4 统计/历史兼容尚未执行；后续结果不倒写为当时已验收。DSH 全部生成的计数语义保留上述协议契约推断范围。

## 7. 实施账本

用户已授权按上述顺序实施，继续锁定 `group/deepseek/max`，保留 RANGE，不部署、不重启当前 Desktop。开工基线为当前工作树 389 个文件及其字节副本；不是从干净 HEAD 重做已有修改。

- C4：完整并排包和 CLI/Desktop 启动器已验收；最终 11 项离线测试由 Main 独立复跑通过，包含不同注册 Desktop 版本的运行中拒绝、精确进程身份与错误 fallback；真实 CLI version 通过。
- D4：官方路径全部生成 reader、probe 与 65 项定向测试通过。真实 reader 保留 881 个官方候选，870 个有效、8 个无正窗口、3 个身份冲突；主审补充内存/SQLite/API/冻结及旧文件失败重试检查通过。
- V4：统计版本、来源契约、显示/排名分离与发布指纹已整合；86 项内核回归通过。
- H4：v3/v4 Codex 请求身份及 WorkBuddy 原生生成归档已整合。正式归档、日志轮转、原目录删除后的转移恢复通过；历史专项 304 项，299 通过、5 跳过。旧 E2E 值保持原版本，不进入生成统计。
- C5：同一 Codex worker 完成四条 CLI/app-server SSE/WS 本地假响应→原生摘要→本仓 reader 闭环。真实 rg、code-mode host 协议握手、app-server 握手通过；Main 在普通 OS 权限下独立验证 unelevated RestrictedToken 的离线 command/exec。包前后 hash 不变，无外部模型请求。elevated command runner/service provisioning 未运行。
- Desktop 实际采用：按用户约束本轮不执行；后续需要独立退出/启动窗口。

全仓 3,486 项：3,460 通过、25 跳过、1 个既有皮肤稠密表格检查失败，开工前字节副本的隔离树同样复现。全仓后 C4 的拒绝条件收口另以最终 11 项专项复跑验收；Typecheck、lint、format、diff 检查通过。UI 几何回归通过；产品前端本轮零改动。两位 worker 的 10 条 turn 配置均为 `group/deepseek/max`，已关闭。完整验收和剩余边界集中登记于[实施记录](../validation/2026-10-29-local-generation-implementation/README.md)。

## 8. Release 与 helper 续卡

用户随后授权将并排包构建为 release，并补齐 helper 验证。Desktop 实际采用留到用户自行退出后的独立窗口；本轮仍不部署、不重启当前 Desktop，不改 UI、RANGE、模型路由及认证。

- R1：`group/deepseek/max` worker 核验固定源码并准备构建缓存；Main 接管 Cargo 执行，沿用原 release profile、独立 release target，不覆盖 debug 包。首次长缓存路径失败已切换为既有短路径 `.ct`，不改源码绕过。
- R1b：同一 worker 已缓存并校验上游固定的 V8 `152.2.0` Windows ptrcomp/sandbox 静态库及 binding；构建阶段获取公开依赖，运行时仍完全本地。R1c 已核验 8,979 个源码文件：23 项与 producer patch 逐字节一致，另有 Cargo.lock 中 167 次确定的版本号替换，没有未知源码差异；Main 已验收并关闭该 worker。
- H1/H2：另一同模型 worker 交付真实 helper 探针；Main 修正合成 SID 描述、空数组与布尔断言汇总，并补强父可写/子拒写的实际权限差异。旧包上的实际 JavaScript、runner 正向协议/隔离、setup 非空 read_root 的 RX ACL refresh 已独立通过；不等同新 release 包验收，不做机器级 provisioning。
- Release 构建：引擎和同源码 helper 的 `--offline --locked --release` 均返回 0，保留上游 opt-level 3、thin LTO、codegen-units 4，Cargo.lock 未变；构建前后 8,979 个源码文件的 digest 一致，原 debug 包保留。
- R2/Main：完整 release 包 `0.165.0-alpha.1.2-release-8d290b64` 已组包并通过四条本地 SSE/WS 原生采集闭环、真实 JavaScript、rg、runner 正向协议/写隔离、setup RX ACL refresh 和 unelevated command/exec。真实 CLI 启动器 version 与 11 项专项通过，21 条 worker 配置全部匹配并已关闭。完整包、命令与证据见 [release 验收](../validation/2026-10-29-codex-release/README.md)。Desktop 实际采用、完整账号 provisioning 和 service SCM 模式未执行。

本轮开工基线为 398 个文件；构建与验证证据保存在 `.codex-usage/codex-release-20261029/`，汇总见上述 release 验收。构建、组包和本地验证已完成；原 debug 和前轮验收保持各自版本归属，Desktop 实际采用继续单独安排。
