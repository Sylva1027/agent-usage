import fs from "node:fs/promises";
import path from "node:path";
import {pathToFileURL} from "node:url";

const config = JSON.parse(await fs.readFile(process.argv[2], "utf8"));
let closing = false;
let server = null;

function send(message) {
  if (!process.connected || typeof process.send !== "function") return;
  try {
    process.send(message, () => {});
  } catch {
    // The benchmark owns lifecycle cleanup when IPC is unavailable.
  }
}

async function close() {
  if (closing) return;
  closing = true;
  try {
    if (server?.listening) await server.close();
    send({type: "closed", pid: process.pid});
  } catch (error) {
    send({type: "fatal", error: {message: error.message, stack: error.stack}});
  } finally {
    if (process.connected) process.disconnect();
  }
}

process.on("message", (message) => {
  if (message?.type === "close") void close();
});
process.once("disconnect", () => void close());
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());

try {
  const {createUsageServer} = await import(pathToFileURL(path.join(config.sourceRoot, "src/server.js")).href);
  server = createUsageServer({
    ...config.options,
    automaticDiscoveryEnabled: false,
    pricingRefreshSchedulerEnabled: false,
  });
  server.once("error", (error) => {
    send({type: "fatal", error: {message: error.message, stack: error.stack}});
  });
  server.listen(0, "127.0.0.1", () => {
    send({type: "ready", pid: process.pid, port: server.address().port});
  });
} catch (error) {
  send({type: "fatal", error: {message: error.message, stack: error.stack}});
  process.exitCode = 1;
}
