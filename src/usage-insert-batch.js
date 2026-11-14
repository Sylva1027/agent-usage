/** @typedef {import("node:sqlite").SQLInputValue} SQLInputValue */

/** @type {WeakMap<import("node:sqlite").DatabaseSync, number>} */
const variableLimits = new WeakMap();

/** @param {import("node:sqlite").DatabaseSync} database */
function variableLimit(database) {
  const cached = variableLimits.get(database);
  if (cached !== undefined) return cached;
  let limit = 999;
  try {
    for (const row of database.prepare("PRAGMA compile_options").all()) {
      const match = /^MAX_VARIABLE_NUMBER=(\d+)$/.exec(String(row.compile_options));
      if (match && Number.isSafeInteger(Number(match[1])) && Number(match[1]) > 0) {
        limit = Number(match[1]);
        break;
      }
    }
  } catch {
    // Builds without compile-option diagnostics use SQLite's conservative legacy limit.
  }
  variableLimits.set(database, limit);
  return limit;
}

/**
 * Buffer positional INSERT values in input order; the caller owns the transaction
 * and must roll it back on failure. Flush before reads that depend on pending rows.
 * Bytes count UTF-8 text, binary view lengths, and eight bytes per other scalar.
 * @param {import("node:sqlite").DatabaseSync} database
 * @param {{sqlPrefix: string, columns: number, maxRows?: number, maxBytes?: number}} options
 *   Trusted SQL ending in VALUES (including INSERT OR REPLACE), and the number of columns per row.
 * @returns {{add(values: readonly SQLInputValue[]): void, flush(): void}}
 */
export function createUsageInsertBatch(database, { sqlPrefix, columns, maxRows = 128, maxBytes = 256 * 1024 }) {
  if (!database || typeof database.prepare !== "function") throw new TypeError("database must support prepare");
  if (typeof sqlPrefix !== "string" || !sqlPrefix.trim()) throw new TypeError("sqlPrefix must be a non-empty string");
  for (const [name, value] of Object.entries({ columns, maxRows, maxBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  }
  // SQLite may accept more parameters than a JavaScript spread call can safely pass.
  const rowLimit = Math.min(maxRows, Math.floor(Math.min(variableLimit(database), 16_384) / columns));
  if (rowLimit < 1) throw new RangeError("columns exceed SQLite's bind parameter limit");
  const tuple = `(${Array(columns).fill("?").join(",")})`;
  /** @type {SQLInputValue[]} */
  let parameters = [];
  let bytes = 0;
  /** @type {import("node:sqlite").StatementSync | null} */
  let fullStatement = null;
  /** @type {import("node:sqlite").StatementSync | null} */
  let partialStatement = null;
  let partialRows = 0;

  function flush() {
    const rows = parameters.length / columns;
    if (rows === 0) return;
    let statement;
    if (rows === rowLimit) {
      fullStatement ??= database.prepare(`${sqlPrefix} ${Array(rows).fill(tuple).join(",")}`);
      statement = fullStatement;
    } else {
      if (partialRows !== rows) {
        partialStatement = database.prepare(`${sqlPrefix} ${Array(rows).fill(tuple).join(",")}`);
        partialRows = rows;
      }
      statement = partialStatement;
    }
    statement.run(...parameters);
    parameters = [];
    bytes = 0;
  }

  return {
    add(values) {
      if (!Array.isArray(values) || values.length !== columns) {
        throw new TypeError(`values must be an array of ${columns} positional scalars`);
      }
      let rowBytes = 0;
      for (const value of values) {
        if (typeof value === "string") rowBytes += Buffer.byteLength(value);
        else if (ArrayBuffer.isView(value)) rowBytes += value.byteLength;
        else if (value === null || typeof value === "number" || typeof value === "bigint") rowBytes += 8;
        else throw new TypeError("values must contain only node:sqlite positional scalars");
      }
      if (bytes + rowBytes > maxBytes) flush();
      for (const value of values) parameters.push(value);
      bytes += rowBytes;
      if (parameters.length / columns === rowLimit || bytes >= maxBytes) flush();
    },
    flush,
  };
}
