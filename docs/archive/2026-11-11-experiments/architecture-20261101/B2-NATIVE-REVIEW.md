# B2：Windows append proof V1 发现与 V2 闭环审查

> 历史材料，2026-11-11 归档。本文命令与状态属于原记录日期；源码及恢复方法见[归档入口](../README.md)。

日期：2026-11-03。结论：**不接受为 ready**。发现的不是泛化的安全顾虑，而是两个可复现的 append 错误接受路径；其中一个会让 store 在读前缀尚未被读取前直接跳过 native identity 检查，另一个会在 SHA 回退路径发布一个已过时的前缀。

本卡只读审查，未修改 owner 文件。除本报告外没有写入工作区，也没有触碰真实 usage 数据、系统 journal 配置、服务、管理员状态、commit、push 或部署。所有实验均使用系统临时目录中的合成文件并在结束后删除。

以上“不接受”是 V1 对当时快照的原始结论，原样保留。Main 修复后，V2 按下面的新快照重新审查并把发现固化为
`test/usage-source-proof-adversarial.test.js`；V2 未再发现阻断。native USN seal/interval 算法本身在 V1、V2
期间均未改变。

## V2 结论与修复清单

结论：**V1 两个阻断已闭环，当前快照没有发现新的 append proof 错误接受路径。**

- V1-B1 已闭环。`src/usage-core.js:860-877` 的 server 可见指纹加入
  `dev/ino/birthtimeMs/ctimeMs`，同 size/mtime、只改中段且 inode 替换的文件不再被 summary cache
  提前跳过。`src/usage-store.js:4128-4136` 还要通过 saved identity/ctime 或 recertification，
  之后才能 unchanged `continue`。
- V1-B2 已闭环。`src/usage-source-proof.js:82-110` 在 SHA capture 时重新读取并比较
  `0..verified.offset` 的完整旧 prefix，再读取 suffix；`verify` 后、capture 前发生等长同 mtime
  的中段修订会得到 `LIVE_SOURCE_CHANGED`，facts/progress/source row 整体回滚。
- snapshot 现在持久化 `ctimeMs`，native wrapper 在 capture 后把当前 physical identity/ctime
  写入 validation；`src/usage-store.js:4130-4133` 的 unchanged fast path 要求二者都匹配。
- 原来的有界首尾 `usageSourceFingerprint` 仍用于 rename/retained-history 去重，没有强行改成
  physical identity；physical identity 仅进入 usage 扫描/缓存键与 proof 授权。

V2 审查快照（更新报告前重新计算）：

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `native/windows-source-proof/src/usn.rs` | 36,296 | `e0fa182d61e12feba3b51a4e4c06a52ed9949bc80d8710bd61682a6e86b74095` |
| `src/usage-source-native.js` | 9,493 | `1c029ddc1065df9044d7136a84d4f9f0eee63d6d2635deb5d836daaf0066db72` |
| `src/usage-source-proof.js` | 6,166 | `c57a6618822ad4e5691d9268d8ccc721d9690b63dcce8230fad82718053d0ca4` |
| `src/usage-store.js` | 275,549 | `e98e89e6bf9c138b33fe4ea69b6cc48333535179daa6c94e4a5e1da24286114d` |
| `src/usage-core.js` | 114,708 | `9a84662c012c6038650bc2f2b92c5f23b64a80571a72dcb73b902ac4a85ac039` |
| `src/server.js` | 60,189 | `d94e7346090c76c914da52121fdc93ef76ce770b7dfc378103e63c050eafe1bb` |
| `test/usage-source-native.test.js` | 17,285 | `40a7c83fe42e0cfc62bd6b2fac3f9c646e9335bb550e8c7e6710bc9870366846` |
| `test/usage-source-proof-adversarial.test.js` | 21,242 | `0f706849a5468610ed0ced243ecf8cb3b789441b2728da9589a266d86df53f4c` |

