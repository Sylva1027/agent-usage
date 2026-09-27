import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";

import { buildUsageReport, selectQuotaWindows, summarizePeriodComparison } from "./usage-core.js";
import { API_PRICING_MODE, API_PRICING_SOURCE, estimateEventCost, getPricingCatalog } from "./pricing.js";
import { loadPricingFile } from "./pricing-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");

function safeScriptJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function replaceExactlyOnce(value, anchor, replacement, description) {
  const index = value.indexOf(anchor);
  if (index < 0 || value.indexOf(anchor, index + anchor.length) >= 0) {
    throw new Error(`Expected exactly one ${description} in dashboard HTML.`);
  }
  return value.slice(0, index) + replacement + value.slice(index + anchor.length);
}

function removeNamedPublicImport(source, fileName) {
  const escapedName = fileName.replaceAll(".", "\\.");
  const pattern = new RegExp(`^import\\s*\\{[^}]*\\}\\s*from "\\./${escapedName}";[ \\t]*(?:\\r?\\n)?`, "gm");
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) throw new Error(`Expected exactly one named import from ${fileName} in the dashboard source.`);
  return source.replace(pattern, "");
}

// The snapshot runs from file:// and must not request sibling source files.
// Parse its inline scripts as classic JavaScript after removing declaration-only
// exports. Any unbundled import, re-export, or module-only syntax then fails.
export function assertSelfContainedStaticHtml(html) {
  if (/<(?:script|link)\b[^>]*\b(?:src|href)\s*=/i.test(html)) {
    throw new Error("Static dashboard still references an external script or stylesheet.");
  }
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  const moduleScripts = scripts.filter(([, attributes]) => /\btype\s*=\s*["']module["']/i.test(attributes));
  if (moduleScripts.length !== 1) {
    throw new Error(`Expected one inline dashboard module, found ${moduleScripts.length}.`);
  }
  for (const [index, [, attributes, source]] of scripts.entries()) {
    const isModule = /\btype\s*=\s*["']module["']/i.test(attributes);
    if (isModule && /\bimport\s*\(/.test(source)) {
      throw new Error(`Static dashboard contains a dynamic module import in script ${index + 1}.`);
    }
    const classicSource = isModule
      ? source.replace(/(^|\n)([ \t]*)export[ \t]+(?=(?:async[ \t]+)?(?:function|class|const|let|var)\b)/g, "$1$2")
      : source;
    try {
      new Script(classicSource, { filename: `static-dashboard-script-${index + 1}.js` });
    } catch (error) {
      throw new Error(`Static dashboard has unresolved module syntax or invalid JavaScript in script ${index + 1}: ${error.message}`, { cause: error });
    }
  }
}

export function renderStaticDashboardHtml(report) {
  const indexHtml = readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const styles = readFileSync(path.join(PUBLIC_DIR, "styles.css"), "utf8");
  const app = readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  const i18n = readFileSync(path.join(PUBLIC_DIR, "i18n.js"), "utf8");
  const timelineUtils = readFileSync(path.join(PUBLIC_DIR, "timeline-utils.js"), "utf8");
  const htmlUtils = readFileSync(path.join(PUBLIC_DIR, "html-utils.js"), "utf8");
  const calendar = readFileSync(path.join(PUBLIC_DIR, "calendar.js"), "utf8");
  const appState = readFileSync(path.join(PUBLIC_DIR, "app-state.js"), "utf8");
  const inlineTimelineUtils = timelineUtils.replace(/^export\s+/gm, "");
  const inlineI18n = i18n.replace(/^export\s+/gm, "");
  const inlineHtmlUtils = htmlUtils.replace(/^export\s+/gm, "");
  const inlineCalendar = removeNamedPublicImport(removeNamedPublicImport(calendar, "i18n.js"), "html-utils.js").replace(/^export\s+/gm, "");
  const inlineAppState = appState.replace(/^export\s+/gm, "");
  const i18nImport = app.match(/^import \{([^}]*)\} from "\.\/i18n\.js";\s*/m);
  if (!i18nImport) throw new Error("Expected the dashboard localization import.");
  const i18nNames = i18nImport[1].split(",").map((name) => name.trim()).filter(Boolean);
  if (!i18nNames.every((name) => /^[A-Za-z_$][\w$]*$/.test(name))) {
    throw new Error("Expected simple named dashboard localization imports.");
  }
  const bundledApp = replaceExactlyOnce(
    ["timeline-utils.js", "i18n.js", "app-state.js", "html-utils.js", "calendar.js"]
      .reduce((source, fileName) => removeNamedPublicImport(source, fileName), app),
    "export { datePickerMonthModel, renderDatePickerHtml };",
    "",
    "dashboard date picker export",
  );
  const bundledTimelineUtils = `const { buildTimelineRows, MAX_TIMELINE_SLOTS, RECENT_SELECTIONS, resolveNamedRecentRange, hasSelectedCodexSource, quotaRecordsForRange, quotaRecordValues } = (() => {\n${inlineTimelineUtils}\nreturn { buildTimelineRows, MAX_TIMELINE_SLOTS, RECENT_SELECTIONS, resolveNamedRecentRange, hasSelectedCodexSource, quotaRecordsForRange, quotaRecordValues };\n})();`;
  const bundledI18n = `const { ${i18nNames.join(", ")} } = (() => {\n${inlineI18n}\nreturn { ${i18nNames.join(", ")} };\n})();`;
  const bundledHtmlUtils = `const { escapeHtml, externalHttpUrl, safeChartColor } = (() => {\n${inlineHtmlUtils}\nreturn { escapeHtml, externalHttpUrl, safeChartColor };\n})();`;
  const bundledCalendar = `const { addDays, dateKey, datePickerMonthModel, monthStart, normalizeDateInput, parseLocalDate, renderDatePickerHtml } = (() => {\n${inlineCalendar}\nreturn { addDays, dateKey, datePickerMonthModel, monthStart, normalizeDateInput, parseLocalDate, renderDatePickerHtml };\n})();`;
  const bundledAppState = `const { state } = (() => {\n${inlineAppState}\nreturn { state };\n})();`;
  const asOf = report.asOf || report.generatedAt || new Date().toISOString();
  const quota = selectQuotaWindows(report.rateLimitObservations || [], asOf);
  const periodComparison = summarizePeriodComparison(report.events, { now: asOf });
  const utcPeriodComparison = summarizePeriodComparison(report.events, { now: asOf, calendarZone: "utc" });
  const catalog = getPricingCatalog();
  const pricedReport = {
    ...report,
    generatedAt: asOf,
    asOf,
    quota,
    pricing: {
      checkedAt: catalog.checkedAt,
      usdToCnyRate: catalog.usdToCnyRate,
      mode: API_PRICING_MODE,
      source: API_PRICING_SOURCE,
    },
    events: report.events.map((event) => ({ ...event, costEstimate: estimateEventCost(event) })),
  };

  const styleAnchor = '<link rel="stylesheet" href="/styles.css" />';
  const scriptAnchor = '<script src="/app.js" type="module"></script>';
  let html = replaceExactlyOnce(indexHtml, styleAnchor, `<style>\n${styles}\n</style>`, "stylesheet link");
  html = replaceExactlyOnce(
    html,
    scriptAnchor,
    `<script>window.__CODEX_USAGE_REPORT__ = ${safeScriptJson(pricedReport)}; window.__CODEX_USAGE_PERIOD_COMPARISON__ = ${safeScriptJson(periodComparison)}; window.__CODEX_USAGE_PERIOD_COMPARISON_UTC__ = ${safeScriptJson(utcPeriodComparison)};</script>\n<script type="module">\n${bundledTimelineUtils}\n${bundledI18n}\n${bundledHtmlUtils}\n${bundledCalendar}\n${bundledAppState}\n${bundledApp}\n</script>`,
    "application script",
  );
  assertSelfContainedStaticHtml(html);
  return html;
}

export async function exportStaticDashboard(options = {}) {
  const outFile = options.outFile || path.join(ROOT_DIR, "dist", "codex-usage.html");
  await loadPricingFile(options);
  const report = options.report || (await buildUsageReport(options));
  const asOf = new Date().toISOString();
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, renderStaticDashboardHtml({ ...report, asOf }));
  return outFile;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const outArgIndex = process.argv.indexOf("--out");
  const outFile = outArgIndex >= 0 ? process.argv[outArgIndex + 1] : undefined;
  exportStaticDashboard({ outFile })
    .then((file) => {
      console.log(file);
    })
    .catch((error) => {
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
}
