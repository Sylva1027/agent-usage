import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { hashCandidateSet, sha256Canonical, SKIN_IDS, validateSelections } from "../scripts/skin-palette/contracts.mjs";
import { buildSelectionScript, createSelectionExport } from "../scripts/skin-palette/review-selection.mjs";

const source = "本地报告交互，待 M5.7 确认";
const recordedAt = "2026-10-07T08:30:00.000Z";

function createCandidate(skinId, index) {
  const suffix = String(index).padStart(12, "0");
  return {
    id: `${skinId}-a-${suffix}`,
    skinId,
    candidateHash: String(index).padStart(64, "0"),
    profileSnapshot: { modes: { light: { surface: "#FFFFFF" }, dark: { surface: "#000000" } } },
  };
}

function createModel() {
  const candidates = SKIN_IDS.map((skinId, index) => createCandidate(skinId, index + 1));
  const candidateSet = { schemaVersion: 1, candidates };
  candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
  const assessments = candidates.map(({ id: candidateId, candidateHash }) => ({
    candidateId,
    candidateHash,
    readiness: "ready",
  }));
  const container = { schemaVersion: 1, candidateSetHash: candidateSet.candidateSetHash, assessments };
  container.assessmentHash = sha256Canonical({
    schemaVersion: container.schemaVersion,
    candidateSetHash: container.candidateSetHash,
    assessments: container.assessments,
  });
  return {
    schemaVersion: 1,
    kind: "skin-palette-review-verified-model",
    candidateSet,
    container,
    selectableCandidateIds: candidates.map(({ id }) => id),
    gaps: [],
    images: {
      baseline: [],
      units: candidates.flatMap(({ id: candidateId }) => [
        { candidateId, mode: "light" },
        { candidateId, mode: "dark" },
      ]),
    },
  };
}

function refreshSummaryHashes(model) {
  model.candidateSet.candidateSetHash = hashCandidateSet(model.candidateSet);
  model.container.candidateSetHash = model.candidateSet.candidateSetHash;
  model.container.assessmentHash = sha256Canonical({
    schemaVersion: model.container.schemaVersion,
    candidateSetHash: model.container.candidateSetHash,
    assessments: model.container.assessments,
  });
}

function choicesFor(model, skinIds = SKIN_IDS) {
  return Object.fromEntries(
    skinIds.map((skinId) => {
      const candidate = model.candidateSet.candidates.find((item) => item.skinId === skinId);
      return [skinId, { candidateId: candidate.id, candidateHash: candidate.candidateHash }];
    }),
  );
}

test("partial selections remain drafts and list every missing skin", () => {
  const model = createModel();
  const result = createSelectionExport({
    verifiedModel: model,
    choices: choicesFor(model, SKIN_IDS.slice(0, 2)),
    decisionSource: source,
    recordedAt,
  });

  assert.equal(result.fileName, "selection-draft.json");
  assert.equal(result.record.kind, "skin-palette-selection-draft");
  assert.deepEqual(result.record.missingSkinIds, SKIN_IDS.slice(2));
  assert.equal(result.record.candidateSetHash, model.candidateSet.candidateSetHash);
  assert.equal(result.record.assessmentHash, model.container.assessmentHash);
  assert.equal(Object.hasOwn(result.record, "status"), false);
});

test("complete ten-skin selection produces the exact M0 record and passes its validator", () => {
  const model = createModel();
  const result = createSelectionExport({
    verifiedModel: model,
    choices: choicesFor(model),
    decisionSource: source,
    recordedAt,
  });

  assert.equal(result.fileName, "selections.json");
  assert.deepEqual(Object.keys(result.record), [
    "schemaVersion",
    "candidateSetHash",
    "assessmentHash",
    "choices",
    "decisionSource",
    "recordedAt",
  ]);
  assert.deepEqual(validateSelections(result.record), { valid: true, errors: [] });
  assert.equal(result.record.candidateSetHash, model.candidateSet.candidateSetHash);
  assert.equal(result.record.assessmentHash, model.container.assessmentHash);
});

