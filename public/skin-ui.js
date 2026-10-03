/**
 * Character skin runtime: decoration layer, load sequencing and the skin picker.
 *
 * Contract: implementation plan section 4. This module owns the DOM side only.
 * The registry, URL derivation and preference normalisation live in skins.js so
 * that both the online dashboard and the offline snapshot share one source of
 * truth, and so the pre-paint bootstrap can apply a restored skin before paint.
 *
 * Geometry rule (plan 4.1): the decoration layer is fixed, viewport-anchored and
 * outside normal flow. Nothing here may resize, reflow or re-space the dashboard.
 * Toggling characters must not move a single existing box.
 */

import {
  DEFAULT_SKIN_PREFERENCE,
  PALETTE_CSS_VAR_NAMES,
  SKIN_PREFERENCE_KEY,
  SKINS,
  clampOpacity,
  normalizeSkinPreference,
  paletteDeclarations,
  serializeSkinPreference,
  skinDisplayParams,
  skinFaceTarget,
} from "./skins.js";

export { SKINS };
export { createSkinPicker } from "./skin-picker.js";

const DECORATION_LAYER_ID = "skinCharacters";
const SKIN_STORAGE_KEY = SKIN_PREFERENCE_KEY;
const VIEW_ORDER = ["side", "front"];

function storageRead(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage can be blocked entirely; the dashboard must still work.
    return null;
  }
}

