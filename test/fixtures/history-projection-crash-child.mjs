import { UsageHistoryQuery } from "../../src/usage-history-query.js";
import {
  HistoryProjectionStore,
  ensureHistoryProjectionTracking,
  readHistoryProjectionStamp,
  recordHistoryProjectionBatch,
} from "../../src/usage-history-projection-store.js";
import { UsageStore } from "../../src/usage-store.js";

const config = JSON.parse(process.argv[2]);
const store = new UsageStore({
  databaseFile: config.file,
  homeDir: config.root,
  env: {},
  importDirs: [],
  automaticDiscoveryEnabled: false,
});
await store.open();
store.homes = [{ id: "home", label: "Home", path: config.root, kind: "codex" }];
store.serviceTierEvidenceInput = "fixture-standard";
ensureHistoryProjectionTracking(store.database);

function stop(stage, database) {
  if (!process.send) throw new Error("Crash fixture needs IPC");
  process.send({
    stage,
    transactionOpen: database.isTransaction,
    eventCount: Number(database.prepare("SELECT COUNT(*) n FROM events").get().n),
    stamp: readHistoryProjectionStamp(store.database),
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error("Crash fixture resumed without SIGKILL");
}

const finishChanges = UsageHistoryQuery.prototype.finishChanges;
UsageHistoryQuery.prototype.finishChanges = function (...args) {
  const work = finishChanges.apply(this, args);
  if (config.stage === "projection-transaction" && work.added > 0) {
    if (!this.database.isTransaction) throw new Error("Projection crash point escaped its outer transaction");
    stop(config.stage, this.database);
  }
  return work;
};
const applyDelta = HistoryProjectionStore.prototype.applyDelta;
HistoryProjectionStore.prototype.applyDelta = function (prepared, ...args) {
  const work = applyDelta.call(this, prepared, ...args);
  if (config.stage === "projection-commit") {
    if (prepared.query.database.isTransaction) throw new Error("Projection crash point is still uncommitted");
    stop(config.stage, prepared.query.database);
  }
  return work;
};

const database = store.database;
const before = readHistoryProjectionStamp(database);
database.exec("BEGIN IMMEDIATE");
const event = { ...database.prepare("SELECT * FROM events ORDER BY id LIMIT 1").get() };
delete event.id;
const date = new Date(config.timestamp);
event.timestamp_ms = config.timestamp;
event.session_id = "crash-session";
event.total = config.total;
event.input = config.total - 10;
event.request_input_tokens = config.total - 10;
event.day_key = date.toISOString().slice(0, 10);
event.hour_key = `${event.day_key} ${date.toISOString().slice(11, 13)}`;
event.month_key = event.day_key.slice(0, 7);
date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() || 7) - 1));
event.week_key = date.toISOString().slice(0, 10);
const columns = Object.keys(event);
database
  .prepare(`INSERT INTO events(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`)
  .run(...Object.values(event));
recordHistoryProjectionBatch(database, before, { sources: [config.sourcePath], mode: "append" });
database.exec("COMMIT");
if (config.stage === "facts-commit") stop(config.stage, database);
await store.dashboardHistory(config.filters, { includeDetails: false });
throw new Error(`Crash fixture did not reach ${config.stage}`);
