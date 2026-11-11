export const DEEPSEEK_RAW_MODELS = Object.freeze([
  "deepseek-v4.1-flash",
  "opendesign/deepseek-v4.1-flash",
  "workbuddy-ai/deepseek-v4.1-flash",
  "workbuddy-ai/deepseek-v4.1-flash-sg",
  "opencode-go/deepseek-v4.1-flash",
  "deepseek-flash",
  "deepseek-v4.1-flash-sg",
  "group/deepseek",
]);

export const UNKNOWN_MODELS = Object.freeze([
  "opencode-go/gemini-4-argon-contributor",
  "sensenova-6.8-flash-lite",
  "Unknown model",
]);

export const KNOWN_PREFIXED_MODEL = "codex/gpt-6.1-sol";
export const FIXTURE_NOW = "2026-10-26T12:00:00.000Z";

const RATES = Object.freeze({
  deepseek: Object.freeze({
    currency: "CNY",
    short: { input: 2, cachedInput: 0.04, cacheWrite: 0, output: 8 },
    long: { input: 2, cachedInput: 0.04, cacheWrite: 0, output: 8 },
    offPeakMultiplier: 0.5,
    peakTimezone: "Asia/Shanghai",
    peakWindows: [{ days: [1, 2, 3, 4, 5], ranges: [["09:00", "12:00"], ["14:00", "18:00"]] }],
  }),
  gpt: Object.freeze({
    currency: "USD",
    short: { input: 1, cachedInput: 0.1, cacheWrite: 0, output: 8 },
    long: { input: 2, cachedInput: 0.2, cacheWrite: 0, output: 16 },
  }),
  argon: Object.freeze({
    currency: "USD",
    short: { input: 0.5, cachedInput: 0.05, cacheWrite: 0, output: 2 },
    long: { input: 1, cachedInput: 0.1, cacheWrite: 0, output: 4 },
  }),
});

export const PRICING_MODELS_A = Object.freeze({
  "deepseek-flash": RATES.deepseek,
  "gpt-6.1-sol": RATES.gpt,
});

export const PRICING_MODELS_B = Object.freeze({
  ...PRICING_MODELS_A,
  "gemini-4-argon-contributor": RATES.argon,
});

const SOURCES = Object.freeze([
  { sourceKind: "codex", channel: "Codex", homeId: "codex", homeLabel: "Codex" },
  { sourceKind: "dsh", channel: "DSH", homeId: "dsh", homeLabel: "DSH" },
  { sourceKind: "workbuddy", channel: "WorkBuddy", homeId: "workbuddy", homeLabel: "WorkBuddy" },
  { sourceKind: "claude", channel: "Claude", homeId: "claude", homeLabel: "Claude" },
  { sourceKind: "zcode", channel: "ZCode", homeId: "zcode", homeLabel: "ZCode" },
]);

const SPECS = Object.freeze([
  [DEEPSEEK_RAW_MODELS[0], "2026-09-22T02:00:00.000Z", SOURCES[1], "deepseek-shared-session"],
  [DEEPSEEK_RAW_MODELS[1], "2026-09-22T02:00:00.000Z", SOURCES[0], "deepseek-opendesign"],
  [DEEPSEEK_RAW_MODELS[2], "2026-09-22T02:00:00.000Z", SOURCES[2], "deepseek-workbuddy"],
  [DEEPSEEK_RAW_MODELS[3], "2026-09-22T02:00:00.000Z", SOURCES[0], "deepseek-workbuddy-sg"],
  [DEEPSEEK_RAW_MODELS[4], "2026-09-22T05:00:00.000Z", SOURCES[0], "deepseek-opencode"],
  [DEEPSEEK_RAW_MODELS[5], "2026-09-22T05:00:00.000Z", SOURCES[4], "deepseek-shared-session"],
  [DEEPSEEK_RAW_MODELS[6], "2026-09-22T05:00:00.000Z", SOURCES[3], "deepseek-sg"],
  [DEEPSEEK_RAW_MODELS[7], "2026-09-22T05:00:00.000Z", SOURCES[1], "deepseek-group"],
  [UNKNOWN_MODELS[0], "2026-09-22T02:00:00.000Z", SOURCES[0], "unknown-argon"],
  [UNKNOWN_MODELS[1], "2026-09-22T05:00:00.000Z", SOURCES[2], "unknown-sensenova"],
  [UNKNOWN_MODELS[2], "2026-09-22T05:00:00.000Z", SOURCES[4], "unknown-model"],
  [KNOWN_PREFIXED_MODEL, "2026-09-22T02:00:00.000Z", SOURCES[0], "known-gpt"],
]);

export function createPricingOfficialReport() {
  const events = SPECS.map(([model, timestamp, source, sessionId], index) => ({
    timestamp,
    sessionId,
    ...source,
    model,
    cwd: "/fixture/pricing-official",
    total: { total: 900 + index, input: 800 + index, cached: 100, output: 100, reasoning: 0 },
    cacheWriteTokens: 0,
    cacheWriteKnown: true,
    serviceTier: "standard",
    contextLevel: "short",
    detailMask: 15,
  }));
  return {
    generatedAt: FIXTURE_NOW,
    homes: SOURCES.map(({ homeId: id, homeLabel: label, sourceKind: kind }) => ({
      id,
      label,
      path: `/fixture/${id}`,
      kind,
    })),
    events,
    sessions: [],
    rateLimitObservations: [],
    warnings: [],
  };
}

