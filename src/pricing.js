import { createHash } from "node:crypto";

export const API_PRICING_CHECKED_AT = "2026-09-25";
export const API_PRICING_VERSION = "2026-09-25";
export const API_PRICING_MODE = "minimum-fallback-scenario";
export const API_PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing";
export const LONG_CONTEXT_INPUT_THRESHOLD = 272_000;

export const CNY_PRICING_SOURCES = Object.freeze({
  stepfun: "https://platform.stepfun.com/docs/zh/guides/pricing/details",
  mimo: "https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go",
  deepseek: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
  kimi: "https://platform.kimi.com/docs/pricing/chat",
  glm: "https://docs.bigmodel.cn/cn/guide/start/pricing",
  xai: "https://docs.x.ai/developers/pricing",
  qwen: "https://www.qwencloud.com/pricing/api",
  gemini: "https://ai.google.dev/gemini-api/docs/pricing",
  minimax: "https://platform.minimax.io/docs/guides/pricing-paygo",
  meta: "https://dev.meta.ai/docs/pricing-rate-limits",
});

// 混合币种排序与图表比例只做显示折算，金额本身仍按原币种累计。
// 汇率（1 美元兑多少人民币）由用户在“更新计价标准”弹窗中填写；
// 默认值取 2026-09-25 实时汇率 6.717（open.er-api.com），四舍五入为 6.72。
export const DEFAULT_USD_TO_CNY_RATE = 6.72;

const USD_PER_MILLION_TOKENS = 1_000_000;
const DETAIL_INPUT = 1;
const DETAIL_CACHED = 2;
const DETAIL_OUTPUT = 4;
const DETAIL_INCONSISTENT = 16;

