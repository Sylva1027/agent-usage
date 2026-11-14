import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Keep automatic Hermes discovery enabled inside a disposable test environment.
const parent = await realpath(tmpdir());
const root = await mkdtemp(path.join(parent, "codex-usage-tests-"));
const directories = [{ directory: root, parent }];
try {
  // Native NTFS proofs need AppData's volume; ordinary fixtures keep the runner's temp drive.
  const localParent = process.platform === "win32" && process.env.LOCALAPPDATA
    ? await realpath(path.join(process.env.LOCALAPPDATA, "Temp")) : root;
  const local = localParent === root ? path.join(root, "local")
    : await mkdtemp(path.join(localParent, "codex-usage-appdata-"));
  if (localParent !== root) directories.push({ directory: local, parent: localParent });
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
  await Promise.all(directories.map(async ({ directory, parent }) => {
    if (path.dirname(await realpath(directory)) !== parent) throw new Error("Test cleanup escaped its temporary directory");
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }));
}
