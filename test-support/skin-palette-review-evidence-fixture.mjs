import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  canonicalFileContent,
  collectSourceHashes,
  hashCandidate,
  hashCandidateSet,
  hashRoleInputs,
  sha256Canonical,
} from "../scripts/skin-palette/contracts.mjs";
import { assessCandidate, VISUAL_REVIEW_ITEMS } from "../scripts/skin-palette/assess.mjs";
import { ROLE_CATALOG, STATE_CATALOG } from "../scripts/skin-palette/roles.mjs";
import {
  buildFixedMatrixFixtureBindings,
  SOURCE_FILES,
  STATE_MATRIX_GROUPS,
} from "../scripts/skin-palette/capture.mjs";
import { REPO_ROOT, buildReviewContainer, loadReviewEvidence } from "../scripts/skin-palette/review-evidence.mjs";
import { getPaletteFixtureHash, getTimelineWarningFixtureHash } from "./skin-palette-fixture.mjs";

export const POLICY = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));

/** 当前磁盘上全部注册捕获链路依赖文件的真实摘要（capture.json sourceHashes 的诚实登记）。 */
export const REAL_SOURCE_HASHES = collectSourceHashes(SOURCE_FILES, (relativePath) =>
  readFileSync(path.join(REPO_ROOT, relativePath)),
);
const REAL_SKINS_JS_DIGEST = REAL_SOURCE_HASHES["public/skins.js"];
export const HISTORICAL_SOURCE_FILES = ["public/skin-palettes.js", "public/skin-picker.js", "public/skin-bootstrap.js"];

const ALL_GROUP_IDS = STATE_MATRIX_GROUPS.map((group) => group.id);
export const ROLE_BY_ID = new Map(ROLE_CATALOG.map((role) => [role.id, role]));

/** 小 PNG 样本：PNG 签名 + 填充字节；核验只对字节做 SHA-256，不要求可渲染。 */
export const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 0),
]);

const FIXED_AT = "2026-10-06T00:00:00.000Z";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function makeHistoricalSourceSet(label) {
  const buffers = Object.fromEntries(HISTORICAL_SOURCE_FILES.map((file) => [file, Buffer.from(`${label}:${file}`)]));
  return {
    buffers,
    hashes: {
      ...REAL_SOURCE_HASHES,
      ...Object.fromEntries(HISTORICAL_SOURCE_FILES.map((file) => [file, sha256(buffers[file])])),
    },
  };
}

const LIGHT_TOKENS = Object.freeze({
  pageBackground: "#F5F2EC",
  panelBackground: "#FFFDF8",
  panelBorder: "#D8D2C4",
  panelHighlight: "#FFFFFF",
  panelShadow: "#B8B2A4",
  textPrimary: "#2A2721",
  textSecondary: "#6B6558",
  accent: "#4F4971",
  controlBackground: "#FFFFFF",
  controlBorder: "#D8D2C4",
  controlText: "#2A2721",
  chartText: "#2A2721",
});
const DARK_TOKENS = Object.freeze({
  pageBackground: "#1C1A16",
  panelBackground: "#26231D",
  panelBorder: "#3A362D",
  panelHighlight: "#4A453A",
  panelShadow: "#12100C",
  textPrimary: "#EDE8DC",
  textSecondary: "#A39C8C",
  accent: "#8F86C0",
  controlBackground: "#2E2A23",
  controlBorder: "#3A362D",
  controlText: "#EDE8DC",
  chartText: "#EDE8DC",
});

const IDENTITY_BY_SKIN = Object.freeze({
  chatgpt: "#4F4971",
  claude: "#B85C38",
  glm: "#2F6F8F",
  gemini: "#3D7A5C",
  deepseek: "#5A4F8F",
  kimi: "#8F2F5C",
  qwen: "#6B6FB4",
  grok: "#444444",
  muse: "#8F6B2F",
  mimo: "#2F8F8A",
});

