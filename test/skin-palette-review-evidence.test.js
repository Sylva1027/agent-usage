// M4.4.1 证据读取与内部接口（review-evidence.mjs）验收测试。
// 冻结接口 loadReviewEvidence({ runDir, capturesIndexPath, rootDir }) / buildReviewContainer /
// hashReviewContainer / ReviewEvidenceError：
// 合法单候选与局部批次样本可加载、无评审保留缺项不造空 PASS、坏 JSON / 错 ID/hash /
// 重复绑定 / 缺文件 / 真实路径逃逸（junction 与捕获目录内符号链接）/ 含糊 capture 全部
// 明确拒绝、评审容器与 assessmentHash 规则固定、总集出处文件核验（含 M4.4.2 协同
// 扩展的 currentProfiles 可选通道：登记即核验）、两次加载结果可复现。
// 样本全部写进系统临时目录沙箱（rootDir 注入），不启动浏览器，不触碰真实 docs/validation。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SKIN_IDS,
  canonicalFileContent,
  hashCandidate,
  hashCandidateSet,
  hashRoleInputs,
  sha256Canonical,
} from "../scripts/skin-palette/contracts.mjs";
import {
  REVIEW_EVIDENCE_CODES,
  ReviewEvidenceError,
  buildReviewContainer,
  hashReviewContainer,
  loadReviewEvidence,
} from "../scripts/skin-palette/review-evidence.mjs";

const POLICY = JSON.parse(readFileSync(new URL("../scripts/skin-palette/policy.json", import.meta.url), "utf8"));

/** 小 PNG 样本：PNG 签名 + 填充字节；loader 只断言扩展名/字节，不要求可渲染。 */
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 0)]);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

function makeCandidate({ skinId = "chatgpt", variant = "a", identity } = {}) {
  const identityHex = identity ?? IDENTITY_BY_SKIN[skinId];
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
    derivationHash: "b".repeat(64),
    seed: "palette-redesign-v1",
    style: { title: "评审样本", rationale: "M4.4.1 加载样本", identitySource: identityHex },
    parameters: { light: {}, dark: {}, search: {} },
    modes: { light: { ...LIGHT_TOKENS }, dark: { ...DARK_TOKENS } },
  };
  const candidateHash = hashCandidate(base);
  return { ...base, id: `${skinId}-${variant}-${candidateHash.slice(0, 12)}`, candidateHash };
}

function makeCandidateSet(candidates, { rejected = [], derivation = "b".repeat(64) } = {}) {
  const base = {
    schemaVersion: 1,
    inputHashes: {
      profiles: "c".repeat(64),
      policy: sha256Canonical(POLICY),
      roles: hashRoleInputs(),
      derivation,
    },
    candidates,
    rejected,
  };
  return { ...base, candidateSetHash: hashCandidateSet(base) };
}

function makeAssessment(candidate, { readiness = "incomplete" } = {}) {
  const visual =
    readiness === "ready"
      ? { reviewed: true, verdict: "pass", notes: "原尺寸目检通过" }
      : { reviewed: false, verdict: null, notes: "未评审" };
  return {
    schemaVersion: 1,
    candidateId: candidate.id,
    candidateHash: candidate.candidateHash,
    fast: [],
    browser: [],
    visual,
    readiness,
    failures: [],
    unmeasured: [],
    diagnostics: {},
  };
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

async function writeCaptureDir(runDir, relativePath, candidate, options = {}) {
  const {
    kind = "skin-palette-capture-matrix",
    candidateOverride = null,
    pngs = ["light/baseline.png", "dark/baseline.png", "light/states/calendar-open/state.png"],
    progress = false,
  } = options;
  const dir = path.join(runDir, relativePath);
  await mkdir(dir, { recursive: true });
  const capture = {
    schemaVersion: 1,
    kind,
    tool: "scripts/skin-palette/capture.mjs",
    createdAt: "2026-10-06T00:00:00.000Z",
    candidate: candidateOverride ?? captureIdentity(candidate),
    fixtureHash: "1".repeat(64),
    policyHash: sha256Canonical(POLICY),
    sourceHashes: {},
    environment: {},
    stateTimeoutMs: 15000,
    baselineTimeoutMs: 30000,
    retryPolicy: { maxAttemptsPerUnit: 2 },
    measureBaseline: true,
    groups: ["S0"],
    coverage: {},
    untested: [],
    modes: {
      light: { status: "captured", blockers: [], gaps: [], baseline: {}, states: {} },
      dark: { status: "captured", blockers: [], gaps: [], baseline: {}, states: {} },
    },
  };
  await writeFile(path.join(dir, "capture.json"), `${JSON.stringify(capture)}\n`, "utf8");
  for (const pngRelative of pngs) {
    await mkdir(path.dirname(path.join(dir, pngRelative)), { recursive: true });
    await writeFile(path.join(dir, pngRelative), PNG_BYTES);
  }
  if (progress) {
    await writeFile(
      path.join(dir, "progress.json"),
      `${JSON.stringify({ schemaVersion: 1, kind: "skin-palette-capture-progress", units: {} })}\n`,
      "utf8",
    );
  }
  return capture;
}

const writeJson = async (absPath, value) => writeFile(absPath, `${JSON.stringify(value)}\n`, "utf8");

const writeCandidates = async (runDir, candidateSet) =>
  writeFile(path.join(runDir, "candidates.json"), canonicalFileContent(candidateSet), "utf8");

const writeAssessments = async (runDir, container) =>
  writeFile(path.join(runDir, "assessments.json"), canonicalFileContent(container), "utf8");

const writeIndex = async (runDir, captures) =>
  writeJson(path.join(runDir, "captures-index.json"), { schemaVersion: 1, captures });

async function createSandbox() {
  const sandbox = await mkdtemp(path.join(tmpdir(), "skin-palette-review-evidence-"));
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

const rejectsCode = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.ok(
      error instanceof ReviewEvidenceError,
      `期望 ReviewEvidenceError，收到 ${error?.constructor?.name}: ${error?.message}`,
    );
    assert.equal(error.code, code, `错误码应为 ${code}，实际 ${error.code}：${error.message}`);
    return true;
  });

