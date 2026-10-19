import { createHash } from "node:crypto";
import { isCodexAutoReview, resolvePricingModel } from "../public/pricing-models.js";

// This catalog revision includes a fresh Claude check on 2026-10-01;
// the date does not claim that every provider entry was rechecked that day.
export const API_PRICING_CHECKED_AT = "2026-10-01";
export const API_PRICING_VERSION = "2026-10-12";
export const MAX_PRICING_MODELS = 256;
export const ANTHROPIC_PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
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
// 离线兜底汇率。在线汇率和手动覆盖由 pricing-store.js 管理。
// 此值取 2026-09-25 汇率 6.717（open.er-api.com），四舍五入为 6.72。
export const DEFAULT_USD_TO_CNY_RATE = 6.72;

const USD_PER_MILLION_TOKENS = 1_000_000;
const DETAIL_INPUT = 1;
const DETAIL_CACHED = 2;
const DETAIL_OUTPUT = 4;
const DETAIL_INCONSISTENT = 16;

/** @typedef {{ input: number, cachedInput: number, cacheWrite: number, output: number }} TokenRates */
/**
 * One model's per-million-token rates. Optional tiers are absent when a
 * provider quotes only one context or service tier.
 * @typedef {object} PriceModel
 * @property {TokenRates} short
 * @property {TokenRates} [long]
 * @property {{ short?: TokenRates, long?: TokenRates, shortLongOutput?: TokenRates }} [fast]
 * @property {TokenRates} [shortLongOutput]
 * @property {"USD" | "CNY"} [currency]
 * @property {string} [source]
 * @property {"5m"} [cacheWriteTtl]
 * @property {number} [standardContextLimit]
 * @property {number} [longContextThreshold]
 * @property {number} [outputThreshold]
 * @property {number} [offPeakMultiplier]
 * @property {string} [peakTimezone]
 * @property {ReadonlyArray<{ days: ReadonlyArray<number>, ranges: ReadonlyArray<ReadonlyArray<string>> }>} [peakWindows]
 */
/** @typedef {{ checkedAt: string, version: string, usdToCnyRate: number, models: Record<string, PriceModel> }} PricingCatalog */

// 每 100 万 tokens 的单价。currency 省略时为美元（OpenAI 价目）；
// 人民币模型来自各厂商官方定价页（见 source 字段）。
// 分档字段说明：
//   longContextThreshold  单次请求输入超过该值按 long 费率（省略时按事件记录的上下文档）
//   outputThreshold       输出达到该值时短上下文改用 shortLongOutput 费率（GLM 的输出分档）
//   offPeakMultiplier     不在 peakWindows 时段内时整体乘以该折扣（DeepSeek 谷价 5 折）
//   peakWindows           高峰时段：按 peakTimezone 判定星期与时刻；无法识别的节假日按高峰计（略保守）
/** @returns {PriceModel} */
function claudePrice(input, cachedInput, output, { fast = false, standardContextLimit = undefined } = {}) {
  const short = { input, cachedInput, cacheWrite: input * 1.25, output };
  return Object.freeze({
    currency: "USD",
    source: ANTHROPIC_PRICING_SOURCE,
    cacheWriteTtl: "5m",
    short,
    ...(standardContextLimit ? { standardContextLimit } : {}),
    ...(fast
      ? {
          fast: {
            short: { input: input * 2, cachedInput: cachedInput * 2, cacheWrite: input * 2.5, output: output * 2 },
          },
        }
      : {}),
  });
}

