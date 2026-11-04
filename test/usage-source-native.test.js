import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { WindowsSourceProof } from "../src/usage-source-native.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nativeExecutable = [
  path.join(projectRoot, "native/windows-source-proof/bin/windows-source-proof.exe"),
  path.join(projectRoot, "native/windows-source-proof/target/release/windows-source-proof.exe"),
].find(existsSync);
const nativeAvailable = process.platform === "win32" && Boolean(nativeExecutable);

const writerSource = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
const file = process.argv[1];
const handle = fs.openSync(file, "r+");
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function append(hex) {
  fs.writeSync(handle, Buffer.from(hex, "hex"), 0, Buffer.from(hex, "hex").length, fs.fstatSync(handle).size);
  fs.fsyncSync(handle);
}
function overwrite(hex, offset) {
  const bytes = Buffer.from(hex, "hex");
  fs.writeSync(handle, bytes, 0, bytes.length, offset);
}
input.on("line", line => {
  try {
    const command = JSON.parse(line);
    if (command.op === "append") append(command.data);
    else if (command.op === "mixed") {
      overwrite(command.overwrite, command.offset);
      append(command.append);
    } else if (command.op === "truncate") {
      fs.ftruncateSync(handle, command.size);
      fs.fsyncSync(handle);
    } else if (command.op === "close") {
      fs.closeSync(handle);
      process.stdout.write("closed\n");
      process.exit(0);
    } else throw new Error("unknown writer command");
    process.stdout.write("ok\n");
  } catch (error) {
    process.stderr.write(String(error));
    process.exit(1);
  }
});
process.stdout.write("ready\n");
`;

async function fixture(run, root = tmpdir()) {
  const directory = await mkdtemp(path.join(root, "usage-native-w3-"));
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(directory);
  if (!resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("fixture escaped temp root");
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function patterns(seed, length) {
  const bytes = Buffer.alloc(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[index] = state >>> 24;
  }
  return bytes;
}

function oracle(bytes) {
  return {
    length: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function reportProof(label, proof) {
  const fields = proof?.validation?.token?.split(":");
  console.log(
    `W3_OBSERVATION ${JSON.stringify({
      label,
      available: Boolean(proof),
      journalBytes: proof?.journalBytes ?? null,
      journalId: fields?.[1] ?? null,
      sealUsn: fields?.[2] ?? null,
    })}`,
  );
}

async function exactInfo(filePath) {
  return stat(filePath, { bigint: true });
}

async function startWriter(filePath) {
  const child = spawn(process.execPath, ["-e", writerSource, filePath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = "";
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      waiters.shift()?.(line);
    }
  });
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const nextLine = () =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`writer timeout: ${stderr}`)), 10_000);
      waiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  assert.equal(await nextLine(), "ready");
  return {
    async command(value) {
      child.stdin.write(`${JSON.stringify(value)}\n`);
      assert.equal(await nextLine(), "ok");
    },
    async close() {
      const exited = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}: ${stderr}`))));
      });
      child.stdin.write(`${JSON.stringify({ op: "close" })}\n`);
      assert.equal(await nextLine(), "closed");
      await exited;
    },
    kill() {
      child.kill();
    },
  };
}

async function protocolHelper(directory, name, source) {
  const helper = path.join(directory, `${name}.js`);
  await writeFile(helper, source);
  return helper;
}

