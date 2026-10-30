# 本地实际输出速度采集验收

2026-10-30。用户确认采用统一分词的实际输出速度。本轮将 Codex、DSH 和 WorkBuddy 的新采集接入 tps-v6，计数来自实际正文和工具参数，原始计费用量与费用不变。纯本地采集和存储，不读取 Magpie 的遥测，不增加 UI 说明。

## 修正内容

之前的窗口从首包到末包计时，却将整次输出减 1 作为分子。首包实际可能已有几百个 token，这会把窗口外的输出算入速度。另一个问题是把已收到的缓冲解析成多次事件后才取时钟，解析时间也可能被当成生成时间。此前约 1.6 倍的比较不能修正这两个缺陷。

新采集在传输接收层记录批次和时间，先取得每条输出 lane 的完整文字，使用用户选定的本机 `o200k_base` 分词器编码一次，再按最终 UTF-8 token 结束位置计数。首批的所有字节从计数窗口排除，同一次接收中的多个事件不制造新的计时区间。正文、拒绝文本、函数参数和自定义工具输入属于可见输出；思考内容、协议字段、工具名称和工具执行不计入。

每个请求的分子是窗口内完成的参考 token 数之和，分母是这些窗口时间区间的并集。并行 lane 不重复累计时间；思考或工具执行将可见输出分成多个阶段，但同一 lane 仍只编码一次。只有一个接收批次的响应没有可测间隔，不虚构速度。

平均值采用所有有效请求的 token 总和除以时间总和，P10/P90 使用同一批请求的速度分布。已有 TPS 降序、样本数和区间条保持原样。模型保留来源、渠道和 effort 身份，不按模型名称、速度高低或固定倍率修正数据。

## 采集接入

| 来源 | 接入方式 | 已验证路径 |
| --- | --- | --- |
| Codex | 独立 release 并排包，原生 schema 3 摘要随 rollout 保存，启动器选择实际引擎 | producer 单测、release 构建、完整包完整性；实际传输验证与采用状态见下文 |
| DSH | 官方支持的 Cordis patch 插件，以 attempt 和最终提交的本地 message ID 关联标量观测 | 实际 CLI 0.2.1rc2、Desktop 内置 0.2.1rc3 的 Cordis、LlmRuntime、DeepSeekAdapter |
| WorkBuddy | 专用 CLI 启动器加载 Node HTTP 接收钩子，以请求头中的本地会话和消息 ID 关联 | 实际 CLI 2.165.0、原始会话、内存 reader 和 SQLite |

DSH 与 WorkBuddy 使用同一套本地分词和窗口测量。它们仅新增 token 数、窗口时间、分词器及身份字段，不额外落盘回复正文。WorkBuddy 每会话写入独立观测文件；DSH 写入会话旁的 companion 文件，正常索引能发现观测晚到。

DSH 原始 usage 缺少 reasoning 明细不再阻塞可见输出测量：新计数直接来自实际输出内容，不从服务商总 token 中猜减 reasoning。原始 usage 继续供用量和费用统计。

## 历史和恢复

tps-v1 至 v5 保持原版本，历史计数不改名冒充统一参考 token。旧 generation 样本保留模型身份；只有新口径证据进入 v6 的数值与分位数。历史文件缺少接收批次边界时，不能回算新窗口。

修复了新计时到达后冷归档仍使用旧测量核验的问题。修订现在同时携带样本和按 sample、home、source 精确绑定的标量测量；发布在同一事务提交。冷侧继续核对不可变归档中的请求身份及原始 usage，用修订证据核对新 token 数和时间。完整导出、删除原来源和候选文件、重新导入及 reopen 均保留这一关系。

无测量修订、损坏窗口、跨 response 绑定、单独篡改 duration 均拒绝。没有把可变热库当作归档的恢复权威。数据库 schema 仍为 23，Codex 投影版本与持久化摘要缓存已更新。

## 验证结果

- 全仓：3,584 项，3,559 通过、0 失败、25 项既有跳过；受控并发为 4。
- UI 和启动器：51 项全部通过、无跳过，覆盖实际浏览器的明暗主题、双语、1920/2560 尺寸、字体、空值及区间条。
- Codex producer：codex-api 230 项、generation_timing 15 项、rollout roundtrip 和 restored usage 定向检查通过。
- 类型检查通过，80 个本轮 JS、MJS、JSON 文件的 Biome 检查通过。
- 新 release 的 CLI/app-server × SSE/WebSocket × 正常/同批缓冲共 8 条真实二进制闭环全部通过。正常两批只计后批 200 个参考 token；同批缓冲保留原始 usage，但不制造测量区间。完整包前后 hash 相同，code-mode host 与 rg 冒烟通过。
- 实际 DSH Desktop 运行时的本机模拟流：首批 900、后批 200 个参考 token，观测只计后批 200，窗口 142 ms，reader 收到 1 个样本。
- 实际 WorkBuddy CLI 的本机模拟流：同样只计后批 200，窗口 186 ms，内存及 SQLite 各 1 个样本，计费用量一致。本地消息 ID 与 wire response ID 不同，仍能精确关联。
- 真实索引的一致性副本包含 150,332 条用量事件。旧、新运行包独立打开可写副本，schema 23、quick_check 为 ok，用量与费用相同，新方法为 tps-v6；没有在活动库上做兼容测试。

上述模拟流用于验证计数和时间边界，不是模型性能实测。全程没有新增真实模型请求。

## 构建与采用状态

Codex release 使用 opt-level 3、thin LTO、4 codegen units、静态 CRT，离线锁定依赖构建成功，用时约 55 分钟。引擎 SHA-256 为 `64cac13a8aebaaca6c58ecc76b8472c7cfb96b0bc10e3b92c3398f4bd3054ab4`，producer patch 为 `a380d7603922ab3006971d9b9bc395b855c9163510cee16bfbbbadccba1076e5`。完整包复用已验证且逐文件核对 hash 的 code-mode host、command runner、sandbox setup 和 rg。

正式看板已切至固定运行包 `f8a844e4fe4b`，采用 tps-v6、schema 23。完整离线恢复点的 quick_check 为 ok，没有外部冷段；正式 API 的固定历史用量、费用、summary 字段及前端资源 hash 均核对通过。服务继续独立托管，保留 128 MiB heap 和 7 GiB 服务树预算。

Codex release 已并排安装，DSH 插件与 WorkBuddy CLI 启动器已装入独立版本目录；DSH 原 patch 已完整备份、原配置逐字保留。DSH 当时未运行，插件将在下次正常启动时加载。WorkBuddy CLI 须通过专用启动器运行。

用户配合退出和 resume 后，Desktop 的实际 app-server 已采用上述 release 引擎，路径、父子关系和 SHA-256 均核对通过，启动选择已保存。看板进程保持原身份。恢复后的 10 个自然请求已完成原生摘要、内存 reader、SQLite 与正式 API 的逐条对照；窗口并集、平均值和 P10/P90 独立复算一致。原始请求和用量证据仅留本机，未放入发布包。实际采用及重启辅助程序的两次状态问题见 [Desktop 采用结果](desktop-result.md)。

本轮先完成 Codex、DSH 与 WorkBuddy CLI 的采集。WorkBuddy Desktop，以及 Claude、OpenCode、ZCode 的统一分词采集仍未接入；它们的旧计数不会混进 v6。旧记录无法补出的窗口保留原始用量，新的自然请求才会积累新口径速度。

本地原始构建、探针和回归证据保留在 `.codex-usage/tps-aligned-20261030/`；没有提交或发布这些私有运行目录。
