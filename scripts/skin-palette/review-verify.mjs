/**
 * M4.4.2 离线核验（review-verify.mjs）
 * ============================================================================
 *
 * 消费 M4.4.1 loadReviewEvidence 的冻结输出，对评审证据做一次离线复核：
 *   block 1  逐候选核对身份与摘要——capture.json 的候选身份、progress.json 的
 *            摘要绑定、捕获链路全部依赖（capture.mjs 导出的 SOURCE_FILES，22 项）
 *            摘要的在场与一致。"缺摘要"（登记里根本没有某文件的摘要）与"不一致"
 *            （摘要与当前磁盘字节不符）分开报告。另做当前口径的独立核对：
 *            派生口径（candidate.derivationHash）必须等于当前 public/skins.js
 *            字节，也必须等于捕获时登记的字节；候选 profileSnapshot 的
 *            profileHash 自洽。"当前单皮肤配方"消费 .1 扩展的 currentProfiles
 *            出处通道（出处文件登记 { path, sha256 }，登记即核验）：按登记
 *            摘要重读来源、解析 profiles[skinId]、比对
 *            sha256Canonical(条目) === candidate.profileHash。未登记（含内部
 *            出处——无出处文件可登记）记 `current-profiles-unverifiable`，
 *            登记后字节漂移记 `current-profiles-source-changed`，来源不可读/
 *            缺该皮肤条目记 `current-profiles-source-invalid`，配方不一致记
 *            `current-recipe-drift`——四类都是阻断缺件，一致才放行 pass。
 *   block 2  在原批次 run 上下文里调用 M3.4 assessCandidate 复核。落盘的
 *            readiness 一律不信——readiness 由重算得出；run.inputHashes 取原
 *            批次 candidates.json（绝不把当前总集的 profiles 摘要塞进原评审），
 *            当前源文件 / roles / fixture 的漂移会以 STALE_EVIDENCE 落进重算结论。
 *   block 3  M4.3 捕获完整性：progress 自报的组与模式必须覆盖完整必要矩阵
 *            （STATE_MATRIX_GROUPS 全部组 + light/dark 两模式）——局部捕获保留
 *            为 incomplete，绝不当完整证据。核对单元状态（缺一必要状态即不
 *            通过）、浅深配对（单侧缺测/单侧不可达都是配对破坏）、captured
 *            单元证据树（capture.mjs 的 readCapturedUnitEvidence，含几何与原图
 *            哈希）与 S0 固定附件清单（固定附件集合、JSON 身份与一致性结论、
 *            测量开启时的 checks.json 与截图索引——M4.3 已验收口径）。单元
 *            证据树自洽不能替代测量结果核验：落盘判据必须与用于重算的原
 *            Assessment 测量记录按 (mode, stateId) 逐条一致——磁盘上的
 *            fail/unmeasured 若不被原评审反映是旧评审掩盖失败，原评审的记录
 *            若没有落盘判据支撑则结论无从追溯。双侧一致 unreachable 只对矩阵
 *            里登记了 precondition 预案的状态豁免（当前即 quota-toast 一类已知
 *            触发不到的单元）；正常可触发的状态双侧标不可达一律阻断。
 *   选择      requireSelections=true 时在重算后的容器哈希上核对十套 choices 与
 *            candidateSetHash / assessmentHash 两个总摘要绑定。
 *   正式身份  production=true 只验正式身份（capture.candidate.production=true 且
 *            skinId 合法）；source 变更规则等待 M4.4.7 适配。
 *
 * 状态语义（卡面固定四种）：
 *   invalid    契约被破坏（身份/摘要绑定矛盾、复核抛错）——verifiedModel=null；
 *   rejected   任一候选重算结论为 rejected——保留显示模型与诊断，禁选；
 *   incomplete 有必要缺件（缺摘要、不一致、缺测、捕获失败、出处不全、
 *              重算退步、当前配方无法核对）——保留显示模型与诊断，禁选；
 *   pass       无错误、无阻断缺件。当前配方来源已登记且与候选 profileHash
 *              一致时可达；已知不可达单元（有 precondition 预案、两侧一致
 *              unreachable）记非阻断缺件，在诊断里可见。
 *
 * 离线承诺：不写任何证据文件、不启动服务/浏览器/生成器。只读 evidence 已绑定
 * 的路径与仓库源文件；对再次读盘的文件一律重验 SHA-256 与包含关系（.1 载入与
 * 本核验之间落盘内容可能变化，重验后结论才绑定到已核字节上）。
 *
 * 前置契约：evidence 必须是 loadReviewEvidence 的返回值（路径已过词法 + realpath
 * 双重包含校验；selections / 评审容器已过 M0 校验）。本模块对 .1 已核过的绑定
 * 做防御性复核——手工构造的 evidence 对象不在支持范围内。
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { isProxy } from "node:util/types";
import path from "node:path";

import {
  canonicalJson,
  collectSourceHashes,
  sha256Canonical,
  validateCandidateSet,
  validateSelections,
  SKIN_IDS,
} from "./contracts.mjs";
import { assessCandidate } from "./assess.mjs";
import { createReviewFocusSupplement } from "./review-focus-supplement.mjs";
import { STATE_CATALOG } from "./roles.mjs";
import { SOURCE_FILES, STATE_MATRIX_GROUPS, readCapturedUnitEvidence } from "./capture.mjs";
import {
  REPO_ROOT,
  REVIEW_EVIDENCE_SCHEMA_VERSION,
  buildReviewContainer,
  hashReviewContainer,
} from "./review-evidence.mjs";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export const REVIEW_VERIFY_SCHEMA_VERSION = 1;

/** 卡面固定：status 只能是这四种。 */
export const REVIEW_VERIFY_STATUSES = Object.freeze(["pass", "incomplete", "rejected", "invalid"]);

/** 契约级错误码（出现任一项 → status=invalid，verifiedModel=null）。 */
export const REVIEW_VERIFY_ERROR_CODES = Object.freeze([
  "INVALID_INPUT",
  "EVIDENCE_SHAPE",
  "CONTAINER_HASH_MISMATCH",
  "CAPTURE_IDENTITY_MISMATCH",
  "CAPTURE_FIXTURE_HEADER_INVALID",
  "PROFILE_HASH_MISMATCH",
  "PROGRESS_IDENTITY_MISMATCH",
  "CAPTURE_ORIGIN_MISMATCH",
  "ORIGIN_DIGEST_MISMATCH",
  "ORIGIN_SET_MISMATCH",
  "ORIGIN_CANDIDATE_MISMATCH",
  "REASSESSMENT_FAILED",
  "SELECTIONS_SET_MISMATCH",
  "SELECTIONS_HASH_MISMATCH",
  "PRODUCTION_IDENTITY",
  "FOCUS_SUPPLEMENT_INVALID",
]);

/** M4.3 progress.json 的矩阵 kind（capture.mjs 既有常量语义）。 */
const MATRIX_KIND = "skin-palette-capture-matrix";

const UNIT_BY_GROUP = new Map(STATE_MATRIX_GROUPS.map((group) => [group.id, group]));

/** 完整必要矩阵：全部登记组（局部捕获不算完整证据——复核第 1 项）。 */
const ALL_GROUP_IDS = STATE_MATRIX_GROUPS.map((group) => group.id);
const STANDARD_MODES = Object.freeze(["light", "dark"]);
const HISTORICAL_SOURCE_FILES = Object.freeze([
  "public/skin-palettes.js",
  "public/skin-picker.js",
  "public/skin-bootstrap.js",
]);
const HISTORICAL_SOURCE_FILE_SET = new Set(HISTORICAL_SOURCE_FILES);

/** S0 基线的固定口径（capture.mjs BASELINE_STATE_ID 同值，该常量未导出）。 */
const BASELINE_STATE_ID = "dashboard-default";
const BASELINE_FIXED_FILES = Object.freeze([
  "baseline.png",
  "colors.json",
  "first-screen.json",
  "first-screen.png",
  "layout.json",
]);
const BASELINE_JSON_FILES = Object.freeze(["colors.json", "first-screen.json", "layout.json"]);

/** 状态目录 → 该状态必须出现的角色（capture.mjs 续跑校验同口径）。 */
const EXPECTED_ROLE_IDS_BY_STATE = new Map(
  STATE_CATALOG.map((state) => [state.id, Array.isArray(state.expectedRoleIds) ? state.expectedRoleIds : []]),
);

/**
 * 测量记录的语义元组：判据比对只看测量语义（谁、哪种模式、哪个角色、哪个状态、
 * 结论、比值、阈值、方法），evidence/reason 这类叙述字段不参与——文件完整性
 * 核验归证据树，这里核的是"测量结果本身是否被原评审如实反映"。
 */
function semanticRecordTuple(record) {
  return {
    candidateId: record.candidateId,
    mode: record.mode,
    roleId: record.roleId,
    stateId: record.stateId,
    result: record.result,
    ratio: record.ratio,
    threshold: record.threshold,
    method: record.method,
  };
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isSha256 = (value) => typeof value === "string" && SHA256_PATTERN.test(value);

function sha256Of(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * 证据树哈希重算（capture.mjs hashEvidenceTree 同语义：排序遍历、拒符号链接
 * 与非普通文件、逐文件 SHA-256/字节、sha256Canonical）：用于把"续跑校验之后
 * 再单独重读的文件"钉回已核验的字节——读出的字节若不属于这棵树，重算即失配。
 */
async function hashEvidenceTreeOf(rootDir, captureFile = null) {
  const rootReal = await realpath(rootDir);
  const entries = [];
  let capturedFile = null;
  const walk = async (directory) => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolutePath = path.join(directory, child.name);
      if (child.isSymbolicLink()) throw new Error(`证据目录包含符号链接：${path.relative(rootReal, absolutePath)}`);
      if (child.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!child.isFile()) throw new Error(`证据目录包含非普通文件：${path.relative(rootReal, absolutePath)}`);
      const bytes = await readFile(absolutePath);
      const file = path.relative(rootReal, absolutePath).split(path.sep).join("/");
      const entry = {
        file,
        sha256: sha256Of(bytes),
        bytes: bytes.length,
      };
      entries.push(entry);
      if (file === captureFile) capturedFile = { ...entry, content: bytes };
    }
  };
  await walk(rootReal);
  if (entries.length === 0) throw new Error("证据目录为空");
  const hash = sha256Canonical(entries);
  return captureFile === null ? hash : { hash, capturedFile };
}

