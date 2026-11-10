import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { estimateEventCost } from "../src/pricing.js";
import { loadPricingFile } from "../src/pricing-store.js";
import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";
import { clean } from "../test-support/history-compaction-fixture.mjs";
import { installRecoveryHooks } from "../test-support/live-source-recovery-hook.mjs";

const DAY = 86_400_000;
const START = Date.parse("2026-11-01T00:00:00Z");
const FILTERS = { preset: "all", calendarZone: "utc", bucket: "day", now: new Date(START + 9 * DAY) };
const QUERY = "/api/usage?preset=all&view=dashboard&bucket=day&calendarZone=utc";
const HOOK = new URL("../test-support/live-source-recovery-hook.mjs", import.meta.url).href;
const HOT_ONLY = process.env.LIVE_SOURCE_RECOVERY_HOT_ONLY === "1";
const other = (kind) => (kind === "codex" ? "dsh" : "codex");
const deferred = () => Promise.withResolvers();

async function bounded(promise, label, ms = 8_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function record(kind, index, amount, cumulative) {
  const time = START + Math.min(index - 1, 2) * DAY + index * 1000 + (kind === "dsh" ? 100 : 0);
  if (kind === "dsh")
    return {
      type: "assistant/message",
      seq: index,
      time,
      data: {
        turn: 1,
        step: index,
        usage: {
          inputTokens: amount - 7,
          cacheReadTokens: 2,
          cacheWriteTokens: 0,
          outputTokens: 5,
          totalTokens: amount,
        },
      },
    };
  const usage = (total, count) => ({
    total_tokens: total,
    input_tokens: total - 5 * count,
    cached_input_tokens: 2 * count,
    output_tokens: 5 * count,
    reasoning_output_tokens: 0,
  });
  return {
    type: "event_msg",
    timestamp: new Date(time).toISOString(),
    payload: {
      type: "token_count",
      info: { total_token_usage: usage(cumulative, index), last_token_usage: usage(amount, 1) },
    },
  };
}

// Same real Codex/concatenated-zstd input and two-package layout as history-source-append.test.js.
// Its private fixture cannot be imported without registering its tests; only six initial events are needed here.
async function fixture(t, target) {
  const root = await mkdtemp(path.join(tmpdir(), "live-source-recovery-"));
  const options = {
    homeDir: root,
    env: {},
    importDirs: [],
    databaseFile: path.join(root, "usage.sqlite"),
    importStoreFile: path.join(root, "imports.json"),
    pricingFile: path.join(root, "prices.json"),
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
  };
  const paths = {
    codex: path.join(root, ".codex", "sessions", "recovery.jsonl"),
    dsh: path.join(root, ".dsh", "sessions", "fixture", "recovery", "session.v4.jsonl.zstd"),
  };
  const rows = {};
  const amounts = { codex: [101, 70, 51], dsh: [101, 70, 51] };
  const encode = (kind, entries) =>
    kind === "dsh"
      ? Buffer.concat(entries.map((row) => zstdCompressSync(Buffer.from(`${JSON.stringify(row)}\n`))))
      : Buffer.from(entries.map((row) => `${JSON.stringify(row)}\n`).join(""));
  const stores = new Set();
  const children = new Set();
  const sockets = new Set();
  const trace = [];
  const changes = new EventEmitter();
  const cleanup = [];
  let server;
  let control;
  let handler = async () => {};
  let hookError;
  const point = async (event, store) => {
    event.observedAt = performance.now();
    trace.push(event);
    changes.emit("point", event);
    try {
      return await handler(event, store);
    } catch (error) {
      hookError ||= error;
    }
  };
  const restore = installRecoveryHooks(point, paths[other(target)]);
  const openStore = (databaseFile = options.databaseFile) => {
    const store = new UsageStore({ ...options, databaseFile });
    stores.add(store);
    return store;
  };
  t.after(async () => {
    handler = async () => {};
    for (const release of cleanup.reverse()) await release();
    let closeFailure;
    try {
      await bounded(server?.close(), "fixture server close", 12_000);
    } catch (error) {
      closeFailure = error;
    }
    const unreleased = [...children].filter((child) => child.exitCode === null && child.signalCode === null);
    // Reap a failed test as well, but never count forced cleanup as a successful close.
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all([...children].map((child) => child.exited));
    for (const socket of sockets) socket.destroy();
    if (control) await new Promise((resolve) => control.close(resolve));
    for (const store of stores) store.close();
    restore();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("live-source-recovery-"));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    assert.equal(fs.existsSync(root), false, "fixture, WAL, archives and projection readers are released");
    if (closeFailure) throw closeFailure;
    assert.equal(unreleased.length, 0, "server.close must release its children before fixture cleanup");
  });
  for (const kind of ["codex", "dsh"]) {
    rows[kind] =
      kind === "codex"
        ? [
            {
              type: "session_meta",
              payload: { id: "recovery-codex", source: "cli", originator: "codex-tui", cwd: root },
            },
            { type: "turn_context", payload: { model: "gpt-5.1-codex" } },
          ]
        : [
            { type: "session", version: 4, id: "recovery-dsh", cwd: root, createdAt: START, delegationDepth: 0 },
            { type: "request/header", time: START, data: { header: { config: { model: "deepseek-flash" } } } },
          ];
    let cumulative = 0;
    for (const [i, amount] of amounts[kind].entries()) {
      cumulative += amount;
      rows[kind].push(record(kind, i + 1, amount, cumulative));
    }
    await mkdir(path.dirname(paths[kind]), { recursive: true });
    await writeFile(paths[kind], encode(kind, rows[kind]));
  }
  const store = openStore();
  await loadPricingFile(options);
  await store.sync();
  if (!HOT_ONLY) {
    // Reuse history-projection-recovery's exclusive-copy fixture setup on sandboxed Windows.
    const fsPromises = process.getBuiltinModule("fs/promises");
    const link = fsPromises.link;
    fsPromises.link = (source, destination) => copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    syncBuiltinESMExports();
    try {
      const candidates = [];
      for (let day = 0; day < 2; day++) {
        const file = path.join(root, `cold-${day}.sqlite`);
        await createHistoryArchiveCandidate(store.database, file, {
          startMs: START + day * DAY,
          endMs: START + (day + 1) * DAY,
        });
        candidates.push(file);
      }
      for (const candidate of candidates)
        await store.commitHistoryArchiveEvents(await prepareHistoryArchiveCommit(store.database, candidate));
    } finally {
      fsPromises.link = link;
      syncBuiltinESMExports();
    }
    for (const kind of ["codex", "dsh"]) {
      const note = kind === "dsh" ? rows[kind][1] : { type: "note", text: "refresh cold cursor" };
      rows[kind].push(note);
      await appendFile(paths[kind], encode(kind, [note]));
    }
    await store.sync();
    assert.equal(store.database.prepare("SELECT count(*) n FROM archive_segments").get().n, 2);
    assert.equal(store.database.prepare("SELECT count(*) n FROM events").get().n, 2);
  }
  const initial = await store.dashboardHistory(FILTERS, { includeDetails: false });
  assert.equal(initial.summary.eventCount, 6);
  assert.equal(initial.summary.totals.total, 444);
  trace.length = 0;
  const f = {
    root,
    options,
    paths,
    rows,
    amounts,
    encode,
    trace,
    store,
    children,
    cleanup,
    openStore,
    set handler(value) {
      handler = value;
    },
    check() {
      if (hookError) throw hookError;
    },
    wait(predicate, label) {
      const seen = trace.find(predicate);
      if (seen) return Promise.resolve(seen);
      let listener;
      return bounded(
        new Promise((resolve) => {
          listener = (event) => {
            if (predicate(event)) {
              changes.off("point", listener);
              resolve(event);
            }
          };
          changes.on("point", listener);
        }),
        label,
      ).finally(() => changes.off("point", listener));
    },
    async append(kind = target, amount = 37) {
      amounts[kind].push(amount);
      const entry = record(
        kind,
        amounts[kind].length,
        amount,
        amounts[kind].reduce((a, b) => a + b, 0),
      );
      rows[kind].push(entry);
      const bytes = encode(kind, [entry]);
      await appendFile(paths[kind], bytes);
      return bytes;
    },
    async listen() {
      store.close();
      if (!control) {
        control = createServer((socket) => {
          sockets.add(socket);
          socket.on("error", (error) => {
            if (error.code !== "ECONNRESET") hookError ||= error;
          });
          socket.once("close", () => sockets.delete(socket));
          socket.setEncoding("utf8");
          let buffer = "";
          socket.on("data", (chunk) => {
            buffer += chunk;
            while (buffer.includes("\n")) {
              const end = buffer.indexOf("\n");
              const event = JSON.parse(buffer.slice(0, end));
              buffer = buffer.slice(end + 1);
              void point(event).then((action) => {
                if (!socket.destroyed) socket.write(`${JSON.stringify({ id: event.id, action })}\n`);
              });
            }
          });
        });
        await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
        const fork = childProcess.fork;
        t.mock.method(childProcess, "fork", (file, args, config) => {
          const child = fork(file, args, {
            ...config,
            stdio: ["ignore", "ignore", "pipe", "ipc"],
            execArgv: [...config.execArgv, "--import", HOOK],
            env: {
              ...config.env,
              LIVE_RECOVERY_CONTROL_PORT: String(control.address().port),
              LIVE_RECOVERY_FIRST_PATH: paths[other(target)],
            },
          });
          child.stderr.setEncoding("utf8");
          child.stderr.on("data", (text) => {
            child.diagnostics = (child.diagnostics || "") + text;
          });
          child.exited = once(child, "exit");
          children.add(child);
          return child;
        });
        // Deliver hints explicitly; file contents, debounce, server and child execution stay real.
        const watchers = new Set();
        t.mock.method(fs, "watch", (directory, _options, callback) => {
          const watcher = new EventEmitter();
          watcher.close = () => watchers.delete(watcher);
          watcher.unref = () => {};
          watcher.directory = directory;
          watcher.callback = callback;
          watchers.add(watcher);
          return watcher;
        });
        f.notify = (file = paths[target]) => {
          for (const watcher of watchers) {
            const relative = path.relative(watcher.directory, file);
            if (relative && !relative.startsWith("..") && !path.isAbsolute(relative))
              watcher.callback("change", relative);
          }
        };
        syncBuiltinESMExports();
      }
      server = createUsageServer(options);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      f.base = `http://127.0.0.1:${server.address().port}`;
      return server;
    },
    async closeServer() {
      await server?.close();
      server = null;
    },
    async get(url = QUERY, init = {}) {
      const response = await fetch(f.base + url, { signal: AbortSignal.timeout(10_000), ...init });
      return { status: response.status, body: await response.json() };
    },
    async success() {
      const result = await f.get();
      f.check();
      assert.equal(
        result.status,
        200,
        JSON.stringify(result.body) + [...children].map((child) => child.diagnostics || "").join(""),
      );
      return result.body;
    },
    async events() {
      const abort = new AbortController();
      const response = await fetch(`${f.base}/api/usage-events`, { signal: abort.signal });
      assert.equal(response.status, 200);
      const reader = response.body.getReader();
      const events = [];
      const received = new EventEmitter();
      const decoder = new TextDecoder();
      let buffer = "";
      const pump = (async () => {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          while (buffer.includes("\n\n")) {
            const end = buffer.indexOf("\n\n");
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const name = /^event: (.+)$/m.exec(block)?.[1];
            if (!name) continue;
            const event = { name, data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] || "{}") };
            events.push(event);
            received.emit("event", event);
          }
        }
      })().catch((error) => {
        if (!abort.signal.aborted) throw error;
      });
      cleanup.push(async () => {
        abort.abort();
        await reader.cancel().catch(() => {});
        await pump;
      });
      const until = async (name) => {
        const existing = events.find((event) => event.name === name);
        if (existing) return existing;
        let listener;
        return bounded(
          new Promise((resolve) => {
            listener = (event) => {
              if (event.name === name) resolve(event);
            };
            received.on("event", listener);
          }),
          `SSE ${name}`,
        ).finally(() => received.off("event", listener));
      };
      await until("ready");
      return { events, until };
    },
  };
  return f;
}

