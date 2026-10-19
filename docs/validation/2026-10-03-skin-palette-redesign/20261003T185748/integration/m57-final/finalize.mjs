import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalFileContent } from "../../../../../../scripts/skin-palette/contracts.mjs";
import { loadReviewEvidence } from "../../../../../../scripts/skin-palette/review-evidence.mjs";
import { verifyReviewEvidence } from "../../../../../../scripts/skin-palette/review-verify.mjs";
import { createSelectionExport } from "../../../../../../scripts/skin-palette/review-selection.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../../../../..");
const run = path.resolve(here, "../..");
const relative = (file) => path.relative(repo, file).split(path.sep).join("/");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = (file, value, exclusive = false) => writeFile(file, canonicalFileContent(value), { flag: exclusive ? "wx" : "w" });
assert.deepEqual(process.argv.slice(2, 3), ["--execute"]);
assert.equal(process.argv.length, 4);
const target = path.resolve(repo, process.argv[3]);
assert.equal(path.dirname(target), here);
assert.match(path.basename(target), /^draft-A-/);

const selected = await json(path.join(run, "batches/m57-aggregate-selected-20261018T205439Z-10707200/selected-inputs.json"));
const map = await json(path.join(here, "visual-evidence-map.json"));
const set = await json(path.join(target, "candidates.json"));
assert.equal(set.candidateSetHash, selected.candidateSetHash);
assert.equal(map.scope.sourceSetHash, set.candidateSetHash);
assert.equal(set.candidates.length, 10);
assert.equal(new Set(set.candidates.map((candidate) => candidate.skinId)).size, 10);

// 已有用户选型与最终 token 的区别说明，不冒充新的盲测或距离评分。
const neighbour = {
  glm: "GLM为近中性蓝灰（浅#E6E8EC、深#151619）；DeepSeek为明显冷蓝（#E2ECFC/#141B26），Muse为冰蓝白/深海蓝（#EBF7FF/#010F18）。强调色接近，区别主要来自表面。",
  gemini: "Gemini偏粉紫（#FFF3FA/#1F161C，浅强调#82459A）；ChatGPT偏蓝薰衣草（#F1EEFC/#18161F，#50578E），不把两者都笼统记成紫色。",
  kimi: "Kimi已按用户选择改为玉绿（#F0FAF3/#0C120E，浅强调#3F6659）；与GLM中性蓝灰、Qwen冰青的表面和强调色方向均不同。",
  qwen: "Qwen为冰青/石油青（#E6F7F9/#0B1719，强调#2E656C/#43CCDE）；Muse为更偏蓝的#EBF7FF/#010F18，Kimi为偏绿的#F0FAF3/#0C120E。",
  grok: "Grok保留暖米金（#F2EADD/#1D170E，强调#5C5942/#CCB93E）；Muse新A改为冰蓝白/深海蓝，已消除用户指出的旧beige重叠。与Claude桃陶底、砖橙强调也可解释区分。",
  muse: "用户已选择新Muse A；浅#EBF7FF/深#010F18与Grok暖米金#F2EADD/#1D170E明确分离。相近蓝系GLM更中性、DeepSeek更灰蓝；强调色仍接近，此项接受表面区别而非声称十款完全不同色相。",
};
const addedReviews = new Set(["chatgpt", "claude", "glm", "gemini", "deepseek", "kimi", "qwen", "muse"]);
const materialReviews = new Set(["chatgpt", "gemini", "kimi", "qwen", "muse"]);
const geometryReviews = { claude: "geometry-visual-1.md", glm: "geometry-visual-1.md", deepseek: "geometry-visual-1.md", kimi: "geometry-visual-2.md", grok: "geometry-visual-2.md" };
const reviews = {};
for (const candidate of set.candidates) {
  const entry = map.skins.find((item) => item.candidateId === candidate.id);
  const input = selected.items.find((item) => item.candidateId === candidate.id);
  assert.ok(entry && input);
  const capture = path.join(run, "batches", input.fullCaptureRun, "captures", candidate.id);
  const sixImages = ["light", "dark"].flatMap((mode) => [
    relative(path.join(capture, mode, "baseline.png")),
    relative(path.join(capture, mode, "states/characters-off/state.png")),
    relative(path.join(capture, mode, "states/characters-100/state.png")),
  ]);
  const reviewPath = path.join(here, `visual-${candidate.skinId}.md`);
  if (addedReviews.has(candidate.skinId)) {
    const text = await readFile(reviewPath, "utf8");
    assert.match(text, /accept/);
  }
  if (geometryReviews[candidate.skinId]) {
    const text = await readFile(path.join(here, geometryReviews[candidate.skinId]), "utf8");
    assert.match(text, /accept/);
    assert.ok(text.includes(candidate.skinId), "几何意见必须明确包含该皮肤");
  }
  const items = entry.items.map((item) => {
    let supported = item.sufficientForSupervisorAcceptance;
    let notes = item.sources.map((source) => `${source.path}：${source.conclusion}`).join("；");
    let screenshots = item.screenshots;
    if (item.id === "character-levels-unobstructed" && addedReviews.has(candidate.skinId) ||
        item.id === "ceramic-relief-consistent" && materialReviews.has(candidate.skinId)) {
      supported = true;
      notes = `${relative(reviewPath)}：独立审阅者实际查看浅深各关闭/50%/100%三图，本项accept；结论限指定图可见范围，未断言屏外或任意状态。`;
      screenshots = sixImages;
    }
    if (item.id === "nearest-neighbour-distinguishable" && neighbour[candidate.skinId]) {
      supported = true;
      notes = `${neighbour[candidate.skinId]} 用户明确选择的出处：${entry.userChoice.path}；本项为主管结合已有实拍及颜色值的区别说明，不是新盲测。`;
      screenshots = [relative(path.join(capture, "light/baseline.png")), relative(path.join(capture, "dark/baseline.png"))];
    }
    if (item.id === "logotype-legible") notes += "；此accept仅接受用户批准的弱浮雕设计例外，不声称字标满足正文对比度。";
    if (item.id === "no-geometry-workaround" && geometryReviews[candidate.skinId]) {
      supported = true;
      notes = `${relative(path.join(here, geometryReviews[candidate.skinId]))}：审阅者实际查看此款浅深baseline，逐图核对PNG与layout/viewport/documentHeight绑定；固定四rect一致且捕获布局源码等于当前冻结源。仅接受当前候选呈现，没有通过几何变更掩盖颜色问题；不证明全部历史或任意状态。`;
      screenshots = [relative(path.join(capture, "light/baseline.png")), relative(path.join(capture, "dark/baseline.png"))];
    }
    assert.ok(supported, `仍无依据的视觉项：${candidate.skinId}/${item.id}`);
    assert.ok(screenshots.length > 0);
    return { id: item.id, verdict: "accept", notes, screenshots };
  });
  assert.equal(items.length, 8);
  reviews[candidate.id] = { reviewer: "M5.7 supervisor / delegated six-image reviews and recorded user choices", by: "proxy", verdict: "accept", items,
    notes: "140图阅读判读、已有初筛、用户字标例外及有限补看汇总；Qwen深色性能副标题/脚注偏弱观察保留，不视为必须改色。", reviewedAt: "2026-10-19" };
}

