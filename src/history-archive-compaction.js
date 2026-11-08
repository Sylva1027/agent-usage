import assert from "node:assert/strict";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHistoryBackup } from "./history-backup.js";
import { verifyHistoryArchiveCandidate } from "./history-archive.js";
import { compactHistoryDatabase, compareHistoryDatabases, syncHistoryArchiveFiles } from "./history-compact.js";
import { serviceTierEvidenceFromSnapshot } from "./service-tier-evidence.js";

async function saveMapping(file, value) {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Build a separately published package; the original price and evidence snapshots remain its inputs. */
export async function compactHistoryArchivePackage(sourceFile, destinationFile) {
  const original = await verifyHistoryArchiveCandidate(sourceFile);
  const scratch = `${destinationFile}.compact-work`;
  let owned = false;
  try {
    await compactHistoryDatabase(sourceFile, scratch);
    owned = true;
    const tables = compareHistoryDatabases(sourceFile, scratch);
    const database = new DatabaseSync(scratch, { readOnly: true });
    let manifest;
    try {
      manifest = await createHistoryBackup(database, destinationFile, {
        pricingCatalog: original.manifest.pricing.catalog,
        serviceTierEvidence: original.manifest.serviceTierEvidence
          ? serviceTierEvidenceFromSnapshot(original.manifest.serviceTierEvidence.snapshot)
          : null,
      });
    } finally {
      database.close();
    }
    await syncHistoryArchiveFiles(destinationFile);
    await verifyHistoryArchiveCandidate(destinationFile);
    return { databaseFile: path.resolve(destinationFile), sha256: manifest.database.sha256, tables };
  } finally {
    if (owned) await rm(scratch);
  }
}

function matchesRecord(record, verified) {
  assert.equal(record.segment_id, verified.manifest.database.sha256, "registered archive identity changed");
  assert.equal(record.database_sha256, record.segment_id);
  assert.equal(record.start_ms, verified.candidate.startMs);
  assert.equal(record.end_ms, verified.candidate.endMs);
  assert.equal(record.event_count, verified.candidate.events.rows);
}

/** Validate a saved forward/inverse mapping against current facts; never restore an old primary database snapshot. */
export async function switchHistoryArchivePackages(store, mapping, { rollback = false, guard = null } = {}) {
  await store.open();
  assert.equal(path.resolve(store.databaseFile), mapping.databaseFile, "mapping belongs to another primary database");
  assert.equal(mapping.format, 1);
  assert(Array.isArray(mapping.packages) && mapping.packages.length > 0);
  await store.ensureHistoryProjectionTracking();
  guard ||= store.captureArchiveMaintenanceGuard();
  const records = new Map(
    store.database
      .prepare("SELECT * FROM archive_segments")
      .all()
      .map((row) => [row.segment_id, row]),
  );
  const replacements = [],
    seen = new Set();
  const scope = await store.createHistoryVerificationScope({ requireLeases: true });
  try {
    await scope.run(async () => {
      for (const entry of mapping.packages) {
        const previous = rollback ? entry.next : entry.previous,
          next = rollback ? entry.previous : entry.next;
        assert(previous.segment_id !== next.segment_id, "mapping must change a package identity");
        assert.deepEqual(
          { ...next },
          {
            ...previous,
            segment_id: next.segment_id,
            database_sha256: next.segment_id,
            database_path: path.resolve(next.database_path),
          },
          "mapping changes more than the archive identity and path",
        );
        assert(!seen.has(previous.segment_id) && !seen.has(next.segment_id), "overlapping archive mapping");
        seen.add(previous.segment_id);
        seen.add(next.segment_id);
        const before = await verifyHistoryArchiveCandidate(previous.database_path);
        const after = await verifyHistoryArchiveCandidate(next.database_path);
        matchesRecord(previous, before);
        matchesRecord(next, after);
        assert.deepEqual(after.candidate, before.candidate);
        assert.deepEqual(after.manifest.pricing, before.manifest.pricing);
        assert.deepEqual(after.manifest.serviceTierEvidence, before.manifest.serviceTierEvidence);
        compareHistoryDatabases(before.databaseFile, after.databaseFile);
        const current = records.get(previous.segment_id);
        if (current) {
          assert.deepEqual({ ...current }, { ...previous }, "registered archive changed since mapping was prepared");
          assert(!records.has(next.segment_id), "target archive is already registered");
          replacements.push({
            previous: current,
            next: {
              ...current,
              segment_id: next.segment_id,
              database_sha256: next.segment_id,
              database_path: path.resolve(next.database_path),
            },
          });
        } else
          assert.deepEqual(
            { ...records.get(next.segment_id) },
            { ...next },
            "mapping is neither current nor already applied",
          );
      }
      await scope.check();
      if (replacements.length) store.rebindHistoryArchiveReferences(replacements, guard);
    });
  } finally {
    await scope.close();
  }
  // A crash after the primary commit leaves a durable rebind batch for this call or the next query to finish.
  await store.withSqlHistoryReader(() => null);
  return {
    switched: replacements.length,
    replay: replacements.length === 0,
    rollback,
    projection: structuredClone(store.lastHistoryQueryWork?.projection ?? null),
    retainedFiles: mapping.packages.map((entry) => entry.previous.database_path),
  };
}

/** Explicit maintenance only. A complete mapping is also the resume/rollback record; old files are retained. */
export async function compactRegisteredHistory(store, directory, { rollback = false } = {}) {
  await store.open();
  await store.ensureHistoryProjectionTracking();
  const guard = store.captureArchiveMaintenanceGuard();
  const root = path.resolve(directory),
    mappingFile = path.join(root, "compaction.json");
  let mapping;
  try {
    mapping = JSON.parse(await readFile(mappingFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT" || rollback) throw error;
  }
  if (!mapping) {
    await mkdir(root); // An unfinished or unrelated directory is never overwritten.
    const records = store.database.prepare("SELECT * FROM archive_segments ORDER BY start_ms,segment_id").all();
    assert(records.length > 0, "there are no registered archives to compact");
    const packages = [];
    await store.withHistoryVerification(async () => {
      for (const [index, previous] of records.entries()) {
        const built = await compactHistoryArchivePackage(
          previous.database_path,
          path.join(root, `segment-${index}.sqlite`),
        );
        if (built.sha256 === previous.segment_id) continue;
        packages.push({
          previous,
          next: {
            ...previous,
            segment_id: built.sha256,
            database_sha256: built.sha256,
            database_path: built.databaseFile,
          },
        });
      }
    });
    assert(packages.length > 0, "archives are already compact with identical bytes");
    mapping = { format: 1, databaseFile: path.resolve(store.databaseFile), packages };
    await saveMapping(mappingFile, mapping);
  }
  const result = await switchHistoryArchivePackages(store, mapping, { rollback, guard });
  return { ...result, mappingFile };
}