const EXPECTED_ROLE_IDS_BY_STATE = new Map(
  STATE_CATALOG.map((state) => [state.id, Array.isArray(state.expectedRoleIds) ? state.expectedRoleIds : []]),
);

export function makeCandidate({ skinId = "chatgpt", variant = "a", derivationHash = REAL_SKINS_JS_DIGEST } = {}) {
  const identityHex = IDENTITY_BY_SKIN[skinId];
  if (!identityHex) throw new Error(`测试样本缺少皮肤 ${skinId} 的身份色`);
  const profileSnapshot = {
    identityHex,
    surfaceH: 268,
    surfaceC: 0.028,
    pageL: { light: 0.93, dark: 0.17 },
    accentC: 0.1,
  };
  const base = {
    schemaVersion: 1,
    skinId,
    variant,
    profileVersion: 1,
    profileSnapshot,
    profileHash: sha256Canonical(profileSnapshot),
    policyHash: sha256Canonical(POLICY),
    derivationHash,
    seed: "palette-redesign-v1",
    style: { title: "离线核验样本", rationale: "M4.4.2 核验样本", identitySource: identityHex },
    parameters: { light: {}, dark: {}, search: {} },
    modes: { light: { ...LIGHT_TOKENS }, dark: { ...DARK_TOKENS } },
  };
  const candidateHash = hashCandidate(base);
  return { ...base, id: `${skinId}-${variant}-${candidateHash.slice(0, 12)}`, candidateHash };
}

export function makeCandidateSet(candidates) {
  const base = {
    schemaVersion: 1,
    inputHashes: {
      profiles: "c".repeat(64),
      policy: sha256Canonical(POLICY),
      roles: hashRoleInputs(),
      derivation: REAL_SKINS_JS_DIGEST,
    },
    candidates,
    rejected: [],
  };
  return { ...base, candidateSetHash: hashCandidateSet(base) };
}

/**
 * 单状态测量判据：期望角色逐个 pass（无阈值角色按 not-applicable），与
 * browser-measure.mjs buildRecord 同形（10 字段）。落盘 checks.json 与原评审
 * 的 browser 记录由同一构造产生——判据比对要求两者逐条一致。
 */
function recordsForState(candidate, mode, stateId) {
  const expected = EXPECTED_ROLE_IDS_BY_STATE.get(stateId) ?? [];
  return expected.map((roleId) => {
    const role = ROLE_BY_ID.get(roleId);
    if (!role) throw new Error(`fixture：状态 ${stateId} 的期望角色 ${roleId} 不在 ROLE_CATALOG`);
    if (role.threshold === null) {
      return {
        candidateId: candidate.id,
        mode,
        roleId,
        stateId,
        result: "not-applicable",
        ratio: null,
        threshold: null,
        method: "not-applicable",
        evidence: "{}",
        reason: "无 DOM 选择器或阈值——视觉与规程覆盖",
      };
    }
    return {
      candidateId: candidate.id,
      mode,
      roleId,
      stateId,
      result: "pass",
      ratio: role.threshold * 1.5,
      threshold: role.threshold,
      method: "browser-text-pixels",
      evidence: JSON.stringify({ source: "m442-synthetic" }),
      reason: "",
    };
  });
}

/** 全矩阵测量记录：S0 基线（dashboard-default）+ 矩阵全部状态单元的状态集。 */
export function matrixRecords(candidate) {
  const records = [];
  for (const mode of ["light", "dark"]) {
    const seen = new Set();
    const push = (stateId) => {
      if (seen.has(stateId)) return;
      seen.add(stateId);
      records.push(...recordsForState(candidate, mode, stateId));
    };
    push("dashboard-default");
    for (const group of STATE_MATRIX_GROUPS) {
      for (const unit of group.units) {
        if (typeof unit.stateId === "string") push(unit.stateId);
      }
    }
  }
  return records;
}

