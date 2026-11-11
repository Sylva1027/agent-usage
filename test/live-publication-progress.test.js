import assert from "node:assert/strict";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  publicationFixture,
  captureGeneration,
  assertGeneration,
  assertCanonical,
  deferred,
  bounded,
  other,
  QUERY,
} from "../test-support/live-publication-fixture.mjs";

function gate(f) {
  const hold = deferred();
  f.cleanup.push(() => hold.resolve());
  return hold;
}

function success(f, response) {
  f.check();
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.ok(response.body.usageVersion, "completed responses carry a proved version");
  const read = f.trace.find(
    (event) =>
      event.stage === "query-result" &&
      event.ok &&
      JSON.stringify(event.result.summary) === JSON.stringify(response.body.summary),
  );
  assert.ok(read, "HTTP facts came from an actual executor query");
  assert.deepEqual(
    response.body.metadata,
    { ...read.result.metadata, imports: f.initial.metadata.imports },
    "HTTP metadata belongs to the same captured query as its facts",
  );
  assert.deepEqual(response.body.periodComparison, read.result.periodComparison);
  assert.deepEqual(response.body.pricingCatalog, read.result.pricingCatalog);
  return response.body;
}

async function start(t, kind) {
  const f = await publicationFixture(t, kind);
  await f.listen();
  f.initial = await f.success();
  f.trace.length = 0;
  return f;
}

async function continuous(t, kind, retry) {
  const f = await start(t, kind);
  const permits = Array.from({ length: 4 }, () => gate(f));
  permits[0].resolve();
  const reports = [];
  let injected = false;
  await f.append(kind, 37);
  f.handler = async (event) => {
    if (event.pid === process.pid) return;
    if (event.stage === "round-start" && reports.length < permits.length) await permits[reports.length].promise;
    if (retry && event.stage === "before-verify" && event.file === f.paths[kind] && !injected) {
      injected = true;
      await f.append(kind, 43);
    }
    if (event.stage === "round-done" && reports.length < 3) {
      assert.equal(event.snapshot.work.sourceRetries, retry && reports.length === 0 ? 1 : 0);
      reports.push(await captureGeneration(f));
      await f.append(kind, 47 + reports.length);
    }
  };
  const versions = new Set([f.initial.usageVersion]);
  for (let generation = 0; generation < 3; generation++) {
    permits[generation].resolve();
    const payload = success(f, await bounded(f.get(), `generation ${generation + 1} while its successor is paused`));
    assert.equal(reports.length, generation + 1, "only the admitted batch may be consumed before its response");
    assertGeneration(payload, reports[generation], `generation ${generation + 1}`);
    assert.equal(versions.has(payload.usageVersion), false, "each new batch advances the completed version");
    versions.add(payload.usageVersion);
  }
  const completed = f.trace.filter((event) => event.stage === "round-done").at(-1);
  await f.wait(
    (event) => event.stage === "round-start" && event.observedAt > completed.observedAt,
    "known successor resumes without another request, watcher hint or SSE client",
  );
  permits[3].resolve();
  await f.wait(
    (event) => event.stage === "round-done" && event !== completed && event.observedAt > completed.observedAt,
    "last successor commits",
  );
  f.handler = async () => {};
  await assertCanonical(f, await f.success());
}

