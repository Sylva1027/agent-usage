import { isDeepStrictEqual } from "node:util";
import { SOURCE_FILES } from "./capture.mjs";
import { validateCandidateSet } from "./contracts.mjs";
import { resolveProductionSelection } from "./review-production.mjs";
import { verifyReviewEvidence } from "./review-verify.mjs";

const SHA256_RE = /^[a-f0-9]{64}$/;
const SOURCE_FILE_SET = new Set(SOURCE_FILES);

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readDataFields(value, label) {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain or null-prototype object`);
  const fields = new Map();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new TypeError(`${label} must not contain symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label}.${key} must be an own data property`);
    }
    fields.set(key, descriptor.value);
  }
  return fields;
}

function validateBeforeSourceHashes(value) {
  const fields = readDataFields(value, "beforeSourceHashes");
  if (
    fields.size !== SOURCE_FILES.length ||
    [...fields.keys()].some((key) => !SOURCE_FILE_SET.has(key)) ||
    SOURCE_FILES.some((file) => !fields.has(file))
  ) {
    throw new TypeError("beforeSourceHashes must contain exactly the registered source files");
  }
  const hashes = new Map();
  for (const file of SOURCE_FILES) {
    const digest = fields.get(file);
    if (typeof digest !== "string" || !SHA256_RE.test(digest)) {
      throw new TypeError(`beforeSourceHashes.${file} must be a lowercase 64-character SHA-256`);
    }
    hashes.set(file, digest);
  }
  return hashes;
}

function diagnostic(code, candidateId, path, detail) {
  return { code, candidateId, path, detail };
}

function safeRelativePath(recordFields) {
  const relativePath = recordFields.get("relativePath");
  return typeof relativePath === "string" ? relativePath : null;
}

/** Compare every loader-shaped original candidate capture against one supplied pre-transition hash set. */
export function verifyProductionSourceOrigins({ evidence, beforeSourceHashes } = {}) {
  const before = validateBeforeSourceHashes(beforeSourceHashes);
  const evidenceFields = readDataFields(evidence, "evidence");
  const candidateSetWrapperFields = readDataFields(evidenceFields.get("candidateSet"), "evidence.candidateSet");
  const candidateSet = candidateSetWrapperFields.get("data");
  if (!isPlainRecord(candidateSet)) throw new TypeError("evidence.candidateSet.data must be a CandidateSet object");
  const candidateSetResult = validateCandidateSet(candidateSet, { expectedSkinIds: [] });
  if (!candidateSetResult.valid) {
    const first = candidateSetResult.errors[0];
    throw new TypeError(
      `evidence.candidateSet.data failed M0 CandidateSet validation: ${first?.path ?? "$"} ${first?.message ?? "invalid"}`,
    );
  }
  const candidates = candidateSet.candidates;
  const capturesFields = readDataFields(evidenceFields.get("captures"), "evidence.captures");
  const errors = [];
  const gaps = [];
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));

  for (const candidate of candidates) {
    const candidateId = candidate.id;
    if (!capturesFields.has(candidateId)) {
      gaps.push(
        diagnostic(
          "origin-capture-missing",
          candidateId,
          null,
          "loadReviewEvidence has no capture record for this original candidate",
        ),
      );
      continue;
    }

    const recordFields = readDataFields(capturesFields.get(candidateId), `evidence.captures[${candidateId}]`);
    const captureFields = readDataFields(recordFields.get("capture"), `evidence.captures[${candidateId}].capture`);
    const captureCandidateFields = readDataFields(
      captureFields.get("candidate"),
      `evidence.captures[${candidateId}].capture.candidate`,
    );
    if (
      recordFields.get("candidateId") !== candidateId ||
      recordFields.get("skinId") !== candidate.skinId ||
      captureCandidateFields.get("id") !== candidateId ||
      captureCandidateFields.get("candidateHash") !== candidate.candidateHash ||
      captureCandidateFields.get("skinId") !== candidate.skinId ||
      captureCandidateFields.get("production") === true
    ) {
      errors.push(
        diagnostic(
          "origin-capture-identity-mismatch",
          candidateId,
          null,
          "capture record and capture.json candidate identity must match the CandidateSet entry and must not be production evidence",
        ),
      );
    }

    if (!captureFields.has("sourceHashes") || captureFields.get("sourceHashes") === null) {
      gaps.push(diagnostic("origin-source-hashes-missing", candidateId, null, "capture.json has no sourceHashes map"));
      continue;
    }

    const sourceHashFields = readDataFields(
      captureFields.get("sourceHashes"),
      `evidence.captures[${candidateId}].capture.sourceHashes`,
    );
    for (const file of SOURCE_FILES) {
      if (!sourceHashFields.has(file) || sourceHashFields.get(file) === null) {
        gaps.push(
          diagnostic("origin-source-hash-missing", candidateId, file, `capture.json sourceHashes is missing ${file}`),
        );
        continue;
      }
      const digest = sourceHashFields.get(file);
      if (typeof digest !== "string" || !SHA256_RE.test(digest)) {
        errors.push(
          diagnostic(
            "origin-source-hash-invalid",
            candidateId,
            file,
            `capture.json sourceHashes.${file} must be a lowercase 64-character SHA-256`,
          ),
        );
      } else if (digest !== before.get(file)) {
        errors.push(
          diagnostic(
            "origin-source-hash-mismatch",
            candidateId,
            file,
            `original capture source hash differs from beforeSourceHashes: ${file}`,
          ),
        );
      }
    }

    const unknownFiles = [...sourceHashFields.keys()].filter((file) => !SOURCE_FILE_SET.has(file)).sort();
    for (const file of unknownFiles) {
      errors.push(
        diagnostic(
          "unknown-origin-source-file",
          candidateId,
          file,
          `capture.json sourceHashes contains an unregistered path: ${file}`,
        ),
      );
    }
  }

  const unknownCandidateIds = [...capturesFields.keys()].filter((candidateId) => !candidateIds.has(candidateId)).sort();
  for (const candidateId of unknownCandidateIds) {
    const recordFields = readDataFields(capturesFields.get(candidateId), `evidence.captures[${candidateId}]`);
    const captureFields = readDataFields(recordFields.get("capture"), `evidence.captures[${candidateId}].capture`);
    readDataFields(captureFields.get("candidate"), `evidence.captures[${candidateId}].capture.candidate`);
    errors.push(
      diagnostic(
        "unknown-origin-capture",
        candidateId,
        safeRelativePath(recordFields),
        "captures contains an entry whose candidateId is not present in CandidateSet",
      ),
    );
  }

  return { status: errors.length > 0 ? "rejected" : gaps.length > 0 ? "incomplete" : "pass", errors, gaps };
}

/** Keep pre-transition source matching and historical review verification as separate results. */
export async function verifyProductionHistoricalEvidence({ evidence, beforeSourceHashes, sourceSnapshot } = {}) {
  const originResult = verifyProductionSourceOrigins({ evidence, beforeSourceHashes });
  const historicalPending = verifyReviewEvidence({
    evidence,
    sourceSnapshot: sourceSnapshot === undefined ? null : sourceSnapshot,
    requireSelections: false,
    production: false,
  });
  const historicalResult = await historicalPending;
  const recordedHash = evidence?.review?.present === true ? (evidence.review.container?.assessmentHash ?? null) : null;
  const reconstructedHash = historicalResult.verifiedModel?.container?.assessmentHash ?? null;
  const hasRecordedHash = typeof recordedHash === "string" && SHA256_RE.test(recordedHash);
  const hasReconstructedHash = typeof reconstructedHash === "string" && SHA256_RE.test(reconstructedHash);
  const assessmentBinding = {
    status:
      !hasRecordedHash || !hasReconstructedHash
        ? "incomplete"
        : recordedHash === reconstructedHash
          ? "pass"
          : "rejected",
    recordedHash,
    reconstructedHash,
  };

  return { originResult, historicalResult, assessmentBinding };
}

/** Bind one real loader selection to D5b's historical result without upgrading its status. */
export function resolveProductionHistoricalSelection(options = {}) {
  const optionFields = readDataFields(options, "options");
  const optionNames = ["evidence", "historicalEvidence", "candidateId"];
  if (optionFields.size !== optionNames.length || optionNames.some((key) => !optionFields.has(key))) {
    throw new TypeError("options must contain exactly evidence, historicalEvidence, and candidateId");
  }
  const evidence = optionFields.get("evidence");
  const historicalEvidence = optionFields.get("historicalEvidence");
  const candidateId = optionFields.get("candidateId");

  const historicalFields = readDataFields(historicalEvidence, "historicalEvidence");
  const historicalSections = ["originResult", "historicalResult", "assessmentBinding"];
  if (
    historicalFields.size !== historicalSections.length ||
    historicalSections.some((key) => !historicalFields.has(key))
  ) {
    throw new TypeError("historicalEvidence must contain exactly the three D5b results");
  }

  const originFields = readDataFields(historicalFields.get("originResult"), "historicalEvidence.originResult");
  if (
    originFields.size !== 3 ||
    !["status", "errors", "gaps"].every((key) => originFields.has(key)) ||
    originFields.get("status") !== "pass" ||
    !Array.isArray(originFields.get("errors")) ||
    originFields.get("errors").length !== 0 ||
    !Array.isArray(originFields.get("gaps")) ||
    originFields.get("gaps").length !== 0
  ) {
    throw new TypeError("historicalEvidence.originResult must be a clean pass");
  }

  const bindingFields = readDataFields(
    historicalFields.get("assessmentBinding"),
    "historicalEvidence.assessmentBinding",
  );
  if (
    bindingFields.size !== 3 ||
    !["status", "recordedHash", "reconstructedHash"].every((key) => bindingFields.has(key)) ||
    bindingFields.get("status") !== "pass"
  ) {
    throw new TypeError("historicalEvidence.assessmentBinding must be a pass with both hashes");
  }

  const historicalResultFields = readDataFields(
    historicalFields.get("historicalResult"),
    "historicalEvidence.historicalResult",
  );
  const historicalStatus = historicalResultFields.get("status");
  if (
    historicalResultFields.get("sourceContext") !== "historical" ||
    !["pass", "incomplete", "rejected"].includes(historicalStatus) ||
    !Array.isArray(historicalResultFields.get("errors")) ||
    historicalResultFields.get("errors").length !== 0 ||
    !Array.isArray(historicalResultFields.get("gaps"))
  ) {
    throw new TypeError("historicalEvidence.historicalResult must be a valid, error-free historical result");
  }

  const verifiedModel = historicalResultFields.get("verifiedModel");
  const modelFields = readDataFields(verifiedModel, "historicalEvidence.historicalResult.verifiedModel");
  if (modelFields.get("production") !== false) {
    throw new TypeError("historicalEvidence.historicalResult.verifiedModel must be historical, not production");
  }
  const modelContainerFields = readDataFields(
    modelFields.get("container"),
    "historicalEvidence.historicalResult.verifiedModel.container",
  );
  const modelCandidateSet = modelFields.get("candidateSet");

  const evidenceFields = readDataFields(evidence, "evidence");
  const reviewFields = readDataFields(evidenceFields.get("review"), "evidence.review");
  if (reviewFields.get("present") !== true) throw new TypeError("evidence.review must be present");
  const recordedContainerFields = readDataFields(reviewFields.get("container"), "evidence.review.container");

  const candidateSetFields = readDataFields(evidenceFields.get("candidateSet"), "evidence.candidateSet");
  const recordedCandidateSet = candidateSetFields.get("data");
  if (!isPlainRecord(recordedCandidateSet) || !isDeepStrictEqual(modelCandidateSet, recordedCandidateSet)) {
    throw new TypeError("historical verifiedModel.candidateSet must deeply equal evidence.candidateSet.data");
  }

  const selectionFields = readDataFields(evidenceFields.get("selections"), "evidence.selections");
  if (selectionFields.get("present") !== true) throw new TypeError("evidence.selections must be present");
  const selections = selectionFields.get("record");

  const boundHashes = [
    recordedContainerFields.get("assessmentHash"),
    modelContainerFields.get("assessmentHash"),
    bindingFields.get("recordedHash"),
    bindingFields.get("reconstructedHash"),
  ];
  if (boundHashes.some((hash) => typeof hash !== "string" || !SHA256_RE.test(hash))) {
    throw new TypeError("the original, reconstructed, and D5b-bound assessment hashes must be lowercase SHA-256");
  }
  if (boundHashes.some((hash) => hash !== boundHashes[0])) {
    throw new TypeError("the original, reconstructed, and D5b-bound assessment hashes must all match");
  }

  return resolveProductionSelection({ verifiedModel, selections, candidateId });
}
