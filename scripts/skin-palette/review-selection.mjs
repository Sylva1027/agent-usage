import { hashCandidateSet, sha256Canonical, SKIN_IDS, validateSelections } from "./contracts.mjs";

function createSelectionExportCore({ verifiedModel, choices, decisionSource, recordedAt, skinIds }) {
  const fail = (message) => {
    throw new TypeError(`Invalid selection: ${message}`);
  };
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const isHash = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
  const hasOwn = (value, key) => Object.hasOwn(value, key);

  if (
    !isObject(verifiedModel) ||
    verifiedModel.schemaVersion !== 1 ||
    verifiedModel.kind !== "skin-palette-review-verified-model"
  ) {
    fail("verifiedModel kind/schemaVersion mismatch");
  }
  const { candidateSet, container, selectableCandidateIds, gaps, images } = verifiedModel;
  if (
    !isObject(candidateSet) ||
    candidateSet.schemaVersion !== 1 ||
    !isHash(candidateSet.candidateSetHash) ||
    !Array.isArray(candidateSet.candidates)
  ) {
    fail("candidateSet shape or total hash is invalid");
  }
  if (
    !isObject(container) ||
    container.schemaVersion !== 1 ||
    container.candidateSetHash !== candidateSet.candidateSetHash ||
    !isHash(container.assessmentHash) ||
    !Array.isArray(container.assessments)
  ) {
    fail("container is invalid or not bound to candidateSet");
  }
  if (
    !Array.isArray(selectableCandidateIds) ||
    !Array.isArray(gaps) ||
    !isObject(images) ||
    !Array.isArray(images.baseline) ||
    !Array.isArray(images.units)
  ) {
    fail("verifiedModel selection data is invalid");
  }
  if (!isObject(choices)) fail("choices must be an object keyed by skinId");
  if (Object.getOwnPropertySymbols(choices).length) fail("choices cannot contain symbol keys");
  if (typeof decisionSource !== "string" || !decisionSource) fail("decisionSource is required");
  if (typeof recordedAt !== "string" || Number.isNaN(Date.parse(recordedAt)))
    fail("recordedAt must be a valid timestamp");

  const suppliedSkinIds = Object.keys(choices);
  for (const skinId of suppliedSkinIds) {
    if (!skinIds.includes(skinId)) fail(`unknown skinId ${skinId}`);
  }

  const normalizedChoices = {};
  for (const skinId of skinIds) {
    if (!hasOwn(choices, skinId)) continue;
    const choice = choices[skinId];
    if (!isObject(choice) || Object.getOwnPropertySymbols(choice).length)
      fail(`choice for ${skinId} must be an object`);
    if (Object.keys(choice).some((key) => key !== "candidateId" && key !== "candidateHash")) {
      fail(`choice for ${skinId} has unknown fields`);
    }
    if (typeof choice.candidateId !== "string" || !choice.candidateId) fail(`candidateId for ${skinId} is required`);
    if (!/^[a-z0-9]+-(a|b|c)-[0-9a-f]{12}$/.test(choice.candidateId))
      fail(`candidateId for ${skinId} has an invalid format`);
    if (!isHash(choice.candidateHash)) fail(`candidateHash for ${skinId} is invalid`);

    const candidates = candidateSet.candidates.filter((candidate) => candidate?.id === choice.candidateId);
    if (candidates.length !== 1) fail(`candidateId ${choice.candidateId} is missing or ambiguous`);
    const candidate = candidates[0];
    if (candidate.skinId !== skinId) fail(`candidateId ${choice.candidateId} belongs to another skin`);
    if (candidate.candidateHash !== choice.candidateHash) fail(`candidateHash mismatch for ${choice.candidateId}`);
    if (!selectableCandidateIds.includes(choice.candidateId)) fail(`candidate ${choice.candidateId} is not selectable`);

    const assessments = container.assessments.filter((assessment) => assessment?.candidateId === choice.candidateId);
    if (
      assessments.length !== 1 ||
      assessments[0].candidateHash !== candidate.candidateHash ||
      assessments[0].readiness !== "ready"
    ) {
      fail(`candidate ${choice.candidateId} is not ready in the verified container`);
    }

    const modeEvidence = [...images.baseline, ...images.units];
    if (
      !["light", "dark"].every((mode) =>
        modeEvidence.some((item) => item?.candidateId === choice.candidateId && item.mode === mode),
      )
    ) {
      fail(`candidate ${choice.candidateId} does not have verified light and dark evidence`);
    }
    if (gaps.some((gap) => gap?.candidateId === choice.candidateId && gap.blocking !== false)) {
      fail(`candidate ${choice.candidateId} has a blocking gap`);
    }
    normalizedChoices[skinId] = { candidateId: choice.candidateId, candidateHash: choice.candidateHash };
  }

  const missingSkinIds = skinIds.filter((skinId) => !hasOwn(normalizedChoices, skinId));
  if (missingSkinIds.length) {
    return {
      fileName: "selection-draft.json",
      record: {
        schemaVersion: 1,
        kind: "skin-palette-selection-draft",
        candidateSetHash: candidateSet.candidateSetHash,
        assessmentHash: container.assessmentHash,
        choices: normalizedChoices,
        decisionSource,
        recordedAt,
        missingSkinIds,
      },
    };
  }

  const record = {
    schemaVersion: 1,
    candidateSetHash: candidateSet.candidateSetHash,
    assessmentHash: container.assessmentHash,
    choices: normalizedChoices,
    decisionSource,
    recordedAt,
  };
  return { fileName: "selections.json", record };
}

