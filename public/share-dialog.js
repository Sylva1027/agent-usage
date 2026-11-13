import { createShareCardData, shareCardFilename } from "./share-card-data.js";
import { renderShareCard, SHARE_METRICS } from "./share-card.js";

const $ = (selector) => document.querySelector(selector);
const pickers = ["shareMetricFirst", "shareMetricSecond"];
const METRICS_STORAGE_KEY = "codexUsageShareMetrics";
const metrics = ["cacheHit", "output"];
let initialized = false;
let snapshot;
let showCost = false;
let sequence = 0;
let previewUrl;
let imageBlob;
let originalHintTimer;
const t = (zh, en) => (snapshot.locale === "en-US" ? en : zh);

function setMenu(id, open, focus = false) {
  if (open) for (const other of pickers) if (other !== id) setMenu(other, false);
  $(`#${id}Menu`).hidden = !open;
  $(`#${id}`).setAttribute("aria-expanded", String(open));
  if (focus) (open ? $(`#${id}Menu [aria-selected="true"]`) : $(`#${id}`)).focus();
}

function renderControls() {
  pickers.forEach((id, index) => {
    const metric = SHARE_METRICS.find((option) => option.id === metrics[index]);
    $(`#${id}Value`).textContent = t(metric.zh, metric.en);
    $(`#${id}Menu`).replaceChildren(
      ...SHARE_METRICS.filter((option) => option.id !== metrics[1 - index]).map((metric) => {
        const option = document.createElement("button");
        option.type = "button";
        option.textContent = t(metric.zh, metric.en);
        option.dataset.metric = metric.id;
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", String(metric.id === metrics[index]));
        return option;
      }),
    );
  });
  $("#shareShowCost").checked = showCost;
}

function setReady(ready) {
  for (const id of ["openShareImage", "copyShareImage", "saveShareImage"]) $(`#${id}`).disabled = !ready;
  $("#shareImage").setAttribute("aria-busy", String(!ready));
}

async function updateImage() {
  const current = ++sequence;
  setReady(false);
  imageBlob = null;
  $("#shareStatus").textContent = "";
  let url;
  try {
    const blob = await renderShareCard({ ...snapshot, metrics: [...metrics], showCost });
    url = URL.createObjectURL(blob);
    const probe = new Image();
    probe.src = url;
    await probe.decode();
    if (current !== sequence) {
      URL.revokeObjectURL(url);
      return;
    }
    const previous = previewUrl;
    previewUrl = url;
    $("#shareImage").src = url;
    if (previous) URL.revokeObjectURL(previous);
    imageBlob = blob;
    setReady(true);
  } catch {
    if (url) URL.revokeObjectURL(url);
    if (current === sequence)
      $("#shareStatus").textContent = t("图片加载失败，请重新打开。", "Image could not load. Please reopen.");
  }
}

function trapFocus(event, dialog) {
  const controls = [...dialog.querySelectorAll("button,input,a[href],[tabindex]")].filter(
    (control) => !control.disabled && control.tabIndex >= 0 && control.getClientRects().length > 0,
  );
  if (!controls.length) {
    event.preventDefault();
    dialog.focus();
  } else if (
    !controls.includes(document.activeElement) ||
    document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))
  ) {
    event.preventDefault();
    (event.shiftKey ? controls.at(-1) : controls[0]).focus();
  }
}

