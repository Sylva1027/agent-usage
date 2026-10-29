import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { streamWorkbuddyPerfSamples } from "../src/perf-sources/workbuddy.js";
import {
  createWorkbuddyTextTimingLookup,
  streamWorkbuddySessionEvents,
  workbuddyGenerationSpans,
  workbuddyLogSnapshot,
  workbuddyTextTimingSpans,
} from "../src/workbuddy-usage.js";

const MESSAGE_ID = "message-text-1";
const MODEL = "deepseek-v4.1-flash";

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function sessionRows({ outputTokens = 120, reasoningTokens = 20, model = MODEL } = {}) {
  const provider = {
    messageId: MESSAGE_ID,
    model,
    traceId: "session-trace",
    conversationRequestId: "conversation-1",
  };
  const reasoning =
    reasoningTokens > 0
      ? [
          {
            type: "reasoning",
            providerData: provider,
            rawContent: [{ type: "reasoning_text" }],
          },
        ]
      : [];
  return [
    ...reasoning,
    {
      timestamp: 1792537466382,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text" }],
      sessionId: "session-1",
      cwd: "/work/demo",
      providerData: {
        ...provider,
        usage: {
          inputTokens: 1000,
          outputTokens,
          totalTokens: 1000 + outputTokens,
          inputTokensDetails: [{ cached_tokens: 0 }],
          outputTokensDetails: [{ reasoning_tokens: reasoningTokens }],
        },
      },
    },
  ];
}

function endRecord(overrides = {}) {
  return {
    message_id: MESSAGE_ID,
    finish_flag: "done",
    finish_reason: "stop",
    model: MODEL,
    conversation_request_id: "conversation-1",
    model_error: "",
    http_begin_status_code: 200,
    http_end_status_code: 200,
    trace_id: "session-trace",
    completion_tokens: 120,
    text_first_cost_ms: 100,
    text_total_cost_ms: 500,
    think_first_cost_ms: 20,
    think_total_cost_ms: 30,
    text_content_chars: 6,
    text_content_bytes: 6,
    text_total_tokens: 2,
    think_content_chars: 4,
    think_content_bytes: 4,
    think_total_tokens: 1,
    ...overrides,
  };
}

function traceRows({ descendantTool = false, outputTokens = 120, reasoningTokens = 20, model = MODEL } = {}) {
  const output = [
    {
      id: MESSAGE_ID,
      created: 1792537466,
      model,
      object: "chat.completion",
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "answer",
            refusal: null,
            tool_calls: [],
          },
        },
      ],
      usage: {
        completion_tokens: outputTokens,
        completion_tokens_details: {
          reasoning_tokens: reasoningTokens,
          accepted_prediction_tokens: 0,
          audio_tokens: 0,
          rejected_prediction_tokens: 0,
          cached_tokens: 0,
        },
      },
    },
  ];
  const rows = [
    {
      type: "span_end",
      span: {
        traceId: "generation-trace",
        spanId: "root",
        parentId: "",
        type: "agent",
        status: "ok",
      },
    },
    {
      type: "span_end",
      span: {
        traceId: "generation-trace",
        spanId: "generation",
        parentId: "root",
        name: "generation",
        type: "generation",
        status: "ok",
        startedAt: "2026-10-21T00:08:41.249Z",
        endedAt: "2026-10-21T00:08:56.704Z",
        duration: 15455,
        attributes: {
          tracePayloadTruncated: true,
          tracePayloadTruncatedFields: ["toolInput"],
        },
        toolOutput: JSON.stringify(output),
      },
    },
  ];
  if (descendantTool) {
    rows.push({
      type: "span_end",
      span: {
        traceId: "generation-trace",
        spanId: "tool",
        parentId: "generation",
        type: "function",
        status: "ok",
      },
    });
  }
  return rows;
}