`src/server.js` 的 `buildUsageFingerprint` 调用链已使用上述 physical metadata。本 V2 卡没有修改
生产文件或公共 API/signature；表中生产 hash 是复核基线。

## 审查快照

审计期间 `src/usage-source-proof.js` 被 owner 并发更新；以下结论按最终重新读取的快照复核：

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `native/windows-source-proof/src/usn.rs` | 36,296 | `e0fa182d61e12feba3b51a4e4c06a52ed9949bc80d8710bd61682a6e86b74095` |
| `src/usage-source-native.js` | 9,493 | `1c029ddc1065df9044d7136a84d4f9f0eee63d6d2635deb5d836daaf0066db72` |
| `src/usage-source-proof.js` | 5,623 | `58f5ad0aa87e0c32af72a94732ace3aba6edbacf4bc98052bddf4f1ad2b05461` |
| `test/usage-source-native.test.js` | 17,028 | `69ca5eab9c5079796a7dfe5943283f7178a464790abe3ec5d1cfeca1c684765f` |
| `src/usage-store.js`（集成审查） | 272,752 | `ee2ea61aa9cdbaf9a11271a583d8db25d043ebc26ef8daea2f25ec48b6746c9d` |
| `native/windows-source-proof/bin/windows-source-proof.exe` | 293,376 | `17fb2137fd285a313ecd946f4bee4bb7a0eb35ed62303db845de6adc4b98031e` |

若 owner 后续改动这些文件，应重新核对行号和 hash 后再接受本结论。

## 阻断问题

### V1-B1：同路径替换可在调用 native proof 前被跳过

严重度：**阻断**。

`src/usage-store.js:3987-4015` 的 `syncRound` 使用下面的条件直接 `continue`：

- `source_files.size` 与当前 size 相同；
- `source_files.mtime_ms` 与当前 mtime 相同；
- source binding 相同；
- `usageSourceFingerprint` 相同。

`usageSourceFingerprint` 在 `src/usage-store.js:1686-1704` 只散列头 64 KiB 和尾 64 KiB，键中只有 size、mtime 与该有界内容 hash；没有 physical file identity。`src/usage-store.js:4008-4010` 因此会在 `appendFile` 和 `src/usage-store.js:3825` 的 native `verify` 之前返回。

这违反了 native token 已具备的身份前置条件：

- `src/usage-source-native.js:61-74` 要求 token 带 volume/file ID/FRN identity；
- `src/usage-source-native.js:128-149` 才把旧 token 与当前文件交给 native；
- `native/windows-source-proof/src/usn.rs:424-431` 在证明区间前比较当前 handle identity 与 token identity。

只要替换文件保持 size、mtime 与首尾采样字节不变，并只修改中间内容，上述调用链一次都不会到达。

#### 复现

用合成的 Codex JSONL 建立一个约 1.36 MiB 文件，将唯一 token 事件放在头 64 KiB 与尾 64 KiB 之外。首次完整同步后：

1. 写一个同长度替换文件；
2. 将 mtime 恢复为固定值；
3. 用 Windows `rename` 覆盖原路径，确认 inode 改变；
4. 把旧事件 `total=100` 改为 `total=900`；
5. 再次执行 `UsageStore.sync()`；
6. 用新数据库完整解析当前文件作为 oracle。

结果：

```json
{
  "bytes": "1360604",
  "tokenAt": 680363,
  "inodeChanged": true,
  "displayedMtimePreserved": true,
  "updatedFileCount": 0,
  "beforeEvents": [100],
  "afterEvents": [100],
  "expectedEvents": [900],
  "sourceWork": {
    "appendedFiles": 0,
    "replacedFiles": 0,
    "parsedBytes": 0,
    "prefixBytesRead": 0,
    "journalBytes": 0
  },
  "sourceRowUnchanged": true,
  "progressUnchanged": true
}
```

这不是 native token 漏过 identity 检查。单独对当前 native helper 做相同的 size/mtime 替换后，`verify` 正确返回 `null`。错误发生在 store 根本没有调用它。