const sourceRows = (snapshot, file, table = "events") => snapshot[table].filter((row) => row.source_path === file);

function assertRollback(before, after, file) {
  assert.equal(after.transaction, false, "the failed attempt is outside its transaction before retry");
  assert.equal(after.depth, 0);
  for (const table of ["events", "progress", "quotas", "rates"])
    assert.deepEqual(
      sourceRows(after, file, table),
      sourceRows(before, file, table),
      `${table}: failed source leaves no facts/cursor/derived residue`,
    );
  assert.equal(after.fingerprint, before.fingerprint, "a failed attempt cannot publish a complete fingerprint");
}

async function assertCanonical(f, payload = null) {
  f.check();
  const actual = f.openStore();
  const oracle = f.openStore(path.join(f.root, "oracle.sqlite"));
  f.handler = async () => {};
  try {
    await actual.open();
    await oracle.sync();
    const expectedEvents = oracle.publishedUsageEvents();
    const events = await actual.publishedHistoryUsageEvents();
    assert.deepEqual(events, expectedEvents, "ordered facts, sessions and token detail match a new complete parse");
    assert.equal(events.length, f.amounts.codex.length + f.amounts.dsh.length);
    assert.equal(
      new Set(events.map((event) => JSON.stringify([event.sessionId, event.timestamp]))).size,
      events.length,
      "no duplicate logical event",
    );
    assert.deepEqual(
      events.map((event) => estimateEventCost(event)),
      expectedEvents.map((event) => estimateEventCost(event)),
      "per-event money retains full-parse accumulation order",
    );
    const canonical = await oracle.dashboardHistory(FILTERS, { includeDetails: false });
    const mixed = await actual.dashboardHistory(FILTERS, { includeDetails: false });
    assert.equal(
      canonical.summary.totals.total,
      [...f.amounts.codex, ...f.amounts.dsh].reduce((sum, value) => sum + value, 0),
    );
    for (const key of ["totals", "eventCount", "sessionCount", "costEstimate", "timeline"])
      assert.deepEqual(clean(mixed.summary[key]), clean(canonical.summary[key]), `cold/hot ${key}`);
    if (payload) {
      for (const key of ["totals", "eventCount", "sessionCount", "costEstimate", "timeline"])
        assert.deepEqual(clean(payload.summary[key]), clean(canonical.summary[key]), `HTTP ${key}`);
      assert.ok(payload.fingerprint);
      assert.ok(payload.usageVersion);
    }
    for (const kind of ["codex", "dsh"]) {
      const saved = actual.database
        .prepare("SELECT * FROM usage_source_progress WHERE source_path=?")
        .get(f.paths[kind]);
      assert.ok(saved, `${kind} durable parser checkpoint`);
      assert.equal(JSON.parse(saved.checkpoint_json).offset, (await stat(f.paths[kind])).size);
      assert.equal(
        JSON.parse(saved.validation_json).kind,
        "sha256-prefix-v2",
        "these business cases force SHA, native is a separate regression",
      );
    }
    for (const table of ["quota_usage_sources", "rate_limit_observations"])
      assert.deepEqual(
        actual.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        oracle.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
    assert.equal(actual.database.isTransaction, false);
    assert.equal(actual.database.prepare("PRAGMA quick_check").get().quick_check, "ok");
  } finally {
    actual.close();
    oracle.close();
  }
}

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
