import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  codexQuotaFile,
  quotaCacheObservations,
  readCodexQuotaCache,
  readCodexQuotaObservations,
  readOfficialCodexQuota,
  recoverCodexQuota,
} from "../src/codex-quota-cache.js";

const NOW = Date.parse("2026-10-30T00:00:00.000Z");
const ONE_WEEK_MS = 10_080 * 60_000;

function snapshot({
  observedAtMs = NOW,
  windowMinutes = 10_080,
  resetsAtMs = NOW + ONE_WEEK_MS,
  usedPercent = 29,
  secondary = null,
} = {}) {
  return {
    observedAtMs,
    accountFingerprint: "a".repeat(64),
    planType: "prolite",
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        planType: "prolite",
        primary: { usedPercent, windowDurationMins: windowMinutes, resetsAt: resetsAtMs / 1000 },
        secondary,
      },
    },
  };
}

function quotaWindow(state) {
  return { windows: { quota_5h: { state }, quota_week: { state } } };
}

async function cacheOptions(cache) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "codex-quota-cache-"));
  const options = { homeDir, quotaNow: NOW };
  if (cache) {
    const file = codexQuotaFile(options);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(cache));
  }
  return options;
}

test("cache observations are canonical, sanitized, and limited to the default main Codex home", async () => {
  const options = await cacheOptions({
    formatVersion: 1,
    lastAttemptAtMs: 0,
    recoveryEnabled: true,
    snapshots: [snapshot()],
  });
  try {
    const cache = readCodexQuotaCache(options);
    assert.equal(cache.recoveryEnabled, true);
    assert.deepEqual(quotaCacheObservations(cache), [
      {
        sourcePath: `codex-quota.json#${"a".repeat(64)}:codex`,
        lineNumber: 1,
        role: "primary",
        observedAtMs: NOW,
        limitId: "codex",
        limitName: null,
        planType: "prolite",
        windowMinutes: 10_080,
        resetsAtMs: NOW + ONE_WEEK_MS,
        usedPercent: 29,
      },
    ]);
    const multiBucket = structuredClone(cache);
    multiBucket.snapshots[0].rateLimitsByLimitId.other = {
      limitId: "other",
      planType: "prolite",
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: (NOW + 300 * 60_000) / 1000 },
      secondary: null,
    };
    assert.equal(new Set(quotaCacheObservations(multiBucket).map((observation) => observation.sourcePath)).size, 2);

    const mainHome = path.join(options.homeDir, ".codex");
    assert.equal(readCodexQuotaObservations({ ...options, homes: [{ kind: "main", path: mainHome }] }).length, 1);
    assert.deepEqual(readCodexQuotaObservations({ ...options, homes: [{ kind: "codex", path: mainHome }] }), []);
    assert.deepEqual(
      readCodexQuotaObservations({ ...options, homes: [{ kind: "main", path: path.join(options.homeDir, "other") }] }),
      [],
    );
  } finally {
    await rm(options.homeDir, { recursive: true, force: true });
  }
});

test("missing cache is offline by default and the explicit local switch is required", async () => {
  const options = await cacheOptions();
  let reads = 0;
  const readOfficialCodexQuota = async () => {
    reads += 1;
    return snapshot();
  };
  try {
    assert.deepEqual(readCodexQuotaCache(options), {
      formatVersion: 1,
      lastAttemptAtMs: 0,
      snapshots: [],
      recoveryEnabled: false,
    });
    assert.equal(
      await recoverCodexQuota(quotaWindow("waiting"), "quota_week", { ...options, readOfficialCodexQuota }),
      false,
    );
    assert.equal(reads, 0);
    assert.equal(
      await recoverCodexQuota(quotaWindow("waiting"), "quota_week", {
        ...options,
        officialQuotaRecoveryEnabled: true,
        readOfficialCodexQuota,
      }),
      true,
    );
    assert.equal(reads, 1);
  } finally {
    await rm(options.homeDir, { recursive: true, force: true });
  }
});

