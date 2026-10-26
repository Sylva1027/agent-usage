import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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
  assert.equal(await reader.read(file), false);
  assert.equal(reader.offset, offset);
  const next = JSON.stringify(row({ response_id: "response-b", ms: 3000, req: "codex/模型", model: "模型" }));
  await appendFile(file, next.slice(0, 30));
  await reader.read(file);
  assert.equal(reader.offset, offset);
  await appendFile(file, `${next.slice(30)}\n`);
  await reader.read(file);
  assert.equal(reader.recordsForRequest("response-b", "模型", 100)[0].durationMs, 3000);
  assert.equal(reader.requests.size, 2);
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
  await writeFile(file, `${JSON.stringify(row())}\n`);
  await reader.read(file);
  await rename(file, `${file}.old`);
  await writeFile(file, `${JSON.stringify(row({ response_id: "response-b" }))}\n`);
  await reader.read(file);
  assert.equal(reader.recordsForRequest("response-a", "model-a", 100).length, 0);
  assert.equal(reader.recordsForRequest("response-b", "model-a", 100).length, 1);
  await writeFile(file, "");
  await reader.read(file);
  assert.equal(reader.requests.size, 0);
});

test("duplicate observations deduplicate; conflicting durations remain separate", async (t) => {
  const { file, reader } = await fixture(t);
  await writeFile(file, [row(), row(), row({ ms: 4000 })].map((r) => `${JSON.stringify(r)}\n`).join(""));
  await reader.read(file);
  assert.deepEqual(
    reader.recordsForRequest("response-a", "model-a", 100).map((r) => r.durationMs),
    [2000, 4000],
  );
});
