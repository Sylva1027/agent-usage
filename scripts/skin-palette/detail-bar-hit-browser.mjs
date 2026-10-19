import { randomUUID } from "node:crypto";

/**
 * Detail bar native 命中诊断（M5.2.P-C15 / B43 / B45 / B47）。
 *
 * 两个固定入口共享同一页内 stash、精确对象比较和 CDP/cleanup 核心：
 * 原左/中/右三点入口，以及覆盖中心条每个像素中心的入口。
 * `observed` 不证明 pseudo 绘制、RGB、整行或整 bar 可见。
 */

const STASH_KEY = "__codexSkinDetailBarHitV1__";
const SOURCE = "detail-bar-native-hits";
const POINT_KINDS = Object.freeze(["left", "center", "right"]);

class DiagnosticRejected extends Error {}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readClip(value) {
  if (!isRecord(value)) throw new TypeError("clip 必须是 { x, y, width, height } 对象");
  const clip = { x: value.x, y: value.y, width: value.width, height: value.height };
  for (const [key, coordinate] of Object.entries(clip)) {
    if (!Number.isSafeInteger(coordinate)) throw new TypeError(`clip.${key} 必须是安全整数`);
  }
  if (clip.x < 0 || clip.y < 0) throw new TypeError("clip.x/y 必须非负");
  if (clip.width <= 0 || clip.height !== 1) {
    throw new TypeError("clip 必须是正整数宽且恰好 1 像素高");
  }
  return clip;
}

function buildThreeCenterRowPoints(clip) {
  const y = clip.y + 0.5;
  const xs = [clip.x + 0.5, clip.x + clip.width / 2, clip.x + clip.width - 0.5];
  return POINT_KINDS.map((kind, index) => {
    const point = {
      kind,
      x: xs[index],
      y,
      integer: { x: Math.floor(xs[index]), y: Math.floor(y) },
    };
    if (!insideClip(point, clip)) throw new TypeError(`clip 的 ${kind} 中心点映射越出 clip`);
    return point;
  });
}

