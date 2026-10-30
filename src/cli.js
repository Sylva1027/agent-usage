#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { createUsageServer } from "./server.js";
import { buildUsageReport, summarizeUsage, toPublicUsageReport } from "./usage-core.js";
import { UsageStore } from "./usage-store.js";
import { loadPricingFile } from "./pricing-store.js";
import { PRICE_FETCH_TIMEOUT_MS } from "./pricing-auto.js";
import {
  planHistoryArchive,
  prepareHistoryArchiveCommit,
  publishHistoryArchiveBundle,
  publishHistoryArchiveImport,
  verifyPublishedHistoryArchiveBundle,
} from "./history-archive.js";
import { createHistoryBackup, restoreHistoryBackup, verifyHistoryBackup } from "./history-backup.js";
import { loadServiceTierEvidence } from "./service-tier-evidence.js";
import { createUsageExecutor } from "./usage-executor.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3765;
const DEFAULT_GATEWAY_MEMORY_MB = 512;
const DEFAULT_STATE_FILE = path.join(homedir(), ".codex-usage", "services.json");
const SERVICE_LOCK_WAIT_MS = 5000;
const SERVICE_LOCK_STALE_MS = 15000;
const SERVICE_REPLACE_RETRY_MS = 1000;

const USAGE = `Usage:
  codex-usage summary [--json] [--home-dir <dir>]
  codex-usage json [--home-dir <dir>]
  codex-usage dashboard [--host <host>] [--port <port>] [--home-dir <dir>]
  codex-usage -d [--host <host>] [--port <port>] [--home-dir <dir>]
  codex-usage gateway [--host <host>] [--port <port>] [--home-dir <dir>] [--memory-mb <mb>]
  codex-usage restart [--host <host>] [--port <port>] [--home-dir <dir>] [--memory-mb <mb>]
  codex-usage run [--host <host>] [--port <port>] [--home-dir <dir>]
  codex-usage stop
  codex-usage history verify <databaseFile>
  codex-usage history backup <sourceDB> <newPackageDB>
  codex-usage history export <sourceDB> <newDirectory> [--home-dir <dir>]
  codex-usage history import <publishedBundleDir> <newImportDir>
  codex-usage history restore <packageDB> <newDB>
  codex-usage history archive <sourceDB> --dry-run
  codex-usage history archive <sourceDB> --commit <verifiedCandidateDB> --backup <newBundleDir> [--home-dir <dir>]`;

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function splitCommand(argv, defaultCommand = "summary") {
  if (argv[0] === "-d") {
    return { command: "dashboard", args: argv.slice(1) };
  }
  if (argv[0] && !argv[0].startsWith("-")) {
    return { command: argv[0], args: argv.slice(1) };
  }
  return { command: defaultCommand, args: argv };
}

function hasFlag(args, name) {
  return args.includes(name);
}

