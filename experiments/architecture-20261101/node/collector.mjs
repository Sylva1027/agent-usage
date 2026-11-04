import { createHash } from "node:crypto";
import { createReadStream, watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { openRolloutStream } from "../../../src/codex-rollout.js";
import { streamDshSessionEvents, streamDshSessionRows } from "../../../src/dsh-usage.js";
import { parseSessionFile } from "../../../src/usage-core.js";
import { InputError, isRecord, validateEvents, validateSourceId } from "./protocol.mjs";

export class SourceValidationError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "SourceValidationError";
  }
}

const backendCommitQueues = new Map();

function serializeBackendSource(key, task) {
  const previous = backendCommitQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  backendCommitQueues.set(key, current);
  return current.finally(() => {
    if (backendCommitQueues.get(key) === current) {
      backendCommitQueues.delete(key);
    }
  });
}

function sameCursor(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

async function readBackendCursors(baseUrl, fetchImpl) {
  const response = await fetchImpl(new URL("/api/cursors", baseUrl), {
    headers: { accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new SourceValidationError(
      `Cannot read backend cursor (${response.status}): ${
        payload ? JSON.stringify(payload) : "invalid JSON response"
      }`,
    );
  }
  if (
    !isRecord(payload) ||
    !Number.isSafeInteger(payload.revision) ||
    payload.revision < 0 ||
    !isRecord(payload.cursors)
  ) {
    throw new SourceValidationError("Backend cursor response is invalid");
  }
  return payload;
}

function requireText(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InputError(`${label} must be a non-empty string`);
  }
  return value;
}

export function validateSourceConfig(input, baseDirectory = process.cwd()) {
  if (!isRecord(input)) {
    throw new InputError("source config must be an object");
  }
  const sourceId = validateSourceId(input.sourceId);
  if (input.kind !== "codex" && input.kind !== "dsh") {
    throw new InputError("source kind must be codex or dsh");
  }
  const sourcePath = requireText(input.path, "source path");
  if (!isRecord(input.home)) {
    throw new InputError("source home must be an object");
  }
  const home = {
    id: requireText(input.home.id, "home.id"),
    label: requireText(input.home.label, "home.label"),
    path: path.resolve(baseDirectory, requireText(input.home.path, "home.path")),
    kind: requireText(input.home.kind, "home.kind"),
  };
  return {
    sourceId,
    kind: input.kind,
    path: path.resolve(baseDirectory, sourcePath),
    home,
  };
}

export function normalizeSourceConfigs(inputs, baseDirectory = process.cwd()) {
  if (!Array.isArray(inputs)) {
    throw new InputError("sources must be an array");
  }
  const sources = inputs.map((source) => validateSourceConfig(source, baseDirectory));
  const ids = new Set();
  for (const source of sources) {
    if (ids.has(source.sourceId)) {
      throw new InputError(`duplicate sourceId: ${source.sourceId}`);
    }
    ids.add(source.sourceId);
  }
  return sources;
}

export async function loadSources(filePath) {
  const resolved = path.resolve(filePath);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(resolved, "utf8"));
  } catch (error) {
    throw new InputError(`Cannot read source config ${resolved}: ${error.message}`);
  }
  const inputs = Array.isArray(parsed) ? parsed : parsed?.sources;
  return normalizeSourceConfigs(inputs, path.dirname(resolved));
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { sha256: hash.digest("hex"), size };
}

async function validateCodexLines(filePath) {
  const input = openRolloutStream(filePath).setEncoding("utf8");
  let fragment = "";
  let lastCharacter = "";
  let lineNumber = 0;

  try {
    for await (const chunk of input) {
      if (chunk.length) {
        lastCharacter = chunk.at(-1);
      }
      let from = 0;
      for (let newline = chunk.indexOf("\n"); newline !== -1; newline = chunk.indexOf("\n", from)) {
        lineNumber += 1;
        const line = fragment + chunk.slice(from, newline);
        fragment = "";
        from = newline + 1;
        if (!line.trim()) {
          continue;
        }
        try {
          JSON.parse(line);
        } catch (error) {
          throw new SourceValidationError(`Codex line ${lineNumber} is not complete JSON: ${error.message}`);
        }
      }
      fragment += chunk.slice(from);
    }
  } finally {
    input.destroy();
  }

  if (lastCharacter !== "\n") {
    throw new SourceValidationError("Codex source must end with a complete newline-terminated line");
  }
  if (fragment.trim()) {
    throw new SourceValidationError(`Codex line ${lineNumber + 1} is incomplete`);
  }
}

