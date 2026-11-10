import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, open, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureUsageSourcePrefix, UsageSourceProof, verifyUsageSourcePrefix } from "../src/usage-source-proof.js";

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "usage-prefix-"));
  const file = path.join(directory, "source.jsonl");
  try {
    await writeFile(file, Buffer.alloc(256 * 1024, 65));
    await run(file, directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("prefix fallback checks every old byte both before and after suffix parsing", async () => {
  await fixture(async (file) => {
    const before = await stat(file);
    const original = await captureUsageSourcePrefix(file, before.size, before);
    await appendFile(file, "new row\n");
    const current = await stat(file);
    const verified = await verifyUsageSourcePrefix(file, original.validation, before.size, current);
    assert.ok(verified);
    assert.equal(verified.readBytes, before.size);
    const next = await captureUsageSourcePrefix(file, current.size, current, verified);
    assert.equal(next.readBytes, current.size);
    assert.equal(
      next.validation.digest,
      createHash("sha256").update(Buffer.alloc(before.size, 65)).update("new row\n").digest("hex"),
    );
  });
});

test("middle overwrite plus append cannot reuse a matching stat/sample hint", async () => {
  await fixture(async (file) => {
    const before = await stat(file);
    const original = await captureUsageSourcePrefix(file, before.size, before);
    const handle = await open(file, "r+");
    try {
      await handle.write(Buffer.from("B"), 0, 1, 128 * 1024);
    } finally {
      await handle.close();
    }
    await appendFile(file, "new row\n");
    await utimes(file, before.atime, before.mtime);
    assert.equal(await verifyUsageSourcePrefix(file, original.validation, before.size, await stat(file)), null);
  });
});

test("initial capture rejects a restored-mtime rewrite since the parser's discovery snapshot", async () => {
  await fixture(async (file) => {
    await utimes(file, 1_700_000_000, 1_700_000_000);
    const before = await stat(file);
    const handle = await open(file, "r+");
    try {
      await handle.write(Buffer.from("B"), 0, 1, 128 * 1024);
    } finally {
      await handle.close();
    }
    await utimes(file, before.atime, before.mtime);
    const current = await stat(file);
    assert.equal(current.size, before.size);
    assert.equal(current.mtimeMs, before.mtimeMs);
    // Windows can retain the same ctime; the digest must bind the bytes actually parsed.
    const parsed = {
      offset: before.size,
      digest: createHash("sha256").update(Buffer.alloc(before.size, 65)).digest("hex"),
    };
    await assert.rejects(captureUsageSourcePrefix(file, before.size, before, null, parsed), {
      code: "LIVE_SOURCE_CHANGED",
    });
  });
});

test("source movement after verification is rejected before cursor capture", async () => {
  await fixture(async (file) => {
    const before = await stat(file);
    const original = await captureUsageSourcePrefix(file, before.size, before);
    const verified = await verifyUsageSourcePrefix(file, original.validation, before.size, before);
    await appendFile(file, "changed\n");
    await assert.rejects(captureUsageSourcePrefix(file, before.size, await stat(file), verified), {
      code: "LIVE_SOURCE_CHANGED",
    });
    await assert.rejects(captureUsageSourcePrefix(file, before.size + 8, before), { code: "LIVE_SOURCE_CHANGED" });
  });
});

test("empty prefixes, incompatible proofs and future bounds fail safely", async () => {
  await fixture(async (file, directory) => {
    const info = await stat(file);
    const empty = await captureUsageSourcePrefix(file, 0, info);
    assert.equal(empty.readBytes, 0);
    assert.ok(await verifyUsageSourcePrefix(file, empty.validation, 0, info));
    assert.equal(await verifyUsageSourcePrefix(file, { ...empty.validation, kind: "unknown" }, 0, info), null);
    assert.equal(await verifyUsageSourcePrefix(file, { ...empty.validation, digest: "broken" }, 0, info), null);
    await assert.rejects(captureUsageSourcePrefix(file, info.size + 1, info), { code: "LIVE_SOURCE_CHANGED" });
    const folder = path.join(directory, "folder");
    await mkdir(folder);
    await assert.rejects(captureUsageSourcePrefix(folder, 0, null), { code: "LIVE_SOURCE_CHANGED" });
  });
});

test("native completion rechecks the current path after the helper releases its file handle", async () => {
  await fixture(async (file, directory) => {
    const info = await stat(file);
    const proof = new UsageSourceProof();
    proof.provider = async () => ({
      advance: async () => {
        await rename(file, path.join(directory, "old.jsonl"));
        await writeFile(file, Buffer.alloc(info.size, 65));
        await utimes(file, info.atime, info.mtime);
        return { validation: { kind: "ntfs-usn-v1" }, readBytes: 0, journalBytes: 1 };
      },
    });
    await assert.rejects(
      proof.capture(file, info.size, info, {
        kind: "ntfs-usn-v1",
        info,
        offset: 0,
      }),
      { code: "LIVE_SOURCE_CHANGED" },
    );
    proof.close();
  });
});

test("invalid parser bounds and digests are never retried by SHA or native capture", async () => {
  await fixture(async (file) => {
    const info = await stat(file);
    const proof = new UsageSourceProof();
    proof.provider = async () => { assert.fail("invalid parser output must not reach the native helper"); };
    const expected = { code: "LIVE_SOURCE_CHANGED", retryable: false };
    for (const [offset, parsed] of [[-1, null], [info.size + 1, null], [0, { offset: 0, digest: "bad" }]]) {
      await assert.rejects(captureUsageSourcePrefix(file, offset, info, null, parsed), expected);
      await assert.rejects(proof.capture(file, offset, info, { kind: "ntfs-usn-v1", info, offset: 0 }, parsed), expected);
    }
    await assert.rejects(captureUsageSourcePrefix(file, 0, info, { info, offset: 1 }), expected);
    await assert.rejects(proof.capture(file, 0, info, { kind: "ntfs-usn-v1", info, offset: 1 }), expected);
    proof.close();
  });
});
