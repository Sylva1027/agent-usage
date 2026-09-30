# OpenCode 接入进度（执行依据见 `docs/opencode-adaptation-plan.md` v2.1）

- [x] **P0** `-free` 零费率规则（`src/pricing.js` + `test/pricing.test.js`，250 pass）
- [x] **P1** `src/opencode-usage.js`（发现/解析/映射/版本守护/隐私白名单）
- [x] **P1** `test/opencode-usage.test.js`（三组 fixture 语义测试 + 回归/粒度/版本/发现/容错/哨兵，16/16）
- [x] **P2** `src/usage-core.js` 接线（分类/发现/指纹/分派/report/index，34/34；真库已发现 `Main OpenCode`，事件等 P3）
- [x] **P3** `src/usage-store.js` + `src/server.js`（索引/元数据/导入标签；真库逐位一致 44,044,846）
- [x] **P4** 前端 + i18n（`HARNESS_ORDER` / 限额排除 / 文案；真库命中率 95.0% ≤ 100%）
- [x] **P5** 三路一致断言 + `docs/opencode-data-source.md` + README + 真库对照（逐位一致 62,164,162）
- [x] 收尾：探针已删，全门禁重跑（304/304，tsc/lint/format/export 全绿），待提交