const pngDataUrl = (bytes) => `data:image/png;base64,${bytes.toString("base64")}`;

async function readVerifiedStatePng(captureDirReal, unitDirPath, mode, unitId, expectedEvidenceHash) {
  const relativePath = `${mode}/states/${unitId}/state.png`;
  const before = await readContainedBytes(captureDirReal, relativePath);
  if (before === null) throw new Error(`单元 ${mode}/${unitId} state.png 缺失或包含链接`);
  const tree = await hashEvidenceTreeOf(unitDirPath, "state.png");
  const after = await readContainedBytes(captureDirReal, relativePath);
  if (
    tree.hash !== expectedEvidenceHash ||
    tree.capturedFile === null ||
    after === null ||
    sha256Of(before) !== tree.capturedFile.sha256 ||
    before.length !== tree.capturedFile.bytes ||
    sha256Of(after) !== tree.capturedFile.sha256 ||
    after.length !== tree.capturedFile.bytes
  ) {
    throw new Error(`单元 ${mode}/${unitId} state.png 未能钉回已核验的证据树`);
  }
  return tree.capturedFile.content;
}

/**
 * 在根目录包含范围内读取文件：逐段 lstat 拒绝符号链接/junction，realpath 落回
 * 根内才读（与 .1 readContainedFile 同语义；本模块自带一份，避免改动已冻结的
 * M4.4.1 交付物）。任何越界/缺失/链接都返回 null，由调用方决定记什么缺件。
 */
async function readContainedBytes(rootReal, relativePosix) {
  if (typeof relativePosix !== "string" || relativePosix.length === 0) return null;
  if (relativePosix.includes("\\") || path.posix.isAbsolute(relativePosix)) return null;
  const segments = relativePosix.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  let current = rootReal;
  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch {
      return null;
    }
    if (info.isSymbolicLink()) return null;
  }
  try {
    const real = await realpath(current);
    const rel = path.relative(rootReal, real);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    return await readFile(real);
  } catch {
    return null;
  }
}

/** 历史源快照只接收三份原始 Buffer；复制发生在 verifier 的首个 await 之前。 */
function cloneSourceSnapshot(sourceSnapshot) {
  try {
    if (
      sourceSnapshot === null ||
      typeof sourceSnapshot !== "object" ||
      Array.isArray(sourceSnapshot) ||
      isProxy(sourceSnapshot)
    ) {
      return null;
    }
    const prototype = Object.getPrototypeOf(sourceSnapshot);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(sourceSnapshot);
    if (
      keys.length !== HISTORICAL_SOURCE_FILES.length ||
      keys.some((key) => typeof key !== "string" || !HISTORICAL_SOURCE_FILE_SET.has(key))
    ) {
      return null;
    }
    const copy = Object.create(null);
    for (const key of HISTORICAL_SOURCE_FILES) {
      const descriptor = Object.getOwnPropertyDescriptor(sourceSnapshot, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !Buffer.isBuffer(descriptor.value)) return null;
      copy[key] = Buffer.from(descriptor.value);
    }
    return copy;
  } catch {
    return null;
  }
}

/** 只对登记键取字节；获准的历史源码来自快照，其余文件始终读取当前磁盘。 */
function currentSourceHashesFor(recordedKeys, sourceSnapshot = null) {
  const readSource = (relativePath) =>
    sourceSnapshot !== null && HISTORICAL_SOURCE_FILE_SET.has(relativePath)
      ? sourceSnapshot[relativePath]
      : readFileSync(path.join(REPO_ROOT, relativePath));
  try {
    return {
      hashes: collectSourceHashes([...recordedKeys].sort(), (relativePath) => readSource(relativePath)),
      unreadable: [],
    };
  } catch {
    // collectSourceHashes 遇到首个读不了的文件即抛：退化为逐键读取，把读不了的
    // 文件单独记"缺摘要"（磁盘上没有了，不是摘要对不上）。
    const hashes = {};
    const unreadable = [];
    for (const relativePath of [...recordedKeys].sort()) {
      try {
        hashes[relativePath] = sha256Of(readSource(relativePath));
      } catch {
        unreadable.push(relativePath);
      }
    }
    return { hashes, unreadable };
  }
}

/** 期望单元清单：与 capture.mjs effectiveMatrixUnits 同序同集（组按登记顺序展开）。 */
function expectedMatrixUnits(groupIds) {
  if (!Array.isArray(groupIds) || groupIds.length === 0) return null;
  const units = [];
  for (const groupId of groupIds) {
    const group = UNIT_BY_GROUP.get(groupId);
    if (!group) return null;
    for (const unit of group.units) units.push(unit);
  }
  return units;
}

/**
 * 当前配方来源核验（block 1 补充，消费 .1 扩展的 currentProfiles 出处通道）：
 *   未登记 / 内部出处（无出处文件可登记）→ current-profiles-unverifiable（缺来源）；
 *   已登记但重读字节与登记摘要不符 → current-profiles-source-changed（.1 载入与
 *   本核验之间落盘可能变化，结论只绑定已核字节）；
 *   来源不可读 / 非合法 JSON / 缺少该皮肤条目 → current-profiles-source-invalid；
 *   sha256Canonical(profiles[skinId]) ≠ candidate.profileHash → current-recipe-drift
 *   （候选派生自的配方与当前配方来源不一致——与 generate.mjs 的
 *   profileHash = sha256Canonical(profiles[skinId]) 同口径）；
 *   一致 → 不记缺件，pass 可达。路径包含关系由 readContainedBytes 复核（留在
 *   原 run 内；.1 载入期已核过一次，这里同时拦手工构造的 evidence）。
 */
async function verifyCurrentProfiles({ evidence, origin, candidate, runDirReal, gaps }) {
  const push = (code, detail) => gaps.push({ code, candidateId: candidate.id, detail, blocking: true });
  const ref = isPlainObject(origin.currentProfiles) ? origin.currentProfiles : null;
  if (evidence.origins?.source !== "file" || ref === null) {
    push(
      "current-profiles-unverifiable",
      evidence.origins?.source === "file"
        ? "当前单皮肤 profileSnapshot 无来源可核对：assessment-origins.json 未登记 currentProfiles——登记后 pass 才可达"
        : "当前单皮肤 profileSnapshot 无来源可核对：内部出处没有出处文件、无法登记 currentProfiles——补总集出处文件并登记后 pass 才可达",
    );
    return;
  }
  if (
    typeof ref.path !== "string" ||
    ref.path.length === 0 ||
    typeof ref.sha256 !== "string" ||
    !SHA256_PATTERN.test(ref.sha256)
  ) {
    push(
      "current-profiles-unverifiable",
      "currentProfiles 登记形状非法（须为 { path, sha256 }，sha256 为 64 位小写 hex）——无法核对当前配方",
    );
    return;
  }
  const bytes = await readContainedBytes(runDirReal, ref.path);
  if (bytes === null) {
    push("current-profiles-source-changed", `当前配方来源不可读（登记 ${ref.path}）——.1 登记后落盘已变化`);
    return;
  }
  if (sha256Of(bytes) !== ref.sha256) {
    push(
      "current-profiles-source-changed",
      "当前配方来源字节摘要与出处登记不一致——载入后落盘已变化，核验不绑定未核字节",
    );
    return;
  }
  let profilesValue;
  try {
    profilesValue = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    push(
      "current-profiles-source-invalid",
      `当前配方来源不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`,
    );
    return;
  }
  const entry = isPlainObject(profilesValue) ? profilesValue[candidate.skinId] : undefined;
  if (!isPlainObject(entry)) {
    push("current-profiles-source-invalid", `当前配方来源缺少皮肤 "${candidate.skinId}" 的配方条目`);
    return;
  }
  if (sha256Canonical(entry) !== candidate.profileHash) {
    push(
      "current-recipe-drift",
      "当前配方来源的 profileSnapshot 与候选 profileHash 不一致——候选派生自旧配方，当前配方已漂移",
    );
  }
}

/**
 * 离线核验主入口。
 *
 * @param {{ evidence: object, requireSelections?: boolean, production?: boolean, sourceSnapshot?: object }} options
 *   evidence — loadReviewEvidence 的返回值（深冻对象；本模块不再修改）。
 *   requireSelections — true 时额外核对十套选择与两个总摘要绑定。
 *   production — true 时走正式身份核验（M4.4.7 适配前的最小口径）。
 *   sourceSnapshot — 仅供历史候选重核的三文件 Buffer 字节；任何返回均标
 *                    sourceContext:"historical"，不能当作当前正式核验。
 * @returns {Promise<{status, errors, gaps, verifiedModel, sourceContext?}>}
 *   status ∈ pass / incomplete / rejected / invalid；errors 契约级错误；
 *   gaps 缺件（含 blocking 标记）；verifiedModel 仅 status≠invalid 时非空，
 *   深冻、无时间戳（同一 evidence + 未变磁盘 → canonicalJson 逐字节一致）。
 */
