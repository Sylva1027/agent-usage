import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { SourceCollector, loadSources } from "./collector.mjs";
import { InputError, isRecord, validateCommitBody, validateTimestamp } from "./protocol.mjs";
import {
  CursorConflictError,
  LegacySnapshotError,
  SnapshotNotFoundError,
  SqliteStore,
} from "./store.mjs";

const BODY_LIMIT = 64 * 1024 * 1024;
const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJson(request, { required = true } = {}) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > BODY_LIMIT) {
    throw new InputError("request payload exceeds 64 MiB");
  }
  const chunks = [];
  let length = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > BODY_LIMIT) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (tooLarge) {
    throw new InputError("request payload exceeds 64 MiB");
  }
  if (!length) {
    if (required) {
      throw new InputError("request body is empty");
    }
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new InputError(`Invalid JSON: ${error.message}`);
  }
}

function validateFreezeBody(body) {
  if (!isRecord(body) || Object.keys(body).length !== 0) {
    throw new InputError("freeze body must be an empty JSON object");
  }
}

function parseInteger(value, label) {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new InputError(`${label} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new InputError(`${label} exceeds the safe integer range`);
  }
  return parsed;
}

function parseFilters(searchParams) {
  const filters = {};
  const start = searchParams.get("start");
  const end = searchParams.get("end");
  if (start !== null) {
    validateTimestamp(start, "start");
    filters.startMs = Date.parse(start);
  }
  if (end !== null) {
    validateTimestamp(end, "end");
    filters.endMs = Date.parse(end);
  }
  if (filters.startMs !== undefined && filters.endMs !== undefined && filters.startMs > filters.endMs) {
    throw new InputError("start must not be after end");
  }
  const excluded = searchParams
    .getAll("excludeHomes")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (excluded.length) {
    filters.excludeHomes = [...new Set(excluded)];
  }
  const snapshot = searchParams.get("snapshot");
  if (snapshot !== null) {
    filters.snapshot = parseInteger(snapshot, "snapshot");
  }
  return filters;
}

function parseChanges(searchParams) {
  const since = searchParams.get("since");
  const snapshot = searchParams.get("snapshot");
  const contextSince = searchParams.get("contextSince");
  if (since !== null && snapshot !== null) {
    throw new InputError("since and snapshot cannot be combined");
  }
  const options = {};
  if (since !== null) {
    options.since = parseInteger(since, "since");
  }
  if (snapshot !== null) {
    options.snapshot = parseInteger(snapshot, "snapshot");
  }
  if (contextSince !== null) {
    options.contextSince = parseInteger(contextSince, "contextSince");
  }
  return options;
}

function diagnosticPage() {
  return `<!doctype html>
<meta charset="utf-8">
<title>Node SQLite prototype</title>
<body>
<h1>Node SQLite prototype</h1>
<p id="status">Checking local service...</p>
<script>
fetch("/api/status").then((response) => response.json()).then((value) => {
  document.querySelector("#status").textContent =
    "Revision " + value.revision + ", " + value.eventCount + " events";
}).catch((error) => {
  document.querySelector("#status").textContent = error.message;
});
</script>
</body>`;
}

function safeStaticPath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Invalid URL encoding");
  }
  const relative = decoded.replace(/^\/+/, "");
  const candidate = path.resolve(root, relative);
  const prefix = path.resolve(root) + path.sep;
  if (candidate !== path.resolve(root) && !candidate.startsWith(prefix)) {
    throw new HttpError(404, "Not found");
  }
  return candidate;
}

async function serveWeb(response, webPath, pathname) {
  if (!webPath) {
    const body = Buffer.from(diagnosticPage());
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    response.end(body);
    return;
  }

  let filePath;
  const webInfo = await stat(webPath);
  if (webInfo.isDirectory()) {
    filePath = safeStaticPath(webPath, pathname === "/" ? "/index.html" : pathname);
  } else if (pathname === "/") {
    filePath = webPath;
  } else {
    filePath = safeStaticPath(path.dirname(webPath), pathname);
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      throw new HttpError(404, "Not found");
    }
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "content-length": body.length,
      "cache-control": "no-store",
    });
    response.end(body);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new HttpError(404, "Not found");
    }
    throw error;
  }
}

async function handleRequest(request, response, runtime) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const route = url.pathname;

  if (request.method === "GET" && route === "/api/health") {
    sendJson(response, 200, { ok: true, backend: "node-sqlite" });
    return;
  }
  if (request.method === "GET" && route === "/api/status") {
    sendJson(response, 200, runtime.store.status());
    return;
  }
  if (request.method === "GET" && route === "/api/cursors") {
    sendJson(response, 200, runtime.store.cursorState());
    return;
  }
  if (request.method === "GET" && route === "/api/changes") {
    sendJson(response, 200, runtime.store.changes(parseChanges(url.searchParams)));
    return;
  }
  if (request.method === "GET" && route === "/api/report") {
    sendJson(response, 200, runtime.store.report(parseFilters(url.searchParams)));
    return;
  }
  if (request.method === "GET" && route === "/api/query") {
    sendJson(response, 200, runtime.store.query(parseFilters(url.searchParams)));
    return;
  }
  if (request.method === "POST" && route === "/api/commit") {
    const body = validateCommitBody(await readJson(request));
    const commitOptions = Object.hasOwn(body, "expectedCursor")
      ? { expectedCursor: body.expectedCursor }
      : {};
    const result = runtime.store.commit(
      body.sourceId,
      body.events,
      body.cursor,
      body.context,
      commitOptions,
    );
    sendJson(response, 200, result);
    return;
  }
  if (request.method === "POST" && route === "/api/freeze") {
    validateFreezeBody(await readJson(request, { required: false }));
    sendJson(response, 200, { snapshot: runtime.store.freeze() });
    return;
  }
  if (request.method === "GET" && !route.startsWith("/api/")) {
    await serveWeb(response, runtime.webPath, route);
    return;
  }
  throw new HttpError(404, "Not found");
}

function argumentValue(argv, index, name) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new InputError(`${name} requires a value`);
  }
  return value;
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--database") {
      options.database = argumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--port") {
      options.port = parseInteger(argumentValue(argv, index, argument), "port");
      index += 1;
    } else if (argument === "--web") {
      options.web = argumentValue(argv, index, argument);
      index += 1;
    } else if (argument === "--sources") {
      options.sources = argumentValue(argv, index, argument);
      index += 1;
    } else {
      throw new InputError(`Unknown argument: ${argument}`);
    }
  }
  if (!options.database) {
    throw new InputError("--database is required");
  }
  if (options.port === undefined) {
    throw new InputError("--port is required");
  }
  if (options.port > 65_535) {
    throw new InputError("port must be between 0 and 65535");
  }
  return options;
}

export async function startServer({
  database,
  port,
  web,
  sources = [],
  collectorIntervalMs = 2_000,
  onCollectorStatus = () => {},
} = {}) {
  if (!database) {
    throw new InputError("database is required");
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new InputError("port must be between 0 and 65535");
  }

  const databasePath = path.resolve(database);
  await mkdir(path.dirname(databasePath), { recursive: true });
  const store = new SqliteStore(databasePath);
  const webPath = web ? path.resolve(web) : null;
  const collector = sources.length
    ? new SourceCollector({
        store,
        sources,
        intervalMs: collectorIntervalMs,
        onStatus: onCollectorStatus,
      })
    : null;
  const runtime = { store, webPath };
  const server = createServer((request, response) => {
    void handleRequest(request, response, runtime).catch((error) => {
      const status =
        error instanceof CursorConflictError
          ? 409
          : error instanceof LegacySnapshotError
            ? 409
          : error instanceof SnapshotNotFoundError
            ? 404
            : error instanceof HttpError
              ? error.status
              : error instanceof InputError
                ? 400
                : 500;
      if (status === 500) {
        console.error(error);
      }
      if (!response.headersSent) {
        sendJson(
          response,
          status,
          error instanceof LegacySnapshotError
            ? { error: error.message, code: error.code }
            : { error: error.message },
        );
      } else {
        response.destroy();
      }
    });
  });
  server.requestTimeout = 120_000;

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    store.close();
    throw error;
  }

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  collector?.start();

  let closing;
  return {
    server,
    store,
    collector,
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    close() {
      closing ||= (async () => {
        await collector?.stop();
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        store.close();
      })();
      return closing;
    },
  };
}

async function runCli() {
  if (process.argv.includes("--help")) {
    console.log("Usage: node server.mjs --database <path> --port <0-65535> [--web <path>] [--sources <JSON>]");
    return;
  }

  const options = parseArguments(process.argv.slice(2));
  const sources = options.sources ? await loadSources(options.sources) : [];
  let lastFailure = "";
  const runtime = await startServer({
    database: options.database,
    port: options.port,
    web: options.web,
    sources,
    onCollectorStatus(status) {
      if (status.state === "failed" && status.error !== lastFailure) {
        lastFailure = status.error;
        console.error(`[collector] ${status.sourceId}: ${status.error}`);
      } else if (status.state !== "failed") {
        lastFailure = "";
      }
    },
  });

  console.log(JSON.stringify({ port: runtime.port, backend: "node-sqlite" }));
  let stopping = false;
  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    try {
      await runtime.close();
      process.exitCode = 0;
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
