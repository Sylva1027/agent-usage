// M4.4.2 离线核验（review-verify.mjs）验收测试。
// 夹具集中在 test-support/skin-palette-review-evidence-fixture.mjs；样本只用于证据核验，不代表真实视觉验收。
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { SKIN_IDS, canonicalFileContent, canonicalJson, sha256Canonical } from "../scripts/skin-palette/contracts.mjs";
import { REQUIRED_SOURCE_FILES, assessCandidate } from "../scripts/skin-palette/assess.mjs";
import { SOURCE_FILES } from "../scripts/skin-palette/capture.mjs";
import {
  REVIEW_VERIFY_ERROR_CODES,
  REVIEW_VERIFY_STATUSES,
  verifyReviewEvidence,
} from "../scripts/skin-palette/review-verify.mjs";
import { verifyProductionHistoricalEvidence } from "../scripts/skin-palette/production-source-origins.mjs";
import {
  ReviewEvidenceError,
  buildReviewContainer,
  loadReviewEvidence,
} from "../scripts/skin-palette/review-evidence.mjs";
import {
  HISTORICAL_SOURCE_FILES,
  PNG_BYTES,
  POLICY,
  REAL_SOURCE_HASHES,
  ROLE_BY_ID,
  STATE_UNIT_COUNT,
  buildRun,
  createSandbox,
  load,
  makeCandidate,
  makeCandidateSet,
  makeHistoricalSourceSet,
  matrixRecords,
  realAssessment,
  sha256,
  visualAccept,
  writeAssessments,
  writeCandidates,
  writeIndex,
  writeJson,
  writeMatrixCapture,
} from "../test-support/skin-palette-review-evidence-fixture.mjs";
import { getPaletteFixtureHash } from "../test-support/skin-palette-fixture.mjs";

const findGap = (result, code) => result.gaps.filter((gap) => gap.code === code);

const blockingCodes = (result) => [...new Set(result.gaps.filter((gap) => gap.blocking).map((gap) => gap.code))];

test("原评审和重算同为incomplete时，零外部缺件也不能折叠成pass", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({ skinId: "chatgpt", variant: "a" });
    const visual = visualAccept();
    visual.verdict = "pending";
    visual.items = visual.items.map((item) => ({ ...item, verdict: "pending" }));
    const { runDir, evidence } = await buildRun(box, "run", [candidate], {
      origins: { currentProfiles: true },
      visualReviews: { [candidate.id]: visual },
    });
    const initial = await verifyReviewEvidence({ evidence });
    await writeAssessments(runDir, initial.verifiedModel.container);
    const result = await verifyReviewEvidence({
      evidence: await load(box, runDir, path.join(runDir, "captures-index.json")),
    });
    assert.equal(result.verifiedModel.container.assessments[0].readiness, "incomplete");
    assert.deepEqual(blockingCodes(result), []);
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.verifiedModel.selectableCandidateIds, []);
  } finally {
    await box.cleanup();
  }
});

test("焦点补验登记损坏、未知或重复候选时不降级为无补验", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({ skinId: "chatgpt", variant: "a" });
    const { evidence } = await buildRun(box, "run", [candidate]);
    for (const content of [
      "{",
      JSON.stringify({ schemaVersion: 1, items: [], extra: true }),
      JSON.stringify({ schemaVersion: 1, items: [{ originalRecord: { candidateId: "unknown" } }] }),
      JSON.stringify({
        schemaVersion: 1,
        items: [{ originalRecord: { candidateId: candidate.id } }, { originalRecord: { candidateId: candidate.id } }],
      }),
    ]) {
      await writeFile(path.join(evidence.run.dir, "focus-supplements.json"), content);
      const result = await verifyReviewEvidence({ evidence });
      assert.equal(result.status, "invalid");
      assert.equal(result.verifiedModel, null);
      assert.equal(result.errors[0].code, "FOCUS_SUPPLEMENT_INVALID");
    }
  } finally {
    await box.cleanup();
  }
});
test("完整固定样本（配方来源未登记）：除 unverifiable 阻断外全绿，重算容器哈希保持、两次调用逐字节可复现", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({ skinId: "chatgpt", variant: "a" });
    const { container, evidence } = await buildRun(box, "run", [candidate]);
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete", "配方来源未登记时 pass 不可达");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(blockingCodes(result), ["current-profiles-unverifiable"]);
    const unverifiable = findGap(result, "current-profiles-unverifiable")[0];
    assert.equal(unverifiable.candidateId, candidate.id);
    assert.ok(
      unverifiable.detail.includes("currentProfiles"),
      "缺件明细写明未登记 currentProfiles（内部出处无出处文件可登记）",
    );
    // 其余全绿：重算容器哈希与原容器一致（原批次上下文重建忠实的硬证明）。
    assert.equal(result.verifiedModel.container.assessmentHash, container.assessmentHash);
    assert.equal(result.verifiedModel.container.assessments[0].readiness, "ready");
    assert.deepEqual(result.verifiedModel.selectableCandidateIds, [], "阻断缺件挂到候选 → 禁选");
    assert.equal(result.verifiedModel.images.baseline.length, 6, "两模式 × 3 张基线 png（基准/首屏/测量截图）");
    assert.equal(result.verifiedModel.images.units.length, STATE_UNIT_COUNT * 2, "全矩阵 30 状态单元 × 两模式");
    const assets = result.verifiedModel.images.assets;
    assert.equal(assets.length, STATE_UNIT_COUNT * 2 + 4, "状态单元图 + 两模式的 baseline/first-screen");
    assert.deepEqual(
      assets.map(({ candidateId, mode, relativePath }) => [candidateId, mode, relativePath]),
      [...assets]
        .sort(
          (left, right) =>
            left.candidateId.localeCompare(right.candidateId) ||
            (left.mode === "light" ? 0 : 1) - (right.mode === "light" ? 0 : 1) ||
            left.relativePath.localeCompare(right.relativePath),
        )
        .map(({ candidateId, mode, relativePath }) => [candidateId, mode, relativePath]),
      "assets 按候选、模式和相对路径稳定排序",
    );
    assert.ok(Object.isFrozen(assets));
    for (const asset of assets) {
      assert.deepEqual(Object.keys(asset).sort(), [
        "bytes",
        "candidateId",
        "dataUrl",
        "mode",
        "relativePath",
        "sha256",
        "unitId",
      ]);
      assert.ok(Object.isFrozen(asset));
      assert.match(asset.dataUrl, /^data:image\/png;base64,/);
      const base64 = asset.dataUrl.slice("data:image/png;base64,".length);
      const imageBytes = Buffer.from(base64, "base64");
      assert.equal(imageBytes.toString("base64"), base64, "dataUrl base64 编码完整");
      assert.equal(sha256(imageBytes), asset.sha256);
      assert.equal(imageBytes.length, asset.bytes);
      assert.deepEqual(imageBytes, PNG_BYTES, "嵌入字节来自样本原图");
    }
    assert.deepEqual(Object.keys(result.verifiedModel.images.baseline[0]).sort(), [
      "bytes",
      "candidateId",
      "file",
      "mode",
      "sha256",
    ]);
    assert.deepEqual(Object.keys(result.verifiedModel.images.units[0]).sort(), [
      "candidateId",
      "evidenceHash",
      "mode",
      "stateId",
      "unitId",
    ]);
    // 夹具保真锁：S0 checks.json 必须与 capture.mjs:1274-1282 真实输出同键集
    //（没有 kind/status/schemaVersion/unitId）——夹具多添字段会掩盖校验失配。
    const baselineChecks = JSON.parse(
      await readFile(path.join(evidence.captures[candidate.id].dir, "light", "checks.json"), "utf8"),
    );
    assert.deepEqual(
      Object.keys(baselineChecks).sort(),
      ["candidateId", "captureIndex", "counts", "diagnostics", "mode", "records", "stateId"],
      "S0 checks.json 键集必须与真实 capture.mjs 输出一致",
    );
    assert.ok(Object.isFrozen(result.verifiedModel));
    assert.ok(Object.isFrozen(result.verifiedModel.container));
    // 确定性：同一 evidence、磁盘未变 → canonicalJson 逐字节一致。
    const second = await verifyReviewEvidence({ evidence });
    assert.equal(canonicalJson(second), canonicalJson(result));
  } finally {
    box.cleanup();
  }
});

test("images.assets 顺序遵循候选集、light/dark 与相对路径", async () => {
  const box = await createSandbox();
  try {
    const candidates = [
      makeCandidate({ skinId: "chatgpt", variant: "a" }),
      makeCandidate({ skinId: "claude", variant: "a" }),
    ];
    const { evidence } = await buildRun(box, "run-asset-order", candidates, { groups: ["S0"] });
    const result = await verifyReviewEvidence({ evidence });
    const expected = candidates.flatMap((candidate) => [
      [candidate.id, "light", "light/baseline.png"],
      [candidate.id, "light", "light/first-screen.png"],
      [candidate.id, "dark", "dark/baseline.png"],
      [candidate.id, "dark", "dark/first-screen.png"],
    ]);
    assert.deepEqual(
      result.verifiedModel.images.assets.map(({ candidateId, mode, relativePath }) => [
        candidateId,
        mode,
        relativePath,
      ]),
      expected,
    );
  } finally {
    box.cleanup();
  }
});

