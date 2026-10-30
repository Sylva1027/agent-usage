import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { installFetchCapture } from "../src/perf-fetch-capture.js";

const encoder = new TextEncoder();

function sseEvent(payload) {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `data: ${data}\n\n`;
}

function chatChunk(delta, index = 0) {
  return {
    id: "chat-stream",
    object: "chat.completion.chunk",
    model: "chat-model",
    choices: [{ index, delta }],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withLocalServer(handler, run) {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => response.destroy(error));
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
  try {
    return await run(server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withTimeout(promise, timeoutMs = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for measurement")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withInstalledCapture(mockFetch, options, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  const dispose = installFetchCapture(options);
  try {
    return await run(dispose);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
  }
}

test("non-SSE responses are exact passthrough and fetch arguments are unchanged", async () => {
  const response = new Response('{"ok":true}', {
    status: 201,
    statusText: "Created",
    headers: { "content-type": "application/json" },
  });
  const request = new Request("https://example.test/request", {
    method: "POST",
    headers: { "x-request-id": "request-1" },
    body: "request-body",
  });
  const init = { signal: new AbortController().signal };
  const calls = [];
  const mockFetch = async function (...args) {
    calls.push({ receiver: this, args });
    return response;
  };

  await withInstalledCapture(
    mockFetch,
    {
      getContext: () => ({ attempt: "context-1" }),
      onMeasurement: () => {
        assert.fail("non-SSE response must not be measured");
      },
    },
    async (dispose) => {
      const result = await globalThis.fetch(request, init);
      assert.equal(result, response);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].receiver, globalThis);
      assert.equal(calls[0].args.length, 2);
      assert.equal(calls[0].args[0], request);
      assert.equal(calls[0].args[1], init);

      dispose();
      assert.equal(globalThis.fetch, mockFetch);
    },
  );
});

test("a null context leaves an SSE response untouched", async () => {
  const response = new Response(sseEvent(chatChunk({ content: "中" })), {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
  const mockFetch = async () => response;

  await withInstalledCapture(
    mockFetch,
    {
      getContext: () => null,
      onMeasurement: () => {
        assert.fail("null context must not be measured");
      },
    },
    async () => {
      assert.equal(await globalThis.fetch("https://example.test/stream"), response);
    },
  );
});

test("multiple already-ready chunks share one raw receive stamp", async () => {
  const firstChunk = sseEvent(chatChunk({ content: "中" }));
  const secondChunk = sseEvent(chatChunk({ content: "中" })) + sseEvent("[DONE]");
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(firstChunk));
      controller.enqueue(encoder.encode(secondChunk));
      controller.close();
    },
  });
  const response = new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
  let measured = false;

  await withInstalledCapture(
    async () => response,
    {
      getContext: () => ({ attempt: "ready-drain" }),
      onMeasurement: () => {
        measured = true;
      },
    },
    async () => {
      const wrapped = await globalThis.fetch("https://example.test/stream");
      assert.equal(await wrapped.text(), firstChunk + secondChunk);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(measured, false);
    },
  );
});

test("real localhost fetch keeps one corked 1100-delta Chat batch unmeasured", async () => {
  const delta = sseEvent(chatChunk({ content: "中" }));
  const deltas = Array.from({ length: 1_100 }, () => delta);
  const expectedBody = Buffer.from(deltas.join("") + sseEvent("[DONE]"), "utf8");
  let measured = false;

  await withLocalServer(
    (_request, response) => {
      response.cork();
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      for (const event of deltas) response.write(event);
      response.write(sseEvent("[DONE]"));
      response.uncork();
      response.end();
    },
    async (port) => {
      await withInstalledCapture(
        globalThis.fetch,
        {
          getContext: () => ({ attempt: "fetch-local-batch" }),
          onMeasurement: () => {
            measured = true;
          },
        },
        async () => {
          const response = await globalThis.fetch(`http://127.0.0.1:${port}/stream`, { method: "POST" });
          const received = Buffer.from(await response.arrayBuffer());
          await new Promise((resolve) => setImmediate(resolve));
          assert.ok(received.equals(expectedBody), "raw response body differs");
          assert.equal(measured, false, "one transport batch must not produce measurement");
        },
      );
    },
  );
});

