import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { MAGPIE_TIMING_ORIGIN, MagpieRequestTimings } from "../src/perf-magpie-timing.js";

function row(overrides = {}) {
  return {
    agent: "codex",
    provider: "codex",
    req: "codex/model-a",
    model: "model-a",
    response_id: "response-a",
    status: 200,
    ms: 2000,
    out: 100,
    stop: "completed",
    ep: "/backend-api/codex/responses",
    ...overrides,
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(process.cwd(), ".magpie-timing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { file: path.join(root, "usage.jsonl"), reader: new MagpieRequestTimings() };
}

test("read append-only timing without retaining gateway credentials or bodies", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(
    file,
    `${JSON.stringify(row({ host: "private-host", body: "secret", providerKeyId: "secret-key" }))}\n`,
  );
  assert.equal(await reader.read(file), true);
  assert.deepEqual(reader.recordsForRequest("response-a", "model-a", 100), [
    {
      schemaVersion: 1,
      evidenceOrigin: MAGPIE_TIMING_ORIGIN,
      responseId: "response-a",
      requestedModel: "model-a",
      reportedOutputTokens: 100,
      durationMs: 2000,
      status: "completed",
      completedAtMs: null,
    },
  ]);
  assert.equal(JSON.stringify([...reader.requests]).includes("secret"), false);
  const offset = reader.offset;
  const first = reader.pendingChanges();
  assert.deepEqual(first.responseIds, new Set(["response-a"]));
  assert.equal(first.reset, true);
  assert.equal(await reader.read(file), false);
  assert.deepEqual(reader.pendingChanges(), first);
  assert.equal(reader.offset, offset);
  assert.equal(reader.acknowledge(first.revision), true);
  const acknowledged = reader.pendingChanges();
  const next = Buffer.from(
    `${JSON.stringify(row({ response_id: "response-b", ms: 3000, req: "codex/模型", model: "模型" }))}\n`,
  );
  const split = next.indexOf(Buffer.from("模")) + 1;
  await appendFile(file, next.subarray(0, split));
  assert.equal(await reader.read(file), true);
  assert.equal(reader.offset, offset);
  assert.deepEqual(reader.pendingChanges(), acknowledged);
  await appendFile(file, next.subarray(split));
  await reader.read(file);
  assert.equal(reader.recordsForRequest("response-b", "模型", 100)[0].durationMs, 3000);
  assert.equal(reader.requests.size, 2);
  assert.deepEqual(reader.pendingChanges().responseIds, new Set(["response-b"]));
  assert.equal(reader.pendingChanges().reset, false);
});

test("canonicalize only explicit Codex provider aliases; preserve mismatches for the timing kernel", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(file, `${JSON.stringify(row())}\n`);
  await reader.read(file);
  assert.equal(reader.recordsForRequest("response-a", "model-a", 101)[0].reportedOutputTokens, 100);
  assert.equal(reader.recordsForRequest("response-a", "other/model-a", 100)[0].requestedModel, "codex/model-a");
  assert.equal(reader.recordsForRequest("response-a", "codex/model-a", 100).length, 1);
  await appendFile(file, `${JSON.stringify(row({ response_id: "response-b", provider: "other" }))}\n`);
  await reader.read(file);
  assert.equal(reader.recordsForRequest("response-b", "model-a", 100)[0].requestedModel, "codex/model-a");
});

test("failed, interrupted and invalid requests cannot supply a denominator", async (t) => {
  const { file, reader } = await fixture(t);
  const invalid = [
    null,
    { agent: "claude" },
    { status: 500 },
    { ms: 0 },
    { out: -1 },
    { out: 1.5 },
    { tries: 0 },
    { retried_ms: -1 },
    { stop: "incomplete" },
    { handed_on: true },
    { rejected: true },
    { ep: "/v1/chat/completions" },
    { response_id: "" },
  ];
  await writeFile(file, `broken-json\n${invalid.map((r) => JSON.stringify(r === null ? r : row(r))).join("\n")}\n`);
  await reader.read(file);
  assert.equal(reader.requests.size, 0);
  assert.equal(reader.pendingChanges().responseIds.size, 0);
  reader.acknowledge(reader.pendingChanges().revision);
  const acknowledged = reader.pendingChanges();
  await appendFile(file, `broken-json\n${JSON.stringify(row({ status: 500 }))}\n`);
  assert.equal(await reader.read(file), true);
  assert.deepEqual(reader.pendingChanges(), acknowledged);
});

