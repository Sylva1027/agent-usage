#!/usr/bin/env node
/**
 * Import normalized request timing evidence into one explicitly named store.
 * This tool performs no discovery, network access, or source-file scanning.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { assertRequestTimingOriginsReviewed, UsageStore } from "../src/usage-store.js";

class ImportError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function usageText() {
  return [
    "Usage: node scripts/import-perf-request-timings.mjs --database <sqlite> --home <home-id> --input <json> [--reviewed-origin <origin> ...]",
    "",
    "The input is either an array of timing records or an object with a records array.",
    "Schema v1 and v2 records are accepted; v2 generation evidence is preserved.",
    "If the object contains homeId, it must match --home.",
    "Each non-empty batch requires one or more explicit --reviewed-origin values matching its records.",
  ].join("\n");
}

/** @param {string[]} argv */
export function parseImportArgs(argv) {
  try {
    const { values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        database: { type: "string" },
        home: { type: "string" },
        input: { type: "string" },
        "reviewed-origin": { type: "string", multiple: true },
        help: { type: "boolean", short: "h", default: false },
      },
    });
    if (values.help) return { help: true };
    for (const name of ["database", "home", "input"]) {
      if (typeof values[name] !== "string" || values[name].trim() === "") {
        throw new ImportError("IMPORT_USAGE", `--${name} is required`);
      }
    }
    return {
      help: false,
      databaseFile: path.resolve(values.database),
      homeId: values.home,
      inputFile: path.resolve(values.input),
      reviewedOrigins: values["reviewed-origin"] ?? [],
    };
  } catch (error) {
    if (error instanceof ImportError) throw error;
    throw new ImportError("IMPORT_USAGE", "Invalid command line");
  }
}

/** @param {string} inputFile @param {string} homeId */
async function readRecords(inputFile, homeId) {
  let value;
  try {
    value = JSON.parse(await readFile(inputFile, "utf8"));
  } catch {
    throw new ImportError("IMPORT_INVALID_INPUT", "Input must be readable JSON");
  }
  const records = Array.isArray(value) ? value : value?.records;
  if (!Array.isArray(records)) {
    throw new ImportError("IMPORT_INVALID_INPUT", "Input must be a record array or an object with records[]");
  }
  if (!Array.isArray(value) && value.homeId !== undefined && value.homeId !== homeId) {
    throw new ImportError("IMPORT_HOME_MISMATCH", "Input homeId does not match --home");
  }
  return records;
}

/** @param {string[]} argv */
export async function runImport(argv) {
  const options = parseImportArgs(argv);
  if (options.help) {
    console.log(usageText());
    return;
  }
  const records = await readRecords(options.inputFile, options.homeId);
  assertRequestTimingOriginsReviewed(records, options.reviewedOrigins);
  const store = new UsageStore({
    homeDir: path.dirname(options.databaseFile),
    databaseFile: options.databaseFile,
    env: {},
    importDirs: [],
    automaticDiscoveryEnabled: false,
  });
  try {
    await store.open();
    const result = store.importRequestTimingEvidence({
      homeId: options.homeId,
      records,
      reviewedOrigins: options.reviewedOrigins,
    });
    console.log(JSON.stringify(result));
  } finally {
    store.close();
  }
}

function reportFailure(error) {
  const code = error?.code ?? "IMPORT_FAILED";
  console.error(`${code}: ${error instanceof Error ? error.message : "Import failed"}`);
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runImport(process.argv.slice(2)).catch(reportFailure);
}
