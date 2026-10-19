import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { renderReviewReport } from "../scripts/skin-palette/report.mjs";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jA5sAAAAASUVORK5CYII=",
  "base64",
);
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;

function makeModel(skinIds, { readiness = {}, blocked = [], missingImages = [], malicious = false } = {}) {
  const candidates = skinIds.map((skinId, index) => {
    const id = `candidate-${index}`;
    return {
      id,
      candidateHash: `candidate-hash-${index}`,
      skinId,
      name: malicious && index === 0 ? 'Name " </script><img src=x onerror=alert(1)>' : `候选 ${index}`,
      notes: malicious && index === 0 ? 'note " autofocus onfocus=alert(1) </script><img src=x>' : "普通备注",
      ...(index === 0
        ? { style: { identity: "identity-0", temperament: "temperament-0" } }
        : index === 1
          ? { profileSnapshot: { identity: "identity-1", temperament: "temperament-1" } }
          : {}),
      modes: {
        light: { background: "#fff", pageBackground: `#f0f0f${index}`, accent: `#a0b0c${index}` },
        dark: {
          background: "#111",
          pageBackground: `#10101${index}`,
          ...(index === 1 ? {} : { accent: `#50607${index}` }),
        },
      },
    };
  });
  const assessments = candidates.map((candidate, index) => ({
    candidateId: candidate.id,
    readiness: readiness[candidate.id] ?? "ready",
    failures: index === 0 ? [{ code: "failure-0", detail: "existing failure" }] : [],
    unmeasured: index === 0 ? [{ code: "unmeasured-0", detail: "existing unmeasured item" }] : [],
    diagnostics: {
      gate: { blockers: blocked.includes(candidate.id) ? [{ code: `blocker-${index}` }] : [] },
      material: candidates.map((entry, entryIndex) => ({
        candidateId: entry.id,
        skinId: entry.skinId,
        variant: `variant-${entryIndex}`,
        modes: { light: { finish: `material-${entryIndex}` }, dark: { finish: `dark-material-${entryIndex}` } },
        flatSurfaceWarnings: [],
      })),
      identity: {
        nearest: candidates.map((entry, entryIndex) => ({
          candidateId: entry.id,
          neighborId: `neighbor-${entryIndex}`,
          neighborSkinId: `neighbor-skin-${entryIndex}`,
          pairMeanDistance: 8.25 + entryIndex,
          distances: { light: 8 + entryIndex, dark: 8.5 + entryIndex },
        })),
      },
      reading: {
        entries: [
          {
            mode: "light",
            roleId: "page.body-text",
            stateId: "S1-toolbar",
            ratio: 4.6 + index,
            threshold: 4.5,
            headroom: 0.1 + index,
            preferred: 7,
            preferredHeadroom: 0.65 + index * 0.1,
            preferredMet: true,
            worstSample: { foreground: "#111111", background: "#ffffff" },
          },
          {
            mode: "dark",
            roleId: "decorative-text",
            stateId: "S1-toolbar",
            ratio: 2 + index,
            threshold: 3,
            headroom: -1 + index,
            preferred: null,
            preferredHeadroom: null,
            preferredMet: null,
            worstSample: { foreground: "#777777", background: "#111111" },
          },
        ],
        worst: {
          mode: "dark",
          roleId: "decorative-text",
          stateId: "S1-toolbar",
          ratio: 2 + index,
          threshold: 3,
          headroom: -1 + index,
          preferred: null,
          preferredHeadroom: null,
          preferredMet: null,
        },
      },
      notes: malicious && index === 0 ? '</script><img src=x onerror="alert(1)">' : "verified diagnostic",
    },
  }));
  const gaps = blocked.map((candidateId) => ({
    code: "state-image-missing",
    candidateId,
    unitId: "S1-toolbar",
    detail: "状态图未登记",
    blocking: true,
  }));
  const assets = candidates.flatMap((candidate) => {
    const candidateAssets = [];
    for (const mode of ["light", "dark"]) {
      if (missingImages.includes(`${candidate.id}:${mode}`)) continue;
      candidateAssets.push({
        candidateId: candidate.id,
        mode,
        unitId: "baseline",
        relativePath: `${mode}/baseline.png`,
        sha256: createHash("sha256").update(png).digest("hex"),
        bytes: png.length,
        dataUrl,
      });
    }
    if (blocked.includes(candidate.id)) {
      candidateAssets.push({
        candidateId: candidate.id,
        mode: "light",
        unitId: "S1-toolbar",
        relativePath: "light/S1-toolbar/state.png",
        sha256: createHash("sha256").update(png).digest("hex"),
        bytes: png.length,
        dataUrl,
      });
    }
    return candidateAssets;
  });
  const candidateSetHash = "candidate-set-hash";
  const assessmentHash = "assessment-hash";
  return {
    schemaVersion: 1,
    kind: "skin-palette-review-verified-model",
    production: false,
    requireSelections: false,
    candidateSet: { schemaVersion: 1, kind: "skin-palette-candidate-set", candidateSetHash, candidates },
    container: { schemaVersion: 1, candidateSetHash, assessmentHash, assessments },
    origins: Object.fromEntries(
      candidates.map((candidate) => [
        candidate.id,
        { source: `capture-${candidate.id}`, hashes: { capture: `hash-${candidate.id}` } },
      ]),
    ),
    images: { baseline: [], units: [], assets },
    gaps,
    selections: null,
    selectableCandidateIds: candidates
      .filter((candidate) => (readiness[candidate.id] ?? "ready") === "ready" && !blocked.includes(candidate.id))
      .map((candidate) => candidate.id),
  };
}

