#!/usr/bin/env node
/**
 * Export bounded Magpie request timings as unauthenticated candidate evidence.
 *
 * The caller supplies the endpoint and every part of the request scope. This
 * tool performs no discovery, reads no auth configuration, sends no
 * credentials, and writes only the normalized timing whitelist.
 */
import { createHash } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { normalizeRequestTimingEvidence } from "../src/perf-request-timing.js";

export const PAGE_SIZE = 500;
export const PAGE_LIMIT = 100;
export const EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_KIND = "perf-request-timing-export";
export const ADMISSION = "unauthenticated_candidate";

const REQUEST_TIMEOUT_MS = 30_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PRODUCER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ROUTE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

class ExportError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function usageText() {
  return [
    "Usage: node scripts/export-perf-request-timings.mjs --endpoint <url> --home <path>",
    "         --since <YYYY-MM-DD> --until <YYYY-MM-DD> --output <file>",
    "         --producer <name@version> --route <route> --agent <id> --provider <id>",
    "         --requested-model <exact> --reported-model <exact> [--home-kind main|jetbrains|extra] [--force]",
    "",
    "Reads one bounded, explicitly scoped Magpie ledger and writes candidate timing evidence.",
    "The exporter sends no Authorization header and follows no redirects.",
    "It fetches at most 100 pages of 500 rows and writes nothing unless the full read succeeds.",
    "",
    "Required scope values are matched exactly against every returned row:",
    "  --agent / --provider / --requested-model (req) / --reported-model (model)",
    "",
    "The output is unauthenticated_candidate. It is not certified or admitted to ranking.",
  ].join("\n");
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is number} */
function isNonNegativeSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** @param {unknown} value @returns {value is number} */
function isPositiveSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** @param {string} value */
function validatedDate(value) {
  if (!DATE_PATTERN.test(value)) {
    throw new ExportError("EXPORT_INVALID_DATE", "Dates must use YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ExportError("EXPORT_INVALID_DATE", "Dates must be real calendar dates");
  }
  return value;
}

/** @param {string} value */
function validatedProducer(value) {
  if (!PRODUCER_PATTERN.test(value) || value.slice(value.indexOf("@") + 1).toLowerCase() === "latest") {
    throw new ExportError("EXPORT_INVALID_PRODUCER", "Producer must be an exact name@version pin, not @latest");
  }
  return value;
}

/** @param {string} value */
function validatedRoute(value) {
  if (!ROUTE_PATTERN.test(value)) {
    throw new ExportError("EXPORT_INVALID_ROUTE", "Route must be one non-empty token");
  }
  return value;
}

/** @param {string} value */
function validatedEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new ExportError("EXPORT_INVALID_ENDPOINT", "Endpoint must be an absolute URL");
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new ExportError(
      "EXPORT_INVALID_ENDPOINT",
      "Endpoint must be http(s) with no credentials, query string, or fragment",
    );
  }
  return endpoint;
}

/**
 * Match the product's source id derivation so the import can name the same
 * local Codex home without serializing its path.
 *
 * @param {"main" | "jetbrains" | "extra"} kind
 * @param {string} homePath
 */
function homeIdFor(kind, homePath) {
  const resolved = path.resolve(homePath).replace(/\\/g, "/");
  const identity = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return `${kind}-${digest}`;
}

