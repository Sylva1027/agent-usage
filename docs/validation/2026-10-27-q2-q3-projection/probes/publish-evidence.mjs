import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const stage = path.dirname(fileURLToPath(import.meta.url));
const destination = path.resolve('docs/validation/2026-10-27-q2-q3-projection');
fs.mkdirSync(path.join(destination, 'evidence'), { recursive: true });
fs.mkdirSync(path.join(destination, 'probes'), { recursive: true });
const written = [];
function copy(source, relative) {
  if (!fs.existsSync(source)) return;
  fs.copyFileSync(source, path.join(destination, relative));
  written.push(relative);
}
for (const name of [
  'q2-paired-final-v3.mjs', 'q2-paired-final-v4.mjs', 'q3-executor-paired.mjs', 'append-paired.mjs', 'query-paired.mjs',
  'runtime-hook.mjs', 'execution-hook.mjs', 'runtime-http-browser.mjs', 'runtime-http-browser-before-fetch-clock.mjs', 'runtime-controls.mjs',
  'ledger-exact.mjs', 'runtime-retained.mjs', 'runtime-verify-inputs.mjs', 'run-measured.ps1',
  'run-remaining.ps1', 'summarize-results.mjs', 'publish-evidence.mjs', 'gates.mjs',
  'default-refresh-paired.mjs', 'default-refresh-paired-v3.mjs', 'default-refresh-paired-v4-initial.mjs',
  'run-default-check.ps1', 'run-final-browser.ps1', 'run-worst-phase.ps1', 'cleanup-databases.ps1',
]) copy(path.join(stage, name), 'probes/' + name);
for (const name of ['sqlite-accounting.mjs', 'sqlite-accounting-counterexamples.mjs']) {
  copy(path.join(stage, 'probes', name), 'probes/' + name);
}
copy(path.join(stage, 'probes/identity-after.json'), 'evidence/identity-final.json');
for (const name of fs.readdirSync(path.join(stage, 'evidence'))) {
  if (!/\.(?:json|jsonl|txt)$/.test(name)) continue;
  if (name.startsWith('device-load-')) {
    const source = path.join(stage, 'evidence', name);
    const value = JSON.parse(fs.readFileSync(source, 'utf8'));
    value.topProcesses = value.topProcesses.map(({ name, cpuSecondsDelta, workingSetBytes }) => ({
      name: ['node', 'pwsh'].includes(name) ? name : 'other-app', cpuSecondsDelta, workingSetBytes,
    }));
    value.rawArtifact = path.relative(process.cwd(), source);
    fs.writeFileSync(path.join(destination, 'evidence', name), JSON.stringify(value, null, 2));
    written.push('evidence/' + name);
    continue;
  }
  copy(path.join(stage, 'evidence', name), 'evidence/' + name);
}
for (const name of [
  'q2-formal-v4-results.json', 'q2-formal-v3-results.json', 'q2-formal-results.json', 'append-control-results.json',
  'query-paired-results.json', 'ledger-exact-results.json', 'retained-results.json',
  'summary.json', 'browser-final.png', 'browser-worst-phase.png', 'browser-controls.png',
  'default-today-results.json', 'default-month-results.json',
  'default-today-v3-results.json', 'default-month-v3-results.json',
  'default-today-v4-initial-results.json', 'default-month-v4-initial-results.json',
]) copy(path.join(stage, name), 'evidence/' + name);
// All raw dashboard payloads stay local; the review copy keeps each sample's timings and proof.
for (const name of ['q3-formal-results.json', 'q3-smoke-v5-results.json']) {
  const source = path.join(stage, name);
  if (!fs.existsSync(source)) continue;
  const value = JSON.parse(fs.readFileSync(source, 'utf8'));
  for (const sample of value.samples) delete sample.payload;
  value.rawPayloadArtifact = path.relative(process.cwd(), source);
  fs.writeFileSync(path.join(destination, 'evidence', name), JSON.stringify(value, null, 2));
  written.push('evidence/' + name);
}
for (const name of ['browser-final-results.json', 'browser-clock-failed-results.json', 'browser-worst-phase-results.json', 'browser-controls-results.json', 'browser-partial-v2-results.json']) {
  const source = path.join(stage, name);
  if (!fs.existsSync(source)) continue;
  const value = JSON.parse(fs.readFileSync(source, 'utf8'));
  for (const cycle of value.cycles) {
    for (const side of ['before', 'after']) {
      const key = side + 'Perf';
      const perf = cycle[key];
      if (!perf) continue;
      cycle[key + 'Hash'] = createHash('sha256').update(JSON.stringify(perf)).digest('hex');
      cycle[side + 'ControlledPerf'] = {
        model: perf.models.find(row => row.sourceKind === 'codex' && row.model === 'gpt-6-sol' && row.reasoningEffort === 'high'),
        coverage: perf.codexTimingCoverage,
      };
      delete cycle[key];
    }
  }
  value.rawPayloadArtifact = path.relative(process.cwd(), source);
  fs.writeFileSync(path.join(destination, 'evidence', name), JSON.stringify(value, null, 2));
  written.push('evidence/' + name);
}
fs.writeFileSync(path.join(destination, 'evidence', 'artifact-files.json'), JSON.stringify(written, null, 2));
console.log(JSON.stringify({ destination, files: written.length }));
