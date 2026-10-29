import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readCodexRolloutMetadata } from "../src/perf-sources/codex-jsonl.js";
import { foldCodexRolloutMetadata } from "../src/perf-sources/codex-fold.js";
import { buildCodexResponseCandidates } from "../src/perf-sources/codex-candidates.js";
import { buildUsageReport, summarizeUsage } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";

const DATE = "2026-10-29T02:00:00.000Z";
const FILTERS = { preset: "all", now: new Date(DATE), calendarZone: "utc" };
const native = {
  schema_version: 1,
  first_output_ms: 125,
  last_output_ms: 145,
  observed_duration_ms: 20,
  output_tokens: 2,
  start_output_tokens: 1,
};
const row = (id, generation = native) => ({
  type: "token_usage_record",
  timestamp: DATE,
  payload: {
    thread_id: "thread",
    turn_id: "turn",
    response_id: id,
    usage: { output_tokens: 3, reasoning_output_tokens: 1 },
    generation_timing: generation,
  },
});
const headers = [
  { type: "session_meta", payload: { id: "thread", source: "cli" } },
  { type: "turn_context", payload: { thread_id: "thread", turn_id: "turn", model: "model-a", effort: "high" } },
];
const lines = (rows) => `${rows.map((value) => JSON.stringify(value)).join("\n")}\n`;
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "native-generation-"));
  const home = path.join(root, "codex");
  const file = path.join(home, "sessions", "rollout.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await run({ root, home, file });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function candidates(file) {
  const projected = await readCodexRolloutMetadata(file);
  const folded = foldCodexRolloutMetadata("home", [projected]);
  return { projected, values: buildCodexResponseCandidates("home", folded, [file]).candidates };
}

test("native summary produces generation speed without a timing lookup or complete turn", async () => {
  await fixture(async ({ file }) => {
    const source = row("native");
    source.payload.generation_timing = { ...native, body: "BODY_MUST_NOT_LEAK" };
    await writeFile(file, lines([...headers, source, row("missing", null)]));
    const { projected, values } = await candidates(file);
    assert.equal(JSON.stringify(projected).includes("BODY_MUST_NOT_LEAK"), false);
    assert.equal(values.length, 2);
    assert.equal(values[0].outputTokens, 1);
    assert.equal(values[0].durationMs, 20);
    assert.equal(values[0].reportedDurationMs, null);
    assert.equal(values[0].generation.timingKind, "first_last_output");
    assert.equal(values[1].durationMs, null);
  });
});

test("invalid native boundaries and unknown counts preserve usage but produce no speed", async () => {
  await fixture(async ({ file }) => {
    const variations = [
      { ...native, schema_version: 2 },
      { ...native, observed_duration_ms: 21 },
      { ...native, first_output_ms: 145 },
      { ...native, last_output_ms: 120 },
      { ...native, output_tokens: 3 },
      { ...native, start_output_tokens: 0 },
      { ...native, first_output_ms: 1.1 },
      { ...native, observed_duration_ms: 0 },
    ];
    const unknown = row("unknown");
    delete unknown.payload.usage.reasoning_output_tokens;
    await writeFile(file, lines([...headers, ...variations.map((value, i) => row(`invalid-${i}`, value)), unknown]));
    const { values } = await candidates(file);
    assert.equal(values.length, variations.length + 1);
    assert.ok(values.every((value) => value.durationMs === null && value.reportedOutputTokens === 3));
  });
});

test("duplicate summaries fold, conflicting windows affect only their response", async () => {
  await fixture(async ({ file }) => {
    await writeFile(
      file,
      lines([
        ...headers,
        row("good"),
        row("good"),
        row("bad"),
        row("bad", { ...native, last_output_ms: 155, observed_duration_ms: 30 }),
      ]),
    );
    const { values } = await candidates(file);
    assert.equal(values.length, 2);
    assert.equal(values[0].durationMs, 20);
    assert.equal(values[1].durationMs, null);
    assert.ok(values[1].sampleFlags.includes("RECORD_CONFLICT"));
  });
});

test("native evidence survives store reuse, late append and memory/store comparison", async () => {
  await fixture(async ({ root, home, file }) => {
    const options = {
      homeDir: root,
      env: {},
      automaticDiscoveryEnabled: false,
      importDirs: [],
      databaseFile: path.join(root, "usage.sqlite"),
      extraHomes: home,
    };
    await writeFile(file, lines([...headers, row("first"), row("late", null)]));
    const store = new UsageStore(options);
    try {
      await store.sync();
      const before = await store.summarize(FILTERS);
      assert.equal(before.perf.models[0].n, 1);
      assert.equal(before.perf.models[0].averageTps, 50);
      await appendFile(file, lines([row("late"), row("first")]));
      await store.sync();
      const after = await store.summarize(FILTERS);
      assert.equal(after.perf.models[0].n, 2);
      assert.equal(after.perf.models[0].averageTps, 50);
      assert.deepEqual(after.totals, before.totals);
      const memory = summarizeUsage(await buildUsageReport(options), FILTERS);
      assert.deepEqual(memory.perf.models, after.perf.models);
      await store.sync();
      assert.deepEqual((await store.summarize(FILTERS)).perf.models, after.perf.models);
    } finally {
      store.close();
    }
    const reopened = new UsageStore(options);
    try {
      await reopened.sync();
      assert.equal((await reopened.summarize(FILTERS)).perf.models[0].n, 2);
    } finally {
      reopened.close();
    }
    assert.ok((await readFile(file, "utf8")).includes("generation_timing"));
  });
});
