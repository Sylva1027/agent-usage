import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { listenOnFetchPort } from "../test-support/fetch-port.mjs";

const close = (server) => new Promise((resolve) => server.close(resolve));

test("fetch port retries an occupied port and serves HTTP without leaking listeners", async (t) => {
  const occupied = createServer();
  const server = createServer((_request, response) => response.end("ok"));
  const originalListeningListeners = server.listeners("listening");
  try {
    await listenOnFetchPort(occupied);
    const occupiedPort = occupied.address().port;
    const random = Math.random;
    let picks = 0;
    const picker = t.mock.method(Math, "random", () =>
      picks++ === 0 ? (occupiedPort - 20_000 + 0.5) / 10_000 : random(),
    );
    await listenOnFetchPort(server);
    picker.mock.restore();
    const { port } = server.address();
    assert.ok(picks >= 2);
    assert.notEqual(port, occupiedPort);
    assert.ok(port >= 20_000 && port < 30_000);
    assert.equal(await fetch(`http://127.0.0.1:${port}`).then((response) => response.text()), "ok");
    assert.equal(server.listenerCount("error"), 0);
    assert.deepEqual(server.listeners("listening"), originalListeningListeners);
  } finally {
    await Promise.all([close(server), close(occupied)]);
  }
  assert.equal(server.listening, false);
  assert.equal(occupied.listening, false);
});

for (const { name, code, synchronous, attempts } of [
  { name: "synchronous failure", code: "ERR_INVALID_ARG_VALUE", synchronous: true, attempts: 1 },
  { name: "asynchronous failure", code: "EACCES", synchronous: false, attempts: 1 },
  { name: "exhausted port conflicts", code: "EADDRINUSE", synchronous: false, attempts: 21 },
]) {
  test(`fetch port cleans listeners and permits closing after ${name}`, async (t) => {
    const server = createServer();
    const originalListeningListeners = server.listeners("listening");
    const failure = Object.assign(new Error(name), { code });
    const originalErrorListener = () => {};
    server.on("error", originalErrorListener);
    const listen = t.mock.method(server, "listen", () => {
      if (synchronous) throw failure;
      queueMicrotask(() => server.emit("error", failure));
      return server;
    });
    let closed = false;
    server.once("close", () => {
      closed = true;
    });
    try {
      await assert.rejects(listenOnFetchPort(server), (error) => error === failure);
      assert.equal(listen.mock.callCount(), attempts);
      assert.deepEqual(server.listeners("error"), [originalErrorListener]);
      assert.deepEqual(server.listeners("listening"), originalListeningListeners);
    } finally {
      await close(server);
    }
    assert.equal(closed, true);
    assert.equal(server.address(), null);
  });
}
