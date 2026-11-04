import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { injectStartupOptions } from './startup-options.mjs';

test('light configuration hook preserves caller fields and overrides experiment options', () => {
  const key = Symbol.for('architecture.startup.options');
  globalThis[key] = { homeDir: 'private', automaticDiscoveryEnabled: false };
  try {
    const source = injectStartupOptions('export function createUsageServer(options = {}) { return options; }');
    const factory = new Function(source.replace('export ', '') + '\nreturn createUsageServer;')();
    assert.deepEqual(factory({ host: '127.0.0.1', homeDir: 'caller' }), {
      host: '127.0.0.1', homeDir: 'private', automaticDiscoveryEnabled: false,
    });
    assert.deepEqual(factory(null), globalThis[key]);
    assert.throws(() => injectStartupOptions('unexpected signature'), /one server factory/);
    assert.ok(injectStartupOptions(readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8')));
  } finally { delete globalThis[key]; }
});
