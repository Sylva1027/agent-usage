import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";

function projectLogLine(timestamp, sessionId, total) {
  return `${JSON.stringify({
    schema_version: "codex-usage.project-log.v1",
    timestamp,
    source: "test",
    channel: "Test",
    project_root: "/work/source-replacement",
    cwd: "/work/source-replacement",
    session_id: sessionId,
    model: "gpt-6-sol",
    usage: {
      total,
      input: total - 20,
      cached: 0,
      output: 20,
      reasoning: 0,
    },
  })}\n`;
}

function codexTokenCount(timestamp, model, cumulative, last) {
  const usage = (total) => ({
    total_tokens: total,
    input_tokens: total - 20,
    cached_input_tokens: 0,
    output_tokens: 20,
    reasoning_output_tokens: 0,
  });
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: usage(cumulative),
        last_token_usage: usage(last),
      },
      rate_limits: {
        limit_id: "codex",
        primary: {
          window_minutes: 300,
          resets_at: Date.parse("2026-07-12T16:30:00.000Z") / 1000,
          used_percent: model.endsWith("-new") ? 42 : 11,
        },
        secondary: {
          window_minutes: 10_080,
          resets_at: Date.parse("2026-07-19T16:30:00.000Z") / 1000,
          used_percent: null,
        },
      },
    },
  });
}

function makeProjectFixture(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const importDir = path.join(root, "import-a");
  const usageFile = path.join(importDir, ".codex-usage", "usage.jsonl");
  mkdirSync(path.dirname(usageFile), { recursive: true });
  const options = { homeDir: root, env: {}, importDirs: [importDir] };
  return {
    root,
    usageFile,
    options,
    storeOptions: { ...options, databaseFile: path.join(root, "index.sqlite") },
  };
}

function makeCodexFixture(prefix) {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const rolloutFile = path.join(root, ".codex", "sessions", "2026", "07", "12", "rollout-replacement.jsonl");
  mkdirSync(path.dirname(rolloutFile), { recursive: true });
  const options = { homeDir: root, env: {} };
  return {
    root,
    rolloutFile,
    options,
    storeOptions: { ...options, databaseFile: path.join(root, "index.sqlite") },
  };
}

function invalidateSource(store, sourcePath) {
  store.database.prepare("UPDATE source_files SET size=-1,mtime_ms=-1 WHERE path=?").run(sourcePath);
}

function eventRows(store, sourcePath) {
  return store.database
    .prepare("SELECT * FROM events WHERE source_path=? ORDER BY id")
    .all(sourcePath)
    .map((row) => ({ ...row }));
}

function canonicalEventPayload(row) {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([name]) => name !== "id")
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function replacementRows(store, sourcePath = null) {
  const statement =
    sourcePath === null
      ? store.database.prepare("SELECT * FROM history_replaced_facts ORDER BY fact_table,payload_digest")
      : store.database.prepare(
          "SELECT * FROM history_replaced_facts WHERE source_path=? ORDER BY fact_table,payload_digest",
        );
  const rows = sourcePath === null ? statement.all() : statement.all(sourcePath);
  return rows.map((row) => ({
    ...row,
    occurrence_count: Number(row.occurrence_count),
    payload_object: JSON.parse(row.payload),
  }));
}

test("duplicate rows that differ only by auto id leave one missing occurrence", async (t) => {
  const fixture = makeProjectFixture("usage-replacement-duplicate-");
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const line = projectLogLine("2026-07-12T02:00:00.000Z", "duplicate-session", 100);
  writeFileSync(fixture.usageFile, line + line);
  const store = new UsageStore(fixture.storeOptions);
  try {
    await store.sync({ options: fixture.options });
    const before = eventRows(store, fixture.usageFile);
    assert.equal(before.length, 2);
    assert.notEqual(before[0].id, before[1].id);
    assert.deepEqual(canonicalEventPayload(before[0]), canonicalEventPayload(before[1]));
    const sourceIdentity = {
      ...store.database
        .prepare("SELECT kind,home_id,home_label,home_path FROM source_files WHERE path=?")
        .get(fixture.usageFile),
    };

    writeFileSync(fixture.usageFile, line);
    invalidateSource(store, fixture.usageFile);
    const round = await store.sync({ options: fixture.options });
    assert.equal(round.updatedFileCount, 1);
    assert.deepEqual(eventRows(store, fixture.usageFile).map(canonicalEventPayload), [
      canonicalEventPayload(before[0]),
    ]);

    const archive = replacementRows(store, fixture.usageFile);
    assert.equal(archive.length, 1);
    assert.equal(archive[0].fact_table, "events");
    assert.equal(archive[0].occurrence_count, 1);
    assert.equal(archive[0].payload_digest, createHash("sha256").update(archive[0].payload).digest("hex"));
    assert.deepEqual(archive[0].payload_object, canonicalEventPayload(before[0]));
    assert.deepEqual(
      {
        kind: archive[0].source_kind,
        home_id: archive[0].home_id,
        home_label: archive[0].source_home_label,
        home_path: archive[0].source_home_path,
      },
      sourceIdentity,
    );
    assert.equal(archive[0].method_version, "events.v1");
    assert.equal(archive[0].revision_reason, "reparse_replaced");
    assert.equal(Object.hasOwn(archive[0].payload_object, "id"), false);
  } finally {
    store.close();
  }
});

