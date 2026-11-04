import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";

const KIND = "ntfs-usn-v1";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TOKEN_BYTES = 512;
const FIXED_TIMEOUT_MS = 3_000;
const MODULE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const RESPONSE_DECODER = new TextDecoder("utf-8", { fatal: true });

function candidateExecutables() {
  return [
    path.resolve(MODULE_DIRECTORY, "../native/windows-source-proof/bin/windows-source-proof.exe"),
    path.resolve(MODULE_DIRECTORY, "../native/windows-source-proof/target/release/windows-source-proof.exe"),
  ];
}

function executablePath(explicitPath) {
  if (explicitPath !== undefined) return path.resolve(explicitPath);
  return candidateExecutables().find((candidate) => existsSync(candidate)) || candidateExecutables()[0];
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function bigintValue(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return null;
}

function expectedMatches(exactInfo, displayInfo, expectedInfo) {
  if (!expectedInfo || typeof expectedInfo !== "object") return false;
  const size = bigintValue(expectedInfo.size);
  if (size === null || size !== exactInfo.size) return false;
  const expectedMtimeNs = bigintValue(expectedInfo.mtimeNs);
  if (expectedMtimeNs !== null) return expectedMtimeNs === exactInfo.mtimeNs;
  return typeof expectedInfo.mtimeMs === "number" && expectedInfo.mtimeMs === displayInfo.mtimeMs;
}

async function captureExpected(filePath, expectedInfo) {
  const [exactInfo, displayInfo] = await Promise.all([stat(filePath, { bigint: true }), stat(filePath)]);
  if (!exactInfo.isFile() || !displayInfo.isFile() || !expectedMatches(exactInfo, displayInfo, expectedInfo)) {
    return null;
  }
  return {
    info: displayInfo,
    expected: {
      size: exactInfo.size.toString(),
      mtimeNs: exactInfo.mtimeNs.toString(),
    },
  };
}

function validToken(token, offset) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_BYTES) return false;
  const fields = token.split(":");
  if (fields.length !== 9 || fields[0] !== KIND) return false;
  if (!/^[0-9a-f]{1,16}$/i.test(fields[1]) || !/^[0-9a-f]{1,16}$/i.test(fields[2])) return false;
  if (!/^[0-9a-f]{16}$/i.test(fields[3]) || !/^[0-9a-f]{32}$/i.test(fields[4])) return false;
  if (!/^[0-9a-f]{16}$/i.test(fields[5])) return false;
  if (!/^[0-9a-f]{1,16}$/i.test(fields[6]) || BigInt(`0x${fields[6]}`) !== BigInt(offset)) return false;
  return (
    BigInt(`0x${fields[1]}`) !== 0n &&
    BigInt(`0x${fields[2]}`) !== 0n &&
    /^[0-9a-f]{1,16}$/i.test(fields[7]) &&
    /^[0-9a-f]{1,16}$/i.test(fields[8])
  );
}

function proofResult(response, offset, info, includeKind) {
  if (
    response?.ok !== true ||
    response.available !== true ||
    response.kind !== KIND ||
    response.offset !== offset ||
    !Number.isSafeInteger(response.journalBytes) ||
    response.journalBytes < 0 ||
    !validToken(response.token, offset)
  ) {
    return null;
  }
  const validation = { kind: KIND, offset, token: response.token };
  const result = { validation, readBytes: 0, journalBytes: response.journalBytes };
  return includeKind ? { kind: KIND, offset, ...result, info } : result;
}

/**
 * One lazily-started helper is intended per writer. Create a new instance after
 * close(); malformed helper protocol disables the instance rather than retrying.
 */
export class WindowsSourceProof {
  #executablePath;
  #child = null;
  #buffer = Buffer.alloc(0);
  #pending = null;
  #nextRequestId = 1;
  #tail = Promise.resolve();
  #disabled = false;
  #closed = false;

  constructor(internalExecutablePath) {
    this.#executablePath = executablePath(internalExecutablePath);
  }

