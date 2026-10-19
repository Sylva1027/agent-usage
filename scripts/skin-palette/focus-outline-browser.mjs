import {
  analyzeFocusOutlineAdjacentPixels,
  analyzeFocusOutlinePixels,
} from "./focus-outline-pixels.mjs";

const SELECTORS = new Set(["#addImportButton", "#pricingSearch"]);

const probe = (element, selector) => {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const effects = [];
  for (let node = element; node; node = node.parentElement) {
    const css = getComputedStyle(node);
    effects.push({
      tag: node.tagName,
      id: node.id,
      opacity: css.opacity,
      transform: css.transform,
      zoom: css.zoom,
      clip: css.clip,
      clipPath: css.clipPath,
      filter: css.filter,
      backdropFilter: css.backdropFilter,
      maskImage: css.maskImage,
      perspective: css.perspective,
      mixBlendMode: css.mixBlendMode,
      visibility: css.visibility,
      scrollLeft: node.scrollLeft,
      scrollTop: node.scrollTop,
    });
  }
  const matches = document.querySelectorAll(selector);
  return {
    identity: { count: matches.length, sameNode: matches[0] === element, connected: element.isConnected },
    active: document.activeElement === element,
    focusVisible: element.matches(":focus-visible"),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    scroll: { x: scrollX, y: scrollY },
    outline: {
      style: style.outlineStyle,
      width: style.outlineWidth,
      offset: style.outlineOffset,
      color: style.outlineColor,
    },
    radii: [
      style.borderTopLeftRadius,
      style.borderTopRightRadius,
      style.borderBottomRightRadius,
      style.borderBottomLeftRadius,
    ],
    inline: {
      hadStyle: element.hasAttribute("style"),
      value: element.style.getPropertyValue("outline-color"),
      priority: element.style.getPropertyPriority("outline-color"),
      other: Array.from(element.style)
        .filter((name) => name !== "outline-color")
        .map((name) => [name, element.style.getPropertyValue(name), element.style.getPropertyPriority(name)]),
    },
    spotlightCount: document.querySelectorAll("[data-spotlight-active]").length,
    effects,
  };
};

async function paint(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function rgba(color) {
  const match = /^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(color);
  if (!match) return null;
  const result = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 1) * 255];
  return result.every((value) => Number.isInteger(value) && value >= 0 && value <= 255) ? result : null;
}

function unsupported(state) {
  if (!state.identity.connected || !state.identity.sameNode || state.identity.count !== 1)
    return "target-identity-invalid";
  if (!state.active || !state.focusVisible) return "natural-focus-not-ready";
  if (state.viewport.dpr !== 1) return "unsupported-device-pixel-ratio";
  if (state.spotlightCount !== 0) return "spotlight-active";
  if (state.outline.style !== "solid" || state.outline.width !== "2px" || state.outline.offset !== "3px")
    return "unsupported-outline-style";
  if (state.radii.some((radius) => radius !== "11px")) return "unsupported-border-radius";
  if (rgba(state.outline.color)?.[3] !== 255) return "unsupported-outline-color";
  for (const effect of state.effects) {
    if (
      effect.opacity !== "1" ||
      effect.transform !== "none" ||
      !["1", "normal"].includes(effect.zoom) ||
      effect.clip !== "auto" ||
      effect.clipPath !== "none" ||
      effect.filter !== "none" ||
      effect.backdropFilter !== "none" ||
      effect.maskImage !== "none" ||
      effect.perspective !== "none" ||
      effect.mixBlendMode !== "normal" ||
      effect.visibility !== "visible"
    )
      return `unsupported-effect:${effect.tag}#${effect.id}`;
  }
  if (state.rect.width < 22 || state.rect.height < 22) return "unsupported-target-dimensions";
  return null;
}

function stableState(state) {
  const { color: _color, ...outline } = state.outline;
  const { hadStyle: _hadStyle, value: _value, priority: _priority, ...inline } = state.inline;
  return JSON.stringify({ ...state, outline, inline });
}

async function decode(page, png) {
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0);
    return {
      width: canvas.width,
      height: canvas.height,
      data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
    };
  }, png.toString("base64"));
}

function clipFor(rect) {
  const clip = { x: Math.floor(rect.x - 9), y: Math.floor(rect.y - 9) };
  clip.width = Math.ceil(rect.x + rect.width + 9) - clip.x;
  clip.height = Math.ceil(rect.y + rect.height + 9) - clip.y;
  return clip;
}