/** @type {Readonly<Record<string, PriceModel>>} */
const MODEL_PRICES = Object.freeze({
  // Claude API Standard, global, 5-minute cache writes. Older context SKUs are
  // not inferred from today's base price; out-of-range records carry a caveat.
  "claude-fable-5-1": claudePrice(10, 0.25, 50),
  "claude-fable-5": claudePrice(10, 1, 50),
  "claude-opus-5-5": claudePrice(4, 0.2, 20, { fast: true }),
  "claude-opus-5": claudePrice(5, 0.5, 25, { fast: true }),
  "claude-opus-4-8": claudePrice(5, 0.5, 25, { fast: true }),
  "claude-opus-4-7": claudePrice(5, 0.5, 25),
  "claude-opus-4-6": claudePrice(5, 0.5, 25),
  "claude-opus-4-5": claudePrice(5, 0.5, 25, { standardContextLimit: 200_000 }),
  "claude-opus-4-1": claudePrice(15, 1.5, 75, { standardContextLimit: 200_000 }),
  "claude-opus-4": claudePrice(15, 1.5, 75, { standardContextLimit: 200_000 }),
  "claude-sonnet-5-5": claudePrice(2, 0.2, 10),
  "claude-sonnet-5": claudePrice(2, 0.2, 10),
  "claude-sonnet-4-6": claudePrice(3, 0.3, 15),
  "claude-sonnet-4-5": claudePrice(3, 0.3, 15, { standardContextLimit: 200_000 }),
  "claude-sonnet-4": claudePrice(3, 0.3, 15, { standardContextLimit: 200_000 }),
  "claude-haiku-4-5": claudePrice(1, 0.1, 5, { standardContextLimit: 200_000 }),
  "claude-3-5-haiku": claudePrice(0.8, 0.08, 4, { standardContextLimit: 200_000 }),
  "gpt-6-astra": Object.freeze({
    fast: {
      short: { input: 20, cachedInput: 2, cacheWrite: 25, output: 100 },
      long: { input: 40, cachedInput: 4, cacheWrite: 50, output: 150 },
    },
    short: { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 },
    long: { input: 20, cachedInput: 2, cacheWrite: 25, output: 75 },
  }),
  "gpt-6-sol": Object.freeze({
    fast: {
      short: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
      long: { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 30 },
    },
    short: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
    long: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 15 },
  }),
  "gpt-6.1-sol": Object.freeze({
    currency: "USD",
    source: "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
    longContextThreshold: 272_000,
    fast: {
      short: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
      long: { input: 8, cachedInput: 0.4, cacheWrite: 10, output: 30 },
    },
    short: { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 },
    long: { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 15 },
  }),
  "gpt-6-luna": Object.freeze({
    fast: {
      short: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1 },
      long: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.5 },
    },
    short: { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
    long: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 0.75 },
  }),
  "gpt-5.6-sol": Object.freeze({
    fast: {
      short: { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 40 },
      long: { input: 16, cachedInput: 1.6, cacheWrite: 20, output: 60 },
    },
    short: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 },
    long: { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 30 },
  }),
  "gpt-5.6-terra": Object.freeze({
    fast: {
      short: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 24 },
      long: { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 36 },
    },
    short: { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 },
    long: { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 18 },
  }),
  "gpt-5.6-luna": Object.freeze({
    fast: {
      short: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 2.4 },
      long: { input: 0.8, cachedInput: 0.08, cacheWrite: 1, output: 3.6 },
    },
    short: { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 },
    long: { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.8 },
  }),
  // StepFun（人民币，元/百万 tokens；命中 = 缓存命中价，页面未单列缓存写入费）
  "step-5-preview": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.stepfun,
    short: { input: 7, cachedInput: 0.35, cacheWrite: 0, output: 20 },
    long: { input: 7, cachedInput: 0.35, cacheWrite: 0, output: 20 },
  }),
  "step-3.7-flash": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.stepfun,
    short: { input: 1.35, cachedInput: 0.27, cacheWrite: 0, output: 8.1 },
    long: { input: 1.35, cachedInput: 0.27, cacheWrite: 0, output: 8.1 },
  }),
  "step-3.5-flash": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.stepfun,
    short: { input: 0.7, cachedInput: 0.14, cacheWrite: 0, output: 2.1 },
    long: { input: 0.7, cachedInput: 0.14, cacheWrite: 0, output: 2.1 },
  }),
  "step-3.5-flash-2603": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.stepfun,
    short: { input: 0.7, cachedInput: 0.14, cacheWrite: 0, output: 2.1 },
    long: { input: 0.7, cachedInput: 0.14, cacheWrite: 0, output: 2.1 },
  }),
  // 小米 MiMo（人民币；缓存写入限时免费按 0 计，批量推理价未纳入）
  "mimo-v2.6-pro": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.mimo,
    short: { input: 3, cachedInput: 0.025, cacheWrite: 0, output: 6 },
    long: { input: 3, cachedInput: 0.025, cacheWrite: 0, output: 6 },
  }),
  "mimo-v2.6-flash": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.mimo,
    short: { input: 1, cachedInput: 0.02, cacheWrite: 0, output: 2 },
    long: { input: 1, cachedInput: 0.02, cacheWrite: 0, output: 2 },
  }),
  "mimo-v2.6-pro-ultraspeed": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.mimo,
    short: { input: 30, cachedInput: 0.25, cacheWrite: 0, output: 60 },
    long: { input: 30, cachedInput: 0.25, cacheWrite: 0, output: 60 },
  }),
  "mimo-v2.5-pro": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.mimo,
    short: { input: 3, cachedInput: 0.025, cacheWrite: 0, output: 6 },
    long: { input: 3, cachedInput: 0.025, cacheWrite: 0, output: 6 },
  }),
  "mimo-v2.5": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.mimo,
    short: { input: 1, cachedInput: 0.02, cacheWrite: 0, output: 2 },
    long: { input: 1, cachedInput: 0.02, cacheWrite: 0, output: 2 },
  }),
  // DeepSeek（人民币；基准为高峰价，谷时 5 折。高峰 = 北京时间工作日 9:00-12:00、14:00-18:00，节假日未建模按高峰计）
  "deepseek-flash": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.deepseek,
    short: { input: 2, cachedInput: 0.04, cacheWrite: 0, output: 8 },
    long: { input: 2, cachedInput: 0.04, cacheWrite: 0, output: 8 },
    offPeakMultiplier: 0.5,
    peakTimezone: "Asia/Shanghai",
    peakWindows: Object.freeze([
      Object.freeze({
        days: Object.freeze([1, 2, 3, 4, 5]),
        ranges: Object.freeze([Object.freeze(["09:00", "12:00"]), Object.freeze(["14:00", "18:00"])]),
      }),
    ]),
  }),
  "deepseek-v4-pro": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.deepseek,
    short: { input: 9, cachedInput: 0.3, cacheWrite: 0, output: 27 },
    long: { input: 9, cachedInput: 0.3, cacheWrite: 0, output: 27 },
    offPeakMultiplier: 0.5,
    peakTimezone: "Asia/Shanghai",
    peakWindows: Object.freeze([
      Object.freeze({
        days: Object.freeze([1, 2, 3, 4, 5]),
        ranges: Object.freeze([Object.freeze(["09:00", "12:00"]), Object.freeze(["14:00", "18:00"])]),
      }),
    ]),
  }),
  // 月之暗面 Kimi（人民币；kimi-k3 缓存写入默认 5 分钟 TTL 档 20 元，1 小时档为 40 元）
  "kimi-k3": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.kimi,
    short: { input: 20, cachedInput: 2, cacheWrite: 20, output: 100 },
    long: { input: 20, cachedInput: 2, cacheWrite: 20, output: 100 },
  }),
  "kimi-k2.7-code": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.kimi,
    short: { input: 6.5, cachedInput: 1.3, cacheWrite: 0, output: 27 },
    long: { input: 6.5, cachedInput: 1.3, cacheWrite: 0, output: 27 },
  }),
  "kimi-k2.7-code-highspeed": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.kimi,
    short: { input: 13, cachedInput: 2.6, cacheWrite: 0, output: 54 },
    long: { input: 13, cachedInput: 2.6, cacheWrite: 0, output: 54 },
  }),
  "kimi-k2.6": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.kimi,
    short: { input: 6.5, cachedInput: 1.1, cacheWrite: 0, output: 27 },
    long: { input: 6.5, cachedInput: 1.1, cacheWrite: 0, output: 27 },
  }),
  // 智谱 GLM（人民币；缓存写入限时免费按 0 计。glm-4.7 / glm-4.5-air 另有输出长度分档）
  "glm-5.3": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 8, cachedInput: 2, cacheWrite: 0, output: 28 },
    long: { input: 8, cachedInput: 2, cacheWrite: 0, output: 28 },
  }),
  "glm-5.3-flash": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 0.8, cachedInput: 0.23, cacheWrite: 0, output: 2.8 },
    long: { input: 0.8, cachedInput: 0.23, cacheWrite: 0, output: 2.8 },
  }),
  "glm-5.3-flashx": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 2, cachedInput: 0.57, cacheWrite: 0, output: 7 },
    long: { input: 2, cachedInput: 0.57, cacheWrite: 0, output: 7 },
  }),
  "glm-5.2": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 8, cachedInput: 2, cacheWrite: 0, output: 28 },
    long: { input: 8, cachedInput: 2, cacheWrite: 0, output: 28 },
  }),
  "glm-5.1": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    longContextThreshold: 32_000,
    short: { input: 6, cachedInput: 1.3, cacheWrite: 0, output: 24 },
    long: { input: 8, cachedInput: 2, cacheWrite: 0, output: 28 },
  }),
  "glm-5-turbo": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    longContextThreshold: 32_000,
    short: { input: 5, cachedInput: 1.2, cacheWrite: 0, output: 22 },
    long: { input: 7, cachedInput: 1.8, cacheWrite: 0, output: 26 },
  }),
  "glm-5": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    longContextThreshold: 32_000,
    short: { input: 4, cachedInput: 1, cacheWrite: 0, output: 18 },
    long: { input: 6, cachedInput: 1.5, cacheWrite: 0, output: 22 },
  }),
  "glm-4.7": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    longContextThreshold: 32_000,
    outputThreshold: 200,
    short: { input: 2, cachedInput: 0.4, cacheWrite: 0, output: 8 },
    shortLongOutput: { input: 3, cachedInput: 0.6, cacheWrite: 0, output: 14 },
    long: { input: 4, cachedInput: 0.8, cacheWrite: 0, output: 16 },
  }),
  "glm-4.5-air": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    longContextThreshold: 32_000,
    outputThreshold: 200,
    short: { input: 0.8, cachedInput: 0.16, cacheWrite: 0, output: 2 },
    shortLongOutput: { input: 0.8, cachedInput: 0.16, cacheWrite: 0, output: 6 },
    long: { input: 1.2, cachedInput: 0.24, cacheWrite: 0, output: 8 },
  }),
  "glm-4.7-flashx": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 0.5, cachedInput: 0.1, cacheWrite: 0, output: 3 },
    long: { input: 0.5, cachedInput: 0.1, cacheWrite: 0, output: 3 },
  }),
  "glm-4.7-flash": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
    long: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
  }),
  "glm-4-plus": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 5, cachedInput: 2.5, cacheWrite: 0, output: 5 },
    long: { input: 5, cachedInput: 2.5, cacheWrite: 0, output: 5 },
  }),
  "glm-4-air-250414": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 0.5, cachedInput: 0.25, cacheWrite: 0, output: 0.5 },
    long: { input: 0.5, cachedInput: 0.25, cacheWrite: 0, output: 0.5 },
  }),
  "glm-4-airx": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 10, cachedInput: 0, cacheWrite: 0, output: 10 },
    long: { input: 10, cachedInput: 0, cacheWrite: 0, output: 10 },
  }),
  "glm-4-long": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 1, cachedInput: 0.5, cacheWrite: 0, output: 1 },
    long: { input: 1, cachedInput: 0.5, cacheWrite: 0, output: 1 },
  }),
  "glm-4-assistant": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 5, cachedInput: 0, cacheWrite: 0, output: 5 },
    long: { input: 5, cachedInput: 0, cacheWrite: 0, output: 5 },
  }),
  "glm-z1-air": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 0.5, cachedInput: 0, cacheWrite: 0, output: 0.5 },
    long: { input: 0.5, cachedInput: 0, cacheWrite: 0, output: 0.5 },
  }),
  "glm-z1-airx": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 5, cachedInput: 0, cacheWrite: 0, output: 5 },
    long: { input: 5, cachedInput: 0, cacheWrite: 0, output: 5 },
  }),
  "glm-z1-flashx": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 0.1, cachedInput: 0, cacheWrite: 0, output: 0.1 },
    long: { input: 0.1, cachedInput: 0, cacheWrite: 0, output: 0.1 },
  }),
  "glm-z1-flash": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
    long: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
  }),
  "glm-4-flashx-250414": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 0.1, cachedInput: 0.05, cacheWrite: 0, output: 0.1 },
    long: { input: 0.1, cachedInput: 0.05, cacheWrite: 0, output: 0.1 },
  }),
  "glm-4-flash-250414": Object.freeze({
    currency: "CNY",
    source: CNY_PRICING_SOURCES.glm,
    short: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
    long: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
  }),
  // xAI Grok（美元；200K 输入分档，全部 token 按高档计。grok-4.7 另有官方 Fast 价）
  "grok-4.7": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.xai,
    longContextThreshold: 200_000,
    short: { input: 2, cachedInput: 0.5, cacheWrite: 0, output: 6 },
    long: { input: 4, cachedInput: 1, cacheWrite: 0, output: 12 },
    fast: {
      short: { input: 4, cachedInput: 1, cacheWrite: 0, output: 12 },
      long: { input: 6, cachedInput: 1.5, cacheWrite: 0, output: 18 },
    },
  }),
  "grok-4.6": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.xai,
    longContextThreshold: 200_000,
    short: { input: 2, cachedInput: 0.5, cacheWrite: 0, output: 6 },
    long: { input: 4, cachedInput: 1, cacheWrite: 0, output: 12 },
  }),
  "grok-4.5": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.xai,
    longContextThreshold: 200_000,
    short: { input: 2, cachedInput: 0.3, cacheWrite: 0, output: 6 },
    long: { input: 4, cachedInput: 0.6, cacheWrite: 0, output: 12 },
  }),
  "grok-4.3": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.xai,
    longContextThreshold: 200_000,
    short: { input: 1.25, cachedInput: 0.2, cacheWrite: 0, output: 2.5 },
    long: { input: 2.5, cachedInput: 0.4, cacheWrite: 0, output: 5 },
  }),
  "grok-4.20-0309-reasoning": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.xai,
    longContextThreshold: 200_000,
    short: { input: 1.25, cachedInput: 0.2, cacheWrite: 0, output: 2.5 },
    long: { input: 2.5, cachedInput: 0.4, cacheWrite: 0, output: 5 },
  }),
  "grok-4.20-0309-non-reasoning": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.xai,
    longContextThreshold: 200_000,
    short: { input: 1.25, cachedInput: 0.2, cacheWrite: 0, output: 2.5 },
    long: { input: 2.5, cachedInput: 0.4, cacheWrite: 0, output: 5 },
  }),
  "grok-4.20-multi-agent-0309": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.xai,
    longContextThreshold: 200_000,
    short: { input: 1.25, cachedInput: 0.2, cacheWrite: 0, output: 2.5 },
    long: { input: 2.5, cachedInput: 0.4, cacheWrite: 0, output: 5 },
  }),
  "grok-build-0.1": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.xai,
    longContextThreshold: 200_000,
    short: { input: 1, cachedInput: 0.2, cacheWrite: 0, output: 2 },
    long: { input: 2, cachedInput: 0.4, cacheWrite: 0, output: 4 },
  }),
  // QwenCloud（美元；qwen3.7 系列分档。qwen3.7-plus 为当前 8 折促销价；缓存为隐式缓存命中价）
  "qwen3.8-max": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.qwen,
    short: { input: 2, cachedInput: 0.25, cacheWrite: 0, output: 6 },
  }),
  "qwen3.8-flash": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.qwen,
    short: { input: 0.15, cachedInput: 0.016, cacheWrite: 0, output: 0.47 },
  }),
  "qwen3.8-2.4t-a95b": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.qwen,
    short: { input: 2, cachedInput: 0.25, cacheWrite: 0, output: 6 },
  }),
  "qwen3.7-max": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.qwen,
    short: { input: 2.5, cachedInput: 0.5, cacheWrite: 0, output: 7.5 },
  }),
  "qwen3.7-plus": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.qwen,
    longContextThreshold: 256_000,
    short: { input: 0.32, cachedInput: 0.064, cacheWrite: 0, output: 1.28 },
    long: { input: 0.96, cachedInput: 0.192, cacheWrite: 0, output: 3.84 },
  }),
  "qwen3.7-flash": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.qwen,
    longContextThreshold: 32_000,
    short: { input: 0.03, cachedInput: 0.006, cacheWrite: 0, output: 0.13 },
    long: { input: 0.1, cachedInput: 0.02, cacheWrite: 0, output: 0.4 },
  }),
  // QwenCloud 第三方转售（美元；deepseek 系按北京时间 8:00-22:00 高峰、其余 5 折）
  "glm-5.3-prime": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.qwen,
    short: { input: 2.8, cachedInput: 0.56, cacheWrite: 0, output: 8.8 },
  }),
  "deepseek-v4.1-flash": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.qwen,
    short: { input: 0.3, cachedInput: 0.03, cacheWrite: 0, output: 1.2 },
    offPeakMultiplier: 0.5,
    peakTimezone: "Asia/Shanghai",
    peakWindows: Object.freeze([
      Object.freeze({
        days: Object.freeze([1, 2, 3, 4, 5, 6, 7]),
        ranges: Object.freeze([Object.freeze(["08:00", "22:00"])]),
      }),
    ]),
  }),
  "deepseek-v4-flash-0731": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.qwen,
    short: { input: 0.44, cachedInput: 0.044, cacheWrite: 0, output: 1.32 },
    offPeakMultiplier: 0.5,
    peakTimezone: "Asia/Shanghai",
    peakWindows: Object.freeze([
      Object.freeze({
        days: Object.freeze([1, 2, 3, 4, 5, 6, 7]),
        ranges: Object.freeze([Object.freeze(["08:00", "22:00"])]),
      }),
    ]),
  }),
  // Google Gemini（美元；Priority 为官方快速档。缓存写入为按时存储费，按 0 简化）
  "gemini-2.5-pro": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.gemini,
    short: { input: 1.25, cachedInput: 0.125, cacheWrite: 0, output: 10 },
    fast: { short: { input: 2.25, cachedInput: 0.125, cacheWrite: 0, output: 18 } },
  }),
  "gemini-2.5-flash": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.gemini,
    short: { input: 0.3, cachedInput: 0.03, cacheWrite: 0, output: 2.5 },
    fast: { short: { input: 0.54, cachedInput: 0.03, cacheWrite: 0, output: 4.5 } },
  }),
  "gemini-2.5-flash-lite": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.gemini,
    short: { input: 0.1, cachedInput: 0.01, cacheWrite: 0, output: 0.4 },
    fast: { short: { input: 0.18, cachedInput: 0.01, cacheWrite: 0, output: 0.72 } },
  }),
  "gemini-3.8-flash": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.gemini,
    short: { input: 0.75, cachedInput: 0.075, cacheWrite: 0, output: 3.75 },
  }),
  "gemini-3.7-flash": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.gemini,
    short: { input: 0.75, cachedInput: 0.075, cacheWrite: 0, output: 3.75 },
  }),
  "gemini-3.6-flash": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.gemini,
    short: { input: 0.75, cachedInput: 0.075, cacheWrite: 0, output: 3.75 },
  }),
  "gemini-3.5-flash": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.gemini,
    short: { input: 1.5, cachedInput: 0.15, cacheWrite: 0, output: 9 },
  }),
  "gemini-3.5-flash-lite": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.gemini,
    short: { input: 0.3, cachedInput: 0.03, cacheWrite: 0, output: 2.5 },
  }),
  "gemini-3.1-flash-lite": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.gemini,
    short: { input: 0.25, cachedInput: 0.025, cacheWrite: 0, output: 1.5 },
  }),
  "gemini-3.1-pro-preview": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.gemini,
    short: { input: 2, cachedInput: 0.2, cacheWrite: 0, output: 12 },
  }),
  "gemini-3-flash-preview": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.gemini,
    short: { input: 0.5, cachedInput: 0.05, cacheWrite: 0, output: 3 },
  }),
  "gemma-4": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.gemini,
    short: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
  }),
  // MiniMax（美元；M3 为长期五折后价、512K 输入分档，Priority 为官方快速档）
  "minimax-m3": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.minimax,
    longContextThreshold: 512_000,
    short: { input: 0.3, cachedInput: 0.06, cacheWrite: 0, output: 1.2 },
    long: { input: 0.6, cachedInput: 0.12, cacheWrite: 0, output: 2.4 },
    fast: {
      short: { input: 0.45, cachedInput: 0.09, cacheWrite: 0, output: 1.8 },
      long: { input: 0.9, cachedInput: 0.18, cacheWrite: 0, output: 3.6 },
    },
  }),
  "minimax-m2.7": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.minimax,
    short: { input: 0.3, cachedInput: 0.06, cacheWrite: 0.375, output: 1.2 },
  }),
  "minimax-m2.7-highspeed": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.minimax,
    short: { input: 0.6, cachedInput: 0.06, cacheWrite: 0.375, output: 2.4 },
  }),
  "minimax-m2.5": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.minimax,
    short: { input: 0.3, cachedInput: 0.03, cacheWrite: 0.375, output: 1.2 },
  }),
  "minimax-m2.5-highspeed": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.minimax,
    short: { input: 0.6, cachedInput: 0.03, cacheWrite: 0.375, output: 2.4 },
  }),
  "minimax-m2.1": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.minimax,
    short: { input: 0.3, cachedInput: 0.03, cacheWrite: 0.375, output: 1.2 },
  }),
  "minimax-m2.1-highspeed": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.minimax,
    short: { input: 0.6, cachedInput: 0.03, cacheWrite: 0.375, output: 2.4 },
  }),
  "minimax-m2": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.minimax,
    short: { input: 0.3, cachedInput: 0.03, cacheWrite: 0.375, output: 1.2 },
  }),
  // Meta（美元；muse-spark 系列无长上下文加价）
  "muse-spark-1.3": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.meta,
    short: { input: 1.25, cachedInput: 0.15, cacheWrite: 0, output: 4.25 },
  }),
  "muse-spark-1.2": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.meta,
    short: { input: 1.25, cachedInput: 0.15, cacheWrite: 0, output: 4.25 },
  }),
  "muse-spark-1.1": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.meta,
    short: { input: 1.25, cachedInput: 0.15, cacheWrite: 0, output: 4.25 },
  }),
  "muse-spark-1.3-contributor": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.meta,
    short: { input: 0.1, cachedInput: 0.002, cacheWrite: 0, output: 0.2 },
  }),
  "muse-spark-1.2-contributor": Object.freeze({
    currency: "USD",
    source: CNY_PRICING_SOURCES.meta,
    short: { input: 0.1, cachedInput: 0.002, cacheWrite: 0, output: 0.2 },
  }),
});

