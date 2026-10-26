import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { discoverCodexHomes } from "../src/usage-core.js";
import { UsageStore } from "../src/usage-store.js";

const SCRIPT = fileURLToPath(new URL("../scripts/export-perf-request-timings.mjs", import.meta.url));
const IMPORT_SCRIPT = fileURLToPath(new URL("../scripts/import-perf-request-timings.mjs", import.meta.url));
const PRODUCER = "magpie@0.1.1294";
const ROUTE = "codex-responses-to-chat";
const AGENT = "codex";
const PROVIDER = "opendesign";
const REQUESTED_MODEL = "opendesign/deepseek-v4.1-flash";
const REPORTED_MODEL = "deepseek-v4.1-flash";
const ROLLOUT_BASE_MS = Date.parse("2026-10-20T23:58:00.000Z");

function ledgerRow(responseId, overrides = {}) {
  return {
    agent: AGENT,
    provider: PROVIDER,
    model: REPORTED_MODEL,
    req: REQUESTED_MODEL,
    out: 100,
    ms: 1_000,
    status: 200,
    response_id: responseId,
    session: "secret-session",
    host: "secret-host",
    ep: "/secret/endpoint",
    authorization: "Bearer secret-token",
    body: { prompt: "secret prompt" },
    ...overrides,
  };
}

function exportArgs({ endpoint, home, output, homeKind, producer = PRODUCER, requestedModel = REQUESTED_MODEL }) {
  const args = [
    "--endpoint",
    endpoint,
    "--home",
    home,
    "--since",
    "2026-10-20",
    "--until",
    "2026-10-21",
    "--output",
    output,
    "--producer",
    producer,
    "--route",
    ROUTE,
    "--agent",
    AGENT,
    "--provider",
    PROVIDER,
    "--requested-model",
    requestedModel,
    "--reported-model",
    REPORTED_MODEL,
  ];
  if (homeKind) args.push("--home-kind", homeKind);
  return args;
}

function runNode(script, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${label} timed out`));
    }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function runExport(args) {
  return runNode(SCRIPT, args, "export");
}

function runImport(args) {
  return runNode(IMPORT_SCRIPT, args, "import");
}

async function withLocalServer(handler, fn) {
  const requests = [];
  const requestHeaders = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    requests.push(url);
    requestHeaders.push(request.headers);
    try {
      handler(url, response);
    } catch {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"handler failed"}');
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    await fn(`http://127.0.0.1:${address.port}/v1/magpie/usage/requests`, requests, requestHeaders);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
  }
}

