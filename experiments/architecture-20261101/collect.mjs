import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { collectAndCommit } from './node/collector.mjs';
import { request } from './runner.mjs';

const { values } = parseArgs({ options: { backend: { type: 'string' }, sources: { type: 'string' }, once: { type: 'boolean' }, interval: { type: 'string', default: '1000' } } });
if (!values.backend || !/^http:\/\/127\.0\.0\.1:\d+$/.test(values.backend) || !values.sources) throw new Error('--backend http://127.0.0.1:PORT --sources FILE required');
const sources = JSON.parse(await readFile(values.sources, 'utf8'));
if (!Array.isArray(sources)) throw new Error('sources must be an array');
const interval = Number(values.interval);
if (!Number.isFinite(interval) || interval < 100) throw new Error('interval must be at least 100 ms');
let closing = false;
const cursors = (await request(values.backend, '/api/cursors')).cursors;
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { closing = true; });
do {
  for (const source of sources) {
    try {
      const result = await collectAndCommit(values.backend, source, { previousCursor: cursors[source.sourceId] });
      cursors[source.sourceId] = result.cursor;
      console.log(JSON.stringify({ sourceId: source.sourceId, ...result }));
    }
    catch (error) { console.error(JSON.stringify({ sourceId: source.sourceId, error: error.message })); if (values.once) process.exitCode = 1; }
  }
  if (!closing && !values.once) await delay(interval);
} while (!closing && !values.once);
