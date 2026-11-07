import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { HistoryProjectionStore } from "../src/usage-history-projection-store.js";

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "history-verification-receipts-"));
  const source = path.join(directory, "source.sqlite");
  const store = new HistoryProjectionStore(source, (row) => row);
  mkdirSync(store.directory);
  const file = `projection-${randomUUID()}.sqlite`;
  const database = new DatabaseSync(path.join(store.directory, file));
  database.exec("PRAGMA journal_mode=WAL; CREATE TABLE facts(value INTEGER); INSERT INTO facts VALUES(17)");
  writeFileSync(path.join(store.directory, "current.json"), JSON.stringify({ format: 1, file }));
  store.verificationDatabase = database;
  t.after(() => {
    database.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, source, database };
}

test("completed receipts survive another store without opening or changing authoritative facts", (t) => {
  const { store, source, database } = fixture(t);
  const first = store.verificationReceipts();
  assert.equal(first.has("candidate-v1:bytes-a:manifest-a"), false);
  first.add("candidate-v1:bytes-a:manifest-a");
  const reopened = new HistoryProjectionStore(source, (row) => row);
  assert.equal(reopened.verificationReceipts().has("candidate-v1:bytes-a:manifest-a"), true);
  assert.equal(reopened.verificationReceipts().has("candidate-v1:bytes-a:manifest-b"), false);
  assert.equal(reopened.verificationReceipts().has("candidate-v2:bytes-a:manifest-a"), false);
  assert.equal(database.prepare("SELECT value FROM facts").get().value, 17);
});

test("incomplete caller transactions publish no receipts and damaged schema is a miss", (t) => {
  const { store, database } = fixture(t);
  const receipts = store.verificationReceipts();
  database.exec("BEGIN");
  receipts.add("incomplete");
  database.exec("ROLLBACK");
  assert.equal(receipts.has("incomplete"), false);
  database.exec("CREATE TABLE usage_history_verification_receipts(proof TEXT); INSERT INTO usage_history_verification_receipts VALUES('forged')");
  assert.equal(receipts.has("forged"), false);
  receipts.add("completed");
  assert.equal(receipts.has("completed"), true);
  assert.equal(receipts.has("forged"), false);
});

test("receipt history stays bounded and eviction only loses an optimization", (t) => {
  const { store, database } = fixture(t);
  const receipts = store.verificationReceipts();
  for (let i = 0; i < 270; i++) receipts.add(`package-${i}`);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM usage_history_verification_receipts").get().n, 256);
  assert.equal(receipts.has("package-0"), false);
  assert.equal(receipts.has("package-269"), true);
  database.exec("DROP TABLE usage_history_verification_receipts");
  assert.equal(receipts.has("package-269"), false);
  receipts.add("package-269");
  assert.equal(receipts.has("package-269"), true);
});
