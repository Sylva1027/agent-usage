/**
 * M4.4.1 证据读取与内部接口（皮肤配色重设 · 总计划 2026-10-03）
 * ============================================================================
 *
 * 冻结接口（M4.4.2—M4.4.7 与 M5.7.2 只读这些，不得各自再开一套读取逻辑）：
 *
 *   loadReviewEvidence({ runDir, capturesIndexPath, rootDir = REPO_ROOT })
 *     -> Promise<evidence>
 *
 *   buildReviewContainer({ candidateSetHash, assessments }) -> 冻结评审容器
 *   hashReviewContainer(container) -> assessmentHash
 *   ReviewEvidenceError / REVIEW_EVIDENCE_CODES
 *
 * rootDir 与 capture.mjs 的 assertCaptureOutputDir 同一先例：默认仓库根，
 * 测试注入沙箱根；containment 根固定为 <rootDir>/docs/validation。
 *
 * evidence 形状（全部深冻；全部来自本模块自行 JSON.parse 的字节或自行构造，
 * 绝不冻结调用方对象）：
 *
 *   {
 *     schemaVersion: 1,
 *     run: { id, dir, relativePath, candidatesPath, index: { path, relativePath } },
 *     candidateSet: { data, coverage },
 *     review: { present, path, container, missingCandidateIds },
 *     visualReview: { present, path, reviews },
 *     selections: { present, path, record, binding },
 *     captures: { [candidateId]: { candidateId, skinId, variant, dir, relativePath,
 *                                  capture, progress, images } },
 *     capturesMissing: [candidateId],
 *     origins: { source: "file" | "internal", path, origins, missingCandidateIds },
 *     gaps: [ { code, candidateId, detail } ],
 *   }
 *
 * 评审容器（本工具固定，M5.7.2 组总集时按同一规则重算）：
 *   { schemaVersion: 1, candidateSetHash, assessments: [Assessment], assessmentHash }
 *   assessments 按 CandidateSet 候选顺序（允许缺评审的子序列）且每 ID 唯一；
 *   assessmentHash = sha256Canonical(容器去掉自身 assessmentHash)。
 *   单个 Assessment / Candidate / Selections 结构不改 M0 契约；无评审保留缺项，
 *   不造空 PASS。本模块只读：不填 ready、不执行 assess、不写报告、不补截图。
 *
 * assessment-origins.json（总集出处文件，M5.7.2 按此写；单批由 run+index 构建
 * 同形内部出处，不落盘）：
 *   { schemaVersion: 1, origins: { [candidateId]: {
 *       batchRun, capture, visualReview,            // 相对出处文件所在 run 目录
 *       hashes: { candidates, capture, progress, visualReview },
 *       currentProfiles?: { path, sha256 } | null } } }
 *   hashes 为被引用原文件的字节 SHA-256（candidates=candidates.json、
 *   capture=capture.json、progress=capture 目录内 progress.json、
 *   visualReview=视觉评审文件）。candidates/capture 是必需摘要，一律不得为
 *   null；仅无引用的可选附件（progress/visualReview）允许 null，且 null 与
 *   文件存在与否必须互相印证。原 recordedInputHashes / sourceHashes 一律不改写。
 *   currentProfiles（可选通道，M4.4.2 协同扩展）：当前单皮肤配方来源的登记，
 *   path 相对出处文件所在 run 且必须留在该 run 内（随证据自包含，禁跨批引用/
 *   绝对/URL/".."），sha256 钉住文件字节；登记即核验（缺失/字节漂移= fatal）。
 *   内容消费（逐皮肤 sha256Canonical(entry) === candidate.profileHash）归
 *   M4.4.2；未登记时不伪造，由 M4.4.2 记阻断缺件。
 *   内部出处只为本 run 之内的捕获构建（不携带 currentProfiles——无出处文件
 *   可登记）；索引里的跨批相对引用在没有出处文件时登记为 origin-missing 缺项，
 *   绝不伪造 batchRun="." 的错误出处。
 *
 * captures-index.json 形状沿用 M4 卡面：{ schemaVersion: 1, captures:
 *   { [candidateId]: "相对 runDir 的捕获结果目录" } }；跨批次合并时允许经
 *   校验的相对引用进入原批次 run，绝不按时间扫描找“最新”。
 *
 * 安全边界：runDir / capturesIndexPath / 索引值 / 出处路径的词法与真实路径
 * 都必须落在 <rootDir>/docs/validation 之内（词法检查先于存在性判断——校验根
 * 外的 junction 指回根内同样拒绝）；本工具读取的每个文件自身不得是符号链接/
 * junction，读取一律走 realpath 后的受控通道；相对 runDir / capturesIndexPath
 * 以 realpath(rootDir)（仓库根）为解析基点。URL 形式、未知候选、重复绑定、
 * 含糊 capture 都在读取期以 ReviewEvidenceError 拒绝。
 */

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCHEMA_VERSION,
  SKIN_IDS,
  sha256Canonical,
  validateAssessment,
  validateCandidateSet,
  validateSelections,
} from "./contracts.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(MODULE_DIR, "..", "..");

export const REVIEW_EVIDENCE_SCHEMA_VERSION = 1;
export const REVIEW_CONTAINER_SCHEMA_VERSION = 1;
export const ORIGINS_SCHEMA_VERSION = 1;

/** captures-index.json / capture.json 的既定 kind（M4 卡面与 capture.mjs 产物）。 */
const CAPTURE_KINDS = Object.freeze(["skin-palette-capture", "skin-palette-capture-matrix"]);

/** 致命读取错误的机器可读码（exit 语义由 M4.4.5 CLI 统一映射为 invalid→1）。 */
export const REVIEW_EVIDENCE_CODES = Object.freeze([
  "INVALID_INPUT",
  "PATH_ESCAPE",
  "MISSING_FILE",
  "BAD_JSON",
  "INVALID_INDEX",
  "INVALID_CAPTURE",
  "INVALID_CONTAINER",
  "INVALID_ASSESSMENT",
  "INVALID_VISUAL_REVIEW",
  "INVALID_SELECTIONS",
  "INVALID_ORIGINS",
  "INVALID_CANDIDATE_SET",
  "UNKNOWN_CANDIDATE",
  "DUPLICATE_BINDING",
  "AMBIGUOUS_CAPTURE",
  "HASH_MISMATCH",
  "ORDER_MISMATCH",
]);

