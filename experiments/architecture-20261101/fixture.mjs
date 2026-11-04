import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

export const NOW = '2026-11-01T12:00:00.000Z';
export const KINDS = ['codex', 'dsh', 'zcode', 'opencode', 'claude', 'workbuddy'];
export function makeFixture(count = 180) {
  const homes = KINDS.map(kind => ({ id: `fixture-${kind}`, label: kind, kind, path: `/fixture/${kind}` }));
  const events = Array.from({ length: count }, (_, i) => {
    const home = homes[i % homes.length];
    const input = 100 + i, cached = i % 25, output = 10 + i % 60;
    return {
      eventId: `event-${String(i).padStart(6, '0')}`, id: `event-${i}`, timestamp: new Date(Date.parse(NOW) - i * 3_600_000).toISOString(),
      sessionId: `session-${Math.floor(i / 3)}`, homeId: home.id, homeLabel: home.label, homePath: home.path,
      sourceKind: home.kind, channel: home.kind === 'codex' ? 'Codex' : home.label, source: home.kind,
      model: i % 2 ? 'claude-sonnet-4' : 'gpt-5', cwd: `/fixture/project-${i % 4}`,
      repositoryKey: `repo-${i % 3}`, repositoryKind: 'git', repositoryPath: `/fixture/repo-${i % 3}`,
      total: { input, cached, output, reasoning: i % 4, total: input + output },
      detailMask: 31, cacheWriteTokens: 0, cacheWriteKnown: true, requestInputTokens: input,
      contextLevel: 'short', serviceTier: 'default', priceVersion: 'current', quotaSource: 'plan',
    };
  });
  const observedAtMs = Date.parse(NOW) - 60_000;
  const rateLimitObservations = [
    { sourcePath: '/fixture/codex/session.jsonl', lineNumber: 1, role: 'primary', observedAtMs, limitId: 'codex', limitName: 'Codex', planType: 'plus', windowMinutes: 300, resetsAtMs: Date.parse(NOW) + 3_600_000, usedPercent: 25 },
    { sourcePath: '/fixture/codex/session.jsonl', lineNumber: 1, role: 'secondary', observedAtMs, limitId: 'codex', limitName: 'Codex', planType: 'plus', windowMinutes: 10080, resetsAtMs: Date.parse(NOW) + 86_400_000, usedPercent: 10 },
  ];
  return {
    sourceId: 'six-source-fixture', events, cursor: { fixture: 1, count },
    context: { homes, sessions: [], warnings: [], rateLimitObservations, generatedAt: NOW },
  };
}

export async function writeRawFixture(directory) {
  await mkdir(directory, { recursive: true });
  const codex = path.join(directory, 'codex.jsonl'), dsh = path.join(directory, 'session.v4.jsonl.zstd');
  const codexRows = [
    { type: 'session_meta', timestamp: NOW, payload: { id: 'raw-codex', cwd: '/fixture/project', source: 'cli', originator: 'codex_cli_rs' } },
    { type: 'turn_context', timestamp: NOW, payload: { model: 'gpt-5' } },
    { type: 'event_msg', timestamp: NOW, payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 2, total_tokens: 110 } } } },
  ];
  const dshRows = [
    { type: 'session', version: 4, id: 'raw-dsh', cwd: '/fixture/project', delegationDepth: 0, createdAt: Date.parse(NOW) },
    { type: 'request/header', time: Date.parse(NOW), data: { header: { config: { model: 'deepseek-chat', provider: 'deepseek' } } } },
    { type: 'assistant/message', seq: 1, time: Date.parse(NOW), data: { usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 0, outputTokens: 10, totalTokens: 130 } } },
  ];
  await writeFile(codex, codexRows.map(row => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(dsh, Buffer.concat(dshRows.map(row => zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n')))));
  const sources = [
    { sourceId: 'raw-codex', kind: 'codex', path: codex, home: { id: 'raw-codex-home', label: 'Codex', kind: 'codex', path: directory } },
    { sourceId: 'raw-dsh', kind: 'dsh', path: dsh, home: { id: 'raw-dsh-home', label: 'DSH', kind: 'dsh', path: directory } },
  ];
  await writeFile(path.join(directory, 'sources.json'), JSON.stringify(sources, null, 2));
  return { sources, codexRows, dshRows };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const destination = path.resolve(process.argv[2] || 'output/architecture-20261101/fixture.json');
  await mkdir(path.dirname(destination), { recursive: true });
  const fixture = makeFixture(Number(process.argv[3] || 180));
  await writeFile(destination, JSON.stringify(fixture, null, 2));
  await writeRawFixture(path.join(path.dirname(destination), 'raw'));
  console.log(JSON.stringify({ destination, eventCount: fixture.events.length }));
}