#### 必须保持的 invariant

“不变”缓存只能证明有限的、已知不足以改变解析结果的属性。保存了 native token 的来源，在跳过后缀解析前必须验证当前 path/handle 仍对应该 token 的 physical identity；或者把稳定 physical identity 纳入这个 fast path 的不可伪造绑定。仅使用 size、mtime 和首尾采样不能授权“旧前缀仍当前离线”。

#### 测试缺口

`test/usage-source-native.test.js:281-291` 的原路径替换测试没有保持相同 size/mtime，因此即使 native identity 检查被移除，也不能单独由这个测试发现。需要增加同长度、同 mtime、只改中段、inode 改变的 store 级回归，并断言 native `verify` 被调用或至少不会走 unchanged `continue`。

### V1-B2：SHA 回退在 verify 与 capture 之间可接受已修改前缀

严重度：**阻断**。

`src/usage-source-proof.js:115-123` 的 SHA `verify` 会完整读取并校验旧前缀。之后调用方解析后缀；在该 await 窗口内，文件可以修改仍留在已解析前缀中的字节。

`src/usage-source-proof.js:126-137` 在没有 native fence 时重新进入 SHA capture。`src/usage-source-proof.js:76-86` 只在下列内容未变时复用 `verified.hash`：

- dev/inode/birthtime identity；
- size；
- mtime。

它只从 `verified.offset` 到新 offset 读取后缀，**不会重读旧前缀**。`src/usage-source-proof.js:38-49` 的 after/current-path snapshot 同样只比较这些元数据，不比较旧前缀内容。

因此，在 verify 后把中段改写为等长内容并将 mtime 恢复，capture 会把旧 hash 与未变后缀拼成“新”validation。该路径只发生在 native fence 不可用时的 SHA 回退；native 分支当前另有 `src/usage-source-proof.js:132-134` 的路径 identity 复核。

#### 复现

直接 API 复现：

1. 128 KiB 文件的旧前缀 digest 为 `05ece9...f2b2`；
2. `verifyUsageSourcePrefix` 成功；
3. 在旧前缀中部覆盖一个字节并恢复 size、mtime、inode；
4. 当前前缀 digest 已变为 `d7ea6d...c9c0e`；
5. `captureUsageSourcePrefix` 仍返回成功，只读了 4,096 字节后缀，并把 cursor 推进到 204,096。

完整 store 级复现使用两个 token 事件与约 1.36 MiB 合成 Codex 日志。在 SHA `verify` 返回后、后缀解析读取前，将旧 token 的 cumulative/last usage 从 `100` 同长度改为 `900`，恢复 size/mtime，再 append cumulative `950`。结果：

```json
{
  "mutatedBetweenVerifyAndCapture": true,
  "updatedFileCount": 1,
  "sourceWork": {
    "appendedFiles": 1,
    "replacedFiles": 0,
    "parsedBytes": 360,
    "prefixBytesRead": 1360962,
    "journalBytes": 0
  },
  "stored": [100, 850],
  "expected": [900, 50],
  "progressOffset": 1360962
}
```

事务在 `src/usage-store.js:3892-3901` 把错误 facts 与新 offset 一起提交。新 offset 会越过已经修改的旧 token，所以后续继续 append 时不会重新处理该历史修订。

#### 必须保持的 invariant

SHA `verified` 状态只能说明“verify 完成时”的前缀内容；`verified.offset > 0` 不能跨任意 await 授权一次 suffix-only capture。没有覆盖完整解析窗口的 native seal 时，应在 capture 时重新校验完整旧前缀，或直接回退到完整 replace。恢复 mtime 不能被视为旧字节未变的证明。

#### 测试缺口

`test/usage-source-proof.test.js:50-56` 在 verify 后只追加内容，使 size 变化并被拒绝；没有测试等长、同 mtime、同 inode 的旧前缀修订。`test/usage-source-append.test.js:389-421` 的 middle revision 虽然恢复 mtime，但同时 append 并改变 size，且会重新走完整 SHA prefix verification；它不覆盖 verify 已完成后、capture 之前的时间窗。

