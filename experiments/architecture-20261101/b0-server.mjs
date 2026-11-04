import { parseArgs } from 'node:util';
import path from 'node:path';
import { createUsageServer } from '../../src/server.js';
import { getPricingCatalog } from '../../src/pricing.js';

const { values } = parseArgs({ options: { database: { type: 'string' }, directory: { type: 'string' } } });
if (!values.database || !values.directory) throw new Error('--database and --directory required');
const directory = path.resolve(values.directory);
// The existing import path prevents live discovery and pricing mutation of the trial.
const server = createUsageServer({ databaseFile: path.resolve(values.database), homeDir: directory,
  env: {}, importStoreFile: path.join(directory, 'imports.json'),
  pricingFile: path.join(directory, 'pricing.json'),
  importContext: { pricingCatalog: getPricingCatalog(), automaticPricingStatus: null, serviceTierEvidenceSnapshot: null } });
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port, layer: 'B0-frozen-import-index' })));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); });
