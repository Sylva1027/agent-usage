import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UsageStore, publishedUsageEventFromRow } from '../../src/usage-store.js';
import { loadServiceTierEvidence, serviceTierEvidenceSnapshot } from '../../src/service-tier-evidence.js';
import { request } from './runner.mjs';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export async function publishFormalSources({ backend, directory, options = {}, gate, fresh = false }) {
  const started = performance.now(), file = path.join(directory, 'mirror.json');
  const previous = fresh ? { sources: {} } : JSON.parse(await readFile(file, 'utf8'));
  const reader = new UsageStore(options); await reader.open();
  let commits = 0, eventCount = 0, bytes = 0, readingMs = 0, commitMs = 0;
  try {
    const db = reader.database;
    assertNoArchives(db);
    const homes = reader.publishedUsageHomes();
    reader.serviceTierEvidence = gate?.usageStore.serviceTierEvidence || loadServiceTierEvidence(homes);
    const evidence = db.prepare("SELECT key,value FROM store_meta WHERE key IN ('quota_source_log_evidence') ORDER BY key").all();
    // shortcut: evidence changes inspect every source payload; dependency tracking can avoid this scan.
    const evidenceHash = hash({ quota: evidence, serviceTier: serviceTierEvidenceSnapshot(reader.serviceTierEvidence) });
    const allChanged = previous.evidenceHash !== evidenceHash;
    const fingerprints = JSON.parse(db.prepare("SELECT value FROM store_meta WHERE key='usage_file_fingerprints'").get()?.value || '{}');
    const sources = {}, eventHashes = { ...(previous.eventHashes || {}) };
    for (const row of db.prepare('SELECT * FROM source_files ORDER BY path').all()) {
      const sourceId = 'formal-' + hash(row.path), signature = hash({ row, fingerprint: fingerprints[row.path] });
      sources[sourceId] = signature;
      if (!allChanged && previous.sources[sourceId] === signature) continue;
      const begin = performance.now(), events = [];
      for (const event of db.prepare('SELECT * FROM events WHERE source_path=? ORDER BY timestamp_ms,id').iterate(row.path)) {
        events.push({ ...publishedUsageEventFromRow(event, row.kind, reader.serviceTierEvidence, reader.quotaSourceFor.bind(reader)), eventId: String(event.id) });
      }
      readingMs += performance.now() - begin; eventCount += events.length;
      const payloadHash = hash(events);
      if (previous.eventHashes?.[sourceId] === payloadHash) { eventHashes[sourceId] = payloadHash; continue; }
      eventHashes[sourceId] = payloadHash;
      const body = { sourceId, events, cursor: { signature } }; bytes += Buffer.byteLength(JSON.stringify(body));
      const commitStart = performance.now(); await request(backend, '/api/commit', body); commitMs += performance.now() - commitStart; commits++;
    }
    for (const sourceId of Object.keys(previous.sources)) if (!(sourceId in sources)) { await request(backend, '/api/commit', { sourceId, events: [], cursor: { removed: true } }); commits++; }
    const context = { homes, sessions: [], rateLimitObservations: reader.quotaObservations({ useCache: false }), generatedAt: reader.generatedAt || new Date().toISOString(), warnings: reader.warnings || [] };
    const contextHash = hash(context);
    const contextCommits = contextHash !== previous.contextHash ? 1 : 0;
    if (contextCommits) await request(backend, '/api/commit', { sourceId: 'formal-context', events: [], cursor: { contextHash }, context });
    await writeFile(file, JSON.stringify({ sources, eventHashes, evidenceHash, contextHash }));
    return { ms: performance.now() - started, commits, contextCommits, eventCount, bytes, readingMs, commitMs, allChanged };
  } finally { reader.close(); }
}
function assertNoArchives(db) { if (Number(db.prepare('SELECT count(*) AS n FROM archive_segments').get().n)) throw Error('This experimental bridge requires a hot-only index; archive data must never be silently omitted'); }

// Upgrade the measurement-only mirror metadata of seeds created before payload hashes were added.
export async function addSeedPayloadHashes(directories, options = {}) {
  const reader = new UsageStore(options); await reader.open();
  try {
    reader.serviceTierEvidence = loadServiceTierEvidence(reader.publishedUsageHomes());
    const fingerprints = JSON.parse(reader.database.prepare("SELECT value FROM store_meta WHERE key='usage_file_fingerprints'").get()?.value || '{}');
    const sources = {}, eventHashes = {};
    for (const row of reader.database.prepare('SELECT * FROM source_files ORDER BY path').all()) {
      const sourceId = 'formal-' + hash(row.path); sources[sourceId] = hash({ row, fingerprint: fingerprints[row.path] });
      const events = [];
      for (const event of reader.database.prepare('SELECT * FROM events WHERE source_path=? ORDER BY timestamp_ms,id').iterate(row.path)) events.push({ ...publishedUsageEventFromRow(event, row.kind, reader.serviceTierEvidence, reader.quotaSourceFor.bind(reader)), eventId: String(event.id) });
      eventHashes[sourceId] = hash(events);
    }
    for (const directory of directories) {
      const file = path.join(directory, 'mirror.json'), mirror = JSON.parse(await readFile(file, 'utf8'));
      if (hash(mirror.sources) !== hash(sources)) throw Error('Seed mirror does not match its formal source state');
      await writeFile(file, JSON.stringify({ ...mirror, eventHashes }));
    }
    return { sources: Object.keys(sources).length };
  } finally { reader.close(); }
}
