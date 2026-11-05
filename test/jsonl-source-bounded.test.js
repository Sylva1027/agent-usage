import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { streamClaudeSessionEvents } from "../src/claude-code-usage.js";
import { UsageSourceRows } from "../src/usage-source-rows.js";
import { streamWorkbuddySessionEvents } from "../src/workbuddy-usage.js";

const HOME = { id: "bounded-home", label: "Bounded home", path: "/unused" };
const TIME = 1793836800000;
const IDS = ["é", "e\u0301", "Å", "A\u030a", "2", "10", "02", "a-b", "a_b", "a.b", "!", "中", "𐐀", "a", "A"];
const BODY = `BODY_SECRET_${"x".repeat(8192)}`;

function claude(id, { usage = {}, ...overrides } = {}) {
  return {
    type: "assistant",
    uuid: `uuid-${id}`,
    sessionId: "session",
    timestamp: new Date(TIME).toISOString(),
    cwd: "/project",
    ...overrides,
    message: {
      id,
      model: "claude-sonnet-4-5-20250929",
      content: BODY,
      usage: {
        input_tokens: 10,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
        output_tokens: 3,
        ...usage,
      },
    },
  };
}

function workbuddy(id, { usage = {}, provider = {}, ...overrides } = {}) {
  return {
    type: "message",
    sessionId: "session",
    timestamp: TIME,
    cwd: "/project",
    content: BODY,
    ...overrides,
    providerData: {
      messageId: id,
      model: "deepseek-v4.1-flash",
      requestModelName: "DeepSeek",
      ...provider,
      usage: {
        inputTokens: 10,
        outputTokens: 3,
        inputTokensDetails: [{ cached_tokens: 2 }],
        outputTokensDetails: [{ reasoning_tokens: 1 }],
        ...usage,
      },
      rawUsage: { cache_creation_input_tokens: -0 },
    },
  };
}

function jsonl(rows) {
  return `${rows
    .map((row) =>
      typeof row === "string"
        ? row
        : JSON.stringify(row, (_key, value) => (Object.is(value, -0) ? JSON.rawJSON("-0") : value)),
    )
    .join("\n")}\n`;
}

