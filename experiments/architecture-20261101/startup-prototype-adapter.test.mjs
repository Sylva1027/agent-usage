import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, cp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";

import { createCodexIntegrationFixture } from "../../test-support/usage-fixture.mjs";

const testFile = fileURLToPath(import.meta.url);
const traceFile = path.join(path.dirname(testFile), "startup-trace.mjs");
const traceUrl = pathToFileURL(traceFile).href;
const childMarker = "STARTUP_PROTOTYPE_ADAPTER_TEST_CHILD";

function tokenRow(timestamp, usage) {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { last_token_usage: usage },
    },
  };
}

async function writeDshFixture(root) {
  const sessionId = "adapter-dsh-session";
  const file = path.join(root, ".dsh", "sessions", "fixture", sessionId, "session.v4.jsonl.zstd");
  await mkdir(path.dirname(file), { recursive: true });
  const rows = [
    {
      type: "session",
      version: 4,
      id: sessionId,
      createdAt: Date.parse("2026-10-04T12:00:00.000Z"),
      cwd: "/fixture/dsh",
      delegationDepth: 0,
      agentPreset: "fixture",
    },
    {
      type: "request/header",
      seq: 1,
      time: Date.parse("2026-10-04T12:01:00.000Z"),
      data: { header: { config: { provider: "fixture-provider", model: "dsh-fixture-model" } } },
    },
    {
      type: "assistant/message",
      seq: 2,
      time: Date.parse("2026-10-04T12:02:00.000Z"),
      data: {
        turn: 1,
        step: 1,
        usage: {
          inputTokens: 20,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 5,
          totalTokens: 25,
        },
      },
    },
  ];
  await writeFile(
    file,
    Buffer.concat(rows.map((row) => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`)))),
  );
}

function withoutEventId(event) {
  const { eventId: _eventId, ...contract } = event;
  return contract;
}

function canonicalEvents(events) {
  return events
    .map(withoutEventId)
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function eventTotals(events) {
  return events.reduce(
    (totals, event) => {
      for (const key of ["total", "input", "cached", "output", "reasoning"]) {
        totals[key] += Number(event.total[key]);
      }
      return totals;
    },
    { total: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
  );
}

async function getJson(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  const body = await response.json();
  assert.equal(response.ok, true, `${route}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

async function runAdapterContract() {
  const codexFixture = createCodexIntegrationFixture();
  const root = codexFixture.reportOptions.homeDir;
  let engine = null;
  try {
    const mainCodexHome = path.join(root, ".codex");
    await cp(codexFixture.codexHome, mainCodexHome, { recursive: true });
    await writeDshFixture(root);
    const firstRollout = path.join(
      mainCodexHome,
      path.relative(codexFixture.codexHome, codexFixture.rolloutFiles[0]),
    );
    await appendFile(
      firstRollout,
      `${JSON.stringify(
        tokenRow("2026-10-04T12:10:00.000Z", {
          total_tokens: 12,
          input_tokens: 10,
          cached_input_tokens: 2,
          output_tokens: 2,
          reasoning_output_tokens: 0,
        }),
      )}\n`,
    );

    const options = {
      ...codexFixture.serverOptions,
      extraHomes: "",
      databaseFile: path.join(root, "formal-private", "usage-index.sqlite"),
      importStoreFile: path.join(root, "formal-private", "imports.json"),
    };
    const usageStoreUrl = pathToFileURL(path.resolve(path.dirname(testFile), "..", "..", "src", "usage-store.js"))
      .href;
    const runnerUrl = pathToFileURL(path.resolve(path.dirname(testFile), "runner.mjs")).href;
    const adapterUrl = pathToFileURL(path.resolve(path.dirname(testFile), "startup-prototype-adapter.mjs")).href;
    const { UsageStore } = await import(usageStoreUrl);
    const { launch } = await import(runnerUrl);
    const { publishFormalSources, addSeedPayloadHashes } = await import(adapterUrl);

    let reader = new UsageStore(options);
    await reader.sync();
    const initialReaderEvents = reader.publishedUsageEvents();
    reader.close();
    reader = null;

    const prototypeDirectory = path.join(root, "prototype-private");
    await mkdir(prototypeDirectory, { recursive: true });
    engine = await launch("node-sqlite", prototypeDirectory);

    const firstPublish = await publishFormalSources({
      backend: engine.baseUrl,
      directory: prototypeDirectory,
      options,
      fresh: true,
    });
    assert.equal(firstPublish.eventCount, initialReaderEvents.length);
    const firstReport = await getJson(engine.baseUrl, "/api/report");
    assert.deepEqual(canonicalEvents(firstReport.events), canonicalEvents(initialReaderEvents));
    assert.deepEqual(
      [...new Set(firstReport.events.map((event) => event.sourceKind))].sort(),
      ["dsh", "main"],
    );
    assert.deepEqual(firstReport.context.sessions, []);

    const secondPublish = await publishFormalSources({
      backend: engine.baseUrl,
      directory: prototypeDirectory,
      options,
    });
    assert.equal(secondPublish.commits, 0);
    const unchangedReport = await getJson(engine.baseUrl, "/api/report");
    assert.equal(unchangedReport.revision, firstReport.revision);
    assert.deepEqual(canonicalEvents(unchangedReport.events), canonicalEvents(initialReaderEvents));
    const mirrorFile = path.join(prototypeDirectory, 'mirror.json');
    const mirror = JSON.parse(await readFile(mirrorFile, 'utf8'));
    const expectedHashes = mirror.eventHashes;
    delete mirror.eventHashes;
    await writeFile(mirrorFile, JSON.stringify(mirror));
    await addSeedPayloadHashes([prototypeDirectory], options);
    const upgraded = JSON.parse(await readFile(mirrorFile, 'utf8'));
    assert.deepEqual(upgraded.eventHashes, expectedHashes);
    upgraded.evidenceHash = 'force-evidence-recheck';
    await writeFile(mirrorFile, JSON.stringify(upgraded));
    const checked = await publishFormalSources({ backend: engine.baseUrl, directory: prototypeDirectory, options });
    assert.equal(checked.allChanged, true);
    assert.equal(checked.eventCount, initialReaderEvents.length);
    assert.equal(checked.commits, 0);
    assert.equal((await getJson(engine.baseUrl, '/api/report')).revision, firstReport.revision);

    await appendFile(
      firstRollout,
      `${JSON.stringify(
        tokenRow("2026-10-04T12:20:00.000Z", {
          total_tokens: 25,
          input_tokens: 20,
          cached_input_tokens: 5,
          output_tokens: 5,
          reasoning_output_tokens: 3,
        }),
      )}\n`,
    );
    reader = new UsageStore(options);
    await reader.sync();
    const updatedReaderEvents = reader.publishedUsageEvents();
    reader.close();
    reader = null;

    const replacementPublish = await publishFormalSources({
      backend: engine.baseUrl,
      directory: prototypeDirectory,
      options,
    });
    assert.equal(replacementPublish.commits, 1);
    const replacedReport = await getJson(engine.baseUrl, "/api/report");
    assert.equal(replacedReport.events.length, updatedReaderEvents.length);
    assert.deepEqual(canonicalEvents(replacedReport.events), canonicalEvents(updatedReaderEvents));
    assert.deepEqual(
      [...new Set(replacedReport.events.map((event) => event.sourceKind))].sort(),
      ["dsh", "main"],
    );
    assert.deepEqual(replacedReport.context.sessions, []);
    assert.deepEqual(eventTotals(replacedReport.events), {
      total: 62,
      input: 50,
      cached: 7,
      output: 12,
      reasoning: 3,
    });

    const query = await getJson(engine.baseUrl, "/api/query");
    assert.ok(
      query.eventCount === updatedReaderEvents.length,
      JSON.stringify({
        reportEventCount: replacedReport.events.length,
        readerEventCount: updatedReaderEvents.length,
        queryEventCount: query.eventCount,
        reportRevisions: replacedReport.revision,
      }),
    );
    assert.deepEqual(query.totals, eventTotals(updatedReaderEvents));
  } finally {
    await engine?.stop();
    codexFixture.close();
  }
}

test("startup prototype adapter preserves formal published events across replacement", { timeout: 120_000 }, async () => {
  if (process.env[childMarker] === "1") {
    await runAdapterContract();
    return;
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ARCH_STARTUP_") || key.startsWith("NODE_TEST_")) delete env[key];
  }
  env.ARCH_STARTUP_EXPORT_ROWS = "1";
  env[childMarker] = "1";
  const child = spawnSync(
    process.execPath,
    ["--import", traceUrl, "--test", testFile],
    {
      cwd: path.resolve(path.dirname(testFile), "..", ".."),
      encoding: "utf8",
      env,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 100_000,
    },
  );
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
});
