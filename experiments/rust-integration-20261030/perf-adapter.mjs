import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/** Isolated bridge: validated rows are written incrementally, then released before aggregation. */
export function runRustPerf(config, rows) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rust-perf-"));
  const input = path.join(directory, "input.ndjson");
  const pidFile = process.env.RUST_PERF_PID_FILE || path.join(directory, "pid");
  let fd = null;
  try {
    fd = fs.openSync(input, "wx");
    fs.writeSync(fd, JSON.stringify(config) + "\n");
    let count = 0;
    for (const row of rows) {
      fs.writeSync(fd, JSON.stringify(row) + "\n");
      count += 1;
    }
    fs.closeSync(fd); fd = null;
    const result = spawnSync(process.env.RUST_PERF_BIN, ["--input", input, "--pid-file", pidFile], {
      encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Rust perf failed (${result.status}): ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    if (process.env.RUST_INTEGRATION_METRICS) {
      fs.appendFileSync(process.env.RUST_INTEGRATION_METRICS, JSON.stringify({
        type: "perf-spool", pid: process.pid, rows: count, inputBytes: fs.statSync(input).size,
        outputBytes: Buffer.byteLength(result.stdout), at: performance.timeOrigin + performance.now(),
      }) + "\n");
    }
    return parsed;
  } finally {
    if (fd !== null) fs.closeSync(fd);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