function bind() {
  try {
    const saved = JSON.parse(localStorage.getItem(METRICS_STORAGE_KEY));
    if (
      Array.isArray(saved) &&
      saved.length === 2 &&
      saved[0] !== saved[1] &&
      saved.every((id) => SHARE_METRICS.some((metric) => metric.id === id))
    )
      metrics.splice(0, metrics.length, ...saved);
  } catch {
    // Unavailable storage or an invalid preference keeps the default pair.
  }
  initialized = true;
  pickers.forEach((id, index) => {
    const host = $(`#${id}`).parentElement;
    const menu = $(`#${id}Menu`);
    $(`#${id}`).addEventListener("click", () => setMenu(id, menu.hidden, true));
    menu.addEventListener("click", (event) => {
      const option = event.target.closest("[data-metric]");
      if (!option) return;
      metrics[index] = option.dataset.metric;
      try {
        localStorage.setItem(METRICS_STORAGE_KEY, JSON.stringify(metrics));
      } catch {
        // Storage may be disabled; keep the selection for this page session.
      }
      setMenu(id, false, true);
      renderControls();
      void updateImage();
    });
    host.addEventListener("keydown", (event) => {
      const options = [...menu.querySelectorAll("button")];
      const current = options.indexOf(document.activeElement);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const wasClosed = menu.hidden;
        setMenu(id, true);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? options.length - 1
              : wasClosed
                ? options.findIndex((option) => option.dataset.metric === metrics[index])
                : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        options[next].focus();
      } else if (event.key === "Escape" && !menu.hidden) {
        event.preventDefault();
        event.stopPropagation();
        setMenu(id, false, true);
      } else if (event.key === "Tab" && !menu.hidden) setMenu(id, false, true);
    });
  });
  document.addEventListener("click", (event) => {
    for (const id of pickers) if (!$(`#${id}`).parentElement.contains(event.target)) setMenu(id, false);
  });
  $("#shareShowCost").addEventListener("change", () => {
    showCost = $("#shareShowCost").checked;
    void updateImage();
  });
  $("#shareDialog").addEventListener("close", () => {
    ++sequence;
    imageBlob = null;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = null;
    $("#shareImage").removeAttribute("src");
    for (const id of pickers) setMenu(id, false);
    $("#shareToggle").setAttribute("aria-expanded", "false");
    $("#shareToggle").focus({ preventScroll: true });
  });
  $("#openShareImage").addEventListener("click", () => {
    $("#shareOriginalDialog img").src = previewUrl;
    $("#shareOriginalDialog").showModal();
    const hint = $("#shareOriginalHint");
    hint.textContent = t("按 Esc 退出", "Press Esc to exit");
    hint.hidden = false;
    clearTimeout(originalHintTimer);
    originalHintTimer = setTimeout(() => {
      hint.hidden = true;
    }, 3000);
  });
  $("#shareOriginalDialog").addEventListener("close", () => {
    clearTimeout(originalHintTimer);
    $("#shareOriginalHint").hidden = true;
    $("#shareOriginalDialog img").removeAttribute("src");
    $("#openShareImage").focus({ preventScroll: true });
  });
  for (const dialog of [$("#shareDialog"), $("#shareOriginalDialog")]) {
    let downOutside = false;
    const outside = (event) => {
      const r = dialog.getBoundingClientRect();
      return event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom;
    };
    dialog.addEventListener("pointerdown", (event) => {
      downOutside = outside(event);
    });
    dialog.addEventListener("click", (event) => {
      if (downOutside && outside(event)) dialog.close();
      downOutside = false;
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Tab") trapFocus(event, dialog);
    });
  }
  $("#saveShareImage").addEventListener("click", () => {
    if (!imageBlob) return;
    $("#shareStatus").textContent = "";
    const url = URL.createObjectURL(imageBlob);
    const link = document.createElement("a");
    link.href = url;
    link.download = shareCardFilename(snapshot.data.range);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  });
  $("#copyShareImage").addEventListener("click", async () => {
    if (!imageBlob) return;
    $("#shareStatus").textContent = "";
    const current = sequence;
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": imageBlob })]);
    } catch {
      if (current === sequence)
        $("#shareStatus").textContent = t("暂时无法复制，请保存图片。", "Could not copy. Save the image instead.");
    }
  });
}

export function openShareDialog({ summary, preset, currency, usdToCnyRate, periodComparison, ...appearance }) {
  const data = createShareCardData(summary, { preset, currency, usdToCnyRate, periodComparison });
  if (!data || $("#shareDialog").open) return;
  if (!initialized) bind();
  snapshot = { ...appearance, data };
  showCost = false;
  for (const [selector, zh, en] of [
    ["#shareTitle", "分享图片", "Share image"],
    [".customize-label", "辅助指标", "Metrics"],
    [".share-cost-toggle span", "显示费用", "Show cost"],
    ["#copyShareImage span", "复制图片", "Copy image"],
    ["#saveShareImage span", "保存图片", "Save image"],
  ])
    $(selector).textContent = t(zh, en);
  for (const [selector, zh, en] of [
    ["#openShareImage", "查看原图", "View full image"],
    ["#shareMetricFirst", "第一个辅助指标", "First metric"],
    ["#shareMetricSecond", "第二个辅助指标", "Second metric"],
    ["#shareMetricFirstMenu", "第一个辅助指标", "First metric"],
    ["#shareMetricSecondMenu", "第二个辅助指标", "Second metric"],
    ["#shareOriginalDialog", "图片原图", "Full image"],
    [".share-customize", "图片内容", "Image content"],
  ])
    $(selector).setAttribute("aria-label", t(zh, en));
  $("#openShareImage").title = t("查看原图", "View full image");
  $(".project-link").title = t("GitHub 项目", "GitHub project");
  $("#shareImage").alt = t("模型用量分享图片", "Model usage card");
  $("#shareOriginalDialog img").alt = $("#shareImage").alt;
  renderControls();
  $("#shareDialog").showModal();
  $("#shareToggle").setAttribute("aria-expanded", "true");
  $("#shareTitle").focus();
  void updateImage();
}