const RATE_FIELDS = ["input", "cachedInput", "cacheWrite", "output"];
const CODEX_SOURCE_KINDS = new Set(["main", "jetbrains", "extra", "codex"]);

// 名称以 -free 结尾的未收录模型按免费处理：零费率，不参与最低费率兜底。
const ZERO_RATES = Object.freeze({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0 });

// Custom rates reprice all indexed events so the dashboard remains internally
// consistent. The original token counts and recorded price versions are retained.
/** @type {PricingCatalog} */
let activePricing = {
  checkedAt: API_PRICING_CHECKED_AT,
  version: API_PRICING_VERSION,
  usdToCnyRate: DEFAULT_USD_TO_CNY_RATE,
  models: MODEL_PRICES,
};

export const API_TOKEN_PRICES = Object.freeze(
  Object.fromEntries(
    Object.entries(MODEL_PRICES)
      .filter(([, rates]) => (rates.currency || "USD") === "USD")
      .map(([model, rates]) => [model, rates.short]),
  ),
);

export function getPricingCatalog() {
  return {
    checkedAt: activePricing.checkedAt,
    version: activePricing.version,
    usdToCnyRate: activePricing.usdToCnyRate,
    source: API_PRICING_SOURCE,
    models: structuredClone(activePricing.models),
  };
}

