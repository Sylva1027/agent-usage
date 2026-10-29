// Keep routing namespaces: a third-party GPT alias is not subscription evidence.
export function isQuotaUsage(event) {
  if (["api", "external", "credits"].includes(event.quotaSource)) return false;
  return /^(?:(?:openai|codex)\/)?(?:gpt-\d|o[134](?:-|$)|codex-mini-latest$)/i.test(String(event.model || "").trim());
}

// Local snapshots provide an approximate credits interval, not a per-request receipt.
export function createQuotaSourceTracker() {
  let provider = "";
  let hasCredits = false;
  let creditsUntil = 0;
  let recovered = false;
  return (row) => {
    if (row.type === "session_meta") provider = String(row.payload?.model_provider || "").toLowerCase();
    const time = Date.parse(row.timestamp || "");
    const limits = row.type === "event_msg" && row.payload?.type === "token_count" ? row.payload.rate_limits : null;
    if (limits && (!limits.limit_id || limits.limit_id === "codex")) {
      if (typeof limits.credits?.has_credits === "boolean") hasCredits = limits.credits.has_credits;
      const windows = [limits.primary, limits.secondary].filter(
        (window) => window && Number.isFinite(window.used_percent) && Number(window.resets_at) * 1000 > time,
      );
      const exhausted = windows.filter((window) => window.used_percent >= 100);
      if (hasCredits && exhausted.length)
        creditsUntil = Math.max(...exhausted.map((window) => Number(window.resets_at) * 1000));
      else if (windows.length && !exhausted.length) {
        creditsUntil = 0;
        recovered = true;
      }
    }
    if (provider && !["openai", "codex"].includes(provider)) return { quotaSource: "external", quotaSourceUntil: 0 };
    return {
      quotaSource: time < creditsUntil ? "credits" : recovered ? "plan" : "unknown",
      quotaSourceUntil: time < creditsUntil ? creditsUntil : 0,
    };
  };
}
