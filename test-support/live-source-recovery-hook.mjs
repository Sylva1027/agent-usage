import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createConnection } from "node:net";
import { UsageSourceProof } from "../src/usage-source-proof.js";
import { UsageStore } from "../src/usage-store.js";

// Loaded only by this test's explicit --import; production has no hook or environment branch.
export function installRecoveryHooks(point, firstPath = null) {
  const restore = [];
  const owners = new WeakMap();
  let round = 0;
  function wrap(object, name, replacement) {
    const original = object[name];
    object[name] = replacement(original);
    restore.push(() => {
      object[name] = original;
    });
  }
  function snapshot(store) {
    const db = store?.database;
    if (!db?.isOpen) return null;
    const rows = (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    return {
      transaction: db.isTransaction,
      depth: store.writeTransactionDepth,
      events: rows("events"),
      progress: rows("usage_source_progress"),
      quotas: rows("quota_usage_sources"),
      rates: rows("rate_limit_observations"),
      fingerprint: store.readMeta("fingerprint"),
      work: store.lastSyncSourceWork,
      warnings: store.warnings,
    };
  }
  const emit = (stage, store, extra = {}) =>
    point(
      {
        stage,
        round,
        pid: process.pid,
        ...extra,
        snapshot: snapshot(store),
      },
      store,
    );
  wrap(UsageSourceProof.prototype, "provider", () => async () => null);
  wrap(
    UsageStore.prototype,
    "usageFiles",
    (original) =>
      async function (...args) {
        const result = await original.apply(this, args);
        if (firstPath) result.files.sort((a, b) => Number(b.filePath === firstPath) - Number(a.filePath === firstPath));
        return result;
      },
  );
  wrap(
    UsageStore.prototype,
    "syncRound",
    (original) =>
      async function (...args) {
        round += 1;
        if (firstPath && args[0]?.acquisitionPlan)
          args[0].acquisitionPlan.files.sort(
            (a, b) => Number(b.filePath === firstPath) - Number(a.filePath === firstPath),
          );
        await emit("round-start", this);
        try {
          const value = await original.apply(this, args);
          await emit("round-done", this, { result: value });
          return value;
        } catch (error) {
          await emit("round-error", this, {
            error: { code: error.code, retryable: error.retryable, statusCode: error.statusCode },
          });
          throw error;
        }
      },
  );
  for (const method of ["appendFile", "replaceFile"]) {
    wrap(
      UsageStore.prototype,
      method,
      (original) =>
        async function (...args) {
          owners.set(this.sourceProof, { store: this, callbacks: args[1] });
          const file = args[0];
          await emit("source-start", this, { method, file: file.filePath, size: file.info.size });
          try {
            const result = await original.apply(this, args);
            await emit(result?.committed ? "source-commit" : "source-fallback", this, {
              method,
              file: file.filePath,
              result,
            });
            return result;
          } catch (error) {
            await emit("source-error", this, {
              method,
              file: file.filePath,
              error: {
                code: error.code,
                retryable: error.retryable,
                statusCode: error.statusCode,
                message: error.message,
              },
            });
            throw error;
          }
        },
    );
  }
  for (const method of ["verify", "capture"]) {
    wrap(
      UsageSourceProof.prototype,
      method,
      (original) =>
        async function (...args) {
          const owner = owners.get(this);
          const action = await emit(`before-${method}`, owner?.store, { file: args[0] });
          if (action?.warning) owner?.callbacks?.onWarning?.(action.warning);
          return original.apply(this, args);
        },
    );
  }
  return () => {
    for (const undo of restore.reverse()) undo();
  };
}

function installPublicationHandoffHooks(point) {
  UsageSourceProof.prototype.provider = async () => null;
  globalThis[Symbol.for("usage-publication-handoff")] = point;
  const probe = (stage, fields = "") =>
    `await globalThis[Symbol.for("usage-publication-handoff")]({stage:${JSON.stringify(stage)},pid:process.pid,requestId:message.id${fields}});`;
  registerHooks({
    load(url, context, next) {
      const loaded = next(url, context);
      if (url !== new URL("../src/usage-executor.js", import.meta.url).href) return loaded;
      let source = String(loaded.source);
      const inject = (needle, replacement) => {
        assert.equal(source.split(needle).length, 2, `Publication handoff hook moved: ${needle}`);
        source = source.replace(needle, replacement);
      };
      // Preserve the promise captured by the real await before pausing the child.
      inject("await liveReadersDone;", `const waitingReaders = liveReadersDone;
        ${probe("sync-wait", ",liveReaders")}
        await waitingReaders;`);
      inject("ready = publishedReady;", `ready = publishedReady;
          ${probe("reader-wait")}`);
      inject("nextStatus = await syncUsageStore(", `${probe("sync-start", ",liveReaders,pinned:Boolean(publishedReader)")}
          nextStatus = await syncUsageStore(`);
      const query = "dashboard = await reader.dashboardHistory(filters, message.options ?? {});";
      inject(query, `${probe("reader-enter", ",liveReaders,pinned:Boolean(lease)")}
          ${query}
          ${probe("reader-result", ",liveReaders,pinned:Boolean(lease)")}`);
      return { ...loaded, source };
    },
  });
}

if (process.env.LIVE_RECOVERY_CONTROL_PORT && process.env.CODEX_USAGE_EXECUTOR_CHILD === "1") {
  const socket = createConnection({ host: "127.0.0.1", port: Number(process.env.LIVE_RECOVERY_CONTROL_PORT) });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  let sequence = 0;
  let buffer = "";
  const waiting = new Map();
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      waiting.get(message.id)?.(message.action);
      waiting.delete(message.id);
    }
  });
  socket.unref();
  const point = (event) => new Promise((resolve) => {
    const id = ++sequence;
    waiting.set(id, resolve);
    socket.write(`${JSON.stringify({ id, ...event })}\n`);
  });
  if (process.env.LIVE_RECOVERY_HANDOFF === "1") installPublicationHandoffHooks(point);
  else installRecoveryHooks(point, process.env.LIVE_RECOVERY_FIRST_PATH || null);
}
