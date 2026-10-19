import { ROLE_CATALOG } from "./roles.mjs";

const MODES = ["light", "dark"];
const VERIFIED_MODEL_KIND = "skin-palette-review-verified-model";
const REQUIRED_ROLE_IDS = new Set(ROLE_CATALOG.filter((role) => role.required).map((role) => role.id));

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const safeJson = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");

function assertVerifiedModel(verifiedModel) {
  if (
    !verifiedModel ||
    verifiedModel.kind !== VERIFIED_MODEL_KIND ||
    verifiedModel.schemaVersion !== 1 ||
    !Array.isArray(verifiedModel.candidateSet?.candidates) ||
    !Array.isArray(verifiedModel.container?.assessments) ||
    !Array.isArray(verifiedModel.selectableCandidateIds) ||
    !Array.isArray(verifiedModel.gaps) ||
    !Array.isArray(verifiedModel.images?.assets)
  ) {
    throw new TypeError("renderReviewReport requires a verifiedModel from review verification");
  }
}

function candidateId(candidate) {
  return candidate.id ?? candidate.candidateId;
}

function candidateName(candidate, index) {
  return candidate.name ?? candidate.displayName ?? candidate.label ?? candidateId(candidate) ?? `候选 ${index + 1}`;
}

function formatDiagnostic(value) {
  if (value === undefined || value === null || value === "") return "未提供";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function renderDiagnostics(candidate, assessment) {
  const diagnostics = assessment?.diagnostics;
  const id = candidateId(candidate);
  const nearest = diagnostics?.identity?.nearest?.find((entry) => entry.candidateId === id);
  const material = diagnostics?.material?.find((entry) => entry.candidateId === id);
  const readingEntries = diagnostics?.reading?.entries ?? [];
  const worstRequired = readingEntries
    .filter((entry) => REQUIRED_ROLE_IDS.has(entry.roleId) && typeof entry.headroom === "number")
    .reduce((worst, entry) => (worst === undefined || entry.headroom < worst.headroom ? entry : worst), undefined);
  const preferred = readingEntries
    .filter((entry) => entry.preferredHeadroom !== null && entry.preferredHeadroom !== undefined)
    .map(({ mode, roleId, preferredHeadroom, preferredMet, ratio }) => ({
      mode,
      roleId,
      preferredHeadroom,
      preferredMet,
      ratio,
    }));
  const rows = [
    ["最近邻", nearest],
    ["材质诊断", material],
    ["最差必要对比", worstRequired],
    ["主文字优选余量", preferred?.length ? preferred : undefined],
  ];
  return `<dl class="metrics">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(formatDiagnostic(value))}</dd></div>`).join("")}</dl>`;
}

function renderGaps(gaps) {
  if (!gaps.length) return "<p>无已登记缺件。</p>";
  return `<ul class="gaps">${gaps.map((gap) => `<li><code>${escapeHtml(gap.candidateId ?? "全局")}</code> · <strong>${escapeHtml(gap.code ?? "未提供代码")}</strong>${gap.blocking ? " · 阻断" : " · 非阻断"} — ${escapeHtml(gap.detail ?? "未提供详情")}</li>`).join("")}</ul>`;
}

function renderCandidate({ candidate, assessment, index, gaps, selectable }) {
  const id = candidateId(candidate);
  const skinId = candidate.skinId ?? "未提供皮肤";
  const name = candidateName(candidate, index);
  const reason = selectable
    ? "可选整对候选"
    : gaps.some((gap) => gap.blocking)
      ? `禁选：存在阻断缺件（${
          gaps
            .filter((gap) => gap.blocking)
            .map((gap) => gap.code)
            .filter(Boolean)
            .join("、") || "详情见缺件"
        }）`
      : assessment?.readiness !== "ready"
        ? `禁选：复核 readiness 为 ${assessment?.readiness ?? "未提供"}`
        : "禁选：未列入 selectableCandidateIds";
  const notes = candidate.notes == null ? "" : `<p class="notes">${escapeHtml(candidate.notes)}</p>`;
  const readiness = assessment?.readiness;
  const readinessClass = ["ready", "rejected", "incomplete"].includes(readiness)
    ? `readiness-${readiness}`
    : "readiness-unknown";
  const palette = MODES.map((mode) => {
    const values = candidate.modes?.[mode];
    return `<div><b>${mode === "light" ? "浅色" : "深色"}</b><span>主要背景：${escapeHtml(formatDiagnostic(values?.pageBackground))}</span><span>强调色：${escapeHtml(formatDiagnostic(values?.accent))}</span></div>`;
  }).join("");
  return `<article class="candidate" data-candidate-index="${index}">
  <header><h3>${escapeHtml(name)}</h3><code>${escapeHtml(id ?? "未提供候选 ID")}</code></header>
  ${notes}
  <p class="readiness ${readinessClass}"><b>Readiness：</b>${escapeHtml(readiness ?? "未提供")}</p>
  <p class="selection-state">${escapeHtml(reason)}</p>
  <p class="profile"><b>身份 / 气质：</b>${escapeHtml(formatDiagnostic(candidate.style ?? candidate.profileSnapshot))}</p>
  <div class="palette">${palette}</div>
  ${renderDiagnostics(candidate, assessment)}
  <div class="pair" data-baseline-index="${index}">
    ${MODES.map((mode) => `<figure class="mode"><figcaption>${mode === "light" ? "浅色" : "深色"} · baseline.png</figcaption><div class="baseline-slot" data-mode="${mode}">未加载</div></figure>`).join("")}
  </div>
  <label class="choice"><input type="radio" data-selection-skin="${escapeHtml(skinId)}" data-selection-candidate="${escapeHtml(id ?? "")}" name="skin-choice-${escapeHtml(skinId)}" value="${escapeHtml(id ?? "")}"${selectable ? "" : " disabled"}> 选择此候选的浅深整对</label>
  <details class="diagnostics" data-diagnostics-index="${index}"><summary>诊断、缺件、出处与状态图</summary><div class="diagnostic-content">
    <h4>现有限制记录</h4><h5>阻断项</h5><pre data-blockers>展开后加载</pre><h5>失败</h5><pre data-failures>展开后加载</pre><h5>未测</h5><pre data-unmeasured>展开后加载</pre><h5>缺件</h5>${renderGaps(gaps)}
    <h4>出处摘要</h4><pre data-origin>展开后加载</pre>
    <h4>复核诊断</h4><pre data-diagnostics>展开后加载</pre>
    <div class="state-assets" data-state-index="${index}"></div>
  </div></details>