test("real localhost fetch measures only the 200-delta tail with a 150 ms batch gap", async () => {
  const first = Array.from({ length: 900 }, () => sseEvent(chatChunk({ content: "中" })));
  const second = Array.from({ length: 200 }, () => sseEvent(chatChunk({ content: "中" })));
  const expectedBody = Buffer.from(first.join("") + second.join("") + sseEvent("[DONE]"), "utf8");
  const measured = deferred();

  await withLocalServer(
    async (_request, response) => {
      response.cork();
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      for (const event of first) response.write(event);
      response.uncork();
      await new Promise((resolve) => setTimeout(resolve, 150));
      response.cork();
      for (const event of second) response.write(event);
      response.write(sseEvent("[DONE]"));
      response.uncork();
      response.end();
    },
    async (port) => {
      await withInstalledCapture(
        globalThis.fetch,
        {
          getContext: () => ({ attempt: "fetch-delayed-tail" }),
          onMeasurement: (_context, result) => measured.resolve(result),
        },
        async () => {
          const response = await globalThis.fetch(`http://127.0.0.1:${port}/stream`, { method: "POST" });
          const result = await withTimeout(measured.promise, 3_000);
          const received = Buffer.from(await response.arrayBuffer());
          assert.equal(result.measurement.outputTokens, 200);
          assert.ok(received.equals(expectedBody), "raw response body differs");
        },
      );
    },
  );
});

