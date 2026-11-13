import { dateKey } from "./calendar.js";

export const SHARE_PERIODS = Object.freeze(["today", "week", "month"]);
export const SHARE_METRICS = Object.freeze([
  "cacheHit",
  "output",
  "input",
  "cached",
  "uncached",
  "reasoning",
  "sessions",
  "models",
]);

function numberOrNull(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) ? Number(value) : null;
}

function dateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function shareCardFilename(range) {
  const start = dateOrNull(range?.start);
  const end = dateOrNull(range?.end);
  if (!start || !end) return null;
  const first = dateKey(start, range.calendarZone).replaceAll("-", "");
  const last = dateKey(end, range.calendarZone).replaceAll("-", "");
  return `usage_${first}${first === last ? "" : `-${last}`}.png`;
}

function matchingPeriodMetrics(periodComparison, range, total) {
  const bounds = periodComparison?.periods?.find((entry) => entry.key === range.preset);
  const metrics = periodComparison?.totals?.[range.preset];
  if (
    !bounds ||
    dateOrNull(bounds.start)?.toISOString() !== range.start ||
    dateOrNull(bounds.end)?.toISOString() !== range.end ||
    numberOrNull(metrics?.total) !== total
  ) {
    return null;
  }
  return metrics;
}

function displayCost(estimate, currency, rate) {
  const usd = numberOrNull(estimate?.totalUsd);
  const cny = numberOrNull(estimate?.totalCny);
  if (usd === null && cny === null) return null;
  // Match the homepage's native-currency buckets and display-time conversion.
  const safeRate = Number(rate) > 0 ? Number(rate) : 1;
  const amount = currency === "CNY" ? (usd ?? 0) * safeRate + (cny ?? 0) : (usd ?? 0) + (cny ?? 0) / safeRate;
  return Object.freeze({ amount, currency });
}

/**
 * Capture only displayable aggregates from the currently loaded dashboard response.
 * Pass periodComparison from the same response for trustworthy detail availability.
 * Unsupported or not-yet-loaded selections return null; rendering never reads page state.
 */
export function createShareCardData(summary, options = {}) {
  const period = options.preset ?? summary?.range?.preset;
  if (!SHARE_PERIODS.includes(period) || period !== summary?.range?.preset) return null;
  const start = dateOrNull(summary.range.start);
  const end = dateOrNull(summary.range.end);
  const total = numberOrNull(summary.totals?.total);
  if (!start || !end || start > end || total === null) return null;

  const range = Object.freeze({
    preset: period,
    start: start.toISOString(),
    end: end.toISOString(),
    calendarZone: summary.range.calendarZone === "utc" ? "utc" : "local",
  });
  const detail = matchingPeriodMetrics(options.periodComparison, range, total);
  const totals = { total };
  const unavailableTokens = {};
  for (const key of ["input", "cached", "output", "reasoning", "uncached"]) {
    const field = key === "uncached" ? "uncachedInput" : key;
    const value = numberOrNull(detail?.[field] ?? (key === "uncached" ? null : summary.totals[key]));
    const unavailable = numberOrNull(detail?.[`${field}UnavailableTokens`]);
    totals[key] = value === 0 && unavailable > 0 ? null : value;
    unavailableTokens[key] = unavailable;
  }
  // Without the known-detail aggregate, input minus cached can invent uncached usage.
  if (!detail && total === 0) totals.uncached = 0;

  const models = (summary.models || [])
    .map((row) => ({ name: String(row.name || row.key || "Unknown model"), total: numberOrNull(row.total?.total) }))
    .filter((row) => row.total !== null)
    .sort((left, right) => right.total - left.total)
    .slice(0, 5)
    .map(Object.freeze);
  const currency = options.currency === "CNY" ? "CNY" : "USD";
  const estimate = summary.costEstimate;
  return Object.freeze({
    period,
    range,
    filename: shareCardFilename(range),
    totals: Object.freeze(totals),
    sessionCount: numberOrNull(summary.sessionCount),
    modelCount: numberOrNull(estimate?.modelCount),
    cacheHitRate: numberOrNull(estimate?.cacheHitRate),
    models: Object.freeze(models),
    cost: displayCost(estimate, currency, options.usdToCnyRate ?? estimate?.usdToCnyRate),
    unavailableTokens: Object.freeze(unavailableTokens),
  });
}