export function getDefaultPricingCatalog() {
  return {
    checkedAt: API_PRICING_CHECKED_AT,
    usdToCnyRate: DEFAULT_USD_TO_CNY_RATE,
    models: structuredClone(MODEL_PRICES),
  };
}

/** @returns {TokenRates} */
function validateRates(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid rates for ${label}`);
  /** @type {TokenRates} */
  const rates = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
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
      if (
        !Array.isArray(range) ||
        range.length !== 2 ||
        !/^\d{2}:\d{2}$/.test(range[0]) ||
        !/^\d{2}:\d{2}$/.test(range[1])
      ) {
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
  if (
    typeof checkedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(checkedAt) ||
    Number.isNaN(Date.parse(`${checkedAt}T00:00:00Z`)) ||
    new Date(`${checkedAt}T00:00:00Z`).toISOString().slice(0, 10) !== checkedAt
  ) {
    throw new Error("Pricing date must be a valid YYYY-MM-DD date.");
  }
  const models = value.models;
  if (!models || typeof models !== "object" || Array.isArray(models)) throw new Error("Model prices are required.");
  const usdToCnyRate = value.usdToCnyRate === undefined ? DEFAULT_USD_TO_CNY_RATE : Number(value.usdToCnyRate);
  if (!Number.isFinite(usdToCnyRate) || usdToCnyRate <= 0)
    throw new Error("USD to CNY rate must be a positive number.");
  const keys = Object.keys(models);
  if (
    keys.length < Object.keys(MODEL_PRICES).length ||
    Object.keys(MODEL_PRICES).some((key) => !Object.hasOwn(models, key))
  ) {
    throw new Error("All built-in models must have prices.");
  }
  if (keys.length > MAX_PRICING_MODELS) throw new Error(`Pricing supports at most ${MAX_PRICING_MODELS} models.`);
  /** @type {Record<string, PriceModel>} */
  const normalized = {};
  for (const model of keys.sort()) {
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(model)) throw new Error(`Invalid model name: ${model}`);
    const entry = models[model];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Invalid rates for ${model}`);
    const currency = entry.currency === undefined ? "USD" : entry.currency;
    if (currency !== "USD" && currency !== "CNY") throw new Error(`Invalid currency for ${model}`);
    const short = validateRates(entry.short, `${model} short`);
    const result = { currency, short };
    if (entry.cacheWriteTtl !== undefined) {
      if (entry.cacheWriteTtl !== "5m") throw new Error(`Unsupported cache write TTL for ${model}`);
      result.cacheWriteTtl = entry.cacheWriteTtl;
    }
    if (entry.standardContextLimit !== undefined) {
      if (!Number.isInteger(entry.standardContextLimit) || entry.standardContextLimit <= 0)
        throw new Error(`Invalid standardContextLimit for ${model}`);
      result.standardContextLimit = entry.standardContextLimit;
    }
    result.long = entry.long === undefined ? { ...short } : validateRates(entry.long, `${model} long`);
    if (entry.shortLongOutput !== undefined) {
      result.shortLongOutput = validateRates(entry.shortLongOutput, `${model} shortLongOutput`);
    }
    if (entry.fast !== undefined) {
      const fast = entry.fast;
      if (!fast || typeof fast !== "object" || Array.isArray(fast)) throw new Error(`Invalid fast rates for ${model}`);
      const fastRates = { short: validateRates(fast.short, `${model} fast short`) };
      if (fast.long !== undefined) fastRates.long = validateRates(fast.long, `${model} fast long`);
      if (fast.shortLongOutput !== undefined)
        fastRates.shortLongOutput = validateRates(fast.shortLongOutput, `${model} fast shortLongOutput`);
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
      if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1)
        throw new Error(`Invalid offPeakMultiplier for ${model}`);
      result.offPeakMultiplier = multiplier;
    }
    if (entry.peakWindows !== undefined) {
      result.peakWindows = validatePeakWindows(entry.peakWindows, model);
      result.peakTimezone =
        typeof entry.peakTimezone === "string" && entry.peakTimezone ? entry.peakTimezone : "Asia/Shanghai";
    }
    if (entry.source !== undefined) {
      if (typeof entry.source !== "string" || !/^https?:\/\//.test(entry.source))
        throw new Error(`Invalid source for ${model}`);
      result.source = entry.source;
    }
    normalized[model] = result;
  }
  return { checkedAt, usdToCnyRate, models: normalized };
}

