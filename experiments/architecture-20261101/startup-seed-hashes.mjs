import path from 'node:path';
import { addSeedPayloadHashes } from './startup-prototype-adapter.mjs';
console.log(JSON.stringify(await addSeedPayloadHashes(['node-sqlite', 'rust-sqlite', 'rust-redb', 'rust-duckdb'].map(v => path.join(process.argv[2], v)))));