const load = (sandboxBox, runDir, capturesIndexPath) =>
  loadReviewEvidence({ runDir, capturesIndexPath, rootDir: sandboxBox.sandbox });

test("合法单候选样本可加载：覆盖、评审容器、内部出处、图片引用齐备且可复现", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-single");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    const candidateSet = makeCandidateSet([candidate]);
    await writeCandidates(run, candidateSet);
    const captureDir = "captures/cap-1";
    await writeCaptureDir(run, captureDir, candidate);
    const container = buildReviewContainer({
      candidateSetHash: candidateSet.candidateSetHash,
      assessments: [makeAssessment(candidate, { readiness: "ready" })],
    });
    await writeAssessments(run, container);
    await writeIndex(run, { [candidate.id]: captureDir });

    const evidence = await load(sb, run, path.join(run, "captures-index.json"));
    assert.equal(evidence.schemaVersion, 1);
    assert.equal(evidence.run.id, "run-single");
    assert.equal(evidence.run.relativePath, "run-single");
    assert.equal(evidence.run.candidatesPath, "candidates.json");
    assert.deepEqual(evidence.candidateSet.coverage.skins, { chatgpt: ["a"] });
    assert.deepEqual(
      evidence.candidateSet.coverage.missingSkins,
      SKIN_IDS.filter((skinId) => skinId !== "chatgpt"),
    );
    assert.equal(evidence.candidateSet.coverage.candidateCount, 1);
    assert.equal(evidence.candidateSet.data.candidateSetHash, candidateSet.candidateSetHash);

    assert.equal(evidence.review.present, true);
    assert.equal(evidence.review.container.assessmentHash, container.assessmentHash);
    assert.equal(evidence.review.container.candidateSetHash, candidateSet.candidateSetHash);
    assert.deepEqual(evidence.review.missingCandidateIds, []);

    const captureEvidence = evidence.captures[candidate.id];
    assert.equal(captureEvidence.skinId, "chatgpt");
    assert.equal(captureEvidence.variant, "a");
    assert.equal(captureEvidence.relativePath, captureDir);
    assert.equal(captureEvidence.capture.kind, "skin-palette-capture-matrix");
    assert.equal(captureEvidence.progress, null);
    assert.deepEqual(
      captureEvidence.images.map((image) => image.relativePath),
      ["dark/baseline.png", "light/baseline.png", "light/states/calendar-open/state.png"],
    );
    assert.ok(captureEvidence.images.every((image) => image.bytes === PNG_BYTES.length));

    const origin = evidence.origins.origins[candidate.id];
    assert.equal(evidence.origins.source, "internal");
    assert.equal(origin.batchRun, ".");
    assert.equal(origin.capture, captureDir);
    assert.equal(origin.visualReview, null);
    assert.equal(origin.hashes.capture, sha256(await readFile(path.join(captureEvidence.dir, "capture.json"))));
    assert.equal(origin.hashes.candidates, sha256(await readFile(path.join(run, "candidates.json"))));
    assert.equal(origin.hashes.progress, null);
    assert.equal(origin.hashes.visualReview, null);
    assert.deepEqual(evidence.origins.missingCandidateIds, []);

    assert.deepEqual(evidence.gaps, [
      { code: "visual-review-missing", candidateId: null, detail: evidence.gaps[0].detail },
    ]);

    const again = await load(sb, run, path.join(run, "captures-index.json"));
    assert.deepStrictEqual(again, evidence, "两次加载结果必须可复现");
    assert.ok(Object.isFrozen(evidence));
    assert.ok(Object.isFrozen(captureEvidence));
    assert.ok(Object.isFrozen(captureEvidence.images));
  } finally {
    await sb.cleanup();
  }
});

test("无评审保留缺项：不造空 PASS，缺项逐候选登记", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-no-review");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    await writeCandidates(run, makeCandidateSet([candidate]));
    await writeCaptureDir(run, "captures/cap-1", candidate);
    await writeIndex(run, { [candidate.id]: "captures/cap-1" });

    const evidence = await load(sb, run, path.join(run, "captures-index.json"));
    assert.equal(evidence.review.present, false);
    assert.equal(evidence.review.container, null);
    assert.equal(evidence.review.path, null);
    assert.deepEqual(evidence.review.missingCandidateIds, [candidate.id]);
    assert.deepEqual(
      evidence.gaps.map((gap) => gap.code),
      ["review-missing", "visual-review-missing", "assessment-missing"],
    );
    const assessmentGap = evidence.gaps.find((gap) => gap.code === "assessment-missing");
    assert.equal(assessmentGap.candidateId, candidate.id);
  } finally {
    await sb.cleanup();
  }
});

test("局部批次与部分索引合法：缺捕获的候选进 capturesMissing 与 gaps", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-partial");
    const chatgpt = makeCandidate({ skinId: "chatgpt" });
    const claude = makeCandidate({ skinId: "claude" });
    await writeCandidates(run, makeCandidateSet([chatgpt, claude]));
    await writeCaptureDir(run, "captures/chatgpt", chatgpt);
    await writeIndex(run, { [chatgpt.id]: "captures/chatgpt" });

    const evidence = await load(sb, run, path.join(run, "captures-index.json"));
    assert.deepEqual(evidence.candidateSet.coverage.skins, { chatgpt: ["a"], claude: ["a"] });
    assert.deepEqual(evidence.capturesMissing, [claude.id]);
    const captureGap = evidence.gaps.find((gap) => gap.code === "capture-missing");
    assert.equal(captureGap.candidateId, claude.id);
    assert.ok(evidence.captures[chatgpt.id]);
    assert.equal(evidence.captures[claude.id], undefined);
  } finally {
    await sb.cleanup();
  }
});

