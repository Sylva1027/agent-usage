import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { loadQuotaSourceEvidence, quotaSourceEvidenceSnapshot } from "../src/quota-source-evidence.js";
import { loadServiceTierEvidence, serviceTierEvidenceSnapshot } from "../src/service-tier-evidence.js";
import { readUsageSourceInputs } from "../src/usage-source-inputs.js";

const TIER_TARGET = "codex_core::session::handlers";
const AUTH_TARGET = "feedback_tags";
const HTTP_TARGET = "codex_http_client::client";
const TIME = 1_000_000;
const tierMessage = (field, operation = "TurnInput") =>
  `Submission sub=Submission { id: "test", op: ${operation} { service_tier: ${field}, collaboration_mode: None } }`;
const httpMessage = (url, status = "completed", method = "POST") =>
  `responses.stream_request{transport="responses_http" api.path="/responses"}: Request ${status} method=${method} url=${url}`;

async function fixture(t, journal = "WAL", supported = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-source-inputs-evidence-"));
  let database;
  t.after(async () => {
    database?.close();
    await rm(root, { recursive: true, force: true });
  });
  const home = { id: "fixture", kind: "main", path: path.join(root, ".codex") };
  await mkdir(home.path);
  const file = path.join(home.path, "logs_2.sqlite");
  database = new DatabaseSync(file);
  database.exec(
    supported
      ? "CREATE TABLE logs (id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER, thread_id TEXT, target TEXT, feedback_log_body TEXT)"
      : "CREATE TABLE logs (id INTEGER PRIMARY KEY, feedback_log_body TEXT)",
  );
  assert.equal(database.prepare(`PRAGMA journal_mode=${journal}`).get().journal_mode, journal.toLowerCase());
  database.exec("PRAGMA wal_autocheckpoint=0");
  const homes = [home];
  return {
    database,
    homes,
    file,
    read: () => readUsageSourceInputs({ homeDir: root }, homes, "fixed-history-fingerprint"),
    insert({ id, target, message, threadId = "thread", seconds = TIME / 1000 }) {
      database
        .prepare("INSERT INTO logs (id, ts, ts_nanos, thread_id, target, feedback_log_body) VALUES (?, ?, 0, ?, ?, ?)")
        .run(id, seconds, threadId, target, message);
    },
  };
}

function assertChanged(before, after, label) {
  for (const key of ["inputs", "auxiliary", "routingFingerprint"]) {
    assert.notEqual(after[key], before[key], `${label}: ${key}`);
  }
  assert.deepEqual(after.files, before.files);
}

for (const journal of ["DELETE", "WAL"]) {
  test(`diagnostic appends do not change source signatures (${journal})`, async (t) => {
    const f = await fixture(t, journal);
    f.insert({ id: 1, target: "diagnostic", message: "initial diagnostic" });
    const before = await f.read();
    const physicalFile = journal === "WAL" ? `${f.file}-wal` : f.file;
    const physicalBefore = await stat(physicalFile);
    const request = httpMessage("https://api.openai.com/v1/responses");
    const tier = tierMessage('Some(Some("priority"))');
    const ignored = [
      { target: "diagnostic", message: "unrelated log data ".repeat(4096) },
      { target: TIER_TARGET, message: "turn finished" },
      { target: AUTH_TARGET, message: "auth_header_attached=true" },
      { target: HTTP_TARGET, message: request.replace('transport="responses_http"', 'transport="websocket"') },
      { target: HTTP_TARGET, message: request.replace('api.path="/responses"', 'api.path="/models"') },
      { target: HTTP_TARGET, message: request.replace("url=", "endpoint=") },
      { target: "diagnostic", message: `${tier} auth_mode=Chatgpt ${request}` },
      { target: TIER_TARGET, message: tier, threadId: null },
      { target: AUTH_TARGET, message: "auth_mode=Chatgpt", threadId: null },
      { target: HTTP_TARGET, message: request, threadId: null },
      { target: AUTH_TARGET, message: "auth_mode=Chatgpt", threadId: "" },
      { target: HTTP_TARGET, message: request, threadId: "" },
    ];
    for (const [index, row] of ignored.entries()) f.insert({ id: index + 2, ...row });
    assert.ok((await stat(physicalFile)).size > physicalBefore.size, "the physical source really grew");
    assert.deepEqual(await f.read(), before);
    assert.deepEqual(serviceTierEvidenceSnapshot(loadServiceTierEvidence(f.homes)).threads, []);
    assert.deepEqual(quotaSourceEvidenceSnapshot(loadQuotaSourceEvidence(f.homes)).entries, []);

    if (journal === "WAL") {
      f.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      assert.equal((await stat(physicalFile)).size, 0);
      assert.deepEqual(await f.read(), before, "checkpointing diagnostics does not change semantic inputs");
    }
  });
}

