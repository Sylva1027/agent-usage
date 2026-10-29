import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const started = process.hrtime.bigint();
const args = process.argv.slice(2);
let rustBinary = null;
let childPidPath = null;
const rustArgs = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--rust") rustBinary = args[++index];
  else if (args[index] === "--child-pid-file") childPidPath = args[++index];
  else rustArgs.push(args[index]);
}
if (!rustBinary) throw new Error("--rust is required");

let stdout;
let stderr = "";
let status;
if (childPidPath) {
  const child = spawn(rustBinary, rustArgs, { windowsHide: true });
  if (!child.pid) throw new Error("failed to start Rust helper");
  writeFileSync(childPidPath, String(child.pid), "utf8");
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  status = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  stdout = Buffer.concat(stdoutChunks).toString("utf8");
  stderr = Buffer.concat(stderrChunks).toString("utf8");
} else {
  const child = spawnSync(rustBinary, rustArgs, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (child.error) throw child.error;
  status = child.status;
  stdout = child.stdout;
  stderr = child.stderr ?? "";
}
if (status !== 0) {
  process.stderr.write(stderr);
  process.exit(status ?? 1);
}

const result = JSON.parse(stdout);
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
console.log(
  JSON.stringify({
    engine: "node-rust-helper",
    elapsedMs,
    helper: {
      rustProcessMs: result.elapsedMs,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
    },
    result,
  }),
);
