// Dashboard copy lives here so the live page and exported snapshot use the same wording.
export const LOCALE_STORAGE_KEY = "codexUsageLocale";
export const SUPPORTED_LOCALES = Object.freeze(["zh-CN", "en-US"]);

const ENGLISH = new Map(Object.entries({
  "自动刷新": "Auto Refresh",
  "开": "On",
  "关": "Off",
  "上次：尚无": "Last check: none yet",
  "切换主题": "Switch Theme",
  "切换语言": "Switch Language",
  "当前深色主题，点击切换到浅色主题": "Dark theme. Switch to light theme",
  "当前浅色主题，点击切换到深色主题": "Light theme. Switch to dark theme",
  "导入目录": "Import",
  "筛选": "Filters",
  "范围": "Range",
  "今日": "Today",
  "本周": "This Week",
  "本月": "This Month",
  "全部": "All Time",
  "最近": "Recent",
  "上一个5h": "Last 5h",
  "上周": "Last Week",
  "今年": "This Year",
  "尚未发现上一限额窗口的 Codex 记录。": "No Codex record was found for the previous limit window.",
  "最近范围": "Recent Range",
  "展开最近范围选项": "Show recent range options",
  "1天": "1 day",
  "1周": "1 week",
  "1个月": "1 month",
  "2个月": "2 months",
  "3个月": "3 months",
  "半年": "6 months",
  "一年": "1 year",
  "自定义": "Custom",
  "开始": "Start",
  "结束": "End",
  "年/月/日": "YYYY-MM-DD",
  "打开开始日期日历": "Open start date calendar",
  "打开结束日期日历": "Open end date calendar",
  "上个月": "Last Month",
  "下个月": "Next Month",
  "总览": "Overview",
  "总 tokens": "Total Tokens",
  "总输入": "Total Input",
  "缓存读取": "Cache Hit",
  "输出": "Output",
  "推理输出": "Reasoning Tokens",
  "会话": "Sessions",
  "事件": "Events",
  "API 费用估算": "Estimated API Cost",
  "总花销": "Estimated Cost",
  "普通输入": "Cache Miss",
  "缓存写入": "Cache Write",
  "未命中输入": "Cache Miss",
  "缓存命中": "Cache Hit Rate",
  "缓存命中率": "Cache Hit Rate",
  "模型数量": "Models",
  "模型": "Models",
  "渠道": "Sources",
  "费用": "Cost",
  "费用估算": "Estimated Cost",
  "趋势变化": "Usage Trend",
  "时间分布": "Usage Over Time",
  "时间分布方式": "Timeline Breakdown",
  "按渠道": "By Source",
  "按模型": "By Model",
  "按花销": "By Cost",
  "按仓库": "By Repository",
  "时间分布柱状图；聚焦后可查看用量详情": "Usage over time chart. Focus to inspect each interval",
  "图表图例": "Chart Legend",
  "时间分布详情": "Timeline Details",
  "详情": "Details",
  "跨时间范围用量对比": "Usage Across Time Ranges",
  "搜索模型": "Search Models",
  "搜索模型用量对比": "Search model usage",
  "搜索仓库": "Search Repositories",
  "搜索仓库用量对比": "Search repository usage",
  "扫描目录": "Scanned Directories",
  "编辑": "Edit",
  "费用估算说明": "About Cost Estimates",
  "计价标准": "Pricing Rates",
  "数据来源": "Data Sources",
  "勾选要统计的来源，取消勾选的来源不计入用量、费用和时间线，修改立即生效。": "Choose which sources to include. Changes to usage, cost estimates, and the timeline take effect immediately.",
  "统计来源": "Included Sources",
  "添加目录": "Add Directory",
  "选择文件夹": "Choose Folder",
  "关闭": "Close",
  "导入": "Import",
  "更新计价标准": "Update Pricing Rates",
  "单价单位为对应模型的标价货币（USD 美元 / CNY 人民币）每 100 万 tokens。点击模型名编辑费率（含官方单独声明的快速模式价）；汇率只用于混合币种的排序与图表比例，不改变各币种金额。保存后按当天日期记为核对日期并重算历史估算。": "Rates are quoted per million tokens in each model's billing currency (USD or CNY). Select a model to edit its rates, including published fast tier rates. The exchange rate affects only sorting and chart proportions when currencies are mixed. Saving records today's review date and recalculates historical estimates.",
  "1 美元 =": "1 USD =",
  "人民币": "CNY",
  "模型范围": "Model Scope",
  "在用模型": "Models In Use",
  "全部模型": "All Models",
  "取消": "Cancel",
  "保存并重算": "Save And Recalculate",
  "模型计价": "Model Pricing",
  "应用": "Apply",
  "5 小时限额": "5-Hour Limit",
  "本周限额": "Weekly Limit",
  "限额窗口": "Limit Window",
  "此限额窗口当前不可用。": "This limit window is currently unavailable.",
  "尚无限额快照，请等待 Codex 写入限额记录。": "No limit snapshot is available yet. Wait for Codex to record one.",
  "此静态快照未包含限额元数据，请重新导出。": "This snapshot has no limit window data. Export a new snapshot.",
  "等待新的限额记录。": "Waiting for a new limit record.",
  "等待新的限额记录": "Waiting for a new limit record",
  "导出中的限额窗口边界无效。": "The exported limit window boundaries are invalid.",
  "每个图表时间槽是半小时。": "Each chart interval spans 30 minutes.",
  "每个图表时间槽是连续 24 小时，不按本地自然日或夏令时拆分。": "Each chart interval spans 24 continuous hours; it does not follow local calendar days or daylight saving changes.",
  "统计数据截至": "Data as of",
  "当前时间槽仅统计至": "Current interval includes data through",
  "未知": "Unknown",
  "未知时间": "Unknown time",
  "本地时区": "local time zone",
  "限额窗口边界不可用": "Limit window boundaries unavailable",
  "较昨日": "Vs. Yesterday",
  "较上周": "Vs. Last Week",
  "较上月": "Vs. Last Month",
  "较上一等长周期": "Vs. Previous Period",
  "暂无对比": "No Comparison",
  "昨日 tokens": "Yesterday's Tokens",
  "上周 tokens": "Last Week's Tokens",
  "上月 tokens": "Last Month's Tokens",
  "前一等长区间 tokens": "Previous Period's Tokens",
  "上一周期 tokens": "Previous Period's Tokens",
  "无基准": "No baseline",
  "全部范围没有可比较的上一周期": "All-time usage has no preceding period for comparison.",
  "当前范围没有可比较的上一周期": "No preceding period is available for this range.",
  "平均趋势变化": "Average Usage Change",
  "此静态快照没有费用估算，请重新导出快照。": "This snapshot has no cost estimates. Export a new snapshot.",
  "费用估算暂不可用。": "Cost estimates are temporarily unavailable.",
  "当前价格基准": "Current Pricing Baseline",
  "OpenAI 价格表": "OpenAI Pricing",
  "StepFun 定价": "StepFun Pricing",
  "MiMo 定价": "MiMo Pricing",
  "DeepSeek 定价": "DeepSeek Pricing",
  "Kimi 定价": "Kimi Pricing",
  "GLM 定价": "GLM Pricing",
  "价格来源": "Pricing Source",
  "默认价格来源": "Default Pricing Source",
  "按当前价目表估算": "Estimated using current rates",
  "金额按已知明细及最低费率情景折算 API 等价费用，不代表实际账单，也不含工具调用等非 token 费用。": "API-equivalent costs use available token details, with the lowest applicable rates used where details are missing. They are not actual bills and exclude tool calls and other non-token costs.",
  "估算限制": "Estimate Limitations",
  "缓存读取与写入按各自官方费率计入总额。": "Cache-hit input and cache writes are charged at their respective published rates.",
  "更新计价标准后，所有已索引的历史用量会按新单价重算。": "Updating pricing rates recalculates estimates for all indexed usage.",
  "开始": "Start",
  "现在": "Now",
  "没有匹配的用量记录": "No matching usage records",
  "所选时间范围内没有用量": "No usage in the selected period",
  "没有可计价的费用记录": "No priced usage records",
  "时间槽过多，请缩短日期范围或调大时间粒度。": "Too many chart intervals. Shorten the range or use a coarser interval.",
  "明细未提供": "Details unavailable",
  "只按总输入与缓存读取都已知的记录计算": "Calculated only from records with known total input and cache-hit token counts",
  "缓存读取 ÷ 总输入": "Cache-hit tokens ÷ total input tokens",
  "明细不完整记录的总量": "Tokens With Incomplete Details",
  "记录总量提示，不与各明细相加": "For reference only; do not add to the breakdown",
  "字段不一致记录的总量": "Tokens With Inconsistent Fields",
  "涉及总量、输入/输出或缓存关系不一致": "Total, input/output, or cache figures do not reconcile",
  "明细校验差额合计": "Total Reconciliation Gap",
  "各项差额之和，仅作质量提示": "Sum of discrepancies, shown as a data-quality indicator",
  "Git 仓库": "Git Repository",
  "不受搜索筛选影响": "Unaffected by search",
  "全局合计": "Overall Total",
  "仓库": "Repository",
  "正序": "ascending",
  "倒序": "descending",
  "统计截至": "As of",
  "无模型用量": "No model usage",
  "无可计价费用": "No priceable usage",
  "估算金额": "Estimated Amount",
  "已纳入估算 tokens": "Tokens Included In Estimate",
  "未计价": "Unpriced",
  "服务等级未知，金额按 Standard 情景估算": "Service tier unknown; estimated at Standard rates",
  "请求上下文未知，按可用的较低上下文费率估算": "Request context unknown; estimated at the lower applicable context rate",
  "缓存写入明细未知，相关未知部分按最低费率估算": "Cache-write details unknown; the affected portion uses the lowest applicable rate",
  "不可用": "Unavailable",
  "有用量记录": "Usage found",
  "无用量记录": "No usage found",
  "可扫描": "Ready to scan",
  "没有可统计的来源": "No sources available",
  "没有发现 Codex 或 ZCode 目录": "No Codex or ZCode directories found",
  "移除": "Remove",
  "不计入统计": "Excluded from totals",
  "静态快照不能启动轮询": "Auto refresh is unavailable in a static snapshot",
  "切换自动刷新": "Toggle auto refresh",
  "静态快照，不轮询": "Static snapshot; no polling",
  "已关闭": "Off",
  "此静态快照不会轮询；运行 npm run export 可生成新快照": "This static snapshot does not refresh. Run npm run export to create a new one.",
  "快速模式价": "Fast Mode Rates",
  "短上下文": "Short Context",
  "短上下文·长输出": "Short Context · Long Output",
  "长上下文": "Long Context",
  "快速模式": "Fast Mode",
  "快速·短上下文": "Fast · Short Context",
  "快速·短上下文·长输出": "Fast · Short Context · Long Output",
  "快速·长上下文": "Fast · Long Context",
  "点击编辑该模型费率": "Edit this model's rates",
  "没有匹配的模型": "No matching models",
  "暂无模型": "No models available",
  "暂无已用到的模型": "No used models found",
  "正在保存并重算…": "Saving and recalculating…",
  "静态快照不能编辑数据来源": "Data sources cannot be edited in a static snapshot",
  "静态快照不能选择目录，请启动本地服务或手动输入路径。": "A static snapshot cannot open the folder picker. Start the local server or enter a path manually.",
  "正在打开文件夹选择器...": "Opening folder picker…",
  "已选择目录，可继续导入。": "Folder selected. You can import it now.",
  "没有选择目录。": "No folder selected.",
  "静态快照不能编辑数据来源，请启动本地服务后再操作": "Start the local server to edit data sources.",
  "请输入目录路径。": "Enter a directory path.",
  "正在识别目录...": "Checking directory…",
  "静态快照不能移除导入目录，请启动本地服务后再操作": "Start the local server to remove an imported directory.",
  "正在移除导入目录...": "Removing imported directory…",
  "已移除导入目录，正在刷新...": "Directory removed. Refreshing…",
  "快照已回收，正在重新冻结…": "Snapshot expired. Creating a new one…",
  "限额统计暂不可用": "Limit statistics are temporarily unavailable",
  "正在检查更新…": "Checking for updates…",
  "检测到用量变化，正在更新…": "New usage found. Updating…",
  "正在刷新限额窗口…": "Refreshing limit window…",
  "正在加载限额窗口…": "Loading limit window…",
  "最近范围格式无效。请使用数字和天、周、月或年。": "Invalid recent range. Enter a number followed by days, weeks, months, or years.",
  "请重新导出快照": "Export a new snapshot",
  "请重启服务": "Restart the local service",
  "静态快照无法更新计价标准；请启动本地服务": "Start the local server to update pricing rates.",
  "時間分布圖": "Usage over time chart",
  "存在多个无法区分的 Codex 限额桶。": "Multiple Codex limit buckets cannot be distinguished.",
  "尚未发现 Codex 限额记录。": "No Codex limit records were found.",
  "同一观察时刻存在相互冲突的限额重置时间。": "Conflicting reset times were recorded at the same observation time.",
  "尚未发现当前限额窗口的 Codex 记录。": "No Codex record was found for the current limit window.",
  "限额窗口边界无效。": "The limit window boundaries are invalid.",
  "目录需要是 Codex home、ZCode home，或包含 .codex-usage/usage.jsonl": "Choose a Codex or ZCode home directory, or a project containing .codex-usage/usage.jsonl.",
}));