test("valid retry fields retain the producer's request duration", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(
    file,
    [
      row({ provider: "opendesign", req: "opendesign/model-a", tries: 2, retried_ms: 500 }),
      row({ response_id: "response-b", tries: 3, retried_ms: 30 }),
      row({ response_id: "response-c", tries: 2, retried_ms: 0, sent_ms: 1500, own_ms: 900 }),
      row({ response_id: "response-d", tries: 2 }),
    ]
      .map((r) => `${JSON.stringify(r)}\n`)
      .join(""),
  );
  await reader.read(file);
  assert.equal(reader.recordsForRequest("response-a", "model-a", 100)[0].durationMs, 2000);
  assert.equal(reader.recordsForRequest("response-b", "model-a", 100)[0].durationMs, 2000);
  assert.equal(reader.recordsForRequest("response-c", "model-a", 100)[0].durationMs, 2000);
  assert.equal(reader.recordsForRequest("response-d", "model-a", 100)[0].durationMs, 2000);
});

test("rotation rereads the new ledger; absent ledger is optional", async (t) => {
  const { file, reader } = await fixture(t);
  assert.equal(await reader.read(file), false);
  reader.acknowledge(reader.pendingChanges().revision);
  await writeFile(file, `${JSON.stringify(row())}\n`);
  await reader.read(file);
  const opened = reader.pendingChanges();
  assert.equal(opened.reset, true);
  reader.acknowledge(opened.revision);
  await rename(file, `${file}.old`);
  await writeFile(file, `${JSON.stringify(row({ response_id: "response-b" }))}\n`);
  await reader.read(file);
  assert.equal(reader.recordsForRequest("response-a", "model-a", 100).length, 0);
  assert.equal(reader.recordsForRequest("response-b", "model-a", 100).length, 1);
  const rotated = reader.pendingChanges();
  assert.equal(rotated.reset, true);
  assert.deepEqual(rotated.responseIds, new Set(["response-b"]));
  assert.equal(reader.acknowledge(opened.revision), false);
  reader.acknowledge(rotated.revision);
  await writeFile(file, "");
  assert.equal(await reader.read(file), false);
  assert.equal(reader.requests.size, 0);
  const truncated = reader.pendingChanges();
  assert.equal(truncated.reset, true);
  assert.deepEqual(truncated.responseIds, new Set());
  assert.equal(reader.acknowledge(rotated.revision), false);
  assert.equal(await reader.read(file), false);
  assert.deepEqual(reader.pendingChanges(), truncated);
  await rm(file);
  assert.equal(await reader.read(file), false);
  const missing = reader.pendingChanges();
  assert.equal(missing.reset, true);
  assert.ok(missing.revision > truncated.revision);
  assert.equal(await reader.read(file), false);
  assert.deepEqual(reader.pendingChanges(), missing);
  reader.acknowledge(missing.revision);
  assert.equal(await reader.read(file), false);
  assert.equal(reader.pendingChanges().reset, false);
  await writeFile(file, "");
  assert.equal(await reader.read(file), false);
  const returned = reader.pendingChanges();
  assert.equal(returned.reset, true);
  assert.ok(returned.revision > missing.revision);
  assert.equal(reader.acknowledge(missing.revision), false);
  assert.equal(reader.acknowledge(returned.revision), true);
});

