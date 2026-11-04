import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TRACE_DIR = process.env.ARCH_STARTUP_TRACE_DIR || "";
const BRIDGE_ENABLED = process.env.ARCH_STARTUP_BRIDGE === "1";
const OPTIONS_FILE = process.env.ARCH_STARTUP_OPTIONS_FILE || "";
const SERVER_WRAPPER = process.env.ARCH_STARTUP_SERVER_WRAPPER || "";
const EXPORT_ROWS = process.env.ARCH_STARTUP_EXPORT_ROWS === "1";
const TRACE_ENABLED = Boolean(TRACE_DIR);
const FLUSH_INTERVAL_MS = 250;
const FLUSH_BUFFER_BYTES = 64 * 1024;
const SERVER_GATE = Symbol.for("architecture.startup.gate");
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const spanContext = new AsyncLocalStorage();
const wrappedFunctions = new WeakSet();
const pendingSpans = new Set();
const aggregates = new Map();
let nextSpanId = 1;
let traceFd = null;
let traceBuffer = "";
let traceBufferBytes = 0;
let traceInterval = null;
let traceClosed = false;
let ndjsonFile = "";
let summaryFile = "";
let startedAt = "";

function roundMilliseconds(value) {
  return Math.round(value * 1000) / 1000;
}

function wallClockNow() {
  return performance.timeOrigin + performance.now();
}

function sourceFrom(value) {
  if (typeof value === "string" && value) return value;
  if (!value || typeof value !== "object") return "";
  for (const key of ["filePath", "path", "databaseFile", "homePath", "usageLogPath"]) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return "";
}

function sourceFor(args, sourceArg) {
  return Number.isInteger(sourceArg) ? sourceFrom(args[sourceArg]) : "";
}

function summarySnapshot(final = false) {
  const labels = {};
  const statusCounts = {};
  for (const [label, aggregate] of [...aggregates].sort(([left], [right]) => left.localeCompare(right))) {
    labels[label] = {
      count: aggregate.count,
      total: roundMilliseconds(aggregate.total),
      max: roundMilliseconds(aggregate.max),
      topSources: [...aggregate.sources]
        .map(([source, value]) => ({
          source,
          count: value.count,
          total: roundMilliseconds(value.total),
          max: roundMilliseconds(value.max),
        }))
        .sort((left, right) => right.total - left.total || right.max - left.max || left.source.localeCompare(right.source))
        .slice(0, 8),
    };
  }
  for (const aggregate of aggregates.values()) {
    for (const [status, count] of Object.entries(aggregate.statuses)) {
      statusCounts[status] = (statusCounts[status] || 0) + count;
    }
  }
  return {
    pid: process.pid,
    parentPid: process.ppid,
    startedAt,
    finishedAt: final ? new Date().toISOString() : null,
    spanCount: Object.values(labels).reduce((total, aggregate) => total + aggregate.count, 0),
    statusCounts,
    labels,
  };
}

function writeSummary(final = false) {
  if (!summaryFile) return;
  try {
    writeFileSync(summaryFile, `${JSON.stringify(summarySnapshot(final), null, 2)}\n`);
  } catch {
    // Tracing must not change application behavior.
  }
}

export function flushTrace() {
  if (!TRACE_ENABLED || traceClosed || !traceFd || !traceBuffer) return;
  try {
    writeSync(traceFd, traceBuffer);
    traceBuffer = "";
    traceBufferBytes = 0;
    writeSummary(false);
  } catch {
    // Tracing must not change application behavior.
  }
}

function closeOpenSpans() {
  for (const span of [...pendingSpans]) span.finish("unsettled");
}

export function closeTrace() {
  if (!TRACE_ENABLED || traceClosed) return summarySnapshot(true);
  closeOpenSpans();
  flushTrace();
  traceClosed = true;
  if (traceInterval) clearInterval(traceInterval);
  traceInterval = null;
  writeSummary(true);
  if (traceFd !== null) {
    try {
      closeSync(traceFd);
    } catch {
      // Best-effort after the buffer has already been written.
    }
  }
  traceFd = null;
  return summarySnapshot(true);
}

