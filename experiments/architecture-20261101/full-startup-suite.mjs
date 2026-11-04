import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve('experiments/architecture-20261101'), base = path.resolve('output/architecture-20261102/full-startup');
const capture = JSON.parse(await readFile(path.join(base, 'capture-pointer.json'), 'utf8')).file;
const variants = ['node-sqlite', 'rust-sqlite', 'rust-redb', 'rust-duckdb'];
const file = name => pathToFileURL(path.join(root, name)).href;
const envBase = { ...process.env, ARCH_STARTUP_REPLAY_FILE: capture, ARCH_NO_TRACE: '1', ARCH_STARTUP_BRIDGE: '1', ARCH_STARTUP_EXPORT_ROWS: '1' };
async function command(script, args, env) {
  await new Promise((resolve, reject) => { const child = spawn(process.execPath, [path.join(root, script), ...args], { env, windowsHide: true, stdio: 'inherit' }); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(script + ' exited ' + code))); });
}
const mode = process.argv[2] || 'prepare';
const label = process.env.ARCH_FULL_RUN_LABEL ? '-' + process.env.ARCH_FULL_RUN_LABEL : '';
if (mode === 'live') delete envBase.ARCH_STARTUP_REPLAY_FILE;
if (mode === 'prepare') {
  const indexed = path.join(base, 'seed-indexed'); await cp(path.join(base, 'formal-frozen-pending-1', 'state'), indexed, { recursive: true, preserveTimestamps: true });
  for (const scenario of ['indexed', 'pending']) for (const variant of variants) {
    const state = path.join(base, scenario === 'pending' ? 'seed' : 'seed-indexed');
    const env = { ...envBase, ARCH_STARTUP_STATE_MAP: JSON.stringify({ logicalRoot: 'C:\\Users\\Silver\\.codex-usage', physicalRoot: state }), NODE_OPTIONS: ['startup-state-overlay.mjs', 'startup-replay.mjs', 'startup-trace.mjs'].map(n => '--import=' + file(n)).join(' ') };
    await command('startup-prototype-prepare.mjs', [variant, path.join(base, 'proto-seeds', scenario, variant)], env);
  }
} else if (mode === 'hashes') {
  for (const scenario of ['indexed', 'pending']) {
    const state = path.join(base, scenario === 'pending' ? 'seed' : 'seed-indexed');
    const env = { ...envBase, ARCH_STARTUP_STATE_MAP: JSON.stringify({ logicalRoot: 'C:\\Users\\Silver\\.codex-usage', physicalRoot: state }), NODE_OPTIONS: ['startup-state-overlay.mjs', 'startup-replay.mjs', 'startup-trace.mjs'].map(n => '--import=' + file(n)).join(' ') };
    await command('startup-seed-hashes.mjs', [path.join(base, 'proto-seeds', scenario)], env);
  }
} else {
  const firstName = (mode === 'live' ? 'formal-live-check' : 'formal-indexed-u1') + label;
  if (await stat(path.join(base, firstName)).then(() => true, () => false)) throw Error('Output already exists; choose a new ARCH_FULL_RUN_LABEL');
  const repetitions = mode === 'live' ? 1 : Number(process.env.ARCH_FULL_REPETITIONS || '3');
  for (const scenario of mode === 'live' ? ['pending'] : ['indexed', 'pending']) for (let i = 1; i <= repetitions; i++) for (const variant of ['formal', ...variants]) {
    const env = { ...envBase, ARCH_STATE_SEED: path.join(base, scenario === 'pending' ? 'seed' : 'seed-indexed'), ARCH_FIRST_ONLY: mode === 'live' || i !== 1 ? '1' : '0' };
    if (variant !== 'formal') Object.assign(env, { ARCH_STARTUP_VARIANT: variant, ARCH_STARTUP_PROTO_SEED: path.join(base, 'proto-seeds', scenario, variant), ARCH_STARTUP_SERVER_WRAPPER: file('startup-prototype-wrapper.mjs') });
    const name = (mode === 'live' ? variant + '-live-check' : variant + '-' + scenario + '-u' + i) + label;
    try { await command('full-startup-run.mjs', [name], env); }
    catch (error) { console.error(JSON.stringify({ variant, scenario, repetition: i, failure: error.message })); }
  }
}