test("duplicate observations deduplicate; conflicting durations remain separate", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(file, [row(), row(), row({ ms: 4000 })].map((r) => `${JSON.stringify(r)}\n`).join(""));
  await reader.read(file);
  assert.deepEqual(
    reader.recordsForRequest("response-a", "model-a", 100).map((r) => r.durationMs),
    [2000, 4000],
  );
  const first = reader.pendingChanges();
  assert.deepEqual(first.responseIds, new Set(["response-a"]));
  reader.acknowledge(first.revision);
  const acknowledged = reader.pendingChanges();
  await appendFile(file, `${JSON.stringify(row({ host: "ignored-host" }))}\n`);
  assert.equal(await reader.read(file), true);
  assert.deepEqual(reader.pendingChanges(), acknowledged);
  await appendFile(file, `${JSON.stringify(row({ ms: 6000 }))}\n`);
  await reader.read(file);
  const conflict = reader.pendingChanges();
  assert.deepEqual(conflict.responseIds, new Set(["response-a"]));
  assert.equal(conflict.reset, false);
  assert.ok(conflict.revision > first.revision);
  assert.equal(reader.acknowledge(first.revision), false);
});

test("pending snapshots are independent and clear invalidates old acknowledgements", () => {
  const reader = new MagpieRequestTimings();
  reader.addLine(JSON.stringify(row()));
  const first = reader.pendingChanges();
  first.responseIds.clear();
  first.responseIds.add("consumer-only");
  assert.deepEqual(reader.pendingChanges().responseIds, new Set(["response-a"]));
  reader.addLine(JSON.stringify(row({ ms: 4000 })));
  assert.equal(reader.acknowledge(first.revision), false);
  const conflict = reader.pendingChanges();
  reader.clear();
  assert.equal(reader.requests.size, 0);
  const cleared = reader.pendingChanges();
  assert.equal(cleared.reset, true);
  assert.deepEqual(cleared.responseIds, new Set(["response-a"]));
  assert.ok(cleared.revision > conflict.revision);
  assert.equal(reader.acknowledge(conflict.revision), false);
  assert.equal(reader.acknowledge(cleared.revision), true);
  assert.deepEqual(reader.pendingChanges(), {
    revision: cleared.revision,
    responseIds: new Set(),
    reset: false,
  });
  assert.deepEqual(cleared.responseIds, new Set(["response-a"]));
});

test("a failed read and retries without new bytes retain unpublished changes", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(file, "");
  assert.equal(await reader.read(file), false);
  reader.acknowledge(reader.pendingChanges().revision);
  await appendFile(file, `${JSON.stringify(row())}\n`);
  const addLine = reader.addLine;
  reader.addLine = (line) => {
    addLine.call(reader, line);
    throw new Error("injected read failure");
  };
  await assert.rejects(reader.read(file), /injected read failure/);
  reader.addLine = addLine;
  const pending = reader.pendingChanges();
  assert.deepEqual(pending.responseIds, new Set(["response-a"]));
  assert.equal(pending.reset, false);
  assert.equal(await reader.read(file), true);
  assert.deepEqual(reader.pendingChanges(), pending);
  assert.equal(await reader.read(file), false);
  assert.deepEqual(reader.pendingChanges(), pending);
  assert.equal(reader.acknowledge(pending.revision), true);
});

test("same-size ledger rewrites reset associations when mtime changes", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(file, `${JSON.stringify(row())}\n`);
  await reader.read(file);
  const first = reader.pendingChanges();
  reader.acknowledge(first.revision);
  await writeFile(file, `${JSON.stringify(row({ response_id: "response-b" }))}\n`);
  const rewrittenAt = new Date(reader.mtimeMs + 2000);
  await utimes(file, rewrittenAt, rewrittenAt);
  assert.equal(await reader.read(file), true);
  assert.equal(reader.recordsForRequest("response-a", "model-a", 100).length, 0);
  assert.equal(reader.pendingChanges().reset, true);
  assert.deepEqual(reader.pendingChanges().responseIds, new Set(["response-b"]));
  assert.equal(reader.acknowledge(first.revision), false);
});
