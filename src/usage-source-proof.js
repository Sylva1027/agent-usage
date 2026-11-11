import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";

const CHUNK_BYTES = 1024 * 1024;
export const USAGE_SOURCE_SHA_KIND = "sha256-prefix-v2";
const SHA_KIND = USAGE_SOURCE_SHA_KIND;

function changed(message, retryable = true) {
  return Object.assign(new Error(message), { code: "LIVE_SOURCE_CHANGED", retryable });
}

export function usageSourceIdentity(info) {
  return JSON.stringify([String(info.dev), String(info.ino), info.birthtimeMs]);
}
const identity = usageSourceIdentity;

function sameSnapshot(left, right) {
  return (
    identity(left) === identity(right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function assertExpected(info, expected) {
  if (
    expected &&
    (info.size !== expected.size ||
      info.mtimeMs !== expected.mtimeMs ||
      (Number.isFinite(expected.ctimeMs) && info.ctimeMs !== expected.ctimeMs))
  ) {
    throw changed("Source changed after discovery");
  }
}

async function hashRange(handle, hash, start, end) {
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let at = start;
  while (at < end) {
    const length = Math.min(buffer.length, end - at);
    const { bytesRead } = await handle.read(buffer, 0, length, at);
    if (!bytesRead) throw changed("Source ended during prefix verification");
    hash.update(buffer.subarray(0, bytesRead));
    at += bytesRead;
  }
  return at - start;
}

async function withSnapshot(filePath, expected, work) {
  const handle = await open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || !Number.isSafeInteger(before.size)) throw changed("Unsupported source file size", false);
    assertExpected(before, expected);
    const result = await work(handle, before);
    const after = await handle.stat();
    const currentPath = await stat(filePath);
    if (!sameSnapshot(before, after) || !sameSnapshot(before, currentPath)) {
      throw changed("Source changed during prefix verification");
    }
    return result;
  } finally {
    await handle.close();
  }
}

/** Full prefix verification is the safe fallback; its I/O grows with prefix size. */
export async function verifyUsageSourcePrefix(filePath, validation, offset, expectedInfo) {
  if (
    validation?.kind !== SHA_KIND ||
    validation.offset !== offset ||
    !/^[a-f0-9]{64}$/.test(validation.digest || "") ||
    typeof validation.identity !== "string"
  )
    return null;
  return withSnapshot(filePath, expectedInfo, async (handle, info) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > info.size || validation.identity !== identity(info)) {
      return null;
    }
    const hash = createHash("sha256");
    const readBytes = await hashRange(handle, hash, 0, offset);
    if (hash.copy().digest("hex") !== validation.digest) return null;
    return { kind: SHA_KIND, hash, offset, identity: identity(info), info, readBytes };
  });
}

/** Recheck the certified prefix after parsing; a hash state alone cannot protect the intervening await. */
export async function captureUsageSourcePrefix(filePath, offset, expectedInfo, verified = null, parsed = null) {
  return withSnapshot(filePath, expectedInfo, async (handle, info) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > info.size || (verified && verified.offset > offset)) {
      throw changed("Parsed source boundary is outside the current file", false);
    }
    if (verified && !sameSnapshot(verified.info, info)) {
      throw changed("Source changed after prefix validation");
    }
    const hash = createHash("sha256");
    let readBytes = 0;
    if (verified) {
      readBytes += await hashRange(handle, hash, 0, verified.offset);
      if (hash.copy().digest("hex") !== verified.hash.copy().digest("hex")) {
        throw changed("Certified prefix changed during suffix parsing");
      }
    }
    readBytes += await hashRange(handle, hash, verified?.offset || 0, offset);
    if (parsed) {
      if (
        !Number.isSafeInteger(parsed.offset) ||
        parsed.offset < offset ||
        parsed.offset > info.size ||
        !/^[a-f0-9]{64}$/.test(parsed.digest || "")
      )
        throw changed("Invalid parsed source digest", false);
      const parsedHash = hash.copy();
      readBytes += await hashRange(handle, parsedHash, offset, parsed.offset);
      if (parsedHash.digest("hex") !== parsed.digest) throw changed("Source bytes changed after parsing");
    }
    return {
      validation: {
        kind: SHA_KIND,
        offset,
        digest: hash.digest("hex"),
        identity: identity(info),
        ctimeMs: info.ctimeMs,
      },
      readBytes,
    };
  });
}

/** One lazy native helper belongs to the writer; unsupported sources retain full-prefix verification. */
export class UsageSourceProof {
  constructor() {
    this.native = null;
    this.nativePromise = null;
    this.closed = false;
  }

  async provider() {
    if (this.closed || process.platform !== "win32") return null;
    this.nativePromise ||= import("./usage-source-native.js")
      .then(({ WindowsSourceProof }) => {
        if (this.closed) return null;
        this.native = new WindowsSourceProof();
        return this.native;
      })
      .catch(() => null);
    return this.nativePromise;
  }

  async begin(filePath, expectedInfo) {
    const native = await this.provider();
    return (await native?.begin(filePath, 0, expectedInfo)) || null;
  }

  async verify(filePath, validation, offset, expectedInfo) {
    if (validation?.kind === "ntfs-usn-v1") {
      const native = await this.provider();
      return (await native?.verify(filePath, validation, offset, expectedInfo)) || null;
    }
    if (validation?.kind !== SHA_KIND) return null;
    const fence = await this.begin(filePath, expectedInfo);
    const verified = await verifyUsageSourcePrefix(filePath, validation, offset, expectedInfo);
    return verified ? { ...verified, nativeFence: fence } : null;
  }

  async capture(filePath, offset, expectedInfo, verified = null, parsed = null) {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (Number.isSafeInteger(expectedInfo?.size) && offset > expectedInfo.size) ||
      (Number.isSafeInteger(verified?.offset) && verified.offset > offset)
    )
      throw changed("Parsed source boundary is outside the current file", false);
    if (
      parsed &&
      (!Number.isSafeInteger(parsed.offset) ||
        parsed.offset < offset ||
        (Number.isSafeInteger(expectedInfo?.size) && parsed.offset > expectedInfo.size) ||
        !/^[a-f0-9]{64}$/.test(parsed.digest || ""))
    )
      throw changed("Invalid parsed source digest", false);
    const fence = verified?.kind === "ntfs-usn-v1" ? verified : verified?.nativeFence;
    if (fence) {
      const native = await this.provider();
      const result = await native?.advance(filePath, fence, offset, expectedInfo);
      if (!result) throw changed("Source proof could not be completed after parsing");
      const current = await stat(filePath);
      assertExpected(current, expectedInfo);
      if (identity(current) !== identity(fence.info)) throw changed("Source path changed after native verification");
      return { ...result, validation: { ...result.validation, identity: identity(current), ctimeMs: current.ctimeMs } };
    }
    return captureUsageSourcePrefix(filePath, offset, expectedInfo, verified, parsed);
  }

  close() {
    this.closed = true;
    this.native?.close();
    this.native = null;
  }
}