test("valid local windows and an absent Pro window do not trigger official reads", async () => {
  const options = await cacheOptions({
    formatVersion: 1,
    lastAttemptAtMs: 0,
    recoveryEnabled: true,
    snapshots: [snapshot()],
  });
  let reads = 0;
  const readOfficialCodexQuota = async () => {
    reads += 1;
    return snapshot();
  };
  try {
    assert.equal(
      await recoverCodexQuota(quotaWindow("available"), "quota_5h", { ...options, readOfficialCodexQuota }),
      false,
    );
    assert.equal(
      await recoverCodexQuota(quotaWindow("missing"), "quota_5h", { ...options, readOfficialCodexQuota }),
      false,
    );
    assert.equal(
      await recoverCodexQuota(quotaWindow("ambiguous"), "quota_5h", { ...options, readOfficialCodexQuota }),
      false,
    );
    assert.equal(reads, 0);
  } finally {
    await rm(options.homeDir, { recursive: true, force: true });
  }
});

test("an expired cached window is queried again and a new reset is appended", async () => {
  const expiredReset = NOW - 1;
  const options = await cacheOptions({
    formatVersion: 1,
    lastAttemptAtMs: 0,
    recoveryEnabled: true,
    snapshots: [snapshot({ observedAtMs: NOW - 2 * ONE_WEEK_MS, resetsAtMs: expiredReset })],
  });
  const fresh = snapshot({ observedAtMs: NOW, resetsAtMs: NOW + ONE_WEEK_MS, usedPercent: 44 });
  let reads = 0;
  try {
    assert.equal(
      await recoverCodexQuota(quotaWindow("waiting"), "quota_week", {
        ...options,
        readOfficialCodexQuota: async () => {
          reads += 1;
          return fresh;
        },
      }),
      true,
    );
    const cache = readCodexQuotaCache(options);
    assert.equal(reads, 1);
    assert.equal(cache.snapshots.length, 2);
    assert.equal(cache.snapshots[1].rateLimitsByLimitId.codex.primary.usedPercent, 44);
  } finally {
    await rm(options.homeDir, { recursive: true, force: true });
  }
});

test("failed official reads persist a five-minute cooldown across cache reloads", async () => {
  const options = await cacheOptions({
    formatVersion: 1,
    lastAttemptAtMs: 0,
    recoveryEnabled: true,
    snapshots: [],
  });
  let reads = 0;
  const readOfficialCodexQuota = async () => {
    reads += 1;
    throw new Error("offline");
  };
  try {
    assert.equal(
      await recoverCodexQuota(quotaWindow("waiting"), "quota_week", { ...options, readOfficialCodexQuota }),
      false,
    );
    assert.equal(reads, 1);
    assert.equal(
      await recoverCodexQuota(quotaWindow("waiting"), "quota_week", {
        ...options,
        quotaNow: NOW + 4 * 60_000,
        readOfficialCodexQuota,
      }),
      false,
    );
    assert.equal(reads, 1);
    assert.equal(
      await recoverCodexQuota(quotaWindow("waiting"), "quota_week", {
        ...options,
        quotaNow: NOW + 5 * 60_000,
        readOfficialCodexQuota,
      }),
      false,
    );
    assert.equal(reads, 2);
    assert.equal(readCodexQuotaCache(options).lastAttemptAtMs, NOW + 5 * 60_000);
  } finally {
    await rm(options.homeDir, { recursive: true, force: true });
  }
});

test("concurrent recovery is single-flight per cache file", async () => {
  const options = await cacheOptions({
    formatVersion: 1,
    lastAttemptAtMs: 0,
    recoveryEnabled: true,
    snapshots: [],
  });
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const readOfficialCodexQuota = async () => {
    reads += 1;
    await gate;
    return snapshot();
  };
  try {
    const first = recoverCodexQuota(quotaWindow("waiting"), "quota_week", { ...options, readOfficialCodexQuota });
    const second = recoverCodexQuota(quotaWindow("waiting"), "quota_week", { ...options, readOfficialCodexQuota });
    release();
    assert.deepEqual(await Promise.all([first, second]), [true, true]);
    assert.equal(reads, 1);
    assert.equal(readCodexQuotaCache(options).snapshots.length, 1);
  } finally {
    await rm(options.homeDir, { recursive: true, force: true });
  }
});