test("坏 JSON 全部报 BAD_JSON：候选集、评审容器、capture、索引", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-bad-json");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    const candidateSet = makeCandidateSet([candidate]);
    await writeCandidates(run, candidateSet);
    await writeCaptureDir(run, "captures/cap-1", candidate);
    await writeIndex(run, { [candidate.id]: "captures/cap-1" });
    const indexPath = path.join(run, "captures-index.json");

    await writeFile(path.join(run, "assessments.json"), "{broken", "utf8");
    await rejectsCode(load(sb, run, indexPath), "BAD_JSON");

    await writeAssessments(
      run,
      buildReviewContainer({
        candidateSetHash: candidateSet.candidateSetHash,
        assessments: [makeAssessment(candidate)],
      }),
    );
    await writeFile(path.join(run, "captures-index.json"), "not-json", "utf8");
    await rejectsCode(load(sb, run, indexPath), "BAD_JSON");

    await writeIndex(run, { [candidate.id]: "captures/cap-1" });
    await writeFile(path.join(run, "captures", "cap-1", "capture.json"), "{oops", "utf8");
    await rejectsCode(load(sb, run, indexPath), "BAD_JSON");

    await writeCaptureDir(run, "captures/cap-1", candidate);
    await writeFile(path.join(run, "candidates.json"), "{nope", "utf8");
    await rejectsCode(load(sb, run, indexPath), "BAD_JSON");
  } finally {
    await sb.cleanup();
  }
});

test("错 ID/hash 明确拒绝：capture 绑定、未知候选、容器与 assessment 绑定", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-mismatch");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    const candidateSet = makeCandidateSet([candidate]);
    await writeCandidates(run, candidateSet);
    await writeIndex(run, { [candidate.id]: "captures/cap-1" });
    const indexPath = path.join(run, "captures-index.json");

    // capture.json 的 candidateHash 与候选集不一致
    await writeCaptureDir(run, "captures/cap-1", candidate, {
      candidateOverride: { ...captureIdentity(candidate), candidateHash: "f".repeat(64) },
    });
    await rejectsCode(load(sb, run, indexPath), "HASH_MISMATCH");

    // capture.json 的候选 ID 与索引键不一致
    await writeCaptureDir(run, "captures/cap-1", candidate, {
      candidateOverride: { ...captureIdentity(candidate), id: "chatgpt-b-deadbeef1234" },
    });
    await rejectsCode(load(sb, run, indexPath), "HASH_MISMATCH");

    // 索引键不在候选集
    await writeCaptureDir(run, "captures/cap-1", candidate);
    await writeIndex(run, { "claude-a-000000000000": "captures/cap-1" });
    await rejectsCode(load(sb, run, indexPath), "UNKNOWN_CANDIDATE");

    // 容器 candidateSetHash 与候选集不一致
    await writeIndex(run, { [candidate.id]: "captures/cap-1" });
    const assessment = makeAssessment(candidate);
    await writeAssessments(run, buildReviewContainer({ candidateSetHash: "a".repeat(64), assessments: [assessment] }));
    await rejectsCode(load(sb, run, indexPath), "HASH_MISMATCH");

    // 容器 assessmentHash 被改动
    const container = buildReviewContainer({
      candidateSetHash: candidateSet.candidateSetHash,
      assessments: [assessment],
    });
    await writeJson(path.join(run, "assessments.json"), {
      ...JSON.parse(JSON.stringify(container)),
      assessmentHash: container.assessmentHash.slice(0, 63) + (container.assessmentHash.endsWith("0") ? "1" : "0"),
    });
    await rejectsCode(load(sb, run, indexPath), "HASH_MISMATCH");

    // assessment 的 candidateHash 与候选集不一致（hash 保持自洽以先到绑定检查）
    const wrongBinding = JSON.parse(
      JSON.stringify(
        buildReviewContainer({
          candidateSetHash: candidateSet.candidateSetHash,
          assessments: [{ ...assessment, candidateHash: "e".repeat(64) }],
        }),
      ),
    );
    wrongBinding.assessmentHash = hashReviewContainer(wrongBinding);
    await writeJson(path.join(run, "assessments.json"), wrongBinding);
    await rejectsCode(load(sb, run, indexPath), "HASH_MISMATCH");
  } finally {
    await sb.cleanup();
  }
});

test("重复绑定明确拒绝：同一捕获目录两个候选、assessments 重复 ID", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-duplicate");
    const chatgpt = makeCandidate({ skinId: "chatgpt" });
    const claude = makeCandidate({ skinId: "claude" });
    await writeCandidates(run, makeCandidateSet([chatgpt, claude]));
    await writeCaptureDir(run, "captures/cap-1", chatgpt);
    await writeCaptureDir(run, "captures/cap-2", claude);

    // 两种词法写法，realpath 相同
    await writeIndex(run, { [chatgpt.id]: "captures/cap-1", [claude.id]: "./captures/cap-1" });
    await rejectsCode(load(sb, run, path.join(run, "captures-index.json")), "DUPLICATE_BINDING");

    // assessments 出现重复候选 ID（hash 留旧值，先撞重复检查）
    await writeIndex(run, { [chatgpt.id]: "captures/cap-1", [claude.id]: "captures/cap-2" });
    const container = buildReviewContainer({
      candidateSetHash: makeCandidateSet([chatgpt, claude]).candidateSetHash,
      assessments: [makeAssessment(chatgpt)],
    });
    const duplicated = JSON.parse(JSON.stringify(container));
    duplicated.assessments.push({ ...duplicated.assessments[0] });
    await writeJson(path.join(run, "assessments.json"), duplicated);
    await rejectsCode(load(sb, run, path.join(run, "captures-index.json")), "DUPLICATE_BINDING");
  } finally {
    await sb.cleanup();
  }
});

test("缺文件明确拒绝：候选集、索引、capture.json、出处登记的 progress", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-missing");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    const candidateSet = makeCandidateSet([candidate]);
    const indexPath = path.join(run, "captures-index.json");

    await writeIndex(run, {});
    await rejectsCode(load(sb, run, indexPath), "MISSING_FILE");

    await writeCandidates(run, candidateSet);
    await rejectsCode(load(sb, run, path.join(run, "no-index.json")), "MISSING_FILE");

    await writeIndex(run, { [candidate.id]: "captures/empty-dir" });
    await mkdir(path.join(run, "captures", "empty-dir"), { recursive: true });
    await rejectsCode(load(sb, run, indexPath), "MISSING_FILE");

    // 总集出处登记了 progress hash 但 progress.json 不存在（candidates/capture hash 先自洽）
    await writeCaptureDir(run, "captures/cap-1", candidate);
    await writeIndex(run, { [candidate.id]: "captures/cap-1" });
    await writeJson(path.join(run, "assessment-origins.json"), {
      schemaVersion: 1,
      origins: {
        [candidate.id]: {
          batchRun: ".",
          capture: "captures/cap-1",
          visualReview: null,
          hashes: {
            candidates: sha256(readFileSync(path.join(run, "candidates.json"))),
            capture: sha256(readFileSync(path.join(run, "captures", "cap-1", "capture.json"))),
            progress: "3".repeat(64),
            visualReview: null,
          },
        },
      },
    });
    await rejectsCode(load(sb, run, indexPath), "MISSING_FILE");
  } finally {
    await sb.cleanup();
  }
});