async function withWorkspace(fn) {
  const root = await mkdtemp(path.join(tmpdir(), "request-timing-export-"));
  try {
    await fn({
      root,
      home: path.join(root, ".codex"),
      extraHome: path.join(root, "extra-codex"),
      database: path.join(root, "usage-index.sqlite"),
      output: path.join(root, "export.json"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sendPage(response, rows, total, offset, pageSize) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ rows: rows.slice(offset, offset + pageSize), total, offset }));
}

function codexRollout(threadId, responseId, baseMs = ROLLOUT_BASE_MS) {
  return [
    {
      type: "session_meta",
      payload: { id: threadId, session_id: threadId, source: "cli", originator: "codex-tui" },
    },
    {
      type: "turn_context",
      payload: { thread_id: threadId, turn_id: `turn-${threadId}`, model: REQUESTED_MODEL, effort: "high" },
    },
    {
      type: "token_usage_record",
      timestamp: new Date(baseMs + 2_000).toISOString(),
      payload: {
        thread_id: threadId,
        turn_id: `turn-${threadId}`,
        response_id: responseId,
        usage: { output_tokens: 100 },
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: threadId,
        turn_id: `turn-${threadId}`,
        item: { id: `item-${threadId}`, type: "AgentMessage" },
        started_at_ms: baseMs,
        completed_at_ms: baseMs + 500,
      },
    },
    { type: "event_msg", payload: { type: "task_complete", thread_id: threadId, turn_id: `turn-${threadId}` } },
  ];
}

async function writeCodexHome(home, threads) {
  const sessions = path.join(home, "sessions", "2026", "10");
  await mkdir(sessions, { recursive: true });
  for (const { threadId, responseId } of threads) {
    await writeFile(
      path.join(sessions, `rollout-${threadId}.jsonl`),
      `${codexRollout(threadId, responseId)
        .map((entry) => JSON.stringify(entry))
        .join("\n")}\n`,
      "utf8",
    );
  }
}

function storeOptions(root, database) {
  return {
    homeDir: root,
    databaseFile: database,
    env: {},
    extraHomes: "",
    importDirs: [],
    automaticDiscoveryEnabled: false,
  };
}

function sampleFor(store, homeId, threadId) {
  const sourcePath = String(
    store.database
      .prepare("SELECT source_path FROM perf_rollout_threads WHERE home_id = ? AND thread_id = ?")
      .get(homeId, threadId).source_path,
  );
  const rows = store.database
    .prepare("SELECT * FROM perf_samples WHERE home_id = ? AND source_path = ?")
    .all(homeId, sourcePath);
  assert.equal(rows.length, 1, `expected one perf sample for ${threadId}`);
  const row = rows[0];
  return {
    ...row,
    sampleKey: String(row.sample_key),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
  };
}

test("export pages, collapses exact duplicates, preserves conflicts, and emits only the whitelist", async () => {
  const rows = [
    ledgerRow("response-a"),
    ledgerRow("response-b", { out: 100, ms: 1_000 }),
    ledgerRow("response-a"),
    ledgerRow("response-b", { out: 101, ms: 1_001 }),
    ledgerRow("response-c", { status: 503, out: 0, ms: 0 }),
    ledgerRow("response-d", { out: 10, ms: 0 }),
  ];

  await withLocalServer(
    (url, response) => {
      const offset = Number(url.searchParams.get("offset"));
      sendPage(response, rows, rows.length, offset, 2);
    },
    async (endpoint, requests, requestHeaders) => {
      await withWorkspace(async ({ home, output }) => {
        const result = await runExport(exportArgs({ endpoint, home, output }));
        assert.equal(result.code, 0, result.stderr);

        const exported = JSON.parse(await readFile(output, "utf8"));
        assert.deepEqual(Object.keys(exported).sort(), [
          "admission",
          "conflicts",
          "evidenceOrigin",
          "homeId",
          "kind",
          "range",
          "records",
          "schemaVersion",
          "skipped",
        ]);
        assert.equal(exported.schemaVersion, 1);
        assert.equal(exported.kind, "perf-request-timing-export");
        assert.equal(exported.evidenceOrigin, `${PRODUCER};route=${ROUTE}`);
        assert.match(exported.homeId, /^(?:main|jetbrains|extra)-[0-9a-f]{16}$/);
        assert.equal(exported.admission, "unauthenticated_candidate");
        assert.deepEqual(exported.range, { since: "2026-10-20", until: "2026-10-21" });
        assert.deepEqual(exported.skipped, { nonCompletedHttpStatus: 1, invalidTiming: 1 });
        assert.deepEqual(exported.conflicts, [{ responseId: "response-b", variants: 2 }]);

        assert.equal(exported.records.length, 3);
        for (const record of exported.records) {
          assert.deepEqual(Object.keys(record).sort(), [
            "completedAtMs",
            "durationMs",
            "evidenceOrigin",
            "reportedOutputTokens",
            "requestedModel",
            "responseId",
            "schemaVersion",
            "status",
          ]);
        }
        assert.deepEqual(
          exported.records.filter((record) => record.responseId === "response-b").map((record) => record.durationMs),
          [1_000, 1_001],
        );

        const serialized = JSON.stringify(exported);
        assert.equal(serialized.includes("certified"), false);
        assert.equal(serialized.includes("ranking"), false);
        for (const forbidden of [
          "secret-session",
          "secret-host",
          "secret-token",
          "secret prompt",
          "/secret/endpoint",
          endpoint,
        ]) {
          assert.equal(serialized.includes(forbidden), false, forbidden);
        }
        assert.deepEqual(
          requests.map((request) => request.searchParams.get("offset")),
          ["0", "2", "4"],
        );
        for (const request of requests) {
          assert.equal(request.searchParams.get("period"), "2026-10-20..2026-10-21");
          assert.equal(request.searchParams.get("agent"), AGENT);
          assert.equal(request.searchParams.get("provider"), PROVIDER);
          assert.equal(request.searchParams.get("model"), REPORTED_MODEL);
          assert.equal(request.searchParams.get("limit"), "500");
        }
        for (const headers of requestHeaders) {
          assert.equal(headers.authorization, undefined);
          assert.equal(headers.cookie, undefined);
        }
      });
    },
  );
});

test("HTTP failure exits nonzero and writes no partial output", async () => {
  await withLocalServer(
    (_url, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"error":"unavailable"}');
    },
    async (endpoint, requests) => {
      await withWorkspace(async ({ home, output }) => {
        const result = await runExport(exportArgs({ endpoint, home, output }));
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /EXPORT_HTTP_FAILED/);
        await assert.rejects(stat(output), { code: "ENOENT" });
        assert.equal(requests.length, 1);
      });
    },
  );
});

