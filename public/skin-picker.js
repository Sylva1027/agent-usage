/**
 * Skin picker dialog (implementation plan 4.3 and 4.4).
 *
 * Behaviour contract:
 *   - `#skinDialog` is a sibling of `#importDialog` / `#pricingDialog`, uses the
 *     same backdrop and material, and is never nested inside them.
 *   - Opening records the invoker, renders the current selection and focuses the
 *     selected character option, or the explicit simple-mode control.
 *   - The close button, a click on the backdrop and Escape all run one close
 *     function that restores focus and the previous scroll position. Clicks
 *     inside the content never close it.
 *   - Only the currently offered character skins render in the comparison matrix. Classic
 *     stays in the registry and remains reachable through its separate button.
 */

const PICKER_SKIN_IDS = new Set(["chatgpt", "claude", "deepseek", "kimi", "muse"]);

// Thumbnail framing only. anchorX is a SOURCE-canvas percentage at the
// face, not the canvas centre; top is a percentage of the preview's height.
// The same framing applies to both mode assets, whose alpha masks match.
// Page-side artwork keeps its separate measured display parameters in skins.js.
const previewComposition = {
  chatgpt: { anchorX: 45.5, stageX: 76, top: 0, scale: 2.15 },
  claude: { anchorX: 48, stageX: 76, top: 4, scale: 2.15 },
  glm: { anchorX: 49, stageX: 76, top: 0, scale: 2.15 },
  gemini: { anchorX: 49.5, stageX: 76, top: -3, scale: 2.15 },
  deepseek: { anchorX: 49, stageX: 76, top: -3, scale: 2.15 },
  kimi: { anchorX: 51.5, stageX: 76, top: 2, scale: 2.15 },
  qwen: { anchorX: 48, stageX: 76, top: 2, scale: 2.15 },
  grok: { anchorX: 55, stageX: 76, top: -20, scale: 2.15 },
  muse: { anchorX: 48.5, stageX: 74, top: -5, scale: 2.15 },
  mimo: { anchorX: 48, stageX: 72, top: -10, scale: 2.15 },
};

/**
 * Colour tokens a skin may legally override. These are colours only; layout,
 * typography and spacing keys are deliberately absent so a palette can never
 * resize or reflow anything (plan 3.3).
 */
const COLOUR_TOKENS = [
  "pageBackground",
  "panelBackground",
  "controlBackground",
  "text",
  "mutedText",
  "border",
  "accent",
  "chartText",
  "chartLine",
  "series1",
  "series2",
  "series3",
  "chartSeries",
];

/** Maps a palette token onto the CSS variable the mini template reads. */
const TOKEN_TO_CSS = {
  pageBackground: "--skin-preview-page",
  panelBackground: "--skin-preview-panel",
  controlBackground: "--skin-preview-control",
  text: "--skin-preview-text",
  mutedText: "--skin-preview-muted",
  border: "--skin-preview-border",
  accent: "--skin-preview-accent",
  chartText: "--skin-preview-chart-text",
  chartLine: "--skin-preview-chart-line",
  series1: "--skin-preview-series-1",
  series2: "--skin-preview-series-2",
  series3: "--skin-preview-series-3",
};

function element(id) {
  return document.getElementById(id);
}

/**
 * One honest palette reading for a skin/mode. Returns the tokens the user
 * actually supplied; null means "not specified yet" and must never be filled in
 * with invented or copied colours (plan 3.3).
 */
function previewTokens(runtime, skinId, mode) {
  const palette = runtime.paletteFor?.(skinId, mode);
  if (!palette?.tokens) return null;
  const tokens = {};
  for (const key of COLOUR_TOKENS) {
    const value = palette.tokens[key];
    if (typeof value === "string" && value) tokens[key] = value;
  }
  return Object.keys(tokens).length ? tokens : null;
}

/** Inline custom properties for a preview, from real tokens only. */
function tokenStyle(tokens) {
  if (!tokens) return "";
  const declarations = Object.entries(tokens)
    .map(([key, value]) => `${TOKEN_TO_CSS[key]}:${value}`)
    .filter((declaration) => !declaration.startsWith("undefined:"));
  return declarations.length ? ` style="${declarations.join(";")}"` : "";
}