test("真实路径逃逸明确拒绝：词法越界、junction 越界、runDir 越界、URL、捕获目录内链接", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-escape");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    await writeCandidates(run, makeCandidateSet([candidate]));
    await writeCaptureDir(run, "captures/cap-1", candidate);
    const indexPath = path.join(run, "captures-index.json");

    await writeIndex(run, { [candidate.id]: "../../outside/capture" });
    await rejectsCode(load(sb, run, indexPath), "PATH_ESCAPE");

    // junction 指向校验根之外：词法看着合法，真实路径现形
    const outside = path.join(sb.sandbox, "outside-real");
    await mkdir(path.join(outside, "cap"), { recursive: true });
    const junction = path.join(run, "captures", "jn");
    await symlink(outside, junction, "junction");
    await writeIndex(run, { [candidate.id]: "captures/jn" });
    await rejectsCode(load(sb, run, indexPath), "PATH_ESCAPE");
    await rm(junction, { recursive: true, force: true });

    await writeIndex(run, { [candidate.id]: "captures/cap-1" });
    await rejectsCode(load(sb, path.join(sb.sandbox, "elsewhere"), indexPath), "PATH_ESCAPE");
    await rejectsCode(load(sb, sb.validationRoot, indexPath), "PATH_ESCAPE", "校验根自身不能当 runDir");

    await writeIndex(run, { [candidate.id]: "file:///E:/somewhere/capture" });
    await rejectsCode(load(sb, run, indexPath), "PATH_ESCAPE");

    await writeIndex(run, { [candidate.id]: "captures/cap-1" });
    const insideLink = path.join(run, "captures", "cap-1", "light", "link");
    await symlink(path.join(sb.sandbox, "docs"), insideLink, "junction");
    await rejectsCode(load(sb, run, indexPath), "PATH_ESCAPE");
  } finally {
    await sb.cleanup();
  }
});

test("含糊的多个 capture 明确拒绝：索引必须直接绑定捕获目录本身", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-ambiguous");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    await writeCandidates(run, makeCandidateSet([candidate]));
    const parent = "captures/parent";
    await mkdir(path.join(run, parent), { recursive: true });
    await writeCaptureDir(run, `${parent}/sub-1`, candidate);
    await writeCaptureDir(run, `${parent}/sub-2`, candidate);
    await writeIndex(run, { [candidate.id]: parent });
    await rejectsCode(load(sb, run, path.join(run, "captures-index.json")), "AMBIGUOUS_CAPTURE");

    // 子树里只有一个 capture.json 也不猜：绑定目录必须就是捕获目录
    await rm(path.join(run, parent, "sub-2"), { recursive: true, force: true });
    await rejectsCode(load(sb, run, path.join(run, "captures-index.json")), "AMBIGUOUS_CAPTURE");
  } finally {
    await sb.cleanup();
  }
});

test("assessments 顺序必须按候选顺序", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-order");
    const chatgpt = makeCandidate({ skinId: "chatgpt" });
    const claude = makeCandidate({ skinId: "claude" });
    const candidateSet = makeCandidateSet([chatgpt, claude]);
    await writeCandidates(run, candidateSet);
    await writeCaptureDir(run, "captures/cap-1", chatgpt);
    await writeCaptureDir(run, "captures/cap-2", claude);
    await writeIndex(run, { [chatgpt.id]: "captures/cap-1", [claude.id]: "captures/cap-2" });
    const container = buildReviewContainer({
      candidateSetHash: candidateSet.candidateSetHash,
      assessments: [makeAssessment(chatgpt), makeAssessment(claude)],
    });
    const reversed = JSON.parse(JSON.stringify(container));
    reversed.assessments.reverse();
    reversed.assessmentHash = hashReviewContainer(reversed);
    await writeJson(path.join(run, "assessments.json"), reversed);
    await rejectsCode(load(sb, run, path.join(run, "captures-index.json")), "ORDER_MISMATCH");
  } finally {
    await sb.cleanup();
  }
});

test("单条 Assessment 未过 M0 校验即拒绝；production/未知 kind 捕获拒绝", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-invalid");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    const candidateSet = makeCandidateSet([candidate]);
    await writeCandidates(run, candidateSet);
    await writeCaptureDir(run, "captures/cap-1", candidate);
    await writeIndex(run, { [candidate.id]: "captures/cap-1" });
    const indexPath = path.join(run, "captures-index.json");

    const brokenContainer = JSON.parse(
      JSON.stringify(
        buildReviewContainer({
          candidateSetHash: candidateSet.candidateSetHash,
          assessments: [makeAssessment(candidate)],
        }),
      ),
    );
    delete brokenContainer.assessments[0].readiness;
    brokenContainer.assessmentHash = hashReviewContainer(brokenContainer);
    await writeJson(path.join(run, "assessments.json"), brokenContainer);
    await rejectsCode(load(sb, run, indexPath), "INVALID_ASSESSMENT");
    await rm(path.join(run, "assessments.json"), { force: true });

    await writeCaptureDir(run, "captures/cap-1", candidate, {
      candidateOverride: { production: true, skinId: "chatgpt" },
    });
    await rejectsCode(load(sb, run, indexPath), "INVALID_CAPTURE");

    await writeCaptureDir(run, "captures/cap-1", candidate, { kind: "skin-palette-capture-unknown" });
    await rejectsCode(load(sb, run, indexPath), "INVALID_CAPTURE");
  } finally {
    await sb.cleanup();
  }
});