function validateCenterStripClip(clip, viewport) {
  if (
    !Number.isSafeInteger(viewport?.width) ||
    !Number.isSafeInteger(viewport?.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    throw new DiagnosticRejected("viewport-dimensions-invalid");
  }
  if (clip.x > Number.MAX_SAFE_INTEGER - clip.width) {
    throw new DiagnosticRejected("clip-coordinate-overflow:x");
  }
  if (clip.y > Number.MAX_SAFE_INTEGER - clip.height) {
    throw new DiagnosticRejected("clip-coordinate-overflow:y");
  }
  if (clip.x + clip.width > viewport.width || clip.y + clip.height > viewport.height) {
    throw new DiagnosticRejected("clip-outside-viewport");
  }
}

function buildCenterStripPoints(clip, viewport) {
  // 先证明固定 clip 落在真实 viewport 且加法安全，再按 width 分配。
  validateCenterStripClip(clip, viewport);
  const y = clip.y + 0.5;
  const points = new Array(clip.width);
  for (let index = 0; index < clip.width; index += 1) {
    const integerX = clip.x + index;
    points[index] = {
      kind: `pixel-${index}`,
      x: integerX + 0.5,
      y,
      integer: { x: integerX, y: clip.y },
    };
  }
  return points;
}

function insideClip(point, clip) {
  return (
    point.x >= clip.x &&
    point.x < clip.x + clip.width &&
    point.y >= clip.y &&
    point.y < clip.y + 1 &&
    point.integer.x >= clip.x &&
    point.integer.x < clip.x + clip.width &&
    point.integer.y >= clip.y &&
    point.integer.y < clip.y + 1
  );
}

function attachEvidence(error, evidence) {
  try {
    if (error && (typeof error === "object" || typeof error === "function")) {
      Object.defineProperty(error, "detailBarHitEvidence", {
        value: evidence,
        writable: true,
        configurable: true,
        enumerable: false,
      });
      return true;
    }
  } catch {
    // 诊断附加失败不能替换原错误值。
  }
  return false;
}

function describeThrown(error) {
  return error instanceof Error ? error.message : `thrown:${String(error)}`;
}

function firstSnapshotDifference(baseline, current) {
  const keys = new Set([...Object.keys(baseline ?? {}), ...Object.keys(current ?? {})]);
  for (const key of keys) {
    if (JSON.stringify(baseline?.[key]) !== JSON.stringify(current?.[key])) return key;
  }
  return null;
}

function installDetailBarHitStash(fill, { key, token, requireActiveDetailPanel = false }) {
  if (Object.hasOwn(window, key)) {
    return { status: "rejected", reason: "stash-occupied" };
  }
  if (fill?.nodeType !== 1 || fill.isConnected !== true) {
    return { status: "rejected", reason: "fill-not-connected" };
  }
  if (window.top !== window || fill.ownerDocument !== document) {
    return { status: "rejected", reason: "fill-not-in-main-frame" };
  }
  if (typeof fill.getRootNode === "function" && fill.getRootNode() !== document) {
    return { status: "rejected", reason: "fill-not-in-main-document" };
  }
  if (window.devicePixelRatio !== 1) {
    return { status: "rejected", reason: `dpr-not-one:${window.devicePixelRatio}` };
  }

  let panel = null;
  let detailPanel = null;
  if (requireActiveDetailPanel) {
    const panels = Array.from(document.querySelectorAll("#detailPanel"));
    const activeHosts = Array.from(document.querySelectorAll("[data-spotlight-active]"));
    if (panels.length !== 1) return { status: "rejected", reason: `active-panel-count:${panels.length}` };
    panel = panels[0];
    if (
      panel?.isConnected !== true ||
      activeHosts.length !== 1 ||
      activeHosts[0] !== panel ||
      typeof panel.hasAttribute !== "function" ||
      !panel.hasAttribute("data-spotlight-active")
    ) {
      return { status: "rejected", reason: "active-panel-not-sole-active-detail-panel" };
    }
    if (
      typeof panel.contains !== "function" ||
      !panel.contains(fill) ||
      typeof fill.closest !== "function" ||
      fill.closest("#detailPanel") !== panel
    ) {
      return { status: "rejected", reason: "fill-not-in-active-detail-panel" };
    }
    detailPanel = {
      connected: true,
      tag: String(panel.tagName || "").toLowerCase(),
      id: String(panel.id || ""),
      className: String(panel.className || ""),
      activeHostCount: activeHosts.length,
      activeHostIsPanel: activeHosts.length === 1 && activeHosts[0] === panel,
      fillInPanel: true,
    };
  }

  const rect = fill.getBoundingClientRect();
  const style = getComputedStyle(fill);
  const snapshot = {
    connected: true,
    tag: String(fill.tagName || "").toLowerCase(),
    id: String(fill.id || ""),
    className: String(fill.className || ""),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
    },
    style: {
      display: String(style.display || ""),
      visibility: String(style.visibility || ""),
      opacity: String(style.opacity || ""),
      pointerEvents: String(style.pointerEvents || ""),
      backgroundColor: String(style.backgroundColor || ""),
      backgroundImage: String(style.backgroundImage || ""),
    },
  };
  window[key] = { token, fill, panel, requireActiveDetailPanel };
  return { status: "installed", snapshot, detailPanel };
}