</article>`;
}

function groupCandidates(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const skinId = entry.candidate.skinId ?? "未提供皮肤";
    if (!groups.has(skinId)) groups.set(skinId, []);
    groups.get(skinId).push(entry);
  }
  return groups;
}

/** Render a self-contained report from the immutable, verified review model. */
export function renderReviewReport({ verifiedModel, selectionScript = "" } = {}) {
  assertVerifiedModel(verifiedModel);
  if (typeof selectionScript !== "string") throw new TypeError("selectionScript must be a string");
  const { candidateSet, container } = verifiedModel;
  const candidates = candidateSet.candidates;
  const selectable = new Set(verifiedModel.selectableCandidateIds);
  const entries = candidates.map((candidate, index) => ({
    candidate,
    assessment: container.assessments[index],
    index,
    id: candidateId(candidate),
    gaps: verifiedModel.gaps.filter((gap) => gap.candidateId === candidateId(candidate)),
    selectable: selectable.has(candidateId(candidate)),
    origin: verifiedModel.origins?.[candidateId(candidate)] ?? null,
  }));
  const groups = groupCandidates(entries);
  const modelStatus = entries.some((entry) => entry.assessment?.readiness === "rejected")
    ? "存在 rejected 候选"
    : verifiedModel.gaps.some((gap) => gap.blocking)
      ? "存在阻断缺件"
      : "无已登记阻断项";
  const selectionNotice = selectionScript.trim() ? "选择交互已接线" : "交互尚未接线；此页不会生成或下载选择记录。";
  const binding = `candidateSetHash=${container.candidateSetHash ?? "未提供"} · assessmentHash=${container.assessmentHash ?? "未提供"}`;
  const reportCards = [...groups.entries()]
    .map(
      ([skinId, skinEntries]) =>
        `<section class="skin-group"><h2>${escapeHtml(skinId)}</h2><div class="cards">${skinEntries.map((entry) => renderCandidate(entry)).join("")}</div></section>`,
    )
    .join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>皮肤候选评审报告</title><style>
:root{font-family:system-ui,"Microsoft YaHei",sans-serif;color:#202733;background:#f4f6f8}*{box-sizing:border-box}body{margin:0;padding:24px;max-width:1800px;margin-inline:auto}h1,h2,h3,h4,p{margin-top:0}header.page{position:sticky;top:0;background:#f4f6f8eF;padding:12px 0;z-index:1}header.page p{margin-bottom:4px}.skin-group{margin:28px 0}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,520px),1fr));gap:16px}.candidate{padding:18px;border:1px solid #c9d1d9;border-radius:12px;background:white;min-width:0}.candidate header{display:flex;align-items:baseline;justify-content:space-between;gap:12px}.candidate h3{margin-bottom:6px;overflow-wrap:anywhere}.candidate code{overflow-wrap:anywhere}.notes{white-space:pre-wrap}.selection-state{font-weight:600}.readiness{padding:8px 10px;border-radius:7px;font-weight:600}.readiness-ready{color:#116329;background:#dafbe1;border-left:5px solid #1a7f37}.readiness-rejected{color:#82071e;background:#ffebe9;border-left:5px solid #cf222e}.readiness-incomplete{color:#7d4e00;background:#fff8c5;border-left:5px solid #bf8700}.readiness-unknown{color:#57606a;background:#f4f6f8}.profile{overflow-wrap:anywhere}.palette{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:12px}.palette div{display:grid;gap:4px;padding:10px;background:#f4f6f8;border-radius:8px}.metrics{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.metrics div{padding:10px;background:#f4f6f8;border-radius:8px}.metrics dt{font-size:.88rem;color:#57606a}.metrics dd{margin:4px 0 0;overflow-wrap:anywhere}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.mode{margin:0;min-width:0}.mode figcaption{font-size:.9rem;font-weight:600;margin:8px 0}.baseline-slot{aspect-ratio:16/9;background:#eaeef2;display:grid;place-items:center;border-radius:8px;overflow:hidden}.baseline-slot img{width:100%;height:100%;object-fit:contain;cursor:zoom-in}.missing{padding:12px;color:#b42318;text-align:center}.choice{display:block;padding:12px 0}.gaps{padding-left:20px}.gaps li{margin:6px 0;overflow-wrap:anywhere}details{border-top:1px solid #d0d7de;padding-top:12px}summary{cursor:pointer;font-weight:600}.diagnostic-content{padding:12px 0}.diagnostic-content pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f8fa;padding:12px;border-radius:8px;max-height:260px;overflow:auto}.state-assets{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}.state-assets figure{margin:0}.state-assets img{width:100%;height:180px;object-fit:contain;background:#eef1f4}.overall{margin:32px 0;padding-top:16px;border-top:2px solid #8c959f}.mode-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}.mode-grid figure{padding:10px;border:1px solid #c9d1d9;border-radius:10px;background:white;margin:0}.mode-grid img{width:100%;height:220px;object-fit:contain;background:#eaeef2;border-radius:8px}dialog{max-width:96vw;max-height:96vh;border:0;border-radius:12px;padding:12px;box-shadow:0 12px 50px #0008}dialog::backdrop{background:#000b}dialog img{display:block;max-width:92vw;max-height:88vh;object-fit:contain}dialog form{text-align:right}@media(max-width:640px){body{padding:12px}.pair,.metrics,.palette{grid-template-columns:1fr}}
</style><style>.zoom-open{width:100%;height:100%;padding:0;border:0;background:transparent;cursor:zoom-in}.zoom-open img{width:100%;height:100%;object-fit:contain}.mode-grid .zoom-open{height:auto}.state-assets .zoom-open{height:auto}</style></head><body>
<header class="page"><h1>皮肤候选评审报告</h1><p>${escapeHtml(modelStatus)} · ${candidates.length} 个候选 / ${groups.size} 套皮肤</p><p>${escapeHtml(binding)}</p><p>${escapeHtml(selectionNotice)}</p><details><summary>全部缺件与警告（${verifiedModel.gaps.length}）</summary>${renderGaps(verifiedModel.gaps)}</details></header>
<main>${reportCards}<section class="selection-area"><h2>选择区</h2><p data-selection-message>${escapeHtml(selectionNotice)}</p><button type="button" data-selection-export${selectionScript.trim() ? "" : " disabled"}>导出选择记录</button></section>
${groups.size === 10 ? `<section class="overall"><h2>十套整体网格</h2>${MODES.map((mode) => `<h3>${mode === "light" ? "浅色整体" : "深色整体"}</h3><div class="mode-grid" data-overview-mode="${mode}"></div>`).join("")}</section>` : ""}
</main><dialog id="image-viewer" aria-label="原尺寸图片"><form method="dialog"><button type="submit">关闭原图</button></form><img alt="原尺寸评审图片"></dialog>
<script type="application/json" id="review-model">${safeJson({ candidateSetHash: container.candidateSetHash, assessmentHash: container.assessmentHash, candidates: entries.map(({ candidate, assessment, index, id, gaps, selectable }) => ({ candidate, assessment, index, id, gaps, selectable, origin: verifiedModel.origins?.[id] ?? null, assets: verifiedModel.images.assets.filter((asset) => asset.candidateId === id) })) })}</script>
<script>
const review=JSON.parse(document.getElementById("review-model").textContent);
const pngDataUrl=new RegExp("^data:image/png;base64,[A-Za-z0-9+/]*={0,2}$");
function imageButton(asset,alt){
  const button=document.createElement("button");button.type="button";button.className="zoom-open";button.setAttribute("aria-label","放大："+alt);
  const img=document.createElement("img");img.src=asset.dataUrl;img.alt=alt;button.append(img);return button;
}
function setJson(node,value){node.textContent=JSON.stringify(value??null,null,2);}
function isBaseline(asset){return (asset.relativePath??"").toLowerCase().endsWith("baseline.png");}
function relatedStateAssets(entry){
  const references=[...entry.gaps,...(entry.assessment?.failures??[]),...(entry.assessment?.unmeasured??[])];
  const referenced=new Set(references.flatMap(item=>[item.unitId,item.stateId].filter(Boolean)));
  return entry.assets.filter(asset=>!isBaseline(asset)&&pngDataUrl.test(asset.dataUrl??"")&&((asset.relativePath??"").toLowerCase().endsWith("first-screen.png")||(asset.unitId&&referenced.has(asset.unitId))));
}
for(const card of document.querySelectorAll("[data-baseline-index]")){
  const entry=review.candidates[Number(card.dataset.baselineIndex)];
  for(const slot of card.querySelectorAll("[data-mode]")){
    const mode=slot.dataset.mode;const asset=entry.assets.find(item=>item.mode===mode&&isBaseline(item)&&pngDataUrl.test(item.dataUrl??""));
    slot.replaceChildren();
    if(asset)slot.append(imageButton(asset,entry.id+" "+mode+" baseline.png"));
    else {const missing=document.createElement("span");missing.className="missing";missing.textContent="缺图："+mode+"/baseline.png。相关缺件："+(entry.gaps.map(gap=>gap.code).filter(Boolean).join("、")||"未提供");slot.append(missing);}
  }
}
for(const detail of document.querySelectorAll("[data-diagnostics-index]")){
  detail.addEventListener("toggle",()=>{
    if(!detail.open||detail.dataset.loaded) return;
    const entry=review.candidates[Number(detail.dataset.diagnosticsIndex)];
    setJson(detail.querySelector("[data-blockers]"),entry.assessment?.diagnostics?.gate?.blockers);
    setJson(detail.querySelector("[data-failures]"),entry.assessment?.failures);
    setJson(detail.querySelector("[data-unmeasured]"),entry.assessment?.unmeasured);
    setJson(detail.querySelector("[data-origin]"),entry.origin);
    setJson(detail.querySelector("[data-diagnostics]"),entry.assessment?.diagnostics??null);
    const gallery=detail.querySelector("[data-state-index]");const assets=relatedStateAssets(entry);
    if(!assets.length)gallery.textContent="没有与现有缺件关联的状态图。";
    for(const asset of assets){const figure=document.createElement("figure");const caption=document.createElement("figcaption");caption.textContent=asset.mode+" · "+(asset.unitId??asset.relativePath);figure.append(caption,imageButton(asset,entry.id+" "+asset.mode+" "+(asset.unitId??asset.relativePath)));gallery.append(figure);}
    detail.dataset.loaded="true";
  });
}
for(const grid of document.querySelectorAll("[data-overview-mode]")){
  const mode=grid.dataset.overviewMode;
  for(const entry of review.candidates){
    const asset=entry.assets.find(item=>item.mode===mode&&isBaseline(item)&&pngDataUrl.test(item.dataUrl??""));
    const figure=document.createElement("figure");const caption=document.createElement("figcaption");const candidate=entry.candidate;caption.textContent=(candidate.skinId??"未提供皮肤")+" · "+(candidate.name??candidate.displayName??candidate.label??entry.id);figure.append(caption);
    if(asset)figure.append(imageButton(asset,entry.id+" "+mode+" baseline.png"));else{const missing=document.createElement("p");missing.className="missing";missing.textContent="缺图："+mode+"/baseline.png";figure.append(missing);}
    grid.append(figure);
  }
}
const viewer=document.getElementById("image-viewer");const viewerImage=viewer.querySelector("img");
document.addEventListener("click",event=>{const button=event.target.closest(".zoom-open");if(!button)return;viewerImage.src=button.querySelector("img").src;viewerImage.alt=button.querySelector("img").alt;viewer.showModal();});
</script>${selectionScript.trim() ? `<script>${selectionScript.replaceAll(/<\/script/gi, "<\\/script")}</script>` : ""}</body></html>`;
}