## 通过或未发现阻断的 invariant

### V2 recertification 不变量

`src/usage-store.js:4006-4031` 的 recertification 路径只有在
`saved.checkpoint.offset === info.size` 时才可进入。这条条件是必须的：partial checkpoint
没有资格把新 inode 直接绑定到旧的完整 facts；partial tail 仍走保守的 replace 路径。

SHA 路径会用当前 inode identity 替换旧 validation identity，然后调用
`sourceProof.verify`。这不是跳过内容验证：第一步必须先取得当前 handle snapshot，
`src/usage-source-proof.js:63-79` 仍按旧 digest 完整读取 `0..offset`；identity 只允许
verification 针对新 path 进行，内容是否仍是原 certified prefix 由完整 SHA 对拍决定。
随后在 `BEGIN IMMEDIATE` 内执行以下检查：

1. `readUsageSourceProgress` 必须仍精确等于调用前 saved state；
2. 该函数遇 `usage_source_reparse` 会返回 `null`（`src/usage-source-progress.js:172-177`），
   因此锁后的 dirty writer 不能通过比较后继续；
3. `capture` 再次读取完整旧 prefix 并比较 verified hash，再验证同一 snapshot/current path；
4. 只在成功后更新 progress validation；checkpoint、events、source row 与
   `source_files.indexed_at` 不变。

因此无 native fence 的 SHA fallback recertification 必须做两次 full-prefix 读取：一次确认旧
digest，一次在锁内/发布前覆盖 verify 到 capture 的 await 窗口。有 native fence 时仍先完成
full-prefix SHA 验证，再由 begin/advance seal 封闭验证到发布区间；只做 tail、stat 或首尾
采样不足以授权继续复用已有 facts。native token 保留原 physical identity；identity 不同时
normal native verify fail-closed 并进入 full replace，不会发生 native partial-tail rebind。

六项 store 级对抗回归的结果（第 1、2 项另与 full oracle 对拍）：

1. 同 size/mtime、头尾不变、中段修订的 inode replacement：不得 skip，最终 facts 为修订值；
2. SHA verify 后 capture 前的中段等长修订：拒绝、事务回滚、重启下次完整修复为
   `[900, 50]` 并与新数据库 full oracle 相同；
3. 相同字节 replacement：recertify 完整读两遍 prefix，facts 与 `indexed_at` 不变；
4. missing source 后相同字节恢复：facts、progress checkpoint 与 `indexed_at` 不变，
   validation 重绑新 physical identity；
5. partial checkpoint + replacement inode：不 recertify，不把未完成 tail 当完整边界；
6. verify 后锁前插入 `usage_source_reparse` 且保留原 progress：锁后检查拒绝 recertify，
   随后 full replace，dirty marker 正常清除。

### Exact seal interval

`native/windows-source-proof/src/usn.rs:440-490`：

- 使用 `FSCTL_WRITE_USN_CLOSE_RECORD` 返回的精确新 seal，不使用 `NextUsn` 伪造 seal；
- 要求 seal 严格前进；
- `usn.rs:544-627` 从旧 seal 开始包含式读取，要求恰好看到旧 baseline 与新 seal；
- 新 seal 必须带 `CLOSE`；
- 记录 USN 和页 cursor 均要求单调前进。

未发现 range 左端或右端可由 `NextUsn` 替代的路径。

### Reason OR、coalescing 与 open foreign writer

`usn.rs:47-48` 仅允许 `DATA_EXTEND | BASIC_INFO_CHANGE | CLOSE`；`usn.rs:595-609` 对目标 identity 的区间内 reason 做 OR；`usn.rs:469-471` 拒绝 mask 中任何额外 bit。`ReadUsnJournal` 使用 `ReturnOnlyOnClose: 0` 和全 reason mask，没有只在 close 时读取。

