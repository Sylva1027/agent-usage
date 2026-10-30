import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import { installHttpCapture } from "../src/perf-http-capture.js";

const prototype = http.IncomingMessage.prototype;

function sseEvent(payload) {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `data: ${data}\n\n`;
}

function chatChunk(delta, id = "wire-response", model = "wire-model") {
  return {
    id,
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta }],
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout(promise, timeoutMs = 2_000) {
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

async function withServer(handler, run) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    return await run(server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

function requestBody(port, headers, requestPath = "/") {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: requestPath,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

function requestBodyBytes(port, headers, requestPath = "/") {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: requestPath,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const bodyBytes = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
          resolve({
            body: Buffer.concat(chunks, bodyBytes),
            bodyBytes,
          });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function withInstalledCapture(options, run) {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "push");
  const dispose = installHttpCapture(options);
  try {
    return await run(dispose);
  } finally {
    dispose();
    if (descriptor === undefined) delete prototype.push;
    else Object.defineProperty(prototype, "push", descriptor);
  }
}

test("900-token first batch and 200-token terminal batch count only the tail", async () => {
  const first = sseEvent(chatChunk({ content: "中".repeat(900) }));
  const second = sseEvent(chatChunk({ content: "中".repeat(200) })) + sseEvent("[DONE]");
  const measured = deferred();
  let callbackCount = 0;

  await withServer(
    async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      response.write(first);
      await delay(150);
      response.end(second);
    },
    async (port) => {
      await withInstalledCapture(
        {
          onMeasurement: (context, result) => {
            callbackCount += 1;
            measured.resolve({ context, result });
          },
        },
        async () => {
          assert.equal(
            await requestBody(port, {
              "X-Conversation-ID": "session-local",
              "X-Conversation-Message-ID": "message-local",
            }),
            first + second,
          );
          const { context, result } = await withTimeout(measured.promise);
          assert.deepEqual(context, { sessionId: "session-local", messageId: "message-local" });
          assert.equal(result.measurement.outputTokens, 200);
          assert.equal(result.measurement.windows.length, 1);
          assert.equal(result.measurement.windows[0].outputTokens, 200);
          assert.ok(result.measurement.durationMs > 0);
        },
      );
    },
  );

  assert.equal(callbackCount, 1);
});

test("real localhost IncomingMessage keeps one corked 1100-delta Chat batch unmeasured", async () => {
  const delta = sseEvent(chatChunk({ content: "中" }));
  const deltas = Array.from({ length: 1_100 }, () => delta);
  const expectedBody = Buffer.from(deltas.join("") + sseEvent("[DONE]"), "utf8");
  let callbackCount = 0;

  await withServer(
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
        {
          onMeasurement: () => {
            callbackCount += 1;
          },
        },
        async () => {
          const received = await requestBodyBytes(port, {
            "X-Conversation-ID": "session-local-batch",
            "X-Conversation-Message-ID": "message-local-batch",
          });
          await delay(10);
          assert.equal(received.bodyBytes, expectedBody.byteLength);
          assert.ok(received.body.equals(expectedBody), "raw response body differs");
          assert.equal(callbackCount, 0, "one transport batch must not produce measurement");
        },
      );
    },
  );
});

test("capture context uses local request IDs while the result retains wire identity", async () => {
  const first = sseEvent(chatChunk({ content: "中" }, "wire-response", "wire-model-alias"));
  const second = sseEvent(chatChunk({ content: "中" }, "wire-response", "wire-model-alias")) + sseEvent("[DONE]");
  const measured = deferred();

  await withServer(
    async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(first);
      await delay(150);
      response.end(second);
    },
    async (port) => {
      await withInstalledCapture(
        { onMeasurement: (context, result) => measured.resolve({ context, result }) },
        async () => {
          await requestBody(port, {
            "X-Conversation-ID": "local-session",
            "X-Conversation-Message-ID": "local-message",
          });
          const { context, result } = await withTimeout(measured.promise);
          assert.deepEqual(context, { sessionId: "local-session", messageId: "local-message" });
          assert.equal(result.responseId, "wire-response");
          assert.equal(result.model, "wire-model-alias");
        },
      );
    },
  );
});

test("one raw batch with 1100 output tokens produces no measurement", async () => {
  const body =
    sseEvent(chatChunk({ content: "中".repeat(1_100) })) +
    sseEvent({
      id: "wire-response",
      object: "chat.completion.chunk",
      model: "wire-model",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }) +
    sseEvent("[DONE]");
  let callbackCount = 0;

  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(body);
    },
    async (port) => {
      await withInstalledCapture(
        {
          onMeasurement: () => {
            callbackCount += 1;
          },
        },
        async () => {
          assert.equal(
            await requestBody(port, {
              "X-Conversation-ID": "session-single",
              "X-Conversation-Message-ID": "message-single",
            }),
            body,
          );
          await delay(10);
        },
      );
    },
  );

  assert.equal(callbackCount, 0);
});