/** @param {string[]} argv */
export function parseExportArgs(argv) {
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        endpoint: { type: "string" },
        home: { type: "string" },
        "home-kind": { type: "string" },
        since: { type: "string" },
        until: { type: "string" },
        output: { type: "string" },
        producer: { type: "string" },
        route: { type: "string" },
        agent: { type: "string" },
        provider: { type: "string" },
        "requested-model": { type: "string" },
        "reported-model": { type: "string" },
        force: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });

    if (values.help) return { help: true };

    const required = [
      "endpoint",
      "home",
      "since",
      "until",
      "output",
      "producer",
      "route",
      "agent",
      "provider",
      "requested-model",
      "reported-model",
    ];
    for (const name of required) {
      if (typeof values[name] !== "string" || values[name].trim() === "") {
        throw new ExportError("EXPORT_USAGE", `--${name} is required`);
      }
    }

    const since = validatedDate(values.since);
    const until = validatedDate(values.until);
    if (since > until) {
      throw new ExportError("EXPORT_INVALID_RANGE", "--since must not be after --until");
    }

    const home = values.home;
    const inferredKind = path.resolve(home) === path.resolve(homedir(), ".codex") ? "main" : "extra";
    const homeKind = values["home-kind"] ?? inferredKind;
    if (homeKind !== "main" && homeKind !== "jetbrains" && homeKind !== "extra") {
      throw new ExportError("EXPORT_USAGE", "--home-kind must be main, jetbrains, or extra");
    }

    return {
      help: false,
      endpoint: validatedEndpoint(values.endpoint),
      homeId: homeIdFor(homeKind, home),
      since,
      until,
      output: path.resolve(values.output),
      producer: validatedProducer(values.producer),
      route: validatedRoute(values.route),
      agent: values.agent,
      provider: values.provider,
      requestedModel: values["requested-model"],
      reportedModel: values["reported-model"],
      force: values.force,
    };
  } catch (error) {
    if (error instanceof ExportError) throw error;
    throw new ExportError("EXPORT_USAGE", "Invalid command line");
  }
}

/** @param {URL} endpoint @param {ReturnType<typeof parseExportArgs>} options @param {number} offset */
function pageUrl(endpoint, options, offset) {
  if (options.help) throw new TypeError("Help options are not exportable");
  const url = new URL(endpoint);
  const params = url.searchParams;
  params.set("period", `${options.since}..${options.until}`);
  params.set("agent", options.agent);
  params.set("provider", options.provider);
  params.set("model", options.reportedModel);
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset));
  return url;
}

/** @param {URL} url */
async function fetchPage(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ExportError("EXPORT_FETCH_FAILED", "Endpoint request failed");
  }
  if (!response.ok) {
    throw new ExportError("EXPORT_HTTP_FAILED", `Endpoint returned HTTP ${response.status}`);
  }

  let page;
  try {
    page = await response.json();
  } catch {
    throw new ExportError("EXPORT_INVALID_RESPONSE", "Endpoint response is not JSON");
  }
  if (
    !isRecord(page) ||
    !Array.isArray(page.rows) ||
    !isNonNegativeSafeInteger(page.total)
  ) {
    throw new ExportError("EXPORT_INVALID_RESPONSE", "Endpoint page must contain rows[] and a non-negative total");
  }
  return { rows: page.rows, total: page.total };
}

/**
 * @param {Record<string, unknown>} row
 * @param {Exclude<ReturnType<typeof parseExportArgs>, {help: true}>} options
 * @param {string} evidenceOrigin
 */
function normalizeRow(row, options, evidenceOrigin) {
  if (
    row.agent !== options.agent ||
    row.provider !== options.provider ||
    row.req !== options.requestedModel ||
    row.model !== options.reportedModel
  ) {
    throw new ExportError("EXPORT_ROW_OUT_OF_SCOPE", "Ledger row does not match the exact requested scope");
  }
  if (row.status !== 200) return { kind: "nonCompletedHttpStatus" };
  if (typeof row.response_id !== "string" || row.response_id.trim() === "") {
    throw new ExportError("EXPORT_ROW_INVALID_ID", "Completed ledger row has no response identity");
  }
  if (!isNonNegativeSafeInteger(row.out) || !isPositiveSafeInteger(row.ms)) {
    return { kind: "invalidTiming" };
  }

  return {
    kind: "record",
    record: normalizeRequestTimingEvidence({
      schemaVersion: 1,
      evidenceOrigin,
      responseId: row.response_id,
      requestedModel: row.req,
      reportedOutputTokens: row.out,
      durationMs: row.ms,
      status: "completed",
      completedAtMs: null,
    }),
  };
}