async function hasDshHeader(filePath) {
  for await (const row of streamDshSessionRows(filePath, {
    projectRow: (value) => (value?.type === "session" ? value : null),
  })) {
    return true;
  }
  return false;
}

function normalizeEvents(events, sourceId) {
  const normalized = events.map((event) => ({
    ...event,
    eventId: event.eventId || event.id,
    total: event.total || event.usage,
  }));
  validateEvents(normalized, sourceId);
  return normalized;
}

async function parseSource(config) {
  const warnings = [];
  const events = [];
  const parserHome = {
    id: config.home.id,
    label: config.home.label,
    path: config.home.path,
    kind: config.home.kind,
  };

  if (config.kind === "codex") {
    await validateCodexLines(config.path);
    const parsed = await parseSessionFile(config.path, parserHome, {
      onWarning: (warning) => warnings.push(String(warning)),
    });
    events.push(...(parsed?.events || []));
  } else {
    if (!(await hasDshHeader(config.path))) {
      throw new SourceValidationError("DSH source has no session header");
    }
    await streamDshSessionEvents(
      config.path,
      parserHome,
      (event) => events.push(event),
      { onWarning: (warning) => warnings.push(String(warning)) },
    );
  }

  if (warnings.length) {
    throw new SourceValidationError(`Source validation warnings: ${warnings.join(" | ")}`);
  }
  return normalizeEvents(events, config.sourceId);
}

/**
 * Fully validate and parse one Codex or DSH source without committing it.
 * The returned cursor is safe to pass to any backend's atomic commit endpoint.
 */
export async function collectSource(input, options = {}) {
  const config = validateSourceConfig(input, options.baseDirectory);
  const attempts = options.attempts ?? 3;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = await hashFile(config.path);
    if (
      options.previousCursor?.sha256 === before.sha256 &&
      options.previousCursor?.path === config.path &&
      options.previousCursor?.kind === config.kind
    ) {
      const after = await hashFile(config.path);
      if (before.sha256 === after.sha256) {
        const info = await stat(config.path);
        return {
          sourceId: config.sourceId,
          unchanged: true,
          events: [],
          cursor: {
            sha256: after.sha256,
            size: info.size,
            mtimeMs: info.mtimeMs,
            path: config.path,
            kind: config.kind,
          },
        };
      }
      lastError = new SourceValidationError("Source changed while its full content hash was being checked");
      continue;
    }

    let events;
    try {
      events = await parseSource(config);
    } catch (error) {
      if (error instanceof InputError || error instanceof SourceValidationError) {
        throw error;
      }
      throw new SourceValidationError(`Cannot collect ${config.path}: ${error.message}`, { cause: error });
    }

    const after = await hashFile(config.path);
    if (before.sha256 !== after.sha256) {
      lastError = new SourceValidationError("Source changed while it was being parsed");
      continue;
    }
    const info = await stat(config.path);
    return {
      sourceId: config.sourceId,
      unchanged: false,
      events,
      cursor: {
        sha256: after.sha256,
        size: info.size,
        mtimeMs: info.mtimeMs,
        path: config.path,
        kind: config.kind,
      },
    };
  }

  throw lastError || new SourceValidationError("Source did not become stable");
}

/**
 * Parse and atomically commit one source through the shared HTTP contract.
 * This entry point is backend-independent and intended for native parity runs.
 */
export async function collectAndCommit(baseUrl, config, options = {}) {
  const normalized = validateSourceConfig(config, options.baseDirectory);
  const fetchImpl = options.fetch || fetch;
  const maxAttempts = options.concurrencyAttempts ?? 3;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new InputError("concurrencyAttempts must be a positive safe integer");
  }
  const backendOrigin = new URL(baseUrl).origin;

  return serializeBackendSource(`${backendOrigin}\0${normalized.sourceId}`, async () => {
    const backend = await readBackendCursors(baseUrl, fetchImpl);
    let previousCursor = backend.cursors[normalized.sourceId] ?? null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const collected = await collectSource(normalized, {
        ...options,
        previousCursor,
      });
      const latest = await readBackendCursors(baseUrl, fetchImpl);
      const latestCursor = latest.cursors[normalized.sourceId] ?? null;
      if (!sameCursor(previousCursor, latestCursor)) {
        previousCursor = latestCursor;
        continue;
      }

      if (collected.unchanged) {
        return {
          ...collected,
          revision: latest.revision,
          eventCount: 0,
        };
      }

      const endpoint = new URL("/api/commit", baseUrl);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId: collected.sourceId,
          events: collected.events,
          cursor: collected.cursor,
          expectedCursor: previousCursor,
          ...(options.context !== undefined ? { context: options.context } : {}),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 409) {
        if (attempt + 1 >= maxAttempts) {
          throw new SourceValidationError(
            `Backend source ${normalized.sourceId} changed during commit; retry limit exhausted`,
          );
        }
        const refreshed = await readBackendCursors(baseUrl, fetchImpl);
        previousCursor = refreshed.cursors[normalized.sourceId] ?? null;
        continue;
      }
      if (!response.ok) {
        throw new SourceValidationError(
          `Commit failed (${response.status}): ${payload ? JSON.stringify(payload) : "invalid JSON response"}`,
        );
      }
      return { ...payload, cursor: collected.cursor };
    }

    throw new SourceValidationError(
      `Backend source ${normalized.sourceId} kept changing during collection; retry limit exhausted`,
    );
  });
}

