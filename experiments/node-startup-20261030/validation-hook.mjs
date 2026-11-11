import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKSPACE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONFIG_PATH = path.join(WORKSPACE_ROOT, "output", "node-startup-20261030", "experiment.json");
const WORKSPACE_SRC = path.join(WORKSPACE_ROOT, "src");

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const configuredRoot = String(process.env.NODE_STARTUP_TEST_ROOT || config.candidateRoot || "").trim();
assert.notEqual(configuredRoot, "", "NODE_STARTUP_TEST_ROOT/config.candidateRoot must name a candidate root");

const TARGET_ROOT = path.resolve(WORKSPACE_ROOT, configuredRoot);
const TARGET_SRC = path.join(TARGET_ROOT, "src");
const TARGET_USAGE_STORE = path.join(TARGET_SRC, "usage-store.js");
const TARGET_USAGE_CORE = path.join(TARGET_SRC, "usage-core.js");

for (const required of [TARGET_USAGE_CORE, TARGET_USAGE_STORE]) {
  assert.equal(existsSync(required), true, `candidate module is missing: ${required}`);
}

const TEST_PATHS = Object.freeze({
  prefixWindow: path.join(WORKSPACE_ROOT, "test", "codex-prefix-window.test.js"),
  perfIndex: path.join(WORKSPACE_ROOT, "test", "perf-codex-index.test.js"),
  livePartial: path.join(WORKSPACE_ROOT, "test", "perf-codex-live-partial.test.js"),
});

const PREFIX_WINDOW_IMPORT = 'import { planStableCodexHome, proveCodexLiveAppend } from "../src/usage-core.js";';
const PREFIX_WINDOW_CAPTURE = `function capture(files) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("../src/usage-core.js", import.meta.url), {
      workerData: { task: "codex-prefix-window", kind: "codex", files },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    let result;
    worker.once("message", (value) => {
      result = value;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => (code === 0 && result ? resolve(result) : reject(new Error(\`exit \${code}\`))));
  });
}`;

const C1_INJECTION = `/**
 * 在读取后窗口成立之后、逐文件 refresh 判据之前注入一次原地改写。
 * 注入点 = UsageStore 文件循环顶部的显式实例钩子。
 */
function injectC1BeforeDecision(store, targetFile, action) {
  const state = { injected: false };
  const real = store.__startupBeforeFileDecision;
  store.__startupBeforeFileDecision = (filePath) => {
    real?.call(store, filePath);
    if (String(filePath) === targetFile && !state.injected) {
      state.injected = true;
      action();
    }
  };
  state.restore = () => {
    if (real === undefined) delete store.__startupBeforeFileDecision;
    else store.__startupBeforeFileDecision = real;
  };
  return state;
}`;

const LIVE_PUBLICATION_INJECTION = `function injectBeforeCodexPublication(store, action) {
  const state = { injected: false, codexQueries: 0 };
  const real = store.__startupBeforePublication;
  store.__startupBeforePublication = () => {
    real?.call(store);
    state.codexQueries += 1;
    if (!state.injected) {
      state.injected = true;
      action();
    }
  };
  state.restore = () => {
    if (real === undefined) delete store.__startupBeforePublication;
    else store.__startupBeforePublication = real;
  };
  return state;
}`;

const USAGE_STORE_FILE_DECISION_ANCHOR = `    for (const file of files) {
      const existing = this.database`;
const USAGE_STORE_FILE_DECISION_REPLACEMENT = `    for (const file of files) {
      this.__startupBeforeFileDecision?.(file.filePath);

      const existing = this.database`;
const USAGE_STORE_FILE_DECISION_HOOK = "      this.__startupBeforeFileDecision?.(file.filePath);\n\n";

const USAGE_STORE_PUBLICATION_ANCHOR = `    for (const [homeId, plan] of codexPlans) {
      if (blockedHomeIds.has(homeId)) {
        partialHomesById.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
        continue;
      }
      try {
        const discovered = (await discoverSessionFiles(plan.home.path)).sort();`;
const USAGE_STORE_PUBLICATION_REPLACEMENT = `    for (const [homeId, plan] of codexPlans) {
      if (blockedHomeIds.has(homeId)) {
        partialHomesById.delete(homeId);
        if (policyNeedsUpgrade) policyUpgradeComplete = false;
        continue;
      }
      this.__startupBeforePublication?.();
      try {
        const discovered = (await discoverSessionFiles(plan.home.path)).sort();`;
const USAGE_STORE_PUBLICATION_HOOK = "      this.__startupBeforePublication?.();\n";

function normalizeNewlines(source) {
  return source.replace(/\r\n?/g, "\n");
}

function countOccurrences(source, needle) {
  if (needle === "") return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const found = source.indexOf(needle, offset);
    if (found === -1) return count;
    count += 1;
    offset = found + needle.length;
  }
}

function replaceUnique(source, anchor, replacement, label) {
  assert.equal(countOccurrences(source, anchor), 1, `${label} anchor must occur exactly once`);
  return source.replace(anchor, replacement);
}

