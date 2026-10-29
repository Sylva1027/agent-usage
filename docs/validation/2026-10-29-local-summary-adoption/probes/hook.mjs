import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
const config=JSON.parse(fs.readFileSync(process.env.LOCAL_SUMMARY_CASE_CONFIG,'utf8'));
await import(pathToFileURL(config.originalHookFile).href);
const scratch=path.join(path.dirname(config.options.databaseFile),'snapshot-temp');
fs.mkdirSync(scratch,{recursive:true});
// Native SQLite backup bypasses the filesystem mapping; keep its target inside the private tree.
os.tmpdir=()=>scratch;
syncBuiltinESMExports();