export class ReviewEvidenceError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ReviewEvidenceError";
    this.code = code;
    this.details = details;
  }
}

const fail = (code, message, details = null) => {
  throw new ReviewEvidenceError(code, message, details);
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** URL 形式路径（file://、https:// 等任意 scheme://，以及本工具认识的其他 scheme:）。 */
const isUrlLikePath = (value) =>
  /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /^(file|https?|ftp|data|blob|ws|wss|url):/i.test(value);

/** posix 相对路径（evidence 与错误信息统一用 / 分隔，保证跨平台可复现）。 */
const toPosix = (value) => value.split(path.sep).join("/");

const digestOf = (bytes) => createHash("sha256").update(bytes).digest("hex");

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactlyKeys = (value, keys) => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const assertSha256 = (value, label, code) => {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(code, `${label} 必须是 64 位小写 hex（收到 ${JSON.stringify(value) ?? "undefined"}）`);
  }
  return value;
};

// ---------------------------------------------------------------------------
// 路径安全：词法 + 真实路径双检，全部限制在 <rootDir>/docs/validation 之内
// ---------------------------------------------------------------------------

const resolveContained = async (validationRootReal, baseReal, value, label) => {
  if (typeof value !== "string" || value.trim() === "") {
    fail("INVALID_INPUT", `${label} 必须是非空字符串路径`);
  }
  if (isUrlLikePath(value)) {
    fail("PATH_ESCAPE", `${label} 不接受 URL 形式的路径（收到 "${value}"）`);
  }
  const full = path.resolve(baseReal, value);
  // 词法边界先于存在性判断：即使目标存在（如校验根外的 junction 指回根内），
  // 词法越界也一律拒绝——卡面要求相对路径与 realpath 双双落在校验根内。
  const lexicalRelative = path.relative(validationRootReal, full);
  if (lexicalRelative === "" || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
    fail("PATH_ESCAPE", `${label} 词法路径越出校验根（收到 "${value}"）`);
  }
  let real;
  try {
    real = await realpath(full);
  } catch {
    fail("MISSING_FILE", `${label} 不存在：${toPosix(value)}`);
  }
  const realRelative = path.relative(validationRootReal, real);
  if (realRelative === "" || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    fail("PATH_ESCAPE", `${label} 真实路径越出校验根（"${toPosix(value)}" → ${toPosix(real)}）`);
  }
  return real;
};

/**
 * 本工具读取的每个文件：入口不能是符号链接/junction（capture.mjs 与协调者
 * 从不写符号链接，出现即视为篡改向量），真实路径必须落在校验根内，读取走
 * realpath 后的目标。required=false 时文件不存在返回 null（目录也不算存在）。
 */
const readContainedFile = async (validationRootReal, absPath, label, { required = true } = {}) => {
  const entryStat = await lstat(absPath).catch(() => null);
  if (!entryStat) {
    if (!required) return null;
    fail("MISSING_FILE", `${label} 不存在：${toPosix(absPath)}`);
  }
  if (entryStat.isSymbolicLink()) {
    fail("PATH_ESCAPE", `${label} 是符号链接/junction——本工具不读取符号链接（${toPosix(absPath)}）`);
  }
  if (!entryStat.isFile()) {
    fail("MISSING_FILE", `${label} 不是常规文件：${toPosix(absPath)}`);
  }
  const real = await realpath(absPath);
  const realRelative = path.relative(validationRootReal, real);
  if (realRelative === "" || realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
    fail("PATH_ESCAPE", `${label} 真实路径越出校验根：${toPosix(absPath)} → ${toPosix(real)}`);
  }
  try {
    return await readFile(real);
  } catch (error) {
    fail("MISSING_FILE", `${label} 不可读（${error?.code ?? "unknown"}）：${toPosix(real)}`);
  }
};

const readJsonFile = async (validationRootReal, absPath, label, { required = true } = {}) => {
  const bytes = await readContainedFile(validationRootReal, absPath, label, { required });
  if (bytes === null) return { bytes: null };
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    fail("BAD_JSON", `${label} 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`);
  }
};

// ---------------------------------------------------------------------------
// 评审容器（block 3）：固定形状与摘要规则，M4.4.2/M5.7.2 复用
// ---------------------------------------------------------------------------

/** 容器摘要：对去掉自身 assessmentHash 的完整容器做 sha256Canonical。 */
export function hashReviewContainer(container) {
  return sha256Canonical({
    schemaVersion: container.schemaVersion,
    candidateSetHash: container.candidateSetHash,
    assessments: container.assessments,
  });
}

/**
 * 组装评审容器：assessmentHash 按 hashReviewContainer 规则计算。
 * assessments 的顺序由调用方负责（必须已是 CandidateSet 候选顺序）；这里只锁
 * 逐条 M0 合法与 ID 唯一。返回自有深冻数据。
 */
export function buildReviewContainer({ candidateSetHash, assessments }) {
  assertSha256(candidateSetHash, "candidateSetHash", "INVALID_CONTAINER");
  if (!Array.isArray(assessments)) {
    fail("INVALID_CONTAINER", "assessments 必须是 Assessment 数组");
  }
  const seen = new Set();
  const copies = assessments.map((assessment, index) => {
    if (!isPlainObject(assessment)) {
      fail("INVALID_ASSESSMENT", `assessments[${index}] 必须是对象`);
    }
    const check = validateAssessment(assessment);
    if (!check.valid) {
      const first = check.errors[0];
      fail(
        "INVALID_ASSESSMENT",
        `assessments[${index}]（${assessment.candidateId ?? "未知 ID"}）未过 M0 校验：${first.path} ${first.code}：${first.message}`,
      );
    }
    if (seen.has(assessment.candidateId)) {
      fail("DUPLICATE_BINDING", `assessments 中候选 ID 重复 "${assessment.candidateId}"`);
    }
    seen.add(assessment.candidateId);
    return JSON.parse(JSON.stringify(assessment));
  });
  const container = {
    schemaVersion: REVIEW_CONTAINER_SCHEMA_VERSION,
    candidateSetHash,
    assessments: copies,
  };
  return deepFreeze({ ...container, assessmentHash: hashReviewContainer(container) });
}