test("invalid official payload records the attempt without persisting a snapshot", async () => {
  const options = await cacheOptions({
    formatVersion: 1,
    lastAttemptAtMs: 0,
    recoveryEnabled: true,
    snapshots: [],
  });
  try {
    assert.equal(
      await recoverCodexQuota(quotaWindow("missing"), "quota_week", {
        ...options,
        readOfficialCodexQuota: async () => ({
          accountFingerprint: "a".repeat(64),
          planType: "prolite",
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              primary: { usedPercent: 101, windowDurationMins: 10_080, resetsAt: (NOW + ONE_WEEK_MS) / 1000 },
              secondary: null,
            },
          },
        }),
      }),
      false,
    );
    const cache = readCodexQuotaCache(options);
    assert.deepEqual(cache.snapshots, []);
    assert.equal(cache.lastAttemptAtMs, NOW);
  } finally {
    await rm(options.homeDir, { recursive: true, force: true });
  }
});

test("official stdio reader supports spaced executable paths, isolates CODEX_HOME, and skips quota for API keys", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-quota-reader-"));
  const executable = path.join(root, "fake codex", "codex fake.mjs");
  const traceFile = path.join(root, "trace.jsonl");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(
    executable,
    `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const trace = (value) => appendFileSync(process.env.FAKE_TRACE, JSON.stringify(value) + "\\n");
trace({ kind: "start", codexHome: process.env.CODEX_HOME, argv: process.argv.slice(2) });
const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  const message = JSON.parse(line);
  trace({ kind: "method", method: message.method });
  if (message.id === undefined) return;
  let result = {};
  if (message.method === "account/read") {
    result = { account: { type: process.env.FAKE_ACCOUNT_TYPE || "chatgpt", planType: "cached-plan" } };
  } else if (message.method === "account/rateLimits/read") {
    result = {
      accountId: "private-account-id",
      rateLimitsByLimitId: {
        codex: {
          limitId: "codex",
          planType: "prolite",
          primary: {
            usedPercent: 29,
            windowDurationMins: 10080,
            resetsAt: ${Math.floor((NOW + ONE_WEEK_MS) / 1000)}
          },
          secondary: null
        }
      }
    };
  }
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
`,
  );
  try {
    const options = {
      homeDir: root,
      codexExecutable: executable,
      quotaNow: NOW,
      env: { FAKE_TRACE: traceFile, FAKE_ACCOUNT_TYPE: "chatgpt" },
    };
    const result = await readOfficialCodexQuota(options);
    assert.equal(result.observedAtMs, NOW);
    assert.equal(result.accountFingerprint, createHash("sha256").update("private-account-id").digest("hex"));
    assert.equal(result.planType, "prolite");
    assert.equal(result.rateLimitsByLimitId.codex.primary.windowDurationMins, 10_080);
    assert.equal(JSON.stringify(result).includes("private-account-id"), false);

    const firstTrace = (await readFile(traceFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const start = firstTrace.find((entry) => entry.kind === "start");
    assert.equal(start.codexHome, path.join(root, ".codex"));
    assert(start.argv.includes("--listen") && start.argv.includes("stdio://"));
    const sqliteHomeArgument = start.argv[start.argv.indexOf("-c") + 1];
    assert.equal(existsSync(JSON.parse(sqliteHomeArgument.slice("sqlite_home=".length))), false);
    assert.deepEqual(
      firstTrace.filter((entry) => entry.kind === "method").map((entry) => entry.method),
      ["initialize", "initialized", "account/read", "account/rateLimits/read"],
    );

    await writeFile(traceFile, "");
    assert.equal(
      await readOfficialCodexQuota({ ...options, env: { FAKE_TRACE: traceFile, FAKE_ACCOUNT_TYPE: "ApiKey" } }),
      null,
    );
    const apiKeyTrace = (await readFile(traceFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      apiKeyTrace.some((entry) => entry.method === "account/rateLimits/read"),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