export function stepfunPricingPage() {
  return `<!doctype html><html><body><table><thead><tr><th>模型</th><th>计费单位</th><th>输入价格（缓存未命中）</th><th>输入价格（缓存命中）</th><th>输出价格</th></tr></thead><tbody>
    <tr><td><code>step-5-preview</code></td><td>1M tokens</td><td>7 元</td><td>0.35 元</td><td>20 元</td></tr>
    <tr><td><code>step-3.7-flash</code></td><td>1M tokens</td><td>1.35 元</td><td>0.27 元</td><td>8.1 元</td></tr>
    <tr><td><code>step-3.5-flash</code></td><td>1M tokens</td><td>0.7 元</td><td>0.14 元</td><td>2.1 元</td></tr>
    <tr><td><code>step-3.5-flash-2603</code></td><td>1M tokens</td><td>0.7 元</td><td>0.14 元</td><td>2.1 元</td></tr>
  </tbody></table></body></html>`;
}

export function kimiPricingPage() {
  return [
    "此处 1M = 1,000,000 tokens。缓存写入（TTL 5min）和缓存写入（TTL 1h）。",
    "rows:[[ `kimi-k3`,`1M tokens`,`¥20.00`,`¥40.00`,`¥2.00`,`¥20.00`,`¥100.00`,`1,048,576 tokens` ]]",
    "rows:[[ `kimi-k2.7-code`,`1M tokens`,`¥1.30`,`¥6.50`,`¥27.00`,`262,144 tokens` ],[ `kimi-k2.7-code-highspeed`,`1M tokens`,`¥2.60`,`¥13.00`,`¥54.00`,`262,144 tokens` ],[ `kimi-k2.6`,`1M tokens`,`¥1.10`,`¥6.50`,`¥27.00`,`262,144 tokens` ]]",
  ].join("\n");
}

export function glmPricingPage() {
  const rows = [
    ["GLM-5.3", "1M", "8", "28", "限时免费", "2"],
    ["GLM-5.3-Flash", "1M", "0.8", "2.8", "限时免费", "0.23"],
    ["GLM-5.3-FlashX", "1M", "2", "7", "限时免费", "0.57"],
    ["GLM-5.2", "1M", "8", "28", "限时免费", "2"],
    ["GLM-5.1", "输入长度 [0, 32K)", "6", "24", "限时免费", "1.3"],
    ["GLM-5.1", "输入长度 ≥32K", "8", "28", "限时免费", "2"],
    ["GLM-5-Turbo", "输入长度 [0, 32K)", "5", "22", "限时免费", "1.2"],
    ["GLM-5-Turbo", "输入长度 ≥32K", "7", "26", "限时免费", "1.8"],
    ["GLM-5", "输入长度 [0, 32K)", "4", "18", "限时免费", "1"],
    ["GLM-5", "输入长度 ≥32K", "6", "22", "限时免费", "1.5"],
    ["GLM-4.7-FlashX", "200K", "0.5", "3", "限时免费", "0.1"],
    ["GLM-4.7-Flash", "200K", "免费", "免费", "限时免费", "免费"],
    ["GLM-4-Plus", "128K", "5", "5", "限时免费", "2.5"],
    ["GLM-4-Air-250414", "128K", "0.5", "0.5", "限时免费", "0.25"],
    ["GLM-4-AirX", "8K", "10", "10", "限时免费", "不支持"],
    ["GLM-4-Long", "1M", "1", "1", "限时免费", "0.5"],
    ["GLM-4-Assistant", "128K", "5", "5", "限时免费", "不支持"],
    ["GLM-Z1-Air", "128K", "0.5", "0.5", "限时免费", "不支持"],
    ["GLM-Z1-AirX", "32K", "5", "5", "限时免费", "不支持"],
    ["GLM-Z1-FlashX", "128K", "0.1", "0.1", "限时免费", "不支持"],
    ["GLM-4-FlashX-250414", "128K", "0.1", "0.1", "限时免费", "0.05"],
    ["GLM-4-Flash-250414", "128K", "免费", "免费", "限时免费", "不支持"],
    ["GLM-Z1-Flash", "128K", "免费", "免费", "限时免费", "不支持"],
    ["GLM-4.7", "输入 [0, 32K)，输出 [0, 0.2K)", "2", "8", "限时免费", "0.4"],
    ["GLM-4.7", "输入 [0, 32K)，输出 ≥0.2K", "3", "14", "限时免费", "0.6"],
    ["GLM-4.5-Air", "输入 [0, 32K)，输出 [0, 0.2K)", "0.8", "2", "限时免费", "0.16"],
  ];
  return `<html><body><table><thead><tr><th>模型名称</th><th>上下文</th><th>输入单价（元/百万 Tokens）</th><th>输出单价（元/百万 Tokens）</th><th>缓存存储（元/百万 Tokens/小时）</th><th>缓存命中（元/百万 Tokens）</th></tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("")}</tbody></table></body></html>`;
}
