// 皮肤配色重设计的隔离合成 fixture（实现计划 M0.4）。
// 只在 os.tmpdir() 下创建 skin-palette-fixture- 前缀目录并写入全部状态；
// 数据通过真实导入链路接入（.codex-usage/usage.jsonl + imports.json），
// 不伪造 /api/usage 协议，不读取用户 HOME 的日志与配置。
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sha256Canonical } from "../scripts/skin-palette/contracts.mjs";

export const FIXTURE_DIRECTORY_PREFIX = "skin-palette-fixture-";
export const FIXTURE_VERSION = 3;
export const FIXTURE_LOG_SCHEMA = "codex-usage.project-log.v1";
export const FIXTURE_RANGE = Object.freeze({ start: "2026-09-26", end: "2026-10-03" });
export const FIXTURE_EVENT_COUNT = 12;
export const FIXTURE_TOTAL_TOKENS = 242800;
export const FIXTURE_LONG_NAME_MIN_LENGTH = 20;
export const FIXTURE_LONG_NAME_EVENT_MIN_COUNT = 8;

const CHANNEL_PALETTE_CLI = "Palette CLI";
const CHANNEL_AURORA_CONSOLE = "Aurora Design System Console";
const MODEL_GLM = "glm-5.3";
const MODEL_GPT = "gpt-5.6-sol";
const MODEL_CLAUDE = "claude-sonnet-4-6";
// 刻意不在任何本地默认价目表内：触发"缺价说明"场景（未知模型走最低价率兜底，
// priceMode = minimum-fallback-scenario），同时是一条可显示长名称。
export const FIXTURE_MISSING_PRICE_MODEL = "palette-fixture-missing-price-longcontext-model-x9";
const MODEL_MISSING_PRICE = FIXTURE_MISSING_PRICE_MODEL;

const PROVIDER_PROFILES = Object.freeze({
  [MODEL_GPT]: Object.freeze({
    provider: "openai-codex",
    auth: "codex-oauth",
    api_surface: "chatgpt-codex-responses",
  }),
  [MODEL_CLAUDE]: Object.freeze({
    provider: "anthropic-compatible",
    auth: "api-key",
    api_surface: "anthropic-messages",
  }),
  [MODEL_GLM]: Object.freeze({
    provider: "openai",
    auth: "api-key",
    api_surface: "openai-chat-completions",
  }),
  [MODEL_MISSING_PRICE]: Object.freeze({
    provider: "openai",
    auth: "api-key",
    api_surface: "openai-chat-completions",
  }),
});

// 固定静态数据（版本化）：时间戳/模型/渠道/用量全部写死，不依赖当前日期。
// tokens = [input, cached, output, reasoning]；total = input + output（cached ⊆ input）。
const EVENT_SPECS = Object.freeze([
  {
    at: "2026-09-26T01:10:00.000Z",
    source: "palette-cli",
    channel: CHANNEL_PALETTE_CLI,
    model: MODEL_GLM,
    cwdInProject: "src/importer",
    sessionId: "sess-glm-nightly",
    requestId: "req-2026-09-26-001",
    tokens: [12000, 4000, 2500, 600],
  },
  {
    at: "2026-09-26T09:40:00.000Z",
    source: "aurora-console",
    channel: CHANNEL_AURORA_CONSOLE,
    model: MODEL_GPT,
    cwdInProject: "apps/console",
    sessionId: "sess-aurora-batch-nightly-rerank-eval-2026-09-26-a",
    tokens: [9000, 1500, 1800, 300],
  },
  {
    at: "2026-09-27T02:25:00.000Z",
    source: "aurora-console",
    channel: CHANNEL_AURORA_CONSOLE,
    model: MODEL_CLAUDE,
    cwdInProject: "packages/design-tokens",
    sessionId: "sess-aurora-sonnet-refactor-layout-engine-2026-09-27-b",
    requestId: "req-2026-09-27-002",
    tokens: [22000, 8000, 3600, 900],
    serviceTier: "priority",
  },
  {
    at: "2026-09-27T15:05:00.000Z",
    source: "aurora-console",
    channel: CHANNEL_AURORA_CONSOLE,
    model: MODEL_GLM,
    cwdInProject: "apps/console/src/adapters",
    sessionId: "sess-glm-nightly",
    tokens: [7500, 1200, 1400],
  },
  {
    at: "2026-09-28T04:55:00.000Z",
    source: "palette-cli",
    channel: CHANNEL_PALETTE_CLI,
    model: MODEL_GPT,
    cwdInProject: "src",
    sessionId: "sess-palette-gpt-long",
    requestId: "req-2026-09-28-003",
    tokens: [30000, 12500, 5200, 1500],
    serviceTier: "standard",
  },
  {
    at: "2026-09-28T19:30:00.000Z",
    source: "aurora-console",
    channel: CHANNEL_AURORA_CONSOLE,
    model: MODEL_MISSING_PRICE,
    cwdInProject: "packages/preview-renderer",
    sessionId: "sess-aurora-unpriced-experimental-longcontext-preview-run-c",
    tokens: [5400, 0, 900],
  },
  {
    at: "2026-09-29T08:15:00.000Z",
    source: "palette-cli",
    channel: CHANNEL_PALETTE_CLI,
    model: MODEL_CLAUDE,
    cwdInProject: "src/summarize",
    sessionId: "sess-palette-sonnet-docs",
    tokens: [18000, 6600, 4100, 1100],
  },
  {
    at: "2026-09-30T03:45:00.000Z",
    source: "aurora-console",
    channel: CHANNEL_AURORA_CONSOLE,
    model: MODEL_GLM,
    cwdInProject: "apps/console/src/views",
    sessionId: "sess-aurora-glm-view-assembly-d",
    tokens: [9800, 2300, 1600],
  },
  {
    at: "2026-10-01T11:20:00.000Z",
    source: "aurora-console",
    channel: CHANNEL_AURORA_CONSOLE,
    model: MODEL_GPT,
    cwdInProject: "apps/console",
    sessionId: "sess-aurora-gpt-large-context-migration-2026-10-01-e",
    requestId: "req-2026-10-01-004",
    tokens: [46000, 21000, 8800, 2400],
    serviceTier: "standard",
  },
  {
    at: "2026-10-01T22:05:00.000Z",
    source: "palette-cli",
    channel: CHANNEL_PALETTE_CLI,
    model: MODEL_MISSING_PRICE,
    cwdInProject: "src",
    sessionId: "sess-palette-unpriced-f",
    tokens: [3300, 0, 700],
  },
  {
    at: "2026-10-02T06:50:00.000Z",
    source: "aurora-console",
    channel: CHANNEL_AURORA_CONSOLE,
    model: MODEL_CLAUDE,
    cwdInProject: "packages/design-tokens/src",
    sessionId: "sess-aurora-sonnet-token-audit-2026-10-02-g",
    tokens: [27000, 9000, 5300, 1300],
  },
  {
    at: "2026-10-03T00:30:00.000Z",
    source: "palette-cli",
    channel: CHANNEL_PALETTE_CLI,
    model: MODEL_GLM,
    cwdInProject: "src/importer",
    sessionId: "sess-glm-day-h",
    requestId: "req-2026-10-03-005",
    tokens: [14000, 5000, 2900, 700],
  },
]);

