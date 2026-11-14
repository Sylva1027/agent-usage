import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skip =
  process.platform !== "win32"
    ? "Windows build script"
    : process.env.AGENT_USAGE_TEST_NATIVE_BUILD !== "1"
      ? "set AGENT_USAGE_TEST_NATIVE_BUILD=1 for the isolated Cargo build"
      : false;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("native build, portable receipt checks and failed upgrades preserve the previous helper", {
  skip,
  timeout: 120000,
}, async (t) => {
  const output = path.join(root, "output");
  await mkdir(output, { recursive: true });
  const box = await mkdtemp(path.join(output, "native-delivery-test-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(box)), output);
    assert.ok(path.basename(box).startsWith("native-delivery-test-"));
    await rm(box, { recursive: true, force: true });
  });
  const source = path.join(box, "native source"),
    destination = path.join(box, "build output"),
    target = path.join(box, "cargo cache");
  for (const file of ["Cargo.toml", "Cargo.lock", "build.ps1", "src/main.rs", "src/picker.rs", "src/usn.rs"]) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await copyFile(path.join(root, "native/windows-source-proof", file), path.join(source, file));
  }
  const run = (check = false) =>
    spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-File",
        path.join(source, "build.ps1"),
        "-OutputDirectory",
        destination,
        "-TargetDirectory",
        target,
        ...(check ? ["-Check"] : []),
      ],
      {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
        timeout: 90000,
        env: { ...process.env, CARGO_BUILD_TARGET: "invalid-delivery-environment-target" },
      },
    );
  let result = run(true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing/i);
  result = run();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const executable = path.join(destination, "windows-source-proof.exe"),
    receiptFile = path.join(destination, "windows-source-proof.build.json");
  const bytes = await readFile(executable),
    receiptBytes = await readFile(receiptFile),
    receipt = JSON.parse(receiptBytes);
  assert.equal(receipt.sha256, digest(bytes));
  assert.equal(receipt.format, 1);
  assert.match(receipt.target, /-windows-/);
  assert.equal(Object.keys(receipt.sourceSha256).length, 6);
  assert.equal(run(true).status, 0);

  await writeFile(executable, Buffer.concat([bytes, Buffer.from("tampered")]));
  result = run(true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bytes do not match/);
  await writeFile(executable, bytes);

  const rustFile = path.join(source, "src/usn.rs"),
    rustBytes = await readFile(rustFile);
  await writeFile(rustFile, Buffer.concat([rustBytes, Buffer.from("\nthis is not valid Rust;\n")]));
  result = run(true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source changed/);
  result = run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cargo build failed/);
  assert.deepEqual(await readFile(executable), bytes, "failed compilation must preserve the installed helper");
  assert.deepEqual(await readFile(receiptFile), receiptBytes, "failed compilation must preserve its receipt");
  await writeFile(rustFile, rustBytes);
  assert.equal(run(true).status, 0);

  await rm(receiptFile);
  result = run(true);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing/i);
});
