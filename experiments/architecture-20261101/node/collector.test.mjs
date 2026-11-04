import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { writeRawFixture } from "../fixture.mjs";
import { SourceCollector, collectSource } from "./collector.mjs";
import { SqliteStore } from "./store.mjs";

async function codexSource(filePath, total = 110) {
  await writeFile(
    filePath,
    `${[
      {
        type: "session_meta",
        timestamp: "2026-11-01T12:00:00.000Z",
        payload: { id: "codex-session", cwd: "/fixture/project", source: "cli" },
      },
      { type: "turn_context", timestamp: "2026-11-01T12:00:00.000Z", payload: { model: "gpt-5" } },
      {
        type: "event_msg",
        timestamp: "2026-11-01T12:00:01.000Z",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 20,
              output_tokens: 10,
              reasoning_output_tokens: 2,
              total_tokens: total,
            },
          },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n")}\n`,
  );
}

test("collectSource normalizes the shared Codex and DSH fixtures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-collector-"));
  try {
    const fixture = await writeRawFixture(directory);
    const codex = await collectSource(fixture.sources[0]);
    const dsh = await collectSource(fixture.sources[1]);

    assert.equal(codex.events.length, 1);
    assert.equal(codex.events[0].eventId, "raw-codex:1");
    assert.deepEqual(codex.events[0].total, {
      input: 100,
      cached: 20,
      output: 10,
      reasoning: 2,
      total: 110,
    });

    assert.equal(dsh.events.length, 1);
    assert.equal(dsh.events[0].eventId, "raw-dsh:1");
    assert.equal(dsh.events[0].total.total, 130);
    assert.equal(dsh.events[0].total.cached, 20);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex collection rejects a final line without a newline", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-collector-newline-"));
  const filePath = path.join(directory, "codex.jsonl");
  try {
    await codexSource(filePath);
    const complete = await readFile(filePath);
    await writeFile(filePath, complete.subarray(0, complete.length - 1));
    await assert.rejects(
      collectSource({
        sourceId: "codex",
        kind: "codex",
        path: filePath,
        home: { id: "home", label: "Codex", path: directory, kind: "codex" },
      }),
      /complete newline-terminated line/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("content hash detects a same-size and same-mtime replacement", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-collector-hash-"));
  const filePath = path.join(directory, "codex.jsonl");
  const databasePath = path.join(directory, "usage.sqlite");
  const store = new SqliteStore(databasePath);
  try {
    await codexSource(filePath, 110);
    const collector = new SourceCollector({
      store,
      useWatcher: false,
      intervalMs: 60_000,
      sources: [
        {
          sourceId: "codex",
          kind: "codex",
          path: filePath,
          home: { id: "home", label: "Codex", path: directory, kind: "codex" },
        },
      ],
    });

    await collector.checkSource("codex");
    assert.equal(store.status().revision, 1);
    const before = await stat(filePath);
    const text = await readFile(filePath, "utf8");
    await writeFile(filePath, text.replace('"total_tokens":110', '"total_tokens":120'));
    await utimes(filePath, before.atime, before.mtime);

    await collector.checkSource("codex");
    assert.equal(store.status().revision, 2);
    assert.equal(store.report().events[0].total.total, 120);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("DSH warnings leave the previously accepted source facts intact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "architecture-collector-dsh-"));
  const databasePath = path.join(directory, "usage.sqlite");
  const store = new SqliteStore(databasePath);
  try {
    const fixture = await writeRawFixture(directory);
    const dshSource = fixture.sources[1];
    const collector = new SourceCollector({
      store,
      sources: [dshSource],
      useWatcher: false,
      intervalMs: 60_000,
    });

    await collector.checkSource(dshSource.sourceId);
    const accepted = store.report();
    assert.equal(accepted.events.length, 1);

    const valid = await readFile(dshSource.path);
    await writeFile(
      dshSource.path,
      Buffer.concat([valid, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0x00])]),
    );
    await collector.checkSource(dshSource.sourceId);

    assert.equal(collector.statusesSnapshot()[dshSource.sourceId].state, "failed");
    assert.deepEqual(store.report(), accepted);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
