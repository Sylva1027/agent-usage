import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import v8 from "node:v8";

const directory = process.env.REMAINING_DELIVERY_TRACE;
if (directory) {
  mkdirSync(directory, { recursive: true });
  const startedAtMs = Date.now() - process.uptime() * 1000;
  process.once("exit", (code) => {
    appendFileSync(path.join(directory, `node-${process.pid}.jsonl`), `${JSON.stringify({ pid: process.pid,
      ppid: process.ppid, role: process.env.CODEX_USAGE_EXECUTOR_CHILD === "1" ? "executor" : "gateway",
      startedAtMs, endedAtMs: Date.now(), code, execArgv: process.execArgv,
      heapLimit: v8.getHeapStatistics().heap_size_limit, usage: process.resourceUsage(), memory: process.memoryUsage() })}\n`);
  });
}