export function visualAccept() {
  return {
    reviewer: "proxy-m442",
    by: "proxy",
    verdict: "accept",
    notes: "逐项看过原尺寸截图",
    items: VISUAL_REVIEW_ITEMS.map((item) => ({
      id: item.id,
      verdict: "accept",
      notes: `看过 ${item.label}`,
      screenshots: ["shots/light-dashboard.png"],
    })),
    screenshots: ["shots/light-dashboard.png"],
  };
}

/** 原始评审：用与 review-verify 重建完全一致的 run 上下文调 M3.4 得出。 */
export function realAssessment(candidate, set, browserChecks = null, sourceHashes = REAL_SOURCE_HASHES) {
  return assessCandidate({
    candidate,
    fastChecks: null,
    browserChecks: browserChecks ?? matrixRecords(candidate),
    visualReview: visualAccept(),
    run: {
      policy: POLICY,
      inputHashes: set.inputHashes,
      recordedInputHashes: { ...set.inputHashes },
      sourceHashes,
      recordedSourceHashes: sourceHashes,
      fixture: { version: POLICY.versions.fixture },
      recordedFixture: { version: POLICY.versions.fixture },
      candidateSet: set,
      candidateSetHash: set.candidateSetHash,
    },
  });
}

/** capture.json 里记录的候选身份七元组（capture.mjs 既有形状）。 */
const captureIdentity = (candidate) => ({
  id: candidate.id,
  candidateHash: candidate.candidateHash,
  skinId: candidate.skinId,
  variant: candidate.variant,
  profileHash: candidate.profileHash,
  policyHash: candidate.policyHash,
  derivationHash: candidate.derivationHash,
});

export const writeJson = async (absPath, value) => writeFile(absPath, `${JSON.stringify(value)}\n`, "utf8");

export const writeCandidates = async (runDir, candidateSet) =>
  writeFile(path.join(runDir, "candidates.json"), canonicalFileContent(candidateSet), "utf8");

export const writeAssessments = async (runDir, container) =>
  writeFile(path.join(runDir, "assessments.json"), canonicalFileContent(container), "utf8");

export const writeIndex = async (runDir, captures) =>
  writeJson(path.join(runDir, "captures-index.json"), { schemaVersion: 1, captures });

export async function createSandbox() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skin-palette-review-verify-"));
  const validationRoot = path.join(sandbox, "docs", "validation");
  await mkdir(validationRoot, { recursive: true });
  return {
    sandbox,
    validationRoot,
    makeRun: async (name) => {
      const run = path.join(validationRoot, name);
      await mkdir(run, { recursive: true });
      return run;
    },
    cleanup: () => rm(sandbox, { recursive: true, force: true }),
  };
}

export const load = (sandboxBox, runDir, capturesIndexPath) =>
  loadReviewEvidence({ runDir, capturesIndexPath, rootDir: sandboxBox.sandbox });

/** 复刻 capture.mjs hashEvidenceTree 的语义（排序遍历 + 逐文件 SHA-256/字节）。 */
async function hashEvidenceTreeLike(rootDir) {
  const entries = [];
  const walk = async (directory) => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      if (child.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      const bytes = await readFile(absolutePath);
      entries.push({
        file: path.relative(rootDir, absolutePath).split(path.sep).join("/"),
        sha256: sha256(bytes),
        bytes: bytes.length,
      });
    }
  };
  await walk(rootDir);
  return sha256Canonical(entries);
}

/**
 * S0 固定附件（M4.3 已验收口径，measureRoles=true）：5 个固定文件 + checks.json
 * （dashboard-default 判据与截图索引）+ captures/measure-1.png。jsonPatch 可在
 * 计摘要之前改 JSON 内容（born-consistent 的"摘要全部自洽但结论为假"样本）。
 */