  async begin(filePath, offset, expectedInfo) {
    return this.#schedule(async () => {
      if (!safeInteger(offset) || offset !== 0) return null;
      const resolved = path.resolve(filePath);
      const captured = await captureExpected(resolved, expectedInfo);
      if (!captured) return null;
      const response = await this.#request({
        op: "begin",
        path: resolved,
        offset,
        expected: captured.expected,
      });
      return proofResult(response, offset, captured.info, true);
    });
  }

  async verify(filePath, validation, offset, expectedInfo) {
    return this.#schedule(async () => {
      if (
        !safeInteger(offset) ||
        validation?.kind !== KIND ||
        validation.offset !== offset ||
        !validToken(validation.token, offset)
      ) {
        return null;
      }
      const resolved = path.resolve(filePath);
      const captured = await captureExpected(resolved, expectedInfo);
      if (!captured) return null;
      const response = await this.#request({
        op: "verify",
        path: resolved,
        offset,
        expected: captured.expected,
        token: validation.token,
      });
      return proofResult(response, offset, captured.info, true);
    });
  }

  async advance(filePath, verified, newOffset, expectedInfo) {
    return this.#schedule(async () => {
      if (
        !safeInteger(newOffset) ||
        verified?.kind !== KIND ||
        verified.offset > newOffset ||
        !validToken(verified.validation?.token, verified.offset)
      ) {
        return null;
      }
      const resolved = path.resolve(filePath);
      const captured = await captureExpected(resolved, expectedInfo);
      if (!captured || newOffset > BigInt(captured.expected.size)) return null;
      const response = await this.#request({
        op: "advance",
        path: resolved,
        offset: newOffset,
        expected: captured.expected,
        token: verified.validation.token,
      });
      return proofResult(response, newOffset, captured.info, false);
    });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failPending(Object.assign(new Error("native source proof closed"), { code: "NATIVE_PROOF_CLOSED" }));
    this.#stopChild();
  }

  #schedule(operation) {
    if (this.#closed || this.#disabled || process.platform !== "win32") return Promise.resolve(null);
    const task = this.#tail.then(() => {
      if (this.#closed || this.#disabled || process.platform !== "win32") return null;
      return operation();
    });
    this.#tail = task.then(
      () => null,
      () => null,
    );
    return task.catch(() => null);
  }

  #start() {
    const executable = this.#executablePath;
    const isJavaScriptHelper = /\.(?:cjs|mjs|js)$/i.test(executable);
    const command = isJavaScriptHelper ? process.execPath : executable;
    const args = isJavaScriptHelper ? [executable] : [];
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    this.#buffer = Buffer.alloc(0);

    child.stdout.on("data", (chunk) => this.#onData(chunk));
    child.stderr.on("data", () => {});
    child.on("error", () => this.#failProtocol());
    child.on("exit", () => {
      if (this.#child !== child) return;
      this.#child = null;
      if (!this.#closed) this.#failProtocol();
    });
  }

  #onData(chunk) {
    if (this.#buffer.length + chunk.length > MAX_RESPONSE_BYTES) {
      this.#failProtocol();
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const lineEnd = this.#buffer.indexOf(0x0a);
    if (lineEnd < 0) return;
    const line = this.#buffer.slice(0, lineEnd);
    this.#buffer = this.#buffer.slice(lineEnd + 1);
    if (this.#buffer.length > 0) {
      this.#failProtocol();
      return;
    }
    let response;
    try {
      response = JSON.parse(RESPONSE_DECODER.decode(line));
    } catch {
      this.#failProtocol();
      return;
    }
    const pending = this.#pending;
    if (!pending || response?.id !== pending.id) {
      this.#failProtocol();
      return;
    }
    clearTimeout(pending.timer);
    this.#pending = null;
    pending.resolve(response);
  }

  async #request(payload) {
    if (this.#closed || this.#disabled || process.platform !== "win32") return null;
    if (!this.#child) this.#start();
    const child = this.#child;
    if (!child?.stdin.writable) return null;
    const id = this.#nextRequestId++;
    const frame = `${JSON.stringify({ id, ...payload })}\n`;
    if (Buffer.byteLength(frame) > 128 * 1024) return null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#failProtocol(), FIXED_TIMEOUT_MS);
      this.#pending = { id, resolve, timer };
      child.stdin.write(frame, (error) => {
        if (error) this.#failProtocol();
      });
    }).catch(() => null);
  }

  #failPending(error = new Error("native source proof unavailable")) {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    clearTimeout(pending.timer);
    pending.resolve(null);
    void error;
  }

  #failProtocol() {
    this.#disabled = true;
    this.#failPending();
    this.#stopChild();
  }

  #stopChild() {
    const child = this.#child;
    this.#child = null;
    if (child && !child.killed) child.kill();
  }
}