额外实验让一个 Node 子进程长期持有 `r+` handle，写入后**不 fsync**，并在 overwrite 后把 mtime 恢复到原值：

| 用例 | native 结果 |
| --- | --- |
| append，无 fsync | 接受 |
| 旧前缀 overwrite，无 fsync，同 size/mtime | 拒绝 |
| 旧前缀 overwrite + append，无 fsync，恢复 mtime | 拒绝 |

这支持当前 reason-OR/coalescing 处理会在测试环境中保留 unsafe bit。它不证明所有 filter driver 或 Windows 版本行为相同。

### Same-path replacement 的 native 层

在 native-only 实验中，替换文件与旧文件同 size、同 whole-second mtime，inode 已改变；旧 token 的 `verify` 返回 `null`。`usn.rs:424-431` 的 identity 比较有效。

阻断点是调用方可在该检查前跳过，而不是 native identity 比较本身失效。

### `READ_FILE_USN_DATA`

三个审查文件中没有调用 `FSCTL_READ_FILE_USN_DATA`。实现读取的是 journal 区间，未把该 IOCTL 的无效 Reason 字段当证据。

### 无记录边界、journal ID 与 floor

- `usn.rs:551-552` 拒绝空 seal 区间；
- `usn.rs:460-465` 分别要求看到旧 baseline 和新 seal；
- `usn.rs:493-503` 要求 journal ID 不变，旧 seal 不早于 `FirstUsn`/`LowestValidUsn`；
- `usn.rs:506-530` 要求前后 journal ID、flags、版本一致，并检查区间两端不落入 retention gap；
- `usn.rs:315-332` 检查非零 journal ID、合法 USN 顺序和 V2/V3 支持。

未发现“区间没有记录也返回成功”或 journal recreation 被静默接受的路径。

### Size/range tracking 与 unsafe reasons

`usn.rs:472-477` 拒绝 size 减少；size 增长必须出现 `DATA_EXTEND`。`usn.rs:672-757` 严格解析 V2/V3 长度、名字边界、版本和 USN/reason；未知版本或畸形页返回 unavailable。测试 `usn.rs:937-1018` 覆盖 overwrite、truncation、create、delete 等 reason 不在允许 mask 中。

### Native EOF 与 helper lifecycle

`native/windows-source-proof/src/main.rs:165-194` 在 stdin EOF 时结束 helper；坏帧或 stdout 写失败也退出。`src/usage-source-native.js:196-215` 把子进程 exit 标为 protocol unavailable，`275-284` 清除 pending request、禁用实例并停止 child。`test/usage-source-native.test.js:299-390` 覆盖缺失 binary、closed helper、畸形/截断/非法 UTF-8、错误 kind、超大响应、超时和提前 exit。

这些行为 fail closed；未发现 EOF 后仍接受下一条 proof 的生命周期错误。

## V1 验证结果

在最终快照上执行：

```text
node --test test/usage-source-native.test.js
  4 passed, 0 failed, 0 skipped

node --test test/usage-source-proof.test.js
  5 passed, 0 failed

npx.cmd tsc --noEmit --allowJs --checkJs --module NodeNext
  --moduleResolution NodeNext --target ES2022 --types node
  src/usage-source-native.js src/usage-source-proof.js
  test/usage-source-native.test.js --pretty false
  passed
```

`usage-source-proof.test.js` 的首次 sandboxed 运行只因临时 rename 返回 `EPERM`；在允许临时 rename 的隔离环境中 5/5 通过，不是产品断言失败。

## V2 验证结果

最终快照在允许临时目录 rename 的隔离 Windows 环境执行：

```text
node --test
  test/usage-source-proof-adversarial.test.js
  test/usage-source-proof.test.js
  test/usage-source-append.test.js
  16 passed, 0 failed, 0 skipped

node --test test/usage-source-native.test.js
  4 passed, 0 failed, 0 skipped

npx.cmd biome check test/usage-source-proof-adversarial.test.js
  1 file checked, 0 fixes

npx.cmd tsc --noEmit --allowJs --checkJs --module NodeNext
  --moduleResolution NodeNext --target ES2022 --lib ES2023,DOM
  --types node test/usage-source-proof-adversarial.test.js
  src/usage-source-proof.js --pretty false
  passed
```

