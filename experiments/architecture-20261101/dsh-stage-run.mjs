import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const label = process.argv[2];
if (!label || !/^[a-z0-9-]+$/i.test(label)) throw Error('Provide a new alphanumeric run label');
const diagnostic = process.argv[3] === 'diagnostic';
const directory = path.resolve('output/architecture-20261103/dsh-stage', label);
await mkdir(directory);
const base = path.resolve('output/architecture-20261102/full-startup');
const capture = JSON.parse(await readFile(path.join(base, 'capture-pointer.json'), 'utf8')).file;
const baseline = path.resolve('output/architecture-20261103/dsh-stage/baseline-dsh-usage.js');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = {
  label, baselineSha256: digest(await readFile(baseline)),
  candidateSha256: digest(await readFile('src/dsh-usage.js')),
  processCold: true, osCacheFlushed: false, diagnostic, capture, runs: [],
};
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
for (let round = 1; round <= (diagnostic ? 1 : 3); round++) {
  for (const variant of round % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']) {
    const name = `dsh-stage-${label}-${round}-${variant}`;
    const env = { ...process.env, ARCH_STATE_SEED: path.join(base, 'seed-empty'),
      ARCH_STARTUP_REPLAY_FILE: capture, ARCH_FIRST_ONLY: '1', ARCH_NO_TRACE: '1', ARCH_STARTUP_CUMULATIVE_INDEX: '0' };
    delete env.ARCH_STARTUP_SQL_DIR;
    delete env.ARCH_STARTUP_SERVER_WRAPPER;
    delete env.ARCH_STARTUP_PROTO_SEED;
    delete env.ARCH_STARTUP_BRIDGE;
    delete env.ARCH_DSH_PROBE_DIR;
    delete env.ARCH_DSH_BASELINE_FILE;
    if (variant === 'baseline') env.ARCH_DSH_BASELINE_FILE = baseline;
    if (diagnostic) {
      env.ARCH_NO_TRACE = '0';
      env.ARCH_STARTUP_SQL_DIR = path.join(directory, variant, 'sql');
      env.ARCH_DSH_PROBE_DIR = path.join(directory, variant, 'dsh');
    }
    console.log(JSON.stringify({ round, variant, name, stage: 'start' }));
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['experiments/architecture-20261101/full-startup-run.mjs', name],
        { env, windowsHide: true, stdio: 'inherit' });
      child.on('error', reject); child.on('exit', resolve);
    });
    manifest.runs.push({ round, variant, name, exitCode });
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
    if (exitCode !== 0) throw Error(`Run failed: ${name}; preserved as a failure`);
  }
}
