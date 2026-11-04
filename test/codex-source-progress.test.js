import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { createQuotaSourceTracker } from "../public/quota-usage.js";
import { streamUsageFileEvents } from "../src/usage-core.js";

const SESSION_ID = "progress-session";
const START = "2026-11-03T01:00:00.000Z";
const RESET_AT = Date.parse("2026-11-03T02:00:00.000Z") / 1000;

function usage(total) {
  return {
    total_tokens: total,
    input_tokens: total,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
  };
}

function tokenRow(timestamp, total, lastTotal, rate = {}) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage(total),
        last_token_usage: usage(lastTotal),
      },
      rate_limits: {
        limit_id: "codex",
        ...(rate.omitCredits ? {} : { credits: { has_credits: rate.credits ?? true } }),
        primary: {
          used_percent: rate.usedPercent ?? 100,
          window_minutes: 300,
          resets_at: rate.resetsAt ?? RESET_AT,
        },
      },
    },
  };
}

function line(row) {
  return `${JSON.stringify(row)}\r\n`;
}

async function collect(filePath, options = {}) {
  const events = [];
  const observations = [];
  const quotaSources = [];
  const progress = [];
  const parseOptions = {
    repositoryResolver: async (cwd) => ({
      key: `directory:${cwd}`,
      path: cwd,
      kind: "directory",
    }),
    onRateLimit: (observation) => observations.push(observation),
    onQuotaSource: (source) => quotaSources.push(source),
    ...options,
  };
  delete parseOptions.progress;
  if (options.progress) {
    parseOptions.onProgress = (checkpoint) => progress.push(checkpoint);
  }
  await streamUsageFileEvents(
    filePath,
    { id: "main", label: "Main Codex", path: path.dirname(filePath), kind: "main" },
    (event) => events.push(event),
    parseOptions,
  );
  return { events, observations, quotaSources, progress };
}

test("quota tracker snapshots restore provider and credits routing state", () => {
  const tracker = createQuotaSourceTracker({
    provider: "openai",
    hasCredits: true,
    creditsUntil: 2_000,
    recovered: false,
  });
  assert.equal(tracker({ timestamp: new Date(1_000).toISOString() }).quotaSource, "credits");
  const snapshot = tracker.snapshot();
  assert.deepEqual(snapshot, {
    provider: "openai",
    hasCredits: true,
    creditsUntil: 2_000,
    recovered: false,
  });
  assert.equal(createQuotaSourceTracker(snapshot)({ timestamp: new Date(1_500).toISOString() }).quotaSource, "credits");
  assert.equal(
    createQuotaSourceTracker({ provider: "external" })({ timestamp: new Date(1_500).toISOString() }).quotaSource,
    "external",
  );
});