// 每 100 万 tokens 的单价。currency 省略时为美元（OpenAI 价目）；
// 人民币模型来自各厂商官方定价页（见 source 字段）。
// 分档字段说明：
//   longContextThreshold  单次请求输入超过该值按 long 费率（省略时按事件记录的上下文档）
//   outputThreshold       输出达到该值时短上下文改用 shortLongOutput 费率（GLM 的输出分档）
//   offPeakMultiplier     不在 peakWindows 时段内时整体乘以该折扣（DeepSeek 谷价 5 折）
//   peakWindows           高峰时段：按 peakTimezone 判定星期与时刻；无法识别的节假日按高峰计（略保守）
const MODEL_PRICES = Object.freeze({
  "gpt-6-astra": Object.freeze({ fast: { short: { input: 20, cachedInput: 2, cacheWrite: 25, output: 100 }, long: { input: 40, cachedInput: 4, cacheWrite: 50, output: 150 } }, short: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 }, long: { input: 20, cachedInput: 2, cacheWrite: 25, output: 75 } }),
  "gpt-6-sol": Object.freeze({ fast: { short: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 }, long: { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 30 } }, short: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 }, long: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 15 } }),
  "gpt-6-luna": Object.freeze({ fast: { short: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1 }, long: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.5 } }, short: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 }, long: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 0.75 } }),
  "gpt-5.6-sol": Object.freeze({ fast: { short: { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 40 }, long: { input: 16, cachedInput: 1.6, cacheWrite: 20, output: 60 } }, short: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 }, long: { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 30 } }),
  "gpt-5.6-terra": Object.freeze({ fast: { short: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 24 }, long: { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 36 } }, short: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 }, long: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 18 } }),
  "gpt-5.6-luna": Object.freeze({ fast: { short: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 2.4 }, long: { input: 0.8, cachedInput: 0.08, cacheWrite: 1, output: 3.6 } }, short: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 }, long: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.8 } }),
  // StepFun（人民币，元/百万 tokens；命中 = 缓存命中价，页面未单列缓存写入费）
  "step-5-preview": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.stepfun, short: { input: 7, cachedInput: 0.35, cacheWrite: 0, output: 20 }, long: { input: 7, cachedInput: 0.35, cacheWrite: 0, output: 20 } }),
  "step-3.7-flash": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.stepfun, short: { input: 1.35, cachedInput: 0.27, cacheWrite: 0, output: 8.1 }, long: { input: 1.35, cachedInput: 0.27, cacheWrite: 0, output: 8.1 } }),
  "step-3.5-flash": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.stepfun, short: { input: 0.7, cachedInput: 0.14, cacheWrite: 0, output: 2.1 }, long: { input: 0.7, cachedInput: 0.14, cacheWrite: 0, output: 2.1 } }),
  "step-3.5-flash-2603": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.stepfun, short: { input: 0.7, cachedInput: 0.14, cacheWrite: 0, output: 2.1 }, long: { input: 0.7, cachedInput: 0.14, cacheWrite: 0, output: 2.1 } }),
  // 小米 MiMo（人民币；缓存写入限时免费按 0 计，批量推理价未纳入）
  "mimo-v2.6-pro": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.mimo, short: { input: 3, cachedInput: 0.025, cacheWrite: 0, output: 6 }, long: { input: 3, cachedInput: 0.025, cacheWrite: 0, output: 6 } }),
  "mimo-v2.6-flash": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.mimo, short: { input: 1, cachedInput: 0.02, cacheWrite: 0, output: 2 }, long: { input: 1, cachedInput: 0.02, cacheWrite: 0, output: 2 } }),
  "mimo-v2.6-pro-ultraspeed": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.mimo, short: { input: 30, cachedInput: 0.25, cacheWrite: 0, output: 60 }, long: { input: 30, cachedInput: 0.25, cacheWrite: 0, output: 60 } }),
  "mimo-v2.5-pro": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.mimo, short: { input: 3, cachedInput: 0.025, cacheWrite: 0, output: 6 }, long: { input: 3, cachedInput: 0.025, cacheWrite: 0, output: 6 } }),
  "mimo-v2.5": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.mimo, short: { input: 1, cachedInput: 0.02, cacheWrite: 0, output: 2 }, long: { input: 1, cachedInput: 0.02, cacheWrite: 0, output: 2 } }),
  // DeepSeek（人民币；基准为高峰价，谷时 5 折。高峰 = 北京时间工作日 9:00-12:00、14:00-18:00，节假日未建模按高峰计）
  "deepseek-flash": Object.freeze({
    currency: "CNY", source: CNY_PRICING_SOURCES.deepseek,
    short: { input: 2, cachedInput: 0.04, cacheWrite: 0, output: 8 }, long: { input: 2, cachedInput: 0.04, cacheWrite: 0, output: 8 },
    offPeakMultiplier: 0.5, peakTimezone: "Asia/Shanghai",
    peakWindows: Object.freeze([Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), ranges: Object.freeze([Object.freeze(["09:00", "12:00"]), Object.freeze(["14:00", "18:00"])]) })]),
  }),
  "deepseek-v4-pro": Object.freeze({
    currency: "CNY", source: CNY_PRICING_SOURCES.deepseek,
    short: { input: 9, cachedInput: 0.3, cacheWrite: 0, output: 27 }, long: { input: 9, cachedInput: 0.3, cacheWrite: 0, output: 27 },
    offPeakMultiplier: 0.5, peakTimezone: "Asia/Shanghai",
    peakWindows: Object.freeze([Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5]), ranges: Object.freeze([Object.freeze(["09:00", "12:00"]), Object.freeze(["14:00", "18:00"])]) })]),
  }),
  // 月之暗面 Kimi（人民币；kimi-k3 缓存写入默认 5 分钟 TTL 档 20 元，1 小时档为 40 元）
  "kimi-k3": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.kimi, short: { input: 20, cachedInput: 2, cacheWrite: 20, output: 100 }, long: { input: 20, cachedInput: 2, cacheWrite: 20, output: 100 } }),
  "kimi-k2.7-code": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.kimi, short: { input: 6.5, cachedInput: 1.3, cacheWrite: 0, output: 27 }, long: { input: 6.5, cachedInput: 1.3, cacheWrite: 0, output: 27 } }),
  "kimi-k2.7-code-highspeed": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.kimi, short: { input: 13, cachedInput: 2.6, cacheWrite: 0, output: 54 }, long: { input: 13, cachedInput: 2.6, cacheWrite: 0, output: 54 } }),
  "kimi-k2.6": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.kimi, short: { input: 6.5, cachedInput: 1.1, cacheWrite: 0, output: 27 }, long: { input: 6.5, cachedInput: 1.1, cacheWrite: 0, output: 27 } }),
  // 智谱 GLM（人民币；缓存写入限时免费按 0 计。glm-4.7 / glm-4.5-air 另有输出长度分档）
  "glm-5.3": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 8, cachedInput: 2, cacheWrite: 0, output: 28 }, long: { input: 8, cachedInput: 2, cacheWrite: 0, output: 28 } }),
  "glm-5.3-flash": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 0.8, cachedInput: 0.23, cacheWrite: 0, output: 2.8 }, long: { input: 0.8, cachedInput: 0.23, cacheWrite: 0, output: 2.8 } }),
  "glm-5.3-flashx": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 2, cachedInput: 0.57, cacheWrite: 0, output: 7 }, long: { input: 2, cachedInput: 0.57, cacheWrite: 0, output: 7 } }),
  "glm-5.2": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 8, cachedInput: 2, cacheWrite: 0, output: 28 }, long: { input: 8, cachedInput: 2, cacheWrite: 0, output: 28 } }),
  "glm-5.1": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, longContextThreshold: 32_000, short: { input: 6, cachedInput: 1.3, cacheWrite: 0, output: 24 }, long: { input: 8, cachedInput: 2, cacheWrite: 0, output: 28 } }),
  "glm-5-turbo": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, longContextThreshold: 32_000, short: { input: 5, cachedInput: 1.2, cacheWrite: 0, output: 22 }, long: { input: 7, cachedInput: 1.8, cacheWrite: 0, output: 26 } }),
  "glm-5": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, longContextThreshold: 32_000, short: { input: 4, cachedInput: 1, cacheWrite: 0, output: 18 }, long: { input: 6, cachedInput: 1.5, cacheWrite: 0, output: 22 } }),
  "glm-4.7": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, longContextThreshold: 32_000, outputThreshold: 200, short: { input: 2, cachedInput: 0.4, cacheWrite: 0, output: 8 }, shortLongOutput: { input: 3, cachedInput: 0.6, cacheWrite: 0, output: 14 }, long: { input: 4, cachedInput: 0.8, cacheWrite: 0, output: 16 } }),
  "glm-4.5-air": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, longContextThreshold: 32_000, outputThreshold: 200, short: { input: 0.8, cachedInput: 0.16, cacheWrite: 0, output: 2 }, shortLongOutput: { input: 0.8, cachedInput: 0.16, cacheWrite: 0, output: 6 }, long: { input: 1.2, cachedInput: 0.24, cacheWrite: 0, output: 8 } }),
  "glm-4.7-flashx": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 0.5, cachedInput: 0.1, cacheWrite: 0, output: 3 }, long: { input: 0.5, cachedInput: 0.1, cacheWrite: 0, output: 3 } }),
  "glm-4.7-flash": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 }, long: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 } }),
  "glm-4-plus": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 5, cachedInput: 2.5, cacheWrite: 0, output: 5 }, long: { input: 5, cachedInput: 2.5, cacheWrite: 0, output: 5 } }),
  "glm-4-air-250414": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 0.5, cachedInput: 0.25, cacheWrite: 0, output: 0.5 }, long: { input: 0.5, cachedInput: 0.25, cacheWrite: 0, output: 0.5 } }),
  "glm-4-airx": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 10, cachedInput: 0, cacheWrite: 0, output: 10 }, long: { input: 10, cachedInput: 0, cacheWrite: 0, output: 10 } }),
  "glm-4-long": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 1, cachedInput: 0.5, cacheWrite: 0, output: 1 }, long: { input: 1, cachedInput: 0.5, cacheWrite: 0, output: 1 } }),
  "glm-4-assistant": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 5, cachedInput: 0, cacheWrite: 0, output: 5 }, long: { input: 5, cachedInput: 0, cacheWrite: 0, output: 5 } }),
  "glm-z1-air": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 0.5, cachedInput: 0, cacheWrite: 0, output: 0.5 }, long: { input: 0.5, cachedInput: 0, cacheWrite: 0, output: 0.5 } }),
  "glm-z1-airx": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 5, cachedInput: 0, cacheWrite: 0, output: 5 }, long: { input: 5, cachedInput: 0, cacheWrite: 0, output: 5 } }),
  "glm-z1-flashx": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 0.1, cachedInput: 0, cacheWrite: 0, output: 0.1 }, long: { input: 0.1, cachedInput: 0, cacheWrite: 0, output: 0.1 } }),
  "glm-z1-flash": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 }, long: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 } }),
  "glm-4-flashx-250414": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 0.1, cachedInput: 0.05, cacheWrite: 0, output: 0.1 }, long: { input: 0.1, cachedInput: 0.05, cacheWrite: 0, output: 0.1 } }),
  "glm-4-flash-250414": Object.freeze({ currency: "CNY", source: CNY_PRICING_SOURCES.glm, short: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 }, long: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 } }),
  // xAI Grok（美元；200K 输入分档，全部 token 按高档计。grok-4.7 另有官方 Fast 价）
  "grok-4.7": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.xai, longContextThreshold: 200_000, short: { input: 2, cachedInput: 0.5, cacheWrite: 0, output: 6 }, long: { input: 4, cachedInput: 1, cacheWrite: 0, output: 12 }, fast: { short: { input: 4, cachedInput: 1, cacheWrite: 0, output: 12 }, long: { input: 6, cachedInput: 1.5, cacheWrite: 0, output: 18 } } }),
  "grok-4.6": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.xai, longContextThreshold: 200_000, short: { input: 2, cachedInput: 0.5, cacheWrite: 0, output: 6 }, long: { input: 4, cachedInput: 1, cacheWrite: 0, output: 12 } }),
  "grok-4.5": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.xai, longContextThreshold: 200_000, short: { input: 2, cachedInput: 0.3, cacheWrite: 0, output: 6 }, long: { input: 4, cachedInput: 0.6, cacheWrite: 0, output: 12 } }),
  "grok-4.3": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.xai, longContextThreshold: 200_000, short: { input: 1.25, cachedInput: 0.2, cacheWrite: 0, output: 2.5 }, long: { input: 2.5, cachedInput: 0.4, cacheWrite: 0, output: 5 } }),
  "grok-4.20-0309-reasoning": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.xai, longContextThreshold: 200_000, short: { input: 1.25, cachedInput: 0.2, cacheWrite: 0, output: 2.5 }, long: { input: 2.5, cachedInput: 0.4, cacheWrite: 0, output: 5 } }),
  "grok-4.20-0309-non-reasoning": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.xai, longContextThreshold: 200_000, short: { input: 1.25, cachedInput: 0.2, cacheWrite: 0, output: 2.5 }, long: { input: 2.5, cachedInput: 0.4, cacheWrite: 0, output: 5 } }),
  "grok-4.20-multi-agent-0309": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.xai, longContextThreshold: 200_000, short: { input: 1.25, cachedInput: 0.2, cacheWrite: 0, output: 2.5 }, long: { input: 2.5, cachedInput: 0.4, cacheWrite: 0, output: 5 } }),
  "grok-build-0.1": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.xai, longContextThreshold: 200_000, short: { input: 1, cachedInput: 0.2, cacheWrite: 0, output: 2 }, long: { input: 2, cachedInput: 0.4, cacheWrite: 0, output: 4 } }),
  // QwenCloud（美元；qwen3.7 系列分档。qwen3.7-plus 为当前 8 折促销价；缓存为隐式缓存命中价）
  "qwen3.8-max": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.qwen, short: { input: 2, cachedInput: 0.25, cacheWrite: 0, output: 6 } }),
  "qwen3.8-flash": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.qwen, short: { input: 0.15, cachedInput: 0.016, cacheWrite: 0, output: 0.47 } }),
  "qwen3.8-2.4t-a95b": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.qwen, short: { input: 2, cachedInput: 0.25, cacheWrite: 0, output: 6 } }),
  "qwen3.7-max": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.qwen, short: { input: 2.5, cachedInput: 0.5, cacheWrite: 0, output: 7.5 } }),
  "qwen3.7-plus": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.qwen, longContextThreshold: 256_000, short: { input: 0.32, cachedInput: 0.064, cacheWrite: 0, output: 1.28 }, long: { input: 0.96, cachedInput: 0.192, cacheWrite: 0, output: 3.84 } }),
  "qwen3.7-flash": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.qwen, longContextThreshold: 32_000, short: { input: 0.03, cachedInput: 0.006, cacheWrite: 0, output: 0.13 }, long: { input: 0.1, cachedInput: 0.02, cacheWrite: 0, output: 0.4 } }),
  // QwenCloud 第三方转售（美元；deepseek 系按北京时间 8:00-22:00 高峰、其余 5 折）
  "glm-5.3-prime": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.qwen, short: { input: 2.8, cachedInput: 0.56, cacheWrite: 0, output: 8.8 } }),
  "deepseek-v4.1-flash": Object.freeze({
    currency: "USD", source: CNY_PRICING_SOURCES.qwen,
    short: { input: 0.3, cachedInput: 0.03, cacheWrite: 0, output: 1.2 },
    offPeakMultiplier: 0.5, peakTimezone: "Asia/Shanghai",
    peakWindows: Object.freeze([Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5, 6, 7]), ranges: Object.freeze([Object.freeze(["08:00", "22:00"])]) })]),
  }),
  "deepseek-v4-flash-0731": Object.freeze({
    currency: "USD", source: CNY_PRICING_SOURCES.qwen,
    short: { input: 0.44, cachedInput: 0.044, cacheWrite: 0, output: 1.32 },
    offPeakMultiplier: 0.5, peakTimezone: "Asia/Shanghai",
    peakWindows: Object.freeze([Object.freeze({ days: Object.freeze([1, 2, 3, 4, 5, 6, 7]), ranges: Object.freeze([Object.freeze(["08:00", "22:00"])]) })]),
  }),
  // Google Gemini（美元；Priority 为官方快速档。缓存写入为按时存储费，按 0 简化）
  "gemini-2.5-pro": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.gemini, short: { input: 1.25, cachedInput: 0.125, cacheWrite: 0, output: 10 }, fast: { short: { input: 2.25, cachedInput: 0.125, cacheWrite: 0, output: 18 } } }),
  "gemini-2.5-flash": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.gemini, short: { input: 0.3, cachedInput: 0.03, cacheWrite: 0, output: 2.5 }, fast: { short: { input: 0.54, cachedInput: 0.03, cacheWrite: 0, output: 4.5 } } }),
  "gemini-2.5-flash-lite": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.gemini, short: { input: 0.1, cachedInput: 0.01, cacheWrite: 0, output: 0.4 }, fast: { short: { input: 0.18, cachedInput: 0.01, cacheWrite: 0, output: 0.72 } } }),
  "gemini-3.8-flash": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.gemini, short: { input: 0.75, cachedInput: 0.075, cacheWrite: 0, output: 3.75 } }),
  "gemini-3.7-flash": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.gemini, short: { input: 0.75, cachedInput: 0.075, cacheWrite: 0, output: 3.75 } }),
  "gemini-3.6-flash": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.gemini, short: { input: 0.75, cachedInput: 0.075, cacheWrite: 0, output: 3.75 } }),
  "gemini-3.5-flash": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.gemini, short: { input: 1.5, cachedInput: 0.15, cacheWrite: 0, output: 9 } }),
  "gemini-3.5-flash-lite": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.gemini, short: { input: 0.3, cachedInput: 0.03, cacheWrite: 0, output: 2.5 } }),
  "gemini-3.1-flash-lite": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.gemini, short: { input: 0.25, cachedInput: 0.025, cacheWrite: 0, output: 1.5 } }),
  "gemini-3.1-pro-preview": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.gemini, short: { input: 2, cachedInput: 0.2, cacheWrite: 0, output: 12 } }),
  "gemini-3-flash-preview": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.gemini, short: { input: 0.5, cachedInput: 0.05, cacheWrite: 0, output: 3 } }),
  "gemma-4": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.gemini, short: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 } }),
  // MiniMax（美元；M3 为长期五折后价、512K 输入分档，Priority 为官方快速档）
  "minimax-m3": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.minimax, longContextThreshold: 512_000, short: { input: 0.3, cachedInput: 0.06, cacheWrite: 0, output: 1.2 }, long: { input: 0.6, cachedInput: 0.12, cacheWrite: 0, output: 2.4 }, fast: { short: { input: 0.45, cachedInput: 0.09, cacheWrite: 0, output: 1.8 }, long: { input: 0.9, cachedInput: 0.18, cacheWrite: 0, output: 3.6 } } }),
  "minimax-m2.7": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.minimax, short: { input: 0.3, cachedInput: 0.06, cacheWrite: 0.375, output: 1.2 } }),
  "minimax-m2.7-highspeed": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.minimax, short: { input: 0.6, cachedInput: 0.06, cacheWrite: 0.375, output: 2.4 } }),
  "minimax-m2.5": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.minimax, short: { input: 0.3, cachedInput: 0.03, cacheWrite: 0.375, output: 1.2 } }),
  "minimax-m2.5-highspeed": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.minimax, short: { input: 0.6, cachedInput: 0.03, cacheWrite: 0.375, output: 2.4 } }),
  "minimax-m2.1": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.minimax, short: { input: 0.3, cachedInput: 0.03, cacheWrite: 0.375, output: 1.2 } }),
  "minimax-m2.1-highspeed": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.minimax, short: { input: 0.6, cachedInput: 0.03, cacheWrite: 0.375, output: 2.4 } }),
  "minimax-m2": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.minimax, short: { input: 0.3, cachedInput: 0.03, cacheWrite: 0.375, output: 1.2 } }),
  // Meta（美元；muse-spark 系列无长上下文加价）
  "muse-spark-1.3": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.meta, short: { input: 1.25, cachedInput: 0.15, cacheWrite: 0, output: 4.25 } }),
  "muse-spark-1.2": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.meta, short: { input: 1.25, cachedInput: 0.15, cacheWrite: 0, output: 4.25 } }),
  "muse-spark-1.1": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.meta, short: { input: 1.25, cachedInput: 0.15, cacheWrite: 0, output: 4.25 } }),
  "muse-spark-1.3-contributor": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.meta, short: { input: 0.1, cachedInput: 0.002, cacheWrite: 0, output: 0.2 } }),
  "muse-spark-1.2-contributor": Object.freeze({ currency: "USD", source: CNY_PRICING_SOURCES.meta, short: { input: 0.1, cachedInput: 0.002, cacheWrite: 0, output: 0.2 } }),
});