test("配方来源已登记且一致：完整样本 → pass 且可选（当前配方通道接线·验收①）", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({ skinId: "chatgpt", variant: "a" });
    const { evidence } = await buildRun(box, "run", [candidate], { origins: { currentProfiles: true } });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "pass", "出处登记 currentProfiles + sha256Canonical(条目) === profileHash → pass 可达");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(blockingCodes(result), [], "配方一致后无阻断缺件");
    assert.deepEqual(result.verifiedModel.selectableCandidateIds, [candidate.id], "pass 且可选");
    assert.ok(result.verifiedModel.images.assets.length > 0, "pass 模型包含原图 dataUrl");
    assert.ok(findGap(result, "current-profiles-unverifiable").length === 0);
    assert.ok(findGap(result, "current-recipe-drift").length === 0);
  } finally {
    box.cleanup();
  }
});

test("缺来源阻断：出处文件未登记 currentProfiles（省略与显式 null 都算）（验收②）", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({ skinId: "chatgpt", variant: "a" });
    // a) 出处文件照写、条目省略该键
    const plain = await buildRun(box, "run-plain", [candidate], { origins: {} });
    const plainResult = await verifyReviewEvidence({ evidence: plain.evidence });
    assert.equal(plainResult.status, "incomplete");
    const plainGap = findGap(plainResult, "current-profiles-unverifiable");
    assert.equal(plainGap.length, 1);
    assert.equal(plainGap[0].blocking, true);
    assert.equal(plainGap[0].candidateId, candidate.id);
    assert.ok(plainGap[0].detail.includes("未登记"), "文件出处在场但未登记——点名登记要求");

    // b) 显式 currentProfiles: null（登记"无来源"）
    const nulled = await buildRun(box, "run-null", [candidate], { origins: { currentProfiles: null } });
    const nulledResult = await verifyReviewEvidence({ evidence: nulled.evidence });
    assert.equal(nulledResult.status, "incomplete");
    assert.equal(findGap(nulledResult, "current-profiles-unverifiable").length, 1);
  } finally {
    box.cleanup();
  }
});

test("配方漂移阻断：登记摘要诚实但来源内容 ≠ 候选 profileHash → current-recipe-drift（验收③）", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({ skinId: "chatgpt", variant: "a" });
    const { evidence } = await buildRun(box, "run", [candidate], {
      origins: {
        currentProfiles: true,
        profilesPatch: (snapshot) => ({ ...snapshot, identityHex: "#000000" }),
      },
    });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete", "配方漂移按阻断缺件处理（登记摘要诚实，字节核验不报）");
    const drift = findGap(result, "current-recipe-drift");
    assert.equal(drift.length, 1);
    assert.equal(drift[0].blocking, true);
    assert.equal(drift[0].candidateId, candidate.id);
    assert.ok(drift[0].detail.includes("profileHash"), "点名比对口径");
    assert.deepEqual(result.verifiedModel.selectableCandidateIds, [], "漂移 → 禁选");
    assert.ok(findGap(result, "current-profiles-source-changed").length === 0, "字节一致，不误报来源变化");
  } finally {
    box.cleanup();
  }
});

test("D8u3B2: disk verifier blocks missing fixture maps and rejects bad headers per candidate", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({ skinId: "chatgpt", variant: "a" });
    const missingCases = [
      [
        "both",
        {
          capture: (capture) => delete capture.fixtureBindings,
          progress: (progress) => delete progress.digests.fixtureBindings,
        },
        2,
      ],
      ["capture", { capture: (capture) => delete capture.fixtureBindings }, 1],
      ["progress", { progress: (progress) => delete progress.digests.fixtureBindings }, 1],
    ];
    for (const [label, mutations, expectedCount] of missingCases) {
      const { evidence } = await buildRun(box, `missing-${label}`, [candidate], {
        groups: ["S8"],
        captureOptions: () => ({
          ...(mutations.capture ? { tweakCapture: mutations.capture } : {}),
          ...(mutations.progress ? { tweakProgress: mutations.progress } : {}),
        }),
      });
      const result = await verifyReviewEvidence({ evidence });
      assert.equal(result.status, "incomplete", label);
      assert.deepEqual(result.errors, [], label);
      const headerGaps = findGap(result, "capture-fixture-bindings-missing");
      assert.equal(headerGaps.length, expectedCount, label);
      assert.ok(
        headerGaps.every((gap) => gap.blocking && gap.candidateId === candidate.id),
        label,
      );
    }

    const invalidCases = [
      [
        "wrong S8 binding",
        ["S8"],
        {
          tweakCapture(capture) {
            capture.fixtureBindings = {
              ...capture.fixtureBindings,
              S8: { fixtureKind: "base", fixtureHash: getPaletteFixtureHash() },
            };
          },
        },
      ],
      [
        "wrong base binding",
        ["S0", "S8"],
        {
          tweakCapture(capture) {
            capture.fixtureBindings = {
              ...capture.fixtureBindings,
              S0: { fixtureKind: "base", fixtureHash: "0".repeat(64) },
            };
          },
        },
      ],
      ["wrong root hash", ["S8"], { tweakCapture: (capture) => (capture.fixtureHash = "0".repeat(64)) }],
      ["groups conflict", ["S8"], { tweakProgress: (progress) => (progress.groups = ["S0"]) }],
      ["modes conflict", ["S8"], { tweakProgress: (progress) => (progress.modes = ["light"]) }],
      [
        "missing capture map does not hide bad progress map",
        ["S8"],
        {
          tweakCapture: (capture) => delete capture.fixtureBindings,
          tweakProgress(progress) {
            progress.digests.fixtureBindings = {
              ...progress.digests.fixtureBindings,
              S8: { fixtureKind: "base", fixtureHash: getPaletteFixtureHash() },
            };
          },
        },
      ],
    ];
    for (const [label, groups, mutations] of invalidCases) {
      const { evidence } = await buildRun(box, `invalid-${label.replaceAll(" ", "-")}`, [candidate], {
        groups,
        captureOptions: () => mutations,
      });
      const result = await verifyReviewEvidence({ evidence });
      assert.equal(result.status, "invalid", label);
      assert.deepEqual(
        result.errors.map(({ code, candidateId }) => [code, candidateId]),
        [["CAPTURE_FIXTURE_HEADER_INVALID", candidate.id]],
        label,
      );
      assert.ok(result.errors[0].detail.includes("fixture header invalid"), label);
    }

    const bad = makeCandidate({ skinId: "claude", variant: "a" });
    const peer = makeCandidate({ skinId: "glm", variant: "a" });
    const { evidence } = await buildRun(box, "invalid-header-keeps-peer", [bad, peer], {
      groups: ["S8"],
      captureOptions: (candidateEntry) =>
        candidateEntry.id === bad.id
          ? {
              tweakCapture(capture) {
                capture.fixtureBindings = {
                  ...capture.fixtureBindings,
                  S8: { fixtureKind: "base", fixtureHash: getPaletteFixtureHash() },
                };
              },
            }
          : {},
    });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "invalid");
    assert.deepEqual(
      result.errors.map(({ code, candidateId }) => [code, candidateId]),
      [["CAPTURE_FIXTURE_HEADER_INVALID", bad.id]],
    );
    assert.ok(
      findGap(result, "capture-groups-partial").some((gap) => gap.candidateId === peer.id),
      "the malformed candidate does not prevent the next candidate from being checked",
    );
  } finally {
    box.cleanup();
  }
});

test("D8u3B2: verifyReviewEvidence rejects S8 proof semantics after a valid tree rehash", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({ skinId: "chatgpt", variant: "a" });
    const semantic = await buildRun(box, "semantic-proof", [candidate], {
      groups: ["S8"],
      captureOptions: () => ({
        fixtureProofOverride: (proof) => ({ ...proof, actualHash: getPaletteFixtureHash(), match: true }),
      }),
    });
    const semanticResult = await verifyReviewEvidence({ evidence: semantic.evidence });
    assert.equal(semanticResult.status, "incomplete");
    const semanticGaps = findGap(semanticResult, "capture-unit-evidence-invalid").filter((gap) =>
      gap.detail.includes("trace.fixtureRequirement"),
    );
    assert.equal(
      semanticGaps.length,
      2,
      "both S8 modes reject a false actualHash even though writer rehashed the tree",
    );
    assert.ok(semanticGaps.every((gap) => gap.blocking));

    const digestOnly = await buildRun(box, "digest-only-proof", [candidate], { groups: ["S8"] });
    const statePath = path.join(
      digestOnly.evidence.captures[candidate.id].dir,
      "light",
      "states",
      "timeline-range-warning",
      "state.json",
    );
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.trace.fixtureRequirement.actualHash = getPaletteFixtureHash();
    await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
    const digestResult = await verifyReviewEvidence({ evidence: digestOnly.evidence });
    assert.equal(digestResult.status, "incomplete");
    assert.ok(
      findGap(digestResult, "capture-unit-evidence-invalid").some((gap) =>
        gap.detail.includes("证据文件摘要与 progress.json 不一致"),
      ),
      "without updating progress evidenceHash, the original digest guard still rejects first",
    );
  } finally {
    box.cleanup();
  }
});

test("配方来源载入后被改 → current-profiles-source-changed；缺该皮肤条目 → source-invalid", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({ skinId: "chatgpt", variant: "a" });
    // a) .1 载入时摘要一致，载入后重写文件 → .2 重读按登记摘要拦下
    const { runDir, evidence } = await buildRun(box, "run", [candidate], { origins: { currentProfiles: true } });
    const profiles = JSON.parse(await readFile(path.join(runDir, "current-profiles.json"), "utf8"));
    profiles[candidate.skinId] = { ...profiles[candidate.skinId], identityHex: "#123456" };
    await writeFile(path.join(runDir, "current-profiles.json"), `${JSON.stringify(profiles)}\n`, "utf8");
    const changed = await verifyReviewEvidence({ evidence });
    assert.equal(changed.status, "incomplete", "结论只绑定已核字节");
    const changedGap = findGap(changed, "current-profiles-source-changed");
    assert.equal(changedGap.length, 1);
    assert.equal(changedGap[0].blocking, true);
    assert.ok(findGap(changed, "current-recipe-drift").length === 0, "字节失配先于语义比对");

    // b) 登记摘要诚实的空映射：解析成功但没有该皮肤条目
    const empty = await buildRun(box, "run-empty", [candidate], {
      origins: { currentProfiles: true, profilesSource: "{}\n" },
    });
    const emptyResult = await verifyReviewEvidence({ evidence: empty.evidence });
    const invalidGap = findGap(emptyResult, "current-profiles-source-invalid");
    assert.equal(invalidGap.length, 1);
    assert.equal(invalidGap[0].blocking, true);
    assert.ok(invalidGap[0].detail.includes(candidate.skinId), "点名缺失条目的皮肤");
  } finally {
    box.cleanup();
  }
});