const TIMELINE_WARNING_EVENT_SPEC = Object.freeze({
  at: "1860-01-01T00:00:00.000Z",
  source: "palette-cli",
  channel: CHANNEL_PALETTE_CLI,
  model: MODEL_GLM,
  cwdInProject: "src/importer",
  sessionId: "sess-d8s1-timeline-range-186001",
  requestId: "req-d8s1-timeline-range-186001",
  tokens: [1, 0, 0],
});
const TIMELINE_WARNING_EVENT_SPECS = Object.freeze([...EVENT_SPECS, TIMELINE_WARNING_EVENT_SPEC]);
const TIMELINE_WARNING_FIXTURE_RANGE = Object.freeze({ start: "1860-01-01", end: FIXTURE_RANGE.end });
const LOGICAL_IMPORT_PATHS = Object.freeze(["$PROJECT_ROOT", "$UNAVAILABLE_PROJECT_ROOT"]);

function buildUsage([input, cached, output, reasoning]) {
  const entry = { total: input + output, input, cached, output };
  if (reasoning > 0) entry.reasoning = reasoning;
  return entry;
}

function buildEventRow(spec, projectRoot) {
  return {
    schema_version: FIXTURE_LOG_SCHEMA,
    timestamp: spec.at,
    source: spec.source,
    channel: spec.channel,
    ...PROVIDER_PROFILES[spec.model],
    project_root: projectRoot,
    cwd: `${projectRoot}/${spec.cwdInProject}`,
    session_id: spec.sessionId,
    ...(spec.requestId ? { request_id: spec.requestId } : {}),
    model: spec.model,
    usage: buildUsage(spec.tokens),
    ...(spec.serviceTier ? { service_tier: spec.serviceTier } : {}),
  };
}

// 摘要覆盖固定事件、空 main 来源布局与已保存导入项，不包含随机临时路径。
function logicalContentDescriptor() {
  return {
    fixtureVersion: FIXTURE_VERSION,
    logSchema: FIXTURE_LOG_SCHEMA,
    range: FIXTURE_RANGE,
    imports: LOGICAL_IMPORT_PATHS.map((logicalPath) => ({ path: logicalPath })),
    sourceHomes: [
      {
        kind: "main",
        homePath: "$HOME/.codex",
        sessionsPath: "$HOME/.codex/sessions",
        sessionFiles: [],
        quotaSnapshots: [],
      },
    ],
    events: EVENT_SPECS.map((spec) => ({
      timestamp: spec.at,
      source: spec.source,
      channel: spec.channel,
      model: spec.model,
      providerProfile: PROVIDER_PROFILES[spec.model],
      cwdInProject: spec.cwdInProject,
      sessionId: spec.sessionId,
      requestId: spec.requestId ?? null,
      serviceTier: spec.serviceTier ?? null,
      usage: buildUsage(spec.tokens),
    })),
  };
}