const PRICE_ALIASES = Object.freeze({
  "gpt-5.6": "gpt-5.6-sol",
  "gpt-daybreak-blue-latest": "gpt-5.6-sol",
});

const RATE_FIELDS = ["input", "cachedInput", "cacheWrite", "output"];

// Custom rates reprice all indexed events so the dashboard remains internally
// consistent. The original token counts and recorded price versions are retained.
let activePricing = { checkedAt: API_PRICING_CHECKED_AT, version: API_PRICING_VERSION, usdToCnyRate: DEFAULT_USD_TO_CNY_RATE, models: MODEL_PRICES };

export const API_TOKEN_PRICES = Object.freeze(Object.fromEntries(
  Object.entries(MODEL_PRICES)
    .filter(([, rates]) => (rates.currency || "USD") === "USD")
    .map(([model, rates]) => [model, rates.short]),
));

export function getPricingCatalog() {
  return { checkedAt: activePricing.checkedAt, version: activePricing.version,
    usdToCnyRate: activePricing.usdToCnyRate,
    source: API_PRICING_SOURCE, models: structuredClone(activePricing.models) };
}

function validateRates(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid rates for ${label}`);
  const rates = {};
  for (const field of RATE_FIELDS) {
    if (typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0) {
      throw new Error(`Invalid ${field} rate for ${label}`);
    }
    rates[field] = value[field];
  }
  return rates;
}

function validatePeakWindows(value, label) {
  if (!Array.isArray(value) || !value.length) throw new Error(`Invalid peak windows for ${label}`);
  return value.map((window) => {
    const days = (window?.days || []).map(Number);
    if (!days.length || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      throw new Error(`Invalid peak days for ${label}`);
    }
    const ranges = (window?.ranges || []).map((range) => {
      if (!Array.isArray(range) || range.length !== 2 || !/^\d{2}:\d{2}$/.test(range[0]) || !/^\d{2}:\d{2}$/.test(range[1])) {
        throw new Error(`Invalid peak range for ${label}`);
      }
      return [range[0], range[1]];
    });
    if (!ranges.length) throw new Error(`Invalid peak ranges for ${label}`);
    return { days, ranges };
  });
}

export function validatePricingCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pricing must be an object.");
  const checkedAt = value.checkedAt;
  if (typeof checkedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(checkedAt) ||
      Number.isNaN(Date.parse(`${checkedAt}T00:00:00Z`)) ||
      new Date(`${checkedAt}T00:00:00Z`).toISOString().slice(0, 10) !== checkedAt) {
    throw new Error("Pricing date must be a valid YYYY-MM-DD date.");
  }
  const models = value.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("Model prices are required.");
  const usdToCnyRate = value.usdToCnyRate === undefined ? DEFAULT_USD_TO_CNY_RATE : Number(value.usdToCnyRate);
  if (!Number.isFinite(usdToCnyRate) || usdToCnyRate <= 0) throw new Error("USD to CNY rate must be a positive number.");
  const keys = Object.keys(models);
  if (keys.length < Object.keys(MODEL_PRICES).length || keys.length > 100 ||
      Object.keys(MODEL_PRICES).some((key) => !Object.hasOwn(models, key))) {
    throw new Error("All built-in models must have prices.");
  }
  const normalized = {};
  for (const model of keys.sort()) {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(model)) throw new Error(`Invalid model name: ${model}`);
    const entry = models[model];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid rates for ${model}`);
    const currency = entry.currency === undefined ? "USD" : entry.currency;
    if (currency !== "USD" && currency !== "CNY") throw new Error(`Invalid currency for ${model}`);
    const short = validateRates(entry.short, `${model} short`);
    const result = { currency, short };
    result.long = entry.long === undefined ? { ...short } : validateRates(entry.long, `${model} long`);
    if (entry.shortLongOutput !== undefined) {
      result.shortLongOutput = validateRates(entry.shortLongOutput, `${model} shortLongOutput`);
    }
    if (entry.fast !== undefined) {
      const fast = entry.fast;
      if (!fast || typeof fast !== "object" || Array.isArray(fast)) throw new Error(`Invalid fast rates for ${model}`);
      const fastRates = { short: validateRates(fast.short, `${model} fast short`) };
      if (fast.long !== undefined) fastRates.long = validateRates(fast.long, `${model} fast long`);
      if (fast.shortLongOutput !== undefined) fastRates.shortLongOutput = validateRates(fast.shortLongOutput, `${model} fast shortLongOutput`);
      result.fast = fastRates;
    }
    if (entry.longContextThreshold !== undefined) {
      const threshold = Number(entry.longContextThreshold);
      if (!Number.isInteger(threshold) || threshold <= 0) throw new Error(`Invalid longContextThreshold for ${model}`);
      result.longContextThreshold = threshold;
    }
    if (entry.outputThreshold !== undefined) {
      const threshold = Number(entry.outputThreshold);
      if (!Number.isInteger(threshold) || threshold <= 0) throw new Error(`Invalid outputThreshold for ${model}`);
      result.outputThreshold = threshold;
    }
    if (entry.offPeakMultiplier !== undefined) {
      const multiplier = Number(entry.offPeakMultiplier);
      if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1) throw new Error(`Invalid offPeakMultiplier for ${model}`);
      result.offPeakMultiplier = multiplier;
    }
    if (entry.peakWindows !== undefined) {
      result.peakWindows = validatePeakWindows(entry.peakWindows, model);
      result.peakTimezone = typeof entry.peakTimezone === "string" && entry.peakTimezone ? entry.peakTimezone : "Asia/Shanghai";
    }
    if (entry.source !== undefined) {
      if (typeof entry.source !== "string" || !/^https?:\/\//.test(entry.source)) throw new Error(`Invalid source for ${model}`);
      result.source = entry.source;
    }
    normalized[model] = result;
  }
  return { checkedAt, usdToCnyRate, models: normalized };
}