export class SourceCollector {
  constructor({ store, sources, intervalMs = 2_000, useWatcher = true, onStatus = () => {} }) {
    if (!store || typeof store.commit !== "function" || typeof store.getCursor !== "function") {
      throw new InputError("store must provide commit and getCursor");
    }
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new InputError("intervalMs must be a positive safe integer");
    }
    this.store = store;
    this.sources = normalizeSourceConfigs(sources);
    this.intervalMs = intervalMs;
    this.useWatcher = useWatcher;
    this.onStatus = onStatus;
    this.watchers = new Map();
    this.inFlight = new Map();
    this.dirty = new Set();
    this.statuses = new Map();
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.timer = setInterval(() => void this.checkAll(), this.intervalMs);
    if (this.useWatcher) {
      for (const source of this.sources) {
        try {
          const watcher = watch(path.dirname(source.path), { persistent: true }, (_event, filename) => {
            if (!filename || path.basename(source.path) === String(filename)) {
              void this.checkSource(source.sourceId);
            }
          });
          watcher.on("error", (error) => this.#recordFailure(source.sourceId, error));
          this.watchers.set(source.sourceId, watcher);
        } catch (error) {
          this.#recordFailure(source.sourceId, error);
        }
      }
    }
    void this.checkAll();
  }

  async stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    await Promise.allSettled(this.inFlight.values());
  }

  statusesSnapshot() {
    return Object.fromEntries(this.statuses);
  }

  checkAll() {
    return Promise.all(this.sources.map((source) => this.checkSource(source.sourceId)));
  }

  checkSource(sourceId) {
    const existing = this.inFlight.get(sourceId);
    if (existing) {
      this.dirty.add(sourceId);
      return existing;
    }

    const source = this.sources.find((entry) => entry.sourceId === sourceId);
    if (!source) {
      return Promise.reject(new InputError(`Unknown source ${sourceId}`));
    }

    const run = (async () => {
      do {
        this.dirty.delete(sourceId);
        await this.#checkOnce(source);
      } while (this.dirty.has(sourceId) && this.running);
      return this.statuses.get(sourceId);
    })();
    this.inFlight.set(sourceId, run);
    void run.finally(() => this.inFlight.delete(sourceId));
    return run;
  }

  async #checkOnce(source) {
    this.statuses.set(source.sourceId, {
      ...(this.statuses.get(source.sourceId) || {}),
      sourceId: source.sourceId,
      state: "checking",
    });
    try {
      const previousCursor = this.store.getCursor(source.sourceId);
      const collected = await collectSource(source, {
        previousCursor,
      });
      if (collected.unchanged) {
        const status = {
          sourceId: source.sourceId,
          state: "unchanged",
          eventCount: 0,
          cursor: collected.cursor,
        };
        this.statuses.set(source.sourceId, status);
        this.onStatus(status);
        return;
      }
      const committed = this.store.commit(
        source.sourceId,
        collected.events,
        collected.cursor,
        undefined,
        { expectedCursor: previousCursor },
      );
      const status = {
        sourceId: source.sourceId,
        state: "committed",
        revision: committed.revision,
        eventCount: committed.eventCount,
        cursor: collected.cursor,
      };
      this.statuses.set(source.sourceId, status);
      this.onStatus(status);
    } catch (error) {
      this.#recordFailure(source.sourceId, error);
    }
  }

  #recordFailure(sourceId, error) {
    const status = {
      ...(this.statuses.get(sourceId) || { sourceId }),
      sourceId,
      state: "failed",
      error: error.message,
    };
    this.statuses.set(sourceId, status);
    this.onStatus(status);
  }
}
