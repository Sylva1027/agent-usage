import { readFileSync } from "node:fs";
import { switchHistoryArchivePackages } from "../../src/history-archive-compaction.js";
import { HistoryProjectionStore } from "../../src/usage-history-projection-store.js";
import { UsageStore } from "../../src/usage-store.js";

const config = JSON.parse(process.argv[2]);
const mapping = JSON.parse(readFileSync(config.mappingFile, "utf8"));
const store = new UsageStore({
  databaseFile: config.file,
  homeDir: config.root,
  env: {},
  importDirs: [],
  automaticDiscoveryEnabled: false,
});
await store.open();
store.homes = config.homes;
store.serviceTierEvidenceInput = config.evidenceInput;

function stop(database) {
  process.send({ stage: config.stage, transactionOpen: database.isTransaction });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
  throw new Error("Compaction fault marker was not followed by a parent kill");
}

const rebind = store.rebindHistoryArchiveReferences.bind(store);
store.rebindHistoryArchiveReferences = (...args) => {
  if (config.stage === "before-main") stop(store.database);
  rebind(...args);
  if (config.stage === "after-main") stop(store.database);
};
const apply = HistoryProjectionStore.prototype.applyDelta;
HistoryProjectionStore.prototype.applyDelta = function (prepared, ...args) {
  const database = prepared.query.database,
    exec = database.exec.bind(database);
  if (config.stage === "projection-write")
    database.exec = (sql) => {
      if (sql === "COMMIT") stop(database);
      return exec(sql);
    };
  const result = apply.call(this, prepared, ...args);
  if (config.stage === "projection-commit") stop(database);
  return result;
};
await switchHistoryArchivePackages(store, mapping);
store.close();
throw new Error(`Compaction never reached ${config.stage}`);