async function writeBaselineMode(captureDir, mode, candidate, { jsonPatch = null } = {}) {
  const modeDir = path.join(captureDir, mode);
  await mkdir(path.join(modeDir, "captures"), { recursive: true });
  const jsonBody = (extra) => Buffer.from(`${JSON.stringify({ mode, skinId: candidate.skinId, ...extra })}\n`, "utf8");
  const measurePng = "captures/measure-1.png";
  // 键集必须与 capture.mjs:1274-1282 的真实 S0 输出一致（stateId/mode/
  // candidateId/records/counts/diagnostics/captureIndex——没有 kind/status/
  // schemaVersion/unitId）；夹具额外添加字段会掩盖校验与真实形状的失配。
  const baselineRecords = recordsForState(candidate, mode, "dashboard-default");
  const checks = {
    stateId: "dashboard-default",
    mode,
    candidateId: candidate.id,
    records: baselineRecords,
    counts: { records: baselineRecords.length },
    diagnostics: { source: "m442-fixture" },
    captureIndex: [{ index: 1, roleId: null, kind: "baseline", file: measurePng }],
  };
  const fileDefs = [
    ["baseline.png", PNG_BYTES],
    [
      "colors.json",
      jsonBody({ runtimeMatchesExpected: true, firstScreenMatchesRuntime: true, spotlight: { off: true } }),
    ],
    ["first-screen.json", jsonBody({ matches: true })],
    ["first-screen.png", PNG_BYTES],
    ["layout.json", jsonBody({})],
    ["checks.json", Buffer.from(`${JSON.stringify(checks)}\n`, "utf8")],
    [measurePng, PNG_BYTES],
  ];
  const entries = [];
  for (const [name, bytes] of fileDefs) {
    let finalBytes = bytes;
    if (jsonPatch && typeof jsonPatch[name] === "function") {
      const patched = jsonPatch[name](JSON.parse(bytes.toString("utf8")));
      finalBytes = Buffer.from(`${JSON.stringify(patched)}\n`, "utf8");
    }
    await writeFile(path.join(modeDir, name), finalBytes);
    entries.push({ file: name, sha256: sha256(finalBytes), bytes: finalBytes.length });
  }
  entries.sort((left, right) => left.file.localeCompare(right.file));
  return { schemaVersion: 1, measureRoles: true, files: entries, sha256: sha256Canonical(entries) };
}

/**
 * 状态单元证据目录：state/checks/geometry/state.png（S5 timeline 单元另带
 * checks.timeline-<view>.json + 视图截图 + measurementVariants/trace 登记），
 * 返回证据树哈希。
 */
