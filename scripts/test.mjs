import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Keep automatic Hermes discovery enabled inside a disposable test environment.
const parent = await realpath(tmpdir());
const root = await mkdtemp(path.join(parent, "codex-usage-tests-"));
try {
  const local = path.join(root, "local");
  await mkdir(path.join(local, "Temp"), { recursive: true });
  const env = { ...process.env, LOCALAPPDATA: local, TEMP: root, TMP: root };
  for (const name of ["HERMES_HOME", "HERMES_DATA_DIR_SUFFIX", "CODEX_USAGE_HERMES_HOMES", "CODEX_USAGE_HERMES"])
    delete env[name];
  const args = process.argv.slice(2);
  if (!args.some((arg) => arg.endsWith(".test.js"))) args.push("test/**/*.test.js");
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", ...args], { env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  if (path.dirname(await realpath(root)) !== parent) throw new Error("Test cleanup escaped its temporary directory");
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