export function setPricingCatalog(value) {
  const catalog = validatePricingCatalog(value);
  const hash = createHash("sha256")
    .update(API_PRICING_VERSION)
    .update(JSON.stringify(catalog))
    .digest("hex")
    .slice(0, 12);
  activePricing = { ...catalog, version: `${catalog.checkedAt}-${hash}` };
  return getPricingCatalog();
}

// 旧版本保存的价目缺少新增的人民币模型/快速模式等字段时：
// 用户改过的费率优先保留，结构性字段缺失则从内置官方价目补齐，而不是被旧文件顶掉。
function fillMissingStructure(saved, builtIn) {
  const merged = { ...saved };
  for (const field of [
    "longContextThreshold",
    "outputThreshold",
    "offPeakMultiplier",
    "peakTimezone",
    "source",
    "cacheWriteTtl",
    "standardContextLimit",
  ]) {
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
    models[model] = savedModels[model] ? fillMissingStructure(savedModels[model], builtIn) : structuredClone(builtIn);
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
  activePricing = {
    checkedAt: API_PRICING_CHECKED_AT,
    version: API_PRICING_VERSION,
    usdToCnyRate: DEFAULT_USD_TO_CNY_RATE,
    models: MODEL_PRICES,
  };
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
  const has = (key, bit) => (Number.isInteger(event.detailMask) ? Boolean(mask & bit) : Object.hasOwn(usage, key));
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
  const resolved = resolvePricingModel(model, activePricing.models);
  if (resolved.matchType === "free") return { name: model, key: "", free: true };
  return { name: model, key: resolved.catalogKey || "" };
}

function normalizeServiceTier(value) {
  const tier = String(value || "")
    .trim()
    .toLocaleLowerCase();
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

// 峰谷 formatter 的构造只取决于时区，按实际生效的时区字符串复用即可。
// 键用 timezone 而不是价目条目对象：validatePricingCatalog 每次重建 entry，
// 缓存条目对象会在换价目/重置价目时全冷，而时区字符串跨价目替换仍然有效。
// 非法时区在构造处同步抛 RangeError；本表只记录构造成功的结果，失败不缓存、也不回落默认时区。
const PEAK_TIME_FORMATTERS = new Map();

function peakTimeFormatter(timeZone) {
  const cached = PEAK_TIME_FORMATTERS.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  PEAK_TIME_FORMATTERS.set(timeZone, formatter);
  return formatter;
}

export function isPeakPricingTime(entry, timestampMs) {
  if (!entry?.offPeakMultiplier || !Array.isArray(entry.peakWindows)) return true;
  if (!Number.isFinite(timestampMs)) return true;
  const { weekdayIndex, minutes } = peakLocalTuple(entry.peakTimezone || "Asia/Shanghai", timestampMs);
  if (weekdayIndex < 0 || !Number.isFinite(minutes)) return true;
  return peakWindowsHit(entry, weekdayIndex, minutes);
}

/**
 * W4-b1 / D4：**峰谷窗口的预解析表**。
 *
 * 为什么：`peakWindowsHit` 原本对**每个事件**都跑 `timeOfDayMinutes(range[0]/range[1])`（两次正则解析），
 * 实测每次 ~0.6 µs —— 在 37,964 行的全历史扫描里就是 ~20-45 ms 的纯重复劳动。窗口数组在**一次价目
 * 版本内是不变的**，所以按数组身份（`WeakMap`）预解析一次：`days` → `Set`，`ranges` → `[start,end]`。
 *
 * 语义与改动前**逐字节一致**：`start === null || end === null` 的非法区间**仍然不命中**；`days` 缺失
 * 视作空；`weekdayIndex === 0 → 7`（ISO，周日=7）的换算保留在 `peakWindowsHit` 里。
 * `WeakMap` 的键是价目目录里的数组对象 ⇒ 目录被替换后旧条目自然被 GC，不会跨版本泄漏。
 */
const PEAK_WINDOW_PLANS = new WeakMap();

function peakWindowPlan(peakWindows) {
  const cached = PEAK_WINDOW_PLANS.get(peakWindows);
  if (cached) return cached;
  const plan = peakWindows.map((window) => ({
    days: new Set(window.days || []),
    ranges: (window.ranges || []).map((range) => [timeOfDayMinutes(range[0]), timeOfDayMinutes(range[1])]),
  }));
  PEAK_WINDOW_PLANS.set(peakWindows, plan);
  return plan;
}

/** 峰谷判定的**最后一步**（与改动前同语义）：窗口命中与否只取决于 (星期, 分钟)。 */
function peakWindowsHit(entry, weekdayIndex, minutes) {
  const plan = peakWindowPlan(entry.peakWindows);
  const isoWeekday = weekdayIndex === 0 ? 7 : weekdayIndex;
  for (const window of plan) {
    if (!window.days.has(isoWeekday)) continue;
    for (const range of window.ranges) {
      const [start, end] = range;
      if (start !== null && end !== null && minutes >= start && minutes < end) return true;
    }
  }
  return false;
}

/**
 * W4-b1 / D4：与改动前**等价的朴素实现**，只作等价性判据（不进产品路径）。
 * @param {any} entry
 * @param {number} weekdayIndex
 * @param {number} minutes
 */
function peakWindowsHitNaive(entry, weekdayIndex, minutes) {
  return entry.peakWindows.some(
    (window) =>
      (window.days || []).includes(weekdayIndex === 0 ? 7 : weekdayIndex) &&
      (window.ranges || []).some((range) => {
        const start = timeOfDayMinutes(range[0]);
        const end = timeOfDayMinutes(range[1]);
        return start !== null && end !== null && minutes >= start && minutes < end;
      }),
  );
}

/**
 * W4-b1 / D4：**改动前**的逐事件 ICU 实现，保留为等价性判据（只被测试引用，不进产品路径）。
 * @param {any} entry
 * @param {number} timestampMs
 */
export function isPeakPricingTimeExact(entry, timestampMs) {
  if (!entry?.offPeakMultiplier || !Array.isArray(entry.peakWindows)) return true;
  if (!Number.isFinite(timestampMs)) return true;
  const { weekdayIndex, minutes } = peakLocalTupleExact(entry.peakTimezone || "Asia/Shanghai", timestampMs);
  if (weekdayIndex < 0 || !Number.isFinite(minutes)) return true;
  return peakWindowsHitNaive(entry, weekdayIndex, minutes);
}

// ── W4-b1 / D4：本地时区格式化的**复用**（R3："逐事件一次 ICU"） ─────────────────────────────────
//
// `peakTimeFormatter` 本就按**时区**复用 formatter；这里再把"瞬时 → 本地 (星期, 分钟)"从
// **逐事件一次 `formatToParts`** 压到**每个 UTC 日两次探针**：
//   * 一个 UTC 日内的时区偏移量是常量（时区库的偏移量一年至多变两次，从不在同一个 UTC 日内变两次），
//     ⇒ 之后用 `ts + 偏移量` 走 **UTC 取数**（纯整数运算，无 ICU）；
//   * **自证式护栏**：候选偏移量必须 ① 在该 UTC 日 00:00 与 23:59 两点相等，且 ② 用算术得到的
//     (星期, 分钟) 与**改动前实现**在这两点上**逐字段相同**；否则该日整体回退到逐事件 ICU
//     （与改动前逐字节同语义）。任何 ICU 怪异取值（例如某些版本把午夜格式化成 "24"）都会让自证
//     失败 ⇒ 自动回退，绝不静默改变峰谷判定。判据由 `test/w4-event-cost-memo.test.js` 逐日抽样复核。
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;
const PEAK_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** UTC 日 → 偏移量（分钟）；`null` = 该日自证失败 ⇒ 逐事件 ICU。 */
const PEAK_DAY_OFFSETS = new Map();
/** 条目 ~50 B；上限只为"长时间运行也不无界"（纯函数表，清空只损失速度）。 */
const PEAK_DAY_OFFSET_LIMIT = 4_096;

function peakLocalTupleExact(timeZone, timestampMs) {
  const formatter = peakTimeFormatter(timeZone);
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestampMs)).map((part) => [part.type, part.value]),
  );
  return {
    weekdayIndex: PEAK_WEEKDAYS.indexOf(parts.weekday),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function peakLocalTupleFromOffset(offsetMinutes, timestampMs) {
  // 纯整数运算（不分配 `Date`、不调 ICU）：`ts + 偏移量` 后的 UTC 日序与日内分钟。
  // 1970-01-01 是**星期四** ⇒ 日序 0 对应 `weekdayIndex = 4`（与 `getUTCDay()` 同口径）。
  const local = timestampMs + offsetMinutes * MS_PER_MINUTE;
  const dayIndex = Math.floor(local / MS_PER_DAY);
  return {
    weekdayIndex: (((dayIndex + 4) % 7) + 7) % 7,
    minutes: Math.floor((local - dayIndex * MS_PER_DAY) / MS_PER_MINUTE),
  };
}

/** 该瞬时在 `timeZone` 的期望偏移量（分钟）= 本地墙钟 − UTC（分钟精度）。
 *
 * 用**独立的** formatter（含年月日）：`peakTimeFormatter` 只请求了 `weekday/hour/minute`，拿不到
 * 年月日 ⇒ 无法还原"本地墙钟当 UTC 看"的整数。独立 formatter 也保证**改动前的判定路径**逐字节不变。
 * 每个 UTC 日只用它两次（00:00 / 23:59 探针）。
 */
const PEAK_OFFSET_FORMATTERS = new Map();

function peakOffsetFormatter(timeZone) {
  const cached = PEAK_OFFSET_FORMATTERS.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  PEAK_OFFSET_FORMATTERS.set(timeZone, formatter);
  return formatter;
}

function peakOffsetMinutes(timeZone, timestampMs) {
  const formatter = peakOffsetFormatter(timeZone);
  const parts = {};
  for (const part of formatter.formatToParts(new Date(timestampMs))) parts[part.type] = part.value;
  const rawHour = Number(parts.hour);
  const dayShift = rawHour >= 24 ? 1 : 0;
  const wall = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day) + dayShift,
    rawHour % 24,
    Number(parts.minute),
  );
  return Math.round((wall - Math.floor(timestampMs / MS_PER_MINUTE) * MS_PER_MINUTE) / MS_PER_MINUTE);
}