const loadReviewContainer = async ({ validationRootReal, runReal, candidateSet }) => {
  const absPath = path.join(runReal, "assessments.json");
  const { value } = await readJsonFile(validationRootReal, absPath, "assessments.json", { required: false });
  if (value === undefined) {
    return {
      present: false,
      path: null,
      container: null,
      missingCandidateIds: candidateSet.candidates.map((c) => c.id),
    };
  }
  if (
    !isPlainObject(value) ||
    !hasExactlyKeys(value, ["schemaVersion", "candidateSetHash", "assessments", "assessmentHash"])
  ) {
    fail(
      "INVALID_CONTAINER",
      "assessments.json 必须恰好是 { schemaVersion, candidateSetHash, assessments, assessmentHash }",
    );
  }
  if (value.schemaVersion !== REVIEW_CONTAINER_SCHEMA_VERSION) {
    fail("INVALID_CONTAINER", `assessments.json schemaVersion 必须为 ${REVIEW_CONTAINER_SCHEMA_VERSION}`);
  }
  if (value.candidateSetHash !== candidateSet.data.candidateSetHash) {
    fail("HASH_MISMATCH", `assessments.json 的 candidateSetHash 与候选集不一致（评审与候选不是同一批次）`);
  }
  if (!Array.isArray(value.assessments)) {
    fail("INVALID_CONTAINER", "assessments 必须是 Assessment 数组");
  }
  const candidateById = new Map(candidateSet.candidates.map((candidate) => [candidate.id, candidate]));
  const seenIds = new Set();
  let previousRank = -1;
  const rankById = new Map(candidateSet.candidates.map((candidate, index) => [candidate.id, index]));
  for (const [index, assessment] of value.assessments.entries()) {
    if (!isPlainObject(assessment)) {
      fail("INVALID_ASSESSMENT", `assessments[${index}] 必须是对象`);
    }
    const check = validateAssessment(assessment);
    if (!check.valid) {
      const first = check.errors[0];
      fail(
        "INVALID_ASSESSMENT",
        `assessments[${index}]（${assessment.candidateId ?? "未知 ID"}）未过 M0 校验：${first.path} ${first.code}：${first.message}`,
      );
    }
    if (!candidateById.has(assessment.candidateId)) {
      fail("UNKNOWN_CANDIDATE", `assessments[${index}] 的候选 "${assessment.candidateId}" 不在候选集中`);
    }
    if (seenIds.has(assessment.candidateId)) {
      fail("DUPLICATE_BINDING", `assessments 中候选 ID 重复 "${assessment.candidateId}"`);
    }
    seenIds.add(assessment.candidateId);
    const expectedHash = candidateById.get(assessment.candidateId).candidateHash;
    if (assessment.candidateHash !== expectedHash) {
      fail(
        "HASH_MISMATCH",
        `assessments 中 "${assessment.candidateId}" 的 candidateHash 与候选集不一致（评审不是这条候选的）`,
      );
    }
    const rank = rankById.get(assessment.candidateId);
    if (rank <= previousRank) {
      fail("ORDER_MISMATCH", "assessments 必须按 CandidateSet 候选顺序排列");
    }
    previousRank = rank;
  }
  assertSha256(value.assessmentHash, "assessmentHash", "INVALID_CONTAINER");
  const recomputed = hashReviewContainer({
    schemaVersion: value.schemaVersion,
    candidateSetHash: value.candidateSetHash,
    assessments: value.assessments,
  });
  if (value.assessmentHash !== recomputed) {
    fail("HASH_MISMATCH", "assessmentHash 与容器内容摘要不一致（评审容器被改动或缺漏）");
  }
  const missingCandidateIds = candidateSet.candidates.map((candidate) => candidate.id).filter((id) => !seenIds.has(id));
  return {
    present: true,
    path: "assessments.json",
    container: deepFreeze(JSON.parse(JSON.stringify(value))),
    missingCandidateIds,
  };
};

// ---------------------------------------------------------------------------
// captures-index 与逐候选捕获（block 1）
// ---------------------------------------------------------------------------

const loadCapturesIndex = async ({ validationRootReal, repoRootReal, runReal, capturesIndexPath }) => {
  const indexReal = await resolveContained(validationRootReal, repoRootReal, capturesIndexPath, "capturesIndexPath");
  const indexStat = await stat(indexReal);
  if (!indexStat.isFile()) {
    fail("INVALID_INPUT", "capturesIndexPath 必须指向文件");
  }
  const { value } = await readJsonFile(validationRootReal, indexReal, "captures-index.json");
  if (!isPlainObject(value) || !hasExactlyKeys(value, ["schemaVersion", "captures"])) {
    fail(
      "INVALID_INDEX",
      'captures-index.json 必须恰好是 { schemaVersion, captures: { [candidateId]: "相对runDir的捕获目录" } }',
    );
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    fail("INVALID_INDEX", `captures-index.json schemaVersion 必须为 ${SCHEMA_VERSION}`);
  }
  if (!isPlainObject(value.captures)) {
    fail("INVALID_INDEX", "captures 必须是 { [candidateId]: 路径 } 映射");
  }
  const bindings = [];
  for (const [candidateId, valuePath] of Object.entries(value.captures)) {
    if (typeof valuePath !== "string" || valuePath.trim() === "") {
      fail("INVALID_INDEX", `captures["${candidateId}"] 必须是非空字符串路径`);
    }
    const real = await resolveContained(validationRootReal, runReal, valuePath, `captures["${candidateId}"]`);
    bindings.push({ candidateId, given: valuePath, real });
  }
  return {
    real: indexReal,
    relativePath: toPosix(path.relative(runReal, indexReal)),
    bindings,
  };
};