function assertAssertionsPreserved(before, after, label) {
  assert.equal(countOccurrences(after, "assert."), countOccurrences(before, "assert."), `${label} assertions changed`);
  assert.equal(countOccurrences(after, ".skip"), countOccurrences(before, ".skip"), `${label} skip markers changed`);
}

function transformPrefixWindowTest(source) {
  const before = normalizeNewlines(source);
  let after = replaceUnique(before, PREFIX_WINDOW_IMPORT, PREFIX_WINDOW_IMPORT.replace(
    "planStableCodexHome, proveCodexLiveAppend",
    "codexPlanningFingerprintAsync, planStableCodexHome, proveCodexLiveAppend",
  ), "prefix-window import");
  after = replaceUnique(after, PREFIX_WINDOW_CAPTURE, `async function capture(files) {
  return codexPlanningFingerprintAsync({ kind: "codex" }, files);
}`, "prefix-window capture");
  assert.equal(after.includes("const worker = new Worker"), false, "worker capture survived transform");
  assert.equal(after.includes("codexPlanningFingerprintAsync({ kind: \"codex\" }, files)"), true);
  assertAssertionsPreserved(before, after, "prefix-window test");
  return after;
}

function transformPerfIndexTest(source) {
  const before = normalizeNewlines(source);
  const oldHelper = `/**
 * 在**读取后窗口成立之后、逐文件判据之前**注入一次原地改写。
 * 注入点 = 逐文件循环里对目标文件执行的 \`SELECT DISTINCT session_id FROM events WHERE source_path = ?\`
 * （它晚于 codex 规划窗口、早于发布前复核）。
 */
function injectC1BeforeDecision(store, targetFile, action) {
  const state = { injected: false };
  const realPrepare = store.database.prepare.bind(store.database);
  store.database.prepare = (sql) => {
    const stmt = realPrepare(sql);
    if (!String(sql).includes("SELECT DISTINCT session_id FROM events WHERE source_path = ?")) return stmt;
    const realAll = stmt.all.bind(stmt);
    stmt.all = (...args) => {
      if (String(args[0]) === targetFile && !state.injected) {
        state.injected = true;
        action();
      }
      return realAll(...args);
    };
    return stmt;
  };
  state.restore = () => {
    store.database.prepare = realPrepare;
  };
  return state;
}`;
  const after = replaceUnique(before, oldHelper, C1_INJECTION, "C1 helper");
  assert.equal(after.includes("function injectC1BeforeDecision(store, targetFile, action) {"), true);
  assert.equal(after.includes("store.__startupBeforeFileDecision ="), true);
  assert.equal(after.includes("delete store.__startupBeforeFileDecision"), true);
  assertAssertionsPreserved(before, after, "perf-codex-index test");
  return after;
}

function transformLivePartialTest(source) {
  const before = normalizeNewlines(source);
  const oldHelper = `function injectBeforeCodexPublication(store, action) {
  const state = { injected: false, codexQueries: 0 };
  const realPrepare = store.database.prepare.bind(store.database);
  store.database.prepare = (sql) => {
    const statement = realPrepare(sql);
    if (!String(sql).includes("SELECT DISTINCT session_id FROM events WHERE source_path = ?")) return statement;
    const realAll = statement.all.bind(statement);
    statement.all = (...args) => {
      state.codexQueries += 1;
      if (state.codexQueries === 2) {
        state.injected = true;
        action();
      }
      return realAll(...args);
    };
    return statement;
  };
  state.restore = () => {
    store.database.prepare = realPrepare;
  };
  return state;
}`;
  const after = replaceUnique(before, oldHelper, LIVE_PUBLICATION_INJECTION, "publication helper");
  assert.equal(after.includes("store.__startupBeforePublication ="), true);
  assert.equal(after.includes("delete store.__startupBeforePublication"), true);
  assert.equal(after.includes("state.codexQueries += 1"), true);
  assertAssertionsPreserved(before, after, "perf-codex-live-partial test");
  return after;
}

function transformUsageStore(source) {
  const before = normalizeNewlines(source);
  let after = replaceUnique(
    before,
    USAGE_STORE_FILE_DECISION_ANCHOR,
    USAGE_STORE_FILE_DECISION_REPLACEMENT,
    "UsageStore file-decision hook",
  );
  after = replaceUnique(
    after,
    USAGE_STORE_PUBLICATION_ANCHOR,
    USAGE_STORE_PUBLICATION_REPLACEMENT,
    "UsageStore publication hook",
  );
  assert.equal(countOccurrences(after, "this.__startupBeforeFileDecision?.(file.filePath)"), 1);
  assert.equal(countOccurrences(after, "this.__startupBeforePublication?.()"), 1);
  assert.equal(after.replace(USAGE_STORE_FILE_DECISION_HOOK, "").replace(USAGE_STORE_PUBLICATION_HOOK, ""), before);
  return after;
}

function pathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function filePathFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return null;
    parsed.search = "";
    parsed.hash = "";
    return fileURLToPath(parsed);
  } catch {
    return null;
  }
}

function redirectWorkspaceSrcUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") return url;
  const clean = new URL(parsed);
  clean.search = "";
  clean.hash = "";
  const sourcePath = fileURLToPath(clean);
  const relative = path.relative(WORKSPACE_SRC, sourcePath);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return url;
  }
  const target = pathToFileURL(path.resolve(TARGET_SRC, relative));
  target.search = parsed.search;
  target.hash = parsed.hash;
  return target.href;
}

const transformByTestPath = new Map([
  [pathKey(TEST_PATHS.prefixWindow), transformPrefixWindowTest],
  [pathKey(TEST_PATHS.perfIndex), transformPerfIndexTest],
  [pathKey(TEST_PATHS.livePartial), transformLivePartialTest],
]);

const transformedUsageStore = transformUsageStore(readFileSync(TARGET_USAGE_STORE, "utf8"));
const testSelfChecks = Object.freeze(Object.fromEntries(
  Object.entries(TEST_PATHS).map(([name, filePath]) => {
    const before = normalizeNewlines(readFileSync(filePath, "utf8"));
    const after = transformByTestPath.get(pathKey(filePath))(before);
    return [name, Object.freeze({
      assertions: countOccurrences(after, "assert."),
      skips: countOccurrences(after, ".skip"),
    })];
  }),
));

const redirectedCore = redirectWorkspaceSrcUrl(pathToFileURL(path.join(WORKSPACE_SRC, "usage-core.js")).href);
assert.equal(pathKey(filePathFromUrl(redirectedCore)), pathKey(TARGET_USAGE_CORE));

function exerciseInjectionHelpers() {
  const makeC1 = Function(`${C1_INJECTION}\nreturn injectC1BeforeDecision;`)();
  const chained = [];
  const originalFileHook = (filePath) => chained.push(filePath);
  const fileStore = { __startupBeforeFileDecision: originalFileHook };
  let fileActions = 0;
  const fileInjection = makeC1(fileStore, "target.jsonl", () => {
    fileActions += 1;
  });
  fileStore.__startupBeforeFileDecision("other.jsonl");
  fileStore.__startupBeforeFileDecision("target.jsonl");
  fileStore.__startupBeforeFileDecision("target.jsonl");
  assert.deepEqual(chained, ["other.jsonl", "target.jsonl", "target.jsonl"]);
  assert.equal(fileInjection.injected, true);
  assert.equal(fileActions, 1);
  fileInjection.restore();
  assert.equal(fileStore.__startupBeforeFileDecision, originalFileHook);

  const cleanFileStore = {};
  const cleanFileInjection = makeC1(cleanFileStore, "target.jsonl", () => {});
  cleanFileInjection.restore();
  assert.equal(Object.hasOwn(cleanFileStore, "__startupBeforeFileDecision"), false);

  const makePublication = Function(`${LIVE_PUBLICATION_INJECTION}\nreturn injectBeforeCodexPublication;`)();
  let publicationRealCalls = 0;
  const originalPublicationHook = () => {
    publicationRealCalls += 1;
  };
  const publicationStore = { __startupBeforePublication: originalPublicationHook };
  let publicationActions = 0;
  const publicationInjection = makePublication(publicationStore, () => {
    publicationActions += 1;
  });
  publicationStore.__startupBeforePublication();
  publicationStore.__startupBeforePublication();
  assert.equal(publicationRealCalls, 2);
  assert.equal(publicationInjection.injected, true);
  assert.equal(publicationInjection.codexQueries, 2);
  assert.equal(publicationActions, 1);
  publicationInjection.restore();
  assert.equal(publicationStore.__startupBeforePublication, originalPublicationHook);

  return Object.freeze({
    fileDecision: Object.freeze({ injectedOnce: true, restore: "present" }),
    publication: Object.freeze({ injectedOnce: true, restore: "present", codexQueries: 2 }),
  });
}

const helperInjection = exerciseInjectionHelpers();

export const selfCheck = Object.freeze({
  workspaceRoot: WORKSPACE_ROOT,
  targetRoot: TARGET_ROOT,
  targetUsageCore: TARGET_USAGE_CORE,
  targetUsageStore: TARGET_USAGE_STORE,
  tests: testSelfChecks,
  usageStoreHooks: Object.freeze({
    beforeFileDecision: 1,
    beforePublication: 1,
  }),
  helperInjection,
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (typeof resolved?.url !== "string" || !resolved.url.startsWith("file:")) return resolved;
    return { ...resolved, url: redirectWorkspaceSrcUrl(resolved.url) };
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    const filePath = filePathFromUrl(url);
    if (filePath === null) return loaded;

    let transformed;
    if (pathKey(filePath) === pathKey(TARGET_USAGE_STORE)) {
      transformed = transformedUsageStore;
    } else {
      const transform = transformByTestPath.get(pathKey(filePath));
      if (transform === undefined) return loaded;
      const source = typeof loaded.source === "string"
        ? loaded.source
        : Buffer.from(loaded.source).toString("utf8");
      transformed = transform(source);
    }
    return { ...loaded, source: transformed };
  },
});