test("visual-review.json：合法信封加载并进入内部出处；未知候选/坏信封拒绝", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-visual");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    const candidateSet = makeCandidateSet([candidate]);
    await writeCandidates(run, candidateSet);
    await writeCaptureDir(run, "captures/cap-1", candidate);
    await writeIndex(run, { [candidate.id]: "captures/cap-1" });
    const indexPath = path.join(run, "captures-index.json");

    await writeJson(path.join(run, "visual-review.json"), {
      schemaVersion: 1,
      reviews: {
        [candidate.id]: { reviewer: "视觉初筛代理", by: "proxy", verdict: "accept", notes: "八项 accept" },
      },
    });
    const evidence = await load(sb, run, indexPath);
    assert.equal(evidence.visualReview.present, true);
    assert.equal(evidence.visualReview.reviews[candidate.id].by, "proxy");
    assert.equal(evidence.origins.origins[candidate.id].visualReview, "visual-review.json");
    assert.equal(
      evidence.origins.origins[candidate.id].hashes.visualReview,
      sha256(await readFile(path.join(run, "visual-review.json"))),
    );
    assert.ok(!evidence.gaps.some((gap) => gap.code === "visual-review-missing"));

    await writeJson(path.join(run, "visual-review.json"), {
      schemaVersion: 1,
      reviews: { "claude-a-000000000000": { reviewer: "x", by: "proxy", verdict: "pending", notes: "" } },
    });
    await rejectsCode(load(sb, run, indexPath), "UNKNOWN_CANDIDATE");

    await writeJson(path.join(run, "visual-review.json"), { schemaVersion: 1, reviews: {}, extra: true });
    await rejectsCode(load(sb, run, indexPath), "INVALID_VISUAL_REVIEW");
  } finally {
    await sb.cleanup();
  }
});

test("总集出处文件：跨批次相对引用核验 hash，与索引一致才放行", async () => {
  const sb = await createSandbox();
  try {
    const batchRun = await sb.makeRun("run-batch");
    const aggRun = await sb.makeRun("run-agg");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    const batchSet = makeCandidateSet([candidate], { derivation: "b".repeat(64) });
    const aggSet = makeCandidateSet([candidate], { derivation: "c".repeat(64) });
    await writeCandidates(batchRun, batchSet);
    await writeCandidates(aggRun, aggSet);
    await writeCaptureDir(batchRun, "captures/cap-1", candidate);
    await writeCaptureDir(batchRun, "captures/cap-2", candidate);
    await writeIndex(aggRun, { [candidate.id]: "../run-batch/captures/cap-1" });
    const indexPath = path.join(aggRun, "captures-index.json");

    const originsRecord = (overrides = {}) => ({
      schemaVersion: 1,
      origins: {
        [candidate.id]: {
          batchRun: "../run-batch",
          capture: "../run-batch/captures/cap-1",
          visualReview: null,
          hashes: {
            candidates: sha256(readFileSync(path.join(batchRun, "candidates.json"))),
            capture: sha256(readFileSync(path.join(batchRun, "captures", "cap-1", "capture.json"))),
            progress: null,
            visualReview: null,
          },
          ...overrides,
        },
      },
    });

    await writeJson(path.join(aggRun, "assessment-origins.json"), originsRecord());
    const evidence = await load(sb, aggRun, indexPath);
    assert.equal(evidence.origins.source, "file");
    assert.equal(evidence.origins.origins[candidate.id].batchRun, "../run-batch");
    assert.deepEqual(evidence.origins.missingCandidateIds, []);

    await writeJson(
      path.join(aggRun, "assessment-origins.json"),
      originsRecord({
        hashes: {
          candidates: sha256(readFileSync(path.join(batchRun, "candidates.json"))),
          capture: "9".repeat(64),
          progress: null,
          visualReview: null,
        },
      }),
    );
    await rejectsCode(load(sb, aggRun, indexPath), "HASH_MISMATCH", "出处登记后 capture.json 变化必须拒绝");

    await writeJson(
      path.join(aggRun, "assessment-origins.json"),
      originsRecord({ capture: "../run-batch/captures/cap-2" }),
    );
    await rejectsCode(load(sb, aggRun, indexPath), "HASH_MISMATCH", "origins.capture 与索引绑定不一致必须拒绝");

    await writeJson(path.join(aggRun, "assessment-origins.json"), {
      schemaVersion: 1,
      origins: {
        "muse-a-000000000000": {
          batchRun: ".",
          capture: "captures/x",
          visualReview: null,
          hashes: { candidates: null, capture: null, progress: null, visualReview: null },
        },
      },
    });
    await rejectsCode(load(sb, aggRun, indexPath), "UNKNOWN_CANDIDATE");

    await writeJson(path.join(aggRun, "assessment-origins.json"), { schemaVersion: 1, origins: {} });
    const partial = await load(sb, aggRun, indexPath);
    assert.deepEqual(partial.origins.missingCandidateIds, [candidate.id]);
    assert.ok(partial.gaps.some((gap) => gap.code === "origin-missing" && gap.candidateId === candidate.id));
  } finally {
    await sb.cleanup();
  }
});