test("局部捕获—组：只登记 S0 → capture-groups-partial 阻断，不当完整证据（复核第 1 项）", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const { evidence } = await buildRun(box, "run", [candidate], { groups: ["S0"] });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    const partial = findGap(result, "capture-groups-partial");
    assert.equal(partial.length, 1);
    assert.equal(partial[0].blocking, true);
    assert.ok(partial[0].detail.includes("局部捕获"));
    assert.ok(partial[0].detail.includes("S1") && partial[0].detail.includes("D"), "点名缺失的组");
    assert.equal(result.verifiedModel.images.assets.length, 4, "局部 S0 只保留已核基线图，不伪造状态图");
    assert.ok(result.verifiedModel.images.assets.every((asset) => asset.unitId === "baseline"));
  } finally {
    box.cleanup();
  }
});

test("局部捕获—模式：只有浅色 → capture-modes-partial 阻断（复核第 1 项）", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const { evidence } = await buildRun(box, "run", [candidate], { modes: ["light"] });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    const partial = findGap(result, "capture-modes-partial");
    assert.equal(partial.length, 1);
    assert.equal(partial[0].blocking, true);
    assert.ok(partial[0].detail.includes("dark"), "缺深色必须点名");
  } finally {
    box.cleanup();
  }
});

test("缺一必要状态不通过：dark/baseline 无进度记录 → incomplete 且禁选", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const { evidence } = await buildRun(box, "run", [candidate], {
      captureOptions: () => ({
        tweakProgress: (progress) => {
          delete progress.units["dark/baseline"];
        },
      }),
    });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    const missing = findGap(result, "capture-unit-missing");
    assert.equal(missing.length, 1);
    assert.equal(missing[0].candidateId, candidate.id);
    assert.equal(missing[0].blocking, true);
    assert.ok(missing[0].detail.includes("dark"), "缺件明细指出缺失的模式");
    assert.deepEqual(result.verifiedModel.selectableCandidateIds, []);
    assert.ok(result.verifiedModel.container.assessments.length > 0, "保留显示模型与诊断");
  } finally {
    box.cleanup();
  }
});

test("伪 ready 不通过：登记摘要与当前磁盘不一致 → readiness 退回 incomplete，容器哈希改变", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const { container, evidence } = await buildRun(box, "run", [candidate], {
      groups: ["S0"],
      captureOptions: () => ({
        // capture.json 的登记摘要换成"格式合法但内容造假"的摘要：磁盘没变、登记变了。
        tweakCapture: (capture) => {
          capture.sourceHashes = Object.fromEntries(
            Object.keys(capture.sourceHashes).map((file) => [file, sha256Canonical({ fake: file })]),
          );
        },
      }),
    });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    const mismatch = findGap(result, "source-digest-mismatch");
    assert.equal(mismatch.length, 1, "不一致单独成类");
    assert.ok(mismatch[0].detail.includes("不一致"));
    assert.ok(mismatch[0].detail.includes("public/app.js"), "列出漂移文件");
    const changed = findGap(result, "readiness-changed");
    assert.equal(changed.length, 1);
    assert.ok(changed[0].detail.includes("ready") && changed[0].detail.includes("incomplete"));
    assert.equal(changed[0].blocking, true);
    assert.notEqual(result.verifiedModel.container.assessmentHash, container.assessmentHash);
    assert.deepEqual(result.verifiedModel.selectableCandidateIds, []);
  } finally {
    box.cleanup();
  }
});

test("受限历史源码快照：原候选容器忠实重建、默认仍过期，复制在首次 await 前完成", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const set = makeCandidateSet([candidate]);
    const historical = makeHistoricalSourceSet("D2a-original");
    const originalAssessment = realAssessment(candidate, set, null, historical.hashes);
    const { container, evidence } = await buildRun(box, "run", [candidate], {
      groups: ["S0"],
      assessments: [originalAssessment],
      captureOptions: () => ({
        tweakCapture: (capture) => {
          capture.sourceHashes = { ...historical.hashes };
        },
        tweakProgress: (progress) => {
          progress.digests.sourceHashes = { ...historical.hashes };
        },
      }),
    });

    const ordinary = await verifyReviewEvidence({ evidence });
    assert.deepEqual(Object.keys(ordinary).sort(), ["errors", "gaps", "status", "verifiedModel"]);
    assert.equal(Object.hasOwn(ordinary, "sourceContext"), false, "默认调用返回形状不变");
    assert.equal(findGap(ordinary, "source-digest-mismatch").length, 1);
    assert.notEqual(ordinary.verifiedModel.container.assessmentHash, container.assessmentHash);

    const supplied = Object.assign(
      Object.create(null),
      Object.fromEntries(HISTORICAL_SOURCE_FILES.map((file) => [file, Buffer.from(historical.buffers[file])])),
    );
    const pending = verifyReviewEvidence({ evidence, sourceSnapshot: supplied });
    for (const bytes of Object.values(supplied)) bytes.fill(0);
    const result = await pending;
    assert.equal(result.sourceContext, "historical");
    assert.equal(result.status, "incomplete", "S0-only fixture remains incomplete");
    assert.equal(findGap(result, "source-digest-mismatch").length, 0);
    assert.equal(result.verifiedModel.container.assessmentHash, container.assessmentHash);
    assert.deepEqual(result.verifiedModel.container.assessments, container.assessments);
    assert.deepEqual(result.verifiedModel.candidateSet.candidates, set.candidates);

    const wrong = Object.fromEntries(
      HISTORICAL_SOURCE_FILES.map((file) => [file, Buffer.from(historical.buffers[file])]),
    );
    wrong["public/skin-picker.js"][0] ^= 1;
    const wrongResult = await verifyReviewEvidence({ evidence, sourceSnapshot: wrong });
    assert.equal(wrongResult.sourceContext, "historical");
    const mismatch = findGap(wrongResult, "source-digest-mismatch");
    assert.equal(mismatch.length, 1);
    assert.ok(mismatch[0].detail.includes("public/skin-picker.js"));
    assert.notEqual(wrongResult.verifiedModel.container.assessmentHash, container.assessmentHash);
  } finally {
    box.cleanup();
  }
});

test("历史快照按候选独立核对，且其它源码仍读当前磁盘", async () => {
  const box = await createSandbox();
  try {
    const first = makeCandidate({ skinId: "chatgpt" });
    const second = makeCandidate({ skinId: "claude" });
    const set = makeCandidateSet([first, second]);
    const firstHistory = makeHistoricalSourceSet("D2a-first-original");
    const secondHistory = makeHistoricalSourceSet("D2a-second-original");
    secondHistory.hashes["public/app.js"] = sha256(Buffer.from("unavailable old app.js bytes"));
    const historyById = new Map([
      [first.id, firstHistory],
      [second.id, secondHistory],
    ]);
    const { evidence } = await buildRun(box, "run", [first, second], {
      groups: ["S0"],
      assessments: [
        realAssessment(first, set, null, firstHistory.hashes),
        realAssessment(second, set, null, secondHistory.hashes),
      ],
      captureOptions: (candidate) => ({
        tweakCapture: (capture) => {
          capture.sourceHashes = { ...historyById.get(candidate.id).hashes };
        },
        tweakProgress: (progress) => {
          progress.digests.sourceHashes = { ...historyById.get(candidate.id).hashes };
        },
      }),
    });

    const result = await verifyReviewEvidence({ evidence, sourceSnapshot: firstHistory.buffers });
    assert.equal(result.sourceContext, "historical");
    const mismatches = findGap(result, "source-digest-mismatch");
    assert.equal(mismatches.length, 1, "只有第二候选的原摘要与这份历史快照不一致");
    assert.equal(mismatches[0].candidateId, second.id);
    for (const file of [...HISTORICAL_SOURCE_FILES, "public/app.js"]) {
      assert.ok(mismatches[0].detail.includes(file), `第二候选的 ${file} 漂移仍被报告`);
    }
    assert.ok(
      findGap(result, "readiness-changed").some((gap) => gap.candidateId === second.id),
      "未授权的源码漂移继续让第二候选评审退步",
    );
  } finally {
    box.cleanup();
  }
});

test("历史源码快照拒绝错误形状和正式模式组合", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const { evidence } = await buildRun(box, "run", [candidate], { groups: ["S0"] });
    const valid = makeHistoricalSourceSet("D2a-shape").buffers;
    const missing = { ...valid };
    delete missing["public/skin-picker.js"];
    const extra = { ...valid, "public/other.js": Buffer.from("not allowed") };
    const inherited = Object.assign(Object.create({ inherited: true }), valid);
    const withSymbol = { ...valid, [Symbol("extra")]: Buffer.from("not allowed") };
    const badBuffer = { ...valid, "public/skin-picker.js": "not a Buffer" };
    const proxied = new Proxy({ ...valid }, {});

    for (const sourceSnapshot of [null, missing, extra, inherited, withSymbol, badBuffer, proxied]) {
      const result = await verifyReviewEvidence({ evidence, sourceSnapshot });
      assert.equal(result.status, "invalid");
      assert.equal(result.errors[0].code, "INVALID_INPUT");
      assert.equal(result.verifiedModel, null);
      assert.equal(result.sourceContext, "historical");
    }

    const production = await verifyReviewEvidence({ evidence, sourceSnapshot: valid, production: true });
    assert.equal(production.status, "invalid");
    assert.equal(production.errors[0].code, "INVALID_INPUT");
    assert.equal(production.verifiedModel, null);
    assert.equal(production.sourceContext, "historical");
  } finally {
    box.cleanup();
  }
});