const englishText = (value) => localizeText(value, "en-US");

const ENGLISH_PATTERNS = [
  [/^当前范围为(.+?)(?:；(.+?))?；点击切换到(.+)$/, (_, current, reason, target) => `Current range: ${englishText(current)}${reason ? `. ${englishText(reason)}` : ""}. Switch to ${englishText(target.trim())}`],
  [/^点击切换到 (.+)$/, (_, target) => `Switch to ${englishText(target)}`],
  [/^等待(.+)数据$/, (_, range) => `Waiting for ${englishText(range)} data`],
  [/^(.+) 至 (.+)$/, (_, start, end) => `${englishText(start)} to ${englishText(end)}`],
  [/^(.+)年(\d{2})月$/, (_, year, month) => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(Number(year), Number(month) - 1, 1)))],
  [/^价格基准 (.+)$/, (_, date) => `Pricing baseline ${date}`],
  [/^按当前价目表估算 · (.+) · (.+)$/, (_, baseline, sources) => `Estimated using current rates · ${englishText(baseline)} · ${englishText(sources)}`],
  [/^(.+) 条记录的服务等级未知，按 Standard 情景估算$/, (_, n) => `${n} records have an unknown service tier; estimated at Standard rates`],
  [/^(.+) 条记录无法可靠对应单次请求输入，按可用的较低上下文费率估算$/, (_, n) => `${n} records lack reliable per-request input details; estimated at the lower applicable context rate`],
  [/^(.+) 个输入 tokens 缺少缓存写入明细，相关未知部分按最低费率估算$/, (_, n) => `Cache-write details are missing for ${n} input tokens; the affected portion uses the lowest applicable rate`],
  [/^(.+) \/ (.+) tokens 使用最低费率估算$/, (_, n, total) => `${n} of ${total} tokens use the lowest applicable rate`],
  [/^模型 (.+) 缺少专用单价，按价目表最低费率估算$/, (_, names) => `No model-specific rate for ${names.replaceAll("、", ", ")}; estimated at the lowest listed rate`],
  [/^仍有 (.+) tokens 无法估算$/, (_, n) => `${n} tokens remain unpriced`],
  [/^仍无法计价的模型：(.+)$/, (_, names) => `Models still unpriced: ${names.replaceAll("、", ", ")}`],
  [/^([\d,]+) 个会话$/, (_, n) => `${n} sessions`],
  [/^([\d,]+) 条事件(?: · ([\d,]+) 个会话)?$/, (_, events, sessions) => `${events} events${sessions ? ` · ${sessions} sessions` : ""}`],
  [/^(.+)，费用估算 (.+)$/, (_, name, amount) => `${name}, estimated cost ${amount}`],
  [/^移除 (.+)$/, (_, name) => `Remove ${name}`],
  [/^(.+)明细$/, (_, period) => `${englishText(period)} Details`],
  [/^；另有 (.+) token 的记录未提供此项$/, (_, n) => `; this field is unavailable for another ${n} tokens`],
  [/^另有 (.+) token 的记录未提供此项$/, (_, n) => `This field is unavailable for another ${n} tokens`],
  [/^(.+)（已知部分）$/, (_, value) => `${value} (known records only)`],
  [/^(.+)，正序$/, (_, label) => `${englishText(label)}, ascending`],
  [/^(.+)，倒序$/, (_, label) => `${englishText(label)}, descending`],
  [/^按(.+)用量排序$/, (_, label) => `Sort by ${englishText(label).toLowerCase()} usage`],
  [/^统计截至 (.+)$/, (_, date) => `As of ${date}`],
  [/^总计 (.+) tokens(?:，(.+)：(.+))?$/, (_, n, kind, breakdown) => `Total ${n} tokens${kind ? `; ${englishText(kind).toLowerCase()}: ${breakdown.replaceAll("，", ", ")}` : ""}`],
  [/^(.+)，费用估算 (.+)，其中 (.+) tokens 按最低费率估算，未计价 (.+) tokens$/, (_, interval, cost, minimum, unpriced) => `${englishText(interval)}. Estimated cost ${cost}; ${minimum} tokens use fallback rates; ${unpriced} tokens are unpriced`],
  [/^时间槽区间 (.+)；(.+)$/, (_, interval, note) => `Interval ${interval}; ${englishText(note)}`],
  [/^未计价 (.+) tokens$/, (_, n) => `${n} unpriced tokens`],
  [/^其中 (.+) tokens 按最低费率估算$/, (_, n) => `${n} tokens use the lowest applicable rate`],
  [/^时间分布，按模型堆叠 API 等价费用估算，美元为纵轴单位(.+)；每个时间槽可查看完整日期、模型费用和最低费率估算部分$/, (_, range) => `Usage over time, with estimated API-equivalent costs stacked by model in USD${englishText(range)}. Inspect each interval for dates, model costs, and fallback estimates`],
  [/^时间分布，(.+)堆叠 tokens(.+)；每个时间槽可查看完整日期和明细$/, (_, mode, range) => `Usage over time, tokens stacked ${englishText(mode).toLowerCase()}${englishText(range)}. Inspect each interval for dates and details`],
  [/^，统计范围 (.+) 至 (.+)$/, (_, start, end) => `, from ${start} to ${end}`],
  [/^(.+)明细不可用，请刷新数据。$/, (_, kind) => `${englishText(kind)} details are unavailable. Refresh the data.`],
  [/^(.+)明细不可用，(.+)$/, (_, kind, action) => `${englishText(kind)} details are unavailable. ${englishText(action)}`],
  [/^此范围超过 (.+) 个时间槽。请缩短日期范围或选择更大的时间粒度。$/, (_, n) => `This range exceeds ${n} chart intervals. Shorten it or use a coarser interval.`],
  [/^上次：(.+)$/, (_, date) => `Last check: ${date}`],
  [/^单次输入超过 (.+) tokens 按长上下文价$/, (_, n) => `Long-context rates apply above ${n} input tokens per request`],
  [/^输出达到 (.+) tokens 起按长输出价$/, (_, n) => `Long-output rates apply at ${n} output tokens or more`],
  [/^谷时按 (.+) 折计（北京时间工作日 9:00-12:00、14:00-18:00 为高峰，节假日未建模按高峰计）$/, (_, discount) => `Off-peak rates are ${Number(discount) * 10}% of peak rates (Beijing time, weekdays 09:00–12:00 and 14:00–18:00; holidays are treated as peak)`],
  [/^(.+)（入\/缓\/出）$/, (_, rates) => `${rates} (Cache Miss/Cache Hit/Output)`],
  [/^上下文 (.+) 分档$/, (_, n) => `Context tier at ${n}`],
  [/^输出 (.+) 分档$/, (_, n) => `Output tier at ${n}`],
  [/^谷时 (.+) 折$/, (_, discount) => `Off-peak ${Number(discount) * 10}%`],
  [/^请填写大于 0 的美元兑人民币汇率。$/, () => "Enter a USD-to-CNY exchange rate greater than zero."],
  [/^读取计价标准失败：(.+)$/, (_, error) => `Could not load pricing rates: ${englishText(error)}`],
  [/^保存失败：(.+)$/, (_, error) => `Could not save: ${englishText(error)}`],
  [/^选择失败：(.+)，也可以手动输入路径。$/, (_, error) => `Could not choose a folder: ${englishText(error)}. You can enter the path manually.`],
  [/^已导入 (.+)，正在刷新\.\.\.$/, (_, name) => `Imported ${name}. Refreshing…`],
  [/^导入失败：(.+)$/, (_, error) => `Import failed: ${englishText(error)}`],
  [/^加载失败：(.+)$/, (_, error) => `Could not load usage: ${englishText(error)}`],
  [/^检查失败：(.+)；下次继续尝试$/, (_, error) => `Update check failed: ${englishText(error)}. Retrying at the next interval.`],
  [/^移除失败：(.+)$/, (_, error) => `Could not remove the directory: ${englishText(error)}`],
  [/^(.+)：(.+)$/, (_, label, detail) => `${englishText(label)}: ${englishText(detail)}`],
];