/** 绑定目录根部必须有 capture.json；子树里有多个即含糊，有 1 个也说明绑错层级。 */
const resolveCaptureDir = async (binding) => {
  const dirStat = await stat(binding.real).catch(() => null);
  if (!dirStat?.isDirectory()) {
    fail("MISSING_FILE", `captures["${binding.candidateId}"] 必须指向捕获目录（收到 "${toPosix(binding.given)}"）`);
  }
  const captureJsonPath = path.join(binding.real, "capture.json");
  if (await exists(captureJsonPath)) return captureJsonPath;
  const nested = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      const childStat = await lstat(child);
      if (childStat.isSymbolicLink()) {
        fail("PATH_ESCAPE", `捕获目录内出现符号链接/junction（不受本工具契约支持）：${toPosix(child)}`);
      }
      if (childStat.isDirectory()) await walk(child);
      else if (childStat.isFile() && entry.name === "capture.json") nested.push(child);
    }
  };
  await walk(binding.real);
  if (nested.length === 0) {
    fail("MISSING_FILE", `captures["${binding.candidateId}"] 目录内没有 capture.json（"${toPosix(binding.given)}"）`);
  }
  fail(
    "AMBIGUOUS_CAPTURE",
    `captures["${binding.candidateId}"] 根部没有 capture.json，但子树里有 ${nested.length} 个（${nested
      .slice(0, 3)
      .map((p) => toPosix(path.relative(binding.real, p)))
      .join("、")}${nested.length > 3 ? "…" : ""}）——索引必须直接绑定捕获目录本身`,
  );
};

const exists = async (absPath) => {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * 递归收集捕获目录内的原尺寸 PNG 引用。捕获目录内出现任何 symlink/junction
 * 都直接拒绝（capture.mjs 从不写符号链接；静默跳过会让越界引用溜进报告）。
 * 逐项 lstat 判定：Windows 上 readdir 的 dirent 类型对 junction 不可靠，
 * junction 只保证在 lstat 里现形为符号链接。
 */
const collectCaptureImages = async ({ validationRootReal, captureDirReal }) => {
  const images = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      const childStat = await lstat(child);
      if (childStat.isSymbolicLink()) {
        fail("PATH_ESCAPE", `捕获目录内出现符号链接/junction（不受本工具契约支持）：${toPosix(child)}`);
      }
      if (childStat.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!childStat.isFile() || !entry.name.toLowerCase().endsWith(".png")) continue;
      const real = await realpath(child);
      const realRelative = path.relative(validationRootReal, real);
      if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
        fail("PATH_ESCAPE", `捕获图片真实路径越出校验根：${toPosix(real)}`);
      }
      const bytes = (await stat(real)).size;
      images.push({
        path: real,
        relativePath: toPosix(path.relative(captureDirReal, real)),
        bytes,
      });
    }
  };
  await walk(captureDirReal);
  images.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  return images;
};

const loadCandidateCapture = async ({ validationRootReal, runReal, binding, candidate, captureDirRealSeen }) => {
  const seenCandidate = captureDirRealSeen.get(binding.real);
  if (seenCandidate !== undefined) {
    fail(
      "DUPLICATE_BINDING",
      `同一捕获目录被绑定到多个候选："${seenCandidate}" 与 "${binding.candidateId}" 都指向 ${toPosix(binding.given)}`,
    );
  }
  captureDirRealSeen.set(binding.real, binding.candidateId);

  const captureJsonPath = await resolveCaptureDir(binding);
  const { value: capture } = await readJsonFile(
    validationRootReal,
    captureJsonPath,
    `captures["${binding.candidateId}"]/capture.json`,
  );
  if (!isPlainObject(capture)) fail("INVALID_CAPTURE", "capture.json 必须是对象");
  if (capture.schemaVersion !== SCHEMA_VERSION) {
    fail("INVALID_CAPTURE", `capture.json schemaVersion 必须为 ${SCHEMA_VERSION}`);
  }
  if (!CAPTURE_KINDS.includes(capture.kind)) {
    fail("INVALID_CAPTURE", `capture.json kind 必须是 ${CAPTURE_KINDS.join(" / ")}（收到 "${String(capture.kind)}"）`);
  }
  if (!isPlainObject(capture.candidate) || capture.candidate.production === true) {
    fail(
      "INVALID_CAPTURE",
      "候选证据索引不得绑定正式色源捕获（candidate.production=true）；正式模式证据走 M4.4.7 --production 适配",
    );
  }
  if (capture.candidate.id !== binding.candidateId) {
    fail(
      "HASH_MISMATCH",
      `capture.json 的候选 ID（"${String(capture.candidate.id)}"）与索引键（"${binding.candidateId}"）不一致`,
    );
  }
  if (capture.candidate.candidateHash !== candidate.candidateHash) {
    fail("HASH_MISMATCH", `capture.json 的 candidateHash 与候选集不一致（捕获不是这条候选的）`);
  }
  const progressResult = await readJsonFile(
    validationRootReal,
    path.join(binding.real, "progress.json"),
    "progress.json",
    { required: false },
  );
  const images = await collectCaptureImages({ validationRootReal, captureDirReal: binding.real });
  return deepFreeze({
    candidateId: binding.candidateId,
    skinId: candidate.skinId,
    variant: candidate.variant,
    dir: binding.real,
    relativePath: toPosix(path.relative(runReal, binding.real)),
    capture: deepFreeze(JSON.parse(JSON.stringify(capture))),
    progress: progressResult.value === undefined ? null : deepFreeze(JSON.parse(JSON.stringify(progressResult.value))),
    images: deepFreeze(images),
  });
};

// ---------------------------------------------------------------------------
// 出处（block 4）：总集文件或单批内部构建
// ---------------------------------------------------------------------------

