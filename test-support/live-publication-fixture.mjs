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
import { zstdCompressSync } from "node:zlib";
import { createHistoryArchiveCandidate, prepareHistoryArchiveCommit } from "../src/history-archive.js";
import { estimateEventCost, runWithPricingCatalog } from "../src/pricing.js";
import { loadPricingFile } from "../src/pricing-store.js";
import { createUsageServer } from "../src/server.js";
import { UsageStore } from "../src/usage-store.js";
import { buildUsageReport, summarizeUsage, summarizePeriodComparison } from "../src/usage-core.js";
import { UsageSummaryCache } from "../src/usage-summary-cache.js";
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
async function fixture(t, target, { hotOnly = HOT_ONLY, publication = false } = {}) {
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
    if (publication) {
      const directory = path.resolve("output/committed-publication-20261110");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `${t.name.replace(/[^a-zA-Z0-9]+/g, "-")}.json`),
        JSON.stringify({ trace, children: [...children].map((child) => ({ pid: child.pid,
          exitCode: child.exitCode, signalCode: child.signalCode, diagnostics: child.diagnostics })) }, null, 2));
    }
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
  if (!hotOnly) {
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
          child.once("exit", (code, signal) => { void point({ stage: "child-exit", pid: child.pid, code, signal }); });
          children.add(child);
          if (publication) {
            const requests = new Map();
            const send = child.send.bind(child);
            child.send = (message, ...args) => {
              requests.set(message.id, message);
              trace.push({ stage: "executor-request", pid: child.pid, type: message.type, id: message.id });
              return send(message, ...args);
            };
            const emit = child.emit.bind(child);
            child.emit = (name, message, ...args) => {
              if (name !== "message" || message?.type !== "response") return emit(name, message, ...args);
              const request = requests.get(message.id);
              requests.delete(message.id);
              void point({ stage: request?.type === "dashboard" ? "query-result" : "executor-result",
                pid: child.pid, type: request?.type, request, ...message }).then(() => emit(name, message, ...args));
              return true;
            };
          }
          return child;
        });
        // Deliver hints explicitly; file contents, debounce, server and child execution stay real.
        const watchers = new Set();
        f.watchers = watchers;
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
      // Let the OS avoid reserved ports instead of deriving one from the process ID.
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      f.base = `http://127.0.0.1:${server.address().port}`;
      return server;
    },
    async closeServer() {
      await server?.close();
      server = null;
    },
    async get(url = QUERY, init = {}) {
      const response = await fetch(f.base + url, { signal: AbortSignal.timeout(10_000), ...init });
      const result = { status: response.status, body: await response.json() };
      if (publication) trace.push({ stage: "http", url, ...result });
      return result;
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
      const close = async () => {
        abort.abort();
        await reader.cancel().catch(() => {});
        await pump;
      };
      cleanup.push(close);
      const until = async (name, predicate = () => true) => {
        const existing = events.find((event) => event.name === name && predicate(event));
        if (existing) return existing;
        let listener;
        return bounded(
          new Promise((resolve) => {
            listener = (event) => {
              if (event.name === name && predicate(event)) resolve(event);
            };
            received.on("event", listener);
          }),
          `SSE ${name}`,
        ).finally(() => received.off("event", listener));
      };
      await until("ready");
      return { events, until, close };
    },
  };
  if (publication) {
    for (const method of ["readSourceState", "readCertifiedSourceState", "publish", "get"]) {
      const original = UsageSummaryCache.prototype[method];
      t.mock.method(UsageSummaryCache.prototype, method, async function (...args) {
        if (this.databaseFile !== options.databaseFile) return original.apply(this, args);
        f.cache = this;
        await point({ stage: `before-${method}`, pid: process.pid, args });
        const result = await original.apply(this, args);
        await point({ stage: `after-${method}`, pid: process.pid, result });
        return result;
      });
    }
  }
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

export { fixture, assertCanonical, assertRollback, sourceRows, bounded, deferred, other, FILTERS, QUERY, HOT_ONLY };

export const publicationFixture = (t, kind) => fixture(t, kind, { hotOnly: false, publication: true });

export const captureGeneration = (f) => buildUsageReport(f.options);

export function assertGeneration(payload, report, label = "admitted generation", scope = {}) {
  assert.ok(payload.fingerprint, `${label}: fingerprint`);
  assert.ok(payload.usageVersion, `${label}: committed version`);
  const now = new Date(payload.periodComparison.asOf);
  const filters = { ...FILTERS, ...scope, now, pricingModels: payload.pricingCatalog.models };
  runWithPricingCatalog(payload.pricingCatalog, () => {
    const summary = summarizeUsage(report, filters);
    for (const key of ["totals", "eventCount", "sessionCount", "costEstimate", "timeline"])
      assert.deepEqual(clean(payload.summary[key]), clean(summary[key]), `${label}: ${key}`);
    assert.deepEqual(clean(payload.periodComparison), clean(summarizePeriodComparison(report.events, filters)),
      `${label}: period comparison uses the same facts and prices`);
  });
  assert.equal(payload.metadata.eventCount, report.events.length, `${label}: metadata facts`);
  assert.equal(payload.metadata.sessionCount, report.sessions.length, `${label}: metadata sessions`);
}