test("native proof survives repeated appends and is unavailable for unsafe mutations", {
  skip: !nativeAvailable,
  timeout: 60_000,
}, async () => {
  await fixture(
    async (directory) => {
      const originalPath = path.join(directory, "source.jsonl");
      const renamedPath = path.join(directory, "renamed.jsonl");
      let expectedBytes = patterns(1, 4096);
      await writeFile(originalPath, expectedBytes);
      const writer = await startWriter(originalPath);
      let proof = new WindowsSourceProof();
      try {
        const initialInfo = await exactInfo(originalPath);
        let baseline = await proof.begin(originalPath, 0, initialInfo);
        assert.ok(baseline);
        assert.equal(baseline.kind, "ntfs-usn-v1");
        assert.equal(baseline.offset, 0);
        assert.equal(baseline.readBytes, 0);
        assert.ok(baseline.journalBytes > 0);
        assert.deepEqual(oracle(expectedBytes), oracle(await readFile(originalPath)));
        const originalIdentity = baseline.validation.token.split(":")[4];
        reportProof("baseline", baseline);

        const unchanged = await proof.advance(originalPath, baseline, 0, initialInfo);
        assert.ok(unchanged);
        assert.equal(unchanged.readBytes, 0);
        assert.ok(unchanged.journalBytes > 0);
        reportProof("unchanged", unchanged);
        baseline = { ...baseline, validation: unchanged.validation, offset: 0 };

        for (let index = 1; index <= 2; index++) {
          const before = await exactInfo(originalPath);
          const fence = await proof.verify(originalPath, baseline.validation, baseline.offset, before);
          assert.ok(fence);
          const append = patterns(100 + index, 200 + index);
          await writer.command({ op: "append", data: append.toString("hex") });
          expectedBytes = Buffer.concat([expectedBytes, append]);
          assert.deepEqual(oracle(expectedBytes), oracle(await readFile(originalPath)));
          const after = await exactInfo(originalPath);
          const advanced = await proof.advance(originalPath, fence, Number(after.size), after);
          assert.ok(advanced);
          assert.equal(advanced.readBytes, 0);
          assert.ok(advanced.journalBytes > 0);
          reportProof(`append-${index}`, advanced);
          baseline = { ...baseline, validation: advanced.validation, offset: Number(after.size) };
        }

        for (let index = 1; index <= 2; index++) {
          const before = await exactInfo(originalPath);
          const fence = await proof.verify(originalPath, baseline.validation, baseline.offset, before);
          assert.ok(fence);
          const overwrite = patterns(300 + index, 32 + index);
          const append = patterns(400 + index, 80 + index);
          await writer.command({
            op: "mixed",
            offset: 10 + index,
            overwrite: overwrite.toString("hex"),
            append: append.toString("hex"),
          });
          overwrite.copy(expectedBytes, 10 + index);
          expectedBytes = Buffer.concat([expectedBytes, append]);
          assert.deepEqual(oracle(expectedBytes), oracle(await readFile(originalPath)));
          const after = await exactInfo(originalPath);
          const mixed = await proof.advance(originalPath, fence, Number(after.size), after);
          assert.equal(mixed, null);
          reportProof(`overwrite-append-${index}`, mixed);

          const reset = await proof.begin(originalPath, 0, after);
          assert.ok(reset);
          reportProof(`reset-${index}`, reset);
          baseline = { ...reset, offset: 0 };
        }

        const beforeRestart = await exactInfo(originalPath);
        proof.close();
        proof = new WindowsSourceProof(nativeExecutable);
        const restartFence = await proof.verify(originalPath, baseline.validation, baseline.offset, beforeRestart);
        assert.ok(restartFence);
        const restartAppend = patterns(501, 91);
        await writer.command({ op: "append", data: restartAppend.toString("hex") });
        expectedBytes = Buffer.concat([expectedBytes, restartAppend]);
        assert.deepEqual(oracle(expectedBytes), oracle(await readFile(originalPath)));
        const afterRestart = await exactInfo(originalPath);
        const restartAdvance = await proof.advance(originalPath, restartFence, Number(afterRestart.size), afterRestart);
        assert.ok(restartAdvance);
        reportProof("reader-restart-append", restartAdvance);
        baseline = { ...baseline, validation: restartAdvance.validation, offset: Number(afterRestart.size) };

        const beforeTruncate = await exactInfo(originalPath);
        const truncateFence = await proof.verify(originalPath, baseline.validation, baseline.offset, beforeTruncate);
        assert.ok(truncateFence);
        const truncatedSize = expectedBytes.length - 77;
        await writer.command({ op: "truncate", size: truncatedSize });
        expectedBytes = expectedBytes.subarray(0, truncatedSize);
        assert.deepEqual(oracle(expectedBytes), oracle(await readFile(originalPath)));
        const afterTruncate = await exactInfo(originalPath);
        const truncated = await proof.advance(originalPath, truncateFence, Number(afterTruncate.size), afterTruncate);
        assert.equal(truncated, null);
        reportProof("truncate", truncated);
        const truncateReset = await proof.begin(originalPath, 0, afterTruncate);
        assert.ok(truncateReset);
        reportProof("truncate-reset", truncateReset);
        baseline = { ...truncateReset, offset: 0 };

        const beforeRename = await exactInfo(originalPath);
        const renameFence = await proof.verify(originalPath, baseline.validation, baseline.offset, beforeRename);
        assert.ok(renameFence);
        await rename(originalPath, renamedPath);
        assert.deepEqual(oracle(expectedBytes), oracle(await readFile(renamedPath)));
        const afterRename = await exactInfo(renamedPath);
        const renamed = await proof.advance(renamedPath, renameFence, Number(afterRename.size), afterRename);
        assert.equal(renamed, null);
        reportProof("rename", renamed);
        await writer.close();

        const renamedBaseline = await proof.begin(renamedPath, 0, afterRename);
        assert.ok(renamedBaseline);
        reportProof("renamed-baseline", renamedBaseline);
        assert.equal(renamedBaseline.validation.token.split(":")[4], originalIdentity);

        const replacementBytes = patterns(900, 1024);
        await writeFile(originalPath, replacementBytes);
        const replacementInfo = await exactInfo(originalPath);
        const replacement = await proof.verify(originalPath, baseline.validation, baseline.offset, replacementInfo);
        assert.equal(replacement, null);
        reportProof("same-path-replacement", replacement);
        const replacementBaseline = await proof.begin(originalPath, 0, replacementInfo);
        assert.ok(replacementBaseline);
        reportProof("replacement-baseline", replacementBaseline);
        assert.notEqual(replacementBaseline.validation.token.split(":")[4], originalIdentity);
        assert.deepEqual(oracle(replacementBytes), oracle(await readFile(originalPath)));
      } finally {
        writer.kill();
        proof.close();
      }
    },
    path.join(process.env.LOCALAPPDATA, "Temp"),
  );
});