export function setPricingCatalog(value) {
  const catalog = validatePricingCatalog(value);
  const hash = createHash("sha256").update(JSON.stringify(catalog)).digest("hex").slice(0, 12);
  activePricing = { ...catalog, version: `${catalog.checkedAt}-${hash}` };
  return getPricingCatalog();
}

// 旧版本保存的价目缺少新增的人民币模型/快速模式等字段时：
// 用户改过的费率优先保留，结构性字段缺失则从内置官方价目补齐，而不是被旧文件顶掉。
function fillMissingStructure(saved, builtIn) {
  const merged = { ...saved };
  for (const field of ["longContextThreshold", "outputThreshold", "offPeakMultiplier", "peakTimezone", "source"]) {
    if (merged[field] === undefined && builtIn[field] !== undefined) merged[field] = builtIn[field];
  }
  for (const field of ["long", "fast", "shortLongOutput", "peakWindows"]) {
    if (merged[field] === undefined && builtIn[field] !== undefined) merged[field] = structuredClone(builtIn[field]);
  }
  return merged;
}

export function mergePricingCatalog(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Pricing must be an object.");
  const savedModels = value.models || {};
  const models = {};
  for (const [model, builtIn] of Object.entries(MODEL_PRICES)) {
    models[model] = savedModels[model]
      ? fillMissingStructure(savedModels[model], builtIn)
      : structuredClone(builtIn);
  }
  for (const [model, saved] of Object.entries(savedModels)) {
    if (!models[model]) models[model] = saved;
  }
  return {
    checkedAt: value.checkedAt,
    usdToCnyRate: value.usdToCnyRate,
    models,
  };
}

