# 实施验收口径与异常排除

## 冻结输入

沿用 v3 私有冻结来源与 seed.sqlite，不重做生产发现或冻结。before 使用开工前像，通过保留原 module URL 的加载器替换目标源码；after 使用工作树。固定 now 为 2026-10-26T15:00:00.000Z，价目、来源、汇率、时区和查询形状相同。各场景独立复制 seed，排除追赶与两轮稳定过程。

源身份为 `fd1f6fd2b1a66ce457926495e3f81ae4f9ffa2d3dee630708c406ed0134bec31`。追赶后两端均为 135,873 events、1,597 sources、53,161 perf samples、1,388 projections、1,394 owners、0 archives；seed 的原始行数不直接代替追赶后事实。六条缺失来源的历史事实由独立保留断言验收。

## 两项测试侧修复

1. 旧恢复脚本将 JSON Double 转为 Decimal，丢失时间戳的小数精度，造成 after 额外追赶 33 个文件。该批次保留为 `excluded-timestamp-after-*`，不计入正式分布。新实施侧恢复脚本直接用 System.Text.Json.GetDecimal 读取原始 JSON 数字，以 100ns 设置时间；重新验证全部 1,630 个副本的长度，以及本轮恢复的 Claude/ledger 时间戳。正式 after 追赶与 before 同为 5 个文件，来源指纹完全一致。旧 v3 脚本及证据未修改。
2. 此前 before 完整摘要搬入私有目录时，PowerShell 把整秒 ISO 字符串解析为日期，重写时省去了 `.000`。对存档做严格的日期格式还原后，其 JSON SHA-256 与 before 进程当场记录的原始摘要哈希完全相同；after 每档 21 次的完整摘要哈希也逐条一致。此操作未扩大易变字段白名单，仍只移除 generatedAt、perf.indexedAt、perf.meta.indexedAt；费用、范围、性能、告警、quota 和 indexVersion 均参与原始哈希。

## 工程门禁

全仓使用 Node `--test --test-concurrency=1 test/**/*.test.js`，Job 7,168 MiB、heap 1,536 MiB。首轮共 3,301 项，3,274 通过、25 跳过、2 失败；失败均为 Node fetch 的 `bad port`，发生在 HTTP 请求进入产品逻辑前。原命令与完整栈留存 `evidence/full-test.txt`。随后同源码定向执行整个 perf-codex-api 文件，5/5 通过，包括两项失败用例，不篡改首轮为全绿。

最终类型检查发现最小 request 映射中的数组缺少 JSDoc，补齐类型标注后通过；这是全仓启动后的唯一产品文件差异，不改变运行时表达式。最终源码身份单独留存。lint 与 format 检查不做自动修复；lint 原有告警按原样保留。

## 内存与隔离

各本地 Node/npm/SQLite/browser 场景串行使用唯一执行槽。小夹具 Job 1,024 MiB；全仓、真实副本与浏览器树 Job 7,168 MiB，Node heap 不超过 1,536 MiB，另留约 1 GiB 控制余量。浏览器最多两个标签页。Node RSS 采样不代表整树峰值；整树预算由 Windows Job 硬限约束。普通 sandbox 的原子 rename/junction 限制通过相同预算的提权复核处理，不改产品规避权限。

所有受控写入仅针对私有冻结副本；结束后恢复长度与精确时间。未操作 tools/out SQLite，未重启或迁移生产，未提交/推送。
