import { AsyncLocalStorage } from "node:async_hooks";
import { homedir } from "node:os";
import path from "node:path";

import { dshSessionFiles } from "../src/dsh-usage.js";
import { installFetchCapture } from "../src/perf-fetch-capture.js";
import { appendOutputObservation, outputObservationFile } from "../src/perf-output-observations.js";

export const name = "local-output-speed";
export const inject = ["llm", "sessions"];

/** DSH's supported stream/event hooks bind transport observations to the committed message. */
export function apply(ctx, config = {}) {
  const home = path.resolve(config.home ?? process.env.DSH_HOME ?? path.join(homedir(), ".dsh"));
  const context = new AsyncLocalStorage();
  const attempts = new Map();
  const files = new Map();
  const pending = new Set();
  let disposed = false;

  const report = (error) => ctx.logger?.debug?.("local-output-speed: %s", error?.message ?? String(error));
  const restore = installFetchCapture({
    getContext: () => context.getStore() ?? null,
    onMeasurement: (attempt, result) => {
      if (result.measurement) attempt.measurements.push(result.measurement);
    },
  });

  ctx.on("agent/assistant-stream", ({ agent, frame }) => {
    const sessionId = agent?.session?.id;
    if (!sessionId || !frame?.attemptId) return;
    if (frame.type === "start") {
      attempts.set(sessionId, { id: frame.attemptId, sessionId, measurements: [], message: null });
      return;
    }
    if (frame.type !== "end") return;
    const attempt = attempts.get(sessionId);
    if (attempt?.id !== frame.attemptId) return;
    attempts.delete(sessionId);
    if (
      disposed ||
      frame.outcome?.kind !== "committed" ||
      frame.outcome.eventType !== "assistant/message" ||
      attempt.message?.seq !== frame.outcome.seq ||
      attempt.measurements.length !== 1
    ) return;
    const message = attempt.message.data.message;
    const save = (async () => {
      let sourceFile = files.get(sessionId);
      if (!sourceFile) {
        for (const file of await dshSessionFiles(home)) files.set(path.basename(path.dirname(file)), file);
        sourceFile = files.get(sessionId);
      }
      if (!sourceFile) throw new Error("Committed DSH session file is unavailable");
      await appendOutputObservation(outputObservationFile(sourceFile, "dsh"), {
        schemaVersion: 3,
        sourceKind: "dsh",
        sessionId,
        messageId: message.id,
        model: message.source?.model,
        modelProvider: message.source?.provider,
        clock: "transport_receive",
        measurement: attempt.measurements[0],
      });
    })().catch(report);
    pending.add(save);
    void save.finally(() => pending.delete(save));
  }, { global: true });

  ctx.on("session/event", (session, event) => {
    const attempt = attempts.get(session.id);
    if (attempt && event.type === "assistant/message") attempt.message = event;
  }, { global: true });

  ctx.on("llm/stream", (options, next) => {
    if (!options.sessionId) return next();
    return (async function* () {
      const attempt = attempts.get(options.sessionId);
      if (!attempt) return yield* next();
      const iterator = context.run(attempt, () => next()[Symbol.asyncIterator]());
      try {
        while (true) {
          const item = await context.run(attempt, () => iterator.next());
          if (item.done) return;
          yield item.value;
        }
      } finally {
        await context.run(attempt, () => iterator.return?.());
      }
    })();
  }, { global: true, prepend: true });

  ctx.on("session/disposed", (session) => {
    attempts.delete(session.id);
    files.delete(session.id);
  });
  ctx.effect(() => async () => {
    disposed = true;
    restore();
    attempts.clear();
    files.clear();
    await Promise.allSettled([...pending]);
  });
}