test("D5b：来源与历史结果分开保留，完整原容器重建只让摘要绑定通过", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const set = makeCandidateSet([candidate]);
    const historical = makeHistoricalSourceSet("D5b-original");
    const originalAssessment = realAssessment(candidate, set, null, historical.hashes);
    const { container, evidence } = await buildRun(box, "run-d5b-bound", [candidate], {
      groups: ["S0"],
      assessments: [originalAssessment],
      captureOptions: () => ({
        tweakCapture: (capture) => {
          capture.sourceHashes = { ...historical.hashes };
        },
        tweakProgress: (progress) => {
          progress.digests.sourceHashes = { ...historical.hashes };
        },
      }),
    });
    const beforeSourceHashes = { ...historical.hashes };
    const sourceSnapshot = Object.fromEntries(
      HISTORICAL_SOURCE_FILES.map((file) => [file, Buffer.from(historical.buffers[file])]),
    );
    const captureHashesBefore = JSON.stringify(evidence.captures[candidate.id].capture.sourceHashes);
    const evidenceBefore = JSON.stringify(evidence);
    const snapshotBefore = Object.fromEntries(
      Object.entries(sourceSnapshot).map(([file, bytes]) => [file, Buffer.from(bytes)]),
    );

    const result = await verifyProductionHistoricalEvidence({ evidence, beforeSourceHashes, sourceSnapshot });

    assert.deepEqual(Object.keys(result).sort(), ["assessmentBinding", "historicalResult", "originResult"]);
    assert.equal(Object.hasOwn(result, "status"), false, "组合结果不能合成总 PASS 状态");
    assert.deepEqual(result.originResult, { status: "pass", errors: [], gaps: [] });
    assert.equal(result.historicalResult.status, "incomplete", "S0 小夹具仍缺完整矩阵或当前配方出处");
    assert.deepEqual(result.assessmentBinding, {
      status: "pass",
      recordedHash: container.assessmentHash,
      reconstructedHash: container.assessmentHash,
    });
    assert.equal(JSON.stringify(evidence.captures[candidate.id].capture.sourceHashes), captureHashesBefore);
    assert.equal(JSON.stringify(evidence), evidenceBefore);
    assert.deepEqual(beforeSourceHashes, historical.hashes);
    for (const file of HISTORICAL_SOURCE_FILES) assert.deepEqual(sourceSnapshot[file], snapshotBefore[file]);
  } finally {
    box.cleanup();
  }
});

test("D8s4：旧22项来源摘要缺少 timeline-utils.js 时保持 incomplete，不自动补写", async () => {
  const box = await createSandbox();
  try {
    const timelineFile = "public/timeline-utils.js";
    const candidate = makeCandidate({});
    const set = makeCandidateSet([candidate]);
    const historical = makeHistoricalSourceSet("D8s4-legacy-22-source");
    const oldHashes = { ...historical.hashes };
    delete oldHashes[timelineFile];
    assert.equal(Object.keys(oldHashes).length, SOURCE_FILES.length - 1);

    const assessment = realAssessment(candidate, set, null, oldHashes);
    const { evidence } = await buildRun(box, "run-d8s4-legacy-source", [candidate], {
      groups: ["S0"],
      assessments: [assessment],
      captureOptions: () => ({
        tweakCapture: (capture) => {
          capture.sourceHashes = { ...oldHashes };
        },
        tweakProgress: (progress) => {
          progress.digests.sourceHashes = { ...oldHashes };
        },
      }),
    });
    const recordedBefore = JSON.stringify(evidence.captures[candidate.id].capture.sourceHashes);

    const result = await verifyProductionHistoricalEvidence({
      evidence,
      beforeSourceHashes: historical.hashes,
      sourceSnapshot: historical.buffers,
    });

    assert.equal(result.originResult.status, "incomplete");
    assert.deepEqual(
      result.originResult.gaps.map(({ code, candidateId, path: sourcePath }) => [code, candidateId, sourcePath]),
      [["origin-source-hash-missing", candidate.id, timelineFile]],
    );
    assert.equal(result.historicalResult.status, "incomplete");
    assert.ok(
      findGap(result.historicalResult, "source-digest-missing").some((gap) => gap.detail.includes(timelineFile)),
    );
    assert.equal(JSON.stringify(evidence.captures[candidate.id].capture.sourceHashes), recordedBefore);
    assert.equal(Object.hasOwn(evidence.captures[candidate.id].capture.sourceHashes, timelineFile), false);
  } finally {
    box.cleanup();
  }
});

test("D5b：错误的三文件历史快照保留来源 PASS 与历史缺件，重建摘要不同即 rejected", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const set = makeCandidateSet([candidate]);
    const historical = makeHistoricalSourceSet("D5b-wrong-snapshot");
    const originalAssessment = realAssessment(candidate, set, null, historical.hashes);
    const { container, evidence } = await buildRun(box, "run-d5b-wrong-snapshot", [candidate], {
      groups: ["S0"],
      assessments: [originalAssessment],
      captureOptions: () => ({
        tweakCapture: (capture) => {
          capture.sourceHashes = { ...historical.hashes };
        },
        tweakProgress: (progress) => {
          progress.digests.sourceHashes = { ...historical.hashes };
        },
      }),
    });
    const wrongSnapshot = Object.fromEntries(
      HISTORICAL_SOURCE_FILES.map((file) => [file, Buffer.from(historical.buffers[file])]),
    );
    wrongSnapshot["public/skin-picker.js"][0] ^= 1;

    const result = await verifyProductionHistoricalEvidence({
      evidence,
      beforeSourceHashes: historical.hashes,
      sourceSnapshot: wrongSnapshot,
    });

    assert.equal(result.originResult.status, "pass");
    assert.equal(result.historicalResult.status, "incomplete");
    assert.ok(
      findGap(result.historicalResult, "source-digest-mismatch").some((gap) =>
        gap.detail.includes("public/skin-picker.js"),
      ),
    );
    assert.equal(result.assessmentBinding.status, "rejected");
    assert.equal(result.assessmentBinding.recordedHash, container.assessmentHash);
    assert.notEqual(result.assessmentBinding.reconstructedHash, container.assessmentHash);
  } finally {
    box.cleanup();
  }
});

test("D5b：第二候选的其它旧源码漂移同时留下来源与历史诊断", async () => {
  const box = await createSandbox();
  try {
    const first = makeCandidate({ skinId: "chatgpt" });
    const second = makeCandidate({ skinId: "claude" });
    const set = makeCandidateSet([first, second]);
    const historical = makeHistoricalSourceSet("D5b-two-candidates");
    const otherOldAppHash = sha256(Buffer.from("D5b second-candidate old app.js"));
    const secondHistoryHashes = { ...historical.hashes, "public/app.js": otherOldAppHash };
    const sourceHashesByCandidate = new Map([
      [first.id, { ...historical.hashes }],
      [second.id, { ...historical.hashes, "public/app.js": otherOldAppHash }],
    ]);
    const { evidence } = await buildRun(box, "run-d5b-two-candidates", [first, second], {
      groups: ["S0"],
      assessments: [
        realAssessment(first, set, null, historical.hashes),
        realAssessment(second, set, null, secondHistoryHashes),
      ],
      captureOptions: (candidate) => ({
        tweakCapture: (capture) => {
          capture.sourceHashes = { ...sourceHashesByCandidate.get(candidate.id) };
        },
        tweakProgress: (progress) => {
          progress.digests.sourceHashes = { ...sourceHashesByCandidate.get(candidate.id) };
        },
      }),
    });

    const result = await verifyProductionHistoricalEvidence({
      evidence,
      beforeSourceHashes: historical.hashes,
      sourceSnapshot: historical.buffers,
    });

    assert.equal(result.originResult.status, "rejected");
    assert.ok(
      result.originResult.errors.some(
        (error) =>
          error.code === "origin-source-hash-mismatch" &&
          error.candidateId === second.id &&
          error.path === "public/app.js",
      ),
    );
    assert.equal(result.historicalResult.status, "incomplete");
    assert.ok(
      findGap(result.historicalResult, "source-digest-mismatch").some(
        (gap) => gap.candidateId === second.id && gap.detail.includes("public/app.js"),
      ),
    );
  } finally {
    box.cleanup();
  }
});

test("D5b：历史结论 rejected 时摘要相等也不改写历史状态", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const set = makeCandidateSet([candidate]);
    const historical = makeHistoricalSourceSet("D5b-rejected");
    const failedChecks = matrixRecords(candidate).map((record, index) =>
      index === 0 ? { ...record, result: "fail", ratio: record.threshold * 0.5 } : record,
    );
    const rejectedAssessment = realAssessment(candidate, set, failedChecks, historical.hashes);
    assert.equal(rejectedAssessment.readiness, "rejected");
    const { container, evidence } = await buildRun(box, "run-d5b-rejected", [candidate], {
      groups: ["S0"],
      assessments: [rejectedAssessment],
      captureOptions: () => ({
        tweakCapture: (capture) => {
          capture.sourceHashes = { ...historical.hashes };
        },
        tweakProgress: (progress) => {
          progress.digests.sourceHashes = { ...historical.hashes };
        },
      }),
    });

    const result = await verifyProductionHistoricalEvidence({
      evidence,
      beforeSourceHashes: historical.hashes,
      sourceSnapshot: historical.buffers,
    });

    assert.equal(result.originResult.status, "pass");
    assert.equal(result.historicalResult.status, "rejected");
    assert.equal(result.assessmentBinding.status, "pass");
    assert.equal(result.assessmentBinding.recordedHash, container.assessmentHash);
    assert.equal(result.assessmentBinding.reconstructedHash, container.assessmentHash);
  } finally {
    box.cleanup();
  }
});

