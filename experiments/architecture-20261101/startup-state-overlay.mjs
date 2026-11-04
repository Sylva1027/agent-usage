import fs from 'node:fs';
import fsp from 'node:fs/promises';
import sqlite from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports, registerHooks } from 'node:module';

// Keep the application's logical paths/cache signatures while isolating every state write.
const configuration = process.env.ARCH_STARTUP_STATE_MAP ? JSON.parse(process.env.ARCH_STARTUP_STATE_MAP) : null;
if (configuration) {
  const logical = path.resolve(configuration.logicalRoot), physical = path.resolve(configuration.physicalRoot);
  if (logical.toLowerCase() === physical.toLowerCase()) throw Error('Startup state overlay must use a private directory');
  const normalize = value => value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value;
  const mapped = value => {
    const text = normalize(value);
    if (typeof text !== 'string' || text === ':memory:' || text.startsWith('file:') || text.startsWith('node:')) return value;
    const resolved = path.resolve(text), lower = resolved.toLowerCase(), root = logical.toLowerCase();
    return lower === root || lower.startsWith(root + path.sep) ? physical + resolved.slice(logical.length) : value;
  };
  const single = ['access', 'appendFile', 'chmod', 'chown', 'exists', 'lchmod', 'lchown', 'lstat', 'lutimes', 'mkdir', 'mkdtemp',
    'open', 'opendir', 'readFile', 'readdir', 'readlink', 'realpath', 'rm', 'rmdir', 'stat', 'statfs', 'truncate', 'unlink', 'utimes', 'watch', 'watchFile', 'unwatchFile', 'writeFile'];
  for (const name of single) {
    for (const object of [fs, fsp]) {
      const original = object[name];
      if (typeof original === 'function') object[name] = function (file, ...args) { return Reflect.apply(original, this, [mapped(file), ...args]); };
    }
    const original = fs[name + 'Sync'];
    if (typeof original === 'function') fs[name + 'Sync'] = function (file, ...args) { return Reflect.apply(original, this, [mapped(file), ...args]); };
  }
  for (const name of ['copyFile', 'cp', 'link', 'rename', 'symlink']) {
    for (const object of [fs, fsp]) {
      const original = object[name];
      if (typeof original === 'function') object[name] = function (from, to, ...args) { return Reflect.apply(original, this, [mapped(from), mapped(to), ...args]); };
    }
    const original = fs[name + 'Sync'];
    if (typeof original === 'function') fs[name + 'Sync'] = function (from, to, ...args) { return Reflect.apply(original, this, [mapped(from), mapped(to), ...args]); };
  }
  for (const name of ['createReadStream', 'createWriteStream']) {
    const original = fs[name];
    fs[name] = function (file, ...args) { return Reflect.apply(original, this, [mapped(file), ...args]); };
  }
  const OriginalDatabase = sqlite.DatabaseSync;
  sqlite.DatabaseSync = new Proxy(OriginalDatabase, {
    construct(target, [file, ...args], newTarget) { return Reflect.construct(target, [mapped(file), ...args], newTarget); },
  });
  const originalBackup = sqlite.backup;
  sqlite.backup = (database, file, ...args) => originalBackup(database, mapped(file), ...args);
  syncBuiltinESMExports();
  // node:sqlite does not synchronize its named ESM exports through syncBuiltinESMExports.
  const shim = new URL('./startup-sqlite-overlay.mjs', import.meta.url).href;
  registerHooks({ resolve(specifier, context, nextResolve) {
    return specifier === 'node:sqlite' && context.parentURL !== shim
      ? { url: shim, shortCircuit: true } : nextResolve(specifier, context);
  } });
  globalThis[Symbol.for('architecture.startup.state')] = { logicalRoot: logical, physicalRoot: physical, mapPath: mapped };
}
