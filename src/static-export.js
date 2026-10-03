import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Script } from "node:vm";

import { buildUsageReport, selectQuotaWindows } from "./usage-core.js";
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

function removeNamedPublicImport(source, fileName, { expected = 1 } = {}) {
  const escapedName = fileName.replaceAll(".", "\\.");
  const pattern = new RegExp(`^import\\s*\\{[^}]*\\}\\s*from "\\./${escapedName}";[ \\t]*(?:\\r?\\n)?`, "gm");
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== expected) {
    throw new Error(
      `Expected exactly ${expected} named import(s) from ${fileName} in the dashboard source, found ${matches.length}.`,
    );
  }
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
      throw new Error(
        `Static dashboard has unresolved module syntax or invalid JavaScript in script ${index + 1}: ${error.message}`,
        { cause: error },
      );
    }
  }
}

export function renderStaticDashboardHtml(report) {
  const indexHtml = readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const styles = readFileSync(path.join(PUBLIC_DIR, "styles.css"), "utf8");
  const skinsStyles = readFileSync(path.join(PUBLIC_DIR, "skins.css"), "utf8");
  const skinBootstrap = readFileSync(path.join(PUBLIC_DIR, "skin-bootstrap.js"), "utf8");
  const app = readFileSync(path.join(PUBLIC_DIR, "app.js"), "utf8");
  const i18n = readFileSync(path.join(PUBLIC_DIR, "i18n.js"), "utf8");
  const timelineUtils = readFileSync(path.join(PUBLIC_DIR, "timeline-utils.js"), "utf8");
  const htmlUtils = readFileSync(path.join(PUBLIC_DIR, "html-utils.js"), "utf8");
  const calendar = readFileSync(path.join(PUBLIC_DIR, "calendar.js"), "utf8");
  const appState = readFileSync(path.join(PUBLIC_DIR, "app-state.js"), "utf8");
  const usageFields = readFileSync(path.join(PUBLIC_DIR, "usage-fields.js"), "utf8");
  const periodComparison = readFileSync(path.join(PUBLIC_DIR, "period-comparison.js"), "utf8");
  const pricingModels = readFileSync(path.join(PUBLIC_DIR, "pricing-models.js"), "utf8");
  const skins = readFileSync(path.join(PUBLIC_DIR, "skins.js"), "utf8");
  const skinUi = readFileSync(path.join(PUBLIC_DIR, "skin-ui.js"), "utf8");
  const skinPicker = readFileSync(path.join(PUBLIC_DIR, "skin-picker.js"), "utf8");
  const inlineTimelineUtils = timelineUtils.replace(/^export\s+/gm, "");
  const inlineI18n = i18n.replace(/^export\s+/gm, "");
  const inlineHtmlUtils = htmlUtils.replace(/^export\s+/gm, "");
  const inlineCalendar = removeNamedPublicImport(removeNamedPublicImport(calendar, "i18n.js"), "html-utils.js").replace(
    /^export\s+/gm,
    "",
  );
  const inlineAppState = appState.replace(/^export\s+/gm, "");
  const inlinePricingModels = pricingModels.replace(/^export\s+/gm, "");
  const inlineSkins = skins.replace(/^export\s+/gm, "");
  // period-comparison 依赖 usage-fields，把后者嵌进前者的 IIFE 里，
  // 避免顶层名字与 app.js 自身的 emptyUsage 等定义冲突。
  const inlineUsageFields = `const { USAGE_DETAIL_MASK, USAGE_DETAIL_INCONSISTENT, emptyUsage } = (() => {\n${usageFields.replace(
    /^export\s+/gm,
    "",
  )}\nreturn { USAGE_DETAIL_MASK, USAGE_DETAIL_INCONSISTENT, emptyUsage };\n})();`;
  const inlinePeriodComparison = removeNamedPublicImport(periodComparison, "usage-fields.js").replace(
    /^export\s+/gm,
    "",
  );
  const i18nImport = app.match(/^import \{([^}]*)\} from "\.\/i18n\.js";\s*/m);
  if (!i18nImport) throw new Error("Expected the dashboard localization import.");
  const i18nNames = i18nImport[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!i18nNames.every((name) => /^[A-Za-z_$][\w$]*$/.test(name))) {
    throw new Error("Expected simple named dashboard localization imports.");
  }
  const bundledApp = replaceExactlyOnce(
    [
      "timeline-utils.js",
      "i18n.js",
      "app-state.js",
      "html-utils.js",
      "calendar.js",
      "period-comparison.js",
      "pricing-models.js",
      "skin-ui.js",
    ].reduce((source, fileName) => removeNamedPublicImport(source, fileName), app),
    "export { datePickerMonthModel, renderDatePickerHtml };",
    "",
    "dashboard date picker export",
  );
  const bundledTimelineUtils = `const { buildTimelineRows, channelForRange, homeSourceKinds, sourceGroup, deriveTimelineBucket, MAX_TIMELINE_SLOTS, RECENT_SELECTIONS, resolveNamedRecentRange, hasSelectedCodexSource, quotaRecordsForRange, quotaRecordValues } = (() => {\n${inlineTimelineUtils}\nreturn { buildTimelineRows, channelForRange, homeSourceKinds, sourceGroup, deriveTimelineBucket, MAX_TIMELINE_SLOTS, RECENT_SELECTIONS, resolveNamedRecentRange, hasSelectedCodexSource, quotaRecordsForRange, quotaRecordValues };\n})();`;
  const bundledI18n = `const { ${i18nNames.join(", ")} } = (() => {\n${inlineI18n}\nreturn { ${i18nNames.join(", ")} };\n})();`;
  const bundledHtmlUtils = `const { escapeHtml, externalHttpUrl, safeChartColor } = (() => {\n${inlineHtmlUtils}\nreturn { escapeHtml, externalHttpUrl, safeChartColor };\n})();`;
  const bundledCalendar = `const { addDays, dateKey, datePickerMonthModel, monthStart, normalizeDateInput, parseLocalDate, renderDatePickerHtml } = (() => {\n${inlineCalendar}\nreturn { addDays, dateKey, datePickerMonthModel, monthStart, normalizeDateInput, parseLocalDate, renderDatePickerHtml };\n})();`;
  const bundledAppState = `const { state } = (() => {\n${inlineAppState}\nreturn { state };\n})();`;
  const bundledPricingModels = `const { buildModelActivity, buildUsagePricingCoverage, resolvePricingModel } = (() => {\n${inlinePricingModels}\nreturn { buildModelActivity, buildUsagePricingCoverage, resolvePricingModel };\n})();`;
  const bundledPeriodComparison = `const { summarizePeriodComparison } = (() => {\n${inlineUsageFields}\n${inlinePeriodComparison}\nreturn { summarizePeriodComparison };\n})();`;
  // skins.js and skin-ui.js are pure named-export modules. They are inlined into
  // one closure so the registry, its derived URLs and the DOM runtime share a
  // single scope: skins.js declares MIN_OPACITY and so does skin-ui.js, so they
  // must not both be hoisted into the snapshot's top level.
  const skinsExportNames = [...skins.matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)].map(
    (match) => match[1],
  );
  if (!skinsExportNames.length) throw new Error("Expected named exports in public/skins.js.");
  // The registry imports the user-owned colour input; it joins the same closure,
  // so its declaration is inlined and the import statement is dropped.
  const skinPalettes = readFileSync(path.join(PUBLIC_DIR, "skin-palettes.js"), "utf8");
  if (!/export\s+const\s+SKIN_PALETTES\s*=/.test(skinPalettes)) {
    throw new Error("Expected public/skin-palettes.js to export SKIN_PALETTES.");
  }
  const inlineSkinPalettes = skinPalettes
    .replace(/^export\s*\{[^}]*\}\s*(?:from\s*"[^"]*")?\s*;[ \t]*(?:\r?\n)?/gm, "")
    .replace(/^export\s+/gm, "");
  // Drop the registry's exports, the re-export of SKINS that skin-ui adds, and the
  // import of the colour input that now lives in the same closure.
  const inlineSkinsBare = removeNamedPublicImport(inlineSkins, "skin-palettes.js")
    .replace(/^export\s*\{\s*[^}]*\}\s*;[ \t]*(?:\r?\n)?/gm, "")
    .replace(/^export\s+/gm, "");

  const skinUiExportNames = [...skinUi.matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)].map(
    (match) => match[1],
  );
  if (!skinUiExportNames.length) throw new Error("Expected named exports in public/skin-ui.js.");
  const inlineSkinUi = removeNamedPublicImport(skinUi, "skins.js")
    .replace(/^export\s*\{[^}]*\}\s*(?:from\s*"[^"]*")?\s*;[ \t]*(?:\r?\n)?/gm, "")
    .replace(/^export\s+/gm, "");

  // The picker receives the runtime as a factory argument and imports nothing
  // from skin-ui.js, so only its export keywords need stripping.
  const skinPickerExportNames = [...skinPicker.matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)].map(
    (match) => match[1],
  );
  if (!skinPickerExportNames.length) throw new Error("Expected named exports in public/skin-picker.js.");
  const inlineSkinPicker = skinPicker
    .replace(/^export\s*\{\s*[^}]*\}\s*;[ \t]*(?:\r?\n)?/gm, "")
    .replace(/^export\s+/gm, "");

  // SKINS is returned explicitly because app.js consumes it through the re-export.
  const skinUiReturns = [...new Set([...skinUiExportNames, ...skinPickerExportNames, "SKINS"])];
  const bundledSkinUi = `const { ${skinUiReturns.join(", ")} } = (() => {\n${inlineSkinPalettes}\n${inlineSkinsBare}\n${inlineSkinUi}\n${inlineSkinPicker}\nreturn { ${skinUiReturns.join(", ")} };\n})();`;

  // Every skin asset is inlined, not just the currently selected one: the
  // offline snapshot must be able to switch through all ten skins and both
  // modes with no network. A single map is shared by the registry, the
  // decoration layer, the comparison thumbnails and any CSS reference.
  const assetManifestFile = path.join(PUBLIC_DIR, "skin-assets.json");
  let assetManifest;
  try {
    assetManifest = JSON.parse(readFileSync(assetManifestFile, "utf8"));
  } catch (error) {
    throw new Error(`Expected ${path.relative(ROOT_DIR, assetManifestFile)}; run \`npm.cmd run skins:prepare\`.`, {
      cause: error,
    });
  }
  const inlinedAssets = {};
  let inlinedAssetBytes = 0;
  for (const [url, entry] of Object.entries(assetManifest.assets || {})) {
    const bytes = readFileSync(path.join(ROOT_DIR, entry.publicPath));
    inlinedAssets[url] = `data:image/webp;base64,${bytes.toString("base64")}`;
    inlinedAssetBytes += bytes.length;
  }
  if (Object.keys(inlinedAssets).length !== 40) {
    throw new Error(`Expected 40 inlined skin assets, found ${Object.keys(inlinedAssets).length}.`);
  }
  const asOf = report.asOf || report.generatedAt || new Date().toISOString();
  const quota = selectQuotaWindows(report.rateLimitObservations || [], asOf);
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
  const skinsStyleAnchor = '<link rel="stylesheet" href="/skins.css" />';
  const bootstrapAnchor = '<script src="/skin-bootstrap.js"></script>';
  const scriptAnchor = '<script src="/app.js" type="module"></script>';
  let html = replaceExactlyOnce(indexHtml, styleAnchor, `<style>\n${styles}\n</style>`, "stylesheet link");
  html = replaceExactlyOnce(html, skinsStyleAnchor, `<style>\n${skinsStyles}\n</style>`, "skins stylesheet link");
  // The bootstrap stays a classic script in the same position as online (after
  // the theme restore, before the stylesheets) so pre-paint behaviour matches.
  html = replaceExactlyOnce(
    html,
    bootstrapAnchor,
    `<script>\n${skinBootstrap.replace("</script>", "<\\/script>")}\n</script>`,
    "skin bootstrap script",
  );
  html = replaceExactlyOnce(
    html,
    scriptAnchor,
    `<script>window.__CODEX_USAGE_REPORT__ = ${safeScriptJson(pricedReport)};</script>\n<script>window.__CODEX_USAGE_SKIN_ASSETS__ = ${safeScriptJson(inlinedAssets)};</script>\n<script type="module">\n${bundledTimelineUtils}\n${bundledI18n}\n${bundledHtmlUtils}\n${bundledCalendar}\n${bundledAppState}\n${bundledPricingModels}\n${bundledPeriodComparison}\n${bundledSkinUi}\n${bundledApp}\n</script>`,
    "application script",
  );
  assertSelfContainedStaticHtml(html);
  lastExportStats = {
    inlinedSkinAssets: Object.keys(inlinedAssets).length,
    inlinedSkinAssetBytes: inlinedAssetBytes,
    inlinedSkinUrls: Object.keys(inlinedAssets),
  };
  return html;
}

/** Stats from the most recent render, for tests and the plan's size record. */
let lastExportStats = null;

export function lastStaticExportStats() {
  return lastExportStats;
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
