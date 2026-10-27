# I1 首轮仪器失败（保留，不计入基线）

`runs/i1-sync-baseline` 原样保留。末条虽 exit 0，但 642,571,812 bytes / 10,501 reads 全部落在 unclassified/other，helper 与 phase 未激活，因此 catchup 7.59 s、unchanged 1.75 s 不作归因或性能验收。

根因在原 hook 的组合：文件系统 realpath 把逻辑 `src/...` 映到 `preimage/src/...`，原 loader 只识别仓库根 `src/`、`public/`，物理前像 URL 因此前往 nextLoad，绕过源码插桩，也绕过 `new DatabaseSync` 替换。旧轮不能作为“完整隔离已证”的样本；这里只确认绕过机制，不声称已证明某个生产库实际被读取。

`runs/i1-query-baseline` 同样保留。其 all 样本已有 keys 与 methods：原型包装生效，不能据 sync 中查询方法为空推出原型全部失效。源码 helper/窗口归因失败仍使该轮不属于修复后基线。

修复另存 `hook-fixed.mjs`，不覆盖运行中的原 hook：resolve 统一物理/逻辑前像 URL；load 同时识别两种路径并断言 canonical URL；固定模块摘要、模块导出 marker、UsageStore 类身份、setup.json 和 sync 实际 helper/phase 命中均参与检查。未命中先保存 invalid 样本，再使进程失败，不再允许“全 other + exit 0”。

此文件是静态根因分析。修复尚未经本 worker 运行；Main 调度新 run 名，保留旧文件与 identity，不覆盖原始失败记录。