test("D5b：缺原容器或缺历史快照时绑定 incomplete，不能回退当前源码", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const historical = makeHistoricalSourceSet("D5b-missing-inputs");
    const noContainer = await buildRun(box, "run-d5b-no-container", [candidate], {
      groups: ["S0"],
      assessments: null,
      withVisualReview: false,
    });
    const missingContainerResult = await verifyProductionHistoricalEvidence({
      evidence: noContainer.evidence,
      beforeSourceHashes: REAL_SOURCE_HASHES,
      sourceSnapshot: historical.buffers,
    });
    assert.equal(missingContainerResult.historicalResult.status, "incomplete");
    assert.equal(missingContainerResult.assessmentBinding.status, "incomplete");
    assert.equal(missingContainerResult.assessmentBinding.recordedHash, null);

    const withContainer = await buildRun(box, "run-d5b-no-snapshot", [candidate], { groups: ["S0"] });
    await assert.rejects(
      verifyProductionHistoricalEvidence({ evidence: withContainer.evidence, beforeSourceHashes: {} }),
      TypeError,
      "source-origin contract errors pass through unchanged",
    );

    const captureRecord = withContainer.evidence.captures[candidate.id];
    const incompleteSourceHashes = { ...captureRecord.capture.sourceHashes };
    delete incompleteSourceHashes["public/app.js"];
    const incompleteEvidence = {
      ...withContainer.evidence,
      captures: {
        ...withContainer.evidence.captures,
        [candidate.id]: {
          ...captureRecord,
          capture: { ...captureRecord.capture, sourceHashes: incompleteSourceHashes },
        },
      },
    };
    const incompleteOriginResult = await verifyProductionHistoricalEvidence({
      evidence: incompleteEvidence,
      beforeSourceHashes: REAL_SOURCE_HASHES,
      sourceSnapshot: historical.buffers,
    });
    assert.equal(incompleteOriginResult.originResult.status, "incomplete");
    assert.equal(incompleteOriginResult.historicalResult.sourceContext, "historical");
    assert.ok(["incomplete", "rejected"].includes(incompleteOriginResult.historicalResult.status));

    for (const input of [{}, { sourceSnapshot: undefined }]) {
      const result = await verifyProductionHistoricalEvidence({
        evidence: withContainer.evidence,
        beforeSourceHashes: REAL_SOURCE_HASHES,
        ...input,
      });
      assert.equal(result.originResult.status, "pass");
      assert.equal(result.historicalResult.status, "invalid");
      assert.equal(result.historicalResult.sourceContext, "historical");
      assert.equal(result.historicalResult.errors[0].code, "INVALID_INPUT");
      assert.equal(result.assessmentBinding.status, "incomplete");
      assert.equal(result.assessmentBinding.recordedHash, withContainer.container.assessmentHash);
      assert.equal(result.assessmentBinding.reconstructedHash, null);
    }
  } finally {
    box.cleanup();
  }
});

test("缺摘要单独报告：登记缺 app.js 与 timeline-utils.js → source-digest-missing（与不一致区分）", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const { evidence } = await buildRun(box, "run", [candidate], {
      groups: ["S0"],
      captureOptions: () => ({
        tweakCapture: (capture) => {
          delete capture.sourceHashes["public/app.js"];
          delete capture.sourceHashes["public/timeline-utils.js"];
        },
      }),
    });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    const missing = findGap(result, "source-digest-missing");
    assert.equal(missing.length, 1, "缺摘要单独成类");
    assert.ok(missing[0].detail.includes("缺摘要"));
    assert.ok(missing[0].detail.includes("public/app.js"));
    assert.ok(missing[0].detail.includes("public/timeline-utils.js"));
    assert.equal(findGap(result, "source-digest-mismatch").length, 0, "没有登记的文件不按不一致报告");
  } finally {
    box.cleanup();
  }
});

test("捕获独有依赖缺摘要也阻断：只登记新门禁 18 项、漏掉 capture 独有依赖不行（复核第 5 项）", async () => {
  const box = await createSandbox();
  try {
    assert.ok(
      SOURCE_FILES.includes("public/i18n.js") && !REQUIRED_SOURCE_FILES.includes("public/i18n.js"),
      "public/i18n.js 属捕获链路依赖、不在 M3.4 门禁 18 项内——正是会漏的键",
    );
    const candidate = makeCandidate({});
    const { evidence } = await buildRun(box, "run", [candidate], {
      groups: ["S0"],
      captureOptions: () => ({
        tweakCapture: (capture) => {
          delete capture.sourceHashes["public/i18n.js"];
        },
      }),
    });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    const missing = findGap(result, "source-digest-missing");
    assert.equal(missing.length, 1);
    assert.ok(missing[0].detail.includes("public/i18n.js"), "漏报的捕获独有依赖必须点名");
    assert.equal(missing[0].blocking, true);
  } finally {
    box.cleanup();
  }
});

test("登记完全没有 sourceHashes → source-digests-missing", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const { evidence } = await buildRun(box, "run", [candidate], {
      groups: ["S0"],
      captureOptions: () => ({
        tweakCapture: (capture) => {
          delete capture.sourceHashes;
        },
      }),
    });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    assert.equal(findGap(result, "source-digests-missing").length, 1);
  } finally {
    box.cleanup();
  }
});

test("派生口径漂移：候选派生自旧版 public/skins.js → derivation-drift 阻断（复核第 6 项）", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({ derivationHash: "b".repeat(64) });
    const { evidence } = await buildRun(box, "run", [candidate], { groups: ["S0"] });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    const drift = findGap(result, "derivation-drift");
    assert.equal(drift.length, 1);
    assert.equal(drift[0].candidateId, candidate.id);
    assert.equal(drift[0].blocking, true);
    assert.ok(drift[0].detail.includes("public/skins.js"));
  } finally {
    box.cleanup();
  }
});

test("无视觉意见不通过：visual-review.json 缺失 → 重算退为 incomplete", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const { container, evidence } = await buildRun(box, "run", [candidate], {
      groups: ["S0"],
      withVisualReview: false,
    });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    assert.ok(findGap(result, "visual-review-missing").length >= 1, ".1 缺项照单全收");
    assert.equal(findGap(result, "readiness-changed").length, 1, "落盘 ready 重算退步也要点名");
    assert.notEqual(result.verifiedModel.container.assessmentHash, container.assessmentHash);
    assert.deepEqual(result.verifiedModel.selectableCandidateIds, []);
  } finally {
    box.cleanup();
  }
});

test("捕获失败与单侧不可达都是配对破坏", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const failed = await buildRun(box, "run-failed", [candidate], {
      groups: ["S0", "S1"],
      captureOptions: () => ({
        skipUnits: ["light/preset-selected"],
        tweakProgress: (progress) => {
          progress.units["light/preset-selected"] = { status: "failed", blockers: ["触发步骤失败"], attempts: 2 };
        },
      }),
    });
    const failedResult = await verifyReviewEvidence({ evidence: failed.evidence });
    assert.equal(failedResult.status, "incomplete");
    assert.equal(findGap(failedResult, "capture-unit-failed").length, 1);
    assert.ok(
      !failedResult.verifiedModel.images.assets.some(
        (asset) => asset.relativePath === "light/states/preset-selected/state.png",
      ),
      "failed 单元没有假造 state.png",
    );

    const asymmetric = await buildRun(box, "run-asymmetric", [candidate], {
      groups: ["S0", "S1"],
      captureOptions: () => ({
        skipUnits: ["light/preset-selected"],
        tweakProgress: (progress) => {
          progress.units["light/preset-selected"] = { status: "unreachable", reason: "只有浅色不可达？" };
        },
      }),
    });
    const asymmetricResult = await verifyReviewEvidence({ evidence: asymmetric.evidence });
    assert.equal(asymmetricResult.status, "incomplete");
    assert.equal(findGap(asymmetricResult, "capture-pairing-mismatch").length, 1);
  } finally {
    box.cleanup();
  }
});

