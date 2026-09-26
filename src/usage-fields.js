// 用量字段形状与一致性校验。Codex 会话日志、项目日志和 ZCode 用量库
// 的解析器共用这里的定义，避免各来源对 token 明细的口径不一致。

export const USAGE_FIELDS = ["total", "input", "cached", "output", "reasoning"];
export const USAGE_DETAIL_MASK = Object.freeze({ input: 1, cached: 2, output: 4, reasoning: 8, complete: 15, cacheWrite: 32 });
export const USAGE_DETAIL_INCONSISTENT = 16;

export function emptyUsage() {
  return { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 };
}

export function isZeroUsage(usage) {
  return USAGE_FIELDS.every((field) => !usage[field]);
}

export function validateUsageDetails(usage, detailMask) {
  let gap = 0;
  let mask = detailMask;
  const inputKnown = Boolean(mask & USAGE_DETAIL_MASK.input);
  const cachedKnown = Boolean(mask & USAGE_DETAIL_MASK.cached);
  const outputKnown = Boolean(mask & USAGE_DETAIL_MASK.output);
  const reasoningKnown = Boolean(mask & USAGE_DETAIL_MASK.reasoning);
  if (usage.total > 0 && inputKnown && outputKnown && usage.input === 0 && usage.output === 0) {
    return {
      detailMask: (mask & ~USAGE_DETAIL_MASK.complete) | USAGE_DETAIL_INCONSISTENT,
      reconciliationGap: usage.total,
    };
  }
  if (inputKnown && cachedKnown && usage.cached > usage.input) {
    gap += usage.cached - usage.input;
    mask &= ~USAGE_DETAIL_MASK.cached;
  }
  if (inputKnown && outputKnown && usage.total !== usage.input + usage.output) {
    gap += Math.abs(usage.total - usage.input - usage.output);
  }
  if (outputKnown && reasoningKnown && usage.reasoning > usage.output) {
    gap += usage.reasoning - usage.output;
    mask &= ~USAGE_DETAIL_MASK.reasoning;
  }
  if (gap > 0) {
    mask |= USAGE_DETAIL_INCONSISTENT;
  }
  return { detailMask: mask, reconciliationGap: gap };
}
