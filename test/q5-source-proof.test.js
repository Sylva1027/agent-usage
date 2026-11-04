import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureUsageSourcePrefix, verifyUsageSourcePrefix } from "../src/usage-source-proof.js";

test("large certified prefixes, a suffix, and an uncommitted tail keep independent byte digests", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "q5-source-proof-"));
  t.after(() => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), "q5-source-proof-")));
    return rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, "source.jsonl"),
    original = Buffer.alloc(2 * 1024 * 1024 + 17, 0x61);
  await writeFile(file, original);
  const captured = await captureUsageSourcePrefix(file, original.length, await stat(file));
  assert.equal(captured.validation.digest, createHash("sha256").update(original).digest("hex"));
  const suffix = Buffer.from("\ncompleted\npartial-tail");
  await appendFile(file, suffix);
  const info = await stat(file),
    verified = await verifyUsageSourcePrefix(file, captured.validation, original.length, info);
  assert.ok(verified);
  assert.equal(verified.readBytes, original.length);
  const bytes = Buffer.concat([original, suffix]),
    offset = original.length + "\ncompleted\n".length;
  const result = await captureUsageSourcePrefix(file, offset, info, verified, {
    offset: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"),
  });
  assert.equal(result.validation.digest, createHash("sha256").update(bytes.subarray(0, offset)).digest("hex"));
  assert.equal(result.readBytes, bytes.length);
  const handle = await open(file, "r+");
  try {
    await handle.write(Buffer.from("rewrite"), 0, 7, 1024 * 1024 - 3);
  } finally {
    await handle.close();
  }
  assert.equal(await verifyUsageSourcePrefix(file, result.validation, offset, await stat(file)), null);
});