async function writeStateUnit(
  captureDir,
  mode,
  unit,
  candidate,
  records,
  variantRecordOverrides = null,
  fixtureProofOverride = null,
  production = false,
) {
  const unitDir = path.join(captureDir, mode, "states", unit.id);
  await mkdir(unitDir, { recursive: true });
  const stateId = unit.stateId ?? null;
  const files = {
    state: "state.json",
    checks: "checks.json",
    geometry: "geometry.json",
    stateScreenshot: "state.png",
  };
  const trace = { roleScopeGaps: [] };
  if (unit.fixtureRequirement) {
    const { name, expectedHash } = unit.fixtureRequirement;
    // 合成测试证明只验证接线和拒绝路径，不代表真实 fixture 采样。
    const proof = { name, expectedHash, actualHash: expectedHash, match: true };
    trace.fixtureRequirement = fixtureProofOverride ? fixtureProofOverride(proof, { mode, unit }) : proof;
  }
  const state = {
    kind: "skin-palette-capture-state",
    status: "captured",
    unitId: unit.id,
    mode,
    skinId: candidate.skinId,
    stateId,
    files,
    screenshots: { state: "state.png" },
    captures: [],
    trace,
  };
  const checks = {
    schemaVersion: 1,
    kind: "skin-palette-capture-checks",
    status: "captured",
    unitId: unit.id,
    stateId,
    mode,
    candidateId: production ? null : candidate.id,
    records: production ? records.map((record) => ({ ...record, candidateId: null })) : records,
    captureIndex: [],
  };

  // S5 视图测量：每视图一份 checks.timeline-<view>.json + 截图，三处登记
  //（state.files / measurementVariants / trace.timelineModes.checks）缺一即
  // readCapturedUnitEvidence 拒绝。
  const timelineModes = Array.isArray(unit.timelineModeSequence) ? unit.timelineModeSequence : [];
  if (timelineModes.length > 0) {
    const timelineTrace = { checks: [] };
    const measurementVariants = {};
    for (const viewMode of timelineModes) {
      const checksFile = `checks.timeline-${viewMode}.json`;
      const captureFile = `timeline-${viewMode}-1.png`;
      const captureIndexForMode = [{ index: 1, roleId: null, kind: "timeline", file: captureFile }];
      // born-consistent 变体篡改进口：override 在写盘前改判据，证据树哈希按
      // 改后字节重算——文件完整性核验查不出，只有把变体判据纳入比对才能拦。
      const variantOverride = variantRecordOverrides?.[`${mode}/${unit.id}/${viewMode}`] ?? null;
      const variantRecords = variantOverride ? variantOverride(records) : records;
      await writeJson(path.join(unitDir, checksFile), {
        schemaVersion: 1,
        kind: "skin-palette-capture-checks",
        unitId: unit.id,
        stateId,
        mode,
        viewMode,
        candidateId: production ? null : candidate.id,
        status: "captured",
        records: production ? variantRecords.map((record) => ({ ...record, candidateId: null })) : variantRecords,
        captureIndex: captureIndexForMode,
      });
      await writeFile(path.join(unitDir, captureFile), PNG_BYTES);
      measurementVariants[viewMode] = { checks: checksFile, captureIndex: captureIndexForMode };
      timelineTrace.checks.push({
        mode: viewMode,
        measurementEvidence: { checks: checksFile, recordCount: records.length, captureCount: 1 },
      });
      const prefix = `timeline${viewMode[0].toUpperCase()}${viewMode.slice(1)}`;
      files[`${prefix}Checks`] = checksFile;
    }
    state.trace.timelineModes = timelineTrace;
    state.measurementVariants = measurementVariants;
    state.files = files;
  }

  const geometry = { unitId: unit.id, stateId, mode, skinId: candidate.skinId };
  await writeJson(path.join(unitDir, "state.json"), state);
  await writeJson(path.join(unitDir, "checks.json"), checks);
  await writeJson(path.join(unitDir, "geometry.json"), geometry);
  await writeFile(path.join(unitDir, "state.png"), PNG_BYTES);
  return hashEvidenceTreeLike(unitDir);
}

/** Write one registered fixture unit with the matrix helper's state, proof, and evidence-tree shape. */
export async function writeFixtureStateUnit({
  captureDir,
  mode,
  unit,
  candidate,
  records,
  production = false,
  fixtureProofOverride = null,
} = {}) {
  return writeStateUnit(captureDir, mode, unit, candidate, records, null, fixtureProofOverride, production);
}

/**
 * 写一个 M4.3 矩阵捕获目录。默认完整必要矩阵（全部组 × light/dark）；tweakCapture
 * / tweakProgress 在落盘前最后改一次（改动发生在 .1 加载之前，出处摘要按改后
 * 字节登记）；skipUnits 的单元不写证据目录（不可达/失败单元在真实捕获里本来
 * 就没有证据目录）；recordOverrides 按 "<mode>/<unitId>" 改写该单元落盘判据
 *（born-consistent 的"摘要自洽但判据与原评审不一致"样本）。
 */
