# B2 Windows reliable-append preflight: W1

日期：2026-11-03。

状态：能力实验完成；当前 E: 条件下不可取得可靠追加判定，需产品决策

## 结论

当前普通 Windows token（`DESKTOP-D61AMRC\Silver`，`Administrator=false`）的只读能力已经分别验证：

- 在 C: 的活动 NTFS 变更日志上，可通过 `C:\` 目录句柄成功调用 `FSCTL_QUERY_USN_JOURNAL`，也可直接调用 `FSCTL_READ_UNPRIVILEGED_USN_JOURNAL`（`0x000903AB`）。
- 在 E: 上，`\\.\E:` 的只读卷句柄可打开，但查询返回 `ERROR_INVALID_FUNCTION`（1）；E: 合成目录句柄返回 `ERROR_JOURNAL_NOT_ACTIVE`（1179）。没有取得 journal ID、checkpoint 或记录。
- C: 的常规 `FSCTL_READ_USN_JOURNAL` 对目录句柄返回 `ERROR_ACCESS_DENIED`（5），而新的 unprivileged 控制码成功。这表明当前能力不能用旧的“必须管理员”概括，也不能从 E: 的无活动日志推断 API 需要管理员。

因此，本卡对 E: 的结论只是：**在 journal 未活动且不允许修改系统状态的当前条件下，可靠追加判定不可用**。它不证明 unprivileged API 要求管理员，也不证明启用 journal 后 E: 永远不可用。C: 已经证明普通 token 的 API 路径存在且可工作。

由于 E: 是本次指定夹具所在卷，而取得 checkpoint/记录又需要先改变系统 journal 状态，本卡不能完成 append 与 prior-prefix overwrite+append 的 USN 对拍。这里出现实际产品决策：是否要求活动 journal 为 B2 快速路径的前提，或接受退出到有界前缀/内容校验的 fallback。不得从本卡宣称 B2 的可靠追加门槛已通过。

## 范围、身份与运行区分

实验只修改以下已授权位置：

- 探针：[b2-usn-probe.ps1](./b2-usn-probe.ps1)
- 本报告：`B2-WINDOWS-PROBE.md`
- 合成夹具与结果：`output/architecture-20261103/b2/usn-probe-*`

没有启用、创建或删除系统 journal，没有安装服务，没有进行 UAC 提权，没有写真实日志或数据库。C: 检查是只读的：没有在 C: 创建合成夹具，只通过 `C:\` 目录句柄保留日志状态、计数、buffer 字节数和 next USN，不保留第三方记录内容。

两个最终运行均使用：

- Identity：`DESKTOP-D61AMRC\Silver`
- Owner SID：`S-1-5-21-3420090778-2855960327-1689368763-1001`
- Administrator：`False`
- PowerShell：`7.6.5`
- OS：`Microsoft Windows NT 10.0.26300.0`
- E: 文件系统：NTFS，Fixed
- C: 文件系统：NTFS，Fixed
- 卷路径严格为 `\\.\E:` 和 `\\.\C:`，没有尾随反斜杠

精确命令：

```powershell
pwsh -NoProfile -File 'experiments/architecture-20261101/b2-usn-probe.ps1' -ProbeContext sandboxed
pwsh -NoProfile -File 'experiments/architecture-20261101/b2-usn-probe.ps1' -ProbeContext outside
```

最终证据：

| 场景 | 结果文件 | 自检 |
| --- | --- | --- |
| sandboxed | `output/architecture-20261103/b2/usn-probe-w1-20261103T043022477Z-04e9bacd/result.json` | passed |
| outside sandbox | `output/architecture-20261103/b2/usn-probe-w1-20261103T043031433Z-0e6c31e9/result.json` | passed |

outside 运行只移除命令沙箱，没有移除或获取 Windows 管理员权限。两个场景的身份、管理员位、E:/C: 能力状态和错误码一致；因此 E: 的阻断没有显示为 sandbox artifact。

## 作废的首次尝试

首次运行：

`output/architecture-20261103/b2/usn-probe-w1-20261103T042052375Z-797935bf`

其中 `FSCTL_READ_FILE_USN_DATA` 被错误编码为 `0x000900EF`。该数实际是 `FSCTL_WRITE_USN_CLOSE_RECORD`，所以首次运行中的 file-USN 证据全部作废，不能用于解释或通过本卡。

修正后的最终常量为：

| 名称 | 最终值 |
| --- | ---: |
| `FSCTL_QUERY_USN_JOURNAL` | `0x000900F4` |
| `FSCTL_READ_USN_JOURNAL` | `0x000900BB` |
| `FSCTL_READ_UNPRIVILEGED_USN_JOURNAL` | `0x000903AB` |
| `FSCTL_READ_FILE_USN_DATA` | `0x000900EB` |
| `FSCTL_WRITE_USN_CLOSE_RECORD` | `0x000900EF` |

本地 Windows SDK `winioctl.h` 和 `windows-docs-rs` 的定义与上表一致：

- [`FSCTL_READ_UNPRIVILEGED_USN_JOURNAL`](https://microsoft.github.io/windows-docs-rs/doc/windows/Win32/System/Ioctl/constant.FSCTL_READ_UNPRIVILEGED_USN_JOURNAL.html)
- [`FSCTL_READ_FILE_USN_DATA`](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_read_file_usn_data)
- [`FSCTL_WRITE_USN_CLOSE_RECORD`](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_write_usn_close_record)

## E: 合成序列

探针使用自包含 PowerShell `Add-Type` C# P/Invoke，在 `output/architecture-20261103/b2/` 的随机 `usn-probe-*` 目录创建合成 E: 文件。一个 writer handle 从初始写入开始持续打开，覆盖以下序列：

1. 初始写入 27 bytes；
2. 尝试取得 journal checkpoint 并读取 file-USN checkpoint；
3. 追加 11 bytes；
4. 再追加 11 bytes；
5. 读取 file USN；
6. 在中段覆写 5 bytes 后追加 23 bytes；
7. writer 关闭前查询日志与 file USN；
8. writer 关闭后再查询日志与 file USN。

最终内容长度与每次写入量均有断言。初始写入和最终 mixed mutation 的内容也经过精确验证，断言通过。

open-handle 期间的 E: 状态：

| 观察点 | 结果 |
| --- | --- |
| `\\.\E:` handle open（desired access 0） | success |
| `\\.\E:` handle open（read attributes） | success |
| `\\.\E:` handle open（generic read） | `ERROR_ACCESS_DENIED` (5) |
| `FSCTL_QUERY_USN_JOURNAL`：两个可打开的裸卷 handle | `ERROR_INVALID_FUNCTION` (1) |
| `FSCTL_QUERY_USN_JOURNAL`：E: 合成目录 handle | `ERROR_JOURNAL_NOT_ACTIVE` (1179) |
| journal checkpoint | unavailable |
| `FSCTL_READ_FILE_USN_DATA` 初始写后 | success, 152-byte record, USN `0`, Reason `0x00000000` |
| `FSCTL_READ_FILE_USN_DATA` close 前 | success, 152-byte record, USN `0`, Reason `0x00000000` |
| `FSCTL_READ_FILE_USN_DATA` close 后 | success, 152-byte record, USN `0`, Reason `0x00000000` |

直接测试新版 API 时，E: 的实际结果如下。这些是 API 调用结果，不是“未执行”推断：

| handle | `FSCTL_READ_UNPRIVILEGED_USN_JOURNAL` | `FSCTL_READ_USN_JOURNAL` |
| --- | --- | --- |
| `\\.\E:` desired access 0 | `ERROR_INVALID_FUNCTION` (1) | `ERROR_INVALID_FUNCTION` (1) |
| `\\.\E:` read attributes | `ERROR_INVALID_FUNCTION` (1) | `ERROR_INVALID_FUNCTION` (1) |
| generic-read volume handle | handle open failed with `ERROR_ACCESS_DENIED` (5)；未调用读控制码 | 同左 |
| E: 合成目录 handle | `ERROR_JOURNAL_NOT_ACTIVE` (1179) | `ERROR_ACCESS_DENIED` (5) |
| 合成文件 read handle | `ERROR_JOURNAL_NOT_ACTIVE` (1179) | `ERROR_ACCESS_DENIED` (5) |

所有 direct-read 尝试都使用 8、64、4096 和 65536 bytes 的有界 output buffer。E: 没有成功返回记录，因此不存在 buffer 越界或截断后继续解析的路径。

`FSCTL_READ_FILE_USN_DATA` 返回了文件元数据记录，但 Microsoft 文档明确说明该控制码返回记录中的 `TimeStamp`、`Reason` 和 `SourceInfo` 无效。这里观察到的 `Reason=0` 与 E: journal 不活动一致，但即便它非零也不能单独认证 append。

## C: 普通 token 只读对照

C: 对照用于判断 API 能力与 E: 特定 journal 状态，不把 E: 结果泛化到所有 Windows 卷。

通过 `C:\` 目录句柄取得的状态：

| 字段 | 值 |
| --- | ---: |
| `FSCTL_QUERY_USN_JOURNAL` | success, 80 bytes |
| journal ID | `0x01DD1DD4195F46CE` |
| first USN | `0x000000049B000000` |
| next USN（最终 outside 运行） | `0x000000049D229550` |
| lowest valid USN | `0` |
| max USN | `0x00000FFFFFFF0000` |
| supported major versions | 2 through 4 |

`\\.\C:` 的裸卷 handle 可打开，但其 `FSCTL_QUERY_USN_JOURNAL` 返回 `ERROR_INVALID_FUNCTION` (1)，与 E: 裸卷行为相同。成功能力来自目录句柄，所以不能把裸卷控制码返回的 `ERROR_INVALID_FUNCTION` 解释成 API 不存在。

直接 unprivileged 读取的有界结果：

| start USN | requested buffer | bytes returned | records | next USN |
| --- | ---: | ---: | ---: | ---: |
| first USN | 8 | 8 | 0 | unchanged |
| first USN | 64 | 8 | 0 | unchanged |
| first USN | 4096 | 4040 | 63 | `0x000000049B002480` |
| first USN | 65536 | 65480 | 1023 | `0x000000049B018970` |
| observed next USN | 8 / 64 / 4096 / 65536 | 8 | 0 | unchanged |

汇总：

- `FSCTL_READ_UNPRIVILEGED_USN_JOURNAL`：8 次 success；对两个裸卷 handle 的尝试返回 `ERROR_INVALID_FUNCTION` (1)；对目录句柄均 success。
- `FSCTL_READ_USN_JOURNAL`：0 次 success；裸卷 handle 返回 1，目录句柄返回 `ERROR_ACCESS_DENIED` (5)。
- 每个成功调用的实际返回字节数都没有超过请求 buffer。
- 第三方记录内容持久化数为 0；结果只保留状态、计数、buffer 字节数和 next USN。
- generic-read `\\.\C:` handle 也因 `ERROR_ACCESS_DENIED` (5) 未打开；能力由 `C:\` 目录句柄取得。

这些结果证明当前普通 token 在活动 journal 的 C: 上可以读 journal，不证明 unprivileged API 普遍可写、不需要目录权限或可以绕过所有 ACL。实验没有在 C: 创建夹具，也没有改动 C: journal。

## append 覆盖缺口

E: 的四个目标区间均未被 journal 证据覆盖：

| 区间 | checkpoint | 观察证据 | 能否证明只有扩展 |
| --- | --- | --- | --- |
| initial open write | pre-open query failed | file USN 0, Reason 0 | no |
| append one | 仅 file USN checkpoint；无 journal checkpoint | file USN 0, Reason 0 | no |
| append two | 无独立 checkpoint | file USN 0, Reason 0 | no |
| middle overwrite + append | 无独立 checkpoint | file USN 0, Reason 0 | no |

即使 journal 活动，Microsoft 的[变更日志记录](https://learn.microsoft.com/en-us/windows/win32/fileio/change-journal-records)也说明相同原因在未关闭的写入期间可以合并，close record 会汇总累计原因。因此：

- 不能把一个递增 USN 当作逐次 append 或逐次 overwrite 的独立证据。
- 同一 open-handle 期间的 append one、append two 和 mixed mutation 可能只留下一个合并后的文件记录。
- 独立区间必须有各自受覆盖的 checkpoint/记录范围；如果证据跨越区间但只有一个聚合记录，只能支持聚合结论，不能伪装成每区间证明。
- 若聚合 Reason 同时含 `USN_REASON_DATA_EXTEND` 和 `USN_REASON_DATA_OVERWRITE`/`USN_REASON_DATA_TRUNCATION`，不得归入纯 append。
- journal ID、首/尾 USN、buffer 完整性、文件身份和目标记录都必须同时核对；单一 file USN 或单一 reason flag 都不够。

本卡没有观察到 active-journal append/overwrite 对拍，因为 E: journal 不活动，而启用或创建 journal 超出授权范围。

## 最小安全路径

如果产品接受“活动 journal 可用”为前提，最小可校验路径是：

1. 先用正确卷/目录路径查询 `FSCTL_QUERY_USN_JOURNAL`，取得稳定 journal ID 和 checkpoint；所有句柄与 file identity（dev/ino/birthtime）匹配。
2. 对每个待证明区间保存 before next USN，并在相应写入彻底关闭后读取到至少等于 after next USN。
3. 按固定上限分页读取 `FSCTL_READ_UNPRIVILEGED_USN_JOURNAL`，拒绝短于协议头的返回、越界长度、malformed record、journal ID 变化和 checkpoint 落到 first/lowest valid 之前。
4. 目标文件的覆盖区间必须存在，并且 Reason 只允许可解释的 `DATA_EXTEND`/`CLOSE`；出现 overwrite、truncation、create/delete/rename 或无法解释的聚合标志时判为 unknown。
5. 只要任一区间缺少记录覆盖、checkpoint 不连续、文件身份改变或 buffer 可能遗漏，就退出快速路径。

该路径仍不能从一次成功例子宣称 constant-size journal work、固定延迟或 production safety。journal 活动度、日志保留窗口、记录密度和分页长度都必须实测；读取到目标 next USN 的工作量可能随无关活动增长。

当前可执行的最小 fallback 是：E: 无活动 journal 或上述覆盖条件任一失败时，分类为 `unknown`，使用有界前缀/内容校验来决定是否允许快速后缀处理；无法完成该验证时保留现有完整语义处理或报告无法安全增量。这个 fallback 是正确性路径，不能据本卡宣称已满足 B2 的性能目标。

## 需要产品决定

当前 E: 无法在不修改系统 journal 状态的前提下提供可靠 append 证据。主流程必须在以下两条之间选择：

1. 把活动变更日志、可取得 checkpoint 及无缺口记录覆盖列为快速增量路径的部署前提；不满足时由产品明确选择回退与可接受成本。
2. 不要求系统 journal，接受无活动日志时只走有界前缀/内容验证路径，并把相应读取/哈希成本列入 B2 验收。

本卡到此停止；没有接入正式采集、数据库 schema、页面或通知代码，也没有降低现有正确性和校验要求。