function embeddedModel(html) {
  const match = html.match(/<script type="application\/json" id="review-model">([\s\S]*?)<\/script>/);
  assert.ok(match, "report embeds its verified display model as JSON");
  return JSON.parse(match[1]);
}

test("renders one candidate as an unchanged light/dark baseline pair", () => {
  const model = makeModel(["skin-one"]);
  const html = renderReviewReport({ verifiedModel: model });
  const embedded = embeddedModel(html);
  const baselineAssets = embedded.candidates[0].assets.filter((asset) => asset.relativePath.endsWith("baseline.png"));

  assert.equal(baselineAssets.length, 2);
  for (const asset of baselineAssets) {
    const decoded = Buffer.from(asset.dataUrl.slice("data:image/png;base64,".length), "base64");
    assert.deepEqual(decoded, png);
    assert.equal(asset.bytes, png.length);
    assert.equal(asset.sha256, createHash("sha256").update(decoded).digest("hex"));
  }
  assert.match(html, /最近邻/);
  assert.match(html, /neighbor-0/);
  assert.match(html, /material-0/);
  assert.match(html, /4\.6/);
  assert.match(html, /preferredHeadroom/);
  assert.match(html, /0\.65/);
  assert.match(html, /candidateSetHash=candidate-set-hash/);
  assert.match(html, /assessmentHash=assessment-hash/);
  assert.match(html, /交互尚未接线/);
  assert.match(html, /data-selection-export disabled/);
  assert.match(html, /data-selection-skin="skin-one" data-selection-candidate="candidate-0"/);
  assert.doesNotMatch(html, /data-selection-candidate="candidate-0"[^>]* disabled/);
});

test("keeps readiness separate from selection eligibility and reports gaps", () => {
  const model = makeModel(["skin-one", "skin-one", "skin-two", "skin-two"], {
    readiness: { "candidate-2": "rejected", "candidate-3": "incomplete" },
    blocked: ["candidate-0"],
  });
  const html = renderReviewReport({ verifiedModel: model });
  const candidateOne = html.slice(html.indexOf('data-candidate-index="0"'), html.indexOf('data-candidate-index="1"'));
  const candidateRejected = html.slice(
    html.indexOf('data-candidate-index="2"'),
    html.indexOf('data-candidate-index="3"'),
  );

  assert.ok(html.indexOf("<h2>skin-one</h2>") < html.indexOf("<h2>skin-two</h2>"));
  assert.match(candidateOne, /Readiness：<\/b>ready/);
  assert.match(candidateOne, /禁选：存在阻断缺件/);
  assert.match(candidateOne, /data-selection-candidate="candidate-0"[^>]* disabled/);
  assert.match(candidateRejected, /rejected/);
  assert.match(candidateRejected, /readiness-rejected/);
  assert.match(html, /incomplete/);
  assert.match(html, /readiness-incomplete/);
  assert.match(candidateOne, /readiness-ready/);
  assert.match(html, /state-image-missing/);
  assert.match(html, /状态图未登记/);
});