test("a true replacement retains the exact previous event payload", async (t) => {
  const fixture = makeProjectFixture("usage-replacement-revision-");
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  writeFileSync(fixture.usageFile, projectLogLine("2026-07-12T02:00:00.000Z", "old-session", 100));
  const store = new UsageStore(fixture.storeOptions);
  try {
    await store.sync({ options: fixture.options });
    const [oldEvent] = eventRows(store, fixture.usageFile);
    writeFileSync(fixture.usageFile, projectLogLine("2026-07-12T02:05:00.000Z", "new-session", 240));
    invalidateSource(store, fixture.usageFile);
    await store.sync({ options: fixture.options });

    const [current] = eventRows(store, fixture.usageFile);
    assert.equal(current.session_id, "new-session");
    assert.equal(Number(current.total), 240);
    const archive = replacementRows(store, fixture.usageFile);
    assert.equal(archive.length, 1);
    assert.equal(archive[0].occurrence_count, 1);
    assert.deepEqual(archive[0].payload_object, canonicalEventPayload(oldEvent));
  } finally {
    store.close();
  }
});

test("an equivalent complete replacement creates no false missing history", async (t) => {
  const fixture = makeProjectFixture("usage-replacement-equivalent-");
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const contents =
    projectLogLine("2026-07-12T02:00:00.000Z", "same-a", 100) +
    projectLogLine("2026-07-12T02:01:00.000Z", "same-b", 200);
  writeFileSync(fixture.usageFile, contents);
  const store = new UsageStore(fixture.storeOptions);
  try {
    await store.sync({ options: fixture.options });
    const before = eventRows(store, fixture.usageFile);
    const originalReplaceFile = store.replaceFile.bind(store);
    let replacements = 0;
    store.replaceFile = async (file, options) => {
      replacements += 1;
      return originalReplaceFile(file, options);
    };

    writeFileSync(fixture.usageFile, contents);
    invalidateSource(store, fixture.usageFile);
    const round = await store.sync({ options: fixture.options });
    assert.equal(round.updatedFileCount, 1);
    assert.equal(replacements, 1, "the equivalent file must still traverse the complete replacement path");
    const after = eventRows(store, fixture.usageFile);
    assert.deepEqual(after.map(canonicalEventPayload), before.map(canonicalEventPayload));
    assert.deepEqual(replacementRows(store), []);
  } finally {
    store.close();
  }
});