test("rejects unknown, cross-skin, forged, unselectable, unready, incomplete, and blocked candidates", () => {
  const model = createModel();
  const firstSkin = SKIN_IDS[0];
  const firstChoice = choicesFor(model, [firstSkin]);
  const candidate = model.candidateSet.candidates[0];
  const otherCandidate = model.candidateSet.candidates[1];

  assert.throws(() =>
    createSelectionExport({
      verifiedModel: model,
      choices: { unknown: firstChoice[firstSkin] },
      decisionSource: source,
      recordedAt,
    }),
  );
  assert.throws(() =>
    createSelectionExport({
      verifiedModel: model,
      choices: { [firstSkin]: { candidateId: otherCandidate.id, candidateHash: otherCandidate.candidateHash } },
      decisionSource: source,
      recordedAt,
    }),
  );
  assert.throws(() =>
    createSelectionExport({
      verifiedModel: model,
      choices: { [firstSkin]: { ...firstChoice[firstSkin], candidateHash: "c".repeat(64) } },
      decisionSource: source,
      recordedAt,
    }),
  );

  model.selectableCandidateIds = model.selectableCandidateIds.filter((id) => id !== candidate.id);
  assert.throws(() =>
    createSelectionExport({ verifiedModel: model, choices: firstChoice, decisionSource: source, recordedAt }),
  );

  model.selectableCandidateIds.push(candidate.id);
  model.container.assessments[0].readiness = "rejected";
  refreshSummaryHashes(model);
  assert.throws(() =>
    createSelectionExport({ verifiedModel: model, choices: firstChoice, decisionSource: source, recordedAt }),
  );
  model.container.assessments[0].readiness = "incomplete";
  refreshSummaryHashes(model);
  assert.throws(() =>
    createSelectionExport({ verifiedModel: model, choices: firstChoice, decisionSource: source, recordedAt }),
  );

  model.container.assessments[0].readiness = "ready";
  model.container.assessments[0].candidateHash = "d".repeat(64);
  refreshSummaryHashes(model);
  assert.throws(() =>
    createSelectionExport({ verifiedModel: model, choices: firstChoice, decisionSource: source, recordedAt }),
  );
  model.container.assessments[0].candidateHash = candidate.candidateHash;
  refreshSummaryHashes(model);
  model.images.units = model.images.units.filter((item) => item.candidateId !== candidate.id || item.mode !== "dark");
  assert.throws(() =>
    createSelectionExport({ verifiedModel: model, choices: firstChoice, decisionSource: source, recordedAt }),
  );

  model.images.units.push({ candidateId: candidate.id, mode: "dark" });
  model.gaps.push({ candidateId: candidate.id, blocking: true });
  assert.throws(() =>
    createSelectionExport({ verifiedModel: model, choices: firstChoice, decisionSource: source, recordedAt }),
  );
});

test("rejects split-mode choices and broken candidate-set/container summary binding", () => {
  const model = createModel();
  const skinId = SKIN_IDS[0];
  const [choice] = Object.values(choicesFor(model, [skinId]));
  assert.throws(() =>
    createSelectionExport({
      verifiedModel: model,
      choices: { [`${skinId}-light`]: choice, [`${skinId}-dark`]: choice },
      decisionSource: source,
      recordedAt,
    }),
  );

  model.container.candidateSetHash = "c".repeat(64);
  assert.throws(() =>
    createSelectionExport({
      verifiedModel: model,
      choices: choicesFor(model, [skinId]),
      decisionSource: source,
      recordedAt,
    }),
  );
});

test("rejects candidate or readiness edits that keep the old summary hashes", () => {
  const candidateModel = createModel();
  candidateModel.candidateSet.candidates[0].displayName = "tampered candidate data";
  assert.throws(
    () =>
      createSelectionExport({
        verifiedModel: candidateModel,
        choices: choicesFor(candidateModel, [SKIN_IDS[0]]),
        decisionSource: source,
        recordedAt,
      }),
    /candidateSetHash/,
  );
  assert.throws(() => buildSelectionScript(candidateModel), /candidateSetHash/);

  const assessmentModel = createModel();
  assessmentModel.container.assessments[0].readiness = "incomplete";
  refreshSummaryHashes(assessmentModel);
  assessmentModel.container.assessments[0].readiness = "ready";
  assert.throws(
    () =>
      createSelectionExport({
        verifiedModel: assessmentModel,
        choices: choicesFor(assessmentModel, [SKIN_IDS[0]]),
        decisionSource: source,
        recordedAt,
      }),
    /assessmentHash/,
  );
});

function createMinimalDom(model, initialChoices = []) {
  const radios = [];
  const downloads = [];
  const blobs = [];
  class Radio {
    constructor(skinId, candidateId) {
      this.dataset = { selectionSkin: skinId, selectionCandidate: candidateId };
      this.name = `skin-choice-${skinId}`;
      this.checked = initialChoices.includes(candidateId);
      this.disabled = false;
    }
    select() {
      if (this.disabled) return;
      for (const other of radios) if (other.name === this.name) other.checked = false;
      this.checked = true;
    }
  }
  for (const candidate of model.candidateSet.candidates) radios.push(new Radio(candidate.skinId, candidate.id));
  const listeners = new Map();
  const button = { addEventListener: (name, callback) => listeners.set(name, callback) };
  const message = { textContent: "", innerHTML: "must remain untouched" };
  const document = {
    querySelectorAll: (selector) => {
      assert.equal(selector, 'input[type="radio"][data-selection-skin][data-selection-candidate]');
      return radios;
    },
    querySelector: (selector) => {
      if (selector === "button[data-selection-export]") return button;
      if (selector === "[data-selection-message]") return message;
      return null;
    },
    createElement: (tag) => {
      assert.equal(tag, "a");
      return {
        click() {
          downloads.push({ fileName: this.download, blob: this.href });
        },
        remove() {},
      };
    },
    body: { appendChild() {} },
  };
  class BlobStub {
    constructor(parts, options) {
      this.text = parts.join("");
      this.type = options.type;
      blobs.push(this);
    }
  }
  const context = {
    document,
    Blob: BlobStub,
    URL: {
      createObjectURL: (blob) => {
        const key = `blob:${blobs.indexOf(blob)}`;
        return key;
      },
      revokeObjectURL() {},
    },
    setTimeout: (callback) => callback(),
  };
  runInNewContext(buildSelectionScript(model), context);
  return {
    radios,
    button,
    message,
    downloads,
    blobs,
    clickExport() {
      listeners.get("click")({ preventDefault() {} });
    },
  };
}