test("renders production diagnostics for their candidate and preserves existing limitations", () => {
  const model = makeModel(["skin-one", "skin-one"], { blocked: ["candidate-0"] });
  const html = renderReviewReport({ verifiedModel: model });
  const first = html.slice(html.indexOf('data-candidate-index="0"'), html.indexOf('data-candidate-index="1"'));
  const secondStart = html.indexOf('data-candidate-index="1"');
  const second = html.slice(secondStart, html.indexOf("</article>", secondStart));

  assert.match(first, /neighbor-0/);
  assert.match(first, /material-0/);
  assert.match(first, /&quot;roleId&quot;:&quot;page\.body-text&quot;/);
  assert.match(first, /&quot;ratio&quot;:4\.6/);
  assert.match(first, /&quot;roleId&quot;:&quot;page\.body-text&quot;[^<]*&quot;headroom&quot;:0\.1/);
  assert.match(
    first,
    /<dt>主文字优选余量<\/dt><dd>\[\{&quot;mode&quot;:&quot;light&quot;,&quot;roleId&quot;:&quot;page\.body-text&quot;,&quot;preferredHeadroom&quot;:0\.65,&quot;preferredMet&quot;:true,&quot;ratio&quot;:4\.6\}\]<\/dd>/,
  );
  assert.doesNotMatch(first, /decorative-text|&quot;preferredHeadroom&quot;:7/);
  assert.doesNotMatch(first, /neighbor-1|material-1|0\.1\.25/);
  assert.match(second, /neighbor-1/);
  assert.match(second, /material-1/);
  assert.match(second, /&quot;roleId&quot;:&quot;page\.body-text&quot;/);
  assert.match(second, /&quot;ratio&quot;:5\.6/);
  assert.match(second, /&quot;roleId&quot;:&quot;page\.body-text&quot;[^<]*&quot;headroom&quot;:1\.1/);
  assert.match(
    second,
    /<dt>主文字优选余量<\/dt><dd>\[\{&quot;mode&quot;:&quot;light&quot;,&quot;roleId&quot;:&quot;page\.body-text&quot;,&quot;preferredHeadroom&quot;:0\.75,&quot;preferredMet&quot;:true,&quot;ratio&quot;:5\.6\}\]<\/dd>/,
  );
  assert.doesNotMatch(second, /decorative-text|neighbor-0|material-0|failure-0/);
  assert.match(first, /identity-0/);
  assert.match(first, /temperament-0/);
  assert.match(second, /identity-1/);
  assert.match(second, /#f0f0f1/);
  assert.match(second, /#a0b0c1/);
  assert.match(second, /主要背景：#101011/);
  assert.match(second, /强调色：未提供/);
  assert.match(html, /data-blockers/);
  assert.match(html, /data-failures/);
  assert.match(html, /data-unmeasured/);
  assert.match(html, /entry\.assessment\?\.diagnostics\?\.gate\?\.blockers/);
  assert.match(html, /entry\.assessment\?\.failures/);
  assert.match(html, /entry\.assessment\?\.unmeasured/);
  assert.match(html, /node\.textContent=JSON\.stringify/);
  assert.deepEqual(model.container.assessments[0].failures, [{ code: "failure-0", detail: "existing failure" }]);
  assert.deepEqual(model.container.assessments[0].unmeasured, [
    { code: "unmeasured-0", detail: "existing unmeasured item" },
  ]);

  const noRequiredModel = makeModel(["skin-one"]);
  noRequiredModel.container.assessments[0].diagnostics.reading.entries = [
    { mode: "dark", roleId: "decorative-text", headroom: -5, preferredHeadroom: null },
  ];
  const noRequiredHtml = renderReviewReport({ verifiedModel: noRequiredModel });
  assert.match(noRequiredHtml, /<dt>最差必要对比<\/dt><dd>未提供<\/dd>/);
});

test("shows state images referenced only by failure or unmeasured state ids", () => {
  const model = makeModel(["skin-one"]);
  const assessment = model.container.assessments[0];
  assessment.failures = [{ code: "failure-state", stateId: "S4-failure" }];
  assessment.unmeasured = [{ code: "unmeasured-state", stateId: "S5-unmeasured" }];
  model.gaps = [];
  for (const unitId of ["S4-failure", "S5-unmeasured", "S6-unrelated"]) {
    model.images.assets.push({
      candidateId: "candidate-0",
      mode: "light",
      unitId,
      relativePath: `light/${unitId}/state.png`,
      sha256: createHash("sha256").update(png).digest("hex"),
      bytes: png.length,
      dataUrl,
    });
  }
  const html = renderReviewReport({ verifiedModel: model });
  const entry = embeddedModel(html).candidates[0];
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  const helper = script?.match(/function relatedStateAssets\(entry\)\{([\s\S]*?)\n\}/)?.[0];

  assert.equal(entry.gaps.length, 0);
  assert.deepEqual(entry.assessment.failures, [{ code: "failure-state", stateId: "S4-failure" }]);
  assert.deepEqual(entry.assessment.unmeasured, [{ code: "unmeasured-state", stateId: "S5-unmeasured" }]);
  assert.ok(helper, "the detail gallery uses a candidate state-image filter");
  const selectStateAssets = runInNewContext(`(${helper})`, {
    isBaseline: (asset) => (asset.relativePath ?? "").toLowerCase().endsWith("baseline.png"),
    pngDataUrl: /^data:image\/png;base64,[A-Za-z0-9+/]*={0,2}$/,
  });
  const selectedUnitIds = Array.from(selectStateAssets(entry), (asset) => asset.unitId).sort();
  assert.deepEqual(selectedUnitIds, ["S4-failure", "S5-unmeasured"]);
});

test("renders the ten-skin report with two readable mode grids in candidate order", () => {
  const skinIds = Array.from({ length: 10 }, (_, index) => `skin-${index}`);
  const html = renderReviewReport({ verifiedModel: makeModel(skinIds) });
  const embedded = embeddedModel(html);

  assert.equal((html.match(/data-overview-mode="light"/g) ?? []).length, 1);
  assert.equal((html.match(/data-overview-mode="dark"/g) ?? []).length, 1);
  assert.equal((html.match(/data-selection-skin=/g) ?? []).length, 10);
  assert.deepEqual(
    embedded.candidates.map((entry) => entry.candidate.skinId),
    skinIds,
  );
  assert.equal(
    embedded.candidates.flatMap((entry) => entry.assets).filter((asset) => asset.relativePath.endsWith("baseline.png"))
      .length,
    20,
  );
  assert.match(html, /grid-template-columns:repeat\(auto-fit,minmax\(320px,1fr\)\)/);
});

test("escapes candidate content, JSON and script close sequences; never emits remote resources", () => {
  const model = makeModel(["skin-one"], { malicious: true });
  const script = 'window.selectionProbe = "</script><img src=x onerror=alert(1)>";';
  const html = renderReviewReport({ verifiedModel: model, selectionScript: script });
  const embedded = embeddedModel(html);

  assert.match(html, /&lt;\/script&gt;&lt;img/);
  assert.match(html, /\\u003c\/script>\\u003cimg/);
  assert.doesNotMatch(html, /<\/script><img src=x/);
  assert.match(html, /<\\\/script><img src=x/);
  assert.equal(embedded.candidates[0].candidate.name, 'Name " </script><img src=x onerror=alert(1)>');
  assert.equal(embedded.candidates[0].candidate.notes, 'note " autofocus onfocus=alert(1) </script><img src=x>');
  assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//i);
  assert.doesNotMatch(html, /<link[^>]+href|@import\s+url/i);
  assert.doesNotMatch(html, /innerHTML/);
});

test("does not substitute another mode for a missing baseline and rejects null models", () => {
  const model = makeModel(["skin-one"], { missingImages: ["candidate-0:dark"] });
  const html = renderReviewReport({ verifiedModel: model });
  const assets = embeddedModel(html).candidates[0].assets;

  assert.equal(assets.filter((asset) => asset.relativePath.endsWith("baseline.png")).length, 1);
  assert.equal(assets.find((asset) => asset.relativePath.endsWith("baseline.png")).mode, "light");
  assert.match(html, /缺图：.*baseline\.png/);
  assert.throws(() => renderReviewReport({ verifiedModel: null }), TypeError);
});