async function withHome(fn, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "workbuddy-native-text-"));
  const home = path.join(root, ".workbuddy-ai");
  const project = path.join(home, "projects", "slug");
  const trace = path.join(home, "traces", "100");
  const log = path.join(home, "logs", "2026-10-29", "nested");
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(trace, { recursive: true }),
    mkdir(log, { recursive: true }),
  ]);
  try {
    const sessionFile = path.join(project, "session-1.jsonl");
    const traceFile = path.join(trace, "trace_a.jsonl");
    const logFile = path.join(log, "main.log");
    await writeFile(sessionFile, jsonl(sessionRows(options.session)));
    await writeFile(traceFile, jsonl(traceRows(options.trace)));
    await writeFile(logFile, `timestamp qua.end ${JSON.stringify(endRecord(options.end))}\n`);
    return await fn({ root, home, sessionFile, traceFile, logFile });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function collectSessionProof(sessionFile) {
  const events = [];
  await streamWorkbuddySessionEvents(sessionFile, { id: "home", path: path.dirname(sessionFile) }, (event) =>
    events.push(event),
  );
  assert.equal(events.length, 1);
  return events[0];
}

test("log snapshot is bounded to dated logs, skips sandbox, and fingerprints changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workbuddy-log-snapshot-"));
  const home = path.join(root, ".workbuddy-ai");
  const day = path.join(home, "logs", "2026-10-29", "nested");
  const sandbox = path.join(home, "logs", "2026-10-29", "sandbox");
  const notDay = path.join(home, "logs", "Crash-Log");
  await Promise.all([
    mkdir(day, { recursive: true }),
    mkdir(sandbox, { recursive: true }),
    mkdir(notDay, { recursive: true }),
  ]);
  try {
    const included = path.join(day, "main.log");
    await writeFile(included, "secret-body qua.end {}\n");
    await writeFile(path.join(sandbox, "ignored.log"), "sandbox\n");
    await writeFile(path.join(notDay, "ignored.log"), "not-a-day\n");
    const first = await workbuddyLogSnapshot(home);
    assert.deepEqual(first.files, [included]);
    assert.equal(first.complete, true);
    assert.equal(typeof first.fingerprints[included], "string");
    assert.equal(JSON.stringify(first).includes("secret-body"), false);

    await writeFile(included, "secret-body changed qua.end {}\n");
    const second = await workbuddyLogSnapshot(home);
    assert.notEqual(second.fingerprint, first.fingerprint);
    assert.notEqual(second.fingerprints[included], first.fingerprints[included]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("three-side scalar closure publishes text D and keeps trace E2E diagnostic separate", async () => {
  await withHome(async ({ home, sessionFile, logFile }) => {
    const event = await collectSessionProof(sessionFile);
    assert.equal(event.nativeProof.textOnly, true);
    assert.equal(event.nativeProof.outputTokens, 120);
    assert.equal(event.nativeProof.reasoningTokens, 20);
    assert.equal(event.nativeProof.reasoningBeforeText, true);
    assert.equal(JSON.stringify(event.nativeProof).includes("answer"), false);

    const textSpans = await workbuddyTextTimingSpans(logFile);
    const generationSpans = await workbuddyGenerationSpans(home);
    assert.equal(textSpans[0].outputTokens, 120);
    assert.equal(textSpans[0].phaseGate.terminal, true);
    assert.equal(textSpans[0].phaseGate.reasoningTiming, "before_text");
    assert.equal(generationSpans[0].durationMs, 15455);
    assert.equal(generationSpans[0].evidence.descendantToolCount, 0);
    assert.equal(JSON.stringify(textSpans).includes("answer"), false);

    const lookupTextTiming = createWorkbuddyTextTimingLookup(textSpans, generationSpans);
    const timing = lookupTextTiming(MESSAGE_ID);
    assert.equal(timing.durationMs, 500);
    assert.equal(timing.outputTokens, 120);
    assert.equal(timing.reasoningTokens, 20);
    assert.equal(timing.nonReasoningTokens, 100);

    const samples = [];
    const result = await streamWorkbuddyPerfSamples(
      sessionFile,
      { id: "home", path: home },
      (sample) => samples.push(sample),
      {
        lookupGenerationDuration: () => ({ durationMs: 15455 }),
        lookupTextTiming,
      },
    );
    assert.equal(samples.length, 1);
    assert.equal(samples[0].outputTokens, 99, "first/last text window uses N-1");
    assert.equal(samples[0].durationMs, 500, "text_total_cost_ms is D");
    assert.equal(samples[0].reportedDurationMs, 15455, "generation duration stays E2E diagnostic");
    assert.equal(samples[0].timingSource, "explicit");
    assert.equal(result.stats.textTimingSamples, 1);
    assert.equal(result.stats.missingTextTiming, 0);
    assert.equal(result.stats.missingGenerationDuration, 0);
  });
});

test("session output mismatch leaves the candidate without text D", async () => {
  await withHome(
    async ({ home, sessionFile }) => {
      const textSpans = await workbuddyTextTimingSpans(path.join(home, "logs", "2026-10-29", "nested", "main.log"));
      const lookupTextTiming = createWorkbuddyTextTimingLookup(textSpans, await workbuddyGenerationSpans(home));
      const samples = [];
      await streamWorkbuddyPerfSamples(sessionFile, { id: "home", path: home }, (sample) => samples.push(sample), {
        lookupTextTiming,
      });
      assert.equal(samples[0].durationMs, null);
      assert.equal(samples[0].timingSource, "unknown");
    },
    { session: { outputTokens: 121 } },
  );
});

test("end/trace output mismatch, reasoning overlap, and duplicate non-equivalent ends fail closed", async () => {
  await withHome(async ({ home, logFile }) => {
    const generationSpans = await workbuddyGenerationSpans(home);
    const good = (await workbuddyTextTimingSpans(logFile))[0];
    assert.equal(createWorkbuddyTextTimingLookup([good], generationSpans)(MESSAGE_ID).durationMs, 500);

    const duplicateEquivalent = createWorkbuddyTextTimingLookup([good, { ...good }], generationSpans);
    assert.equal(duplicateEquivalent(MESSAGE_ID).durationMs, 500);

    const charCountMismatch = { ...good, textChars: 5, evidenceKey: "unicode-char-count" };
    assert.equal(createWorkbuddyTextTimingLookup([charCountMismatch], generationSpans)(MESSAGE_ID).durationMs, 500);

    const conflicting = { ...good, finishReason: "tool_calls", evidenceKey: "different" };
    const conflictLookup = createWorkbuddyTextTimingLookup([good, conflicting], generationSpans);
    assert.equal(conflictLookup(MESSAGE_ID), null);

    const overlap = {
      ...good,
      thinkFirstMs: 200,
      thinkTotalMs: 100,
      phaseGate: { ...good.phaseGate, reasoningTiming: "overlaps_text" },
      evidenceKey: "overlap",
    };
    assert.equal(createWorkbuddyTextTimingLookup([overlap], generationSpans)(MESSAGE_ID), null);

    const endMismatch = { ...good, outputTokens: 121, evidenceKey: "output-mismatch" };
    assert.equal(createWorkbuddyTextTimingLookup([endMismatch], generationSpans)(MESSAGE_ID), null);
  });
});

test("two text tokens over 20ms use one inter-token interval for 50 TPS despite model aliases", async () => {
  await withHome(
    async ({ home, sessionFile, logFile }) => {
      const textSpans = await workbuddyTextTimingSpans(logFile);
      const generationSpans = await workbuddyGenerationSpans(home);
      const lookupTextTiming = createWorkbuddyTextTimingLookup(textSpans, generationSpans);
      assert.equal(lookupTextTiming(MESSAGE_ID)?.durationMs, 20);
      const event = await collectSessionProof(sessionFile);
      assert.equal(event.nativeProof.textOnly, true);
      assert.equal(event.nativeProof.reasoningBeforeText, true);
      const samples = [];
      const result = await streamWorkbuddyPerfSamples(
        sessionFile,
        { id: "home", path: home },
        (sample) => samples.push(sample),
        {
          lookupTextTiming,
        },
      );
      assert.equal(samples[0].outputTokens, 1);
      assert.equal(samples[0].durationMs, 20);
      assert.equal((samples[0].outputTokens * 1000) / samples[0].durationMs, 50);
      assert.equal(result.stats.missingGenerationDuration, 0);
    },
    {
      session: { outputTokens: 2, reasoningTokens: 0, model: "session-alias" },
      trace: { outputTokens: 2, reasoningTokens: 0, model: "trace-resolved" },
      end: {
        model: "request-resolved",
        completion_tokens: 2,
        text_first_cost_ms: 5,
        text_total_cost_ms: 20,
        think_first_cost_ms: 0,
        think_total_cost_ms: 0,
        text_content_chars: 2,
        text_content_bytes: 2,
        text_total_tokens: 2,
        think_content_chars: 0,
        think_content_bytes: 0,
        think_total_tokens: 0,
      },
    },
  );
});

test("generation descendant tool spans block text D", async () => {
  await withHome(
    async ({ home, logFile }) => {
      const textSpans = await workbuddyTextTimingSpans(logFile);
      const generationSpans = await workbuddyGenerationSpans(home);
      assert.equal(generationSpans[0].evidence.descendantToolCount, 1);
      assert.equal(createWorkbuddyTextTimingLookup(textSpans, generationSpans)(MESSAGE_ID), null);
    },
    { trace: { descendantTool: true } },
  );
});
