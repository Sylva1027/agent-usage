import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  loadQuotaSourceEvidence,
  quotaSourceEvidenceFromSnapshot,
  quotaSourceEvidenceSnapshot,
} from "../src/quota-source-evidence.js";

const PRIVATE_TEXT = "PRIVATE_USER_TEXT auth_mode=Some(Chatgpt)";
const TOKEN = "Bearer sk-private-token";

const at = (seconds) => Date.parse("2026-10-29T00:00:00Z") + seconds * 1000;

const authMessage = (mode) =>
  `session_loop{thread_id=span-thread}: turn effort=Some(XHigh) auth_mode=Some(${mode}) tags_json={"private":${JSON.stringify(PRIVATE_TEXT)}}`;

const quotedAuthMessage = (mode) =>
  `responses.stream_request{transport="responses_http" http.method="POST" api.path="/responses"}: endpoint="/responses" auth_header_attached=true auth_header_name="authorization" auth_mode="${mode}" ${TOKEN}`;

const responsesMessage = (url, spanThread = "span-thread") =>
  `session_loop{thread_id=${spanThread}}:responses.stream_request{transport="responses_http" http.method="POST" api.path="/responses"}:endpoint_session.stream_encoded_json_with{http.method=POST api.path="/responses"}: Request completed method=POST url=${url} status=200 OK`;

