// Dashboard copy lives here so the live page and exported snapshot use the same wording.
export const LOCALE_STORAGE_KEY = "codexUsageLocale";
export const SUPPORTED_LOCALES = Object.freeze(["zh-CN", "en-US"]);

const ENGLISH = new Map(
  Object.entries({
    自动刷新: "Auto Refresh",
    开: "On",
    关: "Off",
    历史归档: "History Archives",
    "展开 / 收起": "Expand / collapse",
    "正在读取归档状态…": "Loading archive status…",
    已登记归档段: "Registered archive segments",
    已登记事件: "Registered events",
    归档段: "Archive segment",
    归档带: "Archive band",
    事件数不可用: "Event count unavailable",
    "封存时数据（UTC 日统计）": "Sealed data (UTC daily totals)",
    "原始封存版本，不含当前覆盖层。": "Original sealed version; current overlays are not included.",
    "展开后读取封存日统计。": "Expand to load sealed daily totals.",
    "正在读取封存日统计…": "Loading sealed daily totals…",
    封存日统计不可用: "Sealed daily totals unavailable",
    "封存日统计不可用。": "Sealed daily totals unavailable.",
    封存日统计格式无效: "Invalid sealed daily totals response",
    "没有封存日统计。": "No sealed daily totals.",
    "展开后读取原始封存事件。": "Expand to load original sealed events.",
    "正在读取原始封存事件…": "Loading original sealed events…",
    原始封存事件不可用: "Original sealed events unavailable",
    原始封存事件格式无效: "Invalid sealed events response",
    "没有原始封存事件。": "No original sealed events.",
    下一页: "Next page",
    "正在读取下一页…": "Loading next page…",
    事件时间: "Event time",
    事件数: "Event count",
    "Token 总量": "Total tokens",
    "Token 输入": "Input tokens",
    "Token 缓存": "Cached tokens",
    "Token 输出": "Output tokens",
    "Token 推理": "Reasoning tokens",
    "已登记（仅表示文件存在，未验证内容）": "Registered (file existence only; contents not verified)",
    "文件缺失（范围保留，事件数不可用）": "File missing (range retained; event count unavailable)",
    "文件不可读（范围保留，事件数不可用）": "File unreadable (range retained; event count unavailable)",
    "归档状态未知（事件数不可用）": "Unknown archive status (event count unavailable)",
    归档状态不可用: "Archive status unavailable",
    归档响应格式无效: "Invalid archive response",
    "没有已登记的归档段。": "No registered archive segments.",
    "上次：尚无": "Last check: none yet",
    "异常 · 详情 ›": "Error · Details ›",
    错误详情: "Error details",
    "‹ 返回": "‹ Back",
    完整错误信息: "Full error message",
    切换主题: "Switch Theme",
    切换语言: "Switch Language",
    查看方式: "View",
    "选择一组模型查看详情。": "Select a model group to view its details.",
    "部分来源已缺失，已保留历史数据。": "Some sources are missing. Historical data is preserved.",
    "统计更新中，当前不展示部分排名。": "The performance index is rebuilding. Partial rankings are hidden.",
    "部分数据来源不可用，当前结果可能不完整。": "Some sources are unavailable, so results may be incomplete.",
    "存在适用候选，但当前没有可计算的 TPS 样本。":
      "Eligible records exist, but none has a usable TPS sample in this range.",
    "当前范围没有可评估的性能样本。": "There are no eligible performance records in this range.",
    "用量摘要暂不可用。": "The usage summary is not currently available.",
    "有不支持性能统计的来源，未纳入 TPS 样本。":
      "Some sources do not support performance statistics and are excluded from TPS samples.",
    "未形成 TPS 的候选": "Eligible records without a TPS sample",
    覆盖情况: "Coverage",
    覆盖明细与诊断: "Coverage details and diagnostics",
    "存在来源告警，展开覆盖明细可查看。": "Source warnings are present. Expand coverage details to inspect them.",
    有跨度率: "Timed-output rate",
    完整跨度率: "Complete-timing rate",
    有效样本率: "Valid-sample rate",
    适用候选: "Eligible",
    有效输出: "Positive output",
    已计时输出: "Timed output",
    完整计时输出: "Complete timed output",
    已采样: "Sampled",
    丢弃: "Dropped",
    等待中: "Pending",
    近期: "Recent",
    历史: "History",
    时间未定位: "Unplaced in time",
    "时间未定位统计所选来源的全历史记录，不计入当前范围的适用候选分母。":
      "Unplaced counts include all history for the selected sources and are excluded from the eligible-record denominator for the current range.",
    "缺少输出/输出无效": "Missing or invalid output",
    "缺少时长/时长无效": "Missing or invalid duration",
    记录冲突: "Conflicting records",
    模型不明确: "Ambiguous model",
    终态未验证: "Terminal state unverified",
    轮级时窗不完整: "Incomplete turn window",
    轮级时窗重叠: "Overlapping turn windows",
    来源计时语义不匹配: "Source timing semantics mismatch",
    源过滤: "Source-filtered",
    "诊断标记可能相互重叠，不要把它们相加为丢弃数。":
      "Diagnostic flags can overlap; do not add them up as dropped records.",
    诊断标记: "Diagnostic flags",
    丢弃原因: "Drop reasons",
    不支持来源: "Unsupported sources",
    来源告警: "Source warnings",
    未归类来源: "Unclassified source",
    渠道未知: "Unknown channel",
    未知来源: "Unknown source",
    未提供: "Not provided",
    主代理: "Main agent",
    子代理: "Subagent",
    代理未知: "Unknown agent",
    模型未知: "Unknown model",
    计时方式未知: "Unknown timing method",
    "Token 范围未知": "Unknown token scope",
    "报告的输出 tokens（范围未注明）": "Reported output tokens (scope unspecified)",
    "可见输出与推理 tokens": "Visible output and reasoning tokens",
    "报告的输出 tokens（含推理）": "Reported output tokens (including reasoning)",
    "请求端到端 TPS（含请求等待）": "Request end-to-end TPS (includes request waiting)",
    生成速度: "Generation speed",
    "非推理输出 tokens": "Non-reasoning output tokens",
    "轮级 item 时窗 TPS 估算": "Turn-level item-window TPS estimate",
    样本不足: "Insufficient samples",
    聚合溢出: "Aggregate overflow",
    排名: "Rank",
    模型速度: "Model Speed",
    "Codex 计时覆盖": "Codex timing coverage",
    候选采样覆盖率: "Candidate sampling coverage",
    已记录输出覆盖率: "Recorded-output coverage",
    "没有适用的 Codex 来源。": "No applicable Codex source.",
    "此响应未提供 Codex 计时覆盖信息。": "This response does not include Codex timing coverage.",
    "本范围没有 Codex 候选。": "No Codex candidates in this range.",
    "Codex 计时覆盖信息不可用。": "Codex timing coverage is unavailable.",
    "性能索引正在重建，覆盖信息不可用。":
      "The performance index is rebuilding, so coverage information is unavailable.",
    "性能索引尚未初始化，覆盖信息不可用。":
      "The performance index is not initialized, so coverage information is unavailable.",
    "性能索引尚未初始化，当前没有可展示的模型速度。":
      "The performance index is not initialized, so no model speed is available.",
    "部分来源降级，覆盖保留已发布的健康数据。":
      "Some sources are degraded; coverage retains the last published healthy data.",
    "输出 token 合计溢出，已记录输出比例不可用。":
      "Output-token totals overflowed; the recorded-output rate is unavailable.",
    "输出 token 汇总字段缺失或无效，已记录输出比例不可用。":
      "Output-token totals are missing or invalid; the recorded-output rate is unavailable.",
    "已记录输出覆盖率只统计已知输出。": "Recorded-output coverage counts known output only.",
    缺失或无效时长: "Missing or invalid duration",
    进行中: "In progress",
    "另有输出 token 未知的候选": "Additional candidates with unknown output tokens",
    "全历史、无法定位日期的记录": "All-history records that cannot be placed in time",
    不计入当前范围分母: "Excluded from the current-range denominator",
    "模型 / 推理强度": "Model / Reasoning Effort",
    "平均速度 (tok/s)": "Average Speed (tok/s)",
    "模型速度历史样本表，最多显示五行，可滚动":
      "Model speed historical sample table. Up to five rows are visible and the rest can be scrolled.",
    "模型速度历史样本表：排名、模型与推理强度、来源、平均速度":
      "Model speed historical sample table: rank, model and reasoning effort, source, and average speed",
    "满足当前计量条件的历史样本排序；分隔线以下为参考读数。":
      "Historical sample ordering for rows that meet the current metering conditions. Rows below the divider are references.",
    参考行: "Reference row",
    计量条件未验证: "Metering conditions unverified",
    排名信息不可用: "Ranking information unavailable",
    满足当前计量条件: "Meets current metering conditions",
    "选择一行模型查看速度详情。": "Select a model row to view its speed details.",
    样本数: "Samples",
    用量记录: "Usage records",
    日志未记录请求耗时: "Request duration is missing from the log",
    样本数不可用: "Sample count unavailable",
    请求: "request",
    步骤: "step",
    消息: "message",
    轮次: "turn",
    混合样本: "mixed sample",
    样本: "sample",
    平均: "Average",
    慢端: "Slow end",
    快端: "Fast end",
    "慢端 10%": "Slow end 10%",
    "快端 90%": "Fast end 90%",
    "慢端/快端": "Slow/Fast",
    常见速度区间: "Common speed range",
    "p90 是第 90 百分位，不是最快 10% 的平均值，也不是速度上限。":
      "p90 is the 90th percentile, not the average of the fastest 10%, and not a speed ceiling.",
    推理强度: "Reasoning effort",
    提供方: "Provider",
    "provider 未知": "Provider unknown",
    "provider 信息不可用": "Provider information unavailable",
    "p10（慢端）": "p10 (slower end)",
    "p90（快端）": "p90 (faster end)",
    "合并样本 TPS": "Pooled-sample TPS",
    "耗时 p50": "Duration p50",
    "耗时 p90": "Duration p90",
    来源: "Source",
    来源目录: "Home",
    代理: "Agent",
    渠道名称: "Channel",
    模型名称: "Model",
    "Token 范围": "Token scope",
    计时口径: "Timing method",
    "样本数 n": "Sample count n",
    此组覆盖诊断: "Coverage diagnostics for this group",
    "此组没有覆盖诊断。": "No coverage diagnostics are available for this group.",
    "p10 表示较慢端，p90 表示较快端；合并样本 TPS 不代表日历时间整体效率。":
      "p10 represents the slower end and p90 the faster end. Pooled-sample TPS does not measure overall calendar-time efficiency.",
    选择界面风格: "Choose Waifu",
    界面风格: "Waifu",
    显示角色: "Show characters",
    角色透明度: "Character opacity",
    简洁模式: "Simple mode",
    无皮肤: "No skin",
    不使用任何皮肤: "No skin of any kind",
    浅色: "Light",
    深色: "Dark",
    配色待定: "Colours pending",
    "当前深色主题，点击切换到浅色主题": "Dark theme. Switch to light theme",
    "当前浅色主题，点击切换到深色主题": "Light theme. Switch to dark theme",
    导入目录: "Import",
    筛选: "Filters",
    范围: "Range",
    日期范围时区: "Date Range Time Zone",
    本地时间: "Local Time",
    今日: "Today",
    本周: "This Week",
    本月: "This Month",
    全部: "All Time",
    最近: "Recent",
    上一个5h: "Last 5h",
    上一个7d: "Last 7d",
    仅显示有用量的日期: "Only dates with usage are shown",
    仅显示有用量的半小时: "Only half-hour slots with usage are shown",
    "上一周限额记录存在冲突，无法确认周期边界。":
      "Weekly limit records conflict; the cycle boundaries cannot be confirmed.",
    上周: "Last Week",
    今年: "This Year",
    "尚未发现上一限额窗口的 Codex 记录。": "No Codex record was found for the previous limit window.",
    最近范围: "Recent Range",
    展开最近范围选项: "Show recent range options",
    "1天": "1 day",
    "1周": "1 week",
    "1个月": "1 month",
    "2个月": "2 months",
    "3个月": "3 months",
    半年: "6 months",
    一年: "1 year",
    自定义: "Custom",
    日期范围: "Date Range",
    打开日期范围日历: "Open date range calendar",
    日期范围日历: "Date range calendar",
    开始日期: "Start date",
    结束日期: "End date",
    选择开始日期: "Choose a start date",
    选择结束日期: "Choose an end date",
    清除: "Clear",
    清除日期范围: "Clear date range",
    结束: "End",
    "年/月/日": "YYYY-MM-DD",
    打开开始日期日历: "Open start date calendar",
    打开结束日期日历: "Open end date calendar",
    上个月: "Last Month",
    下个月: "Next Month",
    总览: "Overview",
    "总 tokens": "Total Tokens",
    总输入: "Total Input",
    缓存读取: "Cache Hit",
    缓存输入: "Cache Hit",
    输出: "Output",
    推理输出: "Reasoning Tokens",
    推理: "Reasoning Tokens",
    会话: "Sessions",
    事件: "Events",
    "API 费用估算": "Estimated API Cost",
    总花销: "Estimated Cost",
    估算花销: "Estimated Cost",
    缓外输入: "Cache Miss",
    缓存写入: "Cache Write",
    未命中输入: "Cache Miss",
    缓存命中: "Cache Hit Rate",
    缓存命中率: "Cache Hit Rate",
    模型数量: "Models",
    模型: "Models",
    费用: "Cost",
    费用估算: "Estimated Cost",
    趋势变化: "Usage Trend",
    时间分布: "Usage Over Time",
    时间分布方式: "Timeline Breakdown",
    按渠道: "By Source",
    按模型: "By Model",
    按花销: "By Cost",
    按仓库: "By Repository",
    "时间分布柱状图；聚焦后可查看用量详情": "Usage over time chart. Focus to inspect each interval",
    图表图例: "Chart Legend",
    时间分布详情: "Timeline Details",
    详情: "Details",
    跨时间范围用量对比: "Usage Across Time Ranges",
    搜索模型: "Search Models",
    搜索模型用量对比: "Search model usage",
    搜索仓库: "Search Repositories",
    搜索仓库用量对比: "Search repository usage",
    "默认排序优先级：今日 → 本周 → 本月 → 全部（各项倒序）":
      "Default sort priority: Today → This Week → This Month → All Time (descending)",
    扫描目录: "Scanned Directories",
    编辑: "Edit",
    费用估算说明: "About Cost Estimates",
    更新详情: "Update details",
    计价详情: "Pricing details",
    "勾选统计来源，修改立即生效。": "Select sources to include. Changes apply immediately.",
    "点击模型调整单价，单位为每百万 tokens。": "Select a model to edit rates per million tokens.",
    计价标准: "Pricing Rates",
    数据来源: "Data Sources",
    "勾选要统计的来源，取消勾选的来源不计入用量、费用和时间线，修改立即生效。":
      "Choose which sources to include. Changes to usage, cost estimates, and the timeline take effect immediately.",
    统计来源: "Included Sources",
    添加目录: "Add Directory",
    选择文件夹: "Choose Folder",
    关闭: "Close",
    导入: "Import",
    更新计价标准: "Update Pricing Rates",
    恢复自动汇率: "Restore automatic rate",
    "单价单位为对应模型的标价货币（USD 美元 / CNY 人民币）每 100 万 tokens。点击模型名编辑费率（含官方单独声明的快速模式价）；汇率只用于混合币种的排序与图表比例，不改变各币种金额。保存后按当天日期记为核对日期并重算历史估算。":
      "Rates are quoted per million tokens in each model's billing currency (USD or CNY). Select a model to edit its rates, including published fast tier rates. The exchange rate affects only sorting and chart proportions when currencies are mixed. Saving records today's review date and recalculates historical estimates.",
    "1 美元 =": "1 USD =",
    人民币: "CNY",
    模型范围: "Model Scope",
    在用模型: "Models In Use",
    全部模型: "All Models",
    取消: "Cancel",
    保存并重算: "Save And Recalculate",
    模型计价: "Model Pricing",
    应用: "Apply",
    "5 小时限额": "5-Hour Limit",
    本周限额: "Weekly Limit",
    限额窗口: "Limit Window",
    "此限额窗口当前不可用。": "This limit window is currently unavailable.",
    "尚无限额快照，请等待 Codex 写入限额记录。": "No limit snapshot is available yet. Wait for Codex to record one.",
    "等待新的限额记录。": "Waiting for a new limit record.",
    等待新的限额记录: "Waiting for a new limit record",
    "每个图表时间槽是半小时。": "Each chart interval spans 30 minutes.",
    "每个图表时间槽是连续 24 小时，不按本地自然日或夏令时拆分。":
      "Each chart interval spans 24 continuous hours; it does not follow local calendar days or daylight saving changes.",
    统计数据截至: "Data as of",
    当前时间槽仅统计至: "Current interval includes data through",
    未知: "Unknown",
    未知时间: "Unknown time",
    本地时区: "local time zone",
    限额窗口边界不可用: "Limit window boundaries unavailable",
    较昨日: "VS Yesterday",
    较上周: "VS Last Week",
    较上月: "VS Last Month",
    较上一5h: "VS Previous 5h",
    较上一7d: "VS Previous 7d",
    较上一等长周期: "VS Previous Period",
    暂无对比: "No Comparison",
    "上一5h Tokens": "Previous 5h Tokens",
    "上一7d Tokens": "Previous 7d Tokens",
    "昨日 tokens": "Yesterday's Tokens",
    "上周 tokens": "Last Week's Tokens",
    "上月 tokens": "Last Month's Tokens",
    "前一等长区间 tokens": "Previous Period's Tokens",
    "上一周期 tokens": "Previous Period's Tokens",
    无基准: "No baseline",
    全部范围没有可比较的上一周期: "All-time usage has no preceding period for comparison.",
    当前范围没有可比较的上一周期: "No preceding period is available for this range.",
    同比流速: "Usage Pace vs. Prior Period",
    "近期使用时间尚未可用，暂显示已观测模型；重启本地服务后按近一个月筛选。":
      "Recent usage times are unavailable; showing observed models. Restart the local service to filter by the past month.",
    "费用估算暂不可用。": "Cost estimates are temporarily unavailable.",
    当前价格基准: "Current Pricing Baseline",
    "OpenAI 价格表": "OpenAI Pricing",
    "Anthropic 定价": "Anthropic Pricing",
    "StepFun 定价": "StepFun Pricing",
    "MiMo 定价": "MiMo Pricing",
    "DeepSeek 定价": "DeepSeek Pricing",
    "Kimi 定价": "Kimi Pricing",
    "GLM 定价": "GLM Pricing",
    价格来源: "Pricing Source",
    默认价格来源: "Default Pricing Source",
    按当前价目表估算: "Estimated using current rates",
    "金额按已知明细及最低费率情景折算 API 等价费用，不代表实际账单，也不含工具调用等非 token 费用。":
      "API-equivalent costs use available token details, with the lowest applicable rates used where details are missing. They are not actual bills and exclude tool calls and other non-token costs.",
    估算限制: "Estimate Limitations",
    "缓存读取与写入按各自官方费率计入总额。":
      "Cache-hit input and cache writes are charged at their respective published rates.",
    "更新计价标准后，所有已索引的历史用量会按新单价重算。":
      "Updating pricing rates recalculates estimates for all indexed usage.",
    "支持自动更新匹配的模型价格与美元兑人民币汇率；点击模型名或汇率可手动调整。":
      "Matching model prices and the USD/CNY exchange rate update automatically. Edit a model or the rate to override them.",
    "单价单位为对应模型的标价货币（USD 美元 / CNY 人民币）每 100 万 tokens。支持自动更新匹配的模型价格与美元兑人民币汇率；点击模型名或汇率可手动调整。保存后按当天日期重算历史估算。":
      "Prices are per million tokens in each model's listed currency (USD or CNY). Matching model prices and the USD/CNY rate update automatically; you can edit either manually. Saving recalculates historical estimates using today's date.",
    "正在读取更新状态…": "Loading update status…",
    立即更新: "Update now",
    "更新完成；未保存的编辑已重置。": "Update complete. Unsaved edits were reset.",
    开始: "Start",
    现在: "Now",
    没有匹配的用量记录: "No matching usage records",
    所选时间范围内没有用量: "No usage in the selected period",
    没有可计价的费用记录: "No priced usage records",
    "时间范围过大，无法生成时间分布。": "The date range is too large to build the time distribution.",
    按周合并: "merged by week",
    按月合并: "merged by month",
    明细未提供: "Details unavailable",
    只按总输入与缓存读取都已知的记录计算:
      "Calculated only from records with known total input and cache-hit token counts",
    "缓存读取 ÷ 总输入": "Cache-hit tokens ÷ total input tokens",
    明细不完整记录的总量: "Tokens With Incomplete Details",
    "记录总量提示，不与各明细相加": "For reference only; do not add to the breakdown",
    字段不一致记录的总量: "Tokens With Inconsistent Fields",
    "涉及总量、输入/输出或缓存关系不一致": "Total, input/output, or cache figures do not reconcile",
    明细校验差额合计: "Total Reconciliation Gap",
    "各项差额之和，仅作质量提示": "Sum of discrepancies, shown as a data-quality indicator",
    "Git 仓库": "Git Repository",
    不受搜索筛选影响: "Unaffected by search",
    全局合计: "Overall Total",
    仓库: "Repository",
    正序: "ascending",
    倒序: "descending",
    统计截至: "As of",
    无模型用量: "No model usage",
    无可计价费用: "No priceable usage",
    估算金额: "Estimated Amount",
    "已纳入估算 tokens": "Tokens Included In Estimate",
    未计价: "Unpriced",
    "服务等级未知，金额按 Standard 情景估算": "Service tier unknown; estimated at Standard rates",
    "请求上下文未知，按可用的较低上下文费率估算":
      "Request context unknown; estimated at the lower applicable context rate",
    "缓存写入明细未知，相关未知部分按最低费率估算":
      "Cache-write details unknown; the affected portion uses the lowest applicable rate",
    不可用: "Unavailable",
    有用量记录: "Usage found",
    无用量记录: "No usage found",
    可扫描: "Ready to scan",
    没有可统计的来源: "No sources available",
    "没有发现 Codex、ZCode、DSH、OpenCode、Claude Code 或 WorkBuddy 目录":
      "No Codex, ZCode, DSH, OpenCode, Claude Code, or WorkBuddy directories found",
    移除: "Remove",
    不计入统计: "Excluded from totals",
    切换自动刷新: "Toggle auto refresh",
    已关闭: "Off",
    快速模式价: "Fast Mode Rates",
    短上下文: "Short Context",
    短上下文·长输出: "Short Context · Long Output",
    长上下文: "Long Context",
    快速模式: "Fast Mode",
    快速·短上下文: "Fast · Short Context",
    快速·短上下文·长输出: "Fast · Short Context · Long Output",
    快速·长上下文: "Fast · Long Context",
    点击编辑该模型费率: "Edit this model's rates",
    没有匹配的模型: "No matching models",
    暂无模型: "No models available",
    暂无已用到的模型: "No used models found",
    "正在保存并重算…": "Saving and recalculating…",
    "正在打开文件夹选择器...": "Opening folder picker…",
    "已选择目录，可继续导入。": "Folder selected. You can import it now.",
    "没有选择目录。": "No folder selected.",
    "请输入目录路径。": "Enter a directory path.",
    "正在识别目录...": "Checking directory…",
    "正在移除导入目录...": "Removing imported directory…",
    "已移除导入目录，正在刷新...": "Directory removed. Refreshing…",
    "快照已回收，正在重新冻结…": "Snapshot expired. Creating a new one…",
    限额统计暂不可用: "Limit statistics are temporarily unavailable",
    正在检查更新: "Checking for updates",
    "正在检查更新…": "Checking for updates…",
    "检测到用量变化，正在更新…": "New usage found. Updating…",
    "正在刷新限额窗口…": "Refreshing limit window…",
    "正在加载限额窗口…": "Loading limit window…",
    "最近范围格式无效。请使用数字和天、周、月或年。":
      "Invalid recent range. Enter a number followed by days, weeks, months, or years.",
    请重启服务: "Restart the local service",
    時間分布圖: "Usage over time chart",
    "存在多个无法区分的 Codex 限额桶。": "Multiple Codex limit buckets cannot be distinguished.",
    "尚未发现 Codex 限额记录。": "No Codex limit records were found.",
    "同一观察时刻存在相互冲突的限额重置时间。": "Conflicting reset times were recorded at the same observation time.",
    "尚未发现当前限额窗口的 Codex 记录。": "No Codex record was found for the current limit window.",
    "限额窗口边界无效。": "The limit window boundaries are invalid.",
    "目录需要是 Codex home、ZCode home、DSH home、OpenCode 数据目录、Claude Code home、WorkBuddy home，或包含 .codex-usage/usage.jsonl":
      "Choose a Codex, ZCode, or DSH home directory, an OpenCode data directory, a Claude Code home, a WorkBuddy home, or a project containing .codex-usage/usage.jsonl.",
  }),
);