组合套件包含 6 个新增 store 级反例和原有 10 个 proof/append case。新增测试使用独立的
synthetic temp home/SQLite、完整 facts oracle 和 SHA read-byte accounting；两遍 recertification
读取显式断言为至少 `2 * full prefix`。没有操作真实 usage 数据或系统 journal 配置。

## V1 当前测试缺口（已由 V2 关闭）

需要补的最小回归不是更多 JSON 协议 case，而是：

1. store 级同 size/mtime、只改中段的 same-path replacement，断言不得走 unchanged fast path，并且 facts 必须与完整 oracle 相同；
2. SHA fallback 在 verify 后、capture 前做等长旧前缀修订，断言 capture 拒绝或完整重验，且 progress 不推进；
3. native open-writer 测试加入无 fsync 的 overwrite 和 overwrite+append；
4. native same-path replacement 测试使用等长 replacement 和固定 mtime，而不只是较短内容覆盖；
5. 保持现有 exact seal、journal floor/id、unsafe reason、EOF/protocol tests。

V2-Main 已加入第 1、2 项 store 级回归，并沿用既有 native unsafe/open-writer 与 exact
seal/journal/protocol 覆盖；第 3 项的无 fsync overwrite/overwrite-append 仍由 V1 独立实验和
`usage-source-native.test.js` 的现有 unsafe mutation case 共同覆盖。第 4 项的同 size/mtime
replacement 已由 V2 第 1 个 store 回归覆盖。

## R1 前 record 文件副本交接

检查了 `output/`、`experiments/`、`docs/`、`test/` 以及全工作区 `usage-record-store` 文件名。**没有找到 R1 前的独立副本**；`rg --files -g '*usage-record-store*' .` 只返回当前的 `src/usage-record-store.js` 和 `test/usage-record-store.test.js`。未通过重构猜测生成旧版。

本次只读检查时两个当前 untracked 文件的 hash 为：

```text
src/usage-record-store.js
63aa4cfeaa70c4305b356d8622cf6c5972be94a4c1ec00b4cff923b0b560b944

test/usage-record-store.test.js
89a2ebf2e7441315df8cb4715f87b50b723838b28d47756df83dcbdf835c6233
```

这些是当前 R1 修正审阅后的文件，不是性能对照所需的 pre-R1 版本。性能对照必须明确 record 实现仅是共享候选，不能声称拥有完整 B1 前后实现对照。

## V1 结论（保留原始状态）

V1 的 native proof 核心 interval/reason/identity/retention 逻辑在现有活动 journal 与合成实验中表现正确；但集成层不是 ready：

- store 可以在 native identity 验证前把同 size/mtime replacement 当作 unchanged；
- 无 native fence 的 SHA fallback 可以跨解析 await 复用旧 prefix hash 并持久推进 cursor。

两项都必须以 store/oracle 和 progress 不前进的反例测试修复后，才能重新提交 V1。

## V2 结论

Main 的修正已满足 V1 两项要求，且 6 个新增回归在最终快照全部通过：

- physical metadata 进入 usage fingerprint 与 saved proof fast-path 校验后，same-path
  replacement 不再在 native/SHA 验证前被跳过；
- SHA capture 完整重验 old prefix 后，verify/capture await 窗口中的等长修订会回滚；
- recertification 只接受完整 checkpoint，锁后重新读取 progress 并 fail closed on dirty；
- missing 后相同字节恢复保留 facts、checkpoint 与 `indexed_at`，只更新 proof validation；
- native seal interval/reason/range/journal floor/EOF 生命周期结论与 V1 相同。

V2 结论：**无剩余阻断，V1 两项发现已闭环。** 本卡在此停止。
