import { API_PRICING_MODE, API_PRICING_SOURCE, estimateEventCost, getPricingCatalog } from "../src/pricing.js";
import { selectQuotaWindows } from "../src/usage-core.js";
import { summarizePeriodComparison } from "../public/period-comparison.js";
import { state } from "../public/app-state.js";

// Exercise the pure browser statistics without generating or loading an HTML export.
export function pricedReport(report, asOf = report.asOf || report.generatedAt) {
  const catalog = getPricingCatalog();
  return {
    ...report,
    generatedAt: asOf,
    asOf,
    pricingCatalog: catalog,
    quota: selectQuotaWindows(report.rateLimitObservations || [], asOf),
    pricing: {
      checkedAt: catalog.checkedAt,
      usdToCnyRate: catalog.usdToCnyRate,
      mode: API_PRICING_MODE,
      source: API_PRICING_SOURCE,
    },
    events: report.events.map((event) => ({ ...event, costEstimate: estimateEventCost(event) })),
  };
}

export function periodComparisonForReport(report, calendarZone = state.calendarZone) {
  const excluded = new Set((state.excludedHomes || []).map(String));
  const events = (report.events || []).filter((event) => !excluded.has(String(event.homeId)));
  const now = state.now || report.asOf || report.quota?.asOf || report.generatedAt || undefined;
  return summarizePeriodComparison(events, { now, calendarZone });
}