// Constructing an Intl.DateTimeFormat dominates formatting cost while format() is
// stateless, so one instance per (options object, locale) pair is reused. Callers pass
// module-level constant option objects, which keeps the lookup allocation-free.
const dateTimeFormatters = new WeakMap();

function cachedDateTimeFormat(locale, options) {
  let byLocale = dateTimeFormatters.get(options);
  if (!byLocale) {
    byLocale = new Map();
    dateTimeFormatters.set(options, byLocale);
  }
  let formatter = byLocale.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, options);
    byLocale.set(locale, formatter);
  }
  return formatter;
}

const LOCAL_DATE_TIME_OPTIONS = {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};
const ENGLISH_MONTH_OPTIONS = { month: "long", year: "numeric", timeZone: "UTC" };

const englishText = (value) => localizeText(value, "en-US");

const ENGLISH_PATTERNS = [
  [
    /^当前范围为(.+?)(?:；(.+?))?；点击切换到(.+)$/,
    (_, current, reason, target) =>
      `Current range: ${englishText(current)}${reason ? `. ${englishText(reason)}` : ""}. Switch to ${englishText(target.trim())}`,
  ],
  [/^点击切换到 (.+)$/, (_, target) => `Switch to ${englishText(target)}`],
  [/^等待(.+)数据$/, (_, range) => `Waiting for ${englishText(range)} data`],
  [/^(.+) 至 (.+)$/, (_, start, end) => `${englishText(start)} to ${englishText(end)}`],
  [
    /^(.+)年(\d{2})月$/,
    (_, year, month) =>
      cachedDateTimeFormat("en-US", ENGLISH_MONTH_OPTIONS).format(
        new Date(Date.UTC(Number(year), Number(month) - 1, 1)),
      ),
  ],
  [/^价格基准 (.+)$/, (_, date) => `Pricing baseline ${date}`],
  [
    /^按当前价目表估算 · (.+) · (.+)$/,
    (_, baseline, sources) => `Estimated using current rates · ${englishText(baseline)} · ${englishText(sources)}`,
  ],
  [
    /^(.+) 条记录的服务等级未知，按 Standard 情景估算$/,
    (_, n) => `${n} records have an unknown service tier; estimated at Standard rates`,
  ],
  [
    /^(.+) 条记录无法可靠对应单次请求输入，按可用的较低上下文费率估算$/,
    (_, n) => `${n} records lack reliable per-request input details; estimated at the lower applicable context rate`,
  ],
  [
    /^(.+) 个输入 tokens 缺少缓存写入明细，相关未知部分按最低费率估算$/,
    (_, n) =>
      `Cache-write details are missing for ${n} input tokens; the affected portion uses the lowest applicable rate`,
  ],
  [/^(.+) \/ (.+) tokens 使用最低费率估算$/, (_, n, total) => `${n} of ${total} tokens use the lowest applicable rate`],
  [
    /^模型 (.+) 缺少专用单价，按价目表最低费率估算$/,
    (_, names) => `No model-specific rate for ${names.replaceAll("、", ", ")}; estimated at the lowest listed rate`,
  ],
  [/^仍有 (.+) tokens 无法估算$/, (_, n) => `${n} tokens remain unpriced`],
  [/^仍无法计价的模型：(.+)$/, (_, names) => `Models still unpriced: ${names.replaceAll("、", ", ")}`],
  [/^([\d,]+) 个会话$/, (_, n) => `${n} sessions`],
  [
    /^([\d,]+) 条事件(?: · ([\d,]+) 个会话)?$/,
    (_, events, sessions) => `${events} events${sessions ? ` · ${sessions} sessions` : ""}`,
  ],
  [/^(.+)，费用估算 (.+)$/, (_, name, amount) => `${name}, estimated cost ${amount}`],
  [/^移除 (.+)$/, (_, name) => `Remove ${name}`],
  [/^(.+)明细$/, (_, period) => `${englishText(period)} Details`],
  [/^；另有 (.+) token 的记录未提供此项$/, (_, n) => `; this field is unavailable for another ${n} tokens`],
  [/^另有 (.+) token 的记录未提供此项$/, (_, n) => `This field is unavailable for another ${n} tokens`],
  [/^(.+)（已知部分）$/, (_, value) => `${value} (known records only)`],
  [/^(.+)，正序$/, (_, label) => `${englishText(label)}, ascending`],
  [/^(.+)，倒序$/, (_, label) => `${englishText(label)}, descending`],
  [
    /^当前先按(.+)(正序|倒序)；平手依次按其余周期倒序$/,
    (_, label, direction) =>
      `Sort by ${englishText(label).toLowerCase()} ${direction === "正序" ? "ascending" : "descending"}; ties follow the remaining periods in descending priority`,
  ],
  [/^按(.+)用量排序$/, (_, label) => `Sort by ${englishText(label).toLowerCase()} usage`],
  [/^本地 Git 仓库优先；(.+)$/, (_, label) => `Local Git repositories first; ${englishText(label)}`],
  [/^统计截至 (.+)$/, (_, date) => `As of ${date}`],
  [
    /^总计 (.+) tokens(?:，(.+)：(.+))?$/,
    (_, n, kind, breakdown) =>
      `Total ${n} tokens${kind ? `; ${englishText(kind).toLowerCase()}: ${breakdown.replaceAll("，", ", ")}` : ""}`,
  ],
  [
    /^(.+)，费用估算 (.+)，其中 (.+) tokens 按最低费率估算，未计价 (.+) tokens$/,
    (_, interval, cost, minimum, unpriced) =>
      `${englishText(interval)}. Estimated cost ${cost}; ${minimum} tokens use fallback rates; ${unpriced} tokens are unpriced`,
  ],
  [/^时间槽区间 (.+)；(.+)$/, (_, interval, note) => `Interval ${interval}; ${englishText(note)}`],
  [/^未计价 (.+) tokens$/, (_, n) => `${n} unpriced tokens`],
  [/^其中 (.+) tokens 按最低费率估算$/, (_, n) => `${n} tokens use the lowest applicable rate`],
  [
    /^时间分布，按模型堆叠 API 等价费用估算，美元为纵轴单位(.+)；每个时间槽可查看完整日期、模型费用和最低费率估算部分$/,
    (_, range) =>
      `Usage over time, with estimated API-equivalent costs stacked by model in USD${englishText(range)}. Inspect each interval for dates, model costs, and fallback estimates`,
  ],
  [
    /^时间分布，(.+)堆叠 tokens(.+)；每个时间槽可查看完整日期和明细$/,
    (_, mode, range) =>
      `Usage over time, tokens stacked ${englishText(mode).toLowerCase()}${englishText(range)}. Inspect each interval for dates and details`,
  ],
  [/^，统计范围 (.+) 至 (.+)$/, (_, start, end) => `, from ${start} to ${end}`],
  [/^(.+)明细不可用，请刷新数据。$/, (_, kind) => `${englishText(kind)} details are unavailable. Refresh the data.`],
  [
    /^(.+)明细不可用，(.+)$/,
    (_, kind, action) => `${englishText(kind)} details are unavailable. ${englishText(action)}`,
  ],
  [
    /^此范围超过 (.+) 个时间槽，无法生成时间分布。请缩短日期范围。$/,
    (_, n) => `This range exceeds ${n} chart intervals and cannot build the time distribution. Shorten the range.`,
  ],
  [/^上次：(.+)$/, (_, date) => `Last check: ${date}`],
  [/^单次输入超过 (.+) tokens 按长上下文价$/, (_, n) => `Long-context rates apply above ${n} input tokens per request`],
  [/^输出达到 (.+) tokens 起按长输出价$/, (_, n) => `Long-output rates apply at ${n} output tokens or more`],
  [
    /^谷时按 (.+) 折计（北京时间工作日 9:00-12:00、14:00-18:00 为高峰，节假日未建模按高峰计）$/,
    (_, discount) =>
      `Off-peak rates are ${Number(discount) * 10}% of peak rates (Beijing time, weekdays 09:00–12:00 and 14:00–18:00; holidays are treated as peak)`,
  ],
  [/^(.+)（入\/缓\/出）$/, (_, rates) => `${rates} (Cache Miss/Cache Hit/Output)`],
  [/^上下文 (.+) 分档$/, (_, n) => `Context tier at ${n}`],
  [/^输出 (.+) 分档$/, (_, n) => `Output tier at ${n}`],
  [/^谷时 (.+) 折$/, (_, discount) => `Off-peak ${Number(discount) * 10}%`],
  [/^请填写大于 0 的美元兑人民币汇率。$/, () => "Enter a USD-to-CNY exchange rate greater than zero."],
  [/^读取计价标准失败：(.+)$/, (_, error) => `Could not load pricing rates: ${englishText(error)}`],
  [/^保存失败：(.+)$/, (_, error) => `Could not save: ${englishText(error)}`],
  [
    /^选择失败：(.+)，也可以手动输入路径。$/,
    (_, error) => `Could not choose a folder: ${englishText(error)}. You can enter the path manually.`,
  ],
  [/^已导入 (.+)，正在刷新\.\.\.$/, (_, name) => `Imported ${name}. Refreshing…`],
  [/^导入失败：(.+)$/, (_, error) => `Import failed: ${englishText(error)}`],
  [/^加载失败：(.+)$/, (_, error) => `Could not load usage: ${englishText(error)}`],
  [/^归档状态不可用：(.+)$/, (_, error) => `Archive status unavailable: ${englishText(error)}`],
  [
    /^检查失败：(.+)；下次继续尝试$/,
    (_, error) => `Update check failed: ${englishText(error)}. Retrying at the next interval.`,
  ],
  [/^移除失败：(.+)$/, (_, error) => `Could not remove the directory: ${englishText(error)}`],
  [/^(.+)：(.+)$/, (_, label, detail) => `${englishText(label)}: ${englishText(detail)}`],
];

