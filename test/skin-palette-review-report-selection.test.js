import assert from "node:assert/strict";
import { Script, runInNewContext } from "node:vm";
import test from "node:test";
import {
  hashCandidate,
  hashCandidateSet,
  sha256Canonical,
  SKIN_IDS,
  validateSelections,
} from "../scripts/skin-palette/contracts.mjs";
import { buildSelectionScript, createSelectionExport } from "../scripts/skin-palette/review-selection.mjs";
import { renderReviewReport } from "../scripts/skin-palette/report.mjs";

const decisionSource = "本地报告交互，待 M5.7 确认";

function createCandidate(skinId, variant, label, { name, notes, readiness } = {}) {
  const candidate = {
    skinId,
    variant,
    name: name ?? `候选 ${label}`,
    notes: notes ?? `备注 ${label}`,
    profileSnapshot: { identity: `身份 ${label}`, temperament: `气质 ${label}` },
    modes: {
      light: { pageBackground: "#F7F7F7", accent: "#3478D4" },
      dark: { pageBackground: "#161616", accent: "#85B8FF" },
    },
    ...(readiness ? { readiness } : {}),
  };
  const candidateHash = hashCandidate(candidate);
  return { ...candidate, id: `${skinId}-${variant}-${candidateHash.slice(0, 12)}`, candidateHash };
}

function createModel() {
  const attack = `</script><script>globalThis.selectionInjected = true</script>\u2028\u2029`;
  const firstCandidates = SKIN_IDS.map((skinId, index) =>
    createCandidate(
      skinId,
      "a",
      `base-${index}`,
      index === 0
        ? {
            name: `quote " < ${attack}`,
            notes: `remark ' " < ${attack}`,
          }
        : {},
    ),
  );
  const firstSkin = SKIN_IDS[0];
  const alternate = createCandidate(firstSkin, "b", "alternate");
  const blockedReady = createCandidate(firstSkin, "c", "blocked-ready");
  const rejected = createCandidate(SKIN_IDS[1], "b", "rejected");
  const incomplete = createCandidate(SKIN_IDS[2], "b", "incomplete");
  const candidates = [...firstCandidates, alternate, blockedReady, rejected, incomplete];
  const readiness = new Map([
    [rejected.id, "rejected"],
    [incomplete.id, "incomplete"],
  ]);
  const candidateSet = { schemaVersion: 1, candidates };
  candidateSet.candidateSetHash = hashCandidateSet(candidateSet);
  const assessments = candidates.map((candidate) => ({
    candidateId: candidate.id,
    candidateHash: candidate.candidateHash,
    readiness: readiness.get(candidate.id) ?? "ready",
  }));
  const container = {
    schemaVersion: 1,
    candidateSetHash: candidateSet.candidateSetHash,
    assessments,
  };
  container.assessmentHash = sha256Canonical({
    schemaVersion: container.schemaVersion,
    candidateSetHash: container.candidateSetHash,
    assessments: container.assessments,
  });
  const blockedIds = new Set([blockedReady.id]);
  const attackGap = `</script><script>alert(1)</script>\u2028\u2029`;
  return {
    schemaVersion: 1,
    kind: "skin-palette-review-verified-model",
    candidateSet,
    container,
    selectableCandidateIds: candidates
      .filter((candidate) => (readiness.get(candidate.id) ?? "ready") === "ready" && !blockedIds.has(candidate.id))
      .map((candidate) => candidate.id),
    gaps: [
      { candidateId: blockedReady.id, blocking: true },
      { candidateId: attackGap, blocking: false },
    ],
    images: {
      baseline: candidates.flatMap(({ id: candidateId }) => [
        { candidateId, mode: "light" },
        { candidateId, mode: "dark" },
      ]),
      units: [],
      assets: [],
    },
  };
}

function scriptBlocks(html) {
  return Array.from(html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi), (match) => ({
    attributes: match[1],
    source: match[2],
  }));
}

