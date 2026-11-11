# 四原型共享契约（实施用）

> 历史材料，2026-11-11 归档。本文命令与状态属于原记录日期；源码及恢复方法见[归档入口](../README.md)。

用户计划：docs/plans/2026-11-01-architecture-prototypes.md。当前基线为 0.8.5，HEAD 6d458ca，当前产品已经移除 TPS；不得将旧实验 TPS 当本轮业务对拍通过。

本轮只编辑 experiments/architecture-20261101/、output/architecture-20261101/ 与原实施计划进度。不能修改 src/、public/ 或活动数据。

## HTTP 接口

所有原型提供同样的 JSON API，监听 127.0.0.1，端口可为 0；启动 stdout 一行 JSON `{ "port": 12345, "backend": "node-sqlite|rust-sqlite|rust-redb|rust-duckdb" }`。

- POST /api/commit：一次原子来源替换，body `{sourceId, events, cursor, context?}`。sourceId 非空。events 是当前产品 UsageReport.events 的完整事件对象数组；每条必须 eventId、timestamp（有效 ISO 字符串）、sessionId、homeId 和 total 五字段 input/cached/output/reasoning/total（非负安全整数）。事件身份为 sourceId + eventId；同来源重复 ID 拒绝。cursor 任意 JSON，用于完整校验后游标/摘要保存；只有事务成功才推进。context 是可选全局 report 元数据 `{homes,sessions,warnings,rateLimitObservations,generatedAt,...}`。返回 `{revision,eventCount}`。
- GET /api/report：按 timestamp、sourceId、eventId 稳定排序返回 `{revision,events,context,cursors}`。可用 start/end（ISO，包含端点）、excludeHomes（逗号列表）、snapshot（已冻结版本编号）过滤。没有任何业务字段裁剪。
- GET /api/query：相同过滤参数，返回 `{revision,eventCount,sessionCount,homeCount,totals,models,channels,projects,repositories,timeline}`。totals 五字段求和；分组行 `{name,count,sessions,total}`，按 total.total 降序/name 升序；models 保持原名，项目用 cwd 或 Unknown cwd，repository 用 repositoryKey 或 Unknown repository；timeline 按 timestamp 的 UTC 日分组并按日升序。范围/价格/额度等完整原产品公式由 /api/report 数据通过统一 Node 兼容层复用现有 summarizeUsage 等函数做完整对拍；原生核心接口不得冒充完整产品 dashboard 的原生移植。
- GET /api/status：`{revision,eventCount}`。
- GET /api/cursors：`{revision,cursors}`；只读薄游标视图，采集器检查并发与重启进度时不传输完整事件历史。
- POST /api/freeze：持久化当前事实+context+cursors的冻结版本，返回 `{snapshot: revision}`；快照在重启后仍可查，后续提交不能改变它。
- GET /api/health：`{ok:true,backend}`。
- GET /：同一份原型浏览器页面，可由主代理给出的文件路径 --web 指定，浏览器处理实际 query/filter/version，不显示伪造数据。

返回 JSON 错误状态 400（输入错误）、404（未知快照/路由）、500（存储失败）；失败不能推进 revision。支持 SIGINT/SIGTERM 正常关停。commit 负载上限 64MiB，不能把响应写入源日志。GET report 不接受路径读写参数。

采集并发补充：commit 可选字段 expectedCursor，缺失表示无条件替换，null 表示要求来源尚不存在，其余值表示要求该来源当前 cursor 与给定 JSON 结构相等。检查与提交必须在同一写事务或单写者互斥边界内完成，冲突返回 409 且不推进版本。采集器使用此条件提交，并对冲突有限重采集，避免两个进程在“检查后、提交前”互相覆盖。

## Rust 存储模块（owner：backend worker）

路径 native/src/storage.rs，公共结构与 trait 固定如下；core worker 只调用，不修改。

```rust
use serde::{Serialize,Deserialize};
use serde_json::Value;
use std::collections::BTreeMap;
pub type StoreResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct State { pub revision:u64, pub sources:BTreeMap<String, Source>, pub context:Value }
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Source { pub events:Vec<Value>, pub cursor:Value }
pub trait Storage: Send {
  fn load(&mut self, snapshot:Option<u64>) -> StoreResult<State>;
  fn commit(&mut self, source_id:&str, source:&Source, context:Option<&Value>) -> StoreResult<State>;
  fn freeze(&mut self) -> StoreResult<u64>;
}
pub fn open(backend:&str, path:&std::path::Path) -> StoreResult<Box<dyn Storage>>;
```

storage.rs 是 trait/dispatch 文件，由 backend worker 所有。SQLite 实现路径 native/src/sqlite.rs，core worker 所有，导出 `pub fn open(path:&Path)->StoreResult<Box<dyn Storage>>`。redb.rs/duckdb.rs 由 backend worker 实现。全局事务包含来源事实替换、cursor、context、revision；snapshot 也须事务化。SQLite synchronous=FULL，redb immediate durable，DuckDB 正式事务；不关闭可靠性设置。初版统一逻辑状态，不将存储对象 JSON blob 基准宣称为列式分析加速；物理布局和仍未原生化的路径须在交付中写清。

## 文件所有权

- Worker A：node/ 下的 P1 和 collector 文件、局部测试。Node SQLite 使用 node:sqlite。collector 使用当前 parseSessionFile 和 streamDshSessionEvents 做完整校验再替换来源，必须检测同大小/mtime内容改变、坏帧/半行/失败不覆盖已接受来源。暂不做未经证明的跳过全文校验。
- Worker B：native/Cargo.toml、Cargo.lock、src/main.rs、src/model.rs、src/sqlite.rs 及 native tests；原生服务不每请求启动 helper，不调用 Node 进程计算 query。
- Worker C：native/src/storage.rs、redb.rs、duckdb.rs、BACKENDS.md 和存储局部测试；Cargo 依赖变更交给 B；优先 duckdb bundled 编译，如有可靠预编译本地动态库可用于原型，但记录可复现构建方法和平台限制。
- 主代理：夹具/兼容层/验证脚本、web、README、基线清单、计划进度。不要与 owner 同写文件。

三位 worker 都只完成当前卡后停下，不生成后代；任何权限/依赖失败如实报告。现阶段目标是四个可运行、可验证的后端与采集/查询链路；计划完整产品公式原生移植和正式规模性能验收不得靠接口降级宣布完成。