test("双侧不可达豁免只限 precondition 预案：quota-toast 非阻断，preset-selected 阻断（复核第 2 项）", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});

    // 已知限制：quota-toast 带 precondition 预案、两侧一致不可达 → 非阻断缺件，
    // 除当前配方通道外无其它阻断（尽可能收敛到 pass 附近的形态）。
    const unreachable = await buildRun(box, "run-unreachable", [candidate], {
      captureOptions: () => ({
        skipUnits: ["light/quota-toast", "dark/quota-toast"],
        tweakProgress: (progress) => {
          progress.units["light/quota-toast"] = { status: "unreachable", reason: "限额开关恒 disabled" };
          progress.units["dark/quota-toast"] = { status: "unreachable", reason: "限额开关恒 disabled" };
        },
      }),
    });
    const unreachableResult = await verifyReviewEvidence({ evidence: unreachable.evidence });
    assert.equal(unreachableResult.status, "incomplete", "pass 通道在当前配方出处通道补上之前不可达");
    assert.deepEqual(
      blockingCodes(unreachableResult),
      ["current-profiles-unverifiable"],
      "已知不可达不新增阻断——除配方通道外没有其它阻断缺件",
    );
    const unreachableGaps = findGap(unreachableResult, "capture-unit-unreachable");
    assert.equal(unreachableGaps.length, 1);
    assert.equal(unreachableGaps[0].blocking, false, "precondition 预案的已知不可达是可见缺件，不是阻断");

    // 正常可触发的状态双侧标 unreachable：已知限制的豁免不能套上去 → 阻断。
    const preset = await buildRun(box, "run-preset", [candidate], {
      captureOptions: () => ({
        skipUnits: ["light/preset-selected", "dark/preset-selected"],
        tweakProgress: (progress) => {
          progress.units["light/preset-selected"] = { status: "unreachable", reason: "谎报不可达" };
          progress.units["dark/preset-selected"] = { status: "unreachable", reason: "谎报不可达" };
        },
      }),
    });
    const presetResult = await verifyReviewEvidence({ evidence: preset.evidence });
    assert.equal(presetResult.status, "incomplete");
    const presetGaps = findGap(presetResult, "capture-unit-unreachable");
    assert.equal(presetGaps.length, 1);
    assert.equal(presetGaps[0].blocking, true, "无预案状态双侧不可达必须阻断");
    assert.ok(presetGaps[0].detail.includes("precondition"), "缺件明细写明豁免边界");
  } finally {
    box.cleanup();
  }
});

test("S1 状态单元证据树逐文件核验：evidenceHash 对不上即不通过", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const { evidence } = await buildRun(box, "run", [candidate], {
      groups: ["S0", "S1"],
      captureOptions: () => ({}),
    });
    // 篡改一个状态单元的 geometry.json（在 .1 加载之后）：证据树哈希必然失配。
    const geometryPath = path.join(
      evidence.captures[candidate.id].dir,
      "light",
      "states",
      "preset-selected",
      "geometry.json",
    );
    const geometry = JSON.parse(await readFile(geometryPath, "utf8"));
    geometry.skinId = "claude";
    await writeFile(geometryPath, `${JSON.stringify(geometry)}\n`, "utf8");
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    const invalid = findGap(result, "capture-unit-evidence-invalid");
    assert.ok(invalid.length >= 1);
    assert.ok(invalid.some((gap) => gap.detail.includes("preset-selected")));
  } finally {
    box.cleanup();
  }
});

test("已核图片被替换或删除：候选阻断且不输出对应旧 dataUrl", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({ skinId: "chatgpt", variant: "a" });
    const { evidence } = await buildRun(box, "run-image-tamper", [candidate], {
      origins: { currentProfiles: true },
    });
    const before = await verifyReviewEvidence({ evidence });
    assert.equal(before.status, "pass");
    assert.deepEqual(before.verifiedModel.selectableCandidateIds, [candidate.id]);

    const captureDir = evidence.captures[candidate.id].dir;
    await writeFile(path.join(captureDir, "light", "baseline.png"), Buffer.concat([PNG_BYTES, Buffer.from([1])]));
    await rm(path.join(captureDir, "dark", "states", "preset-selected", "state.png"));

    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    assert.deepEqual(result.verifiedModel.selectableCandidateIds, []);
    assert.ok(findGap(result, "baseline-file-mismatch").some((gap) => gap.candidateId === candidate.id));
    assert.ok(
      findGap(result, "capture-unit-evidence-invalid").some(
        (gap) => gap.candidateId === candidate.id && gap.detail.includes("preset-selected"),
      ),
    );
    assert.ok(
      !result.verifiedModel.images.assets.some((asset) => asset.relativePath === "light/baseline.png"),
      "被替换的基线图不输出 dataUrl",
    );
    assert.ok(
      !result.verifiedModel.images.assets.some(
        (asset) => asset.relativePath === "dark/states/preset-selected/state.png",
      ),
      "被删除的状态图不输出 dataUrl",
    );
    assert.ok(result.verifiedModel.images.assets.length > 0, "保留其它已核原图供 incomplete 诊断");
  } finally {
    box.cleanup();
  }
});

test("S0 附件清单：内部摘要不一致 / 文件字节被换 / 清单缺失分别报告", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const tampered = await buildRun(box, "run-manifest", [candidate], {
      groups: ["S0"],
      captureOptions: () => ({
        tweakProgress: (progress) => {
          progress.units["light/baseline"].baselineEvidence.files[0].sha256 = "0".repeat(64);
        },
      }),
    });
    const tamperedResult = await verifyReviewEvidence({ evidence: tampered.evidence });
    assert.equal(tamperedResult.status, "incomplete");
    assert.equal(findGap(tamperedResult, "baseline-manifest-mismatch").length, 1);

    const swapped = await buildRun(box, "run-swapped", [candidate], { groups: ["S0"] });
    const colorsPath = path.join(swapped.evidence.captures[candidate.id].dir, "light", "colors.json");
    await writeFile(colorsPath, `${JSON.stringify({ mode: "light", skinId: "claude" })}\n`, "utf8");
    const swappedResult = await verifyReviewEvidence({ evidence: swapped.evidence });
    assert.equal(swappedResult.status, "incomplete");
    assert.equal(findGap(swappedResult, "baseline-file-mismatch").length, 1);

    const absent = await buildRun(box, "run-absent", [candidate], {
      groups: ["S0"],
      captureOptions: () => ({
        tweakProgress: (progress) => {
          delete progress.units["light/baseline"].baselineEvidence;
        },
      }),
    });
    const absentResult = await verifyReviewEvidence({ evidence: absent.evidence });
    assert.equal(absentResult.status, "incomplete");
    assert.equal(findGap(absentResult, "baseline-manifest-missing").length, 1);
    assert.ok(absentResult.gaps.some((gap) => gap.detail.includes("缺摘要")));
  } finally {
    box.cleanup();
  }
});

test("S0 清单完整性：删 layout.json 重算清单哈希仍拦下；一致性结论为假（自洽摘要）也拦下（复核第 4 项）", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});

    // 从清单删 layout.json 并重算清单哈希：摘要自洽，但固定附件集合不完整。
    const missingLayout = await buildRun(box, "run-layout", [candidate], {
      groups: ["S0"],
      captureOptions: () => ({
        tweakProgress: (progress) => {
          const manifest = progress.units["light/baseline"].baselineEvidence;
          manifest.files = manifest.files.filter((entry) => entry.file !== "layout.json");
          manifest.sha256 = sha256Canonical(manifest.files);
        },
      }),
    });
    const missingLayoutResult = await verifyReviewEvidence({ evidence: missingLayout.evidence });
    assert.equal(missingLayoutResult.status, "incomplete");
    const layoutGaps = findGap(missingLayoutResult, "baseline-manifest-mismatch");
    assert.equal(layoutGaps.length, 1);
    assert.ok(layoutGaps[0].detail.includes("layout.json"), "点名缺失的固定附件");
    assert.ok(layoutGaps[0].detail.includes("不一致") || layoutGaps[0].detail.includes("缺"), "按集合不一致报告");

    // born-consistent：colors.json 一致性结论改假、清单摘要按改后字节重算——
    // 只验自洽就会放行，必须核 JSON 里的结论本身。
    const falseFlags = await buildRun(box, "run-flags", [candidate], {
      groups: ["S0"],
      captureOptions: () => ({
        baselineJsonPatch: {
          "colors.json": (json) => ({ ...json, runtimeMatchesExpected: false }),
        },
      }),
    });
    const falseFlagsResult = await verifyReviewEvidence({ evidence: falseFlags.evidence });
    assert.equal(falseFlagsResult.status, "incomplete");
    const flagGaps = findGap(falseFlagsResult, "baseline-json-mismatch");
    assert.equal(flagGaps.length, 2, "jsonPatch 按文件名应用到两模式 → 两模式各报一条");
    assert.ok(flagGaps.some((gap) => gap.detail.includes("light/baseline")));
    assert.ok(flagGaps.every((gap) => gap.detail.includes("colors.json")));
    assert.ok(flagGaps.every((gap) => gap.blocking));
  } finally {
    box.cleanup();
  }
});

test("落盘 fail 被旧评审掩盖：checks.json 判据 fail 而原评审全 pass → capture-checks-mismatch（复核第 3 项）", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const { evidence } = await buildRun(box, "run", [candidate], {
      groups: ["S0", "S1"],
      captureOptions: () => ({
        // born-consistent 篡改：该单元落盘判据改成 fail（证据树哈希按改后重算，
        // progress 摘要自洽）——单靠文件完整性核验是查不出的。
        recordOverrides: {
          "light/preset-selected": (records) =>
            records.map((record) =>
              record.result === "pass" ? { ...record, result: "fail", ratio: record.threshold * 0.5 } : record,
            ),
        },
      }),
    });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    const mismatches = findGap(result, "capture-checks-mismatch");
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].candidateId, candidate.id);
    assert.equal(mismatches[0].blocking, true);
    assert.ok(mismatches[0].detail.includes("light|preset-selected"), "点名状态键");
    assert.ok(mismatches[0].detail.includes("未被原评审反映"), "指明掩盖方向");
  } finally {
    box.cleanup();
  }
});

