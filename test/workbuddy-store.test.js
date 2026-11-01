import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { STORE_SCHEMA_VERSION, UsageStore } from "../src/usage-store.js";

const SESSION_A = "21201ca7-ac0f-4672-9745-084a3dfeb70d";
const SESSION_B = "bd7e6ac4-720f-4c77-8280-8d2687320b1a";

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function usageRecord(messageId, { sessionId = SESSION_A, outputTokens = 200 } = {}) {
  return {
    timestamp: 1792537466382,
    type: "function_call",
    providerData: {
      messageId,
      model: "deepseek-v4.1-flash",
      usage: {
        inputTokens: 1000,
        outputTokens,
        totalTokens: 1000 + outputTokens,
        inputTokensDetails: [{ cached_tokens: 0 }],
        outputTokensDetails: [{ reasoning_tokens: 10 }],
      },
    },
    sessionId,
    cwd: "/work/demo",
  };
}

async function withWorkspace(run) {
  const root = await mkdtemp(path.join(tmpdir(), "workbuddy-store-"));
  try {
    const home = path.join(root, ".workbuddy-ai");
    const projectDir = path.join(home, "projects", "slug");
    await mkdir(projectDir, { recursive: true });
    const options = { homeDir: root, env: {} };
    return await run({ root, home, projectDir, options, storeFile: path.join(root, "index.sqlite") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("usageFiles expands session files and excludes tool results", async () => {
  await withWorkspace(async ({ home, projectDir, options, storeFile }) => {
    await writeFile(path.join(projectDir, `${SESSION_A}.jsonl`), jsonl([usageRecord("m-1")]));
    await writeFile(path.join(projectDir, `${SESSION_B}.jsonl`), jsonl([usageRecord("m-2", { sessionId: SESSION_B })]));
    const toolResults = path.join(projectDir, SESSION_A, "tool-results");
    await mkdir(toolResults, { recursive: true });
    await writeFile(path.join(toolResults, "big.txt"), "x");

    const store = new UsageStore({ homeDir: options.homeDir, databaseFile: storeFile });
    try {
      const { files, failedHomes } = await store.usageFiles([
        { id: "workbuddy-1", label: "Main WorkBuddy", path: home, kind: "workbuddy" },
      ]);
      assert.equal(files.length, 2);
      assert.equal(failedHomes.length, 0);
      assert.ok(files.every((file) => file.filePath.endsWith(".jsonl")));
      assert.ok(files.every((file) => !file.filePath.includes("tool-results")));
    } finally {
      store.close();
    }
  });
});

test("missing WorkBuddy source is harmless and new stores use schema 24", async () => {
  await withWorkspace(async ({ options, storeFile }) => {
    const store = new UsageStore({ homeDir: options.homeDir, databaseFile: storeFile });
    try {
      await store.open();
      const { files, failedHomes } = await store.usageFiles([
        { id: "workbuddy-x", label: "Missing", path: path.join(options.homeDir, "missing"), kind: "workbuddy" },
      ]);
      assert.equal(files.length, 0);
      assert.equal(failedHomes.length, 0);
      assert.equal(STORE_SCHEMA_VERSION, 24);
      assert.equal(Number(store.database.prepare("PRAGMA user_version").get().user_version), 24);
    } finally {
      store.close();
    }
  });
});

test("WorkBuddy usage sync fills its harness bucket and stays stable", async () => {
  await withWorkspace(async ({ projectDir, options, storeFile }) => {
    await writeFile(
      path.join(projectDir, `${SESSION_A}.jsonl`),
      jsonl([
        usageRecord("m-1"),
        usageRecord("m-1", { outputTokens: 999 }),
        usageRecord("m-2", { outputTokens: 300 }),
        usageRecord("m-auto", { outputTokens: 400 }),
      ]),
    );
    const store = new UsageStore({ homeDir: options.homeDir, databaseFile: storeFile });
    try {
      const first = await store.sync({ options });
      assert.equal(first.updatedFileCount, 1);
      const summary = store.summarize({ preset: "all" });
      assert.equal(summary.eventCount, 3);
      assert.equal(summary.totals.total, 3900);
      assert.equal(summary.channels[0].name, "WorkBuddy");
      const metadata = store.metadata();
      assert.deepEqual(metadata.harnessModels.WorkBuddy, ["deepseek-v4.1-flash"]);
      assert.deepEqual(metadata.harnessModels.Codex, []);
      assert.equal((await store.sync({ options })).updatedFileCount, 0);
    } finally {
      store.close();
    }
  });
});