/**
 * The shared mini template every character skin renders through:
 * identical title, text, panel, button and chart sample. Character artwork uses
 * a fixed 50% reference opacity so the comparison never depends on the page's
 * current character opacity (plan 4.4).
 */
function miniTemplate({ artworkUrl, tokens, composition }) {
  const framing = `--skin-preview-anchor-x:${composition.anchorX}%;--skin-preview-stage-x:${composition.stageX}%;--skin-preview-top:${composition.top}%;--skin-preview-scale:${composition.scale}`;
  return `<div class="skin-preview"${tokenStyle(tokens)}>
      ${artworkUrl ? `<img class="skin-preview-art" src="${artworkUrl}" alt="" loading="lazy" style="${framing}" />` : ""}
      <div class="skin-preview-ui" aria-hidden="true">
        <span class="skin-preview-title"></span>
        <span class="skin-preview-line"></span>
        <span class="skin-preview-line skin-preview-line-short"></span>
        <div class="skin-preview-panel">
          <span class="skin-preview-bar" style="--h:62%"></span>
          <span class="skin-preview-bar" style="--h:88%"></span>
          <span class="skin-preview-bar" style="--h:46%"></span>
        </div>
        <span class="skin-preview-button"></span>
      </div>
    </div>`;
}

/** One card, used for each character skin currently offered in the picker. */
function cardHtml(runtime, skin, selectedId, translate, tabStopId) {
  const isSelected = skin.id === selectedId;
  const lightTokens = previewTokens(runtime, skin.id, "light");
  const darkTokens = previewTokens(runtime, skin.id, "dark");

  // Both modes are always rendered side by side; a preview never follows the
  // page's own theme (plan 4.4).
  const body = (mode) =>
    miniTemplate({
      artworkUrl: runtime.urlsFor(skin.id, mode)?.front,
      tokens: mode === "light" ? lightTokens : darkTokens,
      composition: previewComposition[skin.id],
    });

  return `<button
      class="skin-card${isSelected ? " is-selected" : ""}"
      type="button"
      role="radio"
      aria-checked="${isSelected}"
      tabindex="${skin.id === tabStopId ? 0 : -1}"
      data-skin-id="${skin.id}"
      aria-label="${translate(skin.name)}"
    >
      <span class="skin-card-head">
        <span class="skin-card-name">${translate(skin.name)}</span>
        ${isSelected ? `<span class="skin-card-selected-dot" aria-hidden="true"></span>` : ""}
      </span>
      <span class="skin-card-previews">
        <span class="skin-preview-cell" data-preview-theme="light">
          <span class="skin-preview-mode">${translate("浅色")}</span>
          <span class="skin-preview-scope" data-preview-theme="light">${body("light")}</span>
        </span>
        <span class="skin-preview-cell" data-preview-theme="dark">
          <span class="skin-preview-mode">${translate("深色")}</span>
          <span class="skin-preview-scope" data-preview-theme="dark">${body("dark")}</span>
        </span>
      </span>
    </button>`;
}