function readDetailBarHitSnapshot(fill, { key, token }) {
  const state = window[key];
  if (!state || state.token !== token) {
    return { status: "rejected", reason: "stash-token-mismatch" };
  }
  if (state.fill !== fill) return { status: "rejected", reason: "fill-identity-mismatch" };
  if (fill.isConnected !== true) return { status: "rejected", reason: "fill-not-connected" };
  if (window.top !== window || fill.ownerDocument !== document) {
    return { status: "rejected", reason: "fill-not-in-main-frame" };
  }
  if (typeof fill.getRootNode === "function" && fill.getRootNode() !== document) {
    return { status: "rejected", reason: "fill-not-in-main-document" };
  }

  let detailPanel = null;
  if (state.requireActiveDetailPanel === true) {
    const panel = state.panel;
    const panels = Array.from(document.querySelectorAll("#detailPanel"));
    const activeHosts = Array.from(document.querySelectorAll("[data-spotlight-active]"));
    if (
      panel?.isConnected !== true ||
      panels.length !== 1 ||
      panels[0] !== panel ||
      activeHosts.length !== 1 ||
      activeHosts[0] !== panel ||
      typeof panel.hasAttribute !== "function" ||
      !panel.hasAttribute("data-spotlight-active")
    ) {
      return { status: "rejected", reason: "active-detail-panel-binding-changed" };
    }
    if (
      typeof panel.contains !== "function" ||
      !panel.contains(fill) ||
      typeof fill.closest !== "function" ||
      fill.closest("#detailPanel") !== panel
    ) {
      return { status: "rejected", reason: "fill-detail-panel-binding-changed" };
    }
    detailPanel = {
      connected: true,
      tag: String(panel.tagName || "").toLowerCase(),
      id: String(panel.id || ""),
      className: String(panel.className || ""),
      activeHostCount: activeHosts.length,
      activeHostIsPanel: activeHosts.length === 1 && activeHosts[0] === panel,
      fillInPanel: true,
    };
  }

  const rect = fill.getBoundingClientRect();
  const style = getComputedStyle(fill);
  return {
    status: "observed",
    detailPanel,
    snapshot: {
      connected: true,
      tag: String(fill.tagName || "").toLowerCase(),
      id: String(fill.id || ""),
      className: String(fill.className || ""),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
      style: {
        display: String(style.display || ""),
        visibility: String(style.visibility || ""),
        opacity: String(style.opacity || ""),
        pointerEvents: String(style.pointerEvents || ""),
        backgroundColor: String(style.backgroundColor || ""),
        backgroundImage: String(style.backgroundImage || ""),
      },
    },
  };
}

function readDetailBarDomHits(fill, { key, token, points }) {
  const state = window[key];
  if (!state || state.token !== token) {
    return { status: "rejected", reason: "stash-token-mismatch" };
  }
  if (state.fill !== fill) return { status: "rejected", reason: "fill-identity-mismatch" };
  if (typeof document.elementFromPoint !== "function") {
    return { status: "rejected", reason: "elementFromPoint-unavailable" };
  }

  const identity = (node) =>
    node
      ? {
          tag: String(node.tagName || "").toLowerCase(),
          id: String(node.id || ""),
          className: String(node.className || ""),
          connected: node.isConnected === true,
        }
      : null;
  return {
    status: "observed",
    hits: points.map((point) => {
      let hit = null;
      let error = null;
      try {
        hit = document.elementFromPoint(point.x, point.y);
      } catch (thrown) {
        error = String(thrown);
      }
      return {
        kind: point.kind,
        x: point.x,
        y: point.y,
        exactFill: hit === fill,
        withinFill: Boolean(hit && (hit === fill || (typeof fill.contains === "function" && fill.contains(hit)))),
        top: identity(hit),
        error,
      };
    }),
  };
}

function clearDetailBarHitStash(fill, { key, token }) {
  if (!Object.hasOwn(window, key)) {
    return { status: "cleared", changed: false };
  }
  const state = window[key];
  if (!state || state.token !== token) {
    return { status: "rejected", reason: "stash-token-mismatch" };
  }
  const ownerMatches = state.fill === fill;
  delete window[key];
  return { status: "cleared", changed: true, ownerMatches };
}