test("a Codex replacement stages events and quota observations with their exact table methods", async (t) => {
  const fixture = makeCodexFixture("usage-replacement-quota-");
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const writeRollout = (timestamp, model, cumulative, last) => {
    writeFileSync(
      fixture.rolloutFile,
      `${[
        JSON.stringify({
          timestamp,
          type: "session_meta",
          payload: {
            id: "replacement-session",
            source: "cli",
            originator: "codex-tui",
            cwd: "/work/source-replacement",
          },
        }),
        JSON.stringify({ type: "turn_context", payload: { model } }),
        codexTokenCount(timestamp, model, cumulative, last),
      ].join("\n")}\n`,
    );
  };
  writeRollout("2026-07-12T11:30:00.000Z", "gpt-6-old", 100, 100);
  const store = new UsageStore(fixture.storeOptions);
  try {
    await store.sync({ options: fixture.options });
    const [oldEvent] = eventRows(store, fixture.rolloutFile);

    writeRollout("2026-07-12T11:35:00.000Z", "gpt-6-new", 150, 50);
    invalidateSource(store, fixture.rolloutFile);
    await store.sync({ options: fixture.options });

    const [current] = eventRows(store, fixture.rolloutFile);
    assert.equal(current.session_id, "replacement-session");
    assert.equal(current.model, "gpt-6-new");
    assert.equal(Number(current.total), 50);

    const archive = replacementRows(store, fixture.rolloutFile);
    const eventArchive = archive.filter((row) => row.fact_table === "events");
    const quotaArchive = archive.filter((row) => row.fact_table === "rate_limit_observations");
    assert.equal(eventArchive.length, 1);
    assert.equal(eventArchive[0].occurrence_count, 1);
    assert.equal(eventArchive[0].method_version, "events.v1");
    assert.deepEqual(eventArchive[0].payload_object, canonicalEventPayload(oldEvent));
    assert.equal(quotaArchive.length, 2);
    assert.ok(quotaArchive.every((row) => row.occurrence_count === 1));
    assert.ok(quotaArchive.every((row) => row.method_version === "rate_limit_observations.v1"));
    assert.ok(quotaArchive.every((row) => row.revision_reason === "reparse_replaced"));
    assert.deepEqual(
      quotaArchive
        .map((row) => [row.payload_object.role, row.payload_object.used_percent])
        .sort(([left], [right]) => left.localeCompare(right)),
      [
        ["primary", 11],
        ["secondary", null],
      ],
    );
    assert.ok(
      quotaArchive.every((row) => row.payload_object.observed_at_ms === Date.parse("2026-07-12T11:30:00.000Z")),
    );
  } finally {
    store.close();
  }
});

test("an archive insert failure rolls back every staged fact and recovers after restart", async (t) => {
  const fixture = makeProjectFixture("usage-replacement-rollback-");
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const oldContents =
    projectLogLine("2026-07-12T02:00:00.000Z", "old-a", 100) + projectLogLine("2026-07-12T02:01:00.000Z", "old-b", 200);
  const newContents =
    projectLogLine("2026-07-12T02:02:00.000Z", "new-a", 300) + projectLogLine("2026-07-12T02:03:00.000Z", "new-b", 400);
  writeFileSync(fixture.usageFile, oldContents);
  let store = new UsageStore(fixture.storeOptions);
  let recovered = null;
  try {
    await store.sync({ options: fixture.options });
    const oldEvents = eventRows(store, fixture.usageFile);
    writeFileSync(fixture.usageFile, newContents);
    invalidateSource(store, fixture.usageFile);
    store.database.exec(`
      CREATE TRIGGER fail_after_second_replacement_fact
      AFTER INSERT ON history_replaced_facts
      WHEN (SELECT COUNT(*) FROM history_replaced_facts)=2
      BEGIN
        SELECT RAISE(ABORT, 'injected replacement archive failure');
      END
    `);

    const failed = await store.sync({ options: fixture.options });
    assert.equal(failed.updatedFileCount, 0);
    assert.ok(store.warnings.some((warning) => warning.includes("injected replacement archive failure")));
    assert.deepEqual(
      eventRows(store, fixture.usageFile).map(canonicalEventPayload),
      oldEvents.map(canonicalEventPayload),
    );
    assert.deepEqual(replacementRows(store), [], "the first staged archive insert must roll back with the second");
    store.close();
    store = null;

    const maintenance = new DatabaseSync(fixture.storeOptions.databaseFile);
    try {
      maintenance.exec("DROP TRIGGER fail_after_second_replacement_fact");
    } finally {
      maintenance.close();
    }

    recovered = new UsageStore(fixture.storeOptions);
    const repaired = await recovered.sync({ options: fixture.options });
    assert.equal(repaired.updatedFileCount, 1);
    assert.deepEqual(
      eventRows(recovered, fixture.usageFile).map((row) => row.session_id),
      ["new-a", "new-b"],
    );
    assert.deepEqual(
      replacementRows(recovered, fixture.usageFile)
        .map((row) => [row.payload_object.session_id, row.occurrence_count])
        .sort(),
      [
        ["old-a", 1],
        ["old-b", 1],
      ],
    );
  } finally {
    store?.close();
    recovered?.close();
  }
});