let activeLocale = "zh-CN";
let observer = null;
let translationScheduled = false;
let fullPageScheduled = false;
// Nodes queued for the next microtask, mapped to "subtree" or "attributes" work.
const pendingRoots = new Map();
// Pathological guard only: an attributes/text batch this wide is cheaper as one
// whole-page pass. Self-inflicted records are filtered before they reach this cap.
const MAX_PENDING_ROOTS = 512;
const nodeSources = new WeakMap();
const attributeSources = new WeakMap();
const SKIP_USER_DATA =
  ".home-label strong, .home-path, .source-option-label, .source-option-path, .comparison-row-label, .pricing-model-name, .timeline-legend-item, .usage-tooltip-title";
const TRANSLATED_ATTRIBUTES = ["aria-label", "title", "placeholder"];

export function localeFromLanguages(languages = []) {
  const first = Array.isArray(languages) ? languages[0] : languages;
  return String(first || "")
    .toLowerCase()
    .startsWith("zh")
    ? "zh-CN"
    : "en-US";
}

export function preferredLocale(
  storage,
  languages = globalThis.navigator?.languages || [globalThis.navigator?.language],
) {
  try {
    const saved = (storage === undefined ? globalThis.localStorage : storage)?.getItem(LOCALE_STORAGE_KEY);
    if (SUPPORTED_LOCALES.includes(saved)) return saved;
  } catch {
    // file:// pages and restricted browsers may deny storage.
  }
  return localeFromLanguages(languages);
}

