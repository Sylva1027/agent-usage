import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, open, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { serialize } from "node:v8";

const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;
const HEADER = ["page_size", "encoding", "auto_vacuum", "user_version", "application_id"];

function header(database, schema = "main") {
  return Object.fromEntries(HEADER.map((name) => [name, database.prepare(`PRAGMA ${schema}.${name}`).get()[name]]));
}

/**
 * Flush a newly created archive database and its companion manifest before switching references.
 * @param {string} databaseFile
 */
export async function syncHistoryArchiveFiles(databaseFile) {
  const { dir, name } = path.parse(databaseFile);
  for (const file of [databaseFile, path.join(dir, `${name}.manifest.json`)]) {
    const handle = await open(file, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

/**
 * Compare every table in read snapshots, retaining only the current pair of rows.
 * @param {string} originalFile
 * @param {string} copiedFile
 * @returns {{table: string, rows: number, sha256: string, rowid: boolean}[]}
 */
export function compareHistoryDatabases(originalFile, copiedFile) {
  const original = new DatabaseSync(originalFile, { readOnly: true });
  let copied;
  try {
    copied = new DatabaseSync(copiedFile, { readOnly: true });
    for (const database of [original, copied]) {
      database.exec("PRAGMA cache_size=-8192; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; BEGIN");
    }
    const schemaQuery = "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name";
    assert.deepEqual(copied.prepare(schemaQuery).all(), original.prepare(schemaQuery).all(), "database schemas differ");
    assert.deepEqual(header(copied), header(original), "database headers differ");
    const tables = /** @type {{schema: string, type: string, name: string, wr: number}[]} */ (
      original.prepare("PRAGMA table_list").all()
    ).filter(({ schema }) => schema === "main");
    assert(
      tables.every(({ type }) => type === "table" || type === "view"),
      "virtual/shadow tables require an explicit comparison contract",
    );
    const proofs = [];
    for (const table of tables
      .filter(({ type, name }) => type === "table" && name !== "sqlite_schema")
      .sort((a, b) => a.name.localeCompare(b.name))) {
      assert(!table.name.startsWith("sqlite_") || table.name === "sqlite_sequence", "unsupported internal table");
      const columns = /** @type {{name: string, pk: number}[]} */ (
        original.prepare(`PRAGMA table_xinfo(${quote(table.name)})`).all()
      );
      const rowid = ["rowid", "_rowid_", "oid"].find(
        (alias) => !columns.some((column) => column.name.toLowerCase() === alias),
      );
      assert(table.wr || rowid, `cannot compare hidden rowid of ${table.name}`);
      const order = table.wr
        ? columns
            .filter(({ pk }) => pk)
            .sort((a, b) => a.pk - b.pk)
            .map(({ name }) => quote(name))
        : [quote(rowid)];
      const sql = `SELECT ${table.wr ? "" : `${quote(rowid)},`}* FROM ${quote(table.name)} ORDER BY ${order}`;
      const statements = [original, copied].map((database) => {
        const statement = database.prepare(sql);
        statement.setReadBigInts(true);
        statement.setReturnArrays(true);
        return statement;
      });
      assert.deepEqual(
        statements[0].columns().map(({ name }) => name),
        statements[1].columns().map(({ name }) => name),
      );
      const iterators = statements.map((statement) => statement.iterate());
      const hash = createHash("sha256");
      let rows = 0;
      while (true) {
        const before = iterators[0].next(),
          after = iterators[1].next();
        assert.equal(after.done, before.done, `${table.name}: row count`);
        if (before.done) break;
        const a = serialize(before.value),
          b = serialize(after.value);
        assert(a.equals(b), `${table.name}: value or identity mismatch at row ${rows}`);
        hash.update(a);
        rows++;
      }
      proofs.push({ table: table.name, rows, sha256: hash.digest("hex"), rowid: !table.wr });
    }
    return proofs;
  } finally {
    original.close();
    copied?.close();
  }
}

/**
 * Reconstruct a standalone database, preserving row identities and postponing triggers until after loading.
 * @param {string} sourceFile
 * @param {string} destinationFile
 */
export async function compactHistoryDatabase(sourceFile, destinationFile) {
  const sourcePath = path.resolve(sourceFile);
  const destination = path.resolve(destinationFile);
  assert.notEqual(sourcePath, destination, "compaction requires a new destination");
  if (
    await lstat(destination).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    )
  )
    throw Object.assign(new Error("compaction destination exists"), { code: "EEXIST" });
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let sourceHeader;
  try {
    sourceHeader = header(source);
  } finally {
    source.close();
  }
  const temporary = `${destination}.building-${randomUUID()}`;
  let database;
  try {
    await (await open(temporary, "wx")).close();
    database = new DatabaseSync(temporary);
    for (const [name, value] of Object.entries(sourceHeader)) {
      database.exec(`PRAGMA ${name}=${typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : value}`);
    }
    database.exec(
      "PRAGMA foreign_keys=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=-8192; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; PRAGMA threads=0",
    );
    const uri = pathToFileURL(sourcePath);
    uri.searchParams.set("mode", "ro");
    database.prepare("ATTACH DATABASE ? AS original").run(uri.href);
    database.exec("BEGIN");
    assert.deepEqual(header(database, "original"), sourceHeader, "source header changed before snapshot");
    const schema = /** @type {{type: string, name: string, tbl_name: string, sql: string | null}[]} */ (
      database.prepare("SELECT type,name,tbl_name,sql FROM original.sqlite_schema ORDER BY rowid").all()
    );
    const tables = database.prepare("PRAGMA original.table_list").all();
    assert(
      tables.every(({ type }) => type === "table" || type === "view"),
      "virtual/shadow tables require an explicit copy contract",
    );
    for (const { type, name, sql } of schema) {
      if (type !== "table" || name.startsWith("sqlite_")) continue;
      database.exec(sql);
    }
    const internal = schema.filter(({ type, name }) => type === "table" && name.startsWith("sqlite_"));
    assert(
      internal.every(({ name }) => name === "sqlite_sequence"),
      "unsupported internal table",
    );
    let rows = 0;
    for (const { type, name } of schema) {
      if (type !== "table") continue;
      const columns = /** @type {{name: string, hidden: number, pk: number}[]} */ (
        database.prepare(`PRAGMA original.table_xinfo(${quote(name)})`).all()
      );
      const withoutRowid = tables.find((table) => table.name === name).wr === 1;
      const rowid = ["rowid", "_rowid_", "oid"].find(
        (alias) => !columns.some((column) => column.name.toLowerCase() === alias),
      );
      assert(withoutRowid || rowid, `cannot preserve hidden rowid of ${name}`);
      const fields = columns.filter(({ hidden }) => hidden === 0).map(({ name }) => quote(name));
      const order = withoutRowid
        ? columns
            .filter(({ pk }) => pk)
            .sort((a, b) => a.pk - b.pk)
            .map(({ name }) => quote(name))
        : [quote(rowid)];
      if (!withoutRowid) fields.unshift(quote(rowid));
      // AUTOINCREMENT inserts have already recreated sequence rows; restore the original high-water marks and rowids.
      if (name === "sqlite_sequence") database.exec("DELETE FROM sqlite_sequence");
      const insert = database.prepare(
        `INSERT INTO main.${quote(name)} (${fields}) SELECT ${fields} FROM original.${quote(name)} ORDER BY ${order}`,
      );
      insert.setReadBigInts(true);
      rows += Number(insert.run().changes);
    }
    // sqlite_sequence may precede later AUTOINCREMENT tables in sqlite_schema.
    if (internal.length) {
      database.exec(
        "DELETE FROM sqlite_sequence; INSERT INTO sqlite_sequence(rowid,name,seq) SELECT rowid,name,seq FROM original.sqlite_sequence ORDER BY rowid",
      );
    }
    for (const { type, sql } of schema) {
      if (type !== "table" && sql) database.exec(sql);
    }
    assert.deepEqual(
      database.prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name").all(),
      database.prepare("SELECT type,name,tbl_name,sql FROM original.sqlite_schema ORDER BY type,name").all(),
      "copied schema differs",
    );
    assert.deepEqual(
      database
        .prepare("PRAGMA main.quick_check")
        .all()
        .map((row) => row.quick_check),
      ["ok"],
    );
    assert.equal(database.prepare("PRAGMA main.foreign_key_check").get(), undefined, "copied foreign keys are invalid");
    database.exec("COMMIT");
    database.close();
    database = null;
    const handle = await open(temporary, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, destination);
    return { rows, tables: schema.filter(({ type }) => type === "table").length };
  } finally {
    database?.close();
    for (const file of [temporary, `${temporary}-journal`, `${temporary}-wal`, `${temporary}-shm`]) {
      await rm(file, { force: true });
    }
  }
}