/** @param {Exclude<ReturnType<typeof parseExportArgs>, {help: true}>} options */
async function collectExport(options) {
  const evidenceOrigin = `${options.producer};route=${options.route}`;
  const records = new Map();
  const variantsByResponse = new Map();
  const skipped = { nonCompletedHttpStatus: 0, invalidTiming: 0 };
  let total = 0;
  let hasTotal = false;
  let offset = 0;
  let pages = 0;

  while (!hasTotal || offset < total) {
    if (pages >= PAGE_LIMIT) {
      throw new ExportError("EXPORT_PAGE_LIMIT", `Ledger exceeded the ${PAGE_LIMIT}-page safety limit`);
    }
    const page = await fetchPage(pageUrl(options.endpoint, options, offset));
    if (!hasTotal) {
      total = page.total;
      hasTotal = true;
    } else if (page.total !== total) {
      throw new ExportError("EXPORT_PAGINATION_CHANGED", "Ledger total changed while paging");
    }
    pages += 1;

    for (const rawRow of page.rows) {
      if (!isRecord(rawRow)) {
        throw new ExportError("EXPORT_INVALID_RESPONSE", "Ledger page contains a non-object row");
      }
      const normalized = normalizeRow(rawRow, options, evidenceOrigin);
      if (normalized.kind === "nonCompletedHttpStatus" || normalized.kind === "invalidTiming") {
        skipped[normalized.kind] += 1;
        continue;
      }

      const responseId = normalized.record.responseId;
      const variantKey = JSON.stringify(normalized.record);
      records.set(variantKey, normalized.record);
      const variants = variantsByResponse.get(responseId) ?? new Set();
      variants.add(variantKey);
      variantsByResponse.set(responseId, variants);
    }

    if (page.rows.length === 0 && offset < total) {
      throw new ExportError("EXPORT_PAGINATION_STALLED", "Ledger page returned no rows before its total");
    }
    offset += page.rows.length;
    if (offset > total) {
      throw new ExportError("EXPORT_PAGINATION_INVALID", "Ledger page returned more rows than its total");
    }
  }

  const conflicts = [...variantsByResponse]
    .filter(([, variants]) => variants.size > 1)
    .map(([responseId, variants]) => ({ responseId, variants: variants.size }))
    .sort((left, right) => (left.responseId < right.responseId ? -1 : left.responseId > right.responseId ? 1 : 0));
  const sortedRecords = [...records]
    .sort(([leftKey, left], [rightKey, right]) => {
      if (left.responseId !== right.responseId) return left.responseId < right.responseId ? -1 : 1;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    })
    .map(([, record]) => record);

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    kind: EXPORT_KIND,
    evidenceOrigin,
    homeId: options.homeId,
    admission: ADMISSION,
    range: { since: options.since, until: options.until },
    records: sortedRecords,
    conflicts,
    skipped,
  };
}

/**
 * @param {string} output
 * @param {unknown} value
 * @param {boolean} force
 */
async function writeExport(output, value, force) {
  if (!force) {
    try {
      await stat(output);
      throw new ExportError("EXPORT_OUTPUT_EXISTS", "Output already exists; pass --force to replace it");
    } catch (error) {
      if (error instanceof ExportError) throw error;
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
  }
  await writeFile(output, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** @param {string[]} argv */
export async function runExport(argv) {
  const options = parseExportArgs(argv);
  if (options.help) {
    console.log(usageText());
    return;
  }
  const output = await collectExport(options);
  await writeExport(options.output, output, options.force);
}

function reportFailure(error) {
  const code = isRecord(error) && typeof error.code === "string" ? error.code : "EXPORT_FAILED";
  const message = error instanceof Error ? error.message : "Export failed";
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runExport(process.argv.slice(2)).catch(reportFailure);
}
