import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { UsageStore } from "../src/usage-store.js";
import {
  REMAINING_HARNESSES,
  createRemainingHarnessFixture,
  insertDatabaseEvent,
  transcriptRows,
} from "../test-support/remaining-harness-fixture.mjs";

function facts(store) {
  return store.database
    .prepare("SELECT * FROM events ORDER BY id")
    .all()
    .map(({ id: _id, ...row }) => ({ ...row }));
}

function expectedTotal(kind, count) {
  let total = 0;
  for (let index = 0; index < count; index++) total += 140 + 20 + (index % 7) + (kind === "claude" ? 5 : 0);
  return total;
}

function editSource(fixture, kind) {
  if (fixture.filePath.endsWith("jsonl")) {
    const lines = [];
    for (let index = 0; index < 9; index++) {
      if (index !== 2) lines.push(...transcriptRows(kind, index, index === 1 ? 70 : 20 + (index % 7)));
    }
    writeFileSync(fixture.filePath, `${lines.map(JSON.stringify).join("\n")}\n`);
  } else {
    const db = new DatabaseSync(fixture.filePath);
    try {
      db.exec("BEGIN");
      if (kind === "zcode") {
        db.prepare(
          "UPDATE model_usage SET output_tokens=70,computed_total_tokens=210 WHERE session_id='session-1'",
        ).run();
        db.prepare("UPDATE session SET directory='/fixture/revised' WHERE id='session-1'").run();
        db.prepare("DELETE FROM model_usage WHERE session_id='session-2'").run();
      } else {
        const row = db.prepare("SELECT data FROM session_message WHERE session_id='session-1'").get();
        const data = JSON.parse(row.data);
        data.tokens.output = 65;
        db.prepare("UPDATE session_message SET data=? WHERE session_id='session-1'").run(JSON.stringify(data));
        db.prepare("UPDATE session_v2 SET directory='/fixture/revised' WHERE id='session-1'").run();
        db.prepare("DELETE FROM session_message WHERE session_id='session-2'").run();
      }
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  }
}

for (const kind of REMAINING_HARNESSES) {
  test(`${kind}: replacement preserves exact facts, revisions, rollback and restart`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), `remaining-store-${kind}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const fixture = createRemainingHarnessFixture(path.join(root, "source"), kind, 8);
    const storeFile = path.join(root, "index.sqlite");
    let store = new UsageStore({ homeDir: root, databaseFile: storeFile });
    let fresh;
    const replace = () => store.replaceFile({ ...fixture, info: statSync(fixture.filePath) });
    try {
      await store.open();
      await replace();
      assert.equal(facts(store).length, 8);
      assert.equal(store.summarize({ preset: "all" }).totals.total, expectedTotal(kind, 8));
      if (fixture.filePath.endsWith("jsonl")) {
        appendFileSync(fixture.filePath, `${transcriptRows(kind, 8).map(JSON.stringify).join("\n")}\n`);
      } else {
        const db = new DatabaseSync(fixture.filePath);
        try {
          insertDatabaseEvent(db, kind, 8);
        } finally {
          db.close();
        }
      }
      await replace();
      assert.equal(facts(store).length, 9);
      assert.equal(store.summarize({ preset: "all" }).totals.total, expectedTotal(kind, 9));

      const before = facts(store);
      const sourceBefore = { ...store.database.prepare("SELECT * FROM source_files").get() };
      const revisionsBefore = store.database.prepare("SELECT * FROM history_replaced_facts").all();
      editSource(fixture, kind);
      store.database.exec(`CREATE TRIGGER fail_remaining BEFORE INSERT ON events
        WHEN NEW.output>=70 BEGIN SELECT RAISE(ABORT,'test replacement failure'); END;`);
      await assert.rejects(replace, /test replacement failure/);
      assert.deepEqual(facts(store), before);
      assert.deepEqual({ ...store.database.prepare("SELECT * FROM source_files").get() }, sourceBefore);
      assert.deepEqual(store.database.prepare("SELECT * FROM history_replaced_facts").all(), revisionsBefore);
      store.database.exec("DROP TRIGGER fail_remaining");
      await replace();
      assert.equal(facts(store).length, 8);
      assert.equal(
        store.summarize({ preset: "all" }).totals.total,
        expectedTotal(kind, 9) - (140 + 22 + (kind === "claude" ? 5 : 0)) + 49,
      );
      assert.ok(Number(store.database.prepare("SELECT COUNT(*) AS n FROM history_replaced_facts").get().n) >= 2);

      fresh = new UsageStore({ homeDir: root, databaseFile: path.join(root, "fresh.sqlite") });
      await fresh.open();
      await fresh.replaceFile({ ...fixture, info: statSync(fixture.filePath) });
      assert.deepEqual(facts(store), facts(fresh));
      const filters = { preset: "all", now: "2026-10-21T00:00:00Z" };
      assert.deepEqual(store.summarize(filters), fresh.summarize(filters));
      const final = facts(store);
      store.close();
      // Opening an existing index must retain history even when raw inputs have disappeared.
      rmSync(fixture.filePath);
      store = new UsageStore({ homeDir: root, databaseFile: storeFile });
      await store.open();
      assert.deepEqual(facts(store), final);
      assert.equal(String(store.database.prepare("PRAGMA quick_check").get().quick_check), "ok");
    } finally {
      fresh?.close();
      store.close();
    }
  });
}