async function fixture(rows, run) {
  const directory = await mkdtemp(path.join(tmpdir(), "jsonl-source-bounded-"));
  const file = path.join(directory, "session.jsonl");
  try {
    await writeFile(file, jsonl(rows));
    return await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function capture(stream, file) {
  const events = [],
    warnings = [],
    trace = [];
  await stream(
    file,
    HOME,
    (event) => {
      trace.push(["event", event.eventId ?? event.messageId]);
      events.push(event);
    },
    {
      repositoryResolver: async (project) => {
        trace.push(["resolve", project]);
        return { key: `key:${project}`, path: project, kind: "fixture" };
      },
      onWarning: (warning) => {
        warnings.push(warning);
        trace.push(["warning", warning]);
      },
    },
  );
  return { events, warnings, trace };
}

async function withBudget(maxBytes, run) {
  const set = UsageSourceRows.prototype.set;
  const close = UsageSourceRows.prototype.close;
  const closed = [];
  UsageSourceRows.prototype.set = function (key, value) {
    this.maxBytes = maxBytes;
    const text = JSON.stringify(value);
    assert.ok(!text?.includes("BODY_SECRET_"), "retained rows must be body-free");
    assert.ok(!text?.includes("resolveRepository"), "resolvers must stay outside the serialized records");
    return set.call(this, key, value);
  };
  UsageSourceRows.prototype.close = function () {
    close.call(this);
    closed.push(this.stats);
  };
  try {
    return await run(closed);
  } finally {
    UsageSourceRows.prototype.set = set;
    UsageSourceRows.prototype.close = close;
  }
}

const claudeRows = [];
const workbuddyRows = [
  { type: "message", providerData: { messageId: "é" } },
  workbuddy("e\u0301", { cwd: "/combining-first-valid" }),
  workbuddy("é", { cwd: "/composed-first-seen" }),
];
for (let i = 0; i < 140; i += 1) {
  const id = `${IDS[i % IDS.length]}-${Math.floor(i / IDS.length)}`;
  claudeRows.push(claude(id, { cwd: `/original-${i}` }));
  workbuddyRows.push(workbuddy(id, { cwd: `/original-${i}` }));
}
claudeRows.push(
  claude("é-0", { cwd: "/larger", usage: { input_tokens: 50 } }),
  claude("é-0", { cwd: "/same-total-must-lose", usage: { input_tokens: 50 } }),
  claude(" raw id "),
  claude("   ", { uuid: "space-fallback" }),
  claude(null, { uuid: "uuid-fallback" }),
  claude("negative-zero", {
    usage: {
      input_tokens: -0,
      cache_read_input_tokens: -0,
      cache_creation_input_tokens: -0,
      output_tokens_details: { thinking_tokens: -0 },
    },
  }),
  claude("overflow", { usage: { input_tokens: Number.MAX_VALUE, cache_read_input_tokens: Number.MAX_VALUE } }),
  claude("invalid-session", { sessionId: "" }),
  claude("invalid-time", { timestamp: "bad date" }),
  { type: "custom-title", customTitle: "early title" },
  "{broken",
  { type: "agent-name", agentName: "last title" },
);
workbuddyRows.push(
  workbuddy("é-0", { cwd: "/later-duplicate-must-lose", usage: { inputTokens: 9000 } }),
  workbuddy("eligibility", { provider: { model: "default-model" } }),
  workbuddy("eligibility", { provider: { requestModelName: " aUtO " } }),
  workbuddy("eligibility", { timestamp: "bad date" }),
  workbuddy("eligibility", { type: "reasoning" }),
  workbuddy("eligibility", { cwd: "", sessionId: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }),
  workbuddy("eligibility", { usage: { inputTokens: 9000 } }),
  workbuddy("negative-zero", {
    timestamp: -0,
    usage: {
      inputTokens: -0,
      outputTokens: -0,
      totalTokens: -0,
      inputTokensDetails: [{ cached_tokens: -0 }],
      outputTokensDetails: [{ reasoning_tokens: -0 }],
    },
  }),
  workbuddy("fractional-date", { timestamp: TIME + 0.75 }),
  workbuddy("overflow", { usage: { inputTokens: Number.MAX_VALUE, outputTokens: Number.MAX_VALUE } }),
  "{broken",
);
for (let i = 0; i < 120; i += 1) {
  workbuddyRows.push(workbuddy("é-0", { usage: { inputTokens: 10000 + i } }));
  workbuddyRows.push({ type: "reasoning", providerData: { messageId: `unused-${i}` }, content: BODY });
}

test("Claude forced spill preserves max/first, IDs, final title, warning order and exact numeric details", async () => {
  await fixture(claudeRows, async (file) => {
    const memory = await capture(streamClaudeSessionEvents, file);
    await withBudget(2048, async (closed) => {
      const disk = await capture(streamClaudeSessionEvents, file);
      assert.deepEqual(disk, memory);
      assert.equal(disk.events.find((event) => event.eventId === "é-0").project, "/larger");
      assert.ok(disk.events.every((event) => event.conversationName === "last title"));
      assert.ok(disk.events.some((event) => event.eventId === " raw id "));
      assert.ok(disk.events.some((event) => event.eventId === "   "));
      const zero = disk.events.find((event) => event.eventId === "negative-zero");
      assert.ok(Object.is(zero.cacheWriteTokens, -0));
      assert.ok(Object.is(zero.usage.cached, -0));
      assert.ok(closed[0].sortRuns > 2);
      assert.ok(closed[0].peakScratchBytes > 0);
    });
  });
});

test("WorkBuddy forced spill retains first eligible compact record, original group order, zeros and invalid placeholders", async () => {
  await fixture(workbuddyRows, async (file) => {
    const memory = await capture(streamWorkbuddySessionEvents, file);
    await withBudget(2048, async (closed) => {
      const disk = await capture(streamWorkbuddySessionEvents, file);
      assert.deepEqual(disk, memory);
      const tied = disk.events.filter((event) => ["é", "e\u0301"].includes(event.messageId));
      assert.deepEqual(
        tied.map((event) => event.messageId),
        ["é", "e\u0301"],
      );
      const zero = disk.events.find((event) => event.messageId === "negative-zero");
      assert.ok(Object.is(zero.timestampMs, -0));
      assert.ok(Object.is(zero.usage.total, -0));
      assert.ok(Object.is(zero.usage.input, -0));
      assert.equal(disk.events.find((event) => event.messageId === "eligibility").usage.total, 0);
      assert.ok(closed[0].sortRuns > 2);
    });
  });
});

// The independent frozen oracle is a local acceptance artifact, not a dependency of a fresh checkout.
let baseline;
try {
  baseline = {
    claude: (await import("../output/remaining-harnesses-20261105/baseline/src/claude-code-usage.js"))
      .streamClaudeSessionEvents,
    workbuddy: (await import("../output/remaining-harnesses-20261105/baseline/src/workbuddy-usage.js"))
      .streamWorkbuddySessionEvents,
  };
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}

test("forced spill exactly matches independent frozen JSONL adapters including -0 and overflowing totals", {
  skip: !baseline,
}, async () => {
  for (const [kind, stream, rows] of [
    ["claude", streamClaudeSessionEvents, claudeRows],
    ["workbuddy", streamWorkbuddySessionEvents, workbuddyRows],
  ]) {
    await fixture(rows, async (file) => {
      const expected = await capture(baseline[kind], file);
      await withBudget(2048, async () => assert.deepEqual(await capture(stream, file), expected));
    });
  }
});

for (const [kind, stream, make] of [
  ["claude", streamClaudeSessionEvents, claude],
  ["workbuddy", streamWorkbuddySessionEvents, workbuddy],
]) {
  for (const stage of ["parse", "warning", "resolver", "consumer"]) {
    test(`${kind} closes anonymous scratch when ${stage} throws`, async () => {
      const rows = Array.from({ length: 30 }, (_, i) => make(`id-${i}`));
      if (stage === "parse")
        rows.push(
          make("parse-fails", {
            usage: {
              [kind === "claude" ? "input_tokens" : "inputTokens"]: { valueOf: 0, toString: 0 },
            },
          }),
        );
      if (stage === "warning") rows.push("{broken");
      await fixture(rows, async (file) =>
        withBudget(2048, async (closed) => {
          const failure = new Error(`${stage} failed`);
          let emitted = 0;
          await assert.rejects(
            stream(
              file,
              HOME,
              async () => {
                emitted += 1;
                if (stage === "consumer") throw failure;
              },
              {
                onWarning: () => {
                  if (stage === "warning") throw failure;
                },
                repositoryResolver: async () => {
                  if (stage === "resolver") throw failure;
                  return { key: "fixture", path: "/project", kind: "fixture" };
                },
              },
            ),
            stage === "parse" ? TypeError : (error) => error === failure,
          );
          assert.equal(emitted, stage === "consumer" ? 1 : 0);
          assert.equal(closed.length, 1);
          assert.ok(closed[0].spilled);
          assert.ok(closed[0].peakScratchBytes > 0);
        }),
      );
    });
  }
}

test("WorkBuddy out-of-range finite date fails after warnings and before any resolver or consumer", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => workbuddy(`id-${i}`));
  rows.push(workbuddy("invalid", { timestamp: 8.64e15 + 1 }), workbuddy("invalid"), "{broken");
  await fixture(rows, async (file) =>
    withBudget(2048, async (closed) => {
      for (const stream of [streamWorkbuddySessionEvents, ...(baseline ? [baseline.workbuddy] : [])]) {
        const trace = [];
        await assert.rejects(
          stream(file, HOME, () => trace.push("event"), {
            onWarning: () => trace.push("warning"),
            repositoryResolver: () => {
              trace.push("resolve");
              return {};
            },
          }),
          RangeError,
        );
        assert.deepEqual(trace, ["warning"]);
      }
      assert.equal(closed.length, 1);
      assert.ok(closed[0].spilled);
    }),
  );
});