export async function verifyReviewEvidence({
  evidence,
  requireSelections = false,
  production = false,
  sourceSnapshot,
} = {}) {
  const errors = [];
  const gaps = [];
  const historical = sourceSnapshot !== undefined;
  const withSourceContext = (result) => (historical ? { ...result, sourceContext: "historical" } : result);
  const invalid = () => withSourceContext({ status: "invalid", errors, gaps, verifiedModel: null });

  if (typeof requireSelections !== "boolean" || typeof production !== "boolean") {
    errors.push({ code: "INVALID_INPUT", candidateId: null, detail: "requireSelections / production 必须是布尔值" });
    return invalid();
  }
  let historicalSourceSnapshot = null;
  if (historical) {
    if (production) {
      errors.push({
        code: "INVALID_INPUT",
        candidateId: null,
        detail: "sourceSnapshot 仅供历史候选重核，不能与 production=true 一起使用",
      });
      return invalid();
    }
    historicalSourceSnapshot = cloneSourceSnapshot(sourceSnapshot);
    if (historicalSourceSnapshot === null) {
      errors.push({
        code: "INVALID_INPUT",
        candidateId: null,
        detail: "sourceSnapshot 必须是普通或 null-prototype 对象，且只含三份指定源码的 Buffer 自有数据属性",
      });
      return invalid();
    }
  }
  if (!isPlainObject(evidence) || evidence.schemaVersion !== REVIEW_EVIDENCE_SCHEMA_VERSION) {
    errors.push({
      code: "EVIDENCE_SHAPE",
      candidateId: null,
      detail: `evidence 必须是 loadReviewEvidence 的输出（schemaVersion=${REVIEW_EVIDENCE_SCHEMA_VERSION}）`,
    });
    return invalid();
  }
  if (!isPlainObject(evidence.run) || typeof evidence.run.dir !== "string") {
    errors.push({ code: "EVIDENCE_SHAPE", candidateId: null, detail: "evidence.run.dir 缺失——不是 .1 的加载产物" });
    return invalid();
  }
  if (production && requireSelections) {
    errors.push({
      code: "INVALID_INPUT",
      candidateId: null,
      detail: "正式身份核验没有候选集与选择记录，requireSelections 与 production 不能同时为真",
    });
    return invalid();
  }
  if (production) {
    // 正式证据没有候选集（M4.4.7 适配的 evidence 形状），先于候选集形状检查分发。
    return verifyProduction({ evidence, errors, gaps });
  }
  if (!isPlainObject(evidence.candidateSet) || !isPlainObject(evidence.candidateSet.data)) {
    errors.push({ code: "EVIDENCE_SHAPE", candidateId: null, detail: "evidence.candidateSet.data 缺失" });
    return invalid();
  }

  const displaySet = evidence.candidateSet.data;
  const candidates = Array.isArray(displaySet.candidates) ? displaySet.candidates : [];
  const runDirReal = evidence.run.dir;
  const reviewPresent = evidence.review?.present === true;
  const loadedContainer = reviewPresent ? evidence.review.container : null;
  const originalAssessmentById = new Map(
    (Array.isArray(loadedContainer?.assessments) ? loadedContainer.assessments : []).map((a) => [a.candidateId, a]),
  );
  let focusRegistrations;
  try {
    focusRegistrations = await readFocusRegistrations(runDirReal, candidates);
  } catch (error) {
    errors.push({ code: "FOCUS_SUPPLEMENT_INVALID", candidateId: null, detail: String(error.message ?? error) });
    return invalid();
  }

  // 防御性复核：容器自身哈希（.1 已核过一次，这里拦手工构造/载入后替换）。
  if (loadedContainer) {
    const recomputed = hashReviewContainer({
      schemaVersion: loadedContainer.schemaVersion,
      candidateSetHash: loadedContainer.candidateSetHash,
      assessments: loadedContainer.assessments,
    });
    if (loadedContainer.assessmentHash !== recomputed) {
      errors.push({
        code: "CONTAINER_HASH_MISMATCH",
        candidateId: null,
        detail: "载入评审容器的 assessmentHash 与内容摘要不一致",
      });
    }
  }

  // .1 的缺项照单全收（都是"记录不在场"级别的阻断缺件）；选择绑定缺证只在
  // 本轮要求选择时才阻断——不核选择时它只是提示。
  for (const gap of Array.isArray(evidence.gaps) ? evidence.gaps : []) {
    const blocking = !(gap.code === "selections-assessment-hash-unverified" && !requireSelections);
    gaps.push({ code: gap.code, candidateId: gap.candidateId ?? null, detail: gap.detail ?? "", blocking });
  }

  const reAssessedById = new Map();
  const verifiedUnitTrees = [];
  const collectedBaselineImages = [];
  const collectedImageAssets = [];

  // 当前派生口径的比较基点：public/skins.js 的当前磁盘摘要（读不到按 null
  // 处理，缺摘要一类缺件已由源摘要核对覆盖）。
  let currentSkinsJsDigest = null;
  try {
    currentSkinsJsDigest = collectSourceHashes(["public/skins.js"], (relativePath) =>
      readFileSync(path.join(REPO_ROOT, relativePath)),
    )["public/skins.js"];
  } catch {
    currentSkinsJsDigest = null;
  }

  for (const candidate of candidates) {
    if (!isPlainObject(candidate) || typeof candidate.id !== "string") {
      errors.push({ code: "EVIDENCE_SHAPE", candidateId: null, detail: "候选集里有非候选条目" });
      continue;
    }
    const candidateId = candidate.id;

    const captureRecord = isPlainObject(evidence.captures) ? evidence.captures[candidateId] : undefined;
    if (!isPlainObject(captureRecord) || typeof captureRecord.dir !== "string") {
      // capture-missing 已由 .1 记入 gaps；这里没有可核的东西，跳到下一候选。
      continue;
    }
    const captureDirReal = captureRecord.dir;

    // ---- 出处与原批次上下文（block 2 的地基） ----
    const origin = isPlainObject(evidence.origins?.origins) ? evidence.origins.origins[candidateId] : undefined;
    if (!isPlainObject(origin) || !isPlainObject(origin.hashes)) {
      // origin-missing 已由 .1 记入 gaps；没有出处就无法重建原批次上下文。
      continue;
    }

    // captures-index 绑定的捕获目录必须就是出处登记的目录：两者不一致说明
    // 索引与出处各说各话，证据自相矛盾。
    if (typeof origin.capture === "string" && origin.capture !== ".") {
      try {
        const originCaptureReal = await realpath(path.resolve(runDirReal, origin.capture));
        if (originCaptureReal !== captureDirReal) {
          errors.push({
            code: "CAPTURE_ORIGIN_MISMATCH",
            candidateId,
            detail: `captures-index 绑定 ${toPosixRel(runDirReal, captureDirReal)}，出处登记 ${origin.capture}——两者必须是同一捕获目录`,
          });
          continue;
        }
      } catch {
        errors.push({ code: "CAPTURE_ORIGIN_MISMATCH", candidateId, detail: "出处登记的捕获目录无法解析" });
        continue;
      }
    }

    // 重读 capture.json / progress.json 并对回出处登记的字节摘要：.1 载入之后
    // 磁盘可能被改动，核验结论必须绑定到"现在还在"的字节上。
    const captureBytes = await readContainedBytes(captureDirReal, "capture.json");
    if (captureBytes === null) {
      gaps.push({
        code: "origin-file-changed",
        candidateId,
        detail: "capture.json 现在读不到（.1 载入后磁盘已变化）——请重新 loadReviewEvidence",
        blocking: true,
      });
      continue;
    }
    if (sha256Of(captureBytes) !== origin.hashes.capture) {
      gaps.push({
        code: "origin-file-changed",
        candidateId,
        detail: "capture.json 字节与出处登记摘要不一致（.1 载入后磁盘已变化）——请重新 loadReviewEvidence",
        blocking: true,
      });
      continue;
    }
    let captureJson;
    try {
      captureJson = JSON.parse(captureBytes.toString("utf8"));
    } catch {
      gaps.push({ code: "origin-file-changed", candidateId, detail: "capture.json JSON 损坏", blocking: true });
      continue;
    }

    let progressJson = null;
    if (origin.hashes.progress !== null && origin.hashes.progress !== undefined) {
      const progressBytes = await readContainedBytes(captureDirReal, "progress.json");
      if (progressBytes === null || sha256Of(progressBytes) !== origin.hashes.progress) {
        gaps.push({
          code: "origin-file-changed",
          candidateId,
          detail: "progress.json 缺失或字节与出处登记摘要不一致——请重新 loadReviewEvidence",
          blocking: true,
        });
      } else {
        try {
          progressJson = JSON.parse(progressBytes.toString("utf8"));
        } catch {
          gaps.push({ code: "origin-file-changed", candidateId, detail: "progress.json JSON 损坏", blocking: true });
        }
      }
    }

    // ---- block 1：身份与摘要绑定 ----
    const captureCandidate = captureJson.candidate;
    if (
      !isPlainObject(captureCandidate) ||
      captureCandidate.id !== candidateId ||
      captureCandidate.candidateHash !== candidate.candidateHash ||
      captureCandidate.skinId !== candidate.skinId
    ) {
      errors.push({
        code: "CAPTURE_IDENTITY_MISMATCH",
        candidateId,
        detail: "capture.json 的候选身份（id / candidateHash / skinId）与候选集不一致",
      });
      continue;
    }
    if (isPlainObject(progressJson)) {
      const digests = progressJson.digests;
      if (!isPlainObject(digests)) {
        gaps.push({
          code: "progress-digests-missing",
          candidateId,
          detail: "progress.json 没有 digests 摘要绑定（缺摘要）",
          blocking: true,
        });
      } else {
        if (digests.candidateHash !== undefined && digests.candidateHash !== candidate.candidateHash) {
          errors.push({
            code: "PROGRESS_IDENTITY_MISMATCH",
            candidateId,
            detail: "progress.json digests.candidateHash 与候选集不一致",
          });
          continue;
        }
        if (digests.skinId !== undefined && digests.skinId !== candidate.skinId) {
          errors.push({
            code: "PROGRESS_IDENTITY_MISMATCH",
            candidateId,
            detail: "progress.json digests.skinId 与候选集不一致",
          });
          continue;
        }
      }
    }

    if (captureJson.kind === MATRIX_KIND) {
      try {
        const { inspectReviewCaptureFixtureHeaders } = await import("./review-capture.mjs");
        for (const gap of inspectReviewCaptureFixtureHeaders({
          capture: captureJson,
          progress: progressJson,
          modes: captureJson.modes,
        })) {
          gaps.push({
            code: "capture-fixture-bindings-missing",
            candidateId,
            mode: gap.mode,
            unitId: gap.unitId,
            detail: gap.detail,
            blocking: true,
          });
        }
      } catch (error) {
        errors.push({
          code: "CAPTURE_FIXTURE_HEADER_INVALID",
          candidateId,
          detail: `capture/progress fixture header invalid: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
    }

    // 原批次总集：batchRun="." 用本 run 的候选集；跨批引用读原批次的
    // candidates.json（路径已被 .1 包含校验过，这里对回登记摘要再钉一次字节）。
    let originalSet = null;
    if (origin.batchRun === ".") {
      originalSet = displaySet;
    } else {
      originalSet = await loadOriginalBatchSet({ runDirReal, origin, candidateId, errors, gaps });
      if (originalSet === null) continue;
    }

    const originalAssessment = originalAssessmentById.get(candidateId);
    if (!originalAssessment) {
      // assessment-missing 已由 .1 记入 gaps；没有原始评审就无从复核。
      continue;
    }
    const evidenceMeta = isPlainObject(originalAssessment.diagnostics?.evidence)
      ? originalAssessment.diagnostics.evidence
      : null;
    if (evidenceMeta === null) {
      gaps.push({
        code: "assessment-evidence-missing",
        candidateId,
        detail: "原评审没有 diagnostics.evidence 出处记录——无法重建证据产出时的输入",
        blocking: true,
      });
      continue;
    }
    if (
      typeof originalSet.candidateSetHash === "string" &&
      typeof evidenceMeta.candidateSetHash === "string" &&
      originalSet.candidateSetHash !== evidenceMeta.candidateSetHash
    ) {
      errors.push({
        code: "ORIGIN_SET_MISMATCH",
        candidateId,
        detail: "原批次总集哈希与原评审记录的 candidateSetHash 不一致——出处指向的总集不是原评审所用",
      });
      continue;
    }
    const originEntry = originalSet.candidates.find((entry) => entry?.id === candidateId);
    if (!originEntry || canonicalJson(originEntry) !== canonicalJson(candidate)) {
      errors.push({
        code: "ORIGIN_CANDIDATE_MISMATCH",
        candidateId,
        detail: "候选集条目与原批次总集条目不一致（token 或哈希已被改动）",
      });
      continue;
    }

    // ---- block 1：必需源文件摘要（缺摘要与不一致分开报告） ----
    const recordedSourceHashes = isPlainObject(captureJson.sourceHashes) ? captureJson.sourceHashes : null;
    let currentSourceContext = null;
    if (recordedSourceHashes === null) {
      gaps.push({
        code: "source-digests-missing",
        candidateId,
        detail: "capture.json 没有 sourceHashes（缺摘要）",
        blocking: true,
      });
    } else {
      const recordedKeys = Object.keys(recordedSourceHashes);
      currentSourceContext = currentSourceHashesFor(recordedKeys, historicalSourceSnapshot);
      // 捕获链路的全部依赖（capture.mjs SOURCE_FILES，22 项）都必须登记——只
      // 登记门禁的 18 项仍会漏掉 capture 独有的依赖，漏报即缺摘要（复核第 5 项）。
      const missingRequired = SOURCE_FILES.filter((file) => typeof recordedSourceHashes[file] !== "string");
      if (missingRequired.length > 0) {
        gaps.push({
          code: "source-digest-missing",
          candidateId,
          detail: `登记摘要缺 ${missingRequired.length} 个门禁依赖文件（缺摘要）：${missingRequired.join(", ")}`,
          blocking: true,
        });
      }
      const invalidKeys = recordedKeys.filter((file) => !isSha256(recordedSourceHashes[file]));
      if (invalidKeys.length > 0) {
        gaps.push({
          code: "source-digest-missing",
          candidateId,
          detail: `登记摘要不是有效 sha256（缺摘要）：${invalidKeys.join(", ")}`,
          blocking: true,
        });
      }
      if (currentSourceContext.unreadable.length > 0) {
        gaps.push({
          code: "source-digest-unreadable",
          candidateId,
          detail: `当前仓库读不到 ${currentSourceContext.unreadable.length} 个已登记文件（缺摘要）：${currentSourceContext.unreadable.join(", ")}`,
          blocking: true,
        });
      }
      const mismatched = recordedKeys
        .filter(
          (file) =>
            typeof currentSourceContext.hashes[file] === "string" &&
            currentSourceContext.hashes[file] !== recordedSourceHashes[file],
        )
        .sort();
      if (mismatched.length > 0) {
        gaps.push({
          code: "source-digest-mismatch",
          candidateId,
          detail: `${mismatched.length} 个源文件摘要与当前磁盘不一致（不一致，评审已过期）：${mismatched.join(", ")}`,
          blocking: true,
        });
      }
    }

    // ---- block 1 补充：当前口径的独立核对（保留原批次摘要 ≠ 只信它） ----
    // 派生：候选派生自哪一版 public/skins.js，必须等于当前仓库字节（生成后源
    // 已变更即旧派生不可复现），也必须等于捕获时登记的字节（生成 ↔ 捕获一致）。
    // 配方：候选 profileSnapshot 的 profileHash 自洽在这里复核；"当前单皮肤
    // profileSnapshot"消费 .1 扩展的 currentProfiles 出处通道（登记 {path,sha256}、
    // 登记即核验）——本模块按登记摘要重读来源、解析 profiles[skinId]、与候选
    // profileHash 比对（当前配方口径独立核对，第 6 项闭合），细则见
    // verifyCurrentProfiles。
    if (!isSha256(candidate.derivationHash)) {
      gaps.push({
        code: "derivation-missing",
        candidateId,
        detail: "候选缺少有效的 derivationHash（派生口径无摘要）",
        blocking: true,
      });
    } else {
      if (currentSkinsJsDigest !== null && candidate.derivationHash !== currentSkinsJsDigest) {
        gaps.push({
          code: "derivation-drift",
          candidateId,
          detail: "候选派生口径与当前 public/skins.js 摘要不一致——生成后源已变更，旧派生不可复现",
          blocking: true,
        });
      }
      const captureTimeSkinsJs =
        typeof recordedSourceHashes?.["public/skins.js"] === "string" ? recordedSourceHashes["public/skins.js"] : null;
      if (captureTimeSkinsJs !== null && captureTimeSkinsJs !== candidate.derivationHash) {
        gaps.push({
          code: "derivation-capture-mismatch",
          candidateId,
          detail: "候选派生口径与捕获时登记的 public/skins.js 摘要不一致——捕获的不是该候选的派生结果",
          blocking: true,
        });
      }
    }
    if (isPlainObject(candidate.profileSnapshot) && candidate.profileHash !== undefined) {
      if (candidate.profileHash !== sha256Canonical(candidate.profileSnapshot)) {
        errors.push({
          code: "PROFILE_HASH_MISMATCH",
          candidateId,
          detail: "候选 profileHash 与 profileSnapshot 内容摘要不一致（单皮肤配方被改动）",
        });
        continue;
      }
    }
    await verifyCurrentProfiles({ evidence, origin, candidate, runDirReal, gaps });

    // ---- block 2：原批次上下文里的 M3.4 复核 ----
    const policy = currentPolicy();
    const run = {
      policy,
      inputHashes: originalSet.inputHashes,
      recordedInputHashes: isPlainObject(evidenceMeta.inputHashes) ? evidenceMeta.inputHashes : undefined,
      sourceHashes: currentSourceContext === null ? undefined : currentSourceContext.hashes,
      recordedSourceHashes: recordedSourceHashes === null ? undefined : recordedSourceHashes,
      fixture: { version: policy.versions.fixture },
      recordedFixture: isPlainObject(evidenceMeta.recordedFixture) ? evidenceMeta.recordedFixture : undefined,
      candidateSet: originalSet,
      candidateSetHash: typeof originalSet.candidateSetHash === "string" ? originalSet.candidateSetHash : undefined,
    };
    let freshAssessment;
    let diskAssessment = originalAssessment;
    try {
      let browserChecks = Array.isArray(originalAssessment.browser) ? originalAssessment.browser : null;
      let focusSupplement = null;
      if (focusRegistrations.has(candidateId)) {
        focusSupplement = await createReviewFocusSupplement({
          registration: focusRegistrations.get(candidateId),
          readContainedBytes: (relativePath) => readContainedBytes(runDirReal, relativePath),
          candidate,
          candidateSetHash: originalSet.candidateSetHash,
          sourceHashes: recordedSourceHashes,
          policyHash: captureJson.policyHash,
          fixtureHash: captureJson.fixtureHash,
          browserRecords: browserChecks,
        });
        const isTarget = (record) =>
          record.candidateId === candidateId &&
          record.mode === "light" &&
          record.stateId === "keyboard-focus" &&
          record.roleId === "focus.outline";
        // 原磁盘判据仍核对原缺测；只有重算采用已绑定的补验记录。
        diskAssessment = {
          ...originalAssessment,
          browser: browserChecks.map((record) => (isTarget(record) ? focusSupplement.originalRecord : record)),
        };
        browserChecks = browserChecks.map((record) => (isTarget(record) ? focusSupplement.effectiveRecord : record));
      }
      freshAssessment = assessCandidate({
        candidate,
        fastChecks: Array.isArray(originalAssessment.fast) ? originalAssessment.fast : null,
        browserChecks,
        visualReview: isPlainObject(evidence.visualReview?.reviews)
          ? evidence.visualReview.reviews[candidateId]
          : undefined,
        run,
      });
      if (focusSupplement !== null) {
        freshAssessment = {
          ...freshAssessment,
          diagnostics: {
            ...freshAssessment.diagnostics,
            focusSupplement: focusSupplement.diagnostic,
          },
        };
      }
    } catch (error) {
      errors.push({
        code: "REASSESSMENT_FAILED",
        candidateId,
        detail: `M3.4 复核抛错：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    reAssessedById.set(candidateId, freshAssessment);
    if (originalAssessment.readiness !== freshAssessment.readiness) {
      gaps.push({
        code: "readiness-changed",
        candidateId,
        detail: `落盘 readiness=${originalAssessment.readiness}，离线复核=${freshAssessment.readiness}（落盘 ready 不可信，以重算为准）`,
        blocking: freshAssessment.readiness !== "ready",
      });
    }

    // ---- block 3：M4.3 捕获完整性 ----
    if (progressJson !== null) {
      await verifyCaptureUnits({
        candidate,
        captureDirReal,
        captureJson,
        progressJson,
        originalAssessment: diskAssessment,
        gaps,
        verifiedUnitTrees,
        collectedBaselineImages,
        collectedImageAssets,
      });
    } else if (captureJson.kind === MATRIX_KIND) {
      gaps.push({
        code: "progress-missing",
        candidateId,
        detail: "矩阵捕获缺 progress.json——无法核对状态索引与单元证据",
        blocking: true,
      });
    } else {
      gaps.push({
        code: "capture-kind-unsupported",
        candidateId,
        detail: `capture.json kind="${String(captureJson.kind)}" 不是矩阵捕获——M4.4.2 只核 M4.3 状态矩阵证据`,
        blocking: true,
      });
    }
  }

  // ---- 重算后的评审容器（复核后的显示输入） ----
  const assessments = [];
  for (const candidate of candidates) {
    const fresh = reAssessedById.get(candidate.id);
    const original = originalAssessmentById.get(candidate.id);
    const chosen = fresh ?? original ?? null;
    if (chosen) assessments.push(chosen);
  }
  const container = buildReviewContainer({ candidateSetHash: displaySet.candidateSetHash, assessments });

  // ---- 图片引用覆盖：每张原尺寸截图都要有摘要锚点（S0 附件清单或单元证据树） ----
  verifyImageCoverage({ evidence, candidates, verifiedUnitTrees, collectedBaselineImages, gaps });
  const candidateOrder = new Map(candidates.map((candidate, index) => [candidate.id, index]));
  const modeOrder = new Map([
    ["light", 0],
    ["dark", 1],
  ]);
  collectedImageAssets.sort(
    (left, right) =>
      candidateOrder.get(left.candidateId) - candidateOrder.get(right.candidateId) ||
      modeOrder.get(left.mode) - modeOrder.get(right.mode) ||
      left.relativePath.localeCompare(right.relativePath),
  );

  // ---- 选择记录（requireSelections） ----
  const selectionsModel = requireSelections
    ? verifySelections({ evidence, displaySet, container, loadedContainer, errors, gaps })
    : null;

  // ---- 状态折叠 ----
  const anyRejected = [...reAssessedById.values()].some((assessment) => assessment.readiness === "rejected");
  let status;
  if (errors.length > 0) status = "invalid";
  else if (anyRejected) status = "rejected";
  else if (
    gaps.some((gap) => gap.blocking) ||
    [...reAssessedById.values()].some((assessment) => assessment.readiness !== "ready")
  )
    status = "incomplete";
  else status = "pass";

  // 卡面：invalid → verifiedModel=null；rejected/incomplete 保留显示模型禁选。
  if (status === "invalid") {
    return withSourceContext({ status, errors, gaps, verifiedModel: null });
  }

  const blockingByCandidate = new Set(
    gaps.filter((gap) => gap.blocking && typeof gap.candidateId === "string").map((gap) => gap.candidateId),
  );
  const selectableCandidateIds = candidates
    .map((candidate) => candidate.id)
    .filter(
      (candidateId) => reAssessedById.get(candidateId)?.readiness === "ready" && !blockingByCandidate.has(candidateId),
    );

  const verifiedModel = deepFreeze({
    schemaVersion: REVIEW_VERIFY_SCHEMA_VERSION,
    kind: "skin-palette-review-verified-model",
    production: false,
    requireSelections,
    candidateSet: displaySet,
    container,
    origins: evidence.origins.origins ?? {},
    images: {
      baseline: collectedBaselineImages,
      units: verifiedUnitTrees,
      assets: collectedImageAssets,
    },
    gaps,
    selections: selectionsModel,
    selectableCandidateIds,
  });

  return withSourceContext({ status, errors, gaps, verifiedModel });
}

async function readFocusRegistrations(runDirReal, candidates) {
  const name = "focus-supplements.json";
  try {
    await lstat(path.join(runDirReal, name));
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
  const bytes = await readContainedBytes(runDirReal, name);
  if (bytes === null) throw new Error("focus-supplements.json 无法安全读取");
  const value = JSON.parse(bytes.toString("utf8"));
  if (
    !isPlainObject(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.items) ||
    Object.keys(value).sort().join(",") !== "items,schemaVersion"
  ) {
    throw new Error("focus-supplements.json 必须是 {schemaVersion:1,items:[]}");
  }
  const known = new Set(candidates.map((candidate) => candidate.id));
  const registrations = new Map();
  for (const item of value.items) {
    const id = item?.originalRecord?.candidateId;
    if (!known.has(id) || registrations.has(id)) throw new Error("焦点补验包含未知或重复候选");
    registrations.set(id, item);
  }
  return registrations;
}

/** 正式身份核验（production=true）：最小口径，source 变更规则等待 M4.4.7。 */
function verifyProduction({ evidence, errors, gaps }) {
  for (const gap of Array.isArray(evidence.gaps) ? evidence.gaps : []) {
    gaps.push({ code: gap.code, candidateId: gap.candidateId ?? null, detail: gap.detail ?? "", blocking: true });
  }
  const captures = isPlainObject(evidence.captures) ? evidence.captures : {};
  for (const [key, record] of Object.entries(captures)) {
    const captureCandidate = isPlainObject(record?.capture) ? record.capture.candidate : null;
    if (!isPlainObject(captureCandidate) || captureCandidate.production !== true) {
      errors.push({
        code: "PRODUCTION_IDENTITY",
        candidateId: key,
        detail: "capture.json candidate.production 必须=true（正式色源证据走 M4.4.7 适配通道）",
      });
      continue;
    }
    if (!SKIN_IDS.includes(captureCandidate.skinId)) {
      errors.push({
        code: "PRODUCTION_IDENTITY",
        candidateId: key,
        detail: `正式身份 skinId "${String(captureCandidate.skinId)}" 不在十套皮肤内`,
      });
      continue;
    }
    if (key !== captureCandidate.skinId) {
      errors.push({ code: "PRODUCTION_IDENTITY", candidateId: key, detail: "正式证据索引键必须与 skinId 一致" });
    }
  }
  const status = errors.length > 0 ? "invalid" : gaps.some((gap) => gap.blocking) ? "incomplete" : "pass";
  // 卡面契约：invalid → verifiedModel=null（复核第 7 项：正式身份分支同样适用）。
  if (status === "invalid") {
    return { status, errors, gaps, verifiedModel: null };
  }
  const verifiedModel = deepFreeze({
    schemaVersion: REVIEW_VERIFY_SCHEMA_VERSION,
    kind: "skin-palette-review-verified-model",
    production: true,
    requireSelections: false,
    candidateSet: null,
    container: null,
    origins: isPlainObject(evidence.origins?.origins) ? evidence.origins.origins : {},
    images: { baseline: [], units: [], assets: [] },
    gaps,
    selections: null,
    selectableCandidateIds: [],
  });
  return { status, errors, gaps, verifiedModel };
}

/** 读原批次 candidates.json：登记摘要钉字节 → 解析 → M0 局部批次校验。 */
async function loadOriginalBatchSet({ runDirReal, origin, candidateId, errors, gaps }) {
  const recordedDigest = origin.hashes.candidates;
  if (!isSha256(recordedDigest)) {
    errors.push({ code: "ORIGIN_DIGEST_MISMATCH", candidateId, detail: "出处登记的 candidates 摘要不是有效 sha256" });
    return null;
  }
  // 跨批 batchRun（如 "../<runId>"）按 .1 的包含校验结果放行：先落定原批次
  // run 目录，再在该目录范围内读 candidates.json（逐段拒链接 + realpath 包含）。
  let batchRunReal;
  try {
    batchRunReal = await realpath(path.resolve(runDirReal, origin.batchRun));
  } catch {
    gaps.push({
      code: "origin-file-changed",
      candidateId,
      detail: `原批次目录 ${origin.batchRun} 无法解析`,
      blocking: true,
    });
    return null;
  }
  const bytes = await readContainedBytes(batchRunReal, "candidates.json");
  if (bytes === null) {
    gaps.push({
      code: "origin-file-changed",
      candidateId,
      detail: `原批次 ${origin.batchRun}/candidates.json 读不到（须在原批次 run 目录包含范围内）`,
      blocking: true,
    });
    return null;
  }
  if (sha256Of(bytes) !== recordedDigest) {
    errors.push({
      code: "ORIGIN_DIGEST_MISMATCH",
      candidateId,
      detail: "原批次 candidates.json 字节与出处登记摘要不一致",
    });
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    errors.push({
      code: "ORIGIN_DIGEST_MISMATCH",
      candidateId,
      detail: "原批次 candidates.json JSON 损坏（摘要却匹配——出处登记本身不可信）",
    });
    return null;
  }
  const check = validateCandidateSet(parsed, { expectedSkinIds: [] });
  if (!check.valid) {
    errors.push({
      code: "ORIGIN_DIGEST_MISMATCH",
      candidateId,
      detail: `原批次 candidates.json 未过 M0 校验：${check.errors[0]?.path ?? "$"} ${check.errors[0]?.code ?? "shape"}`,
    });
    return null;
  }
  return parsed;
}

/** block 3：完整必要矩阵、浅深配对、单元证据树、S0 附件清单与落盘判据比对。 */
async function verifyCaptureUnits({
  candidate,
  captureDirReal,
  captureJson,
  progressJson,
  originalAssessment,
  gaps,
  verifiedUnitTrees,
  collectedBaselineImages,
  collectedImageAssets,
}) {
  const candidateId = candidate.id;
  if (captureJson.kind !== MATRIX_KIND) {
    gaps.push({
      code: "capture-kind-unsupported",
      candidateId,
      detail: `capture.json kind="${String(captureJson.kind)}" 不是矩阵捕获——M4.4.2 只核 M4.3 状态矩阵证据`,
      blocking: true,
    });
    return;
  }
  const units = expectedMatrixUnits(progressJson.groups);
  if (units === null) {
    gaps.push({
      code: "capture-groups-invalid",
      candidateId,
      detail: "progress.json.groups 不是已知的矩阵组清单",
      blocking: true,
    });
    return;
  }

  // 完整性（复核第 1 项）：progress 自报的组与模式必须覆盖完整必要矩阵。
  // 只登记一部分组、或没有深色（浅/深必须成对），都是局部捕获——保留为
  // incomplete，绝不当完整证据。组/模式不全时继续核已登记部分，多出诊断。
  const declaredGroups = Array.isArray(progressJson.groups) ? progressJson.groups : [];
  const missingGroups = ALL_GROUP_IDS.filter((id) => !declaredGroups.includes(id));
  if (missingGroups.length > 0) {
    gaps.push({
      code: "capture-groups-partial",
      candidateId,
      detail: `progress.json 只登记 ${declaredGroups.length}/${ALL_GROUP_IDS.length} 个矩阵组（缺 ${missingGroups.join(", ")}）——局部捕获不构成完整证据`,
      blocking: true,
    });
  }
  const modes = Array.isArray(progressJson.modes) ? progressJson.modes.filter((mode) => typeof mode === "string") : [];
  if (modes.length === 0) {
    gaps.push({
      code: "capture-modes-missing",
      candidateId,
      detail: "progress.json.modes 为空——不知道捕获了哪些模式",
      blocking: true,
    });
    return;
  }
  const missingStandardModes = STANDARD_MODES.filter((mode) => !modes.includes(mode));
  const unknownModes = modes.filter((mode) => !STANDARD_MODES.includes(mode));
  if (missingStandardModes.length > 0 || unknownModes.length > 0) {
    gaps.push({
      code: "capture-modes-partial",
      candidateId,
      detail: `progress.json.modes=${modes.join("/") || "（空）"}——必须恰好覆盖 light/dark（缺 ${missingStandardModes.join("/") || "—"}；多 ${unknownModes.join("/") || "—"}）`,
      blocking: true,
    });
  }
  const unitsMap = isPlainObject(progressJson.units) ? progressJson.units : {};

  // 落盘判据登记：按 (mode, stateId) 收集单元 checks.json 与 S0 基线判据的
  // 语义元组，稍后与原评审的测量记录逐一比对（文件完整性核验不能替代测量
  // 结果核验——复核第 3 项）。
  const diskRecordIndex = new Map();
  const verifiedStateKeys = new Set();
  const addDiskRecords = (mode, stateId, records) => {
    if (typeof stateId !== "string" || !Array.isArray(records)) return;
    const key = `${mode}|${stateId}`;
    let bucket = diskRecordIndex.get(key);
    if (!bucket) {
      bucket = new Set();
      diskRecordIndex.set(key, bucket);
    }
    for (const record of records) {
      if (isPlainObject(record)) bucket.add(canonicalJson(semanticRecordTuple(record)));
    }
    verifiedStateKeys.add(key);
  };

  for (const unit of units) {
    const statuses = new Map(modes.map((mode) => [mode, unitsMap[`${mode}/${unit.id}`] ?? null]));
    const unknownStatus = [...statuses.entries()].find(([, entry]) => entry !== null && !isPlainObject(entry));
    if (unknownStatus) {
      gaps.push({
        code: "capture-unit-missing",
        candidateId,
        detail: `单元 ${unknownStatus[0]}/${unit.id} 的进度记录不是对象`,
        blocking: true,
      });
      continue;
    }
    const recorded = [...statuses.values()].map((entry) => (entry === null ? null : (entry.status ?? null)));
    // 浅深配对：单侧缺记录/单侧不可达都是配对破坏。
    const missingModes = modes.filter((_mode, index) => recorded[index] === null);
    const unreachableModes = modes.filter((_mode, index) => recorded[index] === "unreachable");
    if (unreachableModes.length > 0 && unreachableModes.length < modes.length) {
      gaps.push({
        code: "capture-pairing-mismatch",
        candidateId,
        detail: `单元 ${unit.id} 只在 ${unreachableModes.join("/")} 不可达（${recorded.join(" / ")}）——浅深必须同达或同不可达`,
        blocking: true,
      });
      continue;
    }
    if (unreachableModes.length === modes.length) {
      // 复核第 2 项：双侧一致不可达只对矩阵里登记了 precondition 预案的状态
      // 豁免（当前即 quota-toast 一类已知触发不到的单元）；正常可触发的状态
      // 双侧标 unreachable 不能套用已知限制的豁免，一律阻断。
      if (isPlainObject(unit.precondition)) {
        const reasons = [...statuses.values()].map((entry) => entry?.reason ?? "");
        gaps.push({
          code: "capture-unit-unreachable",
          candidateId,
          detail: `单元 ${unit.id} 两模式均不可达（M4.3 登记，有 precondition 预案）：${reasons[0] || "未登记原因"}`,
          blocking: false,
        });
      } else {
        gaps.push({
          code: "capture-unit-unreachable",
          candidateId,
          detail: `单元 ${unit.id} 两模式均被标 unreachable，但矩阵没有为它登记 precondition 预案——已知限制的豁免不能套在正常可触发的状态上`,
          blocking: true,
        });
      }
      continue;
    }
    if (missingModes.length > 0) {
      gaps.push({
        code: "capture-unit-missing",
        candidateId,
        detail: `缺一必要状态：单元 ${unit.id} 在 ${missingModes.join("/")} 没有进度记录`,
        blocking: true,
      });
      continue;
    }
    const failed = modes.filter((_mode, index) => recorded[index] === "failed");
    const partial = modes.filter((_mode, index) => recorded[index] === "incomplete");
    if (failed.length > 0) {
      gaps.push({
        code: "capture-unit-failed",
        candidateId,
        detail: `单元 ${unit.id} 捕获失败（${failed.join("/")}）`,
        blocking: true,
      });
      continue;
    }
    if (partial.length > 0) {
      gaps.push({
        code: "capture-unit-incomplete",
        candidateId,
        detail: `单元 ${unit.id} 捕获不完整（${partial.join("/")}）`,
        blocking: true,
      });
      continue;
    }
    const notCaptured = modes.filter((_mode, index) => recorded[index] !== "captured");
    if (notCaptured.length > 0) {
      gaps.push({
        code: "capture-unit-missing",
        candidateId,
        detail: `单元 ${unit.id} 状态未知（${notCaptured.join("/")}）`,
        blocking: true,
      });
      continue;
    }

    // 全部 captured：逐模式核证据（baseline 走固定附件清单，状态单元走
    // capture.mjs 的续跑校验——证据树哈希、身份、几何与测量截图全覆盖），
    // 并把落盘判据登记进 (mode, stateId) 索引。
    for (const mode of modes) {
      const entry = statuses.get(mode);
      if (unit.kind === "baseline") {
        await verifyBaselineUnit({
          candidateId,
          captureDirReal,
          mode,
          entry,
          skinId: candidate.skinId,
          gaps,
          collectedBaselineImages,
          collectedImageAssets,
          addDiskRecords,
        });
      } else {
        const expectedEvidenceHash = entry.evidenceHash;
        if (!isSha256(expectedEvidenceHash)) {
          gaps.push({
            code: "capture-unit-evidence-invalid",
            candidateId,
            detail: `单元 ${mode}/${unit.id} 缺少有效 evidenceHash（缺摘要）`,
            blocking: true,
          });
          continue;
        }
        try {
          const saved = await readCapturedUnitEvidence({
            unitDir: path.join(captureDirReal, mode, "states", unit.id),
            unit: {
              id: unit.id,
              kind: unit.kind,
              stateId: unit.stateId ?? null,
              timelineModeSequence: unit.timelineModeSequence,
              ...(unit.fixtureRequirement ? { fixtureRequirement: unit.fixtureRequirement } : {}),
            },
            mode,
            skinId: candidate.skinId,
            expectedRoleIds: EXPECTED_ROLE_IDS_BY_STATE.get(unit.stateId) ?? [],
            expectedEvidenceHash,
          });
          addDiskRecords(mode, unit.stateId ?? null, saved.checks?.records);
          // S5 双视图判据（复核第二轮第 2 项）：切换视图后分别测量的结果，
          // 不是主判据的重复——逐视图重读 checks.timeline-<view>.json 参与
          // 落盘判据比对；重读字节用证据树哈希重算钉回已核验的字节。
          const timelineModes = Array.isArray(unit.timelineModeSequence) ? unit.timelineModeSequence : [];
          if (timelineModes.length > 0 && typeof unit.stateId === "string") {
            const unitDirPath = path.join(captureDirReal, mode, "states", unit.id);
            for (const viewMode of timelineModes) {
              if (typeof viewMode !== "string") continue;
              const variantChecks = await rereadTimelineVariantChecks({
                candidateId,
                captureDirReal,
                unitDirPath,
                unitId: unit.id,
                stateId: unit.stateId,
                mode,
                viewMode,
                expectedEvidenceHash,
                gaps,
              });
              if (variantChecks !== null) addDiskRecords(mode, unit.stateId, variantChecks.records);
            }
          }
          const statePng = await readVerifiedStatePng(
            captureDirReal,
            path.join(captureDirReal, mode, "states", unit.id),
            mode,
            unit.id,
            expectedEvidenceHash,
          );
          collectedImageAssets.push({
            candidateId,
            mode,
            unitId: unit.id,
            relativePath: `${mode}/states/${unit.id}/state.png`,
            sha256: sha256Of(statePng),
            bytes: statePng.length,
            dataUrl: pngDataUrl(statePng),
          });
          verifiedUnitTrees.push({
            candidateId,
            mode,
            unitId: unit.id,
            stateId: unit.stateId ?? null,
            evidenceHash: saved.evidenceHash,
          });
        } catch (error) {
          gaps.push({
            code: "capture-unit-evidence-invalid",
            candidateId,
            detail: `单元 ${mode}/${unit.id} 证据核验失败：${error instanceof Error ? error.message : String(error)}`,
            blocking: true,
          });
        }
      }
    }
  }

  // 落盘判据 ↔ 原评审测量记录比对（复核第 3 项）：单元证据树自洽只证明
  // "文件没有被篡改"，不能替代测量结果核验——磁盘上的 fail/unmeasured 若不被
  // 原评审反映，旧评审就掩盖了失败；原评审的测量记录若没有落盘判据支撑，
  // 测量结论无从追溯。
  const assessmentRecords = Array.isArray(originalAssessment?.browser) ? originalAssessment.browser : [];
  const assessmentIndex = new Map();
  for (const record of assessmentRecords) {
    if (!isPlainObject(record) || typeof record.stateId !== "string") continue;
    const key = `${record.mode}|${record.stateId}`;
    let bucket = assessmentIndex.get(key);
    if (!bucket) {
      bucket = new Set();
      assessmentIndex.set(key, bucket);
    }
    bucket.add(canonicalJson(semanticRecordTuple(record)));
  }
  const compareKeys = [...new Set([...assessmentIndex.keys(), ...diskRecordIndex.keys()])].sort();
  for (const key of compareKeys) {
    const diskTuples = diskRecordIndex.get(key) ?? new Set();
    const assessTuples = assessmentIndex.get(key) ?? new Set();
    const unreflected = [...diskTuples].filter((tuple) => !assessTuples.has(tuple));
    // 该状态在本模式没有任何已核验单元时，"原评审有记录而磁盘无判据"已由
    // 缺测/失败缺件覆盖，不重复计——unbacked 只对已核验过的状态键追究。
    const unbacked = verifiedStateKeys.has(key) ? [...assessTuples].filter((tuple) => !diskTuples.has(tuple)) : [];
    if (unreflected.length === 0 && unbacked.length === 0) continue;
    const parts = [];
    if (unreflected.length > 0) parts.push(`${unreflected.length} 条落盘判据未被原评审反映（旧评审可能掩盖失败/缺测）`);
    if (unbacked.length > 0) parts.push(`${unbacked.length} 条原评审测量记录没有落盘判据支撑`);
    gaps.push({
      code: "capture-checks-mismatch",
      candidateId,
      detail: `${key} 落盘判据与原评审测量记录不一致：${parts.join("；")}`,
      blocking: true,
    });
  }
}

/**
 * 重读一个 S5 视图判据文件（readCapturedUnitEvidence 校验过变体文件但不返回
 * 其判据值）：读取后重算单元证据树哈希钉回 expectedEvidenceHash——读出的字节
 * 若不在已核验的树里（读前被换/读后并发改），重算即失配，按证据核验失败阻断。
 */
async function rereadTimelineVariantChecks({
  candidateId,
  captureDirReal,
  unitDirPath,
  unitId,
  stateId,
  mode,
  viewMode,
  expectedEvidenceHash,
  gaps,
}) {
  const bytes = await readContainedBytes(captureDirReal, `${mode}/states/${unitId}/checks.timeline-${viewMode}.json`);
  if (bytes === null) {
    gaps.push({
      code: "capture-unit-evidence-invalid",
      candidateId,
      detail: `单元 ${mode}/${unitId} 的 ${viewMode} 视图判据文件重读失败（.1 载入后磁盘已变化或越界）——请重新 loadReviewEvidence`,
      blocking: true,
    });
    return null;
  }
  let treeHash = null;
  try {
    treeHash = await hashEvidenceTreeOf(unitDirPath);
  } catch {
    treeHash = null;
  }
  if (treeHash !== expectedEvidenceHash) {
    gaps.push({
      code: "capture-unit-evidence-invalid",
      candidateId,
      detail: `单元 ${mode}/${unitId} 的证据树在重读 ${viewMode} 视图判据时已变化——请重新 loadReviewEvidence`,
      blocking: true,
    });
    return null;
  }
  let variantChecks = null;
  try {
    variantChecks = JSON.parse(bytes.toString("utf8"));
  } catch {
    variantChecks = null;
  }
  const variantOk =
    isPlainObject(variantChecks) &&
    variantChecks.unitId === unitId &&
    variantChecks.stateId === stateId &&
    variantChecks.mode === mode &&
    variantChecks.viewMode === viewMode &&
    Array.isArray(variantChecks.records);
  if (!variantOk) {
    gaps.push({
      code: "capture-unit-evidence-invalid",
      candidateId,
      detail: `单元 ${mode}/${unitId} 的 ${viewMode} 视图判据文件身份与续跑校验结果不一致`,
      blocking: true,
    });
    return null;
  }
  return variantChecks;
}

/**
 * S0 固定附件清单核验（复核第 4 项：自洽之外还验完整性）——M4.3 已验收口径：
 * 固定附件集合（清单与集合双向一致）、逐文件 SHA-256/字节数、非 checks 的
 * JSON 身份与一致性结论（colors.json/first-screen.json/layout.json）、测量开启
 * 时的 checks.json（身份 + 非空判据 + 截图索引形态与集合一致）。
 */
async function verifyBaselineUnit({
  candidateId,
  captureDirReal,
  mode,
  entry,
  skinId,
  gaps,
  collectedBaselineImages,
  collectedImageAssets,
  addDiskRecords,
}) {
  const label = `${mode}/baseline`;
  const manifest = isPlainObject(entry) ? entry.baselineEvidence : null;
  if (
    !isPlainObject(manifest) ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.measureRoles !== "boolean" ||
    !Array.isArray(manifest.files) ||
    !isSha256(manifest.sha256)
  ) {
    gaps.push({
      code: "baseline-manifest-missing",
      candidateId,
      detail: `${label} 缺少有效的固定附件清单（缺摘要）`,
      blocking: true,
    });
    return;
  }
  if (sha256Canonical(manifest.files) !== manifest.sha256) {
    gaps.push({
      code: "baseline-manifest-mismatch",
      candidateId,
      detail: `${label} 附件清单内部摘要不一致（不一致）`,
      blocking: true,
    });
    return;
  }

  // 逐文件：条目有效 → 受控读取 → 摘要/字节数核对。
  const bytesByName = new Map();
  const names = new Set();
  for (const fileEntry of manifest.files) {
    const file = fileEntry?.file;
    if (typeof file !== "string" || !isSha256(fileEntry.sha256) || !Number.isInteger(fileEntry.bytes)) {
      gaps.push({
        code: "baseline-manifest-mismatch",
        candidateId,
        detail: `${label} 附件清单条目无效：${JSON.stringify(fileEntry ?? null)}`,
        blocking: true,
      });
      continue;
    }
    const bytes = await readContainedBytes(captureDirReal, `${mode}/${file}`);
    if (bytes === null) {
      gaps.push({
        code: "baseline-file-missing",
        candidateId,
        detail: `${label} 附件 ${file} 读不到（须在捕获目录包含范围内）`,
        blocking: true,
      });
      continue;
    }
    if (sha256Of(bytes) !== fileEntry.sha256 || bytes.length !== fileEntry.bytes) {
      gaps.push({
        code: "baseline-file-mismatch",
        candidateId,
        detail: `${label} 附件 ${file} 的 SHA-256/字节数与清单不一致（不一致）`,
        blocking: true,
      });
      continue;
    }
    bytesByName.set(file, bytes);
    names.add(file);
  }

  // 测量开启：checks.json 必须在场且身份/判据/截图索引符合 M4.3 基线要求
  //（capture.mjs collectBaselineEvidenceManifest 同口径）。
  let checks = null;
  if (manifest.measureRoles === true) {
    const checksBytes = bytesByName.get("checks.json");
    if (checksBytes !== undefined) {
      try {
        checks = JSON.parse(checksBytes.toString("utf8"));
      } catch {
        gaps.push({
          code: "baseline-json-mismatch",
          candidateId,
          detail: `${label} checks.json JSON 损坏`,
          blocking: true,
        });
      }
      if (checks !== null) {
        // 按真实 S0 接口校验（capture.mjs:1274-1282 的实际键集：stateId/mode/
        // candidateId/records/counts/diagnostics/captureIndex——没有 kind/status，
        // 与 M4.3 collectBaselineEvidenceManifest 的要求一致；candidateId 的
        // 逐记录绑定由判据比对的语义元组承担，这里不自造更强要求）。
        const checksOk =
          checks.stateId === BASELINE_STATE_ID &&
          checks.mode === mode &&
          Array.isArray(checks.records) &&
          checks.records.length > 0 &&
          Array.isArray(checks.captureIndex) &&
          checks.captureIndex.length > 0;
        if (!checksOk) {
          gaps.push({
            code: "baseline-json-mismatch",
            candidateId,
            detail: `${label} checks.json 身份或测量判据不符合 M4.3 基线要求（stateId=${BASELINE_STATE_ID}、mode 一致、records 与截图索引非空）`,
            blocking: true,
          });
        } else {
          for (const capture of checks.captureIndex) {
            const captureFile = capture?.file;
            if (
              typeof captureFile !== "string" ||
              !captureFile.startsWith("captures/") ||
              captureFile.split("/").length !== 2 ||
              !captureFile.endsWith(".png")
            ) {
              gaps.push({
                code: "baseline-json-mismatch",
                candidateId,
                detail: `${label} checks.json 截图索引条目无效：${JSON.stringify(capture ?? null)}`,
                blocking: true,
              });
            }
          }
        }
      }
    }
  }

  // 清单必须与固定附件集合双向一致：缺（哪怕重新算平了清单哈希）或多都阻断。
  const expected = new Set(BASELINE_FIXED_FILES);
  if (manifest.measureRoles === true) expected.add("checks.json");
  if (checks !== null && Array.isArray(checks.captureIndex)) {
    for (const capture of checks.captureIndex) {
      if (isPlainObject(capture) && typeof capture.file === "string") expected.add(capture.file);
    }
  }
  const missingFiles = [...expected].filter((file) => !names.has(file));
  const extraFiles = [...names].filter((file) => !expected.has(file));
  if (missingFiles.length > 0 || extraFiles.length > 0) {
    gaps.push({
      code: "baseline-manifest-mismatch",
      candidateId,
      detail: `${label} 附件清单与固定附件集合不一致（缺 ${missingFiles.join(", ") || "—"}；多 ${extraFiles.join(", ") || "—"}）`,
      blocking: true,
    });
  }

  // JSON 身份与一致性结论（M4.3 S0 验收同口径）。
  for (const name of BASELINE_JSON_FILES) {
    if (!bytesByName.has(name)) continue;
    let json = null;
    try {
      json = JSON.parse(bytesByName.get(name).toString("utf8"));
    } catch {
      json = null;
    }
    if (!isPlainObject(json) || json.mode !== mode || json.skinId !== skinId) {
      gaps.push({
        code: "baseline-json-mismatch",
        candidateId,
        detail: `${label} ${name} 缺失、损坏或身份不符（mode=${mode}、skinId=${skinId}）`,
        blocking: true,
      });
      continue;
    }
    if (name === "colors.json") {
      if (
        json.runtimeMatchesExpected !== true ||
        json.firstScreenMatchesRuntime !== true ||
        json.spotlight?.off !== true
      ) {
        gaps.push({
          code: "baseline-json-mismatch",
          candidateId,
          detail: `${label} colors.json 一致性结论为假（runtimeMatchesExpected / firstScreenMatchesRuntime / spotlight.off 必须全真）`,
          blocking: true,
        });
      }
    }
    if (name === "first-screen.json" && json.matches !== true) {
      gaps.push({
        code: "baseline-json-mismatch",
        candidateId,
        detail: `${label} first-screen.json 未记录成功的一致性判定（matches 必须 true）`,
        blocking: true,
      });
    }
  }

  // S0 基线判据进入落盘判据索引（与原评审的 dashboard-default 记录比对）。
  if (checks !== null && Array.isArray(checks.records)) {
    addDiskRecords(mode, BASELINE_STATE_ID, checks.records);
  }

  // 原尺寸截图的摘要锚点（清单内全部 png，含测量截图）。
  for (const fileEntry of manifest.files) {
    const file = fileEntry?.file;
    if (typeof file === "string" && file.endsWith(".png") && bytesByName.has(file)) {
      collectedBaselineImages.push({
        candidateId,
        mode,
        file: `${mode}/${file}`,
        sha256: fileEntry.sha256,
        bytes: fileEntry.bytes,
      });
    }
  }

  for (const file of ["baseline.png", "first-screen.png"]) {
    const bytes = bytesByName.get(file);
    if (bytes === undefined) continue;
    const fileEntry = manifest.files.find(
      (entry) => entry?.file === file && entry.sha256 === sha256Of(bytes) && entry.bytes === bytes.length,
    );
    if (fileEntry === undefined) continue;
    collectedImageAssets.push({
      candidateId,
      mode,
      unitId: "baseline",
      relativePath: `${mode}/${file}`,
      sha256: fileEntry.sha256,
      bytes: fileEntry.bytes,
      dataUrl: pngDataUrl(bytes),
    });
  }
}

/** 每张原尺寸截图都要有摘要锚点：S0 附件清单或已核验单元的证据树。 */
function verifyImageCoverage({ evidence, candidates, verifiedUnitTrees, collectedBaselineImages, gaps }) {
  const unitTreeKeys = new Set(verifiedUnitTrees.map((tree) => `${tree.candidateId}|${tree.mode}|${tree.unitId}`));
  const baselineFiles = new Set(collectedBaselineImages.map((image) => `${image.candidateId}|${image.file}`));
  for (const candidate of candidates) {
    const record = isPlainObject(evidence.captures) ? evidence.captures[candidate.id] : undefined;
    if (!isPlainObject(record) || !Array.isArray(record.images)) continue;
    for (const image of record.images) {
      const relativePath = typeof image.relativePath === "string" ? image.relativePath : "";
      const segments = relativePath.split("/");
      const [modeOrRoot, second, third] = segments;
      let covered = false;
      if ((modeOrRoot === "light" || modeOrRoot === "dark") && second === "states" && typeof third === "string") {
        covered = unitTreeKeys.has(`${candidate.id}|${modeOrRoot}|${third}`);
      } else if (modeOrRoot === "light" || modeOrRoot === "dark") {
        covered = baselineFiles.has(`${candidate.id}|${relativePath}`);
      }
      if (!covered) {
        gaps.push({
          code: "image-uncovered",
          candidateId: candidate.id,
          detail: `截图 ${relativePath} 没有任何摘要锚点（既不在 S0 附件清单，也不在已核验的状态单元证据树内）`,
          blocking: true,
        });
      }
    }
  }
}

/** 选择记录核验：十套 choices + 两个总摘要（candidateSetHash / 复核后 assessmentHash）。 */
function verifySelections({ evidence, displaySet, container, loadedContainer, errors, gaps }) {
  const selections = evidence.selections;
  if (!isPlainObject(selections) || selections.present !== true || !isPlainObject(selections.record)) {
    gaps.push({
      code: "selections-missing",
      candidateId: null,
      detail: "requireSelections=true 但本 run 没有可核验的选择记录",
      blocking: true,
    });
    return null;
  }
  const record = selections.record;
  const check = validateSelections(record);
  if (!check.valid) {
    const first = check.errors[0];
    errors.push({
      code: "SELECTIONS_SET_MISMATCH",
      candidateId: null,
      detail: `selections.json 未过 M0 校验：${first.path} ${first.code}：${first.message}`,
    });
    return deepFreeze({ record, binding: { candidateSetHash: false, assessmentHash: false } });
  }
  const candidateSetHashOk = record.candidateSetHash === displaySet.candidateSetHash;
  if (!candidateSetHashOk) {
    errors.push({
      code: "SELECTIONS_SET_MISMATCH",
      candidateId: null,
      detail: "selections.json 的 candidateSetHash 与候选集不一致（选择绑定到别的批次）",
    });
  }
  const assessmentHashOk = record.assessmentHash === container.assessmentHash;
  if (!assessmentHashOk) {
    const matchesOriginal = isPlainObject(loadedContainer) && record.assessmentHash === loadedContainer.assessmentHash;
    if (matchesOriginal) {
      gaps.push({
        code: "selections-assessment-hash-stale",
        candidateId: null,
        detail:
          "选择绑定的是原评审容器哈希；离线复核后容器已变化（证据过期或重算改变结论）——选择须在复核后的证据上重新确认",
        blocking: true,
      });
    } else {
      errors.push({
        code: "SELECTIONS_HASH_MISMATCH",
        candidateId: null,
        detail: "selections.json 的 assessmentHash 既不匹配原容器也不匹配复核后容器——选择记录不是基于本证据做出的",
      });
    }
  }
  return deepFreeze({ record, binding: { candidateSetHash: candidateSetHashOk, assessmentHash: assessmentHashOk } });
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const POLICY_PATH = path.join(REPO_ROOT, "scripts", "skin-palette", "policy.json");
let policyCache = null;
function currentPolicy() {
  if (policyCache === null) {
    policyCache = Object.freeze(JSON.parse(readFileSync(POLICY_PATH, "utf8")));
  }
  return policyCache;
}

function toPosixRel(fromReal, toReal) {
  return path.relative(fromReal, toReal).split(path.sep).join("/");
}

export default verifyReviewEvidence;
