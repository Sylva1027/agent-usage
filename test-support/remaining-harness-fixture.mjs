import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const REMAINING_HARNESSES = ["claude", "workbuddy", "zcode", "opencode"];
export const FIXTURE_TIME = Date.parse("2026-10-20T12:00:00Z");

export function transcriptRows(kind, index, output = 20 + (index % 7)) {
  const sessionId = "long-session";
  const id = `message-${index}`;
  // Many equal timestamps exercise stable locale ordering across spilled runs.
  const timestamp = FIXTURE_TIME + (index % 17) * 1000;
  if (kind === "claude") {
    const record = {
      type: "assistant", sessionId, timestamp: new Date(timestamp).toISOString(), cwd: "/fixture/project",
      message: { id, model: "claude-sonnet-4-5-20250929", usage: {
        input_tokens: 100, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: output,
      }, content: [{ type: "text", text: "BODY-SENTINEL".repeat(32) }] },
    };
    return [record, { ...record, message: { ...record.message, usage: { ...record.message.usage, output_tokens: output + 5 } } }];
  }
  const record = {
    type: "message", sessionId, timestamp, cwd: "/fixture/project",
    providerData: { messageId: id, model: "deepseek-v4.1-flash", usage: {
      inputTokens: 140, outputTokens: output, totalTokens: 140 + output,
      inputTokensDetails: [{ cached_tokens: 30 }], outputTokensDetails: [{ reasoning_tokens: 5 }],
    }, rawUsage: { cache_creation_input_tokens: 10 } },
    content: "BODY-SENTINEL".repeat(32),
  };
  return [
    { ...record, providerData: { ...record.providerData, model: "default-model" } },
    { ...record, timestamp: "invalid" }, record,
    { ...record, providerData: { ...record.providerData, usage: { ...record.providerData.usage, outputTokens: 999 } } },
  ];
}

export function insertDatabaseEvent(database, kind, index, output = 20 + (index % 7)) {
  const id = `session-${index}`;
  if (kind === "zcode") {
    database.prepare("INSERT INTO session VALUES (?,?,?,?,?,?)").run(id, "", "/fixture/project", "", `Title ${index}`, "metadata".repeat(40));
    database.prepare("INSERT INTO model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
      `event-${index}`, id, FIXTURE_TIME + index, FIXTURE_TIME + index + 1,
      140, output, 30, 5, 10, 140 + output, "gpt-6-sol",
    );
  } else {
    database.prepare("INSERT INTO session_v2 VALUES (?,?,?,?,?)").run(id, "/fixture/project", `Title ${index}`, "2.0.19", "metadata".repeat(40));
    const data = { time: { completed: FIXTURE_TIME + index + 1 }, model: { id: "gpt-6-sol", providerID: "fixture" },
      tokens: { input: 100, output: output - 5, reasoning: 5, cache: { read: 30, write: 10 } } };
    database.prepare("INSERT INTO session_message VALUES (?,?,?,?,?,?)").run(`event-${index}`, id, "assistant", index, FIXTURE_TIME + index, JSON.stringify(data));
  }
}

export function createRemainingHarnessFixture(directory, kind, count) {
  mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, kind === "claude" || kind === "workbuddy" ? "session.jsonl" : "source.sqlite");
  const source = { id: `fixture-${kind}`, label: `Fixture ${kind}`, path: directory, kind };
  if (filePath.endsWith("jsonl")) {
    const fd = openSync(filePath, "w");
    try {
      for (let index = 0; index < count; index++) {
        for (const record of transcriptRows(kind, index)) writeSync(fd, `${JSON.stringify(record)}\n`);
      }
      if (kind === "claude") writeSync(fd, `${JSON.stringify({ type: "custom-title", customTitle: "Final title" })}\n`);
    } finally { closeSync(fd); }
  } else {
    const db = new DatabaseSync(filePath);
    try {
      db.exec(kind === "zcode" ? `CREATE TABLE session(id TEXT PRIMARY KEY,parent_id TEXT,directory TEXT,path TEXT,title TEXT,notes TEXT);
        CREATE TABLE model_usage(id TEXT PRIMARY KEY,session_id TEXT,started_at INTEGER,completed_at INTEGER,input_tokens INTEGER,output_tokens INTEGER,
          cache_read_input_tokens INTEGER,reasoning_tokens INTEGER,cache_creation_input_tokens INTEGER,computed_total_tokens INTEGER,model_id TEXT);`
        : `CREATE TABLE session_v2(id TEXT PRIMARY KEY,directory TEXT,title TEXT,version TEXT,notes TEXT);
          CREATE TABLE session_message(id TEXT PRIMARY KEY,session_id TEXT,type TEXT,seq INTEGER,time_created INTEGER,data TEXT);`);
      db.exec("BEGIN");
      for (let index = 0; index < count; index++) insertDatabaseEvent(db, kind, index);
      db.exec("COMMIT");
    } finally { db.close(); }
  }
  return { filePath, source };
}