test("initial plus resumed Codex JSONL matches one full parse across parser and quota state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-progress-parity-"));
  const filePath = path.join(root, "rollout-progress.jsonl");
  const initialRows = [
    {
      timestamp: START,
      type: "session_meta",
      payload: {
        id: SESSION_ID,
        source: "cli",
        originator: "codex-tui",
        cwd: "/work/项目",
        model_provider: "openai",
      },
    },
    {
      timestamp: START,
      type: "turn_context",
      payload: { model: "gpt-5.1-codex" },
    },
    tokenRow("2026-11-03T01:01:00.000Z", 100, 100, { usedPercent: 100, credits: true }),
  ];
  const initialText = initialRows.map(line).join("");
  await writeFile(filePath, initialText);

  let baselineCalls = 0;
  const initial = await collect(filePath, {
    progress: true,
    endOffset: Buffer.byteLength(initialText),
    previousCumulativeForSession: () => {
      baselineCalls += 1;
      return {
        usage: { total: 40, input: 40, cached: 0, output: 0, reasoning: 0 },
        detailMask: 15,
        cacheWrite: { tokens: 0, known: true },
      };
    },
  });
  assert.equal(initial.progress.length, 1);
  const checkpoint = initial.progress[0];
  assert.ok(checkpoint);
  assert.deepEqual(JSON.parse(JSON.stringify(checkpoint)), checkpoint);
  assert.equal(checkpoint.offset, Buffer.byteLength(initialText));
  assert.equal(checkpoint.lineNumber, 3);
  assert.equal(checkpoint.state.meta.id, SESSION_ID);
  assert.equal(checkpoint.state.model, "gpt-5.1-codex");
  assert.equal(checkpoint.state.previousCumulative.total, 100);
  assert.equal(checkpoint.state.baselineLoaded, true);
  assert.equal(checkpoint.state.quota.provider, "openai");
  assert.equal(checkpoint.state.quota.hasCredits, true);
  assert.equal(checkpoint.state.quota.creditsUntil, RESET_AT * 1000);
  assert.equal(checkpoint.state.quota.recovered, false);

  const suffixRows = [
    {
      timestamp: "2026-11-03T01:01:30.000Z",
      type: "note",
      text: `跨块 Unicode ${"漢".repeat(70_000)}`,
    },
    {
      timestamp: "2026-11-03T01:01:40.000Z",
      type: "turn_context",
      payload: { model: "gpt-6-late-context" },
    },
    tokenRow("2026-11-03T01:01:50.000Z", 130, 30, { usedPercent: 100, omitCredits: true }),
    {
      timestamp: "2026-11-03T01:01:55.000Z",
      type: "session_meta",
      payload: { originator: "codex-vscode" },
    },
    tokenRow("2026-11-03T01:02:00.000Z", 100, 0, { usedPercent: 1, credits: true }),
    tokenRow("2026-11-03T01:03:00.000Z", 50, 0, { usedPercent: 20, credits: true }),
    tokenRow("2026-11-03T01:04:00.000Z", 80, 30, { usedPercent: 21, credits: true }),
    { timestamp: "2026-11-03T01:05:00.000Z", type: "note", text: "tail" },
  ];
  const suffixText = `${suffixRows.slice(0, 5).map(line).join("")}{malformed}\r\n\r\n${suffixRows
    .slice(5)
    .map(line)
    .join("")}`;
  await appendFile(filePath, suffixText);

  const resumed = await collect(filePath, {
    progress: true,
    resume: checkpoint,
    endOffset: Buffer.byteLength(initialText + suffixText),
    previousCumulativeForSession: () => {
      throw new Error("resume must use its saved cross-file baseline");
    },
  });
  const full = await collect(filePath, {
    previousCumulativeForSession: () => ({
      usage: { total: 40, input: 40, cached: 0, output: 0, reasoning: 0 },
      detailMask: 15,
      cacheWrite: { tokens: 0, known: true },
    }),
  });

  assert.equal(baselineCalls, 1);
  assert.equal(resumed.progress.length, 1);
  assert.ok(resumed.progress[0]);
  assert.equal(resumed.progress[0].offset, Buffer.byteLength(initialText + suffixText));
  assert.equal(resumed.progress[0].lineNumber, 13);
  assert.equal(resumed.progress[0].state.quota.recovered, true);
  assert.deepEqual([...initial.events, ...resumed.events], full.events);
  assert.deepEqual([...initial.quotaSources, ...resumed.quotaSources], full.quotaSources);
  assert.deepEqual([...initial.observations, ...resumed.observations], full.observations);
  assert.deepEqual(
    initial.events.map((event) => event.usage.total),
    [60],
  );
  assert.deepEqual(
    resumed.events.map((event) => event.usage.total),
    [30, 30],
  );
  assert.equal(resumed.events[0].model, "gpt-6-late-context");
  assert.equal(resumed.events[0].sessionId, SESSION_ID);
  assert.equal(resumed.events[0].project, "/work/项目");
  assert.equal(resumed.events[0].quotaSource, "credits");
  assert.equal(resumed.events[1].quotaSource, "plan");
});

test("progress keeps the last complete boundary through partial and invalid tails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-progress-tail-"));
  const partialPath = path.join(root, "partial.jsonl");
  const prefix = line({
    timestamp: START,
    type: "session_meta",
    payload: { id: SESSION_ID, source: "cli", cwd: "/work/project" },
  });
  await writeFile(partialPath, `${prefix}{"timestamp":"${START}","type":"event_msg"`);

  const invalidTail = await collect(partialPath, { progress: true });
  assert.equal(invalidTail.progress.length, 1);
  assert.equal(invalidTail.progress[0].offset, Buffer.byteLength(prefix));
  assert.equal(invalidTail.progress[0].lineNumber, 1);

  const limitedPath = path.join(root, "limited.jsonl");
  const tokenText = line(tokenRow("2026-11-03T01:01:00.000Z", 100, 100));
  await writeFile(limitedPath, prefix + tokenText);
  const limited = await collect(limitedPath, {
    progress: true,
    endOffset: Buffer.byteLength(prefix) + 20,
  });
  assert.deepEqual(limited.events, []);
  assert.equal(limited.progress[0].offset, Buffer.byteLength(prefix));
  assert.equal(limited.progress[0].lineNumber, 1);

  const resumed = await collect(limitedPath, { progress: true, resume: limited.progress[0] });
  assert.equal(resumed.events.length, 1);
  assert.equal(resumed.events[0].usage.total, 100);
  assert.equal(resumed.progress[0].lineNumber, 2);

  const unterminatedPath = path.join(root, "unterminated.jsonl");
  await writeFile(unterminatedPath, JSON.stringify(tokenRow("2026-11-03T01:01:00.000Z", 100, 100)));
  const unterminated = await collect(unterminatedPath, { progress: true });
  assert.equal(unterminated.events.length, 1);
  assert.deepEqual(unterminated.progress, [null]);

  const unterminatedAtLimit = await collect(unterminatedPath, {
    progress: true,
    endOffset: Buffer.byteLength(JSON.stringify(tokenRow("2026-11-03T01:01:00.000Z", 100, 100))),
  });
  assert.equal(unterminatedAtLimit.events.length, 1);
  assert.deepEqual(unterminatedAtLimit.progress, [null]);
});