function peakDayOffset(timeZone, utcDay) {
  const key = `${timeZone}\u0000${utcDay}`;
  const cached = PEAK_DAY_OFFSETS.get(key);
  if (cached !== undefined) return cached;
  const startMs = utcDay * MS_PER_DAY;
  const endMs = startMs + MS_PER_DAY - MS_PER_MINUTE;
  const candidate = peakOffsetMinutes(timeZone, startMs);
  const sameTuple = (left, right) => left.weekdayIndex === right.weekdayIndex && left.minutes === right.minutes;
  const constant =
    peakOffsetMinutes(timeZone, endMs) === candidate &&
    sameTuple(peakLocalTupleFromOffset(candidate, startMs), peakLocalTupleExact(timeZone, startMs)) &&
    sameTuple(peakLocalTupleFromOffset(candidate, endMs), peakLocalTupleExact(timeZone, endMs));
  const offset = constant ? candidate : null;
  if (PEAK_DAY_OFFSETS.size >= PEAK_DAY_OFFSET_LIMIT) PEAK_DAY_OFFSETS.clear();
  PEAK_DAY_OFFSETS.set(key, offset);
  return offset;
}

/** 本地 (星期, 分钟)：多数 UTC 日走算术快路，自证失败的日子逐事件 ICU。 */
function peakLocalTuple(timeZone, timestampMs) {
  const offset = peakDayOffset(timeZone, Math.floor(timestampMs / MS_PER_DAY));
  return offset === null ? peakLocalTupleExact(timeZone, timestampMs) : peakLocalTupleFromOffset(offset, timestampMs);
}

