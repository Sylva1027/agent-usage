# M5.7 正式汇总验收（2026-10-19）

状态：**ACCEPTED — M5.7 完成**。正式 run 为本目录下 `draft-A-final-20261019/`；不是此前只含元数据的 aggregate。十款各一候选、浅深成对，已由真实 loader/verifier 复核，全部 ready、零错误、零缺件。正式 `selections.json` 经 `requireSelections=true` 重读通过。

候选集合摘要：`107072009ac767cc90c04d91bea5f1c5e4c66ac0b19fe447b7ad8190376b0ea6`。
正式评审摘要：`ed34c64791cdd5c6a98982f0d426802ba296be98a6a6e1e10f4bf0735d4a0713`。

## 实际证据链

- `build-draft.mjs` 从十款准确 sourceRun 读取原候选，Assessment 的原输入/原候选集合分别保持原批次语境；只有总容器绑定十款汇总集合。current-profiles 快照留在 run 内。4,000 条原始判据去除逐字相同重复后为 3,690 条，失败/缺测没有删除或改写。初始草稿容器保存在 `raw-assessments.json`。
- 阅读场景的 140 张真实截图已有逐图意见及主管复看。Qwen 深色性能副标题/脚注偏弱的两条观察保留，没有掩盖为无观察；性能页面为明确标注的合成 UI 数据，不证明 TPS 业务数据真实性。
- `visual-evidence-map.json` 的 61 项已有依据直接引用。其余材质/角色强度项由独立短审阅者实际查看既有截图补齐，每人总计六图，不复用已累积大量图片的旧 worker 会话。逐款意见为 `visual-*.md`。
- 六项近邻区别由主管结合既有实拍、用户逐款明确选型及最终 token 写出解释，未声称进行新的盲测。蓝色系的强调色仍相近，接受的是表面及整体方向可解释的区别，未宣称十套具有完全不同色相。
- 用户明确要求保留 Agent Usage 弱浮雕。正式视觉意见将其标为设计例外，不将其冒充普通正文的数值可读性通过。
- Qwen/Kimi 原 `light/keyboard-focus/focus.outline` 均为 spotlight-active 缺测。新专用入口核验原候选、固定源码、fixture/policy、补验 manifest、原图/测量附件、自然 Tab 与三处零聚光后，才让重算使用独立 PASS。实际比值分别5.585407833087304、5.566197689159183，阈值3。原 checks、原 Assessment 和原缺测完整保留；最终诊断同时保存原缺测与补验出处。不能覆盖 fail、不同记录或重复目标。
- 五条几何意见曾缺少直接截图引用；没有用随意补链接完成验收。`geometry-visual-1.md`/`2.md` 实际复看指定十图，核对 PNG/布局文件/视口/文档高度、固定四个元素 rect，以及捕获布局源码与当前源码一致，接受本轮限定范围。自动审批最初因此拒绝正式命令；撤回补链接做法并完成上述直接复核后，正式命令获准执行。

## 工具修正与实际门禁

新增专用于本次焦点缺测的补验核验模块，接入现有 review verifier；未改测量器、阈值、roles/policy、候选 tokens 或捕获依赖的31源码文件，因此未通过改口径迫使重拍十款。

草稿实跑暴露外层状态折叠错误：当原评审与重算都为 incomplete 且外部 gaps 为空时，旧代码会误返回 pass。现已按重算 readiness 阻断，并有回归测试。初始 `draft-summary.json` 中的旧 pass 仅是该次真实旧结果，不能代表当时十款 ready；最终结论以 `verification-with-selections.json` 为准。

两组定向测试合计 **54/54 通过，零跳过**；涉及的公共模块/测试 Biome 通过。一次性构建/收口脚本通过语法检查和实际断言执行。正式 Assessment 重写后重新加载的摘要保持不变，再生成用户已明确确认的十项选择，最后 `requireSelections=true` 返回 pass。

## 第2项与 M6 边界

缩放结论见 `../m57-scaling/supervisor-review.md` 和独立核对：十款×浅深×三档原生浏览器 zoom 共60页，六图主管复看无横向裁切或重叠；主机实读100%系统缩放，未声称已改变 Windows DPI 或覆盖任意弹窗/显示器。

M6.1.1 接入前快照也已完成：`prepare-integration.mjs` 先再次核验十项选择，再保存三份源码完整前像、旧 palette/声明、当前31项源码 map、旧资产 manifest 与40源图/40公共图登记；既有安全读取器读回前像和资产记录通过，见 run 内 `integration-precheck-validation.json`。读取并非跨文件事务，后续正式写入前仍须核对快照是否漂移。

本次正式 palette、picker、bootstrap 尚未改写；本结论不是正式生产页面已经实测通过。下一步为 M6.1.2 单一 owner 接入，随后对正式源码执行独立验收，延期五款仍不开放。未运行全仓门禁或正式生产矩阵；既有用户预览服务保留。