function isObjectLike(value) {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function attachEvidence(value, evidence, message) {
  if (isObjectLike(value)) {
    try {
      value.focusOutlineEvidence = evidence;
      return value;
    } catch {}
  }
  const error = new Error(message, { cause: value });
  error.focusOutlineEvidence = evidence;
  return error;
}

async function disposeHandles(handles) {
  const errors = [];
  for (const handle of handles) {
    try {
      await handle.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function operationFailure({ hasPrimaryError, primaryError, disposeErrors, evidence }) {
  if (hasPrimaryError && disposeErrors.length > 0) {
    const error = new AggregateError(
      [primaryError, ...disposeErrors],
      "焦点单帧捕获失败且 handle 清理失败",
      { cause: primaryError },
    );
    error.focusOutlineEvidence = evidence;
    return error;
  }
  if (hasPrimaryError) {
    return attachEvidence(primaryError, evidence, "焦点单帧捕获失败（原始错误保留在 cause）");
  }
  if (disposeErrors.length > 0) {
    if (disposeErrors.length === 1) {
      return attachEvidence(disposeErrors[0], evidence, "焦点单帧 handle 清理失败（原始错误保留在 cause）");
    }
    const error = new AggregateError(
      disposeErrors,
      "焦点单帧 handle 清理失败",
      { cause: disposeErrors[0] },
    );
    error.focusOutlineEvidence = evidence;
    return error;
  }
  return null;
}

export async function measureFocusOutlineAdjacentPixels({ page, selector }) {
  if (!SELECTORS.has(selector)) throw new TypeError(`不支持的焦点目标：${selector}`);
  const diagnostics = { selector, mutated: false, probes: {} };
  const captures = { clip: null, focused: null };
  const evidence = { diagnostics, captures };
  const reject = (reason) => ({
    analysis: { result: "unmeasured", ratio: null, threshold: 3, reason },
    diagnostics,
    captures,
    mutated: false,
  });

  let handles;
  try {
    handles = await page.$$(selector);
  } catch (error) {
    throw attachEvidence(error, evidence, "焦点单帧目标查询失败（原始错误保留在 cause）");
  }
  if (handles.length !== 1) {
    const disposeErrors = await disposeHandles(handles);
    const failure = operationFailure({
      hasPrimaryError: false,
      primaryError: undefined,
      disposeErrors,
      evidence,
    });
    if (failure) throw failure;
    return reject("target-not-unique");
  }

  const target = handles[0];
  let hasPrimaryError = false;
  let primaryError;
  let disposeErrors = [];
  let reason = null;
  let outcome = null;
  let before = null;
  try {
    before = await target.evaluate(probe, selector);
    diagnostics.probes.before = before;
    reason = unsupported(before);
    if (reason === null) {
      const { rect, viewport } = before;
      const clip = clipFor(rect);
      captures.clip = clip;
      if (
        clip.x < 0 ||
        clip.y < 0 ||
        clip.x + clip.width > viewport.width ||
        clip.y + clip.height > viewport.height
      ) {
        reason = "clip-outside-viewport";
      } else {
        captures.focused = await page.screenshot({
          type: "png",
          fullPage: false,
          scale: "css",
          caret: "initial",
          clip,
        });
        diagnostics.probes.afterFocused = await target.evaluate(probe, selector);
        if (JSON.stringify(before) !== JSON.stringify(diagnostics.probes.afterFocused)) {
          reason = "focused-capture-state-drift";
        } else {
          const decoded = await decode(page, captures.focused);
          diagnostics.decoded = { width: decoded.width, height: decoded.height };
          if (decoded.width !== clip.width || decoded.height !== clip.height) {
            throw new Error("焦点单帧 PNG 尺寸与 clip 不匹配");
          }
          diagnostics.probes.afterDecode = await target.evaluate(probe, selector);
          if (JSON.stringify(before) !== JSON.stringify(diagnostics.probes.afterDecode)) {
            reason = "decode-state-drift";
          } else {
            const analysis = analyzeFocusOutlineAdjacentPixels({
              width: clip.width,
              height: clip.height,
              focused: new Uint8Array(decoded.data),
              rect: { ...rect, x: rect.x - clip.x, y: rect.y - clip.y },
              outline: { width: 2, offset: 3, radius: 11, color: rgba(before.outline.color) },
            });
            outcome = { analysis, diagnostics, captures, mutated: false };
          }
        }
      }
    }
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    disposeErrors = await disposeHandles([target]);
  }

  const failure = operationFailure({
    hasPrimaryError,
    primaryError,
    disposeErrors,
    evidence,
  });
  if (failure) throw failure;
  return outcome ?? reject(reason ?? "analysis-not-complete");
}

export async function measureFocusOutlinePixels({ page, selector }) {
  if (!SELECTORS.has(selector)) throw new TypeError(`不支持的焦点目标：${selector}`);
  const diagnostics = { selector, probes: {}, restoration: { attempted: false, verified: false } };
  const captures = { clip: null, focused: null, withoutOutline: null, restored: null };
  const reject = (reason) => ({
    analysis: { result: "unmeasured", ratio: null, threshold: 3, reason },
    diagnostics,
    captures,
  });
  const handles = await page.$$(selector);
  if (handles.length !== 1) {
    await Promise.all(handles.map((handle) => handle.dispose()));
    return reject("target-not-unique");
  }
  const target = handles[0];
  let primaryError = null;
  let restorationError = null;
  let changed = false;
  let reason = null;
  let before = null;
  try {
    before = await target.evaluate(probe, selector);
    diagnostics.probes.before = before;
    reason = unsupported(before);
    if (reason) return reject(reason);
    const { rect, viewport } = before;
    const clip = clipFor(rect);
    captures.clip = clip;
    if (clip.x < 0 || clip.y < 0 || clip.x + clip.width > viewport.width || clip.y + clip.height > viewport.height)
      return reject("clip-outside-viewport");
    const screenshot = () => page.screenshot({ type: "png", fullPage: false, scale: "css", caret: "initial", clip });
    try {
      captures.focused = await screenshot();
      diagnostics.probes.afterFocused = await target.evaluate(probe, selector);
      if (JSON.stringify(before) !== JSON.stringify(diagnostics.probes.afterFocused)) {
        reason = "focused-capture-state-drift";
      } else {
        changed = true;
        await target.evaluate((element) => element.style.setProperty("outline-color", "transparent", "important"));
        await paint(page);
        diagnostics.probes.hidden = await target.evaluate(probe, selector);
        if (
          rgba(diagnostics.probes.hidden.outline.color)?.[3] !== 0 ||
          stableState(before) !== stableState(diagnostics.probes.hidden)
        ) {
          reason = "outline-isolation-state-mismatch";
        } else {
          captures.withoutOutline = await screenshot();
          diagnostics.probes.afterWithoutOutline = await target.evaluate(probe, selector);
          if (JSON.stringify(diagnostics.probes.hidden) !== JSON.stringify(diagnostics.probes.afterWithoutOutline))
            reason = "hidden-capture-state-drift";
        }
      }
    } catch (error) {
      primaryError = error;
    } finally {
      if (changed) {
        diagnostics.restoration.attempted = true;
        try {
          await target.evaluate((element, inline) => {
            if (inline.value) element.style.setProperty("outline-color", inline.value, inline.priority);
            else element.style.removeProperty("outline-color");
            if (!inline.hadStyle && element.style.length === 0) element.removeAttribute("style");
          }, before.inline);
          await paint(page);
          diagnostics.probes.restored = await target.evaluate(probe, selector);
          diagnostics.restoration.verified = JSON.stringify(before) === JSON.stringify(diagnostics.probes.restored);
          if (!diagnostics.restoration.verified)
            restorationError = new Error("焦点轮廓恢复后的节点、样式、焦点或几何不一致");
        } catch (error) {
          restorationError = error;
        }
      }
    }
    if (primaryError || restorationError) {
      const error =
        primaryError && restorationError
          ? new AggregateError([primaryError, restorationError], "焦点截图失败且恢复失败")
          : (primaryError ?? restorationError);
      error.focusOutlineEvidence = { diagnostics, captures };
      throw error;
    }
    if (reason) return reject(reason);
    captures.restored = await screenshot();
    diagnostics.probes.afterRestored = await target.evaluate(probe, selector);
    if (JSON.stringify(before) !== JSON.stringify(diagnostics.probes.afterRestored))
      return reject("restored-capture-state-drift");
    const decoded = await Promise.all(
      [captures.focused, captures.withoutOutline, captures.restored].map((png) => decode(page, png)),
    );
    diagnostics.decoded = decoded.map(({ width, height }) => ({ width, height }));
    if (decoded.some(({ width, height }) => width !== clip.width || height !== clip.height))
      throw new Error("三帧 PNG 尺寸与同一 clip 不匹配");
    diagnostics.probes.afterDecode = await target.evaluate(probe, selector);
    if (JSON.stringify(before) !== JSON.stringify(diagnostics.probes.afterDecode)) return reject("decode-state-drift");
    const analysis = analyzeFocusOutlinePixels({
      width: clip.width,
      height: clip.height,
      focused: new Uint8Array(decoded[0].data),
      withoutOutline: new Uint8Array(decoded[1].data),
      restored: new Uint8Array(decoded[2].data),
      rect: { ...rect, x: rect.x - clip.x, y: rect.y - clip.y },
      outline: { width: 2, offset: 3, radius: 11, color: rgba(before.outline.color) },
    });
    return { analysis, diagnostics, captures };
  } catch (error) {
    error.focusOutlineEvidence ??= { diagnostics, captures };
    throw error;
  } finally {
    await target.dispose();
  }
}