test("page-limit exhaustion fails without writing output", async () => {
  await withLocalServer(
    (url, response) => {
      const offset = Number(url.searchParams.get("offset"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ rows: [ledgerRow(`response-${offset}`)], total: 101, offset }));
    },
    async (endpoint, requests) => {
      await withWorkspace(async ({ home, output }) => {
        const result = await runExport(exportArgs({ endpoint, home, output }));
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /EXPORT_PAGE_LIMIT/);
        await assert.rejects(stat(output), { code: "ENOENT" });
        assert.equal(requests.length, 100);
        assert.equal(requests.at(-1)?.searchParams.get("offset"), "99");
      });
    },
  );
});

test("a floating @latest producer is rejected before any request", async () => {
  await withLocalServer(
    (_url, response) => {
      response.writeHead(500);
      response.end();
    },
    async (endpoint, requests) => {
      await withWorkspace(async ({ home, output }) => {
        const result = await runExport(exportArgs({ endpoint, home, output, producer: "magpie@latest" }));
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /EXPORT_INVALID_PRODUCER/);
        assert.equal(requests.length, 0);
        await assert.rejects(stat(output), { code: "ENOENT" });
      });
    },
  );
});

test("rows outside the exact requested-model scope fail rather than being guessed or dropped", async () => {
  await withLocalServer(
    (_url, response) => {
      sendPage(response, [ledgerRow("response-a", { req: "opendesign/deepseek-v4.1-flash-sg" })], 1, 0, 500);
    },
    async (endpoint) => {
      await withWorkspace(async ({ home, output }) => {
        const result = await runExport(exportArgs({ endpoint, home, output }));
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /EXPORT_ROW_OUT_OF_SCOPE/);
        await assert.rejects(stat(output), { code: "ENOENT" });
      });
    },
  );
});

test("real export-to-import CLI seam carries one timing through native projection and sync", async () => {
  await withLocalServer(
    (_url, response) => {
      sendPage(response, [ledgerRow("response-a")], 1, 0, 500);
    },
    async (endpoint) => {
      await withWorkspace(async ({ root, home, database, output }) => {
        await writeCodexHome(home, [
          { threadId: "thread-a", responseId: "response-a" },
          { threadId: "thread-b", responseId: "response-b" },
        ]);
        const rolloutA = path.join(home, "sessions", "2026", "10", "rollout-thread-a.jsonl");
        const rolloutB = path.join(home, "sessions", "2026", "10", "rollout-thread-b.jsonl");
        const rolloutABefore = await readFile(rolloutA, "utf8");
        const rolloutBBefore = await readFile(rolloutB, "utf8");

        const initialStore = new UsageStore(storeOptions(root, database));
        let homeId;
        let beforeA;
        let beforeB;
        try {
          await initialStore.sync();
          const discovered = initialStore.homes.find((candidate) => candidate.path === home);
          assert.ok(discovered);
          homeId = String(discovered.id);
          beforeA = sampleFor(initialStore, homeId, "thread-a");
          beforeB = sampleFor(initialStore, homeId, "thread-b");
          assert.equal(beforeA.durationMs, null);
          assert.equal(beforeB.durationMs, null);
        } finally {
          initialStore.close();
        }

        const exportedResult = await runExport(exportArgs({ endpoint, home, output, homeKind: "main" }));
        assert.equal(exportedResult.code, 0, exportedResult.stderr);
        assert.ok((await stat(output)).size > 0);
        const exported = JSON.parse(await readFile(output, "utf8"));
        assert.equal(exported.records.length, 1);
        assert.deepEqual(exported.conflicts, []);

        const discoveredHomes = await discoverCodexHomes({
          homeDir: root,
          env: {},
          extraHomes: "",
          platform: "linux",
        });
        assert.equal(exported.homeId, discoveredHomes.find((candidate) => candidate.path === home)?.id);

        const importedResult = await runImport([
          "--database",
          database,
          "--home",
          exported.homeId,
          "--input",
          output,
          "--reviewed-origin",
          exported.evidenceOrigin,
        ]);
        assert.equal(importedResult.code, 0, importedResult.stderr);
        assert.ok((await stat(database)).size > 0);
        assert.deepEqual(JSON.parse(importedResult.stdout), {
          revision: 1,
          changed: true,
          affectedThreadIds: ["thread-a"],
        });

        const reopened = new UsageStore(storeOptions(root, database));
        try {
          await reopened.open();
          assert.deepEqual(reopened.requestTimingDirtyThreads(homeId), ["thread-a"]);
          await reopened.sync();

          assert.deepEqual(reopened.codexThreadBuildPlan.get(homeId), {
            staged: ["thread-a"],
            retained: ["thread-b"],
          });
          assert.deepEqual(reopened.requestTimingDirtyThreads(homeId), []);
          assert.deepEqual(reopened.lookupRequestTiming({ homeId, responseId: "response-a" }), {
            state: "available",
            durationMs: 1_000,
            reportedOutputTokens: 100,
            requestedModel: REQUESTED_MODEL,
          });
          assert.equal(sampleFor(reopened, homeId, "thread-a").durationMs, 1_000);
          assert.deepEqual(sampleFor(reopened, homeId, "thread-b"), beforeB);
          assert.equal(await readFile(rolloutA, "utf8"), rolloutABefore);
          assert.equal(await readFile(rolloutB, "utf8"), rolloutBBefore);
        } finally {
          reopened.close();
        }
      });
    },
  );
});