function scriptJson(value) {
  return JSON.stringify(JSON.stringify(value))
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function verifySummaryBindings(verifiedModel) {
  const candidateSet = verifiedModel?.candidateSet;
  const container = verifiedModel?.container;
  if (!candidateSet || !container || !Array.isArray(container.assessments)) {
    throw new TypeError("Invalid verifiedModel summary inputs");
  }

  const candidateSetHash = hashCandidateSet(candidateSet);
  if (candidateSet.candidateSetHash !== candidateSetHash || container.candidateSetHash !== candidateSetHash) {
    throw new TypeError("candidateSetHash does not bind the verified candidate set and container");
  }
  const assessmentHash = sha256Canonical({
    schemaVersion: container.schemaVersion,
    candidateSetHash: container.candidateSetHash,
    assessments: container.assessments,
  });
  if (container.assessmentHash !== assessmentHash) {
    throw new TypeError("assessmentHash does not bind the verified container assessments");
  }
}

export function createSelectionExport({ verifiedModel, choices, decisionSource, recordedAt }) {
  verifySummaryBindings(verifiedModel);
  const result = createSelectionExportCore({ verifiedModel, choices, decisionSource, recordedAt, skinIds: SKIN_IDS });
  if (result.fileName === "selections.json") {
    const validation = validateSelections(result.record);
    if (!validation.valid)
      throw new TypeError(`Invalid selection record: ${validation.errors.map((item) => item.message).join("; ")}`);
  }
  return result;
}

export function buildSelectionScript(verifiedModel) {
  verifySummaryBindings(verifiedModel);
  createSelectionExportCore({
    verifiedModel,
    choices: {},
    decisionSource: "script validation",
    recordedAt: "2000-01-01T00:00:00.000Z",
    skinIds: SKIN_IDS,
  });
  const modelForScript = {
    schemaVersion: verifiedModel?.schemaVersion,
    kind: verifiedModel?.kind,
    candidateSet: {
      schemaVersion: verifiedModel?.candidateSet?.schemaVersion,
      candidateSetHash: verifiedModel?.candidateSet?.candidateSetHash,
      candidates: verifiedModel?.candidateSet?.candidates?.map((candidate) => ({
        id: candidate?.id,
        skinId: candidate?.skinId,
        candidateHash: candidate?.candidateHash,
      })),
    },
    container: {
      schemaVersion: verifiedModel?.container?.schemaVersion,
      candidateSetHash: verifiedModel?.container?.candidateSetHash,
      assessmentHash: verifiedModel?.container?.assessmentHash,
      assessments: verifiedModel?.container?.assessments?.map((assessment) => ({
        candidateId: assessment?.candidateId,
        candidateHash: assessment?.candidateHash,
        readiness: assessment?.readiness,
      })),
    },
    images: {
      baseline: verifiedModel?.images?.baseline?.map((image) => ({
        candidateId: image?.candidateId,
        mode: image?.mode,
      })),
      units: verifiedModel?.images?.units?.map((image) => ({ candidateId: image?.candidateId, mode: image?.mode })),
    },
    selectableCandidateIds: verifiedModel?.selectableCandidateIds,
    gaps: verifiedModel?.gaps?.map((gap) => ({ candidateId: gap?.candidateId, blocking: gap?.blocking })),
  };
  const coreSource = createSelectionExportCore.toString();
  return `(() => {
  "use strict";
  const verifiedModel = JSON.parse(${scriptJson(modelForScript)});
  const skinIds = JSON.parse(${scriptJson(SKIN_IDS)});
  const createSelectionExportCore = ${coreSource};
  const radios = Array.from(document.querySelectorAll('input[type="radio"][data-selection-skin][data-selection-candidate]'));
  const button = document.querySelector('button[data-selection-export]');
  const message = document.querySelector('[data-selection-message]');
  if (!button || !message) return;

  for (const input of radios) {
    input.checked = false;
    const skinId = input.dataset.selectionSkin;
    const candidateId = input.dataset.selectionCandidate;
    const candidate = verifiedModel.candidateSet?.candidates?.find((item) => item?.id === candidateId);
    input.disabled = input.name !== \`skin-choice-\${skinId}\` || !candidate;
    if (input.disabled) continue;
    try {
      createSelectionExportCore({
        verifiedModel,
        choices: { [skinId]: { candidateId, candidateHash: candidate.candidateHash } },
        decisionSource: "本地报告交互，待 M5.7 确认",
        recordedAt: new Date().toISOString(),
        skinIds,
      });
    } catch {
      input.disabled = true;
    }
  }

  button.addEventListener("click", (event) => {
    event.preventDefault();
    try {
      const choices = {};
      for (const input of radios) {
        if (!input.checked) continue;
        const skinId = input.dataset.selectionSkin;
        if (Object.prototype.hasOwnProperty.call(choices, skinId)) throw new TypeError(\`More than one choice for \${skinId}\`);
        const candidate = verifiedModel.candidateSet.candidates.find((item) => item?.id === input.dataset.selectionCandidate);
        choices[skinId] = { candidateId: input.dataset.selectionCandidate, candidateHash: candidate?.candidateHash };
      }
      const result = createSelectionExportCore({
        verifiedModel,
        choices,
        decisionSource: "本地报告交互，待 M5.7 确认",
        recordedAt: new Date().toISOString(),
        skinIds,
      });
      const blob = new Blob([JSON.stringify(result.record, null, 2) + "\\n"], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      message.textContent = result.fileName === "selections.json" ? "已导出完整选择记录。" : \`已导出草稿，仍缺 \${result.record.missingSkinIds.length} 套皮肤。\`;
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
    }
  });
})();`;
}