export async function writeMatrixCapture(
  runDir,
  relativePath,
  candidate,
  {
    groups = ALL_GROUP_IDS,
    modes = ["light", "dark"],
    tweakCapture = null,
    tweakProgress = null,
    skipUnits = [],
    recordOverrides = null,
    variantRecordOverrides = null,
    fixtureProofOverride = null,
    baselineJsonPatch = null,
  } = {},
) {
  const dir = path.join(runDir, relativePath);
  await mkdir(dir, { recursive: true });
  const fixtureHash = getPaletteFixtureHash();
  const fixtureBindings = buildFixedMatrixFixtureBindings({
    groups,
    fixtureHash,
    warningFixtureHash: getTimelineWarningFixtureHash(),
  });
  const capture = {
    schemaVersion: 1,
    kind: "skin-palette-capture-matrix",
    tool: "scripts/skin-palette/capture.mjs",
    createdAt: FIXED_AT,
    candidate: captureIdentity(candidate),
    fixtureHash,
    fixtureBindings,
    policyHash: sha256Canonical(POLICY),
    // 逐份拷贝：tweakCapture 可能删键，绝不能污染模块级的 REAL_SOURCE_HASHES。
    sourceHashes: { ...REAL_SOURCE_HASHES },
    environment: {},
    stateTimeoutMs: 15000,
    baselineTimeoutMs: 15000,
    retryPolicy: { version: 1, maxAttemptsPerUnit: 2 },
    measureBaseline: true,
    groups,
    coverage: {},
    untested: [],
    modes: Object.fromEntries(modes.map((mode) => [mode, { status: "captured" }])),
  };
  if (tweakCapture) tweakCapture(capture);
  await writeFile(path.join(dir, "capture.json"), `${JSON.stringify(capture)}\n`, "utf8");
  const units = {};
  for (const mode of modes) {
    if (groups.includes("S0")) {
      const manifest = await writeBaselineMode(dir, mode, candidate, { jsonPatch: baselineJsonPatch });
      units[`${mode}/baseline`] = { status: "captured", attempts: 1, evidence: ".", baselineEvidence: manifest };
    }
    for (const group of STATE_MATRIX_GROUPS) {
      if (!groups.includes(group.id) || group.id === "S0") continue;
      for (const unit of group.units) {
        if (skipUnits.includes(`${mode}/${unit.id}`)) continue;
        const override = recordOverrides?.[`${mode}/${unit.id}`] ?? null;
        const baseRecords = typeof unit.stateId === "string" ? recordsForState(candidate, mode, unit.stateId) : [];
        const records = override ? override(baseRecords) : baseRecords;
        const evidenceHash = await writeStateUnit(
          dir,
          mode,
          unit,
          candidate,
          records,
          variantRecordOverrides,
          fixtureProofOverride,
        );
        units[`${mode}/${unit.id}`] = { status: "captured", attempts: 1, evidence: `states/${unit.id}`, evidenceHash };
      }
    }
  }
  const digests = {
    candidate: { id: candidate.id, candidateHash: candidate.candidateHash, skinId: candidate.skinId },
    candidateHash: candidate.candidateHash,
    skinId: candidate.skinId,
    retryPolicy: { version: 1, maxAttemptsPerUnit: 2 },
    policyHash: sha256Canonical(POLICY),
    fixtureHash,
    fixtureBindings: structuredClone(fixtureBindings),
    sourceHashes: { ...REAL_SOURCE_HASHES },
  };
  const progress = {
    schemaVersion: 1,
    kind: "skin-palette-capture-progress",
    tool: "scripts/skin-palette/capture.mjs",
    createdAt: FIXED_AT,
    digests,
    modes,
    groups,
    retryPolicy: { version: 1, maxAttemptsPerUnit: 2 },
    units,
    attempts: [],
  };
  if (tweakProgress) tweakProgress(progress);
  await writeFile(path.join(dir, "progress.json"), `${JSON.stringify(progress)}\n`, "utf8");
  return { capture, progress };
}

/**
 * 写总集出处文件（.1 扩展的 currentProfiles 通道样本）：逐候选登记本 run 内
 * 捕获的诚实摘要。currentProfiles=true 时先写 current-profiles.json——默认逐
 * 皮肤放候选 profileSnapshot（sha256Canonical === profileHash）；profilesPatch
 * 改写快照即配方漂移样本；profilesSource 整体替换文件内容（如缺条目样本）。
 * currentProfiles=null 显式登记"无来源"；undefined 省略该键（出处文件照写在）。
 */
