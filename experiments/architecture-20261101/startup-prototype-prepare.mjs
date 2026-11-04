import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { launch } from './runner.mjs';
import { publishFormalSources } from './startup-prototype-adapter.mjs';
const directory = path.resolve(process.argv[3]); await mkdir(directory, { recursive: true });
const engine = await launch(process.argv[2], directory);
try { console.log(JSON.stringify({ variant: process.argv[2], ...await publishFormalSources({ backend: engine.baseUrl, directory, fresh: true }) })); }
finally { await engine.stop(); }
