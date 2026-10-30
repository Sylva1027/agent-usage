# Desktop 采用结果

2026-10-30，用户明确回复“准备好了，现在重启”，配合重启后手动 resume。

实际 Desktop app-server 已采用完整 release 并排包，父子进程关系、执行路径与 SHA-256 均已核对。引擎 SHA-256 为 `64cac13a8aebaaca6c58ecc76b8472c7cfb96b0bc10e3b92c3398f4bd3054ab4`。本机启动选择已保存，看板进程保持原身份。

恢复后，10 个自然请求已完成原生 schema 3 摘要、内存 reader、SQLite 和正式 tps-v6 API 的逐条核对。独立重算窗口时间并集、平均值和 P10/P90 全部一致。没有为验证额外发起模型请求；请求身份、真实用量与逐条证据仅存本机。

重启辅助程序有两处状态问题：第一次遇到已退出子进程的 PID 被 Windows 复用而中止；修正后不再把新 PID 占用者视为旧进程，也不会结束它。第二次实际新引擎已成功启动，但 Desktop 日志混入启动器输出导致整段 JSON 解析失败。恢复后按唯一结果行和实际进程重新核验，修正成功状态并保存引擎选择，没有再次重启。

第一次重启前记录的两个独立 CLI app-server 后来已退出，不能宣称它们存活；它们未被选入强制结束范围。DSH 插件与 WorkBuddy CLI 的真实运行时 localhost 验证已通过，正常使用后的采集仍待观察；WorkBuddy Desktop、Claude、OpenCode、ZCode 的统一采集尚未接入。
