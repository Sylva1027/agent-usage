import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { compactRegisteredHistory } from "../src/history-archive-compaction.js";
import { clean, makeCompactionFixture } from "../test-support/history-compaction-fixture.mjs";

test("SIGKILL before/after primary publication and during/after projection commit resumes without cold copying", async (t) => {
  for (const stage of ["before-main", "after-main", "projection-write", "projection-commit"]) {
    await t.test(stage, async (t) => {
      const f = await makeCompactionFixture(t);
      f.reviseCold(3);
      const expected = clean(await f.read());
      const query = f.store.historyProjectionStore.query.database;
      const identities = query.prepare("SELECT id,history_ordinal FROM events ORDER BY id").all();
      await f.prepareMapping();
      const config = {
        stage,
        file: f.file,
        root: f.root,
        mappingFile: path.join(f.directory, "compaction.json"),
        homes: f.store.homes,
        evidenceInput: f.store.serviceTierEvidenceInput,
      };
      f.store.close();
      const child = fork(
        fileURLToPath(new URL("./fixtures/history-archive-compaction-crash-child.mjs", import.meta.url)),
        [JSON.stringify(config)],
        { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
      );
      let errors = "";
      child.stderr.on("data", (data) => {
        errors += String(data);
      });
      const exited = once(child, "exit");
      try {
        const marker = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`No ${stage} marker: ${errors}`)), 20000);
          child.once("message", (message) => {
            clearTimeout(timer);
            resolve(message);
          });
          child.once("exit", () => {
            clearTimeout(timer);
            reject(new Error(`Child exited before ${stage}: ${errors}`));
          });
        });
        assert.equal(marker.stage, stage);
        assert.equal(marker.transactionOpen, stage === "projection-write");
        child.kill("SIGKILL");
        await exited;
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      }
      await f.reopen();
      const resumed = await compactRegisteredHistory(f.store, f.directory);
      assert.equal(resumed.projection.rebuilt, false);
      assert.equal(resumed.projection.coldCopied, 0);
      assert.deepEqual(clean(await f.read()), expected);
      assert.deepEqual(
        f.store.historyProjectionStore.query.database
          .prepare("SELECT id,history_ordinal FROM events ORDER BY id")
          .all(),
        identities,
      );
      assert.equal(f.store.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
      const again = await compactRegisteredHistory(f.store, f.directory);
      assert.equal(again.switched, 0);
      assert.equal(again.projection.rebuilt, false);
      assert.deepEqual(clean(await f.read()), expected);
    });
  }
});
