const PRICING_MODEL_ALIASES = Object.freeze({
  "gpt-5.6": "gpt-5.6-sol",
  "gpt-daybreak-blue-latest": "gpt-5.6-sol",
});

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

  const alias = PRICING_MODEL_ALIASES[normalized];
  const aliasKey = alias && index.get(alias);
  if (aliasKey) return { rawModel: original, catalogKey: aliasKey, matchType: "alias" };

  if (normalized.endsWith("-free")) {
    return { rawModel: original, catalogKey: null, matchType: "free" };
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