export function getLocale() {
  return activeLocale;
}

export function localizeText(value, locale = activeLocale) {
  const input = String(value ?? "");
  if (locale === "en-US" && input === "、") return ", ";
  if (locale === "en-US" && input === "；") return "; ";
  if (locale === "en-US" && input === "。") return ".";
  if (locale !== "en-US" || !/[\u3400-\u9fff]/u.test(input)) return input;
  const match = input.match(/^(\s*)([\s\S]*?)(\s*)$/u);
  const before = match?.[1] || "";
  const text = match?.[2] || input;
  const after = match?.[3] || "";
  if (ENGLISH.has(text)) return before + ENGLISH.get(text) + after;
  for (const [pattern, format] of ENGLISH_PATTERNS) {
    if (pattern.test(text)) return before + text.replace(pattern, format) + after;
  }
  if (text.endsWith("。")) {
    const translated = englishText(text.slice(0, -1));
    if (!/[\u3400-\u9fff]/u.test(translated))
      return before + translated + (/[.!?]$/u.test(translated) ? "" : ".") + after;
  }
  for (const separator of [" · ", "；"]) {
    if (!text.includes(separator)) continue;
    const parts = text.split(separator).map(englishText);
    if (parts.every((part) => !/[\u3400-\u9fff]/u.test(part))) {
      return before + parts.join(separator === "；" ? "; " : " · ") + after;
    }
  }
  return input;
}