export function createSkinPicker({ runtime, translate, onOpen, onClose }) {
  let opener = null;
  let restoreScrollY = 0;

  function dialog() {
    return element("skinDialog");
  }

  function isOpen() {
    const node = dialog();
    return Boolean(node) && !node.hidden;
  }

  /**
   * One writer for the opacity control's three faces: the range value, the
   * percentage readout and the slider's progress fill. The fill is a CSS
   * variable the track gradient reads, so every path that changes opacity -
   * first render, restored preferences, dragging and programmatic runtime
   * changes - must go through here, or the fill length drifts out of sync
   * (refinement R4). Called without an argument it re-reads the runtime, which
   * is how preference-level changes reach the slider.
   */
  function syncOpacityControl(percent = Math.round(runtime.getPreference().opacity * 100)) {
    const input = element("skinOpacity");
    if (input) {
      input.value = String(percent);
      input.style.setProperty("--skin-opacity-fill", `${percent}%`);
    }
    const output = element("skinOpacityValue");
    if (output) output.textContent = `${percent}%`;
  }

  function render() {
    const grid = element("skinGrid");
    if (!grid) return;
    const preference = runtime.getPreference();
    grid.setAttribute("role", "radiogroup");
    // Filter presentation only: classic remains the default stored state and
    // the separate reset button still uses its original registry entry.
    const skins = runtime.getSelectableSkins().filter((skin) => !skin.isClassic && PICKER_SKIN_IDS.has(skin.id));
    const tabStopId = skins.some((skin) => skin.id === preference.skinId) ? preference.skinId : skins[0]?.id;
    grid.innerHTML = skins.map((skin) => cardHtml(runtime, skin, preference.skinId, translate, tabStopId)).join("");
    if (!runtime.isCharacter(preference.skinId)) grid.scrollTop = 0;
    element("resetSkinClassicButton")?.setAttribute("aria-pressed", String(!runtime.isCharacter(preference.skinId)));

    const toggle = element("skinCharactersToggle");
    if (toggle) {
      toggle.checked = preference.showCharacters;
      toggle.disabled = !runtime.isCharacter(preference.skinId);
    }
    syncOpacityControl(Math.round(preference.opacity * 100));
  }

  function focusCard(card) {
    if (!card) return;
    const grid = element("skinGrid");
    if (grid) {
      const box = card.getBoundingClientRect();
      const viewport = grid.getBoundingClientRect();
      if (box.top < viewport.top) grid.scrollTop -= viewport.top - box.top;
      else if (box.bottom > viewport.bottom) grid.scrollTop += box.bottom - viewport.bottom;
    }
    card.focus({ preventScroll: true });
  }

  function open() {
    const node = dialog();
    if (!node) return;
    opener = document.activeElement;
    restoreScrollY = window.scrollY;
    node.hidden = false;
    render();
    if (onOpen) onOpen();
    // Classic has its own explicit control; character mode starts at its radio.
    window.requestAnimationFrame(() => {
      if (node.hidden) return;
      const card = node.querySelector(".skin-card.is-selected");
      if (card) focusCard(card);
      else element("resetSkinClassicButton")?.focus({ preventScroll: true });
    });
  }

  function close() {
    const node = dialog();
    if (!node || node.hidden) return;
    node.hidden = true;
    window.scrollTo(0, restoreScrollY);
    const target = opener;
    opener = null;
    target?.focus?.({ preventScroll: true });
    if (onClose) onClose();
  }

  function toggleOpen() {
    if (isOpen()) close();
    else open();
  }

  function select(skinId) {
    runtime.setSkin(skinId);
    render();
    // Keep focus on the newly selected card so keyboard use stays predictable.
    focusCard(dialog()?.querySelector(`.skin-card[data-skin-id="${skinId}"]`));
  }

  function bind() {
    const node = dialog();
    if (!node) return;

    node.addEventListener("click", (event) => {
      // Backdrop clicks close; clicks inside the content never do.
      if (event.target === node) {
        close();
        return;
      }
      const card = event.target.closest?.(".skin-card");
      if (card?.dataset.skinId) select(card.dataset.skinId);
    });

    element("skinGrid")?.addEventListener("keydown", (event) => {
      const card = event.target.closest?.(".skin-card");
      if (!card) return;
      const cards = [...element("skinGrid").querySelectorAll(".skin-card")];
      const index = cards.indexOf(card);
      let next;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % cards.length;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index - 1 + cards.length) % cards.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = cards.length - 1;
      else return;
      event.preventDefault();
      select(cards[next].dataset.skinId);
    });

    element("closeSkinDialogButton")?.addEventListener("click", close);

    element("skinCharactersToggle")?.addEventListener("change", (event) => {
      runtime.setShowCharacters(event.target.checked);
      render();
    });

    element("skinOpacity")?.addEventListener("input", (event) => {
      const percent = Number(event.target.value);
      runtime.setOpacity(percent / 100);
      syncOpacityControl(percent);
    });

    element("resetSkinClassicButton")?.addEventListener("click", () => {
      runtime.resetToClassic();
      render();
      element("resetSkinClassicButton")?.focus({ preventScroll: true });
    });
  }

  return { bind, open, close, toggleOpen, render, isOpen, select, syncOpacityControl };
}
