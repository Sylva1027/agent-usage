const PRICING_MODEL_ALIASES = Object.freeze({
  "gpt-5.6": "gpt-5.6-sol",
  "gpt-daybreak-blue-latest": "gpt-5.6-sol",
});

// Official pinned snapshots, not arbitrary numeric version suffixes.
export const CLAUDE_MODEL_SNAPSHOTS = Object.freeze({
  "claude-opus-4-20250514": "claude-opus-4",
  "claude-sonnet-4-20250514": "claude-sonnet-4",
  "claude-opus-4-1-20250805": "claude-opus-4-1",
  "claude-opus-4-5-20251101": "claude-opus-4-5",
  "claude-sonnet-4-5-20250929": "claude-sonnet-4-5",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  "claude-3-5-haiku-20241022": "claude-3-5-haiku",
});

function activityTime(value) {
  return value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(String(value));
}

/** @param {string | number | Date} [asOf] */
export function modelActivityCutoff(asOf = Date.now()) {
  const date = new Date(activityTime(asOf));
  if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid model activity time");
  const day = date.getUTCDate();
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0)).getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - 1);
  date.setUTCDate(Math.min(day, lastDay));
  return date.getTime();
}

/** @param {Iterable<any>} observations @param {string | number | Date} [asOf] */
export function buildModelActivity(observations = [], asOf = Date.now()) {
  const now = activityTime(asOf);
  const cutoff = modelActivityCutoff(now);
  const modelLastSeen = Object.fromEntries(["Codex", "ZCode", "DSH", "OpenCode"].map((harness) => [harness, {}]));
  for (const observation of observations) {
    const model = String(observation.model || "")
      .trim()
      .toLowerCase();
    const timestamp = activityTime(observation.timestamp);
    const harness = observation.harness;
    if (
      !model ||
      model === "unknown model" ||
      !Object.hasOwn(modelLastSeen, harness) ||
      !Number.isFinite(timestamp) ||
      timestamp > now
    )
      continue;
    const previous = Object.hasOwn(modelLastSeen[harness], model) ? modelLastSeen[harness][model] : -Infinity;
    Object.defineProperty(modelLastSeen[harness], model, {
      value: Math.max(previous, timestamp),
      enumerable: true,
      configurable: true,
    });
  }
  const activeHarnessModels = Object.fromEntries(
    Object.entries(modelLastSeen).map(([harness, models]) => [
      harness,
      Object.keys(models)
        .filter((model) => models[model] > cutoff)
        .sort((left, right) => left.localeCompare(right)),
    ]),
  );
  return { modelUsageAsOf: new Date(now).toISOString(), modelLastSeen, activeHarnessModels };
}

function modelIndex(models) {
  if (!models || typeof models !== "object" || Array.isArray(models)) return new Map();
  return new Map(Object.keys(models).map((key) => [key.trim().toLowerCase(), key]));
}

/** Resolve an observed model ID against a supplied pricing catalog. */
export function resolvePricingModel(rawModel, models) {
  const original = String(rawModel ?? "").trim();
  const normalized = original.toLowerCase();
  const index = modelIndex(models);
  if (!normalized || normalized === "unknown model") {
    return { rawModel: original, catalogKey: null, matchType: "missing" };
  }

  const exact = index.get(normalized);
  if (exact) return { rawModel: original, catalogKey: exact, matchType: "exact" };

  const routedClaude = normalized.startsWith("anthropic/") ? normalized.slice("anthropic/".length) : null;
  const alias =
    PRICING_MODEL_ALIASES[normalized] ||
    CLAUDE_MODEL_SNAPSHOTS[normalized] ||
    (routedClaude && (CLAUDE_MODEL_SNAPSHOTS[routedClaude] || (routedClaude.startsWith("claude-") && routedClaude)));
  const aliasKey = alias && index.get(alias);
  if (aliasKey) return { rawModel: original, catalogKey: aliasKey, matchType: "alias" };

  if (normalized.endsWith("-free")) {
    return { rawModel: original, catalogKey: null, matchType: "free" };
  }

  // A future version (4-9, 5-6, etc.) must never borrow an older Claude price.
  if (normalized.startsWith("claude-") || routedClaude) {
    return { rawModel: original, catalogKey: null, matchType: "missing" };
  }

  const suffixKeys = [...index.keys()]
    .filter((key) => normalized.startsWith(`${key}-`))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  if (suffixKeys.length) {
    return { rawModel: original, catalogKey: index.get(suffixKeys[0]), matchType: "suffix" };
  }
  return { rawModel: original, catalogKey: null, matchType: "missing" };
}

/** Count unique observed IDs, keeping the harnesses where each one appeared. */
export function buildUsagePricingCoverage(harnessModels, models, ready = true) {
  if (!ready) {
    return {
      ready: false,
      usedModelCount: 0,
      matchedUsedModelCount: 0,
      freeRuleUsedModelCount: 0,
      missingUsedModels: [],
    };
  }

  const used = new Map();
  if (harnessModels && typeof harnessModels === "object" && !Array.isArray(harnessModels)) {
    for (const [harness, names] of Object.entries(harnessModels)) {
      if (!Array.isArray(names)) continue;
      for (const name of names) {
        const model = String(name ?? "").trim();
        const normalized = model.toLowerCase();
        if (!normalized || normalized === "unknown model") continue;
        let item = used.get(normalized);
        if (!item) {
          item = { model, harnesses: new Set() };
          used.set(normalized, item);
        }
        item.harnesses.add(harness);
      }
    }
  }

  let matchedUsedModelCount = 0;
  let freeRuleUsedModelCount = 0;
  const missingUsedModels = [];
  for (const [normalized, item] of [...used].sort(([left], [right]) => left.localeCompare(right))) {
    const result = resolvePricingModel(normalized, models);
    if (result.matchType === "missing") {
      missingUsedModels.push({ model: item.model, harnesses: [...item.harnesses].sort() });
      continue;
    }
    matchedUsedModelCount += 1;
    if (result.matchType === "free") freeRuleUsedModelCount += 1;
  }

  return {
    ready: true,
    usedModelCount: used.size,
    matchedUsedModelCount,
    freeRuleUsedModelCount,
    missingUsedModels,
  };
}