export function englishCopyEntries() {
  return [...ENGLISH.entries()];
}

export function canonicalRecentValue(value) {
  const input = String(value || "")
    .trim()
    .replace(/\s+/g, " ");
  const named = {
    上一个7d: "上周",
    "上一个 7d": "上周",
    "last 7d": "上周",
    上一个5h: "上一个5h",
    上周: "上周",
    上个月: "上个月",
    今年: "今年",
    "last 5h": "上一个5h",
    "last week": "上周",
    "last month": "上个月",
    "this year": "今年",
  };
  if (named[input.toLowerCase()]) return named[input.toLowerCase()];
  const compact = input.replace(/\s+/g, "");
  if (/^[1-9]\d*$/.test(compact)) return `${compact}天`;
  if (compact === "半年" || compact === "一年" || /^[1-9]\d*(?:天|周|个月|年)$/.test(compact)) return compact;
  const match = input.toLowerCase().match(/^([1-9]\d*)\s*(days?|weeks?|months?|years?)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit.startsWith("day")) return `${amount}天`;
  if (unit.startsWith("week")) return `${amount}周`;
  if (unit.startsWith("month")) return amount === 6 ? "半年" : `${amount}个月`;
  return amount === 1 ? "一年" : `${amount}年`;
}

export function displayRecentValue(value, locale = activeLocale) {
  if (value === "上周") return localizeText("上一个7d", locale);
  if (["上一个5h", "上周", "上个月", "今年"].includes(value)) return localizeText(value, locale);
  if (locale !== "en-US") return String(value || "");
  const canonical = canonicalRecentValue(value);
  if (!canonical) return String(value || "");
  if (canonical === "半年") return "6 months";
  if (canonical === "一年") return "1 year";
  const match = canonical.match(/^([1-9]\d*)(天|周|个月|年)$/);
  if (!match) return canonical;
  const amount = Number(match[1]);
  const unit = { 天: "day", 周: "week", 个月: "month", 年: "year" }[match[2]];
  return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
}