test("总集出处 currentProfiles 通道：登记即核验——漂移/缺失 fatal，坏路径与坏 ref 形状拒绝，null 放行", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-recipes");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    await writeCandidates(run, makeCandidateSet([candidate]));
    await writeCaptureDir(run, "captures/cap-1", candidate);
    await writeIndex(run, { [candidate.id]: "captures/cap-1" });
    const indexPath = path.join(run, "captures-index.json");
    const originsWith = (currentProfiles, overrides = {}) => ({
      schemaVersion: 1,
      origins: {
        [candidate.id]: {
          batchRun: ".",
          capture: "captures/cap-1",
          visualReview: null,
          hashes: {
            candidates: sha256(readFileSync(path.join(run, "candidates.json"))),
            capture: sha256(readFileSync(path.join(run, "captures", "cap-1", "capture.json"))),
            progress: null,
            visualReview: null,
          },
          ...(currentProfiles === undefined ? {} : { currentProfiles }),
          ...overrides,
        },
      },
    });
    const register = async (content) => {
      await writeFile(path.join(run, "current-profiles.json"), content, "utf8");
      await writeJson(
        path.join(run, "assessment-origins.json"),
        originsWith({ path: "current-profiles.json", sha256: sha256(Buffer.from(content, "utf8")) }),
      );
    };

    // 登记且字节一致 → 载入通过，evidence 原样携带登记
    const content = `${JSON.stringify({ [candidate.skinId]: { identityHex: "#4F4971" } })}\n`;
    await register(content);
    const evidence = await load(sb, run, indexPath);
    assert.deepEqual(evidence.origins.origins[candidate.id].currentProfiles, {
      path: "current-profiles.json",
      sha256: sha256(Buffer.from(content, "utf8")),
    });

    // 登记后字节漂移 → HASH_MISMATCH（登记即核验）
    await writeFile(path.join(run, "current-profiles.json"), `${content}x`, "utf8");
    await rejectsCode(load(sb, run, indexPath), "HASH_MISMATCH");

    // 登记但文件缺失 → MISSING_FILE
    await register(content);
    await rm(path.join(run, "current-profiles.json"));
    await rejectsCode(load(sb, run, indexPath), "MISSING_FILE");

    // run 内 junction 指向另一 run：词法合法、真实路径仍在校验根内，但越出
    // 出处 run → PATH_ESCAPE（登记即拒；摘要诚实，拦的是包含关系不是字节）
    const otherRun = await sb.makeRun("run-recipes-other");
    await writeFile(path.join(otherRun, "profiles.json"), content, "utf8");
    const junctionDir = path.join(run, "jn-dir");
    await symlink(otherRun, junctionDir, "junction");
    await writeJson(
      path.join(run, "assessment-origins.json"),
      originsWith({
        path: "jn-dir/profiles.json",
        sha256: sha256(readFileSync(path.join(otherRun, "profiles.json"))),
      }),
    );
    await rejectsCode(load(sb, run, indexPath), "PATH_ESCAPE");

    // 坏路径：跨批 ../、posix 绝对、URL、反斜杠、空段、内嵌 .. → INVALID_ORIGINS
    for (const badPath of [
      "../run-recipes/current-profiles.json",
      "/abs/current-profiles.json",
      "file:///x/current-profiles.json",
      "sub\\current-profiles.json",
      "sub//current-profiles.json",
      "sub/../current-profiles.json",
    ]) {
      await writeJson(
        path.join(run, "assessment-origins.json"),
        originsWith({ path: badPath, sha256: "a".repeat(64) }),
      );
      await rejectsCode(load(sb, run, indexPath), "INVALID_ORIGINS");
    }

    // 坏 ref 形状：多键 / 缺 sha256 / 非法 sha256 格式 → INVALID_ORIGINS
    await register(content);
    for (const badRef of [
      { path: "current-profiles.json", sha256: sha256(Buffer.from(content, "utf8")), extra: 1 },
      { path: "current-profiles.json" },
      { path: "current-profiles.json", sha256: "NOT-A-DIGEST" },
    ]) {
      await writeJson(path.join(run, "assessment-origins.json"), originsWith(badRef));
      await rejectsCode(load(sb, run, indexPath), "INVALID_ORIGINS");
    }

    // currentProfiles: null → 显式"无来源"，载入通过且原样携带
    await writeJson(path.join(run, "assessment-origins.json"), originsWith(null));
    const nulled = await load(sb, run, indexPath);
    assert.equal(nulled.origins.origins[candidate.id].currentProfiles, null);

    // origins 条目本身的未知键仍拒绝（currentProfiles 不是自由扩展口）
    await writeJson(path.join(run, "assessment-origins.json"), originsWith(undefined, { extra: true }));
    await rejectsCode(load(sb, run, indexPath), "INVALID_ORIGINS");
  } finally {
    await sb.cleanup();
  }
});

test("selections.json：十套绑定核验；candidateSetHash/assessmentHash/choiceHash 错误全拒绝", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-selections");
    const candidates = SKIN_IDS.map((skinId) => makeCandidate({ skinId }));
    const candidateSet = makeCandidateSet(candidates);
    await writeCandidates(run, candidateSet);
    await writeIndex(run, {});
    const indexPath = path.join(run, "captures-index.json");
    const container = buildReviewContainer({
      candidateSetHash: candidateSet.candidateSetHash,
      assessments: [makeAssessment(candidates[0])],
    });
    await writeAssessments(run, container);

    const choices = Object.fromEntries(
      candidates.map((candidate) => [
        candidate.skinId,
        { candidateId: candidate.id, candidateHash: candidate.candidateHash },
      ]),
    );
    const record = {
      schemaVersion: 1,
      candidateSetHash: candidateSet.candidateSetHash,
      assessmentHash: container.assessmentHash,
      choices,
      decisionSource: "2026-10-06 用户消息摘录（测试样本）",
      recordedAt: "2026-10-06T00:00:00.000Z",
    };
    await writeJson(path.join(run, "selections.json"), record);
    const evidence = await load(sb, run, indexPath);
    assert.equal(evidence.selections.present, true);
    assert.deepEqual(evidence.selections.binding, { candidateSetHash: true, assessmentHash: true });
    assert.ok(Object.isFrozen(evidence.selections.record));
    assert.ok(evidence.gaps.some((gap) => gap.code === "assessment-missing"));

    await writeJson(path.join(run, "selections.json"), { ...record, assessmentHash: "a".repeat(64) });
    await rejectsCode(load(sb, run, indexPath), "HASH_MISMATCH");

    await writeJson(path.join(run, "selections.json"), { ...record, candidateSetHash: "a".repeat(64) });
    await rejectsCode(load(sb, run, indexPath), "HASH_MISMATCH");

    const wrongChoice = {
      ...record,
      choices: { ...choices, claude: { candidateId: choices.claude.candidateId, candidateHash: "d".repeat(64) } },
    };
    await writeJson(path.join(run, "selections.json"), wrongChoice);
    await rejectsCode(load(sb, run, indexPath), "HASH_MISMATCH");

    // 皮肤归属：choices 必须绑定对应皮肤的候选——id/hash 都正确的 chatgpt 候选
    // 填进 claude 的选择位也必须拒绝
    const wrongSkin = {
      ...record,
      choices: {
        ...choices,
        claude: { candidateId: choices.chatgpt.candidateId, candidateHash: choices.chatgpt.candidateHash },
      },
    };
    await writeJson(path.join(run, "selections.json"), wrongSkin);
    await rejectsCode(load(sb, run, indexPath), "INVALID_SELECTIONS");
  } finally {
    await sb.cleanup();
  }
});