await writeFile(path.join(target, "raw-assessments.json"), await readFile(path.join(target, "assessments.json")), { flag: "wx" });
await save(path.join(target, "visual-review.json"), { schemaVersion: 1, reviews });
const origins = await json(path.join(target, "assessment-origins.json"));
const visualHash = hash(await readFile(path.join(target, "visual-review.json")));
for (const origin of Object.values(origins.origins)) origin.hashes.visualReview = visualHash;
await save(path.join(target, "assessment-origins.json"), origins);

const focusBatches = { kimi: "m57-kimi-focus-20261018T205557Z-e745a8f1", qwen: "m57-qwen-focus-20261018T200943Z-cbb0f570" };
const registrations = [];
for (const [skinId, batch] of Object.entries(focusBatches)) {
  const input = selected.items.find((item) => item.skinId === skinId);
  const originalChecks = await json(path.join(run, "batches", input.fullCaptureRun, "captures", input.candidateId, "light/states/keyboard-focus/checks.json"));
  const originals = originalChecks.records.filter((record) => record.roleId === "focus.outline");
  assert.equal(originals.length, 1);
  assert.equal(originals[0].result, "unmeasured");
  const prefix = `supplements/${skinId}`;
  for (const file of ["manifest.json", "measurement/measurement.json", "measurement/analysis.json", "measurement/captures.json", "measurement/diagnostics.json", "measurement/probes.json", "measurement/raw/adjacent-focused.png"]) {
    const dest = path.join(target, prefix, file);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, await readFile(path.join(run, "batches", batch, file)), { flag: "wx" });
  }
  registrations.push({ manifestPath: `${prefix}/manifest.json`, manifestSha256: hash(await readFile(path.join(target, prefix, "manifest.json"))), originalRecord: originals[0] });
}
await save(path.join(target, "focus-supplements.json"), { schemaVersion: 1, items: registrations }, true);

const verify = async (requireSelections = false) => verifyReviewEvidence({ evidence: await loadReviewEvidence({ runDir: target, capturesIndexPath: path.join(target, "captures-index.json") }), requireSelections });
const compact = (result) => ({ status: result.status, errors: result.errors, gaps: result.gaps, assessments: result.verifiedModel?.container.assessments.map((assessment) => ({ candidateId: assessment.candidateId, readiness: assessment.readiness, blockers: assessment.diagnostics.gate.blockers })), selectable: result.verifiedModel?.selectableCandidateIds });
let result = await verify();
await save(path.join(target, "verification-before-selections.json"), compact(result), true);
if (result.status !== "invalid") await save(path.join(target, "assessments.json"), result.verifiedModel.container);
assert.equal(result.status, "pass", "正式证据尚未通过，详见verification-before-selections.json；不生成选择");
assert.equal(result.verifiedModel.selectableCandidateIds.length, 10);
const assessmentHash = result.verifiedModel.container.assessmentHash;
result = null;
result = await verify();
assert.equal(result.status, "pass");
assert.equal(result.verifiedModel.container.assessmentHash, assessmentHash, "重读后assessmentHash必须幂等");
const selection = createSelectionExport({ verifiedModel: result.verifiedModel,
  choices: Object.fromEntries(set.candidates.map((candidate) => [candidate.skinId, { candidateId: candidate.id, candidateHash: candidate.candidateHash }])),
  decisionSource: "用户逐款明确选型，见M5-selected-directions.md及各user-choice；含ChatGPT/DeepSeek整套互换、Kimi技术修正版与Muse新A", recordedAt: new Date().toISOString() });
assert.equal(selection.fileName, "selections.json");
await save(path.join(target, "selections.json"), selection.record, true);
result = null;
result = await verify(true);
await save(path.join(target, "verification-with-selections.json"), compact(result), true);
assert.equal(result.status, "pass");
console.log(JSON.stringify({ run: relative(target), status: result.status, candidates: 10, assessmentHash, selections: true, productionChanged: false }));
