import { escapeHtml } from "./html-utils.js";

export const SHARE_METRICS = Object.freeze([
  { id: "cacheHit", zh: "缓存命中", en: "Cache hit" },
  { id: "output", zh: "输出", en: "Output" },
  { id: "input", zh: "输入", en: "Input" },
  { id: "cached", zh: "缓存读取", en: "Cache read" },
  { id: "uncached", zh: "未缓存输入", en: "Uncached input" },
  { id: "reasoning", zh: "推理", en: "Reasoning" },
  { id: "sessions", zh: "会话", en: "Sessions" },
  { id: "models", zh: "模型数量", en: "Models" },
]);

const PERIOD_LABELS = {
  today: { zh: "今日", en: "Today" },
  week: { zh: "本周", en: "This Week" },
  month: { zh: "本月", en: "This Month" },
};
const resources = new Map();
const stylesUrl = new URL("./styles.css", import.meta.url).href;

function tokenParts(value) {
  if (!Number.isFinite(value)) return ["—", ""];
  const magnitude = Math.abs(value);
  const [divisor, unit] = magnitude >= 1e12 ? [1e12, "T"] : magnitude >= 1e9 ? [1e9, "B"] : [1e6, "M"];
  return [(value / divisor).toFixed(2), unit];
}

function asDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function resource(url, dataUrl = false) {
  const key = `${dataUrl ? "image" : "text"}:${url}`;
  if (!resources.has(key)) {
    const pending = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error("Could not load share-card resource");
        return dataUrl ? response.blob().then(asDataUrl) : response.text();
      })
      .catch((error) => {
        resources.delete(key);
        throw error;
      });
    resources.set(key, pending);
  }
  return resources.get(key);
}

