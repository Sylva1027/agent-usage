import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const VARIANTS = ['node-sqlite', 'rust-sqlite', 'rust-redb', 'rust-duckdb'];
export async function launch(variant, directory, extra = [], spawnOptions = {}) {
  if (!VARIANTS.includes(variant)) throw new Error(`Unknown variant: ${variant}`);
  const database = path.join(directory, variant + (variant.endsWith('redb') ? '.redb' : variant.endsWith('duckdb') ? '.duckdb' : '.sqlite'));
  const executable = process.env.ARCH_NATIVE_BIN || path.join(ROOT, 'native', 'target', 'release', process.platform === 'win32' ? 'architecture-prototype.exe' : 'architecture-prototype');
  const args = variant === 'node-sqlite'
    ? [path.join(ROOT, 'node', 'server.mjs'), '--database', database, '--port', '0', '--web', path.join(ROOT, 'web.html'), ...extra]
    : ['--backend', variant.replace('rust-', ''), '--database', database, '--port', '0', '--web', path.join(ROOT, 'web.html'), ...extra];
  const child = spawn(variant === 'node-sqlite' ? process.execPath : executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...spawnOptions });
  let stderr = '', pending = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Startup timeout ${variant}: ${stderr}`)); }, 30_000);
    const finish = (error, value) => { clearTimeout(timer); error ? reject(error) : resolve(value); };
    child.once('error', error => finish(error));
    child.once('exit', code => finish(new Error(`${variant} exited ${code}: ${stderr}`)));
    child.stdout.on('data', chunk => {
      pending += chunk.toString();
      let index;
      while ((index = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        try { const message = JSON.parse(line); if (message.port) finish(null, message); } catch { /* compiler/runtime text is not readiness */ }
      }
    });
  });
  const baseUrl = `http://127.0.0.1:${ready.port}`;
  return { child, baseUrl, database, ready, stderr: () => stderr, async crash() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, 'exit'); child.kill('SIGKILL'); await done;
  }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, 'exit'); child.kill();
    await Promise.race([done, new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000); timer.unref(); })]);
  } };
}
export async function request(baseUrl, route, body) {
  const response = await fetch(baseUrl + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(`${response.status}: ${JSON.stringify(data)}`), { status: response.status, data });
  return data;
}