function contextTierFor(entry, event, usage, modelKey) {
  if (Number.isInteger(entry?.longContextThreshold)) {
    if (modelKey === "gpt-6.1-sol") {
      const requestInput = finiteNonNegative(event.requestInputTokens);
      if (requestInput !== null && requestInput > 0)
        return requestInput > entry.longContextThreshold ? "long" : "short";
      return event.contextLevel === "long" ? "long" : event.contextLevel === "short" ? "short" : "unknown";
    }
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
  // 价目表里没有的模型只能按渠道兜底。ZCode 与 DSH 都跑人民币模型，
  // 漏掉 dsh 会把 DSH 的未收录模型按美元计价。
  const channel = String(event.channel || event.source || "").toLocaleLowerCase();
  return channel.startsWith("zcode") || channel.startsWith("dsh") ? "CNY" : "USD";
}

function minimumRatesFor(modelKey, contextLevel, currency) {
  const catalogs = modelKey
    ? [activePricing.models[modelKey]]
    : Object.entries(activePricing.models)
        .filter(([model, entry]) => !isCodexAutoReview(model) && (entry.currency || "USD") === currency)
        .map(([, entry]) => entry);
  const contexts = contextLevel === "unknown" ? ["short", "long"] : [contextLevel];
  const candidates = catalogs.flatMap((catalog) => contexts.map((context) => catalog?.[context]).filter(Boolean));
  return minimumRateSets(candidates);
}

function minimumCategory(rates, categories) {
  return categories.reduce((lowest, category) => (rates[category] < rates[lowest] ? category : lowest), categories[0]);
}

function estimateEventCost(event = {}) {
  const model = normalizeModel(event.model);
  const usage = usageFields(event);
  const total = usage.total || (usage.input || 0) + (usage.output || 0);
  const version = activePricing.version;
  const entry = model.key ? activePricing.models[model.key] : null;
  const currency = currencyForEvent(model, event);
  const contextLevel = contextTierFor(entry, event, usage, model.key);
  // Product policy changes the price tier, not the recorded request context.
  const codexShortContext = model.key === "gpt-6.1-sol" && CODEX_SOURCE_KINDS.has(event.sourceKind);
  const serviceTier = normalizeServiceTier(event.serviceTier ?? event.service_tier);
  // A policy exemption needs no token split, context tier, or fallback price.
  if (isCodexAutoReview(model.name)) {
    return {
      model: model.name,
      currency,
      priceVersion: version,
      priceSource: "https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan",
      serviceTier,
      contextLevel,
      inputUsd: 0,
      cachedInputUsd: 0,
      cacheWriteInputUsd: 0,
      outputUsd: 0,
      totalUsd: 0,
      pricedTokens: total,
      unpricedTokens: 0,
      minimumEstimatedTokens: 0,
      minimumRateModels: [],
      unpricedModels: [],
      unpricedReasons: [],
      serviceTierUnknownTokens: 0,
      contextUnknownTokens: 0,
      cacheWriteUnknownTokens: 0,
      pricingStatus: "estimated",
    };
  }
  // Claude Fast capability is model-specific; unknown Claude IDs also keep
  // an explicit Standard scenario instead of inheriting the generic 2x rule.
  const useFastRates = serviceTier === "fast" && Boolean(entry?.fast);
  const claude = entry?.cacheWriteTtl === "5m" || /^(?:anthropic[/.])?claude-/i.test(model.name);
  const claudeCacheWrite = entry?.cacheWriteTtl === "5m";
  const multiplier = serviceTier === "fast" && !useFastRates && !claude ? 2 : 1;
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
    ? minimumRateSets(rateSetsFor(rateEntry, codexShortContext ? "short" : contextLevel, usage))
    : minimumRatesFor("", contextLevel, currency);
  // 免费模型不参与最低费率兜底：费率全零，金额恒为 0。
  if (model.free) rates = ZERO_RATES;
  if (rates && offPeakMultiplier !== 1) {
    rates = Object.fromEntries(RATE_FIELDS.map((category) => [category, rates[category] * offPeakMultiplier]));
  }
  const minimumModelRate = !model.key && !model.free;
  const cacheWriteTokens = finiteNonNegative(event.cacheWriteTokens);
  const cacheWriteKnown =
    event.cacheWriteKnown === true || (Number.isInteger(event.detailMask) && Boolean(event.detailMask & 32));
  const knownOrInferredInput = usage.inputKnown
    ? usage.input
    : usage.outputKnown
      ? Math.max(0, total - usage.output)
      : null;
  const cacheWriteUnknownTokens =
    !cacheWriteKnown || cacheWriteTokens === null
      ? knownOrInferredInput === null
        ? 0
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
  const unsupportedWriteTtl = claudeCacheWrite && event.cacheWriteTtl !== undefined && event.cacheWriteTtl !== "5m";
  if (claudeCacheWrite && cacheWriteTokens > 0 && event.cacheWriteTtl !== "5m") {
    reasons.push(unsupportedWriteTtl ? "cache-write-ttl-unsupported" : "cache-write-ttl-unknown-5m-scenario");
  }
  if (claude && serviceTier === "fast" && !useFastRates) reasons.push("fast-pricing-unavailable-standard-scenario");
  if (
    entry?.standardContextLimit &&
    (finiteNonNegative(event.requestInputTokens) || usage.input || 0) > entry.standardContextLimit
  )
    reasons.push("legacy-context-pricing-unverified-standard-scenario");

  if (!rates) {
    return {
      model: model.name,
      currency,
      priceVersion: version,
      priceSource: entry?.source || "",
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
    if (category === "cacheWrite" && unsupportedWriteTtl) {
      unpricedTokens += tokens;
      return;
    }
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
  const countsInconsistent =
    usage.inconsistent ||
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

    const remainder = Math.max(0, total - pricedTokens - unpricedTokens);
    if (usage.inputKnown && !usage.outputKnown) addCost(remainder, "output", true);
    else if (!usage.inputKnown && usage.outputKnown) addMinimum(remainder, ["input", "cachedInput", "cacheWrite"]);
    else addMinimum(remainder, allCategories);
  }

  if (minimumModelRate) {
    reasons.push("unknown-model-price-minimum-scenario");
    minimumEstimatedTokens = pricedTokens;
  }
  const serviceTierUnknownTokens = serviceTier === "unknown" ? pricedTokens : 0;
  const contextUnknownTokens = contextLevel === "unknown" && !codexShortContext ? pricedTokens : 0;
  if (serviceTier === "unknown") reasons.push("service-tier-unknown-standard-scenario");
  if (contextLevel === "unknown" && !codexShortContext) reasons.push("request-context-unknown-minimum-scenario");
  if (entry && !peak) reasons.push("off-peak-pricing-applied");
  const totalUsd = inputUsd + cachedInputUsd + cacheWriteInputUsd + outputUsd;
  return {
    model: model.name,
    currency,
    priceVersion: version,
    priceSource: entry?.source || "",
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
    unpricedModels: unpricedTokens > 0 ? [model.name] : [],
    unpricedReasons: [...new Set(reasons)],
    serviceTierUnknownTokens,
    contextUnknownTokens,
    cacheWriteUnknownTokens,
    pricingStatus: unpricedTokens > 0 ? "unpriced" : minimumEstimatedTokens > 0 ? "minimum-estimate" : "estimated",
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
      "inputUsd",
      "cachedInputUsd",
      "cacheWriteInputUsd",
      "outputUsd",
      "cacheRateInput",
      "cacheRateCached",
      "pricedTokens",
      "unpricedTokens",
      "minimumEstimatedTokens",
      "serviceTierUnknownTokens",
      "contextUnknownTokens",
      "cacheWriteUnknownTokens",
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
      priceSource: priceSources.size === 1 ? [...priceSources][0] : "",
    };
  }

  return { add, result };
}

export function createCostEstimateAccumulator(options = {}) {
  return createCostSummaryState(options);
}

/** @param {Iterable<any>} items */
function summarizeCostItems(items = [], options = {}) {
  const summary = createCostSummaryState(options);
  // W4-b1 / D1：允许注入"逐事件计价"实现（默认就是 `estimateEventCost`）。注入点只改**谁去算**，
  // 不改 `add()` 的累加语义 —— 传 `undefined` 时 `add()` 仍走它自己的默认参数。
  const priceEvent = options.estimateEventCost || null;
  for (const item of items) {
    if (priceEvent) summary.add(item, priceEvent(item));
    else summary.add(item);
  }
  return summary.result();
}

function modelNameIsKnown(value) {
  return Boolean(value) && value.toLocaleLowerCase() !== "unknown model";
}

/** @param {Iterable<any>} events */
export function estimateCostForEvents(events = [], options = {}) {
  return summarizeCostItems(events, options);
}

// ── W4-b1 / D1：有界的"内容键 → 派生值"memo（通用原语 + 事件计价实例） ─────────────────────────
//
// 为什么要有通用原语：D1（事件级计价 memo）是 W4-b1 的交付；D2（规范化时间线分桶）与
// D3（排名扫描）在 **W4-b2**，它们需要同一套"有界 + 轮次语义 + 显式失效"的护栏（键函数不同）。
// 所以这里把护栏做成 `createBoundedKeyMemo`，`createEventCostMemo` 只是它的一个实例 —— 接缝在此。

/** memo 的**方法版本**：键的形状或语义一旦变化必须改这个串（沿用 C3 投影缓存的惯例）。 */
export const BOUNDED_KEY_MEMO_METHOD_VERSION = "w4-bounded-key-memo-v1";

/** D1：事件计价 memo 的**默认**字节预算（与 C3 投影缓存同为 64 MiB）。 */
export const DEFAULT_EVENT_COST_MEMO_BYTES = 64 * 1024 * 1024;

/** D1：**单轮内**的硬上限（规格 `:159` 的"首轮上限 192 MiB"）。轮末回落 `maxBytes`。 */
export const DEFAULT_EVENT_COST_MEMO_HARD_BYTES = 192 * 1024 * 1024;

/** 条目数上限：防止"每个条目都极小"时 `Map` 自身的开销无界增长。 */
export const DEFAULT_EVENT_COST_MEMO_MAX_ENTRIES = 262_144;

/**
 * 计费用的**字节估计**：`JSON.stringify(value)` 的 UTF-16 码元长度。
 *
 * 与 C3 `projectionByteEstimate`（`perf-sources/codex-thread.js:307`）**同一口径**，
 * 便于两处预算互相比较；它**不是**常驻堆的字节数（真实堆更大，容量裁定的口径见报告 §容量）。
 */
function valueByteEstimate(value) {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * 有界的**内容键 → 派生值** memo。语义（全部可测）：
 *   * 键 → 值：同一个键**只算一次**，直到被失效；
 *   * **有界**：`bytes > maxBytes`（轮外）或 `> hardMaxBytes`（轮内）时按键的**插入顺序**逐出最旧
 *     条目（FIFO/LRU-by-insertion，与 C3 投影缓存同型）。逐出**只影响成本**，不影响正确性；
 *   * **轮次**：`beginRound()`/`endRound()` 期间放宽到 `hardMaxBytes`（一轮内不要把刚算出来的东西
 *     立刻逐出），轮末收敛回 `maxBytes`；
 *   * **失效**：`clear(reason)` 由调用方在"输入世代"变化时显式调用（本卡：`storeRevision` 前进）；
 *     键里已经包含"输入内容 + 价目版本"，所以失效**只影响内存**，不会造成陈旧命中。
 *
 * @param {{ keyOf: (input: any) => string, maxBytes?: number, hardMaxBytes?: number, maxEntries?: number,
 *   valueBytes?: (value: any) => number, methodVersion?: string }} options
 */
export function createBoundedKeyMemo({
  keyOf,
  maxBytes = DEFAULT_EVENT_COST_MEMO_BYTES,
  hardMaxBytes = DEFAULT_EVENT_COST_MEMO_HARD_BYTES,
  maxEntries = DEFAULT_EVENT_COST_MEMO_MAX_ENTRIES,
  valueBytes = valueByteEstimate,
  methodVersion = BOUNDED_KEY_MEMO_METHOD_VERSION,
}) {
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : Number.POSITIVE_INFINITY;
  const hard = Number.isFinite(hardMaxBytes) && hardMaxBytes > Math.max(0, limit) ? Math.floor(hardMaxBytes) : limit;
  const entryLimit = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : Number.POSITIVE_INFINITY;
  /** @type {Map<string, { value: any, bytes: number }>} */
  const entries = new Map();
  let bytes = 0;
  let roundDepth = 0;
  const stats = {
    methodVersion,
    hits: 0,
    misses: 0,
    evictions: 0,
    clears: 0,
    lastClearReason: "",
    peakBytes: 0,
    peakSize: 0,
    entries: 0,
    bytes: 0,
    maxBytes: limit,
    hardMaxBytes: hard,
  };

  const evictTo = (target) => {
    while (bytes > target && entries.size > 0) {
      const oldest = entries.keys().next().value;
      const evicted = entries.get(oldest);
      entries.delete(oldest);
      bytes -= evicted?.bytes ?? 0;
      stats.evictions += 1;
    }
  };

  return {
    methodVersion,
    /** 读/写：命中直接返回；未命中调用 `compute` 并记入。 */
    get(input, compute) {
      const key = keyOf(input);
      const found = entries.get(key);
      if (found !== undefined) {
        stats.hits += 1;
        return found.value;
      }
      stats.misses += 1;
      const value = compute(input);
      const size = key.length + (valueBytes(value) || 0);
      entries.set(key, { value, bytes: size });
      bytes += size;
      if (bytes > stats.peakBytes) stats.peakBytes = bytes;
      if (entries.size > stats.peakSize) stats.peakSize = entries.size;
      evictTo(roundDepth > 0 ? hard : limit);
      while (entries.size > entryLimit) {
        const oldest = entries.keys().next().value;
        const evicted = entries.get(oldest);
        entries.delete(oldest);
        bytes -= evicted?.bytes ?? 0;
        stats.evictions += 1;
      }
      return value;
    },
    has(input) {
      return entries.has(keyOf(input));
    },
    beginRound() {
      roundDepth += 1;
    },
    endRound() {
      roundDepth = Math.max(0, roundDepth - 1);
      if (roundDepth === 0) evictTo(limit);
    },
    clear(reason = "") {
      entries.clear();
      bytes = 0;
      stats.clears += 1;
      stats.lastClearReason = String(reason);
    },
    stats() {
      stats.entries = entries.size;
      stats.bytes = bytes;
      return { ...stats };
    },
    size() {
      return entries.size;
    },
    retainedBytes() {
      return bytes;
    },
  };
}

/**
 * D1 的**键**：把 `estimateEventCost` 读到的**每一个**输入编成一条字符串。
 *
 * 完备性论证（逐条对应 `pricing.js` 的实际读取点）：
 *   * `activePricing.version`（=`checkedAt`+目录内容哈希）—— 覆盖**生效价目**（含 `models` 增删改）；
 *   * `event.model` —— `normalizeModel`；
 *   * `event.sourceKind` —— Codex / Work 的 GPT-6.1 Sol 上下文计费规则；
 *   * `event.channel`/`event.source` —— **仅当模型不在价目目录里**时用于币种兜底（`currencyForEvent`）；
 *   * `event.serviceTier`/`service_tier` —— `normalizeServiceTier`；
 *   * `event.cacheWriteTokens`/`cacheWriteKnown`/`detailMask`(bit32)/`cacheWriteTtl`、`event.requestInputTokens`
 *     —— 缓存写与长上下文档；
 *   * `event.contextLevel` —— 上下文档；
 *   * `event.timestamp`/`timestampMs`/`timestamp_ms` —— `isPeakPricingTime` 的峰谷判定；
 *   * `event.total`/`usage`（含 **属性是否 own**）与 5 个用量数 —— `usageFields`（`has()` 走 `detailMask`
 *     或 `Object.hasOwn`，所以 **null / undefined / 不存在**三态必须分开编码）。
 * 任何一条不同 ⇒ 键不同（保守：**多**区分只会降低命中率，不会产生错误命中）。
 */
export function eventCostMemoKey(event = {}) {
  const enc = (value) => {
    if (value === undefined) return "u";
    if (value === null) return "z";
    if (typeof value === "string") return `s:${value}`;
    if (value instanceof Date) return `d:${Number(value)}`;
    const number = Number(value);
    return Number.isFinite(number) ? `n:${number}` : `o:${String(value)}`;
  };
  const usage = event.total || event.usage || event;
  const source = event.total ? 1 : event.usage ? 2 : 0;
  const own = (key) => (Object.hasOwn(usage, key) ? 1 : 0);
  const mask = Number.isInteger(event.detailMask) ? `i:${event.detailMask}` : enc(event.detailMask);
  return [
    activePricing.version,
    enc(event.model),
    enc(event.sourceKind),
    enc(event.channel ?? event.source),
    enc(event.serviceTier ?? event.service_tier),
    `s${source}`,
    enc(event.cacheWriteTokens),
    event.cacheWriteKnown === true ? "1" : "0",
    mask,
    enc(event.cacheWriteTtl),
    enc(event.requestInputTokens),
    enc(event.contextLevel),
    enc(event.timestamp ?? event.timestampMs ?? event.timestamp_ms),
    `${own("total")}${own("input")}${own("cached")}${own("output")}`,
    enc(usage.total),
    enc(usage.input),
    enc(usage.cached),
    enc(usage.output),
    enc(usage.reasoning),
  ].join("\u0000");
}

/**
 * D1：**事件级计价 memo**（跨形状共享）。
 *
 * 为什么能跨形状共享：键**只**含"事件内容 + 生效价目"，**不含** `preset`/`bucket`/`calendarZone`/
 * `excludeHomes`/`now` —— 那些是**范围**参数，而金额是**逐事件**的函数。所以同一份事件在
 * `today` 与 `all` 两个形状里只算一次（这正是 R1 "命中也在付" 的止血点）。
 *
 * @param {{ maxBytes?: number, hardMaxBytes?: number, maxEntries?: number, estimate?: (event: any) => any }} [options]
 */
export function createEventCostMemo({
  maxBytes = DEFAULT_EVENT_COST_MEMO_BYTES,
  hardMaxBytes = DEFAULT_EVENT_COST_MEMO_HARD_BYTES,
  maxEntries = DEFAULT_EVENT_COST_MEMO_MAX_ENTRIES,
  estimate = estimateEventCost,
} = {}) {
  const memo = createBoundedKeyMemo({ keyOf: eventCostMemoKey, maxBytes, hardMaxBytes, maxEntries });
  return {
    ...memo,
    /** @param {any} event */
    estimate(event) {
      return memo.get(event, estimate);
    },
  };
}

export function estimateCostForGroups(groups = [], options = {}) {
  return summarizeCostItems(
    groups.map((group) => ({
      ...group,
      total: {
        total: group.total,
        input: group.input,
        cached: group.cached,
        output: group.output,
      },
    })),
    options,
  );
}

export { estimateEventCost };