const evidenceCases = [
  {
    name: "service tier",
    target: TIER_TARGET,
    first: tierMessage('Some(Some("priority"))'),
    second: tierMessage('Some(Some("default"))'),
    expected: ["priority", "default"],
    resolve: (homes) => loadServiceTierEvidence(homes).resolve("thread", TIME),
  },
  {
    name: "auth mode",
    target: AUTH_TARGET,
    first: "auth_mode=Some(Chatgpt)",
    second: 'auth_mode="OpenaiApiKey"',
    expected: ["plan", "api"],
    resolve: (homes) => loadQuotaSourceEvidence(homes).resolve("fixture", "thread", TIME),
  },
  {
    name: "Responses HTTP route",
    target: HTTP_TARGET,
    first: httpMessage("https://chatgpt.com/backend-api/codex/responses"),
    second: httpMessage("https://relay.example.test/v1/responses"),
    expected: ["plan", "external"],
    resolve: (homes) => loadQuotaSourceEvidence(homes).resolve("fixture", "thread", TIME),
  },
];

for (const entry of evidenceCases) {
  test(`${entry.name} insert, same-id update and delete invalidate signatures and warm parser caches`, async (t) => {
    const f = await fixture(t);
    // Hold MAX(id) steady so parser refreshes must come from source-input invalidation.
    f.insert({ id: 100, target: "diagnostic", message: "high-water mark" });
    const initial = await f.read();
    assert.equal(entry.resolve(f.homes), "unknown");

    f.insert({ id: 1, target: entry.target, message: entry.first });
    const added = await f.read();
    assertChanged(initial, added, "insert");
    assert.equal(entry.resolve(f.homes), entry.expected[0]);

    f.database.prepare("UPDATE logs SET feedback_log_body=? WHERE id=1").run(entry.second);
    const updated = await f.read();
    assertChanged(added, updated, "same-id update");
    assert.equal(entry.resolve(f.homes), entry.expected[1]);

    f.database.exec("DELETE FROM logs WHERE id=1");
    const deleted = await f.read();
    assertChanged(updated, deleted, "delete below MAX(id)");
    assert.deepEqual(deleted, initial, "removing all evidence restores the original signature");
    assert.equal(entry.resolve(f.homes), "unknown");
    assert.equal(f.database.prepare("SELECT MAX(id) AS id FROM logs").get().id, 100);
  });
}

test("source predicates cover tier settings, accepted auth spellings and all Responses request statuses", async (t) => {
  const f = await fixture(t);
  let previous = await f.read();
  const rows = [
    ...["fast", "priority", "default", "standard"].map((tier) => ({
      target: TIER_TARGET,
      message: tierMessage(`Some(Some("${tier}"))`),
      tier,
    })),
    ...["Chatgpt", "ApiKey", "OpenaiApiKey"].flatMap((mode) =>
      [`Some(${mode})`, mode, `"${mode}"`].map((value) => ({
        target: AUTH_TARGET,
        message: `auth_mode=${value}`,
        quota: mode === "Chatgpt" ? "plan" : "api",
      })),
    ),
    ...["started", "completed", "failed"].flatMap((status) =>
      ["POST", "GET"].map((method) => ({
        target: HTTP_TARGET,
        message: httpMessage("https://api.openai.com/v1/responses", status, method),
        quota: "api",
      })),
    ),
  ];
  for (const [index, row] of rows.entries()) {
    const threadId = `thread-${index}`;
    f.insert({ id: index + 1, threadId, ...row });
    const next = await f.read();
    assertChanged(previous, next, row.message);
    assert.equal(loadServiceTierEvidence(f.homes).resolve(threadId, TIME), row.tier || "unknown");
    assert.equal(loadQuotaSourceEvidence(f.homes).resolve("fixture", threadId, TIME), row.quota || "unknown");
    previous = next;
  }

  f.insert({ id: 100, target: TIER_TARGET, message: tierMessage('Some(Some("fast"))', "ThreadSettings") });
  const settings = await f.read();
  assertChanged(previous, settings, "ThreadSettings");
  f.insert({ id: 101, target: TIER_TARGET, message: tierMessage("None") });
  const inherited = await f.read();
  assertChanged(settings, inherited, "TurnInput None");
  assert.equal(loadServiceTierEvidence(f.homes).resolve("thread", TIME), "fast");
  f.insert({ id: 102, target: TIER_TARGET, message: tierMessage("Some(None)") });
  assertChanged(inherited, await f.read(), "TurnInput Some(None)");
  assert.equal(loadServiceTierEvidence(f.homes).resolve("thread", TIME), "unknown");
});

for (const journal of ["DELETE", "WAL"]) {
  test(`unsupported log schemas retain physical source signatures (${journal})`, async (t) => {
    const f = await fixture(t, journal, false);
    const insert = f.database.prepare("INSERT INTO logs (feedback_log_body) VALUES (?)");
    insert.run("initial diagnostic");
    const before = await f.read();
    const physicalFile = journal === "WAL" ? `${f.file}-wal` : f.file;
    const physicalBefore = await stat(physicalFile);
    const databaseBefore = await stat(f.file);
    insert.run("unrelated diagnostic ".repeat(4096));
    assert.ok((await stat(physicalFile)).size > physicalBefore.size);
    if (journal === "WAL") {
      const databaseAfter = await stat(f.file);
      assert.equal(databaseAfter.size, databaseBefore.size);
      assert.equal(databaseAfter.mtimeMs, databaseBefore.mtimeMs, "the change exists only in WAL");
    }
    assertChanged(before, await f.read(), "physical fallback");
  });
}
