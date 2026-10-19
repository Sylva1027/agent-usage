# M5.7 final preflight C

只读范围：最新 aggregate `m57-aggregate-selected-20261018T205439Z-10707200`、其 10 个源 candidates、7 个共享 full manifest、2 个 baseline、2 个 supplemental，以及十款 choice 记录。
聚合契约：10 candidates / 10 selected inputs / 10 provenance items，十款恰好各 1；原 candidate 对象与源 `candidates.json` 逐项一致，rejected=0。
绑定：candidateId、candidateHash、sourceRun、fullCaptureRun、baselineRun、supplementalRun 均与 provenance/selected inputs 一致；候选 profileHash 与 currentInputs/profileHash 一致。
Profile snapshot：十款均存在且与源对象一致；版本 1 六款、版本 2 为 Kimi/Qwen/Muse/Mimo，匹配各自来源，无统一 v2 要求。
选择来源：`M5-selected-directions.md` 十行均能定位对应 candidate/source/full run，十条 `user-choice.md` 均存在并明确写出当前 candidateId。
Full 证据：7 个唯一 full manifest 均 `complete=true`，十款 candidate 均 `captured` / captureComplete=true；记录的 manifest SHA 全部匹配。
补充证据：Kimi/Muse baseline 与 Kimi/Qwen supplemental 的绑定字段一致；按指示未重复复验已知两项 focus PASS。
唯一漂移：provenance 记录的 `selectedDirections.sha256` 是 `4e06467e...`，当前 `M5-selected-directions.md` 实际为 `b81e4908...`；当前文件含 aggregate 后的 M5.7 更新，故该不可变快照已陈旧。
该漂移只影响 selected-directions 文件快照，不改变十款 candidate/source/full-capture 绑定；未发现其它缺字段或真实绑定漂移。
边界：未做全仓 hash、未重跑捕获/测试/浏览器、未修改公共代码；不声称 ready 或正式 assessment。