const loadOriginsFile = async ({
  validationRootReal,
  runReal,
  originsValue,
  candidateById,
  captureBindingByCandidateId,
}) => {
  if (!isPlainObject(originsValue) || !hasExactlyKeys(originsValue, ["schemaVersion", "origins"])) {
    fail("INVALID_ORIGINS", "assessment-origins.json 必须恰好是 { schemaVersion, origins }");
  }
  if (originsValue.schemaVersion !== ORIGINS_SCHEMA_VERSION) {
    fail("INVALID_ORIGINS", `assessment-origins.json schemaVersion 必须为 ${ORIGINS_SCHEMA_VERSION}`);
  }
  if (!isPlainObject(originsValue.origins)) {
    fail("INVALID_ORIGINS", "origins 必须是 { [candidateId]: origin } 映射");
  }
  const origins = {};
  for (const [candidateId, entry] of Object.entries(originsValue.origins)) {
    if (!candidateById.has(candidateId)) {
      fail("UNKNOWN_CANDIDATE", `origins["${candidateId}"] 不在候选集中`);
    }
    if (
      !isPlainObject(entry) ||
      !["batchRun", "capture", "visualReview", "hashes"].every((key) => key in entry) ||
      Object.keys(entry).some(
        (key) => key !== "currentProfiles" && !["batchRun", "capture", "visualReview", "hashes"].includes(key),
      )
    ) {
      fail(
        "INVALID_ORIGINS",
        `origins["${candidateId}"] 必须是 { batchRun, capture, visualReview, hashes }（可选 currentProfiles）`,
      );
    }
    if (
      !isPlainObject(entry.hashes) ||
      !hasExactlyKeys(entry.hashes, ["candidates", "capture", "progress", "visualReview"])
    ) {
      fail(
        "INVALID_ORIGINS",
        `origins["${candidateId}"].hashes 必须是 { candidates, capture, progress, visualReview }`,
      );
    }
    const batchRunReal = await resolveContained(
      validationRootReal,
      runReal,
      entry.batchRun,
      `origins["${candidateId}"].batchRun`,
    );
    const batchRunStat = await stat(batchRunReal);
    if (!batchRunStat.isDirectory()) {
      fail("INVALID_ORIGINS", `origins["${candidateId}"].batchRun 必须指向原批次 run 目录`);
    }
    const captureReal = await resolveContained(
      validationRootReal,
      runReal,
      entry.capture,
      `origins["${candidateId}"].capture`,
    );
    if (!(await exists(path.join(captureReal, "capture.json")))) {
      fail("MISSING_FILE", `origins["${candidateId}"].capture 目录内没有 capture.json（"${toPosix(entry.capture)}"）`);
    }
    let visualReviewReal = null;
    if (entry.visualReview !== null) {
      visualReviewReal = await resolveContained(
        validationRootReal,
        runReal,
        entry.visualReview,
        `origins["${candidateId}"].visualReview`,
      );
      if (!(await stat(visualReviewReal)).isFile()) {
        fail("INVALID_ORIGINS", `origins["${candidateId}"].visualReview 必须指向文件`);
      }
    }
    // candidates/capture 是必需出处：摘要必须是非空有效 sha256，原文件必须存在
    // 且字节一致（null 不是"跳过核验"，是非法出处）。progress/visualReview 才是
    // 无引用时允许 null 的可选附件。
    const verifyHash = async (recorded, absPath, label, { optional = false } = {}) => {
      const bytes = await readContainedFile(validationRootReal, absPath, `origins["${candidateId}"].${label}`, {
        required: !optional || recorded !== null,
      });
      if (bytes === null) {
        if (recorded !== null) {
          fail("MISSING_FILE", `origins["${candidateId}"].hashes.${label} 已登记但 ${label} 文件不存在`);
        }
        return;
      }
      if (recorded === null) {
        fail(
          "INVALID_ORIGINS",
          `origins["${candidateId}"].hashes.${label} 为 null 但 ${label} 文件存在（必需摘要不得为 null，或删除多余文件）`,
        );
      }
      assertSha256(recorded, `origins["${candidateId}"].hashes.${label}`, "INVALID_ORIGINS");
      const actual = digestOf(bytes);
      if (actual !== recorded) {
        fail("HASH_MISMATCH", `origins["${candidateId}"].hashes.${label} 与当前文件不一致（出处登记后原文件已变化）`);
      }
    };
    assertSha256(entry.hashes.candidates, `origins["${candidateId}"].hashes.candidates`, "INVALID_ORIGINS");
    assertSha256(entry.hashes.capture, `origins["${candidateId}"].hashes.capture`, "INVALID_ORIGINS");
    await verifyHash(entry.hashes.candidates, path.join(batchRunReal, "candidates.json"), "candidates");
    await verifyHash(entry.hashes.capture, path.join(captureReal, "capture.json"), "capture");
    await verifyHash(entry.hashes.progress, path.join(captureReal, "progress.json"), "progress", { optional: true });
    if (entry.hashes.visualReview === null && entry.visualReview !== null) {
      fail("INVALID_ORIGINS", `origins["${candidateId}"].visualReview 已登记但 hashes.visualReview 为 null`);
    }
    if (entry.hashes.visualReview !== null && entry.visualReview === null) {
      fail("INVALID_ORIGINS", `origins["${candidateId}"].visualReview 为 null 但 hashes.visualReview 已登记`);
    }
    if (entry.visualReview !== null) {
      await verifyHash(entry.hashes.visualReview, visualReviewReal, "visualReview");
    }
    // 当前配方出处（可选通道，M4.4.2 协同扩展）：{path, sha256}——path 相对
    // 出处文件所在 run 且必须留在该 run 内（当前配方来源随证据自包含，禁跨批
    // 引用/绝对/URL/".."），sha256 钉住文件字节。登记即核验：文件必须存在且
    // 字节一致（与 candidates/capture 同级的 fatal）；未登记（缺省/null）=
    // 未提供当前配方来源，由 M4.4.2 记阻断缺件，不在此伪造。
    if (entry.currentProfiles !== undefined && entry.currentProfiles !== null) {
      const ref = entry.currentProfiles;
      if (!isPlainObject(ref) || !hasExactlyKeys(ref, ["path", "sha256"])) {
        fail("INVALID_ORIGINS", `origins["${candidateId}"].currentProfiles 必须是 { path, sha256 }`);
      }
      if (typeof ref.path !== "string" || ref.path.length === 0) {
        fail("INVALID_ORIGINS", `origins["${candidateId}"].currentProfiles.path 必须是非空字符串`);
      }
      const refSegments = ref.path.split("/");
      if (
        ref.path.includes("\\") ||
        path.posix.isAbsolute(ref.path) ||
        isUrlLikePath(ref.path) ||
        refSegments.some((segment) => segment === "" || segment === "." || segment === "..")
      ) {
        fail(
          "INVALID_ORIGINS",
          `origins["${candidateId}"].currentProfiles.path 必须是出处 run 内的相对路径（禁绝对/URL/../反斜杠/空段）`,
        );
      }
      const currentProfilesReal = await resolveContained(
        validationRootReal,
        runReal,
        ref.path,
        `origins["${candidateId}"].currentProfiles.path`,
      );
      // 词法段已禁 ".."，run 内合法相对路径词法上不可能离开 run；但 run 内
      // junction 可把真实路径重定向到别的 run（仍在校验根内，resolveContained
      // 不拦）。声明口径是"留在出处 run 内"（证据自包含、.2 从 run 根重读），
      // 所以真实路径必须对 runReal 二次包含——越出即 PATH_ESCAPE，交 .2 只会
      // 误报"来源已变化"。
      const runRelative = path.relative(runReal, currentProfilesReal);
      if (runRelative === "" || runRelative.startsWith("..") || path.isAbsolute(runRelative)) {
        fail(
          "PATH_ESCAPE",
          `origins["${candidateId}"].currentProfiles.path 真实路径越出出处 run（"${toPosix(ref.path)}" → ${toPosix(currentProfilesReal)}）`,
        );
      }
      const currentProfilesBytes = await readContainedFile(
        validationRootReal,
        currentProfilesReal,
        `origins["${candidateId}"].currentProfiles.path`,
      );
      assertSha256(ref.sha256, `origins["${candidateId}"].currentProfiles.sha256`, "INVALID_ORIGINS");
      if (digestOf(currentProfilesBytes) !== ref.sha256) {
        fail("HASH_MISMATCH", `origins["${candidateId}"].currentProfiles.sha256 与当前文件不一致（登记后来源已变化）`);
      }
    }
    if (captureBindingByCandidateId.has(candidateId)) {
      const bindingReal = captureBindingByCandidateId.get(candidateId);
      if (bindingReal !== captureReal) {
        fail("HASH_MISMATCH", `origins["${candidateId}"].capture 与 captures-index 绑定不一致（两处指向不同捕获目录）`);
      }
    }
    origins[candidateId] = deepFreeze(JSON.parse(JSON.stringify(entry)));
  }
  return origins;
};