async function decodedImage(url) {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

function metricHtml(id, english, data) {
  const metric = SHARE_METRICS.find((item) => item.id === id);
  let value;
  if (id === "cacheHit") {
    value = Number.isFinite(data.cacheHitRate) ? [(data.cacheHitRate * 100).toFixed(2), "%"] : ["—", ""];
  } else if (id === "sessions" || id === "models") {
    const count = id === "sessions" ? data.sessionCount : data.modelCount;
    value = [Number.isFinite(count) ? String(count) : "—", ""];
  } else {
    value = tokenParts(data.totals[id]);
  }
  const unit = value[1] ? `<small${value[1] === "%" ? "" : ' class="p-token-unit"'}>${value[1]}</small>` : "";
  return `<section class="p-metric p-panel"><div class="p-metric-body"><span class="p-label">${english ? metric.en : metric.zh}</span><div class="p-readout"><strong>${value[0]}${unit}</strong></div></div></section>`;
}

/**
 * Render the approved 3:4 card from an already projected dashboard snapshot.
 * Palettes and optional artwork come from the caller, so standard releases never
 * import skin modules. cacheHitRate is a fraction; unavailable metrics are null.
 */
export async function renderShareCard({
  data,
  locale = "zh-CN",
  theme = "light",
  metrics = ["cacheHit", "output"],
  showCost = false,
  palette = [],
  character = null,
}) {
  if (!data?.totals || !Object.hasOwn(PERIOD_LABELS, data.period)) throw new Error("Unsupported share period");
  if (!["light", "dark"].includes(theme)) throw new Error("Unsupported share theme");
  if (
    metrics.length !== 2 ||
    metrics[0] === metrics[1] ||
    metrics.some((id) => !SHARE_METRICS.some((metric) => metric.id === id))
  ) {
    throw new Error("Expected two different share metrics");
  }
  const english = locale.startsWith("en");
  const period = PERIOD_LABELS[data.period];
  const [productionCss, art] = await Promise.all([
    resource(stylesUrl),
    character ? resource(character.url, true) : null,
  ]);
  const colours = palette.map(([key, value]) => `${key}:${value}`).join(";");
  const total = tokenParts(data.totals.total);
  const rows = data.models.slice(0, 5);
  const maximum = Math.max(0, ...rows.map((row) => row.total));
  const bars = rows
    .map((row) => {
      const value = tokenParts(row.total);
      const width = maximum > 0 ? Math.max(0, (row.total / maximum) * 100) : 0;
      return `<div class="bar-row"><div class="bar-label"><span class="bar-name">${escapeHtml(row.name)}</span><span class="bar-value">${value.join("")}</span></div><div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div></div>`;
    })
    .join("");
  let artwork = "";
  if (character) {
    let image;
    try {
      image = await decodedImage(art);
    } catch (error) {
      // Do not preserve a failed image decode across the user's next attempt.
      resources.delete(`image:${character.url}`);
      throw error;
    }
    const face = character.displayParams;
    const height = (1180 * face.scale) / 1.0091;
    const width = (image.naturalWidth / image.naturalHeight) * height;
    artwork = `<div class="p-ornament"><img class="p-character" alt="" src="${escapeHtml(art)}" style="height:${height}px;left:${812.2 - width * face.face.faceX}px"/></div>`;
  }
  const cost = data.cost;
  const heading = english ? "Model Usage" : "模型用量";
  const periodLabel = `<span class="p-period">${english ? period.en : period.zh}</span>`;
  const fee =
    showCost && Number.isFinite(cost?.amount)
      ? `<div class="p-fee">${english ? "API estimate" : "API 估算"}<span>${cost.currency === "CNY" ? "¥" : "$"}${cost.amount.toFixed(0)}</span></div>`
      : "";
  const html = `<div xmlns="http://www.w3.org/1999/xhtml"><style>${productionCss}${CARD_CSS}</style><article class="p-card skin-preview-scope${character ? "" : " no-character classic-hybrid"}" data-preview-theme="${theme}" style="${escapeHtml(colours)}" lang="${english ? "en" : "zh-CN"}">${artwork}<section class="p-hero p-panel v05"><div class="p-heading">${heading}</div>${periodLabel}<div class="p-hero-display"><div class="p-number"><strong>${total[0]}</strong><span>${total[1]}</span></div></div>${fee}</section><div class="p-lower"><div class="p-data"><section class="p-models p-panel"><div class="p-model-tray">${bars}</div></section>${metrics.map((id) => metricHtml(id, english, data)).join("")}</div></div></article></div>`;
  const wrapper = new DOMParser().parseFromString(html, "text/html").body.firstElementChild;
  const xml = new XMLSerializer().serializeToString(wrapper);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440"><foreignObject x="0" y="0" width="1080" height="1440">${xml}</foreignObject></svg>`;
  const image = await decodedImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const canvas = document.createElement("canvas");
  canvas.width = 1080;
  canvas.height = 1440;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas rendering is unavailable");
  context.drawImage(image, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG generation failed"))), "image/png");
  });
}