function appendSpan(span) {
  if (!TRACE_ENABLED || traceClosed) return;
  const record = {
    pid: process.pid,
    parentPid: process.ppid,
    id: span.id,
    parentId: span.parentId,
    label: span.label,
    start: roundMilliseconds(span.startTime),
    duration: roundMilliseconds(span.duration),
    status: span.status,
  };
  if (span.source) record.source = span.source;
  const line = `${JSON.stringify(record)}\n`;
  traceBuffer += line;
  traceBufferBytes += Buffer.byteLength(line);
  const aggregate = aggregates.get(span.label) || {
    count: 0,
    total: 0,
    max: 0,
    statuses: {},
    sources: new Map(),
  };
  aggregate.count += 1;
  aggregate.total += span.duration;
  aggregate.max = Math.max(aggregate.max, span.duration);
  aggregate.statuses[span.status] = (aggregate.statuses[span.status] || 0) + 1;
  const source = span.source || "(unscoped)";
  const sourceAggregate = aggregate.sources.get(source) || { count: 0, total: 0, max: 0 };
  sourceAggregate.count += 1;
  sourceAggregate.total += span.duration;
  sourceAggregate.max = Math.max(sourceAggregate.max, span.duration);
  aggregate.sources.set(source, sourceAggregate);
  aggregates.set(span.label, aggregate);
  if (traceBufferBytes >= FLUSH_BUFFER_BYTES) flushTrace();
}

function newSpan(label, parentId = spanContext.getStore()?.id ?? null, source = "") {
  return {
    id: `${process.pid}:${nextSpanId++}`,
    parentId,
    label,
    source,
    startTime: 0,
    duration: 0,
    status: "pending",
    startedNow: 0,
    finished: false,
    start() {
      if (this.finished || this.startTime) return;
      this.startTime = wallClockNow();
      this.startedNow = performance.now();
      pendingSpans.add(this);
    },
    finish(status = "ok") {
      if (this.finished) return;
      if (!this.startTime) this.start();
      this.finished = true;
      this.status = status;
      this.duration = Math.max(0, performance.now() - this.startedNow);
      pendingSpans.delete(this);
      appendSpan(this);
    },
  };
}

function lazySpan(label, parentId, source) {
  return newSpan(label, parentId, source);
}

function beginSpan(label, { parentId, source } = {}) {
  const span = newSpan(label, parentId, source);
  span.start();
  return span;
}

function observeResult(result, span) {
  if (result && typeof result.then === "function") {
    try {
      result.then(
        () => span.finish("ok"),
        () => span.finish("error"),
      );
    } catch {
      span.finish("error");
    }
    return result;
  }
  span.finish("ok");
  return result;
}

function isAsyncGeneratorFunction(value) {
  return value?.constructor?.name === "AsyncGeneratorFunction";
}

function isGeneratorFunction(value) {
  return value?.constructor?.name === "GeneratorFunction";
}

function generatorMethods(iterator, lifecycle, label, source, traceIterations, isAsync) {
  const finish = (result, span) => {
    span?.finish("ok");
    if (result?.done) lifecycle.finish("ok");
    return result;
  };
  const fail = (error, span) => {
    span?.finish("error");
    lifecycle.finish("error");
    throw error;
  };
  const begin = (name, args) => {
    lifecycle.start();
    const span = traceIterations ? beginSpan(`${label}.${name}`, { parentId: lifecycle.id, source }) : null;
    return {
      span,
      invoke: () => spanContext.run({ id: lifecycle.id }, () => iterator[name](...args)),
    };
  };

  const call = (name) =>
    isAsync
      ? async (...args) => {
          lifecycle.start();
          const span = traceIterations ? beginSpan(`${label}.${name}`, { parentId: lifecycle.id, source }) : null;
          try {
            const result = await spanContext.run({ id: lifecycle.id }, () => iterator[name](...args));
            return finish(result, span);
          } catch (error) {
            fail(error, span);
          }
        }
      : (...args) => {
          const { span, invoke } = begin(name, args);
          try {
            return finish(invoke(), span);
          } catch (error) {
            fail(error, span);
          }
        };

  return {
    next: call("next"),
    return: call("return"),
    throw: call("throw"),
  };
}