function readOption(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  if (index === -1) {
    return fallback;
  }

  const value = args[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${name}`);
  }
  return value;
}

function reportOptions(args) {
  const homeDir = readOption(args, "--home-dir");
  return homeDir ? { homeDir } : {};
}

function stateFilePath(args) {
  return readOption(args, "--state-file", process.env.CODEX_USAGE_STATE_FILE || DEFAULT_STATE_FILE);
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function parsePositiveInteger(value, optionName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`Invalid ${optionName}: ${value}`);
  }
  return number;
}

function formatUrl(host, port) {
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

function withoutOption(args, name) {
  const nextArgs = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      index += 1;
      continue;
    }
    nextArgs.push(args[index]);
  }
  return nextArgs;
}

function invokedAsCud() {
  return path.basename(process.argv[1] || "") === "cud";
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Shutdown drains bounded pricing writes before releasing the process.
async function waitForProcessExit(pid, timeoutMs = PRICE_FETCH_TIMEOUT_MS + 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      return true;
    }
    await sleep(100);
  }
  return !isProcessRunning(pid);
}

async function waitForRegisteredService(filePath, pid, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const service = (await readServices(filePath)).find((entry) => entry.pid === pid);
    if (service && isProcessRunning(pid)) {
      return service;
    }
    if (!isProcessRunning(pid)) {
      throw new Error("Gateway service exited before it was ready.");
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for gateway service to start.");
}

async function readServices(filePath) {
  try {
    const body = await readFile(filePath, "utf8");
    const parsed = JSON.parse(body);
    if (Array.isArray(parsed.services)) {
      return parsed.services;
    }
    return [];
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeServices(filePath, services) {
  const temporary = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify({ services }, null, 2));
    const deadline = Date.now() + SERVICE_REPLACE_RETRY_MS;
    while (true) {
      try {
        await rename(temporary, filePath);
        break;
      } catch (error) {
        // Windows briefly blocks replacement while a reader has the target open.
        if ((error.code !== "EPERM" && error.code !== "EBUSY") || Date.now() >= deadline) {
          throw error;
        }
        await sleep(10);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function withServicesLock(filePath, callback) {
  const lockPath = `${filePath}.lock`;
  let deadline = Date.now() + SERVICE_LOCK_WAIT_MS;

  await mkdir(path.dirname(filePath), { recursive: true });

  while (true) {
    try {
      await mkdir(lockPath);
      await writeFile(
        path.join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
      );
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      let isStale = false;
      try {
        const info = await stat(lockPath);
        isStale = Date.now() - info.mtimeMs > SERVICE_LOCK_STALE_MS;
      } catch (statError) {
        if (statError.code !== "ENOENT") {
          throw statError;
        }
      }

      if (isStale || Date.now() > deadline) {
        await rm(lockPath, { recursive: true, force: true });
        deadline = Date.now() + SERVICE_LOCK_WAIT_MS;
        continue;
      }
      await sleep(25);
    }
  }

  try {
    return await callback();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

async function removeService(filePath, pid) {
  await withServicesLock(filePath, async () => {
    const services = await readServices(filePath);
    const nextServices = services.filter((service) => service.pid !== pid);
    if (nextServices.length === 0) {
      try {
        await unlink(filePath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      return;
    }
    await writeServices(filePath, nextServices);
  });
}

async function registerService(filePath, service) {
  await withServicesLock(filePath, async () => {
    const services = await readServices(filePath);
    const liveServices = services.filter((entry) => entry.pid && isProcessRunning(entry.pid));
    const nextServices = liveServices.filter((entry) => entry.pid !== service.pid);
    nextServices.push(service);
    await writeServices(filePath, nextServices);
  });
}

async function runningServices(filePath) {
  return (await readServices(filePath)).filter(
    (service) => service.pid && isProcessRunning(service.pid) && service.url,
  );
}

function printHuman(summary) {
  console.log(`Total tokens: ${formatNumber(summary.totals.total)}`);
  console.log(`Input tokens: ${formatNumber(summary.totals.input)}`);
  console.log(`Cached input: ${formatNumber(summary.totals.cached)}`);
  console.log(`Output tokens: ${formatNumber(summary.totals.output)}`);
  console.log(`Reasoning output: ${formatNumber(summary.totals.reasoning)}`);
  console.log(`Sessions: ${formatNumber(summary.sessionCount)}`);
  console.log("");
  console.log("By channel:");
  for (const channel of summary.channels) {
    console.log(`- ${channel.name}: ${formatNumber(channel.total.total)}`);
  }
}

async function printSummary(command, args) {
  await loadPricingFile(reportOptions(args));
  if (command === "json") {
    const report = await buildUsageReport(reportOptions(args));
    const summary = summarizeUsage(report, { preset: "all", bucket: "month" });
    // M4.3（卡片明文）：公开 report 必须**投影原有公开字段** ⇒ 内部载体的
    // `perfSamples`（含 `sampleKey`/`sourcePath`/会话路径）与 `perfMeta` 不得被序列化出去。
    // `summary.perf` 是刻意的公开契约，照常输出。
    console.log(JSON.stringify({ report: toPublicUsageReport(report), summary }, null, 2));
    return;
  }

  // 摘要命令复用磁盘索引，避免历史事件常驻内存。
  const store = new UsageStore(reportOptions(args));
  try {
    await store.sync();
    const summary = store.summarize({ preset: "all", bucket: "month" });
    if (hasFlag(args, "--json")) {
      // M4.3 返工1（复核 §1）：这里**只**输出索引摘要 —— `{metadata, summary}`。
      // 曾试过额外导出逐来源的完整报告（`reports[]`/`results[]`）：实测输出从 20683 字节膨胀到
      // 684127 字节（≈33 倍），且要把每个 home 的全部历史事件同时留在内存里，直接违背上面那行
      // 注释的承诺。上游方案要求的"两条生产路径同 fixture 统计一致"由各自的 `summary.perf` 承担，
      // 不需要索引 CLI 顺带导出另一条路径。
      console.log(JSON.stringify({ metadata: store.metadata(), summary }, null, 2));
      return;
    }
    printHuman(summary);
  } finally {
    store.close();
  }
}

function runServer(args) {
  const host = readOption(args, "--host", process.env.HOST || DEFAULT_HOST);
  const port = parsePort(readOption(args, "--port", process.env.PORT || String(DEFAULT_PORT)));
  const stateFile = stateFilePath(args);
  const shutdownToken = randomBytes(32).toString("hex");
  let shuttingDown = false;
  const server = createUsageServer({
    ...reportOptions(args),
    shutdownToken,
    onShutdown: () => void shutdown(),
  });

  server.listen(port, host, async () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    const url = formatUrl(host, actualPort);
    try {
      await registerService(stateFile, {
        pid: process.pid,
        shutdownToken,
        host,
        port: actualPort,
        url,
        cwd: process.cwd(),
        argv: process.argv.slice(1),
        nodeExecArgv: process.execArgv,
        startedAt: new Date().toISOString(),
      });
      console.log(`Agent Usage dashboard: ${url}`);
    } catch (error) {
      console.error(error.stack || error.message);
      server.close(() => {
        process.exit(1);
      });
    }
  });

  server.on("error", async (error) => {
    await removeService(stateFile, process.pid);
    console.error(error.message);
    process.exitCode = 1;
  });

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await removeService(stateFile, process.pid);
    server.close(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

async function startGateway(args, { announce = true } = {}) {
  const stateFile = stateFilePath(args);
  const cliPath = fileURLToPath(import.meta.url);
  const memoryMb = parsePositiveInteger(
    readOption(args, "--memory-mb", process.env.CODEX_USAGE_MEMORY_MB || String(DEFAULT_GATEWAY_MEMORY_MB)),
    "--memory-mb",
  );
  const runArgs = withoutOption(args, "--memory-mb");
  const child = spawn(process.execPath, [`--max-old-space-size=${memoryMb}`, cliPath, "run", ...runArgs], {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: "ignore",
  });

  child.unref();

  const service = await waitForRegisteredService(stateFile, child.pid);
  if (announce) {
    console.log(`Agent Usage gateway started: ${service.url} (pid ${service.pid})`);
  }
  return service;
}

function openUrl(url) {
  const currentPlatform = platform();
  const opener =
    currentPlatform === "darwin"
      ? { command: "open", args: [url] }
      : currentPlatform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  const child = spawn(opener.command, opener.args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", (error) => {
    console.error(`Unable to open dashboard: ${error.message}`);
  });
  child.unref();
}

async function openDashboard(args) {
  const stateFile = stateFilePath(args);
  const services = await runningServices(stateFile);
  const service = services[0] || (await startGateway(args, { announce: false }));
  if (!hasFlag(args, "--no-open") && process.env.CODEX_USAGE_OPEN !== "0") {
    openUrl(service.url);
  }
  console.log(`Agent Usage dashboard: ${service.url}`);
}

async function requestServiceShutdown(service) {
  if (service.shutdownToken && service.url) {
    try {
      const response = await fetch(new URL("/internal/shutdown", service.url), {
        method: "POST",
        headers: { "x-codex-usage-shutdown-token": service.shutdownToken },
        signal: AbortSignal.timeout(1500),
      });
      return response.status === 202;
    } catch {
      return false;
    }
  }
  try {
    process.kill(service.pid, "SIGTERM");
    return true;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

async function stopRunningServices(args, { announce = true } = {}) {
  const stateFile = stateFilePath(args);
  const services = await readServices(stateFile);
  const runningServices = services.filter(
    (service) => service.pid && service.pid !== process.pid && isProcessRunning(service.pid),
  );

  if (runningServices.length === 0) {
    await writeServices(stateFile, []);
    if (announce) {
      console.log("No running Agent Usage services found.");
    }
    return { stoppedServices: [], stillRunningServices: [] };
  }

  const stoppedServices = [];
  const stillRunningServices = [];
  const requestedServices = [];
  for (const service of runningServices) {
    if (await requestServiceShutdown(service)) {
      requestedServices.push(service);
    } else {
      stillRunningServices.push(service);
    }
  }
  for (const service of requestedServices) {
    if (await waitForProcessExit(service.pid)) {
      stoppedServices.push(service);
    } else {
      stillRunningServices.push(service);
    }
  }

  await withServicesLock(stateFile, async () => {
    const liveServices = (await readServices(stateFile)).filter(
      (service) => service.pid && isProcessRunning(service.pid),
    );
    await writeServices(stateFile, liveServices);
  });

  if (stillRunningServices.length > 0) {
    if (announce) {
      console.error(
        `Stopped ${stoppedServices.length} Agent Usage service(s), ${stillRunningServices.length} still running.`,
      );
    }
    return { stoppedServices, stillRunningServices };
  }

  if (announce) {
    console.log(`Stopped ${stoppedServices.length} Agent Usage service(s).`);
  }
  return { stoppedServices, stillRunningServices };
}

async function stopServers(args) {
  const { stillRunningServices } = await stopRunningServices(args);
  if (stillRunningServices.length > 0) {
    process.exitCode = 1;
  }
}

async function restartGateway(args) {
  const { stillRunningServices } = await stopRunningServices(args);
  if (stillRunningServices.length > 0) {
    process.exitCode = 1;
    return;
  }

  const service = await startGateway(args, { announce: false });
  console.log(`Agent Usage gateway restarted: ${service.url} (pid ${service.pid})`);
}

async function verifyHistoryCommand(args) {
  const [subcommand, databaseFile, ...extra] = args;
  if (subcommand !== "verify" || !databaseFile || extra.length > 0) {
    console.error("Usage: codex-usage history verify <databaseFile>");
    process.exitCode = 1;
    return;
  }

  try {
    const verified = await verifyHistoryBackup(databaseFile);
    console.log("History backup verified.");
    console.log(`Schema: ${verified.manifest.schemaVersion}`);
    console.log("Tables:");
    for (const [table, evidence] of Object.entries(verified.manifest.tables).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      console.log(`- ${table}: ${formatNumber(evidence.rows)}`);
    }
    const captured = verified.manifest.serviceTierEvidence;
    console.log(
      captured === null
        ? "Service-tier evidence: not captured"
        : `Service-tier evidence: captured (${formatNumber(captured.snapshot.threads.length)} threads)`,
    );
  } catch (error) {
    console.error(
      `History backup verification failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`,
    );
    process.exitCode = 1;
  }
}

async function backupHistoryCommand(args) {
  const [subcommand, sourceFile, destinationFile, ...extra] = withoutOption(args, "--home-dir");
  if (subcommand !== "backup" || !sourceFile || !destinationFile || extra.length > 0) {
    console.error("Usage: codex-usage history backup <sourceDB> <newPackageDB> [--home-dir <dir>]");
    process.exitCode = 1;
    return;
  }

  try {
    await loadPricingFile(reportOptions(args));
    const source = new DatabaseSync(sourceFile, { readOnly: true });
    try {
      await createHistoryBackup(source, destinationFile);
    } finally {
      source.close();
    }
    console.log("History backup created.");
    console.log(`Database: ${path.resolve(destinationFile)}`);
    console.log("Service-tier evidence: not captured");
    console.log("Source database was not modified.");
  } catch (error) {
    console.error(
      `History backup creation failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`,
    );
    process.exitCode = 1;
  }
}

async function restoreHistoryCommand(args) {
  const [subcommand, packageFile, destinationFile, ...extra] = args;
  if (subcommand !== "restore" || !packageFile || !destinationFile || extra.length > 0) {
    console.error("Usage: codex-usage history restore <packageDB> <newDB>");
    process.exitCode = 1;
    return;
  }

  try {
    const restored = await restoreHistoryBackup(packageFile, destinationFile);
    console.log("History backup restored.");
    console.log(`Database: ${restored.restoredTo}`);
    console.log(`Manifest: ${restored.manifestFile}`);
    console.log("Online service was not switched.");
  } catch (error) {
    console.error(
      `History backup restore failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`,
    );
    process.exitCode = 1;
  }
}

async function exportHistoryCommand(args) {
  const [subcommand, sourceFile, destinationDirectory, ...extra] = withoutOption(args, "--home-dir");
  if (subcommand !== "export" || !sourceFile || !destinationDirectory || extra.length > 0) {
    console.error("Usage: codex-usage history export <sourceDB> <newDirectory> [--home-dir <dir>]");
    process.exitCode = 1;
    return;
  }

  try {
    await loadPricingFile(reportOptions(args));
    const homeDir = readOption(args, "--home-dir");
    const serviceTierEvidence = homeDir
      ? loadServiceTierEvidence([{ id: "cli-export", label: "CLI export", path: path.resolve(homeDir), kind: "main" }])
      : null;
    const source = new DatabaseSync(sourceFile, { readOnly: true });
    try {
      const published = await publishHistoryArchiveBundle(source, destinationDirectory, { serviceTierEvidence });
      console.log("History bundle exported.");
      console.log(`Directory: ${published.directory}`);
      console.log(`Manifest: ${published.manifestFile}`);
      console.log(`Completion marker: ${published.markerFile}`);
      console.log("Source database was not modified.");
    } finally {
      source.close();
    }
  } catch (error) {
    console.error(
      `History bundle export failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`,
    );
    process.exitCode = 1;
  }
}

async function importHistoryCommand(args) {
  const [subcommand, sourceDirectory, destinationDirectory, ...extra] = args;
  if (subcommand !== "import" || !sourceDirectory || !destinationDirectory || extra.length > 0) {
    console.error("Usage: codex-usage history import <publishedBundleDir> <newImportDir>");
    process.exitCode = 1;
    return;
  }

  try {
    const imported = await publishHistoryArchiveImport(sourceDirectory, destinationDirectory);
    console.log("History bundle imported.");
    console.log(`Runtime: ${imported.runtimeFile}`);
    console.log(`Bundle: ${imported.bundleDirectory}`);
    console.log(`Import marker: ${imported.markerFile}`);
    console.log("Online service was not switched.");
  } catch (error) {
    console.error(
      `History bundle import failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`,
    );
    process.exitCode = 1;
  }
}

async function archiveHistoryCommand(args) {
  const [subcommand, sourceFile, ...archiveArgs] = args;
  if (subcommand !== "archive" || !sourceFile) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  let source;
  let executor;
  try {
    const dryRun = archiveArgs.length === 1 && archiveArgs[0] === "--dry-run";
    if (!dryRun) {
      if (!hasFlag(archiveArgs, "--commit") && !hasFlag(archiveArgs, "--backup")) {
        console.error("Usage: codex-usage history archive <sourceDB> --dry-run");
        process.exitCode = 1;
        return;
      }
      const candidateFile = readOption(archiveArgs, "--commit");
      const backupDirectory = readOption(archiveArgs, "--backup");
      const remaining = withoutOption(withoutOption(withoutOption(archiveArgs, "--commit"), "--backup"), "--home-dir");
      if (!candidateFile || !backupDirectory || remaining.length > 0) {
        console.error(
          "Usage: codex-usage history archive <sourceDB> --commit <verifiedCandidateDB> --backup <newBundleDir> [--home-dir <dir>]",
        );
        process.exitCode = 1;
        return;
      }

      await loadPricingFile(reportOptions(args));
      const homeDir = readOption(args, "--home-dir");
      const serviceTierEvidence = homeDir
        ? loadServiceTierEvidence([
            { id: "cli-archive-commit", label: "CLI archive commit", path: path.resolve(homeDir), kind: "main" },
          ])
        : null;
      source = new DatabaseSync(sourceFile, { readOnly: true });
      const plan = await prepareHistoryArchiveCommit(source, candidateFile);
      const published = await publishHistoryArchiveBundle(source, backupDirectory, { serviceTierEvidence });
      await verifyPublishedHistoryArchiveBundle(published.directory);
      source.close();
      source = null;

      executor = createUsageExecutor({ ...reportOptions(args), databaseFile: path.resolve(sourceFile) });
      await executor.open();
      const committed = await executor.commitHistoryArchiveEvents(plan);
      console.log("History archive committed.");
      console.log(`Backup: ${published.directory}`);
      console.log(`Manifest: ${published.manifestFile}`);
      console.log(`Completion marker: ${published.markerFile}`);
      console.log(`Segment: ${committed.segmentId}`);
      console.log(`Deleted events: ${formatNumber(committed.deletedEventCount)}`);
      console.log(`Replay: ${committed.replay ? "yes" : "no"}`);
      console.log("Online service was not switched.");
      return;
    }

    source = new DatabaseSync(sourceFile, { readOnly: true });
    const plan = planHistoryArchive(source, { asOf: Date.now() });
    console.log("History archive dry-run.");
    console.log(`Eligible: ${plan.eligible ? "yes" : "no"}`);
    console.log(`Reason: ${plan.reason}`);
    console.log(`Events: ${formatNumber(plan.eventCount)}`);
    console.log(`Cold events: ${formatNumber(plan.coldEventCount)}`);
    console.log(`Cutoff local: ${new Date(plan.cutoffMs).toLocaleString()}`);
    console.log(`Cutoff epoch ms: ${plan.cutoffMs}`);
  } catch (error) {
    console.error(
      `History archive ${archiveArgs[0] === "--dry-run" ? "dry-run" : "commit"} failed: ${error?.code ? `${error.code}: ` : ""}${error?.message ?? String(error)}`,
    );
    process.exitCode = 1;
  } finally {
    source?.close();
    await executor?.close();
  }
}

async function main() {
  const { command, args } = splitCommand(process.argv.slice(2), invokedAsCud() ? "dashboard" : "summary");

  if (command === "help" || hasFlag(args, "--help") || hasFlag(args, "-h")) {
    console.log(USAGE);
    return;
  }

  if (command === "run" || command === "serve") {
    runServer(args);
    return;
  }

  if (command === "gateway") {
    await startGateway(args);
    return;
  }

  if (command === "restart") {
    await restartGateway(args);
    return;
  }

  if (command === "dashboard") {
    await openDashboard(args);
    return;
  }

  if (command === "stop") {
    await stopServers(args);
    return;
  }

  if (command === "summary" || command === "json") {
    await printSummary(command, args);
    return;
  }

  if (command === "history") {
    if (args[0] === "backup") {
      await backupHistoryCommand(args);
    } else if (args[0] === "restore") {
      await restoreHistoryCommand(args);
    } else if (args[0] === "export") {
      await exportHistoryCommand(args);
    } else if (args[0] === "import") {
      await importHistoryCommand(args);
    } else if (args[0] === "archive") {
      await archiveHistoryCommand(args);
    } else {
      await verifyHistoryCommand(args);
    }
    return;
  }

  console.error(USAGE);
  process.exitCode = 1;
}

export { readServices, writeServices };

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