export async function writeOriginsFile(
  runDir,
  candidates,
  { currentProfiles = undefined, profilesPatch = null, profilesSource = null } = {},
) {
  let profilesText = null;
  if (currentProfiles === true) {
    const profiles = {};
    for (const candidate of candidates) {
      profiles[candidate.skinId] = profilesPatch ? profilesPatch(candidate.profileSnapshot) : candidate.profileSnapshot;
    }
    profilesText = profilesSource ?? `${JSON.stringify(profiles)}\n`;
    await writeFile(path.join(runDir, "current-profiles.json"), profilesText, "utf8");
  }
  const origins = {};
  for (const candidate of candidates) {
    const captureDir = path.join(runDir, "captures", candidate.id);
    origins[candidate.id] = {
      batchRun: ".",
      capture: `captures/${candidate.id}`,
      visualReview: null,
      hashes: {
        candidates: sha256(await readFile(path.join(runDir, "candidates.json"))),
        capture: sha256(await readFile(path.join(captureDir, "capture.json"))),
        progress: sha256(await readFile(path.join(captureDir, "progress.json"))),
        visualReview: null,
      },
      ...(currentProfiles === undefined
        ? {}
        : {
            currentProfiles:
              currentProfiles === null ? null : { path: "current-profiles.json", sha256: sha256(profilesText) },
          }),
    };
  }
  await writeJson(path.join(runDir, "assessment-origins.json"), { schemaVersion: 1, origins });
}

/**
 * 组一个标准评审 run：候选集 + 全部候选捕获 + 评审容器（默认 M3.4 真实输出）
 * + 视觉初筛 + 可选选择记录，随后走 .1 真实加载。origins 非空时在载入前写
 * assessment-origins.json（须 captures=true，摘要取已落盘的捕获文件）。
 */
export async function buildRun(
  box,
  runName,
  candidates,
  {
    groups,
    modes,
    captures = true,
    captureOptions = null,
    assessments,
    withVisualReview = true,
    visualReviews = null,
    selections = null,
    indexIds = null,
    origins = null,
  } = {},
) {
  const runDir = await box.makeRun(runName);
  const set = makeCandidateSet(candidates);
  await writeCandidates(runDir, set);
  if (captures) {
    for (const candidate of candidates) {
      await writeMatrixCapture(runDir, `captures/${candidate.id}`, candidate, {
        ...(groups !== undefined ? { groups } : {}),
        ...(modes !== undefined ? { modes } : {}),
        ...(captureOptions ? captureOptions(candidate) : {}),
      });
    }
  }
  const indexed =
    !captures || indexIds === null
      ? captures
        ? candidates
        : []
      : candidates.filter((candidate) => indexIds.includes(candidate.id));
  await writeIndex(runDir, Object.fromEntries(indexed.map((candidate) => [candidate.id, `captures/${candidate.id}`])));
  let container = null;
  if (assessments !== null) {
    const list = assessments ?? candidates.map((candidate) => realAssessment(candidate, set));
    container = buildReviewContainer({ candidateSetHash: set.candidateSetHash, assessments: list });
    await writeAssessments(runDir, container);
  }
  if (withVisualReview) {
    const reviews = visualReviews ?? Object.fromEntries(candidates.map((candidate) => [candidate.id, visualAccept()]));
    await writeJson(path.join(runDir, "visual-review.json"), { schemaVersion: 1, reviews });
  }
  if (selections) await writeJson(path.join(runDir, "selections.json"), selections);
  if (origins !== null) await writeOriginsFile(runDir, candidates, origins);
  const evidence = await load(box, runDir, path.join(runDir, "captures-index.json"));
  return { runDir, set, container, evidence };
}

export const STATE_UNIT_COUNT = STATE_MATRIX_GROUPS.reduce(
  (count, group) => count + group.units.filter((unit) => unit.kind !== "baseline").length,
  0,
);