test("exported homeId matches discoverCodexHomes for main and extra homes", async () => {
  await withLocalServer(
    (_url, response) => {
      sendPage(response, [ledgerRow("response-home")], 1, 0, 500);
    },
    async (endpoint) => {
      await withWorkspace(async ({ root, home, extraHome }) => {
        await writeCodexHome(home, [{ threadId: "thread-main", responseId: "response-home" }]);
        await writeCodexHome(extraHome, [{ threadId: "thread-extra", responseId: "response-home" }]);

        const discovered = await discoverCodexHomes({
          homeDir: root,
          env: {},
          extraHomes: extraHome,
          platform: "linux",
        });
        const mainHome = discovered.find((candidate) => candidate.path === home);
        const extra = discovered.find((candidate) => candidate.path === extraHome);
        assert.equal(mainHome?.kind, "main");
        assert.equal(extra?.kind, "extra");

        const mainOutput = path.join(root, "main-export.json");
        const extraOutput = path.join(root, "extra-export.json");
        const mainResult = await runExport(exportArgs({ endpoint, home, output: mainOutput, homeKind: "main" }));
        assert.equal(mainResult.code, 0, mainResult.stderr);
        const extraResult = await runExport(
          exportArgs({ endpoint, home: extraHome, output: extraOutput, homeKind: "extra" }),
        );
        assert.equal(extraResult.code, 0, extraResult.stderr);

        assert.equal(JSON.parse(await readFile(mainOutput, "utf8")).homeId, mainHome?.id);
        assert.equal(JSON.parse(await readFile(extraOutput, "utf8")).homeId, extra?.id);
      });
    },
  );
});

test("import rejects an unreviewed origin before creating the database, even if JSON claims admission", async () => {
  await withWorkspace(async ({ database, output }) => {
    const evidenceOrigin = "unreviewed@1;route=synthetic";
    await writeFile(
      output,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: "perf-request-timing-export",
        evidenceOrigin,
        homeId: "main-0000000000000000",
        admission: "certified",
        records: [
          {
            schemaVersion: 1,
            evidenceOrigin,
            responseId: "response-a",
            requestedModel: REQUESTED_MODEL,
            reportedOutputTokens: 100,
            durationMs: 1_000,
            status: "completed",
            completedAtMs: null,
          },
        ],
      })}\n`,
      "utf8",
    );

    const result = await runImport(["--database", database, "--home", "main-0000000000000000", "--input", output]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /REQUEST_TIMING_ORIGIN_UNREVIEWED/);
    for (const file of [database, `${database}-wal`, `${database}-shm`]) {
      await assert.rejects(stat(file), { code: "ENOENT" });
    }
  });
});