test("S5 双视图判据参与核验：timeline 变体里的 fail 同步全部摘要也拦下（复核第二轮第 2 项）", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const { evidence } = await buildRun(box, "run", [candidate], {
      groups: ["S5"],
      captureOptions: () => ({
        // born-consistent 变体篡改：只改 model 视图的判据并同步证据树哈希——
        // 变体是切换视图后分别测量的结果，不是主判据的重复，漏掉就是漏报。
        variantRecordOverrides: {
          "light/dense-data/model": (records) =>
            records.map((record) =>
              record.result === "pass" ? { ...record, result: "fail", ratio: record.threshold * 0.5 } : record,
            ),
        },
      }),
    });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    const mismatches = findGap(result, "capture-checks-mismatch");
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].candidateId, candidate.id);
    assert.equal(mismatches[0].blocking, true);
    assert.ok(mismatches[0].detail.includes("light|dense-data"), "点名状态键");
    assert.ok(mismatches[0].detail.includes("未被原评审反映"), "指明掩盖方向");
  } finally {
    box.cleanup();
  }
});

test("原评审测量记录没有落盘判据支撑：assessment 多出的记录 → capture-checks-mismatch（复核第 3 项反向）", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const set = makeCandidateSet([candidate]);
    const role = ROLE_BY_ID.get("button.secondary");
    const extraRecord = {
      candidateId: candidate.id,
      mode: "light",
      roleId: "button.secondary",
      stateId: "preset-selected",
      result: "pass",
      ratio: role.threshold * 1.5,
      threshold: role.threshold,
      method: "browser-text-pixels",
      evidence: "{}",
      reason: "",
    };
    const { evidence } = await buildRun(box, "run", [candidate], {
      groups: ["S0", "S1"],
      assessments: [realAssessment(candidate, set, [...matrixRecords(candidate), extraRecord])],
    });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    const mismatches = findGap(result, "capture-checks-mismatch");
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].blocking, true);
    assert.ok(mismatches[0].detail.includes("light|preset-selected"), "点名状态键");
    assert.ok(mismatches[0].detail.includes("没有落盘判据支撑"), "指明无支撑方向");
  } finally {
    box.cleanup();
  }
});

test("载入后磁盘被改：capture.json 字节漂移必须重新加载，核验不绑过期字节", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const { evidence } = await buildRun(box, "run", [candidate], { groups: ["S0"] });
    const capturePath = path.join(evidence.captures[candidate.id].dir, "capture.json");
    const capture = JSON.parse(await readFile(capturePath, "utf8"));
    capture.environment = { node: "drifted" };
    await writeFile(capturePath, `${JSON.stringify(capture)}\n`, "utf8");
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    assert.equal(findGap(result, "origin-file-changed").length, 1);
  } finally {
    box.cleanup();
  }
});

test("M3.4 复核抛错（阈值造假记录）→ invalid，verifiedModel=null", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const set = makeCandidateSet([candidate]);
    const honest = realAssessment(candidate, set);
    // 形状合法（M0 不核阈值正确性）但 assertRecordsConform 会拒绝的记录。
    const forged = {
      ...honest,
      browser: [
        ...honest.browser,
        {
          candidateId: candidate.id,
          mode: "light",
          roleId: "button.secondary",
          stateId: "dashboard-default",
          result: "pass",
          ratio: 99,
          threshold: 999,
          method: "browser-text-pixels",
          evidence: "{}",
          reason: "",
        },
      ],
    };
    const { evidence } = await buildRun(box, "run", [candidate], {
      groups: ["S0"],
      assessments: [forged],
    });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "invalid");
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].code, "REASSESSMENT_FAILED");
    assert.equal(result.errors[0].candidateId, candidate.id);
    assert.equal(result.verifiedModel, null);
  } finally {
    box.cleanup();
  }
});

test("progress 摘要绑定造假 → PROGRESS_IDENTITY_MISMATCH → invalid", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const { evidence } = await buildRun(box, "run", [candidate], {
      groups: ["S0"],
      captureOptions: () => ({
        tweakProgress: (progress) => {
          progress.digests.candidateHash = "f".repeat(64);
        },
      }),
    });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "invalid");
    assert.equal(result.errors[0].code, "PROGRESS_IDENTITY_MISMATCH");
    assert.equal(result.verifiedModel, null);
  } finally {
    box.cleanup();
  }
});

test("跨批出处：原批次上下文复核忠实；原批次 candidates.json 被改 → ORIGIN_DIGEST_MISMATCH", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const set = makeCandidateSet([candidate]);
    const batchDir = await box.makeRun("batchA");
    const reviewDir = await box.makeRun("review");
    await writeCandidates(batchDir, set);
    await writeCandidates(reviewDir, set);
    await writeMatrixCapture(batchDir, `captures/${candidate.id}`, candidate, { groups: ["S0"] });
    await writeIndex(reviewDir, { [candidate.id]: `../batchA/captures/${candidate.id}` });
    const candidatesBytes = await readFile(path.join(batchDir, "candidates.json"));
    const captureBytes = await readFile(path.join(batchDir, "captures", candidate.id, "capture.json"));
    const progressBytes = await readFile(path.join(batchDir, "captures", candidate.id, "progress.json"));
    await writeJson(path.join(reviewDir, "assessment-origins.json"), {
      schemaVersion: 1,
      origins: {
        [candidate.id]: {
          batchRun: "../batchA",
          capture: `../batchA/captures/${candidate.id}`,
          visualReview: null,
          hashes: {
            candidates: sha256(candidatesBytes),
            capture: sha256(captureBytes),
            progress: sha256(progressBytes),
            visualReview: null,
          },
        },
      },
    });
    const container = buildReviewContainer({
      candidateSetHash: set.candidateSetHash,
      assessments: [realAssessment(candidate, set)],
    });
    await writeAssessments(reviewDir, container);
    await writeJson(path.join(reviewDir, "visual-review.json"), {
      schemaVersion: 1,
      reviews: { [candidate.id]: visualAccept() },
    });
    const evidence = await load(box, reviewDir, path.join(reviewDir, "captures-index.json"));
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete", "跨批重建同样忠实，但当前配方通道缺失仍阻断");
    assert.deepEqual(
      blockingCodes(result),
      ["current-profiles-unverifiable", "capture-groups-partial"],
      "除配方通道外只有局部组缺件（S0 样本）",
    );
    assert.equal(result.verifiedModel.origins[candidate.id].batchRun, "../batchA");
    assert.equal(result.verifiedModel.container.assessmentHash, container.assessmentHash, "跨批重建同样忠实");

    // 原批次总集被改写：登记摘要钉住的是改写前字节，重读即失配。
    const mutated = { ...set, candidates: [{ ...candidate, derivationHash: "a".repeat(64) }] };
    await writeFile(path.join(batchDir, "candidates.json"), canonicalFileContent(mutated), "utf8");
    const tampered = await verifyReviewEvidence({ evidence });
    assert.equal(tampered.status, "invalid");
    assert.equal(tampered.errors[0].code, "ORIGIN_DIGEST_MISMATCH");
  } finally {
    box.cleanup();
  }
});

test("requireSelections：十套选择绑定两个总摘要；错哈希 .1 即拒；复核退步时选择过期", async () => {
  const box = await createSandbox();
  try {
    const candidates = SKIN_IDS.map((skinId) => makeCandidate({ skinId, variant: "a" }));
    const makeSelections = (candidateSetHash, assessmentHash) => ({
      schemaVersion: 1,
      candidateSetHash,
      assessmentHash,
      choices: Object.fromEntries(
        candidates.map((candidate) => [
          candidate.skinId,
          { candidateId: candidate.id, candidateHash: candidate.candidateHash },
        ]),
      ),
      decisionSource: "用户消息 2026-10-06：十套按代理初筛顺序确认",
      recordedAt: "2026-10-06T00:00:00.000Z",
    });

    // 通过：选择绑定候选集哈希 + 原评审容器哈希（复核不改变结论时两个哈希一致）。
    // 状态受当前配方通道与局部组缺件影响为 incomplete，但两个绑定必须成立。
    const good = await buildRun(box, "run-good", candidates, {
      groups: ["S0"],
      selections: null,
    });
    const goodRecord = makeSelections(good.set.candidateSetHash, good.container.assessmentHash);
    await writeJson(path.join(good.runDir, "selections.json"), goodRecord);
    const goodEvidence = await load(box, good.runDir, path.join(good.runDir, "captures-index.json"));
    const goodResult = await verifyReviewEvidence({ evidence: goodEvidence, requireSelections: true });
    assert.equal(goodResult.verifiedModel.selections.binding.candidateSetHash, true);
    assert.equal(goodResult.verifiedModel.selections.binding.assessmentHash, true);
    assert.ok(findGap(goodResult, "selections-assessment-hash-stale").length === 0, "复核未改变结论时绑定不判过期");

    // 错哈希：评审容器在场时 .1 载入即拒（选择绑定的评审不是这份）——错误
    // assessmentHash 到不了 .2；无容器场界的 SELECTIONS_HASH_MISMATCH 在
    // "没有评审容器"用例覆盖。
    const bad = await buildRun(box, "run-bad", candidates, { groups: ["S0"], selections: null });
    const badRecord = makeSelections(bad.set.candidateSetHash, "e".repeat(64));
    await writeJson(path.join(bad.runDir, "selections.json"), badRecord);
    await assert.rejects(
      () =>
        loadReviewEvidence({
          runDir: bad.runDir,
          capturesIndexPath: path.join(bad.runDir, "captures-index.json"),
          rootDir: box.sandbox,
        }),
      (error) => {
        assert.ok(error instanceof ReviewEvidenceError);
        assert.equal(error.code, "HASH_MISMATCH");
        return true;
      },
    );

    // 复核退步：登记摘要造假 → 容器哈希变化 → 绑原哈希的选择按过期缺件处理。
    const stale = await buildRun(box, "run-stale", candidates, {
      groups: ["S0"],
      selections: null,
      captureOptions: () => ({
        tweakCapture: (capture) => {
          capture.sourceHashes = Object.fromEntries(
            Object.keys(capture.sourceHashes).map((file) => [file, sha256Canonical({ fake: file })]),
          );
        },
      }),
    });
    const staleRecord = makeSelections(stale.set.candidateSetHash, stale.container.assessmentHash);
    await writeJson(path.join(stale.runDir, "selections.json"), staleRecord);
    const staleEvidence = await load(box, stale.runDir, path.join(stale.runDir, "captures-index.json"));
    const staleResult = await verifyReviewEvidence({ evidence: staleEvidence, requireSelections: true });
    assert.equal(staleResult.status, "incomplete");
    const staleGaps = findGap(staleResult, "selections-assessment-hash-stale");
    assert.equal(staleGaps.length, 1);
    assert.equal(staleGaps[0].blocking, true);
  } finally {
    box.cleanup();
  }
});