export function getPaletteFixtureHash() {
  return sha256Canonical(logicalContentDescriptor());
}

export function getTimelineWarningFixtureHashDescriptor() {
  return {
    schema: "codex-usage.skin-palette.timeline-warning-fixture.v1",
    variant: { name: "timeline-range-warning", version: 1 },
    baseFixtureHash: getPaletteFixtureHash(),
    fixtureVersion: FIXTURE_VERSION,
    logSchema: FIXTURE_LOG_SCHEMA,
    range: TIMELINE_WARNING_FIXTURE_RANGE,
    imports: LOGICAL_IMPORT_PATHS.map((logicalPath) => ({ path: logicalPath })),
    usageLog: TIMELINE_WARNING_EVENT_SPECS.map((spec) => buildEventRow(spec, "$PROJECT_ROOT")),
  };
}

export function getTimelineWarningFixtureHash() {
  return sha256Canonical(getTimelineWarningFixtureHashDescriptor());
}

async function removeFixtureRoot(rootDir) {
  const resolved = path.resolve(rootDir);
  const tempRoot = path.resolve(tmpdir());
  if (resolved === tempRoot || !resolved.startsWith(`${tempRoot}${path.sep}`)) {
    throw new Error(`拒绝清理：fixture 目录不在系统临时目录内（${resolved}）`);
  }
  if (!path.basename(resolved).startsWith(FIXTURE_DIRECTORY_PREFIX)) {
    throw new Error(`拒绝清理：缺少 ${FIXTURE_DIRECTORY_PREFIX} 前缀（${path.basename(resolved)}）`);
  }
  await rm(resolved, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
}

/**
 * 创建隔离合成 fixture。返回 `{ homeDir, importStoreFile, databaseFile,
 * pickedPath, fixtureHash, close }`；所有写入都落在同一个临时目录内。
 * 消费方用 `createPaletteServerOptions(fixture)` 接线 `createUsageServer`，
 * 并在调用 `fixture.close()` 之前先自行关闭所建 server。
 */
async function createFixture(eventSpecs, fixtureHash) {
  const rootDir = await mkdtemp(path.join(tmpdir(), FIXTURE_DIRECTORY_PREFIX));
  const homeDir = path.join(rootDir, "home");
  const projectDir = path.join(rootDir, "palette-workspace");
  const unavailablePath = path.join(rootDir, "unavailable-project");
  const pickedPath = path.join(rootDir, "picked-project");
  const importStoreFile = path.join(homeDir, ".codex-usage", "imports.json");
  const databaseFile = path.join(homeDir, ".codex-usage", "usage-index.sqlite");

  try {
    await mkdir(path.join(homeDir, ".codex", "sessions"), { recursive: true });
    await mkdir(path.join(projectDir, ".codex-usage"), { recursive: true });
    await mkdir(unavailablePath, { recursive: true });
    await mkdir(pickedPath, { recursive: true });
    await mkdir(path.dirname(importStoreFile), { recursive: true });
    const rows = eventSpecs.map((spec) => buildEventRow(spec, projectDir));
    await writeFile(
      path.join(projectDir, ".codex-usage", "usage.jsonl"),
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    );
    // 通过当前导入配置接入：服务端 loadUsageStore 读取该存储条目后按
    // project-log 家目录扫描（server.js usageOptions → UsageStore.sync）。
    await writeFile(
      importStoreFile,
      `${JSON.stringify({ imports: [{ path: projectDir }, { path: unavailablePath }] }, null, 2)}\n`,
    );
  } catch (error) {
    try {
      await removeFixtureRoot(rootDir);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Fixture creation and temporary-directory cleanup both failed.");
    }
    throw error;
  }

  let closed = false;
  return {
    homeDir,
    importStoreFile,
    databaseFile,
    unavailablePath,
    pickedPath,
    fixtureHash,
    async close() {
      if (closed) return;
      // 删除成功后才置位：失败时保持未关闭状态，下次调用可重试。
      await removeFixtureRoot(rootDir);
      closed = true;
    },
  };
}

export async function createPaletteFixture() {
  return createFixture(EVENT_SPECS, getPaletteFixtureHash());
}

export async function createTimelineWarningFixture() {
  return createFixture(TIMELINE_WARNING_EVENT_SPECS, getTimelineWarningFixtureHash());
}

// 推荐的 createUsageServer 接线：env 清空、关闭自动计价发现（无外网），
// 目录选择走固定 pickedPath（浏览器流程不弹系统对话框）。
export function createPaletteServerOptions(fixture) {
  return {
    homeDir: fixture.homeDir,
    importStoreFile: fixture.importStoreFile,
    databaseFile: fixture.databaseFile,
    env: {},
    automaticDiscoveryEnabled: false,
    pricingFetcher: async () => new Response("Offline palette fixture", { status: 503 }),
    pickDirectory: async () => fixture.pickedPath,
  };
}