export function resetPricingCatalog() {
  activePricing = { checkedAt: API_PRICING_CHECKED_AT, version: API_PRICING_VERSION, usdToCnyRate: DEFAULT_USD_TO_CNY_RATE, models: MODEL_PRICES };
}

export function pricingVersionForTimestamp(_timestamp) {
  return activePricing.version;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function usageFields(event = {}) {
  const usage = event.total || event.usage || event;
  const mask = Number.isInteger(event.detailMask) ? event.detailMask : 0;
  const has = (key, bit) => Number.isInteger(event.detailMask) ? Boolean(mask & bit) : Object.hasOwn(usage, key);
  return {
    total: finiteNonNegative(usage.total) ?? 0,
    input: finiteNonNegative(usage.input),
    cached: finiteNonNegative(usage.cached),
    output: finiteNonNegative(usage.output),
    inputKnown: has("input", DETAIL_INPUT) && finiteNonNegative(usage.input) !== null,
    cachedKnown: has("cached", DETAIL_CACHED) && finiteNonNegative(usage.cached) !== null,
    outputKnown: has("output", DETAIL_OUTPUT) && finiteNonNegative(usage.output) !== null,
    inconsistent: Boolean(mask & DETAIL_INCONSISTENT),
  };
}

function normalizeModel(value) {
  const model = String(value || "Unknown model").trim() || "Unknown model";
  const lower = model.toLocaleLowerCase();
  if (activePricing.models[lower]) return { name: model, key: lower };
  if (PRICE_ALIASES[lower]) return { name: model, key: PRICE_ALIASES[lower] };
  for (const known of Object.keys(activePricing.models)) {
    if (lower.startsWith(`${known}-`)) return { name: model, key: known };
  }
  return { name: model, key: "" };
}

function normalizeServiceTier(value) {
  const tier = String(value || "").trim().toLocaleLowerCase();
  if (tier === "fast" || tier === "priority") return "fast";
  if (tier === "default" || tier === "standard") return "standard";
  return "unknown";
}

function minimumRateSets(sets) {
  // 全零费率是免费档，不代表典型成本，不参与最低费率兜底。
  const candidates = sets.filter(Boolean).filter((set) => RATE_FIELDS.some((category) => set[category] > 0));
  if (!candidates.length) return null;
  const rates = {};
  for (const category of RATE_FIELDS) {
    rates[category] = Math.min(...candidates.map((candidate) => candidate[category]));
  }
  return rates;
}

function eventTimestampMs(event = {}) {
  const raw = event.timestamp ?? event.timestampMs ?? event.timestamp_ms;
  const value = typeof raw === "string" ? Date.parse(raw) : Number(raw);
  return Number.isFinite(value) ? value : null;
}

function timeOfDayMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(value || "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function isPeakPricingTime(entry, timestampMs) {
  if (!entry?.offPeakMultiplier || !Array.isArray(entry.peakWindows)) return true;
  if (!Number.isFinite(timestampMs)) return true;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: entry.peakTimezone || "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestampMs)).map((part) => [part.type, part.value]));
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  if (weekdayIndex < 0 || !Number.isFinite(minutes)) return true;
  return entry.peakWindows.some((window) =>
    (window.days || []).includes(weekdayIndex === 0 ? 7 : weekdayIndex) &&
    (window.ranges || []).some((range) => {
      const start = timeOfDayMinutes(range[0]);
      const end = timeOfDayMinutes(range[1]);
      return start !== null && end !== null && minutes >= start && minutes < end;
    }),
  );
}

function contextTierFor(entry, event, usage) {
  if (Number.isInteger(entry?.longContextThreshold)) {
    const requestInput = finiteNonNegative(event.requestInputTokens) || usage.input;
    if (requestInput === null || !(requestInput > 0)) return "unknown";
    return requestInput > entry.longContextThreshold ? "long" : "short";
  }
  return event.contextLevel === "long" ? "long" : event.contextLevel === "short" ? "short" : "unknown";
}

function rateSetsFor(entry, contextTier, usage) {
  const outputSplit = Number.isInteger(entry.outputThreshold) && entry.shortLongOutput;
  const longOutput = outputSplit && usage.output !== null && usage.output >= entry.outputThreshold;
  if (contextTier === "long") return [entry.long || entry.short];
  if (contextTier === "short") return [longOutput ? entry.shortLongOutput : entry.short];
  return longOutput ? [entry.shortLongOutput, entry.long || entry.short] : [entry.short, entry.long || entry.short];
}

function currencyForEvent(model, event) {
  if (model.key) return activePricing.models[model.key].currency || "USD";
  const channel = String(event.channel || event.source || "");
  return channel.toLocaleLowerCase().startsWith("zcode") ? "CNY" : "USD";
}

function minimumRatesFor(modelKey, contextLevel, currency) {
  const catalogs = modelKey
    ? [activePricing.models[modelKey]]
    : Object.values(activePricing.models).filter((entry) => (entry.currency || "USD") === currency);
  const contexts = contextLevel === "unknown" ? ["short", "long"] : [contextLevel];
  const candidates = catalogs.flatMap((catalog) => contexts.map((context) => catalog?.[context]).filter(Boolean));
  return minimumRateSets(candidates);
}

function minimumCategory(rates, categories) {
  return categories.reduce((lowest, category) =>
    rates[category] < rates[lowest] ? category : lowest, categories[0]);
}

function estimateEventCost(event = {}) {
  const model = normalizeModel(event.model);
  const usage = usageFields(event);
  const total = usage.total || (usage.input || 0) + (usage.output || 0);
  const version = activePricing.version;
  const entry = model.key ? activePricing.models[model.key] : null;
  const currency = currencyForEvent(model, event);
  const contextLevel = contextTierFor(entry, event, usage);
  const serviceTier = normalizeServiceTier(event.serviceTier ?? event.service_tier);
  // 官方单独声明快速模式费率时按其计价；否则沿用 Fast/Priority 双倍标准价的兜底。
  const useFastRates = serviceTier === "fast" && Boolean(entry?.fast);
  const multiplier = serviceTier === "fast" && !useFastRates ? 2 : 1;
  const rateEntry = useFastRates
    ? {
        ...entry,
        short: entry.fast.short || entry.short,
        shortLongOutput: entry.fast.shortLongOutput || entry.shortLongOutput,
        long: entry.fast.long || entry.long || entry.short,
      }
    : entry;
  const timestampMs = eventTimestampMs(event);
  const peak = entry ? isPeakPricingTime(entry, timestampMs) : true;
  const offPeakMultiplier = entry && !peak ? entry.offPeakMultiplier : 1;
  let rates = entry
    ? minimumRateSets(rateSetsFor(rateEntry, contextLevel, usage))
    : minimumRatesFor("", contextLevel, currency);
  if (rates && offPeakMultiplier !== 1) {
    rates = Object.fromEntries(RATE_FIELDS.map((category) => [category, rates[category] * offPeakMultiplier]));
  }
  const minimumModelRate = !model.key;
  const cacheWriteTokens = finiteNonNegative(event.cacheWriteTokens);
  const cacheWriteKnown = event.cacheWriteKnown === true || (Number.isInteger(event.detailMask) && Boolean(event.detailMask & 32));
  const knownOrInferredInput = usage.inputKnown ? usage.input
    : usage.outputKnown ? Math.max(0, total - usage.output) : null;
  const cacheWriteUnknownTokens = !cacheWriteKnown || cacheWriteTokens === null
    ? knownOrInferredInput === null ? 0
      : Math.max(0, knownOrInferredInput - (usage.cachedKnown ? Math.min(usage.cached, knownOrInferredInput) : 0))
    : 0;
  const reasons = [];
  let inputUsd = 0;
  let cachedInputUsd = 0;
  let cacheWriteInputUsd = 0;
  let outputUsd = 0;
  let minimumEstimatedTokens = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;

  if (!rates) {
    return {
      model: model.name,
      currency,
      priceVersion: version,
      priceSource: entry?.source || API_PRICING_SOURCE,
      serviceTier,
      contextLevel,
      inputUsd: 0,
      cachedInputUsd: 0,
      cacheWriteInputUsd: 0,
      outputUsd: 0,
      totalUsd: null,
      pricedTokens: 0,
      unpricedTokens: total,
      minimumEstimatedTokens: 0,
      minimumRateModels: [],
      unpricedModels: [model.name],
      unpricedReasons: ["no-pricing-catalog"],
      serviceTierUnknownTokens: 0,
      contextUnknownTokens: 0,
      cacheWriteUnknownTokens,
      pricingStatus: "unpriced",
    };
  }

  function addCost(tokens, category, minimum = false) {
    if (!(tokens > 0)) return;
    const amount = (tokens * rates[category] * multiplier) / USD_PER_MILLION_TOKENS;
    if (category === "cachedInput") cachedInputUsd += amount;
    else if (category === "cacheWrite") cacheWriteInputUsd += amount;
    else if (category === "output") outputUsd += amount;
    else inputUsd += amount;
    pricedTokens += tokens;
    if (minimum) minimumEstimatedTokens += tokens;
  }

  function addMinimum(tokens, categories) {
    addCost(tokens, minimumCategory(rates, categories), true);
  }

  const allCategories = RATE_FIELDS;
  const countsInconsistent = usage.inconsistent ||
    (usage.inputKnown && usage.input > total) ||
    (usage.outputKnown && usage.output > total) ||
    (usage.inputKnown && usage.outputKnown && usage.input + usage.output !== total);
  if (countsInconsistent) {
    reasons.push("usage-detail-inconsistent-minimum-scenario");
    addMinimum(total, allCategories);
  } else {
    const inferredInput = knownOrInferredInput;
    if (inferredInput !== null) {
      const input = inferredInput;
      if (!usage.inputKnown) reasons.push("input-detail-inferred-from-total");
      const cachedValid = usage.cachedKnown && usage.cached <= input;
      const writeValid = cacheWriteKnown && cacheWriteTokens !== null && cacheWriteTokens <= input;
      if (cachedValid && writeValid && usage.cached + cacheWriteTokens <= input) {
        addCost(input - usage.cached - cacheWriteTokens, "input");
        addCost(usage.cached, "cachedInput");
        addCost(cacheWriteTokens, "cacheWrite");
      } else if (cachedValid && !writeValid && !cacheWriteKnown) {
        addCost(usage.cached, "cachedInput");
        addMinimum(input - usage.cached, ["input", "cacheWrite"]);
      } else if (writeValid && !cachedValid && !usage.cachedKnown) {
        addCost(cacheWriteTokens, "cacheWrite");
        addMinimum(input - cacheWriteTokens, ["input", "cachedInput"]);
      } else {
        reasons.push("input-detail-inconsistent-minimum-scenario");
        addMinimum(input, ["input", "cachedInput", "cacheWrite"]);
      }
      if (!usage.cachedKnown) reasons.push("cached-input-detail-missing");
      if (!cacheWriteKnown || cacheWriteTokens === null) reasons.push("cache-write-detail-missing");
    } else {
      reasons.push("input-detail-missing");
    }

    if (usage.outputKnown) addCost(usage.output, "output");
    else reasons.push("output-detail-missing");

    const remainder = Math.max(0, total - pricedTokens);
    if (usage.inputKnown && !usage.outputKnown) addCost(remainder, "output", true);
    else if (!usage.inputKnown && usage.outputKnown) addMinimum(remainder, ["input", "cachedInput", "cacheWrite"]);
    else addMinimum(remainder, allCategories);
  }

  if (minimumModelRate) {
    reasons.push("unknown-model-price-minimum-scenario");
    minimumEstimatedTokens = pricedTokens;
  }
  const serviceTierUnknownTokens = serviceTier === "unknown" ? pricedTokens : 0;
  const contextUnknownTokens = contextLevel === "unknown" ? pricedTokens : 0;
  if (serviceTier === "unknown") reasons.push("service-tier-unknown-standard-scenario");
  if (contextLevel === "unknown") reasons.push("request-context-unknown-minimum-scenario");
  if (entry && !peak) reasons.push("off-peak-pricing-applied");
  const totalUsd = inputUsd + cachedInputUsd + cacheWriteInputUsd + outputUsd;
  return {
    model: model.name,
    currency,
    priceVersion: version,
    priceSource: entry?.source || API_PRICING_SOURCE,
    serviceTier,
    contextLevel,
    inputUsd,
    cachedInputUsd,
    cacheWriteInputUsd,
    outputUsd,
    totalUsd: pricedTokens > 0 ? totalUsd : null,
    pricedTokens,
    unpricedTokens,
    minimumEstimatedTokens,
    minimumRateModels: minimumModelRate ? [model.name] : [],
    unpricedModels: [],
    unpricedReasons: [...new Set(reasons)],
    serviceTierUnknownTokens,
    contextUnknownTokens,
    cacheWriteUnknownTokens,
    pricingStatus: minimumEstimatedTokens > 0 ? "minimum-estimate" : "estimated",
  };
}

function createCostSummaryState(options = {}) {
  const totals = {
    inputUsd: 0,
    cachedInputUsd: 0,
    cacheWriteInputUsd: 0,
    outputUsd: 0,
    totalUsd: 0,
    cacheRateInput: 0,
    cacheRateCached: 0,
    pricedTokens: 0,
    unpricedTokens: 0,
    minimumEstimatedTokens: 0,
    pricedRecords: 0,
    minimumEstimatedRecords: 0,
    unpricedRecords: 0,
    serviceTierUnknownTokens: 0,
    serviceTierUnknownRecords: 0,
    contextUnknownTokens: 0,
    contextUnknownRecords: 0,
    cacheWriteUnknownTokens: 0,
    cacheWriteUnknownRecords: 0,
  };
  const byCurrency = {
    USD: { inputUsd: 0, cachedInputUsd: 0, cacheWriteInputUsd: 0, outputUsd: 0, totalUsd: 0, records: 0 },
    CNY: { inputUsd: 0, cachedInputUsd: 0, cacheWriteInputUsd: 0, outputUsd: 0, totalUsd: 0, records: 0 },
  };
  const models = new Set();
  const unpricedModels = new Set();
  const minimumRateModels = new Set();
  const unpricedReasons = new Set();
  const priceVersions = new Set();
  const priceSources = new Set();

  function add(item, estimate = estimateEventCost(item)) {
    for (const field of [
      "inputUsd", "cachedInputUsd", "cacheWriteInputUsd", "outputUsd", "cacheRateInput", "cacheRateCached",
      "pricedTokens", "unpricedTokens", "minimumEstimatedTokens", "serviceTierUnknownTokens", "contextUnknownTokens", "cacheWriteUnknownTokens",
    ]) {
      if (field in estimate) totals[field] += Number(estimate[field] || 0);
    }
    totals.totalUsd += Number(estimate.totalUsd || 0);
    const bucket = byCurrency[estimate.currency === "CNY" ? "CNY" : "USD"];
    bucket.inputUsd += Number(estimate.inputUsd || 0);
    bucket.cachedInputUsd += Number(estimate.cachedInputUsd || 0);
    bucket.cacheWriteInputUsd += Number(estimate.cacheWriteInputUsd || 0);
    bucket.outputUsd += Number(estimate.outputUsd || 0);
    bucket.totalUsd += Number(estimate.totalUsd || 0);
    if (estimate.pricedTokens > 0) {
      totals.pricedRecords += 1;
      bucket.records += 1;
    }
    if (estimate.minimumEstimatedTokens > 0) totals.minimumEstimatedRecords += 1;
    if (estimate.unpricedTokens > 0) totals.unpricedRecords += 1;
    if (estimate.serviceTierUnknownTokens > 0) totals.serviceTierUnknownRecords += 1;
    if (estimate.contextUnknownTokens > 0) totals.contextUnknownRecords += 1;
    if (estimate.cacheWriteUnknownTokens > 0) totals.cacheWriteUnknownRecords += 1;
    if (modelNameIsKnown(estimate.model)) models.add(estimate.model);
    for (const name of estimate.unpricedModels) unpricedModels.add(name);
    for (const name of estimate.minimumRateModels || []) minimumRateModels.add(name);
    for (const reason of estimate.unpricedReasons) unpricedReasons.add(reason);
    priceVersions.add(estimate.priceVersion);
    if (estimate.priceSource) priceSources.add(estimate.priceSource);
    const usage = usageFields(item);
    if (usage.inputKnown && usage.cachedKnown && usage.input > 0) {
      totals.cacheRateInput += usage.input;
      totals.cacheRateCached += usage.cached || 0;
    }
  }

  function result() {
    const usd = byCurrency.USD;
    const cny = byCurrency.CNY;
    return {
      totalUsd: usd.records > 0 ? usd.totalUsd : null,
      inputUsd: usd.records > 0 ? usd.inputUsd : null,
      cachedInputUsd: usd.records > 0 ? usd.cachedInputUsd : null,
      cacheWriteInputUsd: usd.records > 0 ? usd.cacheWriteInputUsd : null,
      outputUsd: usd.records > 0 ? usd.outputUsd : null,
      totalCny: cny.records > 0 ? cny.totalUsd : null,
      inputCny: cny.records > 0 ? cny.inputUsd : null,
      cachedInputCny: cny.records > 0 ? cny.cachedInputUsd : null,
      cacheWriteInputCny: cny.records > 0 ? cny.cacheWriteInputUsd : null,
      outputCny: cny.records > 0 ? cny.outputUsd : null,
      currencies: [...(usd.records > 0 ? ["USD"] : []), ...(cny.records > 0 ? ["CNY"] : [])],
      cacheHitRate: totals.cacheRateInput > 0 ? totals.cacheRateCached / totals.cacheRateInput : null,
      modelCount: models.size,
      pricedTokens: totals.pricedTokens,
      unpricedTokens: totals.unpricedTokens,
      minimumEstimatedTokens: totals.minimumEstimatedTokens,
      pricedRecords: totals.pricedRecords,
      unpricedRecords: totals.unpricedRecords,
      minimumEstimatedRecords: totals.minimumEstimatedRecords,
      unpricedModels: [...unpricedModels].sort((a, b) => a.localeCompare(b)),
      minimumRateModels: [...minimumRateModels].sort((a, b) => a.localeCompare(b)),
      unpricedReasons: [...unpricedReasons].sort(),
      serviceTierUnknownTokens: totals.serviceTierUnknownTokens,
      serviceTierUnknownRecords: totals.serviceTierUnknownRecords,
      contextUnknownTokens: totals.contextUnknownTokens,
      contextUnknownRecords: totals.contextUnknownRecords,
      cacheWriteUnknownTokens: totals.cacheWriteUnknownTokens,
      cacheWriteUnknownRecords: totals.cacheWriteUnknownRecords,
      priceVersions: [...priceVersions].sort(),
      priceSources: [...priceSources].sort(),
      usdToCnyRate: options.usdToCnyRate ?? activePricing.usdToCnyRate,
      priceCheckedAt: options.priceCheckedAt || activePricing.checkedAt,
      priceMode: API_PRICING_MODE,
      priceSource: API_PRICING_SOURCE,
    };
  }

  return { add, result };
}

export function createCostEstimateAccumulator(options = {}) {
  return createCostSummaryState(options);
}

function summarizeCostItems(items = [], options = {}) {
  const summary = createCostSummaryState(options);
  for (const item of items) summary.add(item);
  return summary.result();
}

function modelNameIsKnown(value) {
  return Boolean(value) && value.toLocaleLowerCase() !== "unknown model";
}

export function estimateCostForEvents(events = [], options = {}) {
  return summarizeCostItems(events, options);
}

export function estimateCostForGroups(groups = [], options = {}) {
  return summarizeCostItems(groups.map((group) => ({
    ...group,
    total: {
      total: group.total,
      input: group.input,
      cached: group.cached,
      output: group.output,
    },
  })), options);
}

export { estimateEventCost };
