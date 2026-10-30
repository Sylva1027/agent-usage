import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendOutputObservation,
  normalizeOutputObservation,
  outputObservationFile,
  readOutputObservations,
  workbuddyOutputObservationFile,
} from "../src/perf-output-observations.js";

const measurement = {
  samplingWindowMs: 100,
  tokenizer: "o200k_base",
  outputTokens: 200,
  durationMs: 200,
  windows: [{ startMs: 1000, endMs: 1200, outputTokens: 200 }],
};

test("local output observations bind exact identities, strip bodies and retain conflicts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "output-observations-"));
  try {
    const sourceFile = path.join(root, "session.v4.jsonl.zstd");
    const file = outputObservationFile(sourceFile, "dsh");
    const raw = {
      schemaVersion: 3,
      sourceKind: "dsh",
      sessionId: "session",
      messageId: "message",
      model: "model",
      modelProvider: "provider",
      clock: "transport_receive",
      measurement,
      body: "PRIVATE_BODY",
    };
    assert.equal((await readOutputObservations(sourceFile, "dsh"))("session", "message", "model", "provider"), null);
    assert.equal(normalizeOutputObservation({ ...raw, schemaVersion: 1 }), null);
    await appendOutputObservation(file, raw);
    await appendOutputObservation(file, raw);
    const lookup = await readOutputObservations(sourceFile, "dsh");
    assert.deepEqual(lookup("session", "message", "model", "provider"), measurement);
    assert.equal(lookup("other-session", "message", "model", "provider"), null);
    assert.equal(lookup("session", "message", "other-model", "provider"), null);
    assert.equal((await readFile(file, "utf8")).includes("PRIVATE_BODY"), false);
    const conflicting = {
      ...measurement,
      outputTokens: 201,
      windows: [{ ...measurement.windows[0], outputTokens: 201 }],
    };
    await appendOutputObservation(file, { ...raw, measurement: conflicting });
    await appendOutputObservation(file, raw);
    assert.equal((await readOutputObservations(sourceFile, "dsh"))("session", "message", "model", "provider"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkBuddy request headers bind the local session and message despite a wire model alias", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "output-workbuddy-"));
  try {
    const sourceFile = path.join(root, "projects", "project", "session.jsonl");
    await mkdir(path.dirname(sourceFile), { recursive: true });
    const file = outputObservationFile(sourceFile, "workbuddy");
    assert.equal(file, workbuddyOutputObservationFile(root, "session"));
    assert.notEqual(file, workbuddyOutputObservationFile(root, "other-session"));
    await appendOutputObservation(file, {
      schemaVersion: 2,
      sourceKind: "workbuddy",
      sessionId: "session",
      messageId: "local-message",
      model: "wire-model",
      clock: "transport_receive",
      measurement,
    });
    const lookup = await readOutputObservations(sourceFile, "workbuddy");
    assert.deepEqual(lookup("session", "local-message", "local-model"), measurement);
    assert.equal(lookup("other-session", "local-message", "local-model"), null);
    assert.equal(lookup("session", "wire-response", "local-model"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
