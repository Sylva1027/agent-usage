import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function readPricingSourceCatalogs(file) {
  if (!existsSync(file)) return {};
  const database = new DatabaseSync(path.toNamespacedPath(file), { readOnly: true });
  try {
    return Object.fromEntries(
      database
        .prepare("SELECT source, payload, fetched_at FROM source_catalogs")
        .all()
        .map((row) => [row.source, { payload: JSON.parse(String(row.payload)), fetchedAt: String(row.fetched_at) }]),
    );
  } finally {
    database.close();
  }
}

export async function savePricingSourceCatalogs(file, catalogs) {
  if (!Object.keys(catalogs).length) return;
  await mkdir(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(path.toNamespacedPath(file));
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    database.exec(
      "CREATE TABLE IF NOT EXISTS source_catalogs (source TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL)",
    );
    const save = database.prepare(
      "INSERT INTO source_catalogs VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at",
    );
    database.exec("BEGIN IMMEDIATE");
    for (const [source, catalog] of Object.entries(catalogs))
      save.run(source, JSON.stringify(catalog.payload), catalog.fetchedAt);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
}