for (const kind of ["codex", "dsh"]) {
  test(
    `1 ${kind}: post-commit append after SHA recovery publishes three admitted generations`,
    { timeout: 25_000 },
    (t) => continuous(t, kind, true),
  );

  test(
    `2 ${kind}: post-commit append without source retries publishes three admitted generations`,
    { timeout: 25_000 },
    (t) => continuous(t, kind, false),
  );

  test(`3 ${kind}: next round commits after the query snapshot without mixing facts, metadata, money or periods`, {
    timeout: 25_000,
  }, async (t) => {
    const f = await start(t, kind);
    const stream = await f.events();
    await f.append(kind, 37);
    const committed = await f.success();
    const completion = f.trace.findLast(
      (event) => event.stage === "executor-result" && event.request?.type === "sync" && event.ok,
    )?.result.completion;
    assert.ok(completion, "the committed generation owns an executor receipt");
    f.trace.length = 0;
    const reused = await f.success();
    assert.equal(reused.usageVersion, committed.usageVersion, "an unchanged check reuses the completed version");
    assert.equal(
      f.trace.some((event) => event.stage === "round-start"),
      false,
      "exercise unchanged-source reuse, rather than creating another completion token",
    );
    f.trace.length = 0;
    const before = await captureGeneration(f);
    const release = gate(f);
    let captured;
    f.handler = async (event) => {
      if (event.stage === "query-result" && !captured) {
        captured = event;
        await release.promise;
      }
    };
    const request = f.get();
    await f.wait((event) => event.stage === "query-result", "first query owns its result");
    assert.equal(
      f.trace.some((event) => event.stage === "round-start"),
      false,
      "the paused query also enters through unchanged-source reuse",
    );
    assert.equal(captured.result.completion, completion, "reuse retains the original executor completion token");
    assert.equal(
      f.trace.find((event) => event.stage === "before-get")?.args[1].completion,
      completion,
      "the gateway retains the token needed to identify the captured query",
    );
    assert.equal(captured.result.summary.eventCount, before.events.length);
    const readSource = await f.cache.readSourceState(f.options);
    await f.append(kind, 43);
    const pendingSource = await f.cache.readSourceState(f.options);
    assert.notEqual(pendingSource.fingerprint, readSource.fingerprint, "raw-source freshness has advanced");
    assert.equal(pendingSource.auxiliary, readSource.auxiliary, "ordinary append changes no auxiliary dependency");
    assert.equal(
      pendingSource.publication.signature,
      readSource.publication.signature,
      "raw append alone does not invalidate the database read receipt",
    );
    const after = await captureGeneration(f);
    f.notify();
    await f.wait(
      (event) => event.stage === "round-done" && event.observedAt > captured.observedAt,
      "next commit while the previous response is paused",
    );
    release.resolve();
    const payload = success(f, await request);
    assertGeneration(payload, before, "reused generation survives the next commit");
    assert.equal(payload.usageVersion, reused.usageVersion, "a completed read keeps its original publication identity");
    assert.equal(
      f.trace.filter((event) => event.stage === "query-result").length,
      1,
      "the completed query is returned without chasing the next generation",
    );
    const latest = await f.success();
    assertGeneration(latest, after, "subsequent checked request");
    assert.notEqual(
      (await f.cache.readSourceState(f.options)).publication.signature,
      readSource.publication.signature,
      "the next database commit has its own publication identity",
    );
    assert.notEqual(
      payload.usageVersion,
      latest.usageVersion,
      "an older consistent read cannot be relabeled with the later commit",
    );
    for (const event of f.trace.filter((entry) => entry.stage === "before-publish")) {
      const [, result, , source] = event.args;
      assert.equal(result.status.fingerprint, source.fingerprint, "cache entries use their actual fact version");
    }
    assert.equal(
      f.cache.database.prepare("SELECT count(*) n FROM summaries").get().n,
      0,
      "cold carriers retain the existing prohibition on reusable response-cache entries",
    );
    await stream.close();
    await assertCanonical(f, latest);
  });

  test(`${kind}: unrelated Codex diagnostics after collection do not block publication`, {
    timeout: 25_000,
  }, async (t) => {
    const f = await publicationFixture(t, kind);
    const database = new DatabaseSync(path.join(f.root, ".codex", "logs_2.sqlite"));
    f.cleanup.push(() => database.close());
    database.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE logs(id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER,
        target TEXT, feedback_log_body TEXT, thread_id TEXT)`);
    const insert = database.prepare(
      "INSERT INTO logs(ts,ts_nanos,target,feedback_log_body,thread_id) VALUES(?,?,?,?,?)",
    );
    insert.run(1793491200, 0, "unrelated", "diagnostic", "recovery-codex");
    await f.listen();
    f.initial = await f.success();
    f.trace.length = 0;
    await f.append(kind, 37);
    const expected = await captureGeneration(f);
    let writes = 0;
    f.handler = async (event) => {
      if (event.stage === "round-done") {
        insert.run(1793491201 + writes++, 0, "unrelated", "diagnostic", "recovery-codex");
      }
    };
    assertGeneration(success(f, await bounded(f.get(), "publication while diagnostics continue")), expected);
    assert.equal(writes, 1, "irrelevant logs do not cause repeated collection");
  });

  test(`4 ${kind}: three tabs and duplicate wakes share bounded sync while a slow response cannot block collection`, {
    timeout: 25_000,
  }, async (t) => {
    const f = await start(t, kind);
    const stream = await f.events();
    const syncing = gate(f),
      slow = gate(f);
    let firstRound = true,
      captured;
    await f.append(kind, 37);
    const first = await captureGeneration(f);
    f.handler = async (event) => {
      if (event.stage === "round-start" && firstRound) {
        firstRound = false;
        await syncing.promise;
      }
      if (event.stage === "query-result" && !captured) {
        captured = event;
        await slow.promise;
      }
    };
    const requests = [f.get(), f.get(), f.get("/api/summary?preset=all&bucket=day&calendarZone=utc")];
    await f.wait((event) => event.stage === "round-start", "three tabs join the same synchronization");
    for (let hint = 0; hint < 16; hint++) f.notify();
    syncing.resolve();
    await f.wait((event) => event.stage === "query-result", "one slow tab holds its own response");
    const completed = [];
    const progress = deferred();
    for (const request of requests)
      request.then((result) => {
        completed.push(result);
        if (completed.length === 2) progress.resolve();
      });
    await bounded(progress.promise, "both responsive tabs progress independently");
    for (const result of completed) assertGeneration(success(f, result), first);
    await f.append(kind, 43);
    const second = await captureGeneration(f);
    for (let hint = 0; hint < 16; hint++) f.notify();
    await f.wait(
      (event) => event.stage === "round-done" && event.observedAt > captured.observedAt,
      "collection continues while the first tab is slow",
    );
    slow.resolve();
    for (const result of await Promise.all(requests)) {
      const payload = success(f, result);
      assertGeneration(payload, payload.summary.eventCount === first.events.length ? first : second);
    }
    const latest = await f.success();
    assertGeneration(latest, second);
    assert.equal(f.trace.filter((event) => event.stage === "source-commit" && event.file === f.paths[kind]).length, 2);
    assert.ok(
      f.trace.filter((event) => event.stage === "round-start").length <= 2,
      "duplicate wakes merge into one successor, rather than unbounded rounds",
    );
    let active = 0;
    for (const event of f.trace) {
      if (event.stage === "round-start") assert.equal(++active, 1, "at most one round executes");
      if (["round-done", "round-error"].includes(event.stage)) active--;
    }
    const synced = await stream.until("usage-synced", (event) => event.data.usageVersion === latest.usageVersion);
    assert.ok(synced.data.usageVersion);
    const status = await f.get(`/api/status?since=${encodeURIComponent(latest.fingerprint)}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.changed, false);
    assert.equal(status.body.usageVersion, latest.usageVersion, "quiet HTTP, SSE and status agree on completion");
    await stream.close();
    await assertCanonical(f, latest);
  });

  test(`5 ${kind}: configuration, evidence, prices and exchange rates retain independent invalidation and snapshot rules`, {
    timeout: 30_000,
  }, async (t) => {
    const f = await start(t, kind);
    for (const [dependency, retry] of [
      ["configuration", true],
      ["evidence", true],
      ["configuration", false],
      ["evidence", false],
    ]) {
      f.trace.length = 0;
      await f.append(kind, 31);
      let retried = false,
        changed = false;
      f.handler = async (event) => {
        if (retry && event.stage === "before-verify" && event.file === f.paths[kind] && !retried) {
          retried = true;
          await f.append(kind, 17);
        }
        if (event.stage === "round-done" && !changed) {
          changed = true;
          assert.equal(event.snapshot.work.sourceRetries, Number(retry), `${dependency}: intended retry branch`);
          if (dependency === "configuration")
            await writeFile(
              path.join(f.root, ".codex", "config.toml"),
              `model = "${retry ? "gpt-5.2-codex" : "gpt-5.1-codex"}"\n`,
            );
          else {
            const db = new DatabaseSync(path.join(f.root, ".codex", "logs_2.sqlite"));
            try {
              db.exec(`CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY, ts INTEGER, ts_nanos INTEGER,
                  target TEXT, feedback_log_body TEXT, thread_id TEXT)`);
              db.prepare("INSERT INTO logs(ts,ts_nanos,target,feedback_log_body,thread_id) VALUES(?,?,?,?,?)").run(
                retry ? 1793491200 : 1793491201,
                0,
                "feedback_tags",
                retry ? "turn auth_mode=Some(Chatgpt)" : "turn auth_mode=Some(ApiKey)",
                "recovery-codex",
              );
            } finally {
              db.close();
            }
          }
        }
      };
      const pending = await f.get();
      f.check();
      assert.equal(changed, true);
      assert.equal(retried, retry);
      assert.equal(
        pending.status,
        409,
        `${dependency} changed after the completed boundary; sourceRetries=${Number(retry)}`,
      );
      assert.equal(pending.body.code, "SOURCE_UPDATE_PENDING");
      assert.equal("summary" in pending.body, false);
      const rejected = f.trace.find((event) => event.stage === "round-done");
      await f.wait(
        (event) => event.stage === "round-done" && event !== rejected,
        `${dependency} resumes without a hint`,
      );
      f.handler = async () => {};
      await assertCanonical(f, await f.success());
    }
    for (const dependency of ["prices", "exchange-rate"]) {
      f.trace.length = 0;
      const report = await captureGeneration(f);
      const release = gate(f);
      let captured;
      f.handler = async (event) => {
        if (event.stage === "query-result" && !captured) {
          captured = event;
          await release.promise;
        }
      };
      const request = f.get();
      await f.wait((event) => event.stage === "query-result", `${dependency} query captures its prices`);
      const oldCatalog = structuredClone(captured.result.pricingCatalog);
      const catalog = structuredClone(oldCatalog);
      if (dependency === "prices") catalog.models["deepseek-flash"].short.input *= 3;
      else catalog.usdToCnyRate += 1;
      const updated = await f.get("/api/pricing", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(catalog),
      });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      release.resolve();
      const payload = success(f, await request);
      assert.deepEqual(payload.pricingCatalog, oldCatalog, "a completed read retains its captured catalog");
      assertGeneration(payload, report, dependency);
      f.handler = async () => {};
      const latest = await f.success();
      assertGeneration(latest, report, `new ${dependency}`);
      assert.notDeepEqual(
        latest.summary.costEstimate,
        payload.summary.costEstimate,
        "the new financial context is real",
      );
      assert.notEqual(latest.usageVersion, payload.usageVersion);
    }
  });

  test(`6 ${kind}: truncation and equal-size old-byte rewrite invalidate source freshness after a completed read`, {
    timeout: 25_000,
  }, async (t) => {
    const f = await start(t, kind);
    for (const mutation of ["truncate", "rewrite"]) {
      const original = await readFile(f.paths[kind]);
      await f.append(kind, 37);
      const admitted = await captureGeneration(f);
      const release = gate(f);
      let captured;
      f.trace.length = 0;
      f.handler = async (event) => {
        if (event.stage === "query-result" && !captured) {
          captured = event;
          await release.promise;
        }
      };
      const request = f.get();
      await f.wait((event) => event.stage === "query-result", `${mutation} occurs after the read snapshot`);
      if (mutation === "truncate") {
        await writeFile(f.paths[kind], original);
        f.rows[kind].pop();
        f.amounts[kind].pop();
      } else {
        const previous = await readFile(f.paths[kind]);
        let revised;
        if (kind === "codex") {
          revised = Buffer.from(previous.toString().replace("gpt-5.1-codex", "gpt-5.2-codex"));
          f.rows[kind][1].payload.model = "gpt-5.2-codex";
        } else {
          for (let amount = 110; amount < 300 && !revised; amount++) {
            const rows = structuredClone(f.rows[kind]);
            rows[2].data.usage.inputTokens = amount - 7;
            rows[2].data.usage.totalTokens = amount;
            const bytes = f.encode(kind, rows);
            if (bytes.length === previous.length) {
              revised = bytes;
              f.rows[kind][2] = rows[2];
              f.amounts[kind][0] = amount;
            }
          }
        }
        assert.ok(revised, "valid same-length source encoding exists");
        assert.equal(revised.length, previous.length);
        assert.notDeepEqual(revised, previous);
        await writeFile(f.paths[kind], revised);
      }
      release.resolve();
      const completed = success(f, await request);
      assertGeneration(completed, admitted, `${mutation}: captured DB receipt remains coherent`);
      assert.equal(completed.updatePending, true, "the post-query check retains the known later raw change");
      f.handler = async () => {};
      await f.wait(
        (event) => event.stage === "round-done" && event.observedAt > captured.observedAt,
        `${mutation}: the post-query raw change drains without a request, SSE client or watcher hint`,
      );
      assert.ok(
        f.trace.some(
          (event) =>
            event.stage === "source-commit" &&
            event.file === f.paths[kind] &&
            event.method === "replaceFile" &&
            event.observedAt > captured.observedAt,
        ),
        "automatic continuation validates old bytes and reparses the changed source",
      );
      await assertCanonical(f, await f.success());
    }
  });

  test(`7 ${kind}: external commit, database replacement and executor crash cannot resurrect completion credentials`, {
    timeout: 30_000,
  }, async (t) => {
    const f = await start(t, kind);
    for (const injection of ["executor-result", "round-done"]) {
      f.trace.length = 0;
      await f.append(kind, 37);
      let changed = false;
      f.handler = async (event) => {
        const syncBoundary =
          injection === "round-done"
            ? event.stage === "round-done" && event.pid !== process.pid
            : event.stage === "executor-result" && event.request?.type === "sync" && event.ok;
        if (syncBoundary && !changed) {
          changed = event;
          const db = new DatabaseSync(f.options.databaseFile);
          try {
            const progress = db.prepare("SELECT * FROM usage_source_progress WHERE source_path=?");
            assert.ok(progress.get(f.paths[kind]), "the committed source starts with a durable checkpoint");
            assert.ok(
              db.prepare("UPDATE events SET project=project WHERE source_path=?").run(f.paths[kind]).changes > 0,
            );
            assert.equal(progress.get(f.paths[kind]), undefined, "the external event write invalidates its checkpoint");
          } finally {
            db.close();
          }
        }
      };
      const foreign = await f.get();
      f.check();
      assert.ok(changed);
      f.handler = async () => {};
      if (injection === "round-done") {
        const sync = f.trace.find(
          (event) => event.stage === "executor-result" && event.request?.type === "sync" && event.ok,
        );
        assert.ok(sync, "the interrupted completion boundary still returns its sync result");
        assert.equal(sync.result.completion, null, "an external commit inside sync prevents receipt issuance");
        assert.equal(foreign.status, 409, "a successful sync without a receipt cannot use the old publication");
        assert.equal(foreign.body.summary, undefined);
      } else {
        assert.ok(changed.result.completion, "this branch invalidates an already issued completion receipt");
      }
      if (foreign.status === 200) {
        assert.ok(
          f.trace.some((event) => event.stage === "round-done" && event.observedAt > changed.observedAt),
          "foreign commit requires a new completion boundary before successful retry",
        );
      } else {
        assert.equal(foreign.status, 409);
        assert.equal(foreign.body.code, "SOURCE_UPDATE_PENDING");
        await f.wait(
          (event) => event.stage === "round-done" && event.observedAt > changed.observedAt,
          "foreign-commit recovery",
        );
      }
      const recovery = f.trace.find((event) => event.stage === "round-done" && event.observedAt > changed.observedAt);
      assert.equal(
        recovery.snapshot.progress.some((row) => row.source_path === f.paths[kind]),
        false,
        "unchanged raw input leaves the invalid checkpoint absent",
      );
      assert.equal(
        f.trace.some(
          (event) =>
            event.stage === "source-commit" && event.file === f.paths[kind] && event.observedAt > changed.observedAt,
        ),
        false,
        "the no-op recovery cannot reuse the invalid checkpoint to ingest source data",
      );
      assertGeneration(success(f, await f.get()), await captureGeneration(f), "external-write recovery");
      const beforeAppend = f.trace.length;
      await f.append(kind, 41);
      const rebuilt = success(f, await f.get());
      const continuation = f.trace.slice(beforeAppend).filter((event) => event.file === f.paths[kind]);
      assert.ok(
        continuation.some((event) => event.stage === "source-commit" && event.method === "replaceFile"),
        "the next raw append uses a complete parse after checkpoint invalidation",
      );
      assert.equal(
        continuation.some((event) => event.stage === "source-commit" && event.method === "appendFile"),
        false,
        "the invalidated checkpoint is never reused for incremental parsing",
      );
      await assertCanonical(f, rebuilt);
    }
    await bounded(Promise.all([...f.children].map((child) => child.exited)), "normal idle executor retirement");
    f.cache.source?.close();
    f.cache.source = null;
    const replacement = path.join(f.root, "replacement.sqlite");
    const db = new DatabaseSync(f.options.databaseFile);
    try {
      db.exec(`VACUUM INTO '${replacement.replaceAll("'", "''")}'`);
    } finally {
      db.close();
    }
    await rename(f.options.databaseFile, path.join(f.root, "previous.sqlite"));
    await rename(replacement, f.options.databaseFile);
    f.trace.length = 0;
    await assertCanonical(f, await f.success());
    assert.ok(
      f.trace.some((event) => event.stage === "round-done"),
      "replacement obtains a new completion boundary",
    );
    const stream = await f.events();
    stream.events.length = 0;
    f.trace.length = 0;
    await f.append(other(kind), 31);
    await f.append(kind, 43);
    const partial = gate(f);
    f.handler = async (event) => {
      if (event.stage === "before-capture" && event.file === f.paths[kind]) await partial.promise;
    };
    const request = f.get();
    const paused = await f.wait(
      (event) => event.stage === "before-capture" && event.file === f.paths[kind],
      "second source is uncommitted before crash",
    );
    assert.ok(f.trace.some((event) => event.stage === "source-commit" && event.file === f.paths[other(kind)]));
    assert.equal(
      f.trace.some((event) => event.stage === "round-done"),
      false,
    );
    assert.equal(
      stream.events.some((event) => event.name === "usage-synced"),
      false,
    );
    const child = [...f.children].find((entry) => entry.pid === paused.pid);
    child.kill("SIGKILL");
    await child.exited;
    assert.notEqual((await request).status, 200, "a partial round cannot advertise successful stale data");
    partial.resolve();
    f.handler = async () => {};
    await stream.close();
    await f.closeServer();
    await f.listen();
    await assertCanonical(f, await f.success());
  });

  test(`8 ${kind}: pending work resumes without hints; scope cancellation and close release readers and children`, {
    timeout: 30_000,
  }, async (t) => {
    const f = await start(t, kind);
    await f.append(kind, 37);
    const admitted = await captureGeneration(f);
    let appended = false;
    f.handler = async (event) => {
      if (event.stage === "round-done" && !appended) {
        appended = true;
        await f.append(kind, 43);
      }
    };
    assertGeneration(success(f, await f.get()), admitted);
    const first = f.trace.find((event) => event.stage === "round-done");
    await f.wait(
      (event) => event.stage === "round-done" && event !== first,
      "known pending input drains without SSE, manual refresh, or another hint",
    );
    f.handler = async () => {};
    await assertCanonical(f, await f.success());
    f.trace.length = 0;
    const slow = gate(f);
    let captured;
    f.handler = async (event) => {
      if (event.stage === "query-result" && !captured) {
        captured = event;
        await slow.promise;
      }
    };
    const abort = new AbortController();
    const stale = f.get(QUERY, { signal: abort.signal }).catch((error) => error);
    await f.wait((event) => event.stage === "query-result", "old scope captures its response");
    abort.abort();
    assert.equal((await stale).name, "AbortError");
    await f.append(kind, 47);
    const report = await captureGeneration(f);
    const changed = success(
      f,
      await bounded(
        f.get(QUERY.replace("preset=all", "preset=week")),
        "new scope progresses after cancelling the previous reader",
      ),
    );
    assertGeneration(changed, report, "new scope", { preset: "week" });
    slow.resolve();
    f.handler = async () => {};
    await assertCanonical(f, await f.success());
    f.trace.length = 0;
    await f.append(kind, 53);
    const closing = gate(f);
    f.handler = async (event) => {
      if (event.stage === "before-capture" && event.file === f.paths[kind]) await closing.promise;
    };
    const cancelled = new AbortController();
    const request = f.get(QUERY, { signal: cancelled.signal }).catch((error) => error);
    await f.wait(
      (event) => event.stage === "before-capture" && event.file === f.paths[kind],
      "close interrupts pending input",
    );
    cancelled.abort();
    await request;
    await bounded(f.closeServer(), "close releases blocked readers and the executor", 12_000);
    assert.equal(f.watchers.size, 0);
    for (const child of f.children) assert.ok(child.exitCode !== null || child.signalCode !== null);
    closing.resolve();
    f.handler = async () => {};
    await f.listen();
    await assertCanonical(f, await f.success());
  });
}