test("selections 存在但无评审容器：assessmentHash 绑定记为无法核验并留 gap", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-selections-no-review");
    const candidates = SKIN_IDS.map((skinId) => makeCandidate({ skinId }));
    const candidateSet = makeCandidateSet(candidates);
    await writeCandidates(run, candidateSet);
    await writeIndex(run, {});
    const choices = Object.fromEntries(
      candidates.map((candidate) => [
        candidate.skinId,
        { candidateId: candidate.id, candidateHash: candidate.candidateHash },
      ]),
    );
    await writeJson(path.join(run, "selections.json"), {
      schemaVersion: 1,
      candidateSetHash: candidateSet.candidateSetHash,
      assessmentHash: "e".repeat(64),
      choices,
      decisionSource: "测试样本",
      recordedAt: "2026-10-06T00:00:00.000Z",
    });
    const evidence = await load(sb, run, path.join(run, "captures-index.json"));
    assert.equal(evidence.selections.present, true);
    assert.equal(evidence.review.present, false);
    assert.equal(evidence.selections.binding.assessmentHash, null);
    assert.ok(evidence.gaps.some((gap) => gap.code === "selections-assessment-hash-unverified"));
  } finally {
    await sb.cleanup();
  }
});

test("buildReviewContainer / hashReviewContainer：摘要规则固定，改动即变", () => {
  const candidate = makeCandidate({ skinId: "chatgpt" });
  const assessment = makeAssessment(candidate, { readiness: "ready" });
  const container = buildReviewContainer({ candidateSetHash: "a".repeat(64), assessments: [assessment] });
  assert.equal(container.schemaVersion, 1);
  assert.equal(
    container.assessmentHash,
    sha256Canonical({ schemaVersion: 1, candidateSetHash: "a".repeat(64), assessments: [assessment] }),
    "assessmentHash 必须等于容器去掉自身 hash 的 sha256Canonical",
  );
  assert.equal(
    hashReviewContainer({ ...JSON.parse(JSON.stringify(container)), assessmentHash: "x".repeat(64) }),
    container.assessmentHash,
  );

  const other = buildReviewContainer({
    candidateSetHash: "a".repeat(64),
    assessments: [{ ...assessment, readiness: "incomplete" }],
  });
  assert.notEqual(other.assessmentHash, container.assessmentHash);

  assert.throws(
    () =>
      buildReviewContainer({
        candidateSetHash: "a".repeat(64),
        assessments: [assessment, { ...assessment }],
      }),
    (error) => error instanceof ReviewEvidenceError && error.code === "DUPLICATE_BINDING",
  );
  assert.throws(
    () =>
      buildReviewContainer({
        candidateSetHash: "a".repeat(64),
        assessments: [{ ...assessment, readiness: "banana" }],
      }),
    (error) => error instanceof ReviewEvidenceError && error.code === "INVALID_ASSESSMENT",
  );
});

test("参数与路径形状错误明确拒绝；错误码集合冻结", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-input");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    await writeCandidates(run, makeCandidateSet([candidate]));
    await writeIndex(run, {});

    await rejectsCode(load(sb, run, undefined), "INVALID_INPUT");
    await rejectsCode(load(sb, run, ""), "INVALID_INPUT");
    await rejectsCode(load(sb, run, "   "), "INVALID_INPUT");
    await assert.rejects(
      loadReviewEvidence({ runDir: run, capturesIndexPath: path.join(run, "captures-index.json") }),
      (error) => {
        // 默认 rootDir 指向真实仓库：沙箱 run 的真实路径落在仓库校验根之外 → PATH_ESCAPE
        //（不污染真实 docs/validation）
        assert.ok(error instanceof ReviewEvidenceError, `期望 ReviewEvidenceError：${error?.message}`);
        assert.equal(error.code, "PATH_ESCAPE");
        return true;
      },
    );

    const filePath = path.join(run, "candidates.json");
    await rejectsCode(load(sb, filePath, path.join(run, "captures-index.json")), "INVALID_INPUT", "runDir 不能是文件");
    await rejectsCode(load(sb, run, run), "INVALID_INPUT", "capturesIndexPath 不能是目录");
    assert.ok(Object.isFrozen(REVIEW_EVIDENCE_CODES));
    for (const code of ["PATH_ESCAPE", "HASH_MISMATCH", "AMBIGUOUS_CAPTURE", "ORDER_MISMATCH"]) {
      assert.ok(REVIEW_EVIDENCE_CODES.includes(code));
    }
  } finally {
    await sb.cleanup();
  }
});

test("M4.2 kind capture 与 progress.json 同样可加载，出处记录 progress hash", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-m42");
    const candidate = makeCandidate({ skinId: "claude" });
    const candidateSet = makeCandidateSet([candidate]);
    await writeCandidates(run, candidateSet);
    await writeCaptureDir(run, "captures/cap-1", candidate, { kind: "skin-palette-capture", progress: true });
    await writeIndex(run, { [candidate.id]: "captures/cap-1" });

    const evidence = await load(sb, run, path.join(run, "captures-index.json"));
    const captureEvidence = evidence.captures[candidate.id];
    assert.equal(captureEvidence.capture.kind, "skin-palette-capture");
    assert.equal(captureEvidence.progress.kind, "skin-palette-capture-progress");
    assert.equal(
      evidence.origins.origins[candidate.id].hashes.progress,
      sha256(await readFile(path.join(captureEvidence.dir, "progress.json"))),
    );
  } finally {
    await sb.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 复核修复回归（2026-10-06 五项）
// ---------------------------------------------------------------------------

test("词法越界的既有路径也拒绝：校验根外的 junction 指回根内不得加载", async () => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-lex");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    await writeCandidates(run, makeCandidateSet([candidate]));
    await writeCaptureDir(run, "captures/cap-1", candidate);
    // junction 本体在校验根外（词法越界），目标指回根内的合法捕获目录
    const outsideLink = path.join(sb.sandbox, "outside-link");
    await symlink(path.join(run, "captures", "cap-1"), outsideLink, "junction");
    await writeIndex(run, { [candidate.id]: path.relative(run, outsideLink) });
    await rejectsCode(load(sb, run, path.join(run, "captures-index.json")), "PATH_ESCAPE");
  } finally {
    await sb.cleanup();
  }
});