let activeLocale = "zh-CN";
let observer = null;
const nodeSources = new WeakMap();
const attributeSources = new WeakMap();
const SKIP_USER_DATA = ".home-label strong, .home-path, .source-option-label, .source-option-path, .comparison-row-label, .pricing-model-name, .timeline-legend-item, .usage-tooltip-title";
const TRANSLATED_ATTRIBUTES = ["aria-label", "title", "placeholder"];

export function localeFromLanguages(languages = []) {
  const first = Array.isArray(languages) ? languages[0] : languages;
  return String(first || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function preferredLocale(storage, languages = globalThis.navigator?.languages || [globalThis.navigator?.language]) {
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
    if (!/[\u3400-\u9fff]/u.test(translated)) return before + translated + (/[.!?]$/u.test(translated) ? "" : ".") + after;
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
  const input = String(value || "").trim().replace(/\s+/g, " ");
  const named = { "上一个5h": "上一个5h", "上周": "上周", "上个月": "上个月", "今年": "今年", "last 5h": "上一个5h", "last week": "上周", "last month": "上个月", "this year": "今年" };
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
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(date);
}

export function localizeServerError(body, status = 0, locale = activeLocale) {
  if (locale !== "en-US") return body?.error || `API ${status}`;
  const known = {
    INVALID_PRESET: "That time range is not supported.",
    INVALID_BUCKET: "That chart interval is not supported.",
    INVALID_DATE: "Enter a valid date in YYYY-MM-DD format.",
    INVALID_DATE_RANGE: "The start date must be on or before the end date.",
    MISSING_IMPORT_PATH: "Enter a directory path.",
    FULL_DETAIL_UNAVAILABLE: "Full detail is unavailable in low-memory mode. Restart with more memory or export a snapshot.",
    QUOTA_WINDOW_UNAVAILABLE: "This limit window is not available yet.",
    SNAPSHOT_EXPIRED: "This snapshot has expired.",
    INVALID_IMPORT_DIRECTORY: "Choose a Codex or ZCode home directory, or a project with a usage log.",
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
    "waiting": "Waiting for a new limit record.",
    "missing-window": "No Codex record was found for the current limit window.",
    "invalid-boundaries": "The limit window boundaries are invalid.",
  };
  return reasons[window?.reasonCode] || localizeText(window?.reason || "此限额窗口当前不可用。", locale);
}

function translateNode(node) {
  if (node.nodeType === 3) {
    const parent = node.parentElement;
    if (!parent || parent.closest("script, style, code, pre, textarea, input, [data-i18n-skip], " + SKIP_USER_DATA)) return;
    const current = node.nodeValue || "";
    const entry = nodeSources.get(node);
    const source = entry && current === entry.output ? entry.source : current;
    const output = localizeText(source);
    nodeSources.set(node, { source, output });
    if (current !== output) node.nodeValue = output;
    return;
  }
  if (node.nodeType !== 1) return;
  const element = node;
  if (element.matches("script, style, code, pre, textarea, input, [data-i18n-skip]") && element.tagName !== "INPUT") return;
  if (!element.closest(SKIP_USER_DATA)) {
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
  for (const child of element.childNodes) translateNode(child);
}

export function translatePage(root = globalThis.document?.body) {
  if (!root) return;
  translateNode(root);
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
      let scheduled = false;
      observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => {
          scheduled = false;
          translatePage();
        });
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: TRANSLATED_ATTRIBUTES });
    }
  }
  return locale;
}