test("original push backpressure permanently disables measurement without changing the body", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "push");
  const basePush = prototype.push;
  const pushReturns = [];
  Object.defineProperty(prototype, "push", {
    configurable: true,
    writable: true,
    value: function observedPush(...args) {
      const result = Reflect.apply(basePush, this, args);
      if (args[0] !== null) pushReturns.push(result);
      return result;
    },
  });

  const first = `:${"x".repeat(128 * 1024)}\n\n`;
  const second = sseEvent(chatChunk({ content: "中" })) + sseEvent("[DONE]");
  const terminalWritten = deferred();
  let callbackCount = 0;
  let dispose;

  try {
    await withServer(
      async (_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(first);
        await delay(15);
        response.end(second);
        terminalWritten.resolve();
      },
      async (port) => {
        dispose = installHttpCapture({
          onMeasurement: () => {
            callbackCount += 1;
          },
        });

        const body = await new Promise((resolve, reject) => {
          const request = http.request(
            {
              host: "127.0.0.1",
              port,
              headers: {
                "X-Conversation-ID": "session-backpressure",
                "X-Conversation-Message-ID": "message-backpressure",
              },
            },
            (response) => {
              void (async () => {
                await terminalWritten.promise;
                await delay(25);
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
                response.on("error", reject);
              })();
            },
          );
          request.on("error", reject);
          request.end();
        });

        assert.equal(body, first + second);
        await delay(10);
      },
    );
  } finally {
    dispose?.();
    if (descriptor === undefined) delete prototype.push;
    else Object.defineProperty(prototype, "push", descriptor);
  }

  assert.ok(pushReturns.includes(false));
  assert.equal(callbackCount, 0);
});

test("an aborted response still emits its original error and never produces a measurement", async () => {
  let callbackCount = 0;

  await withServer(
    async (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sseEvent(chatChunk({ content: "中" })));
      await delay(15);
      response.destroy();
    },
    async (port) => {
      await withInstalledCapture(
        {
          onMeasurement: () => {
            callbackCount += 1;
          },
        },
        async () => {
          const responseError = await new Promise((resolve, reject) => {
            const request = http.request(
              {
                host: "127.0.0.1",
                port,
                headers: {
                  "X-Conversation-ID": "session-abort",
                  "X-Conversation-Message-ID": "message-abort",
                },
              },
              (response) => {
                let error = null;
                response.on("data", () => {});
                response.on("error", (nextError) => {
                  error = nextError;
                });
                response.on("close", () => setImmediate(() => resolve(error)));
              },
            );
            request.on("error", reject);
            request.end();
          });
          assert.ok(responseError);
          assert.equal(responseError.code, "ECONNRESET");
        },
      );
    },
  );

  assert.equal(callbackCount, 0);
});

test("dispose restores only its own wrapper and does not clobber a newer one", () => {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "push");
  const firstDispose = installHttpCapture({ onMeasurement: () => {} });
  const firstWrapper = prototype.push;
  const secondDispose = installHttpCapture({ onMeasurement: () => {} });
  const secondWrapper = prototype.push;

  try {
    assert.notEqual(firstWrapper, secondWrapper);
    firstDispose();
    assert.equal(prototype.push, secondWrapper);
    secondDispose();
    assert.equal(prototype.push, firstWrapper);
    firstDispose();
    assert.equal(prototype.push, firstWrapper);
  } finally {
    if (descriptor === undefined) delete prototype.push;
    else Object.defineProperty(prototype, "push", descriptor);
  }
});

test("missing identity, non-SSE, and compressed responses are not captured", async () => {
  let callbackCount = 0;
  const first = sseEvent(chatChunk({ content: "中" }));
  const second = sseEvent(chatChunk({ content: "中" })) + sseEvent("[DONE]");

  await withServer(
    async (request, response) => {
      if (request.url === "/missing-session") {
        response.writeHead(200, { "content-type": "text/event-stream" });
      } else if (request.url === "/missing-message") {
        response.writeHead(200, { "content-type": "text/event-stream" });
      } else if (request.url === "/json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      } else {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "content-encoding": "gzip",
        });
      }
      response.write(first);
      await delay(10);
      response.end(second);
    },
    async (port) => {
      await withInstalledCapture(
        {
          onMeasurement: () => {
            callbackCount += 1;
          },
        },
        async () => {
          assert.equal(
            await requestBody(
              port,
              {
                "X-Conversation-ID": "session-only",
              },
              "/missing-message",
            ),
            first + second,
          );
          assert.equal(
            await requestBody(
              port,
              {
                "X-Conversation-Message-ID": "message-only",
              },
              "/missing-session",
            ),
            first + second,
          );
          assert.equal(
            await requestBody(
              port,
              {
                "X-Conversation-ID": "session-json",
                "X-Conversation-Message-ID": "message-json",
              },
              "/json",
            ),
            '{"ok":true}',
          );
          assert.equal(
            await requestBody(
              port,
              {
                "X-Conversation-ID": "session-gzip",
                "X-Conversation-Message-ID": "message-gzip",
              },
              "/gzip",
            ),
            first + second,
          );
        },
      );
    },
  );

  assert.equal(callbackCount, 0);
});