/**
 * 单批内部出处：只为本 run 之内的捕获构建（batchRun="."，候选摘要取本 run 的
 * candidates.json）。索引里的跨批相对引用（../<batchRun>/…）在没有
 * assessment-origins.json 时不许伪造出处——登记为缺项，交 M4.4.2 用明确出处核验。
 */
const buildInternalOrigins = async ({
  validationRootReal,
  runReal,
  candidateSet,
  captureByCandidateId,
  visualReviewPresent,
}) => {
  const isInsideRun = (dir) => {
    const rel = path.relative(runReal, dir);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  const candidatesBytes = await readContainedFile(
    validationRootReal,
    path.join(runReal, "candidates.json"),
    "candidates.json",
  );
  const visualReviewBytes = visualReviewPresent
    ? await readContainedFile(validationRootReal, path.join(runReal, "visual-review.json"), "visual-review.json")
    : null;
  const origins = {};
  const externalCandidateIds = [];
  for (const candidate of candidateSet.candidates) {
    const captureEvidence = captureByCandidateId.get(candidate.id);
    if (!captureEvidence) continue;
    if (!isInsideRun(captureEvidence.dir)) {
      externalCandidateIds.push(candidate.id);
      continue;
    }
    const captureBytes = await readContainedFile(
      validationRootReal,
      path.join(captureEvidence.dir, "capture.json"),
      "capture.json",
    );
    const progressBytes = captureEvidence.progress
      ? await readContainedFile(validationRootReal, path.join(captureEvidence.dir, "progress.json"), "progress.json")
      : null;
    origins[candidate.id] = deepFreeze({
      batchRun: ".",
      capture: captureEvidence.relativePath,
      visualReview: visualReviewPresent ? "visual-review.json" : null,
      hashes: {
        candidates: digestOf(candidatesBytes),
        capture: digestOf(captureBytes),
        progress: progressBytes ? digestOf(progressBytes) : null,
        visualReview: visualReviewBytes ? digestOf(visualReviewBytes) : null,
      },
    });
  }
  return { origins, externalCandidateIds };
};

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export async function loadReviewEvidence({ runDir, capturesIndexPath, rootDir = REPO_ROOT } = {}) {
  if (rootDir === null || rootDir === undefined || typeof rootDir !== "string" || rootDir.trim() === "") {
    fail("INVALID_INPUT", "rootDir 必须是非空字符串路径（默认仓库根）");
  }
  if (typeof runDir !== "string" || runDir.trim() === "") {
    fail("INVALID_INPUT", "runDir 必须是非空字符串路径");
  }
  if (typeof capturesIndexPath !== "string" || capturesIndexPath.trim() === "") {
    fail("INVALID_INPUT", "capturesIndexPath 必须是非空字符串路径（显式索引，绝不自动找“最新”）");
  }
  // 相对 runDir / capturesIndexPath 一律以仓库根为解析基点（realpath(rootDir)），
  // 不从 validationRoot 反推 dirname——那会把基点错算到 <root>/docs。
  let rootReal;
  try {
    rootReal = await realpath(path.resolve(rootDir));
  } catch {
    fail("INVALID_INPUT", `rootDir 必须指向已存在的目录（收到 "${rootDir}"）`);
  }
  let validationRootReal;
  try {
    validationRootReal = await realpath(path.join(rootReal, "docs", "validation"));
  } catch {
    fail(
      "INVALID_INPUT",
      `${toPosix(path.join(rootReal, "docs", "validation"))} 不存在——rootDir 下必须有 docs/validation`,
    );
  }
  const repoRootReal = rootReal;

  const runReal = await resolveContained(validationRootReal, repoRootReal, runDir, "runDir");
  const runStat = await stat(runReal);
  if (!runStat.isDirectory()) {
    fail("INVALID_INPUT", "runDir 必须指向已存在的运行目录");
  }

  // ---- 候选集（核心，缺失即致命） ----
  const candidatesRead = await readJsonFile(
    validationRootReal,
    path.join(runReal, "candidates.json"),
    "candidates.json",
    {
      required: false,
    },
  );
  if (candidatesRead.value === undefined) {
    fail("MISSING_FILE", "candidates.json 不存在——运行目录缺少候选集（generate-cli 产物），无法加载评审证据");
  }
  const candidateSetValue = candidatesRead.value;
  if (!isPlainObject(candidateSetValue)) {
    fail("INVALID_CANDIDATE_SET", "candidates.json 必须是 CandidateSet 对象");
  }
  const setCheck = validateCandidateSet(candidateSetValue, { expectedSkinIds: [] });
  if (!setCheck.valid) {
    const first = setCheck.errors[0];
    fail(
      "INVALID_CANDIDATE_SET",
      `candidates.json 未过 M0 CandidateSet 校验（局部批次口径）：${first.path} ${first.code}：${first.message}`,
      { errors: setCheck.errors.slice(0, 5) },
    );
  }
  const candidateSet = deepFreeze(JSON.parse(JSON.stringify(candidateSetValue)));
  const candidateById = new Map(candidateSetValue.candidates.map((candidate) => [candidate.id, candidate]));

  // 覆盖单独核对：局部批次合法，只登记覆盖事实，不强造去重掉的第三份
  const skinsCoverage = new Map(SKIN_IDS.map((skinId) => [skinId, []]));
  for (const candidate of candidateSetValue.candidates) {
    skinsCoverage.get(candidate.skinId)?.push(candidate.variant);
  }
  const coverage = deepFreeze({
    skins: deepFreeze(Object.fromEntries([...skinsCoverage.entries()].filter(([, variants]) => variants.length > 0))),
    candidateCount: candidateSetValue.candidates.length,
    rejectedCount: candidateSetValue.rejected.length,
    missingSkins: deepFreeze(SKIN_IDS.filter((skinId) => (skinsCoverage.get(skinId) ?? []).length === 0)),
  });

  // ---- 显式捕获索引 ----
  const index = await loadCapturesIndex({ validationRootReal, repoRootReal, runReal, capturesIndexPath });
  for (const binding of index.bindings) {
    if (!candidateById.has(binding.candidateId)) {
      fail("UNKNOWN_CANDIDATE", `captures-index 绑定的候选 "${binding.candidateId}" 不在候选集中`);
    }
  }

  // ---- 评审容器 / 视觉初筛 / 选择 ----
  const review = await loadReviewContainer({
    validationRootReal,
    runReal,
    candidateSet: { data: candidateSet, candidates: candidateSetValue.candidates },
  });

  const visualRead = await readJsonFile(
    validationRootReal,
    path.join(runReal, "visual-review.json"),
    "visual-review.json",
    {
      required: false,
    },
  );
  let visualReview;
  if (visualRead.value === undefined) {
    visualReview = { present: false, path: null, reviews: null };
  } else {
    if (!isPlainObject(visualRead.value) || !hasExactlyKeys(visualRead.value, ["schemaVersion", "reviews"])) {
      fail(
        "INVALID_VISUAL_REVIEW",
        "visual-review.json 必须恰好是 { schemaVersion, reviews: { [candidateId]: 视觉意见 } }",
      );
    }
    if (visualRead.value.schemaVersion !== SCHEMA_VERSION) {
      fail("INVALID_VISUAL_REVIEW", `visual-review.json schemaVersion 必须为 ${SCHEMA_VERSION}`);
    }
    if (!isPlainObject(visualRead.value.reviews)) {
      fail("INVALID_VISUAL_REVIEW", "reviews 必须是 { [candidateId]: 视觉意见 } 映射");
    }
    for (const [candidateId, reviewRecord] of Object.entries(visualRead.value.reviews)) {
      if (!candidateById.has(candidateId)) {
        fail("UNKNOWN_CANDIDATE", `visual-review.json 的候选 "${candidateId}" 不在候选集中`);
      }
      if (!isPlainObject(reviewRecord)) {
        fail("INVALID_VISUAL_REVIEW", `visual-review.json["${candidateId}"] 必须是对象（逐条校验由 M3.4 复核时执行）`);
      }
    }
    visualReview = {
      present: true,
      path: "visual-review.json",
      reviews: deepFreeze(JSON.parse(JSON.stringify(visualRead.value.reviews))),
    };
  }

  const selectionsRead = await readJsonFile(
    validationRootReal,
    path.join(runReal, "selections.json"),
    "selections.json",
    {
      required: false,
    },
  );
  let selections;
  if (selectionsRead.value === undefined) {
    selections = { present: false, path: null, record: null, binding: null };
  } else {
    const selectionsCheck = validateSelections(selectionsRead.value);
    if (!selectionsCheck.valid) {
      const first = selectionsCheck.errors[0];
      fail("INVALID_SELECTIONS", `selections.json 未过 M0 校验：${first.path} ${first.code}：${first.message}`, {
        errors: selectionsCheck.errors.slice(0, 5),
      });
    }
    const record = selectionsRead.value;
    for (const [skinId, choice] of Object.entries(record.choices)) {
      const candidate = candidateById.get(choice.candidateId);
      if (!candidate) {
        fail("UNKNOWN_CANDIDATE", `selections.json 中皮肤 "${skinId}" 选择的候选 "${choice.candidateId}" 不在候选集中`);
      }
      if (candidate.skinId !== skinId) {
        fail(
          "INVALID_SELECTIONS",
          `selections.json 中皮肤 "${skinId}" 选择了皮肤 "${candidate.skinId}" 的候选 "${choice.candidateId}"（choices 必须按皮肤归属绑定）`,
        );
      }
      if (choice.candidateHash !== candidate.candidateHash) {
        fail(
          "HASH_MISMATCH",
          `selections.json 中皮肤 "${skinId}" 的 candidateHash 与候选集不一致（选择不是这条候选的）`,
        );
      }
    }
    if (record.candidateSetHash !== candidateSet.candidateSetHash) {
      fail("HASH_MISMATCH", "selections.json 的 candidateSetHash 与候选集不一致（选择绑定到别的批次）");
    }
    const binding = {
      candidateSetHash: true,
      assessmentHash: review.present ? record.assessmentHash === review.container.assessmentHash : null,
    };
    if (review.present && !binding.assessmentHash) {
      fail("HASH_MISMATCH", "selections.json 的 assessmentHash 与评审容器不一致（选择绑定的评审不是这份）");
    }
    selections = {
      present: true,
      path: "selections.json",
      record: deepFreeze(JSON.parse(JSON.stringify(record))),
      binding: deepFreeze(binding),
    };
  }

  // ---- 逐候选捕获 ----
  const captureByCandidateId = new Map();
  const capturesMissing = [];
  const captureDirRealSeen = new Map();
  for (const binding of index.bindings) {
    const captureEvidence = await loadCandidateCapture({
      validationRootReal,
      runReal,
      binding,
      candidate: candidateById.get(binding.candidateId),
      captureDirRealSeen,
    });
    captureByCandidateId.set(binding.candidateId, captureEvidence);
  }
  for (const candidate of candidateSetValue.candidates) {
    if (!captureByCandidateId.has(candidate.id)) capturesMissing.push(candidate.id);
  }

  // ---- 出处：总集文件优先，单批由 run+index 构建内部出处 ----
  const originsRead = await readJsonFile(
    validationRootReal,
    path.join(runReal, "assessment-origins.json"),
    "assessment-origins.json",
    { required: false },
  );
  let origins;
  let originsSource;
  let externalOriginCandidateIds = [];
  if (originsRead.value === undefined) {
    originsSource = "internal";
    const internal = await buildInternalOrigins({
      validationRootReal,
      runReal,
      candidateSet: candidateSetValue,
      captureByCandidateId,
      visualReviewPresent: visualReview.present,
    });
    origins = internal.origins;
    externalOriginCandidateIds = internal.externalCandidateIds;
  } else {
    originsSource = "file";
    origins = await loadOriginsFile({
      validationRootReal,
      runReal,
      originsValue: originsRead.value,
      candidateById,
      captureBindingByCandidateId: new Map(index.bindings.map((binding) => [binding.candidateId, binding.real])),
    });
  }
  const originsMissingCandidateIds = candidateSetValue.candidates
    .map((candidate) => candidate.id)
    .filter((id) => !Object.hasOwn(origins, id));

  // ---- 缺项（无评审保留缺项，不造空 PASS） ----
  const gaps = [];
  if (!review.present) {
    gaps.push({ code: "review-missing", candidateId: null, detail: "assessments.json 不存在——全部候选无评审记录" });
  }
  if (!visualReview.present) {
    gaps.push({
      code: "visual-review-missing",
      candidateId: null,
      detail: "visual-review.json 不存在——视觉初筛未落盘",
    });
  }
  if (selections.present && selections.binding.assessmentHash === null) {
    gaps.push({
      code: "selections-assessment-hash-unverified",
      candidateId: null,
      detail: "selections.json 存在但本 run 无评审容器，assessmentHash 绑定无法核验",
    });
  }
  const assessmentMissingIds = review.present
    ? review.missingCandidateIds
    : candidateSetValue.candidates.map((candidate) => candidate.id);
  for (const candidateId of assessmentMissingIds) {
    gaps.push({ code: "assessment-missing", candidateId, detail: "该候选没有 Assessment 记录" });
  }
  for (const candidateId of capturesMissing) {
    gaps.push({ code: "capture-missing", candidateId, detail: "该候选在 captures-index 中没有绑定捕获目录" });
  }
  for (const candidateId of originsMissingCandidateIds) {
    gaps.push({
      code: "origin-missing",
      candidateId,
      detail: externalOriginCandidateIds.includes(candidateId)
        ? "该候选的捕获目录在当前 run 之外且本 run 没有 assessment-origins.json——跨批引用必须由明确出处登记，不生成内部出处"
        : "该候选没有出处登记",
    });
  }

  return deepFreeze({
    schemaVersion: REVIEW_EVIDENCE_SCHEMA_VERSION,
    run: deepFreeze({
      id: path.basename(runReal),
      dir: runReal,
      relativePath: toPosix(path.relative(validationRootReal, runReal)),
      candidatesPath: "candidates.json",
      index: deepFreeze({ path: index.real, relativePath: index.relativePath }),
    }),
    candidateSet: deepFreeze({ data: candidateSet, coverage }),
    review: deepFreeze(review),
    visualReview: deepFreeze(visualReview),
    selections: deepFreeze(selections),
    captures: deepFreeze(Object.fromEntries(captureByCandidateId)),
    capturesMissing: deepFreeze(capturesMissing),
    origins: deepFreeze({
      source: originsSource,
      path: originsSource === "file" ? "assessment-origins.json" : null,
      origins: deepFreeze(origins),
      missingCandidateIds: deepFreeze(originsMissingCandidateIds),
    }),
    gaps: deepFreeze(gaps),
  });
}

// ---------------------------------------------------------------------------
// 深冻：只冻本模块自建对象（JSON.parse 产物 / 字面量），绝不触及调用方对象
// ---------------------------------------------------------------------------

function deepFreeze(value) {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  for (const key of Object.keys(value)) {
    deepFreeze(value[key]);
  }
  return Object.freeze(value);
}

export default loadReviewEvidence;