function readTagAttributes(tag) {
  return Object.fromEntries(Array.from(tag.matchAll(/([^\s=<>]+)="([^"]*)"/g), (match) => [match[1], match[2]]));
}

function parseRadios(html) {
  const radios = [];
  for (const match of html.matchAll(/<input\b(?=[^>]*\btype="radio")[^>]*>/gi)) {
    const attributes = readTagAttributes(match[0]);
    radios.push({
      attributes,
      dataset: {
        selectionSkin: attributes["data-selection-skin"],
        selectionCandidate: attributes["data-selection-candidate"],
      },
      name: attributes.name,
      checked: /\schecked(?:\s|>|$)/i.test(match[0]),
      disabled: /\sdisabled(?:\s|>|$)/i.test(match[0]),
      select() {
        if (this.disabled) return;
        for (const other of radios) if (other.name === this.name) other.checked = false;
        this.checked = true;
      },
    });
  }
  return radios;
}

function createDomFromHtml(html, selectionCode) {
  const radios = parseRadios(html);
  const buttonTag = html.match(/<button\b(?=[^>]*\bdata-selection-export(?:\s|=|>))[^>]*>/i)?.[0];
  const messageTag = html.match(/<p\b(?=[^>]*\bdata-selection-message(?:\s|=|>))[^>]*>([\s\S]*?)<\/p>/i);
  assert.ok(buttonTag, "final report contains the export button");
  assert.ok(messageTag, "final report contains the selection message");
  const buttonAttributes = readTagAttributes(buttonTag);
  const listeners = new Map();
  const message = { textContent: messageTag[1], innerHTML: "must remain untouched" };
  const downloads = [];
  const blobs = [];
  const objectUrls = new Map();
  const button = {
    disabled: /\sdisabled(?:\s|>|$)/i.test(buttonTag),
    attributes: buttonAttributes,
    addEventListener: (name, callback) => listeners.set(name, callback),
  };
  const document = {
    querySelectorAll(selector) {
      assert.equal(selector, 'input[type="radio"][data-selection-skin][data-selection-candidate]');
      return radios;
    },
    querySelector(selector) {
      if (selector === "button[data-selection-export]") return button;
      if (selector === "[data-selection-message]") return message;
      return null;
    },
    createElement(tag) {
      assert.equal(tag, "a");
      return {
        click() {
          downloads.push({ fileName: this.download, blob: objectUrls.get(this.href) });
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
      createObjectURL(blob) {
        const url = `blob:${blobs.indexOf(blob)}`;
        objectUrls.set(url, blob);
        return url;
      },
      revokeObjectURL() {},
    },
    setTimeout() {},
    selectionInjected: false,
  };
  runInNewContext(selectionCode, context);
  return {
    radios,
    button,
    message,
    downloads,
    blobs,
    selectionInjected: context.selectionInjected,
    clickExport() {
      listeners.get("click")?.({ preventDefault() {} });
    },
  };
}

function renderWithSelection(model) {
  return renderReviewReport({ verifiedModel: model, selectionScript: buildSelectionScript(model) });
}

function exportRecord(dom) {
  assert.equal(dom.downloads.length, 1, dom.message.textContent);
  const blob = dom.downloads[0].blob;
  assert.equal(blob.type, "application/json");
  return { fileName: dom.downloads[0].fileName, record: JSON.parse(blob.text) };
}

test("fixed radio parser reads the checked boolean attribute from markup", () => {
  const [radio] = parseRadios(
    '<input type="radio" name="skin-choice-one" data-selection-skin="one" data-selection-candidate="one-a-000000000000" checked>',
  );
  assert.equal(radio.checked, true);
});

test("composes real selection script with report controls from the final HTML", () => {
  const model = createModel();
  const emptyHtml = renderReviewReport({ verifiedModel: model });
  const emptyButton = emptyHtml.match(/<button\b(?=[^>]*\bdata-selection-export(?:\s|=|>))[^>]*>/i)?.[0];
  assert.match(emptyHtml, /交互尚未接线/);
  assert.match(emptyButton ?? "", /\sdisabled(?:\s|>|$)/i);

  const html = renderWithSelection(model);
  const radios = parseRadios(html);
  const expected = new Map(model.candidateSet.candidates.map((candidate) => [candidate.id, candidate]));
  assert.equal(radios.length, expected.size);
  assert.ok(html.match(/<button\b(?=[^>]*\bdata-selection-export(?:\s|=|>))[^>]*>/i));
  assert.ok(html.match(/<p\b(?=[^>]*\bdata-selection-message(?:\s|=|>))/i));
  for (const radio of radios) {
    const candidate = expected.get(radio.dataset.selectionCandidate);
    assert.ok(candidate, `radio candidate exists: ${radio.dataset.selectionCandidate}`);
    assert.equal(radio.dataset.selectionSkin, candidate.skinId);
    assert.equal(radio.name, `skin-choice-${candidate.skinId}`);
    assert.equal(radio.disabled, !model.selectableCandidateIds.includes(candidate.id));
  }
  assert.equal(radios.filter((radio) => radio.dataset.selectionSkin === SKIN_IDS[0]).length, 3);
  assert.ok(radios.some((radio) => radio.dataset.selectionSkin === SKIN_IDS[1]));
  assert.equal(
    radios.every((radio) => !radio.checked),
    true,
  );

  const scripts = scriptBlocks(html);
  const executable = scripts.filter((block) => !/\btype="application\/json"/i.test(block.attributes));
  assert.equal(executable.length, 2, "only report and selection scripts are executable");
  for (const [index, block] of executable.entries())
    new Script(block.source, { filename: `report-inline-${index}.js` });
  const reviewData = scripts.find((block) => /\btype="application\/json"/i.test(block.attributes));
  assert.ok(reviewData);
  const embedded = JSON.parse(reviewData.source);
  const maliciousCandidate = embedded.candidates.find(
    (entry) => entry.candidate.id === model.candidateSet.candidates[0].id,
  );
  assert.equal(maliciousCandidate.candidate.name, model.candidateSet.candidates[0].name);
  assert.equal(maliciousCandidate.candidate.notes, model.candidateSet.candidates[0].notes);
  assert.match(reviewData.source, /\\u003c\/script>/i);

  const selectionCode = executable.at(-1).source;
  assert.doesNotMatch(selectionCode, /<\/script/i);
  assert.match(selectionCode, /\\u003c\/script/i);
  assert.match(selectionCode, /\\u2028/);
  assert.match(selectionCode, /\\u2029/);
  const dom = createDomFromHtml(html, selectionCode);
  assert.equal(dom.button.disabled, false);
  assert.equal(dom.downloads.length, 0, "loading the final embedded script does not download");
  assert.equal(dom.blobs.length, 0);
  assert.equal(
    dom.radios.every((radio) => !radio.checked),
    true,
  );
  assert.equal(dom.message.innerHTML, "must remain untouched");
  assert.equal(dom.selectionInjected, false);
});

test("same-skin choice is local and explicit export remains a complete-list draft", () => {
  const model = createModel();
  const html = renderWithSelection(model);
  const script = scriptBlocks(html)
    .filter((block) => !/\btype="application\/json"/i.test(block.attributes))
    .at(-1).source;
  const dom = createDomFromHtml(html, script);
  const firstSkin = SKIN_IDS[0];
  const [base, alternate] = model.candidateSet.candidates.filter((candidate) => candidate.skinId === firstSkin);
  const baseRadio = dom.radios.find((radio) => radio.dataset.selectionCandidate === base.id);
  const alternateRadio = dom.radios.find((radio) => radio.dataset.selectionCandidate === alternate.id);

  baseRadio.select();
  alternateRadio.select();
  assert.equal(baseRadio.checked, false);
  assert.equal(alternateRadio.checked, true);
  assert.equal(dom.radios.filter((radio) => radio.checked).length, 1);
  assert.equal(dom.downloads.length, 0, "choosing a radio does not download");

  dom.clickExport();
  const { fileName, record } = exportRecord(dom);
  assert.equal(fileName, "selection-draft.json");
  assert.equal(record.kind, "skin-palette-selection-draft");
  assert.deepEqual(record.missingSkinIds, SKIN_IDS.slice(1));
  assert.deepEqual(Object.keys(record.choices), [firstSkin]);
  assert.deepEqual(record.choices[firstSkin], { candidateId: alternate.id, candidateHash: alternate.candidateHash });
  assert.equal(record.candidateSetHash, model.candidateSet.candidateSetHash);
  assert.equal(record.assessmentHash, model.container.assessmentHash);
  assert.equal(Object.hasOwn(record, "status"), false);
  assert.equal(dom.message.innerHTML, "must remain untouched");
});

test("ten explicit choices produce the M0-valid record matching Node export", () => {
  const model = createModel();
  const html = renderWithSelection(model);
  const script = scriptBlocks(html)
    .filter((block) => !/\btype="application\/json"/i.test(block.attributes))
    .at(-1).source;
  const dom = createDomFromHtml(html, script);
  const alternateId = model.candidateSet.candidates.find(
    (candidate) => candidate.skinId === SKIN_IDS[0] && candidate.variant === "b",
  ).id;
  const choiceCandidateIds = {};
  for (const skinId of SKIN_IDS) {
    const candidate = model.candidateSet.candidates.find(
      (item) => item.skinId === skinId && (skinId !== SKIN_IDS[0] || item.id === alternateId),
    );
    const radio = dom.radios.find((item) => item.dataset.selectionCandidate === candidate.id);
    radio.select();
    choiceCandidateIds[skinId] = candidate.id;
  }
  assert.equal(dom.radios.filter((radio) => radio.checked).length, SKIN_IDS.length);
  dom.clickExport();
  const { fileName, record } = exportRecord(dom);

  assert.equal(fileName, "selections.json");
  assert.deepEqual(validateSelections(record), { valid: true, errors: [] });
  assert.equal(record.candidateSetHash, model.candidateSet.candidateSetHash);
  assert.equal(record.assessmentHash, model.container.assessmentHash);
  assert.equal(record.decisionSource, decisionSource);
  assert.deepEqual(
    Object.fromEntries(Object.entries(record.choices).map(([skinId, choice]) => [skinId, choice.candidateId])),
    choiceCandidateIds,
  );
  const nodeResult = createSelectionExport({
    verifiedModel: model,
    choices: record.choices,
    decisionSource: record.decisionSource,
    recordedAt: record.recordedAt,
  });
  assert.equal(nodeResult.fileName, fileName);
  assert.deepEqual(record, nodeResult.record);
});

test("forced blocked-ready, rejected, and incomplete radios cannot export", () => {
  const model = createModel();
  const html = renderWithSelection(model);
  const script = scriptBlocks(html)
    .filter((block) => !/\btype="application\/json"/i.test(block.attributes))
    .at(-1).source;
  const badIds = [
    model.gaps.find((gap) => gap.blocking).candidateId,
    model.container.assessments.find((assessment) => assessment.readiness === "rejected").candidateId,
    model.container.assessments.find((assessment) => assessment.readiness === "incomplete").candidateId,
  ];

  for (const candidateId of badIds) {
    const dom = createDomFromHtml(html, script);
    const radio = dom.radios.find((item) => item.dataset.selectionCandidate === candidateId);
    assert.ok(radio.disabled, `unsafe candidate is disabled: ${candidateId}`);
    radio.disabled = false;
    radio.checked = true;
    dom.clickExport();
    assert.equal(dom.downloads.length, 0, `forced selection cannot download: ${candidateId}`);
    assert.equal(dom.blobs.length, 0);
    assert.match(dom.message.textContent, /Invalid selection/);
    assert.equal(dom.message.innerHTML, "must remain untouched");
  }
});