test("requireSelections 但没有选择记录 → selections-missing；绑定缺证不要求选择时只提示", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const noSelections = await buildRun(box, "run-nosel", [candidate], { groups: ["S0"] });
    const withSelectionFlag = await verifyReviewEvidence({ evidence: noSelections.evidence, requireSelections: true });
    assert.equal(withSelectionFlag.status, "incomplete");
    assert.equal(findGap(withSelectionFlag, "selections-missing").length, 1);

    // 无评审容器但写了完整十套选择记录：.1 记"绑定无法核验"。不要求选择 →
    // 非阻断提示；要求选择 → assessmentHash 不匹配任何容器，按伪造处理。
    const noReviewCandidates = SKIN_IDS.map((skinId) => makeCandidate({ skinId, variant: "a" }));
    const noReviewSet = makeCandidateSet(noReviewCandidates);
    const selectionsRecord = {
      schemaVersion: 1,
      candidateSetHash: noReviewSet.candidateSetHash,
      assessmentHash: "e".repeat(64),
      choices: Object.fromEntries(
        noReviewCandidates.map((candidate) => [
          candidate.skinId,
          { candidateId: candidate.id, candidateHash: candidate.candidateHash },
        ]),
      ),
      decisionSource: "用户消息 2026-10-06：先选后评",
      recordedAt: "2026-10-06T00:00:00.000Z",
    };
    const noReview = await buildRun(box, "run-noreview", noReviewCandidates, {
      assessments: null,
      captures: false,
      selections: selectionsRecord,
    });
    assert.ok(noReview.evidence.selections.binding.assessmentHash === null, ".1 对无评审容器的绑定核验记 null");
    const unbound = await verifyReviewEvidence({ evidence: noReview.evidence });
    const unboundGap = findGap(unbound, "selections-assessment-hash-unverified");
    assert.equal(unboundGap.length, 1);
    assert.equal(unboundGap[0].blocking, false);
    assert.equal(unbound.status, "incomplete");

    const reloaded = await load(
      box,
      noReview.evidence.run.dir,
      path.join(noReview.evidence.run.dir, "captures-index.json"),
    );
    const forged = await verifyReviewEvidence({ evidence: reloaded, requireSelections: true });
    assert.equal(forged.status, "invalid");
    assert.equal(forged.errors[0].code, "SELECTIONS_HASH_MISMATCH");
  } finally {
    box.cleanup();
  }
});

test("缺捕获与缺评审：.1 缺项照单收、容器回退原评审、禁选", async () => {
  const box = await createSandbox();
  try {
    const first = makeCandidate({ skinId: "chatgpt" });
    const second = makeCandidate({ skinId: "claude" });
    const { evidence } = await buildRun(box, "run", [first, second], { groups: ["S0"], indexIds: [first.id] });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    assert.ok(findGap(result, "capture-missing").some((gap) => gap.candidateId === second.id));
    assert.ok(findGap(result, "origin-missing").some((gap) => gap.candidateId === second.id));
    const containerAssessments = result.verifiedModel.container.assessments;
    assert.equal(containerAssessments.length, 2, "重算优先，缺捕获的候选回退原评审显示");
    assert.deepEqual(result.verifiedModel.selectableCandidateIds, [], "阻断缺件挂在候选上 → 禁选");
  } finally {
    box.cleanup();
  }
});

test("没有评审容器：review-missing + assessment-missing → incomplete，容器为空评审", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const { evidence } = await buildRun(box, "run", [candidate], {
      groups: ["S0"],
      assessments: null,
      withVisualReview: false,
    });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "incomplete");
    assert.ok(findGap(result, "review-missing").length === 1);
    assert.ok(findGap(result, "assessment-missing").some((gap) => gap.candidateId === candidate.id));
    assert.equal(result.verifiedModel.container.assessments.length, 0);
    assert.deepEqual(result.verifiedModel.selectableCandidateIds, []);
  } finally {
    box.cleanup();
  }
});

test("production=true：正式身份最小口径；身份缺失/皮肤非法都 invalid 且 verifiedModel=null", async () => {
  const box = await createSandbox();
  try {
    const base = {
      schemaVersion: 1,
      run: {
        dir: "unused",
        id: "run",
        relativePath: "run",
        candidatesPath: "candidates.json",
        index: { path: "", relativePath: "" },
      },
      candidateSet: { data: null, coverage: null },
      review: { present: false, path: null, container: null, missingCandidateIds: [] },
      visualReview: { present: false, path: null, reviews: null },
      selections: { present: false, path: null, record: null, binding: null },
      captures: {},
      capturesMissing: [],
      origins: { source: "file", path: null, origins: {}, missingCandidateIds: [] },
      gaps: [],
    };
    const good = {
      ...base,
      captures: { chatgpt: { dir: "unused", capture: { candidate: { production: true, skinId: "chatgpt" } } } },
    };
    const goodResult = await verifyReviewEvidence({ evidence: good, production: true });
    assert.equal(goodResult.status, "pass");
    assert.equal(goodResult.verifiedModel.production, true);

    const notProduction = {
      ...base,
      captures: { chatgpt: { dir: "unused", capture: { candidate: { id: "x", candidateHash: "a".repeat(64) } } } },
    };
    const notProductionResult = await verifyReviewEvidence({ evidence: notProduction, production: true });
    assert.equal(notProductionResult.status, "invalid");
    assert.equal(notProductionResult.errors[0].code, "PRODUCTION_IDENTITY");
    assert.equal(notProductionResult.verifiedModel, null, "invalid → verifiedModel=null（复核第 7 项）");

    const badSkin = {
      ...base,
      captures: { chatgpt: { dir: "unused", capture: { candidate: { production: true, skinId: "not-a-skin" } } } },
    };
    const badSkinResult = await verifyReviewEvidence({ evidence: badSkin, production: true });
    assert.equal(badSkinResult.status, "invalid");
    assert.equal(badSkinResult.verifiedModel, null, "invalid → verifiedModel=null（复核第 7 项）");

    const conflict = await verifyReviewEvidence({ evidence: good, production: true, requireSelections: true });
    assert.equal(conflict.status, "invalid");
    assert.equal(conflict.errors[0].code, "INVALID_INPUT");
    assert.equal(conflict.verifiedModel, null);
  } finally {
    box.cleanup();
  }
});

test("参数与形状：非 .1 输出一律 invalid；状态与错误码枚举固定", async () => {
  const box = await createSandbox();
  try {
    assert.deepEqual([...REVIEW_VERIFY_STATUSES], ["pass", "incomplete", "rejected", "invalid"]);
    assert.ok(REVIEW_VERIFY_ERROR_CODES.includes("REASSESSMENT_FAILED"));
    assert.ok(REVIEW_VERIFY_ERROR_CODES.includes("PROFILE_HASH_MISMATCH"));
    for (const evidence of [null, undefined, {}, { schemaVersion: 1 }, { schemaVersion: 2 }]) {
      const result = await verifyReviewEvidence({ evidence });
      assert.equal(result.status, "invalid");
      assert.equal(result.verifiedModel, null);
      assert.equal(result.errors[0].code, "EVIDENCE_SHAPE");
    }
    const candidate = makeCandidate({});
    const { evidence } = await buildRun(box, "run", [candidate], { groups: ["S0"] });
    const missingFlags = await verifyReviewEvidence({ evidence, requireSelections: "yes" });
    assert.equal(missingFlags.status, "invalid");
    assert.equal(missingFlags.errors[0].code, "INVALID_INPUT");
  } finally {
    box.cleanup();
  }
});

test("rejected 判定：重算结论为 rejected 时整体 rejected（保留诊断）", async () => {
  const box = await createSandbox();
  try {
    const candidate = makeCandidate({});
    const set = makeCandidateSet([candidate]);
    const failing = assessCandidate({
      candidate,
      fastChecks: null,
      browserChecks: matrixRecords(candidate).map((record, index) =>
        index === 0 ? { ...record, result: "fail", ratio: record.threshold * 0.5 } : record,
      ),
      visualReview: visualAccept(),
      run: {
        policy: POLICY,
        inputHashes: set.inputHashes,
        recordedInputHashes: { ...set.inputHashes },
        sourceHashes: REAL_SOURCE_HASHES,
        recordedSourceHashes: REAL_SOURCE_HASHES,
        fixture: { version: POLICY.versions.fixture },
        recordedFixture: { version: POLICY.versions.fixture },
        candidateSet: set,
        candidateSetHash: set.candidateSetHash,
      },
    });
    assert.equal(failing.readiness, "rejected");
    const { evidence } = await buildRun(box, "run", [candidate], { groups: ["S0"], assessments: [failing] });
    const result = await verifyReviewEvidence({ evidence });
    assert.equal(result.status, "rejected");
    assert.ok(result.verifiedModel !== null, "rejected 保留显示模型");
    assert.deepEqual(result.verifiedModel.selectableCandidateIds, []);
  } finally {
    box.cleanup();
  }
});