function storageWrite(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Clamp while treating 0 as a real value, never as "unset". */
const DEFAULT_OPACITY = DEFAULT_SKIN_PREFERENCE.opacity;

function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function createSkinRuntime({ registry, onChange } = {}) {
  const byId = new Map(registry.map((skin) => [skin.id, skin]));
  const classicId = registry.find((skin) => skin.isClassic)?.id || registry[0]?.id;

  let preference = { version: 1, skinId: classicId, showCharacters: true, opacity: DEFAULT_OPACITY };
  /** Monotonic token: any load that finishes after a newer apply is discarded. */
  let loadSequence = 0;
  /** Exact-URL cache, so the same file is never fetched twice per session. */
  const decoded = new Map();

  const layer = document.getElementById(DECORATION_LAYER_ID);
  const shell = document.querySelector(".shell");
  const images = new Map();
  let positionFrame = 0;
  let trackingPositions = false;

  function clearFacePosition(image) {
    delete image.dataset.faceCentered;
    image.style.removeProperty("--skin-face-x");
    image.style.removeProperty("--skin-target-x");
  }

  /** Read existing board geometry only; all writes stay on fixed decorations. */
  function positionCharacters() {
    if (!layer || !shell || layer.dataset.skinCharacters !== "on") return;
    const viewport = layer.getBoundingClientRect();
    if (viewport.width <= 0) return; // Existing phone rule hides the whole layer.
    const board = shell.getBoundingClientRect();
    const boardLeft = Math.min(viewport.width, Math.max(0, board.left - viewport.left));
    const boardRight = Math.min(viewport.width, Math.max(boardLeft, board.right - viewport.left));
    // Finish both measurements before writing, so one image's transform cannot
    // interleave layout reads for its neighbour.
    const placements = [...images].map(([view, image]) => {
      const face = displayParamsFor(preference.skinId, currentTheme(), view)?.face;
      const width = image.getBoundingClientRect().width;
      const desired = view === "side" ? boardLeft / 2 : (boardRight + viewport.width) / 2;
      const target = image.hasAttribute("src") ? skinFaceTarget(face, width, viewport.width, desired) : null;
      return { image, face, target };
    });
    for (const { image, face, target } of placements) {
      if (target === null) {
        clearFacePosition(image); // Unannotated/custom skins retain static positioning.
      } else {
        image.style.setProperty("--skin-face-x", `${face.faceX * 100}%`);
        image.style.setProperty("--skin-target-x", `${target}px`);
        image.dataset.faceCentered = "1";
      }
    }
  }

  function schedulePositions() {
    if (positionFrame) return;
    positionFrame = window.requestAnimationFrame(() => {
      positionFrame = 0;
      positionCharacters();
    });
  }

  function trackPositions() {
    if (trackingPositions) return;
    trackingPositions = true;
    window.addEventListener("resize", schedulePositions, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(schedulePositions);
      observer.observe(layer);
      if (shell) observer.observe(shell);
      // Intrinsic image changes affect width; transforms never affect observed
      // box size, so these position writes cannot cause an observer loop.
      for (const image of images.values()) observer.observe(image);
    }
  }

  function skinFor(id) {
    return byId.get(id) || byId.get(classicId);
  }

  function isCharacter(skinId) {
    return Boolean(skinFor(skinId)) && !skinFor(skinId).isClassic;
  }

  /** Normalisation is owned by the registry; the runtime only reads its result. */
  function normalize(raw) {
    const source = normalizeSkinPreference(raw);
    // A skin id the registry no longer knows about degrades to no-skin, keeping
    // the rest of the validated preference intact.
    return { ...source, skinId: byId.has(source.skinId) ? source.skinId : classicId };
  }

  function persist() {
    storageWrite(SKIN_STORAGE_KEY, serializeSkinPreference(preference));
  }

  function restore() {
    const raw = storageRead(SKIN_STORAGE_KEY);
    if (raw === null || raw === "") return preference;
    try {
      preference = normalize(JSON.parse(raw));
    } catch {
      // Corrupt JSON falls back to the no-skin default rather than throwing.
      preference = normalize(null);
    }
    return preference;
  }

  /**
   * Resolve a public asset URL to whatever the current build can actually load.
   * The offline snapshot inlines all 40 files as data URLs under
   * `window.__CODEX_USAGE_SKIN_ASSETS__`; the live server serves the real path.
   * Everything that renders artwork must go through here, or the exported
   * snapshot would request sibling files that do not exist next to it.
   */
  function resolveAssetUrl(url) {
    if (!url) return null;
    const inlined = typeof window !== "undefined" ? window.__CODEX_USAGE_SKIN_ASSETS__ : null;
    return inlined?.[url] || url;
  }

  /**
   * Resolve the two image URLs for a skin/mode pair, or null when the layer must
   * stay empty. Classic deliberately has no assets and therefore no requests.
   */
  function urlsFor(skinId, theme) {
    const skin = skinFor(skinId);
    if (!skin || skin.isClassic) return null;
    // Registry shape (skins.js): variants[mode].assets.{side,front}. `mode` and
    // `theme` name the same axis.
    const variant = skin.variants?.[theme];
    if (!variant?.assets) return null;
    return {
      side: resolveAssetUrl(variant.assets.side),
      front: resolveAssetUrl(variant.assets.front),
    };
  }

  function ensureLayer() {
    if (layer) return layer;
    return null;
  }

  /** Measured per-image display parameters, or null when unmeasured/classic. */
  function displayParamsFor(skinId, theme, view) {
    if (typeof skinDisplayParams !== "function") return null;
    return skinDisplayParams(skinId, theme, view);
  }

  function ensureImages() {
    const host = ensureLayer();
    if (!host) return images;
    if (images.size) return images;
    for (const view of VIEW_ORDER) {
      const image = document.createElement("img");
      image.alt = "";
      image.decoding = "async";
      image.dataset.view = view;
      // Hidden until this exact URL has decoded, so a stale or partial frame is
      // never shown (plan 4.1).
      image.dataset.loaded = "0";
      host.appendChild(image);
      images.set(view, image);
    }
    trackPositions();
    return images;
  }

  /**
   * Decode one URL through the browser's real image pipeline.
   *
   * Successful decodes are cached by exact URL. Failures are evicted again, so a
   * transient error (offline blip, aborted request, missing file that appears
   * later) can be retried on the next apply instead of being remembered as
   * permanently broken for the rest of the session (P3.3 "recovery after error").
   */
  function decode(url) {
    if (decoded.has(url)) return decoded.get(url);
    const promise = new Promise((resolve) => {
      const probe = new Image();
      probe.onload = () => resolve({ url, ok: true });
      probe.onerror = () => resolve({ url, ok: false });
      probe.src = url;
    }).then((result) => {
      if (!result.ok) decoded.delete(url);
      return result;
    });
    decoded.set(url, promise);
    return promise;
  }

  /**
   * Drop the artwork but keep the layer itself.
   *
   * `dataset.url` is cleared together with `src`: leaving it behind made the next
   * apply of the SAME skin/mode believe the source was still attached, so the
   * image was never re-added and the character silently disappeared while the DOM
   * still reported `loaded=1` (hide-then-show, classic-then-back, retry-after-error).
   */
  function clearImages() {
    for (const image of images.values()) {
      image.dataset.loaded = "0";
      image.removeAttribute("src");
      delete image.dataset.url;
      clearFacePosition(image);
    }
  }

  /**
   * Apply the current preference to the DOM. Loads only the current skin and
   * mode; returning to classic or hiding characters performs no requests.
   */
  function apply() {
    const host = ensureLayer();
    if (!host) return;

    const root = document.documentElement;
    root.dataset.skin = preference.skinId;
    // Whole-page palette: remove every palette-driven variable first, then set
    // the current skin/mode's declarations. Removing unconditionally is what
    // lets a partial palette, a mode switch or a return to classic never leave
    // a previous skin's colours behind. The accent (--skin-active-accent) is
    // part of the declaration set, preserving the R2 accent-chain behaviour.
    for (const name of PALETTE_CSS_VAR_NAMES) root.style.removeProperty(name);
    const palette = isCharacter(preference.skinId) ? paletteDeclarations(preference.skinId, currentTheme()) : null;
    if (palette) {
      for (const [name, value] of palette) root.style.setProperty(name, value);
    }
    root.dataset.skinOpacity = String(preference.opacity);
    host.style.opacity = String(preference.opacity);

    const wantsCharacters = isCharacter(preference.skinId) && preference.showCharacters;
    const urls = wantsCharacters ? urlsFor(preference.skinId, currentTheme()) : null;

    // Root carries the state (matching the pre-paint bootstrap); the layer
    // carries the same flag because skins.css scopes its display rule to it.
    root.dataset.skinCharacters = wantsCharacters ? "on" : "off";
    host.dataset.skinCharacters = wantsCharacters ? "on" : "off";
    if (!urls) {
      // No skin selected, characters hidden, or the mode has no art: clear the
      // layer and drop the pending token so late responses cannot resurrect it.
      loadSequence += 1;
      clearImages();
      host.removeAttribute("data-skin");
      return;
    }

    loadSequence += 1;
    const token = loadSequence;
    host.dataset.skin = preference.skinId;
    const elements = ensureImages();

    for (const view of VIEW_ORDER) {
      const image = elements.get(view);
      const url = urls[view];
      if (!url) {
        // A missing view hides only that decoration; never borrow the other
        // mode's or another view's art to fill the gap.
        image.dataset.loaded = "0";
        image.removeAttribute("src");
        clearFacePosition(image);
        continue;
      }
      const attachedSrc = image.getAttribute("src");
      if (image.dataset.url === url && attachedSrc === url && image.dataset.loaded === "1") continue;
      if (image.dataset.url !== url || attachedSrc !== url) {
        // A different asset, or a source that was cleared/never attached (hide,
        // classic, or a previous failure): (re)attach it so the same skin/mode can
        // come back instead of staying blank while reporting success.
        image.dataset.loaded = "0";
        image.dataset.url = url;
        image.src = url;
      }
      // Per-image display parameters (measured ink box, P3.1). Applied as local
      // custom properties so the stylesheet owns the actual geometry and no
      // layout-affecting value is written inline.
      const params = displayParamsFor(preference.skinId, currentTheme(), view);
      if (params) {
        image.style.setProperty("--skin-scale", String(params.scale));
        image.style.setProperty("--skin-anchor-x", `${params.anchorX * 100}%`);
        image.dataset.skinScale = String(params.scale);
      } else {
        image.style.removeProperty("--skin-scale");
        image.style.removeProperty("--skin-anchor-x");
        delete image.dataset.skinScale;
      }
      decode(url).then(async (result) => {
        // Discard anything that resolved after a newer apply, or for a source the
        // layer no longer wants.
        if (token !== loadSequence || image.dataset.url !== url) return;
        let ready = result.ok;
        if (ready) {
          try {
            // The cached probe can finish before this DOM image. Await the
            // actual pixels so its width and face position are ready before paint.
            await image.decode();
          } catch {
            ready = false;
          }
        }
        if (token !== loadSequence || image.dataset.url !== url) return;
        if (ready) {
          positionCharacters();
          image.dataset.loaded = "1";
        } else {
          image.dataset.loaded = "0";
          image.removeAttribute("src");
          // Forget the failed URL as well, so the next apply re-attaches and
          // retries it rather than skipping it as "already current".
          delete image.dataset.url;
          decoded.delete(url);
          clearFacePosition(image);
        }
      });
    }
    schedulePositions();
  }

  function setPreference(patch) {
    const previous = preference.skinId;
    preference = normalize({ ...preference, ...patch });
    persist();
    apply();
    if (onChange) onChange(preference, { previousSkinId: previous });
    return preference;
  }

  function setSkin(skinId) {
    return setPreference({ skinId: byId.has(skinId) ? skinId : classicId });
  }

  function setShowCharacters(show) {
    return setPreference({ showCharacters: Boolean(show) });
  }

  function setOpacity(value) {
    return setPreference({ opacity: clampOpacity(value) });
  }

  /** Return to the no-skin state without touching the user's other settings. */
  function resetToClassic() {
    return setPreference({ skinId: classicId });
  }

  function resetOpacity() {
    return setPreference({ opacity: DEFAULT_OPACITY });
  }

  /** Re-resolve art after a theme switch; the mode owns which files are shown. */
  function handleThemeChange() {
    apply();
  }

  function handleLanguageChange() {
    // Names live in the picker; nothing in the layer depends on locale.
  }

  return {
    // state
    getPreference: () => ({ ...preference }),
    getSelectableSkins: () => registry.map((skin) => skin),
    storageKey: SKIN_STORAGE_KEY,
    // lifecycle
    restore,
    apply,
    handleThemeChange,
    handleLanguageChange,
    // mutations
    setSkin,
    setShowCharacters,
    setOpacity,
    resetToClassic,
    resetOpacity,
    // introspection for tests and the picker
    isCharacter,
    urlsFor,
    /** Palette slot for one skin/mode; null until the user supplies colours. */
    paletteFor: (skinId, mode) => skinFor(skinId)?.variants?.[mode]?.palette ?? null,
    clamping: { clampOpacity, DEFAULT_OPACITY },
  };
}

/**
 * Expose the runtime for browser-driven audits. Deliberately a plain object on
 * window rather than a module export, so the offline snapshot can reach it too.
 */
export function installSkinTestHook(runtime, picker) {
  if (typeof window === "undefined") return;
  window.__skinTestHook = {
    selectSkin: (id) => runtime.setSkin(id),
    setShowCharacters: (value) => runtime.setShowCharacters(value),
    setOpacity: (value) => runtime.setOpacity(value),
    resetToClassic: () => runtime.resetToClassic(),
    resetOpacity: () => runtime.resetOpacity(),
    getPreference: () => runtime.getPreference(),
    getSelectableSkins: () => runtime.getSelectableSkins().map((skin) => skin.id),
    openPicker: () => picker?.open(),
    closePicker: () => picker?.close(),
    isPickerOpen: () => picker?.isOpen() ?? false,
  };
}

export const SKIN_RUNTIME_CONSTANTS = Object.freeze({
  DECORATION_LAYER_ID,
  SKIN_STORAGE_KEY,
  VIEW_ORDER,
  DEFAULT_OPACITY,
});
