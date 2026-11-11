import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HELPER = path.resolve(
  HERE,
  "../../.codex-usage/rust-integration-20261030/rust-target/release/dsh-rust-helper.exe",
);

let helper = null;
let serialTail = Promise.resolve();
const stats = { spawns: 0, scans: 0, batches: 0, rows: 0, maxBatchRows: 0, outputBytes: 0 };

function unrefStream(stream) {
  stream?.unref?.();
}

function setReferenced(state, referenced) {
  for (const stream of [state.child.stdin, state.child.stdout, state.child.stderr]) {
    if (referenced) stream?.ref?.();
    else unrefStream(stream);
  }
  if (referenced) state.child.ref();
  else state.child.unref();
}

function finishHelper(state, error) {
  if (state.finished) return;
  state.finished = true;
  state.exitError = error ?? new Error("DSH Rust helper exited");
  for (const waiter of state.waiters.splice(0)) waiter.reject(state.exitError);
  if (helper === state) helper = null;
}

function parseMessages(state) {
  while (state.queue.length === 0) {
    const newline = state.buffer.indexOf("\n");
    if (newline < 0) break;
    const line = state.buffer.slice(0, newline).replace(/\r$/, "");
    state.buffer = state.buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      const wrapped = new Error(`invalid DSH Rust helper output: ${error.message}`);
      finishHelper(state, wrapped);
      state.child.kill();
      return;
    }
    const waiter = state.waiters.shift();
    if (waiter) {
      state.child.stdout.pause();
      waiter.resolve(message);
      return;
    }
    state.queue.push(message);
    state.child.stdout.pause();
    return;
  }
}

function ensureHelper() {
  if (helper && !helper.finished) return helper;
  const executable = process.env.DSH_RUST_HELPER || DEFAULT_HELPER;
  const child = spawn(executable, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const state = {
    child,
    buffer: "",
    queue: [],
    waiters: [],
    stderr: "",
    finished: false,
    exitError: null,
  };
  stats.spawns += 1;
  helper = state;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stats.outputBytes += Buffer.byteLength(chunk);
    state.buffer += chunk;
    parseMessages(state);
  });
  child.stderr.on("data", (chunk) => {
    state.stderr = `${state.stderr}${chunk}`.slice(-8192);
  });
  child.stdin.on("error", (error) => {
    finishHelper(state, error);
  });
  child.once("error", (error) => {
    finishHelper(state, error);
  });
  child.once("exit", (code, signal) => {
    const suffix = state.stderr.trim() ? `: ${state.stderr.trim()}` : "";
    finishHelper(
      state,
      new Error(`DSH Rust helper exited (${code ?? signal ?? "unknown"})${suffix}`),
    );
  });
  setReferenced(state, false);
  return state;
}

function nextMessage(state) {
  if (state.queue.length === 0 && !state.finished) {
    parseMessages(state);
    if (state.queue.length === 0 && !state.finished) state.child.stdout.resume();
  }
  if (state.queue.length > 0) {
    const message = state.queue.shift();
    if (state.queue.length === 0) {
      parseMessages(state);
      if (state.queue.length === 0 && !state.finished) state.child.stdout.resume();
    }
    return Promise.resolve(message);
  }
  if (state.finished) return Promise.reject(state.exitError);
  return new Promise((resolve, reject) => {
    state.waiters.push({ resolve, reject });
  });
}

async function writeRequest(state, request) {
  const writable = state.child.stdin;
  if (!writable || writable.destroyed) throw state.exitError ?? new Error("DSH Rust helper stdin is closed");
  const accepted = writable.write(`${JSON.stringify(request)}\n`, "utf8");
  if (accepted) return;
  await new Promise((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      writable.off("drain", onDrain);
      writable.off("error", onError);
    };
    writable.once("drain", onDrain);
    writable.once("error", onError);
  });
}

function abortHelper(state) {
  if (state.finished) return;
  finishHelper(state, new Error("DSH Rust helper request was abandoned"));
  state.child.kill();
}

export function dshRustAdapterStats() {
  return { ...stats };
}

export async function* streamDshRustRows(filePath, { displayPath = filePath, onWarning } = {}) {
  let release;
  const previous = serialTail;
  serialTail = new Promise((resolve) => {
    release = resolve;
  });
  await previous;

  const state = ensureHelper();
  setReferenced(state, true);
  stats.scans += 1;
  let completed = false;
  try {
    await writeRequest(state, { filePath, displayPath });
    while (true) {
      const message = await nextMessage(state);
      if (!message || typeof message !== "object") {
        throw new Error("invalid DSH Rust helper message");
      }
      if (message.kind === "batch") {
        if (!Array.isArray(message.rows)) throw new Error("invalid DSH Rust helper batch");
        stats.batches += 1;
        stats.rows += message.rows.length;
        stats.maxBatchRows = Math.max(stats.maxBatchRows, message.rows.length);
        for (const row of message.rows) yield row;
        continue;
      }
      if (message.kind === "warning") {
        if (typeof message.text === "string") onWarning?.(message.text);
        continue;
      }
      if (message.kind === "error") {
        throw new Error(typeof message.message === "string" ? message.message : "DSH Rust helper failed");
      }
      if (message.kind === "done") {
        completed = true;
        return;
      }
      throw new Error(`unknown DSH Rust helper message kind: ${String(message.kind)}`);
    }
  } finally {
    if (!completed) abortHelper(state);
    if (!state.finished) setReferenced(state, false);
    release();
  }
}

process.once("exit", () => {
  if (helper && !helper.finished) helper.child.kill();
});