function compareNativeHit(hit, panel, requireActiveDetailPanel) {
  const typeName = (value) => {
    try {
      return String(value?.constructor?.name || Object.prototype.toString.call(value));
    } catch {
      return "unreadable";
    }
  };
  const safeValue = (value, property) => {
    try {
      const result = value?.[property];
      return ["string", "number", "boolean"].includes(typeof result) ? result : null;
    } catch {
      return null;
    }
  };
  const objectTag = (value) => {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "unreadable";
    }
  };
  const readObject = (value, property) => {
    try {
      return value?.[property] ?? null;
    } catch {
      return null;
    }
  };
  const brand = (value) => {
    let isNode = false;
    let isElement = false;
    try {
      isNode = typeof Node === "function" && value instanceof Node;
      isElement = typeof Element === "function" && value instanceof Element;
    } catch {
      // A failed intrinsic check remains a safe non-element rejection.
    }
    return { isNode, isElement };
  };
  const identityFor = (value) => {
    const current = brand(value);
    return current.isElement
      ? {
          tag: String(value.tagName || "").toLowerCase(),
          id: String(value.id || ""),
          className: String(value.className || ""),
          connected: value.isConnected === true,
        }
      : {
          tag: "",
          id: "",
          className: "",
          connected: safeValue(value, "isConnected") === true,
          kind: current.isNode ? "node-not-element" : "non-node",
          valueType: typeof value,
          constructorName: typeName(value),
          toStringTag: objectTag(value),
          nodeType: safeValue(value, "nodeType"),
          nodeName: safeValue(value, "nodeName"),
          pseudoType: safeValue(value, "pseudoType"),
          type: safeValue(value, "type"),
        };
  };
  const hitBrand = brand(hit);
  let isCssPseudoElement = false;
  try {
    isCssPseudoElement = typeof CSSPseudoElement === "function" && hit instanceof CSSPseudoElement;
  } catch {
    // Missing or throwing CSSPseudoElement brand support stays rejected.
  }
  const pseudoType = safeValue(hit, "type");
  const origin = readObject(hit, "element");
  const parent = readObject(hit, "parent");
  const panelConnected = panel?.isConnected === true;
  let panelSoleActive = false;
  let fillInPanel = false;
  try {
    const activeHosts = panel ? Array.from(document.querySelectorAll("[data-spotlight-active]")) : [];
    panelSoleActive =
      panelConnected &&
      activeHosts.length === 1 &&
      activeHosts[0] === panel &&
      typeof panel.hasAttribute === "function" &&
      panel.hasAttribute("data-spotlight-active");
    fillInPanel =
      panelConnected &&
      typeof panel.contains === "function" &&
      panel.contains(this) &&
      typeof this.closest === "function" &&
      this.closest("#detailPanel") === panel;
  } catch {
    // Binding failures remain observable rejections.
  }
  const checks = {
    pseudoBrand: isCssPseudoElement,
    typeAfter: pseudoType === "::after",
    originIsPanel: origin === panel,
    parentIsPanel: parent === panel,
    panelConnected,
    panelSoleActive,
    fillInPanel,
  };
  const spotlightAccepted = requireActiveDetailPanel === true && Object.values(checks).every((value) => value === true);
  const exactFill = hitBrand.isElement && hit === this;
  const accepted = exactFill || spotlightAccepted;
  const inactiveReason = hitBrand.isElement ? "" : hitBrand.isNode ? "native-node-not-element" : "native-non-node";
  const activeReason = !isCssPseudoElement
    ? "native-active-spotlight-brand-missing"
    : !checks.typeAfter
      ? "native-active-spotlight-type-mismatch"
      : !checks.originIsPanel
        ? "native-active-spotlight-origin-mismatch"
        : !checks.parentIsPanel
          ? "native-active-spotlight-parent-mismatch"
          : !checks.panelConnected || !checks.panelSoleActive || !checks.fillInPanel
            ? "native-active-spotlight-panel-binding-mismatch"
            : "native-active-spotlight-unexpected";
  return {
    exactFill,
    withinFill: hitBrand.isElement
      ? Boolean(hit === this || (typeof this.contains === "function" && this.contains(hit)))
      : false,
    fillConnected: this.isConnected === true,
    top: identityFor(hit),
    hitKind: hitBrand.isElement ? "element" : hitBrand.isNode ? "node-not-element" : "non-node",
    expectedDetailSpotlight: spotlightAccepted,
    rejected: !accepted,
    reason: accepted ? "" : requireActiveDetailPanel === true ? activeReason : inactiveReason,
    detailSpotlight: {
      required: requireActiveDetailPanel === true,
      accepted: spotlightAccepted,
      checks,
      identity: {
        type: pseudoType,
        origin: identityFor(origin),
        parent: identityFor(parent),
        panel: identityFor(panel),
      },
    },
  };
}

