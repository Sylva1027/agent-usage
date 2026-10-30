/**
 * Transparent Node HTTP response capture for WorkBuddy SSE transport timing.
 *
 * The wrapper observes IncomingMessage.push arguments before Readable delivers
 * them. It never consumes or rewrites the response body.
 */

import http from "node:http";

import { createOutputStreamCapture } from "./perf-stream-capture.js";

const { IncomingMessage } = http;

/**
 * @typedef {import("node:http").IncomingMessage & {req?: import("node:http").ClientRequest}} ClientResponse
 * @typedef {{
 *   context: {sessionId: string, messageId: string},
 *   capture: ReturnType<typeof createOutputStreamCapture>,
 *   invalid: boolean,
 *   complete: boolean,
 *   published: boolean,
 *   batchOpen: boolean,
 *   readId: number,
 *   cleanup: () => void
 * }} CaptureState
 */

function headerText(value) {
  return typeof value === "string" ? value : Array.isArray(value) && typeof value[0] === "string" ? value[0] : "";
}

/** @param {ClientResponse} message */
function captureContext(message) {
  const request = message.req;
  if (request === null || typeof request !== "object" || typeof request.getHeader !== "function") return null;

  const sessionId = request.getHeader("X-Conversation-ID");
  const messageId = request.getHeader("X-Conversation-Message-ID");
  if (typeof sessionId !== "string" || sessionId.trim() === "") return null;
  if (typeof messageId !== "string" || messageId.trim() === "") return null;

  const contentType = headerText(message.headers?.["content-type"]).split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "text/event-stream") return null;

  const contentEncoding = headerText(message.headers?.["content-encoding"]).trim().toLowerCase();
  if (contentEncoding !== "" && contentEncoding !== "identity") return null;

  return { sessionId, messageId };
}

/**
 * @param {unknown} chunk
 * @param {unknown} encoding
 * @returns {Uint8Array | null}
 */
function bytesFor(chunk, encoding) {
  if (chunk instanceof Uint8Array) return chunk;
  if (typeof chunk === "string") {
    return Buffer.from(chunk, typeof encoding === "string" ? /** @type {BufferEncoding} */ (encoding) : undefined);
  }
  return null;
}

/**
 * Install an IncomingMessage.push observer for eligible SSE responses.
 *
 * @param {{ onMeasurement: (context: {sessionId: string, messageId: string}, result: object) => void | Promise<void> }} options
 * @returns {() => void}
 */
export function installHttpCapture({ onMeasurement }) {
  if (typeof onMeasurement !== "function") {
    throw new TypeError("installHttpCapture requires an onMeasurement function");
  }

  const prototype = IncomingMessage.prototype;
  const previousPush = prototype.push;
  if (typeof previousPush !== "function") {
    throw new TypeError("http.IncomingMessage.prototype.push must be a function");
  }

  const ownPushDescriptor = Object.getOwnPropertyDescriptor(prototype, "push");
  /** @type {WeakMap<object, CaptureState | false>} */
  const states = new WeakMap();
  /** @type {Set<CaptureState>} */
  const activeStates = new Set();
  let disposed = false;

  /**
   * @param {CaptureState} state
   */
  function retireState(state) {
    activeStates.delete(state);
    state.cleanup();
  }

  /**
   * @param {CaptureState} state
   */
  function invalidateState(state) {
    if (state.invalid) return;
    state.invalid = true;
    retireState(state);
  }

  /**
   * @param {ClientResponse} message
   * @returns {CaptureState | false}
   */
  function stateFor(message) {
    const cached = states.get(message);
    if (cached !== undefined) return cached;

    const context = captureContext(message);
    if (context === null) {
      states.set(message, false);
      return false;
    }

    /** @type {CaptureState} */
    const state = {
      context,
      capture: createOutputStreamCapture(),
      invalid: false,
      complete: false,
      published: false,
      batchOpen: false,
      readId: 0,
      cleanup: () => {},
    };

    const request = message.req;
    const onAborted = () => invalidateState(state);
    const onClose = () => {
      if (!message.complete) invalidateState(state);
      else retireState(state);
    };
    const onRequestAbort = () => invalidateState(state);

    state.cleanup = () => {
      message.off("aborted", onAborted);
      message.off("close", onClose);
      request?.off("abort", onRequestAbort);
    };
    message.once("aborted", onAborted);
    message.once("close", onClose);
    request?.once("abort", onRequestAbort);

    states.set(message, state);
    activeStates.add(state);
    return state;
  }

  /**
   * @param {CaptureState} state
   * @param {number} elapsedMs
   */
  function stampFor(state, elapsedMs) {
    if (!state.batchOpen) {
      state.batchOpen = true;
      state.readId += 1;
      queueMicrotask(() => {
        state.batchOpen = false;
      });
    }
    return { elapsedMs, readId: state.readId };
  }

  /**
   * @param {CaptureState} state
   * @param {object} result
   */
  function publish(state, result) {
    if (state.invalid || state.published || !result.measurement) return;
    state.published = true;
    try {
      const pending = onMeasurement(state.context, result);
      if (pending !== null && typeof pending === "object" && typeof pending.then === "function") {
        Promise.resolve(pending).catch(() => {});
      }
    } catch {
      // Measurement delivery cannot alter the HTTP response.
    }
  }

  /** @this {ClientResponse} */
  function wrappedPush(...args) {
    if (disposed) return Reflect.apply(previousPush, this, args);

    const elapsedMs = performance.now();
    const chunk = args[0];
    const cached = states.get(this);
    const state = cached === false ? false : (cached ?? (chunk === null ? false : stateFor(this)));

    if (state && !state.invalid && !state.complete) {
      const bytes = bytesFor(chunk, args[1]);
      if (bytes === null) {
        invalidateState(state);
      } else {
        try {
          state.capture.push(bytes, stampFor(state, elapsedMs));
        } catch {
          invalidateState(state);
        }
      }
    }

    let pushed;
    try {
      pushed = Reflect.apply(previousPush, this, args);
    } catch (error) {
      if (state) invalidateState(state);
      throw error;
    }
    if (!state || state.invalid) return pushed;

    if (pushed === false) {
      invalidateState(state);
      return pushed;
    }
    if (state.complete) return pushed;

    let result = null;
    try {
      result = state.capture.finish();
    } catch {
      invalidateState(state);
      return pushed;
    }
    if (result !== null) {
      state.complete = true;
      publish(state, result);
      retireState(state);
    }
    return pushed;
  }

  Object.defineProperty(prototype, "push", {
    configurable: true,
    writable: true,
    value: wrappedPush,
  });

  return () => {
    if (disposed) return;
    disposed = true;
    for (const state of activeStates) invalidateState(state);
    activeStates.clear();

    if (prototype.push !== wrappedPush) return;
    if (ownPushDescriptor !== undefined) Object.defineProperty(prototype, "push", ownPushDescriptor);
    else delete prototype.push;
  };
}