function createLog(filePath) {
  const database = new DatabaseSync(filePath);
  database.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY,
      ts INTEGER,
      ts_nanos INTEGER,
      level TEXT,
      target TEXT,
      feedback_log_body TEXT,
      module_path TEXT,
      file TEXT,
      line INTEGER,
      thread_id TEXT,
      process_uuid TEXT,
      estimated_bytes INTEGER
    )
  `);
  return database;
}

function insertLog(database, { time, threadId, target, message }) {
  const seconds = Math.floor(time / 1000);
  database
    .prepare("INSERT INTO logs (ts, ts_nanos, target, feedback_log_body, thread_id) VALUES (?, ?, ?, ?, ?)")
    .run(seconds, (time - seconds * 1000) * 1_000_000, target, message, threadId);
}

async function makeHome(root, name, kind = "main") {
  const homePath = path.join(root, name);
  await mkdir(homePath, { recursive: true });
  return { id: name, label: name, path: homePath, kind };
}

test("native auth and Responses routes resolve per home and thread with recoverable switches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quota-source-routes-"));
  try {
    const first = await makeHome(root, "first");
    const second = await makeHome(root, "second", "codex");
    const firstLog = createLog(path.join(first.path, "logs_2.sqlite"));
    const secondLog = createLog(path.join(second.path, "logs_2.sqlite"));
    try {
      insertLog(firstLog, {
        time: at(1),
        threadId: "switch",
        target: "feedback_tags",
        message: authMessage("Chatgpt"),
      });
      insertLog(firstLog, {
        time: at(1),
        threadId: "switch",
        target: "codex_http_client::client",
        message: responsesMessage("https://chatgpt.com/backend-api/codex/responses"),
      });
      insertLog(firstLog, {
        time: at(2),
        threadId: "switch",
        target: "codex_http_client::client",
        message: responsesMessage("https://relay.example.test/v1/responses"),
      });
      insertLog(firstLog, {
        time: at(2) + 100,
        threadId: "switch",
        target: "feedback_tags",
        message: quotedAuthMessage("Chatgpt"),
      });
      insertLog(firstLog, {
        time: at(3),
        threadId: "switch",
        target: "codex_http_client::client",
        message: responsesMessage("https://chatgpt.com/backend-api/codex/responses"),
      });
      insertLog(firstLog, {
        time: at(4),
        threadId: "switch",
        target: "codex_http_client::client",
        message: responsesMessage("https://api.openai.com/v1/responses"),
      });
      for (const [index, host] of ["127.0.0.1:3456", "[::1]:3456", "localhost:3456"].entries()) {
        insertLog(firstLog, {
          time: at(5 + index),
          threadId: `proxy-${index}`,
          target: "codex_http_client::client",
          message: responsesMessage(`http://${host}/backend-api/codex/responses`),
        });
      }
      insertLog(firstLog, {
        time: at(10),
        threadId: "user-text",
        target: "codex_core::session::handlers",
        message: `${PRIVATE_TEXT} Request completed method=POST url=https://api.openai.com/v1/responses`,
      });
      insertLog(firstLog, {
        time: at(11),
        threadId: null,
        target: "codex_http_client::client",
        message: responsesMessage("https://relay.example.test/v1/responses", "user-text"),
      });
      insertLog(secondLog, {
        time: at(1),
        threadId: "switch",
        target: "codex_http_client::client",
        message: responsesMessage("https://relay.example.test/v1/responses"),
      });
    } finally {
      firstLog.close();
      secondLog.close();
    }

    const evidence = loadQuotaSourceEvidence([first, second]);
    assert.equal(evidence.resolve("first", "switch", at(1)), "plan");
    assert.equal(evidence.resolve("first", "switch", at(2)), "external");
    assert.equal(evidence.resolve("first", "switch", at(3)), "plan");
    assert.equal(evidence.resolve("first", "switch", at(4)), "api");
    assert.equal(evidence.resolve("first", "proxy-0", at(5)), "unknown");
    assert.equal(evidence.resolve("first", "proxy-1", at(6)), "unknown");
    assert.equal(evidence.resolve("first", "proxy-2", at(7)), "unknown");
    assert.equal(evidence.resolve("first", "user-text", at(10)), "unknown");
    assert.equal(evidence.resolve("second", "switch", at(1)), "external");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("split auth and route logs merge without erasing explicit recorded sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quota-source-merge-"));
  try {
    const home = await makeHome(root, "home");
    const database = createLog(path.join(home.path, "logs_2.sqlite"));
    try {
      insertLog(database, {
        time: at(1),
        threadId: "api-proxy",
        target: "codex_http_client::client",
        message: responsesMessage("http://127.0.0.1:3456/backend-api/codex/responses"),
      });
      insertLog(database, {
        time: at(1) + 100,
        threadId: "api-proxy",
        target: "feedback_tags",
        message: quotedAuthMessage("ApiKey"),
      });
      insertLog(database, {
        time: at(2),
        threadId: "external-auth",
        target: "codex_http_client::client",
        message: responsesMessage("https://gateway.example.test/responses"),
      });
      insertLog(database, {
        time: at(2) + 100,
        threadId: "external-auth",
        target: "feedback_tags",
        message: quotedAuthMessage("Chatgpt"),
      });
      insertLog(database, {
        time: at(2) + 200,
        threadId: "external-api-auth",
        target: "codex_http_client::client",
        message: responsesMessage("https://gateway.example.test/responses"),
      });
      insertLog(database, {
        time: at(2) + 300,
        threadId: "external-api-auth",
        target: "feedback_tags",
        message: quotedAuthMessage("ApiKey"),
      });
      insertLog(database, {
        time: at(3),
        threadId: "api-auth",
        target: "feedback_tags",
        message: authMessage("OpenaiApiKey"),
      });
      insertLog(database, {
        time: at(4),
        threadId: "plan-auth",
        target: "feedback_tags",
        message: authMessage("Chatgpt"),
      });
      insertLog(database, {
        time: at(5),
        threadId: "bare-chatgpt",
        target: "feedback_tags",
        message: "effort=Some(High) auth_mode=Chatgpt tags_json={}",
      });
    } finally {
      database.close();
    }

    const evidence = loadQuotaSourceEvidence([home]);
    assert.equal(evidence.resolve("home", "api-proxy", at(1) + 200), "api");
    assert.equal(evidence.resolve("home", "external-auth", at(2) + 200), "external");
    assert.equal(evidence.resolve("home", "external-api-auth", at(2) + 400), "external");
    assert.equal(evidence.resolve("home", "api-auth", at(3)), "api");
    assert.equal(evidence.resolve("home", "plan-auth", at(4)), "plan");
    assert.equal(evidence.resolve("home", "bare-chatgpt", at(5)), "plan");
    assert.equal(evidence.resolve("home", "plan-auth", at(4), "api"), "api");
    assert.equal(evidence.resolve("home", "plan-auth", at(4), "external"), "external");
    assert.equal(evidence.resolve("home", "plan-auth", at(4), "credits"), "credits");
    assert.equal(evidence.resolve("home", "missing", at(4), "credits"), "credits");
    assert.equal(evidence.resolve("home", "missing", at(4), "unknown"), "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("snapshot is sanitized, round-trips, and preserves history across an empty rotated log", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quota-source-snapshot-"));
  try {
    const home = await makeHome(root, "home");
    const logFile = path.join(home.path, "logs_2.sqlite");
    const database = createLog(logFile);
    try {
      insertLog(database, {
        time: at(1),
        threadId: "thread-a",
        target: "feedback_tags",
        message: authMessage("Chatgpt"),
      });
      insertLog(database, {
        time: at(1),
        threadId: "thread-a",
        target: "codex_http_client::client",
        message: responsesMessage("https://chatgpt.com/backend-api/codex/responses"),
      });
    } finally {
      database.close();
    }

    const evidence = loadQuotaSourceEvidence([home]);
    const snapshot = quotaSourceEvidenceSnapshot(evidence);
    assert.equal(snapshot.formatVersion, 1);
    assert.deepEqual(Object.keys(snapshot.entries[0]).sort(), ["homeId", "sessionId", "source", "time"]);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes(PRIVATE_TEXT), false);
    assert.equal(serialized.includes("https://"), false);
    assert.equal(serialized.includes("sk-private-token"), false);

    const restored = quotaSourceEvidenceFromSnapshot(JSON.parse(serialized));
    assert.equal(restored.resolve("home", "thread-a", at(1)), "plan");
    assert.equal(restored.resolve("home", "thread-a", at(1) + 1000, "credits"), "credits");

    await rm(logFile);
    const empty = createLog(logFile);
    empty.close();
    const afterRotation = loadQuotaSourceEvidence([home], snapshot);
    assert.equal(afterRotation.resolve("home", "thread-a", at(1)), "plan");

    const rotated = new DatabaseSync(logFile);
    try {
      insertLog(rotated, {
        time: at(2),
        threadId: "thread-a",
        target: "codex_http_client::client",
        message: responsesMessage("https://api.openai.com/v1/responses"),
      });
    } finally {
      rotated.close();
    }
    const extended = loadQuotaSourceEvidence([home], snapshot);
    assert.equal(extended.resolve("home", "thread-a", at(1)), "plan");
    assert.equal(extended.resolve("home", "thread-a", at(2)), "api");

    assert.throws(
      () => quotaSourceEvidenceSnapshot({ resolve: () => "unknown" }),
      /expected quota-source evidence returned by this module/,
    );
    assert.throws(
      () =>
        quotaSourceEvidenceFromSnapshot({
          formatVersion: 1,
          entries: [{ homeId: "home", sessionId: "thread", time: 1, source: "invalid" }],
        }),
      /unsupported snapshot source/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
