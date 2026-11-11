# 工作区清理与文档整理

基线：`3a395c0`。先保存两个追加需求文档，再按用户授权归档旧实验和过时材料，删除已确认可重建的产物，最后重整文档索引。每批验证后独立提交。现用组件、原始输入、历史事实、恢复备份与已安装服务保持原样。

## 已完成批次

1. `3a395c0`：提交追加需求复审计划及任务清单；`git diff --check` 通过。
2. `bfd004a`：测试入口迁移，将四来源追加／修订夹具移入 `test-support`，独立保留分析测试使用的 `business`、`regressed` 及其计算辅助；两份现行测试不再导入实验目录。夹具原始字节相同，保留函数体未改，11 项原有测试全部通过。首次沙箱运行的两项 EPERM 来自临时文件原子重命名限制，正常 Windows 临时目录复跑通过；未因此放宽测试断言。
3. `4fb0ad9`：旧实验与材料归档，外部 ZIP 逐文件验证 413 项、5,541,374 bytes，包括一份未跟踪的压缩夹具；源码快照提供原版本的运行依赖。删除原实验树、原型手动 CI、一次性架构图及根目录旧交接笔记，71 份历史 Markdown 迁入 [归档目录](../archive/2026-11-11-experiments/README.md)，36 份引用文档更新链接。清理工具移入 `scripts`，只调整默认工作区相对路径。117 个现用运行／配置文件摘要相同，108 份相关 Markdown 无新增断链；移出后的 11 项测试、清理工具 SelfTest、typecheck、零 warning lint、format、native:check、skins:check 均通过。历史输入、恢复备份和 `clear/ontology` 保留。
4. 可重建缓存清理：仅删除两个旧 Playwright 测试 profile 下的 12 个 HTTP／编译代码／GPU 缓存目录，共 16,579,424 逻辑字节（约 15.81 MiB）。原有清理工具 Preview、Delete 与删除后路径检查通过；截图、结果、Cookies／Local Storage、冻结 capture、数据库恢复副本及现用助手保留。目录总容量未作为可回收容量，不打开 SQLite 或清空整个 `output`／`.codex-usage`。删除回执：`output/windows-parallel-20261109/cleanup-20261111/20261111T1220065027641Z-Delete-receipt.json`。

本轮日志保存在 `output/cleanup-20261111/`。以下归档、生成物清理和文档整理的结果在各批完成后补入。