test("missing native binary and closed helpers fail safely", async () => {
  if (process.platform !== "win32") return;
  await fixture(async (directory) => {
    const filePath = path.join(directory, "source.jsonl");
    await writeFile(filePath, "source\n");
    const info = await exactInfo(filePath);
    const proof = new WindowsSourceProof(path.join(directory, "missing.exe"));
    assert.equal(await proof.begin(filePath, 0, info), null);
    proof.close();
    assert.equal(await proof.begin(filePath, 0, info), null);
  });
});

test("malformed, truncated, unavailable, oversized and timed-out protocol output stays unavailable", async () => {
  if (process.platform !== "win32") return;
  await fixture(async (directory) => {
    const filePath = path.join(directory, "source.jsonl");
    await writeFile(filePath, "source\n");
    const info = await exactInfo(filePath);

    const malformed = await protocolHelper(
      directory,
      "malformed",
      `process.stdin.once("data", () => process.stdout.write("{not-json}\\n"));`,
    );
    const malformedProof = new WindowsSourceProof(malformed);
    assert.equal(await malformedProof.begin(filePath, 0, info), null);
    malformedProof.close();

    const invalidUtf8 = await protocolHelper(
      directory,
      "invalid-utf8",
      `process.stdin.once("data", () => process.stdout.write(Buffer.from([0xff, 0x0a])));`,
    );
    const invalidUtf8Proof = new WindowsSourceProof(invalidUtf8);
    assert.equal(await invalidUtf8Proof.begin(filePath, 0, info), null);
    invalidUtf8Proof.close();

    const truncated = await protocolHelper(
      directory,
      "truncated",
      `process.stdin.once("data", () => { process.stdout.write("{\\"id\\":1"); process.exit(0); });`,
    );
    const truncatedProof = new WindowsSourceProof(truncated);
    assert.equal(await truncatedProof.begin(filePath, 0, info), null);
    truncatedProof.close();

    const unavailable = await protocolHelper(
      directory,
      "unavailable",
      `process.stdin.on("data", chunk => { const request = JSON.parse(String(chunk).split("\\n")[0]); process.stdout.write(JSON.stringify({ id: request.id, ok: false, available: false }) + "\\n"); });`,
    );
    const unavailableProof = new WindowsSourceProof(unavailable);
    assert.equal(await unavailableProof.begin(filePath, 0, info), null);
    unavailableProof.close();

    const unsupportedKind = await protocolHelper(
      directory,
      "unsupported-kind",
      `process.stdin.on("data", chunk => {
        const request = JSON.parse(String(chunk).split("\\n")[0]);
        const token = "unknown-kind:1:1:0000000000000001:${"0".repeat(32)}:${"0".repeat(16)}:0:1:1";
        process.stdout.write(JSON.stringify({
          id: request.id,
          ok: true,
          available: true,
          kind: "unknown-kind",
          offset: 0,
          token,
          journalBytes: 0,
        }) + "\\n");
      });`,
    );
    const unsupportedKindProof = new WindowsSourceProof(unsupportedKind);
    assert.equal(await unsupportedKindProof.begin(filePath, 0, info), null);
    unsupportedKindProof.close();

    const oversized = await protocolHelper(
      directory,
      "oversized",
      `process.stdin.once("data", () => process.stdout.write("x".repeat(1024 * 1024 + 1)));`,
    );
    const oversizedProof = new WindowsSourceProof(oversized);
    assert.equal(await oversizedProof.begin(filePath, 0, info), null);
    oversizedProof.close();

    const hanging = await protocolHelper(directory, "hanging", `process.stdin.resume();`);
    const hangingProof = new WindowsSourceProof(hanging);
    const timeoutStarted = performance.now();
    assert.equal(await hangingProof.begin(filePath, 0, info), null);
    const timeoutElapsed = performance.now() - timeoutStarted;
    assert.ok(timeoutElapsed >= 2_500, `timeout fired too early: ${timeoutElapsed}ms`);
    assert.ok(timeoutElapsed < 6_000, `timeout fired too late: ${timeoutElapsed}ms`);
    hangingProof.close();
  });
});

test("native helper reports bounded process footprint", { skip: !nativeAvailable, timeout: 20_000 }, async () => {
  const child = spawn(nativeExecutable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  try {
    child.stdin.write(`${JSON.stringify({ id: 1, op: "stats" })}\n`);
    let output = "";
    child.stdout.setEncoding("utf8");
    for await (const chunk of child.stdout) {
      output += chunk;
      if (output.includes("\n")) break;
    }
    const response = JSON.parse(output.slice(0, output.indexOf("\n")));
    assert.equal(response.ok, true);
    assert.ok(response.footprint.workingSetBytes > 0);
    assert.ok(response.footprint.peakWorkingSetBytes >= response.footprint.workingSetBytes);
    assert.ok(response.footprint.pagefileUsageBytes > 0);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