export function formatLocalDateTime(value, locale = activeLocale) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return localizeText("未知时间", locale);
  return cachedDateTimeFormat(locale, LOCAL_DATE_TIME_OPTIONS).format(date);
}

export function localizeServerError(body, status = 0, locale = activeLocale) {
  if (locale !== "en-US") return body?.error || `API ${status}`;
  const known = {
    INVALID_PRESET: "That time range is not supported.",
    INVALID_BUCKET: "That chart interval is not supported.",
    INVALID_DATE: "Enter a valid date in YYYY-MM-DD format.",
    INVALID_DATE_RANGE: "The start date must be on or before the end date.",
    MISSING_IMPORT_PATH: "Enter a directory path.",
    FULL_DETAIL_UNAVAILABLE:
      "Full detail is unavailable in low-memory mode. Restart with more memory or export a snapshot.",
    QUOTA_WINDOW_UNAVAILABLE: "This limit window is not available yet.",
    SNAPSHOT_EXPIRED: "This snapshot has expired.",
    INVALID_IMPORT_DIRECTORY:
      "Choose a Codex, ZCode, or DSH home directory, an OpenCode data directory, a Claude Code home, a WorkBuddy home, or a project with a usage log.",
    INVALID_PRICING: "Check the pricing rates and exchange rate, then try again.",
  };
  if (body?.code && known[body.code]) return known[body.code];
  if (body?.error && ENGLISH.has(body.error)) return ENGLISH.get(body.error);
  if (status === 403) return "This operation is not allowed.";
  if (status === 404) return "The requested resource was not found.";
  if (status >= 500) return `The local service could not complete this request (HTTP ${status}).`;
  return `The request could not be completed${status ? ` (HTTP ${status})` : ""}.`;
}

