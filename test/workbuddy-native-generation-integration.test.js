import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createHistoryArchiveCandidate,
  loadHistoryArchiveImport,
  prepareHistoryArchiveCommit,
  publishHistoryArchiveBundle,
  publishHistoryArchiveImport,
} from "../src/history-archive.js";
import { createHistoryBackup, verifyHistoryBackup } from "../src/history-backup.js";
import { buildUsageReport, summarizeUsage } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";

const DATE = "2026-10-29T02:00:00.000Z";
const FILTERS = { preset: "all", now: new Date(DATE), calendarZone: "utc" };
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
function end(id, duration = 20) {
  return `qua.end ${JSON.stringify({
    message_id: id,
    trace_id: "session-trace",
    finish_flag: "done",
    finish_reason: "stop",
    completion_tokens: 2,
    model_error: "",
    http_begin_status_code: 200,
    http_end_status_code: 200,
    text_first_cost_ms: 100,
    text_total_cost_ms: duration,
    text_content_chars: 2,
    text_content_bytes: 2,
    text_total_tokens: 2,
    think_first_cost_ms: 0,
    think_total_cost_ms: 0,
    think_content_chars: 0,
    think_content_bytes: 0,
    think_total_tokens: 0,
  })}\n`;
}
async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "workbuddy-native-"));
  const home = path.join(root, ".workbuddy-ai");
  const project = path.join(home, "projects", "fixture");
  const traces = path.join(home, "traces", "fixture");
  const logs = path.join(home, "logs", "2026-10-29");
  await Promise.all([project, traces, logs].map((dir) => mkdir(dir, { recursive: true })));
  const files = {};
  const spans = [];
  for (const id of ["a", "b"]) {
    files[id] = path.join(project, `${id}.jsonl`);
    await writeFile(
      files[id],
      jsonl([
        { type: "session-meta", sessionId: id },
        {
          timestamp: Date.parse(DATE),
          type: "message",
          role: "assistant",
          status: "completed",
          sessionId: id,
          cwd: project,
          content: [{ type: "output_text", text: "a " }],
          providerData: {
            messageId: id,
            traceId: "session-trace",
            model: "deepseek-v4.1-flash",
            usage: {
              inputTokens: 10,
              outputTokens: 2,
              totalTokens: 12,
              inputTokensDetails: [{ cached_tokens: 0 }],
              outputTokensDetails: [{ reasoning_tokens: 0 }],
            },
          },
        },
      ]),
    );
    spans.push({
      type: "span_end",
      span: {
        type: "generation",
        name: "generation",
        status: "ok",
        duration: 10000,
        endedAt: DATE,
        traceId: "different-generation-trace",
        spanId: id,
        attributes: { tracePayloadTruncated: true, tracePayloadTruncatedFields: ["toolInput"] },
        toolOutput: JSON.stringify([
          {
            id,
            object: "chat.completion",
            choices: [
              { index: 0, finish_reason: "stop", message: { role: "assistant", content: "a ", refusal: null } },
            ],
            usage: {
              completion_tokens: 2,
              completion_tokens_details: {
                reasoning_tokens: 0,
                accepted_prediction_tokens: 0,
                rejected_prediction_tokens: 0,
                audio_tokens: 0,
                cached_tokens: 0,
              },
            },
          },
        ]),
      },
    });
  }
  const traceFile = path.join(traces, "trace_native.jsonl");
  await writeFile(traceFile, jsonl(spans));
  const log = path.join(logs, "main.log");
  await writeFile(log, "");
  const options = { homeDir: root, env: {}, databaseFile: path.join(root, "index.sqlite") };
  try {
    await run({ root, home, files, log, traceFile, options });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("trace changes revoke only the WorkBuddy response whose native timing proof changes", async () => {
  await fixture(async ({ files, log, traceFile, options }) => {
    await writeFile(log, end("a") + end("b"));
    const store = new UsageStore(options);
    try {
      await store.sync();
      assert.equal((await store.summarize(FILTERS)).perf.models[0].n, 2);
      const originalTrace = await readFile(traceFile, "utf8");
      const replaced = [];
      const replaceFile = store.replaceFile.bind(store);
      store.replaceFile = async (file, ...args) => {
        replaced.push(file.filePath);
        return replaceFile(file, ...args);
      };
      await appendFile(
        traceFile,
        jsonl([
          {
            type: "span_end",
            span: { traceId: "different-generation-trace", spanId: "child", parentId: "a", type: "function" },
          },
        ]),
      );
      await store.sync();
      assert.deepEqual(replaced, [files.a]);
      assert.equal((await store.summarize(FILTERS)).perf.models[0].n, 1);
      replaced.length = 0;
      await writeFile(traceFile, originalTrace);
      await store.sync();
      assert.deepEqual(replaced, [files.a]);
      assert.equal((await store.summarize(FILTERS)).perf.models[0].n, 2);
    } finally {
      store.close();
    }
  });
});

test("native WorkBuddy timing arrives without transcript changes, refreshes only its session and survives restart", async () => {
  await fixture(async ({ files, log, options }) => {
    const store = new UsageStore(options);
    try {
      await store.sync();
      const before = await store.summarize(FILTERS);
      assert.equal(before.perf.models[0].n, 0);
      const replaced = [];
      const replaceFile = store.replaceFile.bind(store);
      store.replaceFile = async (file, ...args) => {
        replaced.push(file.filePath);
        return replaceFile(file, ...args);
      };
      let refresh;
      const refreshDurations = store.refreshWorkbuddyDurations.bind(store);
      store.refreshWorkbuddyDurations = async (...args) => {
        refresh = await refreshDurations(...args);
        return refresh;
      };
      await appendFile(log, end("a"));
      await store.sync();
      const after = await store.summarize(FILTERS);
      assert.deepEqual(replaced, [files.a]);
      assert.equal(after.perf.models[0].n, 1);
      assert.equal(after.perf.models[0].averageTps, 50);
      assert.deepEqual(after.totals, before.totals);
      assert.notEqual(after.perf.meta.indexVersion, before.perf.meta.indexVersion);
      assert.deepEqual(summarizeUsage(await buildUsageReport(options), FILTERS).perf.models, after.perf.models);
      replaced.length = 0;
      await store.sync();
      assert.deepEqual(replaced, []);
      assert.equal(refresh.filesParsed, 0);
      assert.equal((await store.summarize(FILTERS)).perf.meta.indexVersion, after.perf.meta.indexVersion);
      await appendFile(log, end("a", 30));
      await store.sync();
      assert.deepEqual(replaced, [files.a]);
      assert.equal((await store.summarize(FILTERS)).perf.models[0].n, 0);
      await writeFile(log, end("a"));
      await store.sync();
      assert.equal((await store.summarize(FILTERS)).perf.models[0].n, 1);
    } finally {
      store.close();
    }
    const reopened = new UsageStore(options);
    try {
      await reopened.sync();
      assert.equal((await reopened.summarize(FILTERS)).perf.models[0].averageTps, 50);
      await rm(log);
      await reopened.sync();
      assert.equal((await reopened.summarize(FILTERS)).perf.models[0].n, 1);
      await appendFile(files.a, jsonl([{ type: "checkpoint" }]));
      await reopened.sync();
      assert.equal((await reopened.summarize(FILTERS)).perf.models[0].n, 1);
      const changed = (await readFile(files.a, "utf8")).trim().split("\n").map(JSON.parse);
      changed[1].providerData.usage.outputTokens = 3;
      changed[1].providerData.usage.totalTokens = 13;
      await writeFile(files.a, jsonl(changed));
      await reopened.sync();
      assert.equal((await reopened.summarize(FILTERS)).perf.models[0].n, 0);
    } finally {
      reopened.close();
    }
  });
});

test("a failed native timing publication retries its session even when timing files are unchanged", async () => {
  await fixture(async ({ files, log, options }) => {
    const store = new UsageStore(options);
    try {
      await store.sync();
      await appendFile(log, end("b"));
      const replaceFile = store.replaceFile.bind(store);
      let fail = true;
      store.replaceFile = async (file, ...args) => {
        if (fail && file.filePath === files.b) {
          fail = false;
          throw new Error("fixture publication failure");
        }
        return replaceFile(file, ...args);
      };
      await store.sync();
      await store.sync();
      const result = await store.summarize(FILTERS);
      assert.equal(result.perf.models[0].n, 1);
      assert.equal(result.perf.models[0].averageTps, 50);
      assert.deepEqual(summarizeUsage(await buildUsageReport(options), FILTERS).perf.models, result.perf.models);
    } finally {
      store.close();
    }
  });
});

test("v3 WorkBuddy generation survives v4 refresh, rotated logs, backup and source-free archive transfer", async () => {
  await fixture(async ({ root, home, log, options }) => {
    await writeFile(log, end("a") + end("b"));
    const store = new UsageStore(options);
    try {
      await store.sync();
      store.database.prepare("UPDATE perf_samples SET method_version = 'tps-v3'").run();
      store.writeMeta("perf_method_version", "tps-v3");
      const oldFingerprints = JSON.parse(store.readMeta("perf_file_fingerprints"));
      store.writeMeta(
        "perf_file_fingerprints",
        JSON.stringify(Object.fromEntries(Object.keys(oldFingerprints).map((file) => [file, "v3-fingerprint"]))),
      );
      await rm(log);
      await store.sync();
      const upgraded = await store.summarize(FILTERS);
      assert.equal(upgraded.perf.meta.methodVersion, "tps-v4");
      assert.equal(upgraded.perf.models[0].n, 2);
      assert.equal(upgraded.perf.models[0].averageTps, 50);
      assert.deepEqual(
        store.database
          .prepare("SELECT DISTINCT method_version FROM perf_samples")
          .all()
          .map((row) => row.method_version),
        ["tps-v3"],
      );
      const backupFile = path.join(root, "v3-under-v4.sqlite");
      await createHistoryBackup(store.database, backupFile);
      await verifyHistoryBackup(backupFile);
      const candidateFile = path.join(root, "cold-v3.sqlite");
      const timestamp = Date.parse(DATE);
      await createHistoryArchiveCandidate(store.database, candidateFile, {
        startMs: timestamp - 1,
        endMs: timestamp + 1,
      });
      const plan = await prepareHistoryArchiveCommit(store.database, candidateFile);
      assert.equal(plan.perfDeletion.sourceKind, "workbuddy");
      const committed = await store.commitHistoryArchiveEvents(plan);
      assert.equal(committed.deletedPerfSampleCount, 2);
      const bundle = path.join(root, "v3-bundle");
      const destination = path.join(root, "transferred");
      await publishHistoryArchiveBundle(store.database, bundle);
      await publishHistoryArchiveImport(bundle, destination);
      store.close();
      await rm(home, { recursive: true, force: true });
      const loaded = await loadHistoryArchiveImport(destination);
      const restored = new UsageStore({
        homeDir: destination,
        env: {},
        importDirs: [],
        automaticDiscoveryEnabled: false,
        databaseFile: loaded.runtimeFile,
      });
      try {
        await restored.open();
        const result = await restored.summarizeHistory(FILTERS);
        assert.equal(result.perf.models[0].n, 2);
        assert.equal(result.perf.models[0].averageTps, 50);
        assert.deepEqual(result.totals, upgraded.totals);
      } finally {
        restored.close();
      }
    } finally {
      store.close();
    }
  });
});
