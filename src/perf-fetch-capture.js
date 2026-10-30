/**
 * Transparent fetch wrapper that captures SSE output timing from a raw-body
 * pump while preserving the original response bytes and cancellation.
 */

import { createOutputStreamCapture } from "./perf-stream-capture.js";

// Stop raw-read-ahead at this bound when the application consumer stalls.
const MAX_BUFFERED_BYTES = 1024 * 1024;

function isEventStream(response) {
  return (
    response !== null &&
    typeof response === "object" &&
    response.body !== null &&
    typeof response.body === "object" &&
    typeof response.headers?.get === "function" &&
    response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() === "text/event-stream"
  );
}

function copyResponseMetadata(target, source) {
  for (const key of ["url", "redirected", "type"]) {
    try {
      Object.defineProperty(target, key, {
        configurable: true,
        enumerable: true,
        value: source[key],
      });
    } catch {
      // The wrapped Response still preserves status, headers, and body.
    }
  }
}

function beginRead(reader) {
  let elapsedMs = 0;
  const promise = reader.read().then(
    (result) => {
      elapsedMs = performance.now();
      return result;
    },
    (error) => {
      elapsedMs = performance.now();
      throw error;
    },
  );
  void promise.catch(() => {});
  return {
    promise,
    get elapsedMs() {
      return elapsedMs;
    },
  };
}

/**
 * @param {Response} response
 * @param {object} context
 * @param {(context: object, result: object) => void | Promise<void>} onMeasurement
 * @returns {Response}
 */
function wrapEventStreamResponse(response, context, onMeasurement) {
  if (response.body === null || response.body.locked || response.bodyUsed) return response;

  const capture = createOutputStreamCapture();
  /** @type {Uint8Array[]} */
  const queuedChunks = [];
  let queuedBytes = 0;
  let ended = false;
  let canceled = false;
  let hasReadError = false;
  let readError = null;
  let dataWaiter = null;
  let capacityWaiter = null;
  let published = false;
  let captureBroken = false;
  let reader = null;

  /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
  let streamController = null;

  function wakeDataWaiter() {
    const waiter = dataWaiter;
    dataWaiter = null;
    waiter?.();
  }

  function wakeCapacityWaiter() {
    const waiter = capacityWaiter;
    capacityWaiter = null;
    waiter?.();
  }

  function publishMeasurement(result) {
    if (published || !result?.measurement) return;
    published = true;
    try {
      const pending = onMeasurement(context, result);
      if (pending !== null && typeof pending === "object" && typeof pending.then === "function") {
        Promise.resolve(pending).catch(() => {});
      }
    } catch {
      // Callback failure must not affect response delivery.
    }
  }

  function finishCapture() {
    if (captureBroken) return;
    try {
      publishMeasurement(capture.finish());
    } catch {
      captureBroken = true;
    }
  }

  function captureChunk(chunk, stamp) {
    if (captureBroken || canceled) return;
    try {
      capture.push(chunk, stamp);
      finishCapture();
    } catch {
      captureBroken = true;
    }
  }

  async function waitForCapacity() {
    if (canceled || ended || queuedBytes < MAX_BUFFERED_BYTES) return;
    captureBroken = true;
    await new Promise((resolve) => {
      capacityWaiter = resolve;
    });
  }

  async function enqueueCapturedChunk(chunk) {
    if (canceled || ended) return;
    queuedChunks.push(chunk);
    queuedBytes += chunk.byteLength;
    wakeDataWaiter();
    await waitForCapacity();
  }

  async function waitForData() {
    if (queuedChunks.length > 0 || ended) return;
    await new Promise((resolve) => {
      dataWaiter = resolve;
    });
  }

  async function pull(controller) {
    await waitForData();
    if (canceled) return;
    const chunk = queuedChunks.shift();
    if (chunk !== undefined) {
      queuedBytes -= chunk.byteLength;
      wakeCapacityWaiter();
      controller.enqueue(chunk);
      if (ended && queuedChunks.length === 0) {
        if (hasReadError) controller.error(readError);
        else controller.close();
      }
      return;
    }
    if (hasReadError) throw readError;
    if (ended) controller.close();
  }

  async function cancel(reason) {
    if (canceled) return;
    canceled = true;
    ended = true;
    queuedChunks.length = 0;
    queuedBytes = 0;
    wakeDataWaiter();
    wakeCapacityWaiter();
    if (reader !== null) await reader.cancel(reason);
  }

  const body = new ReadableStream(
    {
      start(controller) {
        streamController = controller;
      },
      pull,
      cancel,
    },
    { highWaterMark: 0 },
  );

  let wrapped;
  try {
    wrapped = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    copyResponseMetadata(wrapped, response);
  } catch {
    void body.cancel();
    return response;
  }

  try {
    reader = response.body.getReader();
  } catch {
    try {
      streamController?.error(new Error("Unable to read SSE response body"));
    } catch {
      // Return the untouched response below.
    }
    return response;
  }

  async function pump() {
    let pending = beginRead(reader);
    /** @type {{elapsedMs: number, readId: number} | null} */
    let batch = null;
    let nextReadId = 1;
    try {
      while (!canceled) {
        const result = await pending.promise;
        if (canceled) return;
        if (result.done) {
          finishCapture();
          ended = true;
          wakeDataWaiter();
          return;
        }

        if (batch === null) {
          batch = { elapsedMs: pending.elapsedMs, readId: nextReadId };
          nextReadId += 1;
          // A body reader can yield through microtasks while draining one IO batch.
          setImmediate(() => {
            batch = null;
          });
        }

        captureChunk(result.value, batch);
        pending = beginRead(reader);
        await enqueueCapturedChunk(result.value);
      }
    } catch (error) {
      if (canceled) return;
      hasReadError = true;
      readError = error;
      ended = true;
      wakeDataWaiter();
      wakeCapacityWaiter();
    }
  }

  void pump();
  return wrapped;
}

/**
 * Install a transparent fetch wrapper for context-associated SSE responses.
 *
 * @param {{
 *   getContext: () => object | null,
 *   onMeasurement: (context: object, result: object) => void | Promise<void>
 * }} options
 * @returns {() => void}
 */
export function installFetchCapture({ getContext, onMeasurement }) {
  if (typeof getContext !== "function" || typeof onMeasurement !== "function") {
    throw new TypeError("installFetchCapture requires getContext and onMeasurement functions");
  }
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    throw new TypeError("globalThis.fetch must be a function");
  }

  let disposed = false;
  const wrappedFetch = async function (...args) {
    let context = null;
    try {
      context = getContext();
    } catch {
      context = null;
    }

    const response = await Reflect.apply(originalFetch, this, args);
    if (context === null || context === undefined || !isEventStream(response)) return response;
    try {
      return wrapEventStreamResponse(response, context, onMeasurement);
    } catch {
      return response;
    }
  };

  globalThis.fetch = wrappedFetch;
  return () => {
    if (disposed) return;
    disposed = true;
    if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
  };
}
