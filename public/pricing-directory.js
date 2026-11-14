import { MODEL_RELEASE_DATES } from "./pricing-release-dates.js";
import { canonicalModelName } from "./pricing-models.js";

export const PRICING_PROVIDERS = [
  { id: "openai", name: "OpenAI", models: /^(gpt-|chatgpt-|codex-|o[134](?:-|$))/i },
  { id: "anthropic", name: "Anthropic", models: /^claude-/i },
  { id: "google", name: "Google", models: /^(gemini-|gemma-)/i },
  { id: "deepseek", name: "深度求索", models: /^deepseek-/i },
  { id: "alibaba", name: "阿里巴巴", models: /^qwen/i },
  { id: "moonshotai", name: "月之暗面", models: /^(kimi-|moonshot-)/i },
  { id: "zai", name: "智谱", models: /^glm-/i },
  { id: "minimax", name: "稀宇科技", models: /^minimax-/i },
  { id: "xai", name: "xAI", models: /^grok-/i },
  { id: "xiaomi", name: "小米", models: /^mimo-/i },
  { id: "stepfun", name: "阶跃星辰", models: /^step-/i },
  { id: "meta", name: "Meta", models: /^(muse-|llama-)/i },
  { id: "tencent", name: "腾讯", models: /^(hunyuan|hy[234])/i },
  {
    id: "mistral",
    name: "Mistral AI",
    models: /^(mistral|mixtral|magistral|ministral|devstral|codestral|pixtral|voxtral)/i,
  },
  { id: "cohere", name: "Cohere", models: /^command-/i },
  { id: "baidu", name: "百度", models: /^ernie-/i },
  { id: "meituan", name: "美团", models: /^longcat-/i },
  { id: "inception", name: "Inception", models: /^mercury/i },
  { id: "other", name: "其他", models: /./ },
];

export function pricingProvider(model) {
  return PRICING_PROVIDERS.find((provider) => provider.models.test(model)) || PRICING_PROVIDERS.at(-1);
}

export function modelReleaseDatesFromCatalog(payload) {
  const dates = {};
  for (const provider of PRICING_PROVIDERS) {
    if (provider.id === "other") continue;
    for (const [model, entry] of Object.entries(payload?.[provider.id]?.models || {})) {
      const date = entry?.release_date;
      if (!provider.models.test(model) || typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const time = Date.parse(`${date}T00:00:00Z`);
      if (Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date) {
        const key = canonicalModelName(model, {})
          .toLowerCase()
          .replace(/^(claude-(?:opus|sonnet|haiku|fable)-\d+)\.(\d+)/, "$1-$2");
        dates[key] = date;
      }
    }
  }
  return dates;
}

export function pricingReleaseDate(model, dates = {}) {
  const key = canonicalModelName(model, {})
    .toLowerCase()
    .replace(/^(claude-(?:opus|sonnet|haiku|fable)-\d+)\.(\d+)/, "$1-$2");
  return dates[key] || MODEL_RELEASE_DATES[key] || "";
}