test("valid JSON null keeps the legacy parser failure in default and progress modes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-progress-null-"));
  const filePath = path.join(root, "rollout.jsonl");
  await writeFile(filePath, "null\r\n");
  const source = { id: "main", label: "Main Codex", path: root, kind: "main" };

  await assert.rejects(
    streamUsageFileEvents(filePath, source, () => {}),
    TypeError,
  );
  const progress = [];
  await assert.rejects(
    streamUsageFileEvents(filePath, source, () => {}, {
      onProgress: (checkpoint) => progress.push(checkpoint),
    }),
    TypeError,
  );
  assert.deepEqual(progress, []);
});

test("a fixed endOffset beyond physical EOF fails without advancing progress", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-progress-short-read-"));
  const filePath = path.join(root, "rollout.jsonl");
  const text = line({
    timestamp: START,
    type: "session_meta",
    payload: { id: SESSION_ID, source: "cli", cwd: "/work/project" },
  });
  await writeFile(filePath, text);
  const source = { id: "main", label: "Main Codex", path: root, kind: "main" };

  const initial = await collect(filePath, { progress: true });
  const checkpoint = initial.progress[0];
  const originalCheckpoint = structuredClone(checkpoint);
  const resumedProgress = [];
  await assert.rejects(
    streamUsageFileEvents(filePath, source, () => {}, {
      resume: checkpoint,
      endOffset: checkpoint.offset + 1,
      onProgress: (value) => resumedProgress.push(value),
    }),
    (error) => error.code === "SOURCE_PROGRESS_UNSUPPORTED",
  );
  assert.deepEqual(resumedProgress, []);
  assert.deepEqual(checkpoint, originalCheckpoint);

  const initialProgress = [];
  await assert.rejects(
    streamUsageFileEvents(filePath, source, () => {}, {
      endOffset: Buffer.byteLength(text) + 1,
      onProgress: (value) => initialProgress.push(value),
    }),
    (error) => error.code === "SOURCE_PROGRESS_UNSUPPORTED",
  );
  assert.deepEqual(initialProgress, []);
});

test("unsupported checkpoints fail with the stable source-progress code", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-progress-unsupported-"));
  const filePath = path.join(root, "rollout.jsonl");
  const text = line({
    timestamp: START,
    type: "session_meta",
    payload: { id: SESSION_ID, source: "cli", cwd: "/work/project" },
  });
  await writeFile(filePath, text);
  const initial = await collect(filePath, { progress: true });
  const checkpoint = initial.progress[0];

  for (const candidate of [
    { ...checkpoint, format: 2 },
    { ...checkpoint, adapter: "other" },
    { ...checkpoint, state: { ...checkpoint.state, previousCumulative: null } },
    null,
  ]) {
    await assert.rejects(
      collect(filePath, { progress: true, resume: candidate }),
      (error) => error.code === "SOURCE_PROGRESS_UNSUPPORTED",
    );
  }
});

test("compressed Codex rollouts retain verified full parsing and report null progress", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "codex-progress-zstd-"));
  const plainPath = path.join(root, "rollout.jsonl");
  const compressedPath = `${plainPath}.zst`;
  const text = `${line({
    timestamp: START,
    type: "session_meta",
    payload: { id: SESSION_ID, source: "cli", cwd: "/work/project" },
  })}${line(tokenRow("2026-11-03T01:01:00.000Z", 100, 100))}`;
  await writeFile(plainPath, text);
  await writeFile(compressedPath, zstdCompressSync(text));

  const plain = await collect(plainPath);
  const compressed = await collect(compressedPath, { progress: true });
  assert.deepEqual(compressed.events, plain.events);
  assert.deepEqual(compressed.progress, [null]);
});
