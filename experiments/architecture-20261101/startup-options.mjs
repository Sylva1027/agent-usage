import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const optionKey = Symbol.for('architecture.startup.options');
const anchor = 'export function createUsageServer(options = {}) {';
export function injectStartupOptions(source) {
  assert.equal(source.split(anchor).length, 2, 'Expected exactly one server factory');
  return source.replace(anchor, `${anchor}\n  options = { ...(options && typeof options === 'object' && !Array.isArray(options) ? options : {}), ...globalThis[Symbol.for('architecture.startup.options')] };`);
}
if (process.env.ARCH_STARTUP_OPTIONS_FILE) {
  const options = JSON.parse(readFileSync(process.env.ARCH_STARTUP_OPTIONS_FILE, 'utf8'));
  assert.ok(options && typeof options === 'object' && !Array.isArray(options));
  globalThis[optionKey] = options;
  const serverUrl = new URL('../../src/server.js', import.meta.url).href;
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== serverUrl) return result;
    const source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    return { ...result, source: injectStartupOptions(source) };
  } });
}