const NATIVE_HIT_DECLARATION = compareNativeHit.toString();

function readFrameId(frameTree) {
  const frameId = frameTree?.frameTree?.frame?.id;
  return typeof frameId === "string" && frameId !== "" ? frameId : null;
}

async function retainNativeNodeDescription(cdpSession, nativePoint) {
  try {
    const described = await cdpSession.send("DOM.describeNode", {
      backendNodeId: nativePoint.native.backendNodeId,
      depth: 0,
    });
    nativePoint.native.nodeDescription =
      described?.node && typeof described.node === "object"
        ? { status: "observed", node: described.node }
        : { status: "missing-node", response: described ?? null };
  } catch (error) {
    nativePoint.native.nodeDescription = { status: "failed", error: describeThrown(error) };
  }
}

function stashObjectExpression(token) {
  return `(() => {
    const state = window[${JSON.stringify(STASH_KEY)}];
    return state && state.token === ${JSON.stringify(token)} ? state.fill : null;
  })()`;
}

function stashPanelObjectExpression(token) {
  return `(() => {
    const state = window[${JSON.stringify(STASH_KEY)}];
    return state && state.token === ${JSON.stringify(token)} ? state.panel : null;
  })()`;
}

async function probeDetailBarHits(options, { entryName, scope, makePoints, requireActiveDetailPanel = false }) {
  if (!isRecord(options)) throw new TypeError(`${entryName}: 需要 { page, fill, clip }`);
  const { page, fill } = options;
  if (!page || typeof page.context !== "function") {
    throw new TypeError(`${entryName}: page 需要 context()`);
  }
  if (!fill || typeof fill.evaluate !== "function") {
    throw new TypeError(`${entryName}: 需要同一个 fill ElementHandle`);
  }
  const clip = readClip(options.clip);
  const token = randomUUID();
  const objectGroup = `codex-detail-bar-hit-v1:${token}`;
  const evidence = {
    status: "incomplete",
    reason: "",
    source: SOURCE,
    scope,
    paintMode: requireActiveDetailPanel ? "active-detail" : "exact-fill",
    clip,
    frame: { main: null },
    fill: null,
    detailPanel: null,
    admission: { requireActiveDetailPanel },
    domHits: [],
    points: [],
    pointerEvents: { before: null, after: null, unchanged: null },
    stash: { installed: false, cleared: false },
    cleanup: { releaseObjectGroup: "not-run", detach: "not-run", stash: "not-run" },
  };

  let cdpSession = null;
  let stashOwned = false;
  let baselineSnapshot = null;
  let baselineDetailPanel = null;
  let primaryFailure = false;
  let primaryError;
  let rejectedReason = "";
  const cleanupErrors = [];

  try {
    const installed = await fill.evaluate(installDetailBarHitStash, {
      key: STASH_KEY,
      token,
      requireActiveDetailPanel,
    });
    if (installed?.status !== "installed") {
      throw new DiagnosticRejected(installed?.reason ?? "stash-install-rejected");
    }
    stashOwned = true;
    evidence.stash.installed = true;
    baselineSnapshot = installed.snapshot;
    baselineDetailPanel = installed.detailPanel ?? null;
    evidence.fill = baselineSnapshot;
    evidence.detailPanel = baselineDetailPanel;
    evidence.pointerEvents.before = baselineSnapshot.style.pointerEvents;
    if (baselineSnapshot.viewport?.dpr !== 1) {
      throw new DiagnosticRejected(`dpr-not-one:${baselineSnapshot.viewport?.dpr}`);
    }
    if (
      !Number.isSafeInteger(baselineSnapshot.viewport?.scrollX) ||
      !Number.isSafeInteger(baselineSnapshot.viewport?.scrollY)
    ) {
      throw new DiagnosticRejected("viewport-scroll-not-safe-integer");
    }
    const points = makePoints(clip, baselineSnapshot.viewport);
    for (const point of points) {
      if (
        !(point.x >= 0 && point.x < baselineSnapshot.viewport.width) ||
        !(point.y >= 0 && point.y < baselineSnapshot.viewport.height) ||
        !(point.integer.x >= 0 && point.integer.x < baselineSnapshot.viewport.width) ||
        !(point.integer.y >= 0 && point.integer.y < baselineSnapshot.viewport.height)
      ) {
        throw new DiagnosticRejected(`point-outside-viewport:${point.kind}`);
      }
    }

    const context = page.context();
    if (!context || typeof context.newCDPSession !== "function") {
      throw new TypeError(`${entryName}: page.context().newCDPSession 不可用`);
    }
    cdpSession = await context.newCDPSession(page);

    const frameTree = await cdpSession.send("Page.getFrameTree");
    const mainFrameId = readFrameId(frameTree);
    if (!mainFrameId) throw new Error(`${entryName}: 无法取得主 frame id`);
    evidence.frame.main = mainFrameId;

    const stashResult = await cdpSession.send("Runtime.evaluate", {
      expression: stashObjectExpression(token),
      objectGroup,
    });
    const fillObjectId = stashResult?.result?.objectId;
    if (stashResult?.exceptionDetails || typeof fillObjectId !== "string" || fillObjectId === "") {
      throw new Error(`${entryName}: 无法取得 stash.fill 的 CDP 对象`);
    }
    let detailPanelObjectId = null;
    if (requireActiveDetailPanel) {
      const panelResult = await cdpSession.send("Runtime.evaluate", {
        expression: stashPanelObjectExpression(token),
        objectGroup,
      });
      detailPanelObjectId = panelResult?.result?.objectId;
      if (panelResult?.exceptionDetails || typeof detailPanelObjectId !== "string" || detailPanelObjectId === "") {
        throw new Error(`${entryName}: 无法取得 stash.panel 的 CDP 对象`);
      }
    }

    const domResult = await fill.evaluate(readDetailBarDomHits, { key: STASH_KEY, token, points });
    if (domResult?.status !== "observed") {
      throw new DiagnosticRejected(domResult?.reason ?? "dom-hit-unavailable");
    }
    evidence.domHits = domResult.hits;
    const badDom = domResult.hits.find((hit) => hit.exactFill !== true);
    if (badDom) throw new DiagnosticRejected(`dom-non-fill:${badDom.kind}`);

    for (const [index, point] of points.entries()) {
      const documentInteger = {
        x: point.integer.x + baselineSnapshot.viewport.scrollX,
        y: point.integer.y + baselineSnapshot.viewport.scrollY,
      };
      if (!Number.isSafeInteger(documentInteger.x) || !Number.isSafeInteger(documentInteger.y)) {
        throw new DiagnosticRejected(`point-document-overflow:${point.kind}`);
      }
      const location = await cdpSession.send("DOM.getNodeForLocation", {
        x: documentInteger.x,
        y: documentInteger.y,
        ignorePointerEventsNone: true,
      });
      if (!Number.isInteger(location?.backendNodeId) || location.backendNodeId <= 0) {
        throw new Error(`${entryName}: ${point.kind} 未返回有效 backendNodeId`);
      }
      const nativePoint = {
        kind: point.kind,
        x: point.x,
        y: point.y,
        integer: { ...point.integer },
        dom: domResult.hits[index],
        native: {
          frameId: location.frameId ?? null,
          backendNodeId: location.backendNodeId,
          documentInteger,
          exactFill: null,
          withinFill: null,
          fillConnected: null,
          top: null,
        },
        domNativeDiffer: null,
      };
      evidence.points.push(nativePoint);

      if (location.frameId !== mainFrameId) {
        throw new DiagnosticRejected(`native-frame-not-main:${point.kind}:${String(location.frameId)}`);
      }

      const resolved = await cdpSession.send("DOM.resolveNode", {
        backendNodeId: location.backendNodeId,
        objectGroup,
      });
      const hitObjectId = resolved?.object?.objectId;
      if (typeof hitObjectId !== "string" || hitObjectId === "") {
        throw new Error(`${entryName}: ${point.kind} backendNodeId 无法解析为对象`);
      }
      const compared = await cdpSession.send("Runtime.callFunctionOn", {
        objectId: fillObjectId,
        functionDeclaration: NATIVE_HIT_DECLARATION,
        arguments: [
          { objectId: hitObjectId },
          detailPanelObjectId === null ? { value: null } : { objectId: detailPanelObjectId },
          { value: requireActiveDetailPanel },
        ],
        returnByValue: true,
      });
      if (compared?.exceptionDetails) {
        nativePoint.native.exceptionDetails = compared.exceptionDetails;
        await retainNativeNodeDescription(cdpSession, nativePoint);
        throw new Error(`${entryName}: ${point.kind} 严格对象比较抛出异常`);
      }
      const nativeHit = compared?.result?.value;
      if (
        !nativeHit ||
        typeof nativeHit !== "object" ||
        typeof nativeHit.exactFill !== "boolean" ||
        typeof nativeHit.withinFill !== "boolean" ||
        typeof nativeHit.fillConnected !== "boolean"
      ) {
        throw new Error(`${entryName}: ${point.kind} 严格对象比较结果无效`);
      }
      nativePoint.native = { ...nativePoint.native, ...nativeHit };
      nativePoint.domNativeDiffer =
        nativePoint.dom.exactFill !== nativeHit.exactFill ||
        JSON.stringify(nativePoint.dom.top) !== JSON.stringify(nativeHit.top);
      if (nativeHit.fillConnected !== true) {
        throw new DiagnosticRejected(`fill-disconnected:${point.kind}`);
      }
      const nativeAccepted =
        nativeHit.exactFill === true || (requireActiveDetailPanel && nativeHit.expectedDetailSpotlight === true);
      if (!nativeAccepted) {
        await retainNativeNodeDescription(cdpSession, nativePoint);
        const reason =
          nativeHit.rejected === true && typeof nativeHit.reason === "string" && nativeHit.reason !== ""
            ? nativeHit.reason
            : "native-non-fill";
        throw new DiagnosticRejected(`${reason}:${point.kind}`);
      }

      const snapshotResult = await fill.evaluate(readDetailBarHitSnapshot, { key: STASH_KEY, token });
      if (snapshotResult?.status !== "observed") {
        throw new DiagnosticRejected(snapshotResult?.reason ?? "snapshot-unavailable");
      }
      if (requireActiveDetailPanel) {
        const panelDrift = firstSnapshotDifference(baselineDetailPanel, snapshotResult.detailPanel);
        if (panelDrift) {
          throw new DiagnosticRejected(`detail-panel-binding-drift:${point.kind}:${panelDrift}`);
        }
      }
      const drift = firstSnapshotDifference(baselineSnapshot, snapshotResult.snapshot);
      if (drift) throw new DiagnosticRejected(`layout-drift:${point.kind}:${drift}`);
      evidence.pointerEvents.after = snapshotResult.snapshot.style.pointerEvents;
      evidence.pointerEvents.unchanged = evidence.pointerEvents.before === evidence.pointerEvents.after;
    }
  } catch (error) {
    if (error instanceof DiagnosticRejected) {
      rejectedReason = error.message;
    } else {
      primaryFailure = true;
      primaryError = error;
    }
  } finally {
    if (cdpSession) {
      try {
        await cdpSession.send("Runtime.releaseObjectGroup", { objectGroup });
        evidence.cleanup.releaseObjectGroup = "released";
      } catch (error) {
        cleanupErrors.push(error);
        evidence.cleanup.releaseObjectGroup = "failed";
      }
      try {
        await cdpSession.detach();
        evidence.cleanup.detach = "detached";
      } catch (error) {
        cleanupErrors.push(error);
        evidence.cleanup.detach = "failed";
      }
    }
    if (stashOwned) {
      try {
        const cleared = await fill.evaluate(clearDetailBarHitStash, { key: STASH_KEY, token });
        if (cleared?.status !== "cleared") {
          cleanupErrors.push(new Error(`stash-cleanup-rejected:${cleared?.reason ?? "missing"}`));
          evidence.cleanup.stash = "failed";
        } else {
          evidence.cleanup.stash = "cleared";
          evidence.stash.cleared = true;
        }
      } catch (error) {
        cleanupErrors.push(error);
        evidence.cleanup.stash = "failed";
      }
    }
  }

  if (primaryFailure) {
    evidence.status = "failed";
    evidence.reason = describeThrown(primaryError);
    if (cleanupErrors.length > 0) {
      const failure = new AggregateError(
        [primaryError, ...cleanupErrors],
        "detail bar native hit probe 失败且清理失败",
        { cause: primaryError },
      );
      attachEvidence(failure, evidence);
      throw failure;
    }
    if (attachEvidence(primaryError, evidence)) throw primaryError;
    const failure = new Error("detail bar native hit probe 失败（原始错误保留在 cause）", {
      cause: primaryError,
    });
    attachEvidence(failure, evidence);
    throw failure;
  }
  if (cleanupErrors.length > 0) {
    evidence.status = "failed";
    evidence.reason = `cleanup-failed:${cleanupErrors.map(describeThrown).join(";")}`;
    const failure = new AggregateError(cleanupErrors, "detail bar native hit probe 清理失败");
    attachEvidence(failure, evidence);
    throw failure;
  }
  if (rejectedReason) {
    evidence.status = "rejected";
    evidence.reason = rejectedReason;
    return evidence;
  }

  evidence.status = "observed";
  evidence.pointerEvents.after ??= baselineSnapshot?.style?.pointerEvents ?? null;
  evidence.pointerEvents.unchanged ??= evidence.pointerEvents.before === evidence.pointerEvents.after;
  return evidence;
}

/** 原 C15 固定入口：clip 中心行的左/中/右三点。 */
export function probeDetailBarCenterRowHits(options = {}) {
  return probeDetailBarHits(options, {
    entryName: "probeDetailBarCenterRowHits",
    scope: "three-center-row-points-only",
    makePoints: buildThreeCenterRowPoints,
  });
}

/** B43 固定入口：中心条每个整数 x 的像素中心，不开放任意点或选项。 */
export function probeDetailBarCenterStripHits(options = {}) {
  return probeDetailBarHits(options, {
    entryName: "probeDetailBarCenterStripHits",
    scope: "all-center-strip-pixel-centers",
    makePoints: buildCenterStripPoints,
  });
}

/** C23 固定入口：仅接受 exact fill 或绑定原 detail panel 的 after pseudo。 */
export function probeDetailBarActiveCenterStripHits(options = {}) {
  return probeDetailBarHits(options, {
    entryName: "probeDetailBarActiveCenterStripHits",
    scope: "all-center-strip-pixel-centers",
    makePoints: buildCenterStripPoints,
    requireActiveDetailPanel: true,
  });
}