function wrapAsyncGenerator(original, label, options) {
  const wrapped = function tracedAsyncGenerator(...args) {
    const parentId = spanContext.getStore()?.id ?? null;
    const source = sourceFor(args, options.sourceArg);
    const lifecycle = lazySpan(label, parentId, source);
    const iterator = original.apply(this, args);
    const methods = generatorMethods(
      iterator,
      lifecycle,
      label,
      source,
      options.traceIterations === true,
      true,
    );

    return {
      ...methods,
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  wrappedFunctions.add(wrapped);
  return wrapped;
}

function wrapGenerator(original, label, options) {
  const wrapped = function tracedGenerator(...args) {
    const parentId = spanContext.getStore()?.id ?? null;
    const source = sourceFor(args, options.sourceArg);
    const lifecycle = lazySpan(label, parentId, source);
    const iterator = original.apply(this, args);
    const methods = generatorMethods(
      iterator,
      lifecycle,
      label,
      source,
      options.traceIterations === true,
      false,
    );
    return {
      ...methods,
      [Symbol.iterator]() {
        return this;
      },
    };
  };
  wrappedFunctions.add(wrapped);
  return wrapped;
}

export function wrapFunction(original, label, options = {}) {
  if (typeof original !== "function" || !TRACE_ENABLED || wrappedFunctions.has(original)) return original;
  if (isAsyncGeneratorFunction(original)) return wrapAsyncGenerator(original, label, options);
  if (isGeneratorFunction(original)) return wrapGenerator(original, label, options);
  const wrapped = function tracedFunction(...args) {
    const span = beginSpan(label, { source: sourceFor(args, options.sourceArg) });
    return spanContext.run({ id: span.id }, () => {
      try {
        return observeResult(original.apply(this, args), span);
      } catch (error) {
        span.finish("error");
        throw error;
      }
    });
  };
  wrappedFunctions.add(wrapped);
  return wrapped;
}

export function instrumentPrototype(target, methods) {
  for (const targetMethod of methods) {
    const descriptor = Object.getOwnPropertyDescriptor(target.prototype, targetMethod.name);
    if (!descriptor || typeof descriptor.value !== "function") continue;
    Object.defineProperty(target.prototype, targetMethod.name, {
      ...descriptor,
      value: wrapFunction(descriptor.value, targetMethod.label, { sourceArg: targetMethod.sourceArg }),
    });
  }
}

export function applyStartupOptions(options = {}) {
  if (!OPTIONS_FILE) return options;
  const parsed = JSON.parse(readFileSync(OPTIONS_FILE, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("ARCH_STARTUP_OPTIONS_FILE must contain a JSON object.");
  }
  return {
    ...(options && typeof options === "object" && !Array.isArray(options) ? options : {}),
    ...parsed,
  };
}

export function wrapServerFactory(factory, label = "server.createUsageServer") {
  return wrapFunction(
    function tracedCreateUsageServer(options = {}) {
      return factory(applyStartupOptions(options));
    },
    label,
  );
}

export function installServerGate(server, gate) {
  if (!BRIDGE_ENABLED || !server || !gate) return server;
  Object.defineProperty(server, SERVER_GATE, {
    configurable: true,
    value: gate,
  });
  return server;
}

function moduleKey(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "file:") return "";
  const relative = path.relative(PROJECT_ROOT, fileURLToPath(parsed));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return "";
  return relative.split(path.sep).join("/").toLowerCase();
}

const FUNCTION_TARGETS = new Map([
  ["src/pricing-store.js", [{ name: "loadPricingFile", label: "pricing-store.loadPricingFile" }]],
  [
    "src/usage-store.js",
    [{ name: "usageSourceFingerprint", label: "usage-store.usageSourceFingerprint", sourceArg: 0 }],
  ],
  [
    "src/usage-core.js",
    [
      { name: "discoverUsageSources", label: "usage-core.discoverUsageSources" },
      { name: "buildUsageFingerprint", label: "usage-core.buildUsageFingerprint" },
      { name: "parseSessionFile", label: "usage-core.parseSessionFile", sourceArg: 0 },
      { name: "streamUsageFileEvents", label: "usage-core.streamUsageFileEvents", sourceArg: 0 },
    ],
  ],
  [
    "src/codex-rollout.js",
    [
      { name: "openRolloutStream", label: "codex-rollout.openRolloutStream", sourceArg: 0 },
      { name: "readRolloutLines", label: "codex-rollout.readRolloutLines", sourceArg: 0 },
    ],
  ],
  [
    "src/zcode-usage.js",
    [
      { name: "parseZcodeDb", label: "zcode-usage.parseZcodeDb", sourceArg: 0 },
      { name: "streamZcodeDbEvents", label: "zcode-usage.streamZcodeDbEvents", sourceArg: 0 },
    ],
  ],
  [
    "src/dsh-usage.js",
    [
      { name: "parseDshSessions", label: "dsh-usage.parseDshSessions", sourceArg: 0 },
      { name: "streamDshSessionEvents", label: "dsh-usage.streamDshSessionEvents", sourceArg: 0 },
      { name: "streamDshSessionRows", label: "dsh-usage.streamDshSessionRows", sourceArg: 0 },
      { name: "readDshSessionRows", label: "dsh-usage.readDshSessionRows", sourceArg: 0 },
    ],
  ],
  [
    "src/opencode-usage.js",
    [
      { name: "parseOpencodeDb", label: "opencode-usage.parseOpencodeDb", sourceArg: 0 },
      { name: "streamOpencodeDbEvents", label: "opencode-usage.streamOpencodeDbEvents", sourceArg: 0 },
    ],
  ],
  [
    "src/claude-code-usage.js",
    [
      { name: "parseClaudeSessions", label: "claude-code-usage.parseClaudeSessions", sourceArg: 0 },
      {
        name: "streamClaudeSessionEvents",
        label: "claude-code-usage.streamClaudeSessionEvents",
        sourceArg: 0,
      },
    ],
  ],
  [
    "src/workbuddy-usage.js",
    [
      { name: "parseWorkbuddySessions", label: "workbuddy-usage.parseWorkbuddySessions", sourceArg: 0 },
      {
        name: "streamWorkbuddySessionEvents",
        label: "workbuddy-usage.streamWorkbuddySessionEvents",
        sourceArg: 0,
      },
    ],
  ],
  [
    "src/service-tier-evidence.js",
    [{ name: "loadServiceTierEvidence", label: "usage-store.loadServiceTierEvidence" }],
  ],
  [
    "src/quota-source-evidence.js",
    [{ name: "loadQuotaSourceEvidence", label: "usage-store.loadQuotaSourceEvidence" }],
  ],
  [
    "src/usage-rollups.js",
    [
      { name: "createUsageRollups", label: "usage-rollups.createUsageRollups" },
      { name: "rebuildUsageRollups", label: "usage-rollups.rebuildUsageRollups" },
      { name: "rebuildUsageRollupsFromEvents", label: "usage-rollups.rebuildUsageRollupsFromEvents" },
    ],
  ],
  [
    "public/timeline-utils.js",
    [{ name: "buildTimelineRows", label: "public.buildTimelineRows" }],
  ],
  [
    "public/period-comparison.js",
    [{ name: "summarizePeriodComparison", label: "public.summarizePeriodComparison" }],
  ],
]);

const CLASS_TARGETS = new Map([
  [
    "src/usage-summary-cache.js",
    {
      className: "UsageSummaryCache",
      methods: ["open", "readSourceState", "readPublication", "stateFor", "get", "publish", "invalidate"].map(
        (name) => ({
          name,
          label: `usage-summary-cache.${name}`,
        }),
      ),
    },
  ],
  [
    "src/usage-store.js",
    {
      className: "UsageStore",
      methods: [
        ["open", undefined],
        ["sync", undefined],
        ["syncRound", undefined],
        ["metadata", undefined],
        ["usageFiles", undefined],
        ["replaceFile", 0],
        ["summarizeHistory", undefined],
        ["dashboardHistory", undefined],
        ["metadataHistory", undefined],
        ["periodComparisonHistory", undefined],
        ["trySqlHistoryDashboard", undefined],
        ["aggregateRange", undefined],
        ["timelineRange", undefined],
        ["recordsForRange", undefined],
        ["buildRecordChampions", undefined],
        ["periodAggregate", undefined],
        ["groupedRange", undefined],
        ["costEventsForRange", undefined],
        ["publishedHistoryUsageReport", undefined],
      ].map(([name, sourceArg]) => ({ name, label: `usage-store.${name}`, sourceArg })),
    },
  ],
]);

function findDescendant(node, predicate) {
  let found = null;
  const visit = (current) => {
    if (found) return;
    if (predicate(current)) {
      found = current;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

function applyEdits(source, edits) {
  let transformed = source;
  for (const edit of [...edits].sort((left, right) => right.pos - left.pos)) {
    transformed = `${transformed.slice(0, edit.pos)}${edit.text}${transformed.slice(edit.pos)}`;
  }
  return transformed;
}

function transformServerSource(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const factory = findDescendant(
    sourceFile,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "createUsageServer",
  );
  if (!factory) throw new Error("startup trace could not locate createUsageServer");
  const loadUsageStore = findDescendant(
    factory,
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "loadUsageStore",
  );
  if (!loadUsageStore) throw new Error("startup trace could not locate loadUsageStore");
  const serverCall = findDescendant(factory, (node) => {
    if (!ts.isCallExpression(node) || node.expression.getText(sourceFile) !== "createServer") return false;
    const argument = node.arguments[0];
    return ts.isFunctionExpression(argument) && argument.name?.text === "handleRequest";
  });
  if (!serverCall) throw new Error("startup trace could not locate handleRequest");
  const handleRequest = serverCall.arguments[0];
  const returnServer = factory.body.statements.find(
    (statement) =>
      ts.isReturnStatement(statement) &&
      ts.isIdentifier(statement.expression) &&
      statement.expression.text === "server",
  );
  if (!returnServer) throw new Error("startup trace could not locate createUsageServer return");

  const edits = [
    {
      pos: loadUsageStore.end,
      text: `
  loadUsageStore = __architectureWrapFunction(loadUsageStore, "server.loadUsageStore");`,
    },
    { pos: handleRequest.getStart(sourceFile), text: "__architectureWrapFunction(" },
    { pos: handleRequest.end, text: ', "server.handleRequest")' },
  ];
  const wrappedReturn = SERVER_WRAPPER ? "return __architectureWrapStartupServer(server, options);\n  " : "";
  edits.push({
    pos: returnServer.getStart(sourceFile),
    text: `__architectureInstallServerGate(server, { loadUsageStore, usageStore, pricingReady, pricingCatalog: localPricingCatalog });\n  ${wrappedReturn}`,
  });
  return applyEdits(source, edits);
}

function instrumentationSource(moduleName) {
  const lines = [
    "import {",
    "  installServerGate as __architectureInstallServerGate,",
    "  instrumentPrototype as __architectureInstrumentPrototype,",
    "  wrapFunction as __architectureWrapFunction,",
    "  wrapServerFactory as __architectureWrapServerFactory,",
    `} from ${JSON.stringify(import.meta.url)};`,
  ];
  if (moduleName === "src/server.js" && SERVER_WRAPPER) {
    lines.push(
      `import { wrapStartupServer as __architectureWrapStartupServer } from ${JSON.stringify(SERVER_WRAPPER)};`,
    );
  }
  for (const target of FUNCTION_TARGETS.get(moduleName) || []) {
    lines.push(
      `${target.name} = __architectureWrapFunction(${target.name}, ${JSON.stringify(target.label)}, ${JSON.stringify({
        sourceArg: target.sourceArg,
      })});`,
    );
  }
  const classTarget = CLASS_TARGETS.get(moduleName);
  if (classTarget) {
    lines.push(
      `__architectureInstrumentPrototype(${classTarget.className}, ${JSON.stringify(classTarget.methods)});`,
    );
  }
  if (moduleName === "src/server.js") {
    lines.push(
      'createUsageServer = __architectureWrapServerFactory(createUsageServer, "server.createUsageServer");',
    );
  }
  if (moduleName === "src/usage-store.js" && EXPORT_ROWS) {
    lines.push("export { publishedUsageEventFromRow };");
  }
  return lines.join("\n");
}

export function registerStartupTraceHooks() {
  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      const moduleName = moduleKey(url);
      const shouldTransform =
        moduleName === "src/server.js" ||
        (moduleName === "src/usage-store.js" && EXPORT_ROWS) ||
        (TRACE_ENABLED &&
          (FUNCTION_TARGETS.has(moduleName) || CLASS_TARGETS.has(moduleName)));
      if (!shouldTransform) return loaded;
      let source = String(loaded.source);
      if (moduleName === "src/server.js") {
        source = transformServerSource(source, fileURLToPath(new URL(url)));
      }
      source += `\n${instrumentationSource(moduleName)}\n`;
      return { ...loaded, source };
    },
  });
}

export function getTracePaths() {
  return { ndjsonFile, summaryFile };
}

if (TRACE_ENABLED) {
  mkdirSync(TRACE_DIR, { recursive: true });
  ndjsonFile = path.join(TRACE_DIR, `startup-trace-${process.pid}.ndjson`);
  summaryFile = path.join(TRACE_DIR, `startup-trace-${process.pid}.json`);
  startedAt = new Date().toISOString();
  traceFd = openSync(ndjsonFile, "w");
  writeSummary(false);
  traceInterval = setInterval(flushTrace, FLUSH_INTERVAL_MS);
  traceInterval.unref();
  process.once("beforeExit", flushTrace);
  process.once("exit", closeTrace);
}

if (TRACE_ENABLED || BRIDGE_ENABLED || OPTIONS_FILE || SERVER_WRAPPER || EXPORT_ROWS) {
  registerStartupTraceHooks();
}