test("固定 JSON 文件不允许符号链接：越界符号链接的候选集拒绝读取", async (t) => {
  const sb = await createSandbox();
  try {
    const run = await sb.makeRun("run-symlink");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    const candidateSet = makeCandidateSet([candidate]);
    await writeCandidates(run, candidateSet);
    await writeCaptureDir(run, "captures/cap-1", candidate);
    await writeIndex(run, { [candidate.id]: "captures/cap-1" });
    const outsideCopy = path.join(sb.sandbox, "outside-candidates.json");
    await writeFile(outsideCopy, canonicalFileContent(candidateSet));
    await rm(path.join(run, "candidates.json"), { force: true });
    try {
      await symlink(outsideCopy, path.join(run, "candidates.json"), "file");
    } catch (error) {
      t.skip(`当前环境无法创建文件符号链接（${error?.code ?? error}），该分支由实现审查覆盖`);
      return;
    }
    await rejectsCode(load(sb, run, path.join(run, "captures-index.json")), "PATH_ESCAPE");
  } finally {
    await sb.cleanup();
  }
});

test("出处必需摘要不允许 null：candidates/capture 摘要缺失或原文件缺失都拒绝", async () => {
  const sb = await createSandbox();
  try {
    const batchRun = await sb.makeRun("run-batch-req");
    const aggRun = await sb.makeRun("run-agg-req");
    const candidate = makeCandidate({ skinId: "chatgpt" });
    await writeCandidates(batchRun, makeCandidateSet([candidate], { derivation: "b".repeat(64) }));
    await writeCandidates(aggRun, makeCandidateSet([candidate], { derivation: "c".repeat(64) }));
    await writeCaptureDir(batchRun, "captures/cap-1", candidate);
    await writeIndex(aggRun, { [candidate.id]: "../run-batch-req/captures/cap-1" });
    const indexPath = path.join(aggRun, "captures-index.json");

    const writeOrigins = (hashesOverrides = {}) =>
      writeJson(path.join(aggRun, "assessment-origins.json"), {
        schemaVersion: 1,
        origins: {
          [candidate.id]: {
            batchRun: "../run-batch-req",
            capture: "../run-batch-req/captures/cap-1",
            visualReview: null,
            hashes: {
              candidates: sha256(readFileSync(path.join(batchRun, "candidates.json"))),
              capture: sha256(readFileSync(path.join(batchRun, "captures", "cap-1", "capture.json"))),
              progress: null,
              visualReview: null,
              ...hashesOverrides,
            },
          },
        },
      });

    await writeOrigins({ candidates: null });
    await rejectsCode(load(sb, aggRun, indexPath), "INVALID_ORIGINS");

    await writeOrigins({ capture: null });
    await rejectsCode(load(sb, aggRun, indexPath), "INVALID_ORIGINS");

    // 摘要格式合法但原批次 candidates.json 被删除：致命缺文件，不得静默通过
    await writeOrigins();
    await rm(path.join(batchRun, "candidates.json"));
    await rejectsCode(load(sb, aggRun, indexPath), "MISSING_FILE");
  } finally {
    await sb.cleanup();
  }
});

test('跨批捕获无出处文件时保留缺项：不生成 batchRun="." 的错误内部出处', async () => {
  const sb = await createSandbox();
  try {
    const batchRun = await sb.makeRun("run-batch-x");
    const aggRun = await sb.makeRun("run-agg-x");
    const chatgpt = makeCandidate({ skinId: "chatgpt" });
    const claude = makeCandidate({ skinId: "claude" });
    await writeCandidates(batchRun, makeCandidateSet([chatgpt], { derivation: "b".repeat(64) }));
    await writeCandidates(aggRun, makeCandidateSet([chatgpt, claude], { derivation: "c".repeat(64) }));
    await writeCaptureDir(batchRun, "captures/cap-1", chatgpt);
    await writeCaptureDir(aggRun, "captures/claude-in-agg", claude);
    await writeIndex(aggRun, {
      [chatgpt.id]: "../run-batch-x/captures/cap-1",
      [claude.id]: "captures/claude-in-agg",
    });

    const evidence = await load(sb, aggRun, path.join(aggRun, "captures-index.json"));
    assert.equal(evidence.origins.source, "internal");
    // 跨批候选没有出处登记，也没有被伪造 batchRun="."
    assert.equal(evidence.origins.origins[chatgpt.id], undefined);
    assert.deepEqual(evidence.origins.missingCandidateIds, [chatgpt.id]);
    const originGap = evidence.gaps.find((gap) => gap.code === "origin-missing" && gap.candidateId === chatgpt.id);
    assert.ok(originGap, "跨批候选必须有 origin-missing 缺项");
    assert.match(originGap.detail, /跨批引用必须由明确出处登记/);
    // 本 run 之内的捕获仍然得到内部出处，候选摘要取本 run 的 candidates.json
    const inRunOrigin = evidence.origins.origins[claude.id];
    assert.equal(inRunOrigin.batchRun, ".");
    assert.equal(inRunOrigin.hashes.candidates, sha256(await readFile(path.join(aggRun, "candidates.json"))));
  } finally {
    await sb.cleanup();
  }
});

test("仓库相对路径以 realpath(rootDir) 为基点解析：docs/validation/… 形式可用", async () => {
  const sb = await createSandbox();
  try {
    const runName = "run-relative";
    const run = await sb.makeRun(runName);
    const candidate = makeCandidate({ skinId: "chatgpt" });
    await writeCandidates(run, makeCandidateSet([candidate]));
    await writeCaptureDir(run, "captures/cap-1", candidate);
    await writeIndex(run, { [candidate.id]: "captures/cap-1" });

    // 修复回归：基点曾被错算到 <root>/docs，导致合法相对路径被拒
    const evidence = await load(
      sb,
      path.join("docs", "validation", runName),
      path.join("docs", "validation", runName, "captures-index.json"),
    );
    assert.equal(evidence.run.id, runName);
    assert.equal(evidence.run.relativePath, runName);
    assert.equal(evidence.run.index.relativePath, "captures-index.json");
    assert.ok(evidence.captures[candidate.id]);
  } finally {
    await sb.cleanup();
  }
});
