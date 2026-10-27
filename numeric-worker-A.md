# numeric worker A - Magpie timing reader

状态：A1 done；A2 只读核对 done。未验收，未改真实索引、配置或服务；A2 未改 `src/`、`test/`。

## A1：reader 与局部测试

- `src/perf-magpie-timing.js`：保留已有增量字节 offset、完整行处理、文件轮转/截断检测、未写完行下次从首字节重试，以及同 response 冲突变体不择一。
- 修正 `tries` / `retried_ms` 门槛：合法非负字段不再单独否决；畸形值仍拒绝。源码证据表明通用 `serve()` 与 Codex 直通路径的内部重试都包含在 `ms` 中。
- 保留仅对显式 `provider=codex`、`req=codex/<model>`、`model=<model>` 的 alias 归一；其余请求模型原样交给 timing kernel 判冲突。
- `test/perf-magpie-timing.test.js`：增加有效重试字段保留、畸形重试字段拒绝，以及通用/直通两种字段形状都保留的断言；测试临时目录放在 workspace 内，避开 sandbox 对系统临时目录 `rename` 的 EPERM。

验证：`node --test --test-isolation=none test/perf-magpie-timing.test.js`，6 passed、0 failed；两个文件 `node --check` 通过。

## A2：两条 123 测试候选的只读核对

范围仅限新 A/B 会话中今天最初两条 completed 候选，输出分别为 102 和 148（合计 250）。

- 两个原生 turn 各只有 1 个请求；都带 `response_id`，当前文件重新投影后均为 `requestSetComplete=true`、无冲突，模型和输出字段正确。
- 两条 native `response_id` 在本地账本中都能精确命中且各只有 1 行；两行都通过 reader 的全部门槛。
- 直接调用 reader 的 `addLine` / `recordsForRequest`，两条都返回 1 条可接受 evidence，模型、输出、正时长均精确匹配。
- 因此不是“账本确无同 ID”、不是“reader 拒绝字段”，也不是“新 parse/投影无法识别请求”。
- 但索引快照中两条样本仍是 `completed / duration_missing`，`timing_source=unknown`、`request_count=1`；两条 response 都没有 `perf_request_timing_evidence`、`perf_request_timing_threads` 或 dirty 行。
- 快照里的 326 条 evidence 全部是旧 reviewed origin，当前 reader origin 为 0。两线程的原生文件在最后索引后继续增长，存储投影与已发布指纹/当前源状态未对齐；timing enrichment 没有通过可信投影发布门，因而没有建立 native link/evidence，旧样本也就不会被标脏重建。

聚合原因：**索引侧 native 投影/发布信任门未放行，导致账本 evidence 未导入、线程未链接、样本未重建；不是账本缺失或 A1 reader 字段拒绝。**

下一步：B2 的数据库/index 修复后，对这两个 Codex 线程做一次稳定全量重同步，确认两条 response 出现 timing evidence + native thread link，并让对应样本从 `duration_missing` 重建为带时长；若仍失败，查投影发布指纹/可信门，不要回到 reader 加宽松匹配，也不要用时间差代填时长。

## 边界

- 账本字段不能确切识别 `codexFallBack()` 的跨入口重计时。`sent_ms`/`own_ms` 只能证明通用 `serve()`，而 fallback 也会重新进入 `serve()`；`tries`/`retried_ms` 也不是跨入口信号。因此没有新增排除启发式，也不声称每条 row 都是完整 client E2E。
- reader 只提供 producer 账本的请求窗口；最终是否发布仍由既有 native `response_id`/model/output 精确匹配及 timing kernel 决定。
- A2 只读临时 SQLite 副本，未做全量调查、页面验收或真实索引写入；usage-store 接线及 integration test 由 B/主审负责。