export function localizeQuotaReason(window, locale = activeLocale) {
  if (locale !== "en-US") return window?.reason || "";
  const reasons = {
    "multiple-buckets": "Multiple Codex limit buckets cannot be distinguished.",
    "no-records": "No Codex limit records were found.",
    "conflicting-reset": "Conflicting reset times were recorded at the same observation time.",
    waiting: "Waiting for a new limit record.",
    "missing-window": "No Codex record was found for the current limit window.",
    "invalid-boundaries": "The limit window boundaries are invalid.",
  };
  return reasons[window?.reasonCode] || localizeText(window?.reason || "此限额窗口当前不可用。", locale);
}

function isSkippedElement(element) {
  return element.matches("script, style, code, pre, textarea, input, [data-i18n-skip]") && element.tagName !== "INPUT";
}

function applyAttributeTranslations(element) {
  let attributes = attributeSources.get(element);
  if (!attributes) {
    attributes = new Map();
    attributeSources.set(element, attributes);
  }
  for (const name of TRANSLATED_ATTRIBUTES) {
    if (!element.hasAttribute(name)) continue;
    const current = element.getAttribute(name) || "";
    const entry = attributes.get(name);
    const source = entry && current === entry.output ? entry.source : current;
    const output = localizeText(source);
    attributes.set(name, { source, output });
    if (current !== output) element.setAttribute(name, output);
  }
}