test("browser script uses native same-skin radio groups, disables unsafe choices, and exports only on click", () => {
  const model = createModel();
  const firstSkin = SKIN_IDS[0];
  const extra = createCandidate(firstSkin, 99);
  const disabled = createCandidate(firstSkin, 100);
  model.candidateSet.candidates.push(extra);
  model.candidateSet.candidates.push(disabled);
  model.container.assessments.push({ candidateId: extra.id, candidateHash: extra.candidateHash, readiness: "ready" });
  model.container.assessments.push({
    candidateId: disabled.id,
    candidateHash: disabled.candidateHash,
    readiness: "ready",
  });
  model.images.units.push({ candidateId: extra.id, mode: "light" }, { candidateId: extra.id, mode: "dark" });
  model.images.units.push({ candidateId: disabled.id, mode: "light" }, { candidateId: disabled.id, mode: "dark" });
  model.selectableCandidateIds.push(extra.id);
  refreshSummaryHashes(model);

  const html = `<form><input type="radio" name="skin-choice-${firstSkin}" data-selection-skin="${firstSkin}" data-selection-candidate="${model.candidateSet.candidates[0].id}"><input type="radio" name="skin-choice-${firstSkin}" data-selection-skin="${firstSkin}" data-selection-candidate="${extra.id}"><button data-selection-export>Export</button><p data-selection-message></p></form>`;
  assert.match(html, /data-selection-export/);
  const script = buildSelectionScript(model);
  assert.doesNotMatch(script, /<\/script/i);
  assert.doesNotMatch(script, /innerHTML/);
  assert.doesNotMatch(script, /https?:\/\//i);

  const dom = createMinimalDom(model, [model.candidateSet.candidates[0].id]);
  assert.ok(
    dom.radios.every((radio) => !radio.checked),
    "script must not preselect a candidate",
  );
  assert.equal(dom.radios.find((radio) => radio.dataset.selectionCandidate === disabled.id).disabled, true);
  assert.equal(dom.downloads.length, 0, "loading the script must not export");

  const first = dom.radios.find((radio) => radio.dataset.selectionCandidate === model.candidateSet.candidates[0].id);
  const alternate = dom.radios.find((radio) => radio.dataset.selectionCandidate === extra.id);
  first.select();
  alternate.select();
  assert.equal(first.checked, false);
  assert.equal(alternate.checked, true);

  for (const skinId of SKIN_IDS.slice(1)) {
    dom.radios.find((radio) => radio.dataset.selectionSkin === skinId)?.select();
  }
  dom.clickExport();
  assert.equal(dom.downloads.length, 1);
  assert.equal(dom.downloads[0].fileName, "selections.json");
  const exported = JSON.parse(dom.blobs[0].text);
  assert.equal(validateSelections(exported).valid, true);
  assert.equal(exported.choices[firstSkin].candidateId, extra.id);
  assert.equal(exported.decisionSource, "本地报告交互，待 M5.7 确认");
  assert.equal(dom.message.innerHTML, "must remain untouched");
});

test("browser script safely embeds JSON and exports an incomplete local draft", () => {
  const model = createModel();
  model.gaps.push({ candidateId: "</script><script>alert(1)</script>", blocking: false });
  model.candidateSet.candidates[0].name = "display only";
  refreshSummaryHashes(model);
  const script = buildSelectionScript(model);
  assert.match(script, /\\u003c\/script>/i);
  assert.doesNotMatch(script, /<\/script/i);
  assert.doesNotMatch(script, /display only/);

  const dom = createMinimalDom(model);
  dom.radios[0].select();
  dom.clickExport();
  assert.equal(dom.downloads.length, 1, dom.message.textContent);
  assert.equal(dom.downloads[0].fileName, "selection-draft.json");
  const draft = JSON.parse(dom.blobs[0].text);
  assert.equal(draft.kind, "skin-palette-selection-draft");
  assert.deepEqual(draft.missingSkinIds, SKIN_IDS.slice(1));
  assert.equal(dom.message.innerHTML, "must remain untouched");
});
