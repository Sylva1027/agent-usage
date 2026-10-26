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