function translateTextNode(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest(`script, style, code, pre, textarea, input, [data-i18n-skip], ${SKIP_USER_DATA}`))
    return;
  const current = node.nodeValue || "";
  const entry = nodeSources.get(node);
  const source = entry && current === entry.output ? entry.source : current;
  const output = activeLocale === "en-US" && parent.dataset.i18nEn ? parent.dataset.i18nEn : localizeText(source);
  nodeSources.set(node, { source, output });
  if (current !== output) node.nodeValue = output;
}

function translateElementAttributes(element) {
  if (isSkippedElement(element) || element.closest(SKIP_USER_DATA)) return;
  applyAttributeTranslations(element);
}

function translateNode(node) {
  if (node.nodeType === 3) {
    translateTextNode(node);
    return;
  }
  if (node.nodeType !== 1) return;
  const element = node;
  if (isSkippedElement(element)) return;
  if (!element.closest(SKIP_USER_DATA)) applyAttributeTranslations(element);
  for (const child of element.childNodes) translateNode(child);
}

export function translatePage(root = globalThis.document?.body) {
  if (!root) return;
  translateNode(root);
}

function isTextAtCachedOutput(node) {
  const entry = nodeSources.get(node);
  return Boolean(entry && (node.nodeValue || "") === entry.output);
}

// mode "subtree" translates the node and its descendants, "attributes" only the node's
// translated attributes (what an attributes record can actually have changed).
function queueTranslationRoot(node, mode) {
  if (!node || (node.nodeType !== 1 && node.nodeType !== 3)) return;
  // A detached subtree carries no visible text and its user-data ancestors cannot be
  // resolved yet; inserting it later queues it again through the observer.
  if (!node.isConnected) return;
  if (mode === "subtree") {
    for (const [root, rootMode] of pendingRoots) {
      if (root === node) {
        if (rootMode !== "subtree") pendingRoots.set(root, "subtree");
        return;
      }
      if (root.contains(node)) {
        // An attributes-only pass on an ancestor cannot cover a descendant subtree.
        if (rootMode !== "subtree") pendingRoots.set(root, "subtree");
        return;
      }
    }
    for (const root of pendingRoots.keys()) {
      if (node.contains(root)) pendingRoots.delete(root);
    }
    pendingRoots.set(node, "subtree");
  } else {
    for (const [root, rootMode] of pendingRoots) {
      if (root === node || (rootMode === "subtree" && root.contains(node))) return;
    }
    pendingRoots.set(node, "attributes");
  }
  if (pendingRoots.size > MAX_PENDING_ROOTS) fullPageScheduled = true;
}

function queueMutation(mutation) {
  const target = mutation?.target;
  if (!target) {
    fullPageScheduled = true;
    return;
  }
  if (mutation.type === "characterData") {
    // A record whose text still equals our own last output is already translated;
    // re-queueing those records is what used to make the observer re-walk the page.
    if (!isTextAtCachedOutput(target)) queueTranslationRoot(target, "subtree");
    return;
  }
  if (mutation.type === "attributes") {
    queueTranslationRoot(target, "attributes");
    return;
  }
  if (mutation.type === "childList") {
    for (const node of mutation.addedNodes) queueTranslationRoot(node, "subtree");
    return;
  }
  // Unknown record shape: fall back to a whole-page pass instead of silently skipping work.
  fullPageScheduled = true;
}

function flushTranslationQueue() {
  const roots = [...pendingRoots];
  const fullPage = fullPageScheduled;
  pendingRoots.clear();
  fullPageScheduled = false;
  // Safety net: unclassifiable work (or a pathologically wide batch) keeps the previous
  // "translate the whole page" behaviour, so nothing translatable is ever left behind.
  if (fullPage) {
    translatePage();
    return;
  }
  for (const [root, mode] of roots) {
    if (mode === "attributes") translateElementAttributes(root);
    else translatePage(root);
  }
}

export function setLocale(locale, { persist = true } = {}) {
  activeLocale = locale === "en-US" ? "en-US" : "zh-CN";
  if (globalThis.document) {
    document.documentElement.lang = activeLocale;
    document.documentElement.dataset.locale = activeLocale;
    translatePage();
  }
  if (persist) {
    try {
      globalThis.localStorage?.setItem(LOCALE_STORAGE_KEY, activeLocale);
    } catch {
      // The selection still applies for the current page.
    }
  }
  return activeLocale;
}

export function initializeLocale() {
  const locale = preferredLocale();
  setLocale(locale, { persist: false });
  if (globalThis.document) {
    document.documentElement.removeAttribute("data-i18n-pending");
    if (typeof MutationObserver !== "undefined" && !observer) {
      observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) queueMutation(mutation);
        if (translationScheduled) return;
        translationScheduled = true;
        queueMicrotask(() => {
          translationScheduled = false;
          flushTranslationQueue();
        });
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: TRANSLATED_ATTRIBUTES,
      });
    }
  }
  return locale;
}