test("raw pump publishes the 200-token tail before terminal bytes reach a delayed consumer", async () => {
  let controller;
  const body = new ReadableStream({
    start(streamController) {
      controller = streamController;
    },
  });
  const response = new Response(body, {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
  Object.defineProperties(response, {
    url: { configurable: true, value: "https://example.test/stream" },
    redirected: { configurable: true, value: true },
    type: { configurable: true, value: "basic" },
  });

  const measurementDeferred = deferred();
  const order = [];
  const originalContext = { attempt: "attempt-1" };
  let currentContext = originalContext;
  const requestArgs = ["https://example.test/stream", { method: "POST", body: "unchanged" }];
  const mockFetch = async (...args) => {
    assert.deepEqual(args, requestArgs);
    await Promise.resolve();
    return response;
  };

  await withInstalledCapture(
    mockFetch,
    {
      getContext: () => currentContext,
      onMeasurement: (context, result) => {
        order.push("measurement");
        measurementDeferred.resolve({ context, result });
      },
    },
    async () => {
      const pendingResponse = globalThis.fetch(...requestArgs);
      currentContext = { attempt: "different-context" };
      const wrapped = await pendingResponse;
      assert.notEqual(wrapped, response);
      assert.equal(wrapped.status, 200);
      assert.equal(wrapped.statusText, "OK");
      assert.equal(wrapped.headers.get("content-type"), "text/event-stream; charset=utf-8");
      assert.equal(wrapped.url, "https://example.test/stream");
      assert.equal(wrapped.redirected, true);
      assert.equal(wrapped.type, "basic");

      const firstChunk = Array.from({ length: 900 }, () => sseEvent(chatChunk({ content: "中" }))).join("");
      const secondChunk =
        Array.from({ length: 200 }, () => sseEvent(chatChunk({ content: "中" }))).join("") + sseEvent("[DONE]");
      controller.enqueue(encoder.encode(firstChunk));
      await new Promise((resolve) => setTimeout(resolve, 25));
      controller.enqueue(encoder.encode(secondChunk));
      controller.close();

      const { context, result } = await withTimeout(measurementDeferred.promise);
      assert.equal(context, originalContext);
      assert.equal(result.responseId, "chat-stream");
      assert.equal(result.model, "chat-model");
      assert.equal(result.measurement.outputTokens, 200);
      assert.ok(result.measurement.durationMs > 0);
      assert.equal(result.measurement.windows[0].outputTokens, 200);

      order.push("consumer");
      assert.equal(await wrapped.text(), firstChunk + secondChunk);
      assert.deepEqual(order, ["measurement", "consumer"]);
    },
  );
});

test("consumer backpressure permanently disables capture but preserves the body", async () => {
  let controller;
  const body = new ReadableStream({
    start(streamController) {
      controller = streamController;
    },
  });
  const response = new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
  let measured = false;

  await withInstalledCapture(
    async () => response,
    {
      getContext: () => ({ attempt: "backpressure" }),
      onMeasurement: () => {
        measured = true;
      },
    },
    async () => {
      const wrapped = await globalThis.fetch("https://example.test/stream");
      const firstChunk = `${sseEvent(chatChunk({ content: "a" }))}:${"x".repeat(1024 * 1024 + 1)}\n`;
      const secondChunk = sseEvent(chatChunk({ content: "b" })) + sseEvent("[DONE]");

      controller.enqueue(encoder.encode(firstChunk));
      await new Promise((resolve) => setTimeout(resolve, 25));
      controller.enqueue(encoder.encode(secondChunk));
      controller.close();

      assert.equal(await wrapped.text(), firstChunk + secondChunk);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(measured, false);
    },
  );
});

test("consumer cancellation propagates to the original body and suppresses measurement", async () => {
  const cancelReason = { reason: "consumer-stopped" };
  let originalCancelReason = null;
  const body = new ReadableStream({
    cancel(reason) {
      originalCancelReason = reason;
    },
  });
  const response = new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
  let measured = false;

  await withInstalledCapture(
    async () => response,
    {
      getContext: () => ({ attempt: "cancel" }),
      onMeasurement: () => {
        measured = true;
      },
    },
    async () => {
      const wrapped = await globalThis.fetch("https://example.test/stream");
      const reader = wrapped.body.getReader();
      await reader.cancel(cancelReason);
      assert.equal(originalCancelReason, cancelReason);
      await Promise.resolve();
      assert.equal(measured, false);
    },
  );
});

test("a read error after buffered bytes propagates after those bytes", async () => {
  const sentinel = new Error("failed after chunk");
  const chunk = encoder.encode(sseEvent(chatChunk({ content: "a" })));
  let pullCount = 0;
  const body = new ReadableStream({
    pull(controller) {
      pullCount += 1;
      if (pullCount === 1) controller.enqueue(chunk);
      else controller.error(sentinel);
    },
  });
  const response = new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
  let measured = false;

  await withInstalledCapture(
    async () => response,
    {
      getContext: () => ({ attempt: "buffered-error" }),
      onMeasurement: () => {
        measured = true;
      },
    },
    async () => {
      const wrapped = await globalThis.fetch("https://example.test/stream");
      const reader = wrapped.body.getReader();
      const first = await reader.read();
      assert.deepEqual(first.value, chunk);
      await assert.rejects(reader.read(), (error) => error === sentinel);
      assert.equal(measured, false);
    },
  );
});

test("original body read errors propagate and do not produce a measurement", async () => {
  const sentinel = new Error("stream failed");
  let controller;
  const body = new ReadableStream({
    start(streamController) {
      controller = streamController;
    },
  });
  const response = new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
  let measured = false;

  await withInstalledCapture(
    async () => response,
    {
      getContext: () => ({ attempt: "error" }),
      onMeasurement: () => {
        measured = true;
      },
    },
    async () => {
      const wrapped = await globalThis.fetch("https://example.test/stream");
      const read = wrapped.text();
      controller.error(sentinel);
      await assert.rejects(read, (error) => error === sentinel);
      assert.equal(measured, false);
    },
  );
});