const CARD_CSS = `
*{box-sizing:border-box}
.p-period{position:absolute;top:34px;right:36px;font-size:28px;line-height:34px;font-weight:400;color:var(--muted);white-space:nowrap}
.p-card{position:relative;isolation:isolate;overflow:hidden;width:1080px;height:1440px;padding:72px;background:var(--bg);color:var(--ink);font-family:var(--ui-font-sans);font-variant-numeric:lining-nums tabular-nums;display:grid;grid-template-rows:290px 1fr;gap:36px}
.p-ornament{position:absolute;inset:0;overflow:visible;pointer-events:none;z-index:0}.p-character{position:absolute;left:510px;top:355px;height:1180px;width:auto;max-width:none;opacity:.66}
.p-panel{position:relative;z-index:1;border-radius:36px;background:linear-gradient(135deg,var(--ceramic-top),var(--neo-surface) 45%,var(--ceramic-bottom));box-shadow:14px 18px 36px var(--ceramic-shade),-8px -10px 28px var(--ceramic-light),inset 2px 2px 2px var(--ceramic-rim)}
.p-hero{padding:28px}.p-heading{height:46px;line-height:46px;padding-left:8px;font-size:38px;font-weight:550;color:var(--muted)}.p-hero-display{height:176px;margin-top:12px;padding:0 16px;border-radius:24px;display:flex;align-items:center}.p-number{display:flex;align-items:baseline;gap:15px;line-height:1.15;white-space:nowrap}.p-number>strong{font-size:122px;letter-spacing:-4px;font-weight:700}.p-number>span{font-size:58px;font-weight:550;color:var(--muted)}
.p-lower{position:relative;display:grid;grid-template-columns:520px 1fr;gap:36px;min-height:0}.p-data{display:grid;grid-template-rows:1fr 190px 190px;gap:36px;min-height:0}.p-models{padding:24px}.p-model-tray{height:100%;display:grid;grid-template-rows:repeat(5,minmax(0,1fr));min-height:0}.p-card .bar-row{display:flex;flex-direction:column;justify-content:center;gap:0;padding:10px 12px;min-height:0;position:relative;outline:none}.p-card .bar-label{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0;line-height:1.3;margin:0}.p-card .bar-name{font-size:35px;font-weight:600;letter-spacing:-.4px;white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto}.p-card .bar-value{font-size:31px;font-weight:550;letter-spacing:-.5px;color:var(--muted);flex:0 0 auto;white-space:nowrap}.p-card .bar-track{width:100%;height:12px;margin-top:10px;flex:0 0 12px;border-radius:99px;background:var(--ceramic-well);box-shadow:inset 3px 4px 7px var(--ceramic-shade),inset -1px -1px 2px var(--ceramic-rim);overflow:hidden}.p-card .bar-fill{height:100%;border-radius:inherit;background:var(--blue);box-shadow:inset 0 2px 2px color-mix(in srgb,var(--ceramic-rim) 40%,transparent);opacity:.82}
.p-metric{padding:24px}.p-metric-body{height:100%}.p-label{display:block;font-size:32px;line-height:38px;font-weight:500;color:var(--muted)}.p-readout{height:92px;margin-top:12px;padding:0 12px;display:flex;align-items:center;border-radius:20px;background:var(--ceramic-well);box-shadow:inset 4px 5px 10px var(--ceramic-shade),inset -1px -1px 2px var(--ceramic-rim)}.p-readout>strong{font-size:63px;font-weight:650;letter-spacing:-1.5px;line-height:1.15;white-space:nowrap}.p-readout small{font-size:34px;font-weight:500;color:var(--muted);margin-left:7px;letter-spacing:0}
.v05 .p-heading{color:var(--muted);text-shadow:-1px -1px 1px var(--ceramic-shade),1px 1px 1px var(--ceramic-rim)}.v05 .p-hero-display{position:relative;background:transparent;box-shadow:none;padding-left:8px}.v05 .p-hero-display::before{content:"";position:absolute;left:8px;right:8px;top:0;height:3px;border-radius:3px;background:linear-gradient(to bottom,var(--ceramic-top),var(--ceramic-bottom));box-shadow:0 2px 3px var(--ceramic-shade),inset 0 1px 0 var(--ceramic-rim)}
.p-readout small.p-token-unit{font-size:30px;font-weight:500;margin-left:8px}.p-data,.p-model-tray{grid-template-columns:minmax(0,1fr);min-width:0}.p-models,.bar-row{min-width:0}.p-card.no-character .p-lower{grid-template-columns:minmax(0,1fr)}.classic-hybrid{padding:172px 160px}.classic-hybrid .p-data{grid-template-columns:1fr 1fr;grid-template-rows:518px 216px}.classic-hybrid .p-models{grid-column:1/-1}.classic-hybrid .p-metric{display:flex;align-items:center}.classic-hybrid .p-metric-body{height:auto;width:100%}
.p-fee{position:absolute;right:36px;bottom:36px;z-index:1;display:flex;flex-direction:column;align-items:flex-end;gap:8px;color:var(--muted);font-size:25px;font-weight:450;line-height:1;white-space:nowrap;text-box-trim:trim-both;text-box-edge:cap alphabetic}.p-fee span{font-size:36px;font-weight:500;letter-spacing:-.02em;text-box-trim:trim-both;text-box-edge:cap alphabetic}
`;
