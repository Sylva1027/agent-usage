import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  fixture,
  assertCanonical,
  assertRollback,
  sourceRows,
  bounded,
  deferred,
  other,
  QUERY,
  HOT_ONLY,
} from "../test-support/live-publication-fixture.mjs";

for (const kind of ["codex", "dsh"]) {
  test(`1 ${kind}: discovered source changes before SHA verify; HTTP returns the complete new value`, {
    timeout: 25_000,
  }, async (t) => {
    const f = await fixture(t, kind);
    await f.listen();
    await f.success();
    f.trace.length = 0;
    await f.append();
    let injected = 0;
    f.handler = async (event) => {
      if (event.stage === "before-verify" && event.file === f.paths[kind] && !injected++) await f.append(kind, 43);
    };
    const payload = await f.success();
    assert.equal(f.trace.filter((e) => e.stage === "source-error" && e.file === f.paths[kind]).length, 1);
    const failed = f.trace.find((e) => e.stage === "source-error");
    assert.equal(failed.error.code, "LIVE_SOURCE_CHANGED");
    assert.equal(failed.error.retryable, true);
    assert.equal(f.trace.find((e) => e.stage === "round-done").snapshot.work.sourceRetries, 1);
    await assertCanonical(f, payload);
  });

  test(`2 ${kind}: append between parsing and capture rolls back; direct APIs retain LIVE_SOURCE_CHANGED`, {
    timeout: 25_000,
  }, async (t) => {
    const f = await fixture(t, kind);
    const discovered = (await f.store.usageFiles(f.store.homes)).files.find((file) => file.filePath === f.paths[kind]);
    await f.append();
    await assert.rejects(f.store.appendFile(discovered), { code: "LIVE_SOURCE_CHANGED", retryable: true });
    await assert.rejects(f.store.replaceFile(discovered), { code: "LIVE_SOURCE_CHANGED", retryable: true });
    await f.listen();
    f.trace.length = 0;
    let before;
    let injected = false;
    f.handler = async (event) => {
      if (event.file !== f.paths[kind]) return;
      if (event.stage === "source-start" && !before) before = event.snapshot;
      if (event.stage === "before-capture" && !injected) {
        assert.equal(event.snapshot.transaction, true);
        assert.ok(sourceRows(event.snapshot, event.file).length > sourceRows(before, event.file).length);
        injected = true;
        await f.append(kind, 43);
      }
      if (event.stage === "source-error") assertRollback(before, event.snapshot, event.file);
      if (event.stage === "before-capture") return { warning: "recovery fixture parser warning" };
    };
    const payload = await f.success();
    assert.equal(injected, true);
    assert.equal(f.trace.filter((e) => e.stage === "source-error").length, 1);
    assert.equal(
      f.trace
        .find((event) => event.stage === "round-done")
        .snapshot.warnings.filter((warning) => warning === "recovery fixture parser warning").length,
      1,
      "the failed attempt's onWarning must roll back before the successful parse publishes its warning",
    );
    await assertCanonical(f, payload);
  });

  test(`3 ${kind}: the other source commits first; retry neither replays it nor publishes a partial round`, {
    timeout: 25_000,
  }, async (t) => {
    const f = await fixture(t, kind);
    await f.listen();
    const original = await f.success();
    const sse = await f.events();
    f.trace.length = 0;
    await f.append(other(kind), 31);
    await f.append();
    let injected = false;
    f.handler = async (event) => {
      if (event.stage === "before-verify" && event.file === f.paths[kind] && !injected) {
        assert.equal(f.trace.filter((e) => e.stage === "source-commit" && e.file === f.paths[other(kind)]).length, 1);
        assert.equal(
          f.trace.some((e) => e.stage === "round-done"),
          false,
        );
        const status = await f.get(`/api/status?since=${encodeURIComponent(original.fingerprint)}`);
        assert.equal(status.status, 200);
        assert.equal(status.body.changed, true, "partial facts must still require a refresh");
        assert.notEqual(status.body.usageVersion, original.usageVersion);
        assert.equal(
          sse.events.some((event) => event.name === "usage-synced"),
          false,
          "partial facts cannot emit completion",
        );
        injected = true;
        await f.append(kind, 43);
      }
    };
    const payload = await f.success();
    assert.equal(injected, true);
    assert.notEqual(payload.usageVersion, original.usageVersion);
    assert.equal(f.trace.filter((e) => e.stage === "source-commit" && e.file === f.paths[other(kind)]).length, 1);
    await assertCanonical(f, payload);

    f.trace.length = 0;
    await f.append(kind, 29);
    let retried = false;
    let auxiliaryChanged = false;
    f.handler = async (event) => {
      if (event.stage === "before-verify" && event.file === f.paths[kind] && !retried) {
        retried = true;
        await f.append(kind, 17);
      }
      if (event.stage === "round-done" && !auxiliaryChanged) {
        assert.equal(event.snapshot.work.sourceRetries, 1);
        auxiliaryChanged = true;
        await writeFile(path.join(f.root, ".codex", "config.toml"), 'model = "gpt-5.2-codex"\n');
      }
    };
    const pending = await f.get();
    f.check();
    assert.equal(auxiliaryChanged, true);
    assert.equal(pending.status, 409, "new auxiliary input cannot label already parsed facts as fully synchronized");
    assert.equal(pending.body.code, "SOURCE_UPDATE_PENDING");
    assert.equal("summary" in pending.body, false);
    const unfinished = f.trace.find((event) => event.stage === "round-done");
    await f.wait((event) => event.stage === "round-done" && event !== unfinished, "auxiliary input recovery");
    await assertCanonical(f, await f.success());
  });

  test(`4 ${kind}: three conflicts return pending 409; one delayed successor recovers with no notification or SSE client`, {
    timeout: 25_000,
  }, async (t) => {
    const f = await fixture(t, kind);
    await f.listen();
    await f.success();
    f.trace.length = 0;
    await f.append();
    let invalidations = 0;
    const release = deferred();
    f.cleanup.push(() => release.resolve());
    f.handler = async (event) => {
      if (event.stage === "before-verify" && event.file === f.paths[kind] && invalidations < 3) {
        invalidations += 1;
        await f.append(kind, 40 + invalidations);
      }
      if (event.stage === "round-start" && f.trace.some((e) => e.stage === "round-error")) await release.promise;
    };
    const pending = await f.get();
    f.check();
    assert.equal(pending.status, 409, JSON.stringify(pending.body));
    assert.equal(pending.body.code, "SOURCE_UPDATE_PENDING");
    assert.equal("summary" in pending.body, false);
    assert.equal(invalidations, 3);
    const exhausted = f.trace.find((e) => e.stage === "round-error");
    assert.equal(exhausted.error.code, "SOURCE_UPDATE_PENDING");
    assert.equal(exhausted.error.statusCode, 409);
    assert.equal(exhausted.snapshot.work.sourceRetries, 2);
    const failedRound = exhausted.round;
    assert.equal(
      f.trace.filter((e) => e.round === failedRound && e.stage === "source-start" && e.file === f.paths[kind]).length,
      3,
    );
    for (let i = 0; i < 3; i++)
      assert.equal((await f.get()).status, 409, "requests during pending cannot amplify sync");
    const successor = await f.wait(
      (e) => e.stage === "round-start" && e.round !== failedRound,
      "automatic delayed successor without new hint",
    );
    assert.ok(successor.observedAt - exhausted.observedAt >= 900, "the successor yields through the one-second timer");
    assert.equal(f.trace.filter((e) => e.stage === "round-start").length, 2);
    release.resolve();
    await f.wait((e) => e.stage === "round-done", "automatic convergence");
    const payload = await f.success();
    assert.equal(f.trace.filter((e) => e.stage === "source-commit" && e.file === f.paths[kind]).length, 1);
    await assertCanonical(f, payload);
  });

  test(`5 ${kind}: three tabs, duplicate hints, SSE and status share a coherent flight`, {
    timeout: 25_000,
  }, async (t) => {
    const f = await fixture(t, kind);
    await f.listen();
    const initial = await f.success();
    const sse = await f.events();
    f.trace.length = 0;
    await f.append();
    const release = deferred();
    f.cleanup.push(() => release.resolve());
    let paused = false;
    f.handler = async (event) => {
      if (event.stage === "before-capture" && event.file === f.paths[kind] && !paused) {
        paused = true;
        await release.promise;
      }
    };
    const requests = [f.get()];
    await f.wait((e) => e.stage === "before-capture" && e.file === f.paths[kind], "first tab parsing");
    requests.push(f.get(), f.get());
    f.notify();
    f.notify();
    f.notify();
    const status = await f.get(`/api/status?since=${encodeURIComponent(initial.fingerprint)}`);
    assert.equal(status.status, 200);
    assert.notEqual(
      status.body.usageVersion,
      initial.usageVersion,
      "status cannot advertise the old completed version",
    );
    assert.equal(
      sse.events.some((event) => event.name === "usage-synced"),
      false,
    );
    release.resolve();
    const results = await Promise.all(requests);
    f.check();
    for (const result of results) assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(new Set(results.map((result) => result.body.usageVersion)).size, 1);
    assert.equal(new Set(results.map((result) => result.body.fingerprint)).size, 1);
    const synced = await sse.until("usage-synced");
    assert.equal(synced.data.usageVersion, results[0].body.usageVersion);
    assert.equal(f.trace.filter((e) => e.stage === "source-commit" && e.file === f.paths[kind]).length, 1);
    assert.equal(
      f.trace.filter((e) => e.stage === "round-start").length,
      1,
      "requests and duplicate hints reuse the flight",
    );
    await assertCanonical(f, results[0].body);
  });

  test(`6 ${kind}: truncation and equal-size old-byte rewrite require complete validation`, {
    timeout: 25_000,
  }, async (t) => {
    const f = await fixture(t, kind);
    const before = await readFile(f.paths[kind]);
    await f.append();
    await f.store.sync();
    await writeFile(f.paths[kind], before);
    f.rows[kind].pop();
    f.amounts[kind].pop();
    f.trace.length = 0;
    await f.store.sync();
    assert.ok(
      f.trace.some((e) => e.stage === "source-commit" && e.file === f.paths[kind] && e.method === "replaceFile"),
    );
    await assertCanonical(f);
    const original = await readFile(f.paths[kind]);
    let revised;
    if (kind === "codex") {
      revised = Buffer.from(original.toString().replace("gpt-5.1-codex", "gpt-5.2-codex"));
      f.rows[kind][1].payload.model = "gpt-5.2-codex";
    } else {
      // Find a valid same-length compressed frame, rather than corrupting zstd and testing its decoder.
      const row = f.rows[kind][2];
      for (let amount = 110; amount < 300 && !revised; amount++) {
        const next = structuredClone(row);
        next.data.usage.inputTokens = amount - 7;
        next.data.usage.totalTokens = amount;
        const candidate = [...f.rows[kind]];
        candidate[2] = next;
        const bytes = f.encode(kind, candidate);
        if (bytes.length === original.length) {
          revised = bytes;
          f.rows[kind][2] = next;
          f.amounts[kind][0] = amount;
        }
      }
    }
    assert.ok(revised);
    assert.equal(revised.length, original.length);
    assert.notDeepEqual(revised, original);
    await writeFile(f.paths[kind], revised);
    f.trace.length = 0;
    await f.store.sync();
    assert.ok(
      f.trace.some((e) => e.stage === "source-commit" && e.file === f.paths[kind] && e.method === "replaceFile"),
    );
    await assertCanonical(f);
    await f.listen();
    await assertCanonical(f, await f.success());
  });

  test(`7 ${kind}: kill the real child after the other source commits; reopen recovers once`, {
    timeout: 25_000,
  }, async (t) => {
    const f = await fixture(t, kind);
    await f.listen();
    await f.success();
    f.trace.length = 0;
    await f.append(other(kind), 31);
    await f.append();
    const hold = deferred();
    f.cleanup.push(() => hold.resolve());
    f.handler = async (event) => {
      if (event.stage === "before-capture" && event.file === f.paths[kind]) await hold.promise;
    };
    const request = f.get();
    const paused = await f.wait(
      (e) => e.stage === "before-capture" && e.file === f.paths[kind],
      "partial commit before executor kill",
    );
    assert.equal(paused.snapshot.transaction, true);
    const committed = f.trace.find((e) => e.stage === "source-commit" && e.file === f.paths[other(kind)]);
    assert.ok(committed);
    assert.equal(
      f.trace.some((e) => e.stage === "round-done"),
      false,
    );
    const child = [...f.children].find((entry) => entry.pid === paused.pid);
    child.kill("SIGKILL");
    await child.exited;
    assert.notEqual((await request).status, 200, "killed incomplete round is not a successful old response");
    f.handler = async () => {};
    await f.closeServer();
    const database = new DatabaseSync(f.options.databaseFile);
    try {
      assert.equal(database.prepare("PRAGMA quick_check").get().quick_check, "ok");
      assert.deepEqual(
        database
          .prepare("SELECT * FROM events WHERE source_path=? ORDER BY id")
          .all(f.paths[other(kind)])
          .map((row) => ({ ...row })),
        sourceRows(committed.snapshot, f.paths[other(kind)]),
      );
      assert.equal(
        database.prepare("SELECT count(*) n FROM events WHERE source_path=?").get(f.paths[kind]).n,
        HOT_ONLY ? 3 : 1,
      );
    } finally {
      database.close();
    }
    await f.listen();
    const payload = await f.success();
    await assertCanonical(f, payload);
    await f.closeServer();
    await f.listen();
    const reopened = await f.success();
    assert.deepEqual(reopened.summary.totals, payload.summary.totals);
    await assertCanonical(f, reopened);
  });

  test(`8 ${kind}: real SQLite write denial is not retryable success; closing a paused request releases the child`, {
    timeout: 30_000,
  }, async (t) => {
    const f = await fixture(t, kind);
    await f.append();
    f.trace.length = 0;
    let denied = false;
    f.handler = async (event, store) => {
      if (event.stage === "source-start" && event.file === f.paths[kind] && !denied) {
        denied = true;
        store.database.exec("PRAGMA query_only=ON");
      }
    };
    try {
      await assert.rejects(f.store.sync(), (error) => {
        assert.notEqual(error.code, "SOURCE_UPDATE_PENDING");
        assert.match(error.message, /readonly|read-only/i);
        return true;
      });
      f.check();
      assert.equal(f.trace.filter((e) => e.stage === "source-start" && e.file === f.paths[kind]).length, 1);
      assert.equal(f.store.database.isTransaction, false);
      const before = f.trace.find((event) => event.stage === "source-start" && event.file === f.paths[kind]);
      const failed = f.trace.find((event) => event.stage === "source-error" && event.file === f.paths[kind]);
      assert.ok(failed, "the real SQLite error must escape the source transaction");
      assertRollback(before.snapshot, failed.snapshot, f.paths[kind]);
    } finally {
      f.store.database.exec("PRAGMA query_only=OFF");
      f.handler = async () => {};
    }
    await f.store.sync();
    await assertCanonical(f);
    await f.listen();
    await f.success();
    f.trace.length = 0;
    await f.append();
    const hold = deferred();
    f.cleanup.push(() => hold.resolve());
    f.handler = async (event) => {
      if (event.stage === "before-capture" && event.file === f.paths[kind]) await hold.promise;
    };
    const abort = new AbortController();
    const request = f.get(QUERY, { signal: abort.signal }).catch((error) => error);
    const paused = await f.wait(
      (e) => e.stage === "before-capture" && e.file === f.paths[kind],
      "request waiting at capture",
    );
    const child = [...f.children].find((entry) => entry.pid === paused.pid);
    abort.abort();
    await request;
    await bounded(f.closeServer(), "service close while source attempt is paused", 12_000);
    await child.exited;
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    f.handler = async () => {};
    await f.listen();
    await assertCanonical(f, await f.success());
  });
}
